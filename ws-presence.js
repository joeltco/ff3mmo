// ws-presence.js — WebSocket presence for ff3mmo multiplayer Step 1.
//
// Mounted on the existing HTTP server via the 'upgrade' event so a single
// node process serves both static files / REST API and real-time presence.
//
// Auth: JWT passed as `?token=...` on the upgrade URL (browsers can't set
// Authorization headers on WebSocket connections). Reused from api.js
// without re-issuing — the existing 30-day token is valid here too.
//
// Wire protocol (JSON over text frames):
//
//   client → server:
//     { type: 'hello', profile: { name, jobIdx, level, palIdx, hp, maxHP,
//                                  weaponR, weaponL?, armorId, helmId,
//                                  shieldId? }, loc: 'world'|'ur'|... }
//         Sent ONCE after the save slot is loaded. Without it, the user is
//         authenticated but invisible to other players.
//     { type: 'location', loc }
//         Sent when the local player crosses a map boundary (overworld →
//         town, town → cave, etc).
//     { type: 'update', ...profileFields }
//         Sent when equipment, level, hp, or palIdx changes mid-session.
//
//   server → client:
//     { type: 'snapshot', players: [{userId, ...profile, loc}] }
//         Sent immediately after `hello` — the full current presence map.
//     { type: 'player-join', player: {userId, ...profile, loc} }
//         Broadcast to OTHER clients when a player sends `hello`.
//     { type: 'player-leave', userId }
//         Broadcast when a player's WebSocket closes (or they explicitly leave).
//     { type: 'player-move', userId, loc }
//         Broadcast when a player changes location.
//     { type: 'player-update', userId, fields }
//         Broadcast when a player's profile fields change.
//
// Presence state is in-memory only. Restarting the server drops all
// presence; clients reconnect on next page load. DB-backed persistence
// is a Step 2/3 concern — for visible Step 1 it's not needed.

import { WebSocketServer } from 'ws';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'ff3mmo-dev-secret-change-in-prod';

// userId → { ws, userId, profile, loc, helloed }
// `helloed=false` means authenticated but not yet visible to other players
// (no `hello` message received). Snapshots only include `helloed=true` players.
const _connected = new Map();

// Active PvP searches — challengerUserId → { targetUserId, timer }.
// Server-driven replacement for the v1.7.222 client-side sim timer in
// `src/pvp-search.js`. On `pvp-search` from a client, server starts a
// roll timer (8-15 s). On fire, rolls hook chance; hit → broadcast
// `pvp-match` to both parties + clear search; miss → re-arm.
const _pvpSearches = new Map();
const PVP_ROLL_MIN_MS  = 8000;
const PVP_ROLL_RANGE_MS = 7000;
const PVP_HOOK_CHANCE  = 0.35;  // fixed for MVP — stat-aware arbitration is Step 4.

function _broadcast(payload, exceptUserId = null) {
  const msg = JSON.stringify(payload);
  for (const [uid, entry] of _connected) {
    if (uid === exceptUserId) continue;
    if (!entry.helloed) continue;  // not visible yet
    if (entry.ws.readyState !== 1) continue;  // 1 = OPEN
    try { entry.ws.send(msg); } catch { /* drop */ }
  }
}

function _send(ws, payload) {
  if (ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(payload)); } catch { /* drop */ }
}

function _clearSearch(challengerUserId) {
  const s = _pvpSearches.get(challengerUserId);
  if (!s) return;
  if (s.timer) clearTimeout(s.timer);
  _pvpSearches.delete(challengerUserId);
}

function _startSearchRoll(challengerUserId) {
  const search = _pvpSearches.get(challengerUserId);
  if (!search) return;
  const rollMs = PVP_ROLL_MIN_MS + Math.random() * PVP_ROLL_RANGE_MS;
  search.timer = setTimeout(() => _runSearchHook(challengerUserId), rollMs);
}

function _runSearchHook(challengerUserId) {
  const search = _pvpSearches.get(challengerUserId);
  if (!search) return;
  search.timer = null;
  const challenger = _connected.get(challengerUserId);
  const target     = _connected.get(search.targetUserId);
  // Either party gone / not helloed → abort search.
  if (!challenger || !target || !challenger.helloed || !target.helloed) {
    _clearSearch(challengerUserId);
    if (challenger && challenger.helloed) {
      _send(challenger.ws, { type: 'pvp-search-failed', reason: 'target-offline' });
    }
    return;
  }
  // Target moved to a different location since the search started — abort.
  if (challenger.loc !== target.loc) {
    _clearSearch(challengerUserId);
    _send(challenger.ws, { type: 'pvp-search-failed', reason: 'target-left' });
    return;
  }
  // Roll hook chance. Miss → re-arm.
  if (Math.random() >= PVP_HOOK_CHANCE) {
    _startSearchRoll(challengerUserId);
    return;
  }
  // Hit — broadcast pvp-match to both with each other's profile, then clear
  // both sides' search state. Per the audit's "first-hook-wins" rule, any
  // OTHER searches targeting this challenger or target are also cancelled —
  // those challengers get a "missed" failure so they know to back off.
  const challengerOpp = { userId: target.userId, ...target.profile, loc: target.loc };
  const targetOpp     = { userId: challenger.userId, ...challenger.profile, loc: challenger.loc };
  _send(challenger.ws, { type: 'pvp-match', opponent: challengerOpp });
  _send(target.ws,     { type: 'pvp-match', opponent: targetOpp });
  _clearSearch(challengerUserId);
  // Cancel target's outgoing search if any (target was both A→B and B→C).
  if (_pvpSearches.has(search.targetUserId)) _clearSearch(search.targetUserId);
  // Cancel any other searches aimed at either side.
  for (const [chId, s] of _pvpSearches) {
    if (s.targetUserId === challenger.userId || s.targetUserId === target.userId) {
      _clearSearch(chId);
      const otherCh = _connected.get(chId);
      if (otherCh && otherCh.helloed) {
        _send(otherCh.ws, { type: 'pvp-search-failed', reason: 'target-engaged' });
      }
    }
  }
}

function _snapshotPayload(excludeUserId) {
  const players = [];
  for (const [uid, entry] of _connected) {
    if (uid === excludeUserId) continue;
    if (!entry.helloed) continue;
    players.push({ userId: uid, ...entry.profile, loc: entry.loc });
  }
  return { type: 'snapshot', players };
}

function _handleMessage(entry, msg) {
  let parsed;
  try { parsed = JSON.parse(msg); }
  catch { return; }
  if (!parsed || typeof parsed !== 'object') return;

  switch (parsed.type) {
    case 'hello': {
      // First identification — register profile + loc and broadcast join.
      const profile = parsed.profile || {};
      entry.profile = {
        name:     String(profile.name || 'Player').slice(0, 16),
        jobIdx:   profile.jobIdx | 0,
        level:    profile.level | 0,
        palIdx:   profile.palIdx | 0,
        hp:       profile.hp | 0,
        maxHP:    profile.maxHP | 0,
        weaponR:  profile.weaponR | 0,
        weaponL:  profile.weaponL == null ? undefined : profile.weaponL | 0,
        armorId:  profile.armorId | 0,
        helmId:   profile.helmId | 0,
        shieldId: profile.shieldId == null ? undefined : profile.shieldId | 0,
      };
      entry.loc = String(parsed.loc || 'ur').slice(0, 16);
      const wasHelloed = entry.helloed;
      entry.helloed = true;
      // Send the current snapshot to the new client so they see everyone else.
      _send(entry.ws, _snapshotPayload(entry.userId));
      // Broadcast join to OTHER clients. If `hello` is resent (re-identify
      // after a save-slot swap), broadcast a `player-update` instead.
      if (!wasHelloed) {
        _broadcast({
          type: 'player-join',
          player: { userId: entry.userId, ...entry.profile, loc: entry.loc },
        }, entry.userId);
      } else {
        _broadcast({
          type: 'player-update',
          userId: entry.userId,
          fields: { ...entry.profile, loc: entry.loc },
        }, entry.userId);
      }
      return;
    }
    case 'location': {
      if (!entry.helloed) return;
      const loc = String(parsed.loc || '').slice(0, 16);
      if (!loc || loc === entry.loc) return;
      entry.loc = loc;
      _broadcast({ type: 'player-move', userId: entry.userId, loc }, entry.userId);
      return;
    }
    case 'update': {
      if (!entry.helloed) return;
      const fields = {};
      for (const k of ['name', 'jobIdx', 'level', 'palIdx', 'hp', 'maxHP',
                       'weaponR', 'weaponL', 'armorId', 'helmId', 'shieldId']) {
        if (parsed[k] != null) {
          entry.profile[k] = parsed[k];
          fields[k] = parsed[k];
        }
      }
      if (Object.keys(fields).length === 0) return;
      _broadcast({ type: 'player-update', userId: entry.userId, fields }, entry.userId);
      return;
    }
    case 'pvp-search': {
      if (!entry.helloed) return;
      const targetUserId = parsed.targetUserId | 0;
      if (!targetUserId || targetUserId === entry.userId) return;
      const target = _connected.get(targetUserId);
      if (!target || !target.helloed) {
        _send(entry.ws, { type: 'pvp-search-failed', reason: 'offline' });
        return;
      }
      if (target.loc !== entry.loc) {
        _send(entry.ws, { type: 'pvp-search-failed', reason: 'different-location' });
        return;
      }
      // Cancel any existing search by this challenger before starting a new one.
      _clearSearch(entry.userId);
      _pvpSearches.set(entry.userId, { targetUserId, timer: null });
      _startSearchRoll(entry.userId);
      return;
    }
    case 'pvp-cancel': {
      _clearSearch(entry.userId);
      return;
    }
    case 'chat': {
      // Multiplayer Step 2 — relay world / party / pm chat to other clients.
      // World chat = location-scoped (everyone at the same `loc` sees it).
      // PM chat = targeted by `to` (recipient's display name); the server
      // looks up the matching user. Party chat is currently location-scoped
      // too (full party-state isn't wired across the wire yet — Step 3+).
      if (!entry.helloed) return;
      const channel = String(parsed.channel || 'world');
      const text = String(parsed.text || '').slice(0, 200);
      if (!text) return;
      const senderName = entry.profile?.name || 'Player';
      if (channel === 'pm') {
        const toName = String(parsed.to || '').slice(0, 16);
        if (!toName) return;
        // Find the recipient by display name. Names aren't unique in the
        // engine (it's just whatever the player typed), so deliver to ALL
        // matching connected users for now. Step 3+ should resolve via
        // userId.
        for (const [, target] of _connected) {
          if (!target.helloed) continue;
          if (target.profile?.name !== toName) continue;
          _send(target.ws, { type: 'chat', userId: entry.userId, name: senderName,
                             channel, text, to: toName });
        }
        // Echo back to the sender's other tabs (none today but harmless).
        return;
      }
      // World / party — broadcast to others at the same location. Sender's
      // own client already added the message locally, so exclude them.
      for (const [uid, target] of _connected) {
        if (uid === entry.userId) continue;
        if (!target.helloed) continue;
        if (target.loc !== entry.loc) continue;
        _send(target.ws, { type: 'chat', userId: entry.userId, name: senderName,
                           channel, text });
      }
      return;
    }
  }
}

export function attachWebSocketPresence(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/api/ws') {
      socket.destroy();
      return;
    }
    const token = url.searchParams.get('token');
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    let decoded;
    try { decoded = jwt.verify(token, JWT_SECRET); }
    catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const userId = decoded.userId;

    // If a previous WS is still open for this user (page reload race),
    // close it. The new connection wins.
    const stale = _connected.get(userId);
    if (stale && stale.ws.readyState <= 1) {
      try { stale.ws.close(4001, 'replaced'); } catch { /* drop */ }
      _connected.delete(userId);
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const entry = { ws, userId, profile: null, loc: null, helloed: false };
      _connected.set(userId, entry);

      ws.on('message', (data) => _handleMessage(entry, data.toString()));
      ws.on('close', () => {
        const cur = _connected.get(userId);
        if (cur === entry) _connected.delete(userId);
        // Cancel this user's outgoing PvP search if any.
        _clearSearch(userId);
        // Cancel any searches targeting this user — notify each challenger.
        for (const [chId, s] of [..._pvpSearches]) {
          if (s.targetUserId !== userId) continue;
          _clearSearch(chId);
          const challenger = _connected.get(chId);
          if (challenger && challenger.helloed) {
            _send(challenger.ws, { type: 'pvp-search-failed', reason: 'target-offline' });
          }
        }
        if (entry.helloed) {
          _broadcast({ type: 'player-leave', userId }, userId);
        }
      });
      ws.on('error', () => { /* close handler runs on its own */ });

      // Auth-acknowledge so the client knows it can send `hello`.
      _send(ws, { type: 'ready', userId });
    });
  });

  return wss;
}
