# Implementation evaluation — 2026-09-12

## Assessment

This is a substantial custom game engine with a coherent design and unusually
extensive project-specific diagnostic tools. The ROM extraction, rendering,
combat helpers, and procedural-map verification are valuable foundations.
The main weakness is integration: declarations, runtime transitions, persistence,
and network acknowledgements do not always describe the same completed action.

Preserve and strengthen the existing implementation. A wholesale rewrite is
not justified by this evaluation. Authorship by a particular model does not
establish quality; observable behavior and the quality of its evidence do.

Scope: source inspection across boot, game loop, maps/dungeons, dialogue/quests,
combat, saves, inventory/economy, and multiplayer integration; targeted runtime
checks; two isolated progression/save reproductions; rendered cave and spell
samples. This is not a line-by-line review of all 193 JavaScript source files,
a browser playthrough, a balance study, or a multi-device networking test.

## Confirmed findings, in priority order

### 1. Accepting the Sara quest skips the canoe grant

`data/quests.js` puts the canoe item, parked craft, and `canoe_granted` flag on
the first stage of `sasune_missing_daughter`. `word-menu.js:275` accepts through
`acceptQuest()`. In `quests.js:204` and `quests.js:322`, acceptance immediately
moves to stage two. It never runs the stage effects handled by `_advance()`.

Reproduced with the real quest module, fresh quest/flag/inventory state:

```
offer true, accepted true
stage: errand
flags: {}
vehicleParked: 0
inventory: {}
```

Talking to the King afterwards resolves an aside, so the omitted offer-stage
grant is not recovered through normal conversation. This blocks the intended
fresh-save route into the Cave of Seals. It also affects any future offer stage
with effects, rather than being a missing canoe constant.

Both `check-quests` and `check-quest-stages` pass. Acceptance tests need to assert
the actual stage effects, including the usable craft and full-bag behavior.

### 2. A quest's completion save precedes its XP reward

`quests.js:258` marks the final stage done and calls `_persist()` before calling
the reward callback. `save-state.js:37` snapshots live state before its first
await. `npc.js:799` grants XP afterwards; that grant is not followed by a save
in this completion path.

Reproduced using the real quest/save modules with mocked IndexedDB and cloud
transport. The missing-brother quest finishes with:

```
liveExp: 80
savedExp: 0
savedQuest: { s: 'done', n: 3 }
```

A subsequent save can capture the XP. Closing or losing the process beforehand
can leave completion durable while losing that reward. The test callback added
the declared XP directly to isolate ordering; it was not a full NPC interaction.
Production uses `grantExp()` in the same callback position.

### 3. Some authored conversation is inaccessible

`audit-talk-reach.mjs` reports seven counter-only NPC placements. Four have
dialogue; the Ur tavern keeper also has BROTHER and VEIN answers.
`movement.js:352` only talks to the NPC on the immediately faced tile, while
the counter path opens a shop. The placement checker permits talking across
a counter, so it accepts a relationship the interaction code does not support.

The tavern keeper is at map 9, (23,3). His word answers and dialogue are
authored in `data/town-npcs.js:546`. This is inaccessible content, not evidence
that the main BROTHER quest is blocked: its start-word source is elsewhere.
The three shopkeepers without dialogue are not themselves content defects.

### 4. Bossless endings are outside the current dungeon model

The registry permits boss/crystal endings and defines the last floor as a boss
floor. Its layout validator requires exactly `floors - 1` exploration layouts.
The generator consumes that assumption. Joel's reach-the-end completion rule
needs explicit support before adding a bossless dungeon.

This is an extension gap, not a regression in the two existing boss dungeons.

## How the systems are built

| System | Assessment | Implication |
|---|---|---|
| ROM assets and data | Strong foundations: catalogs, emulator probes, captured graphics, shared data tables, and measured map fixtures. | Keep the extraction pipeline and evidence; verify each new claim at its actual consumer. |
| Dungeons | Registry plus reusable chamber, corridor, plan, shape, and skin modules. Layouts retain deliberate per-cave differences. | Good direction for expansion. The 4,101-line generator still mixes orchestration and individual layouts; extend carefully around stable behavior. |
| Dialogue and quests | Useful separation of prose, objectives, flags, placement, and speech resolution. | Data expressiveness has outgrown acceptance and rollback handling. Verify each stage through the actual interaction path. |
| Combat | Shared attack/math/casting helpers and executable state-machine checks. | Preserve the tested behavior. Rendering and state transitions remain coupled, making headless extraction and future multiplayer combat harder. |
| Saving | Central serializer, local fallback, cloud persistence, and a four-hop field check. | Field coverage is good; ordering, failed writes, conflicting versions, and reward durability need separate tests. |
| Economy/network | Inventory, gil, and equipment have server mirror ownership; some other progression remains locally canonical. | Every cross-system transaction needs a clearly defined completion and recovery path. |
| Multiplayer | Social presence and roster infrastructure exist; PvP is explicitly disabled and co-op has been removed. | Treat working social infrastructure and unfinished synchronized combat as distinct maturity levels. No live multiplayer reliability claim was tested here. |
| Documentation | Extensive design intent and failure history, but current instructions coexist with obsolete descriptions. | Maintain a concise current-state reference; avoid treating historical comments as runtime facts. |

A static relative-import scan found a group of **47 mutually reachable modules**
in the import graph. Separate files therefore do not imply independent systems.
Boot, combat, UI, and other concerns participate in these cycles. This is not
proof of an immediate crash, but it explains extensive browser shims in tools
and raises the cost of changes. Reduce cycles when touching those boundaries;
do not churn working animation code just to reduce file sizes.

Save networking has another source-level concern: `saveSlotsToDB()` dispatches
cloud writes without awaiting their completion, while `/api/save` replaces a
slot without a revision check and loading prefers any populated cloud response.
Delayed or failed writes can therefore produce stale restores. This was
inspected in source, not reproduced against a running server in this pass.

Similarly, `pve-client.js:69` clears a submitted battle even when sending fails,
and its result handler logs rejection without implementing full recovery.
Those paths warrant disconnect tests for ordinary players. The server's
`pve-replay.js` validates outcomes rather than replaying all player actions;
future combat changes must account for that actual boundary.

## Verification and limits

- Encounter checks: **51 passed**.
- Flee behavior/render checks: **29 passed**.
- Spell animation audit: **56 spells**, no missing cast/impact and no stuck
  turn-return cases; all three auto-all checks passed.
- Wire-profile diagnostic: **18 fields**, no divergence in its exercised case.
- Quest runtime, story flags, loot tables, vehicle wiring, and PvE claim checks
  passed during this pass.
- Earlier checks in this session passed for Word Memory, quest-stage placement,
  dungeon endings, 35 persisted fields, and floor plans across 150 seeds/floor
  (3,372 chamber records and 2,691 link records).
- Inspected same-seed rendered Altar/Seals floor 3 and a Quake contact sheet.
  These confirm visible cave differences and a rendered multi-target sequence,
  not full visual fidelity or play quality.
- The dialogue-coverage audit reports 17 uses of idle speech. That count is
  **not 17 confirmed bugs**: several idle variants correctly reflect story
  flags. Its output requires editorial/contextual review.
- Lint passed earlier in this session. No gameplay source was modified.

The strongest tests challenge the result independently: map connectivity,
rendered spell deltas, player/ally combat symmetry. The weaker ones establish
that declarations agree with each other, or drive internal functions while
assuming the missing interaction already happened. The canoe is a concrete
example of a green suite missing the player's blocked journey.

## Recommended work order

1. Repair offer-stage effects and add a fresh-save acceptance-to-boarding check.
2. Make quest completion and reward persistence agree; exercise interruption
   and rejected claims, including mid-stage grants.
3. Resolve unreachable authored conversation through the intended interaction.
4. Add the bossless endpoint model and prove a complete entrance-to-end run.
5. Establish a small whole-journey suite: new character, Word Memory quest,
   crystal/job unlock, canoe, Sara, Djinn, changed towns, airship, reload.
6. Add network interruption and save ordering cases before expanding multiplayer
   combat. Assess pacing with an actual playthrough after progression blockers
   are removed.

The key investment is making the completed player journey as well-tested as
the individual mechanics. The existing project already contains much of the
infrastructure needed to do that.
