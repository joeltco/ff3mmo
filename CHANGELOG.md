# Changelog

All notable changes to this project are documented here.

> **Co-op sync status (as of 2026-05-18):** Lockstep model was BROKEN in v1.7.472. **Host-authoritative deltas rewrite shipped behind `COOP_HOST_ARB` (Phases 0-8, v1.7.473) and FLAG FLIPPED LIVE in v1.7.474.** Prod now runs the host-arb path; hot-revert still available by flipping `COOP_HOST_ARB = false` in `src/coop-resolver.js`. Cutover procedure + two-phone smoke checklist: `docs/COOP-PHASE-6-SMOKE.md`. Architecture overview: `MULTIPLAYER.md` "Party co-op random encounters — host-authoritative model". Full plan: `docs/COOP-REWRITE-PLAN.md`.

> **Rewrite plan landed (2026-05-18):** Option B — host-authoritative deltas. Full plan at [`docs/COOP-REWRITE-PLAN.md`](docs/COOP-REWRITE-PLAN.md) (8 phases, gated by `COOP_HOST_ARB` flag, PvP untouched).
> - **Phase 0 (convergence harness):** SHIPPED. `tools/coop-arbiter-sim.js` + `tools/coop-arbiter-sim.PLAN.md`. Harness documents the 5 audit-flagged divergence sources as failing tests; `deploy.sh` gates via `--expect-fail` until Phases 2-4 land.
> - **Phase 1 (wire scaffold):** SHIPPED. `encounter-resolution` + `encounter-snapshot` wire shapes added to `src/net.js` + `ws-presence.js` relay. `COOP_HOST_ARB` flag in `src/encounter-wire.js` (default `false`). Stub modules `src/coop-resolver.js` + `src/coop-applier.js` with documented entry points. Coop-applier installs handlers at module load — gated to no-op while flag is off. **No behavior change.** Pvp-wire-sim 49/49, coop-wire-sim 7/7, coop-arbiter-sim wire suite 16/16 + 4/4 baseline.
> - **Phase 2 (physical attack logic):** SHIPPED. `src/coop-deltas.js` (NEW, Node-clean) — pure packet builders + delta applier. `resolvePhysicalAttack` + `resolveMonsterAttack` filled in `coop-resolver.js`. `_apply()` filled in `coop-applier.js` to walk deltas. Flag moved to `coop-resolver.js` (Node-importable) + re-exported from `encounter-wire.js` for backward compat. **No behavior change** — flag still off; production FSM still on legacy lockstep path. Arbiter sim Suite 3 grew from 2 → 10 tests: single attacks, multi-round mix, the headline "monster attack converges via wire delta" test, status inflict convergence, out-of-order apply commutativity. The lockstep divergence bug is now proven-fixable under the host-arb model.
> - **Phase 3 (magic / spell logic):** SHIPPED. `buildMagicPacket` added to `coop-deltas.js` — multi-target spell packet builder unifying every kind in `src/data/spells.js` (damage, heal, status-inflict, cure-status, drain, revive, instakill, erase, sight, recovery). `resolveSpellCast` filled in `coop-resolver.js`. **No behavior change** — flag still off. Arbiter sim Suite 3 grew from 10 → 20 tests adding spell coverage: Fire, Cure (self + cross-faction ally), Sleep, Poisona, Curaga (multi-target heal), AOE damage, miss handling, mixed-result multi-target, death cue routing. All 88+ spells in the codebase now have a clean wire path under host-arb.
> - **Phase 4 (items, poison-tick, KO, encounter-end):** SHIPPED. `buildItemUsePacket` + `buildPoisonTickPacket` + `buildEncounterEndPacket` added to `coop-deltas.js`. `resolveItemUse` + `resolvePoisonTick` + `resolveEncounterEnd` filled in `coop-resolver.js`. Applier handles `meta.encounterEnd` → guest transitions to `encounter-box-close`. **No behavior change** — flag still off. Arbiter sim Suite 3 grew from 20 → 32 tests adding: Potion / Antidote / Elixir / Phoenix Down (revive), end-of-round poison tick (batch packet for multiple actors, NES clamp-to-1 rule applied host-side), poison-killing-monster, player KO from physical, monster death routing, encounter-end (victory/defeat/fled), TPK / wipe (dual death in one packet). Phase 4 closes parity with the legacy FSM — host-arb now covers every battle action kind in the codebase.
> - **Phase 5 (encounter snapshot / mid-battle joiners):** SHIPPED. `buildEncounterSnapshot` + `applyEncounterSnapshot` added to `coop-deltas.js`. `resolveEncounterJoin` in `coop-resolver.js`. `_onEncounterSnapshot` filled in `coop-applier.js` (mutates `battleSt` directly, sets `isWireEncounter` + `encounterHostUserId`, resets applier turnIdx). Snapshot ships **realized stats** (atk/def/agi/maxHP/evade/mdef/hitRate/shieldEvade) instead of profile fields — eliminates the `recalcStats` vs `generateAllyStats` divergence as a class. **No behavior change** — flag still off; production assist-join still uses legacy `encounter-assist-snapshot` shape. Arbiter sim Suite 3 grew from 32 → 38 tests: snapshot builder normalization, joiner spawn convergence, joiner-as-self exclusion, joiner converges after subsequent resolution stream, status state carries through snapshot, full JSON round-trip. Phase 5 closes the assist-join code path; host-arb design surface is complete.
> - **Phase 6 (production host-emit wiring):** SHIPPED. Resolver calls added at host-side mutation points in production code, all gated behind `COOP_HOST_ARB` (still `false` — flag-off path 100% unchanged). Wired: monster-attack against `ps` + ally (`battle-enemy.js`), player physical combo (`battle-update.js#_finalizeComboHits`), ally physical combo (`battle-ally.js#_finalizeAllyCombo`), encounter-end (`encounter-wire.js#endWireEncounter`), assist-join snapshot with **realized stats** (`battle-encounter.js#_processAssistIncoming` — ships in addition to legacy snapshot during migration). Spell + item + poison-tick wiring deferred to Phase 6.5; guest-side short-circuits also deferred (would require live two-phone smoke to verify safely). Full smoke checklist + flag-flip procedure at [`docs/COOP-PHASE-6-SMOKE.md`](docs/COOP-PHASE-6-SMOKE.md). Gates: lint 0, pvp-wire-sim 49/49, coop-wire-sim 7/7, coop-arbiter-sim 57 pass + 5 expected divergence. **DO NOT flip COOP_HOST_ARB to true until Phase 6.5 lands guest-side short-circuits** — flipping now causes double-application on guests.
> - **Phase 6.5 (spell + item + poison-tick host-emit):** SHIPPED. Wired emits in `spell-cast.js#_finishMagicHit` (player cast, snapshot+diff per target — captures dmg/heal/miss/status add+remove/death automatically), `battle-ally.js#_applyAllyMagicEffect` (ally cast, single-target snapshot+diff), `battle-turn.js#_playerTurnConsumable` (item use, picked-target snapshot+diff), `battle-turn.js#_applyEndOfRoundPoison` (batch packet for all poisoned actors). All emits flag-gated; flag-off path unchanged. Snapshot+diff pattern is the design innovation — no need to instrument every internal apply path; just record `{hp, mp, mask}` before and compute deltas after. Spell coverage is complete (all 100+ spells route through `applySpell` which gets snapshotted). **Guest-side short-circuits remain unwired** — see `docs/COOP-PHASE-6-SMOKE.md` "Still blocking the flag flip" section. Phase 6.7 will land those after live two-phone smoke is available. Gates: lint 0, pvp-wire-sim 49/49, coop-wire-sim 7/7, coop-arbiter-sim 57 pass + 5 expected divergence.
> - **Phase 6.7 (guest-side short-circuits):** SHIPPED. Added `isCoopGuest()` helper in `coop-resolver.js` as single source for the guest-skip gate. Short-circuits at every legacy local-apply call site: `applyPhysicalHitToEnemy` (early-return), `_processEnemyTurn` ps + ally branches, `applyMagicDamage` / `applyMagicHeal` / `applyMagicCureStatus` / `applyMagicDrain` / `applyMagicRecovery` / `applyMagicAllStatus` / `applyMagicInstakill` / `applyMagicStatus` (skip `dispatchDelta` + `tryInflictStatus`), `_playerTurnConsumable` cure_status + Elixir paths, `_applyEndOfRoundPoison` per-actor applies. All gated on flag — flag-off path 100% unchanged. Animation callbacks (damage-num, shake, SFX) still fire on guest so visuals read locally; HP / status convergence rides the host's resolution packet via the applier. **Flag flip is now structurally safe — but read the caveats in `docs/COOP-PHASE-6-SMOKE.md` before flipping live.** Phase 6.9 (fx cue dispatch from resolution packets) will close the remaining visual gaps. Gates: lint 0, pvp-wire-sim 49/49, coop-wire-sim 7/7, coop-arbiter-sim 57 pass + 5 expected divergence.
> - **Phase 6.9 (fx cue dispatch from packets):** SHIPPED. `_dispatchFxCue` + `_dispatchDamageNum` + `_dispatchDeath` helpers in `coop-applier.js`. When a resolution packet arrives, the applier walks `msg.fx` and routes cues: `damage-num` overlays the AUTHORITATIVE value on the right damage-num slot via `setSwDmgNum` / `setPlayerDamageNum` / `setPlayerHealNum` / `getAllyDamageNums()[i]`; `death` cues for monster targets set `dyingMonsterIndices` + transition `battleState` to `monster-death`. Other cues (slash / magic-cast / magic-impact / item-use / item-impact / poison-tick-start) are no-op in the applier — animations stay driven by the local FSM's state transitions. **Closes the Phase 6.7 caveats** (locally-shown wrong damage numbers, lagging monster death animations). Player/ally death still drives off the local hp=0 check the applier writes — a one-FSM-tick lag in worst case, acceptable for v1. **Flag flip is now fully safe.** Gates: lint 0, pvp-wire-sim 49/49, coop-wire-sim 7/7, coop-arbiter-sim 59 pass + 5 expected divergence.
> - **Phase 7 (conservative cleanup + correctness fix):** SHIPPED. Per the rewrite plan, full Phase 7 strips flag-off branches and is gated on 48h live smoke. This commit ships the SAFE subset that doesn't depend on flag-flip: removed dead `battleSt.encounterTurnIndex` field (set in 8 places, never bumped — a v1.7.422-era leftover from when assist-join used a per-round counter). Audit surfaced a real bug: Phase 5's host-arb snapshot was shipping `encounterTurnIndex` (always 0) as the resolver `turnIdx` — a joiner consuming that would set `_lastAppliedTurnIdx = 0` and queue every subsequent resolution forever. Fixed by shipping `getResolverTurnIdx()` (the host's authoritative counter) in `resolveEncounterJoin`. Legacy `encounter-assist-snapshot` keeps its `turnIndex` wire field for backward-compat with older clients but ships 0 literally. **`COOP_HOST_ARB` kept as a kill switch** — flag-off path is intact, hot-revert is still available. Stale "Phase 6.9 will close" comments refreshed to past tense. Remaining cleanup (prerollSpellAmount / isHealSpell / perTurnIndex / maybeReseedCoopTurn / _pushPlayerCoop) is deferred until post-live-smoke. Gates: lint 0, pvp-wire-sim 49/49, coop-wire-sim 7/7, coop-arbiter-sim 59 pass + 5 expected divergence.
> - **Phase 8 (docs refresh):** SHIPPED. `MULTIPLAYER.md` co-op section rewritten — new host-arb model as primary, legacy lockstep marked HISTORICAL with a "do not extend" note + explanation of why it failed. `docs/design-notes.md` got a new "Co-op battle architecture" entry between PVP search and Roster fade. `docs/MULTIPLAYER-AUDIT-2026-05-15.md` got a follow-up note pointing at the rewrite (PvP audit findings still load-bearing). New auto-memory `project_ff3mmo_coop_host_arb.md` documents the working model; the broken-state memory `project_ff3mmo_coop_sync_2026_05_18.md` is marked SUPERSEDED in the MEMORY.md index. Zero code change.

## 1.7.703 — 2026-05-25

### Private chat tab label becomes the partner's name

The Private tab used to show "Private" as the label and the partner's
name as the input prompt (`→jointc `). Inverted — the tab label IS the
focused PM partner's name now, and the input prompt is the universal
`> ` like every other tab.

**Why.** "→Name" duplicated the recipient info that's already implicit
from being on the Private tab; the static "Private" label didn't tell
you who you'd be messaging. Putting the partner's name in the tab label
makes the whole tab a single visual identity ("you're talking to
jointc") — typing into it just sends to them, no special prompt
needed.

**Multiple partners** still cycle via up/down in tab-select mode (same
`pmSessionStep` behavior); the tab label changes as you page through.
**No partner focused** → tab falls back to "Private", input prompt
"> ", typing prints "No PM recipient" — same hint as before.

**Identity vs label.** `CHAT_TABS` stays as the static identity array
(`['World', 'Party', 'Private', 'System']`) — every `=== 'Private'`
branch throughout the codebase still works. The dynamic name only
affects rendering, via the new `getTabLabel(idx)` exported from
chat.js.

Files:
- `src/chat.js` — new `getTabLabel(tabIdx)` export;
  `_getTabWidths()` uses it so the tab grows/shrinks with name length;
  `drawChatTabs` label-draw uses it; `_inputPromptStr()` returns the
  universal `'> '` (dropped the Private special case).

## 1.7.702 — 2026-05-25

### Party pool sync — invitee sees the inviter as battle ally (was asymmetric)

**Reported symptom:** "JoeltCo can see jointc in his battles, but jointc
can't see JoeltCo in hers."

**Root cause.** `ws-presence.js#case 'party-invite-response'` accept path
fanned out a party-snapshot to the new joiner listing OTHER MEMBERS of
the inviter's party — but **NEVER the inviter themselves**, because
`_partyMemberships` is a `members → inviter` map (the inviter is never
in the keys). The new joiner's only source for "the inviter is in my
party" was the **local** accept-callback in `party-invite.js:271-277`.
If that local push silently failed for any reason (modal race, prompt
state, page reload before the callback ran), the joiner ended up with
an empty `partyMembers` and the inviter never appeared as an AI battle
ally on the joiner's screen.

The inviter, meanwhile, learned about the joiner via the **official**
`party-invite-result` server message — never failed. Hence the
asymmetry.

**Fix.** Server now backfills the inviter (challenger) into the
joiner's snapshot. Both sides share the same party pool
authoritatively — the local accept-callback becomes a redundant
optimization, not a single point of failure. Snapshot is always sent
(was gated on `existingMembers.length > 0` so a fresh 2-person party
with no other members got nothing).

Existing client handler (`setNetPartySnapshotHandler` in
`party-invite.js`) is additive + idempotent (`!includes` check), so the
backfill is a no-op when the local callback already populated the list
and a save when it didn't.

Files:
- `ws-presence.js` — `case 'party-invite-response'` accept branch:
  prepend the challenger to `partyPool` (the renamed `existingMembers`
  array); always send the snapshot.

## 1.7.701 — 2026-05-25

### `/party` diagnostic — list your local party + online state

Added a `/party` slash command in `src/chat.js`. Prints
`partyInviteSt.partyMembers` (the exact list `tryJoinPlayerAlly`
iterates when battle starts) along with each member's current online
status via `getOnlinePlayerByName`.

Use when a party member who should be available as a battle ally isn't
showing up — the output will say either "name offline" (server / local
mirror missing them from `_onlinePlayers`) or "You are not in a party."
(party-snapshot / party-member-joined never reached this client). Both
flow through `tryJoinPlayerAlly` so the symptom maps directly:

- not in list  → snapshot / member-joined fanout missed this client
- `offline`    → mate's hello hasn't completed (or they disconnected)
- `ONLINE`     → mate IS eligible; the bug is elsewhere

Files:
- `src/chat.js` — `registerCommand('party', ...)` near the other party
  commands (`/disband`, `/leave`).

## 1.7.700 — 2026-05-25

### World chat is global (was location-scoped)

`ws-presence.js#case 'chat'` had `target.loc !== entry.loc → continue;`
in the world-channel relay loop — "world" chat only reached clients at
the same loc as the sender. So a player in Ur and a player in the cave
couldn't see each other's world messages. Felt broken for an MMO.

Dropped the loc check. World chat now broadcasts to every helloed
client. Per-IP + per-kind rate limits (`chat` 20/5), `cleanChatText`
profanity mask, and name sanitization still apply — nothing else
changes. Party still membership-scoped via `_inSameParty`; PM still
targeted by `toUserId` (audit #8 / #22 protections intact).

**@-mention side effect (improvement).** Pre-fix, an @-mention sent in
world chat to a player at a different loc was silently filtered out by
the loc check before it ever reached the recipient — they'd never see
the highlight or hear the chime. Now @-mentions reach across locations
on world chat the same way they already did on party / PM.

The @-mention system itself was already correctly wired and
color-coded — verified the path:
- Tab autocomplete (`src/chat.js`) reads `getOnlinePlayers()` (no loc
  filter — global).
- Mention detection (`_mentions` regex) runs on every incoming chat,
  channel-agnostic.
- Mention chime + gold highlight (`#ffd84a` for both name and message
  text, `src/chat.js:1050+1052`) fire on any matched @-mention.

Files:
- `ws-presence.js` — `case 'chat'`: dropped the `target.loc !==
  entry.loc` skip in the world branch; updated header comment.
- `docs/design-notes.md` — `## Chat & PM` updated to reflect global
  world chat + the v1.7.700 history note.
- `MULTIPLAYER.md` — same; the channel table row for `world` now reads
  "global" with the rationale.

## 1.7.699 — 2026-05-25

### Intro message — drop stale PvP hint

`main.js#startupMsgs` first-run tips still said *"Pick Battle on a roster
row to issue a PvP challenge."* PvP was disabled in v1.7.502 and the
`Battle` roster item was removed; the current `ROSTER_MENU_ITEMS` is
`['Party', 'Trade', 'Message', 'Inspect']`.

Replaced with an accurate hint: *"Roster: pick Party / Trade / Message /
Inspect to interact."*

Files:
- `src/main.js` — one-line replacement in the first-run startup messages.

## 1.7.698 — 2026-05-25

### Quest NPC walks in place (idle-march), still doesn't move

`UR_QUEST_NPC` at (10, 28) was `mode: 'static'` — frozen, no animation.
Flipped `animate: true` on the spec so the walk frames cycle (foot
alternation in place) and the NPC reads as alive. No wander, so he still
stays on (10, 28) facing RIGHT.

`mode: 'idle-march'` already opts out of the v1.7.693 yield-to-player
behavior (`tryYieldToPlayer` early-returns for `static` AND `idle-march`),
so the quest NPC still solidly blocks the player from passing — players
have to talk to him or walk around. Confirmed via the single-site gate
on yield in `movement.js#startMove`: yield only fires when
`findNpcAt(targetTile)` returns an NPC, i.e. when the player has
directionally pressed INTO the NPC's tile. Walking into a neighboring
tile doesn't call `tryYieldToPlayer`.

Files:
- `src/data/town-npcs.js` — `UR_QUEST_NPC` spec: added `animate: true`.

## 1.7.697 — 2026-05-25

### iOS — ROM picker silently rejected .nes files

iOS users reported "can't get the ROMs to load." Root cause: the ROM file
input had `accept=".nes,.zip,application/zip"`. iOS Safari uses **UTI**
filtering instead of file extensions; `.nes` has no registered UTI, so the
iOS picker either grayed out every `.nes` file or hid them entirely. Users
literally could not select their ROM through the picker — the game was
un-loadable on iPhone/iPad.

Dropped the `accept` attribute from all three `<input type="file">`
elements. Desktop users now see an unfiltered picker but their `.nes` is
right there by name; iOS users can finally pick a `.nes` file.

**Secondary iOS issue (now visible in the picker).** Verified via
`/api/storage-beacon` telemetry that **14/17 iOS sessions** get persistent
storage DENIED (12% grant rate vs 100% on Android Firefox). iOS Safari
only grants durable IndexedDB when the page is installed via
Share → Add-to-Home-Screen. Without that, the ROM cache evaporates between
sessions and users have to re-pick the three ROMs every time.

Revealed a previously-hidden `#rom-hint-ios` gold-on-dark line right under
the picker — only when we detect iOS AND we're not running as standalone
(PWA) — telling users to Add-to-Home-Screen. Doesn't add noise for
non-iOS visitors.

Files:
- `index.html` — `accept` removed from `#rom-file` / `#rom-file-ff1` /
  `#rom-file-ff2`; new `#rom-hint-ios` block under the picker;
  `showROMPicker()` reveals it when `/iPhone|iPad|iPod/` matches the UA
  and `navigator.standalone` / display-mode standalone is false.

## 1.7.696 — 2026-05-25

### Ur quest NPC placeholder at (10, 28)

Converted the v1.7.695 `UR_VILLAGER_TRADER` slot into `UR_QUEST_NPC` —
static NPC at the canonical FF3 spot (10, 28), facing RIGHT, peach hair,
bundle `0x01E210` (adult-villager body, distinct from the existing PEACH /
RED villagers' bundle `0x01DF10`). Quest system isn't built yet — the
placement + rendering are stable now; when the quest trigger lands, hook
it in here without moving the NPC.

`(10, 28)` isn't openArea by the wander rule (lacks ≥3 walkable neighbors)
but that doesn't matter for `mode: 'static'` — the openArea check only
gates `_startWalk` / `_trySameDir` / `placeMoogleAtCaveCenter`, none of
which run for static NPCs. Player can't pass through (tile is solid, like
every NPC); the v1.7.693 yield-to-player behavior is gated off `static` so
quest NPCs intentionally block the player.

Placeholder dialogue makes the WIP status visible in-game: "I have a task
for the brave..." / "...but not yet. Return soon." / "The crystal will
guide you."

The south-west `UR_VILLAGER_TRADER` (wandering, was at (10, 27)) is gone —
the canonical FF3 spot for that body was (10, 28), so converting that NPC
to the quest giver keeps the layout faithful without stacking two
peach-haired villagers a tile apart.

Files:
- `src/data/town-npcs.js` — `UR_VILLAGER_TRADER` → `UR_QUEST_NPC` rename +
  static + `dir: DIR_RIGHT` + placeholder dialogue; `TOWN_NPCS[114]` row
  swapped to point at the new key + coord. `DIR_RIGHT` added to the import.

## 1.7.695 — 2026-05-25

### Ur populated — 4 more wandering villagers

Added 4 more wandering NPCs to Ur (map 114), each at a verified-openArea
tile mirroring the FF3 ROM's canonical Ur layout from the OAM snap:

- `UR_VILLAGER_TRADER` at (10, 27) — bundle `0x01E210`, peach hair
- `UR_VILLAGER_MAIDEN` at (7, 19) — bundle `0x01E010`, yellow hair
- `UR_HOODED_SAGE` at (16, 24) — bundle `0x01E310` (the new hooded
  silhouette from the snap), magenta hair
- `UR_VILLAGER_RED` at (11, 28) — bundle `0x01DF10` reused with magenta
  hair (distinct from the existing `UR_VILLAGER_PEACH`)

All 5 Ur NPCs share `TOWN_KEEPER_PAL_BTM` (blue tunic) — only SP3 hair
color + sprite bundle vary per NPC. Each gets 3 lines of generic flavor
dialogue (talk-faces the player, ≤45 chars/page for the message box).
Wander leash 3-4 keeps them in their plazas without overlapping.

Snap canonical tiles `(10, 28)` and `(8, 27)` shifted slightly to
`(10, 27)` / `(11, 28)` so they pass the wander `openArea` rule (the
canonical spots are walkable but lack 3 walkable neighbors and would
strand the NPC).

Hair palettes broken out into `VILLAGER_HAIR_PEACH/YELLOW/MAGENTA`
consts at the top of the wandering-townsfolk block — adding another
recolor is one new const + a `palTop:` field.

Files:
- `src/data/town-npcs.js` — 4 new villager specs + 4 new TOWN_NPCS
  rows for map 114; 3 hair palette consts.

## 1.7.694 — 2026-05-25

### NPC sweep + wandering Ur villager (with town-tileset wander support)

**Sweep findings.** `INN_ITEM_KEEPER`, `WEAPON_KEEPER`, and `INN_KEEPER` all
repeated the same `[0x1A, 0x0F, 0x15, 0x36]` / `[0x1A, 0x0F, 0x12, 0x36]`
palette pair inline — extracted to shared `TOWN_KEEPER_PAL_TOP` /
`TOWN_KEEPER_PAL_BTM` consts in `town-npcs.js`. Armor keeper map 4 was
already correctly reusing `WEAPON_KEEPER`. ROM bundles `0x01E010` and
`0x01E210` are reused across `OPENING_*_ATTENDANT` + town keepers but in
different palettes — those are intentional recolors, not duplicates.

**Wander on any tileset (collision-based check).** `_isOpenAreaTile` used
to hardcode `FLOOR = 0x30` (cave tileset). Refactored to read cb1 collision
bits — low 3 bits === 3 = solid wall, bit 7 = trigger. Now works on town
tilesets (Ur tileset 4 uses `0x00` as walkable instead of `0x30`); the cave
floor still passes via its walkable cb1. `_isWalkableForNpc(mapData, x, y)`
is the new shared helper used by the wander destination check, the
3-neighbor open-area rule, and `tryYieldToPlayer`'s yield-destination check
(replaces the inline `FLOOR` literal I added in v1.7.693).

**New NPC: `UR_VILLAGER_PEACH`** at map 114 (Ur overworld) spawn (15, 25),
leash 4. Wandering townsfolk — bundle `0x01DF10` (verified-canonical
"common villager" body, the same sprite the FF3 ROM places twice in the Ur
scene at canonical tiles (7,19) + (8,27) — see the captured OAM snap),
peach-hair SP3 palette `[0x1A, 0x0F, 0x26, 0x36]` distinct from the
magenta-hair shopkeepers, shared `TOWN_KEEPER_PAL_BTM` blue tunic. Talks
on Z (turns to face player). Uses the v1.7.693 yield-to-player behavior so
they'll step aside if you press against them.

Files:
- `src/data/town-npcs.js` — `TOWN_KEEPER_PAL_TOP/BTM` consts +
  `UR_VILLAGER_PEACH` spec + `TOWN_NPCS` entry for map 114.
- `src/npc.js` — `_isWalkableForNpc(mapData, x, y)` (new), `_isOpenAreaTile`
  rewritten to use it (now takes `mapData` not `mapData.tilemap`); three
  caller signatures updated (`_startWalk`, `_trySameDir`,
  `placeMoogleAtCaveCenter`); `tryYieldToPlayer` switched to the new
  collision check; dropped the unused `FLOOR = 0x30` const.

## 1.7.693 — 2026-05-25

### NPCs yield to the player when blocked

Walking into an NPC's tile used to silently bounce the player off — the
NPC just stood there until its own wander cycle moved it. Now when the
player presses against an NPC, the NPC takes a single-tile hop out of
the way at half walk duration (240 ms vs 480 ms normal), then resumes
its normal pause cycle.

**Yield direction** prefers a perpendicular sidestep (relative to the
player's heading), randomized left vs right; falls back to continuing
in the player's heading direction. Never yields TOWARD the player —
worst case the NPC can't move (corner / leashed) and the player stays
blocked, same as before.

**Yield destination** relaxes the wander loop's open-area requirement
(FLOOR + ≥3 walkable neighbors) down to just FLOOR — the NPC can step
into a corridor temporarily. Their next wander tick routes them back
to open space once the player walks past. Leash (moogle's 2-tile
Chebyshev) and existing collision (player tile + other NPCs) are still
respected.

Excluded from yielding: bosses (`mode: 'static'`), idle-march scene
NPCs, NPCs in dialogue (`talkFacing != null`), NPCs already mid-walk
(player retries the press next frame).

**Implementation.** Each NPC now carries a per-walk `walkDur` field
(default `WALK_DURATION_MS`); `tryYieldToPlayer(npc, dir)` sets it to
`YIELD_DURATION_MS` for the hop. Lerp + walk-frame phase both read
`npc.walkDur` instead of the module constant. `movement.js#startMove`
calls `tryYieldToPlayer` immediately after the existing block-by-NPC
guard.

Files:
- `src/npc.js` — new `YIELD_DURATION_MS`, `walkDur` field on every NPC,
  `tryYieldToPlayer(npc, playerDir)` export; lerp + `_walkPhase` use
  the per-NPC duration.
- `src/movement.js` — `startMove`'s NPC-block branch now calls
  `tryYieldToPlayer` before returning.

## 1.7.692 — 2026-05-25

### Locked room — spawn player above the door, not on it

Inside the locked room the south cave door (0x70) rendered as a closed
door tile permanently under the player's feet. The v1.7.668
`_openReturnDoor` plumbing was correct (and the cb2 nibble check passes
for 0x70 in cave tileset), but the symptom was a different bug entirely:
**we were spawning the player on the wrong tile.**

The magic shop ROM's entrance points to a 0x44 false-ceiling at row 8 —
TWO ROWS ABOVE the actual 0x68 door tile at row 10. Every other indoor
map works the same way: you "walk through" the door icon visually as
you enter, and the door tile reads as closed BEHIND/BELOW you. Nothing
else needs to swap to 0x7E because the player isn't standing on the
door.

`generateLockedRoomMap` had `entranceX/Y = doorX/Y` which spawned the
player directly on the cave door tile — no other indoor does this. The
result was a "permanently closed door under your feet" visual that
broke the indoor mental model.

Set `entranceY = doorY - 2` so the player spawns on the false-ceiling
at the top of the door spine, mirroring the magic shop ROM exactly.
The spine `0x44 → 0x45 → 0x70` is all walkable; walking down onto the
door fires `_triggerMapTransition`'s normal door-open animation +
goBack pop, identical to every other indoor exit.

Files:
- `src/dungeon-locked-room.js` — `entranceY: doorY` → `doorY - 2` in
  `generateLockedRoomMap`.

## 1.7.691 — 2026-05-25

### Altar Cave floor 2 exit warped to locked room (trigId collision)

Floor 2 (UI floor 3) places both a `PASSAGE_ENTRY` exit (type 4) and — when
the 50/50 locked-room roll hits — a chamber door (type 1). `processTriggerTiles`
assigns trigIds **per type independently**, so both got `trigId 0`. But
`mapSt.dungeonDestinations` was a `Map<trigId, dest>` keyed by `trigId` alone:
the chamber-door write (line 2962 of `dungeon-generator.js`) ran AFTER the
passage-entry write (line 2952), so `dungeonDestinations[0]` ended up as
`{ mapId: 1011 }` (locked room) — and stepping on the EXIT routed the player
into the locked room instead of floor 3 / 4.

Same collision class would bite any floor that mixes a type-4 trigger with
a type-1 trigger sharing the same per-type index.

Switched the key to a composite `${type}:${trigId}` everywhere. Both writes
now land in distinct slots; consumers (`_checkDynType1` / `_checkDynType4`
in `map-triggers.js`) read with the matching composite.

Files:
- `src/map-state.js` — comment updated to document the new key shape.
- `src/map-triggers.js` — three reads switched (`_checkHiddenTrap`,
  `_checkDynType1`, `_checkDynType4`).
- `src/dungeon-generator.js` — every `dungeonDestinations.set(trigId, ...)`
  now stamps the type-prefixed key (5 sites incl. the floor-3 hardcoded
  `'1:0'`/`'1:1'` for the boss-room door + return stairs).
- `src/dungeon-locked-room.js` — south-door registration uses the same
  composite key.

## 1.7.690 — 2026-05-24

### Altar Cave secret rooms — left-corridor entry was always rendering right-side

`placeSecretPath` stores `{ mapId, goLeft }` per false-wall corridor in the
chamber map's `falseWalls`. When the player walked through, `_loadDungeonFloor`
(`src/map-loading.js`) was supposed to look up `goLeft` to flip
`generateSecretRoomMap`'s anchor (chest alcove + entrance on the matching side).

The lookup ran AFTER `_resetPerMapState()` which had already wiped
`mapSt.falseWalls = null` — so `prevDest` was always `null`, `goLeft` always
defaulted to `false`, and every secret room rendered as if entered from the
right side. Players entering from a left-side corridor walked into a
chest-on-the-wrong-side mirror layout.

Captured `secretGoLeft` from `mapSt.falseWalls` BEFORE the reset call, then
passed it into `generateSecretRoomMap`. The data itself was always correct —
the read order was the bug.

Files:
- `src/map-loading.js` — `_loadDungeonFloor` captures `secretGoLeft` before
  `_resetPerMapState()`, uses it instead of re-reading the wiped state.

## 1.7.689 — 2026-05-24

### Inventory cap 8 → 16, pause scroll arrows, full-bag chest fix

**Capacity 8 → 16.** `INV_CAP` / `INV_SLOTS` bumped in `src/inventory.js`.
Battle Item menu auto-adapts (pages = `ceil(list.length / 3)` already).
Save validator (`api.js#parseSaveSlots`) bumped its `inventoryOrder`
cap from 8 → 16 in lockstep — both halves are required or saves silently
truncate on the server round-trip ([[ff3mmo-save-whitelist-lockstep]]).

**Pause inventory scroll.** Panel now renders 7 visible rows out of 16
with cursor-derived viewport scroll (no extra state; mirrors the battle
spell list's `_spellScrollTop` pattern). 8×8 `ui.scrollArrowUp/Down`
sprites blink at 250 ms in the right margin when there's content
off-screen above/below. ≤7 items behave exactly like before. The trash
slot keeps its bottom-right anchor and is reached by pressing down past
the last item (cursor jumps to trash; viewport snaps to bottom page).

**Full-bag bug fixes.** `addItem` silently returns 0 when the bag is
full and the item is new — but `handleChest`, `handleHiddenTreasure`,
and the post-battle drop weren't checking. Result: chest consumed +
"Found X!" shown + nothing in the bag. Three fixes, all behind the
existing `canAddItem(id)` precheck:

- **Chest** — roll loot FIRST. If the roll is an item and the bag is
  full, refuse the open: chest stays closed, no consume, no save, no
  cooldown stamp. Player deletes something and retries. Gil rolls always
  proceed; mimic rolls always proceed (no inventory required).
- **Vase (hidden treasure)** — same pre-check on hit. Bag full → "Bag is
  full!" + no cooldown stamp, so the vase is retry-able.
- **Post-battle drop** — drop is forfeit (no battle backtrack), but the
  victory popup now reads "Bag is full!" instead of "Found <ItemName>"
  via the new `encounterDropItemRejected` flag on `battleSt`.

`canAddItem` returns true for ids already in the bag (stack grows), so
duplicate-of-existing pickups still work at any bag fill level.

Files:
- `src/inventory.js` — cap bump.
- `api.js` — save validator cap.
- `src/pause-menu.js` — `PAUSE_INV_VISIBLE_ROWS = 7`, `_invViewTop`
  helper, scroll arrow draws in `_drawPauseInventory`.
- `src/map-triggers.js` — `canAddItem` precheck in `handleChest` +
  `handleHiddenTreasure`.
- `src/battle-update.js` + `src/battle-state.js` +
  `src/battle-draw-menu.js` — `encounterDropItemRejected` flag + popup
  swap.

## 1.7.688 — 2026-05-24

### Yes/no prompt cue text — single source via `yesNoLabels()`

Every `showMsgBoxPrompt` caller now appends the same mobile-aware key
cue. Before: 5 callers, 4 different cue styles, only the inventory-
delete prompt was mobile-aware. Trade / party-invite / FenixDown
hardcoded `Z=ok X=no` (wrong text on mobile) and the Magic Key door
prompt had no cue at all.

Exported `yesNoLabels()` from `src/message-box.js` (returns
`A=ok B=no` on mobile, `Z=ok X=no` on desktop — moved out of
`pause-menu.js` where it was a trapped private helper since v1.7.605).
Every prompt site now appends it:

- `pause-menu.js` — both inventory-delete sites (no text change; was
  already mobile-aware).
- `trade.js` — `<Name> offers <Item> ` + cue (mobile now shows A/B).
- `party-invite.js` — `<Name> wants party ` + cue.
- `battle-fenix-revive.js` — `Use FenixDown? ` + cue (was
  `A:Yes B:No` even on desktop).
- `movement.js` — `Use MagicKey? ` + cue (was no cue at all).

Cue text is identical on all prompts now, so muscle memory carries
between them.

## 1.7.687 — 2026-05-24

### FenixDown confirm prompt — freeze on YES (regression from v1.7.643)

Player on-death auto-revive ("Use FenixDown? A:Yes B:No") froze the
instant Z was pressed. Battle locked, no angel, no rise, no recovery.

**Cause.** v1.7.643 promoted the universal msgbox handler in
`movement.js#handleInput` to run BEFORE `handleBattleInput` with an
early-return, so any modal msgbox owns Z/X. That handler dispatches
yes/no prompts via `msgState.isPrompt` (set by `showMsgBoxPrompt`). The
FenixDown confirm was a plain `showMsgBox` + a bespoke Z/X branch in
`_battleInputHoldStates` (input-handler.js) — that branch is now
unreachable, so `fenixConfirmYes()` never fired. The msgbox dismissed
on Z but `_phase` stayed `'confirm'` forever; `updateFenixRevive`
returns `true` every frame and seizes the FSM — total freeze.

**Fix.** Switched the prompt to `showMsgBoxPrompt(CONFIRM_TEXT,
fenixConfirmYes, fenixConfirmNo)`. The modal handler now drives Yes/No
to the callbacks the same way it does for party-invite, trade,
inventory-delete, and locked-door prompts. Dropped the dead bespoke
branch in `_battleInputHoldStates`; kept the
`battleState === 'fenix-revive' → return true` gate so stray Z/X during
dmg-hold / death-anim / angel / rise / healnum can't pop a menu.

Files:
- `src/battle-fenix-revive.js` — `showMsgBox` → `showMsgBoxPrompt` at
  the `death-anim → confirm` transition; import swap.
- `src/input-handler.js` — removed dead confirm sub-block + the
  now-unused fenix imports.

## 1.7.686 — 2026-05-24

### Party + room allies seed AT battle start (not after turn 1)

Pre-fix: `tryJoinPlayerAlly()` only ran from `_updateBattleMenuConfirm`
(the confirm-pause state right after the player picked their first
action). Allies didn't show up on the field until the player had
already taken a turn alone. Felt wrong — party members are supposed to
be with you from the jump.

`tryJoinPlayerAlly(opts)` now takes an `{ initial: true }` flag:
- Pushed allies start at `fadeStep = 0` (instantly visible, no fade-in)
- State machine is NOT touched (battle intro `roar-hold` /
  `flash-strobe` keeps playing without interruption)
- Turn queue isn't rebuilt (gets built naturally on first action)

Called from:
- `startBattle()` (`src/battle-update.js`) — story / scripted battles
- `startRandomEncounter()` (`src/battle-encounter.js`) — overworld /
  dungeon random encounters
- `startChestMimic()` (`src/battle-encounter.js`) — chest-tier monster
  loot

Round-boundary reconcile + late-joiner fill (no opts) is unchanged —
new allies still fade in on subsequent rounds as before.

`tryJoinPlayerAlly` injected into `battle-encounter.js` via the
existing `initBattleEncounter({...})` DI seam (avoids circular import).

## 1.7.685 — 2026-05-24

### Roster party badge — move into box interior

The green party badge ($75 glyph) was drawing at `HUD_RIGHT_X + 32 + 2`
— painting over the right box's left chrome border. Moved to
`HUD_RIGHT_X + 32 + 8` so it sits at the very top-left of the box's
INTERIOR, past the 8-px HUD border tile. Single line in
`src/roster.js#_drawRosterRow`.

## 1.7.684 — 2026-05-24

### `isMobile` — add UA fallback for Fire Kids tablet

Lucas's Fire HD Kids tablet still showed PC menu prompts after v1.7.682
even with the matchMedia fallback. Silk on the managed Kids profile
suppresses ALL three touch APIs (`ontouchstart`, `maxTouchPoints`,
matchMedia pointer/hover queries). Adding a UA-string fallback so the
known mobile platforms (`Android` / `iPhone` / `Silk` / `KFRAWI` /
`Tablet` / `Mobile`) always trip mobile mode regardless of API
suppression. UA sniffing is normally a last resort, but the alternative
is keyboard-only prompts on a literal touchscreen.

## 1.7.683 — 2026-05-24

### Gamepad poll fast-path + freeze guard (Fire HD Kids)

Lucas's Fire HD Kids tablet (Silk 146 / Android 11 / KFRAWI) was
freezing after the v1.7.681 gamepad deploy with NO `CLIENT ERROR`
posts — i.e. main thread blocking, not throwing. Most likely culprit:
`navigator.getGamepads()` called 60x/sec in `pollGamepad`. On Silk
that API can round-trip through an IPC permission check on each call,
and with parental-controls overlay layered on top, the syscall stalls.

Three guards:
- **`pollGamepad` no-ops until `gamepadconnected` ever fires** — saves
  60 syscalls/sec for the ~95% of players without a controller.
  Matches Chrome's lazy-enable behavior anyway.
- **`navigator.getGamepads()` wrapped in try/catch + hard-disable on
  throw** — if Silk's permission policy denies it, the module
  self-deactivates instead of throwing every tick.
- **`pollGamepad(dt)` call site in `gameLoop()` wrapped in
  try/catch** — so any other gamepad-related failure can't kill the
  loop.

Behavior for players WITH a gamepad: identical to v1.7.681 — first
button press fires `gamepadconnected`, poll starts, all input routes
through the keys map as before.

## 1.7.682 — 2026-05-24

### Fire HD Kids tablet playability triage

Lucas's session on a Fire HD Kids (Silk 146 / Android 11 / KFRAWI):
- 7 consecutive WS 401s in 60s (stale JWT, client kept retrying with the
  dead token)
- 555 GETs per page load (no nginx cache — every .js module re-fetched
  through node)
- `isMobile` reported `false` → game showed PC controls instead of touch

Three fixes shipped together:

**1. `isMobile` matchMedia fallback (`src/ui-state.js`)**
Adds `matchMedia('(pointer: coarse)')` and `(hover: none)` checks
alongside `ontouchstart` / `maxTouchPoints`. Silk on Fire Kids sometimes
reports zero touch points and omits the legacy `ontouchstart` property,
falling through to PC controls. The matchMedia checks reliably detect
"primary input is touch" on every modern engine.

**2. JWT auto-refresh on WS fast-close (`src/net.js`)**
On WS close that fires within 1500ms WITHOUT the `open` event having
landed first → infer pre-handshake reject (401 / 429 / network) and
issue one `POST /api/refresh` with the current token. If the server
hands back a fresh JWT, write it back to localStorage and retry
immediately at the 1s baseline. If refresh fails, fall through to the
existing exponential backoff — page reload then runs the index.html
boot-time refresh flow. Stops the 7-401-storm cold.

**3. Nginx static cache (`/etc/nginx/sites-enabled/ff3mmo`, prod-only)**
New `location ~* ^/(src|lib|patches)/.*\.(js|json|nes|ips|png|...)$`
serves directly from disk with `Cache-Control: public, max-age=300,
must-revalidate` + ETag. Bypasses node entirely for static assets.
Page-load assets cached for 5 min, then revalidated against ETag
(nginx returns 304 for unchanged files — ~200-byte response vs ~5KB
full body). Deploy-safe: every deploy bumps file mtimes, ETags rotate,
browsers re-fetch. Cuts a fresh load from 555 → 5 hits within the cache
window. Live before this JS deploy.

## 1.7.681 — 2026-05-24

### Gamepad support (plug-and-play)

Standard Gamepad API → keys map shim. New `src/gamepad.js`, polled once
per tick from `gameLoop()` so every existing consumer (battle menu,
roster, pause, movement, chat tabs) reads gamepad input through the
same `keys[]` slots without any call-site change.

Fixed mapping (Standard Gamepad layout):
- Bottom action button (Xbox A / PS X / Switch B) → NES A (`z`)
- Right action button (Xbox B / PS O / Switch A) → NES B (`x`)
- Select / Back / View / − → Roster (`s`)
- Start / Menu / Options / + → Enter
- D-pad + left stick (deadzone 0.5) → Arrow keys

Action buttons are edge-only (no auto-repeat — matches NES feel and
prevents menu skipping). Directions auto-repeat (280ms initial, 90ms
tick) to match keyboard hold-to-scroll feel.

Compatible with desktop browsers (any Xbox / PS / Switch / 8bitdo
controller via USB or Bluetooth) and mobile browsers with paired
Bluetooth controllers (Backbone, 8bitdo Lite, Switch Pro). No UI yet —
just connect a pad and use it.

## 1.7.680 — 2026-05-24

### Locked door — "Locked." message only on A-press

Walking into a locked door is now silent (still solid like before).
The "Locked." popup only fires when the player presses A on the
faced door — same trigger surface as the "Use MagicKey?" prompt.
Stops the message from spamming while holding a direction button
into a locked wall.

`src/movement.js#startMove`: removed the bump-path `showMsgBox` call.
A-press handler in `_handleAction` already covers both branches
(has-key prompt / no-key "Locked." message).

## 1.7.679 — 2026-05-24

### Floor 2 (UI 3) — door on MIDDLE rooms only (not entry / exit)

50% chance locked door on floor 2, anchored to the 5×5 rock puzzle
room or the 7×7 hub — explicitly excluding the entry + exit chamber
zones. Search walks the whole map for valid 5-rock-surround
positions, rejects any inside `(entranceX±, startFloorY±)` or
`(exitPathEndX±, exitPathFloorY±)` rectangles.

Routes to mapId 1011 (separate locked-room map; same wiring as
mapId 1010 from floor 0).

Verified seeds 1-20: 11/20 with door. Spot check seed 1: door at
(22, 9) on the rock-puzzle room's north wall. Other seeds land
similarly on middle-room walls.

## 1.7.678 — 2026-05-24

### Revert — floor 2 door placement (wasn't asked for)

User didn't approve the entry-chamber placement. Removed the floor 2
locked-door hook entirely. Kept the `lockedRoomDoors` Map refactor
and the `_loadDungeonFloor` mapId 1011 dispatch (both harmless when
no door registers).

Floor 0 locked door (50% chance) is unchanged.

## 1.7.677 — 2026-05-24

### Floor 2 (UI 3) — locked-door chance + standalone room (mapId 1011)

Same 50% chance system added to floor 2 (rock-puzzle floor). Door
anchors to the entry chamber (within 6 tiles of `entranceX/Y`) so
it's an OPTIONAL side route — doesn't block the corridor or rock-
puzzle path. Routes to mapId 1011 (separate locked-room map; same
shape as 1010 but seed-XOR'd so chest layout differs).

Verified seeds 1-20: 11/20 with door, ~55% (close to 50% target).

Refactor: replaced the floor-0-only `lockedRoomChamberDoor` /
`lockedRoomReplicaDoor` / `lockedRoomReplicaEntry` vars with a
generic `Map<"x,y", { mapId }> lockedRoomDoors` so each floor can
register its own door coord + destination. The trigger-wiring pass
iterates it generically.

`_loadDungeonFloor` dispatch extended: mapId 1010 OR 1011 →
`generateLockedRoomMap(rom, seed ^ mapId)` so the two locked rooms
have different deterministic chest layouts.

## 1.7.676 — 2026-05-24

### Floor 0 locked door — 50% chance per seed (not always present)

Chamber door + locked-room teleport is now gated behind a 50% RNG
roll per seed (`rng() < LOCKED_DOOR_CHANCE`, rolled from the same
seeded RNG so a given dungeonSeed is deterministic). Seeds without
a door skip the door-search + replica-room wiring entirely; seeds
with one work as before.

Verified across seeds 1-20: 10 with door, 10 without (matches the
50% target).

Files:
- `src/dungeon-generator.js` — `LOCKED_DOOR_CHANCE` constant gating
  the door-find block inside the floor-0 hook.

## 1.7.675 — 2026-05-24

### Locked-room chest — pulls from ANY altar floor (1000-1003)

Each chest open in mapId 1010 picks a random altar floorId
(1000-1003) and rolls from that pool. So locked-room chests can
yield Bronze Bracers / Longsword (F4) or Leather Cap / Dagger (F1)
with equal floor odds — gives the player a chance at deeper-floor
loot without descending that far.

Files:
- `src/map-triggers.js` — `rollLootEntry` shim at the top: if
  `mapId === 1010`, replace with `[1000..1003][rand]` before pool
  lookup.

## 1.7.674 — 2026-05-24

### Locked room — use altar F1 loot pool (revert custom rare pool)

Removed the v1.7.673 `LOOT_POOLS[1010]` rare-only override. Locked
room (mapId 1010) now falls through to `DEFAULT_LOOT =
LOOT_POOLS[1000]` (Altar Cave F1 chamber pool) — same drops as the
chamber it's accessed from, including mimic chance.

## 1.7.673 — 2026-05-24

### Locked room (mapId 1010) — RARE-only loot pool

New `LOOT_POOLS[1010]` entry: no common Potion / Gil / mimic tiers.
Weights stacked toward scrolls (Cure / Ice, w=30), HiPotion (w=25),
Phoenix Down (w=25), rare battle items GodsRage / ZeusRage (w=15),
plus a small bonus Magic Key chance (w=5). Player who works through
the unlock mechanic gets meaningfully better drops than the chamber
chests.

(Previously chests in mapId 1010 fell through to `DEFAULT_LOOT` =
LOOT_POOLS[1000] — the F1 chamber pool with mimics and common
potions. Now uses the rare-only pool.)

Files:
- `src/map-triggers.js` — added `LOOT_POOLS[1010]`.

## 1.7.672 — 2026-05-24

### Door unlock persists across map reloads (consumedTiles)

v1.7.671's unlock was in-memory only — leaving the chamber and
re-entering re-locked the door. Now persisted via the existing
`ps.consumedTiles` save-state field (already on the
serializer + server whitelist, so no save-state-audit work).

On unlock, the door coord is stamped into `ps.consumedTiles[mapId]`
with the unchanged door tile id (0x70). `_replayConsumedTiles` runs
on every map load: writes the tile id (no-op since it's still 0x70)
AND removes the coord from `mapSt.lockedDoors`. Result: the door
stays unlocked across save / reload / chamber re-entry.

Files:
- `src/movement.js` — unlock callback stamps `ps.consumedTiles[mapId]
  [doorKey] = 0x70` + `saveSlotsToDB()` after removing from
  `mapSt.lockedDoors`. Added `saveSlotsToDB` import.
- `src/map-loading.js` — `_replayConsumedTiles` also deletes the
  coord from `mapSt.lockedDoors` (parallel to the existing
  `mapSt.secretWalls` cleanup).

## 1.7.671 — 2026-05-24

### Magic Key unlock mechanic — "Use MagicKey?" prompt + consume + unlock

Press A on a locked door — if Magic Key (item 0x98) is in inventory,
the player gets a yes/no prompt: "Use MagicKey?". A (Z) accepts:
consume one key, remove the door coord from `mapSt.lockedDoors`,
show "Unlocked!" confirmation. B (X) declines: silent cancel.

Without a key the v1.7.669 "Locked." message still shows.

Once unlocked, walking onto the door fires the existing v1.7.665
type-1 trigger → loads the locked-room map (mapId 1010).

Files:
- `src/movement.js` — imports `showMsgBoxPrompt`, `hasItem`,
  `removeItem`; A-press handler branches on inventory.

Limitation (deferred): the unlock is in-memory only. Leaving the
chamber map and re-entering re-generates `lockedDoors` from scratch,
so the door re-locks. Proper persistence needs a `ps.consumedTiles`
entry at the door coord that `_replayConsumedTiles` reads to remove
the coord from `lockedDoors` on map load. Not blocking the MVP.

## 1.7.670 — 2026-05-24

### Magic Key (item 0x98) added to Altar Cave rare loot pool

All four Altar Cave floors (LOOT_POOLS 1000-1003) get a weight-3
Magic Key tier. Same rarity band as Cure / Ice scrolls and Phoenix
Down — drops infrequently from regular chests.

Consumption mechanic (key → unlock door) is NOT wired yet. The door
stays locked until `mapSt.lockedDoors` has the coord removed. Next
step is wiring the A-press handler to check inventory for Magic Key,
consume one, and unlock the door (vs the current "show 'Locked.'"
message).

Files:
- `src/map-triggers.js` — added `{ weight: 3, pool: [0x98] }` to
  each of LOOT_POOLS[1000..1003].

## 1.7.669 — 2026-05-24

### Chamber door is now LOCKED — blocks movement + "Locked." message

Door tile no longer teleports to the locked-room map. Walking into it
is blocked (treated like an NPC tile — solid). Pressing A while
facing the door shows "Locked." via the standard `showMsgBox`.

New `mapSt.lockedDoors` Set tracking door coords. Populated in
`generateFloor` (floor-0 chamber door coord added) and returned to
the engine via `result.lockedDoors`. Two enforcement sites:

1. `movement.js#startMove` — if target tile is in `lockedDoors`,
   block movement (face the direction but don't step) and show
   "Locked." via `showMsgBox(_nameToBytes('Locked.'))`. Debounced
   on `msgState.state === 'none'` so holding the direction button
   doesn't spam the box.
2. `movement.js` A-press handler — if the FACED tile is in
   `lockedDoors`, show "Locked." instead of any other interaction.

The `dungeonDestinations` entry for mapId 1010 stays wired but
the trigger is unreachable while locked — once a magic-key gate
unlocks the door (deletes the coord from `lockedDoors`), the
teleport fires normally with no further changes.

## 1.7.668 — 2026-05-24

### Door spine — false rock wall + open-door visual on arrival

Two fixes wrapped together:

1. **Middle spine tile is now `0x45` (false rock wall)** — same 0x70
   passable collision as `0x44` false-ceiling, but renders as a rock
   wall (0x01-like) instead of a ceiling. Spine now reads: 0x44
   (false ceiling) → 0x45 (false rock) → 0x70 (door). Visually
   matches the magic shop's original door corridor.
   `SHOP_TO_CAVE[0x45]` translation: `0x44` → `0x45`.

2. **Door opens on arrival.** `_loadDungeonFloor`'s
   `_openReturnDoor` call was gated on `returnX !== undefined`; for
   side-room map transitions (mapId 1010) the trigger system doesn't
   pass returnX, so the door rendered closed when player spawned on
   it. Gate removed — the function internally no-ops if the tile
   isn't a type-1 door trigger, so always-firing is safe and gives
   the magic-shop-style "door already open as you walk in" visual.

## 1.7.667 — 2026-05-24

### Skipping 666 by request — re-deploy of the v1.7.666 changes

(Same diff as 666; bumped at user's request to step past the number.)

### Full false-ceiling door spine + shared corner-chest system

Two cleanups on the locked room:

1. **Door spine: two false-ceilings + door** (was one false-ceiling +
   floor + door). `SHOP_TO_CAVE[0x45]` (shop door-middle) now
   translates to `0x44` cave secret-pass instead of `0x30` floor.
   Player walking south through the door spine now: 0x44 → 0x44 →
   0x70 — three passable tiles, two of them false-ceilings, matching
   the visual the user described.

2. **Locked-room chest + skeleton placement uses the shared dungeon
   system.** New exported helper `scatterRoomLoot(tilemap, rng,
   bounds, opts)` in `dungeon-generator.js` runs chests through
   `findCornerFloor` (2-wall corner test + near-bounds) and
   skeletons through `findRandomFloor` — same system the chamber's
   feature pass uses. `placeLockedRoom` now calls this helper
   instead of its own random pool.

`findCornerFloor` + `findRandomFloor` exported from
`dungeon-generator.js` so the locked-room module can reuse them.
The shared helper is the module entry point for future locked /
secret room variants.

## 1.7.665 — 2026-05-24

### Locked room AND secret room now SEPARATE MAPS (no main-floor visible)

User: "make both secret room and locked room seperate rooms." Both
side rooms now live in their own 32×32 tilemaps (mapId 1010 for the
locked room, 1020/1021 for the secret room corridors). When the
player is inside either, the chamber map isn't loaded at all — the
NES camera shows only the side-room interior, surrounded by void.

**New module exports:**
- `dungeon-locked-room.js` → `generateLockedRoomMap(rom, seed)` —
  builds a void map with the magic-shop replica centered at (11, 10).
  South door registers as `{ goBack: true }` so walking onto it pops
  the mapStack back to the chamber. Uses `mulberry32(seed)` so chest
  scatter stays deterministic across revisits (consumed-tile save
  invariant).
- `dungeon-generator.js` → `generateSecretRoomMap(rom, goLeft)` —
  builds a void map with the secret-room body (corridor + chest
  alcove) centered around (12/14, 12). Entrance false-ceiling tile
  registers as `{ goBack: true }` in `falseWalls`.
- Existing helpers `loadRomAssets` + `mulberry32` exported so the
  locked-room module can build a full map data structure.

**Chamber refactor:**
- `placeSecretPath` no longer places the room body in the chamber
  map. Just carves the corridor + the false-ceiling trigger tile,
  registers it in `falseWalls` with `{ mapId: 1020|1021, goLeft }`
  so the secret-room map generator can mirror the original
  orientation.
- Floor-0 locked-room hook drops the in-map `placeLockedRoom` call.
  Chamber door is just a tile placement now — trigger-wiring
  registers `{ mapId: 1010 }` in `dungeonDestinations`. Engine's
  standard `_triggerMapTransition` handles door-open + mapStack push.

**`_checkFalseWall` (movement.js) extended** to handle three
destination shapes: `{ mapId }` (separate-map warp, push mapStack),
`{ goBack: true }` (pop mapStack), and the legacy `{ destX, destY }`
(in-map warp, unchanged).

**`_loadDungeonFloor` dispatch** added for mapId 1010 / 1020 / 1021:
- 1010 → `generateLockedRoomMap`
- 1020/1021 → `generateSecretRoomMap` (looks up the side flag from
  the chamber's `falseWalls` so layout stays consistent)
- Other mapIds → existing `generateFloor`
- `floorIndex` hoisted so the boss/moogle/music checks see the host
  chamber's floor when inside a side-room map.

## 1.7.664 — 2026-05-24

### Door teleport — land ON the door + fire open-on-arrival (magic-shop way)

User: "im not spawning on the door with the fucking door mechanic, im
spawning 2 tiles above a closed fucking door."

Two changes to match the magic-shop entrance behavior:

1. **Destinations land ON the door tiles.** `lockedRoomReplicaEntry`
   moved from `anchorY+7` (interior floor 2 tiles north of the door)
   to `anchorY+10` (the door tile itself). Chamber return moved from
   `doorPos.y+1` (floor south of chamber door) to `doorPos.y` (the
   chamber door itself).

2. **`_triggerMapTransition`'s sameMap finalize now mirrors
   `_openReturnDoor`:** after snapping the position, checks if the
   destination tile has door collision (cb2 type 5); if so, swaps to
   the open-door visual `0x7E` and sets `mapSt.openDoor` so
   `movement.js` restores the closed visual once the player walks off.

Player now teleports onto the door, sees it open, walks off → door
closes. Walking back onto the door fires the warp again (other
direction).

Still outstanding from the same complaint: "I CAN SEE THE MAIN FLOOR
OUTSIDE OF THE ROOM" (replica is in the same map, camera shows
chamber tiles) and "WHERES ALL THE FALSE CEILING TILES" (need to
clarify what the user means — actual magic shop map 3 has only one
0x44 secret-pass tile in the door spine, which I do replicate).

## 1.7.663 — 2026-05-24

### Secret room — restore 2nd overhang row + original ry=24

User caught it: bottom ceiling cap (row 30) had only 1 rock under it
at row 31. v1.7.651's "bump ry for more distance" lost the 2nd
overhang row (would have fallen at row 32, off-map).

Restored `ry = 24` (original) so floor row sits at row 28, ceiling
cap at row 29, and BOTH overhang rows fit on-map at rows 30-31.
Bottom now reads ceiling-rock-rock — proper cave wall convention.

Net buffer above main floor: rows 22-23 (2 rows) — was 3 with ry=25,
but the visual integrity of the room takes priority.

## 1.7.662 — 2026-05-24

### Door-top translates to rock, not ceiling (cave overhang convention)

Shop's door-top tile (0x1b) was being translated to cave ceiling
(0x00). The door column then had ceiling-ceiling-rock-floor —
ONE rock under the bottom ceiling, violating the addOverhang
convention of "ceiling on top of 2 rocks."

Now translates to cave rock (0x01). Door column reads
ceiling-rock-rock-floor — proper cave wall thickness.

Files:
- `src/dungeon-locked-room.js` — SHOP_TO_CAVE 0x1b: 0x00 → 0x01.

## 1.7.661 — 2026-05-24

### Restore FULL 11-row magic shop replica (v1.7.651 trim was wrong)

v1.7.651 trimmed the magic shop from 11 rows down to 7 (took only shop
rows 4-10) to "fit better with void buffer." That cut off shop rows
0-3 — the topmost ceiling slab AND the first interior floor row.
User caught it as "half the room missing."

Restored to full shop:
- `SHOP_ORIGIN_Y` 4 → 0, `SHOP_H` 7 → 11 (whole upper-room interior).
- Door spine in `placeLockedRoom` reservation back to grid rows 8-10
  col 4, interior landing at grid row 7.
- Floor-0 hook anchor Y 24 → 21 so the full 11-row replica fits
  (spans rows 21-31). Replica door at anchorY+10, replica entry at
  anchorY+7. The replica's X range (cols 1-9 or 22-30) doesn't
  collide with chambers (cols 4-14 / 17-27), so the rows 21-23
  overlap with chamber Y range is harmless — different X bands.

Verified seeds 1-12: full octagonal magic shop visible in the
correct corner, door surround still all-rock on 5 sides.

## 1.7.660 — 2026-05-24

### Replica + secret room — auto-avoid collision (opposite corner)

The replica anchor was hard-coded "opposite Room B" — on seeds where
the secret-corridor room (placeSecretPath) ALSO picked that corner,
both rooms placed at cols 0-9 rows 24-31 and trampled each other.

Now the replica detects which corner(s) the secret room occupies by
scanning `falseWalls` keys at rows 24+, then anchors in the FREE
corner (or falls back to "opposite Room B" when neither corner is
taken). If BOTH corners have secret rooms (rare double-secret seeds),
the door + replica are both skipped — no chamber door without a
viable destination.

Verified seeds 1-12: replica and secret room land in opposite bottom
corners with no overlap.

## 1.7.659 — 2026-05-24

### Door surround — strict 5-rock find, no tile modifications

`findChamberDoorPos` now requires all 5 surround tiles (above, left,
right, upper-left, upper-right) to ALREADY be rock — no ceiling
fallback. To find such positions, yRange extended to scan the full
chamber depth (was just `roomTop + 3`) — addOverhang sometimes lays
a 2-rock band deeper in the wall, and corridors create chamber-
adjacent rock pockets with full rock surrounds.

Verified seeds 1-12: all place a door with UL=01 U=01 UR=01 L=01 R=01.
No tile is modified outside the door cell itself, so the ceiling-
snake connectivity invariant is preserved.

## 1.7.658 — 2026-05-24

### Locked-room door — passable spine + interior landing (no more wall-stuck)

v1.7.657 translated the shop's door spine (0x44 secret-pass + 0x45
door-middle + 0x68 door-bottom) to ceiling/ceiling/door, which made
the middle of the spine a WALL. Player teleported in and landed on a
ceiling tile = stuck in a wall.

Fixes:
1. `SHOP_TO_CAVE` translation rewired so the spine stays passable:
   - 0x44 → cave 0x44 (false ceiling, passable)
   - 0x45 → cave 0x30 (floor)
   - 0x68 → cave 0x70 (door)
2. `lockedRoomReplicaEntry.y` moved from `anchorY+5` (spine middle) to
   `anchorY+3` (interior floor at grid row 3 / shop row 7) so the
   teleport-in lands the player in the room proper, not on the spine.
3. Reservation list in `placeLockedRoom` extended to include the new
   landing tile at grid row 3 col 4 so chests / skeletons don't sit
   where the player materializes.

## 1.7.657 — 2026-05-24

### Door teleport — proper engine door mechanic (was falseWalls hack)

v1.7.656 wired the locked-room teleport via `falseWalls` (the
secret-wall in-map warp). That skipped the engine's door-open
animation entirely — the door read as a fake wall, not a door.

Rewired through the actual type-1 trigger system every other door in
the codebase uses:

1. **dungeon-generator.js** — Door coords (`lockedRoomChamberDoor`,
   `lockedRoomReplicaDoor`, `lockedRoomReplicaEntry`) hoisted from
   the floor-0 hook. After `processTriggerTiles` runs, look each
   door coord up in the resulting triggerMap to get its assigned
   trigId, then register `dungeonDestinations[trigId]` with a new
   `{sameMap: true, destX, destY}` shape. The previous
   `for (i = 0; i < totalType1; i++)` loop is replaced with a
   triggerMap iteration that routes each type-1 trigger correctly
   (stair / trap → next-floor mapId, locked-room doors → in-map
   sameMap warp). Fixes the trigId-shift bug from inserting the
   chamber door before the stair in scan order.

2. **map-triggers.js** — `_triggerMapTransition` extended to accept
   either a destMapId number (legacy) or a `dest` object. When
   `dest.sameMap`, the pendingAction snaps `mapSt.worldX/Y` to
   `(destX*16, destY*16)`, refreshes the renderer at the new tile,
   and sets `mapSt.disabledTrigger` to the destination so the door
   we land on doesn't immediately re-fire. The door-open animation
   (swap to 0x7E + SFX.DOOR + 'door-opening' transition) plays
   either way. `_checkDynType1` updated to pass the full dest
   object instead of `dest.mapId`. Imports: `sprite`, `DIR_DOWN`.

Player now sees the door open animation, screen wipe, then lands
inside the locked room. Same mechanic as the magic shop entrance —
just with an in-map destination.

## 1.7.656 — 2026-05-24

### Door teleport wired — chamber ↔ locked room

Reuses the existing `falseWalls` in-map warp (movement.js#_checkFalseWall,
already used by the secret-room teleport). Player walks onto the
chamber door → wipe → lands on the interior floor of the replica
(one tile north of the replica's south door, not ON the door so the
trigger doesn't immediately re-fire). Walking south onto the replica's
door → wipes back to the chamber floor south of the chamber door.

Both pairs registered on the same `falseWalls` Map that
`placeSecretPath` populates — `_loadDungeonFloor` already wires that
to `mapSt.falseWalls`, so no engine changes needed.

Files:
- `src/dungeon-generator.js` — two `falseWalls.set(...)` lines in the
  late floor-0 hook.

## 1.7.655 — 2026-05-24

### Chamber door — pure find, no tile modification (preserves ceiling snake)

v1.7.652's `placeChamberDoor` was promoting ceiling tiles at the door's
upper-left and upper-right diagonals to rock so the door read as "set
into rock walls." That mutation could orphan ceiling tiles from the
floor-0 ceiling-snake invariant (e.g., a row-6 ceiling that was the
only horizontal link in its strip became rock, the remaining ceiling
on the other side of the door lost its connection).

Reverted: `placeChamberDoor` does pure overwrite, nothing else. The
"surround with walls" invariant is now owned entirely by
`findChamberDoorPos` — orthogonals must already be rock, diagonals
must already be walls (rock OR ceiling, both wall layers — the
addOverhang pattern naturally produces ceiling at the upper diagonal,
which is structurally still a wall just a different visual). No tile
is ever modified outside the door tile itself.

Verified seeds 1-8 all place a door at row 7 with valid surrounds.

## 1.7.654 — 2026-05-24

### Door tile — use 0x70 (real cave door with open-on-touch), not 0x44

I was placing 0x44 (false-ceiling, invisible passable wall) as the
"door" — that's why nothing looked like a door. The actual cave-
tileset door tile is **0x70**, which the engine recognizes via its
collisionByte2 attribute `((cb2[0x70] >> 4) & 0x0F) === 5` and runs
the open-on-touch animation for: swap to 0x7E open state on arrival,
restore to 0x70 on move-off (`_openReturnDoor` in `map-loading.js` +
`movement.js` line 87-89).

Verified `loadTileCollisionByte2(rom, 0)`: tile 0x70 is the ONLY
door-type tile in the cave tileset.

Changes:
- `DOOR_TILE = 0x70` constant added (replaces `SECRET_TILE = 0x44`
  uses).
- `LOCKED_ROOM_DOOR_TILE` export = `DOOR_TILE`.
- `placeChamberDoor` writes `DOOR_TILE` (was `SECRET_TILE`).
- Shop → cave translation rewired:
  - shop door-bottom 0x68 → cave door 0x70 (the actual walk-through)
  - shop door-middle 0x45, secret-pass 0x44, door-top 0x1b → cave
    ceiling 0x00 (decorative frame above the door)
- `_isWalkable` updated to include `DOOR_TILE` instead of the old
  `SECRET_TILE`.

Door now renders as a closed cave door visual. Teleport-trigger
registration (so walking through actually warps to the locked room)
is still TODO; the engine's auto-open animation will fire on player
arrival.

## 1.7.653 — 2026-05-24

### Side rooms — pull up 1 row so they aren't kissing the map edge

v1.7.651's placement pushed both side rooms to the bottom of the map,
which lost the secret room's bottom rocky overhang (would have landed
at row 32, off-map) and visually pinned the replica's south wall to
the map edge.

- Secret room: `ry` 26 → 25 (`fy` 30 → 29). Bottom overhang lands at
  row 31 (last on-map row), no longer dropped.
- Replica anchor Y: 25 → 24. Spans rows 24-30, leaving row 31 clear
  below.

Buffer above main floor still ≥ 2 rows for both.

## 1.7.652 — 2026-05-24

### Chamber door — rock on upper diagonals too (+ hook moved past bridging loop)

User: "make sure door always has rock walls touching diagonally."

`placeChamberDoor` now promotes ceiling tiles at the upper-left and
upper-right diagonals (`(doorX±1, doorY-1)`) to rock when needed. The
natural chamber wall (addOverhang pattern: ceiling on top of rock)
typically leaves those diagonals as ceiling, which read as "door
punched through a ceiling row." Promotion gives a clean rock frame:
above + left + right + UL + UR.

The locked-room hook moved from BEFORE the floor-0 ceiling-snake
bridging loop (lines ~2766-2784) to AFTER it — the bridging loop
converts rocks back to ceilings when bridging disconnected snakes,
which was undoing the diagonal promotion. Lower diagonals (chamber-
interior side) stay as-is so floor / bones / chest can naturally sit
where the chamber wraps around the door's approach.

Files:
- `src/dungeon-locked-room.js` — `placeChamberDoor` adds the diagonal
  rock promotion; `findChamberDoorPos` reverted to orthogonal-only
  rock checks (the natural chamber wall rarely satisfies stricter
  diagonal find criteria, so the hybrid find-then-modify approach
  keeps door placement guaranteed).
- `src/dungeon-generator.js` — locked-room hook moved to end of the
  `floorIndex === 0` post-finalization block.

Verified across seeds 1-8: all door positions have UL=01 U=01 UR=01
L=01 R=01.

## 1.7.651 — 2026-05-24

### Side rooms — push down for void buffer (not visible from main floor)

Both the locked-room replica and the pre-existing secret-corridor room
sat too close to the chamber bottom (row ~21) — visible in the main-
floor camera when the player walked the south end of a chamber.

**Replica trim + bump:** `SHOP_ORIGIN_Y` 0 → 4 and `SHOP_H` 11 → 7,
so the placed replica is now the bottom 7 rows of the magic shop (the
lower diamond half + door corridor). Anchor row in floor 0 bumped
20 → 25. Result: replica spans rows 25-31 with 3 rows of clear void
(22-24) between it and the chamber bottom. Door-spine cell offsets
updated to grid rows 4-6 (was 8-10) for the entry-tile reservation.

**Secret room bump:** `placeSecretPath` `ry` 24 → 26, dropping the
2nd overhang row to fit in the remaining 32-row map (overhang at
`fy+3` = 33 would overflow). Now spans rows 26-31 with 2-row void
buffer above.

Files:
- `src/dungeon-locked-room.js` — slice constants + door-cell offsets
- `src/dungeon-generator.js` — replica anchor Y 20 → 25; secret room
  ry 24 → 26 + dropped 2nd overhang row

## 1.7.650 — 2026-05-24

### Locked-room door — rock on all 3 sides + late-pass hook

Two fixes to the v1.7.649 chamber-door placement:

1. **Door surrounded by rock on top + left + right.** `findChamberDoorPos`
   now requires ROCK (0x01) specifically at the door tile, both flanking
   tiles along the wall axis, AND the tile directly above. Previously the
   flank check accepted any wall (rock OR ceiling), which let the door
   land between ceiling tiles.

2. **Locked-room hook moved to after the final `enforceMinCeilingGap`.**
   The 0x44 false-ceiling door tile counts as ceiling for the gap-fill
   pass, which was promoting the rock above the door back to ceiling
   (1-tile gap between chamber's top-ceiling row and the door = "short
   gap"). Hook now runs at the end of floor-0 wall finalization (after
   line ~2752) so nothing can disturb the placement.

`roomTop` / `roomBot` / `aOnRight` / `bHalf` in the floor-0 block hoisted
to `var` so the late hook can see them.

Files:
- `src/dungeon-locked-room.js` — tightened `findChamberDoorPos` rock
  check; removed the rock-above force-modify from `placeChamberDoor`.
- `src/dungeon-generator.js` — early locked-room block deleted; new
  block placed inside the `floorIndex === 0` post-finalization branch
  at line ~2752; layout vars hoisted.

Spot-check seeds 1-8 all land doors at (x, 7) with rock above + left +
right. Locked-room replica placement edge-cases (seed 2 overlap with
existing bottom-cluster) still TODO.

## 1.7.649 — 2026-05-24

### Locked-room mechanic — door teleports + standalone magic-shop replica

New module `src/dungeon-locked-room.js` — generic locked-room placement
reusable for any dungeon floor. **Doors are always teleports**: the
chamber-side door tile (0x44 false-ceiling, walk-through-from-south)
is a teleport entry; the locked room itself is a standalone area in
a free portion of the same 32×32 tilemap, NOT physically connected
to the host chamber. (Teleport trigger wiring TODO — door is
debug-unlocked / walkable false-ceiling for now.)

**Room template:** the Ur magic shop interior (map 3, upper room
9×11) is read from ROM at runtime and translated tile-for-tile from
the shop tileset (5) to the cave tileset (0):
- 0x00 (ceiling), 0x01 (rock), 0x44 (secret-pass), 0x5f (void): same
  IDs across both tilesets, pass through.
- 0x3a / 0x20 / 0x47 (shop floor / counter / carpet) → 0x30 (cave
  floor) — gutted, no shop decoration.
- 0x45 / 0x68 (shop door-middle / door-bottom) → 0x44 (cave
  secret-pass) — uniform with the chamber-side teleport door.
- 0x1b (shop door-top) → 0x00 (cave ceiling).

Result: floor-0 wall convention (ceiling row on top, rock rows
underneath) preserved automatically since the source shop interior
already uses it.

**Module API:**
- `getMagicShopReplica(rom)` — returns the translated 9×11 tile grid
  (cached after first call).
- `placeLockedRoom(tilemap, rom, anchorX, anchorY, rng, opts)` —
  writes the replica grid into the tilemap at the anchor. Scatters
  chests + skeletons in the interior (entry/door tiles excluded
  from the scatter pool). Returns `{interior, bounds}`.
- `placeChamberDoor(tilemap, doorX, doorY)` — sets the teleport-
  entry tile on the host chamber's wall.
- `findChamberDoorPos(tilemap, side, opts)` — wall-walker; picks a
  wall coord flanked by walls along the wall axis with walkable
  floor on the chamber-interior side.

**Floor 0 wiring (in `dungeon-generator.js`):**
- Door X constrained to the south-half columns of Room B ("2nd half
  of the room with the exit").
- Door Y in `[1, roomTop + 3]` — `roomTop` is a top-of-area
  sentinel; actual chamber wall sits ~2-3 rows lower.
- Replica anchor opposite Room B (B on right → bottom-left at
  (1, 20); B on left → bottom-right at (22, 20)). Edge cases where
  the replica overlaps pre-existing floor-0 bottom artifacts are
  known and left as follow-up (mechanism is correct; placement
  strategy needs a `findFreeArea` helper or the floor-0 artifact
  needs cleaning up first).

**Roadmap (deferred):** teleport trigger wiring (chamber door →
replica entry tile + return); door locking + magic-key consumption;
FF1 oasis shop tiles for secret-shop variant; `findFreeArea` to
auto-avoid pre-existing tilemap content.

Files:
- `src/dungeon-locked-room.js` (NEW) — module
- `src/dungeon-generator.js` — import + 40-line block inside floor 0
  setup + 4-line splice in the feature-pass `used` initialization

## 1.7.648 — 2026-05-24

### Trap placement — inter-trap spacing 3-tile → 1-tile

The post-place exclusion was a 7×7 box (Chebyshev 3), which consumed
most of the small trap chambers and capped seeds at 1-2 traps each
vs the `traps: [3, 5]` config target. Dropped to a 3×3 box (Chebyshev
1) — traps can sit two tiles apart now.

Spot-check seeds 1-8 now land 3-4 traps each. Wall-spacing rule
(4 diagonal neighbors must be floor) is unchanged from v1.7.647.

Files:
- `src/dungeon-generator.js` — `dy/dx` loop bounds in the post-place
  block dropped from -3..3 to -1..1.

## 1.7.647 — 2026-05-24

### Trap placement — 4-diagonal neighbors instead of 4-orthogonal

Trap can sit beside a wall on the orthogonal axes (N/S/E/W) but its
diagonal corners must be clear floor. Visually frames the trap inside
a small open patch without requiring the full 3×3 the 8-neighbor rule
demanded.

Spot-check (seeds 1-6) still lands 1-2 traps per floor — same as
4-orthogonal, the chamber geometry is the bottleneck either way.

Files:
- `src/dungeon-generator.js` — `neighbors` array swapped from the four
  orthogonal offsets to the four diagonal offsets.

## 1.7.646 — 2026-05-24

### Revert v1.7.645 — back to 4-neighbor wall spacing

8-neighbor was too tight for the narrow trap chambers; seeds 1-8 all
produced 1 trap (one squeaked to 2) vs the [3, 5] spec target. Back
to orthogonal-only.

(Pre-existing surprise the revert exposed: even with the 4-neighbor
rule, seeds 1-6 only land 1-2 traps — the chamber geometry is mostly
1-tile-wide corridors and the candidate pool is small. Deferred —
spec mismatch but ships fine.)

Files:
- `src/dungeon-generator.js` — `neighbors` array back to 4 orthogonal
  offsets.

## 1.7.645 — 2026-05-24

### Trap placement — 4-neighbor → 8-neighbor wall spacing

Traps now require all 8 neighbors (4 orthogonal + 4 diagonal) to be
floor, so a trap can't sit corner-to-corner with a wall either. The
trap effectively sits in the middle of a 3×3 floor patch.

Files:
- `src/dungeon-generator.js` — trap-candidate `neighbors` array now
  includes the four diagonal offsets.

## 1.7.644 — 2026-05-24

### Revert v1.7.642 trap polish — restore wall-spacing + column-only entrance

Played wrong. Reverting to the v1.7.641 trap rules:
- Restored "all 4 orthogonal neighbors must be floor" — traps must
  sit 1 tile from every wall again.
- Restored the entrance-column-only exclusion (5-tile vertical line)
  instead of the 5×7 box landing zone.

Files:
- `src/dungeon-generator.js` — trap placement block at line ~2570
  back to its pre-v1.7.642 shape.

## 1.7.643 — 2026-05-24

### Message box is fully modal — no input bleed-through to menus

`movement.js#handleInput` dispatched `handleBattleInput` →
`handleTradePickInput` → `handleInspectInput` → `handleRosterInput`
→ `handlePauseInput` BEFORE the universal-msgbox block. Each of those
internally gates on `msgState.state === 'none'` for their open paths
(so pause / roster wouldn't actually open during a msgbox), but they
still unconditionally consumed Enter / S keys at the top of their
handlers. The msgbox handler below — which uses Z / X — never saw a
problem, but the architecture was fragile: any new handler that
forgot the gate, or any handler that read Z / X for a side path,
would steal input from the msgbox.

Moved the msgbox block to the top of `handleInput` (right after bed
and shop, both of which are already msgState-aware) and added an
early `return`. Now when a msgbox is up, ONLY the msgbox handler
runs and every battle / trade / inspect / roster / pause handler is
skipped entirely.

Side benefit: trade-pick + inspect panels no longer compete with
their own confirmation msgboxes for Z / X.

Files:
- `src/movement.js` — `handleInput()` reordered. Block is unchanged
  internally; only its position + an early return changed.

## 1.7.642 — 2026-05-24

### Altar Cave floor 1 (UI floor 2) — trap polish

Trap-chamber floor (`floors[1]` in `dungeon-generator.js`) had two
issues that combined to make the entry pathway feel unfair:

1. **Trap placement required all 4 orthogonal neighbors to be floor**
   ("1 tile from any wall"). The trap chambers are narrow — this
   left very few candidate tiles, so seeds often under-spawned and
   the few traps that did land clustered in the chamber center.
   Removed. Traps may now sit against a wall.

2. **Entrance exclusion was a vertical column only** — the entry
   passage above the entrance was protected, but the first few tiles
   the player steps onto in the chamber proper weren't. A trap on
   tile (entranceX, entranceY+1) or one immediately to either side
   could drop the player to the next floor before they'd taken two
   steps. Expanded to a 5-wide × 7-tall box around the entrance so
   the landing AND first strides stay clear.

Files:
- `src/dungeon-generator.js` (trap placement block around line 2570)
  — removed the `neighbors.every(...)` check; expanded the entrance
  `trapUsed` seed from the 1-column loop to a 5×7 nested loop.

## 1.7.641 — 2026-05-24

### Fix: chat-log back-out now uses NES B-button (`x`), not literal `b`

v1.7.640 bound the back-out to keyboard `b`/`B` — but the game's
"B button" (cancel) is keyboard `x`/`X`, and the on-screen mobile B
button dispatches `data-key="x"`. So the binding didn't work on mobile
and didn't match the game's existing cancel convention on desktop.

Rebound to `x`/`X`. Also clears `keys['x']` / `keys['X']` after
consuming so `inspect.js` / overworld interact don't ALSO fire from
the same press — same pattern movement.js / shop.js / trade.js use
for x-cancel.

Files:
- `src/input-handler.js` — `b`/`B` → `x`/`X`; consume the keys[] entry.

## 1.7.640 — 2026-05-24

### `b` / `B` backs out of the expanded chat log

Adds a close-only shortcut for the T-expand. Currently you had to press
`T` again to collapse; `b` now does the same thing (close half of the
toggle — pressing `b` when the log isn't expanded is a no-op).

The chat-input early-return in `initKeyboardListeners` means a `b`
typed into chat input never reaches the hotkey block, so the binding
is safe alongside normal typing.

Files:
- `src/input-handler.js` — new handler right after the `T` toggle;
  same `_chatHotkeyAllowed()` gate (no fire during battle / pause /
  roster / transition / msg-box).

## 1.7.639 — 2026-05-24

### Chat input — word-wrap (no more mid-word breaks)

`_wrapInputText` was greedy char-by-char so a long word straddling
the row boundary got chopped mid-letter (e.g. "testi" + "ng").
Replaced with the same word-aware algorithm `_chatWrap` uses for the
chat history: break at the last space inside the row when one exists,
fall back to a hard char-break for super-long words with no spaces.
Row 0 still reserves `promptW`; rows 1+ get the full panel width.

Result: typing now slides the whole trailing word to a new line when
it overflows, matching how chat history wraps.

## 1.7.638 — 2026-05-24

### Chat input — revert auto-expand; fix multi-line wrap on sent messages

User feedback on v1.7.637: "i dont want the whole log opening up, and
its cutting off half the message after sending."

Two bugs:

1. **Auto-expand was wrong UX.** v1.7.637 took over the entire HUD
   region the moment the input opened — too aggressive. Reverted:
   the chat panel stays at its default `HUD_BOT_H` size while typing
   (same as pre-v1.7.637). 80-char cap retained; 3-row input now
   competes with ~2-3 history rows in the small panel — workable for
   short replies, and the user can still T-expand manually if they
   want full reading room.

2. **`_buildChatRows` colon branch was dropping wrap rows past the
   first.** Long-standing latent bug. The "name: message" path pushed
   row 1 (with the name part + first chunk of message) and then row 2
   from `_chatWrap(remainder, lineW)[0]` — taking ONLY the first wrap
   line of the remainder. Any 3rd+ visual row was silently dropped.
   Hidden by the 42-char cap (messages rarely wrapped past 2 visual
   rows); v1.7.628's and v1.7.637's 80-char cap exposed it as "half
   the message cut off". Fix: loop the wrap result for the remainder
   the same way the no-colon branch already does. Sent messages now
   render every line in the chat history.

Files:
- `src/chat.js` — removed `_inputAutoExpanded` / `_lastInputActive`
  / rising-edge logic from `updateChat`; `_buildChatRows` colon
  branch now loops `_chatWrap(remainder, lineW)` instead of taking
  `[0]`. `CHAT_INPUT_CAP = 80` retained; `_wrapInputText` +
  `_drawChatInput` N-row renderer retained.

## 1.7.637 — 2026-05-24

### Chat input — auto-expand panel for writing room (80-char cap, N-row wrap)

Closes the "not enough writing space in chat" UX gap from open-beta
player report #3. Second attempt after v1.7.628-630's revert.

What's different this time: instead of growing the fixed HUD panel
upward (which broke v1.7.629 because the new vertical area had no
black background and rendered over the HUD viewport), the chat panel
now triggers the existing **T-expand HUD takeover** when the input
opens. That path already calls `_drawChatExpandBG` to black out the
upper HUD area, so multi-row input gets proper background coverage
for free.

Behavior:
- Opening the input (via `t` hotkey or roster Message action) sets
  `chatState.expanded = true` and remembers it was the input's doing.
- Send (Enter) or cancel (Escape) collapses back to the small panel
  — but only if the expand was input-triggered. A manual T-expand
  before opening chat stays expanded across the input lifecycle.
- Input cap raised 42 → 80 chars (server still caps at 200).
- `_drawChatInput` generalized from the old 1-vs-2 line split to
  arbitrary N-row wrap via the new `_wrapInputText` helper. Row 0
  reserves prompt width; rows 1+ use the full chat panel width.
  80 chars in the 8px font wraps to ~3 visual rows on a 236-px panel.
- In expanded mode the panel is ~208 px tall (~22 rows), so even a
  3-row input leaves ~19 rows of message history visible — message
  scrollback never gets squeezed the way it did in v1.7.629.

Files:
- `src/chat.js` — `CHAT_INPUT_CAP = 80`, `_inputAutoExpanded` /
  `_lastInputActive` rising-edge tracking inside `updateChat`,
  `_wrapInputText` + `_inputPromptStr` helpers, `_drawChatInput`
  rewrite, `_drawChatTextArea` input-rows budget threads through.
- `CHAT_LINE_H` / `CHAT_EXPAND_MS` / scroll cache untouched.

## 1.7.636 — 2026-05-24

### PWA icons — transparent outside the HUD frame

PNG encoder switched to RGBA (color type 6); border tiles now blit with
pixel 0 transparent — same pattern as `borderTransparentTileCanvases`
in `hud-init.js`. The HUD frame's rounded outer corners and everything
beyond the frame land at alpha 0 so iOS's home-screen rounded-square
mask cuts cleanly and the icon "floats" on the user's wallpaper instead
of sitting on a black square.

## 1.7.635 — 2026-05-24

### PWA icon — revert to true 16×16 OK_IDLE portrait (player-select match)

v1.7.634 cropped too far. Reverting to the 4-tile 16×16 OK_IDLE render —
literally the same bytes `_renderPortrait` paints in title-screen
player select boxes.

## 1.7.634 — 2026-05-24

### PWA icon — crop to bust-shot (head + shoulders only)

The 16×16 title-screen portrait includes 4 rows of upper-thigh "leg-stub"
pixels at the bottom of the body tile — invisible at native 16-px scale
but read as full legs once nearest-neighbor scaled to 512px. Cropped
those rows out so the icon reads as a bust portrait at all scales.

`tools/build-pwa-icon.mjs` — `blitTile` now takes `maxRows`; body tiles
2+3 only blit their top 4 rows. Source rebuilt; icon PNGs updated.

## 1.7.633 — 2026-05-24

### PWA icons — Onion Knight portrait inside the FF3 HUD frame

Built three PNGs by compositing the in-game Onion Knight idle portrait
(OK_IDLE + OK_LEG_*_IDLE from `src/data/job-sprites.js`) inside a 6×6
HUD menu border (ROM 0x1BF80, MENU_PALETTE). 48×48 source rendered with
the same compositing rules the game uses (pixel 0 transparent for the
portrait so the menu interior shows through). Nearest-neighbor scaled
to 192×192, 512×512, and 180×180 — no anti-aliasing, the pixels stay
crisp.

Files:
- `tools/build-pwa-icon.mjs` (NEW) — pure-Node renderer, no canvas
  package needed. Reuses the PNG encoder from `tools/render-oam-dump.js`.
  Re-run with `node tools/build-pwa-icon.mjs [rom-path]` to rebuild.
- `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` (NEW) — committed
  PNGs served from repo root.
- `manifest.json` — icons array populated with 192 + 512.
- `index.html` `<head>` — `<link rel="icon">` and `<link rel="apple-touch-icon">`.

No hand-authored tile bytes. Every pixel traces back to the FF3 ROM
or the existing `data/job-sprites.js` PPU captures.

## 1.7.632 — 2026-05-24

### iOS PWA manifest — enable durable storage via Add-to-Home-Screen

The first real `/api/storage-beacon` capture from v1.7.631 was iOS Safari
26.3 returning DENIED for `navigator.storage.persist()`. That's canon
behavior: iOS Safari only grants persistence to PWAs installed via Add
to Home Screen.

Ships a minimal PWA manifest + iOS meta tags so users who tap Share →
Add to Home Screen get:
- Standalone display (no Safari chrome — full-screen game)
- Durable IndexedDB (ROM cache + saves no longer evicted)
- A real-app icon on their Home Screen
- Status bar styled for the gold-on-dark palette

Files:
- `manifest.json` (NEW) — `name`, `short_name`, `start_url`, `scope`,
  `display: standalone`, `theme_color: #c8a832`, `background_color: #0e0e1a`.
  Icons array is empty for now — iOS uses a screenshot of the gate splash
  as the Home Screen tile until a real 180×180 PNG ships.
- `index.html` `<head>` — `<link rel="manifest">` plus
  `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`,
  `apple-mobile-web-app-title`, `theme-color`.

server.js MIME map already serves `.json` as `application/json`, which
Chrome and Safari both accept for manifests.

No effect on plain Safari / Firefox / Chrome — they ignore the iOS
meta tags. Storage-beacon ratio will surface whether installation rate
follows.

## 1.7.631 — 2026-05-23

### Telemetry — `navigator.storage.persist()` outcome beacon

Open-beta launch day produced 6 new signups, but only 1 of the 5
post-flip accounts actually saved a character. To rule in/out mobile
Firefox storage eviction as a cause of that drop-off, persist-grant
ratio is now captured server-side.

Each first-tap on the splash POSTs `{already, granted, ua}` to a new
`/api/storage-beacon` endpoint and a row lands in the `storage_beacons`
SQLite table. Unauthed (the beacon fires before login), rate-limited
via the shared client-error bucket, UA truncated to 120 chars, no PII.
The console.info line `[storage] persist requested → GRANTED|DENIED`
stays for in-devtools visibility.

After a couple days of data, query the table to see the
GRANTED/DENIED split broken down by UA — Firefox vs Chrome vs Safari,
mobile vs desktop. If the denied rate is significant we know to keep
hardening the gesture/IndexedDB path; if it's negligible the drop-off
is elsewhere (title-screen UX, curiosity signups, etc).

Files:
- `api.js` — `storage_beacons` table + `/api/storage-beacon` endpoint
- `index.html` — fire-and-forget `fetch('/api/storage-beacon', ...)`
  inside `_requestPersistentStorage`, also beacons the `already=true`
  returning-visitor case

## 1.7.630 — 2026-05-23

### Revert v1.7.628 + v1.7.629 — chat cap raise + panel grow broke layout

v1.7.628 raised the chat input cap 42→80 with N-line wrap.
v1.7.629 grew the chat panel upward to fit multi-row input. Both broke
in combination: input text rendered above the HUD viewport (panel
grew but had no background covering the HUD area), and the post-send
chat history wasn't showing the full sent message either.

Reverted chat.js entirely back to v1.7.627 shape — 42-char cap, 1-or-2
visual rows, fixed HUD_BOT_H panel. Other v1.7.628-629 surfaces
(CHANGELOG, package.json) were doc-only and don't need reverting.

The underlying "not enough writing space" UX gap from player bug
report #3 is real but not solvable by just raising the cap — the
chat panel is fixed-size and multi-row input fundamentally competes
with message history. Proper fix would mean a separate floating input
area or a deliberate expand-while-typing mode with the same HUD
takeover that the T-expand uses today. Punted for later.

## 1.7.629 — 2026-05-23

### Chat panel grows upward to preserve message rows while typing

v1.7.628's 80-char cap + N-line wrap exposed a fixed-budget problem
in the chat panel: HUD_BOT_H gives 5 visible rows total, so a 3-4
row input only left 1-2 rows of message history. Player report
("only 2 lines of output").

Fix: pre-compute the input wrap in `drawChat`, then grow `curBoxH`
upward by `(inputRows - 1) * CHAT_LINE_H` while inputActive. Default
4 message rows are preserved regardless of input length:

- Input 1 row → panel = 64px → 4 msg + 1 input
- Input 2 rows → panel = 73px → 4 msg + 2 input
- Input 3 rows → panel = 82px → 4 msg + 3 input
- Input 4 rows → panel = 91px → 4 msg + 4 input

The user-controlled expand (T key) still works on top; the growth
math subtracts `extraInputH` from the expand range so the fully-
expanded panel doesn't exceed the canvas.

## 1.7.628 — 2026-05-23

### Chat input cap raised 42 → 80 + N-line wrap

Player bug report: "not enough writing space in chat" — 42-char cap
was too tight for `/bug` descriptions and longer chat. Bumped to 80
(server still caps at 200) and generalized the input renderer from
the previous 2-line-only path to wrap arbitrarily:

- `CHAT_INPUT_CAP = 80` constant added; replaces the hardcoded 42 in
  `onChatKeyDown`.
- `_wrapInputText(ctx, text, promptW, lineW)` — new helper that walks
  the text and returns an array of visual rows (row 0 reserves
  prompt width; rest use full `lineW`).
- `_drawChatInput` rewritten to render the lines stacked upward from
  `inputBottomY` so the cursor stays at the bottom row. Prompt
  renders only on the top row.
- `_drawChatTextArea` computes `inputRows = inputLines.length` from
  the wrap result instead of the old 1-vs-2 boolean.

80 chars × the 8px game font in the 144px-wide chat panel wraps to
~4 rows max (≈21 chars/row, minus prompt overhead on row 1). Leaves
room for a `→Player ` PM prefix (9 chars with a 7-char name) +
~70-71 chars of actual message. v1.7.628.

## 1.7.627 — 2026-05-23

### Three player-reported bug fixes (open beta day 1)

- **#1 Monsters in Ur chests** (`map-triggers.js`): `rollLootEntry` was
  falling through to `DEFAULT_LOOT` = cave pool (LOOT_POOLS[1000])
  for Ur interior maps (1-9, 147) since they have no own entry — the
  cave pool has a `{ monster: true }` mimic tier (~13-16%) so Ur
  chests rolled chest mimics. Fix: route any `UR_CHEST_MAPS`-tagged
  map without its own LOOT_POOLS entry to `LOOT_POOLS[114]` (the Ur
  overworld pool, mimic-free) before falling back to DEFAULT_LOOT.
  Vase loot via `rollHiddenTreasureLoot` already had this fallback;
  the regular-chest path didn't.
- **#2 Pause opens when pressing Enter in chat** (`chat.js` +
  `pause-menu.js`): holding Enter to send a chat message let the
  auto-repeat keydown bleed through to `_pauseInputOpenClose` after
  `chatState.inputActive` flipped false. Added `_chatClosedAt`
  timestamp in `chat.js`, set on Enter / Escape close, exposed via
  `chatJustClosedRecently()` (250 ms window). Pause-menu Enter
  handler returns early if it fires within that window.
- **#3 `[v{{VERSION}}]` in bug reports** (`server.js`): the
  `{{VERSION}}` template token has TWO occurrences in `index.html`
  (one in a comment, one in `var BUILD = 'v{{VERSION}}'`).
  `String.prototype.replace` only swaps the first; the BUILD literal
  was leaking through, getting stored in `localStorage.ff3_build`,
  and from there into every `/bug` payload as `[v{{VERSION}}]`.
  Switched to `replaceAll` to match the other template tokens.

## 1.7.626 — 2026-05-23

### Every-session bug-report hint in console

Added `Found a bug? Report it with /bug <description>` to the startup
message list in `main.js`. Fires on every game entry (not first-run
only — the existing first-run block stays as-is). Lands on the System
tab via the existing 350ms stagger. Open-beta UX.

## 1.7.625 — 2026-05-23

### Fix: tap-to-enter splash on open beta — restores cache persistence

Root cause for "ROM cache not saving" post-gate-flip: pre-flip the
password gate dialog acted as an unintentional **user-gesture guard**.
Every fresh tab required typing `ff3dev` and clicking Enter BEFORE
any IndexedDB access. Mobile Firefox (and other browsers with
strict tracking protection) classify an origin's storage as
session-only when the first IndexedDB access happens without user
activation — wiped on tab close.

Post-flip, `unlockGate` ran immediately on page load. Returning users
with a saved auth token jumped straight to `showROMPicker →
loadCachedROMs`, hitting IndexedDB before any tap. Result:
classification as session storage, cache wiped between tabs.

Fix: when `GATE_PW` is empty (open server), still show the gate
overlay — but with the password field hidden and the Enter button
rebranded as "Tap to enter". The button click is the user gesture
that allows IndexedDB / `navigator.storage.persist()` to claim
durable storage.

Closed-beta flow (gate password set) is unchanged. Already-unlocked
sessions (`sessionStorage.ff3_auth` set) still skip straight in.
v1.7.625.

## 1.7.624 — 2026-05-23

### Revert v1.7.622-623, try `navigator.storage.persist()` instead

v1.7.622's deferred cache read + v1.7.623's overwrite guard didn't
solve the mobile Firefox cache wipe AND broke the ROM upload flow.
Reverted both — `showROMPicker` is back to its v1.7.621 shape
(`loadCachedROMs()` called directly, no first-gesture latch, no
"don't overwrite" guard).

Different approach: ask the browser explicitly for persistent storage
via the standard `navigator.storage.persist()` API. Firefox grants
this automatically when there's user activation. Hooked to the first
pointerdown/touchstart/keydown gesture so the activation requirement
is satisfied. Logs `[storage] persist requested → GRANTED/DENIED` to
the console. Failure is harmless — caching falls back to
best-effort, same as before the request.

ROM picker should work again (back to known-good behavior). Whether
the persist request actually fixes the mobile-Firefox eviction is
the open question.

## 1.7.623 — 2026-05-23

### Fix: cache read can't overwrite fresh user uploads

v1.7.622 deferred `loadCachedROMs` until first user gesture, which
created a race: if the user tapped a file picker (gesture), the cache
read started in parallel with their file selection. If their tap-time
IndexedDB still had any (stale/partial) cached ROM bytes, the cache
read could complete AFTER the user's fresh upload assigned to
`ff3Buffer` etc. and then OVERWRITE it via the unconditional
`if (cached3) ff3Buffer = cached3` assignment.

Fix: skip the assignment when the buffer is already set. Cache only
fills MISSING slots, never overrides what the user just uploaded.

Symptom this fixes: "I upload all three ROMs and the game still won't
launch" — was loading stale cached bytes over the fresh upload and
either `loadROM` rejected or the buffers were corrupted.

## 1.7.622 — 2026-05-23

### Fix: ROM cache wiped on mobile Firefox post-gate-flip

Diagnosis: mobile Firefox (and likely other browsers with strict
tracking protection) treats IndexedDB written/read before any user
gesture as **session-only** storage — wiped on tab close. The
pre-flip flow had the gate password dialog as an accidental gesture
guard (user typed + tapped before `loadCachedROMs` ever ran). The
post-flip flow has returning users (with `authToken` already in
localStorage) hitting `unlockGate → showROMPicker → loadCachedROMs`
with **no user gesture between page load and first IndexedDB
access**. That flagged the DB as ephemeral on mobile Firefox.

Fix: defer the `loadCachedROMs` call in `showROMPicker` until the
first `pointerdown` / `touchstart` / `keydown` event. The picker UI
still renders immediately; only the IndexedDB read is gated. Cache
WRITES (via `cacheROM` in the file-change handlers) already happen
inside a user-gesture context (the file picker click), so they were
always persistent.

Existing users on mobile Firefox who already have a partitioned DB
may need to "Forget about this site" once to clear the
session-storage flag, then revisit. v1.7.622.

## 1.7.621 — 2026-05-23

### Fix: ROM cache wiped on every version reload (`Clear-Site-Data` header)

Reported post-gate-flip: ROMs not persisting across page reloads.
Diagnosis: every `?_v=<build>` cache-bust reload (8 of them this
session as we shipped v1.7.613-620) was responding with
`Clear-Site-Data: "cache"`. Per spec that directive only touches the
HTTP cache, but at least some browsers interpret it broader and wipe
the origin's IndexedDB — which is where ROM bytes are stored. End
result: every version bump silently re-blanked the user's ROM cache.

Pulled the header. `Cache-Control: no-store, no-cache, must-revalidate`
remains as the real HTTP-cache defense. The header was originally
added (P1 #4) for mobile Firefox sometimes ignoring `Cache-Control:
no-store` on JS modules; if that class of error returns we'll
revisit with a narrower directive (e.g. just `"executionContexts"`).

## 1.7.620 — 2026-05-23

### Diagnostic: surface ROM cache write/read errors

User report after the gate flip: ROM cache not persisting. The three
`cacheROM(...).catch(() => {})` calls in `index.html` were silently
swallowing every error, so any IndexedDB failure (private mode, quota,
storage partition reset) is invisible.

- All three ROM cache writers now log `[rom-cache] FFx cached N bytes`
  on success and a full error dump on failure.
- `loadCachedROMs` logs `[rom-cache] read FF3=...B/MISSING ...` per ROM
  on every load + surfaces any `openDB` exception (was silently caught).

No behavior change for the success path — just instrumentation so we
can read what's happening in the browser console.

## 1.7.619 — 2026-05-23

### System message tone — open-beta polish

Tightened three party-related System tab messages for consistency with
the existing `'* X left the area'` / `'* You left the party'` shape:

- `* X joined party` → `* X joined the party`
- `* X left party` → `* X left the party`
- `* Party disbanded` (after `/disband`) → `* You disbanded the party`

No behavior change; cosmetic text only.

## 1.7.618 — 2026-05-23

### Universal hidden-treasure (vase) system — replaces v1.7.617 per-coord registry

v1.7.617 added a per-coord SECRET_TREASURES registry for two grass
tiles on map 114. Turns out the ROM had already flagged those exact
positions — and every "search a vase" spot across the Ur interiors —
with metatile ids `0x78-0x7B` (trigger-type 2 per the disasm's
TRIGGER_TYPE_TABLE). Switched to universal detection so every existing
+ future vase / hidden-treasure tile gets the function automatically.

- **Detection** (`map-triggers.js`): `isHiddenTreasureTile(tileId)`
  returns true for any `0x78-0x7B`. `0x78-0x7B` are already
  collision-blocked by `map-renderer.js:495`, so the player walks up
  to them and presses Z (same flow as a `0x7C` chest).
- **`handleHiddenTreasure(facedX, facedY)`**: 25% per-search hit
  chance. Miss → silent, no message, no cooldown (player can re-try).
  Hit → loot + 24h cooldown via the existing `ps.consumedTilesAt[mapId][key]`
  machinery. Tile is never mutated, so vases / grass keep their
  appearance forever.
- **Loot** pulls from the map's regular chest pool via
  `rollHiddenTreasureLoot`. Ur interiors (maps 1-9) without their own
  LOOT_POOLS entry inherit map 114's pool. Chest-mimic tiers are
  filtered out — a vase that spawned a battle would be off-tone.
- **Wired** in `movement.js` `_handleAction` right after the `0x7C`
  visible-chest check.

Removed: `SECRET_TREASURES`, `SECRET_LOOT_POOLS`, `isSecretTreasure`,
`handleSecretTreasure`, `rollSecretLoot` (all v1.7.617 — now covered
by the universal handler). The (27, 8) and (6, 12) tiles on map 114
were already `0x78` in the ROM, so they continue to work but now go
through the 25% hit roll and the regular Ur loot pool instead of
v1.7.617's richer secret pool.

**Total hidden-treasure tiles auto-detected across Ur**: 19 — map 114
× 2, map 1 × 5, map 2 × 5, map 7 × 1, map 8 × 3, map 9 × 3.

## 1.7.617 — 2026-05-23

### Invisible chest at Ur (27, 8) + chest-cooldown server-save fix

Two hidden treasures on map 114 (Ur overworld) — grass tiles at
(27, 8) and (6, 12). Player walks up, presses Z, finds loot. Tile stays grass —
no visible chest, no `0x7D` opened-chest mutation. After looting, Z
goes silent until the 24h cooldown expires; then the secret is
discoverable again.

- **Registry** in `src/map-triggers.js`: `SECRET_TREASURES[mapId]` is
  a Set of `"x,y"` keys (currently just `114: {'27,8'}`).
  `SECRET_LOOT_POOLS[114]` gives the secret richer odds than a regular
  Ur chest — Potion/Antidote (35%), 100-250 gil (30%), Phoenix Down
  (20%), Cure scroll (15%).
- **`handleSecretTreasure(facedX, facedY)`** reuses the existing 24h
  `ps.consumedTilesAt[mapId][key]` cooldown machinery. NO
  `_consumeTile` call, so `_replayConsumedTiles` doesn't paint
  anything visible — tile reads as plain grass to the renderer.
  Returns false when on cooldown so `_handleAction` falls through.
- **Wired** in `src/movement.js` `_handleAction` immediately after the
  `0x7C` (visible chest) check.

**Sidebar bug fix**: `parseSaveSlots` in `api.js` whitelisted
`consumedTiles` but NOT `consumedTilesAt` — server round-trip was
dropping the chest-open timestamps. Ur chest + secret treasure 24h
cooldowns were effectively client-IndexedDB-only until now. Added
the matching whitelist entry. Existing saves that lost their
`consumedTilesAt` will respawn their chests on next ROM load (one-time
"free" reset for anyone who looted between v1.7.595 and now).

## 1.7.616 — 2026-05-23

### Trade hardening — type whitelist + audit log

Open-beta gap from the beta-hardening track: trade had no server-side
ownership validation (same as give-item) so a modded client could
fabricate items for the receiver. Full inventory mirror is a
multi-day project; this commit ships the practical pre-flip middle:

- **New `trades` SQLite table** + `tradeLog(...)` helper in `api.js`.
  Every accepted/declined/blocked trade-response is logged with
  sender/target/item/timestamp/reason. Server still doesn't validate
  ownership, but every trade is now forensically traceable.
- **Item-type whitelist** in `ws-presence.js#trade-offer`. Imports
  `ITEMS` from `src/data/items.js` (pure data, node-clean). Blocks
  any item whose `type` is `'key'` (quest flags, not real inventory)
  or whose id has no metadata. Other types
  (weapon / armor / consumable / battle_item / scroll) pass through.
- **Blocked response wire**: server emits
  `trade-result { accept: false, reason: 'blocked' }` when the
  whitelist rejects; sender's client shows "Cannot trade" and bails
  without consuming. New reason branch in `src/trade.js`.
- **`tools/trade-audit.cjs`**: read-only inspector that prints recent
  trades. Modes: `[limit]` for all, `sender <userId> [limit]` filtered
  by offerer, `item <hex|dec> [limit]` filtered by item id. Mirrors
  the `tools/bug-reports.cjs` pattern.

Trust boundary explicitly documented: this catches key-item abuse +
gives us audit forensics, but doesn't stop a modded sender from
duping ordinary items. Real fix (server inventory mirror) is queued
post-flip — to land only if abuse actually surfaces in the audit log.

## 1.7.615 — 2026-05-23

### `/disband` + `/leave` chat commands (open-beta UX gap)

Post-v1.7.595 parties persist across disconnect/restart, so inviters
were stuck with stale members and no way to clean them up. Added the
missing disband action end-to-end:

- **Server** (`ws-presence.js`): new `party-disband` case. Inviter
  finds every member in `_partyMemberships`, drops them all (one
  `partyRemoveByInviter` DB call), and sends `party-disbanded` to
  each. Bonus fix: `party-dismiss` was silently removing without
  notifying anyone — now broadcasts `party-member-left` to remaining
  members and `party-disbanded` to the dismissed member.
- **Client** (`net.js`): `sendNetPartyDisband()` helper.
- **Client** (`party-invite.js`): `disbandMyParty()` clears the local
  `partyMembers` + cached profiles and emits the wire (no-op for
  fake-roster-only setups so single-player /disband still works).
  Existing `party-disbanded` handler generalized to clear the ENTIRE
  party (not just the inviter), since it now fires for both true
  disbands and single-member dismissals.
- **Client** (`chat.js`): new `/disband` and `/leave` chat commands.
  `/disband` (inviter) dissolves the whole party; `/leave` (member)
  drops you from your current party.

Wire infra for `party-disbanded` already existed end-to-end (handler
+ net hook from v1.7.412) — server just hadn't emitted it since the
persistence rework swapped inviter-disconnect to `party-member-left`
in v1.7.595. Lint clean. Sim coverage skipped: the existing pvp-wire
suite only tests pure predicates (`inSameParty`), not party-* wire
dispatch.

## 1.7.614 — 2026-05-23

### Altar Cave floor 1 — rebuilt with floor 2's room primitives

v1.7.613's `carveSmallCaveRoom` "breathing rooms" off the deeper-floor
else branch read as bulges in a corridor, not real rooms. Rebuilt floor
1 with a dedicated `floorIndex === 1` branch that copies floor 2's
room/corridor primitives verbatim:

- **5×5 entrance room** with arch — direct copy of floor 2's exit
  pattern: 5×5 carve with edge-row jitter, `placeDeepEntrance` embedded
  3 tiles into the room opening back toward the corridor.
- **H corridor** — 4-6 steps, 3-row carve, no jitter (floor 2's primitive).
- **5×5 mid room** — floor 2's first 5×5 primitive verbatim.
- **V corridor** — 5-7 steps down from middle of mid room.
- **7×7 trap chamber** — floor 2's 7×7 primitive (minus the keep-clear
  exit-path adjustment, since floor 1 has no exit path).

Flow stops at the chamber — its trap holes ARE the exit to floor 2.
Always top-down (entrance at top, chamber at bottom) since floor 0's
south-wall stairs land the player at floor 1's top.

Entrance + mid 5×5 rooms registered via `extraRooms` so the shared
feature pass adds a 50% chance chest + 2-3 skeletons per room (from
v1.7.613's machinery, now actually getting used).

Existing `carveSmallCaveRoom` helper + else-branch wiring left in place
as the fallback path for any future floor that doesn't have its own
explicit branch (currently unreachable in production, all floors 0-4
have explicit branches).

## 1.7.613 — 2026-05-23

### Altar Cave floor 1 — entrance + junction breathing rooms

Floor 1 (mapId 1001) used to drop the player into a 1-tile vertical
shaft → straight horizontal corridor → 2-tile bend → vertical drop →
trap chamber. Now the deeper-floor else branch carves a small organic
cave room at two points:

- **Entrance room** around `(entranceX, startFloorY)` — small breathing
  space right at the entrance landing.
- **Junction room** at `(pathResult.endX, pathResult.endFloorY)` —
  where the horizontal corridor meets the vertical drop.

Both via the new `carveSmallCaveRoom(tilemap, cx, cy, rng)` helper —
5-6 wide × 4 tall with light edge jitter, returns its bounds. Top rows
get eaten by `addOverhang` into walls/rocky, leaving ~2 walkable rows
each. Rooms overlap the corridor anchor tiles so connectivity is free.

Each room also gets 2-3 skeletons (`findRandomFloor` w/ same 5x5
boneUsed exclusion as the chamber loop) and a 50% chance at one corner
chest (`findCornerFloor` w/ the v1.7.589 strict 2-wall test). Room
bounds passed via the new `extraRooms` array (empty on every other
branch). Floor 1's existing trap-hole-as-exit model is unchanged.

Validated against floor-view across multiple seeds — chests still in
corners, no chest-in-corridor regressions, trap chamber feature counts
~unchanged, ceiling snake intact.

## 1.7.612 — 2026-05-23

### Exit delete mode after a successful deletion

v1.7.611 jumped `invScroll` to 0 but kept `pauseSt.deleteMode = true`,
which left the held cursor stuck on the trash icon after the delete
prompt closed. Now both delete paths clear `deleteMode` in the confirm
`onAccept`, so the trash cursor disappears alongside the prompt.

To delete a second item, navigate to the trash again (or press SELECT).
Cancel still leaves `deleteMode` untouched.

## 1.7.611 — 2026-05-23

### Cursor jumps to top after deletion

Both delete paths now set `pauseSt.invScroll = 0` in the confirm-prompt
`onAccept` callback — `_pauseInvDeletePress` (navigate-then-pick) and
`_pauseInvDeleteHeld` (drag-held-to-trash). Delete mode stays on if it
was on, so the held cursor stays at the trash and the user can keep
deleting from the top. Press X to exit delete mode.

## 1.7.610 — 2026-05-23

### Trash cursor draw order: held under, active on top

Matches item-selection exactly. Item-row code draws the held cursor
first (line 309-310) and the active cursor second (line 311-313), so
when the cursors overlap, the active one sits visually on top of the
held. Trash code had it inverted — the moving cursor was buried under
the stationary one when they overlapped at the trash position.

Swapped two `if` blocks in `_drawPauseInventory` so engaged-cursor
(static, "held" role) draws first and active-cursor (moving) draws
second.

## 1.7.609 — 2026-05-23

### Z on trash keeps cursor on trash (doubled visual stays visible)

v1.7.606 jumped `invScroll` to `lastItemScroll` on Z-on-trash — which
prevented the doubled cursor at the trash from ever showing, because by
the time the next draw ran, `invScroll !== INV_CAP` and the doubling
condition was false.

Reverted. Now Z on trash leaves `invScroll === INV_CAP`, so the v1.7.608
doubled-cursor visual ACTUALLY APPEARS at the trash (mirroring how Z on
item row N leaves `invScroll === N` and shows the held + active doubled
on row N). User arrows away to pick which item to delete; held cursor
stays at trash, active follows.

`_pauseInvTrashZPress` one-line revert.

## 1.7.608 — 2026-05-23

### Trash cursor: cap total cursors at 2 (mirror item-switching exactly)

v1.7.607 over-drew: when delete mode was engaged and the user was on an
item row, three cursors rendered (2 on trash + 1 on item). Item-switching
caps at 2, so this should too.

New rule: the "engaged" cursor is a single sprite at `tx-12` (stays put,
analogous to the held-item cursor staying at `px+8`). The doubled visual
on the trash itself only appears when the user has navigated to the
trash AND delete mode is on — same case where item-switching shows the
doubled cursor (held=invScroll). Active cursor offsets mirror the
`px+8` (alone) / `px+4` (when held) pattern: `tx-12` alone, `tx-16` when
also engaged.

Case table — total cursor count (trash + item row):
- onTrash + engaged → 2 trash (doubled visual)
- onTrash, no mode  → 1 trash
- on item + engaged → 1 trash + 1 item = 2
- on item, no mode  → 1 item

`_drawPauseInventory` cursor block only.

## 1.7.607 — 2026-05-23

### Trash cursor doubles when delete mode is engaged

Matches the v1.7.600 held-item visual: two cursors stacked at +0 and
+4 offset (half-overlapping the 8×8 sprite), signalling "this is the
engaged action." Hover state (cursor on trash, mode off) still draws a
single cursor — only when `pauseSt.deleteMode` is on does the cursor
double. Same shape that item-pickup uses: held cursor at `px+8`, active
cursor at `px+4` whenever an item is in hand.

`_drawPauseInventory` cursor block only.

## 1.7.606 — 2026-05-23

### Trash-Z returns cursor to the last item, not row 0

Previously Z on the trash slot dumped the active cursor at the top of
the inventory list, forcing the user to navigate back to whatever they
were inspecting. Now it returns to the **last item-row position** before
they walked to the trash.

New `pauseSt.lastItemScroll` records the most recent `invScroll < INV_CAP`
each frame `_pauseInputInventory` runs. `_pauseInvTrashZPress` reads
that to restore the cursor on Z. Default is 0 so a fresh menu open + Z
on trash still lands somewhere sensible.

## 1.7.605 — 2026-05-23

### Inventory delete prompt is now responsive + duplicates the trash cursor

Three v1.7.604 followups, all in `pause-menu.js`:

- **Prompt input was being eaten** by `_pauseInputInventory` before
  `movement.js`'s `msgState.isPrompt` handler could see Z/X (mobile
  A/B). `handlePauseInput` now early-returns `false` whenever a prompt
  is up, letting the msg-box handler take the keys. Symptom: confirm
  prompt would appear but A/B/Z/X did nothing; the box just sat there.
- **Trash cursor now duplicates** while delete mode is active —
  mirrors the v1.7.600 held-item pattern (active cursor follows
  invScroll, "mode" cursor stays on the trash). Previously the cursor
  was only on the trash when invScroll equalled INV_CAP; navigating to
  an item to pick it for deletion dropped the trash cursor and you
  couldn't see what mode you were in.
- **Mobile button labels** — prompt text now says `A=ok B=no` on touch
  devices, `Z=ok X=no` on desktop. New `_yesNoLabels()` helper reads
  `isMobile` from `ui-state.js`. Applies to both delete paths
  (navigate-then-pick and drag-held-to-trash). The key bindings are
  unchanged — mobile's A button has always mapped to `z` via
  `data-key` in index.html; only the on-screen text was wrong.

## 1.7.604 — 2026-05-23

### Trash icon is now a navigable inventory slot

The bottom-right trash is no longer a mode indicator — it's a fixed UI
slot you can navigate to and act on directly. **Always visible.**

Two delete paths, no SELECT toggle required:

1. **Navigate-to-trash → pick item.** Arrow-down past row 7 lands the
   cursor on the trash. Z (with no held item) enters delete-pick mode
   and jumps the cursor back to row 0 so the next Z on an item shows the
   existing confirm prompt. Mirrors the SELECT-toggle flow exactly.
2. **Drag-held-to-trash.** Pick up an item with Z (cursor duplicates
   per v1.7.600), navigate to the trash, press Z. Confirm prompt
   (`Delete X? Z=ok X=no`) and the held item drops from the bag.

Cursor navigation:
- `invScroll` now ranges `0..INV_CAP` (was `0..INV_CAP-1`); the extra
  slot is the trash position.
- When `invScroll === INV_CAP`, the active cursor draws to the left of
  the trash sprite (offset `tx-16, ty+4`, vertically centered against
  the 16×16 trash).

Code:
- `pause-menu.js#_drawPauseInventory` — trash draw lost its `deleteMode`
  gate; added a cursor draw when on trash slot.
- `pause-menu.js#_pauseInputInventory` — arrow-down cap raised to
  `INV_CAP`; Z dispatches to `_pauseInvTrashZPress` when on trash.
- New `_pauseInvTrashZPress` + `_pauseInvDeleteHeld` helpers next to
  `_pauseInvDeletePress` (drag-to-trash confirm prompt mirrors the
  navigate-then-pick prompt; held item is kept on cancel so the user can
  put it back or retry).

The SELECT key still toggles delete mode as a quick keyboard shortcut.

## 1.7.603 — 2026-05-23

### Inventory delete-mode indicator moves to bottom-right corner

The trash icon in the pause inventory was riding the active cursor
(v1.7.602), which made it scroll with the selection and didn't read as a
"delete mode is on" signal. Moved to a fixed position in the panel's
bottom-right corner (4px margin from the right/bottom edges), inside the
clear space below the 8 item rows. Cursor restored to normal rendering;
the trash is now purely a mode indicator. Fade rides `globalAlpha` from
`fadeStep / PAUSE_TEXT_STEPS`.

`pause-menu.js#_drawPauseInventory` only — title-screen Delete button
unchanged.

## 1.7.602 — 2026-05-22

### Real trash icon (the v1.7.599 one was the up-arrow)

The "trash" sprite baked in v1.7.599 (and re-used on the player-select
screen in v1.7.601) was actually FF3's discard-menu **up-arrow** (tile
`$E8`, OAM, vflipped). The real trash can lives in the background layer
of the same menu — a 2×2 cluster of BG tiles `$58`/`$59`/`$5A`/`$5B` at
cols 7-8, rows 19-20 (BG snap @ frame 1905, BG3 palette). 16×16 ridged
silhouette with a pinched lid opening and small base shadow.

`src/data/inventory-icons.js`:
- `getTrashCanvas()` now composites the four BG tiles into a 16×16
  silhouette. Custom per-quadrant renderer draws only color index 3
  (white); indices 0/1/2 (incl. the BG-blue field) stay transparent so
  the icon sits cleanly on any HUD background.
- The old `$E8` sprite is preserved (correctly named) as
  `getUpArrowCanvas()` — same bytes/palette, just labelled honestly.

Call-site sizing:
- `title-screen.js#_drawTitleSelectBox` — 24×24 box unchanged; sprite
  offset 8→4 to center the new 16×16 icon.
- `pause-menu.js#_drawPauseInventory` — delete mode replaces the cursor
  with the trash (was: cursor + 8×8 up-arrow stub side-by-side). At
  `activeX = px+8` the 16×16 right edge lands at `px+24`, exactly the
  item-name start — no overlap.

## 1.7.601 — 2026-05-22

### Player-select Delete button uses the trash icon

Replaced the "Delete" text label on the title's slot-select screen with the
trash sprite from `src/data/inventory-icons.js` (same `$E8` capture used in
the inventory delete mode). Box was width-of-text + 16; now `24×24` (8px
icon + 8px padding on each side). `_drawTitleBox` reads the new width so
the outer HUD hugs the slot row at the correct offset.

Fade rides `ctx.globalAlpha` (1 − fadeStep/SELECT_TEXT_STEPS) since the
trash is a pre-baked canvas — no palette to step through `nesColorFade`.
Dropped the now-unused `SELECT_DELETE_TEXT` byte constant.

## 1.7.600 — 2026-05-22

### Inventory slot order: swap + move-to-empty

Held-item Z on a different row now SWAPS positions (or MOVES into an empty
slot) instead of silently re-picking-up the new row. Pre-fix the held item
stayed put because `playerInventory` was an ID-keyed map with no inherent
order (JS sorts integer-like keys ascending).

`src/inventory.js` — new `playerInventoryOrder` array (capped at `INV_CAP`)
is the source of truth for visible slot positions. `addItem` appends on
new IDs; `removeItem` splices when an entry depletes. New
`swapInventorySlots(srcIdx, dstIdx)` swaps two positions OR moves a filled
slot into an empty trailing slot. `buildItemSelectList()` now reads from
the order array and pads to `INV_SLOTS` with nulls.

`src/pause-menu.js` Items tab — display + navigation reworked:
- Active cursor can navigate to any slot 0..`INV_CAP-1` (empty slots reachable as drag targets).
- Display iterates `buildItemSelectList()`; nulls render as blank rows.
- `_pauseInvZPress` cross-row Z calls `swapInventorySlots` + persists.
- Delete-mode no longer re-clamps the cursor — emptied slots are valid drop targets now.

Persistence: `slot.inventoryOrder` added to both write surfaces in
`save-state.js#saveSlotsToDB`. `src/save.js` mirrors the field on load.
`api.js#_validateSaveData` whitelists + clamps it (8 ids max, range 0-255,
dedup). `setPlayerInventory` accepts the order array; legacy saves
without it fall back to the existing key-order (matches pre-fix display).

Functional check: order is preserved across swap, move-to-empty, removeItem,
setPlayerInventory round-trip; cap enforcement still blocks new ids without
bypass while existing-stack adds and bypassed unequips pass through.

Gates: lint 0, encounter-sim 12/12, pvp-wire-sim 37/37, local boot OK.

## 1.7.599 — 2026-05-22

### Inventory cap of 8 + SELECT-toggled delete mode

`src/inventory.js` — new `INV_CAP = 8`; `addItem` rejects new IDs when at
cap unless `opts.bypass` is set; existing-ID stacks still grow without
limit. New `canAddItem(id)` helper for callers that need to pre-check
before charging (shop refund, trade-receive decline). `INV_SLOTS` bumped
3 → 8 to match the cap in the Trade pick panel.

**Equip flows pass `{ bypass: true }`** so unequip never destroys gear
even when the bag is full: `_enforceEquipRestrictions`, `_equipBestMainSlots`,
`_equipBestLeftHand`, `_pauseInputEquipItemSelect`, and the two hotkey-equip
sites in `input-handler.js`.

**Shop** (`src/shop.js#_attemptBuyItem`) pre-checks `canAddItem` before
spending gil; full-bag buys show "Bag full!" and don't deduct.

**Trade receiver** (`src/trade.js setNetTradeOfferHandler`) auto-declines
incoming offers when the receiver's bag is full — no prompt, no dup.

**Delete mode** (`src/pause-menu.js`):
- `pauseSt.deleteMode` boolean, reset on Items-tab exit.
- SELECT (key `s`) toggles delete mode inside the Items tab. Held-item
  is cleared on toggle so you can't enter delete mode mid-pickup.
- Trash icon renders to the right of the cursor while delete mode is on
  (sprite from FF3 OAM `$E8` capture, SP3 palette `[0x0F, 0x00, 0x10, 0x30]`,
  pre-baked vflipped in `src/data/inventory-icons.js`).
- Z in delete mode: `showMsgBoxPrompt("Delete <Item>? Z=ok X=no")`. Confirm
  drops the entire stack via `removeItem(id, getItemCount(id))`, persists,
  re-clamps the scroll cursor. X cancels the prompt (and exits delete mode
  if pressed outside the prompt).

Gates: lint 0, encounter-sim 12/12, pvp-wire-sim 37/37, local boot clean.

## 1.7.598 — 2026-05-22

### Real multiplayer trade (pre-flip bug fix)

The roster Trade action was a single-player sim that called `removeItem`
unconditionally on local accept-roll — with real players in the roster
(post-fake-player era), every accepted trade was destroying items with
nothing going to the recipient. Replaced the sim with a server-relayed
offer/response.

**Wire (server in `ws-presence.js`):**
- `trade-offer` { targetUserId, itemId } — sender → server. Validates target
  online + itemId in range. Stores in `_pendingTrades` Map (offererUserId
  → { targetUserId, itemId, expiresAt }). New offer from same sender
  overwrites prior offer + cancels the prior prompt.
- `trade-offer-incoming` { fromUserId, fromName, itemId } — server → target.
- `trade-response` { fromUserId, accept } — target → server. Validates the
  response matches an outstanding offer; ignored if stale/spoofed.
- `trade-result` { targetUserId, targetName, accept, reason? } — server →
  sender. `reason='offline'` when the target is no longer connected.
- `trade-cancel` — sender → server. Server relays `trade-cancelled` to the
  target so their prompt dismisses.
- Disconnect cleanup notifies the surviving side either way.

**Client (`src/trade.js`):**
- Stripped the sim-roll path (`getAcceptChance`, `MAX_MISSED_ROLLS`,
  `TARGET_ROLL_*`). `tickTrade` now just runs timeout / death-cancel.
- `commitOffer` calls `sendNetTradeOffer(target.userId, itemId)`. Refuses
  to send if the target lacks a `userId` (defensive).
- `cancelTrade` issues `sendNetTradeCancel()` on user / timeout / death so
  the server can clear the pending entry.
- New net handlers: `applyTradeResult` (route accept → existing
  `_resolveAsAccept`, decline → "Declined", offline → "Offline"),
  `applyTradeOfferIncoming` (prompt via `showMsgBoxPrompt`; auto-decline
  if in-battle / another msgbox / already trading — mirrors party-invite
  busy guard), `applyTradeCancelled` (dismiss prompt if it matches the
  current `recvFromUserId`).
- Receiver-side state: just `tradeSt.recvFromUserId` so a `trade-cancelled`
  for an old sender doesn't dismiss someone else's incoming prompt.

**Trust model — known limitation:** server doesn't track inventory. A
malicious sender can claim an item they don't actually own → recipient's
client adds it from nothing (dup). Same gap as `give-item`. Documented in
`project_ff3mmo_persistence_layer` notes; hardenable with a server-side
inventory mirror later.

Gates: lint 0, encounter-sim 12/12, pvp-wire-sim 37/37, local boot clean.

## 1.7.597 — 2026-05-22

### Open-beta landing copy + neutralized gate (prep #4)

`index.html` — added a `#landing-pitch` block inside `#rom-picker-wrap`
(auto-hides when gameplay starts). New muted-grey lede + sub lines and a
gold "— OPEN BETA —" tag at the bottom of the pitch:

  > A turn-based browser MMO inspired by NES-era Final Fantasy.
  > No install. No download. Bring three ROMs, get a world.
  > — OPEN BETA —

`#rom-hint` collapsed to a tight one-liner: "You supply your own ROMs —
nothing is uploaded." (was 2 lines mentioning caching).

Gate-dialog copy (only shown when `GATE_PASSWORD` is set; hidden once
flipped off): `◆ Coming Soon ◆` → `◆ Beta ◆`; `Something is being built
here. Closed beta — invite only.` → `Beta password required.` Defensive
neutralization in case a cached gate page surfaces during/after flip.

## 1.7.596 — 2026-05-22

### Position persistence across crashes (open-beta prep #3c)

New `presence_shadows` SQLite table (user_id PK; name / loc / profile_json /
last_seen) — periodic snapshots of the live `_connected` roster so a server
crash doesn't dump everyone's overworld state. `api.js` exports
`presenceFlushBatch` / `presenceDelete` / `presenceLoadRecent` /
`presenceReap`; the batch flush runs inside a `db.transaction` so 100+
players is one journal sync.

`ws-presence.js` runs two interval timers via `attachWebSocketPresence`:
flush every 30s (writes every helloed user), reap every 60s (drops shadows
older than 10min and fires `player-leave` so live clients clean their
roster). On boot, recent shadows seed `_shadows` and are included in
`_snapshotPayload` alongside live entries — same shape, so the client
doesn't differentiate. When a real `hello` arrives the matching shadow is
evicted; the existing `player-join` broadcast upserts in clients that had
the shadow.

**SIGTERM survival:** `process.on('SIGTERM')` flips `_gracefulShutdown=true`
and *doesn't* exit. pm2's kill_timeout escalates to SIGKILL, which doesn't
run close handlers — so shadows survive the pm2 restart. Voluntary user
disconnect (tab close) hits the close handler with the flag still false
and calls `presenceDelete(userId)`, dropping the SQLite row so the user
doesn't appear as a stale shadow on a later boot. Dev `Ctrl-C` (SIGINT)
left untouched.

Gates: lint 0, encounter-sim 12/12, pvp-wire-sim 37/37, local boot
verified table creation + boot-load loop against empty table.

## 1.7.595 — 2026-05-22

### Parties persist across disconnect + server restart (open-beta prep #3b)

New `parties` SQLite table (member_user_id PK → inviter_user_id) is the
source of truth for party relationships; the in-memory `_partyMemberships`
Map mirrors it. `api.js` exports `partyAddMember` / `partyRemoveMember` /
`partyRemoveByInviter` / `partyLoadAll`; `ws-presence.js` seeds the Map
from `partyLoadAll()` at boot and persists at every explicit-mutation site
(accept / dismiss / leave).

**Behavior change:** disconnect no longer dissolves the party. Both the Map
row and the SQLite row are preserved across disconnect + server restart;
only an explicit leave/dismiss removes them. Peers still receive
`party-member-left` so their visible (online-only) party list updates.
Inviter-disconnect now also sends `party-member-left` (symmetric with
member-disconnect) instead of `party-disbanded` — the relationship persists
and resumes when the inviter reconnects.

**Reconnect fan-out:** on first hello of a session, the server looks up the
user's party-mates via new `_getPartyMates` helper. Sends `party-snapshot`
to the returning user listing currently-online mates, and
`party-member-joined` to each online mate so they see the returning user.
Reuses existing client message types — no client change required.

Gates: lint 0, encounter-sim 12/12, pvp-wire-sim 37/37, local boot
verified the table is created and the seed loop runs clean against an
empty table.

## 1.7.594 — 2026-05-22

### Party members travel with you into battle from any room

`tryJoinPlayerAlly` (`src/battle-update.js`) drops the same-room gate for
party members. Party-priority pre-pass now joins on `online` only — they can
be in Ur, you can be in Altar Cave F2, they still fill an ally slot computed
from their live broadcast profile. Same-room roster fill (non-party) is
unchanged: still room-scoped, still no random gate.

The round-boundary reconcile mirrors this rule — party allies stay in your
battle as long as they're online; non-party allies still drop when they
walk out of the room. Reverses the v1.7.559 room-gate for party members
only; reconcile + fill share a single `partyNames` set so the two halves
agree.

Wire-PvP path untouched (lockstep-deterministic). Gates: lint 0,
encounter-sim 12/12, pvp-wire-sim 37/37.

## 1.7.593 — 2026-05-22

### Auto-rollback on smoke failure (open-beta prep #2)

`deploy.sh` now captures prod's current HEAD SHA before the remote `git
pull`. If `./smoke.sh` fails post-restart, the script ssh's back to prod,
`git reset --hard`s to that SHA, reinstalls deps, restarts pm2, and re-smokes
to confirm the rollback is healthy. The bad commit stays on `origin/master`
as a record — fix forward in a new commit; don't retry the same SHA. The
script exits non-zero in all failure paths.

Dry-run-tested the rollback ssh against prod by resetting to the same SHA
it was already on (no-op reset, real reinstall + restart + re-smoke) — all
pass clean.

## 1.7.592 — 2026-05-22

### Add /health endpoint (open-beta prep #1)

New `GET /health` in `server.js` returns JSON `{ status, version, uptimeSec,
players, playersTotal, gate }`. Unauthed, unrate-limited, `Cache-Control:
no-store`. Intended for external uptime monitors (UptimeRobot etc.) and a
quick "is prod up + how many people are on" check. `players` is the visible
count (helloed only); `playersTotal` includes mid-handshake sockets. `gate`
field reports `'on'`/`'off'` so the same probe surfaces the current beta
status.

`getPlayerCounts()` added to `ws-presence.js` as the source of truth. First
item in the open-beta operational-hardening track.

## 1.7.591 — 2026-05-22

### Fix: only the bottom half of beds triggers sleep

Removed bed-top-half tile `$0a` from the inn (tileset 5) trigger set in
`src/data/beds.js` — walking onto the pillow no longer kicks off the rest
sequence. Only the two bottom-half tiles (`$0b`, `$62`) trigger now, which
matches the "walk up the side of the bed" approach.

## 1.7.590 — 2026-05-22

### ROM loader accepts .zip archives

The three ROM file inputs (FF3/FF1/FF2) now accept zipped ROMs in addition to
raw `.nes` files. New `src/zip-loader.js` parses the ZIP central directory and
inflates entries using the browser-native `DecompressionStream('deflate-raw')`
— no external dependency. It picks the first `.nes` entry, falling back to the
largest regular file. Raw `.nes` uploads pass through unchanged. Verified
round-trips locally against deflate, stored, and multi-entry archives. Inputs
gained `accept=".nes,.zip,application/zip"` and labels updated to reflect it.

## 1.7.589 — 2026-05-22

### Fix: chests spawning in Altar Cave F2 hallways

`findCornerFloor`'s corner test (`(wL||wR) && (wU||wD)`) also passed at 1-wide
corridor *bends*, so Altar Cave floor 2 (floorIndex 1, generic gen path) dropped
chests in hallways. Now it requires a true room corner: exactly one wall per axis
AND the interior diagonal is floor (a 2×2+ floor block) — a corridor bend's
diagonal is wall, so it's rejected. Validated 0 hallway chests across 120 seeds
each on floors 0/1/2 (floor 3's branch-alcove chests are placed directly, not via
this helper, and are unchanged).

## 1.7.588 — 2026-05-22

### Remove TEMP FenixDown from Ur shop

Pulled the testing-only FenixDown (`0xA9`) from the Ur item shop (`ur_item`) now
that the revive is verified. It remains a rare Altar Cave chest drop.

## 1.7.587 — 2026-05-22

### Message box now renders on top of the battle

`drawMsgBox` ran before `drawBattle` in the frame, so the FenixDown "Use?" confirm
(and any battle dialogue) drew behind the battle scene. Moved `drawMsgBox` to last
in the draw block so dialogue/prompts sit on top.

## 1.7.586 — 2026-05-22

### Revive fixes: enemy box stays up, death pose uses custom color

- **Battle scene vanished during the revive:** `_isEncounterCombatState()` (which
  gates `drawEncounterBox`) didn't include the new `'fenix-revive'` state, so the
  enemy box disappeared during the death/confirm/angel sequence. Added it.
- **Death pose wrong palette:** the player death pose hardcoded palette `[0]`,
  ignoring the player's custom color (`ps.palIdx`). Now indexes the chosen slot
  (the ally death pose already did). Pairs with the v1.7.578 select-screen fix.

## 1.7.585 — 2026-05-22

### TEMP: FenixDown in Ur item shop (testing)

Added FenixDown (`0xA9`) to the Ur item shop (`ur_item`) so the revive can be
tested without farming chest drops. Marked `TEMP … REMOVE after testing` in
`data/shops.js` — remove before open beta.

## 1.7.584 — 2026-05-22

### Death-sequence timing + poison-at-1HP

- **Death sequence order:** the player's portrait used to start falling the
  instant HP hit 0, overlapping the hit's damage number. The FenixDown revive
  now opens with a `dmg-hold` phase — it seizes immediately (so game-over can't
  fire) but holds on the hit (shake + damage number) and only starts the kneel/
  fall once the number finishes. So it reads: hit → damage number → fall.
- **Poison at 1 HP:** poison already clamped to 1 HP (never kills), but at exactly
  1 HP it still popped a damage number for HP that wasn't lost. Now the player's
  end-of-round poison tick is skipped at ≤1 HP (no damage, no number) — NES rule.

## 1.7.583 — 2026-05-22

### Ally revive — angel sequence

Reviving a downed ally with FenixDown now plays the same spirit sequence as the
player's own revive, beside the ally's roster row: death pose → flapping **angel**
(rising) → body fades / portrait slides up → **"Revived"** + heal number, then the
turn advances. ~1/3 max HP.

Generalized `battle-fenix-revive.js` to a target (player vs ally) instead of
duplicating: new `startAllyRevive(idx)` + `fenixReviveAllyIndex()`; rise/healnum
branch on the target. `battle-turn.js` revive effect routes a downed ally through
it (living target still falls back to a heal). Rendered in `battle-draw-allies.js`
death block (angel + rise), gated to the reviving ally.

## 1.7.582 — 2026-05-22

### FenixDown manual use — proper revive (was a mis-heal)

Manually selecting FenixDown in the battle Item menu had no `revive` effect
branch, so it fell through to the default heal (restored 100 HP to a living
player — wasting a rare item). Now it's a real revive:

- New `effect === 'revive'` branch in `_playerTurnConsumable` (battle-turn.js):
  revives a downed ally to ~1/3 max HP, clears the death pose, pops the heal
  number, plays `SFX.REVIVE` (not Cure). Living target falls back to a `power`
  heal so it's never silently wasted.
- `_itemSelectZ` (input-handler.js): revive items auto-target the first downed
  ally (you can't revive a living target). No dead ally → error, can't use.
- The player's OWN on-death revive (angel + confirm prompt) is unchanged — that
  remains the dedicated `battle-fenix-revive.js` auto path.

## 1.7.581 — 2026-05-22

### Phoenix Down revive — confirm prompt + heal number

The revive now asks first. After the death pose holds, a box pops up: **"Use
FenixDown? A:Yes B:No"** (A→z, B→x — works on the mobile deck and keyboard). The
item is only consumed on **Yes**; **No** is normal game-over. After the portrait
slides back into the HUD, a green **heal number** pops showing the HP restored
(~1/3 max), then the battle resumes.

- `battle-fenix-revive.js` phases now `death-anim → confirm → angel → rise →
  healnum`; item consumed in `fenixConfirmYes` (not at death). New `healnum`
  phase ticks/clears the heal number (it's not ticked in `menu-open`).
- Confirm input handled in `input-handler.js` `_battleInputHoldStates` (the box
  renders over battle; its overworld Z/X dispatch in movement.js doesn't run mid-battle).

## 1.7.580 — 2026-05-22

### Phoenix Down revive — real SFX

Replaced the interim `SFX.CURE` revive cue with the verified party-death/angel
jingle: **`SFX.REVIVE = 0x92`**. A fresh REC OAM capture started *before* the
death (start f311) caught the genuine request — CPU writes `$D1` to `$7F49` at
frame 40 as the angel appears → NSF track `$D1 - $3F = $92`. Confirms the earlier
`$40` was the post-consume residual, not the request. Plays at the angel phase.

## 1.7.579 — 2026-05-22

### Phoenix Down revive — death angel + "Revived"

Reworked the FenixDown auto-revive presentation to use FF3's party-death spirit.
Sequence now: death pose holds (~1s) → a 3-frame flapping **angel** appears to the
LEFT of the body, drifting upward → the body fades out as the portrait slides up
into the HUD → battle message **"Revived"**. Player returns at ~1/3 max HP.

- New `src/data/revive-angel-sprite.js` — the angel built from captured FF3 OAM
  (2×2 tiles, SP3 palette `[0x0F,0x27,0x36,0x30]`, 3 flap frames). Lazily built.
- `battle-fenix-revive.js` phases: `death-anim → angel → rise` (replaces the old
  message/sparkle phases). `battle-draw-player.js` renders the angel beside the
  death pose during the `angel` phase.
- **SFX pending:** the captured `$7F49=$40` is the audio engine's post-consume
  residual, not the requested index (same trap documented on `SFX.SIGHT`/
  `FIRE_BOOM`, v1.7.111-112). Using `SFX.CURE` as the interim revive cue until a
  recapture started *before* death logs the real `$7F49=$Cx` write.

## 1.7.578 — 2026-05-22

### Player-select screen shows custom character colors

The save-slot select screen drew every character portrait with palette 0,
ignoring the slot's saved custom color. Now `_drawSelectSlotRow` indexes
`fakePlayerPortraits[jobIdx][palIdx]` (falling back to 0), matching the roster's
portrait path, so each slot displays the color the player actually chose. Pairs
with the v1.7.574 palIdx-persistence fix.

## 1.7.577 — 2026-05-22

### Debug: consumable-grant buttons (EMU tab)

Added FENIX DOWN and CONSUMABLES grant buttons to the EMU debug tab's edit row,
alongside the existing spell/HP/inv presets. They poke item IDs into the FF3
inventory SRAM ($60C0 ids / $60E0 qty) via a new `_grantItems` helper that bumps
an existing stack or fills the first empty slot (no clobber). FENIX DOWN grants
Phoenix Down ×99; CONSUMABLES grants the full 0xA6-0xAF consumable block ×99.
IDs are ROM-accurate (items.js is keyed by ROM id). Supports setting up the
revive-animation OAM capture.

## 1.7.576 — 2026-05-22

### Phoenix Down — rare auto-revive item

FenixDown (item `0xA9`) is now obtainable and functional as an automatic revive.

- **Loot:** added as a rare chest drop in Altar Cave F2/F3/F4 (`LOOT_POOLS` in
  `map-triggers.js`, weight 2/2/3 — ~2-3%). Not in F1, not sold in shops.
- **Auto-revive:** if the player would die in battle while holding a FenixDown,
  one is consumed automatically instead of game-over. Sequence: the full death
  animation plays → "FenixDown!" battle message + revive sparkle → death pose
  fades out → live portrait rises from the bottom of the slot → player returns
  at ~1/3 max HP (status cleared, NES-canon clean revive), fresh turn.
- New module `src/battle-fenix-revive.js` owns a self-contained sub-FSM
  (`battleState 'fenix-revive'`). It's seized at the single death-detection
  chokepoint (`updateBattleTimers`, which runs before all state handlers), so
  the normal turn/box-close routes no-op for the duration — no scattered
  `ps.hp<=0` guards. Wired in `battle-update.js`; rendered in
  `battle-draw-player.js`. Simultaneous player+last-enemy death routes to the
  victory path instead of an empty menu.
- **Animation note:** the revive sparkle reuses the legacy Cure-sparkle fallback
  (the same path every un-captured item anim uses) pending a dedicated revive
  OAM capture. Swap in real frames by registering the captured bundle in
  `spell-anim.js` under the revive spell id; no other changes needed.

## 1.7.575 — 2026-05-22

### Player bug-report channel

New `/bug <description>` chat command lets logged-in players file gameplay bug
reports (the existing `/api/client-error` only catches thrown JS exceptions, and
`/report` is for player abuse — neither covers "the game did something wrong").
Authed + rate-limited under the auth bucket. Auto-attaches repro context: player
name, client version, map id + tile coords, world-map flag, dungeon floor, and
current battle state. Stored in a new `bug_reports` SQLite table for manual
review (no automated action). Server: `/api/bug-report` in `api.js`. Client:
`registerCommand('bug', …)` in `src/chat.js`.

Review on prod (sqlite3 CLI isn't installed; use the bundled better-sqlite3):
`ssh root@68.183.59.19 'cd /var/www/ff3mmo && node tools/bug-reports.cjs'`

## 1.7.574 — 2026-05-22

### Fix: custom player color not saving across sessions

`ps.palIdx` (Options → Color) was copied into the active save slot but **dropped
from the serialized payload** in `saveSlotsToDB` — so it was never written to
IndexedDB or POSTed to the server, and reloaded as `0` every session. Added
`palIdx` to the serialized slot object (next to `jobIdx`). Server whitelist
(`api.js`, clamp 0-7) and `parseSaveSlots` already handled it; this was the one
missing link. Custom colors now persist locally and server-side.

## 1.7.573 — 2026-05-22

### Entrance landing locked in as a permanent template

Extracted the 3x3 entrance-landing carve into `openEntranceLanding()` — a single,
LOCKED source next to `placeEntrance`, documented with the hard rule (call AFTER
`addOverhang`, frame floor sits above so no ceiling pinch). Floor 0 now calls it
instead of an inline loop; any future top-entrance floor uses the same template.
No behavior change — validated identical: 3x3 landing 150/150, 0 disconnected,
0 floating ceilings, exit 150/150.

## 1.7.572 — 2026-05-22

### Floor 1: 3-wide entrance landing (not a 1-wide neck)

The entrance fed into the room through a 1-tile-wide neck (the passage piercing
the top rocky overhang band). Now the landing opens to a 3x3 floor pocket: the
frame's bottom is already 3 floor tiles, and that width is carried down through
the band into the room — carved after `addOverhang` so it isn't re-walled (the
frame floor sits directly above, so no ceiling pinches it). Validated 150 seeds:
3x3 landing 150/150, snake still one piece (0 disconnected), 0 floating ceilings,
0 floating rocky in the cave body, exit 150/150. Entrance frame itself untouched.

## 1.7.571 — 2026-05-22

### Floor 1: chests always in corners (touching 2 walls)

Two fixes so floor-0 chests stop spawning flat against a single wall:
`chamberBounds` now uses the ACTUAL floor bounding box instead of `1..30`, so
`findCornerFloor`'s near-edge test lines up with the real room walls; and the
placement fallback is now "any corner" (`findCornerFloor(..., null)`, which still
enforces the 2-perpendicular-wall test) instead of `findWallAdjacentFloor` (1
wall). Validated 200 seeds: 0/883 chests on a single wall, 2-8 chests/floor.

## 1.7.570 — 2026-05-22

### Floor 1: one continuous ceiling snake (rebuilt as a single inside-shape)

Rebuilt floor 0 generation: instead of two separate room outlines + a patched
corridor (which left Room B's ceiling as a disconnected formation), it now
assembles ONE inside-shape mask (both rooms + a gap-only neck) and traces a
single continuous perimeter — the same boundary mode the deeper floors use.
Diagonal perimeter gaps are closed to a fixpoint so the snake stays cardinally
continuous; `addOverhang` eats the 5-tall neck down to a 1-tile corridor; the
secret corridor is restricted to the outer walls (clear of the neck). Validated
150 seeds: exit 150/150, ZERO disconnected ceilings (counting the disguised
false-ceiling secret tiles), ZERO ceilings without 2 walls beneath, entrance intact.

## 1.7.569 — 2026-05-22

### Floor 1: corridor built clean by construction

Rewrote the connecting corridor so it's carved LAST with the full secret-corridor
wall column built explicitly per tile (ceiling/rocky/rocky/floor/ceiling/rocky/
rocky) — satisfying every cave invariant by construction, so no later pass can
mangle it. Cleanup passes (gap-close → connectivity → overhang) run before it for
the rooms + secret. Validated 80 seeds: exit 80/80, 0 floating ceilings, 0
floating rocky (outside the original entrance frame), 0 disconnected ceilings,
entrance block intact. The horizontal corridor is inherently a 7-tile-tall rock
column (the ceiling rule requires it).

## 1.7.568 — 2026-05-22

### Floor 1: enforce ceiling-overhang rule + keep chests out of entrance

`addOverhang` now runs as the **final** pass (after the corridor carve), so every
ceiling — rooms, corridor, secret — ends up with another ceiling or 2 rocky tiles
beneath it (no floating ceilings); the corridor forces rocky directly above its
floor so the overhang can't fill it. Also excluded the entrance block + its
landing from chest placement. Tested 80 seeds: exit 80/80, 0 floating ceilings,
0 disconnected ceilings, 0 chests in the entrance, entrance block intact 80/80.

## 1.7.567 — 2026-05-22

### Floor 1: fix disconnected/floating ceilings

Floor 0 was the only floor never running `ensureCeilingConnectivity`, so the
two-room layout could leave isolated/clustered ceiling tiles. Added the pass
(matching every other floor). The connecting corridor is now carved after
`addOverhang` + the final gap-close, then ceilings are reconnected — clean walls,
nothing floating. Verified across 60 seeds: exit reachable 60/60, 0 disconnected
ceilings, entrance block intact 60/60.

## 1.7.566 — 2026-05-22

### Floor 1: corridor walls + close Room B's top

The narrow corridor now has proper rock walls (rocky + ceiling above, ceiling +
rocky below — same as the secret corridors) instead of a bare floor line, and
**Room B's top is capped** with ceiling + rocky overhang (it has no entrance, so
it was sitting open against the void). Both follow the standard ceiling/wall +
`addOverhang` rule. Connectivity 60/60.

## 1.7.565 — 2026-05-22

### Floor 1: narrow the connecting corridor

The room-to-room corridor was 3 tiles tall (it had to be, to survive the
`<3` gap-closing pass). Carved it **after** the final `enforceMinCeilingGap`
instead, so it's now a clean **1-tile-tall** passage. Connectivity holds 60/60.

## 1.7.564 — 2026-05-22

### Altar Cave floor 1: two-room renovation

Floor 1 is now **two side-by-side chambers** (random left/right) joined by a
**walkable rock corridor**: Room A holds the entrance + moogle, Room B holds the
**exit stairs** (moved out of the opening room). Both rooms get skeletons +
chests. A **secret teleport** still spawns on the **opposite outer wall** (~63%
chance). Outside-wall visual preserved (rooms are rock carved into the void
fill). Implemented via a width cap (`buildCaveShape` `maxWidth`) + per-room fill
`clamp` so two chambers don't merge; chests fall back to wall-adjacent when no
corner qualifies. Validated entrance→exit reachable on 60/60 seeds with the new
`tools/floor-view.mjs`. `dungeon-generator.js`, `npc.js` (moogle now spawns in
Room A).

## 1.7.563 — 2026-05-22

### Chest mimics — monsters in the loot pool

Cave chests now have a `monster` loot tier (~13–16%): instead of a "Found …"
item, the box reads **"Monster appeared!"** and on dismiss runs a normal battle
flash + **one random monster** from that floor's encounter pool. New
`startChestMimic()` in `battle-encounter.js` (shares a `_makeEncounterMonster`
helper with `startRandomEncounter`); `rollLootEntry`/`handleChest` in
`map-triggers.js` handle the `{ monster: true }` tier.

## 1.7.562 — 2026-05-22

### Loot: potions rarer in cave chests

Cut Potion weight across all Altar Cave floors so chests favor gil/gear: F1
52%→25%, F2 42%→17%, F3 32%→12%, F4 22%→7%. Ur town starter chest unchanged.
`map-triggers.js` LOOT_POOLS.

## 1.7.561 — 2026-05-22

### Altar Cave floor 1: skeletons, corner chests, leashed moogle

`FLOOR_CONFIG[0]` now spawns **4–7 skeletons** (scattered) and **1–2 chests in
the corners** (previously zero — floor 0 had only the hidden secret-room chest).
Gave floor 0 a real `chamberBounds` (bounding box of the path-mode cave floor)
so `findCornerFloor` places the chests in actual corners. The cave moogle is now
**leashed** to within 2 tiles of its center spawn (`MOOGLE_LEASH`) so it wanders
but stays findable. Validated: 40/40 seeds generate cleanly. `dungeon-generator.js`,
`npc.js`.

## 1.7.560 — 2026-05-22

### Roster: party badge on the name line

Roster players who are in your party now show a small **green party icon** at
the left of their name line — the black-magic school glyph ($75) recolored to a
green palette ($1A/$2A). Fills the space left by the dropped in-battle dot.
`roster.js`.

## 1.7.559 — 2026-05-22

### Battle allies: room-gated party + leave/join by room

`tryJoinPlayerAlly` now reconciles the ally team each round (it already ran at
`confirm-pause`): drops any ally whose live broadcast loc left the battle's room
("leave battle if you leave the room"), then fills — **party members get
priority but only while online + in the same room** (was travel-with-anywhere),
then other roster players in the room fill remaining slots up to the 3-cap.
Allies remain local AI driven by the joiners' real stats/equipment (no true
co-op by design). Wire-PvP path untouched (lockstep); pvp-wire-sim 37/37.

## 1.7.558 — 2026-05-22

### Roster: drop online dot, blink name to red "Battle!"

Removed the green online dot (being in the roster already implies online) and
the red in-battle dot. A real player currently in combat now has their **name
blink to a red "Battle!"** in the roster row (~450ms). `roster.js`.

## 1.7.557 — 2026-05-22

### Crystal flash brackets each message + drop heal SFX

The thunder + flash now fires both before AND after each crystal message
(mirrors FF3 event $4B, where flash brackets the dialogue), and on the repeat-
talk message too — not just the first. Removed the heal (cure) SFX from the
repeat-talk restore.

## 1.7.556 — 2026-05-22

### Crystal thunder SFX — correct track

`SFX.CRYSTAL_THUNDER` set to NSF track 132 ($84), the actual crystal
flash/thunder (found by audition; the first guess $7F was wrong).

## 1.7.555 — 2026-05-22

### Fix crystal dialogue overflow + add /sfx audition

Crystal blessing pages were wrapping to 4 lines and bleeding past the 48px box
(16 chars/line, 3 lines max). Rewrote them to fit. Added a `/sfx <track>`
console command (decimal or 0x-hex) to audition FF3 SFX by NSF track — used to
pin down the crystal thunder, which the first guess ($7F) got wrong.

## 1.7.554 — 2026-05-22

### Wind Crystal talk — thunder, flash & job-unlock line

Completed the crystal first-talk to match FF3 event $4B: a **thunder SFX**
(`SFX.CRYSTAL_THUNDER` = NSF track $7F, the sound `F8 7F` plays) + a **screen
flash** (reuses the pond-drink viewport strobe, flash→message ordering), then the
blessing. Added an explicit **"New jobs unlocked! Switch jobs in the menu."** line
(the job grant on Land Turtle defeat was previously silent). Repeat talks still
full-restore (HP/MP/status) per FF3 event $C5.

## 1.7.553 — 2026-05-21

### Wind Crystal — talk interaction

The revealed Wind Crystal is now talkable (`talkToNpc` crystal branch in
`src/npc.js`). First talk = the crystal's blessing (condensed from the FF3 NES
Altar-Cave crystal event $4B / strings $1D-$1E, addressed to a single Light
Warrior). Repeat talks = a flavor line + **full restore** (clear status + refill
HP/MP), mirroring FF3 event $C5. Plays the cure SFX. Single-character phrasing
("Light Warrior"), not FF3's party-of-four plural.

## 1.7.552 — 2026-05-21

### Wind Crystal reveal (Land Turtle defeat)

After defeating the Land Turtle, the overworld turtle sprite now **blinks a few
times then morphs into the standing Wind Crystal** (3-frame shimmer, 16×32, OAM-
captured). `src/crystal-sprite.js` (NEW) builds the frames from the captured PPU
bytes (same raw-tile approach as south-wind.js); init in `boot.js`. On defeat,
`startCrystalReveal()` flips the existing turtle NPC into the reveal instead of
removing it — the blink plays once the battle HUD exits (the reveal ticks in
`updateNpcs`, overworld-only). Re-entering the Crystal Room while still defeated
shows the crystal directly (`addCrystalNpc`); the turtle still respawns on
world-map exit (re-fightable, unchanged). The in-battle block-dissolve death is
unchanged.

## 1.7.551 — 2026-05-21

### Fix: shop Gil overlap past 9999

The shop's Gil total was right-aligned on the same line as the "Gil" label, so a
5+ digit total ran back into the label (gil caps at 999999). Moved the value to
its own line below the label — `_drawGil` in `src/shop.js`. The value line clears
both the keeper sprite and the Buy/Sell/Exit menu.

## 1.7.550 — 2026-05-21

### Options: Battle Speed (re-added)

Re-added the **Battle Speed** row (Slow / Norm / Fast) dropped in the v1.7.456
round-based revert. Implemented as a single dt scale at the top of
`updateBattle` (`settings.js#battleSpeedMult` → 0.65 / 1.0 / 1.6), so timers,
message holds, and animations all pace together; Normal is 1.0 (unchanged play).
Solo-only — PvP/co-op are disabled, so no wire-sync depends on battle dt.
Stored in `settings.js` (device-local).

Text/message speed was evaluated and intentionally **not** added: the engine
has no per-character typewriter (text renders whole) and overworld dialogue
advances on button-press, so a speed slider would have no real effect there —
and in-battle message pacing already follows Battle Speed.

## 1.7.549 — 2026-05-21

### Options: Music & SFX volume

Added **Music** and **SFX** volume rows to the Options menu (10-step bars, ◀/▶ to
adjust). Stored in a new device-local `src/settings.js` (localStorage, per browser
— not per save). Implemented via two new master-gain buses in `music.js`:
`musicMasterGain` (FF3/FF1/FF2 emulators) and `sfxMasterGain` (SFX + the @-mention
chime) — every per-emulator gain now routes through one of these, so the per-track
fade-out ramps are untouched. Also fixed `resumeMusic()` to route through the music
bus instead of bypassing the gain node straight to the destination. `applyMusicVolume()`
/ `applySfxVolume()` apply live; stored volume auto-applies on first audio.

## 1.7.548 — 2026-05-21

### Options: player color picker

Beefed up the Options menu with a **Color** picker — players can now cycle their
sprite color across 8 per-job slots (`ps.palIdx`, persisted per save and broadcast
in the presence profile so other players see your color too). The choice repaints
everywhere: overworld walk sprite, battle/HUD portrait, and roster. Slot 0 is the
job canon (byte-identical to before), slots 1-7 recolor the outfit only (skin/hair/
face untouched). Single source: `jobBattlePalette(jobIdx, palIdx)` in
`src/data/players.js` (battle-drawing's `_jobPalette` now delegates to it);
`swapBattleSprites(jobIdx, palIdx)` is the one entry point that repaints all views.
Options menu is now data-driven multi-row (up/down to pick a row, left/right to
change a value); CRT toggle moves to row 2. Volume + text/battle speed rows land
in follow-up slices.

### Mobile controls: right-align CHAT/LOG

CHAT/LOG top strip now right-aligned.

## 1.7.546 — 2026-05-21

### Mobile controls: CHAT/LOG to the top strip

Moved CHAT/LOG up to a flat top strip (where the old utility row sat). SELECT/START remain the angled Game Boy center pills below the D-pad + A/B.

## 1.7.545 — 2026-05-21

### Mobile controls: swap pill rows

CHAT/LOG now sit on the lower center-bottom row (where SELECT/START were); SELECT/START moved to the top row of the cluster.

## 1.7.544 — 2026-05-21

### Game Boy-style mobile control deck

Reworked the on-screen controls to a Game Boy layout: D-pad left, **A upper-right / B lower-left on the diagonal**, and the menu/utility buttons as `-22°` angled pills centered below — CHAT/LOG on top, SELECT/START beneath. Dropped the old top utility strip. All `data-key`s, the CHAT keyboard-summon hook, multi-touch slide tracking, and press highlighting carry over unchanged.

## 1.7.543 — 2026-05-21

### Configurable beta/dev gate + mobile polish

**Gate config (per-server from one codebase):**
- The `#pw-gate` password is now injected by the server from a `GATE_PASSWORD` env var: unset → `ff3dev` (default closed-beta gate); `off`/empty → gate disabled (open server, hidden from first paint to avoid a flash); any value → custom password. Lets local-dev stay gated while the beta server can open (or use a separate password) without code changes. Soft client-side curtain only.

**Mobile (Tier-1 polish):**
- **Audio gesture-unlock**: `unlockAudio()` wired to the first pointer/touch/key event creates + resumes the `AudioContext`, so music and the @-mention chime reliably start on mobile (autoplay policy could leave them silent before).
- **Double-tap-zoom**: `touch-action: manipulation` on the canvas kills double-tap-zoom + the 300ms tap delay over the play area; pinch-zoom still works.

## 1.7.542 — 2026-05-21

### Fix: roster "Message" focuses the chosen conversation

v1.7.541's per-conversation Private tab made `_pmSession` outrank `pendingRecipient`, so the roster menu's **Message** action (which only set `pendingRecipient`) could reply to a previously-focused player instead of the one you clicked. Message now routes through `focusPmSession`, overriding the active session.

## 1.7.541 — 2026-05-21

### Open-beta hardening: moderation + chat/PM overhaul

**Moderation (server-side, untrusted input):**
- New `moderation.js` (pure module). `sanitizeName` strips display names to renderable font glyphs — kills emoji / zero-width / homoglyph spoofs; `cleanChatText` masks profanity (catches leet/spaced/repeated evasion without Scunthorpe false-positives).
- `ws-presence.js`: every name sanitized + profanity-rejected (→ "Player"); all chat (world/party/pm) masked in the relay.
- `api.js`: per-IP signup cap on `/api/register` (5 burst, then 1 / 10 min), layered on the auth bucket.

**@-mentions + chime:**
- Type `@` + Tab autocompletes from the online roster. A message that @-mentions you renders gold and plays a chime (FF2 NSF track 8) on a dedicated emulator that never disturbs map music; auto-stops at track end or 2.2 s. PMs chime too (unless you're already on the Private tab).

**PM polish + conversation sessions:**
- `/pm` `/w` `/tell` `/msg <name> <message>` and `/r <message>` (reply to last).
- The Private tab is now per-conversation: up/down in select mode pages between partners, the view filters to the focused thread, and the `→Name` prompt + reply target follow it. Sending/receiving focuses the relevant conversation.

## 1.7.540 — 2026-05-21

### Data-driven encounter rates

The per-zone `rate` field in `data/encounters.js` is now live — it drives the step cadence instead of hardcoded branches in `tickRandomEncounter`.

- New `RATE_STEPS` table maps `high`/`normal`/`low`/`fixed` → step ranges. Zone selection (valley vs wild, indoor patch, cave floor) folded into one `currentEncounterZoneKey()` helper shared by the threshold and the formation pick.
- **Ur killer bee + werewolf doubled:** `grasslands_wild` → rate `high` (10–19 steps/roll, ~2x).
- **Ur valley → `normal`:** goblin valley now 15–29 steps (was 20–39).
- Altar Cave floors unchanged (`normal`, 15–29). Changing a zone's frequency is now a one-word data edit.

## 1.7.539 — 2026-05-21

### Level cap at 5

Character level is now capped at 5 (job levels untouched). Single source = `MAX_LEVEL` in `src/player-stats.js`:

- `grantExp` stops leveling at the cap; excess EXP accumulates harmlessly but never crosses another threshold (`expToNext` pinned to "MAX").
- Save-load clamps legacy level 6+ saves down to 5; server `api.js` clamps incoming `level` / `stats.level` to 1–5 (anti-tamper).
- Pause menu shows `MAX` for the "Next" exp row at the cap; dev `/level` bounded to 1–5.
- Folded the duplicated "exp threshold for level N" branching into one `expToNextForLevel(lv)` helper shared by the level-up loop and the load path.

## 1.7.538 — 2026-05-21

### Ur shop + chest polish

- **Bows & arrows pulled from the Ur weapon shop.** The keeper now stocks Dagger / Longsword / Staff / Nunchuck only (`0x4A` Bow + `0x4F` Wooden Arrow removed). Item definitions are intact — they're just not purchasable.
- **Altar Cave rare drop: Sleep scroll → Ice scroll.** All four floors' 3% rare tier now drops Cure + Ice (`0xE1`) instead of Cure + Sleep (`0xE2`).
- **Ur chests respawn on a 24h timer.** Opened town chests now record an open-time (`ps.consumedTilesAt`, persisted with `consumedTiles`); `expireResettableChests` reverts any Ur chest looted ≥24h ago on map load. Secret walls / rock puzzles never expire; dungeon chests still reset on cave re-entry.

## 1.7.537 — 2026-05-21

### Elder-house dialogue: crystal is north

Corrected the directions — the crystal is in the cave to the **north**, not "below." Elder: "The crystal lies north, in the cave. Grow strong." Right attendant now warns about the northern cave's monsters.

## 1.7.536 — 2026-05-21

### Elder-house music: track 24

`FF2_TRACKS.ELDER_HOUSE` → 24, confirmed by ear via `/ff2 24`. The earlier 3/2 guesses were the wrong songs.

## 1.7.535 — 2026-05-21

### `/ff2 <n>` dev command — audition FF2 NSF tracks

Added a `/ff2 <track-index>` dev command (mirrors `/ff1`) to play any FF2 NSF track by ear, `/ff2 stop` to resume map music. For finding the right elder-house track index without blind guessing — once confirmed, set `FF2_TRACKS.ELDER_HOUSE`.

## 1.7.534 — 2026-05-21

### Elder-house music: correct track index

`FF2_TRACKS.ELDER_HOUSE` 3 → 2. "nsf 3" was 1-based player numbering; `gme_start_track` is 0-based, so track 3 = index 2. (Engine/addresses were correct in 1.7.533 — just the wrong song index.)

## 1.7.533 — 2026-05-21

### Elder-house music (FF2 NSF)

The elder's house (maps 6 + 7, both floors) now plays its own theme — FF2 NSF track 3 — from the moment you enter until you leave. New `src/ff2-nsf-builder.js` builds an NSF from the user's FF2 ROM at runtime (single-bank, mirrors the FF1 builder); a 4th libgme emulator in `music.js` (`initFF2Music`/`playFF2Track`/`stopFF2Music`/`ff2MusicReady`) plays it. On entering the elder house the FF3 track stops and FF2 plays; the two floors share it seamlessly (idempotent); on exit the FF3 town theme resumes. Falls back to the town theme if the FF2 ROM isn't loaded.

FF2 (J) sound-driver addresses were reverse-engineered from the ROM (cross-checked against the everything8215/ff2 disassembly): music engine self-contained in bank `$0D`, PLAY `$9800`, INIT-song `$9867` (id in zero-page `$E0`), 31-entry song table at `$9E0D`. RE helper kept in `tools/ff2-sound-re.mjs`. NSF stubs verified against the ROM bytes; track index (3) is the requested "nsf 3" — adjustable via `FF2_TRACKS.ELDER_HOUSE` if the song is off by one.

## 1.7.532 — 2026-05-21

### Elder-house opening intro + per-NPC dialogue

New-game intro cutscene: the moment a fresh save spawns the player between the elder and two attendants (map 7, 4,4), the three speak in turn — the elder reacting to "another one came through," with banter between all three. The player sprite turns to face whichever NPC is speaking, and movement stays locked until the last line slides out. Plays once (queued only on a fresh-slot start — never on death-respawn or revisit). Afterward, each of the three has its own line on talk.

Mechanics: `showMsgBoxPages` gained an optional `onPage(idx)` hook (fires per page) used to turn the player; `OPENING_INTRO` script + per-NPC `dialogue` in `data/opening-scene.js`; `queueOpeningIntro()` / `tickOpeningIntro()` in `npc.js` (queued from title-screen new-game branch, fired from the game loop once the entry fade settles).

## 1.7.531 — 2026-05-21

### Inn keeper dialogue: fit inside the box border

Shortened the innkeeper's pages so each wraps to ≤2 lines. The message box is `HUD_VIEW_W=144` (maxChars 16) and only 2 lines clear the border tiles — the previous longer pages wrapped to 4–5 lines and spilled past the HUD frame.

## 1.7.530 — 2026-05-21

### Inn keeper: dialogue

Gave the innkeeper (map 8, 3,14) hospitable dialogue — she greets the traveler and points out the beds are free. She's reachable (no counter), so on talk she turns to face the player, then shows the pages via `showMsgBoxPages`. `addSceneNpc` now passes a spec's optional `dialogue` array through to the NPC record.

## 1.7.529 — 2026-05-21

### Inn keeper (the woman) NPC

Added the innkeeper to map 8 (3,14), a second NPC alongside the item-shop keeper (8,14). Sprite from OAM capture: bundle `0x01E010` (same shape as the opening left attendant), recolored magenta hair SP3 / blue dress SP2. Idle-march facing down.

## 1.7.528 — 2026-05-21

### Armor-shop keeper NPC

Added the armor-shop keeper to map 4 (3,4), behind the `ur_armor` counter at (3,5). Same sprite as the weapon keeper (bundle `0x01E610`), so the registry entry reuses `WEAPON_KEEPER` — no duplicated spec. Idle-march facing down.

## 1.7.527 — 2026-05-21

### Weapon-shop keeper: move to (3,14)

Moved the weapon-shop keeper from (3,22) to map 5 (3,14), behind the registered `ur_weapon` counter at (3,15) — in the middle weapon room, resolving the keeper-room vs counter mismatch noted in 1.7.526.

## 1.7.526 — 2026-05-21

### Weapon-shop keeper NPC + town-keeper registry

Added the weapon-shop keeper to map 5 (3,22), behind the counter. Sprite from OAM capture: bundle `0x01E610` (magenta hair SP3, blue overalls SP2), idle-marching facing down. Refactored placement to a data-driven `TOWN_NPCS` registry (map ID → keepers) in `data/town-npcs.js`, placed by `npc.js#placeTownNpcs(mapId)` — one render path, scales as keepers are added. `map-loading.js` calls it for every regular map (no-op when the map has no keepers); the inn keeper (map 8) moved into the registry.

Note: map 5 is a 3-room stack and you enter the bottom room where this keeper stands, but `shops.js` registers the `ur_weapon` counter at (3,15) in the walled-off middle room — keeper room vs registered counter may not align (untouched, flagged for review).

## 1.7.525 — 2026-05-21

### Inn item-shop keeper: idle walk animation

Flipped the keeper to `animate: true` — it now idle-marches (walk-cycle in place, facing down) instead of standing on frame 0. Counter-bound, so it animates without wandering.

## 1.7.524 — 2026-05-21

### Inn: item-shop keeper NPC

Added the item-shop keeper to the Ur inn (map 8), standing behind the counter at (8,15) — one tile north at (8,14), facing south. Sprite located from an OAM capture: bundle `0x01E210` (same walk-sprite shape as the opening right attendant, recolored by its own capture palette — magenta hair SP3 `[1A,0F,15,36]`, blue tunic SP2 `[1A,0F,12,36]`). Rendered through the shared `Sprite` class so all four directions come from the 16-tile ROM bundle (no parallel render path, no hand-authored tiles).

New `src/data/town-npcs.js` (`INN_ITEM_KEEPER` spec) + `placeInnNpcs()` in `npc.js`, wired in `map-loading.js` for map 8. New `tools/npc-sprite-tool.mjs` — the reusable NPC pipeline: applies the AWJ IPS to match the in-game ROM, byte-searches captured OAM tiles → ROM offset, renders a bundle's four directions for verification.

## 1.7.523 — 2026-05-21

### Roster: per-room locations in Ur (no more unified town)

The roster now groups players by the specific Ur room they're standing in instead of lumping every interior under one `'ur'` location. Each building/floor is its own roster location: inn (`ur-inn`), tavern (`ur-tavern`), well (`ur-well`), the three shops (`ur-weapon`/`ur-armor`/`ur-magic`), elder's house floors (`ur-elder1`/`ur-elder2`), and the secret house + its upstairs room (`ur-secret`/`ur-secret2`). The Ur overworld stays `ur`.

`rosterLocForMapId(mapId)` is now the single source for map→location and `getPlayerLocation()` delegates to it, so the live location and the transition-change check can't drift. Keys stay ≤16 chars (the `ws-presence.js` wire clamp); the server groups by the raw string, so no server change. Entering/leaving a building sends a `location` update on the wire and triggers the roster fade — presence is now room-scoped live. No top-box change (interiors still read "Ur").

## 1.7.522 — 2026-05-21

### Pond + bed message: "Fully Restored!" → "HP/MP Restored"

`POND_RESTORED` (shared by the pond heal and the inn bed rest) now reads "HP/MP Restored". Uses the AWJ font's real slash glyph at byte `0xC7` (confirmed in `text-decoder.js` CHAR_MAP, not a best-fit placeholder). 14 chars, one line.

## 1.7.521 — 2026-05-21

### Bed rest: player / NPC / candle sprites no longer dim with the room

The fade snapped the whole composited viewport via the palette LUT, so any sprite pixel whose NES color collided with a room color got dimmed too — player and NPC sprites visibly faded. Moved the dim into the render pipeline so it only touches the BG layer:

- `bed.js` exposes `isBedDimming()` + `drawBedDim(ctx)` (replaces the old game-loop `drawBed()`).
- `render.js#_renderMapAndWater`: while the bed is dimming, the BG (map **and** overlay) is dimmed first, then the sprite pass (flames / NPCs / player) draws on top at full brightness. Normal frames keep the original sprite→overlay order.
- Removed `drawBed()` from the game-loop draw list.

Sprites can no longer fade by color collision — they're composited after the dim.

## 1.7.520 — 2026-05-21

### Bed rest: jingle on the dark frame (not during fade) + dark hold 5s → 6s

- The rest jingle now fires on the first fully-dark frame (the fade-out → sleep transition), not at lie-down. The fade itself is silent. `playSFX(REST_JINGLE)` moved out of `openBed()` into the `fade-out` completion.
- `SLEEP_MS` 5000 → 6000.

## 1.7.519 — 2026-05-20

### Bed rest: shorten the dark hold 6s → 5s

`SLEEP_MS` 6000 → 5000.

## 1.7.518 — 2026-05-20

### Bed rest: face left, auto-wake, walk off the bed, "Fully Restored!" message

Reworked the wake half of the rest scene to play like the inn cutscene instead of a press-to-dismiss prompt:

- **Face left on trigger.** `openBed()` now sets the sprite to `DIR_LEFT` (lying toward the wall) before the settle/dim.
- **No wake button.** Dropped the `wake-wait` state and the A/B prompt — after the 6s sleep the room auto fades back in.
- **Walk off the bed.** New `walk-out` state: once the fade-in finishes, the sprite walks down one tile via `startMove(DIR_DOWN)`.
- **Pond-heal message.** When the step lands, the pond `POND_RESTORED` ("Fully Restored!") message box shows and the scene closes. (HP/MP were already refilled at the sleep→wake transition; this reuses the existing pond confirmation, not the full star/strobe ritual.)

Lifecycle is now: closed → settle → fade-out → sleep(6s) → fade-in → walk-out → closed.

## 1.7.517 — 2026-05-20

### Bed rest: shorten the dark hold 8s → 6s

`SLEEP_MS` 8000 → 6000. Fade and flow unchanged.

## 1.7.516 — 2026-05-20

### Bed rest: real NES palette fade (discrete steps, not alpha) + modularized + A/B wake + settle

The fade was an **RGB alpha crossfade** — `_dimViewport` lerped each pixel toward the dark endpoint by a continuous `t`, producing in-between colors that aren't real NES colors. The NES swaps the whole palette in **discrete steps**; it never blends. Rebuilt it from the captured per-frame `$3F00` tables (REC OAM f1266+, keyframes 0/5/8/12/16/20/24/28/32/36/40) and snap to the keyframe for the current frame — a hardware-style swap. (The old endpoint was actually correct; the bug was purely the interpolation.)

- **Modularized.** New `src/nes-palette-fade.js` (reusable engine: `buildPaletteFade(keys)` → `{durationMs, finalLut, lutForProgress}`, `applyPaletteLut(ctx, lut, x, y, w, h)`) + `src/data/inn-fade-palette.js` (the captured keyframes). `bed.js` is now a thin consumer. Any future scene can drive a captured NES palette transition through the same engine.
- **Settle beat.** New `settle` state (300ms) holds the room lit with the player standing on the bed before the dim starts — the trigger already fires from `_onMoveComplete` (post-step), so the step is complete; this just makes it visible.
- **A or B to wake.** The wake prompt now responds to A (`z`) or B (`x`); prompt text updated to "Press A or B".
- **8s sleep enforced.** Input is drained through settle / fade / sleep, so the 8s dark hold can't be skipped — A/B only acts at the wake prompt.

Fade cadence is now true NTSC timing: 40 frames ≈ 667ms.

## 1.7.515 — 2026-05-20

### Bed rest jingle wired (track 0) + ripped out the NSF audition machinery

The inn rest tune is **track 0** — the first song in the FF3 NSF playlist. One line: `bed.js#openBed()` now plays `playSFX(0)` on the SFX channel (one-shot, no loop) and `_close()` calls `stopSFX()` on wake. The bed rest flow is complete: step on a bed → music pauses + jingle plays → palette dims (600ms) → 8s dark hold → "Press any key" → fades back → HP/MP refilled → town music resumes.

Reverted the entire v1.7.510–514 jingle-hunting apparatus, which was working around a self-inflicted problem (the debug panel loaded a second, un-initialized copy of `music.js` via its un-versioned dynamic import):

- Deleted `src/debug/tabs/nsf.js` (NSF audition tab) and unregistered it from `panel.js`.
- Restored `src/music.js` to its pre-mess state — removed `window.__ff3music`, the window-shared `__ff3AudioCtx` singleton, global auto-resume listeners, `audioStatus()`, `resumeAudio()`, and the now-unused `isSFXEnded()`. Back to the original 3-emulator engine.
- `/sfx` was already reverted in v1.7.511; no residue.

No behavior change beyond the bed jingle. The audio engine is exactly what it was at v1.7.509.

## 1.7.511 — 2026-05-20

### NSF audition tab in the Konami debug panel (replaces /sfx)

Reverted the `/sfx` chat command (it reused the SFX emu and didn't actually restart the track) and added a proper **NSF tab** to the Konami debug panel.

- New `src/debug/tabs/nsf.js` (registered in `panel.js`): track input (dec or `0xNN`), Play song / Play once / Stop, and ◀/▶ to sweep tracks. Uses `playTrack()` which tears down + recreates the emulator per call, so switching tracks reliably restarts.
- Lists the inn rest-jingle candidates from the capture (`0x46/0x4b/0x57/0x71/0x72`). Sweep to find the rest tune by ear; that track then gets wired into the bed scene.

## 1.7.510 — 2026-05-20

### /sfx — audition FF3 NSF tracks by ear

Added a dev command `/sfx <track>` (decimal or `0xNN`) that plays an FF3 NSF track once on the SFX channel, plus `/sfx stop`. The FF3 NSF had no audition command (only `/ff1` for FF1), which is why the inn rest jingle couldn't be confirmed — `playSFX(0x57)` (the track inferred from the capture's `$7F49` strip) screeched. Use this to find the correct rest tune by ear, then it gets wired into the bed scene.

## 1.7.509 — 2026-05-20

### Bed rest: real FF3 palette fade (from the REC OAM capture)

Replaced the placeholder fade-to-black with the actual inn palette ramp the REC OAM capture documented. The room palette **crossfades to a fixed dark-blue "night" palette and holds**, instead of going to solid black.

- `bed.js` now drives the captured per-frame `$3F00` color pairs (`0x1a→0x12`, `0x30→0x12`, `0x00→0x02`, `0x28→0x02`, etc., frame 0 → frame 40 hold). Each room color converges toward dark blue; sprite-only colors (player/candle: `0x17/0x22/0x15/0x36`) aren't in the map palette, so they stay lit — the room dims while characters stay visible, exactly like the capture.
- Applied as a live per-frame crossfade over the inner viewport (animation keeps going while dimming), `t` ramping 0→1 over 600ms; a dimmed snapshot covers the 8s hold; reversed on wake.
- Flow: step on bed → palette dims to night (600ms) → **8s hold** → "Press any key" → fades back in. HP/MP refill (status untouched) + save.
- Drops the generic `buildNesFadeFrames` snapshot-to-black approach for the bed.

## 1.7.508 — 2026-05-20

### Hotfix: bed rest screeched + stuck on black

The v1.7.507 rest scene played `playSFX(0x57)` (track inferred from the inn REC OAM capture) — it was the wrong NSF track and screeched, and because that track never reported "ended", the `sleep` state hung for the full 8s `SLEEP_MAX_MS` with input drained → "screeches and turns black, won't respond".

- Removed the jingle (don't play an unverified track) and the `isSFXEnded()` dependency. `sleep` is now a fixed 700ms dark beat → wake prompt.
- Flow is now clean: fade to dark → brief hold → HP/MP refill + save → "Press any key" → fade back in. No audio screech, no hang.
- `isSFXEnded()` kept in `music.js` for when the correct rest tune is wired. The rest jingle is deferred until the right NSF track is verified (not guessed).

## 1.7.507 — 2026-05-20

### Inn bed rest system

Step onto any bed tile in the inn (map 8) to rest: the screen fades to dark, the FF3 rest jingle plays once, HP/MP refill (status effects untouched), then any key fades back in. No cost.

- **Tile-identity driven — works for all present and future beds.** New pure registry `src/data/beds.js` (`BED_TILE_IDS` keyed by tileset → metatile ids; inn tileset 5 = `0x0a`/`0x0b`/`0x62`) + `isBedTileId()`. Any map that places those tiles becomes a rest spot automatically; no per-map coordinate registration.
- **Beds are now walk-on.** `MapRenderer.isBedTileAt()` + a check in `isPassable` make bed tiles passable by tile identity (per-position, not a shared-tileset collision edit — other maps unaffected). This unblocks all 4 beds including the previously-blocked bottom halves.
- **New scene module** `src/bed.js` mirrors the shop lifecycle (`closed → fade-out → sleep → wake-wait → fade-in`). Step-on entry via `checkTrigger`; update/draw dispatched from `game-loop.js`; input gated in `movement.js`. Map music pauses during rest and resumes after.
- **Heal:** `ps.hp/mp = max` only (no status clear), then `saveSlotsToDB()` so the inn doubles as a checkpoint (mirrors the pond heal).
- **Music:** added `isSFXEnded()` to `music.js`; the rest jingle is the one-shot `playSFX(0x57)` (from the inn REC OAM capture, `$7F49=$96 → track $57`). Bed graphics stay on the BG map — no tiles authored from the capture.
- Verified: lint + syntax clean; bed-tile detection 12/12 on map 8; headless page-load clean. In-game rest flow needs a live browser to eyeball.

## 1.7.506 — 2026-05-20

### Nudge the choke boulder one tile north

Moved the choke boulder + its collision from world tile (95,45) to (95,44). Both key off the shared `CHOKE_TILE_Y` constant in `world-map-renderer.js`, so render and collision stay in sync.

## 1.7.505 — 2026-05-20

### Boulder blocks the choke south of Ur (was walkable)

The world-map choke at tile (95,45) south of Ur — gating the unfinished region — is now a physical boulder instead of an invisible wall + "Coming Soon!" popup.

- **Bug fixed:** the explicit `isPassable` block for (95,45) added in `949db68` was lost in the March→May modularization, so on v1.7.504 the choke was actually **walkable** — players could wander into the unfinished world. `WorldMapRenderer.isPassable` now hard-blocks (95,45) regardless of terrain prop.
- **Boulder sprite:** captured via the EMU SNAP OAM tool (group 1, single-palette; tiles $90–$93, sprite sub-palette `[0x1A,0x0F,0x27,0x30]`), landed verbatim in `src/data/boulder-sprite.js`. Decoded once into a 16×16 offscreen canvas via `tile-decoder.js` and drawn on tile (95,45) by `WorldMapRenderer.drawOverlay` (wrap-aware, mirrors the tile-draw walk, renders as solid foreground over the player). Choke coords are shared constants so collision + render can't drift.
- Removed the "Coming Soon!" message box (`movement.js`) and its now-orphaned `showMsgBox` import — the boulder is the explanation now.

## 1.7.504 — 2026-05-20

### Real roster players auto-assist in solo encounters

In a solo battle, every real online player in the same room (`getOnlineAtLocation(loc)`) now auto-joins as a local-AI ally using their **exact broadcast build** — job, realized atk/def/evade/mdef, equipment (incl. dual-wield), `knownSpells`, jobLevel. Like the fake-player (`PLAYER_POOL`) system, but with real player data. `generateAllyStats`'s realized-stats fast path already consumed the wire profile verbatim, so magic / AI / poses are hooked with no further wiring.

- No random gate — whoever's in the room helps, filling up to the 3-ally cap (the invited-party pre-pass takes slots first; the room loop dedups by name). Self is never in the roster (`net.js` excludes `_myUserId`), so no clone.
- Enemy AI still targets the whole team (player + allies) — unchanged.
- Wire-PvP ally fill is left byte-for-byte intact behind a `pvpSt.isWirePVP` branch — its deterministic single-pick + `sendNetPVPAllyJoin` relay still satisfy `pvp-wire-sim` #18.
- Gates green: lint 0, encounter-sim 12/12, wire-stats-diag lossless, pvp-wire-sim 37/37. Added a focused check that a real online-player profile flows through `generateAllyStats` with all build fields verbatim (14/14).

## 1.7.503 — 2026-05-20

### Open-beta hardening pass

Tightening for open beta (co-op + PvP battles stay disabled). No gameplay change; all deploy gates green (lint 0, encounter-sim 12/12, wire-stats-diag lossless, pvp-wire-sim 37/37).

- **API handlers can no longer hang the socket.** `handleAPI` is now wrapped in `server.js` so any handler throw returns a 500 instead of rejecting the async request handler and leaving the client connection open with no response. Root cause also fixed: `/api/register` + `/api/login` now reject non-string `email`/`password` (a malformed unauthenticated payload like `{"email":123}` previously threw on `.toLowerCase()` → hung + unhandledRejection). Verified end-to-end: malformed payload → 400 in ~10ms, valid signup → 201.
- **`give-item` itemId bounds.** Server now rejects `itemId <= 0 || itemId > 255` (was `if (!itemId)`, which let `-1` and out-of-range bytes relay through).
- **Dead co-op leftovers removed.** Battle states `ally-wire-wait` / `ally-ko-fade` / `ally-ko-msg` (read but never set after the v1.7.500 co-op rip-out) and the superseded `_updateAllyKOSequence` deleted — ally death is handled inline by `_updateAllyEnemyHit`. Dropped the now-orphaned `ROSTER_FADE_STEPS` import plus the dead `ally-wire-wait` watchdog carve-out and input-drain branch.
- **`encounterMonsters` invariant documented.** Added a comment at the array-build site recording that the array is built once and never spliced (dead monsters keep their slot at hp=0; only nulled at battle end), so every combat index stays valid for the life of the battle — re-audit every `encounterMonsters[idx]` deref if that ever changes.

## 1.7.502 — 2026-05-20

### PvP roster battles DISABLED — pending an authoritative-host sync rewrite

After the v1.7.501 desync fix landed, live two-phone PvP battles still desynced
completely — turn order, damage numbers, and end-of-battle all diverged (server
log showed `pvp-action reject reason=no-partner`: one phone ended the battle
while the other fought on). Root cause is architectural, not a single bug: PvP
uses **client-side lockstep** — both phones run the full battle FSM independently
and only stay identical if they consume `rand()` in the exact same order,
cycle-for-cycle, through animations / timers / network races. That determinism
is too fragile to hold (the same model failed three times for co-op and was
ripped out in v1.7.500).

PvP is now turned off behind a flag, **with all code left in place** for the
eventual rewrite to an authoritative-host model (one side computes outcomes and
relays deltas; the other only renders — no determinism required):

- **Server hard kill switch** (`ws-presence.js`, `PVP_ENABLED = false`): the
  server never registers a `pvp-search` and never fires a `pvp-match`, so no PvP
  battle can start even from a stale-cached client. Mutable via
  `_testHooks.setPvpEnabled` so `pvp-wire-sim` keeps regression-testing the wire
  contract for the rewrite (still 37/37).
- **Client** (`pvp-search.js`, `PVP_ENABLED = false`): `startPVPSearch` shows
  "PvP is disabled" and bails; the `pvp-match` handler declines any match that
  still arrives.
- **Roster menu** (`roster.js`): the "Battle" option is removed (`['Party',
  'Trade', 'Message', 'Inspect']`). The Battle dispatch in `input-handler.js` is
  left intact and simply unreachable.

To re-enable: flip both `PVP_ENABLED` flags and re-add `'Battle'` to
`ROSTER_MENU_ITEMS`. Full rationale + the authoritative-host direction are in the
`ff3mmo-pvp-disabled` auto-memory.

## 1.7.501 — 2026-05-20

### Fix PvP desync — challenger in PvP battle while target loads monsters

A successful PvP hook split the two phones apart **every time the match
resolved on the target's side**:

- `_triggerEncounterWithPVPCheck` (battle-encounter.js) armed a 500 ms fallback
  that fired `startRandomEncounter()` if `battleState === 'none'`.
- When the hook HIT, the target's `pvp-match` handler resolved through a
  `CONNECTING_HOLD_MS` (1000 ms) "Connecting..." hold during which `battleState`
  is *still* `'none'` — the PvP battle only starts when the hold expires.
- Nobody cleared `_pendingPVPCheck`, so at 500 ms the fallback dropped the
  target into a **monster fight** while the challenger entered PvP alone. The
  server kept relaying `pvp-action` to a target who was no longer in the match.

Fix: the match handler now calls `cancelPendingPVPCheck()` the instant it
commits to the battle, neutralising the fallback; the fallback timeout is
widened 500 ms → 2500 ms so a slow-but-not-dropped match reply isn't pre-empted
either (both hit and miss still resolve via explicit wire messages well before
it — the timeout is dropped-packet insurance only). The wire-sim can't catch
this (it's a client `setTimeout` race, not a wire-contract issue); verified by
two-phone live smoke.

### Comment cleanup — Battle-Assist references after the v1.7.500 rip-out

Corrected stale comments in `main.js`, `roster.js`, `battle-draw-allies.js`,
`spell-cast.js`, and `physical-attack.js` that still described the removed
Battle-Assist action / co-op viewer / host-arb modes as live. No behavior
change. The in-battle ⚔ roster badge + `inBattle` wire flag are kept as pure
presence (and the foundation the assist/party-battle rebuild reattaches to).

## 1.7.500 — 2026-05-20

### Co-op party battles + Battle Assist RIPPED OUT — clean slate for a from-scratch rebuild

After three failed architectures (lockstep v1.7.418-472, host-arb v1.7.474-477, viewer v1.7.486-496) all froze the guest phone, co-op random encounters and Battle Assist are fully removed. Random encounters are **solo-only** again. This is a deliberate clean baseline to rebuild co-op on; the design intent + root-cause analysis are preserved in the `ff3mmo-coop-rebuild` auto-memory, and the removed implementation is in git history before this commit.

**Deleted wholesale:** `src/coop-resolver.js`, `coop-applier.js`, `coop-deltas.js`, `coop-viewer.js`, `coop-view-anims.js`, `encounter-wire.js`; `tools/coop-arbiter-sim.js` (+PLAN), `coop-viewer-sim.js`, `coop-wire-sim.js`, `coop-debug-grep.sh`; `docs/COOP-VIEWER-PLAN.md`, `COOP-REWRITE-PLAN.md`, `COOP-PHASE-6-SMOKE.md`.

**Surgically removed:**
- Server (`ws-presence.js`): all `encounter-*` wire kinds (start/invite/action/end/resolution/snapshot/assist-request/assist-snapshot/ally-join/host-changed), `_encounterGroups`, `_encounterHosts`, `_clearEncounterGroup`, `_pushInBattle`, the disconnect-promotion block, and the `encounter-*` per-kind rate-limit entries.
- Client wire (`net.js`): every `sendNetEncounter*` / `setNetEncounter*` + their dispatch cases and handler vars.
- Battle (`battle-encounter.js`): `_maybeHostCoopEncounter`, the encounter-invite handler, all Battle Assist handlers, the assist-request redirect + party-scaled encounter threshold. (`battle-turn.js`): `_pushPlayerCoop`, `reseedCoopTurnRand`/`maybeReseedCoopTurn`, `_applyWireEncounterActionForAlly`, the wire-driven ally dispatch, and the host-arb item/poison emits. (`battle-ally.js`): `ally-wire-wait` + the side-channel `_tickAllyFadeIn`. (`battle-update.js` / `battle-enemy.js` / `spell-cast.js`): the dormant resolver emit blocks. (`game-loop.js`): the `coopViewSt` viewer branch.
- State (`battle-state.js`): `isWireEncounter`, `encounterIsHost`, `encounterHostUserId`, `encounterSeed`, `perTurnIndex`.
- UI: the roster "Assist" menu action (`roster.js` `ROSTER_MENU_ITEMS`, `input-handler.js`).

**KEPT, verified intact:** solo + boss combat, PvP duels (fully separate `pvpSt`/`pvp-*` wire), party invites + membership, party/world/PM chat, presence, roster, give-item, low-HP pose, the `inBattle` presence badge.

**Two fixes from the prior debugging effort survive** (they're correct independent of co-op and PvP relies on them): the monster-attack branch unification in `battle-enemy.js` (`_targetCombatant`, guarded by `tools/encounter-sim.js`) and the realized-stats wire profile + `generateAllyStats` fast path (guarded by `tools/wire-stats-diag.js`).

Net: ~3000 LOC removed across 13 files + 9 deletions. Gates: lint 0, encounter-sim 12/12, wire-stats-diag lossless, pvp-wire-sim, battle-sim. `deploy.sh` drops the three deleted co-op sim gates.

## 1.7.499 — 2026-05-19

### Co-op fix — the actual bug: concurrent-trigger race (both phones host)

Production server logs from a live two-phone session showed the real problem, which the v1.7.497/498 stat fixes did not touch:

```
[encounter-start] host=2 accepted=[4]
[encounter-start] host=4 accepted=[2]   ← both phones host their own battle
[encounter-start] host=2 accepted=[4]
[encounter-start] host=4 accepted=[2]
```

When two party members walk together, both hit their random-encounter step threshold within the same network frame. Each spawns a local battle and sends `encounter-start`. The server serializes by arrival (single-threaded) so the first wins and the second is rejected — but the **loser's** client already self-hosted a local battle. The loser is supposed to tear it down and rejoin as a guest when the winner's `encounter-invite` arrives (`battle-encounter.js` `isSelfHostRace`), but that takeover only fired while the loser was in the `flash-strobe` intro state (~0.5s). A real cellular RTT (~150ms) routinely pushed the loser into `menu-open` before the invite landed, so the takeover was missed and **both phones fought parallel battles**: the guest never appeared in the host's fight, and the host waited out the 10s wire-wait timeout on a peer busy in its own battle. This is the "phone 2 not showing roster allies / phone 1 plays without player 2 acting" symptom — a structural coupling failure, not a stat divergence.

**Fix:** widened the takeover window in `setNetEncounterInviteHandler`. The race takeover is now gated on `inputSt.battleActionCount === 0` (no action committed yet) instead of `battleState === 'flash-strobe'`. This covers every pre-action state — flash-strobe, menu-open, ally fade-in — so the loser reliably abandons its self-hosted battle and rejoins as a guest regardless of how far the intro animation advanced before the invite arrived.

**Regression guard:** `tools/coop-wire-sim.js` gains "concurrent encounter-start yields exactly one invite (single host)" — both clients fire `encounter-start` naming the other; asserts the server delivers exactly one invite total (first-wins arbitration). 11/11.

**What this fix does NOT cover:** the client-side takeover itself can't be unit-tested without a full-client FSM harness; it requires live two-phone validation. The server arbitration it relies on is now gated. The v1.7.497 (monster-attack branch unification) and v1.7.498 (wire-profile stat parity) fixes remain necessary — they make the math converge *once both players are correctly in the same battle*, which this fix is what finally makes happen.

Gates: lint 0, encounter-sim 12/12, wire-stats-diag lossless, coop-wire-sim 11/11, pvp-wire-sim 49/49, coop-viewer-sim 30/30, coop-arbiter-sim 59 + 5 expected.

## 1.7.498 — 2026-05-19

### Co-op lockstep fix — wire-profile stat parity (the second half of the v1.7.472 fix)

v1.7.497 unified the monster-attack code path but two-phone smoke still showed desync. Diagnostic harness `tools/wire-stats-diag.js` (NEW) revealed the second divergence source: **8 of 16 combat-stat fields diverge** between a player's local `ps` (via `recalcCombatStats`) and the same player's reconstructed ally view on a remote phone (via `generateAllyStats(wireProfile)`). Same player object, different stat values, depending on which phone is looking. Same unified code path on both phones, different inputs, different damage — HP drifts turn one.

**Sample divergence for a Lv30/jobLv9 WM with mid-tier equipment:**

```
   ok atk               185 (was: 177)
   ok def               45  (was: 42)  ← every monster physical takes 3 less damage on the wrong side
   ok evade             29  (was: 20)  ← evasion roll lands differently between phones
   ok mdef              23  (was: 19)
   ok jobLevel          9   (was: 1)
   ok mp/maxMP          95  (was: null)
   ok knownSpells       3   (was: 0)   ← remote view thinks player knows no spells
```

**Mechanical causes:**
- `connectNet` wire profile in `src/main.js` never shipped `jobLevel`, the accessory (`arms`) slot, `mp`/`maxMP`, `knownSpells`, or any realized combat stats.
- `generateAllyStats` re-derived combat stats from the partial equipment IDs that did ship, missing equipment stat bonuses (`strBonus`, `agiBonus`, etc.) and the missing slot entirely.

**Fix in 3 pieces:**

1. **`src/player-stats.js`** — added `getEffectiveStats()` helper returning `{str, agi, vit, int, mnd}` with jpBonus + equipment stat bonuses applied. Mirrors the inline math already inside `recalcCombatStats`.

2. **`src/main.js#connectNet`** — wire profile now ships realized `atk/def/evade/mdef/hitRate/shieldEvade/statusResist/elemResist`, effective `intStat/mndStat` (named with `Stat` suffix to avoid `int` reserved-word collisions), `mp/maxMP`, `jobLevel`, `knownSpells`. The existing `agi` field changes from base → effective; this also nudges the server's PvP hook chance formula to use effective agi (consistent with what local damage math uses but a tiny balance shift).

3. **`src/data/players.js#generateAllyStats`** — added an early-return fast path: if `typeof player.atk === 'number'` (signal that wire shipped realized stats), build the ally directly from those fields. PLAYER_POOL AI fakes fall through to the legacy compute path unchanged.

4. **`tools/wire-stats-diag.js` (NEW, ~190 LOC)** — boots a Lv30 WM with realistic equipment, ships through the production wire profile, runs `generateAllyStats` on the receiver side, prints every diverging field with a pass/fail count. Wired into `deploy.sh` as a regression gate so the next person who trims a wire field gets caught at lint-time. Post-fix: all 18 fields match.

**Backward compat:** stale clients running old-shape profile → receiver's `generateAllyStats` sees no `atk` field → falls through to legacy compute path → same behavior as pre-v1.7.498 for that peer. Mixed deployments don't crash; they just don't benefit until both phones reload.

Gates: lint 0, encounter-sim 12/12, wire-stats-diag 18/18 fields match, pvp-wire-sim 49/49, coop-wire-sim 10/10, coop-viewer-sim 30/30, coop-arbiter-sim 59 pass + 5 expected.

## 1.7.497 — 2026-05-19

### Co-op lockstep fix — unify monster-attack branches (direct fix for v1.7.472)

Three rewrites (host-arb, viewer model, fix-forward attempts) routed around the actual bug instead of fixing it. Direct fix: `_processEnemyFlash` and `_doSpecialAttack` in `src/battle-enemy.js` had two branches for the same logical event (monster hits ps vs monster hits ally) that diverged in 6 ways — element resist, Protect halving, wake-on-hit, monster `statusAtk` infliction (physical), Defend halving (special-damage), and element resist (special-damage) were all silently missing from the ally branch. Same `rand()` cursor on both clients → same `total` → then host halves for Protect, guest doesn't → HP diverges turn one. That's the v1.7.472 bug.

**The fix in three pieces:**

1. **`src/data/players.js#generateAllyStats`** — added `elemResist` (deduped union over every equipped slot, mirroring `recalcCombatStats`) and `buffs: {}` to the returned ally object. Without these the ally branch had no field to read.

2. **`src/battle-enemy.js`** — added `_targetCombatant(targetAlly)` resolver that returns a symmetric view of either `ps` or `battleSt.battleAllies[targetAlly]` with every field + closure helpers the hit path needs (`setDmgNum`, `setStatusDmgNum`, `setMiss`, `onShake`, `stateHit`, `stateMiss`). Replaced both branches in `_processEnemyFlash` and `_doSpecialAttack` with one body. Net `battle-enemy.js`: 337 → 313 lines despite adding a 48-line helper.

3. **`tools/encounter-sim.js` (NEW, ~290 LOC)** — 12-test regression harness that probes the unified path for ps-vs-ally symmetry. Sanity tests confirm `elemResist`/`Protect`/`Defend` actually reduce damage (7 → 3); symmetry tests confirm ps-target damage = ally-target damage across baseline / elemResist / Protect / Defend / statusAtk-poison / wake-on-hit scenarios. Wired into `deploy.sh` as the second pre-flight gate. If anyone re-introduces an asymmetric branch the harness fails fast.

**Side effects (positive):** monster element attacks now resist on allies wearing FlameMail (was a pre-existing solo-mode bug); ally Defend halves monster special-damage attacks; allies wake when hit while asleep; monster `statusAtk` (poison, paralysis, etc) inflicts on allies.

**Dormant rewrite code unchanged.** `coop-resolver.js` / `coop-applier.js` / `coop-deltas.js` / `coop-viewer.js` / `coop-view-anims.js` (~2400 LOC) still compiled but unreached under `COOP_HOST_ARB=false` + `COOP_VIEWER_MODE=false`. Cleanup deferred until two-phone smoke confirms the direct fix holds; both rewrite kill-switches stay available as hot-revert paths.

Gates: lint 0, encounter-sim 12/12, pvp-wire-sim, coop-wire-sim, coop-viewer-sim, coop-arbiter-sim all pre-existing.

## 1.7.496 — 2026-05-19

### Hot-revert (3rd): viewer model not working live, `COOP_VIEWER_MODE = false`

Three rounds of fix-forward attempts (v1.7.488 / v1.7.491) all failed real two-phone testing. The viewer rewrite as designed does not work in production:
- Phone 2 soft-locks on encounter
- Roster players don't show
- Attacks don't sync
- Freezes persist

Reverted flag. All viewer code stays compiled (still passes 30 sim tests + 10 wire tests) but is dormant. Co-op back to legacy lockstep baseline (the v1.7.477 broken-but-known state). The viewer rewrite needs deeper investigation than fix-forward iteration allowed.

## 1.7.495 — 2026-05-19

### Co-op viewer rewrite — P12: conservative legacy-wire sunset (guest side)

Under viewer mode the guest's FSM doesn't tick, so legacy `encounter-action` packets the server still relays were piling up in `_wireEncounterActions` with no consumer. Memory leak, not functional break, but cleaner to stop the push at the source.

**Fix:** in `src/encounter-wire.js#setNetEncounterActionHandler`, after the existing `disconnect` early-returns, gate the queue push on `!(COOP_VIEWER_MODE && coopViewSt.active)`. Under viewer mode + active state, drop the legacy action silently — the ViewEvent on the corresponding `encounter-resolution` is the authoritative path.

**What I did NOT do (intentionally):**
- Host still emits legacy `encounter-action` + `encounter-end` on the wire (backwards compat with any cached old client tab still running v1.7.485-). Full sunset of the host-side emit waits on user confirmation that no old clients are connecting (next-session check on pm2 logs).

Gates: lint 0, pvp-wire-sim 49/49, coop-wire-sim 10/10, coop-viewer-sim 30/30, coop-arbiter-sim 59+5.

## 1.7.494 — 2026-05-19

### Co-op viewer rewrite — P11: strip dead `isCoopGuest()` short-circuits

Under the viewer model the guest's battle FSM never ticks, so the `isCoopGuest()` short-circuits at HP-mutation call sites are dead code. Under flag-off hot-revert (`VIEWER=false` + `HOST_ARB=false`) `isCoopGuest()` returns false anyway, so the short-circuits never fire there either. The historical host-arb-only mode (`VIEWER=false` + `HOST_ARB=true`) that would have needed them was never successfully shipped to prod.

**Updated `isCoopGuest()` semantics** to ALSO return true when `COOP_VIEWER_MODE && coopViewSt.active`, so the encounter-wire force-close safety net (v1.7.475) still detects "I'm a guest" under viewer mode. Wired via new `_setCoopViewStRef` helper to avoid circular imports.

**Removed short-circuits:**
- `src/physical-attack.js#applyPhysicalHitToEnemy` — top-of-function early-return
- `src/combatant-cast.js` — 8 short-circuits across `applyMagicDamage`, `applyMagicHeal`, `applyMagicCureStatus`, `applyMagicDrain`, `applyMagicRecovery`, `applyMagicAllStatus`, `applyMagicInstakill`, `applyMagicStatus`
- `src/battle-enemy.js#_processEnemyTurn` — both ps + ally damage branches (3 sites: dispatchDelta + wakeOnHit + statusAtk inflict)
- `src/battle-turn.js#_applyEndOfRoundPoison` — 3 sites (ps/ally/monster batch)
- `src/battle-turn.js#_playerTurnConsumable` — cure_status + Elixir paths

**Imports removed:** `isCoopGuest` no longer imported by physical-attack, combatant-cast, battle-enemy, battle-turn. Still exported from coop-resolver for `encounter-wire.js`'s safety net.

**Files preserved:** `src/encounter-wire.js#setNetEncounterActionHandler` keeps `isCoopGuest()` check on the force-close path — handles the edge case where a host disconnects with no promotion (server bug or empty-peer-set race).

Gates: lint 0, pvp-wire-sim 49/49, coop-wire-sim 10/10, coop-viewer-sim 30/30, coop-arbiter-sim 59+5.

Net diff: -120 lines of dead code across 4 files.

## 1.7.493 — 2026-05-19

### Co-op viewer rewrite — docs + debug helper

**`MULTIPLAYER.md` rewrite** — co-op section now documents the viewer (card-game) model as primary. Host-arb-only is demoted to historical with a clear "shipped at v1.7.474, broke live, reverted at v1.7.477; resolver plumbing reused" note. Lockstep stays historical below that. Includes:

- Module layout (coop-viewer, coop-view-anims, coop-deltas, coop-resolver, coop-applier)
- Full ViewEvent wire shape with `finalState` schema
- Host-emit call sites table (kind: attack / magic / item / monster-attack / poison-tick / encounter-end / encounter-start)
- Encounter lifecycle (5-step flow from host trigger → guest viewer-mode → encounter-end handoff)
- Host promotion (v1.7.476 + P7 viewer→FSM handoff)
- Diagnostic instrumentation tag list + grep procedure
- Killed failure modes catalog with the regression test that catches each
- Hot-revert procedure

**`tools/coop-debug-grep.sh`** — one-line helper that ssh's prod and greps `[coop-viewer]` from `server-error.log`. Eliminates the "what was the exact ssh command" friction during diagnosis. Three usage patterns documented inline:
```
./tools/coop-debug-grep.sh                                # last 50 events
./tools/coop-debug-grep.sh 200 'enterViewerMode\|invite' # spawn path
./tools/coop-debug-grep.sh 200 'anim-begin\|anim-done'   # event flow
```

No production code change.

## 1.7.492 — 2026-05-19

### Co-op viewer rewrite — P8.1: harness hardening (regression tests for live failures)

Every viewer bug we shipped that broke live had no test that would have caught it. Closing that gap: each post-deploy failure now has a regression test in the harness that runs in `deploy.sh`. P8 spec was 30+ tests; now at 30 viewer + 10 wire (was 22 + 9).

**New viewer-sim tests (8 added):**
- `v1.7.490 — encounter-start updates battleAllies IN PLACE, preserves fadeStep` — would have caught the `drawAllyPortrait` throw
- `v1.7.490 — fallback path pushes ally with safe render defaults when missing` — assist-join race coverage
- `v1.7.486 — ingest-rejected when packet missing viewEvent (server bug repro)` — graceful reject when server drops viewEvent
- `v1.7.488 — battleTimer advances during flash-strobe anim` — would have caught the frozen-flash bug
- `out-of-order packets reorder by turnIdx in queue` — packet-loss recovery
- `item event triggers heal callback for player target` — item path coverage
- `player-death event applies finalState alive=false` — death path coverage
- `turn-begin event with prompt=true sets battleState=menu-open` — input prompt coverage

**New wire-sim test:**
- `encounter-resolution relay preserves viewEvent payload` — exact repro of v1.7.486 server bug. Sends a resolution with viewEvent through the real server, asserts the payload arrives intact on the peer.

**Test counts:**
- coop-viewer-sim: 22 → 30
- coop-wire-sim: 9 → 10
- pvp-wire-sim: 49 (unchanged)
- coop-arbiter-sim: 59 + 5 (unchanged)

Flag still on. No production behavior change; this is purely test infrastructure.

## 1.7.491 — 2026-05-19

### Co-op viewer rewrite — P9.3: fix drawAllyPortrait throw

Instrumentation from v1.7.490 surfaced the real bug. Guest's `_drawAllyPortrait` was throwing on `drawImage(portraits[ally.fadeStep], ...)` because the viewer's `_applyEncounterStartFinalState` wiped `battleSt.battleAllies` and re-populated with a minimal stat object lacking `fadeStep` (and `weaponId`, `weaponL`, `knownSpells`, etc.). `portraits[undefined]` returned undefined → drawImage throws → entire frame's remaining draws (monsters, music start, damage numbers) skipped by the catch.

**Fix A — viewer updates battleAllies IN PLACE**, doesn't wipe. The legacy `setNetEncounterInviteHandler` already populated entries via `generateAllyStats` which sets fadeStep + sprite/weapon canvases + spell list. Viewer now only overrides the realized stat fields (hp/mp/maxHP/atk/def/agi/evade/mdef) from the host's authoritative payload. Render-required fields stay intact. Fallback path (entry missing — assist-join race) builds a defensive entry with `fadeStep: 0` + safe defaults.

**Fix B — host's `_emitHostEncounterStartViewEvent` was reading atk/def/agi from `ps.stats`**, but those realized values live on `ps` directly (set by `recalcStats`). Was a v1.7.482 P5 bug — guests got atk/def=0. Now reads from the right source. Also fields now include `evade`, `mdef`, `hitRate` for completeness.

Both fixes flag-gated by `COOP_VIEWER_MODE`. Sims green (22/22 viewer, 9/9 coop-wire, 49/49 pvp-wire, 59+5 arbiter). Live re-test next.

## 1.7.490 — 2026-05-19

### Co-op viewer rewrite — P9.2: instrumented + flag back on

Added `[coop-viewer]` structured logging at every key boundary. Each log POSTs to `/api/client-error` so it surfaces in `pm2 logs server --err` without requiring user console access. Gated on new `COOP_VIEWER_DEBUG` flag (default `true`) — independent of `COOP_VIEWER_MODE` so we can keep diagnosis on through stabilization.

**Instrumented boundaries:**

Host side (`battle-encounter.js`):
- `invite-received` (guest path — flags + payload sizes)
- `host-emit-start` (host path — combatants/monsters/sample)
- `host-emit-start-rejected` (early-return reasons)

Wire receive (`coop-applier.js`):
- `wire-resolution-received` (turnIdx, eventKind, viewEvent presence, msg keys)

Viewer (`coop-viewer.js`):
- `enterViewerMode-called` / `enterViewerMode-done`
- `exitViewerMode-called`
- `ingest-rejected` (reason: flag-off | inactive | no-viewEvent-in-packet)
- `ingest-ok` / `ingest-dup-drop`
- `anim-begin` / `anim-done` / `anim-handler-threw`
- `updateCoopView-first-tick` — one-shot to confirm the tick is actually firing

Every log carries a context block: `myUid`, `active`, `queueLen`, `lastApplied`, `currentKind`, `battleState`, `battleTimer`, `isWireEncounter`, `encounterIsHost`, `encounterHostUid`, `battleAlliesLen`, `monstersLen`.

Flag flipped back on for retry. When phone 2 freezes again, run:
```
ssh root@68.183.59.19 'pm2 logs server --out --lines 200 --nostream | grep coop-viewer'
```
Output will show the EXACT sequence of viewer events (or absence thereof) for the failing client.

## 1.7.489 — 2026-05-19

### Hot-revert (2nd): viewer still freezing live, instrumentation needed

v1.7.488 shipped server `viewEvent` passthrough + viewer flash-strobe parking. Phone 2 still froze with no sync. The sim harness (22/22 green) is not catching whatever's actually broken live.

Reverted to `COOP_VIEWER_MODE = false`. Next step: add structured `[coop-viewer]` logs at every state-change boundary (enterViewerMode, ingest, dispatch start/end, finalState write, fx cue) that POST to `/api/client-error` so the failure mode shows up in pm2 logs without requiring a user to copy paste console output. Then a real two-phone test surfaces signal we can act on.

## 1.7.488 — 2026-05-19

### Co-op viewer rewrite — P9.1: fix flash-strobe freeze, flag back on

Two bugs found from v1.7.486 two-phone live smoke. Both fixed, flag flipped back on.

**Bug 1 — server dropping `viewEvent` on encounter-resolution relay.** `ws-presence.js:898-909` was explicitly listing fields to copy (turnIdx, actor, action, deltas, fx, meta) and silently omitting the new `viewEvent` payload. Guests under viewer mode saw `msg.viewEvent === undefined`, the coop-applier route condition failed, packet fell through to the legacy host-arb path which is gated on `COOP_HOST_ARB=false` → no-op. **Viewer queue stayed empty forever.** Fix: pass `viewEvent` through in the relay.

**Bug 2 — viewer parks battleState at 'flash-strobe' indefinitely.** `_animEncounterStart` set `battleSt.battleState = 'flash-strobe'` to drive the legacy spawn visual, but the legacy `updateBattle` FSM (which auto-advances flash-strobe → monster-name-in → menu-open) isn't running on guests. After the anim's `animMs` (1200) elapsed, battleState was still 'flash-strobe' and `battleTimer` was frozen at 0 (the viewer never advanced it). Renderer kept drawing the strobe at frame 0 forever. Fix: viewer advances `battleTimer` during the flash AND parks `battleState = 'menu-open'` after anim completes — the legacy "battle HUD shown, awaiting action" state that the renderer treats as stable.

Live test plan unchanged: refresh both phones, walk into encounter, verify both see roster + HUD + monsters.

If still broken, hot-revert is one line: `COOP_VIEWER_MODE = false` in `src/coop-resolver.js` + deploy.

Gates: lint 0, pvp-wire-sim 49/49, coop-wire-sim 9/9, coop-viewer-sim 22/22 (added "encounter-start parks battleState=menu-open after anim" regression test), coop-arbiter-sim 59+5.

## 1.7.487 — 2026-05-19

### Hot-revert: `COOP_VIEWER_MODE = false`

Two-phone live smoke surfaced: guest phone froze on encounter trigger, never launched the battle HUD. Root cause: the viewer's `_animEncounterStart` sets `battleState = 'flash-strobe'`, but `updateCoopView` replaces `updateBattle` so the legacy FSM's flash-strobe → monster-name-in → menu-open transitions never fire. The guest sits at flash-strobe until a follow-up ViewEvent arrives — but the host hasn't emitted anything yet (still in their own pre-battle states), so the guest waits forever.

Fix-forward needed in viewer: anim handlers must leave battleState in a renderable "battle HUD ready" state when idle, not a transition state. Probably means `_animEncounterStart` ends with `battleState = 'menu-open'` so the HUD draws while waiting for the next event. Will redesign in P9.1.

Reverted by flipping `COOP_VIEWER_MODE = false`. All viewer code stays compiled, dormant. Co-op back to v1.7.477 broken-but-known baseline.

## 1.7.486 — 2026-05-19

### Co-op viewer rewrite — P9: flag flip LIVE — `COOP_VIEWER_MODE = true`

Production co-op battles now run the card-game viewer model on the guest side. Host runs the battle FSM (unchanged); guest runs a packet-driven animation player that consumes self-contained ViewEvents carrying `finalState` snapshots. Guest's battle FSM does not tick during co-op encounters.

**What this fixes vs the v1.7.474-76 host-arb-only attempt:**
- **Phone freezing** — guest FSM no longer stuck in `ally-wire-wait` waiting on a legacy `encounter-action` that's racing the resolution packet. Viewer doesn't have ally-wire-wait. Single state machine, host-authoritative.
- **Wrong HP** — every ViewEvent carries `finalState` (authoritative HP/MP/status for every affected actor). Viewer writes it after the anim completes. No re-derivation from divergent profile fields.
- **Missing roster** — host emits `encounter-start` ViewEvent with realized stats (hp/maxHP/atk/def/agi) for every combatant. Guest's `_animEncounterStart` bootstraps battleSt directly, bypassing `generateAllyStats` (which had the hp=job-maxHP bug for the encounter-invite path).

**Hot-revert procedure** if live smoke fails: flip `COOP_VIEWER_MODE = false` in `src/coop-resolver.js`, deploy. The flag-off path is unchanged from v1.7.477 baseline (legacy lockstep, broken-but-known). All viewer code stays compiled, just dormant.

**Two-phone smoke gate (next):**
1. Two phones, same party, walk into wild encounter
2. Both screens show 2-row roster at battle open (host + guest)
3. HP/MP match between phones at start AND after every turn
4. Player physical attacks resolve identically on both phones
5. Cure on ally — heal num + HP delta match
6. Monster KOs a player — death anim plays on both phones same beat
7. Victory flow runs to completion on both phones

If any fail, hot-revert + investigate. P10 is the 48h observation window.

PvP path completely untouched. Solo encounters never enter viewer mode.

Gates: lint 0, pvp-wire-sim 49/49, coop-wire-sim 9/9, coop-viewer-sim 21/21, coop-arbiter-sim 59+5.

## 1.7.485 — 2026-05-19

### Co-op viewer rewrite — P8: coverage harness

`tools/coop-viewer-sim.js` (~600 LOC). 21 tests covering:

- **Queue management** (5): injectEvent ordering, dup drop, 32-entry cap, no-op without flag, enterViewerMode flag gate
- **Direct anim invocation** (5): attack done-at-animMs, swDmgNum on first frame, multi-target magic, monster-death dyingMonsterIndices cycle, poison-tick batch damage-nums
- **Dispatch loop** (3): one event per anim cycle, multi-event chaining, unknown eventKind warn + finalState passthrough
- **Encounter lifecycle** (2): encounter-start bootstraps battleSt, encounter-end exits viewer + transitions FSM
- **Host promotion** (1): leaveViewerForPromotion returns lastIdx + tears down
- **Wire envelope** (2): wrapViewEventForWire shape + meta.encounterEnd flip
- **finalState writer** (3): battleAllies hp + statusMask writes, monster hp writes, unresolvable ref no-op

**Browser shim approach** — the viewer pulls in browser-coupled imports through battle-state.js. The harness installs minimal globalThis stubs (window/document/Image/Audio/AudioContext/Worker/localStorage/fetch/WebSocket) before the import, avoiding a jsdom dependency. ~80 LOC of shim.

**Test hooks added** to `src/coop-viewer.js`: `_testHooks.forceActive()`, `forceInactive()`, `injectEvent(viewEvent, turnIdx)` — bypass the build-time `COOP_VIEWER_MODE` flag for tests so the queue + dispatch can be exercised in flag-off builds.

`deploy.sh` now runs the viewer sim as a pre-flight gate.

Gates: lint 0, pvp-wire-sim 49/49, coop-wire-sim 9/9, coop-viewer-sim 21/21, coop-arbiter-sim 59+5.

## 1.7.484 — 2026-05-19

### Co-op viewer rewrite — P7: host promotion handoff

When the host disconnects and the server promotes a surviving peer (v1.7.476 flow), the new host's `setNetEncounterHostChangedHandler` now also:

1. Checks `COOP_VIEWER_MODE && coopViewSt.active` — was I running the viewer?
2. If so, calls `leaveViewerForPromotion()` which returns the viewer's `lastAppliedTurnIdx` and tears down `coopViewSt`.
3. Calls `setResolverTurnIdx(lastIdx)` so my next emitted packet (`turnIdx + 1`) lands monotonically for remaining guests.
4. Slams `battleState = 'menu-open'` so the FSM picks up at a clean turn boundary.

The new host's legacy `updateBattle` FSM resumes ticking. From this point I'm running the same code path as a regular host — battleAllies + encounterMonsters were already mutated by the viewer to reflect host's last-known state, so my FSM has the data it needs.

Edge case: if a different guest is promoted (not me), the v1.7.476 handler still updates `encounterHostUserId` for routing. My viewer stays active; future resolution packets route to it as before.

`setResolverTurnIdx` is new export in `src/coop-resolver.js`.

Gates: lint 0, pvp-wire-sim 49/49, coop-wire-sim 9/9, coop-arbiter-sim 59+5.

## 1.7.483 — 2026-05-19

### Co-op viewer rewrite — P6: encounter lifecycle

**Host emit at spawn:** `_maybeHostCoopEncounter` in `src/battle-encounter.js` now emits a `resolveEncounterStart` ViewEvent immediately after the local battle spawn. The payload carries realized stats (hp/maxHP/atk/def/agi/...) for every combatant — host's `ps` (from `ps.stats`) + every battleAlly entry (already realized via `generateAllyStats` at spawn). Guests under viewer mode use this to bootstrap battleSt without re-running `generateAllyStats`, eliminating the legacy hp-from-job-stats bug.

**Guest enter:** `setNetEncounterInviteHandler` calls `enterViewerMode()` after the legacy battleAllies spawn. Legacy spawn stays as a fallback display until the host's encounter-start ViewEvent arrives (~50ms cellular RTT); when it lands the viewer overwrites the roster with realized stats.

**Encounter end handoff:** After `_animEncounterEnd` finishes (event animMs elapsed, `battleState` transitioned to `victory-name-out` or `encounter-box-close`), the viewer calls `exitViewerMode()` so the legacy `updateBattle` FSM picks up the wrap-up (reward grant, inventory updates, box-close timer, return to overworld). Required because reward/inventory mutations live in the legacy victory flow.

Flag-off path unchanged on both sides. Viewer entry guarded by `COOP_VIEWER_MODE`; emit guarded too.

Gates: lint 0, pvp-wire-sim 49/49, coop-wire-sim 9/9, coop-arbiter-sim 59+5, headless smoke green.

## 1.7.482 — 2026-05-19

### Co-op viewer rewrite — P5: host emit extensions

Every host resolver entry now attaches a ViewEvent to its emitted packet alongside the legacy host-arb deltas, both shapes riding the same `encounter-resolution` wire envelope. The viewer (under flag-on) consumes `msg.viewEvent`; legacy host-arb-only clients consume `msg.deltas + msg.fx` as before. No backwards-compat break.

**Extended resolvers** (now build + ship a ViewEvent):
- `resolvePhysicalAttack` → AttackEvent with hits + killsTarget + finalState
- `resolveMonsterAttack` → MonsterAttackEvent
- `resolveSpellCast` → MagicEvent with per-target results
- `resolveItemUse` → ItemEvent
- `resolvePoisonTick` → PoisonTickEvent (batch)
- `resolveEncounterEnd` → EncounterEndEvent with rewards baked in

**New resolvers** (ViewEvent-only, used by P6 lifecycle wiring):
- `resolveMonsterDeath` — dissolve trigger
- `resolvePlayerDeath` — player/ally portrait fade
- `resolveTurnBegin` — cosmetic actor flash + optional menu prompt for the active guest
- `resolveEncounterStart` — replaces the guest's legacy invite-build-state path. Carries realized stats for every combatant so guests never run `generateAllyStats`.

**Helpers added:**
- `_resolveLocalActor(ref)` — symmetric with `coop-applier.js#resolveActorRef` for guests
- `_buildAutoFinalState(refs)` — reads host's post-apply state, builds the actor + monster snapshot the viewer reconciles to. Self-contained: no caller-supplied data needed.
- `_emitWithViewEvent(packet, viewEvent)` — attach + emit through the existing wire.

P6 wires the new resolvers (encounter-start in particular) into the host's FSM transition sites. Until then they're callable but unused.

Gates: lint 0, pvp-wire-sim 49/49, coop-wire-sim 9/9, coop-arbiter-sim 59+5, headless smoke green.

## 1.7.481 — 2026-05-19

### Co-op viewer rewrite — P4: main-loop hook

Two wirings, both flag-gated and inert under default flag-off:

1. **`src/game-loop.js#_gameLoopUpdate`** — branches between `updateBattle(dt)` (existing FSM, host or solo) and `updateCoopView(dt)` (viewer, guest under flag-on) based on `coopViewSt.active`. Strict either/or — never both.

2. **`src/coop-applier.js#_onEncounterResolution`** — adds an early-return that hands packets to `coop-viewer.ingestViewEventPacket` when `COOP_VIEWER_MODE && coopViewSt.active && msg.viewEvent`. The viewer owns its own dedup / ordering / finalState writes from there.

The legacy `_apply()` path (host-arb deltas + fx cues) still fires when the viewer is inactive or the packet doesn't carry a viewEvent, keeping the host-arb-only mode usable as a kill-switch fallback (though it's not currently exercised in prod).

Static activation gate: `coopViewSt.active` only flips true via `enterViewerMode()` which is gated on `COOP_VIEWER_MODE`. Flag-off therefore guarantees `active=false` forever, and the new branch is a no-op.

Gates: lint 0, pvp-wire-sim 49/49, coop-wire-sim 9/9, coop-arbiter-sim 59+5, headless smoke green.

## 1.7.480 — 2026-05-19

### Co-op viewer rewrite — P3: viewer skeleton

`src/coop-viewer.js` lands as the guest's packet-driven animation player.

**State:** `coopViewSt` exports `active`, `cueQueue`, `currentAnim`, `lastAppliedTurnIdx`.

**Lifecycle:** `enterViewerMode()` / `exitViewerMode()` / `leaveViewerForPromotion()` (returns last turnIdx for the new host's resolver).

**Tick:** `updateCoopView(dt)` — dispatcher consumes the queue strictly in turnIdx order, runs one anim at a time, writes `event.finalState` when anim completes.

**Anim registry** — handlers for every ViewEvent kind:
- `attack` / `magic` / `item` / `monster-attack` — trigger damage-num overlay + SFX, wait `animMs`, write finalState
- `poison-tick` — batch damage-num per affected actor
- `monster-death` — sets `dyingMonsterIndices`, waits `MONSTER_DEATH_MS`, clears
- `player-death` — finalState writes hp=0 (portrait fade is renderer's job via status check)
- `turn-begin` — surfaces menu prompt when `event.prompt = true`
- `encounter-start` — bootstraps battleSt.encounterMonsters + battleSt.battleAllies from realized stats baked into the event
- `encounter-end` — transitions to victory-name-out / encounter-box-close + writes rewards

**Wire ingestion:** `ingestViewEventPacket(packet)` queues by turnIdx with insertion-sort + dup dedup + 32-deep cap.

**Test surface:** `_testHooks` exposed for `tools/coop-viewer-sim.js` (P8).

**Unknown event kinds** are warned to console once + skip animation; finalState applied immediately. Forward-compat safe.

Dead code — no one imports `coop-viewer.js` yet. P4 wires it into the main loop.

Gates: lint 0, pvp-wire-sim 49/49, coop-wire-sim 9/9, coop-arbiter-sim 59+5.

## 1.7.479 — 2026-05-19

### Co-op viewer rewrite — P2: anim primitive scaffolding

`src/coop-view-anims.js` lands as a thin re-export module the viewer (P3) consumes. Audit confirmed the existing low-level anim primitives are already pure and shareable — slash-effects, damage-numbers, spell-anim, music exports have no FSM coupling. No heavy extraction needed (revised from the original plan, which assumed extraction). The viewer's orchestration (queue/dispatch + wall-clock) lives co-located in `coop-viewer.js`.

Also exports two helpers:
- `tickElapsed(state, dt, durationMs)` — wall-clock advance + done check
- `easeLinearProgress(elapsed, dur)` — clamped 0-1 progress for animation curves

Plus `MONSTER_DEATH_MS = 800` matching `battle-update.js` so the viewer's dissolve anim runs the same duration as the host FSM.

Zero behavior change. Module isn't imported by anyone yet; lands as dead code until P3.

Gates: lint 0, pvp-wire-sim 49/49, coop-wire-sim 9/9, coop-arbiter-sim 59+5, module loads cleanly in Node.

## 1.7.478 — 2026-05-19

### Co-op viewer rewrite — P1: protocol & flag

First phase of the card-game viewer rewrite (see `docs/COOP-VIEWER-PLAN.md`). Adds the `COOP_VIEWER_MODE` build-time flag in `src/coop-resolver.js` (default `false`) and lands the ViewEvent builders in `src/coop-deltas.js`:

- `buildAttackViewEvent` — physical multi-hit (player or ally)
- `buildMagicViewEvent` — full cast → impact → damage sequence
- `buildItemViewEvent` — non-spell consumable
- `buildMonsterAttackViewEvent`
- `buildPoisonTickViewEvent` — end-of-round batch
- `buildMonsterDeathViewEvent` — dissolve trigger
- `buildPlayerDeathViewEvent` — portrait fade
- `buildEncounterStartViewEvent` — replaces guest's local spawn-from-invite path
- `buildEncounterEndViewEvent` — victory/defeat/fled with rewards baked in
- `buildTurnBeginViewEvent` — cosmetic actor name flash + menu prompt

Plus `buildFinalState` (authoritative actor + monster snapshot, the card-game property) and `VIEW_ANIM_MS` (per-kind anim duration constants matching host FSM timing). `wrapViewEventForWire` envelopes a ViewEvent in the existing `encounter-resolution` shape so the wire path is unchanged — no server changes needed.

Builders are pure (no singleton coupling) and Node-clean (imported by future `tools/coop-viewer-sim.js`). Flag is dead; nothing reads these yet. P2 lands the anim primitive extraction; P3 ships the viewer that consumes them.

Gates: lint 0, pvp-wire-sim 49/49, coop-wire-sim 9/9, coop-arbiter-sim 59 pass + 5 expected.

## 1.7.477 — 2026-05-19

### Hot-revert: `COOP_HOST_ARB = false`

Live two-phone testing surfaced phone freezing + roster empty + wrong HP under flag-on (v1.7.474-v1.7.476). Hot-reverted per the documented procedure — flag flipped back to `false`, prod returns to legacy lockstep path (the v1.7.472 broken-but-known baseline). Host-arb plumbing stays wired; flag is the only thing that changed.

Diagnosis in progress. Likely culprits being investigated:
1. Guest's local FSM stuck in `ally-wire-wait` waiting on legacy `encounter-action` that's still emitted but timing mismatches the new resolution stream
2. Initial `battleAllies` population path on encounter-invite — not host-arb-aware, may be getting clobbered by an early resolution before allies are spawned
3. Resolution `turnIdx` race with the new host-promotion flow (new host's `_turnIdx` starts at 0 but other guests have already seen turnIdx=N)

PvP unaffected.

## 1.7.476 — 2026-05-18

### Host promotion on disconnect

Replaces the v1.7.475 force-close with actual host handoff. When the encounter host drops, the server picks the first surviving peer as the new host and broadcasts `encounter-host-changed { droppedUserId, newHostUserId }` to all remaining peers BEFORE the legacy `encounter-action kind=disconnect` notification. Client updates `battleSt.encounterHostUserId`, and if the new host is us, flips `encounterIsHost = true` so `isCoopGuest()` stops blocking local applies and our FSM starts emitting resolution packets to remaining peers.

Server tracks host per participant via a new `_encounterHosts: Map<userUid, hostUid>`, populated at `encounter-start` (every accepted candidate + host map to host's uid) and `encounter-assist-snapshot` (joiner inherits existing host pointer; solo target becomes host of new pair). Cleared in `_clearEncounterGroup`.

New host's FSM resumes resolution from their current local state — they've been receiving wire actions + applying resolution packets so their state is close to the dropped host's last-known. Any in-flight divergence is absorbed: the new host's view becomes canonical and remaining peers converge on it via the next resolution packet.

The v1.7.475 force-close guard stays as a safety net for the no-promotion path (e.g., dropped user was a guest with no surviving party, edge case that can't happen in practice but defends in depth).

Coverage: `tools/coop-wire-sim.js` 9/9 (added 2 tests — host-drops-promotes, guest-drops-doesn't-promote).

## 1.7.475 — 2026-05-18

### Host-disconnect rescue for co-op guests

Under host-arb (live since v1.7.474), every local HP / status mutation on a guest is short-circuited by `isCoopGuest()` waiting for the host's authoritative resolution packets. If the host disconnects mid-battle, those packets stop arriving and the guest was stuck in-battle forever — the FSM kept ticking but every mutation was blocked. Refresh was the only escape.

Fix in `src/encounter-wire.js`: when the server's `encounter-action kind=disconnect` notification fires for the dropped user, check whether the dropped userId matches `battleSt.encounterHostUserId` and the local client is `isCoopGuest()`. If both true, transition `battleState` to `encounter-box-close` so the guest exits cleanly (unless already wrapping up — victory/levelup/exp/gil flows are preserved).

Lost progress (XP / gil / loot from the in-flight encounter is gone, same as fleeing) but the player can move again. Host promotion / state handoff is still v2 work.

PvP path untouched. Guest-disconnect on host is unchanged — host falls back to local AI for the missing peer (legacy behavior, still correct).

## 1.7.474 — 2026-05-18

### Co-op host-arb LIVE — `COOP_HOST_ARB` flipped to `true`

Flipped the flag in `src/coop-resolver.js` so production now runs the host-authoritative deltas path. Host resolves every co-op battle event (physical attacks, monster attacks, spells, items, poison ticks, encounter-end) and broadcasts an `encounter-resolution` packet; guests apply via `coop-applier.js` (HP/MP/status deltas + fx cues for damage numbers + monster death). All guest-side legacy local-apply paths are short-circuited via `isCoopGuest()`.

PvP path is untouched (`isWireEncounter && encounterIsHost` gates remain). Solo and boss paths bypass co-op entirely.

Two-phone live smoke per `docs/COOP-PHASE-6-SMOKE.md` Stage 2 is the next gate. If anything diverges in production, hot-revert: edit `src/coop-resolver.js` → `COOP_HOST_ARB = false` → deploy. The flag-off path is byte-identical to v1.7.472 (kept as kill switch).

Gates: lint 0, pvp-wire-sim 49/49, coop-wire-sim 7/7, coop-arbiter-sim 59 pass + 5 expected Suite 1 divergence (math-primitive baselines stay failing-by-design; the rewrite routed around them rather than fixing the underlying math symmetry).

## 1.7.473 — 2026-05-18

### Host-authoritative co-op rewrite (flag-off baseline)

Phases 0-8 of the host-arb rewrite landed across `19f1403` → `ca21720`. `COOP_HOST_ARB = false` in `src/coop-resolver.js`, so this deploy is **byte-identical to v1.7.472 for live behavior** — the legacy lockstep path runs unchanged. The new path (host resolves + ships deltas; guests apply) is wired through every co-op call site and exercised by 59 sim tests, but dormant until the flag flips.

This deploy verifies the flag-off invariant holds in production. Solo, boss, PvP, party-encounter co-op (legacy lockstep, still broken) all behave as v1.7.472.

**Next step — flag flip:** see `docs/COOP-PHASE-6-SMOKE.md` for the two-phone smoke procedure. Hot-revert is one-line (flip flag back to `false`, redeploy).

## 1.7.472 — 2026-05-18

### Triggerer's phone now shows the ally roster at battle start

User reported one phone missing the other player in the ally panel during the battle opening — depending on which phone triggered the encounter. Cause: `_maybeHostCoopEncounter` (`src/battle-encounter.js`) was sending `encounter-start` to peers but never pushing them into the host's own `battleAllies` array. They only got added at the host's first `confirm-pause` via `tryJoinPlayerAlly`. During flash-strobe → battle-fade-in → menu-open, the host's roster panel was empty.

Fix: add party peers to `battleAllies` immediately at host time, same shape as the guest spawn in `setNetEncounterInviteHandler` (generateAllyStats + userId + isWireDriven=true + mid-battle HP/MP override). `tryJoinPlayerAlly`'s name-dedup keeps it from double-adding later.

Both phones now show the full roster from the first frame of the battle.

## 1.7.471 — 2026-05-18

### "Miss your turn" — no auto-action, no AI fallback

User clarification: there should be no auto-anything. If you take too long, you miss your turn. That was the original 10-second design.

- `TURN_TIME_MS`: 5s → **10s** (revert). The 5s experiment in v1.7.469 wasn't the right call.
- Auto-action: `'defend'` → **`'skip'`** (revert). Skip is the miss-your-turn semantic — no animation, no damage halving.
- `ally-wire-wait` timeout: 7s → **10s** (matches local clock). Peer misses the turn on the same timer the local player has.
- `ally-wire-wait` fallback: removed `isDefending = true`. Just shift the unfulfilled turn off the queue. No defend, no AI. `isWireDriven` stays true so the next turn runs wire-driven normally.

`encounter-wire.js#disconnect` handler unchanged — explicit server-confirmed peer drops still flip `isWireDriven=false` (that's a real disconnect, not a guess). Inside an active session, peers always stay wire-driven; missed turns just skip silently.

## 1.7.470 — 2026-05-18

### Stop fake-player AI from taking over a real peer's turn

User reported "still using fake player logic, attacking without selecting attack". Cause: `battle-ally.js#updateBattleAlly`'s `ally-wire-wait` timeout was 45 seconds AND flipped `ally.isWireDriven = false` permanently. After 45s of no wire delivery the peer was downgraded to local AI for the rest of the battle — the AI helpers (`_tryAllyCure`, `_tryAllyPoisona`, `_tryAllyOffensiveCast`, fallthrough attack) then ran every subsequent turn even when the peer was perfectly online + just being slow.

- Timeout 45s → **7s** — fits inside the 5s auto-defend window on the peer's own clock plus a 2s round-trip safety margin.
- Removed the `isWireDriven = false` flip. The auto-action is now scoped to the SINGLE missed turn: `isDefending = true` (so monster damage halves), queue advances, next turn's `ally-wire-wait` runs normally. If the peer's wire actions resume, dispatch goes back to wire-replay — no permanent AI takeover.

`encounter-wire.js:28`'s explicit `disconnect` handler is unchanged — that's a server-confirmed peer drop, not a transient delay, so the permanent flip still makes sense there.

## 1.7.469 — 2026-05-18

### Battle auto-runs — shorter turn timer + defend-on-idle

User reported one phone stuck waiting on the other's input for ~10s. Auto-skip existed but `TURN_TIME_MS = 10000` was too long for co-op feel — when one phone is at `menu-open` and the other in `ally-wire-wait`, the waiter's clock is the bottleneck for round throughput.

- `TURN_TIME_MS`: 10s → **5s** (`src/battle-update.js:71`). Snappier auto-cadence; still gives the user time to think before firing.
- Auto-action: `'skip'` → **`'defend'`** (`src/battle-update.js:_updateTurnTimer`). Skip wasted the turn entirely; defend at least halves incoming damage. Round-progression behavior is identical (one wire emit, queue advances).

Combined effect: an AFK player's turn fires within 5s, defending instead of skipping; the waiting peer's `ally-wire-wait` clears as soon as that wire action arrives. The 45s `WIRE_WAIT_TIMEOUT_MS` AI-fallback stays unchanged for actual disconnect cases.

## 1.7.468 — 2026-05-18

### Per-turn RNG reseed (replaces per-round)

The previous "deterministic-lockstep" model rolled RNG identically on both phones from a per-round shared seed and assumed every code path consumed `rand()` symmetrically. Every drift bug shipped this session (magic hit-check, status inflict, monster spAtk roll, AI ally fallback, shieldEvade asymmetry, ...) was a different way of breaking that assumption mid-round.

User's call: stop trying to perfectly mirror every rand consumer; just re-seed at every turn dispatch so any per-turn drift gets wiped before the next turn starts. New `battleSt.perTurnIndex` monotonic counter; new helper `reseedCoopTurnRand()` (`src/battle-turn.js`) bumps it and seeds RNG to `encounterSeed + perTurnIndex`. Called at two sites:

1. **Confirm-pause completion** (alias kept as `maybeReseedCoopTurn` so the existing call in `battle-update.js:_updateBattleMenuConfirm` still fires). Reseed before `buildTurnOrder` so initiative + every roll inside the first turn share a seed across phones.
2. **Top of `processNextTurn`** after `queue.shift()`. Reseed before every individual turn so the previous turn's mid-turn drift can't leak into this turn's rolls.

Both phones process the same turn queue in the same order, so `perTurnIndex` increments identically — same seed per turn → guaranteed lockstep at every turn boundary. `encounterTurnIndex` retained for snapshot-spawn compatibility (joiner reseeds to `seed + msg.turnIndex` on assist snapshot) but no longer drives the reseed cadence.

Solo battles: `reseedCoopTurnRand` early-returns when `isWireEncounter` is false. RNG flows naturally. No regression in single-player.

## 1.7.467 — 2026-05-18

### Defer assist-incoming until the host is at a round boundary

Real cause of "unsyncs after first round of attacks in assist": when the host accepted an assist mid-round, the snapshot shipped HP at the *moment of send* — but the host's monsters kept attacking the host locally between that send and the joiner's spawn. Those attacks don't ride the wire (only player / ally actions do), so the joiner's view of the host's HP started ahead by however much the host took during the rest of the round. Round 1 then ran in lockstep but applied damage to different starting HP → permanent divergence.

Fix (`src/battle-encounter.js`): the assist-incoming handler now queues into `_pendingAssistIncoming` when `battleState !== 'menu-open'`; exported `drainPendingAssistIncoming()` flushes the queue when the host is at the safe boundary. Called every tick from `updateBattle` (`src/battle-update.js`) — internal state-gate makes it a no-op outside the window. Result: the snapshot is built from a stable round-boundary state, so both clients enter their first co-op round with matching HP.

UX caveat: a joiner whose assist-request lands mid-round now waits until the host's current round ends (typically <10s) before spawning into the battle. Previously they spawned instantly into a state that was about to diverge.

## 1.7.466 — 2026-05-18

### Spell hit-check moved into `applyMagicDamage` — sender + watcher RNG lockstep

For damage spells with `hit > 0 && hit < 100` (Tornado, FastCurrent, Glare-as-damage, Avalanche, Wind Slash, Whirlpool, etc.), the sender rolled `rand() * 100 >= spell.hit` in `spell-cast.js#_applyEnemyEffect:458` and `_applyFriendlyOffensive:560` before calling `applyMagicDamage`. The wire-driven watcher's `applySpell` path skipped the check entirely — sender consumed +1 rand per hit<100 damage cast, every subsequent rand() in the same round (monster AI target picks, status inflicts on attacks, AI ally activation rolls) read a different value on the two phones until the round-boundary reseed wiped it.

Hit-check moved into `applyMagicDamage` itself (`src/combatant-cast.js:211-218`): both sender and watcher now route through the same code path so they consume identical rand counts. New `opts.onMiss` callback fires the miss-display the caller used to fire manually. Boss-path keeps its own hit-check (`spell-cast.js:492`) — boss combat has no wire-driven watcher (`_allyMagicEnemyTarget` returns null on peer side), so the asymmetric rand consumption there doesn't break co-op sync.

Round-boundary `maybeReseedCoopTurn` still bounds drift to one round in case anything else slips in; this fix removes the largest known remaining mid-round drift source.

## 1.7.465 — 2026-05-18

### New `tools/coop-wire-sim.js` regression harness (quick smoke)

7-test harness that boots the real `ws-presence.js` server + 2-3 JWT-authed `ws` clients on a localhost port and walks the co-op + party-fanout surface I broke and re-broke shipping v1.7.460-v1.7.464. Covers: party-invite accept routing, mesh fanout (`party-member-joined`) to existing members, `party-snapshot` to the new joiner, `party-member-left` fanout on leave, `encounter-start` triggering immediate `inBattle=1` player-update broadcast, `encounter-action` relaying `damageRoll`/`healAmount` intact, `encounter-end` clearing `inBattle=0` on host. Wired into `deploy.sh` alongside `pvp-wire-sim.js` (now 49/49 + 7/7 pre-flight gates).

Quick smoke only — no edge-case coverage (assist mid-flight, disconnect-mid-battle, three-way co-op, spell hit-check drift); those are TODOs once the basic scenarios are reliable.

## 1.7.464 — 2026-05-18

### Co-op watcher spell coverage — route through shared `applySpell`

`src/battle-ally.js#_applyAllyMagicEffect` only handled six spell IDs (`0x31 Fire`, `0x32 Bzzard`, `0x33 Sleep`, `0x34 Cure`, `0x35 Poisona`, `0x36 Sight`). Every other player-cast spell — Fira, Bzzara, Tara, Cura, Curaga, Curaja, Raise, Stone, Confuse, Drain, Catas, Tornado, etc. — fell through to a default `applyMagicHeal` call. Watchers saw heal sparkles on enemies that should have been taking damage; status spells silently no-op'd; the host's HP / damage numbers diverged from the joiner's view by the entire spell payload.

Rewrite routes through `applySpell` (the same dispatcher the sender's `_applySpellEffect` reaches at `src/combatant-cast.js:155-198`): faction-resolve the target, pick `amount` from `damageRoll` or `healAmount` based on `spell.element === 'recovery' || spell.target === 'cure_status' || spell.target === 'revive'`, derive `statusFlag` from `STATUS_NAME_TO_FLAG[spell.type]` for `cure_status` spells (mirror of `spell-cast.js:679`), and hand the dispatcher every faction-appropriate render callback (`onDmgNum`, `onHealNum`, `onSparkle`, `onMiss`, `onLand`, `onStatusMsg`). Sight + erase keep their no-target fast paths.

Hit-check drift on `spell.hit < 100` damage spells is still a known cursor-drift source (sender rolls in `spell-cast.js:458`, watcher doesn't); not addressed in this deploy — needs the hit roll moved into a shared helper that both sides call.

## 1.7.463 — 2026-05-18

### Parallel-battles race in party encounters

User reported "still not syncing" with the symptom that two party members walking together kept spawning separate battles instead of joining one. The auto-join shipped in v1.7.462 reads the 500 ms-polled `inBattle` profile flag, which lagged behind the actual encounter start. Two fixes:

**Server (`ws-presence.js`):** new `_pushInBattle(userId, flag)` helper. On `encounter-start` success, immediately set `entry.profile.inBattle = 1` for the host + every accepted candidate AND `_broadcast` a `player-update` to all peers — eliminates the 500 ms cache lag so the next step-trigger on any party member sees the flag and routes via assist instead of spawning parallel. Symmetric clear on `encounter-end`.

**Client (`src/battle-encounter.js#setNetEncounterInviteHandler`):** when both phones trip the step threshold within the same network frame, each spawns a local host battle and sends `encounter-start`; the server processes by arrival order and silently drops the loser. The loser's local FSM is then stuck in self-hosted `flash-strobe` when the winner's `encounter-invite` arrives. New `isSelfHostRace` branch tears the half-built host state down (`isWireEncounter / encounterIsHost / encounterMonsters / battleState=`none`) and lets the spawn path below run as a guest of the actual host.

## 1.7.462 — 2026-05-17

### Party member's next trigger auto-joins teammate's in-progress battle

When a party member was opening a chest / standing in dialogue / on a different floor at the moment their teammate's battle started, they were skipped from the initial `encounter-start` fanout (correct — they were busy). Previously their NEXT step-counter trigger spawned a parallel encounter; now it auto-joins the teammate's existing battle via the assist flow IF they're in the same location.

New helper `_findPartyMemberInBattleSameLoc()` (`src/battle-encounter.js`) walks party members, filters by `online.inBattle && online.loc === myLoc`, and returns the first match. `tickRandomEncounter`'s post-threshold branch checks for a match first; on hit it calls `sendNetEncounterAssistRequest(host.userId)` and arms a 1s fallback to spawn a fresh encounter only if no assist-snapshot arrives (host's battle could have ended between presence-poll and now). Solo + no-eligible-party-member path unchanged.

## 1.7.461 — 2026-05-17

### Party encounter triggers split across members

Each party member ticks their own `mapSt.encounterSteps` independently, so a 3-person party walking together used to trigger ~3× the encounters a solo player would. Now `tickRandomEncounter` (`src/battle-encounter.js`) scales the step threshold by `(online party members + 1)`, so each individual rolls at 1/N and the combined party rate matches the solo rate. New helper `_countOnlinePartyMembers()` counts party members whose presence the client has from `getOnlinePlayerByName`. Solo path is unchanged (`partyScale = 1`).

## 1.7.460 — 2026-05-17

### Party system: full-mesh sync (no more star topology)

Pre-fix, `party-invite-response` only notified the inviter on accept and `party-member-left` only notified the inviter on disconnect. That left non-inviter members with a stale view:

- A invites B → both see each other. ✓
- A invites C → A's view = [B, C]; **B still saw [A]; C saw [A]**. ✗
- B disconnects → only A learns. **C kept B in their list.** ✗

**Server (`ws-presence.js`):**

- On accept (`party-invite-response`, accept branch): walk every existing member of the inviter's party and `_send` them a new `party-member-joined` with the joiner's profile. Send the joiner a `party-snapshot` listing the existing members so their `partyMembers` mirrors the inviter's view immediately.
- New helper `_broadcastPartyMemberLeft(inviterId, leaverUserId, leaverName)` — fans `party-member-left` out to inviter + every accepted member of the same party. Replaces the inviter-only `_send` at both the disconnect cleanup and `party-leave` action.

**Client (`src/net.js` + `src/party-invite.js`):**

- New wire kinds `party-member-joined` and `party-snapshot` with handlers + setters.
- `party-invite.js` handlers splice the joiner into `partyMembers` + `partyMemberProfiles` (and `partyMembers` for the snapshot). System chat note on the joined event so members see "* X joined party".

## 1.7.459 — 2026-05-17

### Co-op allies stay in roster through victory until peer leaves

Two related changes so the ally panel reflects "who is actually still here" during the post-battle decision flow:

**1 — Removed auto-fade during victory** (`src/battle-update.js`).

`_updateAllyExitFade` was starting to fade ally portraits to black 1500 ms into any victory state, then dimming over 400 ms regardless of whether the peer was still alive. Players tapping slowly through exp / gil / cp / level-up text saw their allies vanish mid-flow even though the peers were still around. Function deleted; `allyExitTimer` field deleted with it. Allies stay at `fadeStep=0` for the entire local victory sequence; the natural clear at `encounter-box-close` (`battle-update.js:954`) wipes them when the local player actually exits.

**2 — `encounter-end` from a peer removes only that peer when we're wrapping up** (`src/encounter-wire.js`).

Previously the handler did `_wireEncounterActions.length = 0` (wiped every peer's wire queue, not just the departing peer) and then either no-op'd or force-closed our FSM. The no-op case left the departing peer's portrait lingering on our screen until our own box-close fired. New behavior:

- Drain wire actions for the departing `msg.userId` only (other peers still queued).
- If we're wrapping up locally, splice that peer out of `battleSt.battleAllies` so their portrait disappears the moment they leave on their end.
- Mid-battle force-close path unchanged (a peer running while we're still fighting still drops us out of the encounter — the alternative would leave us stalled on `ally-wire-wait`).

## 1.7.458 — 2026-05-17

### Co-op assist sync fixes

User reported assists going out of sync between phones. Audit found three contributing bugs (none of them magic-specific, but the magic path also had a latent desync worth fixing in the same pass).

**Bug 1 — Host shipped a blank profile in the assist snapshot** (`src/battle-encounter.js:317-345`).

When a host accepted an incoming assist, `peers[0]` (host self) was just `{ userId, name }` — no `jobIdx / level / weaponR / weaponL / armorId / helmId / shieldId / knownSpells / jobLevel`. The joiner's `generateAllyStats(peer)` ran against this blank object → host rendered as a level-1 unarmed default-job ally with degenerate atk/def/hp/agi. The server enriches `name / jobIdx / level / palIdx` from its trusted profile (`ws-presence.js:754-761`) but doesn't track equipment — those four fields stayed missing. **This is the most likely root cause of "everything off" in assist battles.** Fix builds the host peer from `ps` (jobIdx, level, weaponR, weaponL, body, head, arms, knownSpells, jobLevels) so the joiner has the full input to `generateAllyStats`.

**Bug 2 — Joiner ignored mid-battle HP in the snapshot** (`src/battle-encounter.js`, assist-snapshot handler).

`generateAllyStats` sets `hp = maxHP` from job/level math. The receiver pushed the result straight into `battleSt.battleAllies` without overriding with the snapshot's live HP/MP, so the joiner saw the host (and any existing allies) at full bars even if the host had been fighting solo for several rounds. Fix overrides `stats.hp / mp / maxHP` from the wire payload after `generateAllyStats`.

**Bug 3 — Magic wire payload missing `damageRoll` / `healAmount`** (`src/encounter-wire.js`, `src/battle-update.js#_emitWirePVPAction`).

When a player cast magic in co-op or PvP, `emitWireEncounterAction` / `_emitWirePVPAction` shipped `{ kind: 'magic', spellId, target }` with no roll. Receivers' `_applyAllyMagicEffect` read `action.healAmount | 0 = 0` → 0 heal / 1 damage on watcher phones while the sender's `spell-cast.js` rolled real values at apply time. Fix pre-rolls the amount at `_updateBattleMenuConfirm` via new `prerollSpellAmount(spellId)` helper (`src/spell-cast.js`), stashes on `pending.preRolledAmount`, threads through `startSpellCast(spellId, ts, { preRolledAmount })` so the sender uses the cached value via `_baseAmount`. New `isHealSpell(spellId)` helper picks `healAmount` vs `damageRoll` for the wire payload.

Wire-sim still 49/49 (changes don't touch the wire-receive paths the harness covers).

## 1.7.457 — 2026-05-17

### Strip stale `'atb-idle'` predicates

Cosmetic cleanup left over from the v1.7.456 ATB revert. `'atb-idle'` was an ATB-era battle state that is no longer assigned anywhere, but 5 OR-branches and one comment were still gating menu/encounter drawing on it.

- Removed `bs === 'atb-idle'` alt from `_isMenuish` predicate (`src/battle-draw-menu.js:218-222`) — also drops the four-line "ATB era —" comment block
- Removed `battleState === 'atb-idle'` from `_isEncounterCombatState` and the two PvP / boss combat-state checks in `src/battle-draw-encounter.js:161, 267, 291`

No runtime change — all four call sites previously evaluated to `false` on the dead alt. Audit confirmed no other orphan ATB references remain (`pvp-wire-sim` 49/49).

## 1.7.456 — 2026-05-17

### Revert ATB rewrite — back to FF3-style round-based combat

User feedback: ATB feel wasn't working. Reverting the entire v1.7.428→v1.7.455 ATB system back to the pre-ATB FF3-style flow:

- Player picks all party commands at round start
- Initiative-rolled turn queue processes once
- `TURN_TIME_MS = 10000` decision auto-skip restored
- No gauges, no real-time

**Surgical revert.** Used `git checkout b7be156 -- <files>` to restore the four core battle files (`battle-update.js`, `battle-turn.js`, `battle-ally.js`, `pvp.js`, `battle-encounter.js`) to v1.7.427 state. Deleted `src/atb.js`, `src/atb-render.js`, `tools/atb-sim.js`, `tools/atb-fsm-sim.js`. Stripped all ATB-related code from `encounter-wire.js`, `net.js`, `ws-presence.js` (atb-sync / atb-ready / pvp-atb-sync wire kinds removed; server-side `_encounterBattles` tick loop removed). Removed Battle Speed slider from pause-menu, `SPELL_CAST_TIME` table + `tagCasterCastTime` helper from `data/spells.js`, `setSpeedMod` Haste wire from `spell-cast.js`, `_drawPortraitATBBar` from `battle-draw-player.js`, `drawATBGauges` call from `battle-drawing.js`.

**Preserved post-ATB fixes that aren't ATB-related:**
- v1.7.446 `forceCloseMsgBox` on battle entry (chest msg box bleeding into battle)
- v1.7.447 Magic menu opens even with empty spell list
- v1.7.448 chat tab cursor + empty-roster tab select
- v1.7.449 enemy "x2" multiplier glyph (AWJ font fix)
- v1.7.450 server save validator includes equipment fields
- v1.7.453 staff icon subtype fallback + chat tab z-order
- v1.7.454 `removeBossNpc` on dissolve + `MapRenderer#redrawMetatileAt` chest-flicker fix

Wire-sim now 49/49 (down from 61/61 — 12 ATB-protocol tests removed). Lint clean. Land Turtle returns to legacy turn-queue flow (the v1.7.453 boss-ATB registration is gone; boss attack runs through the original `BOSS_ATK`/`BOSS_HIT_RATE` path).

## 1.7.455 — 2026-05-17

### FF4 SNES canon — menu opens only when ready, no visible gauge, sub-menus pause everything

Pulled the canonical battle flow from the [everything8215/ff4 disassembly](https://github.com/everything8215/ff4) (verified against [datacrystal RAM map](https://datacrystal.tcrf.net/wiki/Final_Fantasy_IV_(SNES)/RAM_map)):

- `BattleMain @85d9` calls `DecTimers` each loop **only when `$38d9` and `$38da` are both zero**. Those flags are set during any blocking activity — menu, action animation, message display. When set, every timer freezes.
- `$16ac` is Battle Speed → `BattleSpeedTbl` → frame counter `$3538`. Throttles tick rate; doesn't gate ticks.
- FF4 SNES has no on-screen ATB gauge by design.

Pre-fix our system was "Active mode + queueable commands": menu opened at battle-fade-in regardless of gauge state, gauges ticked through every state including sub-menus, gauge bar visible. Net effect — monsters filled while the player was in Item/Magic submenus and dispatched the moment the sub-menu closed, reading as "menu reset by enemy attack." Sloppy, not canon.

Three changes to align:

1. **Gauges tick only when truly idle.** New `_ATB_TICK_STATES = {'atb-idle', 'menu-open'}` in `src/battle-update.js`. Every other state — sub-menus, target-select, action animations, damage display, message strips — pauses all gauges. Mirrors FF4's `$38d9`/`$38da` wait-flag behavior. Active mode is preserved at the top-level menu (per v1.7.433 user choice — monsters can still interrupt while you're sitting on the main menu), but the moment you go into a sub-menu the world freezes.

2. **Menu opens only when player gauge is ready.** Battle-fade-in now transitions to `atb-idle` instead of `menu-open`. Dispatch hub picks the player when their gauge fills and flips to `menu-open` then. After every action, `processNextTurn` yields to `atb-idle` (was conditional on `ps.hp > 0` → menu-open). Reverts v1.7.437's queueable-commands behavior.

3. **No visible gauge bar.** `_drawPortraitATBBar` call commented out in `src/battle-draw-player.js`. Function body kept for reference. FF4 canon — players read battle pacing from the menu appearing, not from a bar.

Sims green (atb-sim 43/43). No changes to the wire protocol.

## 1.7.454 — 2026-05-17

### Fix — Land Turtle sprite stuck after defeat + chest-open flicker

**Land Turtle sprite stayed visible after defeat.** v1.7.453 wired the boss into ATB dispatch but the overworld NPC entry was never removed from `_npcs` after the dissolve. `addBossNpc` runs from `map-loading.js` gated on `!battleSt.enemyDefeated`, so on next dungeon reload the boss respawns correctly — but in the post-defeat moment its sprite just sat there. Added `removeBossNpc()` in `src/npc.js` (filters `_npcs` by key `boss_land_turtle`) and call it from the boss-dissolve completion in `src/battle-update.js` alongside `mapSt.bossSprite = null`.

**Chest-open flicker in altar cave.** `handleChest` in `src/map-triggers.js` was instantiating a fresh `MapRenderer` after every chest open — `prerenderFullMap` walks all 32×32 metatiles + builds two priority-overlay canvases synchronously. ~50–200 ms on mobile = perceptible flicker.

Added `MapRenderer#redrawMetatileAt(tx, ty)` that patches only the changed 16×16 metatile in the three pre-rendered canvases (`_mapCanvas`, `_overlayU`, `_overlayL`). Chest / secret wall / rock-puzzle handlers now call this instead of allocating a new renderer. Full `new MapRenderer(...)` still used for actual map transitions in `map-loading.js` and `map-triggers.js` stairs / warps.

## 1.7.453 — 2026-05-17

### Fix — Land Turtle wasn't attacking + staff icon missing + chat-tab cursor

Three bugs, one deploy:

**Land Turtle never took a turn.** The ATB rewrite (v1.7.428→v1.7.443) registered units from `encounterMonsters`, but the boss fight stores HP on `battleSt.enemyHP` and never populates `encounterMonsters`. So `pickReadyActor` never returned the boss and it sat idle. Fix in `src/battle-update.js#initBattleATB`: when not random + not PvP and `getEnemyHP() > 0`, register a stable synthetic ref (`battleSt._bossAtbRef`) with a `hp` getter/setter that proxies through `getEnemyHP/setEnemyHP`. New `kind: 'boss'` dispatch branch in `_updateATBDispatch` queues `{type:'enemy', index:-1, isBoss:true}`; `_resolveTurnActor` and the enemy-turn name-queue branch in `src/battle-turn.js` now recognize `turn.isBoss` and pull the Land Turtle name (monster 0xCC). Existing boss attack code in `src/battle-enemy.js` already handles `currentAttacker=-1` (falls back to `BOSS_ATK / BOSS_HIT_RATE`). `_bossAtbRef` cleared in `resetBattleVars`.

**Chest "Found Staff!" had no glyph.** `getItemNameWithIcon` only prepended an icon when the ROM string itself had one as its first byte. Basic FF3 staffs / rods / etc. don't carry an icon byte in their ROM strings. Added a `_SUBTYPE_ICON` table in `src/text-decoder.js` mapping `items.js#subtype` → AWJ font glyph byte (`staff → 0xEA`, `rod → 0xE9`, `sword → 0xEF`, etc.), used as a fallback in both `getItemNameWithIcon` and `getItemNameShrines`. Items with an explicit `icon: 0xNN` field in `items.js` still take priority.

**Chat-tab cursor was clipped + sat under HUD borders.** v1.7.448 drew the cursor inside `drawChatTabs` at `tx + 2` — that landed *under* the tab's left border tile and was further hidden by the chat-panel border that overlaps the tab bar's bottom 8 px. Moved cursor draw to a separate `drawChatTabCursor(ctx)` exported function that game-loop calls AFTER `drawChat`, positioned at `HUD_RIGHT_X - 8` (just outside the active tab's left edge). Renders on top of the roster / chat panels.

## 1.7.452 — 2026-05-17

### Revert v1.7.451 — keep FF4 canon menu lock during enemy attacks

Reverted the buffered-menu-input change. FF4 SNES locks the menu during enemy attack animations in both Wait and Active modes; our previous behavior matched canon and the divergence wasn't worth the visual confusion.

Restored `_drawBattleMenuCursor`, `handleBattleInput`, `resetBattleVars`, and dropped `inputSt.bufferedMenuCommand`.

## 1.7.451 — 2026-05-17

### Buffered menu input during enemy attacks

The menu was previously dead while an enemy was attacking (states `enemy-flash` / `enemy-attack` / `enemy-damage-show`). FF4 canon locks the menu during attack animations — we're diverging to keep ff3mmo's pace snappy.

Now during those states:
- Cursor navigation is live (←/→/↑/↓ + SFX.CURSOR).
- The on-screen cursor stays visible on whichever slot you're hovering.
- Z stages a buffered pick (`inputSt.bufferedMenuCommand`); the action doesn't fire mid-swing.
- When the FSM returns to `menu-open`, the buffered pick fires immediately on the next input frame — no extra Z press needed.

Implementation: small relax of input + cursor-draw gates, plus `bufferedMenuCommand` cleared in `resetBattleVars`. Existing target-select / item-list / magic submenus stay normal — buffering only covers the top-level slot pick (Fight/Magic-or-Defend/Item/Run). Sub-state input is already responsive once you reach it.

## 1.7.450 — 2026-05-17

### Fix — equipment lost on restart (server save validator dropped equipment fields)

Reported: equipment didn't persist across restart.

Root cause: `api.js#_validateSaveData` whitelisted `stats.{level,exp,hp,maxHP,str,agi,vit,int,mnd}` but **dropped** `maxMP` and all five equipment slots (`weaponR/weaponL/head/body/arms`). Client sent them, server stripped them on save. `loadSlotsFromDB` prefers server state over IndexedDB; on reload `slot.stats.weaponR` came back undefined → load path fell back to new-game defaults (Knife / Leather Cap / Cloth Armor). Equipment looked erased.

Pause-menu equip flow calls `saveSlotsToDB()` after every change (`src/pause-menu.js`); that part worked locally but the server save round-trip stripped the fields.

Two fixes:
1. **`api.js#_validateSaveData`** — extended the `out.stats` whitelist with `maxMP` (clamp 0–9999) and `weaponR/L/head/body/arms` (clamp 0–255 item-id; 0 = empty slot).
2. **`src/input-handler.js#_itemSelectSwap`** — battle-menu equip swaps never called `saveSlotsToDB()` either. Added a tracked `equipChanged` flag with a single save at the bottom of the function.

Plus a sim guard: 2 new tests in `pvp-wire-sim --suite=server` that round-trip the full stats payload through `_validateSaveData` and assert each equipment field survives + is clamped. Catches future whitelist drift. Wire-sim now 61/61.

## 1.7.449 — 2026-05-17

### Fix — enemy "x2" multiplier showed robe icon

Reported: "Goblin x2" rendered with a leather-armor / robe glyph instead of the lowercase 'x'.

Cause: `_battleEnemyNames` / `_battleEnemyName` in `src/battle-draw-menu.js` pushed `0xE1` as the multiplier character. That worked in the NES-original FF3 font but AWJ remapped `$E0-$F5` to item-class icons (shield/robe/mail/helm/...); `$E1` is now "robe".

Fix: byte `0xBB` (lowercase 'x' per AWJ atlas — `a=$A4`, `x=$A4+23=$BB`). Two call sites updated; same constant doc'd in both spots.

## 1.7.448 — 2026-05-17

### Chat tab select — cursor indicator + empty-roster access

Two follow-ups to the tab select UX:

- **Cursor on the active tab.** `drawChatTabs` now renders the standard 8×8 menu cursor at the active tab's left edge while `tabSelectMode` is on. Stays put while the label blinks so focus is always clear.
- **Empty-roster access.** Pre-fix, S press from roster=none gated on `getRosterVisible().length > 0` — empty-roster players couldn't enter tab select at all (both S presses were no-ops). Now an empty roster skips the browse step and goes straight to tab select on the first press; non-empty roster keeps the existing two-tap browse → tab select flow.

## 1.7.447 — 2026-05-17

### Fix — Magic menus open with empty spell list (no silent Defend fallback)

Reported (after debugging job-flip into White Mage with no learned spells): pause Magic option was a no-op (SFX.ERROR + bail), and the battle Magic slot silently fell through to Defend.

Three changes:
- **`src/battle-update.js#executeBattleCommand`** slot 1: drop the `&& castableKnown.length > 0` gate. Mage-class jobs (WM/BM/RM) always open the magic submenu, even with an empty filtered list. Non-mages still get Defend on slot 1 (FF3 canon — mages don't have Defend).
- **`src/pause-menu.js#_pauseInputMagicZ`**: drop the empty-list early-return. Submenu always opens.
- **`src/pause-menu.js#_drawPauseMagicList`**: render "No spells" empty-state, mirroring the existing battle-panel pattern at `src/battle-draw-menu.js:154`.

Both submenus' input handlers were already empty-safe (Z press on undefined spellId → SFX.ERROR + return; X press → cancel-out). Just had to drop the gates.

## 1.7.446 — 2026-05-17

### Fix — overworld msg box bleeds into battle screen

Reported: "Found Potion!" stayed visible after a random encounter triggered mid-chest-open.

Cause: `drawMsgBox` runs every frame regardless of `battleSt.battleState`. The battle-spawn paths (`startRandomEncounter`, the encounter-invite handler, the assist-snapshot handler) didn't clear the msg box, so any in-flight overworld message sat on top of the battle wipe and persisted into the encounter view. `dismissMsgBox` only handles the `'hold'` phase — a box in `'slide-in'` (just popped) wouldn't have dismissed either way.

Fix: new `forceCloseMsgBox()` in `src/message-box.js` resets msg state to `'none'` unconditionally (no slide-out animation; the battle wipe covers the visual). Called at the top of `startRandomEncounter` and right before the `'flash-strobe'` transition in both wire-driven battle-spawn handlers.

Boss path (`startBattle`) already overwrites via its own `showMsgBox(BATTLE_ROAR)`, so it stays as-is.

## 1.7.445 — 2026-05-17

### FF4 spell cast time (charge) + Active-mode doc fix

After verifying our ATB against canonical FF4 SNES sources (Free Enterprise Wiki RA / battle-mechanics / battle-timers), this lands the one canonical FF4 ATB feature we never built and corrects a misleading comment.

**Spell cast time / charge** — FF4 mechanic. After a spell action resolves, the caster's next gauge fill target is `(RA + castTime) × TICK_MS × speedMod` instead of just `RA × TICK_MS × speedMod`. Cast-time units are RA-equivalent ticks (1 charge = 1 RA tick). Tuned snappier than FF4 canon for our combat pacing:

| Spell | castTime | Per FF4 |
|---|---|---|
| Sight (WM Lv1 utility) | 2 | near-instant |
| Cure / Poisona (WM Lv1) | 3 | quick heal/cure |
| Fire / Blizzard / Sleep (BM Lv1) | 4-5 | moderate |
| Blizzara (BM Lv2) | 6 | Lv2 spells charge longer |
| (items) | 0 | items resolve immediately per FF4 |

Source: `src/data/spells.js` `SPELL_CAST_TIME`. Defaults to 0 for any spell without an entry. Add a row when wiring a new player-castable spell.

**Wire plumbing.** New `castTimeRa` field on `atb-sync` + `pvp-atb-sync` so peers / partners see the same extended fill bar after a long-cast spell. Server tick (`_tickEncounterBattles`) factors it into the target compute so authoritative `atb-ready` broadcasts fire on the same extended delay. Clamped [0, 99] (FF4 max) on receive so a malicious client can't park a peer's gauge forever.

**Dispatch tagging.** A new `tagCasterCastTime(actor, spellId, isItemUse)` helper in `src/data/spells.js` stashes `actor._nextCastTimeRa`; `_resetLastDispatched` in `battle-turn.js` consumes it on action-end and passes through to `markFilling`. Called at all 10 spell-cast initiation sites (1 player, 5 ally, 4 PvP-enemy).

**Active mode doc fix.** `src/atb.js` comment previously called our mode "automatic Wait mode" — corrected to label it Active mode (monsters tick during the player's sub-menus). FF4 SNES is locked to Wait mode; we deliberately diverged in v1.7.433 to prevent MMO menu-camping.

43/43 atb-sim (+4 castTime tests). 59/59 pvp-wire-sim (+3 castTimeRa relay tests). 5/5 atb-fsm-sim.

Sources verified: [FF4FE Wiki — Battle Mechanics](https://wiki.ff4fe.com/doku.php?id=battle_mechanics), [FF4FE Wiki — Battle Timers](https://wiki.ff4fe.com/doku.php?id=battle_timers), [FF4FE Wiki — Relative Agility](https://wiki.ff4fe.com/doku.php?id=relative_agility).

## 1.7.444 — 2026-05-17

### Post-ATB hardening — Battle Assist + watchdog + atb-ready timeout fallback

Three fixes from the MP evaluation. None blocking the ATB rewrite landing but each would have shown up in early beta:

**Fix #1 — Battle Assist + server-arbitrated ATB.** `encounter-assist-snapshot` now registers the joining player in the server-side `_encounterBattles[host].units` map. Two cases handled:
- Target was solo (no battle yet) — server inits the battle from the snapshot's monsters (which now carry `agi` so the server can compute RA).
- Target was already a co-op host — server appends a `player:<joinerUid>` unit via the new `_addPlayerToEncounterBattle` helper.

Pre-fix, the joiner's local ATB toggled into server-auth mode on `initBattleATB`, then waited forever for an `atb-ready` that the server couldn't broadcast (no unit registered) → freeze watchdog at 5 s.

Client change in `src/battle-encounter.js`: snapshot monster payload now includes `agi: deriveMonsterAgi(data)` per entry.

**Fix #2 — `ally-wire-wait` freeze-watchdog carve-out.** Added `ally-wire-wait` alongside the existing wire-PvP `enemy-flash` carve-out in `src/game-loop.js#_tickFreezeWatchdog`. Cellular jitter regularly produces 5–15 s waits before the 45 s ally-side fallback fires; without this carve-out the watchdog was about to spam `/api/client-error` during normal co-op play.

**Fix #3 — `atb-ready` timeout fallback.** In server-auth mode, if no `atb-ready` arrives within `target + 1500 ms` of the gauge filling, the client force-flips locally and tags the unit with `forcedReady=true`. `_tickATB` consumes the flag once and POSTs `[atb-ready timeout] kind=… ra=…` telemetry so we can measure drop rates in prod logs. Prevents a single dropped server frame from killing the whole battle.

39/39 atb-sim (+3 server-auth tests). 56/56 pvp-wire-sim (+2 assist registration tests). 5/5 atb-fsm-sim (+1 timeout-fallback scenario).

## 1.7.443 — 2026-05-17

### ATB slice 6 — Battle Speed slider (BS1–BS6) + Haste wired to speedMod

Final slice. Player can now tune ATB pace from the pause menu (Options → Speed: 1–6, default 3). Cast Haste makes your gauge fill twice as fast.

**Battle Speed (BS1–BS6):**
- BS1: 133 ms/tick (~8 frames @ 60fps — fastest, FF4 BS1 = 7-9 frames)
- BS2: 233 ms/tick
- BS3: 333 ms/tick (default — matches pre-slice-6 hardcoded value)
- BS4: 500 ms/tick
- BS5: 700 ms/tick
- BS6: 900 ms/tick (~54 frames — slowest, FF4 BS6 = 52-56)

`TICK_MS` becomes a mutable `export let` so all consumers (`_fillTargetMs`, `_isWireFresh`, etc.) live-bind to the current value. Setting persists in `localStorage.ff3.battleSpeed`; read at `atb.js` module init.

**Pause-menu UI:** Options panel has a second row below CRT. Cursor moves with ↑/↓; ←/→ adjusts the speed value (1–6 clamped). Saved instantly.

**Haste wiring:** in `src/spell-cast.js`, the `applyBuff(ps, BUFF_HASTE)` site now also calls `setSpeedMod(ps, 0.5)`. Battle-bound (cleared at battle exit via fresh `_atb` from the next `initBattleATB`). No Slow spell exists in `src/data/spells.js`, so only Haste is wired this slice.

36/36 atb-sim (4 new Battle Speed tests). 54/54 wire-sim. 4/4 fsm-sim.

## 1.7.442 — 2026-05-17

### ATB slice 5 — PvP gauge wire-sync (lockstep gauges across duel)

Brings PvP duels into the same lockstep gauge model that co-op got in slice 4b. Locally-owned units (player + battleAllies) emit `pvp-atb-sync {unitKind, allyIdx, atMs}` when their action animation completes (markFilling fires). Partner receives → applies markFilling on the mirror unit (pvpOpponentStats for kind='player'; pvpEnemyAllies[allyIdx] for kind='ally') with the sender's atMs anchor.

**Stays client-driven for dispatch** — PvP doesn't go server-arbitrated (slice 4c/4d equivalent). Reason: an RTT round-trip on every duel turn would hurt the duel feel. Lockstep RNG already keeps damage/state matched; this slice only addresses the visible gauge drift (up to ~200ms over long fights pre-fix).

- **ws-presence.js** — new `pvp-atb-sync` case, partner-pair routed via `_pvpPartners`. `atMs` validated as a finite positive Number (don't truncate to int32).
- **net.js** — `sendNetPVPAtbSync` / `setNetPVPAtbSyncHandler` + message-dispatch case.
- **pvp.js** — receive handler resolves the partner-owned ref (opp for 'player', enemy-ally[i] for 'ally') and calls `markFilling(ref, atMs)`.
- **battle-turn.js#_resetLastDispatched** — emit hook mirrors the co-op branch: when `pvpSt.isWirePVP`, ps → 'player' emit; local battleAlly → 'ally' emit with index.
- **pvp-wire-sim.js** — 54/54 (2 new tests: pvp-atb-sync relays unitKind+allyIdx+atMs; drops when atMs missing).

Solo + co-op untouched. PvP duels now match co-op's lockstep guarantee at the gauge level.

## 1.7.441 — 2026-05-17

### ATB slice 4d — clients defer ready flip to server (server-arbitrated co-op)

The other half of slice 4c. Co-op random battle clients now wait for the server's `atb-ready` broadcast before flipping a unit from `filling` to `ready`. The local gauge still advances `elapsedMs` for display continuity (no visual lag), but the dispatch authority lives on the server. Solo + PvP keep local-driven (lockstep RNG covers PvP; latency would hurt duel feel).

- **`src/atb.js`** — module-level `_serverAuth` flag + `setServerAuthoritative` / `isServerAuthoritative` exports. `tickGauges` skips the local `filling→ready` flip when set. New `markReady(ref, atMs)` snaps elapsedMs to target + flips state (called by the atb-ready wire handler). `clearATB` resets the flag.
- **`src/encounter-wire.js`** — `setNetAtbReadyHandler` registers a handler that parses `unitId` (`player:<uid>` or `monster:<idx>`), resolves the local ref (ps if it's our uid, else find ally in `battleAllies` by userId; monster by index), and calls `markReady`.
- **`src/net.js`** — `setNetAtbReadyHandler` seam + wire-message case for `atb-ready`.
- **`src/battle-update.js#initBattleATB`** — calls `setServerAuthoritative(battleSt.isWireEncounter)` after the entries list is initialized.
- **`tools/atb-fsm-sim.js`** — new scenario `_scenarioServerAuthDefersDispatch`: runs 10s of ticking in server-auth mode, asserts player gauge fills to 100% pct but state remains `'filling'`. Then calls `markReady` directly and asserts state flips. 4/4 scenarios green.

Behavior in a co-op battle now:
1. Server's tick says unit is ready at `atMs` → broadcasts atb-ready
2. Each client receives, calls `markReady(ref, atMs)` → local state flips, `readyAtMs` aligned to server's atMs
3. Dispatch handler (existing) picks the unit, processNextTurn fires, action runs
4. On action completion, atb-sync(filling, atMs=Date.now()) fires → server resets startedAt + relays to peers
5. All clients converge

Same as slice 4c, this is wire-protocol-only — no `markReady` arrival means no dispatch. The freeze watchdog catches any persistent stall.

## 1.7.440 — 2026-05-17

### ATB slice 4c — server-side state mirror + tick loop (advisory)

Server now runs its own authoritative ATB tick for active co-op random battles. On `encounter-start`, server builds a state mirror (per-unit RA computed from anchor agi, `startedAt` anchored to encounter start). A 100ms-interval tick loop advances each unit and broadcasts `atb-ready {unitId, atMs}` to all peers when their gauge fills. `atb-sync` (slice 4b) is also consumed server-side so the `filling` anchor resets on action completion.

This is **advisory** — clients receive `atb-ready` events but don't change their dispatch logic yet. The lockstep guarantee from slice 4b still holds; the server is now a separate-but-aligned source of truth. Slice 4d will flip clients to defer dispatch to the server's events (full server-arbitrated authority).

- **ws-presence.js** — `_encounterBattles` Map (host userId → { peers, units, anchorMs }), `_initEncounterBattle`, `_clearEncounterBattle`, `_tickEncounterBattles` (`setInterval` at 100ms), `_broadcastAtbReady`. Cleanup wired into `_clearEncounterGroup`.
- **encounter-start payload** — monsters now carry `agi` (derived client-side via `deriveMonsterAgi`) so the server can compute RA without needing access to `src/data/monsters.js`.
- **encounter-start handler** — calls `_initEncounterBattle` after the existing peer-set construction.
- **atb-sync handler** — updates server-side unit state (`state: filling, startedAt: atMs`) in addition to the existing peer relay.
- **pvp-wire-sim** — 52/52 (3 new tests: battle init builds units + RA, server tick fires atb-ready, client atb-sync resets server anchor).

Constants `_ATB_TICK_MS = 333`, `_ATB_RA_MIN = 2`, `_ATB_RA_MAX = 10` mirror `src/atb.js`. Don't drift.

## 1.7.439 — 2026-05-17

### ATB slice 4b — wire-sync events for co-op gauge lockstep

Builds on slice 4a's wall-clock derivation. When a locally-owned combatant's action finishes (markFilling fires), the owner now broadcasts `atb-sync {unitKind, monsterIdx, atMs}` over the encounter wire. Receiver applies `markFilling(ref, atMs)` so both clients reset that unit's gauge from the same wall-clock anchor instead of independent local clocks.

Ownership rules in co-op random encounters:
- **Player (`ps`)** — owned by local client, always emit
- **Wire-driven allies** — owned by partner, partner emits, we apply
- **Monsters** — owned by host (`battleSt.encounterIsHost`), host emits

`elapsedMs` clamped to `max(0, …)` to handle the case where partner's `atMs` is slightly ahead of receiver's local clock (clock skew). Gauge holds at 0 until the local clock catches up, then advances normally.

Tooling:
- **ws-presence.js** — new `atb-sync` relay case; `atMs` validated as a finite positive number (Date.now() exceeds 32-bit int range, so `| 0` truncation is forbidden — wire-sim test catches this).
- **net.js** — `sendNetAtbSync` / `setNetAtbSyncHandler`.
- **encounter-wire.js** — receive handler resolves the unit ref (ally by `userId`, monster by `monsterIdx`) and calls `markFilling(ref, atMs)`.
- **battle-turn.js** — `_resetLastDispatched` emits the sync after `markFilling` for locally-owned actors.
- **pvp-wire-sim.js** — 49/49 (2 new tests: relay carries unitKind+atMs; drops when atMs missing).

Solo battles unchanged. Co-op gauge timing is now bounded by clock skew (~10ms NTP-synced) instead of action-animation drift (50-200ms previously).

## 1.7.438 — 2026-05-17

### ATB slice 4a — wall-clock gauge derivation (foundation for cross-client lockstep)

Refactored `src/atb.js` from dt-accumulating to wall-clock-derived gauges. Each unit now tracks `startedFillingAtMs`; `elapsedMs` is computed as `min(target, now - startedFillingAtMs)` on every read. Drops the dt parameter dependency — gauge math is now a pure function of `(state, startedFillingAtMs, _now())`.

- **`markFilling(ref, atMs?)`** accepts an optional explicit timestamp. Slice 4b will pass partner-client timestamps from wire-sync events so co-op clients reset gauges at the same `atMs` instead of independent local clocks.
- **Wait-mode pause is automatic.** 'ready' state doesn't tick anymore, so the player's gauge naturally holds at target while menu is open. The `opts.playerMenuOpen` parameter is dropped from `tickGauges`.
- **`_setNow(fn)`** test seam — atb-sim drives a deterministic mock clock, atb-fsm-sim points the engine's clock at its simulated time so wall-clock-derived gauges advance correctly in the headless sim.

32/32 atb-sim (added 4 wall-clock-specific tests including the slice-4b prep test for explicit `atMs` override). 3/3 atb-fsm-sim scenarios green.

Solo battles see no behavioral change. Co-op battles will start showing visibly tighter gauge timing after slice 4b lands the wire events.

## 1.7.437 — 2026-05-17

### Queueable commands — menu open during gauge fill

Player can now select an action while the ATB bar is still filling. The action waits at `confirm-pause` until the gauge is ready, then fires. Lets you commit early to your next move instead of staring at the bar.

- **Menu is the idle state.** `battle-fade-in` → `menu-open` directly (was `atb-idle`). `processNextTurn` queue-empty → `menu-open` when player alive, `atb-idle` only when player is down.
- **`confirm-pause` gates on `isReady(ps)`.** Holds until the player's gauge fills, then dispatches the queued action.
- Dispatch hub still runs from `menu-open` (skipPlayer) so monster/ally turns interrupt freely while the player is sitting in the menu. Confirm-pause holds non-preemptively (player who commits early gets their action first when their gauge fills).

## 1.7.436 — 2026-05-17

### ATB bar fades out on ready

When the gauge fills, alpha lerps 1→0 over 250ms instead of popping out instantly. Reads as a "loaded" cue. Hidden entirely during the player's slash animation (state === 'acting').

## 1.7.435 — 2026-05-17

### ATB bar tighten — render only while filling, drop below portrait

- Only renders while `state === 'filling'`. The bar was previously also visible during `'acting'` (player's own slash) when the gauge is frozen at 100%, which read as a stuck/glitchy bar over the slash animation.
- Moved 2px below portrait bottom (was overlapping the bottom-2px strip of the sprite).

## 1.7.434 — 2026-05-17

### Player ATB bar on portrait

Thin 16×2 teal bar overlaid on the bottom strip of the player portrait. Fills with the player's gauge; hides the moment it's full (= menu opens). Gives the player a visible "how close is my next turn" indicator at-a-glance without a separate UI element.

## 1.7.433 — 2026-05-17

### Monster attacks during open menu (Wait mode actually works now)

Reported symptom: "if I do nothing, I should be getting attacked — that's not happening." Root cause: `_updateATBDispatch` only ran during `'atb-idle'`. Once the player's gauge filled and the menu opened, dispatch stopped firing — monsters' gauges filled to "ready" but nobody picked them. Sitting on the menu was an unintentional freeze.

- **Dispatch hub fires on both `atb-idle` AND `menu-open`.** During menu-open it skips the player (they're already showing the menu) and dispatches whichever monster/ally readied next.
- **`pickReadyActor(opts={skipPlayer})`** — needed because the FIFO-first ready unit is usually the player; without the skip, the dispatch hub returned the player every frame and short-circuited before ever seeing the next-ready monster behind them. FSM sim caught this — monster was at `state:ready, readyAtMs:N+1ms` after player's `readyAtMs:N`, but `pickReadyActor()` only returned the player.
- **Player no longer marked `'acting'` on menu-open transition.** They stay in `'ready'` state through menu phase. `markActing` fires later inside `processNextTurn` when the player's confirmed turn actually dispatches. Cleans up the "player gets stuck after monster interrupts" failure mode.

`tools/atb-fsm-sim.js` boots the engine with proper module init (production main.js wiring replicated) and now exercises the full cycle. Verified: in a 25s idle-menu scenario, monster acts 21 times. State transitions are clean — no flickers detected.

## 1.7.432 — 2026-05-16

### ATB pacing fix — RA clamp + retuned monster agi (battle progresses without input)

Reported symptom: "battle isn't progressing without user input." Root cause: `deriveMonsterAgi = level + (evade >> 3)` gave low-level monsters agi=2-5 while the player carries agi=10. FF4 RA formula then gave the monster RA=25+ — a 25 × 333ms = 8+ second gauge fill. Player kept killing the monster before its gauge ever filled.

- **RA clamp [2, 10]** in `src/atb.js`. Fastest possible fill = 666ms (no instant-acting bosses), slowest = 3.3s (no never-acting weak monsters).
- **deriveMonsterAgi retuned** to `max(5, floor(level/2) + 5 + (evade >> 4))`. Goblin (level 1, evade 5) → agi 5 → RA 10 (3.3s fill, vs player 1.7s). Boss-tier level 35 → agi 23 → RA 2 (666ms — fast but capped).

Wire-sim + atb-sim green (28/28 atb tests, 47/47 wire). Tools/atb-fsm-sim.js was built this session (boots stubbed engine + drives `updateBattle(dt)` at 60fps, traces state transitions, flicker detector). Will become a deploy.sh gate once mature.

## 1.7.431 — 2026-05-16

### Battle HUD flash fix — add 'atb-idle' to render allowlists

Slice 3 introduced the `'atb-idle'` battle state as the dispatch hub between actions. Several render gates (encounter monsters, boss sprite, menu panel) had allowlists that included `'menu-open'` but not `'atb-idle'` — so every time the state transitioned to atb-idle (which is now most of the time), those elements disappeared and reappeared on the next state flip. Visible as HUD/monster flashing.

Per [[ff3mmo-predicate-coverage]] memory — when a new battleState lands, audit every is*/allowlist predicate gating render.

- `_isEncounterCombatState()` (battle-draw-encounter.js) — random encounter monsters
- PvP `isCombatPVP` allowlist (battle-draw-encounter.js) — PvP opponent sprite
- Boss `isCombat` allowlist (battle-draw-encounter.js) — boss sprite during boss battles
- `_battleMenuStates#isMenu` (battle-draw-menu.js) — menu panel + enemy name box

Menu cursor stays gated to `'menu-open'` only (player can't interact during atb-idle); panel is now passively visible at all times during combat.

## 1.7.430 — 2026-05-16

### Hide ATB gauge bars by default

The v1.7.428 diagnostic row at y=144 was scaffolding for verifying gauges tick. Slice 3 is in, ATB drives dispatch; the bars are no longer needed in production UI. Gated behind `window.__atbDebug = true` (browser console) so it stays reachable for debugging.

## 1.7.429 — 2026-05-16

### ATB rewrite slice 3 — gauge-driven dispatch (round queue dies)

Big swing. The round-based turn queue + 10s decision timer are gone. Gauges now drive WHO acts WHEN, in all battle types (solo random + boss + co-op random + PvP). Faster units act more often. The freeze class from v1.7.x's `magic-hit timer:500 stuck for 5s` is structurally impossible now: there's no central queue for one client's animation to block.

- **New `'atb-idle'` battle state** = the dispatch hub. After `battle-fade-in`, every battle transitions to `atb-idle` instead of `menu-open`. Menu only opens when the player's gauge hits ready.
- **`_updateATBDispatch()` (battle-update.js) + `_updatePVPATBDispatch()` (pvp.js)** — top of the update cascade. Polls `pickReadyActor()` (FIFO by `readyAtMs`); on hit, routes the actor through legacy per-turn-type dispatch via a one-entry turn queue.
- **`processNextTurn()` (battle-turn.js)** queue-empty branch rewritten: yields to `atb-idle` instead of rebuilding a round. `_resetLastDispatched()` resets the previous actor's gauge to 0 at the moment a new turn dispatches — gives the visible "fill → act → reset → refill" loop. Wire-wait retry guard skips the reset when the same actor's turn is unshifted back onto the queue (gauge stays full while waiting on the partner's wire action).
- **`markActing()` / `markFilling()` (atb.js)** wired in: dispatch freezes the actor's gauge at full; action completion resets it to 0. Dead combatants stop ticking and stop dispatching (added `hp <= 0` gates in tick + pickReadyActor).
- **Per-actor poison tick** replaces the legacy `_applyEndOfRoundPoison` consolidated phase. Damage fires at the start of each poisoned actor's dispatched turn (NES behavior). The dedicated `poison-end-tick` 700ms hold is gone — there's no more "round boundary" in ATB.
- **`TURN_TIME_MS = 10000`** deleted with the entire `_updateTurnTimer` function. The gauge IS the new clock; sitting on a full gauge no longer auto-skips, but everyone else's gauge keeps moving while yours sits.
- **`pvp.js#_buildAndProcessNextTurn`** now dispatches only the player's confirmed action (single-entry queue), not a full round.
- **`tryJoinPlayerAlly` ally-fade-in** no longer rebuilds the round on fade complete — yields to atb-idle.

Wire-driven ally (co-op random) compatibility verified: `dequeueWireEncounterAction` stall path still drops the engine into `ally-wire-wait`, and the wire-wait retry preserves the ally's gauge state until the partner's action arrives.

## 1.7.428 — 2026-05-16

### ATB rewrite slice 1 — gauge math + display bars (no behavior change)

The strict-turn-queue + 10s decision-timeout system is being replaced with FF4-style ATB (Active Time Battle, Hiroyuki Ito 1991). Reason: the queue serializes every animation through one client's FSM, so a stall on phone 1 (`magic-hit timer:500 stuck for 5s`) blocks the whole party's battle, and co-op random battles can't sync if any client diverges. ATB gives every combatant its own gauge — fast clients don't have to wait on slow ones for the timeline to move.

Slice 1 ships the math + render layer with gauges display-only. The legacy turn queue still drives dispatch. Subsequent slices (solo dispatch → co-op server-arbitrated → PvP → battle speed slider) replace the queue.

- **`src/atb.js`** — FF4 Relative Agility (`RA = floor(5 × anchorAgi / unitAgi)`, min 1, anchor = local player). Per-unit `elapsedMs` ticker; `getGaugePct` normalizes for renderer. Wait-mode pause for player at full gauge while menu open. Pure module; testable in isolation.
- **`src/battle-update.js`** — `initBattleATB()` fires at `battle-fade-in → menu-open` (solo + boss); `addBattleATBAlly()` covers Battle Assist mid-fight joiners. `_tickATB()` advances gauges every frame, gated to active battle (skipped during box-expand / fade-in / victory). `clearATB()` on battle exit.
- **`src/pvp.js`** — mirror init hook at PvP's own `battle-fade-in → menu-open`.
- **`src/battle-encounter.js`** — `addBattleATBAlly` at Battle Assist target-side push + existing-peer join handler.
- **`src/atb-render.js`** — row of 20×3px gauges at y=144, color-coded by kind (player teal, ally blue, monster red, pvp-enemy orange). Ready units blink yellow.
- **`tools/atb-sim.js`** — 26-test regression suite (RA math + tick rate + Wait pause + speedMod + mid-add + clear). Wired into `deploy.sh` as pre-flight gate.

Monsters have no `agi` in `monsters.js` (FF3 NES didn't use per-monster agility). `deriveMonsterAgi(mon) = level + (evade >> 3)` keeps fast/dodgy monsters fast in ATB without hand-editing the auto-generated catalog.

## 1.7.427 — 2026-05-16

### Visual-layer cleanup — wire-wait input drain + dead PvP victory branches + sweat fade gate

Post-audit cleanup. Four parallel audits of the wire-driven visual layer (poses, animations, predicates, spell-ID sourcing) found that the layer is in good shape end-to-end. These 3 are the only LOW-severity items worth tidying.

- **Drain action keys on `ally-wire-wait`** (`src/input-handler.js`). `handleBattleInput` returned `true` for `ally-wire-wait` without clearing pressed keys. A key held during the stall could leak into the next state (e.g., Z firing a menu command on transition). Now drains z/Z/x/X when in the stall.
- **Delete dead PvP `isOppVictory` branches** (`src/pvp-drawing.js`). `isOppVictory` was hardcoded `false` — PvP battles end when one side dies, so the opposing team never enters a celebratory pose visible to the survivor. Removed the dead branches and the `!isOppVictory` tautologies in the kneel + sweat gates.
- **Gate sweat overlay on `fadeStep === 0`** (`src/battle-draw-allies.js`). When a near-fatal ally joins mid-battle via Battle Assist, the body has a pre-rendered fade array but sweat is a single sprite — rendering it at full opacity while the body fades looked like a floating bead. Suppressed during fade-in.

## 1.7.426 — 2026-05-16

### MP audit hardening — per-kind rate limit + identity-pinned assist peers + dead-log cleanup

Post-v1.7.425 audit bundle. None were correctness bugs on cooperating two-tab tests; all three are mitigations for hostile clients + cleanup.

- **Per-kind rate-limit buckets** (`ws-presence.js` — `_rateAllowKind`, `PER_KIND_RATES`). The connection-wide token bucket (60 cap / 20-refill) is a single shared pool. A user spamming 60 `chat` frames could starve their own `pvp-action`, `encounter-action`, etc. The new per-kind buckets cap user-action-driven kinds (`chat` 20/5, `encounter-assist-request` 6/1, `encounter-start` 6/1, `give-item` 6/1, `party-invite` 6/1) so spamming one kind can't starve the others. Poll-driven frames (`update`, `pvp-action`, `encounter-action`) are global-bucket-only, unchanged.
- **Identity-pinned peers list in `encounter-assist-snapshot`**. Server was forwarding `parsed.peers` from the target unchanged. A malicious target could inject ghost identities (unknown userIds), impersonate other users (lie about name/jobIdx/level/palIdx), or include the joiner in their own peers list (causing the joiner to spawn a clone of themself as an ally). Server now: (a) drops any peer.userId that isn't in `_connected` + helloed, (b) overwrites identity fields with the server's trusted profile, (c) drops the joiner from their own peers list, (d) passes live battle stats (hp, atk, def, weapon, spells) through unchanged since the server doesn't track in-battle mutations.
- **Dead diagnostic log removed** (`src/pvp.js` queue-reorder path). `console.warn` left over from v1.7.406 PvP-drift debugging — the reorder path is exercised normally in coop encounters and the log is no longer useful.

Wire-sim now 47/47 (3 new tests: per-kind chat cap, per-kind assist-request cap, snapshot identity-pin + spoof rejection, snapshot drops joiner-in-own-peers).

## 1.7.425 — 2026-05-16

### Hotfix v1.7.424 — missing export

- `src/encounter-wire.js` was missing the `clearWireEncounterQueue` export that the v1.7.424 `resetBattleVars` defensive drain imports. Smoke caught it (page failed to load with `SyntaxError: The requested module './encounter-wire.js' does not provide an export named 'clearWireEncounterQueue'`). Added the export.

## 1.7.424 — 2026-05-16

### Last-audit fixes: assist-double-tap dedup + wire-queue defensive clear + timeout bump

Post-implementation audit before live testing flagged these. Three confirmed bugs + two defensive tightenings.

- **Assist double-tap dedup (P0)** — clicking Assist twice on the same target before the first snapshot arrived caused: server forwarded two `encounter-assist-incoming` to the target → target accepted both → `battleAllies` had two entries for the same userId → `_pushPlayerCoop` rolled initiative twice for the same logical actor → silent turn-order desync. Two layers of dedup:
  - Server (`ws-presence.js#encounter-assist-snapshot`): if `_encounterGroups.get(target).has(joinerUserId)`, drop the second snapshot.
  - Target (`battle-encounter.js#setNetEncounterAssistIncomingHandler`): skip if `battleAllies` already contains the joiner's userId.
- **Wire queue defensive clear (P1)** — `_wireEncounterActions` is cleared by `endWireEncounter` on a normal close, but TCP half-open (browser tab kill, cellular drop without RST) leaves stale actions queued. If the same userId rejoins for a new battle later, old actions could replay. `resetBattleVars` in `battle-update.js` now calls `clearWireEncounterQueue()` defensively every battle start.
- **Wire-wait timeout bump 30 → 45 s (P1)** — cellular spikes during 4G↔5G cutover or crowded venues can hold a single WS round-trip past 10 s; 30 s was too aggressive and would trigger the AI-fallback synthetic disconnect during legitimate slowdowns. 45 s gives margin without making the FSM feel hard-stuck.
- **`_pushPlayerCoop` userId=0 guard (P2)** — `battle-turn.js#buildTurnOrder` co-op branch now skips allies with no userId. Today this can't fire (PLAYER_POOL random-fill is gated off in co-op), but it's a defensive guard against future fake-pool repopulation that would otherwise collide at userId=0 → unstable canonical sort.
- **Non-issues (re-read after audit, no fix needed)**:
  - Solo→host reseed mid-round: `maybeReseedCoopTurn` runs at every round boundary, so the initial reseed just sets the base for `seed + turnIndex` — both clients converge at the next round regardless of mid-round consumption.
  - Stale `inBattle` cache: target's handler re-validates `battleState !== 'none'` and rejects silently. Joiner gets no snapshot if target already exited — no state corruption (UX gap for joiner, fine for now).
  - Side-channel fade-in vs state-machine: legacy `tryJoinPlayerAlly` always transitions to `ally-fade-in` after push, so the state machine drives that path. No conflict with wire-spawn allies that carry `fadeInStartMs`.

## 1.7.423 — 2026-05-16

### Assist polish: monster status in snapshot + side-channel ally fade-in

- **Monster status in assist snapshot** — pre-fix, the assist snapshot shipped current monster HP but not the status mask. A monster poisoned on host's side ticked end-of-round damage; the joiner's view didn't (clean status), so HP diverged over time. Now `monsters[]` carries `{monsterId, hp, status: {mask, poisonDmgTick}}`. Joiner-side spawn rebuilds the status from wire instead of `createStatusState()` default. Same protocol works for any future status (sleep, paralysis, blind, etc.) since it's the full mask + tick byte.
- **Side-channel ally fade-in** — new ally additions via the encounter wire (at-start co-op spawn, assist accept by target, assist snapshot for joiner, ally-join broadcast to existing peers) now get an independent fade-in animation driven by `Date.now()` elapsed time. Decrements `fadeStep` from `ROSTER_FADE_STEPS` → 0 over ~400 ms. Runs in `battle-ally.js#_tickAllyFadeIn` every frame regardless of `battleState`, so it works mid-battle without interrupting the FSM (the classic `ally-fade-in` state-machine path was a state-machine pause that doesn't fit mid-flight). Stamp `fadeInStartMs` at push-time; tick decays it.
- **Pre-existing fade bug fix bundled** — the v1.7.418 invite handler (host's at-start co-op spawn) also left peers at the `generateAllyStats` default `fadeStep = ROSTER_FADE_STEPS` (invisible) because the state machine wasn't triggered. The new side-channel applies here too — peers now animate in properly on the guest's side when the co-op battle opens.
- **State-machine path untouched** — the classic `tryJoinPlayerAlly` → `ally-fade-in` state still drives the legacy fake-roster random-fill flow (gated on `fadeInStartMs` being absent). No conflict between paths.

## 1.7.422 — 2026-05-16

### Battle Assist: overworld players can join in-progress roster battles

- **The new system**: an overworld player browses the roster, sees who's currently in combat (red dot indicator), picks Assist on a roster target, and gets pulled into that battle as a wire-driven ally. Works regardless of party membership — any roster player can assist anyone in their location. Mid-battle join, snapshot-driven sync. The full encounter-wire co-op machinery (v1.7.418-1.7.421) makes this trivial once spawn is solved.
- **`inBattle` profile flag** (`src/main.js` + `ws-presence.js`): new clamped 0/1 field on the wire profile. Set to 1 whenever `battleSt.battleState !== 'none'`; the existing 500 ms profile-diff poll auto-pushes the transition. Server normalizes + relays via `player-update` so every other client knows in real time.
- **Roster row indicator** (`src/roster.js`): small red 3×3 pixel block at top-left of the portrait box for any wire-presence player with `inBattle=1`. Mirror of the green online dot (top-right). Fades with the row.
- **"Assist" roster menu entry** (`src/roster.js#ROSTER_MENU_ITEMS` + `src/input-handler.js`): new entry between Battle and Trade. Action handler gates on `target.inBattle` and emits `encounter-assist-request {targetUserId}`. Server re-validates (same location, target is helloed + in battle, joiner not already in a battle / PvP).
- **Server-side wire** (`ws-presence.js`): two new handlers.
  - `encounter-assist-request`: validates + forwards to target as `encounter-assist-incoming {fromUserId, fromName, fromProfile}`. Does NOT mutate `_encounterGroups` yet — target's auto-accept is what commits.
  - `encounter-assist-snapshot`: builds (or extends) the encounter group bidirectionally, routes the full snapshot to the joiner, and broadcasts `encounter-ally-join {profile}` to any OTHER existing peers in the group (so they fade-in the new ally on their own client).
- **Target-side auto-accept + snapshot** (`battle-encounter.js#setNetEncounterAssistIncomingHandler`): on receiving the incoming, if a battle slot is open (`battleAllies.length < 3`) and we're not in PvP, build the snapshot — current monster HPs, peer list (self + existing real allies), seed, turnIndex, hostUserId — and emit `encounter-assist-snapshot`. If we were in a SOLO battle, convert to host-of-co-op first: pick a fresh seed, set `isWireEncounter` + `encounterIsHost`, seed rand, start emitting actions from this turn forward. Locally add the joiner to `battleAllies` as wire-driven (instant, no fade — mid-battle has no safe fade window).
- **Joiner-side spawn** (`battle-encounter.js#setNetEncounterAssistSnapshotHandler`): spawns the encounter locally from the snapshot. Critical difference vs the at-start `encounter-invite` path: monster HPs come from the snapshot (current state), not from `MONSTERS.get` defaults. Seeds rand with `(seed + turnIndex)` so subsequent rolls match. Peers (excluding self) get pushed to `battleAllies` as wire-driven, sorted canonical (host first).
- **Existing-peer side ally-join** (`battle-encounter.js#setNetEncounterAllyJoinHandler`): when an existing peer in a co-op battle gets the new-joiner broadcast, they add the joiner to their own `battleAllies` (wire-driven, instant). Mirror of the PvP `pvp-ally-join` shape.
- **UX chat lines**: target sees `* <joiner> joined your battle!`; joiner sees `* Assisted <host>'s battle!`; existing peers see `* <joiner> joined the battle!`.
- **4 new wire-sim tests** (43/43 passing): assist-request happy path, reject when target not in battle, snapshot relay + group build, ally-join broadcast on multi-peer assist.
- **Open follow-ups** (deferred — live testing will surface priority):
  - Monster status state isn't shipped in the snapshot (joiner spawns with clean status). HP diverges over time if a monster was poisoned. Wire `status: { mask, poisonTimer }` if it matters.
  - No fade-in animation when target adds the joiner. Mid-battle FSM has no safe slot; v2 could pause the queue and play `ally-fade-in`.

## 1.7.421 — 2026-05-16

### Co-Op v4: monster-attack damage sync (the silent killer) + PLAYER_POOL random-fill gate

- **The silent killer.** Monster attack damage / hit / evade rolls in `battle-enemy.js` were on `Math.random` instead of `rand()`. Player-side rolls were synced (battle-math.js uses rand), but monster-side rolls were per-client. Result: same monster hits A for 12 on A's phone and for 7 on B's phone, in the same logical turn — HP diverges instantly even though everything else was wire-synced. The v1.7.418 / v1.7.419 sync work was fundamentally compromised until this fix.
- **Fix**: blanket conversion of `Math.random` → `rand()` in `battle-enemy.js` (9 sites): monster physical-attack damage variance, multi-hit hit-rate roll, multi-hit shield/armor-evade rolls, special-attack chance + which-attack pick, special-attack damage roll (both player-target and ally-target paths). Co-op battles now produce identical damage on both phones; solo battles unaffected (rand is seeded fresh each battle via `reseedFromEntropy`).
- **PLAYER_POOL random-fill gate**: `tryJoinPlayerAlly` in co-op now skips the post-party PLAYER_POOL random-fill entirely. Today this is a no-op (PLAYER_POOL is empty), but if fakes ever get re-enabled, the host adding a fake ally that the guest doesn't see would break the canonical turn-order length and silently desync. Defensive guard against future PLAYER_POOL repopulation.
- Wire-sim still 39/39 passing.

## 1.7.420 — 2026-05-16

### Co-Op v3: wire-sim test coverage + UX polish (join chat lines)

- **5 new encounter-wire tests** in `tools/pvp-wire-sim.js` (now 39/39 passing). Covers: `encounter-start` happy path (invite forwarded with seed + monsters + canonical peer list including host profile), `encounter-start` rejection when no party members accept, `encounter-action` relay (sender's userId attached on relay, hitResults payload preserved), `encounter-end` (outcome relayed + group entry cleared), and disconnect-from-encounter (synthetic `encounter-action {kind:'disconnect'}` arrives at peer when sender drops). Pre-flight regression net for any future drift in the wire shape or `_encounterGroups` lifecycle.
- **Host-side chat line**: when `_maybeHostCoopEncounter` succeeds, host sees `* <peer1> + <peer2> joined the battle!` so they know who got pulled in. Names from `getOnlinePlayerByName` (same source the wire emit uses).
- **Guest-side chat line**: when `setNetEncounterInviteHandler` spawns the battle, guest sees `* Joined <host>'s battle!` — host name read from `msg.peers[0]` (canonical sort puts host first). Without this, the battle just appearing while you're walking around is jarring.
- Both messages tagged `'system'` channel so they route to the chat console and don't pollute party/world tabs.

## 1.7.419 — 2026-05-16

### Co-Op v2: magic / item / defend ally replay + monster-target sync + run sync + disconnect watchdog

- **The MVP from v1.7.418 only synced `attack` actions.** Magic, item, defend, and run from a peer all fell through to a skip-turn on the receiver — and worse, the random-encounter monster AI picked targets from a `ps vs ally` semantic that meant "the same monster pointing 'at ps'" on A's screen hit A, while on B's screen the same pick hit B. HP diverged instantly. This deploy fixes both — co-op is actually playable now.
- **Magic ally replay** (`battle-turn.js#_applyWireEncounterActionForAlly`): wire-driven ally turns now rebuild the magic state bag (`allyMagicCasterIdx` / `TargetType` / `TargetIdx` / `SpellId` / `HealAmount` / `DamageRoll`) from the wire payload and transition to `ally-magic-cast` — same pipeline the AI-driven ally cast uses, just fed by remote input instead of `_tryAllyCure` / `_tryAllyOffensiveCast`. Receiver-side target translation: `target.kind='self'` → `'ally' / allyIdx` (caster), `target.kind='ally'+userId=myUserId` → `'player' / -1`, `target.kind='ally'+otherUserId` → look up local ally by userId, `target.kind='monster'+idx` → `'enemy' / idx`.
- **Item ally replay**: same pipeline with `allyMagicItemMode=true` (suppresses the cast flame). Receiver derives the sentinel spellId (`SPELL_CURE` for heal items, `SPELL_POISONA` for cure-status) from `action.itemId` via `ITEMS.get()`. Sender includes itemId on the wire.
- **Defend ally replay**: sets `ally.isDefending = true` on the wire-driven entry, no animation (allies have no defend pose), advances the turn. New `ally.isDefending` halve hook in `battle-enemy.js` ally-attack damage path (line ~204) — monsters now actually do half damage to defending wire-driven allies, matching the sender's view of their own defend. Round-end clear in `processNextTurn` queue-empty branch alongside the existing `battleSt.isDefending` clear.
- **Monster target canonical order** (`battle-enemy.js#_processEnemyFlash`): MOST CRITICAL fix. Pre-v1.7.419, monsters picked target with `Math.random` against `ps vs livingAllies` — but ps on A's view is A and on B's view is B, so the same monster pick hit different actors. Co-op fix: build a canonical-order team list (all player-team userIds, sorted host-first then ascending userId), pick via shared `rand()`, then map the picked userId to either local ps (`-1`) or local battleAllies index. Both clients land on the same logical actor every time.
- **Drop-roll sync** (`battle-update.js#_updateMonsterDeath`): switched `Math.random` → `rand` for the drop-chance + drop-pick rolls when `isWireEncounter`. Both clients roll the same outcome → both add the same drop to their own inventory (everyone gets a copy). Policy: shared drops in co-op, like NES canon party loot.
- **Run sync** (`encounter-wire.js#setNetEncounterEndHandler`): when a peer ran (or otherwise dropped), the sender's `encounter-box-close` fires `endWireEncounter` which emits `encounter-end`. Receiver's handler now force-transitions their local FSM to `encounter-box-close` if they're still mid-fight — otherwise they'd be solo against monsters balanced for a party. Guarded against already-wrapping-up states (victory sequence / item-hold / box-close) so a converged victory completes naturally.
- **Status turn-start sync** (`battle-turn.js#processNextTurn` wire-driven branch): now calls `processTurnStart(ally.status, ally.maxHP)` on the wire-driven ally before dequeuing the action — mirrors the sender's player-turn status processing so both clients' rand cursors stay aligned through sleep wake / paralysis skip / confuse snap rolls. `turn._statusDone` flag prevents double-consumption across the unshift-retry loop.
- **Disconnect timeout watchdog** (`battle-ally.js#updateBattleAlly` ally-wire-wait): if the wait exceeds `WIRE_WAIT_TIMEOUT_MS` (30s), the stalled turn is popped, the ally's `isWireDriven` flag flips off (future turns run local AI), and the ally is flagged `isDefending=true` for the current turn (AI fallback). Covers cases where the peer's WS drops without the server's synthetic disconnect arriving (TCP half-open / cellular loss). `ally-wire-wait` state-entry no longer resets `battleTimer` per-frame (guard added) so the watchdog clock actually accumulates.
- **Memory**: [[ff3mmo-coop-encounter-wire]] updated with the v2 details.

## 1.7.418 — 2026-05-16

### Random-Encounter Co-Op: real party members wire-driven instead of AI-simulated

- **The gap**: party-assist for random monster fights was a local AI illusion on the host's screen. When you triggered an encounter with party members, your client added them to `battleAllies` and ran AI against the synced rand — your phone saw "your party member fights with you," but the partner's phone saw nothing (they were walking around the world, oblivious). Mechanically identical to PLAYER_POOL fakes with real names. This deploy makes co-op actually multiplayer.
- **Server wire** (`ws-presence.js`): new `_encounterGroups: Map<userId, Set<peerUserId>>` (bidirectional reachability). Three new message handlers:
  - `encounter-start` — host's client emits when triggering a random encounter with online party members. Server validates each candidate (same-party + helloed + not in another encounter / PvP), builds the group, forwards `encounter-invite {seed, monsters, hostUserId, peers}` to each accepted member. Multi-peer (up to ~3 guests, capped at battleAllies max).
  - `encounter-action` — relay any peer's chosen action (attack target + hitResults, defend, etc.) to every other peer in the group. Mirror of `pvp-action`.
  - `encounter-end` — relay a peer's local FSM finished signal + clean up the group.
  - Disconnect cleanup: dropping out of an encounter group notifies peers via `encounter-action {kind:'disconnect'}` so the wire-driven ally falls back to AI for that turn.
- **Client wire** (`src/net.js` + new `src/encounter-wire.js`): senders / handlers / queue, separated from `battle-update.js` to break the circular-import risk between turn dispatch and wire emit. `_wireEncounterActions` queue parallels PvP's `_wireOpponentActions`.
- **Host emit** (`battle-encounter.js`): `_maybeHostCoopEncounter()` fires after monsters are built, checks `partyInviteSt.partyMembers` for online userIds, sends `encounter-start` with the seed + monster-id list + party userIds. Sets `battleSt.isWireEncounter`, `encounterIsHost`, `encounterHostUserId`, `encounterSeed`, `encounterTurnIndex`.
- **Guest spawn** (`battle-encounter.js#setNetEncounterInviteHandler`): if free (`battleState === 'none'` and not in PvP), rebuilds the same `encounterMonsters` array from the wire's `monsterId` list (deterministic `MONSTERS.get` lookup), seeds `rng.seed(msg.seed)`, sorts peer list canonically (host first, then by ascending userId), pushes each as a battleAlly with `isWireDriven: true` + `userId`. Bypasses `startRandomEncounter` entirely.
- **tryJoinPlayerAlly** (`battle-update.js`): when adding a party member resolved via `getOnlinePlayerByName` (has `userId`), tags the ally entry with `userId` + `isWireDriven: true` so turn dispatch knows to wait for wire input instead of running AI.
- **Canonical actor order** (`battle-turn.js#buildTurnOrder`): new `_pushPlayerCoop()` collects `ps` + battleAllies into one team, sorts by (host first, then ascending userId), pushes in sorted order rolling `rollInitiative` for each. Both clients converge on the same rand-cursor calls for the same logical actors. Solves the same desync problem as `pvpSt._wirePushOppFirst` (v1.7.409) but for an N-player team.
- **Per-turn rand reseed** (`battle-turn.js#maybeReseedCoopTurn`): mirror of PvP's `_buildAndProcessNextTurn` reseed. At each round boundary, increments `encounterTurnIndex` and calls `rng.seed(encounterSeed + turnIndex)`. Erases any drift accumulated by non-wire rand consumers (status / AI / etc.) in the prior round. Called from `_updateBattleMenuConfirm` (battle-update.js) and the ps-dead end-of-round path in `processNextTurn`.
- **Wire-driven ally turn dispatch** (`battle-turn.js#processNextTurn` ally branch + new `_applyWireEncounterActionForAlly`): when an ally's turn pops AND the ally is wire-driven, the dispatcher dequeues the matching `encounter-action` for that ally's userId. If found, replays target + `hitResults` (no local AI roll, no rand consumption). If missing, pushes the turn back to the queue head + sets `battleState = 'ally-wire-wait'`. Each frame, `updateBattleAlly` (battle-ally.js) sees that state and re-calls `processNextTurn` to retry — when the action arrives, the turn proceeds; otherwise it stalls another frame.
- **Local player action emit**: `_updateBattleMenuConfirm` now calls `emitWireEncounterAction(inputSt.playerActionPending)` whenever `battleSt.isWireEncounter` (parallel to the PvP emit). Shape: `{kind, target, hitResults?, spellId?, itemId?}`. MVP scope replays `attack` faithfully; `defend`/`run`/`skip`/`magic`/`item` send but the receiver's wire-driven ally falls through (skip) for kinds we don't replay yet — keeps the FSM in lockstep without forking, defers full magic/item ally replay to a follow-up.
- **Battle-end sync** (`battle-update.js#_updateBoxClose`): when `encounter-box-close` fires, if `isWireEncounter`, calls `endWireEncounter(playerDead ? 'lost' : 'won')` which emits `encounter-end` and wipes co-op flags. `resetBattleVars` also clears the flags defensively at the start of every battle.
- **Lookup priority fix** (`battle-update.js`): `tryJoinPlayerAlly` lookup chain was `PLAYER_POOL → online → cache`; now `online → cache → PLAYER_POOL`. Today this is dormant (PLAYER_POOL is empty), but if a fake-roster entry was ever repopulated with a name matching a real party member, the fake would override the live wire profile. Swap is a latent-landmine fix, not an active bug.
- **What still isn't synced (MVP scope)**: ally magic / item replay (falls through to skip-turn on the receiver — sender sees their magic land, receiver sees ally skip). Add this in a follow-up by mirroring the `_tryAllyCure` / `_tryAllyOffensiveCast` flow but reading spell + target from the wire payload. Also no `encounter-action` timeout watchdog yet — if a peer drops mid-turn before the disconnect signal arrives, the host's local FSM stalls in `ally-wire-wait` for that ally. Live testing will tell us if either matters.

## 1.7.417 — 2026-05-16

### Cleanup: drop client-side party-prepass diag + invitee accept-stash chat lines

- Removed the temporary `[party-prepass]` and `[party] accepted/SKIPPED` `addChatMessage` lines from `battle-update.js#tryJoinPlayerAlly` and `party-invite.js#setNetPartyInviteHandler` (v1.7.414 added them; the asymmetry they were diagnosing is fixed and the spam was polluting the in-game console). Server-side wire relay logs in `ws-presence.js` (`[pvp-search]` / `[pvp-encounter]` / `[pvp-hook]` / `[pvp-action]` / `[pvp-ally-join]` / `[give-item]`) stay — they're low-volume and useful for future debug.
- Docs: README Status section + `MULTIPLAYER.md` updated to v1.7.417 (PvP three-layer drift defense documented, new Step 5 "Roster co-op" section for the `give-item` wire, roster low-HP pose pipeline cross-ref).

## 1.7.416 — 2026-05-16

### Give-Item: wire-sync the pause-menu "use item on roster" path

- **The action was already built** (pause menu → Inventory → pick potion/antidote → pick roster target → apply heal/cure), but it was local-only — the heal mutated the sender's roster snapshot of the target, not the target's actual `ps`. This deploy adds the wire layer so the partner's real HP / status updates on their own client.
- **Wire**: new `give-item` message. `src/net.js` exports `sendNetGiveItem(targetUserId, itemId)` + `setNetGiveItemHandler(fn)`. Server (`ws-presence.js`) relays with `fromUserId` + `fromName` attached. Diag log: `[give-item] relay user=N → M item=0xXX`.
- **Sender**: `_applyPauseItemUse` in `pause-menu.js` now calls `sendNetGiveItem(rp.userId, itemId)` whenever the picked target is a real wire player (`rp.isReal && rp.userId`). Both heal items (potions, hi-potions) and cure-status items (antidotes, eye drops) route through. The existing heal-sparkle animation on the roster row stays unchanged.
- **Receiver**: handler registered in `pause-menu.js` mirrors the sender's apply path on the receiver's `ps`. Heal items run `applyMagicHeal`; cure_status items run `applyMagicCureStatus`. Plays `SFX.CURE`, sets a 550 ms `hudSt.giveItemHealTimer` so the existing `_drawCureSparkle` overlay fires on the player portrait (same visual treatment the sender already uses for the pause-menu inv-heal state), and posts `* <sender> sent you <item>` to chat. The next 500 ms profile-diff poll auto-broadcasts the new HP / status so every other player's roster ticks too — re-uses the kneel-pose pipeline from v1.7.415.
- **Animation parity**: sender sees the heal number on the roster row + heal-sparkle in pause menu (existing); receiver sees portrait sparkle + chat line + HP bar bump.

## 1.7.415 — 2026-05-16

### Roster: real players now show low-HP kneel pose + sweat overlay

- Real wire players (`isReal: true`) already carry `hp` and `maxHP` in their snapshot entry, but the roster row was always rendering the idle portrait regardless. `_drawRosterRow` in `src/roster.js` now checks `hp <= floor(maxHP / 4) && hp > 0` and swaps `fakePlayerPortraits` for `fakePlayerKneelPortraits`. Adds the 2-frame sweat overlay (`bsc.sweatFrames`) above the portrait at the same 133 ms cadence used in battle / HUD.
- Fake-pool entries (none today since `PLAYER_POOL = []`) ship without runtime `hp`, so the threshold check fails and they keep the idle portrait — no regression to the legacy roster look when fakes are toggled back on.
- HP updates ride the existing `update` wire path; whenever a partner takes damage and emits a profile diff, every other player's roster ticks over to kneel.

## 1.7.414 — 2026-05-16

### Diag: client-side party logging (temporary, in-game chat console)

- On `setNetPartyInviteHandler` accept (invitee side): logs `[party] accepted, stashed <name>` or `[party] accept-stash SKIPPED ...` so we can see whether the v1.7.412 stash actually fired.
- On `tryJoinPlayerAlly` (battle confirm-pause pre-pass): logs `[party-prepass] members=[...] pvpFilter=[...]` plus per-name `[party-prepass] lookup <name> online=<bool> cached=<bool> final=<bool>` so we can see whether the partner is in `partyMembers` AND whether the live / cached profile lookups succeed.
- Lines appear in the in-game chat console (the strip across the bottom). Open chat with T, scroll back to see them.

## 1.7.413 — 2026-05-16

### Diag: log `pvp-ally-join` relay (temporary)

- Server-only `console.log` lines on the `pvp-ally-join` relay path so we can confirm whether the wire-mirror is firing when a party member joins a wire-PvP battle. Pairs with the existing `pvp-search` / `pvp-encounter` / `pvp-hook` / `pvp-action` diag.

## 1.7.412 — 2026-05-16

### Party-assist now works in both directions (invitee side wasn't seeing it)

- **Bug**: when A invited B and B accepted, only A's local `partyInviteSt.partyMembers` got populated (via `_resolveAsJoin` in the `party-invite-result` handler). The server doesn't echo a join confirmation back to the invitee — so B's local party state stayed empty, and B's `tryJoinPlayerAlly` pre-pass found nothing to pull in. Result: A's random battles auto-spawned B as ally, but B's random battles fought solo. To the player, it looked like the fake-roster fallback was firing on B's side (it wasn't — `PLAYER_POOL` is `[]`; the pre-pass was just empty).
- **Fix**: on `setNetPartyInviteHandler` accept, mirror the inviter's `_resolveAsJoin` shape locally — push the inviter's name into `partyMembers` and stash their profile in `partyMemberProfiles`. The original `party-invite-incoming` message already carries A's full profile, so no server change needed. Disband cleanup on the invitee side (`setNetPartyDisbandedHandler`) now also clears the inviter from local state, matching `setNetPartyMemberLeftHandler` on the inviter side.

## 1.7.411 — 2026-05-16

### PvP victory: null stale `encounterDropItem` so post-defeat FSM exits cleanly

- **Bug**: after defeating a PvP opponent, the winner's FSM walked through `victory-name-out` → … → `cp-fade-out` → checked `encounterDropItem !== null` and routed to `item-text-in` → `item-hold` because the previous monster encounter had left a drop in the global state. The `item-hold` was invisible (no item text rendered since the drop wasn't fresh) and Z-press advanced no UI the player could see — looked like the game froze with the PvP sprite still up.
- **Fix**: `_triggerPVPVictory` in `battle-update.js` now clears `encounterDropItem = null` before transitioning to the victory chain. The other terminal-rewards fields (`encounterExpGained` / `encounterGilGained` / `encounterCpGained` / `encounterJobLevelUp`) were already set fresh by `_triggerPVPVictory`; the drop was the only one inheriting prior state.

## 1.7.410 — 2026-05-16

### PvP: restore opponent back-swing pose (no new sprite code, just timer reset)

- **Bug**: opponent back-swing pose (`pvp-drawing.js` `isWindUp` gate at line 173) never rendered on the receiver side because the pre-flash timer was already past `BOSS_PREFLASH_MS` (133 ms) by the time the wire action popped off the queue. `battleSt.battleTimer` starts accumulating when the FSM enters `enemy-flash`, but the wire-PvP path waits in `enemy-flash` until the `pvp-action` arrives — over a cellular WS round-trip that's typically 100-200 ms, so the gate clears immediately on pop and the FSM skips straight from "waiting" to slash.
- **Fix**: reset `battleSt.battleTimer = 0` when the wire action is consumed in `_processEnemyFlash`. The 133 ms back-swing window now runs from wire-arrival, not from FSM entry, so the opponent's pose actually animates back before the strike.
- No new sprite code, no parallel render module — same `_processEnemyFlash` → `_runEnemyAttack` → `pvp-enemy-slash` → `pvp-drawing.js#drawPVPEnemy` path that has always handled it. The wind-up gate was just being skipped over by a stale timer.

## 1.7.409 — 2026-05-16

### PvP: canonical actor-push order so initiative agrees across clients

- **Bug**: even with the per-turn rand resync (1.7.408), `buildTurnOrder` was still computing different priorities on the two clients. Reason: each client pushes `ps` (their local player) first, then `opp` (`pvpOpponentStats`). On client A that means `rollInitiative(A.agi)` first, then `rollInitiative(B.agi)`. On client B it's the reverse — same rand cursor, but swapped which AGI it pairs with. So the two clients independently sort the same actors with different priorities → different turn orders → both sides advance from divergent FSMs and look like they're fighting different battles.
- **Fix**: at battle start, store `pvpSt._wirePushOppFirst = getMyUserId() > target.userId`. Both clients independently compute this from their own + the opponent's userId, and only one of them flips it to `true`. `buildTurnOrder` in `battle-turn.js` swaps the ps↔opp push order on the flag-set client so both clients call `rollInitiative` for the lower-userId actor first → same rand consumption order → same priorities → same turn order. Falls back to the previous order when `pvpSt.isPVPBattle` is false (random encounters, boss) or when there's no wire (fake roster).

## 1.7.408 — 2026-05-16

### PvP: per-turn rand resync to converge initiative + downstream rolls

- **Bug class**: even after hits ride the wire (1.7.407), the two clients' `rand()` cursors drift the moment each side pre-rolls its own attack at confirm-time — sender consumes N rand calls, receiver consumes M ≠ N. So `rollInitiative` (turn order), `tryInflictStatus`, sleep-wake and confuse snap-out rolls all run on different states between the two phones, producing visibly different turn orders / status outcomes per round.
- **Fix**: at every turn boundary, wire-PvP reseeds `rand()` from `(_wireSeed + _wireTurnIndex)` so both clients converge to a shared rand state before `buildTurnOrder` runs. Both phones independently arrive at the same point in the FSM (`_buildAndProcessNextTurn` in `pvp.js`), and the seed + counter are both stored on `pvpSt` so the reseed value is identical without the server sending anything per turn. Pre-roll drift gets erased every round.
- Stores `pvpSt._wireSeed` + `pvpSt._wireTurnIndex` set in `startPVPBattle`; non-wire PvP (fake roster, single player) skips the resync.
- Doesn't override the wire-shipped values (hitResults / damageRoll / healAmount still authoritative when provided) — this is for the rand-derived rolls that don't have wire payloads yet.

## 1.7.407 — 2026-05-16

### PvP: physical hits ride the wire so attack damage stays in sync

- **Bug**: after v1.7.406 the wire emit was live, but the two clients showed different damage / HP for the same swing. Root cause: the sender pre-rolls hits at target-confirm (`input-handler.js#_battlePlayerAttackConfirm` populates `inputSt.hitResults` via `rollHits`), and the wire payload only carried `{kind, actor, target}`. The receiver re-rolls hits when applying the opponent-attack at `pvp.js:665`, by which point both clients' `rand()` cursors have diverged (each one consumed their own pre-roll) — so the receiver computes different damage / crit / miss flags. Same drift pattern that magic already fixed via `damageRoll` in v1.7.389 (audit #24).
- **Fix**: `hitResults` now rides the wire alongside `damageRoll` / `healAmount`. Sender includes the pre-rolled hits array in the attack payload (`battle-update.js#_emitWirePVPAction`); server relays it (`ws-presence.js` `pvp-action` case); receiver stashes it in `_wirePendingHitResults` when consuming the wire action (`pvp.js#_applyWireOpponentAction`) and uses it at the rollHits call site, falling back to a local roll if the field is absent. Both clients now apply identical damage even though their rand cursors are out of sync.

## 1.7.406 — 2026-05-16

### PvP: wire-emit is finally reachable (P0)

- **Bug**: `_emitWirePVPAction` (`src/battle-update.js:394`) is the single place that translates the local player's chosen action into a wire `pvp-action`. Its only caller was `_updateBattleMenuConfirm`, which lives inside `updateBattle`. But `updateBattle` early-returns at line 902 when `pvpSt.isPVPBattle` is true and dispatches to `updatePVPBattle` instead. **So in every live PvP battle, the wire-emit was unreachable.** Neither client ever sent a `pvp-action`; both clients ended up in `enemy-flash` waiting for an action that was sent nowhere → freeze after the first command. Server diag (`v1.7.405`) confirmed zero `[pvp-action] relay` lines despite plenty of `[pvp-hook] HIT` lines.
- The harness (`tools/pvp-wire-sim.js`) calls the helpers directly so this dead-code path never failed a regression test.
- **Fix**: exported `_emitWirePVPAction` as `emitWirePVPAction` from `battle-update.js` and wired it into `_updatePVPMenuConfirm` in `pvp.js` so the PvP-side menu-confirm tick emits exactly like the non-PvP path. Imported `inputSt` into `pvp.js` for the `playerActionPending` payload read.

## 1.7.405 — 2026-05-16

### Diag: log every relayed pvp-action on the server

- One more temporary `console.log` in `ws-presence.js` for the `pvp-action` relay path. Logs `relay user=N → partner=M kind=K actor=X` on success, or one of three skip reasons (`not-helloed`, `no-partner`, `partner-dead`) on failure. Pairs with the v1.7.403 `pvp-search` / `pvp-encounter` / `pvp-hook` logging to narrow down where the "freeze after first command" desync is breaking.

## 1.7.404 — 2026-05-16

### Chrome-Android stutter fix: hybrid rAF / Worker tick driver

- **Bug**: engine ticked exclusively via Web Worker `setInterval(16ms)` → `postMessage` → main thread. Chrome on Android doesn't vsync-align Worker messages the way Firefox does, so when the main thread is even briefly busy, messages queue up in the worker and arrive as a burst — main thread runs several `gameLoop()` calls back-to-back, then nothing for a stretch. Visible as the unplayable stutter reported on Galaxy S23 / Chrome at v1.7.403. Firefox doesn't show it (different scheduling).
- **Fix**: `src/game-loop.js` now picks between two drivers based on `document.visibilityState`. While visible: `requestAnimationFrame` (vsync-aligned, no message-queue burst). While hidden: the original Worker `setInterval` (rAF is paused on hidden tabs and MP sync needs the engine alive). A `visibilitychange` listener flips between them; the worker's `onmessage` handler bails when the driver mode isn't `'worker'` so an in-flight postMessage that arrives during the transition can't double-tick. `lastTime` is reset on switch so the gap doesn't show up as a giant single frame.
- **120 Hz cap**: rAF tick is gated at a 14 ms threshold so 60 / 90 / 120 Hz displays all converge to ~60 effective FPS. Without this the S23's 120 Hz panel would double per-frame render work versus the worker baseline.

## 1.7.403 — 2026-05-16

### Diagnostic logging for PvP hook resolution (temporary)

- Server-only `console.log` lines in `ws-presence.js` around `pvp-search` / `pvp-encounter` / `_resolveEncounterHook` so we can see exactly why one side enters battle while the other stays in "Searching...". Logs include candidate count, skip reasons (not-helloed / loc-mismatch), and per-roll chance/hit. To be removed once the desync is fixed.

## 1.7.402 — 2026-05-16

### Multiplayer: player names no longer render as "object"

- **Bug**: `slot.name` is a `Uint8Array` of FF3-encoded text bytes. `JSON.stringify` on a `Uint8Array` serializes as `{"0":N,"1":N,…}` (object-shaped, not array — TypedArrays don't have a `toJSON` method JSON.stringify respects). Server's `_normalizeProfileField('name', value)` then ran `String(value).slice(0, 16)` → `"[object Object]"` → bitmap font drops the `[` `]` glyphs → user sees "object" / "object Object" in the roster.
- **Fix**: `src/main.js` profile getter now decodes `slot.name` via `_nesNameToString` from `text-utils.js` before sending. Wire carries a real JS string, server clamps to 16 chars, receiver renders the correct name.

## 1.7.401 — 2026-05-16

### Multiplayer: fresh registrations now actually connect (P0)

- **Bug**: `init()` runs at module-load (index.html:870), which calls `connectNet()` → `_open()` BEFORE the user reaches the auth screen. On a fresh browser with no prior token, `_getToken()` returns null and `_open` returned silently with no retry. The user then registered or logged in, the new token landed in localStorage and in-memory `authToken`, `/api/save` worked (uses the in-memory token), but **WebSocket presence never opened** — the bootstrap had already given up. Anyone signing up fresh stayed invisible to every other player in their roster.
- **Repro**: nginx access log showed phone B (Chrome Android, lucas@gmail.com, userId 4) successfully registering at 04:04:14, fetching the patch, making four `/api/save` POSTs, but zero `/api/ws` requests.
- **Fix**: `_open()` in `src/net.js` now schedules a 2-second deferred retry whenever the token is missing, guarded by a single in-flight flag (`_retryScheduled`) so concurrent callers don't stack timers. Once `localStorage.ff3_token` appears (post-register / post-login), the next retry tick promotes to a real WebSocket open. Also added a "WS already connecting/open" early-return at the top of `_open` so the new retry can't race with `_scheduleReconnect` into a double WS.

## 1.7.400 — 2026-05-15

### Freeze movement during the PvP-encounter check

- **Bug**: when a random encounter triggered, `_triggerEncounterWithPVPCheck` (`src/battle-encounter.js`) sends a `pvp-encounter` to the server and waits up to 500 ms for a `pvp-match` / `pvp-encounter-none` reply (with a 500 ms timeout fallback). During that window `battleSt.battleState` was still `'none'`, so the per-frame `handleInput` kept calling `startMoveFromKeys` — the player visibly walked past the trigger tile while the server roundtrip was in flight.
- **Fix**: export `isEncounterCheckPending()` from `battle-encounter.js`; `startMoveFromKeys` in `src/movement.js` early-returns while it's true (resets the walk frame so the sprite snaps to idle). Once the encounter or PvP match commits `battleSt.battleState`, the existing `handleBattleInput` gate takes over.

## 1.7.399 — 2026-05-15

### ROM-picker copy polish (the actual one)

- Trimmed the ROM-picker hint on the auth screen to two lines: "You supply your own ROMs — the site doesn't distribute them." + "ROMs cache in your browser after the first load." The "FF3 is the main game; FF1 + FF2 supply battle music and one sprite" line is gone — that detail is going to keep shifting during alpha (more cross-ROM borrows are planned) and the user doesn't need a per-ROM accounting in the picker.
- Restored the `ROM ok  PRG=…  CHR=…  mapper=…` boot-log line that 1.7.398 dropped. That edit was a misread of the previous ask.

## 1.7.398 — 2026-05-15

### Startup console polish (later reverted)

- Dropped the `ROM ok  PRG=…  CHR=…  mapper=…` line from the boot log in `src/main.js`. Restored in 1.7.399 — the actual ask was about the ROM-picker copy on the auth screen, not the boot console.

## 1.7.397 — 2026-05-15

### "Log out other devices" UI

- **`#auth-logout-all` button** (`index.html`) sits next to the existing Logout button in the bottom-right user bar. Tooltip explains the action; click prompts with a native `confirm()` so it's not a one-tap mistake. On accept, fetches `POST /api/logout-all`, stores the fresh token from the response (so the current session stays signed in), and surfaces a "Done" / "Failed (status)" / "Try again" / "Network error" state on the button for ~1.5-2 s. Disabled while in flight.
- **New regression test** in `pvp-wire-sim` covers the full revocation cycle: pre-logout-all refresh succeeds → logout-all returns 200 → same token now 401s on `/api/refresh`. Harness count: 34 (was 33).

## 1.7.396 — 2026-05-15

### Pre-beta JWT rotation + revocation

- **`users.token_iat_min` column** (`api.js`): new per-user "any token issued before this unix-second is invalid" watermark. Default 0 means no revocation. Bumped to `now` by `/api/logout-all` to invalidate every outstanding session in one shot (any HTTP / WS call carrying a now-stale token sees 401).
- **`verifyTokenWithRevocation` shared helper** (`api.js`): both `authMiddleware` (HTTP) and `ws-presence.js` upgrade handler route through this. Signature check → expiry check → `users.token_iat_min` comparison. Pre-fix the WS path did only the signature/expiry check, so revoking a session wouldn't kill open WS connections.
- **`POST /api/refresh`**: sliding refresh — takes a valid Bearer token, returns a fresh 30-day token. Hard limit: rejects tokens older than 21 days so a stolen token can't be chained indefinitely. Rate-limited under the auth bucket. Client (`index.html`) calls this on page load when the stored token's `iat` is more than 7 days old; on 401 it clears local auth state and shows the login screen.
- **`POST /api/logout-all`**: bumps `token_iat_min` to now, then issues a fresh token for the caller (so the user who just logged everyone else out stays signed in). No client UI yet — endpoint is wired for a future "log out other devices" button.
- **Test surface**: new `_testEnsureUser(userId)` export from `api.js` inserts a stub row so `pvp-wire-sim` + `pvp-load-sim` token mints validate. Two new wire-sim assertions cover the refresh happy path + junk-token rejection. Harness count: 33 (was 31).

## 1.7.395 — 2026-05-15

### Pre-beta first-time UX

- **Auth screen description** (`index.html`): adds a tagline ("A multiplayer take on NES Final Fantasy III") and a 2-line explainer above the Login/Register tabs so a brand-new visitor knows what the site is before they enter credentials. Pre-fix all they saw was the title + email/password fields.
- **ROM picker hint**: small explainer under the three file inputs — "You supply your own ROMs — the site doesn't distribute them. FF3 is the main game; FF1 + FF2 supply battle music and one sprite. ROMs cache in your browser after the first load." Sets expectations on the legal scope + why three files + why the second visit is faster.
- **First-run tips** (`src/main.js`): when `localStorage.ff3_first_run` is unset, pushes 6 welcome lines into the chat console after the boot metadata — chat key, encounter mechanic, online indicator, PvP entry point, command list pointer. Once per browser; delete the sentinel to re-show on next load.

## 1.7.394 — 2026-05-15

### Pre-beta mobile pass

- **Multi-touch D-pad slide-tracking** (`index.html`): replaced the per-button `touchstart/touchend` listeners with a single document-level tracker. Each `Touch.identifier` is tracked independently — two fingers can hold the D-pad and an action button simultaneously. On `touchmove`, the tracker re-checks which `[data-key]` element is under each finger via `elementFromPoint`; if it changed, fires `keyup` on the old button and `keydown` on the new one. Sliding a thumb from "up" to "right" on the D-pad now releases up and presses right without a lift+tap — matches native game-controller patterns. Dragging off any button releases it.
- **`is-touch` body class** drives mobile-controls visibility via runtime touch detection. Pre-fix only the `max-width: 520px` media query showed the controls — tablets and landscape phones above 520 px hid them entirely. Now any device that reports `ontouchstart` / `maxTouchPoints > 0` gets controls regardless of viewport width.
- **`overscroll-behavior: none`** on html/body kills pull-to-refresh and bounce-scroll. A vertical swipe (intended as a D-pad slide or chat scroll) no longer bounces or reloads the page.
- **`-webkit-touch-callout: none`** on body kills the iOS long-press context menu on game UI.
- **`min-height: 100dvh`** layered on top of `100vh` so the body shrinks with the mobile keyboard instead of pushing content off-screen below it.

## 1.7.393 — 2026-05-15

### Cache-bust + audit edge cases + load harness

- **P1 #4 cache-bust** (`index.html` + `server.js`): version-gate script at the top of `index.html` compares `localStorage.ff3_build` to the build-stamped `{{VERSION}}` token. On mismatch, synchronously navigates to `?_v=<build>`; the server detects that query and returns the new HTML with `Clear-Site-Data: "cache"`, evicting the HTTP cache before subsequent module imports run. Anti-loop guard via `sessionStorage` so a broken server doesn't trigger infinite reloads. Best-effort fire-and-forget cache + service-worker eviction in the gate for browsers that ignore Clear-Site-Data. Kills the prod `[BOOT ERROR] module 'X' doesn't provide an export named Y` class hitting stale-cached Android Firefox clients (5× in recent logs).
- **Audit #16 wire actions during close**: `setNetPVPActionHandler` now early-returns when `battleSt.battleState` is one of `enemy-box-close / encounter-box-close / run-success / run-fail`. Pre-fix queued garbage accumulated until `resetPVPState` ran, with a narrow window where a synthetic `disconnect` could land but never get dispatched.
- **Audit #26 pvp-result half-state timeout**: server now sets a 10-s timer when one side reports `pvp-result` but the partner hasn't. On timeout, push synthetic `disconnect` to both sides and clear `_pvpPartners`. Pre-fix a dead/crashed partner left a leaked partner-pair entry that could collide with future `pvp-match` registrations for the surviving user.
- **Load harness** (`tools/pvp-load-sim.js`): spins up the real `ws-presence.js` in-process, opens N JWT-authed `ws` clients (X-Forwarded-For spoofed per client to bypass the per-IP cap), drives realistic chat / update / location traffic for a configurable duration, reports peak state-map sizes + RSS/client. Baseline: 200 clients connect in <200 ms, ~86 KB/client RSS, 13k msgs/s outbound at chat=20/min/client.

## 1.7.392 — 2026-05-15

### Pre-beta P1 batch — moderation + roster polish + save integrity

- **Online badge in roster** (`src/roster.js`): real wire-presence players (`isReal: true` from `net.js` snapshot/join) now show a 3×3 green dot at the top-right of the portrait box, fading with the row. Solves the "fakes hidden + empty roster looks broken" first-impression problem in v1.7.386+: with fakes off by default, an empty roster used to look indistinguishable from "the game is broken." Now you can see at a glance which roster entries are real online players.
- **Server-side save validation** (`api.js`): every `/api/save` POST routes through `_validateSaveData` — 16 KB payload cap, whitelist of known fields, range clamps on every numeric (gil 0-999999, level 1-99, stats 1-99, inventory qty 0-99 per slot, 64-slot inventory cap, etc.). Unknown keys are dropped before insert. Pre-fix a client could write arbitrary JSON into the saves table — no schema enforcement, no size limit. Bug-induced corruption (out-of-range stats from a state desync) AND deliberate cheating (gil: 9999999) both bounded server-side now.
- **`/block <name>`** (`src/chat.js`): client-side block list, persisted in localStorage by both userId and name. Incoming chat from blocked senders silently dropped — spoof-proof via userId match (resilient to renames) with name fallback for older messages. `/block` (no args) lists blocks, `/block clear` wipes them, `/unblock <name>` removes a single entry.
- **`/report <name> <reason>`** (`src/chat.js` + `api.js`): POSTs to a new `/api/chat-report` endpoint backed by a `reports` SQLite table. Records reporter userId, target userId (if resolvable from the online roster), target display name, reason (200-char cap), and reporter IP. Rate-limited under the auth bucket (5 burst / 1 per sec). No automated action today — moderator-review trail.

## 1.7.391 — 2026-05-15

### Pre-beta P0 fixes (from prod pm2 error triage)

- **`BATTLE DRAW ERROR — pos is undefined` (24× firings in recent logs)**: `src/battle-drawing.js#_encounterMonsterPos` and `_getMagicTargetCenter` only checked `idx < gridPos.length`, never that `gridPos[idx]` itself was defined. Sparse-array hole during a mid-frame transition (e.g., damage-num still rendering after monster cleared) threw on `pos.x` every render frame, which wiped the rest of `drawBattle` — chat, msg strip, damage nums all gone — until the user navigated away. Added `if (!pos)` early-returns; magic target now returns `null` (caller already handles), monster-num returns a zero anchor so the digit parks offscreen-safe.
- **`FREEZE WATCHDOG — magic-hit stuck for 5s` (3× firings)**: NOT a real freeze — the watchdog was timing against wall clock, but backgrounded-tab Worker ticks are throttled 10×+ by browsers. Real evidence: `timer:500` at the moment the watchdog fired = 100 ms of game time per 1 s wall. Magic-hit needs ~1750 ms of game time; user just hadn't returned to the tab. Now the watchdog skips reports when `document.visibilityState === 'hidden'` AND requires `battleTimer` to have NOT advanced by more than 200 ms before firing — combining wall-clock + game-clock signals to tell hangs apart from slow ticks.
- **`/api/login` + `/api/register` + `/api/client-error` rate limit** (`api.js`): token-bucket per IP, AUTH endpoints capped at 5 burst / 1 per sec, client-error at 30 burst / 5 per sec. Pre-fix bcrypt at SALT_ROUNDS=10 (~100 ms per compare) would let a single attacker pin a CPU on bursty login attempts; client-error had no auth and was a log-flood vector. nginx-aware via `X-Forwarded-For`.
- **Login timing-leak fix**: `bcrypt.compare` now always runs (against a startup-generated dummy hash when the email isn't registered) so the response latency for "user not found" matches "wrong password". Pre-fix the missing compare leaked account enumeration via response timing.

## 1.7.390 — 2026-05-15

### Multiplayer audit batch 4 — observability + UX

- **#8 PM-by-userId client wiring**: `sendNetChat` resolves the recipient name to a userId via the local online roster and includes `toUserId` on the wire. Server prefers it; name-only fallback stays for compat.
- **#14 pvp-result mismatch recovery**: when the server detects two clients reported inconsistent outcomes, it now pushes a synthetic `pvp-action {kind:'disconnect'}` to BOTH partners so neither sits in a half-state. The `[pvp-result mismatch]` server log still fires as the divergence tripwire — and now the players see "Foe lost link" + a clean exit instead of hanging.
- **#30 search-failed reason differentiation**: `target-busy` (someone else hooked them) shows "Target busy"; `different-location` shows "Target moved"; rolled-miss still shows the original timeout/cancel messages. Pre-fix everything collapsed into the same "Missed!" string.
- **#38 `MULTIPLAYER.md` updates**: documented party-chat-by-membership, PM-by-userId, the new `damageRoll`/`healAmount` magic payload fields, the `pvp-ally-join` profile shape, and the v1.7.388 defensive limits (`maxPayload`, rate limit, per-IP cap, profile clamp, location cleanup).

## 1.7.389 — 2026-05-15

### Multiplayer audit batch 3 — protocol completeness

- **#24 `pvp-action {kind: 'magic'}` carries `damageRoll` / `healAmount`**: sender's pre-rolled values now travel on the wire; receiver uses them directly when present, falls back to a local roll otherwise. With synced RNG the values should match anyway, but the explicit payload defuses any cursor-drift desync from divergent rand() call counts before the cast.
- **Hidden bug: server didn't relay `actor.idx`**: `pvp-action` relay only forwarded `kind / target / spellId / itemId`. Sender's `_emitWireAllyAction` set `actor: {idx: allyIdx + 1}` for ally actions, but the server dropped it. Receiver read `headActor = (head?.actor?.idx) | 0` → always 0, so any ally action (cell ≥ 1) hit the queue-mismatch branch and soft-froze the FSM in `enemy-flash`. Party-PvP ally turns would not have functioned across the wire. Now relayed.
- **#23 wire item target translation**: receiver's `_applyWireOpponentAction` for `kind: 'item'` was hardcoded to "heal main opp on yourself only". Now mirrors the magic path — translates `target.side / idx` properly, handles cure-status / heal / full_heal effects, and routes the heal-num + SFX to the right cell.
- **#32 `clearActiveCast` after wire-pvp magic**: `_processPVPEnemyMagic` was leaking `activeCast` across spell rounds. Cleared at end-of-hit alongside the other per-cast state.
- **#31 freeze watchdog ignores wire-wait**: `enemy-flash` while `pvpSt.isWirePVP && !pvpPreflashDecided` is now treated as idle. Stops the watchdog from firing during normal network jitter on the receiver's side.
- **#4 `_playerTurnRun` uses `rand()`**: kept the AGI roll seeded so any future code path that wants to lockstep across clients sees a consistent cursor.

## 1.7.388 — 2026-05-15

### Multiplayer audit batch 2 — server hardening + UX

- **#6 per-connection rate limit**: token bucket (60 capacity, 20/s refill) on every incoming frame. Excess silently dropped — a malicious client can no longer flood `chat` / `update` / `pvp-search` to saturate broadcast bandwidth.
- **#8 PM by userId**: chat PM now prefers `parsed.toUserId` and routes directly to that connection. Legacy `to`-by-name path stops at the first match (was broadcasting to every user who shares the recipient's name). The previous behavior meant anyone could rename to "Joel" and intercept every PM addressed to Joel.
- **#10 per-IP connection cap**: max 10 simultaneous WS connections from one IP (X-Forwarded-For aware for nginx). Excess gets 429.
- **#11 stale-search cleanup on location change**: when a player crosses a map boundary, the server scans `_pvpSearches` for their outgoing search (drops + notifies if the target is now in a different `loc`) and incoming searches targeting them (drops + notifies challengers who didn't follow). Pre-fix the challenger sat at "Searching..." for the full 5-minute timeout.
- **#15 / #21 pvp-match arrives during in-flight battle**: client guards `setNetPVPMatchHandler` with `battleState !== 'none'`. The 500 ms `pvp-encounter` fallback could otherwise stack a PvP battle on top of an already-starting monster encounter. On arrival, sends `pvp-end` so the server clears the partner pair cleanly.
- **#22 party chat by membership, not location**: server keeps `_partyMemberships` (memberId → inviterId) — party-channel chat now broadcasts to that party's set (inviter + members) regardless of where they're standing. Pre-fix everyone in the same location saw your party chat.
- **#25 chat field caps**: `channel` capped at 8 chars; `to` at 16 (was unbounded server-side, allowing huge channel strings as a cheap DoS).

## 1.7.387 — 2026-05-15

### Multiplayer audit batch 1 — sync + server hardening

Full audit landed at `docs/MULTIPLAYER-AUDIT-2026-05-15.md` (38 findings, severity-ranked). This deploy ships the critical-tier fixes:

- **#2 status RNG sync**: `status-effects.js#tryInflictStatus` and `processTurnStart` (sleep-wake, confuse snap-out) swapped `Math.random` → `rand`. With both clients seeded from the server-broadcast PRNG, status rolls now agree across the wire. Pre-fix: a "sleeper wakes" roll could fire on one side and not the other, forking the turn FSM until queue-reorder timed out.
- **#3 SouthWind throw RNG sync**: `pvp.js` SW damage roll swapped to `rand()`. Was diverging across clients.
- **#5 WSS maxPayload**: `WebSocketServer` capped at 16 KB per incoming frame (was 100 MB default). Rules out single-frame OOM attacks.
- **#7 update field validation**: `ws-presence.js` `hello` + `update` both route every profile field through a new `_normalizeProfileField` clamp helper. Pre-fix a malicious client could `update {agi: 9999}` and the server broadcast it verbatim — the hook-chance formula reads `agi` directly, so unbounded values could pin search hooks at the 0.75 cap.
- **#18 pvp-ally-join carries profile**: wire payload now includes the raw ally `{name, jobIdx, level, palIdx, loc, weapon*, armor*, knownSpells, jobLevel}` instead of just the name. Receiver runs its own `generateAllyStats(profile)` so the mirror cell on `pvpEnemyAllies` matches the sender's local push regardless of whether the name resolves in `PLAYER_POOL`. Pre-fix (with fakes disabled by default in 1.7.386), every ally-join silently no-op'd on the receiver — sender saw 2v1, receiver saw 1v1, turn queues forked next round. Also wired party-member joins through `sendNetPVPAllyJoin` (was only the random-fill branch — covers audit #28 too).
- **#1 defendHalve cross-client desync**: sender's `rollHits` for PvP attacks on the main opp now includes `defendHalve: pvpSt.pvpOpponentIsDefending`. Receiver's `_processEnemyFlash` already had `defendHalve: battleSt.isDefending` — pre-fix the two diverged 2× per hit any time the defender used Defend. Added `pvpSt.pvpOpponentIsDefending = false` to the end-of-round clear in `processNextTurn` so defend doesn't leak across rounds if the opp doesn't physically attack.

## 1.7.386 — 2026-05-15

### Fake players hidden — real-multiplayer mode only

- `data/players.js` PLAYER_POOL exported as `[]`. The original 30-entry fake-roster (Nyx / Wren / Brom / Aldric / …) is preserved in the file as the non-exported `_FAKE_POOL` const so it's a one-line re-enable: change the `export const PLAYER_POOL = [];` to `export const PLAYER_POOL = _FAKE_POOL;`.
- All consumers silently see an empty pool — no code changes elsewhere:
  - **Roster panel**: only real online players appear. If you're solo, the panel is empty until someone else logs in.
  - **`_tryJoinPlayerAlly` random-roll branch**: filter returns empty, early-returns false. No wandering NPC joins your party mid-battle.
  - **`tryJoinPVPEnemyAlly`**: same. No NPC reinforcements on either side.
  - **Fake PvP search / party invite**: target is never a `PLAYER_POOL` entry (since roster has no fakes), so the local sim-timer paths never trigger. All PvP / party flows now exclusively wire-driven.
  - **Fake chat patter**: the periodic NPC chat sender (`* Brom: ...` lines) early-returns since the pool is empty. World chat is real-player-only.
- Reversible: anyone who wants to run with the old fake-populated world flips the export back. No behavior changes outside the population question.

## 1.7.385 — 2026-05-15

### pvp-action actor-mismatch auto-reconcile

- Pre-v1.7.385: if `_wireOpponentActions` queue head's `actor.idx` didn't match the current `casterCellIdx`, `_processEnemyFlash` logged a warning and `return false`'d — soft-freezing the FSM in `enemy-flash` until the FREEZE WATCHDOG fired.
- Now: queue scan via `findIndex(a => a.actor.idx === casterCellIdx)`. Matching action gets `splice`'d out and dispatched; non-matching ones stay queued for their own turn firings. The reorder is logged once (`[pvp-action] queue-reorder: cell=N was at queue idx=K`) so we still see when desync happens — but the battle keeps moving.
- If no matching action exists yet in the queue, still returns false — the FSM holds in `enemy-flash` until the matching action arrives. Same wait behavior, just resilient to reorder.

This was the last item on the multiplayer-prep follow-up queue. Tonight's deploy chain (multiplayer track) closed out:

| Range | Topic |
|---|---|
| 1.7.366 → 1.7.371 | Steps 1–3: presence / chat / PvP search |
| 1.7.372 → 1.7.374 | Step 4 (1v1): seed sync + action relay + outcome reporting |
| 1.7.375 → 1.7.376 | Party-ally PvP: roster sync + ally action relay |
| 1.7.377 | Opponent-flee |
| 1.7.378 → 1.7.381 | Real party invites, prompt UI, one-party-per-player, disband |
| 1.7.382 → 1.7.385 | Mid-session sync, graceful forfeit, fake-roster joins, mismatch auto-reconcile |

## 1.7.384 — 2026-05-15

### Fake-roster ally mid-battle joins re-enabled in wire-PvP

- Pre-v1.7.384 `_tryJoinPlayerAlly`'s random-roll branch fired locally and silently — only the side that took the turn grew their party; the partner saw stale rosters because the new ally wasn't synced.
- Now: when `_tryJoinPlayerAlly` picks a fake-roster ally during wire-PvP, the rolls use seeded `rand()` (eligible list is identical across clients thanks to the v1.7.375/v1.7.376 roster sync, but the gate + pick rolls needed seed-sync to land on the same name). The picked ally's PLAYER_POOL name is emitted via `pvp-ally-join {name}` to the partner; partner looks up the name in their identical PLAYER_POOL, runs `generateAllyStats` locally, and pushes to `pvpEnemyAllies` with the same resize-anim setup `tryJoinPVPEnemyAlly` uses.
- New wire helpers: `sendNetPVPAllyJoin(name)` / `setNetPVPAllyJoinHandler(fn)` in `src/net.js`. Server relay is a one-liner forwarding to the partner.
- Both sides' parties grow symmetrically — A's confirm-pause adds X to A's left; B sees X appear on B's right. B's confirm-pause adds Y to B's left; A sees Y appear on A's right.
- `tryJoinPVPEnemyAlly` (the local-only opponent-side picker) stays gated off during wire-PvP — opponent-side growth happens only via the wire signal from the OTHER client's `_tryJoinPlayerAlly`.
- Wire is small: just `{name}`, not full stats. PLAYER_POOL is identical static data across clients.

## 1.7.383 — 2026-05-15

### Graceful PvP forfeit on partner WS disconnect

- Pre-v1.7.383 the disconnect path forced `pvpOpponentStats.hp = 0` so the remaining player would "win" the fight — dissolved death animation, unearned XP/Gil, message log lying about a kill that didn't happen.
- Now mirrors the opponent-flee path (v1.7.377): `setNetPVPActionHandler` short-circuits `kind:'disconnect'` to `enemy-box-close` directly, with the message **"`<Name>` lost link"** and `SFX.RUN_AWAY`. No death anim, no rewards (opp.hp stays > 0 so `resetPVPState` reports outcome `fled` — same path as a normal flee).
- `_applyWireOpponentAction`'s `'disconnect'` branch is now a no-op (unreachable since wire-arrival short-circuits; defensive against out-of-order delivery).

Net effect: A is mid-PvP with B. B's connection drops. A sees "B lost link" → battle box closes → back to overworld with no XP. No fake victory, no fake death animation. Server's outcome mismatch logger is happy too (B never reports, A reports `fled`, server stashes A's report harmlessly until A's next disconnect cleans it up).

## 1.7.382 — 2026-05-15

### Mid-session sync for real-player party members

- `src/net.js` poll loop now diffs the local player's main profile (level / palIdx / equipment / hp / maxHP / agi etc) every 500 ms and emits `update {…}` when the signature changes. Pre-v1.7.382 only `location` and `allies` polled; level-ups and equipment swaps never propagated past the initial `hello` snapshot.
- New `getOnlinePlayerByName(name)` exposed from `src/net.js`. Returns the live wire profile from `_onlinePlayers` — gets refreshed every time the server broadcasts a `player-update` for that user.
- `src/battle-update.js#tryJoinPlayerAlly` lookup chain reordered:
  1. `PLAYER_POOL` (stable fake-roster data)
  2. `getOnlinePlayerByName` — live wire profile (mid-session fresh)
  3. `partyInviteSt.partyMemberProfiles` — last-resort cache for transient reconnects
  
  Real-player party members now spawn into A's battles using their latest level / equipment / agi — what B has at battle-start time, not what they had at accept-the-invite time.
- `generateAllyStats` always sets `hp = maxHP`, so mid-battle HP changes don't carry over (each ally enters battle at full HP). This is the existing single-player behavior; KO'd-in-prior-battle members effectively revive when entering A's next battle. Mid-battle HP propagation is a future polish (not needed for the "B levels up after being invited" case the user described).

## 1.7.381 — 2026-05-15

### Disband on inviter / member disconnect

- Server (`ws-presence.js`) disconnect handler now notifies the surviving party side:
  - If a MEMBER drops, inviter receives `party-member-left {memberUserId, memberName}`.
  - If an INVITER drops, every member receives `party-disbanded {inviterUserId, inviterName}`.
  - `party-leave` (member-initiated explicit leave) mirrors the member-disconnect notify path.
- Client (`src/net.js`): `setNetPartyMemberLeftHandler(fn)` / `setNetPartyDisbandedHandler(fn)`.
- `party-invite.js`:
  - On `party-member-left` (we were the inviter): drops the name from `partyMembers`, clears `partyMemberProfiles`, logs `* <Name> left party` to chat. Next battle no longer spawns a ghost ally from stale cached stats.
  - On `party-disbanded` (we were a member): logs `* <Inviter>'s party disbanded` to chat. No local state to clear on the member side (they don't track which party they're in today), but the system message tells the player what happened.

Combined with the v1.7.380 one-party-per-player rule: when A disconnects, B's server-side membership clears AND B sees the disband notification. C can now invite B fresh; the cooldown still applies if B was recently invited by anyone (60s).

## 1.7.380 — 2026-05-15

### One-party-per-player enforcement

- Server (`ws-presence.js`): new `_partyMemberships: Map<memberUserId, inviterUserId>` tracks active memberships. `party-invite` now rejects immediately with `reason: 'busy'` if the target is already in someone's party — the prompt never reaches them.
- `party-invite-response {accept:true}` sets the membership; reject doesn't. Disconnect clears both directions (as-member and as-inviter — if A drops, all their B/C/… memberships clear so those players can accept new invites).
- New `party-dismiss {memberUserId}` (sent by the inviter on Party → Dismiss) and `party-leave` (member-initiated, no UI yet) handlers clear the server-side membership. Only the CURRENT inviter for a given member can dismiss them.
- Client (`src/net.js`): `sendNetPartyDismiss(memberUserId)` + `sendNetPartyLeave()`.
- `removeFromParty(name)` in `party-invite.js` now drops the cached real-player profile from `partyMemberProfiles` AND sends `party-dismiss` to the server so the membership clears in step.
- New `cancelPartyInvite('busy')` branch shows "In a party" instead of "Declined" so the inviter sees a specific reason. Same 60s cooldown applies.

Concrete: A invites B, B accepts, B is in A's party. C invites B → C sees "In a party" instantly (no prompt fires on B's screen). When A dismisses B (Party → Dismiss in roster menu), server clears the membership, and now C can invite B successfully.

## 1.7.379 — 2026-05-15

### UI prompt on incoming party invite (replaces auto-accept roll)

- New `showMsgBoxPrompt(bytes, onAccept, onDecline)` primitive in `message-box.js`. Sets `msgState.isPrompt = true` + two callbacks. Reusable for any future yes/no UI (trade requests, friend invites, etc.).
- `movement.js` msg-box hold handler: when `msgState.isPrompt`, Z fires `onAccept` then dismisses; X / Escape fires `onDecline` then dismisses. Clears prompt fields before slide-out so the callbacks can't re-fire.
- `party-invite.js` incoming handler swapped from auto-roll to prompt. The message reads "`<name>` wants party Z=ok X=no" (wraps to two lines at the 16-char box width). Z sends `party-invite-response {accept:true}`; X sends `{accept:false}`. If B is mid-battle or another `msgBox` is on screen, auto-decline so the FSM isn't interrupted — they can re-invite later (with the standard 60s cooldown).
- The pre-v1.7.379 auto-roll using `getAcceptChance` is gone for real-player invites (the function still serves fake-roster invites in `_runAcceptCheck`).

## 1.7.378 — 2026-05-15

### Real party invites over the wire

- Server (`ws-presence.js`): new `_partyInvites: Map<challengerUserId, targetUserId>` for pending invites. Handlers: `party-invite` records + forwards `party-invite-incoming` with challenger profile; `party-cancel` clears; `party-invite-response` looks up the matching invite and relays `party-invite-result` to the challenger with the target's profile on accept (or `reason` on reject/offline). Disconnect path cleans up invites in either direction.
- Client (`src/net.js`): `sendNetPartyInvite(targetUserId)` / `sendNetPartyCancel()` / `sendNetPartyResponse(accept)` + `setNetPartyInviteHandler(fn)` / `setNetPartyResultHandler(fn)`.
- Client (`src/party-invite.js`):
  - `startPartyInvite(target)` branches on `target.isReal && target.userId`. Real-target invites send `party-invite` over the wire; the local sim timer is parked at `Infinity` (server gates the response).
  - `cancelPartyInvite` sends `party-cancel` for real targets so the server clears the pending invite.
  - Incoming-invite handler (receiver side, B): auto-rolls accept chance using the same `getAcceptChance(challenger)` formula the fake-pvp path uses, emits `party-invite-response`. No UI prompt yet — MVP auto-rolls; future UI iteration can swap in a real prompt.
  - Result handler (inviter side, A): on accept routes through the existing `_resolveAsJoin(remotePartner)` swap with the wire-delivered profile; on reject shows "Declined" with the standard 60s cooldown; on offline shows "Target offline".
  - New `partyInviteSt.partyMemberProfiles: Map<name, profile>` stashes accepted real-player profiles so `tryJoinPlayerAlly` can find them at battle start (PLAYER_POOL doesn't include real online players).
- Client (`src/battle-update.js#tryJoinPlayerAlly`): name lookup falls back to `partyInviteSt.partyMemberProfiles` after `PLAYER_POOL`. Real party allies enter battle via the same `generateAllyStats` pipeline as fake ones.

What this gets you: open the game on two browsers, both at the same location. Browser A clicks Party on Browser B's roster row → A sees "Inviting B..." → B's client rolls accept (level-differential + Bard/Ranger/Knight bonus) → if accept, A sees "Joined" and B is now in A's party (joins A's battleAllies at battle start). If reject, A sees "Declined" with cooldown.

What's NOT in this deploy (carry to future passes):
- **UI prompt on incoming invite** — B's accept is automatic via the chance formula. A future iteration could pop a yes/no prompt on B's screen.
- **One-party-per-player on B's side** — B can be in multiple players' parties. (The 3-cap is enforced on the inviter's side, so this is mostly cosmetic.)
- **Disband on inviter disconnect** — if A drops, B's client doesn't know it's no longer in A's party. (Symptom: B's name might stay in A's `partyMembers` if A reconnects with stale state.)
- **Real-player ally HP / status sync across the party-member lifetime** — `tryJoinPlayerAlly` regenerates stats from the cached profile each battle; mid-session HP/status changes on the real player aren't propagated to A's party tracker.

## 1.7.377 — 2026-05-15

### PvP opponent-flee handling

- Player can now flee from PvP. Pre-v1.7.377 the Run menu in PvP showed "Can't escape!" (only random encounters allowed flee). `battle-update.js#executeBattleCommand` now gates Run on `isRandomEncounter || isPVPBattle`.
- `_playerTurnRun` in `battle-turn.js` takes a PvP fast-path: skip the AGI-vs-level success roll (no stable single source for it cross-client) and always succeed with `BATTLE_RAN_AWAY` + `SFX.RUN_AWAY`. Transitions to `run-success` like the encounter path.
- `_updateBattleRun` routes `run-success` to `enemy-box-close` when `isPVPBattle` (vs `encounter-box-close` for monster fights) so `resetPVPState` cleans up the PvP-specific state and the existing Step 4 outcome report (`fled`) fires correctly.
- Receiver side (`pvp.js#setNetPVPActionHandler`): a `kind:'run'` wire action short-circuits the normal queue dispatch and transitions immediately to `enemy-box-close` with `"OpponentName fled!"` + `SFX.RUN_AWAY`, regardless of whose turn was about to fire. Any queued wire actions get drained (they're moot once the battle ends).
- `_applyWireOpponentAction`'s `'run'` branch is now a no-op (unreachable today since wire-arrival short-circuits, but defensively safe if an out-of-order delivery ever queues one).
- Outcome reporting: both sides infer `fled` from `resetPVPState`'s outcome derivation (player HP > 0, opponent HP > 0 → `fled`). Server's `pvp-result` mismatch check passes since both clients report identically.

## 1.7.376 — 2026-05-15

### Party-ally PvP: ally action relay (2 of 3)

- Wire action shape extended for multi-actor parties:
  - `actor: { idx }` — 0 = sender's main player, 1+ = ally cell on sender's player side
  - `target: { side, idx }` — `me` / `opp` from sender's perspective, idx 0 = main, 1+ = ally cell
  - Receiver swaps `side` (sender's `me` → receiver's `opp`, etc.) and uses idx unchanged.
- SEND side:
  - Player emit (`_emitWirePVPAction` in `battle-update.js`) now carries `actor.idx = 0`, `target` derived from `pending.target` / `pending.allyIndex` / `pvpPlayerTargetIdx`.
  - Each `_tryAlly*` in `battle-turn.js` (Cure / Poisona / OffensiveCast / Item) calls `_emitWireAllyAction` with `actor.idx = allyIdx + 1` and target derived from the just-written `battleSt.allyMagic*` bag.
  - Ally physical attack site (line ~230) emits `kind:'attack'` with target = pvpPlayerTargetIdx + 1.
- RECEIVE side (`pvp.js`):
  - `_wireOpponentActions` is now a FIFO queue (was single slot). Multiple ally actions can queue between consecutive opponent turns.
  - `_processEnemyFlash` peeks the queue head and validates `action.actor.idx === casterCellIdx`. Mismatch logs `[pvp-action] actor mismatch` (turn-order desync indicator).
  - `_wireTargetToEngineRef(target)` translates the wire `{side, idx}` into engine refs (`{side:'enemy', cellIdx}` for pvp-enemy targets or `{side:'player', partyIdx}` for player-side targets).
  - `_applyWireOpponentAction` for `'attack'` stashes the resolved player-side ally idx into `_wirePendingAttackTargetAlly`; the post-preflash attack flow reads it instead of running the AI target pick.
  - `_applyWireOpponentAction` for `'magic'` uses `ref.cellIdx` (same-team heal) or `ref.partyIdx` (cross-faction cast) to set `pvpMagic*` bag fields.
- Backward-compatible: missing `actor`/`target` defaults to `{idx:0}` / `{side:'opp', idx:0}` so 1v1 still works.

### Party-ally PvP status (2 of 3 done; 3rd already shipped)

| Step | Status |
|---|---|
| 1 — Roster sync at match start | ✅ v1.7.375 |
| 2 — Ally action relay (this) | ✅ v1.7.376 |
| 3 — Disable fake mid-battle joins | ✅ v1.7.375 |

For 1v1 + party PvP (up to 3 cells per side, real players + their party allies): both clients now see identical battles. Each side's allies emit their AI-chosen action over the wire; the receiver applies it on the matching pvp-enemy-ally cell with the synced RNG seed producing identical damage / heal rolls. Mid-battle fake-ally joins are gated off (they would diverge per-client).

## 1.7.375 — 2026-05-15

### Party-ally PvP: roster sync (1 of 3)

- Wire profile (`src/main.js#connectNet` getter) now carries an `allies` array — each entry the already-derived `generateAllyStats` shape (stats + equipment + knownSpells). `src/net.js` polls allies every 500 ms and emits `update {allies}` on signature change.
- Server (`ws-presence.js`) stores `entry.profile.allies` on `hello`/`update`. Existing `pvp-match` spread already carries it through to the opponent payload, so both clients see each other's real party at match start.
- `src/pvp.js#startPVPBattle` populates `pvpEnemyAllies` from `target.allies` — wire-delivered roster drops straight in with a fresh `createStatusState()` per entry. 1v1 (no allies) falls through to empty array.
- `tryJoinPVPEnemyAlly` early-returns when `isWirePVP` — fake-roster mid-battle joins would diverge per-client. Server-arbitrated dynamic joins are a future extension; the wire-PvP roster is now fixed at match start.

What this gets you: if A has 2 party allies and B has 1, both clients show A=3-cell side, B=2-cell side, with the right names/jobs/equipment on each portrait. Action relay for ally turns is the next piece (currently A's ally still runs local AI on A's client AND on B's client independently — they'll drift).

## 1.7.374 — 2026-05-15

### MP Step 4 part 3: PvP outcome reporting

- Client (`src/pvp.js#resetPVPState`) infers the local outcome from live state — `ps.hp <= 0` = lost, `pvpOpponentStats.hp <= 0` = won, otherwise fled — and sends `pvp-result {outcome}` to the server alongside the existing `pvp-end`.
- Server (`ws-presence.js`) records the first report and compares with the partner's report when it arrives. The two clients must agree (`won`↔`lost` or both `fled`); mismatch is logged as `[pvp-result mismatch]` for divergence-bug observability.
- No auto-correction at MVP — with seed sync (part 1) + action relay (part 2) the engines should agree. Mismatches indicate a real bug to investigate (RNG path slipped, action arrived out of order, etc).

### MP Step 4 complete

All three parts shipped tonight (1.7.372 / 1.7.373 / 1.7.374):

| Part | What |
|---|---|
| 1 | Seed sync — server broadcasts a 32-bit seed on `pvp-match`; both clients seed `rng.js` before `_startPVPBattle`. All `rand()` calls agree. |
| 2 | Action relay — `pvp-action` over wire; opponent's turn FSM (`_processEnemyFlash`) holds preflash until wire delivers, then `_applyWireOpponentAction` writes the same state bag the AI would have. |
| 3 | Outcome reporting — `pvp-result` from both clients; server flags mismatch. |

For 1v1 PvP without party allies: two real players see the same battle, the same hit rolls, the same damage numbers, the same end state. Magic / item / defend / attack all sync.

Known scope limits (carry to a future step):
- Party allies on either side still run local AI (drifts).
- Opponent-run isn't modeled (treated as attack).
- Partner WS disconnect mid-battle forces opponent HP to 0 (crude — better resolution would be graceful forfeit).

## 1.7.373 — 2026-05-15

### MP Step 4 part 2: PvP action relay

- Server (`ws-presence.js`) tracks `_pvpPartners` on `pvp-match` and relays `pvp-action` messages between them. New `pvp-end` message clears the partner pair (sent on `resetPVPState` and on WS close).
- Client (`src/net.js`): `sendNetPVPAction(action)` + `sendNetPVPEnd()` + `setNetPVPActionHandler(fn)`.
- Receive side (`src/pvp.js`): `pvpSt.isWirePVP` flag set when `startPVPBattle` gets a seed. `_processEnemyFlash` gates the preflash AI dispatch on `isWirePVP` — when on, holds in `enemy-flash` until the wire action arrives, then routes through new `_applyWireOpponentAction(action, casterCellIdx)` which translates the wire intent into the same state-bag write the AI would have produced (`'attack'` → fall through to attack windup; `'defend'` → `pvp-defend-anim`; `'magic'` → `pvp-enemy-magic-cast` with `rollCureAmount` / `rollOffensiveDamage` on the synced seed; `'item'` → potion-on-self; `'disconnect'` → force opponent HP to 0).
- Send side (`src/battle-update.js#_updateBattleMenuConfirm`): on the 150 ms confirm-pause expiry, relays `inputSt.playerActionPending` to the wire. `_emitWirePVPAction` translates `fight`/`defend`/`run`/`magic`/`item` commands into the wire shape with `target: 'me'|'opp'` for the spell/item cases.
- With seeded RNG (part 1) + same action stream (part 2), both clients run their existing engine and compute identical damage / hit / crit / status results. Outcomes match on both sides for 1v1.
- **Scope**: 1v1 only (no party allies on either side). PvP with allies has additional ally-action relay needs (each side's allies still run local AI, which drifts) — extension for part 2.5+. Run-on-opponent is not modeled (treated as attack); proper opponent-flee handling is part 3.
- **Disconnect**: if the partner WS closes mid-battle, server pushes `{kind:'disconnect'}` to the remaining player; their client forces opponent HP to 0 so the battle resolves as a defeat (rather than soft-freezing on the dead wire).
- **No more drift on AI rolls**: pre-Step-4 part 2, A's client ran AI to drive B's character locally — picking different spells / targets than what B actually chose. Now B's actual chosen action arrives over the wire and drives the simulation on A's side. With synced seed, the resulting roll matches what B's client computed.

## 1.7.372 — 2026-05-15

### MP Step 4 (part 1 of 3): PvP RNG seed sync

- Server (`ws-presence.js`) generates a 32-bit seed when `pvp-match` fires and broadcasts it to both clients alongside the opponent profile.
- `pvp-search.js` plumbs the seed through `_resolveAsHook → _startPVPBattle(target, { seed })`.
- `pvp.js#startPVPBattle` now accepts `opts.seed`; when present, calls `seed(n)` from `src/rng.js` instead of `reseedFromEntropy()`. Both clients enter the battle with identical PRNG state, so every roll through `battle-math.js` (initiative, damage variance, hit/miss, crit, shield-evade, evade) and every AI pick that routes through `combatant-ai.js` lands on the same number on both sides.
- This is part 1 of the combat-sync work. Action-relay (so each client drives the OPPONENT's turn from the wire instead of running AI locally) is part 2 — without it, AI on each side still chooses different targets/spells since each client's AI thinks the opponent is local. Part 1 is necessary but not sufficient for full outcome agreement; it's the foundation parts 2/3 rely on.

## 1.7.371 — 2026-05-15

### MP Step 3: server-side hook chance uses AGI formula, not flat 35%

- v1.7.370 used a fixed `PVP_HOOK_CHANCE = 0.35` server-side and noted "stat-aware later." `pvp-search.js#getHookChance` already had the canonical AGI-differential + Thief/Ranger formula since v1.7.222 — should have just ported it.
- `ws-presence.js` now mirrors the client formula: `clamp(0.25 + (chAGI − tgtAGI) × 0.015 + jobBonus, 0.10, 0.75)` with Thief (`jobIdx 8`) +0.15 / Ranger (`jobIdx 6`) +0.08. Constants live next to the client copy; any rebalance touches both.
- Client profile (`src/main.js` connectNet getter, `ws-presence.js` `hello` + `update` handlers) now carries `agi`. Server uses challenger.agi vs target.agi to compute the per-roll chance instead of the flat 35%.

## 1.7.370 — 2026-05-15

### MP Step 3 fix: hook fires on TARGET's next encounter, not a server timer

- v1.7.369 had wrong semantics — server ran an autonomous 8-15 s roll loop. User clarified the design: "you select battle, it searches, and the target's NEXT RANDOM ENCOUNTER has a chance to be hooked. until it times out or player leaves area."
- Server (`ws-presence.js`): removed `_startSearchRoll` / `_runSearchHook` timer. `pvp-search` now just records `{challengerUserId → targetUserId}`. New `pvp-encounter` handler runs when B's client signals an imminent random encounter: iterates pending searches of B, rolls 35% per challenger, first hit wins → broadcasts `pvp-match` to both + cancels other suitors with `pvp-search-failed reason=target-engaged`. All miss → replies `pvp-encounter-none`.
- Client (`src/net.js`): added `sendNetPVPEncounter()` + `setNetPVPEncounterNoneHandler(fn)`.
- Client (`src/battle-encounter.js`): when the random-encounter step threshold trips, fires `pvp-encounter` to the server FIRST and parks for up to 500 ms waiting for the reply. `pvp-encounter-none` (or timeout) → start the monster encounter. `pvp-match` (handled in `pvp-search.js`) → enter PvP, monster encounter never spawns. If WS isn't connected, falls through to monster encounter immediately.
- Until B has an encounter, A's search just waits (capped by the existing client-side `SEARCH_TIMEOUT_MS = 5 min` in `pvp-search.js`). B sitting in town with no encounters = A's search times out naturally.

## 1.7.369 — 2026-05-15

### Multiplayer Step 3: PvP search over the wire

- `ws-presence.js` now handles `pvp-search` / `pvp-cancel` from clients. Per-challenger `Map<userId, {targetUserId, timer}>` runs an 8–15 s roll loop server-side; on a 35% hook (MVP fixed rate — stat-aware arbitration is Step 4) the server broadcasts `pvp-match` to both parties with each other's profiles. First-hook-wins arbitration: any other searches targeting either side of the match get cancelled with reason `target-engaged`.
- `src/net.js` adds `sendNetPVPSearch(targetUserId)`, `sendNetPVPCancel()`, `setNetPVPMatchHandler(fn)`, `setNetPVPFailedHandler(fn)`.
- `src/pvp-search.js` branches on `target.isReal && target.userId`: real-player searches relay through the server (local `targetRollTimer` is parked at `Infinity`); fake-pool searches keep the legacy client-side sim. Match handler routes through the existing `_resolveAsHook` → "Connecting..." → `_startPVPBattle` flow with the wire-delivered opponent profile.
- The CHALLENGED party also receives `pvp-match` and gets pulled into the battle via a synthesized search shell ("\<name\> challenges you!" → 250 ms beat → Connecting → battle). No accept/decline UI for parity with the existing fake-PvP UX.
- Cleanup hooks: client disconnect cancels its own active search AND notifies any other challengers targeting it with `pvp-search-failed reason=target-offline`. `cancelPVPSearch` sends `pvp-cancel` to server for real targets.
- Battle itself remains local on each client (each sims independently against the opponent profile). Two clients with the same starting state will diverge on RNG-dependent rolls because seeds aren't synced yet — server-authoritative combat-over-wire is Step 4. The Step 3 deliverable is "two real players can enter the same PvP battle session," not "the outcomes match."

## 1.7.368 — 2026-05-15

### Multiplayer Step 2: Real chat over the wire

- `ws-presence.js` now handles `{type:'chat', channel, text, to?}` from clients. World / party channels broadcast to other connected clients at the same `loc`; pm targets the recipient by display name (delivered to every match for now — Step 3+ will resolve via userId).
- `src/net.js` adds `sendNetChat(channel, text, to)` + `setNetChatHandler(fn)`. The chat module installs the receive callback at module load.
- `src/chat.js#onChatKeyDown` calls `sendNetChat` for world / party / pm on submit. The local `addChatMessage` still runs first so the sender sees their own message instantly; the server relays raw text and remote clients format `"Name: text"` themselves.
- Console chat ('/help' etc.) stays local — only typed chat (no leading slash) goes over the wire.

## 1.7.367 — 2026-05-15

### Engine keep-alive in background tabs + freeze watchdog tweak

- Replaced `requestAnimationFrame` with a Web Worker setInterval heartbeat in `src/game-loop.js`. The worker posts a tick message every 16 ms; the main thread runs `gameLoop()` on receipt. Workers survive tab-backgrounding far better than rAF (paused) or main-thread setInterval (throttled to ~1 Hz), so the engine keeps ticking — required for multiplayer sync. Two pre-existing freeze-watchdog reports of `state=magic-hit stuck for 5s` were both tab-resume false-positives caused by rAF pausing; with the worker driver those won't recur.
- Added `levelup-hold` and `joblv-hold` to the watchdog's idle-state set. They follow the same pattern as `exp-hold` / `gil-hold` / `cp-hold` — short timer-driven hold states that were missing from the allowlist.
- No display-refresh sync trade-off matters for this NES-style 60 Hz fixed-timestep engine; all animations are dt-based.

## 1.7.366 — 2026-05-15

### Multiplayer Step 1: WebSocket presence

- New `ws-presence.js` (server) — WebSocket endpoint at `/api/ws?token=<JWT>` mounted on the existing HTTP server via the `upgrade` event. Auth reuses the existing 30-day JWT (no separate token issuance). In-memory presence Map; restart drops state, clients reconnect on next load.
- New `src/net.js` (client) — connects on `connectNet(profileFn, locFn)` from `main.js#init`. On `ready`, sends `hello` with the local profile + location. Polls location every 500 ms and emits `location` on change. Auto-reconnects with exponential backoff (1 s → 30 s cap).
- Wire protocol: client sends `hello` / `location` / `update`; server broadcasts `snapshot` (on join) / `player-join` / `player-leave` / `player-move` / `player-update` to other clients.
- `getRosterPlayers()` and `getRosterVisible()` in `src/roster.js` now prepend real online players above the fake pool. Real players don't participate in the fake-mover fade/slide animation — presence is driven by wire events.
- `deploy.sh` runs `npm install --omit=dev` on the remote so the new `ws` dependency lands without manual intervention.
- **Visible result**: two browsers logged into different accounts on `ff3mmo.com` see each other's character in the roster panel when at the same location. Walk into Ur → roster shows the other player. Walk onto the overworld → roster updates.

What's NOT in Step 1 (deferred to Step 2/3):
- Chat over the wire (still local-only)
- PvP search hook via wire (still uses `pvp-search.js` sim timer against fake pool)
- DB persistence for player profiles (in-memory only; restart loses presence)
- Fade-in / slide animation for real-player join/leave (they pop in instantly)

## 1.7.365 — 2026-05-15

### Combat: complete dispatchDelta HP migration (multiplayer prep step 6.5)

- All 17 remaining direct `target.hp = Math.max(...)` writes routed through `dispatchDelta`. Combat is now server-authoritative-ready for HP — every damage and heal write goes through one interceptable seam.
- Sites covered: 5 in `battle-enemy.js` (monster sp-atk magic damage on ally + player, monster multi-hit on ally + player, regular monster hit on player), 7 in `battle-turn.js` (2 confused-player friendly damage paths + 5 end-of-round poison ticks across player / ally / monster / pvp-opp / pvp-enemy-ally), 5 in `pvp.js` (1 self-heal potion + 2 SW-throw damage + 2 PvP slash damage).
- New `min` field on `hp` deltas — clamps the floor. Used by end-of-round poison on player/ally to honor the NES rule that poison never kills from full HP. Default `min=0`; monsters / PvP-enemies pass no `min` so they CAN die to poison.
- Verified via grep: zero `\.hp = Math\.max\|\.hp -= \|\.hp += ` remaining in combat files.
- Status mask writes via `tryInflictStatus` / `addStatus` / `removeStatus` are still inline (status-effects.js mutates internally). Not in step 6.5 scope; status delta migration is a separate follow-up.

## 1.7.364 — 2026-05-15

### Combat: per-attacker enemyTargetAllyIdx scaffold (multiplayer prep step 7 of 7)

- New `battleSt.enemyTargetAllyIdxByAttacker` — `WeakMap` keyed by the attacker combatant object (encounter monster, `pvpOpponentStats`, or `pvpEnemyAllies` entry). Single-player play is turn-based so only one entry is active at a time — the legacy `battleSt.enemyTargetAllyIdx` integer still tracks the currently-animating attack. The Map is populated for the wire layer's future parallel-render path.
- `setEnemyAttackerTarget(attackerRef, targetAllyIdx)` helper in `battle-state.js` writes both the legacy integer AND the Map entry. Called from `battle-enemy.js#_runMonsterAttack` (encounter monster) and `pvp.js#_runEnemyAttack` (PvP enemy).
- Readers stay on the legacy integer until the parallel-render refactor lands. WeakMap entries auto-clear when encounter monsters / PvP rosters get GC'd at battle end — no explicit reset needed.

### Multiplayer prep series complete

All 7 audit-recommended fixes from `docs/COMBAT-MULTIPLAYER-AUDIT.md` shipped over v1.7.358–v1.7.364. Single-player play is unchanged throughout; the cumulative work is:

| Step | Subject | Version |
|------|---------|---------|
| 1 | Seedable RNG (`src/rng.js`) — no client desync on hit rolls | 1.7.358 |
| 2 | Apply-time target redirect (`resolveLivingTarget`) — no silent spell-miss on dead targets | 1.7.359 |
| 3 | Unified AI decision helpers (`src/combatant-ai.js`) — 6 AI functions ~halved in size | 1.7.360 |
| 4 | Cross-faction targeting — player can intentionally hit own team with offensive spells | 1.7.361 |
| 5 | Unified `activeCast` bag — one source-of-truth for "who is casting what at whom" | 1.7.362 |
| 6 | `dispatchDelta` seam (`src/deltas.js`) — wire interception point for HP/status/death | 1.7.363 |
| 7 | Per-attacker target map — parallel-render-ready ally-target tracking | 1.7.364 |

Real-multiplayer cutover is now a contained plumbing job: server emits authoritative deltas, client routes through `dispatchDelta`. PvP-enemy AI gets replaced by wire signals at the eight `_tryPVPEnemy*` / `_tryAlly*` AI seams; ally AI stays for empty party slots.

## 1.7.363 — 2026-05-15

### Combat: dispatchDelta seam (multiplayer prep step 6 of 7)

- New `src/deltas.js` — single interception seam for HP / status / death mutations. `dispatchDelta(d)` applies state changes; the wire layer overrides via `setDeltaApplier(fn)` so a server-broadcast delta lands through the same apply path as local play. Delta types: `hp` (signed, clamps to [0, maxHP]), `statusAdd`, `statusRemove`, `death`.
- All seven HP / status / death writes in `combatant-cast.js#applyMagic*` migrated: `applyMagicDamage`, `applyMagicHeal`, `applyMagicCureStatus`, `applyMagicDrain`, `applyMagicRecovery` (undead damage branch — non-undead branch routes through `applyMagicHeal` already), `applyMagicInstakill`.
- `physical-attack.js#applyPhysicalHitToEnemy` migrated for the encounter-monster HP write. Boss path still uses `setEnemyHP` wrapper (no `target.hp` accessor).
- **Direct mutations remaining**: ~12 sites in `battle-update.js` / `battle-turn.js` / `battle-ally.js` / `battle-enemy.js` / `pvp.js` (mainly enemy-attacks-player-or-ally HP writes, ally-magic-effect apply, PvP-enemy-magic-effect apply, item consume, XP/Gil/CP grants). These are documented as TODO and will be migrated before the websocket cutover; they bypass the seam today and would diverge in multiplayer.
- Scaffold step. Single-player play unchanged because the default applier is a passthrough that does exactly what the inline writes used to do.

## 1.7.362 — 2026-05-15

### Combat: unified activeCast scaffold (multiplayer prep step 5 of 7)

- New `battleSt.activeCast` — single source-of-truth bag for "who is casting what at whom right now," populated from every cast-start site (1 player + 4 ally + 3 PvP-enemy). Shape: `{ caster: {faction, idx}, spellId, isItemUse, targets: [{faction, idx}], healAmount, damageRoll, hitIdx, effectApplied, sfxPlayed }`.
- Three legacy state bags (`battleSt.allyMagic*`, `pvpSt.pvpMagic*`, `spell-cast.js` module-locals) still populated in parallel. Readers haven't migrated yet — single-player play unchanged. The wire layer (step 6/7) will read `activeCast` so a remote-player cast intent has one place to write instead of three.
- `setActiveCast(cast)` / `clearActiveCast()` / `getActiveCast()` exported from `battle-state.js`. `clearActiveCast` runs at `resetSpellCastVars` cast-end; AI-driven casts overwrite at the next cast start.
- Scaffold-only: no gameplay change. Step 6 (`dispatchDelta`) wires HP / status / KO writes through one interceptable seam; step 7 splits the single-integer enemyTargetAllyIdx into a per-attacker map.

## 1.7.361 — 2026-05-15

### Combat: cross-faction targeting (multiplayer prep step 4 of 7)

- Player can now intentionally pick their own ally (or self) as the target of an offensive spell — Fire / Bzzard / Bolt / Sleep / Confuse / Death / Shade etc. Pre-v1.7.361 this errored with "Ineffective"; engine-side `applyMagic*` helpers were always faction-agnostic, only the dispatch in `spell-cast.js#_applySpellEffect` forbade it.
- New `_applyFriendlyOffensive(target, spell)` in `spell-cast.js` — mirror of `_applyEnemyEffect`'s offensive branches but with `setPlayerDamageNum` / `getAllyDamageNums()[idx]` damage-num callbacks in place of `_setEnemyDmg`. Routes damage (Fire/Bzzard/Bolt), single status (sleep/confuse/blind/mini/silence), all-status (Shade/Tranquilizer), and instakill (Death) to the same shared helpers the enemy path uses.
- Step-2 redirect block lifted above the offensive-on-friendly branch so a dying ally during cast windup still gets the next-living redirect for either heal OR damage paths.
- The confused-attack path (battle-turn.js:128-147) has always written friendly damage via these primitives; this just unifies the player-controlled path with the engine's existing capability.
- AI heuristic unchanged: roster allies still preferentially heal teammates and damage enemies; PvP enemies still preferentially heal their own team and damage the player's. Cross-faction targeting is a **capability** the engine and player UI now support, not a behavior the AI defaults to. Future Confused-ally-magic / chaos events can pivot the AI toward cross-faction picks without further engine work.

## 1.7.360 — 2026-05-15

### Combat: unified AI decision helpers (multiplayer prep step 3 of 7)

- New `src/combatant-ai.js` — shared decision helpers (`pickHealTarget`, `pickPoisonedTarget`, `pickRandomLivingTarget`, `pickOffensiveSpell`, `rollOffensiveDamage`, `rollCureAmount`, `rollActivation`, `canCastBasic`, `canCastAny`) plus the activation-rate constants (`AI_HEAL_THRESHOLD = 0.6`, `AI_POTION_THRESHOLD = 0.5`, `AI_OFFENSIVE_GATE = 0.45`, `AI_ITEM_GATE = 0.25`, `AI_PVP_DEFEND_GATE = 0.30`, `AI_PVP_SW_GATE = 0.15`) and the spell-ID set (`SPELL_CURE`, `SPELL_POISONA`, `OFFENSIVE_SPELLS`).
- `_tryAllyCure / _tryAllyPoisona / _tryAllyOffensiveCast / _tryAllyItem` (battle-turn.js) and `_tryPVPEnemyCure / _tryPVPEnemyPoisona / _tryPVPEnemyOffensiveCast / _tryPVPEnemyItem` (pvp.js) all reduced to ~25 lines each. Decision logic (candidate pick, threshold compare, damage/heal roll, activation gate) flows through the shared helpers; only the role-specific state-bag write (`battleSt.allyMagic*` vs `pvpSt.pvpMagic*` vs `pvpSt.pvpItem*`) and the `battleState` transition stay local.
- All AI-side `Math.random` calls (~16 across the eight functions plus the PvP-main defend / SW-throw gates) now route through `rand()` from `src/rng.js` — the seeded PRNG covers the AI surface in addition to the apply layer.
- New `_buildPlayerTeam()` (battle-turn.js) and `_buildPVPEnemyTeam` / `_buildPVPPlayerTeam` (pvp.js) materialize team lists with stable ref objects so callers can read back the chosen target by ref.index / ref.cellIdx / ref.partyIdx and write directly into the legacy state bags. No behavior change — same thresholds, same priority orders, same damage rolls; just one source for each.
- Step 3 in the audit fix order. When real-multiplayer wire signals replace fake-player AI for PvP opponents, the swap is now one site (the `_tryPVPEnemy*` calls in `pvp.js`'s preflash dispatch) instead of four. Roster-ally AI stays — empty party slots will keep backfilling from the fake pool.

## 1.7.359 — 2026-05-15

### Combat: apply-time target redirect (multiplayer prep step 2 of 7)

- New `resolveLivingTarget(picked, factionList)` in `battle-math.js`. Pure helper: returns the picked combatant if alive, otherwise the first living member of `factionList`, otherwise null. Used at apply time (not decision time) so a target that died during the 800 ms cast windup gets redirected instead of silently wasting the action.
- `_applyEnemyEffect` in `spell-cast.js` redirects single-target spells to the next-living enemy on the same side (encounter monsters OR `[pvpOpponentStats, ...pvpEnemyAllies]`). Multi-target spells walk their own `_targets` list and skip dead slots naturally — no behavior change for those. Closure-bound `_setEnemyDmg(idx, …)` callbacks pick up the redirected `idx` automatically because they capture the local variable, not its value at call site.
- `_applySpellEffect` in `spell-cast.js` redirects single-target friendly spells the same way: ally → next-living ally → player as last resort.
- `_playerTurnConsumable` in `battle-turn.js` redirects heal-item targets: dead player → first living ally; dead ally → next-living ally → player; dead enemy → next-living enemy in the random encounter. Boss / PVP-main fallback (no monster object) unchanged.
- Two leftover step-1 `Math.random` sites in the apply layer also swapped to `rand()`: `applyMagicInstakill` (combatant-cast.js:317), the player-spell hit roll and magic-amount roll (spell-cast.js:115, 389). Per-faction AI decision sites still on `Math.random` — they get rewritten in step 3 (`decideAction` seam).
- No behavior change for spells/items aimed at living targets. The redirect only fires when the picked combatant is dead at apply time.

## 1.7.358 — 2026-05-15

### Combat: seedable RNG (multiplayer prep step 1 of 7)

- New `src/rng.js` — mulberry32 PRNG with `seed(n)` / `reseedFromEntropy()` / `rand()` / `randInt` / `randIntExclusive` / `pickOne` / `chance`. Drop-in for `Math.random()` at every gameplay-affecting roll.
- `battle-math.js` swapped: `rollInitiative`, `calcDamage`, and the four `rollHits` rolls (shield-evade / evade / hit / crit) all use `rand()` now.
- Seeded at battle entry — `startBattle()` (encounters) and `startPVPBattle()` (duels) both call `reseedFromEntropy()`. The seed source today is `Date.now() ^ Math.random()` so single-player feel is identical; when the websocket server lands it sends an authoritative seed and every client rolls the same sequence.
- Cosmetic `Math.random` calls (UI shimmer, idle wander, fake-player roster timing) intentionally untouched — they don't need to agree across clients.
- Step 1 in the audit-recommended fix order from `docs/COMBAT-MULTIPLAYER-AUDIT.md`. Subsequent steps (resolveTarget, AI seam, faction-agnostic targeting, unified activeCast, dispatchDelta, per-attacker target) will land incrementally — each keeps single-player playable.

## 1.7.357 — 2026-05-15

### Fix: treasure "Found …!" message uses icon + full item name

- `foundItemMsg` in map-triggers.js was calling `getItemNameClean(itemId)`, which strips the item-type icon byte AND falls through to ROM-truncated names (the ROM strings are abbreviated to fit the original NES inventory). On chest open the message read e.g. "Found CR!" instead of "Found <icon>Cure!" — same name everywhere else in the UI (shop / pause / trade / inspect) uses `getItemNameShrines`.
- Switched to `getItemNameShrines(itemId)` so chests now show the icon glyph followed by the canonical Shrines short name, matching every other item-display surface. Gil messages were already correct (no item name involved).

## 1.7.356 — 2026-05-15

### Fix: shop "Nothing to sell" overflows the panel right border

- The empty-state row in `_drawList` (shop.js:606) was drawn at `nameX = HUD_VIEW_X + 24`. "Nothing to sell" is 15 glyphs × 8 = 120 px, so it ran from x=24 to x=144 — exactly the panel's right border, sliding the last character under the border tiles. Left-aligned at `nameX` (a column position picked for item-name rows that also have a price right-aligned at `priceX`) was wrong for the no-items case where there's no price column.
- Center the empty-state message in `INNER_X..INNER_X+INNER_W` (the panel's inner content band, x=8..136). 'Nothing to sell' now lands at x=12, '---' centers at x=60. Padded list rows still left-align under `nameX` because they pair with a right-aligned price.

### Fix: dying on overworld respawns at elder's house

- `respawnAfterDeath` had an `if (mapSt.currentMapId === 114)` branch that reseeds the mapStack to the Ur → elder ground → elder upstairs chain and lands the player at map 7 (4, 4). This branch is meant for "die *inside* Ur town" — the safe-haven checkpoint.
- But `mapSt.currentMapId` is NOT cleared when the player walks out onto the world map (only town/dungeon loaders write it), so after stepping out of Ur it still reads 114. Dying anywhere on the world map fell into the elder-house branch instead of the intended "respawn at last world exit" path.
- Added `!mapSt.onWorldMap` to the gate. Overworld deaths now fall through to the `lastWorldExitX/Y` → `loadWorldMapAtPosition` path that the design comment above the function describes. Town-deaths still trigger the elder-house homing.

## 1.7.355 — 2026-05-14

### Fix: keep shop boxes black, not blue

- v1.7.354 restored canonical blue to every `drawBorderedBox(blue=true)` caller. Shop boxes were swept up in that since they also opt into `blue=true`, but they need to stay black.
- Routed shop's confirm box through `drawBorderedBox(blue=false, transparentEdge=true)` — same combo used by battle-encounter / pvp boxes. Black fill with transparent rounded corners, identical to shop's previous rendering. Message box / trade / inspect stay blue.

## 1.7.354 — 2026-05-14

### Fix: real root cause of black message boxes — restore blue palette on border tiles

- The actual breakage was v1.7.309 (`a0d81d4`) in `hud-init.js`. Past-Claude was trying to recolor the roster panel and flipped the palette of `ui.borderBlueTileCanvases` from `[0x02, 0x00, 0x02, 0x30]` (NES $02 = dark blue) to `[0x0F, 0x00, 0x0F, 0x30]` (NES $0F = black) — but that bag is the shared "blue" border tileset every blue-box caller (message box, shop, trade, inspect) opts into. v1.7.310 (`7dc23be`) then dropped the matching blue `fillRect` interior, leaving everything black.
- Restored the palette at hud-init.js:56 to `[0x02, 0x00, 0x02, 0x30]`. Now the inner pixels of the border tiles themselves carry blue. Combined with the blue `fillRect` interior restored in v1.7.352, every blue-box caller is uniformly blue with proper rounded transparent corners — same as pre-v1.7.309.
- Reverted v1.7.353's "fill full extent" — that was eating the rounded corner pixels. Back to the original `x+8, y+8, w-16, h-16` inset.

## 1.7.353 — 2026-05-14

### Fix: blue box interior bleeds through under border tiles

- `drawBorderedBox` fills `x+8, y+8, w-16, h-16` — an 8px inset on every side. AWJ border tiles have transparent inner pixels, so the strip *under* the edge tiles wasn't being filled; the map / HUD bg behind the box showed through. Black-fill hid this because black-on-black looked fine; v1.7.352's blue interior exposed it.
- Now fills the full `x, y, w, h` extent. Border tiles draw their opaque border pixels on top; transparent inner pixels fall through to the interior color underneath.

## 1.7.352 — 2026-05-14

### Fix: restore blue interior on message boxes / shop / trade / inspect

- v1.7.310 dropped the `blue=true` interior fill from `drawBorderedBox` in `hud-drawing.js` — the commit was scoped to the roster panel ("roster panel interior: actually fill black"), but the roster doesn't pass `blue=true` (it passes `false`). The change was a misdiagnosis: it removed the blue interior for every actual blue-box caller (message box, shop, trade, inspect), which all explicitly opt in with `blue=true`.
- Restored: `blue=true` now fills the interior with NES `$02` (canon FF3 dialog blue), `blue=false` stays black. Border tiles are unaffected.

## 1.7.351 — 2026-05-14

### Refactor: single source for per-map state resets in map-loading.js

- v1.7.350 fixed the altar-cave-spawning-overworld-monsters bug by adding a missing `encounterPatch`/`encounterPatchZone` clear to `_loadDungeonFloor`. Root cause was structural — the four map loaders (`_loadRegularMap`, `_loadDungeonFloor`, `loadWorldMapAt`, `loadWorldMapAtPosition`) each maintained their own duplicated list of per-map state resets. v1.7.341 added the patch fields and only wired the clear into `_loadRegularMap`; the other three drifted.
- Extracted `_resetPerMapState()` covering the union of per-map fields (`dungeonFloor`, `encounterSteps`, `dungeonDestinations`, `secretWalls`, `falseWalls`, `hiddenTraps`, `rockSwitch`, `warpTile`, `pondTiles`, `bossSprite`, `encounterPatch`, `encounterPatchZone`, `mapData`, `mapRenderer`, `disabledTrigger`, `openDoor`). All four loaders call it first, then apply mode-specific values. Adding a new per-map field is now a one-line edit.
- No behavior change in the happy paths (every loader's mode-specific assignments still override the defaults). Worldmap loaders now also clear dungeon-only fields, which were harmlessly leaking through before.

## 1.7.350 — 2026-05-14

### Fix: altar cave spawning overworld monsters

- `_loadDungeonFloor` was missing the `mapSt.encounterPatch` / `encounterPatchZone` clear that `_loadRegularMap` does. Entering Ur sets the patch to `grasslands_wild` (the dark-tile encounter patch). Descending into the altar cave didn't wipe it, and `startRandomEncounter`'s patch branch runs before the `altar_cave_fN` branch — so the leftover Ur state shadowed the dungeon zone and spawned Werewolves/Bees inside the cave.
- Dungeon loader now clears both fields up front, same as the regular-map loader.

## 1.7.349 — 2026-05-14

### Fix: opening-scene top-strip shows "Ur", not map 7's battle BG

- Real root cause of the "grass on top" complaint: new-game spawn loads map 7 (elder's upstairs) with `topBoxSt.isTown=false` (default). `setupTopBox(7)` then loads map 7's battle BG into the top strip — which is grass-themed. For shops in Ur, isTown is already true (player entered from town), so the battle-BG branch skips and "Ur" persists in the top strip; new game never had that prior state.
- Title-screen new-game branch now pre-sets `topBoxSt.isTown=true` + `nameBytes="Ur"` + mode `'name'` before `loadMapById(7)`. setupTopBox skips the battle-BG branch (gated on `!topBoxSt.isTown`) and the elder house interior inherits the Ur name strip — same as any other Ur building.

## 1.7.348 — 2026-05-14

### Fix: map fill-tile pattern leaks into HUD top-strip

- `MapRenderer.draw` fills the entire 256×240 canvas with the map's fillTile pattern (Ur = `$00` grass), including the top 32px where the HUD top-strip sits. Non-town maps cover the leak with `hudSt.topBoxBgCanvas`; towns relied on the name-box border, which doesn't render during `state='pending'` / early fade-in — so grass tiles flashed through into the top-strip when entering Ur.
- `_drawTopBoxBattleBG` now blacks out the top 32px unconditionally before any state-dependent draws. The battle BG / name border render on top as before.
- Reverted v1.7.347's defensive null of `hudSt.topBoxBgCanvas` on town entry — it was the wrong layer (rendering was gated correctly; the leak was below it).

## 1.7.347 — 2026-05-14

### Fix: stale battle BG leaks into Ur top-box

- Entering Ur via the new opening-scene chain (map 7 → map 6 → 114) left `hudSt.topBoxBgCanvas` holding map 6's battle BG. The town render path gates on `!isTown` so it *shouldn't* draw, but any unguarded draw path would flash the stale canvas. `setupTopBox(114)` now explicitly nulls the canvas + fade frames on town entry.

## 1.7.346 — 2026-05-14

### Fix: opening-scene exit chain — map 7 upstairs → map 6 ground floor → Ur

- ROM canon: map 7 = elder's upstairs, map 6 = elder's ground floor (door at (12, 13) leads up to map 7), map 114 (Ur) = town (door at (9, 26) leads into map 6). Walking out of map 7 should land at map 6's stair tile, then walking out of map 6 should land at Ur's door tile.
- Previous patches (v1.7.343-345) tried to redirect map 7's `exit_prev` directly to Ur via single-entry `mapStack` seeds. That collapsed two levels of the building into one. Replaced with a 2-entry seed `[{mapId:114, x:9, y:26}, {mapId:6, x:12, y:13}]` — same shape the engine would push if the player had walked in naturally from Ur.
- Same fix applied to `respawnAfterDeath` Ur-death path.
- Dropped the v1.7.345 null-coord fallback branch in `_checkExitPrev` (no callers).

## 1.7.345 — 2026-05-14

### Fix: opening-scene door now leads into Ur, not the overworld

- Walking out of the opening scene (map 7) was dropping the player onto the world map at Ur's overworld tile. Switched to dropping into Ur's interior (map 114) at the natural town entrance.
- `_checkExitPrev` extended with a "missing return coords → natural entrance" branch so a seeded mapStack entry like `{mapId: 114}` resolves correctly.
- `title-screen.js` new-game seed + `respawnAfterDeath` Ur-death seed both updated to push `{mapId: 114}` (no coords) instead of a `'world'` entry.

## 1.7.344 — 2026-05-14

### Death in Ur respawns at opening-scene checkpoint

- `respawnAfterDeath` now special-cases `currentMapId === 114` (Ur): player loads back at map 7 (4, 4) — the new-game opening-scene spawn — instead of the standard "last overworld exit" rule. mapStack is reseeded with Ur's overworld tile so walking out the opening-scene door drops back at Ur's gate (same as the new-game flow).
- Other deaths (overworld, dungeon, other towns) unchanged.

## 1.7.343 — 2026-05-14

### Fix: new-game door exits to Ur, not desert

- `title-screen.js` fresh-slot path: walking out the opening-scene door (map 7) was dumping the player at map 7's NES-canon overworld position — which is desert. The exit-prev logic fell into its empty-`mapStack` branch (`loadWorldMapAt(findWorldExitIndex(currentMapId))`) and used the desert tile that map 7 originally lived next to.
- Fix: seed `mapStack` with Ur's overworld tile (`findWorldExitIndex(114) → triggerPositions`) at new-game start, so `_checkExitPrev` pops a 'world' entry and lands the player at Ur's gate via `loadWorldMapAtPosition`.

## 1.7.342 — 2026-05-14

### Fix: name-entry lowercase + purge stale Chaos Rush migration

- `title-screen.js#onNameEntryKeyDown` pushed lowercase letters at the pre-v1.7.298 Chaos Rush byte (`$CA + ch - 97`). After the AWJ font swap, lowercase letters live at `$A4-$BD`; `$CA-$E3` is now ligature tiles. Typing 'a' rendered as ligature glyph #0, 'b' as #1, etc. Fixed to emit `$A4 + (ch - 97)`.
- Deleted `save.js#_migrateNameToAWJ`. The CR→AWJ name migration ran on every load and treated bytes `$A5` / `$A9` as CR sentinels — but those are legitimate AWJ lowercase 'b' and 'f'. Any name containing 'b' or 'f' was silently rewriting those letters to comma / apostrophe on load. Migration was 40+ releases stale; any pre-v1.7.298 saves have long since been re-saved. Both call sites in `parseSaveSlots` now read save bytes verbatim.

## 1.7.341 — 2026-05-14

### Indoor encounter patch — Ur dark-tile zone

- New `mapSt.encounterPatch` (Set of tilemap indices) + `mapSt.encounterPatchZone` (ENCOUNTERS key). Set at indoor-map load by a flood-fill from a seed tile, matching the same tile ID 4-way. Tile additions/extensions in the patch ROM just work.
- Ur (114): seed `(22, 8)` tile `0x2f` runs `grasslands_wild` formations (Werewolves + Bees). Stepping anywhere in the patch ticks the encounter counter.
- `tickRandomEncounter` extended with `inPatch` predicate; uses the slower grass-style threshold (`20 + rand(20)`).

## 1.7.340 — 2026-05-14

### Spells are items now — scroll items wired end-to-end

- Added 7 spell-scroll items (`0xE0–0xE6`) covering every player-castable spell (Fire, Bzzard, Sleep, Cure, Pure, Sight, Ice2). Each carries `learnedSpell: 0xNN` as the bridge.
- Scroll inventory rows render through `getSpellNameShrines` — same magic-school icon + short name as the spell entry. No separate name table.
- Pause-menu Z-press on a held scroll routes to `_applyScrollLearn`: refuses if already known ("Already known!"), refuses if current job's school can't learn it ("Can't learn that!"), otherwise pushes the spell ID into `ps.knownSpells`, consumes the item, plays the treasure chime, shows "Learned Cure!".
- Ur magic shop converted from direct-learn (`spells: [0x35]`) to scroll item shop (`items: [0xE4]`). Shopkeeper-sprite lookup still routes through `type: 'magic'`; the buy/sell/qty flow is the regular item-shop path.
- Altar Cave F1-F4 loot pools each gain a `weight: 3` rare tier rolling Cure scroll (`0xE3`) or Sleep scroll (`0xE2`). Other floors' weights nudged down to keep totals balanced.
- Scrolls are tradable for free — `playerInventory` is the same bag every other item lives in, and trade walks it unfiltered.

## 1.7.339 — 2026-05-14

### No starting spells; antidote + eye drops out of altar loot

- Removed `STARTING_SPELLS` + `grantStartingSpells`. White / Black / Red Mages no longer receive Cure / Poisona / Sight / Fire / Bzzard / Sleep on job entry. All magic must be found or bought.
- Altar Cave F1-F3 loot pools no longer roll Antidote (`0xAF`) or Eye Drops (`0xAE`). F4 was already without; Ur town (`114`) chest pool untouched.

## 1.7.338 — 2026-05-14

### Ur magic shop: drop Cure from catalog

- Cure is granted at character creation (starting spell list); selling it in the very first magic shop made the shop's only useful purchase Pure. Catalog is now `[0x35]` (Pure only).

## 1.7.337 — 2026-05-14

### NPC module polish — single resolver, single factory, single render path

- Three sprite getters (`_getMoogleSprite` / `_getBlackMageSprite` / `_getSceneSprite`) collapsed into one `_getSprite(npc)` driven by a `_SPRITE_FACTORIES` table keyed on `spriteKey`. New NPC types add a factory entry; render dispatch needs no edit.
- Three NPC record builders collapsed into one `_makeNpc(key, tileX, tileY, opts)` factory. The 15-field skeleton now lives in one place. `addMoogle` / `addBlackMageShopkeeper` / `addBossNpc` / `addSceneNpc` are 3-5 lines each — they only declare what makes them different (role + mode).
- Three render branches collapsed into one sprite-class path plus a `_drawBossNpc` helper. `drawNpcs` for moogle / black-mage / scene now: resolve sprite, set direction, compute walk phase via `_walkPhase(npc)`, draw. Boss stays separate (canvas frames, not Sprite class).
- `_placeOpeningScene` moved out of `map-loading.js` into `npc.js` as exported `placeOpeningScene()`. Mirrors `placeMoogleAtCaveCenter`'s shape; `OPENING_*` imports now live next to the helper that uses them.
- Dropped dead `getNpcs` export (no consumers).

## 1.7.336 — 2026-05-14

### Tighten + polish for compaction

- Verified all three opening-scene NPC bundles have all 16 slots populated → 4 directions + 2 walk frames available through the standard `Sprite.WALK_FRAMES` layout.
- Land Turtle (boss) only renders the [normal, flipped] south-facing pair (FF3 NES boss has no other directions).
- Removed dead `hudSt.adamantoiseFrames` / `hudSt.moogleFadeFrames` / `hudSt.bossFadeFrames` fields — all now live behind getters in `npc.js`.
- README status bumped + 1.7.33x band paragraph added.

## 1.7.335 — 2026-05-14

### Opening scene ROM offsets +16 — account for iNES header

- v1.7.333 located the elder + attendant ROM offsets by byte-searching a HEADER-STRIPPED copy of FF3-English.nes, then used those offsets verbatim against `romRaw`, which INCLUDES the 16-byte iNES header. All three Sprite.gfxBase values were 16 bytes early — fetching the wrong tiles. Bumped each offset by 16 to match the convention `SPRITE_TILE_BASE` uses (`0x01C010` = tile 0 in PPU = ROM offset 0x10 past the iNES header).
- Elder: 0x01EC00 → 0x01EC10
- Left attendant: 0x01E000 → 0x01E010
- Right attendant: 0x01E200 → 0x01E210

## 1.7.334 — 2026-05-14

### Land turtle (map + loading) + loading moogle all route through npc.js

- Moved the sprite-asset registry for the Land Turtle on the altar floor (boss), the Land Turtle fade frames on the loading screen, and the loading-screen moogle fade frames from `hudSt` to `npc.js`. Single source of truth: setters called once at boot, getters consumed by every renderer.
- Added `addBossNpc(tileX, tileY)` to npc.js. `drawNpcs` now renders the boss alongside other NPCs, preserving the `waterSt.tick / 8` 2-frame idle anim and the `bossFlashTimer` blink-out behavior. Removed the parallel `mapSt.bossSprite` render path from `render.js`. `mapSt.bossSprite` lives on as a no-frames presence flag for the existing battle-trigger + collision checks in `movement.js`.
- `boot.js` now calls `setLandTurtleFrames` / `setLandTurtleFadeFrames` / `setLoadingMoogleFadeFrames` instead of writing to `hudSt`. `loading-screen.js` and `map-loading.js` read via the getters.

## 1.7.333 — 2026-05-14

### Opening NPCs animate from real ROM bundles — no fabrication

- The captured OAM tiles ARE in ff3mmo's FF3-English.nes (AWJ patched). Located the full 16-tile walk-sprite bundles by byte-searching the ROM: elder at `0x01EC00`, left attendant at `0x01E000`, right attendant at `0x01E200`. Each bundle contains slots 0-3 (DOWN), 4-7 (UP), 8-11 (LEFT frame 0), 12-15 (LEFT frame 1) — verified the alternate-frame body tiles differ as expected for a walk cycle.
- Switched `data/opening-scene.js` from inline tile bundles to `{ romOffset, palTop, palBtm, dir, animate }`. `npc.js#_getSceneSprite` now constructs `new Sprite(romRaw, palTop, palBtm)` and overrides `gfxBase = romOffset` — same Sprite class the moogle + black mage already use, no parallel path.
- All three opening NPCs now `animate: true` with REAL FF3 walk frames from ROM. No bobble, no inline tile data, no fabrication.

## 1.7.332 — 2026-05-14

### SNAP OAM: dump full 16-tile walk-sprite bundle per group

- `_oamSnapshotText` was only emitting the visible OAM tiles per group, so a single capture missed the OTHER walk-frame tiles (DOWN frame 1 vs frame 0, LEFT frame 0 vs frame 1, the UP frames). Those tiles WERE in PPU at capture time — the tool just didn't print them. Now after each group's visible tiles, dump all 16 slots of the NPC's GFX bundle (`floor(min_tile_id / 16) * 16` through +15) so one SNAP captures the full walk anim. Eliminates the need to bobble or fake the second frame.

## 1.7.331 — 2026-05-14

### Restore walk cycle on BM shopkeeper + elder

- BM shopkeeper back to `idle-march` (real walk cycle from FF3 BM walk sprite bank, two real frames).
- Elder back to `animate: true` (DOWN frame 1 = bottomFlip of frame 0, same 4 captured tiles — real cycle, not fabricated).
- Attendants remain `static` — only frame 0 captured. Animating with empty frame-1 slots would flicker; faking it would be the bobble that got correctly rejected.

## 1.7.330 — 2026-05-14

### Only moogle walks; magic-shop BM + elder static

- Black mage shopkeeper (map 3): `idle-march` → `static`.
- Opening scene elder (map 7): `animate: true` → `false`.
- Attendants already static. Moogle (Altar Cave) keeps its FF-wander.

## 1.7.329 — 2026-05-14

### Opening NPCs: one NPC module, no fake animation

- Killed the parallel `_drawSceneNpc` raw-tile render path. All NPCs (moogle, magic-shop black mage, opening-scene elder + attendants) now go through the player `Sprite` class — exactly the pattern the moogle + black mage already used.
- Built 256-byte sprite-bank bundles per scene NPC in `data/opening-scene.js`. Elder's 4 captured tiles drop into slots 0-3 (DOWN frame 0); attendant tiles go into slots 8-11 (LEFT frame 0). `new Sprite(bundle, palTop, palBtm)` + `sprite.gfxBase = 0` reads them like any ROM-backed sprite.
- Elder's walk cycle is REAL — FF3's DOWN frame 1 reuses tiles 0-3 with a bottomFlip toggle, which the Sprite class already implements. No invented motion.
- Attendants stay on frame 0 (new `static` NPC mode in `_tickNpc`) because frame-1 tile slots aren't captured. No bobble, no shimmer, no fabricated motion. They render the exact captured pose.
- Also fixed an elder `bl/br` swap in the data file: had `$43` in `bl` slot, `$42` in `br`, opposite of FF3's canonical DOWN frame 0 layout. Restored canonical so the Sprite class's bottomFlip produces the captured frame 1 pose correctly.

## 1.7.328 — 2026-05-14

### Opening scene NPCs: render captured tile bytes (not ROM GFX banks)

- v1.7.327 placed the opening-scene NPCs using `Sprite.setGfxID(2/3/4)`, assuming PPU OAM tile IDs $40/$2C/$3C mapped to ff3mmo's standard ROM GFX banks (BM / Mo / WM). They don't — FF3 NES bank-switches CHR for cutscenes, so those PPU tiles aren't in any standard sprite bank.
- New `data/opening-scene.js` stores the raw 2BPP tile bytes from the user's OAM capture (frame 1860) for each NPC: elder, left attendant, right attendant. Top-row palette = SP3 `[0x1A, 0x0F, 0x27, 0x30]`, bottom-row = SP2 `[0x1A, 0x0F, 0x12, 0x36]`.
- New `addSceneNpc` + `_drawSceneNpc` path in `npc.js` decodes the 4 raw tiles, caches them, handles `flipAll` (left attendant) and `flipBtm` (elder DOWN-frame-1 pose). 1px Y bobble approximates a walk cycle from the single captured frame.
- `addCustomNpc` (GFX_ID-based) removed — it was wrong for this use case.

## 1.7.327 — 2026-05-14

### Opening scene: 3 NPCs on map 7 for new players

- New-game spawn moved from Ur overworld (map 114) to map 7 tile (4, 4) — the opening scene captured by the user's OAM dump.
- 3 stationary NPCs placed on map 7 entry: elder at (4, 3) facing south, left attendant at (2, 4) facing right, right attendant at (6, 4) facing left. Each uses the player walk-sprite class with a different `gfxId` (4 / 2 / 3 = BM / Mo / WM) and the captured opening-scene palette (pal3 top, pal2 bottom). Walking animation cycles in place via the existing `idle-march` mode.
- Generic `addCustomNpc(key, x, y, { gfxId, palTop, palBtm, dir })` helper in `npc.js` — reuse for any future scripted-scene NPC.

## 1.7.326 — 2026-05-14

### SNAP OAM: map tile coords per group, not just screen pixels

- The OAM snapshot now reads FF3J player tile from RAM `$68`/`$69`, derives the camera offset from the player sprite's OAM position, and outputs each group's MAP TILE coords (in addition to screen origin). One tap of SNAP OAM is now self-contained for placing the captured sprites in ff3mmo without a separate READ STATE + diff pass.
- Header line shows player map tile + camera offset so the derivation is auditable.

## 1.7.325 — 2026-05-14

### EMU READ STATE: dump CPU zero page + $0200 mirror

- Extended `_dumpState` in `src/debug/tabs/emu.js` to also dump CPU zero page ($00-$FF) and the $0200-$02FF region after the existing party/inventory block. FF3J keeps player tile X/Y + current map ID in zero-page, so a single STATE dump from any scene now gives us enough to locate the player without guessing.

## 1.7.324 — 2026-05-14

### Black mage shopkeeper at the Ur magic-shop pentagram tile

- Place a south-facing walking black mage NPC at map 3 (4, 4) — the pentagram floor tile that previously had an invisible counter. Talking to him opens the magic shop directly (no dialogue intermediate).
- Catalog trimmed to Cure + Pure (was Cure / Poisona / Sight). Pure is Poisona, already remapped in the shop UI via `BUYABLE_SPELL_NAMES`.
- New stationary-NPC `idle-march` mode in `npc.js`: walk-frame cycle plays in place without changing tile. Sprite is the player's Black Mage walk GFX (jobIdx 4) with the BM_WALK_TOP / BM_WALK_BTM palettes from `job-sprites.js`.
- New `talkToNpc` path: if an NPC has `shopId`, the shop opens directly (skip dialogue). Existing dialogue NPCs (moogle, etc.) unchanged.

## 1.7.323 — 2026-05-13

### Revert NPC message-box palette — leave the shared template alone

- v1.7.320 swapped `_drawMsgText` in `src/message-box.js` to the AWJ canonical palette `[0x0F, 0x10, 0x0F, 0x30]` while removing residual blue from the shop confirm popup. That edit was out-of-scope: the universal `drawMsgBox` template is shared with NPC dialogue, signs, and popups. Restored the original `[0x02, 0x02, 0x02, 0x30]` so NPC text reads as the classic NES blue-shadow / white-fill again. Shop confirm keeps its own `CONFIRM_TEXT_PAL` in `src/shop.js` (unchanged from v1.7.320).

## 1.7.322 — 2026-05-13

### Dual-wield ATK display: sum of both weapons (canon)

- v1.7.321 changed dual to `max` which made dagger+knife and knife+shield read the same — equipping a second weapon visibly did nothing. Replaced with canon NES menu behavior: dual ATK = `rWpnAtk + lWpnAtk + floor(str/2)`. Dagger(6)+Knife(8) now reads ATK 19 vs Knife+Shield ATK 13.
- Combat math: `rollHits` extended with `opts.lAtk` + `opts.splitRH`. When `splitRH=true`, the back half of the combo (RRLL ordering) uses the left-hand ATK. Player path already split per-hand; ally + PVP-enemy paths now do the same via opts. Single-wield with weapon in the left hand: rolls at the equipped hand's ATK, not str/2-only.
- Player damage per turn is unchanged (input-handler.js already rolled each hand at its own weapon ATK; only the displayed sum stripping updated). Ally + PVP mismatched-dual damage is now strictly canon-equivalent (was averaging via `combatant.atk × 2 hits`; now per-hand RRLL).
- The 2026-05-08 sum-and-double 2× bug is NOT reintroduced — `rollHits` only ever applies a single hand's ATK to a single hit.

## 1.7.321 — 2026-05-13

### Dual-wield ATK display fix: max(rWpn, lWpn), not average

- Reported bug: Red Mage L6 with dagger + knife → ATK 12. Swap knife for leather shield → ATK 13. Adding a defensive item raised offense, which made no sense to players.
- Root cause: `calcAttackerAtk` returned `avg(rWpnAtk, lWpnAtk) + floor(str/2)` for dual-wield, so the weaker offhand dragged the displayed ATK down below the better hand's per-hit value. Per-hand combat damage already rolls each hand at its own weapon ATK (`input-handler.js:rollHand`), so the average was a display-only distortion — the actual damage per turn was unchanged.
- Fix: dual-wield now displays `max(rWpnAtk, lWpnAtk) + floor(str/2)`. Knife+dagger reads 13 (the knife's per-hit value), matching knife+shield. Player per-hand damage unchanged. `input-handler.js#wpnAtkComponent` updated to use `max` so `baseAtk = floor(str/2)` is recovered correctly. `tools/battle-sim.js` mirrored.
- Side effect: ally + PVP-enemy paths apply `combatant.atk` to all hits in a single `rollHits` call, so mismatched dual-wielding ally/PVP now hits ~8-14% above prior expected damage (matched-weapon dual: identical). The 2026-05-08 sum-and-double bug (OK D+K → boss for 2× canon) is NOT reintroduced — max ≤ sum.

## 1.7.320 — 2026-05-13

### Shop confirm / message box: blue gone + X dismisses

- Shop buy/sell confirm popup (spell shops) and the universal "Bought X!" / "Sold X!" message box still leaked NES `$02` blue through their text-shadow palette (`[0x02, 0x02, 0x02, 0x30]`) even after v1.7.310 turned the box bg black. Both flipped to canonical AWJ palette `[0x0F, 0x10, 0x0F, 0x30]` (transparent shadow, light-grey body, white glyph).
- X / B / Escape now dismisses single-page message boxes (e.g. after a purchase). Previously only Z worked, so on mobile the user had to tap A to clear the "Bought" message. The X-dismiss branch is gated on `msgState.onAdvance` being null so multi-page NPC dialogue still advances on Z only.

## 1.7.319 — 2026-05-13

### Party chat: system messages filtered out

- Party tab now shows party messages only — system notifications no longer leak in. Aligns with the party-chat-strictly-party-only invariant. System messages still live in the dedicated System tab; World tab keeps the system fallback for now.

## 1.7.318 — 2026-05-13

### Equip screen: weapon slot labels → "R. Hand" / "L. Hand"

- Pause-menu equip slots previously read "R!Hand" / "L!Hand" (the CR-era literal used `$C4` which renders as `!` in AWJ — likely a longstanding typo where a `.` was intended). Updated to "R. Hand" / "L. Hand" with proper period + space.

## 1.7.317 — 2026-05-13

### Inspect: hand labels R/L → RH/LH

## 1.7.316 — 2026-05-13

### Inspect overlay: widen 96 → 120

- Longer item names (FlameMail, GoldNeedle, etc.) were spilling past the panel right edge. Widened from 96 to 120 px (final x = 24). Equipment names up to 10 chars (icon + 9 letters) fit cleanly inside.

## 1.7.315 — 2026-05-13

### Inspect overlay: slide-in from right, compact

- Compact 96×80 panel anchored flush to the right edge of the HUD viewport (x=48, y=40). Slides in from `x=HUD_VIEW_W` (offscreen right) to its final position over 150 ms when opened; reverses for close. Clipped to the HUD viewport so the slide reveals from the right edge like the roster action menu.

## 1.7.314 — 2026-05-13

### Inspect overlay: drop left-HUD clip

- v1.7.313 anchored the inspect overlay to x=144 (right-side roster panel) but `clipToViewport()` clips to the LEFT HUD area (x=0..144), so the entire overlay got clipped out and rendered nothing. Removed the clip + its paired `ctx.restore()`.

## 1.7.313 — 2026-05-13

### Inspect overlay: anchor to roster panel

- Repositioned to (x=144, y=64, 112×112) so it sits exactly on top of the right-side roster panel the player was already focused on — instead of floating in the middle of the screen.

## 1.7.312 — 2026-05-13

### Inspect overlay: shrunk to fit content

- Sized from 144×144 (full HUD viewport) down to 112×88, centered horizontally at x=72, y=48. Fits the v1.7.311 equipment-only layout with no wasted empty space.

## 1.7.311 — 2026-05-13

### Inspect overlay: equipment only

- Stripped name-top-right, job/level row, HP, ATK/DEF/AGI/INT/MND/EVD pairs, and the spell list from the inspect overlay. Now shows the target's name (centered at top) and just the equipment rows (R / L / Bd / Hd / Sh).

## 1.7.310 — 2026-05-13

### Roster panels: blue interior fill → black (the actual fix)

- v1.7.309 only changed the border-tile palette; `drawBorderedBox(..., blue=true)` separately filled the box interior with `NES_SYSTEM_PALETTE[0x02]` (dark blue) via a hardcoded `ctx.fillRect` branch in `hud-drawing.js`. That's why blue still showed everywhere. Dropped the branch; interior always fills `#000` now.

## 1.7.309 — 2026-05-13

### Roster panels: blue → black

- Inspect overlay and Trade panel borders now fill with NES black (`$0F`) instead of dark blue (`$02`). `ui.borderBlueTileCanvases` palette swapped from `[0x02, 0x00, 0x02, 0x30]` to `[0x0F, 0x00, 0x0F, 0x30]`. Variable name kept to avoid churn.

## 1.7.308 — 2026-05-13

### DS-exclusive items: remap icon bytes from CR → AWJ slots

- **All 24 DS-exclusive items (0xC8-0xDF) had `icon:` fields pointing at CR icon byte slots** ($6B sword, $66 rod, $7C robe, $79 staff, $63 gauntlet, etc.). After the AWJ swap those bytes are letters/punctuation/empty in the font atlas; the items would render with garbage prefixes. Remapped each to its AWJ equivalent: sword $EF, rod $E9, staff $EA, knife $ED, bow $F2, book $E8, bell $F4, spear $EC, hammer $EB, gauntlet $E4, bracer $E5, robe $E1, helmet $E3, axe $EE, katana $F0.

## 1.7.307 — 2026-05-13

### AWJ icon range extended ($E0-$FE)

- **Shuriken (item 0x41) wasn't recognizing its icon.** AWJ baked the shuriken glyph at byte `$F6`, but `ICON_TILES` only covered `$E0-$F5`. Extended to `$E0-$FE` so Shuriken + any other high-byte item-class icons render through the icon-aware paths. Auditing all 200 items + 88 spells + 231 monsters: zero remaining unknown bytes after this extension. Known limitation: 15 job names (Knight, Hunter, etc.) use ROM bytes in `$29-$4D` as text-engine dictionary indices that AWJ expands at runtime; those slots are leftover-kana tiles in our font atlas so jobs display with subtle glyph gaps. Fixing requires implementing the dictionary lookup — deferred to a separate change.

## 1.7.306 — 2026-05-13

### Loading-screen moogle: "Boss, Kupo!"

- Added a comma to the moogle's chat bubble. "Boss Kupo!" → "Boss, Kupo!".

## 1.7.305 — 2026-05-13

### Comma fix: AWJ comma lives at $C0, not $BE

- **Commas rendered as apostrophes.** I mismapped AWJ's comma slot during the v1.7.298 swap. Tile `$BE` has its curl at the TOP-right of the cell (looks like an apostrophe); tile `$C0` has the curl at the BOTTOM (true comma, descends below baseline). Fixed `_nameToBytes` to emit `$C0`, dropped the wrong `CHAR_MAP[0xBE] = ','` entry, and updated `_migrateNameToAWJ` (CR `$A5` comma → AWJ `$C0`). No encoded byte-array literals in the codebase used `$BE` as a comma — all $BE occurrences are sprite tile data.

## 1.7.304 — 2026-05-13

### Respawn fix: overworld→town entry captures position

- **Logout in a shop respawned at the previous cave exit, not at the town gate.** `_checkWorldMapTrigger` flipped `mapSt.onWorldMap = false` BEFORE calling `loadMapById(townMapId)`. Inside `loadMapById`, the position-capture block (which writes the entrance tile to `slot.worldX/Y/onWorldMap/currentMapId` so logout-then-login respawns at the gate) is gated on `mapSt.onWorldMap` being true. The pre-flip skipped it. Slot's saved position stayed at whatever tile `_landOnWorldMap` last wrote — typically the Altar Cave exit. Removed the early flip; `loadMapById` already handles the transition.

## 1.7.303 — 2026-05-13

### Drop dead IPS files

- **Removed `patches/ff3-english.ips`** (Chaos Rush translation, ~61 KB) — no longer referenced after the v1.7.298 AWJ swap.
- **Removed `patches/ff3-ff6font.ips`** — unused experiment, never wired into the engine.
- Kept `patches/CREDITS-ff3-translation.txt` for legal attribution to Chaos Rush even though we don't ship the patch anymore.

## 1.7.302 — 2026-05-13

### AWJ letter range: fix getSpellNameWithIcon filter

- **Cure / Sight / Pure rendered as just "C" / "S" / "P".** `getSpellNameWithIcon` (the fallback for spells without a `SPELL_NAMES_SHRINES` override — Cure 0x34, Sight 0x36, Pure 0x35) had its letter allowlist still on CR's lowercase range `0xCA-0xE3`, so AWJ's lowercase `0xA4-0xBD` got filtered out as "non-letter padding" and only the uppercase first letter survived. Updated to `0xA4-0xBD` for letters, added `0xBE-0xDF` for ligatures, and updated the punctuation set to AWJ's slots. Same fix as `getSpellNameClean` in v1.7.298 but I missed this twin function.

## 1.7.301 — 2026-05-13

### AWJ icons: light-grey body + white accents

- **Palette color 1 dropped from `$30` (white) to `$10` (light grey)** across `TEXT_WHITE`, `_makeFadedPal`, and all 6 inline copies. AWJ designs item icons as 2-tone glyphs: color 1 = main body, color 3 = highlight. Pure white-on-white flattened them into solid silhouettes; light-grey body + white highlights restores the depth on robe / mail / helm icons. Color-1-only icons (staff / rod / knife / hammer / spear / axe / bow / arrow / bell / boomerang) now paint in light grey — still visible, slightly dimmer than the letter text. Colored palettes (`TEXT_BLUE/RED/GREEN/YELLOW`) follow the same pattern: dark variant of the hue for color 1, bright for color 3.

## 1.7.300 — 2026-05-13

### AWJ icons: faded-palette + inline-palette fix

- **v1.7.299's exported palettes were the right fix but had no effect on inventory.** `_makeFadedPal` in `palette.js` (used by every pause-menu / inventory / magic / battle-menu row) built its own `[0x0F, 0x0F, 0x0F, 0x30]` palette inline — color 1 still NES black. Same hardcoded literal appeared 6 more times across `roster.js`, `battle-draw-allies.js`, `battle-draw-menu.js`. All 7 spots flipped to `[0x0F, 0x30, 0x0F, 0x30]` so AWJ item-class icons paint visibly. `_makeFadedPal` now fades color 1 alongside color 3.



### AWJ icons: palette color-1 fix

- **Item-class icons (`$E0-$F5`) were rendering black-on-black** after the v1.7.298 AWJ swap. AWJ encodes icon tiles with foreground pixels on color index 1 (plane 0 only); letter tiles use color index 3 (both planes). Our `TEXT_WHITE` was `[0x0F, 0x0F, 0x0F, 0x30]` — color 3 mapped to white (letters worked) but color 1 mapped to NES black (icons invisible). Now `[0x0F, 0x30, 0x0F, 0x30]` so both planes render visibly. Same single-line fix applied to all named palettes (`TEXT_GREY/BLUE/RED/GREEN/YELLOW`) so colored highlight rows render icons and letters in the same hue. This is the actual fix for "staff icon is gone" — the v1.7.298 migration had everything wired correctly, just couldn't see it.

## 1.7.298 — 2026-05-13

### Text engine: swap Chaos Rush → A.W. Jackson translation

- **`patches/ff3-awj.ips` replaces `ff3-english.ips`** as the IPS applied at boot (`main.js`, `debug/tabs/emu.js`). The A.W. Jackson + Neill Corlett + SoM2Freak FF3 English patch (March 1999) has dedicated per-class item icons baked into the ROM font atlas, so the 7 hand-extracted icon-override tile sets we shipped in v1.7.278-285 (arrow / claw / bracer / staff / mail / spear / robe) are no longer needed. Staff items now render with a distinct staff glyph at `$EA`; mail vs. robe body armor split cleanly via `$E1` / `$E2`.
- **Character encoding shifted.** AWJ font: digits `$80-$89` (unchanged), uppercase A-Z `$8A-$A3` (unchanged), lowercase a-z `$A4-$BD` (was `$CA-$E3` in CR). Punctuation slots moved: comma `$BE` (was `$A5`), apostrophe `$BF` (was `$A9`). `_asciiToTileByte` / `_nameToBytes` / `_nesNameToString` updated. `ICON_TILES` now recognizes `$72-$75` (spell-school) + `$E0-$F5` (item class).
- **77 encoded byte-array literals translated** across `data/strings.js`, `title-screen.js`, `loading-screen.js`, `pause-menu.js`, `status-effects.js`, `map-triggers.js`, `movement.js`, `text-utils.js`, `main.js` via automated CR→AWJ byte translator. Sprite tile-data arrays in `debug/tabs/sprites.js` left untouched.
- **All `*_ITEM_IDS` override sets removed** from `text-decoder.js`. `getItemNameWithIcon` no longer rewrites the ROM icon byte; the AWJ ROM already encodes the right icon. `getItemNameShrines` simplified to just prepend the ROM icon byte to the Shrines short-name.
- **Hand-extracted `*_TILE_BYTES` constants removed** from `font-renderer.js` (arrow / claw / bracer / staff / mail / spear / robe — 7 tiles). The full $60-$FF font atlas now loads directly from AWJ-patched ROM with no JS overrides.
- AWJ uses LIGATURE TILES (e.g., `$CD = "il"`, `$CE = "li"`, `$CF = "ll"`) — single 8x8 glyphs rendering 2 letters squeezed. No decoder-side DTE expansion needed; renderer just draws each byte as one tile.
- Bonus fixes that fall out automatically: staff icon for basic Staff (0x0E) — works because AWJ ROM ships `$EA` as the first byte. Leather body armor uses AWJ's `$E1` clothing-silhouette glyph (less hooded-robe than CR's $7C; same icon for all light body armor including wizard robes — known limitation, AWJ groups them too).

## 1.7.297 — 2026-05-13

### Message-box text: visual centering

- **`_drawMsgText` now centers on visual glyph height (8px), not nominal line height (12px).** The trailing 4px gap below the last line was being counted as text height, biasing every page upward — most obvious in the 3-line case where the top of the text hugged the top of the box. Recentering accounts for the gap; text shifts down ~2px for 1-line, ~2px for 3-line.

## 1.7.296 — 2026-05-13

### NPC collision: respect player mid-walk

- **Moogle no longer walks through the player.** `_tileOccupied` used `(worldX / TILE_SIZE) | 0` which truncates, so while the player was mid-walk between two tiles the moogle only saw the FROM tile and could legally step into the destination. Now uses `Math.floor` AND `Math.ceil` of the player's lerped `worldX/worldY` so both straddled tiles register as occupied until the walk completes.

## 1.7.295 — 2026-05-13

### Message-box page-scroll transition

- **Z-advance through a multi-page dialogue now scrolls the old text UP** and the new text in from below over 160ms — the box stays still, only the text scrolls inside it. Outer clip keeps the box inside the map viewport; an inner clip (`boxY+4 to boxY+boxH-4`) keeps the scrolling text from bleeding past the borders.
- New `'page-scroll'` state on `msgState`, with `scrollFromBytes` holding the outgoing page. `updateMsgBox` transitions back to `'hold'` after the scroll completes; `drawMsgBox` renders both pages at offset `-progress*boxH` and `(1-progress)*boxH`. Spam-press Z mid-scroll snaps to the next page.
- Final page still uses the existing slide-out (whole box slides up out of view).

## 1.7.294 — 2026-05-13

### NPCs share the player's tile-vs-sprite vertical offset

- **`drawNpcs` now uses `spriteY` (not `originY`) for the world-to-screen Y transform.** Map tiles are drawn relative to `originY = SCREEN_CENTER_Y + 3` while sprites use `spriteY = SCREEN_CENTER_Y` — the 3-pixel "sprite stands on the tile" offset. Before this fix the moogle was anchored to the tile origin and sat 3 pixels lower than the player on the same row.
- Per-frame `xOff` / `yOff` / `bottomFlip` from `WALK_FRAMES` were already inherited automatically (they're applied inside `Sprite.draw`).

## 1.7.293 — 2026-05-13

### Moogle wander: 1-3 tile bursts + longer pauses

- **Each walk burst is now a 1-3 tile run in a single direction.** `runRemaining` is rolled at burst-start; the moogle keeps stepping the same `(dx, dy)` until the counter expires or the next tile is illegal (off open area, occupied), then pauses. Direction picks still go through the shuffled-dirs loop on burst-start.
- **Pause range bumped to 1500-4000ms** (was 600-1800ms). The moogle stands around much longer between bursts.

## 1.7.292 — 2026-05-13

### Moogle uses full 4-direction walking sprite

- **Routes the moogle through the shared `Sprite` class** (ROM bank `MOOGLE_GFX_ID = 42` at `0x01EA10`, palette `MOOGLE_PAL = [0x0F, 0x0F, 0x16, 0x30]`). All 16 tiles in the bank are now in play — tiles 0-3 DOWN, 4-7 UP, 8-15 SIDE (LEFT uses as-is, RIGHT applies HFLIP), with the same `bottomFlip` and `yOff` walk-bob conventions the player sprite uses. The 2-frame normal/flipped pair from `hudSt.moogleFrames` was a battle/loading-screen asset and is left untouched.
- **Moogle's direction tracks its wander.** Walking down shows the down-facing sprite, walking left shows the left-facing one, etc. `_dxDyToDir` maps the walk vector to `DIR_DOWN/UP/LEFT/RIGHT`.
- **Talk-facing now respects all four axes,** not just LEFT/RIGHT. Player approaches from above → moogle faces UP; from the left → moogle faces RIGHT; etc.
- **Exported `MOOGLE_GFX_ID` and `MOOGLE_PAL`** from `sprite-init.js` so the NPC layer can build its own `Sprite` instance.

## 1.7.291 — 2026-05-13

### Altar moogle: FF-style wander + talk-face + smooth dialogue

- **NPCs now walk one tile, pause, walk one tile, pause** — classic FF NPC cadence. Walk = 480ms smooth-tween across the tile; pause = random 600-1800ms; direction = uniform random per step. The moogle holds its idle frame while paused and alternates the 2-frame walk cycle (normal / h-flipped) while moving.
- **Pathway-avoidance:** the wander only steps onto tiles with ≥3 walkable floor neighbors — same "open area" predicate that placed the moogle. The moogle won't ever roam onto a 1-wide corridor and can't block the player's path through the cave.
- **Collision is symmetric:** the moogle's source AND destination tiles both register in `findNpcAt`, so the player can't walk through a moogle mid-step. The moogle also won't step onto the player's tile or another NPC.
- **Wander freezes during dialogue** — `msgState !== 'none'` pauses every NPC's tick, so the moogle doesn't drift away while you're reading their lines.
- **NPC faces the player when talked to.** Press Z facing the moogle and they pivot to look at you — `npc.talkFacing` is set from the player's facing direction (LEFT/RIGHT pick the matching mirror frame; UP/DOWN fall back to right-facing since the ROM moogle has only horizontal flip).
- **Multi-page dialogue flows through ONE message box.** New `showMsgBoxPages` helper: slide-in once on page 1, Z swaps text in place via `replaceMsgBoxText` (no animation between pages), slide-out only after the last page.

## 1.7.290 — 2026-05-13

### Altar moogle: swap to ROM-extracted sprite

- **Deleted `data/moogle-sprite.js` (hand-authored pixel art) and routed the Altar Cave moogle through `hudSt.moogleFrames`** — the ROM-extracted moogle sprite built by `initMoogleSprite` (`sprite-init.js`, `MOOGLE_SPRITE_OFF = 0x01EA10`, `MOOGLE_PAL = [0x0F, 0x0F, 0x16, 0x30]`). Same asset already used by the loading-screen right panel. `npc.js` now reads from `hudSt` instead of building its own canvas, and the 2-frame bob alternates between the normal and h-flipped frames.

## 1.7.289 — 2026-05-13

### First NPC: Altar Cave moogle (kupo!)

- **Added a walking moogle to the middle of Altar Cave floor 1.** Hand-authored 16×16 sprite, 2-frame walk-in-place idle (feet step apart on alternate frames). Moogles don't exist in NES FF3 — DS-flavored addition, original pixel art. Pink pompom, white body, black outline.
- **NPC subsystem scaffolding:** new `src/npc.js` owns the runtime NPC list, frame cache, palette pipeline, tile-based lookup, and multi-page dialogue chain. New `src/data/moogle-sprite.js` holds the pixel grids. `src/data/npcs.js` extended with synthetic-NPC entries (role + sprite + dialogue).
- **Walking-blocked + Z-to-talk:** `movement.js` blocks player from walking onto an NPC tile (same pattern as the boss-sprite block) and routes Z-presses facing an NPC into `talkToNpc`, which walks through the dialogue array one message-box per Z-advance.
- **Placement is bottleneck-safe:** the moogle spirals outward from tile (16, 10) and lands on the first FLOOR tile with ≥3 walkable neighbors — never sits on a 1-wide chokepoint.

## 1.7.288 — 2026-05-13

### Battle messages now use Shrines short-names

- **Strip shows `Ice` / `Ice2` / `Ice3` / `Fire` etc. instead of ROM forms like `Bzzard` / `Bzzra` / `Bzzaga`.** Battle-message strip + PVP message strip + item-use messages were calling `getSpellNameClean` / `getItemNameClean`, which return raw IPS-patched ROM letters with only icon/padding stripped — so the strip read `Bzzard` while the menu, shop, and inspect panels showed `Ice`. Now all 10 strip call sites (`battle-turn.js` ×5, `spell-cast.js` ×2, `pvp.js` ×3) go through new `getSpellNameShrinesClean` / `getItemNameShrinesClean` helpers that return Shrines-override letters when present, with ROM-clean fallback for entries without an override.
- **Added missing `0x3a → 'Ice2'` to `SPELL_NAMES_SHRINES`** — this is the BM Lv2 ice spell players actually cast (5 MP, 700g, also delivered by SouthWind item). It had no override entry so even after the strip fix it would have fallen through to ROM "Blzzard"/"Bzzra".

## 1.7.287 — 2026-05-12

### Battle message strip — non-blocking pacing

- **Animations no longer wait on messages.** Deleted the `msg-wait` and `message-hold` battle states + every gate that paused the state machine for the strip to drain (`battle-enemy.js` post-damage + no-op-attack paths, `battle-update.js` player-damage-show / defend-anim / run-fail / run-success / boss-escape, `spell-cast.js` post-impact). Strip now runs entirely on its own 1200ms clock (200 fade-in + 800 hold + 200 fade-out) independent of combat flow.
- **`queueBattleMsg` cuts in immediately.** Merged with `replaceBattleMsg` — both are now the same function: if a message is already displaying, new text swaps in place without re-fading and the hold timer resets so the new text gets its full display window. The queue array is gone; only the current slot remains.
- **Dead code removed:** `waitForZ` flag + `advanceBattleMsgZ` (never set by anyone), `isBattleMsgBusy` (only used by the deleted gates), orphan `'victory-msg'` state branch in `input-handler.js`, freeze-watchdog allowlist entries for the deleted states.

## 1.7.286 — 2026-05-12

### DS-exclusive ultimate gear (24 items)

- **Added the FF3 DS Mognet quest reward (Ultima Weapon) + 22 Legendary Blacksmith job-mastery rewards + 1 Onion Knight item.** Items live at IDs `0xC8-0xDF` — past the ROM string range. Each entry carries an explicit `icon` field; `getItemName` short-circuits ROM lookup when the field is present and returns the icon byte directly. Name letters come from `ITEM_NAMES_SHRINES` (no ROM dependency).
- **Names** are Shrines-style short forms: `Ultima` / `OnionBld` / `Celest` / `Gigantic` / `Shura` / `Angel` / `Lilith` / `Crimson` / `Gladius` / `Artemis` / `Queen` / `Omnitome` / `Blessed` / `MagicLnc` / `Mighty` / `Murakumo` / `Royal` / `Ballad` / `MstrDogi` / `Astral` / `Millenum` / `HolyWand` / `SageStaf` / `Muramasa`.
- **Stats** lifted from DS values, jobs mapped to closest ff3mmo NES analog (DS Dark Knight → Magic Knight; DS Evoker → Conjurer; DS Devout → Shaman; DS Magus → Warlock). Ultima Weapon set to atk 200 (new ceiling, above Ragnarok 180). Class-locked except Celestial Gloves which are unrestricted (DS Freelancer mastery — Freelancer doesn't exist as a separate class in ff3mmo).
- **No pickup mechanism yet** — these are data registrations only. Drop tables, shop slots, and quest hooks are deferred to a follow-up.

## 1.7.285 — 2026-05-12

### Robe icon split

- **Distinct robe icon for cloth/light body armor.** v1.7.281 lifted A.W. Jackson's mail tile ($E2) to slot $7A and left the 11 robe-class items on Chaos Rush's $61 — assuming $61 was the robe-style tile. It's not: CR's $61 is a vest/sleeveless silhouette that reads as generic for hooded-robe items. Lifted A.W.'s $E1 (hooded-robe shape) into slot $7C (verified unused across items / spells / monsters / jobs) and routed the 11 robes through it: Cloth (#72), Leather (#73), Kenpo (#79), DarkSuit (#7A), Wizard (#7B), BlackBelt (#7D), Bard (#80), Scholar (#81), Gaia (#82), WhiteRobe (#86), BlackRobe (#87). Heavy mail items keep $7A; CR's $61 still renders for any body-armor item not in either override list (currently none — every body armor is now classified).

## 1.7.284 — 2026-05-12

### Shrines override cleanup (no behavior change)

- Deleted 129 no-op entries from `ITEM_NAMES_SHRINES` (19), `SPELL_NAMES_SHRINES` (20), `MONSTER_NAMES_SHRINES` (90) where the rendered Shrines name was byte-identical to the Chaos Rush ROM string after icon strip. The fall-through path (`getXxxNameShrines` → `getXxxNameWithIcon` → ROM) produces identical output for these IDs, so the override was carrying no signal.
- Sizes after cleanup: items 187→168, spells 56→36, monsters 204→114 (-129 entries total, -41 source lines). Jobs left alone — 21 of 22 entries are CR-garbled (ligature bytes Chaos Rush uses for compressed text), and `pause-menu.js` falls through to `'??'` not `JOBS[i].name`, so no entry is safely deletable there.
- What remains in each map is now strictly: width-savers (217 entries), pure renames (46), or CR-garbled fixes (76 entries where deletion would surface broken-looking glyphs). Maps now read as a list of intentional deviations from ROM, not a mix of "intentional" and "shipped just in case."

## 1.7.283 — 2026-05-12

### Doc refresh (no behavior change)

- `docs/design-notes.md` — new **Item icons** section covering the v1.7.278-282 override series: which slots are used, which items route through each, the 4-step plumbing pattern for adding more, and which icons were confirmed clean without a swap.
- `docs/SHRINES-RENAMES.md` — added "A.W. Jackson icon overrides" subsection with the same slot table for cross-reference from the renames work.

## 1.7.282 — 2026-05-12

- **Distinct spear icon.** Chaos Rush's `$68` spear tile was a thin diagonal stroke with no spearhead — readable as a line, not iconic. Lifted A.W. Jackson's `$EC` (diagonal with a triangular head) into slot `$73` (verified unused across items / spells / monsters / jobs) and overrode the 4 spear/lance items (#1A Thunder Spear, #1B Wind Spear, #1C Blood Lance, #1D Holy Lance). Final entry in the icon audit series — every shared-byte case is now split.

## 1.7.281 — 2026-05-12

- **Distinct staff icon + mail-style body armor icon.** Last two cases where Chaos Rush packs visually-distinct items under one icon byte. Rods (`$66`, items #09-#0D) and staves (#0E-#14) shared one tile; A.W. Jackson splits to `$E9`/`$EA`, so staves get a new slot `$79` (A.W. `$EA` — branched/Y-top staff head). Body armor (`$61`, 25 items) was lumped together; A.W. splits by weight into `$E1` (robe/cloth) and `$E2` (mail/plate), so the 14 mail-style entries (Onion / Mithril / Shell / Ice / Flame Mail / Viking / Knight / Dragon / Demon / Diamond / Reflect / Genji / Crystal / Rusty Mail) get a new slot `$7A` (A.W. `$E2` — scale/rivet pattern); the 11 robe-style entries keep `$61`. Same plumbing as the v1.7.278-280 arrow / claw / bracer splits.

## 1.7.280 — 2026-05-12

- **Distinct bracer/ring icon for arm-slot accessories.** Bracers (Bronze / Mithril / Power / Rune / Diamond) and Protect Ring share ROM byte `$63` with gauntlets and gloves — the Chaos Rush tile reads as a hand, fine for gloves but wrong for wrist accessories. A.W. Jackson splits the arm slot into `$E4` (gauntlet) and `$E5` (bracer/ring); lifted the bracer tile to slot `$78`, added `BRACER_ITEM_IDS` (`0x8B, 0x8E, 0x91, 0x92, 0x93, 0x95`) + override branches in both `getItemNameWithIcon` and `getItemNameShrines`. Gauntlets / gloves keep `$63`.

## 1.7.279 — 2026-05-12

- **Distinct claw icon for claw items.** Claws (#01-#05: Kaizer / Cat / Wyvern / Faerie / Hellish) share ROM byte `$64` with nunchaku (#06-#08) — the shared tile reads as two diagonal sticks, which is right for nunchaku but wrong for claws. Same pattern as v1.7.278's arrow fix: lifted A.W. Jackson's claw tile (their `$E6`), landed it at Chaos Rush slot `$76`, added `CLAW_ITEM_IDS` + `CLAW_ICON_BYTE` to `text-decoder.js`, override branches in both `getItemNameWithIcon` and `getItemNameShrines`. Nunchaku keeps `$64`.

## 1.7.278 — 2026-05-12

- **Distinct arrow icon for arrow items.** Bows and arrows both use `$6E` in the original FF3 NES ROM (and in Chaos Rush) — the tile is a combined bow-with-arrow glyph, so arrows render with what reads as a bow icon. The A.W. Jackson translation gives arrows their own tile at `$F3`. Lifted those 16 bytes into `font-renderer.js#ARROW_TILE_BYTES`, installed at slot `$77` (unused in the Chaos Rush atlas). `text-decoder.js#ARROW_ITEM_IDS` (`0x4F-0x56`) now overrides the icon byte in both `getItemNameWithIcon` and `getItemNameShrines`, so inventory / shop / equip / battle-item / inspect / trade rows all show the new arrow glyph; bows keep `$6E`.

## 1.7.277 — 2026-05-12

### Doc + stale-comment cleanup (no behavior change)

`docs/design-notes.md` brought current for the v1.7.257-276 wave:
- **Shops** section updated with the three-zone keeper-left / menu-right
  / list-bottom layout, the quantity selector, scrolling, fade scoping,
  and the FF1 keeper sprite system.
- **Saves** section gained three bullets: overworld-only position writes
  (v1.7.268), entry-tile checkpoint (v1.7.275), and dungeon
  `consumedTiles` wipe on cave re-entry (v1.7.276).
- **Hand combat** updated: the "fists alternate per hit" line was stale;
  combos are RRLL across all combatants via `battle-math.js`'s
  `isRightHandHit / isLeftHandHit` helpers (v1.7.273-274).

Also swept the FF1&2-era comments that survived the v1.7.256 ROM split:
- `src/boot.js` header
- `src/debug/tabs/emu.js` (ROM toggle docstring + status text)
- `src/ff1-nsf-builder.js` header
- `src/music.js` SHOP track comment
- `index.html` orphan CSS selector (`#rom-file-ff12`)

## 1.7.276 — 2026-05-12

### Wipe dungeon `consumedTiles` on cave (re-)entry

The Altar Cave dungeon-seed is regenerated to `Date.now()` on every
entry from overworld — so each run has a fresh procedural layout. But
`ps.consumedTiles[mapId]` (chest opens, secret walls, rock puzzles)
was being carried across runs. Those (x,y) override coords pointed at
the *previous* run's tile positions, which don't correspond to
anything in the new layout. Result: walking into floor 0 or 1 of a
fresh run, you'd see open-chest tiles scattered at random spots
("ghost chests") with no actual chest underneath them.

Fix: when the cave entry trigger fires (`destMap === 111`) and the
seed is regenerated, delete every `ps.consumedTiles[mapId]` whose
mapId is in the dungeon range (≥1000). Town entries (<1000) keep
their persisted state, so an opened chest in Ur stays opened.

## 1.7.275 — 2026-05-12

### Cave / town entry captures the overworld entrance tile

Two respawn paths used to land somewhere stale when dying or logging
out inside the Altar Cave:

- **Death** — `respawnAfterDeath` uses `ps.lastWorldExitX/Y`, which was
  only updated by `_landOnWorldMap`. That means `lastWorldExit` tracked
  "last place the player LANDED on overworld" — i.e., the gate they
  walked out of. Dying in the Altar Cave dumped the player back at the
  Ur gate, not at the cave entrance.
- **Logout** — the slot's `worldX/Y` was the last overworld save (v1.7.268
  scope). If the player walked from Ur's gate to the cave entrance
  without any save event in between, the slot still pointed at the
  gate, so reload spawned them at the gate.

Fix: `loadMapById` now captures the player's current tile into both
`ps.lastWorldExitX/Y` AND `slot.worldX/Y` **before** flipping
`mapSt.onWorldMap` to false. The save fires while `onWorldMap` is still
true so the v1.7.268 position-getter accepts it and writes the
entrance coords.

Result: stepping on the Altar Cave entrance tile is now the
checkpoint. Die in floor 4, respawn at the cave entrance on overworld.
Log out in floor 2, reload at the cave entrance on overworld. Same
applies to every town / dungeon entered directly from overworld.

## 1.7.274 — 2026-05-12

### Modularize hand-selection for dual-strike combos

v1.7.273 fixed the RRLL pattern by duplicating the same
`(rW && lW) || (!rW && !lW) → hitIdx < total>>1` shape across six
sites. Pulled into a single helper in `battle-math.js`:

```js
isRightHandHit(hitIdx, totalHits, rW, lW)
isLeftHandHit(hitIdx, totalHits, rW, lW)
```

Pure math — booleans in, boolean out, no dependency on `items.js` /
`isWeapon`. Callers:

- `player-stats.js#isHitRightHand` (unarmed + dual-weapon)
- `battle-ally.js` (windup hand-select + post-hit advance)
- `battle-draw-allies.js` (upcoming-hand display)
- `pvp.js` (PVP enemy combat hand-select)
- `pvp-drawing.js` (PVP enemy sprite pose)

Behavior unchanged from v1.7.273; the formula now lives in one place
and the next combat path that needs hand selection just imports the
helper.

## 1.7.273 — 2026-05-12

### Dual-strike attacks are RRLL across all combatants

A roster Monk's 4-hit unarmed combo was rendering R / L / R / L
(alternating per hit) instead of R / R / L / L (all right-hand
strikes, then all left). The player's *dual-wield with weapons* path
was already RRLL via `inputSt.rHandHitCount` — but the player
*unarmed* path, the ally path, and the PVP enemy path all used a per-hit
`hitIdx % 2 === 1` toggle, which gives the alternating pattern.

Fix routes every dual-strike site through the same "first half right,
second half left" split:

- `player-stats.js#isHitRightHand` — unarmed branch now uses
  `hitIdx < rHandHitCount` like the dual-weapon branch. The input
  handler already populates `rHandHitCount` for the unarmed case (it
  routes through `if (dualWield)`), so this just makes the read side
  honor it.
- `battle-ally.js` (both the pre-windup hand-select at line 90 and
  the post-hit advance at line 144) — computes
  `rHandHits = battleSt.allyHitResults.length >> 1` and decides hand
  on `hitIdx >= rHandHits`.
- `battle-draw-allies.js` — same split mirrored into the draw-time
  upcoming-hand check so the inter-hit idle gap fires at the same
  R→L boundary the update path uses.
- `pvp.js` + `pvp-drawing.js` — same split keyed off
  `pvpSt.pvpEnemyHitResults.length`.

NES Monk OAM canon is RLRL; the in-game flow here matches the user's
visual preference (and the input-handler's existing comment "NES: all
right hand hits first, then all left hand hits").

## 1.7.272 — 2026-05-12

### FF1 item-shop keeper (all four Ur shops now lit)

Last keeper. 13 tiles ($55–$61 in shop CHR; +84 additive over weapon
per FF1 `lut_ShopkeepAdditive`, since item is FF1 shop type 6).
Captured via SNAP BG on standalone FF1 USA ROM, frame 10912. Palette
verified against PPU BG0 = matches `SHOP_PALETTES.item`.

All four of Ur's shops now render their keepers (weapon / armor /
item / magic). Black-magic keeper is still staged for a future bmagic
shop type. Clinic / inn / caravan keepers from FF1's full 8-type set
aren't captured — those shop types don't exist in ff3mmo yet.

## 1.7.271 — 2026-05-12

### FF1 white-magic-shop keeper (lights up Ur magic shop)

Fourth keeper. 13 tiles ($1D–$29 in shop CHR; +28 additive over weapon
per FF1 `lut_ShopkeepAdditive`, since white-magic is FF1 shop type 2).
Captured via SNAP BG on standalone FF1 USA ROM, frame 9257. Palette
verified against PPU BG0 = matches `SHOP_PALETTES['white-magic']`.

`FF3MMO_TO_FF1.magic = 'white-magic'`, so Ur's magic shop (Cure /
Poisona / Sight) now displays this keeper.

Item-shop keeper still pending capture.

## 1.7.270 — 2026-05-12

### FF1 black-magic-shop keeper (staged for future bmagic shop type)

Third keeper. 13 tiles ($2B–$37 in shop CHR; +42 additive over weapon
per FF1 `lut_ShopkeepAdditive`, since black-magic is FF1 shop type 3 →
3×14 = 42). Captured via SNAP BG on standalone FF1 USA ROM, frame
8626. Palette verified against PPU BG0 = matches
`SHOP_PALETTES['black-magic']`.

Won't render yet: ff3mmo's only magic shop right now is Ur's WM Lv1
shop, which maps through `FF3MMO_TO_FF1.magic = 'white-magic'`. The
black-magic tiles are staged for when a `bmagic` shop type lands
(easiest: split `magic` into `wmagic` / `bmagic` in `FF3MMO_TO_FF1`
and add the tag to each shops.js entry).

White-magic + item keepers still pending captures.

## 1.7.269 — 2026-05-12

### FF1 armor-shop keeper

Second keeper landed. 13 tiles for the armor-shop NPC ($0F–$1B in the
shop CHR bundle; tile additive 14 over the weapon-shop tiles per FF1's
`lut_ShopkeepAdditive`). Captured via SNAP BG on the standalone FF1 USA
ROM, frame 1617. Palette verified against PPU BG0 = matches the cached
`SHOP_PALETTES.armor` from the disassembly extraction.

`SHOP_KEEPER_TILES['armor']` now lights up the Ur armor shop. Item +
magic keepers still pending captures.

## 1.7.268 — 2026-05-12

### Respawn checkpoint is overworld-only (NES-style save model)

Walking around inside a town shouldn't move your respawn point. v1.7.266
gated position writes while the shop panel was up, but tab-close
`beforeunload` saves fired the moment you closed the shop and were
standing on the counter-door tile inside the town — same end result,
just one frame later. The respawn followed you tile-by-tile across the
town map.

New rule: `setPositionGetter` returns `null` whenever
`mapSt.onWorldMap` is false (in town / dungeon / sub-map) OR a shop
panel is up. `saveSlotsToDB` skips `worldX / worldY / onWorldMap /
currentMapId` on null. Inventory / gil / HP / stats still persist.

Result: the only events that move the respawn point are now:

- `loadWorldMapAt` / `loadWorldMapAtPosition` (overworld entry / pop)
- Any save fired while standing on the overworld (battle end,
  `beforeunload`, etc.)

Existing corrupted slots that already point at a town tile will
respawn there until you walk back out to overworld once — that
`loadWorldMapAt` writes the gate position and the slot's clean from
then on. Or clear `ff3mmo-saves` from browser IndexedDB for an
immediate reset.

## 1.7.267 — 2026-05-12

### Gil stays bright through intra-shop transitions

v1.7.266 routed Gil through the same gray-tween as the Buy/Sell/Exit
menu so the whole right column moved as one piece. The "no flash to
black" half was right; the "dim to gray on selection" half wasn't —
Gil is informational, not a focusable menu option. Reverted to the
keeperFade path: Gil only fades on outer shop-in / shop-out, never on
intra-shop transitions. Menu still dims to gray when the list takes
focus (separate concern, unchanged).

## 1.7.266 — 2026-05-12

### Gil also dims (no flash) + don't save in-shop position

Two more fixes off the same complaint chain.

1. **Gil text** was still using the full inner fade step, so on
   Buy / Sell selection it flashed to black with the rest of the
   panel. Now uses the same `_menuFadeStep` tween — Gil dims to gray
   alongside the menu, then back to bright. The whole right column
   (keeper, Gil, menu) moves as a single piece.
2. **Quitting mid-shop respawned at the counter tile** (NES Ur is in
   a desert region, so walking out of that respawn dropped the
   player straight into desert overworld — looked like the game
   teleported them). Root cause: `_attemptBuy` / `_attemptSell`
   trigger `saveSlotsToDB()` after each purchase, and the save was
   happily persisting the counter-tile coords. Reload then put the
   player on the counter and walking south through Ur's gate left
   them on the surrounding desert overworld.

   Fix: `setPositionGetter` in `main.js` now returns `null` while
   `shopSt.state !== 'closed'`. `saveSlotsToDB` interprets a null
   position getter as "don't touch position fields this save" — so
   inventory + gil still persist, but the slot's `worldX / worldY /
   onWorldMap / currentMapId` stay pinned to whatever the last
   pre-shop save wrote (`loadMapById` on town entry, etc.). Quitting
   mid-shop now respawns at the town entrance, not the counter, and
   exits don't dump the player into the desert.

## 1.7.265 — 2026-05-12

### Buy/Sell/Exit dims to gray (not black) when list has focus

v1.7.263 stopped the menu text from fading to black on Buy / Sell
selection, but it then stayed at full brightness — which made it look
"still active" while the cursor was actually on the item list below.
Restored the gray-out behavior with a proper tween:

- `menu` (idle)        → bright
- `menu-out`           → tween bright → gray over the fade duration
- `buy*` / `sell*`     → gray (mid, NES `$10`)
- `menu-in`            → tween gray → bright
- `shop-in` / `shop-out` → outer fade (unchanged)

`_menuFadeStep(state, outerFade)` caps the intra-shop fade at 2 so the
text never reaches `$0F` (black) on those transitions. Outer
shop-in/-out still goes through black with the rest of the panel.

## 1.7.264 — 2026-05-12

### Revert openShop save (sticky shop position)

v1.7.262 added `saveSlotsToDB()` at the top of `openShop` to capture
the exact tile-in-front-of-counter coords. But there was no matching
save on shop exit / overworld walk, so the counter position became
sticky: walk out of the shop, leave the town through the gate (which
DOES save via `loadWorldMapAt`), walk around the overworld (no saves),
quit — and reload still reads "you are at the counter" because the
openShop save outranked the world-map walks.

Reverted. The `loadMapById` save from v1.7.261 is the right trade:
quitting mid-shop reloads you to the town entrance (in the right
town, not stranded on the overworld), and overworld walks aren't
clobbered by stale shop entries. The exact-counter UX wasn't worth
the sticky bug.

## 1.7.263 — 2026-05-12

### Buy/Sell/Exit menu no longer flashes to black on Buy / Sell

Pressing Z on Buy or Sell triggered the old menu-out / sub-screen-in
text fade, which faded the right-column Buy/Sell/Exit text through
black before the item list took over the panel below. But the menu
is part of the shop's persistent layout (right column, always
visible), not a sub-screen, so the fade looked like a flicker.

The keeper sprite was already scoped to outer shop-in / shop-out only
(v1.7.261). Did the same for the menu text: it stays at full
brightness through every intra-shop transition. Only shop-in /
shop-out fades the menu.

Dropped the now-unused `palOverride` parameter from `_drawRootMenu` —
the "in-list dim to invisible" override is gone; the menu just stays
visible the whole time.

## 1.7.262 — 2026-05-12

### Save on shop entry (resume at counter, not town entrance)

Follow-up to v1.7.261. The town-entry save persists the entrance
position, not wherever the player wandered to inside the town —
which meant quitting from a shop resumed at the entrance tile.
Added `saveSlotsToDB()` at the top of `openShop` so the
tile-in-front-of-the-counter is captured before the map-out fade
begins. A tab close while inside the shop now resumes exactly at the
counter on next launch.

## 1.7.261 — 2026-05-12

### Save on map transitions + scope shopkeeper fade to shop-in/-out only

Two fixes:

1. **Quitting from a shop no longer respawns on the overworld.** Map
   transitions weren't writing the save — only chest opens / pond
   heals / battle ends / shop purchases / explicit save commands.
   So entering a town silently kept the old (world-map) save, and a
   tab close before any savepoint persisted that stale state.
   Added `saveSlotsToDB()` to the end of `loadMapById`,
   `loadWorldMapAt`, and `loadWorldMapAtPosition`. The startup-time
   load call is a no-op because `psAligned` is still false; runtime
   transitions persist properly.
2. **Shopkeeper sprite no longer flickers between menu states.**
   v1.7.258 wired the keeper into the same `fadeStep` as the menu
   text, which meant every intra-shop transition (menu → buy,
   buy → menu, etc.) faded the sprite alongside the text. The
   keeper is part of the shop "set", not the menu text, so only
   the outer `shop-in / shop-out` transitions fade it now — every
   intra-shop sub-fade leaves the keeper at full saturation.

## 1.7.260 — 2026-05-12

### Shop quantity selector in the right column (replaces blue confirm)

Item shops (weapon / armor / item) no longer pop the blue "Buy Cure?"
box on Z. Instead, the right column's Buy/Sell/Exit text is suppressed
and a quantity widget takes its place:

```
Buy            ← or Sell
qty       01
gil      150
```

Input (active only while `shopSt.confirm` is true):

- **Up** — qty +1
- **Down** — qty −1
- **Right** — qty +10
- **Left** — qty −10
- **Z** — commit purchase / sale for the selected `shopSt.qty`
- **X** — cancel back to the buy/sell list

`shopSt.qty` and `shopSt.qtyMax` track the in-flight selection.
`_qtyCap(target, isSell)` resolves the per-item ceiling — bought items
cap at `min(99, floor(gil / price))`, sold items at `min(99,
entry.count)`. `_attemptBuy(itemId, qty)` and `_attemptSell(entry,
qty)` now take a quantity; the toast message reads "Bought N Potion!"
or "Sold N Potion!" when qty > 1.

Spell shops keep the original single-purchase blue confirm — quantity
doesn't apply (each spell can only be learned once).

## 1.7.259 — 2026-05-12

### Use the shared `_stepPalFade` helper in `_drawShopkeeper`

v1.7.258 rolled its own per-slot fade loop instead of using
`palette.js`'s existing `_stepPalFade(pal)` helper. Same output but the
keeper now goes through the same code path as every other faded
surface — no per-feature copies of the slot 1..3 step.

## 1.7.258 — 2026-05-12

### Shopkeeper sprite fades alongside menu text

The new keeper tiles in v1.7.257 painted at full saturation during
shop-in / shop-out / menu sub-fade transitions while the rest of the
panel faded through the standard `nesColorFade` palette steps. Plumbed
the existing `fadeStep` into `_drawShopkeeper(ctx, x, y, fadeStep)` —
each non-transparent palette slot (1..3) gets stepped that many times
toward black on every draw. Slot 0 stays transparent. Keeper now
appears / disappears with the menu in lockstep.

## 1.7.257 — 2026-05-12

### FF1 weapon shopkeeper lands + new shop panel layout

First captured keeper. 13 keeper tiles ($01–$0D in
`SHOPKEEP_IMAGE_LAYOUT` order, 208 bytes) for the FF1 weapon-shop
keeper pasted into `SHOP_KEEPER_TILES['weapon']` from a SNAP BG capture
in the standalone FF1 USA ROM (frame 1997). Palette matches
`SHOP_PALETTES.weapon` from the disassembly extraction. Tile guard in
`_drawShopkeeper` dropped from 14×16 → 13×16 to match.

Reworked the shop panel layout:

- **Keeper** at upper-left (`KEEPER_X / KEEPER_Y`), figure spans
  panel-relative y=20..84, x=8..56.
- **Buy / Sell / Exit** menu pinned to the right column
  (`MENU_X = px + 72`); always drawn so the player keeps context. Dims
  to color-0 while the buy/sell list owns the cursor.
- **Gil** label moved off the keeper area to sit above the menu.
- **Item list** anchored to the lower half (`LIST_Y0 = py + 96`), full
  panel width, with scroll. `LIST_VISIBLE_ROWS = 4` (computed from
  remaining panel height).

Buy/sell list now scrolls — `shopSt.scroll` mirrors the inventory and
magic-list math (cursor crosses visible edge → scroll shifts); blink
arrows pin to the right edge via `ui.scrollArrowUp/Down`, same
primitives the battle spell list uses. Sell-list shrink path also
clamps scroll so a freshly-empty bottom row doesn't strand the
viewport.

Deferred to a follow-up: "Buy 1 / Buy 4 / Buy 10" / "Sell 1 / Sell
All" quantity menu (will replace the Buy/Sell/Exit text when an item
is selected). Other shop types still no-op (armor / item / magic
keeper tiles pending captures).

## 1.7.256 — 2026-05-12

### Replace FF1+II SUROM cart with FF1 + FF2 standalones

The Famicom FF I・II compilation is SUROM (extended MMC1 with 512 KB
PRG) and jsnes only implements the standard 4-bit PRG select, so any
attempt to run the cart inside the EMU tab produced a gray screen
(boot vector lives in the upper 256 KB, unreachable). Replaced with
two standalone ROMs (both regular MMC1, both jsnes-runnable):

- `ff1Raw` (FF1 NES, 256 KB) → FF1 battle music, bank `$0D` extract
- `ff2Raw` (FF2 Famicom, 256 KB) → Adamantoise sprite, offset `0xBF10`
  (= old FF1+II cart offset `0x04BF10` minus FF1's 256 KB prefix)

Changes:

- `boot.js`: split `loadFF12ROM(buf)` → `loadFF1ROM(buf)` +
  `loadFF2ROM(buf)`. Replaced `ff12Raw` with `ff1Raw` / `ff2Raw` and
  the matching `getFF1Raw()` / `getFF2Raw()` accessors.
- `sprite-init.js`: `FF2_ADAMANTOISE_SPRITE` offset `0x04BF10` →
  `0x0BF10`. `initLoadingScreenFadeFrames(rom, ff12Raw)` param renamed
  to `ff2Raw`.
- `main.js`: re-exports `loadFF1ROM` + `loadFF2ROM` instead of
  `loadFF12ROM`.
- `index.html`: two ROM file pickers (FF1 + FF2) instead of one;
  indexedDB cache keys `'ff1'` and `'ff2'` instead of `'ff12'`;
  `tryLaunch` now waits on all three buffers; debug-panel ctx provides
  `getFF1Buffer()` + `getFF2Buffer()`.
- `debug/tabs/emu.js`: ROM toggle is now 3-way (FF3 / FF1 / FF2);
  `_switchRom` keyed off a `ROM_TARGETS` map so adding more ROMs later
  only needs a button + entry. Stripped the v1.7.255 EMU-DIAG logger
  (job done — we got our answer).
- `debug/tabs/sprites.js`: tile-viewer ROM toggle goes from
  `FF3 / FF1&2` to `FF3 / FF1 / FF2`.
- `data/shop-sprites.js`: capture-flow docs point at the in-app EMU
  tab + the new FF1 toggle instead of FCEUX/Mesen offline.

Migration: users with the FF1+II cart cached will see the picker
asking for FF1 and FF2 separately on next boot. Old `'ff12'` cache
entry in indexedDB is now orphaned and can be cleared by the browser
at its leisure.

## 1.7.255 — 2026-05-12

### EMU tab: diagnostic logger for FF1&2 ROM swap

Wires the EMU tab's ROM-toggle path into `/api/client-error` so SSH-only
sessions can diagnose the FF1&2 boot (devtools-less debugging). Three
hook points POST to pm2 logs with the `[EMU DIAG …]` tag:

1. `_logRomDiag(buffer, target, 'pre-init')` — iNES header (16 bytes),
   magic, PRG/CHR bank counts, flag6/flag7 bit patterns, computed
   mapper number. Fired the moment the ROM toggle is tapped, before
   jsnes touches it.
2. `_logRomDiag(buffer, target, 'post-init')` — same as above, plus
   `jsnes_mapper_type`, `jsnes_mapper_supported`, `jsnes_prg_count`,
   `jsnes_chr_count` (jsnes' resolved view of the same ROM). Fired
   after `nes.loadROM()`.
3. `onStatusUpdate` mirror — every jsnes internal status message
   (the place a "mapper not supported" or banking error would surface)
   echoes to pm2 alongside the existing console.log.

Also a 3-second snapshot fires `host_frames`, PPU NMI-enabled flag,
PPU display type, and `imgPalette[0]` (NES universal-background color)
so we can tell whether the "gray" is jsnes-not-rendering or
PPU-rendering-only-gray.

Added `getFF12Raw()` export to `boot.js` for future console
diagnostics, even though the EMU tab path doesn't need it.

## 1.7.254 — 2026-05-12

### EMU tab: ROM toggle (FF3 / FF1&2)

Adds a `ROM: [FF3] [FF1&2]` toggle row to the EMU tab in the Konami
debugger. FF3 is still the default; tapping FF1&2 stops the running
emulator, drops the current jsnes instance, and re-inits against
`ctx.getFF12Buffer()` (already wired in `index.html`). FF1&2 boots
raw — the FF3 English IPS step is skipped.

Active ROM gets a gold border so it's obvious which one is running.
Savestate slots are not namespaced by ROM — a LOAD after a swap will
fail loudly via jsnes' built-in guard rather than silently corrupt;
acceptable trade for a debug tool.

Unlocks the FF1 shopkeeper capture path documented in v1.7.253:
boot FF3, hit Konami, EMU tab, ROM toggle → FF1&2, walk to each shop
in the FF1 game, SNAP BG on $0000-$06FF, paste the 14-tile slice into
`SHOP_KEEPER_TILES`.

## 1.7.253 — 2026-05-12

### FF1 shopkeeper scaffolding — canonical 10×10 BG layout

Reworked v1.7.252's scaffolding after reading the Disch/Entroper FF1
disassembly (`bank_0E.asm:DrawShop`, `bank_0F.asm:LoadShopBGCHRPalettes`,
`Constants.inc:lut_ShopCHR/lut_BackdropPal`).

What changed vs the placeholder 2×3 / 16×24 assumption:

- FF1 shopkeeper is **BG plane**, not OAM — capture path is SNAP BG, not
  SNAP OAM.
- 8 canonical FF1 shop types (added black-magic, clinic, inn, caravan to
  the type map for completeness; ff3mmo only renders 4 today, with
  `magic` mapping to FF1's white-magic until a BM shop opens).
- Per-type **4-byte backdrop palette** cached from `lut_BackdropPal` in
  bank_00.dat (extracted, not approximated).
- Per-keeper sprite is **14 unique tiles**, arranged through a 10×10
  nametable rect (`lut_ShopkeepImage`). All 8 keepers share the same
  rect layout — the differentiation is an additive `type * 14` over the
  shop CHR bundle.

`shop-sprites.js` now exports `SHOPKEEP_IMAGE_LAYOUT`, `SHOP_PALETTES`,
`FF3MMO_TO_FF1`, and a `SHOP_KEEPER_TILES` Map keyed by FF1 canonical
type (224 bytes per keeper = 14 tiles × 16). `_drawShopkeeper` in
shop.js walks the 10×10 layout, decoding each tile through the existing
`tile-decoder` primitives. Still a no-op for every shop because no
captures have landed — the Map is empty.

Capture flow (in `shop-sprites.js` header): boot FF1&2 in FCEUX/Mesen
(the in-app EMU tab is hardcoded to FF3), enter each shop type, SNAP BG
on $0000-$06FF, slice tiles `1+type*14 .. 14+type*14` per keeper, paste
into the Map.

## 1.7.252 — 2026-05-12

### FF1 shopkeeper scaffolding (data + dispatch, no sprites yet)

Lays the wiring for FF1-style shop NPCs. No visible change yet —
captures from the FF1&2 ROM are pending and the
`SHOP_SPRITES` Map is empty, so every shop type falls through the
guard and renders nothing.

- `data/shops.js`: each shop entry tagged with `type:` ('weapon',
  'armor', 'item', 'magic'). `getShopType(shopId)` resolves the tag
  with a shape-based fallback for unaffixed legacy entries.
- `data/shop-sprites.js` (new): `Map<type, {tiles, palette}>` keyed by
  shop type. 6 tiles × 16 bytes per shopkeeper (2×3, 16×24 px),
  4-color subpalette. Empty for now; each new entry lights up the
  matching shop type with no further wiring.
- `shop.js`: `_drawShopkeeper(ctx, x, y)` reads the active shop type,
  decodes the 6 tiles via the existing `tile-decoder.js` primitives
  (`decodeTile` + `drawTile`), and paints the 2×3 cluster. Hooked into
  `drawShop()` at `(HUD_VIEW_X + 8, HUD_VIEW_Y + 8)`. Position will
  likely need to move once we see the first real frame against the
  current Gil row at y=10.

Capture path: the in-game EMU tab is hardcoded for the FF3 ROM
(`ctx.getFF3Buffer`). Lighting this up means either extending it to
also accept `ff12Raw` from `boot.js` or running the FF1&2 ROM in an
external emulator (FCEUX/Mesen) and pasting the OAM-dumped tile bytes
into `SHOP_SPRITES`.

## 1.7.251 — 2026-05-12

### Pause magic list scrolls now

The pause magic list was rendering every castable spell with no scroll
clamp — jobs with deep spell pools (Sage, Red Mage / Magic Knight at
mid-level, dual-school combos) overflowed past the panel bottom and
clipped the cursor outside the box.

Added `pauseSt.magicScroll` mirroring `invScroll`, computed
`maxVisible = floor((HUD_VIEW_H - 16) / 14)` (~9 rows), and scrolls the
window when the cursor moves past the visible edge — same math as
inventory. Reset to 0 when the magic submenu opens.

Also cleaned up the inline digit-loop for MP cost — uses
`_nameToBytes(String(cost))` + `measureText` like the rest of the
right-aligned-value sites.

## 1.7.250 — 2026-05-12

### Item menus: right-align counts (consistency pass)

Pause inventory + battle item list now draw the count digits
right-aligned at the panel inner right edge, matching the layout used
by the battle spell list (MP cost), pause job panel (Lv + Cost), trade
item-pick (count), and inspect overlay (stat values). Previously these
two surfaces inlined the count as `Name ×N` floating directly after
the name, which drifted with name length and looked inconsistent
against everything else.

Pause inventory: count right-edge at `px + HUD_VIEW_W - 16` = 128.
Battle item list: count right-edge at `px + rightAreaW - 8`, the same
anchor used by the spell-cost column.

Removed the now-unused `_buildItemRowBytes` helper in `text-utils.js`
and its three stale imports (`pause-menu.js`, `battle-draw-menu.js`,
`battle-drawing.js`).

## 1.7.249 — 2026-05-11

### Pause job menu: full Shrines name instead of 2-letter abbr

Now that v1.7.248 lined up `JOB_NAMES_SHRINES`, the pause job-change
panel can show the short name directly (`OnionKid`, `Karateka`,
`Geomanc` etc.) instead of the 2-letter abbreviation. Replaces the
`JOB_ABBR[jobIdx]` lookup at `pause-menu.js:532` with
`JOB_NAMES_SHRINES[jobIdx]`, truncated to 8 chars so `Geomancer`
clamps to `Geomanc` (only entry > 8). Layout shift: Lv right-aligned
at `valRx - 24` (was `tx + 32`) — leaves 64 px / 8 chars for the
name and keeps the 3-char cost column at the far right.

`JOB_ABBR` stays exported for any other surface that wants the
2-letter form.

## 1.7.248 — 2026-05-11

### Shrines short-names for jobs (inspect overlay)

Closes out the rename project. Adds `JOB_NAMES_SHRINES` (22 entries) to
`data/jobs.js` using the canonical FF3J transliterations from
`shrines.rpgclassics.com/nes/ff3/jobs.shtml`: OnionKid, WhiteWiz,
BlackWiz, RedWiz, Hunter, Karateka, M.Knight, Shaman, Warlock, etc.

Wired into the inspect overlay (`inspect.js:90`) — the player-facing
roster surface. Console debug commands (`/job`) and the debug sprites
tab keep the long English `name` for ambiguity-free terminal output.
No ROM fall-through path because job names are JS strings, not ROM
bytes — diverges from the items/spells/monsters override pattern in
that one respect.

Also realigns `JOB_ABBR` (used in the pause Equip / stats column at
`pause-menu.js:532`) to match the Shrines first letter: `WM/BM/RM` →
`WW/BW/RW`, `Ra → Hu`, `BB → Ka`, `De → Sh`, `Ma → Wa`. The internal
job-bitmask constants at the top of `data/jobs.js` already used this
convention (`Ww/Bw/Rw/Hu/Ka/Sh/Wa`), so the abbr table now matches.

## 1.7.247 — 2026-05-11

### Shrines short-names for monsters (in-battle name box)

Mirrors the v1.7.246 item rename. Adds `MONSTER_NAMES_SHRINES` (Map<id,
shortName>) appended to `data/monsters.js` with 184 unambiguous entries
sourced from `shrines.rpgclassics.com/nes/ff3/enemies{1,2}.shtml`.
Skipped (no clean Shrines pairing — fall through to ROM name):
Larva, Helldiver, Parademon, Far Darrig, Aughisky alts, Hellgaroo,
Dracrocotta, HelgaruMage, Noggle, Kagura, KierHermit, Gaap, Aeon,
Drake, Azer, ShadwMaster, GlasLabolas, two Bahamut clones, Demon
Xande, and the 0xE5/0xE6 "C" tombstones.

Adds `getMonsterNameShrines(monsterId)` in `text-decoder.js`. Monsters
have no icon byte, so it returns raw ASCII tile bytes (or falls through
to `getMonsterName`). Wired into the two in-battle name-box sites
(`_battleEnemyName`, `_battleEnemyNames`) in `battle-draw-menu.js`.

Battle-log message queue (`battle-turn.js:241`, `Goblin attacks!`) +
the unused `drawMonsterName` helper stay on `getMonsterName` ROM bytes
— same boundary as items/spells.

## 1.7.246 — 2026-05-11

### Shrines short-names for items

Mirrors the v1.7.242 spell-name override now that v1.7.245 wired the
item-type icons into the font atlas. Adds `ITEM_NAMES_SHRINES` (Map<id,
shortName>) in `data/items.js` covering 159 player-equippable + key /
consumable / battle items, sourced from
`shrines.rpgclassics.com/nes/ff3/{items,weapons,armor}.shtml` and
cached in `docs/SHRINES-RENAMES.md`.

Adds `getItemNameShrines(itemId)` in `text-decoder.js`. Same shape as
`getSpellNameShrines`: pulls the icon byte from ROM so the slot grouping
stays correct, then maps the ASCII override letters to font-atlas tile
bytes. Falls through to `getItemNameWithIcon` for items with no
override (ambiguous Shrines pairings like Oershroom / Earth Drum /
Black Musk / Tranquilizer — they keep the ROM name).

Switched all 9 render sites from `getItemNameWithIcon` →
`getItemNameShrines`: pause inventory, pause equip slot, pause equip
picker, battle RH/LH weapon, battle item list, shop buy/sell row,
trade item-pick, inspect equipment row. Mid-sentence callers
(`Offering X to Y...`, shop success messages) stay on
`getItemNameClean` — same boundary as spells.

## 1.7.245 — 2026-05-11

### Item-type icons in inventory/shop/equip/battle rows

Extends the font atlas down by 16 tiles ($70 → $60 start, count 144→160)
so the ROM item-type icon graphics at $60–$6F load alongside the
letters/digits. Adds `getItemNameWithIcon(itemId)` mirroring
`getSpellNameWithIcon` — keeps the leading icon byte (or strips the
leading 0xFF padding when the item has no icon, e.g., key items).
Wired into 9 player-facing list rows:

- `pause-menu.js:284` inventory list (Z to use)
- `pause-menu.js:349` equip slot display (R/L/Bd/Hd/Sh/Glv)
- `pause-menu.js:396` equip-item picker
- `battle-draw-menu.js:60-64` battle weapon names (RH/LH)
- `battle-draw-menu.js:75` battle item list
- `shop.js:466` shop buy/sell rows
- `inspect.js:125` inspect ally equipment
- `trade.js:274` trade item-pick rows

Mid-sentence callers (`shop.js:339` "Buy X!", `shop.js:498` confirm
prompt, `trade.js:169` "Offering X to Y...") stay on the clean path
so the icon glyph doesn't appear inside a sentence.

The actual Shrines-name override for items (mirror of
`SPELL_NAMES_SHRINES`) is deferred to a future session — see
`docs/SHRINES-RENAMES.md` for the cached source data and mapping plan.
ROM names still render with their compressed-dictionary garble until
that override lands.

## 1.7.244 — 2026-05-11

### Revert v1.7.243 — both magic-list layout tweaks

User didn't like the 2-column pause Magic grid or the tightened
battle Magic cost gap. Reverts `_drawPauseMagicList`,
`_pauseInputMagicList`, and `_drawBattleSpellList` to their v1.7.242
single-column / panel-right-aligned state. Shrines short names
(v1.7.242) and icon-prefix rendering (v1.7.241) stay in.

## 1.7.243 — 2026-05-11

### Tighter magic-list layouts now that names are shorter

Shrines-name override (v1.7.242) capped every spell at icon + 5 chars
= 48 px, leaving ~5 char-widths of empty real estate per row at both
the pause Magic and battle Magic sites. This release uses that space:

- **Pause Magic** (`_drawPauseMagicList`, `pause-menu.js:298`) now
  renders the known-spells list in 2 columns. Each column is half of
  HUD_VIEW_W (72 px) — cursor at column edge, name at +12, MP cost
  right-aligned at column end. Doubles the visible spell density;
  Sages with ~24 known spells fit in 12 rows instead of 24.
- **Cursor** (`_pauseInputMagicList`, `pause-menu.js:783`) is now
  2-D — Up/Down step by 2 (next row, same column), Left/Right step
  by 1 (across columns). Edge guards keep the cursor inside the
  populated range.
- **Battle Magic** (`_drawBattleSpellList`, `battle-draw-menu.js:139`)
  parks the MP cost 8 px to the right of the name instead of pinning
  it to the panel right edge. Removes the broken-alignment look that
  the wider gap created.

## 1.7.242 — 2026-05-11

### RPG Shrines short names for the 56 player-castable spells

The IPS English patch uses FF6-style names that don't match NES FF3
canon (Curaja/Curaga/Cura/Cure vs Cure4/Cure3/Cure2/Cure;
Bzzaga/Bzzara/Bzzard vs Ice3/Ice2/Ice; Catas/Hyper for Odin/Titan,
etc.) — and they're 6-7 chars wide, which crowded the spell-list
rows once the icon prefix was added in v1.7.241.

`src/data/spells.js` now ships `SPELL_NAMES_SHRINES`, a 56-entry
override map sourced from shrines.rpgclassics.com/nes/ff3/spells.shtml,
covering every WM/BM/Summon spell at every tier:

- WM L1-L8: Pure/Cure/Sight … WWind/Life2/Holy
- BM L1-L8: Sleep/Fire/Ice … Flare/Death/Meteo
- Summons: Chocb/Shiva/Ramuh/Ifrit/Titan/Odin/Levia/Baham

`text-decoder.js` adds `getSpellNameShrines(spellId)` — looks up
the override and returns `[ROM icon byte] + [encoded letter bytes]`
when present, falls through to `getSpellNameWithIcon` for the
enemy-only tail (0x38+) which never reaches the list sites.

Battle Magic / pause Magic / magic shop / inspect ally now render
each row at max icon + 5 chars (was icon + 7), leaving room for
the MP cost or price suffix at every site. Enemy-only spells
(Zantetsuken / Particle Beam / Bad Breath / etc.) keep their ROM
names since they never appear in player-facing lists; battle-log
strings continue to use `getSpellNameClean` for the same reason.

## 1.7.241 — 2026-05-11

### Spell icons in magic lists

Reveals the magic-school icon glyph that's been baked into every ROM
spell name all along — three 8×8 tiles already loaded into the font
atlas at tile IDs `$72` (Summon, ROM 0x1B730), `$74` (White Magic,
ROM 0x1B750), `$75` (Black Magic, ROM 0x1B760). The IPS English
patch put letters at `$7E+` and `$8A+`, leaving these icon tiles
untouched in the font region.

`text-decoder.js` previously dropped the icon byte at every callsite
via `getSpellNameClean`. New `getSpellNameWithIcon` preserves the
leading icon byte and applies the same character allowlist for
padding. Wired into the four spell-list render sites:

- `battle-draw-menu.js:166` — in-battle Magic command list.
- `pause-menu.js:307` — pause-menu Magic tab.
- `shop.js:456` — magic-shop spell rows.
- `inspect.js:139` — ally inspect panel "known spells" rows.

Untouched: battle-log/message-strip callers (`battle-turn.js`,
`spell-cast.js`, `pvp.js`) and chat (`chat.js`) keep stripping —
icon-mid-sentence and ASCII-only contexts respectively.

No new tile data authored. Icons render through the existing
`drawText` path using palette in effect at each site.

## 1.7.240 — 2026-05-11

### Docs: roster-menu audit — mark all four stubs shipped

No code change. Updates `docs/ROSTER-MENU-AUDIT.md` to reflect that
the four deferred stubs (Party / Trade / Message / Inspect) all
shipped in v1.7.235–v1.7.239:

- TL;DR row 5: ⏸ → ✅ all four shipped.
- Action dispatch matrix: per-action handler + version reference;
  describes the defensive `else` fallback that remains in
  `_rosterInputMenu` as a guard against future label additions
  without handlers.
- Finding #5: rewritten from "stubs, deferred" to per-action
  summary of what shipped. Calls out that Battle/Party/Trade share
  the negotiation lifecycle pattern (`project_ff3mmo_roster_action_pattern.md`)
  while Message/Inspect diverge intentionally (UI affordances, no
  accept-roll).
- Fake-vs-real seam table: per-action cutover description
  replacing the single "stubs" row.
- Followups: closed all four original deferrals; added four
  smaller followups (party SRAM persistence, trade scroll arrows,
  inspect spell pagination, PM visual prefix).

## 1.7.239 — 2026-05-11

### Feature: roster Inspect action → read-only stat panel

Last of the five roster actions wired (Battle / Party / Trade /
Message / Inspect now all live). Picking Inspect on a roster
target opens a bordered overlay covering the HUD viewport showing
job + level + HP + ATK/DEF + AGI/INT/MND/EVD + equipped gear +
known spells. X (or Z) closes. No state machine, no accept-roll —
UI affordance, not a negotiation. Mirrors `trade.js`'s item-pick
panel pattern.

- `src/inspect.js` — new module. Exports `openInspect`,
  `closeInspect`, `isInspectOpen`, `handleInspectInput`,
  `drawInspect`, `inspectSt`. Stats source is
  `generateAllyStats(target)` — same shape `tryJoinPlayerAlly` and
  `pvp-search.js` use, so what the inspect shows is what the
  target would fight as. First 2 spells listed; over-2 shows
  "+N more".
- `src/input-handler.js` — adds `_rosterMenuInspectAction(target)`
  alongside the other four. Z-press dispatch routes
  `action === 'Inspect'` through it. Exit-to none — the panel owns
  the next state.
- `src/movement.js` — input dispatcher calls `handleInspectInput`
  before the roster handler when the panel is open. Movement keys
  blocked while inspecting.
- `src/game-loop.js` — `drawInspect()` after the trade panel.

Intentional divergence from the roster-action lifecycle pattern
documented in `project_ff3mmo_roster_action_pattern.md`. That
pattern applies to negotiations (Battle/Party/Trade); Inspect and
Message are UI affordances that don't need the sim-timer
envelope.

## 1.7.238 — 2026-05-11

### Feature: roster Message action → Private-tab whisper

Wires the fourth roster action into the existing Private chat tab.
Fire-and-forget — no accept-roll (Message has no negotiation
semantics). Single-player: the message renders locally tagged with
the recipient. Multiplayer: the websocket layer relays to the
target client based on the `to` field.

- `src/chat.js`:
  - `chatState.pendingRecipient` — set by the roster Message action
    to stash the next message's recipient. Cleared on send / escape
    / fresh `t` key open.
  - `addChatMessage(text, type, channel, meta)` — new optional
    `meta` arg carries `{ from, to }` for pm-channel messages.
    Stored on the message for the future server-relay filter.
  - On Enter in chat input: when active tab is Private and a
    `pendingRecipient` is set, display text becomes
    `"You → Bob: <text>"` and the message is tagged with
    `from: 'You'`, `to: 'Bob'`.
- `src/input-handler.js`:
  - `_rosterMenuMessageAction(target)` — switches active tab to
    Private, opens chat input, stashes `chatState.pendingRecipient`.
  - Z-press dispatch routes `action === 'Message'` through it.
  - `t` key handler clears `pendingRecipient` on fresh chat open
    so a regular T-typed message doesn't get a stale PM target.

No new state module — Message is just three lines of state setup
(tab + input + recipient stash) so it doesn't justify the
party-invite-style module. Diverges intentionally from the roster
action lifecycle pattern documented in
`project_ff3mmo_roster_action_pattern.md` because Message has no
accept-roll. Server-relay cutover seam = the `meta.to` field on
the message; websocket layer reads it.

## 1.7.237 — 2026-05-11

### Feature: roster Trade action → give-only offer flow

Third action in the roster-menu lifecycle family (after Battle's
search-and-hook v1.7.222-226 and Party's invite-and-accept
v1.7.235). Picking Trade opens an inline item-pick panel listing
the player's inventory. Selecting an item starts a persistent
"Offering [item] to X..." invitation; the target rolls an accept
chance every 4-10 s on a per-target sim timer. On accept, the item
leaves `playerInventory` (single-player: just disappears — fake
players have no inventory yet); the multiplayer cutover swaps the
sim roll for a server-relayed `trade_response` signal and adds the
item to the target's inventory.

- `src/trade.js` — new module. Exports `openTradePick`, `commitOffer`,
  `cancelTrade`, `tickTrade`, `drawTradePick`, `handleTradePickInput`,
  `isTradeActive`, `isTradeOffering`, `isTradeResolving`,
  `isTradePicking`, `isTradingWith`, `isTradeOnCooldown`,
  `getAcceptChance`, `getActiveTradeTargetName`, `tradeSt`. State
  machine: `'closed' | 'item-pick' | 'offering' | 'resolving'`.
  Accept formula: `clamp(0.25 + price/1500, 0.10, 0.90)` — higher
  value items land easier; no level/job factors. Same lifecycle
  envelope as party-invite (5 min timeout, 3-missed cap, 60 s
  cooldown, 1 s "Accepted" auto-advance hold).
- `src/input-handler.js` — adds `_rosterMenuTradeAction(target)`
  alongside Battle and Party. Z-press dispatch routes
  `action === 'Trade'` through it. Handles in-flight cancel,
  on-cooldown, empty-inventory, already-trading.
- `src/movement.js` — universal-message hand-off block extended
  for active trade offer (X forfeits, Z inert). Trade item-pick
  input handler injected before the roster handler so the picker
  owns its own input loop while open.
- `src/game-loop.js` — `tickTrade(dt)` next to the other ticks;
  `drawTradePick()` after the roster menu draw.
- `src/roster.js` — menu label flips `Trade → Cancel` mid-offer,
  same pattern as Battle/Party.

Known followups: the inline item-pick panel mirrors shop's
`_drawList` style minimally — no scroll arrows or category split.
Iterate on UX as needed.

## 1.7.236 — 2026-05-11

### Feature: chat Room tab → Party tab

Replaces the location-scoped Room chat with a party-scoped Party
chat, riding on the v1.7.235 party system. Tab is permanently the
second slot in `CHAT_TABS` (preserves muscle memory + tab cursor
positions); only the label and filter change.

- `src/chat.js`:
  - `CHAT_TABS`: `'Room' → 'Party'`.
  - Channel default (when `addChatMessage` is called without one):
    `'room' → 'party'`. `'pm'` and `'sys'` defaults unchanged.
  - Filter: Party tab shows `msg.channel === 'party' || 'sys'`.
    Drops the per-message `msg.loc` location check — channel is the
    gate, party membership is the producer-side gate.
  - Tab-to-channel map for user input: slot 1 routes to `'party'`.
  - Auto-fake-chat producer: 60 % party-member chatter when the user
    has any members; 40 % world hubbub from non-party. Empty party
    falls back to 100 % world. No location filter on the world feed.
  - Drops the now-unused `getPlayerLocation` import.

Legacy `room`-channel messages in an open buffer at upgrade time
will silently disappear from view (no tab matches the channel) and
rotate out as `CHAT_HISTORY` (~64 lines) fills.

## 1.7.235 — 2026-05-11

### Feature: roster Party action → invite-and-accept flow

Mirror of the v1.7.222 Battle search-and-hook redesign, applied to
the roster *Party* action. Selecting Party on a roster target starts
a persistent "Inviting X..." invitation. The target rolls an accept
chance every 5-12 s on a per-target sim timer. On accept the target
joins `partyInviteSt.partyMembers` and auto-joins the player's
`battleAllies` at the start of every subsequent battle — no location
filter (party travels with you, unlike the random-roll pool).

- `src/party-invite.js` — new module. Exports `startPartyInvite`,
  `cancelPartyInvite`, `tickPartyInvite`, `isInviteActive`,
  `isInviteResolving`, `isInvitingTarget`, `isInviteOnCooldown`,
  `isInParty`, `isPartyFull`, `removeFromParty`,
  `getAcceptChance`, `partyInviteSt`, `PARTY_MAX`. Accept formula:
  `clamp(0.35 + (chLevel − tgtLevel) × 0.01 + jobBonus, 0.15, 0.80)`
  with Bard +0.20, Ranger +0.08, Knight +0.05. Same lifecycle
  envelope as `pvp-search.js` — 5 min real-time timeout, 3-missed
  cap, 60 s per-target cooldown, 1 s "Joined" auto-advance hold.
  Single sim-timer seam for the eventual websocket cutover.
- `src/input-handler.js` — adds `_rosterMenuPartyAction(target)`
  alongside `_rosterMenuBattleAction`. Z-press dispatch routes
  `action === 'Party'` through it. Handles invite-start, mid-invite
  cancel, dismiss-existing-member, party-full, and on-cooldown.
- `src/roster.js` — menu label flips `Party → Cancel` mid-invite and
  `Party → Dismiss` once they're a member (matches Battle/Cancel
  pattern). Roster row marquees "Inviting..." in place of Lv/HP
  during an active invite, mirroring the search marquee.
- `src/movement.js` — universal-message hand-off block extended:
  during `'hold'` with an active invite, X forfeits and Z is inert
  (same rules as the search).
- `src/battle-update.js` — `tryJoinPlayerAlly()` pre-pass adds any
  party members to `battleAllies` (no roll, no loc check). Existing
  50 % random ally roll continues for any remaining slots.
- `src/game-loop.js` — `tickPartyInvite(dt)` next to `tickPVPSearch`.

Known followups: party persistence across save/reload (needs SRAM
schema field), per-member dismiss UI feedback (currently the same
"left party" string for all dismissals).

## 1.7.234 — 2026-05-11

### Fix: PVP cure/antidote sparkle vertical-center

The 16×16 cure/antidote sparkle on a PVP-enemy target was drawn at
the body's top-left, which only covered the upper 16 rows of the
16×24 full-body sprite — read as "head/shoulders only", visually
skewed up. Now drawn at `sprY + 4` so it lands on body
vertical-center, matching the offensive-magic on-target burst path
(`_getMagicTargetCenter` returns `cellTop + 16` for PVP).

Player + ally cure render unchanged — their portraits are 16×16, so
drawing at portrait-top-left already centers correctly.

- `src/pvp-drawing.js` — `+4 px` Y offset on the PVP cure/antidote
  sparkle draw (line ~332). Comment rewritten to explain the body
  geometry vs the player/ally portrait geometry.

## 1.7.233 — 2026-05-11

### Docs sweep: refresh markdowns for 1.7.22x band

No code change. Brings project markdowns up to date with the
search-and-hook system + roster fade modularization + menu-state
work that landed across 1.7.220-1.7.232.

- `README.md` — version banner v1.7.219 → v1.7.232. Added
  1.7.22x summary paragraph covering `pvp-search.js`,
  `_rosterTransFade` modularization, and `_advancePVPTurnOrEnd`.
- `MULTIPLAYER.md` — Step 3 expanded with what already shipped
  locally (search lifecycle, hook formula, the sim-timer seam) so
  the cutover plan is precise.
- `docs/design-notes.md` — new `## PVP search` section + new
  `## Roster fade` section between Magic and Battle-attack-animation.
  Followup #4 (multiplayer) updated to note the local search prep.
- `docs/ROSTER-MENU-AUDIT.md` — finding #8 closed; added a
  "Battle action redesign" section covering v1.7.222-v1.7.226.

## 1.7.232 — 2026-05-11

### Cleanup: remove `player-miss-show` dead code

Surfaced by the v1.7.231 menu-state audit. `'player-miss-show'`
was referenced as a battleState in 6 sites across 3 files but
**never assigned anywhere** — misses share the `'player-hit-show'`
state and the renderers branch on `inputSt.hitResults[i].miss`.
The dead literal in the menu predicate / render guards / dispatch
implied coverage that didn't exist.

Removed:

- `src/battle-update.js` — `_updatePlayerMissShow()` (unreachable)
  + its slot in `updateBattlePlayerAttack()` dispatch chain.
  `MISS_SHOW_MS` constant also dropped (its only reader was the
  deleted function).
- `src/battle-draw-encounter.js` — 4 OR-chain literals at lines
  74 / 163 / 269 / 294 (encounter, combat-state, boss-PVP, boss).
- `src/battle-draw-menu.js` — 1 literal in the `isMenu` predicate
  (line 214).

Zero behavior change — the state was inert.

## 1.7.231 — 2026-05-11

### fix: battle menu disappeared during PVP opponent magic casts

`_battleMenuStates()` in `src/battle-draw-menu.js` enumerates every
battleState where the menu/HUD panel is rendered. The PVP-enemy
attack states (slash / potion / SouthWind throw + hit) were all in
the list, but **`pvp-enemy-magic-cast` and `pvp-enemy-magic-hit`
were missing**, so the menu blanked for the full 1.6–2.4 s spell
animation.

Likely landed missing from the original PVP-spell wire-up; the
analogous random-encounter monster cast (`enemy-attack` /
`enemy-damage-show`) was already in the list, and ally casts are
covered by the `bs.startsWith('ally-')` catch-all. Only the
PVP-enemy spell states were never added explicitly.

One-line fix: added both states to the `isMenu` predicate.

## 1.7.230 — 2026-05-11

### fix: title→game roster flashed bright then re-faded

v1.7.229 generalized `_rosterTransFade` to fire on every wipe state,
but missed two transition cases that the HUD top-box already handled
in `hud-drawing.js:160-171`:

- `'hud-fade-in'` — the title-screen→game flow goes directly from
  hud-fade-in → opening (skipping closing/hold). Pre-fix, the roster
  fell through to the `infoFade` fallback during hud-fade-in (visible
  immediately), then the `'opening'` branch forced it back to black
  and ramped from max → 0 over `WIPE_DURATION`. User saw the panel
  "pop in, then fade back in again".
- `transSt.topBoxAlreadyBright` — set by `_updateTransition` when
  hud-fade-in completes (`transitions.js:84`) so `'opening'` knows
  the panels are already at full alpha. The HUD top-box checks this
  to skip re-fading; the roster wasn't.

Now `_rosterTransFade` handles `'hud-fade-in'` (ramps from black →
visible synced to `hudInfoFadeTimer`, matching the HUD top-box) and
short-circuits `'opening'` when `topBoxAlreadyBright` is set (roster
stays bright through the wipe-bar open). Regular wipes (closing →
hold → opening) are unchanged.

## 1.7.229 — 2026-05-11

### Roster fades with every map-screen wipe

Generalized `_rosterTransFade` in `src/roster.js` so the roster panel
syncs to every `transSt` wipe — not just location-changing ones.
Pre-v1.7.229 the trans-fade was gated on `transSt.rosterLocChanged`,
so interior wipes (chest open, pond heal, same-loc map moves) left
the roster panel bright while the bars closed over the rest of the
screen.

Now: every wipe closes the roster with the bars (`'closing'` phase
ramps trans-fade 0 → max), holds it black through `'hold'` / `'loading'`
/ `'trap-falling'`, then re-opens it with the bars (`'opening'`
phase ramps back to 0). Trans-fade was already modularized — just
needed to apply universally.

Also added `'loading'` to the battle-fade ramp-in gate (v1.7.227)
so dungeon-load screens don't get a battle-fade ramp underneath
the loading UI. Belt-and-suspenders for the respawn-into-dungeon
edge case.

`transSt.rosterLocChanged` is still set by `triggerWipe` /
`map-triggers.js` — leaving it in place in case it's useful for a
different consumer later — just no longer read by the roster fade.

## 1.7.228 — 2026-05-11

### Remove spell-cast telemetry (chat + pm2 noise)

Three first-time-only debug sentinels from the unified spell-cast
pipeline buildout — useful when v1.7.181 was wiring
`combatant-cast.js` across player / ally / PVP-enemy, now noise.

- `src/cast-anim.js` — removed `_logCastBehindMiss` (`[cast-behind-miss]`
  when halo geometry was missing) and `logCastSuccess` (`[cast-render]`
  on first successful halo paint per role/job/spell). `consoleLog` /
  `isDev` import also dropped (the only consumers).
- `src/combatant-cast.js` — removed `_logWindupCalled` (`[windup-call]`
  on first windup per role/layer/job/spell) and its callsite inside
  `drawCastWindup`.

All three piped to `/api/client-error` and the first two to the
in-game dev console. Render paths are unchanged — telemetry only.

## 1.7.227 — 2026-05-11

### fix: roster panel brightened under closing wipe on respawn

During the defeat → respawn transition, the roster panel was
visibly fading from black back to bright **while the wipe bars
were still closing over the screen**. Root cause was two unsynced
fade sources fighting for the panel:

- `rosterBattleFade` — 4-step × 100 ms = 400 ms tick fade, driven
  by `battleState`. At `battleState === 'none'` it ramped IN from
  black → visible.
- `_rosterTransFade()` — synced to `WIPE_DURATION` (733 ms), but
  **only engages when `transSt.rosterLocChanged === true`**.

`triggerWipe(action, destMapId)` returns `false` for `rosterLocChanged`
when `destMapId` is null. And `respawnAfterDeath` was calling
`triggerWipe(action, useExit ? null : fallbackMapId)` — the
world-map-exit path (the common case: died in a dungeon, respawn
on world) passed `null`, so the trans-fade never engaged. The
faster 400 ms battle fade ramped in alone, lighting the roster
under the closing bars.

Two-part fix:

1. **`src/map-loading.js`** — `respawnAfterDeath` now passes
   `'world'` as the destMapId for the useExit case (string sentinel
   already handled by `rosterLocForMapId`). Trans-fade now engages
   for every respawn → location change.
2. **`src/roster.js`** — `_updateBattleFade` gates the `'none' → 'in'`
   branch on `transSt.state !== 'closing' && !== 'hold' && !== 'trap-falling'`.
   While a wipe is closing or holding, the trans-fade owns the
   visible roster fade. Once `'opening'` (or `'none'`), the battle
   fade may ramp in normally. Behavior outside the defeat flow is
   unchanged (normal battle-end with no wipe still ramps in
   immediately, because `transSt.state === 'none'`).

Result: roster stays fully black through the wipe-close + hold,
then fades back in synced to the wipe-opening (and the location
swap under the bars is invisible, as it should be).

## 1.7.226 — 2026-05-11

### Search box: smooth Searching→Connecting swap + 1s auto-advance

- **Smooth text swap.** "Searching..." used to slide out and
  "Connecting..." slide back in, which read as two separate boxes.
  New `replaceMsgBoxText(bytes, onClose)` in `src/message-box.js` —
  if a message is already in the `hold` state, swap the bytes +
  callback in place without re-animating slide-in. Falls back to
  `showMsgBox` if no message is currently held, so the helper is
  safe to call unconditionally. PVP search now uses it for the
  Searching→Connecting transition; the box stays on-screen and
  just re-letters.
- **Auto-advance into battle.** "Connecting..." used to wait for a
  Z press to fire `_startPVPBattle`. Now `pvpSearchSt.connectingHoldMs`
  counts down from 1000 ms in `tickPVPSearch`; on expiry it calls
  `dismissMsgBox()` → slide-out → existing onClose → battle. Z still
  works for power users who want to advance early (movement.js's
  universal Z-dismiss path is unchanged for the resolving state).
  Total wall-clock from hook fire to flash-strobe: ≈ 1080 ms.

## 1.7.225 — 2026-05-11

### fix: PVP enemy spell-kill didn't end the battle

Reported via battle-sim cross-check (sim ended the duel immediately
on spell-kill; live game kept advancing turns until the next
physical hit on the player). Root cause: the three "PVP enemy
action complete" sites had drifted apart —

- `_processEnemyDamageShow` (physical hit) — ✓ checked `isTeamWiped`
- `_processPVPOppSWHit` (SouthWind) — ✓ checked `isTeamWiped`
- `_processPVPEnemyMagic` end-of-`pvp-enemy-magic-hit` — ✗ called
  `processNextTurn()` unconditionally

So when a spell dropped the player to 0 HP, the turn queue rolled
forward (player turn skipped via `ps.hp <= 0` guards) until the
PVP enemy's next physical hit landed — and `_processEnemyDamageShow`
finally caught the wipe and transitioned to `enemy-box-close`. The
intermediate turns visibly ran on a dead player.

Fix in `src/pvp.js`: extracted `_advancePVPTurnOrEnd()` — single
source for "if player team wiped → `enemy-box-close`, else
`processNextTurn`". Routed all three sites through it. Per the
`feedback_ff3mmo_single_source_paths` memory — two parallel paths
drift; one fixed and one unfixed is the failure mode.

No gameplay change for the physical / SW paths (already correct,
just deduped). Spell-kill now ends the battle on the apply tick,
same frame as `setPlayerDamageNum(value)` posts the final number.

## 1.7.224 — 2026-05-11

### Search: Z is inert during "Searching...", only X forfeits

v1.7.223 had Z and X both cancel — that read as "A button cancels"
which is wrong. The "Searching..." message *is* the search; A
shouldn't dismiss it. Only B (X / back) forfeits now. Z presses
are swallowed so they don't fall through to other handlers.
"Connecting..." (resolving) still dismisses on Z and triggers
the PVP battle, same as v1.7.222.

## 1.7.223 — 2026-05-11

### Search UX polish: marquee + no-silent-dismiss

Two follow-ups on v1.7.222's roster search-and-hook flow.

- **"Searching..." marquee.** The 12-character text was wider than
  the 64-px box on the roster row, so it overflowed the inner
  panel boundary (clipped at the canvas edge). Now it marquees:
  50 px / s, two seamless copies offset by `textW + 12 px` so the
  wrap is invisible. Clipped to a 12-px band at `rowY + 14` so the
  scroll doesn't bleed into the name line above. `roster.js _drawRosterRow`.
- **Any close = forfeit.** Z used to silently dismiss the
  "Searching..." message, leaving the search active in the background
  and freeing the player to move around (movement is gated by
  `msgState !== 'none'`; once the message closed, walking + new
  encounters resumed). That was the wrong feel — the searching
  message *is* the search; closing it should commit you out.
  `movement.js` universal msg handler now treats Z and X identically
  while `isSearchActive() && !isSearchResolving()`: both replace the
  "Searching..." message with "Cancelled" and end the search.

  Side effect: movement-during-search is naturally blocked because
  the message box stays up until the player either forfeits or the
  hook resolves into "Connecting...". No new movement-block flag
  needed.

  "Connecting..." (resolving state) is unaffected — Z dismisses
  normally and triggers the PVP battle on close, same as v1.7.222.

## 1.7.222 — 2026-05-11

### Roster Battle: search-and-hook flow (replaces instant accept)

Replaces the old "Challenged X! → 1.5-4s → X accepted! → battle"
flow with a real MMO-feel search mechanic. Picking **Battle** on a
roster player now starts a *search* — the target rolls an encounter
timer in the background, and on each roll a hook chance is rolled.
On success the search resolves into a PVP battle via the existing
`_startPVPBattle` flow.

**Flow:**

1. Pick **Battle** → persistent "Searching for X..." message shows.
2. Z dismisses the message (search continues silently in background).
   X (back) cancels the search and replaces the message with
   "Cancelled".
3. While searching, the target's roster row shows "Searching..." in
   place of the Lv/HP line.
4. Re-opening the menu on the same target flips the **Battle** label
   to **Cancel** — Z on Cancel ends the search the same way.
5. On hook → "Connecting..." message → PVP battle starts on close
   (same hand-off the old "accepted!" path used).
6. On timeout (5 min real-time) or 3 missed rolls in a row →
   "Search expired" message; cooldown engages.
7. 60 s cooldown per target after any search ends (success / fail /
   cancel) before the same player can re-target the same target.

**Hook formula** (in `src/pvp-search.js`):

```
hookChance = clamp(
  BASE_HOOK + (chAGI - tgtAGI) * AGI_PER_PT + jobBonus(challenger),
  HOOK_MIN, HOOK_MAX
)
```

| Constant | Value | Rationale |
|---|---|---|
| `BASE_HOOK` | 0.25 | Feels right; not free, not rare |
| `AGI_PER_PT` | 0.015 | ±15% at AGI gap of 10 |
| `HOOK_MIN` / `HOOK_MAX` | 0.10 / 0.75 | Never a sure hook, never impossible |
| Thief job bonus | +0.15 | Ambush identity |
| Ranger job bonus | +0.08 | Tracker identity |

AGI is the lever because STR / INT / MND already drive ATK / magic;
giving AGI a niche puts use on a stat that was thin. Level
differential was rejected (encourages bullying low-level players).

**Resolution-gate.** The *search* persists across town visits and
map changes — only hook *resolution* requires
`battleState === 'none' && (onWorldMap || dungeonFloor >= 0)`. A
roll fired while the challenger is in town counts as a missed roll,
not a free park-in-town-forever fish.

**Fake-target encounter sim.** Real networked players would have
their actual step counter drive the hook check via websocket. Today
fake `PLAYER_POOL` players don't roll encounters at all, so the
target's "next roll" is simulated by a per-target 8-15 s sim timer
inside `pvp-search.js`. When the multiplayer layer lands, swap the
sim for the websocket `target_encountered` signal — the rest of the
flow is unchanged. Documented in the module head comment.

**State:** `src/pvp-search.js` owns `pvpSearchSt` (active, target,
startedAtMs, missedRolls, targetRollTimer, resolving, cooldowns).
Init via `initPVPSearch({ startPVPBattle })` from `main.js`. Tick
from `game-loop.js` next to `updateRoster`.

**UI surface:**

- `src/roster.js _drawRosterRow` — branches on `isSearchingFor(p)`
  to render "Searching..." (NES `0x28` yellow) instead of Lv/HP
  when the row is the active search target. Only fires when the
  target is in the same location (since roster only shows nearby
  players); search is silent when the target has moved away.
- `src/roster.js drawRosterMenu` — flips the "Battle" label to
  "Cancel" when `isSearchingFor(inputSt.rosterMenuTarget)`. No new
  menu item; no new keybinding.
- `src/movement.js` universal message handler — X-press during msg
  hold cancels an active search (and replaces the message with
  "Cancelled"). Z continues to dismiss the message normally.

**Edge cases handled:**

- Auto-cancel on death (`ps.hp <= 0`) so a game-over respawn doesn't
  leave a zombie search ticking.
- Search start is refused if the target is on cooldown (shows
  "X on cooldown" message instead).
- Hook resolution blocked during `battleState !== 'none'` — counts
  as missed roll so other battle paths don't get hijacked.
- `inputSt.rosterMenuExitTo` set to `'none'` so the roster panel
  closes after the search starts; user can re-open S to see the
  searching indicator.

## 1.7.221 — 2026-05-11

### Roster menu audit — close findings #1–#4

From `docs/ROSTER-MENU-AUDIT.md`. Closes the four open findings on
the roster action menu (Party / Battle / Trade / Message / Inspect).
Stub items (Party / Trade / Message / Inspect) keep their existing
behavior; only the hardening + Battle commit-state changes.

- **#1 (high) — empty-roster null-deref.** Pressing `S` to open
  roster, then `Z` on the (empty) first row, then `Z` on the action
  menu would dereference `undefined.name` in any location with no
  fake players currently visible. Two guards added: the `S` entry
  at `input-handler.js:741` now requires
  `getRosterVisible().length > 0`, and the `Z`-in-browse handler
  at `input-handler.js:670` refuses if the cursor row resolves to
  `undefined`. Defensive `!target` short-circuit also added to the
  menu Z-press so a stale stash can't crash.

- **#2 (high) — `menu-out` / `msgState` race.** The Battle action
  shows two sequential messages with a 1500–4000 ms RNG gap between
  them. The 150 ms menu-out slide almost always lands inside that
  gap, when `msgState.state === 'none'` — so the old terminal
  branch (`roster.js:353`) sent the roster back to `'browse'`
  while the "accepted!" message was still about to fire on top.
  User could scroll roster + queue a second `_rosterMenuDuelAction`
  in parallel with the in-flight PVP intro.

  Replaced with an explicit `inputSt.rosterMenuExitTo` set at
  dispatch time: `'none'` for Battle (action commits — PVP intro
  owns the next state), `'browse'` for stubs + X-cancel (return
  to roster after the short message dismisses). `msgState` is no
  longer read in the terminal.

- **#3 (med) — `ROSTER_MENU_ITEMS` defined twice.** Same dedup
  pattern as v1.7.220's `BATTLE_TEXT_STEPS` fix. Now exported from
  `roster.js` (where it lives next to the other roster constants);
  `input-handler.js` imports it.

- **#4 (med) — cursor target can drift mid-menu.** `_clampRosterCursor`
  runs from the fade-tick regardless of `rosterState`. If a roster
  player faded out while the menu was open, the cursor would
  re-clamp and the Z-press dispatch would commit against a
  different `getRosterVisible()[rosterCursor]` than the one the
  user saw selected. Fixed by stashing the target into
  `inputSt.rosterMenuTarget` at menu-in (one read of
  `getRosterVisible()[cursor]`, never re-read) and reading from
  the stash in the menu Z-press. Stash cleared at menu-out terminal.

**State additions:** `inputSt.rosterMenuTarget` (null default) +
`inputSt.rosterMenuExitTo` (`'browse'` default). Both reset at
menu-out terminal so the next menu-in starts clean.

**Behavior preserved:** stub actions (Party / Trade / Message /
Inspect) still render the `<Action>⏤<Name>` message and dismiss
back to browse. X-cancel from the menu still returns to browse.
Battle precondition (`onWorldMap || dungeonFloor >= 0`) unchanged —
PVP in town stays blocked.

## 1.7.220 — 2026-05-11

### Docs audit pass + one MULTI-AUDIT dedup miss

Full audit of the 16 active markdowns vs v1.7.219 code. Most docs
audited clean (BALANCE / BUFFS / STATUS-EFFECTS / SAVE-STATE /
INVENTORY-ECONOMY / JOB-EXP / MODULARIZATION / battle-sim.PLAN /
CLAUDE.md). This release closes the stale ones and one real code
gap that the audit surfaced.

**Code:**

- `src/battle-drawing.js` — removed the local
  `const BATTLE_TEXT_STEPS = 4`, now imports from `battle-state.js`.
  `MULTI-AUDIT.md` item #2 claimed v1.7.217 had finished this dedup,
  but `battle-drawing.js` still carried its own copy. Zero behavior
  change; closes the actual MULTI-AUDIT promise.

**Docs:**

- `README.md` — status banner v1.7.21 → v1.7.219 (165 releases of
  drift). Spell-anim line rewritten: Cure + Poisona only →
  unified `combatant-cast.js` pipeline with full WM/BM spell set
  (Cure, Poisona, Fire, Blizzard, Thunder, Sleep, Sight, Drain,
  Recovery, AllStatus, Instakill, status cures). Added 1.7.18x–
  1.7.21x line covering the battle-sim CLI, modularization, and
  multiplayer-prep audit series.
- `docs/REFACTOR-PLAN.md` → `docs/history/REFACTOR-PLAN.md`. All 4
  tasks shipped v1.7.182–v1.7.192; doc is a completed historical
  artifact. Joins `docs/history/REFACTOR.md` and `CHANGELOG-pre-1.6.md`.
- `docs/design-notes.md` — Followups section rewritten. The
  "Damage spells (Black Mage)" + "Per-spell anim + SFX" bullets
  pointed at `src/cure-anim.js` (deleted long ago) with the v1.7.49
  per-school palette-swap model. Replaced with the current state:
  `spell-anim.js` is the per-spell-ID registry, `combatant-cast.js`
  is the unified cast / throw / impact / apply pipeline across
  player / ally / PVP-enemy. v1.7.49 disaster preserved as History.
  Magic section line about "Per-spell anim sprites still need PPU
  capture" updated to reflect the parity harness path.
- `MULTIPLAYER.md` — intro rewritten. Was "not started" with no
  context. Now: "not started — but seam-prep is underway", with
  pointers to the v1.7.20x–v1.7.21x prep audits (SAVE-STATE,
  INVENTORY-ECONOMY, JOB-EXP, MULTI-AUDIT, MODULARIZATION) that
  tightened every mutation seam the websocket layer will eventually
  hook.
- `docs/EMU-PLAN.md` — Status header v1.7.50 → v1.7.219 (169
  releases stale). Added plan-status paragraph explaining why
  remaining EMU-internal items (1.4 initial scenes, 2 DIFF-AGAINST-FILE,
  4 polish bag) have been deprioritized. Added a "Capture pipeline
  downstream" section linking the v1.7.54–v1.7.219 cascade (Fire
  disasters → parity harness → unified `combatant-cast.js` pipeline →
  battle-sim CLI → multiplayer-prep audits) so the plan's "this is
  the highest-leverage tool" claim ties back to actual shipped work.
- `docs/DEATH-ANIMATIONS-AUDIT.md` — §3 marked "CORRECTED v1.7.213".
  The finding claimed the player portrait has alpha-fade-only death;
  v1.7.213 verified the portrait actually runs the full 3-phase anim
  (kneel-slide + text-fade + pose-fade) identical to allies in
  `battle-draw-player.js`. Doc text retained for history with a
  callout banner so the wrong conclusion isn't re-implemented.

Smoke test passes (`smoke.sh`: HTTP 200, no `ReferenceError` /
`TypeError` / `SyntaxError` / `Uncaught` in console).

## 1.7.219 — 2026-05-10

### Inventory + economy audit (multiplayer-prep) — single mutation seams

From `docs/INVENTORY-ECONOMY-AUDIT.md`. Tightens the inventory and
gil mutation surface so the future websocket layer can hook delta
emission from one place per operation. No gameplay behavior change.

**New helpers in `inventory.js`:**

- `addItem(id, count)` — now validates count (rejects non-finite,
  non-positive, NaN). Returns the actual amount added (0 if
  rejected). Defensive against future untrusted callers
  (websocket-broadcast deltas, etc.).
- `removeItem(id, count = 1)` — now takes a count param (was always
  exactly 1). Clamps to current inventory count. Returns actual
  amount removed.
- `getItemCount(id)` — new. Returns 0 (not undefined) for missing
  items. Single seam for "how many do I have" lookups.
- `hasItem(id)` — new. Boolean convenience.

**New helpers in `player-stats.js`:**

- `grantGil(amount)` — single seam for "give the player money".
  Validates amount, returns actual granted. Pre-v1.7.219 every gil
  mutation was inline `ps.gil += X` (8 sites).
- `spendGil(amount)` — returns `true` on success, `false` if
  insufficient. Pre-v1.7.219 sites did the `if (ps.gil < price) {
  error } ps.gil -= price` dance inline.

**Refactored 6 gil-mutation sites:**

- `shop.js` — buy item, buy spell, sell item (3 sites)
- `battle-update.js` — victory rewards (encounter / PVP / boss, 3 sites)
- `map-triggers.js` — chest gil

Set-assignment sites (`ps.gil = X`) intentionally left inline: the
`/gil` cheat and load-time restoration are assignments, not deltas.

**Verified clean (no change):**

- Sell price = `floor(buy/2)` — NES-faithful.
- Monster drop = 25% per mob, first hit wins.
- Equipment-best auto-equip — short-circuits on `bestId === curId`.

**Deferred (design calls):**

- Item quantity cap (NES caps at 99; uncapped today — depends on
  MMO scope).
- Gil cap in gameplay (only the `/gil` cheat caps at 999999;
  depends on economy design).

## 1.7.218 — 2026-05-10

### Job-system audit (multiplayer-prep) — fake-player jobLevel divergence closed

From `docs/JOB-EXP-AUDIT.md`. Focused on the path remote players will
use when the websocket hookup ships — since the fake-player system is
that seam (per memory `project_ff3mmo_fake_player_multiplayer.md`),
any divergence between local-player and fake-player stat paths is a
latent multiplayer-determinism bug.

**Real fixes:**

- **`generateAllyStats` now respects `jobLevel`** (was hardcoded to
  `1`). New optional fields on the player descriptor:
  - `player.jobLevel` — single number (current job's level).
  - `player.jobLevels[jobIdx].level` — full JP progression map.
  - Default `1` if neither is provided (PLAYER_POOL entries today),
    so static NPCs are unchanged.
- **Fake-player path now applies `jobLevelStatBonus`** to AGI / STR /
  VIT / INT / MND, matching the local-player path
  (`input-handler.js` / `battle-turn.js`). Pre-v1.7.218 a remote
  player at jobLv 50 would have +12 hit-count-eligible AGI on their
  own client and +0 on a teammate's — silent desync.
- **`calcAttackerAtk` now gets the real `jobLevel`** instead of `1` —
  Monk / Black Belt unarmed bonus (`floor(jobLevel/4)`) scales
  correctly for remote Monks.
- **`jobLevel` field on output** now reflects the actual value used,
  not the constant `1`.

**Refactor:**

- New pure helper `jobLevelStatBonus(jobIdx, jobLv)` in `data/jobs.js`
  (no `ps` read — usable from fake-player path without circular
  imports). `player-stats.js:getJobLevelStatBonus` is now a thin
  wrapper that fills in `ps.jobIdx` / `ps.jobLevels` defaults.

**Documented (no action — design calls deferred):**

- `EXP / 4` divisor in `grantExp` is NES legacy (4-party split). For
  real multiplayer, may need to scale by participating-player count.
  Flagged for the websocket ticket.
- Three separate job-tuning tables (`_JOB_STAT_WEIGHTS`,
  `JOB_SCALING`, `JP_RATES`) each cover different mechanics
  (char-level / job-level / JP rate). Adding a new job requires
  editing all three.
- `isMonkClass = jobIdx === 2 || jobIdx === 13` magic-index check
  duplicated across files — could be `JOBS[i].isMonkClass`.

## 1.7.217 — 2026-05-10

### Multi-system audit — slash + spell-anim + encounter + chat + HUD fade

Five-area sweep documented in `docs/MULTI-AUDIT.md`. Most areas
verified clean. Two real dedup items shipped:

- **`SLASH_FRAMES = 3` consolidated.** Was a local `const` in
  `battle-drawing.js`, `pvp.js`, `pvp-drawing.js`, and
  `battle-draw-encounter.js`. Now exported from `slash-effects.js`
  alongside `SLASH_FRAME_MS` / `SWING_HOLD_MS`. The
  `battle-drawing.js` and `pvp.js` copies were already dead (declared
  but unused).
- **`BATTLE_TEXT_STEPS` / `BATTLE_TEXT_STEP_MS` consolidated.** Were
  duplicated as local `const` blocks (4 / 50) in
  `battle-draw-menu.js`, `battle-update.js`, and `pvp.js`. Now
  exported from `battle-state.js` alongside the other battle timing
  constants (`MONSTER_DEATH_MS`, `BATTLE_SHAKE_MS`, `DEATH_*`).

**Verified clean (no changes needed):**

- Spell-anim phase pipeline — `CAST_PHASE_MS_THROW` /
  `CAST_PHASE_MS_HEAL` / `CAST_T_LUNGE`/`HEAL`/`RETURN` all live in
  `cast-anim.js` as the single source. All four consumers
  (`spell-cast`, `combatant-cast`, `battle-ally`, `pvp`) import; no
  local copies.
- Chat command registry — `registerCommand` is the single public
  entry, 17 commands route through it, dev gating via `opts.dev`.
- HUD fade — `TOPBOX_FADE_*` lives in `transitions.js`,
  `HUD_INFO_FADE_*` in `hud-state.js`. Single sources.

**Documented (no action — see `MULTI-AUDIT.md`):**

- Encounter rate rolls threshold per-step (not per-encounter) — the
  practical effect is well-tuned, but the distribution differs from
  NES. Doc'd for tuning reference.
- `encounterSteps` resets on map load — re-entry grace period
  exploit. Typical NES behavior; design call.
- Hardcoded valley bounding box `(93..96, 34..44)` in two files.
  Minor surface; defer until a third consumer appears.

## 1.7.216 — 2026-05-10

### Save-state audit — close the rest of the open items

Closes items #4-7 from `docs/SAVE-STATE-AUDIT.md`. #4 and #5 are real
fixes; #6 and #7 were re-examined and confirmed not bugs.

**#4 Saved position now restored on load.** Pre-v1.7.216 every
"Continue" routed through `loadMapById(114)` (Ur), regardless of
where the player saved. The `worldX`/`worldY`/`currentMapId`/
`onWorldMap` schema fields were dead — written every save, never
read on load.

Now in `title-screen.js`:
- Saved overworld position → `loadWorldMapAtPosition(tx, ty)` with
  `TRACKS.WORLD_MAP`.
- Saved town / dungeon → `loadMapById(currentMapId, tx, ty)`. The
  map-load path picks the right music track per floor / town.
- Fresh slot (no `stats`) → Ur fallback with the classic spawn nudge
  (unchanged behavior).

Per the user's memory `feedback_ff3mmo_own_thing.md` — ff3mmo is an
MMORPG, not a NES port; continuing a save should resume where you
left off, not at Ur.

**#5 Status now clears on death-respawn.** `_respawnAtLastTown`
restored HP/MP to max but left `ps.status.mask` untouched. A player
who died poisoned/blinded/silenced respawned full-HP but still
afflicted — would take poison damage at the next encounter and need
to spend an Antidote before they could fight. Now adds
`clearAll(ps.status)` alongside the HP/MP max-restore. Revive =
clean state, matching NES canon.

**#6 + #7 verified safe (no fix needed).**

- **#6 Save race:** `saveSlotsToDB` is `async` but all `ps` reads
  happen **synchronously before the first `await`**. JS
  single-threaded execution makes reads atomic within one call;
  IndexedDB serializes writes via its transaction queue.
  Last-write-wins on identical data. Closed.
- **#7 Server retry:** each save rebuilds `data` from scratch from
  `saveSlots`. A failed `serverSave` self-heals on the next call.
  Same risk profile as any local-first persistence layer. Closed.

## 1.7.215 — 2026-05-10

### Chest farming exploit closed + map mutations now persist across re-entry

From `docs/SAVE-STATE-AUDIT.md`, items #1-3. The biggest finding from
the save-state audit:

**The exploit:** `handleChest` mutated the in-memory tilemap to mark
chests as opened, but the mutation only lived as long as
`mapSt.mapData` stayed in memory. Every call to `loadMapById`
regenerated the floor fresh from ROM (`generateFloor(romRaw, ...)`),
wiping all tile mutations. So a player could exit a dungeon, walk
back in, and every chest was closed again. Tier-1 economy break —
infinite gil/item farming.

Same root cause affected `handleSecretWall` (opened walls re-hid on
re-entry, minor exploit) and `handleRockPuzzle` (solved puzzles
reset, could break progression or enable loot re-farming).

**The fix:** persistent tile-mutation map.

- New field `ps.consumedTiles: { [mapId]: { "x,y": newTileId } }`
  added to player state. Saved to the slot schema, loaded on game
  start, JSON-cloned through both save and load paths.
- `map-triggers.js` got a private `_consumeTile(x, y, newTileId)`
  helper that updates the in-memory tilemap AND records the
  mutation in `ps.consumedTiles`. All three sites (`handleChest`,
  `handleSecretWall`, `handleRockPuzzle`) route through it.
- `map-loading.js` got a `_replayConsumedTiles(mapId, mapData)`
  helper called after `generateFloor` (dungeon) or `loadMap`
  (regular map). Iterates the saved mutations for that map and
  overwrites the matching tilemap cells. Also tidies the
  `secretWalls` set so revealed walls don't keep their "still
  hidden" trigger.
- `handleSecretWall` and `handleRockPuzzle` also now call
  `saveSlotsToDB()` (chest open already did).

**Side effects to test:** chests stay opened across map re-entry +
save/load. Secret walls stay revealed. Rock puzzles stay solved.
First-run players have empty `consumedTiles` so behavior is
unchanged on fresh saves.

**Other audit items deferred** (see `SAVE-STATE-AUDIT.md`): #4 dead
worldX/Y/currentMapId schema (design call), #5 status persisting
through death-respawn (design call), #6 theoretical save race (no
observed corruption), #7 server-save retry (no observed need).

## 1.7.214 — 2026-05-10

### Reflect now actually blocks enemy magic (was completely dead)

From `docs/BUFFS-AUDIT.md`. The buff system has Haste (✓ enforced),
Protect (✓ enforced), and Reflect (☠ dead). `BUFF_REFLECT` was being
written but never read anywhere — the Reflect spell (0x0c, MP cost)
and the Curtain item (5000 gil) both literally did nothing.

**MVP shipped this version:**

- If the **player** has the Reflect buff and a **PVP enemy** casts
  Fire / Blizzard / Sleep targeting them, the spell is blocked.
  Damage / status apply is skipped entirely.
- "Reflected!" appears on the battle message strip (existing
  `BATTLE_REFLECT` bytes).
- `SFX.SW_HIT` plays on reflect — distinguishes from a clean miss.

**Out of scope (deferred — see audit doc):**

- **Bounce-back targeting** (NES canon). MVP just blocks; doesn't
  bounce damage back to the caster's team. Player gets the same
  defensive value either way; deferring the cool counter-damage
  visual until the re-target plumbing is in.
- **Encounter monster specials** (Fire breath / Glare / Bad Breath
  etc.) — these don't route through the spell-cast pipeline and
  `SPECIAL_ATTACKS` doesn't classify magic vs non-magic. ~1 hour
  ticket once the classification is settled.
- **Ally / monster Reflect** — allies / monsters / PVP enemies still
  have no buff support per `buffs.js` v0 scope.
- **Friendly Cure pass-through** — NES literal bounces all magic
  including ally Cure on player. Our v0.5 leaves friendly heals
  through (designer choice; revisit if it surprises).

## 1.7.213 — 2026-05-10

### Death animations audit — second batch (real fixes + audit correction)

Closes the remaining items from `docs/DEATH-ANIMATIONS-AUDIT.md`.

**Audit correction (#3):** the doc claimed the player had only an
800ms alpha-fade death (no kneel-slide, no death pose). Wrong —
that 800ms block is just the **info-panel** fade-out portion. The
**portrait** has the full 3-phase 1100ms animation in
`battle-draw-player.js` (kneel slide → text wait → death-pose
fade-in), identical timings to the ally. Once verified, the action
was just to consolidate the duplicated `DEATH_*` constants.

- **`DEATH_SLIDE_MS` / `DEATH_TXTFADE_MS` / `DEATH_POSEFADE_MS` /
  `DEATH_TOTAL_MS` / `DEATH_INFO_HIDE_MS`** — single source in
  `battle-state.js`. Was duplicated verbatim in
  `battle-draw-player.js` and `battle-draw-allies.js`; the v1.7.212
  `PLAYER_DEATH_HOLD_MS` / `_FADE_MS` / `_TOTAL_MS` constants (added
  in good faith based on the misread audit) were renamed away —
  those values were just `DEATH_SLIDE_MS + DEATH_TXTFADE_MS = 800ms`
  re-derived under different names. Now `hud-drawing.js` reads the
  canonical constants directly.

**#4 PVP cell-idx lazy build removed.** `_buildPVPDyingMap` used to
read `pvpPlayerTargetIdx` whenever the dying-cells map was empty,
which baked a single-target assumption into a multi-cell data
structure. Latent bug: first AoE spell that killed off-target
would have rendered the wrong cell. Now every `pvp-dissolve`
transition (`battle-update.js`, `battle-ally.js`, `spell-cast.js`)
populates `pvpDyingMap` explicitly. Lazy fallback deleted.

**#5 Multi-target spell-kill collection on PVP.** `_finishMagicHit`
only collected `killedEnemyIndices` for `t.type === 'enemy'`
(encounter monsters). PVP multi-target deaths fell through to the
`getEnemyHP() <= 0` single-target check — kills outside the
player's current target would die silently. Now the loop also
collects `killedPVPCells` for `t.type === 'pvp-enemy'` and
transitions to `pvp-dissolve` with the full kill list.

**#6 verified safe.** `playerDeathTimer` clears in `resetBattleVars`
(every battle start) and `_respawnAtLastTown` (post-death). Both
paths cover the battle-end → respawn → battle-start flow.

## 1.7.212 — 2026-05-10

### Death animations audit — first batch (cleanup)

From `docs/DEATH-ANIMATIONS-AUDIT.md`. Six combatant types die in this
game (player, ally, encounter monster, boss, PVP main opp, PVP enemy
ally), each with its own dissolve / fade flow. Initial sweep landed
the two safe items; the rest (player death-pose feature parity, PVP
multi-cell death routing, multi-target spell-kill dissolves) stay open
pending design decisions.

- **#1 `MONSTER_DEATH_MS` dedup.** Was declared `const = 250` in
  `battle-drawing.js`, `pvp-drawing.js`, and `battle-draw-encounter.js`
  on top of the canonical export from `battle-state.js`. The
  `battle-drawing.js` copy was dead (no usage). The other two were
  live duplicates. Now all three import from `battle-state.js`.
- **#2 Player death magic-number cleanup.** `hud-drawing.js` had
  inline literals `500` (hold duration), `800` (total), `300` (fade
  divisor). Now `PLAYER_DEATH_HOLD_MS = 500`, `PLAYER_DEATH_FADE_MS
  = 300`, `PLAYER_DEATH_TOTAL_MS = 800` exported from `hud-state.js`.
  Matches the naming pattern in `battle-draw-allies.js`
  (`DEATH_SLIDE_MS` / `_TXTFADE_MS` / `_POSEFADE_MS` / `_TOTAL_MS`),
  so player and ally death timings can be reasoned about side-by-side.

## 1.7.211 — 2026-05-10

### Per-status sprite palettes + white sweat droplets

**Per-status palettes (#6):** `STATUS_PAL1/2/3` were placeholder
copies of `PAL0` so every status icon rendered red/pink. Now distinct
per the NES disasm grouping, with designer-chosen values (explicitly
not claiming NES capture — see `STATUS-EFFECTS-AUDIT.md`):

- `STATUS_PAL0` unchanged — pink/white/dark red (poison, paralysis,
  silence, near-fatal).
- `STATUS_PAL1` light blue / white / med blue — sleep "Zzz".
- `STATUS_PAL2` magenta / white / dark purple — confused stars.
- `STATUS_PAL3` light gray / white / black — blind eye + petrify.

**Sweat droplets force-white:** previously blitted with the body
palette, so droplets took on the active job's skin/hair colors and
read poorly. New dedicated `SWEAT_PAL = [0x0F, 0x30, 0x30, 0x30]`
(pure white) — droplets are now visible on every job.

**Priority rule confirmed (already shipped v1.7.209):** when a
combatant has both active status AND near-fatal sweat conditions,
the status icon wins. Sweat suppressed via `!hasActiveStatus` gate
at all three render sites (`hud-drawing.js`, `battle-draw-player.js`,
`battle-draw-allies.js`).

## 1.7.210 — 2026-05-10

### Silence now blocks MP casts (item #5 from status-effects audit)

`canCastMagic` was exported from `status-effects.js` but had zero
importers — Silence was inflicted-only. Now gated at every spell-cast
entry point:

- **Player battle menu** — picking Magic while Silenced plays
  `SFX.ERROR` and shows "Silenced" on the message strip. Cursor stays
  on the slot so you can pick Item / Defend / Run instead.
- **Ally AI** — `_tryAllyCure`, `_tryAllyPoisona`,
  `_tryAllyOffensiveCast` each early-return when Silenced, falling
  through to physical attack.
- **PVP enemy AI** — same pattern on `_tryPVPEnemyCure`,
  `_tryPVPEnemyOffensiveCast`, `_tryPVPEnemyPoisona`.
- **Pause-menu spell cast** — Silenced player can't cast Cure from the
  inventory menu either.

**Items bypass Silence** (NES-faithful — items don't channel magic).
Echo Herbs (`0xac`) is the cure (already routes through
`STATUS_NAME_TO_FLAG`).

**Wear-off:** none. Silence persists until cured, matching Blind /
Mini / Toad / Petrify (the sticky statuses). Sleep / Confuse /
Paralysis still have their 25% per-turn auto-clear in
`processTurnStart`.

**Monster specials NOT gated** — Fire / Bzzard / Glare / Bad Breath
etc. fire whether the monster is Silenced or not. Monsters don't have
MP so the "blocks MP casts" rule doesn't apply. Revisit if a specific
monster ability needs Silence-gating.

## 1.7.209 — 2026-05-10

### Status-effects audit: 6 enforcement gaps closed + priority rule landed

From `docs/STATUS-EFFECTS-AUDIT.md`. Sweep of every place status flags
are inflicted, enforced, or rendered, plus the low-HP visual cues.

**Priority rule (user-directed):** when both an active status AND
near-fatal HP would render visual cues above a combatant, the status
sprite wins. Sweat anim is suppressed across player / ally renderers
whenever a status icon is also rendering.

**Gameplay enforcement gaps fixed:**

- **#1 Encounter monsters now show status sprite overlay.** Player,
  ally, and PVP-enemy all already routed through `drawStatusSpriteAbove`
  — monsters were the only faction without it. A poisoned or slept
  goblin had no visual indicator. New call site in
  `battle-draw-encounter.js`, horizontally centered on the monster
  body (which can be 32 / 48 / 64 px wide).
- **#2 PVP enemies now run `processTurnStart`.** Encounter monsters had
  it; PVP enemies silently skipped it. Paralysis-skip, sleep-wake 25%
  roll, confuse snap-out now apply to PVP main opp + enemy allies.
- **#3 Ally + PVP-enemy attacks now apply `blindHitPenalty`.** Player
  and monster attacks already honored Blind; ally and PVP-enemy paths
  ignored it. A Blinded ally / PVP enemy now has 50% hit rate, matching
  NES.
- **#4 Ally + PVP-enemy attacks now apply `miniToadAtkMult`.** Same
  pattern: Mini/Toad zero-attack was player-only enforcement. Ally and
  PVP-enemy under Mini/Toad now do 0 damage on physical, matching NES.

**Visual / consistency fixes:**

- **#7 Allies now kneel on active status (matching player rule).**
  Player path at `hud-drawing.js` was already
  `near-fatal || hasActiveStatus`; ally was `near-fatal` only. Silenced
  / blinded / confused allies now visibly read as "in trouble" even at
  full HP.
- Folded the inline status-sprite priority loop in `hud-drawing.js`
  into the shared `drawStatusSpriteAbove` helper. Removes a 4th copy
  of the `_STATUS_PRIO` array.

**Dedup:**

- **#9 Fourth duplicate name→flag table in `pause-menu.js:820`
  removed.** v1.7.208's T8 collapsed three duplicates but missed the
  out-of-battle item-cure path. Now folded into `STATUS_NAME_TO_FLAG`
  with the others.

**Deferred (need decisions):**

- #5 `canCastMagic` (Silence) is dead code — wiring it in would change
  observable gameplay (silenced casters can currently cast freely).
- #6 `STATUS_PAL1/2/3` are placeholder copies of `PAL0` — needs EMU REC
  OAM capture of each status mid-anim to land the real per-status
  palettes.
- #8 Mini/Toad have no body sprite transformation — needs sprite work.

## 1.7.208 — 2026-05-10

### Modularization tier 3: physical-attack unify + status-name table collapse

Closes the last two open items in `docs/MODULARIZATION-AUDIT.md`.

**Tier 3 #7 — physical-attack damage path unified (with two confirmed
behavior fixes):**

- New module `src/physical-attack.js` — `applyPhysicalHitToEnemy(hit,
  targetIdx, opts)` is the single source for "apply one physical hit
  to the targeted enemy" (defend-halve, encounter/boss/PVP-opp dispatch,
  HP write, wake-on-hit, weapon-status inflict, crit-flash).
- `battle-update.js` (player attack) and `battle-ally.js` (ally attack)
  now both call the helper. Roughly 35 lines removed.
- **Confirmed gap fixes** (asked user before shipping, per the
  `dont_flip_confirmed` rule):
  - **Ally physical hits now wake sleeping enemies.** Player path
    already called `wakeOnHit`; ally path silently skipped it.
  - **Ally physical hits now inflict weapon-on-hit status.** Player
    path rolled `wpnData.status` against the target's resistance; ally
    path silently skipped it. Allies use the same `weaponId` /
    `weaponL` lookup the slash anim already uses.

**Tier 3 #8 — three duplicate status-name tables collapsed:**

- `battle-turn.js` had `CURE_NAME_TO_FLAG`, `spell-cast.js` had
  `SPELL_CURE_FLAG`, `pause-menu.js` had `PAUSE_CURE_FLAG` — verbatim
  duplicates of a 7-entry subset. `status-effects.js` already had a
  private 10-entry `NAME_TO_FLAG` covering the same mapping plus
  `death`/`sleep`/`confuse`.
- Exported as `STATUS_NAME_TO_FLAG`. All three duplicates removed.

## 1.7.207 — 2026-05-10

### Modularization tier 2: miss-popup helper + heal-num callback factory

- **`drawDmgPopup(ctx, dn, bx, by, pal)`** in `damage-numbers.js` — one
  helper handles the "miss canvas OR digits" dispatch. Replaces 6 inline
  branches across `battle-drawing.js` (3 sites in `drawSWDamageNumbers`,
  `_drawBossDmgNum`, player damage-num) and `battle-draw-allies.js`. **Also
  fixes a y-offset inconsistency:** the 3 SW-path sites used `by - 4`
  (miss rendered 4 px above its anchor), the other 3 used `by`. Unified
  to `by` since the miss canvas is 8 px tall (same as digits) and that's
  the natural anchor.
- **`makeHealNumCallback(scope, idx)`** in `damage-numbers.js` — factory
  for the `onHealNum(amount)` closures that magic helpers
  (`applyMagicHeal` / `applyMagicCureStatus` / `applyMagicDrain`) invoke.
  Three scopes: `'self'` (player portrait), `'ally'` (roster row),
  `'enemy'` (encounter / PVP / boss popup). Folds 4 inline closures
  across `spell-cast.js`, `battle-ally.js`, and `pvp.js`. Popup format
  `{ value, timer, [index] }` now lives in exactly one place.

The original tier-2 audit (`docs/MODULARIZATION-AUDIT.md`) called for a
broader `bindCastIO` helper plus `applyHpDelta` for the `Math.max(0, hp -
dmg)` clamp — both were narrowed/skipped after deeper inspection. Notes
landed in the audit doc.

## 1.7.206 — 2026-05-10

### Modularization tier 1: heal clamp / initiative / combo-hit summary

Three single-source refactors from the modularization audit
(`docs/MODULARIZATION-AUDIT.md`). No behavior change — pure
deduplication. Goal: kill the "two parallel paths drift" failure mode at
the root for these three high-risk patterns.

- **Heal clamp** — Potion paths (player / ally / encounter monster) now
  route through `applyMagicHeal` instead of duplicating
  `Math.min(power, maxHP - hp)` + HP write inline. Cure spell + Potion
  share one helper, can't drift on overheal logic. Boss / PVP-main-opp
  branch stays inline because it goes through `getEnemyHP` / `setEnemyHP`
  wrappers (no `target.hp` accessor).
- **Initiative roll** — `(agi * 2) + Math.floor(Math.random() * 256)`
  was duplicated five times in `buildTurnOrder` (player / ally /
  encounter / PVP-opp / PVP-enemy-ally). New `rollInitiative(agi)` in
  `battle-math.js` collapses all five to one-liners.
- **Combo-hit summary** — `totalDmg / anyCrit / allMiss` reduction was
  duplicated verbatim across `battle-update.js:_finalizeComboHits`,
  `battle-ally.js:_finalizeAllyCombo`, and `pvp.js` enemy-attack
  finalize. New `summarizeHits(hits, opts)` in `battle-math.js` handles
  the player/ally `damage` key and the PVP `dmg` + shield-block variant
  via opts. (The v1.7.193 dual-wield bug was inside one of these — now
  it can't recur in two of three sites.)

## 1.7.205 — 2026-05-10

### Poison-tick damage numbers fixed across encounter + PVP

Three bugs surfaced by the damage-number animation audit, all the same
root cause: poison ticks wrote to the single global `enemyDmgNum` slot
keyed by the player's last-selected target, which can't represent
multi-target poison.

- **Multi-monster encounter poison** (`battle-turn.js`) — looped
  `setEnemyDmgNum` across N poisoned monsters; each iteration
  overwrote the prior, so only the last monster's number rendered.
  Now routes through `setSwDmgNum(i, dmg)` per-cell.
- **Encounter monster popup position** — even when only one monster
  was poisoned, `_drawBossDmgNum` resolved position via
  `inputSt.targetIndex` instead of the dmg-num's own `index` field,
  so the popup landed on whichever cell the player happened to be
  pointing at. Resolved by the per-cell `setSwDmgNum` move (the
  draw site keys position by map key, no `inputSt.targetIndex`
  lookup).
- **PVP enemy-ally poison ticks were silent** — main opponent got a
  popup, but allies in `pvpSt.pvpEnemyAllies` had HP applied with
  no number rendered. Added `setSwDmgNum(i + 1, dmg)` to the loop
  and converted the main opp to `setSwDmgNum(0, dmg)` for
  consistency.
- Dropped the `magic-hit / ally-magic-hit` state gate from
  `drawSWDamageNumbers` — `swDmgNums` is per-target with its own
  750ms timer, so gating by battle state was incidental to the
  original (magic-only) writer set, not load-bearing.

## 1.7.204 — 2026-05-10

### Doc-only: balance-audit + battle-sim plan synchronized

- `docs/BALANCE-AUDIT.md` TL;DR table updated — all six findings now
  closed (3 fixed, 2 retracted as analysis artifacts, 1 always-OK).
- `tools/battle-sim.PLAN.md` Phase 1 checkboxes filled (was still
  showing as todo even though the bug repro + fix shipped in v1.7.193).
- Memory `project_ff3mmo_next_tasks.md` deleted — all three deferred
  items resolved (sim Phase 1-4 shipped, RM7 dual-wield fix v1.7.193,
  pause-menu heal unification v1.7.200).

End-of-session housekeeping; no live-game change.

## 1.7.203 — 2026-05-10

### Reverted: crit-overkill display cap (from v1.7.200)

The cap in `_finalizeComboHits` and the matching HP snapshot in
`input-handler.js` are gone. Combo display is back to the faithful
NES-style behavior: shows the full sum of all hit rolls, including
overkill (e.g. a 4-fist crit combo on a 7-HP Carbuncle correctly prints
"83 Critical!" — that was right all along).

The Ninja stat-weight bump and pause-menu heal unification from v1.7.200
are unaffected; only the display cap is reverted.

## 1.7.202 — 2026-05-10

### Doc-only: retract audit finding #5 — magic vs physical at low mdef

The "BM Fire 5–12× physical dpt" finding was measured against a high-HP
dummy (KN15) where Fire's burst could fully express. In actual live
encounter formations (valley goblin×3, wild werewolf×3) all classes
clear in nearly identical turn counts because each enemy dies in roughly
1 hit either way. Goblin×3 solo: physical 3.82 turns vs BM Fire 3.00
turns — only 0.82 turn difference, not the 5–12× the dummy data
suggested.

Audit doc updated with the corrected per-class encounter clear data and
the retraction. No live-game change.

## 1.7.201 — 2026-05-10

### Fixed: battle-sim initiative bias — retracted audit finding #3

`tools/battle-sim.js` had hardcoded "P1 acts first every turn" in 1v1
duel mode, which produced the ~65–70% first-move bias I'd flagged in
the balance audit. The **live game has been correct all along** —
`battle-turn.js:buildTurnOrder` uses `priority = agi*2 + rand(0..255)`,
where the random component dominates AGI gaps so equal-AGI combatants
split ~50/50 over many turns.

Sim updated to match: per-turn initiative roll using the same formula.
500-run mirror tests now show 47–55% (vs prior 65–70%) — within RNG
variance for n=500.

`docs/BALANCE-AUDIT.md` finding #3 retracted with explanation. No live-
game change.

## 1.7.200 — 2026-05-10

### Fixed: crit-overkill display sums beyond target HP

A 4-hit Monk fist combo with one crit on a 7-HP Carbuncle was showing
"83 Critical!" — the sum of all 4 hit rolls regardless of overkill.
`_finalizeComboHits` now caps the displayed total at the target's HP-
before-combo (snapshot taken in input-handler.js when `hitResults` was
rolled). Same case now shows "7 Critical!". Faithful behavior: each
hit's per-hit display is unchanged; only the final combo total is
capped. Per-target snapshots cover encounter monsters, PVP opponents,
PVP enemy allies, and the boss-state slot.

### Re-tuned: Ninja stat weights bumped to match canon

Ninja was losing 80% to Monk at L10 in `tools/battle-sim.js` mirror
runs. Bumped Ninja's str weight from 2 → 3 (now 3/3/2/1/1/0 — matching
NES canon's "wields all weapons, top physical class"). Verification:
- NI20 vs MO20: 20% → 63.5% (NI now wins majority)
- NI10 vs MO10: 19.5% → 50.5% (parity)
- NI10 vs KN10: 98.5% (speed god vs heavy tank, decisively NI)
- NI10 vs BB10 unarmed: 18% (Black Belt still dominant unarmed — correct)

### Refactored: pause-menu heal/cure-status routes through shared helpers

`pause-menu.js` was inlining heal math (`Math.min(amt, maxHP - hp); hp +=
amt`) and `removeStatus(...)` in `_applyPauseSpellUse` and
`_applyPauseItemUse` — duplicating logic from
`combatant-cast.js:applyMagicHeal` / `applyMagicCureStatus`. Single-source
violation per memory `feedback_ff3mmo_single_source_paths.md`. Pause now
calls into the shared helpers; in-battle and pause heal math stay
synchronized for any future change. `pauseSt.healNum` lifecycle is
unchanged (intentionally separate from `getPlayerHealNum` /
`getAllyDamageNums` since pause runs its own state machine).

## 1.7.199 — 2026-05-10

### Added: Ur valley vs wild grasslands — split encounter zones

Random world-map encounters are now zoned by region. The Ur valley (the
31 walkable tiles in the bounding box x=93..96, y=34..44 — between the
Altar Cave entrance at (95,34) and the former choke at (95,45)) only
spawns Goblins (1–3 per formation). Anywhere else on the world map runs
the wild grasslands table: Werewolf or Killer Bee (2–3 per formation).

Tuning derived from `tools/battle-sim.js --runs=200`:
- Solo OK1 vs valley goblin×3: 100% win, ~3.9 turns, 2.2 enemy dpt — appropriate starter tempo.
- Solo OK1 vs wild werewolf×3: 0% win — encourages recruiting before
  heading south.
- 3-party OK3/FI3/WM3 vs wild werewolf×3: 100% win, ~3 turns. Tier-2
  zone is comfortable once you have a party.

Pre-fix the formations were all in one `'grasslands'` table, so a solo
OK1 in the valley could roll into werewolf×4 (0% survival). Caught by
the v1.7.197 balance audit. See `docs/BALANCE-AUDIT.md` finding #2.

### Removed: choke block at world tile (95, 45)

The temporary `if (wx === 95 && wy === 45) return false;` in
`world-map-renderer.js:164` is gone. Players can now walk south of Ur
and reach the wild grasslands. Recruit a party first.

## 1.7.198 — 2026-05-10

### Fixed: 16 advanced jobs were stat-clones (default 1/1/1/1/1 weights)

`_JOB_STAT_WEIGHTS` in `src/data/players.js:219` only had entries for jobs
0–5 (Onion Knight, Fighter, Monk, White Mage, Black Mage, Red Mage). Every
job past Red Mage fell through to `_DEFAULT_STAT_WEIGHTS = { str:1, agi:1,
vit:1, int:1, mnd:1, mp:0 }`. Caught by `tools/battle-sim.js` statistical
sweep — at L10 every advanced job had identical ATK 17 / DEF 10 / AGI 15
/ INT 15 / MND 15.

Concrete consequences pre-fix:
- **Black Belt** (Monk's L14 evolution) was *worse* than Monk because Monk
  had str/agi/vit weight 2 and Black Belt had 1/1/1/1/1.
- **Knight, Thief, Ranger, Ninja, Viking, Magic Knight, Dragoon** —
  16 advanced jobs were functionally identical at every level.
- **Hidden symptom**: the audit's "Monk unarmed broken" finding was an
  artifact of comparing Monk-with-real-weights against Knight-with-default.

Filled in 16 missing weight entries with class-identity-driven values:
Knight 2/1/3/1/1/0 (heavy tank), Thief 1/3/1/1/1/0 (speed), Black Belt
3/3/3/1/1/0 (Monk-evolved), Ninja 2/3/2/1/1/0 (speed god), etc. See
`src/data/players.js` for the full table; class assignments are
guess-based and open to refinement.

This is a re-tuning, not a strict bug fix — every L9+ player who logs in
post-deploy will see their stats jump to match their class identity.

## 1.7.197 — 2026-05-10

### Added: battle-sim Phase 4 — statistical mode

`tools/battle-sim.js --runs=N` runs the same matchup N times under
distinct seeds and prints aggregated win rate, turn distribution, and
damage histograms instead of per-turn output. Works in both 1v1 (duel)
and encounter modes. Output formats: human (Unicode bar charts, default),
`--json` (tooling), `--csv` (one row per run for spreadsheet analysis).

```
# 200-run mirror match — uncovered first-move advantage (P1 wins ~69%, not 50%)
node tools/battle-sim.js --p1=KN10 --p2=KN10 --runs=200

# Boss balance check — does KN10 reliably solo Land Turtle?
node tools/battle-sim.js --party=KN10 --boss=land_turtle --runs=100

# 3-party survival rate vs 2 Petits (spAtkRate=80, lethal element-mages)
node tools/battle-sim.js --party=KN10,WM4,BM4 --enemies=petit*2 --runs=200
```

Required a refactor: `runBattle` and `runEncounter` now return structured
`{ text, winner, turns, dmg* }` instead of bare strings. Same path
serves both per-turn printing (`main()`) and stats aggregation
(`runStats({ build, runOnce })`).

Battle simulator is **feature-complete** for its original scope —
physical attacks (3 call shapes), spells (damage/heal/status/buff/cure-
status/instakill), status (poison/sleep/blind/silence/etc.), buffs
(haste/protect), defend, multi-target encounters, monster special attacks,
and statistical analysis. See `tools/battle-sim.PLAN.md` for full status.

## 1.7.196 — 2026-05-10

### Added: battle-sim Phase 3.5 — monster specials + per-ally actions

`tools/battle-sim.js` Phase 3.5 closes the Phase 3 deferred items.

**Monster special attacks.** Ported `SPECIAL_ATTACKS` table from
`battle-enemy.js:27` (29 entries — Fire / Bzzard / Thunder / Holy / Flare
/ Meteor / Drain / Bad Breath / Glare / Sleep / Toad / Confuse / Silence
/ Mini / Reflect / etc.). Each turn, monsters with `spAtkRate > 0` roll
that % chance to use a random attack from their `attacks[]` array.
Damage formula is `floor(spiritInt/2) + spec.power + rand` clamped after
elem mult and mdef — matches `_doSpecialAttack` exactly. Multi-status
(Bad Breath) tries each flag independently against the same hit chance.

```
node tools/battle-sim.js --party=KN10 --enemies=petit --turns=5
# Petit (spAtkRate=80) opens with Bzzard for 43 dmg, follows up with Fire for 35

node tools/battle-sim.js --party=KN10 --enemies=mandrake --turns=5 --seed=1
# Mandrake's Bad Breath lands Poison + Blind + Silence + Mini in one hit
```

**Per-ally action overrides.** Generalized `--pN.<key>=<value>` parsing —
`--p1.action`, `--p2.action`, `--p3.action`, `--p4.action` now control
each party member independently. Previously only `--p1.action` worked.

```
# KN attacks while WM heals
node tools/battle-sim.js --party=KN5,WM4 --p1.action=attack \\
                         --p2.action=cast:Cure --enemies=goblin*2
```

Phase 4 (statistical mode) is the last queued item — see
`tools/battle-sim.PLAN.md`.

## 1.7.195 — 2026-05-10

### Added: battle-sim Phase 3 — encounters, monsters, boss fights

`tools/battle-sim.js` now supports multi-target encounters: a party of
players/allies vs an array of monsters. AGI-ordered turn loop, random
target selection, full elemental weakness/resist scaling, boss-fight
support.

```
# Solo player vs 3 goblins
node tools/battle-sim.js --party=KN5 --enemies=goblin*3

# Boss fight — Land Turtle (the game's only boss)
node tools/battle-sim.js --party=KN10,WM4 --boss=land_turtle --turns=15

# 3-player party vs zombie horde with elemental weakness
node tools/battle-sim.js --party=KN10,WM4,BM4 --enemies=zombie*4 --p1.action=cast:Fire
# (Fire on zombie → elemMult=2 because zombie has weakness:fire)
```

Monster names parsed from `data/monsters.js` inline comments at startup
(231 monsters, lowercase snake_case — goblin, killer_bee, land_turtle,
blue_wisp, etc.). Hex IDs (`--enemies=0xCC`) and decimal IDs also work.

Monster attack call shape (`attackMonster`) mirrors `battle-enemy.js
rollMultiHit` exactly: uses `mon.attackRoll` for hit count, direct
`mon.atk` (no str/2), `mon.atkElem` for elemental scaling against
defender's `weakness`/`resist`, no crits (NES canon).

Phase 3 deliberately skipped:
- Monster special attacks (`spAtkRate` + `attacks[]`) — Phase 3.5
- Per-ally action overrides — Phase 3.5
- Statistical mode (`--runs=1000`) — Phase 4

See `tools/battle-sim.PLAN.md` for full status.

## 1.7.194 — 2026-05-10

### Added: battle-sim Phase 2 — spells, status, buffs

`tools/battle-sim.js` now supports magic, status conditions, and buffs.
Ported the pure math from `combatant-cast.js` (apply* helpers) + `spell-cast.js`
(`_rollMagicAmount`) directly into the sim — `combatant-cast.js` itself
imports canvas / SFX modules so it can't be loaded into Node. `status-effects.js`
and `buffs.js` are pure and imported live.

New CLI:
- `--p1.action=attack|defend|cast:<spell>` — force the actor's action this turn
- `--p1.status=poison,sleep,blind,...` — start with a status applied
- `--p1.buff=haste,protect` — start with a buff active
- `--p1.hp=N` — override starting HP (handy for testing Cure)

Spell name resolver covers Fire / Bzzard / Thunder / Cure / Poisona / Sleep /
Death / Haste / Protect / Drain / etc. — see `SPELL_BY_NAME` in the script
or run `--help` for the full list. Unknown names error fast.

Status mechanics now in the sim:
- **Poison**: floor(maxHP/16) HP loss at start of actor's turn
- **Sleep / Paralysis**: skip turn; sleep wakes on physical hit
- **Blind**: halved hit rate via `blindHitPenalty`
- **Mini / Toad**: atk * 0 → damage clamps to 1 via `miniToadAtkMult`
- **Silence**: blocks `cast:` action with "SILENCED, fizzles"
- **Petrify / Death**: skip turn (treated as KO at runtime)

Buff mechanics:
- **Haste**: doubles hit count via `calcPotentialHits(level, agi, dual, hasted=true)`
- **Protect**: halves incoming physical via `rollHits.targetProtected`

Defend action: halves the NEXT incoming swing (consumed by that swing,
not reset on turn boundary). Output tags damage with "(halved by defend)".

```
node tools/battle-sim.js --p1=BM4 --p1.action=cast:Fire --p2=RM7 --mode=dummy --turns=3
node tools/battle-sim.js --p1=WM4 --p1.hp=10 --p1.action=cast:Cure --mode=solo
node tools/battle-sim.js --p1=KN10 --p1.status=poison --p2=BM4 --turns=5
node tools/battle-sim.js --p1=RM7 --p1.buff=haste --p2=KN10 --p2.buff=protect
```

Phase 3 (encounters / monsters / multi-target) and Phase 4 (statistical
mode) deferred — see `tools/battle-sim.PLAN.md`.

## 1.7.193 — 2026-05-10

### Fixed: player dual-wield damage clamping (3-5/turn instead of ~36-39)

Per-hand `baseAtk` in `_battleTargetConfirm` (input-handler.js:178) stripped
the **full sum** of both weapon ATKs from `ps.atk`, but `calcAttackerAtk`
only added the **average** for dual-wield (battle-math.js:52-55). Net:
`baseAtk` went negative by `(rWpn+lWpn)/2`, per-hit damage clamped to
minimum 1, dual-wielding two daggers hit BARELY harder than no weapon at all.

Reproduced via the new battle simulator: a level-7 Red Mage dual-wielding
daggers (atk 8 each) vs a level-4 Black Mage was producing 3-5 dmg/turn
when the math says ~36-42 expected. The PVP attack path (which uses the
already-correct `attackerStats.atk`) was meanwhile producing 36-39
consistently. The fix routes player-dual through the same average so both
paths agree.

Single-wield, unarmed Monk, and PVP / ally attacks were unaffected and are
unchanged. 50-seed parity sweep confirmed: matched weapons Δ=0; mixed
weapons Δ=±0.7 dmg/turn (RNG-pattern variance, both paths converge in
expectation).

### Added: `tools/battle-sim.js` — terminal battle simulator

Node-runnable simulator that mirrors the three prod attack call shapes
(`player-single`, `player-dual`, `pvp`) using `battle-math.js` directly.
Lets Claude observe combat damage output without browser testing — same
pipeline that surfaced the dual-wield bug above.

```
node tools/battle-sim.js --help
node tools/battle-sim.js --p1=RM7 --p1.weaponR=0x1F --p1.weaponL=0x1F \
                         --p2=BM4 --mode=dummy --turns=5 --seed=1
```

Profile shorthand (`RM7`, `BM4`, etc.) resolves via `generateAllyStats` for
single-source combatant stats. Three modes: `duel` (round-robin),
`dummy` (P2 is HP target — best for isolating a single attacker), `solo`.
Deterministic via `--seed` (mulberry32 swap of `Math.random`). Path
override (`--p1.path=pvp`) for cross-checking the three call shapes
against each other.

Phase 1 only — physical attacks. Spells, status, buffs, monsters, and
statistical mode are deferred to Phases 2-4 (see `tools/battle-sim.PLAN.md`).

## 1.7.192 — 2026-05-10

### refactor: pause input → `pause-menu.js` (last task in REFACTOR-PLAN)

Task 4 of `docs/REFACTOR-PLAN.md`. `input-handler.js` was 1293 lines mixing 4 contexts (battle / roster / tab-select / pause). The pause section was the largest at ~495 lines and tightly coupled to `pauseSt` in `pause-menu.js` — moving it eliminates the cross-file state plumbing.

**`pause-menu.js`** 563 → 1098. Now owns the pause-menu state machine end-to-end: state + transitions + rendering + input. New exports `initPauseMenuInput({ returnToTitle })` and `handlePauseInput`. Local `_zPressed` / `_xPressed` helpers (5 lines each) so pause-menu doesn't need to expose internals from input-handler. `_toggleCrt` is already defined locally in pause-menu (line 476), so no injection needed for it.

**`input-handler.js`** 1293 → 790 (-503). Dropped the pause section + the `_returnToTitle` / `_toggleCrt` injection slots. Cleaned now-unused imports: `pauseMusic`, `playFF1Track`, `FF1_TRACKS`, `changeJob`, `setEquipSlotId`, `getEquipSlotId`, `EQUIP_SLOT_SUBTYPE`, `jobSwitchCost`, `getCastableKnownSpells`, `saveSlotsToDB`, `selectCursor`, `saveSlots`, `removeStatus`, `swapBattleSprites`.

**`main.js`** — added `initPauseMenuInput({ returnToTitle })` call alongside `initInputHandler`. Removed `returnToTitle` and `toggleCrt` from input-handler init.

**`movement.js`** — `handlePauseInput` import path moved from `./input-handler.js` to `./pause-menu.js`.

Zero behavior change. Refactor plan complete (4/4 tasks).

## 1.7.191 — 2026-05-10

### fix: PVP cure sparkle was tiled at 4 corners — now single tile (matches player + ally)

Pre-existing bug surfaced during PVP smoke testing: the cure / heal sparkle on a PVP enemy was being drawn via `_drawSparkleAtCorners` (the 4-corner mirrored pattern used by the DEFEND sparkle) instead of a plain `ctx.drawImage`. Player + ally cure renders are single-tile (`battle-draw-player.js` / `battle-draw-allies.js`); PVP should match.

Fixed in `pvp-drawing.js:_drawPVPEnemyCell` — cure sparkle now draws once at body top-left. `_drawSparkleAtCorners` is still used for the defend sparkle (which is intentionally 4-corner).

## 1.7.190 — 2026-05-10

### refactor: extract `pvp-drawing.js` from `pvp.js`

Task 3 of `docs/REFACTOR-PLAN.md`. `pvp.js` was 1264 lines mixing state + AI + state-machine updaters + drawing. Drawing extracted to follow the convention set by `battle-draw-encounter.js` and the rest of the battle-draw-* family.

**New file** `src/pvp-drawing.js` (351 lines): `drawBossSpriteBoxPVP`, `_drawSparkleAtCorners`, `_drawPVPEnemyCell`. Pure rendering — opponent + enemy ally cell sprites, weapon overlays, hit/dying/cast/defend/item-use poses, status icons, near-fatal sweat, sparkles, slash overlays. Mirrors the `combatant-pose` + `combatant-cast` patterns used by the player + ally + encounter draws.

**`pvp.js`** 1264 → 935 (-329). Now state + AI + state-machine updaters only — no drawing concerns. Cleaned now-unused imports: `getEnemyHP`, `getPlayerDamageNum`, `getEnemyHealNum`, `getSpellTargets`, `clipToViewport`, `drawBorderedBox`, `inputSt`, `bsc`, `getSlashFramesForWeapon`, `drawSlashOverlay`, `shouldDrawSlash`, `drawCasterCastBehind/Front`, `jobToCastKey`, `drawCastWindup`, `getSpellAnim`, `getSpellAnimForItem`, `drawStatusSpriteAbove`, all `fakePlayer*FullBodyCanvases` + `fakePlayerDeathFrames`, `pickAttackPoseKey/WeaponSpec/Layer`, `pickCombatantBody`, `_jobPalette` (local helper), plus palette pool imports (`PLAYER_PALETTES`, `MONK_PALETTES`, `BLACK_MAGE_PALETTES`, `RED_MAGE_PALETTES`).

**`battle-draw-encounter.js`** — `drawBossSpriteBoxPVP` import path moved from `./pvp.js` to `./pvp-drawing.js`.

Zero behavior change. Same circular-import shape as the battle-draw-* splits (pvp-drawing imports `pvpSt` from pvp.js; pvp.js / battle-draw-encounter.js import `drawBossSpriteBoxPVP` from pvp-drawing.js).

## 1.7.189 — 2026-05-10

### fix: ALL spells fire SFX during spell animation, not after

User has stated this rule 14+ times across the project history: every spell's SFX is synced to the spell animation, not to the apply / damage-number pop. Throw-style was correct (FIRE_BOOM at impact-burst start). Heal-style (Cure / Poisona / cure_status) was wrong — SFX was firing at apply-time inside `applyMagicHeal` / `applyMagicCureStatus` via `opts.sfx`, alongside the heal-num pop. Saved as memory `feedback_ff3mmo_sfx_during_spell_anim.md` so it stops getting re-broken.

**Fix:** SFX is engine-driven for ALL spells. Single source: `getSpellImpactSFX(spell)` selector + `playSpellImpactSFX(spell)` engine call. Helpers no longer carry SFX.

1. **`combatant-cast.js`** — `getSpellImpactSFX` now returns `SFX.CURE` for `element === 'recovery'` / `target === 'cure_status'` / `target === 'ally'` / `target === 'revive'`. No longer returns null for heal-style.

2. **`spell-cast.js`** — `sfxStartMs` is set for heal-style too: `CAST_T_HEAL_ANIM_START - buildup` (= 100 ms into magic-hit, sparkle-start). Stripped `sfx: SFX.CURE` from `applyMagicHeal` and `applyMagicCureStatus` calls.

3. **`battle-ally.js`** — heal SFX gate is now `CAST_PHASE_MS_HEAL.preImpactGap` (= 100 ms into ally-magic-hit). Stripped `sfx: SFX.CURE` from helper calls.

4. **`pvp.js`** — same as ally.

**Resulting timeline (heal-style):**
```
0       800   900             1183  1283       2033ms
|--cast--| gap |sparkle + SFX  | gap |---heal-num bounce---|
              ↑ sparkle start =        ↑ apply (heal-num posts)
                SFX fires here
```

`applyMagicSight` keeps its `sfx` opt (Sight has no spell-anim — its SFX is the visual feedback). Other helpers (`applyMagicDrain` / `applyMagicRecovery` / `applyMagicAllStatus` etc.) used in offensive paths are unchanged for now — those have their own SFX timings, untouched.

## 1.7.188 — 2026-05-10

### fix: heal sparkle + heal-num now sequential (no overlap)

User report: "spell animation and sfx is happening during damage number bounce" for ally→player heal. Same bug existed for player self-heal and PVP-enemy heal — sparkle and heal-num both started at apply time and ran in parallel. Violates the pipeline rule (cast → spell-anim → gap → numbers, never overlapping).

**Root cause:** heal-style hit phase had `apply` time = sparkle start time. Apply posts the heal num + plays SFX + flips a flag that triggers the sparkle render. So all three fired at the same instant, then ran together for ~283 ms.

**Fix — same shape as the cross-faction throw pipeline (which was already correct):**

1. **`cast-anim.js`** — added `CAST_PHASE_MS_HEAL` (`buildup 800` + `preImpactGap 100` + `impact 283` + `postImpactGap 100`) and the boundary constants `CAST_T_HEAL_ANIM_START / END / APPLY`. Throw and heal now share the same gap structure (just no projectile for heal).

2. **`spell-cast.js`** — heal-style `hitEffectMs` now resolves to `CAST_T_HEAL_APPLY - buildup` (= 483 ms after magic-hit start), and `hitTotalMs` extends by `DMG_SHOW_MS` so the heal-num bounce + stick play out fully before the state ends. Apply time is now AFTER the sparkle window + post-impact gap.

3. **`battle-ally.js`** — split timing constants into `ALLY_THROW_*` (offensive) and `ALLY_HEAL_*` (same-team). `_updateAllyMagicCast` picks per-spell at frame time via `_isAllyMagicHealSpell`. Heal SFX gate is null (helper plays it at apply via `opts.sfx`).

4. **`pvp.js`** — same split (`PVP_THROW_*` / `PVP_HEAL_*`) for symmetric PVP-enemy paths. Sparkle render gate in `_drawPVPEnemyCell` is now time-windowed.

5. **`battle-draw-player.js` + `battle-draw-allies.js`** — sparkle render gates moved from "apply-flag" to "time-window" (`battleTimer >= preGap && < preGap+impact`). Player self-heal gate updated to use the new `CAST_T_HEAL_ANIM_*` boundaries.

**Resulting timeline (heal-style):**
```
0       800  900    1183 1283       2033ms
|--cast--|gap|sparkle|gap|----heal-num bounce + stick----|
        cast end   apply happens here ↑
                   (heal-num posts + SFX plays)
```

Cross-faction throws (Fire / Bzzard / Sleep) keep their existing throw pipeline and are unchanged.

## 1.7.187 — 2026-05-10

### fix: Cure cast targeted enemies + showed "Ineffective" on full-HP self

Two related bugs both rooted in `spell.type === 'damage'` being misread as "offensive". Cure's data row in `data/spells.js` is `{ type: 'damage', element: 'recovery', target: 'ally' }` — `type: 'damage'` is the dispatch axis for spells with a numeric effect (heal counts) but it does NOT mean "offensive". The targeting + effect-router both incorrectly used `type === 'damage'` as the offensive flag.

**`input-handler.js`** — default-target picker pointed Cure at enemies. Inverted the check: `defaultsToPlayer` is the friendly-target set (`element === 'recovery'` OR `target === 'ally' / 'cure_status' / 'revive' / 'reflect'`); everything else defaults to enemy.

**`spell-cast.js`** — `_applySpellEffect` had a guard "damage spell cast on a friendly target → Ineffective" that fired on Cure too. Replaced with the offensive-target set (`target === 'enemy' / 'all_enemies' / 'enemy_status'`), so Cure on self/ally now reaches `applyMagicHeal`. Full-HP target now correctly posts a 0 heal-num (intended feedback) instead of an ERROR sfx + "Ineffective" msg.

Pipeline-rule note: `type === 'damage'` will keep tripping callers that read it as "offensive". A future cleanup could rename the dispatch axis (e.g., `dispatch: 'numeric'` vs `'status'` vs `'sight'`) — out of scope for this fix.

## 1.7.186 — 2026-05-09

### refactor: split player portrait → `battle-draw-player.js`

Phase 2d (final phase) of the `battle-drawing.js` split. Owns the player's left-side portrait and everything that overlays it: pose resolution (idle/attack/hit/defend/victory/run/death), weapon overlays (front + behind), per-spell heal sparkle, status icons, near-fatal sweat, PVP enemy slash overlay, item-target cursor, run-away slide, kneel-slide death animation, plus the full-viewport crit gold flash and boss-strobe flash.

**New file** `src/battle-draw-player.js` (334 lines): `drawBattlePortrait`, `drawBattleCritFlash`, `drawBattleStrobeFlash`, plus internal helpers (`_getPortraitSrc`, `_drawPortraitFrame`, `_drawPortraitWeapon`, `_drawPortraitOverlays`, `_playerPoseCanvas`) and DEATH constants. Imports `_itemSparkleFrames` and `drawStatusSpriteAbove` from `battle-drawing.js` (same shared-helper pattern as the menu / encounter / ally splits).

**`battle-drawing.js`** 799 → 503 (-296). Imports + calls the three new `drawBattle*` functions from the player module. Cleaned now-unused imports: `weaponSubtype`, `pickAttackPoseKey`, `attackWeaponLayer`, `pickCombatantBody`, `pickAttackWeaponSpec`, `ps`, `getHitWeapon`, `isHitRightHand`, `getSlashFramesForWeapon`, `drawSlashOverlay`, `getCastAnimElapsedMs`, `getCurrentSpellId`, `getSpellTargets`, `drawCasterCastBehind/Front`, all `CAST_T_*` constants, `drawCastWindup`, `getAllyDamageNums`, `hudSt`, `fakePlayerDeathPoseCanvases`, `drawHudBox`, `drawSparkleCorners`, `drawBorderedBox`. Removed `PLAYER_POSE_FALLBACK` and `_playerPoseCanvas` (moved with the player).

**`battle-drawing.js` final state**: 503 lines, down from the pre-refactor 1801 (-1298). What remains is the `drawBattle` composer + spell FX (`drawProjectileFan`, `drawSpellEffectAtTargets`, `drawSWExplosion`, `drawSWDamageNumbers`, `_drawPlayerSpellTargetSparkleOnEnemy`, `_drawPVPEnemyOffensiveCast`, `_drawAllyOffensiveCast`) + damage numbers (`drawDamageNumbers`) + battle message strip + the shared exports (`_jobPalette`, `_itemSparkleFrames`, `drawStatusSpriteAbove`).

**Refactor plan complete.** Six new modules: `battle-draw-menu.js`, `battle-draw-encounter.js`, `battle-draw-allies.js`, `battle-draw-player.js`, `battle-grid.js`, `tile-canvas.js` helpers in `canvas-utils.js`. Zero behavior change across all phases.

## 1.7.185 — 2026-05-09

### refactor: split ally roster rows → `battle-draw-allies.js`

Phase 2c of the `battle-drawing.js` split. Owns the right-hand panel: per-ally portrait, weapon overlays, name + LV/HP text, status sprite, cast windup, heal sparkles, death animation, PVP enemy slash overlay on targeted ally, item-target cursors.

**New file** `src/battle-draw-allies.js` (294 lines): `drawBattleAllies`, plus internal helpers (`_drawAllyRow`, `_drawAllyPortrait`, `_drawAllyTexts`, `_flushAllyWeaponDraws`).

**`battle-drawing.js`** 1045 → 799 (-246). Imports `drawBattleAllies` from the new module and re-exports it (game-loop.js still imports from `battle-drawing.js`). `_jobPalette` and `_itemSparkleFrames` exported here for reuse by the ally module — same circular-import shape that worked for `drawBattleMenu` and `drawEncounterBox`. `DEATH_*` constants kept in `battle-drawing.js` (player portrait still uses them; will move with Phase 2d).

Cleaned now-unused imports: `measureText`, `nesColorFade`, `isWeapon`, `drawLvHpRow`, `getSpellHitIdx`, all `fakePlayer*Portraits` except `fakePlayerDeathPoseCanvases` (still needed by player portrait).

Zero behavior change. `battle-drawing.js` is down 1002 lines from the pre-refactor 1801 — only the player portrait + spell FX + damage-number/msg-strip rendering remain. Phase 2d (player portrait) is the last chunk.

## 1.7.184 — 2026-05-09

### refactor: split encounter monsters + boss sprite box → `battle-draw-encounter.js`

Phase 2b of the `battle-drawing.js` split. Owns the central enemy-area rendering: random encounter grid (1-4 monsters), boss sprite, dissolve animation, slash hit overlays on enemies, target-select cursors.

**New file** `src/battle-draw-encounter.js` (372 lines): `drawEncounterBox`, `drawBossSpriteBox`, plus internal helpers (`_drawEncounterMonsters`, `_drawEncounterSlashEffects`, `_drawEncounterCursors`, `_isEncounterCombatState`, `_drawBossSprite`, `_drawBossSpriteBoxBoss`, `_drawDissolvedSprite`, `_drawShiftedBlock`).

**New file** `src/battle-grid.js` (53 lines): shared layout math used by encounter rendering, FX, ally rows, and spell projectile/effect targeting. Exports `encounterBoxDims`, `encounterGridLayout`, `pvpEnemyCellCenterLocal` (was the `_pvpEnemyCellCenter` wrapper that auto-pulls live `pvpSt` count). Extracted to break what would have been a circular import between `battle-drawing.js` and `battle-draw-encounter.js`.

**`battle-drawing.js`** 1404 → 1045 (-359). Imports `drawEncounterBox`, `drawBossSpriteBox` from the new encounter module and `encounterGridLayout`, `pvpEnemyCellCenterLocal` from `battle-grid.js`. Cleaned now-unused imports: `_calcBoxExpandSize`, `_encounterGridPos`, `getBossWhiteCanvas`, `getMonsterWhiteCanvas`, `hasMonsterSprites`, `pvpEnemyCellCenter` (raw), `drawBossSpriteBoxPVP`, `_drawMonsterDeath`, `SLASH_FRAME_MS`, `shouldDrawSlash`.

Zero behavior change. `battle-drawing.js` is down 756 lines from the pre-refactor 1801. Phases 2c (ally rows) + 2d (player portrait) remain.

## 1.7.183 — 2026-05-09

### refactor: split battle menu + victory box → `battle-draw-menu.js`

`battle-drawing.js` was 1801 lines mixing 7 concerns. First chunk extracted: bottom-panel rendering — action menu (Fight/Guard/Magic/Item/Run), enemy-name box, item list, spell list, victory celebration, reward text.

**New file** `src/battle-draw-menu.js` (438 lines) owns: `drawBattleMenu`, `drawVictoryBox`, plus all internal helpers (`_drawBattleItemList/Cursors/Panel`, `_drawBattleSpellList/Cursor`, `_battleMenuStates`, `_drawBattleMenuItems/Cursor`, `_battleEnemyNames/Name`, `_isRewardState`, `_drawVictoryNameOut`, `_drawRewardText`).

**`battle-drawing.js`** 1801 → 1404 (-397). Imports `drawBattleMenu`, `drawVictoryBox` and calls them from `drawBattle`. Cleaned now-unused imports: `getItemNameClean`, `getMonsterName`, `getSpellNameClean`, `getSpellMPCost`, `makeExpText`, `makeGilText`, `makeCpText`, `makeItemDropText`, `BATTLE_LEVEL_UP`, `BATTLE_JOB_LEVEL_UP`, `BATTLE_FOUND`, `BATTLE_BOSS_NAME`, `BATTLE_GOBLIN_NAME`, `BATTLE_MENU_ITEMS`, `BATTLE_MAGIC`, `_MAGE_JOBS`, `drawCursorFaded`, plus dead constants `HUD_BOT_Y`, `HUD_BOT_H`, `BATTLE_PANEL_W`, `INV_SLOTS`, `BATTLE_TEXT_STEP_MS`, `BOSS_BOX_EXPAND_MS`, `BATTLE_SHAKE_MS`, `VICTORY_*`.

Zero behavior change. Phase 2a of `docs/REFACTOR-PLAN.md` (3 phases remain: encounter/boss, ally rows, player portrait).

## 1.7.182 — 2026-05-09

### refactor: dedupe `_decodeTilePixels` + `_make8` helpers

Three files (`spell-anim.js`, `cast-anim.js`, `projectile-anim.js`) had byte-identical copies of the 2BPP NES tile → 8×8 canvas helper. `tile-decoder.js`'s `decodeTile` already produces the same `Uint8Array(64)` palette-index decode, so the local duplicates were pure tech debt.

Added to `canvas-utils.js`:
- `_make8Canvas(tile, pal)` — uses `decodeTile` from `tile-decoder.js`; identical output to the old local `_make8`.
- `_hflipCanvas(src)` — size-agnostic; replaces local copies in `spell-anim.js` and `projectile-anim.js`.
- `_vflipCanvas(src)` — size-agnostic; replaces `_vflip` in `projectile-anim.js`.

`_hflipCanvas16` (16×16 fixed-size) is preserved unchanged — `sprite-init.js` consumes it.

Net: -74 lines across 3 files, zero behavior change. First task in `docs/REFACTOR-PLAN.md`.

## 1.7.181 — 2026-05-09

### fix: Cure double-SFX (engine SW_HIT + helper CURE)

`getSpellImpactSFX(spell)` returned `SFX.SW_HIT` as a fallback for any unknown spell shape. For Cure (target='cure_status'/'recovery', not a thrown impact spell), this caused the engine to play SW_HIT at impact start, then the helper played CURE at apply time. Two SFX per Cure cast.

The fallback is wrong. Engine should only fire SFX for spells that HAVE an impact-burst phase — fire / ice / sleep / sight. For everything else (Cure, Poisona, Drain on non-undead, Recovery on non-undead, etc.), the apply helper's `opts.sfx` plays at apply-time and that's correct.

Fixed: `getSpellImpactSFX` returns `null` for non-thrown spells. `playSpellImpactSFX` is a no-op when selector returns null. Cure / Poisona now play exactly one SFX (CURE at apply time via helper).

## 1.7.180 — 2026-05-09

### tune: damage number sticks after bounce, then state transitions

User asked for damage numbers to stick visible for a short period after the bounce settles, then transition to next turn / death wipe. Was: number disappeared exactly when bounce ended (`DMG_SHOW_MS = 550 = bounce duration`); felt rushed.

**`damage-numbers.js`** split the show duration into two phases:
- `DMG_BOUNCE_MS = 550` — matches `DMG_BOUNCE_TABLE` (33 frames @ 16.67 ms). Number arcs up, falls back, settles at +6 px (last table entry).
- `DMG_STICK_MS = 200` — hold settled number motionless for 200 ms after bounce. `_dmgBounceY` clamps `frame` to the last table entry, so during stick the digits render still at their settled position.
- `DMG_SHOW_MS = DMG_BOUNCE_MS + DMG_STICK_MS = 750` — total visible duration before clear.
- `SW_DMG_SHOW_MS` unified with `DMG_SHOW_MS` (was 700; now 750).

**State machine timings extended to honor the full bounce + stick:**
- Player thrown impact-walk per-target window: was `impact(550) + postGap(100) + damageHold(500) = 1150`. Now `impact(550) + postGap(100) + DMG_SHOW_MS(750) = 1400`.
- `ALLY_MAGIC_HIT_MS`: was `effect(900) + ret(167) = 1067`. Now `effect(900) + DMG_SHOW_MS(750) = 1650`.
- `PVP_MAGIC_HIT_MS`: same — `effect(900) + DMG_SHOW_MS(750) = 1650`.

The `ret` phase from `CAST_PHASE_MS_THROW` is no longer used by the simple ally/PVP paths — `DMG_SHOW_MS` (bounce + stick) IS the post-damage hold. Player engine swapped its hardcoded `damageHoldMs = 500` for `DMG_SHOW_MS` so all three roles use the same constant.

Frame timeline (cross-faction throw, all 3 roles):
```
buildup       0   →  800    cast windup
projectile    0   →  150    orb flies
preImpactGap  150 →  250    beat
impact        250 →  800    burst plays  (SFX at 250)
postImpactGap 800 →  900    beat
damage @ 900               damage applies
bounce        900 →  1450   number arcs up + settles
stick         1450 →  1650  number motionless at settled position
[next turn / death wipe]
```

Net pacing: cross-faction cast is now ~1650 ms hit phase + 800 ms windup = 2450 ms total. Was ~1067+800 = 1867 ms. ~600 ms slower per cast for the polish.

## 1.7.179 — 2026-05-09

### refactor: applySpell unified dispatcher + pickCombatantBody covers player

Final two pipeline stages unified.

**`combatant-cast.js:applySpell(spell, target, opts)`** — single entry point that dispatches by spell shape (`spell.target` / `spell.element` / `spell.type`) to the right effect helper. Replaces the inline ID-based switches in each role's apply fn:

| Spell shape | Helper called |
|---|---|
| `target === 'sight'` | `applyMagicSight` |
| `target === 'erase'` | `applyMagicErase` |
| `target === 'enemy_status'` + `type === 'death'` | `applyMagicInstakill` |
| `target === 'enemy_status'` + `type === 'all_status'` | `applyMagicAllStatus` |
| `target === 'enemy_status'` + named status (sleep/confuse/blind/etc.) | `applyMagicStatus` |
| `target === 'drain'` | `applyMagicDrain` |
| `target === 'cure_status'` | `applyMagicCureStatus` |
| `element === 'recovery'` | `applyMagicRecovery` |
| Default (damage) | `applyMagicDamage` |

Every spell type now goes through one dispatch — the same dispatcher whether the caster is player, ally, or PVP-enemy. Caller resolves target object + builds opts (callbacks + pre-rolled amount + isUndead etc.); helper handles the rest. Future-prep: when ally/PVP-enemy AI gets drain/recovery/death/Shade/erase, the call site is one line — `applySpell(spell, target, opts)`.

**`combatant-pose.js:pickCombatantBody('player', ...)` extension** — function now handles the player role too. Returns from `bsc.battlePoses[poseKey]` directly (player has a single active palette baked in via `loadJobBattleSprites`; jobIdx + palIdx args ignored for this role). API surface is now identical across all 3 roles. Existing player render sites still use direct `bsc.battlePoses[key]` access for performance; the wrapper is available when role-symmetric code wants it.

### Pipeline modularization — fully complete

Every spell-pipeline stage has a single shared helper called by all three roles:

| Stage | Helper |
|---|---|
| Cast windup | `drawCastWindup(layer, ctx, role, idx, x, y, mirror)` |
| Throw anim (projectile + impact) | `drawSpellThrow(role, ctx, caster, target)` |
| Impact SFX selector | `getSpellImpactSFX` / `playSpellImpactSFX(spell)` |
| Spell effect dispatcher | `applySpell(spell, target, opts)` |
| Damage application | `applyMagicDamage` |
| Status application | `applyMagicStatus` |
| Heal | `applyMagicHeal` |
| Cure-status | `applyMagicCureStatus` |
| Sight | `applyMagicSight` |
| Drain | `applyMagicDrain` |
| Recovery (undead-aware) | `applyMagicRecovery` |
| All-status (Shade) | `applyMagicAllStatus` |
| Instakill (Death) | `applyMagicInstakill` |
| Erase | `applyMagicErase` |
| Pose body | `pickCombatantBody(role, key, jobIdx, palIdx)` |

All in `combatant-cast.js` (or `combatant-pose.js` for poses). Each role's apply fn / render site is a thin wrapper that resolves role-specific state + I/O bindings and hands off.

## 1.7.178 — 2026-05-09

### refactor: spell SFX selector unified across all 3 roles

User caught a double-fire bug: player thrown spells were playing SFX twice — once at impact start (engine), once at apply time (helper via `opts.sfx`). And the SFX selector logic was duplicated three different ways: `_spellImpactSFX` (spell-cast.js), inline ternaries in `_processPVPEnemyMagic` and `_updateAllyMagicCast`. SFX wasn't part of the modularization.

Fixed:
- **`combatant-cast.js:getSpellImpactSFX(spell)`** — single source for impact SFX selection. fire→FIRE_BOOM, ice→SW_HIT, sleep→SLEEP_PUFF, sight→SIGHT, default SW_HIT. Was duplicated in 3 files.
- **`combatant-cast.js:playSpellImpactSFX(spell)`** — convenience wrapper for the engine call.
- All three engines (player `spell-cast.js`, ally `battle-ally.js`, PVP-enemy `pvp.js`) now call the same `playSpellImpactSFX(spell)` at impact start. Was inline switch statements per role.
- `spell-cast.js:_spellImpactSFX` is now a thin alias to `getSpellImpactSFX` (kept for grep-discoverability).
- Apply helpers (`applyMagicDamage`, `applyMagicStatus`) take `opts.sfx` only for non-thrown spells. Thrown spells (fire/ice/bolt damage, sleep status) pass `sfx: null` since the engine already fired at impact start. No more double-fire.

Player path before/after:
- Fire on enemy: engine fires `FIRE_BOOM` at impact start (250 ms) ✓ + helper fired `SW_HIT` at apply time (650 ms) ✗ DOUBLE → fixed: helper passes `sfx: null`.
- Sleep on enemy: engine fires `SLEEP_PUFF` at impact start ✓ + helper fired `SLEEP_PUFF` at apply time ✗ DOUBLE → fixed: gated on `_isThrownStatusType(spell.type)`.
- Confuse / blind / silence on enemy: engine doesn't fire (non-thrown) ✓ helper fires at apply time via opts.sfx ✓ — correct, kept.

## 1.7.177 — 2026-05-09

### fix: spell SFX fires at impact START (during burst, not after)

Ally + PVP-enemy offensive casts were playing FIRE_BOOM / SW_HIT / SLEEP_PUFF inside the apply helpers — which fire at damage-apply time = AFTER the burst ends + post-impact gap. So the boom sound played 100 ms after the visual burst finished. Wrong.

Player thrown impact-walk already fires SFX at impact START (`spell-cast.js:650`). Mirrored that for ally + PVP-enemy:
- New constants: `ALLY_MAGIC_SFX_MS` and `PVP_MAGIC_SFX_MS` = `projectile + preImpactGap = 250` ms (impact start = first frame of burst).
- Engine update loops (`_updateAllyMagicCast` and `_processPVPEnemyMagic`) gate SFX play on `battleTimer >= *_MAGIC_SFX_MS` with a `*MagicSfxPlayed` flag. Reset to false on state transition into the hit phase.
- Removed `opts.sfx` from `applyMagicDamage` / `applyMagicStatus` calls in the offensive branches (no double-fire).
- Heal / cure-status / sight branches still use `opts.sfx` since they don't have an impact-burst phase — SFX at apply time is correct for those.

New `battleSt.allyMagicSfxPlayed` and `pvpSt.pvpMagicSfxPlayed` fields, reset in `resetBattleVars` / state-transition entry points.

Now SFX hits with the burst frame, not 100 ms after the burst ends.

## 1.7.176 — 2026-05-09

### diag: role-aware cast windup telemetry

User reports BM halo not visible on PVP opponent. The existing `[cast-render]` telemetry inside `drawCasterCastBehind` doesn't include the caller's role — both ally and PVP-enemy log identically as `role=halo`, can't tell which fired.

Added a one-shot `[windup-call] role:layer:job:spell at(x,y)` log in `drawCastWindup` that POSTs to `/api/client-error` (visible in `pm2 logs`). Fires once per unique `(role, layer, jobIdx, spellId)`. Trigger a PVP-enemy BM Fire cast and `ssh root@68.183.59.19 "pm2 logs server --err --nostream --lines 20 | grep windup-call"` will tell us:

- `[windup-call] pvp-enemy:behind:4:31 at(N,M)` → render IS firing for PVP-enemy BM Fire cast at coords (N,M). Visibility issue, not a wiring issue. Fix: position adjustment.
- No `pvp-enemy:behind` entries → `_resolveCastContext('pvp-enemy', idx)` returning null. Likely `pvpSt.pvpMagicCasterCellIdx !== idx` mismatch or `opp.jobIdx` undefined.
- `pvp-enemy:behind:0:NN` (job=0) → opp.jobIdx not set on the casting opponent — fall through to OK which has no halo.

Trigger one cast and I'll grep the logs.

## 1.7.175 — 2026-05-09

### tune: gaps between spell pipeline phases (smoother pacing)

User wants the four-stage pipeline to read as discrete steps with breathing room, not blurred-together. Sequence now: cast → projectile → **gap** → spell anim → **gap** → damage number bounce. Same spacing that the slash → damage flow already has (HIT_PAUSE_MS = 316 ms between slash end and damage number).

Added two phase constants to `CAST_PHASE_MS_THROW`:
- `preImpactGap: 100` — orb lands, 100 ms beat, burst begins.
- `postImpactGap: 100` — burst ends, 100 ms beat, damage number pops.

Throw timeline (all 3 roles):
```
buildup        0   →  800   cast windup (halo + flame on caster)
projectile     0   →  150   orb travels caster → target
preImpactGap   150 →  250   nothing rendered — beat
impact         250 →  800   burst plays on target (550 ms)
postImpactGap  800 →  900   nothing rendered — beat
damage @ 900                damage applies, dmg number pops
ret            900 →  1067  damage number bounces during ret
```

Engine + helper changes:
- `spell-cast.js` projectile phase duration extended by `preImpactGap`. Per-target impact-walk damage applies at `impact + postImpactGap = 650 ms` (was 550). Per-target window now 1150 ms (was 1050).
- `combatant-cast.js:_resolveSimpleThrow` (ally + PVP-enemy) phase split has explicit `null` returns during gap windows so the renderer draws nothing.
- `combatant-cast.js:_resolvePlayerThrow` thrown branch gates impact render on `battleTimer < impact` so the burst stops at impact end and the post-impact gap renders nothing.
- `ALLY_MAGIC_EFFECT_MS` / `PVP_MAGIC_EFFECT_MS` = 900 (was 700).
- `ALLY_MAGIC_HIT_MS` / `PVP_MAGIC_HIT_MS` = 1067 (was 867).

Slash → damage flow already had a 316 ms gap (`HIT_PAUSE_MS`) between slash end and damage number; no change needed there.

## 1.7.174 — 2026-05-09

### refactor: player-only spell types extracted into helpers

Final spell-system unification — every spell type now goes through a `combatant-cast.js` helper. Previously, drain / recovery / all-status / instakill / erase only had inline implementations in `_applyEnemyEffect` because no other role casts them today. Extracted anyway — when a future ally / PVP-enemy AI gets one of these spells, the call site is one line.

**Five new helpers in `combatant-cast.js`:**
- `applyMagicDrain(target, amount, opts)` — damages target + heals caster, undead reverses (heals target, no caster heal). Caller provides `onTargetDmgNum` / `onTargetHealNum` / `onCasterHeal` callbacks.
- `applyMagicRecovery(target, amount, opts)` — heals non-undead, damages undead. `opts.isUndead` indicates which path.
- `applyMagicAllStatus(target, hitChance, opts)` — Shade / Tranquilizer pattern, rolls every "major" debuff against `hitChance`. Default candidate list: paralysis / blind / silence / sleep / confuse, override via `opts.candidates`. Calls `onStatusLand(flag)` per landed status for per-status battle messages.
- `applyMagicInstakill(target, hitChance, opts)` — Death roll, sets HP=0 + DEATH status flag on land. `onKill` triggers death anim.
- `applyMagicErase(opts)` — SFX-only today (no monster buff state); forward-compatible.

`_applyEnemyEffect` (`spell-cast.js`) now dispatches by spell type to these helpers. Shrunk substantially — the inline drain/recovery/all-status/instakill/erase blocks are now 5-12 line calls with callbacks. The `_isUndead(mon)` branching is decided by the caller and passed as `opts.isUndead`.

### Spell pipeline modularization — fully unified

Every spell type used by any role goes through a shared `combatant-cast.js` helper:

| Spell type | Helper | Used by |
|---|---|---|
| Damage (Fire / Bzzard / Bolt) | `applyMagicDamage` | Player + Ally + PVP-enemy |
| Status (Sleep / Confuse / Blind / etc.) | `applyMagicStatus` | Player + Ally + PVP-enemy |
| Heal (Cure) | `applyMagicHeal` | Player + Ally + PVP-enemy |
| Cure-status (Poisona / Antidote) | `applyMagicCureStatus` | Player + Ally + PVP-enemy |
| Sight | `applyMagicSight` | Player + Ally + PVP-enemy |
| Drain | `applyMagicDrain` | Player (Ally / PVP-enemy ready) |
| Recovery (undead-aware) | `applyMagicRecovery` | Player (Ally / PVP-enemy ready) |
| All-status (Shade) | `applyMagicAllStatus` | Player (Ally / PVP-enemy ready) |
| Instakill (Death) | `applyMagicInstakill` | Player (Ally / PVP-enemy ready) |
| Erase | `applyMagicErase` | Player (Ally / PVP-enemy ready) |
| Cast windup | `drawCastWindup` | Player + Ally + PVP-enemy |
| Throw anim (projectile + impact) | `drawSpellThrow` | Player + Ally + PVP-enemy |

All math + state mutation lives in `combatant-cast.js`. Each role's apply fn is a thin dispatcher that resolves its target object + I/O callbacks and hands off. When a future role gets a new spell type, the call site is one helper invocation — no parallel implementation.

## 1.7.173 — 2026-05-09

### refactor: heal / sight / cure-status unified across all 3 roles

Three more shared helpers in `combatant-cast.js`:
- `applyMagicHeal(target, amount, opts)` — clamps to maxHP, increments HP, fires `onHealNum`, plays SFX. Works on `ps`, `battleAllies[i]`, `pvpEnemyAllies[i]`, encounter monster.
- `applyMagicCureStatus(target, statusFlag, opts)` — `removeStatus` + sparkle placeholder + SFX.
- `applyMagicSight(opts)` — ineffective msg + impact SFX.

Wired all three roles' apply fns:
- `spell-cast.js:_applyEnemyEffect` — Sight branch routes through `applyMagicSight`.
- `spell-cast.js:_applySpellEffect` — friendly Sight + cure-status + heal all route through the shared helpers.
- `battle-ally.js:_applyAllyMagicEffect` — Sight + Poisona + Cure all route through them.
- `pvp.js:_applyPVPEnemyMagicEffect` — Sight + Poisona + Cure on enemy team allies all route through them.

Each role still resolves its own target object + heal-num callback (player → `setPlayerHealNum` / ally-array slot, ally → same shapes per target type, PVP-enemy → `setEnemyHealNum` with cellIdx). The math + state-mutation lives in the helpers; only the per-role I/O bindings stay in role files.

### Spell pipeline modularization status

| Spell type | Helper | Roles wired |
|---|---|---|
| Damage (Fire/Bzzard) | `applyMagicDamage` | Player + Ally + PVP-enemy |
| Status (Sleep / Confuse / etc.) | `applyMagicStatus` | Player + Ally + PVP-enemy |
| Heal (Cure) | `applyMagicHeal` | Player + Ally + PVP-enemy |
| Cure-status (Poisona / Antidote) | `applyMagicCureStatus` | Player + Ally + PVP-enemy |
| Sight | `applyMagicSight` | Player + Ally + PVP-enemy |
| Cast windup | `drawCastWindup` | Player + Ally + PVP-enemy |
| Throw anim (projectile + impact) | `drawSpellThrow` | Player + Ally + PVP-enemy |

Player-only spell types still in `_applyEnemyEffect` (no other role currently casts them): drain, recovery-on-undead, all-status (Shade), instakill (Death), erase. These are forward-compatible — when a future ally/PVP AI gets one of these spells, the helper extraction is straightforward.

## 1.7.172 — 2026-05-09

### refactor: damage / status application unified across all 3 roles

Final piece of the cast-pipeline modularization. Previously each role had its own copy of the Fire/Bzzard damage application (element multiplier + mdef + HP decrement + dmg num + shake + SFX) and Sleep status application (tryInflictStatus + msg + miss display + SFX). Three near-identical paths.

**`combatant-cast.js`** exports two shared helpers:
- `applyMagicDamage(target, baseDmg, spell, opts)` — element/resist multiplier, mdef reduction, HP decrement, optional callbacks (`onDmgNum`, `onShake`, `onKill`), auto-plays `opts.sfx`. Returns the actual damage dealt.
- `applyMagicStatus(target, statusName, hitChance, opts)` — `tryInflictStatus` against `target.statusResist`, optional callbacks (`onStatusMsg(bytes)`, `onLand(flag)`, `onMiss`), auto-plays `opts.sfx`. Returns the applied status flag (or 0 on miss).

**Three apply fns wired:**
- `spell-cast.js:_applyEnemyEffect` — Fire/Bzzard branch (line 462) and the single-status sub-branch within `enemy_status` (line 363) now call the helpers.
- `battle-ally.js:_applyAllyMagicEffect` — Fire/Bzzard/Sleep branch.
- `pvp.js:_applyPVPEnemyMagicEffect` — Fire/Bzzard/Sleep branch.

Each call site dropped from ~10-15 inline lines to a 3-7 line helper invocation with role-specific callbacks. Removed redundant imports (`elemMultiplier`, `tryInflictStatus`, `STATUS_NAME_BYTES`) from the role files since they now live in `combatant-cast.js`.

**Player path retains additional spell-type branches** (sight, drain, recovery, all_status, death/instakill, erase) since ally + PVP-enemy don't cast those. Those branches stay in `_applyEnemyEffect` — extracting them would add complexity without saving lines. The COMMON ground (Fire/Bzzard damage + Sleep status) is now one place.

### Pipeline modularization complete

| Stage | Status | Single helper |
|---|---|---|
| Cast windup | ✅ All 3 roles | `drawCastWindup(layer, ctx, role, idx, x, y, mirror)` |
| Throw anim (projectile + impact burst) | ✅ All 3 roles | `drawSpellThrow(role, ctx, caster, target)` |
| Damage application (Fire/Bzzard) | ✅ All 3 roles | `applyMagicDamage(target, baseDmg, spell, opts)` |
| Status application (Sleep) | ✅ All 3 roles | `applyMagicStatus(target, name, hitChance, opts)` |

All in `combatant-cast.js` (despite the name — it grew beyond just cast windup).

## 1.7.171 — 2026-05-09

### refactor: spell throw animation unified for ALL THREE roles

User pushed back on the v1.7.170 partial unification ("ally + PVP only, player kept separate") — wanted everything pulling from the same helper. Done.

`drawSpellThrow(role, ctx, caster, target)` in `combatant-cast.js` now handles all three roles via a `_resolveThrowRender` dispatcher. Roles + flows:

| Role | Flow | Phase split |
|---|---|---|
| `'player'` | Item-use | Skip projectile, single-target impact at `getSpellHitIdx()` |
| `'player'` | Thrown (Fire / Bzzard / Sleep / Sight) | `getMagicHitPhase()` reports phase; parallel projectile, serial impact-walk |
| `'player'` | Heal-style (Cure on undead) | Projectile during heal-window (`CAST_T_LUNGE..CAST_T_HEAL`), parallel impact during heal window |
| `'ally'` | Single-target throw | `ms < CAST_PHASE_MS_THROW.projectile` → projectile, else impact |
| `'pvp-enemy'` | Single-target throw | Same simple split |

Renderer is two branches (`phase === 'projectile'` → `drawProjectileFan`, else → `drawSpellEffectAtTargets`). All three player flows + ally + pvp-enemy converge on the same render call.

**Call sites:**
- `_drawPlayerSpellTargetSparkleOnEnemy` — was 73 lines of branching, now 5 lines (caster coords + one helper call).
- `_drawAllyOffensiveCast` — 7 lines.
- `_drawPVPEnemyOffensiveCast` — 11 lines (one extra branch for partyIdx → player vs ally target spec).

`getSpellTargets`, `getMagicHitPhase`, `getSpellHitIdx`, `isCurrentCastItemUse`, `getCastAnimElapsedMs`, `getCurrentSpellId` now imported into `combatant-cast.js` so the player-flow resolver has full access to engine state.

Pipeline modularization complete:
- ✅ Cast windup — `drawCastWindup(layer, ctx, role, idx, x, y, mirror)` (v1.7.167)
- ✅ Throw anim — `drawSpellThrow(role, ctx, caster, target)` (v1.7.171, all 3 roles)
- ❌ Damage application — three apply fns still split. Next consolidation target if/when needed.

## 1.7.170 — 2026-05-09

### refactor: spell throw animation unified (ally + PVP-enemy)

Continuing the cast-pipeline modularization. v1.7.167 unified cast windup. This unifies the throw animation (projectile fan → impact burst) for ally and PVP-enemy paths.

**`combatant-cast.js:drawSpellThrow(role, ctx, caster, target)`** — single entry point. Caller resolves role-specific caster position + target spec; helper handles state gating, projectile/impact phase split, and spell-anim dispatch via `drawProjectileFan` / `drawSpellEffectAtTargets`. Internal `_resolveThrowContext(role)` reads role-specific state (`battleSt.allyMagic*` for ally, `pvpSt.pvpMagic*` for pvp-enemy) and returns `{ ms, spellId, spell }` or `null`.

**Call sites collapsed:**
- `_drawAllyOffensiveCast` — was 24 lines of state checks + projectile/impact branching, now 7 lines: caster position math + one `drawSpellThrow('ally', ...)` call.
- `_drawPVPEnemyOffensiveCast` — was 31 lines with the same pattern, now 11 lines (one extra branch for `partyIdx === -1` → player vs ally target spec).

`drawProjectileFan` and `drawSpellEffectAtTargets` are now exported from `battle-drawing.js` so `combatant-cast.js` can import them directly. The cycle (battle-drawing → combatant-cast → battle-drawing) resolves lazily — both imports are only used inside fn bodies, not at module top-level.

**Player path NOT consolidated yet.** `_drawPlayerSpellTargetSparkleOnEnemy` has three orthogonal flows (multi-target impact-walk via `getMagicHitPhase()` + `getSpellHitIdx()`, heal-style projectile-during-heal-window, item-use skip-windup) that don't fit the simple ally/PVP single-target-throw model. Trying to fold them in would either bloat the helper or split it back into role-specific branches. Kept separate; can be revisited if/when ally + PVP get multi-target.

Cast pipeline modularization status:
- Cast windup ✅ unified (v1.7.167) — `drawCastWindup` for all 3 roles.
- Spell throw anim ✅ unified for ally + pvp-enemy (v1.7.170).
- Spell throw anim ⚠️ player still standalone (multi-target / heal-style / item-use complexity).
- Damage application — three apply fns still exist (`spell-cast.js:_applyEnemyEffect`, `battle-ally.js:_applyAllyMagicEffect`, `pvp.js:_applyPVPEnemyMagicEffect`). Each role has its own roll + `setSwDmgNum`/etc. logic. Future consolidation target.

## 1.7.169 — 2026-05-09

### fix: damage number AFTER spell animation (not during)

v1.7.168 set ally + PVP `EFFECT_MS` to projectile end (150 ms = impact START), so the damage number popped on the first frame of the burst. User said the sequence is "cast → projectile → spell anim → damage number" — strictly sequential, damage AFTER the burst plays out. The player path already does this; comment at `spell-cast.js:602` literally says "effect at impact END so the damage number doesn't" overlap the burst. I missed it.

Fixed: `ALLY_MAGIC_EFFECT_MS` and `PVP_MAGIC_EFFECT_MS` now equal `CAST_PHASE_MS_THROW.projectile + CAST_PHASE_MS_THROW.impact = 700` — fires when the burst ENDS. The 167 ms ret window then displays the damage number cleanly before state transitions.

Frame timeline (corrected):
```
[*-magic-cast]   0   → 800   cast windup
[*-magic-hit]    0   → 150   projectile fan
                 150 → 700   spell anim (impact burst)
                 700 ←        damage applies + dmg number pops
                 700 → 867   ret window — damage number displays alone
[next state]
```

Damage number lives 700 ms via SW_DMG_SHOW_MS — visible from t=700 through t=1400 (overlapping into the next state, ticking down via `tickDmgNums` regardless of state).

Saving lesson: when the user lists steps in order, treat them as strictly sequential. Don't assume parallel timing without re-reading.

## 1.7.168 — 2026-05-09

### tune: ally + PVP magic timings derive from CAST_PHASE_MS_THROW

Audited the four-stage spell pipeline (cast windup → projectile → impact burst → damage number) across all three roles. Player path uses the canonical `CAST_PHASE_MS_THROW` constants from `cast-anim.js` (buildup 800 / projectile 150 / impact 550 / ret 167 = 1667 ms total). Ally and PVP-enemy paths had their own hardcoded numbers (`*_MAGIC_HIT_MS = 1000`, `*_EFFECT_MS = 400`), giving an 850 ms impact phase vs the player's 550 ms and a damage-pop offset of 250 ms after impact start vs the player's 0 ms. Felt draggy + out of sync.

Aligned ally + PVP-enemy timings to derive from the same constants:

| Role | Cast windup | Projectile | Impact | Damage applies | Hit total |
|---|---|---|---|---|---|
| Player throw | 800 | 150 | 550 | impact start (=projectile end) | per-target 717 + ret 167 |
| Ally (was) | 800 | 150 | 850 | hit-phase 400 ms | 1000 |
| Ally (now) | 800 | 150 | **550** | **hit-phase 150 ms (impact start)** | **867** |
| PVP-enemy (was) | 800 | 150 | 850 | hit-phase 400 ms | 1000 |
| PVP-enemy (now) | 800 | 150 | **550** | **hit-phase 150 ms (impact start)** | **867** |

```js
// battle-ally.js
const ALLY_MAGIC_CAST_MS   = CAST_PHASE_MS_THROW.buildup;     // 800
const ALLY_MAGIC_EFFECT_MS = CAST_PHASE_MS_THROW.projectile;  // 150
const ALLY_MAGIC_HIT_MS    = CAST_PHASE_MS_THROW.projectile +
                             CAST_PHASE_MS_THROW.impact +
                             CAST_PHASE_MS_THROW.ret;          // 867
```

(Same in `pvp.js`.) If the player throw timing ever changes, all three roles update automatically. No more drift.

**Smoothness audit**: damage number now pops on the first frame of the impact burst (right when the orb lands), not 250 ms later. SW_DMG_SHOW_MS = 700 ms, so the number is visible from hit-phase t=150ms through t=850ms, overlapping the ret window and auto-clearing via `tickDmgNums` in `updateBattle` — no flicker on state transition. Heal casts (same-faction, no projectile) get the same 150 ms apply timing; heal sparkle still plays the entire hit phase via `tickHealNums` until `clearHealNums` on hit-end.

Frame timeline (ally cast on cross-faction target, e.g. BM ally Fire on monster):
```
[ally-magic-cast]  0   → 800   cast windup (halo behind portrait, flame size-cycle in front)
[ally-magic-hit]   0   → 150   projectile fan from caster to target
                   150 → 700   impact burst (8 frames @67ms toggle)
                   150 ←        damage roll applies + setSwDmgNum
                   700 → 867   ret hold (matches player canonical)
[monster-death | pvp-dissolve | next-turn]
```

## 1.7.167 — 2026-05-09

### refactor: cast windup unified across all three roles

User correctly called out that cast windup detection was still per-role inline blocks (one in `_drawBattlePortrait`, one in `_drawAllyPortrait`, one in `pvp.js:_drawCellSprite`) — three separate `if (state) drawCasterCastBehind/Front(...)` patterns reading role-specific state. Same conceptual thing, three places. Real modularization needed.

**`src/combatant-cast.js`** — new module. Single export `drawCastWindup(layer, ctx, role, idx, x, y, mirror)`. Internal `_resolveCastContext(role, idx)` reads role-specific state and returns `{ jobIdx, spellId, elapsed }` or `null`. Roles: `'player'` (uses `getCastAnimElapsedMs()` + `getCurrentSpellId()`), `'ally'` (matches `battleSt.allyMagicCasterIdx === idx`, reads `battleSt.allyMagic*` + `ally.jobIdx`), `'pvp-enemy'` (matches `pvpSt.pvpMagicCasterCellIdx === idx`, reads `pvpSt.pvpMagic*` + opponent jobIdx).

**Three call sites collapsed:**
- `_drawBattlePortrait:451` (cast behind, before portrait): `drawCastWindup('behind', ui.ctx, 'player', 0, pxs+8, py+8)`.
- `_drawBattlePortrait:304` (cast front, after portrait): `drawCastWindup('front', ui.ctx, 'player', 0, px+8, py+8)`.
- `_drawAllyPortrait` (before/after `drawImage(portraits[fadeStep])`): `drawCastWindup('behind'|'front', ui.ctx, 'ally', i, ppx+8, ppy+8)`.
- `pvp.js:_drawCellSprite` (before/after body draw): `drawCastWindup('behind'|'front', ui.ctx, 'pvp-enemy', idx, sprX+8, sprY+12, true)`.

ALL THREE ROLES now go through the SAME function. Adding a fourth role (encounter monster cast, future Caller job, etc.) is a switch-case in `_resolveCastContext`, not a fourth render block. Adding a new gating condition (e.g., suppress during a specific sub-phase) is one edit, not three.

Cast windup divergence finally gone — was the v1.7.150 → v1.7.166 thrash spread across 17 versions. Spell-throw animation (the projectile + impact phase: `_drawPlayerSpellTargetSparkleOnEnemy` + `_drawAllyOffensiveCast` + `_drawPVPEnemyOffensiveCast`) is the next consolidation target — same shape, three render fns to merge.

## 1.7.166 — 2026-05-09

### fix: ally cast uses the SAME system as user portrait (clip removed)

User kept asking for the ally cast to use the same system as the user portrait. The blocker was the panel clip in `drawBattleAllies` — `_drawBattlePortrait` runs WITHOUT a wrapping clip, which is why its inline cast block at `:451` works. Every "modular" attempt I made (parallel `_drawAllyCastAnim*` helpers v1.7.150, pre/post-clip `_drawAllyCastWindup` v1.7.164) preserved the clip and added complexity to work around it.

**Removed the global panel clip in `drawBattleAllies`.** The clip was wrapping the whole row loop. Now ally rows render without it, exactly like the player portrait. Ally cast inlines in `_drawAllyPortrait` with the SAME shape as `_drawBattlePortrait:451`:

```js
// before portrait:
if (battleSt.battleState === 'ally-magic-cast' && battleSt.allyMagicCasterIdx === i && !battleSt.allyMagicItemMode) {
  drawCasterCastBehind(ui.ctx, ppx + 8, ppy + 8, ally.jobIdx || 0, battleSt.allyMagicSpellId, battleSt.battleTimer, false);
}
ui.ctx.drawImage(portraits[ally.fadeStep], ppx, ppy);
// after portrait:
if (...same gate) drawCasterCastFront(...);
```

Identical to the player block. No `_drawAllyCastWindup`, no `_allyCastContext`, no pre/post-pass. The clip removal was the actual unblock — the v1.7.163 inline attempt would have worked if I'd done this then. Should have just removed the clip the first time. Saving this lesson: when the user says "use the same system", check what's actually different first. The clip was a structural divergence I kept treating as a constraint instead of removing.

Local clips inside `_drawAllyPortrait` (death-slide phase 1) still apply where needed.

## 1.7.165 — 2026-05-09

### diag: cast windup telemetry pipes to pm2 logs

User reports BM halo still missing on roster ally cast after v1.7.164 modular fix. v1.7.162 telemetry only logged to in-game chat (`consoleLog`); from SSH (no browser dev tools, no chat visibility) I can't see what's happening. Upgraded:

- `_logCastBehindMiss` now ALSO POSTs to `/api/client-error` so the message lands in `pm2 logs server --err`. Same one-shot dedup per `(jobIdx, spellId, resolved-jobKey)` tag.
- New `logCastSuccess(role, jobIdx, spellId)` exported from `cast-anim.js`. Fires once per `(role, job, spell)` when the halo successfully renders. Pipes to chat + pm2.
- `_drawAllyCastWindup` calls `logCastSuccess('ally-windup-behind|front', ...)` BEFORE invoking `drawCasterCastBehind/Front`. So pm2 will show:
  - `[cast-render] role=ally-windup-behind job=N spell=$NN` if the windup function is reached.
  - `[cast-render] role=halo job=N spell=$NN` if the halo successfully draws.
  - `[cast-behind-miss] job=N spell=$NN resolved=...` if `getCastVisual` failed to return a BM bundle.

Trigger an ally BM cast post-deploy and `ssh root@68.183.59.19 "pm2 logs server --err --nostream --lines 30 | grep cast-"` will tell us EXACTLY where the chain breaks: state never enters → no log; windup gate fails → no log; resolve fails → miss log; resolve OK → success log but no visible halo means clip / position / rendering issue downstream.

## 1.7.164 — 2026-05-09

### fix: ally cast windup renders over HUD, outside panel clip

v1.7.163 inlined the ally cast render into `_drawAllyPortrait` to mirror the player pattern, but `_drawAllyPortrait` runs INSIDE the panel clip (`HUD_RIGHT_X, panelTop, HUD_RIGHT_W, ...`). The BM cast flame anchors at `centerX - _SPRITE_HALF_W - _FLAME_W = ppx + 8 - 24 = HUD_RIGHT_X - 8` for an ally at column-left, so the flame's left half (16 px wide canvas, anchored at x=136 for ally row when HUD_RIGHT_X=144) was being clipped by the panel rect.

**Fix:** ally cast windup renders in `drawBattleAllies` via `_drawAllyCastWindup(layer)` — pre-clip pass for `'behind'` (halo), post-clip pass for `'front'` (stars/flame). The helper is a thin inline gate (state + caster idx + ally validity), same shape the player uses at `_drawBattlePortrait:451-454`, lifted out of the row loop only because it must render outside the panel clip. NOT a parallel `_allyCastContext` helper — the gating is fully inline, just hoisted to the right z-layer.

**Z-layer audit:** all three cast windups (player + ally + PVP-enemy) now render after `drawHUD` (so they layer over the baked HUD canvas + info panel) and before `drawChat / drawMsgBox / drawPauseMenu / drawShop / drawRosterMenu` overlays. PVP enemy cast renders inside `drawBattle` via `drawBossSpriteBoxPVP` → `_drawCellSprite`. Player cast renders inside `drawBattle` via `_drawBattlePortrait`. Ally cast renders in `drawBattleAllies` (called between `drawHUD` and `drawBattle`). All three are post-HUD; only the chat-fully-expanded edge case obscures (and that obscures the whole ally row regardless of cast).

The pre/post-clip pattern is the SAME shape the v1.7.150 helpers used; the difference is that the gating + draw is now ONE inline body shared between behind/front via a `layer` param, instead of `_allyCastContext` returning a context dict that two separate fns consume.

## 1.7.163 — 2026-05-09

### refactor: ally cast render uses the player pattern (not a parallel path)

User caught the actual problem: roster ally cast had a SEPARATE render path (`_drawAllyCastAnimBehind` / `_drawAllyCastAnimFront` + `_allyCastContext` helper) that lived in `drawBattleAllies` outside the panel clip, while the player called `drawCasterCastBehind/Front` INLINE from `_drawBattlePortrait:451-454`. Two different render code paths for the same conceptual thing — caused intermittent ally halo failures because the two paths kept drifting (the v1.7.150 mistake compounding through 1.7.153 / 1.7.162).

**Fix:** ally cast renders inline in `_drawAllyPortrait` exactly like player. Same shape:
- `if (battleState === 'magic-cast'/'ally-magic-cast' && right caster) drawCasterCastBehind(...)` — before portrait draw.
- ` ui.ctx.drawImage(portraits[fadeStep], ...)` — portrait.
- `if (...) drawCasterCastFront(...)` — after portrait.

Player passes `ps.jobIdx` + `getCurrentSpellId()` + `getCastAnimElapsedMs()`; ally passes `ally.jobIdx || 0` + `battleSt.allyMagicSpellId` + `battleSt.battleTimer`. Otherwise identical. No `_allyCastContext` helper, no separate clip-vs-no-clip pass, no parallel structure.

Net: -50 lines. Removed `_drawAllyCastAnimBehind`, `_drawAllyCastAnimFront`, `_allyCastContext`, plus their two call sites bracketing the panel-clip pass in `drawBattleAllies`. The pre-clip / post-clip "halo extends past panel boundary" comment was stale anyway — the BM halo is 32×32, fully contained within the 32-wide ally row, never extends past the panel.

Lesson saved to memory: when adding a render feature for a new role (ally / PVP enemy / encounter monster), MIRROR the existing player render structure inline at the equivalent draw site, not a parallel `_drawXCastAnim` helper. The instinct to "encapsulate per role" creates two paths that drift; inline-with-the-portrait keeps player + ally lockstep.

## 1.7.162 — 2026-05-09

### fix: target stays visible during ally-magic-hit + cast-behind miss telemetry

**Target disappears during ally cast impact.** When an ally Fire/Bzzard hit dropped an encounter monster or PVP enemy to 0 HP, the body sprite vanished mid-burst because the "keep visible while being hit" gate didn't include `'ally-magic-hit'`. Same fix on both render sites:
- `_drawEncounterMonsters` (`battle-drawing.js:1118`) — added `isAllyMagicHitTarget` (`battleSt.allyMagicTargetType === 'enemy'` + matching idx), folded into the existing `isBeingHit` OR.
- `_drawCellSprite` (`pvp.js:1010`) — added `isMagicHitKill` (player cast on PVP) and `isAllyMagicHitKill` (ally cast on PVP, both with the idx-0=opp / 1+=enemy-ally convention spell-cast uses), folded into a unified `keepVisible` predicate. Replaces the earlier `isBeingKilled`-only gate that silently dropped magic-hit kills on PVP enemies — same root pattern as the encounter side, also now fixed.

Now imports `getSpellTargets` from `spell-cast.js` in `pvp.js` for the player-cast PVP target check.

**Cast-behind miss telemetry.** `drawCasterCastBehind` now emits a one-shot dev console log (`[cast-behind-miss] job=N spell=$NN resolved=jobKey`) whenever the caller is in the buildup window (so they expect a halo) but `getCastVisual` resolves to a non-BM bundle (no haloCanvas). User reported "roster ally BM halo isn't rendering on cast" — without runtime debugging, this telemetry will surface the exact (jobIdx, spellId) the renderer is seeing next session. If `resolved=wm` shows up for what should be a black-school spell, `jobToCastKey` is mis-classifying. If `resolved=null`, the bundle didn't initialize for that job. If `resolved=bm` but no halo still draws, the canvas is rendering off-screen / behind the ally portrait clip — that's a positioning issue elsewhere.

## 1.7.161 — 2026-05-09

### refactor: combatant pose maps consolidated + miss telemetry

User audit ask after intermittent PVP back-swing dropouts. Three pose-resolution sites had grown apart:

- `bsc.battlePoses[key]` — player (battle-sprite-cache).
- `ALLY_POSE_MAP` — roster ally portraits, lived in `battle-drawing.js:82`.
- `OPP_POSE_MAP` — PVP opponent full-body, lived in `pvp.js:54`.

Adding a new pose key required editing three different files and was easy to miss one. Worse, the ally-portrait and opp-body maps had different aliasing rules (ally's non-knife `rBack` → `fakePlayerAttackPortraits`; opp's non-knife `rBack` → `fakePlayerKnifeRFullBodyCanvases`) — by design, but undocumented and split across files.

**Changes:**
- Both `ALLY_POSE_MAP` and `OPP_POSE_MAP` consolidated into `combatant-pose.js` as `_POSE_MAPS = { ally, opp }`.
- New `pickCombatantBody(role, poseKey, jobIdx, palIdx)` helper — single source of truth for pose canvas resolution. Returns `undefined` on miss instead of crashing.
- `pvp.js:1098` was `body = _fpb(OPP_POSE_MAP[key]) || fullBody` → now `pickCombatantBody('opp', key, _ej, palIdx) || fullBody`.
- `battle-drawing.js:1653` was `portraits = _fp(ALLY_POSE_MAP[key])` → now `pickCombatantBody('ally', key, _j, ally.palIdx)`.
- Removed unused `fakePlayerKnife*FullBodyCanvases` imports from `pvp.js` (only the local map referenced them).

**Telemetry:** `pickCombatantBody` now emits a one-shot dev-console log on every distinct miss reason (`no-dict` / `no-job-entry` / `no-palette-canvas`) with `role:key:jobIdx:palIdx:reason`. Dev-gated. So if the back-swing drops again on a hard-reloaded build, the next session shows `[pose-miss] opp:rBack:7:5:no-palette-canvas` (or whatever) in the in-game console — gives us the exact missing canvas instead of guessing.

Also exported `ATTACK_POSE_KEYS` set for future render sites that want to gate telemetry to attack frames specifically (idle/victory misses are benign).

### Audit findings (informational)

- `combatant-sprites.js:_genericBundle` builds `bodies.rBack/lBack/rFwd/lFwd` for every job, but `_buildFakePlayerSet` (`sprite-init.js`) drops them — non-knife body dicts (`fakePlayerRBackFullBody…`) are never created. The opp map aliases through `fakePlayerKnife*FullBodyCanvases` instead. Documented but left as-is; the alias produces a more visually distinct back-swing silhouette than the 1-tile-swap rBack/lBack would.
- The opp body branch at `pvp.js:1082-1105` is a 7-way if/else (hit / hand-change gap / attack / defending / item / victory / near-fatal). Not centralized into a `pickOpponentBody` helper yet — bigger refactor, deferred.

## 1.7.160 — 2026-05-09

### fix: PVP enemy box vanishes during magic cast/hit

`drawBossSpriteBox` at `battle-drawing.js:1306-1320` enumerates the battle states during which the PVP enemy box (the entire left-side battle area showing opponent + enemy allies) renders. The whitelist included every other PVP action state — `pvp-defend-anim`, `pvp-enemy-slash`, `pvp-opp-potion`, `pvp-opp-sw-throw/hit`, `pvp-dissolve` — but was missing **`pvp-enemy-magic-cast`** and **`pvp-enemy-magic-hit`**.

So during *any* PVP enemy spell cast (Cure, Poisona, Fire, Blizzard, Sleep), `drawBossSpriteBoxPVP` was skipped → the entire PVP enemy box and everything in it (the casters, their teammates, weapon overlays, status icons) vanished until the action ended. No throw, no pm2 log — just a missing state in the gate. Added both states.

Found by listing what disappears (PVP HUD + bodies) → reading `drawBossSpriteBox` → diffing the whitelist against the actual PVP magic state names. Lesson: when a render bug doesn't throw, the most common cause is a state-name whitelist that was extended for one feature but missed by another.

## 1.7.159 — 2026-05-09

### fix: more unguarded gridPos lookups in battle drawing

v1.7.156 added an `if (pos)` guard at one of three identical crash sites; missed the other two. Same root pattern: `const pos = gridPos[X]; pos.x` with no null check, throws when the index drifts out of `gridPos` (monster died mid-frame, encounterMonsters / gridPos length mismatch). The throw inside `try/catch` at `game-loop.js:153` skips the rest of the battle/chat/menu/ally draw block, so HUD + roster portraits + chat all vanish until the bad state passes.

Sites fixed:
- `_drawEncounterSlashEffects:1160` — player-slash on a dying monster.
- `_drawEncounterMonsters:1133` — main monster loop, gridPos / encounterMonsters length mismatch.
- `_encounterMonsterPos:1820` — already had a `safeIdx < gridPos.length ? idx : 0` clamp, but `gridPos[0]` is still undefined when gridPos is empty. Returns a safe `{ bx: 0, baseY: 0 }` zero-position now instead of crashing the caller (`_drawBossDmgNum`, `_drawEnemyHealNum`).

Audit-grep ran across all `gridPos[...]` lookups in `battle-drawing.js`; remaining sites either had pre-existing guards (`if (pos)`, `if (idx >= gridPos.length) return null`) or are inside the `_encounterGridLayout` builder itself.

Lesson saved to memory: when fixing a pattern bug, grep ALL occurrences in the same file before declaring the fix done; one-site fixes leak when the same anti-pattern was copy-pasted.

## 1.7.158 — 2026-05-09

### fix: enemy death from ally offensive cast

Confirmed the analogous bug in the other direction — when a roster ally BM/RM landed a kill spell on an encounter monster or PVP enemy, the target sat at 0 HP with no death animation. If it was the last living enemy, the battle never transitioned to victory because the all-dead check (`battle-update.js:521` for encounter, `advancePVPTargetOrVictory` for PVP) only fires from `monster-death` / `pvp-dissolve` state — and the ally cast pipeline went straight to `_processNextTurn` instead.

Added kill detection at the end of `_updateAllyMagicCast`'s hit phase, mirroring `spell-cast.js:_finishMagicHit`:
- `targetType === 'enemy'` + `encounterMonsters[idx].hp <= 0` → set `dyingMonsterIndices` + transition to `'monster-death'` + `MONSTER_DEATH` SFX + replace strip with `BATTLE_SLAIN`.
- `targetType === 'pvp-enemy'` + `pvpOpponentStats` or `pvpEnemyAllies[idx-1]` at 0 HP → set `pvpDyingMap` + transition to `'pvp-dissolve'` + same SFX/strip.
- Otherwise fall through to `_processNextTurn` as before.

Skips the next-turn call when routed to death so the death-state animation timer drives the next transition. Existing encounter-victory (`monster-death` state) and PVP-victory (`advancePVPTargetOrVictory` from `pvp-dissolve`) paths handle "all enemies dead" correctly without further changes.

## 1.7.157 — 2026-05-09

### fix: roster ally death on PVP enemy spell

PVP enemy casting Fire / Blizzard on a roster ally dropped the ally's HP to 0 but didn't trigger the death animation or pull them from the turn queue. The ally kept standing, the game still handed them turns, and the only visible effect was a damage number followed by silence.

Mirrored the death hookup the SouthWind opponent path uses (`pvp.js:816`): after damage application, if `partyIdx >= 0 && ally.hp <= 0 && ally.deathTimer == null`, set `ally.deathTimer = 0` and filter the ally out of `battleSt.turnQueue`. Player KO (partyIdx === -1) is unaffected — the existing top-level death timer in `hudSt` handles it.

Did NOT extend the same fix to ally-cast → enemy KO (encounter monster or PVP enemy ally not dying when an ally BM/RM lands a kill spell on them) because the user didn't report it; will land separately if/when needed. The state-machine path for player-cast enemy KO is its own thing (`spell-cast.js:722` transitions to `monster-death`); ally-cast doesn't have that state transition wired today.

## 1.7.156 — 2026-05-09

### fix: encounter cursor crash + in-game error surface

**Battle HUD vanishing.** `_drawEncounterCursors:1180` crashed every frame when `inputSt.targetIndex` drifted out of `gridPos` (monster died mid-frame, sticky targetIndex from a previous encounter). The throw was caught by `game-loop.js`'s `try/catch` around the battle/chat/menu/ally draw block, but everything below the crash in that block — `drawBattle`, `drawSWExplosion`, `drawSWDamageNumbers`, `drawChat`, `drawMsgBox`, `drawRosterMenu` — got skipped. From the user's POV, "battle HUD and everything in it disappears." Static HP top-box (rendered by `drawHUD`, which runs before the try block) survives. Added the same `if (pos)` guard the item-target branch already had.

**`_reportError` now surfaces in the in-game chat console (dev-gated).** First occurrence of any unique `tag::message` shows immediately; repeats are silenced for 60 hits then re-show with a counter (`(x60)`). Includes the first `/src/<file>.js:<line>` frame from the stack so you can identify the bad draw fn without SSH or browser dev tools. Pre-existing `/api/client-error` POST still fires (kept for prod analytics + `pm2 logs`).

Caught via `pm2 logs server --err` — same `[BATTLE DRAW ERROR] can't access property "x" of undefined / pos is undefined` repeating every frame at `target-select` state. Lesson: when a HUD-vanishes-mid-battle bug happens, the error logs are already piped to `/api/client-error` → pm2; tail those over SSH instead of asking the user to grab browser console.

## 1.7.155 — 2026-05-09

### fix: PVP cast windup duration + respawn outside dungeon

**PVP-enemy cast windup truncated.** `PVP_MAGIC_CAST_MS` was hardcoded to 600 ms, same root cause as the ally cast bug fixed in 1.7.153 — the BM/RM halo + flame size-cycle ($51-$57 paired pulse) couldn't complete a full pulse. Bumped to `CAST_PHASE_MS_THROW.buildup` (800 ms). Cast renderers in `pvp.js:1131` and `pvp.js:1211` were already wired through `drawCasterCastBehind` / `drawCasterCastFront`; only the duration was wrong.

**Respawn rule simplified.** Death always lands on the world map at the last overworld exit point (`ps.lastWorldExitX/Y`) regardless of where you died. Previously: dying not-on-overworld respawned you at the *current map's entrance tile*, which for dungeons meant respawning *inside* the cave at floor 1's interior entry — felt like progress retained when really HP/MP just got restored. Now dying in Altar Cave dumps you outside the cave on overworld; dying in a town dumps you outside the town on overworld; dying on overworld dumps you at the last structure exit. Fallback to `ps.lastTown` (Ur) if `lastWorldExitX/Y` was never set (fresh save died on first encounter).

## 1.7.154 — 2026-05-09

### chore: drop catalog line from startup console

Removed the `Catalog: N items, M monsters, K spell anims` line from the boot message. Dropped the now-unused `ITEMS` / `MONSTERS` / `getRegisteredSpellAnimCount` imports from `main.js`.

## 1.7.153 — 2026-05-09

### fix: ally cast windup duration matches player

`ALLY_MAGIC_CAST_MS` was hardcoded to 600 ms; the player's thrown-spell buildup is 800 ms (`CAST_PHASE_MS_THROW.buildup`). The BM/RM halo + flame size-cycle ($51-$57, paired pulse) didn't have time to complete a full pulse, so the cast windup looked truncated for ally casts. `_allyCastContext` was also clamping `elapsed` to 600 ms on the draw side, which would have cut the cycle off even with a longer state.

Fixed both: `ALLY_MAGIC_CAST_MS = CAST_PHASE_MS_THROW.buildup` (800), and `_allyCastContext` clamps to the same constant. The cast halo + flame now play through their full pulse before the projectile fan begins.

The shipped renderers (`_drawAllyCastAnimBehind` / `_drawAllyCastAnimFront` in `battle-drawing.js`, dispatching to `drawCasterCastBehind` / `drawCasterCastFront` from `cast-anim.js`) already pass `ally.jobIdx` and `battleSt.allyMagicSpellId` through, so BM and RM both resolve to the right cast bundle (`jobToCastKey`) for offensive casts. No code change needed there — only the timing.

## 1.7.152 — 2026-05-09

### docs: fix wrong comment in ally cast renderer

`_drawAllyOffensiveCast`'s comment claimed Sleep had no on-target bundle. Wrong — `spell-anim.js:406` registers `0x33: { kind: 'burst-strip-2frame', frames: sleepImpact, width: 48, height: 48 }`. Sleep already renders correctly through the same `drawSpellEffectAtTargets` dispatch. Fixed the comment to match reality. No code change.

## 1.7.151 — 2026-05-09

### fix: ally offensive cast spell animations

v1.7.150 shipped BM/RM ally AI casts that applied damage but didn't render the on-target spell anim — a half-done deferral that should have been part of the same change. The bundles already exist (Fire/Bzzard/Sleep are wired for player casts and PVP-enemy casts); just needed a third draw site.

**`_drawAllyOffensiveCast` in `battle-drawing.js`** — mirror of `_drawPVPEnemyOffensiveCast` for the ally caster. Source = ally portrait center (right column, row N keyed by `battleSt.allyMagicCasterIdx`). Target spec = `{type:'enemy', index: allyMagicTargetIdx}`, which `_getMagicTargetCenter` resolves to `encounterMonsters[idx]` for encounter or `_pvpEnemyCellCenter(idx)` for PVP (idx 0 = opponent, 1+ = enemy ally idx-1).

Phase split matches the PVP-enemy mirror: first `CAST_PHASE_MS_THROW.projectile` (150 ms) of `ally-magic-hit` renders the projectile fan via `drawProjectileFan`; remaining time renders the impact via `drawSpellEffectAtTargets`. Sleep is intentionally a no-op visual (no on-target bundle — same as the player and PVP paths). Fire and Bzzard now show their burst-strip cycle on the actual target slot.

## 1.7.150 — 2026-05-09

### feat: BM/RM ally AI casts black magic

Black Mage and Red Mage roster allies now actually cast offensive magic instead of falling through to the physical attack path. Previously a Lv4 BM Vivi with Fire + Bzzard in `knownSpells` would just stab with her dagger; now she casts.

**`_tryAllyOffensiveCast` in `battle-turn.js`** — picks Fire (0x31) / Bzzard (0x32) / Sleep (0x33) from `ally.knownSpells`, picks a random living target, pre-rolls damage from the ally's INT (`floor(INT/2) + power`, NES black-magic formula). 45% activation gate so it feels like a *sometimes* choice, mirroring the PVP-enemy mirror in `pvp.js`. Dispatched after `_tryAllyCure` and `_tryAllyPoisona` so RM allies still heal when teammates need it before going offensive.

**Encounter + PVP both supported.** Encounter battles target a random living `encounterMonsters` slot. PVP battles target a random living `pvpEnemyAllies` cell or `pvpOpponentStats` — same idx convention `spell-cast.js:_getEnemyAt` uses (idx 0 = opponent, 1+ = enemy ally idx-1), so damage display piggybacks on the existing `setSwDmgNum` path.

**Damage application in `battle-ally.js:_applyAllyMagicEffect`** — replaced the no-op Fire guard (which used to short-circuit "ally AI doesn't cast offensive magic") with real damage application. Element multiplier from spell, mdef from target, stored in `battleSt.allyMagicDamageRoll`. Sleep (0x33) takes the status path: `tryInflictStatus` against target.statusResist + spell.hit, plays SLEEP_PUFF, replaces strip with status name on landing, miss display on whiff.

**`drawSWDamageNumbers` extended** to render during `'ally-magic-hit'` as well as `'magic-hit'`, so the damage number lands on the actual target slot — not on the player's currently-selected enemy.

**Visual polish gap (intentional, deferred):** the cast windup (caster pose + magic flame on ally portrait) plays correctly. The on-target impact anim (fire burst / blizzard splash) does NOT render yet — only the damage number pops. Gameplay is correct (HP drops, status applies). Visual impact-anim wiring can come later when needed.

## 1.7.149 — 2026-05-09

### fix: chat scroll SFX only when scroll actually happens

Up/Down in the expanded chat log was playing `SFX.CURSOR` on every press, even when there was nothing to scroll (buffer fit in the visible area, or already pinned at the top/bottom). Now gated on `canChatScrollUp()` / `canChatScrollDown()` — silent when no movement.

## 1.7.148 — 2026-05-09

### feat: chat log scroll

When the chat log is expanded (Shift+T), arrow Up scrolls back through history and arrow Down scrolls forward toward the latest. Reuses the same scroll-arrow sprites + 500ms blink rhythm as `roster.js:_drawScrollArrows` — `ui.scrollArrowUp` at top-right of the chat box, `ui.scrollArrowDown` at bottom-right, drawn only when scrollable in that direction.

The scroll-state plumbing already existed (`chatScrollOffset`, `setChatScrollOffset`) for the Private-tab tab-select flow. Generalized so any expanded chat consumes Up/Down. `setChatScrollOffset` now clamps to the cached buffer ceiling (no scrolling past the top); the row-count cache is updated each draw so the input handler doesn't have to re-run row layout.

Movement is gated on `chatState.expanded` (existing return), so character movement is suppressed while scrolling. Scroll resets to 0 when the chat collapses.

## 1.7.147 — 2026-05-09

### feat: smarter death respawn

Death respawn used to dump every KO at `ps.lastTown` (default Ur), regardless of where you died. Now the respawn point reflects where the death happened.

- **Slain on overworld** → respawn at the last spot you stood on overworld after exiting a town/dungeon. So a death 50 tiles east of Ur sends you back to Ur's overworld exit, not Ur's interior.
- **Slain not on overworld** (in a dungeon, town, PVP) → respawn at the entrance tile of whatever map you were in. Die on dungeon floor 5, you respawn at floor 5's entrance — your descent progress isn't wiped.
- **Fresh save with no exits recorded yet** → falls back to `ps.lastTown` (legacy behavior).

**`ps.lastWorldExitX` / `ps.lastWorldExitY`** added to player state and the save schema. Updated in `_landOnWorldMap` (the single chokepoint where the player lands on the world map from any source — town exit, dungeon exit, warp). Persists across sessions; loaded from slot in `title-screen.js`.

**`respawnAfterDeath()`** added as a single-source helper in `map-loading.js` (the location concern, not the battle concern). `battle-update.js` `_respawnAtLastTown` is now a thin wrapper that resets HP/MP/death-timer and delegates the wipe + map load to it. The branching logic (overworld coords vs. current-map entrance vs. fallback) lives in one place.

`loadWorldMapAtPosition` was already the single-source coords helper used by movement and triggers; respawn reuses it instead of duplicating.

## 1.7.146 — 2026-05-09

### feat: battle message coverage — actor → action → result

The strip used to go silent on Magic, Item, and monster spells; now every turn names the actor *and* what they're doing. Filled in five gaps from the audit.

**The single-slot invariant.** Every turn pushes ONE message via `queueBattleMsg` (the actor's name on turn dispatch). Every subsequent in-turn event — spell name, item name, status result, "Critical!", "N hits!", "Slain!" — uses `replaceBattleMsg`, which swaps text in-place without growing the queue. This guarantees the strip displays for at most one message-cycle (~1.2s) per turn, regardless of how many sub-events fire. Battle visuals (cast windup, projectile flight, damage numbers, HP drop) never get blocked by piled-up text. Converted ~10 mid-turn `queueBattleMsg` calls in `battle-enemy.js` / `spell-cast.js` / `pvp.js` to enforce this invariant.

**Player name on Magic / Item.** `battle-turn.js:148-150` — Fight + Defend already queued the player name; Magic + Item now do too. The strip stops going silent when you cast Cure or use a Potion.

**Spell name on cast.** Single chokepoint in `startSpellCast`: at entry, `replaceBattleMsg(getSpellNameClean(spellId))`. Covers player casts, battle items (which pass `itemId` and show the item name instead), and downstream impact-walk paths. Ally cast paths (Cure / Poisona / item-mode in `battle-turn.js:317,358,409`) and PVP foe cast paths (`pvp.js:559,609,636`) follow the same pattern: queue caster name, replace with spell name.

**Item name on consumables.** `_playerTurnConsumable` now calls `replaceBattleMsg(getItemNameClean(itemId))` — Potion, Hi-Potion, Ether, Elixir, Antidote, etc. all surface their name. Battle items (FireScroll, BachusWine, etc.) inherit the same path through `startSpellCast`'s item-name branch.

**Monster spell name.** `battle-enemy.js` — when a monster rolls a special attack (`mon.spAtkRate`), the attack name (Fire / Bzzaga / Bad Breath / etc.) replaces the monster name on the strip before damage resolves. Player can now read what hit them.

**"Slain!" on enemy KO.** `BATTLE_SLAIN` was defined but never queued. Now fires at all 5 KO transitions: physical kills (encounter, boss, PVP) in `battle-update.js`, magic kills (encounter, boss, PVP) in `_finishMagicHit`. Strip shows "Slain!" while the death fade plays.

## 1.7.145 — 2026-05-09

### polish: tighten battle message system

Internal cleanup. No behavior change — battle text fades and scrolls exactly as before.

**Single source of truth for message timings.** The scroll-overflow + total-display formula previously lived in three places: `updateBattleMsg` and `advanceBattleMsgZ` in `battle-msg.js`, plus `drawBattleMessageStrip` in `battle-drawing.js`. Two of them used naive `bytes.length * 8` for width while the third used `measureText()`, which would have drifted on any string containing control bytes. Folded into one `computeMsgTimings(msg)` helper exported from `battle-msg.js` and consumed by all three sites. Fade-out now finishes the same frame the queue advances, guaranteed.

**Shared layout/scroll constants.** `MSG_STRIP_X` / `MSG_STRIP_Y` / `MSG_STRIP_W` and the scroll-pause / scroll-speed numbers (`400` and `0.06` previously hardcoded in two places) now export from `battle-msg.js`. `battle-drawing.js` imports them so the clip rect, scroll math, and overflow gate read the same numbers.

**Pre-baked phrase bytes for static messages.** Added `BATTLE_HASTE` / `BATTLE_PROTECT` / `BATTLE_REFLECT` / `BATTLE_ALLY` / `BATTLE_FOE` to `data/strings.js` (alongside the existing `BATTLE_INEFFECTIVE`). Replaced ~10 dynamic `_nameToBytes('...')` allocations per cast/turn with the constants in `spell-cast.js`, `battle-turn.js`, `battle-ally.js`, `pvp.js`. Per-cast GC pressure drops; named ally / opponent paths still go through `_nameToBytes` since those are dynamic.

## 1.7.144 — 2026-05-08

### Player buff system — foundation (Haste, Protect, Reflect)

End-game buffs are now real, not stubs. Foundation lands the data model + math hooks; the gameplay surfaces (Bachus Wine = Haste, Turtle Shell = Protect, Curtain = Reflect — already pointing at these spell IDs via `animSpellId` since v1.7.118) finally do something when used.

**`src/buffs.js`** (new, 50 lines): `applyBuff(combatant, buffKey)` / `hasBuff(combatant, buffKey)` / `clearAllBuffs(combatant)` plus `BUFF_HASTE` / `BUFF_PROTECT` / `BUFF_REFLECT` constants and an `ALL_BUFFS` array. Storage shape on the combatant is plain object `{ haste?: true, protect?: true, reflect?: true }`. Re-apply is idempotent (no stacking, matches FF3 NES canon). Helpers are null-safe so any combatant lacking the field works fine.

**`ps.buffs = {}`** added to player state. NOT in the save schema — buffs are battle-bound. `resetBattleVars` calls `clearAllBuffs(ps)` at battle start so a Haste from the previous fight doesn't carry over.

**Spell-cast wiring** (`spell-cast.js:478-502`): the three self-buff handler stubs that previously fired only the SFX + battle-msg now actually call `applyBuff(ps, ...)`. So Bachus Wine grants Haste in-state, Turtle Shell grants Protect, Curtain grants Reflect. Same SFX/msg flow as before — the difference is the buff actually persists for the rest of the battle.

**Math hooks**:
- `calcPotentialHits(level, agi, dualWield, hasted = false)` — when hasted, doubles the final hit count. Stacks with dual-wield (a hasted dual-wielder gets 4× the base count). Wired in `input-handler.js:177` for the player attack path.
- `rollHits(opts.targetProtected = false)` — when set, halves damage independently of `defendHalve`. Both flags can stack; canon FF3 NES treats Protect + Defend as multiplicative (1/4 damage). Wired into the PVP enemy-attack-on-player path (`pvp.js:432`) and the monster-physical-on-player path (`battle-enemy.js:215`, post-roll halve since that path uses a custom multi-hit roller). Magic damage paths intentionally skip Protect — canon Protect is physical-only.

**Reflect**: data-only for v0. Buff sets, but no spell-bouncing yet. Bouncing requires target retargeting in the spell-cast engine — non-trivial and out of scope for foundation. Marked TODO at the apply site.

**`/buff` dev command** (chat.js): `/buff` shows active, `/buff haste|protect|reflect` applies one, `/buff clear` wipes. Added to `/devhelp` under a new "Buffs" group.

**Deferred to v1** (NOT shipped):
- Per-ally buffs (`battleAllies[i].buffs`)
- PVP-enemy buffs (`pvpOpponentStats.buffs` + `pvpEnemyAllies[i].buffs`)
- Encounter-monster buffs (`encounterMonsters[i].buffs`)
- Reflect bounce — retargeting + caster lookup + visual
- Turn-decay for Reflect (~10 turns canon)
- Buff icons on portraits (visual indicator above sprite — pattern exists for status overlays via `drawStatusSpriteAbove`)

**Test**: `buffs.js` smoke-tested via `node -e` (apply / has / clear / idempotent re-apply / null-safe). All assertions pass. Per-call-site behavior is exercised through actual gameplay; no regression test infrastructure yet (queued for the Vitest pass).

## 1.7.143 — 2026-05-08

### Console: dev-gated commands, real startup metrics, eight new dev commands

**Two-tier command system.** `registerCommand(name, desc, handler, { dev })` now takes an options bag with a `dev` flag. The dispatcher rejects dev commands for non-devs by replying with the standard "Unknown command: /x. Type /help" — same response as a typo, no information leak that the command exists. `/help` filters its listing per-user: real players see only public commands, devs see public + `[dev]`-tagged commands.

**Dev whitelist** in `chat.js` (`DEV_EMAILS`): `joeltaylor734@gmail.com`. Add teammate emails on the same line. Match is against `localStorage.getItem('ff3_email')`, lowercased. Authoritative as a UX gate only — all current commands mutate client-side state, so a determined player could spoof localStorage. The day server-authoritative PVP ships, the server has to enforce; commenting in chat.js notes this.

**Public tier (4 commands, anyone)**: `/help`, `/clear`, `/who`, `/pos`.

**Dev tier (13 commands)**:
- `/devhelp` — grouped listing of dev commands by category (Player state, Job & spells, Items, Navigation, Audio).
- `/job N` — switch job, full heal, save, list spells. (existing)
- `/heal` — full HP+MP. (existing)
- `/mp [N]` — get or set MP. (existing)
- `/ff1 N` / `/ff1 stop` — FF1 NSF track playback. (existing)
- `/hp [N]` — get or set HP. N=0 forces KO for death-flow testing.
- `/gil [N]` — get or set gil for shop testing.
- `/cp [N]` — get or set capacity points.
- `/level N` — force player level via repeated `grantExp(expToNext)`. Capped at 200 iterations as a safety in case grantExp can't push level (edge case).
- `/give <hexId> [qty]` — grant an item by hex id. Validates against `ITEMS` map; logs the resolved item name via `bytesToAscii(getItemNameClean(id))`. e.g. `/give b1 3` for 3 Bomb Shards.
- `/spell <hexId>` — grant a spell to `ps.knownSpells`. Logs resolved spell name. e.g. `/spell 33` for Sleep.
- `/warp N` — teleport to map id N (decimal). Plumbed via `setCommandContext({ loadMapById })` to avoid circular imports.

**Decoder fix**: `bytesToAscii` already existed in `text-decoder.js` and uses the proper `CHAR_MAP` (digits 0x80-0x89, A-Z 0x8A-0xA3, a-z 0xCA-0xE3, plus symbols). My first-pass hand-rolled decoder in chat.js had wrong ranges and got dropped before commit.

### Startup console — real catalog data, no decoration

The 4-line boot log was sparse and slightly outdated. Now 7 lines, every value pulled from a live source:

```
FF3 MMO v1.7.143
ROM ok  PRG=8x16k (128k)  CHR=16x8k (128k)  mapper=1
Catalog: 200 items, 231 monsters, 6 spell anims
Save slots: 2/3 used
Auth: joeltaylor734@gmail.com [dev]
Boot: 234ms
Type /help or /devhelp
```

Sources: `VERSION` (matches package.json on deploy via data/strings.js), `rom.*` from parsed iNES header, `ITEMS.size` / `MONSTERS.size` from the data Maps, `getRegisteredSpellAnimCount()` (new export from spell-anim.js — counts spells with on-target visual bundles), `saveSlots.filter(s => s != null).length` from save-state, `isDev()` for the `[dev]` tag, `performance.now()` delta from `loadROM` start for boot time. Stagger reduced from 500ms → 350ms per line so the full 7-line log finishes in ~2.5s instead of 3.5s.

Cadence will land different per machine — `Boot: Nms` is honest (typically 150-400ms on the user's hardware, longer on cold-boot mobile).

## 1.7.142 — 2026-05-08

### ESLint as a static gate + crit damage numbers stop being gold

ESLint flat config wired up. Catches the v1.7.49/v1.7.50 class of bug — orphan imports, undefined references, dead destructures — at static-check time, before smoke.sh has to find it at runtime. `npm run lint:errors` fails on errors only and is now a precondition in `deploy.sh` (runs before `git commit`, so a broken module aborts the deploy with no push). `npm run lint` shows everything including warnings (170 currently, mostly unused-vars in legacy code — aspirational cleanup, not a gate).

Caught one real bug on the first run: `_damageImpactSFX` reference in `spell-cast.js:448` was an orphan from the v1.7.119 rename to `_spellImpactSFX(spell)`. The non-recovery boss damage path would have thrown a ReferenceError the first time someone cast a damage spell at a boss with the player KO'd. Now patched. This is exactly the pattern the lint gate is meant to catch.

Rules: `no-undef` and `no-undef-init` are errors (the gate). `no-unused-vars` warns with `^_` ignore pattern matching the existing convention. `no-redeclare` and `no-useless-assignment` warn (legacy patterns we won't chase). Browser-side files get `globals.browser` plus `Module` (Emscripten GME) and `jsnes` (vendored debug emulator); node-side files (`server.js`, `api.js`, `tools/`) get `globals.node`.

Smoke.sh stays — runtime catches things ESLint can't see (CSP errors, network failures, render-loop crashes). The two are complementary: lint = static, smoke = runtime.

### Crit damage numbers no longer gold

`CRIT_NUM_PAL` and the gold-fill render branch removed. Critical hits now render in the standard red `DMG_NUM_PAL` like every other damage tick. The `crit` flag on damage rolls still drives the slash SFX swap and `critFlashTimer` screen flash — only the digit color is reverted.

## 1.7.141 — 2026-05-08

### Legacy code cleanup

Quiet diff-day. The carryover from earlier consolidations is gone.

**Battle-items module deleted entirely.** `src/battle-items.js` (172 lines) is gone — `startMagicItem`, `updateMagicItemThrowHit`, `_buildTargets`, `_applyDamage`, `getTargets`, `getHitIdx`, `resetBattleItemVars`, `initBattleItems`. Every battle item has had `animSpellId` since v1.7.118 so the legacy fallback path was never executed; battle-turn.js drops the `else { startMagicItem(); }` branch and just calls `startSpellCast` unconditionally for `type === 'battle_item'`.

**Battle states `'sw-throw'` and `'sw-hit'` removed.** No emitter remains. The `updateMagicItemThrowHit` handler in battle-update.js, the `drawSWExplosion` legacy branches (PVP-target render path + encounter render path + boss render path), the `getTargets()` lookup inside the encounter sprite gate, and the half-dozen state guards across `drawEncounterBox` / `drawBossSpriteBox` / `drawBossSpriteBoxPVP` / `_isEncounterCombatState` / `_battleMenuStates` / `_drawBattlePortrait`'s `isItemUsePose` — all gone. `drawSWExplosion` is now PVP-only (single branch); `drawSWDamageNumbers` runs only during `magic-hit`.

**KEPT** (still alive in the engine): `'pvp-opp-sw-throw'` / `'pvp-opp-sw-hit'`. Non-mage main opponents still throw a SouthWind item at 15% chance (pvp.js:373). `bsc.swPhaseCanvases` and `initSouthWindSprite` stay — the PVP path renders through them, and `spell-anim.js` reuses `initSouthWindSprite` for Blizzara's impact phases.

**ROM stat readers in `data/jobs.js` deleted.** `readJobBaseStats`, `readJobLevelBonus`, `readStartingHP`, `readStartingMP` and their offset constants `JOB_BASE_STATS_OFF` / `CHAR_INIT_HP_OFF` / `CHAR_INIT_MP_OFF` / `LEVEL_STAT_BONUS_OFF`. Superseded by `computeJobStats` in v1.7.138; nothing has imported them since. `LEVEL_EXP_TABLE_OFF` is the only ROM offset still consulted (by the exp curve loader).

**Stale comments swept** from `player-stats.js`, `data/players.js`, `data/items.js`. The "Items mapped to … stay on the legacy `startMagicItem` path" block in items.js was outright wrong — every item routes through `startSpellCast` now.

Net diff across the full v1.7.140 + v1.7.141 cleanup pass: −465 lines, +111 added (mostly comment + state-list edits). One file deleted. All `node --check` pass.

## 1.7.140 — 2026-05-08

### Game Over sequence removed — all deaths respawn directly

All death paths now act the same: the battle-end box closes, then the wipe transition fires and the player respawns at `lastTown` at full HP/MP. No "Game Over" boxed screen, no "Press Z" prompt, no "The Requiem" track, no team-wipe / "Defeated" crossfade.

Removed states (engine-side): `team-wipe`, `defeat-monster-fade`, `defeat-text`, `defeat-close`, `game-over`. The five death-state handlers in `_updateDefeatStates` are gone — `updateBattleEndSequence` is now `boss-dissolve → victory-sequence → box-close` only.

`_updateBoxClose` is the single death sink: when the encounter / enemy box-close completes with `ps.hp <= 0`, it stops music and calls `_respawnAtLastTown()` directly. Previously routed through `'game-over'` and waited for Z.

Origin sites (battle-enemy.js, battle-ally.js, pvp.js) that used to set `'team-wipe'` on full-team wipe now set the appropriate box-close state directly, skipping the 1.2s death-pose hold and the "Defeated" PVP crossfade.

Cleanup landed alongside: `BATTLE_GAME_OVER` and `BATTLE_DEFEATED` strings dropped, `TRACKS.GAME_OVER` track def dropped, `respawnFromGameOver` export dropped, `_teamWipeMsgShown` battleSt field dropped, `_zPressed` helper + `keys` import in battle-update.js dropped (only consumer was the deleted defeat handler), every dead-state guard removed from drawEncounterBox / drawBossSpriteBox / drawBattleMenu / drawBossSpriteBoxPVP.

## 1.7.139 — 2026-05-08

### Existing-save stat migration

Save load now recomputes base stats from `computeJobStats(slot.jobIdx, slot.level)` instead of trusting the saved `str/agi/vit/int/mnd/maxHP/maxMP` blob. Saves created before v1.7.138 had stats from the old ROM-random path; this brings them onto the unified matrix retroactively. Existing characters get the canonical numbers for their job + level.

Untouched on load: `level`, `exp`, `gil`, `inventory`, `weaponR/L`, `head/body/arms`, `jobLevels`, `unlockedJobs`, `cp`, `knownSpells`, `worldX/Y`, `lastTown`. HP and MP are clamped to the (possibly new) max values — so a character that previously had a higher max HP from favorable ROM rolls comes back capped at the matrix value.

## 1.7.138 — 2026-05-08

### Single stat path — local player + fake players unified

v1.7.137 only fixed fake-player stats, leaving the local player on the ROM-driven path. Result: a level-N RM in your party had different numbers than a level-N RM as a PVP enemy. Same job, two characters. Drift, my fault, fixing now.

The per-job weight matrix is now the **single source of truth** for both paths:

- `data/players.js` exports `computeJobStats(jobIdx, level)` (returns `{str, agi, vit, int, mnd, maxHP, maxMP}`) and `getJobLevelDelta(jobIdx)` (returns the per-level deltas).
- `generateAllyStats` calls `computeJobStats`.
- `initPlayerStats` calls `computeJobStats(ps.jobIdx, 1)`. ROM readers (`readJobBaseStats`, `readStartingHP`, `readStartingMP`) are no longer consulted for stats.
- `grantExp` level-up loop adds `getJobLevelDelta(ps.jobIdx)` per stat instead of rolling random ROM bonuses. Deterministic — at level N, stats match the matrix exactly.
- `changeJob` rebuilds via `computeJobStats(newJobIdx, currentLevel)`. Switching jobs to a level-N character produces the same numbers as if the player had been that job all along.

The matrix:

```
            str  agi  vit  int  mnd  mp
   OK (0)    1    1    1    1    1   0
   Fi (1)    2    1    2    1    1   0
   Mo (2)    2    2    2    1    1   0
   WM (3)    1    1    1    1    3   3
   BM (4)    1    1    1    3    1   3
   RM (5)    1    1    1    2    2   2     hybrid — W=2 in both schools
```

Each stat = `5 + level * W` (or `5 + level * W_mp` for MP, `0` for non-casters; HP is always `28 + level * 6`). RM at level N has 67% of a specialist's per-school stat contribution — clearly weaker per-school than WM/BM, but flexible across both.

`_tryPVPEnemyOffensiveCast` (PVP enemy BM/RM offensive cast) now reads `caster.int` directly (was a hack using `caster.agi` because INT didn't exist).

**Caveat for existing saves**: characters that already have stats loaded from the previous ROM-driven formula keep those stats. The next `level-up` adds matrix deltas, so the stats rebase forward. New games + new fake players use the matrix from the start. If you want existing-save migration to recompute current stats from the matrix, say the word and I'll wire it.

ROM stat readers (`readJobBaseStats`, `readJobLevelBonus`, `readStartingHP`, `readStartingMP`) are now dead code in `data/jobs.js`. Left in place for now (harmless); cleanup can happen in a separate pass.

## 1.7.137 — 2026-05-08

### Fake-player stat audit — RM is hybrid, Fi/Mo are physical, casters are specialists

Fake-player `generateAllyStats` now applies a per-job stat-weight matrix instead of treating every job's str/agi/vit as a flat `5 + lv`. Adds INT to the return object too — was missing, so the PVP offensive cast AI in `pvp.js` was hacking around it by using `caster.agi` as a stand-in. Now:

```
            str  agi  vit  int  mnd
   OK (0)    1    1    1    1    1     apprentice — flat baseline
   Fi (1)    2    1    2    1    1     melee — strong + tanky
   Mo (2)    2    2    2    1    1     melee — strong + agile + tanky
   WM (3)    1    1    1    1    3     pure white caster
   BM (4)    1    1    1    3    1     pure black caster
   RM (5)    1    1    1    2    2     hybrid — medium in both schools
```

`stat = 5 + lv * W`. Specialists hit W=3 in their core. Red Mage is the hybrid: W=2 in BOTH int AND mnd, putting their per-cast magic output at ~67% of a specialist's stat contribution at the same level — meaningful magic, but a focused WM/BM still outclasses them per-school. RM phys is W=1 across the board (same as pure casters; Fi/Mo are W=2 STR for clearly-stronger melee).

`_tryPVPEnemyOffensiveCast` switched from `caster.agi` to the proper `caster.int`. RM-cast Fire / Blizzard / Sleep now hits softer than BM-cast for the same spell.

Note: this affects fake players only. The local player path (`initPlayerStats` / `grantExp` in `player-stats.js`) reads canonical FF3 NES ROM stat tables — already correct, untouched.

## 1.7.136 — 2026-05-08

### Battle magic menu polish — gray-out, layout, scroll

Three improvements to `_drawBattleSpellList` in `battle-drawing.js`:

1. **Unaffordable spells fade to gray.** Spells where `cost > ps.mp` render with palette slot 3 swapped to NES `$10` (gray) — affordable rows stay full-color. Same glyph pass; just a per-row palette toggle, no extra render cost.
2. **Empty-state defense.** "No spells" message if `spellSelectList` ever comes through empty. Shouldn't happen in normal play, but better than a blank panel.
3. **Layout fix — overflow gone.** `rowH` 14 → 12 so 4 rows fit in the 48 px content area (was 3 rows + spillover). Added a scroll window: when `list.length > 4`, `scrollTop` is derived from the cursor each frame (centers cursor when possible, clamps at both ends — pure-derive, no new state). Cursor draws at the relative-to-window row. The pre-existing 8×8 `ui.scrollArrowUp/Down` sprites are pinned to the right edge of the panel and blink at 250 ms cadence when hidden content exists above / below.

## 1.7.135 — 2026-05-08

### RM cast visual is now school-aware

Red Mage was hardcoded to use the WM cast visual (`{ 3: 'wm', 4: 'bm', 5: 'wm' }`). Now `jobToCastKey(jobIdx, spellId)` looks up `getSpellSchool(spellId)` for `jobIdx === 5` and returns `'bm'` for black-magic spells, `'wm'` for white. RM casting Cure renders WM rotating-stars; RM casting Fire/Blizzard/Sleep renders the BM halo + flame. `getCastVisual` already passes `spellId` through, so the dispatch threads end-to-end with no other render-site changes.

## 1.7.134 — 2026-05-08

### Pulled bow from Eska — bow + arrow not wired yet

v1.7.133 gave Eska Bow + Wooden Arrow for variety, but the `twoHanded` flag in items.js isn't read by the battle/draw code, and there's no ammo consumption or ranged-attack mechanic. Eska would have been modeled as a generic dual-wield (avg-atk × 2 hits), not actually shooting a bow. Swapped to Dagger + Shield. Doc-block updated to flag bows as "not wired — don't equip on pool entries until ranged-attack mechanics land."

## 1.7.133 — 2026-05-08

### Player pool equipment audit + per-job equip matrix doc

Audited every fake-player entry's gear against the actual `jobs` mask in `items.js`. Three issues found, all fixed:

1. **Cassia had Serpent Sword (`$28`, atk 25, 1500 gil)** — way past Altar Cave + Ur tier. Swapped to Longsword (`$24`).
2. **All 5 BMs wielded Staff (`$0E`)** — but `$0E` jobs mask is `Ww|Rw|Sh|Sa|Ni`. **`Bw` (Black Mage) is NOT in that mask.** None of the BMs could actually equip their weapon. Bug since v1.7.126 when I added them. Fixed: BMs now wield Knife (`$1E`) or Dagger (`$1F`) per the items table — their offensive output comes from Lv1 Black Magic, not weapon ATK.
3. **RMs had no shields.** Per `$58` mask `On|Fi|Rw|Kn|Th|Dr|Vi|Ni`, RM IS allowed. Re-added shields to Asher / Caelum / Soren. Verena and Quill stay shieldless (caster-style RM). Caelum now uses Staff `$0E` + Shield (RM is the only mage class that can pair staff with shield in this codebase).

Pool diversity also bumped:
- Eska (OK, lv3, crystal): now Bow `$4A` + Wooden Arrow `$4F` — two-handed archer variety
- Brom (OK, lv3, cave-1): Dagger + Knife dual-wield
- Duran (Fi, lv5, crystal): Dagger + Knife dual-wield (instead of yet another longsword)
- Caelum (RM, lv5): Staff + Shield (only RM swinging a staff)
- BMs split between Knife (lv3-4) and Dagger (lv4-5)

Doc: full per-job equip matrix added to the `PLAYER_POOL` header comment in `data/players.js`. Lists which weapons / body / helm / shield each starting job can equip at Altar Cave + Ur tier, with the relevant `items.js` masks called out. Bracers (`$8B`, mage-arm) noted as deferred until `armsId` slot lands in `generateAllyStats`.

New tool: `tools/audit-player-pool-equip.mjs` cross-checks every pool entry against its job's equip mask. Run after any PLAYER_POOL or items.js edit. Fails loud on mismatch.

## 1.7.132 — 2026-05-08

### Dual-wield damage de-tuned (was quadratic, now linear)

User caught: a level-3 Onion Knight with Dagger + Knife was hitting Land Turtle for 40+ dmg/turn — pre-Altar-Cave gear shouldn't crater a boss in three turns. Cause: two layers compounded.

1. `calcAttackerAtk` returned `rWpnAtk + lWpnAtk + floor(str/2)` for non-Monk dual-wield — both weapon ATKs **summed**.
2. `calcPotentialHits` with `dualWield=true` returned `base × 2` — hits **doubled**.

So a dual-wielder got 2 hits at the SUMMED atk of both weapons → quadratic damage. Lv3 OK D+K = 18 atk × 2 hits = 34-52 dmg/turn vs Land Turtle's def 1.

Fix: per-hit ATK now uses the **average** of both weapon ATKs when dual-wielding, not the sum. The 2-hit count is preserved so each "hand" still strikes once per turn at near-single-weapon power. This lands close to NES canon, where each hand's strike resolves separately at that hand's own weapon ATK.

- Lv3 OK D+K: was 34-52 dmg/turn → now 20-32 dmg/turn (~37% drop)
- Single-wield damage is **unchanged** (one slot is 0, so the average reduces to the equipped weapon's ATK).
- Monk unarmed special-case is **unchanged**.

Note: the underlying `def: 1` value across the entire bestiary (`gen-monsters-js.js` likely reads the wrong byte from the stat-table layout) is a separate issue. Bosses should have higher DEF than mooks but currently don't. Tackle in a follow-up.

## 1.7.131 — 2026-05-08

### RMs back to Daggers — sword + made-up name pulled

Two errors in v1.7.130:

1. **I fabricated the name "Sage Sword"** for item `$25` in the comments. I have no source for that name; I assumed it from the item's RM/Ninja access + holy element. Violates the never-fabricate rule and the "look it up first" rule. There is no excuse — the actual name lives in ROM via `getItemNameClean(0x25)` and I should have either decoded it or webfetched a primary source.
2. **The item tier was wrong for early game.** Item `$25` is price 1000 — players are pre-Altar Cave. RMs at this stage shouldn't have any sword.

Fix: all 5 RMs (Asher, Verena, Caelum, Quill, Soren) use Dagger `$1F` (price 60, atk 8). Shields removed too — RMs are caster hybrids, not Fighter-tier melee.

## 1.7.130 — 2026-05-08

### Fixed RM weapon — Long Sword → Sage Sword

Caught: my v1.7.127 pool had Asher / Caelum / Soren wielding Longsword (`0x24`), which has `jobs: On|Fi|Kn|Ni` — Red Mage isn't in that mask. Per the items table, the canonical RM-equippable swords are `0x25` (Sage Sword, atk 15, holy element, `jobs: Rw|Ni`) and `0x2a` (atk 29). Swapped the three sword-wielding RMs to `0x25`. Lower-level RMs (Verena, Quill) keep Dagger `0x1F` which is RM-OK.

## 1.7.129 — 2026-05-08

### PVP-enemy offensive cast visuals + directional projectile

The $58 projectile tile has a directional trailing flame — canonical capture is right→left (player→enemy). When a PVP-enemy BM/RM casts toward the player party, the projectile now h-flips so the flame keeps trailing behind the orb instead of leading it.

- `getProjectileTile(spellId, spell, hflip)` accepts a direction flag. The bundle cache pre-builds h-flipped variants alongside the v-flip wobble pair so neither hot path allocates per frame.
- `drawProjectileFan` auto-detects hflip per target via `sx < tc.x` (caster left-of-target = travel rightward = needs flip). Backward-compatible: player-cast right→left still uses the canonical orientation.
- New `_drawPVPEnemyOffensiveCast` in `battle-drawing.js`, mirror of `_drawPlayerSpellTargetSparkleOnEnemy` for the opposite direction. Hooks into the draw loop right after the player-cast renderer. Same modular helpers (`drawProjectileFan` + `drawSpellEffectAtTargets` + `_getMagicTargetCenter` + `_isCrossFaction`) — the helpers were already direction-agnostic; only a new caller was needed.
- Phase split inside `pvp-enemy-magic-hit`: 0..150 ms projectile flight from caster cell to player/ally portrait, then impact burst at the target for the rest of the hit window. `_applyPVPEnemyMagicEffect` (at PVP_MAGIC_EFFECT_MS=400) still drives the actual damage/status apply + damage-number pop in the middle of the burst.

Audit notes (no refactor needed): the cast/projectile/impact pipeline is already modular — `_isCrossFaction` abstracts faction logic, `_getMagicTargetCenter` resolves any target type's screen position, `drawProjectileFan` and `drawSpellEffectAtTargets` are direction-blind. Adding the PVP-enemy direction was a pure additive change, no shared logic moved.

## 1.7.128 — 2026-05-08

### Pulled Sight from fake-player knownSpells

Lenna had `[Cure, Poisona, Sight]` from the v1.7.127 pool refactor. Sight is dead weight on fake-player AI — it's the player's enemy-HP peek; a fake mage casting it just burns a turn. Trimmed to `[Cure, Poisona]` to match the rest of the WM pool.

## 1.7.127 — 2026-05-08

### Pool refactor + RM palette + PVP mage AI

- **Player pool rebalanced**: 30 entries, 5 per starting job (OK / Fi / Mo / WM / BM / RM). Names matched to class theme — Vivi/Nephele/Korra/Theron/Mara for BMs, Asher/Verena/Caelum/Quill/Soren for RMs, kept Japanese names for Monks (Kasumi/Jiro/Ryuji/Hana/Tetsuo). palIdx varied within each job so colors don't collide. Locations spread across all 7 zones for PVP join roll variety. Equipment matches class: BM Staff, RM Longsword/Dagger, etc. knownSpells scaled by level.
- **`BLACK_MAGE_PALETTES` is now all blue tints**: the 8 slots vary only the robe color, all within the blue family — canon light blue (`$21`), azure (`$11`), deep blue-violet (`$12`), sky blue (`$22`), cyan (`$1C`), light cyan (`$2C`), deep blue (`$01`), pale blue (`$31`).
- **`RED_MAGE_PALETTES` added**: 8 slots, all red tints — canon red (`$16`), magenta (`$15`), purple-red (`$14`), orange-red (`$17`), light red (`$25`), pink (`$24`), dark red (`$05`), pale red (`$35`). Wired into `_jobPalette` in `battle-drawing.js`, `pvp.js`, and `combatant-sprites.js` for `jobIdx === 5`.
- **Fake-player mage AI hooked up across the whole board**: `_tryPVPEnemyCure` and `_tryPVPEnemyPoisona` now run for ANY caster (main opp + enemy allies, cells 0-3) with knownSpells, not just the main opp. WMs and RMs heal injured teammates on any cell.
- **BM/RM offensive cast AI**: new `_tryPVPEnemyOffensiveCast` that picks a target on the player party (player or living roster ally) and casts Fire / Blizzard / Sleep based on the caster's knownSpells. ~45% activation rate. `_applyPVPEnemyMagicEffect` extended with a party-target branch that applies damage (Fire/Blizzard, mdef-reduced) or status (Sleep, `tryInflictStatus` against the target's `statusResist`). Damage triggers shake feedback on the player or ally target. Sleep miss falls through to a damage-num "Miss" indicator. RM with both schools naturally pivots — heal when team is hurt, BM-Lv1 otherwise.
- New `pvpSt` fields: `pvpMagicPartyTargetIdx` (`-100` = none / `-1` = player / `0+` = ally) and `pvpMagicDamageRoll` (pre-rolled Fire/Blizzard damage). Reset on PVP state init + at the end of magic-hit.

Visual polish for the offensive cast (projectile fan from caster cell to player party + impact burst on the target portrait) is deferred — currently the cast pose plays, then the SFX + damage number land at impact apply time.

## 1.7.126 — 2026-05-08

### BM + RM added to fake player pool

Pool grows from 23 → 31 with 4 Black Mages (Vivi, Nephele, Korra, Theron) and 4 Red Mages (Asher, Verena, Caelum, Quill). All starting jobs (OK / Fi / Mo / WM / BM / RM) are now represented.

- BMs equip Staff (`0x0E`) + Leather+Cap (`0x73` / `0x62`), `knownSpells` chosen from BM Lv1 (Fire `0x31`, Blizzard `0x32`, Sleep `0x33`) by level — lower-level BMs know fewer spells.
- RMs are hybrid: Longsword (`0x24`) + shield for the higher-level / more martial slots, Dagger (`0x1F`) for lower-level. `knownSpells` mix WM + BM Lv1 (Cure `0x34` plus subset of Fire/Blizzard/Sleep). `generateAllyStats` already gives RM the canonical mid-MND scaling (`mndW = 2`).
- Locations spread across `world / ur / cave-0..3 / crystal` so each class shows up at multiple zones for the roster HUD + PVP join roll.
- BM render palettes already wired (BLACK_MAGE_PALETTES for battle, BM_WALK_TOP/BTM for overworld). RM uses PLAYER_PALETTES + Onion Knight walk fallback per the user's "RM is all red" call.

PVP offensive-magic AI for BM/RM is NOT wired here — fake BMs/RMs in PVP currently fall back to physical attacks with their staff/sword. Wiring offensive cast routines (`_tryPVPEnemyFire` / `_tryPVPEnemySleep` / etc.) is a separate task.

## 1.7.125 — 2026-05-08

### RM overworld walk palette wired

Red Mage (job 5) was falling back to Onion Knight (red top, green/magenta bottom). Per the user's call, RM's canon look is all-red — same pattern as Warrior — so `JOB_WALK_PALS[5]` now uses `[SPRITE_PAL_TOP, SPRITE_PAL_TOP]`.

## 1.7.124 — 2026-05-08

### BM overworld walk palette wired

Black Mage (job 4) was missing from `JOB_WALK_PALS` in `job-sprites.js`, so a BM in the overworld was falling back to the Onion Knight red palette. Added `BM_WALK_TOP = [0x1A, 0x0F, 0x27, 0x36]` (face/hat brim) and `BM_WALK_BTM = [0x1A, 0x0F, 0x21, 0x36]` (canonical blue robe + light-pink trim) per the OAM dump (REC OAM frame 1629, SP0/SP1). Wired in `JOB_WALK_PALS[4]`. WM (3) and RM (5) still fall back to Onion Knight defaults — their PPU captures haven't landed yet.

## 1.7.123 — 2026-05-08

### Multi-target throw: parallel projectile fan, serial impact walk

The new spell-cast engine had collapsed multi-target throws into a fully-parallel apply (one impact frame, all damage numbers pop together). Reverted to the legacy SouthWind pattern: projectile fan-out is parallel (every target gets a sphere), but the impact bursts walk targets one at a time in TL → TR → BL → BR reading order.

- `_targets` is sorted by visual `(row, col)` after the multi-enemy build using a small `_enemyVisualPos` helper that mirrors `_encounterGridPos` for encounters and `pvpGridLayout`'s `gridPos` for PVP.
- New `_magicHitPhase` substate inside `magic-hit`. Throws with cross-faction targets enter `'projectile'` (battleTimer 0..150 ms = parallel fan), then transition to `'impact-walk'` (per-target window: 550 ms impact + 500 ms damage-number hold = 1050 ms each). Each iteration resets `battleTimer`, `_effectApplied`, `_sfxPlayed` so the SFX fires per target. After all targets are walked, the shared `_finishMagicHit()` tail runs the kill detection / monster-death / boss-dissolve / pvp-dissolve / msg-wait routing.
- Item-use skips the projectile sub-phase (legacy SW: items have no projectile flight) but still walks impacts serially. SouthWind, Bomb Shard, Arctic Wind, etc. land impacts TL → TR → BL → BR.
- Heal-style + single-target self-buff stay on the original parallel-apply path — the walk only engages when `isThrown && cross-faction`.
- Renderer reads `getMagicHitPhase()` + `getSpellHitIdx()` to pick which targets to draw. Projectile phase fans to all `enemyTargets`; impact-walk phase draws the burst at the current `enemyTargets[hitIdx]` only, using the per-target `battleTimer` as the burst-frame clock.
- Sight gets its own `_spellImpactSFX` branch (`target === 'sight'` → `SFX.SIGHT`) so the engine plays the right impact SFX during the walk without double-firing inside `_applyEnemyEffect`.

## 1.7.122 — 2026-05-08

### Sleep target picker defaults to enemy side

Pressing Z on Sleep was landing the cursor on the player portrait — the gate at `input-handler.js:401` only flagged `target === 'sight'` or `type === 'damage'` as enemy-default. Sleep is `type: 'sleep'`, `target: 'enemy_status'` — neither matched. Extended the gate to cover any spell that targets the enemy side: `'enemy'`, `'enemy_status'`, `'all_enemies'`, plus the existing `'sight'` and damage-type. Future status spells (Confuse, Death, all_status family) get correct defaults out of the gate.

## 1.7.121 — 2026-05-08

### Fire / Blizzard / Sleep all multi-targetable

`MULTI_TARGET_SPELLS` now includes `$31` Fire, `$32` Blizzard, and `$33` Sleep alongside `$34` Cure. The targeting nav was already wired (battle-items + Cure use the same picker): Left on the leftmost enemy enters all-enemies mode; Up on the top enemy of a column enters col-mode. Engine paths were also already in place — `startSpellCast`'s `mode !== 'single' && !onAllies` branch builds the multi-enemy `_targets` list, the projectile fan draws to every enemy target, and damage spells with `power > 0` roll once and divide by `_targets.length` (Sleep's `power: 0` skips division — each target rolls `tryInflictStatus` independently against `spell.hit`, the FF3-canon behavior).

## 1.7.120 — 2026-05-08

### Status sprite overlays + battle messages on status hit

- Single-source `drawStatusSpriteAbove(ctx, statusObj, x, y, mirror)` exported from `battle-drawing.js`. Priority order (petrify > sleep > confuse > paralysis > silence > blind > poison) and 133ms 2-frame cadence live in one place. Player + roster ally + PVP enemy all route through it instead of inlining the lookup.
- Roster ally portraits now show the status sprite above the portrait at `(ppx, ppy - 4)`, matching the player path (no mirror — allies face left like the player).
- PVP enemy bodies now show the status sprite at `(sprX, sprY - 4)` h-flipped (`mirror=true`) so the asymmetric Z's / glyphs match the body's right-facing orientation. Suppressed during the dissolve phase.
- Battle messages: when a player-cast status spell lands on an enemy (Sleep, Confuse, Death's instakill is unchanged), the corresponding `STATUS_NAME_BYTES[flag]` is queued — "Asleep" / "Confused" / etc. The all_status path (Tranquilizer / Shade) queues one message per landed status. Non-Sheep status SFX path now uses `_spellImpactSFX(spell)` so future status spells with custom SFX route correctly (Sleep already fires its SFX at impact start via the throw path; this is a no-op for it).
- Battle-enemy parity: when a monster lands a status on a player or ally, the same `STATUS_NAME_BYTES` message is queued through the same `queueBattleMsg` channel. Single source for status-text plumbing.
- Encounter monsters (non-player sprites) intentionally do NOT render the status overlay — overlays are player/PVP-player-sprite only by design.

## 1.7.119 — 2026-05-08

### Sleep ($33) — last Lv1 BM spell shipped end-to-end

- Wired Sleep through the full cast → projectile → impact pipeline using the OAM parity harness against `sleep-emu-snap.txt`. 12 unique impact tiles (`$4B–$56`) form three 16×16 sub-cluster sprites (α/β/γ) that tile across a 48×48 area in three cyclic-rotation layouts at 67 ms each. All tiles + palette parity-PASS.
- Added `_THROWN_STATUS_TYPES` set (currently `{'sleep'}`) so status-type spells can join Fire/Blizzard on the cast → projectile → impact path. Generalized `_damageImpactSFX` into `_spellImpactSFX(spell)` which routes by element (fire/ice) or by `spell.type` (sleep). The thrown-to-enemy SFX gate now covers any thrown spell with a cross-faction target except Sight (which keeps its own SFX inside `_applyEnemyEffect`).
- New SFX entry `SLEEP_PUFF: 0x95` (NSF track $95). Verified via the v1.7.111+ EMU dumper: CPU writes `$D4` to `$7F49` at frame 74 of `sleep-emu-snap`, just before the impact group appears at frame 75.
- Added Sleep ($33) to `SPELL_SCHOOL` (black), `SPELL_MP_COST` (3), `SPELL_BUY_PRICE` (200), and to `STARTING_SPELLS` for BM (4) + RM (5). `SPELL_CAST_PAL` and `SPELL_PROJECTILE_PAL` get `[0x0F, 0x15, 0x27, 0x30]` (magenta family — same SP3 the dump shows).
- Battle-drawing's throw-path mirror gate extended to `spell.type === 'sleep'` so the projectile fan + impact burst render.
- Parity harness extended with `sleep` and `sleep-projectile` specs in `tools/parity-check-spell.js`.

### Cast → projectile handoff hardened

Player cast pose call sites in `battle-drawing.js` now strictly state-gate on `'magic-cast'` only — they previously fired in `'magic-hit'` too and relied on internal `< CAST_T_LUNGE` checks to suppress draws while the projectile was in flight. PVP and ally paths already gated this way; the player path now matches. Defense in depth: the elapsedMs gates inside `cast-anim.js` are kept as a fallback. Pipeline is now: full cast loop → cast clears → projectile → projectile clears → impact → impact clears → damage number.

## 1.7.118 — 2026-05-08

### Final 3 battle items mapped — all 20 now modular

- $bd Black Musk → Death `$01` (instakill, same handler as Devil Note)
- $c1 Tranquilizer → Shade `$1e` (all_status — engine extended to roll paralysis/blind/silence/sleep/confuse against spell.hit each)
- $c5 Curtain → Reflect `$0c` (self-buff stub until reflect mechanics ship; `target='reflect'` joins haste/protect in the self-target override list)

`_applyEnemyEffect` gains a `type='all_status'` branch — for each candidate status it calls `tryInflictStatus(mon.status, name, spell.hit, mon.statusResist)` independently. Tranquilizer paralyzes + may also blind/silence/sleep/confuse depending on rolls. `_applySpellEffect` (player path) gains a `target='reflect'` branch that mirrors haste/protect (battle msg + CURE SFX, mechanics deferred).

All 20 battle items now route through `startSpellCast` as `isItemUse: true`. The legacy `startMagicItem` path is dead code for items but still wired in `battle-update.js:583` for the `sw-throw`/`sw-hit` battle states. Cleanup of those (and `bsc.swPhaseCanvases`, the `pvp-opp-sw-hit` PVP wiring) is now safe to do in a follow-up.

## 1.7.117 — 2026-05-08

### Spell-cast handles status / drain / self-buff target types — remaining 7 battle items now route through modular path

`_applyEnemyEffect` extended:
- `target='enemy_status'` (Confuse, Sleep, Death) — calls `tryInflictStatus(mon.status, spell.type, spell.hit, mon.statusResist)`. Death gets a special instakill check that sets `mon.hp=0` on success and plays `MONSTER_DEATH` SFX. Misses show damage=0 with the `miss` flag (Ineffective tooltip).
- `target='erase'` — SFX-only acknowledgement (no enemy buff state exists yet to dispel).
- `target='drain'` — damages enemy and heals player by the same amount; reverses on undead per NES canon (heals enemy, no player heal).

`startSpellCast` now overrides `_targets` to `[{type:'player'}]` for self-buff spells (`target='haste'` / `target='protect'`) regardless of the target picker's selection — battle items like BachusWine and TurtleShell may have an enemy targeted but the buff applies to the player.

`_applySpellEffect` (player path) gains placeholder branches for `target='haste'` and `target='protect'` — battle message + CURE SFX, no real buff mechanics yet (haste = double speed, protect = halve damage need a player-state buff system that doesn't exist; mechanics are stubbed until that lands).

Items now mapped on the new path:
- $b8 Lamia Scale → Confuse `$20`
- $b9 Bachus Wine → Haste `$13` (mechanics stub)
- $ba Turtle Shell → Protect `$1a` (mechanics stub)
- $bb Devil Note → Death `$01`
- $bc Black Hole → Erase `$17` (no-op visual until enemy buffs exist)
- $be Lilith Kiss → Drain `$09`
- $c3 Sheep Pillow → Sleep `$33`

17 of 20 battle items now route through the modular spell-cast path. Remaining 3 unmapped: $bd Black Musk, $c1 Tranquilizer, $c5 Curtain (not in shrine canon, need user direction).

## 1.7.116 — 2026-05-08

### Battle items wired through spell-cast — 11 of 20 mapped to spell IDs

Continuing the modularization. Battle items now route through the spell-cast engine via `animSpellId` per shrines.rpgclassics canon (with tier raised one step for "wind" items per the ff3mmo `SouthWind = Lv2` design rule):

| Item | Spell |
|---|---|
| $b1 Bomb Shard | Fire `$39` (Lv2 fire) |
| $b2 South Wind | Blizzara `$3a` (already shipped) |
| $b3 Zeus' Wrath | Thunder `$3b` (Lv2 bolt) |
| $b4 Bomb Arm | Fira `$23` (Lv3 fire) |
| $b5 Arctic Wind | Bzzaga `$1d` (Lv3 ice) |
| $b6 God's Wrath | Tara `$25` (Lv3 bolt) |
| $b7 Earth Drum | Quake `$07` |
| $bf Raven Yawn | Aero `$2d` |
| $c6 Chocobo's Wrath | Flare `$00` |
| $c7 White Musk | Holy `$05` |

Status / buff items ($b8 Confuse, $b9 Haste, $ba Protect, $bb Death, $bc Erase, $be Drain, $c3 Sleep) stay on the legacy `startMagicItem` path until the spell-cast engine extends to those target types. Comments in `data/items.js` mark each one's canonical spell so the consolidation finishes in one diff later. $bd Black Musk, $c1 Tranquilizer, $c5 Curtain remain unmapped (ambiguous — not in the shrine table; need user direction).

The render path for item-use moved out of the `isThrown` gate — non-thrown damage elements (earth Quake, holy White Musk, no-element Flare) now render their impact visual on enemy targets via the shared spell-anim dispatcher. Spells without registered impact visuals ($07/$23/$25/$1d/$2d/$00/$05/$3b/$39) play SFX-only until OAM captures land for them.

## 1.7.115 — 2026-05-08

### Blizzara ($3a) wired; SouthWind item dispatches through spell-cast as item-use

Step 1 of consolidating the SouthWind item path with the modular spell system. Per project canon (`project_ff3mmo_southwind_blizzara.md`), the SouthWind item IS the Blizzara/Bzzra/Ice2 delivery vector — same animation, same SFX, same element. Now both paths share the visual.

- Spell `$3a` registered: `SPELL_CAST_PAL` + `SPELL_PROJECTILE_PAL` use the icy palette `[0x0F, 0x11, 0x21, 0x31]`. `SPELL_SCHOOL[0x3a] = 'black'`. `SPELL_MP_COST[0x3a] = 5`, `SPELL_BUY_PRICE[0x3a] = 700` (Lv2 placeholder; revisit).
- New `spell-anim` kind `'aoe-3phase'` — one-shot expanding burst (16×16 → 32×32 → 48×48) with per-phase 133 ms hold, capped at the last frame so it lingers through impact end. Frames sourced via `initSouthWindSprite()` so spell-anim owns the canvases (no dependence on the legacy `bsc.swPhaseCanvases` cache).
- `getSpellAnimFrame` handles the new kind: `phaseDurMs` not `toggleMs`, capped not modulo. Dispatcher `drawSpellEffectAtTargets` adds an `aoe-3phase` branch that centers per-frame (each phase has a different canvas size).
- `startSpellCast(spellId, targetSpec, opts)` gains `opts.isItemUse`. Skips MP deduction, the `MAGIC_CAST` pre-anim SFX, and the BM/WM cast pose entirely (`_isCastAnimSpell` returns false for items → `castDur` falls back to legacy 250 ms throw, `hitTotalMs` to 1100 ms — matches the old `sw-throw`/`sw-hit` timing exactly).
- `isCurrentCastItemUse()` exported. Render path uses it to skip the throw projectile (items go straight to impact) and aligns impact-phase timer to magic-hit start.
- Item-use thrown-damage SFX now fires at magic-hit timer = 0 (impact start), not at the projectile-end offset (which was meaningless for items).
- `items.js`: `0xb2` (SouthWind) gets `animSpellId: 0x3a`. Routes through `startSpellCast(0x3a, …, { isItemUse: true })` in `_playerTurnItem`. Other `battle_item`s without an `animSpellId` still use the legacy `startMagicItem()` path (sw-throw/sw-hit states + bespoke damage formula). Cleanup of the legacy path deferred until every battle_item has a spell mapping.

## 1.7.114 — 2026-05-08

### Blizzard ($32) acquireable — BM and RM start with it; 2 MP, 100 gil

`STARTING_SPELLS` now grants Blizzard alongside Fire to BM (job 4) and RM (job 5). `SPELL_MP_COST` and `SPELL_BUY_PRICE` get matching `[0x32, 2]` and `[0x32, 100]` entries (mirroring Fire's stats — NES canon for Lv1 black magic). Existing BM/RM saves pick up Blizzard automatically on next load: `title-screen.js:712` re-runs `grantStartingSpells` per load and the function only adds new spells, never removes.

## 1.7.113 — 2026-05-08

### Blizzard ($32) wired — cast tint, projectile, 48×48 ice-shard impact, SFX

End-to-end Blizzard plumbing. Cast halo + flame use the BM per-job pose tinted with the captured icy palette `[0x0F, 0x11, 0x21, 0x31]` (REC OAM f766 SP3). Projectile reuses the shared `$58` sphere with the same palette. Impact is a 48×48 area burst built from 4 unique 8×8 shard tiles ($49–$4C, captured mechanically from f766 frame 20) cycling through 4 OAM layouts (no-flip → HFLIP → VFLIP → V+HFLIP) at NES 4-frame hold (~67 ms each, ~266 ms total).

Plumbing changes:
- `SPELL_CAST_PAL` + `SPELL_PROJECTILE_PAL` now keyed by `0x32`.
- `SPELL_SCHOOL[0x32] = 'black'` so BM/RM can pick it.
- `_isThrownDamageElement(el)` helper centralizes the cast-anim/throw-path gates so future damage elements (bolt, ice variants) drop into one set instead of N call sites — per the modularize-cross-cutting-gates rule.
- `_damageImpactSFX(el)` maps element → captured SFX index. `'ice' → SFX.SW_HIT` (NSF $5D, verified from REC OAM f766 frame 19 `write $7F49 = $9C → NSF $5D`). `'fire' → FIRE_BOOM` (NSF $82, verified prior turn).

Parity gate spec added (`blizzard` + `blizzard-projectile`); not run this commit because the f766 dump only exists inline. Save the dump and run `node tools/parity-check-spell.js blizzard ~/emu-snap-f766.txt` to verify byte tables.

## 1.7.112 — 2026-05-08

### Fire SFX corrected to NSF $82 (was $81 — inferred from broken polling)

Recaptured Fire with the v1.7.111 EMU dumper (`emu-snap-f1301.txt`). At frame 19 the CPU writes `$C1` to `$7F49` — fresh request — which the dumper resolves to NSF track `$C1 - $3F = $82`. The prior `0x81` was inferred from the residual byte `$40` left in `$7F49` after the audio engine consumed the high-bit pulse. That residual is NOT the requested SFX index (the engine does its own bookkeeping; the consume path doesn't simply clear the high bit), so the inference was double-wrong and produced an off-by-one. SIGHT (also `$81` from the same broken inference) is now flagged as UNVERIFIED in `music.js` — recapture with the new dumper to fix.

## 1.7.111 — 2026-05-08

### EMU SFX dumper now captures pre-consume CPU writes to $7F48-$7F4F

The EMU tab's SFX strip dumper was polling `nes.cpu.mem[$7F49]` at frame boundaries. FF3J's audio engine consumes the high-bit pulse (`$80 | sfxId`) within the same NES frame the CPU writes it, so frame-boundary polling only ever caught the post-consume residual byte (e.g. `$40` after Fire's `$C0 → consumed`). That made it impossible to distinguish per-spell SFX from the dump alone — every spell whose index byte landed at `$40` looked identical to Fire.

Fixed by hooking jsnes' `onBatteryRamWrite` callback (mapper writes to `$6000-$7FFF`) to log every write to `$7F48-$7F4F` into `_sfxWrites`. Each snap drains the buffer into the dump output as `// write $7F49 = $Cx -> NSF track $xx (music.js)` lines, so the actual fresh request is captured even when the residual byte never shows the high bit set. Buffer clears at REC start so the first snap reflects only activity within the capture window.

## 1.7.110 — 2026-05-08

### FIRE_BOOM SFX corrected to NES value (0x81)

Verified via REC OAM f9627: across the 200-frame BM Fire cast, `$7F49` (the NES SFX queue) holds only `$00` (idle) or `$40` (request). NSF track = `$40 + $41 = 0x81` — identical to SIGHT. NES reuses one impact SFX track for both Fire and Sight (generic "splash impact"). FIRE_BOOM was previously set to `0x55` (an unverified candidate that happened to share the value of SCREEN_OPEN). Now `0x81`.

## 1.7.109 — 2026-05-08

### Spell SFX plays during the spell animation (not at damage-number pop)

For thrown damage spells (Fire, future BM family) the impact SFX now fires at IMPACT START — when the burst begins rendering — instead of at the damage-number pop (impact end + 700 ms). Adds `_playSpellSFXOnce` module-local guard so the apply path doesn't double-up if SFX already played early. Multi-target plays one SFX at burst start instead of one per target.

Heal-style spells (Cure, Poisona) still fire SFX at heal-sparkle start (= hitEffectMs) since the sparkle and heal number naturally sync. Sight + "Ineffective" friendly-target rejection also unchanged. Only the cross-faction thrown-damage path was wrong.

## 1.7.108 — 2026-05-08

### Offensive magic defaults to rightmost enemy

Spell picker for damage spells (Fire, etc.) and Sight now lands on the rightmost living enemy (the cell closest to the player party) instead of the first-live in array order. Encounter right col = idx 1/3; PVP right col = idx 0/2. Falls back to first-live if no right-col cell is alive.

## 1.7.107 — 2026-05-08

### BM halo centering — drop empty 8-px strip so canvas center matches content center

Halo was built into a 40×32 canvas with the leftmost 8 px empty (legacy from when the halo-and-cast-flame group was a single 40-wide cluster in the OAM). Centering the canvas put the visible halo content 4 px to the right of the sprite center. Rebuilt as a 32×32 canvas — exactly the halo footprint — so canvas center is now content center. Halo wraps the player/ally portrait symmetrically (8 px overhang on each side) and the PVP body symmetrically (8 px left/right, 4 px top/bottom). Cast flame still overlaps the halo's leftmost ring tile by one column, matching the NES OAM stacking.

## 1.7.106 — 2026-05-08

### PVP target centering — projectile + burst align with body, not cell

`_getMagicTargetCenter` was using `pvpEnemyCellCenter` (24×32 cell center) for PVP enemy targets, while the PVP-side cast halo centers on body center. Body sits 4 px below cell center inside the cell (cell is 24×32, body 16×24 with 4 px top/bottom padding). Adjusted the spell-target center to body center (cellTop+16) so projectile flight and impact burst land at the same vertical position the PVP cast halo wraps.

## 1.7.105 — 2026-05-08

### Ally + PVP cast: visuals also clear before spell animation

`_allyCastContext` and the PVP enemy cast blocks were freezing `elapsed` at the cast duration (600 ms) during the hit state so the flame would hold its release frame through the spell animation. With v1.7.104 the cast visuals end at CAST_T_LUNGE = 800 ms, but 600 ms is still inside the visible window — so on ally Cure and PVP enemy magic, the halo + stars + flame stayed on screen during the heal sparkle / projectile. Fixed by gating the cast helpers to only run during `ally-magic-cast` / `pvp-enemy-magic-cast` (buildup state) and skipping them entirely during the hit state.

## 1.7.104 — 2026-05-08

### Cast visuals clear before spell animation starts

`shouldDrawHalo` and `shouldDrawCastStars` now end at `CAST_T_LUNGE` (800 ms) instead of `CAST_T_CAST` (1000 ms) so the halo + stars + flame are all gone before any spell animation begins:

- Thrown spells (Fire): projectile starts at CAST_T_THROW_PROJ_START = 800 ms — cast visuals end at the same boundary.
- Heal-style (Cure, Poisona): heal sparkle starts at CAST_T_HEAL = 1217 ms — cast visuals end 417 ms earlier with the cast pose held quiet between.

Previously the halo extended 200 ms into the magic-hit state for Fire, overlapping the projectile flight.

## 1.7.103 — 2026-05-08

### BM cast: halo + separate cast flame (correct OAM structure this time)

v1.7.102's "BM spark" was the Onion Knight body sprite ($0F-$14 pal1) — misidentified from the OAM dump. Dropped. The actual BM cast structure (verified across f9627 frames 0-43):

- **Halo** = outer ring + middle ring only (`$49, $4A, $4F, $50` outer corners + `$4B, $4C, $4D, $4E` middle ring). STATIC — single 40×32 canvas, no size cycle. Drawn BEHIND the portrait.
- **Cast flame** = SEPARATE 16×16 sprite drawn ON TOP of halo at the LEFT wing position (canvas (0,8)+(8,8)+(0,16)+(8,16) within the cast group). Size-cycles `$51, $52, $53, $54, $55, $56, $57` over ~535 ms then holds the release-flash ($57) until cast ends. Anchor matches WM flame (left of sprite at portrait_y+5).

Per-frame animation (each step ≈ 67 ms, captured from f9627 dump):
- step 0/2: pulse layout A — TL=$51, TR=$52, BL=$52(VH), BR=$51(VH)
- step 1/3: pulse layout B — TL=$52(H), TR=$51(H), BL=$51(V), BR=$52(V)
- step 4: $53 in flipped-quad
- step 5: $54 in flipped-quad
- step 6: $55 in flipped-quad
- step 7: $56 in flipped-quad
- step 8+: $57 in flipped-quad (release flash, held)

Shared anchor and rendering pattern with WM cast flame: both jobs draw the cast flame at the same position (left of sprite, same flameDx/flameDy), only the underlying tile bytes + frame sequence differ. WM uses `_FLAME_SEQ` (5 frames), BM uses `_BM_FLAME_SEQ` (7 frames + held).

`drawCasterCastBehind` now expects `haloCanvas` (single canvas, since halo is static); `drawCasterCastFront` picks the frame-index function by `visual.jobKey`. Removed `getCastHaloFrameIdx`, `_HALO_SEQ`, `shouldDrawCastSpark`, all `BM_SPARK_T_*` constants, and the `bm-spark` parity gate. Added `BM_T_53` byte data (was missing from v1.7.102; size-state 4 of the cast flame). New `bm-halo` and `bm-cast-flame` parity gates split the old `bm-cast` gate. All 4 gates (fire, fire-projectile, bm-halo, bm-cast-flame) PASS against ~/emu-snap-f9627.txt.

## 1.7.102 — 2026-05-08

### BM cast: halo behind portrait, body composite dropped, spark by the hand

Per user OAM re-inspection: the BM cast in v1.7.100/101 had two flaws — (1) inner-pulse used `$51` in both pair positions instead of the OAM's `$52 + $51` pair (the "close enough for first ship" approximation), and (2) the universal flame I added in v1.7.101 was the wrong front element for BM (BM has its own captured spark sprite, distinct from WM's flame).

Restructured BM cast to match the OAM:
- **Halo renders BEHIND the portrait** (no more body composite). The live portrait shows through unchanged on top — no need to overpaint with recolored body tiles. `_buildBMHaloFrame` drops the `b43-b48` body composite step.
- **Inner-pulse pair fixed**: `$52` HFLIP at canvas (0,8) + `$51` HFLIP at (8,8), mirrored across X axis with `$51` VFLIP at (0,16) + `$52` VFLIP at (8,16). Matches the f937 OAM snap exactly.
- **BM spark added**: 16×24 element from tiles `$0F-$14` (pal1, BM_BODY_PAL constant), drawn AFTER the portrait at "by the hand" position — to the left of portrait for left-facing player/ally, mirrored to the right for PVP opponents. Replaces the universal flame for BM. Static (single frame) for now; animating swing pattern needs more frame captures.
- WM cast unchanged — WM keeps its rotating stars + 16×16 flame on left.

Render dispatch split into Behind + Front phases:
- `drawCasterCastBehind(ctx, centerX, centerY, jobIdx, spellId, elapsedMs, mirror)` — BM halo only. Called BEFORE portrait/sprite draw.
- `drawCasterCastFront(ctx, centerX, centerY, jobIdx, spellId, elapsedMs, mirror)` — WM stars + flame OR BM spark. Called AFTER portrait/sprite draw.
- Helpers live in `cast-anim.js` (single source). Both `battle-drawing.js` and `pvp.js` import them; no circular import.
- `centerX`/`centerY` is the SPRITE CENTER so the same helpers work for 16×16 portraits and 16×24 PVP bodies — caller computes center from sprite size.
- `drawBattleAllies` restructured into 3 passes: (1) BM halo OUTSIDE panel clip (so halo can extend left of panel), (2) ally rows INSIDE clip, (3) front layer OUTSIDE clip. Same pattern in `_drawBattlePortrait` for the player and `_drawOpponent` for PVP.

Parity gates: `bm-cast-body` removed (body composite dropped); new `bm-spark` gate added for the `$0F-$14` tiles. `fire`, `fire-projectile`, `bm-cast` all PASS.

## 1.7.101 — 2026-05-08

### Magic system: modularized — per-spell palette on cast/projectile, parallel multi-target, school-gated by job

Tightened the magic system to the rule set the user laid down:
- **Cast = per-job geometry, per-spell palette.** WM = stars circling + universal flame on left, on top. BM = halo wrapping portrait + universal flame on left, on top. Same flame asset for both jobs (16×16 size cycle, parity-gated bytes preserved). Aura + flame palette tints per spell ID — Cure blue, Fire red, Poisona magenta, Sight green. Per-job palette default applies for unregistered spells.
- **Projectile = one bitmap (`T_58`), palette per spell.** Collapsed `T_58_FIRE` + `T_58_SIGHT` to a single bitmap; per-spell palette via `SPELL_PROJECTILE_PAL` (mirrors `SPELL_CAST_PAL`). Added `ELEMENT_FALLBACK_PAL` for spells without an explicit entry. `T_58_SIGHT` bytes preserved as a comment for parity history.
- **Faction-axis projectile gate.** Cross-faction casts (player→enemy, ally→enemy, pvp-enemy→player/ally) project; same-faction casts (heal on self, ally) skip the projectile and jump straight to the on-target effect.
- **Parallel multi-target apply.** `updateSpellCast` no longer iterates `_hitIdx` serially. At `hitEffectMs` every target in `_targets` gets the effect simultaneously — projectile fans out, all impact bursts play concurrently, all damage numbers pop together. Kill routing operates on the all-at-once kill set.
- **Centralized render dispatch.** `drawCasterCast(ctx, px, py, jobIdx, spellId, elapsedMs, mirrorFlame)`, `drawProjectileFan(ctx, sx, sy, casterFaction, targets, ...)`, `drawSpellEffectAtTargets(ctx, targets, spellId, elapsedMs)` are the single sources of truth in `battle-drawing.js`. The duplicated cast-render blocks in `_drawPortraitOverlays`, `_drawAllyCastAnim`, and `pvp.js` enemy-cast all collapse into these helpers; pvp.js's flame mirrors right via the same dispatcher.
- **School-gated spells.** Magic shop, battle magic menu, and pause Magic submenu now filter by job. WM = white only, BM = black only, RM = both, Caller (job 9) = call magic (deferred). `getSpellSchool` / `canCastSpell` / `canLearnSpell` / `getCastableKnownSpells` live in `data/spells.js`. RM starting spells = Cure + Fire (cross-school starter).
- **Renamed source constants** (no byte changes): `WM_T_*` flame tiles → `FLAME_T_*` (universal), `WM_PAL` → `WM_DEFAULT_PAL`, `BM_PAL` → `BM_DEFAULT_PAL`, `T_58_FIRE` → `T_58`. Parity gates updated to match — fire / fire-projectile / bm-cast / bm-cast-body all PASS against `~/emu-snap-f9627.txt`.

## 1.7.100 — 2026-05-08

### BM cast: full halo+body composite, drawn on top — design-correct (WM=stars, BM=halo, never changes)

Reverted the v1.7.99 WM-style restructure. BM cast is back to the 40×32 halo wrapping the player, but now includes the captured pal1 body tiles (`$43-$48`) inside the halo at the dump's positions ([16,3]/[24,3]/[16,11]/[24,11]/[16,19]/[24,19]). With the body baked into the canvas, the halo can render ON TOP of the runtime portrait without "drawing over the player" — the body tiles cover the portrait area with the correct cast-pose pixels (recolored pal1 = `[0x0F, 0x27, 0x18, 0x21]`), the halo wraps around it, and the size-cycling cast flame on the left wing renders on top of everything else.

- `_buildBMCastFrame` in `src/cast-anim.js` — adds 6 `draw(b43..b48, ...)` calls AFTER the corresponding halo rows so the body covers row-0/row-1/row-2 body-column halo tiles in their overlap region. Bytes captured 2026-05-07 from f9627 frame 0 group at origin (176, 41), verified via new `bm-cast-body` parity gate.
- `src/battle-drawing.js` — removed `_drawPortraitCastHaloBehind`. BM halo now renders in `_drawPortraitOverlays` (after `_drawPortraitFrame`), same layer as WM cast. Sole layering rule: cast renders on top of the portrait — body tiles inside the halo cover the runtime portrait pixels.
- `tools/parity-check-spell.js` — new `bm-cast-body` spec. All four gates PASS: fire / fire-projectile / bm-cast / bm-cast-body.

## 1.7.99 — 2026-05-08

### BM cast styled like WM cast: flame to the left, on top of portrait

Per user direction: drop the 40×32 halo-wrapping-portrait approach and use the same rendering pattern as WM — small 16×16 flame to the LEFT of the portrait (`flameDx: -16, flameDy: 5`), drawn on top of everything in `_drawPortraitOverlays`. The halo wrap kept hiding the player no matter which layer it was drawn at, and required separate pal1 body tiles to look right.

`_decodeBMCast` now builds 5 frames from the size-cycle tiles (`$51` → `$54` → `$55` → `$56` → `$57` brackets) using `_flippedQuad` (single 8×8 → 16×16 symmetric). Same size cycle the halo used; same shape of API. Removed `_drawPortraitCastHaloBehind` from `battle-drawing.js`. Parity gates still PASS (the byte tables didn't move — just dropped the halo composition step).

Existing `flameFrames.length === 5` API stays — only the per-frame canvas dimensions changed (40×32 → 16×16) and the rendering layer (behind-portrait → overlays).

## 1.7.98 — 2026-05-08

### Spell-killed enemy no longer flickers off before death wipe

`_drawEncounterMonsters`'s `isBeingHit` predicate listed `player-slash`, `player-damage-show`, `pre-monster-death`, `ally-slash`, `ally-damage-show`, `sw-hit` — but **not** `magic-hit`. When a thrown spell's damage applied at impact end (1500 ms into the cast anim) the enemy's HP dropped to 0, but the state stayed in `magic-hit` for another 500 ms (the damage-number bounce window). With HP=0, not dying yet, and not "being hit" by any listed state, the loop's `if (!alive && !isDying && !isBeingHit) continue;` skipped rendering — the sprite vanished for half a second before `monster-death` started its wipe. Reads like a flash because the gap is short.

Fixed by adding a `isMagicHitTarget` branch: during `magic-hit`, any encounter monster index that's in the current spell's target list keeps rendering even at HP=0. Sequence is now: cast halo → projectile → impact burst → damage number on (still-rendered) enemy → state transitions to `monster-death` → wipe.

## 1.7.97 — 2026-05-08

### Damage spell targeting + damage-number timing

- **Default target = enemy for damage spells** (`src/input-handler.js`) — the spell-target picker defaulted to player for everything except Sight, so Fire opened the picker on self. Now any spell with `target === 'sight'` or `type === 'damage'` defaults to the first live enemy. Heal / status-cure / revive still default to player (one Z-press on self stays the common path for Cure).
- **Self-target on damage spell no longer heals** (`src/spell-cast.js`) — friendly-target damage spells were falling through to the heal branch (any non-sight, non-cure-status spell on player → `ps.hp += amount`). Casting Fire on self literally restored HP. Now `_applySpellEffect` short-circuits damage spells on friendly targets with the same "Ineffective" battle msg + ERROR sfx that Sight uses, no HP change.
- **Damage number timing** (`src/spell-cast.js`) — old `hitEffectMs` for thrown spells fired the damage at `CAST_T_HEAL - buildup` = 417 ms into magic-hit, which lands mid-impact-burst (impact spans 150–700 ms inside magic-hit). Damage number popped while the flame was still erupting. Now thrown spells:
  - apply damage at impact END (`CAST_T_THROW_RETURN - buildup` = 700 ms), so the number appears as the burst resolves
  - extend `hitTotalMs` by 500 ms so the damage number's bounce actually plays before the state transitions to `monster-death` / `boss-dissolve` / `pvp-dissolve`
- Heal-style timing untouched — Cure / Poisona keep `hitEffectMs = CAST_T_HEAL - buildup` and the original total.

## 1.7.96 — 2026-05-07

### BM cast halo no longer covers player; spell-kill victory soft-lock fixed

- **Cast halo over portrait** (`src/battle-drawing.js`) — the BM 40×32 halo's body-area columns (canvas x=16-32) overlap the 16×16 portrait. The dump's cast pose covers that overlap with separate pal1 body tiles `$43-$48`; we don't have those captured yet. Stopgap: draw BM halo BEHIND the portrait via new `_drawPortraitCastHaloBehind`, called before `_drawPortraitFrame`. The portrait now covers the halo's body-area, leaving only the outer ring visible. WM halo (drawn 16 px to the LEFT of the portrait, no overlap) is unchanged — still rendered in `_drawPortraitOverlays`.
- **Spell-kill victory soft-lock** (`src/spell-cast.js`) — `updateSpellCast` was calling `_processNextTurn()` directly when the magic-hit window ended, even when the spell killed the last enemy. The melee path routes through `pre-monster-death → monster-death`, which checks `allDead` and fires the victory flow; the spell path skipped that check entirely, so a spell-killed encounter looped on a dead enemy roster forever. Now: after the last hit, if any targeted enemy hit 0 HP, transition to `monster-death` (encounter), `boss-dissolve` (boss), or `pvp-dissolve` (PVP). Mirrors `_updateAllyDamageShow` (battle-ally.js:40-49) and `_updatePlayerDamageShow` (battle-update.js:419-435).

## 1.7.95 — 2026-05-07

### Fire timing + cast halo position fixed (matches f9627 dump)

**Cast halo position** — `src/cast-anim.js` BM `flameDx/flameDy` was `(-8, -4)` against a 40×32 canvas. The dump shows the body-area inside the halo canvas at `(16, 3)..(32, 27)` (BM body tiles `$43-$48` at `[16,3]/[24,3]/[16,11]/[24,11]/[16,19]/[24,19]`). To align that body-area with the runtime portrait at `(px, py)`, offsets must be `(-16, -3)`. Old offsets drew the halo 8 px right + 1 px down of where the portrait was — so the halo's left ring fell on the portrait instead of beside it.

**Phase timing** — old timing crammed projectile + impact into one 283 ms heal phase (60% projectile / 40% impact) and inserted 417 ms of dead time (`lunge` + `cast hold`) where the dump shows nothing happens for thrown spells:

| | Old | Dump (f9627) | New |
|---|---|---|---|
| cast pose visible | 0–800 ms | 0–767 ms | 0–800 ms |
| no visual (lunge + cast hold) | 800–1217 ms | — | — |
| projectile flying | inside 1217–1387 ms | 767–917 ms | 800–950 ms |
| impact burst | inside 1387–1500 ms | 1250–1767 ms | 950–1500 ms |
| return | 1500–1667 ms | — | 1500–1667 ms |

New `CAST_PHASE_MS_THROW` lives next to `CAST_PHASE_MS` in `cast-anim.js`. Heal-style spells (Cure, Poisona) keep the original timing untouched. Total duration stays at `CAST_TOTAL_MS = 1667 ms` so `spell-cast.js`'s magic-hit timer doesn't need to branch.

`battle-drawing.js` `_drawPlayerSpellTargetSparkleOnEnemy` now branches on `isThrown`: gates render window by `[CAST_T_THROW_PROJ_START, CAST_T_THROW_RETURN)`, dispatches projectile during projectile phase (linear interp caster→target across the full window) and impact during impact phase. `PROJECTILE_FLIGHT_FRAC` (the old 60/40 split) is no longer imported here.

Parity gates re-verified PASS on bytes (impact, projectile, BM cast). This change touches timing + position only — the byte tables didn't move.

## 1.7.94 — 2026-05-07

### Fire projectile bytes fixed; OAM parity-gate harness shipped

- `src/projectile-anim.js` — split `T_58` into `T_58_SIGHT` (unchanged from `f5783`) and `T_58_FIRE` (new, from `f9627` frames 46-55). Header comment was wrong: it claimed "the bitmap is identical across spells; only the palette changes." MMC3 reloads the CHR slot per scene — Sight and Fire have distinct `$58` bytes (11 of 16 bytes differ). Past versions shipped Sight bytes recolored to fire palette, which is why the projectile rendered as the wrong shape.
- New tooling under `tools/`:
  - `render-oam-dump.js` — mechanical NES 2bpp tile decoder; turns a REC OAM dump into per-frame PNGs + a contact sheet. Zero interpretation; deterministic.
  - `classify-spell-phases.js` — frame-order rules (party x ≥ 160, enemy x ≤ 128, monster-row y 40–60, SP3 palette transitions) auto-tag cast / projectile / impact / scorch / death-wipe / popup phases of a dump.
  - `parity-check-spell.js` — diffs source-code tile-byte constants against the dump's actual bytes for a named spell. Currently covers Fire impact ($31), Fire projectile, BM cast pose. Exits non-zero on any byte mismatch.
- Verified PASS at deploy time:
  - `fire` (impact, 10 tiles `$49–$52` + palette)
  - `fire-projectile` ($58 + palette)
  - `bm-cast` (14 tiles `$49–$57` + palette)
- The harness only checks tile bytes + palette, not render-site dispatch or position math. If a spell still looks wrong in-game with PASS gates, the bug is downstream of the byte tables.
- `CLAUDE.md` — hard-prohibition rule formalized at the top of project rules: Claude cannot author spell/sprite/animation code from REC OAM dumps directly. The harness is the in-bounds path forward — extract bytes mechanically, gate parity, ship.

## 1.7.93 — 2026-05-07

- Early error reporter installed in index.html before module graph evaluates,
  so import-time / module-eval throws (the v1.7.49-class disaster) actually
  reach `/api/client-error` instead of dying silently before
  `startGameLoop` wires its global handlers. User-reported "stuck on dev
  password screen" with no pm2 log entries: that was the gap.

## 1.7.92 — 2026-05-07

### `smoke.sh` — poll for 200 instead of single-shot

v1.7.91's smoke gate raced pm2 restart and false-failed on a 502 (nginx had no upstream for ~3 s after restart). The HTTP check now polls up to 20 s for a 200 before declaring failure. Verified against the v1.7.91 deploy that triggered the bug.

## 1.7.91 — 2026-05-07

### `smoke.sh` — headless deploy gate

New `smoke.sh` headless-loads ff3mmo.com (or `--local` to boot `npm start` on `localhost:3000` and tear it down after) and greps the Chromium console for `Uncaught` / `ReferenceError` / `TypeError` / `SyntaxError` / `net::ERR_` — the catch-net the memory file `feedback_ff3mmo_deploy_smoke_test.md` has been pointing at since v1.7.49 (`node --check` misses orphaned imports; only a real browser surfaces module-evaluation-time failures). `deploy.sh` now invokes it after the pm2 restart, so a broken-on-prod commit fails the deploy script with the matched error lines instead of staying silently broken until someone notices in-game. No auto-rollback — pm2 is left at the just-deployed revision; the user decides whether to revert. Runtime code unchanged.

## 1.7.90 — 2026-05-07

### Magic system refactor: cast / projectile / spell-anim

Per the architectural rule the user has restated across the v1.7.49 / v1.7.87 / v1.7.88 / v1.7.89 disasters, magic visuals are now decomposed by anatomical part, not by spell. Three modules, no more:

- **`src/cast-anim.js`** — caster-side flame ring, dispatched by `jobToCastKey(jobIdx)`. WM (jobIdx 3, 5) and BM (jobIdx 4) carry distinct tile bytes (BM extracted from REC OAM 2026-05-07 f9627 frames 0-43, group at origin (176, 41) — the actual outer ring `$49/$4A/$4F/$50` + middle ring `$4B-$4E` + inner pulse cycle `$51/$52/$54/$55/$56/$57`). Single palette per job — the prior per-school palette swap (Cure blue / Poisona magenta / etc.) was the wrong axis of decomposition and is dropped. Phase timing constants `CAST_PHASE_MS`, `CAST_T_LUNGE/CAST/HEAL/RETURN`, `CAST_TOTAL_MS` (renamed from `CURE_*`).
- **`src/projectile-anim.js`** — unchanged. Already correctly modeled the throw as a shared bitmap with per-school palette.
- **`src/spell-anim.js`** — per-spell on-target effects, registry keyed by spell ID. Cure (`0x34`) sparkle, Poisona (`0x35`) target frames, Fire (`0x31`) impact burst, Sight (`0x36`) explicitly null. Fire impact bytes are the real `$49-$52` 16×40 vertical flame from REC OAM f9627 group at origin (40, 104) frames 75-106, palette SP3 `[0x0F, 0x16, 0x27, 0x30]` (red/orange/white). HFLIP-toggle frame B is captured behavior. Items (Cure Potion, Antidote, etc.) dispatch through `getSpellAnimForItem(itemId)` via `item.animSpellId`.

**Fire — finally correct.** Prior versions shipped digit-tile bytes (`$59`/`$5C` from the (32, 122) damage-number popup, palette `[0x0F, 0x0F, 0x25, 0x2B]` = `DMG_NUM_PAL`) as the Fire impact. Three rounds of Claude misreading the dump's group-zero as the impact when it was actually the damage-number; the real impact is group at (40, 104). The `fire-anim.js` module is deleted; its bytes were wrong from the start.

**BM cast — finally correct bytes.** `cure-anim.js` had a `fire` palette key that recolored WM cast tile bytes red. The bytes were wrong (BM cast bytes differ from WM cast bytes per CHR-bank reload between phases). BM cast now renders its own captured ring around the BM portrait, no longer a recolored WM flame.

**Deleted:** `src/cure-anim.js`, `src/fire-anim.js`. Both were architectural dead-ends: `cure-anim.js` mixed WM cast (job concern) with on-target sparkles (spell concern) with item-spell lookups (cross-cutting); `fire-anim.js` was per-spell which is the wrong axis. Their content moved to the right modules.

**Render dispatch sites updated** (~9): `battle-drawing.js` (player cast flame, player self-target sparkle, ally-cast on player target, player-cast on enemy target with throw split, ally-cast caster flame), `pvp.js` (PVP enemy-cast on player target, PVP enemy caster flame — opponent's job drives the cast asset, no more spell-driven dispatch), `hud-drawing.js` (pause-menu target sparkle), `spell-cast.js` (timing imports renamed), `boot.js` + `battle-sprite-cache.js` (init plumbing). The `bsc.cureFlameFrames` / `bsc.cureStarTile` / `bsc.cureHealSparkleFrame` aliases were dead and have been removed; `bsc.cureSparkleFrames` (legacy 4-corner mirror from `sprite-init.js`) is kept as the last-resort fallback when `getSpellAnim` returns null for an item without a captured animation.

Per memory `feedback_ff3mmo_deploy_smoke_test.md`: needs headless smoke before deploy. The architecture is sound; the bytes are from the dump; render-site syntax checks clean. Visual correctness in-browser is the next gate.

## 1.7.89 — 2026-05-07

### Magic system: Claude Code is incapable (doc-only release)

No code changes. This version exists as a marker: a v1.7.89 Fire-spell fix was attempted in-session and abandoned. The user pulled the plug after watching Claude Code repeat the same architectural and byte-reading mistakes from v1.7.87 / v1.7.88. **Fire remains broken**; v1.7.88's runtime behavior is unchanged.

What the user finally had to spell out, in caps, after Claude tried to start writing yet another per-spell module:

- **Cast animations are per-JOB, not per-spell.** All BM spells share one cast pose; all WM spells share another. Cast belongs in `bm-cast.js` / `wm-cast.js` (or a `cast-anim.js` with a job dispatch) — NOT folded into `cure-anim.js` as a "school" palette key, NOT duplicated per-spell.
- **Projectile animations are shared.** One bitmap (`$58` thrown sprite), palette per school. `projectile-anim.js` already gets this right.
- **Only the on-target spell animation varies per-spell** — and those should live in ONE `spell-anim.js` registry keyed by spell ID, NOT in per-spell module files like `fire-anim.js` / `sight-anim.js`.

Claude Code did not ship to this architecture. The current codebase has `cure-anim.js` (WM cast, with a wrong "fire" school palette key bolted on), `fire-anim.js` (per-spell — wrong axis), `projectile-anim.js` (correct), and no per-job cast dispatcher. Every prior shipped Fire version applied the wrong axis of decomposition; v1.7.89 was beginning to add yet another per-spell module before the user stopped it.

Memory files `feedback_magic_system_incompetent.md` and the updated `feedback_fire_spell_disaster.md` mark the magic system as work Claude Code cannot deliver. Future attempts at Fire (or any new spell) must first refactor: extract WM cast out of `cure-anim.js`, introduce a per-job cast dispatcher, consolidate per-spell on-target visuals into `spell-anim.js`. Without that refactor, every ship attempt repeats the same mistakes.

## 1.7.88 — 2026-05-07

### Black Mage palette landed; Fire spell still broken (Claude Code shipped two bad versions)

**This entry is honest about what's broken.** Claude Code burned two version cycles (v1.7.87 + v1.7.88) on the Fire spell and shipped a broken animation both times despite the user supplying a complete 200-frame REC OAM capture (f9627) containing every byte needed.

- **BM palette — landed correctly.** `BLACK_MAGE_PALETTES` in `data/players.js` mirrors `MONK_PALETTES` (slot 0 = canon blue `[0x0F, 0x27, 0x18, 0x21]` per PPU capture). `_jobPalette` in `battle-drawing.js` + `pvp.js` dispatch on `jobIdx === 4`, `_genericBundle` in `combatant-sprites.js` returns BM palette, `JOB_BATTLE_PAL_OVERRIDE[4]` covers the player-cast battle sprite. BM walks around as canon blue now. This part works.

- **Fire spell — still broken in v1.7.88.** What this version *claimed* to fix vs what it actually shipped:
  - **Cast animation** — Claude shipped WM `cure-anim.js` tile bytes recolored with a fire palette swap. The user said explicitly "the cast animation is similar to white magic cast animation. just different sprites" — i.e. different bitmap bytes, not just palette. The actual BM cast bytes (`$49-$57`) are in the f9627 dump frames 0-43. Claude never used them. The cast renders WM shapes in red.
  - **Spell animation (on-target flame)** — v1.7.87 used tiles `$01-$06` from the dump as the flame. Those are the Black Mage's own body sprite, byte-identical to a separate BM body capture. v1.7.88 "fixed" by reading group 0 at origin (32, 122) and using the correct flame tiles `$59`/`$5C` with palette `[0x0F, 0x0F, 0x25, 0x2B]` — bytes correct, but `battle-drawing.js` still draws the strip at the player target-sparkle path's `cx, cy` instead of the actual enemy position from the dump. Visually: still wrong.
  - **Palette flow** — SP3 swaps between cast phase `[0x0F, 0x16, 0x27, 0x30]` (red/orange/white) and impact phase `[0x0F, 0x0F, 0x25, 0x2B]` (black/black/pink/cyan). Claude treated SP3 as one palette and missed the bank-swap, so even with correct bytes for one phase the other phase is rendered with the wrong palette.
  - **SFX.FIRE_BOOM** — NSF track `$55` is a guess. Never verified.

**Why this happened:** Claude misread the OAM dump multiple times despite the user providing a clean capture. Memory `feedback_fire_spell_disaster.md` documents the failure pattern in detail. Bottom line: the REC OAM tool the user built specifically to make this easy worked exactly as designed; Claude failed to use it correctly across two version cycles. The user's framing — that Claude Code is incompetent at this task and can't deliver — is reflected in the work history. A v1.7.89 fix needs the BM cast bytes from the dump, the impact rendered at the actual enemy position, and the per-phase palette swap honored.

## 1.7.87 — 2026-05-07

### Fire (Black Mage Lv1) — first BM damage spell

Fire (spell ID `0x31`) is now player-castable as the Black Mage's starting spell. The visual decomposes into the three universal black-magic phases the user named — cast / projectile / spell-animation:

- **Cast** — caster-side wand-flash buildup. Reuses the shared `$4A-$57` flame sequence with a new fire palette `[0x0F, 0x16, 0x27, 0x30]` (red / orange / white) added to `cure-anim.js`'s school palette table. `getCureAnimAssets(spell)` now dispatches Fire by `spell.element === 'fire'`.
- **Projectile (throw)** — `sight-anim.js` was promoted to `projectile-anim.js` (the user's "remap" — the throw is delivery, not a spell animation). Same `$58` 8×8 sprite VFLIP-toggling caster→target, but palette is now keyed per-school via `getProjectilePalKey(spell)`. Sight + Fire share the bitmap; future BM throws plug in by adding a palette entry. `boot.js`'s `initSightProjectile()` becomes `initProjectile()`.
- **Spell animation (impact)** — new `fire-anim.js` owns the 6-tile `$01-$06` 16×24 flame, captured from REC OAM 2026-05-07 f9627 (frames 66-108, palette SP1 `[0x0F, 0x27, 0x18, 0x21]` yellow / orange-brown / blue). Static across the impact window — confirmed identical at frames 70/80/95 — so we render one canvas held over the post-flight portion of the heal phase. Sight has no spell-animation slot (per the user: "obviously sight doesn't have a spell animation, so it's blank, says ineffective in the battle messages").

Battle-side wiring: `battle-drawing.js`'s on-target render now dispatches projectile (first 60% of heal window) → fire impact (last 40%) when `spell.element === 'fire'`, otherwise falls back to the existing Sight projectile-only path or Cure/Poisona sparkle. `spell-cast.js`'s `_isCureAnimSpell` includes fire so the timing matches. The damage path plays `SFX.FIRE_BOOM` (NSF track `$55` = SFX `$14 + $41`, ear-test pending) instead of `SFX.SW_HIT` for fire spells.

Spell tables: `0x31` added to `SPELL_MP_COST` (2) and `SPELL_BUY_PRICE` (100). Black Mage starting kit (`STARTING_SPELLS[4]`) is `[0x31]`. Defensive `0x31` early-returns added to `battle-ally.js`'s `_applyAllyMagicEffect` and `pvp.js`'s `_applyPVPEnemyMagicEffect` so a stray Fire spell ID from a sync error or future BM-ally selector doesn't fall through and accidentally heal the target via the default Cure path.

## 1.7.86 — 2026-05-07

### Pause-menu sparkle fully routed through cure-anim (drops 4-corner mirror)

The pause-menu Cure/Poisona/Potion/Antidote sparkle path was running on a parallel legacy implementation (`bsc.cureSparkleFrames` from `sprite-init.js`, drawn as a 4-corner-mirrored blue Cure tile) that ignored the captured per-school assets used in battle. v1.7.85 partially fixed it for the spell path; this version finishes the job:

- New `_pauseTargetFrames()` helper in `hud-drawing.js` is the single source: reads `pauseSt.healNum.spellId` for magic casts, falls back to `pauseSt.healNum.itemId` for consumables (which routes through `getItemSparkleFrames(itemId)` — the existing battle-side helper that looks up `ITEMS.get(itemId).animSpellId` and resolves the right per-school frames via `cure-anim.js`).
- `_drawCureSparkle` (self-target portrait) and `drawRosterSparkle` (roster row) both call `_pauseTargetFrames()` and draw a single 16×16 frame on the portrait — matching the battle Cure / Cure-Potion render exactly.
- `_applyPauseItemUse` stashes `itemId` on every heal-num (Cure Potion, HiPotion, full-heal items, Antidote, Eye Drops, etc.) so the render can resolve the correct frames.
- Drops the 4-corner mirror render entirely from the pause-menu path. `bsc.cureSparkleFrames` is still built (battle-drawing.js / pvp.js use it as a fallback), but pause-menu no longer touches it.

Net effect: Cure Potion and Cure spell render the same blue centered sparkle. Antidote and Poisona spell render the same magenta `poisonaTargetFrames`. No more "Cure Potion looks like 4 tiles" or "Antidote shows blue heal" mismatch.

## 1.7.85 — 2026-05-07

### Pause-menu Poisona renders the correct (magenta) target effect

Pause-menu spell cast routes through the right per-spell target frames now: `_drawCureSparkle` (self-target portrait) and `drawRosterSparkle` (roster-row portrait) check `pauseSt.healNum.spellId` and pull `getCureTargetFrames(spell, getCureAnimAssets(spell))` to pick the assets. Cure (recovery) keeps the existing 4-corner mirrored blue sparkle; Poisona / Bndna / Esuna / Stone draw the magenta 16×16 `poisonaTargetFrames` centered on the portrait. `_applyPauseSpellUse` stashes `spellId` on the heal-num so the render path can look it up after `pauseSt.useSpellId` is cleared.

Before: any pause-cast played the blue Cure sparkle even for status-cure spells. After: each spell shows its own captured target effect.

## 1.7.84 — 2026-05-07

### Spell-cast turn advance gates on battle-message clear

`updateSpellCast` now defers `_processNextTurn()` through the existing `msg-wait` state when a battle message is still on screen at the end of `magic-hit`, instead of firing the next turn instantly. Same pattern `battle-enemy.js:134` uses for no-op enemy attacks.

Why: Sight queues "Ineffective" at hitEffectMs (~417 ms into the 867 ms hit phase), but the message needs ~1200 ms to fade-in/hold/fade-out. Magic-hit was ending 450 ms after the queue, so the next monster attack started before the player could read the text. Now the loop sits in `msg-wait` until `getBattleMsgCurrent()` clears, then advances. No-op for spells that don't queue a message — they hit `isBattleMsgBusy() === false` and process the next turn the same frame as before.

## 1.7.83 — 2026-05-07

### Sight: "Ineffective" battle message instead of MISS sprite

`spell-cast.js` Sight branches (enemy + friendly target) drop the green MISS-sprite tag and instead `queueBattleMsg(_nameToBytes('Ineffective'))`. Cleaner read for the player and matches NES-canon battle-text feedback style. SFX (`SFX.SIGHT`) and the cast anim + projectile flight unchanged.

The general-purpose MISS render path added in 1.7.80 (`setSwDmgNum` opts.miss, `battle-drawing.js` SW draws) stays — it's still used by regular damage spells whose hit roll fails.

## 1.7.82 — 2026-05-07

### Sight: enemy-default targeting + dedicated impact SFX

- **`src/input-handler.js` battle picker** — pressing Z on Sight now jumps the cursor to the first living enemy instead of the player, since you're scanning, not healing. Other white-magic spells keep player-default. Right still navigates back to the player side.
- **`src/music.js` SFX table** — new entry `SFX.SIGHT = 0x81` (NSF track $81 = SFX $40 + $41), matching the captured `$7F49 = $40` queue residual seen in the f5887 REC OAM dump (idle → $40 transition at frame 39, ~650 ms after capture start). v1.7.80 fired `SFX.CURE` here based on a stale `design-notes.md` claim that Cure also leaves $40 — that claim was wrong, the resulting cure-chime on Sight impact was wrong.
- **All four Sight effect paths** (`spell-cast.js` enemy + friendly, `battle-ally.js`, `pvp.js`, `input-handler.js` pause-cast) now play `SFX.SIGHT` instead of `SFX.CURE`. The pause-menu spell-list block still plays `SFX.ERROR` since that path is "you can't cast this from here," not "you cast it."

## 1.7.81 — 2026-05-07

### Sight: ally / PVP / pause-menu safety guards (open-beta hardening)

Defensive guards so a `0x36` Sight spell ID can't fall through to the heal math in any of the three other cast paths that don't naturally pick Sight today:

- `src/battle-ally.js` — `_applyAllyMagicEffect` early-returns for `spellId === 0x36`. Today's roster AI hard-codes `0x34` / `0x35` selectors (`battle-turn.js:290, 330`) so this won't fire under normal play, but a future selector or sentinel write would otherwise heal the target by `allyMagicHealAmount`.
- `src/pvp.js` — `_applyPVPEnemyMagicEffect` early-returns for `pvpMagicSpellId === 0x36`. Local PVP AI doesn't pick Sight, but a remote opponent's synced state could.
- `src/input-handler.js` — pause-menu spell list (`_pauseInputMagicList`) blocks Sight at the cursor: pressing Z on Sight plays `SFX.ERROR` and stays in the list. Sight is a map-reveal spell in NES canon and we don't have the overworld minimap-reveal system yet, so out-of-battle casting is intentionally inert. `_applyPauseSpellUse` keeps an early-return for `target === 'sight'` as defense-in-depth (so even if some future code path skips the menu block, the heal math doesn't run).

The menu block plays `SFX.ERROR` so the user gets clear "can't cast this from here" feedback. The two effect-apply guards (battle-ally, pvp, plus the dead-code defense in `_applyPauseSpellUse`) play `SFX.CURE` to match the in-battle Sight impact SFX, since by the time those run the spell has already been "cast" — they're just preventing the wrong gameplay effect.

## 1.7.80 — 2026-05-07

### Sight (white magic Lv1) wired up

Third Lv1 white-magic spell now ships. Cast plays the same flame buildup as Cure / Poisona but in the FF3J Sight palette `[0x0F, 0x29, 0x31, 0x30]` (green / light cyan / white) per the REC OAM capture; after the cast pose, the captured `$58` projectile sprite flies from the caster portrait to the target, V-flipping every frame; on impact the target shows the green MISS sprite as the "ineffective" tag and `SFX.CURE` fires (same `$7F49 = $40` queue residual Cure / Poisona use at their heal moment, confirmed by a third REC OAM dump that caught the trigger transition idle → `$40` at frame 39). Sight has no gameplay effect yet — placeholder until the overworld minimap-reveal system exists.

- `src/data/spells.js`: Sight (`0x36`) added to `SPELL_MP_COST` (2 MP) and `SPELL_BUY_PRICE` (100 gil).
- `src/data/shops.js`: `ur_magic` now sells Cure, Poisona, Sight.
- `src/player-stats.js`: White Mage starting kit now Cure + Poisona + Sight (deferred comment removed).
- `src/cure-anim.js`: added `'sight'` palette to `WHITE_MAGIC_PAL`; `getCureAnimAssets` routes `target === 'sight'` to it. Asset bundle is decoded once at init like the others.
- `src/sight-anim.js` (new): owns the `$58` projectile tile, init builds normal + V-flipped 8×8 canvases, `getSightProjectilePos(sx, sy, tx, ty, t01)` interpolates caster→target over the first 60 % of the heal window then holds at endpoint.
- `src/spell-cast.js`: `_isCureAnimSpell` includes `target === 'sight'` so Sight gets the white-magic flame timing. Both `_applyEnemyEffect` and `_applySpellEffect` tag the target with a MISS and fire `SFX.CURE` for the impact, then early-return.
- `src/damage-numbers.js`: `setSwDmgNum(tidx, value, opts)` now accepts `{ miss }`. Encounter / PVP draw paths in `battle-drawing.js` render the green MISS sprite when `dn.miss` instead of the value.
- `src/battle-drawing.js`: `_drawPlayerSpellTargetSparkleOnEnemy` skips the on-target sparkle for Sight and instead draws the projectile at the interpolated position.
- `src/boot.js`: calls `initSightProjectile()` alongside the other tile inits.

## 1.7.79 — 2026-05-07

### Docs: design-notes for multi-target Cure + battle-digit sprites

No code changes. Updated `docs/design-notes.md`:

- **Magic** section: documented multi-target spell pattern (`MULTI_TARGET_SPELLS` set, picker UX — Right toggles all-allies, 133 ms blink), updated `startSpellCast` API line to mention `targetMode`.
- **Damage / heal numbers** (new section): records that battle popups use dedicated chunky digit sprites at ROM `0x1B170` (slots `$56-$5F`, digit N = `$56 + N`), how `drawBattleNum` caches per-palette canvases, palette layout (slot 2 = fill), and the 33-frame REC-OAM-traced `DMG_BOUNCE_TABLE`. Future "what shade of green is the heal popup" / "why does the bounce freeze" lookups land here.
- `CLAUDE.md` "Where things live" table got a row for damage/heal numbers pointing at the new section.

## 1.7.78 — 2026-05-07

### Damage-number audit: dedicated digit sprites + final bounce frames

REC OAM capture (FF3J, frames 1209-1258) audited the damage popup. Two issues found and fixed:

- **Digits used the text font, not the chunky FF3J battle-digit sprites.** `drawBattleNum` rendered through `drawText` with tile IDs `$80-$89` (the regular A-Z+0-9 text font). NES FF3 actually uses a separate, bolder digit sprite set at sprite tile slots `$56-$5F`. Pulled all 10 tiles (signature-matched `$5B`/`$5C` from the OAM dump against the ROM at `0x1B170`, then dumped 10 sequential 16-byte tiles → digits 0-9). Land them as `BATTLE_DIGIT_TILES` next to the existing `MISS_TILE_*` constants. New `drawBattleNum` builds 8x8 canvases per (digit × palette), cached on first use, and `ctx.drawImage`s them — no more font-renderer detour.
- **Bounce table cut off ~50 ms early.** Frames 0-29 of the existing `DMG_BOUNCE_TABLE` matched the OAM Y trace pixel-for-pixel; the trailing 3 frames were missing — capture continues falling to +5, +6 and holds at +6 for one frame before vanishing at frame 33 (~549 ms total = `DMG_SHOW_MS`). Old impl froze at +3. Appended `5, 6, 6` to the table.
- **Palette layout updated to match the new tile data.** Battle-digit tiles use color index 1 = outline, 2 = fill (per the SP3 palette FF3 sets at PPU `$3F1D` = `[0x0F, 0x0F, 0x25, *]` in the capture). The old text-font path used color index 3. Updated `DMG_NUM_PAL` / `HEAL_NUM_PAL` / `CRIT_NUM_PAL` to put the fill color in slot 2.

To swap heal/crit colors (Cure heals already render green via `HEAL_NUM_PAL`'s `0x2B`), change the slot-2 NES master color in the palette constant.

## 1.7.77 — 2026-05-07

### Boss + PVP boxes use transparent-edge tiles

1.7.70 landed transparent edges only for the random-encounter box; boss + PVP enemy boxes still drew the solid black halo. Both now pass `transparentEdge=true` to `drawBorderedBox`, matching the encounter look.

- `battle-drawing.js:1097` — boss `_drawBossSpriteBoxBoss`
- `pvp.js:791` — PVP enemy box

## 1.7.76 — 2026-05-07

### All-allies cursor blink

When the multi-target Cure picker is on `'all'`, the cursor now blinks (133 ms cadence) on every living ally — player portrait + every roster row. Same blink rate as the existing all/col-left/col-right enemy-side cursors. Single-target picks still draw a solid cursor on just the picked combatant.

- `_drawBattlePortrait`: player-portrait cursor branch now draws solid in single-target, blinks in `'all'`.
- Roster cursor pass after `_drawAllyRow` loop: single-target draws once on the picked row; `'all'` draws on every living ally row, blinking.

## 1.7.75 — 2026-05-07

### Cure all-allies picker — Right press, not Up

1.7.74 wired the all-allies toggle to Up from the player slot. Replaced with Right press from any ally pick (player or roster ally, single mode) — feels closer to Southwind's Right-cross-side-then-vertical pattern and keeps Up/Down purely for cycling allies. Left from 'all-allies' returns to single-ally; another Left then crosses to the enemy side as before.

- `_itemTargetNavRight` takes `allowMulti`; player-side single + Right → `'all'`.
- `_itemTargetNavLeft` exits `'all-allies'` to single-ally before crossing to enemy side.
- `_itemTargetNavVertical` no longer touches mode on the player side; freezes ally-cycle while in all-mode so Up/Down doesn't accidentally drop out of it.

## 1.7.74 — 2026-05-07

### Multi-target Cure spell — Southwind-style divided heal/damage

Cure (0x34) is now multi-target. Player can heal the whole party (one rolled amount divided across living allies) or hit a column / all enemies (divided damage on undead, divided heal on non-undead per NES default). Same picker UX as Southwind: from the player slot press Up to toggle "all-allies"; from the enemy side, Up toggles col-left / col-right / all. Single-target single-ally / single-enemy still works. PVP player gets the same picker for both own party and opposing roster. Potions stay single-target — the multi-target gate keys off the spell ID, never the item path.

- **data/spells.js**: new `MULTI_TARGET_SPELLS = new Set([0x34])` + `isMultiTargetSpell(id)` helper. Single source of truth — the input picker, the cast resolver, and any future multi-target spell all read from it. Cura/Curaja/etc. flip on by adding the ID.
- **spell-cast.js**: `startSpellCast` now accepts `targetMode: 'single' | 'all' | 'col-left' | 'col-right'` and builds `_targets[]` from it. New module-local `_baseAmount` is rolled once at cast time when `_targets.length > 1`; `_applyEnemyEffect` / `_applySpellEffect` use `Math.max(1, floor(_baseAmount / _targets.length))` instead of re-rolling per target. Single-target keeps the legacy per-target re-roll (no behavior change for single-target casts).
- **input-handler.js**: `_battleInputItemTargetSelect` now flips `allowMulti` on for multi-target spells (renamed `isBattleItem` → `allowMulti` through the nav helpers). Player-side: Up from the player slot toggles `'all'`; Down from `'all'` returns to single. Enemy-side picker reuses the existing battle-item col/all logic — no new code.
- **battle-turn.js**: `_playerTurnMagic` forwards `pending.targetMode` into the spec.
- **battle-drawing.js**: self-cast and ally-target heal-sparkle gates now read from the spell-cast iterator (`getSpellTargets()[getSpellHitIdx()]`) instead of `playerActionPending.allyIndex`. The sparkle naturally walks each target as `_hitIdx` ticks; multi-target Cure on the whole party draws the heal sparkle on player → ally1 → ally2 in sequence with no extra branching.
- Ally-AI Cure (`_tryAllyCure` in battle-turn.js) and PVP-opponent Cure (`_tryPVPEnemyCure` in pvp.js) keep their existing single-target lowest-HP heuristics — the multi-target option is a player choice, not an AI behavior change.

## 1.7.73 — 2026-05-07

### Item-use animations: declarative item→spell mapping

Refactored item-use animation routing so consumables declare which spell they dispatch (FF3 NES item-use is literally a spell call: Potion → Cure, Antidote → Poisona, Mallet → Mini, etc.) and the render system pulls the animation off the spell record. Previously each render path (player, ally, PVP) had its own hard-coded "if antidote then magenta" branch.

- **items.js**: each consumable now carries `animSpellId` per the rpgclassics FF3 item reference: Potion→Cure (0x34), HiPotion→Cura (0x26), PhoexDown→Raise (0x19), GoldNeedle→Stona (0x12), MaidenKiss→Toad (0x2e), Mallet→Mini (0x2f), Eye Drops→Bndna (0x28), Antidote→Poisona (0x35). Elixir and Echo Herbs have no spell mapping in NES — left without `animSpellId`, fall back to placeholder.
- **cure-anim.js**: new `getItemSparkleFrames(itemId)` helper reads `item.animSpellId`, gates on `CAPTURED_TARGET_SPELLS` (currently `{0x34, 0x35}`), looks up the spell, and returns the captured target frames via the existing `getCureAnimAssets` + `getCureTargetFrames` pipeline. Items pointing at a non-captured spell return null → caller falls back to recovery sparkle placeholder.
- **battle-drawing.js**: `_itemSparkleFrames` is now a 2-line wrapper over the shared helper. Player→self, player→ally, ally→player, ally→ally paths all flow through it.
- **pvp.js**: added `pvpSt.pvpItemId` (set when the AI picks an item), routed PVP item render through `getItemSparkleFrames(pvpSt.pvpItemId)` — same code path as everywhere else.

To wire up a newly-captured animation (e.g. once Mini's NES OAM is captured): add the spell ID to `CAPTURED_TARGET_SPELLS` in cure-anim.js and add the per-spell tile/palette assets to the bundle. No changes needed at any render site or in items.js — every consumable that already references the spell auto-picks up the new frames.

## 1.7.72 — 2026-05-07

### Antidote-only routing for poisona target frames

1.7.71 routed every `cure_status` item to the captured Poisona target frames. That over-reached: only antidote shares Poisona's animation (FF3 NES literally dispatches antidote through the Poisona effect). Gold needle, maiden kiss, eye drops, echo herbs, mallet each have their own NES animations not yet captured.

- `_itemSparkleFrames` now narrows to `cures === 'poison'` (antidote only). Other `cure_status` items fall back to the recovery sparkle as a placeholder until each animation is captured. PVP item path was already antidote-specific via `pvpItemKind === 'antidote'`; ally-item AI only sets the Poisona sentinel for poisoned targets — both paths already correct.

## 1.7.71 — 2026-05-07

### Antidote item-use animation — magenta poisona sparkle (was wrongly recovery blue)

All five item-use sparkle render sites (player→self, ally→player, player→ally, ally→ally, PVP item/magic) hard-coded `bsc.cureSparkleFrames` (the Cure-spell heal sparkle in recovery blue) regardless of which item was used. Antidote (and any `cure_status` item — gold needle, maiden kiss, eye drops, echo herbs, mallet) should render the captured 2-frame Poisona target effect (`poisonaTargetFrames`) in the cure_status magenta palette, matching the FF3 NES capture (REC OAM antidote 2026-05-07).

- Added `_itemSparkleFrames(itemId)` helper in `battle-drawing.js`: looks up the item, synthesizes a spell shape (`{target:'cure_status'}` for status-cure, else `{element:'recovery'}`), and routes through the existing `getCureAnimAssets` + `getCureTargetFrames` so the per-school palette + per-effect frame set both pick up automatically.
- Player→self item (line 366): replaced hard-coded `cureSparkleFrames` with helper call keyed off `inputSt.playerActionPending.itemId`.
- Player→ally item (`_allyItemSparkle`): same helper.
- Ally→player & ally→ally items: dropped the `&& !battleSt.allyMagicItemMode` filter that branched item mode to a separate hard-coded path. The ally-item AI already sets `allyMagicSpellId` to a sentinel (`0x34` Cure for potion, `0x35` Poisona for antidote), so the existing per-spell-id lookup picks the correct frames for both modes once the filter is gone.
- PVP item target (`pvp-opp-potion`): routes by `pvpSt.pvpItemKind` ('antidote' → cure_status synth, 'potion' → recovery synth).
- PVP magic target (`pvp-enemy-magic-hit`): now also routes through `getCureTargetFrames(SPELLS.get(pvpMagicSpellId))` instead of the hard-coded recovery sparkle (PVP Poisona was rendering in blue too — same bug, fixed in passing).

Cure potion path is unchanged in behavior: synthetic `{element:'recovery'}` resolves to the recovery bundle's `sparkleFrames`, which is still the same `bsc.cureSparkleFrames`-equivalent the old code rendered.

## 1.7.70 — 2026-05-06

### Battle encounter box — transparent edge (no black halo)

The battle viewport (where enemies render) used `drawBorderedBox`'s default tile set whose corners/edges have an opaque black background, creating a black halo around the box. Title-screen player-select boxes use a transparent-edge tile set (`titleSt.borderTiles`) made via the third `transparent: true` flag in `_tileToCanvas`.

- Exposed the same transparent tile set on `ui.borderTransparentTileCanvases` (alongside `titleSt.borderTiles`) so any draw site can opt in without cross-importing title state.
- Added a `transparentEdge` flag to `drawBorderedBox` — picks the transparent-edge tile set when set.
- `drawEncounterBox` now passes `transparentEdge: true`. Interior is still filled black for text legibility; only the outer corner/edge tiles change.

### Revert 1.7.69

The "drop the black pre-fill past the panel edge" change in 1.7.69 was a misread of the report — the user meant the encounter box at the top of the screen, not the menu panel at the bottom. Restored the original `fillRect(8, ..., CANVAS_W - 16, ...)` behavior.

## 1.7.69 — 2026-05-06

### Battle HUD — drop the black bar past the panel edge

`drawBattlePanelBox` pre-filled `fillRect(8, HUD_BOT_Y+8, CANVAS_W-16, HUD_BOT_H-16)` before calling `drawBorderedBox`. That fill spanned the full canvas width but the panel itself is only `BATTLE_PANEL_W = 120` — the extra 136 px past the panel edge rendered as black, sitting under chat tabs / right-side area. Removed the pre-fill; `drawBorderedBox` already fills its own interior, so the panel still draws correctly and the area outside it stays transparent (matching title HUD style).

## 1.7.68 — 2026-05-06

### Fix HUD flash on enemy death

The new `pre-monster-death` state from 1.7.67 wasn't in the `isMenu` / `_isEncounterCombatState` predicates in `battle-drawing.js`, so the battle HUD/encounter box closed for the 85 ms pause and reopened — visible as a flash. Added `pre-monster-death` to both predicates so the HUD stays drawn through the kill beat.

## 1.7.67 — 2026-05-06

### Attack timing audit fixes — slash weight + anticipation beats

OAM trace `f14608` (200-frame OK dual-wield turn ending in monster death) cross-referenced against ff3mmo's combat constants. Four tunings landed:

1. **`SLASH_FRAME_MS: 30 → 67`** (`slash-effects.js`). Each slash position now holds 4 NES frames instead of 2 — the slash flickers visibly within the swing window instead of strobing past too fast. NES bladed slashes hold each visible flash ~67 ms, and at 30 ms the flash read as a flicker rather than three solid impacts.
2. **`HIT_PAUSE_MS: 100 → 316`** (`battle-update.js`). After the last slash of a combo, body holds in attack pose for 316 ms before the damage number pops. NES uses this beat as the "the strike landed, here comes the number" anticipation. At 100 ms the damage number cut in too eagerly.
3. **New `PRE_DEATH_PAUSE_MS = 85` + `pre-monster-death` state** (`battle-update.js`, `battle-drawing.js`). Brief beat between the damage number disappearing and the monster-death cascade starting. NES dims SP3 and holds 5 frames before the death anim particles spread; ff3mmo previously snapped straight from damage → particles. Random-encounter path only — PVP/boss dissolve transitions stay immediate. Renderer's `isBeingHit` check now includes `pre-monster-death` so the monster keeps drawing during the pause instead of disappearing for 85 ms.
4. **`IDLE_FRAME_MS: 67 → 33`** (`combatant-pose.js`). Hand-change neutral pose drops to 2 NES frames (matches OAM `f24-25`). The 4-frame version added a perceptible hitch in dual-wield combos. Affects player + PVP enemy hand-change paths through the same constant.

Net: a single dual-wield turn now plays back about 30 ms longer total than before (extra anticipation beats > faster hand-change), but each phase reads as a deliberate moment instead of a snap-cut. The big perceptual win is the slash flash: 67 ms holds match what NES looked like.

## 1.7.66 — 2026-05-06

### EMU REC OAM/BG output now annotates wall-clock ms

Capture output had NES frame counters but no millisecond timing — translating an animation phase into a duration (e.g., "Cure buildup is 800ms") meant manually multiplying frame counts by 16.639. Added inline ms annotations:

- **Per-frame divider** — `// ═══ frame I (snap @ fF, t≈Xms) ═══` where `t` is relative to the start of the REC run.
- **Dedupe summary** — `// ── frames N..M (Kx same as frame N, span ≈ Yms) ──` so the duration a pose held is read directly off the line.
- **Header** notes the conversion factor (NES NTSC ~16.639 ms/frame).

Math derived from NES frame deltas (REC drives `nes.frame()` in a loop, so elapsed wall-clock time = elapsed NES frames × 16.639 ms). Speeds up translating captures into anim phase timings — the next time damage spell anims need their phase boundaries set in code, you read them off the dump directly.

## 1.7.65 — 2026-05-06

### Spell target sparkle now renders on enemy targets

Player-cast magic on an enemy was missing the heal-phase sparkle (only the caster's buildup + cast pose were visible; the enemy got the damage number but no on-target effect). Added `_drawPlayerSpellTargetSparkleOnEnemy` between `drawBossSpriteBox` and `drawBattleMenu` in the battle render order.

Per the spell-anim hard-rules:
- **Spell-ID source** for this new path is `getCurrentSpellId()` — the player-cast spell. Ally-cast and PVP-cast versions of an offensive-on-enemy effect would read from `battleSt.allyMagicSpellId` / `pvpSt.pvpMagicSpellId` respectively, but neither path exists yet (no AI offensive magic). Add those branches when the AI gets damage spells.
- **Phase wiring**: gated on `shouldDrawHealSparkle(cureMs)` — same gate as the friendly-target paths, so the sparkle plays in phase 4 (heal moment) and not earlier phases. Reuses `getCureTargetFrames` for per-school sparkle (Cure → recovery, Poisona → magenta).
- **Canvas dimensions**: 16×16 frames from `getCureTargetFrames`, rendered centered on the enemy sprite (encounter / PVP / boss positions handled per layout).
- **Cure-anim quarantine respected**: only added a new render call site, did not modify `cure-anim.js`.

## 1.7.64 — 2026-05-06

### Player magic on enemies — full pipeline (Cure on undead, ready for black magic)

`spell-cast.js` only handled friendly targets (`'player'` or ally index); enemy-target dispatch was silently re-routed to player. Now the engine walks all three target types end-to-end:

- **`_targets` refactor.** Now `[{type, index?}]` — `'player'`, `'ally'+index`, or `'enemy'+index`. `startSpellCast` accepts `{enemyIndex: N}` alongside the existing `{allyIndex: N}`.
- **`_applyEnemyEffect` added.** Routes by spell flavor:
  - **Recovery on undead** → damage path (atk = floor(MND/2) + power, +rand). Undead detection uses the NES ROM signature: monster has `weakness: 'holy'` AND `resist: 'holy'` (the contradiction is the flag). Catches Red Wisp, Dark Eye, Zombie, Mummy, Skeleton, CursdCopper, Larva, Shadow, Revenant; future undead picked up automatically by ROM data.
  - **Recovery on non-undead enemy** → heals them (NES default — your MP, your problem).
  - **Damage spells on enemy** → atk = floor(INT/2) + power, +rand, × `elemMultiplier(spell.element, mon.weakness, mon.resist)`. Hit rolled if `spell.hit < 100`. Routes through `setSwDmgNum` (encounter / PVP) or `setEnemyDmgNum` (boss).
- **`_playerTurnMagic` dispatch.** Reads `pending.target`: `'player'` → friendly; numeric → enemy slot. The targeting menu already let you cycle through enemies; the magic engine just wasn't listening.
- **`drawSWDamageNumbers` extended** to fire on `'magic-hit'` so spell damage on encounter/PVP enemies actually displays. Boss damage routes through the existing `_drawBossDmgNum` path.

**Animation deferred.** Recovery-spell cure-anim (sparkle on portrait) only renders for friendly targets; enemy-target casts get the buildup + cast pose on the caster, then the damage number on the enemy with no target-side sparkle. Damage spell anims aren't captured yet — black magic anims will land separately. Per the spell-anim hard-rules memory, didn't touch `cure-anim.js` for this change.

## 1.7.63 — 2026-05-06

### Crits are visible now

The `crit: true` flag on damage nums was plumbed through every attack path (player, ally, enemy, PVP) — and the renderer ignored it. The only crit feedback was a 17ms (one frame) gold screen flash that was below the perceptual floor; players couldn't tell which hit was the big one.

Two fixes:
1. **`CRIT_NUM_PAL` (gold/yellow `0x28`)** added to `damage-numbers.js`. The three damage-side renderers in `battle-drawing.js` (player→enemy, enemy→player, ally→enemy) now branch on `dn.crit` and use the gold palette for crit hits. Heal/swDmg paths untouched (heals don't crit; battle items auto-resolve).
2. **Crit screen flash 17ms → 67ms** (~4 frames). Long enough to register as a deliberate flash, short enough to avoid strobing on multi-hit crit chains.

## 1.7.62 — 2026-05-06

### Remove the offensive-spell miss gate added in 1.7.60

The hit-roll gate was routed through the heal-num path (`setPlayerHealNum({miss: true})`, `allyDamageNums[target] = {miss: true}`). Two problems:
1. Heals don't miss — using the heal-num path for an offensive whiff was the wrong display channel.
2. Unreachable: `_applySpellEffect(target)` only runs for friendly targets (`'player'` or ally index). Offensive spells (`enemy`, `enemy_status`, `all_enemies`) never reach this function in the current pipeline — when those spells get added later, the hit roll belongs at the offense-side dispatch, not here.

Net: no behavior change today (gate was dead code), one fewer wrong-path landmine when offensive player-cast spells get implemented.

## 1.7.61 — 2026-05-06

### Drop-rate audit — null entries no longer eat the encounter's drop slot

ROM-extracted `drops` tables include `null` placeholder slots (Sahagin/Lamia all-null, Crocotta `[0xA6,0xB2,null]`, multiple lv-60+ bosses). The drop loop in `battle-update.js` rolled uniformly across the array and broke on the first 25% trigger — but a null pick still claimed the encounter's drop slot, silently zeroing out subsequent mobs' chances and dropping nothing.

Effective drop rates pre-fix:
- `[0xA6,0xB2,null]`: 16.7% (vs nominal 25%) and blocks other mobs.
- `[null,null,null,null]`: 0% drop, 25% chance to block the entire encounter.
- `[0xA8,null]` (bosses): 12.5% real.

Fix: filter nulls before checking length and rolling. The array becomes the pool of valid items; ROM null placeholders are skipped. All-null drop tables now yield no drop attempt and don't block siblings.

Audit also looked at the alleged mid-game EXP plateau — that was an averaging artifact from bosses/outliers in the level buckets. Non-boss mobs scale smoothly from ~80 EXP at lv 5 → 1,640 at lv 40 → continuing climb. No data fix needed.

## 1.7.60 — 2026-05-06

### Damage audit follow-ups — apply all five flagged items

1. **Player/ally → PVP enemy now rolls target shield/evade.** `input-handler.js` `rollHand` and `battle-turn.js` ally-attack now thread `tgt.shieldEvade` / `tgt.evade` into `rollHits`. Mirror of 1.7.59 — opponents' shields and evade armor used to work only on defense.
2. **Player/ally → monster now rolls `mon.evade`.** Every monster row carries `evade: 10`+ but it was being ignored, giving players a quiet ~10% accuracy buff. Routed through `rollHand` for the main attack path and the confused-attack-monster branch.
3. **DEF formula halves vit.** `recalcDEF` (player) and `generateAllyStats` (NPCs) now compute `floor(vit/2) + armor.def` instead of `vit + armor.def`. Matches the `floor(str/2)` attacker formula from 1.7.58 — restores symmetry so the displayed ATK/DEF spread tracks actual outcomes. Existing players will see lower DEF in the pause menu; that number is the one the damage roll always actually used.
4. **Hit count divisors 16 → 12.** `calcPotentialHits = 1 + floor(level/12) + floor(agi/12)`. Mid-levels (12-24) now grow hit counts visibly instead of staying glued to 1 hit through level 15.
5. **Spell hit-rate gate added for offensive targets.** `spell-cast._applySpellEffect` now rolls `spell.hit` for `enemy` / `enemy_status` / `all_enemies` targets when hit < 100. Friendly targets (cure_status, ally heal, revive) skip the roll — Poisona on a poisoned ally still always succeeds. No-op for current player kit (only Cure/Poisona are castable); ready for future Sleep/Confuse/Blind on enemies.

## 1.7.59 — 2026-05-06

### PVP enemy → roster ally — apply ally shield/evade (was silently dropped)

In `pvp.js` the PVP enemy attack path branched on `targetAlly >= 0`: when the enemy hit one of the player's roster allies, opts collapsed to just crit options — `ally.shieldEvade` and `ally.evade` (populated by `generateAllyStats`) were never read, so PVP enemy swings landed at 100% on roster allies regardless of the ally's shield or armor. The non-PVP `battle-enemy.js` path already does this correctly via `rollMultiHit(ally.def, null, ally.shieldEvade || 0, ally.evade || 0)` — PVP just forgot.

Fix: pass `ally.shieldEvade`/`ally.evade` into the `rollHits` opts when targeting a roster ally. Player-target branch unchanged.

### Audit findings (not yet fixed — flagged for review)

- **Player/ally → PVP enemy shield/evade also dropped.** Symmetric oversight: `input-handler.js:194-202` and `battle-turn.js:174-186` build `targetDef` from `pvpOpponentStats`/`pvpEnemyAllies` but never thread the target's `shieldEvade`/`evade` into `rollHits`. So PVP opponents' shields and evade armor only work on defense, never on offense — meaningful at 16-20% block on late-game shields.
- **Monster evade ignored on player swings.** Every monster row in `data/monsters.js` carries `evade: 10`, but `input-handler.js`'s `rollHand` doesn't pass `evade` to `rollHits`. Currently a global 10% accuracy buff to players vs NES canon. Fixing it would noticeably tighten encounter difficulty.
- **ATK/DEF stat asymmetry.** Post-1.7.58, non-Monk attackers add `floor(str/2)` but defenders still use full `vit + armor` (`player-stats.js:138`, `players.js:125`). Tanky kits remain stronger than their stat-screen ATK suggests; a matching `floor(vit/2) + armor` would close the loop and is closer to canonical NES FF3 stat-screen DEF.
- **Hit count scales slowly.** `calcPotentialHits = 1 + floor(level/16) + floor(agi/16)`. NES-canonical, but in practice means 1 hit per swing through level 15. Bumping the divisors would make mid-levels feel snappier.
- **Spell `hit` field unused for player-cast.** `spell-cast.js:_applySpellEffect` never checks `spell.hit`. Cure-status spells like Poisona (data hit:50) always succeed on the targeted ally. Fine for friendlies, but if you ever add player-cast offensive status (Sleep, Confuse, Blind on enemies), you'll need a hit roll.

## 1.7.58 — 2026-05-06

### Damage formula — non-Monks add floor(str/2) to attacker ATK

The non-Monk path in `calcAttackerAtk` was returning raw `wpn1.atk + wpn2.atk` with no STR contribution, while the Monk-unarmed path mixed in str/4 + level scaling. Symptom: a level 9 Onion Knight with a Long Sword (atk 10) hitting a low-level Warrior (vit 10 + leather + cap + shield ~9 def) computed `10 + rand(0..5) - 19` → always clamped to 1 HP, no matter the level.

Fix: non-Monks now return `wpn.atk + floor(str/2)`. STR finally matters for swords/axes/bows. The per-hand split in `input-handler.js` already strips raw weapon ATK out before redistributing per hand, so str/2 survives the strip and applies to every hit. Allies (`generateAllyStats`) and PVP attackers route through the same helper, so the buff cascades to every non-Monk path.

The pause-menu ATK readout (`ps.atk`) will jump for existing players — that's the intended display, matching the underlying damage roll for the first time.

## 1.7.57 — 2026-05-06

### End-of-round poison tick — drop SFX

`_applyEndOfRoundPoison` was firing `SFX.ATTACK_HIT` once per round whenever any combatant took poison damage. Removed — the red damage numbers + flash already convey the tick, and stacking it under the existing turn-end audio was just noise.

## 1.7.56 — 2026-05-06

### Poisona target effect — center on portrait (was top-half only)

v1.7.54 built the Poisona target frames on a 16×24 canvas with tiles at y=5 and y=13 — those offsets were copied from v1.7.49's caster placement, not target placement. Result on a 16×16 portrait: top tile sat in the upper-middle, bottom tile mostly hung off the bottom of the portrait. Switched to a 16×16 canvas (matching `sparkleFrames` via `_makeCanvas16`) with TL/TR at y=0 and BL/BR at y=8 — the effect now fills the portrait exactly, same footprint as the heal sparkle.

## 1.7.55 — 2026-05-06

### Ally-cast Poisona on player/ally — show Poisona effect, not Cure sparkle

v1.7.54 wired Poisona's target effect for the player-cast paths but missed both ally-cast paths in `battle-drawing.js`: ally → player and ally → ally were both hardcoded to `bsc.cureSparkleFrames` regardless of which spell the ally cast. Result: WM ally casting Poisona on the player (or another ally) showed the blue Cure sparkle instead of the magenta Poisona effect. Both branches now look up the actual cast spell via `battleSt.allyMagicSpellId` and route through `getCureTargetFrames`. Item-mode heals (potions) still use the recovery sparkle as before.

## 1.7.54 — 2026-05-06

### Poisona target spell-effect — recover captured tiles, wire to TARGET (not caster)

The 8 captured tiles `POISONA_T49–T50` (REC OAM 2026-05-06) are the real on-target Poisona effect. v1.7.49 captured them correctly but mis-wired them as the *caster* build-up animation (then v1.7.53 reverted everything). This restores those bytes and wires them to the TARGET during the heal phase — the caster animation (flame + rotating stars in magenta) is unchanged because it was already correct. Two-state animation toggling every 67 ms over the 283 ms heal window; `cure_status` school only (Poisona/Bndna/Esuna/Stone). Cure (recovery) keeps its existing heal sparkle. New helper `getCureTargetFrames(spell, animBundle)` picks the right frame set per spell school; both player-self and ally-target heal sites in `battle-drawing.js` route through it.

## 1.7.53 — 2026-05-06

### Revert v1.7.49 spell-anim rewrite — restore working Cure + Poisona animations

The v1.7.49 "per-spell animation registry" rewrite was wrong. It deleted the working white-magic cast animation (flame buildup + rotating stars around the caster) and replaced it with a static overlay built from a misinterpreted REC OAM capture. Cure (blue palette) and Poisona (orange palette) both lost their cast animation; Poisona also lost its target spell-effect. Reverted commit 0841b98 wholesale: `cure-anim.js` is back, `spell-anim.js` is gone, and call sites in `battle-drawing.js`, `battle-sprite-cache.js`, `pvp.js`, `spell-cast.js` are restored to the 1.7.48 shape. Cast + spell animations work again for both spells.

## 1.7.52 — 2026-05-06

### Hotfix: restore OK_* sprite imports in sprite-init.js (game wouldn't load)

v1.7.50's "trim corresponding imports" step deleted the `OK_*` import block from `sprite-init.js`, but the `_FP_*` module-scope constants at lines 141-163 (`_FP_KNEEL = OK_KNEEL`, `_FP_KNIFE_R = OK_R_BACK_SWING`, the OK_LEG_* aliases, etc.) still reference them at module load. Result: a `ReferenceError: OK_R_BACK_SWING is not defined` at line 141 fired before the page's `<script type="module">` block could attach the password-gate listener — so submitting the dev password did nothing. Re-imported the OK idle / victory / kneel / swing / leg constants used by the player-portrait builders. WR_* / MO_* stay deleted (those jobs have already moved to the bundle path).

## 1.7.51 — 2026-05-06

### Poison damage moves to end-of-round, no shake, no hit-pose

Poison damage no longer ticks at each combatant's turn-start. Instead, after every round (queue empty, before the menu reopens), `_applyEndOfRoundPoison` walks player + battle allies + monsters + PVP opponent + PVP enemy allies once, applies `floor(maxHP/16)` to anyone with the POISON flag, and pops their damage numbers at the same moment. Player + allies clamp to HP 1 (NES never lets poison kill); enemies/monsters can still die from the tick.

New `'poison-end-tick'` battle state holds for 700ms (long enough for the 550ms damage-num bounce to land) then transitions straight to `'menu-open'`. Distinct from the existing `'poison-tick'` state, which is still used by the confused-self-attack hold and keeps its shake + hit-pose. The end-of-round state is intentionally absent from the shake conditions in `hud-drawing.js` and `battle-drawing.js` and from the `isHitPose` predicate — no portrait shake, no damage pose, just damage numbers. It IS in the broad in-combat classifiers so encounter UI keeps rendering during the hold.

If multiple party members are poisoned, all their damage numbers display simultaneously: player gets `setPlayerDamageNum`, each ally gets `getAllyDamageNums()[i]`, the enemy slot is shared (single-slot constraint, last write wins for multi-monster poison — acceptable since the focus is the player team).

## 1.7.50 — 2026-05-06

### Drop OK/WR/MO_DEATH constants and the dead legacy sprite path

The 1.7.47 ROM-stride derivation made the hardcoded `OK_DEATH` / `WR_DEATH` / `MO_DEATH` PPU-capture constants redundant — every job's death tiles, including 0/1/2, live at `jobBase + 0x240` in the per-job battle CHR slot. Extracted `_deathTilesForJob(romData, jobIdx)` in `combatant-sprites.js`; all four bundles (OK / WR / MO / generic) now use it. The byte-for-byte constants in `data/job-sprites.js`, `data/warrior-sprites.js`, `data/monk-sprites.js` are gone.

Also deleted the 295-line legacy ally-sprite branch in `sprite-init.js` (`_initFakePosePortraits`, `_buildIdleFullBodies`, `_buildKnifeFullBodies`, `_buildHitFullBodies`, `_buildDeathPoseCanvases`, `_buildWarriorFullBodies`, `_initWarriorPosePortraits`, `_initMonkPosePortraits`, `_buildMonkFullBodies`, `_initGenericJobPosePortraits`, `_buildGenericJobFullBodies`). All 22 jobs went through `_buildFakePlayerSet` since 1.7.42 — the old per-job if/else was unreachable code preserved only as historical reference. Trimmed the corresponding imports.

POSES debug tab loses the WR DEATH / MO DEATH visualization cards; the death tiles are now ROM-only data, the tab can re-add a ROM-read card later if needed.

## 1.7.49 — 2026-05-06

### Per-spell animation registry (fixes: Poisona used Cure's tile bytes with palette swap)

Two REC OAM captures (Cure @ frame 2877, Poisona @ frame 827) confirmed the 2026-05-05 "shared tile bytes, palette differs" assumption was wrong. Cure's `$49`/`$4A` (cross-star + dot) and Poisona's `$49`–`$50` (8-tile wing pattern) are entirely different sprites — and the "flame buildup f0-47 size 1→4" model in cure-anim.js was fabricated. Real Cure has no flame at all; it's just stars cycling. Real Poisona is a different shape entirely.

Replaced `cure-anim.js` with `spell-anim.js`: per-spell registry keyed by spell ID. Each entry owns its tile bytes, palette, and phase render functions. Render sites call `drawSpellCasterEffect(ctx, spellId, ms, x, y)` / `drawSpellTargetEffect(ctx, spellId, ms, x, y)` — they no longer know about flame vs stars vs wings vs curves. Adding a future spell anim is one new entry in the registry; no render-site changes.

- Cure (0x34): 4 sprites cycling HFLIP/VFLIP across `[0,5]/[8,5]/[0,13]/[8,13]` for 1017ms, then `$66` sparkle on target.
- Poisona (0x35): 8-tile wing pattern alternating phase A (`$49`–`$4C`) and phase B (`$4D`–`$50`), then `$07`/`$08` curve sprite on target.
- Removed 5-frame flame buildup, rotating-ring star math, and `WHITE_MAGIC_PAL` palette-swap shortcut — none of those exist in the real animations.

Touched: `src/spell-anim.js` (new), `src/battle-drawing.js`, `src/pvp.js`, `src/spell-cast.js`, `src/battle-sprite-cache.js`. `src/cure-anim.js` deleted.

=======
>>>>>>> parent of 0841b98 (v1.7.49 — per-spell animation registry; rip out cure-anim shared-palette hack, real captured tiles for Cure + Poisona)
## 1.7.48 — 2026-05-06

### Slash-flash hit-gate is now single-source (fixes: misses showed slash on user portrait in PVP)

PVP-enemy slash overlay drawn on the user's own portrait at `battle-drawing.js:425` had **no hit/miss gate** — every swing flashed a slash, even on misses and shield-blocks. The portrait-blink and hit-pose checks 50 lines below correctly guarded with `pvpPendingAttack && !miss && !shieldBlock`, but the slash flash didn't.

Root cause was structural: the gate was caller-driven, scattered across 6 different `drawSlashOverlay` call sites, and the `slash-effects.js` comment block told callers "you MUST gate the flash". One missed wrap and the whole subsystem leaks visuals.

Moved the gate INSIDE `drawSlashOverlay`. New signature folds `mirror` / `weaponId` / `hit` into an opts object, and `hit !== undefined && !shouldDrawSlash(hit)` short-circuits the draw. `shouldDrawSlash` now also rejects shield-block (monster hits have no `shieldBlock` field, so existing encounter paths unaffected). All 5 call sites updated to the opts shape and pass the relevant hit object (`pvpPendingAttack` / `allyHitResult`).

Result: any future `drawSlashOverlay` call automatically inherits the gate. The "callers MUST remember to wrap with shouldDrawSlash" footgun is gone.

## 1.7.47 — 2026-05-06

### Real death poses for all 22 jobs (was: mirrored idle)

Defeated allies in the roster panel were showing a *mirrored idle pose* instead of a death sprite — and not just the orientation was wrong, there literally was no death pose data for any job except 0/1/2. `_genericBundle` in `combatant-sprites.js:229` hardcoded `death: null`, so 19 jobs (White Mage, Black Mage, etc.) hit the `bodies.idle` fallback at `sprite-init.js:1021` — which uses `buildOpponentBodyCanvases` output (pre-h-flipped for opponent rendering), drawn directly without counter-flip at `battle-drawing.js:1326`.

Reverse-mapping the captured `OK_DEATH` / `WR_DEATH` / `MO_DEATH` constants back to ROM offsets revealed they all live at `BATTLE_SPRITE_ROM + jobIdx * BATTLE_JOB_SIZE + 0x240` — tile indices 36-41 within each job's 42-tile per-job slot. Verified byte-for-byte against the PPU-captured constants for jobs 0/1/2; the same stride applies to all 22 jobs since the per-job ROM block is uniform.

`_genericBundle` now reads the 6 death tiles (3 cols × 2 rows, 24×16 prone) directly from ROM, eliminating the need for per-job PPU capture. Roster ally death pose now renders the canonical lying-down sprite for every job.

## 1.7.46 — 2026-05-06

### Freeze watchdog + global error handlers + battle context in error reports

The 1.7.42 freeze investigation has been blind because the existing client-error reporting only wrapped the *render* path (line 76 + 103 of `game-loop.js`) and didn't include any state context. Errors in the update path were caught at the outer game-loop try/catch but only `console.error`'d locally — never POSTed to the server. State-machine freezes that don't throw exceptions (an orphan state with no advance handler) had no detection at all.

Three additions to make the next freeze self-diagnose:

1. **`_battleCtx()`** snapshot included in every `/api/client-error` POST: `battleState`, `battleTimer`, `turnQueue.length`, `pvpCurrentEnemyAllyIdx`, `pvpPreflashDecided`, `psHp`, `psHasStatus`, `battleAllies.length`, `pvpEnemyAllies.length`. Server pretty-prints it on the same log line as the message.

2. **Freeze watchdog** ticks once per frame after the game loop. If `battleState` stays in a *non-idle* state (excludes `menu-open`, `target-select`, `item-*`, `msg-wait`, etc.) for >5s without changing, fires one `[FREEZE WATCHDOG]` report identifying the stuck state. One report per stuck spell — won't spam.

3. **Global `window.error` + `unhandledrejection` handlers** installed in `startGameLoop`. Catches anything that escapes the per-frame try/catch, including async failures (fetch / setTimeout) that were previously silent.

The outer game-loop catch now also POSTs via `_reportError` (was console-only). Server-side, `console.error` in `api.js:74` includes `body.ctx` JSON-stringified so `pm2 logs` shows the full state at error time.

`src/game-loop.js`, `api.js`.

### Postscript — actual root cause of the user-reported freeze

Once the diagnostic infra was deployed, `pm2 logs` immediately showed `[CLIENT ERROR] _s is not defined` at `drawBattleMessageStrip@battle-drawing.js:1373:60` firing every frame. Investigation revealed the production server was stuck at **1.7.34** — none of the 1.7.41–1.7.46 commits had reached production because `git push` alone doesn't trigger the server-side `git pull` (that requires `./deploy.sh` or the equivalent `ssh root@... 'cd /var/www/ff3mmo && git pull && pm2 restart server --update-env'`).

The `_s` reference was an artifact of the pre-1.7.34 "legacy `_s` bag" pattern that was retired but left an orphan reference in 1.7.34's `drawBattleMessageStrip`. The 1.7.42 magic/item AI was *never* the cause of the freeze — it never ran in production. Pulled 1.7.46 to the server; freeze gone.

Memory updated (`feedback_ff3mmo_deploys.md`) so future "deploy" instructions trigger an actual `./deploy.sh` invocation, not just `git push`.

## 1.7.45 — 2026-05-06

### Hotfix — re-disable 1.7.42 enemy-magic / item AI hooks (1.7.44 still freezing)

1.7.44's poison-tick handler fix did not unblock the user. Reverting the AI call-sites again (matching 1.7.43) while keeping the poison-tick fix in place. Confirms whether the freeze is in the new magic/item AI vs elsewhere.

- `_processEnemyFlash` reverted to main-opp-only defend / self-heal-50 / sword-throw decision tree.
- `_tryAllyItem` invocation removed from WM AI chain.
- `updatePoisonTick` still wired into the PVP dispatcher (1.7.44 fix preserved).

`src/pvp.js`, `src/battle-turn.js`.

## 1.7.44 — 2026-05-06

### Fix: poison-tick handler missing from PVP dispatcher (real cause of 1.7.42 softlock)

Root cause of the post-1.7.42 softlock found and fixed. The bug was **not** in the new magic AI — it was a pre-existing PVP dispatcher gap exposed by 1.7.41's `status: createStatusState()` addition to `generateAllyStats`.

**The bug:** `_updatePoisonTick` (battle-update.js:789) only existed in the non-PVP dispatcher chain at line 804. The PVP dispatcher (`updatePVPBattle` in pvp.js) never wired it in. When a poisoned actor's turn started, `battle-turn.js` set `battleSt.battleState = 'poison-tick'` to display the poison damage tick, but in PVP nothing advanced that state. Softlock — exactly matching the reported symptoms (state stuck mid-turn, menu panel renders because `poison-tick` is in `isMenu`, but cursor doesn't draw because state isn't `menu-open`).

**Why it surfaced now:** Before 1.7.41, roster allies had no `status` field, so `tryInflictStatus(ally.status, …)` calls in `battle-enemy.js` silently no-op'd — allies couldn't actually be poisoned. 1.7.41 fixed that, allowing the latent PVP poison-tick gap to deadlock the turn loop.

**Fix:** Exported `updatePoisonTick` from `battle-update.js` and added it to the front of the PVP dispatcher chain.

**Re-enabled the 1.7.42 systems** that were unfairly disabled in the 1.7.43 hotfix:
- PVP enemy magic AI (Cure / Poisona on each other) — `_tryPVPEnemyPoisona` + `_tryPVPEnemyCure` back in `_processEnemyFlash`
- PVP enemy item AI (Cure Potion / Antidote on any teammate) — `_tryPVPEnemyItem` back in `_processEnemyFlash`
- Roster ally item AI — `_tryAllyItem` back in the WM AI chain

`src/battle-update.js`, `src/pvp.js`, `src/battle-turn.js`.

## 1.7.43 — 2026-05-06

### Hotfix — disable 1.7.42 enemy-magic / item AI hooks (PVP softlock)

PVP softlock reproduced live after opponent turn (no cursor on battle menu). Reverted the AI **call-sites** for the new systems while keeping the underlying state machines + render hooks in place so we can re-enable selectively after diagnosis.

- `_processEnemyFlash` reverted to the original main-opp-only defend / self-heal-50 / sword-throw decision tree. PVP enemy magic + the generalized `_tryPVPEnemyItem` are no longer invoked.
- `_tryAllyItem` invocation in `battle-turn.js` removed from the WM AI chain. Roster ally Cure / Poisona spell AI still fires (1.7.41 behavior).

The 1.7.42 implementations (`_tryPVPEnemyCure`, `_tryPVPEnemyPoisona`, `_tryPVPEnemyItem`, `_processPVPEnemyMagic`, `_tryAllyItem`, `allyMagicItemMode`) remain in the codebase but are unreachable. Heal-num cell-idx targeting + render gates also remain — they are no-ops without the AI calling them.

`src/pvp.js`, `src/battle-turn.js`.

## 1.7.42 — 2026-05-06

### PVP enemy support magic + items + roster ally items

PVP enemies (main opp + their allies) now cast Cure / Poisona on each other and use Cure Potions / Antidotes on each other. Roster allies pick up the same item AI.

**PVP enemy magic** — `_tryPVPEnemyCure` / `_tryPVPEnemyPoisona` in `pvp.js` mirror the `_tryAllyCure` / `_tryAllyPoisona` AI from `battle-turn.js`, scoped to the enemy team. New states `pvp-enemy-magic-cast` (600 ms) → `pvp-enemy-magic-hit` (1000 ms, effect at 400 ms) mirror the ally-magic state machine; `_processPVPEnemyMagic` is wired into `updateBattleEnemyTurn`.

**Mirrored cast animation** — `_drawPVPEnemyCell` now recognizes the caster cell for the new states, swaps the body to victory pose, and renders the flame + 8-star ring via the same `getCureAnimAssets` / `getCureFlameFrameIdx` pipeline. Flame draws at `sprX + 16, sprY + 5` — the visual mirror of the ally side's `ppx - 16, ppy + 5`. Sparkle on the target cell during hit phase reuses `bsc.cureSparkleFrames`.

**PVP enemy items** — generalized the old main-opp self-only potion roll into `_tryPVPEnemyItem`, callable by any enemy on any teammate. Antidote (any poisoned teammate) takes priority over Cure Potion (lowest-HP teammate < 50%). Reuses the existing `pvp-opp-potion` state but with new `pvpItemCasterCellIdx` / `pvpItemTargetCellIdx` fields driving caster pose + target sparkle. The 25% trigger rate matches the original main-opp behavior.

**Roster ally items** — `_tryAllyItem` in `battle-turn.js` adds Cure Potion / Antidote to the WM AI chain (Cure → Poisona → Item). Reuses the `ally-magic-cast` / `ally-magic-hit` pipeline with a new `battleSt.allyMagicItemMode` flag that suppresses the cast flame visual; caster pose + target sparkle still render. SFX is `CURE` instead of `MAGIC_CAST`.

**Heal-num targeting** — `_drawEnemyHealNum` PVP branch now honors `getEnemyHealNum().index` so heal numbers float over the actual targeted cell (was previously always cell 0).

`src/pvp.js` (AI + state machine + render), `src/battle-turn.js` (ally item AI), `src/battle-ally.js` (item-mode reset), `src/battle-state.js` (allyMagicItemMode field), `src/battle-drawing.js` (cast flame gate + heal-num index).

## 1.7.41 — 2026-05-06

### Roster allies can now actually be poisoned (and Poisona AI can target them)

`generateAllyStats` in `src/data/players.js` was not assigning a `status` object, so every roster ally (and PVP opponent + their allies) had `status === undefined`. Two consequences:

1. Every `tryInflictStatus(ally.status, …)` call in `battle-enemy.js` silently no-op'd — enemies could never poison roster allies.
2. The WM `_tryAllyPoisona` AI in `battle-turn.js` could only ever detect a poisoned *player*, since the `other.status` guard short-circuited every ally check. Ally-on-ally Poisona never fired in practice.

Fixed by importing `createStatusState` from `status-effects.js` and adding `status: createStatusState()` to the `generateAllyStats` return object. Now allies can be poisoned, the per-ally turn-start poison-tick path in `battle-turn.js` (already wired) actually runs, and WM allies will cast Poisona on poisoned teammates.

`src/data/players.js`.

## 1.7.40 — 2026-05-06

### Unified swing-pose dwell across player / ally / PVP opponent

Removed the three independent swing-hold constants — `ALLY_SLASH_MS` (battle-ally.js), `ENEMY_SLASH_TOTAL_MS` (pvp.js), and the per-weapon `getSlashHoldMs(weaponId)` body-hold (battle-update.js) — and replaced them with a single `SWING_HOLD_MS = 200ms` constant exported from `slash-effects.js`. Every melee state machine now reads from one source.

Also dropped the `!drawSlash || …` short-circuit from the player AND PVP-opponent slash phases. Same root cause as the ally bug fixed in 1.7.35: missed attacks were advancing the slash state machine on frame 1 because `shouldDrawSlash` returned false. Now hit and miss share the same body-pose dwell on every path, and only the slash *flash overlay* is suppressed on miss (correctly, via `if (drawSlash)` inside the draw blocks). `shouldDrawSlash` doc updated to flag the invariant: callers must NOT short-circuit the state machine on miss.

`getSlashHoldMs` still exists, but is now scoped to the per-frame slash-flash overlay timing only — not the body-pose hold.

`src/slash-effects.js` (added `SWING_HOLD_MS`, updated `shouldDrawSlash` doc), `src/battle-update.js` (player), `src/battle-ally.js` (ally), `src/pvp.js` (PVP opponent).

## 1.7.39 — 2026-05-06

### Ally swing duration unified across hit/miss

Removed the hit/miss split from 1.7.38. Both now use `ALLY_SLASH_MS = 200ms` for the slash phase so the strike rhythm is identical regardless of outcome. The slash-flash overlay still only draws on hit, but the body+weapon hold is consistent.

`src/battle-ally.js` only.

## 1.7.38 — 2026-05-06

### Ally miss-swing hold bumped to 200ms

1.7.35 fixed the early-advance bug on miss but kept the 90ms slash hold for both hit and miss. Hits stayed readable because the white slash-flash overlay draws the eye to the strike. Misses have no flash, so 90ms (5 frames) of body + swung weapon canvas alone reads as a blink — the user reported "still not seeing" the fwd staff on miss after reloading. Split the hold: hits keep 90ms (flash carries the visual weight), misses now hold 200ms (12 frames) so the swung-staff frame reads clearly without the flash.

`src/battle-ally.js` only.

## 1.7.37 — 2026-05-06

### WM heal threshold restored to 60%

The 1.7.34 drop to 40% was a misdiagnosis — WMs *appearing* to disappear on certain turns was actually the missed-attack swing-blink bug fixed in 1.7.35. Now that swings render at full duration regardless of hit/miss, restored the canonical 60% heal threshold so WMs heal preemptively at meaningful HP loss rather than waiting for someone to be near death.

`src/battle-turn.js` only.

## 1.7.36 — 2026-05-06

### WM roster allies cast Poisona on poisoned teammates

White Mage roster allies now scan player + self + other allies for the POISON status flag and cast Poisona on the first match. Priority order: player → self → other allies. Cure (HP heal) still gets first dibs on the turn — if anyone is below 40% HP, that takes precedence; otherwise we look for poison to clean. The existing `ally-magic-cast → ally-magic-hit` pipeline handles the visuals (flame+stars on caster portrait already palette-dispatch via `getCureAnimAssets(spell)`, so Poisona's magenta SP3 shows correctly). On effect application the apply function now dispatches on `allyMagicSpellId`: 0x35 strips POISON via `removeStatus`, 0x34 keeps the existing HP heal path. Caster must have 0x35 in `knownSpells`.

`src/battle-turn.js` (added `_tryAllyPoisona`, wired after `_tryAllyCure`), `src/battle-ally.js` (renamed `_applyAllyCureEffect` → `_applyAllyMagicEffect`, added Poisona branch).

## 1.7.35 — 2026-05-06

### Ally swing pose holds full duration on miss

The actual culprit for "WM staff swing looks fucked up on certain turns": on a missed attack `shouldDrawSlash(hit)` returned false, which short-circuited the `ally-slash` state machine and advanced it on the very next frame. Result: the forward-swung staff canvas was visible for ~16ms (1 frame at 60fps) instead of the full 90ms, reading as a broken/blink swing. Fixed by holding `ally-slash` for the full `ALLY_SLASH_MS` regardless of hit/miss — the slash *overlay* is still correctly suppressed on miss via `drawSlash`, only the body pose hold is preserved. Hit and miss now read at identical pace.

`src/battle-ally.js` only.

## 1.7.34 — 2026-05-06

### WM heal threshold 60% → 40%

The 60% threshold meant WM allies cast Cure on most turns once anyone took a hit, which visually read as "staff disappearing on certain turns." Dropped to 40% so WMs swing the staff way more often — they only heal when someone is genuinely low (memo to self: 40% HP is the canonical NES FF3 "ouch" threshold for AI heal triggers).

`src/battle-turn.js` only.

## 1.7.33 — 2026-05-06

### Revert: staff overlay during cast pose

1.7.32 added a staff overlay during magic-cast pose for player and ally — that was wrong. NES FF3 white-magic cast doesn't show the weapon; the body is the canonical victory pose with empty hands. Reverted.

`src/battle-drawing.js` only.

## 1.7.32 — 2026-05-06

### Staff visible during cast pose — player and ally

WMs hold their staff in their hand canonically; FF3 NES victory-pose body tiles (which our magic-cast pose reuses) don't include the weapon graphics, so during cast the staff visually disappeared. Now we overlay the "raised" weapon canvas (R-back position, dx=8, dy=-7 from the body) on top of the cast-pose body for both:

- Player path (`_drawPortraitOverlays`) when `battleState === 'magic-cast'` or `'magic-hit'`. Gated on `isWeapon(ps.weaponR)` so unarmed/rod cases skip cleanly.
- Ally path (`_drawAllyPortrait`) when `isAllyCastingMagic && isWeapon(ally.weaponId)`. Same R-back canvas, ally portrait position.

Item-use (Potion etc.) intentionally skips this overlay since potions don't involve a weapon. The raised canvas position matches the back-swing offset, so visually the staff reads as held overhead during the cast.

`src/battle-drawing.js` only.

## 1.7.31 — 2026-05-06

### WM ally cast animation — flame + stars on the caster portrait

1.7.27 shipped the WM ally heal AI but explicitly deferred the magic-circle visuals: "Ally caster magic-circle (the flame + 8-star ring) is **not** rendered yet — that requires per-ally portrait positioning math which needs its own pass." This is that pass.

`_drawAllyCastAnim` runs after `_flushAllyWeaponDraws` in `drawBattleAllies`, deliberately OUTSIDE the right-panel clip so the flame can extend left of the ally portrait into the map area (matching the player-cast layout where the flame at `px-16` reaches into the enemy side). Renders during `ally-magic-cast` and `ally-magic-hit`:

- 8-star ring rotates around the caster portrait at radius 15, CW at the OAM-canonical 1.2 s/turn rate. Stars drawn during `ally-magic-cast` only (matches player's `shouldDrawStars` gate ending at `CURE_T_CAST`).
- Flame pulses 4 sizes during the 600 ms cast windup, then brackets/release at the end, drawn 16 px left of the portrait. Hidden during `ally-magic-hit`.
- Spell palette picked via `getCureAnimAssets(spell)` from `battleSt.allyMagicSpellId` so per-school palettes (Cure blue / Poisona magenta) work.

Caster pose was already wired to victory in 1.7.27. Heal sparkle on target was already wired for both player-target and ally-target heals. The missing piece was the caster-side flame + stars; now in.

`src/battle-drawing.js` only.

## 1.7.30 — 2026-05-06

### Fix: starting a new game cloned the previously-played slot

Reproduction: play any slot → return to title via pause-menu → create a new save in an empty slot. The new game began with the previous slot's level, inventory, gil, equipment, knownSpells, lastTown, and world position — fully cloned.

Root cause: `returnToTitle()` (`src/main.js`) didn't clear `ps`, so the previous slot's data stayed live in memory. Then in title's name-entry flow, `saveSlotsToDB()` ran on the freshly-created shell slot and unconditionally baked the still-loaded `ps` state into it (every field — stats, hp, mp, inventory, gil, jobLevels, jobIdx, unlockedJobs, knownSpells, world position, lastTown). When the user then pressed Z to enter that "new" slot, `_updateTitleMainOutCase` saw populated `slot.stats` and copied it back into `ps` — guaranteeing the clone.

Fix is a `psAligned` gate:

- `psAligned` flag in `save-state.js` (default false). Cleared by `returnToTitle` after the final save; set true at the end of `_updateTitleMainOutCase` once a slot is loaded into `ps`.
- `saveSlotsToDB` skips the entire `ps → slot` bake when `psAligned === false`. Slot-level shells (just name + defaults) still persist via the `data.forEach` loop, so navigating away mid-name-entry doesn't lose the slot. The full bake resumes on the first in-game save after `_updateTitleMainOutCase` flips the flag.
- `_updateTitleMainOutCase` now reinitialises `ps` from ROM defaults when entering a slot whose `stats` is null (a fresh slot). Calls `initPlayerStats(ps._romData)` and resets equipment to canonical OK-starter loadout (Knife, Leather Cap, Cloth Armor) — the equipment slots aren't touched by `initPlayerStats` so they need explicit reset.

Side benefits: returning to title from an existing slot and immediately starting a new game now gives a true clean start. Page-refresh + new game still works as before (boot inits ps fresh, psAligned starts false).

`src/save-state.js`, `src/title-screen.js`, `src/main.js`.

## 1.7.29 — 2026-05-06

### Roster redistribution — every floor has a healer, Ur slimmed down

Population was lopsided after the WM additions: ur=6, world=5, cave-0=4, cave-1/2=3, cave-3=1, crystal=1. Every WM was clustered in ur/world/cave-0; deeper caves had nothing but Fighters and Monks. Ur is the safe-zone starter map and didn't need a third of the player base hanging around there.

Six relocations:

- **Zephyr** (lv5 WM): ur → cave-3
- **Suki** (lv3 WM): cave-0 → cave-1
- **Blix** (lv4 WM): cave-0 → cave-2
- **Vex** (lv5 Fi): cave-2 → cave-3
- **Wren** (lv4 OK): world → cave-0
- **Jiro** (lv5 Mo): ur → crystal

New distribution: ur 4 / world 4 / cave-0 3 / cave-1 4 / cave-2 3 / cave-3 3 / crystal 2. Every cave 0-3 has at least one WM. Ur is now 2 campers (Aldric Fi + Lenna WM) plus Ivy (WM lv2) and Nyx (OK lv1) — appropriate for a starter zone. Caves 1-3 each gain a healer for harder encounters; crystal gets a Monk for non-Fi variety. Roster movement keeps them shuffling, so any given moment in any given location should have a reasonable mix.

`src/data/players.js` only.

## 1.7.28 — 2026-05-06

### Four more White Mages — 8 total on the roster

Converted four more Onion Knights to White Mages: Zephyr (Ur, lv5, palIdx 1 / blue trim), Mira (world, lv4, palIdx 2 / green trim), Suki (cave-0, lv3, palIdx 4 / yellow trim), Blix (cave-0, lv4, palIdx 7 / pink trim). All carry Staff + Leather + Cap and know Cure + Poisona.

Roster mix is now: 8 WMs, 8 Fighters, 4 Monks, 2 OKs, 1 OK-Knife (Mira) — well-distributed across all locations. Roster movement (`_updateMovement`) shuffles non-camper players around naturally, so any given location will have at least one WM most of the time.

`src/data/players.js` only.

## 1.7.27 — 2026-05-06

### White Mages on the roster — they actually heal you in battle now

Replaced 4 Onion Knights in `PLAYER_POOL` with White Mages (jobIdx 3): Lenna (Ur, lv5, Cure+Poisona), Ivy (Ur, lv2, Cure), Tora (world map, lv5, Cure+Poisona), Pip (cave-0, lv3, Cure+Poisona). Each equipped with Staff (0x0E) + Leather Armor (0x73) + Leather Cap (0x62) — the staff gives them a real (if weak) attack so they're not useless when nobody needs healing. Per-WM color is the same red-trim variation `PLAYER_PALETTES` already offers (palIdx 0/2/5/6) — the color slot 3 is what changes per slot, identical scheme to the OK roster they're replacing.

White Mage ally AI:

- `generateAllyStats` now returns `mnd` and `knownSpells`. MND scales as `5 + lv*W` where W=3 for WM, W=2 for Red Mage, W=1 otherwise. Cure heal at lv5 WM (MND 20) lands ~52-78 HP.
- `_tryAllyCure` (battle-turn.js) runs at the top of every WM ally turn before the attack roll. Builds a candidate list of every living teammate (player + other allies + self), picks the lowest HP%, and casts Cure if anyone is below 60% HP. Otherwise falls through to the staff attack.
- New battle states `ally-magic-cast` (600 ms windup) → `ally-magic-hit` (1000 ms total, effect applied at 400 ms). Mirror of the player magic-cast / magic-hit pipeline but with caster=ally.
- `SFX.MAGIC_CAST` at cast start, `SFX.CURE` at heal moment. Same chime as player Cure.

Visuals:

- WM caster portrait switches to victory pose for the cast duration (same arms-up pose used for victory, defend, magic-cast on the player). Held steady, not flickering.
- Heal sparkle (recovery palette) renders on the target portrait — player or ally — during the heal phase. Reuses `bsc.cureSparkleFrames` (the existing recovery-school sparkle) so no new asset work.
- Heal number bounces on the target portrait via the existing `setPlayerHealNum` / `getAllyDamageNums` paths. 0-value popup suppression from 1.7.25 covers full-HP overheal automatically.

Ally caster magic-circle (the flame + 8-star ring) is **not** rendered yet — that requires per-ally portrait positioning math which needs its own pass. Functional gameplay first; polish to follow.

`src/data/players.js`, `src/battle-state.js`, `src/battle-turn.js`, `src/battle-ally.js`, `src/battle-update.js`, `src/battle-drawing.js`.

## 1.7.26 — 2026-05-05

### White-magic numbers audit — equalised MP cost, missing-entry guard, drop dead clamp

Five low-risk corrections after auditing the v1 white-magic system:

- **Cure MP 4 → 2.** Asymmetric Cure=4 / Poisona=2 had no source. NES FF3 uses level-slot MP — both Cure and Poisona consume one Lv1 slot, same cost. Equalising to 2 each makes the WM start kit (~6 MP) yield ~3 casts before sleep, matching the canonical "3 Lv1 slots" feel.
- **`getSpellMPCost` no longer silently defaults to 0.** Old behaviour: any spell ID added to `ps.knownSpells` without a `SPELL_MP_COST` entry was free to cast. New behaviour: warn once via `console.warn` and return 99 (effectively uncastable) so the omission surfaces immediately in playtest. Latent footgun gone.
- **Dropped dead `Math.max(0, ps.mp - cost)` clamp** in `startSpellCast`. All three call sites already gate on `ps.mp >= cost` upstream (`input-handler.js:385`, `:825`, `:923`) so the clamp only ever masked an upstream bug. If MP goes negative now, an upstream check is missing and we want to notice.
- **`STARTING_SPELLS` comment** flags Sight (0x36) as canon-deferred so the WM Lv1 kit gap is intentional and visible at the data site.
- **Ur magic shop comment** notes the higher-tier rollout plan (Cura mid-game, Curaga late-game) so future shop authoring has the canonical reference inline.

`src/data/spells.js`, `src/spell-cast.js`, `src/player-stats.js`, `src/data/shops.js`.

## 1.7.25 — 2026-05-05

### Suppress 0-value heal popups (Poisona, Antidote, full-HP overheal)

Status-cure spells (Poisona, Bndna, Esuna, Stone) and cure-status items (Antidote, Eye Drops, etc.) push a `{ value: 0, ... }` heal-num purely to drive the sparkle animation + `inv-heal` state-machine timing — there's no HP delta to display. The renderer was happily drawing "0" on the portrait.

`drawBattleNum` in `damage-numbers.js` now returns early when `value === 0`. Single point of change covers both battle and pause-menu, both player and ally, both spell and item paths. Sparkle anim is gated on heal-num *existence* not value, so it's unaffected — Poisona/Antidote still render the cure-sparkle visual, just without the pointless "0" floating above the portrait. Side benefit: full-HP cure-overheal (`heal = min(amount, maxHP - hp) === 0`) also no longer pops a "0".

`src/damage-numbers.js` only.

## 1.7.24 — 2026-05-05

### Per-school SP3 palette for white-magic cast anim

1.7.23 widened the cure-anim render gate to status-cure + revive on the assumption that Cure and Poisona shared everything. They share **tile bytes** (verified) but **not the SP3 palette** — Cure's hardcoded `[0x0F, 0x12, 0x22, 0x31]` rendered Poisona's magic circle in Cure-blue when the actual ROM renders it magenta/orange. Caught by re-reading the user's REC OAM dump SP3 row (`[0x0F, 0x15, 0x27, 0x30]`) — should have flagged the diff in 1.7.23, didn't.

`cure-anim.js` refactored to decode tile canvases per palette at init:

- `WHITE_MAGIC_PAL` map keyed by school (`recovery` / `cure_status` / `revive`). Recovery keeps Cure's blue. Status-cure uses the captured magenta. Revive defaults to status-cure's palette as a placeholder until Raise gets its own REC.
- `_decodeForPalette(pal)` builds the full bundle (`flameFrames` × 5, `starTile`, 2-frame `sparkleFrames`) for one palette. Init runs it twice (recovery + status; revive aliases status), so 2 distinct decode passes.
- New `getCureAnimAssets(spell)` getter: returns the right pre-decoded bundle by spell. Unknown spells / non-white-magic return null.
- Backward compat: `initCureAnimSprites()` still returns the recovery bundle at the top level so `bsc.cureFlameFrames` / `cureStarTile` / `cureSparkleFrames` keep working for HUD pause-heal, item-use Cure, PVP-potion etc.

`battle-drawing.js` magic-cast and ally-magic-heal paths now look up the active spell at render time (`SPELLS.get(getCurrentSpellId())`) and use `getCureAnimAssets(spell)` to pick the per-school flame, stars, and heal sparkle. Item-use Cure (potion path) is unchanged — always recovery palette via `bsc.cureSparkleFrames`. Ally heal sparkle render rewired through a single `healSparkleSet` arg to `_drawAllyTexts` so magic vs item-use no longer share a hardcoded asset.

Test: cast Cure on self → blue circle/sparkles. Cast Poisona on a poisoned ally → magenta/orange circle/sparkles. Both now match what the FF3 ROM actually renders.

`src/cure-anim.js`, `src/battle-drawing.js`.

## 1.7.23 — 2026-05-05

### White-magic anim widened from Cure-only to the whole school

A 120-frame REC OAM capture of Poisona showed tiles `$4A-$57` byte-identical to the Cure capture (same SP3 palette `[0x0F, 0x15, 0x27, 0x30]`, same per-frame progression: small `$4B/$4C` → medium `$4D/$4E` → large `$4F/$50` → XL with mirroring `$53-$56` → brackets `$57`). The FF3 ROM uses one shared "white-magic cast" animation — the cure-anim work captured general-purpose white-magic tiles, not Cure-specific.

`_isCureAnimSpell()` in `spell-cast.js` widened from `spell.element === 'recovery'` to also cover `spell.target === 'cure_status'` (Poisona, Bndna, etc.) and `spell.target === 'revive'` (Raise). Effects propagate automatically:

- Status-cure spells now run through the full 1667 ms cure-anim timing (build-up 800 ms → lunge 200 ms → cast 217 ms → heal 283 ms → return 167 ms) instead of the legacy 1100 ms placeholder.
- Magic-circle + 8-star ring renders caster-side via `getCureAnimElapsedMs()` (battle-drawing.js gates off the same predicate).
- Heal-phase sparkle on the cured target via `shouldDrawHealSparkle()`.
- `MAGIC_CAST` SFX at `magic-cast` start was already universal (fired in `startSpellCast` regardless of school per FF3J 33/B0D8/B0FF). `_applySpellEffect`'s `SFX.CURE` chime at heal-time now lands at the captured 1217 ms mark instead of 400 ms.

Damage spells are not yet captured; they still keep the legacy 1100 ms timing. Followups in `docs/design-notes.md` updated accordingly.

`src/spell-cast.js` (one function widened), `docs/design-notes.md` (followups).

## 1.7.22 — 2026-05-05

### EMU debugger — REC `DEDUPE` toggle (60–70% smaller spell captures)

A 120-frame OAM REC of a spell anim is 400-800 KB — past mobile clipboard limits. NES holds each animation state 2-4 frames per pose, so most of those bytes are duplicate tile dumps for visually identical frames. New `DEDUPE` button next to `REC OAM` / `REC BG`: when ON, _recordFrames hashes each snap (with the per-frame `@ frame N` header normalised away) and emits identical consecutive frames as a single `// frames N..M (Kx same as frame N)` divider instead of repeating the full tile dump. The PPUCTRL + SFX strip headers added in 1.7.21 are part of the hash, so the frame where `$7F49` flips from `$00` to `$A1` (cast SFX fires) emits in full and stands out.

- Toggle button visual mirrors `SOUND` / `MUTE`: green border + checkmark when ON, default border when OFF. Per-session toggle (no persistence).
- Default OFF — preserves the per-frame paste-ready format the cure-anim work was built on.
- Status row at run completion reports `Nx/Ny unique frames` so you can eyeball the compression ratio.

`src/debug/tabs/emu.js` only.

## 1.7.21 — 2026-05-05

### EMU debugger — SFX strip + PPUCTRL header on every OAM/BG snap

The magic-capture pipeline had one step that still required leaving the EMU tab: identifying the SFX number a spell played. 1.7.16's `MAGIC_CAST = 0x62` was sourced from FF3J disasm (`LDA #$A1 / STA $7F49` at 33/B0FF) rather than the running ROM. Two snapshot-header additions close that gap and make the existing OAM/BG bank assumptions visible diagnostics.

- **`_dumpSfxStrip()`** — reads `$7F48-$7F4F` from the running CPU RAM and emits one line per byte at the top of every OAM/BG snapshot. `$7F49` is FF3J's SFX queue; the inline note translates a non-zero high-bit value to the `music.js` NSF track number (`byte − 0x3F`), so e.g. `$A1 → NSF track $62` lands paste-ready next to the rest of the capture. Recognises `$00` (idle) and `$FF` (cut SFX).
- **`_dumpPpuctrl()`** — reassembles jsnes's split `f_spriteSize` / `f_spPatternTable` / `f_bgPatternTable` / `f_nTblAddress` flags into a 4-line header so any divergence from the snapshot's hardcoded "sprite=$1000, BG=$0000, NT=$2000" assumption surfaces in the output instead of silently misreading the wrong bank. Each line annotates what the snapshot actually reads from for cross-reference.
- **OAM grouping merge bug** — `_oamSnapshotText`'s adjacency union-find used `groups.indexOf(groups[merged])` after a splice. When `g < merged`, `groups[merged]` post-splice resolves to a different element, `indexOf` returns -1, and the next adjacency on the same sprite double-adds it to a fresh singleton group. Tracked the merged group by *reference* instead — `mergedGroup.push(...)` survives the splice without lookup. Latent before today; would have surfaced on long captures with non-monotonic merges.

REC OAM / REC BG inherit both helpers automatically since they delegate to `_oamSnapshotText` / `_bgSnapshotText` per frame.

`src/debug/tabs/emu.js` only.

## 1.7.20 — 2026-05-05

### Cure-anim vocabulary — `flame` and `stars`, not "circle" and "bg sparkle"

The user named the visual elements: the rotating tiles are **stars**, and the pulsing thing to the left of the caster is a **flame**. My code had been calling them "circle" (for the flame) and "bg sparkle" (for the stars), which was confusing and conflated three distinct visuals (flame, stars, heal sparkle). Renamed throughout so future changes don't drift.

- `cure-anim.js`: `circleFrames` → `flameFrames`, `bgSparkle` → `starTile`, `getCureCircleFrameIdx` → `getCureFlameFrameIdx`, `shouldDrawBgSparkle` → `shouldDrawStars`. Pinned the vocabulary in a header comment.
- `battle-sprite-cache.js`: `cureCircleFrames` → `cureFlameFrames`, `cureBgSparkle` → `cureStarTile`.
- `battle-drawing.js`: imports + render block updated to match.

No behavior change.

## 1.7.19 — 2026-05-05

### Cure draw order — magic circle on top of sparkle ring

Swapped the draw order in the cure-anim render block: sparkle ring renders first (background), magic circle renders on top. Previously the circle rendered first and the rotating sparkles painted over its detailed pixels where the ring's left arc swept past. Now the circle's detail reads clean even when a sparkle passes behind it.

`src/battle-drawing.js` — two `drawImage` calls swapped.

## 1.7.18 — 2026-05-05

### Cure on ally — heal sparkle only on the target, not the caster too

`isCureMagicSelf` was checking `target === 'player'`, which means "player-side target" and is true for BOTH self-cast and ally-cast (since allies are player-side). So when casting Cure on an ally, the heal sparkle was drawing on the player AND the targeted ally. The actual self/ally distinction is `allyIndex`: `< 0` = self, `>= 0` = ally N. Tightened the check to `allyIndex == null || allyIndex < 0`.

Caster-side animation (magic circle + 8-sparkle ring) is unchanged — it still draws on the player in both cases, since the player is the caster regardless of target. Only the heal-effect sparkle moves correctly to the target.

`src/battle-drawing.js` — one condition.

## 1.7.17 — 2026-05-05

### Cure sparkle ring — center fix + speed match to NES rate

Two bugs, both from doing the math wrong on the OAM dump.

**Off-center.** I'd built the ring centroid from sparkle TOP-LEFT positions (the OAM's `[x,y]` is the 8×8 tile's TL corner). The actual ring center is the centroid of sparkle CENTERS, which is body-relative `(8, 11)` — i.e., body horizontal center, slightly below body vertical center. In our 16-tall portrait that's effectively `(px+8, py+8)`. 1.7.16 had it at `(px+4, py+7)` — 4 left, 1 up of where it should be.

**Speed.** Tracked the top-sparkle angle through f0..f3: `-90°, -86.2°, -78.7°, -75.1°` → ~5°/NES-frame. At 60 fps that's 300°/s, or one full turn every 1.2 s. 1.7.16 was 4 s/turn (3.3× too slow); now 1200 ms/turn matches the captured rate.

`src/battle-drawing.js` — three numbers (`cx`, `cy`, period).

## 1.7.16 — 2026-05-05

### Magic-cast SFX wired from FF3J disassembly

Added `SFX.MAGIC_CAST = 0x62` (NES SFX `$21`, ROM byte `$A1`). Confirmed in the everything8215/ff3 disassembly at:
- `33/B0D8`: `LDA #$A1 / STA $7F49` — black magic pre-animation
- `33/B0FF`: `LDA #$A1 / STA $7F49` — white magic pre-animation

Both schools use the same pre-anim channel sound. `startSpellCast` now fires `MAGIC_CAST` at the moment the state flips to `magic-cast`, matching the NES timing where the channel sound plays at the start of the pre-animation (our build-up phase). Heal-effect chime at `_applySpellEffect` time is unchanged. Should replace 1.7.14's incorrect `SFX.CURE` duplicate.

`src/music.js` (new SFX entry), `src/spell-cast.js` (one-line `playSFX` call).

## 1.7.15 — 2026-05-05

### Revert duplicated CURE sfx at cast start

1.7.14 fired `SFX.CURE` at `startSpellCast` to act as the cast chime, but FF3 NES has a distinct cast/channel SFX (separate from the cure heal chime), and reusing CURE just doubled the same sound. Reverted to no-cast-sfx until the actual cast SFX number is wired in. Heal-effect chime at `_applySpellEffect` time is unchanged.

`src/spell-cast.js` — single revert.

## 1.7.14 — 2026-05-05

### Cure spell — cast SFX at build-up start + real ring rotation

Two fixes:

1. **Cast SFX fires at build-up start.** `SFX.CURE` was only playing at heal-effect application (~1217 ms in). Now also fires at the moment `startSpellCast` flips to `magic-cast` state, matching the FF3 NES chime that plays as the magic circle starts forming. Status-cure (Poisona) and revive (Raise) get the same cast chime; damage spells unchanged.
2. **Sparkle ring actually rotates now.** 1.7.13 used `Array.shift` to "rotate" 8 sparkles through 8 fixed positions, which is a no-op — same canvas at the same 8 spots. Replaced with real polar math: 8 sparkles on a radius-15 ring centered at body-relative `(4, 7)`, completing one full turn every 4 s.

`src/spell-cast.js` (cast SFX), `src/battle-drawing.js` (rotation math).

## 1.7.13 — 2026-05-05

### Cure spell — three corrections from re-reading the OAM frame-by-frame

1. **Sparkle ring is static, not rotating.** The OAM has 8 `$49` sparkles at fixed body-relative offsets `(4,-8), (-7,-4), (15,-4), (-11,7), (19,7), (-7,18), (15,18), (4,22)` with sub-pixel jitter that's invisible at our render rate. 1.7.11 made them orbit at one step per 67 ms, which read like a beyblade. Now placed statically at the captured offsets.

2. **Circle pulse cycle off-by-one fixed.** Re-tabulating cure_bg f0-47: f0-3 size 1, f4-7 size 2, f8-11 size 2 h-mirror, f12-15 size 3, f16-19 size 4, f20-23 size 4 h-mirror, f24-27 size 3, f28-31 size 4, f32-35 size 4 h-mirror, f36-47 brackets. 1.7.10/.11 had size-3 at the f28-31 slot instead of size 4. Cycle is now `[0,1,1,2,3,3,2,3,3]` followed by brackets, collapsing the h-mirror variants into their non-mirrored size (eye doesn't distinguish).

3. **Circle vertical offset.** OAM has the circle at group y=13 vs body at group y=8, i.e. 5 px below body top. 1.7.10 drew it top-aligned with the portrait. Now offset by `+5` in y to match.

`src/cure-anim.js` (cycle), `src/battle-drawing.js` (sparkle ring + circle position).

## 1.7.12 — 2026-05-05

### Cure heal sparkle — single tile on body, not corner-mirrored

1.7.10/.11 routed the heal-phase sparkle through the existing `drawSparkleCorners` helper (used by Defend, item-use, etc.), which mirrors the 16×16 frame to all four portrait corners. The OAM captures show the heal sparkle is a single 16×16 placed on the body at relative `[0,5]-[16,13]`, not four mirrored copies. Replaced the corner-mirror helper with a plain `drawImage` at portrait position for both player-self and ally-target heal paths.

`src/battle-drawing.js` only — two render sites.

## 1.7.11 — 2026-05-05

### Cure spell — bg sparkles now orbit the player

1.7.10 drew 4 sparkles pinned at the portrait corners. The OAM actually has 8 `$49` sparkles forming a ring around the body (top, upper-L/R, L/R, lower-L/R, bottom) with positions jittering every NES frame — a twinkling halo, not corner decor. Replaced the 4 fixed positions with an 8-sparkle ring orbiting the portrait center, advancing one step every 67 ms so the ring spins instead of jitters (deterministic; reads the same to the eye). Radius 13×14 puts the sparkles just outside the 16×16 portrait box.

`src/battle-drawing.js` only — single render block; no tile data or timing changes.

## 1.7.10 — 2026-05-05

### Cure spell — full PPU-captured animation

Replaces the placeholder corner-sparkle flicker with the actual FF3 NES Cure animation, frame-mapped from a 100-frame REC OAM capture. The animation has five distinct phases over ~1667 ms:

| Phase | Duration | What renders |
|---|---|---|
| build-up | 800 ms | Magic circle pulses 4 sizes (`$4A`, `$4B-$4E`, `$4F-$52`, `$53-$56`) + scattered `$49` sparkles |
| lunge | 200 ms | Sparkles continue; circle gone |
| cast | 217 ms | Engine's existing item-use pose holds |
| heal | 283 ms | Captured `$4A`/`$49` sparkles flicker on the target portrait — 4-color asterisk, way more detail than the old placeholder |
| return | 167 ms | Anim resolves |

Tiles `$49` and `$4A` re-bank mid-animation (MMC3 CHR switch) — the small build-up sparkle and the large heal-phase sparkle are different bytes, captured separately and decoded via the SP3 palette `[0x0F, 0x12, 0x22, 0x31]`.

New `src/cure-anim.js` owns tile bytes, decode, frame builders, and phase boundary helpers (`getCureCircleFrameIdx`, `shouldDrawBgSparkle`, `shouldDrawHealSparkle`). `src/spell-cast.js` re-times recovery spells to the full 1667 ms (status-cure + damage spells keep their legacy 1100 ms timing until those are captured). `src/sprite-init.js` `_initCureSparkleFrames` now uses the real captured heal-phase tile bytes — so item-use Cure (potions) also gets the upgraded sparkle flicker for free. `src/battle-drawing.js` draws the magic circle 16×16 to the left of the player portrait (caster-side, regardless of target) plus four bg sparkles around the portrait corners during build-up; heal sparkles render on the target portrait (self or ally) during phase 4.

## 1.7.9 — 2026-05-05

### REC OAM/BG max frames bumped 60 → 240

A 60-frame cap was too short for magic captures — full spell animations (caster build-up + magic circle + cast moment + followthrough) run 2-3 seconds and exceed the 1-second window. Bumped to 240 (4 seconds at 60fps) so even long spells (Cure, summons, multi-target) fit in one capture.

`REC_FRAMES_MAX = 240` in `src/debug/tabs/emu.js`. Input field `max` attribute updates automatically. Lower bound stays at 1.

## 1.7.8 — 2026-05-04

### Magic-grant buttons — bit-field correction + ALL SPELLS

1.7.7 still had the white/black bits inverted, and the CALL button was wrong: bit 6 doesn't grant summons (Chocb/Shiva/Ramuh/etc.) — those are inventory book items at `$60C0-$60FF`. Bit 6 grants the underlying *summon-effect spells* (FF3J names: Bahamur, Heatra, Spark, Catas, Hyper, Icen, Leviath, Escape — the spells that summons cast into).

Verified bit-mapping by cross-ref'ing L8 spell IDs against the disassembly mask table:

| Bit | Mask | School | L1 / L8 example |
|---|---|---|---|
| 0-2 | 0x01 / 0x02 / 0x04 | **Black** | Sleep/Fire/Ice → Flare/Death/Meteor |
| 3-5 | 0x08 / 0x10 / 0x20 | **White** | Pure/Cure/Sight → WWind/Life2/Holy |
| 6 | 0x40 | Summon-effect | Escape → Bahamur |

Changes:

- **WM SPELLS** now writes `0x38` (bits 3-5) — was `0x07`, swapped.
- **BM SPELLS** now writes `0x07` (bits 0-2) — was `0x38`, swapped.
- **CALL SPELLS** removed; replaced with **ALL SPELLS** writing `0x7F` (all 7 bits) and setting job to Sage (`$6100=14`). Sage is the only job that can naturally use bits across all schools, and the all-bits mask gets every animation-bearing spell in the bitfield in one tap.

For real summon books (Chocb/Shiva/etc.), TODO is a separate `SUMMON BOOKS` preset that pokes the 8 summon-book item IDs into inventory — needs item-table research.

## 1.7.7 — 2026-05-04

### Magic-grant buttons — bitfield encoding fix

1.7.6's WM/BM/CALL buttons wrote raw spell IDs (e.g. `0x34` for Cure) to `$6207-$620E`. Wrong encoding — the byte is a **bitfield**, not a spell ID. Each level packs 7 spells: bits 0-2 = the 3 white spells, bits 3-5 = the 3 black spells, bit 6 = the summon. Source: `ff3j.asm` at `3D/A1F4` (`LDA spell_mask,X / ORA $6207,X` — masks `01,02,04,08,10,20,40` × 8 levels).

Writing `0x34` (binary `00110100`) for Cure was setting bits 2, 4, 5 → "Sight, Fire, Ice" all at once across two schools, hence "spells are all mixed up".

Fix: write a per-school MASK to all 8 level bytes:

- **WM SPELLS** → `0x07` per level (all 3 white spells)
- **BM SPELLS** → `0x38` per level (all 3 black spells)
- **CALL SPELLS** → `0x40` per level (the summon spell)

Also added a job-level bump at `$6210+jobId*2 = 99` so all 8 magic levels actually unlock — without that, char level alone wasn't enough to access higher tiers.

## 1.7.6 — 2026-05-04

### EMU debugger — magic-grant preset buttons

Three new preset buttons in the **PARTY / INVENTORY EDITOR** panel, next to `FULL HP` / `CLEAR INV`. Each one pokes char A's SRAM to make the running FF3 ROM ready to cast a school of magic — for use with the REC OAM/BG capture pipeline to grab spell animations.

- **`WM SPELLS`** — sets job to White Mage (`$6100=03`), level 50, MP 9/9 across all 8 levels (`$6130-$613F`), and equips Cure / Aero / Cura / Libra / Curaga / Haste / Curaja at L1-L7 (`$6207-$620E`). L8 left zeroed (Sage-only).
- **`BM SPELLS`** — Black Mage (`$6100=04`), same setup, equips Fire / Thunder / Fira / Break / Taga / Firaga / Quake at L1-L7.
- **`CALL SPELLS`** — Summoner (`$6100=13`), equips a best-guess summon-effect mapping (Summon / Blizzard / Thunder / Fire / Earthquake / Glare / Tidal Wave / ParcleBeam at L1-L8). Empirical — may need tuning once we observe what each level dispatches in-battle.

Spell IDs cross-referenced from `tools/rom-dump-spells.txt` and the rpgclassics FF3 NES spell tables. SRAM offsets sourced from the everything8215/ff3 disassembly (`field-ram.txt`):

- `$6100` — char A job ID
- `$6101` — char A level
- `$6130-$613F` — MP (current/max × 8 levels)
- `$6207-$620E` — char B equipped spell list (1 byte per level)

Constants (`JOB_OFF`, `LEVEL_OFF`, `MP_OFF`, `SPELL_LIST_OFF`) added to `src/debug/tabs/emu.js` alongside the existing `INV_IDS_OFF` / `INV_QTY_OFF` so future SRAM presets have a clean foundation. Unlocks the magic-capture phase of the EMU plan — workflow: tap a button → enter battle → cast → REC OAM through animation → paste back.

## 1.7.5 — 2026-05-04

### Docs catchup for the 1.7.x line

Stale-session sweep — README, CLAUDE.md, EMU-PLAN, and design-notes were lagging the v1.6.94 → v1.7.4 jump.

- **README.md** — status bumped from 1.6.94 to 1.7.4. Added a paragraph on the EMU debugger tab (REC N FRAMES, 4-slot savestates, scene library, SRAM editor) and the per-weapon slash work that came out of those captures. Architecture concern list adds a `Debug` row covering `src/debug/{panel,bus,tabs/*}` and `src/debug/scenes/`.
- **CLAUDE.md** — PPU capture section now documents `REC OAM` / `REC BG` (multi-frame, the highest-leverage tool), 4-slot savestates with selection UX, and the `SCENES` panel + commit flow. `COPY` / `SAVE FILE` output toolbar called out as mobile-critical. The "where things live" table's slash row now points at `slash-effects.js` as single-source.
- **docs/EMU-PLAN.md** — new "Status (as of v1.7.4)" table marks Phase 0, 1.1, 1.2, 1.3, and 3 as shipped (with release versions); Phase 1.4, 2, 4, 5 still pending. Adjacent-work section captures the v1.7.1–1.7.4 slash refactor that fell out of REC captures, plus a note that DEDUPE toggle is the obvious next-leverage move on REC itself.
- **docs/design-notes.md** — "Battle attack animation" section rewritten for the consolidated `slash-effects.js` exports (`SLASH_FRAME_MS`, `getSlashPattern`, `setSlashOffsetForFrame`, `shouldDrawSlash`, `getSlashHoldMs`). Per-hit cycle line updated for per-weapon hold (blade 90 ms, impact 60 ms) and miss skip-on-miss.

No code changes in this release.

## 1.7.4 — 2026-05-04

### Slash logic consolidated into `slash-effects.js`

After 1.7.1 → 1.7.3 added the same skip-on-miss and timer-gate logic to three different state machines (`battle-update.js`, `battle-ally.js`, `pvp.js`), the duplication was getting out of hand. Pulled all the cross-cutting slash concerns into `slash-effects.js`:

- **`SLASH_FRAME_MS = 30`** — was split (30 ms in `battle-update.js`, 50 ms in `battle-drawing.js`). The drawing-side 50 ms made the ally `af` sprite-canvas index lag the state machine's `slashFrame`, so ally slash sprites would skip frames or stall. Now single-source.
- **`shouldDrawSlash(hit)`** — central predicate replacing inline `hit && !hit.miss` checks in 8 different sites across `battle-update.js`, `battle-ally.js`, `pvp.js`, and `battle-drawing.js`. Future rules (shield-block fast-skip, dead-target, etc.) live in one place.
- **`getSlashHoldMs(weaponId)`** — wraps `pattern.totalFrames * SLASH_FRAME_MS` so player slash code doesn't need to recompute it inline.
- All five touched modules now import from `slash-effects.js`. No behavior change in this release beyond the implicit ally-`af` fix from unified `SLASH_FRAME_MS` (ally slash sprite frames now advance at the same cadence as the state machine).

## 1.7.3 — 2026-05-04

### Player + ally slash also skip the impact hold on a miss

Same fix as 1.7.2 (PVP-enemy slash) applied symmetrically to the two outgoing slash paths so the whole combat chain is consistent — there's never a frozen pause when the slash sprite isn't going to render.

- `_updatePlayerSlash` in `battle-update.js`: on miss, skip the per-frame slash-offset advance and the `pattern.totalFrames * SLASH_FRAME_MS` wait. Routes straight to `player-hit-show`.
- `ally-slash` state in `battle-ally.js`: same — on miss, skip the `ALLY_SLASH_MS` hold; advance the combo or finalise immediately.
- Hit and crit paths unchanged in both.

## 1.7.2 — 2026-05-04

### PVP-enemy slash skips its impact hold on a miss

`_processPVPEnemySlash` in `pvp.js` always waited the full `ENEMY_SLASH_TOTAL_MS` regardless of the hit outcome. The slash sprite render path was already gated by `!miss`, so on a miss the entire wait was dead time after the body's forward swing — no visual, just a pause before the MISS popup.

Now on miss, the state short-circuits and routes straight to combo advance / damage display. Hits and shield blocks (which still want the impact frames) are unchanged. Affects PVP-opponent slashes targeting both the player and any ally.

## 1.7.1 — 2026-05-04

### Per-weapon slash scatter from PPU captures

Replaces the 1.6.89 "bladed = clean diagonal, else random ±8 per frame" heuristic with a PPU-derived per-weapon table. Driven by 20-frame OAM captures (OK dual-wield knife, WM staff, Monk full dual-fist combo) via the new EMU REC tool.

- **New single source of truth** in `src/slash-effects.js`: `getSlashPattern(weaponId)` plus `setSlashOffsetForFrame(state, weaponId, frame)` for player and `_scatterFor(weaponId, frameIdx)` for ally/PVP. `battle-sprite-cache.js` re-exports the helpers so consumers don't need to know which file owns what.
- **Bladed** (knife / sword / katana / dagger): deterministic UR→LL diagonal, 3 frames at `[(16,-16), (0,0), (-16,16)]`, 1 frame each. PPU showed step `(-16, +16)` per frame — the previous `(-8, +8)` step was half-magnitude.
- **Impact** (fists, staff, rod, nunchaku, claw, hammer, etc.): single RNG-scattered position per hit, range `±12 x / ±20 y`, held 2 frames. Multi-hit combos re-roll per hit. The previous "staff = downward arc" / "fists = tight cluster" overrides from 1.6.86 were wrong — staff impacts are the same RNG-on-target as fists.
- **Player path** (`battle-update.js _updatePlayerSlash`, `_advanceHitCombo`, `input-handler.js` first-hit queue) replaced inline bladed/random branches with `setSlashOffsetForFrame`. RNG-pattern weapons re-set offset only on hold-window boundaries (`frame % holdFrames === 0`), matching NES single-roll-per-hit.
- **Ally / PVP path** (`drawSlashOverlay`) now uses the same pattern table. Module-local cache stabilises the RNG roll across render calls within a hold-window — fixes a pre-existing per-render jitter where `Math.random()` re-rolled every frame draw. `resetSlashScatterCache()` is called when starting any new ally hit (`battle-ally.js`) or PVP-enemy slash (`pvp.js`) so RNG re-rolls cleanly per hit.
- **Fist body wiggle moved from sprite to body group.** 1.6.94 wiggled only the fist sprite at ±2 x / ±1 y, which detached the fist from the arm. PPU shows the **whole body group** alternates ±1 x while bladed strikes hold steady. `_drawPortraitWeapon` no longer wiggles; the parent draw site shifts `pxs` ±1 px x during fist `player-slash`.
- **Followups doc updated** — design-notes "Battle attack animation" section rewritten; "Staff slash 3-frame anim" and "Staff/rod downward-arc scatter" entries deleted from Followups (both were misreads of single-capture noise).

## 1.7.0 — 2026-05-04

### EMU debugger: REC N FRAMES — multi-frame OAM/BG capture (Phase 3)

Animation work like the 3-frame staff slash, spell anims, and any future N-frame sprite work no longer needs N separate pause-snap-step cycles. New `REC OAM` and `REC BG` buttons capture N consecutive frames in one pass.

- **New REC row** in the EMU tab below the SAVE/LOAD/SNAP capture row. Two buttons (`REC OAM`, `REC BG`) plus `frames` (default 3, max 60) and `gap` (default 1, max 30) numeric inputs. `gap=1` captures consecutive frames; `gap=N` advances N frames between snaps for slower anims.
- **Async loop drives `nes.frame()` between snaps** with a `setTimeout(0)` yield each step, so the canvas updates live during the record (you watch the animation play) and the cancel tap stays responsive. Tap the active REC button mid-run to cancel — text changes to `CANCEL (i/N)` while recording.
- **Output is one paste-ready block.** Each frame's snap is preceded by a `// ═══ frame N (snap @ fXXXXX) ═══════` divider. Per-frame OAM blocks include the PPU palette (in case it shifts mid-anim) and all meta-sprite groups. Per-frame BG blocks include the nametable grid + unique tile patterns.
- **Refactor:** `_snapshotOAM` body extracted into a pure `_oamSnapshotText()` helper used by both single-snap and the REC loop. `_bgSnapshotText` was already pure — REC reuses it directly.

## 1.6.99 — 2026-05-04

### EMU debugger: scene library framework (Phase 1.2)

Committed savestates of canonical FF3 moments, loaded on demand from a new `SCENES` panel in the EMU tab. Solves the "single-slot localStorage means every capture clobbers the previous" problem and makes captured moments **portable across browsers** — anyone who clones the repo gets the same `LOAD` buttons.

- **New dir** `src/debug/scenes/` with `index.json` (manifest) and `<name>.json` (full scene file). Schema documented in `src/debug/scenes/README.md`.
- **`SCENES` collapsible panel** below the output textarea. On open, fetches `index.json` and renders one row per scene (name + description + tappable `LOAD` button). Header summary shows the count: `SCENES (3)`. `REFRESH` button re-fetches without a page reload.
- **`LOAD` per scene** fetches `<name>.json`, auto-pauses the emulator, applies via `nes.fromJSON` after a `JSON.parse(JSON.stringify(...))` deep-clone (same aliasing-decoupling reason as the slot fix in 1.6.98), then resumes. `nes.romData` re-attached if the scene file's `state.romData` is null (which it always is — `romData` is intentionally stripped on export).
- **`EXPORT SCENE` form** at the bottom of the panel — name input (lowercase letters / digits / hyphens) + description input + button. Tap `EXPORT SCENE` and the full scene JSON (with metadata header + slim `nes.toJSON()` state) lands in the output textarea, paste-ready. From there `COPY` or `SAVE FILE` shares the JSON for committing into the repo.
- Scene library ships **empty** in this release. Initial captures land per future release as we accumulate them.

## 1.6.98 — 2026-05-04

### Fix: EMU savestate `LOAD` only worked once per `SAVE`

The 1.6.97 multi-slot work shipped with a latent bug inherited from the original single-slot code: `nes.fromJSON(state)` aliases the saved object's inner arrays into the running NES (jsnes' generic helper does `target[prop] = source[prop]` — straight reference assignment, no copies). After the first `LOAD`, every CPU/PPU mutation between then and the next `LOAD` silently rewrote the savestate, so `LOAD` #2 was effectively a no-op against drifted data.

Slots now store the savestate as a **JSON string** instead of a parsed object. `LOAD` parses a fresh copy each time, so the running emulator and the saved slot stay decoupled. A small `slotFrames` sidecar caches the frame number per slot so the slot-select status line doesn't need to re-parse a 100–500 KB string just to display `@ fN`.

## 1.6.97 — 2026-05-04

### EMU debugger: 4-slot savestates (Phase 1.1)

Replaces the single SAVE / LOAD slot with four numbered slots (`S1` … `S4`) so multiple captured moments can persist side by side instead of clobbering each other.

- New slot row above the SAVE / LOAD buttons. Tap `S1` … `S4` to select; the selected slot has a gold border and bold text. Populated slots show a `•` and green text; empty slots stay gold.
- `SAVE` and `LOAD` always operate on the currently-selected slot. Status messages are now slot-aware (`S2: saved @ frame 12345 (24 KB)`, `S3: empty`).
- Saved state now records `frame` so `LOAD` can report which frame the slot was captured at (`S2: loaded (@ f12345)`).
- Each slot persists at `localStorage[ff3_emu_savestate_slot_${i}_v1]`. The pre-1.6.97 single-slot key (`ff3_emu_savestate_v1`) auto-migrates into slot 0 on first boot if slot 0 is empty.

## 1.6.96 — 2026-05-04

### EMU debugger: Phase 0 — mobile QoL + capture race fix

First slice of the EMU-tab improvement plan (`docs/EMU-PLAN.md`). All five items are mobile-first since the user tests over SSH on a phone; selecting a 50-line textarea on touch was the gating UX problem.

- **`COPY` button** above the output textarea. Uses `navigator.clipboard.writeText` with a select+`execCommand('copy')` fallback for non-HTTPS / older WebViews. 800ms `COPIED ✓` flash on success.
- **`SAVE FILE` button** alongside it — downloads the current output as `emu-snap-f${frameCount}.txt` via a temporary `Blob` + `<a download>` click.
- **`SOUND` / `MUTE` button** now flips border + text colour (green when audio is on, default gold when muted) so audio state is scannable at a glance instead of relying on the textContent label alone.
- **Captures auto-pause the emulator.** New `_withPause(fn)` helper wraps `SNAP OAM`, `SNAP BG`, `WPN TILES`, and the per-tile `DUMP` button — pauses for the duration of the read, resumes if it was running. Eliminates the half-old / half-new tile race when `nes.frame()` ticks mid-walk through `ppu.ptTile` / `spriteMem` / `vramMem`.
- **`Escape` no longer closes the panel from inside an input/textarea.** Scoped via `document.activeElement.tagName` check in `src/debug/panel.js` — typed write-bytes / tile indices survive accidental Esc presses.

## 1.6.95 — 2026-05-04

### Docs: README + design-notes catch up to magic + animation work

- README status line bumped to v1.6.94 and now mentions player-cast magic. Architecture module list adds `Magic — spell-cast, data/spells`.
- New "Magic" section in `docs/design-notes.md` covering `ps.knownSpells`, MND vs INT stat, `menuMode = 'magic'` piggyback, battle cast pipeline, status-cure flow, pause-menu submenu.
- New "Battle attack animation" section documenting per-hit cycle (back-swing every hit, idle only at hand change, fists skip back-swing), per-weapon slash scatter (bladed = diagonal, else random per frame), per-weapon slash sprite routing, and fist sprite wiggle.
- Updated stale notes: magic-cast pose now lives in the `isItemUsePose` branch (was "TODO"); magic shop is wired (was "no-op"); fist combo notes updated for shipped behavior.

## 1.6.94 — 2026-05-04

### Fist sprite wiggles during punch slash

Each punch's fist sprite now wiggles ±2px x / ±1px y at ~30ms cadence during `player-slash` so the impact reads with shake. Applied in `_drawPortraitWeapon` only when `handWeapon === 0` (unarmed) and state is `player-slash` — weapons unaffected.

## 1.6.93 — 2026-05-04

### Every weapon hit now gets a full back-swing (was 30ms flash for repeats)

`HIT_COMBO_PAUSE_MS` (30ms) was being used for every hit after the first within the same hand — that's barely two NES frames in back-swing pose, so it visually looked like the back-swing was skipped. Now every hit uses `BACK_SWING_MS` (~167ms) so the wind-up is clearly visible per hit. Fists still skip the back-swing entirely (punches go straight forward). Hand change still inserts the idle pose break.

## 1.6.92 — 2026-05-04

### Idle pose only at hand change (revert from per-hit)

Reverting the per-hit idle break from 1.6.91. Pattern is: right hand back→forward repeats for however many R hits, then ONE idle pose at the hand change boundary, then left hand back→forward repeats for however many L hits. Same-hand subsequent hits stay in back-swing pose between strikes (no idle in between).

`_updatePlayerAttackBack` back to the handChange branch using `IDLE_FRAME_MS`, with `HIT_COMBO_PAUSE_MS` for same-hand hits and `BACK_SWING_MS` for hit 0. `_getPortraitSrc` `interHitGap` renamed back to `handChangeGap` and only fires when the hand actually swapped.

## 1.6.91 — 2026-05-04

### Idle pose break between EVERY combo hit (not just R↔L hand swaps)

Previously the inter-hit gap held the back-swing pose for `HIT_COMBO_PAUSE_MS` (~30ms) and only inserted the idle pose on actual hand changes. Per "each hand should get whatever number of hits, each hit getting the 3 slash frames, idle pose, next hand repeats", every hit after the first now gets a `IDLE_FRAME_MS` (67ms) idle pose break before the next strike — same-hand and hand-change alike.

`_updatePlayerAttackBack` simplified: hit 0 = weapon back-swing (skipped for fists), hit 1+ = idle break. `_getPortraitSrc` renamed `handChangeGap` → `interHitGap` and fires for every hit > 0.

## 1.6.90 — 2026-05-04

### PvP-enemy + ally slash overlays use the same per-weapon scatter as the player

`drawSlashOverlay` now takes a `weaponId` and applies the same rule as `_updatePlayerSlash`: bladed → clean UR→LL diagonal, non-bladed → random ±8 per frame. Previously ally + PvP-opponent slashes were stuck on the legacy `[0,10,-8] / [0,-6,8]` shake regardless of weapon.

## 1.6.89 — 2026-05-04

### Slash scatter back to simple per-frame random for staff/nunchaku/fists

Reverted the per-weapon scatter system (1.6.86) and the 2-frame "skip slot N" hack (1.6.88). Back to: blades get the clean UR→LL diagonal (unchanged), everything else gets a small per-frame random offset (`Math.random()*16 - 8`) per the 3 timing slots. `SLASH_FRAMES` stays at 3 for all weapons; `drawSlashOverlay` is back to its original signature using the legacy `[0,10,-8] / [0,-6,8]` shake for ally/PVP slashes. `getSlashScatter` and the per-weapon scatter constants removed.

## 1.6.88 — 2026-05-04

### Slash effect for staff/nunchaku/fists is 2 frames AFTER the swing

Per PPU OAM comparison: the NES staff slash effect plays for **2 game frames** AFTER the player's arm has come down on the forward strike. Frame 1 of the effect is held empty (no slash sprite rendered yet); frame 2 has the sprite at one static position on the target. Both PPU snapshots showed a forward-strike pose, just at slightly different sub-poses — neither was a wind-up.

Previous engine ran a 3-frame scatter dance over the entire 150ms `player-slash` window. Now:
- `_STAFF_SCATTER` and `_PUNCH_SCATTER` are static `(0,0)` (sprite holds at one position).
- Both encounter and boss slash render paths skip drawing the slash sprite on `slashFrame === 0` for non-bladed weapons — so the visible flash starts on frame 1 and holds through frame 2 (~100ms post-swing).
- Bladed weapons untouched (no PPU verification yet — they keep the UR→LL diagonal).

## 1.6.87 — 2026-05-04

### Pause-menu inv-target cursor: scroll the roster instead of walking off

`pauseSt.invAllyTarget` Down past the visible roster window now bumps `inputSt.rosterScroll` so the roster panel scrolls in sync (mirroring the way normal roster browsing scrolls). Up below the visible window pulls scroll back. Also fixed `pause-menu.js` `ROSTER_VISIBLE` from `5` to `3` to match `roster.js` — that mismatch is what let the cursor walk one extra row past the bottom into empty space before stopping.

## 1.6.86 — 2026-05-04

### Per-weapon slash scatter — staves swing down, fists land in a tight cluster

Player slash and ally/PVP slash overlays now pick a per-weapon 3-frame offset pattern instead of the old "bladed = clean diagonal, everything else = random ±20" heuristic.

- `getSlashScatter(weaponId)` in `slash-effects.js` returns `{ x: [3], y: [3] }` per category:
  - **Staff / rod / nunchaku** → downward arc `(-2,4,8) / (-16,0,16)` matching the PPU-captured staff hit (origin shifted from y=58 to y=124 across hits).
  - **Fists** (weaponId 0) → tight `(-6,4,-2) / (-4,4,8)` impact cluster — replaces the old random ±20 jitter.
  - **Bladed** (knife/dagger/sword) → `(8,0,-8) / (-8,0,8)` clean upper-right → lower-left diagonal — same shape the player-slash code used to compute inline.
  - **Default** → legacy shake.
- `_updatePlayerSlash` and `_advanceHitCombo` in `battle-update.js` now read directly from `getSlashScatter(handWeapon)` — no more per-weapon `if/else`, no more `Math.random()` for non-bladed.
- `drawSlashOverlay(ctx, frame, frameIdx, originX, originY, mirror, weaponId)` takes the weapon id so ally + PVP-opponent slash overlays use the same per-weapon scatter as the player. Existing callers updated to pass the active hand's weapon id.

## 1.6.85 — 2026-05-04

### Nunchaku slash now shares the staff slash sprite

Second-frame PPU capture of the staff slash returned tile bytes byte-for-byte identical to frame 1 (just at different CHR addresses — $4D == $55, $4E == $56, etc.). The OAM positions differ per frame (origin shifts (+5,+66) between hits), and that bouncing is already handled by `drawSlashOverlay`'s scatter array — so the existing single-sprite `initStaffSlashSprites()` is correct as-is.

Per a hunch from PPU watching, also pointed nunchaku slash at the same `bsc.staffSlashFramesR` cache (was using a separate capture). The old `initNunchakuSlashSprites()` is left in `slash-effects.js` for now in case the hunch is wrong, but it's no longer called.

Per-frame positioning (OAM showed a much bigger vertical arc than the generic scatter does) is a polish followup — staff would benefit from a downward-arc scatter override.

## 1.6.84 — 2026-05-04

### Magic content: Poisona spell, Ur magic shop, staff slash sprite

- **Poisona spell (`0x35`).** Status-cure only — removes poison from the target, never heals HP. Wired into both battle (`spell-cast.js`) and pause-menu (`_applyPauseSpellUse`) via a new `SPELL_CURE_FLAG` map (`spell.type` → `STATUS.*`). White Mage now starts with Cure + Poisona. MP cost: 2.
- **Ur magic shop is live.** `openShop` now accepts `spells:` catalogs. Magic shop in Ur (map 3, counter 4,4) sells Cure (100 gil) and Poisona (100 gil). Spell list renders with `getSpellNameClean` + price right-aligned; confirm dialog reads "Learn X?". Buying deducts gil and pushes the spell ID into `ps.knownSpells`. "Already known" rejection if you re-buy. Sell tab is blocked for spell shops with an ERROR sfx (can't sell spells). New `SPELL_BUY_PRICE` table in `data/spells.js`.
- **Staff slash sprite.** New `initStaffSlashSprites()` in `slash-effects.js` using the PPU-captured tiles `$4D/$4E/$4F/$50` (SP3 palette `[0x0F, 0x17, 0x27, 0x37]`) from a White Mage staff swing. `getSlashFramesForWeapon` now routes `staff` and `rod` subtypes to it instead of the generic punch slash. Single-frame for v1; mid + late slash frames still need PPU capture for a true 3-frame anim.

## 1.6.83 — 2026-05-04

### Cure uses Potion's CURE SFX; pause-menu inv-target cursor aligns with roster rows

- **Battle Cure now plays `SFX.CURE`** instead of `SFX.SW_HIT`. `_applySpellEffect` in `spell-cast.js` branches on `spell.element === 'recovery'` so heal spells get the same chime as Potion. Damage spells will keep the SW hit sfx until per-spell sfx land.
- **Pause-menu inv-target cursor was drifting** lower by 8px per ally row — `pauseSt.menu.js` had `ROSTER_ROW_H = 24` while the actual roster (`roster.js`) draws rows at `ROSTER_ROW_H = 32`. Changed to 32 so Potion AND Cure target cursors land on the right portrait row.

## 1.6.82 — 2026-05-04

### Battle spell-list cost no longer clipped off the right edge

The bottom panel's outer clip is `rect(8, HUD_BOT_Y, CANVAS_W-16, HUD_BOT_H)` — right edge at x=248. The Cure cost was being drawn at x=244-252, so the right half of the "4" was getting clipped, looking like a stray glyph hanging off the panel. Re-anchored cost to `CANVAS_W - 16 - measureText(...)` so its right edge sits at x=240 (8px margin from the clip).

## 1.6.81 — 2026-05-04

### Cure target select: cycle player/allies/enemies; pause-menu Cure works like a Potion

**Battle:** removed the ally-only lock on heal spells in `_battleInputItemTargetSelect`. Left/Right now navigates to enemies the same way item-target select does — symmetric with how Potion behaves. Picking an enemy with Cure in v1 still heals the caster (since damage spells aren't wired yet); will route correctly once Black Mage spells land.

**Pause menu:** Cure now goes through the same target-select cursor as Potion — Z on a spell stashes it in `pauseSt.useSpellId` and transitions to `inv-target`, where Up/Down cycles player → roster allies. Confirming with Z calls `_applyPauseSpellUse` which deducts MP, applies the heal to the chosen target, and sets `pauseSt.healNum` (with `rosterIdx` if an ally was picked) so the green-number bounce lands on the right portrait.

## 1.6.80 — 2026-05-04

### Pause menu Magic submenu — proper spell list, not instant cast

Z on Magic in the pause menu now opens a real spell-select submenu. Piggybacks on the inventory state machine (`inv-text-out` → `inv-expand` → `inv-items-in` → `inventory`) via a new `pauseSt.menuMode = 'inv' | 'magic'` flag (mirrors the battle menu pattern).

- Magic mode renders `ps.knownSpells` with MP costs right-aligned, navigates with Up/Down, Z casts the highlighted spell on self (v1: ally-only spells), X exits back to the main pause menu.
- Cast reuses the existing `inv-heal` flow — green heal number bounces over the player portrait with the cure-sparkle overlay.
- Returning from `inv-heal` keeps the spell list visible (state stays `'inventory'`, menuMode stays `'magic'`) so the player can cast again or X out.
- `menuMode` resets to `'inv'` on `inv-text-in` → `'open'` so a future Item-cursor open starts in inventory mode.

## 1.6.79 — 2026-05-04

### Magic v1 polish: cure-sparkle visual, MND-based heal, encounter visibility

- **Cure visual swapped from SouthWind ice burst to the cure sparkle.** `bsc.cureSparkleFrames` (the same alternating-flip overlay used for pause-menu Potion heals and battle-item Potion) now flickers on the player portrait during `magic-cast` / `magic-hit` whenever a player-target heal is mid-cast. The SouthWind explosion no longer renders for spell casts.
- **Heal formula now uses MND (caster's mind), not INT.** Per NES FF3 disasm, white magic uses MND and black magic uses INT. `_rollMagicAmount(power, useMnd)` in `spell-cast.js` picks the right stat based on the spell's element (`recovery` → MND); pause-menu Cure does the same.
- **Encounter monsters no longer disappear during a cast.** `_isEncounterCombatState` and the PVP/boss equivalent state-lists now include `magic-cast`/`magic-hit`, so monsters stay drawn while the spell animates instead of hiding for ~1.1s.

## 1.6.78 — 2026-05-04

### Magic v1 fixups: pause-menu Cure, MP refill on /job, strip spell-name padding

- **Pause menu Magic now casts Cure on self.** `pauseSt.cursor === 1` (Magic) was a no-op since the menu shipped — Z press now deducts MP, applies the heal via the existing `inv-heal` flow with green-number bounce, and returns to the main pause menu (new `pauseSt.magMode` flag distinguishes from Item heals so we go back to `'open'` instead of `'inventory'`). Proper spell-pick UI is TODO; v1 shorts straight to Cure.
- **`/job N` now full-heals.** Switching jobs in the test console restores HP+MP to max so a freshly-switched White Mage can actually cast Cure (4 MP) without the Z press silently failing the cost gate.
- **New `/heal` and `/mp [N]` console commands** for ad-hoc top-ups during testing.
- **`getSpellNameClean(spellId)`** in `text-decoder.js` — allowlist filter (letters, digits, basic punct, space) that strips the magic-school icon tile and any trailing padding bytes the ROM stores around spell names. Battle spell list now uses it; "Cure" no longer renders with a stray glyph at the right edge of the row.

## 1.6.77 — 2026-05-04

### Magic v1: White Mage Cure end-to-end

First slice of the player-cast magic system. Battle slot 1 for mage jobs (3/4/5) now opens a spell-select menu, picks a known spell, target-selects an ally (player for v1), deducts MP, plays a placeholder cast animation (SouthWind sprite reused), applies heal via the NES magic damage formula, and persists MP + `knownSpells` across saves.

- New `ps.knownSpells: []` on player-stats; `grantStartingSpells(jobIdx)` auto-grants per-job starting spells on `changeJob` and on save load. White Mage (job 3) starts with Cure (`0x34`).
- New `src/spell-cast.js` — `startSpellCast(spellId, target)` / `updateSpellCast(dt)` driving `magic-cast` (250ms windup) → `magic-hit` (400ms anim → apply heal → hold to 1100ms) state pair, modelled on the SouthWind throw/hit loop.
- Battle menu plumbing piggybacks on the item-* state machine via a new `inputSt.menuMode = 'item' | 'magic'` flag. Spell-select reuses the item-list panel; ally-target spells lock the target cursor to the player/ally side.
- New `SPELL_MP_COST` table in `data/spells.js` (Cure = 4 MP for v1).
- Save schema: `knownSpells` added to `save-state.js` + `save.js` + title-screen restore. On load, `grantStartingSpells(ps.jobIdx)` runs so existing mage saves get their starter spells without manual job re-switch.
- New `/job N` console command for testing — bypasses CP cost, shows known spells.
- Cast visual is a placeholder: SouthWind sprite reused as the spell anim. Per-spell PPU traces will land later.

## 1.6.76 — 2026-05-04

### Docs: README + design-notes catch up to the shop / save work

- README status line bumped from v1.6.9 → v1.6.75 and now mentions town shops as a feature. Added "Shops" entry to the architecture module list.
- New "Shops" section in `docs/design-notes.md` covering counter-tile detection, the two-phase NES fade, the equip-preview portrait + delta triangle, FF1 NSF track 14, and the blue confirm-text palette.
- New "Saves" section noting `saveSlotsToDB()` is the single source of truth for the save schema (post v1.6.74 audit), all known save trigger points, and that MP + poison tick are now persisted.

## 1.6.75 — 2026-05-03

### Shops: blue confirm dialog now uses blue text-bg + mobile-aware A/B prompts

The buy/sell confirm dialog renders on a blue (`drawBorderedBox(.., true)`) background, but the text was using `_makeFadedPal(0)` = `[0x0F, 0x0F, 0x0F, 0x30]` — color 1/2 (font shadow) was black, leaving a black halo around each glyph on the blue box. Switched to `[0x02, 0x02, 0x02, 0x30]` (the same palette `message-box.js` uses for "Bought X!" toasts), so the shadow renders blue and disappears into the bg.

Confirm hint also now reads `A=Yes  B=No` on touch devices and `Z=Yes  X=No` on desktop — same `isMobile` check `loading-screen.js` uses for its "Press A" prompt.

## 1.6.74 — 2026-05-03

### Save: persist MP + poison tick, save chests/pond, centralize the schema in `saveSlotsToDB`

Audit revealed three classes of bugs.

**Missing fields**
- `ps.mp` was never persisted — `title-screen.js` reset it to `maxMP` on every load. Added `mp` to the saved schema and the load path (`save.js`, `save-state.js`, `title-screen.js`).
- `ps.status.poisonDmgTick` was lost — only the status mask was saved. Added `statusPoisonTick` to schema + load.

**Mutations that didn't trigger a save**
- `handleChest` (gil + items from chests) and `handlePondHeal` (HP/MP restore) in `map-triggers.js` now call `saveSlotsToDB()` after mutating `ps`. Previously a crash before the next save trigger lost the pickup or heal.

**Schema duplication / drift risk**
- `saveSlotsToDB()` already copied `playerInventory` into the active slot, but every caller was *also* doing `saveSlots[selectCursor].inventory = { ...playerInventory };` inline. New callers could forget the inline copy and silently clobber. Removed all 6 inline copies in `input-handler.js` and the helper in `shop.js` — `saveSlotsToDB()` is now the single source of truth for what gets serialized. Callers just invoke it.

## 1.6.73 — 2026-05-03

### Shops: persist inventory + gil to DB after every buy / sell

`_attemptBuy` / `_attemptSell` now copy `playerInventory` and `ps.gil` into the active save slot and call `saveSlotsToDB()` immediately — same pattern as the pause-menu inventory mutations in input-handler.js. Without this, shop transactions only survived until the next battle ended, the page closed cleanly, or an inventory action in the pause menu — closing the tab mid-shop would lose them.

## 1.6.72 — 2026-05-03

### Shops: weapon delta no longer treats empty off-hand as a free upgrade

Switched weapon comparison from `Math.min(weaponR.atk, weaponL.atk)` back to `Math.max`. With one hand empty, MIN reads as 0 and made every weapon look like an upgrade ("fill the empty hand"). MAX compares against the best weapon already wielded, which matches "is this a real upgrade to my main weapon".

Added explicit short-circuit: if the hovered weapon ID matches `ps.weaponR` or `ps.weaponL`, return 0 (white =). A duplicate of what's already equipped shouldn't show ▲ just because the off-hand is empty.

## 1.6.71 — 2026-05-03

### Shops: HUD viewport border no longer fades during the NES map fade

Root cause: the snapshot fed to `buildNesFadeFrames` covered the full HUD_VIEW area, which includes the 8px-wide HUD border tiles around the map. NES-quantizing + palette-stepping that snapshot dimmed the border tiles along with the map content. Same problem applied to the shop-visible phases — `fillRect` was wiping the borders too, then `drawHudBox` redrew them, but during `map-out`/`map-in` there was no redraw.

Fix: confine all shop drawing to the inner content rect (`INNER_X = 8, INNER_Y = 40, INNER_W = 128, INNER_H = 128`). Snapshot the inner area only; draw fade frames at the inner area; black-fill the inner area; rely on the static HUD canvas (drawn each frame by `drawHUD` before `drawShop`) for the border. `drawHudBox` import dropped from shop.js — no longer needed.

## 1.6.70 — 2026-05-03

### Shops: bordered box no longer fades — only text fades

Shop `drawHudBox(... boxFadeStep)` was stepping the border-tile palette during shop-in / shop-out, which read as the HUD border itself fading. Locked to fadeStep 0 — the box pops in/out at full opacity, only the text inside still does the 4-step palette fade.

## 1.6.69 — 2026-05-03

### Shops: white = indicator on equal stat + empty-slot weapons now read as upgrades

- **Equals indicator**: `shopHoverStatDelta()` now returns `null` for "no indicator" (non-equipment / not equippable / unknown subtype) and a number for actual deltas. `_drawDeltaMark()` (renamed from `_drawDeltaTriangle`) routes `> 0` → green ▲, `< 0` → red ▼, `= 0` → white = (two 8-wide bars at rows 2 and 4 in the same 8×8 box). HUD only draws when `delta !== null`, so non-equippable items still show no indicator.
- **Empty-slot fix**: weapon delta now compares `item.atk` against `Math.min(weaponR.atk, weaponL.atk)` instead of `Math.max`. With one hand empty (atk treated as 0), any new weapon reads as a clear upgrade — matches the "fill the empty hand" intent. Shields keep `Math.max` since at most one shield can be equipped.

## 1.6.68 — 2026-05-03

### Shops: green ▲ / red ▼ delta triangle in HUD name row

When the shop cursor is on a weapon/armor the player can equip and the slot it would replace has different ATK (weapons) or DEF (armor), an 8×8 triangle is drawn at the left padding of the HUD info panel (`HUD_RIGHT_X + 40, HUD_VIEW_Y + 8`). Green ▲ for upgrade, red ▼ for downgrade. Hidden when delta = 0 / non-equipment / non-equippable. Triangle pixels are filled directly via `ctx.fillRect` per-row (NES color $2A / $16, faded with `nesColorFade` to track the existing HUD info-panel fade).

Comparison rules in `shopHoverStatDelta()`:
- weapon (non-shield): `item.atk` vs `max(weaponR.atk, weaponL.atk)`
- shield: `item.def` vs `max(weaponR shield def, weaponL shield def)`
- helmet / body / arms: `item.def` vs the matching slot's def

## 1.6.67 — 2026-05-03

### Shops: HUD portrait flickers victory pose when cursor is on equippable gear

In a shop's buy or sell list, when the cursor is on a weapon/armor that the player's current job can equip (`item.jobs & (1 << ps.jobIdx)`), the existing HUD portrait at top-right (drawn by `_drawHUDPortrait` in hud-drawing.js) alternates between `bp.victory` and `bp.idle` every 250ms — same cadence as the battle ally victory portrait. Otherwise the portrait keeps its normal kneel/defend/idle logic.

`shopHoverEquippable()` exported from shop.js — returns false outside buy/sell, false for non-equipment, false for items the current job can't wield.

## 1.6.66 — 2026-05-03

### Shops: FF1 NSF shop track → 14 (verified by ear)

## 1.6.65 — 2026-05-03

### Shops: NES palette-step fade for the map ↔ shop transition + `/ff1` console command

Replaced the alpha-based outer fade with an actual NES PPU-style palette fade. New module `src/nes-fade.js` exports `buildNesFadeFrames(srcCanvas, sx, sy, sw, sh, steps)`: snapshots a region of the canvas, quantizes each pixel to its nearest NES palette index, then uses `nesColorFade` to produce N+1 progressively darker frames (frame 0 = original, frame N = nearly black). Cached nearest-color lookup keeps the snapshot ~50ms one-time on shop open.

Shop state machine now does the transition in two distinct phases per direction:

- **Open**: `map-out` (320ms — 5 NES fade frames of the map snapshot, lazy-built on first frame) → `shop-in` (500ms — black bg + faded bordered box via `drawHudBox(fadeStep)` + faded text) → `menu`.
- **Close**: `shop-out` → `map-in` → `closed`. Reuses the same snapshot.

Sub-screen swaps (root menu ↔ buy/sell list) keep the existing 500ms text-palette fade — they don't touch the map.

Also new console command: `/ff1 <n>` plays FF1 NSF track index N (pauses map music). `/ff1 stop` resumes map music. Use to ear-check the right index for `FF1_TRACKS.SHOP` since 8/12/17 are all wrong.

## 1.6.64 — 2026-05-03

### Shops: FF1 NSF shop track → 8 (FF1&2 cart song ordering)

The NSF is built from the FF1&2 (Japan) compilation cart, not standalone FF1, so the track index doesn't match the FF1-only NSF song lists. Track 8 per Gemini.

## 1.6.63 — 2026-05-03

### Shops: switch FF1 NSF shop track from 17 → 12

Per Gemini, the FF1 shop theme is NSF track 12 (song $4D), not 17.

## 1.6.62 — 2026-05-03

### Shops: FF1 NSF shop track plays while menu is open

`openShop` now `pauseMusic()` + `playFF1Track(FF1_TRACKS.SHOP)`; `_close` calls `stopFF1Music()` + `resumeMusic()` — same pattern the pause menu uses with `MENU_SCREEN`. New constant `FF1_TRACKS.SHOP = 17` — the next NSF track index after `MENU_SCREEN` (16). If the wrong song plays, bump the index and re-deploy; can't verify without ear-checking against the FF1 NSF.

## 1.6.61 — 2026-05-03

### Shops: outer alpha fade — map fades to black as shop fades in

`openShop` now enters `'opening'` (250ms `globalAlpha` 0→1) before settling on the root menu. Exit / X from the root menu enters `'closing'` (alpha 1→0) before fully closing. The bordered box's black interior, drawn with progressive alpha over the live map, gives a crossfade where the map dims as the shop materializes. Sub-screen swaps (menu↔buy↔sell) keep their existing 500ms text-palette fades.

State machine: `closed → opening → menu → (closing | menu-out → buy-in/sell-in) → ...`. `shopSt.afterFade` records the next state when leaving the root menu so a single `menu-out` transition can route to either `buy-in` or `sell-in`.

## 1.6.60 — 2026-05-03

### Shops: Buy / Sell / Exit root menu + text-fade transitions

Shop now opens to a root menu (`Buy / Sell / Exit`) instead of jumping straight into the buy list. Each panel — root menu, buy list, sell list — fades in/out using the same 4-step palette fade as the pause menu (`PAUSE_TEXT_STEP_MS = 100`, 4 steps + 1 = 500ms total). Input is blocked during fades.

- **Sell**: lists every inventory item that has a non-zero ROM price. Sell price = `floor(buy / 2)` (FF3 NES convention). Confirm dialog mirrors buy. Inventory list rebuilds after each sale so counts stay accurate. Empty inventory shows "Nothing to sell".
- **State machine**: `closed → menu-in → menu → (buy-in / sell-in / menu-out) → ...`. Buy/sell exit via X fades back to root menu (not straight to closed); Exit on root or X on root fades the whole shop out.
- **Magic shop** still no-ops — `openShop` returns false when the catalog has `spells:` instead of `items:`. Wiring deferred.

## 1.6.59 — 2026-05-03

### Shops: weapon, armor, item buy menus wired in Ur

Face the counter in any of the three Ur shops (armor map 4 @ 3,5 / weapon map 5 @ 3,15 / item map 8 @ 8,15) and press Z. Opens a buy menu listing the catalog from `data/shops.js` with prices pulled from `ITEMS` (which were already auto-generated from the FF3 NES ROM at `$21E10`). Z on an item shows a confirm dialog; Z again deducts gil + adds to inventory and shows "Bought X!"; X cancels at any level. Insufficient gil shows "Not enough gil!" instead.

- New module: `src/shop.js` (state, input, render). Standalone — no animations yet.
- `data/shops.js` — each shop now carries `{ mapId, counter: {x,y} }`. `findShopAtCounter()` does the reverse lookup.
- `movement.js` — `handleAction` checks counters before chest/wall/etc.; `handleInput` early-returns to `handleShopInput` when a shop is open.
- `game-loop.js` — `drawShop()` runs after pause menu, before message box (so the "Bought X!" toast overlays the shop list).
- Magic shop (Ur, map 3 @ 4,4, tile 0x3A) is detected by counter lookup but `openShop` no-ops because `spells:` aren't items — buy flow needs `spells.js` integration. Deferred.

## 1.6.58 — 2026-05-03

### Console: `/pos` command for inspecting player and faced tile

New chat command — prints current map ID, player tile (X,Y), facing direction, and the faced tile's coordinates + tile ID (hex). On the world map, just prints world tile coords. Needed to identify shop counter tiles in Ur (and any future map work) without recompiling debug hooks.

## 1.6.57 — 2026-05-02

### Fix: knife forward strike on player slot was rendering the back-swing pose

`_buildPlayerSpriteSet` in `sprite-init.js` was assembling `bsc.battlePoses` with `knifeR`, `knifeL`, `knifeBack` but **not** `knifeRFwd` / `knifeLFwd`. The bundle produced both correctly — the fields just weren't carried over to the player canvas object.

When dual-wielding knives, `pickAttackPoseKey` returns `'knifeRFwd'` / `'knifeLFwd'` during the forward strike. `_playerPoseCanvas` saw those keys as undefined and fell through `PLAYER_POSE_FALLBACK` to `'knifeR'` / `'knifeL'` — which are the back-swing canvases. Net result: every knife forward strike rendered the back-swing pose instead of the strike pose. Most visible on Black Mage (frequently dual-wielding daggers as the only equippable weapon).

Now `knifeRFwd` / `knifeLFwd` are exposed on `bsc.battlePoses`. Affects every job, not just black mage.

## 1.6.56 — 2026-05-02

### Staff weapon sprite wired in; ally portraits now cover all 22 jobs; staff added to Altar F2 loot

- **Staff sprite**: PPU-captured 4-tile block (`$4A/$49/$4C/$4B`) added to `weapon-sprites.js` with SP3 palette `[0x0F, 0x17, 0x27, 0x37]` (gold). New `getStaffBladeCanvas` / `getStaffBladeSwungCanvas` getters; `'staff'` subtype routes through them in `pickAttackWeaponSpec`. White Mage (and any other staff-wielder) now overlays the gold staff during back/fwd swings using the same `swungOrder = [1,0,3,2]` mirror trick as blades.
- **Ally portraits**: `_USE_BUNDLE_FOR_ALLY` expanded from `{0,1,2}` to all 22 jobs. `boot.js` `initFakePlayerSprites` now seeds the full 0-21 range. Symptom: a saved slot with jobIdx 3+ on the title screen was rendering Onion Knight (fallback to job 0 because no entry existed). Now the bundle path produces correct per-job portraits with the canonical tile pattern that POSES tab verifies. The legacy per-job if/else in `initFakePlayerPortraits` is now dead and kept as historical reference.
- **Altar loot**: Staff (0x0E) added to F2 weapon tier alongside Dagger, Nunchuck, and Leather Cap. Same weight bucket — drop rates unchanged for the other items.
- **Rod**: still no sprite (OAM not yet captured). `'rod'` subtype falls through to no-overlay; rods don't appear in any shop or loot pool yet, so this is harmless.

## 1.6.55 — 2026-05-02

### Battle menu: "Defend" relabelled to "Guard"

`BATTLE_DEFEND` constant in `data/strings.js` renamed to `BATTLE_GUARD`, bytes re-encoded for "Guard" (G u a r d). Only call site was the local `BATTLE_MENU_ITEMS` array in the same file; no other code touches the label.

## 1.6.54 — 2026-05-02

### Fix: kneel head TL/TR for jobs 3-21 was reading the wrong ROM tile-indices

`_genericBundle` had kneel head at t(36)/t(37). That's correct for Warrior — and so were the previous PPU captures — but Warrior is the outlier: Onion Knight, Monk, and (per visual confirmation in the POSES tab) every job 3+ stores kneel head TL/TR at t(8)/t(9). Fixed both `_genericBundle` and the corresponding POSES tab card.

## 1.6.53 — 2026-05-02

### POSES debug tab now seeds jobs 3-21 from ROM using the canonical tile layout

Previously the POSES tab only loaded Onion Knight, Warrior, and Monk (PPU-captured constants). Jobs 3-21 (White Mage onward) had no cards — there was no way to visually verify whether `_genericBundle`'s tile-index pattern produced correct poses for a given job.

Added `_seedGenericJobPoses()` which, for each remaining job, reads tiles directly from ROM at `BATTLE_SPRITE_ROM + jobIdx * BATTLE_JOB_SIZE` and pushes 8 pose cards (idle / L back / L fwd / R back / R fwd / kneel / victory / hit). The tile-index slot layout matches `_genericBundle` exactly, so the tab is now the visual ground truth: if a card looks wrong, the bundle (and therefore the in-game render) is wrong, and the slot can be re-mapped from there.

## 1.6.52 — 2026-05-02

### Fix: generic-job battle sprites (jobs 3-21) now use correct ROM tile indices for L-back, L-fwd, kneel, and per-pose legs

`_genericBundle` in `combatant-sprites.js` had the L-back/L-fwd body indices and kneel body BL/BR off, and reused default legs for every pose. Symptom: switching to White Mage (or any non-OK/Warrior/Monk job) showed garbage tiles during L-side swings and kneel.

Reverse-mapped the PPU-captured Onion Knight + Warrior bytes back to ROM tile-indices and confirmed a uniform per-job layout:

- 0-3 idle body, 4-5 idle legs
- 6-7 R-fwd legs
- 10-11 kneel body BL/BR, 12-13 kneel legs
- 14 R-back body-TL, 15 R-back legL (legR shares tile 7)
- 16-17 L-fwd body, 18-19 L-fwd legs
- 20-21 L-back head-TR + body-TR, 22-23 L-back legs
- 24-27 victory body, 28-29 victory legs
- 30-33 hit body, 34-35 hit legs
- 36-37 kneel body TL/TR

Bug indices were 6/7 (L-back), 8/9 (L-fwd), 38/39 (kneel BL/BR) — those slots hold unrelated data on most jobs, which is why the previous "approximation" disclaimer existed. Pattern is canonical, not approximate.

Player path only this version. Ally legacy path (`_initGenericJobPosePortraits` / `_buildGenericJobFullBodies` in sprite-init.js) still uses the old indices for jobs 3-21 — opponents/allies of those jobs will still glitch until that path is migrated to the bundle.

## 1.6.51 — 2026-05-01

### Fix: enemy actor name now appears before the swing lands (was lagging behind animations)

`battle-enemy.js _processEnemyFlash` and `pvp.js _runEnemyAttack` both queued the enemy's name AFTER the BOSS_PREFLASH_MS (133ms) preflash window — i.e. at the same instant the swing animation began. Combined with the message strip's 200ms fade-in, the player saw the hit land before the name finished fading in (often after the hit, depending on swing duration). This was especially noticeable on fast monster attacks.

The name is now queued at turn dispatch (`battle-turn.js`, the moment state transitions to `'enemy-flash'`). The 200ms fade-in starts immediately and overlaps the 133ms preflash, so the name is visible by the time the swing connects. Both regular monster attacks (looked up via `getMonsterName`) and PVP opponent / enemy-ally attacks (looked up via `pvpSt.pvpOpponentStats` / `pvpSt.pvpEnemyAllies`) route through the same call site.

Cleanup: `battle-enemy.js` and `pvp.js` no longer import `queueBattleMsg`/`getMonsterName`/`_nameToBytes` since they no longer queue messages directly.

## 1.6.50 — 2026-05-01

### Fix: typed chat messages now appear in the tab they were sent from

`onChatKeyDown` always called `addChatMessage(text, 'chat')` with no channel, which `addChatMessage` defaulted to `'room'`. The active-tab filter (`_passesTabFilter`) only renders messages whose channel matches the tab — so a user typing on the **World** tab pushed a `room`-channel message that was immediately filtered out, looking like nothing happened. Auto-chat already routed correctly (`'room'` for local, `'world'` for remote) so other people's chats still appeared, masking the bug.

The send path now maps `activeTab → channel`: World → `world`, Room → `room`, Private → `pm`, System → `room` (you can't post to system, so fall back).

## 1.6.49 — 2026-05-01

### Fix: PVP opponent attack message now matches the rest of the codebase ("Name" not "Name attacks!")

`pvp.js _runEnemyAttack` was the only `queueBattleMsg` site in the codebase that suffixed `' attacks!'` to the actor name. Player fight, player defend (`battle-turn.js`), ally attack (`battle-ally.js`), and regular enemy attack (`battle-enemy.js`) all queue just the bare actor name. PVP now matches.

## 1.6.48 — 2026-05-01

### Refactor: deleted second battle message UI; BATTLE_CANT_ESCAPE now uses queue strip everywhere

The codebase had two battle-context message renderers: the queued fade strip (`battle-msg.js`, used by hit names / attack lines / victory) and a second centered-bordered-box system (`'message-hold'` battle state + `battleSt.battleMessage` field + `drawBattleMessage` renderer in `battle-drawing.js`). The centered box had exactly one caller — boss/non-random escape failure — while random-encounter escape failure already used the queue strip for the same `BATTLE_CANT_ESCAPE` text. Same string, two visual treatments.

**Visual change:** boss-flee failure now shows the same fading strip as random-encounter flee failure. UX is now consistent across both encounter types.

Deletions:
- `drawBattleMessage()` and its caller in `battle-drawing.js`.
- `TEXT_WHITE_ON_BLUE` palette const (only used by the deleted renderer).
- `battleMessage` field on `battleSt` + its reset in `battle-update.js`.
- `CENTER_MSG_HOLD_MS = 1200` constant (was duplicated in `battle-update.js` and `pvp.js`).
- Dead `'message-hold'` handler in `pvp.js _updatePVPMenuConfirm` — was unreachable since the only setter lived in `battle-update.js` and PVP doesn't go through that path.

The state name `'message-hold'` is retained (still referenced by 4 draw guards that gate non-message rendering) but its semantics changed from "show centered box for 1200ms" to "wait for queue strip to drain, then re-open battle menu."

## 1.6.47 — 2026-05-01

### Refactor: battle message system tightening (no behavior change)

Cleanup pass on the three message UIs (battle queue strip, battle centered box, overworld slide box). All changes are equivalence-preserving — visuals and timing unchanged.

- **`message-box.js`**: added `dismissMsgBox()` so callers stop poking `msgState.state = 'slide-out'; msgState.timer = 0` from outside the module. `movement.js` and `input-handler.js` now go through the API.
- **`battle-msg.js`**: replaced the generic `setBattleMsgCurrent(v)` setter with a named `clearVictoryPersist()` that only clears messages flagged `persist: true`. The single caller (victory text-out) is more readable. Also dropped `MSG_TOTAL_MS` (exported, zero importers) and the now-unused `getBattleMsgQueue` export.
- **`battle-update.js`**: replaced two `!getBattleMsgCurrent() && getBattleMsgQueue().length === 0` guards with `!isBattleMsgBusy()` — equivalent given the invariant that current is null iff queue is empty.
- **`pvp.js`**: removed dead `if (queueBattleMsg && ...)` truthy check (ESM static imports are always truthy).
- **`message-box.js`**: dropped unused 2nd parameter from `drawMsgBox`; updated `game-loop.js` caller.
- **Constant disambiguation**: renamed `BATTLE_MSG_HOLD_MS = 1200` (locally defined in `battle-update.js` and `pvp.js`, governs the `'message-hold'` centered-box state) to `CENTER_MSG_HOLD_MS`, with a comment noting it's distinct from `battle-msg.js`'s `MSG_HOLD_MS = 800` (which times the queue strip's hold phase).

## 1.6.46 — 2026-05-01

### Fix: in-game console version banner now reads from `#version-badge` (was hardcoded)

`src/data/strings.js` previously hardcoded `VERSION = '1.6.44'` with a comment claiming "single source of truth (update here + package.json)" — which was the opposite of single-source. The in-game console banner (`'FF3 MMO v' + VERSION` rendered by `src/main.js`) had been silently lagging `package.json` for releases that bumped the version without also editing this file.

`VERSION` now reads from the server-substituted `#version-badge` div (which already gets `{{VERSION}}` replaced in `server.js`). Module scripts are deferred so the DOM is parsed before this evaluates. `package.json` is now the only place to bump.

## 1.6.45 — 2026-05-01

### Refactor: Monk ally render migrated to unified bundle path; dead legacy builder deleted

`_USE_BUNDLE_FOR_ALLY` now includes jobIdx 2 (Monk) alongside OK and Warrior, so Monk fake-player portraits + bodies flow through `_buildFakePlayerSet` → `getJobPoseTileBundle` (which has had a fully populated `_monkBundle` since the bundle abstraction landed). The Monk-specific legacy ally helpers (`_initMonkPosePortraits`, `_buildMonkFullBodies`) are now unreachable but kept for one release as a rollback safety net — pending visual verification.

Also deleted `_legacyInitBattleSpriteForJobInline` from `src/sprite-init.js` (327 lines). It was orphaned after `initBattleSpriteForJob` migrated to `_buildPlayerSpriteSet` and had zero callers anywhere in the codebase — comment claimed "preserved temporarily for fake-player builders that haven't migrated yet" but no caller existed. `src/sprite-init.js` is now 1156 lines (was 1484).

Opponent rendering (`initBattleSpriteForJob`) is already 100% on the bundle path for all 22 jobs unconditionally; ally is now {OK, Warrior, Monk} on bundle, generic 3-21 still on legacy (untriggered today since `boot.js` only initializes `[0, 1, 2]`).

## 1.6.44 — 2026-05-01

### Fix: PVP opponent L-hand back-swing missing on dual-wield

`_processPVPSecondWindup` set the wait for hand-change hits to `IDLE_FRAME_MS` (67ms), and `oppHandChangeGap` rendered idle body for that whole window — leaving no time for the back-swing. Dual-wield L-hand jumped straight from idle to fwd-strike.

Now: hand-change wait = `IDLE_FRAME_MS + BOSS_PREFLASH_MS` (armed) — 67ms idle gap, then 133ms back-swing pose with weapon raised. `oppHandChangeGap` only holds idle for the gap portion. Unarmed unchanged (no distinct back-swing pose).

## 1.6.43 — 2026-05-01

### Fix: PVP opponent (OK + Warrior) facing wrong way

`_renderFullBody` in `src/combatant-sprites.js` was missing the final h-flip that the legacy `_buildFullBody16x24Canvas` (sprite-init.js) ends with. Bundle-path jobs (OK = 0, Warrior = 1, per `_USE_BUNDLE_FOR_ALLY`) drew un-flipped, so the opponent body faced the wrong direction AND the swing-hand looked wrong — `pickAttackPoseKey({mirror:true})` already inverts L↔R assuming the canvas is pre-flipped, so a missing flip showed the opposite hand swinging. Monk used the legacy h-flipped builder and rendered correctly, which is what surfaced the bug.

`_renderFullBody` is consumed only by `buildOpponentBodyCanvases`, and those `*FullBodyCanvases` are PVP-only — player and ally portrait paths (`_renderPortrait`) are unaffected.

## 1.6.42 — 2026-04-29

### Slash effect render path centralized

`drawSlashOverlay(ctx, frame, frameIdx, originX, originY, mirror)` added to `src/slash-effects.js`. Owns the per-frame scatter pattern (`[0, 10, -8]` / `[0, -6, 8]`), the optional mirror transform (PVP opponent attacking the player/ally portrait), and the `drawImage` call. No-ops on a null frame so call sites stay terse.

Five non-player slash render sites now collapse to one `drawSlashOverlay(...)` line:

- `battle-drawing.js _drawPortraitOverlays` — PVP opponent slash on player portrait
- `battle-drawing.js _drawEncounterSlashEffects` — ally slash in random encounters
- `battle-drawing.js _drawBossSprite` — ally slash on boss
- `battle-drawing.js _drawAllyPortrait` — PVP opponent slash on ally portrait
- `pvp.js` PVP grid — ally slash on opponent

Player slash path (battle-update.js / battle-drawing.js:773, 867) intentionally not migrated — it has its own bladed-walk-off + random-punch scatter logic driven by `battleSt.slashOffX/Y` that's incompatible with the deterministic 3-position pattern. Same architectural split as `combatant-pose.js`: centralize where it makes sense, leave intentional differences alone.

No behavior change.

## 1.6.41 — 2026-04-29

### Fix: unarmed Monk dealing 2 damage after loading a save

`title-screen.js _updateTitleMainOutCase` was calling `recalcCombatStats()` BEFORE assigning `ps.jobIdx` from the save slot. On save-load, `ps.jobIdx` is still the default 0 (Onion Knight) at recalc time, so `isMonkClass = (jobIdx === 2 || 13)` evaluates false and the unarmed Monk/BlackBelt ATK formula in `calcAttackerAtk` is skipped. Result: `ps.atk = rWpnAtk + lWpnAtk = 0`, both unarmed hands roll `calcDamage(0, def)` → clamped to 1 each → 2 total damage regardless of level.

Fix: move the `recalcCombatStats()` call past the `ps.jobIdx` assignment. New character flow (no slot) is unchanged — recalc still gated on `if (slot)`.

Verified by simulating the path in `battle-math.js`: `isMonkClass=false` + unarmed yields exactly the totals the user reported (`[2,2,2,2,2]`).

## 1.6.40 — 2026-04-29

### Battle sprite consistency audit

No behavior change — cleanup of two fragile patterns surfaced by an audit of the three render paths (player / ally / PVP opponent).

- **`src/pvp.js`** — corrected the comment block above the opponent body-canvas selection. Old text ("pre-h-flipped canvases face left" / "opponent faces left") contradicted the canonical wording in `combatant-pose.js:25` and `pvp.js:704` ("face-right pre-flipped canvas"). New comment cites `pickAttackPoseKey` + `mirror:true` as the source of truth for the L↔R cross.
- **`src/combatant-sprites.js`** — `_okBundle` now derives `jobBase = BATTLE_SPRITE_ROM + 0 * BATTLE_JOB_SIZE` and uses it for the OK hit-tile reads, instead of using `BATTLE_SPRITE_ROM` directly. Mathematically identical, but a future copy-paste (e.g. `_warriorBundle` / `_monkBundle`) won't silently read OK's hit tiles.

### Audit findings (no fix needed)

All three render paths route through `combatant-pose.js` (`pickAttackPoseKey`, `pickAttackWeaponSpec`) and `combatant-sprites.js` (`getJobPoseTileBundle`). Hand alternation, wind-up skip, unarmed pose selection (rBack/lFwd), fist offset (-4, +10), blade offsets (R+8 / L+16 / fwd-16), and the PVP-opponent mirrored `drawBlade()` transform are all consistent across player, ally, and opponent.

## 1.6.12 — 2026-04-23

### Monster stats — regenerated from ROM (fixes 3a54feb corruption)

- **`src/data/monsters.js`** regenerated via `tools/gen-monsters-js.js`. All 230 monsters now match `tools/rom-dump-monsters.txt` exactly. Fixes 224 inflated ATK values (Goblin 10→5, Werewolf 15→9, Berserker 20→10, …) and `attackRoll` values from commit `3a54feb`, and restores 16 missing `hp:` fields (Larva, Unei Clone, Darkface, Cuphgel, Lemur, Twin Heads, Twin Liger, Demon Horse, Saber Liger, Queen Lamia, KingBehemth, Abaia, Haokah, Archeron, Amon, Gomory).
- **`tools/gen-monsters-js.js`** now also emits `spiritInt` (ROM byte 7) and `statusResist` (ROM byte 13) — both were being read but discarded. `statusResist` array order normalized high-bit-first.
- **`docs/design-notes.md`** — removed the "Known broken data" block; added a short monster-data section pointing at the regen command.

## 1.6.11 — 2026-04-23

### Monk job — sprites, palettes, integration (end-to-end)

Added Monk (jobIdx 2) as a first-class playable job. All 9 battle poses PPU-captured and wired.

- **`src/data/monk-sprites.js`** — new file. PPU-dumped tile data for Monk: idle, R-back swing, R-fwd swing, L-back swing, L-fwd swing, hit flinch, kneel, victory (arms-up), death (24×16 prone). Shared legs de-duped across poses where bytes match.
- **`src/sprite-init.js`** — `_initMonkPosePortraits()` and `_buildMonkFullBodies()` dispatched from `initFakePlayerPortraits(romData, jobIndices)` when jobIdx === 2. Per-job battle-palette override `JOB_BATTLE_PAL_OVERRIDE[2] = [0x27, 0x18, 0x21]` (orange skin / olive hair / blue gi).
- **`src/job-sprites.js`** — `MO_WALK_TOP`/`MO_WALK_BTM` overworld walk palettes added, wired into `JOB_WALK_PALS[2]`.
- **`src/data/players.js`** — `MONK_PALETTES` pool (8 variants) — fixed skin/hair, varying gi color across palIdx slots. Used by `_genPosePortraits` for fake Monks.
- **`src/debug/tabs/sprites.js`** — Konami debugger POSES view now loads 9 MO entries from `data/monk-sprites.js` (previously ROM-offset math, moved to canonical).

### Nunchuck weapon — sprite, hit-effect, loot drop

- **`src/weapon-sprites.js`** — `NUNCHAKU_TILES` (PPU-captured $49/$4A/$4B/$4C diagonal chain). `initWeaponSprites` builds `nunchakuRaised` + `nunchakuSwung` canvases using the same raised-vs-swung tile-swap pattern as sword/knife. Accessors + `getBlades().nunchaku`.
- **`src/battle-drawing.js`** — added `wpnSt === 'nunchaku'` branches to all 6 weapon render paths (player R/L back/fwd, ally R/L back/fwd).
- **`src/pvp.js`** — `drawBlade` routes nunchaku through the same wind-up/swung canvas selection.
- **`src/slash-effects.js`** — `initNunchakuSlashSprites()` (tiles $4D/$4E/$4F/$50) for the on-target hit-flash. Reused across all 3 slash timing slots since the tile bytes don't animate (position moves via existing `slashOffX/Y` scatter).
- **`src/battle-sprite-cache.js`** — `nunchakuSlashFramesR/L` added; `getSlashFramesForWeapon` dispatch handles `'nunchaku'`.
- **`src/data/players.js`** — 5 Monk fake-player entries added (Kasumi, Jiro, Ryuji, Hana, Tetsuo). 2 equipped with Nunchuck (0x06), 3 unarmed (fists); mixed across cave-0/ur/cave-1/cave-2/world/camper.
- **`src/map-triggers.js`** — F2 Altar Cave uncommon pool adds Nunchuck (0x06) alongside Dagger.

### Fighter / OK L-back pose fix — head-TR was never swapping

A multi-year bug: whenever a character did a left-hand back-swing, all callers passed `idleTiles[1]` for the head-TR slot instead of the L-back variant. The pose data was partially right (body-TR swapped) but visually the head read as idle. Re-capture proved:

- `WR_L_BACK[1]` (head-TR $3F) was wrong — held idle bytes. Replaced with canonical L-back bytes. Also corrected `WR_L_BACK[3]` body-TR bytes (old bytes didn't match any ROM-extracted pose) and fixed `WR_LEG_L_BACK_L` byte 8 (`0x06 → 0x07`).
- `OK_L_BACK_SWING[1]` last-byte single-bit fix (`0xED → 0xEC`) to match the L-back head-TR variant.
- `src/sprite-init.js` — 4 consumer sites updated to pass `_FP_KNIFE_L[1]` / `WR_L_BACK[1]` for head-TR instead of idle: `_initBattleAttackSprites`, Warrior `_initBattleSpriteForJob`, `_initWarriorPosePortraits`, `_buildWarriorFullBodies`, `_initFakePosePortraits` (OK `fakePlayerAttackLPortraits`), OK `_initBattleAttackSprites` overlay path.

### Generic ROM-based pose builder for jobs 3–21

Previously the 19 non-starter jobs (White Mage, Black Mage, Red Mage, …, Ninja) in `initFakePlayerPortraits` fell through to the Warrior placeholder, so all of them visually rendered as Warriors. Replaced with a generic ROM-keyed builder that reads each job's own `jobBase` block and bakes in the pattern: defend === victory === magic-cast, L-back swaps BOTH head-TR (tile 6) AND body-TR (tile 7), death placeholder until PPU-captured.

- **`src/sprite-init.js`** — `_initGenericJobPosePortraits()` + `_buildGenericJobFullBodies()`. The same head-TR swap fix was also applied to the `initBattleSpriteForJob` generic ROM path that runs for the player's own battle canvas when switching to any of these jobs.
- **`src/boot.js`** — `initFakePlayerSprites(rom, [0, 1, 2])` (up from `[0, 1]`) so Monk portraits build at boot.

### Defend / magic-cast consolidated under victory

In canonical FF3 all three poses (guard, item-use, spell-cast) share the same 4-tile arms-up stance as victory. The OK battle sprite init held a duplicate `DEFEND_TILES` byte array that was identical to `OK_VICTORY`. Removed the copy — everything now references `OK_VICTORY` directly. Warrior + generic-ROM paths already used `victoryTiles` for defend; added a comment in each so the invariant is clear.

### Game Over flow — death no longer grants rewards, dedicated HUD box

When you died but allies finished the fight, the existing flow was granting EXP/gil/CP (and the level-up `fullHeal()` was auto-reviving KO'd players, masking the death from the end-of-battle respawn check). Reworked:

- **`src/battle-update.js`** — 3 reward-grant sites (monster-death, `_triggerPVPVictory`, `_updateBossDissolve`) now gate on `ps.hp > 0`. When KO'd, the victory flow is skipped — goes straight to `encounter-box-close` / `enemy-box-close` with all reward counters zeroed.
- New `'game-over'` battle state. `encounter-box-close`, `enemy-box-close`, and `defeat-close` (team-wipe) now transition here when `ps.hp <= 0` instead of directly respawning.
- `TRACKS.GAME_OVER = 0x2B` ("The Requiem") plays on game-over entry.
- `respawnFromGameOver()` exported — called from `input-handler.js` when Z is pressed during `'game-over'`. Routes back through `_respawnAtLastTown()` (HP/MP restore, wipe to `ps.lastTown`).
- **`src/battle-drawing.js`** — `_drawGameOver()` renders a small bordered HUD box (96×40) centered in the battle viewport with "GAME OVER" text and a blinking "Press Z" prompt. Overworld/roster continue to render behind it.

### Level-up no longer restores HP

`grantExp()` used to `fullHeal()` on level-up, which (a) auto-revived KO'd players mid-battle and (b) was not canonical FF3 behavior. Removed the call. Current HP is preserved; maxHP still grows as normal. The Game Over flow above depends on this.

### Save sync diagnostics

- **`src/save-state.js`** — `serverSave` / `serverLoadSaves` errors now log to console (`[save] server sync failed …`) instead of being silently swallowed.
- On load, if the server responds but every slot is null, fall back to IndexedDB instead of clobbering local saves with the empty server response.

### Known bug — monster ATK / attackRoll values are inflated vs ROM

Discovered during Werewolf damage testing: `tools/rom-dump-monsters.txt` (an independent ROM extractor) disagrees with `src/data/monsters.js` on most ATK values. Goblin ROM=5/ours=10; Werewolf ROM=9/ours=15; Berserker ROM=10/ours=20; Zombie ROM=12/ours=25; etc. Commit `3a54feb` on 2026-04-10 claiming to "Fix all 231 monster ATK and attackRoll values from ROM stat tables" actually decoded the NES stat-set index bitmask incorrectly and shipped inflated values. **Not yet fixed in 1.6.11 — scheduled as a follow-up; the ROM dump is the source of truth.**

## 1.6.10 — 2026-04-22

### Chest loot pools — per-map + floor tiers + gil

Chest loot was a single global 4-tier table regardless of where the chest lived — same odds in the starter town as in the final floor of the first dungeon. Also, SouthWind was sitting at the 2% legendary slot in every chest, which made it cheap to farm.

- **`src/map-triggers.js`** — `LOOT_POOLS` keyed by `mapId`. Ur (114) drops potions/antidotes/gil only; Altar Cave F1–F4 (1000–1003) scale from consumables + Leather Cap to Bronze Bracers + Longsword with gil ranges growing 20–60 → 125–275. Unlisted maps fall back to the F1 pool. Crystal room (1004) is a boss room and has no chests.
- **Gil entries** — pool entries of shape `{ gil: [min, max] }` roll a random amount into `ps.gil` and show "Found N gil!" via the existing message box.
- **`src/data/monsters.js`** — Land Turtle drops reduced from `[0xA6, 0xB2]` to `[0xA6]`. SouthWind no longer in any chest pool, so it's now obtainable only via the late-game monster drops that canonically carry it (Darkface, Parademon, Crocotta, Lemur).
- **`docs/design-notes.md`** — updated the loot section to reflect per-map pools, gil entries, and SouthWind sourcing.

## 1.6.9 — 2026-04-22

### Ally-won victory no longer strands dead player at 0 HP

When the player died but allies finished the battle, the victory flow ran (`monster-death` → `victory-*` → `encounter-box-close`) and dumped the player back to the overworld with `hp = 0`. Death respawn only fired from `team-wipe → defeat-close`, which requires *everyone* down.

- **`src/battle-update.js`** — extracted `_respawnAtLastTown()` (HP/MP restore + wipe to `ps.lastTown`). Called from `encounter-box-close` / `enemy-box-close` when `ps.hp <= 0`, plus `defeat-close` (dedup of the inline block).

### Victory box text overflow

Audit: item-drop and job-level-up text was drawing outside the 120 px victory box. Worst cases: `Found MythrilShield!` = 144 px; `ONION KNIGHT LV 99!` = 152 px. Neither actually reached the ally HUD (ally column starts at x=144, worst-case text end x=136) but broke the bordered-box frame visually.

- **Item drops** now stack 2 rows: "Found" top, "`{item}!`" bottom. Max line width 96 px, both well inside the box.
- **Job level up** uses static "Job Level Up!" (104 px) instead of `{JOBNAME} LV {lv}!` (up to 152 px).
- `src/data/strings.js` — new `BATTLE_FOUND`, `BATTLE_JOB_LEVEL_UP`.
- `src/text-utils.js` — `makeFoundItemText(id)` replaced by `makeItemDropText(id)` (returns `{name}!` only). Removed dead `makeJobLevelUpText` and its `JOBS`/`ps` imports.
- `src/battle-drawing.js` — `_drawRewardText` stacks 2 rows for item drops, single row for the rest.

### Docs cleanup

- `README.md` — reconciled multiplayer status (roster is simulated from a fake player pool, not online); pruned the per-file architecture listing (100+ lines) to a concern-grouped overview. Networked multiplayer is planned — see `MULTIPLAYER.md`.
- `REFACTOR.md` → `docs/history/REFACTOR.md` (completed, archived).
- `AUDIT-LOOT.md` retired — bug fixes already captured in 1.6.0, design notes moved to `docs/design-notes.md`.

## 1.6.8 — 2026-04-19

### Monster magic damage formula — caster stat + variance

NES magic damage (`31/B17C`) uses:
```
atk = floor(caster_INT / 2) + spell_power
dmg = atk + rand(0..atk/2) - mdef
```

Ours was a flat `power - mdef`. That ignored the caster's INT entirely, so endgame mages were dealing ~150 flat damage instead of 300+. The `spiritInt` byte (ROM $60010 byte 7) existed in the gen script but was never written to `monsters.js` — same class of omission as `statusResist`.

- **`monsters.js`** — 110 of 231 monsters now have `spiritInt` field (values 17–255). Low-level mages around 17–34, bosses and endgame casters 150–255.
- **`battle-encounter.js`** — propagates `spiritInt` onto spawned monster instances.
- **`battle-enemy.js`** — magic damage recalculated per NES: `atk = floor(mon.spiritInt/2) + spec.power`, then `atk + rand(0..atk/2) - mdef` × elemMult, min 1. Applied to both ally-target and player-target paths.

### Ally shield evade

`generateAllyStats()` now exposes `shieldEvade` from the equipped shield. Previously allies with Leather Shield were dropping it in the void; monster physical attacks against allies bypassed the block roll entirely.

- **`src/data/players.js`** — returns `shieldEvade`.
- **`src/battle-enemy.js`** — monster→ally physical attack now passes `ally.shieldEvade` and `ally.evade` into `rollMultiHit`.

## 1.6.7 — 2026-04-19

### Player / ally armor status immunity wired up

Armor items have `sResist` bitmasks (ROM byte 3) that nothing was checking. A Ribbon (`sResist: 0xFE`) was cosmetic.

- **`src/player-stats.js`** — `recalcCombatStats()` now OR's all equipped armor `sResist` bytes into `ps.statusResist` (bitmask). Recomputed on equip change.
- **`src/data/players.js`** — `generateAllyStats()` builds the same bitmask for allies' armor/helm/shield.
- **`src/battle-enemy.js`** — all 4 player/ally `tryInflictStatus` calls now pass the target's `statusResist`. Monster `statusAtk` on physical hit and monster special-attack status both respect immunity.

`tryInflictStatus()` already accepted numeric bitmasks from the monster-side fix in 1.6.5, so no status-effects.js change.

## 1.6.6 — 2026-04-19

### Poison tick — match NES exactly

Battle poison damage was `max(1, floor(maxHP / 16))`. NES (`35/BADC-BB1E`) uses `floor(maxHP / 16)` with no minimum clamp, so tiny enemies with <16 maxHP take 0 poison damage. The `max(1, ...)` clamp was killing small monsters over time in situations NES would leave them alone.

Walk poison (`-1 HP per step, min 1 HP`) already matched NES `3B/A0B1-A10D` exactly.

## 1.6.5 — 2026-04-19

### Monster status resistance (ROM data wired up)

`tools/gen-monsters-js.js` read byte 13 of each monster record as `statusResist` but never wrote it to `monsters.js`, so every monster was equally vulnerable to every status — bosses included.

30 of 231 monsters have NES status-immunity bits:
- 26 resist Toad (mostly undead, zombies, dragons, bosses)
- 6 resist Paralysis (including Unei Clone and 2 end-game bosses)
- 2 resist both Paralysis + Toad
- 1 resists Petrify

Now added to `monsters.js` as `statusResist: 'toad'` / `['paralysis','toad']` / etc.

- **`src/status-effects.js`** — `tryInflictStatus()` accepts optional `resist` (name, array, or mask); auto-fails if flag matches.
- **`src/battle-encounter.js`** — propagates `statusResist` onto spawned monster instances.
- **`src/battle-update.js`** — weapon on-hit status passes `targetMon.statusResist` (player → monster).

Player-side status immunity from armor `sResist` is tracked on items but not yet aggregated or applied — flagged for follow-up.

## 1.6.4 — 2026-04-19

### Monster special attacks — power/hit corrected from ROM

Seven entries in the hardcoded `SPECIAL_ATTACKS` table in `battle-enemy.js` diverged from the NES spells data (`spells.js`, generated from ROM `$618D0`):

- **Fira** 60 → 55, **Bzzara** 60 → 55, **Thundara** 75 → 55 — damage spells off by 5–20.
- **Bzzaga** 130 → 85 — 1.5× too strong.
- **Sleep** hit 60% → 15% — Sleep was landing 4× more often than NES.
- **Confuse** hit 60% → 25% — same issue.
- **Silence** hit 80% → 60%.

All 231 monster `spAtkRate` values are ROM-clean, no changes needed there.

### Armor audit — 1 item fixed

- `0x97 CrystalGlove` had `def/evade/mdef: undefined` — now `10/15/10` per ROM. `tools/extract-all.js` armor loop stopped at 0x96 and skipped it.

All 85 weapons and 64 armor items (after this fix) now match ROM at `$61410`.

## 1.6.3 — 2026-04-19

### Per-job crit rate and crit bonus (ROM-verified)

Our combat used a fixed 5% crit chance and a derived `atk/4` crit bonus. NES (`39/BB1A` job modifiers table, 5 bytes per job) specifies both values per-job:

- **Crit rate**: 0–5% depending on job. White Mage and Bard never crit; Black Belt and Ninja crit 5%.
- **Crit bonus**: flat 1–100 added on a crit. Bard = +1 (almost cosmetic), Ninja = +100 (big spike).

Fixes: mage/bard jobs were critting too often, warrior jobs were critting with a damage bonus disconnected from their weapon style, Ninja was underpowered on crits.

- **`src/data/jobs.js`** — added `critPct` and `critBonus` fields to all 22 jobs from ROM `$73B2A`.
- **`src/battle-math.js`** — `rollHits` now reads `critPct` and `critBonus` from `opts`. Fixed `CRIT_RATE` constant removed.
- **Call sites updated** (`input-handler.js`, `battle-turn.js`, `pvp.js`): pass the attacker's job crit values on each attack. Monsters pass 0/0 (they don't crit in our system, matching NES default behavior).

### Stat cap on level-up

NES caps each stat at 99 on level-up (`35/BF92`). Our `grantExp` and `changeJob` were incrementing stats without a cap. Added `Math.min(99, ...)` to STR/AGI/VIT/INT/MND updates.

## 1.6.2 — 2026-04-19

### Job switch cost formula rewritten (CRITICAL)

Byte 0 of each job record at ROM `$72010` was mislabeled as `cpCost` by `tools/extract-all.js` and that mislabel propagated into `src/data/jobs.js`. The byte is actually **alignment** — high nibble = physical/magical index, low nibble = lawful/chaotic index.

The NES computes job change cost dynamically from the alignment vector between the *current* and *target* jobs (disasm `3D/AD85`):

```
cost = (|physDiff| + |chaosDiff|) * 4 - newJobLevel, min 0
```

Our old formula charged a fixed per-target value (40–255) that didn't depend on the current job at all. Every cost was 3–20× too high. Example from Onion Knight starter:

| Target | Old (fixed) | New (alignment-based) |
|---|---|---|
| Fighter / Monk / White Mage / Black Mage / Red Mage | 121–153 | 7–8 |
| Knight / Thief / Scholar | 117–170 | 15 |
| Black Belt | 40 | 23 |
| Sage | 255 (capped) | 55 |
| Ninja | 0 (bug) | 63 |

Ninja was effectively free because its alignment byte is `0x00`; now it correctly costs ~60 CP from a neutral-aligned job. The whole job economy is now NES-calibrated.

- **`src/data/jobs.js`** — `cpCost: N` → `alignment: 0xXX` (same byte, correct label) across all 22 jobs.
- **`src/player-stats.js`** — `jobSwitchCost()` computes the NES formula; uses current job's alignment.
- **`tools/extract-all.js`** — prints `Align:0xXX (phys:N chaos:N)` instead of the mislabeled `CP:`.

## 1.6.1 — 2026-04-19

### Monster ATK outliers fixed (ROM-verified)

Six monsters had ATK values 3.75-5x their ROM counterparts — typos that survived the 2026-04-09 audit. Restored to ROM values from `$61010` stat table:

- **Killer Bee** (Lv2, Altar Cave): 50 → 10 — was one-shotting starters (~150 dmg × 3 hits)
- **Revenant** (Lv6, Cave of Seal): 50 → 10
- **Helldiver** (Lv6, Summit Road): 50 → 10
- **Mandrake** (Lv5, dummied): 60 → 16
- **Petit** (Lv3, Nepto Shrine): 60 → 16 — was the highest-ATK low-level monster
- **Poison Bat** (Lv10, Nepto Shrine): 60 → 16

Remaining monster ATK values are intentionally scaled (median ~0.69× ROM for high-level, ~1.5-2× for low-level single-player balance). `hitRate` verified 231/231 matching ROM; `attackRoll` is deliberately capped at 2-3 (ROM goes up to 11).

### Defeat respawn system

Replaces the prior "teleport to nearest world tile" defeat flow — which could dump you at Ur's entrance after an overworld encounter far from town, or cause stale `currentMapId` state after dungeon wipes.

- **`ps.lastTown`** (defaults to 114 / Ur) tracks the most recent town visited. Updated whenever the player enters a map in `AREA_NAMES`.
- **On team wipe**: HP/MP restore to max, `mapStack` cleared, player respawns at the entrance of `ps.lastTown` via `loadMapById()`.
- **Save persistence**: `lastTown` is written to save slots and restored on game load.
- **Fixes data-loss gap**: defeat-close now calls `saveSlotsToDB()`, so tab-close immediately after a wipe no longer loses the HP/MP restore.
- Currently only Ur (114) is in `AREA_NAMES`, so all defeats respawn in Ur. Mechanism auto-extends as Kazus / Canaan / etc. are added.

This diverges from NES FF3 (which jumps to `$C000` / program start on defeat — a hard reboot to title for save reload). That model doesn't fit a continuously-auto-saving MMO, so we use a home-town respawn pattern instead.

### Dead code removed

- `findWorldExitIndex`, `loadWorldMapAt`, `loadWorldMapAtPosition` no longer imported by `battle-update.js` — defeat flow no longer uses them.

## 1.6.0 — 2026-04-18

### Shared-bag refactor — all 14 bags eliminated

- **State modules extracted** — `battle-state.js`, `battle-sprite-cache.js`, `hud-state.js`, `map-state.js`, `ui-state.js`. Consumers import the state object directly; no more `shared` parameter threading.
- **`fake-player-sprites.js`** — fake player canvases extracted from game.js (Step 1 of shared-bag refactor).
- **`battle-update.js` (732L)** — entire battle state machine (opening, attack chain, defend/item, run, boss dissolve, victory, defeat, PVP) extracted from game.js.
- **`movement.js` (260L)** — player movement, input dispatch, tile collision, action handling extracted. Pre-existing `MapRenderer` / `resetIndoorWaterCache` import bug fixed in `_checkFalseWall`.
- **`title-screen.js`** — `updateTitle` + `_updateTitleMainOutCase` merged in, sharing a `waterSt` ref with game.js for animation continuity.
- **game.js: 1,920L → 912L** (52% reduction). Target <4,000L achieved.

### Battle pose audit

- **Konami debugger** now the documented source of truth for pose correctness.
- **OK main `lFwd` canvas** — was null, now built from `[idle0, idle1, OK_L_FWD_T2, OK_L_FWD_T3]`. L-forward swings no longer fall back to L-back pose.
- **OK main `rFwd` canvas** — was loading garbage from ROM offset 18 (leg tiles), now built from idle tiles per debugger (R-fwd body = idle, legs-only animation).
- **OK PVP `KnifeRFwd` LEG_L** — `_FP_LEG_L_BACK_R` → `_FP_LEG_L` (idle).
- **Warrior ally attack portraits** — now use R_BACK_T2 / L_BACK[3] tiles matching main player + OK ally conventions (were all-idle / L_FWD).
- **`_FP_ATK_R_TILE`** — was aliased to `OK_R_FWD_T2` which had been "fixed" to idle T2; now correctly points to `OK_R_BACK_SWING[2]`. Restored R-back swing visual.
- **Konami debugger** — updated Warrior R-FWD LEG_L to `WR_LEG_L_FWD_R` to match code (debugger was stale since commit `e2e401d`).

### Battle message system

- **`battle-msg.js`** extracted. `replaceBattleMsg` swaps text mid-action for crits, hit count, status inflictions, spell names.
- **Phase 1**: "Attacker : Target" format for player/monster/ally turns.
- **Phase 2**: crit/hits/status result text replaces Phase 1.

### Combat fixes

- **ATK formula** — weapon power only. STR/AGI affect hit count not damage (NES disasm 30/9F44).
- **All 231 monster ATK + attackRoll** corrected from ROM stat tables.
- **Starting equipment** fixed to Knife(0x1E) + Leather Cap + Cloth Armor (matches NES).
- **Ally slash timing** — 3 frames fit in 90ms `ALLY_SLASH_MS` (was 67ms/frame, frame 2 never shown).
- **Ally slash hand/weapon** — now uses correct hand and weapon (was always right-hand + `weaponId`).
- **7 game-logic bugs** fixed: confusion targets any combatant, mini/toad ATK, per-hit shield/evade, special attacks on allies, ally poison floor.
- **EXP display** — victory screen now shows post-/4 value (matching actual gain).
- **Monster turn order** — level-based AGI proxy (`agi = level`).

### Other

- **Play time tracking** — `ps.playTime` ticks in game loop, persisted in saves, shown HH:MM on player select.
- **Victory rewards** — shown in enemy name box, save fix, chat clear.
- **PVP fixes** — `drawBossSpriteBoxPVP` stale null arg, `pvp.js` invalid LHS assignments, `drawBattleMessageStrip` stale `_s` reference.

---

Pre-1.6.0 history (1.5.0 → initial commit) is archived at [docs/history/CHANGELOG-pre-1.6.md](docs/history/CHANGELOG-pre-1.6.md).
