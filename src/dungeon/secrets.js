// Boulder-switch secrets — a sealed side chamber opened by pushing a rock.
//
// ⛔ THIS IS FLOOR 2'S EXISTING MECHANISM, NOT A NEW ONE. `mapSt.rockSwitch`
// already carries `{ rocks, wallTiles }`; `movement.js` fires on facing a rock,
// and `handleRockPuzzle` shakes the screen and swaps each wall tile. Nothing here
// invents a mechanic — it places a second instance of the one the game has.
//
// ⛔ AND IT IS VISIBLE ON PURPOSE. The previous attempt at secrets below floor 0
// (v1.10.33, reverted) disguised a doorway tile so the wall LOOKED solid; because
// dungeon floors draw the whole tilemap, the passage and its chest were on screen
// anyway and the disguised tile just read as a stray wall blocking an open
// corridor. Floor 2's puzzle room is visible and sealed, and that reads correctly:
// you can see the chamber, you can see it is walled, and you go find the rock.
//
// ⛔ THE BOULDER'S ARRANGEMENT IS COPIED FROM THE CARTRIDGE. Both `$0B` tiles in
// ROM map 22 sit ON the walkable row at the boundary between floor and wall, with
// ROCK directly above and FLOOR below. Placed any other way it stops reading as
// something embedded in the rock.

import { CEILING, WALL_ROCKY, FLOOR, CHEST } from './tiles.js';

const BOULDER = 0x0b;

/**
 * Carve a sealed chamber into solid rock and place the boulder that opens it.
 *
 * Layout, running `dir` from a wall tile beside reachable floor:
 *   [seal][neck][neck][chamber chamber chamber]
 * The seal is real CEILING — a wall, not a disguise — and is what `wallTiles`
 * converts to FLOOR when the rock is pushed.
 *
 * @returns {{rockSwitch: object, chest: {x,y}}|null}
 */
/** Walkable tiles reachable from the entrance, optionally treating `block` as solid. */
function countReach(tilemap, ex, ey, block) {
  const WALK = new Set([FLOOR, 0x09, 0x44, 0x41, 0x49, 0x6a, 0x73, 0x42, 0x68, 0x60]);
  const seen = new Uint8Array(1024); const q = []; let n = 0;
  const push = (x, y) => {
    if (x < 0 || x > 31 || y < 0 || y > 31) return;
    if (block && x === block.x && y === block.y) return;
    const i = y * 32 + x;
    if (!seen[i] && WALK.has(tilemap[i])) { seen[i] = 1; q.push(i); n++; }
  };
  push(ex, ey); push(ex + 1, ey); push(ex - 1, ey); push(ex, ey + 1); push(ex, ey - 1);
  while (q.length) {
    const i = q.pop(); const x = i % 32, y = (i - x) / 32;
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }
  return n;
}

/** Does every chest still have a reachable neighbour once `block` is solid? */
function chestsStillOpenable(tilemap, ex, ey, block) {
  const WALK = new Set([FLOOR, 0x09, 0x44, 0x41, 0x49, 0x6a, 0x73, 0x42, 0x68, 0x60]);
  const seen = new Uint8Array(1024); const q = [];
  const push = (x, y) => {
    if (x < 0 || x > 31 || y < 0 || y > 31) return;
    if (x === block.x && y === block.y) return;
    const i = y * 32 + x;
    if (!seen[i] && WALK.has(tilemap[i])) { seen[i] = 1; q.push(i); }
  };
  push(ex, ey); push(ex + 1, ey); push(ex - 1, ey); push(ex, ey + 1); push(ex, ey - 1);
  while (q.length) {
    const i = q.pop(); const x = i % 32, y = (i - x) / 32;
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }
  for (let i = 0; i < 1024; i++) {
    if (tilemap[i] !== CHEST) continue;
    const x = i % 32, y = (i - x) / 32;
    const ok = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
      const nx = x + dx, ny = y + dy;
      return nx >= 0 && nx < 32 && ny >= 0 && ny < 32 && seen[ny * 32 + nx];
    });
    if (!ok) return false;
  }
  return true;
}

/** Every tile a recorded corridor occupies — boulders must avoid all of them. */
function corridorTiles(plan) {
  const out = new Set();
  const add = (x, y) => { if (x >= 0 && x < 32 && y >= 0 && y < 32) out.add(y * 32 + x); };
  for (const l of (plan?.links || [])) {
    if (l.kind === 'h' || l.kind === 'branch' || l.kind === 'elbow') {
      for (let d = 0; d <= (l.steps ?? 0) + 1; d++) for (const dy of [-2, -1, 0]) add(l.x0 + l.dir * d, l.y + dy);
      if (l.endY != null) for (let y = Math.min(l.y, l.endY); y <= Math.max(l.y, l.endY); y++) add(l.endX, y);
    } else if (l.kind === 'v') {
      for (let d = 0; d <= (l.steps ?? 0) + 1; d++) add(l.x, l.y0 + l.dir * d);
    } else if (l.kind === 'spine') {
      const lo = Math.min(l.yFrom, l.yTo), hi = Math.max(l.yFrom, l.yTo);
      for (let y = lo; y <= hi; y++) { add(l.x, y); add(l.x - 1, y); add(l.x + 1, y); }
    }
  }
  return out;
}

export function placeBoulderSecret(tilemap, rng, { reachable, entranceX, entranceY, plan, neck = 2, room = 3 }) {
  const linkTiles = corridorTiles(plan);
  const need = neck + room + 1;                    // seal + neck + chamber

  // ── 1. Where the sealed chamber goes ────────────────────────────────────
  // A wall tile beside reachable floor, with untouched ceiling behind it for the
  // whole chamber. Rows -3..+2 must be clear: +2 as well, because the chamber
  // widens one row DOWN and the cartridge never puts rock directly below floor.
  const sites = [];
  for (let y = 5; y < 26; y++) {
    for (let x = 3; x < 29; x++) {
      if (tilemap[y * 32 + x] !== FLOOR) continue;
      if (reachable && !reachable[y * 32 + x]) continue;
      for (const dir of [-1, 1]) {
        let clear = true;
        for (let d = 1; d <= need && clear; d++) {
          const cx = x + dir * d;
          if (cx < 1 || cx > 30) { clear = false; break; }
          for (const dy of [-3, -2, -1, 0, 1, 2]) {
            if (tilemap[(y + dy) * 32 + cx] !== CEILING) { clear = false; break; }
          }
        }
        if (clear) sites.push({ x, y, dir });
      }
    }
  }
  if (!sites.length) return null;
  const s = sites[Math.floor(rng() * sites.length)];

  // ── 2. Where the boulder goes ───────────────────────────────────────────
  // ⛔ NOT IN THE DOORWAY. The first version put the rock on the approach tile,
  // so opening the wall left the rock itself blocking the way and the chamber
  // stayed unreachable on every seed. Floor 2 puts its rock inside the room,
  // away from the wall it opens — the switch and the door are separate places.
  // The cartridge's arrangement: on the walkable row, rock directly above.
  const rocks = [];
  for (let y = 4; y < 28; y++) {
    for (let x = 2; x < 30; x++) {
      if (tilemap[y * 32 + x] !== FLOOR) continue;
      if (reachable && !reachable[y * 32 + x]) continue;
      if (tilemap[(y - 1) * 32 + x] !== WALL_ROCKY) continue;   // embedded in the wall
      if (Math.abs(x - s.x) + Math.abs(y - s.y) < 3) continue;  // clear of the doorway
      // ⛔ NEVER ON A CORRIDOR. The rock stays put once pushed — only the wall it
      // opens changes — so a rock in a passage is a permanent obstruction. On a
      // `loop` floor it landed on the ring itself, and cutting the loop then
      // stranded 21 tiles: the topology stopped being a circuit. Floor 2 puts
      // its rock at a room corner and both of the cartridge's sit at a room's
      // edge; corridors stay clear.
      if (linkTiles.has(y * 32 + x)) continue;
      // ⛔ AT A CORNER, not adrift in an open row. Floor 2's existing puzzle
      // picks the floor tile nearest a room corner, and both of the cartridge's
      // boulders sit against solid on one side — a rock in the middle of a
      // walkable row reads as scenery you walk around, not as something set into
      // the wall. Two ROM samples are not enough to call that a law on their own,
      // which is why this follows OUR shipped convention as well.
      const solid = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => {
        const t = tilemap[(y + dy) * 32 + (x + dx)];
        return t === CEILING || t === WALL_ROCKY;
      }).length;
      if (solid < 2) continue;
      rocks.push({ x, y });
    }
  }
  if (!rocks.length) return null;

  // ⛔ THE BOULDER IS IMPASSABLE, so dropping it on a corridor tile SEVERS the
  // floor. Measured: placing it on any reachable floor tile stranded a single
  // tile on some seeds and, on floor 3, cut off 30 tiles AND the exit to the
  // crystal room. Floor 2 avoids this by placing its rock at a room CORNER; a
  // corner test is a proxy, so verify the real thing instead — block the
  // candidate and re-flood, and accept only a tile whose loss costs nothing but
  // itself.
  for (let i = rocks.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [rocks[i], rocks[j]] = [rocks[j], rocks[i]];
  }
  // ⛔ ON A `loop` FLOOR, TEST THE RING TOO. Excluding corridor tiles was not
  // enough: the ring runs THROUGH a side room, and a rock placed in the room can
  // still break it. Rather than approximate where the ring goes, cut the loop's
  // closing link and re-run the same reachability test on top — which is exactly
  // what `check-floor-plan` does when it verifies the circuit.
  const loopLink = plan?.topology === 'loop' ? (plan.links || []).find((l) => l.kind === 'v') : null;
  const cutMap = loopLink ? tilemap.slice() : null;
  if (loopLink) {
    for (let step = 1; step <= loopLink.steps; step++) {
      const y = loopLink.y0 + loopLink.dir * step;
      if (y >= 0 && y < 32) cutMap[y * 32 + loopLink.x] = CEILING;
    }
  }

  let rock = null;
  const before = countReach(tilemap, entranceX, entranceY, null);
  const beforeCut = cutMap ? countReach(cutMap, entranceX, entranceY, null) : 0;
  for (const cand of rocks) {
    if (countReach(tilemap, entranceX, entranceY, cand) !== before - 1) continue;
    if (cutMap && countReach(cutMap, entranceX, entranceY, cand) !== beforeCut - 1) continue;
    // ⛔ AND IT MUST NOT WALL IN A CHEST. A chest is not walkable, so a count of
    // reachable TILES cannot see one become unopenable — the same blind spot
    // that once reported 300/300 locked-room chests as broken. Measured: the
    // rock landed directly beside a branch-alcove chest and took its only
    // approach tile, on roughly one seed in four hundred.
    if (!chestsStillOpenable(tilemap, entranceX, entranceY, cand)) continue;
    rock = cand; break;
  }
  if (!rock) return null;

  // ── 3. Carve ────────────────────────────────────────────────────────────
  const wallTiles = [];
  const sealX = s.x + s.dir;
  for (let dy = -2; dy <= 0; dy++) {
    tilemap[(s.y + dy) * 32 + sealX] = CEILING;
    wallTiles.push({ x: sealX, y: s.y + dy, newTile: dy === 0 ? FLOOR : WALL_ROCKY });
  }
  for (let d = 2; d <= need; d++) {
    const cx = s.x + s.dir * d;
    tilemap[s.y * 32 + cx] = FLOOR;
    tilemap[(s.y - 1) * 32 + cx] = WALL_ROCKY;
    tilemap[(s.y - 2) * 32 + cx] = WALL_ROCKY;
  }
  const farX = s.x + s.dir * need;
  for (let d = 0; d < room; d++) tilemap[(s.y + 1) * 32 + (farX - s.dir * d)] = FLOOR;

  const chest = { x: farX, y: s.y };
  tilemap[chest.y * 32 + chest.x] = CHEST;
  tilemap[rock.y * 32 + rock.x] = BOULDER;
  return { rockSwitch: { rocks: [rock], wallTiles }, chest };
}
