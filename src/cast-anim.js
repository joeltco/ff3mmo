// Caster-side cast animation, dispatched by JOB (not by spell).
//
// Architectural rule (the user has stated this across multiple sessions):
//   • Cast animations are PER-JOB. Every White Mage spell shares the WM cast
//     pose; every Black Mage spell shares the BM cast pose.
//   • Projectile is shared across thrown spells (see projectile-anim.js).
//   • Only the on-target effect varies per spell (see spell-anim.js).
//
// Each job entry owns:
//   - `flameFrames` — array of pre-decoded canvases for the size cycle
//   - `starTile`    — optional 8×8 rotating star (WM only)
//   - `flameDx/Dy`  — anchor offset from portrait origin
//   - `getFlameFrameIdx(elapsedMs)` — picks which size to draw
//
// Caller computes elapsedMs from cast t=0 and passes its portrait origin; the
// render sites stay thin. Tile bytes for both jobs were captured via REC OAM.

import { NES_SYSTEM_PALETTE } from './tile-decoder.js';
import { _makeCanvas16 } from './canvas-utils.js';

// Single palette per job. Per the user's rule: WM cast looks the same for all
// WM spells. Earlier code in cure-anim.js swapped palette per school (Cure blue
// vs Poisona magenta vs revive); that was the wrong axis of decomposition and
// is dropped here. Only the on-target effect (in spell-anim.js) varies.
const WM_PAL = [0x0F, 0x12, 0x22, 0x31];  // blue / cyan / white
const BM_PAL = [0x0F, 0x16, 0x27, 0x30];  // red / orange / white (REC OAM 2026-05-07 f9627)

// ── Phase timings (60 Hz NES capture × 16.67 ms/frame) ────────────────────
//
// Same model as the WM Cure capture from 2026-05-04 (was CURE_PHASE_MS in
// cure-anim.js). The timings hold for all magic-cast — only the visuals
// rendered during each phase differ per job/spell.

export const CAST_PHASE_MS = {
  buildup: 800,    // f0-47   flame pulses on caster
  lunge:   200,    // f48-59  caster slides (visual no-op in our portrait)
  cast:    217,    // f60-72  cast pose hold
  heal:    283,    // f73-89  on-target effect plays here (see spell-anim.js)
  ret:     167,    // f90-99  return — anim ends
};

export const CAST_T_LUNGE  = CAST_PHASE_MS.buildup;
export const CAST_T_CAST   = CAST_T_LUNGE + CAST_PHASE_MS.lunge;
export const CAST_T_HEAL   = CAST_T_CAST + CAST_PHASE_MS.cast;
export const CAST_T_RETURN = CAST_T_HEAL + CAST_PHASE_MS.heal;
export const CAST_TOTAL_MS = CAST_T_RETURN + CAST_PHASE_MS.ret;

// ── WM cast tile bytes ($4A-$57 flame, $49 small star) ────────────────────
// Captured 2026-05-04 (REC OAM). Bytes verbatim from the prior cure-anim.js.

const WM_T_4A = new Uint8Array([0x00,0x00,0x00,0x00,0x03,0x04,0x0B,0x0B, 0x00,0x00,0x00,0x00,0x00,0x03,0x07,0x07]);

const WM_T_4B = new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,0x01,0x01,0x01,0x03]);
const WM_T_4C = new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,0x00,0x00,0x80,0x80]);
const WM_T_4D = new Uint8Array([0x01,0x03,0x03,0x01,0x00,0x00,0x00,0x00, 0x03,0x07,0x07,0x07,0x03,0x00,0x00,0x00]);
const WM_T_4E = new Uint8Array([0x00,0x80,0x80,0x00,0x00,0x00,0x00,0x00, 0xC0,0xC0,0xC0,0xC0,0x80,0x00,0x00,0x00]);

const WM_T_4F = new Uint8Array([0x01,0x01,0x03,0x02,0x02,0x04,0x05,0x09, 0x00,0x00,0x00,0x01,0x01,0x03,0x03,0x07]);
const WM_T_50 = new Uint8Array([0x00,0x00,0x80,0x80,0x40,0x40,0x40,0x60, 0x00,0x00,0x00,0x00,0x80,0x80,0x80,0x80]);
const WM_T_51 = new Uint8Array([0x0B,0x0B,0x0B,0x09,0x04,0x03,0x00,0x00, 0x07,0x07,0x07,0x07,0x03,0x00,0x00,0x00]);
const WM_T_52 = new Uint8Array([0xA0,0xB0,0xB0,0xA0,0x60,0xC0,0x00,0x00, 0xC0,0xC0,0xC0,0xC0,0x80,0x00,0x00,0x00]);

const WM_T_53 = new Uint8Array([0x00,0x00,0x04,0x00,0x01,0x09,0x02,0x06, 0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x01]);
const WM_T_54 = new Uint8Array([0x80,0x80,0x40,0xD0,0xD0,0x60,0x20,0xB0, 0x00,0x00,0x00,0x00,0x00,0x80,0xC0,0xC0]);
const WM_T_55 = new Uint8Array([0x0D,0x09,0x0B,0x09,0x04,0x03,0x00,0x00, 0x03,0x07,0x07,0x07,0x03,0x00,0x00,0x00]);
const WM_T_56 = new Uint8Array([0xD8,0xC8,0xE8,0xD8,0xB0,0xE0,0x00,0x00, 0xE0,0xF0,0xF0,0xE0,0xC0,0x00,0x00,0x00]);

const WM_T_57 = new Uint8Array([0x00,0x00,0x30,0x20,0x08,0x04,0x00,0x00, 0x00,0x00,0x30,0x38,0x10,0x00,0x00,0x00]);

const WM_T_49_STAR = new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x10,0x38,0xFE,0x7C,0x7C,0x6C,0x44,0x00]);

// ── BM cast tile bytes ($49-$57) ──────────────────────────────────────────
// Captured 2026-05-07 (REC OAM f9627). Group at origin (176, 41) frames 0-43.
// Outer corners + middle ring stay constant; inner-corner tile rotates through
// $51/$52 (size 0) → $54 (size 1) → $55 (size 2) → $56 (size 3) → $57 (size 4
// release flash) across the ~733 ms buildup window.

// Outer ring
const BM_T_49 = new Uint8Array([0x00,0x01,0x00,0x11,0x0A,0x07,0x2D,0x1E, 0x00,0x41,0x01,0x11,0x0F,0x0F,0xAF,0x1F]);
const BM_T_4A = new Uint8Array([0x05,0x2F,0xFF,0xED,0xFA,0xA0,0x45,0x97, 0x45,0x3F,0xFF,0xFF,0xFF,0xFF,0xFA,0xE8]);
const BM_T_4F = new Uint8Array([0x1E,0x2D,0x07,0x0A,0x11,0x00,0x01,0x00, 0x1F,0xAF,0x0F,0x0F,0x11,0x01,0x41,0x00]);
const BM_T_50 = new Uint8Array([0x97,0x4A,0xA5,0xF5,0xDA,0xFF,0x2F,0x05, 0xE8,0xF5,0xFA,0xFF,0xFF,0xFF,0x3F,0x45]);

// Middle ring
const BM_T_4B = new Uint8Array([0x5A,0x34,0xB9,0x70,0x6B,0xB4,0x69,0xB2, 0x7F,0x3F,0xBE,0x7F,0x7E,0xFF,0x7E,0xFD]);
const BM_T_4C = new Uint8Array([0xAD,0x57,0x3F,0xDF,0x7F,0xBF,0xFF,0xBF, 0x52,0xA8,0xC0,0x20,0x80,0x40,0x00,0x40]);
const BM_T_4D = new Uint8Array([0x69,0x71,0x6A,0xB1,0x72,0x18,0x35,0x58, 0xFE,0x7E,0x7D,0xFE,0x7D,0x3F,0x3E,0x7F]);
const BM_T_4E = new Uint8Array([0xFF,0x7F,0xFF,0x7F,0xBF,0x7F,0x2F,0x5D, 0x00,0x80,0x00,0x80,0x40,0x80,0xD0,0xA2]);

// Inner pulse (size cycle)
const BM_T_51 = new Uint8Array([0x80,0x40,0x10,0x28,0x1A,0x05,0x0A,0x01, 0x00,0x00,0x20,0x10,0x0C,0x0E,0x07,0x07]);
const BM_T_52 = new Uint8Array([0x00,0x00,0x00,0x08,0x20,0xD0,0x60,0xA0, 0x00,0x00,0x00,0x00,0x10,0x20,0xC0,0xC0]);
const BM_T_54 = new Uint8Array([0x00,0x00,0x00,0x00,0x07,0x18,0x67,0xCF, 0x00,0x00,0x00,0x00,0x00,0x07,0x1F,0x3F]);
const BM_T_55 = new Uint8Array([0x00,0x00,0x07,0x1C,0x31,0x67,0x4F,0x4F, 0x00,0x00,0x00,0x03,0x0F,0x1F,0x3F,0x3F]);
const BM_T_56 = new Uint8Array([0x07,0x0C,0x18,0x19,0x33,0x37,0x27,0x27, 0x00,0x03,0x07,0x07,0x0F,0x0F,0x1F,0x1F]);
const BM_T_57 = new Uint8Array([0x00,0x00,0x0A,0x10,0x00,0x22,0x00,0x00, 0x00,0x00,0x02,0x00,0x04,0x02,0x08,0x00]);

// ── Decode helpers ────────────────────────────────────────────────────────

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

function _make8(tile, pal) {
  const c = document.createElement('canvas'); c.width = 8; c.height = 8;
  const cx = c.getContext('2d');
  const px = _decodeTilePixels(tile);
  const img = cx.createImageData(8, 8);
  for (let p = 0; p < 64; p++) {
    const ci = px[p];
    if (ci === 0) { img.data[p * 4 + 3] = 0; continue; }
    const rgb = NES_SYSTEM_PALETTE[pal[ci]] || [0, 0, 0];
    img.data[p * 4] = rgb[0]; img.data[p * 4 + 1] = rgb[1];
    img.data[p * 4 + 2] = rgb[2]; img.data[p * 4 + 3] = 255;
  }
  cx.putImageData(img, 0, 0);
  return c;
}

// 4-quadrant flipped layout: TL = src, TR = HFLIP, BL = VFLIP, BR = both.
function _flippedQuad(tile8) {
  const c = _makeCanvas16(); const cx = c.getContext('2d');
  cx.drawImage(tile8, 0, 0);
  cx.save(); cx.translate(16, 0);  cx.scale(-1,  1); cx.drawImage(tile8, 0, 0); cx.restore();
  cx.save(); cx.translate(0,  16); cx.scale( 1, -1); cx.drawImage(tile8, 0, 0); cx.restore();
  cx.save(); cx.translate(16, 16); cx.scale(-1, -1); cx.drawImage(tile8, 0, 0); cx.restore();
  return c;
}

function _quad4(tl, tr, bl, br) {
  const c = _makeCanvas16(); const cx = c.getContext('2d');
  cx.drawImage(tl, 0, 0); cx.drawImage(tr, 8, 0);
  cx.drawImage(bl, 0, 8); cx.drawImage(br, 8, 8);
  return c;
}

// ── Per-job decode ────────────────────────────────────────────────────────

function _decodeWMCast() {
  const t4a = _make8(WM_T_4A, WM_PAL);
  const t4b = _make8(WM_T_4B, WM_PAL), t4c = _make8(WM_T_4C, WM_PAL);
  const t4d = _make8(WM_T_4D, WM_PAL), t4e = _make8(WM_T_4E, WM_PAL);
  const t4f = _make8(WM_T_4F, WM_PAL), t50 = _make8(WM_T_50, WM_PAL);
  const t51 = _make8(WM_T_51, WM_PAL), t52 = _make8(WM_T_52, WM_PAL);
  const t53 = _make8(WM_T_53, WM_PAL), t54 = _make8(WM_T_54, WM_PAL);
  const t55 = _make8(WM_T_55, WM_PAL), t56 = _make8(WM_T_56, WM_PAL);
  const t57 = _make8(WM_T_57, WM_PAL);

  const flameFrames = [
    _flippedQuad(t4a),               // size 1 — smallest ring
    _quad4(t4b, t4c, t4d, t4e),      // size 2
    _quad4(t4f, t50, t51, t52),      // size 3
    _quad4(t53, t54, t55, t56),      // size 4 — XL ring
    _flippedQuad(t57),               // brackets — release flash
  ];
  const starTile = _make8(WM_T_49_STAR, WM_PAL);
  return { flameFrames, starTile };
}

// BM cast: 32×32 halo around the player portrait. Outer ring + middle ring
// stay constant; inner pulse tile cycles per size. Frame 0 layout (origin
// 176,41 in the dump) is mirrored across both axes — the captured tiles cover
// only the upper-left quadrant of the halo and the rest is built from flips.
//
// Layout (each entry = 8×8 tile slot relative to the 32×32 halo canvas):
//   row 0 (y=0)    [8,0]=$49      [16,0]=$4A      [24,0]=$50 V H  [32,0]=$4F V H
//   row 1 (y=8)    [0,8]=$51/etc  [8,8]=$52/etc + $4B  [16,8]=$4C  [24,8]=$4E V H  [32,8]=$4D V H
//   row 2 (y=16)   mirror of row 1 across x-axis
//   row 3 (y=24)   mirror of row 0 across x-axis
//
// Halo is drawn at (portrait_x - 8, portrait_y - 4) so the 32×32 halo wraps
// the 16×16 portrait centered (8 px overhang each side, 4 px top/bottom).
function _buildBMCastFrame(innerTile) {
  const t49 = _make8(BM_T_49, BM_PAL), t4a = _make8(BM_T_4A, BM_PAL);
  const t4f = _make8(BM_T_4F, BM_PAL), t50 = _make8(BM_T_50, BM_PAL);
  const t4b = _make8(BM_T_4B, BM_PAL), t4c = _make8(BM_T_4C, BM_PAL);
  const t4d = _make8(BM_T_4D, BM_PAL), t4e = _make8(BM_T_4E, BM_PAL);
  const inner = _make8(innerTile, BM_PAL);

  const c = document.createElement('canvas'); c.width = 40; c.height = 32;
  const cx = c.getContext('2d');

  const draw = (tile, x, y, hf, vf) => {
    cx.save();
    cx.translate(x + (hf ? 8 : 0), y + (vf ? 8 : 0));
    cx.scale(hf ? -1 : 1, vf ? -1 : 1);
    cx.drawImage(tile, 0, 0);
    cx.restore();
  };

  // Row 0 (y=0): top corner ring
  draw(t49, 8,  0, false, false);
  draw(t4a, 16, 0, false, false);
  draw(t50, 24, 0, true,  true);
  draw(t4f, 32, 0, true,  true);
  // Row 1 (y=8): inner-corner pulse + middle ring
  draw(inner, 0, 8, false, false);
  draw(inner, 8, 8, true,  false);
  draw(t4b,   8, 8, false, false);
  draw(t4c,  16, 8, false, false);
  draw(t4e,  24, 8, true,  true);
  draw(t4d,  32, 8, true,  true);
  // Row 2 (y=16): mirror of row 1 (inner pulse VFLIP, middle ring shifted)
  draw(inner, 0, 16, false, true);
  draw(inner, 8, 16, true,  true);
  draw(t4d,   8, 16, false, false);
  draw(t4e,  16, 16, false, false);
  draw(t4c,  24, 16, true,  true);
  draw(t4b,  32, 16, true,  true);
  // Row 3 (y=24): bottom corner ring (V H of row 0)
  draw(t4f,  8,  24, false, false);
  draw(t50, 16, 24, false, false);
  draw(t4a, 24, 24, true,  true);
  draw(t49, 32, 24, true,  true);

  return c;
}

function _decodeBMCast() {
  // 5 size frames cycling through the inner-pulse tile. Outer ring is identical
  // across all 5; only the corner-flash tile rotates. Matches WM's 5-size shape
  // so the dispatch site can use the same `flameFrames[idx]` API.
  const flameFrames = [
    _buildBMCastFrame(BM_T_51),  // size 0/1 — base (also uses $52 alongside; close enough for first ship)
    _buildBMCastFrame(BM_T_54),  // size 2
    _buildBMCastFrame(BM_T_55),  // size 3
    _buildBMCastFrame(BM_T_56),  // size 4
    _buildBMCastFrame(BM_T_57),  // brackets — release flash
  ];
  return { flameFrames, starTile: null };  // BM has no separate rotating-star ring
}

// ── Public API ────────────────────────────────────────────────────────────

let _byKey = null;  // { wm: { flameFrames, starTile, ... }, bm: { ... } }

export function initCastAnim() {
  _byKey = {
    wm: { ..._decodeWMCast(), flameDx: -16, flameDy:  5, flameW: 16, flameH: 16 },
    bm: { ..._decodeBMCast(), flameDx:  -8, flameDy: -4, flameW: 40, flameH: 32 },
  };
}

// Map jobIdx → cast key. WM (3) and RM (5) share WM cast; BM (4) is its own.
// Non-mage jobs return null (no cast visual).
const _MAGE_CAST_KEY = { 3: 'wm', 4: 'bm', 5: 'wm' };
export function jobToCastKey(jobIdx) {
  return _MAGE_CAST_KEY[jobIdx] || null;
}

// Returns the cast asset bundle for a job, or null. Bundle shape:
//   { flameFrames: [c0..c4], starTile: c|null, flameDx, flameDy, flameW, flameH }
export function getCastAsset(jobKey) {
  if (!jobKey || !_byKey) return null;
  return _byKey[jobKey] || null;
}

// Flame size cycle, ms-keyed. Same cadence both jobs (~67 ms/step):
//   WM:   size1 → size2 → size2 → size3 → size4 (REC OAM 2026-05-04)
//   BM:   size0 → size0 → size1 → size2 → size3 (REC OAM 2026-05-07 f9627)
// then brackets ($57) for the last 200 ms of buildup. Returns -1 outside the
// buildup window.
const _WM_FLAME_SEQ = [0, 1, 1, 2, 3, 3, 2, 3, 3];
const _BM_FLAME_SEQ = [0, 0, 0, 1, 2, 2, 3, 3, 3];

export function getCastFlameFrameIdx(elapsedMs, jobKey) {
  if (elapsedMs < 0 || elapsedMs >= CAST_T_LUNGE) return -1;
  if (elapsedMs >= 600) return 4;  // brackets ($57 / WM_T_57)
  const seq = jobKey === 'bm' ? _BM_FLAME_SEQ : _WM_FLAME_SEQ;
  const step = Math.min(seq.length - 1, Math.floor(elapsedMs / 67));
  return seq[step];
}

// Stars rotate during buildup + lunge (phases 1+2). BM has no stars (returns
// null starTile from getCastAsset), so this is effectively WM-only.
export function shouldDrawCastStars(elapsedMs) {
  return elapsedMs >= 0 && elapsedMs < CAST_T_CAST;
}
