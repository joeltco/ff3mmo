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

import { ARRIVAL_ALIASES } from '../../src/data/areas.js';
import { applyPassage } from '../../src/map-passage.js';
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
export function playerRegion(md, MapRenderer, calcSpawnY, mapId = null) {
  if (md.tilemap[16 * 32 + 8] !== 0x32) applyPassage(md.tilemap);
  const sx = md.entranceX, sy = calcSpawnY(md, sx, md.entranceY);
  const renderer = new MapRenderer(md, sx, sy);
  const seeds = [[sx,sy], ...[...ARRIVAL_ALIASES.values()].filter(a => a.map === mapId).map(a => [a.x,a.y])];
  const reach = new Set(), states = new Set(), q = [];
  for (const [x,y] of seeds) {
    const z=renderer.zAfterEntering(x,y,0);
    if(renderer.isPassable(x,y,z)) { q.push([x,y,z]);states.add(`${x},${y},${z}`);reach.add(y*W+x); }
  }
  while(q.length) {
    const [x,y,z]=q.pop();
    for(const [dx,dy] of [[0,1],[0,-1],[1,0],[-1,0]]) {
      const nx=x+dx,ny=y+dy;
      if(nx<0||ny<0||nx>=W||ny>=W||!renderer.isPassable(nx,ny,z))continue;
      const nz=renderer.zAfterEntering(nx,ny,z),key=`${nx},${ny},${nz}`;
      if(states.has(key))continue;
      states.add(key);reach.add(ny*W+nx);q.push([nx,ny,nz]);
    }
  }
  const passable=(x,y)=>x>=0&&x<W&&y>=0&&y<W&&[0,1,2].some(z=>renderer.isPassable(x,y,z));
  const stand=new Set([...reach].filter(k=>!isTransitionTile(md,k%W,Math.floor(k/W))));
  return {sx,sy,reach,stand,passable,renderer};
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
