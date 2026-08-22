#!/usr/bin/env node
// check-dungeon-registry.mjs — can a SECOND dungeon be added by data alone?
//
// That is the claim the registry exists to make, and it is not provable by
// generating Altar Cave: every hardcoded literal agrees with Altar Cave, so a
// suite that only ever builds Altar Cave passes whether or not the refactor
// worked. This builds a two-dungeon registry with DIFFERENT numbers on every
// axis and walks each one.
//
// Two halves:
//   1. LITERAL GUARD — none of the migrated engine modules may mention a
//      dungeon mapId again. This is what stops axis #15 being hardcoded next
//      month; it fails the moment someone writes `mapId === 1004`.
//   2. BEHAVIOUR — a synthetic second dungeon with a different base, floor
//      count, donor, skin, ending, music and roster prefix resolves correctly
//      on every helper, and its floors actually GENERATE with its own art.
//
//   node tools/check-dungeon-registry.mjs

import fs from 'node:fs';
import { buildRegistry, isBossFloor, bossFloorMapId, normalFloorMapIds,
         lockedRoomMapIdForFloor, secretRoomMapIds, DUNGEONS,
         ENDING_BOSS, ENDING_CRYSTAL } from '../src/data/dungeons.js';
import { resolveBossSkin, resolveDungeonDonor } from '../src/dungeon/boss-chamber.js';
import { generateFloor, clearDungeonCache } from '../src/dungeon-generator.js';

const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };

// ── 1. literal guard ───────────────────────────────────────────────────────
// The mapIds Altar Cave owns. Any of these appearing as a bare number in engine
// code means that axis is hardcoded again.
const BANNED = [1000, 1001, 1002, 1003, 1004, 1010, 1011, 1020, 1021];
const GUARDED = [
  'src/dungeon-generator.js', 'src/map-loading.js', 'src/map-triggers.js',
  'src/roster.js', 'src/battle-encounter.js', 'src/data/loot-pools.js',
  'src/dungeon-locked-room.js', 'src/dungeon/boss-chamber.js', 'src/main.js',
];
for (const file of GUARDED) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const code = line.split('//')[0];
    if (/^\s*\*/.test(line)) return;                       // jsdoc/comment body
    for (const id of BANNED) {
      // Word-boundary match, minus two legitimate uses of the same digits:
      //   - an object KEY (`1000:` in LOOT_POOLS) — that is per-floor DATA
      //   - arithmetic (`y * 1000 + dist`, `60 * 1000`) — a scale factor
      // Everything else (`=== 1004`, `mapId: 1010`, `>= 1000`) is a hardcoded id.
      if (new RegExp(`(?<![*/]\\s{0,2})\\b${id}\\b(?!\\s*[:*/])`).test(code)) {
        fails.push(`${file}:${i + 1} hardcodes dungeon mapId ${id} — use the registry: ${line.trim()}`);
      }
    }
  });
}

// ── 2. a second dungeon, different on every axis ───────────────────────────
const SEALS = {
  id: 'seals', name: 'Cave of Seals',
  base: 2000, worldEntranceMap: 103,
  floors: 4,                      // <- NOT 5: boss floor is 3, not 4
  donorMap: 103, tileset: 0,
  bossSkinId: 'seals',
  ending: ENDING_BOSS,
  bossId: 0xCD,
  music: { floors: 'CRYSTAL_CAVE', boss: 'CRYSTAL_ROOM' },
  rosterPrefix: 'seals', bossRosterLoc: 'seals-boss',
  lockedRooms: [{ mapId: 2010, floor: 1 }],
  secretRooms: [{ mapId: 2020, floor: 0 }],
};
const R = buildRegistry([...DUNGEONS, SEALS]);

ok(R.dungeonForMapId(2000)?.id === 'seals', 'floor mapId 2000 does not resolve to seals');
ok(R.floorIndexForMapId(2002) === 2, 'floor index for 2002 should be 2');
ok(R.dungeonForMapId(1004)?.id === 'altar', 'adding a dungeon broke altar lookup');
ok(R.floorIndexForMapId(2004) === null, '2004 is past seals (4 floors) and must not resolve');
ok(R.isDungeonMapId(2010) && R.sideRoomForMapId(2010)?.kind === 'locked', 'seals locked room 2010 not registered');
ok(R.sideRoomForMapId(2020)?.kind === 'secret', 'seals secret room 2020 not registered');
ok(R.dungeonForWorldEntrance(103)?.id === 'seals', 'overworld mouth 103 does not map to seals');
ok(R.dungeonForWorldEntrance(111)?.id === 'altar', 'overworld mouth 111 no longer maps to altar');

// ⛔ The ending axis is the one that must NOT follow the boss chamber. Seals has
// a boss room and no crystal; altar has both.
ok(R.endingKindFor(2003) === ENDING_BOSS,    'seals boss floor must have a plain boss ending');
ok(R.endingKindFor(1004) === ENDING_CRYSTAL, 'altar boss floor must still be a crystal ending');
ok(R.isCrystalChamber(2003) === false,       'seals boss chamber must not be a crystal chamber');

ok(R.rosterLocFor(2001) === 'seals-1',    `roster loc for 2001 was ${R.rosterLocFor(2001)}`);
ok(R.rosterLocFor(2003) === 'seals-boss', `roster loc for seals boss was ${R.rosterLocFor(2003)}`);
ok(R.rosterLocFor(1004) === 'crystal',    'altar boss roster loc changed');

// ⛔ SIDE ROOMS REPORT THEIR HOST FLOOR. Before v1.10.51 these returned null and
// the caller fell through to `ROSTER_LOC.get(mapId) || 'ur'` — a player in a
// locked room showed as standing in Ur. `data/areas.js` lists none of these
// mapIds, so the fallback was reached every time, not just in edge cases.
ok(R.rosterLocFor(1010) === 'cave-0',  `altar locked room 1010 (floor 0) -> ${R.rosterLocFor(1010)}`);
ok(R.rosterLocFor(1011) === 'cave-2',  `altar locked room 1011 (floor 2) -> ${R.rosterLocFor(1011)}`);
ok(R.rosterLocFor(1020) === 'cave-0',  `altar secret room 1020 (floor 0) -> ${R.rosterLocFor(1020)}`);
ok(R.rosterLocFor(1021) === 'cave-0',  `altar secret room 1021 (floor 0) -> ${R.rosterLocFor(1021)}`);
ok(R.rosterLocFor(2010) === 'seals-1', `seals locked room 2010 (floor 1) -> ${R.rosterLocFor(2010)}`);
ok(R.rosterLocFor(2020) === 'seals-0', `seals secret room 2020 (floor 0) -> ${R.rosterLocFor(2020)}`);
// a room's location must equal its host floor's, not merely be non-null
ok(R.rosterLocFor(1011) === R.rosterLocFor(1002),
   'locked room 1011 and its host floor 1002 must share a roster location');
ok(R.rosterLocFor(2010) === R.rosterLocFor(2001),
   'seals locked room 2010 and its host floor 2001 must share a roster location');

ok(isBossFloor(SEALS, 3) && !isBossFloor(SEALS, 4), 'boss floor for a 4-floor dungeon should be 3');
ok(bossFloorMapId(SEALS) === 2003, 'seals boss mapId should be 2003');
ok(JSON.stringify(normalFloorMapIds(SEALS)) === '[2000,2001,2002]', 'seals normal floors wrong');
ok(lockedRoomMapIdForFloor(SEALS, 1) === 2010, 'seals locked room not found for floor 1');
ok(lockedRoomMapIdForFloor(SEALS, 0) === null, 'seals floor 0 has no locked room');
ok(JSON.stringify(secretRoomMapIds(SEALS)) === '[2020]', 'seals secret rooms wrong');

// overlapping ranges must be rejected, not silently merged
let threw = false;
try { buildRegistry([...DUNGEONS, { ...SEALS, base: 1002 }]); } catch { threw = true; }
ok(threw, 'overlapping dungeon map ranges were accepted');

// ── 3. the skin and donor actually differ ──────────────────────────────────
ok(resolveBossSkin(SEALS.bossSkinId).donorMap === 103, 'seals boss skin donor should be 103');
ok(resolveBossSkin('crystal').donorMap === 148, 'crystal skin donor should be 148');
ok(resolveDungeonDonor(1004) === 148 && resolveDungeonDonor(1000) === 111,
   'altar donor resolution changed');

// ── 4. its floors GENERATE, with its own art ───────────────────────────────
const rom = new Uint8Array(fs.readFileSync(process.env.FF3_ROM || 'FF3-English.nes'));
clearDungeonCache();
const seed = 1755000000000;
for (let f = 0; f < SEALS.floors; f++) {
  const r = generateFloor(rom, f, seed, SEALS);
  ok(r && r.tilemap && r.tilemap.length === 1024, `seals floor ${f} did not generate`);
  const want = isBossFloor(SEALS, f) ? resolveBossSkin(SEALS.bossSkinId).tileset : SEALS.tileset;
  ok(r.tileset === want, `seals floor ${f} tileset ${r.tileset}, expected ${want}`);
}
// ⛔ Same shape, DIFFERENT PAINT. If the palettes match Altar Cave's the donor
// never reached the asset loader — which is exactly the bug that shipped as a
// "SEALS" skin repainting Altar Cave onto itself (v1.10.47).
const altarF1 = generateFloor(rom, 1, seed, DUNGEONS[0]);
const sealsF1 = generateFloor(rom, 1, seed, SEALS);
const pal = (r) => JSON.stringify(r.palettes);
ok(pal(altarF1) !== pal(sealsF1), 'seals floor 1 uses ALTAR CAVE palettes — the donor is not reaching loadRomAssets');
ok(JSON.stringify([...altarF1.tilemap]) === JSON.stringify([...sealsF1.tilemap]),
   'same seed + floor should carve the same SHAPE regardless of dungeon (only art differs)');

// boss chambers must differ in art too
const altarBoss = generateFloor(rom, 4, seed, DUNGEONS[0]);
const sealsBoss = generateFloor(rom, 3, seed, SEALS);
ok(pal(altarBoss) !== pal(sealsBoss), 'seals boss chamber uses the crystal palettes');
ok(altarBoss.tileset === 2 && sealsBoss.tileset === 0,
   `boss tilesets should be 2 (crystal) and 0 (cave), got ${altarBoss.tileset} / ${sealsBoss.tileset}`);

// ⛔ THE CRYSTAL IS A SKIN DECORATION, AND A NON-CRYSTAL DUNGEON MUST NOT GET
// ONE. Tiles $3a-$3f are the altar pedestal, stamped by `CRYSTAL_SKIN.decorate`
// over the shared shape. Palette and tileset checks CANNOT see this — hardcoding
// `resolveBossSkin('crystal')` back into `generateBossRoom` leaves both
// identical and only changes what gets stamped, which is how it survived the
// first revert pass of this gate.
const PEDESTAL = new Set([0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f]);
const pedestalCount = (r) => [...r.tilemap].filter((t) => PEDESTAL.has(t)).length;
ok(pedestalCount(altarBoss) > 0, 'altar boss chamber lost its crystal pedestal');
ok(pedestalCount(sealsBoss) === 0,
   `seals boss chamber has ${pedestalCount(sealsBoss)} crystal-pedestal tiles — a non-crystal dungeon must not get an altar`);

clearDungeonCache();

if (fails.length) {
  console.error('FAIL:');
  for (const f of fails) console.error('  ' + f);
  process.exit(1);
}
console.log(`registry drives ${DUNGEONS.length + 1} dungeons: ${[...DUNGEONS, SEALS].map(d => d.id).join(', ')}`);
console.log(`${GUARDED.length} engine modules free of dungeon mapId literals`);
console.log('a second dungeon works from data alone');
