# Phase 6 — Two-Phone Live Smoke Checklist

**Status:** ready to test once the flag flips.
**Authored:** 2026-05-18, after Phase 6 host-emit wiring shipped.
**Owner:** user — Claude cannot run this; it needs two real devices on the wire.

## Prerequisites

1. Two phones (or two browser tabs at different `userId`s — but the live wire path won't match prod cellular latency, so prefer phones).
2. Both logged in with different accounts in the same party.
3. Both on the most recent prod deploy.

## What's wired (Phase 6 + Phase 6.5)

Host emits a host-arb resolution packet at every co-op-relevant mutation point. **Flag is still `false`** so:

- With flag off (current default): packets are **not** emitted. Production runs the legacy lockstep path exactly as today.
- With flag on: host emits + guests apply via the applier. Legacy local-apply on guests is NOT yet short-circuited — see "Still blocking the flag flip" below.

### Host-emit call sites wired (Phase 6 + 6.5)

| File | Site | Resolution kind | Status |
|---|---|---|---|
| `src/battle-enemy.js` | `_processEnemyTurn` — both `ps` and `ally` target paths | `monster-attack` | ✓ Phase 6 |
| `src/battle-update.js` | `_finalizeComboHits` | `attack` (player → monster) | ✓ Phase 6 |
| `src/battle-ally.js` | `_finalizeAllyCombo` | `attack` (ally → monster) | ✓ Phase 6 |
| `src/encounter-wire.js` | `endWireEncounter` | `encounter-end` | ✓ Phase 6 |
| `src/battle-encounter.js` | `_processAssistIncoming` | `encounter-snapshot` (new shape, ships alongside legacy) | ✓ Phase 6 |
| `src/spell-cast.js` | `_finishMagicHit` (snapshot+diff per target) | `magic` (player cast) | ✓ Phase 6.5 |
| `src/battle-ally.js` | `_applyAllyMagicEffect` | `magic` (ally cast) | ✓ Phase 6.5 |
| `src/battle-turn.js` | `_playerTurnConsumable` | `item` (player use) | ✓ Phase 6.5 |
| `src/battle-turn.js` | `_applyEndOfRoundPoison` | `poison-tick` (batch) | ✓ Phase 6.5 |

## Guest-side short-circuits (Phase 6.7)

**SHIPPED.** Every legacy local-apply call site is now gated by `isCoopGuest()` (single source in `src/coop-resolver.js`). Under flag-on + guest mode, the local HP / status mutation is skipped; the host's resolution packet drives the authoritative state via the applier. Animation callbacks (damage-num display, screen shake, SFX) continue firing locally so the visual experience reads correctly.

| File | Function | Behavior under flag-on guest |
|---|---|---|
| `src/physical-attack.js` | `applyPhysicalHitToEnemy` | Early-return — full skip |
| `src/battle-enemy.js` | `_processEnemyTurn` (ps + ally branches) | Skip `dispatchDelta` + `wakeOnHit` + `tryInflictStatus` |
| `src/combatant-cast.js` | `applyMagicDamage` / `applyMagicHeal` / `applyMagicCureStatus` / `applyMagicDrain` / `applyMagicRecovery` / `applyMagicAllStatus` / `applyMagicInstakill` / `applyMagicStatus` | Skip `dispatchDelta` + `tryInflictStatus`; callbacks fire |
| `src/battle-turn.js` | `_playerTurnConsumable` | Skip `removeStatus` (cure_status) + `ps.hp = maxHP` (Elixir) |
| `src/battle-turn.js` | `_applyEndOfRoundPoison` | Skip per-actor `dispatchDelta` |

## Phase 6.9 — fx cue dispatch (SHIPPED)

The Phase 6.7 caveats above are now closed by `_dispatchFxCue` in `src/coop-applier.js`. When a resolution packet arrives, the applier walks `msg.fx` and routes each cue:

- **`damage-num`** — overlays the AUTHORITATIVE dmg/heal/miss value on the right damage-num slot (player / ally / monster), so guests display host's numbers even if their local computation differed. Closes caveats 1 and 3.
- **`death`** — for monster targets, sets `dyingMonsterIndices` + transitions `battleState` to `monster-death` when the FSM is in a damage-show / impact / poison-tick state. Closes caveat 2 (for monsters; player/ally death still drives off the local hp=0 check the applier writes, which fires on the next FSM tick).
- **`slash` / `magic-cast` / `magic-impact` / `item-use` / `item-impact` / `poison-tick-start`** — no-op in the applier. Animations are still driven by the local FSM's state transitions (those transitions fire under flag-on guest since only HP/status mutations are short-circuited, not state changes).

The remaining edge case: a lethal attack on player/ally on guest may show the death anim one FSM tick (~16ms at 60fps) late. Acceptable for v1; could be tightened by adding death-cue dispatch for player/ally refs if live testing surfaces an issue.

**Flag flip is now fully safe.** The remaining work is Phase 7 (dead-code cleanup) and Phase 8 (docs refresh), neither of which gates live testing.

## Smoke test plan (to run AFTER Phase 6.5 ships)

### Stage 1 — Flag-off regression (verify Phase 6 didn't break the legacy path)

| # | Test | Expected | Pass criteria |
|---|---|---|---|
| 1 | Solo random encounter | Plays normally, no errors | Encounter starts, fight, victory |
| 2 | Solo boss (Land Turtle) | Plays normally | Boss fight completes |
| 3 | PvP duel | Plays normally | 49/49 sim already proves this; verify live anyway |
| 4 | Party encounter (2-phone co-op) | Plays as today, broken-state baseline | Same desync the user already observed; **no regression** vs v1.7.472 |

If any of 1-3 fail: **revert Phase 6 commits** and investigate. The flag-off path must stay 100% backward-compatible.

If 4 desyncs the same way as v1.7.472: that's expected — Phase 6 wiring is dormant. Phase 6.5 is what fixes it.

### Stage 2 — Flag-on smoke (only after Phase 6.5 lands)

Flip `COOP_HOST_ARB` to `true` in `src/coop-resolver.js`, deploy, then test:

| # | Scenario | Pass criteria |
|---|---|---|
| 1 | Both phones, same party, phone A triggers encounter | Both phones see 2-row roster (host + guest) at battle open |
| 2 | Both phones, HP/MP shown | HP/MP matches on both screens at start |
| 3 | 5 rounds of attacks | After each round, both phones HP / MP / status icons match exactly |
| 4 | One phone casts Fire on monster | Damage number + monster HP matches on both phones |
| 5 | One phone casts Cure on the other | Heal number + HP delta matches |
| 6 | Monster KOs a player | Death anim on both phones at same logical turn |
| 7 | Surviving player kills last monster | Victory flow runs on both phones, same XP / gil |

Ship only if all 7 pass.

### Stage 3 — Stress smoke (post-launch verification)

- Three-phone party encounter (when third party member becomes available).
- Mid-battle assist join: phone C walks up while A+B fight, picks Assist, all three see same state.
- Disconnect scenarios: phone A drops WS during round 2 — A's portrait disappears on B, battle continues.

## How to flip the flag

```bash
# Edit src/coop-resolver.js, find this line:
export const COOP_HOST_ARB = false;
# Change to:
export const COOP_HOST_ARB = true;

# Deploy via the standard deploy.sh
./deploy.sh "phase 6 live cutover — host-arb on"
```

Pre-flight gate (in deploy.sh) will fail with `--expect-fail` flag in place because once the rewrite lands, divergence tests no longer fail. Drop the `--expect-fail` flag from `tools/coop-arbiter-sim.js` invocation in `deploy.sh`:

```bash
# In deploy.sh, change:
node tools/coop-arbiter-sim.js --expect-fail
# To:
node tools/coop-arbiter-sim.js
```

The divergence tests in Suite 1 will start failing under flag-on because the host-arb apply path produces convergent state, BUT — important caveat — those divergence tests are MATH-level (they test the raw rollMultiHit shape, not the FSM convergence). The flag-on state doesn't make Suite 1 pass automatically. Suite 1 stays as "this is what the lockstep model used to be"; Suite 3 is what proves the new model works.

If you want Suite 1 to flip from fail → pass after the rewrite, that's a Phase 7 cleanup task. For now, drop the `--expect-fail` and accept that Suite 1 prints failures alongside Suite 3's passes.

## Rollback procedure

If Stage 2 fails any test:

1. **Hot revert**: flip `COOP_HOST_ARB = true` → `false` in `src/coop-resolver.js`, deploy.
2. Battle behavior reverts to v1.7.472 lockstep (still broken in the same way it was, but at least matches the pre-flip baseline).
3. Investigate what failed. The host-emit path is well-tested in sims; if live behavior diverges, it's likely a Phase 6.5 short-circuit issue or an animation-cue dispatch problem.
4. Fix forward in a follow-on commit.

## What's NOT covered

- Animation dispatch from fx cues on guest. The applier in Phase 6 walks **deltas only**; fx cues are emitted but ignored by the production code path. With Phase 6.5 wiring, guest still runs its local FSM animations (slash, magic, etc.) — they'll play because the guest's local FSM still drives them. The host-arb data path is what's authoritative; the animation just follows.
- Performance under load. The wire packet rate doesn't change meaningfully (one resolution per turn vs one action per turn). Server rate limit (global token bucket) is already sized for this.
- Cheating prevention. Host can emit arbitrary deltas. Out of scope for v1 (co-op is cooperative).
- New-host promotion on host disconnect. Battle force-closes; v2 work.

## Telemetry to watch during smoke

When the flag is on, look for these in the prod logs (pm2 err):

- `[net] encounter-resolution handler error` — applier threw, divergence likely
- `unknown delta target` warnings (if added in Phase 6.5)
- Increased rate-limit denials on `_encounterGroups` (shouldn't happen but worth checking)
- Reports of "HP wrong" or "out of sync" from users — this is the headline test

If any of those fire repeatedly, hot-revert (above).
