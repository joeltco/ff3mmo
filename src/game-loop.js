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
import { updateChat, updateChatTabs, drawChat, drawChatTabs, isDev, consoleLog } from './chat.js';
import { rosterBattleFade, updateRoster, drawRoster, drawRosterMenu } from './roster.js';
import { tickPVPSearch } from './pvp-search.js';
import { updateMsgBox, drawMsgBox } from './message-box.js';
import { titleSt, drawTitleSkyInHUD, drawTitle, updateTitle } from './title-screen.js';
import { updatePauseMenu, drawPauseMenu } from './pause-menu.js';
import { drawShop, updateShop } from './shop.js';
import { transSt, loadingSt, updateTransition, updateTopBoxScroll,
         drawTransitionOverlay, WIPE_DURATION } from './transitions.js';
import { handleInput, updateMovement } from './movement.js';
import { updateBattle } from './battle-update.js';
import { pvpSt } from './pvp.js';
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

function _battleCtx() {
  return {
    state: battleSt.battleState,
    timer: Math.round(battleSt.battleTimer),
    queueLen: battleSt.turnQueue ? battleSt.turnQueue.length : -1,
    pvp: pvpSt.isPVPBattle,
    pvpAllyIdx: pvpSt.pvpCurrentEnemyAllyIdx,
    pvpPreflashDecided: pvpSt.pvpPreflashDecided,
    psHp: ps.hp,
    psHasStatus: !!(ps.status && ps.status.mask),
    allyCount: battleSt.battleAllies ? battleSt.battleAllies.length : 0,
    enemyAllies: pvpSt.pvpEnemyAllies ? pvpSt.pvpEnemyAllies.length : 0,
  };
}

// In-game error surface so the dev sees crashes without browser dev tools or
// pm2 log tailing. Dev-gated (non-devs see "Unknown command" for /devhelp,
// they don't need to see error spam). Same message rate-limited per-tag so a
// throwing-every-frame draw fn doesn't flood the chat buffer — the first hit
// is what matters; subsequent identical errors bump a counter.
const _errSeen = new Map();  // tag+msg → { count, lastShown }
function _reportError(tag, e) {
  const ctx = _battleCtx();
  console.error('[' + tag + ']', e, ctx);
  fetch('/api/client-error', { method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ msg: '[' + tag + '] ' + e.message, stack: e.stack, ctx }) }).catch(() => {});
  if (isDev()) {
    const key = tag + '::' + (e.message || '');
    const seen = _errSeen.get(key) || { count: 0, lastShown: 0 };
    seen.count++;
    // Show on first occurrence + every 60 hits after (keeps the buffer alive).
    if (seen.count === 1 || (seen.count % 60 === 0)) {
      consoleLog('[' + tag + '] ' + (e.message || 'unknown') + (seen.count > 1 ? ' (x' + seen.count + ')' : ''));
      // Stack frame closest to user code — strip URL + col, keep file:line.
      const firstFrame = (e.stack || '').split('\n').find(l => l.includes('/src/'));
      if (firstFrame) {
        const m = firstFrame.match(/(\w+)@.*\/src\/(\S+\.js):(\d+)/);
        if (m) consoleLog('  ' + m[1] + ' (' + m[2] + ':' + m[3] + ')');
      }
      seen.lastShown = seen.count;
    }
    _errSeen.set(key, seen);
  }
}

// ── Freeze watchdog ──────────────────────────────────────────────────────────
// Catches state-machine freezes that don't throw exceptions (a state with no
// advance handler — exactly the class of bug that hit 1.7.42). If battleState
// stays in a non-idle state for >5s without changing AND battleTimer keeps
// growing, fire one report per stuck spell so the server log can identify the
// orphan state. Idle states (menu-open, target-select, item-*) are excluded
// because they wait on user input.
const FREEZE_THRESHOLD_MS = 5000;
const _frozenIdleStates = new Set([
  'menu-open', 'target-select', 'confirm-pause',
  'item-menu-out', 'item-list-in', 'item-select', 'item-cancel-out', 'item-cancel-in',
  'item-list-out', 'item-slide', 'item-target-select', 'item-use-menu-in',
  'message-hold', 'msg-wait',
  'none', 'roar-hold', 'victory-msg',
  'exp-hold', 'gil-hold', 'cp-hold', 'item-hold',
]);
let _watchState = null;
let _watchSince = 0;
let _watchReported = false;
function _tickFreezeWatchdog(now) {
  const cur = battleSt.battleState;
  if (!cur || cur === 'none' || _frozenIdleStates.has(cur)) {
    _watchState = cur;
    _watchSince = now;
    _watchReported = false;
    return;
  }
  if (cur !== _watchState) {
    _watchState = cur;
    _watchSince = now;
    _watchReported = false;
    return;
  }
  if (!_watchReported && now - _watchSince >= FREEZE_THRESHOLD_MS) {
    _watchReported = true;
    const ctx = _battleCtx();
    const msg = '[FREEZE WATCHDOG] state=' + cur + ' stuck for ' + Math.round((now - _watchSince) / 1000) + 's';
    console.error(msg, ctx);
    fetch('/api/client-error', { method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ msg, stack: '', ctx }) }).catch(() => {});
  }
}

function _gameLoopUpdate(dt) {
  if (hudSt.hudInfoFadeTimer < HUD_INFO_FADE_STEPS * HUD_INFO_FADE_STEP_MS) hudSt.hudInfoFadeTimer += dt;
  updateHudHpLvStep(dt);
  handleInput();
  updateRoster(dt);
  tickPVPSearch(dt);
  updateChat(dt, battleSt.battleState);
  updateChatTabs(dt);
  updatePauseMenu(dt);
  updateShop(dt);
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
    drawShop();
    drawMsgBox(ctx, drawBorderedBox);
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
    _reportError('GAME LOOP ERROR', e);
    requestAnimationFrame(gameLoop);
    return;
  }

  _tickFreezeWatchdog(timestamp);
  requestAnimationFrame(gameLoop);
}

export function startGameLoop() {
  lastTime = performance.now();
  // Global handlers — catch anything that escaped the per-frame try/catch,
  // including async failures (fetch/setTimeout) that would otherwise be silent.
  if (!window._ff3mmoErrorHandlersInstalled) {
    window._ff3mmoErrorHandlersInstalled = true;
    window.addEventListener('error', (ev) => {
      _reportError('WINDOW ERROR', ev.error || { message: ev.message, stack: '' });
    });
    window.addEventListener('unhandledrejection', (ev) => {
      const r = ev.reason;
      _reportError('UNHANDLED REJECTION', r instanceof Error ? r : { message: String(r), stack: '' });
    });
  }
  requestAnimationFrame(gameLoop);
}
