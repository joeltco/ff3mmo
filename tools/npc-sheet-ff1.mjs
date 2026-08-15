#!/usr/bin/env node
// npc-sheet-ff1.mjs — FF1's NPCs, drawn, with the name each one gives.
//
// One cell per OBJECT TYPE that a map actually places. Each shows the four
// animation frames, the sprite entry it resolves to, and a label taken from
// what the NPC says — so the sheet answers "who is this" rather than "which
// hex offset is this".
//
//   node tools/npc-sheet-ff1.mjs          -> docs/sprites/ff1-npc-sheet.png
//   node tools/npc-sheet-ff1.mjs --named  # only the ones that name themselves
//
// Resolution comes from `tools/lib/ff1-text.mjs`:
//   sprite  = 0xA210 + SPRITE_TABLE[objType] * 0x100   (table @ 0x2E10)
//   line    = byte 1 of the four-byte record @ 0x395E5 + objType*4
//
// ⛔ A LABEL IS NOT A NAME. Only "I am X" / "My name is X" gives a real name;
// everything else is a truncated quote, shown in quotes so it cannot be
// mistaken for one. FF1 writes ellipsis as "::", so a "Name:" rule would
// invent a character called "Oh" out of "Oh:: My sister::".

import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.document = { createElement: () => createCanvas(8, 8), getElementById: () => null, addEventListener() {} };

const { decodeTile, NES_SYSTEM_PALETTE } = await import('../src/tile-decoder.js');
const { loadRom, decodeString, mapObjects } = await import('./lib/ff1-text.mjs');

const rom = loadRom();
const NAMED_ONLY = process.argv.includes('--named');

/** A real name, or null. See the header. */
function selfName(t) {
  const m = /^I am ([A-Z][A-Za-z]+)|^My name is ([A-Z][A-Za-z]+)|^I,? ([A-Z][A-Za-z]+),/.exec(t);
  return m ? (m[1] || m[2] || m[3]) : null;
}

// gather every placed type once, with where it stands
const types = new Map();
for (let mapId = 0; mapId < 64; mapId++) {
  for (const o of mapObjects(rom, mapId)) {
    if (!types.has(o.type)) {
      const text = decodeString(rom, o.dialogueId, { nl: ' ' });
      types.set(o.type, {
        type: o.type, sprite: o.sprite, off: o.spriteOffset,
        dialogueId: o.dialogueId, text, name: selfName(text), maps: new Set(), n: 0,
      });
    }
    const e = types.get(o.type); e.maps.add(mapId); e.n++;
  }
}
let cells = [...types.values()].sort((a, b) => a.type - b.type);
if (NAMED_ONLY) cells = cells.filter(c => c.name);

// FF1 sprites are black outline + one colour + a pale fill, so they need a
// light ground to read; on the usual dark sheet the outlines vanish.
// MEASURED off the PPU (tools/nes12-npc-palette.mjs): an NPC's TOP half draws
// on sprite palette 2 and its BOTTOM half on sprite palette 3 — confirmed in
// code, not inferred. The player uses palettes 0/1, which is why a single flat
// palette looked plausible for so long.
// ⛔ These are the values measured in town/castle context. FF1's palette data is
// per-map (pointer = $A000 + X*0x100 + mapId*16, 48 bytes -> RAM $0780 -> $03C0
// -> PPU every frame) but where X comes from is NOT yet decoded, so these cannot
// be resolved per map the way FF3's are.
const PAL_TOP = [0x0F, 0x0F, 0x27, 0x36];    // sprite palette 2
const PAL_BTM = [0x0F, 0x0F, 0x16, 0x36];    // sprite palette 3
const rgb = (v) => NES_SYSTEM_PALETTE[v & 0x3F] || [0, 0, 0];
const SC = 3, FRAMES = 4;

function drawFrame(g, ox, oy, base) {
  // MEASURED from OAM: 4 consecutive tiles drawn TL, TR, BL, BR.
  [[0, 0], [1, 0], [0, 1], [1, 1]].forEach(([tx, ty], k) => {
    let px; try { px = decodeTile(rom, base + k * 16); } catch { return; }
    const img = g.createImageData(8 * SC, 8 * SC);
    for (let y = 0; y < 8 * SC; y++) {
      for (let x = 0; x < 8 * SC; x++) {
        const ci = px[Math.floor(y / SC) * 8 + Math.floor(x / SC)];
        const i = (y * 8 * SC + x) * 4;
        if (ci === 0) { img.data[i + 3] = 0; continue; }
        const [r, gg, b] = rgb((ty === 0 ? PAL_TOP : PAL_BTM)[ci]);
        img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, ox + tx * 8 * SC, oy + ty * 8 * SC);
  });
}

const CELL = 16 * SC;
const CW = CELL * FRAMES + 18;
const CH = CELL + 48;
const COLS = 5;
const ROWS = Math.ceil(cells.length / COLS);
const cv = createCanvas(COLS * CW + 14, ROWS * CH + 58);
const g = cv.getContext('2d');
g.imageSmoothingEnabled = false;
g.fillStyle = '#5a6072';
g.fillRect(0, 0, cv.width, cv.height);
g.textBaseline = 'top';
g.font = 'bold 14px sans-serif';
g.fillStyle = '#ffe9a8';
g.fillText(`FF1 NPCs — ${cells.length} object types, sprite + the line each one gives`, 12, 12);
g.font = '10px sans-serif'; g.fillStyle = '#c9cede';
g.fillText('NPC colours: top half = sprite palette 2, bottom = palette 3 (measured). Per-map variation is NOT decoded for this game.', 12, 26);

cells.forEach((c, i) => {
  const cx = 12 + (i % COLS) * CW;
  const cy = 52 + Math.floor(i / COLS) * CH;
  for (let f = 0; f < FRAMES; f++) drawFrame(g, cx + f * CELL, cy, c.off + f * 0x40);

  g.font = 'bold 11px sans-serif';
  g.fillStyle = c.name ? '#fff2c4' : '#20242e';
  g.fillText(`type ${c.type}  spr ${c.sprite}`, cx, cy + CELL + 3);

  g.font = c.name ? 'bold 12px sans-serif' : '10px sans-serif';
  g.fillStyle = c.name ? '#ffd35c' : '#1b1e26';
  const label = c.name ? `« ${c.name} »` : `"${c.text.slice(0, 30)}"`;
  g.fillText(label, cx, cy + CELL + 17);

  g.font = '9px sans-serif';
  g.fillStyle = '#2b3040';
  g.fillText(`maps ${[...c.maps].slice(0, 5).join(',')}  x${c.n}`, cx, cy + CELL + 33);
});

fs.mkdirSync(new URL('../docs/sprites/', import.meta.url), { recursive: true });
const OUT = new URL(`../docs/sprites/ff1-npc-sheet${NAMED_ONLY ? '-named' : ''}.png`, import.meta.url).pathname;
fs.writeFileSync(OUT, cv.toBuffer('image/png'));
console.log(`${cells.length} types (${cells.filter(c => c.name).length} name themselves) -> ${OUT}`);
