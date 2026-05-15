# Multiplayer

**Live as of v1.7.386.** Open `ff3mmo.com` in two browsers with two accounts. Same location → see each other in the roster panel. Chat, party invites, PvP duels all wire-driven. Fakes are off (`PLAYER_POOL` exported empty in `src/data/players.js`).

This doc is the architecture overview + recovery cheatsheet. For the per-deploy changelog of how it got built, see `CHANGELOG.md` 1.7.366 → 1.7.386.

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
| C→S | `chat` | `channel ('world'|'party'|'pm'), text, to?` |
| S→C | `chat` | `userId, name, channel, text, to?` |

World/party = location-scoped (only same-loc clients receive). PM = name-targeted (delivered to every match).

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
| C→S | `pvp-action` | `kind ('attack'|'defend'|'magic'|'item'|'run'), actor: {idx}, target?: {side, idx}, spellId?, itemId?` |
| C→S | `pvp-end` | — (clears partner pair) |
| C→S | `pvp-result` | `outcome ('won'|'lost'|'fled')` |
| C→S | `pvp-ally-join` | `name` (fake-roster name for mid-battle ally fill) |
| S→C | `pvp-action` | relayed; also synthesizes `{kind:'disconnect'}` when partner WS drops |
| S→C | `pvp-ally-join` | relayed |

Each player's chosen action drives the opponent's turn on the partner's client. Seed sync (broadcast in `pvp-match`) means all rolls inside `battle-math.js` (initiative, damage variance, hit/miss, crit, evade) land on the same value on both sides. Outcome reports get compared server-side; mismatch is logged `[pvp-result mismatch]` as a divergence tripwire.

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
| `src/game-loop.js` | Web Worker tick driver (replaces rAF; survives backgrounded tabs) |
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

## Recovery / known limits

- **WS connection assumes JWT exists.** Logged-out users get a silent no-op connect (token=null). Fine for the demo flow; no auth-required gating on the WS.
- **In-memory presence.** Server restart drops `_connected` / `_pvpSearches` / `_pvpPartners` / `_partyMemberships`. Active battles on the clients keep running locally but lose wire sync (next opponent action waits forever — watchdog fires).
- **PvP-action mismatch** auto-reconciles by scanning the queue for an actor.idx match. Logs `[pvp-action] queue-reorder` once per occurrence.
- **PvP disconnect** mid-battle ends the surviving client's fight as `outcome:'fled'` with a "lost link" message. No XP/Gil, no fake death animation.

## Earlier prep work

The audit series that landed in v1.7.20x–v1.7.217 (`docs/SAVE-STATE-AUDIT.md`, `docs/INVENTORY-ECONOMY-AUDIT.md`, `docs/JOB-EXP-AUDIT.md`, `docs/MULTI-AUDIT.md`, `docs/MODULARIZATION-AUDIT.md`) and v1.7.358–v1.7.365 (`docs/COMBAT-MULTIPLAYER-AUDIT.md`) tightened every mutation seam the WebSocket layer hooks into — `dispatchDelta` for HP/status, seeded RNG, unified spell pipeline, resolveLivingTarget, combatant-ai. The cutover series in v1.7.366+ then plugged into those seams.
