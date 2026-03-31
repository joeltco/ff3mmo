// Boss sprite module — renders boss battle sprites on demand
// Boss sprites use cat 6 (18×12 tiles = 144×96px) with the interlaced
// dissolve transition (boss-appear / boss-dissolve states).
//
// Replaces the hardcoded Land Turtle rendering in game.js.
// Sprites are loaded lazily when a boss fight starts, not at init.

import { NES_SYSTEM_PALETTE } from './tile-decoder.js';
import { _makeWhiteCanvas } from './canvas-utils.js';
import { MONSTER_REGISTRY, PALETTE_TABLE } from './data/boss-sprites-rom.js';

// ── State ──────────────────────────────────────────────────────────
let bossBattleCanvas = null;  // current boss sprite canvas
let bossWhiteCanvas  = null;  // white flash version
let currentBossId    = null;  // which boss is loaded

// ── Rendering ──────────────────────────────────────────────────────

/** Decode 2BPP tile bytes into a canvas (same as monster-sprites.js) */
function _renderSprite(rawBytes, cols, rows, pal0, pal1) {
  const w = cols * 8, h = rows * 8;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cctx = c.getContext('2d');

  const blockRows = rows >> 1;
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const tileIdx = ty * cols + tx;
      const blockRow = ty >> 1;
      const pal = (blockRows <= 2 || blockRow === 0) ? pal0 : pal1;
      const off = tileIdx * 16;
      const img = cctx.createImageData(8, 8);
      for (let row = 0; row < 8; row++) {
        const bp0 = rawBytes[off + row];
        const bp1 = rawBytes[off + row + 8];
        for (let col = 0; col < 8; col++) {
          const bit = 7 - col;
          const ci = (((bp1 >> bit) & 1) << 1) | ((bp0 >> bit) & 1);
          const p = (row * 8 + col) * 4;
          if (ci === 0) {
            img.data[p + 3] = 0;
          } else {
            const rgb = NES_SYSTEM_PALETTE[pal[ci]] || [0, 0, 0];
            img.data[p]     = rgb[0];
            img.data[p + 1] = rgb[1];
            img.data[p + 2] = rgb[2];
            img.data[p + 3] = 255;
          }
        }
      }
      cctx.putImageData(img, tx * 8, ty * 8);
    }
  }
  return c;
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Load a boss sprite by monster ID. Call when a boss fight starts.
 * Returns { canvas, whiteCanvas } or null if not in registry.
 */
export function loadBossSprite(monsterId) {
  if (monsterId === currentBossId && bossBattleCanvas) {
    return { canvas: bossBattleCanvas, whiteCanvas: bossWhiteCanvas };
  }

  const entry = MONSTER_REGISTRY.get(monsterId);
  if (!entry) return null;

  const pal0 = PALETTE_TABLE[entry.pal0] || [0x0F, 0x00, 0x10, 0x20];
  const pal1 = PALETTE_TABLE[entry.pal1] || [0x0F, 0x00, 0x10, 0x20];
  bossBattleCanvas = _renderSprite(entry.raw, entry.cols, entry.rows, pal0, pal1);
  bossWhiteCanvas  = _makeWhiteCanvas(bossBattleCanvas);
  currentBossId    = monsterId;

  return { canvas: bossBattleCanvas, whiteCanvas: bossWhiteCanvas };
}

/** Get the current boss battle canvas (after loadBossSprite). */
export function getBossBattleCanvas() {
  return bossBattleCanvas;
}

/** Get the current boss white flash canvas. */
export function getBossWhiteCanvas() {
  return bossWhiteCanvas;
}

/** Check if a boss sprite is available in the registry. */
export function hasBossSprite(monsterId) {
  return MONSTER_REGISTRY.has(monsterId);
}

/** Clear cached boss sprite (e.g. when returning to overworld). */
export function unloadBossSprite() {
  bossBattleCanvas = null;
  bossWhiteCanvas  = null;
  currentBossId    = null;
}
