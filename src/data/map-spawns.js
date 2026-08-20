// map-spawns.js — where the CARTRIDGE puts the player, where we got it wrong.
//
// `_calcSpawnY` models FF3's spawn adjustment: the ROM's entranceX/Y often names
// the door tile outside a building and the engine walks inward. Measured against
// the real ROM on 44 maps with `door-probe.cjs`, it agrees on 39.
//
// ⛔ DO NOT "FIX" `_calcSpawnY` ITSELF. Bounding its scan takes reachable exits
// to ZERO on the maps it rescues — `map-audit.mjs` records the attempt and the
// damage. Disagreements are corrected here, one measured map at a time.
//
// ⛔ AND DO NOT ADD A MAP JUST BECAUSE THE ROM DISAGREES. Four of the five
// disagreements CANNOT take the cartridge's spawn — see the block below. A spawn
// is only safe to move when the destination is the same walkable region, so the
// content placed on that map is still in front of the player.
// `check-spawn-content.mjs` enforces exactly that.

export const MAP_SPAWNS = new Map([
  [21, {
    at: [4, 29],
    // Castle Sasune tower room. `_calcSpawnY` walks the spawn from (4,29) up to
    // (4,27); the cartridge lands you at (4,29). Safe because it is the SAME
    // ROOM — both flood to the identical 45 tiles (x 1..25, y 25..31) — and the
    // map carries no NPCs and no shop, so nothing moves with it.
    why: 'ROM lands at (4,29); _calcSpawnY moved it to (4,27), two tiles inside the same room',
  }],
]);

// ⛔ MEASURED, AND DELIBERATELY NOT APPLIED — the other four disagreements.
//
//   map      ROM spawn   our spawn   region from the ROM spawn, in THIS engine
//   ----     ---------   ---------   -----------------------------------------
//   2        (8,31)      (8,21)      5 tiles, and the ROM room is behind the
//                                    torch puzzle; our room is the 28-tile one
//   5        (3,26)      (3,18)      8 tiles (y 26..28) — a vestibule with NO
//                                    route to the shop room at y 16..20
//   12       (14,31)     (14,21)     ONE tile. The player could not move.
//   16       (3,26)      (3,18)      8 tiles, same as map 5
//
// The cartridge reaches far more from those tiles — `reach-flood.cjs` walked map
// 12 from (14,31) and covered 53 tiles holding all ten of its ROM NPCs — because
// FF3 links rooms of one tilemap with in-map staircase warps and a collision
// model we do not reproduce. Until those are implemented, moving these spawns
// would put the player in a dead vestibule with no shopkeeper (5, 16) or on a
// tile they cannot step off (12).
//
// The ROM's own NPC table says where the content belongs on those maps:
//   map  5: ids 25 @(3,22), 231 @(3,23)                   [231 = Ur weapon marker]
//   map 16: ids 40 @(3,22), 232 @(3,23), 37 @(3,24)       [232 = Kazus weapon marker]
//   map 12: ten NPCs across x 2..14, y 23..28, incl. 250 @(14,26)  [inn marker]
// Move the spawn and that placement together, or not at all.
// See docs/design-notes.md#followups.
