// Cave shaping — the passes that turn carved floor into a cave, and the chain
// every deep floor ends with.
//
// A leaf beyond `tiles.js`. These were seven functions scattered through
// `dungeon-generator.js`; the five-pass chain below was written out FOUR times.
//
// ⛔ ORDER IS THE CONTRACT, not a suggestion. Each pass assumes the previous one
// ran: `enforceMinCeilingGap` closes gaps that `fixDiagonalCeilingPinch` and
// `removeCeilingProtrusions` can open, `ensureCeilingConnectivity` needs those
// gaps closed before it can judge connectivity, and `addOverhang` must run last
// because it reads the finished ceiling to decide where rock hangs.
//
// ⛔ `openEntranceLanding` MUST be called AFTER `addOverhang` — the overhang pass
// re-walls the pocket otherwise. It is deliberately NOT part of the chain for
// that reason. Same for `sealTinyPockets`, which runs at the very end of
// `generateFloor` once the trap swap has happened.

import { CEILING, WALL_ROCKY, FALSE_CEILING, FLOOR, BONES, CHEST, FILL_VOID, isFloorTile,
  PASSAGE, PASSAGE_BTM, PASSAGE_ENTRY, STAIRS_DOWN, STAIR_ARCH, EXIT_PREV, EVENT_TILE } from './tiles.js';

export // Ensure every $00 tile connects to at least one other $00 (cardinal).
// Isolated $00 tiles get demoted to $01 so they don't float alone.
function ensureCeilingConnectivity(tilemap) {
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      if (tilemap[y * 32 + x] !== CEILING) continue;
      const connected =
        (x > 0 && tilemap[y * 32 + x - 1] === CEILING) ||
        (x < 31 && tilemap[y * 32 + x + 1] === CEILING) ||
        (y > 0 && tilemap[(y - 1) * 32 + x] === CEILING) ||
        (y < 31 && tilemap[(y + 1) * 32 + x] === CEILING);
      if (!connected) tilemap[y * 32 + x] = WALL_ROCKY;
    }
  }
}

export // Enforce minimum 3-tile vertical gap between ceiling tiles in each column.
// If a non-ceiling run BETWEEN two ceilings is shorter than 3, close it to ceiling.
// This prevents overhang from filling narrow gaps entirely with wall (no walkable floor).
// FALSE_CEILING ($44) counts as ceiling for gap purposes (visually identical).
// Only converts safe tiles (FLOOR, WALL_ROCKY, FILL_VOID, BONES) — never special tiles.
// NEVER touches entrance or exit blocks — runs at the top/bottom of a column (no ceiling
// above or below) are not gaps and are left untouched.
function enforceMinCeilingGap(tilemap) {
  const isCeiling = t => t === CEILING || t === FALSE_CEILING;
  const safeToConvert = t => t === FLOOR || t === WALL_ROCKY || t === FILL_VOID || t === BONES;
  for (let x = 0; x < 32; x++) {
    let y = 0;
    let seenCeiling = false;
    while (y < 32) {
      if (isCeiling(tilemap[y * 32 + x])) { seenCeiling = true; y++; continue; }
      const runStart = y;
      while (y < 32 && !isCeiling(tilemap[y * 32 + x])) y++;
      const runLen = y - runStart;
      // Only fill gaps BETWEEN two ceilings (ceiling above AND below)
      if (seenCeiling && runLen < 3 && y < 32) {
        for (let ry = runStart; ry < runStart + runLen; ry++) {
          if (safeToConvert(tilemap[ry * 32 + x])) {
            tilemap[ry * 32 + x] = CEILING;
          }
        }
      }
    }
  }
}

export // Fix diagonal ceiling pairs that block floor paths after overhang.
// If CEILING at (x,y) and (x±1,y+1) with both cross tiles non-ceiling,
// the staggered overhang creates walls at different rows in adjacent columns,
// blocking horizontal movement. Fix by converting the lower ceiling to FLOOR.
function fixDiagonalCeilingPinch(tilemap) {
  let changed = true;
  while (changed) {
    changed = false;
    for (let y = 0; y < 31; y++) {
      for (let x = 0; x < 31; x++) {
        // SE diagonal: CEILING at (x,y) and (x+1,y+1)
        if (tilemap[y * 32 + x] === CEILING && tilemap[(y + 1) * 32 + (x + 1)] === CEILING) {
          if (tilemap[y * 32 + (x + 1)] !== CEILING && tilemap[(y + 1) * 32 + x] !== CEILING) {
            tilemap[(y + 1) * 32 + (x + 1)] = FLOOR;
            changed = true;
          }
        }
        // SW diagonal: CEILING at (x+1,y) and (x,y+1)
        if (tilemap[y * 32 + (x + 1)] === CEILING && tilemap[(y + 1) * 32 + x] === CEILING) {
          if (tilemap[y * 32 + x] !== CEILING && tilemap[(y + 1) * 32 + (x + 1)] !== CEILING) {
            tilemap[(y + 1) * 32 + x] = FLOOR;
            changed = true;
          }
        }
      }
    }
  }
}

// Add $01 rocky wall overhang below ALL $00 tiles.
// Every ceiling tile must have something under it: another $00, or 2 rows of $01.
export function addOverhang(tilemap) {
  const marks = [];
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      if (tilemap[y * 32 + x] !== CEILING) continue;
      for (let dy = 1; dy <= 2; dy++) {
        const ny = y + dy;
        if (ny < 32) marks.push(ny * 32 + x);
      }
    }
  }
  for (const idx of marks) {
    const t = tilemap[idx];
    if (t === FLOOR || t === FILL_VOID || t === BONES) {
      tilemap[idx] = WALL_ROCKY;
    }
  }
}

// Remove thin ceiling protrusions BEFORE overhang.
// A 1-wide ceiling column/row sticking into floor creates overhang walls
// that protrude into the walkable area. Removing the ceiling tile at the
// source prevents overhang from ever generating those walls.
// Only removes ceiling tiles with FLOOR on opposing cardinal sides.
export function removeCeilingProtrusions(tilemap) {
  let changed = true;
  while (changed) {
    changed = false;
    for (let y = 1; y < 31; y++) {
      for (let x = 1; x < 31; x++) {
        if (tilemap[y * 32 + x] !== CEILING) continue;
        const left  = tilemap[y * 32 + (x - 1)];
        const right = tilemap[y * 32 + (x + 1)];
        const up    = tilemap[(y - 1) * 32 + x];
        const down  = tilemap[(y + 1) * 32 + x];
        if (isFloorTile(left) && isFloorTile(right)) {
          tilemap[y * 32 + x] = FLOOR;
          changed = true;
          continue;
        }
        if (isFloorTile(up) && isFloorTile(down)) {
          tilemap[y * 32 + x] = FLOOR;
          changed = true;
        }
      }
    }
  }
}

export // LOCKED — Entrance landing template. Opens a 3x3 floor pocket directly below
// the entrance frame so the player ALWAYS arrives in an open area, never a
// 1-tile-wide neck. Pairs with placeEntrance: the frame's bottom row is already
// 3 floor tiles; this carries that width down through the top rocky overhang
// band into the room.
//   MUST be called AFTER addOverhang — otherwise the overhang pass re-walls the
//   pocket. The frame floor sits directly above the landing, so no ceiling
//   pinches it (no overhang-rule violation). `clamp` [x0,x1] keeps the pocket
//   inside the room's column span. DO NOT inline or fork — this is the single
//   source for entrance landings.
function openEntranceLanding(tilemap, entranceX, topRow, clamp) {
  const lo = clamp ? clamp[0] : 1, hi = clamp ? clamp[1] : 30;
  for (let y = topRow; y <= topRow + 2; y++) {
    for (let x = entranceX - 1; x <= entranceX + 1; x++) {
      if (x >= lo && x <= hi && x >= 0 && x < 32 && y >= 0 && y < 32) {
        tilemap[y * 32 + x] = FLOOR;
      }
    }
  }
}

export // ── Tiny sealed pockets ────────────────────────────────────────────────────
// Fill 1-4 tile islands of floor that NOTHING can reach, left behind by the
// carve passes. Two shapes were measured over 150 timestamp seeds per floor:
//   - floor 3, 24 tiles / 23 seeds: the branch-alcove chest is placed ON the
//     dead-end tile, so a fat stretch hanging off that end (or a leftover row
//     of the 3-row carve) has the chest as its only non-solid neighbour;
//   - floor 0, 2 tiles / 1 seed: the organic outline closed a 2-tile pocket
//     inside the rock.
// Both are the same defect — floor you can see and can never stand on.
//
// ⛔ A pocket is sealed ONLY if every neighbouring tile is solid under BOTH
// passability models. `dungeon-sweep.mjs`'s PASS set is deliberately stricter
// than the game's `isPassable` (0x70, 0x04, 0x61, 0x3a-0x3f), so a generic
// "fill what the flood didn't reach" pass would delete real, walkable content.
// SOLID below holds only tiles impassable either way; anything else joins the
// component and grows it past `maxSize`, which is the point.
//
// The other guards, each protecting a documented intentional formation:
//   - the entrance's own component is never touched;
//   - rows >= 22 are the secret teleport room, an INTENTIONAL separate island;
//   - floor 2's rock-switch puzzle room is sealed on purpose and is ~21 tiles,
//     so `maxSize` 4 excludes it (proven in the sweep by opening the switch);
//   - a pocket holding anything but FLOOR/BONES, or any registered trigger, is
//     reported rather than filled — it is carrying content, not decoration.
// Fill material follows `addOverhang`'s rule: rock may hang under rock, so a
// pocket tile with ceiling/rocky above becomes WALL_ROCKY, otherwise CEILING.
// Top-down order so a stacked pocket sees the tile it just filled.
function sealTinyPockets(tilemap, entranceX, entranceY, triggerMap, maxSize = 4) {
  const SOLID = new Set([CEILING, WALL_ROCKY, CHEST, FILL_VOID]);
  const seen = new Uint8Array(1024);
  const entI = entranceY * 32 + entranceX;
  const filled = [];

  for (let start = 0; start < 1024; start++) {
    if (seen[start] || SOLID.has(tilemap[start])) continue;
    // Flood the WHOLE component. ⛔ Do not break out early once it passes
    // `maxSize`: the tiles already queued stop being expanded, whatever sits
    // behind them is never marked `seen`, and the outer scan re-walks that
    // remainder as a fresh "small pocket" and fills it. Measured — an early
    // break took 6 floor-2 seeds DOWN a reachable tile each and cost one seed
    // a whole chest. A 1024-tile flood is free; correctness is not.
    const comp = []; const q = [start]; seen[start] = 1;
    while (q.length) {
      const i = q.pop(); comp.push(i);
      const x = i % 32, y = (i - x) / 32;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx > 31 || ny < 0 || ny > 31) continue;
        const ni = ny * 32 + nx;
        if (seen[ni] || SOLID.has(tilemap[ni])) continue;
        seen[ni] = 1; q.push(ni);
      }
    }
    if (comp.length > maxSize) continue;

    let skip = false;
    for (const i of comp) {
      const x = i % 32, y = (i - x) / 32;
      if (i === entI) skip = true;                                  // the party's own region
      if (y >= 22) skip = true;                                     // secret teleport room
      if (tilemap[i] !== FLOOR && tilemap[i] !== BONES) skip = true; // carries content
      if (triggerMap && triggerMap.has(`${x},${y}`)) skip = true;    // carries a trigger
    }
    if (skip) continue;

    comp.sort((a, b) => a - b); // ascending index == top-down
    for (const i of comp) {
      const above = i >= 32 ? tilemap[i - 32] : CEILING;
      tilemap[i] = (above === CEILING || above === WALL_ROCKY) ? WALL_ROCKY : CEILING;
      filled.push(i);
    }
  }
  return filled;
}

/**
 * The five-pass cave-shaping chain the deep floors end with.
 *
 * ⛔ FLOOR 0 DOES NOT USE THIS, and its comment used to claim it ran "exact
 * passes/order as every other floor" — it does not. Floor 0 runs only
 * `enforceMinCeilingGap` -> `ensureCeilingConnectivity` -> `addOverhang`,
 * skipping the pinch fix and the protrusion removal, because its shape comes
 * from one traced ceiling snake rather than from carved rooms and corridors.
 * That difference is real; do not "fix" floor 0 into calling this.
 */
export function finishCaveShape(tilemap) {
  fixDiagonalCeilingPinch(tilemap);
  removeCeilingProtrusions(tilemap);
  enforceMinCeilingGap(tilemap);
  ensureCeilingConnectivity(tilemap);
  addOverhang(tilemap);
}


/**
 * Tiles the player can actually stand on, flooded from the entrance.
 *
 * ⛔ Anything that digs INTO a floor must start from a reachable tile. Measured:
 * a secret rock tunnel was dug out of `(21,20)` on floor 3 seed 1754901449177 —
 * a leftover floor tile stranded above a branch chest, which `sealTinyPockets`
 * would have quietly filled. Tunnelling from it turned a 1-tile pocket into a
 * 9-tile one, complete with an unreachable chest at the far end. "It is FLOOR"
 * is not "you can get there".
 *
 * ⛔ IT MUST TRAVERSE PASSAGES, not just floor. The first version walked FLOOR,
 * BONES and FALSE_CEILING only — described as "deliberately conservative", which
 * was wrong: a deep floor's entrance is a two-tile passage stack ($6a over $6b),
 * so the flood could not get from the entrance to the room at all and returned an
 * EMPTY mask. Floors 1 and 3 silently produced zero tunnels while floor 2, whose
 * entrance sits on plain floor, produced one every seed. An empty mask reads
 * exactly like "nowhere qualifies".
 *
 * Traverse everything the player can walk over; callers still choose what a spot
 * must BE (the tunnel finder requires plain FLOOR to dig from).
 */
export function reachableFloorMask(tilemap, entranceX, entranceY) {
  const seen = new Uint8Array(1024);
  const WALK = new Set([FLOOR, BONES, FALSE_CEILING, PASSAGE, PASSAGE_BTM,
    PASSAGE_ENTRY, STAIRS_DOWN, STAIR_ARCH, EXIT_PREV, EVENT_TILE]);
  const walkable = (t) => WALK.has(t);
  const q = [];
  const push = (x, y) => {
    if (x < 0 || x > 31 || y < 0 || y > 31) return;
    const i = y * 32 + x;
    if (!seen[i] && walkable(tilemap[i])) { seen[i] = 1; q.push(i); }
  };
  push(entranceX, entranceY);
  push(entranceX + 1, entranceY); push(entranceX - 1, entranceY);
  push(entranceX, entranceY + 1); push(entranceX, entranceY - 1);
  while (q.length) {
    const i = q.pop(); const x = i % 32, y = (i - x) / 32;
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }
  return seen;
}


/**
 * Break up the overhang band so it follows the floor's contour instead of
 * bounding it as a rectangle.
 *
 * `addOverhang` lays EXACTLY two rocky rows under every ceiling tile, which is
 * why our rooms read as rectangles with a uniform dark lid while the cartridge's
 * caves (ROM maps 22/113/115) have a dark band that wanders 1-3 tiles deep. See
 * §0 of the chambers plan.
 *
 * ⛔ IT GROWS UPWARD, INTO THE ROCK — never downward. Extending the band down
 * converts FLOOR to WALL_ROCKY, which shrinks every room by a row, and the rooms
 * are carved at a height that assumes the overhang eats exactly two. Growing up
 * costs no walkable area at all, and it keeps both wall invariants: the promoted
 * tile has rock below it and ceiling above, and the ceiling above it now has
 * THREE rocky tiles beneath rather than two.
 *
 * ⛔ ONLY WHERE THE CEILING IS THICK. Floor 0's ceiling is a single-tile lip
 * tracing the cave silhouette — the "snake" — and turning one of its tiles to
 * rock would cut it. The promoted tile must have at least two more ceiling rows
 * above it, which confines this to slab interiors and leaves every snake lip
 * alone.
 */
export function roughenOverhang(tilemap, rng, { chance = 0.38 } = {}) {
  const promote = [];
  for (let y = 3; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const i = y * 32 + x;
      if (tilemap[i] !== WALL_ROCKY) continue;
      const above = (y - 1) * 32 + x;
      if (tilemap[above] !== CEILING) continue;          // only the band's top
      // Thick ceiling above, so promoting one tile cannot cut a snake.
      if (tilemap[(y - 2) * 32 + x] !== CEILING) continue;
      if (tilemap[(y - 3) * 32 + x] !== CEILING) continue;
      if (rng() < chance) promote.push(above);
    }
  }
  for (const i of promote) tilemap[i] = WALL_ROCKY;
  return promote.length;
}
