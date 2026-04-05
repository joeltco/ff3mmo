# game.js Refactor TODO

Current size: **4,208 lines**. Target: <4,000 lines.

---

## Next Up

### 1. Canvas cache consolidation (~40 vars → 1 object)
Group ~40 scattered `let xxxCanvas = null` / `let xxxFrames = null` declarations (lines 134–389) into a single `spriteCache` object. No behavior change — just init cleanup.

### ~~2. `src/battle-ally.js` extraction (~123L)~~ DONE
Extracted `updateBattleAlly` + 5 private helpers. `_allyShared()` in game.js (35L). Net: −83L.

### ~~3. `_processEnemyFlash` + `_updateBattleEnemyTurn`~~ DONE
Extracted to `src/battle-enemy.js` (~76L). `_enemyShared()` in game.js.

### 3b. `src/battle-items.js` extraction DONE
Extracted `startMagicItem`, `updateMagicItemThrowHit`, target selection, damage application (~150L).
`_magicItemShared()` in game.js. Designed for multiple spell items.

### 3c. `src/damage-numbers.js` extraction DONE
All damage/heal number state, palettes, tick, reset, drawing helper (~102L).
Miss sprite rendered from ROM tiles $1B4D0/$1B4E0 (green "MISS" with black outline).

### 4. `battleCtx` grouping (~40 battle vars → 1 object)
Group `battleState`, `battleTimer`, `bossDamageNum`, `playerDamageNum`, `bossHP`, `bossDefeated`, `battleShakeTimer`, `critFlashTimer`, `turnQueue`, `encounterMonsters`, etc. (lines 289–462) into a `battleCtx` object.
**Do last** — search/replace pass across the whole file. Enables further extraction.

### 5. `_syncSaveSlotProgress` dedup
9L function called at 4 sites, always paired with `saveSlotsToDB()`. Fold into `_triggerPVPVictory` / `_triggerBossVictory` / consolidate.

---

## Hard (deeply coupled, needs architectural redesign)

- [ ] Split `_processBossFlash()` (49L) → `_targetAllyForAttack`, `_calculateAllyDamage`, `_calculatePlayerDamage`
- [ ] Consolidate battle sprite canvas cache (~90L) into `battleSpriteCache` object
- [ ] Group raw globals (L46–704, ~620L) into state objects: `battleState`, `rosterState`, `chatState`, `transitionState`, `pauseState`, `titleState`

---

## Won't Extract (too entangled)

- Roster draw/update — coupled to too many game globals
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
