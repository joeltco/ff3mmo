// Host-authoritative co-op resolver (Phase 1 stub; filled by Phases 2-5).
//
// One purpose: when a co-op battle's host runs a turn locally, this module
// captures the turn outcome as a `{deltas, fx}` packet, applies the same
// deltas to host state, and emits `encounter-resolution` over the wire so
// every guest applies an identical outcome.
//
// Spec: docs/COOP-REWRITE-PLAN.md#component-design — Host-side resolver.
// Wire shape: docs/COOP-REWRITE-PLAN.md#wire-contract.
//
// Phase 1 (current): empty entry points + the monotonic `turnIdx` counter.
//   Production code does NOT call any resolver entry point yet — the
//   lockstep path remains the live code path.
// Phase 2: resolvePlayerAttack / resolveAllyAttack / resolveMonsterTurn.
// Phase 3: resolveSpellCast (all spells via applySpell).
// Phase 4: resolveItemUse + resolvePoisonTick + KO routing.
// Phase 5: buildEncounterSnapshot (mid-battle joiner state).
//
// All entries gated by `COOP_HOST_ARB` on the caller side (encounter-wire.js
// or battle-turn.js); resolver itself trusts it's only invoked when host-arb
// is active.

import { battleSt } from './battle-state.js';
import { sendNetEncounterResolution, sendNetEncounterSnapshot } from './net.js';

// Monotonic turn-resolution counter. Bumped once per emitted resolution
// packet. Persists across the encounter; guests track `_lastAppliedTurnIdx`
// and apply in order (drop dupes, queue out-of-order — see
// `coop-applier.js`).
let _turnIdx = 0;

export function getResolverTurnIdx() { return _turnIdx; }
export function resetResolverTurnIdx() { _turnIdx = 0; }

// Phase 2+ entry. Resolve a physical attack action and ship the resolution.
// Returns the resolution packet so the host's local FSM can apply the same
// deltas (single-source-of-truth invariant — host applies the bytes it
// shipped, not the bytes its FSM would have computed independently).
//
// Phase 1 stub: returns null to signal "no resolution emitted." Production
// code paths that gate on `COOP_HOST_ARB` skip these calls anyway.
//
// eslint-disable-next-line no-unused-vars
export function resolvePhysicalAttack(_actorRef, _action) {
  // TODO Phase 2: pull hitResults from host's local FSM, build deltas
  // (target HP, statusAtk inflict), build fx cues (slash frames, damage-num,
  // monster-death if applicable), increment _turnIdx, emit, return packet.
  return null;
}

// Phase 2+ entry. Resolve a monster's turn.
// eslint-disable-next-line no-unused-vars
export function resolveMonsterTurn(_monsterIdx) {
  // TODO Phase 2: run monster AI on host, pick target (respecting the
  // ps-vs-ally branch ONLY on host — guest no longer runs this code),
  // compute damage with full ps-path semantics (elemResist, protect,
  // statusAtk inflict), build deltas + fx cues, emit.
  return null;
}

// Phase 3+ entry. Resolve a spell cast.
// eslint-disable-next-line no-unused-vars
export function resolveSpellCast(_actorRef, _spellId, _targets) {
  // TODO Phase 3: run host's applySpell once, capture every mutation,
  // build deltas (damage / heal / status / cure / sight / erase / drain),
  // build fx cues (cast windup, projectile, impact, damage-num, death),
  // emit. Multi-target spells fan multiple deltas into one packet.
  return null;
}

// Phase 4+ entry. Resolve item use.
// eslint-disable-next-line no-unused-vars
export function resolveItemUse(_actorRef, _itemId, _targets) {
  // TODO Phase 4.
  return null;
}

// Phase 4+ entry. End-of-round poison tick — batches every poisoned actor
// into one resolution packet so guests apply the whole tick in one frame.
export function resolvePoisonTick() {
  // TODO Phase 4.
  return null;
}

// Phase 5+ entry. Build + ship the mid-battle snapshot to a joining peer.
// Ships realized stats (atk/def/agi/maxHP/etc.) rather than profile fields
// to eliminate the `recalcStats` vs `generateAllyStats` divergence as a
// class — joiner runs no stats math on the snapshot, just consumes the
// realized values directly.
//
// eslint-disable-next-line no-unused-vars
export function buildEncounterSnapshot(_joinerUserId) {
  // TODO Phase 5: enumerate battleAllies + ps (host's view of self) +
  // encounterMonsters, ship current HP/MP/status, ship realized stats
  // computed from host's authoritative state.
  return null;
}

// Internal — used by Phase 2+ entries when emitting. Bumps counter +
// fires the wire. Exposed for testing.
export function _emitResolution(packet) {
  _turnIdx++;
  const full = { turnIdx: _turnIdx, ...packet };
  sendNetEncounterResolution(full);
  return full;
}

// Internal — used by Phase 5+ snapshot emit. Doesn't bump _turnIdx
// (snapshot includes the current host turnIdx for the joiner to align
// against the resolution stream).
export function _emitSnapshot(joinerUserId, snapshot) {
  return sendNetEncounterSnapshot(joinerUserId, { turnIdx: _turnIdx, ...snapshot });
}

// Sanity guard for use during phases 2-5. Throws if a resolver entry is
// invoked outside a co-op-host context. Production callers gate via
// `COOP_HOST_ARB` so this should never fire; if it does, the call site
// missed its gate.
export function _assertIsCoopHost() {
  if (!battleSt.isWireEncounter) {
    throw new Error('coop-resolver: invoked outside isWireEncounter context');
  }
  if (!battleSt.encounterIsHost) {
    throw new Error('coop-resolver: invoked on guest (only host resolves)');
  }
}
