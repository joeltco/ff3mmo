# Design Notes

Intentional design decisions that aren't obvious from reading the code. One section per subsystem.

## Loot / drops

- **Max 1 item drop per battle.** First monster to pass the 25% drop check wins; loop breaks. Multi-monster fights can't drop 2+ items.
- **Drop check order is tallest-sprite-first.** Encounters are sorted by sprite height, so taller monsters get first dibs on the drop roll.
- **`null` in `drops` arrays is intentional.** e.g., Sahagin `drops: [null,null,null,null]` = "never drops". Code handles it correctly.
- **Chest loot is flat across all dungeon floors.** Same 4 tiers (60/28/10/2 weights) on every floor. Deeper floors don't improve loot.
- **`steal` field on monsters is unused.** No steal command exists in battle.
- **Boss and PVP victories have no item drops.** Only EXP/Gil/CP rewards.
