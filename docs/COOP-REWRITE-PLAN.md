# Co-op Battle Rewrite — Host-Authoritative Plan

**Status:** Phases 0-8 SHIPPED (commits `19f1403` → `6d05aac`). Live in prod at v1.7.473 with `COOP_HOST_ARB = false` — flag-off path runs unchanged. Two-phone smoke + flag flip is the remaining gate; see [`COOP-PHASE-6-SMOKE.md`](COOP-PHASE-6-SMOKE.md). Phase 7.5 (strip legacy lockstep code) deferred until 48h clean live smoke.
**Authored:** 2026-05-18 (v1.7.472 baseline)
**Scope:** random party encounters only — boss fights (LandTurtle) and solo random encounters use the unchanged single-player FSM; PvP duels use the unchanged lockstep model.
**Supersedes:** the v1.7.458 → v1.7.472 deterministic-lockstep fix attempts. Post-mortem of the broken state lives in the auto-memory file `project_ff3mmo_coop_sync_2026_05_18.md`.
**Line-number caveat:** every `file.js:NN` reference below was current as of v1.7.472 when this doc was authored. Verify with `git blame` before relying on a specific line.

## Contents

1. [Why we're rewriting](#why-were-rewriting)
2. [Target model: host-authoritative deltas](#target-model-host-authoritative-deltas)
3. [Why host-authoritative, not server-authoritative](#why-host-authoritative-not-server-authoritative)
4. [Wire contract](#wire-contract)
5. [Component design](#component-design)
6. [Per-turn flow walkthroughs](#per-turn-flow-walkthroughs)
7. [What stays local on every client](#what-stays-local-on-every-client)
8. [What disappears](#what-disappears)
9. [Migration phases](#migration-phases)
10. [PvP isolation guarantees](#pvp-isolation-guarantees)
11. [Edge cases + failure modes](#edge-cases--failure-modes)
12. [Risk register](#risk-register)
13. [Test plan](#test-plan)
14. [Rollback plan](#rollback-plan)
15. [File touchpoints](#file-touchpoints-estimated)
16. [Acceptance criteria](#acceptance-criteria)
17. [Out of scope](#out-of-scope)
18. [Open questions](#open-questions)

## Why we're rewriting

Co-op party-encounter battles desync between phones from round 1. Fifteen patch attempts across v1.7.458 → v1.7.472 made the symptom worse and demonstrated that the underlying model — **two phones each running the full battle FSM and praying `rand()` stays in lockstep** — cannot be made convergent inside its current shape.

The single biggest divergence source is structural, not a bug:

- When a monster attacks the triggerer, host's FSM takes the `targetAlly = -1` branch in `src/battle-enemy.js:248-273` and uses `ps.def`, `ps.elemResist`, `getShieldEvade()`, `ps.buffs.protect`, `ps.status` for status inflict.
- The same monster attack on the guest's FSM takes the `targetAlly >= 0` branch in `src/battle-enemy.js:228-247` and uses `ally.def`, no `elemResist`, `ally.shieldEvade`, no protect, no status inflict.

Same logical event, two different functions, different `rand()` consumption, different HP outputs. Per-turn reseed (v1.7.468) cannot wipe this — the divergence is *inside* the turn. Compound that with the host-self stats path mismatch (`recalcStats` vs `generateAllyStats`) and the wire pre-roll only covering damage values (not status inflicts, not protect halving, not elemental multipliers), and the lockstep model has no path to convergence.

**The fix is to stop running the simulation twice.** One side resolves the turn; the other side renders the result.

## Target model: host-authoritative deltas

The encounter **host** (the player who triggered the random encounter; for assist-converted solo battles, the player who got assisted) is the single source of truth for combat resolution. All other clients in the encounter group ("guests") receive **delta packets** and apply them locally.

```
Host's local FSM            Wire (server relay)              Guest's local FSM
─────────────────────       ──────────────────               ─────────────────────
[player turn]                                                [stalls at menu-open]
  picks action               ←── encounter-action ─────         emits intent
  resolves locally
  rolls damage, status
  applies to host state
  emits resolution           ─── encounter-resolution ──→     applies deltas
                                                              plays anim from fx cues
                                                              advances FSM

[ally turn for guest A]
  waits on action            ←── encounter-action ─────       picks action, emits
  resolves locally
  applies                    ─── encounter-resolution ──→     applies own deltas
                                                              plays anim
[monster turn]
  picks target
  resolves
  applies                    ─── encounter-resolution ──→     applies deltas
                                                              plays anim
```

Crucially: **guests never call `rand()` for combat outcomes**. Guests roll `rand()` only for cosmetic noise (particle scatter, camera shake jitter). All combat math runs on the host. The two-code-path problem in `battle-enemy.js` ceases to be a divergence source because the guest no longer takes either branch — it just applies HP deltas.

## Why host-authoritative, not server-authoritative

The server is a relay, not a simulator. Moving combat resolution to the server would require porting `battle-math.js`, `combatant-cast.js`, `applyMagicDamage`, status mechanics, item effects, weapon ATK rolls, etc. into Node — roughly 5k lines duplicated, plus a perpetual sync burden every time client-side balance changes. Host-authoritative keeps all combat logic in client code where it already lives. Server stays a dumb forwarder.

Trade-off: host can theoretically cheat by emitting bogus deltas. Out of scope for v1 — co-op is cooperative, not adversarial. PvP duels (which *are* adversarial) keep their existing lockstep model untouched.

---

## Wire contract

### New message: `encounter-resolution` (host → all guests via server relay)

```js
{
  type: 'encounter-resolution',
  turnIdx: <int>,           // host's monotonic counter, starts at 1
  actor: <ActorRef>,        // who took the turn
  action: <ActionRef>,      // what they tried (for message-strip text + anim selection)
  deltas: [<Delta>, ...],   // state mutations, applied in order
  fx: [<FXCue>, ...],       // animation cues, played in order
  meta: {
    encounterEnd: <bool>,   // host transitioned to victory/defeat — guest follows
    outcome: <string>,      // 'victory' | 'defeat' | 'fled' (only when encounterEnd)
  }
}
```

### `ActorRef` shape

```js
{ kind: 'player', userId: <int> }     // a human in the encounter (host or guest)
{ kind: 'monster', idx: <int> }       // encounterMonsters[idx]
```

`ally` is not a top-level kind — every "ally" on every client maps back to a userId. Each guest looks up the actor's userId: if it matches their own, route to `ps`; otherwise route to `battleAllies[i]` where `battleAllies[i].userId === ref.userId`.

### `ActionRef` shape

```js
{ kind: 'attack',  target: <ActorRef> }
{ kind: 'magic',   spellId: <int>, targets: [<ActorRef>, ...] }
{ kind: 'item',    itemId: <int>,  targets: [<ActorRef>, ...] }
{ kind: 'defend' }
{ kind: 'run' }
{ kind: 'skip' }                       // missed turn (timer expired)
{ kind: 'monster-attack', target: <ActorRef> }
{ kind: 'monster-special', name: <string>, target: <ActorRef> }
{ kind: 'poison-tick' }                // end-of-round batch
```

### `Delta` shape

```js
{
  target: <ActorRef>,
  hp:     <int>,           // signed; negative = damage, positive = heal, 0 = no change
  mp:     <int>,           // signed
  status: {                // optional
    add:    <int>,         // STATUS bitmask to OR in
    remove: <int>,         // STATUS bitmask to AND-NOT
  },
  poisonDmgTick: <int>,    // optional, mirror of status-effects field
  death: <bool>,           // host computed hp <= 0 → guest plays death anim
}
```

### `FXCue` shape

```js
{ kind: 'slash',       attacker: <ActorRef>, target: <ActorRef>, weaponId: <int>, hand: 'R'|'L', frames: [...], crit: <bool>, miss: <bool>, shieldBlock: <bool> }
{ kind: 'magic-cast',  caster: <ActorRef>, spellId: <int> }
{ kind: 'magic-impact',target: <ActorRef>, spellId: <int>, miss?: <bool> }
{ kind: 'damage-num',  target: <ActorRef>, value: <int>, variant: 'dmg'|'heal'|'miss'|'crit' }
{ kind: 'death',       target: <ActorRef> }
{ kind: 'sfx',         id: <string> }
{ kind: 'msg',         bytes: [...] }    // battle-message-strip text
```

Each cue is self-describing; guest dispatches to the existing animation code paths (slash-effects, spell-cast anim, damage-numbers, etc.) but never *decides* what to play — host already decided.

### Existing `encounter-action` shape (guest → host via server relay)

Kept, but **stripped down**. Guests no longer pre-roll anything; they just declare intent:

```js
{ kind: 'attack',  target: <ActorRef> }
{ kind: 'magic',   spellId: <int>, targets: [<ActorRef>, ...] }
{ kind: 'item',    itemId: <int>,  targets: [<ActorRef>, ...] }
{ kind: 'defend' | 'run' | 'skip' }
```

No `hitResults`, no `damageRoll`, no `healAmount`, no `preRolledAmount`. Host rolls everything.

### `encounter-snapshot` (host → joining guest only, on assist-accept)

Used to seed a mid-battle joiner with current state. Replaces today's `encounter-assist-snapshot`:

```js
{
  type: 'encounter-snapshot',
  turnIdx: <int>,                       // host's current counter
  battleState: <string>,                // FSM state to start at on guest
  monsters: [{ monsterId, hp, status }, ...],
  combatants: [{ userId, hp, mp, status, stats: {atk,def,agi,maxHP,...} }, ...],
  hostUserId: <int>,
}
```

Combatants ship **fully-realized stats** rather than profile fields run through `generateAllyStats` on guest. Removes the host-self stats divergence.

---

## Component design

### Host-side resolver: `src/coop-resolver.js` (NEW)

Owns the turn-resolution loop. One entry per turn type:

- `resolvePlayerTurn(actorRef, action)` — host runs the action against host state, returns `{deltas, fx}`.
- `resolveMonsterTurn(monsterIdx)` — host runs monster AI, picks target, rolls damage/status, returns `{deltas, fx}`.
- `resolvePoisonTick()` — host enumerates poisoned actors, returns batch `{deltas, fx}`.

Each resolver:
1. Reads current local state.
2. Calls existing math helpers (`rollHits`, `applyMagicDamage`, `tryInflictStatus`, etc.) **once**.
3. Captures the mutations as deltas instead of mutating live state directly.
4. Synthesizes fx cues from the same data the local FSM would have used for animation.
5. Returns the packet for the wire emitter.

The host then **applies its own deltas locally** through the same code path guests will use — guaranteeing host's local state matches what guests see.

### Guest-side applier: `src/coop-applier.js` (NEW)

One entry: `applyResolution(msg)`.

1. Validate `turnIdx` is the expected next (queue out-of-order packets).
2. Apply each delta to the addressed actor (host's `ps` if `userId === myUid`, else `battleAllies[i]` where userId matches, else monster idx).
3. Dispatch each fx cue to the existing animation entry points (`battleSt.battleState = 'attack-back'`, `ally-magic-cast`, `monster-death`, etc.).
4. Advance the FSM as fx cues complete.

### Wire surface: `src/encounter-wire.js`

- Add `sendEncounterResolution(packet)` host-side emit.
- Add `setNetEncounterResolutionHandler(fn)` guest-side receive.
- Server relays unchanged (it's already a dumb pipe).

### Server: `ws-presence.js`

One new message type, one new relay case. No state changes. Same group membership (`_encounterGroups`). Same rate limit (probably 30 msg/sec cap per encounter — tune during phase 2).

---

## Per-turn flow walkthroughs

### Host's own physical attack

1. Host picks command at `menu-open` → `confirm-pause` → dispatches `processNextTurn`.
2. Local FSM runs `_playerTurnFight` unchanged. (Pre-roll of `hitResults` already happened at menu-confirm time in `input-handler.js`; the local FSM consumes those rolls. Under host-arb that pre-roll stays — it's host-local state, not wire input.)
3. At slash-apply time (`applyPhysicalHitToEnemy`), host computes damage + status, builds delta + fx packet from the same data, sends `encounter-resolution`, applies delta locally.
4. Local FSM advances as today.
5. Guest receives packet at slash-time (~150ms after host started anim), applies damage to its `encounterMonsters[idx]`, animates slash on its view of host (battleAllies[hostIdx]).

### Guest's own physical attack

1. Guest picks command → `menu-open` → `confirm-pause`.
2. Guest emits `encounter-action {kind: 'attack', target: {kind: 'monster', idx}}` — no rolls.
3. Guest's local FSM **stalls** at a new `wait-for-resolution` state. Anim does not start.
4. Host receives action, dequeues at its `ally` turn slot, runs `_resolveAllyAttack(hostView)`, rolls hits, builds packet, emits.
5. Both guest and host (and any other peer) receive the resolution. Guest's local FSM exits `wait-for-resolution`, starts slash anim, applies delta at apply-time.

*Latency note:* guest's own attack will feel ~150-300ms slower than today (round-trip stall). For v1 this is acceptable — the predictability of correct state matters more than crispness. Optimistic local anim (start slash immediately, hold damage until resolution arrives) is a v2 polish item, not a v1 requirement.

### Monster turn

1. Host's monster-turn slot dispatches as today.
2. Monster AI picks target on host alone (no `Math.random` synchronization needed).
3. Host runs `rollMultiHit` against the *correct* code path for the target (ps vs ally), applies all the rules (`buffs.protect`, `elemResist`, `statusAtk` inflict).
4. Host emits resolution.
5. Guest applies HP delta to whoever the target is (its own `ps`, an ally cell, etc.), animates from fx cues.

The `targetAlly = -1` vs `targetAlly >= 0` divergence disappears because guest no longer runs `_processEnemyTurn`. Guest's monster-turn slot becomes a no-op that waits for the resolution.

### Magic cast (offensive)

1. Host or guest picks magic at menu.
2. Same action-emit-then-stall flow as physical.
3. Host runs the full spell pipeline: cast windup → projectile → impact → `applyMagicDamage` (hit-check rand consumed once, host-side only).
4. Host packet contains: damage delta on target, status delta if the spell inflicts, fx cues for cast/projectile/impact/damage-number.
5. Guest renders all fx; never touches `applyMagicDamage` for wire-driven combatants.

### Multi-target spell (e.g., Curaga on all party)

One resolution packet, multiple deltas + impact fx cues. Host rolls each target's heal amount, packs them all, emits once. Guest applies in order, animates each impact in sequence (same timing the current pipeline uses).

### End-of-round poison tick

Host enumerates poisoned combatants, computes ticks, builds one packet with N deltas + N damage-num fx cues. Guest applies all in a batch — matches today's "consolidated end-of-round phase" UX exactly.

### Assist join mid-battle

1. Joiner sends `encounter-assist-request`.
2. Host receives, accepts, builds `encounter-snapshot` containing **realized stats** for every combatant (not profile fields).
3. Server relays snapshot to joiner only.
4. Joiner spawns local battle from snapshot, registers their userId with host's resolver.
5. From this point forward joiner receives normal `encounter-resolution` stream.
6. Host adds joiner as ally on its side, includes in next turn order rebuild.

The `_pendingAssistIncoming` queue + `menu-open` deferral logic can be retired — host is the only one running the FSM authoritatively, so there's no "mid-round divergence between snapshot send and joiner spawn" window.

---

## What stays local on every client

These are per-client UI/rendering concerns, never on the wire:

- Camera shake, particle scatter, screen flash
- SFX dispatch (each client plays its own audio from fx cues; the cue says "play FIRE_BOOM", each client decides whether to actually play it based on local mute/volume)
- Menu cursor position, target picker state
- Battle BG selection (deterministic from encounter zone, same on all clients)
- Sprite cache, palette setup
- Local roster panel rendering, fade-in animations
- Battle-message-strip rendering (text bytes ride in fx cues; rendering is local)

## What disappears

The following code goes away once Phase 5 lands:

- `prerollSpellAmount` / `isHealSpell` exports in `spell-cast.js` (no more pre-roll)
- `opts.preRolledAmount` plumbing through `startSpellCast`
- The wire-magic `damageRoll`/`healAmount` fields in `encounter-action`
- `reseedCoopTurnRand` / `maybeReseedCoopTurn` / `battleSt.perTurnIndex` (guest doesn't roll → no reseed needed)
- `_pushPlayerCoop` canonical-sort in `buildTurnOrder` (host alone decides turn order; emits via fx cues if needed)
- `_pendingAssistIncoming` queue + `drainPendingAssistIncoming` (no mid-round divergence window)
- The `targetAlly >= 0` branch's stat-divergence from the `targetAlly = -1` branch becomes irrelevant (guest never runs either)

That's ~300 lines of complexity retired.

---

## Migration phases

Each phase ends in a green deploy with no regression in PvP, solo, or boss flows. Phases 1-5 land behind a `COOP_HOST_ARB` build-time const (default `false`) so the old path keeps working until phase 6 flips it. Runtime debug toggle is deferred to phase 6 if needed for live A/B comparison.

### Phase 0 — Convergence harness

**Goal:** build the regression gate that should have existed all along.

- Create `tools/coop-arbiter-sim.js`. Spins up two in-process `battleSt` instances, plus a host resolver. Feeds the same `encounter-action` stream, asserts HP / status / queue convergence after N rounds.
- Phase 0 expectation: harness **fails** against current lockstep code. That failure is the baseline we'll fix.
- Wire into `deploy.sh` as a pre-flight gate alongside `pvp-wire-sim.js` and `battle-sim.js`.

**Deliverables:** `tools/coop-arbiter-sim.js`, `tools/coop-arbiter-sim.PLAN.md`, deploy.sh edit.
**Risk:** none — pure tooling addition.
**Smoke gate:** harness runs locally, prints expected-baseline failures.

### Phase 1 — Wire shape + flag scaffold

**Goal:** define the new wire surface without changing behavior.

- Add `encounter-resolution` + `encounter-snapshot` (new shape) message types in `src/encounter-wire.js`.
- Add `sendEncounterResolution`, `setNetEncounterResolutionHandler` setters in `src/net.js`.
- Add server relay case in `ws-presence.js`. Mirror the `encounter-action` relay shape: forward to all peers in `_encounterGroups[userId]` except sender.
- Add `COOP_HOST_ARB` flag (top of `src/encounter-wire.js`, exported). Default `false`.
- Create stub `src/coop-resolver.js` + `src/coop-applier.js` with empty entry points.

**Deliverables:** new wire constants, server relay, flag, two empty modules.
**Risk:** none — flag-off path is unchanged.
**Smoke gate:** PvP-wire-sim 49/49 green, deploy lands, prod unaffected.

### Phase 2 — Physical attack migration

**Goal:** host-arb path covers monster-attack and player/ally physical attacks.

- `resolveMonsterTurn` in `coop-resolver.js`: runs `_processEnemyTurn` logic, captures damage as delta, packs fx cue for slash impact + damage number.
- `resolvePlayerAttack(actorRef, target)` + `resolveAllyAttack(actorRef, target)`: similar, for physical attacks.
- `applyResolution` in `coop-applier.js`: handles `attack` and `monster-attack` action kinds.
- Gate host-side: when `COOP_HOST_ARB && battleSt.isWireEncounter && battleSt.encounterIsHost`, host calls resolver instead of mutating directly.
- Gate guest-side: when `COOP_HOST_ARB && battleSt.isWireEncounter && !battleSt.encounterIsHost`, guest's monster-turn slot becomes a no-op (waits for resolution); guest's own-attack slot stalls at `wait-for-resolution`.
- Extend `coop-arbiter-sim.js` to assert convergence on physical-only scenarios. Should now pass with flag on.

**Deliverables:** resolver/applier physical paths, gated FSM no-ops on guest, sim assertions.
**Risk:** medium — touches `battle-enemy.js` and `battle-ally.js`. Hard guard by flag.
**Smoke gate:** pvp-wire-sim 49/49, battle-sim solo regression green, new coop-sim convergence after 50 rounds physical-only.

### Phase 3 — Magic migration

**Goal:** host-arb path covers every spell in `src/data/spells.js`.

- `resolveSpellCast(actorRef, spellId, targets)`: host runs `applySpell` once, captures every mutation (damage, heal, status, cure, sight, erase, drain), packs deltas + fx cues for cast/projectile/impact/numbers.
- `applyResolution` handles `magic` and multi-target deltas.
- Strip pre-roll plumbing on guest side (still works for flag-off path; flag-on path no-ops the pre-roll).
- Coop-sim assertions for spell scenarios (offensive, heal, status, cure-status, multi-target).

**Deliverables:** spell resolver, multi-target applier, sim coverage.
**Risk:** medium — touches `spell-cast.js`, `combatant-cast.js`, `battle-ally.js`. Flag-gated.
**Smoke gate:** pvp-wire-sim + battle-sim green; coop-sim convergence with magic + physical mixed.

### Phase 4 — Item, status tick, KO/death

**Goal:** finish parity with the current FSM.

- `resolveItemUse(actorRef, itemId, targets)`.
- `resolvePoisonTick()` — batch packet at end-of-round.
- Death routing through fx cue `{kind: 'death', target}` — guest plays death anim + advances FSM identically.
- Guest's local death detection (`if (mon.hp <= 0) → monster-death state`) becomes a fx-cue trigger only.

**Deliverables:** item/poison/death paths, coop-sim coverage.
**Risk:** medium — death state transitions are timing-sensitive. Test KO scenarios in two-tab live.
**Smoke gate:** all sims green; coop-sim full-scenario coverage (boss-free; co-op doesn't apply to bosses).

### Phase 5 — Assist join + encounter-snapshot

**Goal:** mid-battle joining works under host-arb.

- New `encounter-snapshot` payload shape (realized stats, not profile fields).
- Host-side snapshot builder in `coop-resolver.js`.
- Guest-side snapshot consumer in `coop-applier.js`.
- Retire `_pendingAssistIncoming` queue (no longer needed — host is single source of truth).

**Deliverables:** snapshot builder/consumer, queue removal.
**Risk:** low — assist join is a single code path, well-isolated.
**Smoke gate:** all sims green; live assist-join test on two tabs.

### Phase 6 — Flip the flag

**Goal:** make host-arb the live default.

- Change `COOP_HOST_ARB` default to `true`.
- Live two-phone smoke: party encounter, 5 rounds physical, 5 rounds magic, 1 KO event, 1 assist-join, 1 disconnect.
- Deploy.

**Deliverables:** one-line flag flip, deploy.
**Risk:** highest — first live exposure of the new model.
**Smoke gate:** live two-phone test passes; HP matches on both screens after 10 rounds.

### Phase 7 — Dead-code cleanup

**Goal:** retire the lockstep scaffolding.

- Delete `prerollSpellAmount`, `isHealSpell`, `opts.preRolledAmount`, `damageRoll`/`healAmount` fields from `encounter-action`.
- Delete `reseedCoopTurnRand`, `maybeReseedCoopTurn`, `battleSt.perTurnIndex`.
- Delete `_pushPlayerCoop` (replaced by host-emitted turn order in resolution fx).
- Delete `COOP_HOST_ARB` flag (or leave as a kill-switch — small cost, useful for rollback).
- Strip flag-off branches throughout.

**Deliverables:** cleanup PR. Diff stat: ~300 lines removed.
**Risk:** low — flag-off path is no longer exercised, deletion is mechanical.
**Smoke gate:** sims green, deploy.

### Phase 8 — Docs

**Goal:** capture the new model so future-Claude doesn't reinvent the lockstep failure.

- Rewrite `MULTIPLAYER.md` co-op section.
- Update `docs/design-notes.md` co-op architecture entry.
- Update `MEMORY.md` index: replace `project_ff3mmo_coop_sync_2026_05_18.md` (the broken-state memory) with a new `project_ff3mmo_coop_host_arb.md` describing the working model.
- Update `MULTIPLAYER-AUDIT-2026-05-15.md` with a status footnote pointing at the rewrite.
- Update `CHANGELOG.md`: clear the co-op-broken banner.

---

## PvP isolation guarantees

Every change is gated by `battleSt.isWireEncounter` (true for co-op only; PvP uses `pvpSt.isPVPBattle && pvpSt.isWirePVP`). Specifically:

- `src/coop-resolver.js` is only invoked when `isWireEncounter && encounterIsHost`. PvP never touches it.
- `src/coop-applier.js` is only invoked when `isWireEncounter && !encounterIsHost`. PvP never touches it.
- `src/encounter-wire.js` handlers gate on `isWireEncounter` before processing.
- `src/pvp.js`, `src/pvp-search.js`, `src/party-invite.js` are not modified.
- `src/battle-turn.js` `_pushPlayerCoop` is replaced by a host-only path; PvP's `_wirePushOppFirst` swap logic is untouched.
- `src/battle-enemy.js` `targetAlly >= 0` branch is conditionally short-circuited only when `isWireEncounter && !encounterIsHost`. PvP runs through the same branch unchanged (PvP doesn't set `isWireEncounter`).

`pvp-wire-sim.js` (49 tests) is the regression gate; runs in `deploy.sh` before every commit. Any phase that fails any pvp-wire-sim test does not ship.

---

## Edge cases + failure modes

### Host disconnect mid-battle

- Server detects WS drop, broadcasts `encounter-end {outcome: 'host-disconnect'}` to all members of `_encounterGroups[hostUid]`.
- Each guest force-closes their battle to `encounter-box-close` with no XP / no gil (no resolution = no outcome).
- Guests remain in their party; can re-trigger encounters independently.
- **Why not promote a new host?** v1 simplicity. The "guest gets promoted" path would need to re-establish full state ownership including monster HP/status, in-flight turn queue, etc. Defer to v2.

### Guest disconnect mid-battle

- Server detects, sends `encounter-action {kind: 'disconnect'}` (existing path) to host.
- Host removes the dropped guest from `battleAllies`, skips any queued turns for them, continues battle.
- Remaining guests see a "Player left the battle" chat line + ally portrait disappears via the existing `setNetEncounterEndHandler` peer-remove path.

### Action arrives out of order

Each resolution packet carries `turnIdx`. Guest tracks `_lastAppliedTurnIdx`:

- `msg.turnIdx === _lastAppliedTurnIdx + 1` → apply immediately.
- `msg.turnIdx > _lastAppliedTurnIdx + 1` → queue, apply when gaps fill in.
- `msg.turnIdx <= _lastAppliedTurnIdx` → dupe, drop.

Should be rare under TCP, but worth handling defensively.

### Host's resolution emit fails (server unreachable mid-packet)

Host still applies the delta locally (single source of truth). Guests miss the turn. They'll appear stale until the next packet they receive — which will have a higher `turnIdx` than expected, triggering the gap-fill path above. If gaps remain unfilled for >5 seconds, guest force-closes to `encounter-box-close` (encounter-recovery failure).

### Guest's action emit fails

Host's local FSM stalls at the ally turn slot waiting for the action. Existing `WIRE_WAIT_TIMEOUT_MS = 10000` watchdog catches this — host's `_processNextTurn` skips the turn. Resolution for the skip is emitted with `action: {kind: 'skip'}`; guest applies (no state mutation but FSM advances).

### Simultaneous KO (host + guest both at 0 HP)

Host's resolver computes both deaths in the same turn's deltas. Packet contains two delta entries with `death: true`. Guest applies both. Battle wraps to defeat.

### Cosmetic-only divergence (camera shake, particle scatter)

Acceptable. These ride local `Math.random()` and won't be identical between phones. They don't affect HP / state.

---

## Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Own-turn latency (~200ms stall) | Medium | v1 ships with stall; v2 adds optimistic local anim. Document in changelog. |
| Host has more compute load | Low | Co-op = 2-3 players; host runs at most 3× actor turns. Negligible. |
| Server message rate spike | Low | Resolution packets ~same volume as today's action packets, just bigger. Existing rate-limit + monitoring catches abuse. |
| Resolution packet desync (gaps, dupes) | Low | turnIdx ordering protocol above. |
| PvP regression from shared-code edits | Medium | Hard guard by `isWireEncounter` flag at every change site; pvp-wire-sim 49/49 gate. |
| Host crashes mid-emit | Low | Host force-disconnects → server broadcasts encounter-end → guests close. |
| Cheating host (malicious delta emit) | Out of scope | Co-op only. PvP is separate model. |

---

## Test plan

### Continuous (pre-deploy gates in `deploy.sh`)

- `node tools/pvp-wire-sim.js` — must stay 49/49 throughout all phases.
- `node tools/battle-sim.js --runs=100` — solo regression.
- `node tools/coop-arbiter-sim.js` — new harness, gates from Phase 0 onward.

### Per-phase

- Phase 2 — coop-arbiter-sim physical-only convergence after 50 rounds.
- Phase 3 — coop-arbiter-sim mixed magic/physical, all 88 spell IDs sampled.
- Phase 4 — coop-arbiter-sim with poison ticks, KOs, item use.
- Phase 5 — coop-arbiter-sim with mid-battle assist join, host snapshot to joiner.
- Phase 6 — live two-phone smoke (documented checklist below).

### Phase 6 live smoke checklist

1. Two phones, same party. Phone A triggers encounter. Both see 2-row roster.
2. Both phones: HP matches at start.
3. 5 rounds of attacks. After each round, both phones' HP, MP, status icons match.
4. One phone casts Fire on a monster. Damage number + monster HP matches on both phones.
5. One phone casts Cure on the other. Heal number + HP delta matches.
6. Monster KOs a player. Death anim on both phones at same logical turn.
7. Surviving player kills last monster. Victory flow runs on both phones, same XP/gil.
8. Phase 6 ships only if all 7 pass.

### Phase 6 stress smoke (post-ship)

- Three-phone party encounter (when third party member becomes available).
- Mid-battle assist join: phone C walks up while A+B fight, picks Assist, all three see same state.
- Disconnect scenarios: phone A drops WS during round 2 — A's portrait disappears on B, battle continues.

---

## Rollback plan

Each phase 1-6 lands behind the `COOP_HOST_ARB` flag. To roll back any phase:

1. Hot-fix: set `COOP_HOST_ARB = false` at top of `src/encounter-wire.js`, deploy.
2. Lockstep code path resumes (still broken, but matches v1.7.472 baseline — not worse).
3. Investigate, fix forward, re-flip.

Phase 7 (cleanup) is the point of no return — once flag-off branches are deleted, rollback requires a `git revert` of the phase 7 commit. Don't ship phase 7 until phase 6 has run live for at least 48 hours without incident.

---

## File touchpoints (estimated)

| File | Change kind | Phase |
|---|---|---|
| `src/coop-resolver.js` | NEW | 1-5 |
| `src/coop-applier.js` | NEW | 1-5 |
| `src/encounter-wire.js` | Extend (new emit/handler) | 1 |
| `src/net.js` | Extend (new setters) | 1 |
| `ws-presence.js` | Extend (new relay case) | 1 |
| `src/battle-state.js` | Add `_lastAppliedTurnIdx`, retire `perTurnIndex` | 1, 7 |
| `src/battle-update.js` | Gate confirm-pause emit on flag, retire pre-roll | 2-3, 7 |
| `src/battle-turn.js` | Stall guest turns on flag-on, retire `_pushPlayerCoop` | 2, 7 |
| `src/battle-enemy.js` | Short-circuit `targetAlly >= 0` on flag-on guest | 2 |
| `src/battle-ally.js` | Stall wire-driven turns until resolution arrives | 2-3 |
| `src/battle-encounter.js` | Retire `_pendingAssistIncoming` queue | 5, 7 |
| `src/spell-cast.js` | Retire `prerollSpellAmount` / `isHealSpell` | 7 |
| `tools/coop-arbiter-sim.js` | NEW | 0 |
| `tools/coop-arbiter-sim.PLAN.md` | NEW | 0 |
| `deploy.sh` | Add coop-sim gate (gitignored locally — apply per-developer) | 0 |
| `MULTIPLAYER.md` | Rewrite co-op section | 8 |
| `docs/design-notes.md` | Update co-op architecture entry | 8 |
| `CHANGELOG.md` | Per-phase + final "co-op restored" entry | every phase |
| `MEMORY.md` | New `project_ff3mmo_coop_host_arb.md` index entry | 8 |

`src/pvp.js`, `src/pvp-search.js`, `src/party-invite.js`, `src/pvp-wire-sim.js`: **not modified.**

---

## Acceptance criteria

The rewrite is complete and shippable when:

1. `tools/coop-arbiter-sim.js` passes 100% with `COOP_HOST_ARB=true`.
2. `tools/pvp-wire-sim.js` still passes 49/49.
3. `tools/battle-sim.js` solo regression unchanged.
4. Phase 6 live smoke checklist passes on two phones.
5. v1.7.472 broken-state memory replaced with a working-state project memory.
6. `MULTIPLAYER.md` co-op section reflects the new model.
7. The `COOP_HOST_ARB` flag is either deleted (phase 7) or kept as a documented kill-switch.

---

## Out of scope

- Server-side combat simulation (host-arb keeps logic client-side by design).
- Anti-cheat for host (co-op is cooperative; defer adversarial concerns to PvP).
- Optimistic local anim for own-turn latency (v2 polish).
- Promoting a new host on host disconnect (v2 if demand emerges).
- Replacing the lockstep model for PvP (PvP works as-is; only co-op is broken).
- Cross-encounter spectating, replay, or log capture.

---

## Open questions

These need decisions before phase 1 starts; flagged here so we don't paper over them in implementation.

1. **Snapshot stat shape for mid-battle joiners.** Ship realized `{atk, def, agi, maxHP, evade, mdef, hitRate, shieldEvade}` directly, OR ship profile fields + a guaranteed-deterministic stats helper that both host and guest call? Realized stats are simpler; profile-based is smaller wire payload. *Recommendation: realized stats — eliminates `recalcStats` vs `generateAllyStats` divergence as a class.*

2. **Resolution packet size budget.** A 4-actor end-of-round poison tick = 4 deltas + 4 damage-num cues ≈ 600 bytes. Acceptable but worth a soft cap (e.g., 4KB per packet) to catch runaway cases. *Recommendation: hard cap at 4KB, log + drop oversize packets.*

3. **What does the guest render during the own-turn stall?** Cursor disappears? Spinner? Just frozen menu? *Recommendation: keep menu visible with cursor disabled; no spinner (would feel laggy). v2 adds optimistic anim.*

4. **Should the `COOP_HOST_ARB` flag be a runtime toggle (URL param / debug tab) or a build-time const?** Runtime helps live debugging; build-time is safer. *Recommendation: build-time const for v1; expose runtime toggle in debug tab if needed during live testing.*
