# Multiplayer

**Status as of v1.7.785:**

- **PvE solo combat** — fully server-validated (encounter rewards exp/gil/cp/drop, shops, chests, vases) via the **PvE arbiter + economy arbiter** arc shipped v1.7.771-783. See `docs/PVE-REWRITE-PLAN.md` + `design-notes.md#pve-arbiter-economy-validation`. Replay-validate model: client runs battle locally with server-chosen monsters + seed, server outcome-validates at battle-end. All four flags (`PVE_ARBITER` + `SERVER_ECONOMY`, server + client) LIVE.
- **PvP duels** — server-arbitrated rewrite shipped v1.7.747-757, flags went LIVE v1.7.758, **DISABLED again v1.7.770** pending P-6d anim polish + P-4c magic/items. Arbiter wires stay armed (`PVP_ARBITER_SERVER` + `PVP_ARBITER` = `true`); only the two `PVP_ENABLED` flags + the "Battle" roster menu item are off. See `docs/PVP-REWRITE-PLAN.md`. The original v1.7.502 disable was the client-side lockstep model that couldn't hold cross-phone determinism — the rewrite is the full server FSM that fixed the root cause.
- **Co-op party battles** — model rebuilt. NO true co-op anymore (decision 2026-05-22). Battle allies are now **local AI built from real roster players' stats/equipment**, per-round room-gated reconcile in `tryJoinPlayerAlly` (v1.7.559). The three previous architectures (lockstep / host-arb / viewer, v1.7.418-500) all froze the guest phone and were removed. See `[[ff3mmo-coop-rebuild]]`.
- **Inventory mirror (v1.7.740-746)** — server-canonical gil + inventory + equipped state. Prerequisite for both arbiter arcs above. Closes the 5 original dup vectors (`[[ff3mmo-dup-vectors]]`).
- **Roster Trade (v1.7.598-616)** — real-MP item transfer with server type-whitelist + audit log. See `design-notes#roster-trade-real-multiplayer`.
- **Party persistence (v1.7.595-596)** — parties survive disconnect/restart via SQLite tables + in-memory mirrors. See `[[ff3mmo-persistence-layer]]`.
- **Presence, chat, party invites, give-item, roster low-HP pose** — wire-driven and working.
- **Boss combat** — solo-only; unaffected by any of the above.

Open `ff3mmo.com` in two browsers with two accounts. Same location → see each other in the roster panel. Chat, party invites, low-HP roster pose, give-item, and Roster Trade are all wire-driven and working. Combat is **FF3-style round-based** — the FF4 ATB system that shipped in v1.7.428-v1.7.455 was reverted in v1.7.456 (didn't feel right); all `atb-sync` / `atb-ready` / `pvp-atb-sync` wire kinds + the server-side `_encounterBattles` tick loop are gone. Fakes are off (`PLAYER_POOL` exported empty in `src/data/players.js`).

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

- **`world`** = global (every helloed client; v1.7.700). Pre-v1.7.700 was location-scoped (`target.loc !== entry.loc → skip`), which broke the MMO feel — Ur visitors and cave divers couldn't see each other. Per-IP / per-kind rate limits + profanity mask + name sanitization still apply.
- **`party`** = membership-scoped via the server's `_partyMemberships` map (inviter + their members). Does **not** leak to other parties or to bystanders at the same location. (v1.7.388 — was location-scoped pre-fix.)
- **`pm`** = userId-targeted when the client sends `toUserId`; falls back to first-match-by-name when only `to` is set. The name path stops at the first match so a player can't intercept PMs by renaming to "Joel" anymore. (v1.7.388.)

### PvP search (Step 3)

> **DISABLED v1.7.502.** The wire shapes below are documented as-built and still
> regression-tested, but `PVP_ENABLED` is off (server + client) so no search is
> registered and no match fires. Re-enable per the status note at the top.

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

### Party co-op battles + Battle Assist — REMOVED (v1.7.500)

Wire-driven party members in random battles, and Battle Assist (joining an in-progress fight), were ripped out in v1.7.500 for a from-scratch rebuild. Three architectures were attempted and all froze the guest phone: deterministic lockstep (v1.7.418-472), host-authoritative deltas behind `COOP_HOST_ARB` (v1.7.474-477), and the viewer/card-game model behind `COOP_VIEWER_MODE` (v1.7.486-496). All of `src/coop-resolver.js` / `coop-applier.js` / `coop-deltas.js` / `coop-viewer.js` / `coop-view-anims.js` / `encounter-wire.js`, the `encounter-*` wire kinds (server + client), the `battleSt.isWireEncounter` family, and the server's `_encounterGroups` / `_encounterHosts` are gone. Random encounters are solo-only.

**Two fixes from the removal effort SURVIVE** because they're correct independent of co-op and PvP uses them:
- Monster-attack branch unification (`battle-enemy.js` `_targetCombatant`) — guarded by `tools/encounter-sim.js`.
- Realized-stats wire profile + `generateAllyStats` fast path — guarded by `tools/wire-stats-diag.js`.

The rebuild's design intent + root-cause analysis live in the `ff3mmo-coop-rebuild` auto-memory. The removed implementation is in git history before v1.7.500.

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
| `src/battle-encounter.js` | solo random-encounter spawn (`startRandomEncounter`) + PvP-hook pre-check |
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
