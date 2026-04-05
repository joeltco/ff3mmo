# game.js Refactor TODO

Current size: **3,065 lines** (v1.3.2). Target: <4,000 lines — **achieved**.

---

## Next Up

No high-value extractions remaining. Remaining candidates are in "Evaluated — Not Worth It" or "Hard" below.

---

## Evaluated — Not Worth It

### ~~Canvas cache consolidation (~40 vars → 1 object)~~
Evaluated: 47 canvas vars, ~300 refs across 8 files, 110+ shared context getters.
Converting `let x = null` → `spriteCache.x: null` saves **zero lines** and touches
250–300 sites. High risk, no benefit.

### ~~`battleCtx` grouping (~40 battle vars → 1 object)~~
Evaluated: 35 mutable vars, ~867 refs across 8 files.
Net line savings: ~0 (same keys inside an object). High architectural value
for *future* battle-state module extraction, but not justified without a concrete
follow-up. Revisit when extracting a battle engine module.

---

## Hard (deeply coupled, needs architectural redesign)

- [ ] Split `_processBossFlash()` (49L) → `_targetAllyForAttack`, `_calculateAllyDamage`, `_calculatePlayerDamage`
- [ ] Group raw globals (L46–704, ~620L) into state objects — blocked by shared context overhead

---

## Won't Extract (too entangled)

- ~~Roster draw/update (357L)~~ — **extracted** to `src/roster.js` (v1.3.1). Shared context pattern worked.
- Title update logic (139L) — entangled with game state (ps, playerInventory, saveSlots, map loading)
- Full rendering core — canvas state too entangled
- Battle state machine — needs architectural redesign first

---

## Completed

<details>
<summary>Easy Wins (all done)</summary>

- [x] `src/chat.js` (~150L)
- [x] `src/message-box.js` (~100L)
- [x] `src/title-screen.js` (~300L)
</details>

<details>
<summary>Medium (all done)</summary>

- [x] `src/input-handler.js` (~674L)
- [x] `src/pause-menu.js` (~400L)
- [x] `src/transitions.js` (~250L)
- [x] `src/map-triggers.js` (254L)
</details>

<details>
<summary>Phase 2 (done items)</summary>

- [x] `src/pvp-math.js` (~30L) — grid layout + cell center shared by game.js + pvp.js
- [x] `src/battle-sfx.js` (~15L) — `playSlashSFX` replaced 3 inline copies
- [x] `src/battle-drawing.js` (~1,236L) — biggest single win. 40+ draw helpers extracted.
</details>

<details>
<summary>Phase 3 (done items)</summary>

- [x] `src/battle-ally.js` (~123L) — `updateBattleAlly` + 5 helpers. `_allyShared()` in game.js. Net: −83L.
- [x] `src/battle-enemy.js` (~76L) — `_processEnemyFlash` + `_updateBattleEnemyTurn`. `_enemyShared()` in game.js.
- [x] `src/battle-items.js` (~150L) — `startMagicItem`, `updateMagicItemThrowHit`, target/damage. `_magicItemShared()` in game.js.
- [x] `src/damage-numbers.js` (~102L) — All dmg/heal state, palettes, tick, reset, draw. Miss sprite from ROM $1B4D0/$1B4E0.
</details>

<details>
<summary>Phase 4 — final push (4,208→3,388L)</summary>

- [x] `src/sprite-init.js` (~636L) — 37 pure init functions: battle sprites, portraits, full-body canvases, goblin, adamantoise, invincible, moogle, cursor, fade frames. ROM in → canvases out. Net: −674L.
- [x] `src/flame-sprites.js` (~153L) — Flame/star tile decode, palette rendering, sprite positioning. Net: −135L.
- [x] `src/save-state.js` (~83L) — Centralized save slot state. Direct imports replace shared context proxying. Net: −67L.
- [x] Player select + title update → `title-screen.js` — slot cursor, name entry, underwater animations. Net: −79L.
- [x] `_syncSaveSlotProgress` dedup — Merged into `saveSlotsToDB()`. Net: −10L.
- [x] `startRandomEncounter` dedup — Replaced 15 manual resets with `_resetBattleVars()`. Net: −12L.
- [x] Gil + proficiency persistence fix — was missing from DB serialization and parse.
</details>
