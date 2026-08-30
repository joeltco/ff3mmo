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
// areas.js — the named places, and every map that belongs to one.
//
// SINGLE SOURCE for two things that were separately hand-maintained and drifted
// apart, each in a way that looked fine on screen:
//
//   * the top-box NAME BANNER (`map-loading.js#setupTopBox`), which used to be
//     the literal test `mapId === 114`. Kazus and Castle Sasune therefore got a
//     battle-scene strip on entry, and the ONLY reason Ur's shops kept the
//     banner was inertia: `setupTopBox` skipped its else-branch while
//     `topBoxSt.isTown` was still true from walking in through the town. Load a
//     save made inside any interior and `isTown` starts false, so even Ur's
//     rooms opened with a battle strip.
//
//   * the ROSTER LOCATION key (`roster.js#rosterLocForMapId`), whose lists of
//     the same map ids lived in three separate Maps in a UI module.
//
// ⭐ THE BANNER TEXT IS MEASURED, NOT INVENTED. Each head map was warped to in
// the real ROM (the `$0700` + `$AB` path `tools/monscan/map-bundles.cjs` uses)
// and the banner read off the PPU:
//
//   map  10 -> "Kazus"                map  18 -> "Castle Sasune"
//   map  29 -> "Sasune Throne Room"   map 114 -> "Ur"
//
// `tools/check-area-banners.mjs` re-derives the tables below and gates them.
//
// ⛔ A ROOM IS NOT A HEAD MAP. `head` maps are the ones the ROM names on entry;
// `rooms` inherit the banner but are NOT towns. `ps.lastTown` (the legacy
// respawn fallback) takes `TOWN_MAPS`, which is the head maps you can walk into
// FROM THE OVERWORLD — 29 is a throne room reached through Sasune's interior,
// so it names itself without ever becoming a respawn point.

import { encodeName } from './strings.js';

/**
 * One entry per place the game names. `rooms` maps an interior map id to its
 * roster location key; those keys are on the wire (ws-presence.js clamps `loc`
 * to 16 chars), so they must stay <= 16 characters and must not be renamed
 * casually.
 */
export const AREAS = [
  {
    head: 114, banner: 'Ur', loc: 'ur', fromOverworld: true,
    rooms: new Map([
      [2,   'ur-secret'],   // secret house (ground floor)
      [1,   'ur-secret2'],  // secret room (secret house, upstairs)
      [3,   'ur-magic'],    // white-magic shop
      [4,   'ur-armor'],    // armor shop
      [5,   'ur-weapon'],   // weapon shop
      [6,   'ur-elder1'],   // elder's house (ground floor)
      [7,   'ur-elder2'],   // elder's house (upstairs)
      [8,   'ur-inn'],      // inn (ground floor)
      [9,   'ur-tavern'],   // tavern (inn, upstairs)
      [147, 'ur-well'],     // well
    ]),
    // ⛔ Map 1 (the treasure room) was declared unreachable here in v1.10.4. That
    // was WRONG, and the game was never broken — the GATE was. It flooded the map
    // without `applyPassage`, the $5B/$5C -> $5D/$5E rewrite `map-loading.js`
    // performs on every load, so Ur's secret house read as 28 tiles with the way
    // to the treasure room sealed. With the passage opened, as the live game
    // opens it, map 2 gives 49 tiles and the door at (23,16) is reachable.
    unreachable: new Set()
  },
  {
    head: 10, banner: 'Kazus', loc: 'kazus', fromOverworld: true, unreachable: new Set(),
    // ⛔ These were LOST once already: they shipped in v1.8.12, the revert of
    // that version took them out, and the rebuild restored the NPCs without
    // them — the same way all three Kazus shops went missing. Nothing looked
    // broken because `rosterLocForMapId` DEFAULTS to 'ur', so players standing
    // in Kazus simply reported as being in Ur. `check-roster-locs.mjs` pins it.
    rooms: new Map([
      [11, 'kazus-house'],
      [12, 'kazus-inn'],
      [13, 'kazus-house2'],
      [14, 'kazus-house3'],
      [15, 'kazus-magic'],
      [16, 'kazus-weapon'],
      [17, 'kazus-armor'],
    ]),
  },
  {
    head: 18, banner: 'Castle Sasune', loc: 'sasune', fromOverworld: true,
    rooms: new Map([
      [19, 'sasune-a'], [20, 'sasune-b'], [21, 'sasune-c'],
      [23, 'sasune-d'], [24, 'sasune-e'], [25, 'sasune-f'],
      [28, 'sasune-i'],
      // ⛔ 26, 27 and 30 USED TO BE LISTED HERE, and that was the bug. They are
      // not rooms — they are ARRIVAL ALIASES of 25 and 28 (see
      // ARRIVAL_ALIASES below). Listing one room under three ids gave the same
      // hall three roster keys, three chest ledgers, and NPCs on only one of
      // the three.
      // The EAST tower room, measured: walking into the tower door at (23,12)
      // in the real ROM lands on map 174 at (4,10) (tools/monscan/door-graph.cjs).
      // It shares map 19's tilemap and entrance, which is why the pair looks like
      // a duplicate. Listed so the east tower stays enterable; its own onward
      // doors (175 / 52 / 54) leave the castle and are barred by SHIPPED_MAPS.
      [174, 'sasune-tower-e'],
    ]),
    // Map 24 is in `map-triggers.js#STRANDING_MAPS` — the engine already refuses
    // it at the door because its ROM entrance drops the player in a pocket with
    // no reachable exit. Nothing in the castle points at it either (its own door
    // 0 points at ITSELF). Kept in the list so it keeps its roster key, declared
    // unreachable so the graph gate does not have to lie about it.
    unreachable: new Set([24]),
  },
  {
    // Map 29 names ITSELF on entry, so it is a head map that happens to sit
    // inside another area's interior. Walking 18 -> 25 -> 29 must repaint the
    // banner, which is why the lookup below is keyed per map rather than
    // latched once per town.
    head: 29, banner: 'Sasune Throne Room', loc: 'sasune-throne', fromOverworld: false,
    rooms: new Map(), unreachable: new Set(),
  },
];

/** Maps the ROM names on entry -> the banner bytes. Head maps only. */
export const AREA_NAMES = new Map(AREAS.map(a => [a.head, encodeName(a.banner)]));

/**
 * Every map that shows a name banner -> the bytes it shows. Head maps AND the
 * interiors that inherit their town's name, so entering a room directly (a
 * save loaded inside a shop, a door from somewhere else) paints the right name
 * instead of falling through to a battle-scene strip.
 */
export const BANNER_FOR_MAP = new Map();
for (const a of AREAS) {
  BANNER_FOR_MAP.set(a.head, AREA_NAMES.get(a.head));
  for (const room of a.rooms.keys()) BANNER_FOR_MAP.set(room, AREA_NAMES.get(a.head));
}

/**
 * Head maps you can walk into from the overworld — what `ps.lastTown` means.
 * NOT every named map: a throne room names itself without being a town.
 */
export const TOWN_MAPS = new Set(AREAS.filter(a => a.fromOverworld).map(a => a.head));

/**
 * ⭐ EVERY MAP THIS GAME SHIPS AS A PLACE YOU CAN WALK INTO.
 *
 * FF3's door tables are the whole cartridge's, and most of what they point at is
 * a part of the game ff3mmo has not built. Castle Sasune alone looked like it
 * had TWENTY-FOUR doors leading outside the castle — its tower rooms chain
 * 19 -> 23 -> 21 into Ur's houses, and map 22 opens straight into the Altar
 * Cave. `map-audit --play` measured 69 maps reachable on foot from Ur; only 32
 * of them are places.
 *
 * `map-triggers.js` refuses a door whose destination is not in here, with the
 * same "The way is barred." the stranding guard uses. Ur already had ZERO
 * leaking doors, which is why nobody noticed the rule was missing.
 *
 * ⛔ AND THEN THE RULE OVER-FIRED, BECAUSE THE COUNT WAS WRONG. Nine of those
 * twenty-four "doors out of the castle" led back INTO it — they were arrival
 * aliases of rooms this list already holds (see ARRIVAL_ALIASES). Barring them
 * left the throne room, the keep's 2F and half the hall as rooms you walk into
 * and cannot walk out of. Three doors genuinely leave: 10 -> 101, 25 -> 182 and
 * 174 -> 175. `check-area-graph --list` prints exactly those.
 *
 * ⛔ This is a CONTENT list, not a passability rule. Adding a map here makes it
 * enterable, so add it only when the place is actually built — and check its own
 * doors, because each one you open leaks one level further out.
 */
export const SHIPPED_MAPS = new Set();
for (const a of AREAS) { SHIPPED_MAPS.add(a.head); for (const r of a.rooms.keys()) SHIPPED_MAPS.add(r); }

/**
 * ⭐⭐ A ROM MAP ID IS NOT A PLACE. IT IS (TILEMAP, DOOR TABLE, ARRIVAL TILE).
 *
 * FF3 has no "warp to map M, tile (x,y)" instruction. A door names a MAP ID and
 * the engine drops you on that id's `entranceX/Y`. So when the cartridge wants
 * one room to be enterable by four staircases, it spends four map ids on it —
 * same tilemap, same door table, same NPC list, four different arrival tiles.
 *
 * Castle Sasune's keep is THREE rooms addressed by TWELVE ids. We shipped six of
 * the twelve and barred the other six as "unbuilt content", and the six we
 * barred were exactly the RETURN halves of every stair pair:
 *
 *   map  29  the THRONE ROOM       its one and only exit -> 191   BARRED
 *   map  30  keep 2F               its one and only exit -> 190   BARRED
 *   map  27  keep hall             both exits -> 187 / 182        BARRED
 *   map  25  keep hall, front door -> 186                         BARRED
 *   map  26  keep hall             -> 188                         BARRED
 *   map  28  keep 2F               -> 189                         BARRED
 *
 * Players walked in to talk to the King and could not walk out. That is the
 * "Castle Sasune has barred exits" report, and it is why an id is resolved to
 * its CANONICAL room here instead of being added to SHIPPED_MAPS as a seventh
 * copy of the same hall — a copy would carry its own chest ledger, its own
 * roster key, and none of the hall's TOWN_NPCS (the quest servant `errand`
 * stage is `at: { map: 25 }`, so arriving as 189 would lose him).
 *
 * ⭐ MEASURED, NOT INVENTED. Every entry below was derived by grouping all 256
 * maps on (tilemap bytes, entrance table bytes, npcIdx, tileset, fill tile) and
 * keeping the groups with more than one member; the arrival tile is that id's
 * own ROM `entranceX/Y`. `tools/check-arrival-aliases.mjs` re-derives the whole
 * table from the cartridge and fails on a drifted coordinate, a missing family
 * member AND a stale entry.
 *
 * ⛔ ONLY THREE FAMILIES EXIST among the maps we ship, and all three are in
 * Castle Sasune. The sweep found one other multi-id group (11 / 32 / 64 / 77),
 * and those are NOT aliases — they carry different songs, i.e. different
 * places that happen to reuse a tilemap. Do not add them.
 *
 * ⚠ The alias ids carry bgPalette2 116 where the canonical carries 148 — one
 * palette line, and the only thing it colours in this room is the pair of beds
 * (white vs blue). The canonical's palette wins, because the canonical is the
 * id you arrive on from the courtyard and therefore what players already see.
 */
export const ARRIVAL_ALIASES = new Map([
  // Castle Sasune courtyard (tilemap d93f5b5f) — 186 is the keep's front step.
  [186, { map: 18, x: 15, y: 19 }],

  // The keep's hall + upper hall, ONE tilemap (9f843cd0) with two rooms joined
  // by two internal staircases: (10,9)<->(10,21) and (16,2)<->(16,21).
  [26,  { map: 25, x: 10, y:  9 }],
  [27,  { map: 25, x: 16, y: 21 }],
  [187, { map: 25, x: 16, y:  2 }],
  [188, { map: 25, x: 10, y: 21 }],
  [189, { map: 25, x: 10, y:  5 }],
  [190, { map: 25, x: 14, y:  7 }],

  // The keep's 2F (tilemap a1a1ac50) — two stairs down to the hall, one up to
  // the throne room.
  [30,  { map: 28, x: 14, y: 24 }],
  [191, { map: 28, x: 10, y: 20 }],
]);

/** The map id that actually gets loaded for `mapId` — itself, unless aliased. */
export function canonicalMapId(mapId) {
  const a = ARRIVAL_ALIASES.get(mapId);
  return a ? a.map : mapId;
}

/**
 * Where a door pointed at `mapId` really lands: `{ mapId, x, y }`.
 *
 * `x`/`y` are `undefined` for a non-alias, which is exactly what
 * `loadMapById(id, returnX, returnY)` wants for "use the map's own entrance".
 */
export function resolveArrival(mapId) {
  const a = ARRIVAL_ALIASES.get(mapId);
  return a ? { mapId: a.map, x: a.x, y: a.y } : { mapId, x: undefined, y: undefined };
}

/**
 * Is this door destination a place we ship? Dungeon/world ids are not doors.
 *
 * Asks about the CANONICAL id, so an arrival alias of a shipped room is
 * shipped. Before that it was a raw Set lookup, and every return staircase in
 * Castle Sasune answered "no".
 */
export function isShippedMap(mapId) { return SHIPPED_MAPS.has(canonicalMapId(mapId)); }

/**
 * Every map that belongs to a town/castle area — head map and interiors.
 *
 * ⛔ THIS IS WHAT `UR_CHEST_MAPS` WAS. That was a hand-written Set of Ur's
 * eleven map ids living in `data/loot-pools.js`, byte-for-byte identical to what
 * this table already declares, and it carried TWO unrelated meanings at once:
 * "which chests reset after 24h" (a town rule) and "which maps share Ur's loot"
 * (a loot rule). Adding a room to Ur updated neither.
 *
 * The town-chest reset rule is this one. The loot rule is `AREA_LOOT` in
 * data/loot-tables.js, keyed by area, and it is no longer Ur-only.
 */
export const AREA_MAPS = new Set();
for (const a of AREAS) {
  AREA_MAPS.add(a.head);
  for (const mapId of a.rooms.keys()) AREA_MAPS.add(mapId);
}

/** Is this a town/castle map (as opposed to a generated dungeon floor)? */
export function isAreaMap(mapId) { return AREA_MAPS.has(mapId); }

/** Every map in a named area -> its roster location key. */
export const ROSTER_LOC = new Map();
for (const a of AREAS) {
  ROSTER_LOC.set(a.head, a.loc);
  for (const [mapId, loc] of a.rooms) ROSTER_LOC.set(mapId, loc);
}
