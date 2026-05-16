# `tools/pvp-wire-sim.js` — Plan

Terminal-runnable multiplayer regression harness. Companion to
`tools/battle-sim.js` — that one covers local combat math; this one covers
the **wire layer** (`ws-presence.js` + the cross-client lockstep that we
audited in v1.7.387-v1.7.390).

**Why it exists:** the audit findings (defendHalve desync, status RNG fork,
wire actor drop, ally-join silent no-op) all survived
`tools/battle-sim.js` because that sim runs one engine in one process. A
two-client wire test would have caught them earlier.

## Constraints

- **Node-only**, like `battle-sim.js`. No DOM, no canvas.
- **No engine instantiation in two contexts.** The engine has module-level
  singletons (`battleSt`, `pvpSt`, `ui`). Running two copies needs worker
  threads or vm contexts — too much scaffolding for v1.
- **Test the contracts, not the full FSM.** Three layers of coverage:
  1. **Math lockstep** — re-seed `rng.js` between simulated client A's
     call and client B's call; assert same input → same output. Catches
     #1, #2, #3, #4.
  2. **Server unit** — import internal helpers from `ws-presence.js` via
     a `_testHooks` export; assert clamps, formulas, membership lookups.
     Catches #6, #7, #8 (logic), #22 (logic).
  3. **End-to-end wire** — spin up `attachWebSocketPresence` against a
     localhost HTTP server, connect two mock JWT-authed clients, drive
     scripted scenarios, assert relay output. Catches #10, #11, #14, #18,
     #24, hidden actor-relay bug.

## Out of scope (defer to v2)

- Receiver-side `_applyWireOpponentAction` runs against the real
  `battleSt`/`pvpSt` — needs DOM stubs (#15 #17 #23 #32).
- Visual / SFX correctness.
- Tests that require two full engines stepping in lockstep over
  multiple rounds.

## Exit code

- `0` — all assertions passed.
- `1` — at least one failed; print the offending test name + expected vs
  actual.

## Hook strategy

Add this near the bottom of `ws-presence.js`:

```js
// Test-only — `tools/pvp-wire-sim.js` imports this to exercise the
// internal helpers without re-implementing them.
export const _testHooks = {
  normalizeProfileField: _normalizeProfileField,
  pvpHookChance: _pvpHookChance,
  inSameParty: _inSameParty,
  rateAllow: _rateAllow,
  partyMemberships: _partyMemberships,
  pvpSearches: _pvpSearches,
  pvpPartners: _pvpPartners,
  resetState: () => {
    _connected.clear();
    _pvpSearches.clear();
    _pvpPartners.clear();
    _partyInvites.clear();
    _partyMemberships.clear();
  },
};
```

Keeps the production surface unchanged; test surface gets one explicit
export.
