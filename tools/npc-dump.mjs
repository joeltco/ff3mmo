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
// npc-dump.mjs — the ROM's own NPC list for a map, next to what WE place.
//
// src/map-loader.js#readNPCs already decodes FF3's per-map NPC table (pointer
// table at $058010, entries of {id, x, y, flags} terminated by id 0). Nothing
// but flame-sprites.js ever read it, so the town NPCs were placed from OAM
// snaps — i.e. from whoever happened to be on screen. This prints the ROM's
// full roster so "are we missing anybody" is answerable from data.
import fs from 'node:fs';
const { loadMap, parseMapProperties } = await import('../src/map-loader.js');
const { TOWN_NPCS } = await import('../src/data/town-npcs.js');
const rom = new Uint8Array(fs.readFileSync(process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname));

for (const id of process.argv.slice(2).map(Number)) {
  const props = parseMapProperties(rom, id);
  const md = loadMap(rom, id);
  console.log(`\n=== map ${id}  (npcIdx $${props.npcIdx.toString(16)})  ROM lists ${md.npcs.length} NPC(s) ===`);
  const at = (x, y) => {
    const mid = md.tilemap[y * 32 + x];
    const m = mid < 128 ? mid : mid & 0x7F;
    const c = md.collision[m];
    return { mid, walk: !((c & 0x07) === 3 || (c & 0x80)) };
  };
  md.npcs.forEach((n, i) => {
    const t = at(n.x, n.y);
    console.log(`  #${i}  gfx $${n.id.toString(16).padStart(2, '0')}  at (${n.x},${n.y})` +
      `  flags $${n.flags.toString(16).padStart(2, '0')}` +
      `  tile $${t.mid.toString(16).padStart(2, '0')}${t.walk ? '' : ' [on a solid tile]'}`);
  });
  const ours = TOWN_NPCS.get(id) || [];
  console.log(`  WE place ${ours.length}: ${ours.map(o => `${o.key}(${o.x},${o.y})`).join(' ') || '(none)'}`);
}
