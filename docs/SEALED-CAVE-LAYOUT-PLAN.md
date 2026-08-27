# Cave of Seals — make it its own cave

> ## ✅ PHASES 1 AND 3 SHIPPED IN v1.10.96
>
> The `layout` block, the per-dungeon gates and the `boulder-chamber` floor are
> **live**. What §5 describes as a many-vein room was cut down to what Joel
> actually asked for: **one boulder, one false wall, one small exit chamber** —
> the shipped `rock-switch` chamber grafted onto floor 1 with the traps removed.
> The multi-switch version in §5 is NOT built and was not ordered.
>
> **§4 (longer corridors) shipped in v1.10.97** — and it fixed the walk-around
> below as a side effect (seals 69/400 -> 0/400), proven causally by reverting.
> **v1.10.98** gave floor 0 its own sampling and removed the dead secret
> corridors the Cave of Seals was carving on 54% of its entry-floor seeds.
>
> **Still open:** the seals player meets a boulder on f1 and another on f2, back
> to back. Altar Cave keeps the 17% walk-around — **measured as pre-existing**
> (69/400 on the pre-arc tree at `0ef1db64`), pinned at a ceiling, not fixed,
> because fixing it changes Altar Cave's maps.

**Status: PLAN. Phases 1 and 3 are now shipped — see the banner above.** Joel, 2026-08-26: *"we gotta make sealed
cave a little different. corridors need to be longer. trap room needs to be
turned into a giant puzzle boulder room."*

Two asks. Neither can be done without first fixing the reason the cave is a clone
in the first place, so that is §2.

---

## 1. What ships today — MEASURED

200 timestamp-style seeds per floor, generated through the **seals** registry row
(`DUNGEONS[1]`), counted off the returned tilemap. Not read off `FLOOR_CONFIG`.

| | f0 | f1 — trap room | f2 — rock switch |
|---|---|---|---|
| walkable tiles | 118 | 86 | 103 |
| of which 1-wide corridor | 37 | 30 | 34 |
| footprint used, of 32×32 | 24 × 22 | **14 × 21** | **15 × 17** |
| entrance → exit, BFS steps | 32 | 29 | **13** |
| H corridor (elbow) steps | — | 4–6 | 4–6 |
| V corridor steps | — | 5–7 | 5–7 |
| chests | 3.0 | 5.8 | 3.5 |
| trap holes | 0 | 3.1 | 0 |
| rocks | 0 | 0 | 2.0 |

Three numbers carry the whole plan:

- **Corridors are 4–6 and 5–7 steps.** After the overhang eats the band, the
  player walks a *four-tile* neck between rooms. That is the "short corridor"
  feeling, and it is four literals in two branches.
- **The floors use 14 and 15 of 32 columns.** There is no space problem. Roughly
  half the map is unused rock on both floors.
- **f2's exit is 13 steps from its entrance** while its farthest corner is 24.
  The last floor before the Djinn is the shortest walk in the dungeon.

### Tooling note

`tools/floor-png.mjs` grew a **`--dungeon <id>`** flag while writing this. Without
it every render used Altar Cave's donor map (111) no matter which dungeon you
meant, and the Cave of Seals draws from 103 — same shape, different palette.
Looking at the wrong one is how a claim about the seals chamber gets made about
Altar Cave.

    node tools/floor-png.mjs 2 1754900000000 /tmp/f2.png --dungeon seals --scale 4

Every picture and every number in this document came through that flag.

## 2. ⛔ THE BLOCKER — LAYOUTS ARE DUNGEON-BLIND

`_generateFloor(romData, floorIndex, seed, dungeon)` takes the dungeon row and
**never consults it for layout**. Every branch is `else if (floorIndex === N)`.
`dungeon` is read for assets, mapIds, boss skin and locked rooms — never for
shape.

So the Cave of Seals' three floors are byte-identical in shape to Altar Cave's
first three, for the same seed. Editing floor 1's branch to lengthen a corridor
lengthens **Altar Cave's** corridor too.

This is the same shape as the fourteen-axes problem the dungeon registry was
built to end (`data/dungeons.js` header). The fix is the same: **a registry
keyed by data.**

### Three more things that have to be true first

**2a. The trap holes ARE the descent.** Floor 1 has no stairs. `hiddenTraps` +
`dungeonDestinations` wire the fall to floor 2 through `_checkHiddenTrap`
(`map-triggers.js:491`). Remove the trap chamber and floor 1 has no exit.
Whatever replaces it must carry the descent.

**2b. THE BOULDER-TRIGGERS-A-WALL CHAMBER ALREADY SHIPS.** It is floor 2, and it
is the thing to build on — not something to replace.

Rendered from the seals row, `floor 2 seed 1754900000000`, with the rock (`R`)
and the false wall (`W`) marked from `result.rockSwitch`:

```
14 ########%%%.%######%%%E#########      R = boulder ($0B)
15 ########%%%.%######%%%e#########      W = false wall (renders as solid rock)
16 ########C....%%%W%%R..,#########      E = exit block down to the boss floor
17 ########,....%%%W%%....%########
18 ########......,.W......%########      rocks:     (14,21) (19,16)
19 #########......####.,...########      wallTiles: (16,16) (16,17) (16,18)
20 #########......#####...C########
21 #########.,...R#################
22 #########C....##################
```

You stand in the 7×7 room on the left. The way on is a three-tile vein of rock at
x=16 that **looks exactly like every other rock tile on the map**. Touch the
boulder at (14,21): `handleRockPuzzle()` (`map-triggers.js:317`) plays
`SFX.EARTHQUAKE`, shakes the screen, then swaps those three tiles to floor with
`SFX.DOOR`. The corridor opens into the exit chamber. The second boulder, in the
exit room, opens the same wall from the far side for the return trip.

⭐ **The open state persists.** `_consumeTile` writes to
`ps.consumedTiles[mapId]`, and the expiry pass explicitly exempts rock puzzles:
*"secret walls / rock puzzles never expire."* A dungeon run holds one
`dungeonSeed` (`map-triggers.js:455`), so a wall you opened stays open while you
walk down to the boss and back.

Nothing **pushes** — `grep -rniE '\bpush(able|Block|Rock|Boulder)\b|sokoban' src/`
returns nothing, and it does not need to. The room is a boulder puzzle already;
the ask is to make it a **big** one.

**2c. The dungeon gates run Altar Cave only.** `check-floor-snapshot`,
`check-floor-variety`, `check-floor-plan` and `dungeon-sweep` all call
`generateFloor` with the default dungeon. The string `seals` appears in none of
them. The Cave of Seals' layout is currently **ungated** — which is why this plan
adds it in phase 1 and not at the end.

---

## 3. Phase 1 — a `layout` block on the dungeon row

Data only. No output change for either dungeon; the snapshot must stay green
**without `--update`**, and that is the phase's whole acceptance test.

```js
// data/dungeons.js — altar
layout: {
  floors: ['snake', 'trap-descent', 'rock-switch', 'spine'],
  corridor: { hMin: 4, hMax: 6, vMin: 5, vMax: 7 },
},
// seals
layout: {
  floors: ['snake', 'boulder-room', 'rock-switch'],
  corridor: { hMin: 8, hMax: 12, vMin: 9, vMax: 13 },
},
```

The branch becomes `switch (dungeon.layout.floors[floorIndex])`, not
`floorIndex === N`. Altar declares exactly what it draws today, so it carves the
same map from the same seed.

> ⛔ **RNG CALL ORDER IS THE CONTRACT.** `dungeon/plan.js` and `chambers.js` both
> say so, and it has bitten this generator before. Reading a bound out of a
> config object draws nothing, so lengths stay identical — but any *new* `rng()`
> call inserted before an existing one re-rolls every floor below it. New draws
> go at the END of a branch. Proof is `check-floor-snapshot.mjs` passing
> untouched, not inspection.

**Also in phase 1:** extend `check-floor-snapshot`, `check-floor-variety` and
`dungeon-sweep` to walk **every row in `DUNGEONS`**, not the default. Baseline
the seals rows before changing anything, so phases 2 and 3 have something to
fail against.

**Also in phase 1 (one line, unrelated):** `deploy.sh:270-278` still carries the
retracted "`seals_f3` is a loot table for a floor that places no chests" note.
Every floor places chests — measured, `seals f0=3.2 f1=6.0 f2=3.6`. The docs were
corrected in v1.10.95; that comment was missed.

## 4. Phase 2 — longer corridors, Cave of Seals only

Five literals become the `corridor` block:

| where | today | seals |
|---|---|---|
| `dungeon-generator.js:1376` f1 H elbow | `4 + rng()*3` | `hMin..hMax` = 8–12 |
| `dungeon-generator.js:1388` f1 V run | `5 + rng()*3` | `vMin..vMax` = 9–13 |
| `dungeon-generator.js:1510` f2 H elbow | `4 + rng()*3` | 8–12 |
| `dungeon-generator.js:1521` f2 V run | `5 + rng()*3` | 9–13 |
| `dungeon-generator.js:1539` f2 Z exit path | `4 + rng()*3` | 8–12 |

**Five literals, not four.** Floor 2's doubling-back exit path is a corridor too,
and it is the one the false wall sits in the middle of — lengthening it moves the
wall further from both rooms, which is the point.

Roughly **doubles the neck between rooms**, and takes floor 1's entrance→exit
walk from 29 steps to an estimated 45–50. The 14-column footprint says the space
is there; the estimate still gets measured, not assumed.

Three things to check by running it, because each fails **silently**:

1. **`carveHRun` breaks at `xMin`/`xMax`.** A corridor that runs off the map is
   simply shorter — no error. Longer corridors make that reachable for the first
   time. Gate: measured length must match requested length.
2. **The chain compounds.** Floor 2's own comment records that a *two-row* mid-room
   offset was clean across five seed bases and *three* rows failed on three of
   them — the chain from entrance through corridor, 5×5, drop, 7×7 and the
   doubling-back exit path is long and every link is positioned off the last.
   Doubling the corridors stresses exactly that chain. Expect to widen the
   entrance sampling window, and expect `generateFloor`'s 10-attempt retry loop
   to start earning its keep.
3. **`check-floor-variety`'s contour thresholds move.** More corridor as a share
   of walkable tiles changes the band-flatness number the gate pins. Re-pin from
   the measurement, per-dungeon, and say so in the changelog.

**New gate:** corridor length per dungeon, asserted from the plan's recorded
links against the row's declared bounds. "Longer" becomes a checked claim.

## 5. Phase 3 — the giant boulder room

**Built out of the chamber in §2b, scaled up.** Not a new mechanic. Replaces
floor 1's 7×7 trap chamber with a wide chamber — 11–13 across against today's 7,
in a floor that uses 14 of 32 columns — **segmented by veins of false wall**, each
vein opened by its own boulder.

That is what turns one switch into a room you have to read: you can see the whole
chamber, you can see it is cut into pieces, and the boulders are how you cross.
Floor 2 already proves the read — *"floor 2's puzzle room has always been
visible-and-sealed and it reads correctly: you see the chamber, you see it is
walled, you go find the rock."* (v1.10.42)

### What the engine needs — three small changes, and nothing else

Today `mapSt.rockSwitch` is **one** object, `{ rocks: [...], wallTiles: [...] }`.
Every rock in it opens the **same** wall set, and `handleRockPuzzle` sets
`mapSt.rockSwitch = null` after the first use — one switch, one shot, whole floor.

1. **`rockSwitch` becomes a list of switches**, each with its own rocks and its
   own wallTiles. `map-loading.js:213` and `map-state.js:36` carry it through
   untouched; only the shape changes.
2. **`movement.js:408`** matches the rock against the *specific* switch it
   belongs to instead of one flat `.some()`, and `handleRockPuzzle` consumes
   **that** switch rather than nulling the field.
3. **The generator places N of them** in one chamber instead of one across a floor.

Everything else is already shipped and unchanged: the `$0B` tile, `SFX.EARTHQUAKE`,
the screen shake, `SFX.DOOR`, the per-tile `newTile` swap, and `_consumeTile`
persistence. `check-floor-snapshot` already hashes `rockSwitch`, so the shape
change is gated the moment phase 1 puts seals in the fixture.

### ⛔ The placement laws, paid for in v1.10.42 — all four carry over

A second boulder switch was built on floors 1 and 3 and reverted in v1.10.43. It
was **not** reverted for the mechanic — it was reverted because *"I built this
because §3b listed it as an open item... not because anyone asked."* You are
asking. The mechanic is blessed; the four bugs it cost are not optional reading:

1. **The rock must never be in the doorway.** The first version put it on the
   approach tile, so opening the wall left the rock blocking the way — unreachable
   on **every** seed. Floor 2 keeps rock and wall in separate places on purpose.
2. **The rock is impassable and permanent.** On a corridor tile it severs the
   floor — it cut 30 tiles and an exit on one seed. Candidates get verified **by
   blocking them and re-flooding**, not by inspection.
3. **A chest is not walkable**, so counting reachable *tiles* cannot see a chest
   become unopenable. A rock landed beside an alcove chest and took its only
   approach, about 1 seed in 400. Chest approach tiles get their own check.
4. **Cartridge convention for the tile:** both `$0B` in ROM map 22 sit on the
   walkable row with ROCK directly above, against solid on one side. Ours already
   requires rock above and two solid neighbours. Keep it.

With N boulders and N veins in one room, every one of these scales with N.

### The descent moves off the trap holes

Floor 1 has no stairs (§2a). The way down becomes a `PASSAGE_ENTRY` block behind
the **last** vein — the same exit block floor 2 already places, wired through
`dungeonDestinations` the same way. Trap holes can stay in the room as a hazard;
they just stop being the way out.

### ⛔ The solvability gate is the expensive part, and it is not optional

An unopenable room is a **soft-lock on the floor between the player and the quest
boss**. Over hundreds of seeds, per dungeon: every vein's boulder is reachable
*before* that vein opens, every boulder is reachable at all, and the exit block
is reachable once the chain is walked. This is reachability re-flooded once per
switch, and it is why phase 3 is last.

### Two design calls left

**(a) What makes it a puzzle rather than a button hunt.** Three shapes, all pure
shipped mechanic:
- **Chain** — boulder A opens the vein to boulder B, which opens the vein to C,
  which opens the way down. A sequence you discover by walking it. Simplest, and
  the most likely to read as "giant puzzle room".
- **Fork** — several boulders, one opens the way on, the rest open dead ends and
  treasure alcoves. Wrong picks cost walking, never a lock.
- **Chain + fork** — the chain is the spine, the wrong boulders hang chests off
  it. Most room for loot, most seeds to gate.

**(b) Floor 2 keeps its own rock switch.** As written, the seals player meets
boulders on f1 and again on f2, back to back. Either f2 swaps to a different
layout in the seals row, or the giant room *is* f2 and f1 becomes something else.
Flagging, not deciding.

## 6. Order, and what each phase is worth on its own

| phase | ships | value if the next phase never happens |
|---|---|---|
| 1 | `layout` block + gates walk every dungeon | the two caves can diverge at all; seals stops being ungated |
| 2 | long corridors in the seals row | the cave feels different immediately — the cheap half of the ask |
| 3 | the boulder room | the ask proper |

Phase 1 has no visible effect and is not optional: without it, phase 2 changes
Altar Cave.

## 7. Risks

- **Altar Cave regression.** Mitigated by the snapshot staying green with no
  `--update` through phase 1, and by altar and seals having separate rows after it.
- **The compounding chain (§4.2)** is the likeliest source of ugly floors, and it
  fails as a *bad layout*, not an exception. Only a seed sweep catches it.
- **Soft-lock on floor 1 (§5).** The gate, or don't ship it.
- **Variety thresholds** are pinned per floor today and become per dungeon per
  floor. More gate surface to keep honest.
