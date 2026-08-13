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
const { calcSpawnY } = await import('./lib/spawn.mjs');

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));
const W = 32, TILE = 16;

// The enclosed building interiors that were measured drawing a neighbouring
// room's wall band below their own (tools/gt-sweep.mjs against the real ROM).
// Pinned by id rather than re-deriving "is this an interior" here, so the gate
// tests the fix rather than restating the renderer's own heuristic and
// agreeing with itself.
const TRAILING_MAPS = new Set([3, 12, 13, 15, 47]);

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
  // Seed from where the player actually LANDS, not the raw ROM entrance — the
  // renderer builds its clip from this tile, so seeding it wrong tests a clip
  // the game never constructs. See tools/lib/spawn.mjs.
  const sx = md.entranceX, sy = calcSpawnY(md, md.entranceX, md.entranceY);
  let r;
  try { r = new MapRenderer(md, sx, sy); } catch { continue; }
  checked++;

  // z-aware flood — same state model the renderer uses (v1.7.955). `isPassable`
  // is pure now, so this is deterministic and agrees with the mask.
  const seen = new Set([sy * W + sx]);
  {
    const z0 = r._playerZ;
    const seenState = new Set([(sy * W + sx) * 4 + z0]);
    const q = [[sx, sy, z0]];
    while (q.length) {
      const [x, y, z] = q.pop();
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= W) continue;
        if (!r.isPassable(nx, ny, z)) continue;
        const nz = r.zAfterEntering(nx, ny, z);
        const st = (ny * W + nx) * 4 + nz;
        if (seenState.has(st)) continue;
        seenState.add(st);
        seen.add(ny * W + nx);
        q.push([nx, ny, nz]);
      }
    }
  }

  const c = r._roomClip;
  if (!c) continue;                     // whole map drawn — nothing to check
  const x0 = c.x / TILE, y0 = c.y / TILE, x1 = x0 + c.w / TILE;
  let y1 = y0 + c.h / TILE;
  let outside = 0;
  for (const k of seen) {
    const x = k % W, y = (k - (k % W)) / W;
    if (x < x0 || x >= x1 || y < y0 || y >= y1) outside++;
  }
  // The "clip must not extend past the room" invariant from v1.7.953 has been
  // REMOVED, because it was wrong. Enforcing it clamped the clip down to the
  // walkable area, and a TOWN's buildings, trees and scenery sit outside the
  // walkable tiles — Kazus rendered as scattered fragments. Drawing a little
  // extra is cosmetic; drawing too little deletes the town.
  //
  // What remains is the invariant that actually protects the player: every tile
  // you can walk to must be painted.
  if (outside > 0) {
    console.error(`  ✗ map ${id}: ${outside} of ${seen.size} walkable tiles fall OUTSIDE the drawn area ` +
      `(clip x${x0} y${y0} w${c.w / TILE} h${c.h / TILE})`);
    failed++;
    if (!worst || outside > worst.n) worst = { id, n: outside };
  }

  // The OTHER direction, for enclosed building interiors only: the clip must
  // not run past the room's last walkable row. Overshooting paints a
  // full-width wall band from a NEIGHBOURING room below the player's — the
  // "trailing tiles outside of the rooms" bug. Verified against the real ROM
  // with tools/gt-sweep.mjs (jsnes warps to each map; the actual PPU output is
  // diffed against ours): maps 3, 15 and 47 each drew a 7-tile band the real
  // game leaves blank, and map 13 — the Kazus inn — an 8-tile one.
  //
  // Interiors ONLY. A town's scenery legitimately sits below its walkable
  // tiles, and enforcing this everywhere is what deleted Kazus in v1.7.954.
  // Coming BACK through a door seeds the renderer at the return position rather
  // than the spawn (`map-loading.js` hands returnX/returnY straight to
  // `new MapRenderer`), which builds a DIFFERENT clip from the same map. That is
  // how the Kazus inn's first floor showed four foreign rows above its room:
  // entering from town the clip started at row 10, coming back down from
  // upstairs it started at row 9, while the room begins at row 13.
  //
  // Asserted only for the maps measured against the real ROM, and only on the
  // TOP edge. A general "clip must not exceed the room" rule is not expressible
  // here without re-deriving the renderer's own attachment walk — a gate that
  // restates the implementation only ever agrees with it.
  if (TRAILING_MAPS.has(id)) {
    for (const [key, t] of md.triggerMap) {
      if (t.type !== 1) continue;                     // doors only
      const [dx, dy] = key.split(',').map(Number);
      let dr;
      try { dr = new MapRenderer(md, dx, dy); } catch { continue; }
      const dd = dr._clipDiag;
      if (!dr._roomClip || !dd || dd.rminY === undefined) continue;
      const dTop = dr._roomClip.y / TILE;
      if (dTop < dd.rminY) {
        console.error(`  ✗ map ${id}: coming back through the door at (${dx},${dy}) starts the clip at ` +
          `row ${dTop} for a room beginning at row ${dd.rminY} — ` +
          `${dd.rminY - dTop} foreign row(s) above the room`);
        failed++;
        break;                                        // one report per map
      }
    }
  }

  if (TRAILING_MAPS.has(id)) {
    let lastWalkRow = -1;
    for (const k of seen) {
      const y = (k - (k % W)) / W;
      if (y > lastWalkRow) lastWalkRow = y;
    }
    // Rows made entirely of the fill tile paint nothing — they are void, and
    // including them is invisible. Only rows carrying real tiles can show as
    // another room's wall band. (Map 12's clip ends one row low, but that row
    // is pure fill.)
    while (y1 > lastWalkRow + 1) {
      const row = y1 - 1;
      let anyDrawn = false;
      for (let x = x0; x < x1 && !anyDrawn; x++) {
        if (md.tilemap[row * W + x] !== md.fillTile) anyDrawn = true;
      }
      if (anyDrawn) break;
      y1--;
    }
    if (y1 > lastWalkRow + 1) {
      console.error(`  ✗ map ${id}: clip bottom row ${y1 - 1} is past the room's last walkable row ` +
        `${lastWalkRow} — ${(y1 - 1 - lastWalkRow) * (x1 - x0)} trailing tiles from the next room`);
      failed++;
    }
  }
}

if (!checked) { console.error('check-room-clip: no maps checked'); process.exit(2); }
if (failed) {
  console.error(`\ncheck-room-clip: FAIL — ${failed} of ${checked} maps draw the wrong area ` +
    `(walkable tiles left unpainted, or a neighbouring room's tiles trailing below)` +
    (worst ? ` (worst: map ${worst.id}, ${worst.n} tiles)` : ''));
  process.exit(1);
}
console.log(`check-room-clip: OK — all ${checked} maps draw everywhere the player can reach`);
