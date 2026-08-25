# FF3 battle backdrops — decoded, measured, wired

**Status: complete and verified on hardware, 2026-08-25 (v1.10.81).**
All 24 backdrops match a live PPU on all four of their fields. Both map lookup
tables are read. Selection is a registry (`src/data/backdrops.js`); the overworld
strip follows the biome under the party and dungeons resolve per floor.

⛔ **These strips are ff3mmo's AMBIENT ART LAYER — the HUD top box, the dungeon
loading screen, the title screen — not a battle-screen backdrop.** See
*Where it is wired*.

Two things here are **not** settled and are labelled as such: bits 5-6 of the map
lookup byte, and the per-world tile-prop tables for worlds 1 and 2.

---

## What a backdrop is

A **256 x 32 band** at the top of the battle field — nametable rows 1-4, i.e.
y = 8..39 — with the rest of the field black. Measured off the PPU; not inferred
from the tilemap being 32 bytes long.

It is built from four separate ROM fields. **Reading fewer than four is not
reading the record.**

| field | ROM | shape |
|---|---|---|
| tiles | `0x018010 + bgId * 0x100` | 16 tiles x 16 bytes, CHR ids `$60`-`$6F` |
| palette | `0x001110` / `0x001210` / `0x001310`, indexed by bgId | colours 1-3; colour 0 is always `$0F` |
| tilemap id | `0x05E512 + bgId` | picks one of 3 tilemaps |
| tilemap | `0x05E53A + tmid * 32` | 32 metatile indices — 16 across, 2 down |
| metatiles | `0x05E52A + m * 4` | 4 metatiles x 4 tile ids (TL, TR, BL, BR) |

`BATTLE_BG_COUNT = 24`, ids 0-23. Not an estimate: the tilemap-id table runs out
at 24 — entry 24 onward **is** the metatile table, which is why
`BATTLE_BG_META_TILES` sits at `TMID + 24` — and the highest low-5 value in
either map lookup table is `0x17` = 23.

---

## How a backdrop is selected

### Towns, interiors, dungeons — the map lookup

Bank `$39` at `$A000`, code at `$C533`:

```
LDA #$39 / JSR $FF09      ; page bank $39 into the $A000 window
LDX $48                   ; $48 = map id, LOW byte
LDA $78 / BEQ +           ; $78 = map id HIGH bit (which 256-map bank)
LDA $BD00,X               ;   maps 256-511   -> ROM 0x073D10
LDA $BC00,X               ; + maps   0-255   -> ROM 0x073C10
STA $53 / STA $6B         ; the RAW byte, high bits and all
```

`bgId = table[mapId] & 0x1F`. `$6B` holds the raw byte; the mask happens
downstream.

**⛔ THERE ARE TWO TABLES.** This game read only `$BC00` until v1.10.79. FF3 has
maps above 255 (`loadMap` reaches 511), so every high map silently drew
map-mod-256's backdrop. `battleBgIdForMap` in `src/battle-bg.js` reads both.

Dungeons resolve through `resolveDungeonDonor` first — a dungeon floor's map id
is ff3mmo's own synthetic id and would index the table meaninglessly.

### The overworld — the tile you are standing on

The map lookup is indexed by map id and the overworld is not a map id. This is
**byte 2 of the tile's entry in the world tile-property table** — the same
128 x 2 table `world-map-loader.js` already parses for passability and
entrances. Byte 1 was consumed for years; byte 2 was dropped on the floor.

World 0's non-warp tiles use exactly six ids. **What reaches a strip matters as
much as what it looks like** — two of these are water you can only be standing on
in a boat:

| id | name | placed | reachable by |
|---|---|---|---|
| 0 | grassland | 2410+ | foot |
| 1 | desert | 377 | foot |
| 2 | forest | 717 | foot |
| 3 | marsh | **0** | — never placed on this world |
| 4 | **lake** | 75 | canoe / ship — **foot BLOCKED** |
| 5 | ocean | 4548 | ship — foot and canoe blocked |

Backdrop 4's 75 tiles are one body of water at world **81-87, 38-40**, ringed by
mountains with a cave mouth on its north shore (`node tools/world-shot.mjs
84,39`). It was called `mountain` for a day off a glance at the strip art.

**⛔ AN IMPASSABLE TILE'S BYTE 2 IS NEVER SEEN.** You cannot start a fight
standing on a tile you cannot stand on, so the byte is dead there — the same way
a warp tile's byte 2 is a destination. World 0's real MOUNTAIN tiles
(`$05 $06 $07 $15 $16 $17`, byte 1 `$1f`, 855 placed) carry byte 2 = 0 and it
means nothing. Do not read them as evidence that mountains fight on grassland.

**⛔ Entrance tiles do not carry a backdrop.** When byte 1 bit 7 is set the tile
is a warp and byte 2 is its destination id instead — ids that run to `0x19`, past
the 24 real backdrops. `battleBgIdForWorldProps` returns `NO_BACKDROP` there.

**⛔⛔ AND YOU CAN STAND ON ONE.** "The warp fires first so it never matters" is
wrong twice: leaving a town drops you **on** its entrance tile, and this game
REMOVES some entrances — map 180, the Invincible, is parked at world **(90,59)**,
dead centre of the desert west of Kazus. That tile is ordinary ground you walk
across, and answering `0` for it painted a **grassland strip in the middle of a
desert**. Found in play.

`WorldMapRenderer.battleBgIdAt` gives a warp tile the commonest biome of the
eight tiles around it. ⚠ **Our choice, not the cartridge's** — FF3 reads the
entrance id as a backdrop and gets nonsense it never shows. Ours gives desert in
the desert and grass at Kazus' door, and `check-battle-bg` pins both.

### ⛔ Naming: ask the ROM before describing a picture

The cartridge does not name its backdrops, so every registry row carries the
evidence its name rests on, ranked:

| rank | basis |
|---|---|
| ⭐ ROM-NAMED | a map that selects the strip carries a name banner (map property byte 2 → string `0x100+b2`) |
| TILE-MEASURED | the world tiles that select it, **with their passability** |
| ⚠ FROM THE RENDER | nothing corroborates it — someone looked at the strip |

**Three names came off the art and were wrong.** `hills` was the MOUNTAIN strip —
its only two maps are 92 "Summit Road" and 94 "Bahamut's Nest". `ice` was the
CRYSTAL CHAMBER — 148 "Wind Crystal", 149 "Fire Crystal", which is exactly why
Altar Cave's crystal boss floor takes it. And `mountain` was a LAKE.

`check-battle-bg` pins all three: backdrop 4's placed tiles must be foot-blocked
and canoe-passable, backdrop 7's map set must be exactly `{92, 94}`, and backdrop
15's must contain 148 and 149.

**The tell that this path existed at all:** seven of the 24 backdrops are reached
by no map in either lookup table. Six of them are the list above; the seventh is
18, undersea. A backdrop the cartridge ships that no code can reach is a dropped
field, not a spare.

### Other worlds — STRIDE-DERIVED, NOT MEASURED

Per-world tile-prop tables follow the same 256-byte stride as every other
per-world table:

| world | ROM | non-warp backdrop ids present |
|---|---|---|
| 0 | `0x000510` | 0,1,2,3,4,5 |
| 1 | `0x000610` | 0,1,2,3,4,5,7 |
| 2 | `0x000710` | 0, 18 (undersea) |

**No probe has ever stood on world 1 or 2.** This game loads world 0 and the
headless world harness only reaches world 0. Do not present these as verified.

### Backdrop 6 (sky) is an orphan

Selected by nothing in this cartridge's data — no map, no world's terrain.
`check-battle-bg.mjs` pins the orphan set to exactly `{6}`, so if a real user for
it ever turns up, it fails rather than passing quietly.

---

## ⚠ Bits 5-6 of the map lookup byte — UNDECODED

Set on **79 of the 512 entries**; bit 7 never. Both values occur in stock data on
maps that share a backdrop (map 181 is `$08`, map 183 is `$28`).

Measured, not assumed: bytes `$08` / `$28` / `$48` were run on real hardware and
the backdrop came back **pixel-identical** every time — same palette, same four
nametable rows.

They are not backdrop data. What they *are* is unknown, and `src/battle-bg.js`
says so in the source rather than masking them away silently.

---

## How every claim above was measured

Nothing here rests on a disassembly alone.

**The map index.** Patching table entry 181 changes the backdrop on screen;
patching the other 255 entries changes nothing. Watching zero page from boot:
`$48` becomes 181 at frame 2937 (map load) and `$6B` becomes
`table[181] & 0x1F` at frame 3609.

**All 24 backdrops.** `tools/monscan/battle-bg-sweep.cjs` hex-patches the
map->backdrop byte, boots the real cartridge into a real encounter, and compares
tiles, palette, tilemap and metatiles against the ROM model. 24 of 24 agree. The
capture itself is checked in at `tools/monscan/battle-bg-sweep.json` — the bytes,
not a verdict — so the gate compares the shipped renderer to a PPU and not to
itself.

**The overworld link.** Forcing byte 2 of every world tile to `0x0C` and walking
until a fight fired put backdrop 12's palette (`0f 26 14 04`) on screen and
`0x0C` in `$6B`. Stock, the same walk gives 0.

**The band's size and position.** Read out of the nametable and attribute table
in a live battle: rows 1-4, one attribute palette, tiles `$60`-`$6F`, and the
tile bytes match ROM `0x018810` 16 of 16 for backdrop 8.

---

## Tools

| tool | what it does |
|---|---|
| `tools/check-battle-bg.mjs` | the gate. Shipped renderer vs the PPU capture, pixel for pixel, all 24. Proves both lookup tables are read by finding maps where they disagree. Range-checks all 512 maps. Pins the world-terrain path, the orphan set, the registry's biome rows, per-floor dungeon resolution, and that `setupTopBox` holds no hardcoded id and `movement.js` refreshes the strip |
| `tools/backdrop-shot.mjs` | the strip a place actually gets, through the shipped resolver. `--walk x0 y0 x1 y1 [steps]` renders a biome crossing; `--dungeon <id>` every floor; `--map N` one map |
| `tools/battle-bg-sheet.mjs` | all 24 backdrops, labelled with the maps that use them |
| `tools/monscan/battle-bg-sweep.cjs` | the hardware capture, 24 boots, ~3 min. Re-run after touching any constant |
| `tools/monscan/battle-bg-probe.cjs` | one battle with arbitrary ROM bytes patched |
| `tools/monscan/world-bg-probe.cjs` | walks the real overworld until a fight fires and reads the backdrop back |

## Where it is wired

**⛔ The backdrop is not a battle-screen backdrop in this game.** FF3 draws it
behind the monsters; ff3mmo uses the same strips as its **ambient art layer**,
which is a deliberate design decision and predates all of this work:

| consumer | what it does with the strip |
|---|---|
| HUD top box | `hud-drawing.js` — drawn at (0,0) whenever you are not in a town, with an NES palette fade ramp tied to map transitions |
| dungeon loading screen | `loading-screen.js#_drawLoadingBG` — scrolls horizontally on `loadingSt.bgScroll`, drawn twice for the wrap |
| title screen | `title-animations.js` — the sky and ocean |

v1.10.79 briefly painted the strip into the battle viewport as well. That was an
invented system, not asked for, and it was reverted in v1.10.80. **Do not
rebuild it.**

### The registry

`src/data/backdrops.js` owns WHERE each id is used; `src/battle-bg.js` owns
turning an id into pixels. A new place to show a strip is a new row in
`BACKDROP_SOURCES` and touches no decoder.

```
BACKDROP_SOURCES = [
  { id: 'world',   when: onWorldMap,           resolve: tile props byte 2 },
  { id: 'dungeon', when: isDungeonMapId,       resolve: dungeonRomMapFor -> map table },
  { id: 'map',     when: always,               resolve: map table },
]
```

Order matters and not cosmetically: a dungeon floor's mapId is ff3mmo's own
synthetic id (1000+) and would index the ROM's map table meaninglessly, so the
dungeon row must come before the map row.

`BACKDROPS[24]` carries a name and an `evidence` line per id. **Names describe a
render; the cartridge does not name its backdrops.** For the six overworld
strips the evidence is the set of world tiles that select them, which is
measured. Do not tighten a name into a claim the evidence does not support.

### Overworld biomes

`setupTopBox` used to hardcode grassland for the entire overworld, because the
map table is indexed by map id and the overworld is not a map id. The strip is
now the biome under the party, and `refreshWorldBackdrop()` in `map-loading.js` —
called once per completed step from `movement.js` — keeps it current as you walk.

Cheap on purpose: the id is one table read per step, and the strip is only
rebuilt when it actually **changes**. `getBattleBg` memoises the whole fade ramp
per id, so crossing a desert border swaps two canvas references. A per-step
`renderBattleBg` would rebuild ~20 canvases every footstep.

World 0's tilemap uses five of the six terrain strips — grass 10667 tiles,
ocean 4548, forest 717, desert 377, rock 75. **Marsh (3) has a props entry but no
tile on this world's map.**

### Dungeons, per floor

`dungeonRomMapFor(mapId)` gives a boss floor its **skin's** donor and a walkable
floor its own `romFloorMaps` entry — the same list the encounter tables are keyed
on, so the strip and the monsters come from the same cartridge map. Side rooms
and anything unlisted fall back to the dungeon's donor.

Altar Cave: floors 0-3 `cave`, boss floor `crystal chamber` (crystal skin, donor 148).
Cave of Seals: all four `cave`.

⚠ Both shipped dungeons land on `cave` for every walkable floor, so per-floor
resolution changes nothing visible **today**. That is exactly why the gate pins
it: a dungeon whose floors cross terrain would otherwise have shipped one strip
for the lot and looked fine.
