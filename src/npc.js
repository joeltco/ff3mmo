// NPC runtime — active NPC list, sprite render, tile-based interaction lookup.
// Sprites come from the existing ROM-extracted asset pipeline (e.g. the moogle
// already initialized by sprite-init.js and parked on `hudSt.moogleFrames`).

import { NPCS } from './data/npcs.js';
import { hudSt } from './hud-state.js';
import { showMsgBox } from './message-box.js';
import { _nameToBytes } from './text-utils.js';

const TILE_SIZE = 16;
const NPC_BOB_MS = 400;

let _npcs = [];

export function clearNpcs() { _npcs = []; }

export function addMoogle(tileX, tileY) {
  const entry = NPCS.get('altar_moogle');
  _npcs.push({
    key: 'altar_moogle',
    tileX,
    tileY,
    spriteKey: 'moogle',
    dialogue: (entry && entry.dialogue) || [],
  });
}

export function placeMoogleAtCaveCenter(mapData) {
  const FLOOR = 0x30;
  const isFloor = (x, y) => x >= 0 && x < 32 && y >= 0 && y < 32 && mapData.tilemap[y * 32 + x] === FLOOR;
  const cx = 16, cy = 10;
  for (let r = 0; r < 12; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const tx = cx + dx, ty = cy + dy;
        if (tx < 1 || tx > 30 || ty < 1 || ty > 30) continue;
        if (!isFloor(tx, ty)) continue;
        const walkableNbrs =
          (isFloor(tx + 1, ty) ? 1 : 0) +
          (isFloor(tx - 1, ty) ? 1 : 0) +
          (isFloor(tx, ty + 1) ? 1 : 0) +
          (isFloor(tx, ty - 1) ? 1 : 0);
        if (walkableNbrs < 3) continue;
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
  }
  return null;
}

// Resolve the active sprite canvas for an NPC. Moogle reads from hudSt — the
// ROM-extracted frames built by `initMoogleSprite` (sprite-init.js).
function _resolveNpcCanvas(npc) {
  if (npc.spriteKey === 'moogle') {
    const frames = hudSt.moogleFrames;
    if (!frames) return null;
    const frameIdx = Math.floor(performance.now() / NPC_BOB_MS) & 1;
    return frames[frameIdx];
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
    const sx = npc.tileX * TILE_SIZE - wLeft;
    const sy = npc.tileY * TILE_SIZE - wTop;
    if (sx < -16 || sx > 256 || sy < -16 || sy > 240) continue;
    ctx.drawImage(canvas, sx, sy);
  }
}

export function talkToNpc(npc) {
  if (!npc || !npc.dialogue || npc.dialogue.length === 0) return;
  let idx = 0;
  const showNext = () => {
    if (idx >= npc.dialogue.length) return;
    const line = _nameToBytes(npc.dialogue[idx++]);
    showMsgBox(line, showNext);
  };
  showNext();
}
