// prof-icons.js — proficiency category icon tiles
// Weapon icons from FF1&2 ROM, magic icons from FF3 ROM
import { decodeTile } from './tile-decoder.js';

const FF2_OFFSETS = {
  unarmed: 0x64A10,
  shield:  0x64A20,
  knife:   0x64A30,
  spear:   0x64A40,
  staff:   0x64A50,
  sword:   0x64A60,
  axe:     0x64A70,
  bow:     0x64A80,
};

const FF3_OFFSETS = {
  call:  0x1B730,
  white: 0x1B750,
  black: 0x1B760,
};

// [bg, dark, mid, light] NES color indices — white on black
const ICON_PALETTE = [0x0F, 0x0F, 0x10, 0x30];

let _icons = null; // Map<category, HTMLCanvasElement (8x8)>

function decodeToCanvas(romData, offset) {
  const pixels = decodeTile(romData, offset);
  const c = document.createElement('canvas');
  c.width = 8; c.height = 8;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(8, 8);
  for (let i = 0; i < 64; i++) {
    const ci = pixels[i];
    const v = ci === 0 ? 0 : ci === 1 ? 85 : ci === 2 ? 170 : 255;
    img.data[i*4]   = v;
    img.data[i*4+1] = v;
    img.data[i*4+2] = v;
    img.data[i*4+3] = ci === 0 ? 0 : 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function initProfIcons(ff3RomData, ff12RomData) {
  _icons = new Map();
  for (const [cat, off] of Object.entries(FF2_OFFSETS)) {
    _icons.set(cat, decodeToCanvas(ff12RomData, off));
  }
  for (const [cat, off] of Object.entries(FF3_OFFSETS)) {
    _icons.set(cat, decodeToCanvas(ff3RomData, off));
  }
}

export function getProfIcon(category) {
  return _icons?.get(category) || null;
}
