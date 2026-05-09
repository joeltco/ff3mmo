# ff3mmo Refactor Plan — May 2026

Snapshot from project evaluation at v1.7.181. Each task is independently shippable; deploy one at a time and smoke-test before moving on.

## Order of operations

1. **Extract `tile-canvas.js`** — dedupe `_decodeTilePixels` + `_make8` (3 callers)
2. **Split `battle-drawing.js`** (1801 lines → 4–5 files)
3. **Extract `pvp-drawing.js`** from `pvp.js`
4. **Split `input-handler.js`** — pause section → `pause-menu.js`

Memory rules apply throughout:
- Bump `package.json` + CHANGELOG + commit msg per deploy
- Smoke test (headless-load, grep pm2 for `ReferenceError`) after each
- pm2 logs first if anything looks broken post-deploy

---

## Task 1 — `tile-canvas.js` (dedupe)

### Problem
`_decodeTilePixels` and `_make8` are duplicated byte-for-byte across:
- `src/cast-anim.js:153`
- `src/spell-anim.js:119`
- `src/projectile-anim.js:72` (renamed `_decodePixels`, same body)

`src/tile-decoder.js` already has `decodeTile` returning RGBA, but the spell-anim helpers want a raw `Uint8Array(64)` palette-index array (not RGBA) and a canvas output (not direct draw). So `tile-decoder.js` doesn't fit.

### Plan
Add to `src/tile-decoder.js` (or new `src/tile-canvas.js`):
- `decodeTilePixels(d) → Uint8Array(64)` — 2bpp planar decode
- `make8Canvas(tile, pal) → HTMLCanvasElement` — palette-aware 8x8 canvas
- `hflipCanvas(src) → HTMLCanvasElement` — already in `spell-anim.js:216`

Replace 3 callsites. ~50 lines deleted, zero behavior change.

### Risk
Low. Pure data → pure data, no async, no state.

### Smoke
- Load battle, cast Cure, Fire, throw a knife (projectile), confirm visual unchanged.

---

## Task 2 — Split `battle-drawing.js`

### Problem
1801 lines, 7 distinct concerns. Hard to navigate; touching one section risks breaking another.

### Subgroups (current line ranges)

| Concern | Lines | Target file |
|---|---|---|
| Player portrait + weapon overlays | 18–470 | `battle-draw-player.js` |
| Spell projectile + on-target | 540–690 | move into `combatant-cast.js` (already exports `drawSpellThrow`) |
| Battle menu (item/magic/cursor) | 691–960 | `battle-draw-menu.js` |
| Encounter monsters + cursors | 964–1140 | `battle-draw-encounter.js` |
| Boss sprite box + dissolve | 1140–1350 | folds into encounter file |
| Victory box + reward text | 1351–1418 | folds into menu file |
| Ally rows | 1419–1670 | `battle-draw-allies.js` |
| Damage numbers + msg strip | 1670–1800 | `battle-draw-fx.js` |

Final layout: 5 sibling files + a thin `battle-drawing.js` entry that just re-exports `drawBattle`, `drawBattleAllies`, etc.

### Shared helpers to relocate
- `HUD_VIEW_*`, `BATTLE_PANEL_W`, layout constants → `battle-layout.js` (already exists, 47 lines)
- `_jobPalette`, `_cursorTileCanvas`, `_pvpEnemyCellCenter`, `_encounterGridLayout` → new `battle-draw-shared.js` or `battle-layout.js`

### Risk
Medium. Many cross-references between subgroups via small helpers. Mechanical move + import fixes.

### Smoke
- Encounter battle (player + 2 allies vs 4 monsters) — full round
- PVP duel — full round
- Boss fight (Adamantoise) — open-dissolve animation
- Cure cast on ally
- Item use (potion)
- Victory + reward screen

---

## Task 3 — Extract `pvp-drawing.js`

### Problem
`pvp.js` (1225 lines) is state + AI + drawing. Drawing should follow the convention set by `battle-drawing.js`.

### Plan
Move from `pvp.js` to new `src/pvp-drawing.js`:
- `_drawSparkleAtCorners` (line 930)
- `drawBossSpriteBoxPVP` (line 938)
- `_drawPVPEnemyCell` (line 1010)
- Any other `_draw*` helpers below line 930

Keep state, AI (`_tryPVPEnemy*`), and `_processPVP*` updaters in `pvp.js`.

### Risk
Low. Drawing reads `pvpSt` but doesn't call back into AI.

### Smoke
- PVP duel start — opponent box appears
- PVP enemy cure cast — sprite box stays visible
- PVP victory dissolve

---

## Task 4 — Split `input-handler.js`

### Problem
1287 lines, 4 contexts: battle / roster / tab-select / pause. Pause section (~470 lines, lines 794–1268) is heavily entangled with `pauseSt` from `pause-menu.js`.

### Plan
Move pause input handlers **into** `pause-menu.js`:
- `_pauseInput*` (10 functions)
- `_applyPause*` (2 functions)
- `_enforceEquipRestrictions`, `_equipBest*`, `_equipOptimum`
- Top-level `handlePauseInput` export

Keep in `input-handler.js`:
- Battle input (lines 109–622)
- Roster input (lines 643–752)
- Tab select (lines 755–793)
- Top-level `keys`, `inputSt`, `initKeyboardListeners`

`pause-menu.js` becomes ~1030 lines but cohesively pause-only.

### Risk
Medium. The pause input touches `inputSt`, `pauseSt`, `ps`, `roster`, equipment helpers — all currently importable from `input-handler.js`. Imports need updating in `pause-menu.js`.

### Smoke
- Pause open/close, tab nav
- Inventory use (potion, antidote)
- Magic cast from pause (Cure on ally)
- Equipment swap + auto-optimize
- Job change

---

## Out of scope (intentionally)

- `dungeon-generator.js` (2392 lines) — algorithmic, churn > value
- `battle-update.js` (808 lines) — state machine cohesion
- `combatant-*` family — already the cleanest part of the codebase
- `src/data/*` — pure data
- Files <200 lines

## Speculative / future

- Centralize `*State` stores under `state/` directory (cosmetic)
- `battle-state.js → pvp.js` circular smell — move `getEnemyHP`/`setEnemyHP` to PVP-aware location
- Encounter/PVP grid layout sharing — possible `battle-grid.js` after #2 + #3
