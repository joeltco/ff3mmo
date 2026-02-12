#!/usr/bin/env node
// Map Dump Tool — renders map data from ROM to PPM images for visual inspection.
// Usage: node tools/map-dump.js [mapId]
// Outputs: tools/out/<mapId>-chr.ppm, <mapId>-metatiles.ppm, <mapId>-map.ppm, <mapId>-collision.ppm

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT   = join(__dirname, '..');
const ROM_PATH  = join(PROJECT, 'Final Fantasy III (Japan).nes');
const OUT_DIR   = join(__dirname, 'out');

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
const SLOT_COUNTS      = [0x1A, 0x08, 0x08, 0x0E, 0x08, 0x10, 0x10, 0x10];

// ─── Collision overlay colors [R, G, B] ───
const COL_PASSABLE  = [0x20, 0x80, 0x20]; // green
const COL_WALL      = [0xA0, 0x20, 0x20]; // red
const COL_WATER     = [0x20, 0x40, 0xA0]; // blue
const COL_TRIG_EXIT = [0xC0, 0x40, 0xC0]; // magenta (exit_prev/exit_world)
const COL_TRIG_ENTR = [0x20, 0xA0, 0xC0]; // cyan (entrance/door)
const COL_TRIG_MISC = [0xC0, 0xC0, 0x20]; // yellow (event/other)
const COL_ENTRANCE  = [0xFF, 0x40, 0x40]; // bright red (entrance marker)

const COLL_TRIG_TYPES = {
  0: 'exit_prev', 1: 'exit_world', 4: 'entrance', 5: 'door',
  6: 'locked_door', 12: 'impassable', 13: 'impassable', 14: 'impassable', 15: 'event',
};

// ─── PPM writer ───
function writePPM(path, w, h, pixels) {
  const header = `P6\n${w} ${h}\n255\n`;
  const buf = Buffer.alloc(header.length + w * h * 3);
  buf.write(header);
  const off = header.length;
  for (let i = 0; i < w * h * 3; i++) buf[off + i] = pixels[i];
  writeFileSync(path, buf);
  console.log(`  ${path} (${w}x${h})`);
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

function nesRGB(idx) { return NES_PAL[idx & 0x3F] || [0, 0, 0]; }

function renderCHR(pixels, pw, px, py, tile, pal) {
  if (!tile) return;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const rgb = nesRGB(pal[tile[y * 8 + x]]);
      const di = ((py + y) * pw + (px + x)) * 3;
      pixels[di] = rgb[0]; pixels[di + 1] = rgb[1]; pixels[di + 2] = rgb[2];
    }
  }
}

// ─── Load ROM ───
const rom = readFileSync(ROM_PATH);
console.log(`ROM: ${rom.length} bytes, Map: ${mapId}`);

// ─── Map Properties ───
const propOff = MAP_PROPS_BASE + mapId * 16;
const b0 = rom[propOff], b1 = rom[propOff + 1];
const tileset    = (b0 >> 5) & 7;
const entranceX  = b0 & 0x1F;
const entranceY  = b1 & 0x1F;
const fillTile   = rom[propOff + 3];
const palIdx     = [rom[propOff + 5], rom[propOff + 6], rom[propOff + 7]];
console.log(`Tileset: ${tileset}, Entrance: (${entranceX},${entranceY}), Fill: $${fillTile.toString(16)}`);

// ─── Palettes ───
const palettes = [];
for (let i = 0; i < 3; i++) {
  palettes.push([0x0F, rom[PAL_TABLE_1 + palIdx[i]], rom[PAL_TABLE_2 + palIdx[i]], rom[PAL_TABLE_3 + palIdx[i]]]);
}
palettes.push([0x0F, 0x00, 0x02, 0x30]);

// ─── CHR tiles ───
const subsetId = rom[GFX_SUBSET_ID + mapId];
const subOff = GFX_SUBSET_BASE + subsetId * 16;
const chrTiles = [];
for (let slot = 0; slot < 8; slot++) {
  const ptr = rom[subOff + slot * 2] | (rom[subOff + slot * 2 + 1] << 8);
  const count = SLOT_COUNTS[slot];
  for (let t = 0; t < count; t++) chrTiles.push(decodeTile(rom, MAP_BG_GFX_BASE + ptr + t * 16));
}

// ─── Tileset (planar) ───
const tsOff = TILESET_BASE + tileset * 512;
const tsData = rom.slice(tsOff, tsOff + 512);
const metatiles = [];
for (let m = 0; m < 128; m++) {
  metatiles.push({ tl: tsData[m], tr: tsData[m + 128], bl: tsData[m + 256], br: tsData[m + 384] });
}

// ─── Tile attrs ───
const ntOff = NAME_TABLE_BASE + tileset * 128;
const tileAttrs = rom.slice(ntOff, ntOff + 128);

// ─── Collision data ───
const collOff = COLLISION_BASE + tileset * 256;

// ─── Decompress tilemap ───
const tilemapId = rom[TILEMAP_ID_BASE + mapId];
const ptrIndex = (tilemapId * 2) & 0xFF;
const ptrTableHi = (tilemapId & 0x80) ? 0x81 : 0x80;
const ptrTableRomBase = TILEMAP_PTR_BASE + ((ptrTableHi - 0x80) << 8);
const tmPtrLo = rom[ptrTableRomBase + ptrIndex];
const tmPtrHi = rom[ptrTableRomBase + ptrIndex + 1];
const nesAddrHi = (tmPtrHi & 0x1F) | 0x80;
const tmBank = 0x11 + (tmPtrHi >> 5);
const tmRomOffset = tmBank * 0x2000 + 0x10 + ((nesAddrHi << 8 | tmPtrLo) - 0x8000);

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

// ─── Helper: render a metatile at pixel position ───
function renderMetatile(pixels, pw, sx, sy, mid) {
  const m = mid < 128 ? mid : mid & 0x7F;
  const meta = metatiles[m];
  const palGroup = tileAttrs[m] & 0x03;
  const pal = palettes[palGroup];
  renderCHR(pixels, pw, sx,     sy,     chrTiles[meta.tl], pal);
  renderCHR(pixels, pw, sx + 8, sy,     chrTiles[meta.tr], pal);
  renderCHR(pixels, pw, sx,     sy + 8, chrTiles[meta.bl], pal);
  renderCHR(pixels, pw, sx + 8, sy + 8, chrTiles[meta.br], pal);
}

// ─── Helper: draw a filled rect ───
function fillRect(pixels, pw, rx, ry, rw, rh, color) {
  for (let dy = 0; dy < rh; dy++) {
    for (let dx = 0; dx < rw; dx++) {
      const di = ((ry + dy) * pw + (rx + dx)) * 3;
      pixels[di] = color[0]; pixels[di + 1] = color[1]; pixels[di + 2] = color[2];
    }
  }
}

// ─── Helper: blend color onto pixel buffer (50% alpha) ───
function blendRect(pixels, pw, rx, ry, rw, rh, color) {
  for (let dy = 0; dy < rh; dy++) {
    for (let dx = 0; dx < rw; dx++) {
      const di = ((ry + dy) * pw + (rx + dx)) * 3;
      pixels[di]     = (pixels[di]     + color[0]) >> 1;
      pixels[di + 1] = (pixels[di + 1] + color[1]) >> 1;
      pixels[di + 2] = (pixels[di + 2] + color[2]) >> 1;
    }
  }
}

// ─── Helper: get collision color for a metatile ───
function collisionColor(metaId) {
  const m = metaId < 128 ? metaId : metaId & 0x7F;
  if (m >= 128) return COL_PASSABLE;
  const cb1 = rom[collOff + m * 2];
  const cb2 = rom[collOff + m * 2 + 1];
  const z = cb1 & 0x07;
  if (cb1 & 0x80) {
    const tt = (cb2 >> 4) & 0x0F;
    const name = COLL_TRIG_TYPES[tt];
    if (name === 'exit_prev' || name === 'exit_world') return COL_TRIG_EXIT;
    if (name === 'entrance' || name === 'door' || name === 'locked_door') return COL_TRIG_ENTR;
    return COL_TRIG_MISC;
  }
  if (z === 3) return COL_WALL;
  if (z === 2) return COL_WATER;
  return COL_PASSABLE;
}

// ─── Output ───
mkdirSync(OUT_DIR, { recursive: true });
const prefix = `${OUT_DIR}/${mapId}`;
console.log('Writing:');

// IMAGE 1: Raw CHR tiles
{
  const cols = 16, rows = Math.ceil(chrTiles.length / cols);
  const w = cols * 8, h = rows * 8;
  const px = new Uint8Array(w * h * 3);
  const grayPal = [0x0F, 0x00, 0x10, 0x30];
  for (let i = 0; i < chrTiles.length; i++) {
    renderCHR(px, w, (i % cols) * 8, Math.floor(i / cols) * 8, chrTiles[i], grayPal);
  }
  writePPM(`${prefix}-chr.ppm`, w, h, px);
}

// IMAGE 2: All 128 metatiles
{
  const cols = 16, rows = 8, w = cols * 16, h = rows * 16;
  const px = new Uint8Array(w * h * 3);
  for (let m = 0; m < 128; m++) {
    renderMetatile(px, w, (m % cols) * 16, Math.floor(m / cols) * 16, m);
  }
  writePPM(`${prefix}-metatiles.ppm`, w, h, px);
}

// IMAGE 3: Full 32x32 map
{
  const w = 512, h = 512;
  const px = new Uint8Array(w * h * 3);
  for (let ty = 0; ty < 32; ty++) {
    for (let tx = 0; tx < 32; tx++) {
      renderMetatile(px, w, tx * 16, ty * 16, tilemap[ty * 32 + tx]);
    }
  }
  // Entrance marker: 5x5 red dot
  const ex = entranceX * 16 + 8, ey = entranceY * 16 + 8;
  fillRect(px, w, ex - 2, ey - 2, 5, 5, COL_ENTRANCE);
  writePPM(`${prefix}-map.ppm`, w, h, px);
}

// IMAGE 4: Collision overlay (solid blocks)
{
  const w = 512, h = 512;
  const px = new Uint8Array(w * h * 3);
  for (let ty = 0; ty < 32; ty++) {
    for (let tx = 0; tx < 32; tx++) {
      fillRect(px, w, tx * 16, ty * 16, 16, 16, collisionColor(tilemap[ty * 32 + tx]));
    }
  }
  // Entrance marker
  const ex = entranceX * 16 + 8, ey = entranceY * 16 + 8;
  fillRect(px, w, ex - 2, ey - 2, 5, 5, COL_ENTRANCE);
  writePPM(`${prefix}-collision.ppm`, w, h, px);
}

// IMAGE 5: Map + collision blend
{
  const w = 512, h = 512;
  const px = new Uint8Array(w * h * 3);
  for (let ty = 0; ty < 32; ty++) {
    for (let tx = 0; tx < 32; tx++) {
      const mid = tilemap[ty * 32 + tx];
      renderMetatile(px, w, tx * 16, ty * 16, mid);
      blendRect(px, w, tx * 16, ty * 16, 16, 16, collisionColor(mid));
    }
  }
  const ex = entranceX * 16 + 8, ey = entranceY * 16 + 8;
  fillRect(px, w, ex - 2, ey - 2, 5, 5, COL_ENTRANCE);
  writePPM(`${prefix}-overlay.ppm`, w, h, px);
}

console.log('\nLegend (collision/overlay):');
console.log('  Green   = passable (z≤2)');
console.log('  Red     = wall (z=3)');
console.log('  Blue    = water (z=2)');
console.log('  Magenta = exit_prev / exit_world');
console.log('  Cyan    = entrance / door');
console.log('  Yellow  = event / other trigger');
console.log('  Bright red dot = entrance position');
