// Moogle NPC sprite — hand-authored 16×16, 2 walk frames.
//
// Moogles do not exist in NES FF3 (they were introduced in the DS remake), so
// there is no ROM source to extract from. This sprite is original pixel art.
// Authored as a 16×16 grid of color indices 0-3 per frame, then sliced into
// the same TL/TR/BL/BR 8×8 tile layout the rest of the sprite system expects
// (matches `flame-sprites.js` / player `WALK_FRAMES`).
//
// Color indices (NES palette entries, picked at render time):
//   0 = transparent
//   1 = black outline ($0F)
//   2 = white body    ($30)
//   3 = pink pompom   ($25)

import { NES_SYSTEM_PALETTE } from '../tile-decoder.js';

export const MOOGLE_PALETTE_NES = [null, 0x0F, 0x30, 0x25];

// Each frame: 16 rows × 16 cols. `.` = transparent, digits 1-3 = color index.
// Visual sanity-check: read top-to-bottom — pompom dot, antenna stem, body
// outline circle, eye pair, mouth bar, two feet.
const FRAME_A = [
  '.......3........',
  '......131.......',
  '......131.......',
  '.......1........',
  '....1111111.....',
  '...122222221....',
  '..12222222221...',
  '..12212221221...',
  '..12212221221...',
  '..12222222221...',
  '..12221112221...',
  '..12222222221...',
  '...122222221....',
  '....11111111....',
  '.....11..11.....',
  '................',
];

// Frame B: feet shift apart (walk-in-place bob). Everything above row 14
// stays identical so the head/body never wobbles — only the feet step.
const FRAME_B = [
  '.......3........',
  '......131.......',
  '......131.......',
  '.......1........',
  '....1111111.....',
  '...122222221....',
  '..12222222221...',
  '..12212221221...',
  '..12212221221...',
  '..12222222221...',
  '..12221112221...',
  '..12222222221...',
  '...122222221....',
  '....11111111....',
  '....11....11....',
  '................',
];

// Slice a 16×16 grid into [TL, TR, BL, BR] 64-byte pixel arrays.
function _gridToTiles(grid) {
  const tiles = [new Uint8Array(64), new Uint8Array(64), new Uint8Array(64), new Uint8Array(64)];
  for (let py = 0; py < 16; py++) {
    const row = grid[py];
    for (let px = 0; px < 16; px++) {
      const ch = row[px];
      const ci = ch === '.' ? 0 : (ch.charCodeAt(0) - 48);
      const tileIdx = (py < 8 ? 0 : 2) + (px < 8 ? 0 : 1);
      const tx = px & 7;
      const ty = py & 7;
      tiles[tileIdx][ty * 8 + tx] = ci;
    }
  }
  return tiles;
}

export function getMoogleFrames() {
  return [_gridToTiles(FRAME_A), _gridToTiles(FRAME_B)];
}

// Resolve color indices to RGB triplets via the NES system palette. Index 0
// stays null (transparent) for the renderer to mask.
export function getMoogleRgbPalette() {
  return MOOGLE_PALETTE_NES.map(ci => ci == null ? null : NES_SYSTEM_PALETTE[ci & 0x3F]);
}
