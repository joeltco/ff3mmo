#!/usr/bin/env node
// map-coverage.mjs — what the ROM offers vs what the game actually wires up.
//
// Transitions are already generic: overworld entrances read `destMap` straight
// out of the world tile props (`map-triggers.js#_checkWorldMapTrigger`), and
// interior doors read `mapData.entranceData[trigId]` (`map-triggers.js:530`).
// So "wiring a map in" is not about plumbing — it is about the per-map CONTENT
// tables, each of which is hand-authored and currently covers a handful of IDs.
//
// This prints, per reachable map, which of those tables have an entry, so the
// gap is a number instead of an impression.
//
//   node tools/map-coverage.mjs            # summary + first N unwired maps
//   node tools/map-coverage.mjs --all      # every reachable map
//   node tools/map-coverage.mjs --json     # machine-readable

import fs from 'node:fs';
import { loadWorldMap } from '../src/world-map-loader.js';
import { loadMap } from '../src/map-loader.js';

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));

const args = process.argv.slice(2);
const SHOW_ALL = args.includes('--all');
const AS_JSON  = args.includes('--json');

// ── Content tables, imported rather than re-listed, so this can't drift ─────
//
// Every import is asserted. A `.catch(() => ({ X: null }))` fallback and a
// misremembered export name both produce `undefined`, which `keysOf` turns into
// an empty set and the report prints as a confident "0 / 171" — a table that
// doesn't exist and a table that's empty look identical. That happened twice
// while writing this (SHOPS by shape, ENCOUNTERS by name), so a missing export
// is now a crash instead of a zero.
async function table(mod, name) {
  const m = await import(mod);
  if (m[name] == null) throw new Error(`${mod} has no export '${name}' — fix the tool, don't report 0`);
  return m[name];
}
const AREA_NAMES = await table('../src/data/areas.js', 'AREA_NAMES');
const SHOPS      = await table('../src/data/shops.js', 'SHOPS');
const TOWN_NPCS  = await table('../src/data/town-npcs.js', 'TOWN_NPCS');
const LOOT_POOLS = await table('../src/data/loot-tables.js', 'LOOT_TABLES');
const ENCOUNTERS = await table('../src/data/encounters.js', 'ENCOUNTERS');

// NOT columns, because neither is per-map hand-authored work:
//   `BATTLE_BG_MAP_LOOKUP` (battle-bg.js) is a ROM OFFSET — 0x073C10, 256
//   entries indexed by map id. Battle backgrounds already resolve from ROM for
//   every map, like transitions do.
//   `ENCOUNTERS` is keyed by ZONE name, not map id, and zones are chosen by
//   `battle-encounter.js#currentEncounterZoneKey` from world-map bounding boxes
//   and dungeon floor index. No town/interior map has an encounter zone, and
//   `tickRandomEncounter` returns false there anyway, so "0 per map" would be a
//   category error rather than a gap.

/**
 * Which map ids a content table covers.
 *
 * The tables don't agree on shape and the difference is easy to get wrong:
 * `TOWN_NPCS` and `AREA_NAMES` are keyed BY map id, while `SHOPS` is keyed by
 * shop name (`'ur_weapon'`) and carries `mapId` in the value. A first pass here
 * read `Map.keys()` for both and reported shops as 0/171 — a table with eight
 * entries looked empty because `Number('ur_weapon')` is NaN. So: take numeric
 * keys where they exist, and fall back to `.mapId` on the values.
 */
function keysOf(t) {
  const s = new Set();
  if (!t) return s;
  const entries = t instanceof Map ? [...t.entries()]
    : Array.isArray(t) ? t.map((v, i) => [i, v])
    : Object.entries(t);
  for (const [k, v] of entries) {
    const n = Number(k);
    if (Number.isFinite(n) && String(k).trim() !== '') s.add(n);
    else if (v && v.mapId != null) s.add(Number(v.mapId));
  }
  return s;
}

const TABLES = [
  ['name',   keysOf(AREA_NAMES)],
  ['shop',   keysOf(SHOPS)],
  ['npc',    keysOf(TOWN_NPCS)],
  ['loot',   keysOf(LOOT_POOLS)],
];

// ── Reachable set ──────────────────────────────────────────────────────────
// Seed with every overworld entrance destination, then follow interior doors
// through `entranceData` transitively — that is exactly what the running game
// does, so this is the real reachable set, not a guess at one.
const world = loadWorldMap(rom, 0);
const seeds = new Set();
for (const props of world.tileProps) { /* shape check only */ break; }
for (let i = 0; i < world.tilemap.length; i++) {
  const m = world.tilemap[i] & 0x7F;
  const p = world.tileProps[m];
  if (!p || !(p.byte1 & 0x80)) continue;
  const dest = world.entranceTable[p.byte2 & 0x3F];
  if (dest) seeds.add(dest);
}

const reachable = new Set(seeds);
const queue = [...seeds];
const failed = [];
while (queue.length) {
  const id = queue.shift();
  let r;
  try { r = loadMap(rom, id); } catch { failed.push(id); continue; }
  if (!r || !r.entranceData) continue;
  for (const dest of r.entranceData) {
    if (!dest || reachable.has(dest)) continue;
    reachable.add(dest);
    queue.push(dest);
  }
}

const ids = [...reachable].sort((a, b) => a - b);
const rows = ids.map(id => {
  const have = TABLES.filter(([, set]) => set.has(id)).map(([n]) => n);
  return { mapId: id, entrance: seeds.has(id), have, missing: TABLES.map(([n]) => n).filter(n => !have.includes(n)) };
});

if (AS_JSON) {
  console.log(JSON.stringify({ reachable: ids, rows }, null, 1));
} else {
  console.log(`ROM reachable maps: ${ids.length}  (${seeds.size} entered directly from the overworld)`);
  if (failed.length) console.log(`  ${failed.length} map id(s) failed to load: ${failed.join(', ')}`);
  console.log('\nPer-table coverage across those maps:');
  for (const [name, set] of TABLES) {
    const hit = ids.filter(id => set.has(id));
    console.log(`  ${name.padEnd(7)} ${String(hit.length).padStart(3)} / ${ids.length}`
      + (hit.length && hit.length <= 12 ? `   [${hit.join(', ')}]` : ''));
  }
  const fully = rows.filter(r => r.missing.length === 0);
  const bare  = rows.filter(r => r.have.length === 0);
  console.log(`\nFully wired: ${fully.length}    Nothing at all: ${bare.length}`);
  const show = SHOW_ALL ? rows : rows.filter(r => r.have.length > 0);
  console.log('\nmapId  entrance  has');
  for (const r of show) {
    console.log(`  ${String(r.mapId).padStart(3)}  ${r.entrance ? 'overworld' : '   —     '}  ${r.have.join(',') || '(nothing)'}`);
  }
  if (!SHOW_ALL) console.log(`\n(${bare.length} maps with no content at all omitted — pass --all)`);
}
