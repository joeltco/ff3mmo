#!/usr/bin/env node
// npc-sheet-ff2.mjs — FF2's NPC sprites, drawn, one cell per placed OBJECT TYPE.
//
// Each cell shows the four animation frames, the sprite entry, the line the
// type gives, and every map that places it.
//
//   node tools/npc-sheet-ff2.mjs           -> docs/sprites/ff2-npc-sheet.png
//   node tools/npc-sheet-ff2.mjs --named   # only the ones that name a speaker
//
// Resolution comes from `tools/lib/ff2-text.mjs`:
//   sprite = SPRITE_BASE + SPRITE_TABLE[objType] * 0x100   (table @ 0xD10)
//   line   = stringIdForType() — record[0] via the pointer at 0x38210 + type*2
//
// ⛔ THE LINE IS THE DEFAULT ONE. Each object type runs its own code handler
// (jump table at 0x39933) which swaps in a different byte of the 24-byte record
// once story flags are set, so a late-game player sees something else. Only the
// no-flags line can be resolved statically.
//
// ⛔ v1.8.26-1.8.30 labelled this sheet under `dialogueId == objType`, which was
// RETRACTED in v1.8.31 — it put "Hilda" on ten visibly different sprites and
// gave lines to types whose "speaker" was a pendant or an airship. If this sheet
// ever looks like that again, the rule has regressed. The gate counts it.
//
// ⛔ The four-frame layout is the standard 16x16 one; an entry that is not a
// person (a vehicle, a large creature) renders as its raw tiles.

import fs from 'node:fs';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

// Without this every kana draws as a tofu box — @napi-rs/canvas' default
// sans-serif has no CJK coverage. Registering is not optional here.
const CJK = '/usr/share/fonts/noto-cjk/NotoSansCJK-Light.ttc';
if (!fs.existsSync(CJK)) {
  console.error(`no CJK font at ${CJK} — kana would render as boxes. Install noto-fonts-cjk.`);
  process.exit(1);
}
GlobalFonts.registerFromPath(CJK, 'NotoCJK');

globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.document = { createElement: () => createCanvas(8, 8), getElementById: () => null, addEventListener() {} };

const { decodeTile, NES_SYSTEM_PALETTE } = await import('../src/tile-decoder.js');
const F2 = await import('./lib/ff2-text.mjs');
const { romajiName, romaji } = await import('./lib/romaji.mjs');

const rom = F2.loadRom();
const NAMED_ONLY = process.argv.includes('--named');

const types = new Map();
for (const { base, maps } of F2.MAPOBJ_BLOCKS) {
  for (let m = 0; m < maps; m++) {
    for (const o of F2.mapObjects(rom, base, m)) {
      if (!types.has(o.type)) {
        const sid = F2.stringIdForType(rom, o.type);
        types.set(o.type, {
          type: o.type,
          sprite: F2.spriteEntryForType(rom, o.type),
          off: F2.spriteOffsetForType(rom, o.type),
          text: sid ? F2.lineForType(rom, o.type, { nl: ' ' }) : '',
          name: F2.speakerForType(rom, o.type),
          maps: new Set(), n: 0,
        });
      }
      const e = types.get(o.type);
      e.maps.add(`${base.toString(16)}/${m}`); e.n++;
    }
  }
}
let cells = [...types.values()].sort((a, b) => a.type - b.type);
if (NAMED_ONLY) cells = cells.filter(c => c.name);

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
const CH = CELL + 62;   // ids, the reading, the kana itself, placements
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
g.fillText(`FF2 NPCs — ${cells.length} placed object types, sprite + the DEFAULT line each gives`, 12, 12);
g.font = '10px sans-serif'; g.fillStyle = '#c9cede';
g.fillText('palette is a fixed legible one, not the per-map palette; the line is the no-flag default', 12, 26);

cells.forEach((c, i) => {
  const cx = 12 + (i % COLS) * CW;
  const cy = 52 + Math.floor(i / COLS) * CH;
  if (c.off !== null) for (let f = 0; f < FRAMES; f++) drawFrame(g, cx + f * CELL, cy, c.off + f * 0x40);

  g.font = 'bold 11px sans-serif';
  g.fillStyle = '#20242e';
  g.fillText(`type ${c.type}   spr ${c.sprite}`, cx, cy + CELL + 3);

  // the readable line — transliterated, so the sheet can be scanned at a glance
  const kana = c.text.replace(/\{[0-9a-f]{1,2}\}/g, '');
  g.font = c.name ? 'bold 12px sans-serif' : '10px sans-serif';
  g.fillStyle = c.name ? '#ffd35c' : '#1b1e26';
  g.fillText(c.name ? `« ${romajiName(c.name)} »`
    : kana ? `"${romaji(kana).slice(0, 30)}"` : '(no handler)', cx, cy + CELL + 17);

  // ...and the bytes the ROM actually holds, which is what gets checked
  g.font = c.name ? '12px NotoCJK' : '10px NotoCJK';
  g.fillStyle = c.name ? '#fff2c4' : '#242833';
  g.fillText(c.name ? c.name : kana.slice(0, 16), cx, cy + CELL + 31);

  g.font = '9px sans-serif';
  g.fillStyle = '#2b3040';
  g.fillText(`0x${c.off.toString(16)}  maps ${[...c.maps].slice(0, 3).join(' ')}  x${c.n}`,
    cx, cy + CELL + 47);
});

fs.mkdirSync(new URL('../docs/sprites/', import.meta.url), { recursive: true });
const OUT = new URL(`../docs/sprites/ff2-npc-sheet${NAMED_ONLY ? '-named' : ''}.png`, import.meta.url).pathname;
fs.writeFileSync(OUT, cv.toBuffer('image/png'));
console.log(`${cells.length} types (${cells.filter(c => c.name).length} name a speaker) -> ${OUT}`);
