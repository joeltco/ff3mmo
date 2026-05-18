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
import { COOP_HOST_ARB } from './encounter-wire.js';

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
  // Phase 2+: walk msg.deltas, apply each to the addressed actor.
  // Phase 2+: walk msg.fx, dispatch to existing anim entry points.
  // Phase 4+: msg.meta.encounterEnd → transition to encounter-box-close.
  _lastAppliedTurnIdx = msg.turnIdx | 0;
}

// Joining peer's local FSM spawns from this snapshot under host-arb.
// Phase 5+; flag-gated.
function _onEncounterSnapshot(msg) {
  if (!COOP_HOST_ARB) return;
  if (!msg) return;
  // TODO Phase 5: spawn local battle from realized stats + current HP.
  _lastAppliedTurnIdx = msg.turnIdx | 0;
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
