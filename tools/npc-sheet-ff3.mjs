#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// ⛔⛔⛔  DO NOT HALF-ASS THE DATA PULL.  ⛔⛔⛔
//
// A ROM record has N FIELDS. If you use fewer than N, YOU HAVE NOT READ IT —
// you have guessed while holding the answer. This banner exists because that
// happened over and over in one day:
//
//   * FF3's NPC record is {id, x, y, FLAGS}. The flags byte was DISASSEMBLED
//     (bits 2-3 = FACING, bits 4-7 = MOVEMENT) and then DROPPED on the floor,
//     so ten Ur townsfolk shipped frozen in "random spots" facing wrong.
//   * Cid took THREE releases and Joel pointing at the tile — while
//     `npc-dump.mjs 12` had printed `id $2c @(6,23) ... DRAWN` the whole time.
//   * `$67` was called the "black magic sign" without checking its ATTRIBUTE
//     palette. It is the same star on pal1, the TREE/WOOD palette. Green
//     corners shipped.
//   * Characters were identified from `npcId + 0x202` instead of by RENDERING
//     THE SPRITE — which put Cid's line on the Castle Sasune gate guard.
//   * `check-shops` asked `findShopAtCounter` for the shop's OWN coords, so it
//     agreed with itself wherever the counter pointed.
//   * "0 of 28 bundles match" was a `+0x10` applied twice. SELF-TEST THE
//     INSTRUMENT BEFORE BELIEVING A NEGATIVE.
//
// BEFORE YOU SAY "DONE", ANSWER THIS OUT LOUD:
//   List every field/byte/column of the record you just read. Point at the line
//   of code that CONSUMES each one. If any field is unconsumed, you are NOT
//   done — wire it or say plainly which one you dropped and why.
//
// AND: RENDER IT AND LOOK. `map-png --grid --box`, `tileset-sheet.mjs`,
// `npc-sheet-ff3.mjs`, `npc-cast.cjs`. "The code looks right" is not a check.
// ═══════════════════════════════════════════════════════════════════════════
// npc-sheet-ff3.mjs — FF3's NPCs, drawn, with the name each one gives.
//
// One cell per NPC ID that a map actually places: the four facings, the sprite
// it resolves to, the line it gives, and where it stands. Same layout as
// `npc-sheet-ff1.mjs` and `npc-sheet-ff2.mjs` so the three read alike.
//
//   node tools/npc-sheet-ff3.mjs           -> docs/sprites/ff3-npc-sheet.png
//   node tools/npc-sheet-ff3.mjs --named   # only the ones that name themselves
//
// Resolution:
//   sprite = NPC_GFX_TABLE[npcId] @ ROM 0x1410  (18/18 PPU-verified)
//   line   = npcId + 0x202, into the string table at 0x030010
//
// ⛔ THE LINE IS THE DEFAULT ONE, and `+0x202` is a DESCRIPTION, not a
// derivation. `tools/ff3-talk-trace.mjs` showed the id is a per-NPC byte in RAM
// ($0740 + slot) that the engine REWRITES as a conversation advances, and that
// a second string block at 0x300 exists. `tools/ff3-talk-probe.mjs` measured
// 7 of 8 NPCs matching — the exception is Ur's NPC at (10,28) (npcId 5), which
// the rule sends to 0x207 while the running game shows 0x206.
//
// ⛔ A LABEL IS NOT A NAME. Only self-identification counts (`selfName` in
// lib/ff3-text.mjs). "Takka is the finest blacksmith around" is someone talking
// ABOUT Takka — that NPC is not Takka.
//
// COLOURS ARE PER-MAP, not per-NPC. MEASURED off the PPU by
// `tools/ff3-npc-palette.mjs`: every map NPC draws its TOP half on sprite
// palette 3 and its BOTTOM half on sprite palette 2, with no per-NPC selection.
// The map supplies both, via bytes 8/9 of its properties indexing the shared
// palette library at 0x1110/0x1210/0x1310 — 16/16 maps predicted exactly.
// An NPC placed on several maps is drawn in the colours of the FIRST one, which
// the cell names.

import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.document = { createElement: () => createCanvas(8, 8), getElementById: () => null, addEventListener() {} };

const { decodeTile, NES_SYSTEM_PALETTE } = await import('../src/tile-decoder.js');
const { loadRom, decodeString, selfName } = await import('./lib/ff3-text.mjs');
// ⛔ selfName() reads `npcId + 0x202`, which is NOT an identity. It put « Cid »
// on four different sprites and « Sara » + « Desch » on Cid's own bundle. Only
// CONFIRMED_SPRITE_NAMES is trustworthy; everything else renders as unverified.
const { confirmedName, depictsName } = await import('../src/data/sprite-names.js');
const { loadMap } = await import('../src/map-loader.js');
const G = await import('../src/data/npc-gfx.js');

const rom = loadRom();
const NAMED_ONLY = process.argv.includes('--named');
const NPC_DIALOGUE_BASE = 0x202;   // == npc-dialogue.mjs#NPC_DIALOGUE_BASE

const MAP_NAMES = new Map([
  [114, 'Ur'], [1, 'Ur secret2'], [2, 'Ur secret'], [3, 'Ur magic'], [4, 'Ur armor'],
  [5, 'Ur weapon'], [6, 'Ur elder1'], [7, 'Ur elder2'], [8, 'Ur inn'], [9, 'Ur tavern'],
  [10, 'Kazus'], [12, 'Kazus inn'], [15, 'Kazus magic'], [16, 'Kazus weapon'],
  [17, 'Kazus armor'], [18, 'Castle Sasune'],
]);

// every NPC id any map places, with where it stands
const placed = new Map();
for (let mapId = 0; mapId < 512; mapId++) {
  let md; try { md = loadMap(rom, mapId); } catch { continue; }
  for (const n of md.npcs || []) {
    if (!placed.has(n.id)) placed.set(n.id, []);
    placed.get(n.id).push({ mapId, x: n.x, y: n.y });
  }
}

const cellsAll = [];
for (const [id, spots] of [...placed].sort((a, b) => a[0] - b[0])) {
  const gfx = G.gfxForNpcId(rom, id);
  const kind = G.kindForGfx(gfx);
  if (kind === 'undrawn' || kind === 'object') continue;   // not people
  const text = decodeString(rom, id + NPC_DIALOGUE_BASE);
  cellsAll.push({
    id, gfx, off: G.offsetForGfx(gfx), text,
    name: selfName(text), confirmed: confirmedName(id), depicts: depictsName(G.offsetForGfx(gfx)), spots,
    palMap: spots[0].mapId,
    where: [...new Set(spots.map(s => s.mapId))]
      .map(m => MAP_NAMES.get(m) || `map ${m}`),
  });
}
const cells = NAMED_ONLY ? cellsAll.filter(c => c.confirmed) : cellsAll;

// MEASURED: top half = the map's spritePalette7, bottom half = spritePalette6.
// Cached per map so 179 cells do not reload 179 maps.
const palCache = new Map();
function palettesForMap(mapId) {
  if (!palCache.has(mapId)) {
    let sp;
    try { sp = loadMap(rom, mapId).spritePalettes; } catch { sp = null; }
    palCache.set(mapId, sp
      ? { top: sp[1], btm: sp[0] }
      : { top: [0x0F, 0x0F, 0x26, 0x36], btm: [0x0F, 0x0F, 0x12, 0x36] });
  }
  return palCache.get(mapId);
}
const rgb = (v) => NES_SYSTEM_PALETTE[v & 0x3F] || [0, 0, 0];
const SC = 3, FRAMES = 4;

function drawTile(g, ox, oy, off, pal) {
  let px; try { px = decodeTile(rom, off); } catch { return; }
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
  g.putImageData(img, ox, oy);
}

/** A 2x2 facing from 4 consecutive tiles, TL TR BL BR. */
function drawPose(g, ox, oy, base, pal) {
  [[0, 0], [1, 0], [0, 1], [1, 1]].forEach(([tx, ty], k) =>
    drawTile(g, ox + tx * 8 * SC, oy + ty * 8 * SC, base + k * 16, ty === 0 ? pal.top : pal.btm));
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
g.fillText(`FF3 NPCs — ${cells.length} placed ids, sprite + the DEFAULT line each gives`, 12, 12);
g.font = '10px sans-serif'; g.fillStyle = '#c9cede';
g.fillText('colours are the MAP\'s sprite palettes (measured off the PPU, 16/16 maps) — an NPC on several maps wears the first one\'s', 12, 26);

cells.forEach((c, i) => {
  const cx = 12 + (i % COLS) * CW;
  const cy = 52 + Math.floor(i / COLS) * CH;
  const pal = palettesForMap(c.palMap);
  for (let f = 0; f < FRAMES; f++) drawPose(g, cx + f * CELL, cy, c.off + f * 64, pal);

  // GOLD = confirmed by evidence. GREY-ITALIC = the +0x202 guess, which has
  // been wrong about Cid, Sara and Desch. Never let the two look alike.
  g.font = 'bold 11px sans-serif';
  g.fillStyle = c.confirmed ? '#fff2c4' : '#20242e';
  g.fillText(`id ${c.id}  gfx ${c.gfx}`, cx, cy + CELL + 3);

  if (c.confirmed) {
    g.font = 'bold 13px sans-serif';
    g.fillStyle = '#ffd35c';
    g.fillText(`\u2b50 ${c.confirmed}`, cx, cy + CELL + 17);
  } else {
    g.font = 'italic 10px sans-serif';
    g.fillStyle = '#6b7280';
    // Reusing a named character's art does NOT make you that character.
    g.fillText(c.depicts ? `(${c.depicts}'s sprite, reused)`
      : c.name ? `?« ${c.name} » unverified`
      : (c.text ? `"${c.text.replace(/\s+/g, ' ').slice(0, 28)}"` : '(silent)'),
      cx, cy + CELL + 17);
  }

  g.font = '9px sans-serif';
  g.fillStyle = '#2b3040';
  g.fillText(`0x${c.off.toString(16)}  ${c.where.slice(0, 2).join(', ')}  x${c.spots.length}`,
    cx, cy + CELL + 33);
});

fs.mkdirSync(new URL('../docs/sprites/', import.meta.url), { recursive: true });
const OUT = new URL(`../docs/sprites/ff3-npc-sheet${NAMED_ONLY ? '-named' : ''}.png`, import.meta.url).pathname;
fs.writeFileSync(OUT, cv.toBuffer('image/png'));
console.log(`${cells.length} ids (${cells.filter(c => c.name).length} name themselves) -> ${OUT}`);
