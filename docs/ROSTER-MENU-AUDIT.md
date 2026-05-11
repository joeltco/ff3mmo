# Roster player-menu audit

Started 2026-05-11. Sweep of the per-player menu that opens off the
roster panel (Z on a roster row → 5-item action menu). Maps each
menu item's wiring, the state machine that drives it, and the
seams that the eventual websocket layer will hook into.

Roster opens with `S`. Press Z on a row to open the action menu;
the 5 items are **Party / Battle / Trade / Message / Inspect**
(`ROSTER_MENU_ITEMS` in `input-handler.js:64` AND `roster.js:32` —
see #3). State machine: `'none' → 'browse' → 'menu-in' → 'menu' →
'menu-out'` (`inputSt.rosterState`).

## TL;DR

| # | Item | Class | Status |
|---|------|-------|--------|
| 1 | **Empty-roster null-deref** — pressing Z on an empty roster crashes on `target.name` | crash bug | ✅ v1.7.221 |
| 2 | **`menu-out` ↔ `msgState` race** — Battle's two-stage message can leave roster in `browse` overlaid by a message | state-machine bug | ✅ v1.7.221 |
| 3 | **`ROSTER_MENU_ITEMS` defined twice** (input-handler.js + roster.js) | dedup | ✅ v1.7.221 |
| 4 | **Cursor target can drift mid-menu** — if a roster member fades out while the menu is open, Z dispatches the wrong target | input correctness | ✅ v1.7.221 |
| 5 | Party / Trade / Message / Inspect are stubs — render an `Action⏤Name` message and dismiss | by-design (v0) | ⏸ deferred per `MULTIPLAYER.md` |
| 6 | Battle gate `(onWorldMap \|\| dungeonFloor >= 0)` blocks PVP in town — correct, but worth documenting | spec clarity | ⏸ note |
| 7 | Roster can be opened while chat is expanded (typing-mode is blocked, just expanded isn't) | minor input-gate gap | ⏸ low |
| 8 | "Challenged X!" → 1.5-2.5s gap → "X accepted!" leaves roster visible during PVP intro | UX timing | ✅ obsoleted by Battle redesign (v1.7.222+) |

## Battle action redesign (v1.7.222–v1.7.226)

Findings #6 (Battle precondition) and #8 (instant accept feels
wrong) drove a full redesign of the **Battle** action. The old
"Challenged X! → 1.5-4s delay → X accepted! → battle" flow was
replaced with a **search-and-hook** mechanic — full spec lives in
`src/pvp-search.js` and `MULTIPLAYER.md`. Summary:

- Pick **Battle** → persistent "Searching for X..." message stays
  on screen. Roster row shows "Searching..." marquee (50 px/s,
  seamless wrap) in place of Lv/HP. Menu label flips
  `Battle` → `Cancel` for the same target.
- Background: target rolls a hook check every 8-15 s on a sim
  timer. Hook chance = `clamp(0.25 + (chAGI − tgtAGI) × 0.015 +
  jobBonus, 0.10, 0.75)`. Thief +0.15, Ranger +0.08.
- On hook → message swaps in-place to "Connecting..." (via
  `replaceMsgBoxText` — no slide flicker), auto-advances after
  1000 ms → battle.
- Z is inert during "Searching..." (the message *is* the search);
  X (back) forfeits and replaces it with "Cancelled".
- 5-min real-time timeout / 3-missed-in-a-row cap / 60 s per-target
  cooldown after any close.

Battle precondition (#6) now applies to *search start* only —
search persists across map changes; only *resolution* re-checks
`(onWorldMap || dungeonFloor >= 0)`. Cancel works from anywhere.

## Action dispatch matrix

| Action | Precondition | Handler | Status |
|--------|--------------|---------|--------|
| Party | none | `showMsgBox("Party⏤<name>")` | ⏸ stub |
| Battle | `mapSt.onWorldMap \|\| mapSt.dungeonFloor >= 0` | `_rosterMenuDuelAction(target)` → 2-stage msg → `_startPVPBattle` | ✅ live |
| Trade | none | `showMsgBox("Trade⏤<name>")` | ⏸ stub |
| Message | none | `showMsgBox("Message⏤<name>")` | ⏸ stub |
| Inspect | none | `showMsgBox("Inspect⏤<name>")` | ⏸ stub |

Code path for stubs: `input-handler.js:714-720` (generic fallback —
action label byte-encoded, `0xFF` separator, target name, single
`showMsgBox`). No callback, no follow-up state.

## #1 — Empty-roster null dereference

`_rosterInputMenu` at `input-handler.js:706-720` does:

```js
if (_zPressed()) {
  const action = ROSTER_MENU_ITEMS[inputSt.rosterMenuCursor];
  const target = getRosterVisible()[inputSt.rosterCursor];   // ← can be undefined
  inputSt.rosterState = 'menu-out';
  ...
  if (action === 'Battle' && ...) {
    _rosterMenuDuelAction(target);            // dereferences target.name at line 684
  } else {
    const actionBytes = _nameToBytes(action), nameBytes = _nameToBytes(target.name);
    ...                                       // ← TypeError when target is undefined
  }
}
```

Entry into `browse` at `input-handler.js:741-745` does NOT check that
`getRosterVisible().length > 0`. So in any location with no fake
players present (and none currently fading out), the sequence:

1. Press `S` → `rosterState = 'browse'`, `rosterCursor = 0`.
2. Press `Z` → `rosterState = 'menu-in'` (no target check).
3. Press `Z` again on the menu → `target = undefined` → crash.

Today this is masked by Ur being populated with the fake `PLAYER_POOL`,
but the world map / dungeon floors / Altar Cave can have zero visible
players at any given moment when the fake-mover RNG has drifted
everyone elsewhere.

**Fix sketch:** gate browse entry on `getRosterVisible().length > 0`
at line 741, AND short-circuit `_rosterInputMenu`'s Z-press if `target`
is falsy (return to browse silently or play a CURSOR_DENY sfx).

## #2 — `menu-out` / `msgState` race in Battle action

`_rosterMenuDuelAction` (`input-handler.js:682-692`) shows two
sequential messages:

```js
showMsgBox(challengeMsg, () => {
  setTimeout(() => showMsgBox(...accepted!..., () => _startPVPBattle(target)),
    1500 + Math.floor(Math.random() * 2500));
});
```

Meanwhile the menu-out animation in `drawRosterMenu`
(`roster.js:346-354`) terminates by reading `msgState`:

```js
if (t >= 1) { inputSt.rosterState = msgState.state !== 'none' ? 'none' : 'browse'; ... }
```

During the 1500–4000 ms gap between the "Challenged X!" close and
the "X accepted!" open, `msgState.state === 'none'`. If the
menu-out slide (150 ms) completes during that gap — and it almost
always does, since menu-out starts the same frame as the challenge
message and 150 ms ≪ 1500 ms — then `rosterState` returns to
`'browse'` even though the PVP intro is still in flight.

The user is then dropped back into roster-browse with a message
about to appear on top, can scroll the cursor, and may even press
`Z` again on a different row before the "accepted!" message lands.
If they do, a second `_rosterMenuDuelAction` enqueues — and the
first one's onClose fires `_startPVPBattle(target1)` regardless.

**Fix sketch:** `_rosterMenuDuelAction` should set
`inputSt.rosterState = 'none'` explicitly (don't auto-return to
browse), since the next state legitimately owned by the user is
the PVP battle that's about to start. The `msgState !== 'none' ?
'none' : 'browse'` check at `roster.js:353` becomes dead for this
path and only matters for the stub actions (where it works fine —
stubs use one short message).

## #3 — `ROSTER_MENU_ITEMS` defined twice

```
src/input-handler.js:64   const ROSTER_MENU_ITEMS = ['Party', 'Battle', 'Trade', 'Message', 'Inspect'];
src/roster.js:32          const ROSTER_MENU_ITEMS = ['Party', 'Battle', 'Trade', 'Message', 'Inspect'];
```

`input-handler.js` reads it for cursor wrap (`% .length`) and action
dispatch (`[cursor]` → `action`). `roster.js` reads it for menu height
(`length * 14 + 16`) and label render. A rename or reorder in one
file silently desynchronizes draw vs. dispatch.

**Fix sketch:** export from `roster.js` (where it lives next to the
other roster constants), `import` into `input-handler.js`. Same
pattern as `BATTLE_TEXT_STEPS` consolidated in v1.7.220.

## #4 — Cursor target can drift mid-menu

`_clampRosterCursor` (`roster.js:91`) is only called from
`_updateFadeTicks` when a fading-out player's fade *completes* and
they are removed from `getRosterVisible()` (line 205). That update
runs every frame regardless of `rosterState`.

Scenario:
1. 3 players visible. Cursor at index 2 (bottom row). Press Z →
   menu opens. `target` not yet read.
2. Fake-mover RNG picks the bottom player; `_rosterStartFadeOut`
   begins. Player is still in `getRosterVisible()` during the
   fade (`fadingOut` branch at `roster.js:77-79`).
3. Fade completes (`ROSTER_FADE_STEPS` × `ROSTER_FADE_STEP_MS` ≈
   ~500 ms). Player drops out of visible. `_clampRosterCursor`
   clamps `rosterCursor` from 2 → 1.
4. User picks Battle / presses Z. `getRosterVisible()[1]` is now
   a *different* player than the one whose row the cursor was
   originally over.

Not a crash — but the user just challenged the wrong person to
PVP. Subtle and reproducible.

**Fix sketch:** stash `target` at menu-in entry (`input-handler.js:670`)
into a new `inputSt.rosterMenuTarget` and read from there in
`_rosterInputMenu`. Clears at `menu-out` completion.

## #5 — Party / Trade / Message / Inspect are stubs

Confirmed intentional per `MULTIPLAYER.md` — full implementations
require the websocket layer (chat relay for Message, inventory sync
for Trade, party-invite protocol for Party, stat panel rendering for
Inspect). For v0 the stub renders `<Action>⏤<TargetName>` and dismisses.

No bug. But the code reads as a generic fallback in the dispatch
branch (`input-handler.js:714-720`); a comment marking each one as
"// stub — see MULTIPLAYER.md Step N" would prevent future-Claude
from mistaking the catch-all for an intentional handler. Optional.

## #6 — Battle gate is correct (not a bug; noting for spec)

`if (action === 'Battle' && (mapSt.onWorldMap || mapSt.dungeonFloor >= 0))`
at `input-handler.js:712`. `mapSt.dungeonFloor` defaults to `-1`
(`map-state.js:25`) and is only set to a non-negative value inside
the Altar Cave dungeon. So Battle is blocked in Ur (town) — selecting
it from a town-roster falls through to the stub. This is correct,
just non-obvious from the predicate. A constant like `_canPVP(loc)`
would read better.

## #7 — Roster can open over expanded chat

`handleRosterInput` entry gate at `input-handler.js:741` does not
check `chatState.expanded`. The `keydown` listener at line 43 does
block all keys when `chatState.inputActive` (typing in chat), but
expanded-not-typing is a permissive state. Pressing `S` while chat
is expanded opens the roster on top of the chat overlay.

Likely fine — chat is decorative when expanded — but worth a
`!chatState.expanded` clause if the visual stack becomes an issue.
Low priority.

## #8 — Roster visible during PVP intro

The two-message Battle flow holds the user on the roster panel for
1500–4000 ms after Z-press: challenge message → random delay →
accept message → `_startPVPBattle`. The roster fades to black during
`battleState !== 'none'` (`roster.js:_updateBattleFade`), but
`battleState` doesn't flip until the second message's `onClose` fires.

Is the gap intentional flavor (simulated network round-trip)? With
real WebSocket challenges it'll become structurally necessary, but
the random `1500 + rand*2500` reads as placeholder for now.

**Open question:** when the websocket layer lands, replace the
`setTimeout(rand)` with the actual challenge-relay RTT — but keep a
floor (e.g. 600 ms) so the visual sequence doesn't snap-to-battle
on a fast LAN connection.

## Fake-vs-real seam summary

What today's roster menu would need when the fake `PLAYER_POOL` is
swapped for a real connected-player list:

| Item | Today works because | What changes |
|------|---------------------|--------------|
| Browse / cursor | `PLAYER_POOL` filtered by `loc` is the source | Replace `PLAYER_POOL` reads in `getRosterVisible` / `getPlayersAtLocation` with the websocket roster cache |
| Battle | `target` has `name/jobIdx/level/weapon*/armor/helm/shield/palIdx` — read by `generateAllyStats(target)` (`pvp.js:111`) | Real roster entries must carry the same fields; `JOB-EXP-AUDIT.md` already confirmed `generateAllyStats` is deterministic on these inputs |
| Party / Trade / Message / Inspect | stubs | Each needs its own websocket message type (`party-invite`, `trade-request`, `chat-direct`, `inspect-request`) |
| State machine | Local-only; no race with network | Add `'menu-awaiting-server'` state between menu-out and result message for Party/Trade/Battle (handshake confirmation before flow commits) |

## Followups (deferred)

- **Trade UI** — needs inventory-overlay design + server arbitration. Not in `MULTIPLAYER.md` Step 1-3 scope.
- **Inspect panel** — natural fit for the existing pause-menu equip
  inspector. Could land as a single-player feature first (inspect roster
  in Ur) without the websocket layer.
- **Party** — requires a party state machine (separate from the
  roster). Deferred indefinitely.
- **Direct Message** — chat.js already has tabs; a `to:<name>`
  whisper would be cheaper than a full party system.
