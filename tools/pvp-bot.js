#!/usr/bin/env node
// tools/pvp-bot.js — auto-opponent for solo PvP testing.
//
// Connects to ff3mmo.com as a real WS client, seeds a save in slot 0,
// sits in the roster, and acts as a punching bag / sparring partner for
// the human on the other end:
//
//   - Sends `pvp-encounter` on a timer so a human challenger's
//     `pvp-search` can hook the bot (= human chose Battle → bot in
//     roster).
//   - Sends `pvp-search` targeting the first known online human so the
//     human just walking into a random encounter triggers a PvP battle.
//   - On `pvp-battle-start`, remembers the opposing main's cellId.
//   - On every `pvp-turn`, ships back `pvp-intent { kind:'attack',
//     targetCellId: <opp main> }`. Doesn't try to use magic / items /
//     defend — just fights.
//
// Usage:
//   node tools/pvp-bot.js                          # prod ff3mmo.com, ur zone
//   node tools/pvp-bot.js --loc=altar
//   node tools/pvp-bot.js --host=localhost:3000 --insecure
//   node tools/pvp-bot.js --email=bot2@x --password=foo --name=GHOUL
//
// The bot survives WS disconnects (reconnect every 5s). Ctrl-C to stop.

import { WebSocket } from 'ws';

// ── Args ─────────────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([\w-]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const HOST       = args.host || 'ff3mmo.com';
const INSECURE   = args.insecure === 'true';
const EMAIL      = args.email || 'pvp-bot@ff3mmo.local';
const PASSWORD   = args.password || 'bot-tester-pw-2026';
const NAME       = (args.name || 'BOT').slice(0, 8);
const JOB_IDX    = parseInt(args.job || '1', 10);   // 1 = Knight (heavy hp, low mp)
const PAL_IDX    = parseInt(args.pal || '3', 10);   // visually distinct from default red
const LOC        = args.loc || 'ur';
const ENCOUNTER_MS = parseInt(args['encounter-ms'] || '12000', 10);
const REISSUE_MS   = parseInt(args['reissue-ms']   || '30000', 10);

const HTTP_BASE = INSECURE ? `http://${HOST}` : `https://${HOST}`;
const WS_BASE   = INSECURE ? `ws://${HOST}`   : `wss://${HOST}`;

// ── NES name codec — mirrors AWJ font atlas in src/text-utils.js ────────

function encodeNesName(s) {
  const out = [];
  for (const ch of s.slice(0, 8)) {
    const c = ch.charCodeAt(0);
    if (c >= 48 && c <= 57)        out.push(0x80 + (c - 48));        // 0-9
    else if (c >= 65 && c <= 90)   out.push(0x8A + (c - 65));        // A-Z
    else if (c >= 97 && c <= 122)  out.push(0xA4 + (c - 97));        // a-z
  }
  return out;
}

// ── HTTP auth + save seed ───────────────────────────────────────────────

async function http(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(HTTP_BASE + path, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

async function authenticate() {
  console.log(`[bot] auth email=${EMAIL}`);
  let r = await http('POST', '/api/register', { email: EMAIL, password: PASSWORD });
  if (r.status === 201) { console.log('[bot] registered'); return r.body.token; }
  if (r.status === 409) {
    r = await http('POST', '/api/login', { email: EMAIL, password: PASSWORD });
    if (r.status !== 200) throw new Error('login failed: ' + r.status + ' ' + JSON.stringify(r.body));
    console.log('[bot] logged in');
    return r.body.token;
  }
  throw new Error('register failed: ' + r.status + ' ' + JSON.stringify(r.body));
}

async function seedSave(token) {
  // Level-5 Knight stats — meaningful sparring partner, not a one-shot.
  // Inventory empty; PvP arbiter doesn't read items yet (P-4c TODO).
  const save = {
    name:    encodeNesName(NAME),
    level:   5,
    exp:     0,
    hp:      200,
    mp:      0,
    jobIdx:  JOB_IDX,
    palIdx:  PAL_IDX,
    stats: {
      level: 5, exp: 0,
      hp: 200, maxHP: 200, maxMP: 0,
      str: 18, agi: 12, vit: 16, int: 8, mnd: 8,
      weaponR: 0x21, weaponL: 0, head: 0, body: 0, arms: 0,
    },
    inventory: {},
    inventoryOrder: [],
    gil: 0,
    jobLevels: { [JOB_IDX]: { level: 5, jp: 0 } },
    unlockedJobs: 0xFFFFFFFF,
    knownSpells: [],
    consumedTiles: {},
    consumedTilesAt: {},
  };
  const r = await http('POST', '/api/save', { slot: 0, data: save }, token);
  if (r.status !== 200) throw new Error('seed save failed: ' + r.status + ' ' + JSON.stringify(r.body));
  console.log('[bot] save seeded slot=0 hp=200 atk-weapon=0x21');
}

// ── WS session ──────────────────────────────────────────────────────────

const st = {
  ws: null,
  userId: 0,
  battleId: 0,
  yourCellId: 0,
  oppMainCellId: 0,
  turnIdx: 0,
  knownPlayers: new Map(),   // userId → { name, loc, inBattle }
  searchTarget: 0,
  encounterTimer: null,
  reissueTimer: null,
};

function send(msg) {
  if (st.ws && st.ws.readyState === 1) {
    st.ws.send(JSON.stringify(msg));
  }
}

function pickTarget() {
  // First known online human in the same loc, not already in a battle.
  for (const [uid, info] of st.knownPlayers) {
    if (uid === st.userId) continue;
    if (info.loc !== LOC) continue;
    if (info.inBattle) continue;
    return uid;
  }
  return 0;
}

function maybeIssueSearch() {
  if (st.battleId) return;
  const target = pickTarget();
  if (!target) {
    if (st.searchTarget) {
      send({ type: 'pvp-cancel' });
      console.log('[bot] no targets — cancelled search');
      st.searchTarget = 0;
    }
    return;
  }
  if (target !== st.searchTarget) {
    st.searchTarget = target;
    send({ type: 'pvp-search', targetUserId: target });
    const info = st.knownPlayers.get(target);
    console.log(`[bot] pvp-search target=${target} name=${info?.name || '?'} loc=${LOC}`);
  }
}

function pingEncounter() {
  // Server's hook fires on this — picks up any pvp-search targeting US.
  // Cheap (just a JSON ping); server logs every fire.
  if (st.battleId) return;
  send({ type: 'pvp-encounter' });
}

function handleStart(frame) {
  st.battleId = frame.battleId;
  st.yourCellId = frame.yourCellId;
  st.turnIdx = 0;
  const mySide = frame.yourSide;
  const oppSide = mySide === 'A' ? 'B' : 'A';
  const oppCells = frame.sides[oppSide] || [];
  const oppMain = oppCells.find(c => c.isHuman) || oppCells[0];
  st.oppMainCellId = oppMain ? oppMain.cellId : 0;
  console.log(`[bot] ═══ BATTLE START id=${frame.battleId} side=${mySide} myCell=${frame.yourCellId} oppMain=${st.oppMainCellId} (${oppMain?.name || '?'})`);
  sendIntent();
}

function sendIntent() {
  if (!st.battleId) return;
  const msg = {
    type:     'pvp-intent',
    battleId: st.battleId,
    turnIdx:  st.turnIdx,
    kind:     'attack',
    targetCellId: st.oppMainCellId,
  };
  send(msg);
  console.log(`[bot]   → intent turn=${st.turnIdx} attack → cell=${st.oppMainCellId}`);
}

function handleTurn(frame) {
  if (frame.battleId !== st.battleId) {
    console.log(`[bot] turn for stale battleId=${frame.battleId} (current=${st.battleId}) ignored`);
    return;
  }
  let ended = false;
  for (const d of frame.deltas || []) {
    if (d.kind === 'attack') {
      const tag = d.crit ? 'CRIT' : (d.hit ? 'hit' : 'MISS');
      console.log(`[bot]   turn=${frame.turnIdx} attack ${d.actorCellId}→${d.targetCellId} ${tag} dmg=${d.damage}`);
    } else if (d.kind === 'death') {
      console.log(`[bot]   turn=${frame.turnIdx} †death cell=${d.actorCellId}`);
    } else if (d.kind === 'end') {
      console.log(`[bot]   turn=${frame.turnIdx} ═══ END victor=${d.victor}`);
      ended = true;
    } else if (d.kind === 'state') {
      console.log(`[bot]   turn=${frame.turnIdx} state ${d.actorCellId} ${d.change}`);
    } else if (d.kind === 'status-tick') {
      console.log(`[bot]   turn=${frame.turnIdx} ${d.statusKind} tick cell=${d.actorCellId} dmg=${d.damage}`);
    } else {
      console.log(`[bot]   turn=${frame.turnIdx} ${d.kind} ${JSON.stringify(d)}`);
    }
  }
  if (ended) {
    st.battleId = 0;
    st.searchTarget = 0;
    setTimeout(maybeIssueSearch, 2000);
    return;
  }
  st.turnIdx = frame.turnIdx;
  sendIntent();
}

function handleCancel(frame) {
  console.log(`[bot] pvp-cancel reason=${frame.reason} battleId=${frame.battleId}`);
  st.battleId = 0;
  st.searchTarget = 0;
  setTimeout(maybeIssueSearch, 2000);
}

function handleSnapshot(frame) {
  for (const p of frame.players || []) {
    st.knownPlayers.set(p.userId, { name: p.name, loc: p.loc, inBattle: p.inBattle });
  }
  console.log(`[bot] snapshot players=${(frame.players || []).length}`);
  maybeIssueSearch();
}

function handleJoin(frame) {
  const p = frame.player; if (!p) return;
  st.knownPlayers.set(p.userId, { name: p.name, loc: p.loc, inBattle: p.inBattle });
  console.log(`[bot] join userId=${p.userId} name=${p.name} loc=${p.loc}`);
  maybeIssueSearch();
}

function handleLeave(frame) {
  const info = st.knownPlayers.get(frame.userId);
  st.knownPlayers.delete(frame.userId);
  console.log(`[bot] leave userId=${frame.userId} name=${info?.name || '?'}`);
  if (st.searchTarget === frame.userId) {
    st.searchTarget = 0;
    maybeIssueSearch();
  }
}

function handleUpdate(frame) {
  const fields = frame.fields || {};
  const cur = st.knownPlayers.get(frame.userId) || {};
  st.knownPlayers.set(frame.userId, { ...cur, ...fields });
  maybeIssueSearch();
}

function connect(token) {
  console.log(`[bot] connecting ${WS_BASE}/api/ws`);
  const ws = new WebSocket(`${WS_BASE}/api/ws?token=${token}`);
  st.ws = ws;
  ws.on('open', () => console.log('[bot] ws open'));
  ws.on('close', (code, reason) => {
    console.log(`[bot] ws close code=${code} reason=${reason || '(none)'}`);
    st.battleId = 0;
    st.searchTarget = 0;
    st.knownPlayers.clear();
    if (st.encounterTimer) { clearInterval(st.encounterTimer); st.encounterTimer = null; }
    if (st.reissueTimer)   { clearInterval(st.reissueTimer);   st.reissueTimer   = null; }
    setTimeout(() => connect(token), 5000);
  });
  ws.on('error', (e) => console.error('[bot] ws error', e.message));
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    switch (msg.type) {
      case 'ready':
        send({
          type: 'hello',
          profile: {
            name: NAME, jobIdx: JOB_IDX, level: 5, palIdx: PAL_IDX,
            hp: 200, maxHP: 200, agi: 12, inBattle: 0,
            weaponR: 0x21, weaponL: 0, armorId: 0, helmId: 0, shieldId: 0,
            statusMask: 0, slot: 0,
            allies: [],
          },
          loc: LOC,
        });
        console.log(`[bot] hello sent name=${NAME} loc=${LOC} slot=0`);
        // Start the encounter pings + search re-issue heartbeat once we've
        // identified — server requires entry.helloed for both.
        st.encounterTimer = setInterval(pingEncounter, ENCOUNTER_MS);
        st.reissueTimer   = setInterval(() => { if (!st.battleId) maybeIssueSearch(); }, REISSUE_MS);
        break;
      case 'snapshot':     return handleSnapshot(msg);
      case 'player-join':  return handleJoin(msg);
      case 'player-leave': return handleLeave(msg);
      case 'player-update': return handleUpdate(msg);
      case 'pvp-battle-start': return handleStart(msg);
      case 'pvp-turn':         return handleTurn(msg);
      case 'pvp-cancel':       return handleCancel(msg);
      case 'pvp-encounter-none': return;     // expected — no challengers
      case 'pvp-search-failed':
        console.log(`[bot] pvp-search-failed reason=${msg.reason}`);
        st.searchTarget = 0;
        setTimeout(maybeIssueSearch, 5000);
        break;
      default: break;
    }
  });
}

// ── main ────────────────────────────────────────────────────────────────

(async () => {
  const token = await authenticate();
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
  st.userId = payload.userId;
  console.log(`[bot] userId=${st.userId}`);
  await seedSave(token);
  connect(token);
})().catch(e => { console.error('[bot] fatal:', e); process.exit(1); });

process.on('SIGINT', () => { console.log('\n[bot] SIGINT — exiting'); process.exit(0); });
