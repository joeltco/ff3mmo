// talkable.mjs — the ONE definition of "the player can reach this tile and
// talk to whoever is standing on it".
//
// Two tools need it (check-npc-room.mjs gates it, ur-audit.mjs reports it) and
// a hand-copy in each would drift — which is exactly how `calcSpawnY` ended up
// with four divergent copies and a viewer that disagreed with the game.
//
// The rule has to handle three real FF3 layouts and reject a fourth:
//   1. NPC on the floor beside you            -> orthogonally adjacent
//   2. Shop keeper behind a solid counter     -> player, counter, keeper in a
//      straight line (map 4: floor row 6, counter row 5, keeper row 4)
//   3. NOT a diagonal through a wall
//   4. NOT "reachable" only from a door tile — stepping on a door transitions
//      the map, so the player can never stand there to talk. Map 2's ROM NPCs
//      at (6,24)/(8,24) sit under the northern house's exit and are only
//      approachable that way, which is why that room is legitimately empty.

const W = 32;

/** True if this tile is an exit / door trigger — walkable but not standable. */
export function isTransitionTile(md, x, y) {
  const mid = md.tilemap[y * W + x];
  const c = md.collision[mid < 128 ? mid : mid & 0x7F];
  if (!(c & 0x80)) return false;
  const tt = (md.collisionByte2[mid] >> 4) & 0x0F;
  return tt === 0 || tt === 1 || tt === 4 || tt === 5;
}

/**
 * Flood-fill from the map's real entrance.
 * Returns { sx, sy, reach, stand } — `reach` is everything the player can walk
 * through, `stand` is the subset they can stop on (no door / exit tiles).
 */
export function playerRegion(md, MapRenderer, calcSpawnY) {
  const sx = md.entranceX;
  const sy = calcSpawnY(md, md.entranceX, md.entranceY);
  const renderer = new MapRenderer(md, sx, sy);
  const passable = (x, y) => x >= 0 && x < W && y >= 0 && y < W && renderer.isPassable(x, y);

  const reach = new Set();
  if (passable(sx, sy)) {
    const q = [[sx, sy]];
    reach.add(sy * W + sx);
    while (q.length) {
      const [x, y] = q.pop();
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const nx = x + dx, ny = y + dy, k = ny * W + nx;
        if (reach.has(k) || !passable(nx, ny)) continue;
        reach.add(k); q.push([nx, ny]);
      }
    }
  }
  const stand = new Set();
  for (const k of reach) {
    const x = k % W, y = (k - x) / W;
    if (!isTransitionTile(md, x, y)) stand.add(k);
  }
  return { sx, sy, reach, stand, passable, renderer };
}

/** Can the player stand somewhere and talk to an NPC on (x, y)? */
export function isTalkable(md, stand, x, y) {
  for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
    // Face to face.
    if (stand.has((y + dy) * W + (x + dx))) return true;
    // Across a counter: the tile between must be SOLID (that is the counter),
    // and the one past it standable. Two empty floor tiles apart is not talking
    // distance, and a diagonal is never talking distance.
    const mx = x + dx, my = y + dy;
    if (mx < 0 || mx >= W || my < 0 || my >= W) continue;
    const mid = md.tilemap[my * W + mx];
    const solid = (md.collision[mid < 128 ? mid : mid & 0x7F] & 0x07) === 3 ||
                  !!(md.collision[mid < 128 ? mid : mid & 0x7F] & 0x80);
    // ...and the thing between must be a COUNTER, not a doorway. Map 2's ROM
    // NPC at (8,24) sits directly under the northern house's exit door, so a
    // plain "solid tile between" rule reported the player could talk to them
    // through the door — from inside the house to someone standing outside it.
    if (solid && !isTransitionTile(md, mx, my) &&
        stand.has((y + dy * 2) * W + (x + dx * 2))) return true;
  }
  return false;
}
