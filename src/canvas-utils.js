import { NES_SYSTEM_PALETTE } from './tile-decoder.js';

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
