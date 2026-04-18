// World rendering pipeline — map, sprites, overlays, viewport effects

import { mapSt } from './map-state.js';
import { battleSt } from './battle-state.js';
import { transSt } from './transitions.js';
import { getFlameSprites, getFlameFrames, getStarTiles } from './flame-sprites.js';
import { _updateWorldWater, _updateIndoorWater } from './water-animation.js';
import { getMonsterDeathFrames } from './monster-sprites.js';
import { clipToViewport, grayViewport } from './hud-drawing.js';
import { DIR_DOWN, DIR_UP, DIR_LEFT, DIR_RIGHT } from './sprite.js';
import { poisonFlashTimer, setPoisonFlashTimer } from './movement.js';

const CANVAS_W = 256;
const CANVAS_H = 240;
const HUD_TOP_H = 32;
const HUD_VIEW_X = 0;
const HUD_VIEW_Y = HUD_TOP_H;
const HUD_VIEW_W = 144;
const HUD_VIEW_H = 144;
const SCREEN_CENTER_X = HUD_VIEW_X + (HUD_VIEW_W - 16) / 2;
const SCREEN_CENTER_Y = HUD_VIEW_Y + (HUD_VIEW_H - 16) / 2 - 3;

const BATTLE_FLASH_FRAMES = 65;
const BATTLE_FLASH_FRAME_MS = 16.67;

let ctx = null;
let getSprite = () => null;
let waterSt = null;

export function initRender(opts) {
  ctx = opts.ctx;
  getSprite = opts.getSprite;
  waterSt = opts.waterSt;
}

function _renderSprites(camX, camY, originX, originY, spriteY) {
  const _fs = getFlameSprites();
  if (!mapSt.onWorldMap && _fs.length > 0) {
    const flameFrame = Math.floor(waterSt.tick / 8) & 1;
    const wLeft = camX - originX;
    const wTop = camY - originY;
    const _ff = getFlameFrames();
    for (const flame of _fs) {
      const sx = flame.px - wLeft;
      const sy = flame.py - wTop;
      if (sx < -16 || sx > CANVAS_W || sy < -16 || sy > CANVAS_H) continue;
      const frames = _ff.get(flame.npcId);
      ctx.drawImage(frames[flameFrame], sx, sy);
    }
  }
  if (mapSt.bossSprite) {
    const blinkHidden = battleSt.bossFlashTimer > 0 && (Math.floor(battleSt.bossFlashTimer / 60) & 1);
    if (!blinkHidden) {
      const wLeft = camX - originX;
      const wTop = camY - originY;
      const bx = mapSt.bossSprite.px - wLeft;
      const by = mapSt.bossSprite.py - wTop;
      if (bx > -16 && bx < CANVAS_W && by > -16 && by < CANVAS_H) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(mapSt.bossSprite.frames[Math.floor(waterSt.tick / 8) & 1], bx, by);
      }
    }
  }
  const sprite = getSprite();
  if (sprite) sprite.draw(ctx, SCREEN_CENTER_X, spriteY);
}

function _renderMapAndWater(camX, camY, originX, originY, spriteY) {
  if (mapSt.onWorldMap && mapSt.worldMapRenderer) {
    mapSt.worldMapRenderer.draw(ctx, camX, camY, originX, originY);
    _updateWorldWater(mapSt.worldMapRenderer, waterSt.tick);
  } else if (mapSt.mapRenderer) {
    mapSt.mapRenderer.draw(ctx, camX, camY, originX, originY);
    _updateIndoorWater(mapSt.mapRenderer, waterSt.tick);
  }
  if (transSt.state === 'none' &&
      (battleSt.battleState === 'none' || battleSt.battleState === 'flash-strobe' || battleSt.battleState.startsWith('roar-'))) {
    _renderSprites(camX, camY, originX, originY, spriteY);
  }
  if (mapSt.onWorldMap && mapSt.worldMapRenderer) {
    mapSt.worldMapRenderer.drawOverlay(ctx, camX, camY, originX, originY, SCREEN_CENTER_X, spriteY);
  } else if (mapSt.mapRenderer) {
    mapSt.mapRenderer.drawOverlay(ctx, camX, camY, originX, originY, SCREEN_CENTER_X, spriteY);
  }
}

function _renderStarSpiral() {
  const _st = getStarTiles();
  if (!mapSt.starEffect || !_st) return;
  const { radius, angle, frame } = mapSt.starEffect;
  const tile = _st[(frame >> 4) & 1];
  for (let i = 0; i < 8; i++) {
    const a = angle + i * Math.PI / 4;
    ctx.drawImage(tile,
      Math.round(SCREEN_CENTER_X + 8 + radius * Math.cos(a) - 8),
      Math.round(SCREEN_CENTER_Y + 8 + radius * Math.sin(a) - 8));
  }
}

export function render() {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  let camX = Math.round(mapSt.worldX);
  const camY = Math.round(mapSt.worldY);
  if (mapSt.shakeActive) camX += (Math.floor(mapSt.shakeTimer / (1000 / 60)) & 2) ? 2 : -2;
  if (battleSt.battleShakeTimer > 0) camX += (Math.floor(battleSt.battleShakeTimer / (1000 / 60)) & 2) ? 2 : -2;

  clipToViewport();
  try {
    _renderMapAndWater(camX, camY, SCREEN_CENTER_X, SCREEN_CENTER_Y + 3, SCREEN_CENTER_Y);
    _renderStarSpiral();
  } finally {
    ctx.restore();
  }
}

export function drawMonsterDeath(x, y, size, progress, monsterId) {
  const frames = getMonsterDeathFrames(monsterId, battleSt.goblinDeathFrames);
  if (!frames || !frames.length) return;
  const frameIdx = Math.min(frames.length - 1, Math.floor(progress * frames.length));
  ctx.drawImage(frames[frameIdx], x, y);
}

export function drawPoisonFlash() {
  if (poisonFlashTimer < 0) return;
  if (poisonFlashTimer === 0) setPoisonFlashTimer(Date.now());
  if (Date.now() - poisonFlashTimer < 67) {
    clipToViewport();
    ctx.fillStyle = 'rgba(128, 0, 64, 0.35)';
    ctx.fillRect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);
    ctx.restore();
  } else { setPoisonFlashTimer(-1); }
}

export function drawPondStrobe() {
  if (mapSt.pondStrobeTimer <= 0) return;
  const frame = Math.floor((BATTLE_FLASH_FRAMES * BATTLE_FLASH_FRAME_MS - mapSt.pondStrobeTimer) / BATTLE_FLASH_FRAME_MS);
  if (!(frame & 1)) return;
  clipToViewport();
  grayViewport();
}

export function updateStarEffect(dt) {
  if (!mapSt.starEffect) return;
  const fx = mapSt.starEffect;
  fx.acc = (fx.acc || 0) + dt;
  while (fx.acc >= 16.67) {
    fx.acc -= 16.67;
    fx.frame++;
    fx.angle += 0.06;
    fx.radius -= 0.55;
    if (fx.spin && fx.frame % 14 === 0) {
      const SPIN_ORDER = [DIR_DOWN, DIR_LEFT, DIR_UP, DIR_RIGHT];
      const sprite = getSprite();
      if (sprite) sprite.setDirection(SPIN_ORDER[Math.floor(fx.frame / 14) % 4]);
    }
    if (fx.radius < 4) {
      const cb = fx.onComplete;
      mapSt.starEffect = null;
      if (cb) cb();
      break;
    }
  }
}
