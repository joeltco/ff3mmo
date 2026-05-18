# coop-arbiter-sim — co-op battle convergence regression harness

**Status:** Phases 0-8 SHIPPED. 59 tests passing + 5 expected divergence (the Suite 1 baselines stay failing-by-design as historical reference for the lockstep failure modes). Runs in `deploy.sh` via `--expect-fail` until live flag flip; that flag drops post-cutover.
**Spec for:** `tools/coop-arbiter-sim.js`
**Runs in:** `deploy.sh` (pre-flight gate, alongside `pvp-wire-sim.js` and `coop-wire-sim.js`)
**See also:** [`docs/COOP-REWRITE-PLAN.md`](../docs/COOP-REWRITE-PLAN.md), [`docs/COOP-PHASE-6-SMOKE.md`](../docs/COOP-PHASE-6-SMOKE.md)

## Why this harness exists

Co-op party-encounter battles desync between phones starting at round 1 (v1.7.472 + earlier). `pvp-wire-sim` and `coop-wire-sim` only assert *wire-payload delivery* — they don't run the battle FSM on two simulated clients and compare state. That gap is exactly why fifteen patch attempts (v1.7.458 → v1.7.472) all shipped green-on-sims and broken-in-prod.

This harness closes that gap:

1. **Divergence-detection suite** — directly exercises the math primitives the host's FSM and the guest's FSM each call for the same logical event. Documents the specific divergence sources from the audit (`docs/COOP-REWRITE-PLAN.md#why-were-rewriting`). On v1.7.472 these tests **fail by design** — that's the baseline. After Phase 2-4 of the rewrite they pass.
2. **Wire-contract suite** — validates the new `encounter-resolution` packet shape against a reference schema. Empty placeholder in Phase 0; filled by Phase 1.
3. **Convergence harness** — `runScenario(...)` skeleton that drives turns through real production modules, snapshots state per phone, and asserts equality. Phase 0 ships with a trivial scenario (zero-turn baseline match). Phase 2+ extends with physical, magic, status, multi-target, KO scenarios.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ coop-arbiter-sim.js                                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Suite 1 — DIVERGENCE                                           │
│  ├─ Asserts the audit-flagged divergence sources fire           │
│  ├─ Calls battle-math.js / combatant-cast.js / status-effects   │
│  │  with the asymmetric inputs each path uses                   │
│  └─ Expected: fails on v1.7.472, passes after Phases 2-4        │
│                                                                 │
│  Suite 2 — WIRE CONTRACT                                        │
│  ├─ Validates `encounter-resolution`, `encounter-snapshot`      │
│  │  packet shapes round-trip cleanly                            │
│  └─ Empty in Phase 0; lands content in Phase 1                  │
│                                                                 │
│  Suite 3 — CONVERGENCE                                          │
│  ├─ `Phone` context: snapshot of singleton state                │
│  ├─ `runScenario(actions, opts)` drives N turns                 │
│  ├─ `assertConvergence(a, b)` compares HP/status/queue          │
│  └─ Phase 0: zero-turn baseline. Phase 2+: real scenarios.      │
└─────────────────────────────────────────────────────────────────┘
```

## CLI

```
node tools/coop-arbiter-sim.js                       # run everything
node tools/coop-arbiter-sim.js --suite=divergence    # one suite
node tools/coop-arbiter-sim.js --filter="monster"    # substring match
node tools/coop-arbiter-sim.js --expect-fail         # invert exit code (for Phase 0 baseline)
```

`--expect-fail` is the Phase 0 deploy.sh contract: on v1.7.472 we *expect* divergence tests to fail, so the gate should treat that as the green state. Once Phase 2-4 land, deploy.sh drops the flag and the harness becomes a normal must-pass gate.

## State-isolation strategy

The production code's `battleSt`, `ps`, `inputSt`, etc. are module-level singletons. Two-phone simulation needs to keep distinct state per phone without forking the engine.

Strategy: **swap-in-singleton**.

```js
class Phone {
  constructor(role) {              // 'host' | 'guest'
    this.role = role;
    this.battleStSnapshot = null;
    this.psSnapshot = null;
    this.rngSeed = 0;
    this.rngCallsSinceSeed = 0;
  }

  swapIn() {
    Object.assign(battleSt, this.battleStSnapshot);
    Object.assign(ps,        this.psSnapshot);
    seedRng(this.rngSeed);
    for (let i = 0; i < this.rngCallsSinceSeed; i++) rand();  // restore cursor
  }

  swapOut() {
    this.battleStSnapshot = structuredClone(battleSt);
    this.psSnapshot       = structuredClone(ps);
    // rngCallsSinceSeed bookkeeping tracked via wrapped rand() in scenarios
  }
}
```

The wrapped-rand bookkeeping is a hack but unavoidable without exposing `_state` from `rng.js`. Phase 1 can add a `_testHooks.getRngState()` export to `rng.js` to clean this up.

## Suite 1 detail — divergence tests

Each test names the audit finding it documents, runs the asymmetric math, asserts the divergence visibly. Expected outcomes on v1.7.472:

| Test | Code path | Expected on v1.7.472 | Expected after Phase 2-4 |
|---|---|---|---|
| `monster attack: ps-path vs ally-path damage parity` | `battle-enemy.js:228-273` | FAIL (different damage) | PASS (host computes once, guest applies) |
| `elemResist asymmetry: ps has resist, ally has null` | `battle-enemy.js:219` | FAIL (host halves, guest doesn't) | PASS |
| `statusAtk inflict: ps-path runs, ally-path skips` | `battle-enemy.js:263-266` | FAIL (host inflicts, guest doesn't) | PASS |
| `protect halving: ps-path applies, ally-path skips` | `battle-enemy.js:255-256` | FAIL (host halves, guest doesn't) | PASS |
| `host self stats: recalcStats vs generateAllyStats` | `player-stats.js` vs `data/players.js:298` | FAIL (gear bonus diff) | PASS (snapshot ships realized stats) |
| `per-turn reseed double-bump on ps-dead branch` | `battle-turn.js:165-172` | FAIL (counter diverges) | PASS (perTurnIndex retired) |

Each failure prints the asymmetry (e.g., "host damage 12, guest damage 8 — divergence 4 HP").

## Suite 3 detail — convergence harness

```js
async function runScenario(name, opts = {}) {
  const host  = new Phone('host');
  const guest = new Phone('guest');
  
  initEncounter(host, guest, opts);   // seeds both phones identically
  
  for (const action of opts.actions) {
    host.swapIn();
    drive(action);                    // wraps existing FSM tick
    host.swapOut();
    
    guest.swapIn();
    drive(action);
    guest.swapOut();
  }
  
  assertConvergence(host, guest);
}
```

Phase 0 ships:

- `runScenario('zero-turn baseline', { actions: [] })` — both phones identical after init.

Phase 2 adds:

- `runScenario('5 rounds physical')` — host + guest attack monster, monster attacks back.
- `runScenario('10 rounds physical')` — same, longer.

Phase 3 adds:

- `runScenario('Fire on monster')`
- `runScenario('Cure on ally')`
- `runScenario('multi-target Curaga')`

Phase 4 adds:

- `runScenario('end-of-round poison tick')`
- `runScenario('KO event')`
- `runScenario('item use — cure potion')`

Phase 5 adds:

- `runScenario('assist join mid-battle')`

## Wire-contract suite (Suite 2)

Phase 0: stub with one test asserting the wire-resolution schema exists once defined. Phase 1 fills in:

- `encounter-resolution` round-trip: build packet → serialize → parse → verify shape.
- `encounter-snapshot` round-trip: same.
- Backwards-compat: stripped-down `encounter-action` still parses on host.

## Exit-code contract

| Outcome | Exit code | Phase 0 (with `--expect-fail`) |
|---|---|---|
| All tests pass | 0 | 1 |
| Some divergence tests fail | 1 | 0 |
| Any wire-contract or convergence test fails | 1 | 1 |
| Harness crash / import error | 2 | 2 |

`deploy.sh` gates with `--expect-fail` for Phase 0 → drops the flag after Phase 4.

## File layout

```
tools/
├── coop-arbiter-sim.js          (the harness)
├── coop-arbiter-sim.PLAN.md     (this file)
└── coop-wire-sim.js             (existing v1.7.465 wire-delivery harness — unchanged)
```

## Non-goals

- Full FSM lockstep simulation (deferred to Phase 2+ scenarios).
- Cross-machine WebSocket testing (covered by `pvp-wire-sim` E2E + future Phase 6 live smoke).
- Performance benchmarking (out of scope; this is a correctness gate).
- Boss / PvP / solo coverage (other harnesses own those domains).

## Extension guide for Phase 2+ contributors

When adding a new scenario:

1. Add a `runScenario('name', { actions: [...] })` call in Suite 3.
2. Implement any new helpers needed (e.g., `magicAction(spellId, target)`).
3. Run `node tools/coop-arbiter-sim.js --filter="name"` to iterate.
4. Once green, drop into the main run.
5. Update the per-phase coverage row in `docs/COOP-REWRITE-PLAN.md`.

When the rewrite is done:

1. Remove `--expect-fail` from `deploy.sh`.
2. Drop the Suite 1 "expected to fail" expectations — those tests should now pass.
3. Suite 1 stays as regression coverage against accidental re-introduction of the divergence.
