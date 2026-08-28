#!/usr/bin/env node
// check-generated-npcs.mjs — an NPC standing on a map that is CARVED FRESH.
//
// `TOWN_NPCS` pairs a person with a tile, which works because a town is the same
// town every time. A dungeon floor is not: it is regenerated on every entry, so
// Princess Sara's spot in the Cave of Seals is FOUND at load time rather than
// written down. Nothing else in the build tests a placement like that — the
// static gates read coordinates, and there are none to read.
//
// ⛔ THIS EXISTS BECAUSE THE FIRST VERSION WAS WRONG ON EVERY SEED, TWICE.
//
//   1. It took the first `PASSAGE_ENTRY` ($6a) tile as "the exit chamber". That
//      floor is ENTERED through a passage arch as well as left through one, and
//      the arrival arch scans first — so she stood two rows under the entrance,
//      inside its one-wide neck. 400 of 400 seeds.
//   2. Fixed to take the other one, she was still as solid as a boulder in a
//      five-tile room: the player opened the wall, walked in, and the staircase
//      was behind the princess. 226 of 400 seeds.
//
// Both were invisible to every other gate: the FLOOR is perfectly connected in
// each case — it is the person standing on it that breaks it, and no dungeon
// gate knows she is there. So the three things asked here are the three things
// that went wrong:
//
//   * she gets a spot at all;
//   * that spot is inside the region the puzzle opens, not somewhere adjacent;
//   * blocking it costs the flood exactly herself — she never seals the way on.
//
//   node tools/check-generated-npcs.mjs [seeds]

import fs from 'node:fs';

const rom = new Uint8Array(fs.readFileSync(process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname));
const { generateFloor } = await import('../src/dungeon-generator.js');
const { DUNGEONS } = await import('../src/data/dungeons.js');
const { GENERATED_NPCS } = await import('../src/data/town-npcs.js');
const { findExitChamberSpot } = await import('../src/data/npc-walk-area.js');
const { reachableFrom } = await import('./dungeon-sweep.mjs');
const { QUESTS } = await import('../src/data/quests.js');

const SEEDS = parseInt(process.argv[2] || '400', 10);
const BASE = 1754900000000;
const fails = [];

// Which dungeon floor each generated-map id is.
function locate(mapId) {
  for (const dg of DUNGEONS) {
    if (mapId >= dg.base && mapId < dg.base + dg.floors) return { dg, f: mapId - dg.base };
  }
  return null;
}

// ⛔ EVERY STAGE THAT NAMES A GENERATED MAP MUST HAVE A PLACER FOR IT. A quest
// can point at a dungeon floor; if nothing puts the person there, the chain is
// unfinishable and `check-quest-stages` will not notice, because it reads the
// same table this one does.
for (const q of Object.values(QUESTS)) {
  for (const st of q.stages || []) {
    const m = st.at && st.at.map;
    if (m == null || !locate(m)) continue;
    const rows = GENERATED_NPCS.get(m) || [];
    if (!rows.some((r) => r.key === st.at.npc)) {
      fails.push(`${q.id}/${st.id} sends you to generated map ${m} for '${st.at.npc}', but GENERATED_NPCS[${m}] does not list them`);
    }
  }
}

for (const [mapId, rows] of GENERATED_NPCS) {
  const at = locate(mapId);
  if (!at) { fails.push(`GENERATED_NPCS[${mapId}] is not a floor of any dungeon`); continue; }
  for (const row of rows) {
    let none = 0, outside = 0, seals = 0;
    for (let k = 0; k < SEEDS; k++) {
      const r = generateFloor(rom, at.f, BASE + k * 7919, at.dg);
      const spot = findExitChamberSpot(r);
      if (!spot) { none++; continue; }
      const tm = r.tilemap;
      const shut = reachableFrom(tm, r.entranceX, r.entranceY);
      const open = Uint8Array.from(tm);
      if (r.rockSwitch) for (const w of r.rockSwitch.wallTiles) open[w.y * 32 + w.x] = w.newTile;
      const openSeen = reachableFrom(open, r.entranceX, r.entranceY);
      const i = spot.y * 32 + spot.x;
      // Behind the wall: unreachable before the puzzle, reachable after.
      if (shut[i] || !openSeen[i]) outside++;
      // And she is not walkable — blocking her tile must strand nothing.
      const blocked = Uint8Array.from(open);
      blocked[i] = 0x00;
      const after = reachableFrom(blocked, r.entranceX, r.entranceY);
      let lost = 0;
      for (let j = 0; j < 1024; j++) if (openSeen[j] && !after[j]) lost++;
      if (lost > 1) seals++;
    }
    const label = `${at.dg.id} f${at.f} '${row.key}'`;
    console.log(`${label.padEnd(26)} ${SEEDS} seeds — no spot ${none}, outside the sealed room ${outside}, seals the floor ${seals}`);
    if (none)    fails.push(`${label}: no spot found on ${none}/${SEEDS} seeds — they would simply not be there`);
    if (outside) fails.push(`${label}: placed OUTSIDE the region the puzzle opens on ${outside}/${SEEDS} seeds`);
    if (seals)   fails.push(`${label}: standing there strands part of the floor on ${seals}/${SEEDS} seeds — an NPC is as solid as a boulder`);
  }
}

if (fails.length) {
  console.log(`\nFAIL (${fails.length}):`);
  for (const f of fails) console.log('  ' + f);
  process.exit(1);
}
console.log('\ngenerated-map NPCs: placed, behind the wall, and standing nowhere load-bearing');
