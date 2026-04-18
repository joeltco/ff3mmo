# main.js (née game.js) Refactor Log

**Status: complete.** The entry-point file is **149 lines** (v1.6.0) — a minimal composition root. Target was <4,000 lines; result is 96% under target (1,920L → 149L, −92%). Renamed `game.js` → `main.js` post-Phase 15 since "the game" is now in ~30 subsystem modules; this file just wires them.

## Journey

| Phase | game.js LOC | Delta | Theme |
|---|---|---|---|
| Start (post-Phase 5) | 2,695 | — | HUD + map loading extracted |
| Phase 6 | 912 | −1,783 | 14 shared-bags retired, battle-update/movement/title-screen extracted |
| Phase 7 | 679 | −233 | render.js + hud-init.js |
| Phase 8 | 449 | −230 | dead-import sweep (114 symbols), breadcrumb purge |
| Phase 9 | 429 | −20 | inventory.js; 3 `init*` functions deleted |
| Phase 10 | 414 | −15 | roster `_rds` bag killed; WIPE_DURATION exported |
| Phase 11 | 399 | −15 | `keys`/`sprite`/cursor/onShake direct-import; 4 `init*` deleted |
| Phase 12 | 383 | −16 | `initPVP()` deleted (13-callback bag) |
| Phase 12b | 377 | −6 | `waterSt` → water-animation.js; `initRender()` deleted |
| Phase 13 | 257 | −120 | game-loop.js extraction |
| Phase 14 | 172 | −85 | boot.js extraction |
| Phase 15 | 149 | −23 | job-sprites.js; `initTitleUpdate` deleted |

## Final architecture

game.js contains only: imports, `CANVAS_W/H`, `init()`, `returnToTitle()`, `getMobileInputMode()`, `_startDebugMode()`, `_startTitleScreen()`, `loadROM()`, and `export { loadFF12ROM } from './boot.js'`.

Supporting modules split by concern:
- **Frame loop:** `game-loop.js` — `startGameLoop()`, update/draw dispatch, `_reportError`.
- **Asset init:** `boot.js` — `initSpriteAssets`, `initTitleAssets`, `loadFF12ROM`.
- **Render:** `render.js` (world pipeline), `battle-drawing.js`, `pvp.js`, `hud-drawing.js`, `hud-init.js`.
- **State:** `ui-state.js` (canvas/ctx/sprites), `hud-state.js`, `map-state.js`, `battle-state.js`, `inventory.js`, `player-sprite.js`, `save-state.js`, `water-animation.js` (waterSt).
- **Input:** `input-handler.js` (owns `keys`).
- **Sprites:** `sprite-init.js` (ROM → canvases), `job-sprites.js` (job-change swap), `fake-player-sprites.js`, `battle-sprite-cache.js`, `weapon-sprites.js`, `flame-sprites.js`, `monster-sprites.js`, `boss-sprites.js`.
- **Other extractions:** battle-update, battle-ally, battle-enemy, battle-turn, battle-encounter, battle-items, damage-numbers, sprite-init, flame-sprites, title-screen, transitions, movement, pause-menu, chat, roster, message-box, map-loading, map-triggers.

All shared-bag (`_xxxShared`) patterns eliminated. All `init*()` callback shims eliminated except where deps are genuinely one-shot config (e.g., `initBattleAlly({ buildTurnOrder, processNextTurn, isTeamWiped })` — pure function references, not callbacks into game.js state). ES live bindings + direct imports used throughout.

---

## Phase history

## Completed — Phase 15 (extract swapBattleSprites to job-sprites.js)

<details>
<summary>game.js 172L → 149L (−23L); new src/job-sprites.js (25L); initTitleUpdate deleted</summary>

- [x] **New `src/job-sprites.js` (25L)** — owns `SPRITE_PAL_TOP`, `SPRITE_PAL_BTM`, `JOB_WALK_PALS`, and `swapBattleSprites(jobIdx)`.
- [x] **`romRaw` exported from boot.js as live binding** — job-sprites.js reads it directly; game.js no longer needs a local copy.
- [x] **title-screen.js** imports `swapBattleSprites` directly; `initTitleUpdate` deleted entirely (nothing left to configure).
- [x] **input-handler.js** imports `swapBattleSprites` directly; `_swapBattleSprites` shim + init param dropped.
- [x] game.js: drops `_swapBattleSprites`, `JOB_WALK_PALS`, `loadJobBattleSprites` import, `romRaw` local, `initTitleUpdate` call, `sprite` import, `SPRITE_PAL_TOP/BTM` defs (now imported from job-sprites).
</details>

---


## Completed — Phase 14 (extract boot asset init)

<details>
<summary>game.js 257L → 172L (−85L); new src/boot.js (106L)</summary>

- [x] **New `src/boot.js` (106L)** — owns `initSpriteAssets(rom)`, `initTitleAssets(rom)`, `loadFF12ROM(buffer)`, `ff12Raw`/`romRaw` module state, `TITLE_FADE_MAX`.
- [x] game.js imports `initSpriteAssets, initTitleAssets` from boot.js and uses them in `loadROM`.
- [x] `loadFF12ROM` re-exported via `export { loadFF12ROM } from './boot.js';` — index.html's `import { loadFF12ROM } from './src/game.js'` still works.
- [x] 15 imports migrated from game.js to boot.js: `initHUD`, `loadBossSprite`, `initBattleSpriteCache`, `initFlameRawTiles/initStarTiles`, 6 `initTitleX` from title-animations, `ps/initPlayerStats/initExpTable`, `initRoster`, `initMonsterSprites`, `initMusic/initFF1Music`, 7 `init*` from sprite-init, `initFakePlayerSprites`, `initMissSprite`.
- [x] game.js keeps only what `_swapBattleSprites` and `returnToTitle`/`_startTitleScreen`/`_startDebugMode`/`loadROM` actually need.
</details>

---

## Completed — Phase 13 (extract game loop)

<details>
<summary>game.js 377L → 257L (−120L); new src/game-loop.js (139L)</summary>

- [x] **New `src/game-loop.js` (139L)** — owns `_gameLoopUpdate`, `_gameLoopDraw`, `gameLoop`, `lastTime`, `_tabWasLoading`, `SHAKE_DURATION`, `SCREEN_CENTER_X/Y`, and the `_reportError(tag, e)` helper.
- [x] Exports a single `startGameLoop()` — sets `lastTime = performance.now()` and kicks off `requestAnimationFrame(gameLoop)`.
- [x] `_startDebugMode()` and `_startTitleScreen()` in game.js swapped 2-line `lastTime = …; requestAnimationFrame(gameLoop)` for `startGameLoop()`.
- [x] `ctx` local removed from game.js; game-loop reads `ui.ctx` directly.
- [x] 21 imports moved from game.js to game-loop.js (chat, roster, msg-box, pause, transitions, movement, battle-update, battle-drawing, render, hud-drawing, loading-screen, water-animation, data/players, hud-state, battle-state, map-state, ui-state, player-stats, player-sprite, title-screen).
- [x] Header comment updated from "canvas rendering, input handling, game loop" to "boot wiring, ROM loading, composition root" — reflects the actual role.
</details>

---

## Completed — Phase 12b (waterSt → water-animation.js)

<details>
<summary>game.js 383L → 377L (−6L); initRender deleted, initTitleUpdate simplified</summary>

- [x] **`waterSt` + `WATER_TICK` moved to `water-animation.js`** — natural home. Now exports `waterSt` (`{ timer, tick }`) and `tickWater(dt)` helper.
- [x] **`initRender()` deleted entirely** — render.js imports `waterSt` directly; no init state.
- [x] **`initTitleUpdate({ waterSt, ... })` simplified to `initTitleUpdate({ swapBattleSprites })`** — title-screen calls `tickWater(dt)` when in a title-active state, same shared tick.
- [x] Game loop update shrinks: `waterSt.timer += dt; if (waterSt.timer >= WATER_TICK) { … }` → `tickWater(dt)`.
- [x] Dead imports removed: `initRender` from game.js.
</details>

---

## Completed — Phase 12 (kill initPVP's 13-callback bag)

<details>
<summary>pvp.js 781L → 756L (−25L); game.js 399L → 383L (−16L); last initXxx-bag eliminated</summary>

- [x] **`initPVP()` deleted entirely** — was wiring 13 callbacks: `ctx`, `blades`, `processNextTurn`, `handleAlly`, `updateTimers`, `handlePlayerAttack`, `handleDefendItem`, `handleEndSequence`, `tryJoinPlayerAlly`, `buildAndProcessNextTurn`, `resetBattleVars`, `isTeamWiped`, `advancePVPTargetOrVictory`.
- [x] pvp.js now imports each directly from `battle-turn.js`, `battle-ally.js`, `battle-update.js`, `weapon-sprites.js`, `ui-state.js`. `_buildAndProcessNextTurn` became a local 1-liner since it had no other home.
- [x] `_ctx` → `ui.ctx` throughout pvp.js (~30 sites).
- [x] Circular imports (pvp ↔ battle-update, pvp ↔ battle-ally) are fine — all usage happens inside function bodies, not at module-evaluation.
- [x] Dead imports dropped from game.js: `initPVP`, `getBlades`, `updateBattleAlly`, `updateBattleTimers`, `updateBattlePlayerAttack`, `updateBattleDefendItem`, `updateBattleEndSequence`, `tryJoinPlayerAlly`, `advancePVPTargetOrVictory`.
</details>

---

## Completed — Phase 11 (keys/sprite/cursor/onShake direct-import)

<details>
<summary>game.js 414L → 399L (−15L); 3 init* functions deleted, 10+ callback shims retired</summary>

- [x] **`keys` ownership moved to `input-handler.js`** — `export const keys = {}` mutated by the keydown listener. 5 modules drop `_keys` shim: input-handler itself, movement, battle-update, title-screen, transitions.
- [x] **New `src/player-sprite.js` (11L)** — owns the player `Sprite` instance + `setPlayerSprite(s)`. ES live bindings mean importers see the latest value after init. 5 modules drop `_getSprite` shim: render, movement, transitions, battle-update, map-loading.
- [x] **Cursor reads `ui.cursorTileCanvas` directly** — battle-drawing and pvp drop `_cursorCanvas`/`_cursorTileCanvas` getter shims.
- [x] **`_ctx` → `ui.ctx` throughout battle-drawing.js** — ~200 call sites rewritten. `initBattleDrawing()` deleted entirely.
- [x] **`render.js` ctx reads `ui.ctx`** — `initRender()` now takes only `waterSt` (temporary; goes away in next round).
- [x] **`onShake` callback gone** — transitions.js calls `mapSt.shakeActive = true; mapSt.shakeTimer = 0` inline.
- [x] **3 init functions fully deleted**: `initMovement`, `initTransitions`, `initBattleUpdate` — all their params were the shims we just dropped.
- [x] **Dead imports removed from game.js**: `isVictoryBattleState`, `keys`, `initMovement`, `initTransitions`, `initBattleUpdate`, `initBattleDrawing`.
</details>

---

## Completed — Phase 10 (roster-draw-state bag kill + error-report dedup)

<details>
<summary>game.js 429L → 414L (−15L); last shared-bag eliminated from runtime</summary>

- [x] **`_rds` bag retired** — the 13-line draw-state bag + 6-field update-state bag both deleted. `drawRoster()`, `drawRosterMenu()`, `updateRoster(dt)` now take no extra args.
- [x] **roster.js** — now imports `ui`, `transSt`, `WIPE_DURATION`, `battleSt`, `hudSt`, `HUD_INFO_FADE_STEPS`, `HUD_INFO_FADE_STEP_MS`, `msgState`, `drawHudBox`, `drawBorderedBox`, `clipToViewport`, `drawRosterSparkle` directly. `_rosterTransFade()` and `updateRoster(dt)` shed their shared-bag params. 4 dead pass-throughs removed (`hudInfoFadeTimer/Steps/StepMs`, `wipeDuration`).
- [x] **Scroll arrows moved to `ui.*`** — `ui.scrollArrowUp/Down/UpFade/DownFade` mirror the sprite-init output. roster.js reads from `ui` directly.
- [x] `WIPE_DURATION` exported from `transitions.js` — eliminated 3 duplicated `44 * (1000/60)` literals (game.js + roster.js).
- [x] `_reportError(tag, e)` helper — deduped 2 identical `fetch('/api/client-error', …)` POSTs in `_gameLoopDraw`.
- [x] Dead imports: `drawRosterSparkle` + `msgState` removed from game.js (both only used by the killed bag).
</details>

---

## Completed — Phase 9 (inventory extraction + callback purge)

<details>
<summary>game.js 449L → 429L (−20L); removed 3 init* shims across 6 consumers</summary>

- [x] `src/inventory.js` (28L) — owns `playerInventory`, `addItem`, `removeItem`, `setPlayerInventory`, `buildItemSelectList`, `INV_SLOTS`. Stable `const` reference; `setPlayerInventory` mutates in place so importers never hold a stale binding.
- [x] Rewired 6 consumers to import directly instead of callback shims:
  - `save-state.js` — dropped `setInventoryGetter` + unused `_getInventory` local
  - `input-handler.js` — dropped `playerInventory`/`addItem`/`removeItem` from `initInputHandler`; dropped duplicate `INV_SLOTS` const; purged two stale `// shared = { ... }` doc blocks
  - `pause-menu.js` — `initPauseMenu` deleted entirely; `updatePauseMenu(dt)` signature simplified (param threading gone)
  - `battle-update.js` — dropped `addItem`/`buildItemSelectList` from `initBattleUpdate`
  - `battle-turn.js` — `initBattleTurn` deleted entirely
  - `map-triggers.js` — `initMapTriggers` deleted entirely
  - `title-screen.js` — dropped `setPlayerInventory` callback from `initTitleUpdate`
- [x] Dead-import audit in game.js: dropped `getRosterVisible` (only consumed in input-handler.js) and `inputSt` (obsolete after Phase 8 chat-hotkey move).
</details>

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
