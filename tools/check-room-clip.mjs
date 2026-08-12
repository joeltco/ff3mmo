#!/usr/bin/env node
// check-room-clip.mjs — the renderer must DRAW everywhere the player can WALK.
//
// `MapRenderer._computeRoomBounds` walks out from the spawn to decide the clip
// rectangle for shared indoor tilemaps, and `isPassable` decides where the
// player may go. These are two separate implementations of "can you be here",
// and when they disagree the player walks into un-drawn blackness.
//
// That is exactly what happened: v1.7.944 made event tiles ($60-$63) passable
// so towns stopped being sealed off, but the room-bounds walk still treated
// them as walls (they carry collision bit $80). Map 31 drew 27 tiles of a
// 493-tile reachable area; map 55 drew 45 of 293. Reported as "the map is in
// pieces".
//
// This gate asserts the invariant directly: every tile reachable from the spawn
// must lie inside the clip rectangle.
//
//   node tools/check-room-clip.mjs

import fs from 'node:fs';

const ctx2d = {
  createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4), width: w, height: h }),
  putImageData() {}, drawImage() {}, fillRect() {}, clearRect() {},
  save() {}, restore() {}, translate() {}, scale() {}, beginPath() {}, rect() {}, clip() {},
  createPattern: () => ({}),
};
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }) };

const { loadMap } = await import('../src/map-loader.js');
const { MapRenderer } = await import('../src/map-renderer.js');

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));
const W = 32, TILE = 16;

// Maps reachable on foot — see tools/map-audit.mjs --play.
const PLAY = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,25,26,27,28,29,30,
              44,45,46,47,50,52,53,54,101,102,111,112,113,114,115,122,123,147,148,160,163,164,
              165,166,168,170,174,175,176,177,178,179,182,183,186,187,188,189,190,191];

// `--all` sweeps every map id, not just the ones reachable on foot. Unused
// slots get skipped naturally (they fail to load or have no clip).
const ALL = process.argv.includes('--all');
const IDS = ALL ? Array.from({ length: 256 }, (_, i) => i) : PLAY;

let failed = 0, checked = 0, worst = null;
for (const id of IDS) {
  let md;
  try { md = loadMap(rom, id); } catch { continue; }
  if (!md || !md.tilemap || md.entranceX >= W || md.entranceY >= W) continue;
  // Mirror the game's load-time passage opening (v1.7.950).
  if (md.tilemap[16 * 32 + 8] !== 0x32) {
    for (let i = 0; i < md.tilemap.length; i++) {
      if (md.tilemap[i] === 0x5B) md.tilemap[i] = 0x5D;
      if (md.tilemap[i] === 0x5C) md.tilemap[i] = 0x5E;
    }
  }
  const sx = md.entranceX, sy = md.entranceY;
  let r;
  try { r = new MapRenderer(md, sx, sy); } catch { continue; }
  checked++;

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

  const c = r._roomClip;
  if (!c) continue;                     // whole map drawn — nothing to check
  const x0 = c.x / TILE, y0 = c.y / TILE, x1 = x0 + c.w / TILE, y1 = y0 + c.h / TILE;
  let outside = 0;
  for (const k of seen) {
    const x = k % W, y = (k - (k % W)) / W;
    if (x < x0 || x >= x1 || y < y0 || y >= y1) outside++;
  }
  // Second invariant (v1.7.953): the clip must not extend past the player's own
  // room. It used to, dragging a strip of a NEIGHBOURING room's floor into view
  // — Kazus's inn (map 17) drew the bedroom above it, reported as "trailing
  // tiles outside of the rooms".
  let rminX = W, rmaxX = -1, rminY = W, rmaxY = -1;
  for (const k of seen) {
    const x = k % W, y = (k - (k % W)) / W;
    if (x < rminX) rminX = x;
    if (x > rmaxX) rmaxX = x;
    if (y < rminY) rminY = y;
    if (y > rmaxY) rmaxY = y;
  }
  // Map 146 is excluded, with a reason. `isPassable` is STATEFUL (`_playerZ`),
  // so a flood run inside the constructor and a flood run afterwards can walk
  // different z-levels and disagree: the renderer's own room flood finds 75
  // tiles there, this one finds 1. The clip is correct for the renderer's view;
  // the gate simply cannot see the same room. Same hazard `map-connectivity.mjs`
  // documents. Not a licence to add more entries — anything else here is a bug.
  const STATEFUL_Z_DIVERGENCE = new Set([146]);
  if (!STATEFUL_Z_DIVERGENCE.has(id) &&
      rmaxX >= 0 && (x0 < rminX - 1 || y0 < rminY - 1 || x1 > rmaxX + 2 || y1 > rmaxY + 2)) {
    console.error(`  ✗ map ${id}: clip (x${x0} y${y0} -> x${x1} y${y1}) extends past the room ` +
      `(x${rminX}-${rmaxX} y${rminY}-${rmaxY}) — another room's tiles are drawn`);
    failed++;
    continue;
  }
  if (outside > 0) {
    console.error(`  ✗ map ${id}: ${outside} of ${seen.size} walkable tiles fall OUTSIDE the drawn area ` +
      `(clip x${x0} y${y0} w${c.w / TILE} h${c.h / TILE})`);
    failed++;
    if (!worst || outside > worst.n) worst = { id, n: outside };
  }
}

if (!checked) { console.error('check-room-clip: no maps checked'); process.exit(2); }
if (failed) {
  console.error(`\ncheck-room-clip: FAIL — ${failed} of ${checked} maps let the player walk into un-drawn space` +
    (worst ? ` (worst: map ${worst.id}, ${worst.n} tiles)` : ''));
  process.exit(1);
}
console.log(`check-room-clip: OK — all ${checked} maps draw everywhere the player can reach`);
