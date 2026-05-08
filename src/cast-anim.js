// Caster-side cast animation, dispatched by JOB + SPELL.
//
// Architecture (the user's standing rule):
//   • Per-JOB AURA: WM = 8-star ring rotating around portrait. BM = halo
//     wrapping portrait (40×32, with cast-pose body composited inside).
//   • UNIVERSAL FLAME: same 16×16 size-cycling flame asset for every cast.
//     Drawn LEFT of the portrait, ON TOP of the aura. Acts like a weapon
//     overlay — visible whenever a spell is being cast, regardless of job.
//     (PVP/opponent casters mirror it to the right of their body.)
//   • PER-SPELL PALETTE: aura + flame tinted by the spell's color (Cure
//     blue, Fire red, Poisona magenta, Sight green, etc.). Per-job default
//     applies for unregistered spells.
//
// Render order callers must follow (bottom → top):
//   1. Aura  (stars OR halo)  — wraps portrait
//   2. Flame (universal)      — left of portrait, on top
//
// Tile bytes captured via REC OAM 2026-05-04 (WM) and 2026-05-07 f9627 (BM).
// Parity-gated via tools/parity-check-spell.js (bm-cast, bm-cast-body).
// Don't hand-edit tile bytes — use the harness.

import { NES_SYSTEM_PALETTE } from './tile-decoder.js';
import { _makeCanvas16 } from './canvas-utils.js';

// ── Per-job default palettes ──────────────────────────────────────────────
// Used when a spell isn't registered in SPELL_CAST_PAL below.
const WM_DEFAULT_PAL = [0x0F, 0x12, 0x22, 0x31];  // blue / cyan / white
const BM_DEFAULT_PAL = [0x0F, 0x16, 0x27, 0x30];  // red / orange / white (REC OAM 2026-05-07 f9627)

// BM cast-pose body palette (pal1 from f9627 frame 0). The body recolor is
// per-job (it's the BM character's casting pose), not per-spell — a Blizzard
// cast still draws the BM body in this same recolor with a cyan halo around it.
const BM_BODY_PAL = [0x0F, 0x27, 0x18, 0x21];

// ── Per-spell cast palette overrides ──────────────────────────────────────
// Keyed by spell ID. Only the aura + flame tints change per spell — geometry
// stays per-job. Add new entries as spells get wired. Unregistered spells
// fall back to the caster's job default (WM_DEFAULT_PAL / BM_DEFAULT_PAL).
//
// Adding a spell:
//   1. Pick the school's canonical palette (or capture a new one).
//   2. Add an entry below.
//   3. (Optional) Mirror the same palette in PROJECTILE_PAL_BY_SPELL
//      (projectile-anim.js) and the on-target effect (spell-anim.js).
const SPELL_CAST_PAL = new Map([
  [0x31, [0x0F, 0x16, 0x27, 0x30]],  // Fire     — red/orange
  [0x34, [0x0F, 0x12, 0x22, 0x31]],  // Cure     — blue/cyan
  [0x35, [0x0F, 0x15, 0x27, 0x30]],  // Poisona  — magenta
  [0x36, [0x0F, 0x29, 0x31, 0x30]],  // Sight    — green
]);

// ── Phase timings (60 Hz NES capture × 16.67 ms/frame) ────────────────────
//
// Heal-style (Cure / Poisona): cast pose ~800 ms, then on-target sparkle
// during a single 'heal' window. Throw-style (Fire and future BM damage):
// cast pose ~800 ms, projectile flies ~150 ms, impact burst ~550 ms.
// Both share the same total length so spell-cast.js's magic-hit timer
// doesn't need to branch.

export const CAST_PHASE_MS = {
  buildup: 800,    // cast pose / aura builds
  lunge:   200,    // caster slides (visual no-op in our portrait)
  cast:    217,    // cast pose hold
  heal:    283,    // on-target effect plays here (heal-style only)
  ret:     167,    // return — anim ends
};

export const CAST_T_LUNGE  = CAST_PHASE_MS.buildup;
export const CAST_T_CAST   = CAST_T_LUNGE + CAST_PHASE_MS.lunge;
export const CAST_T_HEAL   = CAST_T_CAST + CAST_PHASE_MS.cast;
export const CAST_T_RETURN = CAST_T_HEAL + CAST_PHASE_MS.heal;
export const CAST_TOTAL_MS = CAST_T_RETURN + CAST_PHASE_MS.ret;

// Throw timings (Fire and any future thrown spell).
export const CAST_PHASE_MS_THROW = {
  buildup:    800,
  projectile: 150,
  impact:     550,
  ret:        167,
};
export const CAST_T_THROW_PROJ_START   = CAST_PHASE_MS_THROW.buildup;
export const CAST_T_THROW_IMPACT_START = CAST_T_THROW_PROJ_START + CAST_PHASE_MS_THROW.projectile;
export const CAST_T_THROW_RETURN       = CAST_T_THROW_IMPACT_START + CAST_PHASE_MS_THROW.impact;

// ── WM aura tile bytes ($49 star) ─────────────────────────────────────────
// Captured 2026-05-04 (REC OAM). Single 8×8 tile, rotated CW around portrait.

const WM_T_49_STAR = new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x10,0x38,0xFE,0x7C,0x7C,0x6C,0x44,0x00]);

// ── Universal flame tile bytes ($4A-$57) ──────────────────────────────────
// Captured 2026-05-04 (REC OAM, WM Cure). Five size-cycling 16×16 frames.
// These bytes are reused for ALL casts — the only thing that varies per spell
// is the palette applied at decode time.

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

// BM cast-pose body tiles ($43-$48 pal1). Captured 2026-05-07 (REC OAM f9627
// frame 0, group at origin 176,41). The recolored player body that the NES
// draws INSIDE the halo during cast (replacing the runtime idle portrait).
// Body palette is per-job, never per-spell.
const BM_T_43_BODY = new Uint8Array([0x00,0x00,0x00,0x00,0x01,0x7F,0x03,0x00, 0x00,0x00,0x00,0x00,0x00,0x00,0x3C,0x07]);
const BM_T_44_BODY = new Uint8Array([0x03,0x0E,0x1C,0x78,0xE0,0x80,0xC0,0xF0, 0x00,0x01,0x02,0x06,0x1C,0x7C,0x3C,0x08]);
const BM_T_45_BODY = new Uint8Array([0x00,0x04,0x84,0xF0,0xE0,0x00,0xDF,0xDF, 0x00,0x00,0x00,0x30,0x20,0x00,0x1F,0x1F]);
const BM_T_46_BODY = new Uint8Array([0x00,0x00,0x80,0x84,0x02,0x7A,0x8E,0xFC, 0xFC,0x1E,0x07,0x04,0x02,0x7A,0x8E,0xFC]);
const BM_T_47_BODY = new Uint8Array([0x9F,0x1F,0x5F,0x6F,0x6F,0x87,0x6B,0xF4, 0x1F,0x1F,0x5F,0x6F,0x6F,0x87,0x0B,0x04]);
const BM_T_48_BODY = new Uint8Array([0xFC,0xF8,0xF8,0xF8,0xFC,0xFC,0xFE,0xFF, 0xFC,0xF8,0xF8,0xF8,0xFC,0xFC,0xFE,0xFF]);

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

// ── Universal flame decode ────────────────────────────────────────────────

function _decodeFlameFrames(pal) {
  const t4a = _make8(FLAME_T_4A, pal);
  const t4b = _make8(FLAME_T_4B, pal), t4c = _make8(FLAME_T_4C, pal);
  const t4d = _make8(FLAME_T_4D, pal), t4e = _make8(FLAME_T_4E, pal);
  const t4f = _make8(FLAME_T_4F, pal), t50 = _make8(FLAME_T_50, pal);
  const t51 = _make8(FLAME_T_51, pal), t52 = _make8(FLAME_T_52, pal);
  const t53 = _make8(FLAME_T_53, pal), t54 = _make8(FLAME_T_54, pal);
  const t55 = _make8(FLAME_T_55, pal), t56 = _make8(FLAME_T_56, pal);
  const t57 = _make8(FLAME_T_57, pal);
  return [
    _flippedQuad(t4a),               // size 1 — smallest ring
    _quad4(t4b, t4c, t4d, t4e),      // size 2
    _quad4(t4f, t50, t51, t52),      // size 3
    _quad4(t53, t54, t55, t56),      // size 4 — XL ring
    _flippedQuad(t57),               // brackets — release flash
  ];
}

// ── WM aura: rotating star tile ───────────────────────────────────────────

function _decodeWMStarTile(pal) {
  return _make8(WM_T_49_STAR, pal);
}

// ── BM aura: 40×32 halo wrapping portrait (with body composited inside) ──
// Halo + body in one 40×32 canvas. Halo decoded with the spell's palette;
// body decoded with the per-job BM_BODY_PAL (constant). This keeps the BM
// character's body recolor consistent across all BM spells while the halo
// hue tracks the spell.

function _buildBMHaloFrame(innerTile, haloPal) {
  const t49 = _make8(BM_T_49, haloPal), t4a = _make8(BM_T_4A, haloPal);
  const t4f = _make8(BM_T_4F, haloPal), t50 = _make8(BM_T_50, haloPal);
  const t4b = _make8(BM_T_4B, haloPal), t4c = _make8(BM_T_4C, haloPal);
  const t4d = _make8(BM_T_4D, haloPal), t4e = _make8(BM_T_4E, haloPal);
  const inner = _make8(innerTile, haloPal);
  const b43 = _make8(BM_T_43_BODY, BM_BODY_PAL), b44 = _make8(BM_T_44_BODY, BM_BODY_PAL);
  const b45 = _make8(BM_T_45_BODY, BM_BODY_PAL), b46 = _make8(BM_T_46_BODY, BM_BODY_PAL);
  const b47 = _make8(BM_T_47_BODY, BM_BODY_PAL), b48 = _make8(BM_T_48_BODY, BM_BODY_PAL);

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
  // Body upper at canvas y=3
  draw(b43, 16, 3, false, false);
  draw(b44, 24, 3, false, false);
  // Row 1 (y=8): inner-corner pulse + middle ring
  draw(inner, 0, 8, false, false);
  draw(inner, 8, 8, true,  false);
  draw(t4b,   8, 8, false, false);
  draw(t4c,  16, 8, false, false);
  draw(t4e,  24, 8, true,  true);
  draw(t4d,  32, 8, true,  true);
  // Body middle at canvas y=11
  draw(b45, 16, 11, false, false);
  draw(b46, 24, 11, false, false);
  // Row 2 (y=16): mirror of row 1
  draw(inner, 0, 16, false, true);
  draw(inner, 8, 16, true,  true);
  draw(t4d,   8, 16, false, false);
  draw(t4e,  16, 16, false, false);
  draw(t4c,  24, 16, true,  true);
  draw(t4b,  32, 16, true,  true);
  // Body lower at canvas y=19
  draw(b47, 16, 19, false, false);
  draw(b48, 24, 19, false, false);
  // Row 3 (y=24): bottom corner ring
  draw(t4f,  8,  24, false, false);
  draw(t50, 16, 24, false, false);
  draw(t4a, 24, 24, true,  true);
  draw(t49, 32, 24, true,  true);

  return c;
}

function _decodeBMHaloFrames(pal) {
  // 5 size-cycling frames. Outer ring is identical across all 5; only the
  // inner-pulse tile rotates ($51 → $54 → $55 → $56 → $57 release flash).
  return [
    _buildBMHaloFrame(BM_T_51, pal),
    _buildBMHaloFrame(BM_T_54, pal),
    _buildBMHaloFrame(BM_T_55, pal),
    _buildBMHaloFrame(BM_T_56, pal),
    _buildBMHaloFrame(BM_T_57, pal),
  ];
}

// ── Per-(job, palette) bundle ─────────────────────────────────────────────

function _buildBundle(jobKey, pal) {
  const flameFrames = _decodeFlameFrames(pal);
  if (jobKey === 'wm') {
    return {
      jobKey,
      auraKind: 'stars',
      starTile: _decodeWMStarTile(pal),
      haloFrames: null,
      flameFrames,
      // Flame anchor relative to portrait origin (16×16 portrait).
      flameDx: -16, flameDy: 5,
      flameW: 16, flameH: 16,
      // Aura (stars) — drawn by ring math at portrait center; no fixed canvas.
      haloDx: 0, haloDy: 0, haloW: 0, haloH: 0,
    };
  }
  if (jobKey === 'bm') {
    return {
      jobKey,
      auraKind: 'halo',
      starTile: null,
      haloFrames: _decodeBMHaloFrames(pal),
      flameFrames,
      // Flame anchor: same offset as WM so the universal flame sits in the
      // same place relative to the portrait regardless of job.
      flameDx: -16, flameDy: 5,
      flameW: 16, flameH: 16,
      // Halo anchor: 40×32 canvas wraps the 16×16 portrait. Body-area inside
      // the halo aligns with the runtime portrait at (px, py) when the canvas
      // is drawn at (px - 16, py - 3).
      haloDx: -16, haloDy: -3, haloW: 40, haloH: 32,
    };
  }
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────

let _byJob   = null;   // { wm: <default bundle>, bm: <default bundle> }
let _bySpell = null;   // Map<spellId, { wm: <bundle> | null, bm: <bundle> | null }>

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
}

// Map jobIdx → cast key. WM (3) and RM (5) share WM cast pose; BM (4) is its
// own. Caller (9) is reserved for future call-magic visuals.
const _MAGE_CAST_KEY = { 3: 'wm', 4: 'bm', 5: 'wm' };
export function jobToCastKey(jobIdx) {
  return _MAGE_CAST_KEY[jobIdx] || null;
}

// Returns the cast-visual bundle for (jobIdx, spellId). Falls back to the
// per-job default palette when the spell isn't registered in SPELL_CAST_PAL.
// Returns null for non-mage jobs.
export function getCastVisual(jobIdx, spellId) {
  const jobKey = jobToCastKey(jobIdx);
  if (!jobKey || !_byJob) return null;
  if (spellId != null && _bySpell) {
    const perSpell = _bySpell.get(spellId);
    if (perSpell && perSpell[jobKey]) return perSpell[jobKey];
  }
  return _byJob[jobKey];
}

// Backward-compat shim — returns the per-job default bundle (no spell tint).
// New callers should use `getCastVisual(jobIdx, spellId)` directly. The
// returned bundle's shape is identical, so existing render code that reads
// `flameFrames`, `starTile`, `flameDx`, `flameDy` keeps working; new fields
// (`auraKind`, `haloFrames`, etc.) are simply ignored by old callers.
export function getCastAsset(jobKey) {
  if (!jobKey || !_byJob) return null;
  return _byJob[jobKey] || null;
}

// Flame size cycle, ms-keyed. Same cadence both jobs (~67 ms/step):
//   size1 → size2 → size2 → size3 → size4 → ... → brackets
// Returns -1 outside the buildup window.
const _FLAME_SEQ = [0, 1, 1, 2, 3, 3, 2, 3, 3];

export function getCastFlameFrameIdx(elapsedMs) {
  if (elapsedMs < 0 || elapsedMs >= CAST_T_LUNGE) return -1;
  if (elapsedMs >= 600) return 4;  // brackets — release flash
  const step = Math.min(_FLAME_SEQ.length - 1, Math.floor(elapsedMs / 67));
  return _FLAME_SEQ[step];
}

// BM halo size cycle, ms-keyed. Same cadence as the flame so caller can drive
// both off the same elapsedMs. Returns -1 outside the buildup window.
const _HALO_SEQ = [0, 0, 0, 1, 2, 2, 3, 3, 3];

export function getCastHaloFrameIdx(elapsedMs) {
  if (elapsedMs < 0 || elapsedMs >= CAST_T_LUNGE) return -1;
  if (elapsedMs >= 600) return 4;  // release flash
  const step = Math.min(_HALO_SEQ.length - 1, Math.floor(elapsedMs / 67));
  return _HALO_SEQ[step];
}

// Stars rotate during buildup + lunge (phases 1+2). BM has no stars
// (auraKind === 'halo'), so this is effectively WM-only.
export function shouldDrawCastStars(elapsedMs) {
  return elapsedMs >= 0 && elapsedMs < CAST_T_CAST;
}
