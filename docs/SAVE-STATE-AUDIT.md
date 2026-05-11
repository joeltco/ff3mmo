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
| 4 | `worldX/Y/currentMapId/onWorldMap` saved but never read at load time | dead schema | ⏸ deferred — design decision |
| 5 | Status flags persist through death-respawn | gameplay | ⏸ deferred — design decision |
| 6 | `saveSlotsToDB` not awaited; concurrent saves race | theoretical | ⏸ deferred — no observed corruption |
| 7 | `serverSave` failures not retried | resilience | ⏸ deferred — next save resyncs |
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

## #4 — `worldX/Y/currentMapId/onWorldMap` are dead schema

`saveSlotsToDB` writes them at lines 62-65. `parseSaveSlots` parses
them at `save.js:37-40`. **But nothing reads them on load** —
`title-screen.js:728` is hardcoded `loadMapById(114)` (Ur), no
fallback to saved position.

So the saved fields waste IndexedDB bytes + server-sync payload + JSON
parse time on every load. Either:
- **Option A:** wire them up so loading a save respawns the player at
  their saved position (proper RPG behavior).
- **Option B:** delete the dead fields from the schema entirely
  (clean up the dead data).

Currently undecided — needs design call. The "always start at Ur"
behavior is technically NES-classic-game-feel (you respawn at the
town when continuing), but for an MMORPG with persistent world state
(per the user's memory `feedback_ff3mmo_own_thing.md`) the worldX/Y
restore makes more sense.

## #5 — Status persists through death-respawn

`_respawnAtLastTown` (`battle-update.js:712`) restores `ps.hp` and
`ps.mp` to max but **does not clear `ps.status.mask`**. A player who
dies poisoned/blinded/etc. respawns full-HP but still afflicted.

NES FF3 canon: death clears most statuses (revive is a clean state).
Our current behavior could be:
- **Intentional** (player paid for items to cure status; death
  shouldn't be a free cure) — keep as is.
- **Unintentional gap** (gameplay flow expects revive = clean) — add
  `clearAll(ps.status)` to `_respawnAtLastTown`.

Awaiting design decision.

## #6 — Save race condition (theoretical)

`saveSlotsToDB` is `async` but **fire-and-forget** at all 47 call
sites — none `await` it. Two saves fired back-to-back race the
IndexedDB transaction + the server POST. In practice both reads of
`ps` see the same state, so the writes are idempotent and consistent.

The risk would be saving mid-operation (read state at step N, save at
step N+1, second save at step N+2 — IndexedDB resolves them out of
order, ending with step N+1 data). Not observed; flagged for
awareness.

## #7 — Server save no retry

`serverSave` failures are caught + logged (`save-state.js:104`) but
not retried. If the server is unreachable, the next `saveSlotsToDB`
call will resync (because `data[i]` is rebuilt from the local slot
each time). Acceptable for v0; could add an offline queue later.

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
