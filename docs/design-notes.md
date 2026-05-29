# Design Notes

Intentional design decisions that aren't obvious from reading the code. One section per subsystem.

## Followups

Deferred work that's been noted in changelog entries but doesn't yet have a home in code. Tracked here so it doesn't get buried in release notes.

- **Per-spell anim registry** — `src/spell-anim.js` is the per-spell-ID registry (caster cast windup + spell-throw / target-effect frames), keyed by spell ID, with distinct tile bytes per spell and palette swaps per school. Lookup is `getSpellAnim(spellId)` / `getSpellAnimForItem(itemId)` / `getSpellAnimFrame(bundle, elapsedMs)`. The unified cast / throw / impact / apply pipeline lives in `src/combatant-cast.js` and serves player, ally, and PVP-enemy callers — exports include `drawCastWindup`, `drawSpellThrow`, `getSpellImpactSFX`, `playSpellImpactSFX`, `applySpell`, `applyMagicDamage`, `applyMagicHeal`, `applyMagicCureStatus`, `applyMagicSight`, `applyMagicDrain`, `applyMagicRecovery`, `applyMagicAllStatus`, `applyMagicInstakill`, `applyMagicErase`, `applyMagicStatus`. Render sites pull spell ID from per-context state: player cast uses `getCurrentSpellId()`, ally-cast paths use `battleSt.allyMagicSpellId`, PVP-enemy casts use `pvpSt.pvpMagicSpellId`. Cast SFX is `SFX.MAGIC_CAST = 0x62` for every spell at cast start (`spell-cast.js:72`); impact SFX is selected by `getSpellImpactSFX(spell)` (single source — fire → FIRE_BOOM, ice → SW_HIT, sleep → SLEEP_PUFF, sight → SIGHT, default SW_HIT). Adding a new spell anim: capture frames via REC OAM, land per-spell tile bytes in `spell-anim.js`, add a `getSpellImpactSFX` branch if needed, no render-site edits required.

  **History:** Original Cure animation shipped in 1.6.77 with hand-rolled `cure-anim.js` (per-school palette swap, shared flame/star caster tiles). v1.7.49 attempted a per-spell registry rewrite but mis-wired Poisona on-target frames as the caster build-up; reverted in v1.7.53. v1.7.54 re-landed Poisona target frames in the correct phase; v1.7.55 fixed ally-cast paths still hardcoded to the Cure sparkle; v1.7.56 corrected canvas dimensions. The v1.7.49 registry idea was redone correctly later — `spell-anim.js` is now the canonical registry, and `combatant-cast.js` (v1.7.181) unified the cast/throw/apply pipeline across player / ally / PVP-enemy callers. Fire shipped 1.7.100 via the parity-check harness (`tools/parity-check-spell.js` + `classify-spell-phases.js` + `render-oam-dump.js`); subsequent damage / status / cure / drain / recovery spells follow the same flow.
- **Rod weapon sprite** — OAM not yet captured (1.6.56). Falls through to no-overlay; rods aren't in any shop or loot pool, so latent.
- **Networked multiplayer** — Step 1 (WebSocket presence) hasn't started. See `MULTIPLAYER.md` for the full plan; current roster is the fake `PLAYER_POOL` from `data/players.js`. The roster Battle action *has* shipped the local search-and-hook prep (see "PVP search" section below) so Step 3 reduces to swapping the target-encounter sim timer for a websocket signal.
- **Re-enable 1.7.42 PVP enemy magic + items + roster ally items** — disabled in 1.7.43/1.7.45 (`pvp.js` `_processEnemyFlash`, `battle-turn.js` ally turn) while chasing the freeze that turned out to be a stale-deploy issue. Implementation code (`_tryPVPEnemyCure`/`_tryPVPEnemyPoisona`/`_tryPVPEnemyItem`/`_processPVPEnemyMagic`/`_tryAllyItem`/`allyMagicItemMode`) is still in the codebase but unreachable. Re-enable by reinstating the call-sites (see 1.7.42 changelog entry for the exact patch).

## Loot / drops

- **Max 1 item drop per battle.** First monster to pass the 25% drop check wins; loop breaks. Multi-monster fights can't drop 2+ items.
- **Drop check order is tallest-sprite-first.** Encounters are sorted by sprite height, so taller monsters get first dibs on the drop roll.
- **`null` in `drops` arrays is intentional.** e.g., Sahagin `drops: [null,null,null,null]` = "never drops". Code handles it correctly.
- **Chest loot is per-map, with floor tiers in Altar Cave.** `LOOT_POOLS` in `src/map-triggers.js` is keyed by `mapId`. Ur (114) drops potions/antidotes/gil only; Altar Cave F1–F4 (1000–1003) scale consumables → weak gear → Longsword/Bronze Bracers with increasing gil ranges. Crystal room (1004) is a boss room with no chests. Unlisted maps fall back to the F1 pool.
- **Gil is a valid chest entry.** Pool entries of shape `{ gil: [min, max] }` roll a random amount into `ps.gil` and show "Found N gil!".
- **SouthWind (0xB2) is not in any chest pool.** It was previously the legendary-tier chest drop; now obtainable only via late-game monster drops (Darkface, Parademon, Crocotta, Lemur).
- **`steal` field on monsters is unused.** No steal command exists in battle.
- **Ur town chests respawn 24h after looting.** Town chests (`UR_CHEST_MAPS` in `map-triggers.js`) record an open-time in `ps.consumedTilesAt` (parallel to `consumedTiles`, persisted alongside it); `expireResettableChests(mapId)` runs on map load and drops any opened-chest mutation ≥24h old so the fresh-from-ROM closed chest returns. Dungeon chests (mapId ≥ 1000) still reset on cave re-entry instead.
- **Boss and PVP victories have no item drops.** Only EXP/Gil/CP rewards.
- **Death = no rewards.** If the player is at `ps.hp <= 0` when monsters all die / boss dissolves / PVP opponent falls, EXP/gil/CP/item drops and job JP are all skipped. The victory flow is bypassed; box-close transitions straight to the `'game-over'` state.
- **Chest mimic — monsters in the loot pool (v1.7.563).** Cave chests have a `{ monster: true }` loot tier (~13–16%). When it rolls, `handleChest` (`map-triggers.js`) shows "Monster appeared!" and on dismiss calls `startChestMimic()` (`battle-encounter.js`) — normal battle flash + one random monster from that floor's encounter pool (shares `_makeEncounterMonster` with `startRandomEncounter`). The monster branch must come BEFORE the gil/item branch in `handleChest` (`{monster:true}` is an object but `.gil` is falsy).

## Hidden-treasure (vase) tiles

**Universal "search here" mechanic** (v1.7.618). Metatile ids `0x78-0x7B` are flagged by the ROM as `TRIGGER_TYPE_TABLE[idx] === 2` (treasure) and rendered as decorative terrain — vases in town interiors (tileset 5), grass spots on the Ur overworld (tileset 4), pots in caves, etc. They're collision-blocked by `map-renderer.js:495` so the player walks UP to them and presses Z, same flow as a `0x7C` visible chest.

- **Detector**: `isHiddenTreasureTile(tileId)` in `src/map-triggers.js` (range `[0x78, 0x7B]`). Used by `movement.js#_handleAction` to dispatch right after the `0x7C` chest branch.
- **Handler**: `handleHiddenTreasure(facedX, facedY)` rolls `HIDDEN_TREASURE_HIT_CHANCE` (25%) per Z. **Miss → silent** (no message, no cooldown — player can immediately re-try). **Hit → loot + 24h cooldown** via `_stampChestTime` (writes `ps.consumedTilesAt[mapId][key]`). Tile is **never mutated** (no `_consumeTile`, no `consumedTiles` entry) — vase/grass keeps its appearance forever.
- **Loot pool**: `rollHiddenTreasureLoot(mapId)` pulls from `LOOT_POOLS[mapId]` if it exists; Ur interiors (maps 1-9) without their own entry inherit `LOOT_POOLS[114]` via the `UR_CHEST_MAPS` set; everything else falls back to `DEFAULT_LOOT`. **Chest-mimic tiers are filtered out** — a vase that spawned a battle would be off-tone.
- **Cooldown**: shares the existing `expireResettableChests` machinery (24h reset on Ur-tagged maps). The server-side save whitelist for `consumedTilesAt` was added in v1.7.617 (was missing — chest cooldowns were being dropped on server round-trip).
- **Counts**: 19 hidden-treasure tiles auto-detected across Ur — map 114 × 2, map 1 × 5, map 2 × 5, map 7 × 1, map 8 × 3, map 9 × 3. Any new map with `0x78-0x7B` in its tilemap gets the function for free (no registry to update).

## Dungeon floor generation (Altar Cave)

`generateFloor(romData, floorIndex, seed)` in `src/dungeon-generator.js`. The live game seeds with `Date.now()` (`map-triggers.js:287`) on every overworld→cave entry — so reproduce in-game floors by passing large/timestamp seeds to the viewer, NOT seed 1. **Always validate gen changes with `tools/floor-view.mjs` across many seeds (incl. timestamp-style) before shipping.**

- **Floor 0 = two rooms (left/right, randomized) + corridor, traced as ONE continuous ceiling snake.** Built via the deeper-floor boundary mode, NOT two separate room outlines (that left a room's ceiling as a disconnected formation). Steps: assemble one `inside` mask (`addRoom` per room, clamped to halves, unioned) → fill ONLY the void gap between rooms as a 5-tall neck (NOT the full span — that makes a bad H-topology) → boundary-detect (inside tile touching void = CEILING, else FLOOR) → **close diagonal perimeter gaps to a fixpoint** (boundary tracing links some ceilings only diagonally) → cleanup (`enforceMinCeilingGap` → `ensureCeilingConnectivity` → `addOverhang`, which eats the neck to a 1-tile corridor) → after the secret path, a bridge-repair loop reconnects any cut-off main-floor ceiling.
- **`openEntranceLanding(tilemap, entranceX, topRow, clamp)` — LOCKED entrance-landing template** (next to `placeEntrance`). Opens a 3×3 floor pocket below the entrance frame so the player never arrives in a 1-wide neck. MUST be called AFTER `addOverhang` or the overhang pass re-walls it; the frame floor sits directly above, so no ceiling pinches it. Single source — never inline/fork.
- **Validation gotcha: count `0x44` FALSE_CEILING as a ceiling connector.** It's the disguised secret-passage tile and looks identical to ceiling; a `0x00`-only flood falsely reports the snake as broken. The secret teleport room (rows ≥22) is an INTENTIONAL separate hidden formation.
- **Ceiling/wall rules (enforced by `addOverhang`):** every CEILING needs another ceiling OR 2 `WALL_ROCKY` directly below; every rocky needs ceiling/rocky above. The entrance frame's rocky-with-void-above is ORIGINAL `placeEntrance` design — leave it.
- **Chests must sit in a corner (≥2 perpendicular walls).** `chamberBounds` = the ACTUAL floor bounding box (not `1..30`, or `findCornerFloor`'s near-edge test misses the rooms); the placement fallback is `findCornerFloor(...,null)` (any corner), NEVER `findWallAdjacentFloor` (1 wall).
- **Secret corridor restricted to outer walls** (`findCorridorCandidates` scans cols 3–7 / 24–29) so it can't carve through the center neck and split the snake.
- `buildCaveShape` gained `clamp [x0,x1]` (fill-scan restriction) + `maxWidth` params. `FLOOR_CONFIG[0]` = chests [2,4], skeletons [6,10], secrets 1.

## Death / respawn

- **Victory pose is also Defend and Magic-cast.** Canonical FF3 uses the same 4-tile arms-up stance for all three. In `src/battle-drawing.js`, defend, item-use, and magic-cast (`magic-cast`/`magic-hit` states) portraits all route through `p.defend` via the `isItemUsePose` branch — `p.defend` is built from victory tiles for every job.
- **HP is NOT restored on level-up.** Preserves death state through the end-of-battle respawn check. `src/player-stats.js:grantExp` deliberately omits `fullHeal()`.
- **Game Over screen.** When `ps.hp <= 0` at box-close or defeat-close, battle enters the `'game-over'` state. Small bordered HUD box (96×40) shows "GAME OVER" with a blinking "Press Z" prompt. `TRACKS.GAME_OVER` plays. Z press → `respawnFromGameOver()` → `_respawnAtLastTown()` (full HP/MP restore at `ps.lastTown`).

## Battle sprite pattern

- **Per-job tile indices are universal.** Every job stores its poses at the same PPU tile indices — idle `$01-$06`, R-back body-TL `$39`, L-back head-TR `$3F` + body-TR `$40` + legs `$41/$42`, L-fwd body `$3B/$3C` + legs `$3D/$3E`, R-fwd legs `$07/$08`, hit `$39-$3E`, kneel `$09-$0E`, victory `$39-$3E` + leg variants, death swaps a different CHR bank at `$01-$06`. Byte contents differ per job; mapping is shared.
- **L-back requires swapping BOTH head-TR and body-TR.** Historical bug: consumers passed `idleTiles[1]` for head-TR instead of the L-back variant's T1. If adding a new job, make sure its `knifeLTiles` pulls head-TR from the L-back data, not idle.
- **Jobs 3–21 use `_genericBundle`** in `combatant-sprites.js` — reads ROM at each job's `jobBase` using the shared tile-index convention. Approximate due to MMC3 CHR banking; PPU-capture specific poses if a job renders scrambled. (1.7.50: legacy `_initGenericJobPosePortraits` / `_buildGenericJobFullBodies` helpers in `sprite-init.js` were deleted along with the rest of the dead per-job branch — every job flows through `_buildFakePlayerSet` → `getJobPoseTileBundle`.)
- **Death tiles for every job** are at `jobBase + 0x240` (PPU tile indices 36-41), 6 tiles in a 3×2 prone grid. `_deathTilesForJob(romData, jobIdx)` in `combatant-sprites.js` is the single helper that all four bundles (OK / WR / MO / generic) use. The per-job `OK_DEATH` / `WR_DEATH` / `MO_DEATH` constants were removed in 1.7.50 once the stride was verified byte-for-byte against the ROM for jobs 0/1/2.

## Dual-wield ATK (display vs combat)

Two values must stay separate:

- **Display** (`calcAttackerAtk` in `battle-math.js`) returns `rWpnAtk + lWpnAtk + floor(str/2)`. That's the canon NES menu — sum of both equipped weapons + str bonus. Single-wield: one slot is 0 so it collapses to the equipped weapon. Unarmed Monk/BlackBelt: special level-based formula (`floor(str/4) + floor(level*1.5) + floor(jobLevel/4) + 2`). This is what shows on the equip / status screen and what's stored as `ps.atk` / `ally.atk` / fake-player `.atk`.
- **Per-hit combat ATK** is **always** computed per-hand: `floor(str/2) + (this hand's weapon ATK)`. Each hand rolls its own hits at its own ATK. RRLL split — first half of the combo uses the right hand, second half uses the left (`battle-math.js#isRightHandHit`).

How callers get per-hand from the stored display value: strip the weapon component (`displayAtk - rWpnAtk - lWpnAtk`) to recover `floor(str/2)`, then add each hand's weapon back. Player path does this inline in `input-handler.js#rollHand`. Ally + PVP-enemy use `rollHits` extended with `opts.lAtk` + `opts.splitRH=true` so a single call still produces the RRLL combo internally.

Never feed the display value directly into `rollHits` with `2 × hits` — that re-creates the 2026-05-08 OK-D+K 2× canon-damage bug (sum doubled = quadratic damage). The single-call `rollHits` always applies exactly one hand's ATK per hit. v1.7.181 worked around this by averaging (`avg(rWpn, lWpn)`) but that distorted the display so adding a weaker offhand lowered ATK — fixed in v1.7.322 by splitting display from combat properly.

## Unarmed combat (fists)

Canonical NES animation pattern, captured from PPU OAM while the Monk punched a target:

- **Base idle** (no combat action): body `$03/$04`, legs `$05/$06`, no fist sprite. Equivalent to `MO_IDLE` + `MO_LEG_L/R`.
- **R-hand strike**: body `$39/$04`, legs `$3A/$08`, fist tile `$49` visible on the body's left side. Tile bytes match what we call `MO_R_BACK_T2`, `MO_LEG_L_BACK_R`, `MO_LEG_R_BACK_R` — i.e. our `rBack` pose IS the unarmed R-strike pose, with a drawn fist overlay. Pose held for several frames while the hit-flash ($4A–$4D pal3, palette `[0x0F, 0x16, 0x27, 0x30]`) scatters at random positions across the target.
- **L-hand strike**: body `$3B/$3C`, legs `$3D/$3E`, fist tile `$51` (same bytes as `$49`, different CHR index). These are our `MO_L_FWD_T2/T3` + `MO_LEG_L_FWD_R`/`MO_LEG_R_BACK_R` — i.e. our `lFwd` pose IS the unarmed L-strike pose.
- **Between-hands idle**: a brief arms-up reset frame between R and L strikes in a combo.
- **No back-swing phase on either hand.** Unarmed skips the wind-up entirely — the first visible attack frame IS the strike.
- **Combo alternation**: **RRLL** — first half of the combo is right-hand strikes, second half left (v1.7.273). All dual-strike combatants (player dual-weapon, player unarmed, ally weapons/fists, PVP enemy) route through `battle-math.js#isRightHandHit(hitIdx, totalHits, rW, lW)` / `isLeftHandHit` (v1.7.274 modularization). Each fist hit gets 3 random-scatter slash frames + a ±2px x / ±1px y wiggle on the fist sprite during `player-slash` for impact shake. **Idle pose break only at hand change** (R↔L), not between same-hand hits.
- **Hit-flash sprite is already correct.** `initSlashSprites()` in `src/slash-effects.js` uses tile bytes byte-identical to the OAM `$4A–$4D` with the same `[0x0F, 0x16, 0x27, 0x30]` palette — the two-fist impact is already what we draw for non-bladed hits.

## Shops

- **Counters, not NPCs.** Shops in Ur are interior maps (3 = magic, 4 = armor, 5 = weapon, 8 = item). Pressing Z facing a registered counter tile opens the shop. Counter coords + `mapId` are stored on each entry in `src/data/shops.js`; lookup via `findShopAtCounter(mapId, x, y)` in `movement.js#handleAction`. Each entry has a `type` field (`'weapon'|'armor'|'item'|'magic'`); `getShopType(shopId)` is the canonical accessor.
- **FF1-style keeper sprite (v1.7.257-272).** Each shop renders a 10×10 BG tile keeper figure in the left column of the panel. Tile data lives in `src/data/shop-sprites.js`: 13 unique 2BPP tiles per keeper (the FF1 `lut_ShopkeepImage` rect is 10×10 but only 13 cells are non-blank), keyed by FF1 canonical type (`weapon`/`armor`/`white-magic`/`black-magic`/`item`) with a 4-color palette pulled from FF1's `lut_BackdropPal`. ff3mmo's 4 shop types map through `FF3MMO_TO_FF1` (current: `magic → white-magic`; black-magic keeper is staged for when a `bmagic` type lands). `_drawShopkeeper(ctx, x, y, fadeStep)` in shop.js walks `SHOPKEEP_IMAGE_LAYOUT` and decodes each tile via `tile-decoder.js`. Keeper fade is scoped to outer shop-in / shop-out (v1.7.261) — intra-shop sub-state transitions don't touch it.
- **Panel layout (v1.7.257+).** Three-zone split:
  - **Left** — keeper sprite at `(KEEPER_X, KEEPER_Y)` = `(px+8, py+4)`. Figure spans panel-relative y=20..84, x=8..56.
  - **Right** — Buy / Sell / Exit menu at `MENU_X = px+72`, always drawn. Dims to gray (NES `$10`) when the buy/sell list owns the cursor; tweens via `_menuFadeStep(state, fadeStep)` so transitions never go through black (v1.7.265). Gil stays bright across intra-shop transitions (v1.7.267).
  - **Bottom** — buy/sell item list anchored at `LIST_Y0 = py+96`. Full panel width, ROW_H=12, `LIST_VISIBLE_ROWS=4`. Scrolls via `shopSt.scroll`; blink arrows use `ui.scrollArrowUp/Down` (same primitives as the battle spell list).
- **Quantity selector (v1.7.260).** Item shops (weapon / armor / item) replace the right-column menu with a qty widget after Z on an item. Up/Down ±1, Right/Left ±10, capped by `_qtyCap(target, isSell)` at `min(99, floor(gil/price))` for buy / `min(99, entry.count)` for sell. `shopSt.qty` and `shopSt.qtyMax` track the in-flight selection. Z commits, X cancels. Magic shops keep the original blue confirm box (spells are one-time).
- **Catalog item IDs only — prices come from `data/items.js`.** That file is auto-generated from the FF3 NES ROM at `$21E10`, so prices are canonical. Sell price = `floor(buy / 2)`.
- **Magic shop is wired.** `openShop` accepts `spells:` catalogs. Spell list shows name + `SPELL_BUY_PRICE` right-aligned; confirm dialog reads "Learn X?". Buying deducts gil and pushes the spell ID into `ps.knownSpells`. Re-buying a known spell is rejected with "Already known". Sell tab is blocked for spell shops (can't sell spells). Ur magic shop sells Cure (100 gil) + Poisona (100 gil).
- **Two-phase NES transition.** Outer fade uses `buildNesFadeFrames` (`src/nes-fade.js`) — snapshots the inner viewport, NES-quantizes each pixel, applies `nesColorFade` N times to produce stepped fade frames. Phase 1 (`map-out`) plays them forward over 320ms; phase 2 (`shop-in`) fills inner area black + text-palette fades in over 500ms. Reverse on close. **Snapshot the INNER area only** (`INNER_X = 8, INNER_Y = 40, INNER_W = 128, INNER_H = 128`) so the static HUD canvas's viewport border doesn't fade with it.
- **HUD portrait flickers victory pose for equippable gear.** `_drawHUDPortrait` checks `shopHoverEquippable()` — if true and `bp.victory` exists, alternates victory ↔ idle every 250ms (same cadence as battle ally victory). Falls back to normal kneel/defend/idle.
- **ATK/DEF delta triangle.** `shopHoverStatDelta()` returns `null` for "no indicator", a number otherwise. Green ▲ for upgrade, red ▼ for downgrade, white = for same. Drawn in the 8×8 left-padding of the HUD info panel via per-row `ctx.fillRect` (NES `$2A` / `$16` / `$30`). Weapon comparison uses `Math.max(weaponR, weaponL)` with a same-ID short-circuit (so a duplicate of what's wielded reads as `=`); shields use `Math.max` of any equipped shield slot.
- **Music: FF1 NSF track 14.** Shop opens with `pauseMusic() + playFF1Track(FF1_TRACKS.SHOP)`; closes with `stopFF1Music() + resumeMusic()`. Mirrors the pause-menu pattern with `MENU_SCREEN`.
- **Confirm dialog uses blue text palette.** Box is `drawBorderedBox(.., true)` (NES `$02` blue). Text uses `[0x02, 0x02, 0x02, 0x30]` so the font shadow (color index 1/2) blends into the blue bg — same trick `message-box.js` uses. Mobile shows `A=Yes  B=No`, desktop shows `Z=Yes  X=No` via `isMobile` from `ui-state.js`.

## Magic

- **Spell knowledge is per-player, not per-job.** `ps.knownSpells = []` is an array of spell IDs the player has learned. Spells are granted by `grantStartingSpells(jobIdx)` on `changeJob` (and on save load), or bought from the magic shop. White Mage starts with Cure (`0x34`) and Poisona (`0x35`). `STARTING_SPELLS` map is in `player-stats.js`.
- **MP cost is flat per spell.** `SPELL_MP_COST` map in `data/spells.js` maps spell ID → MP cost. v1: Cure = 4, Poisona = 2. Approximates NES per-level slot cost as a flat MP value.
- **White magic uses MND, black magic uses INT.** Per NES FF3 disasm. `_rollMagicAmount(power, useMnd)` in `spell-cast.js` and `_applyPauseSpellUse` in `input-handler.js` both branch on `spell.element === 'recovery'` (or `target === 'cure_status'`/`'revive'`) → MND, else INT. Formula: `floor(stat/2) + power + rand(0..floor(atk/2))`.
- **Battle slot 1 = Magic for mage jobs (3/4/5).** `executeBattleCommand(1)` checks `_MAGE_JOBS` + `ps.knownSpells.length > 0` and routes to magic mode (otherwise Defend). Magic uses `inputSt.menuMode = 'magic'` to piggyback on the item-menu state machine — same `item-menu-out` → `item-list-in` → `item-select` → `item-target-select` fades, branched on `menuMode` for spell-list rendering / spell-pick input.
- **Battle cast pipeline.** `cmd === 'magic'` in `_playerTurnMagic` (battle-turn.js) → `startSpellCast(spellId, { allyIndex | enemyIndex, targetMode })` in `spell-cast.js`. Deducts MP, builds the target list per `targetMode`, rolls amount (once for multi-target — divided at apply time, like Southwind), sets up state machine: `magic-cast` (250ms windup, victory pose via `isItemUsePose`) → `magic-hit` (400ms anim, apply heal/damage, hold to 1100ms, walk through `_targets[]` if multi-target, end turn). Cure plays `SFX.CURE` (same as Potion) via `applyMagicHeal`; impact SFX for thrown spells is selected by `getSpellImpactSFX(spell)` in `combatant-cast.js` (fire → FIRE_BOOM, ice → SW_HIT, sleep → SLEEP_PUFF, sight → SIGHT). Visual: cast windup + spell throw + target effect dispatch through `combatant-cast.js`; per-spell tile bytes live in `spell-anim.js`.
- **Multi-target spells.** `MULTI_TARGET_SPELLS = new Set([0x34])` + `isMultiTargetSpell(id)` in `data/spells.js` is the single source of truth. The input picker (`input-handler.js _battleInputItemTargetSelect`) reads it via `allowMulti = isBattleItem || isMultiSpell`; the cast resolver (`spell-cast.js startSpellCast`) reads it via `_targets.length > 1` to switch from per-target re-roll to "roll once / divide by `targets.length`" (Southwind pattern). Adding a new multi-target spell: add the ID to the set. No render-site or callsite edits needed. Picker UX: from any ally pick (player or roster, single mode) press **Right** → `'all-allies'`; **Left** from `'all-allies'` returns to single-ally pick. Enemy side reuses the existing battle-item col-left / col-right / all picker. Cursor blinks at 133ms in `'all'` modes (matches Southwind's enemy-side cursor blink).
- **Status-cure spells** (Poisona, Bndna, etc.) — `spell.target === 'cure_status'` branch in `_applySpellEffect`. `SPELL_CURE_FLAG` map (`spell.type` → `STATUS.*`) drives `removeStatus(...)` on target. Heal-num is rendered as `value: 0` so the green-number bounce still shows the cast happened.
- **Pause-menu Magic uses inv-* state machine** via `pauseSt.menuMode = 'inv' | 'magic'`. Spell list with MP cost right-aligned. Picking a spell stashes ID in `pauseSt.useSpellId` and routes to `inv-target` for player/roster pick — Cure on roster heals that player's HP; Poisona removes their poison status. Returns to spell list after the heal anim. `menuMode` resets to `'inv'` on `inv-text-in` → `'open'`.
- **Spell-list rows render `icon + Shrines short-name`** at four sites (battle Magic, pause Magic, magic shop, ally inspect). The icon byte ($72 Summon / $74 White / $75 Black) is the first byte of the ROM string; the magic-school grouping comes from there. The visible name is sourced from `SPELL_NAMES_SHRINES` in `data/spells.js` (56 entries; ASCII strings capped at 5 chars per `shrines.rpgclassics.com/nes/ff3/spells.shtml`) and encoded to tile bytes by `getSpellNameShrines()` in `text-decoder.js`. Battle-log / message-strip / chat callers stay on `getSpellNameClean` (no icon, no override) so spell names embedded mid-sentence render plain. Shipped v1.7.241 (icon reveal), v1.7.242 (Shrines override). v1.7.243 attempted a 2-column pause Magic grid + tightened battle Magic cost gap; reverted in v1.7.244 — user prefers the breathing room the shorter names create.

## PVP search

> **PvP DISABLED v1.7.502** behind `PVP_ENABLED` (server `ws-presence.js` +
> client `pvp-search.js`); the "Battle" roster item is removed. Live two-phone
> PvP battles desynced completely — the client-side lockstep model can't hold
> cross-phone `rand()`-cursor determinism (same failure that killed co-op,
> v1.7.500). All code is left in place for a rewrite to an authoritative-host
> model (one side computes outcomes + relays deltas; the other renders). The
> design below is as-built. Re-enable: flip both flags + re-add `'Battle'` to
> `ROSTER_MENU_ITEMS`. See the `ff3mmo-pvp-disabled` memory.

- **Roster Battle = search-and-hook, not instant duel.** Lives in `src/pvp-search.js`. Picking *Battle* in the roster menu calls `startPVPSearch(target)` → persistent "Searching for X..." message + roster row marquees "Searching...". The target rolls a hook check on a sim timer (8–15 s); on success the message swaps in-place (via `replaceMsgBoxText` — no slide flicker) to "Connecting...", auto-advances after 1000 ms, and hands off to the existing `_startPVPBattle(target)`.
- **Hook formula.** `clamp(BASE_HOOK + (chAGI − tgtAGI) × AGI_PER_PT + jobBonus, HOOK_MIN, HOOK_MAX)` — tunables at top of `pvp-search.js`. Defaults: 0.25 base, 0.015 per AGI point, [0.10, 0.75] clamp. Thief +0.15, Ranger +0.08. AGI is the lever (STR/INT/MND already drive other systems; AGI was thin).
- **Search persists across map changes; only resolution gates on a valid PVP location** (`battleState === 'none' && (mapSt.onWorldMap || mapSt.dungeonFloor >= 0)`). Hook rolls fired while in town count as a missed roll — prevents fishing from town forever. 3 missed-in-a-row OR 5 min real-time → "Search expired" + 60 s cooldown per target.
- **Single seam to multiplayer.** Fake target encounter rolls are simulated by a per-target timer in `tickPVPSearch`. When the websocket layer lands, replace the sim with the server-relayed `target_encountered` signal; rest of the flow is unchanged. See `MULTIPLAYER.md`.
- **Forfeit UX.** Z is **inert** while "Searching..." is held — the message IS the search; can't A-confirm it away. X (back) forfeits, replaces the message with "Cancelled". Movement is blocked while the message is up (`msgState.state !== 'none'` gates the arrow-key handler). During "Connecting..." (`isSearchResolving()` true) Z dismisses normally for an early auto-advance into battle.
- **Cancel via menu.** Re-opening the roster on the active target flips the menu label `Battle` → `Cancel`. `drawRosterMenu` reads `isSearchingFor(inputSt.rosterMenuTarget)`. Battle precondition gate widened so cancel works from town.

## Co-op battle architecture — REMOVED (v1.7.500)

Party-member co-op random encounters + Battle Assist were **ripped out in v1.7.500**. Three architectures were attempted over ~2 weeks and all froze the guest phone: deterministic lockstep (v1.7.418-472), host-authoritative deltas behind `COOP_HOST_ARB` (v1.7.474-477), and a viewer/card-game model behind `COOP_VIEWER_MODE` (v1.7.486-496). Random monster encounters are **solo-only** now.

A from-scratch rebuild is planned. **Read the `ff3mmo-coop-rebuild` auto-memory before starting** — it has the failure history, the four root causes (no single authority, the concurrent-trigger race, fragile guest renderer, stat divergence at the wire boundary), and what survives. The removed implementation (`coop-resolver/applier/deltas/viewer/view-anims`, `encounter-wire`, the `encounter-*` wire kinds, `_encounterGroups`) is in git history before v1.7.500.

**Two fixes from the removal effort survive** because they're correct independent of co-op and PvP relies on them:
- Monster-attack branch unification (`battle-enemy.js#_targetCombatant`) — collapsed the divergent ps-target vs ally-target branches into one. Guarded by `tools/encounter-sim.js`.
- Realized-stats wire profile (`main.js#connectNet` ships `atk/def/evade/mdef/...`) + the `generateAllyStats` realized-stats fast path. Eliminates the `recalcCombatStats` vs `generateAllyStats` stat-divergence class. Guarded by `tools/wire-stats-diag.js`.

## Roster fade

- **Roster panel fade is tied to every wipe via `_rosterTransFade()` in `roster.js`.** Matches the HUD top-box pattern at `hud-drawing.js:160-171`:
  - `'closing'` → ramps 0 → max synced to `WIPE_DURATION` (~733 ms)
  - `'hold'` / `'loading'` / `'trap-falling'` → holds at max (black)
  - `'opening'` → ramps max → 0, **except** when `transSt.topBoxAlreadyBright` (title→game / hud-fade-in completed) — then returns 0 (no double fade)
  - `'hud-fade-in'` → ramps max → 0 synced to `hudInfoFadeTimer` (alongside the HUD top-box)
  - Otherwise → fall through to `infoFade` (the right-side HUD info ramp)
- **`Math.max(playerFade, transFade, rosterBattleFade)`** picks the dominant fade in `_drawRosterRow`. `rosterBattleFade` is the slow tick-based fade from `_updateBattleFade` — gated on `transSt.state !== 'closing' && !== 'hold' && !== 'loading' && !== 'trap-falling'` so it doesn't ramp-in concurrently with a wipe during the defeat → respawn flow.
- **Respawn flow.** `respawnAfterDeath()` passes a real `destMapId` to `triggerWipe` (`'world'` for the world-exit case, `fallbackMapId` for the town case) so `rosterLocChanged` is correctly computed and the trans-fade engages even for same-loc respawns.
- **`transSt.rosterLocChanged` is set by `triggerWipe` / map-triggers but no longer read by the roster fade** (v1.7.229 dropped the gate so trans-fade fires on every wipe, not just loc-changing ones). Left in place in case a different consumer needs it later.

## NES palette fade (inn bed, future scenes)

`src/nes-palette-fade.js` is a reusable hardware-style palette fade. The NES swaps its whole palette in **discrete steps** and never blends colors — so a "fade" is a sequence of palette snaps, NOT an RGB alpha crossfade.

- **`buildPaletteFade(keys)`** takes captured keyframes `[nesFrame, BG0×4, BG1×4, BG2×4, BG3×4]` (row 0 = the lit/source state) and returns `{ durationMs, finalLut, lutForProgress(prog) }`. Each `lut` is a 64-entry source→target NES-index map built by pairing each keyframe's palette slots against frame 0; **unmapped colors stay identity**, so any color not in the BG palette (sprites, UI) is never touched.
- **`applyPaletteLut(ctx, lut, x, y, w, h)`** snaps a canvas region in place via reverse RGB→NES-index lookup. Callers must re-render the source frame each tick (the game does), so pixels are always the lit source colors going in.
- **Captured keyframe data lives in `src/data/*-fade-palette.js`** — currently `inn-fade-palette.js` (REC OAM `$3F00` dump, f1266+, keyframes 0/5/8/12/16/20/24/28/32/36/40, frame 0 lit → frame 40 dark hold). Cadence = span frames ÷ 60 (≈667 ms for the inn).
- **Do NOT lerp RGB between endpoints.** v1.7.509 shipped an alpha crossfade (in-between colors that aren't real NES colors) even though the capture had every discrete keyframe; rebuilt discrete in v1.7.516. The endpoint was right; the interpolation was the bug.

## Bed rest (inn sleep)

`src/bed.js` is the inn rest scene. Step onto any bed tile to rest: HP/MP refill only (status untouched), no cost.

- **Tile-identity trigger, not per-coordinate.** `src/data/beds.js` (`isBedTileId(tileset, metatileId)`) is the registry — map 8 inn (tileset 5) bed tiles `0x0a/0x0b/0x62`. Every present/future bed works with no per-map setup. `map-renderer.js#isBedTileAt` makes bed tiles passable and `map-triggers.js#checkTrigger` calls `openBed()` — fired from `movement.js#_onMoveComplete`, so the step lerp is always complete before the scene starts.
- **Lifecycle (`bedSt.state`):** closed → `settle` (300 ms, sprite faces `DIR_LEFT`, music pauses) → `fade-out` (≈667 ms, the inn palette fade) → `sleep` (6 s dark hold; the rest jingle `playSFX(0)` fires on the first fully-dark frame, not during the fade; input drained so it can't be skipped) → `fade-in` (auto, no wake button) → `walk-out` (`startMove(DIR_DOWN)` one tile off the bed) → on step-land `showMsgBox(POND_RESTORED)` + close. Heal happens at the sleep→fade-in transition (`_rest()`), `saveSlotsToDB()` checkpoints.
- **The dim runs in the render pipeline, not the game-loop draw list.** `render.js#_renderMapAndWater` checks `isBedDimming()` and, while dimming, dims the BG layer (map **and** overlay) via `drawBedDim(ctx)` BEFORE the sprite pass — so player / NPC / candle sprites composite on top at full brightness and never fade by color collision. (v1.7.521 fix: the old game-loop `drawBed()` dimmed the composited frame including sprite pixels.)
- **`POND_RESTORED` in `data/strings.js` = "HP/MP Restored"** is shared by the bed and the pond heal (`map-triggers.js#handlePondHeal`). The slash uses the AWJ font's real glyph at byte `0xC7` (`text-decoder.js` CHAR_MAP, not a best-fit placeholder).

## Battle attack animation

- **Per-hit cycle.** Each hit goes through three states: `attack-back` (wind-up pose) → `attack-fwd` (transition, `FWD_SWING_MS`) → `player-slash` (impact, `getSlashHoldMs(weaponId)` from `slash-effects.js` — per-weapon: blade `3 × 30 ms = 90 ms`, impact `2 × 30 ms = 60 ms`). On a miss or shield-block, the slash *flash* is suppressed but the body-pose dwell still runs the full `SWING_HOLD_MS` so the strike rhythm reads consistently. Suppression lives inside `drawSlashOverlay` itself (1.7.48) — callers pass `hit` via opts and the helper short-circuits via `shouldDrawSlash`; no caller-side wrapper required.
- **Back-swing duration.** Hit 0 always uses `BACK_SWING_MS` (~167ms, full visible wind-up). Same-hand subsequent hits also use `BACK_SWING_MS` (every weapon hit gets the full wind-up). Hand change inserts `IDLE_FRAME_MS` (67ms) in idle pose. Fists skip the back-swing entirely (`delay = 0` when unarmed) — punches go straight to forward strike.
- **Idle pose only at hand boundary.** `_getPortraitSrc` `handChangeGap` flag fires when `attack-back && currentHitIdx > 0 && hand changed` — drops back to idle pose for the gap. Same-hand inter-hit gap stays in back-swing pose.
- **Slash logic lives in `slash-effects.js`** — single source of truth across player, ally, PVP, and drawing paths (consolidated in 1.7.4, hit-gate folded inside in 1.7.48). Exports: `SLASH_FRAME_MS` (30 ms / frame), `getSlashPattern(weaponId)`, `setSlashOffsetForFrame(state, weaponId, frame)` (player), `shouldDrawSlash(hit)` (rejects miss + shield-block; used internally by `drawSlashOverlay` and externally by adjacent state checks like portrait blink), `getSlashHoldMs(weaponId)` (total slash duration), `drawSlashOverlay(ctx, frame, frameIdx, originX, originY, opts)` (ally / PVP renderer; `opts.hit` opts in to internal hit-gating, `opts.mirror` flips for opponent slashes, `opts.weaponId` selects scatter pattern), `resetSlashScatterCache()` (re-roll RNG between hits).
- **Slash scatter is per-weapon, PPU-derived.** Two patterns:
  - **Bladed** (knife / sword / katana / dagger) — deterministic UR→LL diagonal: 3 frames at `[(16,-16), (0,0), (-16,16)]`, 1 frame each. PPU step `(-16, +16)` per frame.
  - **Impact** (everything else — fists, staff/rod, nunchaku, claw, hammer, etc.) — single RNG-scattered position per hit, range `±12 x / ±20 y`, held 2 frames. Multi-hit combos visibly scatter because each hit re-rolls.
  Confirmed against PPU traces of OK dual-wield knives (clean diagonal), WM staff swing (RNG), and full Monk dual-fist combo (4 RNG impacts in 8 frames). Pre-1.7.1 this was a hand-coded `(8, -8) → (0, 0) → (-8, 8)` for blade and `Math.random() * 16 - 8` for non-blade — both wrong; PPU showed double-magnitude diagonal for blade and the staff-arc theory was a misread of multi-hit RNG.
- **Per-hit RNG re-roll.** Player slash sets the offset once per hit in `_advanceHitCombo` / `setSlashOffsetForFrame(battleSt, weaponId, 0)` (or per hold-window for blade's 3-frame diagonal). Ally + PVP-opponent slash use `_scatterFor(weaponId, frameIdx)` (private to `slash-effects.js`) which caches the RNG roll per hold-window so render calls within the same NES frame agree (no per-render jitter). `resetSlashScatterCache()` is called at every `ally-slash` / `pvp-enemy-slash` state entry so RNG re-rolls cleanly per hit.
- **Slash sprite per weapon subtype.** `getSlashFramesForWeapon(id, rightHand)` in `battle-sprite-cache.js` routes which sprite tile to draw (separate concern from scatter pattern):
  - knife/dagger → `bsc.knifeSlashFramesR/L`
  - sword → `bsc.swordSlashFramesR/L`
  - staff/rod/nunchaku → `bsc.staffSlashFramesR/L` (PPU-captured tiles `$4D-$50` SP3 palette; nunchaku piggy-backs on the staff cache after PPU verified byte-identical)
  - fists → `bsc.slashFrames` (initSlashSprites red two-fist impact)
- **Fist body wiggle.** During `player-slash` when `handWeapon === 0`, the **whole player portrait** (body + fist + overlays) jitters ±1 px x at ~30ms cadence — applied at the parent draw site by adjusting `pxs` (mirrors the NES OAM trace where the entire Monk body group origin alternates 180/181 between impact frames). Bladed strikes hold rock-steady. Pre-1.7.1 this was incorrectly applied only to the fist sprite at ±2 x / ±1 y, so the fist drifted relative to the arm.

## Damage / heal numbers

- **Digit sprites are dedicated, not the text font.** FF3J battle popups use a separate chunky digit tile run at sprite slots `$56-$5F` (tiles for digits 0-9, `digit N = $56 + N`). Source: ROM offset `0x1B170`, 16 bytes per tile. Land them as raw `Uint8Array` literals in `damage-numbers.js BATTLE_DIGIT_TILES` — same pattern as `MISS_TILE_*`. The text font (`$80-$89`, used by `font-renderer.js`) is the skinnier set used in menus/HUD, not damage popups.
- **Render path.** `drawBattleNum(ctx, bx, by, value, palette)` builds 8x8 canvases per (digit × palette) lazily and caches in `_digitCanvasCache` keyed by `palette.join(',')`. Subsequent draws are pure `ctx.drawImage`. Adding a new color = construct a new 4-entry palette `[transparent, outline, fill, unused]` and pass it in; the cache handles the rest.
- **Palette format.** `[0x0F, 0x0F, fill, 0x0F]` — slot 1 = outline (NES master `0x0F` black), slot 2 = fill, slots 0/3 transparent. Damage = `0x25` pink-red, heal = `0x2B` green-cyan, crit = `0x28` gold. (Heal `0x2B` was inherited from the pre-rewrite text-font palette and not yet verified against a Cure-target REC OAM — adjust if the in-game shade looks off.) Don't put the fill color at slot 3; the digit tiles use color-index 2, not 3.
- **Bounce table is REC-OAM-traced.** `DMG_BOUNCE_TABLE` in `data/animation-tables.js` is 33 keyframes at 60fps — frames 0-32 verified pixel-for-pixel against an FF3J REC OAM capture (2026-05-07). Lifetime `DMG_SHOW_MS = 550ms` ≈ 33 × 16.67. Keyframes describe the popup's vertical offset from baseline: rises 25 px, holds at peak, falls back, brief overshoot, small second bounce, dip to +6, hold, vanish. If the popup ever looks like it freezes near the end, check that the table has 33 entries — the `Math.min` clamp in `_dmgBounceY` will hold the last value if the table is short.

## Saves

- **`saveSlotsToDB()` is the single source of truth for the save schema.** Every persisted field is copied from `ps` / `playerInventory` / position getter inside that function. Callers must NOT also copy fields inline — that pattern was removed in the v1.6.74 audit. New callers just invoke `saveSlotsToDB()`.
- **Save triggers.** Every mutation that changes durable state must invoke `saveSlotsToDB()` before the player can lose it: shop buy/sell, chest pickup, pond heal, pause-menu item use / equip / auto-equip / job-switch enforce, battle victory (monster, boss, PVP), title screen actions, page `beforeunload`. Without an explicit trigger, state lives only in memory until one of the others fires.
- **MP is persisted.** Older saves reset MP to `maxMP` on every load; v1.6.74 added `mp` and `statusPoisonTick` to the save shape, so spent mana and active poison ticks now survive a session.
- **Server + IndexedDB dual-write.** Each save call writes the full slot array to local IndexedDB AND pushes per-changed-slot to the server via `window.ff3Auth.serverSave`. Server load is preferred on boot (only if at least one slot has data) with IndexedDB as fallback.
- **Position checkpoint is overworld-only (v1.7.268).** `setPositionGetter` in `main.js` returns `null` to `saveSlotsToDB` whenever `mapSt.onWorldMap === false` or `shopSt.state !== 'closed'`. Save still writes inventory / gil / HP / stats — just skips `worldX / worldY / onWorldMap / currentMapId`. So walking around a town, dungeon, or shop never moves the respawn point. NES-style: only "you're on the overworld" updates the checkpoint.
- **Entry-tile checkpoint (v1.7.275).** Stepping on a town / dungeon entrance from overworld → `loadMapById` captures `mapSt.worldX/Y` into both `ps.lastWorldExitX/Y` (death respawn) and the slot's saved position (via a `saveSlotsToDB()` call fired BEFORE flipping `mapSt.onWorldMap` to false). Dying or logging out in floor 4 of the Altar Cave now respawns the player at the cave entrance tile on overworld, not at the gate of the last town they walked through.
- **Dungeon `consumedTiles` wipe (v1.7.276).** Altar Cave regenerates its layout with a `Date.now()` seed on every overworld → cave transition. Previous runs' `ps.consumedTiles[1000..1004]` were carrying over and slamming "opened chest" tiles ($7D) onto positions that don't correspond to chests in the new layout — visible as "ghost chests" floating mid-floor. Cave-entry trigger (`destMap === 111`) wipes every `ps.consumedTiles[mapId]` where `mapId >= 1000`. Town tiles (`mapId < 1000`) keep their persisted state.

## Item icons

- **AWJ ROM ships dedicated per-class icons inline.** Since the v1.7.298 swap from Chaos Rush → A.W. Jackson (`patches/ff3-awj.ips`), every item name's first byte in the ROM string is already a class-specific icon glyph — no overrides needed. `ICON_TILES` in `text-decoder.js` recognizes `$E0-$FE` (item class) + `$72-$75` (spell-school) as icon bytes. `getItemNameWithIcon(itemId)` just preserves the leading byte + strips padding; `getItemNameShrines(itemId)` prepends the same ROM-supplied byte to the Shrines short-name letters.
- **AWJ item-class icon bytes:**
  - $E0 shield, $E1 robe/light body, $E2 mail/heavy body, $E3 helmet, $E4 gauntlet, $E5 bracer
  - $E6 claw, $E7 nunchuck, $E8 book, $E9 rod, $EA staff, $EB hammer, $EC spear, $ED knife, $EE axe, $EF sword, $F0 katana, $F1 harp, $F2 bow, $F3 arrow, $F4 bell, $F5 boomerang, $F6 shuriken
- **AWJ tile encoding:** icon tiles paint **color index 1** (1bpp on plane 0); some 2-tone icons (robe / mail / helm) also use **color index 3** for inner accents. Letters paint color index 3. All exported text palettes (`TEXT_WHITE` etc.) and `_makeFadedPal` in `palette.js` pair color 1 = `$10` (light grey, icon body) + color 3 = `$30` (white, letters + highlight). Any new palette must follow the same pattern or icons render invisibly (the v1.7.298-1.7.300 regression class).
- **Removed in the AWJ swap:** seven hand-extracted `*_TILE_BYTES` overrides in `font-renderer.js` (arrow / claw / bracer / staff / mail / spear / robe) and their matching `*_ITEM_IDS` / `*_ICON_BYTE` constants in `text-decoder.js`. AWJ has all of these natively. The v1.7.278-285 split work paid back its own tech debt cleanly.
- **Known limitation — leather + robe share `$E1`.** AWJ groups all light/cloth body armor (Cloth, Leather, Kenpo, DarkSuit, Wizard, BlackBelt, Bard, Scholar, Gaia, WhiteRobe, BlackRobe) under one tunic-silhouette glyph. CR had the same grouping. Distinguishing leather from mage-robe would require a custom override glyph; not currently shipped.

### DS-exclusive ultimate gear (IDs 0xC8-0xDF)

- **24 items past the ROM string range** added v1.7.286: Ultima Weapon (Mognet quest reward) + 22 Legendary Blacksmith job-mastery rewards + Onion Blade. Stats lifted from FF3 DS, jobs mapped to ff3mmo's NES analogs (DS Dark Knight → Magic Knight; Evoker → Conjurer; Devout → Shaman; Magus → Warlock). Celestial Gloves (DS Freelancer reward) are unrestricted — Freelancer doesn't exist as a separate class in ff3mmo.
- **Synthesis path** — each entry carries an explicit `icon: 0xNN` field. `getItemName(itemId)` short-circuits to `new Uint8Array([icon])` when the field is present, bypassing the ROM string lookup that would otherwise read past `0x04C7` into the spell table. Name letters come from `ITEM_NAMES_SHRINES` as usual. No new code paths in the renderers — `getItemNameWithIcon` / `getItemNameShrines` keep working unchanged.
- **Icon bytes match AWJ item-class slots** (v1.7.308 rewire — they used CR slots originally). Ultima/Onion Blade/Save the Queen/Murakumo → `$EF` sword; Lilith Rod/Millenium Rod → `$E9` rod; Holy Wand/Sage Staff → `$EA` staff; Angel Robe/Crimson Vest/Master Dogi → `$E1` robe; Astral Bracers → `$E5` bracer; Celestial/Shura Gloves → `$E4` gauntlet; Gigantic Axe → `$EE`; Mighty Hammer → `$EB`; Magic Lance → `$EC`; Gladius → `$ED`; Artemis Bow → `$F2`; Omnitome → `$E8`; Blessed Bell → `$F4`; Royal/Ballad Crown → `$E3`; Muramasa → `$F0`.
- **No pickup mechanism yet.** Data-only registration. Drop tables / shop slots / job-mastery hooks deferred. When implementing pickup, candidates are: (a) rare drops from new endgame monsters (mirrors the Onion-equipment-from-dragons pattern), (b) a post-game crystal shop, (c) job-level-99 grant (closest to DS semantics).

## NPCs

`src/npc.js` is the canonical NPC runtime (v1.7.291-297). First NPC shipped: a moogle on Altar Cave floor 1.

- **Sprite source — always ROM-extracted.** ff3mmo has a documented sprite-extraction pipeline. NEVER hand-author NPC sprites. For the moogle: `MOOGLE_GFX_ID = 42` → `MOOGLE_SPRITE_OFF = 0x01EA10`, palette `MOOGLE_PAL = [0x0F, 0x0F, 0x16, 0x30]` (exported from `sprite-init.js`). For a new NPC, grep `sprite-init.js` for the gfx ID convention and add a parallel `{NAME}_GFX_ID` / `{NAME}_PAL` export — reference image + ROM offset, never a pixel grid. See also memory note `feedback_ff3mmo_never_hand_author_sprites.md`.
- **Render shares the player's `Sprite` class.** One instance per NPC type, lazy-init on first draw, configured per-NPC at draw time. The shared `WALK_FRAMES` map (tiles 0-3 DOWN, 4-7 UP, 8-15 SIDE with HFLIP for RIGHT, plus `bottomFlip` and `yOff` walk-bob) gives 4 directions × 2 frames for free.
- **Render Y-anchor must use `spriteY` (not `originY`).** Map tiles use `originY = SCREEN_CENTER_Y + 3`; sprites use `spriteY = SCREEN_CENTER_Y`, the 3-pixel "sprite stands on the tile" offset. Inheriting this is what makes NPC feet line up with the player on the same row. `drawNpcs(ctx, camX, camY, originX, originY, spriteY)` — pass `spriteY` and use it for the Y world-to-screen transform.
- **FF-style wander loop.** Walk burst = 1-3 tiles in one direction (`runRemaining` rolled at burst-start, walk = 480ms per tile, same-direction continuation via `_trySameDir`). Pause = random 1500-4000ms. Pathway-avoidance: `_isOpenAreaTile` requires FLOOR + ≥3 walkable neighbors so NPCs never roam onto a 1-wide corridor and can't block the player's path.
- **Collision is lerp-aware and symmetric.** `_tileOccupied` treats the player as occupying `Math.floor` AND `Math.ceil` of `worldX/worldY` (the player straddles two tiles mid-walk). Other NPCs check both `tileX/Y` (current/destination) and `walkFromX/Y` (source during walk). `findNpcAt` (called from `movement.js`) is also symmetric.
- **Talk-facing.** When the player presses Z facing an NPC, `talkFacing` pins the render direction to the OPPOSITE of the player's facing (NPC turns to look at you). Cleared in the `onAllDone` callback of `showMsgBoxPages`. Wander freezes during dialogue (`msgState.state !== 'none'`).
- **Placement + lifecycle.** `clearNpcs()` must be called on every map transition (dungeon load, regular-map load, world-map load). Defensive render guard: `drawNpcs` only fires when `mapSt.mapRenderer && mapSt.mapData && !mapSt.onWorldMap`.
- **Dialogue lives in `src/data/npcs.js`** as a `dialogue: [...]` field per NPC. The catalog key convention is `<mapname>_<idx>` for ROM-anchored NPCs, descriptive id for synthetic ones (e.g. `altar_moogle`).
- **Tick site:** `updateNpcs(dt)` is called from `game-loop.js` once per frame, gated on `battleSt.battleState === 'none'`. Don't add a parallel update hook.

### Town keepers + scene NPCs (v1.7.524-532)

- **Scene NPCs** (opening elder/attendants, town keepers) use the player `Sprite` class with `gfxBase` overridden to a raw ROM walk-bundle offset (`addSceneNpc(key, x, y, spec)`). A spec is `{ romOffset, palTop, palBtm, dir, animate, dialogue? }` (header-inclusive offset). `animate:true` → idle-march in place; `false` → static frame 0. Optional `dialogue` array → talk-faces + `showMsgBoxPages`.
- **Town keepers are data-driven** via `TOWN_NPCS` (map ID → keeper list) in `src/data/town-npcs.js`, placed by `npc.js#placeTownNpcs(mapId)` (called for every regular map). One render path; add a keeper by adding a registry row. Shop keepers sit behind counter tiles → unreachable → stay `DIR_DOWN` (no talk-facing); reachable NPCs (e.g. the innkeeper at map 8 (3,14)) talk-face normally.
- **Wandering NPCs randomize spawn per map entry (v1.7.769).** Specs with `wander: true` ignore their declared `(n.x, n.y)`; `placeTownNpcs` builds a pool from `TOWN_NPC_GRASS_TILES[mapId]` (tilemap ids matching the per-map grass set), filters out `mapSt.encounterPatch` tiles + tiles failing `_isOpenAreaTile`, shuffles, and assigns the first N to the N wanderers. Static keepers + `idle-march` NPCs keep their fixed coords. To add wanderers to a new map: add a `TOWN_NPCS[mapId]` entry AND a `TOWN_NPC_GRASS_TILES[mapId]` row; in `_loadRegularMap`, ensure any `mapSt.encounterPatch` flood-fill runs BEFORE `placeTownNpcs(mapId)`.
- **Finding a sprite from an OAM snap:** `tools/npc-sprite-tool.mjs` (`search <hexbytes>` → ROM offset; `render <off> [palTop] [palBtm]` → 4-direction PPM). Byte-search the displayed **top-row, unflipped** OAM tiles — the dump's auto-reconstructed "base $00" bundle often follows the *player* sprite, not the NPC.
- **Opening intro cutscene (v1.7.532):** on a fresh-slot new game (map 7, 4,4), `queueOpeningIntro()` (title-screen) queues a scripted elder+attendant conversation; `tickOpeningIntro()` (game-loop) fires it once the entry fade settles. `OPENING_INTRO` (`data/opening-scene.js`) is `[{dir, text}]`; the player sprite turns to face each speaker via the `showMsgBoxPages` `onPage(idx)` hook. Open box locks movement until the last line. Queued only on fresh-slot — never on revisit/respawn.

## Music (FF3 / FF1 / FF2 NSF)

Three (now four) libgme emulators run side-by-side in `src/music.js`, each fed an NSF built at runtime from the user's ROM (never distribute the rip).

- **FF3 (main):** `nsf-builder.js` (MMC3, banks `$36/$37/$38/$39/$09`). `playTrack(TRACKS.*)` / `stopMusic` / `pauseMusic` / `resumeMusic`. Plus a 2nd FF3 emulator for SFX (`playSFX`).
- **FF1:** `ff1-nsf-builder.js` (bank `$0D`, init `$B003`, play `$B099`). `initFF1Music` / `playFF1Track(idx)` / `stopFF1Music`.
- **FF2 (J):** `ff2-nsf-builder.js` (bank `$0D`, **PLAY `$9800`, INIT-song `$9867`** with id in zero-page `$E0`, 31-song table `$9E0D` — RE'd from ROM, xref [everything8215/ff2](https://github.com/everything8215/ff2)). `initFF2Music` (boot.js#loadFF2ROM) / `playFF2Track(idx)` / `stopFF2Music` / `ff2MusicReady`. RE helper: `tools/ff2-sound-re.mjs`.
- **Building/area music** is wired in `map-loading.js#_loadRegularMap`. The elder house (maps 6+7) plays FF2 `FF2_TRACKS.ELDER_HOUSE` (track 24): null `pendingTrack`, `stopMusic()` (FF3), `playFF2Track` — idempotent across both floors, restores the FF3 town theme on exit, guarded by `ff2MusicReady()`.
- **Track indices are 0-based** (`gme_start_track`); don't infer them from "track N" names. Audition by ear with the `/ff1 <n>` / `/ff2 <n>` dev commands (`chat.js`), then lock the constant.

## Message-box dialogue surface

`src/message-box.js` (v1.7.297) is the canonical overworld dialogue surface. Any new dialogue (NPCs, signs, item-pickup blurbs, post-event explainer text) goes through this — do NOT spin up a parallel box.

- **API.** `showMsgBox(bytes, onClose?)` — one-shot. `showMsgBoxPages(pages, onAllDone?, onPage?)` — multi-page; `onPage(idx)` fires as each page becomes active (used by the opening intro to turn the player toward the speaker). `replaceMsgBoxText(bytes, onClose?)` — text-swap mid-hold without re-animating (used by PVP search, not normally needed for dialogue). `dismissMsgBox()` — force slide-out from `hold`; don't call directly inside a multi-page chain, let the page driver own the lifecycle.
- **State machine.** `msgState.state` ∈ `{ 'none', 'slide-in', 'hold', 'page-scroll', 'slide-out' }`. Slide-in / slide-out use `SLIDE_MS = 80` (whole box slides through the top of the viewport). `page-scroll` uses `SCROLL_MS = 160` (box stays still, text scrolls inside an inner clip `boxY+4 to boxY+boxH-4`). `msgState.onAdvance` is the multi-page hook — when set, the overworld Z handler in `movement.js` routes to it instead of `dismissMsgBox`.
- **Scroll-up transition.** `showMsgBoxPages` plays slide-in once for page 1; every Z scrolls the previous page UP and the next page in from below over 160ms; slide-out only after the final Z. Spam-press Z mid-scroll snaps to the next page. Final Z forces slide-out regardless of current sub-state.
- **Text centering.** `_drawMsgText` centers on **visual glyph height** (`GLYPH_H = 8`) not nominal `lineH = 12`. The trailing 4px gap below the last line was biasing 3-line pages toward the top of the box — fixed in v1.7.297, do not revert. Inner clip `boxY+4 to boxY+boxH-4` keeps the scrolling text from bleeding over the border tiles.
- **Layout.** Box is 144 × 48px, top-aligned in HUD viewport (`HUD_VIEW_Y = 32`). Wrap is 16 chars/line via `_wrapMsgBytes`; 3 lines max fit comfortably. Write dialogue strings short enough that the wrap result lands at ≤3 lines per page.
- **Behavior coupling.** Movement is blocked while `msgState.state !== 'none'` (overworld Z handler in `movement.js`). NPC wander ticks also freeze the same way. `onClose` (one-shot) / `onAllDone` (pages) fire AFTER slide-out completes, in `updateMsgBox`.

## Battle message strip

`src/battle-msg.js` (v1.7.287-288). The in-battle right-side strip is a separate non-blocking surface — different system from the overworld `message-box.js` above.

- **Non-blocking.** Animations never wait on the strip. The old `msg-wait` and `message-hold` battle states were deleted in v1.7.287 along with every gate that paused the state machine for the strip to drain (`battle-enemy.js`, `battle-update.js`, `spell-cast.js`). Strip runs entirely on its own 1200ms clock (200 fade-in + 800 hold + 200 fade-out).
- **Queue collapsed to one slot.** `queueBattleMsg` and `replaceBattleMsg` are the same function: if a message is already displaying, the new text swaps in place without re-fading and the hold timer resets. The queue array is gone; new turns / status / crit / hits / slain all cut in immediately.
- **Display names are Shrines short-names.** Battle-strip + PVP-strip + item-use messages route through `getSpellNameShrinesClean` / `getItemNameShrinesClean` (v1.7.288) so the strip shows `Ice` / `Ice2` / `Ice3` instead of raw ROM `Bzzard` / `Bzzra` / `Bzzaga`. Without these helpers the strip diverges from the spell menu / shop / inspect panels.
- **Don't add new `isBattleMsgBusy` gates.** That predicate is gone. If you need to delay something post-attack, gate it on the actual animation completing, not on the strip.

## Monster data

- **`src/data/monsters.js` is auto-generated from the ROM** via `tools/gen-monsters-js.js`. That script reads `$60010` (monster props), `$61010` (stat table, indexed via byte 9/12 of the props), `$61210` (attack scripts), gil/EXP/CP tables, and preserves `steal`/`drops`/`location` from the existing file. To regenerate: `node tools/gen-monsters-js.js > src/data/monsters.js`. Verify the result against `tools/rom-dump-monsters.txt` before committing.
- **`statusResist` order is high-bit-first** (death, petrify, toad, silence, mini, blind, poison, paralysis) — same decoding as `statusAtk`, driven by `statusVal` in the generator.

## Encounter rates

- **Per-zone, data-driven.** Each zone in `src/data/encounters.js` has a `rate` (`high`/`normal`/`low`/`fixed`); `RATE_STEPS` maps it to a `{base, spread}` step range (steps until the next roll — lower = more frequent). `battle-encounter.js#tickRandomEncounter` resolves the current zone via the shared `currentEncounterZoneKey()` helper (also used for the formation pick) and draws the threshold from the rate. Changing a zone's frequency is a one-word edit; no logic change.
- **Current rates:** `high` 10–19 (~2× — Ur dark-tile patch / `grasslands_wild` = killer bee + werewolf), `normal` 15–29 (Ur valley goblins, Altar Cave floors), `low` 20–39 (open world grass), `fixed` = never random-rolled (boss). The gate for *whether* to tick (`inDungeon`/`onGrass`/`inPatch`) is separate from the cadence.

## Level cap

- **`MAX_LEVEL` in `src/player-stats.js` is the single source** (currently 5). `grantExp` stops there and pins `expToNext` to `0xFFFFFF`; `expToNextForLevel(lv)` is the shared threshold helper for the level-up loop and the save-load path; `title-screen` clamps legacy higher-level saves down on load. `api.js` mirrors the cap as a server-side clamp (1–5) on the save whitelist. Pause menu shows `MAX` at the cap. Job levels are a separate system (still 99).

## Moderation (open beta)

- **`moderation.js` (repo root, pure ESM)** is the single source, imported by `ws-presence.js`. `sanitizeName` strips a display name to renderable font glyphs (no emoji/zero-width/homoglyph spoofs); `cleanChatText` masks profanity (de-leet + repeat-collapse + Scunthorpe-safe exact match for ambiguous words); `isCleanName` rejects profane names → "Player". Names are sanitized in `_normalizeProfileField`; all chat (world/party/pm) is masked in the relay. Soft + tunable — masking only changes display, never drops the message. `api.js` adds a per-IP `/api/register` cap (5 burst, then 1/10min).

## Chat & PM

- **Channels:** world (global — every helloed client; v1.7.700, was loc-scoped through v1.7.699 but felt broken for an MMO), party (membership-scoped via `_inSameParty`), pm (targeted by `toUserId`, name fallback). Server relay = `ws-presence.js` `case 'chat'`; client receive + send = `src/chat.js`.
- **@-mentions:** typing `@` + Tab autocompletes from the online roster (`getOnlinePlayers`). An incoming message that `@`-mentions you (`_mentions` vs `localPlayerName()`) renders gold and plays a chime; PMs chime too unless you're already on the Private tab.
- **Mention chime = FF2 NSF track 8** (`FF2_TRACKS.MENTION_CHIME`). `music.js#playMentionChime` plays it on a dedicated 5th emulator so it never disturbs map music; one-shot (auto-stops at track end or 2.2 s).
- **PM commands:** `/pm` `/w` `/tell` `/msg <name> <message>`, `/r <message>` (reply to last). `_sendPm` is the shared send path (also used by the roster "Message" action via `focusPmSession`).
- **Private tab = per-conversation sessions.** Up/down in tab-select pages partners (`pmSessionStep`); the view filters to the focused partner (`_activePmPartner`) and the `→Name` prompt + reply target follow it. `_pmSession` outranks `pendingRecipient`, so `focusPmSession` (roster Message / `/pm`) overrides the focused conversation.

## Beta/dev gate

- **Soft client-side curtain** (`#pw-gate` in `index.html`), not real auth — account login + save validation sit behind it regardless. `server.js` injects the password from the `GATE_PASSWORD` env var into `{{GATE_PASSWORD}}`/`{{GATE_DISPLAY}}` (`.replaceAll`, since the tokens also appear in comments): unset → `ff3dev` (closed-beta default), `off`/empty → disabled, any value → custom. Same codebase runs gated on dev and open (or differently keyed) on the beta server just by changing the launch env.
- **Open-beta landing copy** (v1.7.597): `#landing-pitch` inside `#rom-picker-wrap` carries the public pitch — lede + sub + gold "OPEN BETA" tag. Auto-hides with the picker when gameplay starts. `#rom-hint` collapsed to "You supply your own ROMs — nothing is uploaded." Gate-dialog copy neutralized to `◆ Beta ◆` + "Beta password required." so a cached gate page doesn't read closed-beta.

## Tap-to-enter splash + storage gesture rule

**Load-bearing UX**, not cosmetic. `index.html` ALWAYS shows the `#pw-gate` overlay before the ROM picker, even when `GATE_PASSWORD=off`. When the gate is off the password input is hidden and the button is rebranded "Enter"; pressing it calls `unlockGate()` exactly like the closed-beta password-submit path. v1.7.625.

The pre-gate-flip flow required typing `ff3dev` and clicking Enter on every fresh tab — that was an **accidental user-gesture guard** for the first IndexedDB access. Mobile Firefox (and other browsers with strict tracking protection) classify an origin's IndexedDB as session-only when the first storage access happens BEFORE any user activation; subsequent tab closes wipe it. The post-flip auto-`unlockGate()` path (for returning users with `authToken` in localStorage) ran `loadCachedROMs` before any tap and triggered exactly that classification, breaking ROM cache persistence (player report → v1.7.620-625 thrash).

The splash restores the gesture guard. On the first `pointerdown` / `touchstart` / `keydown` after the splash, `_requestPersistentStorage` calls `navigator.storage.persist()` to ask the browser for durable storage explicitly — Firefox grants it automatically given user activation. The log line `[storage] persist requested → GRANTED|DENIED` lands in the console.

**Hard rule going forward:** never call `unlockGate()` automatically at module load (it touches `loadCachedROMs` and downstream `saveSlotsToDB` paths). Anything that touches `ff3mmo-roms` IndexedDB (ROM bytes, save slots) must run inside a user-gesture context. If a future change wants to bypass the splash on returning visits, the bypass needs a different gesture source first.

Also pulled v1.7.621: server no longer attaches `Clear-Site-Data: "cache"` on `?_v=` version-bust reloads. At least some browsers interpreted that header as broader than spec and wiped IndexedDB between sessions on every version bump. `Cache-Control: no-store, no-cache, must-revalidate` is the actual HTTP-cache defense.

## /health uptime endpoint

- **`GET /health`** in `server.js` (before the `/api/` dispatch) returns `{ status, version, uptimeSec, players, playersTotal, gate }` as `application/json`. Unauthed, unrate-limited, `Cache-Control: no-store`, `Access-Control-Allow-Origin: *`. `players` (visible — helloed only) is the user-facing count; `playersTotal` includes mid-handshake sockets. `gate` reports `'on'`/`'off'` so the same probe surfaces beta status. v1.7.592.
- **Source of player count:** `getPlayerCounts()` exported from `ws-presence.js` walks `_connected` once. Includes both live entries (helloed) and is the single source — don't duplicate the iteration elsewhere.
- Nginx proxies via `location /` (no nginx config change needed).

## Open-beta persistence (parties + presence_shadows)

Two SQLite tables in `api.js` survive disconnect + pm2 restart so the world doesn't reset every time the process bounces.

- **`parties` table** (v1.7.595): `member_user_id` PK → `inviter_user_id`. Helpers: `partyAddMember`, `partyRemoveMember`, `partyRemoveByInviter`, `partyLoadAll`. `_partyMemberships` Map in `ws-presence.js` is the in-memory mirror, seeded at boot.
  - **Lifetime:** removed ONLY by explicit `party-dismiss` (inviter) or `party-leave` (member). Disconnect no longer dissolves a party.
  - **Disconnect:** both member-disconnect and inviter-disconnect broadcast `party-member-left` (symmetric); `party-disbanded` is no longer fired server-side (client handler kept for backward compat).
  - **Reconnect fan-out (first hello):** `_getPartyMates(userId)` returns related userIds (inviter + peer members + members this user invited). Server sends `party-snapshot` to the user listing currently-online mates and `party-member-joined` to each online mate. Reuses existing client message handlers — no client change.

- **`presence_shadows` table** (v1.7.596): `user_id` PK; `name`, `loc`, `profile_json`, `last_seen`. Index on `last_seen` for the reap query. Helpers: `presenceFlushBatch` (one `db.transaction` for batched INSERT OR REPLACE), `presenceDelete`, `presenceLoadRecent`, `presenceReap`.
  - **Constants** (in `ws-presence.js`): `PRESENCE_TTL_SEC = 600` (10min), `PRESENCE_FLUSH_MS = 30000`, `PRESENCE_REAP_MS = 60000`.
  - **Boot load:** recent rows seed `_shadows` (same shape as `_connected` entries minus `ws`). Boot logs `Presence: restored N shadows` if non-empty.
  - **Snapshot integration:** `_snapshotPayload` walks `_connected` first (helloed) then `_shadows` (deduped via `seen` Set). Client doesn't differentiate — same payload shape. A real `hello` evicts the matching shadow; the existing `player-join` broadcast upserts in clients that had the shadow.
  - **Reap:** every 60s, drops `_shadows` entries with `lastSeen < cutoff`, broadcasts `player-leave` for each (so live clients clean their rosters), then `presenceReap(cutoff)` clears SQLite rows.

- **SIGTERM survival (the non-obvious bit):**
  ```js
  let _gracefulShutdown = false;
  process.on('SIGTERM', () => { _gracefulShutdown = true; });   // DO NOT exit
  ```
  Setting the flag without calling `process.exit` means pm2's SIGTERM doesn't trigger close handlers. pm2 escalates to SIGKILL after `kill_timeout`, and SIGKILL is uncatchable — close handlers don't run, so shadows persist across the restart. Voluntary tab-close still hits the close handler with `_gracefulShutdown=false` and calls `presenceDelete(userId)`. Dev `Ctrl-C` (SIGINT) is intentionally untouched.

- **Party-always-join battle (v1.7.594):** `tryJoinPlayerAlly` in `src/battle-update.js` drops the same-room gate for party members. They join battle on `online`-only; non-party roster (auto-assist) is still room-scoped. Wire-PvP path unchanged. Reconcile + fill share one `partyNames = new Set(partyInviteSt.partyMembers)` so the leave-check and the join-fill agree.

## Roster Trade (real multiplayer)

Roster → Trade is a real-MP item transfer (v1.7.598). The original v1.7.237 implementation was a single-player sim that destroyed items on accept-roll regardless of whether the target was a real player — that was a black-hole bug with the post-fake-player roster, fixed pre-gate-flip.

- **Wire shape** (mirrors party-invite's relay + give-item's trust model):
  - `trade-offer { targetUserId, itemId }` — sender → server. Server validates target is online + itemId 1-255. New offer overwrites prior; prior target gets `trade-cancelled`.
  - `trade-offer-incoming { fromUserId, fromName, itemId }` — server → target.
  - `trade-response { fromUserId, accept }` — target → server. Validated against `_pendingTrades.get(fromUserId).targetUserId === entry.userId`; stale/spoofed responses dropped silently.
  - `trade-result { targetUserId, targetName, accept, reason? }` — server → sender. `reason='offline'` when the target is unreachable.
  - `trade-cancel` — sender → server. Server relays `trade-cancelled` to the target.
  - Disconnect cleanup notifies the surviving side via either `trade-cancelled` (if user was an offerer) or `trade-result { accept:false, reason:'offline' }` (if user was a target).
- **Server state:** `_pendingTrades` Map in `ws-presence.js` (offererUserId → { targetUserId, itemId, expiresAt }). Single outstanding offer per sender. `TRADE_OFFER_TTL_MS = 6 * 60 * 1000` — looser than the client's 5min timeout so cancel-race always has a slot.
- **Client (`src/trade.js`):**
  - Sender: `commitOffer` calls `sendNetTradeOffer(target.userId, itemId)`. Refuses if target lacks `userId`. `tickTrade` runs only timeout / death-cancel — no local accept-roll. `cancelTrade` calls `sendNetTradeCancel` on user / timeout / death so server pending clears.
  - Receiver: `setNetTradeOfferHandler` prompts via `showMsgBoxPrompt('<Name> offers <Item> Z=ok X=no', accept, decline)`. Auto-declines if `battleState !== 'none'` or `msgState.state !== 'none'` or `tradeSt.state !== 'closed'` (busy guard mirrors party). Accept → `addItem` + `sendNetTradeResponse(true)`; decline → `sendNetTradeResponse(false)`. `tradeSt.recvFromUserId` tracks the current prompt's sender so a `trade-cancelled` for a stale offerer doesn't dismiss the wrong prompt.
  - Sender's `setNetTradeResultHandler`: accept → existing `_resolveAsAccept` (1s "Accepted" hold then `removeItem`); decline → "Declined"; offline → "Offline".
- **Hardening (v1.7.616 — open-beta prep):**
  - **Server type-whitelist** in `trade-offer`: `ITEMS.get(itemId).type` must not be `'key'` (quest flags, not real inventory) and the id must be known. Rejected offers never reach the target; server emits `trade-result { accept: false, reason: 'blocked' }` back to the sender, and `src/trade.js` surfaces "Cannot trade" via `cancelTrade('blocked')`. Sender's local consume never fires.
  - **Audit log** — every `trade-response` and every `trade-offer` rejection is recorded in the SQLite `trades` table (defined in `api.js`) via `tradeLog(senderUserId, senderName, targetUserId, targetName, itemId, accepted, reason)`. Schema: `id, ts (epoch ms), sender_user_id, sender_name, target_user_id, target_name, item_id, accepted, reason`. Inspect with `node tools/trade-audit.cjs` (modes: bare = recent N, `sender <userId>`, `item <hex|dec>`).
- **Remaining trust limitation:** server still doesn't validate ownership of NON-key items. A modded client can `trade-offer` an ordinary itemId they don't have, target accepts, target's client adds the item → free items for the receiver. Open-beta accepted limitation — full fix requires a server-side inventory mirror (queued post-flip, ship only if `trade-audit` surfaces actual abuse).

## Mobile controls

- **On-screen deck** (`#mobile-controls` in `index.html`), shown via `@media (max-width:520px)` or the `is-touch` body class (`isMobile` from `ui-state.js`). Game Boy layout: CHAT/LOG flat top strip (right-aligned), D-pad left, A (upper-right) / B (lower-left) on the diagonal, SELECT/START as `-22°` angled center pills. Every button carries a `data-key`; the multi-touch slide handler walks `[data-key]` and dispatches synthetic `KeyboardEvent`s + toggles `.pressed`, so the same code path serves keyboard and touch. CHAT's `data-key="t"` also focuses the hidden `#mobile-input` to summon the keyboard.
- **Audio gesture-unlock:** `music.js#unlockAudio` (create + resume the shared `AudioContext`) is wired to a one-shot pointer/touch/key handler in `main.js` — mobile autoplay policy otherwise leaves music + the @-chime silent. `touch-action: manipulation` on the canvas kills double-tap-zoom over the play area.

## Options menu

- **Rows** (`src/pause-menu.js`, `_drawPauseOptions` / `_pauseInputOptions`): Color, Music, SFX, Battle, CRT. Data-driven by row index — up/down moves `pauseSt.optCursor`, left/right changes the focused row's value. Adding a row = draw it, handle its index, bump `OPT_ROW_COUNT`. `OPT_ROW_H` = 16px pitch.
- **Device prefs** live in `src/settings.js` (localStorage key `ff3_settings`, **per browser, NOT per save slot**): `musicVol`/`sfxVol` (0-10), `battleSpeed` (0/1/2), `textSpeed` (reserved, unused — see below). `getSetting`/`setSetting` + helpers `volGain`, `battleSpeedMult`, `BATTLE_SPEED_LABELS`.
- **Volume:** two master-gain buses in `music.js` — `musicMasterGain` (FF3/FF1/FF2 emulators) and `sfxMasterGain` (SFX + @-mention chime). Every per-emulator gain routes through one of these; the per-track fade-out ramps still ride each emulator's own gain node, so volume and fades don't fight. `applyMusicVolume`/`applySfxVolume` re-read the setting → master gain. Stored volume auto-applies on first audio (masters read the setting on lazy create). `resumeMusic` routes through the music bus (it used to bypass straight to destination).
- **Battle speed:** `battleSpeedMult()` (0.65 / 1.0 / 1.6) scales `dt` once at the top of `updateBattle` (`battle-update.js`), so timers, message holds, and animations pace together. Normal = 1.0 (default play unchanged). Solo-only — fine because PvP/co-op are disabled and nothing wire-synced depends on battle dt.
- **No text-speed control (intentional):** the engine has no per-character typewriter (dialogue renders whole) and the overworld message box advances on button-press, not a timer — so a text-speed slider would have nothing real to bite on, and in-battle message pacing already follows Battle Speed. A real one would mean adding a typewriter reveal to `message-box.js` + `battle-msg.js` (separate feature). The `textSpeed` setting key exists but is unwired.

## Inventory delete mode

The pause-menu Items tab supports deleting items via a fixed **trash slot** in the panel's bottom-right corner. The trash is always visible and behaves as a navigable inventory slot — `invScroll === INV_CAP` (= 16 as of v1.7.689; was 8 v1.7.599–v1.7.688), one past the last item row. Pause panel scrolls to fit (7 rows visible with up/down arrows; battle Item menu paginates horizontally with L/R arrows).

- **Trash sprite** is the real FF3 discard-menu trash can — a 2×2 cluster of BG tiles `$58`/`$59`/`$5A`/`$5B` from the FF3J item-discard menu (BG snap @ frame 1905, cols 7-8 / rows 19-20, BG3 palette). Composited into a 16×16 silhouette in `src/data/inventory-icons.js#getTrashCanvas`. Only color index 3 (white) renders; indices 0/1/2 stay transparent so the BG-blue field doesn't bleed onto the HUD. The same file exports `getUpArrowCanvas` (tile `$E8`, OAM, vflipped — the discard-menu up-arrow, originally mis-shipped as the trash in v1.7.599). See `[[ff3mmo-snap-bg-for-menu-icons]]` for the lesson.
- **Two delete paths**, both share the same `showMsgBoxPrompt` confirm and `_yesNoLabels()` helper (mobile A/B, desktop Z/X):
  1. **Navigate-then-pick.** Arrow-down past row 7 → cursor on trash. Z (no held) calls `_pauseInvTrashZPress` → sets `deleteMode = true`, leaves `invScroll === INV_CAP`. Doubled cursor visual appears at the trash. User arrows up to pick an item; Z fires `_pauseInvDeletePress` (confirm by item-row index).
  2. **Drag-held-to-trash.** Z on an item picks it up (`heldItem = invScroll`, v1.7.600 swap/move pattern). Navigate to trash, Z → `_pauseInvDeleteHeld` (confirm prompt for the held item by index).
- **Cursor pattern mirrors v1.7.600 item-switching exactly.** Item-row code draws held cursor first at `px+8` (underneath, static), active cursor second at `px+4` (on top, moving). Trash code mirrors: engaged-cursor first at `tx-12` (held role), active-cursor second at `tx-16` when `onTrash` (active role, moves). Total cursor count never exceeds 2 — onTrash+engaged shows doubled at trash, onItem+engaged shows held at trash + active on item, no engaged shows single on whichever slot. Draw order matters — moving cursor sits on top of static cursor in the overlap region.
- **SELECT keyboard shortcut** stays as an equivalent quick-toggle into delete mode (`pauseSt.deleteMode = !pauseSt.deleteMode`, clears `heldItem` first). Mobile users use the nav-to-trash flow.
- **After a successful delete:** `invScroll = 0`, `deleteMode = false`, `heldItem = -1` (drag path only). Single one-shot delete per engagement; to delete again, re-engage via trash or SELECT.
- **Prompt input gating** (CRITICAL for any pause-launched prompt): `handlePauseInput` early-returns `false` when `msgState.isPrompt` is on. Without this, `_pauseInputInventory` would eat Z/X before `movement.js`'s `msgState.isPrompt` handler (~line 162) could see them, and the prompt would never resolve. Mobile A→`z`, B→`x` via `data-key` in `index.html`.
- **Cursor on trash gating:** drawn only when `pauseSt.state !== 'inv-target' && pauseSt.state !== 'inv-heal'` (so target-pick / heal-anim flows don't double-cursor).

## Player color (palette)

- **Per-character** `ps.palIdx` (0-7), set in Options → Color. Persisted in the save slot (`save-state.js` / `save.js`), survives the server round-trip (`api.js` whitelist clamp 0-7), and is broadcast in the presence profile (`main.js`, replacing the old hardcoded `palIdx: 0`) so other players see your color in roster/battle.
- **Single source:** `jobBattlePalette(jobIdx, palIdx)` in `src/data/players.js` resolves the 4-entry NES palette (only color 3, the outfit, varies across slots). `battle-drawing.js#_jobPalette` delegates to it, so the player and AI allies share one resolver. `swapBattleSprites(jobIdx, palIdx)` in `src/job-sprites.js` is the one entry point that repaints every view: walk sprite (`sprite.setPalette`, live each frame) + battle/HUD/portrait (`loadJobBattleSprites` → rebuilt canvases; HUD portrait reads `bsc.battlePoses`).
- **Slot 0 = job canon, byte-identical to pre-feature.** Battle build keeps the original ROM/`JOB_BATTLE_PAL_OVERRIDE` palette at slot 0 and only pulls from the table at slots 1-7. Walk sprite returns the PPU-traced `JOB_WALK_PALS` verbatim at slot 0; slots 1-7 recolor only the outfit slot(s) listed in `WALK_OUTFIT_SLOTS` (deliberately excludes Monk hair / Black Mage face so a color swap never tints skin/hair/face).

## Phoenix Down revive (FenixDown)

FenixDown (item `0xA9`, `effect: 'revive'`) — rare Altar Cave chest loot (F2/F3/F4,
`LOOT_POOLS` weights 2/2/3). Two ways it triggers, both running one sequence in
`src/battle-fenix-revive.js` (a self-contained sub-FSM under `battleState ===
'fenix-revive'`):

- **Player on-death (auto):** when the player would die holding a FenixDown,
  `tryStartFenixRevive` (called at the single death chokepoint in
  `updateBattleTimers`, which runs before all state handlers — so the scattered
  `ps.hp<=0` box-close routes no-op) seizes the battle. It does NOT consume the
  item until the player confirms.
- **Manual ally revive:** selecting FenixDown in the battle Item menu auto-targets
  the first downed ally (`_itemSelectZ`; errors if none — you can't revive the
  living). `_playerTurnConsumable`'s `revive` branch calls `startAllyRevive(idx)`.

**Phases:** `dmg-hold → death-anim → confirm → angel → rise → healnum`.
- `dmg-hold` (player only): hold on the hit (shake + damage number) — the portrait
  does NOT fall until the number finishes, so it reads hit → number → fall.
- `death-anim`: the death pose plays out (~1s).
- `confirm` (player only): "Use FenixDown? A:Yes B:No" via `showMsgBoxPrompt`
  (v1.7.687 — was `showMsgBox` + a bespoke Z/X branch in `_battleInputHoldStates`
  until v1.7.643 promoted the universal modal msgbox handler in
  `movement.js#handleInput` above `handleBattleInput`, stranding the branch and
  freezing the FSM on YES). The modal handler now routes Z → `fenixConfirmYes`
  and X → `fenixConfirmNo` the same way it drives party-invite, trade,
  inventory-delete, and locked-door prompts. Item consumed only on YES.
- `angel`: the FF3 party-death spirit (`src/data/revive-angel-sprite.js` — 2×2
  tiles, SP3 palette, 3-frame flap, captured OAM) appears beside the body and
  drifts up; `SFX.REVIVE` (NSF track `0x92`) plays.
- `rise`: HP restored to ~1/3 max (status cleared for the player), death pose
  fades, portrait slides up, "Revived" message.
- `healnum`: green heal number pops on the returned portrait (HP restored), then
  the turn resumes (player: fresh round / victory if simultaneous death; ally:
  next turn).

**Rendering:** player path in `battle-draw-player.js` death block; ally path in
`battle-draw-allies.js` death block (gated to `fenixReviveAllyIndex()`). Both key
off the phase getters. The death pose honors `ps.palIdx` (custom color). NOTE:
`'fenix-revive'` had to be added to `_isEncounterCombatState()` (battle-draw-encounter.js)
or the enemy box vanishes during the sequence — the usual new-`battleState`
predicate-coverage gotcha. `drawMsgBox` renders LAST in game-loop so the confirm
box sits on top of the battle.

**SFX capture gotcha:** the death/revive SFX is NSF track `0x92`, captured by
starting REC *before* death (the genuine `$7F49=$D1` write). An earlier capture's
steady-state `$40` was the post-consume residual, not the request — see SFX.SIGHT
/ FIRE_BOOM notes.
