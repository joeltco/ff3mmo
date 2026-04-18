# game.js Refactor TODO

Current size: **912 lines** (v1.6.0). Target: <4,000 lines — **achieved** (53% under target).

---

## Next Up

No high-value extractions remaining. game.js at 912L is essentially a composition root — module init, callback wiring, top-level game loop. Further extraction would be cosmetic.

---

## Completed — Phase 6 (shared-bag refactor + final extractions)

<details>
<summary>Shared-bag elimination (14/14 bags retired)</summary>

- [x] `src/fake-player-sprites.js` — fake player canvases (Step 1)
- [x] `src/battle-sprite-cache.js` (60L) — `bsc` state object replaces canvas passing (Step 2)
- [x] `src/hud-state.js` (28L) — HUD render state (Step 3)
- [x] `src/map-state.js` (50L) — map/world state (Step 4)
- [x] `src/battle-state.js` (108L) — full battle state machine data (Step 5)
- [x] `src/ui-state.js` (30L) — misc UI state
- [x] 5 battle bags retired — `_magicItem`, `_encounter`, `_ally`, `_enemy`, `_turn`
- [x] 3 remaining battle bags retired — `_inputShared`, `_pvpShared`, `_battleDrawShared`
- [x] 3 non-battle bags retired — `hudDraw`, `loading`, `transDraw`
- [x] 3 final bags retired — `_pauseShared`, `_titleShared`, `_transShared`
</details>

<details>
<summary>Final game.js extractions (1,920L → 912L)</summary>

- [x] `src/battle-update.js` (732L) — complete battle state machine (opening, attack chain, defend/item, run, boss dissolve, victory/defeat, PVP)
- [x] `src/movement.js` (260L) — player movement, input dispatch, tile collision, action handling. Fixed pre-existing `MapRenderer`/`resetIndoorWaterCache` import bug in `_checkFalseWall`.
- [x] `src/title-screen.js` — `updateTitle` + `_updateTitleMainOutCase` merged in with shared `waterSt` ref
</details>

---

## Prior Phases

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

<details>
<summary>Phase 5 — HUD + map loading (3,083→2,695L)</summary>

- [x] `src/hud-drawing.js` (~349L) — HUD rendering, top box, portrait, info panel, utility draw helpers. `_hudDrawShared()` in game.js. Net: −388L.
- [x] `src/map-loading.js` (~223L) — map/dungeon/world loading, setupTopBox, spawn calc. `_mapLoadShared()` in game.js.
</details>
