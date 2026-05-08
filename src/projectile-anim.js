// Projectile delivery for spells that target an opponent.
//
// Design rule (the user's standing rule):
//   • ALL spells cast on a cross-faction target (player→enemy, ally→enemy,
//     pvp-enemy→player, pvp-enemy→ally) get a projectile.
//   • Same-faction casts (heal on self, ally) skip the projectile entirely
//     and jump straight to the on-target spell effect.
//   • Only the PALETTE varies per spell. Bitmap is universal — one $58
//     sphere reused across the whole magic system.
//
// The runtime render path interpolates between caster (x,y) and target
// (x,y); captured endpoints from the OAM dumps aren't reused — only the
// timing constants in cast-anim.js's CAST_PHASE_MS_THROW.

import { NES_SYSTEM_PALETTE } from './tile-decoder.js';

// Universal projectile bytes (REC OAM 2026-05-07 f9627, frames 46-55, tile
// $58). Round sphere shape — works for every school with palette swap.
const T_58 = new Uint8Array([
  0x00, 0x14, 0x59, 0xAC, 0xB8, 0x5E, 0x28, 0x00,
  0x00, 0x00, 0x38, 0x70, 0x70, 0x38, 0x00, 0x00,
]);

// Historical: T_58_SIGHT bytes from f5783 (Sight scene CHR bank). Distinct
// pattern (more arrow-like) but per the "one bitmap, palette swap" rule the
// runtime now uses T_58 for all spells. Preserved here for parity history.
//   T_58_SIGHT = [0x00,0x32,0x48,0xB4,0xA4,0x49,0x30,0x00,
//                 0x00,0x04,0x30,0x78,0x78,0x32,0x00,0x00]

// ── Per-spell palette table ───────────────────────────────────────────────
// Keyed by spell ID. Mirrors SPELL_CAST_PAL in cast-anim.js so the projectile
// matches the cast tint. Add a new entry alongside the cast-anim entry when
// wiring a new spell.
const SPELL_PROJECTILE_PAL = new Map([
  [0x31, [0x0F, 0x16, 0x27, 0x30]],  // Fire     — red/orange
  [0x32, [0x0F, 0x11, 0x21, 0x31]],  // Blizzard — icy blue
  [0x3a, [0x0F, 0x11, 0x21, 0x31]],  // Blizzara — icy blue (Lv2)
  [0x34, [0x0F, 0x12, 0x22, 0x31]],  // Cure     — blue/cyan
  [0x35, [0x0F, 0x15, 0x27, 0x30]],  // Poisona  — magenta
  [0x36, [0x0F, 0x29, 0x31, 0x30]],  // Sight    — green
]);

// Fallback palettes by spell element when the spell ID isn't registered
// above. Lets new captured-anim spells project sensibly without needing a
// table edit (though a real entry is preferred).
const ELEMENT_FALLBACK_PAL = {
  fire:     [0x0F, 0x16, 0x27, 0x30],
  ice:      [0x0F, 0x11, 0x21, 0x31],
  bolt:     [0x0F, 0x07, 0x27, 0x30],
  recovery: [0x0F, 0x12, 0x22, 0x31],
  air:      [0x0F, 0x29, 0x31, 0x30],
  earth:    [0x0F, 0x07, 0x17, 0x27],
  holy:     [0x0F, 0x30, 0x30, 0x30],
};

const DEFAULT_PAL = [0x0F, 0x16, 0x27, 0x30];  // matches Fire

// ── Decode helpers ────────────────────────────────────────────────────────

function _decodePixels(d) {
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
  const px = _decodePixels(tile);
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

function _vflip(src) {
  const c = document.createElement('canvas'); c.width = 8; c.height = 8;
  const cx = c.getContext('2d');
  cx.translate(0, 8); cx.scale(1, -1); cx.drawImage(src, 0, 0);
  return c;
}

// ── Per-spell decoded canvas cache ────────────────────────────────────────

let _bySpell = null;       // Map<spellId, { normal, vflip }>
let _byElement = null;     // { fire: {normal, vflip}, ice: {...}, ... }
let _default = null;       // fallback bundle

function _bundle(pal) {
  const normal = _make8(T_58, pal);
  return { normal, vflip: _vflip(normal) };
}

export function initProjectile() {
  _bySpell = new Map();
  for (const [spellId, pal] of SPELL_PROJECTILE_PAL.entries()) {
    _bySpell.set(spellId, _bundle(pal));
  }
  _byElement = {};
  for (const [el, pal] of Object.entries(ELEMENT_FALLBACK_PAL)) {
    _byElement[el] = _bundle(pal);
  }
  _default = _bundle(DEFAULT_PAL);
}

// Returns the projectile tile pair for a spell. Lookup order:
//   1. Per-spell ID palette (SPELL_PROJECTILE_PAL).
//   2. Per-element fallback (ELEMENT_FALLBACK_PAL).
//   3. Default (red — matches Fire).
// `spell` is the SPELLS map entry (has `element` field). Pass either spellId
// or spell, not both — kept compatible with the legacy call site that passed
// a spell object.
function _resolveBundle(spellId, spell) {
  if (!_default) return null;  // not initialized yet
  if (spellId != null && _bySpell) {
    const b = _bySpell.get(spellId);
    if (b) return b;
  }
  if (spell && _byElement) {
    const elKey = Array.isArray(spell.element) ? spell.element[0] : spell.element;
    if (elKey && _byElement[elKey]) return _byElement[elKey];
  }
  return _default;
}

// Returns the right 8×8 canvas (normal or vflipped) for the current frame.
// VFLIP toggle is at 60 Hz (~17ms) per the NES capture; we use Date.now()/17
// for a smooth wobble independent of dt.
export function getProjectileTile(spellOrId, spellMaybe) {
  // Backward-compat: legacy callers pass `(spell)`. New callers should pass
  // `(spellId, spell)` so the per-spell-ID lookup hits.
  const spellId = (typeof spellOrId === 'number') ? spellOrId : null;
  const spell   = (typeof spellOrId === 'object') ? spellOrId : (spellMaybe || null);
  const bundle = _resolveBundle(spellId, spell);
  if (!bundle) return null;
  return ((Math.floor(Date.now() / 17) & 1) === 0) ? bundle.normal : bundle.vflip;
}

// First 60% of the throw window is flight (caster → target); last 40% is
// endpoint hold while the on-target burst plays. Used by the projectile
// flight interpolator.
export const PROJECTILE_FLIGHT_FRAC = 0.6;

export function getProjectilePos(sx, sy, tx, ty, t01) {
  if (t01 < 0 || t01 > 1) return { drawn: false };
  const t = t01 / PROJECTILE_FLIGHT_FRAC;
  if (t >= 1) return { x: tx, y: ty, drawn: true };
  return {
    x: sx + (tx - sx) * t,
    y: sy + (ty - sy) * t,
    drawn: true,
  };
}
