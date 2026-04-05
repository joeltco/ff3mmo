// Damage/heal number state, timing, and drawing — extracted from game.js + battle-drawing.js
// Owns all floating number lifecycle: create → tick → draw → clear.

import { drawText } from './font-renderer.js';
import { _dmgBounceY } from './data/animation-tables.js';

// ── Palettes ────────────────────────────────────────────────────────────────
export const DMG_NUM_PAL  = [0x0F, 0x0F, 0x0F, 0x25]; // red/orange damage
export const HEAL_NUM_PAL = [0x0F, 0x0F, 0x0F, 0x2B]; // green heal

// ── Duration ────────────────────────────────────────────────────────────────
export const DMG_SHOW_MS    = 550;  // standard display time
export const SW_DMG_SHOW_MS = 700;  // southwind display time

// ── State ───────────────────────────────────────────────────────────────────
// Each is null when inactive, or { value, timer, crit?, miss?, heal?, index? }
let enemyDmgNum     = null;  // player hits enemy
let playerDamageNum = null;  // enemy hits player
let playerHealNum   = null;  // heal on player portrait
let enemyHealNum    = null;  // heal on enemy {value, timer, index}
let allyDamageNums  = {};    // {allyIdx: {value, timer, crit?, miss?, heal?}}
let swDmgNums       = {};    // {targetIdx: {value, timer}} — magic item per-target

// ── Getters / setters ───────────────────────────────────────────────────────
export function getEnemyDmgNum()        { return enemyDmgNum; }
export function setEnemyDmgNum(v)       { enemyDmgNum = v; }
export function getPlayerDamageNum()    { return playerDamageNum; }
export function setPlayerDamageNum(v)   { playerDamageNum = v; }
export function getPlayerHealNum()      { return playerHealNum; }
export function setPlayerHealNum(v)     { playerHealNum = v; }
export function getEnemyHealNum()       { return enemyHealNum; }
export function setEnemyHealNum(v)      { enemyHealNum = v; }
export function getAllyDamageNums()      { return allyDamageNums; }
export function getSwDmgNums()          { return swDmgNums; }

// ── Creation helpers ────────────────────────────────────────────────────────
export function createDmg(value, crit)  { return { value, crit: !!crit, timer: 0 }; }
export function createMiss()            { return { miss: true, timer: 0 }; }
export function createHeal(value)       { return { value, timer: 0 }; }
export function createHealIdx(value, index) { return { value, timer: 0, index }; }
export function createAllyHeal(value)   { return { value, timer: 0, heal: true }; }

export function setSwDmgNum(tidx, value) {
  swDmgNums[tidx] = { value, timer: 0 };
}

// ── Reset (called at battle start) ─────────────────────────────────────────
export function resetAllDmgNums() {
  enemyDmgNum = null; playerDamageNum = null;
  playerHealNum = null; enemyHealNum = null;
  allyDamageNums = {}; swDmgNums = {};
}

// ── Timer ticks ─────────────────────────────────────────────────────────────
export function tickDmgNums(dt) {
  if (enemyDmgNum) {
    enemyDmgNum.timer += dt;
    if (enemyDmgNum.timer >= DMG_SHOW_MS) enemyDmgNum = null;
  }
  if (playerDamageNum) {
    playerDamageNum.timer += dt;
    if (playerDamageNum.timer >= DMG_SHOW_MS) playerDamageNum = null;
  }
  for (const idx in allyDamageNums) {
    if (allyDamageNums[idx]) {
      allyDamageNums[idx].timer += dt;
      if (allyDamageNums[idx].timer >= DMG_SHOW_MS) delete allyDamageNums[idx];
    }
  }
  for (const k of Object.keys(swDmgNums)) {
    swDmgNums[k].timer += dt;
    if (swDmgNums[k].timer >= SW_DMG_SHOW_MS) delete swDmgNums[k];
  }
}

export function tickHealNums(dt) {
  if (playerHealNum) {
    playerHealNum.timer += dt;
    if (playerHealNum.timer >= DMG_SHOW_MS) playerHealNum = null;
  }
  if (enemyHealNum) {
    enemyHealNum.timer += dt;
    if (enemyHealNum.timer >= DMG_SHOW_MS) enemyHealNum = null;
  }
}

export function clearHealNums() {
  playerHealNum = null;
  enemyHealNum = null;
}

// ── Miss sprite (PPU tile $61, 8×8, green with black outline) ───────────────
const MISS_TILE_RAW = new Uint8Array([
  0xAA,0x05,0x2A,0x81,0x0A,0x00,0x02,0x08,  // bitplane 0
  0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00   // bitplane 1
]);
// NES palette: $0F=black(transparent), $2B=green, $0F=black, $0F=black
// Color 0 = transparent, color 1 = green fill
import { NES_SYSTEM_PALETTE } from './tile-decoder.js';
let missCanvas = null;

export function initMissSprite() {
  const c = document.createElement('canvas');
  c.width = 8; c.height = 8;
  const cx = c.getContext('2d');
  const img = cx.createImageData(8, 8);
  const green = NES_SYSTEM_PALETTE[0x2B] || [124, 252, 0];
  const black = NES_SYSTEM_PALETTE[0x0F] || [0, 0, 0];
  for (let row = 0; row < 8; row++) {
    const bp0 = MISS_TILE_RAW[row];
    for (let col = 0; col < 8; col++) {
      const bit = 7 - col;
      const ci = (bp0 >> bit) & 1;
      const p = (row * 8 + col) * 4;
      if (ci === 1) {
        img.data[p] = green[0]; img.data[p+1] = green[1]; img.data[p+2] = green[2]; img.data[p+3] = 255;
      } else {
        img.data[p+3] = 0;
      }
    }
  }
  cx.putImageData(img, 0, 0);
  // Add black outline: draw shifted copies in black behind the green
  const outlined = document.createElement('canvas');
  outlined.width = 10; outlined.height = 10; // 1px border
  const ox = outlined.getContext('2d');
  // Black outline layer
  const bImg = ox.createImageData(8, 8);
  for (let row = 0; row < 8; row++) {
    const bp0 = MISS_TILE_RAW[row];
    for (let col = 0; col < 8; col++) {
      const bit = 7 - col;
      const ci = (bp0 >> bit) & 1;
      const p = (row * 8 + col) * 4;
      if (ci === 1) {
        bImg.data[p] = black[0]; bImg.data[p+1] = black[1]; bImg.data[p+2] = black[2]; bImg.data[p+3] = 255;
      }
    }
  }
  const bCanvas = document.createElement('canvas');
  bCanvas.width = 8; bCanvas.height = 8;
  bCanvas.getContext('2d').putImageData(bImg, 0, 0);
  // Draw black at 8 surrounding offsets for outline
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      ox.drawImage(bCanvas, 1 + dx, 1 + dy);
    }
  }
  // Green on top
  ox.drawImage(c, 1, 1);
  missCanvas = outlined;
}

export function getMissCanvas() { return missCanvas; }

// ── Drawing ─────────────────────────────────────────────────────────────────
export function drawBattleNum(ctx, bx, by, value, pal) {
  const digits = String(value);
  const b = new Uint8Array(digits.length);
  for (let i = 0; i < digits.length; i++) b[i] = 0x80 + parseInt(digits[i]);
  drawText(ctx, bx - Math.floor(digits.length * 4), by, b, pal);
}

export function dmgBounceY(baseY, timer) {
  return _dmgBounceY(baseY, timer);
}
