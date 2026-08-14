#!/usr/bin/env node
// npc-sprite-catalog.mjs — a labelled contact sheet of EVERY NPC walk sprite.
//
// This exists because Kazus shipped with its shop keepers wearing the GHOST
// sprite. Bundles were chosen off "which ones does this map load into sprite
// memory", which says nothing about who they DEPICT, and not one of them was
// rendered before it went out. A sprite is a picture; picking one from a list
// of hex offsets is picking blind.
//
// So: draw them all, label them all, and pick from the sheet.
//
//   node tools/npc-sprite-catalog.mjs                    -> npc-catalog.png
//   node tools/npc-sprite-catalog.mjs --from 0x1C010 --to 0x1F010
//   node tools/npc-sprite-catalog.mjs --dirs             # all 4 facings each
//
// A walk bundle is 256 bytes = 16 tiles = four 2x2 poses (down, up, left,
// right). The sheet shows the DOWN pose by default, which is how an NPC stands
// when you walk up to them.
//
// ⛔ COLOURS HERE ARE INDICATIVE ONLY. Every NPC is repainted at placement time
// with the palette of the map it stands on (src/data/npc-palette.js), so the
// SHAPE is what this sheet is for. A bundle that reads as a ghost, a keeper or
// a townsman reads that way in any palette.

import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.document = { createElement: () => createCanvas(8, 8), getElementById: () => null, addEventListener() {} };

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const has = (n) => args.includes('--' + n);

const FROM = parseInt(flag('from', '0x1C010'), 16);
const TO = parseInt(flag('to', '0x1F010'), 16);
const SC = Math.max(1, parseInt(flag('scale', '3'), 10));
const OUT = flag('out', 'npc-catalog.png');
const ALL_DIRS = has('dirs');

const { decodeTile, NES_SYSTEM_PALETTE } = await import('../src/tile-decoder.js');
const { TOWN_NPCS } = await import('../src/data/town-npcs.js');

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));

// Who already uses each bundle, so a taken sprite is obvious and a free one can
// be picked on purpose rather than by collision.
const USED = new Map();
for (const [mapId, list] of TOWN_NPCS) {
  for (const e of list) {
    const off = e.spec && e.spec.romOffset;
    if (off == null) continue;
    if (!USED.has(off)) USED.set(off, []);
    USED.get(off).push(`${e.key}@${mapId}`);
  }
}

// Indicative palette — Ur's townsfolk pair. See the header note.
const PAL_TOP = [0x1A, 0x0F, 0x26, 0x36];   // head / hair
const PAL_BTM = [0x1A, 0x0F, 0x12, 0x36];   // body
const rgb = (v) => NES_SYSTEM_PALETTE[v & 0x3F] || [0, 0, 0];

// A pose is 4 tiles: top-left, top-right, bottom-left, bottom-right. The top
// row takes the head palette and the bottom the body one — FF3 splits them,
// which is why townsfolk read tan-faced in a blue tunic.
function drawPose(g, ox, oy, base) {
  for (const [tx, ty] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const idx = ty * 2 + tx;
    let px;
    try { px = decodeTile(rom, base + idx * 16); } catch { return false; }
    const pal = ty === 0 ? PAL_TOP : PAL_BTM;
    const img = g.createImageData(8 * SC, 8 * SC);
    for (let y = 0; y < 8 * SC; y++) {
      for (let x = 0; x < 8 * SC; x++) {
        const ci = px[Math.floor(y / SC) * 8 + Math.floor(x / SC)];
        const i = (y * 8 * SC + x) * 4;
        if (ci === 0) { img.data[i + 3] = 0; continue; }
        const [r, gg, b] = rgb(pal[ci]);
        img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, ox + tx * 8 * SC, oy + ty * 8 * SC);
  }
  return true;
}

// A bundle is blank when every tile is empty — those are gaps in the range, not
// people, and printing them as anonymous squares makes the sheet unreadable.
function isBlank(base) {
  for (let t = 0; t < 4; t++) {
    const px = decodeTile(rom, base + t * 16);
    for (const v of px) if (v !== 0) return false;
  }
  return true;
}

const bundles = [];
for (let off = FROM; off < TO; off += 0x100) {
  if (off + 0x100 > rom.length) break;
  if (isBlank(off)) continue;
  bundles.push(off);
}

const CELL = 16 * SC;
const POSES = ALL_DIRS ? 4 : 1;
const CW = CELL * POSES + 10;
const CH = CELL + 30;
const COLS = Math.max(1, Math.floor(1400 / CW));
const ROWS = Math.ceil(bundles.length / COLS);
const cv = createCanvas(COLS * CW + 10, ROWS * CH + 34);
const g = cv.getContext('2d');
g.imageSmoothingEnabled = false;
g.fillStyle = '#0e0e18';
g.fillRect(0, 0, cv.width, cv.height);
g.font = 'bold 13px sans-serif';
g.fillStyle = '#ddd';
g.textBaseline = 'top';
g.fillText(`FF3 NPC walk sprites  ${'0x' + FROM.toString(16).toUpperCase()}-${'0x' + TO.toString(16).toUpperCase()}` +
  `   ${bundles.length} bundles   (colours indicative — the MAP repaints every NPC)`, 8, 8);

bundles.forEach((off, i) => {
  const cx = 8 + (i % COLS) * CW;
  const cy = 30 + Math.floor(i / COLS) * CH;
  for (let d = 0; d < POSES; d++) drawPose(g, cx + d * CELL, cy, off + d * 64);
  const used = USED.get(off);
  g.font = '11px sans-serif';
  g.fillStyle = used ? '#ffd35c' : '#8a8a9a';
  g.fillText('0x' + off.toString(16).toUpperCase(), cx, cy + CELL + 2);
  if (used) {
    g.font = '9px sans-serif';
    g.fillStyle = '#ffd35c';
    g.fillText(used[0].slice(0, 18), cx, cy + CELL + 14);
  }
});

fs.writeFileSync(OUT, cv.toBuffer('image/png'));
console.log(`${bundles.length} non-blank bundles in ${'0x' + FROM.toString(16)}..${'0x' + TO.toString(16)}`);
console.log(`  ${USED.size} are already placed (gold labels)`);
console.log('wrote ' + OUT);
