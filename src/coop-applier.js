// Host-authoritative co-op applier (Phase 1 stub; filled by Phases 2-5).
//
// One purpose: consume `encounter-resolution` packets emitted by the host
// and apply them to local state on guests. Guests do not run combat math
// under host-arb — they apply deltas + drive animation purely from fx cues
// in the packet.
//
// Spec: docs/COOP-REWRITE-PLAN.md#component-design — Guest-side applier.
// Wire shape: docs/COOP-REWRITE-PLAN.md#wire-contract.
//
// Phase 1 (current): wire handler is installed but the COOP_HOST_ARB flag
// is `false` so production guests ignore inbound packets. The hosts that
// matter aren't emitting yet either. This module exists so Phase 2 can
// flip the flag once the resolver + applier symmetric pairs are written.
//
// Phase 2: applyResolution handles attack/monster-attack actions.
// Phase 3: applyResolution handles magic / multi-target deltas.
// Phase 4: poison tick / KO / item.
// Phase 5: applySnapshot — joiner-spawn from realized stats.

import { battleSt } from './battle-state.js';
import { ps } from './player-stats.js';
import { setNetEncounterResolutionHandler, setNetEncounterSnapshotHandler,
         getMyUserId } from './net.js';
// Pull the flag from its owner (coop-resolver.js) instead of via the
// encounter-wire re-export — keeps this module Node-importable for the
// arbiter sim's convergence tests.
import { COOP_HOST_ARB } from './coop-resolver.js';
import { applyDeltaToActor, applyEncounterSnapshot } from './coop-deltas.js';

// Last applied resolution turnIdx. Packets must arrive monotonically
// (host's _turnIdx counter). Out-of-order packets are queued and applied
// when gaps fill in; dupes (already-seen turnIdx) are dropped.
let _lastAppliedTurnIdx = 0;
const _pendingResolutions = [];

export function getLastAppliedTurnIdx() { return _lastAppliedTurnIdx; }

export function resetApplier() {
  _lastAppliedTurnIdx = 0;
  _pendingResolutions.length = 0;
}

// Resolve an ActorRef from the wire to a local state pointer.
//
// 'player' kind with userId === my own → local `ps`.
// 'player' kind with userId of a peer → `battleAllies[i]` where userId
// matches (host or another guest, from this client's view).
// 'monster' kind → `encounterMonsters[idx]`.
//
// Returns null if the ref doesn't resolve (rare — typically a stale ref
// after a peer disconnected mid-packet).
export function resolveActorRef(ref) {
  if (!ref) return null;
  if (ref.kind === 'monster') {
    const idx = ref.idx | 0;
    return battleSt.encounterMonsters && battleSt.encounterMonsters[idx] || null;
  }
  if (ref.kind === 'player') {
    const uid = ref.userId | 0;
    if (!uid) return null;
    if (uid === (getMyUserId() | 0)) return ps;
    if (!battleSt.battleAllies) return null;
    return battleSt.battleAllies.find(a => a && (a.userId | 0) === uid) || null;
  }
  return null;
}

// Main entry — called on receipt of `encounter-resolution`. Flag-gated:
// when COOP_HOST_ARB=false (Phases 1-5 dev), this no-ops so the legacy
// lockstep code path stays live.
function _onEncounterResolution(msg) {
  if (!COOP_HOST_ARB) return;
  if (!battleSt.isWireEncounter) return;
  if (battleSt.encounterIsHost) return;  // host runs resolver, not applier
  if (!msg || typeof msg.turnIdx !== 'number') return;

  const tidx = msg.turnIdx | 0;
  if (tidx <= _lastAppliedTurnIdx) return;  // dupe

  if (tidx === _lastAppliedTurnIdx + 1) {
    _apply(msg);
    _drainPending();
    return;
  }
  // Gap — queue and apply when fill arrives.
  _pendingResolutions.push(msg);
  _pendingResolutions.sort((a, b) => (a.turnIdx | 0) - (b.turnIdx | 0));
}

function _drainPending() {
  while (_pendingResolutions.length > 0) {
    const next = _pendingResolutions[0];
    if ((next.turnIdx | 0) !== _lastAppliedTurnIdx + 1) break;
    _pendingResolutions.shift();
    _apply(next);
  }
}

function _apply(msg) {
  // Phase 2+ — walk deltas, apply each to the resolved actor. Damage,
  // status, MP all flow through `applyDeltaToActor` (coop-deltas.js).
  // This is the only HP-write path on guests under host-arb; legacy
  // local-damage code is short-circuited at the call site by the
  // `COOP_HOST_ARB && !encounterIsHost` gate (added in Phase 2.5 / live
  // cut-over).
  if (Array.isArray(msg.deltas)) {
    for (const delta of msg.deltas) {
      const actor = resolveActorRef(delta.target);
      if (actor) applyDeltaToActor(actor, delta);
    }
  }
  // Phase 4 — `meta.encounterEnd: true` signals host transitioned to
  // post-battle (victory / defeat / fled). Guests follow by flipping
  // their local FSM into `encounter-box-close` so the post-battle flow
  // (XP, gil, level-ups) runs through the same shared code path. The
  // optional `meta.outcome` field carries the host's verdict.
  if (msg.meta && msg.meta.encounterEnd && battleSt.battleState !== 'none') {
    // Defensive — only act if we're still in an active wire encounter.
    // Solo / boss / PvP battles never set the encounter-end flag here.
    if (battleSt.isWireEncounter && !battleSt.encounterIsHost) {
      battleSt.battleState = 'encounter-box-close';
      battleSt.battleTimer = 0;
    }
  }
  // Phase 2+: walk msg.fx, dispatch to existing anim entry points
  //   (slash, magic-cast, magic-impact, damage-num, death,
  //    item-use, item-impact, poison-tick-start). Animation cues are
  //    role-specific — the renderer for `kind: 'slash'` on a monster
  //    target is the same one the local FSM would have driven for a
  //    player attack. The exact dispatch wiring lands when we attach
  //    to the live FSM in Phase 4.5; the sim tests state convergence only.
  _lastAppliedTurnIdx = msg.turnIdx | 0;
}

// Joining peer's local FSM spawns from this snapshot under host-arb.
// Production behavior:
//   1. Seed `battleSt.battleAllies` from snapshot.combatants (excluding self)
//   2. Seed `battleSt.encounterMonsters` from snapshot.monsters
//   3. Set `battleSt.battleState` to snapshot.battleState
//   4. Set `battleSt.encounterHostUserId` so subsequent resolution
//      packets resolve hostward correctly
//   5. Mark `battleSt.isWireEncounter = true` + `encounterIsHost = false`
//   6. Reset applier counters to snapshot.turnIdx so the next
//      resolution lands at turnIdx+1 without queueing.
//
// Phase 5 lands the wiring through `applyEncounterSnapshot`; the live
// FSM transition (flash-strobe → wire-encounter spawn) attaches in
// Phase 5.5 when the legacy `encounter-assist-snapshot` path gets
// short-circuited under the flag.
function _onEncounterSnapshot(msg) {
  if (!COOP_HOST_ARB) return;
  if (!msg) return;

  // Mark co-op state — production flag-on guests need these set BEFORE
  // applyEncounterSnapshot runs so subsequent resolution packets route
  // through the correct hostUserId.
  battleSt.isWireEncounter = true;
  battleSt.encounterIsHost = false;
  battleSt.encounterHostUserId = msg.hostUserId | 0;
  battleSt.encounterSeed = 0;  // unused under host-arb; kept zero for safety

  // applyEncounterSnapshot mutates `target.battleAllies` + `monsters` +
  // `battleState` in place. We pass `battleSt` directly so it writes to
  // the live singleton.
  applyEncounterSnapshot(msg, battleSt, getMyUserId() | 0);
  // `target.monsters` is the snapshot consumer's field; production
  // singleton calls it `encounterMonsters`. Mirror over.
  if (Array.isArray(battleSt.monsters)) {
    battleSt.encounterMonsters = battleSt.monsters;
    delete battleSt.monsters;
  }
  // Reset applier turn-idx so the next resolution doesn't queue. Host's
  // counter at snapshot time is the high-water mark; we accept anything
  // strictly greater.
  _lastAppliedTurnIdx = msg.turnIdx | 0;
  _pendingResolutions.length = 0;
}

// Install handlers at module load. Mirrors how `encounter-wire.js` wires
// its own setters at top-level — no explicit boot call needed; importing
// this module from `encounter-wire.js` triggers the install. The handler
// bodies gate on `COOP_HOST_ARB` so flag-off path is a no-op.
setNetEncounterResolutionHandler(_onEncounterResolution);
setNetEncounterSnapshotHandler(_onEncounterSnapshot);

// Test surface — Phase 0/1 sim drives these directly without needing
// the wire round-trip. Removed in Phase 7 cleanup.
export const _testHooks = {
  onEncounterResolution: _onEncounterResolution,
  onEncounterSnapshot:   _onEncounterSnapshot,
  pending:               _pendingResolutions,
};
