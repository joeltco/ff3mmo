#!/usr/bin/env node
// map-png.mjs — render a map to a PNG so it can actually be LOOKED at.
//
// ASCII tells you the shape of a map; it cannot tell you what a tile depicts.
// A player reported "person in tree" in Ur and the tile under that NPC carries
// no priority bit and no special collision — the only way to settle whether it
// draws as a tree is to look at the pixels.
//
// Decodes metatiles straight from the ROM through the same tileset / CHR /
// palette path `MapRenderer` uses, so what lands in the PNG is what the game
// paints. Optionally overlays a grid, NPC markers and a highlight box.
//
//   node tools/map-png.mjs 114 out.png                 # whole map
//   node tools/map-png.mjs 114 out.png --scale 3       # 3x zoom
//   node tools/map-png.mjs 114 out.png --box 24,22,31,28   # outline a region
//   node tools/map-png.mjs 114 out.png --grid          # 16px tile grid

import fs from 'node:fs';
import zlib from 'node:zlib';

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));

const { loadMap } = await import('../src/map-loader.js');
const { NES_SYSTEM_PALETTE } = await import('../src/tile-decoder.js');

const args = process.argv.slice(2);
const mapId = parseInt(args[0], 10);
const outPath = args[1] || `map-${mapId}.png`;
const flag = (name, def) => { const i = args.indexOf('--' + name); return i < 0 ? def : args[i + 1]; };
const has = (name) => args.includes('--' + name);
const SCALE = Math.max(1, parseInt(flag('scale', '2'), 10));
const BOX = flag('box', null);

const md = loadMap(rom, mapId);
// `--live` applies the per-map tile overrides `src/map-loading.js` runs at load,
// so the render is what the GAME draws rather than the raw ROM tilemap. Without
// it, a shipped tile change is invisible to every map tool.
if (has('live') && mapId === 10) md.tilemap[24 * 32 + 14] = 0x67;  // Kazus black-magic sign
// `--passage` mirrors src/map-loading.js#_loadRegularMap (v1.7.950): closed
// passages open at load unless the map carries the torch opener at (8,16).
// Use it to see what the GAME draws, not just what the raw tilemap holds.
if (has('passage') && md.tilemap[16 * 32 + 8] !== 0x32) {
  for (let i = 0; i < md.tilemap.length; i++) {
    if (md.tilemap[i] === 0x5B) md.tilemap[i] = 0x5D;
    if (md.tilemap[i] === 0x5C) md.tilemap[i] = 0x5E;
  }
}
// `--mask` renders exactly what the game DRAWS: the visibility mask from the
// real MapRenderer, everything else left as void. Without it this tool shows
// the raw tilemap, which is NOT what the player sees.
let VISMASK = null;
if (has('mask')) {
  const _c = {
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4), width: w, height: h }),
    putImageData() {}, drawImage() {}, fillRect() {}, clearRect() {}, save() {}, restore() {},
    translate() {}, scale() {}, beginPath() {}, rect() {}, clip() {}, createPattern: () => ({}),
  };
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => _c }) };
  const { MapRenderer } = await import('../src/map-renderer.js');
  VISMASK = new MapRenderer(md, md.entranceX, md.entranceY)._visibleMask;
}

const W = 32, TILE = 16;
const pxW = W * TILE, pxH = W * TILE;

// RGB buffer at 1x, scaled at the end.
const rgb = new Uint8Array(pxW * pxH * 3);
function px(x, y, c) {
  if (x < 0 || x >= pxW || y < 0 || y >= pxH) return;
  const i = (y * pxW + x) * 3;
  rgb[i] = c[0]; rgb[i + 1] = c[1]; rgb[i + 2] = c[2];
}

// Same decode path MapRenderer uses: metatile -> 4 CHR tiles -> palette by attr.
const { metatiles, chrTiles, palettes, tileAttrs, tilemap } = md;
const offsets = [[0, 0], [8, 0], [0, 8], [8, 8]];
for (let ty = 0; ty < W; ty++) {
  for (let tx = 0; tx < W; tx++) {
    if (VISMASK && !VISMASK[ty * W + tx]) continue;   // outside the room
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
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          px(tx * TILE + offsets[q][0] + x, ty * TILE + offsets[q][1] + y, rgbPal[tile[y * 8 + x]] || [0, 0, 0]);
        }
      }
    }
  }
}

// Optional 16px grid, drawn dim so it doesn't hide art.
if (has('grid')) {
  for (let y = 0; y < pxH; y++) for (let x = 0; x < pxW; x++) {
    if (x % TILE === 0 || y % TILE === 0) {
      const i = (y * pxW + x) * 3;
      rgb[i] = (rgb[i] * 3 + 255) >> 2; rgb[i + 1] = (rgb[i + 1] * 3) >> 2; rgb[i + 2] = (rgb[i + 2] * 3) >> 2;
    }
  }
}

// Highlight box in tile coords: x0,y0,x1,y1
if (BOX) {
  const [x0, y0, x1, y1] = BOX.split(',').map(Number);
  const C = [255, 64, 64];
  for (let x = x0 * TILE; x < (x1 + 1) * TILE; x++) { px(x, y0 * TILE, C); px(x, (y1 + 1) * TILE - 1, C); }
  for (let y = y0 * TILE; y < (y1 + 1) * TILE; y++) { px(x0 * TILE, y, C); px((x1 + 1) * TILE - 1, y, C); }
}

// Scale up (nearest neighbour) so tile art is legible.
const outW = pxW * SCALE, outH = pxH * SCALE;
const out = new Uint8Array(outW * outH * 3);
for (let y = 0; y < outH; y++) {
  const sy = (y / SCALE) | 0;
  for (let x = 0; x < outW; x++) {
    const sx = (x / SCALE) | 0;
    const s = (sy * pxW + sx) * 3, d = (y * outW + x) * 3;
    out[d] = rgb[s]; out[d + 1] = rgb[s + 1]; out[d + 2] = rgb[s + 2];
  }
}

// ── PNG (truecolor RGB) — same encoder shape as tools/render-oam-dump.js ───
function crc32(buf) {
  if (!crc32.table) {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
    crc32.table = t;
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = crc32.table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
const stride = outW * 3;
const filtered = Buffer.alloc((stride + 1) * outH);
for (let y = 0; y < outH; y++) {
  filtered[y * (stride + 1)] = 0;
  Buffer.from(out.subarray(y * stride, y * stride + stride)).copy(filtered, y * (stride + 1) + 1);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(outW, 0); ihdr.writeUInt32BE(outH, 4);
ihdr[8] = 8; ihdr[9] = 2;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(filtered)), chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(outPath, png);
console.log(`map ${mapId} -> ${outPath}  (${outW}x${outH}, scale ${SCALE})`);
