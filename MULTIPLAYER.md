# Multiplayer

**Live as of v1.7.472. Co-op party-encounter sync was BROKEN under the deterministic-lockstep model. The host-authoritative rewrite is shipped behind `COOP_HOST_ARB` (default `false`) — live cutover is pending two-phone smoke; until the flag flips, prod still runs the broken lockstep path.** PvP duels, presence, chat, party invites, give-item, roster low-HP pose are all working. Solo + boss combat unaffected. **Read `docs/COOP-REWRITE-PLAN.md` for the host-arb model spec and `docs/COOP-PHASE-6-SMOKE.md` for the flag-flip + smoke checklist.**

Open `ff3mmo.com` in two browsers with two accounts. Same location → see each other in the roster panel. Chat, party invites, PvP duels, low-HP roster pose, give-item-to-roster, party co-op random encounters, and Battle Assist (any roster player can join an in-progress fight) all wire-driven. Combat is **FF3-style round-based** — the FF4 ATB system that shipped in v1.7.428-v1.7.455 was reverted in v1.7.456 (didn't feel right); all `atb-sync` / `atb-ready` / `pvp-atb-sync` wire kinds + the server-side `_encounterBattles` tick loop are gone. Fakes are off (`PLAYER_POOL` exported empty in `src/data/players.js`).

This doc is the architecture overview + recovery cheatsheet. For the per-deploy changelog of how it got built, see `CHANGELOG.md` 1.7.366 → 1.7.443.

## Architecture

```
                                  ┌──────────────────┐
   browser A  ◄── WSS /api/ws ───►│  ws-presence.js  │◄── WSS /api/ws ──►  browser B
   src/net.js                     │   (Node, ws)     │                     src/net.js
                                  └──────────────────┘
                                      relay only
                                  (no game-math)
```

**Server (`ws-presence.js`)** — mounted on the existing HTTP server via the `upgrade` event. Auth on connect via JWT (query param `?token=…`, same token as `api.js`). All game-math runs on the clients; server only relays + arbitrates a few small decisions (PvP hook chance, party-membership uniqueness).

In-memory state on the server:

| Map | Purpose |
|---|---|
| `_connected` | userId → `{ws, profile, loc, helloed}` |
| `_pvpSearches` | challengerUserId → `{targetUserId}` (pending Battle searches) |
| `_pvpPartners` | userId → partnerUserId (active 1v1 battle pairs) |
| `_partyInvites` | challengerUserId → targetUserId (pending Party invites) |
| `_partyMemberships` | memberUserId → inviterUserId (active party memberships) |
| `_encounterGroups` | userId → Set\<peerUserId\> (active co-op random-encounter groups; bidirectional) |

All state is in-memory. Restart drops it; clients reconnect on next page load.

**Client (`src/net.js`)** — opens WS after `init()`, sends `hello` with the local profile when the save slot is loaded. Polls every 500 ms for location + ally-roster + main-player-profile changes, emits `update` on diff. Auto-reconnects with exponential backoff (1 s → 30 s cap).

## Wire protocol

Messages are JSON over text frames. `actor` / `target` are sender's-perspective with idx 0 = main player, 1+ = ally cell.

### Presence (Step 1)

| Direction | Type | Fields |
|---|---|---|
| C→S | `hello` | `profile, loc` |
| C→S | `location` | `loc` |
| C→S | `update` | partial profile fields (incl. `allies`) |
| S→C | `ready` | `userId` |
| S→C | `snapshot` | `players: [{userId, …profile, loc}]` |
| S→C | `player-join` | `player` |
| S→C | `player-leave` | `userId` |
| S→C | `player-move` | `userId, loc` |
| S→C | `player-update` | `userId, fields` |

### Chat (Step 2)

| Direction | Type | Fields |
|---|---|---|
| C→S | `chat` | `channel ('world'|'party'|'pm'), text, to?, toUserId?` |
| S→C | `chat` | `userId, name, channel, text, to?` |

- **`world`** = location-scoped (only same-loc clients receive).
- **`party`** = membership-scoped via the server's `_partyMemberships` map (inviter + their members). Does **not** leak to other parties or to bystanders at the same location. (v1.7.388 — was location-scoped pre-fix.)
- **`pm`** = userId-targeted when the client sends `toUserId`; falls back to first-match-by-name when only `to` is set. The name path stops at the first match so a player can't intercept PMs by renaming to "Joel" anymore. (v1.7.388.)

### PvP search (Step 3)

| Direction | Type | Fields |
|---|---|---|
| C→S | `pvp-search` | `targetUserId` |
| C→S | `pvp-cancel` | — |
| C→S | `pvp-encounter` | — (target's client signals an imminent random encounter) |
| S→C | `pvp-search-failed` | `reason ('offline'|'different-location'|'target-left'|'target-engaged')` |
| S→C | `pvp-encounter-none` | — (no challenger hooked; proceed with monster fight) |
| S→C | `pvp-match` | `opponent: {userId, …profile}, seed` |

Hook chance = `clamp(0.25 + (chAGI − tgtAGI) × 0.015 + jobBonus, 0.10, 0.75)` with Thief +0.15 / Ranger +0.08 — same formula as `pvp-search.js#getHookChance`, mirrored on the server.

### PvP combat (Step 4)

| Direction | Type | Fields |
|---|---|---|
| C→S | `pvp-action` | `kind ('attack'|'defend'|'magic'|'item'|'run'), actor: {idx}, target?: {side, idx}, spellId?, itemId?, damageRoll?, healAmount?, hitResults?` |
| C→S | `pvp-end` | — (clears partner pair) |
| C→S | `pvp-result` | `outcome ('won'|'lost'|'fled')` |
| C→S | `pvp-ally-join` | `profile: { name, jobIdx, level, palIdx, loc, weapon*, armor*, knownSpells, jobLevel }` |
| S→C | `pvp-action` | relayed in full (incl. `actor`/`damageRoll`/`healAmount`/`hitResults`); synthesizes `{kind:'disconnect'}` when partner WS drops or `pvp-result` mismatch is detected (audit #14) |
| S→C | `pvp-ally-join` | relayed; receiver runs its own `generateAllyStats(profile)` for the mirror cell |

Each player's chosen action drives the opponent's turn on the partner's client. Seed sync (broadcast in `pvp-match`) means all rolls inside `battle-math.js` (initiative, damage variance, hit/miss, crit, evade) AND `status-effects.js` (status infliction, sleep-wake, confuse snap-out) land on the same value on both sides. Outcome reports get compared server-side; mismatch logs `[pvp-result mismatch]` AND ends both sides with a synthetic disconnect rather than letting one side hang (audit #14).

**Three-layer cursor-drift defense (v1.7.407-v1.7.410):**

1. **Authoritative pre-rolled values ride the wire.** `damageRoll` / `healAmount` (magic, audit #24) and `hitResults` (physical attacks, v1.7.407) are sent in the wire payload. Receiver uses them directly instead of re-rolling on a drifted `rand()` cursor. Each side pre-rolls before `_emitWirePVPAction`, so the same numbers land on both clients.
2. **Per-turn rand resync.** At every turn boundary, `_buildAndProcessNextTurn` calls `seedRng(_wireSeed + _wireTurnIndex)`. Both clients independently arrive at the same rand state for the next round's `rollInitiative` and any non-wire-bypassed roll (status infliction, sleep-wake, etc.).
3. **Canonical actor-push order.** `buildTurnOrder` swaps the `ps ↔ opp` push order on the higher-userId client so both clients call `rollInitiative` for the lower-userId actor first — same cursor + same actor mapping → same priorities → same turn order.

**Preflash timer reset (v1.7.410):** when the receiver pops a wire `pvp-action`, `battleSt.battleTimer` is reset to 0 so the `BOSS_PREFLASH_MS` back-swing window starts from wire-arrival, not from FSM entry into `enemy-flash`. Without this, a cellular WS round-trip (~150 ms) would push the timer past the 133 ms preflash gate before the action was even received, and the opponent's back-swing pose would skip entirely.

### Roster co-op (Step 5)

| Direction | Type | Fields |
|---|---|---|
| C→S | `give-item` | `targetUserId, itemId` — used a heal / cure consumable from the pause menu on a real-player roster row |
| S→C | `give-item` | relayed with `fromUserId` + `fromName` attached |

Receiver (`pause-menu.js#setNetGiveItemHandler`) mirrors the sender's `_applyPauseItemUse` apply path on its own `ps` — `applyMagicHeal` for `effect: heal / full_heal / restore_hp`, `applyMagicCureStatus` for `effect: cure_status`. Plays `SFX.CURE`, fires the existing `_drawCureSparkle` overlay on the receiver's HUD portrait via `hudSt.giveItemHealTimer` (550 ms window matching the sender's pause-menu `inv-heal` state), and posts `* <sender> sent you <item>` to chat. The next 500 ms profile-diff poll auto-broadcasts the new HP / status so every other player's roster row ticks too — the kneel-pose pipeline in `roster.js` (v1.7.415) reads `p.hp` / `p.maxHP` from the snapshot entry and swaps `fakePlayerPortraits` for `fakePlayerKneelPortraits` + sweat overlay when `hp <= floor(maxHP / 4)`.

### Party co-op random encounters — viewer (card-game) model (current)

**Active model** behind `COOP_VIEWER_MODE` in `src/coop-resolver.js`. Spec: `docs/COOP-VIEWER-PLAN.md`. Supersedes both the v1.7.458-72 lockstep model AND the v1.7.474-77 host-arb-only attempt that broke live (both documented below as historical).

**Core principle — card game, not lockstep.** The encounter host runs the battle FSM unchanged. Guests **do not run a battle FSM at all**. Each guest's `updateCoopView(dt)` (replacing `updateBattle(dt)` in the game loop) is a packet-driven animation player consuming `ViewEvent` packets carrying self-contained `finalState` snapshots. There is exactly ONE FSM per encounter, on the host. Two-FSM lockstep is structurally impossible.

**Module layout:**

- `src/coop-viewer.js` — guest-side. `coopViewSt` (queue, currentAnim, lastAppliedTurnIdx), `enterViewerMode()`, `exitViewerMode()`, `leaveViewerForPromotion()`, `ingestViewEventPacket(packet)`, `updateCoopView(dt)`. Anim registry maps eventKind → handler.
- `src/coop-view-anims.js` — re-exports shared low-level primitives (slash, damage-num, spell-anim, SFX, monster-death timing) the viewer's anim handlers consume directly.
- `src/coop-deltas.js` — ViewEvent builders: `buildAttackViewEvent`, `buildMagicViewEvent`, `buildItemViewEvent`, `buildMonsterAttackViewEvent`, `buildPoisonTickViewEvent`, `buildMonsterDeathViewEvent`, `buildPlayerDeathViewEvent`, `buildEncounterStartViewEvent`, `buildEncounterEndViewEvent`, `buildTurnBeginViewEvent`. Plus `buildFinalState`, `wrapViewEventForWire`, `VIEW_ANIM_MS`.
- `src/coop-resolver.js` — host-side. Existing `resolve*` (PhysicalAttack/MonsterAttack/SpellCast/ItemUse/PoisonTick/EncounterEnd) attach a ViewEvent to each emitted packet via `_emitWithViewEvent`. New entries: `resolveMonsterDeath`, `resolvePlayerDeath`, `resolveTurnBegin`, `resolveEncounterStart`. Helpers: `_resolveLocalActor`, `_buildAutoFinalState`, `setResolverTurnIdx`. Owns flags: `COOP_HOST_ARB` (legacy kill-switch), `COOP_VIEWER_MODE` (viewer enable), `COOP_VIEWER_DEBUG` (instrumentation).
- `src/coop-applier.js` — under `COOP_VIEWER_MODE && coopViewSt.active && msg.viewEvent`, routes incoming `encounter-resolution` to `coopViewer.ingestViewEventPacket`. Falls back to legacy host-arb deltas otherwise.

**Wire shape — additive on the existing `encounter-resolution`:**

```
encounter-resolution (host → all guests):
  {
    turnIdx,              // monotonic per encounter
    actor, action,        // legacy host-arb passthrough (backwards-compat)
    deltas, fx, meta,
    viewEvent: {          // ViewEvent payload — viewer reads only this
      eventKind,          // 'attack' | 'magic' | 'item' | 'monster-attack' | ...
      turnIdx,            // mirror for downstream
      animMs,             // viewer anim duration (calibrated to host FSM)
      finalState: {       // authoritative post-anim actor + monster state
        actors:   [{ ref, hp, mp, statusMask, alive }, ...],
        monsters: [{ idx, hp, statusMask, alive }, ...],
      },
      // kind-specific: actor, target, hits, dmg, etc.
    }
  }
```

Every event is self-contained — `finalState` lets the viewer reconcile to authoritative state on every event, so lost packets don't corrupt state.

**Host-emit call sites (host's FSM unchanged; each existing resolve\* attaches a ViewEvent):**

| File | Site | ViewEvent kind |
|---|---|---|
| `src/battle-enemy.js#_processEnemyTurn` | both ps + ally branches | `monster-attack` |
| `src/battle-update.js#_finalizeComboHits` | player physical combo | `attack` |
| `src/battle-ally.js#_finalizeAllyCombo` | wire-driven ally combo | `attack` |
| `src/spell-cast.js#_finishMagicHit` | player spell impact | `magic` |
| `src/battle-ally.js#_applyAllyMagicEffect` | ally spell impact | `magic` |
| `src/battle-turn.js#_playerTurnConsumable` | item use | `item` |
| `src/battle-turn.js#_applyEndOfRoundPoison` | poison batch | `poison-tick` |
| `src/encounter-wire.js#endWireEncounter` | battle wrap-up | `encounter-end` |
| `src/battle-encounter.js#_maybeHostCoopEncounter` | encounter spawn | `encounter-start` (P6) |
| `src/battle-encounter.js#_processAssistIncoming` | mid-battle joiner | (legacy snapshot + `encounter-snapshot` ViewEvent) |

**Guest's input path is unchanged.** Picking Attack/Magic/etc. emits a normal `encounter-action` to the host. Host's FSM consumes it, resolves the turn, ships back a ViewEvent. Viewer plays the anim. Single round-trip.

**Encounter lifecycle (viewer mode):**

1. Host walks into encounter → `_maybeHostCoopEncounter` runs → server sends `encounter-invite` to guests + host emits `encounter-start` ViewEvent
2. Guest's invite handler: legacy spawn via `generateAllyStats` (fills sprite/portrait/weapon canvases) + `enterViewerMode()` (sets `coopViewSt.active = true`)
3. Guest receives `encounter-start` ViewEvent → `_animEncounterStart` updates `battleAllies` IN PLACE with realized stats (does NOT wipe; preserves `fadeStep` + canvases the renderer needs) → parks `battleState = 'menu-open'` after flash anim
4. Host emits turn events; viewer plays each
5. `encounter-end` ViewEvent → `_animEncounterEnd` transitions to `victory-name-out` / `encounter-box-close` → `exitViewerMode()` → legacy `updateBattle` resumes for wrap-up

**Host promotion (v1.7.476 + P7 viewer handoff).** When the host disconnects, server picks first surviving peer + broadcasts `encounter-host-changed { droppedUserId, newHostUserId }`. The new host's handler in `encounter-wire.js`:
- `leaveViewerForPromotion()` — tears down `coopViewSt`, returns last `lastAppliedTurnIdx`
- `setResolverTurnIdx(lastIdx)` — initializes resolver's monotonic counter so next emit lands monotonically for remaining guests
- `battleState = 'menu-open'` — FSM resumes at a clean turn boundary

The new host's `battleAllies` + `encounterMonsters` were already mutated by the viewer to reflect host's last-known state, so the FSM has the data it needs.

**Diagnostic instrumentation (`COOP_VIEWER_DEBUG = true`).** Every viewer state-change boundary fires a structured `[coop-viewer]` log via `POST /api/client-error`. Tags: `enterViewerMode-called` / `-done`, `exitViewerMode-called`, `ingest-rejected` (reason), `ingest-ok`, `ingest-dup-drop`, `anim-begin`, `anim-done`, `anim-handler-threw`, `updateCoopView-first-tick`. Host side: `invite-received`, `host-emit-start`, `host-emit-start-rejected`. Wire receive: `wire-resolution-received` (turnIdx, eventKind, hasViewEvent, msg keys). Each carries a context block with myUid, active, queueLen, lastApplied, currentKind, battleState, battleTimer, isWireEncounter, encounterIsHost, battleAlliesLen, monstersLen. To grep:

```
ssh root@68.183.59.19 'tail -300 /root/.pm2/logs/server-error.log | grep coop-viewer'
```

**Killed failure modes vs lockstep / host-arb-only:**

1. The v1.7.472 monster-attack divergence (`targetAlly` branches with different stat fields). Guest never runs ANY combat code under viewer mode.
2. The v1.7.486 server-dropping-viewEvent on relay → guest freezes waiting forever. Now: wire-sim test `encounter-resolution relay preserves viewEvent payload` is a gate.
3. The v1.7.488 flash-strobe freeze (viewer not advancing `battleTimer`, not parking `battleState`). Now: viewer-sim test `v1.7.488 — battleTimer advances during flash-strobe anim` + `encounter-start parks battleState=menu-open after anim`.
4. The v1.7.490 `drawAllyPortrait` throw (viewer wiping `battleAllies` instead of updating in place). Now: viewer-sim test `v1.7.490 — encounter-start updates battleAllies IN PLACE, preserves fadeStep`.
5. The v1.7.491 host emit reading `atk`/`def`/`agi` from wrong source (`ps.stats` vs `ps`). Fixed; guests now get realized values.

**Regression gates (`deploy.sh`):**
- `tools/coop-viewer-sim.js` — 30 tests (queue, anim dispatch, encounter lifecycle, promotion, wire envelope, finalState writer, regression suite)
- `tools/coop-wire-sim.js` — 10 tests (delivery + viewEvent passthrough)
- `tools/coop-arbiter-sim.js` — 59 + 5 (host-arb resolver/applier convergence)
- `tools/pvp-wire-sim.js` — 49 (PvP, untouched)

**Hot-revert procedure.** Flip `COOP_VIEWER_MODE = false` in `src/coop-resolver.js`, deploy. The flag-off path is the v1.7.477 lockstep baseline (broken in the known v1.7.472 way, not the new way). All viewer code stays compiled, dormant.

### Party co-op random encounters — host-authoritative model (HISTORICAL)

Predecessor of the viewer model above. Shipped at v1.7.474, broke live (phone freezes, wrong HP, missing roster), reverted at v1.7.477. The resolver/deltas/wire plumbing is REUSED by the viewer model — only the guest-side behavior was wrong. Documented here in past tense.

**Core principle (defunct).** Host resolves locally and ships `{deltas, fx}` packets. Guest applies deltas + drives animation from fx cues. **Two FSMs running concurrently** — guest still ran its battle FSM, with `isCoopGuest()` short-circuits at HP-mutation call sites. Phone freezes occurred when guest's FSM expected legacy `encounter-action` queue drains at FSM phases that no longer corresponded to host's emit timing.

**Module layout:**

- `src/coop-resolver.js` — host-side. `resolvePhysicalAttack` / `resolveMonsterAttack` / `resolveSpellCast` / `resolveItemUse` / `resolvePoisonTick` / `resolveEncounterEnd` / `resolveEncounterJoin`. Each captures the host's locally-applied outcome + emits a resolution packet. Also owns `COOP_HOST_ARB` (the kill-switch flag) and `isCoopGuest()` (single source for the guest-skip gate).
- `src/coop-applier.js` — guest-side. Installs `encounter-resolution` + `encounter-snapshot` handlers at module load. `_apply()` walks `msg.deltas` (HP / status mutations) + `msg.fx` (animation cues). `_dispatchDamageNum` / `_dispatchDeath` route fx cues to the existing damage-number / death-anim helpers.
- `src/coop-deltas.js` — pure, Node-clean. Packet builders (`buildPhysicalAttackPacket` / `buildMonsterAttackPacket` / `buildMagicPacket` / `buildItemUsePacket` / `buildPoisonTickPacket` / `buildEncounterEndPacket` / `buildEncounterSnapshot`) + `applyDeltaToActor`. Used by both production AND the arbiter sim (`tools/coop-arbiter-sim.js`) so convergence tests exercise the actual production logic.

**Wire shape:**

| Direction | Type | Fields |
|---|---|---|
| C→S | `encounter-resolution` | `{turnIdx, actor, action, deltas: [<Delta>], fx: [<FXCue>], meta}` — host's authoritative turn outcome |
| S→C | `encounter-resolution` | relayed to every peer in `_encounterGroups[hostUid]` with `userId: <host>` attached |
| C→S | `encounter-snapshot` | `{joinerUserId, turnIdx, battleState, monsters, combatants}` — host → specific joiner only, mid-battle assist join with realized stats |
| S→C | `encounter-snapshot` | relayed to the targeted joiner with `hostUserId` attached |

`Delta`: `{target: <ActorRef>, hp?, mp?, status?: {add, remove}, poisonDmgTick?, death?}`. `FXCue`: `{kind: 'slash'|'magic-cast'|'magic-impact'|'item-use'|'item-impact'|'damage-num'|'death'|'poison-tick-start', ...}`. Full schemas: `docs/COOP-REWRITE-PLAN.md#wire-contract`.

**Host-emit call sites (production wiring):**

| File | Site | Resolution |
|---|---|---|
| `src/battle-enemy.js#_processEnemyTurn` | both ps + ally damage branches | `resolveMonsterAttack` |
| `src/battle-update.js#_finalizeComboHits` | player physical combo end | `resolvePhysicalAttack` |
| `src/battle-ally.js#_finalizeAllyCombo` | wire-driven ally combo end | `resolvePhysicalAttack` (host running peer's relayed action) |
| `src/spell-cast.js#_finishMagicHit` | player spell apply | `resolveSpellCast` (snapshot+diff over `_targets`) |
| `src/battle-ally.js#_applyAllyMagicEffect` | ally spell apply | `resolveSpellCast` (single-target snapshot+diff) |
| `src/battle-turn.js#_playerTurnConsumable` | item use | `resolveItemUse` |
| `src/battle-turn.js#_applyEndOfRoundPoison` | poison batch | `resolvePoisonTick` |
| `src/encounter-wire.js#endWireEncounter` | battle wrap-up | `resolveEncounterEnd` |
| `src/battle-encounter.js#_processAssistIncoming` | mid-battle joiner | `resolveEncounterJoin` (realized stats) |

**Guest-side short-circuits (Phase 6.7).** At every call site that legacy code uses to mutate HP / status, a single `isCoopGuest()` gate skips the local apply. Animation callbacks still fire so visuals read correctly; the resolution packet drives authoritative state via the applier. Sites: `applyPhysicalHitToEnemy`, `_processEnemyTurn` damage applies, every `applyMagic*` helper in `combatant-cast.js`, `_playerTurnConsumable` cure-status + Elixir paths, `_applyEndOfRoundPoison` per-actor applies.

**Snapshot+diff pattern (Phase 6.5 spell wiring).** Rather than instrument every internal apply path (`applyMagicDamage`, `applyMagicHeal`, ...) to write to a host-arb accumulator, the spell-cast resolver snapshots `{hp, mp, mask}` for each target BEFORE `applySpell` runs, then diffs against the post-apply state. Damage, heal, status add, status remove, death — all derived automatically from the diff. Adding new spells requires zero host-arb code changes.

**Killed bugs:**

1. The v1.7.472 monster-attack divergence (`targetAlly = -1` vs `targetAlly >= 0` branches with different stat fields, status inflicts, protect halving). Guests never run either branch under host-arb.
2. The `recalcStats` vs `generateAllyStats` divergence for host-self stats. The snapshot ships realized stats directly; joiners never recompute.
3. The mid-battle turnIdx misalignment Phase 7 caught in code review (legacy snapshot shipped `encounterTurnIndex` = 0 instead of the resolver's actual counter).

**Convergence regression gate:** `tools/coop-arbiter-sim.js` — three suites, 59 tests. Suite 1 documents the lockstep divergence sources (5 failing-by-design baselines). Suite 2 validates wire-shape contracts + module export surface. Suite 3 drives 38 convergence scenarios (physical, magic, items, poison, KO, snapshot, multi-round drift). Runs in `deploy.sh` via `--expect-fail` mode (Suite 1 baseline failures are the "green" state until live cutover).

**Flag flip + live smoke:** see `docs/COOP-PHASE-6-SMOKE.md` for the procedure.

### Party co-op random encounters — legacy lockstep model (HISTORICAL)

Pre-rewrite implementation. Documented here for context — **do not extend this model**; route new co-op work through the host-arb resolver/applier above.

Real party members are wire-driven allies in random monster battles instead of AI-simulated. Mirror of the PvP wire pattern. Both clients run identical FSMs from a shared seed.

| Direction | Type | Fields |
|---|---|---|
| C→S | `encounter-start` | `seed, monsters: [{monsterId}], partyUserIds` — host triggers a random encounter and pulls party members in |
| S→C | `encounter-invite` | `seed, monsters, hostUserId, peers: [{userId, …profile}]` — forwarded to each validated party-member candidate |
| C→S | `encounter-action` | `kind, target, hitResults?, spellId?, itemId?, damageRoll?, healAmount?` — a peer's chosen turn action |
| S→C | `encounter-action` | relayed with `userId` (sender) attached; `{kind:'disconnect'}` synthesized when a peer drops |
| C→S | `encounter-end` | `outcome` — peer's local FSM finished the battle |
| S→C | `encounter-end` | `userId, outcome` — peer reported end; clears the group; receivers force-close their local FSM if mid-battle |

`battleSt.isWireEncounter` is the local flag. `encounterIsHost / encounterHostUserId / encounterSeed` mirror the PvP `pvpSt._wire*` set. (`encounterTurnIndex` was retired in Phase 7 — see `getResolverTurnIdx()` for the authoritative counter.)

**Sync defenses (same shape as PvP v1.7.406-v1.7.410, applied to encounters):**

1. **Authoritative pre-rolled values.** `hitResults` rides `encounter-action {kind:'attack'}` so the receiver doesn't re-roll against a drifted cursor. (`damageRoll` / `healAmount` slots present for magic; ally magic replay added v1.7.419.)
2. **Per-turn rand reseed.** `battle-turn.js#maybeReseedCoopTurn` increments `battleSt.perTurnIndex` and calls `rng.seed(encounterSeed + perTurnIndex)` at every round boundary (`_updateBattleMenuConfirm` + ps-dead end-of-round path).
3. **Canonical actor-push order.** `buildTurnOrder` has a `_pushPlayerCoop()` branch that collects `ps` + battleAllies into one team, sorts by (host's userId first, then ascending userId), pushes each through `rollInitiative` in sorted order. Both clients consume rand for the same logical actor regardless of which side they're sitting on.
4. **Monster-target canonical order** (v1.7.419). `battle-enemy.js#_processEnemyFlash` builds the same canonical team list and picks via shared `rand()`, then maps the picked userId to either local `ps` (-1) or `battleAllies[N]`. Pre-fix, `Math.random()` picked "ps" on one client and "ally" on another for the same monster → instant HP divergence.
5. **All `Math.random` in `battle-enemy.js` converted to `rand()`** (v1.7.421, the silent killer). Monster physical-attack damage variance, multi-hit hit-rate, evade rolls, special-attack chance + which-attack pick, special-attack damage roll. Pre-fix monster damage was per-client; everything else was synced; HPs diverged turn one.

**Why it ultimately failed:** the defenses above synchronized rand cursors but couldn't fix structural code-path asymmetry — when a monster attacked the encounter triggerer, host's FSM took the `targetAlly = -1` branch (uses `ps.def`, `ps.elemResist`, `protect`, status inflict) while guest's FSM took the `targetAlly >= 0` branch (uses `ally.def`, no elemResist, no protect, no inflict). Same logical event, different functions, different HP outputs. The rewrite eliminates this by having only ONE side resolve and ship deltas; see the host-arb section above.

**Wire-driven ally turn dispatch** (`battle-turn.js#processNextTurn` ally branch). When the ally has `isWireDriven && userId && battleSt.isWireEncounter`:
- `processTurnStart(ally.status, ally.maxHP)` runs first so sleep-wake / paralysis-skip / confuse-snap rand consumers stay aligned. `turn._statusDone` flag prevents double-consume in the unshift-retry loop.
- Call `dequeueWireEncounterAction(ally.userId)`. Found → `_applyWireEncounterActionForAlly` replays the action (`attack` reads wire-supplied `hitResults`; `magic`/`item` populate the `ally-magic-cast` state bag from wire payload; `defend` sets `ally.isDefending = true`, halved in `battle-enemy.js` ally-attack damage path; `run`/`skip` advance the turn).
- Not found → `turnQueue.unshift(turn)`, `battleState = 'ally-wire-wait'`. The state handler in `battle-ally.js#updateBattleAlly` retries `processNextTurn()` each frame. **10 s timeout** (v1.7.471) drops the ally's turn — miss-your-turn semantics — without changing `isWireDriven`.

**Drop-roll sync.** `battle-update.js#_updateMonsterDeath` switches `Math.random → rand` for the drop-chance + drop-pick rolls when `isWireEncounter`. Both clients roll the same outcome; each adds the drop to their own inventory (everyone gets a copy; NES-canon party loot model).

**Run sync.** Sender's `encounter-box-close` fires `endWireEncounter('won'/'lost')` which emits `encounter-end`. The receiver's handler force-transitions to `encounter-box-close` if mid-battle (guarded against already-wrapping-up states so a converged victory completes naturally).

### Battle Assist (Step 7 — v1.7.422 → v1.7.425)

Overworld players can join in-progress roster battles regardless of party membership.

- `inBattle: 0|1` lives in the wire profile (clamped on server, broadcast via `player-update`).
- Roster row renders a small red 3×3 pixel block at top-left of the portrait box when `p.isReal && p.inBattle` (mirror of the green online dot at top-right). Drives the "Assist" action eligibility.

| Direction | Type | Fields |
|---|---|---|
| C→S | `encounter-assist-request` | `targetUserId` — joiner picked Assist on a roster row |
| S→C | `encounter-assist-incoming` | `fromUserId, fromName, fromProfile` — server forwards to target after validating target is helloed + same-loc + `inBattle` + joiner isn't already in another battle / PvP |
| C→S | `encounter-assist-snapshot` | `joinerUserId, seed, turnIndex, monsters: [{monsterId, hp, status: {mask, poisonDmgTick}}], peers, hostUserId` — target's auto-accept; full state snapshot of the in-progress battle |
| S→C | `encounter-assist-snapshot` | relayed to joiner so they spawn the same battle locally |
| S→C | `encounter-ally-join` | `profile` — broadcast to any OTHER existing peers in the group so they fade-in the new joiner |

**Target side** (`battle-encounter.js#setNetEncounterAssistIncomingHandler`): on receiving the incoming, if a slot is open (`battleAllies.length < 3`) and we're not in PvP and the joiner isn't already in our `battleAllies` (dedup against double-tap, v1.7.424), build the snapshot — current monster HPs + status, peer list (self + existing real allies), seed, turnIndex, hostUserId — and emit. If we were in a SOLO battle, convert to host-of-co-op first: set `isWireEncounter`, `encounterIsHost`, generate seed, start emitting actions from this turn forward via `_updateBattleMenuConfirm`. Locally add the joiner to `battleAllies` with `fadeInStartMs = Date.now()`.

**Joiner side** (`battle-encounter.js#setNetEncounterAssistSnapshotHandler`): spawn the encounter locally from the snapshot. Critical difference vs the at-start `encounter-invite` path: monster HPs come from the snapshot (current state), status mask is rebuilt from wire, seed rand with `(seed + turnIndex)` so subsequent rolls match. Peers pushed to `battleAllies` as wire-driven, sorted canonical (host first), each with `fadeInStartMs`.

**Side-channel ally fade-in** (v1.7.423). `battle-ally.js#_tickAllyFadeIn` runs every frame regardless of `battleState`. Allies with `fadeInStartMs` set get `fadeStep` decremented based on `Date.now()` elapsed; fully visible after ~400 ms. Works mid-battle without interrupting the FSM (the classic `ally-fade-in` state-machine pause doesn't fit mid-flight). Also fixed a pre-existing bug where the v1.7.418 at-start invite handler left guest-side peers at `fadeStep = ROSTER_FADE_STEPS` (invisible).

**Audit-driven dedup + defenses** (v1.7.424):
- Server `encounter-assist-snapshot` drops the second snapshot if the joiner is already in the target's group (double-tap protection).
- Target `setNetEncounterAssistIncomingHandler` drops the second incoming if `battleAllies` already has the joiner.
- `resetBattleVars` calls `clearWireEncounterQueue()` defensively so a half-open TCP queue can't replay against a new battle.
- Wire-wait timeout bumped 30 → 45 s to absorb legitimate cellular spikes.
- `_pushPlayerCoop` skips allies with no userId (defensive against future PLAYER_POOL repopulation that would collide at userId=0).

### ATB rewrite reverted (v1.7.456)

The FF4-style ATB system that shipped across v1.7.428→v1.7.455 was reverted at user request. Combat is back to **FF3-style round-based**: `buildTurnOrder` rolls initiative once per round, `processNextTurn` works through the queue, `TURN_TIME_MS = 10000` auto-skips a stuck player decision. Deleted: `src/atb.js`, `src/atb-render.js`, `tools/atb-sim.js`, `tools/atb-fsm-sim.js`. Stripped wire kinds: `atb-sync`, `atb-ready`, `pvp-atb-sync`. Stripped server state: `_encounterBattles`, `_tickEncounterBattles`, `_initEncounterBattle`, `_addPlayerToEncounterBattle`, `_broadcastAtbReady`, `_computeRA`, the 100 ms tick `setInterval`. Stripped client: Battle Speed slider, `SPELL_CAST_TIME` table, `setSpeedMod` Haste wire, `_drawPortraitATBBar`. The wire-protocol audit from the original v1.7.418-v1.7.425 co-op band is intact (the round-queue / canonical actor-push / per-turn rand reseed defenses still apply to round-based co-op).

### Party invites

| Direction | Type | Fields |
|---|---|---|
| C→S | `party-invite` | `targetUserId` |
| C→S | `party-cancel` | — |
| C→S | `party-invite-response` | `accept` |
| C→S | `party-dismiss` | `memberUserId` (inviter clears a member) |
| C→S | `party-leave` | — (member voluntarily leaves) |
| S→C | `party-invite-incoming` | `challenger: {userId, …profile}` |
| S→C | `party-invite-result` | `accept, partner?, reason? ('offline'|'busy'|'rejected')` |
| S→C | `party-member-left` | `memberUserId, memberName` |
| S→C | `party-disbanded` | `inviterUserId, inviterName` |

Server enforces one-party-per-player. `party-invite` rejects with `reason:'busy'` if target is already a member. Disconnect cleans up both directions and notifies the surviving side.

## Key files

| File | Role |
|---|---|
| `ws-presence.js` | server WS endpoint at `/api/ws?token=…`, relay + minimal arbitration |
| `src/net.js` | client WS connector, polling, send/receive handler registry |
| `src/main.js#connectNet` | profile getter for the wire — includes player fields + serialized allies |
| `src/pvp-search.js` | wire-search branch (`isRealTarget`) + match handler |
| `src/pvp.js#startPVPBattle` | seeds RNG from wire on `opts.seed`; sets `isWirePVP` flag |
| `src/pvp.js#_processEnemyFlash` | wire branch: queue-scan for matching actor.idx, dispatch via `_applyWireOpponentAction` |
| `src/battle-update.js#_emitWirePVPAction` | translates `inputSt.playerActionPending` → wire shape |
| `src/battle-update.js#tryJoinPlayerAlly` | mid-battle fake-roster ally pick (synced `rand()`) + wire `pvp-ally-join` |
| `src/party-invite.js` | wire-invite branch, accept prompt via `showMsgBoxPrompt` |
| `src/encounter-wire.js` | encounter wire queue + emit/dequeue helpers (mirror of pvp.js `_wireOpponentActions`) |
| `src/battle-encounter.js` | host emit (`_maybeHostCoopEncounter`) + guest spawn (encounter-invite) + assist accept + assist-snapshot spawn + ally-join broadcast handlers |
| `src/battle-turn.js#_pushPlayerCoop` | canonical actor-push order for co-op random encounters |
| `src/battle-turn.js#maybeReseedCoopTurn` | per-round rand reseed at `seed + turnIndex` |
| `src/battle-turn.js#_applyWireEncounterActionForAlly` | replays wire-driven ally turns (attack / magic / item / defend) |
| `src/battle-ally.js#updateBattleAlly` | wire-wait state retry + 45s timeout watchdog + side-channel fade-in tick |
| `src/game-loop.js` | hybrid rAF / Worker tick driver (rAF when visible, Worker when hidden) |
| `src/rng.js` | seedable mulberry32; combat rolls land identically when seed matches |

## Nginx config

Reverse-proxy needs WebSocket upgrade headers:

```nginx
location / {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 86400;
}
```

Already deployed at `/etc/nginx/sites-enabled/ff3mmo` on production. A backup of the pre-WS config lives in `/root/ff3mmo.bak.<timestamp>` on the server.

## Toggling fakes back on

`src/data/players.js` exports `PLAYER_POOL = []` to hide the fake-roster NPCs. The archived 30-entry list is preserved as `_FAKE_POOL` in the same file. To re-enable, swap the export:

```js
export const PLAYER_POOL = _FAKE_POOL;
```

Every consumer (roster, ally fills, fake PvP / fake party paths, chat sender) silently picks them back up.

## Defensive limits (v1.7.388 + v1.7.396)

- **`maxPayload` 16 KB** on the WebSocketServer. Single fat-frame OOM attacks rejected at the protocol layer.
- **Per-connection rate limit**: token bucket, capacity 60, refill 20/s. Excess frames are silently dropped.
- **Per-IP connection cap**: 10 concurrent WS connections from one source IP. nginx-aware (reads `X-Forwarded-For`). Excess gets 429.
- **`update` field clamping**: every profile field passes through `_normalizeProfileField` on both `hello` and `update` — `agi/level` clamped 1-99, IDs 0-255, name 16 chars, allies array ≤ 3. Hook-chance formula reads `agi` so this is load-bearing for fair matchmaking.
- **Location-change cleanup**: server drops the user's stale outgoing search + any incoming searches that now reference a different `loc`, notifying the affected challengers with `pvp-search-failed reason:'different-location'`.
- **JWT revocation watermark**: `users.token_iat_min` invalidates every outstanding session in one shot. Both HTTP `authMiddleware` and the WS upgrade route through `verifyTokenWithRevocation` so a logged-out token can't keep a WS open.

## Auth lifecycle (v1.7.396)

- **`POST /api/login`** / **`POST /api/register`** issue a 30-day JWT.
- **`POST /api/refresh`** — sliding window. Returns a fresh 30-day token if the supplied token is < 21 days old. Client (`index.html`) calls it on page load when the stored token's `iat` is > 7 days old. Older-than-21d tokens get 401 → re-login.
- **`POST /api/logout-all`** — bumps `users.token_iat_min` to `now`; every other open session sees 401 on its next request. Returns a fresh token for the caller so they stay signed in. Wired to the "Log out other devices" button in the user-bar.
- **WS upgrade revocation**: the upgrade handler routes through `verifyTokenWithRevocation`, so existing WS sessions die on the next reconnect after a logout-all.

## Recovery / known limits

- **WS connection assumes JWT exists.** Logged-out users get a silent no-op connect (token=null). Fine for the demo flow; no auth-required gating on the WS.
- **In-memory presence.** Server restart drops `_connected` / `_pvpSearches` / `_pvpPartners` / `_partyMemberships`. Active battles on the clients keep running locally but lose wire sync (next opponent action waits forever — watchdog fires).
- **PvP-action mismatch** auto-reconciles by scanning the queue for an actor.idx match. Logs `[pvp-action] queue-reorder` once per occurrence.
- **PvP disconnect** mid-battle ends the surviving client's fight as `outcome:'fled'` with a "lost link" message. No XP/Gil, no fake death animation.

## Earlier prep work

The audit series that landed in v1.7.20x–v1.7.217 (`docs/SAVE-STATE-AUDIT.md`, `docs/INVENTORY-ECONOMY-AUDIT.md`, `docs/JOB-EXP-AUDIT.md`, `docs/MULTI-AUDIT.md`, `docs/MODULARIZATION-AUDIT.md`) and v1.7.358–v1.7.365 (`docs/COMBAT-MULTIPLAYER-AUDIT.md`) tightened every mutation seam the WebSocket layer hooks into — `dispatchDelta` for HP/status, seeded RNG, unified spell pipeline, resolveLivingTarget, combatant-ai. The cutover series in v1.7.366+ then plugged into those seams.

## v1.7.418-v1.7.425 closeout (co-op + Battle Assist, 2026-05-16)

Eight deploys built the random-encounter co-op layer on top of the PvP wire pattern, plus the open Battle Assist system that lets any roster player join an in-progress fight regardless of party. All actions (attack / defend / magic / item / run / skip) replay across the wire, all RNG consumers consistent across clients (canonical actor order + per-turn reseed + Math.random→rand conversion in `battle-enemy.js`), all damage / status state synced including mid-battle joiner snapshot, side-channel fade-in for new allies, 45 s timeout watchdog for dropped peers, double-tap dedup at server + target. Wire-sim regression suite is 43/43 (4 PvP + 5 encounter + 4 assist tests added in the closeout). Read `CHANGELOG.md` 1.7.418 → 1.7.425 entries for per-deploy detail.

## v1.7.426-v1.7.427 post-launch hardening (2026-05-16)

Four parallel audits across the wire-driven visual + state layer (sprite poses, battle animations, predicate coverage, spell-ID sourcing) found the layer mostly clean end-to-end. The agent findings that turned out to be real reduced to: per-kind WS rate-limit gap, identity-spoofable peer list in the Battle Assist snapshot, and three LOW-severity visual cleanups (held-key leak on `ally-wire-wait`, dead `isOppVictory` branches in `pvp-drawing.js`, sweat overlay at full opacity during Battle Assist fade-in). Two deploys:

**v1.7.426** — Hostile-client hardening. (a) **Per-kind rate-limit buckets** in `ws-presence.js` (`_rateAllowKind` + `PER_KIND_RATES`). The connection-wide token bucket (60/20) is shared across kinds, so a user spamming 60 `chat` frames could starve their own `pvp-action` / `encounter-action`. New per-kind caps for user-action-driven kinds: `chat` 20/5, `encounter-assist-request` / `encounter-start` / `give-item` / `party-invite` 6/1. Poll-driven frames (`update`, `pvp-action`, `encounter-action`) stay global-bucket-only. (b) **Identity-pinned `peers` in `encounter-assist-snapshot`** — server validates every `peer.userId` is in `_connected` + helloed and overwrites identity fields (`name` / `jobIdx` / `level` / `palIdx`) with the server's trusted profile; live battle stats (hp, atk, def, weapon, spells) pass through since the server doesn't track in-battle mutations. Drops unknown userIds + joiner-in-own-peers. (c) Dead `console.warn` removed from the PvP queue-reorder path in `src/pvp.js` (was a v1.7.406 debugging leftover).

**v1.7.427** — Visual cleanup. (a) Action keys drained when `battleState === 'ally-wire-wait'` so a held key can't fire a menu command on the next state transition. (b) `isOppVictory = false` literal + 3 dead branches deleted from `pvp-drawing.js` (PvP battles end on death — opponent never enters a victory pose visible to the survivor). (c) Sweat overlay gated on `fadeStep === 0` so it doesn't float at full opacity while a Battle-Assist joiner's body fades in.

Wire-sim added 4 tests (per-kind chat cap, per-kind assist-request cap, snapshot identity-pin + spoof rejection, joiner-in-own-peers drop) and rebalanced one existing test for the new chat cap. Suite is now 47/47.
