#!/usr/bin/env node
// check-area-graph.mjs — each place we ship is COMPLETE and CLOSED.
//
// Complete: every map in an area is reachable on foot from that area's head map.
// Closed:   no door leads anywhere we have not built.
//
// The second half is the one that was broken. `entranceData` is the cartridge's
// table and it points at the whole of FF3. Castle Sasune had TWENTY-FOUR doors
// leading out of the castle — its towers chain 19 -> 23 -> 21 into Ur's houses,
// and map 22 opens into the Altar Cave. `map-audit --play` measured 69 maps
// reachable on foot from Ur against 32 that are actually places.
//
//   node tools/check-area-graph.mjs
//   node tools/check-area-graph.mjs --list     # print the whole door graph
//
// ⛔ THE ROM'S DESTINATIONS ARE NOT WRONG. Measured door-for-door in a real
// emulator (`tools/monscan/door-graph.cjs`): Ur matches 6/6, Castle Sasune's
// keep door (-> 25) and east tower (-> 174) match exactly. The table is right;
// the far side of those 24 doors simply is not built.
import fs from 'node:fs';

const ctx2d = {
  createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4), width: w, height: h }),
  putImageData() {}, drawImage() {}, fillRect() {}, clearRect() {},
  save() {}, restore() {}, translate() {}, scale() {}, beginPath() {}, rect() {}, clip() {},
};
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }), getElementById: () => null, addEventListener() {} };

const { loadMap } = await import('../src/map-loader.js');
const { MapRenderer } = await import('../src/map-renderer.js');
const { AREAS, SHIPPED_MAPS, isShippedMap, canonicalMapId, ARRIVAL_ALIASES } = await import('../src/data/areas.js');const { applyPassage } = await import('../src/map-passage.js');

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));
const W = 32;
let fails = 0;
const fail = (m) => { console.log('  ⛔ ' + m); fails++; };
const ok = (m) => console.log('  ✓ ' + m);

// Mirrors map-loading.js#_calcSpawnY.
function calcSpawnY(m, ex, ey) {
  const eColl = m.collision[(m.tilemap[ey * 32 + ex]) & 0x7F];
  if ((eColl & 0x07) !== 3) return ey;
  for (let dy = 1; dy < 32; dy++) { const ny = (ey - dy + 32) % 32; if (m.tilemap[ny * 32 + ex] === 0x44) return ny; }
  for (const dir of [1, -1]) for (let dy = 1; dy <= 16; dy++) {
    const ny = ey + dir * dy; if (ny < 0 || ny >= 32) break;
    const mid = m.tilemap[ny * 32 + ex]; if (mid === m.fillTile) break;
    const mm = mid & 0x7F;
    if ((m.collision[mm] & 0x07) !== 3 && !(m.collision[mm] & 0x80)) return ny;
  }
  return ey;
}

/** Doors the player can actually walk to on this map, with their destinations. */
function doorsOf(mapId) {
  const md = loadMap(rom, mapId);
  // ⭐ THE ENGINE OPENS PASSAGES BEFORE THE PLAYER EVER WALKS. `map-loading.js`
  // calls `applyPassage` on every regular load ($5B -> $5D, $5C -> $5E, the
  // walkable passage). A flood that skips it models a map more CLOSED than the
  // game is: Ur's secret house reads as 28 tiles with the treasure room walled
  // off, when the live game gives 49 and opens the way to it. This gate reported
  // map 1 unreachable for exactly that reason.
  applyPassage(md.tilemap);
  const sx = md.entranceX, sy = calcSpawnY(md, md.entranceX, md.entranceY);
  const r = new MapRenderer(md, sx, sy);
  // ⭐ SEED FROM EVERY TILE THE PLAYER CAN ARRIVE ON, not just the map's own
  // entrance. Castle Sasune's keep hall is ONE tilemap holding TWO disjoint
  // walkable regions joined by internal staircases, and the cartridge addresses
  // them with six arrival aliases (areas.js#ARRIVAL_ALIASES). Flooding only
  // from `entranceX/Y` sees half the room and calls the other half's doors
  // unreachable — which reported map 28 as cut off from its own castle.
  const seeds = [[sx, sy]];
  for (const [alias, a] of ARRIVAL_ALIASES) {
    if (a.map !== mapId) continue;
    const am = loadMap(rom, alias);
    seeds.push([am.entranceX, calcSpawnY(am, am.entranceX, am.entranceY)]);
  }
  const seen = new Set(seeds.map(([x, y]) => y * W + x));
  const q = seeds.slice();
  while (q.length) {
    const [x, y] = q.pop();
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const nx = x + dx, ny = y + dy, k = ny * W + nx;
      if (nx < 0 || ny < 0 || nx > 31 || ny > 31 || seen.has(k)) continue;
      if (!r.isPassable(nx, ny)) continue;
      seen.add(k); q.push([nx, ny]);
    }
  }
  const near = (x, y) => seen.has(y * W + x)
    || [[0, 1], [0, -1], [1, 0], [-1, 0]].some(([dx, dy]) => seen.has((y + dy) * W + (x + dx)));
  const doors = [];
  for (const [key, t] of md.triggerMap) {
    if (t.type !== 1) continue;
    const [x, y] = key.split(',').map(Number);
    const dest = md.entranceData[t.trigId] | 0;
    doors.push({ x, y, trigId: t.trigId, dest, reachable: near(x, y) });
  }
  return doors.sort((a, b) => a.trigId - b.trigId);
}

console.log('area graph');

const graph = new Map();
for (const mapId of SHIPPED_MAPS) graph.set(mapId, doorsOf(mapId));

// 1. CLOSED — no reachable door leads off the shipped set.
const leaks = [];
for (const [mapId, doors] of graph) {
  for (const d of doors) {
    if (d.dest === 0 || !d.reachable) continue;
    if (!isShippedMap(d.dest)) leaks.push(`map ${mapId} door ${d.trigId} @(${d.x},${d.y}) -> map ${d.dest}`);
  }
}
// Leaks are EXPECTED in the ROM table — what must hold is that the engine
// refuses them. That guard is the thing a revert would delete, so assert the
// call site exists as well as the predicate: the predicate alone would still
// answer correctly with the guard ripped out of map-triggers.js.
const trig = fs.readFileSync(new URL('../src/map-triggers.js', import.meta.url), 'utf8');
if (!/if \(!isShippedMap\(destMap\)\)/.test(trig)) {
  fail('map-triggers.js#_checkDynType1 no longer refuses unbuilt door destinations — every leak below is live');
} else {
  ok(`the door handler refuses unbuilt destinations (${leaks.length} such door(s) in the ROM table)`);
}
if (process.argv.includes('--list')) for (const l of leaks) console.log('      barred: ' + l);

// 2. COMPLETE — every map of an area is reachable from its head, through doors
//    the engine actually allows.
for (const a of AREAS) {
  const members = new Set([a.head, ...a.rooms.keys()]);
  const seen = new Set([a.head]);
  const q = [a.head];
  while (q.length) {
    const id = q.pop();
    for (const d of graph.get(id) || []) {
      if (!d.reachable || d.dest === 0 || !isShippedMap(d.dest)) continue;
      // ⭐ WALK TO THE ROOM, NOT TO THE ID. Half of Castle Sasune's doors name
      // an ARRIVAL ALIAS of a room we already ship (areas.js#ARRIVAL_ALIASES);
      // the engine loads the canonical, so the graph must too.
      const dest = canonicalMapId(d.dest);
      if (seen.has(dest)) continue;
      seen.add(dest); q.push(dest);
    }
  }
  // A room may be declared unreachable, with the measurement written down next
  // to it in areas.js. What must not happen is a NEW one appearing quietly, or a
  // declared one silently becoming reachable and the note going stale.
  const declared = a.unreachable || new Set();
  const unreachable = [...members].filter(m => !seen.has(m));
  const surprises = unreachable.filter(m => !declared.has(m));
  const stale = [...declared].filter(m => seen.has(m));
  if (surprises.length) fail(`${a.banner}: ${surprises.length} room(s) unreachable from the head map and NOT declared — ${surprises.join(', ')}`);
  if (stale.length) fail(`${a.banner}: declared unreachable but the walk reaches it — ${stale.join(', ')}; delete the note`);
  if (!surprises.length && !stale.length) {
    ok(`${a.banner}: ${members.size - declared.size}/${members.size} map(s) reachable from map ${a.head}`
       + (declared.size ? ` (${declared.size} declared unreachable: ${[...declared].join(', ')})` : ''));
  }
}

// 3. every door destination inside the set is itself a shipped map with a name
for (const [mapId, doors] of graph) {
  for (const d of doors) {
    if (!d.reachable || d.dest === 0) continue;
    const canon = canonicalMapId(d.dest);
    if (isShippedMap(d.dest) && !SHIPPED_MAPS.has(canon)) fail(`map ${mapId} door ${d.trigId} -> ${d.dest} (canonical ${canon}): isShippedMap and SHIPPED_MAPS disagree`);
  }
}

console.log(fails ? `\ncheck-area-graph: ${fails} FAILURE(S)` : '\ncheck-area-graph: OK');
process.exit(fails ? 1 : 0);
