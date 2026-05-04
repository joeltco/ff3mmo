# Changelog

All notable changes to this project are documented here.

## 1.6.92 — 2026-05-04

### Idle pose only at hand change (revert from per-hit)

Reverting the per-hit idle break from 1.6.91. Pattern is: right hand back→forward repeats for however many R hits, then ONE idle pose at the hand change boundary, then left hand back→forward repeats for however many L hits. Same-hand subsequent hits stay in back-swing pose between strikes (no idle in between).

`_updatePlayerAttackBack` back to the handChange branch using `IDLE_FRAME_MS`, with `HIT_COMBO_PAUSE_MS` for same-hand hits and `BACK_SWING_MS` for hit 0. `_getPortraitSrc` `interHitGap` renamed back to `handChangeGap` and only fires when the hand actually swapped.

## 1.6.91 — 2026-05-04

### Idle pose break between EVERY combo hit (not just R↔L hand swaps)

Previously the inter-hit gap held the back-swing pose for `HIT_COMBO_PAUSE_MS` (~30ms) and only inserted the idle pose on actual hand changes. Per "each hand should get whatever number of hits, each hit getting the 3 slash frames, idle pose, next hand repeats", every hit after the first now gets a `IDLE_FRAME_MS` (67ms) idle pose break before the next strike — same-hand and hand-change alike.

`_updatePlayerAttackBack` simplified: hit 0 = weapon back-swing (skipped for fists), hit 1+ = idle break. `_getPortraitSrc` renamed `handChangeGap` → `interHitGap` and fires for every hit > 0.

## 1.6.90 — 2026-05-04

### PvP-enemy + ally slash overlays use the same per-weapon scatter as the player

`drawSlashOverlay` now takes a `weaponId` and applies the same rule as `_updatePlayerSlash`: bladed → clean UR→LL diagonal, non-bladed → random ±8 per frame. Previously ally + PvP-opponent slashes were stuck on the legacy `[0,10,-8] / [0,-6,8]` shake regardless of weapon.

## 1.6.89 — 2026-05-04

### Slash scatter back to simple per-frame random for staff/nunchaku/fists

Reverted the per-weapon scatter system (1.6.86) and the 2-frame "skip slot N" hack (1.6.88). Back to: blades get the clean UR→LL diagonal (unchanged), everything else gets a small per-frame random offset (`Math.random()*16 - 8`) per the 3 timing slots. `SLASH_FRAMES` stays at 3 for all weapons; `drawSlashOverlay` is back to its original signature using the legacy `[0,10,-8] / [0,-6,8]` shake for ally/PVP slashes. `getSlashScatter` and the per-weapon scatter constants removed.

## 1.6.88 — 2026-05-04

### Slash effect for staff/nunchaku/fists is 2 frames AFTER the swing

Per PPU OAM comparison: the NES staff slash effect plays for **2 game frames** AFTER the player's arm has come down on the forward strike. Frame 1 of the effect is held empty (no slash sprite rendered yet); frame 2 has the sprite at one static position on the target. Both PPU snapshots showed a forward-strike pose, just at slightly different sub-poses — neither was a wind-up.

Previous engine ran a 3-frame scatter dance over the entire 150ms `player-slash` window. Now:
- `_STAFF_SCATTER` and `_PUNCH_SCATTER` are static `(0,0)` (sprite holds at one position).
- Both encounter and boss slash render paths skip drawing the slash sprite on `slashFrame === 0` for non-bladed weapons — so the visible flash starts on frame 1 and holds through frame 2 (~100ms post-swing).
- Bladed weapons untouched (no PPU verification yet — they keep the UR→LL diagonal).

## 1.6.87 — 2026-05-04

### Pause-menu inv-target cursor: scroll the roster instead of walking off

`pauseSt.invAllyTarget` Down past the visible roster window now bumps `inputSt.rosterScroll` so the roster panel scrolls in sync (mirroring the way normal roster browsing scrolls). Up below the visible window pulls scroll back. Also fixed `pause-menu.js` `ROSTER_VISIBLE` from `5` to `3` to match `roster.js` — that mismatch is what let the cursor walk one extra row past the bottom into empty space before stopping.

## 1.6.86 — 2026-05-04

### Per-weapon slash scatter — staves swing down, fists land in a tight cluster

Player slash and ally/PVP slash overlays now pick a per-weapon 3-frame offset pattern instead of the old "bladed = clean diagonal, everything else = random ±20" heuristic.

- `getSlashScatter(weaponId)` in `slash-effects.js` returns `{ x: [3], y: [3] }` per category:
  - **Staff / rod / nunchaku** → downward arc `(-2,4,8) / (-16,0,16)` matching the PPU-captured staff hit (origin shifted from y=58 to y=124 across hits).
  - **Fists** (weaponId 0) → tight `(-6,4,-2) / (-4,4,8)` impact cluster — replaces the old random ±20 jitter.
  - **Bladed** (knife/dagger/sword) → `(8,0,-8) / (-8,0,8)` clean upper-right → lower-left diagonal — same shape the player-slash code used to compute inline.
  - **Default** → legacy shake.
- `_updatePlayerSlash` and `_advanceHitCombo` in `battle-update.js` now read directly from `getSlashScatter(handWeapon)` — no more per-weapon `if/else`, no more `Math.random()` for non-bladed.
- `drawSlashOverlay(ctx, frame, frameIdx, originX, originY, mirror, weaponId)` takes the weapon id so ally + PVP-opponent slash overlays use the same per-weapon scatter as the player. Existing callers updated to pass the active hand's weapon id.

## 1.6.85 — 2026-05-04

### Nunchaku slash now shares the staff slash sprite

Second-frame PPU capture of the staff slash returned tile bytes byte-for-byte identical to frame 1 (just at different CHR addresses — $4D == $55, $4E == $56, etc.). The OAM positions differ per frame (origin shifts (+5,+66) between hits), and that bouncing is already handled by `drawSlashOverlay`'s scatter array — so the existing single-sprite `initStaffSlashSprites()` is correct as-is.

Per a hunch from PPU watching, also pointed nunchaku slash at the same `bsc.staffSlashFramesR` cache (was using a separate capture). The old `initNunchakuSlashSprites()` is left in `slash-effects.js` for now in case the hunch is wrong, but it's no longer called.

Per-frame positioning (OAM showed a much bigger vertical arc than the generic scatter does) is a polish followup — staff would benefit from a downward-arc scatter override.

## 1.6.84 — 2026-05-04

### Magic content: Poisona spell, Ur magic shop, staff slash sprite

- **Poisona spell (`0x35`).** Status-cure only — removes poison from the target, never heals HP. Wired into both battle (`spell-cast.js`) and pause-menu (`_applyPauseSpellUse`) via a new `SPELL_CURE_FLAG` map (`spell.type` → `STATUS.*`). White Mage now starts with Cure + Poisona. MP cost: 2.
- **Ur magic shop is live.** `openShop` now accepts `spells:` catalogs. Magic shop in Ur (map 3, counter 4,4) sells Cure (100 gil) and Poisona (100 gil). Spell list renders with `getSpellNameClean` + price right-aligned; confirm dialog reads "Learn X?". Buying deducts gil and pushes the spell ID into `ps.knownSpells`. "Already known" rejection if you re-buy. Sell tab is blocked for spell shops with an ERROR sfx (can't sell spells). New `SPELL_BUY_PRICE` table in `data/spells.js`.
- **Staff slash sprite.** New `initStaffSlashSprites()` in `slash-effects.js` using the PPU-captured tiles `$4D/$4E/$4F/$50` (SP3 palette `[0x0F, 0x17, 0x27, 0x37]`) from a White Mage staff swing. `getSlashFramesForWeapon` now routes `staff` and `rod` subtypes to it instead of the generic punch slash. Single-frame for v1; mid + late slash frames still need PPU capture for a true 3-frame anim.

## 1.6.83 — 2026-05-04

### Cure uses Potion's CURE SFX; pause-menu inv-target cursor aligns with roster rows

- **Battle Cure now plays `SFX.CURE`** instead of `SFX.SW_HIT`. `_applySpellEffect` in `spell-cast.js` branches on `spell.element === 'recovery'` so heal spells get the same chime as Potion. Damage spells will keep the SW hit sfx until per-spell sfx land.
- **Pause-menu inv-target cursor was drifting** lower by 8px per ally row — `pauseSt.menu.js` had `ROSTER_ROW_H = 24` while the actual roster (`roster.js`) draws rows at `ROSTER_ROW_H = 32`. Changed to 32 so Potion AND Cure target cursors land on the right portrait row.

## 1.6.82 — 2026-05-04

### Battle spell-list cost no longer clipped off the right edge

The bottom panel's outer clip is `rect(8, HUD_BOT_Y, CANVAS_W-16, HUD_BOT_H)` — right edge at x=248. The Cure cost was being drawn at x=244-252, so the right half of the "4" was getting clipped, looking like a stray glyph hanging off the panel. Re-anchored cost to `CANVAS_W - 16 - measureText(...)` so its right edge sits at x=240 (8px margin from the clip).

## 1.6.81 — 2026-05-04

### Cure target select: cycle player/allies/enemies; pause-menu Cure works like a Potion

**Battle:** removed the ally-only lock on heal spells in `_battleInputItemTargetSelect`. Left/Right now navigates to enemies the same way item-target select does — symmetric with how Potion behaves. Picking an enemy with Cure in v1 still heals the caster (since damage spells aren't wired yet); will route correctly once Black Mage spells land.

**Pause menu:** Cure now goes through the same target-select cursor as Potion — Z on a spell stashes it in `pauseSt.useSpellId` and transitions to `inv-target`, where Up/Down cycles player → roster allies. Confirming with Z calls `_applyPauseSpellUse` which deducts MP, applies the heal to the chosen target, and sets `pauseSt.healNum` (with `rosterIdx` if an ally was picked) so the green-number bounce lands on the right portrait.

## 1.6.80 — 2026-05-04

### Pause menu Magic submenu — proper spell list, not instant cast

Z on Magic in the pause menu now opens a real spell-select submenu. Piggybacks on the inventory state machine (`inv-text-out` → `inv-expand` → `inv-items-in` → `inventory`) via a new `pauseSt.menuMode = 'inv' | 'magic'` flag (mirrors the battle menu pattern).

- Magic mode renders `ps.knownSpells` with MP costs right-aligned, navigates with Up/Down, Z casts the highlighted spell on self (v1: ally-only spells), X exits back to the main pause menu.
- Cast reuses the existing `inv-heal` flow — green heal number bounces over the player portrait with the cure-sparkle overlay.
- Returning from `inv-heal` keeps the spell list visible (state stays `'inventory'`, menuMode stays `'magic'`) so the player can cast again or X out.
- `menuMode` resets to `'inv'` on `inv-text-in` → `'open'` so a future Item-cursor open starts in inventory mode.

## 1.6.79 — 2026-05-04

### Magic v1 polish: cure-sparkle visual, MND-based heal, encounter visibility

- **Cure visual swapped from SouthWind ice burst to the cure sparkle.** `bsc.cureSparkleFrames` (the same alternating-flip overlay used for pause-menu Potion heals and battle-item Potion) now flickers on the player portrait during `magic-cast` / `magic-hit` whenever a player-target heal is mid-cast. The SouthWind explosion no longer renders for spell casts.
- **Heal formula now uses MND (caster's mind), not INT.** Per NES FF3 disasm, white magic uses MND and black magic uses INT. `_rollMagicAmount(power, useMnd)` in `spell-cast.js` picks the right stat based on the spell's element (`recovery` → MND); pause-menu Cure does the same.
- **Encounter monsters no longer disappear during a cast.** `_isEncounterCombatState` and the PVP/boss equivalent state-lists now include `magic-cast`/`magic-hit`, so monsters stay drawn while the spell animates instead of hiding for ~1.1s.

## 1.6.78 — 2026-05-04

### Magic v1 fixups: pause-menu Cure, MP refill on /job, strip spell-name padding

- **Pause menu Magic now casts Cure on self.** `pauseSt.cursor === 1` (Magic) was a no-op since the menu shipped — Z press now deducts MP, applies the heal via the existing `inv-heal` flow with green-number bounce, and returns to the main pause menu (new `pauseSt.magMode` flag distinguishes from Item heals so we go back to `'open'` instead of `'inventory'`). Proper spell-pick UI is TODO; v1 shorts straight to Cure.
- **`/job N` now full-heals.** Switching jobs in the test console restores HP+MP to max so a freshly-switched White Mage can actually cast Cure (4 MP) without the Z press silently failing the cost gate.
- **New `/heal` and `/mp [N]` console commands** for ad-hoc top-ups during testing.
- **`getSpellNameClean(spellId)`** in `text-decoder.js` — allowlist filter (letters, digits, basic punct, space) that strips the magic-school icon tile and any trailing padding bytes the ROM stores around spell names. Battle spell list now uses it; "Cure" no longer renders with a stray glyph at the right edge of the row.

## 1.6.77 — 2026-05-04

### Magic v1: White Mage Cure end-to-end

First slice of the player-cast magic system. Battle slot 1 for mage jobs (3/4/5) now opens a spell-select menu, picks a known spell, target-selects an ally (player for v1), deducts MP, plays a placeholder cast animation (SouthWind sprite reused), applies heal via the NES magic damage formula, and persists MP + `knownSpells` across saves.

- New `ps.knownSpells: []` on player-stats; `grantStartingSpells(jobIdx)` auto-grants per-job starting spells on `changeJob` and on save load. White Mage (job 3) starts with Cure (`0x34`).
- New `src/spell-cast.js` — `startSpellCast(spellId, target)` / `updateSpellCast(dt)` driving `magic-cast` (250ms windup) → `magic-hit` (400ms anim → apply heal → hold to 1100ms) state pair, modelled on the SouthWind throw/hit loop.
- Battle menu plumbing piggybacks on the item-* state machine via a new `inputSt.menuMode = 'item' | 'magic'` flag. Spell-select reuses the item-list panel; ally-target spells lock the target cursor to the player/ally side.
- New `SPELL_MP_COST` table in `data/spells.js` (Cure = 4 MP for v1).
- Save schema: `knownSpells` added to `save-state.js` + `save.js` + title-screen restore. On load, `grantStartingSpells(ps.jobIdx)` runs so existing mage saves get their starter spells without manual job re-switch.
- New `/job N` console command for testing — bypasses CP cost, shows known spells.
- Cast visual is a placeholder: SouthWind sprite reused as the spell anim. Per-spell PPU traces will land later.

## 1.6.76 — 2026-05-04

### Docs: README + design-notes catch up to the shop / save work

- README status line bumped from v1.6.9 → v1.6.75 and now mentions town shops as a feature. Added "Shops" entry to the architecture module list.
- New "Shops" section in `docs/design-notes.md` covering counter-tile detection, the two-phase NES fade, the equip-preview portrait + delta triangle, FF1 NSF track 14, and the blue confirm-text palette.
- New "Saves" section noting `saveSlotsToDB()` is the single source of truth for the save schema (post v1.6.74 audit), all known save trigger points, and that MP + poison tick are now persisted.

## 1.6.75 — 2026-05-03

### Shops: blue confirm dialog now uses blue text-bg + mobile-aware A/B prompts

The buy/sell confirm dialog renders on a blue (`drawBorderedBox(.., true)`) background, but the text was using `_makeFadedPal(0)` = `[0x0F, 0x0F, 0x0F, 0x30]` — color 1/2 (font shadow) was black, leaving a black halo around each glyph on the blue box. Switched to `[0x02, 0x02, 0x02, 0x30]` (the same palette `message-box.js` uses for "Bought X!" toasts), so the shadow renders blue and disappears into the bg.

Confirm hint also now reads `A=Yes  B=No` on touch devices and `Z=Yes  X=No` on desktop — same `isMobile` check `loading-screen.js` uses for its "Press A" prompt.

## 1.6.74 — 2026-05-03

### Save: persist MP + poison tick, save chests/pond, centralize the schema in `saveSlotsToDB`

Audit revealed three classes of bugs.

**Missing fields**
- `ps.mp` was never persisted — `title-screen.js` reset it to `maxMP` on every load. Added `mp` to the saved schema and the load path (`save.js`, `save-state.js`, `title-screen.js`).
- `ps.status.poisonDmgTick` was lost — only the status mask was saved. Added `statusPoisonTick` to schema + load.

**Mutations that didn't trigger a save**
- `handleChest` (gil + items from chests) and `handlePondHeal` (HP/MP restore) in `map-triggers.js` now call `saveSlotsToDB()` after mutating `ps`. Previously a crash before the next save trigger lost the pickup or heal.

**Schema duplication / drift risk**
- `saveSlotsToDB()` already copied `playerInventory` into the active slot, but every caller was *also* doing `saveSlots[selectCursor].inventory = { ...playerInventory };` inline. New callers could forget the inline copy and silently clobber. Removed all 6 inline copies in `input-handler.js` and the helper in `shop.js` — `saveSlotsToDB()` is now the single source of truth for what gets serialized. Callers just invoke it.

## 1.6.73 — 2026-05-03

### Shops: persist inventory + gil to DB after every buy / sell

`_attemptBuy` / `_attemptSell` now copy `playerInventory` and `ps.gil` into the active save slot and call `saveSlotsToDB()` immediately — same pattern as the pause-menu inventory mutations in input-handler.js. Without this, shop transactions only survived until the next battle ended, the page closed cleanly, or an inventory action in the pause menu — closing the tab mid-shop would lose them.

## 1.6.72 — 2026-05-03

### Shops: weapon delta no longer treats empty off-hand as a free upgrade

Switched weapon comparison from `Math.min(weaponR.atk, weaponL.atk)` back to `Math.max`. With one hand empty, MIN reads as 0 and made every weapon look like an upgrade ("fill the empty hand"). MAX compares against the best weapon already wielded, which matches "is this a real upgrade to my main weapon".

Added explicit short-circuit: if the hovered weapon ID matches `ps.weaponR` or `ps.weaponL`, return 0 (white =). A duplicate of what's already equipped shouldn't show ▲ just because the off-hand is empty.

## 1.6.71 — 2026-05-03

### Shops: HUD viewport border no longer fades during the NES map fade

Root cause: the snapshot fed to `buildNesFadeFrames` covered the full HUD_VIEW area, which includes the 8px-wide HUD border tiles around the map. NES-quantizing + palette-stepping that snapshot dimmed the border tiles along with the map content. Same problem applied to the shop-visible phases — `fillRect` was wiping the borders too, then `drawHudBox` redrew them, but during `map-out`/`map-in` there was no redraw.

Fix: confine all shop drawing to the inner content rect (`INNER_X = 8, INNER_Y = 40, INNER_W = 128, INNER_H = 128`). Snapshot the inner area only; draw fade frames at the inner area; black-fill the inner area; rely on the static HUD canvas (drawn each frame by `drawHUD` before `drawShop`) for the border. `drawHudBox` import dropped from shop.js — no longer needed.

## 1.6.70 — 2026-05-03

### Shops: bordered box no longer fades — only text fades

Shop `drawHudBox(... boxFadeStep)` was stepping the border-tile palette during shop-in / shop-out, which read as the HUD border itself fading. Locked to fadeStep 0 — the box pops in/out at full opacity, only the text inside still does the 4-step palette fade.

## 1.6.69 — 2026-05-03

### Shops: white = indicator on equal stat + empty-slot weapons now read as upgrades

- **Equals indicator**: `shopHoverStatDelta()` now returns `null` for "no indicator" (non-equipment / not equippable / unknown subtype) and a number for actual deltas. `_drawDeltaMark()` (renamed from `_drawDeltaTriangle`) routes `> 0` → green ▲, `< 0` → red ▼, `= 0` → white = (two 8-wide bars at rows 2 and 4 in the same 8×8 box). HUD only draws when `delta !== null`, so non-equippable items still show no indicator.
- **Empty-slot fix**: weapon delta now compares `item.atk` against `Math.min(weaponR.atk, weaponL.atk)` instead of `Math.max`. With one hand empty (atk treated as 0), any new weapon reads as a clear upgrade — matches the "fill the empty hand" intent. Shields keep `Math.max` since at most one shield can be equipped.

## 1.6.68 — 2026-05-03

### Shops: green ▲ / red ▼ delta triangle in HUD name row

When the shop cursor is on a weapon/armor the player can equip and the slot it would replace has different ATK (weapons) or DEF (armor), an 8×8 triangle is drawn at the left padding of the HUD info panel (`HUD_RIGHT_X + 40, HUD_VIEW_Y + 8`). Green ▲ for upgrade, red ▼ for downgrade. Hidden when delta = 0 / non-equipment / non-equippable. Triangle pixels are filled directly via `ctx.fillRect` per-row (NES color $2A / $16, faded with `nesColorFade` to track the existing HUD info-panel fade).

Comparison rules in `shopHoverStatDelta()`:
- weapon (non-shield): `item.atk` vs `max(weaponR.atk, weaponL.atk)`
- shield: `item.def` vs `max(weaponR shield def, weaponL shield def)`
- helmet / body / arms: `item.def` vs the matching slot's def

## 1.6.67 — 2026-05-03

### Shops: HUD portrait flickers victory pose when cursor is on equippable gear

In a shop's buy or sell list, when the cursor is on a weapon/armor that the player's current job can equip (`item.jobs & (1 << ps.jobIdx)`), the existing HUD portrait at top-right (drawn by `_drawHUDPortrait` in hud-drawing.js) alternates between `bp.victory` and `bp.idle` every 250ms — same cadence as the battle ally victory portrait. Otherwise the portrait keeps its normal kneel/defend/idle logic.

`shopHoverEquippable()` exported from shop.js — returns false outside buy/sell, false for non-equipment, false for items the current job can't wield.

## 1.6.66 — 2026-05-03

### Shops: FF1 NSF shop track → 14 (verified by ear)

## 1.6.65 — 2026-05-03

### Shops: NES palette-step fade for the map ↔ shop transition + `/ff1` console command

Replaced the alpha-based outer fade with an actual NES PPU-style palette fade. New module `src/nes-fade.js` exports `buildNesFadeFrames(srcCanvas, sx, sy, sw, sh, steps)`: snapshots a region of the canvas, quantizes each pixel to its nearest NES palette index, then uses `nesColorFade` to produce N+1 progressively darker frames (frame 0 = original, frame N = nearly black). Cached nearest-color lookup keeps the snapshot ~50ms one-time on shop open.

Shop state machine now does the transition in two distinct phases per direction:

- **Open**: `map-out` (320ms — 5 NES fade frames of the map snapshot, lazy-built on first frame) → `shop-in` (500ms — black bg + faded bordered box via `drawHudBox(fadeStep)` + faded text) → `menu`.
- **Close**: `shop-out` → `map-in` → `closed`. Reuses the same snapshot.

Sub-screen swaps (root menu ↔ buy/sell list) keep the existing 500ms text-palette fade — they don't touch the map.

Also new console command: `/ff1 <n>` plays FF1 NSF track index N (pauses map music). `/ff1 stop` resumes map music. Use to ear-check the right index for `FF1_TRACKS.SHOP` since 8/12/17 are all wrong.

## 1.6.64 — 2026-05-03

### Shops: FF1 NSF shop track → 8 (FF1&2 cart song ordering)

The NSF is built from the FF1&2 (Japan) compilation cart, not standalone FF1, so the track index doesn't match the FF1-only NSF song lists. Track 8 per Gemini.

## 1.6.63 — 2026-05-03

### Shops: switch FF1 NSF shop track from 17 → 12

Per Gemini, the FF1 shop theme is NSF track 12 (song $4D), not 17.

## 1.6.62 — 2026-05-03

### Shops: FF1 NSF shop track plays while menu is open

`openShop` now `pauseMusic()` + `playFF1Track(FF1_TRACKS.SHOP)`; `_close` calls `stopFF1Music()` + `resumeMusic()` — same pattern the pause menu uses with `MENU_SCREEN`. New constant `FF1_TRACKS.SHOP = 17` — the next NSF track index after `MENU_SCREEN` (16). If the wrong song plays, bump the index and re-deploy; can't verify without ear-checking against the FF1 NSF.

## 1.6.61 — 2026-05-03

### Shops: outer alpha fade — map fades to black as shop fades in

`openShop` now enters `'opening'` (250ms `globalAlpha` 0→1) before settling on the root menu. Exit / X from the root menu enters `'closing'` (alpha 1→0) before fully closing. The bordered box's black interior, drawn with progressive alpha over the live map, gives a crossfade where the map dims as the shop materializes. Sub-screen swaps (menu↔buy↔sell) keep their existing 500ms text-palette fades.

State machine: `closed → opening → menu → (closing | menu-out → buy-in/sell-in) → ...`. `shopSt.afterFade` records the next state when leaving the root menu so a single `menu-out` transition can route to either `buy-in` or `sell-in`.

## 1.6.60 — 2026-05-03

### Shops: Buy / Sell / Exit root menu + text-fade transitions

Shop now opens to a root menu (`Buy / Sell / Exit`) instead of jumping straight into the buy list. Each panel — root menu, buy list, sell list — fades in/out using the same 4-step palette fade as the pause menu (`PAUSE_TEXT_STEP_MS = 100`, 4 steps + 1 = 500ms total). Input is blocked during fades.

- **Sell**: lists every inventory item that has a non-zero ROM price. Sell price = `floor(buy / 2)` (FF3 NES convention). Confirm dialog mirrors buy. Inventory list rebuilds after each sale so counts stay accurate. Empty inventory shows "Nothing to sell".
- **State machine**: `closed → menu-in → menu → (buy-in / sell-in / menu-out) → ...`. Buy/sell exit via X fades back to root menu (not straight to closed); Exit on root or X on root fades the whole shop out.
- **Magic shop** still no-ops — `openShop` returns false when the catalog has `spells:` instead of `items:`. Wiring deferred.

## 1.6.59 — 2026-05-03

### Shops: weapon, armor, item buy menus wired in Ur

Face the counter in any of the three Ur shops (armor map 4 @ 3,5 / weapon map 5 @ 3,15 / item map 8 @ 8,15) and press Z. Opens a buy menu listing the catalog from `data/shops.js` with prices pulled from `ITEMS` (which were already auto-generated from the FF3 NES ROM at `$21E10`). Z on an item shows a confirm dialog; Z again deducts gil + adds to inventory and shows "Bought X!"; X cancels at any level. Insufficient gil shows "Not enough gil!" instead.

- New module: `src/shop.js` (state, input, render). Standalone — no animations yet.
- `data/shops.js` — each shop now carries `{ mapId, counter: {x,y} }`. `findShopAtCounter()` does the reverse lookup.
- `movement.js` — `handleAction` checks counters before chest/wall/etc.; `handleInput` early-returns to `handleShopInput` when a shop is open.
- `game-loop.js` — `drawShop()` runs after pause menu, before message box (so the "Bought X!" toast overlays the shop list).
- Magic shop (Ur, map 3 @ 4,4, tile 0x3A) is detected by counter lookup but `openShop` no-ops because `spells:` aren't items — buy flow needs `spells.js` integration. Deferred.

## 1.6.58 — 2026-05-03

### Console: `/pos` command for inspecting player and faced tile

New chat command — prints current map ID, player tile (X,Y), facing direction, and the faced tile's coordinates + tile ID (hex). On the world map, just prints world tile coords. Needed to identify shop counter tiles in Ur (and any future map work) without recompiling debug hooks.

## 1.6.57 — 2026-05-02

### Fix: knife forward strike on player slot was rendering the back-swing pose

`_buildPlayerSpriteSet` in `sprite-init.js` was assembling `bsc.battlePoses` with `knifeR`, `knifeL`, `knifeBack` but **not** `knifeRFwd` / `knifeLFwd`. The bundle produced both correctly — the fields just weren't carried over to the player canvas object.

When dual-wielding knives, `pickAttackPoseKey` returns `'knifeRFwd'` / `'knifeLFwd'` during the forward strike. `_playerPoseCanvas` saw those keys as undefined and fell through `PLAYER_POSE_FALLBACK` to `'knifeR'` / `'knifeL'` — which are the back-swing canvases. Net result: every knife forward strike rendered the back-swing pose instead of the strike pose. Most visible on Black Mage (frequently dual-wielding daggers as the only equippable weapon).

Now `knifeRFwd` / `knifeLFwd` are exposed on `bsc.battlePoses`. Affects every job, not just black mage.

## 1.6.56 — 2026-05-02

### Staff weapon sprite wired in; ally portraits now cover all 22 jobs; staff added to Altar F2 loot

- **Staff sprite**: PPU-captured 4-tile block (`$4A/$49/$4C/$4B`) added to `weapon-sprites.js` with SP3 palette `[0x0F, 0x17, 0x27, 0x37]` (gold). New `getStaffBladeCanvas` / `getStaffBladeSwungCanvas` getters; `'staff'` subtype routes through them in `pickAttackWeaponSpec`. White Mage (and any other staff-wielder) now overlays the gold staff during back/fwd swings using the same `swungOrder = [1,0,3,2]` mirror trick as blades.
- **Ally portraits**: `_USE_BUNDLE_FOR_ALLY` expanded from `{0,1,2}` to all 22 jobs. `boot.js` `initFakePlayerSprites` now seeds the full 0-21 range. Symptom: a saved slot with jobIdx 3+ on the title screen was rendering Onion Knight (fallback to job 0 because no entry existed). Now the bundle path produces correct per-job portraits with the canonical tile pattern that POSES tab verifies. The legacy per-job if/else in `initFakePlayerPortraits` is now dead and kept as historical reference.
- **Altar loot**: Staff (0x0E) added to F2 weapon tier alongside Dagger, Nunchuck, and Leather Cap. Same weight bucket — drop rates unchanged for the other items.
- **Rod**: still no sprite (OAM not yet captured). `'rod'` subtype falls through to no-overlay; rods don't appear in any shop or loot pool yet, so this is harmless.

## 1.6.55 — 2026-05-02

### Battle menu: "Defend" relabelled to "Guard"

`BATTLE_DEFEND` constant in `data/strings.js` renamed to `BATTLE_GUARD`, bytes re-encoded for "Guard" (G u a r d). Only call site was the local `BATTLE_MENU_ITEMS` array in the same file; no other code touches the label.

## 1.6.54 — 2026-05-02

### Fix: kneel head TL/TR for jobs 3-21 was reading the wrong ROM tile-indices

`_genericBundle` had kneel head at t(36)/t(37). That's correct for Warrior — and so were the previous PPU captures — but Warrior is the outlier: Onion Knight, Monk, and (per visual confirmation in the POSES tab) every job 3+ stores kneel head TL/TR at t(8)/t(9). Fixed both `_genericBundle` and the corresponding POSES tab card.

## 1.6.53 — 2026-05-02

### POSES debug tab now seeds jobs 3-21 from ROM using the canonical tile layout

Previously the POSES tab only loaded Onion Knight, Warrior, and Monk (PPU-captured constants). Jobs 3-21 (White Mage onward) had no cards — there was no way to visually verify whether `_genericBundle`'s tile-index pattern produced correct poses for a given job.

Added `_seedGenericJobPoses()` which, for each remaining job, reads tiles directly from ROM at `BATTLE_SPRITE_ROM + jobIdx * BATTLE_JOB_SIZE` and pushes 8 pose cards (idle / L back / L fwd / R back / R fwd / kneel / victory / hit). The tile-index slot layout matches `_genericBundle` exactly, so the tab is now the visual ground truth: if a card looks wrong, the bundle (and therefore the in-game render) is wrong, and the slot can be re-mapped from there.

## 1.6.52 — 2026-05-02

### Fix: generic-job battle sprites (jobs 3-21) now use correct ROM tile indices for L-back, L-fwd, kneel, and per-pose legs

`_genericBundle` in `combatant-sprites.js` had the L-back/L-fwd body indices and kneel body BL/BR off, and reused default legs for every pose. Symptom: switching to White Mage (or any non-OK/Warrior/Monk job) showed garbage tiles during L-side swings and kneel.

Reverse-mapped the PPU-captured Onion Knight + Warrior bytes back to ROM tile-indices and confirmed a uniform per-job layout:

- 0-3 idle body, 4-5 idle legs
- 6-7 R-fwd legs
- 10-11 kneel body BL/BR, 12-13 kneel legs
- 14 R-back body-TL, 15 R-back legL (legR shares tile 7)
- 16-17 L-fwd body, 18-19 L-fwd legs
- 20-21 L-back head-TR + body-TR, 22-23 L-back legs
- 24-27 victory body, 28-29 victory legs
- 30-33 hit body, 34-35 hit legs
- 36-37 kneel body TL/TR

Bug indices were 6/7 (L-back), 8/9 (L-fwd), 38/39 (kneel BL/BR) — those slots hold unrelated data on most jobs, which is why the previous "approximation" disclaimer existed. Pattern is canonical, not approximate.

Player path only this version. Ally legacy path (`_initGenericJobPosePortraits` / `_buildGenericJobFullBodies` in sprite-init.js) still uses the old indices for jobs 3-21 — opponents/allies of those jobs will still glitch until that path is migrated to the bundle.

## 1.6.51 — 2026-05-01

### Fix: enemy actor name now appears before the swing lands (was lagging behind animations)

`battle-enemy.js _processEnemyFlash` and `pvp.js _runEnemyAttack` both queued the enemy's name AFTER the BOSS_PREFLASH_MS (133ms) preflash window — i.e. at the same instant the swing animation began. Combined with the message strip's 200ms fade-in, the player saw the hit land before the name finished fading in (often after the hit, depending on swing duration). This was especially noticeable on fast monster attacks.

The name is now queued at turn dispatch (`battle-turn.js`, the moment state transitions to `'enemy-flash'`). The 200ms fade-in starts immediately and overlaps the 133ms preflash, so the name is visible by the time the swing connects. Both regular monster attacks (looked up via `getMonsterName`) and PVP opponent / enemy-ally attacks (looked up via `pvpSt.pvpOpponentStats` / `pvpSt.pvpEnemyAllies`) route through the same call site.

Cleanup: `battle-enemy.js` and `pvp.js` no longer import `queueBattleMsg`/`getMonsterName`/`_nameToBytes` since they no longer queue messages directly.

## 1.6.50 — 2026-05-01

### Fix: typed chat messages now appear in the tab they were sent from

`onChatKeyDown` always called `addChatMessage(text, 'chat')` with no channel, which `addChatMessage` defaulted to `'room'`. The active-tab filter (`_passesTabFilter`) only renders messages whose channel matches the tab — so a user typing on the **World** tab pushed a `room`-channel message that was immediately filtered out, looking like nothing happened. Auto-chat already routed correctly (`'room'` for local, `'world'` for remote) so other people's chats still appeared, masking the bug.

The send path now maps `activeTab → channel`: World → `world`, Room → `room`, Private → `pm`, System → `room` (you can't post to system, so fall back).

## 1.6.49 — 2026-05-01

### Fix: PVP opponent attack message now matches the rest of the codebase ("Name" not "Name attacks!")

`pvp.js _runEnemyAttack` was the only `queueBattleMsg` site in the codebase that suffixed `' attacks!'` to the actor name. Player fight, player defend (`battle-turn.js`), ally attack (`battle-ally.js`), and regular enemy attack (`battle-enemy.js`) all queue just the bare actor name. PVP now matches.

## 1.6.48 — 2026-05-01

### Refactor: deleted second battle message UI; BATTLE_CANT_ESCAPE now uses queue strip everywhere

The codebase had two battle-context message renderers: the queued fade strip (`battle-msg.js`, used by hit names / attack lines / victory) and a second centered-bordered-box system (`'message-hold'` battle state + `battleSt.battleMessage` field + `drawBattleMessage` renderer in `battle-drawing.js`). The centered box had exactly one caller — boss/non-random escape failure — while random-encounter escape failure already used the queue strip for the same `BATTLE_CANT_ESCAPE` text. Same string, two visual treatments.

**Visual change:** boss-flee failure now shows the same fading strip as random-encounter flee failure. UX is now consistent across both encounter types.

Deletions:
- `drawBattleMessage()` and its caller in `battle-drawing.js`.
- `TEXT_WHITE_ON_BLUE` palette const (only used by the deleted renderer).
- `battleMessage` field on `battleSt` + its reset in `battle-update.js`.
- `CENTER_MSG_HOLD_MS = 1200` constant (was duplicated in `battle-update.js` and `pvp.js`).
- Dead `'message-hold'` handler in `pvp.js _updatePVPMenuConfirm` — was unreachable since the only setter lived in `battle-update.js` and PVP doesn't go through that path.

The state name `'message-hold'` is retained (still referenced by 4 draw guards that gate non-message rendering) but its semantics changed from "show centered box for 1200ms" to "wait for queue strip to drain, then re-open battle menu."

## 1.6.47 — 2026-05-01

### Refactor: battle message system tightening (no behavior change)

Cleanup pass on the three message UIs (battle queue strip, battle centered box, overworld slide box). All changes are equivalence-preserving — visuals and timing unchanged.

- **`message-box.js`**: added `dismissMsgBox()` so callers stop poking `msgState.state = 'slide-out'; msgState.timer = 0` from outside the module. `movement.js` and `input-handler.js` now go through the API.
- **`battle-msg.js`**: replaced the generic `setBattleMsgCurrent(v)` setter with a named `clearVictoryPersist()` that only clears messages flagged `persist: true`. The single caller (victory text-out) is more readable. Also dropped `MSG_TOTAL_MS` (exported, zero importers) and the now-unused `getBattleMsgQueue` export.
- **`battle-update.js`**: replaced two `!getBattleMsgCurrent() && getBattleMsgQueue().length === 0` guards with `!isBattleMsgBusy()` — equivalent given the invariant that current is null iff queue is empty.
- **`pvp.js`**: removed dead `if (queueBattleMsg && ...)` truthy check (ESM static imports are always truthy).
- **`message-box.js`**: dropped unused 2nd parameter from `drawMsgBox`; updated `game-loop.js` caller.
- **Constant disambiguation**: renamed `BATTLE_MSG_HOLD_MS = 1200` (locally defined in `battle-update.js` and `pvp.js`, governs the `'message-hold'` centered-box state) to `CENTER_MSG_HOLD_MS`, with a comment noting it's distinct from `battle-msg.js`'s `MSG_HOLD_MS = 800` (which times the queue strip's hold phase).

## 1.6.46 — 2026-05-01

### Fix: in-game console version banner now reads from `#version-badge` (was hardcoded)

`src/data/strings.js` previously hardcoded `VERSION = '1.6.44'` with a comment claiming "single source of truth (update here + package.json)" — which was the opposite of single-source. The in-game console banner (`'FF3 MMO v' + VERSION` rendered by `src/main.js`) had been silently lagging `package.json` for releases that bumped the version without also editing this file.

`VERSION` now reads from the server-substituted `#version-badge` div (which already gets `{{VERSION}}` replaced in `server.js`). Module scripts are deferred so the DOM is parsed before this evaluates. `package.json` is now the only place to bump.

## 1.6.45 — 2026-05-01

### Refactor: Monk ally render migrated to unified bundle path; dead legacy builder deleted

`_USE_BUNDLE_FOR_ALLY` now includes jobIdx 2 (Monk) alongside OK and Warrior, so Monk fake-player portraits + bodies flow through `_buildFakePlayerSet` → `getJobPoseTileBundle` (which has had a fully populated `_monkBundle` since the bundle abstraction landed). The Monk-specific legacy ally helpers (`_initMonkPosePortraits`, `_buildMonkFullBodies`) are now unreachable but kept for one release as a rollback safety net — pending visual verification.

Also deleted `_legacyInitBattleSpriteForJobInline` from `src/sprite-init.js` (327 lines). It was orphaned after `initBattleSpriteForJob` migrated to `_buildPlayerSpriteSet` and had zero callers anywhere in the codebase — comment claimed "preserved temporarily for fake-player builders that haven't migrated yet" but no caller existed. `src/sprite-init.js` is now 1156 lines (was 1484).

Opponent rendering (`initBattleSpriteForJob`) is already 100% on the bundle path for all 22 jobs unconditionally; ally is now {OK, Warrior, Monk} on bundle, generic 3-21 still on legacy (untriggered today since `boot.js` only initializes `[0, 1, 2]`).

## 1.6.44 — 2026-05-01

### Fix: PVP opponent L-hand back-swing missing on dual-wield

`_processPVPSecondWindup` set the wait for hand-change hits to `IDLE_FRAME_MS` (67ms), and `oppHandChangeGap` rendered idle body for that whole window — leaving no time for the back-swing. Dual-wield L-hand jumped straight from idle to fwd-strike.

Now: hand-change wait = `IDLE_FRAME_MS + BOSS_PREFLASH_MS` (armed) — 67ms idle gap, then 133ms back-swing pose with weapon raised. `oppHandChangeGap` only holds idle for the gap portion. Unarmed unchanged (no distinct back-swing pose).

## 1.6.43 — 2026-05-01

### Fix: PVP opponent (OK + Warrior) facing wrong way

`_renderFullBody` in `src/combatant-sprites.js` was missing the final h-flip that the legacy `_buildFullBody16x24Canvas` (sprite-init.js) ends with. Bundle-path jobs (OK = 0, Warrior = 1, per `_USE_BUNDLE_FOR_ALLY`) drew un-flipped, so the opponent body faced the wrong direction AND the swing-hand looked wrong — `pickAttackPoseKey({mirror:true})` already inverts L↔R assuming the canvas is pre-flipped, so a missing flip showed the opposite hand swinging. Monk used the legacy h-flipped builder and rendered correctly, which is what surfaced the bug.

`_renderFullBody` is consumed only by `buildOpponentBodyCanvases`, and those `*FullBodyCanvases` are PVP-only — player and ally portrait paths (`_renderPortrait`) are unaffected.

## 1.6.42 — 2026-04-29

### Slash effect render path centralized

`drawSlashOverlay(ctx, frame, frameIdx, originX, originY, mirror)` added to `src/slash-effects.js`. Owns the per-frame scatter pattern (`[0, 10, -8]` / `[0, -6, 8]`), the optional mirror transform (PVP opponent attacking the player/ally portrait), and the `drawImage` call. No-ops on a null frame so call sites stay terse.

Five non-player slash render sites now collapse to one `drawSlashOverlay(...)` line:

- `battle-drawing.js _drawPortraitOverlays` — PVP opponent slash on player portrait
- `battle-drawing.js _drawEncounterSlashEffects` — ally slash in random encounters
- `battle-drawing.js _drawBossSprite` — ally slash on boss
- `battle-drawing.js _drawAllyPortrait` — PVP opponent slash on ally portrait
- `pvp.js` PVP grid — ally slash on opponent

Player slash path (battle-update.js / battle-drawing.js:773, 867) intentionally not migrated — it has its own bladed-walk-off + random-punch scatter logic driven by `battleSt.slashOffX/Y` that's incompatible with the deterministic 3-position pattern. Same architectural split as `combatant-pose.js`: centralize where it makes sense, leave intentional differences alone.

No behavior change.

## 1.6.41 — 2026-04-29

### Fix: unarmed Monk dealing 2 damage after loading a save

`title-screen.js _updateTitleMainOutCase` was calling `recalcCombatStats()` BEFORE assigning `ps.jobIdx` from the save slot. On save-load, `ps.jobIdx` is still the default 0 (Onion Knight) at recalc time, so `isMonkClass = (jobIdx === 2 || 13)` evaluates false and the unarmed Monk/BlackBelt ATK formula in `calcAttackerAtk` is skipped. Result: `ps.atk = rWpnAtk + lWpnAtk = 0`, both unarmed hands roll `calcDamage(0, def)` → clamped to 1 each → 2 total damage regardless of level.

Fix: move the `recalcCombatStats()` call past the `ps.jobIdx` assignment. New character flow (no slot) is unchanged — recalc still gated on `if (slot)`.

Verified by simulating the path in `battle-math.js`: `isMonkClass=false` + unarmed yields exactly the totals the user reported (`[2,2,2,2,2]`).

## 1.6.40 — 2026-04-29

### Battle sprite consistency audit

No behavior change — cleanup of two fragile patterns surfaced by an audit of the three render paths (player / ally / PVP opponent).

- **`src/pvp.js`** — corrected the comment block above the opponent body-canvas selection. Old text ("pre-h-flipped canvases face left" / "opponent faces left") contradicted the canonical wording in `combatant-pose.js:25` and `pvp.js:704` ("face-right pre-flipped canvas"). New comment cites `pickAttackPoseKey` + `mirror:true` as the source of truth for the L↔R cross.
- **`src/combatant-sprites.js`** — `_okBundle` now derives `jobBase = BATTLE_SPRITE_ROM + 0 * BATTLE_JOB_SIZE` and uses it for the OK hit-tile reads, instead of using `BATTLE_SPRITE_ROM` directly. Mathematically identical, but a future copy-paste (e.g. `_warriorBundle` / `_monkBundle`) won't silently read OK's hit tiles.

### Audit findings (no fix needed)

All three render paths route through `combatant-pose.js` (`pickAttackPoseKey`, `pickAttackWeaponSpec`) and `combatant-sprites.js` (`getJobPoseTileBundle`). Hand alternation, wind-up skip, unarmed pose selection (rBack/lFwd), fist offset (-4, +10), blade offsets (R+8 / L+16 / fwd-16), and the PVP-opponent mirrored `drawBlade()` transform are all consistent across player, ally, and opponent.

## 1.6.12 — 2026-04-23

### Monster stats — regenerated from ROM (fixes 3a54feb corruption)

- **`src/data/monsters.js`** regenerated via `tools/gen-monsters-js.js`. All 230 monsters now match `tools/rom-dump-monsters.txt` exactly. Fixes 224 inflated ATK values (Goblin 10→5, Werewolf 15→9, Berserker 20→10, …) and `attackRoll` values from commit `3a54feb`, and restores 16 missing `hp:` fields (Larva, Unei Clone, Darkface, Cuphgel, Lemur, Twin Heads, Twin Liger, Demon Horse, Saber Liger, Queen Lamia, KingBehemth, Abaia, Haokah, Archeron, Amon, Gomory).
- **`tools/gen-monsters-js.js`** now also emits `spiritInt` (ROM byte 7) and `statusResist` (ROM byte 13) — both were being read but discarded. `statusResist` array order normalized high-bit-first.
- **`docs/design-notes.md`** — removed the "Known broken data" block; added a short monster-data section pointing at the regen command.

## 1.6.11 — 2026-04-23

### Monk job — sprites, palettes, integration (end-to-end)

Added Monk (jobIdx 2) as a first-class playable job. All 9 battle poses PPU-captured and wired.

- **`src/data/monk-sprites.js`** — new file. PPU-dumped tile data for Monk: idle, R-back swing, R-fwd swing, L-back swing, L-fwd swing, hit flinch, kneel, victory (arms-up), death (24×16 prone). Shared legs de-duped across poses where bytes match.
- **`src/sprite-init.js`** — `_initMonkPosePortraits()` and `_buildMonkFullBodies()` dispatched from `initFakePlayerPortraits(romData, jobIndices)` when jobIdx === 2. Per-job battle-palette override `JOB_BATTLE_PAL_OVERRIDE[2] = [0x27, 0x18, 0x21]` (orange skin / olive hair / blue gi).
- **`src/job-sprites.js`** — `MO_WALK_TOP`/`MO_WALK_BTM` overworld walk palettes added, wired into `JOB_WALK_PALS[2]`.
- **`src/data/players.js`** — `MONK_PALETTES` pool (8 variants) — fixed skin/hair, varying gi color across palIdx slots. Used by `_genPosePortraits` for fake Monks.
- **`src/debug/tabs/sprites.js`** — Konami debugger POSES view now loads 9 MO entries from `data/monk-sprites.js` (previously ROM-offset math, moved to canonical).

### Nunchuck weapon — sprite, hit-effect, loot drop

- **`src/weapon-sprites.js`** — `NUNCHAKU_TILES` (PPU-captured $49/$4A/$4B/$4C diagonal chain). `initWeaponSprites` builds `nunchakuRaised` + `nunchakuSwung` canvases using the same raised-vs-swung tile-swap pattern as sword/knife. Accessors + `getBlades().nunchaku`.
- **`src/battle-drawing.js`** — added `wpnSt === 'nunchaku'` branches to all 6 weapon render paths (player R/L back/fwd, ally R/L back/fwd).
- **`src/pvp.js`** — `drawBlade` routes nunchaku through the same wind-up/swung canvas selection.
- **`src/slash-effects.js`** — `initNunchakuSlashSprites()` (tiles $4D/$4E/$4F/$50) for the on-target hit-flash. Reused across all 3 slash timing slots since the tile bytes don't animate (position moves via existing `slashOffX/Y` scatter).
- **`src/battle-sprite-cache.js`** — `nunchakuSlashFramesR/L` added; `getSlashFramesForWeapon` dispatch handles `'nunchaku'`.
- **`src/data/players.js`** — 5 Monk fake-player entries added (Kasumi, Jiro, Ryuji, Hana, Tetsuo). 2 equipped with Nunchuck (0x06), 3 unarmed (fists); mixed across cave-0/ur/cave-1/cave-2/world/camper.
- **`src/map-triggers.js`** — F2 Altar Cave uncommon pool adds Nunchuck (0x06) alongside Dagger.

### Fighter / OK L-back pose fix — head-TR was never swapping

A multi-year bug: whenever a character did a left-hand back-swing, all callers passed `idleTiles[1]` for the head-TR slot instead of the L-back variant. The pose data was partially right (body-TR swapped) but visually the head read as idle. Re-capture proved:

- `WR_L_BACK[1]` (head-TR $3F) was wrong — held idle bytes. Replaced with canonical L-back bytes. Also corrected `WR_L_BACK[3]` body-TR bytes (old bytes didn't match any ROM-extracted pose) and fixed `WR_LEG_L_BACK_L` byte 8 (`0x06 → 0x07`).
- `OK_L_BACK_SWING[1]` last-byte single-bit fix (`0xED → 0xEC`) to match the L-back head-TR variant.
- `src/sprite-init.js` — 4 consumer sites updated to pass `_FP_KNIFE_L[1]` / `WR_L_BACK[1]` for head-TR instead of idle: `_initBattleAttackSprites`, Warrior `_initBattleSpriteForJob`, `_initWarriorPosePortraits`, `_buildWarriorFullBodies`, `_initFakePosePortraits` (OK `fakePlayerAttackLPortraits`), OK `_initBattleAttackSprites` overlay path.

### Generic ROM-based pose builder for jobs 3–21

Previously the 19 non-starter jobs (White Mage, Black Mage, Red Mage, …, Ninja) in `initFakePlayerPortraits` fell through to the Warrior placeholder, so all of them visually rendered as Warriors. Replaced with a generic ROM-keyed builder that reads each job's own `jobBase` block and bakes in the pattern: defend === victory === magic-cast, L-back swaps BOTH head-TR (tile 6) AND body-TR (tile 7), death placeholder until PPU-captured.

- **`src/sprite-init.js`** — `_initGenericJobPosePortraits()` + `_buildGenericJobFullBodies()`. The same head-TR swap fix was also applied to the `initBattleSpriteForJob` generic ROM path that runs for the player's own battle canvas when switching to any of these jobs.
- **`src/boot.js`** — `initFakePlayerSprites(rom, [0, 1, 2])` (up from `[0, 1]`) so Monk portraits build at boot.

### Defend / magic-cast consolidated under victory

In canonical FF3 all three poses (guard, item-use, spell-cast) share the same 4-tile arms-up stance as victory. The OK battle sprite init held a duplicate `DEFEND_TILES` byte array that was identical to `OK_VICTORY`. Removed the copy — everything now references `OK_VICTORY` directly. Warrior + generic-ROM paths already used `victoryTiles` for defend; added a comment in each so the invariant is clear.

### Game Over flow — death no longer grants rewards, dedicated HUD box

When you died but allies finished the fight, the existing flow was granting EXP/gil/CP (and the level-up `fullHeal()` was auto-reviving KO'd players, masking the death from the end-of-battle respawn check). Reworked:

- **`src/battle-update.js`** — 3 reward-grant sites (monster-death, `_triggerPVPVictory`, `_updateBossDissolve`) now gate on `ps.hp > 0`. When KO'd, the victory flow is skipped — goes straight to `encounter-box-close` / `enemy-box-close` with all reward counters zeroed.
- New `'game-over'` battle state. `encounter-box-close`, `enemy-box-close`, and `defeat-close` (team-wipe) now transition here when `ps.hp <= 0` instead of directly respawning.
- `TRACKS.GAME_OVER = 0x2B` ("The Requiem") plays on game-over entry.
- `respawnFromGameOver()` exported — called from `input-handler.js` when Z is pressed during `'game-over'`. Routes back through `_respawnAtLastTown()` (HP/MP restore, wipe to `ps.lastTown`).
- **`src/battle-drawing.js`** — `_drawGameOver()` renders a small bordered HUD box (96×40) centered in the battle viewport with "GAME OVER" text and a blinking "Press Z" prompt. Overworld/roster continue to render behind it.

### Level-up no longer restores HP

`grantExp()` used to `fullHeal()` on level-up, which (a) auto-revived KO'd players mid-battle and (b) was not canonical FF3 behavior. Removed the call. Current HP is preserved; maxHP still grows as normal. The Game Over flow above depends on this.

### Save sync diagnostics

- **`src/save-state.js`** — `serverSave` / `serverLoadSaves` errors now log to console (`[save] server sync failed …`) instead of being silently swallowed.
- On load, if the server responds but every slot is null, fall back to IndexedDB instead of clobbering local saves with the empty server response.

### Known bug — monster ATK / attackRoll values are inflated vs ROM

Discovered during Werewolf damage testing: `tools/rom-dump-monsters.txt` (an independent ROM extractor) disagrees with `src/data/monsters.js` on most ATK values. Goblin ROM=5/ours=10; Werewolf ROM=9/ours=15; Berserker ROM=10/ours=20; Zombie ROM=12/ours=25; etc. Commit `3a54feb` on 2026-04-10 claiming to "Fix all 231 monster ATK and attackRoll values from ROM stat tables" actually decoded the NES stat-set index bitmask incorrectly and shipped inflated values. **Not yet fixed in 1.6.11 — scheduled as a follow-up; the ROM dump is the source of truth.**

## 1.6.10 — 2026-04-22

### Chest loot pools — per-map + floor tiers + gil

Chest loot was a single global 4-tier table regardless of where the chest lived — same odds in the starter town as in the final floor of the first dungeon. Also, SouthWind was sitting at the 2% legendary slot in every chest, which made it cheap to farm.

- **`src/map-triggers.js`** — `LOOT_POOLS` keyed by `mapId`. Ur (114) drops potions/antidotes/gil only; Altar Cave F1–F4 (1000–1003) scale from consumables + Leather Cap to Bronze Bracers + Longsword with gil ranges growing 20–60 → 125–275. Unlisted maps fall back to the F1 pool. Crystal room (1004) is a boss room and has no chests.
- **Gil entries** — pool entries of shape `{ gil: [min, max] }` roll a random amount into `ps.gil` and show "Found N gil!" via the existing message box.
- **`src/data/monsters.js`** — Land Turtle drops reduced from `[0xA6, 0xB2]` to `[0xA6]`. SouthWind no longer in any chest pool, so it's now obtainable only via the late-game monster drops that canonically carry it (Darkface, Parademon, Crocotta, Lemur).
- **`docs/design-notes.md`** — updated the loot section to reflect per-map pools, gil entries, and SouthWind sourcing.

## 1.6.9 — 2026-04-22

### Ally-won victory no longer strands dead player at 0 HP

When the player died but allies finished the battle, the victory flow ran (`monster-death` → `victory-*` → `encounter-box-close`) and dumped the player back to the overworld with `hp = 0`. Death respawn only fired from `team-wipe → defeat-close`, which requires *everyone* down.

- **`src/battle-update.js`** — extracted `_respawnAtLastTown()` (HP/MP restore + wipe to `ps.lastTown`). Called from `encounter-box-close` / `enemy-box-close` when `ps.hp <= 0`, plus `defeat-close` (dedup of the inline block).

### Victory box text overflow

Audit: item-drop and job-level-up text was drawing outside the 120 px victory box. Worst cases: `Found MythrilShield!` = 144 px; `ONION KNIGHT LV 99!` = 152 px. Neither actually reached the ally HUD (ally column starts at x=144, worst-case text end x=136) but broke the bordered-box frame visually.

- **Item drops** now stack 2 rows: "Found" top, "`{item}!`" bottom. Max line width 96 px, both well inside the box.
- **Job level up** uses static "Job Level Up!" (104 px) instead of `{JOBNAME} LV {lv}!` (up to 152 px).
- `src/data/strings.js` — new `BATTLE_FOUND`, `BATTLE_JOB_LEVEL_UP`.
- `src/text-utils.js` — `makeFoundItemText(id)` replaced by `makeItemDropText(id)` (returns `{name}!` only). Removed dead `makeJobLevelUpText` and its `JOBS`/`ps` imports.
- `src/battle-drawing.js` — `_drawRewardText` stacks 2 rows for item drops, single row for the rest.

### Docs cleanup

- `README.md` — reconciled multiplayer status (roster is simulated from a fake player pool, not online); pruned the per-file architecture listing (100+ lines) to a concern-grouped overview. Networked multiplayer is planned — see `MULTIPLAYER.md`.
- `REFACTOR.md` → `docs/history/REFACTOR.md` (completed, archived).
- `AUDIT-LOOT.md` retired — bug fixes already captured in 1.6.0, design notes moved to `docs/design-notes.md`.

## 1.6.8 — 2026-04-19

### Monster magic damage formula — caster stat + variance

NES magic damage (`31/B17C`) uses:
```
atk = floor(caster_INT / 2) + spell_power
dmg = atk + rand(0..atk/2) - mdef
```

Ours was a flat `power - mdef`. That ignored the caster's INT entirely, so endgame mages were dealing ~150 flat damage instead of 300+. The `spiritInt` byte (ROM $60010 byte 7) existed in the gen script but was never written to `monsters.js` — same class of omission as `statusResist`.

- **`monsters.js`** — 110 of 231 monsters now have `spiritInt` field (values 17–255). Low-level mages around 17–34, bosses and endgame casters 150–255.
- **`battle-encounter.js`** — propagates `spiritInt` onto spawned monster instances.
- **`battle-enemy.js`** — magic damage recalculated per NES: `atk = floor(mon.spiritInt/2) + spec.power`, then `atk + rand(0..atk/2) - mdef` × elemMult, min 1. Applied to both ally-target and player-target paths.

### Ally shield evade

`generateAllyStats()` now exposes `shieldEvade` from the equipped shield. Previously allies with Leather Shield were dropping it in the void; monster physical attacks against allies bypassed the block roll entirely.

- **`src/data/players.js`** — returns `shieldEvade`.
- **`src/battle-enemy.js`** — monster→ally physical attack now passes `ally.shieldEvade` and `ally.evade` into `rollMultiHit`.

## 1.6.7 — 2026-04-19

### Player / ally armor status immunity wired up

Armor items have `sResist` bitmasks (ROM byte 3) that nothing was checking. A Ribbon (`sResist: 0xFE`) was cosmetic.

- **`src/player-stats.js`** — `recalcCombatStats()` now OR's all equipped armor `sResist` bytes into `ps.statusResist` (bitmask). Recomputed on equip change.
- **`src/data/players.js`** — `generateAllyStats()` builds the same bitmask for allies' armor/helm/shield.
- **`src/battle-enemy.js`** — all 4 player/ally `tryInflictStatus` calls now pass the target's `statusResist`. Monster `statusAtk` on physical hit and monster special-attack status both respect immunity.

`tryInflictStatus()` already accepted numeric bitmasks from the monster-side fix in 1.6.5, so no status-effects.js change.

## 1.6.6 — 2026-04-19

### Poison tick — match NES exactly

Battle poison damage was `max(1, floor(maxHP / 16))`. NES (`35/BADC-BB1E`) uses `floor(maxHP / 16)` with no minimum clamp, so tiny enemies with <16 maxHP take 0 poison damage. The `max(1, ...)` clamp was killing small monsters over time in situations NES would leave them alone.

Walk poison (`-1 HP per step, min 1 HP`) already matched NES `3B/A0B1-A10D` exactly.

## 1.6.5 — 2026-04-19

### Monster status resistance (ROM data wired up)

`tools/gen-monsters-js.js` read byte 13 of each monster record as `statusResist` but never wrote it to `monsters.js`, so every monster was equally vulnerable to every status — bosses included.

30 of 231 monsters have NES status-immunity bits:
- 26 resist Toad (mostly undead, zombies, dragons, bosses)
- 6 resist Paralysis (including Unei Clone and 2 end-game bosses)
- 2 resist both Paralysis + Toad
- 1 resists Petrify

Now added to `monsters.js` as `statusResist: 'toad'` / `['paralysis','toad']` / etc.

- **`src/status-effects.js`** — `tryInflictStatus()` accepts optional `resist` (name, array, or mask); auto-fails if flag matches.
- **`src/battle-encounter.js`** — propagates `statusResist` onto spawned monster instances.
- **`src/battle-update.js`** — weapon on-hit status passes `targetMon.statusResist` (player → monster).

Player-side status immunity from armor `sResist` is tracked on items but not yet aggregated or applied — flagged for follow-up.

## 1.6.4 — 2026-04-19

### Monster special attacks — power/hit corrected from ROM

Seven entries in the hardcoded `SPECIAL_ATTACKS` table in `battle-enemy.js` diverged from the NES spells data (`spells.js`, generated from ROM `$618D0`):

- **Fira** 60 → 55, **Bzzara** 60 → 55, **Thundara** 75 → 55 — damage spells off by 5–20.
- **Bzzaga** 130 → 85 — 1.5× too strong.
- **Sleep** hit 60% → 15% — Sleep was landing 4× more often than NES.
- **Confuse** hit 60% → 25% — same issue.
- **Silence** hit 80% → 60%.

All 231 monster `spAtkRate` values are ROM-clean, no changes needed there.

### Armor audit — 1 item fixed

- `0x97 CrystalGlove` had `def/evade/mdef: undefined` — now `10/15/10` per ROM. `tools/extract-all.js` armor loop stopped at 0x96 and skipped it.

All 85 weapons and 64 armor items (after this fix) now match ROM at `$61410`.

## 1.6.3 — 2026-04-19

### Per-job crit rate and crit bonus (ROM-verified)

Our combat used a fixed 5% crit chance and a derived `atk/4` crit bonus. NES (`39/BB1A` job modifiers table, 5 bytes per job) specifies both values per-job:

- **Crit rate**: 0–5% depending on job. White Mage and Bard never crit; Black Belt and Ninja crit 5%.
- **Crit bonus**: flat 1–100 added on a crit. Bard = +1 (almost cosmetic), Ninja = +100 (big spike).

Fixes: mage/bard jobs were critting too often, warrior jobs were critting with a damage bonus disconnected from their weapon style, Ninja was underpowered on crits.

- **`src/data/jobs.js`** — added `critPct` and `critBonus` fields to all 22 jobs from ROM `$73B2A`.
- **`src/battle-math.js`** — `rollHits` now reads `critPct` and `critBonus` from `opts`. Fixed `CRIT_RATE` constant removed.
- **Call sites updated** (`input-handler.js`, `battle-turn.js`, `pvp.js`): pass the attacker's job crit values on each attack. Monsters pass 0/0 (they don't crit in our system, matching NES default behavior).

### Stat cap on level-up

NES caps each stat at 99 on level-up (`35/BF92`). Our `grantExp` and `changeJob` were incrementing stats without a cap. Added `Math.min(99, ...)` to STR/AGI/VIT/INT/MND updates.

## 1.6.2 — 2026-04-19

### Job switch cost formula rewritten (CRITICAL)

Byte 0 of each job record at ROM `$72010` was mislabeled as `cpCost` by `tools/extract-all.js` and that mislabel propagated into `src/data/jobs.js`. The byte is actually **alignment** — high nibble = physical/magical index, low nibble = lawful/chaotic index.

The NES computes job change cost dynamically from the alignment vector between the *current* and *target* jobs (disasm `3D/AD85`):

```
cost = (|physDiff| + |chaosDiff|) * 4 - newJobLevel, min 0
```

Our old formula charged a fixed per-target value (40–255) that didn't depend on the current job at all. Every cost was 3–20× too high. Example from Onion Knight starter:

| Target | Old (fixed) | New (alignment-based) |
|---|---|---|
| Fighter / Monk / White Mage / Black Mage / Red Mage | 121–153 | 7–8 |
| Knight / Thief / Scholar | 117–170 | 15 |
| Black Belt | 40 | 23 |
| Sage | 255 (capped) | 55 |
| Ninja | 0 (bug) | 63 |

Ninja was effectively free because its alignment byte is `0x00`; now it correctly costs ~60 CP from a neutral-aligned job. The whole job economy is now NES-calibrated.

- **`src/data/jobs.js`** — `cpCost: N` → `alignment: 0xXX` (same byte, correct label) across all 22 jobs.
- **`src/player-stats.js`** — `jobSwitchCost()` computes the NES formula; uses current job's alignment.
- **`tools/extract-all.js`** — prints `Align:0xXX (phys:N chaos:N)` instead of the mislabeled `CP:`.

## 1.6.1 — 2026-04-19

### Monster ATK outliers fixed (ROM-verified)

Six monsters had ATK values 3.75-5x their ROM counterparts — typos that survived the 2026-04-09 audit. Restored to ROM values from `$61010` stat table:

- **Killer Bee** (Lv2, Altar Cave): 50 → 10 — was one-shotting starters (~150 dmg × 3 hits)
- **Revenant** (Lv6, Cave of Seal): 50 → 10
- **Helldiver** (Lv6, Summit Road): 50 → 10
- **Mandrake** (Lv5, dummied): 60 → 16
- **Petit** (Lv3, Nepto Shrine): 60 → 16 — was the highest-ATK low-level monster
- **Poison Bat** (Lv10, Nepto Shrine): 60 → 16

Remaining monster ATK values are intentionally scaled (median ~0.69× ROM for high-level, ~1.5-2× for low-level single-player balance). `hitRate` verified 231/231 matching ROM; `attackRoll` is deliberately capped at 2-3 (ROM goes up to 11).

### Defeat respawn system

Replaces the prior "teleport to nearest world tile" defeat flow — which could dump you at Ur's entrance after an overworld encounter far from town, or cause stale `currentMapId` state after dungeon wipes.

- **`ps.lastTown`** (defaults to 114 / Ur) tracks the most recent town visited. Updated whenever the player enters a map in `AREA_NAMES`.
- **On team wipe**: HP/MP restore to max, `mapStack` cleared, player respawns at the entrance of `ps.lastTown` via `loadMapById()`.
- **Save persistence**: `lastTown` is written to save slots and restored on game load.
- **Fixes data-loss gap**: defeat-close now calls `saveSlotsToDB()`, so tab-close immediately after a wipe no longer loses the HP/MP restore.
- Currently only Ur (114) is in `AREA_NAMES`, so all defeats respawn in Ur. Mechanism auto-extends as Kazus / Canaan / etc. are added.

This diverges from NES FF3 (which jumps to `$C000` / program start on defeat — a hard reboot to title for save reload). That model doesn't fit a continuously-auto-saving MMO, so we use a home-town respawn pattern instead.

### Dead code removed

- `findWorldExitIndex`, `loadWorldMapAt`, `loadWorldMapAtPosition` no longer imported by `battle-update.js` — defeat flow no longer uses them.

## 1.6.0 — 2026-04-18

### Shared-bag refactor — all 14 bags eliminated

- **State modules extracted** — `battle-state.js`, `battle-sprite-cache.js`, `hud-state.js`, `map-state.js`, `ui-state.js`. Consumers import the state object directly; no more `shared` parameter threading.
- **`fake-player-sprites.js`** — fake player canvases extracted from game.js (Step 1 of shared-bag refactor).
- **`battle-update.js` (732L)** — entire battle state machine (opening, attack chain, defend/item, run, boss dissolve, victory, defeat, PVP) extracted from game.js.
- **`movement.js` (260L)** — player movement, input dispatch, tile collision, action handling extracted. Pre-existing `MapRenderer` / `resetIndoorWaterCache` import bug fixed in `_checkFalseWall`.
- **`title-screen.js`** — `updateTitle` + `_updateTitleMainOutCase` merged in, sharing a `waterSt` ref with game.js for animation continuity.
- **game.js: 1,920L → 912L** (52% reduction). Target <4,000L achieved.

### Battle pose audit

- **Konami debugger** now the documented source of truth for pose correctness.
- **OK main `lFwd` canvas** — was null, now built from `[idle0, idle1, OK_L_FWD_T2, OK_L_FWD_T3]`. L-forward swings no longer fall back to L-back pose.
- **OK main `rFwd` canvas** — was loading garbage from ROM offset 18 (leg tiles), now built from idle tiles per debugger (R-fwd body = idle, legs-only animation).
- **OK PVP `KnifeRFwd` LEG_L** — `_FP_LEG_L_BACK_R` → `_FP_LEG_L` (idle).
- **Warrior ally attack portraits** — now use R_BACK_T2 / L_BACK[3] tiles matching main player + OK ally conventions (were all-idle / L_FWD).
- **`_FP_ATK_R_TILE`** — was aliased to `OK_R_FWD_T2` which had been "fixed" to idle T2; now correctly points to `OK_R_BACK_SWING[2]`. Restored R-back swing visual.
- **Konami debugger** — updated Warrior R-FWD LEG_L to `WR_LEG_L_FWD_R` to match code (debugger was stale since commit `e2e401d`).

### Battle message system

- **`battle-msg.js`** extracted. `replaceBattleMsg` swaps text mid-action for crits, hit count, status inflictions, spell names.
- **Phase 1**: "Attacker : Target" format for player/monster/ally turns.
- **Phase 2**: crit/hits/status result text replaces Phase 1.

### Combat fixes

- **ATK formula** — weapon power only. STR/AGI affect hit count not damage (NES disasm 30/9F44).
- **All 231 monster ATK + attackRoll** corrected from ROM stat tables.
- **Starting equipment** fixed to Knife(0x1E) + Leather Cap + Cloth Armor (matches NES).
- **Ally slash timing** — 3 frames fit in 90ms `ALLY_SLASH_MS` (was 67ms/frame, frame 2 never shown).
- **Ally slash hand/weapon** — now uses correct hand and weapon (was always right-hand + `weaponId`).
- **7 game-logic bugs** fixed: confusion targets any combatant, mini/toad ATK, per-hit shield/evade, special attacks on allies, ally poison floor.
- **EXP display** — victory screen now shows post-/4 value (matching actual gain).
- **Monster turn order** — level-based AGI proxy (`agi = level`).

### Other

- **Play time tracking** — `ps.playTime` ticks in game loop, persisted in saves, shown HH:MM on player select.
- **Victory rewards** — shown in enemy name box, save fix, chat clear.
- **PVP fixes** — `drawBossSpriteBoxPVP` stale null arg, `pvp.js` invalid LHS assignments, `drawBattleMessageStrip` stale `_s` reference.

## 1.5.0 — 2026-04-08

### Title screen, menus, CP fixes

- **Title screen airship physics** — replaced sine-wave oscillation with exponential chase drift. Ship lazily follows a wandering target using two incommensurate sine waves. No overshoot, organic non-repeating movement.
- **Player select fix** — empty "New Game" slots now show onion knight (job 0) portrait instead of current player's fighter silhouette.
- **CP earning fixes** — PVP CP now scales with opponent level (was always 1). Random encounter CP uses monster bestiary CP values (was using monster count). Boss CP reads from bestiary data (was hardcoded).
- **Stats screen layout** — widened to full 136px viewport width. Paired stats (ATK/DEF, etc.) use fixed right column with consistent alignment. Gil on its own full-width row. Removed job/CP from stats (already in job menu).
- **Equip menu** — "Optimum" abbreviated to "Opt" and moved to top-right of R.Hand row. ATK and DEF display added to bottom row.
- **Pause menu cursor fading** — all sub-menu cursors (equip, job, options) now fade in/out with NES palette steps instead of snapping on/off. Fixed property name mismatch (`drawCursorFaded` vs `_drawCursorFaded`).
- **Job menu color fading** — green (current job) and grey (can't afford) text properly fades during transitions using `nesColorFade()`.
- **Deploy fix** — server git repo reset after history rewrite divergence from previous session's deploy.sh scrub.

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
