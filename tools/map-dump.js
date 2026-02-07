#!/usr/bin/env node
// Map Dump Tool — renders map data from ROM to PPM images for visual inspection.
// Usage: node tools/map-dump.js [mapId]
// Outputs: tools/out/chr-tiles.ppm, tools/out/metatiles.ppm, tools/out/map.ppm

import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const mapId = parseInt(process.argv[2] || '114', 10);

// ─── NES System Palette ───
const NES_PAL = [
  [0x62,0x62,0x62],[0x00,0x2E,0x98],[0x12,0x12,0xAB],[0x35,0x00,0x9E],
  [0x4E,0x00,0x7A],[0x5B,0x00,0x45],[0x5A,0x04,0x00],[0x4A,0x18,0x00],
  [0x30,0x2E,0x00],[0x14,0x40,0x00],[0x00,0x49,0x00],[0x00,0x47,0x12],
  [0x00,0x3E,0x4B],[0x00,0x00,0x00],[0x00,0x00,0x00],[0x00,0x00,0x00],
  [0xAB,0xAB,0xAB],[0x0F,0x63,0xE7],[0x37,0x40,0xFF],[0x6C,0x2E,0xFF],
  [0x9C,0x22,0xD4],[0xAF,0x22,0x83],[0xAD,0x31,0x2E],[0x96,0x4B,0x00],
  [0x71,0x66,0x00],[0x45,0x7C,0x00],[0x1E,0x87,0x00],[0x07,0x84,0x2E],
  [0x00,0x79,0x76],[0x00,0x00,0x00],[0x00,0x00,0x00],[0x00,0x00,0x00],
  [0xFF,0xFF,0xFF],[0x56,0xB4,0xFF],[0x7B,0x97,0xFF],[0xAF,0x87,0xFF],
  [0xE0,0x7C,0xFF],[0xF2,0x7D,0xD2],[0xF0,0x8B,0x82],[0xDA,0xA3,0x36],
  [0xBA,0xBC,0x14],[0x8E,0xD1,0x1A],[0x6A,0xDA,0x42],[0x54,0xD7,0x82],
  [0x4F,0xCE,0xC6],[0x4E,0x4E,0x4E],[0x00,0x00,0x00],[0x00,0x00,0x00],
  [0xFF,0xFF,0xFF],[0xBE,0xDF,0xFF],[0xCC,0xD3,0xFF],[0xE1,0xCB,0xFF],
  [0xF3,0xC7,0xFF],[0xFB,0xC7,0xED],[0xFA,0xCD,0xCA],[0xF2,0xD7,0xAB],
  [0xE4,0xE2,0x9D],[0xD1,0xEB,0x9E],[0xC1,0xEF,0xAE],[0xB7,0xEE,0xC9],
  [0xB5,0xEA,0xE7],[0xB0,0xB0,0xB0],[0x00,0x00,0x00],[0x00,0x00,0x00],
];

// ─── ROM offsets ───
const MAP_PROPS_BASE   = 0x004010;
const TILESET_BASE     = 0x002390;
const NAME_TABLE_BASE  = 0x003190;
const COLLISION_BASE   = 0x003510;
const GFX_SUBSET_ID    = 0x000C10;
const GFX_SUBSET_BASE  = 0x000E10;
const MAP_BG_GFX_BASE  = 0x006010;
const PAL_TABLE_1      = 0x001110;
const PAL_TABLE_2      = 0x001210;
const PAL_TABLE_3      = 0x001310;
const TILEMAP_ID_BASE  = 0x000A10;
const TILEMAP_PTR_BASE = 0x022010;
const SLOT_COUNTS = [0x1A, 0x08, 0x08, 0x0E, 0x08, 0x10, 0x10, 0x10]; // 112 tiles

// ─── PPM writer ───
function writePPM(path, w, h, pixels) {
  const header = `P6\n${w} ${h}\n255\n`;
  const buf = Buffer.alloc(header.length + w * h * 3);
  buf.write(header);
  const off = header.length;
  for (let i = 0; i < w * h; i++) {
    buf[off + i * 3]     = pixels[i * 3];
    buf[off + i * 3 + 1] = pixels[i * 3 + 1];
    buf[off + i * 3 + 2] = pixels[i * 3 + 2];
  }
  writeFileSync(path, buf);
  console.log(`  wrote ${path} (${w}×${h})`);
}

// ─── 2BPP tile decoder ───
function decodeTile(rom, offset) {
  const px = new Uint8Array(64);
  for (let row = 0; row < 8; row++) {
    const bp0 = rom[offset + row];
    const bp1 = rom[offset + row + 8];
    for (let col = 0; col < 8; col++) {
      const bit = 7 - col;
      px[row * 8 + col] = ((bp1 >> bit) & 1) << 1 | ((bp0 >> bit) & 1);
    }
  }
  return px;
}

// ─── Load ROM ───
const rom = readFileSync('Final Fantasy III (Japan).nes');
console.log(`ROM: ${rom.length} bytes, Map ID: ${mapId}`);

// ─── Step 1: Map Properties ───
const propOff = MAP_PROPS_BASE + mapId * 16;
const b0 = rom[propOff], b1 = rom[propOff + 1];
const tileset    = (b0 >> 5) & 7;
const entranceX  = b0 & 0x1F;
const entranceY  = b1 & 0x1F;
const fillTile   = rom[propOff + 3];
const palIdx     = [rom[propOff + 5], rom[propOff + 6], rom[propOff + 7]];
console.log(`Tileset: ${tileset}, Entrance: (${entranceX},${entranceY}), Fill: ${fillTile}, Pal indices: [${palIdx}]`);

// ─── Step 2: Build palettes ───
const palettes = [];
for (let i = 0; i < 3; i++) {
  palettes.push([
    0x0F,
    rom[PAL_TABLE_1 + palIdx[i]],
    rom[PAL_TABLE_2 + palIdx[i]],
    rom[PAL_TABLE_3 + palIdx[i]],
  ]);
}
palettes.push([0x0F, 0x00, 0x02, 0x30]); // palette 3: menu/text window (hardcoded in game)
for (let i = 0; i < 4; i++) {
  const cols = palettes[i].map(c => `0x${c.toString(16).padStart(2,'0')}`);
  console.log(`Palette ${i}: [${cols}]`);
}

// ─── Step 3: Load CHR tiles ───
const subsetId = rom[GFX_SUBSET_ID + mapId];
const subOff = GFX_SUBSET_BASE + subsetId * 16;
const chrTiles = [];
console.log(`\nGraphics subset: ${subsetId}`);
for (let slot = 0; slot < 8; slot++) {
  const ptr = rom[subOff + slot * 2] | (rom[subOff + slot * 2 + 1] << 8);
  const fileOff = MAP_BG_GFX_BASE + ptr;
  const count = SLOT_COUNTS[slot];
  console.log(`  Slot ${slot}: ptr=0x${ptr.toString(16).padStart(4,'0')} -> file 0x${fileOff.toString(16)}, ${count} tiles (CHR #${chrTiles.length}-${chrTiles.length + count - 1})`);
  for (let t = 0; t < count; t++) {
    chrTiles.push(decodeTile(rom, fileOff + t * 16));
  }
}
console.log(`Total CHR tiles loaded: ${chrTiles.length}`);

// ─── Step 4: Load tileset (planar) ───
const tsOff = TILESET_BASE + tileset * 512;
const tsData = rom.slice(tsOff, tsOff + 512);
const metatiles = [];
for (let m = 0; m < 128; m++) {
  metatiles.push({
    tl: tsData[m],
    tr: tsData[m + 128],
    bl: tsData[m + 256],
    br: tsData[m + 384],
  });
}

// ─── Step 5: Load name table (palette per metatile) ───
const ntOff = NAME_TABLE_BASE + tileset * 128;
const tileAttrs = rom.slice(ntOff, ntOff + 128);

// ─── Step 6: Decompress tilemap ───
// Look up tilemap ID from per-map table, then resolve pointer with bank math
const tilemapId = rom[TILEMAP_ID_BASE + mapId];
const ptrIndex = (tilemapId * 2) & 0xFF;
const ptrTableHi = (tilemapId & 0x80) ? 0x81 : 0x80;
const ptrTableRomBase = TILEMAP_PTR_BASE + ((ptrTableHi - 0x80) << 8);
const tmPtrLo = rom[ptrTableRomBase + ptrIndex];
const tmPtrHi = rom[ptrTableRomBase + ptrIndex + 1];
const nesAddrLo = tmPtrLo;
const nesAddrHi = (tmPtrHi & 0x1F) | 0x80;
const tmBank = 0x11 + (tmPtrHi >> 5);
const tmRomOffset = tmBank * 0x2000 + 0x10 + ((nesAddrHi << 8 | nesAddrLo) - 0x8000);
console.log(`Tilemap ID: ${tilemapId}, Bank: 0x${tmBank.toString(16)}, ROM offset: 0x${tmRomOffset.toString(16)}`);

let readPos = tmRomOffset;
const tilemap = new Uint8Array(1024);
let writePos = 0;
while (writePos < 1024) {
  const byte = rom[readPos++];
  if ((byte & 0x80) === 0) {
    tilemap[writePos++] = byte;
  } else {
    const tile = byte & 0x7F;
    const runLen = rom[readPos++];
    for (let i = 0; i < runLen && writePos < 1024; i++) tilemap[writePos++] = tile;
  }
}

// ─── Helper: resolve NES color index to RGB ───
function nesRGB(idx) {
  return NES_PAL[idx & 0x3F] || [0, 0, 0];
}

// ─── Helper: render an 8x8 CHR tile into a pixel buffer ───
function renderCHR(pixels, pw, px, py, tile, pal) {
  if (!tile) return;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const ci = tile[y * 8 + x];
      const rgb = nesRGB(pal[ci]);
      const di = ((py + y) * pw + (px + x)) * 3;
      pixels[di] = rgb[0];
      pixels[di + 1] = rgb[1];
      pixels[di + 2] = rgb[2];
    }
  }
}

// ─── Output dir ───
mkdirSync('tools/out', { recursive: true });

// ═══════════════════════════════════════════
// IMAGE 1: Raw CHR tiles (16 columns × N rows, each tile 8×8)
// ═══════════════════════════════════════════
{
  const cols = 16;
  const rows = Math.ceil(chrTiles.length / cols);
  const w = cols * 8;
  const h = rows * 8;
  const px = new Uint8Array(w * h * 3);
  // Use a grayscale palette to show raw tile data without palette influence
  const grayPal = [0x0F, 0x00, 0x10, 0x30]; // black, dark gray, medium, white
  for (let i = 0; i < chrTiles.length; i++) {
    const cx = (i % cols) * 8;
    const cy = Math.floor(i / cols) * 8;
    renderCHR(px, w, cx, cy, chrTiles[i], grayPal);
  }
  writePPM('tools/out/1-chr-tiles.ppm', w, h, px);
}

// ═══════════════════════════════════════════
// IMAGE 2: All 128 metatiles (16 columns × 8 rows, each metatile 16×16)
// ═══════════════════════════════════════════
{
  const cols = 16;
  const rows = 8;
  const w = cols * 16;
  const h = rows * 16;
  const px = new Uint8Array(w * h * 3);
  for (let m = 0; m < 128; m++) {
    const mx = (m % cols) * 16;
    const my = Math.floor(m / cols) * 16;
    const meta = metatiles[m];
    const palGroup = tileAttrs[m] & 0x03;
    const pal = palettes[palGroup];
    renderCHR(px, w, mx,     my,     chrTiles[meta.tl], pal);
    renderCHR(px, w, mx + 8, my,     chrTiles[meta.tr], pal);
    renderCHR(px, w, mx,     my + 8, chrTiles[meta.bl], pal);
    renderCHR(px, w, mx + 8, my + 8, chrTiles[meta.br], pal);
  }
  writePPM('tools/out/2-metatiles.ppm', w, h, px);
}

// ═══════════════════════════════════════════
// IMAGE 3: Full 32×32 map
// ═══════════════════════════════════════════
{
  const w = 32 * 16;
  const h = 32 * 16;
  const px = new Uint8Array(w * h * 3);
  for (let ty = 0; ty < 32; ty++) {
    for (let tx = 0; tx < 32; tx++) {
      const mid = tilemap[ty * 32 + tx];
      const m = mid < 128 ? mid : mid & 0x7F;
      const meta = metatiles[m];
      const palGroup = tileAttrs[m] & 0x03;
      const pal = palettes[palGroup];
      const sx = tx * 16;
      const sy = ty * 16;
      renderCHR(px, w, sx,     sy,     chrTiles[meta.tl], pal);
      renderCHR(px, w, sx + 8, sy,     chrTiles[meta.tr], pal);
      renderCHR(px, w, sx,     sy + 8, chrTiles[meta.bl], pal);
      renderCHR(px, w, sx + 8, sy + 8, chrTiles[meta.br], pal);
    }
  }
  writePPM('tools/out/3-map.ppm', w, h, px);

  // Mark entrance with a red dot
  const ex = entranceX * 16 + 8;
  const ey = entranceY * 16 + 8;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const di = ((ey + dy) * w + (ex + dx)) * 3;
      if (di >= 0 && di < px.length - 2) { px[di] = 255; px[di+1] = 0; px[di+2] = 0; }
    }
  }
  writePPM('tools/out/3-map-entrance.ppm', w, h, px);
}

console.log('\nDone! Check tools/out/ for images.');
