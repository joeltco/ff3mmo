// Dungeon Generator — procedural cave floors using FF3 tileset 0

import {
  parseMapProperties, loadTileset, loadCHRGraphics,
  buildMapPalettes, buildSpritePalettes, loadTileCollision, loadTileCollisionByte2,
  loadNameTable, processTriggerTiles,
} from './map-loader.js';
import { placeLockedRoom, placeChamberDoor, findChamberDoorPos } from './dungeon-locked-room.js';

// Tile ids live in `dungeon/tiles.js` — a leaf, so tools can read them too.
// `WATER_EDGE_N` used to be TWO constants of the same name here: 0x08 at module
// scope and 0x23 redefined inside floor 3's branch, which shadowed it for
// everything below. They are `WATER_EDGE_POND` and `WATER_EDGE_N` now.
import {
  CEILING, WALL_ROCKY, ENTRANCE_TOP, WATER, WATER_EDGE_POND, BONES, WATER_EDGE_N,
  FLOOR, WARP_A, WARP_B, WARP_C, WARP_D, PASSAGE, STAIR_ARCH, FALSE_CEILING,
  PASSAGE_BTM, FILL_VOID, EVENT_TILE, EXIT_PREV, PASSAGE_ENTRY, DOOR,
  STAIRS_DOWN, TRAP_HOLE, CHEST, isFloorTile,
} from './dungeon/tiles.js';
import { carveChamber, carveWideChamber, carveBoxChamber, carveBottomBump } from './dungeon/chambers.js';
import {
  createPlan, planChamber, planWideChamber, planBoxChamber,
  planHLink, planVLink, planSpine, planBranch, planOrganicRoom, planElbow,
} from './dungeon/plan.js';
import { carveHRun, carveVRun, carveFatteningVRun, carveFatteningHRun, carveBand } from './dungeon/corridors.js';
import { carveBossChamber, resolveBossSkin } from './dungeon/boss-chamber.js';
import { rollChambers, chamberById } from './data/chambers.js';
import { STARTING_DUNGEON, isBossFloor, bossFloorMapId, lockedRoomMapIdForFloor, secretRoomMapIds, layoutForFloor, corridorBounds, snakeBounds, drawRange } from './data/dungeons.js';
import {
  ensureCeilingConnectivity, enforceMinCeilingGap, fixDiagonalCeilingPinch,
  addOverhang, removeCeilingProtrusions, openEntranceLanding, sealTinyPockets,
  finishCaveShape, reachableFloorMask, sealFloorToVoid,
} from './dungeon/shape.js';

// Reference map for tileset/palette/CHR loading
const REF_MAP_ID = 111;

// Mulberry32 PRNG
export function mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ── Cave Outline Generation ──────────────────────────────────────────────

// ⛔ REMOVED in v1.10.22 (phase 1): `generateCaveOutline` was dead — its only caller was `buildCaveShape`.

// Outline generator for path mode: run-based movement with bottom convergence.
// Each wall picks a direction and holds it for several rows (smooth curves, not zigzag).
// Bottom 40%: snakes converge toward each other, forming a V/U shape.
function generateCaveOutlinePath(anchorX, startRow, endRow, rng, maxWidth = 10) {
  const left = new Array(32).fill(0);
  const right = new Array(32).fill(31);
  const totalRows = endRow - startRow;

  left[startRow] = anchorX - 2;
  right[startRow] = anchorX + 2;

  // Track peak width for convergence targeting
  let peakWidth = 4;

  // Run-based: pick direction, hold for several rows
  let lDir = -1, lRun = 2 + Math.floor(rng() * 2); // start expanding outward
  let rDir = 1,  rRun = 2 + Math.floor(rng() * 2);
  // Reversal cooldown: after a move, block opposite direction for 4 rows.
  // This prevents thin indents where overhang fills the entire pocket with $01.
  // With 4-row cooldown, indents are at least 3 interior rows deep
  // (overhang fills 2, leaving 1+ row of floor underneath).
  let lNoRev = 0, rNoRev = 0;
  let lLastNZ = 0, rLastNZ = 0;

  for (let y = startRow + 1; y <= endRow; y++) {
    const progress = (y - startRow) / totalRows;
    const currentWidth = right[y - 1] - left[y - 1];
    if (currentWidth > peakWidth) peakWidth = currentWidth;

    // Left wall: pick new direction when run expires
    if (lRun <= 0) {
      const r = rng();
      if (progress < 0.35) {
        lDir = r < 0.55 ? -1 : r < 0.85 ? 0 : 1;
      } else if (progress < 0.6) {
        lDir = r < 0.3 ? -1 : r < 0.7 ? 0 : 1;
      } else {
        lDir = r < 0.45 ? 1 : r < 0.75 ? 0 : -1;
      }
      lRun = lDir === 0
        ? 2 + Math.floor(rng() * 3)   // straight runs: 2-4 rows
        : 1 + Math.floor(rng() * 2);  // moving runs: 1-2 rows
    }

    // Right wall: pick new direction when run expires (mirrored)
    if (rRun <= 0) {
      const r = rng();
      if (progress < 0.35) {
        rDir = r < 0.55 ? 1 : r < 0.85 ? 0 : -1;
      } else if (progress < 0.6) {
        rDir = r < 0.3 ? 1 : r < 0.7 ? 0 : -1;
      } else {
        rDir = r < 0.45 ? -1 : r < 0.75 ? 0 : 1;
      }
      rRun = rDir === 0
        ? 2 + Math.floor(rng() * 3)
        : 1 + Math.floor(rng() * 2);
    }

    let dl = lDir, dr = rDir;
    lRun--; rRun--;

    // Convergence override: force walls inward when too wide for progress
    if (progress > 0.6) {
      const t = (progress - 0.6) / 0.4; // 0→1 within convergence zone
      const targetWidth = Math.max(3, Math.round(peakWidth * (1 - t * 0.85)));
      if (currentWidth > targetWidth + 2) {
        dl = 1; dr = -1; // both walls inward
      } else if (currentWidth > targetWidth) {
        if (rng() < 0.5) dl = 1; else dr = -1; // one wall inward
      }
    }

    // Block reversal during cooldown (prevents thin indents)
    if (lNoRev > 0 && ((lLastNZ < 0 && dl > 0) || (lLastNZ > 0 && dl < 0))) dl = 0;
    if (rNoRev > 0 && ((rLastNZ > 0 && dr < 0) || (rLastNZ < 0 && dr > 0))) dr = 0;

    left[y] = Math.max(1, left[y - 1] + dl);
    right[y] = Math.min(30, right[y - 1] + dr);

    // Width constraints
    const width = right[y] - left[y];
    const minWidth = progress > 0.85 ? 2 : 4;
    if (width < minWidth) {
      const mid = Math.floor((left[y - 1] + right[y - 1]) / 2);
      left[y] = Math.max(1, mid - Math.ceil(minWidth / 2));
      right[y] = Math.min(30, left[y] + minWidth);
      dl = left[y] - left[y - 1];
      dr = right[y] - right[y - 1];
    }
    if (width > maxWidth) {
      left[y] = left[y - 1]; right[y] = right[y - 1];
      dl = 0; dr = 0;
    }

    // Update reversal cooldowns
    if (dl !== 0) { lLastNZ = dl; lNoRev = 4; } else if (lNoRev > 0) lNoRev--;
    if (dr !== 0) { rLastNZ = dr; rNoRev = 4; } else if (rNoRev > 0) rNoRev--;
  }

  // Force bottom row flat (2-neighbor guarantee at corners where snakes meet bottom edge)
  left[endRow] = left[endRow - 1];
  right[endRow] = right[endRow - 1];

  return { left, right };
}

// ⛔ REMOVED in v1.10.22 (phase 1): `buildCaveShape` was dead — nothing called it, yet design-notes documented its parameters as though it were live.






// ── Feature Placement Helpers ────────────────────────────────────────────


export function findRandomFloor(tilemap, rng, used, bounds) {
  const candidates = [];
  for (let i = 0; i < 1024; i++) {
    if (!isFloorTile(tilemap[i])) continue;
    const x = i % 32, y = (i - x) / 32;
    if (used.has(`${x},${y}`)) continue;
    if (bounds && (y < bounds.top || y > bounds.bot || x < bounds.left || x > bounds.right)) continue;
    candidates.push({ x, y });
  }
  if (candidates.length === 0) return null;
  return candidates[Math.floor(rng() * candidates.length)];
}

function findFarthestFloor(tilemap, fromX, fromY, used) {
  let best = null, maxDist = 0;
  for (let i = 0; i < 1024; i++) {
    if (!isFloorTile(tilemap[i])) continue;
    const x = i % 32, y = (i - x) / 32;
    if (used.has(`${x},${y}`)) continue;
    const d = Math.abs(x - fromX) + Math.abs(y - fromY);
    if (d > maxDist) { maxDist = d; best = { x, y }; }
  }
  return best;
}

// Find a flat wall edge for exit placement.
// southWall=true: find lowest floor row with 3-wide non-floor below (south edge)
// southWall=false: find highest floor row with 3-wide non-floor above (north edge)
function findExitWallPosition(tilemap, entranceX, entranceY, used, southWall) {
  // BFS to find reachable floor tiles + distances
  const reachable = new Map();
  const queue = [[entranceX, entranceY, 0]];
  reachable.set(entranceY * 32 + entranceX, 0);
  while (queue.length) {
    const [cx, cy, dist] = queue.shift();
    for (const [dx, dy] of [[0,1],[0,-1],[1,0],[-1,0]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || nx > 31 || ny < 0 || ny > 31) continue;
      const idx = ny * 32 + nx;
      if (reachable.has(idx)) continue;
      if (isFloorTile(tilemap[idx])) {
        reachable.set(idx, dist + 1);
        queue.push([nx, ny, dist + 1]);
      }
    }
  }

  let best = null;
  let bestScore = -Infinity;

  for (const [idx, dist] of reachable) {
    const x = idx % 32;
    const y = Math.floor(idx / 32);
    if (used.has(`${x},${y}`)) continue;
    if (tilemap[idx] !== FLOOR) continue;
    if (x < 2 || x > 29) continue;

    if (southWall) {
      // Need non-floor at y+1 across 3 tiles (flat south wall)
      if (y + 2 >= 32) continue;
      let flat = true;
      for (let dx = -1; dx <= 1; dx++) {
        if (tilemap[(y + 1) * 32 + x + dx] === FLOOR) { flat = false; break; }
      }
      if (!flat) continue;
      // Need floor on both sides at y (approach space)
      if (tilemap[y * 32 + (x - 1)] !== FLOOR) continue;
      if (tilemap[y * 32 + (x + 1)] !== FLOOR) continue;
      // Score: prefer highest y (deepest), then farthest from entrance
      const score = y * 1000 + dist;
      if (score > bestScore) { bestScore = score; best = { x, y }; }
    } else {
      // Need non-floor at y-1 across 3 tiles (flat north wall)
      if (y < 3) continue;
      let flat = true;
      for (let dx = -1; dx <= 1; dx++) {
        if (tilemap[(y - 1) * 32 + x + dx] === FLOOR) { flat = false; break; }
      }
      if (!flat) continue;
      // Need non-floor at y-2 (space for void tile)
      if (tilemap[(y - 2) * 32 + x] === FLOOR) continue;
      // Need floor on both sides at y (approach space)
      if (tilemap[y * 32 + (x - 1)] !== FLOOR) continue;
      if (tilemap[y * 32 + (x + 1)] !== FLOOR) continue;
      // One side must already be non-floor for clean closed side
      const leftNonFloor = tilemap[y * 32 + (x - 2)] !== FLOOR;
      const rightNonFloor = tilemap[y * 32 + (x + 2)] !== FLOOR;
      if (!leftNonFloor && !rightNonFloor) continue;
      // Score: prefer lowest y (highest in map), then farthest from entrance
      const score = (31 - y) * 1000 + dist;
      if (score > bestScore) { bestScore = score; best = { x, y }; }
    }
  }

  return best;
}

// ⛔ REMOVED in v1.10.22 (phase 1): `findInteriorFloor` was dead — superseded by `findCornerFloor`.

export function findCornerFloor(tilemap, rng, used, bounds) {
  const candidates = [];
  for (let i = 0; i < 1024; i++) {
    if (!isFloorTile(tilemap[i])) continue;
    const x = i % 32, y = (i - x) / 32;
    if (used.has(`${x},${y}`)) continue;
    if (x < 1 || x > 30 || y < 1 || y > 30) continue;
    if (bounds && (y < bounds.top || y > bounds.bot || x < bounds.left || x > bounds.right)) continue;
    const wL = !isFloorTile(tilemap[y * 32 + x - 1]);
    const wR = !isFloorTile(tilemap[y * 32 + x + 1]);
    const wU = !isFloorTile(tilemap[(y - 1) * 32 + x]);
    const wD = !isFloorTile(tilemap[(y + 1) * 32 + x]);
    if (!((wL || wR) && (wU || wD))) continue;
    // Must be a real ROOM corner, not a 1-wide corridor bend / spur: exactly one
    // wall on each axis, and the interior diagonal is floor (a 2x2+ floor block).
    // A corridor bend has its interior diagonal as wall, so it's rejected — this
    // keeps chests out of hallways.
    const dxIn = (wL && !wR) ? 1 : (wR && !wL) ? -1 : 0;
    const dyIn = (wU && !wD) ? 1 : (wD && !wU) ? -1 : 0;
    if (dxIn === 0 || dyIn === 0) continue;
    if (!isFloorTile(tilemap[(y + dyIn) * 32 + (x + dxIn)])) continue;
    // Must be near actual chamber edge — within 3 tiles of bounds on both wall axes
    if (bounds) {
      const nearL = x - bounds.left <= 3;
      const nearR = bounds.right - x <= 3;
      const nearT = y - bounds.top <= 3;
      const nearB = bounds.bot - y <= 3;
      const nearHoriz = (wL && nearL) || (wR && nearR);
      const nearVert = (wU && nearT) || (wD && nearB);
      if (!nearHoriz || !nearVert) continue;
    }
    candidates.push({ x, y });
  }
  if (candidates.length === 0) return null;
  return candidates[Math.floor(rng() * candidates.length)];
}

/**
 * Standard room-loot scatter: chests in corners (findCornerFloor — 2-wall
 * test + nearness to bounds), skeletons on random floor (findRandomFloor).
 * Used both by the per-chamber feature pass and by the standalone
 * locked-room / secret-room map generators so all rooms use the same
 * placement system. v1.7.666.
 *
 * @param {Uint8Array} tilemap
 * @param {Function}   rng
 * @param {object}     bounds  {top, bot, left, right}
 * @param {object}     [opts]
 * @param {number}     [opts.chests=0]
 * @param {number}     [opts.skeletons=0]
 * @param {Set}        [opts.used]  pre-seeded exclusion set; extended.
 * @returns {{chests: Array, skeletons: Array, used: Set}}
 */
export function scatterRoomLoot(tilemap, rng, bounds, opts = {}) {
  const { chests = 0, skeletons = 0, used = new Set() } = opts;
  const placedChests = [];
  const placedBones = [];
  for (let i = 0; i < chests; i++) {
    const pos = findCornerFloor(tilemap, rng, used, bounds);
    if (!pos) break;
    tilemap[pos.y * 32 + pos.x] = CHEST;
    used.add(`${pos.x},${pos.y}`);
    placedChests.push(pos);
  }
  for (let i = 0; i < skeletons; i++) {
    const pos = findRandomFloor(tilemap, rng, used, bounds);
    if (!pos) break;
    tilemap[pos.y * 32 + pos.x] = BONES;
    used.add(`${pos.x},${pos.y}`);
    placedBones.push(pos);
  }
  return { chests: placedChests, skeletons: placedBones, used };
}

function findWallAdjacentFloor(tilemap, rng, used) {
  const candidates = [];
  for (let i = 0; i < 1024; i++) {
    if (!isFloorTile(tilemap[i])) continue;
    const x = i % 32, y = (i - x) / 32;
    if (used.has(`${x},${y}`)) continue;
    const hasWall = [[-1,0],[1,0],[0,-1],[0,1]].some(([ox, oy]) => {
      const nx = x + ox, ny = y + oy;
      if (nx < 0 || nx >= 32 || ny < 0 || ny >= 32) return false;
      const nt = tilemap[ny * 32 + nx];
      return nt === CEILING || nt === WALL_ROCKY;
    });
    if (hasWall) candidates.push({ x, y });
  }
  if (candidates.length === 0) return null;
  return candidates[Math.floor(rng() * candidates.length)];
}

function findSecretWallSpot(tilemap, rng, used) {
  const candidates = [];
  for (let y = 1; y < 31; y++) {
    for (let x = 1; x < 31; x++) {
      if (tilemap[y * 32 + x] !== CEILING) continue;
      if (used.has(`${x},${y}`)) continue;
      const lf = isFloorTile(tilemap[y * 32 + x - 1]);
      const rf = isFloorTile(tilemap[y * 32 + x + 1]);
      const uf = isFloorTile(tilemap[(y - 1) * 32 + x]);
      const df = isFloorTile(tilemap[(y + 1) * 32 + x]);
      if ((lf && rf) || (uf && df)) candidates.push({ x, y });
    }
  }
  if (candidates.length === 0) return null;
  return candidates[Math.floor(rng() * candidates.length)];
}

function placePond(tilemap, rng, used, bounds = null) {
  const pw = rng() < 0.5 ? 2 : 3;
  const ph = 2;
  for (let attempt = 0; attempt < 50; attempt++) {
    const pos = findRandomFloor(tilemap, rng, used, bounds);
    if (!pos) return;
    let ok = true;
    for (let dy = 0; dy < ph && ok; dy++) {
      for (let dx = 0; dx < pw && ok; dx++) {
        const nx = pos.x + dx, ny = pos.y + dy;
        if (nx >= 32 || ny >= 32) { ok = false; continue; }
        if (!isFloorTile(tilemap[ny * 32 + nx]) || used.has(`${nx},${ny}`)) ok = false;
      }
    }
    if (!ok) continue;
    for (let dy = 0; dy < ph; dy++) {
      for (let dx = 0; dx < pw; dx++) {
        const nx = pos.x + dx, ny = pos.y + dy;
        const isEdge = dx === 0 || dx === pw - 1 || dy === 0 || dy === ph - 1;
        tilemap[ny * 32 + nx] = (isEdge && pw > 2) ? WATER_EDGE_POND : WATER;
        used.add(`${nx},${ny}`);
      }
    }
    return;
  }
}


// ── Chamber features ───────────────────────────────────────────────────────

/**
 * How many tiles can the player reach, with `blocked` treated as solid?
 *
 * ⛔ THE ONE HONEST TEST FOR "MAY I PUT A ROCK HERE". A rock tile is impassable
 * and permanent, so dropping one on a corridor tile severs the floor — v1.10.42
 * paid for that once ("it cut 30 tiles and the exit"), and the longer corridors
 * in v1.10.97 brought it straight back. A candidate that severs nothing costs
 * exactly itself; anything else is a cut. No amount of looking at the tile, or
 * at which corner it sits in, can tell you this.
 */
function reachableCount(tilemap, ex, ey, blocked = null) {
  const seen = new Uint8Array(1024);
  const start = ey * 32 + ex;
  seen[start] = 1;
  const q = [start];
  let n = 0;
  for (let h = 0; h < q.length; h++) {
    const i = q[h]; n++;
    const x = i % 32, y = (i - x) / 32;
    for (const [dx, dy] of [[0,1],[0,-1],[1,0],[-1,0]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx > 31 || ny < 0 || ny > 31) continue;
      if (blocked && blocked.has(`${nx},${ny}`)) continue;
      const ni = ny * 32 + nx;
      if (seen[ni]) continue;
      const t = tilemap[ni];
      if (t !== FLOOR && t !== BONES && t !== PASSAGE_BTM && t !== PASSAGE_ENTRY) continue;
      seen[ni] = 1; q.push(ni);
    }
  }
  return n;
}

/**
 * Do whatever a chamber type says its room becomes.
 *
 * ⛔ EVERY `feature` ID IN `data/chambers.js` NEEDS A CASE HERE. A typo'd or
 * unimplemented id would otherwise be a chamber that rolls, records itself in
 * the plan, prints in the tools and does NOTHING — the most expensive kind of
 * silent failure, because every gate reports it as present.
 * `tools/check-chambers.mjs` walks the catalogue against this switch.
 */
function applyChamberFeature(feature, tilemap, rng, bounds, used, entranceX, entranceY) {
  switch (feature) {
    case null:
    case undefined:
      return 'plain';
    case 'traps':
      // Trap holes are placed by the shared pass from `LAYOUT_CONFIG.traps`,
      // because their count is a property of the FLOOR (they are the descent),
      // not of the room. Declared here so the catalogue is complete and the
      // gate can see the id is known rather than missing.
      return 'traps (placed by the floor)';
    case 'bones': {
      const n = 3 + Math.floor(rng() * 3);
      const r = scatterRoomLoot(tilemap, rng, bounds, { skeletons: n, used });
      return `bones x${r.skeletons.length}`;
    }
    case 'vault': {
      // ⛔ CHESTS NEED SPACING OR THEY WALL EACH OTHER IN. `scatterRoomLoot`
      // marks only the chest's own tile used, so two of them landed orthogonally
      // adjacent — and a chest is not walkable, so the inner one had no reachable
      // neighbour and became unopenable. The floor's own chest loop has always
      // added a 7x7 exclusion for exactly this reason; the catalogue has to do
      // the same. Caught by `dungeon-sweep`'s chest audit, not by looking.
      const n = 1 + Math.floor(rng() * 2);
      let placed = 0;
      for (let i = 0; i < n; i++) {
        const r = scatterRoomLoot(tilemap, rng, bounds, { chests: 1, used });
        if (!r.chests.length) break;
        const p = r.chests[0];
        placed++;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) used.add(`${p.x + dx},${p.y + dy}`);
      }
      return `chests x${placed}`;
    }
    default:
      throw new Error(`chamber feature '${feature}' has no implementation`);
  }
}

function countWater(tilemap) {
  let n = 0;
  for (let i = 0; i < 1024; i++) if (tilemap[i] === WATER || tilemap[i] === WATER_EDGE_POND) n++;
  return n;
}

// Find candidate spots for a secret corridor on one side of the cave.
// Needs: $00 at (x,y) with $00 above/below/above-2/above-3, cave interior inside, void outside.
// Void clearance: 5 rows (wy-3 to wy+1) at d=1..4 for the corridor body.
function findCorridorCandidates(tilemap, startRow, endRow, goLeft) {
  const candidates = [];
  for (let y = startRow + 4; y <= endRow - 2; y++) {
    if (y - 3 < 0 || y + 1 >= 32) continue;
    if (goLeft) {
      // Outer-left wall only (cols 3-7). Staying clear of the center keeps the
      // secret corridor from carving through the room-connecting neck.
      for (let x = 3; x < 8; x++) {
        if (tilemap[y * 32 + x] !== CEILING) continue;
        // ⛔ CHECK TWO TILES IN, NOT ONE. A single walkable tile behind the wall
        // can be an isolated nook rather than the room: measured on floor 0 seed
        // 1799000372193, the tile at x+1 was FLOOR and the one at x+2 was
        // CEILING, so the corridor opened into a one-tile pocket and the whole
        // 5-tile run was sealed off. `sealTinyPockets` caps at 4, so it survived
        // all the way to the sweep as "5 sealed pocket tiles". Latent for as
        // long as the corridor existed; v1.10.31's room sampling started landing
        // on it.
        const inside = tilemap[y * 32 + x + 1];
        if (inside !== FLOOR && inside !== BONES && inside !== WALL_ROCKY) continue;
        const beyond = x + 2 <= 31 ? tilemap[y * 32 + x + 2] : CEILING;
        if (beyond !== FLOOR && beyond !== BONES) continue;
        if (tilemap[y * 32 + x - 1] !== FILL_VOID) continue;
        if (tilemap[(y - 1) * 32 + x] !== CEILING) continue;
        if (tilemap[(y + 1) * 32 + x] !== CEILING) continue;
        if (tilemap[(y - 2) * 32 + x] !== CEILING) continue;
        if (tilemap[(y - 3) * 32 + x] !== CEILING) continue;
        // Need 4 tiles of void at rows wy-3 through wy+1
        let space = true;
        for (let d = 1; d <= 4 && space; d++) {
          const cx = x - d;
          if (cx < 1) { space = false; break; }
          for (let dy = -3; dy <= 1; dy++) {
            if (tilemap[(y + dy) * 32 + cx] !== FILL_VOID) { space = false; break; }
          }
        }
        if (space) { candidates.push({ x, y }); break; }
      }
    } else {
      // Outer-right wall only (cols 24-29) — clear of the center neck.
      for (let x = 29; x > 23; x--) {
        if (tilemap[y * 32 + x] !== CEILING) continue;
        const inside = tilemap[y * 32 + x - 1];
        if (inside !== FLOOR && inside !== BONES && inside !== WALL_ROCKY) continue;
        const beyond = x - 2 >= 0 ? tilemap[y * 32 + x - 2] : CEILING;   // see the left scan
        if (beyond !== FLOOR && beyond !== BONES) continue;
        if (tilemap[y * 32 + x + 1] !== FILL_VOID) continue;
        if (tilemap[(y - 1) * 32 + x] !== CEILING) continue;
        if (tilemap[(y + 1) * 32 + x] !== CEILING) continue;
        if (tilemap[(y - 2) * 32 + x] !== CEILING) continue;
        if (tilemap[(y - 3) * 32 + x] !== CEILING) continue;
        let space = true;
        for (let d = 1; d <= 4 && space; d++) {
          const cx = x + d;
          if (cx > 30) { space = false; break; }
          for (let dy = -3; dy <= 1; dy++) {
            if (tilemap[(y + dy) * 32 + cx] !== FILL_VOID) { space = false; break; }
          }
        }
        if (space) { candidates.push({ x, y }); break; }
      }
    }
  }
  return candidates;
}

// Carve a corridor as a snake detour — the $00 border IS the snake.
// The snake at (wx, wy-3) turns outward, traces top border → end cap → bottom border,
// and reconnects at (wx, wy+1). The opening at (wx, wy) becomes floor.
// Cross-section: $00(wy-3), $01(wy-2), $01(wy-1), $30(wy), $00(wy+1), $01(wy+2), $01(wy+3)
// Snake connectivity is guaranteed by construction.
function carveCorridor(tilemap, candidates, goLeft, isFalse, rng) {
  if (candidates.length === 0) return null;
  const spot = candidates[Math.floor(rng() * candidates.length)];
  const wx = spot.x, wy = spot.y;
  const dir = goLeft ? -1 : 1;

  // Ensure cave interior tile next to opening is walkable
  const insideX = wx - dir;
  if (insideX >= 0 && insideX < 32) tilemap[wy * 32 + insideX] = FLOOR;

  // Opening: snake skips wy, wy-1, wy-2 at column wx
  tilemap[wy * 32 + wx] = FLOOR;
  tilemap[(wy - 1) * 32 + wx] = WALL_ROCKY;  // overhang at opening
  tilemap[(wy - 2) * 32 + wx] = WALL_ROCKY;  // overhang at opening

  // Snake detour: top border at wy-3, end cap at d=4, bottom border at wy+1
  const endX = wx + dir * 4;
  for (let d = 1; d <= 4; d++) {
    const cx = wx + dir * d;
    tilemap[(wy - 3) * 32 + cx] = CEILING;    // top border
    tilemap[(wy - 2) * 32 + cx] = WALL_ROCKY; // overhang inside corridor
    tilemap[(wy - 1) * 32 + cx] = WALL_ROCKY; // overhang inside corridor
    tilemap[(wy + 1) * 32 + cx] = CEILING;    // bottom border
  }
  // End cap: connects top border (wy-3) to bottom border (wy+1)
  tilemap[(wy - 2) * 32 + endX] = CEILING;  // end cap
  tilemap[(wy - 1) * 32 + endX] = CEILING;  // end cap
  tilemap[wy * 32 + endX] = isFalse ? FALSE_CEILING : CEILING;  // end cap (or teleport)
  tilemap[(wy + 1) * 32 + endX] = CEILING;  // already set, explicit

  // Corridor floor (between the borders)
  tilemap[wy * 32 + (wx + dir * 1)] = FLOOR;
  tilemap[wy * 32 + (wx + dir * 2)] = FLOOR;
  tilemap[wy * 32 + (wx + dir * 3)] = FLOOR;
  const teleX = wx + dir * 4; // false ceiling IS the end cap wall

  // Overhang below the bottom border (in the void)
  for (let d = 1; d <= 4; d++) {
    const cx = wx + dir * d;
    for (const dy of [2, 3]) {
      const ny = wy + dy;
      if (ny >= 0 && ny < 32 && tilemap[ny * 32 + cx] === FILL_VOID) {
        tilemap[ny * 32 + cx] = WALL_ROCKY;
      }
    }
  }

  return { wx, wy, teleX };
}

// Place secret corridors extending from the cave into the void.
// Always one corridor, 50% chance for a second on the opposite side.
// Each corridor independently has a 50% chance of a false ceiling teleport
// leading to a secret room. Both corridors can be secret rooms (opposite corners).
function placeSecretPath(tilemap, startRow, endRow, floorIndex, rng, exitX, dungeon = STARTING_DUNGEON) {
  const falseWalls = new Map();
  if (floorIndex !== 0) return falseWalls;

  // ⛔ NO SECRET ROOMS DECLARED, NO SECRET CORRIDORS CARVED.
  //
  // This used to carve regardless and only consult the registry at the WIRING
  // step, where `_secretIds[_secretIdx++]` came back undefined and `break`. The
  // corridor was already cut by then. On the Cave of Seals — which declares
  // `secretRooms: []` deliberately — that left a corridor running out of the
  // room into the void, ending at a disguised `FALSE_CEILING` doorway wired to
  // NOTHING, on 218 of 400 seeds. Dungeon floors set `skipRoomClip`, so the
  // whole thing is drawn: the player walks a passage to the map edge and finds a
  // tile that looks like wall and does nothing.
  //
  // That is precisely the shape v1.10.33 was reverted for — "a disguised tile in
  // a corridor reads as a stray wall tile" — and here it is not even hiding
  // anything. The registry's `secretRooms: []` is a statement; this is the
  // generator finally reading it.
  //
  // ⛔ THE RETURN IS BEFORE THE DRAWS, ON PURPOSE. It changes the rng stream for
  // a dungeon with no secret rooms, which is the point; Altar Cave declares two
  // and never takes this path, so its floors are untouched.
  if (secretRoomMapIds(dungeon).length === 0) return falseWalls;

  const hasSecond = rng() < 0.5;
  const primaryLeft = rng() < 0.5;
  const primaryIsFalse = rng() < 0.5;
  const secondIsFalse = hasSecond && rng() < 0.5;

  // Primary corridor — always spawns
  const primaryCandidates = findCorridorCandidates(tilemap, startRow, endRow, primaryLeft);
  const primary = carveCorridor(tilemap, primaryCandidates, primaryLeft, primaryIsFalse, rng);

  // Second corridor — opposite side
  let second = null;
  if (hasSecond) {
    const secondLeft = !primaryLeft;
    const secondCandidates = findCorridorCandidates(tilemap, startRow, endRow, secondLeft);
    second = carveCorridor(tilemap, secondCandidates, secondLeft, secondIsFalse, rng);
  }

  // Collect corridors that have false ceilings — each gets a secret room
  const secretCorridors = [];
  if (primaryIsFalse && primary) secretCorridors.push({ corridor: primary, goLeft: primaryLeft });
  if (secondIsFalse && second) secretCorridors.push({ corridor: second, goLeft: !primaryLeft });

  // Void buffer: clear rows below exit block once before placing any rooms
  if (secretCorridors.length > 0) {
    for (let by = endRow + 5; by <= 31; by++) {
      for (let bx = 0; bx < 32; bx++) {
        tilemap[by * 32 + bx] = FILL_VOID;
      }
    }
  }

  // v1.7.665: secret room body is no longer placed in the chamber map.
  // The corridor's false-ceiling trigger now warps to a separate map (1020
  // or 1021) — `_checkFalseWall` handles the `{ mapId }` destination shape
  // (see movement.js). The room interior is generated by
  // `generateSecretRoomMap` at map-load time.
  // ⛔ IDS COME FROM THE REGISTRY, not from a counter starting at 1020. A bare
  // `secretMapIdNext++` silently produces ids no dungeon owns the moment a
  // second dungeon exists, and `map-loading` would not recognise them.
  const _secretIds = secretRoomMapIds(dungeon);
  let _secretIdx = 0;
  for (const { corridor: secretCorridor, goLeft: secretGoLeft } of secretCorridors) {
    const secretMapId = _secretIds[_secretIdx++];
    if (secretMapId === undefined) break;   // more corridors than the dungeon declares rooms
    falseWalls.set(`${secretCorridor.teleX},${secretCorridor.wy}`, {
      mapId: secretMapId, goLeft: secretGoLeft,
    });
    // No return-side falseWalls entry — the secret-room map (mapId 1020/1021)
    // registers its own goBack-style trigger that pops the mapStack to
    // bring the player back to the chamber map at the saved position.
  }

  return falseWalls;
}

/**
 * Generate a standalone secret-room map (mapId 1020 / 1021). 32×32 void
 * with the secret-room body (corridor + chest alcove) placed in the
 * center. The entrance false-ceiling tile (col 0 of the room) registers
 * as a `{ goBack: true }` falseWalls entry — walking onto it pops the
 * mapStack back to the chamber map at the saved position.
 *
 * Mirrors the in-map secret-room layout from the pre-v1.7.665
 * `placeSecretPath` function (entrance + 2-col corridor + transition +
 * 2-col chest alcove + back wall), but in its own map so the chamber
 * isn't visible from inside. v1.7.665.
 *
 * @param {Uint8Array} rom
 * @param {boolean}    goLeft  Originally indicated which side of the
 *                             chamber the corridor extended to; preserved
 *                             so the room renders the same way (chest
 *                             alcove on the same relative side).
 * @returns {object} map data structure compatible with loadMapById.
 */
export function generateSecretRoomMap(rom, goLeft, dungeon = STARTING_DUNGEON) {
  const assets = loadRomAssets(rom, dungeon.donorMap, dungeon.tileset);
  const tilemap = new Uint8Array(1024).fill(FILL_VOID);

  // Anchor centered: room is 7 cols × 5 rows tall (entrance + corridor +
  // alcove + back wall, with overhang below). Place around (rx=12, ry=12).
  const rw = 7;
  const rx = goLeft ? 11 : 14;
  const ry = 12;
  const fy = ry + 4;  // floor row
  const entCol = goLeft ? rx + rw - 1 : rx;
  const step = goLeft ? -1 : 1;
  const c = i => entCol + step * i;

  // Bottom ceiling + 2-row overhang
  for (let i = 0; i < rw; i++) {
    tilemap[(fy + 1) * 32 + c(i)] = CEILING;
    tilemap[(fy + 2) * 32 + c(i)] = WALL_ROCKY;
    tilemap[(fy + 3) * 32 + c(i)] = WALL_ROCKY;
  }
  // Entrance column (i=0): all ceiling above $44
  tilemap[(fy - 3) * 32 + c(0)] = CEILING;
  tilemap[(fy - 2) * 32 + c(0)] = CEILING;
  tilemap[(fy - 1) * 32 + c(0)] = CEILING;
  tilemap[fy * 32 + c(0)] = FALSE_CEILING;
  // Wall corridor (i=1..2)
  for (let i = 1; i <= 2; i++) {
    tilemap[(fy - 3) * 32 + c(i)] = CEILING;
    tilemap[(fy - 2) * 32 + c(i)] = WALL_ROCKY;
    tilemap[(fy - 1) * 32 + c(i)] = WALL_ROCKY;
    tilemap[fy * 32 + c(i)] = FLOOR;
  }
  // Transition (i=3) with nudged ceiling
  tilemap[(fy - 4) * 32 + c(3)] = CEILING;
  tilemap[(fy - 3) * 32 + c(3)] = CEILING;
  tilemap[(fy - 2) * 32 + c(3)] = WALL_ROCKY;
  tilemap[(fy - 1) * 32 + c(3)] = WALL_ROCKY;
  tilemap[fy * 32 + c(3)] = FLOOR;
  // Chest alcove (i=4..5)
  for (let i = 4; i <= 5; i++) {
    tilemap[(fy - 4) * 32 + c(i)] = CEILING;
    tilemap[(fy - 3) * 32 + c(i)] = WALL_ROCKY;
    tilemap[(fy - 2) * 32 + c(i)] = WALL_ROCKY;
    tilemap[(fy - 1) * 32 + c(i)] = CHEST;
    tilemap[fy * 32 + c(i)] = FLOOR;
  }
  // Back wall (i=6)
  for (let row = fy - 4; row <= fy; row++) {
    tilemap[row * 32 + c(6)] = CEILING;
  }

  // Entrance tile = the false-ceiling at (c(0), fy). Register as goBack
  // via falseWalls; player walks onto it → mapStack pops.
  const entranceX = c(0);
  const entranceY = fy;
  const falseWalls = new Map();
  falseWalls.set(`${entranceX},${entranceY}`, { goBack: true });

  const triggerMap = processTriggerTiles(tilemap);

  return {
    tileset: 0,
    fillTile: FILL_VOID,
    skipRoomClip: true,
    entranceX,
    entranceY,
    mapExit: 0,
    tilemap,
    chrTiles: assets.chrTiles,
    metatiles: assets.metatiles,
    palettes: assets.palettes,
    tileAttrs: assets.tileAttrs,
    spritePalettes: assets.spritePalettes,
    collision: assets.collision,
    collisionByte2: assets.collisionByte2,
    entranceData: new Uint8Array(16),
    triggerMap,
    secretWalls: new Set(),
    dungeonDestinations: new Map(),
    hiddenTraps: new Set(),
    falseWalls,
    rockSwitch: null,
    warpTile: null,
    pondTiles: null,
  };
}

// Place cave entrance graphic.
// Floor 0: rows 0-1 all black ($5f) with $03/$68 at center.
//          rows 2-3 all black ($5f) with 5-tile cluster: ceiling, wall, passage, wall, ceiling.
// Deeper floors: $5f void → $6a passage entry (exit_prev) → $49 passage bottom
function placeEntrance(tilemap, x, y, floorIndex) {
  function set(tx, ty, tile) {
    if (tx >= 0 && tx < 32 && ty >= 0 && ty < 32) tilemap[ty * 32 + tx] = tile;
  }

  if (floorIndex === 0) {
    // Fill all 4 entrance rows with black void
    for (let row = y - 3; row <= y; row++) {
      if (row >= 0 && row < 32) {
        for (let bx = 0; bx < 32; bx++) set(bx, row, FILL_VOID);
      }
    }
    // Row 0: $03 arch (surrounded in black)
    set(x, y - 3, ENTRANCE_TOP);
    // Row 1: $68 exit_prev (surrounded in black)
    set(x, y - 2, EXIT_PREV);
    // Row 2: ceiling, wall, $41 passage, wall, ceiling (5 tiles)
    set(x - 2, y - 1, CEILING);
    set(x - 1, y - 1, WALL_ROCKY);
    set(x,     y - 1, PASSAGE);
    set(x + 1, y - 1, WALL_ROCKY);
    set(x + 2, y - 1, CEILING);
    // Row 3: ceiling, wall, $49 passage bottom, wall, ceiling (5 tiles)
    set(x - 2, y, CEILING);
    set(x - 1, y, WALL_ROCKY);
    set(x,     y, PASSAGE_BTM);
    set(x + 1, y, WALL_ROCKY);
    set(x + 2, y, CEILING);
    // Row 4: ceiling, floor, floor, floor, ceiling (5 tiles)
    set(x - 2, y + 1, CEILING);
    set(x - 1, y + 1, FLOOR);
    set(x,     y + 1, FLOOR);
    set(x + 1, y + 1, FLOOR);
    set(x + 2, y + 1, CEILING);
  } else {
    // Passage from above
    if (y - 1 >= 0) {
      for (let bx = 0; bx < 32; bx++) set(bx, y - 1, FILL_VOID);
      set(x, y - 1, PASSAGE_ENTRY);
      set(x, y, PASSAGE_BTM);
    } else {
      set(x, y, PASSAGE_ENTRY);
    }
  }
}



// Floor feature counts per floor index
// How often a horizontal corridor steps a row as it runs. Floor 3's band-tops
// sat in nine-column flat runs because its elbows ran dead straight at the same
// height as the rooms beside them; a corridor that changes level breaks those up.
const CORRIDOR_WOBBLE = 0.3;


// ⛔ KEYED BY LAYOUT NAME, NOT FLOOR INDEX. As `FLOOR_CONFIG[floorIndex]` this
// was shared by every dungeon: the Cave of Seals' floor 1 got Altar Cave's
// `traps: [3,5]` because it was floor 1, and there was no way to give one cave
// a trap room and the other a boulder room. See `data/dungeons.js` -> LAYOUTS.
//
// ⛔ A NUMBER AND A [min,max] PAIR ARE NOT INTERCHANGEABLE HERE. An array draws
// from `rng`; a bare number does not. `boulder-chamber` uses `traps: 0`, which
// skips a draw `trap-chamber` makes — a deliberate divergence between the two
// caves' RNG streams, and the reason altar stays byte-identical while seals does
// not.
const LAYOUT_CONFIG = {
  'snake':           { stairs: 1, traps: 0,      chests: [2, 4], ponds: 0, skeletons: [6, 10], secrets: 1 },
  'trap-chamber':    { stairs: 0, traps: [3, 5], chests: [4, 6], ponds: 0, skeletons: 9,       secrets: 0 },
  // Same room, same chest budget, NO trap holes — the way down is the exit
  // chamber behind the false wall instead. Joel, 2026-08-26.
  'boulder-chamber': { stairs: 0, traps: 0,      chests: [4, 6], ponds: 0, skeletons: 9,       secrets: 0 },
  'rock-switch':     { stairs: 0, traps: 0,      chests: 0,      ponds: 0, skeletons: 0,       secrets: 0, rockPuzzle: true },
  // Same deal as `rock-switch` — the branch places its own chests and bones,
  // because the shared pass cannot see which side of the false wall a tile is
  // on and will happily wall in the vault it opens.
  'chamber-run':     { stairs: 0, traps: 0,      chests: 0,      ponds: 0, skeletons: 0,       secrets: 0, rockPuzzle: true },
  'spine':           { stairs: 0, traps: 0,      chests: 0,      ponds: 0, skeletons: [4, 6],  secrets: 0 },
};

// LOCKED — Place exit on the south/bottom wall of the cave. DO NOT CHANGE.
// Stairs sit directly on the snake's bottom edge (y = endRow).
// Player approaches from the cave interior (floor at y-1).
// Layout — 5 rows × 3 columns:
//   Row 0 (y):   $00  $42  $00   ← ceiling (snake), stair arch (decoration), ceiling (snake)
//   Row 1 (y+1): $00  $73  $00   ← ceiling, stairs down (passable trigger), ceiling
//   Row 2 (y+2): $00  $00  $00   ← all ceiling
//   Row 3 (y+3): $01  $01  $01   ← rocky wall
//   Row 4 (y+4): $01  $01  $01   ← rocky wall
function placeExit(tilemap, x, y) {
  function set(tx, ty, tile) {
    if (tx >= 0 && tx < 32 && ty >= 0 && ty < 32) tilemap[ty * 32 + tx] = tile;
  }
  // Row 0: stair arch on the snake's bottom edge — player walks onto this from cave floor
  // Snake heads: explicitly set $00 on both sides so snake always connects through U-shape below
  set(x - 1, y, CEILING);
  set(x,     y, STAIR_ARCH);
  set(x + 1, y, CEILING);
  // Row 1: stairs down + ceiling sides
  set(x - 1, y + 1, CEILING);
  set(x,     y + 1, STAIRS_DOWN);
  set(x + 1, y + 1, CEILING);
  // Row 2: all ceiling
  set(x - 1, y + 2, CEILING);
  set(x,     y + 2, CEILING);
  set(x + 1, y + 2, CEILING);
  // Row 3: rocky wall
  set(x - 1, y + 3, WALL_ROCKY);
  set(x,     y + 3, WALL_ROCKY);
  set(x + 1, y + 3, WALL_ROCKY);
  // Row 4: rocky wall
  set(x - 1, y + 4, WALL_ROCKY);
  set(x,     y + 4, WALL_ROCKY);
  set(x + 1, y + 4, WALL_ROCKY);
}

// Place deeper-floor entrance. Runs AFTER addOverhang.
// baseRow = row of the void tile (top of entrance block).
// Entrance spans baseRow to baseRow+3 (4 rows).
//
// Entrance rule (pathDir = +1, pathway goes RIGHT):
//   baseRow+0: C  $5f  C   ← black door between ceiling
//   baseRow+1: C  $6a  W   ← stair between ceiling (closed) and wall (pathway side)
//   baseRow+2: C  $49  W   ← stair between ceiling (closed) and wall (pathway side)
//   baseRow+3: C   .   .   ← floor opens toward pathway
function placeDeepEntrance(tilemap, x, pathDir, baseRow) {
  function set(tx, ty, tile) {
    if (tx >= 0 && tx < 32 && ty >= 0 && ty < 32) tilemap[ty * 32 + tx] = tile;
  }
  const open = pathDir; // +1 = right, -1 = left

  set(x - 1, baseRow, CEILING);
  set(x,     baseRow, FILL_VOID);
  set(x + 1, baseRow, CEILING);

  set(x - open, baseRow + 1, CEILING);
  set(x,        baseRow + 1, PASSAGE_ENTRY);
  set(x + open, baseRow + 1, WALL_ROCKY);

  set(x - open, baseRow + 2, CEILING);
  set(x,        baseRow + 2, PASSAGE_BTM);
  set(x + open, baseRow + 2, WALL_ROCKY);

  set(x - open, baseRow + 3, CEILING);
  set(x,        baseRow + 3, FLOOR);
  set(x + open, baseRow + 3, FLOOR);

  // Enforce overhang below closed-side ceiling (2 rows below baseRow+3)
  const cx = x - open;
  for (let row = baseRow + 4; row <= baseRow + 5; row++) {
    if (cx >= 0 && cx < 32 && row >= 0 && row < 32) {
      const idx = row * 32 + cx;
      if (tilemap[idx] === FLOOR) tilemap[idx] = WALL_ROCKY;
    }
  }
}

// Place deeper-floor exit (stairs down). Runs AFTER addOverhang.
// North wall: entrance-style block (void + arch/stairs + wall on open side)
// South wall: floor-0-style (arch + stairs + ceiling below, blends in)
function placeDeepExit(tilemap, x, y) {
  function set(tx, ty, tile) {
    if (tx >= 0 && tx < 32 && ty >= 0 && ty < 32) tilemap[ty * 32 + tx] = tile;
  }

  // Detect wall orientation: is the cave interior above or below?
  const floorAbove = y > 0 && tilemap[(y - 1) * 32 + x] === FLOOR;

  if (floorAbove) {
    // South wall: player approaches from above
    set(x - 1, y, CEILING);
    set(x,     y, STAIR_ARCH);
    set(x + 1, y, CEILING);

    set(x - 1, y + 1, CEILING);
    set(x,     y + 1, STAIRS_DOWN);
    set(x + 1, y + 1, CEILING);

    // Ceiling below — blends with surrounding ceiling, no rocky wall
    set(x - 1, y + 2, CEILING);
    set(x,     y + 2, CEILING);
    set(x + 1, y + 2, CEILING);
  } else {
    // North wall: entrance-style block (opens sideways toward cave interior)
    const leftFloor = x > 0 && tilemap[y * 32 + (x - 1)] === FLOOR;
    const open = leftFloor ? -1 : 1;
    const baseRow = y - 2;

    set(x - 1, baseRow, CEILING);
    set(x,     baseRow, FILL_VOID);
    set(x + 1, baseRow, CEILING);

    set(x - open, baseRow + 1, CEILING);
    set(x,        baseRow + 1, STAIR_ARCH);
    set(x + open, baseRow + 1, WALL_ROCKY);

    set(x - open, baseRow + 2, CEILING);
    set(x,        baseRow + 2, STAIRS_DOWN);
    set(x + open, baseRow + 2, WALL_ROCKY);

    set(x - open, baseRow + 3, CEILING);
    set(x,        baseRow + 3, FLOOR);
    set(x + open, baseRow + 3, FLOOR);

    // Overhang below closed-side ceiling
    const cx = x - open;
    for (let row = baseRow + 4; row <= baseRow + 5; row++) {
      if (cx >= 0 && cx < 32 && row >= 0 && row < 32) {
        const idx = row * 32 + cx;
        if (tilemap[idx] === FLOOR) tilemap[idx] = WALL_ROCKY;
      }
    }
  }
}

// Carve a straight, narrow horizontal corridor from the entrance.
// Runs BEFORE addOverhang — just places FLOOR tiles. Overhang handles walls.
// 3 rows of FLOOR: top 2 become walls via overhang, bottom 1 walkable.
// No descent — corridor stays at a fixed floor level.
function carvePathway(tilemap, startX, startFloorY, pathDir, pathLength, rng) {
  let x = startX;
  const fy = startFloorY;

  x = carveHRun(tilemap, { x0: startX, y: fy, dir: pathDir, steps: pathLength }).endX;
  return { endX: x, endFloorY: fy };
}

// Carve a vertical pathway (goes up or down), curving left/right.
// Runs BEFORE addOverhang — just places FLOOR tiles.
// Each row gets a 4-tile-wide horizontal strip. Overhang handles walls at corridor top.
function carveVerticalPathway(tilemap, startX, startY, vertDir, pathLength, rng) {
  let y = startY;
  const fx = startX;

  // 2 tiles wide, and yMax is 28 here against 29 for the floor-1/2 corridors —
  // both preserved rather than unified, since either change moves tiles.
  y = carveVRun(tilemap, { x: fx, y0: y, dir: vertDir, steps: pathLength, width: 2, yMax: 28 }).endY;
  return { endX: fx, endY: y };
}

// Carve a small organic cave room centered on (cx, cy). Used as the entrance
// "breathing" room and the H↔V corridor junction room on deeper floors —
// gives the player something to stand in besides a 1-tile corridor before the
// pathway forks. Runs BEFORE addOverhang, so all FLOOR (top rows are eaten
// into walls by overhang; bottom rows stay walkable).
//   width  : 5-6 tiles
//   height : 4 tiles total (top 2 → wall via overhang, bottom 2 walkable)
// Light per-row edge jitter keeps it cave-shaped, not rectangular.
function carveSmallCaveRoom(tilemap, cx, cy, rng) {
  const w = 5 + Math.floor(rng() * 2);          // 5-6 wide
  const halfL = Math.floor(w / 2);
  const halfR = w - 1 - halfL;
  let bL = 32, bR = -1, bT = 32, bB = -1;
  for (let dy = -3; dy <= 0; dy++) {            // 4 rows tall, anchored at cy
    const row = cy + dy;
    if (row < 1 || row > 30) continue;
    const jl = Math.floor(rng() * 2);           // 0-1 inset on each side
    const jr = Math.floor(rng() * 2);
    const left = Math.max(1, cx - halfL + jl);
    const right = Math.min(30, cx + halfR - jr);
    for (let x = left; x <= right; x++) tilemap[row * 32 + x] = FLOOR;
    if (left <= right) {
      if (left < bL) bL = left;
      if (right > bR) bR = right;
      if (row < bT) bT = row;
      if (row > bB) bB = row;
    }
  }
  return bR >= bL ? { top: bT, bot: bB, left: bL, right: bR } : null;
}

// ⛔ REMOVED in v1.10.22 (phase 1): `carvePathwayRoom` was dead — superseded by the inline room carves.

// The boss chamber's SHAPE lives in `dungeon/boss-chamber.js` — one shape for
// every dungeon, dressed by a per-dungeon skin (§4c of the chambers plan). The
// crystal pedestal moved out of the layout and into `CRYSTAL_SKIN`, so Altar
// Cave's room is unchanged and a cave-skinned dungeon gets floor where the altar
// would be instead of whatever $3a-$3f render as in tileset 0.
function generateBossRoom(tilemap, dungeon) {
  return carveBossChamber(tilemap, resolveBossSkin(dungeon.bossSkinId));
}

// ROM assets, cached per DONOR MAP rather than per run.
//
// ⛔ THIS USED TO BE TWO SINGLETONS — `cachedRomAssets` and
// `cachedCrystalAssets` — which silently assumed exactly one cave donor and one
// boss-room donor existed. A second dungeon with its own donor map would have
// been handed the first dungeon's cached tiles and palettes, and the only
// symptom would be a cave painted in the wrong colours.
//
// `walkableWarp` overrides tile $61 to walkable (z=1, no trigger). That belongs
// to BOSS CHAMBERS generally, not to the crystal — every boss room has a warp
// out — so it is a flag here rather than a property of the crystal loader.
const _assetCache = new Map();

export function loadRomAssets(romData, donorMap = REF_MAP_ID, tileset = 0, { walkableWarp = false } = {}) {
  const key = `${donorMap}:${tileset}:${walkableWarp ? 1 : 0}`;
  const hit = _assetCache.get(key);
  if (hit) return hit;
  const mapProps = parseMapProperties(romData, donorMap);
  const collision = loadTileCollision(romData, tileset);
  if (walkableWarp) collision[0x61] = 0x01;
  const assets = {
    metatiles: loadTileset(romData, tileset),
    chrTiles: loadCHRGraphics(romData, donorMap),
    palettes: buildMapPalettes(romData, mapProps),
    // The donor map's SP2/SP3, so NPCs and objects on a generated floor are
    // painted from the ROM instead of from hand-picked constants.
    spritePalettes: buildSpritePalettes(romData, mapProps),
    collision,
    collisionByte2: loadTileCollisionByte2(romData, tileset),
    tileAttrs: loadNameTable(romData, tileset),
  };
  _assetCache.set(key, assets);
  return assets;
}

/** Assets for a dungeon's floor — the boss chamber uses the boss skin's donor. */
function assetsForFloor(romData, dungeon, floorIndex) {
  if (isBossFloor(dungeon, floorIndex)) {
    const skin = resolveBossSkin(dungeon.bossSkinId);
    return loadRomAssets(romData, skin.donorMap, skin.tileset, { walkableWarp: true });
  }
  return loadRomAssets(romData, dungeon.donorMap, dungeon.tileset);
}

export function clearDungeonCache() {
  _assetCache.clear();
}

export function generateFloor(romData, floorIndex, seed, dungeon = STARTING_DUNGEON) {
  // Retry with shifted seed if exit is unreachable (rare convergence pinch)
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = _generateFloor(romData, floorIndex, seed + attempt * 9973, dungeon);
    // Validate connectivity: BFS from entrance to any stairs tile
    let stairIdx = -1;
    for (let i = 0; i < 1024; i++) {
      if (result.tilemap[i] === STAIRS_DOWN) { stairIdx = i; break; }
    }
    if (stairIdx < 0) {
      // No stairs — validate floor has enough reachable tiles (chamber not eaten by overhang)
      const visited = new Set();
      const queue = [result.entranceY * 32 + result.entranceX];
      visited.add(queue[0]);
      while (queue.length) {
        const idx = queue.shift();
        const x = idx % 32, y = (idx - x) / 32;
        for (const [dx, dy] of [[0,1],[0,-1],[1,0],[-1,0]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx > 31 || ny < 0 || ny > 31) continue;
          const ni = ny * 32 + nx;
          if (visited.has(ni)) continue;
          if ((result.collision[result.tilemap[ni]] & 0x07) === 3) continue;
          visited.add(ni);
          queue.push(ni);
        }
      }
      if (visited.size >= 60) return result; // enough walkable space
      continue; // retry — chamber got eaten
    }
    // A boulder floor's stairs are behind a false wall — unreachable by design
    // until the switch is pulled. Validate that the ROCK is adjacent to a
    // reachable tile instead.
    //
    // ⛔ KEYED ON `result.rockSwitch`, NOT ON THE FLOOR INDEX. It was
    // `floorIndex === 2`, which is exactly equivalent while floor 2 is the only
    // floor with a rock — and silently wrong the moment a second layout grows
    // one, because the normal stairs BFS below would reject every seed of it.
    if (result.rockSwitch) {
      const rv = new Set();
      const rq = [result.entranceY * 32 + result.entranceX];
      rv.add(rq[0]);
      while (rq.length) {
        const idx = rq.shift();
        const x = idx % 32, y = (idx - x) / 32;
        for (const [dx, dy] of [[0,1],[0,-1],[1,0],[-1,0]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx > 31 || ny < 0 || ny > 31) continue;
          const ni = ny * 32 + nx;
          if (rv.has(ni)) continue;
          if ((result.collision[result.tilemap[ni]] & 0x07) === 3) continue;
          rv.add(ni);
          rq.push(ni);
        }
      }
      const rx = result.rockSwitch.rocks[0].x, ry = result.rockSwitch.rocks[0].y;
      const rockAdj = [[rx-1,ry],[rx+1,ry],[rx,ry-1],[rx,ry+1]];
      const rockReachable = rockAdj.some(([ax,ay]) =>
        ax >= 0 && ax < 32 && ay >= 0 && ay < 32 && rv.has(ay * 32 + ax));
      if (rockReachable && rv.size >= 20) return result;
      continue;
    }
    const visited = new Set();
    const queue = [result.entranceY * 32 + result.entranceX];
    visited.add(queue[0]);
    let found = false;
    while (queue.length) {
      const idx = queue.shift();
      if (idx === stairIdx) { found = true; break; }
      const x = idx % 32, y = (idx - x) / 32;
      for (const [dx, dy] of [[0,1],[0,-1],[1,0],[-1,0]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx > 31 || ny < 0 || ny > 31) continue;
        const ni = ny * 32 + nx;
        if (visited.has(ni)) continue;
        if ((result.collision[result.tilemap[ni]] & 0x07) === 3) continue;
        visited.add(ni);
        queue.push(ni);
      }
    }
    if (found) return result;
  }
  return _generateFloor(romData, floorIndex, seed, dungeon); // fallback
}

function _generateFloor(romData, floorIndex, seed, dungeon = STARTING_DUNGEON) {
  const assets = assetsForFloor(romData, dungeon, floorIndex);
  const rng = mulberry32(seed + floorIndex);
  // ⭐ WHAT SHAPE THIS FLOOR IS. Null on the boss chamber, whose shape comes from
  // `bossSkinId` — every branch below tests `isBossFloor` first, so null never
  // reaches a layout comparison. Reading it draws nothing from `rng`, which is
  // why swapping the whole dispatch from floor index to layout name leaves Altar
  // Cave byte-identical (`check-floor-snapshot`).
  const LAYOUT = layoutForFloor(dungeon, floorIndex);
  // Corridor run lengths for THIS dungeon. `hSpan`/`vSpan` keep the draw to one
  // `rng()` call apiece — for Altar Cave's 4..6 / 5..7 that is byte-for-byte the
  // `4 + Math.floor(rng() * 3)` these replace.
  const CORR = corridorBounds(dungeon);
  const hSpan = CORR.hMax - CORR.hMin + 1;
  const vSpan = CORR.vMax - CORR.vMin + 1;
  const fillTile = (LAYOUT === 'snake') ? FILL_VOID : CEILING;
  const tilemap = new Uint8Array(1024).fill(fillTile);

  let entranceX, entranceY;
  let warpTile = null;
  let pondTiles = null;
  const secretWalls = new Set();
  const dungeonDestinations = new Map();
  let falseWalls = new Map();
  const lockedDoors = new Set();  // v1.7.669 — door coords that block
                                  // movement and show "Locked."
  // Floor-0 locked-room door coords — hoisted so the late
  // trigger-wiring pass (after processTriggerTiles) can look them up
  // in the triggerMap to find their assigned trigIds. v1.7.657.
  // Locked-room chamber doors: Map<"x,y", { mapId }>. Each entry routes its
  // type-1 trigger to the given mapId (where mapId is a separate-map locked
  // room generated by generateLockedRoomMap). v1.7.677 — generalized from
  // the single-door floor-0 vars so floor 2 (UI 3) can register one too.
  const lockedRoomDoors = new Map();
  // Small breathing rooms (entrance + H↔V junction) on the deeper-floor else
  // branch; the shared feature-placement pass sprinkles skeletons + a chance
  // chest into each. Empty on every other branch.
  const extraRooms = [];
  // Chambers rolled from `data/chambers.js`, with the bounds of the room they
  // landed in. Applied at the END of the shared feature pass so a chamber
  // feature is ADDITIVE — it cannot take a tile the floor's own chests, traps or
  // stairs already claimed.
  const chamberFeatures = [];
  // What each rolled chamber actually did, for the tools and the gates.
  const chamberLog = [];

  // Floors 1, 2 and 3 build every chamber through a primitive, so their plans
  // are COMPLETE. Floor 0's shape is a traced ceiling snake — one boundary, not
  // a set of rooms — and floor 4's chamber is authored, so neither is a chamber
  // list. `complete: false` says so rather than letting a partial plan read as
  // whole.
  // Complete = every chamber on the floor went through a plan primitive. The
  // `snake` layout traces a ceiling boundary rather than placing rooms, and the
  // boss chamber is authored, so neither is a chamber list.
  const plan = createPlan(floorIndex, LAYOUT !== null && LAYOUT !== 'snake');

  if (isBossFloor(dungeon, floorIndex)) {
    const pos = generateBossRoom(tilemap, dungeon);
    entranceX = pos.entranceX;
    entranceY = pos.entranceY;
    warpTile = pos.warpTile;
  } else if (LAYOUT === 'snake') {
    // ── Floor 0: two rooms (left/right) joined by a corridor — traced as ONE
    // continuous ceiling perimeter (snake) so ceilings NEVER disconnect. ──
    // Built like the deeper-floor boundary mode: assemble one inside-shape mask
    // (both rooms + a connecting neck), then mark every inside tile that touches
    // the void as CEILING and the interior as FLOOR. That single perimeter is
    // the snake. addOverhang then lays 2 rocky tiles under every ceiling, which
    // also eats the 5-tall neck down to a 1-tile-tall walkable corridor. Outside
    // stays FILL_VOID — the floor-0 "outside" look.
    // `var` hoist for floor-0 layout constants so the late locked-room hook
    // (placed after the final enforceMinCeilingGap so its 0x44 door can't
    // get gap-filled back to ceiling) can see them. v1.7.650.
    // ── Skeleton, SAMPLED (v1.10.31 — phase 3) ─────────────────────────
    // These were literals: rows 5..19, halves [4,14] and [17,27], an 8-wide
    // room and anchors at 9 and 22. The floor therefore lived in the same rows
    // and the same columns on EVERY seed — 0.610 mean pairwise Jaccard, 72
    // fixed tiles, and exactly TWO entrance positions (the `aOnRight` flip).
    //
    // ⛔ THE LEFT HALF MUST NOT START BEFORE COLUMN 5. `findCorridorCandidates`
    // hunts the secret corridor in columns 3-7 and needs FOUR void columns
    // outside the room's wall (`x-1 … x-4`, all >= 1). A room whose wall sits at
    // column 4 leaves only three, and the left-hand secret corridor stops being
    // placeable at all. Same in mirror on the right: the wall must be at 29 or
    // less. Widening the rooms toward the map edge would quietly delete the
    // floor's secrets, so the sampling ranges are bounded by that, not by what
    // fits on the map — and `check-floor-variety` now gates the resulting rate.
    // ⭐ SAMPLED FROM THE DUNGEON ROW. These were seven literals, so both caves
    // opened on the same map. `drawRange` is one `rng()` call per value, in the
    // same order, and Altar Cave's row declares exactly the ranges these
    // literals had — so its floor 0 is byte-identical.
    const SN = snakeBounds(dungeon);
    var roomTop = drawRange(rng, SN.top);
    var roomBot = drawRange(rng, SN.bot);
    var aOnRight = rng() < 0.5;
    const ROOM_W = drawRange(rng, SN.roomW);
    const leftL = drawRange(rng, SN.left);          // see the note above re: secrets
    const rightR = drawRange(rng, SN.right);
    // ⛔ THE TWO HALVES MUST NOT OVERLAP, and the gap must be derived rather
    // than hoped for. v1.10.31 sampled a fixed half-width of 9-11 columns from
    // each end independently: of the 12 resulting combinations **5 overlapped**
    // and 6 pushed the left half past column 16. Both break the neck (below),
    // and the symptom is not a malformed room — it is room B ending up a
    // SEPARATE CAVE with its own arch and chests that nothing can reach. Caught
    // on floor 0 seed 1811002716217, which took a third seed base to surface.
    const gap = drawRange(rng, SN.gap);             // columns of rock between
    const halfW = Math.floor((rightR - leftL - gap) / 2);
    const LEFT_HALF = [leftL, leftL + halfW];
    const RIGHT_HALF = [rightR - halfW, rightR];
    const aHalfSel = aOnRight ? RIGHT_HALF : LEFT_HALF;
    // Anchor near each half's middle, jittered by a tile either way.
    const midOf = (h) => Math.round((h[0] + h[1]) / 2) + (Math.floor(rng() * 3) - 1);
    const aAnchor = midOf(aHalfSel);
    const bAnchor = midOf(aOnRight ? LEFT_HALF : RIGHT_HALF);
    const aHalf = aHalfSel;
    var bHalf = aOnRight ? LEFT_HALF : RIGHT_HALF;

    // ── Topology (v1.10.37) ────────────────────────────────────────────
    // `level`  — both rooms on the same row band, joined by a horizontal neck.
    //            The only shape this floor has ever built.
    // `tilted` — room B sits LOWER, so the cave descends as you cross it.
    //
    // ⛔ B goes DOWN, never up. The entrance is placed on room A's top edge and
    // the exit on room B's bottom, so `roomTop`/`roomBot` are those two edges.
    // Tilting B downward keeps them the extremes of the whole shape and every
    // downstream scan — the secret-corridor rows, the feature bounding box —
    // keeps working unchanged. Tilting upward would make `roomBot` stop being
    // the lowest row and quietly cut room A out of those scans.
    const topology = rng() < 0.5 ? 'level' : 'tilted';
    plan.topology = topology;
    const tilt = topology === 'tilted' ? drawRange(rng, SN.tilt) : 0;
    const aTop = roomTop, aBot = roomBot;
    const bTop = roomTop + tilt;
    const bBot = Math.min(24, roomBot + tilt);   // leave rows for B's overhang
    roomBot = bBot;                              // the exit lives on room B

    // Inside-shape mask: organic outline for each room, clamped to its half so
    // they don't overlap, unioned together.
    const inside = new Uint8Array(1024);
    const addRoom = (anchor, half, top, bot) => {
      const { left, right } = generateCaveOutlinePath(anchor, top, bot, rng, ROOM_W);
      for (let y = top; y <= bot; y++) {
        const l = Math.max(half[0], Math.min(left[y], right[y]));
        const r = Math.min(half[1], Math.max(left[y], right[y]));
        for (let x = l; x <= r; x++) inside[y * 32 + x] = 1;
      }
    };
    addRoom(aAnchor, aHalf, aTop, aBot);
    addRoom(bAnchor, bHalf, bTop, bBot);

    // Connecting neck: fill ONLY the void gap between the two rooms (not the
    // full span), 5 mask rows tall at the mid row. Keeping each room's own
    // shape gives each a simple perimeter loop, so a secret carved into an
    // outer wall can't cut a room in half. After overhang eats 2 rows the neck
    // becomes a 1-tile corridor that's part of the single perimeter.
    // ⛔ The neck must sit in the rows BOTH rooms occupy. With a tilt that is
    // `bTop..aBot`, not the whole shape's span — a neck row outside the overlap
    // has nothing to join on one side and the two rooms stay separate caves.
    const overlapTop = Math.max(aTop, bTop), overlapBot = Math.min(aBot, bBot);
    const cy = overlapTop + Math.floor((overlapBot - overlapTop) / 2);
    // ⛔ SPLIT AT THE ACTUAL GAP, not at column 16. The hardcoded midline assumed
    // each room stayed on its own side of it; once the left half can reach column
    // 16 or beyond, the right-hand scan finds ROOM A's own tiles, `rightMin` lands
    // inside room A, and the neck fills a span that connects nothing.
    const neckSplit = Math.floor((LEFT_HALF[1] + RIGHT_HALF[0]) / 2);
    for (let ny = cy - 2; ny <= cy + 2; ny++) {
      let leftMax = -1, rightMin = 32;
      for (let x = 0; x < neckSplit; x++) if (inside[ny * 32 + x]) leftMax = x;
      for (let x = neckSplit; x < 32; x++) if (inside[ny * 32 + x]) { rightMin = x; break; }
      if (leftMax >= 0 && rightMin < 32) {
        for (let x = leftMax + 1; x < rightMin; x++) inside[ny * 32 + x] = 1;
      }
    }

    // Boundary detection — ONE continuous CEILING perimeter, FLOOR interior.
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        if (!inside[y * 32 + x]) continue;
        const edge =
          x === 0  || !inside[y * 32 + x - 1] || x === 31 || !inside[y * 32 + x + 1] ||
          y === 0  || !inside[(y - 1) * 32 + x] || y === 31 || !inside[(y + 1) * 32 + x];
        tilemap[y * 32 + x] = edge ? CEILING : FLOOR;
      }
    }
    // Close diagonal perimeter gaps so the ceiling is ONE cardinally-connected
    // snake. Where the wall steps in/out, boundary tracing links two ceilings
    // only diagonally; bridge each such pair through the inside corner tile.
    // Iterate to a fixpoint — closing one corner can expose the next.
    for (let pass = 0; pass < 8; pass++) {
      let changed = false;
      for (let y = 0; y < 31; y++) {
        for (let x = 0; x < 31; x++) {
          const tl = tilemap[y * 32 + x], tr = tilemap[y * 32 + x + 1];
          const bl = tilemap[(y + 1) * 32 + x], br = tilemap[(y + 1) * 32 + x + 1];
          if (tl === CEILING && br === CEILING && tr !== CEILING && bl !== CEILING) {
            const i = inside[y * 32 + x + 1] ? y * 32 + x + 1 : (y + 1) * 32 + x;
            tilemap[i] = CEILING; changed = true;
          } else if (tr === CEILING && bl === CEILING && tl !== CEILING && br !== CEILING) {
            const i = inside[y * 32 + x] ? y * 32 + x : (y + 1) * 32 + x + 1;
            tilemap[i] = CEILING; changed = true;
          }
        }
      }
      if (!changed) break;
    }

    // Entrance into Room A (top), passage down through the top perimeter.
    entranceX = aAnchor;
    const columnY = 3;
    placeEntrance(tilemap, entranceX, columnY, 0);
    entranceY = columnY - 1;
    for (let y = columnY + 1; y <= roomTop + 1; y++) {
      if (y < 32) tilemap[y * 32 + entranceX] = FLOOR;
    }

    // Exit stairs on Room B's bottom edge, centered on B's floor span.
    let exitX = bAnchor;
    {
      let lo = 32, hi = -1;
      for (let x = bHalf[0]; x <= bHalf[1]; x++) {
        if (isFloorTile(tilemap[(roomBot - 1) * 32 + x])) { if (x < lo) lo = x; if (x > hi) hi = x; }
      }
      if (hi >= lo) exitX = Math.floor((lo + hi) / 2);
    }
    placeExit(tilemap, exitX, roomBot);

    // ⛔ NOT `finishCaveShape`. This comment used to read "exact passes/order as
    // every other floor", which was false: floor 0 skips the pinch fix and the
    // protrusion removal. Its shape is one traced ceiling snake, not carved
    // rooms joined by corridors, so those two passes have nothing to do here.
    enforceMinCeilingGap(tilemap);
    ensureCeilingConnectivity(tilemap);
    addOverhang(tilemap);

    // Entrance landing — 3x3 open floor pocket (single source: openEntranceLanding).
    openEntranceLanding(tilemap, entranceX, roomTop, aHalf);

    var exitXForSecret = exitX;
    var startRowForSecret = roomTop;
    var endRowForSecret = roomBot;
    var exitXForUsed = exitX;
    var endRowForUsed = roomBot;
    // Features (chests/skeletons) span both rooms. Bounds = the ACTUAL floor
    // bounding box (not 1..30) so findCornerFloor's "near the edge" test lines
    // up with the real room walls — otherwise every chest fails the corner test
    // and falls back to wall-adjacent placement.
    var chamberBounds = (() => {
      let left = 32, right = -1, top = 32, bot = -1;
      for (let y = roomTop; y <= roomBot; y++) {
        for (let x = 0; x < 32; x++) {
          if (isFloorTile(tilemap[y * 32 + x])) {
            if (x < left) left = x; if (x > right) right = x;
            if (y < top) top = y; if (y > bot) bot = y;
          }
        }
      }
      return right >= left ? { top, bot, left, right } : { top: roomTop, bot: roomBot, left: 1, right: 30 };
    })();

    // Locked-room hook is now LATE — after the final enforceMinCeilingGap
    // pass at line ~2752, so its 0x44 false-ceiling door can't trigger the
    // gap-fill that converts the rock above the door back to ceiling.
    // `lockedRoomExclusion` is hoisted to the feature-pass scope; chest /
    // skeleton scatter at line 2491+ runs BEFORE the late hook, so it can't
    // collide with the room-to-be either way (room interior + door land in
    // the free corner the cave never spawns features in).

  } else if (LAYOUT === 'trap-chamber') {
    // ── Floor 1: floor-2 architecture, trap-chamber half only ──────────
    // Copies floor 2's room/corridor primitives (5×5 + H corridor + 5×5 +
    // V corridor + 7×7) verbatim. The entrance arch reuses floor 2's
    // EXIT-BLOCK pattern (placeDeepEntrance embedded in a 5×5 room with
    // the open side facing the corridor). Flow stops at the 7×7 chamber —
    // its trap holes ARE the exit to floor 2, no further rooms / no exit
    // arch. Always top-down (entrance at top, chamber at bottom) since
    // floor 0's south-wall stairs put the player at floor 1's top.

    entranceX = 5 + Math.floor(rng() * 22); // 5-26
    const horizDir = entranceX > 16 ? -1 : entranceX < 16 ? 1 : (rng() < 0.5 ? -1 : 1);
    const vertDir = 1;

    // ── Topology (v1.10.35) ────────────────────────────────────────────
    // `chain`  — both rooms on one row, then down to the chamber. An L, and
    //            what this floor always built.
    // `zigzag` — the mid room sits at its own height, reached by an ELBOW, so
    //            the route steps down twice instead of once.
    const topology = rng() < 0.5 ? 'chain' : 'zigzag';
    plan.topology = topology;

    // 5×5 entrance room — identical primitive to floor 2's exit room
    // (lines 1602-1611 in the floor-2 branch). The corridor exits the
    // room on +horizDir side, so the room body extends in -horizDir
    // ("entrFarDir") from the corridor-side edge column entranceX.
    const entrFarDir = -horizDir;
    const entrCornerX = entranceX;
    const entrFloorY = 7;
    // ⛔ DOWNWARD ONLY, and not clamped. Offsetting either way and clamping to
    // 6..11 looked symmetric and was not: the entrance row is 7, so every
    // upward roll hit the clamp and produced a ONE-row step. Measured 91 of 205
    // zigzags sitting at row 6 against 51 and 63 at rows 9 and 10 — nearly half
    // of them barely zigzagged. Down is also the only direction with room:
    // floor 0's south stairs land the player at this floor's top, so the
    // entrance room has to stay there.
    const midFloorY = topology === 'zigzag'
      ? entrFloorY + 2 + Math.floor(rng() * 3)   // 9-11
      : entrFloorY;
    planChamber(plan, tilemap, rng, 'entrance', { x: entrCornerX, y: entrFloorY, dir: entrFarDir });

    // Short H corridor — 4-6 steps, 3-row carve (1 walkable row after
    // overhang), no jitter. Same primitive as floor 2's H corridor
    // (lines 1533-1540 in the floor-2 branch).
    const horizStartX = entrCornerX;
    const horizFloorY = entrFloorY;
    const pathLength = CORR.hMin + Math.floor(rng() * hSpan);
    // Straight when `midFloorY` matches (the `chain` topology), an L otherwise.
    planElbow(plan, tilemap, { x0: horizStartX, y: horizFloorY, dir: horizDir, steps: pathLength, turnY: midFloorY });
    const pathEndX = Math.max(1, Math.min(30, horizStartX + pathLength * horizDir));
    const pathResult = { endX: pathEndX, endFloorY: midFloorY };

    // 5×5 mid room — direct copy of floor 2's first 5×5 mid room
    // (lines 1544-1553 in the floor-2 branch).
    // ⭐ THE MID ROOM IS ROLLED FROM THE CATALOGUE. It was always a plain
    // 'junction'; now it can come up a bone pit, a vault, rubble or a spring.
    // See `data/chambers.js`.
    const [midCh] = rollChambers(dungeon, floorIndex, ['mid'], rng);
    planChamber(plan, tilemap, rng, midCh.role, { x: pathResult.endX, y: pathResult.endFloorY, dir: horizDir });

    // V corridor — 5-7 steps DOWN from middle of mid room.
    // Direct copy of floor 2's V corridor (lines 1557-1564).
    const vertRoll = CORR.vMin + Math.floor(rng() * vSpan);
    // ⛔ CLAMPED TO THE ROOM BUDGET, AND CLAMPED AFTER THE DRAW.
    //
    // The chamber hangs off the BOTTOM of this run, so a long vertical push its
    // far edge off the map: at 9-13 steps the 7x7 landed on rows 30-32 and took
    // its chests and the exit with it — 41 of 400 seeds, chests unopenable and
    // the way down stranded. The cap is the row the chamber's far edge may not
    // pass; drawing first and clamping second leaves the rng stream untouched,
    // and Altar Cave's 5-7 never reaches the cap, so it is unaffected.
    const vertLength = Math.min(vertRoll, 21 - pathResult.endFloorY);
    const vertX = pathResult.endX + 2 * horizDir;
    let vertY = pathResult.endFloorY + 2;
    vertY = planVLink(plan, tilemap, { x: vertX, y0: vertY, dir: vertDir, steps: vertLength }).endY;

    // 7×7 trap chamber — direct copy of floor 2's 7×7 chamber primitive
    // (lines 1566-1586), minus the exit-path keep-clear adjustment since
    // floor 1 has no exit path.
    const roomDyMin = -2;
    const roomDyMax = 6;
    planWideChamber(plan, tilemap, rng, 'trap', { x: vertX, y: vertY, dyMin: roomDyMin, dyMax: roomDyMax });

    // Cleanup + overhang — same pass order as floor 2.
    finishCaveShape(tilemap);

    // Entrance arch — direct copy of floor 2's exit-block placement
    // (lines 1621-1623). Arch sits 3 tiles INTO the room from the
    // corridor side, opens back TOWARD the corridor so the player drops
    // in already facing the corridor exit.
    const archX = entrCornerX + 3 * entrFarDir;
    const archBaseRow = entrFloorY - 5;
    placeDeepEntrance(tilemap, archX, -entrFarDir, archBaseRow);
    entranceX = archX;
    entranceY = archBaseRow + 1; // PASSAGE_ENTRY row
    enforceMinCeilingGap(tilemap);

    // BFS-seal any floor isolated by entrance placement, starting at the
    // landing FLOOR tile (one row below PASSAGE_BTM).
    const reachable = new Set();
    const startIdx = (archBaseRow + 3) * 32 + archX;
    reachable.add(startIdx);
    const bfsQ = [[archX, archBaseRow + 3]];
    while (bfsQ.length) {
      const [cx, cy] = bfsQ.shift();
      for (const [dx, dy] of [[0,1],[0,-1],[1,0],[-1,0]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || nx > 31 || ny < 0 || ny > 31) continue;
        const idx = ny * 32 + nx;
        if (reachable.has(idx)) continue;
        const t = tilemap[idx];
        if (t === FLOOR || t === PASSAGE_BTM || t === PASSAGE_ENTRY || t === BONES) {
          reachable.add(idx);
          bfsQ.push([nx, ny]);
        }
      }
    }
    for (let i = 0; i < 1024; i++) {
      if (!reachable.has(i) && tilemap[i] === FLOOR) tilemap[i] = CEILING;
    }

    // chamberBounds = the 7×7 trap chamber where trap holes drop.
    var exitXForSecret = null;
    var startRowForSecret = 7;
    var endRowForSecret = 27;
    var exitXForUsed = null;
    var endRowForUsed = 27;
    var chamberBounds = {
      top: vertY + roomDyMin,
      bot: vertY + roomDyMax,
      left: vertX - 3,
      right: vertX + 3,
    };

    // Register entrance + mid 5×5 rooms for bonus chest/skeleton placement
    // via the shared block's extra-room pass. Bounds use the same
    // start-edge/+4 model as floor 2's chest placement (lines 1705-1707).
    extraRooms.push({
      top: entrFloorY - 2,
      bot: entrFloorY + 2,
      left: entrFarDir === 1 ? entrCornerX : entrCornerX - 4,
      right: entrFarDir === 1 ? entrCornerX + 4 : entrCornerX,
    });
    extraRooms.push({
      top: pathResult.endFloorY - 2,
      bot: pathResult.endFloorY + 2,
      left: horizDir === 1 ? pathResult.endX : pathResult.endX - 4,
      right: horizDir === 1 ? pathResult.endX + 4 : pathResult.endX,
    });
    // The rolled chamber's feature is applied to THIS room's bounds, at the end
    // of the shared feature pass.
    chamberFeatures.push({ ...midCh, bounds: extraRooms[extraRooms.length - 1] });

  } else if (LAYOUT === 'boulder-chamber') {
    // ── The Cave of Seals' floor 1 — the trap room, minus the traps ─────
    //
    // Joel, 2026-08-26: "remove the traps from the trap room, add a random
    // boulder, add the smaller exit with wall chamber."
    //
    // Same head as `trap-chamber` (entrance arch, elbow, junction, drop into a
    // 7×7) and the same tail as `rock-switch` (boulder, Z-shaped exit path with
    // a false wall across it, small exit chamber, passage down). What it is NOT
    // is a trap floor: `LAYOUT_CONFIG['boulder-chamber']` sets `traps: 0`, so
    // the shared feature pass places none and the way down is the exit block
    // behind the wall the boulder opens.
    //
    // ⛔ THE BFS-SEAL RUNS WHILE THE WALL IS STILL OPEN. The `trap-chamber` head
    // ends by converting every FLOOR tile unreachable from the entrance landing
    // into CEILING — which, if the false wall were already carved, would ERASE
    // the entire exit chamber and the passage down with it. Carve the wall
    // after the seal, never before. This floor has no other guard against it:
    // every tile gate would report a perfectly connected floor with no exit.

    entranceX = 5 + Math.floor(rng() * 22); // 5-26
    const horizDir = entranceX > 16 ? -1 : entranceX < 16 ? 1 : (rng() < 0.5 ? -1 : 1);
    const vertDir = 1;

    const topology = rng() < 0.5 ? 'chain' : 'zigzag';
    plan.topology = topology;

    const entrFarDir = -horizDir;
    const entrCornerX = entranceX;
    const entrFloorY = 7;
    const midFloorY = topology === 'zigzag'
      ? entrFloorY + 2 + Math.floor(rng() * 3)   // 9-11
      : entrFloorY;
    planChamber(plan, tilemap, rng, 'entrance', { x: entrCornerX, y: entrFloorY, dir: entrFarDir });

    const horizStartX = entrCornerX;
    const horizFloorY = entrFloorY;
    const pathLength = CORR.hMin + Math.floor(rng() * hSpan);
    planElbow(plan, tilemap, { x0: horizStartX, y: horizFloorY, dir: horizDir, steps: pathLength, turnY: midFloorY });
    const pathEndX = Math.max(1, Math.min(30, horizStartX + pathLength * horizDir));
    const pathResult = { endX: pathEndX, endFloorY: midFloorY };

    // ⭐ Rolled from the catalogue, same as `trap-chamber`.
    const [midCh] = rollChambers(dungeon, floorIndex, ['mid'], rng);
    planChamber(plan, tilemap, rng, midCh.role, { x: pathResult.endX, y: pathResult.endFloorY, dir: horizDir });

    const vertRoll = CORR.vMin + Math.floor(rng() * vSpan);
    // ⛔ CLAMPED TO THE ROOM BUDGET, AND CLAMPED AFTER THE DRAW.
    //
    // The chamber hangs off the BOTTOM of this run, so a long vertical push its
    // far edge off the map: at 9-13 steps the 7x7 landed on rows 30-32 and took
    // its chests and the exit with it — 41 of 400 seeds, chests unopenable and
    // the way down stranded. The cap is the row the chamber's far edge may not
    // pass; drawing first and clamping second leaves the rng stream untouched,
    // and Altar Cave's 5-7 never reaches the cap, so it is unaffected.
    // ⛔ THE CAP FOLLOWS THE HALL'S HEIGHT. Doubling the hall moved its far edge
    // two rows down, so the `21 -` cap written for `dyMax: 6` let it run off the
    // bottom of the map.
    const vertLength = Math.min(vertRoll, 19 - pathResult.endFloorY);
    const vertX = pathResult.endX + 2 * horizDir;
    let vertY = pathResult.endFloorY + 2;
    vertY = planVLink(plan, tilemap, { x: vertX, y0: vertY, dir: vertDir, steps: vertLength }).endY;

    // `keepClear` holds a lane open on the sealed-chamber side so the jitter
    // cannot close the mouth of the passage the boulder opens.
    // ⭐ DOUBLE-SIZED BOULDER HALL. Joel, 2026-08-27: "f1 needs to be a boulder
    // room, but we gotta double the size of the room." Was 7 wide x 9 tall (63
    // tiles); now 11 x 11 (121). `halfW` is the only knob `carveWideChamber`
    // needs for the width; the extra height comes off `dyMax`, downward, because
    // the corridor enters through the top.
    const roomDyMin = -2;
    const roomDyMax = 8;
    const HALL_HALF_W = 5;
    const exitDir = -horizDir;
    const exitPathFloorY = vertY + 2;
    const exitPathDy = exitPathFloorY - vertY;
    planWideChamber(plan, tilemap, rng, 'puzzle', {
      x: vertX, y: vertY, dyMin: roomDyMin, dyMax: roomDyMax, halfW: HALL_HALF_W,
      keepClear: (dy) => (Math.abs(dy - exitPathDy) <= 1 ? (exitDir === -1 ? 'left' : 'right') : null),
    });

    // Z-shaped exit path out of the chamber — 1 walkable row after overhang,
    // no jitter. Carved OPEN; the false wall goes in after the seal below.
    const exitPathWidth = 1;
    const exitPathRoll = CORR.hMin + Math.floor(rng() * hSpan);
    const exitPathStartX = vertX + HALL_HALF_W * exitDir;
    // ⛔ CLAMPED TO WHAT ACTUALLY FITS, AND CLAMPED **AFTER** THE DRAW.
    //
    // The exit path doubles BACK toward the side of the map the entrance came
    // from, and this floor's head is longer than `rock-switch`'s, so near either
    // edge the tail runs out of columns. Unclamped it failed in two ways at once,
    // both silent: the carve loop `break`s at the edge while `exitPathEndX` is
    // computed as if it had not, so the exit chamber and its passage were placed
    // in solid rock — 12 of 200 seeds, exits stranded at x=2..9 and x=25..32.
    // Caught by `dungeon-sweep` only because it re-floods the OPENED map.
    //
    // The room spans `exitPathEndX .. exitPathEndX + 4*exitDir`, so that far edge
    // is what has to stay on the map. Drawing first and clamping second keeps the
    // rng stream identical to an unclamped draw — clamping the BOUNDS instead
    // would move the draw and change every floor below it.
    const exitSpan = exitDir === 1 ? (26 - exitPathStartX) : (exitPathStartX - 5);
    const exitPathLength = Math.min(exitPathRoll, exitSpan);
    for (let s = 1; s <= exitPathLength; s++) {
      const ex = exitPathStartX + s * exitDir;
      for (let dy = -(exitPathWidth + 1); dy <= 0; dy++) {
        const ey = exitPathFloorY + dy;
        if (ey >= 0 && ey < 32) tilemap[ey * 32 + ex] = FLOOR;
      }
    }
    const exitPathEndX = exitPathStartX + exitPathLength * exitDir;

    // The smaller exit chamber, behind the false wall. ⛔ THE BOULDER GATES THE
    // EXIT ON THIS FLOOR and that is deliberate — the treasure-instead-of-exit
    // rule is floor 2's, not floor 1's.
    planChamber(plan, tilemap, rng, 'exit', { x: exitPathEndX, y: exitPathFloorY, dir: exitDir });

    finishCaveShape(tilemap);

    // Entrance arch — as `trap-chamber`: 3 tiles into the room from the corridor
    // side, opening back toward the corridor.
    const archX = entrCornerX + 3 * entrFarDir;
    const archBaseRow = entrFloorY - 5;
    placeDeepEntrance(tilemap, archX, -entrFarDir, archBaseRow);
    entranceX = archX;
    entranceY = archBaseRow + 1; // PASSAGE_ENTRY row

    // The way down, in the chamber the boulder opens.
    const exitBlockX = exitPathEndX + 3 * exitDir;
    const exitBaseRow = exitPathFloorY - 5;
    placeDeepEntrance(tilemap, exitBlockX, -exitDir, exitBaseRow);
    // ⛔ THIS IS WHAT WIRES THE PASSAGE TO THE NEXT FLOOR. `PASSAGE_ENTRY` ($6a)
    // sits in the skipped trigger range, so `processTriggerTiles` never registers
    // it; the late pass keyed on `typeof rockExitX !== 'undefined'` adds the
    // type-4 trigger and points it at `dungeon.base + floorIndex + 1`. Without
    // these two lines the floor generates perfectly, the boulder opens the wall,
    // the staircase is drawn — and standing on it does nothing.
    var rockExitX = exitBlockX, rockExitY = exitBaseRow + 1; // PASSAGE_ENTRY position
    enforceMinCeilingGap(tilemap);

    // ⛔ SEAL FIRST, WALL SECOND. See the header note.
    const reachable = new Set();
    const startIdx = (archBaseRow + 3) * 32 + archX;
    reachable.add(startIdx);
    const bfsQ = [[archX, archBaseRow + 3]];
    while (bfsQ.length) {
      const [cx, cy] = bfsQ.shift();
      for (const [dx, dy] of [[0,1],[0,-1],[1,0],[-1,0]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || nx > 31 || ny < 0 || ny > 31) continue;
        const idx = ny * 32 + nx;
        if (reachable.has(idx)) continue;
        const t = tilemap[idx];
        if (t === FLOOR || t === PASSAGE_BTM || t === PASSAGE_ENTRY || t === BONES) {
          reachable.add(idx);
          bfsQ.push([nx, ny]);
        }
      }
    }
    for (let i = 0; i < 1024; i++) {
      if (!reachable.has(i) && tilemap[i] === FLOOR) tilemap[i] = CEILING;
    }

    // The false wall across the middle of the exit path. Two rocky rows and one
    // floor row, so it reads as ordinary rock until the boulder opens it — the
    // shape `rock-switch` uses and `handleRockPuzzle` restores tile by tile.
    const wallStep = Math.floor(exitPathLength / 2);
    const wallX = exitPathStartX + wallStep * exitDir;
    const wallTiles = [];
    for (let dy = -(exitPathWidth + 1); dy <= 0; dy++) {
      const wy = exitPathFloorY + dy;
      if (wy >= 0 && wy < 32) {
        tilemap[wy * 32 + wallX] = CEILING;
        const newTile = (dy <= -exitPathWidth) ? WALL_ROCKY : FLOOR;
        wallTiles.push({ x: wallX, y: wy, newTile });
      }
    }

    // The boulder — nearest floor tile to a randomly chosen corner of the 7×7,
    // which is where `rock-switch` puts its own. It has to be on the ENTRANCE
    // side of the wall, and it is: the whole chamber is.
    const roomX1 = vertX - HALL_HALF_W, roomX2 = vertX + HALL_HALF_W;
    const roomY1 = vertY + roomDyMin, roomY2 = vertY + roomDyMax;
    const cornerPts = [[roomX1,roomY1],[roomX2,roomY1],[roomX1,roomY2],[roomX2,roomY2]];
    for (let i = cornerPts.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [cornerPts[i], cornerPts[j]] = [cornerPts[j], cornerPts[i]];
    }
    const rockCandidates = [];
    for (const [cx, cy] of cornerPts) {
      let best = null, bestD = Infinity;
      for (let y = roomY1; y <= roomY2; y++) {
        for (let x = roomX1; x <= roomX2; x++) {
          if (x < 1 || x > 30 || y < 0 || y >= 32) continue;
          if (tilemap[y * 32 + x] !== FLOOR) continue;
          const d = Math.abs(x - cx) + Math.abs(y - cy);
          if (d < bestD) { bestD = d; best = { x, y }; }
        }
      }
      if (best) rockCandidates.push(best);
    }
    // ⛔ A BOULDER IS IMPASSABLE AND PERMANENT, SO IT MUST NOT SEVER THE FLOOR.
    //
    // v1.10.42 paid for this once already ("it cut 30 tiles and the exit to the
    // crystal room on one floor-3 seed") and the longer corridors brought it
    // straight back: the vertical run now ends INSIDE the chamber's top row, so
    // "nearest floor tile to the top corner" is frequently the corridor mouth
    // itself. The boulder plugged the passage it was supposed to open — the
    // chamber below it stranded, the exit unreachable, on 41 of 400 seeds.
    //
    // A corner is not a safe place by construction, and no amount of looking at
    // the tile can tell you. The only honest test is the one that entry names:
    // BLOCK IT AND RE-FLOOD. A safe candidate costs exactly itself.
    const floodSize = (blockX, blockY) => {
      const seenR = new Uint8Array(1024);
      const q = [entranceY * 32 + entranceX];
      seenR[q[0]] = 1;
      let n = 0;
      for (let h = 0; h < q.length; h++) {
        const i = q[h]; n++;
        const x = i % 32, y = (i - x) / 32;
        for (const [dx, dy] of [[0,1],[0,-1],[1,0],[-1,0]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx > 31 || ny < 0 || ny > 31) continue;
          if (nx === blockX && ny === blockY) continue;
          const ni = ny * 32 + nx;
          if (seenR[ni]) continue;
          const t = tilemap[ni];
          if (t !== FLOOR && t !== BONES && t !== PASSAGE_BTM && t !== PASSAGE_ENTRY) continue;
          seenR[ni] = 1; q.push(ni);
        }
      }
      return n;
    };
    const openSize = floodSize(-1, -1);
    const safeRocks = rockCandidates.filter((c) => floodSize(c.x, c.y) === openSize - 1);

    var rockSwitch = null;
    if (safeRocks.length > 0) {
      const rock = safeRocks[Math.floor(rng() * safeRocks.length)];
      tilemap[rock.y * 32 + rock.x] = 0x0B;
      rockSwitch = { rocks: [{ x: rock.x, y: rock.y }], wallTiles };
    }

    // ⭐ A BOULDER ON EACH SIDE, BECAUSE THIS WALL LEADS OFF THE FLOOR.
    //
    // Joel, 2026-08-27: *"if a boulder puzzle ever leads to an exit, it needs
    // two boulders. one on each side of the wall, like its built in altar f2.
    // but if its a treasure room, pond room, or any other chamber that doesn't
    // leave the floor, it won't need a 2nd boulder."*
    //
    // Altar Cave's `rock-switch` has always had two — one in the hall, one in
    // the room beyond the wall, so the wall opens from either side. This floor
    // shipped with ONE and its wall gates the way DOWN, so a player standing on
    // the far side had nothing to reopen it with. Counted before the fix:
    // 2 boulders on 399 of 400 altar f2 seeds, 1 on 400 of 400 here.
    //
    // ⛔ THE FAR SIDE IS UNREACHABLE UNTIL THE WALL OPENS, so the severance test
    // has to run on the OPENED map — `floodSize` above floods the shut one, where
    // every tile over there costs nothing because none of it is reachable anyway.
    if (rockSwitch) {
      const openedTm = Uint8Array.from(tilemap);
      for (const w of wallTiles) openedTm[w.y * 32 + w.x] = w.newTile;
      const openFull = reachableCount(openedTm, entranceX, entranceY);
      // Everything you stand BESIDE to use — the passage down, chests — plus its
      // own neighbours, so the second boulder cannot wall in the staircase it
      // shares a room with.
      const rockUsed = new Set();
      for (let i = 0; i < 1024; i++) {
        const t = tilemap[i];
        if (t !== CHEST && t !== PASSAGE_ENTRY && t !== PASSAGE_BTM && t !== STAIR_ARCH
            && t !== STAIRS_DOWN && t !== EXIT_PREV) continue;
        const x = i % 32, y = (i - x) / 32;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) rockUsed.add(`${x + dx},${y + dy}`);
      }
      const farBounds = {
        left:  exitDir === 1 ? exitPathEndX : exitPathEndX - 4,
        right: exitDir === 1 ? exitPathEndX + 4 : exitPathEndX,
        top: exitPathFloorY - 2, bot: exitPathFloorY + 2,
      };
      const farSafe = (p) => reachableCount(openedTm, entranceX, entranceY,
        new Set([`${p.x},${p.y}`])) === openFull - 1;
      let far = findCornerFloor(tilemap, rng, rockUsed, farBounds);
      if (far && !farSafe(far)) far = null;
      // ⛔ A CORNER IS NOT GUARANTEED IN A 5x5 WITH A STAIRCASE IN IT. Fall back
      // to any safe floor tile in the room rather than shipping a one-sided exit
      // puzzle, which is the whole defect being fixed.
      if (!far) {
        for (let y = farBounds.top; y <= farBounds.bot && !far; y++) {
          for (let x = farBounds.left; x <= farBounds.right; x++) {
            if (x < 1 || x > 30 || y < 0 || y >= 32) continue;
            if (tilemap[y * 32 + x] !== FLOOR) continue;
            if (rockUsed.has(`${x},${y}`)) continue;
            if (!farSafe({ x, y })) continue;
            far = { x, y }; break;
          }
        }
      }
      if (far) {
        tilemap[far.y * 32 + far.x] = 0x0B;
        rockSwitch.rocks.push({ x: far.x, y: far.y });
      }
    }

    var exitXForSecret = null;
    var startRowForSecret = 7;
    var endRowForSecret = 27;
    // ⛔ TELL THE SHARED FEATURE PASS WHERE THE EXIT BLOCK IS. It seeds its
    // exclusion set from the ENTRANCE only, and its corner-chest search falls
    // back to "any corner anywhere" when the chamber has none free — so it put a
    // chest on the landing tile of the passage down. A chest is not walkable, so
    // the way to floor 2 was sealed by treasure: 12 of 400 seeds, and every tile
    // gate reported a perfectly connected floor. `rock-switch` never hits this
    // because it places its own chests and excludes the block by hand.
    var exitXForUsed = exitBlockX;
    var endRowForUsed = exitBaseRow;
    // Chest scatter targets the boulder chamber, as the trap room's did.
    var chamberBounds = {
      top: vertY + roomDyMin,
      bot: vertY + roomDyMax,
      left: vertX - 3,
      right: vertX + 3,
    };

    extraRooms.push({
      top: entrFloorY - 2,
      bot: entrFloorY + 2,
      left: entrFarDir === 1 ? entrCornerX : entrCornerX - 4,
      right: entrFarDir === 1 ? entrCornerX + 4 : entrCornerX,
    });
    extraRooms.push({
      top: pathResult.endFloorY - 2,
      bot: pathResult.endFloorY + 2,
      left: horizDir === 1 ? pathResult.endX : pathResult.endX - 4,
      right: horizDir === 1 ? pathResult.endX + 4 : pathResult.endX,
    });
    // The rolled chamber's feature is applied to THIS room's bounds, at the end
    // of the shared feature pass.
    chamberFeatures.push({ ...midCh, bounds: extraRooms[extraRooms.length - 1] });

  } else if (LAYOUT === 'rock-switch') {
    // ── Floor 2: Rock puzzle — building incrementally ───────────────────
    // Step 1: just a small room for the trap landing

    // Position based on vertical direction so everything fits on map
    // ── Entrance, SAMPLED (v1.10.36 — phase 3) ─────────────────────────
    // `entranceX` was the literal 15 and `startFloorY` one of two values, so
    // this floor had exactly TWO entrance positions across any number of seeds.
    //
    // ⛔ The corridor must still be AIMED AT THE MIDDLE. Everything downstream
    // chains off the entrance in `horizDir` — corridor, 5x5 room, the 7x7
    // chamber, then the exit path doubling back — and that chain is about
    // fifteen columns long. Picking a direction at random would run half of them
    // off the map. Same rule floor 1 already uses.
    entranceX = 8 + Math.floor(rng() * 15);       // 8-22
    const vertDirEarly = rng() < 0.5 ? -1 : 1;    // peek ahead so we can position the entrance
    const startFloorY = vertDirEarly === -1
      ? 23 + Math.floor(rng() * 3)                // 23-25, entering from the bottom
      : 7 + Math.floor(rng() * 3);                // 7-9,   entering from the top

    // ── Topology (v1.10.35) ────────────────────────────────────────────
    // Same pair as floor 1, whose architecture this floor's was copied into.
    // `zigzag` puts the mid room at its own height, reached by an ELBOW.
    const topology = rng() < 0.5 ? 'chain' : 'zigzag';
    plan.topology = topology;
    // ⛔ The offset must move the mid room AWAY from the vertical corridor's
    // travel, not into it: this floor runs up from row 24 or down from row 8, so
    // a mid room nudged the wrong way crowds the 7x7 chamber it is about to drop
    // into. Offsetting against `vertDirEarly` keeps the run length intact.
    // ⛔ EXACTLY TWO ROWS. Three strands this floor's exit room and part of its
    // puzzle: the chain from here — corridor, 5x5 room, vertical drop, 7x7
    // chamber, then the exit path doubling back — is long and every link is
    // positioned off the last, so the offset compounds down it. Measured over
    // 3,000 seeds per floor across five seed bases: offset 2 clean on all five,
    // offset 3 failing on three of them. It took a FOURTH base to surface at all.
    const midFloorY = topology === 'zigzag' ? startFloorY - vertDirEarly * 2 : startFloorY;

    // Entrance room: 3-4 wide, no jitter (too small — enforceMinCeilingGap eats thin runs)
    const entrBaseW = 2 + Math.floor(rng() * 2); // dx 0..2 or 0..3
    planBoxChamber(plan, tilemap, 'entrance', { x: entranceX, y: startFloorY, w: entrBaseW });

    // Short horizontal pathway (1 walkable row after overhang)
    const horizDir = entranceX > 15 ? -1 : entranceX < 15 ? 1 : (rng() < 0.5 ? -1 : 1);
    const pathLength = CORR.hMin + Math.floor(rng() * hSpan);
    const horizStartX = horizDir === 1 ? entranceX + 2 : entranceX;
    planElbow(plan, tilemap, { x0: horizStartX, y: startFloorY, dir: horizDir, steps: pathLength, turnY: midFloorY });
    const pathEndX = horizStartX + pathLength * horizDir;
    const pathResult = { endX: Math.max(1, Math.min(30, pathEndX)), endFloorY: midFloorY };

    // 5×5 room with irregular edges — ⭐ rolled from the catalogue.
    const [midCh] = rollChambers(dungeon, floorIndex, ['mid'], rng);
    planChamber(plan, tilemap, rng, midCh.role, { x: pathResult.endX, y: pathResult.endFloorY, dir: horizDir });

    // Vertical pathway (1 tile wide)
    const vertDir = vertDirEarly;
    const vertRoll = CORR.vMin + Math.floor(rng() * vSpan);
    // ⛔ SAME CLAMP, BOTH DIRECTIONS. This floor runs UP from the bottom or DOWN
    // from the top, and the 7x7 hangs off whichever end — `roomDyMin/-8` above
    // when climbing, `roomDyMax/+6` below when descending. Altar Cave's 5-7 never
    // reaches either cap, so its floors are unchanged.
    const vertLength = Math.min(vertRoll, vertDirEarly === -1
      ? midFloorY - 12               // climbing: keep vertY-8 on the map
      : 21 - midFloorY);             // descending: keep vertY+6 on the map
    const vertX = pathResult.endX + 2 * horizDir; // middle of 5×5 room
    let vertY = vertDir === -1 ? pathResult.endFloorY - 2 : pathResult.endFloorY + 2;
    vertY = planVLink(plan, tilemap, { x: vertX, y0: vertY, dir: vertDir, steps: vertLength }).endY;

    // 7×7 room with irregular edges
    const roomDyMin = vertDir === -1 ? -8 : -2;
    const roomDyMax = vertDir === -1 ? 0 : 6;
    const exitDir = -horizDir;
    const exitPathFloorY = vertDir === -1 ? vertY - 2 : vertY + 2;
    const exitPathDy = exitPathFloorY - vertY;
    planWideChamber(plan, tilemap, rng, 'puzzle', {
      x: vertX, y: vertY, dyMin: roomDyMin, dyMax: roomDyMax,
      keepClear: (dy) => (Math.abs(dy - exitPathDy) <= 1 ? (exitDir === -1 ? 'left' : 'right') : null),
    });

    // Exit pathway from 7×7 room — the Z-shape (1 tile wide, NO jitter)
    const exitPathWidth = 1;
    const exitPathLength = CORR.hMin + Math.floor(rng() * hSpan);
    const exitPathStartX = vertX + 3 * exitDir;
    for (let s = 1; s <= exitPathLength; s++) {
      const ex = exitPathStartX + s * exitDir;
      if (ex < 1 || ex > 30) break;
      for (let dy = -(exitPathWidth + 1); dy <= 0; dy++) {
        const ey = exitPathFloorY + dy;
        if (ey >= 0 && ey < 32) tilemap[ey * 32 + ex] = FLOOR;
      }
    }
    const exitPathEndX = exitPathStartX + exitPathLength * exitDir;

    // 5×5 exit room with irregular edges
    planChamber(plan, tilemap, rng, 'exit', { x: exitPathEndX, y: exitPathFloorY, dir: exitDir });

    // Cleanup + overhang
    finishCaveShape(tilemap);

    // Exit block in exit room — passage entry to next floor
    const exitBlockX = exitPathEndX + 3 * exitDir;
    const exitBaseRow = exitPathFloorY - 5;
    placeDeepEntrance(tilemap, exitBlockX, -exitDir, exitBaseRow);
    var rockExitX = exitBlockX, rockExitY = exitBaseRow + 1; // PASSAGE_ENTRY position
    enforceMinCeilingGap(tilemap);

    // ⭐ HOW YOU ARRIVE DEPENDS ON HOW THE FLOOR ABOVE LET YOU LEAVE.
    //
    // This layout was written for Altar Cave, where you FALL onto it through
    // floor 1's trap holes — which is why its entrance is a bare box room with
    // no staircase: there is nothing to climb back to. The Cave of Seals' floor
    // 1 is a boulder puzzle whose exit is a PASSAGE, so its player walks DOWN a
    // staircase and arrived, until now, standing on plain floor with nothing
    // behind them.
    //
    // Derived from the layout ABOVE rather than from the dungeon id, so it stays
    // true if floors are ever reordered: you fell iff the floor above is a
    // `trap-chamber`. Altar Cave's floor 1 is exactly that, so its floor 2 keeps
    // the bare landing and is byte-identical.
    const _arrivedByFalling = layoutForFloor(dungeon, floorIndex - 1) === 'trap-chamber';
    if (!_arrivedByFalling) {
      // An arrival arch, in the entrance room, opening TOWARD the corridor —
      // the same rule `trap-chamber` uses for its own entrance.
      //
      // ⛔ IT GOES AT THE FAR EDGE FROM THE CORRIDOR, NOT THE MIDDLE.
      // `placeDeepEntrance` lays WALL_ROCKY on the arch's CLOSED side, and from
      // the middle of the room that wall landed across the corridor mouth and
      // severed it — one stranded tile, one seed in three hundred, invisible to
      // everything except the sweep's pocket check.
      const _archX = Math.max(2, Math.min(29, horizDir === 1 ? entranceX : entranceX + entrBaseW));
      const _archBase = startFloorY - 5;
      placeDeepEntrance(tilemap, _archX, horizDir, _archBase);
      enforceMinCeilingGap(tilemap);
      entranceX = _archX;
      entranceY = _archBase + 1;                 // the PASSAGE_ENTRY row
    } else {

    // Trap spawn point — center of entrance room
    const spawnX = entranceX + Math.floor(entrBaseW / 2);
    const spawnY = startFloorY - 1; // middle of 3 walkable rows after overhang
    // Verify it's floor, fall back to scan if not
    if (spawnX >= 0 && spawnX < 32 && spawnY >= 0 && spawnY < 32 && tilemap[spawnY * 32 + spawnX] === FLOOR) {
      entranceX = spawnX;
      entranceY = spawnY;
    } else {
      entranceY = startFloorY;
      for (let d = 0; d < 32; d++) {
        if (startFloorY + d < 32 && tilemap[(startFloorY + d) * 32 + entranceX] === FLOOR) {
          entranceY = startFloorY + d; break;
        }
        if (startFloorY - d >= 0 && tilemap[(startFloorY - d) * 32 + entranceX] === FLOOR) {
          entranceY = startFloorY - d; break;
        }
      }
    }
    }

    // Rock switch — find a corner floor tile in the 7×7 room
    const roomX1 = vertX - 3, roomX2 = vertX + 3;
    const roomY1 = vertY + roomDyMin, roomY2 = vertY + roomDyMax;
    const cornerPts = [[roomX1,roomY1],[roomX2,roomY1],[roomX1,roomY2],[roomX2,roomY2]];
    for (let i = cornerPts.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [cornerPts[i], cornerPts[j]] = [cornerPts[j], cornerPts[i]];
    }
    // For each corner, find the nearest FLOOR tile
    const rockCandidates = [];
    for (const [cx, cy] of cornerPts) {
      let best = null, bestD = Infinity;
      for (let y = roomY1; y <= roomY2; y++) {
        for (let x = roomX1; x <= roomX2; x++) {
          if (x < 1 || x > 30 || y < 0 || y >= 32) continue;
          if (tilemap[y * 32 + x] !== FLOOR) continue;
          const d = Math.abs(x - cx) + Math.abs(y - cy);
          if (d < bestD) { bestD = d; best = { x, y }; }
        }
      }
      if (best) rockCandidates.push(best);
    }
    // False wall (ceiling door) — vertical column of CEILING in center of exit pathway
    const wallStep = Math.floor(exitPathLength / 2);
    const wallX = exitPathStartX + wallStep * exitDir;
    const wallTiles = [];
    for (let dy = -(exitPathWidth + 1); dy <= 0; dy++) {
      const wy = exitPathFloorY + dy;
      if (wy >= 0 && wy < 32) {
        tilemap[wy * 32 + wallX] = CEILING;
        // Top 2 tiles become WALL_ROCKY (overhang), rest become FLOOR (opening)
        const newTile = (dy <= -exitPathWidth) ? WALL_ROCKY : FLOOR;
        wallTiles.push({ x: wallX, y: wy, newTile });
      }
    }

    var rockSwitch = null;
    if (rockCandidates.length > 0) {
      const rock = rockCandidates[Math.floor(rng() * rockCandidates.length)];
      tilemap[rock.y * 32 + rock.x] = 0x0B;
      rockSwitch = { rocks: [{ x: rock.x, y: rock.y }], wallTiles };
    }

    // Chests in corners of each room (not entrance room)
    const chestUsed = new Set();
    chestUsed.add(`${entranceX},${entranceY}`);
    if (rockSwitch) {
      for (const r of rockSwitch.rocks) {
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++)
            chestUsed.add(`${r.x + dx},${r.y + dy}`);
      }
    }
    // Exclude exit block area
    for (let dy = -3; dy <= 3; dy++)
      for (let dx = -2; dx <= 2; dx++)
        chestUsed.add(`${exitBlockX + dx},${exitBaseRow + dy}`);

    // First 5×5 room bounds
    const rm1Left = horizDir === 1 ? pathResult.endX : pathResult.endX - 4;
    const rm1Right = horizDir === 1 ? pathResult.endX + 4 : pathResult.endX;
    const rm1Bounds = { left: rm1Left, right: rm1Right, top: startFloorY - 2, bot: startFloorY + 2 };
    chamberFeatures.push({ ...midCh, bounds: rm1Bounds });
    for (let i = 0; i < 1; i++) {
      const pos = findCornerFloor(tilemap, rng, chestUsed, rm1Bounds);
      if (pos) {
        tilemap[pos.y * 32 + pos.x] = CHEST;
        for (let dy = -3; dy <= 3; dy++)
          for (let dx = -3; dx <= 3; dx++)
            chestUsed.add(`${pos.x + dx},${pos.y + dy}`);
      }
    }

    // 7×7 room bounds
    const rm7Bounds = { left: vertX - 3, right: vertX + 3, top: vertY + roomDyMin + 2, bot: vertY + roomDyMax };
    for (let i = 0; i < 1 + Math.floor(rng() * 2); i++) {
      const pos = findCornerFloor(tilemap, rng, chestUsed, rm7Bounds);
      if (pos) {
        tilemap[pos.y * 32 + pos.x] = CHEST;
        for (let dy = -3; dy <= 3; dy++)
          for (let dx = -3; dx <= 3; dx++)
            chestUsed.add(`${pos.x + dx},${pos.y + dy}`);
      }
    }

    // Exit 5×5 room bounds
    const rm2Left = exitDir === 1 ? exitPathEndX : exitPathEndX - 4;
    const rm2Right = exitDir === 1 ? exitPathEndX + 4 : exitPathEndX;
    const rm2Bounds = { left: rm2Left, right: rm2Right, top: exitPathFloorY - 2, bot: exitPathFloorY + 2 };
    for (let i = 0; i < 1; i++) {
      const pos = findCornerFloor(tilemap, rng, chestUsed, rm2Bounds);
      if (pos) {
        tilemap[pos.y * 32 + pos.x] = CHEST;
        for (let dy = -3; dy <= 3; dy++)
          for (let dx = -3; dx <= 3; dx++)
            chestUsed.add(`${pos.x + dx},${pos.y + dy}`);
      }
    }

    // ── The far-side boulder — opens the false wall from the other side.
    //
    // ⛔ IT HAS TO BE IN THE REGION THE WALL SEALS, NOT MERELY IN THE EXIT ROOM.
    // Joel, 2026-08-27: *"altar f2 has to have 100% 2 boulders."*
    //
    // This was `findCornerFloor(tilemap, rng, rockUsed, rm2Bounds)` — a corner of
    // the exit ROOM, on the SHUT map, with no test of which side of the wall it
    // landed on. Two ways that came up short, both measured over 2,000 seeds:
    //
    //   * On 16.3% of seeds part of the exit room is already reachable by another
    //     route (the same walk-around `walkaroundCap` pins), so the corner it
    //     picked was on the reachable side. The boulder existed; it was not on
    //     the far side of anything, and a player standing in the sealed part had
    //     nothing to push.
    //   * On ~1 seed in 400 the room offered no corner at all and the floor
    //     shipped with ONE boulder.
    //
    // Both fixed the same way: derive the sealed region — unreachable now,
    // reachable once the wall opens — and take the boulder FROM it. Corners
    // first, so it still reads as placed rather than dropped; any safe tile in
    // the region if the room has no free corner, because one boulder is the
    // defect being fixed and a plain tile is not.
    //
    // ⛔ AND THE SEVERANCE TEST RUNS ON THE OPENED MAP. Flooding the shut one
    // says every tile over there costs nothing, because none of it is reachable
    // anyway — the test would pass a boulder dropped straight onto the doorway.
    if (rockSwitch) {
      const rockUsed = new Set();
      for (let i = 0; i < 1024; i++) {
        const t = tilemap[i];
        if (t === CHEST || t === PASSAGE_ENTRY || t === PASSAGE_BTM || t === 0x6c) {
          const x = i % 32, y = (i - x) / 32;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++)
              rockUsed.add(`${x + dx},${y + dy}`);
        }
      }
      const openedTm = Uint8Array.from(tilemap);
      for (const w of wallTiles) openedTm[w.y * 32 + w.x] = w.newTile;
      const shutMask = reachableFloorMask(tilemap, entranceX, entranceY);
      const openMask = reachableFloorMask(openedTm, entranceX, entranceY);
      const openFull = reachableCount(openedTm, entranceX, entranceY);
      const sealed = [];
      for (let i = 0; i < 1024; i++) {
        if (shutMask[i] || !openMask[i]) continue;
        if (tilemap[i] !== FLOOR) continue;
        const x = i % 32, y = (i - x) / 32;
        if (rockUsed.has(`${x},${y}`)) continue;
        if (reachableCount(openedTm, entranceX, entranceY, new Set([`${x},${y}`])) !== openFull - 1) continue;
        sealed.push({ x, y });
      }
      // A corner is a tile with a wall on each axis — the same shape
      // `findCornerFloor` looks for, asked of the sealed region instead of a
      // rectangle. Prefer them; fall back to the whole region.
      const isCorner = (p) => {
        const f = (x, y) => (x >= 0 && x < 32 && y >= 0 && y < 32 && isFloorTile(tilemap[y * 32 + x]));
        const wL = !f(p.x - 1, p.y), wR = !f(p.x + 1, p.y);
        const wU = !f(p.x, p.y - 1), wD = !f(p.x, p.y + 1);
        return (wL !== wR) && (wU !== wD);
      };
      // ⛔ AND IT IS PLACED EVEN WHEN THERE IS NO FAR SIDE TO PLACE IT ON.
      // Joel, 2026-08-27: *"altar f2 has to have 100% 2 boulders."*
      //
      // On the seeds this floor lets you walk around the wall, the region the
      // wall seals is exactly ONE TILE — the wall's own opening. Measured: 71 of
      // 400, sealed region size 1, tile $00. There is no other side to stand on,
      // so "one on each side" has nothing to attach to, and a first pass that
      // required the sealed region simply placed no second boulder at all: it
      // took the count from 399/400 DOWN to 329/400.
      //
      // So the sealed region is a PREFERENCE, not a condition. The exit room is
      // the fallback, which is where this boulder always used to go — the count
      // is what was asked for and the count is now exact.
      //
      // ⛔ The 71 seeds are the walk-around wart (`walkaroundCap`), seen a third
      // way. Closing THAT is what would make "one on each side" reach 100% here;
      // it is a different change and it moves this floor again.
      const roomFloor = [];
      for (let y = rm2Bounds.top; y <= rm2Bounds.bot; y++) {
        for (let x = rm2Bounds.left; x <= rm2Bounds.right; x++) {
          if (x < 1 || x > 30 || y < 0 || y >= 32) continue;
          if (tilemap[y * 32 + x] !== FLOOR) continue;
          if (rockUsed.has(`${x},${y}`)) continue;
          if (reachableCount(openedTm, entranceX, entranceY, new Set([`${x},${y}`])) !== openFull - 1) continue;
          roomFloor.push({ x, y });
        }
      }
      const sealedCorners = sealed.filter(isCorner);
      const roomCorners = roomFloor.filter(isCorner);
      // Best available, in order: a corner of the sealed region, any tile of it,
      // a corner of the exit room, any tile of the exit room.
      const pool = sealedCorners.length ? sealedCorners
                 : sealed.length ? sealed
                 : roomCorners.length ? roomCorners
                 : roomFloor;
      // ⛔ ONE DRAW, ALWAYS — `findCornerFloor` made zero when it found nothing,
      // so the number of rng calls depended on whether the room had a corner.
      const pick = pool.length ? pool[Math.floor(rng() * pool.length)] : (rng(), null);
      if (pick) {
        tilemap[pick.y * 32 + pick.x] = 0x0B;
        rockSwitch.rocks.push({ x: pick.x, y: pick.y });
      }
    }

    // Bones scattered in each room (not entrance room)
    const boneUsed = new Set();
    boneUsed.add(`${entranceX},${entranceY}`);
    if (rockSwitch) {
      for (const r of rockSwitch.rocks) {
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++)
            boneUsed.add(`${r.x + dx},${r.y + dy}`);
      }
    }
    // Exclude all feature tiles
    for (let i = 0; i < 1024; i++) {
      const t = tilemap[i];
      if (t === CHEST || t === STAIRS_DOWN || t === EXIT_PREV || t === PASSAGE_ENTRY || t === PASSAGE_BTM) {
        const x = i % 32, y = (i - x) / 32;
        boneUsed.add(`${x},${y}`);
      }
    }
    // Exclude entrance area
    for (let dy = -3; dy <= 1; dy++) {
      if (entranceY + dy >= 0) boneUsed.add(`${entranceX},${entranceY + dy}`);
    }

    // First 5×5 room: 2 bones
    for (let i = 0; i < 2; i++) {
      const pos = findRandomFloor(tilemap, rng, boneUsed, rm1Bounds);
      if (pos) {
        tilemap[pos.y * 32 + pos.x] = BONES;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++)
            boneUsed.add(`${pos.x + dx},${pos.y + dy}`);
      }
    }
    // 7×7 room: 3 bones
    for (let i = 0; i < 3; i++) {
      const pos = findRandomFloor(tilemap, rng, boneUsed, rm7Bounds);
      if (pos) {
        tilemap[pos.y * 32 + pos.x] = BONES;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++)
            boneUsed.add(`${pos.x + dx},${pos.y + dy}`);
      }
    }
    // Exit 5×5 room: 2 bones
    for (let i = 0; i < 2; i++) {
      const pos = findRandomFloor(tilemap, rng, boneUsed, rm2Bounds);
      if (pos) {
        tilemap[pos.y * 32 + pos.x] = BONES;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++)
            boneUsed.add(`${pos.x + dx},${pos.y + dy}`);
      }
    }

    var exitXForSecret = null;
    var startRowForSecret = 7;
    var endRowForSecret = 27;
    var exitXForUsed = null;
    var endRowForUsed = 27;
    var chamberBounds = null;

    // Locked-room chamber door — 50% chance. Anchored to ONE OF the middle
    // rooms (5×5 rock puzzle room or 7×7 hub) — explicitly NOT the entry
    // or exit chambers. Search the whole map for valid 5-rock-surround
    // positions, then reject any that fall within the entry / exit zones.
    // v1.7.679.
    const LOCKED_DOOR_CHANCE_F3 = 0.5;
    if (rng() < LOCKED_DOOR_CHANCE_F3) {
      const entryMinX = entranceX - 4, entryMaxX = entranceX + 6;
      const entryMinY = startFloorY - 5, entryMaxY = startFloorY + 2;
      const exitMinX = Math.min(exitPathEndX, exitPathEndX + 4 * exitDir) - 2;
      const exitMaxX = Math.max(exitPathEndX, exitPathEndX + 4 * exitDir) + 2;
      const exitMinY = exitPathFloorY - 5, exitMaxY = exitPathFloorY + 2;
      const inEntry = (x, y) => x >= entryMinX && x <= entryMaxX && y >= entryMinY && y <= entryMaxY;
      const inExit  = (x, y) => x >= exitMinX  && x <= exitMaxX  && y >= exitMinY  && y <= exitMaxY;
      const candidates = [];
      for (let y = 2; y < 31; y++) {
        for (let x = 1; x < 31; x++) {
          if (inEntry(x, y) || inExit(x, y)) continue;
          if (tilemap[y * 32 + x] !== WALL_ROCKY) continue;
          if (tilemap[y * 32 + x - 1] !== WALL_ROCKY) continue;
          if (tilemap[y * 32 + x + 1] !== WALL_ROCKY) continue;
          if (tilemap[(y - 1) * 32 + x] !== WALL_ROCKY) continue;
          if (tilemap[(y - 1) * 32 + x - 1] !== WALL_ROCKY) continue;
          if (tilemap[(y - 1) * 32 + x + 1] !== WALL_ROCKY) continue;
          const below = tilemap[(y + 1) * 32 + x];
          if (below !== FLOOR && below !== BONES && below !== FALSE_CEILING) continue;
          candidates.push({ x, y });
        }
      }
      // ⛔ NO ROOM, NO DOOR. `lockedRoomMapIdForFloor` returns null for a dungeon
      // that declares no locked room on this floor, and the old code set
      // `{ mapId: null }` regardless — a door the player opens onto nothing.
      // Measured on the Cave of Seals: 43 of 120 generated floors had one.
      const _lockedId = lockedRoomMapIdForFloor(dungeon, floorIndex);
      if (candidates.length > 0 && _lockedId !== null) {
        const doorPos = candidates[Math.floor(rng() * candidates.length)];
        placeChamberDoor(tilemap, doorPos.x, doorPos.y);
        lockedRoomDoors.set(`${doorPos.x},${doorPos.y}`, { mapId: _lockedId });
        lockedDoors.add(`${doorPos.x},${doorPos.y}`);
      }
    }

  } else if (LAYOUT === 'chamber-run') {
    // ── A RUN OF CHAMBERS, WITH THE BOULDER OPENING A VAULT ─────────────
    //
    // Joel, 2026-08-27: *"f2 is gonna be random chambers. entrance chamber to
    // exit chamber. Boulder puzzles will only be to open treasure chambers.
    // not an exit."*
    //
    // ⛔ THE WAY ONWARD IS NEVER BEHIND THE WALL. That is the whole difference
    // from `rock-switch`, which puts its false wall in the middle of the run to
    // the exit chamber and makes the boulder the only way off the floor. Here
    // the run is open end to end; the wall seals a DEAD-END alcove instead.
    // `dungeon-sweep` pins this layout as `gates: 'treasure'`, which inverts
    // every assertion: the exit must be reachable without touching the boulder
    // on EVERY seed, and the sealed side must actually hold a chest.
    //
    // ⛔ THE HUB IS FIVE WIDE, NOT SEVEN. The giant hall belongs to floor 1
    // (`boulder-chamber`); this floor spends its rows on two branches leaving
    // one hub, and a 7-wide hall leaves no room for the second.
    //
    // Shape — a T lying on its side, the run doubling back over itself:
    //
    //     [entrance] --------- corridor ---------> [chamber A]
    //                                                   |
    //                                               vertical
    //                                                   |
    //        [ VAULT ] === wall === stub --------- [ hub + boulder ]
    //                                                   |
    //                       [exit chamber] <-- corridor -+
    //
    // Chamber A and the hub are both ROLLED from `data/chambers.js`; the
    // entrance, the exit and the vault are fixed, because what they are is what
    // the floor is for.

    // ── Columns. Drawn first, then the hub is placed where both branches fit.
    const runDir   = rng() < 0.5 ? 1 : -1;   // hub -> exit chamber
    const vaultDir = -runDir;                // hub -> vault alcove
    const horizDir = vaultDir;               // entrance -> chamber A, over the exit run
    const exitDir  = runDir;

    const vaultLen = 3 + Math.floor(rng() * 3);              // 3-5: an alcove, not a run
    const hubJit   = Math.floor(rng() * 3);                  // 0-2
    const exitRoll = CORR.hMin + Math.floor(rng() * hSpan);
    const pathRoll = CORR.hMin + Math.floor(rng() * hSpan);
    const entrBaseW = 2 + Math.floor(rng() * 2);

    // ⛔ CLAMPED AFTER THE DRAW, NEVER BEFORE. Narrowing a range before it is
    // rolled changes the distribution; clamping the result only trims the tail
    // that would not have fitted anyway. Same rule the corridor bounds follow.
    //
    // The hub sits `HUB_HALF_W + vaultLen + 5` columns clear of the vault-side
    // edge, which is the least the alcove can occupy, and everything left over
    // goes to the run onward. The two expressions are exact mirrors (x -> 31-x).
    const HUB_HALF_W = 2;
    // Read as if the run went RIGHT, then mirrored (x -> 31-x) if it does not,
    // so the two hands of this floor are exact reflections and only one budget
    // has to be reasoned about.
    //   `8 + vaultLen`  the least the alcove can occupy on the far side
    //   `23 - exitRoll` the most the hub can sit right and still give the run
    //                   onward its full drawn length
    // The jitter moves the hub between them; where they cross, the alcove wins
    // and the run onward is the thing that gets trimmed — a short main corridor
    // is a worse floor than a short dead-end stub.
    const hubMin = 8 + vaultLen;
    const hubRight = Math.max(hubMin, Math.min(hubMin + hubJit, 23 - exitRoll));
    const hubX = runDir === 1 ? hubRight : 31 - hubRight;
    const exitLen   = Math.max(4, Math.min(exitRoll, runDir === 1 ? 23 - hubX : hubX - 8));
    const pathLength = Math.max(4, Math.min(pathRoll, runDir === 1 ? 25 - hubX : hubX - 6));

    // ── Rows. Same top/bottom entry split `rock-switch` uses.
    const vertDir = rng() < 0.5 ? -1 : 1;
    const startFloorY = vertDir === -1
      ? 23 + Math.floor(rng() * 3)                 // 23-25, climbing
      : 7 + Math.floor(rng() * 3);                 // 7-9,   descending
    const topology = rng() < 0.5 ? 'chain' : 'zigzag';
    plan.topology = topology;
    const midFloorY = topology === 'zigzag' ? startFloorY - vertDir * 2 : startFloorY;
    const vertRoll = CORR.vMin + Math.floor(rng() * vSpan);
    // Both branches and the hub carve the same seven rows, and the exit block
    // reaches one row above them — so the whole floor fits inside vertY-5..vertY+2.
    const vertLength = Math.max(4, Math.min(vertRoll, vertDir === -1
      ? midFloorY - 8                              // climbing:   keep vertY-5 >= 0
      : 25 - midFloorY));                          // descending: keep vertY+2 <= 29

    // ── Carve.
    const pathEndX = hubX - HUB_HALF_W * horizDir;          // chamber A's near edge
    entranceX = horizDir === 1
      ? pathEndX - pathLength - entrBaseW
      : pathEndX + pathLength;
    planBoxChamber(plan, tilemap, 'entrance', { x: entranceX, y: startFloorY, w: entrBaseW });

    const horizStartX = horizDir === 1 ? entranceX + entrBaseW : entranceX;
    planElbow(plan, tilemap, { x0: horizStartX, y: startFloorY, dir: horizDir, steps: pathLength, turnY: midFloorY });

    // ⭐ BOTH MIDDLE ROOMS ARE ROLLED. `rock-switch` rolls one and hard-codes
    // its hall as 'puzzle'; "random chambers" means the hub is drawn from the
    // pool too, and the boulder is placed in whatever it turned out to be.
    const [midCh, hubCh] = rollChambers(dungeon, floorIndex, ['mid', 'mid'], rng);
    planChamber(plan, tilemap, rng, midCh.role, { x: pathEndX, y: midFloorY, dir: horizDir });

    const vertY0 = vertDir === -1 ? midFloorY - 2 : midFloorY + 2;
    const vertY = planVLink(plan, tilemap, { x: hubX, y0: vertY0, dir: vertDir, steps: vertLength }).endY;

    const hubDyMin = -4, hubDyMax = 2;
    // ⭐ BOTH BRANCHES LEAVE THE SAME ROW, IN OPPOSITE DIRECTIONS. The hub is a T.
    const exitFloorY = vertY, vaultFloorY = vertY;
    planWideChamber(plan, tilemap, rng, hubCh.role, {
      x: hubX, y: vertY, dyMin: hubDyMin, dyMax: hubDyMax, halfW: HUB_HALF_W,
    });
    // ⛔ `keepClear` IS NOT ENOUGH TO GUARANTEE A MOUTH, AND IT ONLY HOLDS ONE
    // SIDE PER ROW — this hub needs both.
    //
    // It holds a row's JITTER, and the thing that actually closes a mouth is
    // `addOverhang`, which lays two rows of rock under every ceiling. Jitter one
    // row of the room's top edge inward and the ceiling it leaves hangs its band
    // over the row BELOW — so a mouth held open at its own row was walled anyway
    // by the row above it. Measured on the first build of this layout: the vault
    // was cut off from the hub, wall and stub both intact, on 69 of 200 seeds.
    //
    // Holding the top five rows at full width puts the ceiling at vertY-5 and
    // the rock band at vertY-4..vertY-3, which is two clear rows above the
    // branch row. The bottom two rows keep their jitter, so the room still ends
    // ragged rather than rectangular.
    for (let dy = hubDyMin + 1; dy <= 0; dy++) {
      const y = vertY + dy;
      if (y < 0 || y >= 32) continue;
      for (let x = hubX - HUB_HALF_W; x <= hubX + HUB_HALF_W; x++) {
        if (x >= 1 && x <= 30) tilemap[y * 32 + x] = FLOOR;
      }
    }

    // The run onward — OPEN. No wall anywhere along it.
    const exitPathStartX = hubX + HUB_HALF_W * exitDir;
    for (let s = 1; s <= exitLen; s++) {
      const ex = exitPathStartX + s * exitDir;
      if (ex < 1 || ex > 30) break;
      for (let dy = -2; dy <= 0; dy++) {
        const ey = exitFloorY + dy;
        if (ey >= 0 && ey < 32) tilemap[ey * 32 + ex] = FLOOR;
      }
    }
    const exitPathEndX = exitPathStartX + exitLen * exitDir;
    planChamber(plan, tilemap, rng, 'exit', { x: exitPathEndX, y: exitFloorY, dir: exitDir });

    // The vault alcove — a stub off the hub, ending in a room with no other way in.
    const vaultStartX = hubX + HUB_HALF_W * vaultDir;
    for (let s = 1; s <= vaultLen; s++) {
      const vx = vaultStartX + s * vaultDir;
      if (vx < 1 || vx > 30) break;
      for (let dy = -2; dy <= 0; dy++) {
        const vy = vaultFloorY + dy;
        if (vy >= 0 && vy < 32) tilemap[vy * 32 + vx] = FLOOR;
      }
    }
    const vaultEndX = vaultStartX + vaultLen * vaultDir;
    planChamber(plan, tilemap, rng, 'hoard', { x: vaultEndX, y: vaultFloorY, dir: vaultDir });

    finishCaveShape(tilemap);

    // The way down, in the exit chamber.
    const exitBlockX = exitPathEndX + 3 * exitDir;
    const exitBaseRow = exitFloorY - 5;
    placeDeepEntrance(tilemap, exitBlockX, -exitDir, exitBaseRow);
    var rockExitX = exitBlockX, rockExitY = exitBaseRow + 1;   // PASSAGE_ENTRY
    enforceMinCeilingGap(tilemap);

    // The way in. This floor is always ENTERED ON FOOT — floor 1's boulder
    // chamber leaves through a passage, not a trap hole — so it always gets an
    // arrival arch. ⛔ At the far edge of the entrance room from the corridor:
    // `placeDeepEntrance` lays rock on the arch's closed side, and from the
    // middle of the room that wall lands across the corridor mouth.
    const archX = Math.max(2, Math.min(29, horizDir === 1 ? entranceX : entranceX + entrBaseW));
    const archBase = startFloorY - 5;
    placeDeepEntrance(tilemap, archX, horizDir, archBase);
    enforceMinCeilingGap(tilemap);
    entranceX = archX;
    entranceY = archBase + 1;

    // ── The false wall, across the middle of the vault stub. Two rocky rows
    // and one floor row, so it reads as ordinary rock until the boulder opens
    // it — the shape `handleRockPuzzle` restores tile by tile.
    const wallStep = Math.max(1, Math.floor(vaultLen / 2));
    const wallX = vaultStartX + wallStep * vaultDir;
    const wallTiles = [];
    for (let dy = -2; dy <= 0; dy++) {
      const wy = vaultFloorY + dy;
      if (wy >= 0 && wy < 32) {
        tilemap[wy * 32 + wallX] = CEILING;
        wallTiles.push({ x: wallX, y: wy, newTile: dy <= -1 ? WALL_ROCKY : FLOOR });
      }
    }

    // ── The boulder, in the hub. Nearest floor tile to a random corner, then
    // the severance test: a boulder is impassable and permanent, so a candidate
    // that costs the flood more than itself is a cut, not a puzzle piece.
    const hubX1 = hubX - HUB_HALF_W, hubX2 = hubX + HUB_HALF_W;
    const hubY1 = vertY + hubDyMin, hubY2 = vertY + hubDyMax;
    const cornerPts = [[hubX1, hubY1], [hubX2, hubY1], [hubX1, hubY2], [hubX2, hubY2]];
    for (let i = cornerPts.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [cornerPts[i], cornerPts[j]] = [cornerPts[j], cornerPts[i]];
    }
    const rockCandidates = [];
    for (const [cx, cy] of cornerPts) {
      let best = null, bestD = Infinity;
      for (let y = hubY1; y <= hubY2; y++) {
        for (let x = hubX1; x <= hubX2; x++) {
          if (x < 1 || x > 30 || y < 0 || y >= 32) continue;
          if (tilemap[y * 32 + x] !== FLOOR) continue;
          const d = Math.abs(x - cx) + Math.abs(y - cy);
          if (d < bestD) { bestD = d; best = { x, y }; }
        }
      }
      if (best) rockCandidates.push(best);
    }
    // ⛔ THE TEST HAS TO BE RUN ON THE FLOOR THE PUZZLE LEAVES BEHIND, TOO.
    //
    // Blocking-and-reflooding the SHUT map is not enough here, and this is the
    // difference between a wall that gates the exit and a wall that gates a
    // vault. With the wall shut the alcove is already unreachable, so a boulder
    // dropped in its MOUTH costs the flood exactly one tile and passes — and
    // then the player pushes it, the wall opens, and the way into the vault is
    // blocked by the very boulder that opened it. 15 of 200 seeds, and the
    // sweep's own "still stranded after the rock switch" check is what caught
    // it. A candidate has to be free of consequence on BOTH maps.
    const openedTm = Uint8Array.from(tilemap);
    for (const w of wallTiles) openedTm[w.y * 32 + w.x] = w.newTile;
    const shutSize = reachableCount(tilemap, entranceX, entranceY);
    const openSize = reachableCount(openedTm, entranceX, entranceY);
    const isSafeRock = (c) => {
      const blocked = new Set([`${c.x},${c.y}`]);
      return reachableCount(tilemap,   entranceX, entranceY, blocked) === shutSize - 1
          && reachableCount(openedTm,  entranceX, entranceY, blocked) === openSize - 1;
    };
    const safeRocks = rockCandidates.filter(isSafeRock);
    // ⛔ NO BOULDER MEANS A VAULT NOTHING CAN EVER OPEN — chests included. If
    // every corner is a cut, take any safe tile in the hub rather than shipping
    // a floor whose puzzle has no piece.
    if (safeRocks.length === 0) {
      for (let y = hubY1; y <= hubY2 && safeRocks.length === 0; y++) {
        for (let x = hubX1; x <= hubX2; x++) {
          if (x < 1 || x > 30 || y < 0 || y >= 32) continue;
          if (tilemap[y * 32 + x] !== FLOOR) continue;
          if (isSafeRock({ x, y })) { safeRocks.push({ x, y }); break; }
        }
      }
    }

    var rockSwitch = null;
    if (safeRocks.length > 0) {
      const rock = safeRocks[Math.floor(rng() * safeRocks.length)];
      tilemap[rock.y * 32 + rock.x] = 0x0B;
      rockSwitch = { rocks: [{ x: rock.x, y: rock.y }], wallTiles };
    }

    // ── Room bounds, for the chest / bone passes and the catalogue features.
    const spanOf = (nearX, dir) => (dir === 1
      ? { left: nearX, right: nearX + 4 }
      : { left: nearX - 4, right: nearX });
    const roomA = { ...spanOf(pathEndX, horizDir), top: midFloorY - 2, bot: midFloorY + 2 };
    const hubRoom = { left: hubX1, right: hubX2, top: vertY + hubDyMin + 2, bot: vertY + hubDyMax };
    const exitRoom = { ...spanOf(exitPathEndX, exitDir), top: exitFloorY - 2, bot: exitFloorY + 2 };
    const vaultRoom = { ...spanOf(vaultEndX, vaultDir), top: vaultFloorY - 2, bot: vaultFloorY + 2 };

    // ⛔ THIS LAYOUT PLACES ITS OWN LOOT (`LAYOUT_CONFIG` gives it 0 chests and
    // 0 skeletons), because the shared pass cannot see the sealed side. Its
    // corner search falls back to "any corner anywhere" when a room has none
    // free, and a chest dropped on the vault stub walls in the room the puzzle
    // exists to open — the same class of bug as a chest on the boulder's only
    // approach, one step further along.
    const chestUsed = new Set();
    chestUsed.add(`${entranceX},${entranceY}`);
    if (rockSwitch) {
      for (const r of rockSwitch.rocks) {
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) chestUsed.add(`${r.x + dx},${r.y + dy}`);
      }
    }
    for (let dy = -3; dy <= 3; dy++)
      for (let dx = -2; dx <= 2; dx++) chestUsed.add(`${exitBlockX + dx},${exitBaseRow + dy}`);
    // The wall's own tiles and everything beside them: the stub is one tile
    // wide, so anything standing in it is standing in the doorway.
    for (const w of wallTiles) {
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) chestUsed.add(`${w.x + dx},${w.y + dy}`);
    }
    for (let s = 0; s <= vaultLen; s++) {
      const vx = vaultStartX + s * vaultDir;
      for (let dy = -2; dy <= 0; dy++) chestUsed.add(`${vx},${vaultFloorY + dy}`);
    }

    const dropChest = (bounds) => {
      const pos = findCornerFloor(tilemap, rng, chestUsed, bounds)
        || findRandomFloor(tilemap, rng, chestUsed, bounds);
      if (!pos) return null;
      tilemap[pos.y * 32 + pos.x] = CHEST;
      for (let dy = -3; dy <= 3; dy++)
        for (let dx = -3; dx <= 3; dx++) chestUsed.add(`${pos.x + dx},${pos.y + dy}`);
      return pos;
    };

    // ⭐ THE VAULT IS SERVED FIRST. Everything else competes for what is left —
    // the sealed room is the reason the boulder is here at all.
    //
    // ⛔ NOT THE ONLY THING PUTTING TREASURE IN THERE, and the measurement says
    // so: with this line removed the `sealed-hoard` feature still fills the vault
    // on all 400 seeds. It is here to make the hoard a hoard — measured at 2 or 3
    // chests behind the wall on every seed, never fewer — not because the gate
    // catches its absence. What the gate DOES catch is an empty vault: remove
    // this AND the feature and `sealedNoTreasure` fires on 400/400.
    dropChest(vaultRoom);
    dropChest(roomA);
    for (let i = 0; i < 1 + Math.floor(rng() * 2); i++) dropChest(hubRoom);
    dropChest(exitRoom);

    const boneUsed = new Set();
    boneUsed.add(`${entranceX},${entranceY}`);
    for (let dy = -3; dy <= 1; dy++) if (entranceY + dy >= 0) boneUsed.add(`${entranceX},${entranceY + dy}`);
    if (rockSwitch) {
      for (const r of rockSwitch.rocks) {
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) boneUsed.add(`${r.x + dx},${r.y + dy}`);
      }
    }
    for (let i = 0; i < 1024; i++) {
      const t = tilemap[i];
      if (t === CHEST || t === PASSAGE_ENTRY || t === PASSAGE_BTM || t === STAIRS_DOWN || t === EXIT_PREV) {
        const x = i % 32, y = (i - x) / 32;
        for (const [dx, dy] of [[0,0],[1,0],[-1,0],[0,1],[0,-1]]) boneUsed.add(`${x + dx},${y + dy}`);
      }
    }
    for (const w of wallTiles) boneUsed.add(`${w.x},${w.y}`);
    const dropBones = (bounds, n) => {
      for (let i = 0; i < n; i++) {
        const pos = findRandomFloor(tilemap, rng, boneUsed, bounds);
        if (!pos) break;
        tilemap[pos.y * 32 + pos.x] = BONES;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) boneUsed.add(`${pos.x + dx},${pos.y + dy}`);
      }
    };
    dropBones(roomA, 2);
    dropBones(hubRoom, 3);
    dropBones(exitRoom, 2);

    // ⭐ WHAT EACH ROLLED ROOM BECOMES, applied at the end of the shared pass so
    // a feature can only ever ADD to what is already placed.
    chamberFeatures.push({ ...midCh, bounds: roomA });
    chamberFeatures.push({ ...hubCh, bounds: hubRoom });
    chamberFeatures.push({ ...chamberById('sealed-hoard'), bounds: vaultRoom });

    // ⛔ THE SHARED FEATURE PASS HAS TO BE TOLD ABOUT THE BRANCHES.
    //
    // A rolled chamber's feature runs at the end of that pass against the shared
    // `used` set — which is seeded from the entrance, the boulder and the tiles
    // you stand on to use a door, and knows nothing about this floor's shape. A
    // hub that rolled `vault` scattered its chests anywhere inside the hub,
    // including the mouth of the alcove: 1 seed in 400 where the boulder opened
    // the wall onto a doorway with a chest standing in it.
    //
    // Both mouths and the whole stub, so the reservation does not depend on
    // where the wall happened to land along it.
    var reservedTiles = [];
    for (let s = 0; s <= vaultLen + 1; s++) {
      const vx = vaultStartX + s * vaultDir;
      for (let dy = -2; dy <= 0; dy++) reservedTiles.push(`${vx},${vaultFloorY + dy}`);
    }
    for (let s = 0; s <= 1; s++) {
      const ex = exitPathStartX + s * exitDir;
      for (let dy = -2; dy <= 0; dy++) reservedTiles.push(`${ex},${exitFloorY + dy}`);
    }

    var exitXForSecret = null;
    var startRowForSecret = 7;
    var endRowForSecret = 27;
    var exitXForUsed = exitBlockX;
    var endRowForUsed = exitBaseRow;
    var chamberBounds = hubRoom;

  } else if (LAYOUT === 'spine') {
    // ── Floor 4: Long corridor up → 5×5 room → paths left/right to side rooms ──
    // Entrance at bottom (placeDeepExit — same staircase block as floor 1 exit).

    // ── Skeleton, SAMPLED (v1.10.29 — phase 3) ─────────────────────────
    // These were literals: `entranceX = 16`, `roomCenterY = 9`, a fixed 3-tile
    // half-width, a fixed 6-tile gap and fixed 5-wide side rooms. Together they
    // pinned the floor to columns 3..29 and rows 6..12 on EVERY seed — measured
    // at 0.749 mean pairwise Jaccard, 85 of ~122 tiles fixed, and exactly ONE
    // entrance position across 200 seeds.
    //
    // ⛔ SAMPLE THE GEOMETRY BEFORE THE POSITION. The three rooms plus their two
    // gaps span `halfW + gap + sideW` either side of the spine; with the old
    // values that is 13, so the layout filled columns 3..29 and `entranceX`
    // could not move at all without falling off the map. Rolling the widths
    // first is what creates room for the position to vary.
    const halfW = 3 + Math.floor(rng() * 2);       // centre room half-width 3-4
    const gap = 5 + Math.floor(rng() * 3);         // corridor to side room 5-7
    const sideW = 3 + Math.floor(rng() * 2);       // side room half-span 3-4
    const extent = halfW + gap + sideW;            // columns used either side
    const exLo = 1 + extent, exHi = 30 - extent;
    entranceX = exLo + Math.floor(rng() * Math.max(1, exHi - exLo + 1));

    const stairY = 26 + Math.floor(rng() * 3);     // 26-28
    const corridorBottomY = stairY - 1;
    const pondSide = rng() < 0.5 ? -1 : 1; // -1=left, 1=right

    // `row`     — all three rooms share one band, joined by straight runs.
    //             This is what the floor ALWAYS did.
    // `stagger` — each side room sits at its own height, reached by an ELBOW.
    // Offsets are clamped so a side room stays on the map and above the branch
    // slot (~row 20); a room hanging into the branches would have them carve
    // straight through it.
    // `row`     — all three rooms share one band, joined by straight runs.
    // `stagger` — each side room sits at its own height, reached by an elbow.
    // `loop`    — as `row`, plus one branch climbing into a side room, so the
    //             floor is a CIRCUIT: out through the centre, back underneath.
    // `hub`     — a fourth room due north of the centre, giving the centre four
    //             spokes (spine from the south, two sides, one north).
    const topology = ['row', 'stagger', 'loop', 'hub'][Math.floor(rng() * 4)];
    plan.topology = topology;

    // Room band, sampled. Kept clear of the spine's bottom by construction:
    // `roomBotCarve` is at most 15 and `corridorBottomY` at least 25.
    // ⛔ `hub` puts a whole room ABOVE the centre, so the centre has to sit low
    // enough to leave rows for it: its top is `roomCenterY - 3`, and the north
    // room needs six rows clear above that. 7 would leave one.
    const roomCenterY = topology === 'hub'
      ? 10 + Math.floor(rng() * 2)      // 10-11
      : 7 + Math.floor(rng() * 5);      // 7-11
    const roomTopCarve = roomCenterY - 3;
    const roomBotCarve = roomCenterY + 3;

    // ── Topology (v1.10.30) ────────────────────────────────────────────
    const rollOffset = () => {
      if (topology !== 'stagger') return 0;
      const mag = 2 + Math.floor(rng() * 3);            // 2-4
      const dir = rng() < 0.5 ? -1 : 1;
      const want = dir * mag;
      const lo = 1 - (roomCenterY - 3), hi = 17 - (roomCenterY + 3);
      return Math.max(lo, Math.min(hi, want));
    };
    const leftOffset = rollOffset();
    const rightOffset = rollOffset();
    const roomLeft = entranceX - halfW;
    const roomRight = entranceX + halfW;

    // Long vertical corridor from row 26 up to roomBotCarve
    // Fattens 1 tile left or right in stretches, never both
    planSpine(plan, tilemap, rng, { x: entranceX, yFrom: corridorBottomY, yTo: roomBotCarve });

    // Center room — organic carving (top rows narrow for cave ceiling shape)
    planOrganicRoom(plan, tilemap, rng, 'centre', {
      left: roomLeft, right: roomRight, top: roomTopCarve, bot: roomBotCarve, topInset: 1,
    });
    // Center room bottom bumps (1-2 columns extend down 1 tile)
    for (let i = 0, nb = 1 + Math.floor(rng() * 2); i < nb; i++) {
      carveBottomBump(tilemap, rng, { left: roomLeft, right: roomRight, row: roomBotCarve + 1 });
    }

    // Side rooms: 5 wide × 7 tall carved (5×5 walkable)
    // 5-tile gap for clear narrow tunnel between room and side rooms
    const leftRoomRight = roomLeft - gap;
    const leftRoomLeft = Math.max(1, leftRoomRight - sideW);
    const rightRoomLeft = roomRight + gap;
    const rightRoomRight = Math.min(30, rightRoomLeft + sideW);

    // Per-side bands, declared BEFORE the connecting paths — the elbows need to
    // know what row each side room meets its corridor on.
    const sideRoomTopCarve = roomCenterY - 3;
    const sideRoomBotCarve = roomCenterY + 3;
    const leftTop = sideRoomTopCarve + leftOffset,  leftBot = sideRoomBotCarve + leftOffset;
    const rightTop = sideRoomTopCarve + rightOffset, rightBot = sideRoomBotCarve + rightOffset;
    const leftPathY = roomCenterY + leftOffset;
    const rightPathY = roomCenterY + rightOffset;
    // The pond goes in whichever side room was picked, so it follows THAT
    // room's band — not the centre's, which is what it used to assume.
    const pondTop = pondSide === -1 ? leftTop : rightTop;
    const pondBot = pondSide === -1 ? leftBot : rightBot;
    // ...and the OTHER side room, which gets the bone scatter. It used to take
    // that room's columns but the CENTRE room's rows — harmless while all three
    // shared a band, wrong the moment they do not.
    const otherTop = pondSide === 1 ? leftTop : rightTop;
    const otherBot = pondSide === 1 ? leftBot : rightBot;

    // Narrow path left (carve 3 rows, overhang eats 2 → 1 walkable)
    // Elbow: straight when `leftOffset` is 0 (the `row` topology), an L when the
    // side room sits at its own height. The vertical leg lands on the room's
    // held-open edge, which is why `keepEdge` uses `leftPathY`.
    planElbow(plan, tilemap, {
      x0: roomLeft - 1, y: roomCenterY, dir: -1,
      steps: (roomLeft - 1) - (leftRoomRight + 1) + 1,
      turnY: leftPathY, rng, wobble: CORRIDOR_WOBBLE,
    });
    // Narrow path right
    planElbow(plan, tilemap, {
      x0: roomRight + 1, y: roomCenterY, dir: 1,
      steps: (rightRoomLeft - 1) - (roomRight + 1) + 1,
      turnY: rightPathY, rng, wobble: CORRIDOR_WOBBLE,
    });

    // ⭐ THE TWO WINGS ARE ROLLED FROM THE CATALOGUE. Both are drawn in one
    // call so the pair honours `maxPerFloor` between them — two vaults on one
    // floor is a decision, not an accident of drawing twice.
    const [wingL, wingR] = rollChambers(dungeon, floorIndex, ['side', 'side'], rng);

    // Left side room — organic carving (keep right edge full at path row)
    planOrganicRoom(plan, tilemap, rng, wingL.role, {
      left: leftRoomLeft, right: leftRoomRight, top: leftTop, bot: leftBot,
      keepEdge: (y) => (y === leftPathY ? 'right' : null),   // the path meets it here
    });
    // Left room bottom bump
    if (rng() < 0.6) {
      carveBottomBump(tilemap, rng, { left: leftRoomLeft, right: leftRoomRight, row: leftBot + 1 });
    }

    // Right side room — organic carving (keep left edge full at path row)
    planOrganicRoom(plan, tilemap, rng, wingR.role, {
      left: rightRoomLeft, right: rightRoomRight, top: rightTop, bot: rightBot,
      keepEdge: (y) => (y === rightPathY ? 'left' : null),
    });
    // Right room bottom bump
    if (rng() < 0.6) {
      carveBottomBump(tilemap, rng, { left: rightRoomLeft, right: rightRoomRight, row: rightBot + 1 });
    }

    chamberFeatures.push({ ...wingL, bounds: { left: leftRoomLeft, right: leftRoomRight, top: leftTop, bot: leftBot } });
    chamberFeatures.push({ ...wingR, bounds: { left: rightRoomLeft, right: rightRoomRight, top: rightTop, bot: rightBot } });

    // Branch alcoves off corridor — horizontal paths with fat stretches, chests at ends
    const branchChestPos = [];
    // Single branch slot centered in corridor — avoids removeCeilingProtrusions merging
    const branchSlotY = Math.round((corridorBottomY + roomBotCarve) / 2) + 1; // ~row 20
    const firstSide = rng() < 0.5 ? -1 : 1;
    // `loop` closes the circuit on ONE side: that branch is allowed under the
    // side room and then climbs into it, so the floor can be walked as a ring
    // rather than as a tree of dead ends. It gets no chest — its end is a way
    // through, not a reward.
    const loopSide = topology === 'loop' ? firstSide : 0;
    for (const side of [-1, 1]) {
      if (side !== firstSide && rng() < 0.5) continue; // first side guaranteed, second 50%
      const len = 6 + Math.floor(rng() * 5); // 6-10 tiles
      const isLoop = side === loopSide;
      const roomMidX = side === -1
        ? Math.round((leftRoomLeft + leftRoomRight) / 2)
        : Math.round((rightRoomLeft + rightRoomRight) / 2);
      const sideBot = side === -1 ? leftBot : rightBot;
      const { endX: lastValidX, endY: branchEndY } = planBranch(plan, tilemap, rng, {
        x0: entranceX + side, y: branchSlotY, dir: side, wobble: CORRIDOR_WOBBLE,
        // A looping branch needs to REACH the room's middle column, so it is
        // given the length to get there rather than a rolled one.
        steps: isLoop ? Math.abs(roomMidX - (entranceX + side)) + 1 : len,
        // Normally stop one tile short of the side room so the branch never
        // bleeds in; a looping branch is meant to arrive under it.
        stopAt: isLoop ? null : (x) => (side === -1 ? x <= leftRoomRight + 1 : x >= rightRoomLeft - 1),
      });
      if (isLoop) {
        // Climb from the branch up to the room's bottom edge, closing the ring.
        // ⛔ From the branch's ACTUAL end row — a wobbled branch does not finish
        // on the row it started, and a climb measured from the wrong row lands
        // short of the room and the circuit never closes.
        const steps = branchEndY - (sideBot + 1);
        if (steps > 0) planVLink(plan, tilemap, { x: lastValidX, y0: branchEndY, dir: -1, steps });
      } else {
        branchChestPos.push({ x: lastValidX, y: branchEndY });
      }
    }

    // ── hub: a fourth room due north of the centre, on its own spoke ────
    if (topology === 'hub') {
      const hubBot = roomTopCarve - 2;
      const hubTop = hubBot - 4;
      const hubHalf = 2 + Math.floor(rng() * 2);   // 2-3 either side of the spine
      planOrganicRoom(plan, tilemap, rng, 'north', {
        left: Math.max(1, entranceX - hubHalf), right: Math.min(30, entranceX + hubHalf),
        top: hubTop, bot: hubBot,
      });
      // Spoke: centre room's top up to the north room's bottom.
      planVLink(plan, tilemap, { x: entranceX, y0: roomTopCarve, dir: -1, steps: roomTopCarve - hubBot });
    }

    // Cleanup + overhang
    finishCaveShape(tilemap);

    // Pond — 2 water lines in one side room, extending into wall
    // 50% vertical (south wall), 50% horizontal (north wall into side wall)
    const pondHorizontal = rng() < 0.5;
    {
      if (pondHorizontal) {
        // Horizontal: hugs north wall inside room, below overhang
        // Top row = all WATER_EDGE_N ($23) — north wall water detail
        // Bottom row = all WATER ($04) — water body
        // Top row 1 tile longer, both extend into outer side wall
        const topY = pondTop + 2;    // inside the POND's room, below overhang
        const botY = pondTop + 3;    // 1 row below
        if (pondSide === -1) {
          // Left room: extend left past leftRoomLeft into wall
          // Top row (edge detail): starts 1 tile inside room, 6 into wall = 7 tiles
          for (let i = -1; i < 6; i++) {
            const x = leftRoomLeft - i;
            if (x >= 0 && x < 32) tilemap[topY * 32 + x] = WATER_EDGE_N;
          }
          // Bottom row (water): starts at boundary, 6 into wall = 6 tiles
          for (let i = 0; i < 6; i++) {
            const x = leftRoomLeft - i;
            if (x >= 0 && x < 32) tilemap[botY * 32 + x] = WATER;
          }
        } else {
          // Right room: extend right past rightRoomRight into wall
          // Top row (edge detail): starts 1 tile inside room, 6 into wall = 7 tiles
          for (let i = -1; i < 6; i++) {
            const x = rightRoomRight + i;
            if (x >= 0 && x < 32) tilemap[topY * 32 + x] = WATER_EDGE_N;
          }
          // Bottom row (water): starts at boundary, 6 into wall = 6 tiles
          for (let i = 0; i < 6; i++) {
            const x = rightRoomRight + i;
            if (x >= 0 && x < 32) tilemap[botY * 32 + x] = WATER;
          }
        }
        // 2 rows of rocky wall above pond (covers full width including into-wall tiles)
        for (let x = 0; x < 32; x++) {
          if (tilemap[topY * 32 + x] === WATER_EDGE_N) {
            tilemap[(topY - 1) * 32 + x] = WALL_ROCKY;
            tilemap[(topY - 2) * 32 + x] = WALL_ROCKY;
          }
        }
      } else {
        // Vertical: 2 columns extending into south wall
        const outerX = pondSide === -1 ? leftRoomLeft : rightRoomRight;
        const innerX = pondSide === -1 ? leftRoomLeft + 1 : rightRoomRight - 1;
        // Outer: edge at pondBot-1, water from pondBot to +5 (6 into wall)
        tilemap[(pondBot - 1) * 32 + outerX] = WATER_EDGE_N;
        for (let y = pondBot; y <= pondBot + 5; y++) {
          if (y < 32) tilemap[y * 32 + outerX] = WATER;
        }
        // Inner: edge at pondBot, water from +1 to +5 (5 into wall)
        tilemap[pondBot * 32 + innerX] = WATER_EDGE_N;
        for (let y = pondBot + 1; y <= pondBot + 5; y++) {
          if (y < 32) tilemap[y * 32 + innerX] = WATER;
        }
      }
    }

    // 1 chest in pond room — wall corner, avoid water
    {
      const pLeft = pondSide === -1 ? leftRoomLeft : rightRoomLeft;
      const pRight = pondSide === -1 ? leftRoomRight : rightRoomRight;
      const pondUsed = new Set();
      for (let i = 0; i < 1024; i++) {
        const t = tilemap[i];
        if (t === WATER || t === WATER_EDGE_N) {
          const x = i % 32, y = (i - x) / 32;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++)
              pondUsed.add(`${x + dx},${y + dy}`);
        }
      }
      const pondBounds = { left: pLeft, right: pRight, top: pondTop, bot: pondBot };
      const pos = findCornerFloor(tilemap, rng, pondUsed, pondBounds);
      if (pos) tilemap[pos.y * 32 + pos.x] = CHEST;
    }

    // Place branch chest tiles after overhang so they're not eaten
    for (const { x, y } of branchChestPos) {
      tilemap[y * 32 + x] = CHEST;
    }

    // 1-2 chests in center room — lock into actual corners (wall on 2 perpendicular sides)
    const numRoomChests = 1 + (rng() < 0.5 ? 1 : 0);
    const isWall = (x, y) => {
      if (x < 0 || x > 31 || y < 0 || y > 31) return true;
      const t = tilemap[y * 32 + x];
      return t !== FLOOR && t !== BONES && t !== CHEST;
    };
    const cornerTiles = [];
    const edgeTiles = [];
    for (let y = roomTopCarve; y <= roomBotCarve; y++) {
      for (let x = roomLeft; x <= roomRight; x++) {
        if (tilemap[y * 32 + x] !== FLOOR || x === entranceX) continue;
        const wU = isWall(x, y - 1), wD = isWall(x, y + 1);
        const wL = isWall(x - 1, y), wR = isWall(x + 1, y);
        const perpWalls = (wU && wL) || (wU && wR) || (wD && wL) || (wD && wR);
        if (perpWalls) cornerTiles.push({ x, y });
        else if (wU || wD || wL || wR) edgeTiles.push({ x, y });
      }
    }
    // Prefer corners, fall back to edges
    const chestPool = cornerTiles.length >= numRoomChests ? cornerTiles : cornerTiles.concat(edgeTiles);
    // Shuffle pool
    for (let i = chestPool.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [chestPool[i], chestPool[j]] = [chestPool[j], chestPool[i]];
    }
    for (let i = 0; i < numRoomChests && i < chestPool.length; i++) {
      tilemap[chestPool[i].y * 32 + chestPool[i].x] = CHEST;
    }

    // Boss door — 3×3 block in north wall of boss room (non-pond side)
    // $00 $70 $00 (ceiling, door, ceiling)
    // $01 $41 $01 (wall, passage, wall)
    // $01 $49 $01 (wall, passage_btm, wall)
    {
      const bLeft = pondSide === 1 ? leftRoomLeft : rightRoomLeft;
      const bRight = pondSide === 1 ? leftRoomRight : rightRoomRight;
      const doorX = Math.round((bLeft + bRight) / 2);
      const doorY = otherTop - 1; // in the ceiling row above THAT room
      tilemap[doorY * 32 + doorX] = 0x70;             // door
      tilemap[(doorY + 1) * 32 + doorX] = 0x41;       // passage
      tilemap[(doorY + 2) * 32 + doorX] = PASSAGE_BTM; // passage bottom
    }

    // Bones in boss door room (non-pond side)
    {
      const bLeft = pondSide === 1 ? leftRoomLeft : rightRoomLeft;
      const bRight = pondSide === 1 ? leftRoomRight : rightRoomRight;
      const boneExclude = new Set();
      // Exclude door column and adjacent
      const doorX = Math.round((bLeft + bRight) / 2);
      for (let dy = -1; dy <= 3; dy++) boneExclude.add(`${doorX},${otherTop - 1 + dy}`);
      const boneCount = 2 + Math.floor(rng() * 2); // 2-3 bones
      for (let i = 0; i < boneCount; i++) {
        const pos = findRandomFloor(tilemap, rng, boneExclude,
          { left: bLeft, right: bRight, top: otherTop, bot: otherBot });
        if (pos) {
          tilemap[pos.y * 32 + pos.x] = BONES;
          for (let dy = -2; dy <= 2; dy++)
            for (let dx = -2; dx <= 2; dx++)
              boneExclude.add(`${pos.x + dx},${pos.y + dy}`);
        }
      }
    }

    // Entrance block after overhang — placeDeepExit (same staircase as floor 1 exit).
    // Corridor FLOOR at row 26 is directly above, so floorAbove=true → south wall variant.
    placeDeepExit(tilemap, entranceX, stairY);
    entranceY = stairY + 1; // STAIRS_DOWN row — player spawns here

    // Door ($70) scans before stairs ($73) → door=trigId 0, stairs=trigId 1.
    // Composite key `${type}:${trigId}` so trigId 0 of type 1 doesn't collide
    // with any trigId 0 of type 4 elsewhere on this floor (v1.7.691).
    dungeonDestinations.set('1:0', { mapId: bossFloorMapId(dungeon) }); // door → boss room
    dungeonDestinations.set('1:1', { goBack: true }); // stairs → back to floor 3

    // BFS seal unreachable floor.
    //
    // ⛔ This flood walks THROUGH chests on purpose — it drives the chest
    // DELETION below, and a chest tile can never be entered, so a flood that
    // blocks on chests marks every chest unreachable and the cleanup wipes
    // all of them. That permissiveness is also why it cannot catch a pocket
    // sealed BY a chest: floor 3's branch chest lands on the dead-end tile,
    // and this BFS strolls straight over it into the fat stretch behind.
    // Sealing those is `sealTinyPockets`'s job (see the end of generateFloor),
    // which uses the game's own rule that a chest blocks. The two are not
    // duplicates: this one deletes unreachable CONTENT in bulk, that one fills
    // tiny decorative holes and never removes anything.
    const reachable = new Set();
    const bfsQ = [[entranceX, entranceY]];
    reachable.add(entranceY * 32 + entranceX);
    while (bfsQ.length) {
      const [cx, cy] = bfsQ.shift();
      for (const [dx, dy] of [[0,1],[0,-1],[1,0],[-1,0]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || nx > 31 || ny < 0 || ny > 31) continue;
        const idx = ny * 32 + nx;
        if (reachable.has(idx)) continue;
        const t = tilemap[idx];
        if (t === FLOOR || t === STAIR_ARCH || t === STAIRS_DOWN || t === BONES || t === CHEST) {
          reachable.add(idx);
          bfsQ.push([nx, ny]);
        }
      }
    }
    for (let i = 0; i < 1024; i++) {
      if (!reachable.has(i) && (tilemap[i] === FLOOR || tilemap[i] === CHEST)) tilemap[i] = CEILING;
    }

    var exitXForSecret = null;
    var startRowForSecret = 7;
    var endRowForSecret = 27;
    var exitXForUsed = null;
    var endRowForUsed = 27;
    var chamberBounds = { top: roomTopCarve, bot: roomBotCarve, left: roomLeft, right: roomRight };

  } else {
    // ── Deeper floors: horizontal corridor → vertical corridor → chamber ──
    // Always horizontal first (left/right), then vertical down.
    entranceX = 5 + Math.floor(rng() * 22); // 5-26
    const pathDir = entranceX > 16 ? -1 : entranceX < 16 ? 1 : (rng() < 0.5 ? -1 : 1);
    const vertDir = rng() < 0.5 ? 1 : -1; // 1=down, -1=up

    // DOWN: entrance at top (row 3), corridor at row 7, vertical goes down
    // UP:   entrance at bottom (row 22), corridor at row 25, vertical goes up
    const entranceBaseRow = vertDir === 1 ? 3 : 22;
    const startFloorY = vertDir === 1 ? 7 : 25;

    // Entrance shaft: only for DOWN (short drop from entrance to corridor)
    if (vertDir === 1) {
      for (let row = entranceBaseRow + 2; row <= startFloorY; row++) {
        tilemap[row * 32 + entranceX] = FLOOR;
      }
    }
    // Overhang margin at entrance column (connects entrance to corridor)
    carveBand(tilemap, entranceX, startFloorY);

    // 1a. Entrance breathing room — small cave around the entrance landing so
    //     the player steps into a room, not a 1-wide drop, before the corridor.
    const entranceRoom = carveSmallCaveRoom(tilemap, entranceX, startFloorY, rng);
    if (entranceRoom) extraRooms.push(entranceRoom);

    // 1b. Horizontal pathway (left or right)
    const pathLength = 8 + Math.floor(rng() * 5); // 8-12 steps
    const pathResult = carvePathway(tilemap, entranceX, startFloorY, pathDir, pathLength, rng);

    // 2. Junction room — small cave where the H corridor meets the V corridor,
    //    overlapping (endX, endFloorY) so both corridors stay connected. The
    //    vertical pathway exits through one side of the room.
    const junctionRoom = carveSmallCaveRoom(tilemap, pathResult.endX, pathResult.endFloorY, rng);
    if (junctionRoom) extraRooms.push(junctionRoom);

    // 3. Vertical pathway (up or down from corridor end)
    const vertLength = 3 + Math.floor(rng() * 2); // 3-4 steps
    const vertResult = carveVerticalPathway(tilemap, pathResult.endX, pathResult.endFloorY, vertDir, vertLength, rng);

    // 4. Wide chamber at end of vertical pathway
    const chamberW = 9 + Math.floor(rng() * 5); // 9-13 tiles wide
    const chamberH = 9 + Math.floor(rng() * 5); // 9-13 tiles tall
    const chamberCX = Math.max(Math.ceil(chamberW / 2) + 1,
      Math.min(30 - Math.ceil(chamberW / 2), vertResult.endX));
    const chamberLeft = Math.max(1, Math.round(chamberCX - chamberW / 2));
    const chamberRight = Math.min(30, chamberLeft + chamberW - 1);
    // Position chamber with gap from vertical endpoint (gap shrinks if no room)
    let chamberTop, chamberBot;
    if (vertDir === 1) {
      // Going down: chamber below corridor
      const idealTop = vertResult.endY + 2;
      chamberTop = Math.min(idealTop, 29 - chamberH);
      chamberTop = Math.max(2, chamberTop);
      chamberBot = Math.min(29, chamberTop + chamberH);
    } else {
      // Going up: chamber above corridor
      const idealBot = vertResult.endY - 2;
      chamberBot = Math.max(idealBot, 2 + chamberH);
      chamberBot = Math.min(29, chamberBot);
      chamberTop = Math.max(2, chamberBot - chamberH);
    }

    // Carve 2-wide connector from vertical corridor end into chamber
    const connTopY = vertDir === 1 ? vertResult.endY + 1 : chamberTop;
    const connBotY = vertDir === 1 ? chamberTop - 1 : vertResult.endY - 1;
    for (let cy = Math.min(connTopY, connBotY); cy <= Math.max(connTopY, connBotY); cy++) {
      for (let dx = 0; dx <= 1; dx++) {
        if (cy >= 0 && cy < 32 && vertResult.endX + dx >= 0 && vertResult.endX + dx < 32) {
          tilemap[cy * 32 + vertResult.endX + dx] = FLOOR;
        }
      }
    }
    // Pick 1 random corner to pull inward (0=TL, 1=TR, 2=BL, 3=BR)
    const pullCorner = Math.floor(rng() * 4);
    const pullDepth = 3 + Math.floor(rng() * 3); // 3-5 rows of pull
    const pullWidth = 3 + Math.floor(rng() * 3); // 3-5 tiles max inset

    for (let y = chamberTop; y <= chamberBot; y++) {
      const jl = Math.floor(rng() * 3) + (rng() < 0.3 ? Math.floor(rng() * 2) : 0);
      const jr = Math.floor(rng() * 3) + (rng() < 0.3 ? Math.floor(rng() * 2) : 0);

      // Corner pull: taper from pullWidth down to 0 over pullDepth rows
      let pullL = 0, pullR = 0;
      const distTop = y - chamberTop;
      const distBot = chamberBot - y;
      if (pullCorner === 0 && distTop < pullDepth) {
        pullL = Math.round(pullWidth * (1 - distTop / pullDepth));
      } else if (pullCorner === 1 && distTop < pullDepth) {
        pullR = Math.round(pullWidth * (1 - distTop / pullDepth));
      } else if (pullCorner === 2 && distBot < pullDepth) {
        pullL = Math.round(pullWidth * (1 - distBot / pullDepth));
      } else if (pullCorner === 3 && distBot < pullDepth) {
        pullR = Math.round(pullWidth * (1 - distBot / pullDepth));
      }

      for (let x = chamberLeft + jl + pullL; x <= chamberRight - jr - pullR; x++) {
        if (x >= 0 && x < 32 && y >= 0 && y < 32) tilemap[y * 32 + x] = FLOOR;
      }
    }

    // Clean up ceiling artifacts, then overhang
    finishCaveShape(tilemap);

    // Place entrance using the entrance rule (after overhang)
    placeDeepEntrance(tilemap, entranceX, pathDir, entranceBaseRow);
    entranceY = entranceBaseRow + 1;

    // Seal any floor tiles isolated by entrance placement (BFS from entrance)
    const reachable = new Set();
    const bfsQ = [[entranceX, entranceY]];
    reachable.add(entranceY * 32 + entranceX);
    while (bfsQ.length) {
      const [cx, cy] = bfsQ.shift();
      for (const [dx, dy] of [[0,1],[0,-1],[1,0],[-1,0]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || nx > 31 || ny < 0 || ny > 31) continue;
        const idx = ny * 32 + nx;
        if (reachable.has(idx)) continue;
        const t = tilemap[idx];
        if (t === FLOOR || t === PASSAGE_BTM || t === PASSAGE_ENTRY || t === BONES) {
          reachable.add(idx);
          bfsQ.push([nx, ny]);
        }
      }
    }
    for (let i = 0; i < 1024; i++) {
      if (!reachable.has(i) && tilemap[i] === FLOOR) tilemap[i] = CEILING;
    }

    var exitXForSecret = null;
    var startRowForSecret = 7;
    var endRowForSecret = 27;
    var exitXForUsed = null;
    var endRowForUsed = 27;
    var chamberBounds = { top: chamberTop, bot: chamberBot, left: chamberLeft, right: chamberRight };
  }

  // ── Feature placement (shared across all cave floors) ──────────────
  let hiddenTraps = new Set();
  if (!isBossFloor(dungeon, floorIndex)) {
    const config = LAYOUT_CONFIG[LAYOUT] || LAYOUT_CONFIG['snake'];
    const used = new Set();
    used.add(`${entranceX},${entranceY}`);
    for (let dy = -3; dy <= 1; dy++) {
      if (entranceY + dy >= 0) used.add(`${entranceX},${entranceY + dy}`);
    }
    // ⛔ A CHEST ON THE BOULDER'S ONLY APPROACH SEALS THE FLOOR.
    //
    // The boulder goes in the nearest floor tile to a random chamber CORNER, and
    // the chest search wants corners too — so on 69 of 2000 seeds a chest landed
    // on the one walkable tile beside the boulder. A chest is not walkable, so
    // the boulder could never be touched, the wall never opened, and the way to
    // the next floor never unsealed. Every tile-reachability gate passed it: the
    // chamber is fully connected, the chest is openable, and the sealed half is
    // sealed *by design* right up until you notice nothing can unseal it.
    //
    // This is v1.10.42's third bug seen from the other side — there a rock took a
    // chest's only approach, here a chest takes the rock's. `rock-switch` excludes
    // its own rocks inline before placing its own chests; layouts that lean on
    // this shared pass need the same exclusion, and it has to be in `used`
    // BEFORE the chest loop reads it.
    if (typeof rockSwitch !== 'undefined' && rockSwitch) {
      for (const rk of rockSwitch.rocks) {
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) used.add(`${rk.x + dx},${rk.y + dy}`);
        }
      }
    }
    // Tiles a floor branch has claimed for itself — a doorway, a one-wide stub,
    // the mouth of a corridor. Empty on every layout that does not set it, so
    // this changes nothing for the floors that came before it.
    if (typeof reservedTiles !== 'undefined' && reservedTiles) {
      for (const k of reservedTiles) used.add(k);
    }
    // The snake layout: keep chests (and traps) out of the entrance block + its
    // landing in Room A — no chest should sit right where you walk in.
    if (LAYOUT === 'snake') {
      for (let yy = 0; yy <= 7; yy++) {
        for (let xx = entranceX - 2; xx <= entranceX + 2; xx++) {
          if (xx >= 0 && xx < 32) used.add(`${xx},${yy}`);
        }
      }
    }

    // Stairs down — the snake layout uses its exit block, deeper layouts use the
    // farthest floor tile.
    const nextMapId = dungeon.base + floorIndex + 1;
    //
    // ⛔ THE EXCLUSION IS NOT SNAKE-ONLY. It used to be `LAYOUT === 'snake' &&
    // exitXForUsed !== null`; every other layout left `exitXForUsed` null, so the
    // extra condition was invisible — until a layout placed its own exit block
    // and got a chest dropped on the landing. Altar Cave is unaffected: its three
    // deep layouts all leave `exitXForUsed` null, so this arm does not run for
    // them and the stairs arm below runs exactly as it did.
    if (exitXForUsed !== null) {
      for (let dy = 0; dy <= 4; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          used.add(`${exitXForUsed + dx},${endRowForUsed + dy}`);
        }
      }
    }
    if (LAYOUT !== 'snake') {
      for (let i = 0; i < config.stairs; i++) {
        // Entrance at top → south wall exit, entrance at bottom → north wall exit
        const southWall = entranceY <= 10;
        const pos = findExitWallPosition(tilemap, entranceX, entranceY, used, southWall)
          || findFarthestFloor(tilemap, entranceX, entranceY, used);
        if (pos) {
          placeDeepExit(tilemap, pos.x, pos.y);
          for (let dy = -2; dy <= 3; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              used.add(`${pos.x + dx},${pos.y + dy}`);
            }
          }
        }
      }
    }

    // ⛔ PROTECT EVERY WAY IN AND OUT, AND THE TILES YOU STAND ON TO USE IT.
    //
    // Doors, staircases and passage blocks are not walkable — you stand BESIDE
    // them and face them — so anything that takes their approach tile seals the
    // floor while every tile-count still looks right. Nothing needed this before:
    // the `spine` layout carries `chests: 0`, so the shared pass never placed
    // anything on the floor whose exit is a $70 door. The moment the catalogue
    // could roll a vault onto its side rooms, chests started walling in the door
    // to the crystal room — 9 seeds in 400, each one an unfinishable dungeon.
    //
    // Seeded before the features so it protects them AND the generic scatter
    // that follows, rather than being a special case for one of them.
    for (let i = 0; i < 1024; i++) {
      const t = tilemap[i];
      // ⛔ CHESTS TOO. `rock-switch` places its own chests INSIDE its branch,
      // before this pass runs — so a rubble field dropped a rock on a chest's
      // only approach and made it unopenable. Every one of these tiles is
      // something you stand BESIDE and face; none of them is walkable; all of
      // them are sealed by anything that takes the tile you stand on.
      if (t !== DOOR && t !== STAIRS_DOWN && t !== EXIT_PREV && t !== CHEST
          && t !== PASSAGE_ENTRY && t !== PASSAGE_BTM && t !== STAIR_ARCH) continue;
      const x = i % 32, y = (i - x) / 32;
      for (const [dx, dy] of [[0,0],[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < 32 && ny >= 0 && ny < 32) used.add(`${nx},${ny}`);
      }
    }

    // ⭐ CHAMBER FEATURES — what each rolled room BECOMES.
    //
    // ⛔ BEFORE THE FLOOR'S GENERIC SCATTER, NOT AFTER. `used` at this point
    // holds exactly the tiles a room may not touch — the entrance column, the
    // exit block, the boulder and its approach — and nothing else. Running the
    // features after the chest loop instead starved them: that loop adds a 7x7
    // exclusion around EVERY chest it places, which covers a whole 5x5 mid room,
    // so a vault placed 0 chests and a bone pit placed 1 of its 3-5. A chamber's
    // feature is the room's identity; the floor's generic dressing is what
    // should work around it.
    for (const ch of chamberFeatures) {
      const what = applyChamberFeature(ch.feature, tilemap, rng, ch.bounds, used, entranceX, entranceY);
      chamberLog.push({ id: ch.id, role: ch.role, feature: ch.feature, what, bounds: ch.bounds });
    }

    // Chests in corners first (need specific corner positions, place before traps)
    const chestCount = Array.isArray(config.chests)
      ? config.chests[0] + Math.floor(rng() * (config.chests[1] - config.chests[0] + 1))
      : config.chests;
    for (let i = 0; i < chestCount; i++) {
      // Chests must ALWAYS sit in a corner (touching >=2 perpendicular walls).
      // Prefer a corner near the chamber edge; if none is free, fall back to any
      // corner anywhere (bounds=null still enforces the 2-wall test) — never a
      // plain wall-adjacent tile, which would leave a chest flat against 1 wall.
      const pos = (chamberBounds && findCornerFloor(tilemap, rng, used, chamberBounds))
        || findCornerFloor(tilemap, rng, used, null);
      if (pos) {
        tilemap[pos.y * 32 + pos.x] = CHEST;
        for (let dy = -3; dy <= 3; dy++) {
          for (let dx = -3; dx <= 3; dx++) {
            used.add(`${pos.x + dx},${pos.y + dy}`);
          }
        }
      }
    }

    // Extra rooms (entrance + junction) get a 50% chance at one corner chest
    // each. Same 2-wall corner rule via findCornerFloor — small rooms can fail
    // the corner test (jitter / overhang), in which case no chest.
    for (const room of extraRooms) {
      if (rng() >= 0.5) continue;
      const pos = findCornerFloor(tilemap, rng, used, room);
      if (!pos) continue;
      tilemap[pos.y * 32 + pos.x] = CHEST;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          used.add(`${pos.x + dx},${pos.y + dy}`);
        }
      }
    }

    // Trap holes (interior only — never touching a wall, chamber only)
    // Hidden: placed as $74 for trigger registration, then swapped to $30 for rendering
    // Separate exclusion set — traps only space from each other + entrance/stairs
    let trapsPlaced = 0;
    const trapUsed = new Set();
    trapUsed.add(`${entranceX},${entranceY}`);
    for (let dy = -3; dy <= 1; dy++) {
      if (entranceY + dy >= 0) trapUsed.add(`${entranceX},${entranceY + dy}`);
    }
    // Block actual feature positions (not their exclusion zones)
    for (let i = 0; i < 1024; i++) {
      const t = tilemap[i];
      if (t === CHEST || t === STAIRS_DOWN || t === EXIT_PREV || t === PASSAGE_ENTRY || t === PASSAGE_BTM) {
        const x = i % 32, y = (i - x) / 32;
        trapUsed.add(`${x},${y}`);
      }
    }
    const trapCount = Array.isArray(config.traps)
      ? config.traps[0] + Math.floor(rng() * (config.traps[1] - config.traps[0] + 1))
      : config.traps;
    for (let i = 0; i < trapCount; i++) {
      // Build candidates: floor tiles inside chamber, not in trapUsed, all 4 neighbors also floor
      const trapCandidates = [];
      for (let ti = 0; ti < 1024; ti++) {
        if (!isFloorTile(tilemap[ti])) continue;
        const tx = ti % 32, ty = (ti - tx) / 32;
        if (trapUsed.has(`${tx},${ty}`)) continue;
        if (chamberBounds && (ty < chamberBounds.top || ty > chamberBounds.bot || tx < chamberBounds.left || tx > chamberBounds.right)) continue;
        // All 4 DIAGONAL neighbors must be floor — trap can sit beside an
        // orthogonal wall but its corners must be clear. v1.7.647 (was 4
        // orthogonal NSEW; the diagonal flavor leaves more trap candidates
        // in narrow corridors while still keeping the trap visually framed).
        const neighbors = [[1,1],[1,-1],[-1,1],[-1,-1]];
        if (!neighbors.every(([dx,dy]) => {
          const nx = tx+dx, ny = ty+dy;
          return nx >= 0 && nx < 32 && ny >= 0 && ny < 32 && isFloorTile(tilemap[ny*32+nx]);
        })) continue;
        trapCandidates.push({ x: tx, y: ty });
      }
      const pos = trapCandidates.length > 0 ? trapCandidates[Math.floor(rng() * trapCandidates.length)] : null;
      if (pos) {
        tilemap[pos.y * 32 + pos.x] = TRAP_HOLE;
        hiddenTraps.add(`${pos.x},${pos.y}`);
        // 1-tile inter-trap spacing (3×3 box). v1.7.648 — was 3-tile (7×7),
        // which ate most of the small trap chambers and capped seeds at 1-2
        // traps vs the [3, 5] config target.
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            trapUsed.add(`${pos.x + dx},${pos.y + dy}`);
          }
        }
        used.add(`${pos.x},${pos.y}`);
        trapsPlaced++;
      }
    }

    // Ponds — the FLOOR's own pond budget. Still 0 everywhere; a pond now
    // arrives as a `spring` chamber rolled from the catalogue instead.
    for (let i = 0; i < config.ponds; i++) {
      placePond(tilemap, rng, used);
    }


    // Bones scattered (chamber only when bounds exist)
    // Separate exclusion set — bones only avoid each other + actual feature tiles, not chest spacing
    const boneUsed = new Set();
    for (let i = 0; i < 1024; i++) {
      const t = tilemap[i];
      if (t === CHEST || t === TRAP_HOLE || t === STAIRS_DOWN || t === EXIT_PREV || t === PASSAGE_ENTRY || t === PASSAGE_BTM) {
        const x = i % 32, y = (i - x) / 32;
        boneUsed.add(`${x},${y}`);
      }
    }
    // Also block entrance area
    for (let dy = -3; dy <= 1; dy++) {
      if (entranceY + dy >= 0) boneUsed.add(`${entranceX},${entranceY + dy}`);
    }
    const boneCount = Array.isArray(config.skeletons)
      ? config.skeletons[0] + Math.floor(rng() * (config.skeletons[1] - config.skeletons[0] + 1))
      : config.skeletons;
    for (let i = 0; i < boneCount; i++) {
      const pos = chamberBounds
        ? findRandomFloor(tilemap, rng, boneUsed, chamberBounds)
        : findWallAdjacentFloor(tilemap, rng, boneUsed);
      if (pos) {
        tilemap[pos.y * 32 + pos.x] = BONES;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            boneUsed.add(`${pos.x + dx},${pos.y + dy}`);
          }
        }
        used.add(`${pos.x},${pos.y}`);
      }
    }

    // Extra rooms: 2-3 skeletons each, inhabiting the entrance + junction so
    // they feel as occupied as the trap chamber. Same 5x5 boneUsed exclusion
    // as the main loop so they don't clump together.
    for (const room of extraRooms) {
      const roomSkelCount = 2 + Math.floor(rng() * 2); // 2-3
      for (let i = 0; i < roomSkelCount; i++) {
        const pos = findRandomFloor(tilemap, rng, boneUsed, room);
        if (!pos) break;
        tilemap[pos.y * 32 + pos.x] = BONES;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            boneUsed.add(`${pos.x + dx},${pos.y + dy}`);
          }
        }
        used.add(`${pos.x},${pos.y}`);
      }
    }

    // Secret walls
    for (let i = 0; i < config.secrets; i++) {
      const pos = findSecretWallSpot(tilemap, rng, used);
      if (pos) {
        tilemap[pos.y * 32 + pos.x] = WALL_ROCKY;
        secretWalls.add(`${pos.x},${pos.y}`);
        used.add(`${pos.x},${pos.y}`);
      }
    }

    // Secret path (floor 0 only)
    falseWalls = placeSecretPath(tilemap, startRowForSecret, endRowForSecret, floorIndex, rng, exitXForSecret, dungeon);

    if (LAYOUT === 'snake') {
      // Secret corridors can open ceiling gaps — reclose + reconnect.
      enforceMinCeilingGap(tilemap);
      ensureCeilingConnectivity(tilemap);

      // Guarantee ONE connected main-floor ceiling snake. A secret corridor can
      // cut a room's perimeter off the entrance snake; bridge it back by
      // promoting a rocky wall tile that touches BOTH the connected snake and
      // the cut-off ceiling — only where 2 walls remain beneath it (so no
      // ceiling is ever left floating). Rows >=22 (the secret teleport room)
      // are intentionally a separate hidden formation and excluded.
      const C0 = CEILING, R0 = WALL_ROCKY;
      const okBelow = (x, y) => {
        const b1 = y < 31 ? tilemap[(y + 1) * 32 + x] : R0;
        const b2 = y < 30 ? tilemap[(y + 2) * 32 + x] : R0;
        return (b1 === R0 || b1 === C0) && (b2 === R0 || b2 === C0);
      };
      for (let pass = 0; pass < 16; pass++) {
        const conn = new Uint8Array(1024); const q = [];
        for (const sx of [entranceX - 2, entranceX + 2]) { const i = 2 * 32 + sx; if (tilemap[i] === C0) { conn[i] = 1; q.push(i); } }
        while (q.length) { const j = q.pop(); const x = j % 32, y = (j - x) / 32; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (nx < 0 || nx > 31 || ny < 0 || ny > 31) continue; const k = ny * 32 + nx; if (!conn[k] && tilemap[k] === C0) { conn[k] = 1; q.push(k); } } }
        let bridged = false;
        for (let y = 1; y < 22 && !bridged; y++) {
          for (let x = 0; x < 32 && !bridged; x++) {
            if (tilemap[y * 32 + x] !== R0 || !okBelow(x, y)) continue;
            let tConn = false, tDisc = false;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const nx = x + dx, ny = y + dy; if (nx < 0 || nx > 31 || ny < 0 || ny > 31) continue;
              const k = ny * 32 + nx; if (tilemap[k] !== C0) continue;
              if (conn[k]) tConn = true; else if (ny < 22) tDisc = true;
            }
            if (tConn && tDisc) { tilemap[y * 32 + x] = C0; bridged = true; }
          }
        }
        if (!bridged) break;
      }

      // Locked-room hook — runs LAST in floor-0 finalization, AFTER both
      // enforceMinCeilingGap and the ceiling-snake bridging loop, so the
      // chamber-door upper-diagonal rock promotion in `placeChamberDoor`
      // sticks. Door X is in the "2nd half" of Room B's column range =
      // south-half columns (the half with the exit). v1.7.652.
      // Chamber door is a CHANCE feature — not every seed gets one. The
      // chance is rolled BEFORE the find so seeds without a door don't
      // burn time on the search. v1.7.676 — 50% on floor 0.
      const LOCKED_DOOR_CHANCE = 0.5;
      if (rng() < LOCKED_DOOR_CHANCE) {
        const southMidY = Math.floor((roomTop + roomBot) / 2);
        const southCols = new Set();
        for (let y = southMidY; y <= roomBot; y++) {
          for (let x = bHalf[0]; x <= bHalf[1]; x++) {
            if (isFloorTile(tilemap[y * 32 + x])) southCols.add(x);
          }
        }
        if (southCols.size > 0) {
          const sxs = [...southCols];
          const xMin = Math.min(...sxs), xMax = Math.max(...sxs);
          // yRange spans the full chamber depth so the strict rock-5 find
          // can locate a deeper rock pocket when the chamber's top edge
          // doesn't have 3 consecutive rocks at row Y-1 (common — chamber
          // walls are typically 1-tile-thick rocks under ceiling).
          const doorPos = findChamberDoorPos(tilemap, 'north', {
            xRange: { min: xMin, max: xMax },
            yRange: { min: 1, max: roomBot },
            rng,
          });
          // ⛔ NO ROOM, NO DOOR — see the note on the other placement site.
          const _lockedId2 = lockedRoomMapIdForFloor(dungeon, floorIndex);
          if (doorPos && _lockedId2 !== null) {
            placeChamberDoor(tilemap, doorPos.x, doorPos.y);
            lockedRoomDoors.set(`${doorPos.x},${doorPos.y}`, { mapId: _lockedId2 });
            lockedDoors.add(`${doorPos.x},${doorPos.y}`);
          }
        }
      }
    }

    // Dungeon destinations — all type-1 triggers go to next floor
    // Rock puzzle exit: PASSAGE_ENTRY is type 4 (manually registered in triggerMap below).
    // trigId is computed after processTriggerTiles via the type-1 fall-through below.
  }

  const triggerMap = processTriggerTiles(tilemap);

  // Warp tile ($61) is in the event range ($60-$63) so processTriggerTiles registers it
  // as a blocking trigger. Remove it — warp is handled by position in game.js.
  if (warpTile) {
    triggerMap.delete(`${warpTile.x},${warpTile.y}`);
  }

  // Rock puzzle exit: PASSAGE_ENTRY ($6a) is in the "skipped" trigger range ($64-$6F),
  // so processTriggerTiles doesn't register it. Manually add it to the triggerMap.
  if (typeof rockExitX !== 'undefined') {
    triggerMap.set(`${rockExitX},${rockExitY}`, { type: 4, trigId: 0 });
  }

  // Wire dungeonDestinations from the freshly-built triggerMap. Composite
  // key `${type}:${trigId}` (v1.7.691): processTriggerTiles assigns trigIds
  // per type, so type-1 trigId 0 (a chamber door) and type-4 trigId 0 (a
  // passage-entry exit) can both exist. Before the composite key, the
  // chamber-door write below overwrote the passage-entry write and routed
  // the floor exit into the locked room on floor 2 (UI floor 3).
  //
  // Replaces the old `for (let i = 0; i < totalType1; i++)` loop which
  // assumed trigIds 0..N-1 were stair/trap; the v1.7.649 locked-room doors
  // insert another type-1 trigger between them in scan order, shifting all
  // later trigIds (v1.7.657).
  //
  // ⛔ NEVER OVERWRITE A DESTINATION A FLOOR BRANCH ALREADY SET. This loop is a
  // fallback — "any type-1 trigger I have not been told about leads down" — and
  // it used to run unconditionally, which clobbered floor 3's own wiring two
  // lines after that branch wrote it:
  //     dungeonDestinations.set('1:1', { goBack: true });  // stairs back up
  // became `{ mapId: 1004 }`. Floor 3's entrance staircase is a type-1 trigger,
  // so the player arrived on it, and `disabledTrigger` (map-loading.js) only
  // suppresses it until they step OFF (movement.js clears it on the first move).
  // Step off the stairs and back on and you warped straight to the CRYSTAL ROOM,
  // skipping the whole floor and landing on the boss. Shipped and unnoticed
  // because the sweep's "exit reachable" check looked for a $73 staircase and
  // found this one — the entrance — and called it the exit.
  const _nextMapId = dungeon.base + floorIndex + 1;
  for (const [coord, trig] of triggerMap) {
    if (trig.type !== 1) continue;
    if (lockedRoomDoors.has(coord)) continue;  // wired below to locked-room mapId
    const key = `${trig.type}:${trig.trigId}`;
    if (dungeonDestinations.has(key)) continue;  // the floor branch knows better
    dungeonDestinations.set(key, { mapId: _nextMapId });
  }
  // Rock puzzle exit (type 4)
  if (typeof rockExitX !== 'undefined') {
    const rockTrig = triggerMap.get(`${rockExitX},${rockExitY}`);
    if (rockTrig) dungeonDestinations.set(`${rockTrig.type}:${rockTrig.trigId}`, { mapId: _nextMapId });
  }
  // Locked-room chamber doors → standalone locked-room maps. Engine's
  // standard type-1 door transition handles door-open animation +
  // mapStack push + loadMapById. Return trip (walking onto the locked
  // room's south door) is owned by the locked-room map's own
  // dungeonDestinations entry (`{ goBack: true }` → pops the mapStack
  // back to the chamber map at the saved position). v1.7.677.
  for (const [coord, dest] of lockedRoomDoors) {
    const trig = triggerMap.get(coord);
    if (trig) dungeonDestinations.set(`${trig.type}:${trig.trigId}`, dest);
  }

  // Hide traps: swap $74 → $30 after triggers are registered
  for (const key of hiddenTraps) {
    const [x, y] = key.split(',').map(Number);
    tilemap[y * 32 + x] = FLOOR;
  }

  // ⛔ NO BAND ROUGHENING. v1.10.34 added `roughenOverhang`, which deepened the
  // rock band by promoting a ceiling tile above it — and that is a RULE BREAK.
  // Measured against the cartridge: every ceiling capping a band in ROM maps
  // 111, 113, 22 and 115 has EXACTLY TWO rocky tiles below it. Not one, not
  // three — 125 of 125 sampled. The pass put 652/831/1376 three-deep bands on
  // floors 1/2/3 and a handful four and five deep.
  //
  // The cartridge's band still looks irregular because its FLOOR EDGES are
  // jagged, not because the band varies in depth. Contour irregularity has to
  // come from the room and corridor outlines; deepening the band is not a
  // cheaper route to it, it is a different thing that happens to move the same
  // metric. `check-floor-shape.mjs` now gates the depth-2 rule.

  // ⛔ SECRET ROCK TUNNELS REMOVED (v1.10.40). Added in v1.10.33 to close §3b,
  // reverted after seeing one in the game.
  //
  // The mouth was a FALSE_CEILING tile and the passage behind it was carved as
  // ordinary FLOOR. Dungeon floors set `skipRoomClip`, so the whole tilemap is
  // drawn — which meant the passage and its chest were fully visible, and the
  // single disguised tile in the doorway read as A STRAY WALL TILE BLOCKING AN
  // OPEN CORRIDOR. Not a secret; a bug, with treasure behind it.
  //
  // Floor 0's secret corridors work because they are carved into the VOID fill:
  // surrounded by black, a corridor reads as hidden. A rock-slab floor has no
  // void, so the same trick cannot hide anything — the §3b conclusion that
  // tunnelling into rock was "the easier case" was about the CARVE, and I never
  // checked what it looked like afterwards.
  //
  // If secrets are wanted on these floors, the mechanism the game already has is
  // the boulder switch (floor 2's `rockSwitch`): a rock you push, which opens a
  // wall. That reads as a puzzle element instead of a mistake. Do not re-add a
  // walk-through-wall secret whose passage is drawn open.

  // ⛔ NO SECRETS ON FLOORS 1-3. Two attempts, both reverted on sight:
  //   v1.10.33 — a disguised doorway into a tunnel. The whole tilemap is drawn,
  //     so the passage and its chest were visible and the disguised tile read as
  //     a stray wall blocking an open corridor.
  //   v1.10.42 — floor 2's boulder switch placed a SECOND time, opening a sealed
  //     side chamber IN ADDITION to the one gating the exit. Mechanically sound
  //     and fully gated; still rejected on look.
  // Floor 2 keeps its rock puzzle and floor 0 keeps its void-carved corridors,
  // because those are shipped and accepted. Do not add a third variation without
  // an explicit design call — the two that exist were not rejected for bugs.
  //
  // ⭐ AND `chamber-run` IS THAT EXPLICIT DESIGN CALL, not a fourth variation.
  // Joel, 2026-08-27: *"Boulder puzzles will only be to open treasure chambers.
  // not an exit."* What v1.10.42 added was a boulder on TOP of the exit puzzle —
  // two mechanisms on one floor. What this is, is the floor's ONE boulder having
  // one job. Read the rejection as "no second secret", not as "no vault".

  // ⛔ FLOOR MUST NEVER TOUCH VOID — the cartridge always walls it. Runs after
  // every shaping and placement pass, since the entrance frame is what mostly
  // leaves floor hanging over black. See `tools/tile-grammar.mjs`.
  // ⛔ EVERY POND HEALS, WHEREVER IT CAME FROM. This scan used to live INSIDE the
  // spine branch, so `pondTiles` was populated for floor 3's hand-carved pool and
  // nothing else. The moment the catalogue could roll a `spring` chamber onto any
  // floor, that water was decoration: correct tiles, correct collision, and no
  // healing trigger, because the only code that registered one was in another
  // branch. One scan, run after every placement, so the water on screen and the
  // water the Z-action knows about cannot disagree.
  {
    const pt = new Set();
    for (let i = 0; i < 1024; i++) {
      const t = tilemap[i];
      if (t === WATER || t === WATER_EDGE_N) pt.add(`${i % 32},${(i - i % 32) / 32}`);
    }
    pondTiles = pt.size ? pt : null;
  }

  sealFloorToVoid(tilemap);

  // Last pass on the tilemap — AFTER the trap swap, so the map it walks is the
  // one the player gets. `dungeon-sweep.mjs` gates the result at 0.
  sealTinyPockets(tilemap, entranceX, entranceY, triggerMap);

  // ⛔ NO ROCK LEFT HANGING OVER CEILING. Rock exists to hang BELOW a ceiling
  // lip; the cartridge has zero `ROCK over CEIL` pairs across all five of its
  // cave maps, and `tools/tile-grammar.mjs` gates that. But `sealTinyPockets`
  // converts an unreachable FLOOR tile to CEILING and does not look up — so the
  // two rocky tiles that were hanging over it are left stranded, rock above
  // ceiling, an arrangement that reads as a floating lump of wall.
  //
  // It took a chest moving one tile to surface: one instance in 240 floors, on a
  // build where nothing about the shape passes had changed. Repeated until
  // stable because a band is two deep, so clearing the lower rock exposes the
  // upper one.
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (let y = 0; y < 31; y++) {
      for (let x = 0; x < 32; x++) {
        if (tilemap[y * 32 + x] !== WALL_ROCKY) continue;
        if (tilemap[(y + 1) * 32 + x] !== CEILING) continue;
        tilemap[y * 32 + x] = CEILING;
        changed = true;
      }
    }
    if (!changed) break;
  }

  const entranceData = new Uint8Array(16);

  return {
    tileset: isBossFloor(dungeon, floorIndex) ? resolveBossSkin(dungeon.bossSkinId).tileset : dungeon.tileset,
    fillTile,
    skipRoomClip: true,
    entranceX,
    entranceY,
    mapExit: 0,
    tilemap,
    chrTiles: assets.chrTiles,
    metatiles: assets.metatiles,
    palettes: assets.palettes,
    tileAttrs: assets.tileAttrs,
    spritePalettes: assets.spritePalettes,
    collision: assets.collision,
    collisionByte2: assets.collisionByte2,
    entranceData,
    triggerMap,
    secretWalls,
    dungeonDestinations,
    hiddenTraps,
    falseWalls,
    lockedDoors,
    rockSwitch: typeof rockSwitch !== 'undefined' ? rockSwitch : null,
    chambers: chamberLog,
    warpTile,
    pondTiles,
    plan,
  };
}
