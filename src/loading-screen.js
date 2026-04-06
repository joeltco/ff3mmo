// loading-screen.js — loading screen overlay + right-panel moogle
//
// Extracted from game.js. Uses _loadingShared() pattern for game.js state access.

import { nesColorFade } from './palette.js';
import { NES_SYSTEM_PALETTE } from './tile-decoder.js';
import { loadingSt } from './transitions.js';
import { MONSTERS } from './data/monsters.js';

// Constants
const LOAD_FADE_STEP_MS = 133;
const LOAD_FADE_MAX = 4;

// Module-level shared ref
let _s = null;

// NES-encoded text constants
const _LOADING_BYTES = new Uint8Array([0x95,0xD8,0xCA,0xCD,0xD2,0xD7,0xD0,0xFF,0x8D,0xDE,0xD7,0xD0,0xCE,0xD8,0xD7]);
const _LOADED_BYTES  = new Uint8Array([0x8D,0xDE,0xD7,0xD0,0xCE,0xD8,0xD7,0xFF,0x95,0xD8,0xCA,0xCD,0xCE,0xCD]);
const _FLOORS_BYTES  = new Uint8Array([0x84,0xFF,0x95,0xCE,0xDF,0xCE,0xD5,0xDC]);
// "HP " + boss HP digits (NES encoding: 0x80='0', 0x81='1', etc.)
const _bossHP = String((MONSTERS.get(0xCC) || { hp: 120 }).hp);
const _LODHP_BYTES = new Uint8Array([0x91, 0x99, 0xFF, ...Array.from(_bossHP, ch => 0x80 + parseInt(ch))]);

function _calcFadeLevel() {
  if (loadingSt.state === 'in') return LOAD_FADE_MAX - Math.min(Math.floor(loadingSt.timer / LOAD_FADE_STEP_MS), LOAD_FADE_MAX);
  if (loadingSt.state === 'out') return Math.min(Math.floor(loadingSt.timer / LOAD_FADE_STEP_MS), LOAD_FADE_MAX);
  if (loadingSt.state !== 'visible') return LOAD_FADE_MAX;
  return 0;
}

function _drawLoadingBG(vpTop, fadeLevel) {
  const bgFadeFrames = _s.loadingBgFadeFrames;
  if (!bgFadeFrames || bgFadeFrames.length === 0) return;
  const bgCanvas = bgFadeFrames[Math.min(fadeLevel, bgFadeFrames.length - 1)];
  const scrollX = Math.floor(loadingSt.bgScroll) % 256;
  const ctx = _s.ctx;
  ctx.save();
  ctx.beginPath(); ctx.rect(_s.HUD_VIEW_X, vpTop, _s.HUD_VIEW_W, 32); ctx.clip();
  ctx.drawImage(bgCanvas, _s.HUD_VIEW_X - scrollX, vpTop);
  ctx.drawImage(bgCanvas, _s.HUD_VIEW_X - scrollX + 256, vpTop);
  ctx.restore();
}

function _drawLoadingInfoBox(cx, vpTop, vpBot, fadeLevel, fadedTextPal) {
  const hpW = _s.measureText(_LODHP_BYTES);
  const bossRowW = 16 + 4 + hpW;
  const infoBoxW = Math.ceil(Math.max(bossRowW + 16, 80) / 8) * 8;
  const infoBoxH = 48;
  const infoBoxX = Math.round(cx - infoBoxW / 2);
  const infoBoxY = Math.round(vpTop + (vpBot - vpTop) / 2 - infoBoxH / 2);
  const borderSet = _s.borderFadeSets && _s.borderFadeSets[fadeLevel];
  if (borderSet) _s.drawBoxOnCtx(_s.ctx, borderSet, infoBoxX, infoBoxY, infoBoxW, infoBoxH);
  const floorsW = _s.measureText(_FLOORS_BYTES);
  _s.drawText(_s.ctx, infoBoxX + Math.floor((infoBoxW - floorsW) / 2), infoBoxY + 10, _FLOORS_BYTES, fadedTextPal);
  const bossContentX = infoBoxX + Math.floor((infoBoxW - bossRowW) / 2);
  const bossRowY = infoBoxY + 22;
  const bossFade = _s.bossFadeFrames;
  if (bossFade) _s.ctx.drawImage(bossFade[fadeLevel][Math.floor(_s.transTimer / 400) & 1], bossContentX, bossRowY);
  else if (_s.adamantoiseFrames) _s.ctx.drawImage(_s.adamantoiseFrames[0], bossContentX, bossRowY);
  _s.drawText(_s.ctx, bossContentX + 20, bossRowY + 4, _LODHP_BYTES, fadedTextPal);
}

function _drawLoadingRightPanel(fadeLevel) {
  const tiles = (_s.borderFadeSets && _s.borderFadeSets[fadeLevel]) || _s.borderTileCanvases;
  if (!tiles) return;
  const [TL, TOP, TR, LEFT, RIGHT, BL, BOT, BR] = tiles;
  const lx = _s.HUD_RIGHT_X, ly = _s.HUD_VIEW_Y + 32, lw = _s.HUD_RIGHT_W, lh = _s.HUD_VIEW_H - 32;
  const ctx = _s.ctx;
  ctx.fillStyle = '#000';
  ctx.fillRect(lx + 8, ly + 8, lw - 16, lh - 16);
  ctx.drawImage(TL, lx, ly); ctx.drawImage(TR, lx+lw-8, ly);
  ctx.drawImage(BL, lx, ly+lh-8); ctx.drawImage(BR, lx+lw-8, ly+lh-8);
  for (let tx = lx+8; tx < lx+lw-8; tx += 8) { ctx.drawImage(TOP, tx, ly); ctx.drawImage(BOT, tx, ly+lh-8); }
  for (let ty = ly+8; ty < ly+lh-8; ty += 8) { ctx.drawImage(LEFT, lx, ty); ctx.drawImage(RIGHT, lx+lw-8, ty); }
}

function _drawLoadingChatBubble(rpCX, rpY, rpH, fadeLevel) {
  const beatBytes = new Uint8Array([0x8B,0xCE,0xCA,0xDD,0xFF,0xDD,0xD1,0xCE]);
  const bossBytes = new Uint8Array([0x8B,0xD8,0xDC,0xDC,0xFF,0x94,0xDE,0xD9,0xD8,0xC4]);
  let fadedWhite = 0x30;
  for (let s = 0; s < fadeLevel; s++) fadedWhite = nesColorFade(fadedWhite);
  const whiteRgb = NES_SYSTEM_PALETTE[fadedWhite] || [0,0,0];
  const ctx = _s.ctx;
  ctx.fillStyle = `rgb(${whiteRgb[0]},${whiteRgb[1]},${whiteRgb[2]})`;
  const bgW = Math.max(_s.measureText(beatBytes), _s.measureText(bossBytes)) + 6;
  const bubbleX = Math.round(rpCX - bgW / 2);
  const bubbleY = rpY + Math.floor((rpH - (22 + 5 + 16)) / 2);
  ctx.beginPath(); ctx.roundRect(bubbleX, bubbleY, bgW, 22, 4); ctx.fill();
  const triCX = Math.round(bubbleX + bgW / 2);
  ctx.beginPath();
  ctx.moveTo(triCX-4, bubbleY+22); ctx.lineTo(triCX, bubbleY+27); ctx.lineTo(triCX+4, bubbleY+22);
  ctx.fill();
  const blackTextPal = [0x0F, fadedWhite, fadedWhite, 0x0F];
  _s.drawText(ctx, bubbleX+3, bubbleY+2,  beatBytes, blackTextPal);
  _s.drawText(ctx, bubbleX+3, bubbleY+12, bossBytes, blackTextPal);
  return bubbleY;
}

function _drawLoadingMoogleSprite(moogleX, moogleY, fadeLevel) {
  const moogleFade = _s.moogleFadeFrames;
  if (!moogleFade) return;
  _s.ctx.drawImage(moogleFade[fadeLevel][Math.floor(_s.transTimer / 400) & 1], moogleX, moogleY);
}

// --- Exported functions ---

export { LOAD_FADE_STEP_MS, LOAD_FADE_MAX };

export function drawLoadingOverlay(shared) {
  _s = shared;
  const fadeLevel = _calcFadeLevel();
  const fadedTextPal = _s.TEXT_WHITE.map((c, i) => {
    if (i === 0) return c;
    let fc = c; for (let s = 0; s < fadeLevel; s++) fc = nesColorFade(fc); return fc;
  });
  const vpTop = _s.HUD_VIEW_Y, vpBot = vpTop + _s.HUD_VIEW_H;
  const cx = _s.HUD_VIEW_X + _s.HUD_VIEW_W / 2;
  _drawLoadingBG(vpTop, fadeLevel);
  _drawLoadingInfoBox(cx, vpTop, vpBot, fadeLevel, fadedTextPal);
  const promptBytes = _s.isMobile
    ? new Uint8Array([0x99,0xDB,0xCE,0xDC,0xDC,0xFF,0x8A])
    : new Uint8Array([0x99,0xDB,0xCE,0xDC,0xDC,0xFF,0xA3]);
  if (loadingSt.state === 'in') {
    _s.drawText(_s.ctx, cx - _s.measureText(_LOADING_BYTES) / 2, vpBot - 32, _LOADING_BYTES, fadedTextPal);
  } else if (loadingSt.state === 'visible') {
    _s.drawText(_s.ctx, cx - _s.measureText(_LOADED_BYTES) / 2, vpBot - 32, _LOADED_BYTES, fadedTextPal);
    if (Math.floor(_s.transTimer / 500) % 2 === 0)
      _s.drawText(_s.ctx, cx - _s.measureText(promptBytes) / 2, vpBot - 20, promptBytes, fadedTextPal);
  } else if (loadingSt.state === 'out') {
    _s.drawText(_s.ctx, cx - _s.measureText(_LOADED_BYTES) / 2, vpBot - 32, _LOADED_BYTES, fadedTextPal);
  }
}

export function drawHUDLoadingMoogle(shared) {
  _s = shared;
  const fadeLevel = _calcFadeLevel();
  _drawLoadingRightPanel(fadeLevel);
  const rpCX = _s.HUD_RIGHT_X + Math.floor(_s.HUD_RIGHT_W / 2);
  const bubbleY = _drawLoadingChatBubble(rpCX, _s.HUD_VIEW_Y + 32, _s.HUD_VIEW_H - 32, fadeLevel);
  _drawLoadingMoogleSprite(Math.round(rpCX - 8), bubbleY + 30, fadeLevel);
}
