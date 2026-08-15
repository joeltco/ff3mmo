#!/usr/bin/env node
// npc-sheet-ff2.mjs — FF2's NPC sprites, drawn, one cell per placed OBJECT TYPE.
//
// Each cell shows the four animation frames, the sprite entry it resolves to,
// and every map that places it.
//
//   node tools/npc-sheet-ff2.mjs        -> docs/sprites/ff2-npc-sheet.png
//
// Resolution comes from `tools/lib/ff2-text.mjs`:
//   sprite = SPRITE_BASE + SPRITE_TABLE[objType] * 0x100   (table @ 0xD10)
// — measured by ROM-patch probe and verified 7/7 against a PPU trace of the
// Altair throne room.
//
// ⛔ THERE ARE NO NAMES ON THIS SHEET, and that is deliberate.
//
// v1.8.26-1.8.30 labelled it from `decodeLine(rom, objType)` under the rule
// `dialogueId == objType`. That rule is RETRACTED — `tools/ff2-talk-probe.mjs`
// measured Minwu (object type 8) displaying string 49, and object types 97/99
// read a different table (0x28010) altogether. Under the old rule this sheet
// labelled ten visibly different sprites "Hilda", and gave lines to types whose
// "speaker" was a pendant or an airship.
//
// Labelling these needs the real objType -> dialogue link, which is unsolved.
// Until it is, the sprite IS the honest content of this sheet.
//
// ⛔ The four-frame layout is the standard 16x16 one; an entry that is not a
// person (a vehicle, a large creature) renders as its raw tiles.

import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.document = { createElement: () => createCanvas(8, 8), getElementById: () => null, addEventListener() {} };

const { decodeTile, NES_SYSTEM_PALETTE } = await import('../src/tile-decoder.js');
const F2 = await import('./lib/ff2-text.mjs');

const rom = F2.loadRom();

const types = new Map();
for (const { base, maps } of F2.MAPOBJ_BLOCKS) {
  for (let m = 0; m < maps; m++) {
    for (const o of F2.mapObjects(rom, base, m)) {
      if (!types.has(o.type)) {
        types.set(o.type, {
          type: o.type,
          sprite: F2.spriteEntryForType(rom, o.type),
          off: F2.spriteOffsetForType(rom, o.type),
          maps: new Set(), n: 0,
        });
      }
      const e = types.get(o.type);
      e.maps.add(`${base.toString(16)}/${m}`); e.n++;
    }
  }
}
const cells = [...types.values()].sort((a, b) => a.type - b.type);

const PAL = [0x0F, 0x0F, 0x16, 0x36];
const rgb = (v) => NES_SYSTEM_PALETTE[v & 0x3F] || [0, 0, 0];
const SC = 3, FRAMES = 4;

function drawFrame(g, ox, oy, base) {
  [[0, 0], [1, 0], [0, 1], [1, 1]].forEach(([tx, ty], k) => {
    let px; try { px = decodeTile(rom, base + k * 16); } catch { return; }
    const img = g.createImageData(8 * SC, 8 * SC);
    for (let y = 0; y < 8 * SC; y++) {
      for (let x = 0; x < 8 * SC; x++) {
        const ci = px[Math.floor(y / SC) * 8 + Math.floor(x / SC)];
        const i = (y * 8 * SC + x) * 4;
        if (ci === 0) { img.data[i + 3] = 0; continue; }
        const [r, gg, b] = rgb(PAL[ci]);
        img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, ox + tx * 8 * SC, oy + ty * 8 * SC);
  });
}

const CELL = 16 * SC;
const CW = CELL * FRAMES + 18;
const CH = CELL + 34;   // two label lines: ids, and where it is placed
const COLS = 5;
const ROWS = Math.ceil(cells.length / COLS);
const cv = createCanvas(COLS * CW + 14, ROWS * CH + 44);
const g = cv.getContext('2d');
g.imageSmoothingEnabled = false;
g.fillStyle = '#5a6072';
g.fillRect(0, 0, cv.width, cv.height);
g.textBaseline = 'top';
g.font = 'bold 14px sans-serif';
g.fillStyle = '#ffe9a8';
g.fillText(`FF2 NPC sprites — ${cells.length} placed object types` +
           `   (no names: the objType -> dialogue link is unsolved)`, 12, 12);

cells.forEach((c, i) => {
  const cx = 12 + (i % COLS) * CW;
  const cy = 38 + Math.floor(i / COLS) * CH;
  if (c.off !== null) for (let f = 0; f < FRAMES; f++) drawFrame(g, cx + f * CELL, cy, c.off + f * 0x40);

  g.font = 'bold 11px sans-serif';
  g.fillStyle = '#20242e';
  g.fillText(`type ${c.type}   spr ${c.sprite}`, cx, cy + CELL + 3);

  g.font = '9px sans-serif';
  g.fillStyle = '#2b3040';
  g.fillText(`0x${c.off.toString(16)}   maps ${[...c.maps].slice(0, 3).join(' ')}  x${c.n}`,
    cx, cy + CELL + 18);
});

fs.mkdirSync(new URL('../docs/sprites/', import.meta.url), { recursive: true });
const OUT = new URL('../docs/sprites/ff2-npc-sheet.png', import.meta.url).pathname;
fs.writeFileSync(OUT, cv.toBuffer('image/png'));
console.log(`${cells.length} placed object types -> ${OUT}`);
