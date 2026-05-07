// Fire spell on-target animation — captured from FF3 NES via EMU tab REC OAM
// (200 frames, 2026-05-07, f9627 dump). After the projectile lands, a 32×8
// horizontal flame strip renders OVER THE TARGET (group 0 at origin 32,122 in
// the capture — the enemy/left-side position; previous misreads of this
// dump fixated on group 1 at the caster side and grabbed BM body bytes by
// mistake). Held static for frames 126-158 (~533ms).
//
// Palette: SP3 = [0x0F, 0x0F, 0x25, 0x2B] (black / black / pink / cyan-teal).
// Note: SP3 is bank-swapped mid-cast — frames 0-65 use the fire-cast palette
// [0x0F, 0x16, 0x27, 0x30] (red/orange/white) for the wand-flash; frames 126+
// switch to this scorch palette for the impact flame.
//
// Layout: tiles $00 (blank), $59, $59, $5C laid out at relative x=(0,8,16,24)
// y=0. Two flame "puffs" (twin $59) followed by a tail/spark ($5C) — small
// 32×8 burst over the enemy.
//
// Vocabulary (matches user's framing):
//   "cast"       — caster-side wand-flash buildup (cure-anim.js, fire palette).
//   "projectile" — $58 thrown sprite caster→target (projectile-anim.js).
//   "spell anim" — THIS module: on-target effect after projectile lands.

import { NES_SYSTEM_PALETTE } from './tile-decoder.js';

const FIRE_IMPACT_PAL = [0x0F, 0x0F, 0x25, 0x2B];

const T_59 = new Uint8Array([0x3C,0x42,0x99,0x72,0x79,0x99,0x42,0x3C, 0x00,0x3C,0x66,0x0C,0x06,0x66,0x3C,0x00]);
const T_5C = new Uint8Array([0x3C,0x42,0x9F,0x82,0x99,0x99,0x42,0x3C, 0x00,0x3C,0x60,0x7C,0x66,0x66,0x3C,0x00]);

let _impactCanvas = null;  // 32×8 strip

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
  const t59 = _make8(T_59, FIRE_IMPACT_PAL);
  const t5c = _make8(T_5C, FIRE_IMPACT_PAL);

  // 32×8 strip: blank | $59 | $59 | $5C — OAM order from the dump
  const c = document.createElement('canvas'); c.width = 32; c.height = 8;
  const cx = c.getContext('2d');
  // First slot is $00 (transparent) — leave blank.
  cx.drawImage(t59, 8, 0);
  cx.drawImage(t59, 16, 0);
  cx.drawImage(t5c, 24, 0);
  _impactCanvas = c;
}

// Returns the 32×8 fire flame canvas, or null if not initialized.
// Visual is static for the impact window; callers handle visibility timing.
export function getFireImpactCanvas() {
  return _impactCanvas;
}
