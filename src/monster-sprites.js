// Monster sprite module — renders & caches all monster battle sprites
// Replaces the old 3-sprite inline system with ROM-extracted data for 182 monsters.

import { NES_SYSTEM_PALETTE } from './tile-decoder.js';
import { _makeWhiteCanvas } from './canvas-utils.js';
import { MONSTER_REGISTRY, PALETTE_TABLE } from './data/monster-sprites-rom.js';

// ── State ──────────────────────────────────────────────────────────
const monsterBattleCanvas = new Map(); // monsterId → canvas
const monsterWhiteCanvas  = new Map(); // monsterId → white flash canvas
const monsterDeathFrames  = new Map(); // monsterId → death frame canvas[]

const DEATH_FRAMES = 16;
const BAYER4 = [
  [0, 8, 2, 10], [12, 4, 14, 6],
  [3, 11, 1, 9], [15, 7, 13, 5],
];

// ── Rendering ──────────────────────────────────────────────────────

/** Decode 2BPP tile bytes into a canvas */
function _renderSprite(rawBytes, cols, rows, pal0, pal1, tilePal) {
  const w = cols * 8, h = rows * 8;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cctx = c.getContext('2d');

  // NES PPU attribute table assigns palette per 16×16 block based on screen
  // position. Top 16px (2 tile rows) uses pal0, rest uses pal1.
  // Verified: Eye Fang (4×6) rows 0-1=pal0, 2-5=pal1. Goblin (4×4) rows 0-1=pal0, 2-3=pal1.
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const tileIdx = ty * cols + tx;
      const pal = tilePal ? (tilePal[tileIdx] === 1 ? pal1 : pal0) : (ty < 2 ? pal0 : pal1);
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

/** Generate dissolve death frames (Bayer dither wipe) */
function _makeDeathFrames(srcCanvas) {
  const { width: w, height: h } = srcCanvas;
  const origData = srcCanvas.getContext('2d').getImageData(0, 0, w, h);
  const maxThreshold = (w - 1) + (h - 1) + 15;
  const frames = [];
  for (let f = 0; f < DEATH_FRAMES; f++) {
    const fc = document.createElement('canvas'); fc.width = w; fc.height = h;
    const fctx = fc.getContext('2d');
    const fd = fctx.createImageData(w, h);
    const wave = (f / (DEATH_FRAMES - 1)) * (maxThreshold + 1);
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const idx = (py * w + px) * 4;
        const threshold = (w - 1 - px) + py + BAYER4[py & 3][px & 3];
        if (threshold < wave) {
          fd.data[idx + 3] = 0;
        } else {
          fd.data[idx]     = origData.data[idx];
          fd.data[idx + 1] = origData.data[idx + 1];
          fd.data[idx + 2] = origData.data[idx + 2];
          fd.data[idx + 3] = origData.data[idx + 3];
        }
      }
    }
    fctx.putImageData(fd, 0, 0);
    frames.push(fc);
  }
  return frames;
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Battle canvas for one monster, built on first ask and cached.
 *
 * Nothing here needs the ROM — MONSTER_REGISTRY and PALETTE_TABLE are both
 * baked data — but the only thing that used to build these was
 * initMonsterSprites(), which runs from initSpriteAssets() and therefore only
 * after the player has supplied an FF3 ROM. Any caller that legitimately wants
 * a monster sprite outside a booted game (the BESTIARY debug tab) got nothing.
 * Exposing the per-monster build lets those callers render through this exact
 * function instead of growing a second decoder that could disagree with what
 * the battle screen paints.
 */
export function buildMonsterCanvas(monsterId) {
  const cached = monsterBattleCanvas.get(monsterId);
  if (cached) return cached;
  const entry = MONSTER_REGISTRY.get(monsterId);
  if (!entry) return null;
  // pal0Raw / pal1Raw override the PALETTE_TABLE lookup — used for monsters
  // whose real in-battle colors come from the sprite palette (SP0/SP1) rather
  // than the BG palette table the extractor pulled from. Captured via SNAP OAM.
  const pal0 = entry.pal0Raw || PALETTE_TABLE[entry.pal0] || [0x0F, 0x00, 0x10, 0x20];
  const pal1 = entry.pal1Raw || PALETTE_TABLE[entry.pal1] || [0x0F, 0x00, 0x10, 0x20];
  const canvas = _renderSprite(entry.raw, entry.cols, entry.rows, pal0, pal1, entry.tilePal);
  monsterBattleCanvas.set(monsterId, canvas);
  return canvas;
}

/** Initialize all monster sprites from ROM-extracted data. Call once after DOM ready. */
export function initMonsterSprites() {
  for (const monsterId of MONSTER_REGISTRY.keys()) {
    const canvas = buildMonsterCanvas(monsterId);
    monsterWhiteCanvas.set(monsterId, _makeWhiteCanvas(canvas));
    monsterDeathFrames.set(monsterId, _makeDeathFrames(canvas));
  }
}

/** Get the battle canvas for a monster. Falls back to fallback if not found. */
export function getMonsterCanvas(monsterId, fallback) {
  return monsterBattleCanvas.get(monsterId) || fallback;
}

/** Get the white flash canvas for a monster. Falls back to fallback. */
export function getMonsterWhiteCanvas(monsterId, fallback) {
  return monsterWhiteCanvas.get(monsterId) || fallback;
}

/** Get the death frame array for a monster. Falls back to fallback. */
export function getMonsterDeathFrames(monsterId, fallback) {
  return monsterDeathFrames.get(monsterId) || fallback;
}

/** Check if any sprites are loaded (for early-exit guards). */
export function hasMonsterSprites() {
  return monsterBattleCanvas.size > 0;
}
