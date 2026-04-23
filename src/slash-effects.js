import { NES_SYSTEM_PALETTE } from './tile-decoder.js';
import { _makeCanvas16 } from './canvas-utils.js';

function _decode2BPPTiles(imgData, tiles, layout, pal) {
  for (let t = 0; t < tiles.length; t++) {
    const [ox, oy] = layout[t]; const d = tiles[t];
    for (let row = 0; row < 8; row++) {
      const lo = d[row], hi = d[row + 8];
      for (let bit = 7; bit >= 0; bit--) {
        const val = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
        if (val === 0) continue;
        const rgb = NES_SYSTEM_PALETTE[pal[val]] || [252, 252, 252];
        const di = ((oy + row) * 16 + ox + (7 - bit)) * 4;
        imgData.data[di] = rgb[0]; imgData.data[di+1] = rgb[1]; imgData.data[di+2] = rgb[2]; imgData.data[di+3] = 255;
      }
    }
  }
}

function _buildSwordSlashFrame(tiles, pal) {
  const c = _makeCanvas16();
  const cctx = c.getContext('2d'); const img = cctx.createImageData(16, 16);
  _decode2BPPTiles(img, tiles, [[0, 0], [8, 0]], pal);
  cctx.putImageData(img, 0, 0); return c;
}

function _putPx16(img, x, y, rgb) {
  if (x < 0 || x >= 16 || y < 0 || y >= 16) return;
  const di = (y * 16 + x) * 4;
  img.data[di] = rgb[0]; img.data[di+1] = rgb[1]; img.data[di+2] = rgb[2]; img.data[di+3] = 255;
}

// Returns [frame, frame, frame] array — assign to slashFramesR / slashFramesL / slashFrames
export function initSlashSprites() {
  const TILE_DATA = [
    new Uint8Array([0x01,0x09,0x4E,0x3C,0x18,0xF8,0x30,0x10, 0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00]),
    new Uint8Array([0x00,0x20,0xE8,0x30,0x10,0x0C,0x08,0x00, 0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00]),
    new Uint8Array([0x10,0x30,0xF8,0x18,0x3C,0x4E,0x09,0x01, 0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00]),
    new Uint8Array([0x00,0x08,0x0C,0x10,0x30,0xE8,0x20,0x00, 0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00]),
  ];
  const c = _makeCanvas16();
  const sctx = c.getContext('2d'); const imgData = sctx.createImageData(16, 16);
  _decode2BPPTiles(imgData, TILE_DATA, [[0,0],[8,0],[0,8],[8,8]], [0x0F, 0x16, 0x27, 0x30]);
  sctx.putImageData(imgData, 0, 0);
  return [c, c, c];
}

// Returns frames array — assign to knifeSlashFramesR / knifeSlashFramesL
export function initKnifeSlashSprites() {
  const white = NES_SYSTEM_PALETTE[0x30], light = NES_SYSTEM_PALETTE[0x2B], dark = NES_SYSTEM_PALETTE[0x1B];
  const FULL_LINE = Array.from({length: 15}, (_, i) => [14 - i, i]);
  const frames = [];
  for (let f = 0; f < 3; f++) {
    const c = _makeCanvas16();
    const cctx = c.getContext('2d'); const img = cctx.createImageData(16, 16);
    const startI = f === 0 ? 0 : f === 1 ? 0 : 7, endI = f === 1 ? 15 : f === 0 ? 7 : 15;
    for (let i = startI; i < endI; i++) {
      const [x, y] = FULL_LINE[i];
      _putPx16(img, x, y, white); _putPx16(img, x + 1, y, light); _putPx16(img, x, y + 1, light);
      if (f === 2 && i < 10) { _putPx16(img, x, y, dark); _putPx16(img, x + 1, y, dark); }
    }
    cctx.putImageData(img, 0, 0); frames.push(c);
  }
  return frames;
}

// Returns frames array — assign to swordSlashFramesR / swordSlashFramesL
export function initSwordSlashSprites() {
  const PAL = [0x0F, 0x00, 0x32, 0x30];
  const D = new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x03, 0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x03]);
  const E = new Uint8Array([0x00,0x04,0x00,0x18,0x30,0x60,0xC0,0x80, 0x02,0x10,0x28,0x00,0x60,0xC0,0x80,0x00]);
  const F = new Uint8Array([0x07,0x0E,0x1C,0x38,0x70,0xE0,0xC0,0x80, 0x07,0x0E,0x1C,0x38,0x70,0xE0,0xC0,0x80]);
  return [[D,E],[D,F],[E,F]].map(t => _buildSwordSlashFrame(t, PAL));
}

// Nunchaku impact/hit-flash — PPU capture of tiles $4D/$4E/$4F/$50 on target during forward-strike.
// Captured as a single 16×16 frame; reused across all 3 slash timing slots.
export function initNunchakuSlashSprites() {
  const PAL = [0x0F, 0x00, 0x32, 0x30];
  const TILES = [
    new Uint8Array([0x00,0x20,0x11,0x19,0x0D,0x0B,0x3E,0x05,0x00,0x20,0x11,0x19,0x0D,0x0F,0x3F,0x07]), // $4D
    new Uint8Array([0x80,0x80,0x80,0x88,0xB0,0x60,0x20,0x30,0x80,0x80,0x80,0x88,0xB0,0xE0,0xE0,0xF0]), // $4E
    new Uint8Array([0x0A,0x0E,0x17,0x07,0x09,0x10,0x00,0x00,0x0F,0x0F,0x17,0x07,0x09,0x10,0x00,0x00]), // $4F
    new Uint8Array([0x1E,0xA0,0x50,0xB0,0xD8,0x44,0x22,0x00,0xFE,0xE0,0xF0,0xF0,0xD8,0x44,0x22,0x00]), // $50
  ];
  const c = _makeCanvas16();
  const cctx = c.getContext('2d'); const img = cctx.createImageData(16, 16);
  _decode2BPPTiles(img, TILES, [[0,0],[8,0],[0,8],[8,8]], PAL);
  cctx.putImageData(img, 0, 0);
  return [c, c, c];
}
