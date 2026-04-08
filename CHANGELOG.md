# Changelog

All notable changes to this project are documented here.

## 1.5.0 — 2026-04-08

### FF3 Job Levels + Combat Overhaul

- **FF3 job levels** replace FF2 proficiency system. JP earned per battle action, 100 JP per level, max 99. Per-job JP rates from NES disassembly.
- **Job level affects ATK** (`floor(jobLv/4)`) not hit count — verified from disassembly 31/ABEF.
- **Hit count from disassembly** — `1 + floor(level/16) + floor(AGI/16)` per hand (31/ABCE).
- **Dual wield NES-accurate** — each hand rolls independently with own ATK/hitRate/element. R hand combo first, then L hand (NES loop at 30/9F6A).
- **Back/fwd swing animation** — 80ms back swing, 80ms forward swing per hit. Distinct portrait poses using attack2 canvas.
- **Battle pose system modularized** — 14 canvas variables replaced with `battlePoses` map. One shared getter.
- **Battle message strip** — right panel (144,160) shows all combat + victory messages. Auto-advance for combat, Z-advance for victory. Horizontal scroll for long messages.
- **Victory state machine simplified** — ~14 states collapsed to 3 (`victory-celebrate` → `victory-msg` → close).
- **Run states simplified** — 10 run states collapsed to 2 (`run-success`, `run-fail`).
- **msg-wait state** — battle turns wait for messages to finish before advancing.
- **Combat math centralized** — `calcPotentialHits()` and `rollHits()` with opts (shieldEvade, evade, defendHalve, elemMult) in battle-math.js. Used by player, allies, PVP.
- **Player name in battle messages** — "Joel attacks!", "Joel defends!"
- **Enemy name messages** — monster name shown when enemy attacks
- **Stats screen** — added HIT, EVD, MDF rows
- **Job menu** — 2-letter abbreviations (Fi, Mo, WM, etc.), per-job level display, discounted CP costs
- **Single-player economy** — all earnings /4 (EXP, Gil, CP, JP). Costs stay NES values.
- **CP cost discount** — `jobSwitchCost = max(0, baseCost - (jobLv - 1))`
- **Battle strings from disassembly** — Critical!, Strike first!, Ambushed!, Ineffective, Slain, etc.
- **Fighter R FWD leg tile fix** — first byte 0xE0 (was 0x00)
- **prof-icons.js deleted** — FF2 proficiency system fully removed

## 1.4.0 — 2026-04-06

### Per-item equip restrictions + Warrior PPU sprites

- **Per-item job restrictions** — every weapon and armor in `items.js` has a `jobs` bitmask (22 bits). `canJobEquip(jobIdx, itemId, ITEMS)` checks per-item, not per-type. Data sourced from RPG Shrines weapon/armor pages
- **Auto-unequip on job change** — `_enforceEquipRestrictions(jobIdx)` checks all 5 equip slots, returns invalid gear to inventory
- **Equip filtering** — equip list only shows items the current job can use. Optimum respects job restrictions
- **Warrior PPU sprites** — `src/data/warrior-sprites.js` with all PPU-dumped poses (idle, L/R back/fwd swing, kneel, victory, hit, death + all leg tiles). Player battle sprites and fake player portraits/bodies use PPU tiles
- **Per-job fake player sprites** — all `fakePlayer*` vars keyed by `{jobIdx: array[palIdx]}`. Roster, battle-drawing, PVP updated to look up by `ally.jobIdx`
- **Fake player jobs** — PLAYER_POOL entries have `jobIdx` (0=OK, 1=Fighter). `generateAllyStats` includes `jobIdx`
- **PVP damage number positioning** — fixed: numbers now appear at sprite right edge + bottom (matching regular encounters), not sprite center
- **Konami debug viewer** — Warrior poses added to tile viewer (same labels as OK). `openTileViewer()` now async for dynamic import

## 1.3.6 — 2026-04-05

### Job system + Capacity Points

- **Job system** — players start as Onion Knight, unlock Wind Crystal jobs (Warrior, Monk, White Mage, Black Mage, Red Mage) after defeating Land Turtle boss
- **Job change** — pause menu "Job" opens submenu listing unlocked jobs. Current job highlighted green. Selecting a new job recalculates stats from base + level bonuses for the new job class
- **Battle sprite swap** — portrait and all battle pose canvases (idle, attack, defend, hit, kneel, victory, knife poses) rebuild from ROM per job via `initBattleSpriteForJob(romData, jobIdx)` in sprite-init.js
- **Capacity Points (CP)** — earned from battles (1 per enemy killed, 10 for boss). Cap 255. Spent to change jobs (Wind Crystal = 10 CP, later tiers scale 20/30/40/50). Onion Knight always free
- **Job menu UI** — shows CP counter at top, each job's cost on right, grey text for unaffordable jobs, error SFX on insufficient CP
- **Save data** — `jobIdx`, `unlockedJobs` (bitmask), and `cp` persisted per save slot
- **Stat recalc** — `changeJob()` in player-stats.js rebuilds stats from scratch: reads job base stats, replays all level bonuses for the new job at current level, clamps HP/MP
- **Level-up** — uses current job's stat growth curve instead of hardcoded Onion Knight
- player-stats.js: 247L, sprite-init.js: 802L, game.js: 2,730L

## 1.3.5 — 2026-04-05

### Refactor — HUD drawing + map loading extraction

- **`src/hud-drawing.js`** (349L) — HUD rendering, top box, portrait, info panel, utility draw helpers (`clipToViewport`, `drawCursorFaded`, `drawHudBox`, `drawBorderedBox`, `drawSparkleCorners`, `drawHealNum`, `drawTopBoxBorder`, `roundTopBoxCorners`, `grayViewport`, `drawRosterSparkle`, `drawHUD`, `statRowBytes`)
- **`src/map-loading.js`** (223L) — map/dungeon/world loading (`loadMapById`, `loadWorldMapAt`, `loadWorldMapAtPosition`, `setupTopBox`), spawn calculation, door state, floor generation wiring
- game.js: **2,695L** (was 3,083L, net −388L)

## 1.3.4 — 2026-04-05

### Options menu + CRT filter

- **Options in pause menu** — new "Options" entry above "Quit" in pause menu (7 items, cursor wraps 0–6). Full expand/shrink/fade transitions matching existing sub-menus
- **CRT filter toggle** — "CRT" option with On/Off display, press Z to toggle. Adds/removes `crt` class on canvas wrapper
- **Canvas-based scanlines** — replaced CSS gradient scanlines with a 1×480 canvas overlay using `image-rendering: pixelated`. Guarantees pixel-perfect alignment on all screen sizes
- **Vignette** — radial gradient `::after` overlay (separate from scanlines)
- pause-menu.js: 466L (was 413L), input-handler.js: 920L (was 908L)

## 1.3.3 — 2026-04-05

### Player select rework

- **Airship drift transition** — pressing Z on title triggers simultaneous: logo box closes, press-A box closes, airship drifts left (eased, 800ms). Pressing X on select reverses: boxes close, airship drifts right, logo reopens, content fades in
- **Roster-style save slots** — 3 individual HUD boxes (portrait + info, like roster rows) replace single select box. Positioned center-right, pushed right one tile. Each box opens/closes individually
- **Sequenced logo animations** — logo box expands on title start (after credits), FF3 MMORPG content fades in separately, press-A box opens then text fades in and blinks. On close: content fades out first, then box collapses (top+bottom HUD borders visible on final frame)
- **Delete system** — "Delete" HUD box to the left of bottom slot row, bottom-aligned. Left arrow moves cursor to delete, right/X returns. Z on delete removes save. Red highlight when selected, fades with content
- **Removed states**: `zbox-close`, `logo-fade-out`, `logo-fade-in`, `select-box-close`. **Added**: `to-select`, `to-main`, `logo-reopen`, `logo-box-open`, `logo-content-in`, `logo-content-out`, `logo-content-in-back`, `pressz-fade-in`
- Removed `drawPlayerSelectContent` export. Added `drawHudBox` to title shared context
- title-screen.js: 635L (was 539L), game.js: 3,084L (was 3,078L)

## 1.3.2 — 2026-04-05

### Chat tabs + channel system

- **Chat tab bar** — bordered tabs in gap between roster panel and chat HUD
  - Tabs: World, Room, Private, System — HUD-bordered boxes, selected tab on left with open bottom connecting to chat HUD
  - Unselected tabs collapse behind selected tab, filling remaining panel width
  - S key cycles: none → roster browse → tab select. X/Z exits tab select
  - Left/right arrows cycle tabs. Selected tab text blinks in tab select mode
  - Drawn before HUD so chat HUD border draws on top of tab overlap
- **Channel system** — messages tagged with `channel` ('room'/'world'/'pm'/'sys') and `loc` (for room filtering)
  - Auto-chat: 60% local (room channel), 40% remote players (world channel), tagged with sender's location
  - World: world chat + system messages. Room: local area chat + system messages. Private: PMs (scrollable). System: console + system only
  - Room tab filters by `msg.loc === getPlayerLocation()`
- **Unread notifications** — background tab text blinks when new messages arrive. Clears when tab is selected. System tab never blinks.
- **Private tab scroll** — up/down arrows scroll chat history when Private tab is in select mode
- **Tab fading** — NES palette fade on game start (HUD info), battle (roster fade), dungeon loading (fade out during closing wipe, stay faded during loading, fade in during opening wipe after loading). `_tabWasLoading` flag tracks post-loading fade-in. No fade on regular room transitions.
- Movement blocked during tab select mode
- chat.js: 394L, input-handler.js: 905L

## 1.3.1 — 2026-04-05

### Roster extraction + scroll arrows

- **Roster scroll arrows** — replaced hand-drawn canvas triangles with ROM sprite arrows (`$1B490`)
  - `initScrollArrows(romData)` in sprite-init.js — single 8×8 tile, vertically flipped for up arrow
  - NES palette fade variants for transition/battle fading
  - Down arrow: bottom-right corner of bottom-most roster player's info box, blinking 500ms
  - Up arrow: top-right corner of top-most roster player's info box, blinking 500ms
  - Only visible when scrolling is available in that direction

### Roster extraction → roster.js

- **Extracted `src/roster.js`** (367L) — all roster state, update, and draw logic
  - Owns: fade maps, slide animations, battle fade, arrival order, movement timers
  - Exports: `getPlayerLocation`, `rosterLocForMapId`, `getRosterVisible`, `rosterBattleFade`
  - `setLocationGetter()` callback pattern for `onWorldMap`/`currentMapId` (avoids circular dep)
  - Draw functions receive shared context: `ctx`, `drawHudBox`, portraits, sparkle callback
  - Update functions receive shared context: `battleState`, `transSt`, `wipeDuration`, HUD fade params
  - `_drawRosterSparkle` stays in game.js (entangled with `pauseSt`, `cureSparkleFrames`, `_drawHealNum`)
- Cleaned up game.js imports: removed `LOCATIONS`, `CHAT_PHRASES` (moved to roster.js/chat.js)
- Renamed `_rosterLocForMapId` → `rosterLocForMapId` (public export)
- game.js: 3,046L (−344L)

## 1.3.0 — 2026-04-05

### Console system

- **Chat HUD → console** — chat panel now doubles as a game console
  - Command system: `/help`, `/clear`, `/who` — lines starting with `/` are parsed as commands
  - New `'console'` message type renders in green (`#58c858`)
  - Startup log on title screen: version, ROM info, auth status, save slot count
  - Console-only rendering during title screen (no auto-chat, no player messages)
  - Command context system (`setCommandContext`) for game state access (roster names for `/who`)
- **Moved `_onChatKeyDown` from game.js → chat.js** as `onChatKeyDown` — chat module now owns all input handling
  - chat.js imports `selectCursor`/`saveSlots` from save-state.js, `_nesNameToString` from text-utils.js directly
- **Dynamic input line expansion** — chat input starts as 1 line, expands to 2 only when text wraps
- **Removed version badge** from webpage (`#version-badge` hidden) — version now in console
- game.js: 3,390L (net +2L from wiring, −16L from extraction)

## 1.2.4 — 2026-04-05

### Player select + title update logic → title-screen.js

- **Moved player select update logic to `title-screen.js`** — slot cursor input, delete mode, name entry key handler, underwater bubble/fish animations
  - `updateTitleSelect(keys)`, `onNameEntryKeyDown(e)`, `updateTitleUnderwater(dt)` now exported from title-screen.js
  - title-screen.js is now the complete player select module (draw + update)
  - `_zPressed`/`_xPressed` helpers moved as private functions
  - `_updateTitleMainOutCase` stays in game.js (deep game state writes)
- Cleaned up unused imports: `serverDeleteSlot`, `nameBuffer`, `NAME_MAX_LEN`, `setNameBuffer` removed from game.js
- game.js: 3,388L (−79L this release)

## 1.2.3 — 2026-04-05

### Save state module + gil persistence fix

- **Extracted `src/save-state.js`** (new module, 83L) — centralized save slot state
  - Owns `selectCursor`, `saveSlots`, `nameBuffer`, `savesLoaded`
  - `saveSlotsToDB()` and `loadSlotsFromDB()` moved from game.js
  - input-handler.js, pause-menu.js, title-screen.js now import directly — no more shared context proxying
  - 3 shared context functions simplified (removed `selectCursor`/`saveSlots` getters)
- **Gil + proficiency persistence fix** — `saveSlotsToDB()` serialization was missing `gil` and `proficiency` fields; `parseSaveSlots()` wasn't reading `gil` back. Both now persist to IndexedDB and server correctly.
- game.js: 3,467L (−67L from save-state extraction)

## 1.2.2 — 2026-04-05

### Refactor: game.js under 4,000 lines (4,208 → 3,534)

- **Extracted `src/sprite-init.js`** (new module, 636L) — all sprite initialization functions
  - 37 pure init functions: battle sprites, portraits, full-body canvases, goblin, adamantoise, invincible airship, moogle, cursor, loading screen fade frames
  - ROM bytes in, canvases out — zero runtime coupling
  - Constants moved: palette arrays, ROM offsets, tile data (only used at init time)
  - Each init function returns result object; game.js destructures and assigns to existing variables
- **Extracted `src/flame-sprites.js`** (new module, 153L) — flame & star sprite systems
  - Flame tile decode from ROM, palette rendering with map sprite palettes, sprite positioning
  - Star tile decode (teleport warp effect)
  - Thin wrapper `_rebuildFlameSprites()` remains in game.js for map-triggers compat
- **`_syncSaveSlotProgress` dedup** — merged 9L sync function into `saveSlotsToDB()`, removed 5 paired call sites
- **`startRandomEncounter` dedup** — replaced 15 manual variable resets with single `_resetBattleVars()` call
- game.js: 3,534L (−674L this release). **Target <4,000L achieved.**

## 1.2.1 — 2026-04-04

### Damage numbers module + miss sprite + gil

- **Extracted `src/damage-numbers.js`** (new module, 102L) — all damage/heal number state and rendering
  - Owns all 6 number state variables (`enemyDmgNum`, `playerDamageNum`, `allyDamageNums`, `playerHealNum`, `enemyHealNum`, `swDmgNums`)
  - `DMG_NUM_PAL` and `HEAL_NUM_PAL` constants — single source of truth (removed duplicates from game.js + battle-drawing.js)
  - `tickDmgNums()` / `tickHealNums()` / `clearHealNums()` / `resetAllDmgNums()` — unified lifecycle
  - `drawBattleNum()` — shared digit rendering helper (replaced duplicate `_drawHealNum` in game.js)
  - `initMissSprite()` / `getMissCanvas()` — miss sprite from ROM tiles $1B4D0/$1B4E0 (green "MISS" with black outline)
- **Miss sprite** — replaced `drawText` "Miss" with actual ROM tile sprite (2×8×8 tiles, color 3=green fill, color 1=black outline)
- **Damage number positioning** — NES-accurate: bottom-right of enemy sprites, right edge of player/ally portraits
- **Battle items use `setSwDmgNum()`** from damage-numbers module (removed local dmgNums from battle-items.js)
- **Gil on stats screen** — displayed in pause menu stats panel below MND
- **Gil persists on logout** — `beforeunload` now calls `_syncSaveSlotProgress()` before saving
- **Tile viewer BANK button** — cycles through 21 known CHR data banks in ROM, skips program code garbage
- game.js: ~4,208L (−23L this release)

## 1.2.0 — 2026-04-04

### Magic battle items extracted + Southwind boss fix

- **Extracted `src/battle-items.js`** (new module, 150L) — all magic item battle logic decoupled from game.js
  - `startMagicItem()` — target selection + damage roll (PVP, random encounter, boss paths)
  - `updateMagicItemThrowHit()` — throw/hit state machine, damage application, death triggers
  - `resetBattleItemVars()` — state reset
  - Module-local state: targets, hitIdx, baseDamage (no longer pollute game.js scope)
  - `_magicItemShared()` context in game.js passes battle state via getter/setter pattern
  - Designed for multiple spell items — future items share the same entry points
- **Southwind now works on boss** — was silently doing nothing (animation played, item consumed, no damage). Boss path added to damage application, target selection, kill detection, explosion drawing, and damage numbers
- **Carbuncle per-tile palette fix** — bottom-left tiles were wrong colors; added `tilePal` override array
- **Blue Wisp palette fix** — bottom half used wrong palette; all tiles forced to pal0
- **Encounter box per-row height** — tall monsters (Eye Fangs) sorted to top row; box sized per-row instead of single sprH
- **Healing pond movement block** — player can no longer walk away during strobe animation before "Fully Restored!" message
- game.js: ~4,231L (−89L this release)

## 1.1.9 — 2026-03-28

### Weapon blade positioning overhaul + ally dual-wield

NES OAM traces confirmed exact per-hand offsets for all blade placements.

- **L-hand back-swing offset corrected** — NES data shows L-hand sits at body_left+16, not +8 (R-hand). Fixed in player portrait (`_drawPortraitWeapon`), PVP opponent (`drawBlade` with `isLeftHandWind`).
- **Ally dual-wield second strike** — allies with `weaponL` now perform a full second hit:
  - `allyHitIsLeft` flag tracks which hit is active
  - `_updateAllyDamageShow` queues second `ally-attack-start` when `isWeapon(ally.weaponL)`
  - `_drawAllyPortrait` selects correct portrait per hand (`fakePlayerAttackLPortraits` for L back-swing, `fakePlayerKnifeR/LPortraits` for fwd-swing), correct blade position, correct blade canvas
  - SFX uses active hand's weapon (knife sound vs punch)
  - Single-weapon allies unaffected

## 1.1.8 — 2026-03-28

### Fix PVP opponent weapon blade positions

- **`drawBlade()` fixed** — replaced hardcoded wrong positions with a mirrored ctx transform
  - `ctx.translate(sprX+16, sprY); ctx.scale(-1,1)` pivots at the body's right edge
  - Blade drawn at player-identical offsets: raised=(8,-7), swung=(-16,1), fist=(-4,10)
  - Back-swing blade now spans sprX-8 to sprX+8 (behind body, correct side)
  - Fwd-swing blade now spans sprX+16 to sprX+32 (forward, correct side)
- **Root cause of previous failure:** `trace-weapon-positions.lua` equipped both hands simultaneously without labeling R vs L. Fixed by writing isolated `tools/trace-rhand.lua` and `tools/trace-lhand.lua`; ran headlessly via Xvfb.
- **L-hand finding:** dagger L-hand attack produces no weapon tile sprites in NES — it uses the fist/punch animation. Existing fist path in pvp.js is correct.

## 1.1.7 — 2026-03-24

### PVP system modularized + opponent animation overhaul

- **Battle freeze fix** — `HUD_VIEW_H` was missing from `input-handler.js` local constants; every call to `_battleTargetConfirm` threw `ReferenceError`, crashing the game loop on player attack confirm
- **Extracted `src/pvp.js`** (new module, ~340L) — entire PVP duel system decoupled from game.js
  - `pvpSt` exported state object replaces 12 scattered `let` vars (`isPVPBattle`, `pvpOpponent`, `pvpOpponentStats`, `pvpOpponentIsDefending`, `pvpOpponentHitIdx`, `pvpOpponentHitsThisTurn`, `pvpEnemyAllies`, `pvpCurrentEnemyAllyIdx`, `pvpBoxResize*`, `pvpEnemySlidePosFrom`)
  - Exports: `startPVPBattle`, `resetPVPState`, `tryJoinPVPEnemyAlly`, `updateBattleEnemyTurn`, `drawBossSpriteBoxPVP`
  - `_pvpShared()` in game.js bundles all required state via getter/setter pattern (same as `_inputShared`, `_triggerShared`)
  - game.js: −181L this release
- **Opponent animation system** — PVP opponents now mirror the full player/ally portrait animation pipeline
  - **Body poses**: idle → `fullBodyCanvases`; hit → `hitFullBodyCanvases`; wind-up → `knifeBackFullBodyCanvases` (raised back-swing); R-hand strike → `knifeRFullBodyCanvases`; L-hand strike → `knifeLFullBodyCanvases`
  - **Weapon blade overlays**: drawn via mirrored transform (`translate(sprX+16) + scale(-1,1)`) — same offsets as player/ally (`raised=(8,-7)`, `swung=(-16,1)`, `fist=(-4,10)`) but h-flipped so blades appear on opponent's screen-left (their right hand)
  - Supports knife, dagger, sword, fist; dual-wield second hit uses left-hand pose and blade
  - **Hit pose duration fixed**: `player-damage-show` (700ms) removed from `isOppHit` — opponent returns to idle during damage display, only flinches during slash impact + `player-hit-show` (150ms)
  - **Wind-up blink fixed**: slowed from 16ms/frame to 50ms/frame — was too fast to render at 60fps (invisible flicker); now clearly visible
- **Naming cleanup in pvp.js**: `monHitRate`→`hitRate`, `monAtk`→`atk`, `monAtk2`/`shieldEvade2`/`dmg2` → clean names; removed unused `wpnSt` knife-pose variable

## 1.1.6 — 2026-03-23

### Polish fixes

- **Quit→title full-screen fade** — black overlay drawn last in `_gameLoopDraw` after all HUDs, covering entire 256×240 canvas. `hud-fade-out` removed from `drawTransitionOverlay` (handled in game.js only)
- **Quit no longer reloads page** — `returnToTitle` now calls `_startTitleScreen()` directly after fade; session preserved

## 1.1.5 — 2026-03-23

### Polish — music timing, tile viewer, pause menu clip

- **Ur music deferred to map open transition** — title → game start: `transSt.pendingTrack` set before `loadMapById`; `_loadRegularMap` skips immediate play when pending track is set; `hud-fade-in` → `opening` triggers playback in sync with the wipe
- **Title screen music fade-out** — `fadeOutMusic(durationMs)` added to `music.js` using Web Audio `GainNode`; triggered at `select-box-close-fwd` → `main-out` so music fades with the title screen. Fixed: `gainNode` now created independently of `audioCtx` so `playSFX` initializing audio first no longer breaks the fade
- **TILES button removed** — ROM tile viewer now opened via Konami code (↑↑↓↓←→←→ X Z Start), using game keybindings (X=B, Z=A)
- **Pause menu scroll-in clip** — box was drawing over top HUD area during slide-in; fixed by moving `_clipToViewport()` before `_drawPauseBox()` in `drawPauseMenu`

## 1.1.4 — 2026-03-23

### game.js refactor — map-triggers.js extracted (5,631 → 5,465L)

- **Extracted `src/map-triggers.js`** (254L) — all tile-based Z-action and walk-on event handlers
  - `checkTrigger`, `_checkWorldMapTrigger`, `_checkHiddenTrap`, `_checkDynType1`, `_checkDynType4`, `_checkExitPrev`, `_triggerMapTransition`, `handleChest`, `handleSecretWall`, `handleRockPuzzle`, `handlePondHeal`, `applyPassage`, `openPassage`, `findWorldExitIndex`
  - `_triggerShared()` helper in game.js bundles map/dungeon state via get/set props for `mapRenderer`, `rockSwitch`, `disabledTrigger`, `onWorldMap`, `dungeonSeed`, shake/star/pond effects
  - `applyPassage(tm)` remains pure (no shared state); `findWorldExitIndex(mapId, worldMapData)` takes data directly
- game.js: −166L this release, −2,023L total (7,488 → 5,465)

## 1.1.3 — 2026-03-23

### game.js refactor — 6 modules extracted (7,488 → 5,631L)

- **Extracted `src/chat.js`** (~150L) — chat message buffer, auto-chat, expand/collapse animation, and HUD rendering fully decoupled from game.js
  - `chatState` object replaces 8 scattered globals (`messages`, `autoTimer`, `fontReady`, `inputActive`, `inputText`, `cursorTimer`, `expanded`, `expandAnim`)
  - `addChatMessage(text, type)`, `updateChat(dt, battleState)`, `drawChat(ctx, drawHudBoxFn, rosterBattleFade)` exported
  - All 5 chat constants moved into module (`CHAT_LINE_H`, `CHAT_HISTORY`, `CHAT_EXPAND_MS`, `CHAT_AUTO_MIN/MAX_MS`)
- **Extracted `src/message-box.js`** (~100L) — slide-in/hold/slide-out message box overlay
  - `msgState` object replaces 4 globals (`state`, `timer`, `bytes`, `onClose`)
  - `showMsgBox(bytes, onClose)`, `updateMsgBox(dt)`, `drawMsgBox(ctx, clipFn, drawBoxFn)` exported
  - `_wrapMsgBytes` moved into module (byte-level word wrap for NES text encoding)
- **Extracted `src/title-screen.js`** (~445L) — all title draw functions + titleSt state object
  - `titleSt` object replaces ~20 scattered title globals (waterScroll, underwaterScroll, shipTimer, deleteMode, all sprite caches, pressZ, fish/bubble state)
  - Exported draw functions: `drawTitle`, `drawTitleOcean`, `drawTitleWater`, `drawTitleSky`, `drawTitleUnderwater`, `drawUnderwaterSprites`, `drawTitleSkyInHUD`, `drawPlayerSelectContent`
  - Draw functions take `(ctx, shared)` where `shared` bundles game.js deps (waterTick, selectCursor, saveSlots, drawBorderedBox, etc.)
  - Border tiles / fade sets wired via `titleSt.borderTiles` / `titleSt.borderFadeSets` after HUD init
  - Title update logic kept in game.js (too coupled to game state machine)
- **Extracted `src/pause-menu.js`** (~405L) — pause menu state, transitions, and rendering
  - `pauseSt` object replaces 12 globals (state, timer, cursor, invScroll, heldItem, healNum, useItemId, invAllyTarget, eqCursor, eqSlotIdx, eqItemList, eqItemCursor)
  - Exports: `pauseSt`, `updatePauseMenu(dt, playerInventory)`, `drawPauseMenu(ctx, shared)`
  - All 4 pause transition sub-functions + all 6 draw sub-functions moved into module
  - `_pauseShared()` helper in game.js bundles deps for draw calls
- **Extracted `src/transitions.js`** (~234L) — wipe transitions, loading screen state, top-box area name
  - `transSt`, `topBoxSt`, `loadingSt` objects replace 17 scattered globals
  - Exports: `startWipeTransition`, `updateTransition`, `updateTopBoxScroll`, `drawTransitionOverlay`
  - `_triggerWipe()` wrapper in game.js pre-computes `rosterLocChanged` before calling module
  - Loading overlay draw functions kept in game.js (too coupled to game canvas globals)
- **Extracted `src/input-handler.js`** (~380L module, ~674L removed from game.js) — battle, roster, and pause input handlers
  - `inputSt` object replaces 20 scattered globals (battleCursor, targetIndex, hitResults, playerActionPending, itemSelectList, itemPage/PageCursor/SlideDir/SlideCursor, itemHeldIdx, itemTargetType/Index/AllyIndex/Mode, battleProfHits, rosterState/Cursor/Scroll/MenuCursor/MenuTimer)
  - Exports: `inputSt`, `handleBattleInput(shared)`, `handleRosterInput(shared)`, `handlePauseInput(shared)`
  - Module-level `_s` pattern: exported handlers set shared context once, private helpers access it without explicit parameter threading
  - `_inputShared()` helper in game.js bundles 30+ deps (get/set battleState/battleTimer, game arrays, callbacks)
  - `executeBattleCommand`, `_resetBattleVars`, roster draw/update in game.js all reference `inputSt.*` directly
- game.js: −1,857L total (7,488 → 5,631)

## 1.1.2 — 2026-03-23

### Full monster catalog + FF2 battle rank prof scaling

- **All 225 monsters populated** in `src/data/monsters.js` — complete NES bestiary from Altar Cave through Dark World. HP/Level/EXP/Gil from GameFAQs NES FAQ + RPGClassics shrine. ATK/DEF estimated via `level+4` / `max(1,floor(level/4))` formula (exact NES values require GamerCorner per-page lookup).
  - Regular enemies IDs `0x00`–`0xC2` (195 entries, sequential by bestiary order)
  - Bosses IDs `0xCC`–`0xE9` (30 entries, verified offset from existing Land Turtle)
  - IDs `0xC3`–`0xCB` reserved (9 unused/dummied ROM slots)
  - Undead flagged `weakness: ['fire','holy']`, sea enemies `'bolt'`, sky `'air'`, etc.
  - Splitting enemies (Sirenos, Azrael, Death Claw, etc.) flagged `weakness: 'dark'`
  - Dummied entries (Mandrake, Fury Eye) included with `location: ['dummied']`
- **FF2 battle rank scaling** for proficiency gains — `gainProficiency(hitsMap, battleRank)` in `player-stats.js`:
  - Points per hit = `hits × max(1, battleRank − profLevel + 1)`
  - Grinding low-rank enemies gives 1× points; fighting above your prof level multiplies gains
  - Random encounters pass avg monster level from `MONSTERS.get(m.monsterId)?.level`
  - PVP passes `pvpOpponentStats.level`
  - Boss (Land Turtle) passes `MONSTERS.get(0xCC)?.level`
  - Boss dissolve path now also stores `encounterProfLevelUps` / `profLevelUpIdx` so prof level-up messages display after boss victories

## 1.1.1 — 2026-03-23

### Proficiency depth — shield evade + full combat scaling

- **Shield evade mechanic**: shields now roll evade% before the enemy hit rate check. Each shield has a base evade value from ROM data (Leather 3%, Crystal 19%, Onion 48%). Enemy misses due to shield block earn 1 shield prof point. `getShieldEvade(ITEMS)` in `player-stats.js` returns `baseEvade + profLevel`.
- **Shield prof scaling**: +1% evade per shield prof level (max +16% at level 16). Stacks on top of base shield evade.
- **Weapon prof combat bonuses** — `rollHits` in `battle-math.js` now accepts `profLevel` param:
  - +0.5% hit rate per level (max +8% at level 16)
  - +0.25% crit rate per level (max +4% on top of base 5%)
  - +floor(level × 0.5) flat ATK per level (max +8 at level 16)
- **`WEAPON_PROF_CATEGORY`** map covers all weapon subtypes: claw/nunchaku→unarmed, rod→staff, katana→sword, hammer→axe, boomerang→bow, shuriken→knife, bell/book/harp→staff.

## 1.1.0 — 2026-03-23

### Stats screen overhaul + proficiency icons

- New `src/prof-icons.js` — decodes FF2 weapon icon tiles (unarmed/shield/knife/spear/staff/sword/axe/bow) from FF1&2 ROM at `$64A10`–`$64A80`, and FF3 magic icon tiles (call/white/black) from FF3 ROM at `$1B730`–`$1B760`. `initProfIcons(ff3Rom, ff12Rom)` called on ROM load. `getProfIcon(category)` returns 8×8 canvas.
- ROM tile browser debug tool — TILES button in mobile utility row opens full ROM tile viewer. Select FF3 or FF1&2 ROM, enter hex offset, page through 128 tiles per page.
- Stats screen redesigned as single page: left section has player name, Lv, HP cur/max, MP cur/max, EXP, Next, paired stat rows (ATK/DEF, STR/AGI, VIT/INT, MND); right column has all 11 proficiency icons stacked vertically with level numbers.
- `text-decoder.js` / `text-utils.js`: fixed and added symbol character mappings — `,` `'` `.` `-` `!` `?` `%` `/` `:` `"` `+`
- Removed 2-page stats system; single-page layout with 11px row spacing fills the HUD panel cleanly.

## 1.0.9 — 2026-03-23

### Player stats module + FF2-style proficiency system + stats screen

- New `src/player-stats.js` — extracts all player state from game.js into a single `ps` object and exports pure functions: `getEquipSlotId`, `setEquipSlotId`, `recalcCombatStats`, `recalcDEF`, `getHitWeapon`, `isHitRightHand`, `initPlayerStats`, `initExpTable`, `grantExp`, `fullHeal`, `playerStatsSnapshot`
- `ps` replaces 13 scattered globals: `playerStats`, `playerHP/MP/ATK/DEF/Gil`, `playerWeaponR/L`, `playerHead/Body/Arms`, `expTable`, `leveledUp`
- **FF2-style weapon proficiency**: `ps.proficiency` tracks points per weapon subtype (100 pts/level, max level 16). Hits landed in battle earn points. Every 4 proficiency levels = +1 bonus hit. Gains applied on victory, persisted in save DB.
- **Stats screen in pause menu**: Select → Stats expands HUD panel (same animation as Inventory/Equip). Page 1: Lv, HP, MP, EXP, STR/AGI/VIT/INT/MND, ATK/DEF. Page 2: weapon proficiency levels. Left/Right to page-flip, X to exit.

## 1.0.8 — 2026-03-22

### Extract jobs module + fix weapon subtype system

- New `src/data/jobs.js` — all 22 FF3 NES jobs in ROM order, ROM offset constants (`BATTLE_SPRITE_ROM`, `BATTLE_JOB_SIZE`, `BATTLE_PAL_ROM`, `JOB_BASE_STATS_OFF`, etc.), `JOBS` array with name/weapons/armor/magic flags, `JOB_NAMES`, and reader functions: `readJobBaseStats`, `readStartingHP`, `readStartingMP`, `readJobLevelBonus`, `buildExpTable`
- `game.js` imports from `jobs.js`; removed inline ROM offset constants and inline stat/exp parsing
- `initPlayerStats` and `initExpTable` now call reader functions from `jobs.js`
- `grantExp` level-up stat bonuses now use `readJobLevelBonus`
- Weapon sprite selection in game.js now keyed by item ID (`0x1F`) rather than `'dagger'` subtype — subtype is animation category only (`'knife'`, `'sword'`, everything else)

## 1.0.7 — 2026-03-22

### All fades converted to NES palette — no globalAlpha on HUD or sprites

Enforced strict NES palette fading across the entire codebase. `globalAlpha` is now only used for the chat black fill rect and canvas text (no NES tile equivalent exists for those).

**Changes:**
- `drawHUD` game-start border: switched from `globalAlpha` to `_drawHudWithFade` + `hudFadeCanvases` (real NES border tiles fading via `borderFadeSets`)
- Portrait idle/kneel/defend: new `_buildFadedCanvas4Set` helper generates pre-rendered NES-palette-faded canvas sets at init time; `_drawPortraitImage` selects the correct faded canvas per pose
- Info panel text (name/HP/level): `nesColorFade` applied to text palette per `infoFadeStep`; HP/level cross-fade steps combined additively with `infoFadeStep`
- Cursor: `initCursorTile` refactored to use `_buildCanvas4ROM` + pre-rendered `cursorFadeCanvases`; `_drawCursorFaded` uses faded canvases instead of `globalAlpha`
- Select screen portraits: use `battleSpriteFadeCanvases[fadeStep-1]`; silhouette skipped during fade (no faded version)
- Chat border: `_drawChatExpandBG` passes `rosterBattleFade` step to `_drawHudBox` → `borderFadeSets` used for NES tile fading

## 1.0.6 — 2026-03-22

### Keep bottom HUD solid during game-start fade-in

Bottom HUD border (chat panel) was fading in along with the rest of the HUD on map start. After drawing the faded `hudCanvas`, the bottom HUD region is now clipped and redrawn at full alpha — same pattern used by `_drawHudWithFade` for title screen.

## 1.0.5 — 2026-03-22

### Fix underwater title BG flash on game start

When `updateTitle(dt)` set `titleState='done'` mid-frame, `drawTitleSkyInHUD()` was still called in the same iteration. With no matching state, it hit its `else` branch and drew the title underwater BG at full brightness in the top box for one frame (~50ms with dt cap), causing a visible flash.

Fix: re-check `titleState !== 'done'` before calling `drawTitleSkyInHUD()` in the game loop.

## 1.0.4 — 2026-03-22

### Fix top box battle BG flash at game start

When `hud-fade-in` ended and `'opening'` wipe started, `transTimer` reset to 0, causing `fadeStep = maxStep` (fully dark) on the first frame of opening — the top box flashed dark then re-brightened during the wipe.

Fix: `_topBoxAlreadyBright` flag set on `hud-fade-in → opening` transition. During `opening`, if flag is set, top box stays at `fadeStep = 0` (full brightness) for the entire wipe. Flag cleared when opening finishes.

## 1.0.3 — 2026-03-22

### Fix HUD fade-in after player select

**Root causes fixed:**
- Frame spike: `loadMapById` at game start caused a single large `dt` that consumed the entire 500ms `hud-fade-in` state in one frame — capped `dt` at 50ms in `gameLoop`
- Invisible fade: HUD border and info text used NES palette fading (dark colors on a black background look identical to the background) — switched to `globalAlpha` so the fade is actually visible
- Duration too short: increased `HUD_INFO_FADE_STEP_MS` from 100ms → 200ms (800ms total fade, then screen opens)

**Changes:**
- `gameLoop`: cap `dt = Math.min(dt, 50)` to prevent animation skipping on slow frames
- `drawHUD` game-start branch: alpha-based border fade instead of palette-fade canvases
- `_drawHUDInfoPanel`: `globalAlpha` for name text fade-in; battle HP/Level cross-fade unchanged
- `_drawTopBoxBattleBG` hud-fade-in: use `HUD_INFO_FADE_STEP_MS` to stay in sync with other elements
- `HUD_INFO_FADE_STEP_MS`: 100 → 200ms

## 1.0.2 — 2026-03-22

### Smooth HUD fade-in after player select screen

**Top box battle BG now fades in with the rest of the HUD:**
- `_drawTopBoxBattleBG` now handles `'hud-fade-in'` transState
- Fades from fully dark to full brightness using `hudInfoFadeTimer` in sync with portrait, roster, info panel, and HUD borders
- Previously the top box battle BG strip popped in immediately while everything else faded — now all elements animate together

## 1.0.1 — 2026-03-22

### Modularization continued — −451L from game.js

**New module `src/slash-effects.js`:**
- `initSlashSprites`, `initKnifeSlashSprites`, `initSwordSlashSprites` — punch/knife/sword slash frame builders
- Internal helpers: `_decode2BPPTiles`, `_buildSwordSlashFrame`, `_putPx16`

**New module `src/south-wind.js`:**
- `initSouthWindSprite` — builds 3-phase ice explosion canvases (16×16, 32×32, 48×48)
- Internal: `SW_TILES` PPU data, `_drawSWTile`, `_buildSWPhase1/2/3`

**New module `src/battle-bg.js`:**
- `renderBattleBg(romData, bgId)` — returns `{ bgCanvas, fadeFrames }` instead of setting globals
- `renderBattleBgWithPalette` — shared renderer used by title animations
- `_loadBattlePalette`, `_loadOceanTileData` — ROM data parsers
- Exports `BATTLE_BG_MAP_LOOKUP` and palette-C1/C2/C3 constants

**New module `src/title-animations.js`:**
- `initTitleWater(romData, titleFadeMax)` — returns `{ titleWaterFrames, titleWaterFadeTiles }`
- `initTitleSky`, `initTitleUnderwater`, `initTitleOcean` — return frame arrays
- `initUnderwaterSprites` — returns `{ uwBubbleTiles }`
- `initTitleLogo` — returns `titleLogoFrames` array
- Imports from `battle-bg.js`, `water-animation.js`, `palette.js`

**game.js call sites updated** to capture return values and assign to existing globals.

## 1.0.0 — 2026-03-22

### Modularization Phase 3 complete

**New module `src/canvas-utils.js`:**
- `_makeCanvas16`, `_makeCanvas16ctx` — 16×16 canvas creation helpers
- `_hflipCanvas16` — horizontal flip utility
- `_makeWhiteCanvas` — copies canvas with all opaque pixels set to NES white ($30)

**New module `src/water-animation.js`:**
- `_buildHorizWaterPair` — builds 16-frame horizontal water shift animation for a tile pair
- `_updateWorldWater(wmr, waterTick)` — animates world map water atlas
- `_updateIndoorWater(mr, waterTick)` — animates indoor map water tiles
- `resetWorldWaterCache`, `resetIndoorWaterCache` — called on map transitions
- All support functions (`_buildHorizWaterFrames`, `_buildWorldVertWaterFrames`, `_buildWaterCache`, etc.) internalized
- `HORIZ_CHR`, `VERT_CHR`, `ANIM_CHR` constants moved into module

## 0.9.9 — 2026-03-22

### Modularization Phase 2 (partial)

**New module `src/battle-layout.js`:**
- `_calcBoxExpandSize(fullW, fullH, isExpand, isClose, timer)` — box expand/close animation sizing (refactored to take `timer` as param instead of reading `battleTimer` global)
- `_encounterGridPos(boxX, boxY, boxW, boxH, count, sprH)` — pure monster grid positioning for 1–4 encounters

## 0.9.8 — 2026-03-22

### Modularization Phase 1 complete

**New module `src/text-utils.js`:**
- `_nameToBytes`, `_nesNameToString` — JS string ↔ NES byte encoding
- `_buildItemRowBytes` — inventory row formatter
- `_makeGotNText`, `makeExpText`, `makeGilText`, `makeFoundItemText` — battle result text builders

**New module `src/palette.js`:**
- `nesColorFade` — NES color fade step (bit math)
- `_makeFadedPal` — builds faded palette array
- `_stepPalFade` — fades palette colors in place

**New module `src/tile-math.js`:**
- `_getPlane0`, `_rebuild` — NES 2-bit plane extraction/merging
- `_shiftHorizWater` — horizontal water tile shift
- `_isWater`, `_buildHorizMixed`, `_writePixels64`, `_writeTilePixels` — pixel/tile helpers

**New module `src/data/animation-tables.js`:**
- `BAYER4` — 4×4 Bayer dithering matrix (boss dissolve)
- `DMG_BOUNCE_TABLE`, `_dmgBounceY` — damage number bounce animation (FCEUX trace data)

## 0.9.7 — 2026-03-22

### Modularization continued

**Extracted to `src/data/players.js`:**
- `ROSTER_FADE_STEPS` — roster fade constant (was module-level in game.js)
- `generateAllyStats(player)` — nearly pure function computing ally stats from player pool entry

## 0.9.6 — 2026-03-22

### Modularization + bug fixes

**Extracted to `src/data/items.js`:**
- `isHandEquippable`, `isWeapon`, `weaponSubtype`, `isBladedWeapon` — pure item query functions

**New module `src/save.js`:**
- `openSaveDB` — IndexedDB open helper
- `serverDeleteSlot` — server save deletion
- `parseSaveSlots` — parse raw save data into slot array (refactored from `_parseSaveSlots` to return value instead of mutating global)

**Bug fixes (M99 regressions):**
- `_drawPauseInventory` — `fadeStep` was undeclared (orphaned by M99 function split), causing ReferenceError and missing inventory cursor
- `_drawPauseEquipSlots` — same issue, caused missing equip screen cursor + soft-lock
- `_drawPauseEquipItems` — same issue, caused missing item-select cursor in equip screen

## 0.9.5 — 2026-03-22

### M99: game.js refactor (continued) + bug fix — 8477L → 8320L (−157L)

Continued pure structural refactoring of `src/game.js`. No new features or behavior changes.

**New helpers extracted:**
- `_recalcCombatStats()` — 5 sites (`playerATK = str + weapons; recalcDEF()`)
- `_startMoveFromKeys(resetOnIdle)` — 2 sites (arrow key → startMove dispatcher)
- `_makeGotNText(amount, suffix)` — shared core of `makeExpText` / `makeGilText`
- `_makeCanvas16ctx()` — 3 sites (returns `[canvas, ctx]` for 16×16 canvases)

**Deduplication:**
- `_FP_KNIFE_R` / `_FP_KNIFE_L` / `_FP_KNEEL` — removed duplicate inline tile arrays in `_initBattleKnifeBodySprites` / `_initBattleLowHPSprites`
- `_BATTLE_LAYOUT` — replaced 4 inline `const layout = [[0,0],[8,0],[0,8],[8,8]]`
- `_makeFadedPal(fadeStep)` — replaced 4 inline fade-palette build loops
- `_clipToViewport()` — replaced 4 inline `ctx.save/beginPath/rect/clip` blocks
- `_buildWorldHorizWaterFrames` collapsed to call `_buildHorizWaterFrames` (identical logic)
- `invincibleFadeFrames` / `invincibleShadowFade` — two identical fade loops unified into single `Array.from` + map
- `rosterBattleFade` out/in branches unified into direction-based single block

**Bug fix:**
- `_calcBoxExpandSize` — fixed self-referential infinite recursion introduced by automated refactor script; restored correct expand/close interpolation logic

## 0.9.4 — 2026-03-22

### M97–M98: game.js refactor (continued) — 8736L → 8477L (−259L)

Continued pure structural refactoring of `src/game.js`. No new features or behavior changes.

**New module-level helpers extracted:**
- `_makeCanvas16()` — 6 sites
- `_hflipCanvas16(src)` — 4 sites (horizontal-flip 16×16 canvas)
- `_playerStatsSnapshot()` — 5 sites (save slot stats object)
- `_syncSaveSlotProgress()` — 3 sites (level/exp/stats/inventory/gil sync)
- `_zPressed()` / `_xPressed()` — 9 + 10 sites (key consume helpers)
- `_resetBattleVars()` — 2 sites (22-line battle state reset block)
- `_loadBattlePalette(romData, bgId)` — 3 sites
- `_shiftHorizWater(cL, cR)` — 3 sites (bit-rotation for water animation)
- `_buildHorizWaterPair(bL, bR)` — 3 sites
- `_grayViewport()` — 2 sites (saturate-0 gray overlay)
- `_pausePanelLayout()` — 2 sites (pause menu scroll position)
- `_pauseFadeStep(inState, outState)` — 3 sites
- `_drawHudWithFade(fullCanvas, fadeCanvases, fadeStep)` — 2 sites
- `_encounterGridLayout()` — 4 sites (encounter box + grid position)
- `_buildItemRowBytes(nameBytes, countStr)` — 2 sites

**Deduplication:**
- `_renderDecodedTile` collapsed to alias for `_blitTile` (identical logic)
- `_renderPortrait` simplified from 17L to 3L using `_blitTile` + `_makeCanvas16`
- 4 inline 64-pixel tile loops replaced with `_blitTile` calls (`initLandTurtleBattle`, `_renderGoblinSprite`, `initMoogleSprite`, `renderSpriteFaded`)

## 2026-03-21

### M89–M90: Refactor/modularize game.js (continued)

- **M89**: `_handlePauseInput` (300L→15L) split into 6 subs (`_pauseInputOpenClose`, `_pauseInputMainMenu`, `_pauseInputInventory`, `_pauseInputInvTarget`, `_pauseInputEquip`, `_pauseInputEquipItemSelect`); `drawPauseMenu` (247L→28L) split into 5 subs (`_drawPauseBox`, `_drawPauseMenuText`, `_drawPauseInventory`, `_drawPauseEquipSlots`, `_drawPauseEquipItems`); `initFakePlayerPortraits` (239L→4L) into `_genPosePortraits` (module-level helper) + `_initFakePosePortraits` + `_initFakeFullBodyCanvases`; `drawBattleMenu` item panel extracted as `_drawBattleItemPanel`; `drawBossSpriteBox` (235L→35L) split into `_drawBossSpriteBoxPVP` + `_drawBossSpriteBoxBoss`
- **M90**: `_updateBattlePlayerAttack` (206L→9L) split into `_finalizeComboHits` + `_advanceHitCombo` (shared helpers eliminating duplicate combo-finalize logic) + 6 state subs (`_updatePlayerAttackStart/Slash/HitShow/MissShow/DamageShow` + `_updateMonsterDeath`); `updateTitle` (221L→46L) into `_updateTitleUnderwater` + `_updateTitleSelectCase` + `_updateTitleMainOutCase`; `drawTitle` (223L→45L) into 5 subs (`_drawTitleCredit`, `_drawTitleLogo`, `_drawTitleShip`, `_drawTitlePressZ`, `_drawTitleSelectBox`)

## 2026-03-21

### M87–M88: Refactor/modularize game.js

- **M87**: Extracted pure data/math into ES modules — `battle-math.js` (combat formulas), `data/players.js` (PLAYER_POOL, palettes, chat phrases), `data/strings.js` (all NES-encoded text constants), `data/monster-sprites.js` (PPU-dumped tile bytes); split `handleInput` (849L) and `updateBattle` into focused sub-functions with true/false dispatcher pattern
- **M88**: `initBattleSprite` (590L→14L) split into 7 sub-functions + 5 low-level tile helpers (`_blitTile`, `_blitTileH`, `_buildCanvas4`, `_buildCanvas4ROM`, `_drawTileOnto`) eliminating repeated decode loops; `drawHUD` (296L→49L) split into `_drawHUDTopBox/Portrait/InfoPanel/LoadingMoogle`; `drawBattle` (266L→75L) split into `_drawBattlePortrait`

## 2026-03-21

### M85–M86: Email auth, server saves, PVP duel system

- **M85**: Email auth + server saves — register/login UI, JWT tokens, SQLite on DigitalOcean droplet, `/api/*` endpoints, server-first save load with IndexedDB fallback
- **M86**: PVP duel system — "Duel" in roster context menu, challenge flow with random 1.5–4s accept delay, `startPVPBattle()` reusing boss-style battle engine; opponent portrait scaled 3× with HP bar, AI: 70% attack / 30% defend; victory grants 5×level EXP + 10×level Gil; dual-wield infrastructure added (pvp-second-windup state, per-hand canvases) but currently inactive

## 2026-03-19

### M82–M84: Altar Cave enemies, SouthWind polish, mobile controls

- **M82**: Altar Cave enemies — Carbuncle, Eye Fang, Blue Wisp random encounter sprites from FCEUX PPU dump; mixed enemy encounters with bottom-aligned sprite grid
- **M83**: SouthWind polish — damage numbers float above explosion, damage split evenly among targets; ally crit flash, world map choke block, pause blocked during msgBox
- **M84**: Mobile controls — utility row (CHAT/LOG/SELECT/START) + D-pad + A/B buttons, touch→KeyboardEvent mapping; canvas edge-to-edge flush layout; hidden `type=password` input at `top:0` for iOS/Android keyboard (critical: do not move); CRT vignette replaces scanlines on ≤520px; save wipe fix (savesLoaded flag)

## 2026-03-18

### M81: Walk sprite fix

- **M81**: NES-accurate walk frames — correct WALK_FRAMES tile IDs, `bottomFlip` for DOWN/UP frame 1 (matching ROM sprite data from FCEUX)

## 2026-03-16

### M79–M80: Roster HUD revamp, chat system

- **M79**: Roster HUD revamp — per-player dynamic border boxes, ROSTER_ROW_H=32, slide-in animations, 10-second turn timer with visual countdown
- **M80**: Chat system — Press Start 2P font, auto-generated player messages, t/T keys for input/expand, bottom HUD panel with NES fades

## 2026-03-15

### M78: Battle assist allies

- **M78**: Battle assist allies — fake roster players join random battles, full turn queue integration, enemies can target allies; ally arrival animation, ally fade-out on victory

## 2026-03-11

### M76–M77: Weapon sprites, MMO roster

- **M76**: Weapon sprites — sword/dagger/knife blade canvases from FCEUX PPU captures, slash effects, weapon subtype helpers (`weaponSubtype`, `isBladedWeapon`, `getSlashFramesForWeapon`)
- **M77**: MMO roster — 18 fake players across 8 NES palettes, location-aware filtering, S key browse + context menu with location display

## 2026-03-10

### M65–M72: Message box, game over, potion animation, armor system

- **M65**: Universal message box — `showMsgBox(bytes, onClose)` replaces roar box and chest message; word wrap via `_wrapMsgBytes()`, box stretches vertically
- **M66**: Battle text speed — BATTLE_TEXT_STEP_MS 100→50ms
- **M67**: Game over screen — defeat fade→text→reload, wipe to world map, full HP restored on continue
- **M68**: Potion/cure animation — defend pose during item use, cure sparkle at 4 portrait corners (PPU $4D/$4E tiles, two alternating 16×16 configs)
- **M69**: Pause menu potion use — battle-style hold/swap, cure sparkle + bouncing heal number during pause
- **M70**: Armor system — 5 equip slots (head/body/hands/footR/footL), playerDEF = VIT + equipped DEF, save/load with backward compat
- **M71**: Pause menu equip screen — 5 slot rows + Optimum button, type-validated equip/unequip with animated border expand
- **M72**: Chest loot rarity — Common 60% Potion, Uncommon 28%, Rare 10%, Legendary 2% SouthWind

## 2026-03-05

### M61–M64, M56–M60: Title/HUD polish, item target, gil, battle shake

- **M56**: Item target select — cursor moves to player portrait or enemy grid after selecting consumable
- **M57**: Gil system — monsters drop gil, boss drops 500, victory flow extended: Victory→EXP→Gil→Level Up
- **M58**: Battle scene shake — top box battle BG shakes ±2px horizontally on player hit
- **M59**: Bottom panel slide cleanup — `ctx.translate`-based slide for correct clipping
- **M60**: Title screen logo fix — FCEUX pixel capture, 160×21px composited from PPU dump
- **M61–M64**: Title/HUD NES fades — viewport border fade-in at game start, HUD border fade sequence, game start delay, player select overhaul (center-expand animation), underwater BG scene

## 2026-03-04

### M46–M55: Defend, turn order, near-fatal, items, run command

- **M46**: Defend action — halves incoming damage, defend pose + sparkle animation (PPU $47-$4C tiles), SFX $61
- **M47**: Turn order — priority-based queue: Player (AGI×2)+rand(256), Enemy rand(256)
- **M48**: Near-fatal pose — kneel sprite (PPU $09–$0C) + 2-frame sweat dot animation at HP ≤ maxHP/4
- **M49**: Item system — `playerInventory {id:count}`, Potion from chests, battle item-select menu (page-based, hold/swap mechanic)
- **M50**: Chest message box — NES-style blue box slide-in/out with text fade, TREASURE SFX
- **M51**: Pause menu inventory — animated border expand/shrink, NES text fade transitions
- **M52**: FF1 pause music — third libgme emulator, FF1 menu track (NSF 16) during pause
- **M53**: Music pause/resume — `pauseMusic()`/`resumeMusic()` stash emulator state; music resumes from position
- **M54**: Run command — escape chance formula, "Ran away…"/"Can't run", portrait h-flip + slide-out animation
- **M55**: Item system overhaul — spatial cursor navigation, item equip↔inventory swaps

## 2026-03-03

### M42–M45: Knife sprites, blade position, miss, crit flash

- **M42**: Knife weapon sprites — blade from PPU $4C, two canvases (raised/swung), 2-frame swing animation, KNIFE_HIT SFX
- **M43**: Blade position fix — trace-accurate placement from FCEUX OAM data
- **M44**: Miss behavior — attack pose + SFX plays but no slash effect on target
- **M45**: Critical hit flash — 1-frame orange backdrop (#DAA336, NES $27) on crit

## 2026-03-01 – 2026-03-02

### M38–M41: Random encounters, Goblin sprites, battle polish, victory flow

- **M38**: Random encounters — Goblins (1–4) on dungeon floors 0–3, step counter, encounter box, 2×2 monster grid, target-select cursor, Run command, dynamic EXP text, victory box
- **M39**: Goblin battle sprites — ROM tile decode (0x40010), dual palette, 32×32 canvas, slide-in from left, dithered diagonal death dissolve (Bayer 4×4), MONSTER_DEATH SFX
- **M40**: Battle sequence polish — authentic damage bounce (30-frame FCEUX keyframe table), purple damage numbers, green "Miss" text, punch scatter ±20px
- **M41**: Victory flow polish — victory music, portrait attack/victory/hit poses, fist sprite, 250ms idle/victory flash

## 2026-02-28

### M32–M37: Player select, save slots, loading screen, boss battle, leveling

- **M32**: Player select screen — 3 save slots, name entry (a–z/A–Z, max 7 chars), blinking cursor, delete option
- **M33**: Save persistence — IndexedDB stores save slots (key `saves` in `ff3mmo-roms` store), `beforeunload` hook
- **M34**: HUD info fade-in — portrait and HP/MP text NES-fade in on game start (4 steps × 100ms)
- **M35**: Loading screen layout — scrolling battle BG (32px top), bordered info box (floors+boss+HP centered), moogle+chat in right HUD panel
- **M36**: Land Turtle boss battle — battle state machine, roar box, grayscale strobe, turn-based combat, target-select cursor, boss pre-attack white flash, portrait shake, sine-bounce damage numbers
- **M37**: Leveling system — EXP table from ROM (0x0720C0), stat bonuses (0x0721E6), HP growth formula, `grantExp()`, save slots store level/exp/stats

## 2026-02-20

### M28–M31: Loading screen, title screen, pause menu, NES fades

- **M28**: Loading screen overhaul — moogle sprite, boss in menu border, chat bubble, NES fade in/out, generation deferred to piano intermission
- **M29**: Pause menu — bordered panel, hand cursor, 6 menu items, NES text fade, Enter/X toggle
- **M30**: Area name NES fades — discrete palette stepping, simultaneous with wipe transitions
- **M31**: Title screen — credit text, sky+ocean background in top box, ship sprite, NES fades, "Press Z" prompt
- Floor 2 tuning — chamber 9–13×9–13, traps 3–5, chests 4–6
- Floor 4 tuning — 2–3 bones in boss door room

## 2026-02-16

### M18–M27: Text system, HUD, boss sprite, ROM cache

- **M18**: IPS patcher — applies English translation patch (Chaos Rush v1.3) at runtime
- **M19**: Text decoder — reads item/monster/spell names from patched ROM text tables
- **M20**: Data catalogs — monsters, items, shops, encounters, NPCs (no copyrighted strings in source)
- **M21**: Font renderer — ROM font tiles to canvas, loading screen uses ROM font
- **M22**: HUD top box — battle background scene (non-town) or blue banner with area name (town)
- **M23**: FF1&2 ROM loading — dual ROM file picker, Adamantoise sprite extraction
- **M24**: Boss sprite — Adamantoise in crystal room center stage, Land Turtle palette, h-flip animation
- **M25**: NES palette fade — authentic FF3 $FA87 algorithm on battle scene box (discrete color steps toward $0F)
- **M26**: Area name scroll — blue banner scrolls down on entry, up on exit (150ms timing, loading screen too)
- **M27**: ROM cache — IndexedDB stores both ROMs, Start button on reload (audio context needs user gesture)

## 2026-02-14

### M7–M17: Dungeon floors, music, world map, crystal room

- **M7**: Music system — NSF built from ROM banks + libgme, SFX dual emulator
- **M8**: Water tile animation — per-row cascade effect
- **M9**: Flame sprites + passage earthquake + Town of Ur 100% complete
- **M10**: Altar Cave floor 2 — corridor+chamber layout, trap holes, chests, bones
- **M11**: Dungeon loading screen — generation deferred to piano intermission (floor 1 entry)
- **M12**: Door open delay — 400ms pause after creak SFX before wipe
- **M13**: HUD system — 6-panel layout with real FF3 border tiles, FF1 black interior
- **M14**: Altar Cave floor 3 — rock puzzle, Z-shaped layout, false wall, chests, bones
- **M15**: Altar Cave floor 4 — T-shape corridor, organic rooms, branch alcoves, pond room, boss door
- **M16**: Crystal room (floor 5) — tileset 2 blue palettes, ROM map 148 diamond layout, song $36
- **M17**: Star spiral effect — crystal room warp teleport + pond healing trigger
- Altar Cave layout 100% complete (4 floors + crystal room, all triggers/doors/music working)
- Repo cleanup — untracked ROM, removed dead code and debug artifacts

## 2026-02-12

### Initial commit

- Repo cleanup — removed generated assets, added .gitignore for ROM/output files

## 2026-02-07

### M1–M6: Core engine, Town of Ur, world map, Altar Cave floor 1

- **M1**: Walking sprite, animation, keyboard input
- **M2**: Town of Ur (map 114) rendering, collision, player at entrance
- **M3**: Room transitions — door triggers, exit_prev, map stack
- **M4**: World map — floating continent 128×128, exit/enter towns
- **M5**: Action button (Z key), vase house secret passage
- **M6**: Altar Cave dungeon generator — 3 floors + boss room, secret paths
