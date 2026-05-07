// Projectile delivery for thrown spells (Sight, Fire, future BM damage).
// FF3 NES uses a single 8x8 sprite ($58) that flies caster→target after the
// cast pose, VFLIP-toggling every frame. The bitmap is identical across spells;
// only the palette changes per school.
//
// Captured trajectories (OAM origin coords):
//   Sight (REC OAM 2026-05-07, f5783): (176, 53) → (38, 128) over ~10 frames
//   Fire  (REC OAM 2026-05-07, f9627): same $58 tile in fire palette
// The runtime render path interpolates between caster-portrait (x,y) and
// target-portrait (x,y), so captured endpoints aren't reused — only the timing.
//
// This module owns the throw/delivery phase only — NOT the on-target spell
// animation. After the throw lands the caller hands off to the per-spell impact
// in spell-anim.js (sight = battle msg, fire = spell-anim flame burst, etc.).

import { NES_SYSTEM_PALETTE } from './tile-decoder.js';

const T_58 = new Uint8Array([
  0x00, 0x32, 0x48, 0xB4, 0xA4, 0x49, 0x30, 0x00,
  0x00, 0x04, 0x30, 0x78, 0x78, 0x32, 0x00, 0x00,
]);

// Palette per school. Add a new key when capturing a new BM/WM throw palette.
const PROJECTILE_PAL = {
  sight: [0x0F, 0x29, 0x31, 0x30],  // green / light cyan / white
  fire:  [0x0F, 0x16, 0x27, 0x30],  // red / orange / white (REC OAM 2026-05-07 f9627)
};

let _byKey = null;  // { sight: { normal, vflip }, fire: { normal, vflip } }

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

export function initProjectile() {
  _byKey = {};
  for (const [key, pal] of Object.entries(PROJECTILE_PAL)) {
    const normal = _make8(T_58, pal);
    _byKey[key] = { normal, vflip: _vflip(normal) };
  }
}

// Pick the projectile palette key for a spell. Returns null if the spell
// doesn't use a thrown projectile (e.g., recovery/cure_status — those land
// straight on the target via spell-anim's portrait sparkle).
export function getProjectilePalKey(spell) {
  if (!spell) return null;
  if (spell.target === 'sight') return 'sight';
  if (spell.element === 'fire') return 'fire';
  return null;
}

// Returns the right 8x8 canvas (normal or vflipped) for the current frame.
// VFLIP toggle is at 60 Hz (~17ms) per the NES capture; we use Date.now()/17
// for a smooth wobble independent of dt.
export function getProjectileTile(spell) {
  const key = getProjectilePalKey(spell);
  if (!key || !_byKey || !_byKey[key]) return null;
  const pair = _byKey[key];
  return ((Math.floor(Date.now() / 17) & 1) === 0) ? pair.normal : pair.vflip;
}

// First 60% of the heal-window frac is flight (caster → target); last 40% is
// endpoint hold while the spell impact animation plays.
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
