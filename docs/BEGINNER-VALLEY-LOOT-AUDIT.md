# Beginner valley loot — audit

2026-08-26, against v1.10.92. Regenerate with `node tools/valley-loot-audit.mjs`.

Covers every loot source in the valley: Ur (town, interiors, well, hidden
spots), Kazus (town, interiors, hidden spots), the Mythril Mines, Castle Sasune
(courtyard, halls, throne, east tower), the Altar Cave and the Cave of Seals.

Two sides are compared throughout: **what the cartridge puts there**, and **what
ff3mmo rolls instead**.

---

## 1. The headline

**Between 50% and 100% of every loot table in the game is stuff the valley's own
shops already sell.**

| table | mimic | gil | items | of which shop stock |
|---|---|---|---|---|
| `ur_town` | 0% | 10-30 | 2 | **2 / 2** |
| `altar_f1` | 15.2% | 20-60 | 5 | **4 / 5** |
| `altar_f2` | 13.8% | 40-100 | 10 | **8 / 10** |
| `altar_f3` | 12.8% | 75-175 | 8 | **7 / 8** |
| `altar_f4` | 11.8% | 125-275 | 9 | **8 / 9** |
| `seals_f1` | 12.8% | 150-320 | 8 | **8 / 8** |
| `seals_f2` | 12.4% | 220-450 | 8 | **6 / 8** |
| `seals_f3` | 12.2% | 300-650 | 8 | 4 / 8 |

⛔ **Every single item on Cave of Seals floor 1 is sold in a valley shop.** It is
the first floor of the second dungeon, reached by crossing water you needed a
quest to cross, and it hands out Dagger, Leather, Copper, Long, Potion and the
two 100 G scrolls.

This is not a Sealed Cave problem. It is every table in the game.

---

## 2. FenixDown is in seven of the eight tables

`FenixDown` — **3000 G**, twenty times anything Ur sells, 2.4× the next most
valuable item in the valley — appears in `altar_f2`, `altar_f3`, `altar_f4`,
`seals_f1`, `seals_f2` and `seals_f3`. Its rate climbs with depth in both
dungeons (2% → 3% in the Altar Cave, 3% → 4% → 5% in the Seals).

⛔ **Dungeon chests deliberately skip the server's replay gate**, because the
dungeon regenerates on every entry (CLAUDE.md, chest loot). So this is farmable
by re-entering, in six of the eight tables, by design of the exemption rather
than by anyone's decision about FenixDown.

---

## 3. The mimic rate runs backwards

| | f1 | f2 | f3 | f4 |
|---|---|---|---|---|
| Altar Cave | **15.2%** | 13.8% | 12.8% | **11.8%** |
| Cave of Seals | 12.8% | 12.4% | 12.2% | — |

The opening dungeon is at its most hostile on **floor 1** and gets gentler the
deeper you go. Nothing in the design notes claims that was intended; it falls out
of the weights being tuned per floor without anyone looking at the column.

---

## 4. MagicKey is random loot in every Altar Cave table

`MagicKey` (0x98) is in `altar_f1` through `altar_f4` at 3% each. It is the key
to the locked rooms — a KEY ITEM handed out by a dice roll, in the same tier
slot as a Potion.

---

## 5. Per place — what is actually there

⛔ Tiles are counted only where the player can REACH them from that map's own
entrance. FF3 packs several interiors per tilemap: without the filter, Ur's magic
shop, weapon shop and tavern all report the secret room's chests as their own.

⭐ **Chests (`$7C`) and hidden spots (`$78-$7B`) are different content** and roll
different tables — a vase drops the mimic tiers. They are listed separately.

### Ur — 8 chests, 6 hidden spots, all on `ur_town`

| map | chests | hidden | note |
|---|---|---|---|
| 114 town | 0 | 2 | |
| 1 secret room (upstairs) | 5 | 0 | the treasure room |
| 2 secret house | 0 | 2 | |
| 8 inn | 0 | 1 | |
| 9 tavern | 0 | 1 | |
| 147 well | 3 | 0 | |

⛔ **All fourteen roll the same two-line table**: Potion / Antidote, and 10-30
gil. The secret room the player has to find a hidden passage to reach pays the
same as a pot in the tavern.

### Kazus — 0 chests, 2 hidden spots, **UNDESIGNED**

| map | chests | hidden |
|---|---|---|
| 12 pub/inn | 0 | 1 |
| 14 house | 0 | 1 |

Kazus town itself has **no treasure tiles at all**. Until v1.10.92 both spots
rolled the Altar Cave's floor-1 table.

### Mythril Mines (map 101) — **nothing**

⛔ **Zero treasure tiles.** The mine the whole Kazus story turns on — where the
Mythril Ring was cut, script `0x231` — contains no loot of any kind, from either
side. It is not that the table is wrong; there is nothing to roll for.

### Castle Sasune — 11 chests, 0 hidden spots, **UNDESIGNED**

| map | chests | note |
|---|---|---|
| 21 | 1 | |
| 23 | 2 | |
| **24** | **3** | ⛔ in `STRANDING_MAPS` — the engine REFUSES entry at the door |
| 27 | 2 | |
| 30 | 3 | |

⛔ **Eleven chests in the castle and not one designed table.** Until v1.10.92
every one rolled the Altar Cave's floor-1 loot, mimic tier included — a chest in
the king's castle could turn into a goblin.

⛔ **Three of the eleven are unreachable.** Map 24 is refused at the door
(`map-triggers.js#STRANDING_MAPS`) because its ROM entrance drops the player in a
pocket with no exit. Its chests are content nobody can ever open.

### Altar Cave — 12 chests

| ROM map | floor | chests | table |
|---|---|---|---|
| 111 | f1 | **0** | `altar_f1` |
| 115 | f2 | 3 | `altar_f2` |
| 112 | f3 | 2 | `altar_f3` |
| 113 | f4 | 5 | `altar_f4` |
| 22 | boss | 2 | ⚠ **UNDESIGNED** |

### Cave of Seals — 5 chests

| ROM map | floor | chests | table |
|---|---|---|---|
| 103 | f1 | 2 | `seals_f1` |
| 104 | f2 | 1 | `seals_f2` |
| 105 | f2b | **0** | `seals_f2` |
| 106 | B3F/boss | 2 | ⚠ **UNDESIGNED** |

⛔ **Both boss chambers hold chests and neither has a table.** Map 22 and map 106
each carry two, and both fall through.

---

## 6. Totals

```
44 treasure tiles reachable in the valley
   36 chests   8 hidden spots
   19 on a designed table   12 on ur_town   13 UNDESIGNED (was: the Altar Cave's f1 table)
    3 unreachable (map 24, refused at the door)
```

---

## 7. What the cartridge puts there — NOT YET USABLE

The ROM's own chest contents are decoded but **not attributable to maps**, and
this audit does not quote them.

- ⭐ **Contents table confirmed** — file `0x3C10`, one byte per chest = item id.
  `rom[0x3C10..0x3C14]` = `24 73 fc 1f 73`, matching `tools/rom-dump-chests.txt`
  line for line.
- ⭐ **The map property record is 16 bytes and ff3mmo reads ELEVEN.** Bytes 2,
  12, 13, 14 and 15 are dropped. Byte 2 is the map-name index; byte 13 is a
  constant `$84`.
- ⛔ **Byte 12 is NOT confirmed as the chest base.** It climbs monotonically and
  reads `$00` on maps with no treasure tile, which is what a base would do.
  Scored over all 256 maps:

  | rule | indices | collisions | gaps |
  |---|---|---|---|
  | `base + tilemap-wide trigId` | 106 | **49** | 75 |
  | `base + this map's own order` | 100 | **48** | 81 |

  Neither partitions the table. Two maps claiming the same chest is not a decode.

**To settle it:** open a known chest in a running game and read what lands in the
inventory, then work backwards. Until then the audit tool prints the ROM column
as `cand#`.

---

## 8. Findings, ranked

1. ⛔ **Every table is mostly shop stock** — 50-100%, and 8/8 on Seals floor 1.
2. ⛔ **FenixDown (3000 G) is in six farmable dungeon tables.**
3. ⛔ **Castle Sasune's eleven chests have no designed table**, and three of them
   are behind a door the engine refuses.
4. ⛔ **Both boss chambers have chests and no table.**
5. ⛔ **The Mythril Mines has no loot at all.**
6. ⚠ **The Altar Cave's mimic rate falls with depth.**
7. ⚠ **MagicKey is a 3% random drop** on every Altar Cave floor.
8. ⚠ **Ur's secret room pays the same as a tavern pot** — 14 tiles, one table.
9. ⚠ **Map 105 and map 111 have zero chests**, so `seals_f2` and `altar_f1` cover
   fewer tiles than their names suggest.

---

## 9. Not decided here

This is the audit. It deliberately proposes **no numbers** — the previous attempt
at that (`docs/SEALED-CAVE-LOOT-PLAN.md` §4) put gear from a 1200-2400 G shop
tier into a valley that caps at 500 G, and filled a table with shop stock under a
heading that said not to. That section should be read as void; §1 of that file
(the diagnosis) still stands.

The content pass should wait on §7 — what the cartridge itself puts in these 44
tiles is the one source of truth nobody has read yet.
