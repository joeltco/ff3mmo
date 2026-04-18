// Game loop — frame driver, update dispatch, draw dispatch.
// Kicked off via startGameLoop() after title or debug-mode boot.

import { hudSt, HUD_INFO_FADE_STEPS, HUD_INFO_FADE_STEP_MS } from './hud-state.js';
import { mapSt } from './map-state.js';
import { battleSt } from './battle-state.js';
import { ui } from './ui-state.js';
import { ROSTER_FADE_STEPS } from './data/players.js';
import { ps } from './player-stats.js';
import { sprite } from './player-sprite.js';
import { waterSt, tickWater } from './water-animation.js';
import { updateChat, updateChatTabs, drawChat, drawChatTabs } from './chat.js';
import { rosterBattleFade, updateRoster, drawRoster, drawRosterMenu } from './roster.js';
import { updateMsgBox, drawMsgBox } from './message-box.js';
import { titleSt, drawTitleSkyInHUD, drawTitle, updateTitle } from './title-screen.js';
import { updatePauseMenu, drawPauseMenu } from './pause-menu.js';
import { transSt, loadingSt, updateTransition, updateTopBoxScroll,
         drawTransitionOverlay, WIPE_DURATION } from './transitions.js';
import { handleInput, updateMovement } from './movement.js';
import { updateBattle } from './battle-update.js';
import { drawBattle, drawBattleAllies, drawSWExplosion, drawSWDamageNumbers } from './battle-drawing.js';
import { render, drawPoisonFlash, drawPondStrobe, updateStarEffect } from './render.js';
import { drawHUD, clipToViewport, drawHudBox, drawBorderedBox,
         roundTopBoxCorners, updateHudHpLvStep } from './hud-drawing.js';
import { LOAD_FADE_STEP_MS, LOAD_FADE_MAX } from './loading-screen.js';

const CANVAS_W = 256;
const CANVAS_H = 240;
const SCREEN_CENTER_X = 64;   // viewport center x for trap-falling draw
const SCREEN_CENTER_Y = 93;   // viewport center y for trap-falling draw
const SHAKE_DURATION = 34 * (1000 / 60);  // 2 × 17 NES frames ≈ 567ms

let lastTime = 0;
let _tabWasLoading = false;   // tracks if we just came from a loading screen

function _reportError(tag, e) {
  console.error('[' + tag + ']', e);
  fetch('/api/client-error', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ msg: e.message, stack: e.stack }) }).catch(() => {});
}

function _gameLoopUpdate(dt) {
  if (hudSt.hudInfoFadeTimer < HUD_INFO_FADE_STEPS * HUD_INFO_FADE_STEP_MS) hudSt.hudInfoFadeTimer += dt;
  updateHudHpLvStep(dt);
  handleInput();
  updateRoster(dt);
  updateChat(dt, battleSt.battleState);
  updateChatTabs(dt);
  updatePauseMenu(dt);
  updateMsgBox(dt);
  updateBattle(dt);
  updateMovement(dt);
  updateTransition(dt);
  updateTopBoxScroll(dt);
  if (mapSt.pondStrobeTimer > 0) mapSt.pondStrobeTimer = Math.max(0, mapSt.pondStrobeTimer - dt);
  if (mapSt.shakeActive) {
    mapSt.shakeTimer += dt;
    if (mapSt.shakeTimer >= SHAKE_DURATION) {
      mapSt.shakeActive = false;
      if (mapSt.shakePendingAction) { mapSt.shakePendingAction(); mapSt.shakePendingAction = null; }
    }
  }
  updateStarEffect(dt);
  tickWater(dt);
}

function _gameLoopDraw() {
  const ctx = ui.ctx;
  try {
    render();
    drawPoisonFlash();
    drawTransitionOverlay(ctx);
    drawPondStrobe();
    if (transSt.state === 'trap-falling' && sprite) sprite.draw(ctx, SCREEN_CENTER_X, SCREEN_CENTER_Y);
  } catch (e) { _reportError('RENDER ERROR', e); }
  // Draw tabs BEFORE HUD so static HUD canvas draws on top of tab overlap
  const _infoFade = HUD_INFO_FADE_STEPS - Math.min(Math.floor(hudSt.hudInfoFadeTimer / HUD_INFO_FADE_STEP_MS), HUD_INFO_FADE_STEPS);
  let _tabFade = Math.max(rosterBattleFade, _infoFade);
  const _wFadeMs = WIPE_DURATION / ROSTER_FADE_STEPS;
  if (transSt.dungeon && transSt.state === 'closing') _tabFade = Math.max(_tabFade, Math.min(Math.floor(transSt.timer / _wFadeMs), ROSTER_FADE_STEPS));
  else if (transSt.dungeon && (transSt.state === 'hold' || transSt.state === 'trap-falling')) _tabFade = ROSTER_FADE_STEPS;
  else if (transSt.state === 'loading') {
    _tabWasLoading = true;
    _tabFade = ROSTER_FADE_STEPS;
    if (loadingSt.state === 'out') _tabFade = LOAD_FADE_MAX - Math.min(Math.floor(loadingSt.timer / LOAD_FADE_STEP_MS), LOAD_FADE_MAX);
  }
  else if (transSt.state === 'opening' && _tabWasLoading) _tabFade = Math.max(_tabFade, ROSTER_FADE_STEPS - Math.min(Math.floor(transSt.timer / _wFadeMs), ROSTER_FADE_STEPS));
  else _tabWasLoading = false;
  drawChatTabs(ctx, _tabFade, drawHudBox);
  drawHUD();
  try {
    if (battleSt.battleAllies.length > 0 && battleSt.battleState !== 'none') drawBattleAllies();
    else drawRoster();
    drawChat(ctx, drawHudBox, rosterBattleFade);
    drawPauseMenu(ctx);
    drawMsgBox(ctx, clipToViewport, drawBorderedBox);
    drawRosterMenu();
    drawBattle();
    drawSWExplosion();
    drawSWDamageNumbers();
  } catch (e) { _reportError('BATTLE DRAW ERROR', e); }
  if (transSt.state === 'hud-fade-out') {
    const alpha = Math.min(transSt.timer / ((HUD_INFO_FADE_STEPS + 1) * HUD_INFO_FADE_STEP_MS), 1);
    ctx.fillStyle = `rgba(0,0,0,${alpha})`;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  }
}

function gameLoop(timestamp) {
  const dt = Math.min(timestamp - lastTime, 50); // cap at 50ms to prevent frame-spike skipping animations
  lastTime = timestamp;
  const ctx = ui.ctx;

  if (titleSt.state !== 'done') {
    updateTitle(dt); drawTitle(ctx, waterSt.tick); drawHUD();
    if (titleSt.state !== 'done') drawTitleSkyInHUD(ctx, roundTopBoxCorners); // guard: updateTitle may have set titleSt.state='done'
    updateChat(dt, 'none', true);
    drawChat(ctx, drawHudBox, 0, true);
    requestAnimationFrame(gameLoop);
    return;
  }

  ps.playTime += dt / 1000;

  try {
    _gameLoopUpdate(dt);
    _gameLoopDraw();
  } catch (e) {
    console.error('[GAME LOOP ERROR] transSt.state=' + transSt.state + ' battleSt.battleState=' + battleSt.battleState, e);
    requestAnimationFrame(gameLoop);
    return;
  }

  requestAnimationFrame(gameLoop);
}

export function startGameLoop() {
  lastTime = performance.now();
  requestAnimationFrame(gameLoop);
}
