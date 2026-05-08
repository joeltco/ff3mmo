// Caster-side cast animation, dispatched by JOB + SPELL.
//
// Architecture (per the user's spec — see project_ff3mmo_magic_next.md):
//   • Per-JOB AURA: WM = 8-star ring rotating around sprite. BM = 40×32 halo
//     wrapping sprite. Aura is drawn BEHIND the sprite (halo) or AROUND it
//     (stars), so the live portrait/body shows through on top.
//   • Per-JOB SPARK (animated cast indicator): WM = 16×16 size-cycling flame
//     to the LEFT of sprite. BM = 16×24 spark "by the hand" (downward swing
//     pattern from the captured OAM). Drawn AFTER the sprite on top.
//   • PER-SPELL PALETTE: aura + flame/spark tinted by the spell's color.
//     Per-job default applies for unregistered spells. BM_BODY_PAL is a
//     per-job constant (used only by the BM spark — pal1 in the OAM dump).
//
// Render order callers must follow:
//   1. drawCasterCastBehind  (halo only — BM)
//   2. portrait / body sprite
//   3. drawCasterCastFront   (stars + flame for WM, spark for BM)
//
// PVP / opponent casters mirror the spark to the opposite side (they face
// right toward the player party; the casting hand reaches right).
//
// Tile bytes captured via REC OAM 2026-05-04 (WM) and 2026-05-07/08 (BM,
// f9627 + later snapshot for the spark). Don't hand-edit tile bytes — use
// the harness (tools/render-oam-dump.js + parity-check-spell.js).

import { NES_SYSTEM_PALETTE } from './tile-decoder.js';
import { _makeCanvas16 } from './canvas-utils.js';

// ── Per-job default palettes ──────────────────────────────────────────────
const WM_DEFAULT_PAL = [0x0F, 0x12, 0x22, 0x31];  // blue / cyan / white
const BM_DEFAULT_PAL = [0x0F, 0x16, 0x27, 0x30];  // red / orange / white

// BM spark palette (pal1 from f937 OAM snap) — per-job constant. Spark color
// stays orange/brown across all BM spells; only the halo + flame tints swap
// per spell.
const BM_BODY_PAL = [0x0F, 0x27, 0x18, 0x21];

// ── Per-spell cast palette overrides ──────────────────────────────────────
// Keyed by spell ID. Aura + WM flame tint per spell. BM spark stays at
// BM_BODY_PAL regardless. Add entries when wiring new spells.
const SPELL_CAST_PAL = new Map([
  [0x31, [0x0F, 0x16, 0x27, 0x30]],  // Fire     — red/orange
  [0x34, [0x0F, 0x12, 0x22, 0x31]],  // Cure     — blue/cyan
  [0x35, [0x0F, 0x15, 0x27, 0x30]],  // Poisona  — magenta
  [0x36, [0x0F, 0x29, 0x31, 0x30]],  // Sight    — green
]);

// ── Phase timings ─────────────────────────────────────────────────────────
export const CAST_PHASE_MS = {
  buildup: 800,
  lunge:   200,
  cast:    217,
  heal:    283,
  ret:     167,
};
export const CAST_T_LUNGE  = CAST_PHASE_MS.buildup;
export const CAST_T_CAST   = CAST_T_LUNGE + CAST_PHASE_MS.lunge;
export const CAST_T_HEAL   = CAST_T_CAST + CAST_PHASE_MS.cast;
export const CAST_T_RETURN = CAST_T_HEAL + CAST_PHASE_MS.heal;
export const CAST_TOTAL_MS = CAST_T_RETURN + CAST_PHASE_MS.ret;

export const CAST_PHASE_MS_THROW = {
  buildup:    800,
  projectile: 150,
  impact:     550,
  ret:        167,
};
export const CAST_T_THROW_PROJ_START   = CAST_PHASE_MS_THROW.buildup;
export const CAST_T_THROW_IMPACT_START = CAST_T_THROW_PROJ_START + CAST_PHASE_MS_THROW.projectile;
export const CAST_T_THROW_RETURN       = CAST_T_THROW_IMPACT_START + CAST_PHASE_MS_THROW.impact;

// ── WM aura: rotating star tile ───────────────────────────────────────────
const WM_T_49_STAR = new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x10,0x38,0xFE,0x7C,0x7C,0x6C,0x44,0x00]);

// ── WM flame tile bytes ($4A-$57) ─────────────────────────────────────────
// Captured 2026-05-04 (REC OAM, WM Cure). Five size-cycling 16×16 frames.
// WM-specific: the small flame to the LEFT of the portrait. BM uses its own
// spark (below) instead of this flame.

const FLAME_T_4A = new Uint8Array([0x00,0x00,0x00,0x00,0x03,0x04,0x0B,0x0B, 0x00,0x00,0x00,0x00,0x00,0x03,0x07,0x07]);

const FLAME_T_4B = new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,0x01,0x01,0x01,0x03]);
const FLAME_T_4C = new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,0x00,0x00,0x80,0x80]);
const FLAME_T_4D = new Uint8Array([0x01,0x03,0x03,0x01,0x00,0x00,0x00,0x00, 0x03,0x07,0x07,0x07,0x03,0x00,0x00,0x00]);
const FLAME_T_4E = new Uint8Array([0x00,0x80,0x80,0x00,0x00,0x00,0x00,0x00, 0xC0,0xC0,0xC0,0xC0,0x80,0x00,0x00,0x00]);

const FLAME_T_4F = new Uint8Array([0x01,0x01,0x03,0x02,0x02,0x04,0x05,0x09, 0x00,0x00,0x00,0x01,0x01,0x03,0x03,0x07]);
const FLAME_T_50 = new Uint8Array([0x00,0x00,0x80,0x80,0x40,0x40,0x40,0x60, 0x00,0x00,0x00,0x00,0x80,0x80,0x80,0x80]);
const FLAME_T_51 = new Uint8Array([0x0B,0x0B,0x0B,0x09,0x04,0x03,0x00,0x00, 0x07,0x07,0x07,0x07,0x03,0x00,0x00,0x00]);
const FLAME_T_52 = new Uint8Array([0xA0,0xB0,0xB0,0xA0,0x60,0xC0,0x00,0x00, 0xC0,0xC0,0xC0,0xC0,0x80,0x00,0x00,0x00]);

const FLAME_T_53 = new Uint8Array([0x00,0x00,0x04,0x00,0x01,0x09,0x02,0x06, 0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x01]);
const FLAME_T_54 = new Uint8Array([0x80,0x80,0x40,0xD0,0xD0,0x60,0x20,0xB0, 0x00,0x00,0x00,0x00,0x00,0x80,0xC0,0xC0]);
const FLAME_T_55 = new Uint8Array([0x0D,0x09,0x0B,0x09,0x04,0x03,0x00,0x00, 0x03,0x07,0x07,0x07,0x03,0x00,0x00,0x00]);
const FLAME_T_56 = new Uint8Array([0xD8,0xC8,0xE8,0xD8,0xB0,0xE0,0x00,0x00, 0xE0,0xF0,0xF0,0xE0,0xC0,0x00,0x00,0x00]);

const FLAME_T_57 = new Uint8Array([0x00,0x00,0x30,0x20,0x08,0x04,0x00,0x00, 0x00,0x00,0x30,0x38,0x10,0x00,0x00,0x00]);

// ── BM halo tile bytes ($49-$57) ──────────────────────────────────────────
// Captured 2026-05-07/08 (REC OAM f9627 + later f937 snap). 40×32 halo
// wrapping the body, drawn BEHIND the portrait/sprite. Inner-pulse uses a
// PAIR of tiles per OAM ($52 at (0,8) HFLIP + $51 at (8,8) HFLIP, mirrored
// across both axes). v1.7.100/101 used $51 in both positions ("close enough
// for first ship") — fixed here.

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

// Inner pulse — paired tile (size cycle on the inner one).
// $52 = outer-of-pair (constant across cycle), $51/$54/$55/$56/$57 = inner-of-
// pair (cycles by size).
const BM_T_51 = new Uint8Array([0x80,0x40,0x10,0x28,0x1A,0x05,0x0A,0x01, 0x00,0x00,0x20,0x10,0x0C,0x0E,0x07,0x07]);
const BM_T_52 = new Uint8Array([0x00,0x00,0x00,0x08,0x20,0xD0,0x60,0xA0, 0x00,0x00,0x00,0x00,0x10,0x20,0xC0,0xC0]);
const BM_T_54 = new Uint8Array([0x00,0x00,0x00,0x00,0x07,0x18,0x67,0xCF, 0x00,0x00,0x00,0x00,0x00,0x07,0x1F,0x3F]);
const BM_T_55 = new Uint8Array([0x00,0x00,0x07,0x1C,0x31,0x67,0x4F,0x4F, 0x00,0x00,0x00,0x03,0x0F,0x1F,0x3F,0x3F]);
const BM_T_56 = new Uint8Array([0x07,0x0C,0x18,0x19,0x33,0x37,0x27,0x27, 0x00,0x03,0x07,0x07,0x0F,0x0F,0x1F,0x1F]);
const BM_T_57 = new Uint8Array([0x00,0x00,0x0A,0x10,0x00,0x22,0x00,0x00, 0x00,0x00,0x02,0x00,0x04,0x02,0x08,0x00]);

// ── BM spark tile bytes ($0F-$14) ─────────────────────────────────────────
// Captured 2026-05-08 (REC OAM f937 snap). 16×24 sprite (2 wide × 3 tall),
// pal1 (BM_BODY_PAL). Drawn at "by the hand" position — to the left of the
// portrait for left-facing player/ally, mirrored to the right for PVP
// opponents. Replaces the universal flame for BM (WM keeps its own flame).
const BM_SPARK_T_0F = new Uint8Array([0x00,0x00,0x0A,0x16,0x2F,0x03,0x00,0x0C, 0x00,0x00,0x0E,0x1E,0x3F,0x7F,0x83,0x40]);
const BM_SPARK_T_10 = new Uint8Array([0x00,0x00,0x00,0xE0,0x70,0xB8,0xD8,0x68, 0x00,0x6C,0x19,0xFE,0x76,0xBB,0xDB,0xED]);
const BM_SPARK_T_11 = new Uint8Array([0x1F,0x04,0x16,0x16,0x0F,0x0F,0x60,0xC6, 0x00,0x00,0x00,0x00,0x50,0xE0,0x60,0x1E]);
const BM_SPARK_T_12 = new Uint8Array([0x18,0x80,0x48,0xCC,0x00,0x00,0x70,0xD8, 0x59,0x32,0x38,0x0C,0xB0,0x78,0x70,0x1C]);
const BM_SPARK_T_13 = new Uint8Array([0xCC,0x58,0x2F,0x3F,0x3F,0x1F,0x00,0x00, 0x1E,0x5F,0x3F,0x3F,0x3F,0x1F,0x07,0x0F]);
const BM_SPARK_T_14 = new Uint8Array([0xD8,0x70,0x80,0xE0,0xE0,0xC0,0x00,0x00, 0x1C,0x74,0x84,0xE6,0xE6,0xC6,0xC7,0xC7]);

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

// ── WM flame decode ───────────────────────────────────────────────────────

function _decodeWMFlameFrames(pal) {
  const t4a = _make8(FLAME_T_4A, pal);
  const t4b = _make8(FLAME_T_4B, pal), t4c = _make8(FLAME_T_4C, pal);
  const t4d = _make8(FLAME_T_4D, pal), t4e = _make8(FLAME_T_4E, pal);
  const t4f = _make8(FLAME_T_4F, pal), t50 = _make8(FLAME_T_50, pal);
  const t51 = _make8(FLAME_T_51, pal), t52 = _make8(FLAME_T_52, pal);
  const t53 = _make8(FLAME_T_53, pal), t54 = _make8(FLAME_T_54, pal);
  const t55 = _make8(FLAME_T_55, pal), t56 = _make8(FLAME_T_56, pal);
  const t57 = _make8(FLAME_T_57, pal);
  return [
    _flippedQuad(t4a),
    _quad4(t4b, t4c, t4d, t4e),
    _quad4(t4f, t50, t51, t52),
    _quad4(t53, t54, t55, t56),
    _flippedQuad(t57),
  ];
}

// ── WM aura decode (single rotating star tile) ────────────────────────────

function _decodeWMStarTile(pal) {
  return _make8(WM_T_49_STAR, pal);
}

// ── BM halo decode ────────────────────────────────────────────────────────
// 40×32 canvas. Halo only — body composite removed (halo now renders BEHIND
// the portrait, so the live portrait shows on top with no need to overpaint
// the body). Outer ring + middle ring stay constant; inner-pulse pair
// ($52 + size-tile) cycles per frame.
//
// OAM layout (left half — right half is the H-flip mirror of the left):
//   (0, 8)  $52 HFLIP             ← inner pulse outer (constant)
//   (8, 8)  $51 HFLIP             ← inner pulse inner (size-cycles)
//   (0, 16) inner-tile VFLIP      ← row 2 mirror
//   (8, 16) $52 VFLIP             ← row 2 mirror
// All halo tiles use the SPELL palette (red for Fire, blue for Cure, etc.).

function _buildBMHaloFrame(innerTile, haloPal) {
  const t49 = _make8(BM_T_49, haloPal), t4a = _make8(BM_T_4A, haloPal);
  const t4f = _make8(BM_T_4F, haloPal), t50 = _make8(BM_T_50, haloPal);
  const t4b = _make8(BM_T_4B, haloPal), t4c = _make8(BM_T_4C, haloPal);
  const t4d = _make8(BM_T_4D, haloPal), t4e = _make8(BM_T_4E, haloPal);
  const inner = _make8(innerTile, haloPal);
  const t52   = _make8(BM_T_52, haloPal);

  const c = document.createElement('canvas'); c.width = 40; c.height = 32;
  const cx = c.getContext('2d');

  const draw = (tile, x, y, hf, vf) => {
    cx.save();
    cx.translate(x + (hf ? 8 : 0), y + (vf ? 8 : 0));
    cx.scale(hf ? -1 : 1, vf ? -1 : 1);
    cx.drawImage(tile, 0, 0);
    cx.restore();
  };

  // Row 0 (y=0): top corner ring. OAM: $4F VFLIP at [8,0], $50 VFLIP at
  // [16,0], $4A HFLIP at [24,0], $49 HFLIP at [32,0].
  draw(t4f,  8, 0, false, true);
  draw(t50, 16, 0, false, true);
  draw(t4a, 24, 0, true,  false);
  draw(t49, 32, 0, true,  false);
  // Row 1 (y=8): inner-pulse pair on left + middle ring.
  // OAM: $52 HFLIP at [0,8], $51 HFLIP at [8,8], $4D VFLIP at [8,8],
  //       $4E VFLIP at [16,8], $4C HFLIP at [24,8], $4B HFLIP at [32,8].
  draw(t52,    0, 8, true,  false);
  draw(inner,  8, 8, true,  false);
  draw(t4d,    8, 8, false, true);
  draw(t4e,   16, 8, false, true);
  draw(t4c,   24, 8, true,  false);
  draw(t4b,   32, 8, true,  false);
  // Row 2 (y=16): mirror of row 1 across X axis (swaps inner pair, V-flips).
  // OAM: $51 VFLIP at [0,16], $52 VFLIP at [8,16], $4B VFLIP at [8,16],
  //       $4C VFLIP at [16,16], $4E HFLIP at [24,16], $4D HFLIP at [32,16].
  draw(inner,  0, 16, false, true);
  draw(t52,    8, 16, false, true);
  draw(t4b,    8, 16, false, true);
  draw(t4c,   16, 16, false, true);
  draw(t4e,   24, 16, true,  false);
  draw(t4d,   32, 16, true,  false);
  // Row 3 (y=24): bottom corner ring (mirror of row 0 across Y).
  // OAM: $49 VFLIP at [8,24], $4A VFLIP at [16,24], $50 HFLIP at [24,24],
  //       $4F HFLIP at [32,24].
  draw(t49,  8,  24, false, true);
  draw(t4a, 16,  24, false, true);
  draw(t50, 24,  24, true,  false);
  draw(t4f, 32,  24, true,  false);

  return c;
}

function _decodeBMHaloFrames(pal) {
  return [
    _buildBMHaloFrame(BM_T_51, pal),
    _buildBMHaloFrame(BM_T_54, pal),
    _buildBMHaloFrame(BM_T_55, pal),
    _buildBMHaloFrame(BM_T_56, pal),
    _buildBMHaloFrame(BM_T_57, pal),
  ];
}

// ── BM spark decode ───────────────────────────────────────────────────────
// 16×24 canvas (2 wide × 3 tall), pal1 (BM_BODY_PAL constant). Single static
// frame for now — animating swing pattern needs more frame captures.

function _decodeBMSparkCanvas() {
  const t0f = _make8(BM_SPARK_T_0F, BM_BODY_PAL), t10 = _make8(BM_SPARK_T_10, BM_BODY_PAL);
  const t11 = _make8(BM_SPARK_T_11, BM_BODY_PAL), t12 = _make8(BM_SPARK_T_12, BM_BODY_PAL);
  const t13 = _make8(BM_SPARK_T_13, BM_BODY_PAL), t14 = _make8(BM_SPARK_T_14, BM_BODY_PAL);
  const c = document.createElement('canvas'); c.width = 16; c.height = 24;
  const cx = c.getContext('2d');
  cx.drawImage(t0f, 0, 0);  cx.drawImage(t10, 8, 0);
  cx.drawImage(t11, 0, 8);  cx.drawImage(t12, 8, 8);
  cx.drawImage(t13, 0, 16); cx.drawImage(t14, 8, 16);
  return c;
}

// ── Per-(job, palette) bundle ─────────────────────────────────────────────

function _buildBundle(jobKey, pal) {
  if (jobKey === 'wm') {
    return {
      jobKey,
      // Aura: rotating star tile. Drawn AFTER portrait (front layer), since
      // stars sweep through the portrait area and need to render on top.
      starTile: _decodeWMStarTile(pal),
      haloFrames: null,
      // Front spark: WM flame. 16×16 size-cycling, anchored to the LEFT of
      // sprite center vertically centered with the sprite.
      flameFrames: _decodeWMFlameFrames(pal),
      sparkCanvas: null,
    };
  }
  if (jobKey === 'bm') {
    return {
      jobKey,
      // Aura: 40×32 halo wrapping sprite, drawn BEHIND portrait so the live
      // portrait shows through unchanged.
      starTile: null,
      haloFrames: _decodeBMHaloFrames(pal),
      // Front spark: BM 16×24 spark "by the hand" — drawn AFTER portrait.
      // Static (single frame) for now; palette-independent (always pal1).
      flameFrames: null,
      sparkCanvas: _decodeBMSparkCanvas(),
    };
  }
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────

let _byJob   = null;
let _bySpell = null;
// BM spark uses pal1 constant — built once, shared across all spells/spell-IDs.
let _bmSparkShared = null;

export function initCastAnim() {
  _byJob = {
    wm: _buildBundle('wm', WM_DEFAULT_PAL),
    bm: _buildBundle('bm', BM_DEFAULT_PAL),
  };
  _bySpell = new Map();
  for (const [spellId, pal] of SPELL_CAST_PAL.entries()) {
    _bySpell.set(spellId, {
      wm: _buildBundle('wm', pal),
      bm: _buildBundle('bm', pal),
    });
  }
  // Spark is shared (pal1 doesn't depend on spell), but each BM bundle has
  // its own reference for API symmetry.
  _bmSparkShared = _byJob.bm.sparkCanvas;
}

const _MAGE_CAST_KEY = { 3: 'wm', 4: 'bm', 5: 'wm' };
export function jobToCastKey(jobIdx) {
  return _MAGE_CAST_KEY[jobIdx] || null;
}

// Returns the cast-visual bundle for (jobIdx, spellId). Falls back to per-job
// default palette when the spell isn't registered.
export function getCastVisual(jobIdx, spellId) {
  const jobKey = jobToCastKey(jobIdx);
  if (!jobKey || !_byJob) return null;
  if (spellId != null && _bySpell) {
    const perSpell = _bySpell.get(spellId);
    if (perSpell && perSpell[jobKey]) return perSpell[jobKey];
  }
  return _byJob[jobKey];
}

// Backward-compat shim — returns per-job default bundle (ignores spell ID).
// New callers should use getCastVisual(jobIdx, spellId).
export function getCastAsset(jobKey) {
  if (!jobKey || !_byJob) return null;
  return _byJob[jobKey] || null;
}

// Flame size cycle, ms-keyed (~67ms/step). WM-only.
const _FLAME_SEQ = [0, 1, 1, 2, 3, 3, 2, 3, 3];
export function getCastFlameFrameIdx(elapsedMs) {
  if (elapsedMs < 0 || elapsedMs >= CAST_T_LUNGE) return -1;
  if (elapsedMs >= 600) return 4;
  const step = Math.min(_FLAME_SEQ.length - 1, Math.floor(elapsedMs / 67));
  return _FLAME_SEQ[step];
}

// BM halo size cycle, ms-keyed (~67ms/step).
const _HALO_SEQ = [0, 0, 0, 1, 2, 2, 3, 3, 3];
export function getCastHaloFrameIdx(elapsedMs) {
  if (elapsedMs < 0 || elapsedMs >= CAST_T_LUNGE) return -1;
  if (elapsedMs >= 600) return 4;
  const step = Math.min(_HALO_SEQ.length - 1, Math.floor(elapsedMs / 67));
  return _HALO_SEQ[step];
}

// WM stars draw during buildup + lunge phases. BM has no stars.
export function shouldDrawCastStars(elapsedMs) {
  return elapsedMs >= 0 && elapsedMs < CAST_T_CAST;
}

// Returns true while the BM spark should render. Visible during the full
// buildup + lunge window (matches the user's "stay in the same spot" — the
// spark is the static cast indicator analogous to WM's flame).
export function shouldDrawCastSpark(elapsedMs) {
  return elapsedMs >= 0 && elapsedMs < CAST_T_CAST;
}

// ── Centralized render helpers ───────────────────────────────────────────
//
// Render order callers must follow:
//   1. drawCasterCastBehind(ctx, centerX, centerY, jobIdx, spellId, elapsedMs, mirror)
//   2. portrait / body sprite
//   3. drawCasterCastFront(ctx, centerX, centerY, jobIdx, spellId, elapsedMs, mirror)
//
// `centerX` / `centerY` is the SPRITE CENTER (not the top-left), so this
// works equally for 16×16 portraits and 16×24 PVP bodies — caller computes
// center based on the sprite size.
//
// `mirror` flips the asymmetric elements (BM halo's inner-pulse wing, the
// flame/spark side) for right-facing sprites (PVP opponents face right
// toward the player party). Sprite-edge math assumes 16-wide sprites — true
// for all current portraits and PVP bodies.

const _SPRITE_HALF_W = 8;        // half-width of all current sprites (16 wide)
const _HALO_HALF_W   = 20;       // halo canvas is 40×32
const _HALO_HALF_H   = 16;
const _FLAME_W       = 16;       // WM flame canvas is 16×16
const _FLAME_DY      = -3;       // flame top relative to sprite center
const _SPARK_W       = 16;       // BM spark canvas is 16×24
const _SPARK_DY      = -12;      // spark vertical center matches sprite center

// Halo (BM only) — drawn BEHIND the sprite. WM has no behind-layer.
export function drawCasterCastBehind(ctx, centerX, centerY, jobIdx, spellId, elapsedMs, mirror = false) {
  if (elapsedMs < 0) return;
  const visual = getCastVisual(jobIdx, spellId);
  if (!visual || !visual.haloFrames) return;
  const haloIdx = getCastHaloFrameIdx(elapsedMs);
  if (haloIdx < 0) return;
  const halo = visual.haloFrames[haloIdx];
  if (mirror) {
    ctx.save();
    ctx.translate(centerX + _HALO_HALF_W, centerY - _HALO_HALF_H);
    ctx.scale(-1, 1);
    ctx.drawImage(halo, 0, 0);
    ctx.restore();
  } else {
    ctx.drawImage(halo, centerX - _HALO_HALF_W, centerY - _HALO_HALF_H);
  }
}

// WM stars + WM flame OR BM spark — drawn AFTER the sprite.
export function drawCasterCastFront(ctx, centerX, centerY, jobIdx, spellId, elapsedMs, mirror = false) {
  if (elapsedMs < 0) return;
  const visual = getCastVisual(jobIdx, spellId);
  if (!visual) return;

  // WM aura: 8 stars on a radius-15 ring, rotating CW at 1.2 s/turn.
  if (visual.starTile && shouldDrawCastStars(elapsedMs)) {
    const r = 15, N = 8;
    const rotRad = (elapsedMs / 1200) * Math.PI * 2;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2 + rotRad - Math.PI / 2;
      const sx = Math.round(centerX + Math.cos(a) * r - 4);
      const sy = Math.round(centerY + Math.sin(a) * r - 4);
      ctx.drawImage(visual.starTile, sx, sy);
    }
  }

  // WM flame: 16×16 size-cycling, abuts the sprite's left edge (or right
  // edge when mirrored).
  if (visual.flameFrames) {
    const flameIdx = getCastFlameFrameIdx(elapsedMs);
    if (flameIdx >= 0) {
      const flame = visual.flameFrames[flameIdx];
      if (mirror) {
        ctx.save();
        ctx.translate(centerX + _SPRITE_HALF_W + _FLAME_W, centerY + _FLAME_DY);
        ctx.scale(-1, 1);
        ctx.drawImage(flame, 0, 0);
        ctx.restore();
      } else {
        ctx.drawImage(flame, centerX - _SPRITE_HALF_W - _FLAME_W, centerY + _FLAME_DY);
      }
    }
  }

  // BM spark: 16×24 static, abuts the sprite's left edge (right when
  // mirrored). Vertical center matches the sprite center.
  if (visual.sparkCanvas && shouldDrawCastSpark(elapsedMs)) {
    if (mirror) {
      ctx.save();
      ctx.translate(centerX + _SPRITE_HALF_W + _SPARK_W, centerY + _SPARK_DY);
      ctx.scale(-1, 1);
      ctx.drawImage(visual.sparkCanvas, 0, 0);
      ctx.restore();
    } else {
      ctx.drawImage(visual.sparkCanvas, centerX - _SPRITE_HALF_W - _SPARK_W, centerY + _SPARK_DY);
    }
  }
}
