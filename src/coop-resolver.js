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
import { buildPhysicalAttackPacket, buildMonsterAttackPacket,
         buildMagicPacket, buildItemUsePacket, buildPoisonTickPacket,
         buildEncounterEndPacket, buildEncounterSnapshot } from './coop-deltas.js';

// Host-authoritative co-op rewrite (Phase 1+). Build-time const that
// gates every host-arb code path. Default `false` keeps the legacy
// deterministic-lockstep code path active. Phase 6 flips it to `true`
// to make host-arb the live default; Phase 7 deletes the flag-off
// branches entirely. See docs/COOP-REWRITE-PLAN.md.
//
// Owned here (not in encounter-wire.js) so Node tooling (coop-arbiter-sim,
// future regression harnesses) can read it without pulling browser-only
// modules through encounter-wire.js's transitive imports.
//
// Runtime debug toggle is NOT exposed — build-time only (per Open Question
// #4 in the plan). Wire to debug tab in Phase 6 if A/B comparison helps.
export const COOP_HOST_ARB = false;

// Monotonic turn-resolution counter. Bumped once per emitted resolution
// packet. Persists across the encounter; guests track `_lastAppliedTurnIdx`
// and apply in order (drop dupes, queue out-of-order — see
// `coop-applier.js`).
let _turnIdx = 0;

export function getResolverTurnIdx() { return _turnIdx; }
export function resetResolverTurnIdx() { _turnIdx = 0; }

// Phase 2 entry. Resolve a physical attack action and ship the resolution.
// Host's local FSM has already rolled `hits` (via `rollHits()`); this fn
// captures the outcome into a packet and emits it so guests apply the
// same total damage rather than re-deriving it from divergent stat paths.
//
// `input` shape:
//   { actor: <ActorRef>, target: <ActorRef>, hits: [<HitResult>],
//     weaponId: <int>, hand: 'R'|'L' }
//
// Caller is responsible for: applying the damage locally on host (host is
// authoritative — applies what it shipped), and ensuring `hits` matches
// the local FSM's `rollHits` output for this turn. Returns the emitted
// packet (with `turnIdx` filled in by `_emitResolution`) or null if no
// emit happened (flag off / unhelloed / etc.).
export function resolvePhysicalAttack(input) {
  const packet = buildPhysicalAttackPacket(input);
  return _emitResolution(packet);
}

// Phase 2 entry. Resolve a monster's turn against a player/ally target.
//
// Host has already run `_processEnemyTurn` locally (which respects the
// full ps-path semantics — `elemResist`, `protect`, `statusAtk` inflict,
// `getShieldEvade`) and computed the final `dmg`. This fn ships that
// final value over the wire so the guest applies the exact same damage
// rather than re-deriving via its `ally`-path code (no `elemResist`, no
// `protect`, no status inflict — the legacy divergence source).
//
// `input` shape:
//   { monsterIdx: <int>, target: <ActorRef>, dmg: <int>, miss: <bool>,
//     statusAdd: <int> }   // statusAdd: STATUS bitmask, default 0
export function resolveMonsterAttack(input) {
  const packet = buildMonsterAttackPacket(input);
  return _emitResolution(packet);
}

// Legacy name kept for the original Phase 1 stub signature — alias to
// `resolveMonsterAttack` so existing call sites + sim grep tests still
// find the export. Will be inlined away in Phase 7 cleanup.
export function resolveMonsterTurn(input) { return resolveMonsterAttack(input); }

// Phase 3 entry. Resolve a spell cast and ship the resolution.
//
// `input` shape:
//   { actor: <ActorRef>, spellId: <int>, results: [<TargetResult>, ...] }
//
// Each TargetResult contains the per-target outcome the host computed
// via `applySpell` (or `applyMagicDamage` / `applyMagicHeal` / etc.) —
// dmg/heal/miss/statusAdd/statusRemove/death. The builder converts
// them into a single multi-target packet so guests apply N target
// changes in one frame.
//
// Caller responsibilities:
//   1. Run `applySpell` (or the spell-specific helper) locally on host
//      so the rolls happen exactly once on the authoritative side.
//   2. Convert each target's outcome into a TargetResult.
//   3. Pass the array to `resolveSpellCast`.
//
// Production wiring (Phase 3.5): the `spell-cast.js` impact-apply
// callsites + `battle-ally.js#_applyAllyMagicEffect` accumulate the
// TargetResults during local apply, then call this once per cast.
//
// Returns the emitted packet (with `turnIdx` filled in) or null when
// the wire send fails (unhelloed / disconnect).
export function resolveSpellCast(input) {
  const packet = buildMagicPacket(input);
  return _emitResolution(packet);
}

// Phase 4 entry. Resolve a battle-item use (Potion / Antidote / Elixir /
// Phoenix Down / thrown weapon / etc.). Same TargetResult shape as magic;
// items don't roll RNG for power (item.power is flat) so per-target
// outcomes are deterministic on the host side.
//
// `input` shape:
//   { actor: <ActorRef>, itemId: <int>, results: [<TargetResult>, ...] }
//
// Production wiring (Phase 4.5): `battle-turn.js#_playerTurnConsumable`
// + `battle-ally.js#_applyAllyItemEffect` accumulate per-target outcomes
// and call this once per item use.
export function resolveItemUse(input) {
  const packet = buildItemUsePacket(input);
  return _emitResolution(packet);
}

// Phase 4 entry. End-of-round poison tick — batches every poisoned actor
// (player, allies, monsters, PvP enemies) into one resolution packet so
// guests apply the whole tick in one frame, matching the existing
// "consolidated end-of-round phase" UX.
//
// Host runs `_applyEndOfRoundPoison` locally first (which enforces the
// NES clamp-to-1 rule for player/ally and lets monsters die); the
// resulting per-actor damage values + death flags are passed in via
// `input.results`.
//
// `input` shape:
//   { results: [{ target, dmg, death }, ...] }
export function resolvePoisonTick(input) {
  const packet = buildPoisonTickPacket(input);
  return _emitResolution(packet);
}

// Phase 4 entry. Host detected end-of-battle — emit the encounter-end
// signal so guests transition to `encounter-box-close` and run the
// post-battle flow (victory / defeat / fled).
//
// `input` shape:
//   { outcome: 'victory'|'defeat'|'fled', deltas?: [], fx?: [] }
//
// Production wiring (Phase 4.5): wherever `battleSt.battleState` flips to
// `'encounter-box-close'` on host (battle-update.js + battle-enemy.js +
// battle-ally.js), the host-arb branch calls this in addition to (or
// instead of) the local transition. Cleanup of legacy paths happens in
// Phase 7.
export function resolveEncounterEnd(input) {
  const packet = buildEncounterEndPacket(input);
  return _emitResolution(packet);
}

// Re-export the pure builder so callers can inspect a snapshot's shape
// without sending it. Live host emit goes through `resolveEncounterJoin`.
export { buildEncounterSnapshot };

// Phase 5 entry. Build + ship the mid-battle snapshot to a joining peer.
// Ships realized stats (atk/def/agi/maxHP/etc.) rather than profile fields
// to eliminate the `recalcStats` vs `generateAllyStats` divergence as a
// class — joiner runs no stats math on the snapshot, just consumes the
// realized values directly.
//
// `input` shape:
//   { joinerUserId: <int>, hostUserId: <int>, turnIdx: <int>,
//     battleState: <string>, monsters: [...], combatants: [...] }
//
// Production wiring (Phase 5.5): when host receives an
// `encounter-assist-incoming` and is in a safe state (menu-open), it
// builds the input from `ps + battleAllies + encounterMonsters` and
// calls this. The wire goes through `sendNetEncounterSnapshot` (joiner-
// only, not fanned out to the encounter group).
//
// Returns the snapshot object that was sent, or null on send failure.
export function resolveEncounterJoin(input) {
  if (!input || !input.joinerUserId) return null;
  const snapshot = buildEncounterSnapshot(input);
  if (!snapshot) return null;
  _emitSnapshot(input.joinerUserId | 0, snapshot);
  return snapshot;
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
