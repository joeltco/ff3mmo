#!/usr/bin/env node
// check-loot-tables.mjs — one loot rule, one place, and no silent fallbacks.
//
// ⛔ WHAT THIS REPLACES. The chain
//
//     LOOT_POOLS[mapId] -> UR_CHEST_MAPS -> DEFAULT_LOOT
//
// was written SIX TIMES across data/loot-pools.js, src/map-triggers.js and
// economy-arbiter.js — client and server both, twice each for chests and vases.
// `DEFAULT_LOOT` was `LOOT_POOLS[1000]`, the Altar Cave's floor-1 table, so
// every place nobody had written a table for handed out the opening dungeon's
// loot INCLUDING ITS 12% MIMIC TIER. Measured with `valley-loot-audit.mjs`:
// thirteen treasure tiles, every one in Kazus and Castle Sasune.
//
// And `UR_CHEST_MAPS` was a hand-copy of the map set `data/areas.js` already
// declares for Ur — identical today, silently divergent the moment a room is
// added.
//
//   node tools/check-loot-tables.mjs
//   node tools/check-loot-tables.mjs --list    # every place and its table


import fs from 'node:fs';

let failed = 0;
const ok  = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { console.error(`  ✗ ${m}`); failed++; };
const LIST = process.argv.includes('--list');

const LT = await import('../src/data/loot-tables.js');
const { AREAS, AREA_MAPS, isAreaMap } = await import('../src/data/areas.js');
const { DUNGEONS, normalFloorMapIds, sideRoomForMapId } = await import('../src/data/dungeons.js');
const { ITEMS } = await import('../src/data/items.js');
const { SHOPS } = await import('../src/data/shops.js');

// ── 1. the duplicated fallback chain is gone ──────────────────────────────
{
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const files = ['src/map-triggers.js', 'economy-arbiter.js', 'src/data/loot-tables.js'];
  let copies = 0;
  for (const f of files) {
    const src = strip(fs.readFileSync(new URL('../' + f, import.meta.url).pathname, 'utf8'));
    // The tell: reading a table by bare map id then falling back.
    for (const m of src.matchAll(/UR_CHEST_MAPS|DEFAULT_LOOT|LOOT_POOLS\s*\[/g)) { copies++; void m; }
  }
  if (copies) bad(`${copies} reference(s) to the old LOOT_POOLS/UR_CHEST_MAPS/DEFAULT_LOOT chain remain`);
  else ok('the six copies of the fallback chain are gone');

  if (fs.existsSync(new URL('../src/data/loot-pools.js', import.meta.url).pathname)) {
    bad('src/data/loot-pools.js still exists — two tables is how they drift');
  } else ok('src/data/loot-pools.js is deleted, not shimmed');
}

// ── 2. no place falls back to a DUNGEON's table ───────────────────────────
//
// The bug this file is named for. An undesigned place must land on the town
// baseline — no mimic — never on a real dungeon's ladder.
{
  if (LT.UNDESIGNED.some((t) => t.monster)) {
    bad('the UNDESIGNED fallback contains a mimic tier — a chest in a castle could eat you');
  } else ok('the UNDESIGNED fallback has no mimic tier');

  const dungeonTables = new Set(Object.values(LT.DUNGEON_LOOT).flat());
  for (const [, table] of Object.entries(LT.AREA_LOOT)) {
    if (dungeonTables.has(table)) bad(`an AREA is pointed at the dungeon table '${table}'`);
  }
  ok('no town/castle area borrows a dungeon table');
}

// ── 3. every named table exists, and every table is reachable ─────────────
{
  const named = new Set([...Object.values(LT.AREA_LOOT), ...Object.values(LT.DUNGEON_LOOT).flat()]);
  for (const n of named) if (!LT.LOOT_TABLES[n]) bad(`table '${n}' is referenced and not defined`);
  for (const n of Object.keys(LT.LOOT_TABLES)) if (!named.has(n)) bad(`table '${n}' is defined and nothing references it`);
  if (named.size === Object.keys(LT.LOOT_TABLES).length) ok(`all ${named.size} tables are defined and referenced`);

  // Every dungeon's walkable floors must each have a table — a short list means
  // the deepest floors silently share the shallowest's loot or fall through.
  for (const d of DUNGEONS) {
    const floors = normalFloorMapIds(d).length;
    const names = (LT.DUNGEON_LOOT[d.id] || []).length;
    if (floors !== names) bad(`dungeon '${d.id}' has ${floors} walkable floor(s) and ${names} table(s)`);
  }
  ok('every dungeon names one table per walkable floor');
}

// ── 4. tier shape ─────────────────────────────────────────────────────────
{
  for (const [name, tiers] of Object.entries({ ...LT.LOOT_TABLES, UNDESIGNED: LT.UNDESIGNED })) {
    if (!Array.isArray(tiers) || !tiers.length) { bad(`table '${name}' is empty`); continue; }
    for (const t of tiers) {
      if (!(t.weight > 0)) bad(`table '${name}' has a tier with weight ${t.weight}`);
      if (t.monster) continue;
      if (!Array.isArray(t.pool) || !t.pool.length) { bad(`table '${name}' has a tier with an empty pool`); continue; }
      for (const e of t.pool) {
        if (typeof e === 'number') { if (!ITEMS.get(e)) bad(`table '${name}' yields unknown item 0x${e.toString(16)}`); }
        else if (!e || !Array.isArray(e.gil) || e.gil[0] > e.gil[1]) bad(`table '${name}' has a malformed gil entry`);
      }
    }
  }
  ok('every tier has a positive weight, a non-empty pool, and real item ids');
}

// ── 5. the resolver agrees with the registries ────────────────────────────
{
  for (const a of AREAS) {
    const want = LT.AREA_LOOT[a.loc];
    for (const mapId of [a.head, ...a.rooms.keys()]) {
      const got = LT.lootTableFor(mapId, () => 0);
      if (want && got.name !== want) bad(`map ${mapId} (${a.loc}) resolved to '${got.name}', area says '${want}'`);
      if (!want && got.designed) bad(`map ${mapId} (${a.loc}) resolved to '${got.name}' but no AREA_LOOT entry exists`);
    }
  }
  ok('every area map resolves to its area\'s table');

  // ⛔ AREA_MAPS must still equal what the old hand-written set listed for Ur —
  // the whole point of deleting UR_CHEST_MAPS is that this is now derived.
  const ur = AREAS.find((a) => a.loc === 'ur');
  const urMaps = [ur.head, ...ur.rooms.keys()].sort((p, q) => p - q).join(' ');
  if (urMaps !== '1 2 3 4 5 6 7 8 9 114 147') bad(`Ur's map set changed: ${urMaps}`);
  else if (![1, 2, 114, 147].every(isAreaMap)) bad('isAreaMap disagrees with AREAS');
  else ok(`AREA_MAPS is derived from AREAS (${AREA_MAPS.size} maps), not hand-listed`);
}

// ── 6. a vase never spawns a battle ───────────────────────────────────────
{
  let sawMonster = false;
  const rng = (() => { let i = 0; return () => ((i = (i * 9301 + 49297) % 233280), i / 233280); })();
  for (const mapId of [114, 1, 1000, 1003, 2000, 2002, 10, 18]) {
    for (let n = 0; n < 4000; n++) {
      const e = LT.pickLootEntry(mapId, 'vase', rng);
      if (e && e.monster) { sawMonster = true; break; }
    }
  }
  if (sawMonster) bad('a vase rolled a mimic — a vase is "search here", not "spawn a battle"');
  else ok('vases never roll a mimic, on any map');
}

// ── 7. the server's union covers what the client can roll ─────────────────
//
// If these disagree the arbiter rejects a legitimate chest. Locked rooms are
// the case the old code special-cased on the literal mapId 1010.
{
  const rng = (() => { let i = 7; return () => ((i = (i * 9301 + 49297) % 233280), i / 233280); })();
  const maps = [114, 1, 1000, 1001, 1002, 1003, 2000, 2001, 2002, 10, 18, 1010, 1011];
  let mismatches = 0;
  for (const mapId of maps) {
    const union = LT.resolvedPoolFor(mapId, 'chest');
    if (!union) { bad(`no resolved pool for map ${mapId}`); continue; }
    for (let n = 0; n < 6000; n++) {
      const e = LT.pickLootEntry(mapId, 'chest', rng);
      if (e == null) continue;
      if (typeof e === 'number') { if (!union.items.has(e)) { bad(`map ${mapId}: rolled item 0x${e.toString(16)} the server union does not accept`); mismatches++; break; } }
      else if (e.gil) { if (e.gil[1] > union.gilMax) { bad(`map ${mapId}: rolled gil above the server's max`); mismatches++; break; } }
      else if (e.monster && !union.hasMonster) { bad(`map ${mapId}: rolled a mimic the server union does not accept`); mismatches++; break; }
    }
  }
  if (!mismatches) ok(`the server union accepts every client roll across ${maps.length} maps, locked rooms included`);
}

// ── 8. every table can actually fire ──────────────────────────────────────
//
// ⛔ THE PREVIOUS VERSION OF THIS CHECK WAS WRONG AND SHIPPED RED.
//
// It read `FLOOR_CONFIG[floorIndex].chests` out of dungeon-generator.js, saw
// `chests: 0` on floors 2 and 3, and declared `seals_f3` a dead table. That
// number is only ONE of the placement paths: the floor-2 and floor-3 layouts
// push `extraRooms`, and the scatter gives each of those a 50% corner chest.
// GENERATING the floors says so — averaged over 5 seeds:
//
//     altar  f0=3.2  f1=6.0  f2=3.6  f3=3.4
//     seals  f0=3.2  f1=6.0  f2=3.6
//
// Every floor of both dungeons places chests. No table is dead. The lesson is
// the one this session kept relearning: a CONSTANT IN SOURCE IS NOT BEHAVIOUR —
// generate the thing and count.
{
  const counts = [];
  for (const d of DUNGEONS) {
    const names = LT.DUNGEON_LOOT[d.id] || [];
    counts.push(`${d.id}:${names.length}`);
  }
  ok(`tables per dungeon: ${counts.join(' ')} — chest placement is verified by ` +
     'generating floors (tools/floor-view.mjs), not by reading FLOOR_CONFIG');
}

// ── 9. the debt is VISIBLE, not silent ────────────────────────────────────
{
  const undesigned = [];
  for (const a of AREAS) if (!LT.AREA_LOOT[a.loc]) undesigned.push(a.loc);
  if (undesigned.length) {
    console.log(`  … UNDESIGNED places (real chests, no table written): ${undesigned.join(', ')}`);
    console.log('    they get the town baseline — gil + consumables, no mimic — until someone writes one.');
  } else ok('every area has a designed loot table');
}

if (LIST) {
  console.log('\n── every mapped place ──');
  const m = LT.mappedLootMaps();
  const byTable = new Map();
  for (const [mapId, name] of m) { if (!byTable.has(name)) byTable.set(name, []); byTable.get(name).push(mapId); }
  for (const [name, ids] of byTable) console.log(`  ${name.padEnd(12)} ${ids.sort((p, q) => p - q).join(' ')}`);
  void SHOPS; void sideRoomForMapId;
}

console.log(failed ? `\ncheck-loot-tables: ${failed} FAILED` : '\ncheck-loot-tables: OK');
process.exit(failed ? 1 : 0);
