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

## Known broken data (as of 1.6.11)

- **Monster ATK and attackRoll values in `src/data/monsters.js` are WRONG.** They diverge from `tools/rom-dump-monsters.txt` (the correct ROM extract). Commit `3a54feb` on 2026-04-10, titled "Fix all 231 monster ATK and attackRoll values from ROM stat tables", decoded the NES stat-set index bitmask incorrectly and inflated most values. Examples: Goblin ATK ROM=5/ours=10, Werewolf ROM=9/ours=15, Berserker ROM=10/ours=20. `tools/rom-dump-monsters.txt` is authoritative — regenerate `monsters.js` from it or a corrected `tools/gen-monsters-js.js`. Do NOT trust the current values until this is resolved.
