# Cave of Seals — plan

Status: **plan only, nothing implemented.** Written 2026-08-21 against v1.10.46.

Altar Cave is a **crystal dungeon**. The Cave of Seals is a **regular dungeon** —
a boss at the end, its own tiles and palettes, no crystal and no job unlock
(`DUNGEON-CHAMBERS-PLAN.md` §4c).

---

## 1. What the cartridge actually has

Read out of the ROM, not from memory.

**The maps: 116 / 117 (one shared tilemap, two entry points, like 111/112), 118,
and 119.** Door chain: 116 → 118 → 119, and 116 → 117.

| map | walkable | chests | stairs | fill | note |
|---|---|---|---|---|---|
| 116 | 87 | 1 | 1 | `$5f` VOID | islands in black, one long bridge |
| 117 | 87 | 1 | 1 | `$5f` VOID | same tilemap as 116 |
| 118 | 135 | 4 | 1 | `$5f` VOID | **seven ladders** |
| 119 | 138 | 2 | 0 | **`$04` WATER** | a flooded cavern |

**It looks nothing like Altar Cave.** Same tileset (0), different palette — map
property byte 9 is `0x8b` against Altar Cave's `0x78` — and it renders as **pale
grey stone with black stalactites hanging from every ceiling**, on an olive floor.
Rendered with `map-png.mjs`; that is a skin, exactly as §4c defines one.

**Its area id is the one after Altar Cave's.** Map property byte 5 is `0x31`
here and `0x30` for all five Altar Cave maps. Each cave cluster in the ROM has its
own area byte, and these two are adjacent.

### Two connectors Altar Cave does not have

- **`$33` — a vertical LADDER.** A column of them dropping through void, with
  floor above and `$02` rock at the lip. Map 118 has seven; vertical is this
  cave's primary connector, where Altar Cave uses carved corridors.
- **`$34` — a horizontal BRIDGE.** Nine in a row on map 116 at row 23, void above
  AND below — a walkway across a chasm.

Chambers are **islands in black joined by ladders and bridges**, rather than one
continuous carved silhouette. That is the dungeon's identity and the reason it
cannot just be Altar Cave with a recolour.

### The boss and the story hooks

- **Djinn, monster `0xCD`** — HP 480, 700 gil, the id immediately after the Land
  Turtle's `0xCC`.
- Script `0x23b`: *"The Sealed Cave is guarded by undead monsters. They may be
  defeated by casting Cure!"*
- Script `0x23f`: *"There's a secret path in the Sealed Cave. Find the skeleton
  key."*
- Script `0x19c` is the location banner **"Sealed Cave"**.

### ⛔ What is NOT proven

That maps 116-119 are the ones the game calls the Sealed Cave. The evidence is
circumstantial-but-strong: the area byte sits directly after Altar Cave's, the
palette is distinct, it is a multi-map cave chain, and its size and shape match a
mid-early dungeon. I could not find a map -> name table to settle it, and the
encounter-set index is not one of the property bytes I checked.

**The decisive test, before any of this is built:** boot the world map with
`tools/monscan/world-harness.cjs`, walk onto the Sealed Cave's overworld entrance,
and read `$48`. That is one measurement and it either confirms 116 or names the
real map. Do it first — every number below hangs off it.

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
2. **`carveLadder` / `carveBridge`** — the two connectors above. Both cross VOID,
   which no existing primitive does: every corridor we have carves through rock or
   along a ceiling snake.
3. **Void fill on every floor.** Altar Cave uses void only on floor 0; this cave
   uses it throughout, so its floors are island-and-bridge layouts rather than
   rooms-in-a-slab.
4. **An overworld entrance**, and the world-map trigger to reach it.
5. **The Djinn** — battle sprite, formation, and encounter tables for the floors.
6. **Server-side loot pool for the new map range**, or every chest is rejected.

## 4. Order of work

1. **Settle the map identity** with the world harness (§1).
2. ✅ **Skin only — DONE, in the debug tab (v1.10.47).** The DUNGEON tab has an
   ALTAR / SEALS / CRYSTAL row that repaints the SAME generated tilemap with
   another donor map's CHR and palettes. No generator change.

   **Result: the material transfers, the architecture does not.** Our floor 1 in
   the SEALS skin reads convincingly as that cave — pale stone, stalactites
   hanging off every wall band, olive floor, black void. Side by side with ROM map
   116 the difference is entirely structural: the cartridge's cave is ISLANDS
   joined by ladders and a bridge; ours is one connected blob with far more wall.

   So the skin is nearly free and the layout is the whole job. That reorders what
   follows: build the ladder/bridge connectors and island placement FIRST, and
   treat the recolour as a finishing step rather than a starting one.
3. **Ladder and bridge primitives**, gated by the tile-grammar check against maps
   116-119 the way the current one checks 111-115.
4. **Island layouts** — chambers placed in void and joined by ladders/bridges.
5. **The Djinn and its chamber**, reusing the boss chamber with a `boss` ending.
6. **Wire the range**: the eight integration points in §4b, of which two fail
   SILENTLY — `inDungeon = dungeonFloor >= 0 && dungeonFloor < 4` stops encounters
   dead, and `_resolvedChestPool` rejects every chest.

## 5. Risks, from what this session actually cost

- ⛔ **Render it before shipping it.** Three additions this session passed every
  gate and were rejected on sight. Gates say a thing is not broken; they say
  nothing about whether it belongs.
- ⛔ **Extend the tile grammar to this cave's maps FIRST.** The census currently
  derives its rules from 111/112/113/22/115 only. Ladders and bridges do not exist
  there, so every arrangement using them would land in "insufficient evidence" and
  be excused — which is exactly the hole that let the disguised doorway through.
- ⛔ **Do not place structures against assumed rows.** Four separate couplings
  turned up chasing contour, all the same: exits, entrances and doors assume the
  rows a room was carved at. Islands-and-bridges makes that worse, not better.
- ⛔ **Monster tables are content.** `ENCOUNTERS` has four Altar Cave zones and
  nothing else. Undead formations for this cave are authoring work, not generator
  work.
