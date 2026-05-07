// Bayer 4×4 dithering matrix — used for boss dissolve effect
export const BAYER4 = [
  [ 0, 8, 2,10],
  [12, 4,14, 6],
  [ 3,11, 1, 9],
  [15, 7,13, 5],
];

// Damage number bounce — 33 keyframes @ 60fps from REC OAM (FF3J, 2026-05-07).
// Frames 0-29 verified pixel-for-pixel against capture; trailing 5,6,6 are the
// final dip + held bottom before the popup vanishes at frame 33 (~549ms total,
// matching DMG_SHOW_MS = 550). Earlier 30-entry table clamped at +3 for the
// last ~50ms instead of falling.
export const DMG_BOUNCE_TABLE = [
  0, -6, -11, -16, -20, -23, -25,    // fast rise (7 frames)
  -25, -25,                           // hang at peak (2 frames)
  -23, -20, -16, -11, -6, 0,         // fall back to baseline (6 frames)
  6, 5, 3, 2, 1, 0,                  // small overshoot + settle (6 frames)
  -1, -1, -1, -1, -1,                // tiny second bounce hold (5 frames)
  0, 1, 2, 3, 5, 6, 6                // final settle + dip + held bottom (7 frames)
];

const DMG_BOUNCE_FRAME_MS = 16.67;

export function _dmgBounceY(baseY, timer) {
  const frame = Math.min(Math.floor(timer / DMG_BOUNCE_FRAME_MS), DMG_BOUNCE_TABLE.length - 1);
  return baseY + DMG_BOUNCE_TABLE[frame];
}
