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

## 3. The chamber types are already in there, unnamed

They exist as code but not as a vocabulary, which is why they can't be composed:

| role | today | where |
|---|---|---|
| boss chamber | `generateBossRoom` | its own function ✅ |
| pond chamber | `placePond` + inline water lines | helper + 60 inline lines in floor 3 |
| locked chamber | `placeLockedRoom`, maps 1010/1011 | `dungeon-locked-room.js` ✅ |
| secret chamber | `generateSecretRoomMap` | its own function ✅ |
| rock-puzzle chamber | inline | floor 2 |
| trap chamber | inline 7×7 | floor 1 |
| branch alcove | inline | floor 3 |
| entrance / junction / exit room | inline ×4 | floors 0–3 |

Three already are modules. The plan is to finish the set.

---

## 4. Plan

Five phases. Phases 1–2 change no output at all; the dungeon only starts looking
different in phase 3. That split is deliberate — a refactor and a behaviour
change in one commit means neither can be verified.

### Phase 1 — Extract the vocabulary (output must not change)

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
- `shape.js` — the cleanup chain that every floor ends with
  (`fixDiagonalCeilingPinch` → `removeCeilingProtrusions` → `enforceMinCeilingGap`
  → `ensureCeilingConnectivity` → `addOverhang` → `sealTinyPockets`).

Delete the dead code in the same phase, and fix the `design-notes.md` entry that
describes `buildCaveShape` as live.

**Gate:** a refactor is only correct here if it is byte-identical. Add
`tools/check-floor-snapshot.mjs` — hash every floor's tilemap for a fixed seed
list, snapshot before, assert after. Phase 1 lands only when 5 floors × 400 seeds
hash identically.

### Phase 2 — A floor becomes a declaration

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

### Phase 3 — Randomize the skeleton (the visible change)

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

## 4b. The endless dungeon (its own map range)

Decided 2026-08-20: the roguelike lives in a **separate dungeon with its own map
range**, not in Altar Cave. Altar Cave keeps its five authored floors and its
place in the story. Beating a depth's boss offers a choice — **warp out**, or take
a **doorway on the north wall of the boss chamber** and go deeper.

### Map ids

Altar Cave holds 1000–1004, locked rooms 1010/1011, secret rooms 1020/1021.
Proposed for endless, decodable in one line each:

```
ENDLESS_BASE = 2000
mapId  = 2000 + depth * 10 + kind      // kind 0 floor, 1 locked, 2 secret, 3 boss
depth  = ((mapId - 2000) / 10) | 0
kind   = (mapId - 2000) % 10           // 6 kinds spare
```

Depth 0–999 occupies 2000–11999 and collides with nothing. It keeps the engine's
existing model — one generated map per id, `dungeonDestinations` carrying
`{ mapId }`, `loadMapById` regenerating — rather than introducing a second one.

### The boss chamber's two exits

Both armed only once `battleSt.enemyDefeated` — the crystal room already gates its
boss sprite on exactly that flag (`map-loading.js`), so the pattern exists.

- **Warp tile** — leave the dungeon, land back on the overworld.
- **North-wall door (`$70`)** — descend to `depth + 1`.

The current boss room's warp already sits at (6,5), the north alcove of the
chamber, so the door goes on the same wall beside it.

### What must change — measured, not guessed

Each of these keys off the Altar Cave range and will silently misbehave for a new
one:

| site | what breaks |
|---|---|
| `battle-encounter.js` `inDungeon = dungeonFloor >= 0 && dungeonFloor < 4` | **random encounters stop dead past depth 3** — the dungeon goes quiet, no error |
| `battle-encounter.js` `['altar_cave_f1'..'f4'][dungeonFloor]` | every depth ≥ 4 falls back to the *floor-1* table |
| `economy-arbiter.js` `_resolvedChestPool(mapId)` | no pool for the new range → the server **rejects every chest claim** |
| `map-loading.js` `romMap = (mapId === 1004) ? 148 : 111` | asset donor picked by hardcoded id |
| `map-triggers.js` music `>= 1000 && < 1004` | wrong track |
| `map-triggers.js` `exitingCrystalRoom = currentMapId === 1004` | exit handling |
| `roster.js` `cave-N` / `crystal` labels | other players see no location |
| `map-triggers.js` consumedTiles wipe `>= 1000` | **already covers it** ✅ (per the save-model rule, as long as the seed regenerates per run) |

### ⛔ The choice has no stake yet — this is a design decision, not mine

"Warp out or go deeper" is only a decision if going deeper can cost something.
Measured, today it cannot:

- **Loot banks the moment you pick it up.** Only *position* writes are
  overworld-only (`setPositionGetter` returns null off the overworld);
  inventory, gil, HP and stats persist from anywhere, dungeon included.
- **Death is free.** `ps.hp <= 0` → Game Over → `respawnFromGameOver()` →
  `_respawnAtLastTown()`, full HP/MP restore. No gil loss, no item loss, no
  progress loss — the cost is the walk back.

So as it stands you would keep everything either way and the doorway is a
convenience, not a gamble. Three ways to give it teeth, in ascending harshness —
**pick one before building the boss chamber**, because it changes what the room
has to do:

1. **Depth loot escrows.** Chests below depth 1 go to a run bag that only merges
   into `ps` on warp-out. Death loses the bag, keeps everything you owned before.
2. **Death drops the run.** Loot banks normally, but dying inside endless returns
   you empty-handed from that run.
3. **No stake — it is a depth chase.** The reward is the record and the tables;
   warp-out is pure convenience.

(1) is the classic roguelike shape and needs the least new machinery — a bag that
merges or is discarded. (3) is honest and cheapest, and can become (1) later.

### Chamber pool — weights and depth bands

Once phase 1 makes chambers modules and phase 2 makes a floor a declaration, an
endless floor is a draw from this pool. Everything below is built from mechanics
already in the repo; nothing here needs new art.

| chamber | weight | first depth | max/floor | built from |
|---|---|---|---|---|
| junction | 40 | 0 | — | inline room carve (phase 1 `carveChamber`) |
| treasure | 25 | 0 | 2 | `scatterRoomLoot` + `findCornerFloor` |
| bone pit | 15 | 1 | 1 | `BONES` density + per-zone encounter rate |
| pond / spring | 12 | 2 | 1 | **`placePond` — already written, `ponds: 0` everywhere so it never runs** |
| rubble | 12 | 2 | 2 | `WALL_ROCKY` as in-room obstacles |
| trap chamber | 10 | 3 | 1 | floor 1's hidden `$74` holes |
| boulder-switch | 8 | 4 | 1 | `rockSwitch {rocks, wallTiles}` from floor 2 |
| mimic chamber | 8 | 4 | 1 | `loot-pools.js` already ships `{ weight: 12, monster: true }` |
| secret chamber | 6 | 5 | 1 | `placeSecretPath` + `$44`, currently floor-0-only |
| locked chamber | 5 | 6 | 1 | **`placeLockedRoom` — already written, imported, never called** |
| boss chamber | — | every Nth | 1 | `generateBossRoom` |

Two of those are switched-on-by-deletion: `placePond` and `placeLockedRoom` are
finished code that nothing reaches. They are the cheapest content in the plan.

**Monster tables are content, not generator work.** `ENCOUNTERS` has four Altar
Cave tables. Depth bands should reuse them (1–4), and beyond that the deepest
band repeats until new tables are authored. Say so in the UI rather than
pretending the difficulty curve continues.

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
