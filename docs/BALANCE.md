# Zone balance — measured

`node tools/zone-balance.mjs --zones=<a,b,c> [--parties=…] [--detail]`

Drives `tools/battle-sim.js` — the shipped combat math, monster specials
included — over every formation a zone can roll. Formations are spawned the way
`startRandomEncounter` spawns them (per-group count roll, **hard stop at four
bodies**) and weighted by the ROM's slot odds, so a 1-in-64 nightmare does not
drag a zone's headline number down as if it were a coin flip.

Numbers below: **win rate per encounter, 60 runs each**, measured at v1.10.57
against the ROM-derived tables shipped in v1.10.56.

## ⛔ Read these two caveats first

**The party only ever attacks.** No potions, no Cure, no Protect, no Defend.
Every number here is a FLOOR, and the Djinn row shows how far off that floor can
be — one correct spell moves it from 0% to 85%.

**Jobs are restricted to what the player can actually have.** Onion Knight alone
before the Wind Crystal; Fighter / Monk / White Mage / Black Mage / Red Mage
after (`WIND_CRYSTAL_JOBS` = `0x3E`). ⛔ The first run of this sweep used
**Knight** — job 7, unlocked nowhere near these dungeons — and every number came
out far too kind. Cave of Seals floor 1 read 4% for a level-5 solo; the honest
answer is **0%**.

## Altar Cave — a clean curve

| party | f1 | f2 | f3 | f4 | Land Turtle |
|---|---|---|---|---|---|
| OK1 | 98% | 89% | 44% | 20% | 0% |
| OK2 | 100% | 94% | 66% | 37% | — |
| OK3 | 100% | 100% | 97% | 88% | 0% |
| OK5 | 100% | 100% | 100% | 100% | 53% |
| OK8 | — | — | — | — | 100% |
| OK5 + OK4 | 100% | 100% | 100% | 100% | 100% |

⭐ This is what a first dungeon should look like: survivable on arrival at level
1, punishing by floor 3, comfortable by level 5. The difficulty is in the floor
you are on, not in a wall.

⭐ **The Land Turtle DOES gate** — OK1 and OK3 lose 40/40, OK5 is a coin flip at
53%, OK8 is certain. So a player leaves Altar Cave at roughly **level 5-8**, and
that is the level the next dungeon should be built against.

## Cave of Seals — the step is real

| party | seals_f1 | seals_f2 / f3 | Djinn |
|---|---|---|---|
| FI5 | **0%** | **0%** | — |
| FI5 + WM4 | 12% | 9% | — |
| FI8 + WM6 | 72% | 65% | 0% |
| FI8 + WM6 + BM6 | 93% | 91% | 0% |
| FI12 + WM10 + BM10 | 100% | 100% | 100% |

⭐ A player leaving Altar Cave at the level the Land Turtle demands (5-8) walks
into 0-72%. That is a real step but not an unfair one — **as long as they bring
an ally**. Solo at level 5 it is a wall.

⭐⭐ **The Djinn is a MAGIC check, not a level check.** Fire-resistant, ice-weak,
casts Fire at an 85% rate. All-attack, FI8+WM6+BM6 loses 40/40 — the same party
with the Black Mage casting **Bzzard wins 85%**, and at level 9 with ice it is
100%. A level table alone hides this completely; the boss is well designed and
should not be nerfed on the strength of the all-attack row.

⛔ **Not reachable in normal play.** The mouth at (84,36) is an isolated
**8-tile** pocket with no path to Ur's 267-tile region — debug-only.
`check-encounter-zones.mjs` tripwires if that ever changes.

## The Floating Continent (world 0) — 69% of the reachable map is tier-2

Reachable on foot from Ur: **267 tiles**, split across only five zones.

| zone | share of reachable | OK1 | OK3 | OK5 | OK8 | FI8+WM6 |
|---|---|---|---|---|---|---|
| `grasslands_valley` (safe radius) | 83 tiles, 31% | 100% | 100% | 100% | 100% | 100% |
| `world_r6` | 127 tiles, 48% | 10% | 25% | 50% | 87% | 100% |
| `world_r7` | 36 tiles, 13% | 10% | 25% | 50% | 87% | 100% |
| `world_r11` | 18 tiles, 7% | 5% | 15% | 33% | 75% | 100% |
| `world_r10` | 3 tiles, 1% | 5% | 15% | 33% | 75% | 100% |

⛔ **The safe radius is a cliff, not a ramp.** 100% inside, 10% one tile
outside — and 69% of everything a starting character can walk to is that
outside. The 8-tile radius (v1.7.945) covers the Ur ↔ Altar Cave corridor and
nothing else, which was its stated purpose; this is what the rest looks like.

⛔ The killer is **Berserker x4** and **Werewolf x3**, both 0% below level 5.
Berserker is the 12/64 slot of `world_r6`/`r7`.

## ⚠ Ur's own encounter patch

`grasslands_wild` — the dark-tile patch inside Ur town (map 114, flood-filled
from (22,8), **43 tiles**, bounding box x 2-24, y 3-8):

| party | win rate |
|---|---|
| OK1 | 12% |
| OK3 | 31% |
| OK5 | 62% |
| OK8 | 100% |

⛔ **At 18/256 it is the hottest zone in the game — a fight every ~14 steps**,
against three and a half times the open-grass rate. That is the cartridge's own
number for map 114, not ours; but the cartridge did not put a level-1 character's
starting town on it. A new player who walks north in Ur meets Werewolves at 12%.
