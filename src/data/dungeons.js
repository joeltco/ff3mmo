// THE DUNGEON REGISTRY — one row per dungeon, and the only place a dungeon's
// identity is written down.
//
// A hand-maintained leaf: **imports nothing**, so every module can read it
// without an import cycle. Skins and music tracks are referenced BY ID and
// resolved at the call site (`BOSS_SKINS` in `dungeon/boss-chamber.js`,
// `TRACKS` in `music.js`) — pulling those objects in here would end the leaf
// property and put `data/` downstream of the engine.
//
// ⛔ WHY THIS EXISTS. Altar Cave was hardcoded across TEN files on fourteen
// independent axes — `mapId - 1000`, `(mapId === 1004) ? 148 : 111`,
// `floorIndex === 4 ? 2 : 0`, `dungeonFloor < 4`, `Set([1004])`, the 1010/1011
// locked rooms, the 1020/1021 secret rooms, `LOOT_POOLS[1000]`, `'cave-' +
// (mapId - 1000)`, `destMap = 1000`. Adding a second dungeon meant finding and
// editing all fourteen, and missing any one of them fails SILENTLY: the wrong
// palette, the wrong music, no encounters, or every chest rejected.
//
// ⛔ ENDING KIND IS NOT SKIN. Skin is what the boss chamber looks and sounds
// like; ending kind is what happens when the boss dies. Altar Cave is a CRYSTAL
// dungeon — its boss dissolves into the Wind Crystal and unlocks jobs. The Cave
// of Seals is a regular dungeon: a boss, and nothing else. They are separate
// fields here for that reason.
//
// ⛔ THE DISSOLVE ITSELF IS NOT CRYSTAL-SPECIFIC. Every boss dissolves; that is
// the death animation. Only the crystal reveal, the standing crystal NPC and the
// job unlock belong to the crystal ending.

export const ENDING_CRYSTAL = 'crystal';
export const ENDING_BOSS    = 'boss';

/** Wind Crystal — Warrior, Monk, White Mage, Black Mage, Red Mage (bits 1-5). */
export const WIND_CRYSTAL_JOBS = 0x3E;

/**
 * A dungeon row.
 *
 * `base` + `floors` own a contiguous mapId range: floor N is `base + N`, and the
 * LAST floor (`floors - 1`) is the boss chamber. Side rooms carry their own
 * mapIds and name the floor they hang off, because they are not floors —
 * `dungeonFloor` deliberately does not change when you step into one.
 *
 * ⭐ Ranges must not overlap. `assertNoOverlap()` below is called at import.
 */
export const DUNGEONS = [
  {
    id: 'altar',
    name: 'Altar Cave',
    base: 1000,
    worldEntranceMap: 111,        // ROM map the overworld trigger points at
    floors: 5,                    // 1000-1004; 1004 is the boss chamber
    donorMap: 111,                // ROM map supplying tiles/CHR/palettes
    tileset: 0,
    bossSkinId: 'crystal',        // -> BOSS_SKINS.crystal (donor 148, tileset 2)
    ending: ENDING_CRYSTAL,
    bossId: 0xCC,                 // Land Turtle / Adamantoise
    music: { floors: 'CRYSTAL_CAVE', boss: 'CRYSTAL_ROOM' },
    rosterPrefix: 'cave',         // roster loc 'cave-0'.. ; boss floor -> 'crystal'
    bossRosterLoc: 'crystal',
    lockedRooms: [
      { mapId: 1010, floor: 0 },
      { mapId: 1011, floor: 2 },
    ],
    secretRooms: [
      { mapId: 1020, floor: 0 },
      { mapId: 1021, floor: 0 },
    ],
  },
];

// ── Lookups ────────────────────────────────────────────────────────────────
//
// `buildRegistry(rows)` is the whole implementation; the module-level helpers
// below are a bound instance over `DUNGEONS`. Keeping it a FUNCTION OF ITS ROWS
// is what makes "a second dungeon works by data alone" a testable claim rather
// than an assertion — `check-dungeon-registry.mjs` builds a two-dungeon
// registry and walks every axis. A hand-rolled module-level index could only be
// tested against the one dungeon that happens to ship.

export function buildRegistry(rows) {
  const byFloor = new Map();   // mapId -> { dungeon, floorIndex }
  const bySide  = new Map();   // mapId -> { dungeon, kind, floor }
  const claimed = new Map();

  for (const d of rows) {
    const ids = [];
    for (let f = 0; f < d.floors; f++) { byFloor.set(d.base + f, { dungeon: d, floorIndex: f }); ids.push(d.base + f); }
    for (const r of d.lockedRooms || []) { bySide.set(r.mapId, { dungeon: d, kind: 'locked', floor: r.floor }); ids.push(r.mapId); }
    for (const r of d.secretRooms || []) { bySide.set(r.mapId, { dungeon: d, kind: 'secret', floor: r.floor }); ids.push(r.mapId); }
    for (const id of ids) {
      if (claimed.has(id) && claimed.get(id) !== d.id) {
        throw new Error(`dungeon mapId ${id} claimed by both '${claimed.get(id)}' and '${d.id}'`);
      }
      claimed.set(id, d.id);
    }
  }

  const isDungeonMapId    = (mapId) => byFloor.has(mapId) || bySide.has(mapId);
  const dungeonForMapId   = (mapId) => (byFloor.get(mapId) || bySide.get(mapId))?.dungeon ?? null;
  const floorIndexForMapId = (mapId) => (byFloor.has(mapId) ? byFloor.get(mapId).floorIndex : null);
  const sideRoomForMapId  = (mapId) => bySide.get(mapId) || null;

  const endingKindFor = (mapId) => {
    const d = dungeonForMapId(mapId);
    if (!d) return ENDING_BOSS;
    const f = floorIndexForMapId(mapId);
    if (f === null || !isBossFloor(d, f)) return ENDING_BOSS;
    return d.ending;
  };

  const rosterLocFor = (mapId) => {
    const e = byFloor.get(mapId);
    if (!e) return null;
    const { dungeon, floorIndex } = e;
    return isBossFloor(dungeon, floorIndex) ? dungeon.bossRosterLoc
                                            : `${dungeon.rosterPrefix}-${floorIndex}`;
  };

  const dungeonForWorldEntrance = (romMapId) => rows.find((x) => x.worldEntranceMap === romMapId) || null;

  const minMapId = Math.min(...[...byFloor.keys(), ...bySide.keys()]);

  return {
    rows, minMapId,
    isDungeonMapId, dungeonForMapId, floorIndexForMapId, sideRoomForMapId,
    endingKindFor, rosterLocFor, dungeonForWorldEntrance,
    isCrystalChamber: (mapId) => endingKindFor(mapId) === ENDING_CRYSTAL,
  };
}

// ── Row-shape helpers (pure, no index needed) ──────────────────────────────

/** mapId of a dungeon's floor N. */
export function mapIdForFloor(dungeon, floorIndex) { return dungeon.base + floorIndex; }

/** Is this the dungeon's boss chamber (its last floor)? */
export function isBossFloor(dungeon, floorIndex) { return floorIndex === dungeon.floors - 1; }

/** mapId of the dungeon's boss chamber. */
export function bossFloorMapId(dungeon) { return dungeon.base + dungeon.floors - 1; }

/** Every non-boss floor mapId — the floors that carry loot pools and encounters. */
export function normalFloorMapIds(dungeon) {
  const out = [];
  for (let f = 0; f < dungeon.floors - 1; f++) out.push(dungeon.base + f);
  return out;
}

/** The locked-room mapId hanging off a given floor, or null if that floor has none. */
export function lockedRoomMapIdForFloor(dungeon, floorIndex) {
  const r = (dungeon.lockedRooms || []).find((x) => x.floor === floorIndex);
  return r ? r.mapId : null;
}

/** Secret-room mapIds, in the order the generator hands them out. */
export function secretRoomMapIds(dungeon) {
  return (dungeon.secretRooms || []).map((r) => r.mapId);
}

// ── The shipped instance ───────────────────────────────────────────────────

const _R = buildRegistry(DUNGEONS);

/** Lowest mapId any dungeon owns. Town maps are all below this. */
export const DUNGEON_MIN_MAP_ID = _R.minMapId;

/** Is this mapId a dungeon map at all (floor OR side room)? */
export function isDungeonMapId(mapId) { return _R.isDungeonMapId(mapId); }

/** The dungeon owning this mapId, or null. Works for floors and side rooms. */
export function dungeonForMapId(mapId) { return _R.dungeonForMapId(mapId); }

/**
 * Floor index for a FLOOR mapId, or null for a side room / non-dungeon map.
 *
 * ⛔ Side rooms return null on purpose. A locked or secret room is not a floor:
 * `mapSt.dungeonFloor` keeps the host chamber's value while you are inside one,
 * so the boss / music / encounter checks stay consistent (v1.7.665).
 */
export function floorIndexForMapId(mapId) { return _R.floorIndexForMapId(mapId); }

/** Side-room descriptor `{ dungeon, kind, floor }`, or null. */
export function sideRoomForMapId(mapId) { return _R.sideRoomForMapId(mapId); }

/**
 * The dungeon whose overworld mouth is this ROM map id, or null.
 *
 * ⛔ The world trigger's destination is a ROM map (111 for Altar Cave), NOT a
 * dungeon mapId — `map-triggers.js` matched `destMap === 111` and then set
 * `destMap = 1000` by hand. Both halves are per-dungeon.
 */
export function dungeonForWorldEntrance(romMapId) { return _R.dungeonForWorldEntrance(romMapId); }

/**
 * What kind of ending does this map's boss have?
 *
 * Read at boss-death time from the map the fight is on, rather than cached on
 * `battleSt`, so it cannot go stale between entering a dungeon and killing the
 * thing at the bottom. Defaults to a plain boss ending for anything unlisted.
 */
export function endingKindFor(mapId) { return _R.endingKindFor(mapId); }

/** Convenience for the map-load and battle paths. */
export function isCrystalChamber(mapId) { return _R.isCrystalChamber(mapId); }

/**
 * Roster location string for a dungeon FLOOR mapId, or null.
 *
 * ⛔ SIDE ROOMS RETURN NULL, WHICH IS A KNOWN BUG PRESERVED ON PURPOSE. The
 * caller then falls through to `ROSTER_LOC.get(mapId) || 'ur'`, so a player
 * standing in a locked or secret room shows on the roster as being in **Ur**.
 * That is what shipped before this registry existed (`mapId >= 1000 && mapId <
 * 1004` simply did not match 1010/1011/1020/1021) and this refactor is
 * deliberately behaviour-preserving.
 *
 * The fix is one line in `buildRegistry` and belongs in its own change, with
 * its own gate.
 */
export function rosterLocFor(mapId) { return _R.rosterLocFor(mapId); }

/** The dungeon a new run starts in — first row of the registry. */
export const STARTING_DUNGEON = DUNGEONS[0];
