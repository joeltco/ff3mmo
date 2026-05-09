// Damage/heal number state, timing, and drawing — extracted from game.js + battle-drawing.js
// Owns all floating number lifecycle: create → tick → draw → clear.

import { _dmgBounceY } from './data/animation-tables.js';
import { NES_SYSTEM_PALETTE } from './tile-decoder.js';

// ── Palettes ────────────────────────────────────────────────────────────────
// 4-entry NES master palette: [transparent, outline, fill, unused].
// Battle-digit sprite tiles ($56-$5F) use color index 1 for outline, 2 for fill;
// matches the SP3 palette FF3 sets at PPU $3F1D ([0x0F, 0x0F, 0x25, *]) seen in
// the OAM REC capture (2026-05-07). Heal swaps the fill color.
export const DMG_NUM_PAL  = [0x0F, 0x0F, 0x25, 0x0F]; // red/pink damage (also used for crits — flag drives SFX + flash, not color)
export const HEAL_NUM_PAL = [0x0F, 0x0F, 0x2B, 0x0F]; // green heal

// ── Duration ────────────────────────────────────────────────────────────────
// Damage number lifecycle: bounce → stick → clear.
//   - DMG_BOUNCE_MS — matches DMG_BOUNCE_TABLE (33 frames @ 16.67ms).
//     The number arcs up, settles back, and ends at the last bounce-table
//     frame (+6 px below baseline).
//   - DMG_STICK_MS — hold the settled number visible AFTER the bounce so
//     the player has a clear "this is the damage" beat before the next turn
//     / death wipe takes over. `_dmgBounceY` clamps `frame` to the last
//     table entry, so during stick the number renders motionless at +6.
//   - DMG_SHOW_MS — bounce + stick. Number cleared after this.
export const DMG_BOUNCE_MS  = 550;
export const DMG_STICK_MS   = 200;
export const DMG_SHOW_MS    = DMG_BOUNCE_MS + DMG_STICK_MS;  // 750
export const SW_DMG_SHOW_MS = DMG_SHOW_MS;                    // unified

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

export function setSwDmgNum(tidx, value, opts = {}) {
  swDmgNums[tidx] = { value, timer: 0, miss: !!opts.miss };
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

// ── Battle damage digit sprites ────────────────────────────────────────────
// 10 8x8 tiles for digits 0-9 — extracted from the FF3J ROM at offset 0x1B170
// (sprite bank tile slots $56-$5F at battle time, verified by signature-
// matching tiles $5B/$5C against an OAM REC capture). NES FF3 uses these
// dedicated chunky digit sprites for damage/heal popups instead of the regular
// text-font digits ($80-$89), which are skinnier.
export const BATTLE_DIGIT_TILES = [
  new Uint8Array([0x3C,0x42,0x99,0x99,0x99,0x99,0x42,0x3C,0x00,0x3C,0x66,0x66,0x66,0x66,0x3C,0x00]), // 0
  new Uint8Array([0x18,0x24,0x44,0x24,0x24,0x24,0x42,0x3C,0x00,0x18,0x38,0x18,0x18,0x18,0x3C,0x00]), // 1
  new Uint8Array([0x3C,0x42,0x99,0x99,0x72,0x66,0x81,0x7E,0x00,0x3C,0x66,0x66,0x0C,0x18,0x7E,0x00]), // 2
  new Uint8Array([0x3C,0x42,0x99,0x72,0x79,0x99,0x42,0x3C,0x00,0x3C,0x66,0x0C,0x06,0x66,0x3C,0x00]), // 3
  new Uint8Array([0x0C,0x12,0x22,0x52,0xB2,0x81,0x72,0x0C,0x00,0x0C,0x1C,0x2C,0x4C,0x7E,0x0C,0x00]), // 4
  new Uint8Array([0x7E,0x81,0x9E,0x82,0x79,0x99,0x42,0x3C,0x00,0x7E,0x60,0x7C,0x06,0x66,0x3C,0x00]), // 5
  new Uint8Array([0x3C,0x42,0x9F,0x82,0x99,0x99,0x42,0x3C,0x00,0x3C,0x60,0x7C,0x66,0x66,0x3C,0x00]), // 6
  new Uint8Array([0x7E,0x81,0x99,0x79,0x12,0x24,0x48,0x30,0x00,0x7E,0x66,0x06,0x0C,0x18,0x30,0x00]), // 7
  new Uint8Array([0x3C,0x42,0x99,0x42,0x99,0x99,0x42,0x3C,0x00,0x3C,0x66,0x3C,0x66,0x66,0x3C,0x00]), // 8
  new Uint8Array([0x3C,0x42,0x99,0x99,0x41,0x39,0x42,0x3C,0x00,0x3C,0x66,0x66,0x3E,0x06,0x3C,0x00]), // 9
];

// Per-palette canvas cache. Key = palette.join(','); value = array of 10 8×8
// canvases (one per digit). Built lazily on first use.
const _digitCanvasCache = new Map();

function _buildDigitCanvas(tileBytes, palette) {
  const c = document.createElement('canvas');
  c.width = 8; c.height = 8;
  const cx = c.getContext('2d');
  const img = cx.createImageData(8, 8);
  for (let r = 0; r < 8; r++) {
    const bp0 = tileBytes[r], bp1 = tileBytes[r + 8];
    for (let col = 0; col < 8; col++) {
      const bit = 7 - col;
      const ci = ((bp0 >> bit) & 1) | (((bp1 >> bit) & 1) << 1);
      const p = (r * 8 + col) * 4;
      if (ci === 0) { img.data[p+3] = 0; continue; }
      const palVal = palette[ci];
      const rgb = NES_SYSTEM_PALETTE[palVal] || [255, 0, 255];
      img.data[p] = rgb[0]; img.data[p+1] = rgb[1]; img.data[p+2] = rgb[2]; img.data[p+3] = 255;
    }
  }
  cx.putImageData(img, 0, 0);
  return c;
}

function _getDigitCanvases(palette) {
  const key = palette.join(',');
  let set = _digitCanvasCache.get(key);
  if (!set) {
    set = BATTLE_DIGIT_TILES.map(t => _buildDigitCanvas(t, palette));
    _digitCanvasCache.set(key, set);
  }
  return set;
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
// Zero-value popups are suppressed: status-cure spells (Poisona, Bndna, etc.)
// and cure-status items (Antidote, Eye Drops, etc.) push `value: 0` heal-nums
// purely to drive the sparkle anim + state-machine timing — there's no actual
// HP delta to display. Same for full-HP cure overheal where amount caps at 0.
// Sparkle renders are gated on heal-num *existence*, not value, so they're
// unaffected. Damage 0 is also covered (a numeric 0 dmg has no useful read).
//
// Renders via cached 8x8 canvases per (digit × palette) — chunky FF3J digit
// sprites ($56-$5F), not the skinnier text-font digits.
export function drawBattleNum(ctx, bx, by, value, pal) {
  if (value === 0) return;
  const digits = String(value);
  const x0 = bx - Math.floor(digits.length * 4);
  const set = _getDigitCanvases(pal);
  for (let i = 0; i < digits.length; i++) {
    ctx.drawImage(set[parseInt(digits[i])], x0 + i * 8, by);
  }
}

export function dmgBounceY(baseY, timer) {
  return _dmgBounceY(baseY, timer);
}
