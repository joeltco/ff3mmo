#!/usr/bin/env node
// tools/pvp-load-sim.js — load test for `ws-presence.js`.
//
// Spins up the real WS server in-process, opens N simulated clients, drives
// each through realistic chat / update / location traffic for a fixed
// duration, and prints aggregate stats. Use to right-size rate limits and
// the per-IP connection cap from data instead of guesses.
//
//   node tools/pvp-load-sim.js                              # 20 clients × 30 s
//   node tools/pvp-load-sim.js --clients=50 --duration=60
//   node tools/pvp-load-sim.js --clients=100 --chat-per-min=120
//
// Reports: connect successes/failures, msgs sent/received/dropped, peak
// server state-map sizes, RSS delta over the run.

import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { WebSocket } from 'ws';
import { attachWebSocketPresence, _testHooks } from '../ws-presence.js';

const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'ff3mmo-dev-secret-change-in-prod';

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([\w-]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const CLIENTS      = parseInt(args.clients || '20', 10);
const DURATION_S   = parseInt(args.duration || '30', 10);
const CHAT_PER_MIN = parseInt(args['chat-per-min'] || '20', 10);
const UPDATE_PER_MIN = parseInt(args['update-per-min'] || '12', 10);  // every 5 s
const LOC_PER_MIN    = parseInt(args['loc-per-min']    || '1', 10);   // every 60 s

function _mintToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '1h' });
}

// Per-client stats — flat counters so the wrap-up is just a sum.
class Client {
  constructor(id, port) {
    this.id        = id;
    this.port      = port;
    this.ws        = null;
    this.helloed   = false;
    this.sent      = 0;
    this.received  = 0;
    this.errors    = 0;
    this.closed    = false;
  }
  async connect() {
    const token = _mintToken(1_000_000 + this.id);
    return new Promise((resolve) => {
      // Spoof X-Forwarded-For per client so the per-IP cap (10 in
      // v1.7.388) doesn't gate the load test. Mirrors what nginx forwards
      // — server.js reads the first XFF entry. Each load-client looks like
      // a distinct source IP.
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}/api/ws?token=${token}`, {
        headers: { 'X-Forwarded-For': '10.0.' + ((this.id >> 8) & 0xFF) + '.' + (this.id & 0xFF) },
      });
      this.ws = ws;
      const t = setTimeout(() => { this.errors++; resolve(false); }, 2000);
      ws.on('open', () => {});
      ws.on('error', () => { this.errors++; });
      ws.on('close', () => { this.closed = true; });
      ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        this.received++;
        if (msg.type === 'ready') {
          ws.send(JSON.stringify({
            type: 'hello',
            profile: {
              name: 'Load' + this.id, jobIdx: this.id % 22, level: 1 + (this.id % 30),
              palIdx: this.id % 4, hp: 50, maxHP: 50, agi: 5 + (this.id % 10),
              weaponR: 0x1e, armorId: 0x73, helmId: 0x62,
            },
            loc: this.id % 3 === 0 ? 'ur' : this.id % 3 === 1 ? 'cave-1' : 'crystal',
          }));
          this.helloed = true;
          this.sent++;
          clearTimeout(t);
          resolve(true);
        }
      });
    });
  }
  send(payload) {
    if (!this.helloed || this.closed || this.ws.readyState !== WebSocket.OPEN) return;
    try { this.ws.send(JSON.stringify(payload)); this.sent++; }
    catch { this.errors++; }
  }
  close() {
    if (this.ws && this.ws.readyState <= 1) this.ws.close();
  }
}

function _now() { return performance.now(); }

async function main() {
  console.log(`ff3mmo pvp-load-sim — clients=${CLIENTS} duration=${DURATION_S}s`);
  console.log(`  chat=${CHAT_PER_MIN}/min, update=${UPDATE_PER_MIN}/min, loc=${LOC_PER_MIN}/min`);

  _testHooks.resetState();
  const httpServer = createServer();
  attachWebSocketPresence(httpServer);
  await new Promise(r => httpServer.listen(0, '127.0.0.1', r));
  const port = httpServer.address().port;
  const rssAtStart = process.memoryUsage().rss;

  // Connect all clients in parallel.
  const tConnectStart = _now();
  const clients = Array.from({ length: CLIENTS }, (_, i) => new Client(i, port));
  const connectResults = await Promise.all(clients.map(c => c.connect()));
  const connectedN = connectResults.filter(Boolean).length;
  const tConnect = _now() - tConnectStart;
  console.log(`  connected ${connectedN}/${CLIENTS} in ${Math.round(tConnect)} ms`);

  // Drive realistic traffic for `DURATION_S` seconds. Each client gets its
  // own jittered interval to avoid the thundering-herd artifact.
  const chatMs   = 60000 / CHAT_PER_MIN;
  const updateMs = 60000 / UPDATE_PER_MIN;
  const locMs    = 60000 / LOC_PER_MIN;

  const handles = [];
  for (const c of clients) {
    if (c.closed) continue;
    // Add 0-1×interval jitter so clients don't all fire on the same tick.
    handles.push(setInterval(() => {
      c.send({ type: 'chat', channel: 'world', text: 'load test msg #' + c.sent });
    }, chatMs * (0.5 + Math.random())));
    handles.push(setInterval(() => {
      c.send({ type: 'update', hp: 50 - (c.sent % 50), agi: 5 + (c.id % 10) });
    }, updateMs * (0.5 + Math.random())));
    handles.push(setInterval(() => {
      const locs = ['ur', 'cave-1', 'crystal'];
      c.send({ type: 'location', loc: locs[(c.sent + c.id) % 3] });
    }, locMs * (0.5 + Math.random())));
  }

  // Sample state-map sizes every second.
  const peaks = { connected: 0, partyMem: 0, searches: 0, partners: 0 };
  const sampler = setInterval(() => {
    const s = _testHooks.state;
    peaks.connected = Math.max(peaks.connected, s.connected.size);
    peaks.partyMem  = Math.max(peaks.partyMem,  s.partyMemberships.size);
    peaks.searches  = Math.max(peaks.searches,  s.pvpSearches.size);
    peaks.partners  = Math.max(peaks.partners,  s.pvpPartners.size);
  }, 1000);

  await new Promise(r => setTimeout(r, DURATION_S * 1000));

  for (const h of handles) clearInterval(h);
  clearInterval(sampler);

  // Drain ~200 ms for final receives.
  await new Promise(r => setTimeout(r, 200));

  const sent     = clients.reduce((s, c) => s + c.sent, 0);
  const received = clients.reduce((s, c) => s + c.received, 0);
  const errors   = clients.reduce((s, c) => s + c.errors, 0);
  const stillUp  = clients.filter(c => !c.closed).length;
  const rssAtEnd = process.memoryUsage().rss;
  const rssDelta = rssAtEnd - rssAtStart;

  console.log('\n═══ results ═══');
  console.log('  connected            ' + connectedN + '/' + CLIENTS);
  console.log('  still up @ end       ' + stillUp);
  console.log('  msgs sent (total)    ' + sent);
  console.log('  msgs received (sum)  ' + received);
  console.log('  errors               ' + errors);
  console.log('  send rate            ' + (sent / DURATION_S).toFixed(1) + ' / s');
  console.log('  recv rate            ' + (received / DURATION_S).toFixed(1) + ' / s');
  console.log('  peak connected map   ' + peaks.connected);
  console.log('  peak parties map     ' + peaks.partyMem);
  console.log('  peak searches map    ' + peaks.searches);
  console.log('  peak partners map    ' + peaks.partners);
  console.log('  RSS delta            ' + (rssDelta / 1024 / 1024).toFixed(1) + ' MB');
  console.log('  RSS / client         ' + (rssDelta / Math.max(connectedN, 1) / 1024).toFixed(1) + ' KB');

  // Tear down.
  clients.forEach(c => c.close());
  await new Promise(r => setTimeout(r, 200));
  await new Promise(r => httpServer.close(r));
  process.exit(0);
}

main().catch((e) => {
  console.error('harness crashed:', e);
  process.exit(2);
});
