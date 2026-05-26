# Inventory mirror — dup-vector audit + rollout plan

**Status:** Audit complete (2026-05-26). No code shipped. This doc captures
the dup-vector surface and a phased path to a server-canonical inventory
mirror, the only mechanism that genuinely closes the holes. Smaller
hardening fixes (rate limits, audit logs, save delta sanity checks) are
catalogued below but explicitly out of scope for this plan — they're
forensic and detection-grade, not preventive.

Reference: this doc is the long-form for the [[ff3mmo-beta-hardening]]
note. Pre-existing limitations (trade trust model v1.7.598, save trust
model since launch) are still documented in those memories — the mirror
replaces them.

---

## Audit findings — current dup-vector surface

### V-A — Trade (`case 'trade-offer'` in `ws-presence.js`)

Server validates `itemId` is 0-255, looks up `ITEMS.get(itemId)`, and
blocks `'key'`-type items (v1.7.616). It does NOT validate the sender
actually owns the item. A scripted client can loop:

```
for each target in onlinePlayers:
  trade-offer { targetUserId, itemId: 0xDE }   // Sage Staff
  await trade-result
```

Each acceptance lands a real Sage Staff in a recipient's inventory.
Sender pays nothing. Type whitelist limits the highest-tier exploit
(can't dup quest items / keys) but everything else is open.

**Current defenses:** `tradeLog` writes every offer + outcome to the
`trades` SQLite table (v1.7.616). Forensic only — pattern detection on
that log can catch abusers after the fact. No real-time prevention.

### V-B — Give-item (`case 'give-item'` in `ws-presence.js`)

Same trust model as trade. Sender consumes locally, server relays the
heal/cure effect to the target. Sender can fire give-item at N targets
in parallel; N recipients receive heal effects, sender claims to have
spent one item. Lower impact than V-A because recipients get the EFFECT,
not the item — but it's still cost-free duplication of consumables.

**No audit log currently.** Trades have one; give-item does not.

### V-C — Save sync (`POST /api/save`, `_validateSaveData`)

The biggest hole. `_validateSaveData` clamps every value to a structurally
valid range but never asks "did you earn this?". A client can POST a save
with:

| Field | Limit | Exploit |
|---|---|---|
| `inventory: { 0x14: 99 }` | 99 per slot, 64 slots | 99 of any item, including legendary gear |
| `gil: 999999` | 0-999999 | Max gil at level 1 |
| `unlockedJobs: 0xFFFFFFFF` | 32-bit mask | Every job unlocked |
| `knownSpells: [...]` | 64 entries | Full spellbook |
| `cp: 999999` | 0-999999 | Max CP |
| `stats: { weaponR: 0xDE, ... }` | 0-255 | Equip Sage Staff without owning one |

On next load, `serverLoadSaves` returns this and the client adopts it.
The client is effectively the source of truth for its own progression.

### V-D — Profile broadcast (`case 'update'`)

Server clamps weaponR/L/head/body/arms to 0-255 but doesn't cross-check
against inventory. Lying about equipped gear is cosmetic for peers'
roster rows, but the co-op AI-ally model regenerates an ally's stats
from the wire profile — so a cheating player inflates their own ally's
stats on every other client's screen during co-op battles. PvP is
disabled (see [[ff3mmo-pvp-disabled]]) so the worst-case (real PvP
cheating) is dead code.

### V-E — Cross-device replay

V-C with extra steps. Login on device A with a cheated save → save POSTs
to server → login on device B → server returns the cheated save → device
B adopts it. Solved naturally once V-C is closed.

---

## Why a server-side inventory mirror is the only real fix

The forensic + rate-limit fixes catalogued below close *some* of the
scriptability but don't change the fundamental architecture: **the
client is the source of truth for game state**. Every defense short of
a mirror is a heuristic — pattern detection, anomaly flagging, delta
sanity checks. They make dup harder to script and easier to investigate.
They don't prevent it.

A server-canonical inventory mirror means: every state mutation is a
server-validated event. Client requests it, server applies it (or
rejects with a corrective push). Save sync becomes a snapshot of server
state, not a client-side write. Trade resolution happens on the server,
not on trust.

Trade-off: latency, offline-play, dev cost (~3-6 weeks careful rollout).
None of those are deal-breakers; they're the cost of a real fix.

---

## Phased rollout plan

The goal is to avoid a flag-day flip — every phase is shippable on its
own and the system stays functional throughout. Each phase has a
rollback path (flip a feature flag, server reverts to trust-model).

### Phase 0 — Foundation (read-only mirror)

**Goal:** server tracks every player's canonical inventory state in
SQLite, but doesn't enforce it yet. Used for diff-detection against
incoming saves (forensic).

**Schema:**
```sql
CREATE TABLE inventories (
  user_id   INTEGER NOT NULL,
  item_id   INTEGER NOT NULL,
  qty       INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id)
);
CREATE TABLE economies (
  user_id      INTEGER PRIMARY KEY,
  gil          INTEGER NOT NULL,
  cp           INTEGER NOT NULL,
  exp          INTEGER NOT NULL,
  level        INTEGER NOT NULL,
  unlocked_jobs INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE TABLE equipped (
  user_id  INTEGER PRIMARY KEY,
  weapon_r INTEGER, weapon_l INTEGER,
  head     INTEGER, body     INTEGER, arms INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE TABLE known_spells (
  user_id  INTEGER NOT NULL,
  spell_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, spell_id)
);
```

**Seed:** read every existing save in `saves` table, populate mirror from
the client-asserted data. (Yes, we trust V-C-style cheaters for the seed.
That's the cost of bootstrapping a mirror on existing data; future
mutations get validated.)

**Behavior:** every incoming save also writes a snapshot to mirror tables.
No rejection yet; logged warnings if save and mirror diverge by more
than reasonable deltas.

**Risk:** schema is invasive. Migration path needs care.

**Rollback:** drop the tables. Nothing else changes.

### Phase 1 — Authoritative inventory mutations (wire deltas)

**Goal:** every inventory change generates a server-validated `inv-event`.
Server applies to mirror, then pushes the corrective state if the
client's local state diverges.

**Substructure — Phase 1a / 1b / 1c:** the work splits along the
risk-vs-deploy-size axis. 1a lands the wire scaffold + handler in shadow
mode (logs only, never rejects). 1b flips a flag so the server starts
rejecting events that don't match mirror state. 1c (multi-session)
migrates the remaining ~30-40 client call sites onto the wire. Each
sub-phase is independently shippable and rolls back via flag flip.

**Phase 1a deliverables** (v1.7.741):
- `inv-event` + `inv-state` wire shapes defined and stable
- Server handler that validates bounds, applies to mirror, logs
  divergence in shadow mode (`INV_MIRROR_AUTHORITATIVE = false` server-
  side)
- Client `sendNetInvEvent` + `setNetInvStateHandler` exports
- Hello payload extended with active `slot` so the server knows which
  (userId, slot) to apply events to
- ONE real call site migrated (chest open) — fires the event in
  ADDITION to the existing `addItem` call, gated on the flag.
  Flag-off: wire fires, server logs, no behavior change.
- Wire-sim regression tests for the roundtrip + bounds validation

**Phase 1b** (future, NOT YET SAFE — see prerequisite): flip
`INV_MIRROR_AUTHORITATIVE = true`. Server starts rejecting events that
don't match mirror state (e.g. "you claimed to remove a Sage Staff you
don't have"). Server pushes `inv-state` back on rejection. Client
wholesale-replaces local state from the push.

**Phase 1b prerequisite (discovered v1.7.742):** `/api/save`'s mirror
sync (`mirrorSyncFromSave`) wholesale-replaces the wire-managed fields
(inventory / equipped / spells / gil). With both Phase 1c migration
AND the existing save sync writing the mirror, race conditions are
possible: client uses Potion → fires wire `remove`, then
`saveSlotsToDB()` posts /api/save. WS and HTTP arrive at the server in
either order. If save arrives first, it sets mirror inventory to N-1
(post-mutation count from the just-written save), then the wire event
decrements again to N-2 — mirror under-counts by 1. Harmless in shadow
mode (just logs); catastrophic with enforcement (next legitimate
remove falsely rejected).

To make Phase 1b safe, EITHER:
- (Partial Phase 4) Stop `mirrorSyncFromSave` from touching the
  wire-managed fields when `INV_MIRROR_AUTHORITATIVE_SERVER = true`.
  Wire becomes sole writer; save sync covers metadata only
  (currentMapId, lastTown, playTime, etc.). ~20 lines.
- (Full Phase 4) Save endpoint becomes a snapshot of the server's
  mirror state. Client save data ignored for wire-managed fields.
  Larger surface area; pairs naturally with Phase 1b flip.

Until one of these lands, Phase 1b stays deferred. Phase 1a + 1c
(shadow mode with full wire coverage) is the right resting state for
gathering production divergence data without breaking players.

**Phase 1c+** (future, multi-session): migrate the remaining mutation
sites. Audit identifies them at: `addItem` (chest/loot/shop/levelup/use),
`removeItem` (use/trade/equip), `setEquipSlotId` (equip menu),
`grantSpell` (scroll use / level-up), gil/cp/exp deltas in player-stats.

**Wire shapes (frozen as of Phase 1a):**

```js
// Client → server
// kind defines the mutation; source is a free-text reason field used
// for divergence logging + future rejection messaging. itemId/qty
// semantics depend on kind.
{
  type:   'inv-event',
  kind:   'add' | 'remove' | 'equip' | 'unequip' | 'gil-delta',
  itemId: <0-255>,           // ignored when kind === 'gil-delta'
  qty:    <integer>,          // signed for 'gil-delta', else positive
  source: 'chest' | 'shop' | 'loot' | 'use' | 'trade' |
          'levelup' | 'equip-swap' | 'scroll' | 'other',
  slot?:  <0-2>,              // optional; server falls back to entry.slot
}
```

```js
// Server → client (corrective state push)
// Sent on rejection in Phase 1b, on hello in 1c-onward (replaces the
// existing /api/saves load for inventory fields). Carries the full
// mirror snapshot for the active slot so the client can replace its
// local state wholesale.
{
  type:        'inv-state',
  slot:        <0-2>,
  inventory:   { <itemIdHexOrDecimal>: qty, ... },
  gil:         <integer>,
  cp:          <integer>,
  exp:         <integer>,
  unlockedJobs: <uint32>,
  equipped:    { weaponR, weaponL, head, body, arms },
  knownSpells: [spellId, spellId, ...],
  jobLevels:   { <jobIdx>: { level, jp }, ... },
  reason?:     'rejected' | 'hello-sync' | 'post-restore',
}
```

**Slot-tracking convention:** the `hello` profile (and subsequent
`update` frames) carries `slot` as a normal field — server stashes it
on `entry.slot`. Subsequent `inv-event` frames apply to that slot by
default; an explicit `slot` in the event payload overrides (used when
the client changes active save mid-session).

**Pre-1a scaffold doc — read this in any 1b/1c session before adding code:**
```js
// Client → server (corrective push if rejected)
{ type: 'inv-state', inventory: {...}, gil, equipped: {...} }
```

**Server logic:**
- `add`: validate `source` is plausible (chest/loot ID exists, shop transaction logged, etc.)
- `remove`: validate player has the qty
- `equip`: validate item is in inventory + slot type matches
- Apply to mirror, broadcast result

**Client logic:**
- Existing `addItem` / `removeItem` paths route through `sendInvEvent`
- On `inv-state` arrival, replace local inventory wholesale (trust-but-verify → server-wins)

**Risk:** every inventory operation now needs a server round-trip.
Latency on chest opens / loot drops. Mitigation: optimistic local apply,
server correction is rare on legitimate gameplay.

**Rollback:** feature flag `INV_MIRROR_AUTHORITATIVE`; off → server logs
divergence but doesn't reject.

### Phase 2 — Loot/shop/quest events

**Goal:** server rolls all server-canonical economy events itself, not
trust the client's rolled outcome.

**Loot:** client sends `loot-roll { mapId, coord, tier }`. Server validates
the tile is rollable (not on cooldown), rolls from the canonical loot
table with seeded RNG, applies to inventory mirror, pushes result. Client
adopts. Replaces the client-rolled `rollLootEntry` path.

**Shop:** client sends `shop-buy { itemId, qty }`. Server validates gil >=
price, applies inventory + gil to mirror, pushes corrective state.

**Quest rewards:** server triggers (event-driven from quest completion,
which becomes server-tracked too — much bigger lift, defer to a later
phase).

**Risk:** loot is a hot path. Server load needs measurement. Mitigation:
batch rolls per encounter, cache loot tables in memory.

**Rollback:** flag `LOOT_SERVER_ROLLED`; off → client rolls and reports.

### Phase 3 — Trade resolution on server

**Goal:** trade is server-resolved. `trade-offer` reserves the item from
sender's mirror; `trade-accept` moves it to recipient. No more "did you
have it" trust.

**Schema:** `trade_pending` row carries the reserved item id + qty;
ledger entry on accept moves it. Rollback on decline/timeout/disconnect.

**Risk:** distributed-systems edge cases — what if sender disconnects
mid-trade after the reservation? Need timeout cleanup. (Already exists
in `_pendingTrades` server-side; expand to handle the mirror reservation
too.)

**Rollback:** flag `TRADE_SERVER_RESOLVED`; off → existing trust model.

### Phase 4 — Save sync becomes a read

**Goal:** `POST /api/save` snapshots the server's mirror, not the
client's data. Client save data becomes display-only metadata
(currentMapId, lastTown, playTime).

**`_validateSaveData` shrinks** to just metadata fields. Combat / item /
gil / equipment / job fields all come from mirror tables.

**Client save-state.js:** `serverLoadSaves` returns mirror-derived data,
not the saved JSON. Local IndexedDB save becomes a fallback for offline
play only.

**Risk:** legacy save compatibility — what about saves written before
the mirror existed? Phase 0's seed handles this. After Phase 4, the
client-asserted save fields are ignored.

**Rollback:** keep `_validateSaveData` as-is for one more release, then
deprecate.

### Phase 5 — Anti-cheat enforcement on `update`

**Goal:** `case 'update'` cross-checks broadcast equipment/stats against
the mirror's `equipped` table. Mismatch → reject with corrective push.

**Risk:** breaks legitimate clients that haven't fully migrated.
Mitigation: phase 5 ships AFTER phase 1-4 so all paths use the mirror.

### Phase 6 — Cleanup

**Goal:** remove the trust-model fallback paths. `inventoryOrder` /
`knownSpells` / `unlockedJobs` come from server. Audit logs (`trades`,
`give_items` if added) preserved as forensic trail. Save tables
shrink. Documentation updated.

---

## Forensic + rate-limit fixes (out of scope for the mirror, but cheaper)

If we want intermediate hardening before committing to the mirror:

| Fix | Vector | Effort | Real impact |
|---|---|---|---|
| Log give-item to `give_items` table | V-B | ~15 lines | Forensic only |
| Per-target trade rate limit (3/min/target) | V-A | ~20 lines | Slows scripted spam, doesn't stop |
| Per-target give-item rate limit | V-B | ~20 lines | Same |
| Save delta sanity check (gil/level jumps) | V-C | ~50 lines | False-positive risk |
| Equipped-vs-inventory cross-check in `_validateSaveData` | V-C | ~30 lines | Blocks "equip Sage Staff without owning" |

These were enumerated for completeness. Mirror plan supersedes all but
the audit logs, which become forensic complements even after the mirror
ships.

---

## Recommendation

**Tier 1 (now):** ship none of the small fixes. Document the surface
(this doc) and the limitations in [[ff3mmo-beta-hardening]]. Continue
the open beta with the existing forensic audit log (trade table) and
the type whitelist.

**Tier 2 (if dup abuse surfaces):** ship the small fixes incrementally
as needed. Each is independently useful and rolls back cleanly.

**Tier 3 (when ready for "no dup" guarantee):** commit to the mirror.
Phase 0 + 1 alone close V-A and V-B; Phase 4 closes V-C/V-E. Phase 5
closes V-D. Estimated 3-6 weeks for a careful rollout.

**Trigger for Tier 3:** either (a) observed dup abuse in `trades` log,
or (b) decision to flip PvP back on (V-D becomes load-bearing for fair
PvP), or (c) launch out of open beta.
