# Beginner valley loot — audit

2026-08-26, against v1.10.94. Regenerate with `node tools/valley-loot-audit.mjs`.

> ⚠ **READ §1 AND §5 FIRST.** Two of this document's original findings were
> WRONG and were acted on before anyone checked them — one measured the game
> against an invented rule, the other read a constant in source and called it
> behaviour. Both are struck in place rather than deleted, because the mistake is
> more useful than the missing text. Everything in §8 survived verification.

Covers every loot source in the valley: Ur (town, interiors, well, hidden
spots), Kazus (town, interiors, hidden spots), the Mythril Mines, Castle Sasune
(courtyard, halls, throne, east tower), the Altar Cave and the Cave of Seals.

Two sides are compared throughout: **what the cartridge puts there**, and **what
ff3mmo rolls instead**.

---

## 1. The headline

⛔ **THIS SECTION IS RETRACTED.** It measured the tables against a rule nobody
gave: *"a chest never offers what a valley shop stocks."* That rule was invented
mid-session, written into `SEALED-CAVE-LOOT-PLAN.md` as Principle 1, and then
used to rank a finding here.

**The cartridge disproves it.** FF3's own Ur chests hold Long sword, Leather,
Dagger and Staff — every one sold in Ur's shops; the Sealed Cave's own map 103
chests hold Long sword and Nunchuck, both sold in Ur. Chests at shop tier are
what FF3 does, and it is what ff3mmo does by Joel's decision (v1.10.94).

The table below is kept as a record of what the tables contain, not as a fault.

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

### ⛔ THE DUNGEONS ARE GENERATED — the ROM's chests there are IRRELEVANT

**Corrected 2026-08-26.** The first cut of this audit read the chest tiles out of
ROM maps 22, 103, 104, 106, 111, 112, 113 and 115 and reported them as the
dungeons' loot. They are not. Those are **donor maps** — the dungeon registry
uses them for tiles, CHR and palettes only (`donorMap`, `romFloorMaps`), and
`dungeon-generator.js` builds the layout and scatters the chests itself. A player
never walks the cartridge's version of those rooms.

What ff3mmo actually places, from `FLOOR_CONFIG` (`dungeon-generator.js:754`),
indexed by floor and shared by both dungeons:

| floor | chests |
|---|---|
| 0 | 2-4 |
| 1 | 4-6 |
| 2 | **0** |
| 3 | **0** |
| boss | **0** — the whole feature block is inside `if (!isBossFloor(...))` |

⭐ **Boss chambers place no chests.** Neither does any floor past the second.
⭐ **Generated dungeons place no hidden-treasure vases either** — there is no
`$78-$7B` anywhere in the generator.

### ⛔ RETRACTED — "three of the eight tables can never fire"

**This section claimed `seals_f3`, `altar_f3` and `altar_f4` were unreachable.
It was WRONG and it was acted on.** The claim came from reading
`FLOOR_CONFIG[floorIndex].chests` in `dungeon-generator.js` and seeing `0` on
floors 2 and 3. That constant is one of several placement paths — the floor-2 and
floor-3 layouts push `extraRooms`, and the scatter gives each a 50% corner chest.

Generating the floors, five seeds each:

```
altar  f0=3.2  f1=6.0  f2=3.6  f3=3.4   chests
seals  f0=3.2  f1=6.0  f2=3.6
```

**Every floor of both dungeons places chests. Every table fires.** The Cave of
Seals is a working clone of the Altar Cave — same layout, same rock puzzle on
floor 2, same chest counts.

⛔ The lesson, which this session relearned four times: **a constant in source is
not behaviour.** Generate the thing and count it.

---

## 6. Totals

**Towns and castles** read their tilemaps straight from the ROM, so these counts
are what a player walks up to:

```
Ur              8 chests   6 hidden spots   -> ur_town (one table for all 14)
Kazus           0 chests   2 hidden spots   -> UNDESIGNED
Mythril Mines   0 chests   0 hidden spots   -> nothing at all
Castle Sasune  11 chests   0 hidden spots   -> UNDESIGNED  (3 behind a refused door)
```

**Dungeons** are generated, so the count is per run, not per map. MEASURED by
generating five seeds per floor and counting `$7C` tiles:

```
Altar Cave    f0=3.2   f1=6.0   f2=3.6   f3=3.4      boss: 0
              + locked rooms 1010 / 1011, secret rooms 1020 / 1021
Cave of Seals f0=3.2   f1=6.0   f2=3.6               boss: 0
              + no locked or secret rooms (registry says deliberate)
```

⭐ **The Cave of Seals is a faithful clone of the Altar Cave** — same generator,
same layout branches, same rock puzzle on floor 2, same chest counts. Its only
structural difference is one fewer walkable floor and no side rooms.

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
- ⭐ **Byte 12 IS the chest base.** An earlier pass called it unconfirmed on the
  strength of 49 "collisions" across 256 maps. Those were mis-measured: **19 of
  the 21 shared bases belong to maps with BYTE-IDENTICAL TILEMAPS** — FF3 packs
  several interiors per tilemap, so two maps legitimately sharing a base is the
  format working, not the decode failing. Only 2 are genuinely odd (maps 72/74
  and 158/175).
- ⚠ **The per-tile index rule is still approximate.** Bracketing a chest to "the
  map with the largest base ≤ its index" answers WHICH REGION reliably — that is
  how Carapace was traced — but adjacent maps' ranges can overlap, so it does not
  reliably answer WHICH CHEST. Carapace #89 is claimed by both map 24 (base $57,
  +2) and map 161 (base $59, +0).

**To settle the per-tile rule:** open a known chest in a running game and read
what lands in the inventory, then work backwards.

---

## 8. Findings — what survived verification

⛔ Findings 1, 2 and 3 of the original list are RETRACTED (§1, §5). What is left
was measured and holds:

1. ⛔ **Carapace, WSlayer and FenixDown were not from the valley.** Read out of
   the ROM chest table and bracketed to their maps: Carapace to map 161/24 (both
   unreachable), WSlayer to maps 140/170, FenixDown to ten maps and not one in
   the valley. All three removed in v1.10.93; WSlayer is now the Djinn's drop.
2. ⛔ **Castle Sasune's eleven chests had no table.** Fixed v1.10.94 — they roll
   `kazus_tier`. Three of the eleven are still behind map 24, which the engine
   refuses at the door.
3. ⛔ **The Mythril Mines has no loot at all.** Zero treasure tiles, both sides.
4. ⚠ **Ur's fourteen tiles share one two-line table** — the secret room pays what
   a tavern pot pays.
5. ⚠ **The Altar Cave's mimic rate falls with depth** (15.2% → 12.1%).
6. ⚠ **MagicKey is a 3% random drop** on every Altar Cave floor — a key item on a
   dice roll.
7. ⚠ **Map 105 and map 111 hold no ROM chests**, so those donor maps contribute
   nothing (irrelevant to play, since the dungeons are generated).

---

## 9. The gate

`tools/check-loot-tables.mjs` — green. Its dead-table check was removed: it was
based on the retracted claim in §5 and shipped red for two versions.

⚠ It is still not in `deploy.sh`. Wire it in once someone has read it end to end;
this file has a poor record.

## 10. Not decided here

This is the audit. It deliberately proposes **no numbers** — the previous attempt
at that (`docs/SEALED-CAVE-LOOT-PLAN.md` §4) put gear from a 1200-2400 G shop
tier into a valley that caps at 500 G, and filled a table with shop stock under a
heading that said not to. That section should be read as void; §1 of that file
(the diagnosis) still stands.

The content pass should wait on §7 — what the cartridge itself puts in these 44
tiles is the one source of truth nobody has read yet.
