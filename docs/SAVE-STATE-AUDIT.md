# Save state + persistence audit

Started 2026-05-10. Sweep of what gets persisted, what doesn't, when
saves trigger, and what's dead schema. `saveSlotsToDB` is the single
public entry — called 47 times across 9 files; the schema lives at
`src/save-state.js:37` and the load path is in `src/title-screen.js`
(~line 685).

## TL;DR

| # | Item | Class | Status |
|---|------|-------|--------|
| 1 | **Chest farming exploit** — opened chests reset on map re-entry; tilemap mutation is in-memory only | gameplay/economy bug | ✅ v1.7.215 |
| 2 | Secret walls reset on map re-entry | nicety / minor exploit | ✅ v1.7.215 (same fix path) |
| 3 | Rock puzzle resets on map re-entry | progression risk | ✅ v1.7.215 (same fix path) |
| 4 | Saved position now restored on load (was hardcoded Ur fallback) | dead schema → live | ✅ v1.7.216 |
| 5 | Status flags now clear on death-respawn (revive = clean state) | gameplay | ✅ v1.7.216 |
| 6 | `saveSlotsToDB` not awaited — verified not a bug | theoretical | ✅ verified safe |
| 7 | `serverSave` failures not retried — verified self-healing | resilience | ✅ verified safe |
| 8 | Equipment saved inside `slot.stats` (nested) | naming clarity | ⏸ deferred — works fine |

## What's saved (verified clean)

Slot top-level fields (single source: `saveSlotsToDB` in
`save-state.js:37-69`):
- `name` (Uint8Array)
- `level`, `exp`, `hp`, `mp`
- `stats` (snapshot blob — `playerStatsSnapshot()` includes
  `weaponR`, `weaponL`, `head`, `body`, `arms`, `maxHP`, `maxMP`,
  derived `hitRate` / `evade` / `mdef`)
- `inventory`, `gil`
- `jobLevels`, `jobIdx`, `unlockedJobs`, `cp`
- `statusMask`, `statusPoisonTick`
- `lastTown`, `lastWorldExitX`, `lastWorldExitY`
- `knownSpells`
- `playTime`

Derived stats (`atk`, `def`, `hitRate`, `evade`, `mdef`,
`elemResist`, `statusResist`) are recomputed at load via
`recalcCombatStats` — correct, not stored.

Battle-bound state (buffs, battleSt, hudSt, pauseSt, inputSt) is
deliberately not persisted — clears every battle/session.

## #1-3 — Map mutations reset on re-entry

**The pattern:**
- `handleChest` (`map-triggers.js:106`) writes `tilemap[idx] = 0x7D`
  (opened chest tile) to mark chest as taken.
- `handleSecretWall` (`map-triggers.js:126`) writes `tilemap[idx] =
  0x30` (revealed wall).
- `handleRockPuzzle` (`map-triggers.js:133`) writes new tile IDs for
  the puzzle-revealed wall segment.

**The bug:**
All three mutations happen on `mapSt.mapData.tilemap` in-memory only.
When `loadMapById` runs (entry to a different dungeon floor, re-entry
to a town, post-respawn), it calls `generateFloor(romRaw, ...)` which
rebuilds `mapData` fresh from ROM. The tilemap mutations are wiped.

**Concrete consequences:**
- **Chests refill on re-entry** — player can farm gil/items by
  exiting the dungeon and walking back in. Tier-1 economy break.
- **Secret walls re-hide** — minor; player can re-reveal them.
- **Rock puzzles reset** — if a puzzle gates a path, player has to
  re-solve it. If a puzzle reveals loot behind a chest, that loot is
  re-farmable too.

**Fix shape (shipped v1.7.215):**
- New `ps.consumedTiles: { [mapId]: { [x,y]: tileId } }` — stable
  map of mutated tile coords to their post-mutation tile IDs.
  Persisted in the save schema.
- `handleChest` / `handleSecretWall` / `handleRockPuzzle` record
  their mutations into `consumedTiles`.
- `loadMapById` replays the recorded mutations after
  `generateFloor` — chest tiles stay opened, secret walls stay
  revealed, rock puzzles stay solved.

## #4 — Saved position now restored on load (v1.7.216)

Per the user's memory `feedback_ff3mmo_own_thing.md` (ff3mmo is its
own MMORPG, not a NES port), continuing a save now resumes where you
left off, not at Ur.

Load logic (`title-screen.js:_updateTitleMainOutCase`):
- Fresh slot (no `stats` yet) → Ur, `loadMapById(114)`, classic Ur
  spawn nudge.
- Saved overworld position → `loadWorldMapAtPosition(worldX/TILE_SIZE,
  worldY/TILE_SIZE)` with `TRACKS.WORLD_MAP`.
- Saved town / dungeon → `loadMapById(currentMapId, tileX, tileY)`.
  The map-load path swaps the music track for floor tracks
  automatically.
- Any missing position data falls back to Ur (defensive).

## #5 — Status now clears on death-respawn (v1.7.216)

`_respawnAtLastTown` now calls `clearAll(ps.status)` alongside the
HP/MP max-restore. Matches NES canon (revive = clean state) and the
expected gameplay flow — a player who eats a Land Turtle Bzzard
crit while Poisoned doesn't respawn full-HP-but-still-poisoned and
have to spend an Antidote before the next encounter.

## #6 — Save race: verified safe

Re-examined for the v1.7.216 sweep. `saveSlotsToDB` is `async` but
all `ps` reads happen **synchronously before the first `await`**
(the await on `openSaveDB()` at line ~98). JS single-threaded
execution guarantees one call's reads are atomic — there's no point
where another call could interleave between two reads of the same
function. IndexedDB then serializes the writes via the transaction
queue. Last-write-wins on identical data is correct.

Not a bug. Flagged in v1.7.215 audit out of caution; closed.

## #7 — Server save retry: verified self-healing

Re-examined for the v1.7.216 sweep. Each `saveSlotsToDB` call
rebuilds `data` from scratch via `saveSlots.map(...)`. A failed
`serverSave` means the local IndexedDB has the latest state but the
server doesn't — until the **next** save call, which rebuilds and
re-sends the same fresh data. The only data-loss window is "user
quits between failed-save and next-save", which is identical to the
"user quits before IndexedDB transaction settles" window — same risk
profile as any local-first persistence layer.

Not a bug under v0 expectations. Flagged in v1.7.215 audit; closed.

## #8 — Equipment saved nested inside `stats`

`playerStatsSnapshot()` bundles `weaponR/L/head/body/arms` into the
stats blob alongside `maxHP/maxMP/str/agi/...`. Cleaner organization
would be a sibling `equipment` field. But the current shape works
correctly (verified at load: `title-screen.js:703-707`). Naming
nicety, not a bug.

## Bonus: triggered save sites (n=47)

A spot-check of `saveSlotsToDB` calls by file:
- `chat.js` — 9× (chat-driven `/give`, `/spell`, `/level`, etc. cheat commands)
- `shop.js` — 3× (buy / sell / unequip)
- `pause-menu.js` — multiple (equip changes, item use, item sort)
- `map-triggers.js` — 2× (chest open, NPC dialog flag)
- `battle-update.js` — 4× (victory rewards, respawn, JP gain, MP spend)
- `battle-turn.js` — 1× (post-MP-spend confirm)
- `title-screen.js` — 1× (new game / load slot)
- `main.js` — 1× (cleanup on shutdown)
- `save-state.js` — internal

The high count is fine: each is a discrete state-changing event. No
duplicate triple-save patterns found.
