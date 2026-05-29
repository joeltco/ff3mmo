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

// Per-battle local state — the battleId + intent buffer between
// pve-battle-start arrival and pve-battle-end submission.
const _localBattle = {
  battleId: 0,
  rngSeed:  0,
  intents:  [],
};

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
  return sendNetPveEncounterRequest({ zoneKey, mapId });
}

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
  // P-3 stub — captures the natural outcome of the local battle but
  // doesn't yet itemize every delta. P-6 expands this into the full
  // schema (party HP/MP/status, monster HP, drop, exp/cp/gil, level-ups,
  // job-CP, spells-learned). Server's P-2 stub accepts whatever we
  // send; the schema solidifies once the replay engine lands.
  return {
    victor: battleSt.enemyDefeated ? 'party' : 'wipe',
    drop: battleSt.encounterDropItem,
    expGained: battleSt.encounterExpGained | 0,
    cpGained:  battleSt.encounterCpGained  | 0,
    gilGained: battleSt.encounterGilGained | 0,
  };
}

// ── Wire handlers ──────────────────────────────────────────────────────────

setNetPveBattleStartHandler((msg) => {
  if (!PVE_ARBITER) return;
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
  // Server refused (arbiter-disabled / no-save / unknown-zone / etc).
  // Reset local arbiter state. Caller in battle-encounter.js falls
  // back to the local startRandomEncounter path by checking that
  // _localBattle.battleId is 0 after a short window.
  console.warn('[pve] encounter cancelled reason=' + (msg && msg.reason));
  _resetLocalBattle();
});
