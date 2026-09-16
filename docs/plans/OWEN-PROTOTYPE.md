# Owen authored tower — local review, 2026-09-15

All five floors are now registered as Owen's real maps 6000–6004. No standalone
prototype descriptor or cave-generator floor remains in Owen. Work is local,
uncommitted and not deployed; Joel decides when to deploy for human playtesting.
The existing tool filenames are retained so no prototype gate becomes orphaned.

## Layout and measurements

The building envelope is x=1..14, y=3..12: **14x10** on every floor. Outer walls
and the upper machine face occupy a 16x14 drawing rectangle. Native ROM donors
are 126/128/130/132/134, adapting ten original levels into five playable floors.
The engine keeps the common envelope around a small 18-tile suspended walkway.

Seed `1754900087109`, measured with the actual renderer's movement predicates:

| Floor | Envelope | Walkable closed / open | Crossing |
|---|---|---|---|
| Machine Gallery | 14x10 | 101 / 103 | 18 |
| Distribution | 14x10 | 107 / 109 | 19 |
| Shaft | 14x10 | 45 (44–46 across seeds) | 20 |
| Control | 14x10 | 73 / 77 | 18 |
| Engine | 14x10 | 18 | 12 |

Gallery has paired upright machinery banks. Distribution uses a transverse
bank and an upright bank, with a different right-side arrival. Control has an
upper regulator bank, a lower service catwalk and a four-tile service gate.
Shaft has narrow perimeter walks and a seeded supply spur. Engine contains
Medusa at the existing (6,8), with the boss-gated completion warp to her left.

Gallery/distribution/control each have four machine/control arrangements;
shaft has three spur lengths. Engine is fixed. Primary crossings remain
recognizable between visits; variation changes bank circulation and supply
access, not every tile. Controls only add passable tiles, never remove them;
applying them twice is harmless. No shared MMO state or enemy-visibility system
is introduced.

## Runtime and saves

The existing boss ending, no-random-encounter engine, Desch scene, companion
removal and `owen_restored` Lake unlock remain in place. The engine has only a
return stair: it cannot bypass the boss gate through a normal onward port.
Completed runs return to (63,32) and discard their temporary layout record;
retreating and re-entering before completion preserves its seed and features.

Saves **can write indoors**, but `main.js` supplies no indoor position override.
World entry captures the safe checkpoint before switching maps; feature/inventory
writes preserve it. The codec now accepts either Mines or Owen, with each one's
own feature allowlist. A run from the other dungeon cannot supply Owen's seed.
For older saves with indoor IDs 6000–6004, the actual title-screen restore path
lands on the world at (63,32), never on obsolete cave coordinates.

## Shared validation and regression boundaries

Mines and Owen use the authored compiler; caves keep their construction passes.
All paths invoke `validateDungeonFloor`, including consumed-feature replay.
The shared contract checks safe arrival, valid transitions, reachable objectives,
usable treasure and disconnected land. Preserve the chest-adjacent scenery
exception: a chest is not a wall. Only Owen's five snapshot rows are intentionally
updated. Altar, Seals, Mines and every other snapshot row remain byte-identical.

`check-owen-prototype` now generates the REAL registry dungeon across all five
floors, default 120 seeds each, in both initial and opened-control states:

- A: fixed structural envelope and intact outer shell; no floor outside it.
- C: opposite-side crossing, minimum 18 steps on normal floors and 12 in the
  18-tile engine; 3x3 normal arrivals and a 2x2 engine arrival; real port targets.
- D: per-floor density bands 98–105 / 104–114 / 38–50 / 70–80 / exactly 18.
- E: every chest requires at least four extra steps to interact with and resume
  progress. Replacing a chest with floor must not shorten the crossing.
- Two internally vertex-disjoint routes inside each declared machinery bank;
  real-renderer collision parity and atomic, opening-only, idempotent controls.

The generic sweep now recognizes an explicitly wired previous-floor destination
as backtracking, not a forward sequence skip. It uses real renderer reachability
for authored floors and permits the intentionally 18-tile engine. Cave wall-depth
and floor/void adjacency rules still apply to caves and Mines; tower catwalks
intentionally border a shaft, and Owen gate A enforces their enclosing shell.

There is no coordinate-overlap gate. Routes, junctions and machine states are
measured separately. Engine has no chest or seeded machine puzzle.

`check-owen-route` drives world entry, all four ascents and descents, saved-feature
replay, boss gating, outside return, encounter suppression and actual title-screen
recovery of all five legacy indoor save IDs, plus retreat to the world and re-entry. `check-dungeon-run-save` round-trips
both dungeon records through the server validator and client codec. Existing
continent-story and companion gates cover Desch and the subsequent unlock.

`check-dungeon-contract` instruments the real boundary and tests malformed
arrivals, transitions, objectives, treasure and disconnected floor. It covers
both generator paths without duplicating their validation implementation.

## Revert proofs

`node tools/prove-owen-gates.mjs` restores intentionally regressed `.bak` copies,
requires these failures, then restores the working bytes in `finally`:

| Regression | Failure |
|---|---|
| A: wider building | `A: structural envelope must be 14x10` |
| C: adjacent exit | `C: arrival and onward stair must oppose` |
| D: filled shaft | `D: shaft density 121 outside 38..50` |
| E: chest on progress route | `E: gallery-cache detour 0 is below 4 steps` |
| Disable contract | `Missing expected exception: arrival corruption must fail` |
| Disconnect legacy validation | `boundary not called for altar` |

Logs and backups: `/tmp/ff3mmo-owen-prototype/`. No Git revert or checkout is used.

## Review renders

`node tools/render-owen-prototype.mjs` uses native ROM assets, the actual
MapRenderer, player sprite and existing Medusa map sprite. PNGs are at:

- `/tmp/ff3mmo-owen-prototype/owen-gallery-closed.png`
- `/tmp/ff3mmo-owen-prototype/owen-gallery-open.png`
- `/tmp/ff3mmo-owen-prototype/owen-distribution.png`
- `/tmp/ff3mmo-owen-prototype/owen-shaft.png`
- `/tmp/ff3mmo-owen-prototype/owen-control.png`
- `/tmp/ff3mmo-owen-prototype/owen-engine.png`

Matching `-camera.png` files provide 9x9-tile views. Full-floor captions are
outside the map. These are renderer outputs, not live-site screenshots.

## Final local verification

All **112/112** executable gates from the ignored `deploy.sh` passed with their
configured timeouts in a fresh disposable copy excluding player databases.
The earlier run exposed the sweep's backward-stair assumption and the cave-only
void rule; both were corrected, and the complete suite was rerun successfully.
`deploy.sh` itself was not executed. No commit, push or deployment occurred.

Evidence: `/tmp/owen-final-gates/results.json` and its per-gate logs.
`check-owen-route` passed actual ascents/descents, saved-feature replay, the
Medusa gate, outside return, all five legacy title-screen restores and retreat.
`check-floor-snapshot` reported `generator output unchanged`; only the five
Owen fixture rows were intentionally replaced, preserving every other row.
The 120-seed/floor design gate, 400-seed dungeon sweep, shared contract and all
six `.bak` negative proofs passed. All 608 project JavaScript source/tool files
matched the tested copy byte-for-byte (dependencies excluded).
