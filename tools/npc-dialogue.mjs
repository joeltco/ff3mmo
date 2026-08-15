#!/usr/bin/env node
// npc-dialogue.mjs — every FF3 NPC, with the sprite it wears and the line it says.
//
// ── the link ──────────────────────────────────────────────────────────────
// An NPC's dialogue is simply its id, offset into the global string table:
//
//     stringId = npcId + 0x202
//
// MEASURED, not inferred. Ur's elder house (map 7) holds exactly three NPCs at
// known ROM coordinates. Warping there, walking to each one and reading the
// message box off the PPU NAMETABLE gave:
//
//     id 19 @(4,3) centre -> "Elder Topapa, the man who raised the four orphans"
//     id 17 @(2,4) left   -> "Nina, the adoptive mother of the four orphans"
//     id 18 @(6,4) right  -> "Tomak, a village Elder"
//
// which are string ids 0x215, 0x213, 0x214 — id + 0x202, three for three, and
// the left/centre/right positions match the ROM's own coordinates.
//
// Reading the NAMETABLE is the trick that makes this cheap: by the time the
// game draws a box it has already expanded the DTE compression, so the tiles
// ARE the decoded text (tile index == character code).
//
// ⛔ Read all FOUR nametables and diff against a post-warp baseline. FF3 does
// not draw the box into $2000, and the previous screen's tiles linger — an
// absolute read of one nametable returns the STALE battle screen while the
// screenshot plainly shows a town interior.
//
// ── the text ──────────────────────────────────────────────────────────────
// Decoding lives in `tools/lib/ff3-text.mjs`: the string pointer table at
// 0x30010 and the DTE table at 0x75FA1, which is stored as TWO PARALLEL
// 52-byte arrays (all first characters, then all second characters).
//
//   node tools/npc-dialogue.mjs              # NPCs in the towns we ship
//   node tools/npc-dialogue.mjs --all        # every NPC id in the game
//   node tools/npc-dialogue.mjs --json

import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.document = { createElement: () => createCanvas(8, 8), getElementById: () => null, addEventListener() {} };

import { loadRom, decodeString, selfName } from './lib/ff3-text.mjs';
const { loadMap } = await import('../src/map-loader.js');
const G = await import('../src/data/npc-gfx.js');

/** An NPC's line is its id offset into the string table. Measured — see header. */
export const NPC_DIALOGUE_BASE = 0x202;
export const dialogueIdForNpc = (npcId) => npcId + NPC_DIALOGUE_BASE;

const rom = loadRom();
const ALL = process.argv.includes('--all');

const MAP_NAMES = new Map([
  [114, 'Ur'], [1, 'Ur secret2'], [2, 'Ur secret'], [3, 'Ur magic'], [4, 'Ur armor'],
  [5, 'Ur weapon'], [6, 'Ur elder1'], [7, 'Ur elder2'], [8, 'Ur inn'], [9, 'Ur tavern'],
  [10, 'Kazus'], [12, 'Kazus inn'], [15, 'Kazus magic'], [16, 'Kazus weapon'],
  [17, 'Kazus armor'], [18, 'Castle Sasune'],
]);

const where = new Map();
for (let m = 0; m < 512; m++) {
  let md; try { md = loadMap(rom, m); } catch { continue; }
  for (const n of md.npcs || []) {
    if (!where.has(n.id)) where.set(n.id, []);
    where.get(n.id).push({ mapId: m, x: n.x, y: n.y });
  }
}

export { selfName };

const rows = [];
for (const id of [...where.keys()].sort((a, b) => a - b)) {
  const gfx = G.gfxForNpcId(rom, id);
  const kind = G.kindForGfx(gfx);
  const spots = where.get(id);
  const named = [...new Set(spots.map(s => s.mapId))].filter(m => MAP_NAMES.has(m));
  if (!ALL && !named.length) continue;
  if (kind === 'undrawn' || kind === 'object') continue;
  const text = decodeString(rom, dialogueIdForNpc(id));
  rows.push({
    npcId: id, gfx, kind,
    spriteOffset: '0x' + G.offsetForGfx(gfx).toString(16).toUpperCase(),
    dialogueId: '0x' + dialogueIdForNpc(id).toString(16),
    name: selfName(text),
    maps: named.map(m => MAP_NAMES.get(m)),
    allMaps: [...new Set(spots.map(s => s.mapId))],
    at: spots.filter(s => MAP_NAMES.has(s.mapId)).map(s => `${MAP_NAMES.get(s.mapId)}(${s.x},${s.y})`),
    text,
  });
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ base: NPC_DIALOGUE_BASE, npcs: rows }, null, 2));
} else {
  console.log(`FF3 NPCs — ${rows.length} ${ALL ? 'total' : 'in the towns we ship'}   (dialogue = npcId + 0x202)\n`);
  for (const r of rows) {
    const nm = r.name ? `  «${r.name}»` : '';
    console.log(`id ${String(r.npcId).padStart(3)}  gfx ${String(r.gfx).padStart(2)} ${r.spriteOffset}  ${r.dialogueId}${nm}`);
    console.log(`     ${r.at.length ? r.at.join(' ') : 'maps ' + r.allMaps.slice(0, 6).join(',')}`);
    console.log(`     ${r.text ? '"' + r.text + '"' : '(silent — no string)'}`);
  }
  const named = rows.filter(r => r.name);
  console.log(`\n${named.length} of ${rows.length} name themselves: ` +
    named.map(r => `${r.name}(id ${r.npcId})`).join(', '));
}
