#!/usr/bin/env node
// sara-shot.mjs — draw Princess Sara through the GAME's own Sprite class.
//
// ⭐ HER BUNDLE IS `0x1D810`. Joel, 2026-08-28: *"0x1D810 is sara"* — after
// looking at a sheet of all 32 walk bundles and saying, correctly, that none of
// the ones I had put in front of him was her.
//
// ⛔ SHE USED TO WEAR `0x1D810`'s NEIGHBOUR, `0x1D910` — WHICH IS CID. Byte for
// byte the same bundle as `CID.romOffset`. The source justified it with "Cid is
// in the pub (map 12); she is out in the town (map 10) — never on screen
// together", and that premise died when she moved to the Cave of Seals. Joel
// looked at a render of "Sara" and said *"thats not sara. thats cid"*.
//
// ⛔ NOT a hand-drawn sprite and not a hand-copied tile list: this walks the
// real `Sprite` class, so the frame layout, the flips and the walk cycle are
// the game's, not a description of them.
//
//   node tools/sara-shot.mjs [--maps 2001,24,29]
import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
// Sprite.draw() calls document.createElement('canvas') — a TAG NAME, not a size.
globalThis.document = { createElement: () => createCanvas(16, 16), addEventListener() {} };
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };

const { loadMap } = await import('../src/map-loader.js');
const { NES_SYSTEM_PALETTE } = await import('../src/tile-decoder.js');
const { Sprite, DIR_DOWN, DIR_UP, DIR_LEFT, DIR_RIGHT } = await import('../src/sprite.js');
const { mapPalettesForSpec } = await import('../src/data/npc-palette.js');
const { SARA, CID } = await import('../src/data/town-npcs.js');

const rom = new Uint8Array(fs.readFileSync(new URL('../FF3-English.nes', import.meta.url).pathname));
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const MAPS = arg('maps', '2001,24,29').split(',').map(Number);
const DIRS = [[DIR_DOWN, 'down'], [DIR_UP, 'up'], [DIR_LEFT, 'left'], [DIR_RIGHT, 'right']];
const Z = 5, CELL = 16 * Z + 8;

// The cave floor is generated; borrow the palette from the map its donor uses.
const paletteOf = (m) => { try { return loadMap(rom, m === 2001 ? 115 : m); } catch { return null; } };

const ROWS = [
  { label: 'SARA  0x1D810  (Joel: "0x1D810 is sara")', spec: { ...SARA, romOffset: 0x1D810 } },
  { label: 'was:  0x1D910  — this is CID', spec: { ...SARA, romOffset: 0x1D910 }, bad: true },
  { label: 'CID   0x1D910  (for comparison)', spec: CID, bad: true },
];

const cv = createCanvas(140 + MAPS.length * (CELL * 4 + 24), ROWS.length * (CELL + 34) + 40);
const g = cv.getContext('2d');
g.imageSmoothingEnabled = false;
g.fillStyle = '#101018'; g.fillRect(0, 0, cv.width, cv.height);
g.font = 'bold 13px monospace'; g.fillStyle = '#e8e8f0';
g.fillText('Princess Sara — the real Sprite class, all four directions, per-map palettes', 12, 20);

MAPS.forEach((m, mi) => {
  g.font = 'bold 11px monospace'; g.fillStyle = '#ffd77a';
  const name = m === 2001 ? 'Cave of Seals' : m === 24 ? 'spring room' : `map ${m}`;
  g.fillText(`map ${m} — ${name}`, 140 + mi * (CELL * 4 + 24), 36);
});

ROWS.forEach((row, ri) => {
  const y = 46 + ri * (CELL + 34);
  g.font = 'bold 11px monospace'; g.fillStyle = row.bad ? '#ff8080' : '#9fe8a0';
  g.fillText(row.label, 12, y + 16);
  MAPS.forEach((m, mi) => {
    const md = paletteOf(m);
    const spec = md ? mapPalettesForSpec(row.spec, md) : row.spec;
    DIRS.forEach(([d], di) => {
      const s = new Sprite(rom, spec.palTop, spec.palBtm);
      s.setPalette(spec.palTop, spec.palBtm);
      s.gfxBase = spec.romOffset;
      s.setDirection(d);
      s.resetFrame();
      const tmp = createCanvas(16, 16);
      const t = tmp.getContext('2d');
      s.draw(t, 0, 0);
      g.drawImage(tmp, 140 + mi * (CELL * 4 + 24) + di * CELL, y + 22, 16 * Z, 16 * Z);
    });
  });
});
g.font = '10px monospace'; g.fillStyle = '#8f8fa8';
g.fillText('directions left-to-right within each map: down, up, left, right', 140, cv.height - 10);
const out = new URL('../docs/sprites/sara-0x1D810.png', import.meta.url).pathname;
fs.writeFileSync(out, cv.toBuffer('image/png'));
console.log('wrote ' + out);
