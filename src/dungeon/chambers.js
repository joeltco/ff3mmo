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

/**
 * The wide chamber — floor 1's trap chamber and floor 2's rock-puzzle room.
 * Centred on `x`, spanning `dyMin..dyMax` rows with a half-width of `halfW`,
 * and jittered more heavily than `carveChamber` (up to 2 tiles per side on the
 * edge rows, up to 1 elsewhere) so a big room does not read as a big rectangle.
 *
 * ⛔ `keepClear(dy)` returns 'left' | 'right' | null and zeroes that side's
 * jitter for the row — floor 2 uses it so the exit path always meets the room.
 * It is applied AFTER both draws, never instead of them: the rng call count per
 * row is fixed at two whatever the answer, which is what keeps the stream
 * aligned with floor 1, which passes no predicate at all.
 */
export function carveWideChamber(tilemap, rng, { x, y, dyMin, dyMax, halfW = 3, keepClear = null }) {
  for (let dy = dyMin; dy <= dyMax; dy++) {
    const distFromTop = dy - dyMin;
    const distFromBot = dyMax - dy;
    const isEdge = (distFromTop <= 1 || distFromBot <= 1);
    let jl = isEdge ? Math.floor(rng() * 3) : Math.floor(rng() * 2);
    let jr = isEdge ? Math.floor(rng() * 3) : Math.floor(rng() * 2);
    const clear = keepClear && keepClear(dy);
    if (clear === 'left') jl = 0;
    else if (clear === 'right') jr = 0;
    for (let dx = -halfW + jl; dx <= halfW - jr; dx++) {
      const ax = x + dx, ay = y + dy;
      if (ax >= 1 && ax <= 30 && ay >= 0 && ay < 32) tilemap[ay * 32 + ax] = FLOOR;
    }
  }
}

/**
 * A plain rectangular chamber, no jitter — floor 2's entrance room.
 *
 * ⛔ It is deliberately NOT jittered. The room is only 3-4 tiles wide, and
 * `enforceMinCeilingGap` eats thin runs, so a jittered edge here can close the
 * room's own mouth. Small rooms stay square on purpose.
 *
 * Draws no rng at all, which is why it is a separate primitive rather than
 * `carveChamber` with jitter turned off: a zero-jitter path through
 * `carveChamber` would still have to decide whether to make the draws.
 */
export function carveBoxChamber(tilemap, { x, y, w, dyMin = -4, dyMax = 0 }) {
  for (let dy = dyMin; dy <= dyMax; dy++) {
    for (let dx = 0; dx <= w; dx++) {
      const ax = x + dx, ay = y + dy;
      if (ax >= 1 && ax <= 30 && ay >= 0 && ay < 32) tilemap[ay * 32 + ax] = FLOOR;
    }
  }
}
