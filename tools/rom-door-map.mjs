#!/usr/bin/env node
// rom-door-map.mjs — the walkable grid and the door list for each map, as JSON.
//
// Feeds `tools/monscan/door-graph.cjs`, which drives the REAL ROM in an emulator
// and records where each door actually goes. That prober needs to pathfind to a
// door tile, and it must not re-derive passability: the whole point is to compare
// our door table against the ROM's, so the only thing allowed to differ is the
// destination. Passability therefore comes from the production
// `MapRenderer.isPassable`, exactly as `map-connectivity.mjs` does it.
//
// The split is the same one `map-trigger-dump.mjs` already lives with — the
// emulator harness is CommonJS and the map loader is ESM.
//
//   node tools/rom-door-map.mjs 18,25,114 out.json
//   node tools/rom-door-map.mjs --towns out.json     # Ur + Kazus + Sasune blocks
//
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

// Mirrors map-loading.js#_calcSpawnY (and map-connectivity.mjs's copy of it).
function calcSpawnY(m, ex, ey) {
  const eColl = m.collision[(m.tilemap[ey * 32 + ex]) & 0x7F];
  if ((eColl & 0x07) !== 3) return ey;
  for (let dy = 1; dy < 32; dy++) { const ny = (ey - dy + 32) % 32; if (m.tilemap[ny * 32 + ex] === 0x44) return ny; }
  for (const dir of [1, -1]) {
    for (let dy = 1; dy <= 16; dy++) {
      const ny = ey + dir * dy;
      if (ny < 0 || ny >= 32) break;
      const mid = m.tilemap[ny * 32 + ex];
      if (mid === m.fillTile) break;
      const mm = mid & 0x7F;
      if ((m.collision[mm] & 0x07) !== 3 && !(m.collision[mm] & 0x80)) return ny;
    }
  }
  return ey;
}

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const TOWNS = [114, 1, 2, 3, 4, 5, 6, 7, 8, 9, 147,
               10, 11, 12, 13, 14, 15, 16, 17,
               18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 174, 175, 176, 177, 178, 179];
const ids = process.argv.includes('--towns')
  ? TOWNS
  : (args[0] || '18').split(',').map(n => parseInt(n, 10));
const outPath = args[process.argv.includes('--towns') ? 0 : 1] || 'door-map.json';

const out = {};
for (const mapId of ids) {
  const md = loadMap(rom, mapId);
  const sx = md.entranceX, sy = calcSpawnY(md, md.entranceX, md.entranceY);
  const r = new MapRenderer(md, sx, sy);

  // `isPassable` is STATEFUL (it tracks a player z-level), so ask it in a fixed
  // scan order and take the answer as advisory for routing only. A route that
  // turns out to be blocked shows up as "the party did not move", which the
  // prober reports rather than silently mis-attributing.
  const walk = [];
  for (let y = 0; y < 32; y++) { const row = []; for (let x = 0; x < 32; x++) row.push(r.isPassable(x, y) ? 1 : 0); walk.push(row); }

  const doors = [];
  for (const [key, t] of md.triggerMap) {
    if (t.type !== 1) continue;
    const [x, y] = key.split(',').map(Number);
    // The DOORSTEP: the tile the party stands on to step into this door, and the
    // direction of that step. Same rule map-trigger-dump.mjs uses — from below
    // first, because FF3 doors are entered walking UP into them — restricted to a
    // tile the party can actually stand on. `door-probe.cjs` patches the map's
    // ROM entrance to this tile, so the probe starts one step away and never has
    // to route (and so can never cross another trigger on the way).
    const cand = [[x, y + 1, 'up'], [x, y - 1, 'down'], [x + 1, y, 'left'], [x - 1, y, 'right']]
      .filter(([cx, cy]) => cx >= 0 && cy >= 0 && cx < 32 && cy < 32 && r.isPassable(cx, cy));
    // ALL viable doorsteps, not just the first. A door in a shared tilemap's
    // far room often cannot be entered from below at all, and one candidate is
    // the difference between "measured" and a harness fact dressed up as a
    // finding — 33 doors came back unmeasured on the from-below-only version.
    doors.push({ x, y, trigId: t.trigId, ourDest: md.entranceData[t.trigId] | 0,
                 approach: cand.length ? [cand[0][0], cand[0][1]] : null,
                 walk: cand.length ? cand[0][2] : null,
                 approaches: cand.map(([cx, cy, w]) => ({ at: [cx, cy], walk: w })) });
  }
  doors.sort((a, b) => a.trigId - b.trigId);

  // Exit tiles are NOT passable by design (fire-on-attempt — see
  // check-map-exits.mjs), so they never appear in `walk`; list them so the
  // prober can tell "walked into the world" from "route failed".
  const exits = [];
  for (let i = 0; i < md.tilemap.length; i++) {
    const mid = md.tilemap[i], x = i % W, y = (i - x) / W;
    if (md.triggerMap.has(`${x},${y}`)) continue;
    if (!(md.collision[mid & 0x7F] & 0x80)) continue;
    const tt = (md.collisionByte2[mid] >> 4) & 0x0F;
    if (tt === 0 || tt === 1) exits.push({ x, y, kind: tt === 0 ? 'prev' : 'world' });
  }

  // Every trigger tile, of any type. The prober routes AROUND these: a path to a
  // far door that crosses a nearer one fires the wrong transition, and the
  // result is indistinguishable from a real table mismatch (it cost one full
  // false "Ur door 0 is wrong" reading before this existed).
  const avoid = [];
  for (const [key] of md.triggerMap) { const [x, y] = key.split(',').map(Number); avoid.push([x, y]); }
  for (const e of exits) avoid.push([e.x, e.y]);

  out[mapId] = { mapId, entrance: [md.entranceX, md.entranceY], spawn: [sx, sy], walk, doors, exits, avoid,
                 entranceData: [...md.entranceData] };
}

fs.writeFileSync(outPath, JSON.stringify(out));
const totalDoors = Object.values(out).reduce((a, m) => a + m.doors.length, 0);
console.log(`${Object.keys(out).length} map(s), ${totalDoors} door(s) -> ${outPath}`);
