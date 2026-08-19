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
  },
  {
    head: 10, banner: 'Kazus', loc: 'kazus', fromOverworld: true,
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
    ]),
  },
  {
    // Map 29 names ITSELF on entry, so it is a head map that happens to sit
    // inside another area's interior. Walking 18 -> 25 -> 29 must repaint the
    // banner, which is why the lookup below is keyed per map rather than
    // latched once per town.
    head: 29, banner: 'Sasune Throne Room', loc: 'sasune-throne', fromOverworld: false,
    rooms: new Map(),
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

/** Every map in a named area -> its roster location key. */
export const ROSTER_LOC = new Map();
for (const a of AREAS) {
  ROSTER_LOC.set(a.head, a.loc);
  for (const [mapId, loc] of a.rooms) ROSTER_LOC.set(mapId, loc);
}
