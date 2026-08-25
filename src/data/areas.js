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
      [26, 'sasune-g'], [27, 'sasune-h'], [28, 'sasune-i'],
      [30, 'sasune-j'],
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
 * a part of the game ff3mmo has not built. Castle Sasune alone had TWENTY-FOUR
 * doors leading outside the castle — its tower rooms chain 19 -> 23 -> 21 into
 * Ur's houses, and map 22 opens straight into the Altar Cave. `map-audit --play`
 * measured 69 maps reachable on foot from Ur; only 32 of them are places.
 *
 * `map-triggers.js` refuses a door whose destination is not in here, with the
 * same "The way is barred." the stranding guard uses. Ur already had ZERO
 * leaking doors, which is why nobody noticed the rule was missing.
 *
 * ⛔ This is a CONTENT list, not a passability rule. Adding a map here makes it
 * enterable, so add it only when the place is actually built — and check its own
 * doors, because each one you open leaks one level further out.
 */
export const SHIPPED_MAPS = new Set();
for (const a of AREAS) { SHIPPED_MAPS.add(a.head); for (const r of a.rooms.keys()) SHIPPED_MAPS.add(r); }

/** Is this door destination a place we ship? Dungeon/world ids are not doors. */
export function isShippedMap(mapId) { return SHIPPED_MAPS.has(mapId); }

/** Every map in a named area -> its roster location key. */
export const ROSTER_LOC = new Map();
for (const a of AREAS) {
  ROSTER_LOC.set(a.head, a.loc);
  for (const [mapId, loc] of a.rooms) ROSTER_LOC.set(mapId, loc);
}
