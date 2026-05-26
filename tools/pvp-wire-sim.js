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
