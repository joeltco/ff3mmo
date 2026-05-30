# PvE + economy rewrite — server-validated replay architecture

**Status:** P-0 design doc landing v1.7.771. Replay-validate (not full FSM); see "Why replay-validate" below. Arc covers PvE, shops, chests, vases, inn. Follows the PvP arbiter (`docs/PVP-REWRITE-PLAN.md`) but uses a different shape because PvE is single-player + frequent (50+ fights/session) and full server FSM would add unacceptable latency.

Design landed 2026-05-29 after the inventory mirror (v1.7.740-746) closed the item-dup vectors. The next biggest client-trusted surface was the **save delta** (exp/cp/gil/level/job-CP/spell-learn) which the client asserts after every battle. This arc closes that — and the shop/chest/inn surfaces that grant the same currencies.

## Current status

**SHIPPED + LIVE** v1.7.779. Outcome-validate model. Chest + vase client gating landed v1.7.780 (validate-only model, swapped from server-roll). Happy-path regression added v1.7.782 (wire-sim 114/114). Hotfixes v1.7.781 (victor derivation) + v1.7.783 (movement gate during request).

| Phase | Version | Status |
|---|---|---|
| P-0 design doc | v1.7.771 | ✅ shipped |
| P-1 seed remaining RNG sites | v1.7.771 | ✅ shipped |
| P-2 pve-arbiter.js skeleton + encounter gen | v1.7.772 | ✅ shipped |
| P-3 client encounter handshake | v1.7.773 | ✅ shipped |
| P-4 per-turn intent buffer | v1.7.774 | ✅ shipped |
| P-5 server replay engine (outcome-validate) | v1.7.775 | ✅ shipped |
| P-6 end-of-battle validation + delta apply | v1.7.775 | ✅ shipped |
| P-7 drop validation | v1.7.775 | ✅ folded into P-5/P-6 |
| P-8 server shop catalog | v1.7.776 | ✅ shipped |
| P-9 shop-transaction wire | v1.7.776 | ✅ shipped |
| P-10 chest + vase server endpoints | v1.7.777 | ✅ shipped (server-roll model — superseded) |
| P-11 inn-rest endpoint | v1.7.777 | ✅ shipped (`INN_REGISTRY` empty; bed-rest is free) |
| P-12 wire-sim regression coverage | v1.7.778 / v1.7.782 | ✅ shipped (114/114) |
| **P-13 FLAG FLIP** | **v1.7.779** | **✅ LIVE — all 4 flags ON** |
| P-10b chest + vase client gating (validate-only) | v1.7.780 | ✅ shipped — swapped server-roll → claim-validate |
| HOTFIX victor derivation | v1.7.781 | ✅ shipped (live-fire fix) |
| HOTFIX movement gate during request | v1.7.783 | ✅ shipped |

**Bed-rest deliberately skipped.** Beds in this game are free (`src/bed.js` — refills HP/MP, no gil). Zero currency leverage = no exploit surface; `INN_REGISTRY` stays empty until a paid inn lands.

### Flag landscape (LIVE as of v1.7.779)

| Flag | File | State |
|---|---|---|
| `PVE_ARBITER` (server) | `ws-presence.js` | `true` |
| `PVE_ARBITER` (client) | `src/net.js` | `true` |
| `SERVER_ECONOMY` (server) | `ws-presence.js` | `true` |
| `SERVER_ECONOMY` (client) | `src/net.js` | `true` |

**Rollback** = flip all four back to `false` + redeploy. Mirror + saves are forward-compatible.

---

## Why replay-validate (not full server FSM)

The PvP arbiter is a full server FSM because both players are adversaries — every turn must round-trip the server so neither can fudge a roll. PvE doesn't have that constraint: the player is alone, the "opponent" is server-spawned AI, and there's nothing to time-fudge. The only thing we need to enforce is **outcome integrity**: the deltas the client claims (exp/gil/items/HP) must match what would actually have happened given the server-chosen monsters + RNG seed.

**Replay-validate flow:**
1. Client requests encounter → server picks monsters, formation, RNG seed, records pre-state snapshot, returns `pve-battle-start`.
2. Client runs battle locally with provided seed (zero latency, render unchanged).
3. Each turn, client emits `pve-intent` for the round it just played (intent log for audit + replay input).
4. On battle end, client emits `pve-battle-end` with claimed outcome.
5. Server replays seed + intents through shared `battle-math` → compares replayed outcome vs claim.
6. Match → server applies deltas to user save row, broadcasts `pve-battle-result` (canonical post-state).
7. Mismatch → server rejects, logs `[pve divergence]`, force-resyncs save to server truth.

**Wins vs full FSM:**
- Zero added latency per turn (battle plays at native speed).
- No render rewrite (existing `battle-draw-*.js` paths untouched).
- ~10x less wire traffic.
- Battle-math determinism work is already 90% done from PvP arbiter (`opts.rand` injection in `battle-math.js`).

**Risks:**
- Any battle-math non-determinism = false-positive divergence. Mitigation: P-1 audits + seeds the remaining `Math.random` sites; wire-sim suite includes deterministic round-trip tests.
- Battle takes N seconds; a cheater could submit a forged outcome immediately, before the server can react. Mitigation: server holds the seed + pre-state — the only way to forge is to match the math exactly, which means actually running the math, which is the same cost as playing the game honestly. Cheating the replay means *re-deriving the canonical outcome and then changing it* — server detects every change.

---

## Architecture (one paragraph)

Server holds per-battle state keyed by `battleId`: monsters + formation + RNG seed + pre-state snapshot of party (HP/MP/inv/gil/exp/cp/level/job state) + intent log. Client requests encounter, runs battle locally with server seed, buffers per-turn intents and submits at end. Server replays the same seed + intents through `pve-replay.js` (a Node-clean wrapper around `battle-math` + `spell-cast` + `status-effects`) and compares the resulting party post-state + drop to the client's claim. On match, server applies deltas to the `saves` row + inventory mirror + broadcasts canonical result. Same pattern for shops/chests/inn: client requests, server validates + applies + broadcasts.

---

## File layout

### New
- **`pve-arbiter.js`** (root, Node-clean ESM) — battle FSM holder. `createPveBattle`, `recordIntent`, `validateAndApply`, `cancelBattle`. Mirrors `pvp-arbiter.js` shape.
- **`pve-replay.js`** (root, Node-clean ESM) — pure replay function. `replayBattle({preState, monsters, seed, intents}) → {postState, drop, deltas}`. Imports `battle-math` + `spell-cast` shared modules.
- **`economy-arbiter.js`** (root, Node-clean ESM) — shop/chest/vase/inn validation + delta apply. `validateShopTransaction`, `validateChestOpen`, `validateVaseSearch`, `validateInnRest`.
- **`src/data/shop-catalog.js`** — Node-clean shop tables (lifted from `src/data/shops.js`). Re-exported by `shops.js` so client renders unchanged.
- **`src/data/loot-pools.js`** — Node-clean LOOT_POOLS extracted from `src/map-triggers.js`. Same re-export pattern.
- **`src/pve-client.js`** — client wrapper. Sends `pve-encounter-request`, holds intent buffer, sends `pve-intent` + `pve-battle-end`, applies `pve-battle-result` to ps.

### Modified
- **`src/battle-encounter.js`** — `tickRandomEncounter` gates on `PVE_ARBITER`; flag-on path calls `pveRequestEncounter()` instead of `startRandomEncounter()`.
- **`src/battle-update.js`** — encounter end-of-battle delta apply gates on flag (`PVE_ARBITER` off = current local apply; on = wait for `pve-battle-result`).
- **`src/shop.js`** — buy/sell calls gate on `SERVER_ECONOMY`.
- **`src/map-triggers.js`** — chest open / vase hit gate on `SERVER_ECONOMY`.
- **`src/data/beds.js` + inn handlers** — gate on `SERVER_ECONOMY`.
- **`ws-presence.js`** — new wire handlers: `pve-encounter-request`, `pve-intent`, `pve-battle-end`, `shop-transaction`, `chest-open`, `vase-search`, `inn-rest`. New emits: `pve-battle-start`, `pve-battle-result`, `pve-cancel`, `shop-result`, `chest-result`, `vase-result`, `inn-result`.
- **`api.js`** — `_applyPveDeltas(userId, deltas)` helper that does the atomic save-row update (mirrors trade audit pattern).

---

## Wire protocol

All frames carry `battleId` (for PvE) or `txnId` (for economy) so the response can be scoped to the request.

### PvE — encounter handshake

**Client → server:**
```js
{ type: 'pve-encounter-request',
  zoneKey,                              // 'grasslands_wild' / 'altar_cave_f1' / etc.
  mapId,                                // for server-side zone-allowed check
  worldX, worldY,                       // for server-side zone-allowed check (overworld only)
  partyState: [                         // current party for snapshot (ps + allies)
    { userId?, slot, hp, mp, statusMask, status }  // server validates against mirror
  ] }
```

**Server → client:**
```js
{ type: 'pve-battle-start',
  battleId,                             // uint32, server-assigned
  rngSeed,                              // uint32, drives _encounterRng + all battle rolls
  monsters: [                           // server-rolled formation + counts
    { monsterId, hp, maxHP, atk, attackRoll, def, evade, mdef, exp, gil,
      hitRate, spAtkRate, attacks, level, agi, statusAtk, atkElem,
      weakness, resist, statusResist, spiritInt } ],
  // any other server-rolled facts the client needs to render the same battle
}
```

```js
// Server-initiated cancel (e.g. validation failed pre-battle, server overloaded).
{ type: 'pve-cancel', battleId, reason: 'validation-failed' | 'server-overload' | 'error' }
```

### PvE — per-turn intent

**Client → server:**
```js
{ type: 'pve-intent',
  battleId,
  turnIdx,                              // monotonic per-battle
  kind: 'attack' | 'magic' | 'item' | 'defend' | 'flee',
  actorSlot,                            // 0 = ps, 1-3 = allies
  targetMonsterIdx?, targetSlot?,       // depends on kind
  spellId?, itemId?,
  rngSnapshot?                          // optional — RNG cursor at intent-start, for divergence diagnostics
}
```

(Intents are batched per turn; client may also send the whole array at battle-end. Implementation choice in P-4.)

### PvE — end of battle

**Client → server:**
```js
{ type: 'pve-battle-end',
  battleId,
  intents,                              // full ordered array (in case some pve-intent frames dropped)
  claimedOutcome: {
    victor: 'party' | 'wipe' | 'fled',
    party: [ { slot, hp, mp, statusMask } ],
    monsters: [ { idx, hp } ],           // dead monsters carry hp:0
    drop: { itemId, qty } | null,
    expGained, cpGained, gilGained,
    jobJpGained, levelUps?, jobLevelUps?,
    spellsLearned?                       // [spellId, ...]
  } }
```

**Server → client:**
```js
{ type: 'pve-battle-result',
  battleId,
  canonical: <claimedOutcome shape>,    // server's replayed truth (== claim on match)
  status: 'applied' | 'rejected',
  reason?                               // when rejected
}
```

Server applies `canonical` deltas to the user save row + inventory mirror atomically. On rejection, client gets `status: 'rejected'` + server force-resyncs save state.

### Shops

**Client → server:**
```js
{ type: 'shop-transaction',
  txnId,                                // client-supplied; uniqueness + reply matching
  shopMapId,                            // map shop is rooted at
  counterX, counterY,                   // shop counter coords (identifies catalog)
  action: 'buy' | 'sell',
  itemId, qty
}
```

**Server → client:**
```js
{ type: 'shop-result',
  txnId,
  status: 'ok' | 'rejected',
  reason?,
  gilAfter,                             // server-canonical
  invDelta? : { itemId, qty }           // for client-side mirror reconcile
}
```

### Chests + vases

**Client → server:**
```js
{ type: 'chest-open',  txnId, mapId, x, y }
{ type: 'vase-search', txnId, mapId, x, y }
```

**Server → client:**
```js
{ type: 'chest-result' | 'vase-result',
  txnId,
  status: 'ok' | 'rejected' | 'empty' | 'mimic',
  reason?,
  drop?: { itemId, qty } | { gil } | { monster: monsterId },
  consumedAt                            // server-canonical timestamp
}
```

### Inn

**Client → server:**
```js
{ type: 'inn-rest',
  txnId,
  mapId, counterX, counterY,            // identifies inn (price lookup)
}
```

**Server → client:**
```js
{ type: 'inn-result',
  txnId,
  status: 'ok' | 'rejected',
  reason?,
  gilAfter, party: [ { slot, hp, mp, statusMask } ]
}
```

---

## Server FSM (per PvE battle)

```js
{
  battleId,
  userId,                               // single-player only — battle belongs to one user
  createdAt,
  rngSeed,                              // seed; engine uses createRng(seed) on replay
  zoneKey, mapId,
  monsters: [ ...spawned ],             // canonical
  preState: {                           // snapshot at battle-start
    party: [ {slot, hp, maxHP, mp, maxMP, statusMask, status, stats, equipped, ...} ],
    gil, exp, cp, level, jobIdx, jobLevels, jobJp, spellsKnown, inv
  },
  intents: [ ...recorded ],
  status: 'in-progress' | 'ended',
  endedAt?                              // GC after 5min idle
}
```

5-minute idle TTL; ended battles GC'd immediately after `pve-battle-result` ACK.

---

## Determinism audit (P-1 scope)

`Math.random` sites that affect gameplay outcome and must be swapped to seeded RNG:

| File | Line | What | Fix |
|---|---|---|---|
| `src/battle-update.js` | 846 | `_dropRand = Math.random` for drop rolls | Use `battleSt._rand()` (set at battle-start) |
| `src/battle-turn.js` | 132 | Confused-target pick | Use `battleSt._rand()` |
| `src/battle-turn.js` | 214 | Ally auto-target pick | Use `battleSt._rand()` |
| `src/pause-menu.js` | 906 | In-menu healing spell roll | Use `rand()` from `src/rng.js` singleton |
| `src/battle-encounter.js` | 58 | Step-threshold jitter | **Keep `Math.random`** — purely client-side trigger timing, not outcome |
| `src/battle-encounter.js` | 147, 171, 183 | Formation + monster count picks | Move server-side (P-2) |

`map-triggers.js` chest/vase/loot rolls become server-side at P-10; their `Math.random` usage gets superseded then.

Audio/sprite/animation `Math.random` (`slash-effects.js`, `npc.js`, `title-screen.js`, etc.) is cosmetic and stays untouched.

---

## Phased plan

### P-0 — design doc (this doc, v1.7.771)

### P-1 — seed remaining RNG sites
- Swap the 4 sites above to seeded RNG.
- Verify `tools/battle-sim.js` produces identical traces for the same seed.

### P-2 — `pve-arbiter.js` skeleton + encounter generation
- New root module, Node-clean. `createPveBattle(userId, {zoneKey, mapId, worldX, worldY, partyState}) → {battleId, rngSeed, monsters}`.
- Server `_pickEncounterMonsters(zoneKey, rng)` mirrors `startRandomEncounter`'s formation pick using the seeded RNG.
- Server snapshots party pre-state from `users` + `inv_equipped` + client `partyState` payload (validates HP/MP against server-side mirror).
- New `_pveBattles` Map keyed by battleId; 5-minute TTL.
- Wire handlers in `ws-presence.js` for `pve-encounter-request` / `pve-intent` / `pve-battle-end`.
- Stub `validateAndApply` to no-op + always-accept for the first integration test.

### P-3 — client encounter handshake
- New `src/pve-client.js` — `pveRequestEncounter()`, `pveHandleBattleStart(frame)`.
- `src/battle-encounter.js#_triggerEncounterWithPVPCheck` gets a `PVE_ARBITER` branch: instead of `startRandomEncounter()`, call `pveRequestEncounter()`.
- On `pve-battle-start` arrival: client calls `startRandomEncounterFromServer(monsters, rngSeed)` (new wrapper) which sets `battleSt._rand = createRng(rngSeed).rand` + skips the local formation roll.
- Existing PvP-search check stays — PvP hook takes precedence over PvE arbiter.

### P-4 — per-turn intent buffer
- `pve-client.js` buffers `{kind, actorSlot, target..., spellId?, itemId?}` per turn as the local battle runs.
- Emit at battle-end (one big batch in `pve-battle-end`). Optional: per-turn emit for divergence-early-detection (defer until P-5 lands).

### P-5 — server replay engine
- New `pve-replay.js`. Pure function `replayBattle({preState, monsters, seed, intents})`.
- Walks through turns: for each turn, sort by AGI + seeded tiebreak, dispatch each combatant's intent through shared battle-math/spell-cast modules (using `createRng(seed).rand` injected via `opts.rand`).
- Handles physical attacks, dual-wield, magic, items, status ticks, death, level-up, job-CP, drop rolls.
- Returns canonical post-state.
- Unit-tested standalone (no WS dep) via new `tools/pve-replay-sim.js`.

### P-6 — end-of-battle validation + delta apply
- Server `validateAndApply(battleId, claim)` calls replay engine, compares result.
- On match: write `users.gil`, `users.exp`, `users.cp`, `users.level`, `users.job_levels`, `users.spells_known` (whichever fields exist; new fields added to `users` table via migration as needed), apply inv mirror events for drop. Broadcast `pve-battle-result` with `status: 'applied'`.
- On mismatch: log `[pve divergence battleId=... claim=... canonical=...]`. Send `status: 'rejected'` + a save-resync frame (existing `setNetSaveResyncHandler` infrastructure if present, else new `pve-save-resync`).
- Client `setNetPveBattleResultHandler` applies the canonical (overwriting local) — even on match, server's word is final to keep state synchronized.

### P-7 — drop validation
- Replay engine rolls drops from the same seed cursor the client uses, so claim parity already covers drops.
- Server emits the `add` inventory mirror event for the drop only after the result is `applied` (not from the client's `sendNetInvEvent` path).
- Client `_dropRand` swap + the `sendNetInvEvent('add', dropItemId, 1, 'loot')` call become viewer-only mirror calls under the flag.

### P-8 — server shop catalog
- Extract price tables from `src/data/shops.js` into Node-clean `src/data/shop-catalog.js`. Original file re-exports for client compatibility.
- Server-side `findShopByCounter(mapId, x, y) → {inventory, sellMult}`.

### P-9 — `shop-transaction` wire + atomic update
- `src/shop.js` buy/sell branches: when `SERVER_ECONOMY`, instead of `addItem`+`grantGil`, send `shop-transaction` and wait for `shop-result`.
- Server validates: counter coord matches a shop, item is in shop catalog, player has gil (buy) or item (sell), inv has space (buy).
- Atomic SQLite txn updates `users.gil` + emits mirror inv event.
- On `shop-result` `ok`: client applies the canonical gil + inv delta. On `rejected`: client shows "Cannot complete" SFX + reverts UI.

### P-10 — server chest + vase loot
- Extract `LOOT_POOLS` from `src/map-triggers.js` into Node-clean `src/data/loot-pools.js`.
- Server `validateChestOpen(userId, mapId, x, y)`: check map has a chest at that coord (server holds map → chest-coord registry — extracted from existing client-side chest data), check `ps.consumedTiles[mapId][coord]` doesn't already exist or is expired (read from save row), roll loot from `LOOT_POOLS[mapId]` with per-battle RNG, mark consumed in save row, broadcast.
- Same shape for `validateVaseSearch` — uses `HIDDEN_TREASURE_HIT_CHANCE` + cooldown logic, runs server-side.

### P-11 — server inn-rest
- Inn registry — Node-clean map of `(mapId, counterX, counterY) → price`. Lifted from existing client inn handlers.
- Server `validateInnRest(userId, mapId, x, y)`: check inn exists, player has gil, deduct, restore HP/MP across party, broadcast.

### P-12 — wire-sim regression coverage
- New `tools/pve-wire-sim.js` (or extend `tools/pvp-wire-sim.js`).
- Suites: encounter handshake parity (client + server roll the same formation given the same seed), intent submission + replay match, replay mismatch (forge a higher exp claim, expect server reject), shop buy + sell, chest open, vase search, inn rest.
- Add to `deploy.sh` pre-flight.

### P-13 — FLAG FLIP + ship
- Flip all four flags.
- Live smoke: one wild encounter, one Ur magic-shop purchase, one chest, one vase, one inn rest, one death-and-respawn (verify post-defeat save state matches server).
- Bump version, CHANGELOG, deploy, memory update.

---

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Battle-math non-determinism causes false-positive divergence | P-1 audits + seeds every gameplay RNG site; wire-sim parity tests gate every change to battle-math/spell-cast |
| Bigger save-write traffic (server-side update per battle) | Save writes already happen on every battle (existing `saveSlotsToDB`); just moves source. Atomic SQLite txn keeps it cheap |
| Replay engine drifts from live engine over time | Replay imports the SAME `battle-math.js` + `spell-cast.js` modules client uses — single source. Any drift = lint error / wire-sim failure |
| Cheater submits forged outcome immediately on battle-start (no real play) | Server replays from seed + intents. Forged outcome means forged intent log — but the intent log has to produce the claim, which means actually computing it. No shortcut |
| Inn / shop / chest server-side check breaks for legitimate players (e.g. de-synced consumedTiles) | First `pve-battle-result` after the flag flip overwrites local with server-canonical; persistent divergence reports get the `[pve divergence]` log line for grep |
| Drop ordering subtle bugs (e.g. server picks drop from monster A, client from B) | Use the SAME `_dropRand` loop order; replay engine processes drops via the exact same code path as client |
| Encounter request adds 100-300ms before battle wipe | Acceptable — the existing PvP-encounter check already adds 2.5s fallback. PvE request is fire-and-forget with optimistic battle-flash start; if server is slow we just delay the formation reveal a beat |

---

## Out of scope (deferred)

- **PvE replay log persistence** — `pve_battles` SQLite table for post-hoc audit. Would let us catch cheaters even when replay matches by aggregating odd patterns. Defer to a separate observability arc.
- **Server-side party-member action validation** — co-op AI allies are deterministic from server seed, so their actions are validated as part of the main replay. True multi-human-party PvE (where each human picks for one combatant) would need a different wire shape — not on the roadmap.
- **Quest reward grants** — NPCs that grant items via dialogue. Not in scope; covered by inventory mirror's `give` event today, which is already server-validated.
- **Crystal reveal / map-trigger one-shots** — `defeat-Land-Turtle → crystal` is a sequence flag, not currency. Stays client-driven; server save schema only mirrors `ps.gameProgress` for now.

---

## Pairs with

- [[ff3mmo-pvp-arbiter-rewrite]] — PvP is full server FSM (different model, same prerequisites)
- [[ff3mmo-dup-vectors]] — inventory mirror is the prerequisite; this arc extends the closure to currency/exp surfaces
- [[ff3mmo-multiplayer-arch]] — gets a new section at P-13 covering PvE arbiter + economy arbiter
