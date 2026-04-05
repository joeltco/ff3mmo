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
