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
