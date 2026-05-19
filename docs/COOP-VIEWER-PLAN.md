# Co-op Viewer Rewrite — execution plan

**Goal:** Rebuild co-op battles around a card-game model: host runs the battle (already does, via host-arb), **guest does not run a battle FSM at all** — it's a packet-driven animation player with mutable display state. No frame-by-frame lockstep, no FSM-on-both-sides, no math on guest.

**Status:** Plan only. Implementation gated on user approval.
**Authored:** 2026-05-19.
**Owner:** Claude.
**Supersedes:** the host-arb-only model documented in `docs/COOP-REWRITE-PLAN.md`. Host-arb's resolver / deltas / snapshot are reused as the protocol layer; this plan replaces the *guest* side wholesale.

---

## TOC

- [Why the host-arb cutover failed live](#why)
- [The viewer model in one diagram](#diagram)
- [Wire protocol — event-discriminated packets](#protocol)
- [Guest state model](#state)
- [Animation registry](#anims)
- [Tick / render integration](#tick)
- [Input routing](#input)
- [Encounter lifecycle (spawn / end)](#lifecycle)
- [Host promotion under viewer mode](#promotion)
- [Backwards compatibility & migration](#compat)
- [Phasing](#phases)
- [File touchpoints](#files)
- [Risk register](#risks)
- [Acceptance criteria](#accept)
- [Open questions](#oq)
- [Effort estimate](#estimate)

---

<a id="why"></a>
## Why the host-arb cutover failed live

The host-arb rewrite (Phases 0–8, v1.7.473–v1.7.476) shipped **correctly** as a data-path rewrite: host computes outcomes, ships deltas, guest applies. But it kept the guest's frame-by-frame battle FSM running. The FSM expects:

1. Local `dispatchDelta` calls to land at predictable FSM phases (`ally-attack-back` → `ally-attack-fwd` → `ally-damage-show` → `monster-death`).
2. Wire-driven ally turns to dequeue `encounter-action` from `_wireEncounterActions` *at the moment* the FSM enters `ally-wire-wait`.
3. Monster turns to roll `rollMultiHit` locally and consume `rand()` calls in a specific order.

Host-arb disabled (1) on the guest via `isCoopGuest()`, but left (2) and (3) intact. The result:

- **Phone freezes** = FSM stuck in `ally-wire-wait` waiting on an `encounter-action` whose mate already resolved via `encounter-resolution`. The guest's queue drain logic and the applier's HP write race; FSM gets stuck in the gap.
- **Wrong HP / roster** = the guest's `setNetEncounterInviteHandler` doesn't override `stats.hp/maxHP` from the peer profile (only the *assist-snapshot* handler does — a pre-existing bug). Then resolution packets correct it on the host's view but the guest's roster ran on stale values from turn 0.
- **Desync** = the guest's monster HP gets written twice (once by FSM via local roll, once by applier via packet). v1.7.474's `isCoopGuest` short-circuits caught most but not all sites.

The **fundamental architectural mistake**: two FSMs running concurrently with subtle synchronization needs. A card-game model eliminates this — only ONE FSM exists (host's), and the guest is a *viewer*.

---

<a id="diagram"></a>
## The viewer model in one diagram

```
┌────────────────────────────────────────────────────────────────────┐
│  HOST PHONE (encounterIsHost = true)                               │
│                                                                    │
│  Input → battle-turn.js FSM (UNCHANGED) → resolves turn locally    │
│                                                                    │
│  coop-resolver.js emits ViewEvent per resolved turn:               │
│    • turn-begin                                                    │
│    • slash-hit (multi-hit array baked in)                          │
│    • magic-cast (cast → throw → impact → damage-show baked in)     │
│    • monster-attack                                                │
│    • poison-tick                                                   │
│    • monster-death                                                 │
│    • encounter-end                                                 │
│                                                                    │
│  Each packet is self-contained — full anim sequence + final state  │
└────────────────────────────────────────────────────────────────────┘
                                │
                       encounter-resolution
                                │  (extended w/ explicit anim cue)
                                ▼
┌────────────────────────────────────────────────────────────────────┐
│  GUEST PHONE (encounterIsHost = false, COOP_VIEWER_MODE = true)    │
│                                                                    │
│  battle-update.js FSM: SHORT-CIRCUITED at top — does NOT tick      │
│                                                                    │
│  coop-viewer.js tick:                                              │
│    1. If currently playing an anim, advance it (consume dt)        │
│    2. If anim done, write packet's final-state to battleSt         │
│    3. If queue non-empty, dequeue next ViewEvent, start its anim   │
│    4. Else idle                                                    │
│                                                                    │
│  Existing render reads battleSt — no render code changes needed    │
│                                                                    │
│  Guest input still rides legacy encounter-action (host needs to    │
│  know what they picked). Outbound path unchanged.                  │
└────────────────────────────────────────────────────────────────────┘
```

**Key insight:** The guest's `battleSt.battleState` is repurposed as a *display* state, not an FSM state. The viewer drives it. Existing renderer keeps working.

---

<a id="protocol"></a>
## Wire protocol — event-discriminated packets

Single packet type `encounter-resolution` carries one `ViewEvent`. Backwards-compat with existing host-arb packets — we add `eventKind` discriminator and a baked-in animation block.

```ts
type ViewEvent =
  | TurnBeginEvent
  | AttackEvent          // physical multi-hit, all hands
  | MagicEvent           // full cast → impact → damage sequence
  | ItemEvent            // item use, includes heal/cure/revive
  | MonsterAttackEvent
  | PoisonTickEvent      // round-end batch
  | MonsterDeathEvent
  | PlayerDeathEvent     // includes ally death
  | EncounterStartEvent  // shipped on host's flash-strobe begin (replaces invite-build-state on guest)
  | EncounterEndEvent;   // victory / defeat / fled + xp/gil/drops

type Base = {
  turnIdx: number;           // monotonic per encounter; viewer enforces strict-increase or queues
  eventKind: ViewEvent['kind'];
  finalState: {              // authoritative state snapshot AFTER this event lands
    actors: Array<{ ref: ActorRef; hp: number; mp?: number; statusMask: number; alive: boolean }>;
    monsters: Array<{ idx: number; hp: number; statusMask: number; alive: boolean }>;
  };
  animMs: number;            // how long the viewer's anim takes — used for backpressure
};

type AttackEvent = Base & {
  kind: 'attack';
  actor: ActorRef;           // player | ally | monster
  target: ActorRef;          // monster | player | ally
  hits: Array<{ damage: number; crit: boolean; miss: boolean; hand: 'R' | 'L' }>;
  weaponId: number;          // for slash sprite
  killsTarget: boolean;
};

type MagicEvent = Base & {
  kind: 'magic';
  actor: ActorRef;
  spellId: number;
  targets: Array<{ ref: ActorRef; result: 'hit' | 'miss' | 'absorbed'; dmg?: number; heal?: number; statusAdded?: number; statusRemoved?: number; revives?: boolean; kills?: boolean }>;
  isItemUse: boolean;        // for cast-flame suppression
};

type MonsterAttackEvent = Base & {
  kind: 'monster-attack';
  monsterIdx: number;
  target: ActorRef;
  dmg: number;
  miss: boolean;
  statusAdded: number;
  killsTarget: boolean;
};

type PoisonTickEvent = Base & {
  kind: 'poison-tick';
  ticks: Array<{ ref: ActorRef; dmg: number; kills: boolean }>;
};

type EncounterStartEvent = Base & {
  kind: 'encounter-start';
  monsters: Array<{ monsterId: number; hp: number; maxHP: number; statusMask: number }>;
  combatants: Array<RealizedCombatant>;  // host + every guest, realized stats
  hostUserId: number;
  myUserId: number;          // server tags per-recipient
};

type EncounterEndEvent = Base & {
  kind: 'encounter-end';
  outcome: 'victory' | 'defeat' | 'fled';
  rewards?: { exp: number; gil: number; drops: Array<{ itemId: number; qty: number }> };
};
```

**Self-contained guarantee.** Every event carries `finalState` for every affected actor. Lost packets are recoverable — receiving any event lets the viewer reconcile state without history. `turnIdx` makes ordering explicit; out-of-order packets queue.

**Animation timing in the packet.** `animMs` is the host's animation duration for this event. The viewer plays its own anim for the same duration so the FSMs stay loosely-coupled. Host doesn't wait for the guest to finish animating — host runs at its own pace, guest catches up via the queue.

---

<a id="state"></a>
## Guest state model

The viewer **mutates `battleSt` directly** (cheap — keeps existing render code working) plus owns one new module-level state bag:

```js
// src/coop-viewer.js
const coopViewSt = {
  active:        false,        // true only when (isCoopGuest && COOP_VIEWER_MODE)
  cueQueue:      [],           // ViewEvent[] waiting to play, sorted by turnIdx
  currentAnim:   null,         // { event, elapsedMs, animState } | null
  lastAppliedTurnIdx: 0,       // dedup + ordering
  // ... animation-specific scratch state lives inside currentAnim.animState
};
```

**What the viewer writes to `battleSt`:**

- `battleAllies[i].hp`, `.mp`, `.status.mask`
- `encounterMonsters[i].hp`, `.status.mask`, `.dyingFrame` (for death dissolve)
- `ps.hp`, `.mp`, `.status.mask`
- `battleState` — used by renderer to pick which overlay to draw (slash, magic flame, damage num). Set by `currentAnim.animState` each tick.
- `battleTimer` — same, animation-clock readout for renderer.
- `currentAttacker`, `allyTargetIndex`, `allyHitIsLeft`, etc. — the existing display fields. Viewer writes them based on the active event.

**What the viewer ignores (FSM-only fields):**

- `turnQueue`
- `actionPending` / menu state machine
- `_wireEncounterActions` queue (host owns)
- All `is*` FSM gates (`isWaitingForOpponent`, `isDefending`, `ally-wire-wait` substates)

These get cleared at viewer-enter and never written.

---

<a id="anims"></a>
## Animation registry

Each event kind maps to one anim function. Anims are *short* state machines local to the viewer — typically 3-5 phases each.

```js
const VIEW_ANIMS = {
  'attack':         playAttackAnim,         // slash → damage-num bounce
  'magic':          playMagicAnim,          // cast windup → throw → impact → damage-show → (death?)
  'item':           playItemAnim,           // sparkle → effect → damage-num
  'monster-attack': playMonsterAttackAnim,  // monster step-fwd → shake target → damage-num
  'poison-tick':    playPoisonAnim,         // green flash on each affected, dmg-num per
  'monster-death':  playMonsterDeathAnim,   // dissolve frames
  'player-death':   playPlayerDeathAnim,    // black-fade portrait
  'encounter-end':  playEncounterEndAnim,   // victory fanfare / defeat fade
  'turn-begin':     playTurnBeginAnim,      // optional cosmetic — name flash, menu prompt
  'encounter-start': playEncounterStartAnim, // flash-strobe → reveal monsters
};
```

Each `playXAnim(event, dt, animState)` returns `{ done: bool }`. When done, viewer writes `event.finalState` to `battleSt` and dequeues next.

**Animation primitives are EXTRACTED from existing modules** (not duplicated):

- Slash overlay: `src/slash-effects.js` (already a shared helper)
- Damage-num bounce: `src/damage-numbers.js` (already shared)
- Magic cast windup / throw: `src/spell-anim.js` (per-spell registry, already shared)
- Monster dissolve: `src/battle-update.js#_updateMonsterDeath` — needs extraction into a callable
- Battle msg strip: `src/battle-msg.js` (already a shared helper)
- SFX: `src/sfx.js` (shared)

**Extraction strategy:** Phase 2 lifts the inline animation logic in `battle-update.js` into helpers callable by both the FSM (host path) and the viewer (guest path). Zero behavior change for host.

---

<a id="tick"></a>
## Tick / render integration

The game loop runs in `src/main.js` (or wherever `update(dt)` is called). Current shape:

```js
function update(dt) {
  if (battleSt.battleState !== 'none') updateBattle(dt);
  // ... overworld update
}
```

New shape:

```js
function update(dt) {
  if (battleSt.battleState !== 'none') {
    if (coopViewSt.active) {
      updateCoopView(dt);     // viewer tick — only fires when isCoopGuest && COOP_VIEWER_MODE
    } else {
      updateBattle(dt);        // host or solo — existing FSM
    }
  }
  // ... overworld update
}
```

**Renderer is unchanged.** Reads `battleSt`, `encounterMonsters`, `battleAllies`, `ps`. The viewer writes those.

**One render exception:** the menu UI in the bottom strip. When it's the guest's turn to pick an action, the viewer enters a `waiting-for-input` substate driven by a `turn-begin` event with `actor.userId === myUid`. Existing menu input handler runs unchanged (it doesn't know whether we're host or guest — it just sees `battleState === 'menu-open'` and a target list). Viewer sets `battleState = 'menu-open'` when prompting.

---

<a id="input"></a>
## Input routing

**Guest's outbound action stays on the legacy wire.** When the guest picks Attack / Magic / Item / Defend / Run:

1. Existing input handler → `emitWireEncounterAction(pending)` → `encounter-action` packet to host.
2. Host receives, queues, resolves at its turn.
3. Host emits `attack` / `magic` / `item` view event.
4. Guest's viewer plays the anim for its own action (round-trip latency = ~50-100ms cellular; tolerable).

**No new wire path for guest input.** Just reuse what already works.

**Backpressure:** if the host's `animMs` total falls behind the guest's queue (host running fast, guest playing many anims back-to-back), the guest's queue grows. We cap queue size at 32; overflow drops oldest non-final-state events (rare, but bounded memory). `finalState` carried on every event means lost events still leave the guest at correct HP.

---

<a id="lifecycle"></a>
## Encounter lifecycle (spawn / end)

### Spawn (party random encounter)

**Today:** server emits `encounter-invite` carrying `peers` + monsters. Guest's invite handler builds `battleAllies` from `peers`, sets `battleState = 'flash-strobe'`, FSM takes over.

**Under viewer mode:** server still emits `encounter-invite` (kept for backwards compat). Guest's invite handler now:

1. Marks `coopViewSt.active = true`.
2. Initializes `battleSt.encounterMonsters` from `msg.monsters` (data only — no FSM init).
3. Initializes `battleSt.battleAllies` from `msg.peers` realized stats (NOT from `generateAllyStats` — host ships realized stats inside the first `encounter-start` view event).
4. Sets `battleState = 'flash-strobe'` purely as display state; viewer's `playEncounterStartAnim` handles the flash + monster reveal.

Host emits an `encounter-start` view event right after sending the invite. Guest's viewer consumes it as the first cue, overwriting any stub state from the invite handler. Single source of truth = host.

### End

Host emits `encounter-end` view event. Viewer's `playEncounterEndAnim` runs victory/defeat anim, then writes xp/gil/drops, then transitions `battleState = 'none'`, sets `coopViewSt.active = false`, returns control to overworld.

### Assist mid-battle join

Host emits `encounter-start` view event (full snapshot) to the joiner. Joiner's viewer treats it like a fresh spawn but skips the flash-strobe (since `kind = 'encounter-start'` with `mid-battle: true` flag → cuts directly into the current monster state). Existing `encounter-snapshot` packet is repurposed as this initial event — no new wire path.

---

<a id="promotion"></a>
## Host promotion under viewer mode

When the host disconnects (v1.7.476 host promotion logic stays), the surviving peer that becomes new host needs to **transition from viewer to FSM**.

**Steps on the new host:**

1. `setNetEncounterHostChangedHandler` fires with `newHostUserId === myUid`.
2. Set `coopViewSt.active = false`, `encounterIsHost = true`.
3. Copy viewer's last `finalState` into the FSM's data fields. `battleSt.battleAllies`, `encounterMonsters`, `ps` are already populated (viewer writes them).
4. Set `battleState = 'menu-open'` so the FSM picks up at a clean turn boundary.
5. Build `turnQueue` from current battleAllies + encounterMonsters via `_buildTurnOrder()`.
6. FSM resumes ticking normally.

**Catch:** the new host has no `_wireEncounterActions` from prior turns — fine, those were consumed by the old host. Future turns get fresh `encounter-action` from remaining guests.

**Catch 2:** the new host's `_turnIdx` in `coop-resolver.js` starts at 0. Other guests have already applied turnIdx=N from old host. **Fix:** new host initializes their resolver's turnIdx to `coopViewSt.lastAppliedTurnIdx + 1` so emitted packets land monotonically. Other guests' `_lastAppliedTurnIdx` is up to date, so they apply normally.

**Catch 3:** the new host's view of monster `currentAttacker` / `currentAttackTarget` is stale (was set by viewer for animation, not for FSM dispatch). FSM clears these at next turn dispatch. Acceptable.

---

<a id="compat"></a>
## Backwards compatibility & migration

**Flag:** `COOP_VIEWER_MODE` in `src/coop-resolver.js`, default `false`. Implies `COOP_HOST_ARB`. Three states:

| `COOP_VIEWER_MODE` | `COOP_HOST_ARB` | Behavior |
|---|---|---|
| `false` | `false` | Legacy lockstep (current prod after v1.7.477 revert; co-op broken in the v1.7.472 way) |
| `false` | `true` | Host-arb only (the v1.7.474–v1.7.476 mode that surfaced live bugs; NOT recommended) |
| `true` | implied true | Viewer mode (target end state) |

**Migration:**

1. Ship Phases 1-8 with flag default `false`. Live behavior unchanged.
2. Internal smoke: flip flag locally, run two-tab tests, verify.
3. Two-phone smoke on real devices.
4. Flip flag to `true` in prod via deploy.
5. After 48h clean, Phase 11 cleanup: rip the legacy guest FSM short-circuits (`isCoopGuest()` checks become dead code since FSM no longer ticks for guests).

**Old clients:** clients that don't know `encounter-resolution`'s extended shape will silently ignore unknown fields (JSON over WS — extra keys are harmless). They still receive legacy `encounter-action` + `encounter-end` from host (host emits both during migration window). Eventually we strip the legacy emit in Phase 12.

---

<a id="phases"></a>
## Phasing

Each phase is one PR / one deploy. Flag stays off until Phase 9.

| Phase | Scope | Risk | Effort |
|---|---|---|---|
| **P1** — Protocol & flag | Define ViewEvent types in `src/coop-deltas.js`. Add `COOP_VIEWER_MODE` flag. Extend `encounter-resolution` to carry `eventKind` + `animMs` + `finalState`. Host emits new shape under flag-off too (additive — no clients consume it yet). | Low | 0.5d |
| **P2** — Anim primitive extraction | Lift `_updateMonsterDeath`, ally-attack chains, magic cast/throw/impact, poison flash from `battle-update.js` / `battle-ally.js` into pure helpers callable by FSM AND viewer. Host FSM continues calling them in-place (zero behavior change). | Medium — touches battle code | 1.5d |
| **P3** — Viewer skeleton | New `src/coop-viewer.js` with state, tick, animation registry, applyEvent. Animations call P2 helpers. Tick is dead code (flag off). Unit tests via `tools/coop-viewer-sim.js` (new). | Low | 1.5d |
| **P4** — Main-loop hook | Wire `updateCoopView(dt)` into the game loop under the flag. Still no FSM activations under flag-off. | Low | 0.5d |
| **P5** — Host emit extensions | Extend `coop-resolver.js` to emit the full ViewEvent set (turn-begin, magic, item, poison-tick, monster-death, encounter-start, encounter-end with rewards). `animMs` calibration per event. | Medium — many call sites | 1d |
| **P6** — Encounter lifecycle | Guest's `encounter-invite` handler enters viewer mode when flag-on. `encounter-end` event triggers viewer's exit anim → overworld return. | Low | 0.5d |
| **P7** — Host promotion handoff | New host transitions viewer → FSM cleanly: copy state, init turnIdx, set menu-open. | Medium | 0.5d |
| **P8** — Coverage harness | Extend `tools/coop-arbiter-sim.js` with Suite 4: viewer convergence — drive two simulated phones (one as host running FSM, one as viewer) through 20+ scenarios. Add `tools/coop-viewer-sim.js` for animation-frame-accurate tests. | Medium | 1.5d |
| **P9** — Flag flip + smoke | Flip `COOP_VIEWER_MODE = true`. Deploy. Two-phone smoke. | Low (flag) / High (live) | 1d for live testing |
| **P10** — Live observation | 48h observation. Watch pm2 logs for `coop-viewer` errors. Fix any surfaced issues. | High | 2d wall-clock |
| **P11** — Legacy cleanup | Rip `isCoopGuest()` short-circuits (dead under viewer mode). Strip the legacy `encounter-action` queue drain on guests. | Low (cleanup only) | 1d |
| **P12** — Backwards-compat sunset | Stop emitting legacy `encounter-action` from host. Stop emitting legacy `encounter-end`. Old clients still see legacy `encounter-resolution` (now the only path). | Low | 0.5d |

**Total:** ~12 working days + 2-3 days of live smoke + iteration. Realistic timeline: 3 weeks elapsed including bug fixes.

---

<a id="files"></a>
## File touchpoints

### NEW

| File | Purpose |
|---|---|
| `src/coop-viewer.js` | Viewer state, tick, applyEvent, anim registry. ~500 LOC. |
| `src/coop-view-anims.js` | Animation primitives shared with FSM. Extracted from battle-update / battle-ally / spell-cast. ~300 LOC. |
| `tools/coop-viewer-sim.js` | Frame-accurate viewer regression harness. ~400 LOC. |
| `docs/COOP-VIEWER-PLAN.md` | This document. |
| `docs/COOP-VIEWER-SMOKE.md` | Two-phone live smoke checklist (P9 gate). |

### MODIFIED

| File | Change |
|---|---|
| `src/coop-resolver.js` | Add `COOP_VIEWER_MODE` flag. Extend every `resolve*` to emit ViewEvent shape. Bump turnIdx semantics. |
| `src/coop-deltas.js` | Add `buildViewEvent*` builders, one per kind. |
| `src/coop-applier.js` | Becomes thin shim — under viewer mode, hands packets to `coop-viewer`. Legacy delta application stays for `COOP_HOST_ARB && !COOP_VIEWER_MODE` (transition mode). |
| `src/battle-update.js` | Extract anim primitives to `coop-view-anims.js`. Add `if (coopViewSt.active) return;` at top of `updateBattle`. |
| `src/battle-ally.js` | Same — extract + early-return. |
| `src/battle-encounter.js` | `encounter-invite` handler branches: viewer mode skips FSM init. |
| `src/encounter-wire.js` | Host promotion handler transitions viewer → FSM on new-host election. |
| `src/main.js` (or main-loop) | Branch update + render between FSM and viewer paths. |
| `src/net.js` | Already wired for `encounter-resolution`; verify shape extension passes through. |
| `ws-presence.js` | No change — server is a relay. |
| `deploy.sh` | Add `node tools/coop-viewer-sim.js` as a pre-flight gate. |
| `CHANGELOG.md` | Per-phase entry. |
| `MULTIPLAYER.md` | Update co-op section to viewer model. |

---

<a id="risks"></a>
## Risk register

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Animation timing drift** — host's anim takes 800ms, guest plays it in 750ms; over 50 turns the queue compounds. | `animMs` ships in the packet. Viewer scales its anim to match host's clock. Buffer overflow drops oldest non-final events; finalState carried on every event means HP stays correct. |
| 2 | **Input lag perceived** — guest picks Attack, waits 100ms for host's resolution, then sees their own slash. | Show a "queuing your turn..." indicator immediately on input. The actual slash anim feels normal once it lands. Cellular RTT is the floor; can't beat physics. |
| 3 | **Packet loss / out-of-order** | `turnIdx` strict-increase or queue. Sequence gaps trigger an `encounter-snapshot` resync request (new wire kind: `coop-viewer-resync` → host re-sends full snapshot). |
| 4 | **Animation extraction breaks host FSM** — refactoring `_updateMonsterDeath` etc. could regress solo / boss / PvP. | Extract behind a wrapper that the FSM calls unchanged. Run `tools/battle-sim.js` (statistical mode) before/after to verify zero distribution drift on duels. |
| 5 | **Host promotion at non-turn-boundary** — new host inherits viewer state mid-animation. | Promotion logic FINISHES the current viewer anim before flipping to FSM. ~500ms worst case before menu-open. Cosmetic delay only. |
| 6 | **Backwards-compat clients receive new packet shape and crash** | New fields are additive. Tested: old client ignores unknown JSON keys. Phase 12 sunset only after Phase 11 has shipped + cached old clients have refreshed (>1 week). |
| 7 | **Cheat surface** — guest sends encounter-action, host trusts. | Same as today — host validates target index + action shape. Out of scope for v1 anti-cheat. |
| 8 | **Damage number flicker** — viewer writes finalState AFTER anim, briefly out-of-sync from on-screen number. | Anims write to display fields (damage-num overlay) during the anim, then write `actor.hp` exactly when the anim's damage-show phase finishes. Same beat as the FSM today. |
| 9 | **Multi-phase event interruption** — a magic event has cast → throw → impact phases. Mid-event, an `encounter-end` arrives (peer fled, encounter aborted). | Viewer's current anim is canceled; finalState of the in-flight event is applied immediately so HP doesn't lag; encounter-end anim begins. |
| 10 | **PvP regression** — viewer code accidentally runs during PvP battles. | Viewer gates on `battleSt.isWireEncounter && !pvpSt.isPVPBattle && coopViewSt.active`. PvP path never sets `coopViewSt.active = true`. |

---

<a id="accept"></a>
## Acceptance criteria

Per phase:

**P1** — Lint 0. pvp-wire-sim 49/49. coop-wire-sim 9/9. coop-arbiter-sim 59+5. ViewEvent types defined; flag declared.

**P2** — Same gates. PLUS: `tools/battle-sim.js --runs=500 --seed=42` produces identical HP distributions before/after extraction (no math drift).

**P3** — Same gates + `tools/coop-viewer-sim.js` skeleton runs with at least 1 test (init state) green.

**P4** — Same gates + viewer tick runs in main loop under flag (verified by adding a `console.log` behind the flag, removed before commit).

**P5** — Same gates + `tools/coop-viewer-sim.js` has ≥15 tests covering every ViewEvent kind, all green.

**P6** — Same gates + `tools/coop-viewer-sim.js` has encounter-start → 3 turns → encounter-end scenario, green.

**P7** — Same gates + a wire-sim test for host-disconnect promotion under viewer mode (new host's viewer tears down, FSM resumes at menu-open).

**P8** — coop-viewer-sim 30+ tests covering all event kinds + edge cases (out-of-order, dup, lost packet, promotion mid-anim).

**P9** — All P8 gates + live two-phone smoke: 5 rounds of co-op, HP matches, animations look smooth, no FSM freeze, no console errors.

**P10** — 48h of prod traffic with `COOP_VIEWER_MODE=true`. No pm2 error spikes. No user reports of freezes / wrong HP / missing roster.

**P11** — Same gates + grep verifies all `isCoopGuest()` short-circuits removed except the resolver gate.

**P12** — Same gates + legacy emit removed; old cached clients tested in private window to confirm they still receive a valid event stream (they get the new shape, which they parse as "extra unknown fields" + still works).

---

<a id="oq"></a>
## Open questions

1. **Should `COOP_VIEWER_MODE` imply `COOP_HOST_ARB` automatically, or be checked independently?** Recommendation: implicit (`COOP_VIEWER_MODE = true` forces host to emit ViewEvents regardless of `COOP_HOST_ARB`). Simplifies the matrix.

2. **`animMs` calibration — how does the host know how long its own anims will take?** Each anim has a known duration (slash = 320ms, magic cast = 800ms, etc.). These are constants in `slash-effects.js` / `spell-anim.js`. Resolver reads them.

3. **Status anim — sleep zZ, poison green, etc.** — these are passive overlays driven by `actor.status.mask`. No event needed. Viewer just writes the mask and the renderer handles overlay. Confirmed.

4. **What about runtime errors in the viewer (e.g., unknown spellId)?** Viewer falls back to a generic "impact" anim with the dmg number. Logs `[coop-viewer] unknown spell N` to console + pm2 via the existing `/api/client-error` POST. Never crashes the battle.

5. **Three-phone scenarios** — viewer mode is N-aware (host emits to N-1 guests). No special handling needed. P9 smoke should include a 3-phone test if available.

6. **Should we kill the legacy `encounter-action` wire entirely under viewer mode?** No — guests still emit `encounter-action` to ship their input to the host. We only kill the *inbound* `encounter-action` consumption on guests (no more `_wireEncounterActions` queue drain). The outbound path stays.

7. **Solo encounters** — viewer never activates. `coopViewSt.active = false` always when `isWireEncounter = false`. Confirmed safe.

---

<a id="estimate"></a>
## Effort estimate

| Phase | Days |
|---|---|
| P1 (protocol + flag) | 0.5 |
| P2 (anim extraction) | 1.5 |
| P3 (viewer skeleton) | 1.5 |
| P4 (main-loop hook) | 0.5 |
| P5 (host emit) | 1.0 |
| P6 (lifecycle) | 0.5 |
| P7 (promotion) | 0.5 |
| P8 (harness) | 1.5 |
| P9 (smoke) | 1.0 |
| P10 (observation, 48h) | 2.0 wall |
| P11 (cleanup) | 1.0 |
| P12 (sunset) | 0.5 |
| **Total code** | **10.0 days** |
| **Total wall** | **~3 weeks** with live testing windows |

---

## Build vs. fix tradeoff

**Why this is the right call instead of patching host-arb:**

- Host-arb's three live failures (freeze, wrong HP, missing roster) all stem from the same root cause: a guest-side FSM that can't be reliably kept in sync with the host's. Patching is whack-a-mole.
- The viewer eliminates the class. Not "fix this freeze" but "make freezes structurally impossible."
- The reused 80% (resolver, deltas, snapshot, wire) is the hard part of multiplayer code. The viewer is the EASY part — it's just an animation player.
- This unlocks future features cleanly: replay (record event stream), spectator mode (subscribe to encounter event stream as a non-participant), variable-speed playback, instant-text mode.

**Why this is NOT premature:**

- We have lived evidence the lockstep / dual-FSM model doesn't work (fifteen v1.7.458–v1.7.472 attempts + the live failure of v1.7.474–v1.7.476).
- The card-game architecture is the standard MMO turn-based model (FF11, FF14 with limit breaks, etc.). Battles are server-resolved, clients are viewers. Not a novel design.
