# Multiplayer Roadmap

Replace fake `PLAYER_POOL` with real connected players.

**Current state: not started — but seam-prep is underway.** The networked layer below has not been implemented; the live game still uses the simulated roster from `src/data/players.js` (see README "Status"). What *has* happened is a deliberate multiplayer-prep audit series in the v1.7.20x–v1.7.21x band that tightens every mutation seam the websocket layer will eventually hook into, so the eventual cutover is plumbing instead of refactoring:

- **`docs/SAVE-STATE-AUDIT.md`** (v1.7.215–v1.7.216) — `saveSlotsToDB()` is the single persistence seam; `consumedTiles`, last-town respawn position, and post-death status clear all routed through it.
- **`docs/INVENTORY-ECONOMY-AUDIT.md`** (v1.7.219) — `addItem` / `removeItem` / `grantGil` / `spendGil` validated, idempotent, return actual deltas; ready for websocket delta emission from one site per op.
- **`docs/JOB-EXP-AUDIT.md`** (v1.7.218) — `jobLevelStatBonus(jobIdx, jobLv)` and `generateAllyStats(player)` ensure fake players and (future) real players compute stats deterministically from the same inputs, so a websocket-delivered roster entry can render identically on every client.
- **`docs/MULTI-AUDIT.md`** + **`docs/MODULARIZATION-AUDIT.md`** (v1.7.206–v1.7.217) — physical-hit, heal-clamp, status-flag, initiative, slash-timing, and message-text constants consolidated to single sources; reduces the number of code paths the network layer has to keep in sync.

This doc is kept as the design target for when networked play lands. Full implementation is deferred until economics/server design is finalized.

---

## Step 1: WebSocket Presence

**Goal:** Server knows who's online and where. Clients see real players in roster.

### Server (`ws-presence.js`)
- Upgrade HTTP server to support WebSocket (`ws` library)
- On connect: authenticate via JWT (sent as first message or query param)
- Track connected players in a `Map<userId, { ws, name, loc, level, palIdx, equipment }>`
- Broadcast to all clients on:
  - `player-join` — new player connected (full player data)
  - `player-leave` — player disconnected
  - `player-move` — player changed location (new loc)
- On receive from client:
  - `location` — player changed map (loc string)
  - `update` — player stats/equipment changed

### Client (`src/net.js`)
- Connect WebSocket on successful login (after JWT received)
- Send `location` on every map change (world map, enter town, enter dungeon floor)
- Send `update` when equipment/level changes
- Maintain `onlinePlayers` map, updated from server broadcasts
- Expose: `getOnlinePlayers()`, `getOnlineAtLocation(loc)`

### Roster Integration (`src/roster.js`)
- `getRosterPlayers()` / `getRosterVisible()` pull from online players + fake backfill
- Real players sort before fakes
- Fake movement timer only runs for fake players (unchanged)
- Everything downstream (PVP, ally recruit, chat) just sees the merged list

### Player Data Shape (shared by real + fake)
```js
{
  name: string,        // display name (from save slot)
  level: number,
  palIdx: number,      // 0-7 outfit color
  loc: string,         // 'world' | 'ur' | 'cave-0' .. 'cave-3' | 'crystal'
  weaponR: number,     // right-hand weapon item ID
  weaponL?: number,    // left-hand weapon item ID (dual wield)
  armorId: number,
  helmId: number,
  shieldId?: number,
  hp: number,
  maxHP: number,
  isReal: boolean,     // true = real player, false = fake
}
```

### DB: `players` table
```sql
CREATE TABLE IF NOT EXISTS players (
  user_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  level INTEGER DEFAULT 1,
  pal_idx INTEGER DEFAULT 0,
  weapon_r INTEGER DEFAULT 0x1E,
  weapon_l INTEGER,
  armor_id INTEGER DEFAULT 0x73,
  helm_id INTEGER DEFAULT 0x62,
  shield_id INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```
Populated on first save or character creation. Queried on WebSocket connect to broadcast join.

---

## Step 2: Real Chat
- Chat messages relay through WebSocket
- Server broadcasts `chat` messages to all players at same location
- Client chat UI already exists — just wire send/receive

## Step 3: Real PVP
- Challenge request → server relays to target → accept/decline
- Battle actions (attack, defend, item, flee) relayed through server
- Server validates turns to prevent cheating
- Biggest piece — requires presence + roster working first

**Local prep landed v1.7.222–v1.7.226: roster Battle action now
runs a *search-and-hook* flow instead of an instant accept.**

- `src/pvp-search.js` — owns the lifecycle. `startPVPSearch(target)`
  shows a persistent "Searching for X..." message; `cancelPVPSearch`
  on X / on death / on timeout / on missed-cap; auto-resolves into
  "Connecting..." → `_startPVPBattle` when a hook fires.
- **Hook formula:** `clamp(0.25 + (chAGI − tgtAGI) × 0.015 + jobBonus, 0.10, 0.75)`
  with Thief +0.15 / Ranger +0.08. All tunables at the top of the
  module.
- **Search persists across map changes; only resolution gates on
  `(onWorldMap || dungeonFloor >= 0)`.** Town searches roll-but-can't-fire,
  burning a missed slot — prevents fish-from-town parking.
- **Target's encounter roll is simulated today** (8–15 s per-target
  sim timer in `tickPVPSearch`). Real multiplayer replaces this
  with a websocket `target_encountered` signal — the rest of the
  flow (hook chance, "Connecting...", `_startPVPBattle` hand-off)
  is unchanged. **This is the single seam to swap on Step 3 wire-up.**
- Roster row "Searching..." marquee + menu label flip (`Battle` →
  `Cancel`) are already in the row renderer; both read the search
  state via `isSearchingFor(target)`. No additional UI work needed
  for multiplayer.

When networking lands, Step 3 reduces to: replace the sim timer
with the server-driven signal, add server-side hook arbitration
for the parallel-challengers case (first-hook-wins, others get
"missed" message), and wire `_startPVPBattle` to accept a remote
target object instead of a `PLAYER_POOL` entry.

---

## Status
- [ ] Step 1: WebSocket Presence
- [ ] Step 2: Real Chat
- [ ] Step 3: Real PVP
