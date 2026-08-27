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
    // ⭐ WHAT EACH WALKABLE FLOOR IS SHAPED LIKE. One name per floor, boss floor
    // excluded (its shape comes from `bossSkinId`). See `layoutForFloor`.
    // `corridor` is Altar Cave's historical run lengths, written down rather
    // than left as literals in the generator. Changing them changes this cave.
    layout: {
      floors: ['snake', 'trap-chamber', 'rock-switch', 'spine'],
      corridor: { hMin: 4, hMax: 6, vMin: 5, vMax: 7 },
      // Altar Cave's historical floor-0 sampling, written down. ⛔ `left` MUST
      // NOT go below 5 and `right` NOT above 27 here: `findCorridorCandidates`
      // hunts this cave's secret corridor in columns 3-7 and needs four void
      // columns outside the room wall. Widening these would quietly delete
      // Altar Cave's secrets. The Cave of Seals has no secret corridors to
      // protect, which is exactly why it may go wider.
      snake: { top: [4, 6], bot: [18, 20], roomW: [7, 9], left: [5, 6], right: [26, 27], gap: [3, 5], tilt: [3, 5] },
      // ⛔ NO `water` CAPABILITY. ALTAR CAVE HAS EXACTLY ONE POND AND IT IS ON
      // FLOOR 3 — the hand-carved pool in the `spine` branch, which is inline
      // code and owes nothing to the catalogue. Joel, 2026-08-27: "ALTAR SHOULD
      // ONLY HAVE A POND ON F3".
      //
      // v1.10.99 granted this cave `water` and made `spring` a rollable mid
      // chamber, which put ponds on floors 1 and 2 at 15-17% of seeds. Nobody
      // asked for that; I granted the capability to both caves because the
      // TILESET could draw it, and "the tileset can draw it" is not a reason to
      // put it in a cave. `tools/check-chambers.mjs` gates the rule now.
    },
    bossId: 0xCC,                 // Land Turtle / Adamantoise
    music: { floors: 'CRYSTAL_CAVE', boss: 'CRYSTAL_ROOM' },
    rosterPrefix: 'cave',         // roster loc 'cave-0'.. ; boss floor -> 'crystal'
    encounterZonePrefix: 'altar_cave',   // -> ENCOUNTERS key `${prefix}_f${floor+1}`
    // ⭐ The ROM map each floor's ENCOUNTERS come from — see `romFloorMaps`
    // below. Altar Cave's four walkable floors climb the cartridge's own four
    // encounter groups (0 -> 1 -> 2 -> 3): Goblins, then Eye Fang + Carbuncle,
    // then Blue Wisp, then all three at once.
    romFloorMaps: [111, 115, 112, 113, 22],
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
  {
    id: 'seals',
    name: 'Cave of Seals',
    base: 2000,
    worldEntranceMap: 103,        // the ROM's own overworld mouth, world (84,36)
    floors: 4,                    // 2000-2003; 3 normal floors + boss, matching
                                  // the cartridge's 103 / 104+105 / 106
    donorMap: 103,                // "Sealed Cave", area $18, palette $79
    tileset: 0,
    bossSkinId: 'seals',          // the dais from ROM map 106 — no crystal
    ending: ENDING_BOSS,          // ⛔ NOT a crystal dungeon. Altar Cave is.
    // ⭐ THIS IS WHERE THE TWO CAVES STOP BEING THE SAME CAVE. Floor 1 is
    // `boulder-chamber`, not `trap-chamber`: no trap holes, a boulder in the big
    // room, and the way down behind a false wall — Altar Cave keeps its trap
    // room. Joel, 2026-08-26: "remove the traps from the trap room, add a random
    // boulder, add the smaller exit with wall chamber".
    // ⭐ LONGER RUNS THAN ALTAR CAVE. Joel, 2026-08-26: "corridors need to be
    // longer." Roughly double: the neck between two rooms was four walkable
    // tiles after the overhang ate the band, which is what made this cave read
    // as a string of rooms rather than a cave.
    layout: {
      floors: ['snake', 'boulder-chamber', 'rock-switch'],
      corridor: { hMin: 8, hMax: 12, vMin: 9, vMax: 13 },
      // ⭐ ITS OWN ENTRY FLOOR. Both caves used to open on the same map — 83 of
      // 200 seeds pixel-identical, the rest differing by ONE tile (Altar Cave's
      // secret doorway). `snake` has no corridors, so the corridor block could
      // not touch it.
      //
      // Wider than Altar Cave's, with a longer neck between the two rooms — the
      // same "make the run longer" the corridors got. It can reach columns 2 and
      // 29 precisely BECAUSE this cave declares no secret rooms: nothing needs
      // the void margin outside the room wall.
      snake: { top: [3, 5], bot: [19, 21], roomW: [8, 11], left: [2, 4], right: [28, 29], gap: [7, 11], tilt: [4, 7] },
      // The Cave of Seals may draw water: its donor map (103) carries the pond
      // metatiles and floor 3's pool proves they read as water in this tileset.
      caps: ['water'],
      // ⭐ THE TWO CAVES FAVOUR DIFFERENT ROOMS. Multipliers on the catalogue's
      // base weights, so a new chamber type still reaches both caves without
      // editing either row.
      //
      // ⛔ `spring: 2.5` IS REMOVED. I wrote "the Cave of Seals is the drowned
      // one" and multiplied its pond weight by two and a half on that basis —
      // a flavour claim I invented, which took ponds to 31% of its floors.
      // Nothing in the ROM, the design notes or anything Joel said makes this
      // cave wet. Base weight only unless someone asks otherwise.
      chambers: { 'bone-pit': 1.6, vault: 0.75 },
    },
    bossId: 0xCD,                 // Djinn — the id right after the Land Turtle
    // ⭐ THE DJINN DROPS THE WSLAYER, 2 in 7 (28.6%). Joel, 2026-08-26.
    //
    // `WSlayer` (0x25) is a HOLY sword, and every encounter in this cave is
    // undead (Mummy, Skeleton, Shadow, Laruwai, CurseCoin, Revenant — all
    // `weakness: [fire, holy]`). It used to sit in `seals_f3` at 9.2%, a table
    // that CANNOT FIRE, so it was unobtainable.
    //
    // ⛔ IT CANNOT LIVE IN `data/monsters.js` — that file is generated from the
    // ROM and hand-edits vanish on the next run — and it is not a ROM drop:
    // FF3 gives bosses rate 0, which `check-drop-roll` correctly pins. The
    // encounter drop roll never sees a boss either; it iterates
    // `battleSt.encounterMonsters`, and a boss fight has no such array.
    //
    // `rate` is the ROM's own ladder (rate/7, the same `DROP_GATE_DIE` the
    // encounter roll uses) so there is ONE drop-chance idiom in the codebase.
    bossDrop: { item: 0x25, rate: 2 },
    music: { floors: 'DUNGEON_CAVE', boss: 'DUNGEON_CAVE' },
    rosterPrefix: 'seals',
    bossRosterLoc: 'seals-boss',
    encounterZonePrefix: 'seals_cave',
    // 1:1 with the cartridge's own four maps, in depth order: 103 "Sealed
    // Cave", 104 "B2F", 105 (B2F's second map — same encounter group as 104),
    // 106 "B3F". Groups 7 -> 8 -> 8 -> 9.
    romFloorMaps: [103, 104, 105, 106],
    // ⛔ NO SIDE ROOMS. The locked/secret rooms are Altar Cave content; giving
    // this dungeon empty arrays is a statement, not an oversight — the generator
    // hands out ids from `secretRoomMapIds` and would otherwise invent some.
    lockedRooms: [],
    secretRooms: [],
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

  // ⛔ DUPLICATE IDS ARE REJECTED. Without this a second row carrying an
  // existing id silently SHADOWS it — the mapId-overlap check below compares
  // `claimed.get(id) !== d.id` and a repeated id passes that test. A test
  // fixture reusing 'seals' at base 2000 did exactly this the moment the real
  // Cave of Seals shipped, and the only symptom was a count that said
  // "3 dungeons: altar, seals, seals".
  const seenIds = new Set();
  for (const d of rows) {
    if (seenIds.has(d.id)) throw new Error(`duplicate dungeon id '${d.id}'`);
    seenIds.add(d.id);
    // ⛔ A SHORT `romFloorMaps` FAILS SILENTLY. `gen-encounters.mjs` walks the
    // floors and would simply emit no zone for the missing ones, and a floor
    // with no zone falls back to a lone Goblin — the same "no encounters"
    // symptom this registry exists to prevent.
    if (d.romFloorMaps && d.romFloorMaps.length !== d.floors) {
      throw new Error(`dungeon '${d.id}': romFloorMaps has ${d.romFloorMaps.length} entries, floors is ${d.floors}`);
    }
    // ⛔ A MISSING OR SHORT `layout` FAILS SILENTLY AND CATASTROPHICALLY. The
    // generator dispatches on the layout name; an undefined name matches no
    // branch, so the floor falls through every carve and the player gets a solid
    // slab of rock with an entrance in it. Length is `floors - 1` because the
    // boss chamber is shaped by `bossSkinId`, not by a layout.
    const _lay = d.layout && d.layout.floors;
    if (!Array.isArray(_lay) || _lay.length !== d.floors - 1) {
      throw new Error(`dungeon '${d.id}': layout.floors must have ${d.floors - 1} entries (floors minus the boss chamber), got ${Array.isArray(_lay) ? _lay.length : typeof _lay}`);
    }
    if (_lay.some((n) => !LAYOUTS.has(n))) {
      throw new Error(`dungeon '${d.id}': unknown floor layout(s) ${_lay.filter((n) => !LAYOUTS.has(n)).join(', ')} — known: ${[...LAYOUTS].join(', ')}`);
    }
  }

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
    if (!e) {
      // A locked or secret room reports its HOST FLOOR's location. It is not a
      // floor of its own — `mapSt.dungeonFloor` deliberately keeps the host
      // chamber's value while you are inside one (v1.7.665) — so the roster
      // follows the same rule and you stay grouped with the players you were
      // just standing next to.
      const side = bySide.get(mapId);
      return side ? `${side.dungeon.rosterPrefix}-${side.floor}` : null;
    }
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

// ── Floor layouts ──────────────────────────────────────────────────────────
//
// ⛔ THE GENERATOR USED TO BRANCH ON THE BARE FLOOR INDEX. `_generateFloor` took
// the dungeon row and never consulted it for SHAPE — every branch was
// `floorIndex === N` — so the Cave of Seals' three floors were byte-identical to
// Altar Cave's first three for the same seed, and editing one edited both. This
// is the same "fourteen hardcoded axes" problem the rest of this registry
// exists to end, and it gets the same fix: the row says what it is.
//
// A name here is a CARVE, not a theme. `trap-chamber` and `boulder-chamber`
// share a head (entrance room, elbow, junction, drop) and differ in what the
// big room at the bottom is and how you leave it.
export const LAYOUTS = new Set([
  'snake',            // two-room ceiling snake, stairs out. Both caves' floor 0.
  'trap-chamber',     // ends in a 7x7 room whose TRAP HOLES are the way down.
  'boulder-chamber',  // ends in a 7x7 room with a boulder; the way down is a
                      // small exit chamber behind the false wall it opens.
  'rock-switch',      // boulder + false wall + exit room, entered from a fall.
  'spine',            // long fattening spine up to side rooms. Altar Cave only.
]);

/**
 * Floor-0 (`snake`) sampling ranges for this dungeon, each an inclusive
 * `[min, max]` pair drawn with a single `rng()` call.
 *
 * ⛔ THESE WERE SEVEN LITERALS IN THE SNAKE BRANCH, so both caves opened on the
 * same map. The default is Altar Cave's historical set, so a row that says
 * nothing carves exactly what it always did.
 *
 * ⛔ `left` / `right` ARE NOT FREE FOR A CAVE WITH SECRET ROOMS.
 * `findCorridorCandidates` needs four void columns outside the room wall to
 * place a secret corridor, which is why Altar Cave's left edge may not go below
 * 5. A dungeon declaring no secret rooms has no such constraint — see
 * `placeSecretPath`, which now returns before carving anything for one.
 */
export function snakeBounds(dungeon) {
  const d = (dungeon && dungeon.layout && dungeon.layout.snake) || null;
  const pick = (k, dflt) => (d && Array.isArray(d[k]) ? d[k] : dflt);
  return {
    top:   pick('top',   [4, 6]),
    bot:   pick('bot',   [18, 20]),
    roomW: pick('roomW', [7, 9]),
    left:  pick('left',  [5, 6]),
    right: pick('right', [26, 27]),
    gap:   pick('gap',   [3, 5]),
    tilt:  pick('tilt',  [3, 5]),
  };
}

/** One `rng()` draw from an inclusive `[min, max]` pair. */
export function drawRange(rng, [lo, hi]) { return lo + Math.floor(rng() * (hi - lo + 1)); }

/**
 * Corridor run lengths for this dungeon, in steps.
 *
 * ⛔ THESE WERE FIVE LITERALS IN TWO GENERATOR BRANCHES — `4 + rng()*3` and
 * `5 + rng()*3`, written out once per branch — so every dungeon walked the same
 * four-tile neck between rooms and there was no way to give one cave longer runs
 * than another. The default is Altar Cave's historical pair, so a row that says
 * nothing carves exactly what it always did.
 *
 * ⛔ THE DRAW MUST STAY ONE `rng()` CALL. Callers do
 * `hMin + Math.floor(rng() * (hMax - hMin + 1))`, which for 4..6 is the old
 * `4 + Math.floor(rng() * 3)` exactly. Reading a bound draws nothing; splitting
 * it into two draws would re-roll every floor below it.
 */
export function corridorBounds(dungeon) {
  const c = (dungeon && dungeon.layout && dungeon.layout.corridor) || null;
  return {
    hMin: c && c.hMin != null ? c.hMin : 4,
    hMax: c && c.hMax != null ? c.hMax : 6,
    vMin: c && c.vMin != null ? c.vMin : 5,
    vMax: c && c.vMax != null ? c.vMax : 7,
  };
}

/**
 * What shape is this dungeon's floor N?
 *
 * Returns null for the boss chamber (which has no layout — see `bossSkinId`)
 * and for any out-of-range index. `buildRegistry` rejects a row whose
 * `layout.floors` is missing, the wrong length, or names an unknown layout, so
 * a non-null return is always one of `LAYOUTS`.
 */
export function layoutForFloor(dungeon, floorIndex) {
  const l = dungeon && dungeon.layout && dungeon.layout.floors;
  return (l && l[floorIndex] != null) ? l[floorIndex] : null;
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

/**
 * The ROM map floor N's encounters are pulled from.
 *
 * The floor -> ROM map assignment is OURS (our floors are generated, not the
 * cartridge's layouts); what comes back OUT of that map — group, formations,
 * rate — is the ROM's. `tools/gen-encounters.mjs` is the only reader.
 */
export function romMapForFloor(dungeon, floorIndex) {
  const m = dungeon.romFloorMaps;
  return m ? (m[floorIndex] ?? null) : null;
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
 * Roster location string for a dungeon mapId, or null for a non-dungeon map.
 *
 * ⛔ FIXED IN v1.10.51 — SIDE ROOMS USED TO REPORT "UR". `rosterLocForMapId`
 * tested `mapId >= 1000 && mapId < 1004`, which never matched the 1010/1011
 * locked rooms or the 1020/1021 secret rooms, so they fell through to
 * `ROSTER_LOC.get(mapId) || 'ur'` — and `data/areas.js` has no entry for any of
 * them. A player who stepped into a locked room showed on the roster as
 * standing in Ur, grouped with strangers in a different town.
 *
 * ⭐ The knock-on is `transSt.rosterLocChanged`, which drives the roster fade on
 * every transition. It used to fire on the way into a side room (cave-0 -> ur)
 * and again on the way out. It no longer fires, which is correct: your roster
 * group does not change when you open a door inside the same floor.
 */
export function rosterLocFor(mapId) { return _R.rosterLocFor(mapId); }

/** The dungeon a new run starts in — first row of the registry. */
export const STARTING_DUNGEON = DUNGEONS[0];
