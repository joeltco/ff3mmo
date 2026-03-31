// Boss sprite module — renders boss battle sprites on demand
// Boss sprites are loaded lazily when a boss fight starts, not at init.
//
// Cat 6 boss tiles: ROM stores 216 tiles (18×12) in PPU pattern memory.
// The NES nametable maps the first 36 tiles into a 6×6 grid (48×48px).
// Palette: encounter pal1 on top 4 tile rows, pal0 on bottom 2 rows
// (opposite of random encounters — verified against Land Turtle PPU data).

import { NES_SYSTEM_PALETTE } from './tile-decoder.js';
import { _makeWhiteCanvas } from './canvas-utils.js';
import { MONSTER_REGISTRY, PALETTE_TABLE } from './data/boss-sprites-rom.js';

// ── Constants ──────────────────────────────────────────────────────
const BOSS_COLS = 6;
const BOSS_ROWS = 6;
const BOSS_TILES = BOSS_COLS * BOSS_ROWS; // 36
const BOSS_PAL_SPLIT_ROW = 4; // top 4 rows use pal1, bottom 2 use pal0

// ── State ──────────────────────────────────────────────────────────
let bossBattleCanvas = null;
let bossWhiteCanvas  = null;
let currentBossId    = null;

// ── Rendering ──────────────────────────────────────────────────────

function _renderBossSprite(rawBytes, pal0, pal1) {
  const w = BOSS_COLS * 8, h = BOSS_ROWS * 8; // 48×48
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cctx = c.getContext('2d');

  // Only use first 36 tiles (6×6 grid) from the 216-tile boss data.
  // Palette: top 4 rows = pal1 (shell/head colors), bottom 2 = pal0 (legs/body).
  for (let ty = 0; ty < BOSS_ROWS; ty++) {
    const pal = ty < BOSS_PAL_SPLIT_ROW ? pal1 : pal0;
    for (let tx = 0; tx < BOSS_COLS; tx++) {
      const tileIdx = ty * BOSS_COLS + tx;
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

export function loadBossSprite(monsterId) {
  if (monsterId === currentBossId && bossBattleCanvas) {
    return { canvas: bossBattleCanvas, whiteCanvas: bossWhiteCanvas };
  }

  const entry = MONSTER_REGISTRY.get(monsterId);
  if (!entry) return null;

  const pal0 = PALETTE_TABLE[entry.pal0] || [0x0F, 0x00, 0x10, 0x20];
  const pal1 = PALETTE_TABLE[entry.pal1] || [0x0F, 0x00, 0x10, 0x20];
  bossBattleCanvas = _renderBossSprite(entry.raw, pal0, pal1);
  bossWhiteCanvas  = _makeWhiteCanvas(bossBattleCanvas);
  currentBossId    = monsterId;

  return { canvas: bossBattleCanvas, whiteCanvas: bossWhiteCanvas };
}

export function getBossBattleCanvas() { return bossBattleCanvas; }
export function getBossWhiteCanvas()  { return bossWhiteCanvas; }
export function hasBossSprite(monsterId) { return MONSTER_REGISTRY.has(monsterId); }

export function unloadBossSprite() {
  bossBattleCanvas = null;
  bossWhiteCanvas  = null;
  currentBossId    = null;
}
