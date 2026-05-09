import { NES_SYSTEM_PALETTE, decodeTile } from './tile-decoder.js';

export function _makeCanvas16() {
  const c = document.createElement('canvas'); c.width = 16; c.height = 16; return c;
}

export function _makeCanvas16ctx() {
  const c = _makeCanvas16(); return [c, c.getContext('2d')];
}

export function _hflipCanvas16(src) {
  const c = _makeCanvas16(); const cx = c.getContext('2d');
  cx.translate(16, 0); cx.scale(-1, 1); cx.drawImage(src, 0, 0); return c;
}

// 2BPP NES tile (16 bytes) → 8×8 canvas with palette applied.
// `pal` is 4 NES system-palette indices; index 0 renders transparent.
export function _make8Canvas(tile, pal) {
  const c = document.createElement('canvas'); c.width = 8; c.height = 8;
  const cx = c.getContext('2d');
  const px = decodeTile(tile);
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

// Size-agnostic horizontal flip (use _hflipCanvas16 if you want a 16×16 fixed-size copy).
export function _hflipCanvas(src) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const cx = c.getContext('2d');
  cx.translate(src.width, 0); cx.scale(-1, 1);
  cx.drawImage(src, 0, 0);
  return c;
}

// Size-agnostic vertical flip.
export function _vflipCanvas(src) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const cx = c.getContext('2d');
  cx.translate(0, src.height); cx.scale(1, -1);
  cx.drawImage(src, 0, 0);
  return c;
}

// Returns a copy of srcCanvas with all opaque pixels set to NES white ($30)
export function _makeWhiteCanvas(srcCanvas) {
  const { width: w, height: h } = srcCanvas;
  const wc = document.createElement('canvas'); wc.width = w; wc.height = h;
  const wctx = wc.getContext('2d');
  const srcData = srcCanvas.getContext('2d').getImageData(0, 0, w, h);
  const [r, g, b] = NES_SYSTEM_PALETTE[0x30] || [255, 255, 255];
  for (let p = 0; p < srcData.data.length; p += 4) {
    if (srcData.data[p + 3] > 0) { srcData.data[p] = r; srcData.data[p+1] = g; srcData.data[p+2] = b; }
  }
  wctx.putImageData(srcData, 0, 0);
  return wc;
}
