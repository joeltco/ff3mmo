// Per-spell animation data — captured from FF3 NES via EMU tab REC OAM.
//
// Each spell's spell-effect (the visual that overlays caster + target) is its
// own data: distinct tile bytes, distinct palette, distinct phase pattern. The
// shared "flame-with-palette-swap" assumption from the previous cure-anim.js
// was wrong (REC OAM 2026-05-06 confirmed Cure and Poisona have COMPLETELY
// different tile bytes; the byte-identity claim was an error).
//
// Adding a new spell anim:
//   1. REC OAM the spell at frame-zero of `magic-cast` for 50 frames (gap=1).
//   2. Drop the captured tile bytes into a SPELL_ANIM_DATA[<spellId>] entry.
//   3. Define caster-side phase + target-side phase. Done — render path
//      dispatches automatically via getSpellAnim(spellId).

import { NES_SYSTEM_PALETTE } from './tile-decoder.js';
import { _makeCanvas16 } from './canvas-utils.js';

// ── Tile decode helpers ────────────────────────────────────────────────────

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

function _drawTileAt(ctx, tile8, x, y, hflip, vflip) {
  if (!hflip && !vflip) { ctx.drawImage(tile8, x, y); return; }
  ctx.save();
  if (hflip && vflip) { ctx.translate(x + 8, y + 8); ctx.scale(-1, -1); }
  else if (hflip)     { ctx.translate(x + 8, y);     ctx.scale(-1,  1); }
  else                { ctx.translate(x,     y + 8); ctx.scale( 1, -1); }
  ctx.drawImage(tile8, 0, 0);
  ctx.restore();
}

// ── Cure (0x34) — recovery school, blue palette ────────────────────────────
//
// Captured frame 2877+ (REC OAM 2026-05-06). Caster effect: 4 sprites cycling
// HFLIP/VFLIP across [0,5][8,5][0,13][8,13] relative to caster portrait, two
// states alternating every ~67 ms. Target effect: single $66 sparkle on the
// healed sprite.
const CURE_PAL = [0x0F, 0x12, 0x22, 0x31];
const CURE_T49 = new Uint8Array([0x10,0x10,0x28,0xD6,0x28,0x10,0x10,0x00, 0x00,0x00,0x10,0x38,0x10,0x00,0x00,0x00]);
const CURE_T4A = new Uint8Array([0x00,0x00,0x00,0x00,0x08,0x00,0x00,0x00, 0x00,0x00,0x00,0x08,0x1C,0x08,0x00,0x00]);
const CURE_T66 = new Uint8Array([0x3C,0x7E,0xFF,0xFF,0xFF,0xFF,0x7E,0x3C, 0x00,0x3C,0x66,0x66,0x66,0x66,0x3C,0x00]);

// ── Poisona (0x35) — cure_status school, magenta palette ───────────────────
//
// Captured frame 827+ (REC OAM 2026-05-06). Caster effect: 8 distinct tiles
// in two 4-tile groups (phase A + phase B), alternating every ~67 ms with
// HFLIP/VFLIP cycling. Target effect: $07/$08 curve sprite on target.
const POISONA_PAL = [0x0F, 0x15, 0x27, 0x30];
// Phase A
const POISONA_T49 = new Uint8Array([0x00,0x02,0x00,0x0C,0x00,0x40,0x00,0x20, 0x00,0x05,0x1C,0x30,0x30,0x20,0x68,0x60]);
const POISONA_T4A = new Uint8Array([0x00,0x80,0x38,0x04,0x04,0x02,0x02,0x00, 0x00,0x60,0x00,0x00,0x00,0x00,0x00,0x00]);
const POISONA_T4B = new Uint8Array([0x30,0x20,0x18,0x08,0x0E,0x4B,0x03,0x00, 0x60,0x70,0x30,0x3C,0x1F,0x47,0x00,0x00]);
const POISONA_T4C = new Uint8Array([0x00,0x30,0x38,0xB8,0x78,0xE0,0x00,0x10, 0x04,0x30,0x38,0x78,0xF2,0xD0,0x80,0x10]);
// Phase B
const POISONA_T4D = new Uint8Array([0x00,0x06,0x18,0x20,0x20,0x20,0x00,0x40, 0x00,0x00,0x00,0x00,0x00,0x40,0x40,0x00]);
const POISONA_T4E = new Uint8Array([0x00,0x00,0x00,0x38,0x70,0x7D,0x0C,0x14, 0x00,0x00,0x00,0x38,0x7C,0x79,0x1C,0x0E]);
const POISONA_T4F = new Uint8Array([0x00,0x40,0x10,0x10,0x00,0x01,0x04,0x00, 0x40,0x00,0x60,0x20,0x38,0x1F,0x03,0x00]);
const POISONA_T50 = new Uint8Array([0x06,0x0E,0x08,0x3C,0xA0,0xC0,0x00,0x00, 0x0C,0x0C,0x1C,0x18,0x78,0xF0,0xC4,0x00]);
// Target curve
const POISONA_T07 = new Uint8Array([0x81,0xE1,0xC1,0x81,0x61,0x22,0x16,0x3B, 0xFD,0xFD,0xFD,0xED,0x6D,0x2E,0x07,0x03]);
const POISONA_T08 = new Uint8Array([0x80,0xC0,0x80,0x00,0xC0,0xD2,0x76,0xBF, 0xFE,0xFE,0xFE,0xFE,0xFE,0xFE,0x7E,0xBF]);

// ── Phase timing ───────────────────────────────────────────────────────────
//
// Same five-phase model as the prior cure-anim.js so spell-cast.js doesn't
// need to know per-spell timing. Phase boundaries are spell-agnostic; what
// each spell renders DURING those phases is what differs.
export const SPELL_PHASE_MS = {
  buildup: 800,
  lunge:   200,
  cast:    217,
  heal:    283,
  ret:     167,
};
export const SPELL_TOTAL_MS = SPELL_PHASE_MS.buildup + SPELL_PHASE_MS.lunge +
  SPELL_PHASE_MS.cast + SPELL_PHASE_MS.heal + SPELL_PHASE_MS.ret;
export const SPELL_T_LUNGE  = SPELL_PHASE_MS.buildup;
export const SPELL_T_CAST   = SPELL_T_LUNGE + SPELL_PHASE_MS.lunge;
export const SPELL_T_HEAL   = SPELL_T_CAST + SPELL_PHASE_MS.cast;
export const SPELL_T_RETURN = SPELL_T_HEAL + SPELL_PHASE_MS.heal;

// Back-compat aliases (spell-cast.js imports CURE_*).
export const CURE_PHASE_MS = SPELL_PHASE_MS;
export const CURE_TOTAL_MS = SPELL_TOTAL_MS;
export const CURE_T_HEAL   = SPELL_T_HEAL;

// ── Per-spell anim builders ────────────────────────────────────────────────

// Cure caster effect: 4 sprites at fixed offsets, two-state cycle every 67 ms.
//   state A: [0,5]=$4A_H, [8,5]=$49_H, [0,13]=$49_V, [8,13]=$4A_V
//   state B: [0,5]=$49,   [8,5]=$4A,   [0,13]=$4A_VH, [8,13]=$49_VH
function _buildCureCaster() {
  const t49 = _make8(CURE_T49, CURE_PAL);
  const t4a = _make8(CURE_T4A, CURE_PAL);
  // Returns a function that paints the caster effect at (x,y) for a given ms.
  return function drawCureCaster(ctx, ms, x, y) {
    if (ms < 0 || ms >= SPELL_T_CAST) return;
    const stateB = (Math.floor(ms / 67) & 1) === 1;
    if (!stateB) {
      _drawTileAt(ctx, t4a, x + 0, y + 5,  true,  false);
      _drawTileAt(ctx, t49, x + 8, y + 5,  true,  false);
      _drawTileAt(ctx, t49, x + 0, y + 13, false, true);
      _drawTileAt(ctx, t4a, x + 8, y + 13, false, true);
    } else {
      _drawTileAt(ctx, t49, x + 0, y + 5,  false, false);
      _drawTileAt(ctx, t4a, x + 8, y + 5,  false, false);
      _drawTileAt(ctx, t4a, x + 0, y + 13, true,  true);
      _drawTileAt(ctx, t49, x + 8, y + 13, true,  true);
    }
  };
}

function _buildCureTarget() {
  const t66 = _make8(CURE_T66, CURE_PAL);
  return function drawCureTarget(ctx, ms, x, y) {
    if (ms < SPELL_T_HEAL || ms >= SPELL_T_RETURN) return;
    // Sparkle pulses on/off every ~67 ms during heal phase, drawn at portrait
    // center (8,4 inside 16×16 portrait).
    if ((Math.floor(ms / 67) & 1) === 0) return;
    ctx.drawImage(t66, x + 4, y + 4);
  };
}

// Poisona caster effect: 4 sprites at same fixed offsets, but tile content
// differs per state (8 unique tiles total instead of Cure's 2). Phase A uses
// $49/$4A/$4B/$4C; phase B uses $4D/$4E/$4F/$50. Same HFLIP/VFLIP layout.
function _buildPoisonaCaster() {
  const a49 = _make8(POISONA_T49, POISONA_PAL);
  const a4a = _make8(POISONA_T4A, POISONA_PAL);
  const a4b = _make8(POISONA_T4B, POISONA_PAL);
  const a4c = _make8(POISONA_T4C, POISONA_PAL);
  const b4d = _make8(POISONA_T4D, POISONA_PAL);
  const b4e = _make8(POISONA_T4E, POISONA_PAL);
  const b4f = _make8(POISONA_T4F, POISONA_PAL);
  const b50 = _make8(POISONA_T50, POISONA_PAL);
  return function drawPoisonaCaster(ctx, ms, x, y) {
    if (ms < 0 || ms >= SPELL_T_CAST) return;
    const stateB = (Math.floor(ms / 67) & 1) === 1;
    if (!stateB) {
      _drawTileAt(ctx, a4a, x + 0, y + 5,  true,  false);
      _drawTileAt(ctx, a49, x + 8, y + 5,  true,  false);
      _drawTileAt(ctx, a4c, x + 0, y + 13, true,  false);
      _drawTileAt(ctx, a4b, x + 8, y + 13, true,  false);
    } else {
      _drawTileAt(ctx, b4e, x + 0, y + 5,  true,  false);
      _drawTileAt(ctx, b4d, x + 8, y + 5,  true,  false);
      _drawTileAt(ctx, b50, x + 0, y + 13, true,  false);
      _drawTileAt(ctx, b4f, x + 8, y + 13, true,  false);
    }
  };
}

function _buildPoisonaTarget() {
  const t07 = _make8(POISONA_T07, POISONA_PAL);
  const t08 = _make8(POISONA_T08, POISONA_PAL);
  // 16×16 curve composed of two 8×8 tiles side-by-side, drawn at portrait center.
  return function drawPoisonaTarget(ctx, ms, x, y) {
    if (ms < SPELL_T_HEAL || ms >= SPELL_T_RETURN) return;
    ctx.drawImage(t07, x + 0, y + 4);
    ctx.drawImage(t08, x + 8, y + 4);
  };
}

// ── Spell registry ─────────────────────────────────────────────────────────

let _registry = null;

export function initSpellAnims() {
  _registry = {
    0x34: { drawCaster: _buildCureCaster(),    drawTarget: _buildCureTarget()    },
    0x35: { drawCaster: _buildPoisonaCaster(), drawTarget: _buildPoisonaTarget() },
  };
}

function _getEntry(spellId) {
  if (!_registry) return null;
  return _registry[spellId] || null;
}

// Public draw entry points — called by battle-drawing.js and pvp.js. No-op
// for spells without anim data, so callers can blindly invoke regardless.
export function drawSpellCasterEffect(ctx, spellId, elapsedMs, x, y) {
  const e = _getEntry(spellId);
  if (e) e.drawCaster(ctx, elapsedMs, x, y);
}
export function drawSpellTargetEffect(ctx, spellId, elapsedMs, x, y) {
  const e = _getEntry(spellId);
  if (e) e.drawTarget(ctx, elapsedMs, x, y);
}
export function hasSpellAnim(spellId) { return !!_getEntry(spellId); }

// Phase predicates — convenience for callers that need to gate other UI on
// the spell-anim phase clock (e.g. heal-num pop-in).
export function isInCasterPhase(elapsedMs) { return elapsedMs >= 0 && elapsedMs < SPELL_T_CAST; }
export function isInHealPhase(elapsedMs)   { return elapsedMs >= SPELL_T_HEAL && elapsedMs < SPELL_T_RETURN; }

// shouldDrawHealSparkle is the only legacy predicate still used by callers
// (gates ally-target heal-sparkle visibility during the heal phase). All
// other cure-anim.js exports were dropped in this rewrite.
export function shouldDrawHealSparkle(elapsedMs) { return isInHealPhase(elapsedMs); }
