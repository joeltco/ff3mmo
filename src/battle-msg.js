// Battle message strip — state, queue, timing, update logic.
// Single source of truth for the message-strip layout, timings, and
// scroll math; battle-drawing imports from here so the strip render and
// the queue advance can never disagree.

import { BATTLE_VICTORY } from './data/strings.js';
import { measureText } from './font-renderer.js';

// ── State ──────────────────────────────────────────────────────────────────
let battleMsgQueue = [];       // [{ bytes: Uint8Array, waitForZ: bool }]
let battleMsgCurrent = null;   // current message object or null
let battleMsgTimer = 0;        // ms into current message display

// ── Timing constants ───────────────────────────────────────────────────────
export const MSG_FADE_IN_MS  = 200;
export const MSG_HOLD_MS     = 800;
export const MSG_FADE_OUT_MS = 200;

// ── Strip layout (shared with battle-drawing) ──────────────────────────────
export const MSG_STRIP_X = 144;
export const MSG_STRIP_Y = 160;
export const MSG_STRIP_W = 112;

// ── Scroll constants (shared with battle-drawing) ──────────────────────────
export const MSG_SCROLL_PAUSE_MS    = 400;  // pause before/after scroll travel
export const MSG_SCROLL_SPEED_PX_MS = 0.06; // px traveled per ms

// ── Per-message timings (single source) ────────────────────────────────────
// Both the queue advance and the strip render derive from this — guarantees
// the message disappears the same frame the fade-out finishes.
export function computeMsgTimings(msg) {
  const tw = measureText(msg.bytes);
  const overflow = Math.max(0, tw - MSG_STRIP_W);
  const scrollMs = overflow > 0 ? overflow / MSG_SCROLL_SPEED_PX_MS : 0;
  const scrollTime = overflow > 0
    ? MSG_SCROLL_PAUSE_MS + scrollMs + MSG_SCROLL_PAUSE_MS
    : 0;
  const hold = Math.max(MSG_HOLD_MS, scrollTime);
  return {
    tw, overflow, scrollMs, hold,
    total: MSG_FADE_IN_MS + hold + MSG_FADE_OUT_MS,
  };
}

// ── Getters (for drawing + shared state objects) ───────────────────────────
export function getBattleMsgCurrent() { return battleMsgCurrent; }
export function getBattleMsgTimer() { return battleMsgTimer; }

// ── Queue / advance ────────────────────────────────────────────────────────
export function queueBattleMsg(bytes, waitForZ = false) {
  battleMsgQueue.push({ bytes, waitForZ });
  if (!battleMsgCurrent) _advanceBattleMsg();
}

function _advanceBattleMsg() {
  if (battleMsgQueue.length > 0) {
    battleMsgCurrent = battleMsgQueue.shift();
    battleMsgTimer = 0;
  } else {
    battleMsgCurrent = null;
  }
}

// ── Replace current message text (no fade restart) ─────────────────────────
// Swaps text mid-display. Keeps the fade-in already done, resets hold timer
// so the new text gets its full display time.
export function replaceBattleMsg(bytes) {
  if (!battleMsgCurrent) {
    queueBattleMsg(bytes);
    return;
  }
  battleMsgCurrent = { ...battleMsgCurrent, bytes };
  if (battleMsgTimer > MSG_FADE_IN_MS) battleMsgTimer = MSG_FADE_IN_MS;
}

// ── Update (call once per frame) ───────────────────────────────────────────
export function updateBattleMsg(dt) {
  if (!battleMsgCurrent) return;
  battleMsgTimer += dt;
  if (battleMsgCurrent.persist || battleMsgCurrent.waitForZ) return;
  if (battleMsgTimer >= computeMsgTimings(battleMsgCurrent).total) _advanceBattleMsg();
}

// ── Z-advance (victory screen / waitForZ messages) ─────────────────────────
export function advanceBattleMsgZ() {
  if (battleMsgCurrent && battleMsgCurrent.waitForZ) {
    const { hold } = computeMsgTimings(battleMsgCurrent);
    if (battleMsgTimer >= MSG_FADE_IN_MS + hold) {
      _advanceBattleMsg();
      return true;
    }
  }
  return false;
}

// ── Busy check ─────────────────────────────────────────────────────────────
export function isBattleMsgBusy() {
  return battleMsgCurrent !== null;
}

// ── Clear all ──────────────────────────────────────────────────────────────
export function clearBattleMsgQueue() {
  battleMsgQueue = [];
  battleMsgCurrent = null;
  battleMsgTimer = 0;
}

// ── Victory persist ────────────────────────────────────────────────────────
export function queueVictoryRewards() {
  battleMsgCurrent = { bytes: BATTLE_VICTORY, waitForZ: false, persist: true };
  battleMsgTimer = 0;
}

// `queueVictoryRewards` puts a `persist: true` message in `battleMsgCurrent` that
// `updateBattleMsg` refuses to time out. Call this when victory text-out finishes.
export function clearVictoryPersist() {
  if (battleMsgCurrent && battleMsgCurrent.persist) battleMsgCurrent = null;
}
