#!/usr/bin/env node
// map-connectivity.mjs — flood-fill a map using the REAL MapRenderer.isPassable.
//
// `map-explorable.mjs` reimplements the passability rule, and a reimplementation
// is exactly what you cannot trust when the question is "is my model of
// passability wrong?" This constructs the actual `MapRenderer` behind a canvas
// stub and calls its own `isPassable`, so the z-level state machine, the bed
// check and the entrance special-case are the production ones.
//
//   node tools/map-connectivity.mjs 180

import fs from 'node:fs';

// Minimal canvas stub — MapRenderer prerenders to an offscreen canvas in its
// constructor. None of that output is used here; only isPassable is.
const ctx2d = {
  createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  putImageData() {}, drawImage() {}, fillRect() {}, clearRect() {},
  save() {}, restore() {}, translate() {}, scale() {}, beginPath() {}, rect() {}, clip() {},
};
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }) };

const { loadMap } = await import('../src/map-loader.js');
const { MapRenderer } = await import('../src/map-renderer.js');
// ⭐ THE ENGINE OPENS PASSAGES BEFORE THE PLAYER WALKS. `map-loading.js` calls
// `applyPassage` on every regular map load ($5B -> $5D doorframe, $5C -> $5E the
// walkable passage). Every reachability tool here used to skip it, which models
// each map more CLOSED than the game is — Ur's secret house read as 28 tiles
// with its treasure room walled off, against 49 tiles and an open way in live.
const { applyPassage } = await import('../src/map-passage.js');

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));
const mapId = parseInt(process.argv[2] || '180', 10);
const W = 32;

const md = loadMap(rom, mapId);
  applyPassage(md.tilemap);

// Same spawn rule as _loadRegularMap:249 — (ex, _calcSpawnY(ex, ey)).
function calcSpawnY(m, ex, ey) {
  const eColl = m.collision[(m.tilemap[ey * 32 + ex]) & 0x7F];
  if ((eColl & 0x07) === 3) {
    for (let dy = 1; dy < 32; dy++) { const ny = (ey - dy + 32) % 32; if (m.tilemap[ny * 32 + ex] === 0x44) return ny; }
    for (let dy = 1; dy <= 16; dy++) { const ny = ey + dy; if (ny >= 32) break; const mid = m.tilemap[ny * 32 + ex];
      if (mid === m.fillTile) break; const mm = mid & 0x7F;
      if ((m.collision[mm] & 0x07) !== 3 && !(m.collision[mm] & 0x80)) return ny; }
    for (let dy = 1; dy <= 16; dy++) { const ny = ey - dy; if (ny < 0) break; const mid = m.tilemap[ny * 32 + ex];
      if (mid === m.fillTile) break; const mm = mid & 0x7F;
      if ((m.collision[mm] & 0x07) !== 3 && !(m.collision[mm] & 0x80)) return ny; }
    return ey;
  }
  return ey;
}

const sx = md.entranceX, sy = calcSpawnY(md, md.entranceX, md.entranceY);
const r = new MapRenderer(md, sx, sy);

// Flood with the REAL isPassable. Note it is STATEFUL (`_playerZ`), so this is
// an optimistic reachability: it explores in an arbitrary order rather than
// along a single walk. Anything it cannot reach is definitely unreachable.
const seen = new Set([sy * W + sx]);
const q = [[sx, sy]];
while (q.length) {
  const [x, y] = q.pop();
  for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
    const nx = x + dx, ny = y + dy, k = ny * W + nx;
    if (seen.has(k)) continue;
    if (!r.isPassable(nx, ny)) continue;
    seen.add(k); q.push([nx, ny]);
  }
}

// Every exit-ish trigger on the map, and whether the flood touched it.
const exits = [];
for (const [key, t] of md.triggerMap) {
  const [x, y] = key.split(',').map(Number);
  if (t.type === 1 || t.type === 4) exits.push({ x, y, what: `tile-trigger type ${t.type}`, dest: md.entranceData[t.trigId] | 0 });
}
for (let i = 0; i < md.tilemap.length; i++) {
  const mid = md.tilemap[i], x = i % W, y = (i - x) / W;
  if (md.triggerMap.has(`${x},${y}`)) continue;
  if (!(md.collision[mid & 0x7F] & 0x80)) continue;
  const tt = (md.collisionByte2[mid] >> 4) & 0x0F;
  if (tt === 0) exits.push({ x, y, what: 'exit_prev (trigType 0)', dest: -1 });
  if (tt === 1) exits.push({ x, y, what: 'exit-to-world (trigType 1)', dest: -1 });
}

const near = (x, y) => seen.has(y * W + x)
  || [[0, 1], [0, -1], [1, 0], [-1, 0]].some(([dx, dy]) => seen.has((y + dy) * W + (x + dx)));

console.log(`map ${mapId}  ROM entrance (${md.entranceX},${md.entranceY}) -> spawn (${sx},${sy})`);
console.log(`reachable with the REAL isPassable: ${seen.size} tiles`);
console.log(`exits on this map: ${exits.length}`);
for (const e of exits) console.log(`  (${e.x},${e.y}) ${e.what} dest=${e.dest}  ${near(e.x, e.y) ? 'REACHABLE' : 'walled off'}`);
if (!exits.some(e => near(e.x, e.y))) console.log('\n=> WALLED IN: no exit reachable from the spawn.');
else console.log('\n=> reachable exit exists.');
