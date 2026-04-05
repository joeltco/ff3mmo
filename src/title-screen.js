// title-screen.js — title screen state, rendering, and player select screen

import { drawText, measureText, TEXT_WHITE } from './font-renderer.js';
import { nesColorFade, _makeFadedPal } from './palette.js';
import { selectCursor, saveSlots, nameBuffer, NAME_MAX_LEN } from './save-state.js';

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
const TITLE_HOLD_MS        = 2000;
const TITLE_WAIT_MS        = 0;
const TITLE_ZBOX_MS        = 200;
const TITLE_SHIP_ANIM_MS   = 100;
const TITLE_SHADOW_ANIM_MS = 50;
export const SELECT_TEXT_STEPS    = 4;
export const SELECT_TEXT_STEP_MS  = 100;
export const BOSS_BOX_EXPAND_MS   = 300;
const LOAD_FADE_MAX        = 4;
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
  return s === 'main-in' || s === 'zbox-open' || s === 'main' || s === 'zbox-close' ||
    s === 'logo-fade-out' || s === 'logo-fade-in' || s === 'select-box-open' ||
    s === 'select-box-close' || s === 'select-box-close-fwd' ||
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
  } else if (ts.state === 'zbox-open' || ts.state === 'main' || ts.state === 'zbox-close' ||
             ts.state === 'logo-fade-out' || ts.state === 'logo-fade-in' ||
             ts.state === 'select-box-open' || ts.state === 'select-box-close' || ts.state === 'select-box-close-fwd' ||
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

    const isSelectState = ts.state === 'select-box-open' || ts.state === 'select-box-close' || ts.state === 'select-box-close-fwd' ||
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

export function drawPlayerSelectContent(ctx, sbX, sbY, sbW, sbH, shared) {
  const ts = titleSt;
  let fadeStep = 0;
  if (ts.state === 'select-fade-in') {
    fadeStep = SELECT_TEXT_STEPS - Math.min(Math.floor(ts.timer / SELECT_TEXT_STEP_MS), SELECT_TEXT_STEPS);
  } else if (ts.state === 'select-fade-out' || ts.state === 'select-fade-out-back') {
    fadeStep = Math.min(Math.floor(ts.timer / SELECT_TEXT_STEP_MS), SELECT_TEXT_STEPS);
  }
  const fadedPal = _makeFadedPal(fadeStep);
  const ix = sbX + 8, iy = sbY + 8, iw = sbW - 16;
  const tw = measureText(SELECT_TITLE);
  drawText(ctx, ix + Math.floor((iw - tw) / 2), iy, SELECT_TITLE, fadedPal);
  const slotStartY = iy + 16, slotSpacing = 20;
  for (let i = 0; i < 3; i++) {
    _drawSelectSlot(ctx, i, ix, slotStartY, slotSpacing, fadeStep, fadedPal, shared);
  }
  const delY   = slotStartY + 3 * slotSpacing;
  const delPal = ts.deleteMode
    ? [0x0F, 0x0F, 0x0F, 0x16]
    : [0x0F, 0x0F, 0x0F, fadedPal[3]];
  if (!ts.deleteMode && selectCursor === 3) shared.drawCursorFaded(ix, delY - 4, fadeStep);
  drawText(ctx, ix + 38, delY, SELECT_DELETE_TEXT, delPal);
}

// ── Private helpers ────────────────────────────────────────────────────────

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
  let logoFl = fl;
  if (ts.state === 'logo-fade-out') {
    logoFl = Math.min(Math.floor(ts.timer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
  } else if (ts.state === 'logo-fade-in') {
    logoFl = TITLE_FADE_MAX - Math.min(Math.floor(ts.timer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
  } else if (isSelectState || ts.state === 'main-out') {
    logoFl = TITLE_FADE_MAX;
  }
  if (!ts.logoFrames || logoFl >= TITLE_FADE_MAX) return;
  const logoFrame = ts.logoFrames[Math.min(logoFl, ts.logoFrames.length - 1)];
  const tboxW = logoFrame.width + 16, tboxH = logoFrame.height + 24;
  const tboxX = Math.round(cx - tboxW / 2);
  const tboxY = HUD_VIEW_Y + 12;
  const clampedFl  = Math.min(logoFl, LOAD_FADE_MAX);
  const tBorderSet = (ts.borderFadeSets && logoFl > 0) ? ts.borderFadeSets[clampedFl] : ts.borderTiles;
  if (tBorderSet) {
    const [TL, TOP, TR, LEFT, RIGHT, BL, BOT, BR, FILL] = tBorderSet;
    ctx.drawImage(TL, tboxX, tboxY); ctx.drawImage(TR, tboxX + tboxW - 8, tboxY);
    ctx.drawImage(BL, tboxX, tboxY + tboxH - 8); ctx.drawImage(BR, tboxX + tboxW - 8, tboxY + tboxH - 8);
    for (let tx = tboxX + 8; tx < tboxX + tboxW - 8; tx += 8) { ctx.drawImage(TOP, tx, tboxY); ctx.drawImage(BOT, tx, tboxY + tboxH - 8); }
    for (let ty = tboxY + 8; ty < tboxY + tboxH - 8; ty += 8) { ctx.drawImage(LEFT, tboxX, ty); ctx.drawImage(RIGHT, tboxX + tboxW - 8, ty); }
    for (let ty = tboxY + 8; ty < tboxY + tboxH - 8; ty += 8)
      for (let tx = tboxX + 8; tx < tboxX + tboxW - 8; tx += 8) ctx.drawImage(FILL, tx, ty);
  }
  ctx.drawImage(logoFrame, tboxX + 8, tboxY + 8);
  const tw2 = measureText(TITLE_MMORPG);
  drawText(ctx, cx - tw2 / 2, tboxY + 8 + logoFrame.height, TITLE_MMORPG, logoFl === 0 ? TEXT_WHITE : titleFadePal(logoFl));
}

function _drawTitleShip(ctx, cx, cy, fl) {
  const ts = titleSt;
  if (!ts.shipFadeFrames || fl >= TITLE_FADE_MAX) return;
  const frameIdx = Math.floor(ts.shipTimer / TITLE_SHIP_ANIM_MS) % 2;
  const shipCanvas = ts.shipFadeFrames[fl][frameIdx];
  const shipX = cx - 16;
  const bob   = Math.sin(ts.shipTimer / 2000 * Math.PI * 2) * 4;
  const shipY = Math.round(cy - 20 + bob);
  const shadowY = cy - 20 + 32;
  if (ts.shadowFade && Math.floor(ts.shipTimer / TITLE_SHADOW_ANIM_MS) % 2 === 0) {
    ctx.drawImage(ts.shadowFade[fl], shipX, shadowY);
  }
  ctx.drawImage(shipCanvas, shipX, shipY);
}

function _drawTitlePressZ(ctx, cx, vpBot) {
  const ts = titleSt;
  if (ts.state !== 'zbox-open' && ts.state !== 'main' && ts.state !== 'zbox-close') return;
  if (!ts.pressZ) return;
  const pw    = measureText(ts.pressZ);
  const fullW = pw + 16, fullH = 24;
  const boxCY = vpBot - 44 + fullH / 2;
  let t = 1;
  if (ts.state === 'zbox-open')  t = Math.min(ts.timer / TITLE_ZBOX_MS, 1);
  else if (ts.state === 'zbox-close') t = 1 - Math.min(ts.timer / TITLE_ZBOX_MS, 1);
  const boxW = fullW, boxH = Math.max(8, Math.round(fullH * t));
  const boxX = cx - boxW / 2, boxY = Math.round(boxCY - boxH / 2);
  if (ts.borderTiles) {
    const [TL, TOP, TR, LEFT, RIGHT, BL, BOT, BR, FILL] = ts.borderTiles;
    ctx.drawImage(TL, boxX, boxY); ctx.drawImage(TR, boxX + boxW - 8, boxY);
    ctx.drawImage(BL, boxX, boxY + boxH - 8); ctx.drawImage(BR, boxX + boxW - 8, boxY + boxH - 8);
    for (let tx = boxX + 8; tx < boxX + boxW - 8; tx += 8) { ctx.drawImage(TOP, tx, boxY); ctx.drawImage(BOT, tx, boxY + boxH - 8); }
    for (let ty = boxY + 8; ty < boxY + boxH - 8; ty += 8) { ctx.drawImage(LEFT, boxX, ty); ctx.drawImage(RIGHT, boxX + boxW - 8, ty); }
    for (let ty = boxY + 8; ty < boxY + boxH - 8; ty += 8)
      for (let tx = boxX + 8; tx < boxX + boxW - 8; tx += 8) ctx.drawImage(FILL, tx, ty);
  }
  if (t >= 1 && Math.floor(ts.timer / 500) % 2 === 0) {
    drawText(ctx, boxX + 8, boxY + 8, ts.pressZ, TEXT_WHITE);
  }
}

function _drawTitleSelectBox(ctx, cx, shared) {
  const ts = titleSt;
  const isSelectState = ts.state === 'select-box-open' || ts.state === 'select-box-close' || ts.state === 'select-box-close-fwd' ||
    ts.state === 'select-fade-in' || ts.state === 'select' ||
    ts.state === 'select-fade-out' || ts.state === 'select-fade-out-back' || ts.state === 'name-entry';
  if (!isSelectState) return;
  const SELECT_BOX_W = 128, SELECT_BOX_H = 112;
  const sbCX = cx, sbCY = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2);
  let sbt = 1;
  if (ts.state === 'select-box-open') sbt = Math.min(ts.timer / BOSS_BOX_EXPAND_MS, 1);
  else if (ts.state === 'select-box-close' || ts.state === 'select-box-close-fwd') sbt = 1 - Math.min(ts.timer / BOSS_BOX_EXPAND_MS, 1);
  const sbW = Math.max(16, Math.ceil(SELECT_BOX_W * sbt / 8) * 8);
  const sbH = Math.max(16, Math.ceil(SELECT_BOX_H * sbt / 8) * 8);
  if (ts.borderTiles) shared.drawBorderedBox(Math.round(sbCX - sbW / 2), Math.round(sbCY - sbH / 2), sbW, sbH);
  if (sbt >= 1 && ts.state !== 'select-box-close' && ts.state !== 'select-box-close-fwd') {
    drawPlayerSelectContent(ctx, Math.round(sbCX - sbW / 2), Math.round(sbCY - sbH / 2), SELECT_BOX_W, SELECT_BOX_H, shared);
  }
}

function _drawSelectSlot(ctx, i, ix, slotStartY, slotSpacing, fadeStep, fadedPal, shared) {
  const ts  = titleSt;
  const sy  = slotStartY + i * slotSpacing;
  const textX = ix + 20, nameX = textX + 18;
  const isNameEntry = ts.state === 'name-entry' && i === selectCursor;

  if (i === selectCursor) shared.drawCursorFaded(ix, sy - 4, fadeStep);

  if (isNameEntry) {
    if (shared.silhouetteCanvas) ctx.drawImage(shared.silhouetteCanvas, textX - 2, sy - 4);
  } else {
    const portraitSrc = (saveSlots[i] && shared.battleSpriteCanvas) ? shared.battleSpriteCanvas : shared.silhouetteCanvas;
    if (portraitSrc && fadeStep < SELECT_TEXT_STEPS) {
      let src = portraitSrc;
      if (fadeStep > 0 && portraitSrc === shared.battleSpriteCanvas && shared.battleSpriteFadeCanvases)
        src = shared.battleSpriteFadeCanvases[fadeStep - 1];
      else if (fadeStep > 0)
        src = null;
      if (src) ctx.drawImage(src, textX - 2, sy - 4, ...(portraitSrc === shared.battleSpriteCanvas ? [16, 16] : []));
    }
  }

  if (isNameEntry) {
    if (nameBuffer.length > 0) drawText(ctx, nameX, sy, new Uint8Array(nameBuffer), fadedPal);
    if (nameBuffer.length < NAME_MAX_LEN && Math.floor(ts.timer / 400) % 2 === 0) {
      ctx.fillStyle = '#fcfcfc';
      ctx.fillRect(nameX + nameBuffer.length * 8 + 1, sy + 7, 6, 1);
    }
  } else if (saveSlots[i]) {
    drawText(ctx, nameX, sy, saveSlots[i].name, fadedPal);
  } else {
    drawText(ctx, nameX, sy, SELECT_SLOT_TEXT, fadedPal);
  }
}
