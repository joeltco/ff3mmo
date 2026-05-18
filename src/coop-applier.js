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
import { setPlayerDamageNum, setPlayerHealNum, setEnemyDmgNum,
         setSwDmgNum, getAllyDamageNums } from './damage-numbers.js';

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
  // `COOP_HOST_ARB && !encounterIsHost` gate.
  if (Array.isArray(msg.deltas)) {
    for (const delta of msg.deltas) {
      const actor = resolveActorRef(delta.target);
      if (actor) applyDeltaToActor(actor, delta);
    }
  }
  // Phase 6.9 — dispatch fx cues. The cues drive damage-num overlays,
  // death state transitions, and other visual/state-machine effects
  // that the legacy local FSM was computing inline. With short-circuits
  // (Phase 6.7) the local FSM no longer mutates state; the packet now
  // drives both state (via deltas) and visuals (via cues).
  if (Array.isArray(msg.fx)) {
    for (const cue of msg.fx) _dispatchFxCue(cue);
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
  _lastAppliedTurnIdx = msg.turnIdx | 0;
}

// Phase 6.9 — dispatch a single fx cue. Cue kinds covered:
//
//   damage-num — overlay authoritative dmg/heal/miss value on the
//     correct damage-num slot (player / ally / enemy). Closes the
//     "guest shows wrong number for a frame" caveat from Phase 6.7.
//
//   death — trigger death animation for the resolved target. Encounter-
//     scope routing only (monster targets); player/ally death routing
//     is handled by the local FSM's hp-check loop after the applier
//     writes hp=0.
//
//   Other kinds (slash / magic-cast / magic-impact / item-use /
//     item-impact / poison-tick-start) are no-ops here — those
//     animations are already driven by the local FSM state machine
//     (battleState transitions kick off in legacy code paths even
//     under guest short-circuit, since only the HP/status mutations
//     are skipped, not the state transitions).
//
// `ref` resolution mirrors `resolveActorRef` but returns a {kind, slot}
// pair so the right setter is callable (damage-numbers' slots are
// keyed differently per faction).
function _dispatchFxCue(cue) {
  if (!cue || !cue.kind) return;
  if (cue.kind === 'damage-num') {
    _dispatchDamageNum(cue);
    return;
  }
  if (cue.kind === 'death') {
    _dispatchDeath(cue);
    return;
  }
  // Other cues — no-op (local FSM handles animation flow).
}

// Authoritative damage-num overlay. Routes by target.kind:
//   player + own userId  → setPlayerDamageNum / setPlayerHealNum
//   player + peer userId → getAllyDamageNums()[allyIdx]
//   monster              → setSwDmgNum(idx, value, {miss})
function _dispatchDamageNum(cue) {
  if (!cue.target) return;
  const value   = cue.value | 0;
  const variant = String(cue.variant || 'dmg');
  const isHeal  = variant === 'heal';
  const isMiss  = variant === 'miss';
  const isCrit  = variant === 'crit';

  if (cue.target.kind === 'monster') {
    setSwDmgNum(cue.target.idx | 0, value, { miss: isMiss });
    // Multi-monster encounters also use setEnemyDmgNum as the "currently
    // selected" enemy slot. Keep that in sync when the host indicates
    // the player's-aim target was hit — but we don't know which monster
    // is currently selected on the guest's UI; setSwDmgNum drives the
    // per-slot overlay which is sufficient.
    return;
  }
  if (cue.target.kind === 'player') {
    const uid = cue.target.userId | 0;
    if (!uid) return;
    if (uid === (getMyUserId() | 0)) {
      // Local player slot
      if (isMiss) {
        setPlayerDamageNum({ miss: true, timer: 0 });
      } else if (isHeal) {
        setPlayerHealNum({ value, timer: 0 });
      } else {
        setPlayerDamageNum({ value, crit: isCrit, timer: 0 });
      }
      return;
    }
    // Ally slot — find by userId in battleAllies
    if (!Array.isArray(battleSt.battleAllies)) return;
    const idx = battleSt.battleAllies.findIndex(a => a && (a.userId | 0) === uid);
    if (idx < 0) return;
    if (isMiss) {
      getAllyDamageNums()[idx] = { miss: true, timer: 0 };
    } else if (isHeal) {
      getAllyDamageNums()[idx] = { value, timer: 0, heal: true };
    } else {
      getAllyDamageNums()[idx] = { value, crit: isCrit, timer: 0 };
    }
    return;
  }
}

// Authoritative death routing for monster targets. Sets up the
// `dyingMonsterIndices` map + transitions to `monster-death` state so
// the local FSM plays the dissolve anim. Player / ally death isn't
// routed here; the applier writes hp=0 via deltas and the local FSM's
// next hp-check picks up the transition (the legacy `_isTeamWiped`
// check still runs every frame).
function _dispatchDeath(cue) {
  if (!cue.target || cue.target.kind !== 'monster') return;
  if (!battleSt.encounterMonsters) return;
  const idx = cue.target.idx | 0;
  const mon = battleSt.encounterMonsters[idx];
  if (!mon || mon.hp > 0) return;
  // If a death anim is already in flight for this idx, don't restart.
  if (battleSt.dyingMonsterIndices && battleSt.dyingMonsterIndices.has(idx)) return;
  if (!battleSt.dyingMonsterIndices || !(battleSt.dyingMonsterIndices instanceof Map)) {
    battleSt.dyingMonsterIndices = new Map();
  }
  battleSt.dyingMonsterIndices.set(idx, 0);
  // Only transition battleState if FSM is in a state where death-anim
  // makes sense — i.e., we just applied a damage delta. Don't yank the
  // FSM out of unrelated states (menu-open, victory flow, etc.).
  const bs = battleSt.battleState;
  const canTransition = bs === 'ally-damage-show' || bs === 'player-damage-show'
                      || bs === 'enemy-damage-show' || bs === 'magic-hit'
                      || bs === 'ally-magic-hit' || bs === 'poison-end-tick';
  if (canTransition) {
    battleSt.battleState = 'monster-death';
    battleSt.battleTimer = 0;
  }
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
