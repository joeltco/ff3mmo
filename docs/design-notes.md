# Design Notes

Intentional design decisions that aren't obvious from reading the code. One section per subsystem.

## Followups

Deferred work that's been noted in changelog entries but doesn't yet have a home in code. Tracked here so it doesn't get buried in release notes.

- **Damage spells (Black Mage)** — only Cure + Poisona shipped (1.6.77). INT-based formula and `magic-cast`/`magic-hit` pipeline are already there; needs spell content (Fire/Blizzard/Bolt etc.), per-spell SFX, and per-spell anim sprites.
- **Per-spell anim + SFX** — current cast visual is the SouthWind sprite reused; damage spells fall back to `SFX.SW_HIT` (1.6.77, 1.6.83). Each spell needs its own PPU-captured tile set + SFX entry.
- **Rod weapon sprite** — OAM not yet captured (1.6.56). Falls through to no-overlay; rods aren't in any shop or loot pool, so latent.
- **Ally render path for jobs 3–21** — opponent (PVP) rendering is on the unified bundle path for all 22 jobs; ally rendering is on bundle for {OK, Warrior, Monk} only, generic 3–21 still on the legacy `_initGenericJobPosePortraits` / `_buildGenericJobFullBodies` path with the older tile-index pattern (1.6.45, 1.6.52). Latent today since `boot.js` only seeds `[0, 1, 2]`; will surface as soon as a fake-player entry uses jobIdx ≥ 3.
- **Delete Monk legacy ally helpers** — `_initMonkPosePortraits` / `_buildMonkFullBodies` were kept "for one release as a rollback safety net" after 1.6.45 migrated Monk ally render to the bundle path. Once visually verified across a release, delete them.
- **Networked multiplayer** — Step 1 (WebSocket presence) hasn't started. See `MULTIPLAYER.md` for the full plan; current roster is the fake `PLAYER_POOL` from `data/players.js`.

## Loot / drops

- **Max 1 item drop per battle.** First monster to pass the 25% drop check wins; loop breaks. Multi-monster fights can't drop 2+ items.
- **Drop check order is tallest-sprite-first.** Encounters are sorted by sprite height, so taller monsters get first dibs on the drop roll.
- **`null` in `drops` arrays is intentional.** e.g., Sahagin `drops: [null,null,null,null]` = "never drops". Code handles it correctly.
- **Chest loot is per-map, with floor tiers in Altar Cave.** `LOOT_POOLS` in `src/map-triggers.js` is keyed by `mapId`. Ur (114) drops potions/antidotes/gil only; Altar Cave F1–F4 (1000–1003) scale consumables → weak gear → Longsword/Bronze Bracers with increasing gil ranges. Crystal room (1004) is a boss room with no chests. Unlisted maps fall back to the F1 pool.
- **Gil is a valid chest entry.** Pool entries of shape `{ gil: [min, max] }` roll a random amount into `ps.gil` and show "Found N gil!".
- **SouthWind (0xB2) is not in any chest pool.** It was previously the legendary-tier chest drop; now obtainable only via late-game monster drops (Darkface, Parademon, Crocotta, Lemur).
- **`steal` field on monsters is unused.** No steal command exists in battle.
- **Boss and PVP victories have no item drops.** Only EXP/Gil/CP rewards.
- **Death = no rewards.** If the player is at `ps.hp <= 0` when monsters all die / boss dissolves / PVP opponent falls, EXP/gil/CP/item drops and job JP are all skipped. The victory flow is bypassed; box-close transitions straight to the `'game-over'` state.

## Death / respawn

- **Victory pose is also Defend and Magic-cast.** Canonical FF3 uses the same 4-tile arms-up stance for all three. In `src/battle-drawing.js`, defend, item-use, and magic-cast (`magic-cast`/`magic-hit` states) portraits all route through `p.defend` via the `isItemUsePose` branch — `p.defend` is built from victory tiles for every job.
- **HP is NOT restored on level-up.** Preserves death state through the end-of-battle respawn check. `src/player-stats.js:grantExp` deliberately omits `fullHeal()`.
- **Game Over screen.** When `ps.hp <= 0` at box-close or defeat-close, battle enters the `'game-over'` state. Small bordered HUD box (96×40) shows "GAME OVER" with a blinking "Press Z" prompt. `TRACKS.GAME_OVER` plays. Z press → `respawnFromGameOver()` → `_respawnAtLastTown()` (full HP/MP restore at `ps.lastTown`).

## Battle sprite pattern

- **Per-job tile indices are universal.** Every job stores its poses at the same PPU tile indices — idle `$01-$06`, R-back body-TL `$39`, L-back head-TR `$3F` + body-TR `$40` + legs `$41/$42`, L-fwd body `$3B/$3C` + legs `$3D/$3E`, R-fwd legs `$07/$08`, hit `$39-$3E`, kneel `$09-$0E`, victory `$39-$3E` + leg variants, death swaps a different CHR bank at `$01-$06`. Byte contents differ per job; mapping is shared. See `/home/joeltco/.claude/projects/-home-joeltco/memory/reference_battle-pose-tile-map.md` for the full table.
- **L-back requires swapping BOTH head-TR and body-TR.** Historical bug: consumers passed `idleTiles[1]` for head-TR instead of the L-back variant's T1. If adding a new job, make sure its `knifeLTiles` pulls head-TR from the L-back data, not idle.
- **Jobs 3–21 use `_initGenericJobPosePortraits` / `_buildGenericJobFullBodies`** in `sprite-init.js` — reads ROM at each job's `jobBase` using the shared tile-index convention. Approximate due to MMC3 CHR banking; PPU-capture specific poses if a job renders scrambled.

## Unarmed combat (fists)

Canonical NES animation pattern, captured from PPU OAM while the Monk punched a target:

- **Base idle** (no combat action): body `$03/$04`, legs `$05/$06`, no fist sprite. Equivalent to `MO_IDLE` + `MO_LEG_L/R`.
- **R-hand strike**: body `$39/$04`, legs `$3A/$08`, fist tile `$49` visible on the body's left side. Tile bytes match what we call `MO_R_BACK_T2`, `MO_LEG_L_BACK_R`, `MO_LEG_R_BACK_R` — i.e. our `rBack` pose IS the unarmed R-strike pose, with a drawn fist overlay. Pose held for several frames while the hit-flash ($4A–$4D pal3, palette `[0x0F, 0x16, 0x27, 0x30]`) scatters at random positions across the target.
- **L-hand strike**: body `$3B/$3C`, legs `$3D/$3E`, fist tile `$51` (same bytes as `$49`, different CHR index). These are our `MO_L_FWD_T2/T3` + `MO_LEG_L_FWD_R`/`MO_LEG_R_BACK_R` — i.e. our `lFwd` pose IS the unarmed L-strike pose.
- **Between-hands idle**: a brief arms-up reset frame between R and L strikes in a combo.
- **No back-swing phase on either hand.** Unarmed skips the wind-up entirely — the first visible attack frame IS the strike.
- **Combo alternation**: fists alternate R/L every hit (`isHitRightHand` returns `(hitIdx % 2) === 0` when unarmed). Each fist hit gets 3 random-scatter slash frames + a ±2px x / ±1px y wiggle on the fist sprite during `player-slash` for impact shake. **Idle pose break only at hand change** (R↔L), not between same-hand hits.
- **Hit-flash sprite is already correct.** `initSlashSprites()` in `src/slash-effects.js` uses tile bytes byte-identical to the OAM `$4A–$4D` with the same `[0x0F, 0x16, 0x27, 0x30]` palette — the two-fist impact is already what we draw for non-bladed hits.

## Shops

- **Counters, not NPCs.** Shops in Ur are interior maps (3 = magic, 4 = armor, 5 = weapon, 8 = item). Pressing Z facing a registered counter tile opens the shop. Counter coords + `mapId` are stored on each entry in `src/data/shops.js`; lookup via `findShopAtCounter(mapId, x, y)` in `movement.js#handleAction`.
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
- **Battle cast pipeline.** `cmd === 'magic'` in `_playerTurnMagic` (battle-turn.js) → `startSpellCast(spellId, { allyIndex })` in `spell-cast.js`. Deducts MP, rolls amount, sets up state machine: `magic-cast` (250ms windup, victory pose via `isItemUsePose`) → `magic-hit` (400ms anim, apply heal/damage, hold to 1100ms, end turn). Cure plays `SFX.CURE` (same as Potion); damage spells default to `SFX.SW_HIT` (placeholder). Visual: cure-sparkle on player portrait via `bsc.cureSparkleFrames` when target is self. Per-spell anim sprites still need PPU capture.
- **Status-cure spells** (Poisona, Bndna, etc.) — `spell.target === 'cure_status'` branch in `_applySpellEffect`. `SPELL_CURE_FLAG` map (`spell.type` → `STATUS.*`) drives `removeStatus(...)` on target. Heal-num is rendered as `value: 0` so the green-number bounce still shows the cast happened.
- **Pause-menu Magic uses inv-* state machine** via `pauseSt.menuMode = 'inv' | 'magic'`. Spell list with MP cost right-aligned. Picking a spell stashes ID in `pauseSt.useSpellId` and routes to `inv-target` for player/roster pick — Cure on roster heals that player's HP; Poisona removes their poison status. Returns to spell list after the heal anim. `menuMode` resets to `'inv'` on `inv-text-in` → `'open'`.

## Battle attack animation

- **Per-hit cycle.** Each hit goes through three states: `attack-back` (wind-up pose) → `attack-fwd` (transition, `FWD_SWING_MS`) → `player-slash` (impact, `getSlashHoldMs(weaponId)` from `slash-effects.js` — per-weapon: blade `3 × 30 ms = 90 ms`, impact `2 × 30 ms = 60 ms`). On a miss, `player-slash` short-circuits (gated by `shouldDrawSlash(hit)`) so there's no dead time when the slash overlay won't render. Same predicate gates `ally-slash` and `pvp-enemy-slash`.
- **Back-swing duration.** Hit 0 always uses `BACK_SWING_MS` (~167ms, full visible wind-up). Same-hand subsequent hits also use `BACK_SWING_MS` (every weapon hit gets the full wind-up). Hand change inserts `IDLE_FRAME_MS` (67ms) in idle pose. Fists skip the back-swing entirely (`delay = 0` when unarmed) — punches go straight to forward strike.
- **Idle pose only at hand boundary.** `_getPortraitSrc` `handChangeGap` flag fires when `attack-back && currentHitIdx > 0 && hand changed` — drops back to idle pose for the gap. Same-hand inter-hit gap stays in back-swing pose.
- **Slash logic lives in `slash-effects.js`** — single source of truth across player, ally, PVP, and drawing paths (consolidated in 1.7.4). Exports: `SLASH_FRAME_MS` (30 ms / frame), `getSlashPattern(weaponId)`, `setSlashOffsetForFrame(state, weaponId, frame)` (player), `shouldDrawSlash(hit)` (skip-on-miss predicate), `getSlashHoldMs(weaponId)` (total slash duration), `drawSlashOverlay(ctx, frame, ...)` (ally / PVP renderer), `resetSlashScatterCache()` (re-roll RNG between hits).
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

## Saves

- **`saveSlotsToDB()` is the single source of truth for the save schema.** Every persisted field is copied from `ps` / `playerInventory` / position getter inside that function. Callers must NOT also copy fields inline — that pattern was removed in the v1.6.74 audit. New callers just invoke `saveSlotsToDB()`.
- **Save triggers.** Every mutation that changes durable state must invoke `saveSlotsToDB()` before the player can lose it: shop buy/sell, chest pickup, pond heal, pause-menu item use / equip / auto-equip / job-switch enforce, battle victory (monster, boss, PVP), title screen actions, page `beforeunload`. Without an explicit trigger, state lives only in memory until one of the others fires.
- **MP is persisted.** Older saves reset MP to `maxMP` on every load; v1.6.74 added `mp` and `statusPoisonTick` to the save shape, so spent mana and active poison ticks now survive a session.
- **Server + IndexedDB dual-write.** Each save call writes the full slot array to local IndexedDB AND pushes per-changed-slot to the server via `window.ff3Auth.serverSave`. Server load is preferred on boot (only if at least one slot has data) with IndexedDB as fallback.

## Monster data

- **`src/data/monsters.js` is auto-generated from the ROM** via `tools/gen-monsters-js.js`. That script reads `$60010` (monster props), `$61010` (stat table, indexed via byte 9/12 of the props), `$61210` (attack scripts), gil/EXP/CP tables, and preserves `steal`/`drops`/`location` from the existing file. To regenerate: `node tools/gen-monsters-js.js > src/data/monsters.js`. Verify the result against `tools/rom-dump-monsters.txt` before committing.
- **`statusResist` order is high-bit-first** (death, petrify, toad, silence, mini, blind, poison, paralysis) — same decoding as `statusAtk`, driven by `statusVal` in the generator.
