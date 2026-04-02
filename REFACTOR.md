# game.js Refactor TODO

Current size: ~5,465 lines. Target: <4,000 lines.

---

## Easy Wins (self-contained, minimal deps)

- [x] Extract `src/chat.js` — `addChatMessage`, `updateChat`, `drawChat`, `_drawChatExpandBG`, `_drawChatTextArea`, `_buildChatRows`, `_drawChatInput`, `_chatWrap` (~150L)
- [x] Extract `src/message-box.js` — `showMsgBox`, `updateMsgBox`, `_wrapMsgBytes`, `drawMsgBox` (~100L)
- [x] Extract `src/title-screen.js` — `updateTitle`, `_updateTitleSelectCase`, `_updateTitleMainOutCase`, `_updateTitleUnderwater`, `titleFadeLevel`, `titleFadePal`, `drawTitle`, `drawTitleSky`, `drawTitleSkyInHUD`, `drawTitleUnderwater`, `drawTitleOcean`, `drawTitleWater`, `_drawTitleWaterRows`, `_titleParallaxSpeed`, `drawUnderwaterSprites`, `_drawTitleCredit`, `_drawTitleLogo`, `_drawTitleShip`, `_drawTitlePressZ`, `_drawTitleSelectBox`, `drawPlayerSelectContent`, `_drawSelectSlot` (~300L)

---

## Medium (partially self-contained)

- [x] Extract `src/input-handler.js` — all `_handleBattleInput`, `_battleTargetNav`, `_battleTargetConfirm`, `_itemSelectNav`, `_itemSelectZ`, `_itemSelectSwap`, `_handleRosterInput`, `_handlePauseInput`, `_pauseInput*`, `_equipBest*` functions (~674L). Exports `inputSt` (20-prop mutable state shared with game.js draw/update) + `handleBattleInput`, `handleRosterInput`, `handlePauseInput`.
- [x] Extract `src/pause-menu.js` — `updatePauseMenu`, `_updatePause*Transitions`, `_drawPauseBox`, `_drawPauseMenuText`, `_drawPauseInventory`, `_drawPauseEquipSlots`, `_drawPauseEquipItems`, `_drawPauseStats` (~400L)
- [x] Extract `src/transitions.js` — `startWipeTransition`, `updateTransition`, `_updateTransition*`, `drawTransitionOverlay`, `updateTopBoxScroll` (~250L)
- [x] Extract `src/map-triggers.js` — `checkTrigger`, `_checkWorldMapTrigger`, `_checkHiddenTrap`, `_checkDynType1`, `_checkDynType4`, `_checkExitPrev`, `_triggerMapTransition`, `_handleChest`, `_handleSecretWall`, `_handleRockPuzzle`, `_handlePondHeal`, `applyPassage`, `openPassage`, `findWorldExitIndex` (254L). Uses `_triggerShared()` pattern with get/set props.

---

## Hard (deeply coupled, major refactor)

- [ ] Split `initHUD()` (330L) into:
  - `_initHUDBordersAndCanvases()` — border tiles + HUD canvases
  - `_initBattleSprites()` — all pose sprite caches
  - `_initFakePlayerPortraits()` — fake player portrait system
- [ ] Group raw globals (L46–704, ~620L) into state objects:
  - `battleState` — all `battle*` vars
  - `rosterState` — all `roster*` vars
  - `chatState` — all `chat*` vars
  - `transitionState` — all transition/wipe vars
  - `pauseState` — all pause menu vars
  - `titleState` — all title vars
- [ ] Consolidate 90L canvas cache declarations into a single `battleSpriteCache` object
- [ ] Split `_processBossFlash()` (49L) → `_targetAllyForAttack`, `_calculateAllyDamage`, `_calculatePlayerDamage`
- [ ] Split `_itemSelectSwap()` (45L) → `_swapInvInv`, `_swapInvEquip`, `_swapEquipEquip`
- [ ] Split `_updatePlayerDamageShow()` (34L) → separate handlers for death / exp gain / PVP victory
- [ ] Clean up `_drawPauseStats()` (80L) — separate stat calc, icon rendering, font layout

---

## Won't Extract (too entangled)

- Roster draw/update — coupled to too many game globals (noted in M87–M99)
- Full rendering core — canvas state too entangled
- Battle state machine — needs architectural redesign first

---

## Phase 2 Analysis (2026-03-30) — Next Extraction Targets

game.js is now **~5,460L**. Analysis of remaining candidates:

### Quick Wins (do first)

#### 1. ~~`src/pvp-math.js` (~30L extracted)~~ ✅ DONE
- Exported `pvpGridLayout(totalEnemies)`, `pvpEnemyCellCenter(idx, totalEnemies)`, `PVP_CELL_W/H`
- game.js `_pvpEnemyCellCenter` → thin wrapper calling `pvpEnemyCellCenter`
- pvp.js `tryJoinPVPEnemyAlly` + `drawBossSpriteBoxPVP` now import from `pvp-math.js`

#### 2. `src/battle-ally.js` (~220L extracted)
Already grouped, already follow same patterns as extracted modules.
- Extract: `_updateAllyJoin`, `_updateAllyAttack`, `_updateAllyDamageShow`, `_updateAllyEnemyHit`, `_updateAllyKOSequence`, `_updateBattleAlly`
- Keep in game.js: `_tryJoinPlayerAlly` (needs turnQueue, inputSt), player turn handlers
- Use `_allyShared()` pattern (same as `_pvpShared`, `_inputShared`)
- **Needs shared context getters/setters for:** `battleState`, `battleTimer`, `bossDamageNum`, `allyHitResult`, `allyDamageNums`, `allyShakeTimer`, `currentAllyAttacker`, `enemyTargetAllyIdx`, `critFlashTimer`, `bossHP`, `encounterMonsters`, `pvpSt`
- **Blocker:** Medium — wiring up shared context

#### 3. ~~`src/battle-sfx.js` (~15L, consolidation only)~~ ✅ DONE
- Exported `playSlashSFX(weaponId, isCrit)` with shared `_sfxCutTimerId`
- Replaced 3 inline copies: game.js player attack, game.js ally attack, pvp.js `_playSlashSFX`

---

### Medium Effort

#### 4. `src/battle-drawing.js` (~1,340L extracted — biggest single win)
All `draw*` + `_draw*` rendering functions. Gets game.js under 4,000L alone.
- Candidates: `drawBattle`, `drawBattleMenu`, `drawBattleAllies`, `drawEncounterBox`, `drawBossSpriteBox`, `drawBossSpriteBoxPVP`, `drawVictoryBox`, `drawDamageNumbers`, `_drawBossDmgNum`, `_drawEnemyHealNum`, `drawSWExplosion`, `drawSWDamageNumbers`, plus ~20 internal `_draw*` helpers
- **Blocker:** Reads ~20 globals. Needs read-only shared state object with getters — same pattern already used by pvp.js. ctx passed as parameter.
- **Do after:** `pvp-math.js` (used inside drawing functions)

#### 5. Group globals into `battleCtx` object (~40 vars → 1 symbol)
Prerequisite for fully decoupling update/render modules.
- `battleState`, `battleTimer`, `bossDamageNum`, `playerDamageNum`, `bossHP`, `bossDefeated`, `battleShakeTimer`, `critFlashTimer`, `currentHitIdx`, `slashFrame`, `turnQueue`, etc.
- **Blocker:** Touches every function in the file. Do in one pass with search/replace.

---

### Duplications to Fix (no new file needed)

| Location | Duplicate of | Fix |
|---|---|---|
| ~~game.js ally SFX~~ | ~~pvp.js `_playSlashSFX`~~ | ✅ `battle-sfx.js` |
| ~~pvp.js grid math~~ | ~~game.js `_pvpEnemyCellCenter`~~ | ✅ `pvp-math.js` |
| `_syncSaveSlotProgress()` called 5+ times before victory | — | Fold into `_triggerPVPVictory` / `_triggerBossVictory` |

---

### Estimated Line Counts After Each Step

| After step | game.js size |
|---|---|
| ~~+ `pvp-math.js`~~ | ~~~5,570L~~ ✅ 5,462L |
| ~~+ `battle-sfx.js`~~ | ~~~5,310L~~ ✅ (included above) |
| + `battle-ally.js` | ~5,190L |
| + `battle-drawing.js` | ~3,850L ✓ target hit |
| + `battleCtx` grouping | ~3,650L |
