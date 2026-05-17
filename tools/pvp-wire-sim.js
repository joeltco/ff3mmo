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
import { attachWebSocketPresence, _testHooks } from '../ws-presence.js';
import { _testEnsureUser, handleAPI, _testValidateSaveData } from '../api.js';

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
  // bucket for other kinds — `chat` has capacity 20, `encounter-action`
  // is unrestricted (global only). After 20 `chat` frames, further chat
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
  test('per-kind rate — encounter-assist-request capped at 6', () => {
    const { rateAllowKind, perKindRates } = _testHooks;
    const entry = {};
    const cap = perKindRates['encounter-assist-request'].cap;
    let passes = 0;
    for (let i = 0; i < cap + 10; i++) {
      if (rateAllowKind(entry, 'encounter-assist-request')) passes++;
    }
    assertEqual(passes, cap, 'assist-request cap not honored');
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
    let ready = false;
    ws.on('open', () => { /* wait for ready */ });
    ws.on('error', reject);
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
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

  // ── encounter-wire — host triggers co-op random encounter ──────────────
  // Validates the server-side flow: `encounter-start` from host with party
  // members + monster list → server validates each candidate (helloed,
  // in-same-party, not already in encounter) → forwards `encounter-invite`
  // to each accepted peer with seed, monsters, host profile, peers list.
  // Mirror of the v1.7.418 / v1.7.419 co-op layer.
  await asyncTest('encounter-start relays invite to party member', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 1019, { ...baseProfile, name: 'Host' });
    const B = await connectClient(port, 1020, { ...targetProfile, name: 'Guest' });
    // B is in A's party so A.userId qualifies as inviter (one-party-per-player).
    _testHooks.state.partyMemberships.set(1020, 1019);
    const got = once(B, m => m.type === 'encounter-invite', 500);
    A.send(JSON.stringify({
      type: 'encounter-start',
      seed: 0x12345678,
      monsters: [{ monsterId: 0x00 }, { monsterId: 0x00 }],
      partyUserIds: [1020],
    }));
    const m = await got;
    assertEqual(m.seed, 0x12345678, 'seed not relayed');
    assertEqual(m.hostUserId, 1019, 'hostUserId not relayed');
    assertTrue(Array.isArray(m.monsters) && m.monsters.length === 2, 'monsters array malformed');
    assertEqual(m.monsters[0].monsterId, 0x00);
    assertTrue(Array.isArray(m.peers) && m.peers.length >= 1, 'peers list missing');
    // Host's profile should be the first peer entry on the receiver list.
    assertEqual(m.peers[0].userId, 1019);
    assertEqual(m.peers[0].name, 'Host');
    A.close(); B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // Rejects encounter-start if no party members are online (server-side
  // sanity — without an accepted candidate the group is never built).
  await asyncTest('encounter-start rejects when no candidates accept', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 1021, { ...baseProfile, name: 'Solo' });
    // No party membership set — partyUserIds [1099] (non-existent) → reject.
    let invited = false;
    A.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'encounter-invite') invited = true;
    });
    A.send(JSON.stringify({
      type: 'encounter-start',
      seed: 0xdeadbeef,
      monsters: [{ monsterId: 0x00 }],
      partyUserIds: [1099],
    }));
    await new Promise(r => setTimeout(r, 80));
    assertTrue(!invited, 'unexpected invite emitted with no valid candidates');
    assertTrue(!_testHooks.state.encounterGroups.has(1021), 'group built despite no accepts');
    A.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // encounter-action relays to all peers in group (mirror of pvp-action).
  await asyncTest('encounter-action relays to peers with userId attached', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 1022, { ...baseProfile, name: 'A_enc' });
    const B = await connectClient(port, 1023, { ...targetProfile, name: 'B_enc' });
    // Force group membership directly (mirrors the v1.7.418+ server map).
    _testHooks.state.encounterGroups.set(1022, new Set([1023]));
    _testHooks.state.encounterGroups.set(1023, new Set([1022]));
    const got = once(B, m => m.type === 'encounter-action', 500);
    A.send(JSON.stringify({
      type: 'encounter-action',
      kind: 'attack',
      target: { kind: 'monster', idx: 0 },
      hitResults: [{ damage: 12, miss: false, crit: false }],
    }));
    const m = await got;
    assertEqual(m.userId, 1022, 'sender userId not attached on relay');
    assertEqual(m.kind, 'attack');
    assertTrue(Array.isArray(m.hitResults), 'hitResults not relayed');
    assertEqual(m.hitResults[0].damage, 12, 'hitResults payload corrupted');
    A.close(); B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // encounter-end relays + cleans the group.
  await asyncTest('encounter-end relays + clears group', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 1024, { ...baseProfile, name: 'A_end' });
    const B = await connectClient(port, 1025, { ...targetProfile, name: 'B_end' });
    _testHooks.state.encounterGroups.set(1024, new Set([1025]));
    _testHooks.state.encounterGroups.set(1025, new Set([1024]));
    const got = once(B, m => m.type === 'encounter-end', 500);
    A.send(JSON.stringify({ type: 'encounter-end', outcome: 'won' }));
    const m = await got;
    assertEqual(m.outcome, 'won');
    assertEqual(m.userId, 1024, 'sender userId missing on encounter-end');
    // A's group entry must be cleared; B's may or may not be (we sent
    // from A so the server only ran _clearEncounterGroup on A — but B's
    // set referenced A so cross-link cleanup applies). Both should clear.
    assertTrue(!_testHooks.state.encounterGroups.has(1024), 'A group entry leaked');
    A.close(); B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // Disconnect from an encounter group notifies peers via synthetic
  // disconnect (mirror of PvP's pvp-action {kind:'disconnect'}).
  await asyncTest('encounter peer disconnect → synthetic disconnect to peers', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 1026, { ...baseProfile, name: 'A_drop' });
    const B = await connectClient(port, 1027, { ...targetProfile, name: 'B_drop' });
    _testHooks.state.encounterGroups.set(1026, new Set([1027]));
    _testHooks.state.encounterGroups.set(1027, new Set([1026]));
    const got = once(B, m => m.type === 'encounter-action' && m.kind === 'disconnect', 500);
    A.close();
    const m = await got;
    assertEqual(m.userId, 1026, 'disconnect from wrong userId');
    B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── Battle Assist — assist-request forwarded when target.inBattle ───────
  // Mirror of the v1.7.422 wire: joiner emits `encounter-assist-request`
  // for an in-battle roster target. Server validates target.inBattle +
  // same loc, forwards to target as `encounter-assist-incoming`.
  await asyncTest('assist-request forwards to in-battle target', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 1028, { ...baseProfile, name: 'Joiner' });
    // Target needs inBattle=1; helloed with profile.inBattle=1.
    const B = await connectClient(port, 1029, { ...targetProfile, name: 'Target', inBattle: 1 });
    const got = once(B, m => m.type === 'encounter-assist-incoming', 500);
    A.send(JSON.stringify({ type: 'encounter-assist-request', targetUserId: 1029 }));
    const m = await got;
    assertEqual(m.fromUserId, 1028);
    assertEqual(m.fromName, 'Joiner');
    assertTrue(m.fromProfile && m.fromProfile.userId === 1028, 'fromProfile not attached');
    A.close(); B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // Rejects assist-request when target is NOT in battle (server-side gate
  // mirrors the client-side check in input-handler.js).
  await asyncTest('assist-request rejected when target not in battle', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 1030, { ...baseProfile, name: 'Joiner2' });
    const B = await connectClient(port, 1031, { ...targetProfile, name: 'Target2', inBattle: 0 });
    let incoming = false;
    B.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'encounter-assist-incoming') incoming = true;
    });
    A.send(JSON.stringify({ type: 'encounter-assist-request', targetUserId: 1031 }));
    await new Promise(r => setTimeout(r, 80));
    assertTrue(!incoming, 'unexpected incoming when target not in battle');
    A.close(); B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // Snapshot relay — target's accept ships a snapshot to joiner + builds
  // the encounter group.
  await asyncTest('assist-snapshot routes to joiner + builds group', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 1032, { ...baseProfile, name: 'Joiner3' });
    const B = await connectClient(port, 1033, { ...targetProfile, name: 'Target3', inBattle: 1 });
    const got = once(A, m => m.type === 'encounter-assist-snapshot', 500);
    B.send(JSON.stringify({
      type: 'encounter-assist-snapshot',
      joinerUserId: 1032,
      seed: 0xfeedface,
      turnIndex: 3,
      monsters: [{ monsterId: 0x00, hp: 5 }],
      peers: [{ userId: 1033, name: 'Target3', jobIdx: 4, level: 4, palIdx: 0, hp: 50, maxHP: 52 }],
      hostUserId: 1033,
    }));
    const m = await got;
    assertEqual(m.seed, 0xfeedface, 'seed not relayed');
    assertEqual(m.turnIndex, 3, 'turnIndex not relayed');
    assertEqual(m.monsters[0].hp, 5, 'monster hp not relayed');
    assertEqual(m.hostUserId, 1033);
    assertTrue(_testHooks.state.encounterGroups.has(1032), 'joiner not added to group');
    assertTrue(_testHooks.state.encounterGroups.has(1033), 'host not in group');
    assertTrue(_testHooks.state.encounterGroups.get(1032).has(1033), 'joiner→host link missing');
    A.close(); B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // When assist joins an EXISTING co-op (target already has peers), the
  // new joiner gets the snapshot AND existing peers get an ally-join
  // broadcast so they fade-in the new ally locally.
  await asyncTest('assist-snapshot broadcasts ally-join to existing peers', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 1034, { ...baseProfile, name: 'NewJoiner' });
    const B = await connectClient(port, 1035, { ...targetProfile, name: 'Target4', inBattle: 1 });
    const C = await connectClient(port, 1036, { ...targetProfile, name: 'ExistingPeer' });
    // B and C are already in a co-op encounter; pre-populate the group.
    _testHooks.state.encounterGroups.set(1035, new Set([1036]));
    _testHooks.state.encounterGroups.set(1036, new Set([1035]));
    const aGot = once(A, m => m.type === 'encounter-assist-snapshot', 500);
    const cGot = once(C, m => m.type === 'encounter-ally-join', 500);
    B.send(JSON.stringify({
      type: 'encounter-assist-snapshot',
      joinerUserId: 1034,
      seed: 0xcafe,
      turnIndex: 1,
      monsters: [{ monsterId: 0x00, hp: 8 }],
      peers: [{ userId: 1035, name: 'Target4' }, { userId: 1036, name: 'ExistingPeer' }],
      hostUserId: 1035,
    }));
    await aGot;
    const ally = await cGot;
    assertEqual(ally.profile && ally.profile.userId, 1034, 'ally-join carries new joiner profile');
    // All three must now be reachable from each other.
    const aGroup = _testHooks.state.encounterGroups.get(1034);
    assertTrue(aGroup && aGroup.has(1035) && aGroup.has(1036), 'joiner group missing peer links');
    A.close(); B.close(); C.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // Identity-pin defense (v1.7.426). Target tries to ship a spoofed peer
  // profile (unknown userId, lies about name/job). Server must drop the
  // unknown userId entirely and overwrite identity fields on known users
  // with the server's trusted profile. Live battle stats (hp, atk) flow
  // through unchanged — server doesn't track those.
  await asyncTest('assist-snapshot drops unknown-userId peers + pins identity', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 1040, { ...baseProfile, name: 'Joiner5' });
    const B = await connectClient(port, 1041, { ...targetProfile, name: 'RealName', jobIdx: 3, level: 5, palIdx: 2, inBattle: 1 });
    const C = await connectClient(port, 1042, { ...baseProfile, name: 'Existing', jobIdx: 1, level: 7, palIdx: 4 });
    const got = once(A, m => m.type === 'encounter-assist-snapshot', 500);
    B.send(JSON.stringify({
      type: 'encounter-assist-snapshot',
      joinerUserId: 1040,
      seed: 0xabad1dea,
      turnIndex: 2,
      monsters: [{ monsterId: 0x00, hp: 9 }],
      peers: [
        // B lies about C's identity (wrong name + job).
        { userId: 1042, name: 'SPOOFED', jobIdx: 0, level: 99, palIdx: 31, hp: 33, maxHP: 50, atk: 12 },
        // B injects a peer who isn't connected.
        { userId: 9999, name: 'GHOST', jobIdx: 0, level: 1, palIdx: 0 },
        // B includes themselves with correct fields — server should pin those.
        { userId: 1041, name: 'SHOULDOVERWRITE', jobIdx: 0, level: 99, hp: 40, maxHP: 60 },
      ],
      hostUserId: 1041,
    }));
    const m = await got;
    // Ghost (unknown userId 9999) must be absent.
    assertTrue(!m.peers.some(p => p.userId === 9999), 'ghost peer leaked into snapshot');
    // C's identity fields are pinned to server profile, not the spoof.
    const cPeer = m.peers.find(p => p.userId === 1042);
    assertTrue(cPeer, 'real peer 1042 dropped');
    assertEqual(cPeer.name, 'Existing', 'name not pinned to server');
    assertEqual(cPeer.jobIdx, 1, 'jobIdx not pinned to server');
    assertEqual(cPeer.level, 7, 'level not pinned to server');
    assertEqual(cPeer.palIdx, 4, 'palIdx not pinned to server');
    // Live battle stats flow through unchanged (server can't validate them).
    assertEqual(cPeer.hp, 33, 'hp should pass through');
    assertEqual(cPeer.atk, 12, 'atk should pass through');
    // Host's own peer entry should also be pinned.
    const bPeer = m.peers.find(p => p.userId === 1041);
    assertTrue(bPeer, 'host peer 1041 dropped');
    assertEqual(bPeer.name, 'RealName', 'host name not pinned');
    assertEqual(bPeer.jobIdx, 3, 'host jobIdx not pinned');
    A.close(); B.close(); C.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // Defense — target tries to put the joiner into the joiner's own peers
  // list (would cause the joiner to spawn a clone of themself as an ally).
  await asyncTest('assist-snapshot drops joiner from own peers list', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 1044, { ...baseProfile, name: 'Joiner6' });
    const B = await connectClient(port, 1045, { ...targetProfile, name: 'Target6', inBattle: 1 });
    const got = once(A, m => m.type === 'encounter-assist-snapshot', 500);
    B.send(JSON.stringify({
      type: 'encounter-assist-snapshot',
      joinerUserId: 1044,
      seed: 0xdead,
      turnIndex: 0,
      monsters: [{ monsterId: 0x00, hp: 10 }],
      peers: [
        { userId: 1045, name: 'Target6', jobIdx: 0, level: 1, palIdx: 0 },
        { userId: 1044, name: 'CLONE',   jobIdx: 0, level: 1, palIdx: 0 },
      ],
      hostUserId: 1045,
    }));
    const m = await got;
    assertTrue(!m.peers.some(p => p.userId === 1044), 'joiner cloned into own peers list');
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
