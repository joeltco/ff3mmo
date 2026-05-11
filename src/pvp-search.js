// pvp-search.js — roster "Battle" → search-and-hook flow (v1.7.222).
//
// Replaces the old instant-accept PVP challenge. Picking Battle starts
// a *search* with the target. While the search is active, the target
// rolls an encounter timer; on each roll a hook chance is evaluated.
// On success the search resolves into a normal PVP battle via the
// existing `_startPVPBattle` flow. On failure the timer re-rolls.
//
// Today the target's encounter roll is *simulated* on a per-target
// timer (fake players don't roll real encounters). When real networked
// players land, swap the sim timer for the websocket-relayed
// "target_encountered" signal — the rest of the flow is the same.
//
// Design doc: `docs/ROSTER-MENU-AUDIT.md` (Battle redesign discussion
// 2026-05-11). Hook formula uses AGI differential + Thief/Ranger job
// bonus; see `getHookChance` for the constants.

import { ps } from './player-stats.js';
import { generateAllyStats } from './data/players.js';
import { mapSt } from './map-state.js';
import { battleSt } from './battle-state.js';
import { _nameToBytes } from './text-utils.js';
import { showMsgBox, replaceMsgBoxText, dismissMsgBox } from './message-box.js';
import { playSFX, SFX } from './music.js';

// Tuning constants. Surface them up here so they're easy to find.
const BASE_HOOK     = 0.25;
const AGI_PER_PT    = 0.015;
const HOOK_MIN      = 0.10;
const HOOK_MAX      = 0.75;

// Job bonuses — Thief (8) ambush identity, Ranger (6) tracker.
const JOB_BONUS = {
  6: 0.08,
  8: 0.15,
};

const SEARCH_TIMEOUT_MS    = 5 * 60 * 1000;
const MAX_MISSED_ROLLS     = 3;
const TARGET_ROLL_MIN_MS   = 8000;
const TARGET_ROLL_MAX_MS   = 15000;
const COOLDOWN_MS          = 60 * 1000;
const CONNECTING_HOLD_MS   = 1000;   // auto-advance "Connecting..." into battle after this delay (v1.7.226)

export const pvpSearchSt = {
  active: false,
  target: null,
  startedAtMs: 0,
  missedRolls: 0,
  targetRollTimer: 0,
  resolving: false,
  connectingHoldMs: 0,     // counts down while "Connecting..." holds; at 0 → dismiss → onClose → battle
  cooldowns: new Map(),    // targetName -> expiresAtMs
};

let _startPVPBattle = () => {};
export function initPVPSearch(deps) {
  _startPVPBattle = deps.startPVPBattle;
}

function _rollTimerMs() {
  return TARGET_ROLL_MIN_MS + Math.random() * (TARGET_ROLL_MAX_MS - TARGET_ROLL_MIN_MS);
}

function _now() { return performance.now(); }

export function isSearchOnCooldown(targetName) {
  const exp = pvpSearchSt.cooldowns.get(targetName);
  return !!exp && exp > _now();
}

export function isSearchingFor(target) {
  return pvpSearchSt.active && !!target && pvpSearchSt.target === target;
}

export function isSearchActive() {
  return pvpSearchSt.active;
}

export function isSearchResolving() {
  return pvpSearchSt.resolving;
}

export function getActiveTargetName() {
  return pvpSearchSt.active && pvpSearchSt.target ? pvpSearchSt.target.name : null;
}

// Hook chance formula: AGI differential + job bonus, clamped.
// Both sides matter — high-AGI target evades, Thief challenger hooks easier.
export function getHookChance(target) {
  const chAGI  = (ps.stats && typeof ps.stats.agi === 'number') ? ps.stats.agi : 5;
  const tgtStats = generateAllyStats(target);
  const tgtAGI = (tgtStats && typeof tgtStats.agi === 'number') ? tgtStats.agi : 5;
  const jobBonus = JOB_BONUS[ps.jobIdx] || 0;
  const raw = BASE_HOOK + (chAGI - tgtAGI) * AGI_PER_PT + jobBonus;
  return Math.max(HOOK_MIN, Math.min(HOOK_MAX, raw));
}

export function startPVPSearch(target) {
  if (pvpSearchSt.active) return false;
  if (!target) return false;
  if (isSearchOnCooldown(target.name)) return false;
  pvpSearchSt.active           = true;
  pvpSearchSt.target           = target;
  pvpSearchSt.startedAtMs      = _now();
  pvpSearchSt.missedRolls      = 0;
  pvpSearchSt.targetRollTimer  = _rollTimerMs();
  pvpSearchSt.resolving        = false;
  const msg = _nameToBytes('Searching for ' + target.name + '...');
  showMsgBox(msg);
  return true;
}

function _endSearch(targetName) {
  pvpSearchSt.active = false;
  pvpSearchSt.target = null;
  pvpSearchSt.resolving = false;
  pvpSearchSt.missedRolls = 0;
  pvpSearchSt.targetRollTimer = 0;
  if (targetName) {
    pvpSearchSt.cooldowns.set(targetName, _now() + COOLDOWN_MS);
  }
}

export function cancelPVPSearch(reason = 'user') {
  if (!pvpSearchSt.active) return;
  const targetName = pvpSearchSt.target && pvpSearchSt.target.name;
  _endSearch(targetName);
  if (reason === 'user') {
    showMsgBox(_nameToBytes('Cancelled'));
    playSFX(SFX.CONFIRM);
  } else if (reason === 'timeout' || reason === 'missed-cap') {
    showMsgBox(_nameToBytes('Search expired'));
  } else if (reason === 'death') {
    // Silent — game-over flow owns the screen
  }
}

// Can the challenger actually fight right now? Used to gate hook
// resolution (the *search* itself persists across town visits, but
// the hook only fires when a battle could legitimately start).
function _canResolveBattle() {
  return battleSt.battleState === 'none' && (mapSt.onWorldMap || mapSt.dungeonFloor >= 0);
}

function _runHookCheck() {
  // Challenger in town / in a battle / on a transition — counts as a
  // missed roll so the player can't park in town and fish forever.
  if (!_canResolveBattle()) {
    pvpSearchSt.missedRolls++;
    return;
  }
  const target = pvpSearchSt.target;
  const chance = getHookChance(target);
  if (Math.random() < chance) {
    _resolveAsHook();
  } else {
    pvpSearchSt.missedRolls++;
  }
}

function _resolveAsHook() {
  const target = pvpSearchSt.target;
  pvpSearchSt.resolving = true;
  pvpSearchSt.connectingHoldMs = CONNECTING_HOLD_MS;
  // Smooth swap so the "Searching..." box stays on-screen and just
  // re-letters into "Connecting..." — no slide-out / slide-in flicker.
  // tickPVPSearch auto-dismisses after CONNECTING_HOLD_MS, which
  // triggers slide-out → onClose → battle. v1.7.226.
  replaceMsgBoxText(_nameToBytes('Connecting...'), () => {
    _endSearch(target.name);
    _startPVPBattle(target);
  });
}

export function tickPVPSearch(dt) {
  if (!pvpSearchSt.active) return;
  // Resolving — "Connecting..." is on screen. Tick the hold timer;
  // when it expires, dismiss the message which fires onClose →
  // _startPVPBattle. User doesn't need to press anything. v1.7.226.
  if (pvpSearchSt.resolving) {
    if (pvpSearchSt.connectingHoldMs > 0) {
      pvpSearchSt.connectingHoldMs -= dt;
      if (pvpSearchSt.connectingHoldMs <= 0) {
        pvpSearchSt.connectingHoldMs = 0;
        dismissMsgBox();
      }
    }
    return;
  }
  // Auto-cancel on death — search is meaningless if the challenger
  // can't fight back.
  if (ps.hp <= 0) {
    cancelPVPSearch('death');
    return;
  }
  if (_now() - pvpSearchSt.startedAtMs > SEARCH_TIMEOUT_MS) {
    cancelPVPSearch('timeout');
    return;
  }
  if (pvpSearchSt.missedRolls >= MAX_MISSED_ROLLS) {
    cancelPVPSearch('missed-cap');
    return;
  }
  pvpSearchSt.targetRollTimer -= dt;
  if (pvpSearchSt.targetRollTimer <= 0) {
    _runHookCheck();
    pvpSearchSt.targetRollTimer = _rollTimerMs();
  }
}
