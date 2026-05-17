# Multiplayer

**Live as of v1.7.443.** Open `ff3mmo.com` in two browsers with two accounts. Same location → see each other in the roster panel. Chat, party invites, PvP duels, low-HP roster pose, give-item-to-roster, party co-op random encounters, and Battle Assist (any roster player can join an in-progress fight) all wire-driven. Co-op battles run on **server-arbitrated FF4-style ATB** (gauges tick centrally, server broadcasts `atb-ready` events; clients defer dispatch). PvP runs on **client-driven lockstep ATB** with `pvp-atb-sync` keeping gauges aligned without RTT-per-turn latency. Fakes are off (`PLAYER_POOL` exported empty in `src/data/players.js`).

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

### Party co-op random encounters (Step 6 — v1.7.418 → v1.7.421)

Real party members are wire-driven allies in random monster battles instead of AI-simulated. Mirror of the PvP wire pattern.

| Direction | Type | Fields |
|---|---|---|
| C→S | `encounter-start` | `seed, monsters: [{monsterId}], partyUserIds` — host triggers a random encounter and pulls party members in |
| S→C | `encounter-invite` | `seed, monsters, hostUserId, peers: [{userId, …profile}]` — forwarded to each validated party-member candidate |
| C→S | `encounter-action` | `kind, target, hitResults?, spellId?, itemId?, damageRoll?, healAmount?` — a peer's chosen turn action |
| S→C | `encounter-action` | relayed with `userId` (sender) attached; `{kind:'disconnect'}` synthesized when a peer drops |
| C→S | `encounter-end` | `outcome` — peer's local FSM finished the battle |
| S→C | `encounter-end` | `userId, outcome` — peer reported end; clears the group; receivers force-close their local FSM if mid-battle |

`battleSt.isWireEncounter` is the local flag. `encounterIsHost / encounterHostUserId / encounterSeed / encounterTurnIndex` mirror the PvP `pvpSt._wire*` set.

**Sync defenses (same shape as PvP v1.7.406-v1.7.410, applied to encounters):**

1. **Authoritative pre-rolled values.** `hitResults` rides `encounter-action {kind:'attack'}` so the receiver doesn't re-roll against a drifted cursor. (`damageRoll` / `healAmount` slots present for magic; ally magic replay added v1.7.419.)
2. **Per-turn rand reseed.** `battle-turn.js#maybeReseedCoopTurn` increments `encounterTurnIndex` and calls `rng.seed(encounterSeed + turnIndex)` at every round boundary (`_updateBattleMenuConfirm` + ps-dead end-of-round path).
3. **Canonical actor-push order.** `buildTurnOrder` has a `_pushPlayerCoop()` branch that collects `ps` + battleAllies into one team, sorts by (host's userId first, then ascending userId), pushes each through `rollInitiative` in sorted order. Both clients consume rand for the same logical actor regardless of which side they're sitting on.
4. **Monster-target canonical order** (v1.7.419). `battle-enemy.js#_processEnemyFlash` builds the same canonical team list and picks via shared `rand()`, then maps the picked userId to either local `ps` (-1) or `battleAllies[N]`. Pre-fix, `Math.random()` picked "ps" on one client and "ally" on another for the same monster → instant HP divergence.
5. **All `Math.random` in `battle-enemy.js` converted to `rand()`** (v1.7.421, the silent killer). Monster physical-attack damage variance, multi-hit hit-rate, evade rolls, special-attack chance + which-attack pick, special-attack damage roll. Pre-fix monster damage was per-client; everything else was synced; HPs diverged turn one.

**Wire-driven ally turn dispatch** (`battle-turn.js#processNextTurn` ally branch). When the ally has `isWireDriven && userId && battleSt.isWireEncounter`:
- `processTurnStart(ally.status, ally.maxHP)` runs first so sleep-wake / paralysis-skip / confuse-snap rand consumers stay aligned. `turn._statusDone` flag prevents double-consume in the unshift-retry loop.
- Call `dequeueWireEncounterAction(ally.userId)`. Found → `_applyWireEncounterActionForAlly` replays the action (`attack` reads wire-supplied `hitResults`; `magic`/`item` populate the `ally-magic-cast` state bag from wire payload; `defend` sets `ally.isDefending = true`, halved in `battle-enemy.js` ally-attack damage path; `run`/`skip` advance the turn).
- Not found → `turnQueue.unshift(turn)`, `battleState = 'ally-wire-wait'`. The state handler in `battle-ally.js#updateBattleAlly` retries `processNextTurn()` each frame. **45 s timeout** (v1.7.424) flips the ally to AI-fallback (`isWireDriven = false; isDefending = true`) so cellular spikes don't hard-stall the FSM.

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

### ATB lockstep + server arbitration (Step 8 — v1.7.428 → v1.7.443)

FF4-style ATB replaces the FF1 round queue + 10 s decision timer. Each combatant has a per-unit gauge filling in `RA × TICK_MS × speedMod` ms (FF4 RA = `floor(5 × anchorAgi / unitAgi)`, clamped to [2, 10] for playable pacing; anchor = local player). Wall-clock derivation: gauges read `Date.now() - startedFillingAtMs` per frame, not accumulated `dt`. Wait-mode is automatic — `'ready'` state doesn't tick, so the player's gauge naturally holds at target while menu is open.

**Co-op random battles — server-arbitrated** (slice 4c + 4d, v1.7.440 + v1.7.441). `ws-presence.js` maintains `_encounterBattles: Map<hostUserId, { peers, units, anchorMs }>`. Each unit has `{ ra, state, startedAt, readyAtMs }`. A 100 ms-interval `setInterval(_tickEncounterBattles, 100)` advances gauges and broadcasts `atb-ready {unitId, atMs}` when a unit fills. Client receives → `markReady(ref, atMs)` flips the local unit to `'ready'`. The dispatch hub (`_updateATBDispatch` in `battle-update.js`) picks the FIFO-earliest ready unit. Without `markReady`, no local dispatch (server-authoritative).

**PvP duels — client-driven lockstep** (slice 5, v1.7.442). PvP doesn't go through the server tick — RTT on every duel turn would hurt the feel. Instead `pvp-atb-sync {unitKind, allyIdx, atMs}` relays the sender's `markFilling` timestamp to the partner so both clients reset gauges at the same wall-clock anchor. Lockstep RNG (existing v1.7.406-v1.7.410 work) keeps damage/state matched.

**Bidirectional `atb-sync`** (slice 4b, v1.7.439). When a locally-owned unit's action animation completes (`_resetLastDispatched` in `battle-turn.js`), the owner emits `atb-sync {unitKind, monsterIdx, atMs}`. Server-side: updates `_encounterBattles[host].units[unitId]` (`state: filling, startedAt: atMs`) so its tick stays in step. Wire-side: relays to peers, each calls `markFilling(ref, atMs)` to anchor their gauge to the same atMs. Ownership: ps always emits; monsters emit only if `battleSt.encounterIsHost`; wire-driven allies are partner-owned, partner emits.

| Direction | Type | Fields |
|---|---|---|
| C→S | `atb-sync` | `unitKind: 'player'\|'monster', monsterIdx, atMs` (co-op only) |
| S→C | `atb-sync` | `userId, unitKind, monsterIdx, atMs` (relay to peers) |
| S→C | `atb-ready` | `unitId, atMs` — server's authoritative ready flip (co-op only) |
| C→S | `pvp-atb-sync` | `unitKind: 'player'\|'ally', allyIdx, atMs` (PvP only) |
| S→C | `pvp-atb-sync` | `userId, unitKind, allyIdx, atMs` (relay to partner) |

**Battle Speed slider** (slice 6, v1.7.443). Pause-menu Options → Speed: 1-6 (default 3 = 333 ms/tick). `TICK_MS` is a live-binding `export let` from `src/atb.js`; consumers re-read on every gauge compute. Persisted in `localStorage.ff3.battleSpeed`. **Haste spell** doubles your gauge fill rate via `setSpeedMod(ps, 0.5)` (battle-bound — cleared at battle exit by the fresh `_atb` from the next `initBattleATB`).

**Menu opens during gauge fill** (slice 3 polish, v1.7.437). Battle starts in `menu-open` instead of `atb-idle` so the player can queue an action while their bar fills. `confirm-pause` holds until `isReady(ps) && battleTimer >= 150`, then fires. Monsters/allies still interrupt freely during the menu (dispatch hub fires on both `'atb-idle'` and `'menu-open'` with `skipPlayer:true` in the latter).

Key constants live in `src/atb.js` (`TICK_MS`, `FILL_MAX`, `RA_MIN`, `RA_MAX`, `BATTLE_SPEED_TABLE`) and **must match the server's `_ATB_TICK_MS`/`_ATB_RA_MIN`/`_ATB_RA_MAX` in `ws-presence.js`**. Drift = co-op desync.

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
| `src/atb.js` | per-unit gauge math (wall-clock derived), `setBattleSpeed`/`setSpeedMod`, `setServerAuthoritative`, `markActing`/`markFilling`/`markReady`, `pickReadyActor({skipPlayer})` |
| `src/atb-render.js` | dev-only debug gauge row (gated on `window.__atbDebug`) |
| `src/battle-update.js#initBattleATB` | composite init from `ps + battleAllies + encounterMonsters + pvpSt.*`; toggles server-auth based on `battleSt.isWireEncounter` |
| `src/battle-update.js#_updateATBDispatch` | solo + co-op dispatch hub — fires on `atb-idle` and `menu-open` (skipPlayer in menu) |
| `src/pvp.js#_updatePVPATBDispatch` | PvP dispatch hub (mirror of above; receives `pvp-atb-sync` for partner gauge anchors) |
| `src/encounter-wire.js#setNetAtbSyncHandler` / `setNetAtbReadyHandler` | apply partner/server gauge events to local unit refs |
| `src/battle-turn.js#_resetLastDispatched` | markFilling at action end + emit `atb-sync` / `pvp-atb-sync` for locally-owned units |
| `tools/atb-sim.js` | 36-test pure-math suite (deploy.sh gate) |
| `tools/atb-fsm-sim.js` | stubbed-engine FSM driver (4 scenarios incl. server-auth defers-dispatch) |

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
