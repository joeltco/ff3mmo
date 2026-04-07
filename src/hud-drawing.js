// hud-drawing.js — HUD rendering, top box, portrait, info panel, utility draw helpers

import { NES_SYSTEM_PALETTE } from './tile-decoder.js';
import { drawText, measureText, TEXT_WHITE } from './font-renderer.js';
import { nesColorFade, _makeFadedPal } from './palette.js';
import { _nameToBytes, drawLvHpRow } from './text-utils.js';
import { ps } from './player-stats.js';
import { selectCursor, saveSlots } from './save-state.js';
import { pauseSt } from './pause-menu.js';
import { transSt, topBoxSt, loadingSt } from './transitions.js';
import { LOAD_FADE_STEP_MS, LOAD_FADE_MAX, drawHUDLoadingMoogle } from './loading-screen.js';
import { _dmgBounceY } from './data/animation-tables.js';
import { HEAL_NUM_PAL, drawBattleNum } from './damage-numbers.js';
import { inputSt } from './input-handler.js';

// NES layout constants — must match game.js
const CANVAS_W = 256;
const CANVAS_H = 240;
const HUD_TOP_H = 32;
const HUD_VIEW_X = 0;
const HUD_VIEW_Y = HUD_TOP_H;
const HUD_VIEW_W = 144;
const HUD_VIEW_H = 144;
const HUD_RIGHT_X = HUD_VIEW_W;
const HUD_RIGHT_W = CANVAS_W - HUD_VIEW_W;
const HUD_BOT_Y = HUD_VIEW_Y + HUD_VIEW_H;
const HUD_BOT_H = CANVAS_H - HUD_BOT_Y;
const HUD_INFO_FADE_STEPS = 4;
const HUD_INFO_FADE_STEP_MS = 200;
const TOPBOX_FADE_STEPS = 4;

// Shared state — set once via initHudDrawing()
let _s = null;

export function initHudDrawing(shared) { _s = shared; }

// ── Utility draw helpers (used by other modules via shared context) ────────

export function clipToViewport() {
  _s.ctx.save(); _s.ctx.beginPath(); _s.ctx.rect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H); _s.ctx.clip();
}

export function drawCursorFaded(cx, cy, fadeStep) {
  if (!_s.cursorTileCanvas) return;
  if (fadeStep <= 0) { _s.ctx.drawImage(_s.cursorTileCanvas, cx, cy); return; }
  if (fadeStep < 4 && _s.cursorFadeCanvases) _s.ctx.drawImage(_s.cursorFadeCanvases[fadeStep - 1], cx, cy);
}

export function drawHudBox(x, y, w, h, fadeStep = 0) {
  const tiles = (fadeStep > 0 && _s.borderFadeSets) ? _s.borderFadeSets[fadeStep] : _s.borderTileCanvases;
  if (!tiles) return;
  const [TL, TOP, TR, LEFT, RIGHT, BL, BOT, BR] = tiles;
  const ctx = _s.ctx;
  ctx.fillStyle = '#000';
  ctx.fillRect(x + 8, y + 8, w - 16, h - 16);
  ctx.drawImage(TL, x, y); ctx.drawImage(TR, x + w - 8, y);
  ctx.drawImage(BL, x, y + h - 8); ctx.drawImage(BR, x + w - 8, y + h - 8);
  for (let tx = x + 8; tx < x + w - 8; tx += 8) { ctx.drawImage(TOP, tx, y); ctx.drawImage(BOT, tx, y + h - 8); }
  for (let ty = y + 8; ty < y + h - 8; ty += 8) { ctx.drawImage(LEFT, x, ty); ctx.drawImage(RIGHT, x + w - 8, ty); }
}

export function drawSparkleCorners(frame, px, py) {
  const ctx = _s.ctx;
  ctx.drawImage(frame, px - 8, py - 7);
  ctx.save(); ctx.scale(-1, 1); ctx.drawImage(frame, -(px + 23), py - 7); ctx.restore();
  ctx.save(); ctx.scale(1, -1); ctx.drawImage(frame, px - 8, -(py + 24)); ctx.restore();
  ctx.save(); ctx.scale(-1, -1); ctx.drawImage(frame, -(px + 23), -(py + 24)); ctx.restore();
}

export function drawBorderedBox(x, y, w, h, blue = false) {
  if (!_s.borderTileCanvases) return;
  const ctx = _s.ctx;
  const tileSet = blue ? _s.borderBlueTileCanvases : _s.borderTileCanvases;
  const [TL, TOP, TR, LEFT, RIGHT, BL, BOT, BR] = tileSet;
  if (blue) {
    const nb = NES_SYSTEM_PALETTE[0x02];
    ctx.fillStyle = `rgb(${nb[0]},${nb[1]},${nb[2]})`;
  } else {
    ctx.fillStyle = '#000';
  }
  ctx.fillRect(x + 8, y + 8, w - 16, h - 16);
  ctx.drawImage(TL, x, y); ctx.drawImage(TR, x + w - 8, y);
  ctx.drawImage(BL, x, y + h - 8); ctx.drawImage(BR, x + w - 8, y + h - 8);
  for (let tx = x + 8; tx < x + w - 8; tx += 8) { ctx.drawImage(TOP, tx, y); ctx.drawImage(BOT, tx, y + h - 8); }
  for (let ty = y + 8; ty < y + h - 8; ty += 8) { ctx.drawImage(LEFT, x, ty); ctx.drawImage(RIGHT, x + w - 8, ty); }
}

export function drawHealNum(bx, by, value, pal) {
  drawBattleNum(_s.ctx, bx, by, value, pal);
}

// ── Top box ───────────────────────────────────────────────────────────────

export function drawTopBoxBorder(fadeStep) {
  if (!_s.borderFadeSets || fadeStep >= TOPBOX_FADE_STEPS) return;
  const ctx = _s.ctx;
  const tiles = _s.borderFadeSets[fadeStep];
  const [TL, TOP, TR, LEFT, RIGHT, BL, BOT, BR] = tiles;
  const x = 0, y = 0, w = CANVAS_W, h = HUD_TOP_H;
  ctx.fillStyle = '#000';
  ctx.fillRect(x + 8, y + 8, w - 16, h - 16);
  ctx.drawImage(TL, x, y); ctx.drawImage(TR, x + w - 8, y);
  ctx.drawImage(BL, x, y + h - 8); ctx.drawImage(BR, x + w - 8, y + h - 8);
  for (let tx = x + 8; tx < x + w - 8; tx += 8) { ctx.drawImage(TOP, tx, y); ctx.drawImage(BOT, tx, y + h - 8); }
  for (let ty = y + 8; ty < y + h - 8; ty += 8) { ctx.drawImage(LEFT, x, ty); ctx.drawImage(RIGHT, x + w - 8, ty); }
}

export function roundTopBoxCorners() {
  if (!_s.cornerMasks) return;
  const ctx = _s.ctx;
  const [TL, TR, BL, BR] = _s.cornerMasks;
  ctx.drawImage(TL, 0, 0);
  ctx.drawImage(TR, CANVAS_W - 8, 0);
  ctx.drawImage(BL, 0, HUD_TOP_H - 8);
  ctx.drawImage(BR, CANVAS_W - 8, HUD_TOP_H - 8);
}

// ── Top box rendering ─────────────────────────────────────────────────────

function _drawTopBoxBattleBG() {
  const ctx = _s.ctx;
  const battleState = _s.battleState;
  const battleShakeTimer = _s.battleShakeTimer;
  const topShake = ((battleState === 'enemy-attack' || battleState === 'poison-tick' || battleState === 'pvp-opp-sw-hit') && battleShakeTimer > 0)
    ? (Math.floor(battleShakeTimer / 67) & 1 ? 2 : -2) : 0;
  if (transSt.state !== 'loading' && !topBoxSt.isTown && _s.topBoxBgCanvas) {
    ctx.drawImage(_s.topBoxBgCanvas, topShake, 0);
  }
  if (!topBoxSt.isTown && _s.topBoxBgFadeFrames && transSt.state !== 'none' && transSt.state !== 'door-opening' && transSt.state !== 'loading') {
    const maxStep = _s.topBoxBgFadeFrames.length - 1;
    const FADE_STEP_MS = 100;
    let fadeStep = 0;
    if (transSt.state === 'closing') {
      fadeStep = Math.min(Math.floor(transSt.timer / FADE_STEP_MS), maxStep);
    } else if (transSt.state === 'hold' || transSt.state === 'trap-falling') {
      fadeStep = maxStep;
    } else if (transSt.state === 'opening') {
      if (transSt.topBoxAlreadyBright) fadeStep = 0;
      else fadeStep = Math.max(maxStep - Math.floor(transSt.timer / FADE_STEP_MS), 0);
    } else if (transSt.state === 'hud-fade-in') {
      fadeStep = Math.max(maxStep - Math.floor(_s.hudInfoFadeTimer / HUD_INFO_FADE_STEP_MS), 0);
    }
    if (fadeStep > 0) ctx.drawImage(_s.topBoxBgFadeFrames[fadeStep], 0, 0);
  }
  if (!topBoxSt.isTown && transSt.state !== 'loading') roundTopBoxCorners();
}

function _drawTopBoxOverlay(isFading) {
  const ctx = _s.ctx;
  if (transSt.state === 'loading') {
    let loadFade = LOAD_FADE_MAX;
    if (loadingSt.state === 'in') {
      loadFade = LOAD_FADE_MAX - Math.min(Math.floor(loadingSt.timer / LOAD_FADE_STEP_MS), LOAD_FADE_MAX);
    } else if (loadingSt.state === 'visible') {
      loadFade = 0;
    } else if (loadingSt.state === 'out') {
      loadFade = Math.min(Math.floor(loadingSt.timer / LOAD_FADE_STEP_MS), LOAD_FADE_MAX);
    }
    drawTopBoxBorder(loadFade);
    if (topBoxSt.nameBytes && !isFading) {
      const fadedPal = _makeFadedPal(loadFade);
      const tw = measureText(topBoxSt.nameBytes);
      drawText(ctx, 8 + Math.floor((240 - tw) / 2), 12, topBoxSt.nameBytes, fadedPal);
    }
  } else if (topBoxSt.isTown && _s.topBoxMode === 'name' && topBoxSt.nameBytes) {
    if (isFading) drawTopBoxBorder(topBoxSt.fadeStep);
    else if (topBoxSt.state !== 'pending') drawTopBoxBorder(0);
    if (!isFading && topBoxSt.state !== 'pending') {
      const tw = measureText(topBoxSt.nameBytes);
      drawText(ctx, 8 + Math.floor((240 - tw) / 2), 12, topBoxSt.nameBytes, TEXT_WHITE);
    }
  }
  if (isFading && topBoxSt.nameBytes) {
    if (transSt.state !== 'loading' && !topBoxSt.isTown) drawTopBoxBorder(topBoxSt.fadeStep);
    const fadedPal = _makeFadedPal(topBoxSt.fadeStep);
    const tw = measureText(topBoxSt.nameBytes);
    drawText(ctx, 8 + Math.floor((240 - tw) / 2), 12, topBoxSt.nameBytes, fadedPal);
  }
}

function _drawHUDTopBox() {
  const isFading = topBoxSt.state === 'fade-in' || topBoxSt.state === 'display' || topBoxSt.state === 'fade-out';
  _drawTopBoxBattleBG();
  _drawTopBoxOverlay(isFading);
}

// ── Portrait ──────────────────────────────────────────────────────────────

function _drawPortraitImage(px, py, nfPortrait, isPauseHeal, infoFadeStep) {
  const ctx = _s.ctx;
  if (infoFadeStep >= HUD_INFO_FADE_STEPS) return;
  if (infoFadeStep > 0) {
    const fadeSets = nfPortrait === _s.battleSpriteKneelCanvas ? _s.battleSpriteKneelFadeCanvases
                   : nfPortrait === _s.battleSpriteDefendCanvas ? _s.battleSpriteDefendFadeCanvases
                   : _s.battleSpriteFadeCanvases;
    if (fadeSets) { ctx.drawImage(fadeSets[infoFadeStep - 1], px, py); return; }
  }
  ctx.drawImage(nfPortrait, px, py);
  const isNearFatal = ps.hp > 0 && ps.stats && ps.hp <= Math.floor(ps.stats.maxHP / 4);
  if (!isPauseHeal && isNearFatal && nfPortrait === _s.battleSpriteKneelCanvas && _s.sweatFrames.length === 2)
    ctx.drawImage(_s.sweatFrames[Math.floor(Date.now() / 133) & 1], px, py - 3);
  // Poison bubble above portrait when status active
  if (ps.status && ps.status.mask !== 0 && _s.poisonBubbleFrames && _s.poisonBubbleFrames.length === 2) {
    const bFrame = _s.poisonBubbleFrames[Math.floor(Date.now() / 267) & 1];
    ctx.drawImage(bFrame, px + 2, py - 14);
  }
}

function _drawCureSparkle(px, py, isPauseHeal) {
  const ctx = _s.ctx;
  if (!isPauseHeal || _s.cureSparkleFrames.length !== 2 || (pauseSt.healNum && pauseSt.healNum.rosterIdx >= 0)) return;
  const frame = _s.cureSparkleFrames[Math.floor(pauseSt.timer / 67) & 1];
  ctx.drawImage(frame, px - 8, py - 7);
  ctx.save(); ctx.scale(-1,  1); ctx.drawImage(frame, -(px + 23),  py - 7);  ctx.restore();
  ctx.save(); ctx.scale( 1, -1); ctx.drawImage(frame,   px - 8,  -(py + 24)); ctx.restore();
  ctx.save(); ctx.scale(-1, -1); ctx.drawImage(frame, -(px + 23), -(py + 24)); ctx.restore();
}

function _drawPauseHealNum(px, py) {
  if (!pauseSt.healNum || pauseSt.healNum.rosterIdx >= 0) return;
  drawHealNum(px + 8, _dmgBounceY(py + 8, pauseSt.healNum.timer), pauseSt.healNum.value, HEAL_NUM_PAL);
}

function _drawHUDPortrait() {
  const infoFadeStep = HUD_INFO_FADE_STEPS - Math.min(Math.floor(_s.hudInfoFadeTimer / HUD_INFO_FADE_STEP_MS), HUD_INFO_FADE_STEPS);
  if (_s.battleState !== 'none' || !_s.battleSpriteCanvas) return;
  const isPauseHeal = pauseSt.state === 'inv-heal';
  const hasActiveStatus = ps.status && ps.status.mask !== 0;
  const nfPortrait = isPauseHeal && _s.battleSpriteDefendCanvas ? _s.battleSpriteDefendCanvas
    : ((ps.hp > 0 && ps.stats && ps.hp <= Math.floor(ps.stats.maxHP / 4) || hasActiveStatus) && _s.battleSpriteKneelCanvas
       ? _s.battleSpriteKneelCanvas : _s.battleSpriteCanvas);
  const px = HUD_RIGHT_X + 8, py = HUD_VIEW_Y + 8;
  _drawPortraitImage(px, py, nfPortrait, isPauseHeal, infoFadeStep);
  _drawCureSparkle(px, py, isPauseHeal);
  _drawPauseHealNum(px, py);
}

// ── Info panel ────────────────────────────────────────────────────────────

function _drawHUDInfoPanel() {
  const ctx = _s.ctx;
  const infoFadeStep = HUD_INFO_FADE_STEPS - Math.min(Math.floor(_s.hudInfoFadeTimer / HUD_INFO_FADE_STEP_MS), HUD_INFO_FADE_STEPS);
  if (infoFadeStep >= HUD_INFO_FADE_STEPS) return;
  const playerDeathTimer = _s.playerDeathTimer;
  if (playerDeathTimer != null) {
    if (playerDeathTimer < 500) {
    } else if (playerDeathTimer < 800) {
      const deathAlpha = 1 - (playerDeathTimer - 500) / 300;
      ctx.save(); ctx.globalAlpha = deathAlpha;
    } else { return; }
  }
  const battleShakeTimer = _s.battleShakeTimer;
  const battleState = _s.battleState;
  const shakeOff = ((battleState === 'enemy-attack' || battleState === 'poison-tick' || battleState === 'pvp-opp-sw-hit') && battleShakeTimer > 0)
    ? (Math.floor(battleShakeTimer / 67) & 1 ? 2 : -2) : 0;
  const sy = HUD_VIEW_Y + 8;
  const panelRight = HUD_RIGHT_X + HUD_RIGHT_W - 8 + shakeOff;
  const slot = saveSlots[selectCursor];
  const deathTextFading = playerDeathTimer != null && playerDeathTimer >= 500 && playerDeathTimer < 800;
  if (!slot) { if (deathTextFading) ctx.restore(); return; }
  const namePal = [...TEXT_WHITE];
  for (let s = 0; s < infoFadeStep; s++) namePal[3] = nesColorFade(namePal[3]);
  const nameW = measureText(slot.name);
  drawText(ctx, panelRight - nameW, sy, slot.name, namePal);
  const panelLeft = HUD_RIGHT_X + 32 + 8 + shakeOff;
  drawLvHpRow(ctx, panelLeft, panelRight, sy + 9,
    ps.stats ? ps.stats.level : slot.level, ps.hp, ps.stats ? ps.stats.maxHP : 28, infoFadeStep);
  if (deathTextFading) ctx.restore();
}

// ── Roster sparkle ────────────────────────────────────────────────────────

export function drawRosterSparkle(panelTop) {
  if (!pauseSt.healNum || pauseSt.healNum.rosterIdx < 0 || _s.cureSparkleFrames.length !== 2) return;
  const visRow = pauseSt.healNum.rosterIdx - inputSt.rosterScroll;
  if (visRow < 0 || visRow >= 3) return;
  const px = HUD_RIGHT_X + 8;
  const py = panelTop + visRow * 32 + 8;
  const fi = Math.floor(pauseSt.timer / 67) & 1;
  const frame = _s.cureSparkleFrames[fi];
  drawSparkleCorners(frame, px, py);
  drawHealNum(px + 8, _dmgBounceY(py + 8, pauseSt.healNum.timer), pauseSt.healNum.value, HEAL_NUM_PAL);
}

// ── HUD with fade ─────────────────────────────────────────────────────────

function _drawHudWithFade(fullCanvas, fadeCanvases, fadeStep) {
  const ctx = _s.ctx;
  if (fadeStep > 0 && fadeCanvases && fadeStep <= fadeCanvases.length) {
    ctx.drawImage(fadeCanvases[fadeStep - 1], 0, 0);
    ctx.save(); ctx.beginPath(); ctx.rect(0, HUD_BOT_Y, CANVAS_W, HUD_BOT_H); ctx.clip();
    ctx.drawImage(fullCanvas, 0, 0); ctx.restore();
  } else { ctx.drawImage(fullCanvas, 0, 0); }
}

function _grayViewport() {
  const ctx = _s.ctx;
  ctx.filter = 'saturate(0)';
  ctx.drawImage(ctx.canvas, HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H,
                            HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);
  ctx.filter = 'none'; ctx.restore();
}

export { _grayViewport as grayViewport };

// ── Main drawHUD ──────────────────────────────────────────────────────────

export function drawHUD() {
  const ctx = _s.ctx;
  const isTitleActive = _s.titleState !== 'done';
  if (isTitleActive && _s.titleHudCanvas) {
    let tfl = 0;
    if (_s.titleState === 'main-out') {
      tfl = Math.min(Math.floor(_s.titleTimer / _s.TITLE_FADE_STEP_MS), _s.TITLE_FADE_MAX);
    }
    _drawHudWithFade(_s.titleHudCanvas, _s.titleHudFadeCanvases, tfl);
  } else if (_s.hudCanvas) {
    const fadeStep = HUD_INFO_FADE_STEPS - Math.min(Math.floor(_s.hudInfoFadeTimer / HUD_INFO_FADE_STEP_MS), HUD_INFO_FADE_STEPS);
    _drawHudWithFade(_s.hudCanvas, _s.hudFadeCanvases, fadeStep);
  }
  if (_s.titleState !== 'done') return;
  _drawHUDTopBox();
  _drawHUDPortrait();
  _drawHUDInfoPanel();
  if (transSt.state === 'loading' && loadingSt.state !== 'none') {
    drawHUDLoadingMoogle(_s.loadingShared());
  }
}

export function statRowBytes(label1, label2, value) {
  const digits = String(value);
  const bytes = new Uint8Array(8);
  bytes[0] = label1;
  bytes[1] = label2;
  const numStart = 8 - digits.length;
  for (let i = 2; i < numStart; i++) bytes[i] = 0xFF;
  for (let i = 0; i < digits.length; i++) bytes[numStart + i] = 0x80 + parseInt(digits[i]);
  return bytes;
}
