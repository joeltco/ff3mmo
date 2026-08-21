// Chamber carves — the shapes a dungeon floor is made of.
//
// A leaf beyond `tiles.js`, so tools can carve without a browser.
//
// ⛔ RNG CALL ORDER IS PART OF THE CONTRACT. Every floor draws from one seeded
// stream, so a carve that makes one more or one fewer `rng()` call — or makes
// them in a different order — shifts every later chest, skeleton and corridor on
// that floor. It does not look like a bug in the carve; it looks like the whole
// floor changed. `tools/check-floor-snapshot.mjs` exists for exactly this.

import { FLOOR } from './tiles.js';

/**
 * The irregular-edged room the deep floors are built from.
 *
 * This body was written out FOUR times — floor 1's entrance room and mid room,
 * floor 2's mid room and exit room — with the source itself calling the copies
 * "direct copy of floor 2's first 5×5 mid room" and "identical primitive to
 * floor 2's exit room". Only three things ever varied: the origin column, the
 * horizontal direction, and the floor row.
 *
 * Carved `h` rows tall (default 7) and `w` wide (default 5): `addOverhang` later
 * eats the top rows into rock, leaving a 5×5 walkable room — which is why the
 * carve is taller than the room. The top two and bottom two rows get up to one
 * tile of jitter per side so the result reads as cave rather than rectangle.
 *
 * @param {Uint8Array} tilemap  32×32, mutated in place
 * @param {Function}   rng      seeded RNG — called twice per jittered row, left then right
 * @param {object}     spec
 * @param {number}     spec.x        origin column (the corridor-side edge)
 * @param {number}     spec.y        floor row the room sits on
 * @param {number}     [spec.dir=1]  +1 extends right of `x`, -1 extends left
 * @param {number}     [spec.w=5]    walkable width
 * @param {number}     [spec.h=7]    carve height, pre-overhang
 */
export function carveChamber(tilemap, rng, { x, y, dir = 1, w = 5, h = 7 }) {
  const dyMax = 2, dyMin = dyMax - (h - 1);
  for (let dy = dyMin; dy <= dyMax; dy++) {
    const isEdge = (dy <= dyMin + 1 || dy >= dyMax - 1);
    const jl = isEdge ? Math.floor(rng() * 2) : 0;
    const jr = isEdge ? Math.floor(rng() * 2) : 0;
    for (let dx = jl; dx <= (w - 1) - jr; dx++) {
      const ax = x + dx * dir, ay = y + dy;
      if (ax >= 1 && ax <= 30 && ay >= 0 && ay < 32) tilemap[ay * 32 + ax] = FLOOR;
    }
  }
}
