// NPC runtime — list of active NPCs on the current map, sprite render,
// tile-based interaction lookup. Currently houses the moogle on Altar Cave
// floor 1 (the first non-ROM NPC). The same module will hold ROM-anchored
// NPCs (Ur villagers etc.) once those are wired up.

import { _makeCanvas16 } from './canvas-utils.js';
import { getMoogleFrames, getMoogleRgbPalette } from './data/moogle-sprite.js';
import { NPCS } from './data/npcs.js';
import { showMsgBox } from './message-box.js';
import { _nameToBytes } from './text-utils.js';

const TILE_SIZE = 16;
// Bob period in ms — gives a slow walk-in-place. 2 frames so total cycle = 2x.
const NPC_BOB_MS = 400;

// One entry per NPC currently on the map. Keys:
//   key      — string id (matches dialogue catalog)
//   tileX/tileY — tile coords
//   frames   — [canvas, canvas, ...] pre-rendered 16×16 frames
//   dialogue — array of message strings (one per Z-advance, future use)
let _npcs = [];

// ── Sprite cache (built once per session) ──────────────────────────────────
let _moogleFrames = null;

function _buildMoogleFrames() {
  if (_moogleFrames) return _moogleFrames;
  const rgb = getMoogleRgbPalette();
  const rawFrames = getMoogleFrames();
  const out = [];
  for (const tiles of rawFrames) {
    const c = _makeCanvas16();
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(16, 16);
    const d = img.data;
    const positions = [[0, 0], [8, 0], [0, 8], [8, 8]];
    for (let q = 0; q < 4; q++) {
      const tile = tiles[q];
      const [ox, oy] = positions[q];
      for (let py = 0; py < 8; py++) {
        for (let px = 0; px < 8; px++) {
          const ci = tile[py * 8 + px];
          const di = ((oy + py) * 16 + (ox + px)) * 4;
          if (ci === 0 || !rgb[ci]) { d[di + 3] = 0; continue; }
          d[di]     = rgb[ci][0];
          d[di + 1] = rgb[ci][1];
          d[di + 2] = rgb[ci][2];
          d[di + 3] = 255;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    out.push(c);
  }
  _moogleFrames = out;
  return out;
}

// ── Public API ─────────────────────────────────────────────────────────────

export function clearNpcs() { _npcs = []; }

// Place a moogle at the given tile, pulling dialogue from the NPC catalog.
export function addMoogle(tileX, tileY) {
  const entry = NPCS.get('altar_moogle');
  _npcs.push({
    key: 'altar_moogle',
    tileX,
    tileY,
    frames: _buildMoogleFrames(),
    dialogue: (entry && entry.dialogue) || [],
  });
}

// Find a walkable floor tile near the geometric center of the dungeon floor
// and place the moogle there. Spirals outward from (16, 10) — the candidate
// tile must be FLOOR with at least 3 walkable neighbors so we never land on
// a 1-wide chokepoint and block the player's path through the cave.
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

// Walk through an NPC's dialogue array, one message-box per Z-advance. The
// onClose hook chains the next page until the array is exhausted.
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

export function getNpcs() { return _npcs; }

export function findNpcAt(tileX, tileY) {
  for (const npc of _npcs) {
    if (npc.tileX === tileX && npc.tileY === tileY) return npc;
  }
  return null;
}

// Pick the frame to show right now. Time-based, no per-NPC state needed yet.
export function getNpcFrameIdx() {
  return Math.floor(performance.now() / NPC_BOB_MS) & 1;
}

// Draw every NPC on the current map. Called from the world-render pass after
// flame sprites and before the player sprite — same layering as the boss.
export function drawNpcs(ctx, camX, camY, originX, originY) {
  if (_npcs.length === 0) return;
  const frameIdx = getNpcFrameIdx();
  const wLeft = camX - originX;
  const wTop = camY - originY;
  for (const npc of _npcs) {
    const sx = npc.tileX * TILE_SIZE - wLeft;
    const sy = npc.tileY * TILE_SIZE - wTop;
    if (sx < -16 || sx > 256 || sy < -16 || sy > 240) continue;
    ctx.drawImage(npc.frames[frameIdx], sx, sy);
  }
}
