# Cave of Seals — plan

Status: **SHIPPED in v1.10.55; encounters made ROM-true in v1.10.56.** The Cave
of Seals is a registered, reachable dungeon — maps 2000-2003, entered from world
(84,36). §6 was the one open question, FF3's per-map encounter table; it is now
decoded, gated against a running game, and the zones are generated from it. What
is left is BALANCE, which nothing has measured.

Written 2026-08-21 against v1.10.46.
**§1 and §3-4 rewritten the same day: the maps named below are not the ones the
first draft used.** The original identification (116-119) was wrong, and the
design that hung off it — ladders, bridges, island layouts — described a
different dungeon. See §1.

Altar Cave is a **crystal dungeon**. The Cave of Seals is a **regular dungeon** —
a boss at the end, its own tiles and palettes, no crystal and no job unlock
(`DUNGEON-CHAMBERS-PLAN.md` §4c).

---

## 1. What the cartridge actually has

⭐ **Measured, via `tools/map-names.mjs`.** Map property **byte 2 is the
location-name index**: the entry banner is dialogue string `0x100 + byte2`.
Decoding it for all 256 maps names 78 of them, every one a real place. **Byte 5
is the area id** and groups a dungeon's floors.

⛔ **The first draft of this section named the wrong dungeon.** It picked maps
116-119 by inference — the area byte sits right after Altar Cave's, the palette
is distinct, it is a multi-map cave chain — and shipped a debug button on it. The
name table says map 116 is the **Subterranean Lake**. Everything the draft
described as this cave's identity, the ladders and bridges and islands in black,
belongs to that other dungeon. The inference was reasonable and it was wrong; the
byte was there to be read the whole time.

**The Sealed Cave is area `$18`: maps 103, 104, 105, 106.** Palette `$79`, song
`$1d`, tileset 0. Overworld mouth at **(84, 36)** — Altar Cave's is (95, 34).

| map | banner | walkable | chests | stairs | note |
|---|---|---|---|---|---|
| 103 | "Sealed Cave" | 139 | 2 | 1 | the entrance floor |
| 104 | "B2F" | 125 | 1 | 1 | |
| 105 | — | 125 | 1 | 1 | byte-identical tilemap to 104, two entry points |
| 106 | "B3F" | 154 | 2 | 0 | bones, and the sealed door |

(104/105 sharing one tilemap is the same trick as 111/112 in Altar Cave.)

### The real difference from Altar Cave: void, not connectors

Both caves are **tileset 0 with the same tile ids**. Neither uses a ladder, a
bridge, or water anywhere. The difference is how much of the map is *black*:

| | Altar Cave (22,111,112,113,115) | Sealed Cave (103-106) |
|---|---|---|
| `$00` CEILING | 52.0% | **75.0%** |
| `$5f` VOID | **33.4%** | **3.3%** |
| `$30` FLOOR | 6.8% | **13.3%** |
| `$01` ROCK | 6.4% | 7.1% |
| `$33` LADDER / `$34` BRIDGE / `$04` WATER | 0 | 0 |

Altar Cave is **islands of carved cave floating in black margins**. The Sealed
Cave is a **solid rock mass filled edge to edge**, with corridors cut through it
and almost no void at all — and twice the floor density, so it reads as more open
despite being more enclosed.

⭐ **That makes the skin nearly the whole job.** Same tileset, same tile
vocabulary, same wall grammar — a palette swap plus a fill/void ratio. It does
not need new primitives.

Bones (`$09`) appear at a similar rate in both (9 tiles here, 12 there), so they
are cave decoration, not a Sealed Cave signature.

### The boss and the story hooks

- **Djinn, monster `0xCD`** — HP 480, 700 gil, the id immediately after the Land
  Turtle's `0xCC`.
- Script `0x23b`: *"The Sealed Cave is guarded by undead monsters. They may be
  defeated by casting Cure!"*
- Script `0x23f`: *"There's a secret path in the Sealed Cave. Find the skeleton
  key."*
- Script `0x19c` is the location banner **"Sealed Cave"** — string `0x100 + $9c`,
  and map 103's byte 2 is `$9c`. That is the identification, closed.

---

## 2. What already exists

Most of the machinery landed during the Altar Cave work and needs no new design.

| need | already built |
|---|---|
| per-dungeon tiles/palettes/music | **skin** — `{ donorMap, tileset, musicIn, musicOut, decorate }`, `dungeon/boss-chamber.js` |
| no crystal, no job unlock | **ending kind** — `endingKindFor(mapId)` already DEFAULTS to `boss`; a new range gets the right behaviour by doing nothing |
| the boss's rewards | `battleSt.bossId` — set it to `0xCD` and exp/gil/cp follow |
| a boss arena | one shape + skin, pedestal already lives in the crystal skin |
| the way out | warp tile, gated on `battleSt.enemyDefeated` |
| rooms, corridors, walls | the whole phase-1 vocabulary |
| proof it is not broken | ten gates, all ROM-derived or revert-proven |

## 3. What is genuinely new

1. **Its own map range.** `2000 + depth` or similar; see §4b's decodable scheme.
2. ~~`carveLadder` / `carveBridge`~~ — **dropped.** Those came from the
   misidentified maps. The Sealed Cave has zero of both.
3. **A void budget per dungeon.** The one structural knob that separates the two
   caves: Altar Cave leaves 33% of the map black, the Sealed Cave 3%. Our
   generator currently bakes Altar Cave's habit in. This is a parameter on the
   floor spec, not a new primitive.
4. **An overworld entrance**, and the world-map trigger to reach it.
5. **The Djinn** — battle sprite, formation, and encounter tables for the floors.
6. **Server-side loot pool for the new map range**, or every chest is rejected.

## 4. Order of work

1. ✅ **Map identity — SETTLED.** Maps 103-106, by the name table (§1), not by
   the emulator walk the first draft proposed. Cheaper and it answers every map
   at once rather than one per boot.
2. ✅ **Skin — DONE and corrected.** The DUNGEON tab has an ALTAR / SEALS /
   CRYSTAL row repainting the SAME generated tilemap with another donor map's CHR
   and palettes, and `SEALS_SKIN` in `dungeon/boss-chamber.js` now points at 103.

   ⛔ **It pointed at 111 before this — Altar Cave's own donor.** The "cave" skin
   was repainting the crystal dungeon's palette onto itself, a 100% palette
   overlap that no gate was checking. `check-debug-dungeon.mjs` now fails on
   exactly that, revert-proven.

   **Result: the skin transfers well and the architecture nearly matches too.**
   Our floors already carve corridors through a rock mass, which is what this cave
   is — unlike the island-and-bridge layout the first draft chased.
3. **The void budget** (§3.2), gated by extending `tile-grammar` to maps 103-106.
   Their ratios differ sharply from 111-115, so the census must not average the
   two caves into one blurred rule.
4. **The Djinn and its chamber**, reusing the boss chamber with a `boss` ending.
5. **Wire the range**: the eight integration points in §4b, of which two fail
   SILENTLY — `inDungeon = dungeonFloor >= 0 && dungeonFloor < 4` stops encounters
   dead, and `_resolvedChestPool` rejects every chest.

## 5. Risks, from what this session actually cost

- ⛔ **Render it before shipping it.** Three additions this session passed every
  gate and were rejected on sight. Gates say a thing is not broken; they say
  nothing about whether it belongs.
- ⛔ **Read the ROM's own tables before inferring from art.** An area byte next
  to Altar Cave's, a distinct palette and a plausible size pointed confidently at
  the wrong dungeon, and a "SEALS" button shipped on it. `map-names.mjs` settled
  it in one command. When a table exists, circumstantial evidence is not a
  shortcut, it is a wrong answer that takes longer.
- ⛔ **Extend the tile grammar to maps 103-106 before tuning fill.** The census
  derives its rules from 111/112/113/22/115 only, whose void ratio is ten times
  this cave's. Averaging the two caves would erase the one difference that
  matters.
- ⛔ **Do not place structures against assumed rows.** Four separate couplings
  turned up chasing contour, all the same: exits, entrances and doors assume the
  rows a room was carved at. Any fill/void change moves those rows, so it will
  find them again.
- ⛔ **Monster tables are content.** `ENCOUNTERS` has four Altar Cave zones and
  nothing else. Undead formations for this cave are authoring work, not generator
  work.


---

## 6. ⭐ SOLVED: FF3's per-map encounter table (v1.10.56)

Decoded, measured against a running game, and wired. `tools/ff3-zone-trace.mjs`
found it; `tools/lib/ff3-map-encounters.mjs` carries the trace;
`tools/check-map-encounters.mjs` is the gate.

### The chain

    map id ($48)  -> $92F0[map]            = the map's encounter GROUP
                     $93F0[map-256]          ...for maps 256-511 ($78 != 0)
    group         -> $94F0 + group*8       = EIGHT formation ids
    slot          -> $BD78[random & $3F]   = 12/12/12/12/6/6/3/1 out of 64
    formation     -> $5C010                = species record + count pattern
    rate          -> $BE00[map]            = chance out of 256, per step check

`$48` is the live map id — confirmed exactly for 103/104/106/111/114/7/12. The
world map takes a different branch: `$78` selects the world, and world 0 splits
into a **4x4 grid of 32-tile regions** at `$9CF0`, indexed by the cartridge's own
`(x+7)&$7F >>5` / `(y+7)&$60 >>3`.

⛔ **The rate table is in a DIFFERENT BANK from everything else in the chain.**
The encounter roll runs with bank 61 at `$A000` and bank 46 at `$8000`; the rate
is read during a map LOAD, with bank 57 at `$A000`. Bank 61's own `$BE00` is
executable code that reads as a table of plausible small numbers. This is the
trap the plan warned about, and it very nearly landed.

### What this replaced

⛔ It is **not** any of the 16 map property bytes. All sixteen were decoded as a
set index and checked against species; the two that appeared to match were the
tileset byte (`tileset<<5 | entranceX`) and the songId byte (`TRACKS.CRYSTAL_CAVE`
happens to be `$02` too). That search is gone from `map-encounters.mjs`, which
now decodes for real.

### What it changed

⭐ **Formations are WEIGHTED, not uniform.** Altar Cave B1F is Goblins 63 times
in 64. The Cave of Seals' real roster is Mummy-led, not Zombie-led — **Zombie
(`$09`) is not in this cave at all**, which the hand-authored version had on
floor 1. Floors are `103 -> 104 -> 105 -> 106` = groups `7 -> 8 -> 8 -> 9`, stored
as `romFloorMaps` on the registry row.

⛔ Because floor 4 is our boss chamber, group 9 — Revenant + Shadow, the cave's
deepest tier — never appears in a random encounter. That is a consequence of the
1:1 floor mapping, not a decode gap; `seals_cave_f4` carries the group with
`rate: 0` so it stays visible. Pointing `romFloorMaps[2]` at 106 instead of 105
would put it in play at the cost of the 1:1.

## 7. Balance — MEASURED (v1.10.57)

`node tools/zone-balance.mjs --seals` drives `battle-sim.js` — the shipped
math — over every formation a zone can roll, spawning the way
`startRandomEncounter` does (per-group count roll, **hard stop at four bodies**)
and weighting by the ROM's slot odds. Win rate per encounter, 60 runs each:

| party | altar_cave_f4 | seals_f1 | seals_f2/f3 | Djinn |
|---|---|---|---|---|
| KN5            | 100% | **4%**  | **3%**  | — |
| KN5 + WM4      | 100% | **28%** | **17%** | — |
| KN8 + WM6      | 100% | 92%     | 95%     | 0% |
| KN8 + WM6 + BM6| 100% | 99%     | 100%    | 0% |
| KN12+WM10+BM10 | 100% | 100%    | 100%    | 100% |

⭐ **The step from Altar Cave to the Cave of Seals is the sharpest in the game**
— 100% to 4% for the party that just cleared it. Altar Cave's deepest floor is
a 100% win at *every* level tested, so nothing there prepares a player for
Mummy x2-4, which is 48/64 of Seals floor 1.

⭐ **The Land Turtle gates nothing.** A solo KN5 beats it 100/100. Whatever
level a player leaves Altar Cave at is whatever they wandered in with.

⭐⭐ **The Djinn is a MAGIC check, not a level check.** It resists fire, is weak
to ice, and casts Fire at an 85% rate. All-attack, a KN8+WM6+BM6 party loses
40/40; the same party with the Black Mage casting **Bzzard wins 85%**. Level 9
all-attack is 60%; level 9 with ice is 100%.

⛔ **None of this reaches a player yet.** The cartridge's own mouth at (84,36)
sits in an isolated pocket of **8 tiles** with no path to Ur's 267-tile region —
the dungeon is debug-only until a choke is lifted. `check-encounter-zones.mjs`
now asserts that, so joining those regions FAILS THE GATE and forces the
decision (level gate, quest flag, or an accepted spike) instead of dropping a
level-5 character into a 4% fight.

⚠ The sim's party only ever attacks — no potions, no Cure, no Protect. Real
play is better than these numbers, and the Djinn row shows how much better one
correct spell makes it. Treat them as a floor, and as a comparison between
zones rather than an absolute.
