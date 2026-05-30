// PvE replay-validate client. v1.7.773 P-3.
//
// Client-side bridge for the server-arbitrated PvE encounter handshake.
// Owns:
//   - Request encounter from server (when PVE_ARBITER on)
//   - Receive server's monster list + seed, hand to battle-encounter
//   - Buffer per-turn intents (P-4 fills this; P-3 stubs)
//   - Send claimed outcome at battle-end + handle server's verdict
//
// Wire shapes: docs/PVE-REWRITE-PLAN.md. Server module: pve-arbiter.js.

import {
  setNetPveBattleStartHandler, setNetPveBattleResultHandler, setNetPveCancelHandler,
  sendNetPveEncounterRequest, sendNetPveBattleEnd,
  PVE_ARBITER,
} from './net.js';
import { seed as seedRng } from './rng.js';
import { battleSt } from './battle-state.js';
import { ps } from './player-stats.js';

// Per-battle local state — the battleId + intent buffer between
// pve-battle-start arrival and pve-battle-end submission.
const _localBattle = {
  battleId: 0,
  rngSeed:  0,
  intents:  [],
};

// v1.7.783 — true between pveRequestEncounter() and the server's
// pve-battle-start / pve-cancel reply. movement.js gates on this so the
// player can't walk during the request round-trip (which lands the
// battle-flash). Without it, the 50-200ms WS window let the player keep
// stepping after the encounter trigger fired.
let _requestPending = false;
const REQUEST_TIMEOUT_MS = 2500;

// Injected at boot to avoid a circular import with battle-encounter.js.
let _startFromServer = null;
export function initPveClient({ startRandomEncounterFromServer }) {
  _startFromServer = startRandomEncounterFromServer;
}

// Public — client kicks off an encounter request. Called from
// battle-encounter.js#_triggerEncounterWithPVPCheck after the PvP search
// check resolves with "no hook". Fire-and-forget; server replies
// pve-battle-start (handled below) or pve-cancel (fallback to local).
export function pveRequestEncounter({ zoneKey, mapId }) {
  if (!PVE_ARBITER) return false;
  const ok = sendNetPveEncounterRequest({ zoneKey, mapId });
  if (ok) {
    _requestPending = true;
    // Watchdog — if the server drops the reply, release the input gate
    // so the player isn't permanently frozen. Battle handlers below
    // clear the flag the moment they fire.
    setTimeout(() => { _requestPending = false; }, REQUEST_TIMEOUT_MS);
  }
  return ok;
}

// Public — true while a pve-encounter-request is in flight (no battle-start
// or pve-cancel received yet). movement.js gates on this so the player
// can't take steps during the WS round-trip. v1.7.783.
export function pveEncounterPending() { return _requestPending; }

// Public — call from battle-update.js when the encounter naturally ends
// (victory, defeat, fled). P-3 ships a STUB claim — intents are empty,
// outcome is whatever battleSt currently holds. P-4 fills the intent
// buffer; P-5/P-6 finish the validation contract.
export function pveSubmitBattleEnd() {
  if (!PVE_ARBITER) return false;
  if (!_localBattle.battleId) return false;
  const claim = _buildStubClaim();
  const ok = sendNetPveBattleEnd({
    battleId: _localBattle.battleId,
    intents:  _localBattle.intents,
    claimedOutcome: claim,
  });
  // Reset local battle state regardless of send success — server's
  // 5min idle TTL will GC its side; we don't want stale battleId
  // hanging around if the player starts a new encounter.
  _resetLocalBattle();
  return ok;
}

// Public — for P-4 to push per-turn intents into the buffer. P-3 ships
// the function so the call sites can land without breaking the build.
export function pveBufferIntent(intent) {
  if (!PVE_ARBITER) return;
  if (!_localBattle.battleId) return;
  _localBattle.intents.push(intent);
}

// Public — translate a legacy `playerActionPending` shape into the
// PvE-arbiter intent wire shape. Mirrors the PvP arbiter's mapping
// (see battle-update.js#_emitWirePVPArbAction) but for PvE: actor is
// always the player (no PvP cell map); targetMonsterIdx is a 0..3
// index into battleSt.encounterMonsters. v1.7.774 P-4.
//
// Note: ally-target intents (magic/item used on a party member) carry
// targetSlot = 1..3 (allyIndex+1); player-self is targetSlot=0. Replay
// engine (P-5) maps these back to combatants.
export function pveBuildIntent(pending, turnIdx) {
  if (!pending) return null;
  const out = { battleId: _localBattle.battleId, turnIdx: turnIdx | 0, actorSlot: 0 };
  switch (pending.command) {
    case 'defend': out.kind = 'defend'; break;
    case 'run':    out.kind = 'flee';   break;
    case 'skip':   out.kind = 'defend'; break;          // ATB-era stub; treat as defend
    case 'fight':
      out.kind = 'attack';
      out.targetMonsterIdx = pending.targetIndex | 0;
      break;
    case 'magic':
      out.kind = 'magic';
      out.spellId = pending.spellId | 0;
      if (pending.target === 'monster') out.targetMonsterIdx = pending.targetIndex | 0;
      else if (pending.target === 'ally') out.targetSlot = (pending.allyIndex | 0) + 1;
      else out.targetSlot = 0;                          // self
      break;
    case 'item':
      out.kind = 'item';
      out.itemId = pending.itemId | 0;
      if (pending.target === 'monster') out.targetMonsterIdx = pending.targetIndex | 0;
      else if (pending.target === 'ally') out.targetSlot = (pending.allyIndex | 0) + 1;
      else out.targetSlot = 0;
      break;
    default:
      out.kind = String(pending.command || 'defend');
  }
  return out;
}

// Public — read current arbiter battleId. Returns 0 when not in an
// arbiter battle. Lets battle-update tell pve-arbiter end vs local end.
export function pveCurrentBattleId() {
  return _localBattle.battleId | 0;
}

function _resetLocalBattle() {
  _localBattle.battleId = 0;
  _localBattle.rngSeed  = 0;
  _localBattle.intents  = [];
}

function _buildStubClaim() {
  // v1.7.781 — derive victor from observable encounter state instead of
  // battleSt.enemyDefeated, which is true in BOTH victory and player-KO
  // paths (battle-update.js lines 799 + 824) and therefore can't
  // distinguish the two. Reward-presence is the reliable signal:
  //   - player dead          → wipe (no rewards)
  //   - encounterExpGained>0 → party victory (rewards earned)
  //   - otherwise (no rewards, player alive) → fled
  const playerDead = ps.hp <= 0;
  const earnedRewards = (battleSt.encounterExpGained | 0) > 0;
  const victor = playerDead ? 'wipe' : (earnedRewards ? 'party' : 'fled');
  const isVictory = victor === 'party';
  return {
    victor,
    drop:      isVictory ? battleSt.encounterDropItem : null,
    expGained: isVictory ? (battleSt.encounterExpGained | 0) : 0,
    cpGained:  isVictory ? (battleSt.encounterCpGained  | 0) : 0,
    gilGained: isVictory ? (battleSt.encounterGilGained | 0) : 0,
  };
}

// ── Wire handlers ──────────────────────────────────────────────────────────

setNetPveBattleStartHandler((msg) => {
  if (!PVE_ARBITER) return;
  _requestPending = false;
  if (!msg || !msg.battleId || !msg.rngSeed) {
    console.warn('[pve] battle-start missing fields', msg);
    return;
  }
  _localBattle.battleId = msg.battleId | 0;
  _localBattle.rngSeed  = msg.rngSeed >>> 0;
  _localBattle.intents  = [];
  // Seed the singleton RNG so all subsequent battle rolls (drop,
  // confused-target, ally-target — already swapped from Math.random in
  // P-1) are deterministic from the server's seed. Replay (P-5) walks
  // the same sequence from this seed + the buffered intents.
  seedRng(_localBattle.rngSeed);
  if (_startFromServer) {
    try { _startFromServer(msg.monsters || []); }
    catch (e) { console.warn('[pve] startFromServer threw', e); }
  } else {
    console.warn('[pve] startFromServer not injected — battle-encounter.js init missed');
  }
});

setNetPveBattleResultHandler((msg) => {
  if (!PVE_ARBITER) return;
  // P-3 stub: log + verify the result matches the battle we were in.
  // P-6 expands to: on `applied`, overwrite ps with canonical
  // (server is source of truth); on `rejected`, force a save-resync.
  if (msg.status === 'rejected') {
    console.warn('[pve] battle rejected battleId=' + msg.battleId + ' reason=' + msg.reason);
  } else {
    // console.log('[pve] battle applied battleId=' + msg.battleId);
  }
});

setNetPveCancelHandler((msg) => {
  if (!PVE_ARBITER) return;
  _requestPending = false;
  // Server refused (arbiter-disabled / no-save / unknown-zone / etc).
  // Reset local arbiter state. Caller in battle-encounter.js falls
  // back to the local startRandomEncounter path by checking that
  // _localBattle.battleId is 0 after a short window.
  console.warn('[pve] encounter cancelled reason=' + (msg && msg.reason));
  _resetLocalBattle();
});
