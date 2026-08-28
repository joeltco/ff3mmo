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


/**
 * The first open tile on an expanding ring around `(cx, cy)`.
 *
 * ⛔ THE SAME SPIRAL WAS WRITTEN TWICE IN `npc.js` — once to drop the moogle in
 * floor 0's opening room, once to stand Sara in the Cave of Seals' exit chamber
 * — and neither copy could be reached from a tool, because `npc.js` pulls in
 * `boot.js` and the message box and will not load outside a browser. A gate that
 * wants to ask "where does she actually end up on 400 seeds" then has to
 * hand-copy the search, which is the one thing `CLAUDE.md` says never to do:
 * a tool that disagrees with the game is worse than no tool.
 *
 * `minR` starts the ring OUT from the centre. Sara's chamber is found from its
 * `PASSAGE_ENTRY` tile and she is not walkable, so standing her on the tile you
 * step onto to descend would seal the floor — she starts two rings out.
 *
 * @returns {{x:number,y:number}|null}
 */
export function findOpenSpotNear(mapData, cx, cy, { minR = 0, maxR = 12 } = {}) {
  for (let r = minR; r < maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const tx = cx + dx, ty = cy + dy;
        if (!isOpenAreaTile(mapData, tx, ty)) continue;
        return { x: tx, y: ty };
      }
    }
  }
  return null;
}

/**
 * Where Princess Sara stands on the Cave of Seals' floor 1 — derived from the
 * map rather than written down, because the floor is carved fresh every entry.
 *
 * `boulder-chamber` puts the way down (`PASSAGE_ENTRY`, $6a) inside the exit
 * chamber, so that tile IS the chamber.
 *
 * ⛔ THERE ARE TWO `$6a` TILES ON THAT FLOOR, AND THE FIRST ONE IS THE WAY IN.
 * The floor is ENTERED through a passage arch as well as left through one, and
 * the arrival arch scans first — so "find the passage tile" put Sara two rows
 * below the entrance, inside its one-wide neck, on 400 of 400 seeds. She is not
 * walkable: it sealed the floor on 242 of them.
 *
 * The map already says which is which. `entranceX/entranceY` IS the arrival
 * tile (`boulder-chamber` sets them to the arch's own `PASSAGE_ENTRY` row), so
 * the exit is the other one. Derived, not guessed at by scan order.
 */
export function findExitChamberSpot(mapData) {
  const tm = mapData && mapData.tilemap;
  if (!tm) return null;
  const PASSAGE_ENTRY = 0x6a;
  const ex = mapData.entranceX, ey = mapData.entranceY;
  let px = -1, py = -1;
  for (let i = 0; i < 1024; i++) {
    if (tm[i] !== PASSAGE_ENTRY) continue;
    const x = i % 32, y = (i - (i % 32)) / 32;
    if (x === ex && y === ey) continue;            // that is the way IN
    px = x; py = y; break;
  }
  if (px < 0) return null;

  // ⛔ AND SHE IS AS SOLID AS A BOULDER, IN A ROOM THIS SIZE.
  //
  // The exit chamber is five tiles across. "Two rings out from the passage" is
  // far enough not to stand ON the approach and nowhere near far enough to be
  // safe: measured, she cut the way down on 226 of 400 seeds — the player opens
  // the wall, walks in, and the staircase is behind the princess.
  //
  // Same test the boulder gets, for the same reason: BLOCK IT AND REFLOOD. A
  // spot she may stand on is one the passage survives.
  const open = Uint8Array.from(tm);
  const rs = mapData.rockSwitch;
  if (rs && rs.wallTiles) for (const w of rs.wallTiles) open[w.y * 32 + w.x] = w.newTile;
  const reaches = (bx, by) => {
    const seen = new Uint8Array(1024);
    const q = [py * 32 + px];
    seen[q[0]] = 1;
    for (let h = 0; h < q.length; h++) {
      const i = q[h], x = i % 32, y = (i - x) / 32;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx > 31 || ny < 0 || ny > 31) continue;
        if (nx === bx && ny === by) continue;
        const ni = ny * 32 + nx;
        if (seen[ni]) continue;
        const t = open[ni];
        if (t !== 0x30 && t !== 0x09 && t !== 0x41 && t !== 0x49 && t !== 0x6a) continue;
        seen[ni] = 1; q.push(ni);
      }
    }
    return seen;
  };
  const free = reaches(-1, -1);
  let n = 0; for (let i = 0; i < 1024; i++) if (free[i]) n++;

  for (let r = 2; r < 8; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const tx = px + dx, ty = py + dy;
        if (!isOpenAreaTile(mapData, tx, ty)) continue;
        if (!free[ty * 32 + tx]) continue;         // not even in this chamber
        const after = reaches(tx, ty);
        let m = 0; for (let i = 0; i < 1024; i++) if (after[i]) m++;
        if (m === n - 1) return { x: tx, y: ty };  // costs exactly herself
      }
    }
  }
  return null;
}
