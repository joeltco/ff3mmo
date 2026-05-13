// Battle message strip — state, timing, render-side math.
// Single entry point: every caller writes to `queueBattleMsg` (or its alias
// `replaceBattleMsg`). New text always cuts in immediately — if a message is
// already on screen, the text swaps without re-fading and the hold timer
// resets so the new text gets its full display time. The strip drains on
// its own clock and never gates the battle state machine.

import { BATTLE_VICTORY } from './data/strings.js';
import { measureText } from './font-renderer.js';

// ── State ──────────────────────────────────────────────────────────────────
let battleMsgCurrent = null;   // { bytes, persist? } or null
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
export const MSG_SCROLL_PAUSE_MS    = 400;
export const MSG_SCROLL_SPEED_PX_MS = 0.06;

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

export function getBattleMsgCurrent() { return battleMsgCurrent; }
export function getBattleMsgTimer() { return battleMsgTimer; }

// Show a message. If nothing is on screen, fades in from scratch. If a
// message is already displaying, swaps the text in place — preserves the
// fade-in already paid for, rewinds to "just past fade-in" so the new text
// gets a full hold.
export function queueBattleMsg(bytes) {
  if (!battleMsgCurrent) {
    battleMsgCurrent = { bytes };
    battleMsgTimer = 0;
    return;
  }
  battleMsgCurrent = { ...battleMsgCurrent, bytes };
  if (battleMsgTimer > MSG_FADE_IN_MS) battleMsgTimer = MSG_FADE_IN_MS;
}

// Alias kept for call-site readability — `replaceBattleMsg` reads as "swap
// in follow-up detail (crit/hits/status)"; both go through the same path.
export const replaceBattleMsg = queueBattleMsg;

export function updateBattleMsg(dt) {
  if (!battleMsgCurrent) return;
  battleMsgTimer += dt;
  if (battleMsgCurrent.persist) return;
  if (battleMsgTimer >= computeMsgTimings(battleMsgCurrent).total) {
    battleMsgCurrent = null;
  }
}

export function clearBattleMsgQueue() {
  battleMsgCurrent = null;
  battleMsgTimer = 0;
}

// Victory: persist forever until clearVictoryPersist fires.
export function queueVictoryRewards() {
  battleMsgCurrent = { bytes: BATTLE_VICTORY, persist: true };
  battleMsgTimer = 0;
}

export function clearVictoryPersist() {
  if (battleMsgCurrent && battleMsgCurrent.persist) battleMsgCurrent = null;
}
