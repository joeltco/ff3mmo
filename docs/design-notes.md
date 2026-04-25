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

## Monster data

- **`src/data/monsters.js` is auto-generated from the ROM** via `tools/gen-monsters-js.js`. That script reads `$60010` (monster props), `$61010` (stat table, indexed via byte 9/12 of the props), `$61210` (attack scripts), gil/EXP/CP tables, and preserves `steal`/`drops`/`location` from the existing file. To regenerate: `node tools/gen-monsters-js.js > src/data/monsters.js`. Verify the result against `tools/rom-dump-monsters.txt` before committing.
- **`statusResist` order is high-bit-first** (death, petrify, toad, silence, mini, blind, poison, paralysis) — same decoding as `statusAtk`, driven by `statusVal` in the generator.
