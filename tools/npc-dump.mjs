#!/usr/bin/env node
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
