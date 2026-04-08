// title-screen.js — title screen state, rendering, and player select screen

import { drawText, measureText, TEXT_WHITE } from './font-renderer.js';
import { nesColorFade, _makeFadedPal } from './palette.js';
import { _nameToBytes, drawLvHpRow } from './text-utils.js';
import { selectCursor, saveSlots, nameBuffer, NAME_MAX_LEN,
         setSelectCursor, setNameBuffer, saveSlotsToDB } from './save-state.js';
import { playSFX, SFX } from './music.js';
import { serverDeleteSlot } from './save.js';

// ── NES layout constants — must match game.js ─────────────────────────────
const CANVAS_W   = 256;
const HUD_TOP_H  = 32;
const HUD_VIEW_X = 0;
const HUD_VIEW_Y = 32;
const HUD_VIEW_W = 144;
const HUD_VIEW_H = 144;

// ── Title constants ────────────────────────────────────────────────────────
const TITLE_FADE_MAX       = 4;
const TITLE_FADE_STEP_MS   = 100;
const TITLE_FADE_MS        = (TITLE_FADE_MAX + 1) * TITLE_FADE_STEP_MS;
const TITLE_HOLD_MS        = 2000;
const TITLE_WAIT_MS        = 0;
const TITLE_ZBOX_MS        = 200;
const TITLE_TRANSITION_MS  = 800;
const SHIP_DRIFT_PX        = 56;
const SHIP_WINDUP_PX       = 20;

// Spring physics for ship drift
const SHIP_SPRING_K        = 0.0008;  // spring stiffness (force per px per ms²)
const SHIP_SPRING_DAMP     = 0.020;   // damping — overdamped, no overshoot
const SHIP_SPRING_NUDGE    = 0.003;   // gentle wind nudge strength (px/ms²)
const SELECT_BOX_OFFSET_X  = 48;
const TITLE_SHIP_ANIM_MS   = 100;
const TITLE_SHADOW_ANIM_MS = 50;
export const SELECT_TEXT_STEPS    = 4;
export const SELECT_TEXT_STEP_MS  = 100;
export const BOSS_BOX_EXPAND_MS   = 300;
const LOAD_FADE_MAX        = 4;
const SEL_ROW_H            = 32;  // same as roster rows

// Draw a box using title-screen transparent border tiles (no black outer edge)
function _drawTitleBox(ctx, x, y, w, h, fadeStep) {
  const ts = titleSt;
  const tBorderSet = (ts.borderFadeSets && fadeStep > 0) ? ts.borderFadeSets[Math.min(fadeStep, LOAD_FADE_MAX)] : ts.borderTiles;
  if (!tBorderSet) return;
  const [TL, TOP, TR, LEFT, RIGHT, BL, BOT, BR] = tBorderSet;
  ctx.fillStyle = '#000';
  ctx.fillRect(x + 8, y + 8, w - 16, h - 16);
  ctx.drawImage(TL, x, y); ctx.drawImage(TR, x + w - 8, y);
  ctx.drawImage(BL, x, y + h - 8); ctx.drawImage(BR, x + w - 8, y + h - 8);
  for (let tx = x + 8; tx < x + w - 8; tx += 8) { ctx.drawImage(TOP, tx, y); ctx.drawImage(BOT, tx, y + h - 8); }
  for (let ty = y + 8; ty < y + h - 8; ty += 8) { ctx.drawImage(LEFT, x, ty); ctx.drawImage(RIGHT, x + w - 8, ty); }
}
const SEL_W                = 112; // same width as roster panel
// NAME_MAX_LEN → imported from save-state.js

// ── Text byte arrays (NES encoding) ───────────────────────────────────────
const TITLE_CREDIT_1  = new Uint8Array([0x8A,0xFF,0xCF,0xCA,0xD7,0xFF,0xD0,0xCA,0xD6,0xCE]);
const TITLE_CREDIT_2  = new Uint8Array([0xD6,0xCA,0xCD,0xCE,0xFF,0xCB,0xE2]);
const TITLE_CREDIT_3  = new Uint8Array([0x93,0xD8,0xCE,0xD5,0xDD,0x8C,0xD8]);
const TITLE_DISCLAIM_1 = new Uint8Array([0x8A,0xD5,0xD5,0xFF,0xCC,0xD1,0xCA,0xDB,0xCA,0xCC,0xDD,0xCE,0xDB,0xDC]);
const TITLE_DISCLAIM_2 = new Uint8Array([0xCA,0xD7,0xCD,0xFF,0xD6,0xDE,0xDC,0xD2,0xCC,0xFF,0xCA,0xDB,0xCE]);
const TITLE_DISCLAIM_3 = new Uint8Array([0xD9,0xDB,0xD8,0xD9,0xCE,0xDB,0xDD,0xE2,0xFF,0xD8,0xCF]);
const TITLE_DISCLAIM_4 = new Uint8Array([0x9C,0x9A,0x9E,0x8A,0x9B,0x8E,0xFF,0x8E,0x97,0x92,0xA1]);
const TITLE_DISCLAIM_5 = new Uint8Array([0x97,0xD8,0xFF,0xCA,0xCF,0xCF,0xD2,0xD5,0xD2,0xCA,0xDD,0xD2,0xD8,0xD7]);
const TITLE_MMORPG    = new Uint8Array([0x96,0x96,0x98,0x9B,0x99,0x90]);
const SELECT_TITLE    = new Uint8Array([0x99,0xD5,0xCA,0xE2,0xCE,0xDB,0xFF,0x9C,0xCE,0xD5,0xCE,0xCC,0xDD]);
const SELECT_SLOT_TEXT   = new Uint8Array([0x97,0xCE,0xE0,0xFF,0x90,0xCA,0xD6,0xCE]);
const SELECT_DELETE_TEXT = new Uint8Array([0x8D,0xCE,0xD5,0xCE,0xDD,0xCE]);

// ── Mutable state (exported so game.js can read/write directly) ────────────
export const titleSt = {
  state:             'credit-wait',
  timer:             0,
  waterScroll:       0,
  underwaterScroll:  0,
  shipTimer:         0,
  shipDriftTimer:    0,     // legacy — kept for shipTimer frame calc
  shipPosX:          0,     // current X offset from anchor (spring physics)
  shipVelX:          0,     // current X velocity (px/ms)
  deleteMode:        false,

  // Sprite caches — populated after init
  oceanFrames:      null,  // [fadeLevel] 256×32 canvases
  waterFrames:      null,  // [16] 16×16 animated water tiles
  waterFadeTiles:   null,  // [TITLE_FADE_MAX+1] static faded water tiles
  skyFrames:        null,  // [fadeLevel] 256×32 sky strips
  underwaterFrames: null,  // [fadeLevel] 256×32 underwater BG
  logoFrames:       null,  // [TITLE_FADE_MAX+1] FF3 logo canvases
  shipFadeFrames:   null,  // [fadeLevel][frame] Invincible ship canvases
  shadowFade:       null,  // [fadeLevel] 32×8 shadow canvases
  bubbleTiles:      null,  // decoded bubble/fish sprite canvases
  cascadeCanvas:    null,  // reusable 16×16 scratch for water rows

  // Border tiles — set from game.js after HUD init
  borderTiles:      null,
  borderFadeSets:   null,

  // Underwater animation
  bubbles:          [],
  fish:             null,
  fishTriggered:    false,

  // Press Z text — set from game.js at startup (depends on isMobile)
  pressZ: null,
};

// ── Pure helpers ───────────────────────────────────────────────────────────

export function isTitleActiveState() {
  const s = titleSt.state;
  return s === 'main-in' || s === 'logo-content-in' || s === 'logo-content-in-back' ||
    s === 'pressz-fade-in' || s === 'main' || s === 'logo-content-out' ||
    s === 'to-select' || s === 'to-main' ||
    s === 'select-fade-in' || s === 'select' || s === 'select-fade-out' ||
    s === 'select-fade-out-back' || s === 'name-entry' || s === 'main-out';
}

export function titleFadeLevel(state, timer) {
  if (state.endsWith('-in')) {
    const step = Math.min(Math.floor(timer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
    return TITLE_FADE_MAX - step;
  } else if (state.endsWith('-out')) {
    return Math.min(Math.floor(timer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
  } else if (state.endsWith('-hold')) {
    return 0;
  }
  return TITLE_FADE_MAX;
}

export function titleFadePal(fadeLevel) {
  return TEXT_WHITE.map((c, i) => {
    if (i === 0) return c;
    let fc = c;
    for (let s = 0; s < fadeLevel; s++) fc = nesColorFade(fc);
    return fc;
  });
}

// ── Draw functions ─────────────────────────────────────────────────────────

export function drawTitleOcean(ctx, fadeLevel) {
  const ts = titleSt;
  if (!ts.oceanFrames || ts.oceanFrames.length === 0) return;
  const oceanCanvas = ts.oceanFrames[Math.min(fadeLevel, ts.oceanFrames.length - 1)];
  ctx.save();
  ctx.beginPath(); ctx.rect(HUD_VIEW_X, HUD_VIEW_Y, CANVAS_W, 32); ctx.clip();
  for (let row = 0; row < 2; row++) {
    const speed  = _titleParallaxSpeed(2 + row);
    const scrollX = Math.floor(ts.waterScroll * speed) % 256;
    const y = HUD_VIEW_Y + row * 16;
    ctx.drawImage(oceanCanvas, 0, row * 16, 256, 16, -scrollX, y, 256, 16);
    ctx.drawImage(oceanCanvas, 0, row * 16, 256, 16, -scrollX + 256, y, 256, 16);
  }
  ctx.restore();
}

export function drawTitleWater(ctx, fadeLevel, waterTick) {
  const ts = titleSt;
  if (!ts.waterFrames) return;
  const twW = CANVAS_W; const waterTop = HUD_VIEW_Y + 32;
  ctx.save(); ctx.beginPath(); ctx.rect(HUD_VIEW_X, waterTop, twW, HUD_VIEW_H - 32); ctx.clip();
  if (fadeLevel > 0 && ts.waterFadeTiles) {
    _drawTitleWaterRows(ctx, waterTop, twW, ts.waterFadeTiles[Math.min(fadeLevel, ts.waterFadeTiles.length - 1)]);
  } else {
    const hShift = Math.floor(waterTick / 8) % 16, hPrev = (hShift + 15) % 16, subRow = waterTick % 8;
    if (!ts.cascadeCanvas) {
      ts.cascadeCanvas = document.createElement('canvas'); ts.cascadeCanvas.width = 16; ts.cascadeCanvas.height = 16;
    }
    const cctx = ts.cascadeCanvas.getContext('2d');
    cctx.drawImage(ts.waterFrames[hPrev], 0, 0);
    const h = subRow + 1;
    cctx.drawImage(ts.waterFrames[hShift], 0, 0, 16, h, 0, 0, 16, h);
    cctx.drawImage(ts.waterFrames[hShift], 0, 8, 16, h, 0, 8, 16, h);
    _drawTitleWaterRows(ctx, waterTop, twW, ts.cascadeCanvas);
  }
  ctx.restore();
}

export function drawTitleSky(ctx, fadeLevel) {
  const ts = titleSt;
  if (!ts.skyFrames || ts.skyFrames.length === 0) return;
  const skyCanvas = ts.skyFrames[Math.min(fadeLevel, ts.skyFrames.length - 1)];
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, CANVAS_W, HUD_TOP_H); ctx.clip();
  for (let row = 0; row < 2; row++) {
    const speed  = _titleParallaxSpeed(row);
    const scrollX = Math.floor(ts.waterScroll * speed) % 256;
    const y = row * 16;
    ctx.drawImage(skyCanvas, 0, row * 16, 256, 16, -scrollX, y, 256, 16);
    ctx.drawImage(skyCanvas, 0, row * 16, 256, 16, -scrollX + 256, y, 256, 16);
  }
  ctx.restore();
}

export function drawTitleUnderwater(ctx, fadeLevel) {
  const ts = titleSt;
  if (!ts.underwaterFrames || ts.underwaterFrames.length === 0) return;
  const uwCanvas = ts.underwaterFrames[Math.min(fadeLevel, ts.underwaterFrames.length - 1)];
  const scrollX = Math.floor(ts.underwaterScroll) % 256;
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, CANVAS_W, HUD_TOP_H); ctx.clip();
  ctx.drawImage(uwCanvas, -scrollX, 0);
  ctx.drawImage(uwCanvas, -scrollX + 256, 0);
  ctx.restore();
}

export function drawUnderwaterSprites(ctx) {
  const ts = titleSt;
  if (!ts.bubbleTiles) return;
  ctx.save();
  ctx.beginPath(); ctx.rect(HUD_VIEW_X, HUD_VIEW_Y, CANVAS_W, HUD_VIEW_H); ctx.clip();
  for (const b of ts.bubbles) {
    const zigX = Math.sin(b.zigPhase + b.timer / 1000 * b.zigSpeed) * b.zigAmp;
    ctx.drawImage(ts.bubbleTiles[0], Math.round(b.x + zigX), Math.round(HUD_VIEW_Y + b.y));
  }
  if (ts.fish) {
    const frame = Math.floor(ts.fish.timer / 200) % 2;
    const zigY = Math.sin(ts.fish.zigPhase + ts.fish.timer / 1000 * ts.fish.zigSpeed) * ts.fish.zigAmp;
    ctx.drawImage(ts.bubbleTiles[1 + frame], Math.round(ts.fish.x), Math.round(HUD_VIEW_Y + ts.fish.y + zigY));
  }
  ctx.restore();
}

export function drawTitleSkyInHUD(ctx, roundTopBoxCornersFn) {
  const ts = titleSt;
  if (ts.state === 'main-in') {
    const fl = TITLE_FADE_MAX - Math.min(Math.floor(ts.timer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
    drawTitleSky(ctx, fl); roundTopBoxCornersFn();
  } else if (ts.state === 'logo-content-in' || ts.state === 'logo-content-in-back' ||
             ts.state === 'pressz-fade-in' || ts.state === 'main' || ts.state === 'logo-content-out' ||
             ts.state === 'to-select' || ts.state === 'to-main' ||
             ts.state === 'select-fade-in' || ts.state === 'select' || ts.state === 'select-fade-out' ||
             ts.state === 'select-fade-out-back' || ts.state === 'name-entry') {
    drawTitleSky(ctx, 0); roundTopBoxCornersFn();
  } else if (ts.state === 'main-out') {
    const fl = Math.min(Math.floor(ts.timer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
    drawTitleSky(ctx, fl); roundTopBoxCornersFn();
  } else if (ts.state === 'disclaim-out') {
    const fl = Math.min(Math.floor(ts.timer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
    drawTitleUnderwater(ctx, fl); roundTopBoxCornersFn();
  } else if (ts.state === 'credit-wait') {
    const fl = TITLE_FADE_MAX - Math.min(Math.floor(ts.timer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
    drawTitleUnderwater(ctx, fl); roundTopBoxCornersFn();
  } else {
    drawTitleUnderwater(ctx, 0); roundTopBoxCornersFn();
  }
}

export function drawTitle(ctx, shared) {
  const ts  = titleSt;
  const TVW = CANVAS_W;
  ctx.fillStyle = '#000';
  ctx.fillRect(HUD_VIEW_X, HUD_VIEW_Y, TVW, HUD_VIEW_H);
  ctx.fillRect(0, 0, CANVAS_W, HUD_TOP_H);

  const cx    = HUD_VIEW_X + TVW / 2;
  const cy    = HUD_VIEW_Y + HUD_VIEW_H / 2;
  const vpBot = HUD_VIEW_Y + HUD_VIEW_H;

  _drawTitleCredit(ctx, cx, cy);

  if (ts.state === 'credit-wait' || ts.state === 'credit-in' || ts.state === 'credit-hold' || ts.state === 'credit-out' ||
      ts.state === 'disclaim-wait' || ts.state === 'disclaim-in' || ts.state === 'disclaim-hold' || ts.state === 'disclaim-out') {
    drawUnderwaterSprites(ctx);
  }

  if (isTitleActiveState()) {
    let fl = 0;
    if (ts.state === 'main-in') fl = TITLE_FADE_MAX - Math.min(Math.floor(ts.timer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
    else if (ts.state === 'main-out') fl = Math.min(Math.floor(ts.timer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);

    const isSelectState = ts.state === 'to-main' ||
      ts.state === 'select-fade-in' || ts.state === 'select' ||
      ts.state === 'select-fade-out' || ts.state === 'select-fade-out-back' || ts.state === 'name-entry';

    ctx.save();
    ctx.beginPath(); ctx.rect(HUD_VIEW_X + 8, HUD_VIEW_Y + 8, TVW - 16, HUD_VIEW_H - 16); ctx.clip();
    drawTitleOcean(ctx, fl);
    drawTitleWater(ctx, fl, shared.waterTick);
    _drawTitleLogo(ctx, cx, fl, isSelectState);
    _drawTitleShip(ctx, cx, cy, fl);
    ctx.restore();

    _drawTitlePressZ(ctx, cx, vpBot);
    _drawTitleSelectBox(ctx, cx, shared);
  }
}

// ── Private helpers ────────────────────────────────────────────────────────

function _easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

// Spring physics: pulls shipPosX toward 0 (anchor) with damping + random nudges
export function updateShipSpring(dt) {
  const ts = titleSt;
  // Spring force toward anchor (0)
  const springF = -SHIP_SPRING_K * ts.shipPosX;
  // Damping force opposing velocity
  const dampF = -SHIP_SPRING_DAMP * ts.shipVelX;
  // Gentle random nudge (wind) — changes slowly via low-freq noise
  const nudge = Math.sin(ts.shipTimer * 0.0004) * Math.cos(ts.shipTimer * 0.00017) * SHIP_SPRING_NUDGE;

  ts.shipVelX += (springF + dampF + nudge) * dt;
  ts.shipPosX += ts.shipVelX * dt;
}

function _isShipLeftState(s) {
  return s === 'select-fade-in' || s === 'select' || s === 'name-entry';
}

function _titleParallaxSpeed(row) {
  return 0.3 + (row / 10) * 0.7;
}

function _drawTitleWaterRows(ctx, waterTop, twW, tile) {
  const ts = titleSt;
  for (let r = 0; r < 7; r++) {
    const speed  = _titleParallaxSpeed(4 + r);
    const scrollX = Math.floor(ts.waterScroll * speed) % 16;
    const y = waterTop + r * 16;
    for (let x = HUD_VIEW_X - scrollX; x < HUD_VIEW_X + twW + 16; x += 16) ctx.drawImage(tile, x, y);
  }
}

function _drawTitleCredit(ctx, cx, cy) {
  const ts = titleSt;
  if (ts.state === 'credit-in' || ts.state === 'credit-hold' || ts.state === 'credit-out') {
    let fl = 0;
    if (ts.state === 'credit-in')  fl = TITLE_FADE_MAX - Math.min(Math.floor(ts.timer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
    else if (ts.state === 'credit-out') fl = Math.min(Math.floor(ts.timer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
    const pal = fl === 0 ? TEXT_WHITE : titleFadePal(fl);
    drawText(ctx, cx - measureText(TITLE_CREDIT_1) / 2, cy - 16, TITLE_CREDIT_1, pal);
    drawText(ctx, cx - measureText(TITLE_CREDIT_2) / 2, cy -  4, TITLE_CREDIT_2, pal);
    drawText(ctx, cx - measureText(TITLE_CREDIT_3) / 2, cy +  8, TITLE_CREDIT_3, pal);
  } else if (ts.state === 'disclaim-in' || ts.state === 'disclaim-hold' || ts.state === 'disclaim-out') {
    let fl = 0;
    if (ts.state === 'disclaim-in')  fl = TITLE_FADE_MAX - Math.min(Math.floor(ts.timer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
    else if (ts.state === 'disclaim-out') fl = Math.min(Math.floor(ts.timer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
    const pal = fl === 0 ? TEXT_WHITE : titleFadePal(fl);
    drawText(ctx, cx - measureText(TITLE_DISCLAIM_1) / 2, cy - 24, TITLE_DISCLAIM_1, pal);
    drawText(ctx, cx - measureText(TITLE_DISCLAIM_2) / 2, cy - 14, TITLE_DISCLAIM_2, pal);
    drawText(ctx, cx - measureText(TITLE_DISCLAIM_3) / 2, cy -  4, TITLE_DISCLAIM_3, pal);
    drawText(ctx, cx - measureText(TITLE_DISCLAIM_4) / 2, cy + 10, TITLE_DISCLAIM_4, pal);
    drawText(ctx, cx - measureText(TITLE_DISCLAIM_5) / 2, cy + 24, TITLE_DISCLAIM_5, pal);
  }
}

function _drawTitleLogo(ctx, cx, fl, isSelectState) {
  const ts = titleSt;
  if (isSelectState || ts.state === 'main-out' || ts.state === 'to-main' || ts.state === 'main-in') return;
  if (!ts.logoFrames) return;

  // Compute fade level — box + content fade together
  let boxFl = fl;
  if (ts.state === 'logo-content-in' || ts.state === 'logo-content-in-back') boxFl = TITLE_FADE_MAX - Math.min(Math.floor(ts.timer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
  else if (ts.state === 'logo-content-out') boxFl = Math.min(Math.floor(ts.timer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
  else if (ts.state === 'to-select') boxFl = TITLE_FADE_MAX;
  if (boxFl >= TITLE_FADE_MAX) return;

  const logoFrame = ts.logoFrames[Math.min(boxFl, ts.logoFrames.length - 1)];
  const fullW = logoFrame.width + 16, fullH = logoFrame.height + 24;
  const tboxY = HUD_VIEW_Y + 12;
  const tboxX = Math.round(cx - fullW / 2);
  _drawTitleBox(ctx, tboxX, tboxY, fullW, fullH, boxFl);
  ctx.drawImage(logoFrame, tboxX + 8, tboxY + 8);
  const tw2 = measureText(TITLE_MMORPG);
  drawText(ctx, cx - tw2 / 2, tboxY + 8 + logoFrame.height, TITLE_MMORPG, boxFl === 0 ? TEXT_WHITE : titleFadePal(boxFl));
}

function _drawTitleShip(ctx, cx, cy, fl) {
  const ts = titleSt;
  if (!ts.shipFadeFrames || fl >= TITLE_FADE_MAX) return;
  const frameIdx = Math.floor(ts.shipTimer / TITLE_SHIP_ANIM_MS) % 2;
  const shipCanvas = ts.shipFadeFrames[fl][frameIdx];

  const leftX = cx - 16 - SHIP_DRIFT_PX;
  let shipX;

  if (ts.state === 'to-select') {
    // Eased slide from center to left anchor
    const t = _easeInOut(Math.min(ts.timer / TITLE_TRANSITION_MS, 1));
    shipX = cx - 16 - t * SHIP_DRIFT_PX;
  } else if (ts.state === 'to-main') {
    // Spring back to center from current left position
    const t = _easeInOut(Math.min(ts.timer / TITLE_TRANSITION_MS, 1));
    const startX = leftX + ts.shipPosX;
    shipX = startX + (cx - 16 - startX) * t;
  } else if (ts.state === 'select-fade-out') {
    // Wind-up left
    const t = Math.min(ts.timer / ((SELECT_TEXT_STEPS + 1) * SELECT_TEXT_STEP_MS), 1);
    shipX = leftX + ts.shipPosX - t * SHIP_WINDUP_PX;
  } else if (ts.state === 'main-out') {
    // Fly right
    const t = Math.min(ts.timer / TITLE_FADE_MS, 1);
    const startX = leftX + ts.shipPosX - SHIP_WINDUP_PX;
    shipX = startX + (cx + 300 - startX) * t * t;
  } else if (_isShipLeftState(ts.state) || ts.state === 'select-fade-out-back') {
    // Spring-driven drift around left anchor
    shipX = leftX + ts.shipPosX;
  } else {
    shipX = cx - 16;
  }

  const bob = Math.sin(ts.shipTimer / 2000 * Math.PI * 2) * 4;
  const shipY = Math.round(cy - 20 + bob);
  const shadowY = cy - 20 + 32;
  if (ts.shadowFade && Math.floor(ts.shipTimer / TITLE_SHADOW_ANIM_MS) % 2 === 0) {
    ctx.drawImage(ts.shadowFade[fl], shipX, shadowY);
  }
  ctx.drawImage(shipCanvas, shipX, shipY);
}

function _drawTitlePressZ(ctx, cx, vpBot) {
  const ts = titleSt;
  if (ts.state !== 'pressz-fade-in' && ts.state !== 'main' && ts.state !== 'logo-content-out' &&
      ts.state !== 'to-select' && ts.state !== 'logo-content-in-back') return;
  if (!ts.pressZ) return;

  // Compute fade level — box + text fade together
  let boxFl = 0;
  if (ts.state === 'pressz-fade-in' || ts.state === 'logo-content-in-back') boxFl = TITLE_FADE_MAX - Math.min(Math.floor(ts.timer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
  else if (ts.state === 'logo-content-out') boxFl = Math.min(Math.floor(ts.timer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
  else if (ts.state === 'to-select') boxFl = TITLE_FADE_MAX;
  if (boxFl >= TITLE_FADE_MAX) return;

  const pw    = measureText(ts.pressZ);
  const fullW = pw + 16, fullH = 24;
  const boxY = vpBot - 44;
  const boxX = cx - fullW / 2;
  _drawTitleBox(ctx, boxX, boxY, fullW, fullH, boxFl);
  // Text: blink while idle, otherwise matches box fade
  let textFl = boxFl;
  if (ts.state === 'main') {
    textFl = (Math.floor(ts.timer / 500) % 2 === 0) ? 0 : TITLE_FADE_MAX;
  }
  if (textFl < TITLE_FADE_MAX) {
    const pal = textFl === 0 ? TEXT_WHITE : titleFadePal(textFl);
    drawText(ctx, boxX + 8, boxY + 8, ts.pressZ, pal);
  }
}

function _drawTitleSelectBox(ctx, cx, shared) {
  const ts = titleSt;
  const isSelectState = ts.state === 'to-main' ||
    ts.state === 'select-fade-in' || ts.state === 'select' ||
    ts.state === 'select-fade-out' || ts.state === 'select-fade-out-back' || ts.state === 'name-entry';
  if (!isSelectState) return;

  // Compute fade step — boxes + content fade together
  let fadeStep = 0;
  if (ts.state === 'select-fade-in') fadeStep = SELECT_TEXT_STEPS - Math.min(Math.floor(ts.timer / SELECT_TEXT_STEP_MS), SELECT_TEXT_STEPS);
  else if (ts.state === 'select-fade-out' || ts.state === 'select-fade-out-back') fadeStep = Math.min(Math.floor(ts.timer / SELECT_TEXT_STEP_MS), SELECT_TEXT_STEPS);
  else if (ts.state === 'to-main') fadeStep = SELECT_TEXT_STEPS;
  if (fadeStep >= SELECT_TEXT_STEPS && ts.state === 'to-main') return;

  const showContent = fadeStep < SELECT_TEXT_STEPS;

  // Layout: 3 slot rows with gaps, pushed right one tile
  const selX = Math.round(cx + SELECT_BOX_OFFSET_X - SEL_W / 2) + 8;
  const gap = 4;
  const totalH = 3 * SEL_ROW_H + 2 * gap;
  const topY = HUD_VIEW_Y + Math.floor((HUD_VIEW_H - totalH) / 2);

  // Delete box dimensions
  const labelH = 24;
  const deleteLabelW = measureText(SELECT_DELETE_TEXT) + 16;
  const row2Y = topY + 2 * (SEL_ROW_H + gap);

  for (let i = 0; i < 3; i++) {
    const rowY = topY + i * (SEL_ROW_H + gap);
    _drawSelectSlotRow(ctx, i, selX, rowY, fadeStep, showContent, shared);
  }

  // "Delete" label — left of bottom row, bottom-aligned
  const dx = selX - 4 - deleteLabelW;
  const dy = row2Y + SEL_ROW_H - labelH;
  const delPal = [0x0F, 0x0F, 0x0F, titleSt.deleteMode ? 0x16 : selectCursor === 3 ? 0x16 : 0x30];
  for (let s = 0; s < fadeStep; s++) delPal[3] = nesColorFade(delPal[3]);
  _drawTitleBox(ctx, dx, dy, deleteLabelW, labelH, fadeStep);
  if (showContent) {
    if (selectCursor === 3) shared.drawCursorFaded(dx - 10, dy + 4, fadeStep);
    drawText(ctx, dx + 8, dy + 8, SELECT_DELETE_TEXT, delPal);
  }

  // Draw slot cursors AFTER delete box so they aren't covered
  if (showContent && selectCursor >= 0 && selectCursor < 3) {
    const cursorRowY = topY + selectCursor * (SEL_ROW_H + gap);
    shared.drawCursorFaded(selX - 10, cursorRowY + 12, fadeStep);
  }
}

function _drawSelectSlotRow(ctx, i, selX, rowY, fadeStep, showContent, shared) {
  const ts = titleSt;
  const isNameEntry = ts.state === 'name-entry' && i === selectCursor;

  // Portrait box (left) + info box (right) — with NES fade
  _drawTitleBox(ctx, selX, rowY, 32, SEL_ROW_H, fadeStep);
  _drawTitleBox(ctx, selX + 32, rowY, SEL_W - 32, SEL_ROW_H, fadeStep);
  if (!showContent) return;

  // Portrait — use per-job fake player portraits keyed by slot's jobIdx
  if (isNameEntry) {
    if (shared.silhouetteCanvas) ctx.drawImage(shared.silhouetteCanvas, selX + 8, rowY + 8);
  } else if (saveSlots[i] && shared.fakePlayerPortraits) {
    const jobIdx = saveSlots[i].jobIdx || 0;
    const jobPortraits = shared.fakePlayerPortraits[jobIdx] || shared.fakePlayerPortraits[0];
    const palPortraits = jobPortraits && jobPortraits[0]; // palette 0
    if (palPortraits && fadeStep < SELECT_TEXT_STEPS) {
      ctx.drawImage(palPortraits[fadeStep], selX + 8, rowY + 8);
    }
  } else {
    if (shared.silhouetteCanvas && fadeStep < SELECT_TEXT_STEPS) ctx.drawImage(shared.silhouetteCanvas, selX + 8, rowY + 8);
  }

  // Name + level text (right-aligned in info box, like roster)
  const fadedPal = _makeFadedPal(fadeStep);
  const infoRight = selX + SEL_W - 8;
  if (isNameEntry) {
    if (nameBuffer.length > 0) {
      const nameBytes = new Uint8Array(nameBuffer);
      const nw = measureText(nameBytes);
      drawText(ctx, infoRight - nw, rowY + 8, nameBytes, fadedPal);
    }
    if (nameBuffer.length < NAME_MAX_LEN && Math.floor(ts.timer / 400) % 2 === 0) {
      const cursorX = nameBuffer.length > 0 ? infoRight - measureText(new Uint8Array(nameBuffer)) + nameBuffer.length * 8 + 1 : selX + 40;
      ctx.fillStyle = '#fcfcfc';
      ctx.fillRect(cursorX, rowY + 15, 6, 1);
    }
  } else if (saveSlots[i]) {
    const nameBytes = saveSlots[i].name;
    const nw = measureText(nameBytes);
    drawText(ctx, infoRight - nw, rowY + 8, nameBytes, fadedPal);
    const infoLeft = selX + 32 + 8;
    const lvl = saveSlots[i].level || 1;
    const slotMaxHP = saveSlots[i].stats ? saveSlots[i].stats.maxHP : null;
    const slotHP = saveSlots[i].hp != null ? saveSlots[i].hp
                 : (saveSlots[i].stats && saveSlots[i].stats.hp != null) ? saveSlots[i].stats.hp
                 : slotMaxHP;
    if (slotHP != null && slotMaxHP) {
      drawLvHpRow(ctx, infoLeft, infoRight, rowY + 16, lvl, slotHP, slotMaxHP, fadeStep);
    } else {
      const lvLabel = _nameToBytes('Lv' + String(lvl));
      const lvPal = [0x0F, 0x0F, 0x0F, 0x10];
      for (let s = 0; s < fadeStep; s++) lvPal[3] = nesColorFade(lvPal[3]);
      drawText(ctx, infoLeft, rowY + 16, lvLabel, lvPal);
    }
  } else {
    const nw = measureText(SELECT_SLOT_TEXT);
    drawText(ctx, infoRight - nw, rowY + 8, SELECT_SLOT_TEXT, fadedPal);
  }
}

// ── Title update functions (moved from game.js) ──────────────────────────

function _zPressed(keys) { if (!keys['z'] && !keys['Z']) return false; keys['z'] = false; keys['Z'] = false; return true; }
function _xPressed(keys) { if (!keys['x'] && !keys['X']) return false; keys['x'] = false; keys['X'] = false; return true; }

export function updateTitleUnderwater(dt) {
  if (!titleSt.bubbleTiles) return;
  if (titleSt.state === 'main-in' || titleSt.state === 'main' || titleSt.state === 'main-out' ||
      titleSt.state.startsWith('zbox') || titleSt.state.startsWith('select') || titleSt.state === 'name-entry') return;
  if (titleSt.bubbles.length < 3 && Math.random() < dt * 0.0015) {
    titleSt.bubbles.push({
      x: HUD_VIEW_X + 20 + Math.random() * (CANVAS_W - 40),
      y: HUD_VIEW_H - 4,
      speed: 18 + Math.random() * 12,
      zigPhase: Math.random() * Math.PI * 2,
      zigSpeed: 3 + Math.random() * 3,
      zigAmp: 8 + Math.random() * 8,
      timer: 0,
    });
  }
  for (let i = titleSt.bubbles.length - 1; i >= 0; i--) {
    const b = titleSt.bubbles[i];
    b.y -= b.speed * dt / 1000;
    b.timer += dt;
    if (b.y < -8) titleSt.bubbles.splice(i, 1);
  }
  if (!titleSt.fishTriggered && titleSt.state === 'disclaim-wait') {
    titleSt.fishTriggered = true;
    titleSt.fish = { x: -10, y: HUD_VIEW_H * 0.7, timer: 0, speed: 80, zigPhase: 0, zigSpeed: 4, zigAmp: 6 };
  }
  if (titleSt.fish) {
    titleSt.fish.x += titleSt.fish.speed * dt / 1000;
    titleSt.fish.y -= titleSt.fish.speed * 0.4 * dt / 1000;
    titleSt.fish.timer += dt;
    if (titleSt.fish.x > CANVAS_W + 10 || titleSt.fish.y < -10) titleSt.fish = null;
  }
}

export function updateTitleSelect(keys) {
  if (_zPressed(keys)) {
    if (titleSt.deleteMode) {
      // In delete mode — Z on a slot deletes it
      if (saveSlots[selectCursor]) {
        playSFX(SFX.CONFIRM);
        saveSlots[selectCursor] = null;
        serverDeleteSlot(selectCursor);
        saveSlotsToDB();
        titleSt.deleteMode = false;
      }
    } else if (selectCursor === 3) {
      // Activate delete mode — cursor goes back to slots
      playSFX(SFX.CONFIRM);
      titleSt.deleteMode = true;
      setSelectCursor(titleSt._lastSlotCursor || 0);
    } else if (saveSlots[selectCursor]) {
      playSFX(SFX.CONFIRM);
      titleSt.state = 'select-fade-out'; titleSt.timer = 0;
    } else {
      playSFX(SFX.CONFIRM);
      setNameBuffer([]);
      titleSt.state = 'name-entry'; titleSt.timer = 0;
    }
  }
  if (titleSt.deleteMode) {
    // Delete mode — navigate slots only, no access to delete button
    if (keys['ArrowDown'])  { keys['ArrowDown'] = false;  setSelectCursor((selectCursor + 1) % 3); playSFX(SFX.CURSOR); }
    if (keys['ArrowUp'])    { keys['ArrowUp'] = false;    setSelectCursor((selectCursor + 2) % 3); playSFX(SFX.CURSOR); }
  } else if (selectCursor === 3) {
    // On delete button — right goes back to slots
    if (keys['ArrowRight']) { keys['ArrowRight'] = false; setSelectCursor(titleSt._lastSlotCursor || 0); playSFX(SFX.CURSOR); }
  } else {
    if (keys['ArrowDown'])  { keys['ArrowDown'] = false;  setSelectCursor((selectCursor + 1) % 3); playSFX(SFX.CURSOR); }
    if (keys['ArrowUp'])    { keys['ArrowUp'] = false;    setSelectCursor((selectCursor + 2) % 3); playSFX(SFX.CURSOR); }
    if (keys['ArrowLeft'])  { keys['ArrowLeft'] = false;  titleSt._lastSlotCursor = selectCursor; setSelectCursor(3); playSFX(SFX.CURSOR); }
  }
  if (_xPressed(keys)) {
    if (titleSt.deleteMode) {
      // Cancel delete mode
      playSFX(SFX.CURSOR);
      titleSt.deleteMode = false;
    } else {
      playSFX(SFX.CONFIRM); titleSt.state = 'select-fade-out-back'; titleSt.timer = 0;
    }
  }
}

export function onNameEntryKeyDown(e) {
  e.preventDefault();
  if (e.key === 'Enter' && nameBuffer.length > 0) {
    saveSlots[selectCursor] = { name: new Uint8Array(nameBuffer), level: 1, exp: 0, stats: null, inventory: {}, gil: 0, jobLevels: {}, jobIdx: 0, unlockedJobs: 0x01 };
    saveSlotsToDB();
    titleSt.state = 'select'; titleSt.timer = 0;
  } else if (e.key === 'Backspace') {
    if (nameBuffer.length > 0) nameBuffer.pop();
    else { titleSt.state = 'select'; titleSt.timer = 0; }
  } else if (e.key.length === 1 && /[a-zA-Z]/.test(e.key) && nameBuffer.length < NAME_MAX_LEN) {
    const ch = e.key;
    if (ch >= 'A' && ch <= 'Z') nameBuffer.push(0x8A + ch.charCodeAt(0) - 65);
    else nameBuffer.push(0xCA + ch.charCodeAt(0) - 97);
  }
}
