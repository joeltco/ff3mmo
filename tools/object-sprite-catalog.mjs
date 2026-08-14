#!/usr/bin/env node
// object-sprite-catalog.mjs — the animated MAP OBJECTS, drawn and labelled.
//
// A map's NPC table holds more than people. High ids are objects: torches,
// candles, and — the reason this exists — the campfire in Kazus's south-west
// corner, which was missing because only walk-bundle townsfolk were ever
// placed. That corner's tilemap is bare grass; the fire is a SPRITE.
//
// `flame-sprites.js` already decodes two of these by hand:
//   id 193 (large torch)  file 0x14010
//   id 194 (small candle) file 0x14090
// 0x80 apart, each 8 tiles = two 16x16 frames. So id N sits at
// 0x14010 + (N - 193) * 0x80 — a hypothesis this sheet is here to TEST, by
// drawing the range and looking, rather than asserting an offset.
//
//   node tools/object-sprite-catalog.mjs                 -> object-catalog.png
//   node tools/object-sprite-catalog.mjs --from 180 --to 220
//
// Both animation frames are drawn side by side, so a two-frame flicker (which
// is what a fire is) is obvious next to a static object.

import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.document = { createElement: () => createCanvas(8, 8), getElementById: () => null, addEventListener() {} };

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };

const FROM = parseInt(flag('from', '180'), 10);
const TO = parseInt(flag('to', '215'), 10);
const SC = Math.max(1, parseInt(flag('scale', '4'), 10));
const OUT = flag('out', 'object-catalog.png');

const { decodeTile, NES_SYSTEM_PALETTE } = await import('../src/tile-decoder.js');
const { loadMap } = await import('../src/map-loader.js');

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));

// The anchors flame-sprites.js established by hand.
const ANCHOR_ID = 193;
const ANCHOR_OFF = 0x14010;
const STRIDE = 0x80;
const offsetFor = (id) => ANCHOR_OFF + (id - ANCHOR_ID) * STRIDE;

// Flame palette from flame-sprites.js: transparent, black, orange, white.
const PAL = [null, 0x0F, 0x27, 0x30];
const rgb = (v) => NES_SYSTEM_PALETTE[v & 0x3F] || [0, 0, 0];

// Which ids does any map actually place? An id nothing uses is a gap, and
// labelling the used ones says which are worth decoding.
const USED = new Map();
for (let mapId = 0; mapId < 256; mapId++) {
  let md;
  try { md = loadMap(rom, mapId); } catch { continue; }
  for (const n of md.npcs || []) {
    if (n.id < FROM || n.id > TO) continue;
    if (!USED.has(n.id)) USED.set(n.id, []);
    const a = USED.get(n.id);
    if (a.length < 4) a.push(`${mapId}@${n.x},${n.y}`);
  }
}

function drawFrame(g, ox, oy, base) {
  let any = false;
  for (const [tx, ty, t] of [[0, 0, 0], [1, 0, 1], [0, 1, 2], [1, 1, 3]]) {
    let px;
    try { px = decodeTile(rom, base + t * 16); } catch { return false; }
    const img = g.createImageData(8 * SC, 8 * SC);
    for (let y = 0; y < 8 * SC; y++) {
      for (let x = 0; x < 8 * SC; x++) {
        const ci = px[Math.floor(y / SC) * 8 + Math.floor(x / SC)];
        const i = (y * 8 * SC + x) * 4;
        if (ci === 0 || PAL[ci] == null) { img.data[i + 3] = 0; continue; }
        const [r, gg, b] = rgb(PAL[ci]);
        img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = 255;
        any = true;
      }
    }
    g.putImageData(img, ox + tx * 8 * SC, oy + ty * 8 * SC);
  }
  return any;
}

const ids = [];
for (let id = FROM; id <= TO; id++) ids.push(id);

const CELL = 16 * SC;
const CW = CELL * 2 + 14;
const CH = CELL + 32;
const COLS = Math.max(1, Math.floor(1500 / CW));
const ROWS = Math.ceil(ids.length / COLS);
const cv = createCanvas(COLS * CW + 10, ROWS * CH + 34);
const g = cv.getContext('2d');
g.imageSmoothingEnabled = false;
g.fillStyle = '#0e0e18'; g.fillRect(0, 0, cv.width, cv.height);
g.font = 'bold 13px sans-serif'; g.fillStyle = '#ddd'; g.textBaseline = 'top';
g.fillText(`FF3 map OBJECT sprites, ids ${FROM}-${TO}  (both frames)   ` +
  `offset = 0x14010 + (id-193)*0x80 — anchors 193 torch / 194 candle`, 8, 8);

ids.forEach((id, i) => {
  const cx = 8 + (i % COLS) * CW;
  const cy = 30 + Math.floor(i / COLS) * CH;
  const off = offsetFor(id);
  drawFrame(g, cx, cy, off);
  drawFrame(g, cx + CELL, cy, off + 4 * 16);
  const used = USED.get(id);
  g.font = '11px sans-serif';
  g.fillStyle = used ? '#ffd35c' : '#7a7a8a';
  g.fillText(`${id}  0x${off.toString(16).toUpperCase()}`, cx, cy + CELL + 2);
  if (used) {
    g.font = '9px sans-serif';
    g.fillText(used[0], cx, cy + CELL + 15);
  }
});

fs.writeFileSync(OUT, cv.toBuffer('image/png'));
console.log(`ids ${FROM}-${TO}; ${USED.size} of them are placed by some map`);
for (const [id, where] of [...USED].sort((a, b) => a[0] - b[0])) {
  console.log(`  id ${id}  0x${offsetFor(id).toString(16)}  used by ${where.join(' ')}`);
}
console.log('wrote ' + OUT);
