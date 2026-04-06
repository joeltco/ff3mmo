# Multiplayer Roadmap

Replace fake `PLAYER_POOL` with real connected players.

---

## Step 1: WebSocket Presence (current)

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

---

## Status
- [ ] Step 1: WebSocket Presence
- [ ] Step 2: Real Chat
- [ ] Step 3: Real PVP
