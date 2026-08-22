# Zone balance

Two instruments, and they do not agree. Read this section before either table.

**`tools/ff3-fight-real.mjs` — the cartridge.** Patches all eight slots of the
live map's encounter group to the formation under test (the weighted roll still
runs, it just cannot matter), then lets **FF3 itself** fight the battle and reads
the corpses out of the combatant array. Species and counts stay the ROM's. This
is a measurement.

**`tools/zone-balance.mjs` — our model.** Drives `battle-sim.js`, this repo's
re-implementation of FF3's combat math. It can sweep party levels and jobs, which
the cartridge harness cannot. It is a model, and the error is quantified below.

⛔ **When they disagree, the cartridge wins.**

## What the cartridge says

Party: **FF3's own starting party — four level-1 Onion Knights, 32 HP each**, the
one in `tools/states/ff3-freeroam.state.gz`. This is the only party the harness
can speak for; it is not a ladder. 6 battles per formation.

| zone | 🎮 cartridge | 📐 our sim | sim error |
|---|---|---|---|
| `altar_cave_f1` | **100%** | 100% | — |
| `altar_cave_f2` | **100%** | 100% | — |
| `altar_cave_f3` | **98%** | 100% | +2 |
| `altar_cave_f4` | **79%** | 100% | **+21** |
| `seals_cave_f1` | **0%** | 17% | +17 |
| `seals_cave_f2` | **0%** | 6% | +6 |
| `seals_cave_f3` | **0%** | 6% | +6 |
| `grasslands_wild` (Ur patch) | **81%** | 100% | +19 |
| `world_r6` | **66%** | 84% | +18 |
| `world_r11` | **42%** | 65% | **+23** |

⭐ **The sim is optimistic everywhere and pessimistic nowhere**, by up to 23
points. It is accurate only where the fight is already won. Every number it
produces about a hard fight is an upper bound.

### Per formation, on the cartridge

| formation | zone slots | result |
|---|---|---|
| Goblin x4 | altar f1, 63/64 | 6/6 |
| Eye Fang + Carbuncle x3 | altar f1-f2 | 6/6 |
| Blue Wisp + Carbuncle x4 | altar f2-f4 | 6/6 |
| Eye Fang + Blue Wisp + Carbuncle x4 | altar f3-f4, 54/64 | **6/8** |
| Killer Bee x3 | world, Ur patch | 6/6 |
| Werewolf x2 | world, Ur patch | **3/6** |
| Berserker x4 | `world_r6` 12/64, `r11` 15/64 | **0/6** |
| Berserker + Werewolf x4 | `world_r11` 13/64 | **0/6** |
| Mummy x3 | seals f1, 48/64 | **0/6** |
| Skeleton x4 | seals f1-f3 | **0/6** |
| Shadow x2 | seals f1-f3 | **0/6** |
| Skeleton + Mummy x4 | seals f2-f3 | **0/6** |
| Larva + CursdCopper x4 | seals f1-f3 | **0/6** |

⭐ **Altar Cave is a real curve on the cartridge** — 100% on floor 1, 79% on
floor 4, driven entirely by one formation (Eye Fang + Blue Wisp + Carbuncle,
54/64 of floor 4) that the starting party wins 6 times in 8. Our sim called that
formation 100% and missed the whole curve.

⛔ **The Cave of Seals is 0% on every formation — 0 wins in 30 decided battles**,
all total wipes (`0/0/0/0`). Not "hard": impossible for the starting party.

⛔ **Berserker x4 is an unwinnable fight in reachable overworld grass**, and it
is the 12/64 slot of `world_r6` (48% of everything a starter can walk to) and the
15/64 slot of `world_r11`. `world_r11` also carries Berserker + Werewolf at
13/64, which is why it lands at 42%.

## What the model says about LEVELS — upper bounds only

⛔ Everything below is `battle-sim.js`, carrying the up-to-23-point optimism
measured above, and the party only ever attacks — no potions, no Cure, no
Protect. Treat every figure as a ceiling.

⛔ Jobs are restricted to what the player can hold: Onion Knight alone before the
Wind Crystal, Fighter / Monk / WM / BM / RM after (`WIND_CRYSTAL_JOBS` = `0x3E`).
An earlier pass used **Knight** — job 7, unlocked nowhere near this content — and
produced conclusions that were simply false.

### Altar Cave (Onion Knight, solo)

| party | f1 | f2 | f3 | f4 | Land Turtle |
|---|---|---|---|---|---|
| OK1 | 98% | 89% | 44% | 20% | 0% |
| OK3 | 100% | 100% | 97% | 88% | 0% |
| OK5 | 100% | 100% | 100% | 100% | 53% |
| OK8 | — | — | — | — | 100% |

The Land Turtle gates: OK1 and OK3 lose 40/40, OK5 is a coin flip. A player
leaves Altar Cave at roughly **level 5-8**.

### Cave of Seals (post-crystal jobs)

| party | seals_f1 | seals_f2 / f3 | Djinn |
|---|---|---|---|
| FI5 | 0% | 0% | — |
| FI5 + WM4 | 12% | 9% | — |
| FI8 + WM6 | 72% | 65% | 0% |
| FI8 + WM6 + BM6 | 93% | 91% | 0% |
| FI12 + WM10 + BM10 | 100% | 100% | 100% |

⭐⭐ **The Djinn is a MAGIC check, not a level check.** Fire-resistant, ice-weak,
casts Fire at 85%. FI8+WM6+BM6 all-attack loses 40/40; the same party with the
Black Mage casting **Bzzard wins 85%**. ⛔ Do not nerf it on the all-attack row.

## The overworld — 69% of what a starter can reach is tier-2

Reachable on foot from Ur: **267 tiles**, five zones.

| zone | share of reachable | 🎮 cartridge (4x OK1) |
|---|---|---|
| `grasslands_valley` (safe radius) | 83 tiles, 31% | Goblins only — 100% |
| `world_r6` | 127 tiles, 48% | **66%** |
| `world_r7` | 36 tiles, 13% | same group as r6 |
| `world_r11` | 18 tiles, 7% | **42%** |
| `world_r10` | 3 tiles, 1% | same group as r11 |

⛔ The safe radius is a cliff, not a ramp: Goblins inside, Berserker x4 one tile
out. `grasslands_valley` is the one zone in the game that is ours and not the
cartridge's — see `src/data/encounters.js`.

## Ur's own encounter patch

`grasslands_wild` — 43 tiles inside the starting town (map 114, flood-filled from
(22,8), bounding box x 2-24, y 3-8), at the cartridge's own **18/256**: a fight
every ~14 steps, three and a half times open grass. The starting party wins
**81%** of them, losing half its fights against Werewolf x2.

## Reproducing

    node tools/ff3-fight-real.mjs --zone=seals_cave_f1 --battles=6 --trace
    node tools/ff3-fight-real.mjs --formation=0x03 --battles=8 --rounds=400
    node tools/zone-balance.mjs --seals --detail
    node tools/check-real-battles.mjs        # the harness gate

⛔ **A real level ladder is NOT possible yet.** The party record is at
`0x6100 + slot*0x40` with cur/max HP measured at `+0x0C`/`+0x0E`, but which bytes
carry LEVEL and the primary stats has not been proven, and FF3's level-up growth
table has not been decoded from ROM. Poking unnamed bytes to fake a level-8 party
would produce exactly the kind of number this document exists to stop.
