# PvP rewrite — server-arbitrated battle architecture

**Status:** Shipped P-0 through P-9 across v1.7.747–v1.7.757. Flags went LIVE v1.7.758, then PvP was **DISABLED again v1.7.770** pending P-6d anim polish + P-4c magic/items — `PVP_ENABLED` flipped back to `false` (both server + client) + "Battle" removed from the roster action menu. Arbiter path stays armed (`PVP_ARBITER_SERVER` + `PVP_ARBITER` remain `true`) so re-enable is a 3-edit flip: both `PVP_ENABLED` flags + restoring the menu item. See "Current status" below.

Design landed 2026-05-26 after the inventory mirror project (v1.7.740-746) shipped the prerequisite — server-canonical equipped stats mean the server can spawn combatants with authoritative stat profiles for the first time.

## Current status

| Phase | Version | Status |
|---|---|---|
| P-0 design doc | v1.7.747 | ✅ shipped |
| P-1 server scaffold | v1.7.747 | ✅ shipped |
| P-2 combatant generation | v1.7.748 | ✅ shipped |
| P-3 Node-clean math + per-battle RNG | v1.7.749 | ✅ shipped |
| P-4 turn resolution (physical only) | v1.7.750 | ✅ shipped |
| P-4b multi-hit attacks | — | deferred |
| P-4c magic + items (server-side resolve) | — | deferred (blocks P-5b smart-magic-AI + P-6d magic visuals) |
| P-4d 15s intent watchdog | — | deferred |
| P-5 smart AI (target weakest, panic defend) | v1.7.751 | ✅ shipped |
| P-5b magic AI | — | deferred (waits for P-4c) |
| P-6 client viewer state mirror | v1.7.752 | ✅ shipped |
| P-6b legacy-state adapter (render bridge) | v1.7.753 | ✅ shipped |
| P-6c anim driver (attack + death) | v1.7.754 | ✅ shipped |
| P-6d anim polish (HP sync, ally dmg, defend pose, magic/item visuals) | — | deferred |
| P-7 input rewire to `sendNetPvpIntent` | v1.7.755 | ✅ shipped |
| P-8 name strip — attacker / target only | v1.7.756 | ✅ shipped |
| P-9 matchmaking wire + client bootstrap | v1.7.757 | ✅ shipped |
| Flag-flip deploy | v1.7.758 | ✅ shipped (all 4 → true) |
| Live 2-phone smoke | v1.7.758-770 | ✅ ran — surfaced P-6d/P-4c roughness as blockers |
| **DISABLED again** | **v1.7.770** | **both `PVP_ENABLED` → false; arbiter flags stay true** |
| P-6d anim polish (HP sync, ally dmg, defend pose, magic visuals) | — | NEXT — gates re-enable |
| P-4c magic + items (server-side resolve) | — | NEXT — gates re-enable |
| P-10 cleanup (rip lockstep code) | — | post-re-enable + soak |

### Flag landscape (current as of v1.7.785)

| Flag | File | Current value |
|---|---|---|
| `PVP_ENABLED` (server) | `ws-presence.js:110` | `false` (v1.7.770) |
| `PVP_ARBITER_SERVER` | `ws-presence.js:120` | `true` (v1.7.758) |
| `PVP_ENABLED` (client) | `src/pvp-search.js:51` | `false` (v1.7.770) |
| `PVP_ARBITER` (client) | `src/net.js:821` | `true` (v1.7.758) |

**Re-enable = 3 edits:** flip both `PVP_ENABLED` flags back to `true` + restore the `'Battle'` row in the roster action menu. Arbiter wires are already armed; no other changes needed.

**Hard rule:** mismatched `PVP_ENABLED` states softlock — keep the two in sync. Arbiter flags can stay on even when `PVP_ENABLED` is off (no-op without a battle to start).

### Known visible roughness for live smoke (P-6d backlog)

- HP bar snaps to post-round value while damage numbers play (adapter writes pvpSt.HP at end-of-round; anim driver doesn't gate per-delta)
- My-side ally damage numbers missing (`allyDamageNums[idx]` shape unused)
- Defend pose doesn't fire (the `state defend-on` delta dwells in silence)
- Magic / item intents log `kind=magic not yet implemented` and waste the turn (P-4c gate)
- Name strip cuts cleanly between attacker/target but FSM-driven text from legacy paths may briefly appear during transitions

---

PvP was disabled in v1.7.502 because client-side lockstep can't sync two
phones (same disease as co-op, see [[ff3mmo-pvp-disabled]]). The co-op
rewrite picked **host-authoritative deltas** (v1.7.474, currently live).
PvP can't use the same model — neither player should be the "host" because
they're adversaries. PvP needs the **server** as the authoritative
arbiter.

This doc is the long-form spec. Read before touching any `pvp-arb.*` /
`pvp.js` / `pvp-search.js` / `pvp-drawing.js` code.

---

## Architecture

**Server-arbitrated battle FSM.** Server runs the entire battle loop:
- Holds combatant state (HP, MP, status, realized stats)
- Sole RNG source for the battle
- Receives intents from both humans, resolves turn order by AGI
- Picks actions for non-human party members (server-side AI)
- Broadcasts deltas to both clients

Clients are **viewers** that render the battle state + emit one intent
per human turn. No lockstep, no synced seeds, no pre-rolled bandaids.

### Why server-arbitrated (not host-arb like co-op)

Co-op has a natural host (the room owner / party leader). PvP doesn't —
both players are equal adversaries. If we picked one as the host:
- Host could fudge their own rolls (always crit)
- Trust asymmetry breaks the "fair fight" premise

Server-arbitrated has none of those problems. The CPU cost is small
(PvP is rare; battle FSM is ~5KB per match; even 100 concurrent matches
is 500KB).

### Why mirror was the prerequisite

Server needs authoritative stats to spawn combatants. Before the
inventory mirror (Phases 1b + 5), the server had no idea what equipment
each player had — it would have had to trust the client's broadcast
profile (which V-D let cheaters lie about). With mirror live, the
server reads `inv_equipped` + `saves` table + computes the same
`generateAllyStats` shape both clients already use. Single source of
truth, no cheating possible.

---

## Combatant rules (new — per user spec 2026-05-26)

Each side has:
- **1 human-controlled main player** (the userId who initiated/accepted)
- **0-3 AI-controlled party members** (their current `partyInviteSt.partyMembers`)

Total: 1-4 combatants per side, 2-8 per battle. Asymmetric sides are
allowed — solo vs full party is a 1-vs-4 if both consent.

### Party gating decisions (locked):
- AI placement: **server-side** (single source, no client divergence)
- Matchmaking: **keep pvp-search hook** (challenger sends search, server
  hooks on opponent's next random encounter via AGI-differential roll —
  surprise factor preserved)
- Party gating: **any size** — match what each player has online
- Refactor scope: **new pvp-arb module, old pvp.js stays for now** behind
  a `PVP_ARBITER` flag, rip lockstep code in a separate cleanup deploy
  after the flag flips

### UI changes (per user spec):
- **Enemy name box only displays the attacker / target.** Not a static
  "here are all 4 enemies at once" list. As turn order progresses, the
  name strip cuts to the active attacker; on player target selection,
  shows the highlighted target.
- Existing `pvpGridLayout` (1→4 cells, dynamic) stays for the visual
  layout of enemy sprites; just the NAME strip behavior changes.

---

## Wire protocol

All frames carry `battleId` so reconnect can scope state correctly.

### Server → both clients

#### `pvp-battle-start`
```js
{
  type:       'pvp-battle-start',
  battleId:   <uint32>,
  yourSide:   'A' | 'B',
  yourCellId: <0-7 global cell id>,       // your main player's cell
  sides: {
    A: [
      { cellId, name, jobIdx, level, palIdx, isHuman,
        userId?, stats: { hp, maxHP, mp, maxMP, atk, def, agi, vit, int, str,
                          mdef, evade, hitRate, shieldEvade, weaponR, weaponL, ... } },
      ...
    ],
    B: [ ... ],
  },
  rngSeed:    <uint32>,                   // server-side; clients use for ANIMATION rolls only
}
```

Stats come from mirror + ps. Server runs `generateAllyStats`-equivalent
on the server-side ps shape (built from `saves` row merged with mirror).

#### `pvp-turn`
```js
// One frame per resolved turn. `deltas` is an ordered list — clients
// animate them sequentially. `nextActor` tells both clients who's up
// next (drives the attacker name strip + intent prompt).
{
  type:     'pvp-turn',
  battleId,
  turnIdx,
  deltas:   [ <delta>, <delta>, ... ],
  nextActor: { cellId, isHuman, userId? } | null,   // null = battle ended
}
```

Delta shapes (extensible — start with the minimum, add as phases land):
```js
// Physical attack
{ kind: 'attack', actorCellId, targetCellId, damage, hit, crit, hand: 'R'|'L' }
// Magic cast
{ kind: 'magic', actorCellId, spellId,
  targets: [ { cellId, damage?, heal?, status?, miss? }, ... ] }
// Item use
{ kind: 'item', actorCellId, itemId, targetCellId, heal?, status? }
// Status tick (poison, etc.)
{ kind: 'status-tick', actorCellId, statusKind, damage }
// Death cue (visual only — actor already at hp:0 from a prior delta)
{ kind: 'death', actorCellId }
// State change (defend, sleep wake, etc.)
{ kind: 'state', actorCellId, change: 'defend-on' | 'defend-off' | 'wake' }
// End of battle
{ kind: 'end', victor: 'A' | 'B' | 'draw', xpReward?, gilReward? }
```

#### `pvp-cancel`
```js
// Server-initiated cancel (disconnect, timeout, error). Both clients
// tear down. Difference from pvp-end: not a victor outcome.
{ type: 'pvp-cancel', battleId, reason: 'opponent-disconnect' | 'timeout' | 'error' }
```

### Client → server

#### `pvp-intent`
```js
{
  type:     'pvp-intent',
  battleId,
  turnIdx,                              // server rejects stale-turn intents
  kind:     'attack' | 'magic' | 'item' | 'defend' | 'flee',
  targetCellId?: <0-7>,                 // required for attack/magic/item
  spellId?:      <0-255>,               // required for kind='magic'
  itemId?:       <0-255>,               // required for kind='item'
}
```

Server validates:
- `battleId` matches an active battle the client is in
- It's actually this client's turn (or the AI server-side decides)
- `targetCellId` is a live combatant (hp > 0)
- For magic/item: client owns the spell/item (mirror check)
- For magic: MP cost satisfied

Rejection → server sends a corrective `pvp-state-resync` with the full
battle state (rare path).

### Reconnect / state recovery

Client hello may carry `battleId` if it was mid-battle. Server checks
its active-battles map; if found and the client's userId is still in it,
server replays the current state via:
```js
{ type: 'pvp-state-resync', battleId, /* same shape as pvp-battle-start, +
  current turnIdx + any in-flight delta queue */ }
```

---

## Server FSM (per battle)

```js
{
  battleId,
  createdAt,
  turnIdx,                          // monotonic
  rngState,                         // server-internal seed
  status: 'awaiting-intent' | 'resolving' | 'ended',
  pendingIntents: Map<userId, intent>,
  combatants: [
    { cellId, side, isHuman, userId?, name, jobIdx, palIdx,
      stats: { ...realized },
      hp, mp, statusMask,
      defending: false,
      asleep: false,
      ... },
    ...
  ],
  watchdogTimer,                     // 60s — if any human goes unresponsive
                                     // we end the battle as 'opponent-disconnect'
}
```

### Turn loop
1. **Collect intents.** Server marks `status: 'awaiting-intent'`. For each
   human cell that's alive + not asleep, server waits for their `pvp-intent`
   frame (15s timeout per intent → server picks 'defend' as fallback).
   For each non-human cell that's alive + not asleep, server-side AI picks
   immediately.
2. **Resolve.** `status: 'resolving'`. Sort by combatant AGI (with random
   tiebreak via server RNG). For each combatant's intent:
   - Run battle math (existing `battle-math.js` ported Node-clean)
   - Append delta(s) to the turn log
   - Update combatant HP/MP/status
   - If any side has all combatants at hp:0 → break out, emit `end` delta
3. **Broadcast `pvp-turn`** with the ordered deltas + `nextActor`.
4. **Status ticks.** End-of-round poison etc. as separate deltas in the
   SAME `pvp-turn` frame (after the action deltas).
5. **Loop** until `kind: 'end'` delta sent.

### AI logic
Port from existing `battle-ally.js#_pickAllyAction` (currently used in
co-op). Reuse verbatim if possible — server reads its own combatant
state, picks a target by priority, returns intent. Must be Node-clean
(no DOM / canvas / Audio imports).

---

## Client (viewer) integration

### New module: `src/pvp-arb-viewer.js`
- Consumes `pvp-battle-start` / `pvp-turn` / `pvp-state-resync` / `pvp-cancel`
- Walks `deltas[]` per turn, drives animations via existing helpers
  (slash overlay, spell-anim, damage-num, etc.)
- Sends `pvp-intent` on human turn (existing input handling, but
  `pvpAction` → `pvpEmitIntent` instead of pre-rolling)

### `src/pvp.js` (existing — kept for rollback)
Behind the `PVP_ARBITER` flag (default `false` while developing):
- Flag off: existing lockstep path (broken but the code is there).
- Flag on: input handlers route to `pvpEmitIntent`; render pulls from
  the viewer's state instead of `pvpSt.*`.

After flag flip + 1 week soak, separate cleanup deploy rips the lockstep
fields out of `pvpSt`, drops the bandaid `damageRoll`/`healAmount`/
`hitResults` from the `pvp-action` relay, etc.

### Name strip change (new requirement)
`battle-msg.js`'s enemy name display currently fires on encounter start
+ on enemy-flash. For PvP under the arbiter:
- On `pvp-turn` arrival: name strip cuts to the new `nextActor`'s name.
- On player target selection (already a UI state): name strip shows
  the highlighted target's name.
- No persistent "here are 4 enemies" list view.

This is a behavioral change to the strip's update triggers, not a layout
rewrite. The 16-char/3-line constraints (see
[[ff3mmo-message-box-realestate]]) still apply.

---

## Phased plan

Phase numbering matches the eventual git/CHANGELOG record. Each phase
is independently shippable behind the flag.

### P-0 — design doc (this doc, v1.7.747)
- This file.
- No code change.

### P-1 — server scaffold + wire shapes
- Create `pvp-arbiter.js` (Node-clean, importable by ws-presence)
- New wire handlers: `pvp-intent`, `pvp-state-resync`
- New server emits: `pvp-battle-start`, `pvp-turn`, `pvp-cancel`
- Stub FSM that creates a battle on demand and immediately ends it with
  a no-op `pvp-turn` — proves the roundtrip
- `PVP_ARBITER` flag in `src/net.js` (default `false`); both client and
  server gate on it
- Wire-sim tests for the scaffold (battle creation, intent rejection on
  wrong turn, state-resync shape)

### P-2 — combatant stat generation on server
- Server-side `buildCombatantFromUser(userId, slot)` reads mirror +
  saves row, returns the realized stat block matching the client's
  `generateAllyStats` output exactly
- Asserted via wire-sim parity test: client `generateAllyStats(profile)`
  === `buildCombatantFromUser(userId, slot)` for the same data
- Battle-start emit populates combatants from this

### P-3 — Node-clean battle math
- Audit `src/battle-math.js` — make every export Node-clean (no DOM/Audio
  imports). Most already are; lift any that aren't.
- Server imports + uses for damage/hit/status/heal math
- Wire-sim parity: client damage roll vs server damage roll for same
  RNG seed + inputs

### P-4 — turn resolution
- Server picks turn order (AGI-sort + random tiebreak)
- Walks each combatant's intent, runs math, appends deltas
- End-of-round status ticks
- Battle-end detection
- Wire-sim tests: full turn round-trip, AGI ordering, hit/miss/crit, magic
  damage, item heal, status inflict, death/end

### P-5 — server AI
- Port `_pickAllyAction` from `battle-ally.js`
- Server picks intents for non-human combatants
- Wire-sim tests: AI picks valid intent, AI targets enemy side (not own
  side), AI doesn't grief itself on heal items

### P-6 — client viewer module
- New `src/pvp-arb-viewer.js`
- Handlers for `pvp-battle-start` / `pvp-turn` / `pvp-state-resync` /
  `pvp-cancel`
- Renders from viewer state; reuses existing animations
- Old `pvp.js` lockstep code untouched

### P-7 — input rewire (intent emit)
- Pause-menu / target-select fires `pvpEmitIntent(...)` instead of
  pre-rolling locally
- Gated on `PVP_ARBITER`

### P-8 — name strip behavior change
- `battle-msg.js`: name display becomes `nextActor`-driven on PvP under
  the arbiter
- Target selection drives the same strip during player turn

### P-9 — FLAG FLIP + smoke
- `PVP_ARBITER = true` on both sides
- `PVP_ENABLED = true` in `pvp-search.js` (re-enabling PvP gameplay)
- Live two-phone smoke test
- Rollback = flip back to false

### P-10 — cleanup (post-soak)
- Rip lockstep fields from `pvpSt`
- Drop `damageRoll` / `healAmount` / `hitResults` from `pvp-action` relay
  (kept for legacy clients during transition; remove after soak)
- Update [[ff3mmo-pvp-disabled]] memory → [[ff3mmo-pvp-arbiter]]

---

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Battle math drift between client (animation timing) and server (damage truth) | Server is authoritative — clients animate the server's damage value. Client RNG is animation-only (frame jitter, miss-graphic position) — never affects state |
| Stat parity (client `generateAllyStats` vs server `buildCombatantFromUser`) | Wire-sim parity test in P-2 gates every change to either function |
| Server CPU under load | Negligible — PvP is rare; battle FSM is tiny. Add a metric in P-9 if concerned |
| Reconnect mid-battle | `pvp-state-resync` handler — server keeps battle state for the full battle; on hello with `battleId`, server replays |
| Watchdog timeouts kill legit slow players | 15s per intent + 60s for full unresponsiveness. UX prompt "your turn — 10s left" via existing message strip if needed |
| Server retains battle state forever if both clients disappear | 5-minute idle TTL on battle FSMs; ended battles GC'd immediately |

---

## Out of scope (deferred to future phases)

- **Spectator mode** — clients not in the battle viewing the deltas.
  Wire shapes are compatible; just needs a `pvp-spectate` join handler.
  Defer.
- **Replay** — battle log persistence + playback. Requires a `pvp_battles`
  SQLite table with delta-log column. Defer.
- **Match-making queue** — explicit "find me a PvP" queue independent
  of the search-hook. User explicitly chose to keep pvp-search-hook;
  defer queue mode.

---

## Pairs with

- [[ff3mmo-pvp-disabled]] — the v1.7.502 disable rationale this rewrite
  closes out.
- [[ff3mmo-coop-rebuild]] — host-arb model for co-op; PvP can't use it
  but the wire-delta pattern is the same.
- [[ff3mmo-multiplayer-arch]] — live MP architecture reference; gets
  updated when P-9 ships.
- [[ff3mmo-dup-vectors]] — the prerequisite project; mirror gives us
  authoritative stats for server combatant spawning.
