#!/usr/bin/env node
// npc-palette-shot.mjs — draw a map's placed NPCs the way the GAME draws them,
// next to the way the ROM says that map colours people.
//
// `check-npc-placement.mjs` proves an NPC is in the right room on a bundle the
// map loads. It says nothing about COLOUR, which is how the elder's house
// shipped with the inn's palette on everyone in it: `data/town-npcs.js` builds
// every interior NPC through one `interior()` helper that hard-codes INN_SP2 /
// INN_SP3, under a comment claiming "each map's own SP2/SP3 are the same values
// for Ur's buildings". The ROM disagrees for maps 4, 6 and 7.
//
// Left swatch = the palette the spec carries (what the player sees).
// Right swatch = the map's own sprite palettes, read from the ROM.
//
//   node tools/npc-palette-shot.mjs 7 out.png
//   node tools/npc-palette-shot.mjs 6 out.png --scale 5

import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.document = { createElement: () => createCanvas(8, 8), getElementById: () => null, addEventListener() {} };

const args = process.argv.slice(2);
const mapId = parseInt(args[0], 10);
const out = args[1] || `npc-pal-${mapId}.png`;
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const SC = Math.max(1, parseInt(flag('scale', '4'), 10));

const { loadMap } = await import('../src/map-loader.js');
const { TOWN_NPCS } = await import('../src/data/town-npcs.js');
const { decodeTile, NES_SYSTEM_PALETTE } = await import('../src/tile-decoder.js');
// The REAL repaint the game applies at placement time — imported, never
// re-implemented here. A tool that disagrees with the game is worse than no
// tool, and this one exists to settle a colour question.
const { mapPalettesForSpec } = await import('../src/data/npc-palette.js');

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));
const md = loadMap(rom, mapId);
const list = TOWN_NPCS.get(mapId) || [];
if (!list.length) { console.error(`no placed NPCs on map ${mapId}`); process.exit(2); }

// The map's own sprite palettes. Index 0 is the shared backdrop slot — the
// sprite renderer treats index 0 as transparent, so a difference there is not
// a visible difference and is reported separately from a real one.
const romPals = (md.spritePalettes || []).map(p => p.slice());
const romSp2 = romPals[0] || [];
const romSp3 = romPals[1] || [];

const rgb = (v) => NES_SYSTEM_PALETTE[v & 0x3F] || [0, 0, 0];

// A walk bundle is 16 tiles of 16 bytes; the down-facing standing pose is the
// first 2x2 block. Head tiles take the TOP palette, body tiles the BOTTOM —
// FF3 splits them, which is why townsfolk read tan-faced in a blue tunic.
function drawNpc(g, ox, oy, romOffset, palTop, palBtm) {
  const quads = [[0, 0, palTop], [1, 0, palTop], [0, 1, palBtm], [1, 1, palBtm]];
  for (const [tx, ty, pal] of quads) {
    const tileIdx = ty * 2 + tx;
    const px = decodeTile(rom, romOffset + tileIdx * 16);
    const img = g.createImageData(8 * SC, 8 * SC);
    for (let y = 0; y < 8 * SC; y++) {
      for (let x = 0; x < 8 * SC; x++) {
        const ci = px[Math.floor(y / SC) * 8 + Math.floor(x / SC)];
        const i = (y * 8 * SC + x) * 4;
        if (ci === 0) { img.data[i + 3] = 0; continue; }   // index 0 = transparent
        const [r, gg, b] = rgb(pal[ci]);
        img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, ox + tx * 8 * SC, oy + ty * 8 * SC);
  }
}

const CELL = 16 * SC, GAP = 12, LBL = 34;
const cv = createCanvas(list.length * (CELL * 2 + GAP * 2) + GAP, CELL + LBL + 24);
const g = cv.getContext('2d');
g.imageSmoothingEnabled = false;
g.fillStyle = '#101018'; g.fillRect(0, 0, cv.width, cv.height);
g.font = '11px sans-serif'; g.textBaseline = 'top';

let x = GAP;
const diffs = [];
for (const n of list) {
  const spec = n.spec;
  g.fillStyle = '#ddd';
  g.fillText(n.key.replace(/^ur_/, ''), x, 4);
  // AS SHIPPED
  drawNpc(g, x, 20, spec.romOffset, spec.palTop, spec.palBtm);
  g.fillStyle = '#888';
  g.fillText('spec', x, 20 + CELL + 2);
  // AS PLACED — run through the game's own repaint.
  const placed = mapPalettesForSpec(spec, md);
  drawNpc(g, x + CELL + GAP, 20, spec.romOffset, placed.palTop, placed.palBtm);
  g.fillStyle = '#8f8';
  g.fillText('placed', x + CELL + GAP, 20 + CELL + 2);

  // Slots 1..3 are the visible ones; slot 0 is the transparent index.
  const topOff = [1, 2, 3].some(i => placed.palTop[i] !== romSp3[i]);
  const btmOff = [1, 2, 3].some(i => placed.palBtm[i] !== romSp2[i]);
  if (topOff || btmOff) {
    diffs.push(`${n.key}: ${topOff ? 'HEAD' : ''}${topOff && btmOff ? '+' : ''}${btmOff ? 'BODY' : ''}`);
  }
  x += CELL * 2 + GAP * 2;
}

fs.writeFileSync(out, cv.toBuffer('image/png'));
const hex = (a) => '[' + a.map(v => '0x' + v.toString(16).padStart(2, '0')).join(',') + ']';
console.log(`map ${mapId}: ROM SP2(body) ${hex(romSp2)}  SP3(head) ${hex(romSp3)}`);
for (const n of list) {
  const pl = mapPalettesForSpec(n.spec, md);
  const same = [1, 2, 3].every(i => pl.palTop[i] === n.spec.palTop[i] && pl.palBtm[i] === n.spec.palBtm[i]);
  console.log(`  ${n.key.padEnd(22)} spec head ${hex(n.spec.palTop)} body ${hex(n.spec.palBtm)}` +
              (same ? '   (unchanged)' : `\n  ${' '.repeat(22)} PLACED    head ${hex(pl.palTop)} body ${hex(pl.palBtm)}`));
}
console.log(diffs.length ? `MISMATCH after placement: ${diffs.join(', ')}` : 'every placed NPC matches its map palettes');
console.log('wrote ' + out);
