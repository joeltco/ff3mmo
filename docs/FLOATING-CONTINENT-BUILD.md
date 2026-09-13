# Floating Continent build — 2026-09-12

## Delivery state

The main Floating Continent chapter is implemented through Cid's Enterprise
upgrade. The new content is the v1.12.0 release candidate.
The two optional summon caves are implemented behind the later Invincible
milestone; this chapter does not grant that vehicle or implement the Surface World.

The work follows the user's MMO direction and bossless “find the end” rule.
It extends the existing canvas engine, ROM assets, procedural dungeon registry,
word-driven quests, per-character story state, and existing social systems.
Research and the initial gameplay evaluation are in
[FF3-GAMEPLAY-REFERENCE.md](FF3-GAMEPLAY-REFERENCE.md) and
[IMPLEMENTATION-EVALUATION-2026-09-12.md](IMPLEMENTATION-EVALUATION-2026-09-12.md).

## Implemented adventure

| Place / sequence | Playable behavior |
| --- | --- |
| Opening valley | Existing Altar/Seals content retained; ACCEPT delivers the canoe before the search. Cid's airship and permanent Nelv passage lead onward. |
| Canaan | Native connected town, shops, townspeople, Mrs. Cid's Elixir treatment and treasure vault. |
| Dragon's Peak / Healing Copse | Native climb, Bahamut escape warp, Desch joins and teaches Mini; healing and return-to-Canaan springs. |
| Tozus | Doctor's Potion treatment opens the passage. Mini access, shops, and a generated bossless tunnel with forward and reverse exits. |
| Vikings / Nepto | Giant Rat, NEPTO conversation quest, restored waters and Enterprise reward. |
| Western towns | Tokkul, Village of the Ancients, Gulgan Gulch, Gysahl and Living Woods; native inhabitants, shops, spell lessons, healing and route hints. |
| Owen | Five-floor adaptation of the ten-floor ROM tower, Medusa, Desch's guardian scene and completed exit. Uses maps 126/128/130/132/134 (native 2F/4F/6F/8F/10F), every other floor, as material donors; generated layouts do not reproduce the original tower geometry. |
| Dwarven Hollows | Gutsco, stolen horns, Flame Cave and Salamander; Fire Crystal jobs, chief's reward and opened vault. |
| Hein / Argus | Tokkul capture, Castle Hein, Barrier Shift and Scholar Study; restored forest, castle audience, Time Wheel and flying Enterprise. |
| Revisit routes | Restored woods offer a personal Hein replay; story rewards remain one-time. Mythril Mines finish by finding the endpoint. Chocobo Woods offer rides. |
| Optional summons | Lake Dohr / Leviathan and Bahamut's Lair, distinct generated caves, later access gate, return exits and one-time learned summons. |

Eleven registered dungeons now use shared completion and exit mechanisms.
Bossless final rooms have no boss or random encounters. Ready exits use the
existing animated ROM star. Generated floors retain native tiles, palettes,
music and encounter donors; destination rooms and loot are assigned per dungeon.

## MMO decisions

- Missing PvE party slots fill with local NPC adventurers. Real online players
  take priority. An `N` in the battle row identifies an NPC. They are not online
  roster entries, chat participants, trade partners or PvP combatants.
- Desch occupies a companion slot between the mountain escape and Owen.
  Companions retain damage within a battle, but are refreshed for each new
  battle. Their spell AI follows the existing local ally system, which does
  not maintain persistent MP expenditure. This is not synchronous co-op.
- Learning Mini or Toad grants the corresponding field access for any combat
  job. Traversal does not force a combat status penalty or a job switch.
- Nepto's recovered-eye beat is resolved when reporting to the Viking chief;
  it is not a separate statue-placement inventory puzzle. The Time Wheel is
  retained as a keepsake after the Enterprise upgrade.
- Story completion is per character. Replaying a dungeon does not reverse
  its world milestones. The restored forest's Hein dream provides repeat access.
- Native springs heal HP, MP and status. Shops include useful remedies and
  elemental scrolls; Vikings sell Soft before Medusa. The character cap is 40.
- Chocobo rides avoid encounters, end with Z, and preserve the parked ship.
  Canoes automatically handle shallow water. Airships stay airborne until
  landed with Z; ocean ships disembark at the shore.
- Optional summon entrances retain the original later-world progression role.
  `invincible_acquired` is intentionally not obtainable in this chapter.
  Fat Chocobo storage and the Surface World are not implemented by this build.

## Persistence and integration fixes

The save parser now preserves quests, words, flags and vehicle fields that the
serializer was already writing. Older parked mode-1 canoes migrate to mode 2;
mode 1 is the ROM's chocobo mode. New real chocobo rides are preserved.

Local checkpoint transactions and cloud snapshots are ordered. Unacknowledged
local progress survives a stale cloud response and retries on load. Local
recovery is associated with the active account. Cloud deletion shares the
write queue so an older pending save cannot immediately overwrite a successful
delete. Offline deletion retry remains an existing limitation.

Reconnect reconstructs outstanding quest claims from saved progression. Claims
are paced and use the server's existing one-time ledger. A full bag postpones
payment without reversing earned XP, story flags or vehicle upgrades. Retrying
an already-paid claim does not execute local reward callbacks again. This does
not redesign the existing offline inventory economy or guarantee recovery of
all disconnected consumable-use events.

Bosses now use their native special-attack data. Allied offensive magic reaches
boss targets. Hein changes elemental weakness without mutating the shared
bestiary; Scholar Study reveals it. Party petrification terminates combat
instead of trapping the player in an endless turn loop. Argus bars an unused native
door into map 24, which belongs to Sasune in the current area catalog.

## Verification and its limits

`tools/check-continent-story.mjs` carries one fresh story state through both
crystals, canoe, curse, Nelv, mountain, Mini, Tozus, Nepto, Toad, Owen, horns,
Hein and the Enterprise upgrade. Story/quest/spell state is earned rather than
seeded and survives checkpoint parsing. The harness positions travel between
scenes, provides treatment consumables and supplies boss victories through the
real dissolve handler. It is a connected story regression, not a human playthrough
or a measurement of fresh-character grinding time.

Separate input-driven checks cover counters and word menus, native entrances,
vehicle boarding/movement/landing, the mountain warp, treatment gates, tower
stairs, dungeon endpoints, Argus's door chain, healing springs and Hein revisits.
Optional cave checks seed the later Invincible flag; they do not claim that
this vehicle can already be earned.

The actual battle-update/input/ally/enemy handlers completed 20 seeded Fighter
runs for each of five bosses, using appropriate gear and NPC companions with
no consumable items. At levels 12/16/18/22/24, wins were 20/14/20/20/20 for
Giant Rat/Medusa/Gutsco/Salamander/Hein, with no stalls. A lower-level sample at
8/12/14/18/20 won 13/13/20/18/20, also without stalls. These samples support
solo feasibility; they do not establish balance for every job, equipment choice,
real-player party or later summon boss.

The floor-plan sweep passed 100 seeds per dungeon across all eleven dungeons.
Registry, area connectivity, arrivals, exits, banners, NPC placement, shops,
loot and dialogue checks pass. Save tests cover codec preservation, transaction
ordering, stale-cloud recovery, account switching and storage failure; mocked
WebSocket tests cover reward retries, duplicate acknowledgements and slot changes.
Real online allies replacing NPC companions are also exercised with roster messages.

Runtime renders were inspected for the new towns, forest, boss chambers,
chocobos and companion HUD. `tools/render-continent-review.mjs` reproduces the
review images in `/tmp/ff3mmo-evaluation` using the game's AWJ font patch.
There has been no live multi-client session, browser soak test, or uninterrupted
human journey from level 1 in this build. These remain playtest limitations. Deployment does not require a production
database migration.

### World event decoding correction

World tile-property byte 2's high bit distinguishes an EVENT from an entrance
index (FF3 3E/C6DF-C6EB). Do not mask both kinds with `$3F`. That conflates
separate locations and corrupts reverse exits. Verified event scripts:

| event | result script | FB entrance index | place / world tile |
| --- | --- | --- | --- |
| 2 | $12 | $1A | Summit Road, 88,69 |
| 3 | $13 | $1B | Bahamut nest approach, 88,66 |
| 4 | $14 | $05 | Tozus, 95,96 |
| 5 | $15 | $06 | Tozus Tunnel, 86,92 |
| 7 | $17 | $07 | Living Woods, 40,66 |
| 9 | $1A | $02 | Lake Dohr, 32,53 |

Native map-property exit bytes independently confirm Tozus (95,96) and the
passage (86,92). Nepto's ordinary entrance is 72,72. Event 8 at 84,26 is
separate; it must not be mistaken for Nepto. Event 6 at 79,76 is not a cave
entrance. Earlier raw `world-entrances.json` exploration conflated these;
use `decodeWorldTrigger` and corrected `triggerPositions` instead.

### v1.12.0 release checks

The deployment preflight ran in an isolated checkout with a disposable database.
It exposed and resolved two misplaced Tokkul NPCs, missing Argus follow-up
dialogue, bossless loading text, oversized transparent battle-sprite margins,
and rare chest placements that blocked a dungeon route. New floors now validate
their completed routes and treasure before accepting a deterministic seed retry.
The 400-seed dungeon sweep passes; Altar and Seals retain their existing
structural snapshots. Dedicated regression cases use the actual map renderer
to check the previously failing chest, boulder and exit routes.

~~All 105 deployment gates passed~~ was an inaccurate description: those were
separate checks and focused retests, not 105 gates enforced by `deploy.sh`.
The original runner had 89 executable gate calls. The v1.12.1 containment
release passed 108; restoring Mines and adding its two gates brings the local
runner to **110**. The runner remains ignored and untracked. This count does not
claim that all 110 were rerun together or that Mines has been deployed.
Lint and whitespace checks also passed for v1.12.0. A consistent SQLite backup
was taken before that deployment and its integrity was verified.
