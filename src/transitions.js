// transitions.js — wipe transitions, loading screen state, top-box area name

import { playSFX, playTrack, SFX, TRACKS } from './music.js';
import { DIR_LEFT, DIR_UP, DIR_RIGHT, DIR_DOWN } from './sprite.js';

// NES layout constants — must match game.js
const HUD_VIEW_X = 0;
const HUD_VIEW_Y = 32;
const HUD_VIEW_W = 144;
const HUD_VIEW_H = 144;

// Transition timing constants
const WIPE_DURATION          = 44 * (1000 / 60);  // 44 NES frames ≈ 733ms
const WIPE_HOLD              = 100;
const DOOR_OPEN_DURATION     = 400;
const TRAP_REVEAL_DURATION   = 400;
const SPIN_DIRS_ORDER        = [DIR_LEFT, DIR_UP, DIR_RIGHT, DIR_DOWN];
const SPIN_INTERVAL          = 110;
const SPIN_CYCLES            = 4;
const HUD_INFO_FADE_STEPS    = 4;
const HUD_INFO_FADE_STEP_MS  = 200;
const LOAD_FADE_STEP_MS      = 133;
const LOAD_FADE_MAX          = 4;
const TOPBOX_FADE_STEP_MS    = 100;
const TOPBOX_FADE_STEPS      = 4;
const TOPBOX_DISPLAY_HOLD    = 1800;

// ── Mutable state ──────────────────────────────────────────────────────────

export const transSt = {
  state:              'none',  // 'none'|'door-opening'|'trap-reveal'|'trap-falling'|'closing'|'hold'|'loading'|'opening'|'hud-fade-in'
  timer:              0,
  pendingAction:      null,
  pendingTrack:       null,   // track to play when 'hud-fade-in' transitions to 'opening'
  dungeon:            false,
  trapFallPending:    false,
  trapShakePending:   false,
  rosterLocChanged:   false,
  topBoxAlreadyBright: false,
};

export const topBoxSt = {
  state:   'none',    // 'none'|'pending'|'fade-in'|'display'|'fade-out'
  timer:   0,
  fadeStep: 0,        // 0 = full bright, 4 = fully black ($0F)
  isTown:  false,     // true = always show name
  nameBytes: null,    // Uint8Array for area name text
  onDone:  null,      // callback when fade-out finishes
};

export const loadingSt = {
  state:    'none',  // 'in'|'visible'|'out'|'none'
  timer:    0,
  bgScroll: 0,
};

// ── Public API ─────────────────────────────────────────────────────────────

// rosterLocChanged: pre-computed by game.js via _transLocChanged(destMapId)
export function startWipeTransition(action, destMapId, rosterLocChanged = false) {
  transSt.state          = 'closing';
  transSt.timer          = 0;
  transSt.rosterLocChanged = rosterLocChanged;
  transSt.pendingAction  = action;
  playSFX(SFX.SCREEN_CLOSE);
}

// shared = { sprite, keys, onShake }
// onShake(): triggers the earthquake shake effect in game.js
export function updateTransition(dt, shared) {
  if (transSt.state === 'none') return;
  transSt.timer += dt;
  if (transSt.state === 'hud-fade-out') {
    if (transSt.timer >= (HUD_INFO_FADE_STEPS + 1) * HUD_INFO_FADE_STEP_MS) {
      transSt.state = 'none';
      if (transSt.pendingAction) { transSt.pendingAction(); transSt.pendingAction = null; }
    }
    return;
  }
  if (transSt.state === 'hud-fade-in') {
    if (transSt.timer >= (HUD_INFO_FADE_STEPS + 1) * HUD_INFO_FADE_STEP_MS) {
      transSt.state = 'opening'; transSt.timer = 0; transSt.topBoxAlreadyBright = true;
      playSFX(SFX.SCREEN_OPEN);
      if (transSt.pendingTrack != null) { playTrack(transSt.pendingTrack); transSt.pendingTrack = null; }
    }
    return;
  } else if (transSt.state === 'trap-reveal') {
    if (transSt.timer >= TRAP_REVEAL_DURATION) { transSt.state = 'closing'; transSt.timer = 0; playSFX(SFX.SCREEN_CLOSE); }
  } else if (transSt.state === 'trap-falling') { _updateTransitionTrapFall(shared);
  } else if (transSt.state === 'door-opening') {
    if (transSt.timer >= DOOR_OPEN_DURATION) { transSt.state = 'closing'; transSt.timer = 0; playSFX(SFX.SCREEN_CLOSE); }
  } else if (transSt.state === 'closing') { _updateTransitionClosing();
  } else if (transSt.state === 'hold') { _updateTransitionHold();
  } else if (transSt.state === 'loading') { _updateTransitionLoading(dt, shared);
  } else if (transSt.state === 'opening') { _updateTransitionOpening(shared);
  }
}

export function updateTopBoxScroll(dt) {
  if (topBoxSt.state === 'none') return;

  if (topBoxSt.state === 'pending') {
    if (transSt.state === 'none') {
      topBoxSt.state = 'fade-in';
      topBoxSt.timer = 0;
      topBoxSt.fadeStep = TOPBOX_FADE_STEPS;
    }
    return;
  }

  topBoxSt.timer += Math.min(dt, 33);

  if (topBoxSt.state === 'fade-in') {
    topBoxSt.fadeStep = TOPBOX_FADE_STEPS - Math.min(Math.floor(topBoxSt.timer / TOPBOX_FADE_STEP_MS), TOPBOX_FADE_STEPS);
    if (topBoxSt.timer >= (TOPBOX_FADE_STEPS + 1) * TOPBOX_FADE_STEP_MS) {
      topBoxSt.fadeStep = 0;
      if (topBoxSt.isTown) {
        topBoxSt.state = 'none';
      } else {
        topBoxSt.state = 'display';
        topBoxSt.timer = 0;
      }
    }
  } else if (topBoxSt.state === 'display') {
    if (transSt.state !== 'loading' && topBoxSt.timer >= TOPBOX_DISPLAY_HOLD) {
      topBoxSt.state = 'fade-out';
      topBoxSt.timer = 0;
    }
  } else if (topBoxSt.state === 'fade-out') {
    topBoxSt.fadeStep = Math.min(Math.floor(topBoxSt.timer / TOPBOX_FADE_STEP_MS), TOPBOX_FADE_STEPS);
    if (topBoxSt.timer >= (TOPBOX_FADE_STEPS + 1) * TOPBOX_FADE_STEP_MS) {
      topBoxSt.state = 'none';
      topBoxSt.fadeStep = TOPBOX_FADE_STEPS;
      topBoxSt.nameBytes = null;
      if (topBoxSt.onDone) {
        const cb = topBoxSt.onDone;
        topBoxSt.onDone = null;
        cb();
      }
    }
  }
}

// shared = { drawLoadingOverlay }
export function drawTransitionOverlay(ctx, shared) {
  if (transSt.state === 'none' || transSt.state === 'door-opening') return;
  if (transSt.state === 'hud-fade-out') {
    const alpha = Math.min(transSt.timer / ((HUD_INFO_FADE_STEPS + 1) * HUD_INFO_FADE_STEP_MS), 1);
    ctx.fillStyle = `rgba(0,0,0,${alpha})`;
    ctx.fillRect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);
    return;
  }
  if (transSt.state === 'hud-fade-in') {
    ctx.fillStyle = '#000';
    ctx.fillRect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);
    return;
  }

  const halfH = HUD_VIEW_H / 2;
  let barHeight = halfH;

  if (transSt.state === 'closing') {
    barHeight = Math.min(transSt.timer / WIPE_DURATION, 1) * halfH;
  } else if (transSt.state === 'opening') {
    barHeight = (1 - Math.min(transSt.timer / WIPE_DURATION, 1)) * halfH;
  }

  ctx.fillStyle = '#000';
  ctx.fillRect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, Math.ceil(barHeight));
  ctx.fillRect(HUD_VIEW_X, HUD_VIEW_Y + HUD_VIEW_H - Math.ceil(barHeight), HUD_VIEW_W, Math.ceil(barHeight));

  if (transSt.state === 'loading') shared.drawLoadingOverlay();
}

// ── Private helpers ────────────────────────────────────────────────────────

function _updateTransitionClosing() {
  if (transSt.timer < WIPE_DURATION) return;
  if (transSt.trapFallPending) {
    transSt.trapFallPending = false;
    transSt.state = 'trap-falling'; transSt.timer = 0;
    playSFX(SFX.FALL);
  } else {
    transSt.state = 'hold'; transSt.timer = 0;
    if (!transSt.dungeon && transSt.pendingAction) { transSt.pendingAction(); transSt.pendingAction = null; }
  }
}

function _updateTransitionHold() {
  if (transSt.timer < WIPE_HOLD) return;
  if (transSt.dungeon) {
    transSt.state = 'loading'; transSt.timer = 0;
    loadingSt.state = 'in'; loadingSt.timer = 0; loadingSt.bgScroll = 0;
    playTrack(TRACKS.PIANO_3);
    if (transSt.pendingAction) { transSt.pendingAction(); transSt.pendingAction = null; }
    if (topBoxSt.nameBytes) {
      topBoxSt.state = 'fade-in'; topBoxSt.timer = 0; topBoxSt.fadeStep = TOPBOX_FADE_STEPS;
    }
  } else {
    transSt.state = 'opening'; transSt.timer = 0;
    playSFX(SFX.SCREEN_OPEN);
    if (topBoxSt.state === 'pending') {
      topBoxSt.state = 'fade-in'; topBoxSt.timer = 0; topBoxSt.fadeStep = TOPBOX_FADE_STEPS;
    }
  }
}

function _updateTransitionLoading(dt, shared) {
  loadingSt.timer += dt;
  loadingSt.bgScroll += dt * 0.08;
  if (loadingSt.state === 'in') {
    if (loadingSt.timer >= (LOAD_FADE_MAX + 1) * LOAD_FADE_STEP_MS) {
      loadingSt.state = 'visible'; loadingSt.timer = 0;
    }
  } else if (loadingSt.state === 'out') {
    if (loadingSt.timer >= (LOAD_FADE_MAX + 1) * LOAD_FADE_STEP_MS) {
      loadingSt.state = 'none'; transSt.state = 'opening'; transSt.timer = 0;
      transSt.dungeon = false; playSFX(SFX.SCREEN_OPEN); playTrack(TRACKS.CRYSTAL_CAVE);
    }
  }
  const keys = shared.keys;
  if (loadingSt.state === 'visible' && (keys['z'] || keys['Z'])) {
    keys['z'] = false; keys['Z'] = false;
    loadingSt.state = 'out'; loadingSt.timer = 0;
    if (topBoxSt.state !== 'none' && topBoxSt.state !== 'fade-out') {
      topBoxSt.state = 'fade-out'; topBoxSt.timer = 0; topBoxSt.fadeStep = 0;
    }
  }
}

function _updateTransitionTrapFall(shared) {
  const totalSpinTime = SPIN_INTERVAL * SPIN_DIRS_ORDER.length * SPIN_CYCLES;
  shared.sprite.setDirection(SPIN_DIRS_ORDER[Math.floor(transSt.timer / SPIN_INTERVAL) % SPIN_DIRS_ORDER.length]);
  if (transSt.timer >= totalSpinTime) {
    if (transSt.pendingAction) { transSt.pendingAction(); transSt.pendingAction = null; }
    transSt.trapShakePending = true; transSt.state = 'opening'; transSt.timer = 0; playSFX(SFX.SCREEN_OPEN);
  }
}

function _updateTransitionOpening(shared) {
  if (transSt.timer >= WIPE_DURATION) {
    transSt.state = 'none'; transSt.timer = 0; transSt.rosterLocChanged = false; transSt.topBoxAlreadyBright = false;
    if (transSt.trapShakePending) {
      transSt.trapShakePending = false;
      playSFX(SFX.EARTHQUAKE);
      shared.onShake();
    }
  }
}
