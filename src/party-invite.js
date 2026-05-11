// party-invite.js — roster "Party" → invite-and-accept flow (v1.7.235).
//
// Mirror of pvp-search.js for the Party action. Picking Party starts a
// persistent "Inviting X..." invitation. The target rolls an accept
// chance every 5-12 s on a per-target sim timer. On accept, the target
// is added to `partyInviteSt.partyMembers` and will auto-join the
// player's battleAllies at the start of every future battle while they
// share the player's location. Manual-dismiss lifetime — they stay in
// the party until the user picks Party → Dismiss on the same target.
//
// Today the target's accept roll is *simulated* on a per-target timer
// (fake players don't decide anything). When real networked players
// land, swap the sim timer for the websocket-relayed "invite_response"
// signal — the rest of the flow is the same. Same cutover seam as the
// PVP search.
//
// Accept formula: level-differential + job bonus (Bard / Ranger /
// Knight), clamped. AGI doesn't fit here — see getAcceptChance for the
// constants.

import { ps } from './player-stats.js';
import { generateAllyStats } from './data/players.js';
import { battleSt } from './battle-state.js';
import { _nameToBytes } from './text-utils.js';
import { showMsgBox, replaceMsgBoxText, dismissMsgBox } from './message-box.js';
import { playSFX, SFX } from './music.js';

const BASE_ACCEPT   = 0.35;
const LEVEL_PER_PT  = 0.01;
const ACCEPT_MIN    = 0.15;
const ACCEPT_MAX    = 0.80;

// Bard (16) charisma/leader, Ranger (6) easy-going scout, Knight (7) formal recruiter.
const JOB_BONUS = {
  6: 0.08,
  7: 0.05,
  16: 0.20,
};

const INVITE_TIMEOUT_MS  = 5 * 60 * 1000;
const MAX_MISSED_ROLLS   = 3;
const TARGET_ROLL_MIN_MS = 5000;
const TARGET_ROLL_MAX_MS = 12000;
const COOLDOWN_MS        = 60 * 1000;
const JOINED_HOLD_MS     = 1000;

export const PARTY_MAX = 3;

export const partyInviteSt = {
  active: false,
  target: null,
  startedAtMs: 0,
  missedRolls: 0,
  targetRollTimer: 0,
  resolving: false,
  joinedHoldMs: 0,
  cooldowns: new Map(),       // targetName -> expiresAtMs
  partyMembers: [],           // array of player names, persistent until dismissed
};

function _rollTimerMs() {
  return TARGET_ROLL_MIN_MS + Math.random() * (TARGET_ROLL_MAX_MS - TARGET_ROLL_MIN_MS);
}

function _now() { return performance.now(); }

export function isInviteOnCooldown(targetName) {
  const exp = partyInviteSt.cooldowns.get(targetName);
  return !!exp && exp > _now();
}

export function isInvitingTarget(target) {
  return partyInviteSt.active && !!target && partyInviteSt.target === target;
}

export function isInviteActive() {
  return partyInviteSt.active;
}

export function isInviteResolving() {
  return partyInviteSt.resolving;
}

export function getActiveInviteTargetName() {
  return partyInviteSt.active && partyInviteSt.target ? partyInviteSt.target.name : null;
}

export function isInParty(target) {
  return !!target && partyInviteSt.partyMembers.includes(target.name);
}

export function isPartyFull() {
  return partyInviteSt.partyMembers.length >= PARTY_MAX;
}

export function removeFromParty(targetName) {
  const i = partyInviteSt.partyMembers.indexOf(targetName);
  if (i >= 0) partyInviteSt.partyMembers.splice(i, 1);
}

// Accept chance formula: level differential + job bonus, clamped. Lower-
// level player inviting a high-level target → harder to land; Bard/
// Ranger/Knight get a recruit bonus.
export function getAcceptChance(target) {
  const chLevel  = (typeof ps.level === 'number') ? ps.level : 1;
  const tgtStats = generateAllyStats(target);
  const tgtLevel = (tgtStats && typeof tgtStats.level === 'number') ? tgtStats.level : 1;
  const jobBonus = JOB_BONUS[ps.jobIdx] || 0;
  const raw = BASE_ACCEPT + (chLevel - tgtLevel) * LEVEL_PER_PT + jobBonus;
  return Math.max(ACCEPT_MIN, Math.min(ACCEPT_MAX, raw));
}

export function startPartyInvite(target) {
  if (partyInviteSt.active) return false;
  if (!target) return false;
  if (isInParty(target)) return false;
  if (isPartyFull()) return false;
  if (isInviteOnCooldown(target.name)) return false;
  partyInviteSt.active           = true;
  partyInviteSt.target           = target;
  partyInviteSt.startedAtMs      = _now();
  partyInviteSt.missedRolls      = 0;
  partyInviteSt.targetRollTimer  = _rollTimerMs();
  partyInviteSt.resolving        = false;
  showMsgBox(_nameToBytes('Inviting ' + target.name + '...'));
  return true;
}

function _endInvite(targetName) {
  partyInviteSt.active = false;
  partyInviteSt.target = null;
  partyInviteSt.resolving = false;
  partyInviteSt.missedRolls = 0;
  partyInviteSt.targetRollTimer = 0;
  if (targetName) {
    partyInviteSt.cooldowns.set(targetName, _now() + COOLDOWN_MS);
  }
}

export function cancelPartyInvite(reason = 'user') {
  if (!partyInviteSt.active) return;
  const targetName = partyInviteSt.target && partyInviteSt.target.name;
  _endInvite(targetName);
  if (reason === 'user') {
    showMsgBox(_nameToBytes('Cancelled'));
    playSFX(SFX.CONFIRM);
  } else if (reason === 'timeout' || reason === 'missed-cap') {
    showMsgBox(_nameToBytes('Invite expired'));
  } else if (reason === 'death') {
    // Silent — game-over flow owns the screen
  }
}

// Can the invite actually resolve right now? Mid-battle adds-to-party
// would be jarring — the invite *itself* persists, but resolution waits
// for the user to be out of combat.
function _canResolveInvite() {
  return battleSt.battleState === 'none';
}

function _runAcceptCheck() {
  if (!_canResolveInvite()) {
    partyInviteSt.missedRolls++;
    return;
  }
  const target = partyInviteSt.target;
  const chance = getAcceptChance(target);
  if (Math.random() < chance) {
    _resolveAsJoin();
  } else {
    partyInviteSt.missedRolls++;
  }
}

function _resolveAsJoin() {
  const target = partyInviteSt.target;
  partyInviteSt.resolving = true;
  partyInviteSt.joinedHoldMs = JOINED_HOLD_MS;
  replaceMsgBoxText(_nameToBytes('Joined'), () => {
    if (!partyInviteSt.partyMembers.includes(target.name) && !isPartyFull()) {
      partyInviteSt.partyMembers.push(target.name);
    }
    _endInvite(target.name);
  });
}

export function tickPartyInvite(dt) {
  if (!partyInviteSt.active) return;
  if (partyInviteSt.resolving) {
    if (partyInviteSt.joinedHoldMs > 0) {
      partyInviteSt.joinedHoldMs -= dt;
      if (partyInviteSt.joinedHoldMs <= 0) {
        partyInviteSt.joinedHoldMs = 0;
        dismissMsgBox();
      }
    }
    return;
  }
  if (ps.hp <= 0) {
    cancelPartyInvite('death');
    return;
  }
  if (_now() - partyInviteSt.startedAtMs > INVITE_TIMEOUT_MS) {
    cancelPartyInvite('timeout');
    return;
  }
  if (partyInviteSt.missedRolls >= MAX_MISSED_ROLLS) {
    cancelPartyInvite('missed-cap');
    return;
  }
  partyInviteSt.targetRollTimer -= dt;
  if (partyInviteSt.targetRollTimer <= 0) {
    _runAcceptCheck();
    partyInviteSt.targetRollTimer = _rollTimerMs();
  }
}
