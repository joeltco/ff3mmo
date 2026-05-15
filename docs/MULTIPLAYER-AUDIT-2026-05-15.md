# Multiplayer Audit — v1.7.386 (2026-05-15)

Read every file in the MP stack end-to-end (`ws-presence.js`, `src/net.js`,
`src/rng.js`, `src/deltas.js`, `src/pvp.js`, `src/pvp-search.js`,
`src/party-invite.js`, `src/battle-update.js`, `src/battle-turn.js`,
`src/battle-encounter.js`, `src/battle-math.js`, `src/combatant-cast.js`,
`src/status-effects.js`, `src/game-loop.js`, `src/main.js`,
`src/message-box.js`, `src/movement.js`, `src/input-handler.js`).

Findings are ranked by severity. Each item includes the failure mode and a
suggested fix.

---

## CRITICAL — Combat desync

### 1. `defendHalve` / `targetProtected` diverge between sender and receiver

`battle-math.js#rollHits` (lines 178-180) halves damage post-roll when
`opts.defendHalve` or `opts.targetProtected` is set. Receiver
(`pvp.js:627`) passes `defendHalve: battleSt.isDefending`; sender
(`input-handler.js:214` + `battle-turn.js:220`) does **not** pass
`defendHalve` for PvP targets.

When the receiver is defending and the sender attacks, the synced RNG
produces identical raw rolls, but receiver halves and sender doesn't.
Sender's `pvpOpponentStats.hp` and receiver's `ps.hp` diverge 2× per hit.
Same bug for `BUFF_PROTECT`.

**Failure mode:** sender ends battle "won" while receiver still alive →
receiver's loop trips the synthetic `disconnect` action when sender's
`pvp-end` arrives. Defender is robbed and gets a degraded UX.

**Fix:** wire defender's defend/protect state in the action payload (or in
profile-update) so the attacker's `rollHits` opts match the defender's view.
The pvp-side flag `pvpSt.pvpOpponentIsDefending` already exists; pass it
into the sender's `rollHits` opts when attacking the opponent.

### 2. Status rolls use unsynced `Math.random()`

- `status-effects.js#tryInflictStatus` line 105 — Sleep/Paralyze/Poison
  infliction roll.
- `status-effects.js#processTurnStart` lines 146, 157 — sleep-wake (25%) +
  confuse snap-out (25%).

`processTurnStart` runs on both clients independently each PvP combatant
turn (`battle-turn.js:259`, `pvp.js`). If one client rolls "sleeper wakes"
and the other doesn't, the FSM forks: one side dispatches turn, other side
skips. Wire actions stop matching `actor.idx`, queue-reorder fires
repeatedly, eventually times out.

**Fix:** swap `Math.random` → `rand` in `status-effects.js`.

### 3. SouthWind opp throw rolls use unsynced `Math.random()`

`pvp.js:1169` — `swBase` uses `Math.random()` instead of `rand()`. SW
damage diverges across clients.

### 4. `_playerTurnRun` for fake-PvP/random-encounter uses `Math.random`

`battle-turn.js:754` — not a desync today because the PvP branch above
always succeeds, but the fake-PvP branch and random encounter both diverge
if any future code path reads them in lockstep. Low impact today; will bite
when PvP run becomes a real roll.

---

## CRITICAL — Server security

### 5. No `maxPayload` on `WebSocketServer`

`ws-presence.js:493`. Default `maxPayload` is 100 MB. One malicious client
can OOM the process with a single fat JSON frame.

**Fix:** `new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 })`.

### 6. No rate limiting on any message type

Server processes every `chat` / `pvp-search` / `party-invite` / `update`
immediately. Trivial griefing: spam `chat` at 10k msg/s, or spam `update`
to flood broadcast traffic (each `update` echoes to every connected
client; an attacker amplifies their bandwidth × N).

### 7. `update` accepts arbitrary values without clamping

`ws-presence.js:240-253`. A client can `update` with `{agi: 99999}` and
the server broadcasts it. PvP hook chance formula reads `agi` directly
(`_pvpHookChance` line 88) → attacker forces hook chance to the 0.75 cap
on every search.

The `hello` path coerces with `| 0` but doesn't bound. `update` doesn't
even coerce.

**Fix:** validate every field in `update` (same coercion as `hello`, plus
realistic range clamps for `level`, `agi`, `hp/maxHP`).

### 8. PM channel delivers to every user matching a display name

`ws-presence.js:469-474`. Comment on line 467 acknowledges this:
*"Names aren't unique in the engine… deliver to ALL matching."* Anyone
can rename to "Joel" and intercept every PM addressed to Joel.

**Fix:** route PMs by `userId`, not name. Client-side resolves name →
userId from the local online map at send time.

### 9. JWT secret defaults to a hardcoded dev value

`ws-presence.js:45` — `JWT_SECRET = process.env.JWT_SECRET ||
'ff3mmo-dev-secret-change-in-prod'`. If `JWT_SECRET` is unset on prod,
anyone can forge tokens for any `userId`. **Verify the env var is set on
the prod box**; otherwise the auth check is theatre.

### 10. No connection cap per user / per IP

A single attacker can hold thousands of WS connections (each consumes
memory + a `_connected` slot). The "replace stale connection" logic at
line 519 only handles same-`userId` collisions.

---

## HIGH — State / UX correctness

### 11. Stale searches and invites are not notified to the challenger

`ws-presence.js#case 'location'` (232-238) only emits `player-move`. It
does **not** scan `_pvpSearches` / `_partyInvites` for entries the
challenger started and that are now invalid because the challenger left
the location.

If A searches for B in Ur, A walks to the cave, B never gets the
encounter hook. A sits at "Searching..." for the full 5-minute timeout.
Same for B moving away.

**Fix:** on every `location` change, drop any `_pvpSearches` entry by
this user (and notify the challenger if they're the search owner) when
their `loc` no longer matches the target's `loc`. Same pattern for
`_partyInvites`.

### 12. `_pvpSearches` overwrite silently drops a previous active search

Line 270. The challenger's local `pvpSearchSt.target` may still be the
old target if they retargeted client-side. Minor UX nit.

### 13. `_resolveEncounterHook` race for simultaneous encounters

If B and C both send `pvp-encounter` in the same tick and A is searching
for both, A could end up double-matched. Node.js single-threaded
execution actually saves us today because `_resolveEncounterHook` is
synchronous start-to-finish per call. **Safe today, fragile if any
future async slips in.**

### 14. `pvp-result` mismatch is logged but not acted on

`ws-presence.js:418-449`. Given findings #1-#3, this WILL fire in real
games. There's no way to recover; one side just keeps battling alone.

### 15. `pvp-encounter` 500 ms fallback races with `pvp-encounter-none`

`battle-encounter.js:56-60`. If `pvp-match` arrives at ms 600 (between
the timeout and the encounter starting), both fire — monster battle +
PvP. The `battleState !== 'none'` check at line 59 prevents this for
monsters, but the `pvp-search.js#setNetPVPMatchHandler` has no such
guard. It calls `_startPVPBattle` while the monster encounter is
mid-fade-in.

**Fix:** in the match handler, abort if `battleState !== 'none'`.

### 16. Disconnect race for ongoing PvP

Server's close handler (543-552) sends `pvp-action {kind: 'disconnect'}`
to the partner. If the partner is already in `enemy-box-close`, the
action sits in `_wireOpponentActions` forever (queue drained on
`resetPVPState`, but only if the FSM reaches that point). Narrow window;
practically OK because `_wireOpponentActions.length = 0` runs in
`resetPVPState`. Low risk.

### 17. Reconnect resends `hello` with allies but doesn't clear pre-existing party state

On WS reconnect (`net.js:194-199`), `_onlinePlayers.clear()` +
`_helloed = false`. Server's `close` handler tears down memberships
before the new socket lands. **Verified not a bug.**

---

## HIGH — Correctness / consistency

### 18. `pvp-ally-join` accepts only a name — receiver looks it up in PLAYER_POOL

`pvp.js:155` — `PLAYER_POOL.find(p => p.name === name)`. With fakes
disabled (`PLAYER_POOL = []` by default per v1.7.386), every
`pvp-ally-join` silently no-ops. The sender added an ally locally but
the receiver never adds the mirror. **Sender's view: 2v1; receiver's
view: 1v1.** Their turn queues won't match starting next round.

Plus: even with fakes enabled, `tryJoinPlayerAlly` does a 3-step lookup
(PLAYER_POOL → online → partyMemberProfiles), but the wire-receive side
only checks PLAYER_POOL.

**Fix:** make `setNetPVPAllyJoinHandler` look up via the same chain AND
extend the `pvp-ally-join` payload to carry the full stat block as a
fallback for receivers who can't resolve the name locally.

### 19. `update` polling races with battle-state mutations

`net.js:217-235` polls `profileFn()` every 500 ms. While in PvP, every
hit changes `ps.hp`, triggering an `update` broadcast. Acceptable
bandwidth; receiver's `_onlinePlayers` map updates — and
`generateAllyStats` reads during `tryJoinPlayerAlly` could pick up a
mid-attack-animation snapshot. Minor today.

### 20. Server `hello` normalizes `shieldId` but `update` blindly accepts it

`ws-presence.js:206` vs lines 243-245. Inconsistent. Trivial fix.

### 21. Race: `pvp-match` arrives while we're already in a battle

If A searches B, the server matches them, broadcasts `pvp-match`. If B
is mid-`startRandomEncounter` because the 500 ms fallback in
`battle-encounter.js` fired before the WS round-trip, the
`pvp-search.js#setNetPVPMatchHandler` transitions to PvP, leaving the
in-flight monster encounter in a half-state. Related to #15.

### 22. `chat` channel='party' uses location filter, not party membership

`ws-presence.js:480-486` broadcasts party chat to *every player at the
same loc*. Comment line 455-457 acknowledges this is a placeholder.
**Currently anyone in the same location sees your party chat.** Privacy
bug.

---

## MEDIUM — Functional gaps

### 23. `pvp-action {kind: 'item'}` only handles "potion on self"

`pvp.js:808-825`. If sender uses a Cure Potion on their ally, the wire
emits `kind: 'item'` with `target: {side: 'me', idx: N}`. Receiver
branches to `if (casterCellIdx === 0)` and heals the OPPONENT, not the
targeted ally.

**Fix:** translate `target` properly, like the `kind: 'magic'` path does
(lines 767-784).

### 24. `pvp-action {kind: 'magic'}` doesn't carry `damageRoll`/`healAmount`

`battle-update.js:383` emits `{spellId, target}` only. Receiver re-rolls
via `rollOffensiveDamage(caster, spell)` (`pvp.js:774`). Synced seed
should make this work, but it places extra burden on RNG cursor lockstep
and `combatant-ai.js` helpers can branch on caster status that differs
across clients via stale profile-update.

**Fix:** include the rolled values in the wire payload as a sanity check.
Receiver uses them if present; falls back to local roll otherwise.

### 25. `chat` length cap is text only — channel/to fields unbounded

Line 459 caps text to 200 chars. `channel` and `to` aren't capped at the
receive site (`to` is limited to 16 in the PM branch). Trivial DoS via
huge channel string allocation.

### 26. `pvp-result` doesn't time out

If user A reports `won` and user B never reports anything (process
killed, network loss before pvp-end), partner's `_lastPVPResult` is set
but never compared. Server's `_pvpPartners` cleared via close handler
eventually, but if WS never closes (TCP half-open), it leaks.

### 27. `partyMemberProfiles` are stale after dismiss-then-reinvite

`party-invite.js:106-117`. Edge-case, low impact.

### 28. `tryJoinPlayerAlly` lookup order doesn't match the wire receiver

Sender picks ally from PLAYER_POOL ∪ partyMembers ∪ random fill. Wire
receiver (`pvp.js:155`) only handles random fill (and only via
PLAYER_POOL). Sender's party-member ally is silently absent on receiver
side → same desync as #18.

---

## MEDIUM — UX / observability

### 29. No "still searching" heartbeat / no list-of-pending-searches API

A challenger has no way to know whether the server still holds their
search. If a desync drops the search on the server but not the client,
the user sees "Searching..." until timeout.

### 30. `pvp-search-failed reason:'target-engaged'` shows "Missed!" but no cooldown distinction

A real-player target who's already in PvP looks the same as a roll miss.
Hard to debug from the player's side.

### 31. Freeze watchdog can fire spuriously when waiting on wire actions

`game-loop.js:95` — `FREEZE_THRESHOLD_MS = 5000`. The receiver can sit
in `enemy-flash` for >5 s waiting for the sender's `pvp-action` in a slow
network. Watchdog fires + POSTs `/api/client-error` — noisy.

**Fix:** treat `enemy-flash` as idle when
`pvpSt.isWirePVP && _wireOpponentActions.length === 0`.

### 32. `setActiveCast` is set during wire-applied opponent magic but never `clearActiveCast`'d

`pvp.js:790`. `_processPVPEnemyMagic` never calls `clearActiveCast`. If
any downstream consumer reads `activeCast` after the spell finishes, it
reads stale data.

---

## LOW — Hygiene

### 33. `_pvpSearches` overwrite silently drops a previous active search

Line 270. Tiny gap; user-visible only on immediate re-issue.

### 34. `_pendingPVPCheck` is module-singleton — two concurrent encounter checks would clobber it

`battle-encounter.js:49`. Practically not reachable today.

### 35. `update` polls every 500 ms regardless of activity

`net.js:205`. While the player is idle in town, this is 2 calls/sec /
connection / forever. Not a bug; tunable.

### 36. `replaceMsgBoxText` during wire-search "Connecting..." doesn't account for prompt mode

`pvp-search.js:191`. If a party invite incoming arrives while in
resolving phase, the `isPrompt` state could leak.

### 37. `partyMemberProfiles` survives `_endInvite`

By design — but persists in memory across new saves until refresh.

### 38. `MULTIPLAYER.md` doesn't surface party-chat-by-location caveat

The doc says party chat is location-scoped but doesn't flag this is
**the entire chat security model**.

---

## Summary by area

| Area            | Critical    | High     | Med           | Low      |
| --------------- | ----------- | -------- | ------------- | -------- |
| Combat sync     | 4 (#1-#4)   | —        | 2 (#23, #24)  | —        |
| Server security | 6 (#5-#10)  | —        | 1 (#25)       | —        |
| State / UX      | —           | 7 (#11-#17) | 3 (#26-#28) | 5 (#33-#37) |
| Observability   | —           | 4 (#18-#22) | 3 (#29-#31) | 1 (#38) |

## Top 5 to fix first

1. **#2** — `Math.random` → `rand` in status-effects.js. One-line per site,
   eliminates the largest divergence source.
2. **#5** — set `maxPayload` on the WebSocketServer.
3. **#7** — clamp profile fields in `update` (especially `agi`).
4. **#18** — fix `pvp-ally-join` lookup to mirror `tryJoinPlayerAlly` (or
   carry profile in payload).
5. **#1** — wire defender's `isDefending` / `hasBuff(PROTECT)` state into
   the action payload so `rollHits` opts match across clients.

After those five, the next tier is rate limiting (#6), PM-by-userId (#8),
and the encounter race (#15/#21).
