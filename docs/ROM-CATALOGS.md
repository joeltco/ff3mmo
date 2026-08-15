# ROM catalogs — what has been pulled out of FF1, FF2 and FF3

Every table below was found by watching the running game, not by searching the
ROM for plausible-looking data. Each one is pinned by a gate that fails when a
constant is reverted, and most are additionally checked against what the game
draws on screen.

## The catalogs

| game | shops | items | monsters | script | sprites |
|---|---|---|---|---|---|
| FF1 | [FF1-SHOPS.md](FF1-SHOPS.md) | [FF1-ITEMS.md](FF1-ITEMS.md) | [FF1-MONSTERS.md](FF1-MONSTERS.md) | [FF1-SCRIPT.md](FF1-SCRIPT.md) | [NPC-CATALOG.md](NPC-CATALOG.md) |
| FF2 | [FF2-SHOPS.md](FF2-SHOPS.md) | [FF2-ITEMS.md](FF2-ITEMS.md) | [FF2-MONSTERS.md](FF2-MONSTERS.md) | [FF2-SCRIPT.md](FF2-SCRIPT.md) | [NPC-CATALOG.md](NPC-CATALOG.md) |
| FF3 | [FF3-SHOPS.md](FF3-SHOPS.md) | [FF3-ITEMS.md](FF3-ITEMS.md) | `src/data/monsters.js` | [FF3-SCRIPT.md](FF3-SCRIPT.md) | [NPC-CATALOG.md](NPC-CATALOG.md) |

Sound is cataloged separately in [SOUND-CATALOG.md](SOUND-CATALOG.md).

## How each was reached

| game | a shop is… | reached by |
|---|---|---|
| FF1 | a tile property (`prop1` → `$51`) | walking onto it; the party had to be put in a town by **patching the castle entrance's destination**, because the start pocket has no walkable route out |
| FF2 | an OBJECT TYPE (192-219) | standing each of the 256 types next to the party in RAM at `$7500` and talking to it |
| FF3 | a shopkeeper NPC | patching one shopkeeper's id in ROM and warping in — FF3 reloads its NPC table on every map load, FF2 does not |

## Verification, stated plainly

| table | how far it is proven |
|---|---|
| FF1 shops | every constant pinned to its instruction; 4 shops opened live; 13 gate reverts |
| FF1 items | **500/500** names and prices drawn by the game, by patching a shop record to stock every id |
| FF1 monsters | table ADDRESS pinned to `$FC83`; only index 0 (`IMP`) confirmed on screen |
| FF2 shops | pinned; all 28 opened live, names and prices; 12 gate reverts |
| FF2 items | **255/255** names drawn by the game |
| FF2 monsters | NOT instruction-pinned; 4 confirmations from the guard types that summon them |
| FF3 shops | pinned; all 21 opened live; 12 gate reverts |
| FF3 items | **504/504** names and prices drawn by the game; 8 ids shown to be non-items |
| scripts | decoders pinned by `check-ff12-text` / `check-npc-dialogue` against text read off the running game |

## What is still open

- **FF1's encounter formation table.** Without it a chosen monster cannot be made
  to appear, so 127 of the 128 monster names stay decoded-but-unwitnessed. The
  slots themselves are decoded (`$FBD4 LDA $6BC9,X`, `$FF` = empty); holding a
  poked value there does not make an encounter draw.
- **FF2's sub-`0x8A` dictionary.** About a fifth of every JP line is still `{xx}`.
- **Monster STATS** for FF1 and FF2 — only names are decoded. FF3's are already
  generated into `src/data/monsters.js`.
- **Treasure / chest tables** for all three.
