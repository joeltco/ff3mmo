// Corridor carves.
//
// ⛔ THE HORIZONTAL/VERTICAL ASYMMETRY IS LOAD-BEARING, NOT AN ACCIDENT.
// A horizontal corridor is carved THREE ROWS TALL and `addOverhang` eats the top
// two into rock, leaving one walkable row — because rock hangs *below* a ceiling
// lip, so a sideways passage needs headroom above it. A vertical corridor is
// simply one or two columns wide; it has no headroom problem. A `carveLine`
// that treats both axes the same produces floating rock or pinched ceiling, and
// `addOverhang` will fight it.
//
// ⛔ RNG CALL ORDER IS PART OF THE CONTRACT (see chambers.js). Anything here
// that draws from `rng` must draw the same number of times in the same order.
//
// ⛔ THE BOUNDS ARE NOT UNIFORM AND MUST NOT BE "TIDIED". The inline copies these
// replace clamp rows to 0..31 in some places and 1..30 in others; floor 3's
// narrow paths and branch spine use the tighter range. Unifying them changes what
// gets carved at the map edge, which is a real output change, so both are
// parameters and callers pass what they always passed.

import { FLOOR, CEILING, WALL_ROCKY, FALSE_CEILING } from './tiles.js';

/**
 * Carve one column of a horizontal corridor: `depth` rows ending at `y`.
 *
 * Exported as well as used internally — a lone band is the "overhang margin"
 * that joins an entrance column to its corridor, and that is the same 3-rows-
 * eaten-to-1 convention. It is the convention, not the loop, that must not drift.
 */
export function carveBand(tilemap, x, y, depth = 3, yMin = 0, yMax = 31) {
  for (let dy = -(depth - 1); dy <= 0; dy++) {
    const row = y + dy;
    if (row >= yMin && row <= yMax) tilemap[row * 32 + x] = FLOOR;
  }
}

/**
 * A straight horizontal corridor: `steps` columns from `x0` in `dir`, each a
 * 3-row band that the overhang pass reduces to a single walkable row.
 *
 * Replaces the run written out inline in floor 1's and floor 2's branches, and
 * floor 3's two narrow side-room paths.
 *
 * @param {object} spec
 * @param {number} spec.x0        first column carved is `x0 + startStep * dir`
 * @param {number} spec.y         the walkable row
 * @param {number} spec.dir       +1 right, -1 left
 * @param {number} spec.steps     how many columns
 * @param {number} [spec.startStep=1]
 * @param {number} [spec.depth=3] rows carved per column
 * @param {number} [spec.xMin=1] @param {number} [spec.xMax=30]
 * @param {number} [spec.yMin=0] @param {number} [spec.yMax=31]
 * @returns {{endX:number}} last column the loop reached
 */
export function carveHRun(tilemap, { x0, y, dir, steps, startStep = 1, depth = 3, xMin = 1, xMax = 30, yMin = 0, yMax = 31 }) {
  let x = x0;
  for (let s = startStep; s < startStep + steps; s++) {
    x = x0 + s * dir;
    if (x < xMin || x > xMax) break;
    carveBand(tilemap, x, y, depth, yMin, yMax);
  }
  return { endX: x };
}

/**
 * A straight vertical corridor, `width` columns wide, walking `dir` from `y0`.
 * No headroom band — see the asymmetry note above.
 *
 * @returns {{endY:number}}
 */
export function carveVRun(tilemap, { x, y0, dir, steps, width = 1, yMin = 2, yMax = 29 }) {
  let y = y0;
  for (let s = 0; s < steps; s++) {
    y += dir;
    if (y < yMin || y > yMax) break;
    for (let w = 0; w < width; w++) {
      const cx = x + w;
      if (cx >= 0 && cx < 32) tilemap[y * 32 + cx] = FLOOR;
    }
  }
  return { endY: y };
}

/**
 * A vertical corridor that widens by one tile in stretches — the only corridor
 * in the game that varies its width along the run, and the only one that reads
 * as cave rather than as a drawn line (§0 of the chambers plan). Floor 3's spine.
 *
 * It fattens to ONE side at a time, never both, so the passage stays legible.
 *
 * ⛔ RNG ORDER: one draw for the opening side before the loop, then per row —
 * one draw to test whether a stretch starts and, only if it does, one for the
 * side and one for the length. Reordering or adding a draw shifts every chest
 * and skeleton placed after it on the floor.
 *
 * @param {object} spec
 * @param {number} spec.x       the spine column
 * @param {number} spec.yFrom   first row (walks toward `yTo`)
 * @param {number} spec.yTo     last row, inclusive
 * @param {number} [spec.chance=0.4]   probability a stretch starts on a free row
 * @param {number} [spec.minLen=2] @param {number} [spec.lenSpread=3]
 * @param {number} [spec.xMin=1] @param {number} [spec.xMax=30]
 */
export function carveFatteningVRun(tilemap, rng, { x, yFrom, yTo, chance = 0.4, minLen = 2, lenSpread = 3, xMin = 1, xMax = 30 }) {
  let fatSide = rng() < 0.5 ? -1 : 1;
  let fatLen = 0;
  const step = yTo < yFrom ? -1 : 1;
  for (let y = yFrom; step < 0 ? y >= yTo : y <= yTo; y += step) {
    tilemap[y * 32 + x] = FLOOR;
    if (fatLen <= 0 && rng() < chance) {
      fatSide = rng() < 0.5 ? -1 : 1;
      fatLen = minLen + Math.floor(rng() * lenSpread);
    }
    if (fatLen > 0) {
      const sx = x + fatSide;
      if (sx >= xMin && sx <= xMax) tilemap[y * 32 + sx] = FLOOR;
      fatLen--;
    }
  }
}

/**
 * A horizontal branch that fattens, and stops early when it would run into
 * something. Floor 3's alcoves — a 3-row band per column with the occasional
 * bulge one row above or below.
 *
 * `stopAt(x)` is how the caller keeps the branch from bleeding into a side room;
 * returning true ends the run BEFORE that column is carved. `endX` is the last
 * column actually carved, which is where the caller puts the alcove's chest —
 * so the chest lands on the dead-end tile, not past it.
 *
 * ⛔ The fat bulge is written OUTSIDE the 3-row band (one row below it, or one
 * row above its top) and is bounds-checked separately. It is decoration, not
 * walkable width, and `sealTinyPockets` cleans up the ones the end-of-branch
 * chest seals off.
 *
 * ⛔ RNG ORDER: per carved column, one draw to test whether a bulge starts and,
 * only then, one for the direction and one for the length.
 */
export function carveFatteningHRun(tilemap, rng, { x0, y, dir, steps, stopAt, chance = 0.2, minLen = 2, lenSpread = 3, xMin = 1, xMax = 30, yMin = 1, yMax = 30, depth = 3 }) {
  let fatDir = 0, fatLen = 0;
  let endX = x0;
  for (let i = 0; i < steps; i++) {
    const x = x0 + dir * i;
    if (x < xMin || x > xMax) break;
    if (stopAt && stopAt(x)) break;
    endX = x;
    carveBand(tilemap, x, y, depth, yMin, yMax);
    if (fatLen <= 0 && rng() < chance) {
      fatDir = rng() < 0.5 ? -1 : 1;
      fatLen = minLen + Math.floor(rng() * lenSpread);
    }
    if (fatLen > 0) {
      if (fatDir === 1 && y + 1 <= yMax) tilemap[(y + 1) * 32 + x] = FLOOR;
      else if (fatDir === -1 && y - depth >= yMin) tilemap[(y - depth) * 32 + x] = FLOOR;
      fatLen--;
    }
  }
  return { endX };
}

/**
 * An L-shaped link: a horizontal run, then a vertical drop or climb at its far
 * end. The corridor primitive nothing had — every link in the game ran dead
 * straight along one axis, which is a large part of why the floors read as drawn
 * rather than dug (§0 of the chambers plan).
 *
 * ⛔ THE TWO LEGS ARE NOT SYMMETRIC, and cannot be. The horizontal leg is a
 * 3-row band that `addOverhang` reduces to one walkable row; the vertical leg is
 * a single column. See the asymmetry note at the top of this file. The corner
 * column is carved by BOTH legs, which is what joins them.
 *
 * @param {object} spec
 * @param {number} spec.x0 @param {number} spec.y   start of the horizontal leg
 * @param {number} spec.dir      horizontal direction
 * @param {number} spec.steps    horizontal length
 * @param {number} spec.turnY    row the vertical leg ends on (== `y` for no turn)
 * @returns {{endX:number, endY:number}}
 */
export function carveElbow(tilemap, { x0, y, dir, steps, turnY, yMin = 1, yMax = 30 }) {
  const { endX } = carveHRun(tilemap, { x0, y, dir, steps, startStep: 0, yMin, yMax });
  if (turnY === y) return { endX, endY: y };
  const vDir = turnY > y ? 1 : -1;
  const { endY } = carveVRun(tilemap, {
    x: endX, y0: y, dir: vDir, steps: Math.abs(turnY - y), yMin, yMax,
  });
  return { endX, endY };
}

/**
 * Find places a secret tunnel could be dug straight into solid rock.
 *
 * ⛔ THIS IS NOT `findCorridorCandidates`. That one hunts along floor 0's cave
 * OUTLINE and needs `FILL_VOID` beyond the wall — four columns of it — because
 * it carves a detour around the ceiling snake. Floor 0 is the only floor with a
 * void fill, which is why `placeSecretPath` returns empty for every other floor
 * and why secrets have never existed below it (§3b of the chambers plan).
 *
 * A rock-slab floor has no snake and no void: the fill IS ceiling, all the way
 * to the map edge. So there is nothing to detour around — a tunnel just needs a
 * run of solid rock wide enough to lay the standard cross-section into, which
 * makes this the easier case, not the harder one.
 *
 * Cross-section laid by `carveRockTunnel`, matching every other horizontal
 * corridor: ceiling at y-3, rock at y-2 and y-1, floor at y, ceiling at y+1.
 * The candidate therefore needs those rows already solid for the tunnel's whole
 * length, which is what keeps it from breaking into a neighbouring room.
 *
 * @param {object} spec
 * @param {Uint8Array} [spec.reachable] mask from `reachableFloorMask` — REQUIRED in
 *   practice; without it a tunnel can be dug out of a stranded tile.
 * @returns {Array<{x:number, y:number, dir:number}>} wall tile and direction in
 */
export function findRockTunnelSpots(tilemap, { len = 6, reachable = null }) {
  const out = [];
  for (let y = 4; y < 29; y++) {
    for (let x = 2; x < 30; x++) {
      if (tilemap[y * 32 + x] !== FLOOR) continue;          // stand inside the room
      // ⛔ ...and the tile must be REACHABLE, not merely floor. Digging out of a
      // stranded tile just makes the stranded region bigger — see
      // `reachableFloorMask`.
      if (reachable && !reachable[y * 32 + x]) continue;
      for (const dir of [-1, 1]) {
        const wallX = x + dir;
        if (wallX < 1 || wallX > 30) continue;
        if (tilemap[y * 32 + wallX] !== CEILING) continue;   // the wall we pierce
        // Everything the tunnel will occupy must currently be solid ceiling, so
        // it cannot burrow into another room or through a corridor.
        // ⛔ The MOUTH column is checked on its own row only. The two tiles
        // above it are the ROOM's overhang rock, not virgin ceiling, and the
        // tunnel overwrites them anyway — demanding ceiling there rejected every
        // spot on floors 1 and 3 (measured: 0/200 seeds each) while floor 2
        // happened to have one. Beyond the mouth the full cross-section must be
        // untouched ceiling, which is what stops a tunnel breaking into a
        // neighbouring room or corridor.
        let solid = true;
        for (let d = 1; d <= len + 1 && solid; d++) {
          const cx = wallX + dir * d;
          if (cx < 1 || cx > 30) { solid = false; break; }
          for (const dy of [-3, -2, -1, 0, 1]) {
            if (tilemap[(y + dy) * 32 + cx] !== CEILING) { solid = false; break; }
          }
        }
        if (solid) out.push({ x: wallX, y, dir });
      }
    }
  }
  return out;
}

/**
 * Dig a secret tunnel into rock from `spot`, ending in a small alcove.
 *
 * The mouth is `FALSE_CEILING` — visually identical to the ceiling beside it but
 * passable, so the wall reads solid until you walk into it. No trigger and no map
 * transition: the alcove is part of this floor, which is why this needs none of
 * floor 0's `falseWalls` / secret-room-map wiring.
 *
 * ⛔ Runs AFTER `addOverhang`, so it lays its own rock. The overhang pass would
 * otherwise re-wall the passage, exactly as it does to `openEntranceLanding`.
 *
 * @returns {{alcove: {x:number, y:number}}} where the alcove's chest goes
 */
export function carveRockTunnel(tilemap, { x, y, dir, len = 6 }) {
  tilemap[y * 32 + x] = FALSE_CEILING;                    // the disguised mouth
  for (let d = 1; d <= len; d++) {
    const cx = x + dir * d;
    tilemap[y * 32 + cx] = FLOOR;
    tilemap[(y - 1) * 32 + cx] = WALL_ROCKY;              // overhang above the passage
    tilemap[(y - 2) * 32 + cx] = WALL_ROCKY;
  }
  // The mouth column needs the same overhang, or the ceiling above it floats.
  tilemap[(y - 1) * 32 + x] = WALL_ROCKY;
  tilemap[(y - 2) * 32 + x] = WALL_ROCKY;
  return { alcove: { x: x + dir * len, y } };
}
