#!/usr/bin/env node
// map-audit.mjs — does the player land in the RIGHT ROOM on every map?
//
// ⚠ READ THIS BEFORE TRUSTING THE "WRONG ROOM" COLUMN.
//
// The `entIn` metric — "is the spawn in the same connected region as the ROM's
// entrance tile?" — is NOT a correctness test for this engine, and acting on it
// would ship a player-trapping regression. Verified 2026-08-12:
//
//   The ROM's entranceX/Y points at the door tile on the OUTSIDE of a building.
//   `_calcSpawnY`'s $44 search then walks to the INTERIOR doorway, which is a
//   different connected region by design. Map 2: ROM entrance (8,31), spawn
//   (8,21), and the exit_prev door sits at (8,23) — the player stands two tiles
//   inside a corridor with the way out behind them and a chest room ahead.
//   That is correct FF3 behaviour, and `entIn` calls it WRONG.
//
//   "Fixing" the 11 flagged maps (bounding the $44 search, or stopping the
//   floor scans at walls) takes wrong-room to 0 and reachable exits to ZERO on
//   every one of them — maps 12/44/139 collapse to a single tile. The metric
//   is satisfied by spawning ON the entrance, which is trivially "in its own
//   region" and usually a sealed tile.
//
// So: treat WRONG ROOM as a PROMPT TO LOOK, never as a defect count. The column
// that matters is `exits reachable`. Indoor maps share 32x32 tilemaps, several
// unconnected rooms per grid, which is why this is subtle at all.
//
// Uses the REAL MapRenderer.isPassable behind a canvas stub, for the same
// reason map-connectivity.mjs does: a reimplementation of passability is
// exactly what you cannot trust when passability is what's in question.
//
//   node tools/map-audit.mjs              # audit every map, summary + defects
//   node tools/map-audit.mjs --all        # include clean maps in the listing
//   node tools/map-audit.mjs 2            # one map, verbose

import fs from 'node:fs';

const ctx2d = {
  createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4), width: w, height: h }),
  putImageData() {}, drawImage() {}, fillRect() {}, clearRect() {},
  save() {}, restore() {}, translate() {}, scale() {}, beginPath() {}, rect() {}, clip() {},
};
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }) };

const { loadMap } = await import('../src/map-loader.js');
const { MapRenderer } = await import('../src/map-renderer.js');

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));
const W = 32;

// Mirrors src/map-loading.js#_calcSpawnY. Kept in sync deliberately — this
// tool exists to measure that function's behaviour, so it has to model it.
function calcSpawnY(m, ex, ey, { boundFirstLoop, strictScan }) {
  const at = (x, y) => m.tilemap[y * 32 + x];
  const collOf = (mid) => m.collision[mid < 128 ? mid : mid & 0x7F];
  const eColl = collOf(at(ex, ey));
  if ((eColl & 0x07) === 3) {
    // The unbounded wrap-around scan. With `boundFirstLoop` it stops at the
    // fill tile and does not wrap — i.e. it stays inside the room.
    const MAXD = boundFirstLoop ? 3 : 32;
    for (let dy = 1; dy <= MAXD; dy++) {
      const ny = boundFirstLoop ? ey - dy : (ey - dy + 32) % 32;
      if (boundFirstLoop) {
        if (ny < 0) break;
        if (at(ex, ny) === m.fillTile) break;
      }
      if (at(ex, ny) === 0x44) return ny;
    }
    // `strictScan`: stop at the first tile the player could not walk through.
    // Without it these scans skip OVER walls and land in the next room —
    // map 2's entrance (8,31) has solid tiles at (8,30) and (8,29), and the
    // scan sails past both to (8,28), a different room.
    for (let dy = 1; dy <= 16; dy++) {
      const ny = ey + dy; if (ny >= 32) break;
      const mid = at(ex, ny); if (mid === m.fillTile) break;
      const c = collOf(mid);
      if ((c & 0x07) !== 3 && !(c & 0x80)) return ny;
      if (strictScan) break;
    }
    for (let dy = 1; dy <= 16; dy++) {
      const ny = ey - dy; if (ny < 0) break;
      const mid = at(ex, ny); if (mid === m.fillTile) break;
      const c = collOf(mid);
      if ((c & 0x07) !== 3 && !(c & 0x80)) return ny;
      if (strictScan) break;
    }
    return ey;
  }
  const entMid = at(ex, ey);
  const entM = entMid < 128 ? entMid : entMid & 0x7F;
  if (entMid === 0x44) return ey;
  if ((m.collision[entM] & 0x80) && ((m.collisionByte2[entM] >> 4) & 0x0F) === 0) {
    for (let dy = 1; dy <= 8; dy++) {
      const ny = ey - dy; if (ny < 0) break;
      if (at(ex, ny) === 0x44) return ny;
    }
  }
  return ey;
}

function regionFrom(r, sx, sy) {
  const seen = new Set([sy * W + sx]);
  const q = [[sx, sy]];
  while (q.length) {
    const [x, y] = q.pop();
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const nx = x + dx, ny = y + dy, k = ny * W + nx;
      if (nx < 0 || nx >= W || ny < 0 || ny >= W || seen.has(k)) continue;
      if (!r.isPassable(nx, ny)) continue;
      seen.add(k); q.push([nx, ny]);
    }
  }
  return seen;
}

function audit(mapId, opts) {
  let md;
  try { md = loadMap(rom, mapId); } catch (e) { return { mapId, error: e.message }; }
  if (!md || !md.tilemap) return { mapId, error: 'no tilemap' };
  const ex = md.entranceX, ey = md.entranceY;
  if (ex >= W || ey >= W) return { mapId, error: `entrance out of range (${ex},${ey})` };

  // Mirror src/map-loading.js#_loadRegularMap (v1.7.950): a closed passage
  // ($5B/$5C) opens at load unless the map carries the torch opener at (8,16),
  // because nothing else in this build can ever open it.
  if (md.tilemap[16 * 32 + 8] !== 0x32) {
    for (let i = 0; i < md.tilemap.length; i++) {
      if (md.tilemap[i] === 0x5B) md.tilemap[i] = 0x5D;
      if (md.tilemap[i] === 0x5C) md.tilemap[i] = 0x5E;
    }
  }
  const sy = calcSpawnY(md, ex, ey, opts);
  const r = new MapRenderer(md, ex, sy);
  const spawnRegion = regionFrom(r, ex, sy);
  // Is the ROM's own entrance tile in the region we spawned into? If the
  // entrance tile itself is solid (a door), accept an orthogonal neighbour.
  const entIn = spawnRegion.has(ey * W + ex) ||
    [[0, 1], [0, -1], [1, 0], [-1, 0]].some(([dx, dy]) => spawnRegion.has((ey + dy) * W + (ex + dx)));

  // Exits reachable from where we actually stand.
  //
  // BOTH kinds count. Doors also arrive as dynamic tilemap-placeholder
  // triggers ($70-$77) in `md.triggerMap`; counting only collision-driven
  // triggers made small building interiors look exit-less and nearly got a
  // player-trapping spawn rule shipped as a fix.
  let exits = 0, reachableExits = 0;
  const near = (x, y) => spawnRegion.has(y * W + x) ||
    [[0, 1], [0, -1], [1, 0], [-1, 0]].some(([dx, dy]) => spawnRegion.has((y + dy) * W + (x + dx)));
  const counted = new Set();
  if (md.triggerMap) {
    for (const [key, t] of md.triggerMap) {
      // Type 0 is an EVENT tile ($60-$63), NOT a way out. It is passable as of
      // v1.7.944 and has no handler, so counting it as an exit made map 180
      // read "2/3 exits ok" when its only real door (2,27) is walled off from
      // the spawn — the exact map that stranded a live player.
      if (!(t.type === 1 || t.type === 4)) continue;
      const [x, y] = key.split(',').map(Number);
      counted.add(y * W + x);
      exits++;
      if (near(x, y)) reachableExits++;
    }
  }
  for (let i = 0; i < md.tilemap.length; i++) {
    const mid = md.tilemap[i], x = i % W, y = (i - (i % W)) / W;
    const mm = mid < 128 ? mid : mid & 0x7F;
    if (!(md.collision[mm] & 0x80)) continue;
    const tt = (md.collisionByte2[mm] >> 4) & 0x0F;
    if (tt !== 0 && tt !== 1 && tt !== 4 && tt !== 5) continue;
    if (counted.has(y * W + x)) continue;   // already counted as a dynamic trigger
    exits++;
    if (near(x, y)) reachableExits++;
  }
  return { mapId, ex, ey, sy, moved: sy !== ey, tiles: spawnRegion.size, entIn, exits, reachableExits };
}

const args = process.argv.slice(2);
const one = args.find(a => /^\d+$/.test(a));
const SHOW_ALL = args.includes('--all');

// ── --play: only the maps a player can actually get to ────────────────────
// Seeds from the overworld entrances reachable on foot from Ur, then follows
// door destinations transitively. Everything else in the 256-id space is an
// unused slot and its "defects" are noise.
if (args.includes('--play')) {
  globalThis.document = globalThis.document || { createElement: () => ({ getContext: () => ({}) }) };
  const { loadWorldMap } = await import('../src/world-map-loader.js');
  const { WorldMapRenderer } = await import('../src/world-map-renderer.js');
  const world = loadWorldMap(rom, 0);
  const stub = { data: world };
  const wpass = (x, y) => WorldMapRenderer.prototype.isPassable.call(stub, x, y);
  const WS = world.mapWidth;

  let seed = null;
  for (const [t, p] of world.triggerPositions) if (world.entranceTable[t] === 114) { seed = p; break; }
  const wseen = new Set([seed.y * WS + seed.x]);
  const wq = [[seed.x, seed.y]];
  while (wq.length) {
    const [x, y] = wq.pop();
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const nx = ((x + dx) % WS + WS) % WS, ny = ((y + dy) % WS + WS) % WS, k = ny * WS + nx;
      if (wseen.has(k) || !wpass(nx, ny)) continue;
      wseen.add(k); wq.push([nx, ny]);
    }
  }
  const seeds = new Set();
  for (const [, p] of world.triggerPositions) {
    if (!wseen.has(p.y * WS + p.x)) continue;
    const t = WorldMapRenderer.prototype.getTriggerAt.call(stub, p.x, p.y);
    if (t && t.destMap) seeds.add(t.destMap);
  }

  const reachable = new Set(seeds);
  const queue = [...seeds];
  const report = [];
  while (queue.length) {
    const id = queue.shift();
    const a = audit(id, {});
    report.push(a);
    if (a.error) continue;
    const md = loadMap(rom, id);
    for (const [, t] of (md.triggerMap || [])) {
      if (t.type !== 1 && t.type !== 4) continue;
      const dest = md.entranceData[t.trigId] | 0;
      if (!dest || reachable.has(dest)) continue;
      reachable.add(dest); queue.push(dest);
    }
  }
  report.sort((a, b) => a.mapId - b.mapId);
  const broken = report.filter(r => !r.error && r.exits > 0 && r.reachableExits === 0);
  console.log(`play area: ${report.length} maps reachable from Ur on foot\n`);
  console.log('  map   spawn      tiles  exits  status');
  for (const r of report) {
    if (r.error) { console.log(`  ${String(r.mapId).padStart(3)}   (error: ${r.error})`); continue; }
    const status = (r.exits === 0) ? 'no exits at all'
      : (r.reachableExits === 0) ? '*** WALLED IN ***'
      : 'ok';
    console.log(`  ${String(r.mapId).padStart(3)}   (${String(r.ex).padStart(2)},${String(r.sy).padStart(2)})  ` +
      `${String(r.tiles).padStart(5)}  ${String(r.reachableExits)}/${String(r.exits).padEnd(3)}  ${status}`);
  }
  console.log(`\nWALLED IN: ${broken.length} map(s)${broken.length ? ' -> ' + broken.map(b => b.mapId).join(', ') : ''}`);
  process.exit(0);
}

if (one != null) {
  const id = parseInt(one, 10);
  for (const bound of [false, true]) {
    const a = audit(id, { boundFirstLoop: bound });
    console.log(`${bound ? 'BOUNDED ' : 'CURRENT '} ${JSON.stringify(a)}`);
  }
  process.exit(0);
}

// Sweep every map id the loader accepts.
const rows = { cur: [], fix: [] };
for (let id = 0; id < 256; id++) {
  const c = audit(id, { boundFirstLoop: false });
  const f = audit(id, { boundFirstLoop: true });
  const t = audit(id, { boundFirstLoop: true, strictScan: true });
  if (c.error || f.error || t.error) continue;
  rows.cur.push(c); rows.fix.push(f); (rows.strict ||= []).push(t);
}

const wrongRoom = (rs) => rs.filter(r => !r.entIn);
const stranded  = (rs) => rs.filter(r => r.exits > 0 && r.reachableExits === 0);

console.log(`maps audited: ${rows.cur.length}\n`);
console.log('                        WRONG ROOM   STRANDED (exits exist, none reachable)');
console.log(`  current rule            ${String(wrongRoom(rows.cur).length).padStart(4)}         ${String(stranded(rows.cur).length).padStart(4)}`);
console.log(`  bounded first loop      ${String(wrongRoom(rows.fix).length).padStart(4)}         ${String(stranded(rows.fix).length).padStart(4)}`);
console.log(`  bounded + strict scan   ${String(wrongRoom(rows.strict).length).padStart(4)}         ${String(stranded(rows.strict).length).padStart(4)}`);

const changed = rows.cur.filter((c, i) => c.sy !== rows.fix[i].sy);
console.log(`\nmaps whose spawn moves under the fix: ${changed.length}`);
for (const c of changed) {
  const f = rows.fix.find(r => r.mapId === c.mapId);
  const verdict = (!c.entIn && f.entIn) ? 'FIXED'
    : (c.entIn && !f.entIn) ? 'REGRESSED'
    : 'same-verdict';
  const t = rows.strict.find(r => r.mapId === c.mapId);
  console.log(`  map ${String(c.mapId).padStart(3)}  ent (${c.ex},${c.ey})  spawnY ${c.sy}->${f.sy}->${t.sy}   ` +
    `room ${c.entIn ? 'ok' : 'WRONG'}->${f.entIn ? 'ok' : 'WRONG'}->${t.entIn ? 'ok' : 'WRONG'}   ` +
    `exits cur ${c.reachableExits}/${c.exits} strict ${t.reachableExits}/${t.exits}  tiles ${c.tiles}->${t.tiles}`);
}

const listing = SHOW_ALL ? rows.cur : wrongRoom(rows.cur);
if (listing.length) {
  console.log(`\n${SHOW_ALL ? 'all maps' : 'maps landing in the WRONG ROOM (current rule)'}:`);
  for (const r of listing) {
    console.log(`  map ${String(r.mapId).padStart(3)}  ent (${r.ex},${r.ey}) spawn (${r.ex},${r.sy})  ` +
      `region ${String(r.tiles).padStart(4)} tiles  exits ${r.reachableExits}/${r.exits}`);
  }
}
