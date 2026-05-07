// Fire spell impact — captured from FF3 NES via EMU tab REC OAM (200 frames,
// 2026-05-07, f9627 dump). After the projectile lands on the target, a 16×24
// fire flame plays for ~700 ms (frames 66-108 of capture). Six tiles in a
// 2×3 grid, palette SP1 = [0x0F, 0x27, 0x18, 0x21] (yellow / orange-brown /
// blue). Visually static across the impact window — confirmed identical at
// frames 70, 80, 95 — so we render one canvas held for the impact duration.
//
// Vocabulary (matches user's framing):
//   "cast"       — caster-side wand-flash buildup (school palette swap of the
//                  shared $4A-$57 flame; lives in cure-anim.js).
//   "projectile" — $58 thrown sprite that flies caster→target (projectile-
//                  anim.js, palette per school).
//   "spell anim" — THIS module: the on-target effect that plays after the
//                  projectile lands. Sight has none; Fire = the flame below.

import { NES_SYSTEM_PALETTE } from './tile-decoder.js';

const FIRE_IMPACT_PAL = [0x0F, 0x27, 0x18, 0x21];

const T_01 = new Uint8Array([0x00,0x00,0x00,0x00,0x03,0xFF,0x07,0x00, 0x00,0x00,0x00,0x00,0x00,0x00,0x78,0x0F]);
const T_02 = new Uint8Array([0x06,0x1C,0x38,0xF0,0xC0,0x00,0x80,0xE0, 0x00,0x02,0x04,0x0C,0x38,0xF8,0x78,0x10]);
const T_03 = new Uint8Array([0x00,0x08,0x09,0x21,0x40,0x71,0x3F,0xDF, 0x01,0x00,0x00,0x20,0x40,0x71,0x3F,0x1F]);
const T_04 = new Uint8Array([0x00,0x00,0x00,0x08,0x04,0xFC,0x88,0x3C, 0xF8,0x3C,0x0E,0x08,0x04,0xFC,0x88,0x3C]);
const T_05 = new Uint8Array([0xDE,0x36,0x59,0x5F,0x6F,0x77,0x79,0xFF, 0x1E,0x36,0x59,0x5F,0x6F,0x77,0x79,0xFF]);
const T_06 = new Uint8Array([0xDC,0xDC,0x3C,0x3C,0x3C,0xBC,0xDA,0xE7, 0x1C,0x1C,0x3C,0x3C,0x3C,0xBC,0xDA,0xE7]);

let _impactCanvas = null;  // 16×24

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

export function initFireImpact() {
  const t01 = _make8(T_01, FIRE_IMPACT_PAL);
  const t02 = _make8(T_02, FIRE_IMPACT_PAL);
  const t03 = _make8(T_03, FIRE_IMPACT_PAL);
  const t04 = _make8(T_04, FIRE_IMPACT_PAL);
  const t05 = _make8(T_05, FIRE_IMPACT_PAL);
  const t06 = _make8(T_06, FIRE_IMPACT_PAL);

  const c = document.createElement('canvas'); c.width = 16; c.height = 24;
  const cx = c.getContext('2d');
  cx.drawImage(t01, 0, 0);  cx.drawImage(t02, 8, 0);
  cx.drawImage(t03, 0, 8);  cx.drawImage(t04, 8, 8);
  cx.drawImage(t05, 0, 16); cx.drawImage(t06, 8, 16);
  _impactCanvas = c;
}

// Returns the 16×24 fire flame canvas, or null if not initialized.
// The visual is static for the impact window; callers handle visibility timing.
export function getFireImpactCanvas() {
  return _impactCanvas;
}
