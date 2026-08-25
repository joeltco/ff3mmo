# FF3 battle backdrops — decoded, measured, wired

**Status: complete and verified on hardware, 2026-08-25 (v1.10.79).**
All 24 backdrops match a live PPU on all four of their fields. Both map lookup
tables are read. The overworld terrain path is wired. The battle screen draws it.

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

World 0's walkable tiles use exactly six ids:

| id | terrain |
|---|---|
| 0 | grassland |
| 1 | desert |
| 2 | forest |
| 3 | marsh |
| 4 | rock / mountain |
| 5 | ocean |

**⛔ Entrance tiles do not carry a backdrop.** When byte 1 bit 7 is set the tile
is a warp and byte 2 is its destination id instead — ids that run to `0x19`, past
the 24 real backdrops. `battleBgIdForWorldProps` masks and range-checks anyway.

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
nametable rows. The enemy count wobbled between those runs, but it wobbles for
`$09` and `$0a` too, so that is the RNG, not the bits.

They are not backdrop data. What they *are* is unknown, and
`src/battle-bg.js` says so in the source rather than masking them away silently.

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
| `tools/check-battle-bg.mjs` | the gate. Shipped renderer vs the PPU capture, pixel for pixel, all 24. Proves both lookup tables are read by finding maps where they disagree. Range-checks all 512 maps. Pins the world-terrain path and the orphan set. Asserts the battle screen actually calls the drawer |
| `tools/battle-shot.mjs` | the battle viewport through the shipped drawers. `--map N`, `--world X Y`, `--bg N`, `--all out.png` |
| `tools/battle-bg-sheet.mjs` | all 24 backdrops, labelled with the maps that use them |
| `tools/monscan/battle-bg-sweep.cjs` | the hardware capture, 24 boots, ~3 min. Re-run after touching any constant |
| `tools/monscan/battle-bg-probe.cjs` | one battle with arbitrary ROM bytes patched |
| `tools/monscan/world-bg-probe.cjs` | walks the real overworld until a fight fires and reads the backdrop back |

## Where it is wired

`src/battle-backdrop.js` is the single source. Resolution happens at **draw
time** from `mapSt`, not at each battle-start site — random encounters, chest
mimics, server-rolled PvE, bosses and PvP all get it, and a new kind of battle
has nothing to forget to set.

`isFieldStillShowing()` in `battle-state.js` decides when the field map gives way
to the battle field. It has **two readers** — `render.js` (is the walking sprite
still drawn?) and `battle-backdrop.js` (blank the viewport yet?) — because those
two must be the same answer. It is deliberately *not* the same predicate as
`updateHudHpLvStep` in `hud-drawing.js`, which stays true longer.

## Known cosmetic note

Monster sprites overlap the bottom of the band by roughly 8 px, because the
encounter grid centres monsters in a 144 px viewport while the band keeps the
console's 8 px offset. They read as standing in front of the backdrop, which is
what a backdrop is for, and the cartridge does the same with tall monsters. Not
changed — the grid is shipped layout and moving it was not asked for.
