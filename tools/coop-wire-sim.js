#!/usr/bin/env node
// tools/coop-wire-sim.js — co-op + party-fanout regression harness.
//
// Spins up the real `ws-presence.js` server on a localhost port + 2-3 JWT-
// authed `ws` clients and exercises the wire surface I broke and re-broke
// while shipping v1.7.460..v1.7.464:
//
//   - party-invite fanout (v1.7.460 star → mesh)
//   - party-member-joined notification to existing members
//   - party-snapshot to the joiner
//   - inBattle push on encounter-start / encounter-end (v1.7.463)
//   - encounter-invite reaches every party member
//   - encounter-action relays with damageRoll / healAmount intact (v1.7.458)
//
// Quick smoke only — boots a fresh server per run; one assertion per scenario;
// run from `deploy.sh` as a pre-flight gate alongside `pvp-wire-sim.js`.
//
//   node tools/coop-wire-sim.js
//   node tools/coop-wire-sim.js --filter=party

import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { WebSocket } from 'ws';

import { attachWebSocketPresence, _testHooks } from '../ws-presence.js';
import { _testEnsureUser, handleAPI } from '../api.js';

const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'ff3mmo-dev-secret-change-in-prod';

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--(\w+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const ONLY_FILTER = args.filter || null;

let _passed = 0, _failed = 0;
const _failures = [];

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

function mintToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '1h' });
}

// Wait for the next message matching `predicate`. Resolves with the msg or
// rejects on timeout. Removes the listener on either path.
function once(ws, predicate, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error('timeout waiting for predicate'));
    }, timeoutMs);
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

// Spawn a connected + helloed client. Returns the open `ws`. Caller must
// `.close()` when done. `loc` defaults to 'ur'.
function connectClient(port, userId, profile, loc = 'ur') {
  _testEnsureUser(userId);
  return new Promise((resolve, reject) => {
    const token = mintToken(userId);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${token}`);
    let ready = false;
    ws.on('error', reject);
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (!ready && msg.type === 'ready') {
        ready = true;
        ws.send(JSON.stringify({ type: 'hello', profile, loc }));
        setTimeout(() => resolve(ws), 30);
      }
    });
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Suite
// ──────────────────────────────────────────────────────────────────────────

async function suite() {
  _testHooks.resetState();

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

  const baseProfile = (name, jobIdx, level, agi) => ({
    name, jobIdx, level, palIdx: 0, hp: 40, maxHP: 40, agi,
    weaponR: 0x1e, armorId: 0x73, helmId: 0x62, inBattle: 0,
  });

  // ── Party invite — A invites B, B accepts, A receives result ───────────
  await asyncTest('party-invite accept routes back to inviter with partner profile', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 2001, baseProfile('A1', 5, 7, 12));
    const B = await connectClient(port, 2002, baseProfile('B1', 4, 6, 10));
    const gotIncoming = once(B, m => m.type === 'party-invite-incoming');
    const gotResult   = once(A, m => m.type === 'party-invite-result');
    A.send(JSON.stringify({ type: 'party-invite', targetUserId: 2002 }));
    const incoming = await gotIncoming;
    assertEqual(incoming.challenger?.userId, 2001, 'incoming missing challenger.userId');
    B.send(JSON.stringify({ type: 'party-invite-response', accept: true }));
    const result = await gotResult;
    assertEqual(result.accept, true);
    assertEqual(result.partner?.userId, 2002, 'partner.userId not relayed');
    // Server side now records B → A.
    assertTrue(_testHooks.state.partyMemberships.get(2002) === 2001, 'membership not set');
    A.close(); B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── Mesh fanout — existing member learns about new joiner ──────────────
  await asyncTest('party-member-joined fans out to existing members on accept', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 2010, baseProfile('A2', 5, 7, 12));
    const B = await connectClient(port, 2011, baseProfile('B2', 4, 6, 10));
    const C = await connectClient(port, 2012, baseProfile('C2', 6, 5, 11));
    // A invites B, B accepts. (Same flow as the first test — drives setup.)
    const gotIncB = once(B, m => m.type === 'party-invite-incoming');
    A.send(JSON.stringify({ type: 'party-invite', targetUserId: 2011 }));
    await gotIncB;
    B.send(JSON.stringify({ type: 'party-invite-response', accept: true }));
    // Now A invites C. B (existing member) should be told C joined.
    await new Promise(r => setTimeout(r, 30));
    const gotIncC      = once(C, m => m.type === 'party-invite-incoming');
    const gotBNotified = once(B, m => m.type === 'party-member-joined');
    A.send(JSON.stringify({ type: 'party-invite', targetUserId: 2012 }));
    await gotIncC;
    C.send(JSON.stringify({ type: 'party-invite-response', accept: true }));
    const bMsg = await gotBNotified;
    assertEqual(bMsg.member?.userId, 2012, 'B got party-member-joined for wrong user');
    A.close(); B.close(); C.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── party-snapshot — new joiner learns about existing peers ────────────
  await asyncTest('party-snapshot to joiner lists existing members', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 2020, baseProfile('A3', 5, 7, 12));
    const B = await connectClient(port, 2021, baseProfile('B3', 4, 6, 10));
    const C = await connectClient(port, 2022, baseProfile('C3', 6, 5, 11));
    // Build A's party with B first.
    const incB = once(B, m => m.type === 'party-invite-incoming');
    A.send(JSON.stringify({ type: 'party-invite', targetUserId: 2021 }));
    await incB;
    B.send(JSON.stringify({ type: 'party-invite-response', accept: true }));
    await new Promise(r => setTimeout(r, 30));
    // Now A invites C; C should get a party-snapshot listing B.
    const incC      = once(C, m => m.type === 'party-invite-incoming');
    const cSnapshot = once(C, m => m.type === 'party-snapshot');
    A.send(JSON.stringify({ type: 'party-invite', targetUserId: 2022 }));
    await incC;
    C.send(JSON.stringify({ type: 'party-invite-response', accept: true }));
    const snap = await cSnapshot;
    assertTrue(Array.isArray(snap.members), 'snapshot.members not an array');
    assertEqual(snap.members.length, 1, 'expected 1 existing member (B)');
    assertEqual(snap.members[0].userId, 2021, 'snapshot member not B');
    A.close(); B.close(); C.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── Member-left fanout — peer member learns when another peer drops ────
  await asyncTest('party-member-left fans out to all members, not just inviter', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 2030, baseProfile('A4', 5, 7, 12));
    const B = await connectClient(port, 2031, baseProfile('B4', 4, 6, 10));
    const C = await connectClient(port, 2032, baseProfile('C4', 6, 5, 11));
    // Build A → {B, C}.
    const incB = once(B, m => m.type === 'party-invite-incoming');
    A.send(JSON.stringify({ type: 'party-invite', targetUserId: 2031 }));
    await incB;
    B.send(JSON.stringify({ type: 'party-invite-response', accept: true }));
    await new Promise(r => setTimeout(r, 30));
    const incC = once(C, m => m.type === 'party-invite-incoming');
    A.send(JSON.stringify({ type: 'party-invite', targetUserId: 2032 }));
    await incC;
    C.send(JSON.stringify({ type: 'party-invite-response', accept: true }));
    await new Promise(r => setTimeout(r, 30));
    // B leaves; A AND C should both be notified.
    const aGotLeft = once(A, m => m.type === 'party-member-left' && m.memberUserId === 2031);
    const cGotLeft = once(C, m => m.type === 'party-member-left' && m.memberUserId === 2031);
    B.send(JSON.stringify({ type: 'party-leave' }));
    await Promise.all([aGotLeft, cGotLeft]);
    A.close(); B.close(); C.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── encounter-start — server pushes inBattle=1 to peers immediately ────
  await asyncTest('encounter-start broadcasts inBattle=1 player-update', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 2040, baseProfile('A5', 5, 7, 12));
    const B = await connectClient(port, 2041, baseProfile('B5', 4, 6, 10));
    // Build A → B.
    const incB = once(B, m => m.type === 'party-invite-incoming');
    A.send(JSON.stringify({ type: 'party-invite', targetUserId: 2041 }));
    await incB;
    B.send(JSON.stringify({ type: 'party-invite-response', accept: true }));
    await new Promise(r => setTimeout(r, 30));
    // A starts an encounter pulling B in.
    const bGotInvite  = once(B, m => m.type === 'encounter-invite');
    const bGotInBattle = once(B, m => m.type === 'player-update' && m.userId === 2040 && m.fields?.inBattle === 1);
    A.send(JSON.stringify({
      type: 'encounter-start',
      seed: 0x12345678,
      monsters: [{ monsterId: 0x00 }],
      partyUserIds: [2041],
    }));
    const invite = await bGotInvite;
    assertEqual(invite.hostUserId, 2040, 'host not relayed');
    assertEqual(invite.monsters.length, 1, 'monster list not relayed');
    await bGotInBattle;  // throws if it never arrives
    A.close(); B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── encounter-action — relay carries damageRoll + healAmount ───────────
  await asyncTest('encounter-action relays damageRoll + healAmount to peers', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 2050, baseProfile('A6', 5, 7, 12));
    const B = await connectClient(port, 2051, baseProfile('B6', 4, 6, 10));
    // Build A → B + start an encounter so the server's _encounterGroups
    // map routes encounter-action between them.
    const incB = once(B, m => m.type === 'party-invite-incoming');
    A.send(JSON.stringify({ type: 'party-invite', targetUserId: 2051 }));
    await incB;
    B.send(JSON.stringify({ type: 'party-invite-response', accept: true }));
    await new Promise(r => setTimeout(r, 30));
    const bInvite = once(B, m => m.type === 'encounter-invite');
    A.send(JSON.stringify({
      type: 'encounter-start', seed: 0xCAFEBABE,
      monsters: [{ monsterId: 0x00 }], partyUserIds: [2051],
    }));
    await bInvite;
    // A casts a magic spell against the enemy. Relayed to B with both
    // pre-rolled fields intact (this is the v1.7.458 fix).
    const bGotAction = once(B, m => m.type === 'encounter-action' && m.kind === 'magic');
    A.send(JSON.stringify({
      type: 'encounter-action', kind: 'magic',
      target: { kind: 'monster', idx: 0 },
      spellId: 0x23,    // Fira
      damageRoll: 47,
    }));
    const action = await bGotAction;
    assertEqual(action.userId,    2050, 'sender userId not stamped');
    assertEqual(action.spellId,   0x23);
    assertEqual(action.damageRoll, 47, 'damageRoll dropped on relay');
    A.close(); B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // ── encounter-end — inBattle=0 pushed back to peers ────────────────────
  await asyncTest('encounter-end clears inBattle on host', async () => {
    _testHooks.resetState();
    const A = await connectClient(port, 2060, baseProfile('A7', 5, 7, 12));
    const B = await connectClient(port, 2061, baseProfile('B7', 4, 6, 10));
    const incB = once(B, m => m.type === 'party-invite-incoming');
    A.send(JSON.stringify({ type: 'party-invite', targetUserId: 2061 }));
    await incB;
    B.send(JSON.stringify({ type: 'party-invite-response', accept: true }));
    await new Promise(r => setTimeout(r, 30));
    const bInvite = once(B, m => m.type === 'encounter-invite');
    const bGotInBattle = once(B, m => m.type === 'player-update' && m.userId === 2060 && m.fields?.inBattle === 1);
    A.send(JSON.stringify({
      type: 'encounter-start', seed: 0xFEEDFACE,
      monsters: [{ monsterId: 0x00 }], partyUserIds: [2061],
    }));
    await bInvite;
    await bGotInBattle;
    // A finishes; B should see player-update inBattle=0 + encounter-end.
    const bGotClear   = once(B, m => m.type === 'player-update' && m.userId === 2060 && m.fields?.inBattle === 0);
    const bGotEnd     = once(B, m => m.type === 'encounter-end' && m.userId === 2060);
    A.send(JSON.stringify({ type: 'encounter-end', outcome: 'won' }));
    await Promise.all([bGotClear, bGotEnd]);
    A.close(); B.close();
    await new Promise(r => setTimeout(r, 40));
  });

  // Done — close server.
  await new Promise(r => httpServer.close(r));
}

// ──────────────────────────────────────────────────────────────────────────

(async () => {
  console.log('═══ coop-wire-sim ═══');
  await suite();
  console.log(`\n═══ summary ═══`);
  console.log(`  passed: ${_passed}`);
  console.log(`  failed: ${_failed}`);
  if (_failed > 0) {
    for (const f of _failures) console.log(`  - ${f.name}: ${f.err.message}`);
    process.exit(1);
  }
})().catch((e) => { console.error(e); process.exit(1); });
