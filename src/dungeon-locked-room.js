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

import { loadMap, processTriggerTiles } from './map-loader.js';
import { loadRomAssets, mulberry32 } from './dungeon-generator.js';

// ── Source map ────────────────────────────────────────────────────────────

const MAGIC_SHOP_MAP_ID = 3;
const SHOP_ORIGIN_X = 0;
// FULL magic shop interior — rows 0-10, all 11 rows. v1.7.661 restored
// after v1.7.651's bottom-only trim was caught as "half the room missing".
// Anchor placement (caller's responsibility) needs to allow 11 rows below
// the chamber; the floor-0 hook anchors at Y=21 (spans rows 21-31).
const SHOP_ORIGIN_Y = 0;
const SHOP_W = 9;
const SHOP_H = 11;

// Shop tileset (5) → cave tileset (0) translation. The magic shop's door
// is a 3-tile passable SPINE — secret-pass on top (0x44), door-middle in
// the middle (0x45), door-bottom at the south (0x68). All three are
// walkable; the player walks UP through the spine to enter the shop.
// We translate them to keep that passability:
//   - 0x44 → cave 0x44 (same false-ceiling tile, passable)
//   - 0x45 → cave 0x30 (floor; visually clean inside the door corridor)
//   - 0x68 → cave 0x70 (visible cave door with engine open-on-touch)
// Frame tiles (1b door-top, 19/1a stairwell decoration) become cave
// ceiling. Walls + void share IDs across both tilesets.
const SHOP_TO_CAVE = new Map([
  [0x00, 0x00],
  [0x01, 0x01],
  [0x3a, 0x30],
  [0x20, 0x30],
  [0x47, 0x30],
  [0x44, 0x44],  // shop secret-pass → cave secret-pass (passable)
  [0x45, 0x30],  // shop door-middle → cave floor (passable middle of spine)
  [0x68, 0x70],  // shop door-bottom → CAVE DOOR (open-on-touch)
  [0x1b, 0x01],  // shop door-top → cave rock (NOT ceiling — keeps the
                 // addOverhang "ceiling on 2 rocks" pattern intact for the
                 // door column; ceiling here gave ceiling-rock-floor which
                 // is a 1-rock-under-ceiling glitch). v1.7.662.
  [0x5f, 0x5f],
  // Bottom stairwell room (rows 11-15 of map 3) tiles — not used by the
  // 7-row slice we take, listed for completeness.
  [0x08, 0x09],
  [0x09, 0x09],
  [0x19, 0x00],
  [0x1a, 0x00],
  [0x1d, 0x01],
  [0x7c, 0x7c],
]);

// ── Cave tileset constants (mirrored from dungeon-generator.js) ───────────

const CEILING_TILE = 0x00;
const ROCK_TILE    = 0x01;
const BONES_TILE   = 0x09;
const FLOOR_TILE   = 0x30;
const VOID_TILE    = 0x5f;
const CHEST_TILE   = 0x7c;
// Cave-tileset closed-door tile. The engine recognizes this as a door via
// its collisionByte2 attribute ((cb2[0x70] >> 4) & 0x0F === 5) and runs the
// open-on-touch animation (swaps to 0x7E for the open state, restores on
// move-off via `_openReturnDoor` + movement.js). Same tile ID is the door
// in the shop tileset too — engine logic is collisionByte2-driven, not
// tile-ID-driven. v1.7.654.
const DOOR_TILE    = 0x70;

// Door tile this module places on the host chamber's wall. Exported so
// caller / engine teleport-trigger code can register it.
export const LOCKED_ROOM_DOOR_TILE = DOOR_TILE;

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

  // Reserve cells the player walks through / lands on so chests + skeletons
  // don't block them. With SHOP_ORIGIN_Y=0 the door spine lives at grid rows
  // 8-10 col 4 (shop rows 8/9/10: secret-pass → cave 0x44, door-middle →
  // cave 0x30, door-bottom → cave 0x70). Grid row 7 col 4 is the interior
  // landing tile where the teleport-in lands the player. v1.7.661.
  for (const [dr, dc] of [[7, 4], [8, 4], [9, 4], [10, 4]]) {
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
 * onto it. Walls flanking the door coord (and the tile above it) are NOT
 * modified — `findChamberDoorPos` is responsible for picking a coord that
 * already satisfies the surround-with-walls invariant.
 *
 * @param {Uint8Array} tilemap
 * @param {number} doorX
 * @param {number} doorY
 */
export function placeChamberDoor(tilemap, doorX, doorY) {
  // Pure overwrite — nothing else is touched. `findChamberDoorPos` is the
  // single source of truth for the surround-with-rocks invariant; if it
  // returns a coord, all required rocks are already in place. Modifying
  // anything here risks disconnecting the ceiling snake the dungeon
  // generator relies on.
  tilemap[doorY * 32 + doorX] = DOOR_TILE;
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
    // STRICT find — all 5 surround tiles must ALREADY be rock; no tile is
    // modified (modifying surrounds risks disconnecting the ceiling snake).
    //   - (x, y)        must be ROCK (overwritten with door)
    //   - (x±1, y)      flanks both rock
    //   - (x, y-1)      above is rock
    //   - (x±1, y-1)    upper diagonals both rock
    //   - (x, y+1)      below is walkable floor (chamber-interior approach)
    // The chamber wall is mostly 1 tile thick (ceiling + rock + floor) so
    // top-row positions rarely satisfy all 5 rocks. The find walks DEEP into
    // the chamber wall (yRange should span the full chamber) — addOverhang
    // sometimes lays a 2-rock thick band lower down, and corridors create
    // chamber-adjacent rock pockets with full rock surrounds.
    for (let y = yMin; y <= yMax; y++) {
      for (let x = xMin; x <= xMax; x++) {
        if (tilemap[y * 32 + x] !== ROCK_TILE) continue;
        if (tilemap[y * 32 + x - 1] !== ROCK_TILE) continue;
        if (tilemap[y * 32 + x + 1] !== ROCK_TILE) continue;
        if (tilemap[(y - 1) * 32 + x] !== ROCK_TILE) continue;
        if (tilemap[(y - 1) * 32 + x - 1] !== ROCK_TILE) continue;
        if (tilemap[(y - 1) * 32 + x + 1] !== ROCK_TILE) continue;
        if (!_isWalkable(tilemap[(y + 1) * 32 + x])) continue;
        candidates.push({ x, y });
      }
      if (candidates.length > 0) break;
    }
  }

  if (candidates.length === 0) return null;
  return candidates[Math.floor(rng() * candidates.length)];
}

/**
 * Generate a STANDALONE locked-room map — a 32×32 tilemap of void with the
 * magic-shop replica placed in the center. The south door is registered as
 * a goBack-type-1 trigger, so walking onto it pops the mapStack and returns
 * the player to the chamber map (same way stairs-back works).
 *
 * Used for separate-map locked rooms (e.g., mapId 1010). The host chamber's
 * door tile should be a regular type-1 trigger with destination
 * `{ mapId: 1010 }` — the engine's existing `_triggerMapTransition` handles
 * the door-open animation + map transition + mapStack push automatically.
 *
 * Caller (typically `_loadDungeonFloor`) supplies a seed so chest / skeleton
 * placement stays deterministic across revisits (otherwise re-entering the
 * room would rerandomize, breaking the consumed-tile save). v1.7.665.
 *
 * @param {Uint8Array} rom    FF3 ROM
 * @param {number}     seed   integer for mulberry32 (chest scatter)
 * @returns {object} map data structure compatible with loadMapById.
 */
export function generateLockedRoomMap(rom, seed) {
  const assets = loadRomAssets(rom);
  const rng = mulberry32(seed | 0);

  // Fill with void; place replica centered.
  const tilemap = new Uint8Array(1024).fill(VOID_TILE);
  const anchorX = 11;
  const anchorY = 10;
  placeLockedRoom(tilemap, rom, anchorX, anchorY, rng, { chests: 2, skeletons: 3 });

  // South door = exit. Register as goBack so engine pops mapStack to the
  // chamber map. Door coord matches the shop's south door after translation:
  // anchorX + 4 col, anchorY + 10 row.
  const triggerMap = processTriggerTiles(tilemap);
  const doorX = anchorX + 4;
  const doorY = anchorY + 10;
  const dungeonDestinations = new Map();
  const doorTrig = triggerMap.get(`${doorX},${doorY}`);
  if (doorTrig) {
    dungeonDestinations.set(doorTrig.trigId, { goBack: true });
  }

  return {
    tileset: 0,
    fillTile: VOID_TILE,
    skipRoomClip: true,
    // Player spawns ON the door (matches magic-shop arrival — door animates
    // open via _openReturnDoor when returnX/Y is passed to loadMapById).
    entranceX: doorX,
    entranceY: doorY,
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
    dungeonDestinations,
    hiddenTraps: new Set(),
    falseWalls: new Map(),
    rockSwitch: null,
    warpTile: null,
    pondTiles: null,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function _isWall(t)     { return t === CEILING_TILE || t === ROCK_TILE; }
function _isWalkable(t) { return t === FLOOR_TILE || t === BONES_TILE || t === DOOR_TILE; }
