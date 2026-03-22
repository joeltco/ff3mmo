import { NES_SYSTEM_PALETTE } from './tile-decoder.js';

// Extract plane 0 (bit 0 of each pixel) into 8 packed bytes
export function _getPlane0(pixels) {
  const p = new Uint8Array(8);
  for (let r = 0; r < 8; r++) {
    let b = 0;
    for (let c = 0; c < 8; c++) b |= (pixels[r * 8 + c] & 1) << (7 - c);
    p[r] = b;
  }
  return p;
}

// Rebuild 64-pixel tile from plane0 bytes + plane1 pixel array
export function _rebuild(plane0, plane1pix) {
  const px = new Uint8Array(64);
  for (let r = 0; r < 8; r++) {
    const b = plane0[r];
    for (let c = 0; c < 8; c++)
      px[r * 8 + c] = plane1pix[r * 8 + c] | ((b >> (7 - c)) & 1);
  }
  return px;
}

// Shift two horizontally adjacent water tile plane0 rows by 1 pixel
export function _shiftHorizWater(cL, cR) {
  const nL = new Uint8Array(8), nR = new Uint8Array(8);
  for (let r = 0; r < 8; r++) {
    const l = cL[r], ri = cR[r];
    nL[r] = ((l >> 1) | ((ri & 1) << 7)) & 0xFF;
    nR[r] = ((ri >> 1) | ((l & 1) << 7)) & 0xFF;
  }
  return [nL, nR];
}

// Returns true if all 64 pixels have bit 1 set (water plane check)
export function _isWater(pixels) {
  for (let i = 0; i < 64; i++) if (!(pixels[i] & 2)) return false;
  return true;
}

// Build a mixed tile blending cur (top) and prev (bottom) at a row boundary
export function _buildHorizMixed(curTile, prevTile, subRow) {
  const m = new Array(64);
  for (let py = 0; py < 8; py++) {
    const src = py <= subRow ? curTile : prevTile;
    for (let px = 0; px < 8; px++) m[py * 8 + px] = src[py * 8 + px];
  }
  return m;
}

// Write 64 pixels into ImageData using pre-resolved RGB palette (transparent on index 0)
export function _writePixels64(img, pixels, pal) {
  for (let p = 0; p < 64; p++) {
    const ci = pixels[p];
    if (ci === 0) { img.data[p * 4 + 3] = 0; }
    else {
      const rgb = NES_SYSTEM_PALETTE[pal[ci]] || [0, 0, 0];
      img.data[p * 4] = rgb[0]; img.data[p * 4 + 1] = rgb[1];
      img.data[p * 4 + 2] = rgb[2]; img.data[p * 4 + 3] = 255;
    }
  }
}

// Write 64 pixels into ImageData using pre-resolved RGB values array
export function _writeTilePixels(td, tile, rgbPal) {
  for (let p = 0; p < 64; p++) {
    const rgb = rgbPal[tile[p]]; const di = p * 4;
    td[di]=rgb[0]; td[di+1]=rgb[1]; td[di+2]=rgb[2]; td[di+3]=255;
  }
}
