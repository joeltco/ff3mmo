# Changelog

All notable changes to this project are documented here.

## [Unreleased]

_No unreleased changes._

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
