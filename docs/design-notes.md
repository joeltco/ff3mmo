# Design Notes

Intentional design decisions that aren't obvious from reading the code. One section per subsystem.

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

- **Victory pose is also Defend and Magic-cast.** Canonical FF3 uses the same 4-tile arms-up stance for all three. In `src/battle-drawing.js:203`, defend and item-use portraits both route through `p.defend` — which is built from victory tiles for every job. When magic-cast is added, route `isMagicPose` through the same branch.
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
- **Combo alternation**: R → idle → L → idle → R → L → … per hit. When both hand slots are empty (fists), treat as dual-wield for pose alternation purposes, not just for one-hand-only.
- **Hit-flash sprite is already correct.** `initSlashSprites()` in `src/slash-effects.js` uses tile bytes byte-identical to the OAM `$4A–$4D` with the same `[0x0F, 0x16, 0x27, 0x30]` palette — the two-fist impact is already what we draw for non-bladed hits.

## Shops

- **Counters, not NPCs.** Shops in Ur are interior maps (3 = magic, 4 = armor, 5 = weapon, 8 = item). Pressing Z facing a registered counter tile opens the shop. Counter coords + `mapId` are stored on each entry in `src/data/shops.js`; lookup via `findShopAtCounter(mapId, x, y)` in `movement.js#handleAction`.
- **Catalog item IDs only — prices come from `data/items.js`.** That file is auto-generated from the FF3 NES ROM at `$21E10`, so prices are canonical. Sell price = `floor(buy / 2)`.
- **Magic shop is a no-op.** `openShop` returns false when the catalog has `spells:` instead of `items:` — magic-buy flow needs `spells.js` integration. The counter is detected; nothing happens on Z. Defer until ready.
- **Two-phase NES transition.** Outer fade uses `buildNesFadeFrames` (`src/nes-fade.js`) — snapshots the inner viewport, NES-quantizes each pixel, applies `nesColorFade` N times to produce stepped fade frames. Phase 1 (`map-out`) plays them forward over 320ms; phase 2 (`shop-in`) fills inner area black + text-palette fades in over 500ms. Reverse on close. **Snapshot the INNER area only** (`INNER_X = 8, INNER_Y = 40, INNER_W = 128, INNER_H = 128`) so the static HUD canvas's viewport border doesn't fade with it.
- **HUD portrait flickers victory pose for equippable gear.** `_drawHUDPortrait` checks `shopHoverEquippable()` — if true and `bp.victory` exists, alternates victory ↔ idle every 250ms (same cadence as battle ally victory). Falls back to normal kneel/defend/idle.
- **ATK/DEF delta triangle.** `shopHoverStatDelta()` returns `null` for "no indicator", a number otherwise. Green ▲ for upgrade, red ▼ for downgrade, white = for same. Drawn in the 8×8 left-padding of the HUD info panel via per-row `ctx.fillRect` (NES `$2A` / `$16` / `$30`). Weapon comparison uses `Math.max(weaponR, weaponL)` with a same-ID short-circuit (so a duplicate of what's wielded reads as `=`); shields use `Math.max` of any equipped shield slot.
- **Music: FF1 NSF track 14.** Shop opens with `pauseMusic() + playFF1Track(FF1_TRACKS.SHOP)`; closes with `stopFF1Music() + resumeMusic()`. Mirrors the pause-menu pattern with `MENU_SCREEN`.
- **Confirm dialog uses blue text palette.** Box is `drawBorderedBox(.., true)` (NES `$02` blue). Text uses `[0x02, 0x02, 0x02, 0x30]` so the font shadow (color index 1/2) blends into the blue bg — same trick `message-box.js` uses. Mobile shows `A=Yes  B=No`, desktop shows `Z=Yes  X=No` via `isMobile` from `ui-state.js`.

## Saves

- **`saveSlotsToDB()` is the single source of truth for the save schema.** Every persisted field is copied from `ps` / `playerInventory` / position getter inside that function. Callers must NOT also copy fields inline — that pattern was removed in the v1.6.74 audit. New callers just invoke `saveSlotsToDB()`.
- **Save triggers.** Every mutation that changes durable state must invoke `saveSlotsToDB()` before the player can lose it: shop buy/sell, chest pickup, pond heal, pause-menu item use / equip / auto-equip / job-switch enforce, battle victory (monster, boss, PVP), title screen actions, page `beforeunload`. Without an explicit trigger, state lives only in memory until one of the others fires.
- **MP is persisted.** Older saves reset MP to `maxMP` on every load; v1.6.74 added `mp` and `statusPoisonTick` to the save shape, so spent mana and active poison ticks now survive a session.
- **Server + IndexedDB dual-write.** Each save call writes the full slot array to local IndexedDB AND pushes per-changed-slot to the server via `window.ff3Auth.serverSave`. Server load is preferred on boot (only if at least one slot has data) with IndexedDB as fallback.

## Monster data

- **`src/data/monsters.js` is auto-generated from the ROM** via `tools/gen-monsters-js.js`. That script reads `$60010` (monster props), `$61010` (stat table, indexed via byte 9/12 of the props), `$61210` (attack scripts), gil/EXP/CP tables, and preserves `steal`/`drops`/`location` from the existing file. To regenerate: `node tools/gen-monsters-js.js > src/data/monsters.js`. Verify the result against `tools/rom-dump-monsters.txt` before committing.
- **`statusResist` order is high-bit-first** (death, petrify, toad, silence, mini, blind, poison, paralysis) — same decoding as `statusAtk`, driven by `statusVal` in the generator.
