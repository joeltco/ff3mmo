# Dungeon refactor proposal

Prepared 2026-09-12 against deployed v1.12.0 (`d442a4af`). Planning only.

The target is an FF3 MMO whose dungeons are recognizable places, enjoyable to
explore again. Ur is Joel's current quality benchmark. Altar and Seals are
prototypes to reassess, not architectural standards to extend indefinitely.

The recommendation is **authored dungeon structure with controlled procedural
variation**. Preserve the defining rooms, journey, discoveries and story beats
of each location; vary suitable branches and room shapes inside that design.
A dungeon may use several map types. Its floor count follows its journey.

## 1. What the current build gets wrong

These are findings from the deployed source, not assumptions about its author:

- `src/dungeon-generator.js` is 4,152 lines. Different dungeon rows mostly select
  the same cave algorithms. All four exploration floors of Owen and Hein use
  `snake`; changing bounds, palettes and encounter donors does not change their
  architectural identity.
- `src/dungeon/plan.js` records carving as it happens, sometimes incompletely.
  It does not define a complete route before generation. This made sense as a
  compatibility extraction, but cannot carry the new design by itself.
- `src/dungeon/boss-chamber.js` stamps one room layout and swaps its decoration.
  Bossless endpoints also enter that final-room pipeline. Arrival at the final
  place consequently feels much the same across dungeons.
- Tile painting, room shape, features, stairs and event wiring are interleaved.
  The vocabulary assumes cave walls and rocky overhangs. Native tower assets
  get replacement-tile patches to fit that vocabulary.
- Water scanning in the generator registers pond healing from tile IDs. Water,
  healing springs and lava need separate gameplay meanings before wet/volcanic
  dungeons can behave correctly.
- Mini and Toad currently check learned-spell access at the outside entrance.
  Their actual passages are missing from the generated journey.
- Entry assigns a local `Date.now()` seed and clears dungeon tile consumption.
  The seed is transient map state. That is insufficient for a resumed run or
  multiple clients agreeing on a dungeon's geometry and mechanisms.
- Most existing checks prove connectivity, familiar cave tile arrangements or
  random variation. They do not prove a place resembles Owen, Seals or a mine.

I rendered native maps 126 (Owen), 101 (Mines) and 104 (Seals), and reviewed
NES map references. Owen's organized machinery and stairs, the mine's narrow
excavated passage, and Seals' bone-marked rooms are distinct starting points.
These are raw map-sheet renders; they can contain multiple connected rooms and
must not be mistaken for single player-visible screens.

**Rule for inherited code and documentation:** separate Joel's explicit design
choices, reproducible engine constraints, and previous implementation guesses.
Preserve the first, test the second, and replace the third when it impedes the
new design. The old “one shape, many skins” plan is superseded as the direction
for this work. Existing tests remain evidence, not a definition of good design.

## 2. Design every destination separately

The following are proposed designs. References establish recognizable source
features; added route choices and replay rules are MMO adaptations, not claims
that FF3 already implemented them.

| Place | Structure and recognizable features | What the player does / ending | Variation allowed |
| --- | --- | --- | --- |
| Altar Cave | Natural opening cave, an introduction to hidden routes, deeper chambers, the established healing-spring floor, and an authored crystal sanctuary. | Learn exploration through a small number of purposeful discoveries; reach Land Turtle and the Wind Crystal. | Cave contours, optional treasure branches and eligible locked rooms. Keep the spring on the currently designated F3 and preserve useful existing interactions while reworking the route. |
| Cave of Seals | Its own burial-cave route: bone-marked chambers, constrained passages and a distinct deeper sealing chamber. | Discover the skull/bones passage, encounter Sara at a deliberate story location, and confront Djinn. | Burial alcoves and treasure detours around the authored secret and Sara sequence. Reassess the inherited spring/spine rather than retaining it because Altar has one. |
| Mithril Mines | A compact worked passage and side excavation leading to a concealed treasure working. Start with two short connected sections, informed by native maps 101/102. | Notice a clue, inspect the concealed opening, find the end and its worthwhile cache, then take a clear route back to Kazus. No boss requirement. | Small branch arrangements and secondary caches. The discovery and useful destination reward always exist. No new crafting/mining profession is needed. |
| Tozus Tunnel | A small-scale through-route with an identifiable entrance beneath Tozus and an exit on the Viking side. | Use the Mini passage and navigate through. The destination is the far exit. | Brief bypasses and optional alcoves; keep it a passage rather than extending it to match other dungeons' lengths. |
| Nepto Temple | An authored statue entrance and shrine rooms joined by miniature passages, ending at a distinct eye chamber. | Explore the shrine, defeat Giant Rat and restore the eye through a visible interaction. Adapt the existing report/reward quest so restoration is credited once. | Shrine side rooms and small passages within a fixed landmark sequence. |
| Tower of Owen | Flooded entry, compact mechanical tiers, shafts, stairs around machinery, a recognizable switch passage and an authored engine room. | Use Toad at the passage, ascend, operate the mechanism, defeat Medusa, and witness Desch's engine sequence. | Suitable side walkways, caches and room variants; preserve the vertical route and central mechanisms. Restore the multi-tier ascent rather than keeping five maps by habit. |
| Subterranean Lake | Shoreline chambers, water-separated routes and dry landings; an authored approach to Gutsco. | Enter through the Toad route, follow the lake passages and recover the horn. | Shore contours and shore-side treasure branches. Keep this a subterranean lake rather than randomly scattering healing ponds. |
| Flame Cave | Distinct lava channels, dry ledges, deliberate crossings, a discoverable passage and a Fire Crystal chamber. | Choose between safer travel and worthwhile detours, reach Salamander and the crystal. | Ledge/branch arrangements around fixed landmarks. Any damaging terrain needs clear visuals, measured cost and a viable solo route. |
| Castle Hein | Prison rooms and a small escape passage leading into the tree's interior, with deliberate room/branch transitions and a unique confrontation room. | Escape captivity, use Mini at the relevant passage, climb through the tree-castle and defeat Hein. | Optional cells, treasure rooms and branches. Preserve Barrier Shift/Study and the existing restored-woods replay access. |
| Lake Dohr | A deeper lake cavern with broad chambers, shoreline treasure and an authored Leviathan encounter. | Explore a substantial optional summon trial and defeat Leviathan. | Larger connected side chambers and treasure routes; distinguish it from the earlier lake's narrower chase route. |
| Bahamut's Lair | Cavern approach with a deliberate transition to an exposed high confrontation area. | Complete the later summon trial and confront Bahamut. | Cavern branches and approach variants, with a fixed final reveal. Keep separate from the early escape sequence. |
| Dragon's Peak / Healing Copse | Preserve the native mountain route and outdoor identity; inspect its transitions and landmarks alongside the refactor. | Reach the summit escape warp; recover in the copse and use the authorized return warp. | Polish and necessary repairs to the existing route; it need not become a procedural cave. |

Native town interiors, Ur, the Viking base and Dwarven Hollows remain adjoining
places rather than being routed through the dungeon generator. Their entrance,
exit, hint and reward interactions are included in the full journey review.

The original mine includes a concealed passage and two Mithril Swords; that
supports an exploration reward with an identity, rather than generic gil at a
fake boss platform. Exact MMO rewards will respect the existing shop tier and
inventory rules. [NES Kazus/Mines maps](https://shrines.rpgclassics.com/nes/ff3/maps/kazus.shtml).

Owen's NES maps explicitly include a Toad passage and a switch. Those belong in
its route design. [NES Owen maps](https://shrines.rpgclassics.com/nes/ff3/maps/owen.shtml).

Seals' skull passage and Sara sequence provide a basis for its own exploration
identity. [NES walkthrough](https://shrines.rpgclassics.com/nes/ff3/walk1.shtml).

Mini passages are documented in both Nepto and Hein. Use those as visible
traversal beats while retaining the project's any-job field-skill adaptation.
[NES Nepto maps](https://shrines.rpgclassics.com/nes/ff3/maps/nepto.shtml),
[NES Hein maps](https://shrines.rpgclassics.com/nes/ff3/maps/hyne.shtml).

Flame's maps include a switch and a crystal destination. Additional hazard
choices in this proposal require playtesting rather than being assumed faithful.
[NES Flame maps](https://shrines.rpgclassics.com/nes/ff3/maps/flamecave.shtml).

The source map collections for the two lakes and Bahamut will guide their
individual shapes before implementation; every map, event and transition still
needs its own capture/review sheet.
[Subterranean Lake](https://shrines.rpgclassics.com/nes/ff3/maps/lake.shtml),
[Lake Dohr](https://shrines.rpgclassics.com/nes/ff3/maps/dol.shtml),
[Bahamut](https://shrines.rpgclassics.com/nes/ff3/maps/bahamut.shtml).

## 3. Replace the architecture that forces sameness

Introduce these responsibilities behind a compatibility adapter that returns the
map data the existing loader/renderer expects. Directory names below are proposed.

1. **Dungeon definition:** one module per place under `src/dungeons/definitions/`.
   Declares its route, landmark rooms, eligible variations, objectives, art,
   encounters, treasure and progression integration. Existing registry IDs stay
   stable wherever possible.
2. **Complete route graph:** describe rooms/sections and directed connections
   before painting tiles. Connections name their entrances and destinations;
   support branches, loops, stairs up/down, secret passages and exit returns.
   No assumption that every transition means `base + floor + 1`.
3. **Dedicated layouts and authored rooms:** reusable low-level placement helpers,
   with separate tower, shrine, mine, natural-cave and tree-castle builders.
   Related caves may share helpers while having distinct route definitions,
   contours and features. A theme name alone is not a finished dungeon.
4. **Material and collision mapping:** builders place semantic surfaces and
   objects; each art profile resolves verified native tiles and legal joins.
   Reuse the renderer and original artwork. Scope rocky-wall rules to applicable
   caves; measure tower walls and other materials against their own references.
   Do not use palette swapping as a substitute for room construction.
5. **Explicit features:** stable IDs for switches, treasure, healing springs,
   hazards, field passages, NPC scenes and shortcuts. Store interaction position,
   walkable approaches, affected tiles, prerequisites and persistence scope.
   Ordinary water does not heal merely because it shares a tile ID with a pond.
6. **Objectives independent of room shape:** support reaching a passage exit,
   finding a cache, recovering/restoring an object, defeating a boss, touching a
   crystal and finishing a story scene. A bossless destination may finish within
   an exploration room. Every dungeon gets an intentional destination design.
7. **Validation and tooling:** inspect the graph and the actual painted map in
   each relevant state. Extend the existing dungeon debug view to show authored
   landmarks, feature IDs, route states and the exact generated version.

Generation sequence:

`definition + version + seed → route → room placement → tile painting → features → validation → runtime map`

Use separate deterministic random streams for route, decoration and loot so an
extra decorative draw cannot rearrange the entire run. Select among valid
variants; keep a verified authored fallback per definition. Record rejected
seeds for diagnosis rather than treating repeated retries as a design solution.

This work intentionally changes old layout snapshots. First preserve the legacy
path during extraction; then replace each dungeon's baseline only with its
reviewed redesign. A fixed signature room is desirable and must not fail a
universal “everything moves every seed” requirement.

## 4. MMO and saved-run behavior

Recommended model: a run has `{runId, dungeonId, definitionVersion, seed}` and a
separate state record for opened features, completed objectives and a safe resume
anchor. State names features, not only coordinates whose meanings can change.

- In online play, allocate run identity/seed through the server. Clients joining
  the same run must use the same definition and route. Existing local seed
  generation can remain only for explicitly personal/offline runs.
- Separate repeatable run state from permanent character story flags and
  one-time rewards. Replaying Owen must not remove later progress; replaying
  Hein must not re-capture the entire population.
- For shared exploration, synchronize mechanisms within the run and validate
  interaction/reward attribution. Each character keeps their own treasure claim
  and story eligibility. Opening a switch cannot strand another participant.
- Preserve the current solo/NPC/online-ally battle behavior during this refactor.
  Sharing exploration state does not by itself implement synchronous co-op
  combat; that remains a separate system and must not be advertised as completed.
- Persist a safe anchor and run version for disconnect recovery. A live version
  change either resumes the compatible run or returns the character safely to
  its entrance with permanent progress intact. Never apply old consumed-tile
  coordinates to a different layout.
- Extend client save codecs, server save validation and storage together. Test
  older saves explicitly. Existing saves without run state use the existing
  safe world position, not a guessed floor coordinate.
- Keep Mini/Toad traversal available to any combat job. Make the small/watery
  passage an actual interaction and understandable transition. Do not require
  permanent combat penalties or repeated job swaps to preserve the reference.

## 5. Delivery order and concrete checkpoints

**A. Reference and structural groundwork.** Record every dungeon's route and
original visual landmarks, with native renders and explicit MMO adaptations.
Implement the route/feature interfaces, versioned run state and loader adapter.
Exercise them with the two contrasting prototypes below before broad extraction.
Do not spend a whole milestone building an abstract engine without a playable
place using it.

**B. Mithril Mines, end to end.** First complete prototype: arrival from Kazus,
short distinctive excavation, clue, hidden opening, useful cache, bossless
completion, return and reload. It proves authored discovery, branching,
non-boss endings and feature persistence in a small area. Review the actual
rendered route and a complete walk, including a full inventory at the cache.

**C. Tower of Owen, end to end.** Second prototype: Toad entrance, mechanical
ascent, switch, Medusa, Desch and return. It proves that the new architecture can
build a tower rather than another cave. Review a whole ascent at game camera
scale, with machinery and floor transitions legible on mobile.

**D. Altar and Seals.** Rebuild them as separate adventures. Preserve useful
accepted Altar content and its spring-placement decision; give Seals its own
route, signature secret and authored final approach. Test a fresh character's
opening-valley progression and current story/reward behavior.

**E. Main chapter conversions.** Tozus and Nepto, then the Subterranean Lake and
Flame Cave, then Hein. Each ships as a complete journey, including access,
mechanisms, encounters, destination, replay and save recovery. NPC hints and
quest objectives must describe the redesigned route accurately.

**F. Optional trials and complete continent playthrough.** Dohr and Bahamut keep
their later progression gates. Review the native mountain/copse route and all
hub connections. Retire the legacy generator only after every consumer,
including locked rooms, secrets and debug tools, has a replacement.

These are work packages, not calendar estimates. The two playable prototypes
will establish the real implementation cost before scheduling the rest.

## 6. What qualifies as finished

Every converted dungeon needs all of the following evidence:

- A reference sheet and full-route render review: recognizable architecture,
  sensible stairs, native palette/material joins, readable discoveries, a
  distinct destination and no misleading decorative objects.
- A deliberate exploration rhythm: a reason to take a branch, fair clues for
  required passages, useful treasure, and an appropriate trip length. Record
  walking time, encounters, resource use and backtracking during playtests;
  do not force every dungeon into the same floor count or duration.
- Reachability under the actual movement predicate, including before/after
  switches, reverse travel, all treasure approaches and the proper terminal
  objective. Required progression never depends on optional random loot.
- Determinism and a broad seed sweep (at least the existing 400-seed baseline),
  plus exact regressions for failures. Structural variation must stay within
  each dungeon's identity; pixel difference alone is not the quality metric.
- Solo and relevant party-state tests; two real clients for shared run state,
  switches and reconnection. Keep battle tests distinct from exploration tests.
- Save/reload at meaningful milestones, full inventory, death/escape, abandoning
  and repeating a run, and deployment with an older saved state. Rewards remain
  recoverable without duplicate one-time grants.
- In-game camera and mobile review, then an uninterrupted playable route.
  Automated victories or positioned travel count as integration coverage only.

Implementation can proceed dungeon by dungeon behind the adapter. Release each
conversion with its own evidence and a rollback path. Passing the old test suite
alone is insufficient to call the refactor polished.

## First implementation deliverable

A fully playable redesigned Mithril Mines, accompanied by its reference images,
route diagram and in-game renders, using the new route and feature contract.
Then prove the same contract on Owen's very different architecture before
converting the remaining dungeons.
