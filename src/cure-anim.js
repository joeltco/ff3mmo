// Cure spell animation — captured from FF3 NES via EMU tab REC OAM (100 frames).
// White-magic SP3 palette is fixed in the ROM: [0x0F, 0x12, 0x22, 0x31].
//
// Vocabulary (the user's; pin it here so future-me doesn't drift):
//   "flame"       — pulsing 4-size sprite drawn LEFT of the player; tiles $4A
//                   (size 1) → $4B-$4E (size 2) → $4F-$52 (size 3) → $53-$56
//                   (size 4) → $57 brackets (release flash).
//   "stars"       — 8 rotating $49 tiles forming a ring around the player.
//   "heal sparkle" — ONE 16×16 ($4A + $49 after CHR rebank) drawn on whoever
//                   the spell is healing. NOT the same thing as the stars.
//
// The captured animation has 5 phases (60 Hz NES → ms):
//   build-up (f0-47, 800ms)  — flame pulses 4 sizes + stars rotate around player
//   lunge    (f48-59, 200ms) — caster slides; in our 16×16 portrait we hold
//   cast     (f60-72, 217ms) — body swap (engine's existing item-use pose)
//   heal     (f73-89, 283ms) — heal sparkle on target ($4A + $49 after CHR rebank)
//   return   (f90-99, 167ms) — caster slides further, anim ends
//
// Tiles $4A and $49 mean different pixels in the build-up vs. heal phases due
// to MMC3 CHR bank switching. Both byte sets are captured here.

import { NES_SYSTEM_PALETTE } from './tile-decoder.js';
import { _makeCanvas16 } from './canvas-utils.js';

const PAL = [0x0F, 0x12, 0x22, 0x31];

// ── Build-up phase tiles ($4A-$57 flame + $49 small star) ──────────────────

const T_4A = new Uint8Array([0x00,0x00,0x00,0x00,0x03,0x04,0x0B,0x0B, 0x00,0x00,0x00,0x00,0x00,0x03,0x07,0x07]);

const T_4B = new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,0x01,0x01,0x01,0x03]);
const T_4C = new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,0x00,0x00,0x80,0x80]);
const T_4D = new Uint8Array([0x01,0x03,0x03,0x01,0x00,0x00,0x00,0x00, 0x03,0x07,0x07,0x07,0x03,0x00,0x00,0x00]);
const T_4E = new Uint8Array([0x00,0x80,0x80,0x00,0x00,0x00,0x00,0x00, 0xC0,0xC0,0xC0,0xC0,0x80,0x00,0x00,0x00]);

const T_4F = new Uint8Array([0x01,0x01,0x03,0x02,0x02,0x04,0x05,0x09, 0x00,0x00,0x00,0x01,0x01,0x03,0x03,0x07]);
const T_50 = new Uint8Array([0x00,0x00,0x80,0x80,0x40,0x40,0x40,0x60, 0x00,0x00,0x00,0x00,0x80,0x80,0x80,0x80]);
const T_51 = new Uint8Array([0x0B,0x0B,0x0B,0x09,0x04,0x03,0x00,0x00, 0x07,0x07,0x07,0x07,0x03,0x00,0x00,0x00]);
const T_52 = new Uint8Array([0xA0,0xB0,0xB0,0xA0,0x60,0xC0,0x00,0x00, 0xC0,0xC0,0xC0,0xC0,0x80,0x00,0x00,0x00]);

const T_53 = new Uint8Array([0x00,0x00,0x04,0x00,0x01,0x09,0x02,0x06, 0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x01]);
const T_54 = new Uint8Array([0x80,0x80,0x40,0xD0,0xD0,0x60,0x20,0xB0, 0x00,0x00,0x00,0x00,0x00,0x80,0xC0,0xC0]);
const T_55 = new Uint8Array([0x0D,0x09,0x0B,0x09,0x04,0x03,0x00,0x00, 0x03,0x07,0x07,0x07,0x03,0x00,0x00,0x00]);
const T_56 = new Uint8Array([0xD8,0xC8,0xE8,0xD8,0xB0,0xE0,0x00,0x00, 0xE0,0xF0,0xF0,0xE0,0xC0,0x00,0x00,0x00]);

const T_57 = new Uint8Array([0x00,0x00,0x30,0x20,0x08,0x04,0x00,0x00, 0x00,0x00,0x30,0x38,0x10,0x00,0x00,0x00]);

const T_49_STAR = new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x10,0x38,0xFE,0x7C,0x7C,0x6C,0x44,0x00]);

// ── Heal phase tiles (CHR bank-switched at f73) ─────────────────────────────
const T_4A_HEAL = new Uint8Array([0x00,0x00,0x00,0x00,0x08,0x00,0x00,0x00, 0x00,0x00,0x00,0x08,0x1C,0x08,0x00,0x00]);
const T_49_HEAL = new Uint8Array([0x10,0x10,0x28,0xD6,0x28,0x10,0x10,0x00, 0x00,0x00,0x10,0x38,0x10,0x00,0x00,0x00]);

// ── Decode helpers ──────────────────────────────────────────────────────────

function _decodeTilePixels(d) {
  const out = new Uint8Array(64);
  for (let row = 0; row < 8; row++) {
    const lo = d[row], hi = d[row + 8];
    for (let bit = 7; bit >= 0; bit--) {
      out[row * 8 + (7 - bit)] = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
    }
  }
  return out;
}

function _make8(tile) {
  const c = document.createElement('canvas'); c.width = 8; c.height = 8;
  const cx = c.getContext('2d');
  const px = _decodeTilePixels(tile);
  const img = cx.createImageData(8, 8);
  for (let p = 0; p < 64; p++) {
    const ci = px[p];
    if (ci === 0) { img.data[p * 4 + 3] = 0; continue; }
    const rgb = NES_SYSTEM_PALETTE[PAL[ci]] || [0, 0, 0];
    img.data[p * 4] = rgb[0]; img.data[p * 4 + 1] = rgb[1];
    img.data[p * 4 + 2] = rgb[2]; img.data[p * 4 + 3] = 255;
  }
  cx.putImageData(img, 0, 0);
  return c;
}

// 4-quadrant flipped layout: TL = src, TR = HFLIP, BL = VFLIP, BR = both.
// Used for size-1 ($4A) and brackets ($57) which build a 16×16 ring from one tile.
function _flippedQuad(tile8) {
  const c = _makeCanvas16(); const cx = c.getContext('2d');
  cx.drawImage(tile8, 0, 0);
  cx.save(); cx.translate(16, 0);  cx.scale(-1,  1); cx.drawImage(tile8, 0, 0); cx.restore();
  cx.save(); cx.translate(0,  16); cx.scale( 1, -1); cx.drawImage(tile8, 0, 0); cx.restore();
  cx.save(); cx.translate(16, 16); cx.scale(-1, -1); cx.drawImage(tile8, 0, 0); cx.restore();
  return c;
}

// 4-distinct-tile 16×16: TL, TR, BL, BR.
function _quad4(tl, tr, bl, br) {
  const c = _makeCanvas16(); const cx = c.getContext('2d');
  cx.drawImage(tl, 0, 0); cx.drawImage(tr, 8, 0);
  cx.drawImage(bl, 0, 8); cx.drawImage(br, 8, 8);
  return c;
}

// ── Public init ─────────────────────────────────────────────────────────────

// Returns:
//   flameFrames:      [size1, size2, size3, size4, brackets] — 5× 16×16 canvases
//   starTile:         8×8 canvas (build-up rotating-star tile, T_49_STAR)
//   healSparkleFrame: 16×16 canvas (phase-4 target sparkle, captured from f73)
export function initCureAnimSprites() {
  const t4a = _make8(T_4A);
  const t4b = _make8(T_4B), t4c = _make8(T_4C), t4d = _make8(T_4D), t4e = _make8(T_4E);
  const t4f = _make8(T_4F), t50 = _make8(T_50), t51 = _make8(T_51), t52 = _make8(T_52);
  const t53 = _make8(T_53), t54 = _make8(T_54), t55 = _make8(T_55), t56 = _make8(T_56);
  const t57 = _make8(T_57);

  const flameFrames = [
    _flippedQuad(t4a),               // size 1 — smallest ring
    _quad4(t4b, t4c, t4d, t4e),      // size 2
    _quad4(t4f, t50, t51, t52),      // size 3
    _quad4(t53, t54, t55, t56),      // size 4 — XL ring
    _flippedQuad(t57),               // brackets — release flash
  ];

  const starTile = _make8(T_49_STAR);

  // Heal sparkle: same TL/TR/BL/BR pattern as captured frame 73, where $4A
  // (small dot) frames the corners and $49 (big asterisk) sits inside.
  // From f73: [0,5] $4A HFLIP, [8,5] $49 HFLIP, [0,13] $49 VFLIP, [8,13] $4A VFLIP.
  const t4aHeal = _make8(T_4A_HEAL);
  const t49Heal = _make8(T_49_HEAL);
  const healSparkleFrame = _quad4(t4aHeal, t49Heal, t49Heal, t4aHeal);

  return { flameFrames, starTile, healSparkleFrame };
}

// ── Phase mapping (ms-based, 60 Hz NES capture × 16.67ms/frame) ─────────────

export const CURE_PHASE_MS = {
  buildup: 800,    // f0-47   flame pulses + stars rotate
  lunge:   200,    // f48-59  caster slides (visual no-op in our portrait)
  cast:    217,    // f60-72  cast pose hold (engine's item-use pose)
  heal:    283,    // f73-89  heal sparkle on target + heal number
  ret:     167,    // f90-99  return — anim ends
};

export const CURE_TOTAL_MS =
  CURE_PHASE_MS.buildup + CURE_PHASE_MS.lunge + CURE_PHASE_MS.cast +
  CURE_PHASE_MS.heal + CURE_PHASE_MS.ret;

// Phase boundary ms-offsets from t=0 of magic-cast.
export const CURE_T_LUNGE  = CURE_PHASE_MS.buildup;
export const CURE_T_CAST   = CURE_T_LUNGE + CURE_PHASE_MS.lunge;
export const CURE_T_HEAL   = CURE_T_CAST + CURE_PHASE_MS.cast;
export const CURE_T_RETURN = CURE_T_HEAL + CURE_PHASE_MS.heal;

// Flame pulse cycle, transcribed from OAM frame-by-frame (cure_bg, f0-47):
//   f0-3   size 1 ($4A ×4 with corner flips)
//   f4-7   size 2 normal
//   f8-11  size 2 h-mirror (visually similar to size 2)
//   f12-15 size 3 normal
//   f16-19 size 4 normal
//   f20-23 size 4 h-mirror
//   f24-27 size 3 normal
//   f28-31 size 4 normal
//   f32-35 size 4 h-mirror
//   f36-47 brackets ($57)
// h-mirror variants collapse to their non-mirrored size (the eye doesn't
// distinguish a symmetric ring from its mirror); cycle reduces to 9 hops at
// 67 ms each, then brackets for ~200 ms.
const _FLAME_SEQ = [0, 1, 1, 2, 3, 3, 2, 3, 3];

// Returns 0..4 (size1, size2, size3, size4, brackets) or -1 if not in build-up.
export function getCureFlameFrameIdx(elapsedMs) {
  if (elapsedMs < 0 || elapsedMs >= CURE_T_LUNGE) return -1;
  if (elapsedMs >= 600) return 4; // brackets
  const step = Math.min(_FLAME_SEQ.length - 1, Math.floor(elapsedMs / 67));
  return _FLAME_SEQ[step];
}

// True while the rotating stars should be drawn — phases 1+2 (f0-59 in
// capture). Stars continue through the lunge phase even though the flame
// disappears at the end of build-up.
export function shouldDrawStars(elapsedMs) {
  return elapsedMs >= 0 && elapsedMs < CURE_T_CAST;
}

// True while the heal-phase target sparkle should be drawn (phase 4).
export function shouldDrawHealSparkle(elapsedMs) {
  return elapsedMs >= CURE_T_HEAL && elapsedMs < CURE_T_RETURN;
}
