// Dungeon Generator — procedural cave floors using FF3 tileset 0

import {
  parseMapProperties, loadTileset, loadCHRGraphics,
  buildMapPalettes, loadTileCollision, loadTileCollisionByte2,
  loadNameTable, processTriggerTiles,
} from './map-loader.js';
import { placeLockedRoom, placeChamberDoor, findChamberDoorPos } from './dungeon-locked-room.js';

// Tile IDs (tileset 0 metatile indices)
const CEILING = 0x00;
const WALL_ROCKY = 0x01;
const FALSE_CEILING = 0x44;  // same visual as $00 but z=0 (passable)
const ENTRANCE_TOP = 0x03;   // arch above exit_prev
const PASSAGE = 0x41;        // passable doorway/passage tile
const PASSAGE_BTM = 0x49;    // passage bottom transition
const FLOOR = 0x30;
const BONES = 0x09;         // skeleton/bone decoration (scattered on floor)
const WATER_CENTER = 0x04;
const WATER_EDGE = 0x08;
// $0B/$0C — NOT skeletons, these render as teleport/warp sprites in tileset 0. Do not use.
const STAIRS_DOWN = 0x73;
const TRAP_HOLE = 0x74;
const CHEST = 0x7C;
const EXIT_PREV = 0x68;
const EVENT_TILE = 0x60;
const WARP_A = 0x3A;
const WARP_B = 0x3B;
const WARP_C = 0x3C;
const WARP_D = 0x3D;
const STAIR_ARCH = 0x42;     // decoration above stairs ($73)
const PASSAGE_ENTRY = 0x6a;  // passage from above (exit_prev, deeper floors)
const FILL_VOID = 0x5f;      // black void tile

// Reference map for tileset/palette/CHR loading
const REF_MAP_ID = 111;

// Mulberry32 PRNG
function mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ── Cave Outline Generation ──────────────────────────────────────────────

function generateCaveOutline(anchorX, startRow, endRow, rng) {
  const left = new Array(32).fill(0);
  const right = new Array(32).fill(31);

  // L-shaped cave matching Map 113 feel:
  //   narrow passage from entrance → L-bend → large open chamber
  //
  // Chamber is positioned so passage sits at its trailing edge —
  // this guarantees smooth column overlap through the bend (no disconnections).
  const passageHalfW = 3 + Math.floor(rng() * 2); // 3-4 (width 7-9)
  const chamberHalfW = 5 + Math.floor(rng() * 3); // 5-7 (width 11-15)

  // Turn direction: away from entrance to maximize chamber space
  const turnDir = anchorX > 16 ? -1 : anchorX < 16 ? 1 : (rng() < 0.5 ? -1 : 1);

  // Zone sizes
  const passageLen = 5 + Math.floor(rng() * 3); // 5-7 rows
  const passageEnd = startRow + passageLen;
  const bendLen = 3 + Math.floor(rng() * 2);    // 3-4 rows
  const bendEnd = passageEnd + bendLen;

  // Phase 1: Fill passage rows (narrow, drifts toward turn direction)
  let cx = anchorX;
  for (let y = startRow; y < passageEnd; y++) {
    if (y > startRow + 1 && rng() < 0.35) {
      cx += turnDir;
      cx = Math.max(passageHalfW + 1, Math.min(30 - passageHalfW, cx));
    }
    const jL = (rng() < 0.25) ? 1 : 0;
    const jR = (rng() < 0.25) ? 1 : 0;
    left[y]  = Math.max(1, cx - passageHalfW + jL);
    right[y] = Math.min(30, cx + passageHalfW - jR);
  }

  // Phase 2: Position chamber so passage's final position is at its trailing edge.
  // Chamber extends in turnDir from passage. Guarantees column overlap at bend.
  const extraOffset = Math.floor(rng() * 3); // 0-2 extra separation
  const rawChamberX = cx + turnDir * (chamberHalfW - passageHalfW + extraOffset);
  const chamberX = Math.max(chamberHalfW + 1, Math.min(30 - chamberHalfW, rawChamberX));

  // Phase 3: Fill bend rows (smooth interpolation from passage to chamber)
  const pL = cx - passageHalfW;
  const pR = cx + passageHalfW;
  const cL = chamberX - chamberHalfW;
  const cR = chamberX + chamberHalfW;
  for (let y = passageEnd; y < bendEnd; y++) {
    const t = (y - passageEnd + 1) / bendLen;
    left[y]  = Math.max(1, Math.round(pL + t * (cL - pL)));
    right[y] = Math.min(30, Math.round(pR + t * (cR - pR)));
  }

  // Phase 4: Fill chamber rows (wide area with organic edge jitter)
  for (let y = bendEnd; y <= endRow; y++) {
    const jL = (rng() < 0.4) ? Math.floor(rng() * 2) : 0;
    const jR = (rng() < 0.4) ? Math.floor(rng() * 2) : 0;
    left[y]  = Math.max(1, chamberX - chamberHalfW + jL);
    right[y] = Math.min(30, chamberX + chamberHalfW - jR);
  }

  return { left, right };
}

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

// Build cave shape: $00 perimeter, $30 interior, $5f outside
// pathMode: trace perimeter as a path (exactly 2 $00 neighbors per tile)
function buildCaveShape(tilemap, anchorX, startRow, endRow, rng, pathMode, clamp, maxWidth) {
  if (pathMode) {
    const { left, right } = generateCaveOutlinePath(anchorX, startRow, endRow, rng, maxWidth);

    // Left wall: snake down from startRow to endRow
    tilemap[startRow * 32 + left[startRow]] = CEILING;
    for (let y = startRow; y < endRow; y++) {
      const curr = left[y], next = left[y + 1];
      if (next !== curr) tilemap[y * 32 + next] = CEILING; // L-bend horizontal
      tilemap[(y + 1) * 32 + next] = CEILING;              // then down
    }

    // Bottom edge
    for (let x = left[endRow]; x <= right[endRow]; x++) {
      tilemap[endRow * 32 + x] = CEILING;
    }

    // Right wall: snake up from endRow to startRow
    tilemap[startRow * 32 + right[startRow]] = CEILING;
    for (let y = endRow; y > startRow; y--) {
      const curr = right[y], next = right[y - 1];
      if (next !== curr) tilemap[y * 32 + next] = CEILING; // L-bend horizontal
      tilemap[(y - 1) * 32 + next] = CEILING;              // then up
    }

    // Fill interior: scan each row for outermost $00 tiles, fill between.
    // `clamp` [x0,x1] restricts the scan to this chamber's columns so a second
    // side-by-side chamber in the same row range doesn't merge with it.
    const fl = clamp ? clamp[0] : 0, fr = clamp ? clamp[1] : 31;
    for (let y = startRow; y <= endRow; y++) {
      let minX = 32, maxX = -1;
      for (let x = fl; x <= fr; x++) {
        if (tilemap[y * 32 + x] === CEILING) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
      for (let x = minX + 1; x < maxX; x++) {
        if (tilemap[y * 32 + x] !== CEILING) {
          tilemap[y * 32 + x] = FLOOR;
        }
      }
    }
    return;
  }

  // ── Non-path mode (deeper floors): inside mask + boundary detection ──
  const { left, right } = generateCaveOutline(anchorX, startRow, endRow, rng);

  const inside = new Uint8Array(1024);
  for (let y = startRow; y <= endRow; y++) {
    for (let x = left[y]; x <= right[y]; x++) {
      inside[y * 32 + x] = 1;
    }
  }
  // Bridge row connects entrance to cave's first row
  const connRow = startRow - 1;
  if (connRow >= 0) {
    const bridgeL = Math.min(anchorX - 2, left[startRow]);
    const bridgeR = Math.max(anchorX + 2, right[startRow]);
    for (let x = bridgeL; x <= bridgeR; x++) {
      if (x >= 0 && x < 32) inside[connRow * 32 + x] = 1;
    }
  }

  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      if (!inside[y * 32 + x]) continue;
      const isEdge =
        x === 0 || !inside[y * 32 + x - 1] ||
        x === 31 || !inside[y * 32 + x + 1] ||
        y === 0 || !inside[(y - 1) * 32 + x] ||
        y === 31 || !inside[(y + 1) * 32 + x];
      tilemap[y * 32 + x] = isEdge ? CEILING : FLOOR;
    }
  }

  for (let y = startRow; y < endRow; y++) {
    if (left[y + 1] < left[y]) {
      for (let x = left[y + 1]; x <= left[y]; x++) tilemap[(y + 1) * 32 + x] = CEILING;
    }
    if (left[y + 1] > left[y]) {
      for (let x = left[y]; x <= left[y + 1]; x++) tilemap[y * 32 + x] = CEILING;
    }
    if (right[y + 1] > right[y]) {
      for (let x = right[y]; x <= right[y + 1]; x++) tilemap[(y + 1) * 32 + x] = CEILING;
    }
    if (right[y + 1] < right[y]) {
      for (let x = right[y + 1]; x <= right[y]; x++) tilemap[y * 32 + x] = CEILING;
    }
  }
}

// Ensure every $00 tile connects to at least one other $00 (cardinal).
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

// Enforce minimum 3-tile vertical gap between ceiling tiles in each column.
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

// Fix diagonal ceiling pairs that block floor paths after overhang.
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
function addOverhang(tilemap) {
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
function removeCeilingProtrusions(tilemap) {
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

// ── Feature Placement Helpers ────────────────────────────────────────────

function isFloorTile(t) { return t === FLOOR || t === BONES; }

function findRandomFloor(tilemap, rng, used, bounds) {
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

function findInteriorFloor(tilemap, rng, used, bounds) {
  const candidates = [];
  for (let i = 0; i < 1024; i++) {
    if (tilemap[i] !== FLOOR) continue;
    const x = i % 32, y = (i - x) / 32;
    if (used.has(`${x},${y}`)) continue;
    if (x < 2 || x > 29 || y < 2 || y > 29) continue;
    if (bounds && (y < bounds.top || y > bounds.bot || x < bounds.left || x > bounds.right)) continue;
    const allFloor =
      isFloorTile(tilemap[(y - 1) * 32 + x]) &&
      isFloorTile(tilemap[(y - 2) * 32 + x]) &&
      isFloorTile(tilemap[(y + 1) * 32 + x]) &&
      isFloorTile(tilemap[(y + 2) * 32 + x]) &&
      isFloorTile(tilemap[y * 32 + x - 1]) &&
      isFloorTile(tilemap[y * 32 + x - 2]) &&
      isFloorTile(tilemap[y * 32 + x + 1]) &&
      isFloorTile(tilemap[y * 32 + x + 2]);
    if (allFloor) candidates.push({ x, y });
  }
  if (candidates.length === 0) return null;
  return candidates[Math.floor(rng() * candidates.length)];
}

function findCornerFloor(tilemap, rng, used, bounds) {
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
        tilemap[ny * 32 + nx] = (isEdge && pw > 2) ? WATER_EDGE : WATER_CENTER;
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
        const inside = tilemap[y * 32 + x + 1];
        if (inside !== FLOOR && inside !== BONES && inside !== WALL_ROCKY) continue;
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

  for (const { corridor: secretCorridor, goLeft: secretGoLeft } of secretCorridors) {
    // ── Secret room: horizontal corridor in bottom corner ──
    // Left room extends left (entrance on right), right room extends right.
    // Layout: entrance → 3 wall cols → 2 chest cols → back wall
    // Chest alcove ceiling nudged up 1 tile. Always 2 $01 under $00.
    const rw = 7;
    const rx = secretGoLeft ? 0 : (32 - rw);
    // v1.7.653: ry=25 — moved up 1 from v1.7.651's 26 so the bottom
    // overhang at fy+2 = 31 fits the map (overhang at 32 was being lost).
    // Net buffer above main floor (row 21) is still 3 rows (22-24).
    const ry = 25;
    const fy = ry + 4; // floor row = 29

    // Column mapping: c(0)=entrance → c(6)=back wall
    const entCol = secretGoLeft ? rx + rw - 1 : rx;
    const step = secretGoLeft ? -1 : 1;
    const c = i => entCol + step * i;

    // Bottom: all 7 columns get ceiling below + 1-row overhang.
    // v1.7.651: dropped the 2nd overhang row (was `(fy+3)*32+c(i)`) — with
    // ry=26 it would land at row 33 and overflow the 32-row map.
    for (let i = 0; i < rw; i++) {
      tilemap[(fy + 1) * 32 + c(i)] = CEILING;
      tilemap[(fy + 2) * 32 + c(i)] = WALL_ROCKY;
    }

    // Entrance column (i=0): all ceiling above $44 (hides the secret)
    tilemap[(fy - 3) * 32 + c(0)] = CEILING;
    tilemap[(fy - 2) * 32 + c(0)] = CEILING;
    tilemap[(fy - 1) * 32 + c(0)] = CEILING;
    tilemap[fy * 32 + c(0)] = FALSE_CEILING;

    // Wall corridor (i=1..2): ceiling + 2 overhang + floor
    for (let i = 1; i <= 2; i++) {
      tilemap[(fy - 3) * 32 + c(i)] = CEILING;
      tilemap[(fy - 2) * 32 + c(i)] = WALL_ROCKY;
      tilemap[(fy - 1) * 32 + c(i)] = WALL_ROCKY;
      tilemap[fy * 32 + c(i)] = FLOOR;
    }

    // Transition column (i=3): nudged ceiling + ceiling + 2 overhang + floor
    tilemap[(fy - 4) * 32 + c(3)] = CEILING;
    tilemap[(fy - 3) * 32 + c(3)] = CEILING;
    tilemap[(fy - 2) * 32 + c(3)] = WALL_ROCKY;
    tilemap[(fy - 1) * 32 + c(3)] = WALL_ROCKY;
    tilemap[fy * 32 + c(3)] = FLOOR;

    // Chest alcove (i=4..5): nudged ceiling + 2 overhang + chest + floor
    for (let i = 4; i <= 5; i++) {
      tilemap[(fy - 4) * 32 + c(i)] = CEILING;
      tilemap[(fy - 3) * 32 + c(i)] = WALL_ROCKY;
      tilemap[(fy - 2) * 32 + c(i)] = WALL_ROCKY;
      tilemap[(fy - 1) * 32 + c(i)] = CHEST;
      tilemap[fy * 32 + c(i)] = FLOOR;
    }

    // Back wall (i=6): solid $00 column from nudged ceiling to floor
    for (let row = fy - 4; row <= fy; row++) {
      tilemap[row * 32 + c(6)] = CEILING;
    }

    // Register teleport pairs
    const roomTeleX = c(0);
    const roomTeleY = fy;
    falseWalls.set(`${secretCorridor.teleX},${secretCorridor.wy}`, { destX: roomTeleX, destY: roomTeleY });
    falseWalls.set(`${roomTeleX},${roomTeleY}`, { destX: secretCorridor.teleX, destY: secretCorridor.wy });
  }

  return falseWalls;
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

// LOCKED — Entrance landing template. Opens a 3x3 floor pocket directly below
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

  for (let s = 0; s < pathLength; s++) {
    x += pathDir;
    if (x < 1 || x > 30) break;
    // 3 rows of floor: top 2 get eaten by overhang, bottom 1 is walkable
    for (let dy = -2; dy <= 0; dy++) {
      const row = fy + dy;
      if (row >= 0 && row < 32) tilemap[row * 32 + x] = FLOOR;
    }
  }

  return { endX: x, endFloorY: fy };
}

// Carve a vertical pathway (goes up or down), curving left/right.
// Runs BEFORE addOverhang — just places FLOOR tiles.
// Each row gets a 4-tile-wide horizontal strip. Overhang handles walls at corridor top.
function carveVerticalPathway(tilemap, startX, startY, vertDir, pathLength, rng) {
  let y = startY;
  const fx = startX;

  for (let s = 0; s < pathLength; s++) {
    y += vertDir;
    if (y < 2 || y > 28) break;
    // 2 tiles wide, straight down
    if (fx >= 0 && fx < 32 && y >= 0 && y < 32) tilemap[y * 32 + fx] = FLOOR;
    if (fx + 1 >= 0 && fx + 1 < 32 && y >= 0 && y < 32) tilemap[y * 32 + fx + 1] = FLOOR;
  }

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

// Carve a jagged room at the pathway endpoint, then connect down to the cave.
// Runs BEFORE addOverhang — just places FLOOR tiles.
// Room is roughly 6-8 wide × 4-6 tall with random edge jitter.
function carvePathwayRoom(tilemap, endX, endFloorY, pathDir, caveTopFloorY, rng) {
  const rw = 6 + Math.floor(rng() * 3); // 6-8 wide
  const rh = 4 + Math.floor(rng() * 3); // 4-6 tall

  // Room positioned so the pathway enters from pathDir side
  const roomLeft = pathDir === 1
    ? Math.max(1, endX - 1)
    : Math.max(1, endX - rw + 2);
  const roomRight = Math.min(30, roomLeft + rw - 1);
  // Room centered vertically on pathway end, with 2 extra rows on top for overhang
  const roomTop = Math.max(2, endFloorY - 2 - Math.floor(rh / 2));
  const roomBot = roomTop + rh - 1 + 2; // +2 for overhang rows

  // Carve the room with jagged edges — all FLOOR, overhang handles walls
  for (let row = roomTop; row <= roomBot; row++) {
    const jl = Math.floor(rng() * 2);
    const jr = Math.floor(rng() * 2);
    const left = roomLeft + jl;
    const right = roomRight - jr;
    for (let cx = left; cx <= right; cx++) {
      if (cx >= 0 && cx < 32) tilemap[row * 32 + cx] = FLOOR;
    }
  }

  // Connect room down to the cave (3-wide shaft, all FLOOR)
  const shaftX = Math.floor((roomLeft + roomRight) / 2);
  for (let row = roomBot + 1; row <= caveTopFloorY; row++) {
    for (const dx of [-1, 0, 1]) {
      const cx = shaftX + dx;
      if (cx >= 0 && cx < 32) tilemap[row * 32 + cx] = FLOOR;
    }
  }
}

function generateBossRoom(tilemap, floorIndex) {
  // Crystal room — diamond layout from ROM map 148 (tileset 2, blue palettes)
  // Copy the original layout directly
  const layout = [
    // y, x, tile
    // Top narrowing approach (rows 2-4)
    [2,5,0x01],[2,6,0x01],[2,7,0x01],
    [3,5,0x02],[3,6,0x02],[3,7,0x02],
    [4,5,0x30],[4,6,0x30],[4,7,0x30],
    // Diamond widens (rows 5-6)
    [5,4,0x01],[5,5,0x30],[5,6,0x61],[5,7,0x30],[5,8,0x01],
    [6,3,0x01],[6,4,0x02],[6,5,0x30],[6,6,0x30],[6,7,0x30],[6,8,0x02],[6,9,0x01],
    [7,3,0x02],[7,4,0x30],[7,5,0x30],[7,6,0x30],[7,7,0x30],[7,8,0x30],[7,9,0x02],
    // Crystal pedestal + widest rows (8-10)
    [8,3,0x30],[8,4,0x30],[8,5,0x3a],[8,6,0x3f],[8,7,0x3e],[8,8,0x30],[8,9,0x30],
    [9,1,0x01],[9,2,0x01],[9,3,0x30],[9,4,0x30],[9,5,0x3a],[9,6,0x3f],[9,7,0x3e],[9,8,0x30],[9,9,0x30],[9,10,0x01],[9,11,0x01],
    [10,1,0x02],[10,2,0x02],[10,3,0x30],[10,4,0x30],[10,5,0x3b],[10,6,0x3c],[10,7,0x3d],[10,8,0x30],[10,9,0x30],[10,10,0x02],[10,11,0x02],
    [11,1,0x30],[11,2,0x30],[11,3,0x30],[11,4,0x30],[11,5,0x30],[11,6,0x30],[11,7,0x30],[11,8,0x30],[11,9,0x30],[11,10,0x30],[11,11,0x30],
    // Diamond narrows (rows 12-13)
    [12,3,0x30],[12,4,0x30],[12,5,0x30],[12,6,0x30],[12,7,0x30],[12,8,0x30],[12,9,0x30],
    [13,3,0x30],[13,4,0x30],[13,5,0x30],[13,6,0x30],[13,7,0x30],[13,8,0x30],[13,9,0x30],
    // Narrowing exit (rows 14-17)
    [14,3,0x30],[14,6,0x30],[14,9,0x30],
    [15,3,0x30],[15,5,0x01],[15,6,0x30],[15,7,0x01],[15,9,0x30],
    [16,5,0x02],[16,6,0x30],[16,7,0x02],
    [17,5,0x30],[17,6,0x30],[17,7,0x30],
    // Exit (row 18-19)
    [18,6,0x42],
    [19,6,0x6b],
  ];
  for (const [y, x, t] of layout) {
    tilemap[y * 32 + x] = t;
  }

  // Entrance at exit_prev tile, warp at crystal pedestal top
  return { entranceX: 6, entranceY: 19, warpTile: { x: 6, y: 5 } };
}

// Cache ROM data across floors (same seed = same dungeon run)
let cachedRomAssets = null;

function loadRomAssets(romData) {
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
  // Small breathing rooms (entrance + H↔V junction) on the deeper-floor else
  // branch; the shared feature-placement pass sprinkles skeletons + a chance
  // chest into each. Empty on every other branch.
  const extraRooms = [];

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
    var roomTop = 5, roomBot = 19;
    var aOnRight = rng() < 0.5;
    const aAnchor = aOnRight ? 22 : 9;   // Room A (entry)
    const bAnchor = aOnRight ? 9 : 22;   // Room B (exit) — opposite side
    const ROOM_W = 8;
    const RIGHT_HALF = [17, 27], LEFT_HALF = [4, 14];
    const aHalf = aOnRight ? RIGHT_HALF : LEFT_HALF;
    var bHalf = aOnRight ? LEFT_HALF : RIGHT_HALF;

    // Inside-shape mask: organic outline for each room, clamped to its half so
    // they don't overlap, unioned together.
    const inside = new Uint8Array(1024);
    const addRoom = (anchor, half) => {
      const { left, right } = generateCaveOutlinePath(anchor, roomTop, roomBot, rng, ROOM_W);
      for (let y = roomTop; y <= roomBot; y++) {
        const l = Math.max(half[0], Math.min(left[y], right[y]));
        const r = Math.min(half[1], Math.max(left[y], right[y]));
        for (let x = l; x <= r; x++) inside[y * 32 + x] = 1;
      }
    };
    addRoom(aAnchor, aHalf);
    addRoom(bAnchor, bHalf);

    // Connecting neck: fill ONLY the void gap between the two rooms (not the
    // full span), 5 mask rows tall at the mid row. Keeping each room's own
    // shape gives each a simple perimeter loop, so a secret carved into an
    // outer wall can't cut a room in half. After overhang eats 2 rows the neck
    // becomes a 1-tile corridor that's part of the single perimeter.
    const cy = roomTop + Math.floor((roomBot - roomTop) / 2);
    for (let ny = cy - 2; ny <= cy + 2; ny++) {
      let leftMax = -1, rightMin = 32;
      for (let x = 0; x < 16; x++) if (inside[ny * 32 + x]) leftMax = x;
      for (let x = 16; x < 32; x++) if (inside[ny * 32 + x]) { rightMin = x; break; }
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

    // Standard cleanup — exact passes/order as every other floor.
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

    // 5×5 entrance room — identical primitive to floor 2's exit room
    // (lines 1602-1611 in the floor-2 branch). The corridor exits the
    // room on +horizDir side, so the room body extends in -horizDir
    // ("entrFarDir") from the corridor-side edge column entranceX.
    const entrFarDir = -horizDir;
    const entrCornerX = entranceX;
    const entrFloorY = 7;
    for (let dy = -4; dy <= 2; dy++) {
      const isEdge = (dy <= -3 || dy >= 1);
      const jl = isEdge ? Math.floor(rng() * 2) : 0;
      const jr = isEdge ? Math.floor(rng() * 2) : 0;
      for (let dx = jl; dx <= 4 - jr; dx++) {
        const ax = entrCornerX + dx * entrFarDir, ay = entrFloorY + dy;
        if (ax >= 1 && ax <= 30 && ay >= 0 && ay < 32) tilemap[ay * 32 + ax] = FLOOR;
      }
    }

    // Short H corridor — 4-6 steps, 3-row carve (1 walkable row after
    // overhang), no jitter. Same primitive as floor 2's H corridor
    // (lines 1533-1540 in the floor-2 branch).
    const horizStartX = entrCornerX;
    const horizFloorY = entrFloorY;
    const pathLength = 4 + Math.floor(rng() * 3); // 4-6 steps
    for (let s = 1; s <= pathLength; s++) {
      const hx = horizStartX + s * horizDir;
      if (hx < 1 || hx > 30) break;
      for (let dy = -2; dy <= 0; dy++) {
        const hy = horizFloorY + dy;
        if (hy >= 0 && hy < 32) tilemap[hy * 32 + hx] = FLOOR;
      }
    }
    const pathEndX = Math.max(1, Math.min(30, horizStartX + pathLength * horizDir));
    const pathResult = { endX: pathEndX, endFloorY: horizFloorY };

    // 5×5 mid room — direct copy of floor 2's first 5×5 mid room
    // (lines 1544-1553 in the floor-2 branch).
    for (let dy = -4; dy <= 2; dy++) {
      const isEdge = (dy <= -3 || dy >= 1);
      const jl = isEdge ? Math.floor(rng() * 2) : 0;
      const jr = isEdge ? Math.floor(rng() * 2) : 0;
      for (let dx = jl; dx <= 4 - jr; dx++) {
        const ax = pathResult.endX + dx * horizDir, ay = pathResult.endFloorY + dy;
        if (ax >= 1 && ax <= 30 && ay >= 0 && ay < 32) tilemap[ay * 32 + ax] = FLOOR;
      }
    }

    // V corridor — 5-7 steps DOWN from middle of mid room.
    // Direct copy of floor 2's V corridor (lines 1557-1564).
    const vertLength = 5 + Math.floor(rng() * 3);
    const vertX = pathResult.endX + 2 * horizDir;
    let vertY = pathResult.endFloorY + 2;
    for (let s = 0; s < vertLength; s++) {
      vertY += vertDir;
      if (vertY < 2 || vertY > 29) break;
      tilemap[vertY * 32 + vertX] = FLOOR;
    }

    // 7×7 trap chamber — direct copy of floor 2's 7×7 chamber primitive
    // (lines 1566-1586), minus the exit-path keep-clear adjustment since
    // floor 1 has no exit path.
    const roomDyMin = -2;
    const roomDyMax = 6;
    for (let dy = roomDyMin; dy <= roomDyMax; dy++) {
      const distFromTop = dy - roomDyMin;
      const distFromBot = roomDyMax - dy;
      const isEdge = (distFromTop <= 1 || distFromBot <= 1);
      const jl = isEdge ? Math.floor(rng() * 3) : Math.floor(rng() * 2);
      const jr = isEdge ? Math.floor(rng() * 3) : Math.floor(rng() * 2);
      for (let dx = -3 + jl; dx <= 3 - jr; dx++) {
        const ax = vertX + dx, ay = vertY + dy;
        if (ax >= 1 && ax <= 30 && ay >= 0 && ay < 32) tilemap[ay * 32 + ax] = FLOOR;
      }
    }

    // Cleanup + overhang — same pass order as floor 2.
    fixDiagonalCeilingPinch(tilemap);
    removeCeilingProtrusions(tilemap);
    enforceMinCeilingGap(tilemap);
    ensureCeilingConnectivity(tilemap);
    addOverhang(tilemap);

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
    entranceX = 15;
    const vertDirEarly = rng() < 0.5 ? -1 : 1; // peek ahead so we can position entrance
    const startFloorY = vertDirEarly === -1 ? 24 : 8; // bottom if going up, top if going down

    // Entrance room: 3-4 wide, no jitter (too small — enforceMinCeilingGap eats thin runs)
    const entrBaseW = 2 + Math.floor(rng() * 2); // dx 0..2 or 0..3
    for (let dy = -4; dy <= 0; dy++) {
      for (let dx = 0; dx <= entrBaseW; dx++) {
        const ax = entranceX + dx, ay = startFloorY + dy;
        if (ax >= 1 && ax <= 30 && ay >= 0 && ay < 32) tilemap[ay * 32 + ax] = FLOOR;
      }
    }

    // Short horizontal pathway (1 walkable row after overhang)
    const horizDir = rng() < 0.5 ? -1 : 1;
    const pathLength = 4 + Math.floor(rng() * 3); // 4-6 steps
    const horizStartX = horizDir === 1 ? entranceX + 2 : entranceX;
    for (let s = 1; s <= pathLength; s++) {
      const hx = horizStartX + s * horizDir;
      if (hx < 1 || hx > 30) break;
      for (let dy = -2; dy <= 0; dy++) {
        const hy = startFloorY + dy;
        if (hy >= 0 && hy < 32) tilemap[hy * 32 + hx] = FLOOR;
      }
    }
    const pathEndX = horizStartX + pathLength * horizDir;
    const pathResult = { endX: Math.max(1, Math.min(30, pathEndX)), endFloorY: startFloorY };

    // 5×5 room with irregular edges
    for (let dy = -4; dy <= 2; dy++) {
      const isEdge = (dy <= -3 || dy >= 1);
      const jl = isEdge ? Math.floor(rng() * 2) : 0;
      const jr = isEdge ? Math.floor(rng() * 2) : 0;
      for (let dx = jl; dx <= 4 - jr; dx++) {
        const ax = pathResult.endX + dx * horizDir, ay = pathResult.endFloorY + dy;
        if (ax >= 1 && ax <= 30 && ay >= 0 && ay < 32) tilemap[ay * 32 + ax] = FLOOR;
      }
    }

    // Vertical pathway (1 tile wide)
    const vertDir = vertDirEarly;
    const vertLength = 5 + Math.floor(rng() * 3); // 5-7 steps
    const vertX = pathResult.endX + 2 * horizDir; // middle of 5×5 room
    let vertY = vertDir === -1 ? pathResult.endFloorY - 2 : pathResult.endFloorY + 2;
    for (let s = 0; s < vertLength; s++) {
      vertY += vertDir;
      if (vertY < 2 || vertY > 29) break;
      tilemap[vertY * 32 + vertX] = FLOOR;
    }

    // 7×7 room with irregular edges
    const roomDyMin = vertDir === -1 ? -8 : -2;
    const roomDyMax = vertDir === -1 ? 0 : 6;
    const exitDir = -horizDir;
    const exitPathFloorY = vertDir === -1 ? vertY - 2 : vertY + 2;
    const exitPathDy = exitPathFloorY - vertY;
    for (let dy = roomDyMin; dy <= roomDyMax; dy++) {
      const distFromTop = dy - roomDyMin;
      const distFromBot = roomDyMax - dy;
      const isEdge = (distFromTop <= 1 || distFromBot <= 1);
      let jl = isEdge ? Math.floor(rng() * 3) : Math.floor(rng() * 2);
      let jr = isEdge ? Math.floor(rng() * 3) : Math.floor(rng() * 2);
      // Keep exit path connection clear
      if (Math.abs(dy - exitPathDy) <= 1) {
        if (exitDir === -1) jl = 0; else jr = 0;
      }
      for (let dx = -3 + jl; dx <= 3 - jr; dx++) {
        const ax = vertX + dx, ay = vertY + dy;
        if (ax >= 1 && ax <= 30 && ay >= 0 && ay < 32) tilemap[ay * 32 + ax] = FLOOR;
      }
    }

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
    for (let dy = -4; dy <= 2; dy++) {
      const isEdge = (dy <= -3 || dy >= 1);
      const jl = isEdge ? Math.floor(rng() * 2) : 0;
      const jr = isEdge ? Math.floor(rng() * 2) : 0;
      for (let dx = jl; dx <= 4 - jr; dx++) {
        const ax = exitPathEndX + dx * exitDir, ay = exitPathFloorY + dy;
        if (ax >= 1 && ax <= 30 && ay >= 0 && ay < 32) tilemap[ay * 32 + ax] = FLOOR;
      }
    }

    // Cleanup + overhang
    fixDiagonalCeilingPinch(tilemap);
    removeCeilingProtrusions(tilemap);
    enforceMinCeilingGap(tilemap);
    ensureCeilingConnectivity(tilemap);
    addOverhang(tilemap);

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

  } else if (floorIndex === 3) {
    // ── Floor 4: Long corridor up → 5×5 room → paths left/right to side rooms ──
    // Entrance at bottom (placeDeepExit — same staircase block as floor 1 exit).

    entranceX = 16; // centered
    const stairY = 27;
    const corridorBottomY = stairY - 1; // row 26
    const pondSide = rng() < 0.5 ? -1 : 1; // -1=left, 1=right

    // 5×5 room at top (carved 7 tall × 7 wide → 5×5 walkable after overhang)
    const roomCenterY = 9;
    const roomTopCarve = roomCenterY - 3; // row 6
    const roomBotCarve = roomCenterY + 3; // row 12
    const roomLeft = entranceX - 3;
    const roomRight = entranceX + 3;

    // Long vertical corridor from row 26 up to roomBotCarve
    // Fattens 1 tile left or right in stretches, never both
    let fatSide = rng() < 0.5 ? -1 : 1; // current fatten direction
    let fatLen = 0; // rows remaining in current fat stretch
    for (let y = corridorBottomY; y >= roomBotCarve; y--) {
      tilemap[y * 32 + entranceX] = FLOOR;
      if (fatLen <= 0) {
        // 40% chance to start a new fat stretch (2-4 rows)
        if (rng() < 0.4) {
          fatSide = rng() < 0.5 ? -1 : 1;
          fatLen = 2 + Math.floor(rng() * 3); // 2-4 rows
        }
      }
      if (fatLen > 0) {
        const sx = entranceX + fatSide;
        if (sx >= 1 && sx < 31) tilemap[y * 32 + sx] = FLOOR;
        fatLen--;
      }
    }

    // Center room — organic carving (top rows narrow for cave ceiling shape)
    for (let y = roomTopCarve; y <= roomBotCarve; y++) {
      let rowL = roomLeft, rowR = roomRight;
      const fromTop = y - roomTopCarve;
      const fromBot = roomBotCarve - y;
      if (fromTop === 0) { rowL += 1 + (rng() < 0.5 ? 1 : 0); rowR -= 1 + (rng() < 0.5 ? 1 : 0); }
      else if (fromTop === 1) { rowL += (rng() < 0.5 ? 1 : 0); rowR -= (rng() < 0.5 ? 1 : 0); }
      if (fromBot === 0) { if (rng() < 0.5) rowL++; if (rng() < 0.5) rowR--; }
      for (let x = rowL; x <= rowR; x++) {
        if (x >= 1 && x < 31 && y >= 1 && y < 31) tilemap[y * 32 + x] = FLOOR;
      }
    }
    // Center room bottom bumps (1-2 columns extend down 1 tile)
    for (let i = 0, nb = 1 + Math.floor(rng() * 2); i < nb; i++) {
      const bx = roomLeft + 1 + Math.floor(rng() * Math.max(1, roomRight - roomLeft - 1));
      if (bx >= 1 && bx < 31) tilemap[(roomBotCarve + 1) * 32 + bx] = FLOOR;
    }

    // Side rooms: 5 wide × 7 tall carved (5×5 walkable)
    // 5-tile gap for clear narrow tunnel between room and side rooms
    const leftRoomRight = roomLeft - 6;
    const leftRoomLeft = Math.max(1, leftRoomRight - 4);
    const rightRoomLeft = roomRight + 6;
    const rightRoomRight = Math.min(30, rightRoomLeft + 4);

    // Narrow path left (carve 3 rows, overhang eats 2 → 1 walkable)
    for (let x = roomLeft - 1; x >= leftRoomRight + 1; x--) {
      for (let dy = -2; dy <= 0; dy++) {
        const y = roomCenterY + dy;
        if (y >= 1 && y < 31 && x >= 1) tilemap[y * 32 + x] = FLOOR;
      }
    }
    // Narrow path right
    for (let x = roomRight + 1; x <= rightRoomLeft - 1; x++) {
      for (let dy = -2; dy <= 0; dy++) {
        const y = roomCenterY + dy;
        if (y >= 1 && y < 31 && x < 31) tilemap[y * 32 + x] = FLOOR;
      }
    }

    // Left side room — organic carving (keep right edge full at path row)
    const sideRoomTopCarve = roomCenterY - 3;
    const sideRoomBotCarve = roomCenterY + 3;
    for (let y = sideRoomTopCarve; y <= sideRoomBotCarve; y++) {
      let rowL = leftRoomLeft, rowR = leftRoomRight;
      const fromTop = y - sideRoomTopCarve;
      const fromBot = sideRoomBotCarve - y;
      if (fromTop === 0) { rowL += (rng() < 0.5 ? 1 : 0); rowR -= (rng() < 0.5 ? 1 : 0); }
      else if (fromTop === 1) { rowL += (rng() < 0.5 ? 1 : 0); rowR -= (rng() < 0.5 ? 1 : 0); }
      if (fromBot === 0) { if (rng() < 0.5) rowL++; if (rng() < 0.5) rowR--; }
      if (y === roomCenterY) rowR = leftRoomRight; // path connects on right
      for (let x = rowL; x <= rowR; x++) {
        if (x >= 1 && x < 31 && y >= 1 && y < 31) tilemap[y * 32 + x] = FLOOR;
      }
    }
    // Left room bottom bump
    if (rng() < 0.6) {
      const bx = leftRoomLeft + 1 + Math.floor(rng() * Math.max(1, leftRoomRight - leftRoomLeft - 1));
      if (bx >= 1 && bx < 31) tilemap[(sideRoomBotCarve + 1) * 32 + bx] = FLOOR;
    }

    // Right side room — organic carving (keep left edge full at path row)
    for (let y = sideRoomTopCarve; y <= sideRoomBotCarve; y++) {
      let rowL = rightRoomLeft, rowR = rightRoomRight;
      const fromTop = y - sideRoomTopCarve;
      const fromBot = sideRoomBotCarve - y;
      if (fromTop === 0) { rowL += (rng() < 0.5 ? 1 : 0); rowR -= (rng() < 0.5 ? 1 : 0); }
      else if (fromTop === 1) { rowL += (rng() < 0.5 ? 1 : 0); rowR -= (rng() < 0.5 ? 1 : 0); }
      if (fromBot === 0) { if (rng() < 0.5) rowL++; if (rng() < 0.5) rowR--; }
      if (y === roomCenterY) rowL = rightRoomLeft; // path connects on left
      for (let x = rowL; x <= rowR; x++) {
        if (x >= 1 && x < 31 && y >= 1 && y < 31) tilemap[y * 32 + x] = FLOOR;
      }
    }
    // Right room bottom bump
    if (rng() < 0.6) {
      const bx = rightRoomLeft + 1 + Math.floor(rng() * Math.max(1, rightRoomRight - rightRoomLeft - 1));
      if (bx >= 1 && bx < 31) tilemap[(sideRoomBotCarve + 1) * 32 + bx] = FLOOR;
    }

    // Branch alcoves off corridor — horizontal paths with fat stretches, chests at ends
    const branchChestPos = [];
    // Single branch slot centered in corridor — avoids removeCeilingProtrusions merging
    const branchSlotY = Math.round((corridorBottomY + roomBotCarve) / 2) + 1; // ~row 20
    const firstSide = rng() < 0.5 ? -1 : 1;
    for (const side of [-1, 1]) {
      if (side !== firstSide && rng() < 0.5) continue; // first side guaranteed, second 50%
      const len = 6 + Math.floor(rng() * 5); // 6-10 tiles
      let fatDir = 0, fatLen = 0;
      const startX = entranceX + side;
      let lastValidX = startX;
      for (let i = 0; i < len; i++) {
        const x = startX + side * i;
        if (x < 1 || x >= 31) break;
        // Don't bleed into side rooms (stop 1 tile before room edge)
        if (side === -1 && x <= leftRoomRight + 1) break;
        if (side === 1 && x >= rightRoomLeft - 1) break;
        lastValidX = x;
        // Base 3-row carve (overhang eats top 2 → 1 walkable)
        for (let dy = -2; dy <= 0; dy++) {
          const y = branchSlotY + dy;
          if (y >= 1 && y < 31) tilemap[y * 32 + x] = FLOOR;
        }
        // Fat stretch (up or down, never both)
        if (fatLen <= 0 && rng() < 0.2) {
          fatDir = rng() < 0.5 ? -1 : 1;
          fatLen = 2 + Math.floor(rng() * 3); // 2-4 tiles
        }
        if (fatLen > 0) {
          if (fatDir === 1 && branchSlotY + 1 < 31) {
            tilemap[(branchSlotY + 1) * 32 + x] = FLOOR; // fat down
          } else if (fatDir === -1 && branchSlotY - 3 >= 1) {
            tilemap[(branchSlotY - 3) * 32 + x] = FLOOR; // fat up
          }
          fatLen--;
        }
      }
      branchChestPos.push({ x: lastValidX, y: branchSlotY });
    }

    // Cleanup + overhang
    fixDiagonalCeilingPinch(tilemap);
    removeCeilingProtrusions(tilemap);
    enforceMinCeilingGap(tilemap);
    ensureCeilingConnectivity(tilemap);
    addOverhang(tilemap);

    // Pond — 2 water lines in one side room, extending into wall
    // 50% vertical (south wall), 50% horizontal (north wall into side wall)
    const WATER = 0x04, WATER_EDGE = 0x23;
    const pondHorizontal = rng() < 0.5;
    {
      if (pondHorizontal) {
        // Horizontal: hugs north wall inside room, below overhang
        // Top row = all WATER_EDGE ($23) — north wall water detail
        // Bottom row = all WATER ($04) — water body
        // Top row 1 tile longer, both extend into outer side wall
        const topY = sideRoomTopCarve + 2;    // inside room, below overhang
        const botY = sideRoomTopCarve + 3;    // 1 row below
        if (pondSide === -1) {
          // Left room: extend left past leftRoomLeft into wall
          // Top row (edge detail): starts 1 tile inside room, 6 into wall = 7 tiles
          for (let i = -1; i < 6; i++) {
            const x = leftRoomLeft - i;
            if (x >= 0 && x < 32) tilemap[topY * 32 + x] = WATER_EDGE;
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
            if (x >= 0 && x < 32) tilemap[topY * 32 + x] = WATER_EDGE;
          }
          // Bottom row (water): starts at boundary, 6 into wall = 6 tiles
          for (let i = 0; i < 6; i++) {
            const x = rightRoomRight + i;
            if (x >= 0 && x < 32) tilemap[botY * 32 + x] = WATER;
          }
        }
        // 2 rows of rocky wall above pond (covers full width including into-wall tiles)
        for (let x = 0; x < 32; x++) {
          if (tilemap[topY * 32 + x] === WATER_EDGE) {
            tilemap[(topY - 1) * 32 + x] = WALL_ROCKY;
            tilemap[(topY - 2) * 32 + x] = WALL_ROCKY;
          }
        }
      } else {
        // Vertical: 2 columns extending into south wall
        const outerX = pondSide === -1 ? leftRoomLeft : rightRoomRight;
        const innerX = pondSide === -1 ? leftRoomLeft + 1 : rightRoomRight - 1;
        // Outer: edge at sideRoomBotCarve-1, water from sideRoomBotCarve to +5 (6 into wall)
        tilemap[(sideRoomBotCarve - 1) * 32 + outerX] = WATER_EDGE;
        for (let y = sideRoomBotCarve; y <= sideRoomBotCarve + 5; y++) {
          if (y < 32) tilemap[y * 32 + outerX] = WATER;
        }
        // Inner: edge at sideRoomBotCarve, water from +1 to +5 (5 into wall)
        tilemap[sideRoomBotCarve * 32 + innerX] = WATER_EDGE;
        for (let y = sideRoomBotCarve + 1; y <= sideRoomBotCarve + 5; y++) {
          if (y < 32) tilemap[y * 32 + innerX] = WATER;
        }
      }
    }

    // Collect pond tile positions for Z-action healing trigger
    pondTiles = new Set();
    for (let i = 0; i < 1024; i++) {
      const t = tilemap[i];
      if (t === WATER || t === WATER_EDGE) {
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
        if (t === WATER || t === WATER_EDGE) {
          const x = i % 32, y = (i - x) / 32;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++)
              pondUsed.add(`${x + dx},${y + dy}`);
        }
      }
      const pondBounds = { left: pLeft, right: pRight, top: sideRoomTopCarve, bot: sideRoomBotCarve };
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
      const doorY = sideRoomTopCarve - 1; // in the ceiling row above room
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
      for (let dy = -1; dy <= 3; dy++) boneExclude.add(`${doorX},${sideRoomTopCarve - 1 + dy}`);
      const boneCount = 2 + Math.floor(rng() * 2); // 2-3 bones
      for (let i = 0; i < boneCount; i++) {
        const pos = findRandomFloor(tilemap, rng, boneExclude,
          { left: bLeft, right: bRight, top: sideRoomTopCarve, bot: sideRoomBotCarve });
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

    // Door ($70) scans before stairs ($73) → door=trigId 0, stairs=trigId 1
    dungeonDestinations.set(0, { mapId: 1004 }); // door → boss room
    dungeonDestinations.set(1, { goBack: true }); // stairs → back to floor 3

    // BFS seal unreachable floor
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
    for (let dy = -2; dy <= 0; dy++) {
      const row = startFloorY + dy;
      if (row >= 0 && row < 32) tilemap[row * 32 + entranceX] = FLOOR;
    }

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
    fixDiagonalCeilingPinch(tilemap);
    removeCeilingProtrusions(tilemap);
    enforceMinCeilingGap(tilemap);
    ensureCeilingConnectivity(tilemap);
    addOverhang(tilemap);

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
      {
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
          const doorPos = findChamberDoorPos(tilemap, 'north', {
            xRange: { min: xMin, max: xMax },
            yRange: { min: 1, max: roomTop + 3 },
            rng,
          });
          if (doorPos) {
            placeChamberDoor(tilemap, doorPos.x, doorPos.y);
            // Standalone magic-shop replica in the bottom corner opposite
            // Room B (B right → bottom-left anchor; B left → bottom-right).
            // Anchor Y=24 with the 7-row replica → rows 24-30, leaving row
            // 31 clear so the replica isn't kissing the map's south edge.
            // Buffer above (rows 22-23) is still 2 rows from chamber bottom.
            const replicaAnchorX = aOnRight ? 22 : 1;
            const replicaAnchorY = 24;
            placeLockedRoom(tilemap, romData, replicaAnchorX, replicaAnchorY, rng, {
              chests: 2, skeletons: 3,
            });
          }
        }
      }
    }

    // Dungeon destinations — all type-1 triggers go to next floor
    const totalType1 = config.stairs + trapsPlaced;
    for (let i = 0; i < totalType1; i++) {
      dungeonDestinations.set(i, { mapId: nextMapId });
    }

    // Rock puzzle exit: PASSAGE_ENTRY is type 4 (manually registered in triggerMap below).
    // trigId = 0 (only type-4 trigger on this floor). dungeonDestinations key = totalType1 = 0.
    if (config.rockPuzzle) {
      dungeonDestinations.set(totalType1, { mapId: nextMapId });
    }
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

  // Hide traps: swap $74 → $30 after triggers are registered
  for (const key of hiddenTraps) {
    const [x, y] = key.split(',').map(Number);
    tilemap[y * 32 + x] = FLOOR;
  }

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
    rockSwitch: typeof rockSwitch !== 'undefined' ? rockSwitch : null,
    warpTile,
    pondTiles,
  };
}
