# Loot System Audit — 2026-04-09

## Bug

### 1. EXP display shows 4x actual gain — FIXED
- `encounterExpGained` = raw sum of monster EXP (e.g., 64 for 4 goblins)
- Victory screen displayed this raw number: "64 EXP!"
- But `grantExp()` divides by 4 internally — player actually got 16
- Gil and CP were already divided before display — EXP was the only inconsistent one

### 2. Monster AGI missing — monsters always go last
- Zero monsters in `data/monsters.js` define an `agi` field
- `battle-encounter.js` doesn't copy `agi` to spawned encounters
- Turn order: `mAgi || 0` → all monsters get priority `0*2 + random(256)`
- Player gets `agi*2 + random(256)` — almost guaranteed to act first
- Needs ROM extraction or manual values to fix

## Design Notes

### 3. Max 1 item drop per battle
First monster to pass a 25% check wins, loop breaks. Multi-monster fights can't drop 2+ items.

### 4. Drop check order = tallest sprite first
Encounters sorted by sprite height. Taller monsters get first dibs on the drop roll.

### 5. Null in drops arrays is intentional
e.g., Sahagin `drops: [null,null,null,null]` = "never drops." Code handles correctly.

### 6. Chest loot flat across all dungeon floors
Same 4 tiers (60/28/10/2 weights) on every floor. Deeper floors don't improve loot.

### 7. `steal` field on monsters unused
No steal command exists in battle.

### 8. Boss/PVP victories have no item drops
Only EXP/Gil/CP rewards.
