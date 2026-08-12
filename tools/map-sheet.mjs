#!/usr/bin/env node
// map-sheet.mjs — render MANY maps into one contact sheet PNG.
//
// Built because asking which map looks wrong is not an option: I have the ROM
// and a renderer, so I render them ALL and look. Each cell is a whole 32x32 map
// at 1px/tile*SCALE with its id burned in, so a fragmented or corrupt map is
// obvious at a glance and I can then open that one full size with map-png.mjs.
//
//   node tools/map-sheet.mjs sheet.png                 # every play-area map
//   node tools/map-sheet.mjs sheet.png --ids 1,2,3     # specific maps
//   node tools/map-sheet.mjs sheet.png --all           # all 256 ids
//   node tools/map-sheet.mjs sheet.png --scale 2       # bigger cells

import fs from 'node:fs';
import zlib from 'node:zlib';

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));
const { loadMap } = await import('../src/map-loader.js');
const { NES_SYSTEM_PALETTE } = await import('../src/tile-decoder.js');

const args = process.argv.slice(2);
const outPath = args[0] || 'map-sheet.png';
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const has = (n) => args.includes('--' + n);
const SCALE = Math.max(1, parseInt(flag('scale', '3'), 10));   // px per TILE
const W = 32, CELL = W * SCALE;

// Default: the maps reachable on foot (see tools/map-audit.mjs --play).
const PLAY = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,25,26,27,28,29,30,
              44,45,46,47,50,52,53,54,101,102,111,112,113,114,115,122,123,147,148,160,163,164,
              165,166,168,170,174,175,176,177,178,179,182,183,186,187,188,189,190,191];
let ids = PLAY;
if (has('all')) { ids = []; for (let i = 0; i < 256; i++) ids.push(i); }
const idsFlag = flag('ids', null);
if (idsFlag) ids = idsFlag.split(',').map(Number);

const COLS = Math.ceil(Math.sqrt(ids.length));
const ROWS = Math.ceil(ids.length / COLS);
const LABEL = 8 * ((SCALE >= 3) ? 1 : 1);        // label strip height per cell
const outW = COLS * CELL, outH = ROWS * (CELL + LABEL);
const rgb = new Uint8Array(outW * outH * 3);

const px = (x, y, c) => {
  if (x < 0 || x >= outW || y < 0 || y >= outH) return;
  const i = (y * outW + x) * 3;
  rgb[i] = c[0]; rgb[i + 1] = c[1]; rgb[i + 2] = c[2];
};

// 3x5 digit font so each cell can carry its map id.
const DIGITS = {
  0: ['111','101','101','101','111'], 1: ['010','110','010','010','111'],
  2: ['111','001','111','100','111'], 3: ['111','001','111','001','111'],
  4: ['101','101','111','001','001'], 5: ['111','100','111','001','111'],
  6: ['111','100','111','101','111'], 7: ['111','001','001','001','001'],
  8: ['111','101','111','101','111'], 9: ['111','101','111','001','111'],
};
function drawId(id, ox, oy) {
  const s = String(id);
  for (let c = 0; c < s.length; c++) {
    const g = DIGITS[s[c]];
    for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) {
      if (g[y][x] === '1') { px(ox + c * 4 + x, oy + y, [255, 255, 0]); px(ox + c * 4 + x, oy + y + 1, [255, 255, 0]); }
    }
  }
}

const offsets = [[0, 0], [8, 0], [0, 8], [8, 8]];
let n = 0;
for (const id of ids) {
  const col = n % COLS, row = (n / COLS) | 0;
  const ox = col * CELL, oy = row * (CELL + LABEL) + LABEL;
  n++;
  let md;
  try { md = loadMap(rom, id); } catch { continue; }
  if (!md || !md.tilemap) continue;
  // Mirror the game's load-time passage opening (v1.7.950).
  if (md.tilemap[16 * 32 + 8] !== 0x32) {
    for (let i = 0; i < md.tilemap.length; i++) {
      if (md.tilemap[i] === 0x5B) md.tilemap[i] = 0x5D;
      if (md.tilemap[i] === 0x5C) md.tilemap[i] = 0x5E;
    }
  }
  drawId(id, ox + 1, oy - LABEL + 1);
  const { metatiles, chrTiles, palettes, tileAttrs, tilemap } = md;
  for (let ty = 0; ty < W; ty++) {
    for (let tx = 0; tx < W; tx++) {
      const raw = tilemap[ty * W + tx];
      const m = raw < 128 ? raw : raw & 0x7F;
      const meta = metatiles[m];
      if (!meta) continue;
      const pal = palettes[tileAttrs[m] & 0x03] || palettes[0];
      const rgbPal = pal.map(v => NES_SYSTEM_PALETTE[v & 0x3F] || [0, 0, 0]);
      // Average the metatile down to one colour per tile, then paint SCALE px.
      let r = 0, g = 0, b = 0, cnt = 0;
      const chrIdx = [meta.tl, meta.tr, meta.bl, meta.br];
      for (let q = 0; q < 4; q++) {
        const t = chrTiles[chrIdx[q]];
        if (!t) continue;
        for (let i = 0; i < 64; i += 4) {
          const c = rgbPal[t[i]] || [0, 0, 0];
          r += c[0]; g += c[1]; b += c[2]; cnt++;
        }
      }
      const col3 = cnt ? [r / cnt | 0, g / cnt | 0, b / cnt | 0] : [0, 0, 0];
      for (let dy = 0; dy < SCALE; dy++) for (let dx = 0; dx < SCALE; dx++) {
        px(ox + tx * SCALE + dx, oy + ty * SCALE + dy, col3);
      }
    }
  }
}

function crc32(buf) {
  if (!crc32.table) {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[i] = c >>> 0; }
    crc32.table = t;
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = crc32.table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
};
const stride = outW * 3;
const filtered = Buffer.alloc((stride + 1) * outH);
for (let y = 0; y < outH; y++) {
  filtered[y * (stride + 1)] = 0;
  Buffer.from(rgb.subarray(y * stride, y * stride + stride)).copy(filtered, y * (stride + 1) + 1);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(outW, 0); ihdr.writeUInt32BE(outH, 4);
ihdr[8] = 8; ihdr[9] = 2;
fs.writeFileSync(outPath, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(filtered)), chunk('IEND', Buffer.alloc(0)),
]));
console.log(`${ids.length} maps -> ${outPath} (${outW}x${outH}, ${COLS}x${ROWS} grid)`);
