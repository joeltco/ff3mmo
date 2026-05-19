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
import { ps } from './player-stats.js';
import { sendNetEncounterResolution, sendNetEncounterSnapshot, getMyUserId } from './net.js';
import { buildPhysicalAttackPacket, buildMonsterAttackPacket,
         buildMagicPacket, buildItemUsePacket, buildPoisonTickPacket,
         buildEncounterEndPacket, buildEncounterSnapshot,
         // P5 — ViewEvent builders (docs/COOP-VIEWER-PLAN.md).
         buildAttackViewEvent, buildMagicViewEvent, buildItemViewEvent,
         buildMonsterAttackViewEvent, buildPoisonTickViewEvent,
         buildMonsterDeathViewEvent, buildPlayerDeathViewEvent,
         buildEncounterStartViewEvent, buildEncounterEndViewEvent,
         buildTurnBeginViewEvent } from './coop-deltas.js';

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

// Co-op viewer rewrite (P1+, docs/COOP-VIEWER-PLAN.md). When `true`, guests
// stop running the battle FSM during co-op encounters and instead consume
// host-emitted ViewEvents via `src/coop-viewer.js` as a packet-driven
// animation player. Implies `COOP_HOST_ARB`-style host-resolves model
// regardless of that flag's setting. Default `false` so plan can land in
// stages without changing live behavior.
//
// Three-state matrix (see docs/COOP-VIEWER-PLAN.md#compat):
//   { HOST_ARB: false, VIEWER: false } → legacy lockstep (current prod)
//   { HOST_ARB: true,  VIEWER: false } → host-arb only (v1.7.474–76; broken live)
//   {                  VIEWER: true  } → viewer (target end state)
export const COOP_VIEWER_MODE = true;

// Monotonic turn-resolution counter. Bumped once per emitted resolution
// packet. Persists across the encounter; guests track `_lastAppliedTurnIdx`
// and apply in order (drop dupes, queue out-of-order — see
// `coop-applier.js`).
let _turnIdx = 0;

export function getResolverTurnIdx() { return _turnIdx; }
export function resetResolverTurnIdx() { _turnIdx = 0; }
// P7 — set the resolver's monotonic counter on host promotion. The new
// host initializes to the viewer's `lastAppliedTurnIdx` so the next
// emitted packet (turnIdx + 1) lands monotonically for remaining guests
// who've already applied up to that count.
export function setResolverTurnIdx(n) { _turnIdx = n | 0; }

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
  const finalState = _buildAutoFinalState(_refsFromPacket(packet));
  const targetLocal = _resolveLocalActor(input.target);
  const killsTarget = !!(targetLocal && targetLocal.hp <= 0);
  const viewEvent = buildAttackViewEvent({
    actor:       input.actor,
    target:      input.target,
    hits:        input.hits,
    weaponId:    input.weaponId,
    hand:        input.hand,
    killsTarget,
    finalState,
  });
  return _emitWithViewEvent(packet, viewEvent);
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
  const finalState = _buildAutoFinalState([input.target]);
  const targetLocal = _resolveLocalActor(input.target);
  const killsTarget = !!(targetLocal && targetLocal.hp <= 0);
  const viewEvent = buildMonsterAttackViewEvent({
    monsterIdx:   input.monsterIdx,
    target:       input.target,
    dmg:          input.dmg,
    miss:         input.miss,
    statusAdded:  input.statusAdd | 0,
    killsTarget,
    finalState,
  });
  return _emitWithViewEvent(packet, viewEvent);
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
  // ViewEvent targets — derive from host-arb's per-target results.
  const vTargets = Array.isArray(input.results) ? input.results.map(r => ({
    ref:           r.target,
    result:        r.miss ? 'miss' : (r.absorbed ? 'absorbed' : 'hit'),
    dmg:           r.dmg  | 0,
    heal:          r.heal | 0,
    statusAdded:   r.statusAdd    | 0,
    statusRemoved: r.statusRemove | 0,
    revives:       !!r.revive,
    kills:         !!r.death,
  })) : [];
  const refs = [input.actor, ...vTargets.map(t => t.ref)].filter(Boolean);
  const finalState = _buildAutoFinalState(refs);
  const viewEvent = buildMagicViewEvent({
    actor:      input.actor,
    spellId:    input.spellId,
    targets:    vTargets,
    isItemUse:  !!input.isItemUse,
    finalState,
  });
  return _emitWithViewEvent(packet, viewEvent);
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
  // Items typically single-target — pick the first result's target.
  const firstResult = (Array.isArray(input.results) && input.results[0]) || {};
  const refs = [input.actor, firstResult.target].filter(Boolean);
  const finalState = _buildAutoFinalState(refs);
  const viewEvent = buildItemViewEvent({
    actor:          input.actor,
    itemId:         input.itemId,
    target:         firstResult.target,
    dmg:            firstResult.dmg  | 0,
    heal:           firstResult.heal | 0,
    revives:        !!firstResult.revive,
    statusRemoved:  firstResult.statusRemove | 0,
    finalState,
  });
  return _emitWithViewEvent(packet, viewEvent);
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
  const ticks = (Array.isArray(input.results) ? input.results : []).map(r => ({
    ref:   r.target,
    dmg:   r.dmg | 0,
    kills: !!r.death,
  }));
  const refs = ticks.map(t => t.ref).filter(Boolean);
  const finalState = _buildAutoFinalState(refs);
  const viewEvent = buildPoisonTickViewEvent({ ticks, finalState });
  return _emitWithViewEvent(packet, viewEvent);
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
  // ViewEvent — carries rewards baked in so guest's victory screen
  // doesn't need to read battleSt.encounterExpGained.
  const viewEvent = buildEncounterEndViewEvent({
    outcome: input && input.outcome,
    rewards: (input && input.rewards) || null,
    // No actor refs to populate finalState — encounter-end is the
    // final state by definition. Viewer transitions to box-close.
    finalState: { actors: [], monsters: [] },
  });
  return _emitWithViewEvent(packet, viewEvent);
}

// Re-export the pure builder so callers can inspect a snapshot's shape
// without sending it. Live host emit goes through `resolveEncounterJoin`.
export { buildEncounterSnapshot };

// ── P5 — new resolver entries for viewer-mode events ──────────────────
//
// These ship ViewEvents that don't have an existing host-arb-deltas
// equivalent. Each emits a minimal legacy packet (action: kind) for
// backwards-compat + the ViewEvent for viewers.

// `input`: { monsterIdx }
export function resolveMonsterDeath(input) {
  const idx = (input && input.monsterIdx | 0) | 0;
  const mon = battleSt.encounterMonsters && battleSt.encounterMonsters[idx];
  const packet = {
    actor:  { kind: 'system' },
    action: { kind: 'monster-death', monsterIdx: idx },
    deltas: [],
    fx:     [{ kind: 'death', target: { kind: 'monster', idx } }],
    meta:   { encounterEnd: false },
  };
  const finalState = mon ? {
    actors: [],
    monsters: [{ idx, hp: 0, statusMask: (mon.status && mon.status.mask) | 0, alive: false }],
  } : { actors: [], monsters: [] };
  const viewEvent = buildMonsterDeathViewEvent({ monsterIdx: idx, finalState });
  return _emitWithViewEvent(packet, viewEvent);
}

// `input`: { target: ActorRef }
export function resolvePlayerDeath(input) {
  const target = input && input.target;
  if (!target) return null;
  const packet = {
    actor:  { kind: 'system' },
    action: { kind: 'player-death', target },
    deltas: [],
    fx:     [{ kind: 'death', target }],
    meta:   { encounterEnd: false },
  };
  const finalState = _buildAutoFinalState([target]);
  const viewEvent = buildPlayerDeathViewEvent({ target, finalState });
  return _emitWithViewEvent(packet, viewEvent);
}

// `input`: { actor: ActorRef, promptUserId?: number }
// `promptUserId` — if set AND a recipient's userId matches, that
// recipient's viewer surfaces the menu. For v1 we ship the flag
// universally (the per-recipient gate lives in the viewer's
// `_animTurnBegin` reading event.prompt and comparing to its myUid).
//
// Production wiring (P6+): host's `battle-turn.js#processNextTurn`
// calls this right before dispatching each turn so guests know who's
// active.
export function resolveTurnBegin(input) {
  const actor = (input && input.actor) || { kind: 'system' };
  const packet = {
    actor,
    action: { kind: 'turn-begin' },
    deltas: [],
    fx:     [],
    meta:   { encounterEnd: false },
  };
  const viewEvent = buildTurnBeginViewEvent({
    actor,
    prompt:     !!(input && input.prompt),
    finalState: { actors: [], monsters: [] },
  });
  return _emitWithViewEvent(packet, viewEvent);
}

// `input`: { monsters, combatants, hostUserId, midBattle? }
// Host emits at encounter spawn (flash-strobe entry) — replaces the
// guest's local `setNetEncounterInviteHandler` build-state path under
// viewer mode. Carries realized stats so guest never runs
// generateAllyStats.
export function resolveEncounterStart(input) {
  if (!input) return null;
  const packet = {
    actor:  { kind: 'system' },
    action: { kind: 'encounter-start' },
    deltas: [],
    fx:     [],
    meta:   { encounterEnd: false },
  };
  const viewEvent = buildEncounterStartViewEvent({
    monsters:   input.monsters,
    combatants: input.combatants,
    hostUserId: input.hostUserId | 0,
    midBattle:  !!input.midBattle,
    finalState: { actors: [], monsters: [] },
  });
  return _emitWithViewEvent(packet, viewEvent);
}

// Phase 6.7 — single source of truth for the guest-side short-circuit
// gate. Returns true when this client is a guest in an active host-arb
// co-op battle and should defer authoritative mutations to incoming
// resolution packets. Used at every legacy local-apply call site.
//
// IMPORTANT: when this returns true, the local FSM should NOT mutate
// HP / status — the host's emitted resolution will arrive shortly and
// the applier will write the authoritative values. Animation cues
// (slash, cast windup, damage-num display) continue to fire from the
// FSM as today; only the underlying state change is deferred.
//
// Caveats (closed in Phase 6.9 via fx-cue dispatch in coop-applier.js):
//   - Damage numbers now overlay the host's authoritative value when
//     the resolution packet arrives, via `damage-num` fx cues.
//   - Monster death transitions fire from `death` fx cues so the
//     dissolve anim plays even if the FSM advanced past its local
//     hp-check before the packet landed.
//
// Remaining edge case: player/ally death anim still drives off the
// local hp=0 check the applier writes (~1 FSM tick latency at 60fps;
// usually invisible). Acceptable for v1; can add player/ally death-cue
// dispatch if live testing surfaces an issue.
export function isCoopGuest() {
  return COOP_HOST_ARB
      && battleSt.isWireEncounter
      && !battleSt.encounterIsHost;
}

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

// ── P5 — ViewEvent finalState helpers ──────────────────────────────────
//
// Each ViewEvent carries `finalState` so the guest's viewer reconciles
// to authoritative HP/status after the anim. We build it by reading
// host-side state RIGHT NOW (post-apply); whoever called the resolver
// has already mutated battleSt + ps + encounterMonsters locally.

// Resolve an ActorRef to the host's local state pointer. Mirrors what
// `coop-applier.js#resolveActorRef` does on the guest side — kept
// aligned so both walks of the ref produce the same actor.
export function _resolveLocalActor(ref) {
  if (!ref) return null;
  if (ref.kind === 'monster') {
    const idx = ref.idx | 0;
    return (battleSt.encounterMonsters && battleSt.encounterMonsters[idx]) || null;
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

// Build the ViewEvent finalState block from a list of refs. Reads each
// actor's current hp/mp/status/alive directly from host state. Refs
// that don't resolve are dropped (peer dropped mid-packet).
//
// Output shape matches `coop-deltas.js#buildFinalState`:
//   { actors: [{ ref, hp, mp, statusMask, alive }, ...],
//     monsters: [{ idx, hp, statusMask, alive }, ...] }
export function _buildAutoFinalState(refs) {
  const actors = [];
  const monsters = [];
  if (!Array.isArray(refs)) return { actors, monsters };
  const seen = new Set();
  for (const ref of refs) {
    if (!ref) continue;
    const key = ref.kind + ':' + (ref.kind === 'monster' ? (ref.idx | 0) : (ref.userId | 0));
    if (seen.has(key)) continue;
    seen.add(key);
    const actor = _resolveLocalActor(ref);
    if (!actor) continue;
    if (ref.kind === 'monster') {
      monsters.push({
        idx:        ref.idx | 0,
        hp:         actor.hp | 0,
        statusMask: (actor.status && actor.status.mask) | 0,
        alive:      (actor.hp | 0) > 0,
      });
    } else {
      actors.push({
        ref,
        hp:         actor.hp | 0,
        mp:         actor.mp | 0,
        statusMask: (actor.status && actor.status.mask) | 0,
        alive:      (actor.hp | 0) > 0,
      });
    }
  }
  return { actors, monsters };
}

// Pull refs out of a resolution packet's actor + action.target. Used to
// auto-build finalState without callers passing explicit refs.
function _refsFromPacket(packet) {
  const refs = [];
  if (packet.actor) refs.push(packet.actor);
  if (packet.action && packet.action.target) refs.push(packet.action.target);
  return refs;
}

// ── P5 — emit a host-arb packet WITH an attached ViewEvent ─────────────
//
// Every resolver entry calls this. The legacy host-arb fields
// (deltas, fx) ride alongside the new ViewEvent block for backwards-
// compat with host-arb-only clients during the migration window. The
// guest's `coop-applier.js` (P4) routes to the viewer when
// `COOP_VIEWER_MODE && coopViewSt.active && msg.viewEvent`, else
// falls through to the legacy delta apply.
function _emitWithViewEvent(packet, viewEvent) {
  if (viewEvent) packet.viewEvent = viewEvent;
  return _emitResolution(packet);
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
