// Where a WANDERING NPC is allowed to stand.
//
// Node-clean and import-free so `src/npc.js` and the placement gate share the
// REAL rule instead of restating it.
//
// A wanderer only steps onto a tile with at least MIN_OPEN_NEIGHBOURS walkable
// neighbours (`npc.js#_startWalk` / `_trySameDir` both test the destination
// with `isOpenAreaTile`). The consequence is easy to miss when PLACING one:
// an NPC that starts on a tile the wander logic would never step onto can
// never legally move off it either. It stands there for the life of the save.
//
// That shipped in v1.8.13 — a Kazus townsman was placed on a 1-neighbour tile,
// which is a doorway, and stood in the inn's door permanently. Hence the gate.
export const MIN_OPEN_NEIGHBOURS = 3;

export function isWalkableForNpc(mapData, x, y) {
  if (!mapData) return false;
  const raw = mapData.tilemap[y * 32 + x];
  if (raw === undefined) return false;
  const m = raw < 128 ? raw : raw & 0x7F;
  const coll = mapData.collision[m];
  return (coll & 0x07) !== 3 && !(coll & 0x80);
}

/** Enough elbow room for a wanderer to stand on AND step off. */
export function isOpenAreaTile(mapData, x, y) {
  if (!mapData) return false;
  if (x < 1 || x > 30 || y < 1 || y > 30) return false;
  if (!isWalkableForNpc(mapData, x, y)) return false;
  let n = 0;
  if (isWalkableForNpc(mapData, x + 1, y)) n++;
  if (isWalkableForNpc(mapData, x - 1, y)) n++;
  if (isWalkableForNpc(mapData, x, y + 1)) n++;
  if (isWalkableForNpc(mapData, x, y - 1)) n++;
  return n >= MIN_OPEN_NEIGHBOURS;
}
