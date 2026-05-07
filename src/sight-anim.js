// Sight spell projectile — captured from FF3 NES via EMU tab REC OAM (200 frames,
// 2026-05-07). Sight reuses the white-magic flame buildup (cure-anim.js) with the
// 'sight' palette [0x0F, 0x29, 0x31, 0x30] (green / light cyan / white), then
// after the cast pose a single 8x8 sprite ($58) flies from caster toward target,
// VFLIP-toggling every frame. That projectile is what this module owns.
//
// Captured trajectory (OAM origin coords): (176, 53) → (38, 128) over ~10 frames
// (~150ms) of motion + ~150ms held at endpoint. Render path interpolates between
// caster-portrait (x,y) and target-portrait (x,y) at runtime, so the captured
// endpoint isn't reused — only the timing.

import { NES_SYSTEM_PALETTE } from './tile-decoder.js';

const T_58 = new Uint8Array([
  0x00, 0x32, 0x48, 0xB4, 0xA4, 0x49, 0x30, 0x00,
  0x00, 0x04, 0x30, 0x78, 0x78, 0x32, 0x00, 0x00,
]);

const SIGHT_PAL = [0x0F, 0x29, 0x31, 0x30];

let _proj = null;       // 8x8 canvas, normal orientation
let _projVflip = null;  // 8x8 canvas, vertical flip

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

export function initSightProjectile() {
  _proj = _make8(T_58, SIGHT_PAL);
  _projVflip = _vflip(_proj);
}

// Pick the right orientation for the current frame. NES capture toggles VFLIP
// every frame at 60 Hz (~17ms). At 60fps render this is the same; we use
// Date.now()/17 to get a smooth wobble independent of dt.
export function getSightProjectileTile() {
  if (!_proj) return null;
  return ((Math.floor(Date.now() / 17) & 1) === 0) ? _proj : _projVflip;
}

// Phase timing during 'magic-hit'. The cure-anim heal window starts at
// (CURE_T_HEAL - CURE_PHASE_MS.buildup) ms after magic-hit start and lasts
// CURE_PHASE_MS.heal ms (283ms). For Sight, we use that window: first 60% is
// flight (caster → target), last 40% is endpoint hold.
export const SIGHT_FLIGHT_FRAC = 0.6;

// Returns { x, y, drawn: true } position for a sight projectile in flight, or
// { drawn: false } if not visible. `t01` is 0..1 progress through the heal
// window (0 = flight start, 1 = window end).
export function getSightProjectilePos(sx, sy, tx, ty, t01) {
  if (t01 < 0 || t01 > 1) return { drawn: false };
  const t = t01 / SIGHT_FLIGHT_FRAC;
  if (t >= 1) return { x: tx, y: ty, drawn: true };
  return {
    x: sx + (tx - sx) * t,
    y: sy + (ty - sy) * t,
    drawn: true,
  };
}
