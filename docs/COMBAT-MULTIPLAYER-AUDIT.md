# Combat + fake-player → websocket readiness audit

Started 2026-05-15. Scope: every code path that a fake-player decision
or a battle action goes through, with the question "does this still
work when the fake is replaced by a remote player?" Reads only — no
behavior changes landed by this doc.

Companion to `MULTIPLAYER.md` (roadmap) and the v1.7.20x–v1.7.21x
audit series. This is the **combat-system** half of that prep; the
earlier series handled save/inventory/economy/job-EXP/modularization.

## TL;DR

Spell + physical *effect application* is already in good shape — one
`combatant-cast.js`, one `physical-attack.js`, one `battle-math.js` for
hands and initiative. The websocket gaps are above that layer:

1. **No single AI seam.** Per-role decision trees (`_tryAlly*` in
   `battle-turn.js` mirrored by `_tryPVPEnemy*` in `pvp.js`) duplicate
   target search + state-bag write six times. Replacing the AI with a
   wire signal means swapping at six sites today.
2. **Cross-faction targeting is gated by per-AI allowlists**, not by
   the apply layer. Ally→ally damage, ally→player damage, PvP→PvP-ally
   damage, PvP→player-ally heal — none are possible today.
3. **No resolution-time target redirect** for spells or items. Spells
   silently miss when the picked target dies during windup; items
   no-op.
4. **`Math.random` everywhere, unseeded.** Two clients will diverge on
   the first hit roll.
5. **HP / status / death / inventory writes are direct mutations**, not
   intent→delta. No interception seam for a server-authoritative wire.

None of these block current single-player play. All of them block the
websocket swap.

## READY (websocket-clean today)

| Surface | Single source | Notes |
|---|---|---|
| Spell effect application | `src/combatant-cast.js#applySpell` + `applyMagic{Damage,Heal,CureStatus,Status,Drain,Recovery,AllStatus,Instakill,Erase,Sight}` | All three role engines call the same helpers (`spell-cast.js:18-21`, `battle-ally.js:23-24`, `pvp.js:32-33`). v1.7.181 unified. |
| Physical hit application | `src/physical-attack.js#applyPhysicalHitToEnemy` | Single sink for player + ally → enemy / boss / PVP-main. Wake-on-hit, weapon-status, crit-flash centralized (v1.7.208 dedup). |
| Hand selection (dual wield) | `src/battle-math.js#isRightHandHit` / `#isLeftHandHit` | Player (`battle-update.js:361`), ally (`battle-ally.js:93,147`), PVP (`pvp.js:927`) — same call. |
| Initiative | `src/battle-math.js#rollInitiative` | `buildTurnOrder` (`battle-turn.js:27-58`) uses it for all four actor types. |
| Hit-result summarization | `src/battle-math.js#summarizeHits` | Combo finalizers (player + ally + PVP) all share. |
| MP debit | Two sites — both player-only (`spell-cast.js:259`, `pause-menu.js:694`) | Fake roster doesn't track MP. Real players will, but the apply seam already exists. |
| Spell SFX selector | `src/combatant-cast.js#getSpellImpactSFX` / `#playSpellImpactSFX` | Engine drives SFX at anim start everywhere; helpers never carry SFX (memory rule). |

## NEEDS WORK (works today, will glitch with real players)

### 1. AI is duplicated three ways, six functions

- `src/battle-turn.js#_tryAllyCure / _tryAllyPoisona / _tryAllyOffensiveCast / _tryAllyItem` (lines ~171-178 and below)
- `src/pvp.js#_tryPVPEnemyCure / _tryPVPEnemyPoisona / _tryPVPEnemyOffensiveCast / _tryPVPEnemyItem` (lines ~325-340)
- Inline melee target-pick at `pvp.js:376-386`

Each duplicates AI gating, target search, damage/heal roll, and
state-bag write. Websocket swap wants one `combatant-ai.js#decideAction(combatant, board)`
that returns an intent object `{kind, casterId, targetId, spellId?, itemId?, payload}`,
applied by one dispatcher. Doing it once is a refactor; doing it after
the wire lands is six divergent refactors.

### 2. Per-role active-cast state bags duplicate the same shape

- `battleSt.allyMagic*` (`battle-state.js:71-79`)
- `pvpSt.pvpMagic*` (`pvp.js:101-111`)
- Module-locals in `spell-cast.js:34-58` for the player

Same fields three times (`casterIdx`, `targetType`/`targetCellIdx`,
`partyTargetIdx`, `spellId`, `healAmount`, `damageRoll`,
`effectApplied`, `sfxPlayed`). A wire-delivered cast intent has no
canonical bag to write to. Unify into one `activeCast` keyed by
`(casterFaction, casterIdx)`.

### 3. Cross-faction targets are blocked at the AI layer, not the apply layer

- Ally → ally damage: blocked. `_tryAllyOffensiveCast` (`battle-turn.js:421-480`)
  restricts target list to `'enemy'` / `'pvp-enemy'` only (lines 436-452).
- PvP enemy → PvP-enemy damage: blocked. `_tryPVPEnemyOffensiveCast`
  (`pvp.js:626-661`) restricts to player + player's allies.
- Player → ally damage: blocked at `spell-cast.js:497-501` ("Ineffective"
  early-return when `spell.target === 'enemy' | 'all_enemies' | 'enemy_status'`).
  The confused-attack path (`battle-turn.js:138-140`) already proves the
  engine can write friendly damage — only the cast path refuses.
- PvP enemy → player-ally heal: impossible. `_tryPVPEnemyCure` (`pvp.js:586-590`)
  scopes target set to `_pvpEnemyTeamCellIdxs()`.

Fix shape: make `applySpell` faction-agnostic (it largely is — the
filtering is in the AI). Replace the per-AI target-list faction filter
with `getLivingCombatants()` + a target-priority hint. Let the apply
layer accept any combatant pair.

### 4. No resolution-time target redirect

- Player melee: redirects on dead target (`battle-turn.js:537-541`).
- Ally melee: random-living at decision time; if monster dies before
  slash, `applyPhysicalHitToEnemy` silently no-ops.
- PvP-enemy melee: decision-time pick only (`pvp.js:376-386`).
- Player spell: NO redirect. `applyMagicDamage` early-returns at
  `target.hp <= 0` (`combatant-cast.js:210`); spell wastes silently.
- Multi-target heal: targets rebuilt at cast start (`spell-cast.js:189-192`)
  but not after the 800 ms windup — an ally that dies during windup
  gets a wasted heal slot.
- Item: no fallback (`_playerTurnConsumable` in `battle-turn.js:551-610`).

User's spec: "targeted first, fallback to next-living" for melee AND
spell AND item. Single helper `resolveTarget(intent, board) → liveTargetOrNull`,
called at *apply time*, used by every action path.

### 5. RNG is unseeded `Math.random`

`battle-math.js:13, 56, 92, 115, 142-145, 149` plus 100+ call sites
across `battle-turn.js`, `spell-cast.js`, `pvp.js`, `battle-enemy.js`,
`pvp-search.js`, `roster.js`. Two clients running the same battle
diverge immediately. Solution: central `src/rng.js` with seedable PRNG;
server picks seed at battle start (or serves authoritative results and
the client uses `Math.random` only for cosmetic-only rolls).

### 6. Direct HP mutation, no intent→delta seam

- Player HP writes (7): `battle-enemy.js:109,112,220`,
  `battle-turn.js:135,278,575`, `pvp.js:864,947`.
- Ally HP writes (5): `battle-enemy.js:71`, `battle-turn.js:139,289`,
  `pvp.js:870,944`.
- Monster + cross-faction HP via `applyPhysicalHitToEnemy` and the
  `applyMagic*` helpers (`combatant-cast.js:213,229,263,277,320`).

All are `target.hp = …`. Server-authoritative play needs each write to
emit `{type:'hp-delta', targetId, value, source}` through one
reducer. Introduce `dispatchDelta(d)` so the websocket layer can
intercept (or buffer-and-replay for rollback netcode if it comes to
that).

### 7. Status, KO, item-consume, XP/Gil are local-only

- Status: `tryInflictStatus` / `addStatus` / `removeStatus`
  (`status-effects.js`) called inline from ≥8 sites (`physical-attack.js:54`,
  `battle-enemy.js:77,119,132,226`, `combatant-cast.js:240,318,341`,
  `battle-update.js:723`). No broadcast hook.
- Death/KO: ally death timer (`battle-ally.js:174`, `pvp.js:749,893`);
  monster death (`battle-update.js:451`, `battle-ally.js:46`,
  `spell-cast.js:727`); PvP dissolve. Unify into `applyDeath(combatantId)`.
- Item consumption: `removeItem(pending.itemId)` at `battle-turn.js:615`,
  player only.
- XP/Gil/CP/JP: `grantExp`/`grantGil`/`grantCP`/`gainJobJP` at
  `battle-update.js:499-506, 536-541, 650-655`, player-local. For
  party play these need party-aware distribution.

### 8. Turn order is rebuilt locally on every menu confirm

`buildTurnOrder` (`battle-turn.js:27`) sorts by `rollInitiative` (random)
on each call. Two clients = two orders. Server builds once and
broadcasts; clients render what they're told.

### 9. `battleSt.enemyTargetAllyIdx` is a single integer

Set at `pvp.js:306,939`, `battle-enemy.js:199`, `battle-ally.js:175`.
With multiple PvP-enemy combatants simultaneously targeting different
player-side combatants (which real multiplayer ticks will produce),
this single slot collides. Make it per-attacker.

### 10. Player target-legality has a friendly-damage block

`spell-cast.js:497-501` rejects offensive spells aimed at friendlies.
Per the audit ask, the player should be able to hit their own ally
deliberately (Confuse already does it via RNG). Drop the early-return;
route through `applyMagicDamage` like the confused-attack path.

### 11. Item targeting is roster-friendly only

`_playerTurnConsumable` (`battle-turn.js:551-610`) only resolves
`target === 'player'` (self/ally) or `target === 'enemy'` with
`effect = 'heal'`. There is no path for "use battle item on own ally
as damage" or "use heal item on enemy in PvP" outside the
`animSpellId` branch. Fake-player items (`_tryAllyItem`,
`_tryPVPEnemyItem`) restrict to same-team teammates only.

### 12. Spell-cast module-locals don't survive interleaving

`spell-cast.js:34-57` (`_spellId`, `_targets`, `_hitIdx`,
`_effectApplied`, `_baseAmount`, `_sfxPlayed`, `_isItemUse`,
`_magicHitPhase`). A remote-player cast intent arriving mid-local-cast
will clobber. Roll into the unified `activeCast` bag from #2, keyed by
casterId.

### 13. PvP-vs-monsters cross-mode is not modeled

`buildTurnOrder` (`battle-turn.js:37-55`) is `if/else if`: monsters
OR `pvpEnemyAllies`, never both. Multiplayer could plausibly want
"two parties in the same encounter"; the engine has one PvP-enemy
roster slot OR one monster roster slot.

### 14. Confused-player friendly attack computes damage inline

`battle-turn.js:128-147` rolls hits and writes HP outside
`applyPhysicalHitToEnemy`. If confuse ever extends to allies or
PvP-enemies, the math gets re-implemented. Generalize
`applyPhysicalHitToEnemy` (rename to `applyPhysicalHit`) to accept
friendly targets.

## MISSING (capability the user wants, not implemented)

- **Cross-faction free-for-all targeting.** No engine path allows:
  ally→ally damage, ally→player damage, player→ally damage (outside
  confuse RNG), PvP→player-ally heal, PvP→PvP-ally damage. Items
  mirror the same restriction.
- **Resolution-time target redirect for spells + items.** Only player
  melee redirects today.
- **Authoritative-delta broadcast layer.** No `applyDelta` / `emitDelta`
  seam exists. Every handler writes directly.
- **Seeded RNG.** No `rng.js`.
- **Per-combatant inventory + MP tracking for non-player actors.**
  Fake roster doesn't track either; real players will.

## Recommended fix order

Lowest-blast-radius first; each step keeps single-player working and
removes one class of divergence.

1. **`src/rng.js`** — seedable PRNG, swap `Math.random` at the ~7 sites
   in `battle-math.js` and the AI decision sites. Cosmetic-only rolls
   stay on `Math.random`. (Tiny diff; immediate divergence win.)
2. **`resolveTarget(intent, board)`** in `battle-math.js` — single
   helper for "picked target if alive, else next-living-in-faction,
   else null". Use it at apply time in physical / spell / item paths.
   Closes #4. Also closes the silent-miss class of spell bugs.
3. **`combatant-ai.js#decideAction(combatant)`** returning intent
   objects. Replace the six `_tryAlly*` / `_tryPVPEnemy*` callsites
   with one switch. Closes #1.
4. **Faction-agnostic target lists in AI** + drop the
   `spell-cast.js:497-501` friendly block. Closes #3, #10, #11.
5. **Unified `activeCast` bag** keyed by casterId. Closes #2, #12.
6. **`dispatchDelta(d)`** for HP/status/KO/inventory/XP. Closes #6, #7.
7. **Per-attacker `enemyTargetAllyIdx` (or remove)**. Closes #9.

After 1-3, fake↔real swap is a single-day plumbing job at the AI seam.
After 1-6, the engine is server-authoritative-ready and a remote
combatant looks identical to a local one to every code path beneath
`dispatchDelta`.

## Out of scope

- The `pvp-search.js` sim-timer cutover seam (already documented in
  `MULTIPLAYER.md` Step 3).
- Save persistence (covered by `SAVE-STATE-AUDIT.md`).
- Inventory/economy persistence (`INVENTORY-ECONOMY-AUDIT.md`).
- Stat scaling / job EXP (`JOB-EXP-AUDIT.md`).
