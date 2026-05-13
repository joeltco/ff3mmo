// NPC runtime — active NPC list, sprite render (4-dir walking via the shared
// `Sprite` class + ROM bank 42), tile-based interaction lookup, FF-style
// wander (walk straight one tile → pause → walk straight one tile).

import { NPCS } from './data/npcs.js';
import { romRaw } from './boot.js';
import { mapSt } from './map-state.js';
import { msgState, showMsgBoxPages } from './message-box.js';
import { _nameToBytes } from './text-utils.js';
import { sprite as playerSprite } from './player-sprite.js';
import { Sprite, DIR_DOWN, DIR_UP, DIR_LEFT, DIR_RIGHT } from './sprite.js';
import { MOOGLE_GFX_ID, MOOGLE_PAL } from './sprite-init.js';

const TILE_SIZE = 16;

const WALK_DURATION_MS = 480;
const PAUSE_MIN_MS     = 1500;
const PAUSE_MAX_MS     = 4000;
const WALK_RUN_MIN     = 1;     // tiles in a single walk burst before pausing
const WALK_RUN_MAX     = 3;
const FLOOR = 0x30;

let _npcs = [];
let _moogleSprite = null;

function _getMoogleSprite() {
  if (_moogleSprite) return _moogleSprite;
  if (!romRaw) return null;
  _moogleSprite = new Sprite(romRaw, MOOGLE_PAL, MOOGLE_PAL);
  _moogleSprite.setGfxID(MOOGLE_GFX_ID);
  return _moogleSprite;
}

// ── Public API ─────────────────────────────────────────────────────────────

export function clearNpcs() { _npcs = []; }

export function addMoogle(tileX, tileY) {
  const entry = NPCS.get('altar_moogle');
  _npcs.push({
    key: 'altar_moogle',
    tileX, tileY,
    spriteKey: 'moogle',
    dialogue: (entry && entry.dialogue) || [],
    mode: 'pause',
    timer: _randPauseMs(),
    pixelOffX: 0,
    pixelOffY: 0,
    walkDX: 0,
    walkDY: 0,
    walkFromX: tileX,
    walkFromY: tileY,
    dir: DIR_DOWN,
    talkFacing: null,  // DIR_* when set during dialogue, overrides wander dir
    runRemaining: 0,   // tiles left in the current walk burst
  });
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

export function getNpcs() { return _npcs; }

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
  npc.timer -= dt;
  if (npc.mode === 'pause') {
    if (npc.timer > 0) return;
    // Start a new walk burst: pick a direction + a 1..3-tile run length.
    npc.runRemaining = WALK_RUN_MIN + Math.floor(Math.random() * (WALK_RUN_MAX - WALK_RUN_MIN + 1));
    _startWalk(npc, null);
    return;
  }
  if (npc.timer <= 0) {
    npc.tileX = npc.walkFromX + npc.walkDX;
    npc.tileY = npc.walkFromY + npc.walkDY;
    npc.pixelOffX = 0;
    npc.pixelOffY = 0;
    npc.runRemaining--;
    // Continue the burst in the SAME direction if there are tiles left AND
    // the next step is legal. Otherwise pause.
    if (npc.runRemaining > 0 && _trySameDir(npc)) return;
    npc.mode = 'pause';
    npc.timer = _randPauseMs();
    return;
  }
  const progress = 1 - (npc.timer / WALK_DURATION_MS);
  npc.pixelOffX = Math.round(npc.walkDX * TILE_SIZE * progress) - npc.walkDX * TILE_SIZE;
  npc.pixelOffY = Math.round(npc.walkDY * TILE_SIZE * progress) - npc.walkDY * TILE_SIZE;
}

// Same-direction continuation: keep the same dx/dy if the next tile is legal.
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
  const ptx = (mapSt.worldX / TILE_SIZE) | 0;
  const pty = (mapSt.worldY / TILE_SIZE) | 0;
  if (tx === ptx && ty === pty) return true;
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

export function drawNpcs(ctx, camX, camY, originX, originY) {
  if (_npcs.length === 0) return;
  const moogle = _getMoogleSprite();
  if (!moogle) return;
  const wLeft = camX - originX;
  const wTop = camY - originY;
  for (const npc of _npcs) {
    if (npc.spriteKey !== 'moogle') continue;
    const sx = npc.tileX * TILE_SIZE + npc.pixelOffX - wLeft;
    const sy = npc.tileY * TILE_SIZE + npc.pixelOffY - wTop;
    if (sx < -16 || sx > 256 || sy < -16 || sy > 240) continue;
    // Direction: locked to player during dialogue, otherwise current wander dir.
    moogle.setDirection(npc.talkFacing != null ? npc.talkFacing : npc.dir);
    // Walk-cycle frame: while walking, advance from progress; while paused/talking, hold frame 0.
    if (npc.mode === 'walk' && npc.talkFacing == null) {
      const progress = 1 - (npc.timer / WALK_DURATION_MS);
      moogle.setWalkProgress(progress);
    } else {
      moogle.resetFrame();
    }
    moogle.draw(ctx, sx, sy);
  }
}

// ── Dialogue ───────────────────────────────────────────────────────────────

export function talkToNpc(npc) {
  if (!npc || !npc.dialogue || npc.dialogue.length === 0) return;
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
