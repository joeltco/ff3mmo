// NPC runtime — active NPC list, sprite render, tile-based interaction
// lookup, FF-style wander.
//
// Single source of truth for every NPC-style sprite in ff3mmo:
//   - moogle (wander)            — gfxId 42, MOOGLE_PAL
//   - black-mage shopkeeper      — gfxId 4 (BM walk bank), BM palette
//   - opening-scene NPCs         — raw ROM bundle offsets (data/opening-scene.js)
//   - boss-on-map (Land Turtle)  — pre-rendered canvas frames
//   - loading-screen sprites     — pulled by `loading-screen.js` via getters below
//
// See [[ff3mmo-one-npc-module]] for the rule. New NPC types extend the
// helpers + render dispatch here — no parallel render paths.

import { NPCS } from './data/npcs.js';
import { romRaw } from './boot.js';
import { mapSt } from './map-state.js';
import { msgState, showMsgBoxPages } from './message-box.js';
import { _nameToBytes } from './text-utils.js';
import { sprite as playerSprite } from './player-sprite.js';
import { Sprite, DIR_DOWN, DIR_UP, DIR_LEFT, DIR_RIGHT } from './sprite.js';
import { MOOGLE_GFX_ID, MOOGLE_PAL } from './sprite-init.js';
import { BM_WALK_TOP, BM_WALK_BTM } from './job-sprites.js';
import { OPENING_ELDER, OPENING_LEFT_ATTENDANT, OPENING_RIGHT_ATTENDANT } from './data/opening-scene.js';
import { INN_ITEM_KEEPER } from './data/town-npcs.js';
import { openShop } from './shop.js';
import { waterSt } from './water-animation.js';
import { battleSt } from './battle-state.js';

const TILE_SIZE = 16;

const WALK_DURATION_MS = 480;
const PAUSE_MIN_MS     = 1500;
const PAUSE_MAX_MS     = 4000;
const WALK_RUN_MIN     = 1;     // tiles per wander burst
const WALK_RUN_MAX     = 3;
const FLOOR            = 0x30;
const IDLE_MARCH_MS    = 480;   // walk-cycle period for stationary NPCs

let _npcs = [];

// ── Sprite asset registry ──────────────────────────────────────────────────
// Pre-rendered canvas frames live here as the single source. Producers
// (sprite-init.js consumers in boot.js) set; consumers (loading-screen.js,
// drawNpcs below) read via getters.
let _landTurtleFrames = null;        // [normal16, flipped16]
let _landTurtleFadeFrames = null;    // [[normal, flipped], ...] per fade level
let _loadingMoogleFadeFrames = null; // [[normal, flipped], ...] per fade level

export function setLandTurtleFrames(f)        { _landTurtleFrames = f; }
export function getLandTurtleFrames()         { return _landTurtleFrames; }
export function setLandTurtleFadeFrames(f)    { _landTurtleFadeFrames = f; }
export function getLandTurtleFadeFrames()     { return _landTurtleFadeFrames; }
export function setLoadingMoogleFadeFrames(f) { _loadingMoogleFadeFrames = f; }
export function getLoadingMoogleFadeFrames()  { return _loadingMoogleFadeFrames; }

// ── Sprite-class resolver (moogle / black mage / scene) ────────────────────
// Each entry returns a `Sprite` instance bound to its bank + palette. Cached
// so we don't rebuild the tile cache on every frame.
const _spriteCache = new Map();
const _SPRITE_FACTORIES = {
  moogle: () => {
    const s = new Sprite(romRaw, MOOGLE_PAL, MOOGLE_PAL);
    s.setGfxID(MOOGLE_GFX_ID);
    return s;
  },
  black_mage: () => {
    const s = new Sprite(romRaw, BM_WALK_TOP, BM_WALK_BTM);
    s.setGfxID(4); // jobIdx 4 = Black Mage walk-sprite GFX bank
    return s;
  },
  scene: (npc) => {
    const spec = npc.scene;
    const s = new Sprite(romRaw, spec.palTop, spec.palBtm);
    s.gfxBase = spec.romOffset; // raw ROM bundle (header-inclusive, see [[ff3mmo-ines-header-romraw-vs-header-stripped]])
    s.tileCache.clear();
    return s;
  },
};
function _getSprite(npc) {
  if (!romRaw) return null;
  // Scene NPCs are per-key (different ROM bundles); moogle/BM share one.
  const cacheKey = npc.spriteKey === 'scene' ? `scene:${npc.key}` : npc.spriteKey;
  let s = _spriteCache.get(cacheKey);
  if (s) return s;
  const factory = _SPRITE_FACTORIES[npc.spriteKey];
  if (!factory) return null;
  s = factory(npc);
  _spriteCache.set(cacheKey, s);
  return s;
}

// ── NPC record factory ─────────────────────────────────────────────────────
// All NPCs share this skeleton. `add*` helpers below differ only in
// spriteKey + mode + role-specific fields (dialogue / shopId / scene spec).
function _makeNpc(key, tileX, tileY, opts) {
  return {
    key,
    tileX, tileY,
    spriteKey:  opts.spriteKey,
    dialogue:   opts.dialogue || null,
    shopId:     opts.shopId   || null,
    scene:      opts.scene    || null,
    mode:       opts.mode,
    timer:      opts.mode === 'pause' ? _randPauseMs() : 0,
    pixelOffX:  0,
    pixelOffY:  0,
    walkDX:     0,
    walkDY:     0,
    walkFromX:  tileX,
    walkFromY:  tileY,
    dir:        opts.dir != null ? opts.dir : DIR_DOWN,
    talkFacing: null,
    runRemaining: 0,
  };
}

// ── Public API: clear / add / query ────────────────────────────────────────

export function clearNpcs() { _npcs = []; }

export function addMoogle(tileX, tileY) {
  const entry = NPCS.get('altar_moogle');
  _npcs.push(_makeNpc('altar_moogle', tileX, tileY, {
    spriteKey: 'moogle',
    dialogue:  (entry && entry.dialogue) || [],
    mode:      'pause',
  }));
}

// Stationary shopkeeper NPC — walks in place; opens `shopId` on Z.
export function addBlackMageShopkeeper(tileX, tileY, shopId) {
  _npcs.push(_makeNpc('bm_shop', tileX, tileY, {
    spriteKey: 'black_mage',
    shopId,
    mode:      'idle-march',
  }));
}

// Boss NPC (Land Turtle on the altar floor). Battle trigger + walk-onto
// blocker still go through `mapSt.bossSprite` in `movement.js` —
// `addBossNpc` only owns the visual render path.
export function addBossNpc(tileX, tileY) {
  _npcs.push(_makeNpc('boss_land_turtle', tileX, tileY, {
    spriteKey: 'boss',
    mode:      'static',
  }));
}

// v1.7.454 — drop the boss NPC from the active list on defeat. The
// map-loading path gates new spawns on `battleSt.enemyDefeated`, but the
// already-pushed NPC entry was never removed, so the boss sprite stayed
// on-screen after the dissolve. On next dungeon reload `addBossNpc` runs
// again because clearNpcs() ran at map load.
export function removeBossNpc() {
  _npcs = _npcs.filter(n => n.key !== 'boss_land_turtle');
}

// Scene NPC — backed by the player Sprite class with `gfxBase` overridden
// to a raw FF3 ROM walk bundle (see data/opening-scene.js). `spec.animate`
// cycles walk frames; otherwise stays on frame 0 (no fabricated motion —
// see [[never-add-fake-content-user-didnt-ask-for]]).
export function addSceneNpc(key, tileX, tileY, spec) {
  _npcs.push(_makeNpc(key, tileX, tileY, {
    spriteKey: 'scene',
    scene:     spec,
    mode:      spec.animate ? 'idle-march' : 'static',
    dir:       spec.dir,
  }));
}

export function placeMoogleAtCaveCenter(mapData) {
  const cx = 16, cy = 10;
  for (let r = 0; r < 12; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const tx = cx + dx, ty = cy + dy;
        if (!_isOpenAreaTile(mapData.tilemap, tx, ty)) continue;
        addMoogle(tx, ty);
        return true;
      }
    }
  }
  return false;
}

// Map 7 (new-game spawn) opening scene: elder facing south, two
// attendants flanking the player and facing inward. Player spawns at
// (4, 4); elder 1N, attendants 2W + 2E. See [[ff3mmo-opening-scene-map-7]].
export function placeOpeningScene() {
  addSceneNpc('opening_elder', 4, 3, OPENING_ELDER);
  addSceneNpc('opening_left',  2, 4, OPENING_LEFT_ATTENDANT);
  addSceneNpc('opening_right', 6, 4, OPENING_RIGHT_ATTENDANT);
}

// Map 8 (inn): the item-shop keeper stands behind the counter at (8,15),
// one tile north at (8,14), facing south toward the player.
export function placeInnNpcs() {
  addSceneNpc('inn_item_keeper', 8, 14, INN_ITEM_KEEPER);
}

export function findNpcAt(tileX, tileY) {
  for (const npc of _npcs) {
    if (npc.tileX === tileX && npc.tileY === tileY) return npc;
    if (npc.mode === 'walk' && npc.walkFromX === tileX && npc.walkFromY === tileY) return npc;
  }
  return null;
}

// ── Update tick ────────────────────────────────────────────────────────────

export function updateNpcs(dt) {
  if (_npcs.length === 0) return;
  if (msgState.state !== 'none') return;
  for (const npc of _npcs) _tickNpc(npc, dt);
}

function _tickNpc(npc, dt) {
  if (npc.mode === 'static') return;
  if (npc.mode === 'idle-march') {
    npc.timer = (npc.timer + dt) % (IDLE_MARCH_MS * 2);
    return;
  }
  npc.timer -= dt;
  if (npc.mode === 'pause') {
    if (npc.timer > 0) return;
    // Start a new walk burst: pick a direction + a 1..3-tile run length.
    npc.runRemaining = WALK_RUN_MIN + Math.floor(Math.random() * (WALK_RUN_MAX - WALK_RUN_MIN + 1));
    _startWalk(npc);
    return;
  }
  // mode === 'walk'
  if (npc.timer <= 0) {
    npc.tileX = npc.walkFromX + npc.walkDX;
    npc.tileY = npc.walkFromY + npc.walkDY;
    npc.pixelOffX = 0;
    npc.pixelOffY = 0;
    npc.runRemaining--;
    if (npc.runRemaining > 0 && _trySameDir(npc)) return;
    npc.mode = 'pause';
    npc.timer = _randPauseMs();
    return;
  }
  const progress = 1 - (npc.timer / WALK_DURATION_MS);
  npc.pixelOffX = Math.round(npc.walkDX * TILE_SIZE * progress) - npc.walkDX * TILE_SIZE;
  npc.pixelOffY = Math.round(npc.walkDY * TILE_SIZE * progress) - npc.walkDY * TILE_SIZE;
}

// Same-direction continuation: keep dx/dy if the next tile is legal.
function _trySameDir(npc) {
  if (!mapSt.mapData) return false;
  const dx = npc.walkDX, dy = npc.walkDY;
  const tx = npc.tileX + dx, ty = npc.tileY + dy;
  if (!_isOpenAreaTile(mapSt.mapData.tilemap, tx, ty)) return false;
  if (_tileOccupied(tx, ty, npc)) return false;
  npc.mode = 'walk';
  npc.timer = WALK_DURATION_MS;
  npc.walkFromX = npc.tileX;
  npc.walkFromY = npc.tileY;
  npc.tileX = tx;
  npc.tileY = ty;
  npc.pixelOffX = -dx * TILE_SIZE;
  npc.pixelOffY = -dy * TILE_SIZE;
  return true;
}

function _startWalk(npc) {
  if (!mapSt.mapData) { npc.timer = _randPauseMs(); return; }
  const dirs = _shuffledDirs();
  for (const [dx, dy] of dirs) {
    const tx = npc.tileX + dx, ty = npc.tileY + dy;
    if (!_isOpenAreaTile(mapSt.mapData.tilemap, tx, ty)) continue;
    if (_tileOccupied(tx, ty, npc)) continue;
    npc.mode = 'walk';
    npc.timer = WALK_DURATION_MS;
    npc.walkFromX = npc.tileX;
    npc.walkFromY = npc.tileY;
    npc.walkDX = dx;
    npc.walkDY = dy;
    npc.tileX = tx;
    npc.tileY = ty;
    npc.pixelOffX = -dx * TILE_SIZE;
    npc.pixelOffY = -dy * TILE_SIZE;
    npc.dir = _dxDyToDir(dx, dy);
    return;
  }
  npc.runRemaining = 0;
  npc.timer = _randPauseMs();
}

function _dxDyToDir(dx, dy) {
  if (dx > 0) return DIR_RIGHT;
  if (dx < 0) return DIR_LEFT;
  if (dy > 0) return DIR_DOWN;
  if (dy < 0) return DIR_UP;
  return DIR_DOWN;
}

function _isOpenAreaTile(tilemap, x, y) {
  if (x < 1 || x > 30 || y < 1 || y > 30) return false;
  if (tilemap[y * 32 + x] !== FLOOR) return false;
  let nbrs = 0;
  if (x + 1 < 32 && tilemap[y * 32 + (x + 1)] === FLOOR) nbrs++;
  if (x - 1 >= 0 && tilemap[y * 32 + (x - 1)] === FLOOR) nbrs++;
  if (y + 1 < 32 && tilemap[(y + 1) * 32 + x] === FLOOR) nbrs++;
  if (y - 1 >= 0 && tilemap[(y - 1) * 32 + x] === FLOOR) nbrs++;
  return nbrs >= 3;
}

function _tileOccupied(tx, ty, selfNpc) {
  // Player straddles two tiles mid-walk (lerped worldX/worldY). Treat both
  // the player's FROM and TO tiles as occupied so a wandering NPC never
  // steps into the player's destination during a player walk.
  const pfx = Math.floor(mapSt.worldX / TILE_SIZE);
  const pcx = Math.ceil(mapSt.worldX  / TILE_SIZE);
  const pfy = Math.floor(mapSt.worldY / TILE_SIZE);
  const pcy = Math.ceil(mapSt.worldY  / TILE_SIZE);
  if ((tx === pfx || tx === pcx) && (ty === pfy || ty === pcy)) return true;
  for (const other of _npcs) {
    if (other === selfNpc) continue;
    if (other.tileX === tx && other.tileY === ty) return true;
    if (other.mode === 'walk' && other.walkFromX === tx && other.walkFromY === ty) return true;
  }
  return false;
}

const _DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
function _shuffledDirs() {
  const a = _DIRS.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function _randPauseMs() {
  return PAUSE_MIN_MS + Math.floor(Math.random() * (PAUSE_MAX_MS - PAUSE_MIN_MS));
}

// ── Render ─────────────────────────────────────────────────────────────────

// Walk-frame phase 0..1 (null = hold frame 0). Wander uses walk-duration
// timing; in-place "idle-march" uses its own period.
function _walkPhase(npc) {
  if (npc.talkFacing != null) return null; // hold pose while talking
  if (npc.mode === 'walk')       return 1 - (npc.timer / WALK_DURATION_MS);
  if (npc.mode === 'idle-march') return (npc.timer / IDLE_MARCH_MS) % 1;
  return null;
}

export function drawNpcs(ctx, camX, camY, originX, originY, spriteY) {
  if (_npcs.length === 0) return;
  // Map tiles use `originY` (3px below `spriteY`); sprites use `spriteY` so
  // their feet align with the player on the same row.
  const wLeft = camX - originX;
  const wTop  = camY - (spriteY != null ? spriteY : originY);
  for (const npc of _npcs) {
    const sx = npc.tileX * TILE_SIZE + npc.pixelOffX - wLeft;
    const sy = npc.tileY * TILE_SIZE + npc.pixelOffY - wTop;
    if (sx < -16 || sx > 256 || sy < -16 || sy > 240) continue;

    if (npc.spriteKey === 'boss') {
      _drawBossNpc(ctx, sx, sy);
      continue;
    }
    // Sprite-class NPCs (moogle / black_mage / scene).
    const s = _getSprite(npc);
    if (!s) continue;
    s.setDirection(npc.talkFacing != null ? npc.talkFacing : npc.dir);
    const phase = _walkPhase(npc);
    if (phase == null) s.resetFrame();
    else               s.setWalkProgress(phase);
    s.draw(ctx, sx, sy);
  }
}

function _drawBossNpc(ctx, sx, sy) {
  const frames = _landTurtleFrames;
  if (!frames) return;
  // Blink-out during boss flash (e.g., spell impact) — preserved from the
  // previous render.js path.
  const blinkHidden = battleSt.bossFlashTimer > 0 && (Math.floor(battleSt.bossFlashTimer / 60) & 1);
  if (blinkHidden) return;
  // 2-frame idle anim on water-tick parity. Land Turtle only has south-facing
  // frames in ROM (no other directions captured), so no setDirection.
  const idx = Math.floor(waterSt.tick / 8) & 1;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(frames[idx], sx, sy);
}

// ── Dialogue ───────────────────────────────────────────────────────────────

export function talkToNpc(npc) {
  if (!npc) return;
  // Shopkeeper NPC: open the linked shop directly. The shop UI takes over;
  // no dialogue box. Keep the NPC's south-facing pose (don't flip to player).
  if (npc.shopId) {
    openShop(npc.shopId);
    return;
  }
  if (!npc.dialogue || npc.dialogue.length === 0) return;
  // NPC turns to face the player. Player's facing = direction they walked
  // INTO the NPC, so the NPC's talk-facing is the opposite axis.
  if (playerSprite) {
    const pdir = playerSprite.getDirection();
    if (pdir === DIR_DOWN)       npc.talkFacing = DIR_UP;
    else if (pdir === DIR_UP)    npc.talkFacing = DIR_DOWN;
    else if (pdir === DIR_LEFT)  npc.talkFacing = DIR_RIGHT;
    else if (pdir === DIR_RIGHT) npc.talkFacing = DIR_LEFT;
  }
  const pages = npc.dialogue.map(line => _nameToBytes(line));
  showMsgBoxPages(pages, () => { npc.talkFacing = null; });
}
