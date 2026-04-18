# game.js Refactor TODO

Current size: **449 lines** (v1.6.0). Target: <4,000 lines — **achieved** (89% under target).

---

## Next Up

game.js at 449L is a composition root — imports, module wiring, boot/asset init, top-level game loop. Remaining code is genuine composition; no further extractions worth pursuing.

---

## Completed — Phase 8 (cleanup + small extractions)

<details>
<summary>game.js 679L → 449L (−230L, −34%)</summary>

- [x] **Dead-import audit** — removed 114 unused imports across 29 import lines. Examples: entire `battle-msg` suite (10 syms), entire `text-utils` suite (7 syms), most `player-stats` equipment helpers (13 syms), all weapon-sprites canvas getters, chat tab exports, title-screen draw fns, battle-encounter tickers, damage-numbers getters, etc.
- [x] **Breadcrumb purge** — ~55 stale `// X → module.js` migration comments and "retired" notes deleted.
- [x] **Dead constants/state** — `TOPBOX_FADE_STEPS`, `TEXT_WHITE_ON_BLUE`, `prePauseTrack`.
- [x] `initKeyboardListeners(keys)` → `input-handler.js` — moved `window.addEventListener('keydown'/'keyup')` block + chat hotkey logic.
- [x] `_updateHudHpLvStep` → `hud-drawing.js` as `updateHudHpLvStep`.
</details>

---

## Completed — Phase 7 (render + HUD init extractions)

<details>
<summary>game.js 912L → 679L (−233L, −25%)</summary>

- [x] `src/render.js` (165L) — world rendering pipeline: `render`, `_renderSprites`, `_renderMapAndWater`, `_renderStarSpiral`, `drawMonsterDeath`, `drawPoisonFlash`, `drawPondStrobe`, `updateStarEffect`. `battle-drawing.js` now imports `drawMonsterDeath` directly (callback dropped from `initBattleDrawing`).
- [x] `src/hud-init.js` (109L) — HUD canvas init: `_tileToCanvas`, `_initHUDBorderTiles`, `_initHUDCanvases`, `_buildFadedHUDSet`, `initHUD`. Border/canvas state local to module, mirrored to `ui.*`.
- [x] Dead imports cleaned from game.js: `NES_SYSTEM_PALETTE`, `decodeTiles`, `nesColorFade`, `_stepPalFade`, `drawLoadingOverlay`, `TILE_SIZE`, `DIR_DOWN/UP/LEFT/RIGHT`, `getMonsterCanvas/WhiteCanvas/DeathFrames`, `hasMonsterSprites`, `getBossBattleCanvas/WhiteCanvas`, `_updateWorldWater`, `_updateIndoorWater`, `_buildHorizWaterPair`, `getFlameSprites/Frames`, `getStarTiles`, `poisonFlashTimer`, `setPoisonFlashTimer`, `BATTLE_FLASH_FRAMES/MS`, `_getPlane0` et al from tile-math, `_calcBoxExpandSize`, `_encounterGridPos`.
</details>

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
