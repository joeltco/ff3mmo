# Phase 6 — Two-Phone Live Smoke Checklist

**Status:** ready to test once the flag flips.
**Authored:** 2026-05-18, after Phase 6 host-emit wiring shipped.
**Owner:** user — Claude cannot run this; it needs two real devices on the wire.

## Prerequisites

1. Two phones (or two browser tabs at different `userId`s — but the live wire path won't match prod cellular latency, so prefer phones).
2. Both logged in with different accounts in the same party.
3. Both on the most recent prod deploy.

## What's wired (Phase 6 commit)

Host emits a host-arb resolution packet at every co-op-relevant mutation point. **Flag is still `false`** so:

- With flag off (current default): packets are **not** emitted. Production runs the legacy lockstep path exactly as today.
- With flag on: host emits + guests apply. Legacy path is now redundant but not yet short-circuited (Phase 6.5 work).

### Host-emit call sites wired

| File | Site | Resolution kind | Status |
|---|---|---|---|
| `src/battle-enemy.js` | `_processEnemyTurn` — both `ps` and `ally` target paths | `monster-attack` | ✓ wired |
| `src/battle-update.js` | `_finalizeComboHits` | `attack` (player → monster) | ✓ wired |
| `src/battle-ally.js` | `_finalizeAllyCombo` | `attack` (ally → monster) | ✓ wired |
| `src/encounter-wire.js` | `endWireEncounter` | `encounter-end` | ✓ wired |
| `src/battle-encounter.js` | `_processAssistIncoming` | `encounter-snapshot` (new shape, ships alongside legacy) | ✓ wired |

### Not yet wired (Phase 6.5)

| File | Site | Resolution kind | Reason deferred |
|---|---|---|---|
| `src/spell-cast.js` | impact-apply (`applySpell` and friends) | `magic` | Multi-target rollup logic + accumulating TargetResults at each impact phase needs careful state capture. Phase 6.5. |
| `src/battle-ally.js` | `_applyAllyMagicEffect` | `magic` (ally cast) | Same as above. |
| `src/battle-turn.js` | `_playerTurnConsumable` | `item` | Multi-target items (Hi-Potion + variants); deferred to Phase 6.5. |
| `src/battle-turn.js` | `_applyEndOfRoundPoison` | `poison-tick` | Batch packet across actors; straightforward but not in Phase 6 scope. |

**Guest-side short-circuits** (where flag-on guest skips legacy combat math and waits for resolution) are deferred to Phase 6.5. With Phase 6's wiring alone, flipping the flag causes guests to apply incoming deltas AND continue running their legacy lockstep apply — double-application, broken state. **DO NOT FLIP THE FLAG YET.** Phase 6.5 will land the short-circuits, then the flip becomes safe.

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
