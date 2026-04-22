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
