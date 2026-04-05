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

// ── Miss sprite — 2 tiles (16×8) from ROM $1B4D0 "MI" + $1B4E0 "SS" ────────
// Color 0=transparent, 1=outline(black), 3=fill(green)
const MISS_TILE_0 = new Uint8Array([ // "MI"
  0x00,0x4a,0xff,0xff,0xff,0xff,0xff,0x4a, // bp0
  0x00,0x00,0x4a,0x7a,0x4a,0x4a,0x4a,0x00  // bp1
]);
const MISS_TILE_1 = new Uint8Array([ // "SS"
  0x00,0x66,0xff,0xff,0xff,0xff,0xfe,0xcc, // bp0
  0x00,0x00,0x66,0x88,0xee,0x22,0xcc,0x00  // bp1
]);
import { NES_SYSTEM_PALETTE } from './tile-decoder.js';
let missCanvas = null;

export function initMissSprite() {
  const c = document.createElement('canvas');
  c.width = 16; c.height = 8;
  const cx = c.getContext('2d');
  const img = cx.createImageData(16, 8);
  const green = NES_SYSTEM_PALETTE[0x2B] || [124, 252, 0];
  const black = NES_SYSTEM_PALETTE[0x0F] || [0, 0, 0];
  const tiles = [MISS_TILE_0, MISS_TILE_1];
  for (let t = 0; t < 2; t++) {
    const tile = tiles[t];
    for (let row = 0; row < 8; row++) {
      const bp0 = tile[row], bp1 = tile[row + 8];
      for (let col = 0; col < 8; col++) {
        const bit = 7 - col;
        const ci = ((bp0 >> bit) & 1) | (((bp1 >> bit) & 1) << 1);
        const px = t * 8 + col;
        const p = (row * 16 + px) * 4;
        if (ci === 3) {
          img.data[p] = green[0]; img.data[p+1] = green[1]; img.data[p+2] = green[2]; img.data[p+3] = 255;
        } else if (ci === 1) {
          img.data[p] = black[0]; img.data[p+1] = black[1]; img.data[p+2] = black[2]; img.data[p+3] = 255;
        } else {
          img.data[p+3] = 0;
        }
      }
    }
  }
  cx.putImageData(img, 0, 0);
  missCanvas = c;
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
