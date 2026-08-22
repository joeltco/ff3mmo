// Dungeon Generator — procedural cave floors using FF3 tileset 0

import {
  parseMapProperties, loadTileset, loadCHRGraphics,
  buildMapPalettes, loadTileCollision, loadTileCollisionByte2,
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
import { carveBossChamber, CRYSTAL_SKIN } from './dungeon/boss-chamber.js';
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

function placePond(tilemap, rng, used) {
  const pw = rng() < 0.5 ? 2 : 3;
  const ph = 2;
  for (let attempt = 0; attempt < 50; attempt++) {
    const pos = findRandomFloor(tilemap, rng, used);
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
function placeSecretPath(tilemap, startRow, endRow, floorIndex, rng, exitX) {
  const falseWalls = new Map();
  if (floorIndex !== 0) return falseWalls;

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
  let secretMapIdNext = 1020;
  for (const { corridor: secretCorridor, goLeft: secretGoLeft } of secretCorridors) {
    const secretMapId = secretMapIdNext++;
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
export function generateSecretRoomMap(rom, goLeft) {
  const assets = loadRomAssets(rom);
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
const FLOOR_CONFIG = [
  { stairs: 1, traps: 0, chests: [2, 4], ponds: 0, skeletons: [6, 10], secrets: 1 }, // floor 0 (two rooms)
  { stairs: 0, traps: [3, 5], chests: [4, 6], ponds: 0, skeletons: 9, secrets: 0 }, // floor 1
  { stairs: 0, traps: 0, chests: 0, ponds: 0, skeletons: 0, secrets: 0, rockPuzzle: true }, // floor 2
  { stairs: 0, traps: 0, chests: 0, ponds: 0, skeletons: [4, 6], secrets: 0 },             // floor 3
];

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
function generateBossRoom(tilemap, floorIndex) {
  return carveBossChamber(tilemap, CRYSTAL_SKIN);
}

// Cache ROM data across floors (same seed = same dungeon run)
let cachedRomAssets = null;

export function loadRomAssets(romData) {
  if (cachedRomAssets) return cachedRomAssets;
  const mapProps = parseMapProperties(romData, REF_MAP_ID);
  cachedRomAssets = {
    metatiles: loadTileset(romData, 0),
    chrTiles: loadCHRGraphics(romData, REF_MAP_ID),
    palettes: buildMapPalettes(romData, mapProps),
    collision: loadTileCollision(romData, 0),
    collisionByte2: loadTileCollisionByte2(romData, 0),
    tileAttrs: loadNameTable(romData, 0),
  };
  return cachedRomAssets;
}

// Crystal room (floorIndex 4) uses tileset 2 + map 148 palettes
const CRYSTAL_MAP_ID = 148;
let cachedCrystalAssets = null;

function loadCrystalAssets(romData) {
  if (cachedCrystalAssets) return cachedCrystalAssets;
  const mapProps = parseMapProperties(romData, CRYSTAL_MAP_ID);
  const collision = loadTileCollision(romData, 2);
  // Override tile $61 (warp tile) to be walkable (z=1, no trigger)
  collision[0x61] = 0x01;
  cachedCrystalAssets = {
    metatiles: loadTileset(romData, 2),
    chrTiles: loadCHRGraphics(romData, CRYSTAL_MAP_ID),
    palettes: buildMapPalettes(romData, mapProps),
    collision,
    collisionByte2: loadTileCollisionByte2(romData, 2),
    tileAttrs: loadNameTable(romData, 2),
  };
  return cachedCrystalAssets;
}

export function clearDungeonCache() {
  cachedRomAssets = null;
  cachedCrystalAssets = null;
}

export function generateFloor(romData, floorIndex, seed) {
  // Retry with shifted seed if exit is unreachable (rare convergence pinch)
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = _generateFloor(romData, floorIndex, seed + attempt * 9973);
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
    // Floor 2 (rock puzzle): stairs are behind false wall (unreachable by design).
    // Validate rock is adjacent to a reachable tile instead.
    if (floorIndex === 2 && result.rockSwitch) {
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
  return _generateFloor(romData, floorIndex, seed); // fallback
}

function _generateFloor(romData, floorIndex, seed) {
  const assets = floorIndex === 4 ? loadCrystalAssets(romData) : loadRomAssets(romData);
  const rng = mulberry32(seed + floorIndex);
  const fillTile = (floorIndex === 0) ? FILL_VOID : CEILING;
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

  // Floors 1, 2 and 3 build every chamber through a primitive, so their plans
  // are COMPLETE. Floor 0's shape is a traced ceiling snake — one boundary, not
  // a set of rooms — and floor 4's chamber is authored, so neither is a chamber
  // list. `complete: false` says so rather than letting a partial plan read as
  // whole.
  const plan = createPlan(floorIndex, floorIndex >= 1 && floorIndex <= 3);

  if (floorIndex === 4) {
    const pos = generateBossRoom(tilemap, floorIndex);
    entranceX = pos.entranceX;
    entranceY = pos.entranceY;
    warpTile = pos.warpTile;
  } else if (floorIndex === 0) {
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
    var roomTop = 4 + Math.floor(rng() * 3);        // 4-6
    var roomBot = 18 + Math.floor(rng() * 3);       // 18-20
    var aOnRight = rng() < 0.5;
    const ROOM_W = 7 + Math.floor(rng() * 3);       // 7-9
    const leftL = 5 + Math.floor(rng() * 2);        // 5-6  (never 4 — see above)
    const rightR = 26 + Math.floor(rng() * 2);      // 26-27
    // ⛔ THE TWO HALVES MUST NOT OVERLAP, and the gap must be derived rather
    // than hoped for. v1.10.31 sampled a fixed half-width of 9-11 columns from
    // each end independently: of the 12 resulting combinations **5 overlapped**
    // and 6 pushed the left half past column 16. Both break the neck (below),
    // and the symptom is not a malformed room — it is room B ending up a
    // SEPARATE CAVE with its own arch and chests that nothing can reach. Caught
    // on floor 0 seed 1811002716217, which took a third seed base to surface.
    const gap = 3 + Math.floor(rng() * 3);          // 3-5 columns of rock between
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
    const tilt = topology === 'tilted' ? 3 + Math.floor(rng() * 3) : 0;   // 3-5
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

  } else if (floorIndex === 1) {
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
    const pathLength = 4 + Math.floor(rng() * 3); // 4-6 steps
    // Straight when `midFloorY` matches (the `chain` topology), an L otherwise.
    planElbow(plan, tilemap, { x0: horizStartX, y: horizFloorY, dir: horizDir, steps: pathLength, turnY: midFloorY });
    const pathEndX = Math.max(1, Math.min(30, horizStartX + pathLength * horizDir));
    const pathResult = { endX: pathEndX, endFloorY: midFloorY };

    // 5×5 mid room — direct copy of floor 2's first 5×5 mid room
    // (lines 1544-1553 in the floor-2 branch).
    planChamber(plan, tilemap, rng, 'junction', { x: pathResult.endX, y: pathResult.endFloorY, dir: horizDir });

    // V corridor — 5-7 steps DOWN from middle of mid room.
    // Direct copy of floor 2's V corridor (lines 1557-1564).
    const vertLength = 5 + Math.floor(rng() * 3);
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

  } else if (floorIndex === 2) {
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
    const pathLength = 4 + Math.floor(rng() * 3); // 4-6 steps
    const horizStartX = horizDir === 1 ? entranceX + 2 : entranceX;
    planElbow(plan, tilemap, { x0: horizStartX, y: startFloorY, dir: horizDir, steps: pathLength, turnY: midFloorY });
    const pathEndX = horizStartX + pathLength * horizDir;
    const pathResult = { endX: Math.max(1, Math.min(30, pathEndX)), endFloorY: midFloorY };

    // 5×5 room with irregular edges
    planChamber(plan, tilemap, rng, 'junction', { x: pathResult.endX, y: pathResult.endFloorY, dir: horizDir });

    // Vertical pathway (1 tile wide)
    const vertDir = vertDirEarly;
    const vertLength = 5 + Math.floor(rng() * 3); // 5-7 steps
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
    const exitPathLength = 4 + Math.floor(rng() * 3); // 4-6 steps
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

    // Exit room rock — opens false wall from the other side (return trip)
    if (rockSwitch) {
      // Tight exclusion: just the exit block + chest tiles (not the wide chestUsed radius)
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
      const exitRockPos = findCornerFloor(tilemap, rng, rockUsed, rm2Bounds);
      if (exitRockPos) {
        tilemap[exitRockPos.y * 32 + exitRockPos.x] = 0x0B;
        rockSwitch.rocks.push({ x: exitRockPos.x, y: exitRockPos.y });
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
      if (candidates.length > 0) {
        const doorPos = candidates[Math.floor(rng() * candidates.length)];
        placeChamberDoor(tilemap, doorPos.x, doorPos.y);
        lockedRoomDoors.set(`${doorPos.x},${doorPos.y}`, { mapId: 1011 });
        lockedDoors.add(`${doorPos.x},${doorPos.y}`);
      }
    }

  } else if (floorIndex === 3) {
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
      turnY: leftPathY,
    });
    // Narrow path right
    planElbow(plan, tilemap, {
      x0: roomRight + 1, y: roomCenterY, dir: 1,
      steps: (rightRoomLeft - 1) - (roomRight + 1) + 1,
      turnY: rightPathY,
    });

    // Left side room — organic carving (keep right edge full at path row)
    planOrganicRoom(plan, tilemap, rng, 'side-left', {
      left: leftRoomLeft, right: leftRoomRight, top: leftTop, bot: leftBot,
      keepEdge: (y) => (y === leftPathY ? 'right' : null),   // the path meets it here
    });
    // Left room bottom bump
    if (rng() < 0.6) {
      carveBottomBump(tilemap, rng, { left: leftRoomLeft, right: leftRoomRight, row: leftBot + 1 });
    }

    // Right side room — organic carving (keep left edge full at path row)
    planOrganicRoom(plan, tilemap, rng, 'side-right', {
      left: rightRoomLeft, right: rightRoomRight, top: rightTop, bot: rightBot,
      keepEdge: (y) => (y === rightPathY ? 'left' : null),
    });
    // Right room bottom bump
    if (rng() < 0.6) {
      carveBottomBump(tilemap, rng, { left: rightRoomLeft, right: rightRoomRight, row: rightBot + 1 });
    }

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
      const { endX: lastValidX } = planBranch(plan, tilemap, rng, {
        x0: entranceX + side, y: branchSlotY, dir: side,
        // A looping branch needs to REACH the room's middle column, so it is
        // given the length to get there rather than a rolled one.
        steps: isLoop ? Math.abs(roomMidX - (entranceX + side)) + 1 : len,
        // Normally stop one tile short of the side room so the branch never
        // bleeds in; a looping branch is meant to arrive under it.
        stopAt: isLoop ? null : (x) => (side === -1 ? x <= leftRoomRight + 1 : x >= rightRoomLeft - 1),
      });
      if (isLoop) {
        // Climb from the branch up to the room's bottom edge, closing the ring.
        const steps = branchSlotY - (sideBot + 1);
        if (steps > 0) planVLink(plan, tilemap, { x: lastValidX, y0: branchSlotY, dir: -1, steps });
      } else {
        branchChestPos.push({ x: lastValidX, y: branchSlotY });
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

    // Collect pond tile positions for Z-action healing trigger
    pondTiles = new Set();
    for (let i = 0; i < 1024; i++) {
      const t = tilemap[i];
      if (t === WATER || t === WATER_EDGE_N) {
        pondTiles.add(`${i % 32},${(i - i % 32) / 32}`);
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
    dungeonDestinations.set('1:0', { mapId: 1004 }); // door → boss room
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
  if (floorIndex !== 4) {
    const config = FLOOR_CONFIG[floorIndex] || FLOOR_CONFIG[0];
    const used = new Set();
    used.add(`${entranceX},${entranceY}`);
    for (let dy = -3; dy <= 1; dy++) {
      if (entranceY + dy >= 0) used.add(`${entranceX},${entranceY + dy}`);
    }
    // Floor 0: keep chests (and traps) out of the entrance block + its landing
    // in Room A — no chest should sit right where you walk in.
    if (floorIndex === 0) {
      for (let yy = 0; yy <= 7; yy++) {
        for (let xx = entranceX - 2; xx <= entranceX + 2; xx++) {
          if (xx >= 0 && xx < 32) used.add(`${xx},${yy}`);
        }
      }
    }

    // Stairs down — floor 0 uses exit block, deeper floors use farthest floor
    const nextMapId = 1000 + floorIndex + 1;
    if (floorIndex === 0 && exitXForUsed !== null) {
      for (let dy = 0; dy <= 4; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          used.add(`${exitXForUsed + dx},${endRowForUsed + dy}`);
        }
      }
    } else if (floorIndex > 0) {
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

    // Ponds
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
    falseWalls = placeSecretPath(tilemap, startRowForSecret, endRowForSecret, floorIndex, rng, exitXForSecret);

    if (floorIndex === 0) {
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
          if (doorPos) {
            placeChamberDoor(tilemap, doorPos.x, doorPos.y);
            lockedRoomDoors.set(`${doorPos.x},${doorPos.y}`, { mapId: 1010 });
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
  const _nextMapId = 1000 + floorIndex + 1;
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
  //   v1.10.42 — floor 2's boulder switch placed a second time, opening a sealed
  //     side chamber. Mechanically sound and fully gated; still rejected on look.
  // Floor 2 keeps its rock puzzle and floor 0 keeps its void-carved corridors,
  // because those are shipped and accepted. Do not add a third variation without
  // an explicit design call — the two that exist were not rejected for bugs.

  // ⛔ FLOOR MUST NEVER TOUCH VOID — the cartridge always walls it. Runs after
  // every shaping and placement pass, since the entrance frame is what mostly
  // leaves floor hanging over black. See `tools/tile-grammar.mjs`.
  sealFloorToVoid(tilemap);

  // Last pass on the tilemap — AFTER the trap swap, so the map it walks is the
  // one the player gets. `dungeon-sweep.mjs` gates the result at 0.
  sealTinyPockets(tilemap, entranceX, entranceY, triggerMap);

  const entranceData = new Uint8Array(16);

  return {
    tileset: floorIndex === 4 ? 2 : 0,
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
    warpTile,
    pondTiles,
    plan,
  };
}
