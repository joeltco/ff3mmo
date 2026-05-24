// dungeon-locked-room.js — generic locked-room placement for dungeon floors.
//
// Replicates the Ur magic shop interior (map 3) tile-for-tile into a free
// area of a dungeon tilemap, with shop-tileset IDs translated to the cave
// tileset equivalents (gutting any shop-specific decoration). The room is
// NOT physically connected to the host chamber — a separate "door" tile
// placed on the chamber wall acts as a teleport entry (teleport wiring
// is TODO; the tile placement here is debug-unlocked for now).
//
// The magic shop already uses the floor-0 wall convention (ceiling row on
// top with rock rows underneath), so replicating its tiles literally gives
// the right cave look without a separate addOverhang pass.
//
// Designed to be reusable from any dungeon generator: shape comes from ROM
// (call `getMagicShopReplica(rom)` once and cache if needed), placement is
// pure tile-write into a caller-supplied tilemap.
//
// First use: Altar Cave floor 0 (v1.7.649).
// Roadmap: door locking + magic-key consumption, teleport trigger wiring,
//   secret-shop interior variant.

import { loadMap } from './map-loader.js';

// ── Source map ────────────────────────────────────────────────────────────

const MAGIC_SHOP_MAP_ID = 3;
const SHOP_ORIGIN_X = 0;  // upper-left corner of the shop interior in map 3
const SHOP_ORIGIN_Y = 0;
const SHOP_W = 9;         // shop interior width in tiles
const SHOP_H = 11;        // shop interior height in tiles

// Shop tileset (5) → cave tileset (0) translation. Wall + secret-pass tiles
// share IDs across the two tilesets (00, 01, 44, 5f), so they pass through.
// Shop floor (3a, 20, 47) all collapse to the single cave floor (30). Shop
// door tiles (45, 68) become cave secret-pass (44) — same false-ceiling the
// chamber-side teleport door uses (the player walks through it from the
// south as the user spec'd). Shop door-top (1b) becomes plain cave ceiling.
// Any unknown shop tile passes through unchanged (would render as the
// matching cave tile or — if no match — as garbage; map 3 only contains
// the IDs covered here).
const SHOP_TO_CAVE = new Map([
  [0x00, 0x00],
  [0x01, 0x01],
  [0x3a, 0x30],
  [0x20, 0x30],
  [0x47, 0x30],
  [0x44, 0x44],
  [0x45, 0x44],
  [0x68, 0x44],
  [0x1b, 0x00],
  [0x5f, 0x5f],
  // Bottom stairwell room (rows 11-15 of map 3) tiles — not used by the
  // 11-tall interior slice we take, but listed for completeness in case a
  // future call extends the source rectangle.
  [0x08, 0x09],  // shop bones → cave bones
  [0x09, 0x09],
  [0x19, 0x44],  // shop door-arch → cave secret-pass
  [0x1a, 0x00],
  [0x1d, 0x01],
  [0x7c, 0x7c],  // shop chest → cave chest (same ID)
]);

// ── Cave tileset constants (mirrored from dungeon-generator.js) ───────────

const CEILING_TILE = 0x00;
const ROCK_TILE    = 0x01;
const BONES_TILE   = 0x09;
const FLOOR_TILE   = 0x30;
const SECRET_TILE  = 0x44;  // false ceiling — passable, looks like wall
const VOID_TILE    = 0x5f;
const CHEST_TILE   = 0x7c;

// Door tile this module places on the host chamber's wall. Exported so
// caller / engine teleport-trigger code can register it.
export const LOCKED_ROOM_DOOR_TILE = SECRET_TILE;

// Shop interior cache — map 3 is identical every load.
let _replicaCache = null;

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Extract the magic shop interior from ROM and translate tile IDs to the
 * cave tileset. Returns a 2D array of tile IDs (SHAPE_H rows × SHAPE_W cols).
 * Cached after first call.
 */
export function getMagicShopReplica(rom) {
  if (_replicaCache) return _replicaCache;
  const m = loadMap(rom, MAGIC_SHOP_MAP_ID);
  const grid = [];
  for (let y = 0; y < SHOP_H; y++) {
    const row = [];
    for (let x = 0; x < SHOP_W; x++) {
      const src = m.tilemap[(SHOP_ORIGIN_Y + y) * 32 + (SHOP_ORIGIN_X + x)];
      row.push(SHOP_TO_CAVE.has(src) ? SHOP_TO_CAVE.get(src) : src);
    }
    grid.push(row);
  }
  _replicaCache = grid;
  return grid;
}

/**
 * Place the magic-shop-replica locked room in a free area of the tilemap.
 * Room is standalone — not physically connected to any chamber. Use
 * `placeChamberDoor` separately to put the teleport-entry tile on the
 * host chamber wall.
 *
 * The replica preserves the shop's floor-0 wall convention (ceiling row on
 * top, rock rows underneath) automatically. Inside the interior, scatter
 * chests + bones (no other features per spec — "only chests and skeletons
 * in the rooms for now").
 *
 * @param {Uint8Array} tilemap   32×32 dungeon tilemap, mutated in place.
 * @param {Uint8Array} rom       FF3 ROM (for the shop template).
 * @param {number}     anchorX   Tile X of the replica's top-left corner.
 * @param {number}     anchorY   Tile Y of the replica's top-left corner.
 * @param {Function}   rng       Seeded RNG ([0, 1)).
 * @param {object}     [opts]
 * @param {number}     [opts.chests=2]
 * @param {number}     [opts.skeletons=3]
 * @param {Set}        [opts.used]      Exclusion set extended with every
 *                                      tile the room occupies (so caller's
 *                                      downstream feature placers skip them).
 * @returns {{interior: Set<string>, bounds: {top,bot,left,right}}|null}
 *   `null` if the room would not fit on the map.
 */
export function placeLockedRoom(tilemap, rom, anchorX, anchorY, rng, opts = {}) {
  const { chests = 2, skeletons = 3, used = new Set() } = opts;
  const grid = getMagicShopReplica(rom);
  const gh = grid.length, gw = grid[0].length;

  if (anchorX < 0 || anchorY < 0 || anchorX + gw > 32 || anchorY + gh > 32) return null;

  const interior = new Set();
  for (let r = 0; r < gh; r++) {
    for (let c = 0; c < gw; c++) {
      const tile = grid[r][c];
      const wx = anchorX + c, wy = anchorY + r;
      if (tile === VOID_TILE) continue;  // leave whatever was there
      tilemap[wy * 32 + wx] = tile;
      used.add(`${wx},${wy}`);
      if (tile === FLOOR_TILE) interior.add(`${wx},${wy}`);
    }
  }

  // Reserve the door-entry tile (the floor directly inside the shop's door,
  // which in the shop interior at (4, 8) → (4, 9) translated through the
  // tileset = the secret-pass tile and the floor above it). Skip the secret
  // tile itself + the tile above so chests don't sit in the doorway path.
  // Door coords inside the grid: door tile at row 10 col 4, entry floor at
  // row 9 col 4, secret-pass at row 8 col 4. Strip any of these from the
  // chest pool.
  for (const [dr, dc] of [[8, 4], [9, 4], [10, 4]]) {
    interior.delete(`${anchorX + dc},${anchorY + dr}`);
  }

  const pool = [...interior].map(s => { const [x, y] = s.split(',').map(Number); return { x, y }; });
  for (let i = 0; i < chests && pool.length > 0; i++) {
    const idx = Math.floor(rng() * pool.length);
    const { x, y } = pool.splice(idx, 1)[0];
    tilemap[y * 32 + x] = CHEST_TILE;
  }
  for (let i = 0; i < skeletons && pool.length > 0; i++) {
    const idx = Math.floor(rng() * pool.length);
    const { x, y } = pool.splice(idx, 1)[0];
    tilemap[y * 32 + x] = BONES_TILE;
  }

  return {
    interior,
    bounds: { top: anchorY, bot: anchorY + gh - 1, left: anchorX, right: anchorX + gw - 1 },
  };
}

/**
 * Set the teleport-entry door tile on a host chamber's wall. The tile is
 * the same false-ceiling 0x44 the locked room's interior uses — the engine
 * treats it as walkable false ceiling, and a future map-trigger registration
 * will fire the teleport-to-locked-room transition when the player steps
 * onto it. Walls flanking the door coord are NOT modified by this call;
 * `findChamberDoorPos` is responsible for picking a coord that already has
 * walls on each side along the wall axis.
 *
 * @param {Uint8Array} tilemap
 * @param {number} doorX
 * @param {number} doorY
 */
export function placeChamberDoor(tilemap, doorX, doorY) {
  tilemap[doorY * 32 + doorX] = SECRET_TILE;
}

/**
 * Find a viable door coordinate on a chamber wall.
 * "Viable" = wall tile (CEILING or ROCK) flanked by walls along the wall
 * axis, with walkable floor on the chamber-interior side so the player can
 * approach the door from inside.
 *
 * @param {Uint8Array} tilemap
 * @param {string}     side    'north' (chamber floor is south of door).
 *                             south/east/west deferred until a caller needs.
 * @param {object}     opts
 * @param {object}     [opts.xRange]  { min, max } restricts candidate X.
 * @param {object}     [opts.yRange]  { min, max } restricts candidate Y.
 * @param {Function}   [opts.rng]     RNG for tiebreak (default Math.random).
 * @returns {{x:number,y:number}|null}
 */
export function findChamberDoorPos(tilemap, side, opts = {}) {
  const { xRange, yRange, rng = Math.random } = opts;
  const xMin = xRange ? xRange.min : 1;
  const xMax = xRange ? xRange.max : 30;
  const yMin = yRange ? yRange.min : 1;
  const yMax = yRange ? yRange.max : 30;
  const candidates = [];

  if (side === 'north') {
    // Walk top-down; pick the topmost row with any viable candidate so the
    // door sits on the chamber's actual north edge (not an interior wall).
    for (let y = yMin; y <= yMax; y++) {
      for (let x = xMin; x <= xMax; x++) {
        if (!_isWall(tilemap[y * 32 + x])) continue;
        if (!_isWall(tilemap[y * 32 + x - 1]) || !_isWall(tilemap[y * 32 + x + 1])) continue;
        if (!_isWalkable(tilemap[(y + 1) * 32 + x])) continue;
        candidates.push({ x, y });
      }
      if (candidates.length > 0) break;
    }
  }

  if (candidates.length === 0) return null;
  return candidates[Math.floor(rng() * candidates.length)];
}

// ── Helpers ───────────────────────────────────────────────────────────────

function _isWall(t)     { return t === CEILING_TILE || t === ROCK_TILE; }
function _isWalkable(t) { return t === FLOOR_TILE || t === BONES_TILE || t === SECRET_TILE; }
