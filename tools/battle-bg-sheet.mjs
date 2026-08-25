#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// ⛔⛔⛔  DO NOT HALF-ASS THE DATA PULL.  ⛔⛔⛔
// A backdrop is FOUR things — tiles, palette, tilemap id, metatiles. Reading
// the palette table and calling the backdrop "pulled" is the same mistake as
// decoding the NPC flags byte and shipping the townsfolk frozen. Every one of
// the four is checked against a live PPU by `monscan/battle-bg-sweep.cjs`;
// this file is the other half of the rule — RENDER IT AND LOOK.
// ═══════════════════════════════════════════════════════════════════════════
// battle-bg-sheet.mjs — draw all 24 FF3 battle backdrops through the SHIPPED
// renderer, labelled, so a backdrop can be chosen by eye instead of by id.
//
//   node tools/battle-bg-sheet.mjs out.png
//
// It calls `renderBattleBg` from src/battle-bg.js — the same function the game
// calls — so a sheet can never show something the game would not draw.
import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));
const outPath = process.argv[2] || 'battle-bg-sheet.png';

globalThis.window = { addEventListener() {} };
globalThis.document = { createElement: () => createCanvas(8, 8), addEventListener() {} };

const { renderBattleBg, BATTLE_BG_COUNT, battleBgIdForMap, BATTLE_BG_MAP_LOOKUP,
        BATTLE_BG_MAP_LOOKUP_HI } = await import('../src/battle-bg.js');

// Which maps use each backdrop — read off both lookup tables, so the label
// says where a backdrop is actually seen instead of just numbering it.
const usedBy = new Map();
for (let mapId = 0; mapId < 512; mapId++) {
  const id = battleBgIdForMap(rom, mapId);
  if (!usedBy.has(id)) usedBy.set(id, []);
  usedBy.get(id).push(mapId);
}

const SCALE = 2, W = 256 * SCALE, H = 32 * SCALE, LABEL = 26, PAD = 6;
const sheet = createCanvas(W + PAD * 2, (H + LABEL) * BATTLE_BG_COUNT + PAD * 2);
const ctx = sheet.getContext('2d');
ctx.fillStyle = '#101014';
ctx.fillRect(0, 0, sheet.width, sheet.height);
ctx.imageSmoothingEnabled = false;
ctx.font = '12px monospace';
ctx.textBaseline = 'top';

for (let id = 0; id < BATTLE_BG_COUNT; id++) {
  const y = PAD + id * (H + LABEL);
  const { bgCanvas } = renderBattleBg(rom, id);
  ctx.drawImage(bgCanvas, PAD, y + LABEL, W, H);
  const maps = usedBy.get(id) || [];
  const shown = maps.slice(0, 12).join(',') + (maps.length > 12 ? `,+${maps.length - 12}` : '');
  ctx.fillStyle = '#e8e8f0';
  ctx.fillText(`bg ${String(id).padStart(2)}   maps: ${maps.length ? shown : '(unused)'}`, PAD, y + 6);
}

fs.writeFileSync(outPath, sheet.toBuffer('image/png'));
console.log(`wrote ${outPath} — ${BATTLE_BG_COUNT} backdrops`);
for (let id = 0; id < BATTLE_BG_COUNT; id++) {
  const maps = usedBy.get(id) || [];
  console.log(`  bg ${String(id).padStart(2)}  ${String(maps.length).padStart(3)} maps  ${maps.slice(0, 10).join(',')}`);
}
