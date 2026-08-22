# Dungeon chambers / corridors — modularization plan

Status: **plan only, nothing implemented.** Written 2026-08-20 against v1.10.15,
revised the same day after comparing against the cartridge's own Altar Cave.

The ask: chambers, rooms and corridors as reusable modules; floor shapes that
actually differ per seed; a real dungeon generator instead of a same-floor
cloner. Floor 3 (mapId 1003, the last cave floor before the crystal room) is the
worst offender.

---

## 0. What the cartridge's Altar Cave actually does

Rendered with `tools/map-png.mjs` and compared against our floors with
`tools/floor-png.mjs` (written for this — we could render ROM maps to PNG but
not generated floors, so every previous comparison was PNG-against-ASCII).

The real cave is six maps: **111 → 112 → 113 → 22 → 115 → 148**. It does two
different things, and the split is the important part:

| ROM map | fill | void tiles | walkable |
|---|---|---|---|
| **111 / 112** (floor 1) | **`$5f` VOID** | **855** | 39 |
| 113 | `$00` ceiling | 1 | 95 |
| 22 | `$00` ceiling | 1 | 87 |
| 115 | `$00` ceiling | 0 | 142 |
| 148 (crystal) | `$00` ceiling | 0 | 59 |

Map 111 is a cave island floating in black, its entrance a cave mouth showing
**daylight** — a real sky tile — over striped stairs. Maps 113 / 22 / 115 are the
opposite: solid textured rock edge to edge with rooms carved into it.

**Our generator already matches this, map for map.**
`fillTile = (floorIndex === 0) ? FILL_VOID : CEILING` gives floor 0 a void fill
(678 tiles) and floors 1–4 a ceiling fill (0–1 void). The material proportions
match too: ROM 115 is 784 rock / 96 dark-band / 125 floor, our floor 3 is
810 / 75 / 114.

> ⛔ **RETRACTED:** an earlier draft of this plan proposed making *every* floor a
> silhouette in black and retiring `placeDeepEntrance`. That was wrong and would
> have made the cave **less** faithful — the black surround belongs to floor 1
> alone. Floor 0 stays the void-fill outlier with its framed arch entrance;
> deeper floors stay rock-slab. Do not re-propose this.

What genuinely differs is **contour**, not material:

- our overhang bands are clean rectangles sitting above rectangular rooms; the
  ROM's dark band follows the floor's edge in irregular 1–3 tile patches;
- our floor 3 is symmetric around a dead-straight 15-tile central corridor; map
  115 wanders diagonally and changes width as it goes;
- our pond is a rectangle shoved into a corner and clipped by the map edge; the
  ROM's sits in a niche with rock wrapping it;
- the ROM's caves are smaller and more winding — map 111 is 39 walkable tiles
  against our floor 0's 129.

Two attempts to reduce "boxy" to a number: perimeter-per-floor-tile half works
(ROM 1.07–1.59 vs ours 0.90–1.08 — theirs consistently more wall-hugging, but the
ranges overlap at the bottom), and an edge-alignment metric **failed outright**,
scoring ROM 115 boxier than our floor 3. Neither is gate material. The cloning
measure in §1 is the one that holds.

---

## 1. What the layouts actually are

Measured over 200 timestamp seeds per floor
(`reachableFrom` from `dungeon-sweep.mjs`; "share" = mean pairwise Jaccard of the
walkable-tile sets of two different seeds).

| floor | walkable tiles | share between two seeds | tiles walkable in ≥90% of seeds | tiles that ever vary | distinct entrance positions |
|---|---|---|---|---|---|
| 0 | 126 | 0.630 | 72 | 221 | **2** |
| 1 | 84 | 0.280 | 2 | 447 | 23 |
| 2 | 79 | 0.193 | 0 | 402 | **2** |
| **3** | **122** | **0.727** | **85** | **101** | **1** |
| 4 (crystal) | 61 | 1.000 | 61 | 0 | 1 |

**Floor 3 is the clone.** Two players entering it see the same 73% of the map,
70% of its walkable tiles are in the same place almost every time, and across 200
seeds the entrance never moved once. Floor 4 scoring 1.000 is correct — it is a
handcrafted boss room and stays that way.

Floor 3's skeleton is literally constants in the source: `entranceX = 16`,
`stairY = 27`, `roomCenterY = 9`, side rooms at `roomLeft - 6` / `roomRight + 6`.
The only things the seed decides are which side the pond is on, which side the
single branch alcove goes, chest positions, and one tile of edge jitter. Every
visit is: bottom-centre entrance → long vertical corridor up column 16 → one
branch alcove around row 20 → three rooms in a row at rows 8–12 → staircase.

Floor 0 is second (0.630, two entrance positions — the `aOnRight` flip).

Secondary observation: every floor uses **8–12% of the 1024-tile grid**. There is
a lot of unused cave.

## 2. Why it clones — the code

- **The same room is written out four times.** `const isEdge = (dy <= -3 || dy >= 1);`
  appears 4× inline. The source says so itself: *"Copies floor 2's room/corridor
  primitives verbatim"*, *"identical primitive to floor 2's exit room"*,
  *"direct copy of floor 2's first 5×5 mid room"*, *"direct copy of floor 2's 7×7
  chamber primitive"*. Floor 1 is a hand-copy of half of floor 2.
- **`_generateFloor` is one 1,540-line function** with a per-floor `if/else`:
  floor 0 ≈ 140 lines, floor 1 ≈ 159, floor 2 ≈ 351, floor 3 ≈ 328, floor 4 ≈ 5
  (it delegates to `generateBossRoom` — the one floor that already does this
  right). Everything is carved inline against literal coordinates, so "vary the
  shape" means editing arithmetic rather than changing an input.
- **A generic composable generator already exists — and nothing can reach it.**
  The final `else` branch (entrance room → horizontal pathway → junction room →
  vertical pathway → chamber, via `carveSmallCaveRoom` / `carvePathway` /
  `carveVerticalPathway`) only runs for `floorIndex >= 5`, which the game never
  requests: map ids 1000–1004 give 0–4. Rendered by hand it produces varied,
  reasonable floors. It is the seed of the architecture we want, abandoned.
- **Dead code sitting in the way:** `buildCaveShape` + `generateCaveOutline`
  (~110 lines, nothing calls them — and `design-notes.md` documents
  `buildCaveShape`'s parameters as though it were live), `carvePathwayRoom`,
  `findInteriorFloor`.

## 3. The chamber and corridor system

### 3a. Chambers that exist today

Every one of these works. What they share is being **floor-locked** — hardcoded
into one `if (floorIndex === N)` branch — which is the cloning problem restated.
Rates measured over 200 seeds per floor.

| chamber | floors | how often | built from |
|---|---|---|---|
| entrance (framed arch, in black) | 0 | always | `placeEntrance` + `openEntranceLanding` |
| entrance (3-wide notch) | 1, 2, 3 | always | `placeDeepEntrance` |
| exit stairs | 0, 1, 2 | always | `placeExit` / `placeDeepExit` |
| exit door `$70` | 3 | always | inline → crystal room |
| **locked chamber** behind a door + Magic Key | 0 → map 1010 | **99/200 (~50%)** | `findChamberDoorPos('north')` + `placeChamberDoor` + `generateLockedRoomMap` |
| | 2 → map 1011 | **103/200 (~52%)** | same |
| **secret corridor** (disguised `$44`) | **0 only** | **118/200 (59%)** | `placeSecretPath` → `findCorridorCandidates` → `carveCorridor` |
| **secret room** (6 tiles, 2 chests) | 0 → maps 1020/1021 | 139 rooms / 200 seeds | `generateSecretRoomMap` |
| trap chamber (3–5 hidden `$74`) | **1 only** | always | inline 7×7 |
| boulder-switch chamber | **2 only** | always | inline `rockSwitch {rocks, wallTiles}` |
| branch alcove + dead-end chest | **3 only** | always | inline |
| pond | **3 only** | always | inline water lines `$04`/`$23` |
| boss / crystal chamber | 4 | always, identical | `generateBossRoom`, tileset 2, warp at (6,5) |
| loot scatter | all | per `FLOOR_CONFIG` | `scatterRoomLoot` + `findCornerFloor` |
| moogle | 0 | always | `placeMoogleAtCaveCenter` (map-loading) |

Secret-corridor odds, from the source: the primary corridor always spawns, a
second one 50% of the time on the opposite side, and each is **independently 50%
"false"**. Only a false corridor leads to a secret room — a non-false one is a
plain dead end. That gives 62.5% theoretical; 59% measured, the gap being seeds
where `carveCorridor` finds no candidate.

Built but unreachable: `placePond` (`ponds: 0` in every `FLOOR_CONFIG`),
`placeLockedRoom` (the in-chamber replica variant — imported, never called; the
door-plus-standalone-map path is the live one), `buildCaveShape`,
`generateCaveOutline`, `carvePathwayRoom`, `findInteriorFloor`, and the whole
generic branch at `floorIndex >= 5`.

### 3b. ✅ Secrets on a rock-slab floor — BOULDER SWITCH (v1.10.42)

This is the single biggest structural finding and it constrains the whole design.

`findCorridorCandidates` requires **`FILL_VOID` on the outer side** — the wall
tile must have void beyond it, and the carver needs *four tiles* of void across
rows `wy-3 … wy+1` to put the corridor in. `carveCorridor`'s own comment says
what it is: *"carve a corridor as a snake detour — the `$00` border IS the
snake"*, tracing the ceiling outline outward and reconnecting.

Floor 0 is the only floor with a void fill (§0), so it is the only floor with a
1-tile ceiling snake and empty space outside it. Floors 1–4 are solid rock to the
map edge: **no void, no snake, nothing to detour into.** The
`if (floorIndex !== 0) return falseWalls` guard is not a policy choice, it is a
statement of fact about the tilemap.

⛔ **REVERTED in v1.10.40 after seeing one in the game.** `findRockTunnelSpots` +
`carveRockTunnel` dug straight into the slab: a `$44` mouth in the room's wall, the standard cross-section (ceiling at
y-3, rock at y-2/y-1, floor at y, ceiling at y+1) driven into virgin rock, and a
hidden alcove with a chest at the end. No trigger and no map transition — the
alcove is part of the floor, so none of floor 0's `falseWalls` machinery is needed.

⛔ **It was not a secret.** Dungeon floors set `skipRoomClip`, so the whole tilemap
is drawn: the passage and its chest were fully visible, and the single disguised
tile in the doorway read as **a stray wall tile blocking an open corridor**. A bug
with treasure behind it.

Floor 0's secret corridors work because they are carved into the VOID fill —
surrounded by black, a corridor reads as hidden. A rock-slab floor has no void, so
the same trick hides nothing. The "easier case" conclusion was about the CARVE; I
never looked at the result.

**Done with the boulder switch** (v1.10.42) — floor 2's existing `rockSwitch`,
placed a second time on floors 1 and 3 rather than a new mechanic invented. A
sealed side chamber with a chest, and a rock somewhere in the floor that opens it.
~55% of seeds on each.

⛔ **The chamber is VISIBLE and walled, and that is the point.** Floor 2's puzzle
room has always been visible-and-sealed and reads correctly: you see the chamber,
you see it is walled, you go find the rock. The reverted version disguised a
doorway instead, and since the whole tilemap is drawn it just looked like a stray
wall tile blocking an open corridor.

Four things had to be verified rather than assumed, each found by a gate:
- ⛔ **the rock must not sit in the doorway** — the first version put it on the
  approach tile, so opening the wall left the rock itself blocking the way and the
  chamber stayed unreachable on every seed;
- ⛔ **the rock is impassable and permanent**, so on a corridor tile it severs the
  floor — it cut 30 tiles and the exit to the crystal room on one floor-3 seed;
- ⛔ **a chest is not walkable**, so a reachable-tile count cannot see one become
  unopenable — the rock landed beside a branch chest and took its only approach;
- ⛔ **on a `loop` floor the ring runs THROUGH a side room**, so excluding corridor
  tiles is not enough. The placement now cuts the loop's closing link and re-runs
  the same reachability test on top, which is exactly what the circuit gate does.

⛔ Also removed: the gate demanding a secret rate on floors 1-3. A rate demanded by
a gate is a rate something has to satisfy, and that pressure is what produced the
bad mechanism.

⛔ **A tunnel must start from a REACHABLE tile, not merely a FLOOR one**, and
⛔ **the reachability mask must traverse passages** — see the changelog for both;
each produced a silent, opposite-looking failure.

### 3c. The corridor system

**Seven implementations, three named, four inline:**

| # | what | where | shape |
|---|---|---|---|
| 1 | horizontal pathway | `carvePathway` | 3-row carve → 1 walkable |
| 2 | vertical pathway | `carveVerticalPathway` | **2 tiles wide**, straight |
| 3 | secret snake-detour | `carveCorridor` | void-only, see 3b |
| 4 | room-to-room neck | floor 0 inline | 5 rows tall, overhang eats to 1 |
| 5 | short H + V corridor | floors 1/2 inline | 3-row / 1-wide |
| 6 | long fattening spine | floor 3 inline | 1 wide + random 1-tile bulges, 2–4 rows |
| 7 | narrow side-room paths | floor 3 inline | 3-row carve |

(1) and (2) are only reachable from the dead `floorIndex >= 5` branch.

**The asymmetry is real and must be preserved, not smoothed away.** A horizontal
corridor is carved 3 rows tall and `addOverhang` eats the top 2 into rock,
leaving one walkable row — because rock hangs *below* a ceiling lip, so a
sideways passage needs headroom above it. A vertical corridor is simply 1–2
columns wide; no headroom problem. Any corridor module encodes this per axis. A
naive `carveLine(from, to)` that treats both axes the same produces either
floating rock or pinched ceiling, and `addOverhang` will fight it.

**Why our floors read as boxy** (§0) is mostly here: corridors are carved
axis-by-axis against literal coordinates, so they meet at right angles and run
dead straight. Floor 3's fattening spine is the only one that varies its width,
and it is the only corridor in the game that looks cave-like.

**Proposed:** one `carveLink(tilemap, from, to, spec)` with
`spec = { axis, width, jitter, kind }`, `kind ∈ { straight, fattening, neck,
secret }`, replacing all seven. Two things it must add that nothing does today:
**elbows** (an L or S route between chambers that are not axis-aligned) and
**width variation along the run**, which is what makes floor 3's spine the one
that works.

### 3d. Boss chambers

Today: `generateBossRoom` is handcrafted, byte-identical every seed (Jaccard
1.000 — correct for an authored room), tileset 2, with the crystal as a warp tile
at (6,5) in the north alcove.

For endless, per §4b, the boss chamber needs to be a **template picked by tier**
rather than one room — authored layouts, not procedurally generated, because a
boss arena is a fight space and should be designed. It carries two exits, both
armed on `battleSt.enemyDefeated`:

- the **warp tile** — leave the dungeon;
- a **`$70` door on the north wall** — descend to `depth + 1`.

The crystal room's warp already sits in the north alcove, so both exits share that
wall. `placeChamberDoor` already does north-wall doors for locked rooms — reuse
it rather than writing a second door placer.

Open: how many templates, and whether the tier boss is a fixed roster or drawn
from the depth band's encounter table. Monster tables are content work (§4b).

## 4. Plan

Five phases. Phases 1–2 change no output at all; the dungeon only starts looking
different in phase 3. That split is deliberate — a refactor and a behaviour
change in one commit means neither can be verified.

### Phase 1 — Extract the vocabulary (output must not change) ✅ DONE v1.10.22–25

New `src/dungeon/` leaf modules, no `window`/DOM, so tools can import them:

- `tiles.js` — the tile constants, currently duplicated between
  `dungeon-generator.js` and `dungeon-locked-room.js` (which re-declares its own
  `CHEST_TILE`, unused).
- `chambers.js` — `carveChamber(tilemap, spec)` where spec is
  `{ x, y, w, h, jitter, anchor }`. The four copies collapse into this. Plus the
  named roles as thin wrappers: `pondChamber`, `trapChamber`, `puzzleChamber`,
  `alcove`, `treasureChamber`.
- `corridors.js` — `carveCorridor(tilemap, from, to, spec)` covering the
  horizontal, vertical and fattening variants now written inline.
- `bossChamber.js` — the ONE boss-chamber shape (§4c), lifted out of
  `generateBossRoom` with the crystal pedestal removed from the layout and moved
  into the crystal skin. Takes a skin `{ donorMap, tileset, musicIn, musicOut }`.
- `shape.js` — the cleanup chain that every floor ends with
  (`fixDiagonalCeilingPinch` → `removeCeilingProtrusions` → `enforceMinCeilingGap`
  → `ensureCeilingConnectivity` → `addOverhang` → `sealTinyPockets`).

Delete the dead code in the same phase, and fix the `design-notes.md` entry that
describes `buildCaveShape` as live.

**Gate:** a refactor is only correct here if it is byte-identical. Add
`tools/check-floor-snapshot.mjs` — hash every floor's tilemap for a fixed seed
list, snapshot before, assert after. Phase 1 lands only when 5 floors × 400 seeds
hash identically.

### Phase 2 — A floor becomes a declaration ◐ STARTED v1.10.27

⛔ **The obvious design does not work.** "Describe the whole floor, then render
it" REORDERS THE RNG DRAWS and changes every floor: a floor draws from one seeded
stream, and today the draws that size a corridor are interleaved with the draws
that jitter a chamber's edges — chamber, corridor length, chamber, corridor
length. Build-then-render moves all the sizing draws in front of all the jitter
draws.

So the plan is **recorded while carving**: `planChamber` and friends carve
immediately and record what they carved. Byte-identical by construction, and the
plan is still a value you can print, diff, and — in phase 3 — generate rather
than transcribe. Turning it into a true build-then-render is a phase-3 change
that comes WITH the re-baseline, not before it.

Coverage is partial and says so. Floors 1 and 2 record every chamber
(`complete: true`); floor 0's shape is a traced ceiling snake and floor 3 still
carves its centre and side rooms inline, so theirs record part of the map.
`tools/check-floor-plan.mjs` pins that, and checks every recorded chamber's
footprint actually contains carved floor.

#### Original sketch (still the phase-3 target)

Replace the `if/else` with a spec per floor and one renderer:

```
FLOOR_SPECS[3] = {
  arrive: 'south',              // floor 2's stairs land the player at the bottom
  chambers: [
    { role: 'entrance' },
    { role: 'junction', count: [1, 2] },
    { role: 'pond' },
    { role: 'treasure', count: [1, 2] },
    { role: 'exit' },
  ],
  links: 'spine',               // topology, see phase 3
  budget: { chests: [3, 5], skeletons: [4, 6] },
}
```

`planLayout(rng, spec)` returns a graph of placed chambers and the links between
them; `renderLayout` carves it with the phase-1 primitives, then the shared tail
(loot, secrets, triggers, wiring) runs exactly as it does now. Still no output
change if the specs reproduce today's layouts — which is the phase-2 gate.

`arrive` is not decoration: floor 1's own comment notes it must be entered from
the top because floor 0's south-wall stairs put the player there. Inter-floor
continuity has to be an input to the planner, not an accident of constants.

### Phase 3 — Randomize the skeleton (the visible change) ◐ STARTED v1.10.29

Floor 3's anchors are sampled. Measured over 200 seeds:

| | before | after | limit |
|---|---|---|---|
| mean pairwise Jaccard | 0.749 | **0.282** | 0.40 |
| tiles walkable in >=90% of seeds | 85 | **3** | 15 |
| distinct entrance positions | 1 | **22** | 12 |

⛔ **Sample the geometry BEFORE the position.** The three rooms plus their two
gaps span `halfW + gap + sideW` either side of the spine; at the old fixed values
that is 13, so the layout filled columns 3..29 and `entranceX` could not move at
all without falling off the map. Rolling the widths first is what creates the room
for the position to vary — pinning `entranceX` alone would have achieved nothing.

The re-baseline moved **exactly one hash**: floors 0/1/2/4 and all three side maps
are byte-identical. `tools/check-floor-variety.mjs` is a deploy gate now, so this
cannot silently regress; it is phase 5's first invariant, pulled forward because
phase 3 is the change it exists to protect.

**Topology rolled per seed (v1.10.30).** Floor 3 now picks `row` (all three rooms
on one band, joined by straight runs — what it always did) or `stagger` (each side
room at its own height, reached by an **elbow**). Measured 103/97 across 200 seeds;
Jaccard fell further to **0.253**.

`carveElbow` is the corridor primitive nothing had: every link in the game ran
dead straight along one axis, which is much of why the floors read as drawn rather
than dug. Its two legs are deliberately asymmetric — a 3-row horizontal band and a
1-column vertical — per §3c.

⛔ **Staggering exposed four places that took a side room's COLUMNS but the CENTRE
room's ROWS**: the pond (both orientations), the chest bounds inside the pond room,
the bone scatter in the other side room, and the locked-room door row. Harmless
while all three rooms shared a band; wrong the moment they do not, and they showed
up as sealed pockets and an unreachable exit rather than as anything that looked
like a row bug. The gates caught all of it.

**Four topologies (v1.10.32).** `row`, `stagger`, `loop` and `hub`, distributed
49/52/54/45 across 200 seeds. `loop` runs one branch under a side room and up into
it, so the floor is a **circuit**; `hub` adds a fourth room due north of the
centre, giving the centre four spokes.

⛔ **"There is an extra link" is not "you can go around".** `check-floor-plan` cuts
the loop's closing link and re-floods: if anything is stranded, the link was the
only path and the topology name is a lie. 40/40 loop seeds are genuine circuits.
Proven by removing the ordinary elbow on that side — half the seeds stop being
circuits and the gate fires.

Floor 3 walkable area rose 126 → 134; `hub` adds a room and `loop` adds a link.

**Contour irregularity (v1.10.34) — DONE, and measurable.** `addOverhang` lays
exactly two rocky rows under every ceiling, giving each room a straight dark lid.
Measured as the share of adjacent band-tops that sit level:

| | floors 1 / 2 / 3 | ROM caves (22, 113, 115) |
|---|---|---|
| before | 70% / 61% / 79% | 42–63% |
| after | **46% / 44% / 48%** | 42–63% |

`roughenOverhang` grows the band **upward into the rock**, never downward:
extending it down converts FLOOR to WALL_ROCKY and shrinks every room by a row,
and the rooms are carved assuming the overhang eats exactly two. Growing up costs
no walkable area and keeps both wall invariants. It only fires where the ceiling
above is at least three rows thick, which confines it to slab interiors and leaves
floor 0's single-tile snake lip untouched.

⛔ **Not floor 4.** The crystal chamber is authored. The first attempt roughened
it too, and the snapshot caught it — floor 4's hash is the one that should never
move for a procedural reason.

This is the number that actually separated our look from the cartridge's. Two
earlier attempts at measuring "boxiness" (§0) did not discriminate at all — one
scored ROM map 115 *boxier* than our floor 3.

**Floors 1 and 2 topologies (v1.10.35) — DONE.** Both built the same L: two rooms
on one row, then a drop to the chamber. They now roll `chain` (that) or `zigzag`
(the mid room at its own height, reached by an elbow), ~50/50. Jaccard fell to
**0.189** and **0.130**, with zero fixed tiles on either.

⛔ **A symmetric offset with a clamp is not symmetric.** Floor 1's first version
offset the mid room either way and clamped to rows 6..11; its entrance row is 7,
so every upward roll hit the clamp and produced a ONE-row step — 91 of 205
zigzags sat at row 6 against 51 and 63 at rows 9 and 10. Nearly half barely
zigzagged, and the topology counts looked perfectly healthy throughout. Downward
only now, which is also the only direction with room: floor 0's south stairs land
the player at floor 1's top.

**Floor 2's entrance (v1.10.36) — DONE.** `entranceX` was the literal 15 and
`startFloorY` one of two values, so the floor had exactly TWO entrance positions
however many seeds you ran. Both sampled: **2 → 82 distinct positions**, feature
rates unmoved (secret 53%, locked 50%).

⛔ **The corridor still has to be aimed at the middle.** Everything chains off the
entrance in `horizDir` — corridor, 5×5 room, 7×7 chamber, then the exit path
doubling back — about fifteen columns. A randomly chosen direction runs half the
seeds off the map. Floor 1 already had this rule; floor 2 needed it once its
entrance could move.

### Phase 3 is complete

| floor | Jaccard | fixed tiles | entrances | secrets | topologies | band contour |
|---|---|---|---|---|---|---|
| 0 | 0.408 | 24 | 10 | 53% | — | (snake) |
| 1 | 0.189 | 0 | 23 | 46% | 2 | 46% |
| 2 | 0.148 | 0 | 82 | 53% | 2 | 43% |
| 3 | 0.259 | 6 | 22 | 57% | 4 | 47% |
| 4 | authored — exempt from every variety measure |

Remaining across the whole plan: phase 4 (migrate floors onto the spec/renderer)
and phase 5 (the rest of the anti-cloning gates, most of which landed early
because phase 3 needed them).

#### Original plan

This is where floor 3 stops being one map:

- **Anchors are sampled, not constants.** Chamber positions come from a
  poisson-ish scatter inside the usable grid with a minimum separation, instead
  of `entranceX = 16` / `roomCenterY = 9`.
- **Topology is rolled per seed.** `spine` (today's corridor-with-rooms),
  `loop` (a circuit — you can come back a different way), `hub` (central chamber
  with spokes), `branch` (dead ends holding the treasure). Floor 3 currently only
  ever produces `spine`.
- **Chamber size and count are ranges**, so a floor can be 3 fat chambers or 6
  small ones.
- **Roles get placed by constraint, not position** — "the pond chamber is not the
  entrance chamber", "the exit is the graph-farthest chamber from the entrance",
  "at most one puzzle chamber". This is what lets a boss/pond/secret chamber
  appear on a floor it does not currently appear on, which is the actual ask.
- **Use more of the grid.** Target ~200 walkable tiles rather than 84–126.
- **Rock-tunnelling secret corridors** (§3b) — the prerequisite for secret rooms
  anywhere but floor 0. Schedule it here, not with the chamber pool.
- **Chambers stop being floor-locked.** With endless dropped (§4b) the pool
  applies to Altar Cave's own five floors: a pond, a boulder switch or a locked
  room becomes something a floor can roll rather than something one floor owns.
  Set the weights from the measured rates in §3a, not from the guesses that were
  drafted before those rates existed.
- **Contour irregularity**, per §0 — the overhang band should follow the floor's
  edge rather than bound it as a rectangle, and corridors should change width and
  direction along their length. This is the visual half of the ask and it is
  judged by looking (`floor-png.mjs` beside `map-png.mjs`), not by a metric.

### Phase 4 — Migrate the floors

Order: **floor 3 first** (worst measured, and its bespoke code is the most
mechanical), then floor 1 (already a copy of floor 2, so it should mostly
evaporate), then floor 2 (hardest — the rock-switch wiring is coupled to
positions), then floor 0 (the two-room ceiling snake is genuinely bespoke and may
stay a custom spec). **Floor 4 stays handcrafted** — a boss room should be
authored.

Each floor migrates as its own release, so a regression is attributable.

### Phase 5 — Make cloning a test failure

Extend `dungeon-sweep.mjs` with variety invariants alongside the correctness ones
it now has, so this cannot silently come back:

- mean pairwise Jaccard **below a ceiling** per floor (floor 3: 0.727 → target
  < 0.35, i.e. floor 1's current level);
- exits stay checked from the ENGINE'S WIRING, never from a tile guess — see the
  `exitAudit` note in §5;
- **distinct entrance positions ≥ N** over the sweep (floor 3 is at 1);
- tiles walkable in ≥90% of seeds **below a ceiling** (floor 3: 85 → target < 20);
- chamber-count and topology histograms non-degenerate.

Set each threshold from the measurement after phase 3, and prove it the usual way
— pin a floor's layout to a constant and confirm the gate fails.

## 4b. Endless dungeon — DROPPED

Considered and **dropped 2026-08-20**, same day it was drafted. What survives of
it is one line: **the boss chamber's warp out is gated on beating the boss.**

Do not re-propose the endless dungeon without a fresh decision. What it would
have needed is recorded here so the cost is not rediscovered:

- its own map range (`2000 + depth * 10 + kind`) and a second dispatch path;
- eight integration points that key off the Altar Cave range, **two of which fail
  silently** — `inDungeon = dungeonFloor >= 0 && dungeonFloor < 4` stops random
  encounters dead past depth 3, and `_resolvedChestPool` has no pool for a new
  range so the server rejects every chest claim;
- depth-banded monster tables, which are content work — `ENCOUNTERS` has four
  Altar Cave tables and nothing beyond;
- **a stake.** Loot banks the moment you pick it up (only *position* writes are
  overworld-only) and death is a full HP/MP restore at `ps.lastTown` with no gil,
  item or progress loss. "Go deeper or cash out" was not a decision, because
  nothing could be lost either way. That gap is unchanged and would have to be
  designed before any push-your-luck loop means anything.

### What shipped instead — the warp is gated (v1.10.19)

⛔ **The boss does not block the way to the warp, and never did.** Flooding the
generated crystal room with the real `MapRenderer.isPassable` and the Land
Turtle's tile (6,8) treated as solid still reaches the warp at (6,5) — **71 tiles
against 72**, losing only the turtle's own tile. The player could walk around the
boss and warp straight out. `_checkWarpTile` had no `enemyDefeated` check of any
kind; positional blocking was assumed.

`_checkWarpTile` now returns false until `battleSt.enemyDefeated`. Before the
boss is beaten the tile is inert and the player walks over it — no message, since
there is no written line for it and inventing one is content.

`tools/check-boss-warp.mjs` is a deploy gate. It drives a **real step** onto the
warp tile through `startMove` / `updateMovement` and watches for
`mapSt.starEffect`, rather than grepping the source for the guard — a grep would
pass on a comment. It also re-asserts the reachability fact, so if the room is
ever reshaped to make the boss a genuine chokepoint, the check says so instead of
silently protecting nothing.

## 4c. Boss chambers — one shape, per-dungeon skins, two ending kinds

Decided 2026-08-20. Altar Cave is a **crystal dungeon** — it ends in a crystal
room with a crystal and job unlocks. The Cave of Seals is a **regular dungeon** —
just a boss at the end, and its boss room must NOT use the crystal room's
palettes or change the music.

Today those are the same code path. `generateBossRoom` is not a boss chamber; it
is *the crystal room*, and eight things key off `floorIndex === 4` or "a boss
died":

| # | coupling | where |
|---|---|---|
| 1 | tileset 2 + map-148 CHR / palettes | `assets = floorIndex === 4 ? loadCrystalAssets(…)` |
| 2 | `tileset: floorIndex === 4 ? 2 : 0` | returned mapData |
| 3 | **crystal pedestal baked into the layout** (`$3a`–`$3f`, rows 8–10) | `generateBossRoom`'s tile list |
| 4 | `TRACKS.CRYSTAL_ROOM` on entry | `map-loading.js` |
| 5 | `TRACKS.CRYSTAL_CAVE` on exit | `map-triggers.js` ×2 |
| 6 | turtle → `addCrystalNpc(6,8)` after defeat | `map-loading.js` |
| 7 | warp tile at the pedestal top | `generateBossRoom` (defeat-gated, v1.10.19) |
| 8 | **`startCrystalReveal()` + `ps.unlockedJobs \|= 0x3E`** | `battle-update.js` `_updateBossDissolve` |

⛔ **#8 is not dressing.** `_updateBossDissolve` is the GENERIC boss-death
handler — `battle-update.js`, `battle-ally.js` and `spell-cast.js` all route any
non-random, non-PVP kill into `'boss-dissolve'`. It then unconditionally plays
the crystal reveal and unlocks the five Wind Crystal jobs. A Cave of Seals boss
dropped in as-is would dissolve into a Wind Crystal and re-unlock Warrior / Monk
/ White / Black / Red.

### The split — ONE shape, many skins

Revised 2026-08-20 (this replaces an earlier "authored templates picked by ending
kind", which had several shapes — wrong).

**There is ONE boss chamber shape.** It is modularized and used by every dungeon.
What varies per dungeon is a **skin**. The crystal room stops being a bespoke room
of its own: it is the boss chamber wearing crystal dressing, which is what gets us
away from ending every dungeon in the same crystal room.

A skin is four fields, and three of them are already driven by a single thing the
code calls the **donor ROM map** — the map we borrow CHR, palettes and the battle
background from. It just is not a table yet:

| skin field | today | spelled as |
|---|---|---|
| CHR + palettes | map 111 cave, map 148 crystal | `REF_MAP_ID = 111`, `CRYSTAL_MAP_ID = 148`, chosen by `floorIndex === 4 ? loadCrystalAssets(…) : loadRomAssets(…)` |
| tileset id | 0 cave, 2 crystal | `tileset: floorIndex === 4 ? 2 : 0` |
| battle background | from the donor map's ROM lookup | `romMap = (mapId === 1004) ? 148 : 111` then `BATTLE_BG_MAP_LOOKUP + romMap` |
| music | `CRYSTAL_ROOM` in, `CRYSTAL_CAVE` out | `map-loading.js`, `map-triggers.js` ×2 |

So: `{ donorMap, tileset, musicIn, musicOut }` per dungeon, replacing four
hardcoded ternaries on `floorIndex === 4` / `mapId === 1004`.

- **Altar Cave** → donor 148, tileset 2, crystal music.
- **Cave of Seals** → its own donor map, tileset 0, cave music. **No crystal
  palettes, no music change.**

### ✅ Done (v1.10.24) — and the shape IS tileset-neutral, verified by looking

`src/dungeon/boss-chamber.js` holds the one shape; `generateBossRoom` delegates.
Byte-identical: the pedestal moved into `CRYSTAL_SKIN.decorate`, which stamps it
back over the shape, so Altar Cave's room is unchanged.

Both halves were then RENDERED with the cave assets
(`floor-png.mjs --boss cave|crystal`), because the shape's tile ids were
transcribed from ROM map 148 in tileset 2 and nothing said they meant the same
in tileset 0:

- **cave skin + cave assets** — reads as a proper cave chamber. `$01`/`$02` are
  the rock band in both tilesets, the overhang lands correctly, `$42`/`$6b` still
  draw the entrance arch and staircase, and there is plain floor where the altar
  would be. The shape survives a skin it was not drawn for.
- **crystal skin + cave assets** — the pedestal renders as a **flat yellow slab**.
  `$3a`–`$3f` depict an altar only in tileset 2. This is the artifact the split
  exists to prevent, and it is now a picture rather than an argument.

### ⛔ Why the crystal pedestal cannot be in the shape

`generateBossRoom` bakes the pedestal into its tile list — tiles `$3a`–`$3f` at
rows 8–10, cols 5–7. Those ids only depict a crystal altar **in tileset 2**. Leave
them in the shared shape and the Cave of Seals gets a crystal pedestal rendered in
cave tiles: whatever `$3a`–`$3f` happen to be in tileset 0.

The pedestal therefore moves **out of the layout and into the crystal skin**, as
decoration the skin stamps onto the shared shape. This is the concrete work item
that "one shape" creates, and it must happen before a second dungeon exists.

### ✅ Done (v1.10.26) — ending kind is split out

`src/data/dungeons.js` holds it: `endingKindFor(mapId)` returns `crystal` for
Altar Cave's chamber (1004) and `boss` for everything else, **defaulting to
`boss`** for maps it has never heard of. The default is the whole point — the old
code defaulted the other way and handed a Wind Crystal to any boss that died.

Gated on it: `startCrystalReveal()` and `ps.unlockedJobs |= WIND_CRYSTAL_JOBS` in
`_updateBossDissolve`, and the standing crystal NPC in `map-loading.js`. In a
regular dungeon the boss is simply gone once beaten — nothing stands in its place.

⛔ **The dissolve stays generic.** Every boss dissolves; that is the death
animation, not a crystal thing. The boss-NPC placement is likewise ungated —
every boss chamber has a boss.

`tools/check-dungeon-ending.mjs` is a deploy gate, proven on both a flipped
default and a job mask granted from a literal outside the gate.

### Skin is not ending kind — keep them separate

Two independent axes, and conflating them is how we got here:

- **Skin** (tiles, palettes, music, battle background) — what the room looks and
  sounds like. Every dungeon has one.
- **Ending kind** (`crystal` | `boss`) — what beating the boss *does*. The crystal
  NPC, `startCrystalReveal()` and `ps.unlockedJobs |= 0x3E` belong here, not to
  the skin. A dungeon could in principle wear crystal tiles without granting a
  crystal; nothing should assume otherwise.

### Done — the boss id has one home (v1.10.20)

`MONSTERS.get(0xCC)` was written out in **seven modules**: `boot.js` (sprite
load), `battle-state.js` (`BOSS_ATK` / `BOSS_DEF` / `BOSS_MAX_HP`),
`battle-update.js` (victory rewards), `pvp.js`, `input-handler.js` and
`loading-screen.js`. `pvp.js` and `input-handler.js` re-derived atk and def that
`battle-state.js` already exports.

It now lives in `src/data/bosses.js` as `DEFAULT_BOSS_ID` — a hand-maintained
leaf with no imports, so there is no cycle (`battle-state.js` imports `pvp.js`,
so `pvp.js` cannot import back). **Not in `data/monsters.js`**, which is
auto-generated and overwritten wholesale.

The victory-reward path reads `battleSt.bossId ?? DEFAULT_BOSS_ID` instead of a
literal. That read was correct only because the Land Turtle is the game's one
non-random encounter — a second boss would have paid out Land Turtle exp, gil and
cp regardless of what died. Gated by `tools/check-boss-id.mjs`.

## 5. Risks

- ⛔ **Never identify an exit by its tile.** The v1.10.15 sweep looked for the
  first `$73` staircase and asserted it was reachable. Floors 1 / 2 / 4 have no
  `$73` at all (trap holes, a rock-switch passage, a boss chamber) and were
  silently skipped; floor 3's exit is a **door `$70`** and its only `$73` is the
  **entrance**, so the check asserted that the tile the flood starts from is
  reachable. It did real work on floor 0 alone. `exitAudit` now walks
  `dungeonDestinations`, which is what `_checkDynType1` / `_checkDynType4` read.
  Any new chamber type must register its way out there, not as a tile convention.
- ⛔ **A fallback must not overwrite an explicit wiring.** Finding the above
  turned up a live sequence break: the tail loop wired every type-1 trigger to
  the next floor, clobbering floor 3's own `dungeonDestinations.set('1:1',
  { goBack: true })` two lines after the floor branch wrote it. Floor 3's
  entrance staircase is a type-1 trigger, and `disabledTrigger` suppresses the
  tile you arrive on only until you step OFF it, so stepping off the stairs and
  back on warped the player straight to the crystal room — skipping the whole
  floor onto the boss, on every seed. Fixed in v1.10.16; the planner must keep
  this ordering (branch wiring wins, fallback fills gaps).


- **The ceiling/overhang invariants are fragile.** Every chamber primitive has to
  leave a continuous ceiling snake and satisfy the overhang rules; floor 0's
  "one continuous ceiling snake" was a hard-won fix and is the likeliest thing to
  break. It gets its own check in phase 1.
- **Position-coupled wiring**: the rock switch, the secret path (restricted to
  outer columns 3–7 / 24–29 so it cannot cut the centre neck), locked-room doors,
  and `openEntranceLanding` all assume things about where chambers are. Each
  needs to become a constraint the planner honours rather than an assumption.
- **The generator is seeded with `Date.now()` per cave entry**, so anything that
  ships broken hits a fraction of players unreproducibly. The v1.10.15 deploy gate
  (`dungeon-sweep.mjs 400`) is the safety net and should be raised, not relaxed,
  during this work.
- **Scope**: phases 1–2 are refactors with a byte-identical gate and are safe to
  do in one pass. Phase 3 onward changes what players see and should ship one
  floor at a time.
