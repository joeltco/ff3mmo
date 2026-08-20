#!/usr/bin/env node
// floor-png.mjs — render a GENERATED dungeon floor to a PNG.
//
// `floor-view.mjs` prints the shape as ASCII; it cannot tell you what a tile
// depicts or whether the cave reads as a cave. `map-png.mjs` does that for ROM
// maps only. Comparing our generated floors against the real Altar Cave meant
// putting a PNG next to an ASCII grid, which is not a comparison — so this
// renders a generated floor through the SAME metatile -> CHR -> palette path
// `map-png.mjs` uses, and the two images can be looked at side by side.
//
//   node tools/floor-png.mjs <floor> <seed> out.png [--scale 2]
//   node tools/floor-png.mjs 3 1761000000000 /tmp/f3.png --scale 2

import fs from 'node:fs';
import zlib from 'node:zlib';

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));
const { generateFloor } = await import('../src/dungeon-generator.js');
const { NES_SYSTEM_PALETTE } = await import('../src/tile-decoder.js');

const args = process.argv.slice(2);
const floorIndex = parseInt(args[0], 10);
const seed = Number(args[1]);
const outPath = args[2] || `floor-${floorIndex}.png`;
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const SCALE = Math.max(1, parseInt(flag('scale', '2'), 10));

const md = generateFloor(rom, floorIndex, seed);
const W = 32, TILE = 16, pxW = W * TILE, pxH = W * TILE;
const rgb = new Uint8Array(pxW * pxH * 3);
const px = (x, y, c) => { if (x < 0 || x >= pxW || y < 0 || y >= pxH) return;
  const i = (y * pxW + x) * 3; rgb[i] = c[0]; rgb[i + 1] = c[1]; rgb[i + 2] = c[2]; };

const { metatiles, chrTiles, palettes, tileAttrs, tilemap } = md;
const offsets = [[0, 0], [8, 0], [0, 8], [8, 8]];
for (let ty = 0; ty < W; ty++) for (let tx = 0; tx < W; tx++) {
  const raw = tilemap[ty * W + tx];
  const m = raw < 128 ? raw : raw & 0x7F;
  const meta = metatiles[m];
  if (!meta) continue;
  const pal = palettes[tileAttrs[m] & 0x03] || palettes[0];
  const rgbPal = pal.map(n => NES_SYSTEM_PALETTE[n & 0x3F] || [0, 0, 0]);
  const chrIdx = [meta.tl, meta.tr, meta.bl, meta.br];
  for (let q = 0; q < 4; q++) {
    const tile = chrTiles[chrIdx[q]];
    if (!tile) continue;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++)
      px(tx * TILE + offsets[q][0] + x, ty * TILE + offsets[q][1] + y, rgbPal[tile[y * 8 + x]] || [0, 0, 0]);
  }
}

const outW = pxW * SCALE, outH = pxH * SCALE;
const out = new Uint8Array(outW * outH * 3);
for (let y = 0; y < outH; y++) { const sy = (y / SCALE) | 0;
  for (let x = 0; x < outW; x++) { const sx = (x / SCALE) | 0;
    const s = (sy * pxW + sx) * 3, d = (y * outW + x) * 3;
    out[d] = rgb[s]; out[d + 1] = rgb[s + 1]; out[d + 2] = rgb[s + 2]; } }

function crc32(buf) {
  if (!crc32.table) { const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
    crc32.table = t; }
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
for (let y = 0; y < outH; y++) { filtered[y * (stride + 1)] = 0;
  Buffer.from(out.subarray(y * stride, y * stride + stride)).copy(filtered, y * (stride + 1) + 1); }
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(outW, 0); ihdr.writeUInt32BE(outH, 4);
ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
fs.writeFileSync(outPath, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(filtered)), chunk('IEND', Buffer.alloc(0)),
]));
console.log(`floor ${floorIndex} seed ${seed} -> ${outPath} (${outW}x${outH}, entrance ${md.entranceX},${md.entranceY})`);
