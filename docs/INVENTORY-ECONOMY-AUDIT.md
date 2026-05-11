# Inventory + economy audit (multiplayer-prep)

Started 2026-05-10. Sweep of inventory + gil mutations from the
multiplayer angle — once the websocket layer broadcasts state
changes, every mutation site is a delta-emission point. The fewer
parallel paths, the cleaner the sync.

## TL;DR

| # | Item | Class | Status |
|---|------|-------|--------|
| 1 | `ps.gil` mutations are inline (`ps.gil +=` / `-=`) — 8 sites, no helper | multiplayer prep | ✅ v1.7.219 (grantGil / spendGil) |
| 2 | `removeItem` removes exactly 1 — multi-consume needs N calls | API quirk | ✅ v1.7.219 (count param) |
| 3 | `addItem(id, count)` accepts any number (including negative / NaN) | defensive | ✅ v1.7.219 (validation) |
| 4 | No `getItemCount(id)` / `hasItem(id)` helpers — callers read `playerInventory[id]` directly | API gap | ✅ v1.7.219 |
| 5 | No quantity cap (NES capped at 99) | design call | ⏸ deferred — depends on MMO scope |
| 6 | No gil cap in gameplay (only the `/gil` chat cheat caps at 999999) | design call | ⏸ deferred — depends on MMO scope |
| 7 | Sell price = `floor(buy/2)` — verified NES-faithful | clean | ✅ no action |
| 8 | Monster drop rate (25% per mob, first hit wins) | tunable | ⏸ doc-only |

## #1 — `ps.gil` mutations are inline (no helper)

Found 8 sites mutating gil directly:
- `shop.js:286` — buy item
- `shop.js:312` — buy spell
- `shop.js:332` — sell item
- `battle-update.js:493, 530, 648` — victory rewards (PVP, encounter,
  boss)
- `map-triggers.js:125` — chest gil
- `chat.js:220` — `/gil` cheat (capped at 999999)
- `title-screen.js:710` — load slot

Compare with `grantExp(amount)` (player-stats.js:208) and
`grantCP(amount)` (player-stats.js:295) — both are helpers with
clamps. Gil is the odd one out.

**Fix shape (v1.7.219):** add `grantGil(amount)` and
`spendGil(amount)` helpers in `player-stats.js`. Returns the
actual amount granted/spent. No cap yet (see #6 deferred), but the
single seam is in place for the websocket layer to hook.

## #2 — `removeItem(id)` removes exactly 1

Pre-v1.7.219 signature `removeItem(id)` always decremented by 1.
Multi-consume sites (none today, but future "drink 3 potions" or
"feed 5 fish" wouldn't exist) would have to loop. Worse, the
contract is asymmetric with `addItem(id, count)` — adders take a
count, removers don't.

**Fix:** `removeItem(id, count = 1)`. Validates count, clamps to
inventory count (no negative inventory), deletes entry if zeroed.
Returns actual removed count.

## #3 — `addItem` accepts garbage

```js
export function addItem(id, count) {
  playerInventory[id] = (playerInventory[id] || 0) + count;
}
```

Pre-v1.7.219:
- `addItem(id, -5)` would subtract 5 (bypass `removeItem`'s clamp).
- `addItem(id, NaN)` would NaN the count.
- `addItem(id, '5')` would string-concat ("0" + "5" = "05").

In practice all callers pass positive integers, but the multiplayer
seam will see broadcasted deltas from less-trusted sources.
Defensive validation is cheap.

**Fix:** validate `Number.isFinite(count) && count > 0`; coerce to
integer with `Math.floor`. Negative / zero / NaN counts return 0 (no-op).
Returns actual added count.

## #4 — No `getItemCount` / `hasItem` helpers

Callers read `playerInventory[id]` directly throughout the codebase.
Single seam for "do you have this item" doesn't exist. Future
multiplayer code reading remote inventories needs the same shape.

**Fix:** export `getItemCount(id)` and `hasItem(id)` helpers from
`inventory.js`. Wraps the lookup; consistent return shape (0 not
undefined for `getItemCount`).

## #5 — No quantity cap (deferred)

`addItem` has no upper bound. A player can theoretically have
arbitrarily many of any item. NES capped at 99. For an MMORPG —
per memory `feedback_ff3mmo_own_thing.md`, ff3mmo is its own game,
not a port — uncapped might be intentional.

If you want NES caps, `MAX_ITEM_QTY = 99` + clamp in `addItem` is a
2-line patch. Flag if you want it.

## #6 — No gil cap (deferred)

Same shape as #5. `/gil` cheat caps at 999999 (`chat.js:220`) but
normal gameplay doesn't. For multiplayer with potential trading /
shared markets, an overflow ceiling matters more — but it depends on
the economy design (which doesn't exist yet).

`grantGil` / `spendGil` in v1.7.219 are the seam to add a cap when
the design lands.

## #7 — Sell price = `floor(buy/2)` — verified clean

`shop.js:53`: `function sellPrice(item) { return item && item.price > 0 ? Math.floor(item.price / 2) : 0; }`. Items without
price aren't sellable (no -> sell). NES-faithful.

## #8 — Monster drop rate

`battle-update.js:541`:
```js
if (validDrops.length && Math.random() < 0.25) {
  battleSt.encounterDropItem = validDrops[Math.floor(Math.random() * validDrops.length)];
  break;
}
```

25% per-monster, **first hit wins**. So in a 4-mob encounter:
- P(no drop) = 0.75^4 = 0.316 → 31.6%
- P(some drop) = 0.684 → ~68%

That's fine and intentional — encourages multi-mob encounters.
Document only.
