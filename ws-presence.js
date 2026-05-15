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

// Active PvP searches — challengerUserId → { targetUserId }.
// The hook is rolled on the TARGET's next random encounter (mirroring the
// existing fake-PvP design — A clicks Battle, B's next monster encounter
// has a chance to be replaced by PvP). Server does NOT run a timer; B's
// client signals an encounter via `pvp-encounter` and the server rolls
// hook chance against each challenger of B at that moment.
const _pvpSearches = new Map();

// Hook-chance formula — mirror of `src/pvp-search.js#getHookChance`.
// AGI differential + Thief/Ranger job bonus, clamped to [10%, 75%].
// Constants live alongside the client source for cross-reference (any
// rebalance has to touch both).
const PVP_BASE_HOOK  = 0.25;
const PVP_AGI_PER_PT = 0.015;
const PVP_HOOK_MIN   = 0.10;
const PVP_HOOK_MAX   = 0.75;
const PVP_JOB_BONUS  = { 6: 0.08, 8: 0.15 };  // Ranger, Thief

function _pvpHookChance(challengerProfile, targetProfile) {
  const chAGI  = (challengerProfile && challengerProfile.agi) || 5;
  const tgtAGI = (targetProfile && targetProfile.agi) || 5;
  const jobBonus = PVP_JOB_BONUS[challengerProfile && challengerProfile.jobIdx] || 0;
  const raw = PVP_BASE_HOOK + (chAGI - tgtAGI) * PVP_AGI_PER_PT + jobBonus;
  return Math.max(PVP_HOOK_MIN, Math.min(PVP_HOOK_MAX, raw));
}

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
  _pvpSearches.delete(challengerUserId);
}

// B's client sent `pvp-encounter` — they're about to start a random encounter.
// Find every challenger targeting B and roll hook chance for each in order
// (oldest search first). First hit wins: match B against that challenger,
// cancel B's other suitors. If all miss (or there are no challengers),
// reply with `pvp-encounter-none` so B starts the regular monster fight.
function _resolveEncounterHook(targetEntry) {
  const targetUserId = targetEntry.userId;
  const challengers = [];
  for (const [chId, s] of _pvpSearches) {
    if (s.targetUserId !== targetUserId) continue;
    const ch = _connected.get(chId);
    if (!ch || !ch.helloed) continue;
    if (ch.loc !== targetEntry.loc) continue;  // moved away — stale search, skip
    challengers.push(ch);
  }
  let hookedChallenger = null;
  for (const ch of challengers) {
    const chance = _pvpHookChance(ch.profile, targetEntry.profile);
    if (Math.random() < chance) { hookedChallenger = ch; break; }
  }
  if (!hookedChallenger) {
    _send(targetEntry.ws, { type: 'pvp-encounter-none' });
    return;
  }
  // Match. Broadcast pvp-match to both parties with each other's profile.
  const targetOpp = {
    userId: targetEntry.userId, ...targetEntry.profile, loc: targetEntry.loc,
  };
  const challengerOpp = {
    userId: hookedChallenger.userId, ...hookedChallenger.profile, loc: hookedChallenger.loc,
  };
  _send(hookedChallenger.ws, { type: 'pvp-match', opponent: targetOpp });
  _send(targetEntry.ws,      { type: 'pvp-match', opponent: challengerOpp });
  // Clear winning challenger's search.
  _clearSearch(hookedChallenger.userId);
  // Cancel every OTHER challenger of B (and of the winning challenger, if any
  // were targeting them too). Per the audit's "first-hook-wins" rule.
  for (const [chId, s] of [..._pvpSearches]) {
    if (s.targetUserId === targetUserId || s.targetUserId === hookedChallenger.userId) {
      _clearSearch(chId);
      const otherCh = _connected.get(chId);
      if (otherCh && otherCh.helloed) {
        _send(otherCh.ws, { type: 'pvp-search-failed', reason: 'target-engaged' });
      }
    }
  }
  // If B was ALSO searching someone, drop B's outgoing search too.
  if (_pvpSearches.has(targetUserId)) _clearSearch(targetUserId);
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
        agi:      profile.agi | 0,
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
      for (const k of ['name', 'jobIdx', 'level', 'palIdx', 'hp', 'maxHP', 'agi',
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
      // Replace any existing search by this challenger. No server-side timer —
      // the hook rolls on B's next random encounter (handled in `pvp-encounter`).
      _clearSearch(entry.userId);
      _pvpSearches.set(entry.userId, { targetUserId });
      return;
    }
    case 'pvp-cancel': {
      _clearSearch(entry.userId);
      return;
    }
    case 'pvp-encounter': {
      // B's client is about to start a random encounter. Roll hook chance
      // against any pending challengers; reply with `pvp-match` (on hit) or
      // `pvp-encounter-none` (on miss / no challengers) so B can branch.
      if (!entry.helloed) {
        _send(entry.ws, { type: 'pvp-encounter-none' });
        return;
      }
      _resolveEncounterHook(entry);
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
