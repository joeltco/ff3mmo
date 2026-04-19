// Battle message strip — state, queue, timing, update logic
// Extracted from game.js for reuse across battle modules

import { BATTLE_VICTORY } from './data/strings.js';

// ── State ──────────────────────────────────────────────────────────────────
let battleMsgQueue = [];       // [{ bytes: Uint8Array, waitForZ: bool }]
let battleMsgCurrent = null;   // current message object or null
let battleMsgTimer = 0;        // ms into current message display

// ── Timing constants ───────────────────────────────────────────────────────
export const MSG_FADE_IN_MS = 200;
export const MSG_HOLD_MS = 800;
export const MSG_FADE_OUT_MS = 200;
export const MSG_TOTAL_MS = MSG_FADE_IN_MS + MSG_HOLD_MS + MSG_FADE_OUT_MS;

// ── Getters (for drawing + shared state objects) ───────────────────────────
export function getBattleMsgCurrent() { return battleMsgCurrent; }
export function getBattleMsgTimer() { return battleMsgTimer; }
export function getBattleMsgQueue() { return battleMsgQueue; }

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
  // Keep fade-in progress, reset hold from now
  if (battleMsgTimer > MSG_FADE_IN_MS) {
    battleMsgTimer = MSG_FADE_IN_MS;
  }
}

// ── Update (call once per frame) ───────────────────────────────────────────
export function updateBattleMsg(dt) {
  if (!battleMsgCurrent) return;
  battleMsgTimer += dt;
  if (battleMsgCurrent.persist) return;
  if (!battleMsgCurrent.waitForZ) {
    const textW = battleMsgCurrent.bytes.length * 8;
    const overflow = Math.max(0, textW - 112);
    const scrollTime = overflow > 0 ? 400 + overflow / 0.06 + 400 : 0;
    const totalMs = MSG_FADE_IN_MS + Math.max(MSG_HOLD_MS, scrollTime) + MSG_FADE_OUT_MS;
    if (battleMsgTimer >= totalMs) _advanceBattleMsg();
  }
}

// ── Z-advance (victory screen) ────────────────────────────────────────────
export function advanceBattleMsgZ() {
  if (battleMsgCurrent && battleMsgCurrent.waitForZ) {
    const textW = battleMsgCurrent.bytes.length * 8;
    const overflow = Math.max(0, textW - 112);
    const scrollTime = overflow > 0 ? 400 + overflow / 0.06 + 400 : 0;
    const minTime = MSG_FADE_IN_MS + Math.max(MSG_HOLD_MS, scrollTime);
    if (battleMsgTimer >= minTime) {
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

// ── Direct state set (for victory-text-out nulling) ────────────────────────
export function setBattleMsgCurrent(v) { battleMsgCurrent = v; }
