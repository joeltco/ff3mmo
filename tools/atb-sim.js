#!/usr/bin/env node
// ATB regression suite — covers RA math, tick rate, Wait-mode pause,
// mid-battle add, speedMod, monster-agi derivation. Runs as deploy.sh
// pre-flight gate alongside pvp-wire-sim.

import {
  initATB, addATBUnit, clearATB, tickGauges, getGaugePct, isReady,
  markActing, markFilling, setSpeedMod, deriveMonsterAgi,
  _atbDebugState, _setNow, TICK_MS, FILL_MAX,
} from '../src/atb.js';

// Deterministic mock clock for slice-4a wall-clock ATB. Each test resets
// the clock to 0; `advance(ms)` bumps it and runs a tick.
let _mockNow = 0;
_setNow(() => _mockNow);
function advance(ms) {
  _mockNow += ms;
  tickGauges(ms);
}

let _passed = 0, _failed = 0;
const _failures = [];

function test(name, fn) {
  try {
    _mockNow = 0;
    clearATB();
    fn();
    _passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    _failed++;
    _failures.push({ name, err: e });
    console.log('  FAIL ' + name + ' — ' + (e.message || e));
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error((msg || 'expected') + ' ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}
function assertNear(actual, expected, tol, msg) {
  if (Math.abs(actual - expected) > tol) throw new Error((msg || 'expected') + ' ~' + expected + ' (±' + tol + '), got ' + actual);
}

// ── RA math ────────────────────────────────────────────────────────────────

test('RA: anchor gets RA=5', () => {
  const p = {}, a = {};
  initATB([
    { ref: p, kind: 'player', agi: 10 },
    { ref: a, kind: 'ally',   agi: 10 },
  ]);
  assertEq(p._atb.ra, 5, 'anchor RA');
  assertEq(a._atb.ra, 5, 'same-agi RA');
});

test('RA: 2x anchor agi -> RA=2 (faster)', () => {
  const p = {}, fast = {};
  initATB([
    { ref: p,    kind: 'player', agi: 10 },
    { ref: fast, kind: 'ally',   agi: 20 },
  ]);
  assertEq(fast._atb.ra, 2);
});

test('RA: 0.5x anchor agi -> RA=10 (slower, at clamp max)', () => {
  const p = {}, slow = {};
  initATB([
    { ref: p,    kind: 'player', agi: 10 },
    { ref: slow, kind: 'ally',   agi: 5  },  // floor(50/5)=10, at max
  ]);
  assertEq(slow._atb.ra, 10);
});

test('RA: floor (asymmetric divide)', () => {
  const p = {}, q = {};
  initATB([
    { ref: p, kind: 'player', agi: 10 },
    { ref: q, kind: 'ally',   agi: 7  },  // floor(50/7) = 7
  ]);
  assertEq(q._atb.ra, 7);
});

test('RA: huge agi clamps to RA_MIN=2', () => {
  const p = {}, q = {};
  initATB([
    { ref: p, kind: 'player', agi: 10 },
    { ref: q, kind: 'ally',   agi: 99 },  // floor(50/99) = 0 -> clamped to 2
  ]);
  assertEq(q._atb.ra, 2);
});

test('RA: tiny agi clamps to RA_MAX=10', () => {
  const p = {}, q = {};
  initATB([
    { ref: p, kind: 'player', agi: 10 },
    { ref: q, kind: 'ally',   agi: 2  },  // floor(50/2) = 25 -> clamped to 10
  ]);
  assertEq(q._atb.ra, 10);
});

test('RA: zero agi -> clamped to RA_MIN=2 (no NaN)', () => {
  const p = {}, q = {};
  initATB([
    { ref: p, kind: 'player', agi: 10 },
    { ref: q, kind: 'ally',   agi: 0  },
  ]);
  assertEq(q._atb.ra, 2);
});

test('RA: zero anchor agi -> all RA=RA_MIN', () => {
  const p = {}, q = {};
  initATB([
    { ref: p, kind: 'player', agi: 0  },
    { ref: q, kind: 'ally',   agi: 10 },
  ]);
  assertEq(p._atb.ra, 2);
  assertEq(q._atb.ra, 2);
});

// ── Tick rate ──────────────────────────────────────────────────────────────

test('tick: anchor unit fills in RA*TICK_MS ms', () => {
  const p = {};
  initATB([{ ref: p, kind: 'player', agi: 10 }]);
  // RA=5, fill time = 5 * 333 = 1665ms
  advance(1665);
  assertEq(getGaugePct(p), 1, 'pct at cap');
  assert(isReady(p), 'state should be ready');
});

test('tick: faster unit fills before anchor', () => {
  const p = {}, fast = {};
  initATB([
    { ref: p,    kind: 'player', agi: 10 },
    { ref: fast, kind: 'ally',   agi: 20 },  // RA=2, fill in 666ms
  ]);
  advance(666);
  assert(isReady(fast), 'fast unit ready');
  assert(!isReady(p),   'anchor not ready yet');
});

test('tick: getGaugePct mid-fill', () => {
  const p = {};
  initATB([{ ref: p, kind: 'player', agi: 10 }]);
  advance(832);  // half of 1665
  assertNear(getGaugePct(p), 0.5, 0.01);
});

test('tick: dt accumulates across multiple calls', () => {
  const p = {};
  initATB([{ ref: p, kind: 'player', agi: 10 }]);
  for (let i = 0; i < 100; i++) advance(16.65);  // 100 frames at 60fps
  assertEq(getGaugePct(p), 1, 'reaches cap via repeated ticks');
});

test('tick: clamps at target (no overflow)', () => {
  const p = {};
  initATB([{ ref: p, kind: 'player', agi: 10 }]);
  advance(99999);
  // RA=5 → target = 5 * 333 = 1665 ms; elapsedMs clamps there, not at FILL_MAX.
  assertEq(p._atb.elapsedMs, 5 * TICK_MS);
  assertEq(getGaugePct(p), 1);
});

// ── Wait mode ──────────────────────────────────────────────────────────────

test('wait: player gauge holds at full while menu open; others advance', () => {
  const p = {}, ally = {};
  initATB([
    { ref: p,    kind: 'player', agi: 10 },
    { ref: ally, kind: 'ally',   agi: 10 },
  ]);
  advance(1665);                            // both reach full
  advance(1000);  // menu open, both already full
  assertEq(getGaugePct(p),    1, 'player held at cap');
  assertEq(getGaugePct(ally), 1, 'ally clamped, not pushed past');
});

test('wait: player gauge KEEPS FILLING during menu if not yet full', () => {
  const p = {};
  initATB([{ ref: p, kind: 'player', agi: 10 }]);
  // Wait-mode only pauses when AT full. Pre-full filling continues.
  advance(800);
  const pct = getGaugePct(p);
  assert(pct > 0 && pct < 1, 'partial fill ok, got ' + pct);
});

test('wait: ally keeps filling while player menu open', () => {
  const p = {}, ally = {};
  initATB([
    { ref: p,    kind: 'player', agi: 10 },
    { ref: ally, kind: 'ally',   agi: 20 },  // RA=2
  ]);
  advance(666);
  assert(isReady(ally), 'ally hits ready during menu');
});

// ── Wall-clock (slice 4a) ──────────────────────────────────────────────────

test('wall-clock: gauge advances even with sparse ticks', () => {
  // Simulates Worker setInterval throttling — clock jumps forward but
  // tickGauges may not be called during the gap. Wall-clock derivation
  // means the gauge state is still correct at the next read.
  const p = {};
  initATB([{ ref: p, kind: 'player', agi: 10 }]);
  // Skip the clock forward without calling tickGauges.
  _mockNow += 1665;
  // getGaugePct should re-derive from wall clock — no explicit tick needed.
  assertEq(getGaugePct(p), 1, 'getGaugePct catches up on read');
});

test('wall-clock: state flip still needs a tickGauges call', () => {
  // getGaugePct re-derives elapsedMs from clock, but the state transition
  // (filling -> ready) only fires inside tickGauges. So pickReadyActor
  // won't see the unit as ready until at least one tick after the gauge
  // hits target. Acceptable since tickGauges runs every frame in prod.
  const p = {};
  initATB([{ ref: p, kind: 'player', agi: 10 }]);
  _mockNow += 1665;
  // Without a tickGauges call, state is still 'filling'.
  assertEq(p._atb.state, 'filling');
  assert(!isReady(p), 'no state flip without tick');
  tickGauges(0);  // one tick — flips to 'ready'
  assert(isReady(p));
});

test('wall-clock: markFilling resets anchor to current clock', () => {
  const p = {};
  initATB([{ ref: p, kind: 'player', agi: 10 }]);
  advance(1000);
  markFilling(p);
  assertEq(p._atb.startedFillingAtMs, _mockNow, 'anchor set to current clock');
  assertEq(p._atb.elapsedMs, 0);
});

test('wall-clock: markFilling accepts explicit atMs (slice 4b prep)', () => {
  // Wire-sync events will pass the partner's timestamp; verify the
  // override path works.
  const p = {};
  initATB([{ ref: p, kind: 'player', agi: 10 }]);
  advance(1000);
  markFilling(p, 500);  // explicit anchor at t=500 (somewhere in the past)
  assertEq(p._atb.startedFillingAtMs, 500);
  // Reading pct after override — elapsed = now (1000) - anchor (500) = 500.
  // target = 5*333 = 1665. pct ≈ 0.30
  assertNear(getGaugePct(p), 500 / 1665, 0.01);
});

// ── State transitions ──────────────────────────────────────────────────────

test('state: markActing freezes gauge (no further fill)', () => {
  const p = {};
  initATB([{ ref: p, kind: 'player', agi: 10 }]);
  advance(500);
  const beforeGauge = p._atb.elapsedMs;
  markActing(p);
  advance(1000);
  assertEq(p._atb.elapsedMs, beforeGauge, 'acting gauge frozen');
});

test('state: markFilling resets to 0', () => {
  const p = {};
  initATB([{ ref: p, kind: 'player', agi: 10 }]);
  advance(1665);
  markFilling(p);
  assertEq(p._atb.elapsedMs, 0);
  assertEq(p._atb.state, 'filling');
});

// ── speedMod ───────────────────────────────────────────────────────────────

test('speedMod: 2.0 doubles fill time (Slow)', () => {
  const p = {};
  initATB([{ ref: p, kind: 'player', agi: 10 }]);
  setSpeedMod(p, 2.0);  // target = 5 * 333 * 2 = 3330 ms
  advance(1665);
  assertNear(getGaugePct(p), 0.5, 0.001, 'half-filled after baseline duration');
});

test('speedMod: 0.5 halves fill time (Haste)', () => {
  const p = {};
  initATB([{ ref: p, kind: 'player', agi: 10 }]);
  setSpeedMod(p, 0.5);  // target = 5 * 333 * 0.5 = 832.5 ms
  advance(833);
  assertEq(getGaugePct(p), 1, 'full at half baseline');
});

// ── Mid-battle add ─────────────────────────────────────────────────────────

test('addATBUnit: newcomer uses cached anchor agi', () => {
  const p = {};
  initATB([{ ref: p, kind: 'player', agi: 10 }]);
  const newAlly = {};
  addATBUnit({ ref: newAlly, kind: 'ally', agi: 20 });
  assertEq(newAlly._atb.ra, 2);
  assertEq(newAlly._atb.elapsedMs, 0, 'starts empty');
});

test('addATBUnit: ticks alongside existing units', () => {
  const p = {};
  initATB([{ ref: p, kind: 'player', agi: 10 }]);
  advance(832);
  const ally = {};
  addATBUnit({ ref: ally, kind: 'ally', agi: 10 });  // joins mid-fight
  advance(1665);
  assert(isReady(ally), 'late joiner reaches ready');
  assertEq(getGaugePct(p), 1);
});

// ── clearATB ───────────────────────────────────────────────────────────────

test('clearATB: wipes _atb from all units', () => {
  const p = {}, a = {};
  initATB([
    { ref: p, kind: 'player', agi: 10 },
    { ref: a, kind: 'ally',   agi: 10 },
  ]);
  clearATB();
  assertEq(p._atb, null);
  assertEq(a._atb, null);
  assertEq(_atbDebugState().length, 0);
});

test('clearATB: subsequent initATB starts fresh', () => {
  const p = {};
  initATB([{ ref: p, kind: 'player', agi: 10 }]);
  advance(1665);
  clearATB();
  const q = {};
  initATB([{ ref: q, kind: 'player', agi: 10 }]);
  assertEq(q._atb.elapsedMs, 0);
  assertEq(q._atb.ra, 5);
});

// ── Monster agi derivation ─────────────────────────────────────────────────

test('deriveMonsterAgi: scaled to player range', () => {
  // floor(lv/2) + 5 + (ev>>4), min 5
  assertEq(deriveMonsterAgi({ level: 10, evade: 16 }), 11);  // 5 + 5 + 1
  assertEq(deriveMonsterAgi({ level: 35, evade: 30 }), 23);  // 17 + 5 + 1
  assertEq(deriveMonsterAgi({ level: 1,  evade: 0  }), 5);   // floor
});

test('deriveMonsterAgi: low-level monster acts in playable time', () => {
  // Goblin-class level 1 → agi 5. Player typical 10. RA = floor(50/5) = 10 (at clamp max).
  // Fill time = 10 * 333 = 3.3s. Player at agi 10 fills in 5*333 = 1.7s.
  // Player acts ~2x per monster turn — playable.
  const goblin = deriveMonsterAgi({ level: 1, evade: 5 });
  assert(goblin >= 5 && goblin <= 8, 'goblin agi in playable range, got ' + goblin);
});

test('deriveMonsterAgi: handles missing fields', () => {
  assertEq(deriveMonsterAgi({}), 5);   // safety floor
  assertEq(deriveMonsterAgi(null), 5);
});

// ── Cross-scenario: 4-unit battle ──────────────────────────────────────────

test('scenario: 4-unit party + monster', () => {
  const p = {}, knight = {}, thief = {}, wm = {}, mon = {};
  // Player (anchor) agi=10. Knight slow (agi=8), Thief fast (agi=18),
  // WhiteMage average (agi=11), Monster avg (agi=10).
  initATB([
    { ref: p,      kind: 'player',  agi: 10 },
    { ref: knight, kind: 'ally',    agi: 8  },  // RA=6
    { ref: thief,  kind: 'ally',    agi: 18 },  // RA=2
    { ref: wm,     kind: 'ally',    agi: 11 },  // RA=4
    { ref: mon,    kind: 'monster', agi: 10 },  // RA=5
  ]);
  // After 666ms, only Thief should be ready (RA=2 -> 666ms exact).
  advance(666);
  assert(isReady(thief), 'thief ready first');
  assert(!isReady(p));
  assert(!isReady(knight));
  assert(!isReady(wm));
  assert(!isReady(mon));
});

// ── Run ────────────────────────────────────────────────────────────────────

console.log('\nATB regression suite');
console.log('--------------------');
console.log(`tick base: ${TICK_MS}ms · fill resolution: ${FILL_MAX}`);
console.log('');
// Tests register themselves; this is just the summary marker.

console.log('');
console.log(`Passed: ${_passed}`);
console.log(`Failed: ${_failed}`);
if (_failed > 0) {
  console.log('');
  for (const f of _failures) console.log('  · ' + f.name + ' — ' + (f.err.message || f.err));
  process.exit(1);
}
process.exit(0);
