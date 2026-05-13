// NPC runtime — active NPC list, sprite render, tile-based interaction lookup,
// FF-style wander (walk straight one tile → pause → walk straight one tile).
// Sprites come from the existing ROM-extracted asset pipeline (e.g. the moogle
// already initialized by sprite-init.js and parked on `hudSt.moogleFrames`).

import { NPCS } from './data/npcs.js';
import { hudSt } from './hud-state.js';
import { mapSt } from './map-state.js';
import { msgState, showMsgBoxPages } from './message-box.js';
import { _nameToBytes } from './text-utils.js';
import { sprite } from './player-sprite.js';
import { DIR_DOWN, DIR_UP, DIR_LEFT, DIR_RIGHT } from './sprite.js';

const TILE_SIZE = 16;

// Walk cadence — slower than the player so the moogle reads as ambient.
const WALK_DURATION_MS = 480;
const PAUSE_MIN_MS     = 600;
const PAUSE_MAX_MS     = 1800;
// Walk-cycle frame swap during motion (same 2-frame normal/flipped pair).
const WALK_FRAME_MS    = 160;

const FLOOR = 0x30;

let _npcs = [];

// ── Public API ─────────────────────────────────────────────────────────────

export function clearNpcs() { _npcs = []; }

export function addMoogle(tileX, tileY) {
  const entry = NPCS.get('altar_moogle');
  _npcs.push({
    key: 'altar_moogle',
    tileX, tileY,
    homeX: tileX, homeY: tileY,
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
    talkFacing: null,  // when set ('left' or 'right'), overrides wander frame
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

// Tile lookup: returns the NPC at (tileX, tileY) — checks the source tile of
// a currently-walking NPC AND its destination tile, so the player can never
// walk through a moogle mid-step.
export function findNpcAt(tileX, tileY) {
  for (const npc of _npcs) {
    if (npc.tileX === tileX && npc.tileY === tileY) return npc;
    if (npc.mode === 'walk' && npc.walkFromX === tileX && npc.walkFromY === tileY) return npc;
  }
  return null;
}

// ── Update tick (called from game-loop) ────────────────────────────────────

export function updateNpcs(dt) {
  if (_npcs.length === 0) return;
  // Freeze wander while talking to the player so they don't drift away mid-line.
  if (msgState.state !== 'none') return;
  for (const npc of _npcs) _tickNpc(npc, dt);
}

function _tickNpc(npc, dt) {
  npc.timer -= dt;
  if (npc.mode === 'pause') {
    if (npc.timer > 0) return;
    _startWalk(npc);
    return;
  }
  // walking — interpolate pixel offset along (walkDX, walkDY)
  if (npc.timer <= 0) {
    // arrived
    npc.tileX = npc.walkFromX + npc.walkDX;
    npc.tileY = npc.walkFromY + npc.walkDY;
    npc.pixelOffX = 0;
    npc.pixelOffY = 0;
    npc.mode = 'pause';
    npc.timer = _randPauseMs();
    return;
  }
  const progress = 1 - (npc.timer / WALK_DURATION_MS);
  npc.pixelOffX = Math.round(npc.walkDX * TILE_SIZE * progress) - npc.walkDX * TILE_SIZE;
  npc.pixelOffY = Math.round(npc.walkDY * TILE_SIZE * progress) - npc.walkDY * TILE_SIZE;
}

function _startWalk(npc) {
  if (!mapSt.mapData) { npc.timer = _randPauseMs(); return; }
  const dirs = _shuffledDirs();
  for (const [dx, dy] of dirs) {
    const tx = npc.tileX + dx, ty = npc.tileY + dy;
    if (!_isOpenAreaTile(mapSt.mapData.tilemap, tx, ty)) continue;
    if (_tileOccupied(tx, ty, npc)) continue;
    // Set destination immediately so collision checks see both tiles.
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
    return;
  }
  // No legal step right now — pause and try again.
  npc.timer = _randPauseMs();
}

// "Open area" = FLOOR with ≥3 walkable neighbors. Keeps the moogle off
// 1-wide corridors so they never block the player's path through the cave.
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
  // Block stepping onto the player
  const ptx = (mapSt.worldX / TILE_SIZE) | 0;
  const pty = (mapSt.worldY / TILE_SIZE) | 0;
  if (tx === ptx && ty === pty) return true;
  // Block stepping onto another NPC's tile or its in-flight destination
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

function _resolveNpcCanvas(npc) {
  if (npc.spriteKey === 'moogle') {
    const frames = hudSt.moogleFrames;
    if (!frames) return null;
    // Talking: lock to the frame that points at the player. `frames[0]` is
    // the ROM-native facing, `frames[1]` is the h-flipped mirror — convention
    // here is that frame 0 = facing right, frame 1 = facing left. (If the
    // visual reads inverted on the live site, swap the two indices below.)
    if (npc.talkFacing === 'left')  return frames[1];
    if (npc.talkFacing === 'right') return frames[0];
    // Walking: alternate on a fixed cadence. Pausing: hold frame 0.
    const idx = npc.mode === 'walk'
      ? (Math.floor((WALK_DURATION_MS - npc.timer) / WALK_FRAME_MS) & 1)
      : 0;
    return frames[idx];
  }
  return null;
}

export function drawNpcs(ctx, camX, camY, originX, originY) {
  if (_npcs.length === 0) return;
  const wLeft = camX - originX;
  const wTop = camY - originY;
  for (const npc of _npcs) {
    const canvas = _resolveNpcCanvas(npc);
    if (!canvas) continue;
    const sx = npc.tileX * TILE_SIZE + npc.pixelOffX - wLeft;
    const sy = npc.tileY * TILE_SIZE + npc.pixelOffY - wTop;
    if (sx < -16 || sx > 256 || sy < -16 || sy > 240) continue;
    ctx.drawImage(canvas, sx, sy);
  }
}

// ── Dialogue ───────────────────────────────────────────────────────────────

export function talkToNpc(npc) {
  if (!npc || !npc.dialogue || npc.dialogue.length === 0) return;
  // Pin the NPC's facing direction to the player for the duration of the
  // chat — the moogle has only normal/flipped frames, so up/down approaches
  // fall back to "face right" (no vertical sprite to use).
  if (sprite) {
    const pdir = sprite.getDirection();
    if (pdir === DIR_LEFT)        npc.talkFacing = 'right'; // player faces left → moogle is to player's left → moogle looks right at player
    else if (pdir === DIR_RIGHT)  npc.talkFacing = 'left';
    else if (pdir === DIR_UP || pdir === DIR_DOWN) npc.talkFacing = 'right';
  }
  const pages = npc.dialogue.map(line => _nameToBytes(line));
  showMsgBoxPages(pages, () => { npc.talkFacing = null; });
}
