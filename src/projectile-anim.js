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

import { _make8Canvas, _hflipCanvas, _vflipCanvas } from './canvas-utils.js';
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
  [0x33, [0x0F, 0x15, 0x27, 0x30]],  // Sleep    — magenta
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

// ── Per-spell decoded canvas cache ────────────────────────────────────────

let _bySpell = null;       // Map<spellId, { normal, vflip }>
let _byElement = null;     // { fire: {normal, vflip}, ice: {...}, ... }
let _default = null;       // fallback bundle

function _bundle(pal) {
  const normal = _make8Canvas(T_58, pal);
  const normalH = _hflipCanvas(normal);
  return {
    normal, vflip: _vflipCanvas(normal),
    // h-flipped pair for projectiles traveling left→right (PVP-enemy-cast on
    // player party). The $58 tile bytes have a directional trailing flame —
    // the canonical capture was right→left (player→enemy), so left→right
    // flight needs an h-flip to keep the flame trailing behind the orb.
    normalHflip: normalH, vflipHflip: _vflipCanvas(normalH),
  };
}


// ─── Physical weapon projectiles (PPU-captured) ────────────────────────────
//
// Distinct from the spell projectile above: that one is a single universal $58
// sphere recolored per school, because every spell throws the same orb. Thrown
// and fired weapons each have their own artwork, so each carries its own tiles.
//
// Captured with tools/monscan/weapon-extract.cjs. The flight pose is the one
// furthest forward — the party stands right of the enemies, so a projectile
// leaving the character travels left, and it is the same positional rule that
// assigned raised-vs-swung for the held overlays. Arrow and shuriken fly as a
// single 8x8; boomerang is a 16x16 meta-sprite, so all three are stored on a
// 16x16 grid and the shape falls out of the data.

// arrow flight sprite — PPU-captured at (189,114), 20 opaque px
const ARROW_PROJ_TILES = [
  new Uint8Array([0x00,0x00,0x00,0x73,0x53,0x23,0x00,0x00,0x00,0x00,0x00,0x0c,0x2c,0x4c,0x00,0x00]),
  new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00]),
  new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00]),
  new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00]),
];
const ARROW_PROJ_PAL = [0x0F,0x17,0x36,0x0F];

// boomerang flight sprite — PPU-captured at (94,94), 95 opaque px
const BOOMERANG_PROJ_TILES = [
  new Uint8Array([0x07,0x08,0x10,0x10,0x00,0x21,0x22,0x24,0x00,0x07,0x0f,0x0f,0x1f,0x1e,0x1c,0x18]),
  new Uint8Array([0x80,0x60,0x1c,0x02,0x01,0xfe,0x00,0x00,0x00,0x80,0xe0,0xfc,0xfe,0x00,0x00,0x00]),
  new Uint8Array([0x44,0x78,0x78,0x90,0x90,0xa0,0xc0,0x00,0x38,0x30,0x70,0x60,0x60,0x40,0x00,0x00]),
  new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00]),
];
const BOOMERANG_PROJ_PAL = [0x0F,0x24,0x34,0x21];

// shuriken flight sprite — PPU-captured at (43,76), 21 opaque px
const SHURIKEN_PROJ_TILES = [
  new Uint8Array([0x40,0x00,0x60,0x94,0x90,0x60,0x00,0x20,0x00,0x60,0xf0,0x98,0x98,0xf0,0x60,0x00]),
  new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00]),
  new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00]),
  new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00]),
];
const SHURIKEN_PROJ_PAL = [0x0F,0x37,0x18,0x13];


let _weaponProj = null;

/** Build the weapon projectile canvases. Called from initProjectile. */
function _initWeaponProjectiles() {
  const quad = [[0, 0], [8, 0], [0, 8], [8, 8]];
  const make = (tiles, pal) => {
    const c = document.createElement('canvas');
    c.width = 16; c.height = 16;
    const cctx = c.getContext('2d');
    tiles.forEach((t, i) => _blitProjTile(cctx, t, pal, quad[i][0], quad[i][1]));
    return c;
  };
  _weaponProj = {
    arrow:     make(ARROW_PROJ_TILES, ARROW_PROJ_PAL),
    boomerang: make(BOOMERANG_PROJ_TILES, BOOMERANG_PROJ_PAL),
    shuriken:  make(SHURIKEN_PROJ_TILES, SHURIKEN_PROJ_PAL),
  };
}

function _blitProjTile(ctx, bytes, palette, x, y) {
  const img = ctx.createImageData(8, 8);
  for (let row = 0; row < 8; row++) {
    const lo = bytes[row], hi = bytes[row + 8];
    for (let col = 0; col < 8; col++) {
      const bit = 7 - col, p = (row * 8 + col) * 4;
      const v = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
      if (!v) { img.data[p + 3] = 0; continue; }
      const rgb = NES_SYSTEM_PALETTE[palette[v]] || [0, 0, 0];
      img.data[p] = rgb[0]; img.data[p + 1] = rgb[1]; img.data[p + 2] = rgb[2]; img.data[p + 3] = 255;
    }
  }
  ctx.putImageData(img, x, y);
}

/**
 * Flight sprite for a thrown/fired weapon, or null for anything that is not
 * one. Callers pass the weapon subtype so arrows resolve from the ARROW in the
 * quiver rather than the bow that fires it.
 */
export function getWeaponProjectile(subtype) {
  if (!_weaponProj) return null;
  return _weaponProj[subtype] || null;
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
  _initWeaponProjectiles();
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
// for a smooth wobble independent of dt. Pass `hflip=true` for projectiles
// traveling left→right so the trailing flame stays behind the orb.
export function getProjectileTile(spellOrId, spellMaybe, hflip = false) {
  // Backward-compat: legacy callers pass `(spell)`. Newer callers can pass
  // `(spellId, spell)` or `(spellId, spell, hflip)` to drive direction.
  const spellId = (typeof spellOrId === 'number') ? spellOrId : null;
  const spell   = (typeof spellOrId === 'object') ? spellOrId : (spellMaybe || null);
  const bundle = _resolveBundle(spellId, spell);
  if (!bundle) return null;
  const phase = (Math.floor(Date.now() / 17) & 1) === 0;
  if (hflip) return phase ? bundle.normalHflip : bundle.vflipHflip;
  return phase ? bundle.normal : bundle.vflip;
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
