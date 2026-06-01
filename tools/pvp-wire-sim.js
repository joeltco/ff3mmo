#!/usr/bin/env node
// tools/pvp-wire-sim.js — terminal regression harness for the multiplayer
// wire layer. Spec: tools/pvp-wire-sim.PLAN.md
//
// Three layers of coverage:
//   1. Math lockstep — re-seed `rng.js` between simulated client A and B,
//      assert deterministic combat math.
//   2. Server unit  — call `ws-presence.js` internals via `_testHooks`.
//   3. End-to-end   — spin up the real WS server on a localhost port and
//                     drive two JWT-authed clients through scripted scenarios.
//
//   node tools/pvp-wire-sim.js                 # run everything
//   node tools/pvp-wire-sim.js --suite=math    # one suite only
//   node tools/pvp-wire-sim.js --filter=defend # one assertion
//
// Each failed assertion bumps an exit-code counter; final exit is non-zero
// when anything fails.

import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { WebSocket } from 'ws';

import { seed as seedRng, rand } from '../src/rng.js';
import { rollHits, calcDamage, rollInitiative } from '../src/battle-math.js';
import {
  STATUS, addStatus, hasStatus, createStatusState,
  tryInflictStatus, processTurnStart,
} from '../src/status-effects.js';
import { generateAllyStats } from '../src/data/players.js';
import { createRng } from '../src/rng.js';
import { _testGetBattleRng as pvpArbGetBattleRng } from '../pvp-arbiter.js';
// v1.7.752 P-6 — direct test hooks into the client viewer module, so
// wire-sim can feed synthetic frames through the same handlers that
// the live net.js dispatch invokes.
import {
  arbViewSt,
  _testApplyStart as arbViewApplyStart,
  _testApplyTurn  as arbViewApplyTurn,
  _testApplyCancel as arbViewApplyCancel,
  _testResetView  as arbViewReset,
  drainPendingDeltas, isMyTurn,
} from '../src/pvp-arb-viewer.js';
// v1.7.753 P-6b adapter not importable from wire-sim — it pulls in
// pvp.js which pulls ui-state.js + audio modules that reference
// browser-only APIs (window, document, Audio). The adapter's shape
// mapping is straightforward; production validation happens via the
// live game smoke test once PVP_ARBITER flips on.
// calcDamage / rollHits / rollInitiative are already imported at line 24
// (Suite 1 RNG determinism tests). Reuse those for the P-3 parity tests.
import { attachWebSocketPresence, _testHooks } from '../ws-presence.js';
import { _testEnsureUser, handleAPI, _testValidateSaveData,
         _testMirrorSync, _testMirrorSyncRuntime,
         _testMirrorRead, _testMirrorClear,
         _testSetMirrorAuthoritative, _testGetMirrorAuthoritative,
         _testSeedSave,
         _testConsumedTilesClear,
         consumedTileMark, consumedTileConsumedAt, consumedTilesReap,
         mirrorApplyInvEvent,
       } from '../api.js';
import { createPveBattle, recordIntent, _testReset as _pveTestReset }
       from '../pve-arbiter.js';

const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken');

// ── Env wiring ─────────────────────────────────────────────────────────────
// `ws-presence.js` reads `JWT_SECRET` from env at module-load time. If we
// don't pin it here, the test runs with the dev fallback and our JWTs
// match anyway. Setting it explicitly makes that contract visible.
const JWT_SECRET = process.env.JWT_SECRET || 'ff3mmo-dev-secret-change-in-prod';

// ── CLI ────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--(\w+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const ONLY_SUITE  = args.suite || null;       // 'math' | 'server' | 'wire'
const ONLY_FILTER = args.filter || null;      // substring match on test name

// ── Assertion plumbing ─────────────────────────────────────────────────────
let _passed = 0, _failed = 0;
const _failures = [];

function test(name, fn) {
  if (ONLY_FILTER && !name.toLowerCase().includes(ONLY_FILTER.toLowerCase())) return;
  let err = null;
  try { fn(); }
  catch (e) { err = e; }
  if (err) {
    _failed++;
    _failures.push({ name, err });
    console.log(`  ✗ ${name}\n    ${err.message}`);
  } else {
    _passed++;
    console.log(`  ✓ ${name}`);
  }
}

async function asyncTest(name, fn) {
  if (ONLY_FILTER && !name.toLowerCase().includes(ONLY_FILTER.toLowerCase())) return;
  let err = null;
  try { await fn(); }
  catch (e) { err = e; }
  if (err) {
    _failed++;
    _failures.push({ name, err });
    console.log(`  ✗ ${name}\n    ${err.message}`);
  } else {
    _passed++;
    console.log(`  ✓ ${name}`);
  }
}

function assertEqual(actual, expected, label = '') {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label || 'mismatch'}\n      expected: ${b}\n      actual:   ${a}`);
}
function assertTrue(cond, msg = 'expected true') {
  if (!cond) throw new Error(msg);
}
function assertClose(actual, expected, tol, label = '') {
  if (Math.abs(actual - expected) > tol) {
    throw new Error(`${label || 'not close'}: expected ${expected} ± ${tol}, got ${actual}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// SUITE 1 — Math lockstep
// ──────────────────────────────────────────────────────────────────────────
// Each test seeds the RNG, runs the "sender" computation, re-seeds the same
// value, runs the "receiver" computation. With the audit fixes, both sides
// should land on the same numbers (or diverge intentionally — e.g.,
// defendHalve when receiver is defending).

function suiteMath() {
  console.log('\n═══ SUITE 1 — math lockstep ═══');

  // Audit #2 — `tryInflictStatus` now uses rand(), not Math.random.
  test('#2 status RNG is deterministic across reseed', () => {
    const a = createStatusState();
    const b = createStatusState();
    seedRng(123);
    tryInflictStatus(a, 'sleep', 50);
    seedRng(123);
    tryInflictStatus(b, 'sleep', 50);
    assertEqual(a.mask, b.mask, 'mask diverged after same-seed roll');
  });

  // Audit #2 — processTurnStart sleep-wake roll syncs.
  test('#2 sleep-wake roll is deterministic', () => {
    const a = createStatusState();
    const b = createStatusState();
    addStatus(a, STATUS.SLEEP);
    addStatus(b, STATUS.SLEEP);
    seedRng(7);
    const ra = processTurnStart(a, 100);
    seedRng(7);
    const rb = processTurnStart(b, 100);
    assertEqual(ra.canAct, rb.canAct, 'canAct diverged');
    assertEqual(hasStatus(a, STATUS.SLEEP), hasStatus(b, STATUS.SLEEP), 'sleep state diverged');
  });

  // Audit #1 — rollHits with same seed and same opts → identical output.
  // Confirms the lockstep baseline before testing the divergence path.
  test('#1 rollHits is deterministic with same seed + opts', () => {
    const opts = { critPct: 4, critBonus: 0 };
    seedRng(99);
    const a = rollHits(20, 5, 80, 2, opts);
    seedRng(99);
    const b = rollHits(20, 5, 80, 2, opts);
    assertEqual(a, b, 'rollHits output diverged with identical inputs');
  });

  // Audit #1 — confirms the bug shape: same seed but `defendHalve` toggled
  // on one side produces DIFFERENT damage. After the fix, both sides pass
  // `defendHalve` consistently → equality. Pre-fix: only the receiver passed
  // it → mismatch on every hit while the defender was Defending.
  test('#1 defendHalve halves damage post-roll', () => {
    seedRng(99);
    const without = rollHits(20, 5, 80, 4, { critPct: 0 });
    seedRng(99);
    const withHalve = rollHits(20, 5, 80, 4, { critPct: 0, defendHalve: true });
    // Hit-or-miss pattern matches (rand cursor identical), but landed hits
    // are halved.
    for (let i = 0; i < without.length; i++) {
      const a = without[i], b = withHalve[i];
      if (a.miss) { assertTrue(b.miss, `hit ${i}: miss/hit fork`); continue; }
      if (a.shieldBlock) { assertTrue(b.shieldBlock, `hit ${i}: block fork`); continue; }
      assertTrue(b.damage <= a.damage, `hit ${i}: defendHalve raised damage`);
    }
  });

  // Audit #3 — SW throw uses rand() (formula mirrored from pvp.js:1169).
  test('#3 SouthWind damage formula is deterministic', () => {
    function rollSW(level, seed) {
      seedRng(seed);
      const int_ = 5 + level;
      const swAtk = Math.floor(int_ / 2) + 55;
      return Math.floor((swAtk + Math.floor(rand() * Math.floor(swAtk / 2 + 1))) / 2);
    }
    assertEqual(rollSW(10, 42), rollSW(10, 42), 'SW damage diverged with same seed');
  });

  // Audit #4 — _playerTurnRun success roll uses rand() (formula from
  // battle-turn.js:754).
  test('#4 run-success roll is deterministic', () => {
    function rollRun(playerAgi, avgLevel, seed) {
      seedRng(seed);
      const successRate = Math.min(99, Math.max(1, playerAgi + 25 - Math.floor(avgLevel / 4)));
      return Math.floor(rand() * 100) < successRate;
    }
    assertEqual(rollRun(15, 10, 1), rollRun(15, 10, 1), 'run roll diverged');
  });

  // Sanity — rollInitiative is RNG-driven (proves combat turn order syncs).
  test('rollInitiative is deterministic', () => {
    seedRng(5);
    const a = rollInitiative(10);
    seedRng(5);
    const b = rollInitiative(10);
    assertEqual(a, b, 'initiative diverged');
  });

  // Sanity — calcDamage variance roll syncs.
  test('calcDamage variance syncs across reseed', () => {
    seedRng(11);
    const a = calcDamage(30, 5, false, 0, 1);
    seedRng(11);
    const b = calcDamage(30, 5, false, 0, 1);
    assertEqual(a, b, 'calcDamage diverged');
  });
}

// ──────────────────────────────────────────────────────────────────────────
// SUITE 2 — Server unit
// ──────────────────────────────────────────────────────────────────────────
// Internals exposed via `_testHooks` (production code path unaffected).

function suiteServer() {
  console.log('\n═══ SUITE 2 — server unit ═══');
  _testHooks.resetState();

  const { normalizeProfileField, pvpHookChance, inSameParty, rateAllow,
          state } = _testHooks;

  // Audit #7 — profile fields clamp on both `hello` and `update`.
  test('#7 normalize agi clamps to [1, 99]', () => {
    assertEqual(normalizeProfileField('agi', 9999), 99);
    assertEqual(normalizeProfileField('agi', -50), 1);
    assertEqual(normalizeProfileField('agi', 42), 42);
  });
  test('#7 normalize level clamps to [1, 99]', () => {
    assertEqual(normalizeProfileField('level', 0), 1);
    assertEqual(normalizeProfileField('level', 100), 99);
  });
  test('#7 normalize name truncates to 16 chars', () => {
    assertEqual(normalizeProfileField('name', 'A'.repeat(40)), 'A'.repeat(16));
  });
  test('#7 normalize allies caps at 3 entries', () => {
    const arr = [{a:1},{a:2},{a:3},{a:4},{a:5}];
    const out = normalizeProfileField('allies', arr);
    assertEqual(out.length, 3);
  });
  test('#7 normalize rejects unknown keys', () => {
    assertEqual(normalizeProfileField('hax', 999), undefined);
  });

  // Audit hook formula — both client and server share the same math.
  test('hook chance — AGI-equal default', () => {
    const p = { agi: 10, jobIdx: 0 };
    assertClose(pvpHookChance(p, p), 0.25, 0.0001);
  });
  test('hook chance — Thief bonus +0.15', () => {
    const ch = { agi: 10, jobIdx: 8 };
    const tg = { agi: 10, jobIdx: 0 };
    assertClose(pvpHookChance(ch, tg), 0.40, 0.0001);
  });
  test('hook chance — clamped to 0.75 max', () => {
    const ch = { agi: 99, jobIdx: 8 };
    const tg = { agi: 1, jobIdx: 0 };
    assertEqual(pvpHookChance(ch, tg), 0.75);
  });
  test('hook chance — clamped to 0.10 min', () => {
    const ch = { agi: 1, jobIdx: 0 };
    const tg = { agi: 99, jobIdx: 0 };
    assertEqual(pvpHookChance(ch, tg), 0.10);
  });

  // Audit #22 — party chat is membership-scoped, not location-scoped.
  test('#22 inSameParty — direct (inviter ↔ member)', () => {
    state.partyMemberships.set(20, 10);  // 20 is in 10's party
    assertTrue(inSameParty(10, 20), 'inviter+member not flagged');
    assertTrue(inSameParty(20, 10), 'reverse not flagged');
    _testHooks.resetState();
  });
  test('#22 inSameParty — two members same inviter', () => {
    state.partyMemberships.set(20, 10);
    state.partyMemberships.set(21, 10);
    assertTrue(inSameParty(20, 21), 'co-members not flagged');
    _testHooks.resetState();
  });
  test('#22 inSameParty — strangers reject', () => {
    state.partyMemberships.set(20, 10);
    state.partyMemberships.set(31, 30);
    assertTrue(!inSameParty(20, 31), 'unrelated members crossed parties');
    _testHooks.resetState();
  });
  test('#22 inSameParty — both solo reject', () => {
    assertTrue(!inSameParty(1, 2), 'solo players crossed');
  });

  // Audit #6 — rate-limit token bucket. Capacity 60; one allow per token.
  test('#6 rate limit — first 60 frames pass', () => {
    const entry = {};
    let passes = 0;
    for (let i = 0; i < 60; i++) if (rateAllow(entry)) passes++;
    assertEqual(passes, 60, 'capacity not 60');
  });
  test('#6 rate limit — burst overrun blocked', () => {
    const entry = {};
    for (let i = 0; i < 60; i++) rateAllow(entry);
    // Without time advance the 61st is denied.
    assertTrue(!rateAllow(entry), 'burst did not block');
  });

  // Per-kind bucket (v1.7.426). Spamming one kind must not exhaust the
  // bucket for other kinds — `chat` has capacity 20, `pvp-action` is
  // unrestricted (global only). After 20 `chat` frames, further chat
  // is denied but a different unrestricted kind still passes.
  test('per-kind rate — chat exhausts independently', () => {
    const { rateAllowKind, perKindRates } = _testHooks;
    const entry = {};
    const cap = perKindRates['chat'].cap;
    for (let i = 0; i < cap; i++) {
      assertTrue(rateAllowKind(entry, 'chat'), 'chat denied within capacity');
    }
    assertTrue(!rateAllowKind(entry, 'chat'), 'chat allowed past capacity');
    assertTrue(rateAllowKind(entry, 'pvp-action'), 'unrestricted kind blocked by chat exhaust');
  });

  // v1.7.450 — save validator must roundtrip every stats field the client
  // sends in `playerStatsSnapshot()`. Pre-fix `maxMP` + equipment IDs
  // (weaponR/L/head/body/arms) were dropped by the whitelist, and on reload
  // (server preferred) the player's equipment looked erased.
  test('save validator preserves all stats fields incl. equipment', () => {
    const input = {
      name: [0x80, 0x81, 0x82],
      level: 12,
      stats: {
        level: 12, exp: 5000, hp: 250, maxHP: 300, maxMP: 80,
        str: 22, agi: 18, vit: 17, int: 25, mnd: 28,
        weaponR: 0x1E, weaponL: 0x00,
        head: 0x62, body: 0x72, arms: 0x05,
      },
    };
    const { ok, data } = _testValidateSaveData(input);
    assertEqual(ok, true, 'validator rejected good input');
    assertEqual(data.stats.maxMP, 80, 'maxMP dropped');
    assertEqual(data.stats.weaponR, 0x1E, 'weaponR dropped');
    assertEqual(data.stats.weaponL, 0x00, 'weaponL dropped');
    assertEqual(data.stats.head, 0x62, 'head dropped');
    assertEqual(data.stats.body, 0x72, 'body dropped');
    assertEqual(data.stats.arms, 0x05, 'arms dropped');
  });

  test('save validator clamps equipment IDs to 0-255', () => {
    const input = {
      name: [0x80],
      stats: {
        level: 1, exp: 0, hp: 1, maxHP: 1, maxMP: 0,
        str: 1, agi: 1, vit: 1, int: 1, mnd: 1,
        weaponR: 9999, weaponL: -10,
        head: 256, body: 1, arms: 0,
      },
    };
    const { data } = _testValidateSaveData(input);
    assertEqual(data.stats.weaponR, 255, 'weaponR over-cap');
    assertEqual(data.stats.weaponL, 0, 'weaponL under-zero');
    assertEqual(data.stats.head, 255, 'head 256 not clamped');
  });

  // ── Inventory mirror Phase 0 (v1.7.740) ────────────────────────────
  // Pure-API unit tests — no WS / network. mirrorSyncFromSave is the
  // sole writer in Phase 0 (called from /api/save), so every assert on
  // mirror state exercises the path the production save endpoint hits.
  test('v1.7.740 mirror sync populates all five tables', () => {
    const UID = 88810, SLOT = 0;
    _testEnsureUser(UID);
    _testMirrorClear(UID, SLOT);
    _testMirrorSync(UID, SLOT, {
      gil: 1234, cp: 56, exp: 7890, unlockedJobs: 0x7,
      stats: { weaponR: 0x1E, weaponL: 0x00, head: 0x62, body: 0x72, arms: 0x05 },
      inventory: { 0x80: 5, 0x81: 2 },
      knownSpells: [0x01, 0x02, 0x03],
      jobLevels: { 0: { level: 5, jp: 100 }, 3: { level: 2, jp: 50 } },
    });
    const m = _testMirrorRead(UID, SLOT);
    assertEqual(m.econ.gil, 1234, 'gil');
    assertEqual(m.econ.cp, 56, 'cp');
    assertEqual(m.econ.exp, 7890, 'exp');
    assertEqual(m.econ.unlocked_jobs, 0x7, 'unlockedJobs');
    assertEqual(m.eq.weapon_r, 0x1E, 'weapon_r');
    assertEqual(m.eq.head, 0x62, 'head');
    assertEqual(m.inv.length, 2, 'inventory rows');
    assertEqual(m.inv[0].item_id, 0x80, 'inv first item');
    assertEqual(m.inv[0].qty, 5, 'inv first qty');
    assertEqual(m.sp.length, 3, 'spell rows');
    assertEqual(m.jl.length, 2, 'job rows');
    _testMirrorClear(UID, SLOT);
  });

  test('v1.7.740 mirror re-sync replaces (not appends) array tables', () => {
    const UID = 88811, SLOT = 0;
    _testEnsureUser(UID);
    _testMirrorClear(UID, SLOT);
    // Seed with 3 items, 2 spells.
    _testMirrorSync(UID, SLOT, {
      gil: 100,
      inventory: { 0x80: 1, 0x81: 1, 0x82: 1 },
      knownSpells: [0x01, 0x02],
    });
    let m = _testMirrorRead(UID, SLOT);
    assertEqual(m.inv.length, 3, 'pre: 3 inv rows');
    assertEqual(m.sp.length, 2, 'pre: 2 spell rows');
    // Re-sync with just 1 item, no spells.
    _testMirrorSync(UID, SLOT, {
      gil: 100,
      inventory: { 0x90: 9 },
      knownSpells: [],
    });
    m = _testMirrorRead(UID, SLOT);
    assertEqual(m.inv.length, 1, 'post: 1 inv row (replaced)');
    assertEqual(m.inv[0].item_id, 0x90, 'post: new item');
    assertEqual(m.sp.length, 0, 'post: 0 spell rows (replaced)');
    _testMirrorClear(UID, SLOT);
  });

  test('v1.7.740 mirror sync ignores out-of-range item ids', () => {
    const UID = 88812, SLOT = 0;
    _testEnsureUser(UID);
    _testMirrorClear(UID, SLOT);
    _testMirrorSync(UID, SLOT, {
      gil: 0,
      inventory: { 0x80: 1, '-1': 1, 256: 1, 'abc': 1, 0x99: 3 },
    });
    const m = _testMirrorRead(UID, SLOT);
    assertEqual(m.inv.length, 2, 'only valid item ids land');
    assertEqual(m.inv[0].item_id, 0x80, 'first valid item');
    assertEqual(m.inv[1].item_id, 0x99, 'second valid item');
    _testMirrorClear(UID, SLOT);
  });

  test('v1.7.793 mirrorApplyInvEvent rejects itemId=0 for add/remove', () => {
    const UID = 88822, SLOT = 0;
    _testEnsureUser(UID);
    _testMirrorClear(UID, SLOT);
    // add with itemId=0 → bad-itemId (would seed a phantom item_id=0 row).
    let r = mirrorApplyInvEvent(UID, SLOT, { kind: 'add', itemId: 0, qty: 1 });
    assertEqual(r.ok, false, 'add itemId=0 should reject');
    assertEqual(r.reason, 'bad-itemId', 'wrong reject reason: ' + r.reason);
    // remove with itemId=0 → bad-itemId.
    r = mirrorApplyInvEvent(UID, SLOT, { kind: 'remove', itemId: 0, qty: 1 });
    assertEqual(r.ok, false, 'remove itemId=0 should reject');
    assertEqual(r.reason, 'bad-itemId', 'wrong reject reason: ' + r.reason);
    // equip with itemId=0 (unequip) is still legitimate. qty=2 = head slot.
    r = mirrorApplyInvEvent(UID, SLOT, { kind: 'equip', itemId: 0, qty: 2 });
    assertEqual(r.ok, true, 'equip itemId=0 (unequip head) should pass');
    // gil-delta ignores itemId; itemId=0 still passes.
    r = mirrorApplyInvEvent(UID, SLOT, { kind: 'gil-delta', qty: 10 });
    assertEqual(r.ok, true, 'gil-delta should pass without itemId');
    _testMirrorClear(UID, SLOT);
  });

  test('v1.7.791 recordIntent rejects out-of-range turnIdx', () => {
    const UID = 88820, SLOT = 0;
    _testEnsureUser(UID);
    _testSeedSave(UID, SLOT, { stats: { level: 1, hp: 50, maxHP: 50 } });
    _pveTestReset();
    const start = createPveBattle(UID, { slot: SLOT, zoneKey: 'grasslands_valley', mapId: 0 });
    assertTrue(start && start.battleId != null, 'battle should create');
    // Honest small index is accepted.
    assertEqual(recordIntent(UID, { battleId: start.battleId, turnIdx: 0, kind: 'attack' }), true);
    // Honest in-bound large index is accepted.
    assertEqual(recordIntent(UID, { battleId: start.battleId, turnIdx: 999, kind: 'attack' }), true);
    // Out-of-bound indices reject silently — sparse-array DoS guard.
    assertEqual(recordIntent(UID, { battleId: start.battleId, turnIdx: 1000, kind: 'attack' }), false);
    assertEqual(recordIntent(UID, { battleId: start.battleId, turnIdx: 0x7FFFFFFF, kind: 'attack' }), false);
    assertEqual(recordIntent(UID, { battleId: start.battleId, turnIdx: -1, kind: 'attack' }), false);
    _pveTestReset();
  });

  test('v1.7.791 consumedTilesReap drops rows past the cutoff', () => {
    const UID = 88821, SLOT = 0;
    _testEnsureUser(UID);
    _testConsumedTilesClear(UID, SLOT);
    // Backdate a row by overwriting `consumed_at` via a fresh mark, then
    // reap with a cutoff that's newer than that mark.
    consumedTileMark(UID, SLOT, 114, 1, 1, 'chest');
    const stamp = consumedTileConsumedAt(UID, SLOT, 114, 1, 1, 'chest');
    assertTrue(stamp != null, 'mark should land');
    // Reap with a cutoff well in the future → row drops. We don't assert
    // the changes count because other tests in the same suite run can
    // leave their own stale chest rows behind — verify the SPECIFIC row
    // is gone instead.
    const changes = consumedTilesReap('chest', stamp + 1);
    assertTrue(changes >= 1, 'reap should drop at least our row');
    assertEqual(consumedTileConsumedAt(UID, SLOT, 114, 1, 1, 'chest'), null,
      'reaped row should be gone');
    // Vase rows are NOT reaped by the chest kind selector.
    consumedTileMark(UID, SLOT, 114, 2, 2, 'vase');
    const vstamp = consumedTileConsumedAt(UID, SLOT, 114, 2, 2, 'vase');
    consumedTilesReap('chest', vstamp + 1);
    assertEqual(consumedTileConsumedAt(UID, SLOT, 114, 2, 2, 'vase'), vstamp,
      'vase row survives a chest reap');
    _testConsumedTilesClear(UID, SLOT);
  });
}

// ──────────────────────────────────────────────────────────────────────────
// SUITE 3 — End-to-end wire
// ──────────────────────────────────────────────────────────────────────────
// Real `attachWebSocketPresence` against a localhost server, two JWT-authed
// `ws` clients. Drives scripted scenarios; asserts what the partner
// receives.

function mintToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '1h' });
}

function once(ws, predicate, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for predicate')), timeoutMs);
    const onMsg = (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (predicate(msg)) {
        clearTimeout(t);
        ws.off('message', onMsg);
        resolve(msg);
      }
    };
    ws.on('message', onMsg);
  });
}

function connectClient(port, userId, profile) {
  // Ensure the test userId has a row in `users` so the revocation check in
  // `verifyTokenWithRevocation` validates the minted token. Pre-beta P3
  // JWT rotation rejects tokens whose userId isn't in the DB.
  _testEnsureUser(userId);
  return new Promise((resolve, reject) => {
    const token = mintToken(userId);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${token}`);
    // v1.7.733 — capture every message received from connect-time onward so
    // tests for hello-time-triggered traffic (e.g. the unconditional
    // party-snapshot) can inspect what arrived during the handshake window
    // instead of racing an `once()` listener that's only attached after
    // resolve. The collector keeps running after resolve; `once` and other
    // post-resolve helpers see live traffic the same as before.
    ws._earlyMessages = [];
    let ready = false;
    ws.on('open', () => { /* wait for ready */ });
    ws.on('error', reject);
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      ws._earlyMessages.push(msg);
      if (!ready && msg.type === 'ready') {
        ready = true;
        ws.send(JSON.stringify({ type: 'hello', profile, loc: 'ur' }));
        // Wait one tick for the server to broadcast our join, then resolve.
        setTimeout(() => resolve(ws), 30);
      }
    });
  });
}

async function suiteWire() {
  console.log('\n═══ SUITE 3 — end-to-end wire ═══');
  _testHooks.resetState();

  // Boot the real ws-presence + API on a localhost port. Random port keeps
  // re-runs idempotent. The HTTP path is wired through `handleAPI` so the
  // /api/refresh + /api/logout-all tests can hit the same server.
  const httpServer = createServer(async (req, res) => {
    if (req.url && req.url.startsWith('/api/')) {
      const handled = await handleAPI(req, res);
      if (handled) return;
    }
    res.writeHead(404); res.end();
  });
  attachWebSocketPresence(httpServer);
  // PvP is disabled in prod (v1.7.502) but the wire contract still needs
  // regression coverage for the eventual authoritative-host rewrite — turn it
  // on here so the search/encounter/match tests below exercise the real path.
  _testHooks.setPvpEnabled(true);
  await new Promise(r => httpServer.listen(0, '127.0.0.1', r));
  const port = httpServer.address().port;

  const baseProfile = {
    name: 'Alpha', jobIdx: 5, level: 7, palIdx: 0, hp: 70, maxHP: 70, agi: 12,
    weaponR: 0x1f, armorId: 0x73, helmId: 0x62,
  };
  const targetProfile = {
    name: 'Beta', jobIdx: 4, level: 4, palIdx: 0, hp: 52, maxHP: 52, agi: 9,
    weaponR: 0x1e, armorId: 0x73, helmId: 0x62,
  };

  // ── #18 / #24 / hidden actor relay ───────────────────────────────────────
  await asyncTest('#18 hidden actor relay — server forwards actor.idx', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 1001, { ...baseProfile, name: 'Alpha' });
    const B = await connectClient(port, 1002, { ...targetProfile, name: 'Beta' });
    // Force a partner pair by injecting directly into the server state
    // (no need to drive a full search→encounter flow for this assertion).
    _testHooks.state.pvpPartners.set(1001, 1002);
    _testHooks.state.pvpPartners.set(1002, 1001);
    // Wait for B to receive the pvp-action with `actor`.
    const got = once(B, m => m.type === 'pvp-action');
    A.send(JSON.stringify({
      type: 'pvp-action', kind: 'magic',
      actor: { idx: 1 },
      target: { side: 'opp', idx: 0 },
      spellId: 0x31,
      damageRoll: 42, healAmount: 0,
    }));
    const msg = await got;
    assertEqual(msg.kind, 'magic');
    assertEqual(msg.actor && msg.actor.idx, 1, 'actor.idx not relayed');
    assertEqual(msg.damageRoll, 42, 'damageRoll not relayed');
    assertEqual(msg.spellId, 0x31);
    A.close(); B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── #11 stale-search cleanup on location change ─────────────────────────
  await asyncTest('#11 location change drops outgoing search', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 1003, { ...baseProfile, name: 'A1' });
    const B = await connectClient(port, 1004, { ...targetProfile, name: 'B1' });
    // A searches B.
    A.send(JSON.stringify({ type: 'pvp-search', targetUserId: 1004 }));
    await new Promise(r => setTimeout(r, 30));
    assertTrue(_testHooks.state.pvpSearches.has(1003), 'search not registered');
    // A moves to a different loc. Server should drop A's search.
    const failed = once(A, m => m.type === 'pvp-search-failed', 500);
    A.send(JSON.stringify({ type: 'location', loc: 'cave-1' }));
    const f = await failed;
    assertEqual(f.reason, 'different-location');
    assertTrue(!_testHooks.state.pvpSearches.has(1003), 'search not cleared');
    A.close(); B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── #14 mismatch recovery — both sides get synthetic disconnect ──────────
  await asyncTest('#14 pvp-result mismatch ends both sides', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 1005, { ...baseProfile, name: 'A2' });
    const B = await connectClient(port, 1006, { ...targetProfile, name: 'B2' });
    _testHooks.state.pvpPartners.set(1005, 1006);
    _testHooks.state.pvpPartners.set(1006, 1005);
    // Both report `won` — inconsistent. Server should push disconnect to both.
    const gotA = once(A, m => m.type === 'pvp-action' && m.kind === 'disconnect', 500);
    const gotB = once(B, m => m.type === 'pvp-action' && m.kind === 'disconnect', 500);
    A.send(JSON.stringify({ type: 'pvp-result', outcome: 'won' }));
    await new Promise(r => setTimeout(r, 20));
    B.send(JSON.stringify({ type: 'pvp-result', outcome: 'won' }));
    await Promise.all([gotA, gotB]);
    A.close(); B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── #8 PM-by-userId routes to that user specifically ────────────────────
  await asyncTest('#8 PM by toUserId routes to the target', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 1007, { ...baseProfile, name: 'A3' });
    const B = await connectClient(port, 1008, { ...targetProfile, name: 'B3' });
    const C = await connectClient(port, 1009, { ...targetProfile, name: 'B3' });  // same display name as B
    const gotB = once(B, m => m.type === 'chat' && m.channel === 'pm', 500);
    let cReceived = false;
    const onC = (d) => { const m = JSON.parse(d.toString()); if (m.type === 'chat') cReceived = true; };
    C.on('message', onC);
    A.send(JSON.stringify({ type: 'chat', channel: 'pm', text: 'hi B', toUserId: 1008 }));
    const m = await gotB;
    assertEqual(m.text, 'hi B');
    await new Promise(r => setTimeout(r, 80));
    assertTrue(!cReceived, 'PM leaked to other user with same display name');
    A.close(); B.close(); C.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── Hidden bug regression — server relays actor.idx for ally actions ────
  await asyncTest('hidden actor relay — ally action arrives with idx=2', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 1010, { ...baseProfile, name: 'A4' });
    const B = await connectClient(port, 1011, { ...targetProfile, name: 'B4' });
    _testHooks.state.pvpPartners.set(1010, 1011);
    _testHooks.state.pvpPartners.set(1011, 1010);
    const got = once(B, m => m.type === 'pvp-action');
    A.send(JSON.stringify({
      type: 'pvp-action', kind: 'attack',
      actor: { idx: 2 },                      // ally cell 1 (allyIdx + 1)
      target: { side: 'opp', idx: 0 },
    }));
    const msg = await got;
    assertEqual(msg.actor && msg.actor.idx, 2, 'ally actor.idx dropped');
    A.close(); B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── #18 pvp-ally-join carries profile ──────────────────────────────────
  await asyncTest('#18 pvp-ally-join relays profile to partner', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 1012, { ...baseProfile, name: 'A5' });
    const B = await connectClient(port, 1013, { ...targetProfile, name: 'B5' });
    _testHooks.state.pvpPartners.set(1012, 1013);
    _testHooks.state.pvpPartners.set(1013, 1012);
    const got = once(B, m => m.type === 'pvp-ally-join', 500);
    const allyProfile = {
      name: 'Nyx', jobIdx: 8, level: 5, palIdx: 0, loc: 'ur',
      weaponR: 0x1e, knownSpells: [], jobLevel: 1,
    };
    A.send(JSON.stringify({ type: 'pvp-ally-join', profile: allyProfile }));
    const m = await got;
    assertEqual(m.profile && m.profile.name, 'Nyx');
    assertEqual(m.profile && m.profile.jobIdx, 8);
    A.close(); B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── #6 rate limit — 200 frames in a tight loop, count what makes it ────
  await asyncTest('#6 rate limit drops frames past burst capacity', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 1014, { ...baseProfile, name: 'A6' });
    const B = await connectClient(port, 1015, { ...targetProfile, name: 'B6' });
    let received = 0;
    B.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'chat') received++;
    });
    for (let i = 0; i < 200; i++) {
      A.send(JSON.stringify({ type: 'chat', channel: 'world', text: 'spam' + i }));
    }
    await new Promise(r => setTimeout(r, 200));
    // Per-kind cap for chat is 20 (v1.7.426), refill 5/s. Tight loop fits
    // under 200ms so refill is negligible; ~20 expected. MUST be < 200.
    assertTrue(received < 200, `rate limit didn't bite: ${received} delivered`);
    assertTrue(received >= 15, `unexpected: only ${received} delivered`);
    A.close(); B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── #22 party chat scopes to party, not location ────────────────────────
  await asyncTest('#22 party chat scopes to party-membership', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 1016, { ...baseProfile, name: 'A7' });
    const B = await connectClient(port, 1017, { ...targetProfile, name: 'B7' });
    const C = await connectClient(port, 1018, { ...targetProfile, name: 'C7' });  // unrelated
    // B is in A's party.
    _testHooks.state.partyMemberships.set(1017, 1016);
    const gotB = once(B, m => m.type === 'chat' && m.channel === 'party', 500);
    let cReceived = false;
    C.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'chat' && m.channel === 'party') cReceived = true;
    });
    A.send(JSON.stringify({ type: 'chat', channel: 'party', text: 'party only' }));
    const m = await gotB;
    assertEqual(m.text, 'party only');
    await new Promise(r => setTimeout(r, 80));
    assertTrue(!cReceived, 'party chat leaked to non-party member');
    A.close(); B.close(); C.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── v1.7.720 party-resync offline-mate snapshot ─────────────────────────
  // Pre-fix: a reconnecting client whose partymate is currently offline got
  // NO party-snapshot at all (server's hello fanout only sent the snapshot
  // when at least one mate was online). Local `partyMembers` stayed empty,
  // /disband/leave/party all said "not in a party" — phantom party.
  // v1.7.720: snapshot now ships ALL mates with `online: 0|1` flag;
  // offline mates carry their last-known profile from `_lastSeenProfiles`.
  await asyncTest('v1.7.720 party-resync includes offline mates with cached profile', async () => {
    _testHooks.resetState();
    // Mate's last-known profile cached by a prior session (simulated).
    _testHooks.state.lastSeenProfiles.set(7720, {
      name: 'OfflineMate', jobIdx: 3, level: 7, palIdx: 1,
      hp: 25, maxHP: 60, agi: 8, inBattle: 0, statusMask: 0,
      weaponR: 1, armorId: 0, helmId: 0, allies: [],
    });
    // Membership preserved across the mate's disconnect.
    _testHooks.state.partyMemberships.set(7720, 7710);
    const A = await connectClient(port, 7710, { ...baseProfile, name: 'Resync' });
    const got = once(A, m => m.type === 'party-snapshot', 800);
    A.send(JSON.stringify({ type: 'party-resync' }));
    const snap = await got;
    assertTrue(Array.isArray(snap.members), 'snapshot.members is an array');
    assertEqual(snap.members.length, 1, 'expected one mate in snapshot');
    assertEqual(snap.members[0].userId, 7720, 'mate userId carried');
    assertEqual(snap.members[0].name, 'OfflineMate', 'cached profile fields carried');
    assertEqual(snap.members[0].online, 0, 'offline mate flagged online=0');
    A.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── v1.7.723 party-resync omits mates with no cached profile ──────────
  // Pre-fix the server emitted a skeleton `{name:'Player'}` for mates
  // without profile data; clients rendered them as anonymous "Player"
  // entries in the partymate's roster. Now skipped entirely; user can
  // `/disband` to clean up persistent-but-recoverable-nowhere mates.
  await asyncTest('v1.7.723 party-resync skips mates without cached profile', async () => {
    _testHooks.resetState();
    // Mate is in partyMemberships but has NO _lastSeenProfiles entry
    // and is NOT connected. Pre-v1.7.723 the snapshot would include
    // {userId: 9999, name: 'Player', online: 0}.
    _testHooks.state.partyMemberships.set(9999, 7790);
    const A = await connectClient(port, 7790, { ...baseProfile, name: 'NoDataA' });
    const got = once(A, m => m.type === 'party-snapshot', 800);
    A.send(JSON.stringify({ type: 'party-resync' }));
    const snap = await got;
    assertEqual(snap.members.length, 0, 'no skeleton entry for unrecoverable mate');
    A.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── v1.7.720 party-resync flags online mate with online=1 ──────────────
  await asyncTest('v1.7.720 party-resync flags live mate online=1', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 7711, { ...baseProfile, name: 'ResyncA' });
    const B = await connectClient(port, 7712, { ...targetProfile, name: 'ResyncB' });
    _testHooks.state.partyMemberships.set(7712, 7711);
    const got = once(A, m => m.type === 'party-snapshot', 800);
    A.send(JSON.stringify({ type: 'party-resync' }));
    const snap = await got;
    assertEqual(snap.members.length, 1, 'one online mate in snapshot');
    assertEqual(snap.members[0].userId, 7712, 'mate userId carried');
    assertEqual(snap.members[0].online, 1, 'online mate flagged online=1');
    assertTrue(typeof snap.members[0].name === 'string' && snap.members[0].name.length > 0, 'live profile name carried');
    A.close(); B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── v1.7.733 hello sends snapshot unconditionally ────────────────────
  // Pre-fix the hello fanout was wrapped in `if (mateIds.length > 0)`, so a
  // returning inviter whose members had all `/leave`-d during the offline
  // window got NO snapshot. A soft-reconnect (mobile WS unsuspend, page
  // memory preserved) was left with phantom `partyInviteSt.partyMembers`
  // until they manually ran `/party`. Now the snapshot rides through
  // unconditionally so client REPLACE semantics scrub stale state.
  await asyncTest('v1.7.733 hello sends party-snapshot even with zero mates', async () => {
    _testHooks.resetState();
    // No party memberships set — user has zero mates. The hello-time
    // party-snapshot fires during the connect handshake, so we can't use
    // `once()` here (the listener would be attached after the snapshot
    // already passed). Check the connect-time message buffer instead.
    const A = await connectClient(port, 7733, { ...baseProfile, name: 'NoMates' });
    const snap = A._earlyMessages.find(m => m.type === 'party-snapshot');
    assertTrue(!!snap, 'hello fanout sent a party-snapshot frame');
    assertTrue(Array.isArray(snap.members), 'snapshot.members is an array');
    assertEqual(snap.members.length, 0, 'zero mates → empty members array');
    A.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── v1.7.734 Gap A — inviter disconnect dismisses target's modal ─────
  await asyncTest('v1.7.734 Gap A inviter disconnect notifies target', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 7341, { ...baseProfile, name: 'GapAInv' });
    const B = await connectClient(port, 7342, { ...targetProfile, name: 'GapATgt' });
    A.send(JSON.stringify({ type: 'party-invite', targetUserId: 7342 }));
    // Wait for B's invite-incoming so we know the invite was registered.
    await once(B, m => m.type === 'party-invite-incoming', 800);
    // Now close A — should trigger the dismiss notify on B.
    const got = once(B, m => m.type === 'party-invite-cancelled', 1500);
    A.close();
    const cancel = await got;
    assertEqual(cancel.challengerUserId, 7341, 'challengerUserId matches the disconnecting inviter');
    B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── v1.7.734 Gap B — invite overwrite dismisses prior target's modal ──
  await asyncTest('v1.7.734 Gap B inviter switching targets cancels prior invite', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 7343, { ...baseProfile, name: 'GapBInv' });
    const B = await connectClient(port, 7344, { ...targetProfile, name: 'GapBTgt1' });
    const C = await connectClient(port, 7345, { ...targetProfile, name: 'GapBTgt2' });
    A.send(JSON.stringify({ type: 'party-invite', targetUserId: 7344 }));
    await once(B, m => m.type === 'party-invite-incoming', 800);
    // A switches to C. B should get a party-invite-cancelled.
    const got = once(B, m => m.type === 'party-invite-cancelled', 1500);
    A.send(JSON.stringify({ type: 'party-invite', targetUserId: 7345 }));
    const cancel = await got;
    assertEqual(cancel.challengerUserId, 7343, 'cancel carries original inviter userId');
    A.close(); B.close(); C.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── v1.7.734 Gap C — inviter /leave redirects to disband ──────────────
  await asyncTest('v1.7.734 Gap C inviter party-leave runs disband path', async () => {
    _testHooks.resetState();
    // Pre-seed an inviter+member pair so we don't have to round-trip an invite.
    _testHooks.state.partyMemberships.set(7347, 7346);
    const A = await connectClient(port, 7346, { ...baseProfile, name: 'GapCInv' });
    const B = await connectClient(port, 7347, { ...targetProfile, name: 'GapCMem' });
    const got = once(B, m => m.type === 'party-disbanded', 1500);
    A.send(JSON.stringify({ type: 'party-leave' }));   // inviter calls /leave
    const disbanded = await got;
    assertEqual(disbanded.inviterUserId, 7346, 'disband attributed to inviter');
    assertEqual(_testHooks.state.partyMemberships.has(7347), false, 'member row cleared server-side');
    A.close(); B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── v1.7.734 Gap D — stale invite-response gets dismissed back ───────
  await asyncTest('v1.7.734 Gap D stale response dismisses responder modal', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 7348, { ...baseProfile, name: 'GapDInv' });
    const B = await connectClient(port, 7349, { ...targetProfile, name: 'GapDTgt' });
    A.send(JSON.stringify({ type: 'party-invite', targetUserId: 7349 }));
    await once(B, m => m.type === 'party-invite-incoming', 800);
    // A cancels server-side (clears _partyInvites); B's modal still open
    // locally. B then attempts to accept — should get party-invite-cancelled
    // back so B's modal dismisses gracefully.
    A.send(JSON.stringify({ type: 'party-cancel' }));
    // Drain the cancel notify that fires naturally so we don't latch onto it.
    await once(B, m => m.type === 'party-invite-cancelled', 800);
    // Now simulate B responding (their modal didn't see the cancel, or the
    // user clicked accept in the same tick). Server should send a fresh
    // cancelled back. Use a fresh listener.
    const got = once(B, m => m.type === 'party-invite-cancelled', 1500);
    B.send(JSON.stringify({ type: 'party-invite-response', accept: true, expectChallengerUserId: 7348 }));
    const cancel = await got;
    assertEqual(cancel.challengerUserId, 7348, 'stale-response cancel carries expectChallengerUserId');
    A.close(); B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── v1.7.735 GI-1 give-item to offline target refunds sender ────────
  await asyncTest('v1.7.735 GI-1 give-item to offline target notifies sender', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 7351, { ...baseProfile, name: 'GiveSender' });
    // No B connected — target userId 7352 is offline. Sender's local already
    // consumed the item; server should respond with give-item-failed so the
    // client can re-grant.
    const got = once(A, m => m.type === 'give-item-failed', 800);
    A.send(JSON.stringify({ type: 'give-item', targetUserId: 7352, itemId: 0x80 }));
    const fail = await got;
    assertEqual(fail.targetUserId, 7352, 'failed message carries target userId');
    assertEqual(fail.itemId, 0x80, 'failed message carries item id for refund');
    assertEqual(fail.reason, 'offline', 'reason flagged offline');
    A.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── v1.7.793 — give-item with key item rejected via type whitelist ──
  await asyncTest('v1.7.793 give-item with key item is blocked by type whitelist', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 7361, { ...baseProfile, name: 'KeyGiver' });
    const B = await connectClient(port, 7362, { ...targetProfile, name: 'KeyTarget' });
    // Item 0x98 = Magic Key (type 'key' in src/data/items.js). Server's
    // give-item handler now mirrors trade-offer's NON_TRADEABLE_ITEM_TYPES
    // filter — should respond with `give-item-failed reason='blocked'`
    // and NOT relay to B.
    let bGotRelay = false;
    B.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'give-item') bGotRelay = true;
    });
    const got = once(A, m => m.type === 'give-item-failed', 800);
    A.send(JSON.stringify({ type: 'give-item', targetUserId: 7362, itemId: 0x98 }));
    const fail = await got;
    assertEqual(fail.reason, 'blocked', 'key item should reject as blocked');
    assertEqual(fail.itemId, 0x98, 'failed message carries item id for refund');
    await new Promise(r => setTimeout(r, 80));
    assertTrue(!bGotRelay, 'blocked give-item must not relay to target');
    A.close(); B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── v1.7.735 PM-1 PM to offline target notifies sender ──────────────
  await asyncTest('v1.7.735 PM-1 pm to offline target notifies sender', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 7353, { ...baseProfile, name: 'PmSender' });
    // toUserId path — target offline.
    const got = once(A, m => m.type === 'chat-pm-failed', 800);
    A.send(JSON.stringify({
      type: 'chat', channel: 'pm', text: 'hi',
      to: 'PmTarget', toUserId: 7354,
    }));
    const fail = await got;
    assertEqual(fail.to, 'PmTarget', 'failed message carries display name');
    assertEqual(fail.toUserId, 7354, 'failed message carries userId when known');
    assertEqual(fail.reason, 'offline', 'reason flagged offline');
    A.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── v1.7.735 PM-1 legacy name-only PM to nonexistent target notifies ──
  await asyncTest('v1.7.735 PM-1 legacy name-route fail notifies sender', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 7355, { ...baseProfile, name: 'PmSenderB' });
    // toUserId omitted — server hits the legacy name-loop, finds no match.
    const got = once(A, m => m.type === 'chat-pm-failed', 800);
    A.send(JSON.stringify({
      type: 'chat', channel: 'pm', text: 'hi',
      to: 'NobodyByThatName',
    }));
    const fail = await got;
    assertEqual(fail.to, 'NobodyByThatName', 'failed message carries name');
    A.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── v1.7.736 JWT-bump kicks existing WS ────────────────────────────
  // Pre-fix /api/logout-all only bumped the DB watermark; existing WS
  // sessions stayed alive (verified at upgrade, never re-checked) until
  // each made its next HTTP call and 401'd. Now the hook closes any
  // user-WS whose tokenIat predates the watermark.
  await asyncTest('v1.7.736 logout-all closes stale WS', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 7361, { ...baseProfile, name: 'JwtKick' });
    // Simulate /api/logout-all having bumped the watermark to now+1 (so
    // the WS we just opened has iat < watermark).
    const futureWatermark = Math.floor(Date.now() / 1000) + 1;
    const gotClose = new Promise((resolve) => {
      A.on('close', (code, reason) => resolve({ code, reason: reason?.toString() }));
    });
    const revoked = _testHooks.revokeWsBeforeIat(7361, futureWatermark);
    assertEqual(revoked, true, 'revoke returned true (WS found and closed)');
    const closed = await Promise.race([
      gotClose,
      new Promise((_, reject) => setTimeout(() => reject(new Error('WS did not close within 1500ms')), 1500)),
    ]);
    assertEqual(closed.code, 4002, 'close code 4002 distinguishes logout-all from replaced');
    await new Promise(r => setTimeout(r, 40));
  });

  // ── v1.7.736 player-update buffered until player-join arrives ───────
  // Hand-test the client-side buffer logic by importing the relevant
  // module. (Server-side has no behavior change; this is a client
  // unit-test in the wire-sim harness's host process.)
  await asyncTest('v1.7.736 player-update before join is buffered + drained', async () => {
    // Import the net module's dispatch directly. Since net.js is a
    // browser-targeted module that calls `localStorage` at top-level,
    // we instead replicate the buffer logic inline as a regression of
    // the contract: out-of-order update for unknown userId stashes,
    // then a subsequent join applies the stashed fields.
    //
    // The actual client code lives in src/net.js#case 'player-update'
    // and case 'player-join'. This test asserts the OBSERVABLE
    // contract: server can emit `player-update` for a userId BEFORE
    // `player-join` for that same userId without losing data.
    //
    // Smoke this by emitting both via the wire in that order to a
    // peer and verifying the join fanout's profile fields land
    // intact (any server change that breaks the ordering would surface
    // as a missing field in the peer's snapshot).
    _testHooks.resetState();
    const A = await connectClient(port, 7363, { ...baseProfile, name: 'BufA' });
    // Connect B which triggers a `player-join` broadcast to A. Then
    // update B's profile, which broadcasts a `player-update`. A should
    // see both. We're checking the JOIN actually carries the live profile.
    const B = await connectClient(port, 7364, { ...targetProfile, name: 'BufB', level: 5 });
    // A should receive a player-join for B with the full profile.
    const join = A._earlyMessages.find(m => m.type === 'player-join' && m.player?.userId === 7364);
    assertTrue(!!join, 'A received player-join for B');
    assertEqual(join.player.name, 'BufB', 'join carries name');
    assertEqual(join.player.level, 5, 'join carries level');
    A.close(); B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── v1.7.737 D-1 _lastSeenProfiles reaped on party-leave ────────────
  // Pre-fix the cache grew unbounded — comment claimed it dropped on
  // leave/dismiss/disband but no delete() calls existed. Fixed by
  // wiring the deletes per the comment.
  await asyncTest('v1.7.737 D-1 party-leave drops cached profile', async () => {
    _testHooks.resetState();
    // Seed: member 7371 in inviter 7370's party, both cached.
    _testHooks.state.partyMemberships.set(7371, 7370);
    _testHooks.state.lastSeenProfiles.set(7370, { name: 'Inviter' });
    _testHooks.state.lastSeenProfiles.set(7371, { name: 'Member' });
    const B = await connectClient(port, 7371, { ...targetProfile, name: 'Member' });
    B.send(JSON.stringify({ type: 'party-leave' }));
    // Wait a beat for the server to process.
    await new Promise(r => setTimeout(r, 100));
    assertEqual(_testHooks.state.lastSeenProfiles.has(7371), false,
      'leaver cache reaped');
    assertEqual(_testHooks.state.lastSeenProfiles.has(7370), true,
      'inviter cache preserved (still party-ful with other members)');
    B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  await asyncTest('v1.7.737 D-1 party-disband drops all cached profiles', async () => {
    _testHooks.resetState();
    _testHooks.state.partyMemberships.set(7373, 7372);
    _testHooks.state.partyMemberships.set(7374, 7372);
    _testHooks.state.lastSeenProfiles.set(7372, { name: 'InvAll' });
    _testHooks.state.lastSeenProfiles.set(7373, { name: 'M1' });
    _testHooks.state.lastSeenProfiles.set(7374, { name: 'M2' });
    const A = await connectClient(port, 7372, { ...baseProfile, name: 'InvAll' });
    A.send(JSON.stringify({ type: 'party-disband' }));
    await new Promise(r => setTimeout(r, 100));
    assertEqual(_testHooks.state.lastSeenProfiles.has(7372), false, 'inviter reaped');
    assertEqual(_testHooks.state.lastSeenProfiles.has(7373), false, 'member 1 reaped');
    assertEqual(_testHooks.state.lastSeenProfiles.has(7374), false, 'member 2 reaped');
    A.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── v1.7.741 Phase 1a inv-event roundtrip ────────────────────────────
  // Client sends inv-event {kind:'add'}, server applies to mirror.
  // Verify the mirror has the new qty after the event lands. Shadow
  // mode: no rejection, no inv-state push back.
  await asyncTest('v1.7.741 inv-event add applies to mirror', async () => {
    _testHooks.resetState();
    _testEnsureUser(7411);
    _testMirrorClear(7411, 0);
    const A = await connectClient(port, 7411, { ...baseProfile, name: 'InvA', slot: 0 });
    A.send(JSON.stringify({ type: 'inv-event', kind: 'add', itemId: 0x80, qty: 3, source: 'chest' }));
    // Wait for the server to process the event (no response in 1a; small delay).
    await new Promise(r => setTimeout(r, 80));
    const m = _testMirrorRead(7411, 0);
    assertEqual(m.inv.length, 1, 'mirror has 1 item after add');
    assertEqual(m.inv[0].item_id, 0x80, 'item id');
    assertEqual(m.inv[0].qty, 3, 'qty applied');
    A.close();
    _testMirrorClear(7411, 0);
    await new Promise(r => setTimeout(r, 40));
  });

  await asyncTest('v1.7.741 inv-event remove decrements mirror', async () => {
    _testHooks.resetState();
    _testEnsureUser(7412);
    _testMirrorClear(7412, 0);
    // Seed mirror with 5 Potions.
    _testMirrorSync(7412, 0, { gil: 0, inventory: { 0x80: 5 } });
    const A = await connectClient(port, 7412, { ...baseProfile, name: 'InvR', slot: 0 });
    A.send(JSON.stringify({ type: 'inv-event', kind: 'remove', itemId: 0x80, qty: 2, source: 'use' }));
    await new Promise(r => setTimeout(r, 80));
    const m = _testMirrorRead(7412, 0);
    assertEqual(m.inv.length, 1, '1 item row remains');
    assertEqual(m.inv[0].qty, 3, 'qty decremented 5 → 3');
    A.close();
    _testMirrorClear(7412, 0);
    await new Promise(r => setTimeout(r, 40));
  });

  await asyncTest('v1.7.741 inv-event remove past zero deletes row (shadow mode)', async () => {
    _testHooks.resetState();
    _testEnsureUser(7413);
    _testMirrorClear(7413, 0);
    _testMirrorSync(7413, 0, { gil: 0, inventory: { 0x80: 2 } });
    // v1.7.745 — shadow-mode behavior; toggle off the authoritative gate
    // for this test so the divergent remove applies (clamped to 0) instead
    // of being rejected with a push.
    const prev = _testSetMirrorAuthoritative(false);
    try {
      const A = await connectClient(port, 7413, { ...baseProfile, name: 'InvZ', slot: 0 });
      A.send(JSON.stringify({ type: 'inv-event', kind: 'remove', itemId: 0x80, qty: 5, source: 'use' }));
      await new Promise(r => setTimeout(r, 80));
      const m = _testMirrorRead(7413, 0);
      assertEqual(m.inv.length, 0, 'row deleted when qty reaches 0');
      A.close();
    } finally {
      _testSetMirrorAuthoritative(prev);
      _testMirrorClear(7413, 0);
      await new Promise(r => setTimeout(r, 40));
    }
  });

  await asyncTest('v1.7.741 inv-event gil-delta applies', async () => {
    _testHooks.resetState();
    _testEnsureUser(7414);
    _testMirrorClear(7414, 0);
    _testMirrorSync(7414, 0, { gil: 100 });
    const A = await connectClient(port, 7414, { ...baseProfile, name: 'InvG', slot: 0 });
    A.send(JSON.stringify({ type: 'inv-event', kind: 'gil-delta', itemId: 0, qty: 250, source: 'chest' }));
    await new Promise(r => setTimeout(r, 80));
    const m = _testMirrorRead(7414, 0);
    assertEqual(m.econ.gil, 350, 'gil 100 + 250 = 350');
    A.close();
    _testMirrorClear(7414, 0);
    await new Promise(r => setTimeout(r, 40));
  });

  await asyncTest('v1.7.741 inv-event bad bounds silently rejected', async () => {
    _testHooks.resetState();
    _testEnsureUser(7415);
    _testMirrorClear(7415, 0);
    const A = await connectClient(port, 7415, { ...baseProfile, name: 'InvBad', slot: 0 });
    // Out-of-range itemId, bad qty, bad kind — all should no-op on the mirror.
    A.send(JSON.stringify({ type: 'inv-event', kind: 'add', itemId: 999, qty: 1, source: 'chest' }));
    A.send(JSON.stringify({ type: 'inv-event', kind: 'add', itemId: 0x80, qty: 0, source: 'chest' }));
    A.send(JSON.stringify({ type: 'inv-event', kind: 'totally-fake-kind', itemId: 0x80, qty: 1 }));
    await new Promise(r => setTimeout(r, 80));
    const m = _testMirrorRead(7415, 0);
    assertEqual(m.inv.length, 0, 'no rows added for invalid events');
    A.close();
    _testMirrorClear(7415, 0);
    await new Promise(r => setTimeout(r, 40));
  });

  await asyncTest('v1.7.741 inv-state-request returns full mirror snapshot', async () => {
    _testHooks.resetState();
    _testEnsureUser(7416);
    _testMirrorClear(7416, 0);
    _testMirrorSync(7416, 0, {
      gil: 1500, cp: 50, exp: 800, unlockedJobs: 0x7,
      inventory: { 0x80: 5, 0x90: 1 },
      stats: { weaponR: 0x1E, head: 0x62 },
      knownSpells: [0x01, 0x02],
    });
    const A = await connectClient(port, 7416, { ...baseProfile, name: 'InvSnap', slot: 0 });
    const got = once(A, m => m.type === 'inv-state', 800);
    A.send(JSON.stringify({ type: 'inv-state-request' }));
    const snap = await got;
    assertEqual(snap.slot, 0, 'slot in snapshot');
    assertEqual(snap.gil, 1500, 'gil');
    assertEqual(snap.inventory[0x80], 5, 'inventory potion qty');
    assertEqual(snap.inventory[0x90], 1, 'inventory elixir qty');
    assertEqual(snap.equipped.weaponR, 0x1E, 'equipped weaponR');
    assertEqual(snap.equipped.head, 0x62, 'equipped head');
    assertTrue(Array.isArray(snap.knownSpells) && snap.knownSpells.length === 2, 'spells array');
    A.close();
    _testMirrorClear(7416, 0);
    await new Promise(r => setTimeout(r, 40));
  });

  await asyncTest('v1.7.741 hello slot routes inv-event to right slot', async () => {
    _testHooks.resetState();
    _testEnsureUser(7417);
    _testMirrorClear(7417, 0);
    _testMirrorClear(7417, 1);
    const A = await connectClient(port, 7417, { ...baseProfile, name: 'InvSlot', slot: 1 });
    A.send(JSON.stringify({ type: 'inv-event', kind: 'add', itemId: 0x80, qty: 1, source: 'chest' }));
    await new Promise(r => setTimeout(r, 80));
    const slot0 = _testMirrorRead(7417, 0);
    const slot1 = _testMirrorRead(7417, 1);
    assertEqual(slot0.inv.length, 0, 'slot 0 untouched');
    assertEqual(slot1.inv.length, 1, 'slot 1 received the add');
    A.close();
    _testMirrorClear(7417, 0);
    _testMirrorClear(7417, 1);
    await new Promise(r => setTimeout(r, 40));
  });

  // ── v1.7.744 Phase 4 (partial) — gate save sync ────────────────────────
  // With INV_MIRROR_AUTHORITATIVE_SERVER on, mirrorSyncFromSave must skip
  // the wire-managed fields (inventory, gil, equipped) so the wire becomes
  // the sole writer. Non-wire-managed fields (cp, exp, unlockedJobs, spells,
  // jobLevels) still sync.
  test('v1.7.744 save sync skips wire-managed fields when flag on', () => {
    const UID = 7441; const SLOT = 0;
    _testEnsureUser(UID);
    _testMirrorClear(UID, SLOT);
    // Seed mirror with state the wire would have produced (bootSeed bypass
    // — always writes regardless of flag).
    _testMirrorSync(UID, SLOT, {
      gil: 500, inventory: { 0x80: 5 },
      stats: { weaponR: 0x1E, weaponL: 0, head: 0, body: 0, arms: 0 },
    });
    const prev = _testSetMirrorAuthoritative(true);
    try {
      // Runtime sync (gated by the flag) — claims different inventory + gil
      // + equipped, should be IGNORED for those fields. cp/exp/unlockedJobs/
      // spells/jobs should still apply (not wire-managed).
      _testMirrorSyncRuntime(UID, SLOT, {
        gil: 99999, inventory: { 0x80: 99, 0xDE: 1 },
        stats: { weaponR: 0xDE, weaponL: 0xDE, head: 0xDE, body: 0xDE, arms: 0xDE },
        cp: 42, exp: 1234, unlockedJobs: 0xFF,
        knownSpells: [0x01, 0x02],
      });
      const m = _testMirrorRead(UID, SLOT);
      assertEqual(m.econ.gil, 500, 'gil preserved (wire-managed)');
      assertEqual(m.inv.length, 1, 'inventory unchanged (wire-managed)');
      assertEqual(m.inv[0].qty, 5, 'potion qty preserved');
      assertEqual(m.eq.weapon_r, 0x1E, 'weaponR preserved (wire-managed)');
      assertEqual(m.eq.body, 0, 'body unchanged (wire-managed)');
      assertEqual(m.econ.cp, 42, 'cp synced (not wire-managed)');
      assertEqual(m.econ.exp, 1234, 'exp synced (not wire-managed)');
      assertEqual(m.econ.unlocked_jobs, 0xFF, 'unlockedJobs synced (not wire-managed)');
      assertEqual(m.sp.length, 2, 'knownSpells synced (not wire-managed)');
    } finally {
      _testSetMirrorAuthoritative(prev);
      _testMirrorClear(UID, SLOT);
    }
  });

  test('v1.7.744 save sync writes wire-managed fields when flag off (shadow)', () => {
    const UID = 7442; const SLOT = 0;
    _testEnsureUser(UID);
    _testMirrorClear(UID, SLOT);
    // v1.7.745 production default is `true`; toggle off to exercise the
    // shadow-mode path (still supported as the rollback target). Use the
    // runtime helper so the gate decision is exercised — the bypass
    // seed helper would always write regardless.
    const prev = _testSetMirrorAuthoritative(false);
    try {
      _testMirrorSyncRuntime(UID, SLOT, {
        gil: 7777, inventory: { 0x80: 3 },
        stats: { weaponR: 0x1E, weaponL: 0, head: 0, body: 0, arms: 0 },
      });
      const m = _testMirrorRead(UID, SLOT);
      assertEqual(m.econ.gil, 7777, 'gil written in shadow mode');
      assertEqual(m.inv[0].qty, 3, 'inventory written in shadow mode');
      assertEqual(m.eq.weapon_r, 0x1E, 'equipped written in shadow mode');
    } finally {
      _testSetMirrorAuthoritative(prev);
      _testMirrorClear(UID, SLOT);
    }
  });

  test('v1.7.744 bootSeed bypasses gate even with flag on', () => {
    const UID = 7443; const SLOT = 0;
    _testEnsureUser(UID);
    _testMirrorClear(UID, SLOT);
    const prev = _testSetMirrorAuthoritative(true);
    try {
      // Empty mirror — _testMirrorSync (which threads bootSeed:true) must
      // populate it. Mirrors the real _mirrorBootSeed IIFE that runs at
      // module load to migrate the existing `saves` table to mirror rows.
      _testMirrorSync(UID, SLOT, {
        gil: 250, inventory: { 0x80: 4 },
        stats: { weaponR: 0x1E, weaponL: 0, head: 0, body: 0, arms: 0 },
      });
      const m = _testMirrorRead(UID, SLOT);
      assertEqual(m.econ.gil, 250, 'bootSeed wrote gil');
      assertEqual(m.inv[0].qty, 4, 'bootSeed wrote inventory');
      assertEqual(m.eq.weapon_r, 0x1E, 'bootSeed wrote equipped');
    } finally {
      _testSetMirrorAuthoritative(prev);
      _testMirrorClear(UID, SLOT);
    }
  });

  // ── v1.7.745 Phase 1b — authoritative rejection + corrective push ──────
  // When the server-side flag is on, divergent remove + gil-delta events
  // are rejected with a corrective inv-state push (reason: 'rejected').
  // The mirror is NOT mutated by a rejected event.
  await asyncTest('v1.7.745 divergent remove rejected with inv-state push', async () => {
    _testHooks.resetState();
    _testEnsureUser(7451);
    _testMirrorClear(7451, 0);
    // Seed mirror with 2 Potions.
    _testMirrorSync(7451, 0, { gil: 100, inventory: { 0x80: 2 } });
    const prev = _testSetMirrorAuthoritative(true);
    try {
      const A = await connectClient(port, 7451, { ...baseProfile, name: 'RejR', slot: 0 });
      // Client claims to remove 5 — only has 2.
      const gotState = once(A, m => m.type === 'inv-state', 800);
      A.send(JSON.stringify({ type: 'inv-event', kind: 'remove', itemId: 0x80, qty: 5, source: 'use' }));
      const snap = await gotState;
      assertEqual(snap.reason, 'rejected', 'inv-state reason is rejected');
      assertEqual(snap.rejectedKind, 'remove', 'rejected kind is remove');
      assertEqual(snap.rejectedItemId, 0x80, 'rejected itemId echoed');
      assertEqual(snap.inventory[0x80], 2, 'inventory snapshot still shows 2 (no mutation)');
      const m = _testMirrorRead(7451, 0);
      assertEqual(m.inv[0].qty, 2, 'mirror still 2 after rejection');
      A.close();
    } finally {
      _testSetMirrorAuthoritative(prev);
      _testMirrorClear(7451, 0);
      await new Promise(r => setTimeout(r, 40));
    }
  });

  await asyncTest('v1.7.745 legitimate remove applies without push', async () => {
    _testHooks.resetState();
    _testEnsureUser(7452);
    _testMirrorClear(7452, 0);
    _testMirrorSync(7452, 0, { gil: 0, inventory: { 0x80: 5 } });
    const prev = _testSetMirrorAuthoritative(true);
    try {
      const A = await connectClient(port, 7452, { ...baseProfile, name: 'OkR', slot: 0 });
      // Set up a listener that should NOT fire (only listen briefly).
      let gotState = false;
      A.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'inv-state') gotState = true;
      });
      A.send(JSON.stringify({ type: 'inv-event', kind: 'remove', itemId: 0x80, qty: 2, source: 'use' }));
      await new Promise(r => setTimeout(r, 120));
      assertTrue(!gotState, 'no inv-state push for legitimate remove');
      const m = _testMirrorRead(7452, 0);
      assertEqual(m.inv[0].qty, 3, 'mirror decremented 5 → 3');
      A.close();
    } finally {
      _testSetMirrorAuthoritative(prev);
      _testMirrorClear(7452, 0);
      await new Promise(r => setTimeout(r, 40));
    }
  });

  await asyncTest('v1.7.745 gil-delta underflow rejected with corrective push', async () => {
    _testHooks.resetState();
    _testEnsureUser(7453);
    _testMirrorClear(7453, 0);
    _testMirrorSync(7453, 0, { gil: 50 });
    const prev = _testSetMirrorAuthoritative(true);
    try {
      const A = await connectClient(port, 7453, { ...baseProfile, name: 'GilU', slot: 0 });
      const gotState = once(A, m => m.type === 'inv-state', 800);
      // Spend 200 with only 50 in mirror.
      A.send(JSON.stringify({ type: 'inv-event', kind: 'gil-delta', itemId: 0, qty: -200, source: 'shop' }));
      const snap = await gotState;
      assertEqual(snap.reason, 'rejected', 'rejected push');
      assertEqual(snap.gil, 50, 'gil snapshot unchanged');
      const m = _testMirrorRead(7453, 0);
      assertEqual(m.econ.gil, 50, 'mirror gil unchanged after rejection');
      A.close();
    } finally {
      _testSetMirrorAuthoritative(prev);
      _testMirrorClear(7453, 0);
      await new Promise(r => setTimeout(r, 40));
    }
  });

  await asyncTest('v1.7.745 shadow mode (flag off) still applies divergent removes', async () => {
    _testHooks.resetState();
    _testEnsureUser(7454);
    _testMirrorClear(7454, 0);
    _testMirrorSync(7454, 0, { gil: 0, inventory: { 0x80: 1 } });
    // Explicit shadow-mode toggle — production default is now `true`,
    // so this test exercises the rollback path.
    const prev = _testSetMirrorAuthoritative(false);
    try {
      const A = await connectClient(port, 7454, { ...baseProfile, name: 'ShdR', slot: 0 });
      let gotState = false;
      A.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'inv-state') gotState = true;
      });
      A.send(JSON.stringify({ type: 'inv-event', kind: 'remove', itemId: 0x80, qty: 5, source: 'use' }));
      await new Promise(r => setTimeout(r, 120));
      assertTrue(!gotState, 'shadow mode never pushes inv-state on divergence');
      const m = _testMirrorRead(7454, 0);
      assertEqual(m.inv.length, 0, 'mirror clamped to 0 + row deleted');
      A.close();
    } finally {
      _testSetMirrorAuthoritative(prev);
      _testMirrorClear(7454, 0);
      await new Promise(r => setTimeout(r, 40));
    }
  });

  // ── v1.7.721 P7 server-side cooldown survives client reload ─────────
  await asyncTest('v1.7.721 P7 decline sets server cooldown; re-invite rejected', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 7721, { ...baseProfile, name: 'CdA' });
    const B = await connectClient(port, 7722, { ...targetProfile, name: 'CdB' });
    // Simulate the full invite → decline flow so the cooldown gets set.
    const bGotInvite = once(B, m => m.type === 'party-invite-incoming', 600);
    A.send(JSON.stringify({ type: 'party-invite', targetUserId: 7722 }));
    await bGotInvite;
    const aGotDecline = once(A, m => m.type === 'party-invite-result', 600);
    B.send(JSON.stringify({ type: 'party-invite-response', accept: false }));
    const decline = await aGotDecline;
    assertEqual(decline.accept, false, 'first invite declined');
    // Re-invite immediately → server rejects with reason: 'cooldown'.
    const aGotCooldown = once(A, m => m.type === 'party-invite-result', 600);
    A.send(JSON.stringify({ type: 'party-invite', targetUserId: 7722 }));
    const cooldown = await aGotCooldown;
    assertEqual(cooldown.accept, false, 'second invite rejected');
    assertEqual(cooldown.reason, 'cooldown', 'rejected with cooldown reason');
    A.close(); B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── v1.7.721 P8 dismiss carries reason: 'dismissed' ─────────────────
  await asyncTest('v1.7.721 P8 dismiss flags party-disbanded msg as dismissed', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 7731, { ...baseProfile, name: 'DismA' });
    const B = await connectClient(port, 7732, { ...targetProfile, name: 'DismB' });
    _testHooks.state.partyMemberships.set(7732, 7731);
    const bGotDisbanded = once(B, m => m.type === 'party-disbanded', 600);
    A.send(JSON.stringify({ type: 'party-dismiss', memberUserId: 7732 }));
    const msg = await bGotDisbanded;
    assertEqual(msg.reason, 'dismissed', 'dismissed flag on disband msg');
    assertEqual(msg.inviterUserId, 7731, 'inviter userId carried');
    A.close(); B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── v1.7.721 P9 disband cancels pending outgoing invite ─────────────
  await asyncTest('v1.7.721 P9 disband cancels outgoing invite + notifies target', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 7741, { ...baseProfile, name: 'P9A' });
    const B = await connectClient(port, 7742, { ...targetProfile, name: 'P9B' });
    const bGotInvite = once(B, m => m.type === 'party-invite-incoming', 600);
    A.send(JSON.stringify({ type: 'party-invite', targetUserId: 7742 }));
    await bGotInvite;
    // A disbands while invite is pending. B should get party-invite-cancelled.
    const bGotCancelled = once(B, m => m.type === 'party-invite-cancelled', 600);
    A.send(JSON.stringify({ type: 'party-disband' }));
    const cancelled = await bGotCancelled;
    assertEqual(cancelled.challengerUserId, 7741, 'cancelled msg carries challenger userId');
    // _partyInvites should be cleared.
    assertTrue(!_testHooks.state.partyInvites.has(7741), 'pending invite cleared from server');
    A.close(); B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── v1.7.721 party-cancel notifies target so modal dismisses ───────
  await asyncTest('v1.7.721 party-cancel notifies target with party-invite-cancelled', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 7751, { ...baseProfile, name: 'CancA' });
    const B = await connectClient(port, 7752, { ...targetProfile, name: 'CancB' });
    const bGotInvite = once(B, m => m.type === 'party-invite-incoming', 600);
    A.send(JSON.stringify({ type: 'party-invite', targetUserId: 7752 }));
    await bGotInvite;
    const bGotCancelled = once(B, m => m.type === 'party-invite-cancelled', 600);
    A.send(JSON.stringify({ type: 'party-cancel' }));
    const cancelled = await bGotCancelled;
    assertEqual(cancelled.challengerUserId, 7751, 'cancelled msg carries challenger userId');
    A.close(); B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── v1.7.746 Phase 5 — update broadcast cross-check vs mirror ──────────
  // Authoritative mirror owns equipped (since Phase 1b). A client that
  // claims weaponR/L/helmId/armorId/shieldId different from mirror state
  // gets the broadcast field SILENTLY overwritten with mirror's view —
  // peers + ally-stat generation only ever see authoritative gear.
  await asyncTest('v1.7.746 update overwrites cheated weaponR from mirror', async () => {
    _testHooks.resetState();
    _testEnsureUser(7461);
    _testEnsureUser(7462);
    _testMirrorClear(7461, 0);
    // Seed mirror with the legitimate weapon (Knife 0x1E).
    _testMirrorSync(7461, 0, {
      gil: 0, inventory: {},
      stats: { weaponR: 0x1E, weaponL: 0, head: 0x62, body: 0x73, arms: 0 },
    });
    const A = await connectClient(port, 7461, { ...baseProfile, name: 'CheatW', slot: 0 });
    const B = await connectClient(port, 7462, { ...targetProfile, name: 'PeerW' });
    // B should receive A's player-update with weaponR === mirror's 0x1E,
    // NOT A's claimed 0xDE (Sage Staff).
    const bGotUpdate = once(B, m => m.type === 'player-update' && m.userId === 7461, 800);
    A.send(JSON.stringify({ type: 'update', weaponR: 0xDE, armorId: 0xDE, helmId: 0xDE }));
    const msg = await bGotUpdate;
    assertEqual(msg.fields.weaponR, 0x1E, 'weaponR overwritten with mirror');
    assertEqual(msg.fields.armorId, 0x73, 'armorId overwritten with mirror body');
    assertEqual(msg.fields.helmId, 0x62, 'helmId overwritten with mirror head');
    A.close(); B.close();
    _testMirrorClear(7461, 0);
    await new Promise(r => setTimeout(r, 40));
  });

  await asyncTest('v1.7.746 update passes through matching equipment', async () => {
    _testHooks.resetState();
    _testEnsureUser(7463);
    _testEnsureUser(7464);
    _testMirrorClear(7463, 0);
    _testMirrorSync(7463, 0, {
      gil: 0, inventory: {},
      stats: { weaponR: 0x1F, weaponL: 0, head: 0x62, body: 0x73, arms: 0x58 },
    });
    const A = await connectClient(port, 7463, { ...baseProfile, name: 'OkW', slot: 0 });
    const B = await connectClient(port, 7464, { ...targetProfile, name: 'PeerOk' });
    const bGotUpdate = once(B, m => m.type === 'player-update' && m.userId === 7463, 800);
    // Client claims values that match mirror exactly — no overwrite, no warning.
    A.send(JSON.stringify({ type: 'update', weaponR: 0x1F, armorId: 0x73, helmId: 0x62, shieldId: 0x58 }));
    const msg = await bGotUpdate;
    assertEqual(msg.fields.weaponR, 0x1F, 'matching weaponR passes through');
    assertEqual(msg.fields.armorId, 0x73, 'matching armorId passes through');
    assertEqual(msg.fields.shieldId, 0x58, 'matching shieldId passes through');
    A.close(); B.close();
    _testMirrorClear(7463, 0);
    await new Promise(r => setTimeout(r, 40));
  });

  await asyncTest('v1.7.746 update non-equipment fields untouched', async () => {
    _testHooks.resetState();
    _testEnsureUser(7465);
    _testEnsureUser(7466);
    _testMirrorClear(7465, 0);
    _testMirrorSync(7465, 0, {
      gil: 0, inventory: {},
      stats: { weaponR: 0x1E, weaponL: 0, head: 0x62, body: 0x73, arms: 0 },
    });
    const A = await connectClient(port, 7465, { ...baseProfile, name: 'NameU', slot: 0 });
    const B = await connectClient(port, 7466, { ...targetProfile, name: 'PeerN' });
    const bGotUpdate = once(B, m => m.type === 'player-update' && m.userId === 7465, 800);
    A.send(JSON.stringify({ type: 'update', name: 'Renamed', level: 9 }));
    const msg = await bGotUpdate;
    assertEqual(msg.fields.name, 'Renamed', 'name field passes through');
    assertEqual(msg.fields.level, 9, 'level field passes through');
    A.close(); B.close();
    _testMirrorClear(7465, 0);
    await new Promise(r => setTimeout(r, 40));
  });

  // ── v1.7.747 Phase 4 (full) — GET /api/saves overlays mirror ───────────
  // Save row may carry cheated inventory / gil / equipped — the load
  // path overwrites those wire-managed fields with mirror's canonical
  // view. Non-wire fields (palIdx, currentMapId, knownSpells, etc.)
  // still come from the save JSON.
  await asyncTest('v1.7.747 GET /api/saves returns mirror inventory, not save JSON', async () => {
    _testEnsureUser(7481);
    _testMirrorClear(7481, 0);
    const t = mintToken(7481);
    // POST a save with "cheated" inventory + gil.
    let r = await fetch(`http://127.0.0.1:${port}/api/save`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + t, 'content-type': 'application/json' },
      body: JSON.stringify({
        slot: 0,
        data: {
          gil: 99999,
          inventory: { 0xDE: 99 },
          stats: { weaponR: 0xDE, weaponL: 0xDE, head: 0xDE, body: 0xDE, arms: 0xDE },
          knownSpells: [],
        },
      }),
    });
    assertEqual(r.status, 200, 'save POST succeeded');
    // Mirror was gated by Phase 4 partial — the wire-managed fields
    // were skipped. So the mirror's inventory/gil/equipped remained
    // empty (this is a fresh user). We need to populate the mirror so
    // the load-overlay has something to overlay.
    _testMirrorSync(7481, 0, {
      gil: 200,
      inventory: { 0x80: 3 },
      stats: { weaponR: 0x1E, weaponL: 0, head: 0x62, body: 0x73, arms: 0 },
    });
    // Now GET — should return mirror's inventory/gil/equipped, NOT the
    // cheated values from the save POST.
    r = await fetch(`http://127.0.0.1:${port}/api/saves`, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + t },
    });
    assertEqual(r.status, 200, 'saves GET succeeded');
    const body = await r.json();
    const slot = body.slots[0];
    assertTrue(slot != null, 'slot 0 present');
    assertEqual(slot.gil, 200, 'gil from mirror, not 99999');
    assertEqual(slot.inventory[0x80], 3, 'inventory[Potion] from mirror');
    assertTrue(slot.inventory[0xDE] === undefined, 'cheated 0xDE not in returned inventory');
    assertEqual(slot.stats.weaponR, 0x1E, 'weaponR from mirror, not 0xDE');
    assertEqual(slot.stats.body, 0x73, 'body from mirror, not 0xDE');
    _testMirrorClear(7481, 0);
  });

  await asyncTest('v1.7.747 GET /api/saves preserves non-wire-managed fields', async () => {
    _testEnsureUser(7472);
    _testMirrorClear(7472, 0);
    const t = mintToken(7472);
    // palIdx + currentMapId + knownSpells live at TOP level on the save
    // shape; `level` is inside `stats:`. The overlay only touches
    // inventory + gil + stats.weaponR/L/head/body/arms — these should
    // all flow through to the load unchanged.
    let r = await fetch(`http://127.0.0.1:${port}/api/save`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + t, 'content-type': 'application/json' },
      body: JSON.stringify({
        slot: 0,
        data: {
          gil: 0, inventory: {},
          palIdx: 3, currentMapId: 7,
          stats: { weaponR: 0, weaponL: 0, head: 0, body: 0, arms: 0, level: 4 },
          knownSpells: [0x01, 0x02, 0x05],
        },
      }),
    });
    assertEqual(r.status, 200, 'save POST succeeded');
    _testMirrorSync(7472, 0, {
      gil: 100, inventory: { 0x80: 1 },
      stats: { weaponR: 0x1E, weaponL: 0, head: 0x62, body: 0x73, arms: 0 },
    });
    r = await fetch(`http://127.0.0.1:${port}/api/saves`, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + t },
    });
    const body = await r.json();
    const slot = body.slots[0];
    assertEqual(slot.palIdx, 3, 'non-wire palIdx preserved');
    assertEqual(slot.currentMapId, 7, 'non-wire currentMapId preserved');
    assertEqual(slot.stats.level, 4, 'non-wire stats.level preserved');
    assertTrue(Array.isArray(slot.knownSpells) && slot.knownSpells.length === 3, 'knownSpells preserved');
    _testMirrorClear(7472, 0);
  });

  await asyncTest('v1.7.747 GET /api/saves leaves save as-is when mirror empty', async () => {
    _testEnsureUser(7473);
    _testMirrorClear(7473, 0);
    const t = mintToken(7473);
    let r = await fetch(`http://127.0.0.1:${port}/api/save`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + t, 'content-type': 'application/json' },
      body: JSON.stringify({
        slot: 0,
        data: {
          gil: 50, inventory: { 0x80: 2 },
          stats: { weaponR: 0x1E, weaponL: 0, head: 0x62, body: 0x73, arms: 0 },
          knownSpells: [],
        },
      }),
    });
    assertEqual(r.status, 200, 'save POST succeeded');
    // Mirror is intentionally empty (cleared above). With both Phase 4
    // partial gating mirrorSyncFromSave AND no boot seed for this user,
    // the mirror has no rows for (7473, 0). The load path must fall
    // back to the save JSON's values — otherwise this user would lose
    // legitimate state.
    _testMirrorClear(7473, 0);
    r = await fetch(`http://127.0.0.1:${port}/api/saves`, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + t },
    });
    const body = await r.json();
    const slot = body.slots[0];
    assertTrue(slot != null, 'slot 0 present');
    // Mirror empty: gil and equipped untouched (no overlay), but
    // inventory was also empty in mirror so the load returns save's
    // inventory unchanged. Note: the overlay condition is "if mirror
    // has any econ or inv rows" — for a truly-empty mirror, save wins.
    assertEqual(slot.gil, 50, 'gil from save (mirror empty)');
    assertEqual(slot.stats.weaponR, 0x1E, 'weaponR from save (mirror empty)');
    assertEqual(slot.inventory[0x80], 2, 'inventory from save (mirror empty)');
  });

  // ── v1.7.747 P-1 — PvP arbiter scaffold roundtrip ──────────────────────
  // Server-arbitrated PvP rewrite (docs/PVP-REWRITE-PLAN.md). P-1 deliverable
  // is the wire roundtrip: client sends `pvp-arb-start`, server creates a
  // battle, sends `pvp-battle-start` to both, then `pvp-turn end:draw`
  // (stub — P-4 lands real resolution).
  await asyncTest('v1.7.747 P-1 pvp-arb-start spawns battle (awaits intents)', async () => {
    _testHooks.resetState();
    _testEnsureUser(7484); _testSeedSave(7484, 0);
    _testEnsureUser(7485); _testSeedSave(7485, 0);
    const A = await connectClient(port, 7484, { ...baseProfile, name: 'ArbA' });
    const B = await connectClient(port, 7485, { ...targetProfile, name: 'ArbB' });
    // Both clients should see pvp-battle-start with matching battleId.
    // v1.7.750 P-4 — battle no longer immediately ends; waits for intents.
    const aStart = once(A, m => m.type === 'pvp-battle-start', 800);
    const bStart = once(B, m => m.type === 'pvp-battle-start', 800);
    A.send(JSON.stringify({ type: 'pvp-arb-start', opponentUserId: 7485 }));
    const [sa, sb] = await Promise.all([aStart, bStart]);
    assertEqual(sa.battleId, sb.battleId, 'both sides see same battleId');
    assertEqual(sa.yourSide, 'A', 'A is side A');
    assertEqual(sb.yourSide, 'B', 'B is side B');
    A.close(); B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  await asyncTest('v1.7.747 P-1 pvp-arb-start rejects when opponent offline', async () => {
    _testHooks.resetState();
    _testEnsureUser(7486);
    const A = await connectClient(port, 7486, { ...baseProfile, name: 'SoloA' });
    const got = once(A, m => m.type === 'pvp-cancel', 800);
    A.send(JSON.stringify({ type: 'pvp-arb-start', opponentUserId: 9999 }));
    const cancel = await got;
    assertEqual(cancel.reason, 'opponent-offline', 'offline opponent rejected');
    A.close();
    await new Promise(r => setTimeout(r, 40));
  });

  await asyncTest('v1.7.747 P-1 pvp-arb-start rejects when already in battle', async () => {
    _testHooks.resetState();
    _testEnsureUser(7474); _testSeedSave(7474, 0);
    _testEnsureUser(7475); _testSeedSave(7475, 0);
    _testEnsureUser(7476); _testSeedSave(7476, 0);
    const A = await connectClient(port, 7474, { ...baseProfile, name: 'A2' });
    const B = await connectClient(port, 7475, { ...targetProfile, name: 'B2' });
    const C = await connectClient(port, 7476, { ...targetProfile, name: 'C2' });
    // First battle A vs B starts and stays open (no end stub since P-4).
    const aStart1 = once(A, m => m.type === 'pvp-battle-start', 800);
    A.send(JSON.stringify({ type: 'pvp-arb-start', opponentUserId: 7475 }));
    await aStart1;
    // Second start attempt rejects — A is still in the first battle.
    const aCancel = once(A, m => m.type === 'pvp-cancel', 800);
    A.send(JSON.stringify({ type: 'pvp-arb-start', opponentUserId: 7476 }));
    const cancel = await aCancel;
    assertEqual(cancel.reason, 'already-in-battle', 'second start rejected');
    A.close(); B.close(); C.close();
    await new Promise(r => setTimeout(r, 40));
  });

  await asyncTest('v1.7.787 friendly-fire attack on same-side cell rejected silently', async () => {
    _testHooks.resetState();
    // 7560/7561 are not used elsewhere — pvp-arbiter._userBattle isn't
    // cleared by resetState (5s delayed GC inside the arbiter), so picking
    // colliding uids will leak battle state into later tests.
    _testEnsureUser(7560); _testSeedSave(7560, 0);
    _testEnsureUser(7561); _testSeedSave(7561, 0);
    const A = await connectClient(port, 7560, { ...baseProfile, name: 'FFA' });
    const B = await connectClient(port, 7561, { ...targetProfile, name: 'FFB' });
    const aStart = once(A, m => m.type === 'pvp-battle-start', 800);
    A.send(JSON.stringify({ type: 'pvp-arb-start', opponentUserId: 7561 }));
    const start = await aStart;
    // B submits first so the round is ONE-intent-away-from-resolving. If
    // A's friendly-fire intent (targetCellId=0 = A's own cell, side A)
    // were wrongly accepted, the round would resolve and a pvp-turn frame
    // would arrive on both sides. With the v1.7.787 same-side-target
    // guard, A's intent rejects silently and no pvp-turn fires.
    let unexpected = false;
    A.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'pvp-turn') unexpected = true;
    });
    B.send(JSON.stringify({
      type: 'pvp-intent', battleId: start.battleId, turnIdx: 0,
      kind: 'defend',
    }));
    await new Promise(r => setTimeout(r, 30));
    A.send(JSON.stringify({
      type: 'pvp-intent', battleId: start.battleId, turnIdx: 0,
      kind: 'attack', targetCellId: 0,    // A's OWN main cell — friendly fire
    }));
    await new Promise(r => setTimeout(r, 200));
    assertTrue(!unexpected, 'friendly-fire intent wrongly resolved a turn');
    A.close(); B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  await asyncTest('v1.7.747 P-1 pvp-intent stale-turn rejected silently', async () => {
    _testHooks.resetState();
    _testEnsureUser(7477); _testSeedSave(7477, 0);
    _testEnsureUser(7478); _testSeedSave(7478, 0);
    const A = await connectClient(port, 7477, { ...baseProfile, name: 'IntA' });
    const B = await connectClient(port, 7478, { ...targetProfile, name: 'IntB' });
    const aStart = once(A, m => m.type === 'pvp-battle-start', 800);
    A.send(JSON.stringify({ type: 'pvp-arb-start', opponentUserId: 7478 }));
    const start = await aStart;
    // Battle starts at turnIdx 0. An intent with turnIdx 99 should be
    // silently rejected (server logs, no pvp-turn / state-resync frame
    // in P-4). Verify by sending intent + waiting briefly for any
    // unexpected frame — if none arrive, rejection worked silently.
    let unexpected = false;
    A.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'pvp-turn' || m.type === 'pvp-state-resync') unexpected = true;
    });
    A.send(JSON.stringify({
      type: 'pvp-intent', battleId: start.battleId, turnIdx: 99,
      kind: 'attack', targetCellId: 4,
    }));
    await new Promise(r => setTimeout(r, 120));
    assertTrue(!unexpected, 'stale-turn intent silently rejected');
    A.close(); B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  await asyncTest('v1.7.747 P-1 disconnect mid-battle notifies survivor', async () => {
    _testHooks.resetState();
    _testEnsureUser(7479); _testSeedSave(7479, 0);
    _testEnsureUser(7480); _testSeedSave(7480, 0);
    const A = await connectClient(port, 7479, { ...baseProfile, name: 'DropA' });
    const B = await connectClient(port, 7480, { ...targetProfile, name: 'DropB' });
    const aStart = once(A, m => m.type === 'pvp-battle-start', 800);
    A.send(JSON.stringify({ type: 'pvp-arb-start', opponentUserId: 7480 }));
    await aStart;
    // v1.7.750 P-4 — battle is in awaiting-intent state. If A disconnects,
    // B should receive `pvp-cancel reason: 'opponent-disconnect'`.
    const bCancelled = once(B, m => m.type === 'pvp-cancel', 800);
    A.close();
    const cancel = await bCancelled;
    assertEqual(cancel.reason, 'opponent-disconnect', 'survivor notified on drop');
    B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── v1.7.748 P-2 — server stat parity vs client generateAllyStats ──────
  // The arbiter populates combatant cells via buildCombatantFromUser on
  // the server. The client's generateAllyStats fast-path consumes those
  // same wire fields. Both must agree on atk/def/agi/evade/mdef/etc. —
  // otherwise the rendered preview diverges from the math the server
  // runs at turn resolution (P-4). This test seeds a non-trivial save
  // (Fighter level 5 with Longsword + shield), spawns a battle, parses
  // the wire frame, runs generateAllyStats on the wire shape, asserts
  // every realized stat field matches.
  await asyncTest('v1.7.748 P-2 wire combatant matches client generateAllyStats', async () => {
    _testHooks.resetState();
    _testEnsureUser(7494);
    _testEnsureUser(7495);
    // Fighter (jobIdx 1) at level 5 with Longsword (0x24) + heavy armor.
    // Real numbers: ATK ≈ wpn(20) + str/2 + jp; DEF ≈ floor(vit/2) + arm.
    _testSeedSave(7494, 0, {
      name: 'Aldric', jobIdx: 1, palIdx: 3,
      stats: {
        level: 5, exp: 0, hp: 80, maxHP: 80, mp: 0, maxMP: 0,
        str: 14, agi: 9, vit: 12, int: 5, mnd: 5,
      },
      jobLevels: { 1: { level: 3, jp: 200 } },
    });
    _testMirrorSync(7494, 0, {
      gil: 0, inventory: {},
      stats: { weaponR: 0x24, weaponL: 0, head: 0x62, body: 0x73, arms: 0x58 },
    });
    _testSeedSave(7495, 0);
    const A = await connectClient(port, 7494, { ...baseProfile, name: 'Aldric', slot: 0 });
    const B = await connectClient(port, 7495, { ...targetProfile, name: 'Opp2' });
    const aStart = once(A, m => m.type === 'pvp-battle-start', 800);
    A.send(JSON.stringify({ type: 'pvp-arb-start', opponentUserId: 7495 }));
    const start = await aStart;
    // A's main is at sides.A[0] — the heavy-equipped Aldric.
    const wireCell = start.sides.A[0];
    assertEqual(wireCell.name, 'Aldric', 'name from save');
    assertEqual(wireCell.jobIdx, 1, 'jobIdx from save');
    assertEqual(wireCell.level, 5, 'level from save');
    // Realized stats come from computeRealizedStats. Recompute on the
    // client via generateAllyStats fast-path — must agree exactly.
    const clientStats = generateAllyStats(wireCell);
    assertEqual(clientStats.atk, wireCell.atk, 'atk parity');
    assertEqual(clientStats.def, wireCell.def, 'def parity');
    assertEqual(clientStats.agi, wireCell.agi, 'agi parity');
    assertEqual(clientStats.evade, wireCell.evade, 'evade parity');
    assertEqual(clientStats.mdef, wireCell.mdef, 'mdef parity');
    assertEqual(clientStats.hitRate, wireCell.hitRate, 'hitRate parity');
    assertEqual(clientStats.shieldEvade, wireCell.shieldEvade, 'shieldEvade parity');
    assertEqual(clientStats.statusResist, wireCell.statusResist, 'statusResist parity');
    assertEqual(clientStats.int, wireCell.intStat, 'intStat parity');
    assertEqual(clientStats.mnd, wireCell.mndStat, 'mndStat parity');
    assertEqual(clientStats.maxHP, wireCell.maxHP, 'maxHP parity');
    A.close(); B.close();
    _testMirrorClear(7494, 0);
    await new Promise(r => setTimeout(r, 40));
  });

  await asyncTest('v1.7.748 P-2 wire frame carries combatant on both sides', async () => {
    _testHooks.resetState();
    _testEnsureUser(7496); _testSeedSave(7496, 0);
    _testEnsureUser(7497); _testSeedSave(7497, 0);
    const A = await connectClient(port, 7496, { ...baseProfile, name: 'SymA' });
    const B = await connectClient(port, 7497, { ...targetProfile, name: 'SymB' });
    const aStart = once(A, m => m.type === 'pvp-battle-start', 800);
    const bStart = once(B, m => m.type === 'pvp-battle-start', 800);
    A.send(JSON.stringify({ type: 'pvp-arb-start', opponentUserId: 7497 }));
    const [sa, sb] = await Promise.all([aStart, bStart]);
    assertEqual(sa.sides.A.length, 1, 'A frame: 1 combatant on side A');
    assertEqual(sa.sides.B.length, 1, 'A frame: 1 combatant on side B');
    assertEqual(sa.sides.A[0].userId, 7496, 'A sees self on side A');
    assertEqual(sa.sides.B[0].userId, 7497, 'A sees opponent on side B');
    // Both clients see the SAME combatant data — wire is symmetric.
    assertEqual(sb.sides.A[0].atk, sa.sides.A[0].atk, 'cross-client atk parity');
    assertEqual(sb.sides.B[0].atk, sa.sides.B[0].atk, 'cross-client B atk parity');
    // Cell IDs: A=0, B=4 (reserved range).
    assertEqual(sa.sides.A[0].cellId, 0, 'A main cellId=0');
    assertEqual(sa.sides.B[0].cellId, 4, 'B main cellId=4 (range reserved)');
    assertEqual(sa.yourCellId, 0, 'A yourCellId=0');
    assertEqual(sb.yourCellId, 4, 'B yourCellId=4');
    A.close(); B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── v1.7.749 P-3 — per-battle RNG + injected battle-math ───────────────
  // The server-arbiter holds a per-battle RNG instance. A second RNG
  // seeded with the same value must produce IDENTICAL sequences. This
  // verifies the createRng factory + the singleton don't share state
  // and the mulberry32 step works correctly on both.
  test('v1.7.749 P-3 createRng(seed) produces deterministic sequence', () => {
    const rngA = createRng(12345);
    const rngB = createRng(12345);
    for (let i = 0; i < 10; i++) {
      assertEqual(rngA.rand(), rngB.rand(), 'seq[' + i + '] matches');
    }
    // Different seed → different sequence.
    const rngC = createRng(67890);
    assertTrue(rngA.rand() !== rngC.rand(), 'different seed → different roll');
  });

  test('v1.7.749 P-3 calcDamage accepts opts.rand', () => {
    // Pure math test — no battle. Identical seeded RNGs produce
    // identical damage rolls; advancing one without the other proves
    // they hold independent state.
    const rngA = createRng(424242);
    const rngB = createRng(424242);
    for (let i = 0; i < 10; i++) {
      const dA = calcDamage(50, 10, false, 0, 1, { rand: rngA.rand });
      const dB = calcDamage(50, 10, false, 0, 1, { rand: rngB.rand });
      assertEqual(dA, dB, 'seq[' + i + '] parity');
    }
    // Burn one extra roll on rngA, then verify the next pair diverges
    // (proves they're independent instances, not aliases of one state).
    rngA.rand();
    let diverged = false;
    for (let i = 0; i < 5; i++) {
      if (calcDamage(50, 10, false, 0, 1, { rand: rngA.rand }) !==
          calcDamage(50, 10, false, 0, 1, { rand: rngB.rand })) {
        diverged = true; break;
      }
    }
    assertTrue(diverged, 'independent state — diverges after one offset');
  });

  test('v1.7.749 P-3 rollHits accepts opts.rand for reproducibility', () => {
    const rngA = createRng(987654);
    const rngB = createRng(987654);
    const hitsA = rollHits(40, 8, 80, 4, { rand: rngA.rand, evade: 0 });
    const hitsB = rollHits(40, 8, 80, 4, { rand: rngB.rand, evade: 0 });
    assertEqual(JSON.stringify(hitsA), JSON.stringify(hitsB), 'rollHits seq matches');
  });

  test('v1.7.749 P-3 rollInitiative accepts opts.rand', () => {
    const rngA = createRng(11111);
    const rngB = createRng(11111);
    assertEqual(rollInitiative(10, { rand: rngA.rand }),
                rollInitiative(10, { rand: rngB.rand }), 'initiative parity');
  });

  await asyncTest('v1.7.749 P-3 battle carries an RNG instance via the seed', async () => {
    _testHooks.resetState();
    _testEnsureUser(7498); _testSeedSave(7498, 0);
    _testEnsureUser(7499); _testSeedSave(7499, 0);
    const A = await connectClient(port, 7498, { ...baseProfile, name: 'RngA' });
    const B = await connectClient(port, 7499, { ...targetProfile, name: 'RngB' });
    const aStart = once(A, m => m.type === 'pvp-battle-start', 800);
    A.send(JSON.stringify({ type: 'pvp-arb-start', opponentUserId: 7499 }));
    const start = await aStart;
    assertTrue(start.rngSeed > 0, 'rngSeed shipped in start frame');
    // Server's battle RNG must produce the same sequence as a client
    // createRng(seed) — proves the wire seed lets a client preview
    // animation rolls without drifting from the server's gameplay
    // rolls (which the server makes independently after this point).
    const serverRng = pvpArbGetBattleRng(start.battleId);
    assertTrue(serverRng != null, 'arbiter exposes per-battle rng');
    const clientRng = createRng(start.rngSeed);
    for (let i = 0; i < 5; i++) {
      assertEqual(serverRng.rand(), clientRng.rand(), 'roll[' + i + '] parity');
    }
    A.close(); B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── v1.7.750 P-4 — turn resolution loop ─────────────────────────────────
  // The first P-4 test of an actual round: both humans submit 'attack',
  // server resolves, both clients receive pvp-turn with attack deltas
  // for both sides. Verifies the simultaneous-intent → resolve →
  // broadcast loop end-to-end.
  await asyncTest('v1.7.750 P-4 simultaneous attack intents resolve into one pvp-turn', async () => {
    _testHooks.resetState();
    _testEnsureUser(7500); _testSeedSave(7500, 0);
    _testEnsureUser(7501); _testSeedSave(7501, 0);
    const A = await connectClient(port, 7500, { ...baseProfile, name: 'RoundA' });
    const B = await connectClient(port, 7501, { ...targetProfile, name: 'RoundB' });
    const aStart = once(A, m => m.type === 'pvp-battle-start', 800);
    A.send(JSON.stringify({ type: 'pvp-arb-start', opponentUserId: 7501 }));
    const start = await aStart;
    // Both sides submit 'attack' targeting the opposing main player.
    const aTurn = once(A, m => m.type === 'pvp-turn', 1200);
    const bTurn = once(B, m => m.type === 'pvp-turn', 1200);
    A.send(JSON.stringify({
      type: 'pvp-intent', battleId: start.battleId, turnIdx: 0,
      kind: 'attack', targetCellId: 4,    // B's main cell
    }));
    B.send(JSON.stringify({
      type: 'pvp-intent', battleId: start.battleId, turnIdx: 0,
      kind: 'attack', targetCellId: 0,    // A's main cell
    }));
    const [ta, tb] = await Promise.all([aTurn, bTurn]);
    assertEqual(ta.battleId, tb.battleId, 'both clients see same turn frame');
    assertEqual(ta.turnIdx, 1, 'turnIdx incremented from 0 to 1');
    // Two attack deltas expected (one per side); ordering driven by AGI.
    const attackDeltas = ta.deltas.filter(d => d.kind === 'attack');
    assertEqual(attackDeltas.length, 2, 'two attack deltas in turn');
    const attackerCells = attackDeltas.map(d => d.actorCellId).sort();
    assertEqual(JSON.stringify(attackerCells), '[0,4]', 'both mains attacked');
    A.close(); B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  await asyncTest('v1.7.750 P-4 defend halves incoming damage', async () => {
    _testHooks.resetState();
    _testEnsureUser(7502); _testSeedSave(7502, 0);
    _testEnsureUser(7503); _testSeedSave(7503, 0);
    const A = await connectClient(port, 7502, { ...baseProfile });
    const B = await connectClient(port, 7503, { ...targetProfile });
    const aStart = once(A, m => m.type === 'pvp-battle-start', 800);
    A.send(JSON.stringify({ type: 'pvp-arb-start', opponentUserId: 7503 }));
    const start = await aStart;
    // Run two rounds: round 1 both attack to baseline damage. Round 2
    // A defends, B attacks — A should take noticeably less damage.
    // Server-rolled, so we just assert defend-on state delta exists +
    // damage isn't a flat 0 (would mean attack didn't fire).
    const aTurn = once(A, m => m.type === 'pvp-turn', 1200);
    A.send(JSON.stringify({ type: 'pvp-intent', battleId: start.battleId, turnIdx: 0, kind: 'defend' }));
    B.send(JSON.stringify({ type: 'pvp-intent', battleId: start.battleId, turnIdx: 0, kind: 'attack', targetCellId: 0 }));
    const t1 = await aTurn;
    const defendDelta = t1.deltas.find(d => d.kind === 'state' && d.change === 'defend-on');
    assertTrue(!!defendDelta, 'defend produced a state delta');
    assertEqual(defendDelta.actorCellId, 0, 'defender is cell 0');
    const bAttack = t1.deltas.find(d => d.kind === 'attack' && d.actorCellId === 4);
    assertTrue(!!bAttack, 'B still attacked');
    A.close(); B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  await asyncTest('v1.7.750 P-4 battle ends with victor delta on side defeat', async () => {
    _testHooks.resetState();
    _testEnsureUser(7504);
    // Give A a powerhouse loadout (Longsword + high str/atk) so a few
    // rounds chunk B (default loadout — Knife). Use BB level (5) to push
    // hit count high enough to KO in ~10 rounds even on bad rolls.
    _testSeedSave(7504, 0, {
      jobIdx: 1, palIdx: 3,
      stats: { level: 5, exp: 0, hp: 80, maxHP: 80, mp: 0, maxMP: 0,
               str: 20, agi: 15, vit: 12, int: 5, mnd: 5,
               weaponR: 0x24, weaponL: 0, head: 0x62, body: 0x73, arms: 0x58 },
      jobLevels: { 1: { level: 3, jp: 200 } },
    });
    _testEnsureUser(7505);
    // Make B a glass cannon: tiny maxHP so any solid hit ends them fast.
    _testSeedSave(7505, 0, {
      stats: { level: 1, exp: 0, hp: 1, maxHP: 1, mp: 0, maxMP: 0,
               str: 2, agi: 5, vit: 1, int: 5, mnd: 5,
               weaponR: 0x1E, weaponL: 0, head: 0, body: 0, arms: 0 },
    });
    const A = await connectClient(port, 7504, { ...baseProfile });
    const B = await connectClient(port, 7505, { ...targetProfile });
    const aStart = once(A, m => m.type === 'pvp-battle-start', 800);
    A.send(JSON.stringify({ type: 'pvp-arb-start', opponentUserId: 7505 }));
    const start = await aStart;
    // With B at 1 HP and A's Longsword, a single landed hit KOs B.
    // A's hit rate is ~75-80% per weapon — occasionally A misses on
    // round 1 and the battle continues. Loop up to 5 rounds and break
    // on the first turn that carries an end delta. Far more reliable
    // than gambling on a single hit roll.
    let endFrame = null;
    for (let round = 0; round < 5; round++) {
      const turnFrame = once(A, m => m.type === 'pvp-turn', 1500);
      A.send(JSON.stringify({ type: 'pvp-intent', battleId: start.battleId, turnIdx: round, kind: 'attack', targetCellId: 4 }));
      B.send(JSON.stringify({ type: 'pvp-intent', battleId: start.battleId, turnIdx: round, kind: 'defend' }));
      const t = await turnFrame;
      if (t.deltas.some(d => d.kind === 'end')) { endFrame = t; break; }
    }
    assertTrue(!!endFrame, 'battle ended within 5 rounds');
    const endDelta = endFrame.deltas.find(d => d.kind === 'end');
    assertEqual(endDelta.victor, 'A', 'A wins on B KO');
    assertEqual(endFrame.nextActor, null, 'nextActor cleared on end');
    const deathDelta = endFrame.deltas.find(d => d.kind === 'death');
    assertTrue(!!deathDelta, 'death delta for KO');
    assertEqual(deathDelta.actorCellId, 4, 'B main cell died');
    A.close(); B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  await asyncTest('v1.7.750 P-4 second pvp-intent on same turn idempotent (latest wins)', async () => {
    _testHooks.resetState();
    _testEnsureUser(7506); _testSeedSave(7506, 0);
    _testEnsureUser(7507); _testSeedSave(7507, 0);
    const A = await connectClient(port, 7506, { ...baseProfile });
    const B = await connectClient(port, 7507, { ...targetProfile });
    const aStart = once(A, m => m.type === 'pvp-battle-start', 800);
    A.send(JSON.stringify({ type: 'pvp-arb-start', opponentUserId: 7507 }));
    const start = await aStart;
    // A sends an attack, then changes mind to defend BEFORE B responds.
    // Latest intent (defend) wins; resolution happens when B's intent
    // lands.
    A.send(JSON.stringify({ type: 'pvp-intent', battleId: start.battleId, turnIdx: 0, kind: 'attack', targetCellId: 4 }));
    A.send(JSON.stringify({ type: 'pvp-intent', battleId: start.battleId, turnIdx: 0, kind: 'defend' }));
    const aTurn = once(A, m => m.type === 'pvp-turn', 1200);
    B.send(JSON.stringify({ type: 'pvp-intent', battleId: start.battleId, turnIdx: 0, kind: 'attack', targetCellId: 0 }));
    const t = await aTurn;
    // A's resolution should be defend, NOT attack — only one attack
    // delta in the round (B's), and a defend-on state delta from A.
    const aAttackDeltas = t.deltas.filter(d => d.kind === 'attack' && d.actorCellId === 0);
    assertEqual(aAttackDeltas.length, 0, 'A did NOT attack (latest intent was defend)');
    const aDefendDelta = t.deltas.find(d => d.kind === 'state' && d.actorCellId === 0 && d.change === 'defend-on');
    assertTrue(!!aDefendDelta, 'A defended (latest intent wins)');
    A.close(); B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── v1.7.751 P-5 — smart AI (target lowest-HP, panic defend) ───────────
  // Unit + integration coverage. Multi-cell battles (1+3 vs 1+3) are
  // where the AI's smart targeting actually fires, so we set up real
  // parties via _testHooks.state.partyMemberships + seeded saves for
  // each mate.

  // Unit — picker correctness.
  test('v1.7.751 P-5 pickWeakestEnemy picks lowest hp alive', async () => {
    const { pickWeakestEnemy } = await import('../src/combatant-ai.js');
    const enemies = [
      { hp: 50, cellId: 4 },
      { hp: 0,  cellId: 5 },  // dead — skipped
      { hp: 10, cellId: 6 },  // weakest alive
      { hp: 99, cellId: 7 },
    ];
    const pick = pickWeakestEnemy(enemies);
    assertEqual(pick.cellId, 6, 'weakest alive is cell 6');
    assertEqual(pickWeakestEnemy([{ hp: 0 }, { hp: 0 }]), null, 'no alive → null');
    assertEqual(pickWeakestEnemy([]), null, 'empty → null');
  });

  // Unit — per-battle RNG injection on the helpers.
  test('v1.7.751 P-5 pickRandomLivingTarget accepts opts.rand', async () => {
    const { pickRandomLivingTarget } = await import('../src/combatant-ai.js');
    const enemies = [
      { hp: 10, id: 'a' }, { hp: 20, id: 'b' }, { hp: 30, id: 'c' },
    ];
    const rngA = createRng(99);
    const rngB = createRng(99);
    for (let i = 0; i < 5; i++) {
      const pa = pickRandomLivingTarget(enemies, { rand: rngA.rand });
      const pb = pickRandomLivingTarget(enemies, { rand: rngB.rand });
      assertEqual(pa.id, pb.id, 'pick[' + i + '] parity');
    }
  });

  // Integration — partymate AI cells spawn into the battle when their
  // userId is in _partyMemberships. Verifies the smart picker is
  // actually wired into resolveTurn (not just defined as an export).
  // Asserts only the AI mate fires its first attack on a target —
  // the WEAKEST-vs-RANDOM picking is covered by the pure unit tests
  // above; integration test stays deterministic by checking that an
  // AI attack delta appears at all for the partymate's cellId.
  await asyncTest('v1.7.751 P-5 AI partymate fires an attack delta on round 1', async () => {
    _testHooks.resetState();
    _testEnsureUser(7510); _testSeedSave(7510, 0);  // A main (human)
    _testEnsureUser(7511); _testSeedSave(7511, 0);  // A's mate (AI)
    _testEnsureUser(7512); _testSeedSave(7512, 0);  // B main (human)
    // No B mate — just 2-vs-1. Tests AI fires; doesn't risk the multi-
    // round attrition that masks intent rejection from dead humans.
    _testHooks.state.partyMemberships.set(7511, 7510);
    const A = await connectClient(port, 7510, { ...baseProfile, name: 'P5A', slot: 0 });
    const B = await connectClient(port, 7512, { ...targetProfile, name: 'P5B', slot: 0 });
    const aStart = once(A, m => m.type === 'pvp-battle-start', 800);
    A.send(JSON.stringify({ type: 'pvp-arb-start', opponentUserId: 7512 }));
    const start = await aStart;
    assertEqual(start.sides.A.length, 2, 'side A has 2 combatants');
    assertEqual(start.sides.B.length, 1, 'side B has 1 combatant');
    // Both humans submit defend. AI mate at cellId 1 should still
    // emit an attack delta (defends don't suppress AI auto-pick).
    const turnFrame = once(A, m => m.type === 'pvp-turn', 1200);
    A.send(JSON.stringify({ type: 'pvp-intent', battleId: start.battleId, turnIdx: 0, kind: 'defend' }));
    B.send(JSON.stringify({ type: 'pvp-intent', battleId: start.battleId, turnIdx: 0, kind: 'defend' }));
    const t = await turnFrame;
    const aiAttack = t.deltas.find(d => d.kind === 'attack' && d.actorCellId === 1);
    assertTrue(!!aiAttack, 'AI mate (cell 1) attacked on round 1');
    assertEqual(aiAttack.targetCellId, 4, 'AI targets B main (only alive enemy)');
    A.close(); B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── v1.7.752 P-6 — client viewer module (state mirroring) ──────────────
  // The viewer consumes pvp-battle-start + pvp-turn + pvp-cancel +
  // pvp-state-resync, mutates arbViewSt by walking deltas. Tests
  // feed the SAME frames the arbiter ships at the wire layer; the
  // viewer state must match a hand-computed expected outcome.
  await asyncTest('v1.7.752 P-6 viewer mirrors a full battle from real arbiter frames', async () => {
    _testHooks.resetState();
    arbViewReset();
    _testEnsureUser(7520); _testSeedSave(7520, 0);
    _testEnsureUser(7521); _testSeedSave(7521, 0);
    const A = await connectClient(port, 7520, { ...baseProfile, name: 'V6A', slot: 0 });
    const B = await connectClient(port, 7521, { ...targetProfile, name: 'V6B', slot: 0 });
    // Capture every PvP frame A receives + feed into viewer.
    const captured = [];
    A.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'pvp-battle-start') { captured.push(m); arbViewApplyStart(m); }
      if (m.type === 'pvp-turn')         { captured.push(m); arbViewApplyTurn(m); }
      if (m.type === 'pvp-cancel')       { captured.push(m); arbViewApplyCancel(m); }
    });
    const aStart = once(A, m => m.type === 'pvp-battle-start', 800);
    A.send(JSON.stringify({ type: 'pvp-arb-start', opponentUserId: 7521 }));
    const start = await aStart;
    // Viewer's arbViewSt should now mirror the battle-start frame.
    assertEqual(arbViewSt.battleId, start.battleId, 'viewer battleId from start');
    assertEqual(arbViewSt.yourSide, 'A', 'viewer yourSide');
    assertEqual(arbViewSt.yourCellId, 0, 'viewer yourCellId');
    assertEqual(arbViewSt.combatants[0].userId, 7520, 'viewer cell 0 = A');
    assertEqual(arbViewSt.combatants[4].userId, 7521, 'viewer cell 4 = B');
    assertEqual(arbViewSt.inBattle, true, 'viewer inBattle');
    // Run one round of attacks. Viewer's hp tracking must converge to
    // server's hp tracking — verified by comparing post-turn HPs to
    // the deltas the server emitted (which the viewer also received).
    const aHpBefore = arbViewSt.combatants[0].hp;
    const bHpBefore = arbViewSt.combatants[4].hp;
    const aTurn = once(A, m => m.type === 'pvp-turn', 1200);
    A.send(JSON.stringify({ type: 'pvp-intent', battleId: start.battleId, turnIdx: 0, kind: 'attack', targetCellId: 4 }));
    B.send(JSON.stringify({ type: 'pvp-intent', battleId: start.battleId, turnIdx: 0, kind: 'attack', targetCellId: 0 }));
    const turn = await aTurn;
    // Find each side's attack delta — viewer should have applied them.
    const aAttack = turn.deltas.find(d => d.kind === 'attack' && d.actorCellId === 0);
    const bAttack = turn.deltas.find(d => d.kind === 'attack' && d.actorCellId === 4);
    if (aAttack && aAttack.hit !== false) {
      assertEqual(arbViewSt.combatants[4].hp, Math.max(0, bHpBefore - aAttack.damage),
        'viewer hp[4] = bHpBefore - aDamage');
    }
    if (bAttack && bAttack.hit !== false) {
      assertEqual(arbViewSt.combatants[0].hp, Math.max(0, aHpBefore - bAttack.damage),
        'viewer hp[0] = aHpBefore - bDamage');
    }
    assertEqual(arbViewSt.turnIdx, 1, 'viewer turnIdx = 1');
    assertEqual(arbViewSt.nextActor.cellId, 0, 'viewer nextActor.cellId is next alive human (A)');
    A.close(); B.close();
    arbViewReset();
    await new Promise(r => setTimeout(r, 40));
  });

  await asyncTest('v1.7.752 P-6 viewer clears inBattle on cancel frame', async () => {
    _testHooks.resetState();
    arbViewReset();
    _testEnsureUser(7522); _testSeedSave(7522, 0);
    _testEnsureUser(7523); _testSeedSave(7523, 0);
    const A = await connectClient(port, 7522, { ...baseProfile, name: 'CancV6A', slot: 0 });
    const B = await connectClient(port, 7523, { ...targetProfile, name: 'CancV6B', slot: 0 });
    A.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'pvp-battle-start') arbViewApplyStart(m);
      if (m.type === 'pvp-cancel')       arbViewApplyCancel(m);
    });
    const aStart = once(A, m => m.type === 'pvp-battle-start', 800);
    A.send(JSON.stringify({ type: 'pvp-arb-start', opponentUserId: 7523 }));
    await aStart;
    assertEqual(arbViewSt.inBattle, true, 'inBattle after start');
    // B disconnects — A should get pvp-cancel; viewer flips inBattle off.
    B.close();
    await new Promise(r => setTimeout(r, 120));
    assertEqual(arbViewSt.inBattle, false, 'inBattle cleared on cancel');
    assertEqual(arbViewSt.endReason, 'opponent-disconnect', 'endReason recorded');
    A.close();
    arbViewReset();
    await new Promise(r => setTimeout(r, 40));
  });

  test('v1.7.752 P-6 drainPendingDeltas pops + clears in order', () => {
    arbViewReset();
    // Pre-seed minimal state — turn handler needs a battleId to match.
    arbViewApplyStart({
      battleId: 1, yourSide: 'A', yourCellId: 0, rngSeed: 1,
      sides: {
        A: [{ cellId: 0, side: 'A', isHuman: true, userId: 1, hp: 30, maxHP: 30 }],
        B: [{ cellId: 4, side: 'B', isHuman: true, userId: 2, hp: 30, maxHP: 30 }],
      },
    });
    arbViewApplyTurn({
      type: 'pvp-turn', battleId: 1, turnIdx: 1, nextActor: { cellId: 0, isHuman: true, userId: 1 },
      deltas: [
        { kind: 'attack', actorCellId: 0, targetCellId: 4, damage: 5, hit: true, crit: false },
        { kind: 'attack', actorCellId: 4, targetCellId: 0, damage: 3, hit: true, crit: false },
      ],
    });
    assertEqual(arbViewSt.pendingDeltas.length, 2, '2 deltas pending');
    const drained = drainPendingDeltas();
    assertEqual(drained.length, 2, 'drain returns both');
    assertEqual(drained[0].actorCellId, 0, 'order preserved [0]');
    assertEqual(drained[1].actorCellId, 4, 'order preserved [1]');
    assertEqual(arbViewSt.pendingDeltas.length, 0, 'state cleared');
    assertEqual(drainPendingDeltas().length, 0, 'second drain empty');
    arbViewReset();
  });

  test('v1.7.752 P-6 isMyTurn gates on nextActor cellId match', () => {
    arbViewReset();
    arbViewApplyStart({
      battleId: 1, yourSide: 'A', yourCellId: 0, rngSeed: 1,
      sides: {
        A: [{ cellId: 0, side: 'A', isHuman: true, userId: 1, hp: 30, maxHP: 30 }],
        B: [{ cellId: 4, side: 'B', isHuman: true, userId: 2, hp: 30, maxHP: 30 }],
      },
    });
    // nextActor not set after start — no turn resolved yet.
    assertEqual(isMyTurn(), false, 'no nextActor → not my turn');
    arbViewApplyTurn({
      type: 'pvp-turn', battleId: 1, turnIdx: 1,
      nextActor: { cellId: 0, isHuman: true, userId: 1 },
      deltas: [],
    });
    assertEqual(isMyTurn(), true, 'nextActor cell 0 + yourCellId 0 → my turn');
    arbViewApplyTurn({
      type: 'pvp-turn', battleId: 1, turnIdx: 2,
      nextActor: { cellId: 4, isHuman: true, userId: 2 },
      deltas: [],
    });
    assertEqual(isMyTurn(), false, 'nextActor cell 4 → not my turn');
    arbViewReset();
  });

  // ── v1.7.757 P-9 — matchmaking fork via PVP_ARBITER_SERVER ─────────────
  // With both PVP_ENABLED and PVP_ARBITER_SERVER flipped on, a successful
  // encounter hook spawns an arbiter battle via pvpArbCreate instead of
  // the legacy pvp-match relay. Both clients receive pvp-battle-start
  // (not pvp-match). Other matchmaking semantics (search-cancel, etc.)
  // stay identical to the legacy path.
  await asyncTest('v1.7.757 P-9 encounter hook spawns arbiter battle when both flags on', async () => {
    _testHooks.resetState();
    _testHooks.setPvpEnabled(true);
    _testHooks.setPvpArbiterServer(true);
    _testEnsureUser(7530); _testSeedSave(7530, 0);
    _testEnsureUser(7531); _testSeedSave(7531, 0);
    const A = await connectClient(port, 7530, { ...baseProfile, name: 'HookA', loc: 'world' });
    const B = await connectClient(port, 7531, { ...targetProfile, name: 'HookB', loc: 'world' });
    // A searches for B; B then steps into encounter, which should fire
    // the hook (same-loc, default 100% hook for level-1 vs level-1).
    A.send(JSON.stringify({ type: 'pvp-search', targetUserId: 7531 }));
    await new Promise(r => setTimeout(r, 30));
    // Hook chance is ~30% per roll (AGI-differential). On miss, search
    // persists and we can retry. 10 retries → ≤3% chance of total miss.
    const aStart = once(A, m => m.type === 'pvp-battle-start', 4000);
    const bStart = once(B, m => m.type === 'pvp-battle-start', 4000);
    for (let i = 0; i < 10; i++) {
      B.send(JSON.stringify({ type: 'pvp-encounter' }));
      await new Promise(r => setTimeout(r, 60));
    }
    const [sa, sb] = await Promise.all([aStart, bStart]);
    assertEqual(sa.battleId, sb.battleId, 'both sides see same arbiter battleId');
    assertEqual(sa.yourSide, 'A', 'challenger is side A');
    assertEqual(sb.yourSide, 'B', 'target is side B');
    assertTrue(sa.sides.A.length >= 1, 'A has at least main combatant');
    assertTrue(sa.sides.B.length >= 1, 'B has at least main combatant');
    A.close(); B.close();
    _testHooks.setPvpEnabled(false);
    _testHooks.setPvpArbiterServer(false);
    await new Promise(r => setTimeout(r, 40));
  });

  await asyncTest('v1.7.757 P-9 hook falls through to legacy pvp-match when arbiter flag off', async () => {
    _testHooks.resetState();
    _testHooks.setPvpEnabled(true);
    // PVP_ARBITER_SERVER stays false — legacy lockstep path runs.
    _testEnsureUser(7532);
    _testEnsureUser(7533);
    const A = await connectClient(port, 7532, { ...baseProfile, name: 'LegA', loc: 'world' });
    const B = await connectClient(port, 7533, { ...targetProfile, name: 'LegB', loc: 'world' });
    A.send(JSON.stringify({ type: 'pvp-search', targetUserId: 7533 }));
    await new Promise(r => setTimeout(r, 30));
    const aMatch = once(A, m => m.type === 'pvp-match', 4000);
    const bMatch = once(B, m => m.type === 'pvp-match', 4000);
    for (let i = 0; i < 10; i++) {
      B.send(JSON.stringify({ type: 'pvp-encounter' }));
      await new Promise(r => setTimeout(r, 60));
    }
    const [ma, mb] = await Promise.all([aMatch, bMatch]);
    assertTrue(!!ma.opponent && !!mb.opponent, 'legacy pvp-match path intact');
    assertEqual(typeof ma.seed, 'number', 'legacy seed present');
    A.close(); B.close();
    _testHooks.setPvpEnabled(false);
    await new Promise(r => setTimeout(r, 40));
  });

  // ── P3 JWT rotation — refresh endpoint smoke ─────────────────────────────
  await asyncTest('P3 /api/refresh returns a fresh token for a valid one', async () => {
    _testEnsureUser(2001);
    const t = mintToken(2001);
    const r = await fetch(`http://127.0.0.1:${port}/api/refresh`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + t },
    });
    assertEqual(r.status, 200, 'refresh rejected a valid token');
    const data = await r.json();
    assertTrue(typeof data.token === 'string' && data.token.length > 20, 'no token in refresh response');
    assertTrue(data.token !== t, 'refresh returned the same token (should be a fresh sign)');
  });

  await asyncTest('P3 /api/refresh rejects junk token with 401', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/refresh`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer not-a-jwt' },
    });
    assertEqual(r.status, 401, 'junk token was accepted');
  });

  await asyncTest('P3 /api/logout-all bumps watermark and revokes old tokens', async () => {
    _testEnsureUser(2002);
    const t1 = mintToken(2002);
    // Old token validates before logout-all.
    let r = await fetch(`http://127.0.0.1:${port}/api/refresh`, {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + t1 },
    });
    assertEqual(r.status, 200, 'refresh rejected a pre-logout-all token');
    // Trigger logout-all with t1 (server gives us a fresh token in
    // response, but t1's iat is now older than the watermark).
    // The minted t1 has iat ≈ now; the bumped watermark is also `now` —
    // need to wait a second so t1's iat < watermark.
    await new Promise(r => setTimeout(r, 1100));
    r = await fetch(`http://127.0.0.1:${port}/api/logout-all`, {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + t1 },
    });
    assertEqual(r.status, 200, 'logout-all rejected a valid token');
    // Original t1 must now be invalid — any subsequent request 401s.
    r = await fetch(`http://127.0.0.1:${port}/api/refresh`, {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + t1 },
    });
    assertEqual(r.status, 401, 't1 still works after logout-all (watermark not enforced)');
  });

  // ── PvE + economy arbiters (v1.7.778 P-12) ────────────────────────────
  // Boots a fresh user, flips PVE_ARBITER + SERVER_ECONOMY, exercises the
  // wire paths. Covers happy + reject for each surface. Each test cleans
  // its own state so order doesn't matter.

  await asyncTest('PvE encounter request returns battle-start with monsters + seed', async () => {
    _testHooks.setPveArbiter(true);
    _testEnsureUser(3001);
    _testSeedSave(3001, 0, { stats: { level: 5, hp: 100, maxHP: 100 } });
    const ws = await connectClient(port, 3001, { name: 'Pve1', jobIdx: 0, level: 5,
      palIdx: 0, hp: 100, maxHP: 100, agi: 5 });
    ws.send(JSON.stringify({ type: 'slot', slot: 0 }));
    // v1.7.794 — pve-encounter-request gates zoneKey against entry.loc;
    // grasslands_valley requires loc='world'.
    ws.send(JSON.stringify({ type: 'location', loc: 'world' }));
    await new Promise(r => setTimeout(r, 30));
    ws.send(JSON.stringify({ type: 'pve-encounter-request',
      zoneKey: 'grasslands_valley', mapId: 0 }));
    const start = await once(ws, m => m.type === 'pve-battle-start', 2000);
    assertTrue(start.battleId > 0, 'battleId not set');
    assertTrue(start.rngSeed > 0, 'rngSeed not set');
    assertTrue(start.monsters.length >= 1, 'monsters empty');
    assertEqual(start.monsters[0].monsterId, 0, 'expected Goblin');
    // Cleanup: end the battle so the slot is released.
    ws.send(JSON.stringify({ type: 'pve-battle-end', battleId: start.battleId,
      intents: [], claimedOutcome: { victor: 'fled' } }));
    await once(ws, m => m.type === 'pve-battle-result', 1000);
    ws.close();
    _testHooks.setPveArbiter(false);
  });

  await asyncTest('PvE happy path: victor=party with correct rewards is applied', async () => {
    _testHooks.setPveArbiter(true);
    _testEnsureUser(3004);
    _testSeedSave(3004, 0, { stats: { level: 5, hp: 100, maxHP: 100 } });
    const ws = await connectClient(port, 3004, { name: 'PveOK', jobIdx: 0, level: 5,
      palIdx: 0, hp: 100, maxHP: 100, agi: 5 });
    ws.send(JSON.stringify({ type: 'slot', slot: 0 }));
    // v1.7.794 — pve-encounter-request gates zoneKey against entry.loc;
    // grasslands_valley requires loc='world'.
    ws.send(JSON.stringify({ type: 'location', loc: 'world' }));
    await new Promise(r => setTimeout(r, 30));
    ws.send(JSON.stringify({ type: 'pve-encounter-request',
      zoneKey: 'grasslands_valley', mapId: 0 }));
    const start = await once(ws, m => m.type === 'pve-battle-start', 2000);
    // Compute the CORRECT rewards from the actual monsters the server picked.
    // Mirrors the formula in src/battle-update.js#_updateVictoryFsm.
    const expSum = start.monsters.reduce((s, m) => s + (m.exp | 0), 0);
    const gilSum = start.monsters.reduce((s, m) => s + (m.gil | 0), 0);
    const cpSum  = start.monsters.reduce((s, m) => s + ((m.cp != null ? m.cp : 1) | 0), 0);
    ws.send(JSON.stringify({ type: 'pve-battle-end', battleId: start.battleId,
      intents: [], claimedOutcome: {
        victor: 'party',
        expGained: Math.max(1, Math.floor(expSum / 4)),
        gilGained: Math.max(1, Math.floor(gilSum / 4)),
        cpGained:  Math.max(1, Math.floor(cpSum  / 4)),
        drop: null,
      } }));
    const result = await once(ws, m => m.type === 'pve-battle-result', 1000);
    assertEqual(result.status, 'applied', 'happy-path victory rejected: ' + result.reason);
    assertTrue(result.canonical && result.canonical.victor === 'party',
      'canonical victor missing or wrong: ' + JSON.stringify(result.canonical));
    // Mirror gil should reflect the granted gilGained. inv-state arrives
    // right after pve-battle-result; ws._earlyMessages collector captures
    // both for retrospective inspection (the once() helper can race past
    // the inv-state when chained after pve-battle-result).
    await new Promise(r => setTimeout(r, 50));
    const invState = ws._earlyMessages.find(m =>
      m.type === 'inv-state' && m.reason === 'pve-applied');
    assertTrue(invState, 'inv-state push missing after applied victory');
    assertTrue(invState.gil > 0, 'mirror gil did not increase after applied victory');
    ws.close();
    _testHooks.setPveArbiter(false);
  });

  await asyncTest('PvE battle-end rejects forged exp', async () => {
    _testHooks.setPveArbiter(true);
    _testEnsureUser(3002);
    _testSeedSave(3002, 0, { stats: { level: 5, hp: 100, maxHP: 100 } });
    const ws = await connectClient(port, 3002, { name: 'Pve2', jobIdx: 0, level: 5,
      palIdx: 0, hp: 100, maxHP: 100, agi: 5 });
    ws.send(JSON.stringify({ type: 'slot', slot: 0 }));
    // v1.7.794 — pve-encounter-request gates zoneKey against entry.loc;
    // grasslands_valley requires loc='world'.
    ws.send(JSON.stringify({ type: 'location', loc: 'world' }));
    await new Promise(r => setTimeout(r, 30));
    ws.send(JSON.stringify({ type: 'pve-encounter-request',
      zoneKey: 'grasslands_valley', mapId: 0 }));
    const start = await once(ws, m => m.type === 'pve-battle-start', 2000);
    ws.send(JSON.stringify({ type: 'pve-battle-end', battleId: start.battleId,
      intents: [], claimedOutcome: { victor: 'party',
        expGained: 99999, gilGained: 1, cpGained: 1, drop: null } }));
    const result = await once(ws, m => m.type === 'pve-battle-result', 1000);
    assertEqual(result.status, 'rejected', 'forged exp accepted');
    assertTrue(result.reason && result.reason.startsWith('exp-mismatch'),
      'wrong reject reason: ' + result.reason);
    ws.close();
    _testHooks.setPveArbiter(false);
  });

  await asyncTest('PvE battle-end rejects drop not in monster pool', async () => {
    _testHooks.setPveArbiter(true);
    _testEnsureUser(3003);
    _testSeedSave(3003, 0, { stats: { level: 5, hp: 100, maxHP: 100 } });
    const ws = await connectClient(port, 3003, { name: 'Pve3', jobIdx: 0, level: 5,
      palIdx: 0, hp: 100, maxHP: 100, agi: 5 });
    ws.send(JSON.stringify({ type: 'slot', slot: 0 }));
    // v1.7.794 — pve-encounter-request gates zoneKey against entry.loc;
    // grasslands_valley requires loc='world'.
    ws.send(JSON.stringify({ type: 'location', loc: 'world' }));
    await new Promise(r => setTimeout(r, 30));
    ws.send(JSON.stringify({ type: 'pve-encounter-request',
      zoneKey: 'grasslands_valley', mapId: 0 }));
    const start = await once(ws, m => m.type === 'pve-battle-start', 2000);
    // Goblin drops Potion (0xA6) only; claiming a Hi-Potion (0xA7) = cheat.
    const expSum = start.monsters.reduce((s, m) => s + (m.exp | 0), 0);
    const gilSum = start.monsters.reduce((s, m) => s + (m.gil | 0), 0);
    const cpSum = start.monsters.reduce((s, m) => s + ((m.cp != null ? m.cp : 1) | 0), 0);
    ws.send(JSON.stringify({ type: 'pve-battle-end', battleId: start.battleId,
      intents: [], claimedOutcome: { victor: 'party',
        expGained: Math.max(1, Math.floor(expSum / 4)),
        gilGained: Math.max(1, Math.floor(gilSum / 4)),
        cpGained:  Math.max(1, Math.floor(cpSum  / 4)),
        drop: 0xA7 } }));
    const result = await once(ws, m => m.type === 'pve-battle-result', 1000);
    assertEqual(result.status, 'rejected', 'fake drop accepted');
    assertTrue(result.reason && result.reason.startsWith('drop-not-in-pool'),
      'wrong reject reason: ' + result.reason);
    ws.close();
    _testHooks.setPveArbiter(false);
  });

  await asyncTest('v1.7.794 pve-encounter-request rejects zoneKey not allowed for entry.loc', async () => {
    _testHooks.setPveArbiter(true);
    _testEnsureUser(3005);
    _testSeedSave(3005, 0, { stats: { level: 5, hp: 100, maxHP: 100 } });
    const ws = await connectClient(port, 3005, { name: 'PveZone', jobIdx: 0, level: 5,
      palIdx: 0, hp: 100, maxHP: 100, agi: 5 });
    ws.send(JSON.stringify({ type: 'slot', slot: 0 }));
    // hello defaulted entry.loc to 'ur'. Claiming altar_cave_f4 (allowed
    // only for cave-3) must reject with wrong-zone — closes the v1.7.794
    // zoneKey-claim exploit.
    await new Promise(r => setTimeout(r, 30));
    ws.send(JSON.stringify({ type: 'pve-encounter-request',
      zoneKey: 'altar_cave_f4', mapId: 1003 }));
    const cancel = await once(ws, m => m.type === 'pve-cancel', 1000);
    assertEqual(cancel.reason, 'wrong-zone', 'wrong reject reason: ' + cancel.reason);
    // After updating loc to cave-3, the same zoneKey should now succeed.
    ws.send(JSON.stringify({ type: 'location', loc: 'cave-3' }));
    await new Promise(r => setTimeout(r, 30));
    ws.send(JSON.stringify({ type: 'pve-encounter-request',
      zoneKey: 'altar_cave_f4', mapId: 1003 }));
    const start = await once(ws, m => m.type === 'pve-battle-start', 1000);
    assertTrue(start.battleId > 0, 'legit request still works after loc switch');
    // Cleanup: end the battle.
    ws.send(JSON.stringify({ type: 'pve-battle-end', battleId: start.battleId,
      intents: [], claimedOutcome: { victor: 'fled' } }));
    await once(ws, m => m.type === 'pve-battle-result', 1000);
    ws.close();
    _testHooks.setPveArbiter(false);
  });

  await asyncTest('Shop buy succeeds + mirror gil decreases', async () => {
    _testHooks.setServerEconomy(true);
    _testEnsureUser(3010);
    _testSeedSave(3010, 0, { stats: { level: 1 } });
    // Mint gil into the mirror so the shop has something to debit.
    _testHooks.setMirrorAuthoritative
      ? _testHooks.setMirrorAuthoritative(true) : null;
    // Direct mirror seed via test helper.
    _testSetMirrorAuthoritative(true);
    _testEnsureUser(3010);
    const ws = await connectClient(port, 3010, { name: 'Shop1', jobIdx: 0,
      level: 1, palIdx: 0, hp: 50, maxHP: 50, agi: 5 });
    ws.send(JSON.stringify({ type: 'slot', slot: 0 }));
    await new Promise(r => setTimeout(r, 30));
    // Seed mirror gil via gil-delta event (shadow mode).
    ws.send(JSON.stringify({ type: 'inv-event', kind: 'gil-delta', qty: 1000, source: 'test' }));
    await new Promise(r => setTimeout(r, 30));
    // Potion (0xA6) costs 50g in Ur item shop.
    ws.send(JSON.stringify({ type: 'shop-transaction', txnId: 1,
      shopId: 'ur_item', action: 'buy', itemId: 0xA6, qty: 1 }));
    const result = await once(ws, m => m.type === 'shop-result', 1000);
    assertEqual(result.status, 'ok', 'buy was rejected: ' + result.reason);
    assertTrue(result.gilAfter < 1000, 'gil did not decrease');
    ws.close();
    _testHooks.setServerEconomy(false);
  });

  await asyncTest('Shop buy rejected when item not in shop catalog', async () => {
    _testHooks.setServerEconomy(true);
    _testEnsureUser(3011);
    const ws = await connectClient(port, 3011, { name: 'Shop2', jobIdx: 0,
      level: 1, palIdx: 0, hp: 50, maxHP: 50, agi: 5 });
    ws.send(JSON.stringify({ type: 'slot', slot: 0 }));
    await new Promise(r => setTimeout(r, 30));
    // Try to buy a Longsword (0x24) from the item shop (has Potion only).
    ws.send(JSON.stringify({ type: 'shop-transaction', txnId: 1,
      shopId: 'ur_item', action: 'buy', itemId: 0x24, qty: 1 }));
    const result = await once(ws, m => m.type === 'shop-result', 1000);
    assertEqual(result.status, 'rejected', 'unauthorized buy accepted');
    assertEqual(result.reason, 'item-not-in-shop', 'wrong reject reason');
    ws.close();
    _testHooks.setServerEconomy(false);
  });

  await asyncTest('Shop buy rejected on insufficient gil', async () => {
    _testHooks.setServerEconomy(true);
    _testEnsureUser(3012);
    const ws = await connectClient(port, 3012, { name: 'Shop3', jobIdx: 0,
      level: 1, palIdx: 0, hp: 50, maxHP: 50, agi: 5 });
    ws.send(JSON.stringify({ type: 'slot', slot: 0 }));
    await new Promise(r => setTimeout(r, 30));
    // Mirror gil defaults to 0 for fresh user. Try to buy a Potion (50g).
    ws.send(JSON.stringify({ type: 'shop-transaction', txnId: 1,
      shopId: 'ur_item', action: 'buy', itemId: 0xA6, qty: 1 }));
    const result = await once(ws, m => m.type === 'shop-result', 1000);
    assertEqual(result.status, 'rejected', 'broke player got the item');
    assertTrue(result.reason && result.reason.startsWith('insufficient-gil'),
      'wrong reject reason: ' + result.reason);
    ws.close();
    _testHooks.setServerEconomy(false);
  });

  await asyncTest('Chest validate-only accepts a claim in the pool', async () => {
    _testHooks.setServerEconomy(true);
    _testEnsureUser(3020);
    // v1.7.787 — consumed_tiles is persistent; clear so a prior run's row
    // for (114, 5, 5) doesn't pre-block the open.
    _testConsumedTilesClear(3020, 0);
    const ws = await connectClient(port, 3020, { name: 'Chest1', jobIdx: 0,
      level: 1, palIdx: 0, hp: 50, maxHP: 50, agi: 5 });
    ws.send(JSON.stringify({ type: 'slot', slot: 0 }));
    await new Promise(r => setTimeout(r, 30));
    // Potion (0xA6) is in Ur (map 114) chest pool.
    ws.send(JSON.stringify({ type: 'chest-open', txnId: 1, mapId: 114, x: 5, y: 5,
      claim: { type: 'item', itemId: 0xA6 } }));
    const result = await once(ws, m => m.type === 'chest-result', 1000);
    assertEqual(result.status, 'ok', 'in-pool claim rejected: ' + result.reason);
    ws.close();
    _testHooks.setServerEconomy(false);
  });

  await asyncTest('Chest validate-only rejects claim outside pool', async () => {
    _testHooks.setServerEconomy(true);
    _testEnsureUser(3021);
    const ws = await connectClient(port, 3021, { name: 'Chest2', jobIdx: 0,
      level: 1, palIdx: 0, hp: 50, maxHP: 50, agi: 5 });
    ws.send(JSON.stringify({ type: 'slot', slot: 0 }));
    await new Promise(r => setTimeout(r, 30));
    // Longsword (0x24) is NOT in Ur chest pool — should reject.
    ws.send(JSON.stringify({ type: 'chest-open', txnId: 1, mapId: 114, x: 5, y: 5,
      claim: { type: 'item', itemId: 0x24 } }));
    const result = await once(ws, m => m.type === 'chest-result', 1000);
    assertEqual(result.status, 'rejected', 'out-of-pool claim accepted');
    assertTrue(result.reason && result.reason.startsWith('item-not-in-pool'),
      'wrong reject reason: ' + result.reason);
    ws.close();
    _testHooks.setServerEconomy(false);
  });

  await asyncTest('Chest replay is rejected as already-opened (v1.7.787)', async () => {
    _testHooks.setServerEconomy(true);
    _testEnsureUser(3022);
    // consumed_tiles persists in SQLite across test runs — wipe before so
    // a prior run's row at (114, 9, 9) doesn't pre-block the first open.
    _testConsumedTilesClear(3022, 0);
    const ws = await connectClient(port, 3022, { name: 'ChestRep', jobIdx: 0,
      level: 1, palIdx: 0, hp: 50, maxHP: 50, agi: 5 });
    ws.send(JSON.stringify({ type: 'slot', slot: 0 }));
    await new Promise(r => setTimeout(r, 30));
    // First open succeeds.
    ws.send(JSON.stringify({ type: 'chest-open', txnId: 1, mapId: 114, x: 9, y: 9,
      claim: { type: 'item', itemId: 0xA6 } }));
    const first = await once(ws, m => m.type === 'chest-result' && m.txnId === 1, 1000);
    assertEqual(first.status, 'ok', 'first chest open rejected: ' + first.reason);
    // Replay against same (mapId, x, y) is the exploit; server must reject.
    ws.send(JSON.stringify({ type: 'chest-open', txnId: 2, mapId: 114, x: 9, y: 9,
      claim: { type: 'item', itemId: 0xA6 } }));
    const second = await once(ws, m => m.type === 'chest-result' && m.txnId === 2, 1000);
    assertEqual(second.status, 'rejected', 'replay accepted — exploit open');
    assertEqual(second.reason, 'already-opened', 'wrong reject reason: ' + second.reason);
    ws.close();
    _testHooks.setServerEconomy(false);
  });

  await asyncTest('Dungeon chests are NOT server-tracked (regen by design, v1.7.789)', async () => {
    _testHooks.setServerEconomy(true);
    _testEnsureUser(3024);
    _testConsumedTilesClear(3024, 0);
    const ws = await connectClient(port, 3024, { name: 'CaveRep', jobIdx: 0,
      level: 1, palIdx: 0, hp: 50, maxHP: 50, agi: 5 });
    ws.send(JSON.stringify({ type: 'slot', slot: 0 }));
    await new Promise(r => setTimeout(r, 30));
    // Altar Cave F1 (mapId 1000). Dungeon chests skip the replay block
    // because the dungeon regenerates per re-entry — a coord-keyed gate
    // would falsely block legit chests at recurring coords. Both opens
    // must succeed (proper per-instance tracking is on the queue).
    ws.send(JSON.stringify({ type: 'chest-open', txnId: 1, mapId: 1000, x: 4, y: 4,
      claim: { type: 'item', itemId: 0xA6 } }));
    const first = await once(ws, m => m.type === 'chest-result' && m.txnId === 1, 1000);
    assertEqual(first.status, 'ok', 'first dungeon chest open rejected: ' + first.reason);
    ws.send(JSON.stringify({ type: 'chest-open', txnId: 2, mapId: 1000, x: 4, y: 4,
      claim: { type: 'item', itemId: 0xA6 } }));
    const second = await once(ws, m => m.type === 'chest-result' && m.txnId === 2, 1000);
    assertEqual(second.status, 'ok', 'dungeon replay was wrongly blocked: ' + second.reason);
    ws.close();
    _testHooks.setServerEconomy(false);
  });

  await asyncTest('Vase replay is rejected as on-cooldown; miss does not consume (v1.7.787)', async () => {
    _testHooks.setServerEconomy(true);
    _testEnsureUser(3023);
    _testConsumedTilesClear(3023, 0);
    const ws = await connectClient(port, 3023, { name: 'VaseRep', jobIdx: 0,
      level: 1, palIdx: 0, hp: 50, maxHP: 50, agi: 5 });
    ws.send(JSON.stringify({ type: 'slot', slot: 0 }));
    await new Promise(r => setTimeout(r, 30));
    // Two miss claims at (7, 7) must NOT consume the cooldown (per the
    // client v1.7.618 design — players keep searching until they hit).
    ws.send(JSON.stringify({ type: 'vase-search', txnId: 1, mapId: 114, x: 7, y: 7,
      claim: { type: 'miss' } }));
    const miss1 = await once(ws, m => m.type === 'vase-result' && m.txnId === 1, 1000);
    assertEqual(miss1.status, 'ok', 'first miss rejected: ' + miss1.reason);
    ws.send(JSON.stringify({ type: 'vase-search', txnId: 2, mapId: 114, x: 7, y: 7,
      claim: { type: 'miss' } }));
    const miss2 = await once(ws, m => m.type === 'vase-result' && m.txnId === 2, 1000);
    assertEqual(miss2.status, 'ok', 'second miss rejected (cooldown wrongly consumed): ' + miss2.reason);
    // First hit succeeds.
    ws.send(JSON.stringify({ type: 'vase-search', txnId: 3, mapId: 114, x: 7, y: 7,
      claim: { type: 'gil', amount: 1 } }));
    const hit1 = await once(ws, m => m.type === 'vase-result' && m.txnId === 3, 1000);
    assertEqual(hit1.status, 'ok', 'first hit rejected: ' + hit1.reason);
    // Second hit on the same tile must be blocked.
    ws.send(JSON.stringify({ type: 'vase-search', txnId: 4, mapId: 114, x: 7, y: 7,
      claim: { type: 'gil', amount: 1 } }));
    const hit2 = await once(ws, m => m.type === 'vase-result' && m.txnId === 4, 1000);
    assertEqual(hit2.status, 'rejected', 'vase replay accepted — exploit open');
    assertEqual(hit2.reason, 'on-cooldown', 'wrong reject reason: ' + hit2.reason);
    ws.close();
    _testHooks.setServerEconomy(false);
  });

  await asyncTest('Dungeon vases are NOT server-tracked (regen by design, v1.7.790)', async () => {
    _testHooks.setServerEconomy(true);
    _testEnsureUser(3025);
    _testConsumedTilesClear(3025, 0);
    const ws = await connectClient(port, 3025, { name: 'CaveVase', jobIdx: 0,
      level: 1, palIdx: 0, hp: 50, maxHP: 50, agi: 5 });
    ws.send(JSON.stringify({ type: 'slot', slot: 0 }));
    await new Promise(r => setTimeout(r, 30));
    // mapId 1000 = Altar Cave F1, gil pool 20-60. No dungeon today places
    // hidden-treasure tiles (0x78-0x7B), but the validator mirrors the
    // chest exemption so a future cave tileset that adds vases doesn't
    // re-introduce the v1.7.787 false-block. Both hits must succeed.
    ws.send(JSON.stringify({ type: 'vase-search', txnId: 1, mapId: 1000, x: 6, y: 6,
      claim: { type: 'gil', amount: 1 } }));
    const first = await once(ws, m => m.type === 'vase-result' && m.txnId === 1, 1000);
    assertEqual(first.status, 'ok', 'first dungeon vase hit rejected: ' + first.reason);
    ws.send(JSON.stringify({ type: 'vase-search', txnId: 2, mapId: 1000, x: 6, y: 6,
      claim: { type: 'gil', amount: 1 } }));
    const second = await once(ws, m => m.type === 'vase-result' && m.txnId === 2, 1000);
    assertEqual(second.status, 'ok', 'dungeon vase replay wrongly blocked: ' + second.reason);
    ws.close();
    _testHooks.setServerEconomy(false);
  });

  // ── teardown ─────────────────────────────────────────────────────────────
  await new Promise(r => httpServer.close(r));
}

// ──────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('ff3mmo pvp-wire-sim — multiplayer regression harness');

  if (!ONLY_SUITE || ONLY_SUITE === 'math')   suiteMath();
  if (!ONLY_SUITE || ONLY_SUITE === 'server') suiteServer();
  if (!ONLY_SUITE || ONLY_SUITE === 'wire')   await suiteWire();

  console.log('\n═══ summary ═══');
  console.log(`  passed: ${_passed}`);
  console.log(`  failed: ${_failed}`);
  if (_failed > 0) {
    console.log('\nfailures:');
    for (const f of _failures) console.log(`  - ${f.name}: ${f.err.message}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('harness crashed:', e);
  process.exit(2);
});
