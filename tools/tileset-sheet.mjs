#!/usr/bin/env node
// tileset-sheet.mjs — every metatile a map can draw, labelled with its id.
//
// `map-png.mjs` shows what a map DOES draw. When you need to CHANGE a tile —
// swap a shop sign, pick a floor, find the other variant of something — the
// question is what the tileset HAS, and there was no way to see that. Picking a
// metatile id out of the tilemap and hoping is the same blind guess as picking
// a sprite bundle off a list of hex offsets.
//
//   node tools/tileset-sheet.mjs 10 out.png        # tileset used by map 10
//
// Palettes are the MAP's, so a tile looks here exactly as it does in that town.
// A metatile drawn under four different attribute palettes appears four times,
// once per palette, because the same id genuinely looks different per attr.
import fs from 'node:fs';
import zlib from 'node:zlib';

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));
const { loadMap, parseMapProperties } = await import('../src/map-loader.js');
const { NES_SYSTEM_PALETTE } = await import('../src/tile-decoder.js');

const mapId = parseInt(process.argv[2], 10);
const outPath = process.argv[3] || `tileset-${mapId}.png`;
const md = loadMap(rom, mapId);
const props = parseMapProperties(rom, mapId);

const COLS = 16, TILE = 16, SCALE = 4, PAD = 14;
const CELL = TILE * SCALE;
const rows = Math.ceil(128 / COLS);
const pxW = COLS * (CELL + PAD), pxH = rows * (CELL + PAD) + 8;
const rgb = new Uint8Array(pxW * pxH * 3).fill(24);
const px = (x, y, c) => {
  if (x < 0 || x >= pxW || y < 0 || y >= pxH) return;
  const i = (y * pxW + x) * 3;
  rgb[i] = c[0]; rgb[i + 1] = c[1]; rgb[i + 2] = c[2];
};

// 3x5 digit font so each cell can carry its own id — a sheet you cannot read
// ids off is a sheet you cannot pick from.
const FONT = {
  '0': ['111','101','101','101','111'], '1': ['010','110','010','010','111'],
  '2': ['111','001','111','100','111'], '3': ['111','001','111','001','111'],
  '4': ['101','101','111','001','001'], '5': ['111','100','111','001','111'],
  '6': ['111','100','111','101','111'], '7': ['111','001','010','010','010'],
  '8': ['111','101','111','101','111'], '9': ['111','101','111','001','111'],
  'a': ['111','101','111','101','101'], 'b': ['110','101','110','101','110'],
  'c': ['111','100','100','100','111'], 'd': ['110','101','101','101','110'],
  'e': ['111','100','111','100','111'], 'f': ['111','100','111','100','100'],
  'x': ['000','101','010','101','000'], '$': ['010','111','110','011','111'],
};
function text(s, ox, oy, c) {
  let cx = ox;
  for (const ch of s) {
    const g = FONT[ch]; if (!g) { cx += 4; continue; }
    for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) if (g[y][x] === '1') px(cx + x, oy + y, c);
    cx += 4;
  }
}

const { metatiles, chrTiles, palettes, tileAttrs } = md;
const offsets = [[0, 0], [8, 0], [0, 8], [8, 8]];
let drawn = 0;
for (let m = 0; m < 128; m++) {
  const meta = metatiles[m];
  const col = m % COLS, row = Math.floor(m / COLS);
  const ox = col * (CELL + PAD) + 4, oy = row * (CELL + PAD) + 4;
  if (!meta) { text('$' + m.toString(16), ox, oy + CELL + 3, [70, 70, 80]); continue; }
  drawn++;
  const pal = palettes[tileAttrs[m] & 0x03] || palettes[0];
  const rgbPal = pal.map(n => NES_SYSTEM_PALETTE[n & 0x3F] || [0, 0, 0]);
  const chrIdx = [meta.tl, meta.tr, meta.bl, meta.br];
  for (let q = 0; q < 4; q++) {
    const tile = chrTiles[chrIdx[q]];
    if (!tile) continue;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const c = rgbPal[tile[y * 8 + x]] || [0, 0, 0];
      for (let sy = 0; sy < SCALE; sy++) for (let sx = 0; sx < SCALE; sx++) {
        px(ox + (offsets[q][0] + x) * SCALE + sx, oy + (offsets[q][1] + y) * SCALE + sy, c);
      }
    }
  }
  text('$' + m.toString(16), ox, oy + CELL + 3, [200, 210, 120]);
}

// PNG encode (truecolor, one filter byte per row)
const raw = Buffer.alloc((pxW * 3 + 1) * pxH);
for (let y = 0; y < pxH; y++) {
  raw[y * (pxW * 3 + 1)] = 0;
  Buffer.from(rgb.buffer, y * pxW * 3, pxW * 3).copy(raw, y * (pxW * 3 + 1) + 1);
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(td) >>> 0 : crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
};
function crc32(buf) {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
  return ~c;
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(pxW, 0); ihdr.writeUInt32BE(pxH, 4);
ihdr[8] = 8; ihdr[9] = 2;
fs.writeFileSync(outPath, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
]));
console.log(`map ${mapId} (tileset ${props.tileset}): ${drawn} metatiles -> ${outPath}`);
