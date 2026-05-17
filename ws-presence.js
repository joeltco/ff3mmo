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
import { verifyTokenWithRevocation } from './api.js';
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

// Active PvP battle partners — userId → partnerUserId. Set on pvp-match,
// cleared on disconnect. The server relays `pvp-action` between partners
// so each client drives its opponent's turn from the remote player's actual
// chosen action instead of local AI (MP Step 4 part 2).
const _pvpPartners = new Map();

// Pending party invites — challengerUserId → targetUserId. Set on
// `party-invite`, cleared on `party-cancel` / response / disconnect.
const _partyInvites = new Map();

// Active party memberships — memberUserId → inviterUserId. Enforces the
// one-party-per-player invariant: server rejects a new `party-invite`
// targeting someone who's already a member. Cleared by explicit
// `party-dismiss` from the inviter, `party-leave` from the member, or
// disconnect of either side.
const _partyMemberships = new Map();

// Active co-op random-encounter groups — userId → Set<peerUserId>. Built
// when a host's client emits `encounter-start` for a monster fight that
// pulls in party members; cleared on `encounter-end` / disconnect / the
// last peer dropping. Bidirectional: if A's set has B and C, then B's set
// has A and C, and C's has A and B. Mirror of `_pvpPartners` but
// multi-peer. v1.7.418.
const _encounterGroups = new Map();

function _clearEncounterGroup(userId) {
  const peers = _encounterGroups.get(userId);
  if (!peers) return;
  _encounterGroups.delete(userId);
  for (const peerId of peers) {
    const peerSet = _encounterGroups.get(peerId);
    if (!peerSet) continue;
    peerSet.delete(userId);
    if (peerSet.size === 0) _encounterGroups.delete(peerId);
  }
}

// Hook-chance formula — mirror of `src/pvp-search.js#getHookChance`.
// AGI differential + Thief/Ranger job bonus, clamped to [10%, 75%].
// Constants live alongside the client source for cross-reference (any
// rebalance has to touch both).
const PVP_BASE_HOOK  = 0.25;
const PVP_AGI_PER_PT = 0.015;
const PVP_HOOK_MIN   = 0.10;
const PVP_HOOK_MAX   = 0.75;
const PVP_JOB_BONUS  = { 6: 0.08, 8: 0.15 };  // Ranger, Thief

// Range clamps for trusted profile fields. The hook-chance formula reads
// `agi` and `jobIdx` straight out of the broadcast profile, so any
// unvalidated value lets a malicious client manipulate match-making.
// See docs/MULTIPLAYER-AUDIT-2026-05-15.md #7.
function _clamp(n, min, max) {
  const v = n | 0;
  return v < min ? min : (v > max ? max : v);
}

// Sanitize a single profile field (called from both `hello` and `update`).
// Unknown keys fall through untouched — caller is responsible for the
// allow-list. Returns `undefined` when the input couldn't be normalized;
// the caller should drop the field in that case.
function _normalizeProfileField(key, value) {
  if (value == null) return undefined;
  switch (key) {
    case 'name': return String(value).slice(0, 16);
    case 'jobIdx':   return _clamp(value, 0, 31);
    case 'level':    return _clamp(value, 1, 99);
    case 'palIdx':   return _clamp(value, 0, 31);
    case 'hp':       return _clamp(value, 0, 9999);
    case 'maxHP':    return _clamp(value, 1, 9999);
    case 'agi':      return _clamp(value, 1, 99);
    case 'inBattle': return _clamp(value, 0, 1);
    case 'weaponR':
    case 'armorId':
    case 'helmId':   return _clamp(value, 0, 255);
    case 'weaponL':
    case 'shieldId': return value == null ? undefined : _clamp(value, 0, 255);
    case 'allies':   return Array.isArray(value) ? value.slice(0, 3) : undefined;
    default: return undefined;
  }
}

function _pvpHookChance(challengerProfile, targetProfile) {
  const chAGI  = (challengerProfile && challengerProfile.agi) || 5;
  const tgtAGI = (targetProfile && targetProfile.agi) || 5;
  const jobBonus = PVP_JOB_BONUS[challengerProfile && challengerProfile.jobIdx] || 0;
  const raw = PVP_BASE_HOOK + (chAGI - tgtAGI) * PVP_AGI_PER_PT + jobBonus;
  return Math.max(PVP_HOOK_MIN, Math.min(PVP_HOOK_MAX, raw));
}

// Per-connection token bucket. Capacity 60 messages, refill 20/s. Each
// incoming frame consumes one token before any handling. Excess frames are
// dropped silently. Bursting is fine (60 tokens covers a typical 500 ms
// poll storm at session start); sustained flood is throttled.
// See docs/MULTIPLAYER-AUDIT-2026-05-15.md #6.
const RATE_CAPACITY  = 60;
const RATE_REFILL_PS = 20;

function _rateAllow(entry) {
  const now = Date.now();
  if (entry._rateTokens == null) {
    entry._rateTokens = RATE_CAPACITY;
    entry._rateRefilledAt = now;
  }
  const elapsed = (now - entry._rateRefilledAt) / 1000;
  if (elapsed > 0) {
    entry._rateTokens = Math.min(RATE_CAPACITY, entry._rateTokens + elapsed * RATE_REFILL_PS);
    entry._rateRefilledAt = now;
  }
  if (entry._rateTokens < 1) return false;
  entry._rateTokens -= 1;
  return true;
}

// Per-kind sub-buckets. The global bucket above stops a single connection
// from drowning the server, but it's a shared pool: 60 `chat` frames in a
// burst would exhaust the bucket for that connection's `pvp-action`,
// `encounter-action`, etc. These smaller per-kind buckets cap the
// kinds that are user-action-driven (not poll-driven) so spamming one
// can't starve the others. Frames not listed here are global-bucket-only.
// v1.7.426.
const PER_KIND_RATES = {
  'chat':                      { cap: 20, refill: 5 },
  'encounter-assist-request':  { cap: 6,  refill: 1 },
  'encounter-start':           { cap: 6,  refill: 1 },
  'give-item':                 { cap: 6,  refill: 1 },
  'party-invite':              { cap: 6,  refill: 1 },
};
function _rateAllowKind(entry, kind) {
  const rate = PER_KIND_RATES[kind];
  if (!rate) return true;
  if (!entry._kindRates) entry._kindRates = Object.create(null);
  let b = entry._kindRates[kind];
  const now = Date.now();
  if (!b) {
    b = { tokens: rate.cap, refilledAt: now };
    entry._kindRates[kind] = b;
  }
  const elapsed = (now - b.refilledAt) / 1000;
  if (elapsed > 0) {
    b.tokens = Math.min(rate.cap, b.tokens + elapsed * rate.refill);
    b.refilledAt = now;
  }
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// Returns true when A and B are in the same party (one inviter + their
// active members). Used to gate `chat` channel='party' so a stray "party"
// message from someone in the same location doesn't leak into another
// party's tab. See docs/MULTIPLAYER-AUDIT-2026-05-15.md #22.
function _inSameParty(uidA, uidB) {
  if (uidA === uidB) return true;
  const aInviter = _partyMemberships.get(uidA);
  const bInviter = _partyMemberships.get(uidB);
  if (aInviter && bInviter) return aInviter === bInviter;          // both members of same party
  if (aInviter) return aInviter === uidB;                          // A is member, B is inviter
  if (bInviter) return bInviter === uidA;                          // B is member, A is inviter
  return false;                                                    // neither is in any party
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
  const skipped = [];
  for (const [chId, s] of _pvpSearches) {
    if (s.targetUserId !== targetUserId) continue;
    const ch = _connected.get(chId);
    if (!ch) { skipped.push({ chId, reason: 'not-connected' }); continue; }
    if (!ch.helloed) { skipped.push({ chId, reason: 'not-helloed' }); continue; }
    if (ch.loc !== targetEntry.loc) { skipped.push({ chId, reason: 'loc-mismatch', chLoc: ch.loc, tgtLoc: targetEntry.loc }); continue; }
    challengers.push(ch);
  }
  console.log('[pvp-hook] target=' + targetUserId + ' loc=' + targetEntry.loc +
    ' searches=' + _pvpSearches.size + ' candidates=' + challengers.length +
    (skipped.length ? ' skipped=' + JSON.stringify(skipped) : ''));
  let hookedChallenger = null;
  for (const ch of challengers) {
    const chance = _pvpHookChance(ch.profile, targetEntry.profile);
    const roll = Math.random();
    console.log('[pvp-hook] roll challenger=' + ch.userId + ' chance=' + chance.toFixed(3) + ' roll=' + roll.toFixed(3) + ' hit=' + (roll < chance));
    if (roll < chance) { hookedChallenger = ch; break; }
  }
  if (!hookedChallenger) {
    console.log('[pvp-hook] no-hook → pvp-encounter-none to target=' + targetUserId);
    _send(targetEntry.ws, { type: 'pvp-encounter-none' });
    return;
  }
  console.log('[pvp-hook] HIT challenger=' + hookedChallenger.userId + ' target=' + targetUserId);
  // Match. Broadcast pvp-match to both parties with each other's profile.
  // MP Step 4 — also broadcast a shared 32-bit RNG seed. Both clients seed
  // their mulberry32 (`src/rng.js`) before `_startPVPBattle` runs, so
  // initiative rolls / damage rolls / AI picks come out identical on both
  // sides. Until action-relay lands, AI on each side may still drift if it
  // reads UNSYNCED state (e.g., the opponent's chosen target), but at least
  // every roll inside `battle-math.js` agrees.
  const seed = (Math.random() * 0xffffffff) >>> 0;
  const targetOpp = {
    userId: targetEntry.userId, ...targetEntry.profile, loc: targetEntry.loc,
  };
  const challengerOpp = {
    userId: hookedChallenger.userId, ...hookedChallenger.profile, loc: hookedChallenger.loc,
  };
  _send(hookedChallenger.ws, { type: 'pvp-match', opponent: targetOpp, seed });
  _send(targetEntry.ws,      { type: 'pvp-match', opponent: challengerOpp, seed });
  // Register partners for action relay (MP Step 4 part 2).
  _pvpPartners.set(hookedChallenger.userId, targetEntry.userId);
  _pvpPartners.set(targetEntry.userId, hookedChallenger.userId);
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
  if (!_rateAllow(entry)) return;
  let parsed;
  try { parsed = JSON.parse(msg); }
  catch { return; }
  if (!parsed || typeof parsed !== 'object') return;
  if (!_rateAllowKind(entry, parsed.type)) return;

  switch (parsed.type) {
    case 'hello': {
      // First identification — register profile + loc and broadcast join.
      // Every field passes through `_normalizeProfileField` so the broadcast
      // payload is trusted by the time it lands on other clients (the
      // hook-chance formula reads agi / jobIdx straight out of this map).
      const profile = parsed.profile || {};
      entry.profile = {
        name:     _normalizeProfileField('name',     profile.name) || 'Player',
        jobIdx:   _normalizeProfileField('jobIdx',   profile.jobIdx) ?? 0,
        level:    _normalizeProfileField('level',    profile.level) ?? 1,
        palIdx:   _normalizeProfileField('palIdx',   profile.palIdx) ?? 0,
        hp:       _normalizeProfileField('hp',       profile.hp) ?? 0,
        maxHP:    _normalizeProfileField('maxHP',    profile.maxHP) ?? 1,
        agi:      _normalizeProfileField('agi',      profile.agi) ?? 5,
        inBattle: _normalizeProfileField('inBattle', profile.inBattle) ?? 0,
        weaponR:  _normalizeProfileField('weaponR',  profile.weaponR) ?? 0,
        weaponL:  _normalizeProfileField('weaponL',  profile.weaponL),
        armorId:  _normalizeProfileField('armorId',  profile.armorId) ?? 0,
        helmId:   _normalizeProfileField('helmId',   profile.helmId) ?? 0,
        shieldId: _normalizeProfileField('shieldId', profile.shieldId),
        // MP party-PvP — opaque ally roster; server doesn't validate the
        // inner stats, just enforces array shape + cap. Each side computes
        // damage locally from these so a synthesized roster only screws
        // over the sender.
        allies:   _normalizeProfileField('allies',   profile.allies) || [],
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
      // v1.7.388 — clean up loc-scoped state that became stale on this move.
      // Pre-fix the challenger could walk out of the search area and sit at
      // "Searching..." until the 5-min timeout because the server silently
      // skipped their entry in `_resolveEncounterHook`. Same for party
      // invites; the invite would tick until timeout with no signal back.
      // See docs/MULTIPLAYER-AUDIT-2026-05-15.md #11.
      const myOutSearch = _pvpSearches.get(entry.userId);
      if (myOutSearch) {
        const tgt = _connected.get(myOutSearch.targetUserId);
        if (!tgt || tgt.loc !== loc) {
          _clearSearch(entry.userId);
          _send(entry.ws, { type: 'pvp-search-failed', reason: 'different-location' });
        }
      }
      for (const [chId, s] of [..._pvpSearches]) {
        if (s.targetUserId !== entry.userId) continue;
        const ch = _connected.get(chId);
        if (!ch || ch.loc === loc) continue;       // challenger followed us — keep search
        _clearSearch(chId);
        if (ch.helloed) _send(ch.ws, { type: 'pvp-search-failed', reason: 'different-location' });
      }
      return;
    }
    case 'update': {
      if (!entry.helloed) return;
      // Route every field through the same normalizer `hello` uses. Skipping
      // this lets a client `update {agi: 9999}` and corrupt hook-chance math
      // for every other player who reads the broadcast.
      const fields = {};
      for (const k of ['name', 'jobIdx', 'level', 'palIdx', 'hp', 'maxHP', 'agi',
                       'weaponR', 'weaponL', 'armorId', 'helmId', 'shieldId',
                       'allies', 'inBattle']) {
        if (parsed[k] == null) continue;
        const v = _normalizeProfileField(k, parsed[k]);
        if (v === undefined) continue;
        entry.profile[k] = v;
        fields[k] = v;
      }
      if (Object.keys(fields).length === 0) return;
      _broadcast({ type: 'player-update', userId: entry.userId, fields }, entry.userId);
      return;
    }
    case 'pvp-search': {
      if (!entry.helloed) { console.log('[pvp-search] reject reason=not-helloed user=' + entry.userId); return; }
      const targetUserId = parsed.targetUserId | 0;
      if (!targetUserId || targetUserId === entry.userId) { console.log('[pvp-search] reject reason=bad-target user=' + entry.userId + ' target=' + targetUserId); return; }
      const target = _connected.get(targetUserId);
      if (!target || !target.helloed) {
        console.log('[pvp-search] fail reason=offline user=' + entry.userId + ' target=' + targetUserId);
        _send(entry.ws, { type: 'pvp-search-failed', reason: 'offline' });
        return;
      }
      if (target.loc !== entry.loc) {
        console.log('[pvp-search] fail reason=loc-mismatch user=' + entry.userId + ' loc=' + entry.loc + ' target=' + targetUserId + ' tgtLoc=' + target.loc);
        _send(entry.ws, { type: 'pvp-search-failed', reason: 'different-location' });
        return;
      }
      // Replace any existing search by this challenger. No server-side timer —
      // the hook rolls on B's next random encounter (handled in `pvp-encounter`).
      _clearSearch(entry.userId);
      _pvpSearches.set(entry.userId, { targetUserId });
      console.log('[pvp-search] OK user=' + entry.userId + ' target=' + targetUserId + ' loc=' + entry.loc);
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
        console.log('[pvp-encounter] reject reason=not-helloed user=' + entry.userId);
        _send(entry.ws, { type: 'pvp-encounter-none' });
        return;
      }
      console.log('[pvp-encounter] from user=' + entry.userId + ' loc=' + entry.loc);
      _resolveEncounterHook(entry);
      return;
    }
    case 'pvp-ally-join': {
      // Mid-battle ally pick on the sender's player team. Server relays the
      // raw profile to the partner so they can run their own
      // `generateAllyStats` and add the mirror to `pvpEnemyAllies` — works
      // whether the ally is a fake-roster pick, a party member, or any other
      // source. Server doesn't validate the inner stats; receiver re-derives
      // everything via `generateAllyStats(profile)`.
      // See docs/MULTIPLAYER-AUDIT-2026-05-15.md #18.
      if (!entry.helloed) { console.log('[pvp-ally-join] reject reason=not-helloed user=' + entry.userId); return; }
      const partnerId = _pvpPartners.get(entry.userId);
      if (!partnerId) { console.log('[pvp-ally-join] reject reason=no-partner user=' + entry.userId); return; }
      const partner = _connected.get(partnerId);
      if (!partner || partner.ws.readyState !== 1) { console.log('[pvp-ally-join] reject reason=partner-dead user=' + entry.userId); return; }
      const profile = parsed.profile || (parsed.name ? { name: parsed.name } : null);
      if (!profile) { console.log('[pvp-ally-join] reject reason=no-profile user=' + entry.userId); return; }
      profile.name = String(profile.name || '').slice(0, 16);
      console.log('[pvp-ally-join] relay user=' + entry.userId + ' → partner=' + partnerId + ' ally=' + profile.name);
      _send(partner.ws, { type: 'pvp-ally-join', profile });
      return;
    }
    case 'pvp-action': {
      // MP Step 4 part 2 — relay the player's chosen action to their PvP
      // partner so the partner's client can drive the opponent's turn from
      // real input rather than local AI. Server doesn't validate / interpret
      // — clients run the existing engine and arrive at identical outcomes
      // via the synced seed (Step 4 part 1).
      if (!entry.helloed) { console.log('[pvp-action] reject reason=not-helloed user=' + entry.userId); return; }
      const partnerId = _pvpPartners.get(entry.userId);
      if (!partnerId) { console.log('[pvp-action] reject reason=no-partner user=' + entry.userId + ' kind=' + parsed.kind); return; }
      const partner = _connected.get(partnerId);
      if (!partner || partner.ws.readyState !== 1) { console.log('[pvp-action] reject reason=partner-dead user=' + entry.userId + ' partner=' + partnerId); return; }
      console.log('[pvp-action] relay user=' + entry.userId + ' → partner=' + partnerId + ' kind=' + parsed.kind + ' actor=' + (parsed.actor && parsed.actor.idx));
      _send(partner.ws, {
        type:       'pvp-action',
        kind:       parsed.kind,
        actor:      parsed.actor,         // { idx } — sender's cell
        target:     parsed.target,        // { side: 'me'|'opp', idx } — sender's perspective
        spellId:    parsed.spellId,       // for kind === 'magic'
        itemId:     parsed.itemId,        // for kind === 'item'
        damageRoll: parsed.damageRoll,    // v1.7.389 — sender's pre-rolled damage (audit #24)
        healAmount: parsed.healAmount,    // v1.7.389 — sender's pre-rolled heal (audit #24)
        hitResults: parsed.hitResults,    // v1.7.407 — sender's pre-rolled physical hits
      });
      return;
    }
    case 'give-item': {
      // Sender used a heal / cure item from their pause-menu inventory on a
      // roster target. Server forwards to `targetUserId` so their client can
      // apply the same effect to their own `ps`. Sender already consumed the
      // item locally; server doesn't validate ownership (trust-but-verify
      // model — client paths gate on inventory state, and the worst-case
      // abuse is healing someone you don't actually have the items for, which
      // costs the abuser nothing the partner could lose). v1.7.416.
      if (!entry.helloed) return;
      const targetUserId = parsed.targetUserId | 0;
      if (!targetUserId || targetUserId === entry.userId) return;
      const target = _connected.get(targetUserId);
      if (!target || !target.helloed) return;
      const itemId = parsed.itemId | 0;
      if (!itemId) return;
      console.log('[give-item] relay user=' + entry.userId + ' → ' + targetUserId + ' item=0x' + itemId.toString(16));
      _send(target.ws, {
        type: 'give-item',
        fromUserId: entry.userId,
        fromName: entry.profile.name,
        itemId,
      });
      return;
    }
    case 'party-invite': {
      // A invites B. Server records the pending invite and forwards to B
      // with A's profile so B's client can prompt the player. One invite
      // per challenger at a time — new invite replaces old.
      if (!entry.helloed) return;
      const targetUserId = parsed.targetUserId | 0;
      if (!targetUserId || targetUserId === entry.userId) return;
      const target = _connected.get(targetUserId);
      if (!target || !target.helloed) {
        _send(entry.ws, { type: 'party-invite-result', accept: false, reason: 'offline' });
        return;
      }
      // One-party-per-player — reject immediately if B is already a member.
      // B's client never sees the prompt; A gets a 'busy' reason back so
      // the standard cooldown applies + the user knows why it failed.
      if (_partyMemberships.has(targetUserId)) {
        _send(entry.ws, { type: 'party-invite-result', accept: false, reason: 'busy' });
        return;
      }
      _partyInvites.set(entry.userId, targetUserId);
      _send(target.ws, {
        type: 'party-invite-incoming',
        challengerUserId: entry.userId,
        challenger: { userId: entry.userId, ...entry.profile, loc: entry.loc },
      });
      return;
    }
    case 'party-cancel': {
      _partyInvites.delete(entry.userId);
      return;
    }
    case 'party-invite-response': {
      // B answers the invite. Find the challenger by looking up the invite
      // that targets B, forward A's profile alongside the accept flag.
      if (!entry.helloed) return;
      const accept = !!parsed.accept;
      let challengerId = null;
      for (const [chId, tgtId] of _partyInvites) {
        if (tgtId === entry.userId) { challengerId = chId; break; }
      }
      if (!challengerId) return;
      _partyInvites.delete(challengerId);
      const challenger = _connected.get(challengerId);
      if (!challenger || !challenger.helloed) return;
      // One-party-per-player — record membership on accept so future invites
      // targeting B get the early 'busy' rejection. Reject doesn't set.
      if (accept) _partyMemberships.set(entry.userId, challengerId);
      _send(challenger.ws, {
        type:    'party-invite-result',
        accept,
        partner: { userId: entry.userId, ...entry.profile, loc: entry.loc },
      });
      return;
    }
    case 'party-dismiss': {
      // Inviter explicitly dismisses a member (Party → Dismiss in roster
      // menu). Only the CURRENT inviter for that member can clear it; an
      // attempt by anyone else is silently ignored.
      if (!entry.helloed) return;
      const memberUserId = parsed.memberUserId | 0;
      if (!memberUserId) return;
      if (_partyMemberships.get(memberUserId) === entry.userId) {
        _partyMemberships.delete(memberUserId);
      }
      return;
    }
    case 'party-leave': {
      // Member voluntarily leaves their current party (no UI yet, but the
      // hook exists for future client-side "leave party" action). Mirror
      // of the disconnect-as-member path: notify the inviter so they can
      // clear local state too.
      if (!entry.helloed) return;
      const inviterId = _partyMemberships.get(entry.userId);
      if (inviterId == null) return;
      _partyMemberships.delete(entry.userId);
      const inviter = _connected.get(inviterId);
      if (inviter && inviter.helloed) {
        _send(inviter.ws, {
          type:         'party-member-left',
          memberUserId: entry.userId,
          memberName:   entry.profile?.name || '',
        });
      }
      return;
    }
    case 'encounter-start': {
      // Host (this user) is triggering a co-op random encounter and wants
      // to pull party members in. Validate each candidate is helloed + in
      // same party + not already in another encounter / PvP, then forward
      // `encounter-invite` to each. The host's own client spawns the battle
      // locally at the same time — turn dispatch will wait on `encounter-
      // action` for any actor whose userId is wire-driven.
      if (!entry.helloed) return;
      const seed = (parsed.seed | 0) >>> 0;
      if (!seed) return;
      const candidates = Array.isArray(parsed.partyUserIds) ? parsed.partyUserIds.slice(0, 8) : [];
      const monsters   = Array.isArray(parsed.monsters)     ? parsed.monsters.slice(0, 9)     : [];
      if (!candidates.length || !monsters.length) return;
      if (_encounterGroups.has(entry.userId)) return;  // already in a co-op battle
      const accepted = [];
      for (const cand of candidates) {
        const cid = cand | 0;
        if (!cid || cid === entry.userId) continue;
        const target = _connected.get(cid);
        if (!target || !target.helloed) continue;
        if (!_inSameParty(entry.userId, cid)) continue;
        if (_pvpPartners.has(cid)) continue;
        if (_encounterGroups.has(cid)) continue;
        accepted.push(cid);
      }
      if (accepted.length === 0) return;
      const all = [entry.userId, ...accepted];
      for (const uid of all) {
        const peerSet = new Set(all);
        peerSet.delete(uid);
        _encounterGroups.set(uid, peerSet);
      }
      const hostProfile = { userId: entry.userId, ...entry.profile, loc: entry.loc };
      for (const memberId of accepted) {
        const target = _connected.get(memberId);
        if (!target || !target.helloed) continue;
        const peers = [hostProfile];
        for (const otherId of accepted) {
          if (otherId === memberId) continue;
          const other = _connected.get(otherId);
          if (other && other.helloed) {
            peers.push({ userId: otherId, ...other.profile, loc: other.loc });
          }
        }
        _send(target.ws, {
          type:       'encounter-invite',
          seed,
          monsters,
          hostUserId: entry.userId,
          peers,
        });
      }
      console.log('[encounter-start] host=' + entry.userId + ' accepted=' + JSON.stringify(accepted) + ' monsters=' + monsters.length);
      return;
    }
    case 'encounter-assist-request': {
      // Joiner picked Assist on a roster target who's in battle. Validate
      // target exists, helloed, same location, currently in battle.
      // Forward to target as `encounter-assist-incoming`; target's client
      // auto-accepts by emitting `encounter-assist-snapshot`. The group
      // mutation happens server-side at snapshot-arrival, not here, so
      // the joiner doesn't get added to _encounterGroups until the target
      // actually accepts (handles target-side reject for "battle slot
      // full" / "already in PvP"). v1.7.422.
      if (!entry.helloed) return;
      const targetUserId = parsed.targetUserId | 0;
      if (!targetUserId || targetUserId === entry.userId) return;
      const target = _connected.get(targetUserId);
      if (!target || !target.helloed) return;
      if (target.loc !== entry.loc) return;
      if (!target.profile?.inBattle) return;
      if (_encounterGroups.has(entry.userId)) return;  // joiner already in another battle
      if (_pvpPartners.has(entry.userId)) return;       // joiner is in PvP
      console.log('[encounter-assist-request] joiner=' + entry.userId + ' → target=' + targetUserId);
      _send(target.ws, {
        type:        'encounter-assist-incoming',
        fromUserId:  entry.userId,
        fromName:    entry.profile?.name || 'Player',
        fromProfile: { userId: entry.userId, ...entry.profile, loc: entry.loc },
      });
      return;
    }
    case 'encounter-assist-snapshot': {
      // Target accepted (auto). Snapshot carries the current battle state
      // for the joiner to spawn locally + the joiner's userId for the
      // route. Server adds joiner to the existing group (or creates a
      // pair if target was solo) + broadcasts `encounter-ally-join` to
      // any OTHER peers already in the group so they fade-in the joiner.
      if (!entry.helloed) return;
      const joinerUserId = parsed.joinerUserId | 0;
      if (!joinerUserId || joinerUserId === entry.userId) return;
      const joiner = _connected.get(joinerUserId);
      if (!joiner || !joiner.helloed) return;
      // Build / extend the encounter group.
      let group = _encounterGroups.get(entry.userId);
      // Server-side dedup (v1.7.424) — if the joiner is already in this
      // target's group (e.g., double-tap on Assist before the first
      // snapshot landed), drop the second snapshot. Otherwise both
      // target's battleAllies and the wire route get duplicated and the
      // canonical turn-order push rolls initiative twice for the same
      // userId → silent desync.
      if (group && group.has(joinerUserId)) return;
      if (!group) {
        // Target was solo — create the bidirectional pair.
        group = new Set([joinerUserId]);
        _encounterGroups.set(entry.userId, group);
        _encounterGroups.set(joinerUserId, new Set([entry.userId]));
      } else {
        // Extend existing group with joiner. Update every peer's set.
        const allPeers = new Set([entry.userId, ...group, joinerUserId]);
        for (const uid of allPeers) {
          const peerSet = new Set(allPeers);
          peerSet.delete(uid);
          _encounterGroups.set(uid, peerSet);
        }
      }
      console.log('[encounter-assist-snapshot] host=' + entry.userId + ' joiner=' + joinerUserId + ' group=' + Array.from(_encounterGroups.get(entry.userId)).join(','));
      // Forward the full snapshot to the joiner so they spawn the same
      // battle locally with current monster HPs + peer list.
      //
      // Peers list is identity-pinned (v1.7.426): every peer.userId must
      // exist in `_connected` and be helloed, and identity fields
      // (name / jobIdx / level / palIdx) are overwritten with the server's
      // trusted profile. Live battle stats (hp, atk, def, weapon, spells)
      // pass through from the target's view since the server doesn't
      // track in-battle mutations. Spoofed userIds drop silently. This
      // means a malicious target can lie about a peer's HP but cannot
      // inject ghost identities or impersonate a different user.
      const candidatePeers = Array.isArray(parsed.peers) ? parsed.peers.slice(0, 8) : [];
      const peers = [];
      for (const p of candidatePeers) {
        const puid = (p && p.userId) | 0;
        if (!puid) continue;
        if (puid === joinerUserId) continue;  // joiner spawns self locally, not as ally
        const peerEntry = _connected.get(puid);
        if (!peerEntry || !peerEntry.helloed) continue;
        const sp = peerEntry.profile || {};
        peers.push({
          ...p,
          userId: puid,
          name:   sp.name   != null ? sp.name   : p.name,
          jobIdx: sp.jobIdx != null ? sp.jobIdx : p.jobIdx,
          level:  sp.level  != null ? sp.level  : p.level,
          palIdx: sp.palIdx != null ? sp.palIdx : p.palIdx,
        });
      }
      _send(joiner.ws, {
        type:       'encounter-assist-snapshot',
        seed:       (parsed.seed | 0) >>> 0,
        turnIndex:  parsed.turnIndex | 0,
        monsters:   Array.isArray(parsed.monsters) ? parsed.monsters.slice(0, 9) : [],
        peers,
        hostUserId: entry.userId,
      });
      // Notify any OTHER peers in the group (not the target who is the
      // snapshot source, and not the joiner who got the full snapshot)
      // that a new ally joined. Mirror of `pvp-ally-join` shape.
      const joinerProfile = { userId: joinerUserId, ...joiner.profile, loc: joiner.loc };
      for (const peerId of _encounterGroups.get(entry.userId)) {
        if (peerId === joinerUserId) continue;
        const peer = _connected.get(peerId);
        if (peer && peer.helloed) {
          _send(peer.ws, { type: 'encounter-ally-join', profile: joinerProfile });
        }
      }
      return;
    }
    case 'encounter-action': {
      // Relay a co-op encounter action (player command or wire-driven ally
      // command) to every other peer in the group. Mirror of pvp-action.
      if (!entry.helloed) return;
      const peers = _encounterGroups.get(entry.userId);
      if (!peers || peers.size === 0) return;
      for (const peerId of peers) {
        const peer = _connected.get(peerId);
        if (!peer || peer.ws.readyState !== 1) continue;
        _send(peer.ws, {
          type:       'encounter-action',
          userId:     entry.userId,
          kind:       parsed.kind,
          target:     parsed.target,
          spellId:    parsed.spellId,
          itemId:     parsed.itemId,
          damageRoll: parsed.damageRoll,
          healAmount: parsed.healAmount,
          hitResults: parsed.hitResults,
        });
      }
      return;
    }
    case 'atb-sync': {
      // Slice 4b (v1.7.439) — relay ATB gauge state transitions across
      // co-op peers so both clients' wall-clock gauges reset at the same
      // timestamp. Sender's local Date.now() carried in `atMs`; receiver
      // calls `markFilling(unit, atMs)` instead of using their own clock.
      // Only `filling` is sync'd in this slice — that's the high-impact
      // reset moment; `acting` just freezes elapsedMs (~ negligible drift).
      if (!entry.helloed) return;
      const peers = _encounterGroups.get(entry.userId);
      if (!peers || peers.size === 0) return;
      const unitKind = String(parsed.unitKind || '').slice(0, 16);
      const monsterIdx = parsed.monsterIdx | 0;
      // Date.now() exceeds 32-bit signed int range (~2.1B), so don't use
      // `| 0` here. Preserve the full Number; coerce + sanity-check below.
      const atMs = Number(parsed.atMs);
      if (!unitKind || !Number.isFinite(atMs) || atMs <= 0) return;
      for (const peerId of peers) {
        const peer = _connected.get(peerId);
        if (!peer || peer.ws.readyState !== 1) continue;
        _send(peer.ws, {
          type:       'atb-sync',
          userId:     entry.userId,
          unitKind,
          monsterIdx,
          atMs,
        });
      }
      return;
    }
    case 'encounter-end': {
      // Local battle ended on this user's side. Tell peers + clean up group.
      if (!entry.helloed) return;
      const peers = _encounterGroups.get(entry.userId);
      if (!peers) return;
      const outcome = String(parsed.outcome || '').slice(0, 16);
      for (const peerId of peers) {
        const peer = _connected.get(peerId);
        if (peer && peer.helloed) {
          _send(peer.ws, { type: 'encounter-end', userId: entry.userId, outcome });
        }
      }
      _clearEncounterGroup(entry.userId);
      return;
    }
    case 'pvp-end': {
      // Either player signals the battle is over (fled / lost / won locally).
      // Server drops the partner pair so a new pvp-match can fire later.
      const partnerId = _pvpPartners.get(entry.userId);
      if (partnerId) {
        _pvpPartners.delete(entry.userId);
        _pvpPartners.delete(partnerId);
      }
      return;
    }
    case 'pvp-result': {
      // MP Step 4 part 3 — both clients report their final outcome
      // ('won' | 'lost' | 'fled'). Server records the first report; on the
      // second, compares for consistency. With seed sync (part 1) + action
      // relay (part 2) the two sides MUST agree on the outcome — a mismatch
      // is a divergence bug to investigate (logged for observability; not
      // auto-corrected at MVP).
      if (!entry.helloed) return;
      const outcome = String(parsed.outcome || '').slice(0, 16);
      const partnerId = _pvpPartners.get(entry.userId);
      if (!partnerId) return;
      const partner = _connected.get(partnerId);
      if (!partner) {
        _pvpPartners.delete(entry.userId);
        return;
      }
      if (partner._lastPVPResult) {
        const myExpected = partner._lastPVPResult === 'won'  ? 'lost'
                         : partner._lastPVPResult === 'lost' ? 'won'
                         : partner._lastPVPResult;  // 'fled' → both flee
        if (outcome !== myExpected) {
          console.warn('[pvp-result mismatch]',
            'userA=' + partnerId, 'reported=' + partner._lastPVPResult,
            '| userB=' + entry.userId, 'reported=' + outcome);
          // v1.7.390 — when divergence is detected, push a synthetic
          // `disconnect` to BOTH partners so neither sits in a half-state.
          // Pre-fix the side reporting first ran out the FSM as if everything
          // was fine; the lagging side might be waiting for actions that
          // never arrive. Audit #14.
          _send(partner.ws, { type: 'pvp-action', kind: 'disconnect' });
          _send(entry.ws,   { type: 'pvp-action', kind: 'disconnect' });
        }
        if (partner._lastPVPResultTimer) clearTimeout(partner._lastPVPResultTimer);
        delete partner._lastPVPResult;
        delete partner._lastPVPResultTimer;
        _pvpPartners.delete(entry.userId);
        _pvpPartners.delete(partnerId);
      } else {
        entry._lastPVPResult = outcome;
        // Audit #26 — if the partner never reports their outcome (process
        // killed, TCP half-open, client crash before pvp-end), the partner
        // pair leaks. Clean up after 10 s — the surviving partner gets a
        // synthetic disconnect and `_pvpPartners` clears. Pre-fix the pair
        // would tie up future PvP searches until the lagging side closed
        // their WS.
        entry._lastPVPResultTimer = setTimeout(() => {
          // Re-check that the partner is still pending (no second report
          // arrived in the meantime).
          if (entry._lastPVPResult == null) return;
          delete entry._lastPVPResult;
          delete entry._lastPVPResultTimer;
          const partnerNow = _pvpPartners.get(entry.userId);
          if (partnerNow) {
            _pvpPartners.delete(entry.userId);
            _pvpPartners.delete(partnerNow);
            const p = _connected.get(partnerNow);
            if (p && p.helloed) _send(p.ws, { type: 'pvp-action', kind: 'disconnect' });
            const e = _connected.get(entry.userId);
            if (e && e.helloed) _send(e.ws, { type: 'pvp-action', kind: 'disconnect' });
          }
        }, 10000);
      }
      return;
    }
    case 'chat': {
      // Relay world / party / pm chat to other clients.
      //   - world: location-scoped (everyone at the same `loc`).
      //   - party: by party-membership lookup (`_inSameParty`), not by loc.
      //            See docs/MULTIPLAYER-AUDIT-2026-05-15.md #22.
      //   - pm:    targeted by `toUserId` (preferred) or `to` display name
      //            fallback. PM-by-name was the entire chat security model
      //            since v1.7.366 — anyone could rename to "Joel" and read
      //            every PM sent to Joel. See audit #8.
      if (!entry.helloed) return;
      const channel = String(parsed.channel || 'world').slice(0, 8);
      const text = String(parsed.text || '').slice(0, 200);
      if (!text) return;
      const senderName = entry.profile?.name || 'Player';
      if (channel === 'pm') {
        const toUserId = (parsed.toUserId | 0) || 0;
        const toName   = String(parsed.to || '').slice(0, 16);
        if (toUserId) {
          // Preferred path — direct userId target. Spoof-proof.
          const target = _connected.get(toUserId);
          if (!target || !target.helloed) return;
          _send(target.ws, { type: 'chat', userId: entry.userId, name: senderName,
                             channel, text, to: target.profile?.name || toName });
          return;
        }
        // Legacy fallback — name-based routing. Keeps old clients working
        // until everyone is on the new wire. NEW clients should always send
        // `toUserId`.
        if (!toName) return;
        for (const [, target] of _connected) {
          if (!target.helloed) continue;
          if (target.profile?.name !== toName) continue;
          _send(target.ws, { type: 'chat', userId: entry.userId, name: senderName,
                             channel, text, to: toName });
          break;  // stop at the first match — name collisions no longer broadcast.
        }
        return;
      }
      if (channel === 'party') {
        // Membership-scoped; ignores location. If sender isn't in any party,
        // nothing routes (the message is a no-op, matching how a solo
        // player's "party tab" send falls on the floor).
        for (const [uid, target] of _connected) {
          if (uid === entry.userId) continue;
          if (!target.helloed) continue;
          if (!_inSameParty(entry.userId, uid)) continue;
          _send(target.ws, { type: 'chat', userId: entry.userId, name: senderName,
                             channel, text });
        }
        return;
      }
      // World — broadcast to others at the same location. Sender's own
      // client already added the message locally, so exclude them.
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

// Cap incoming frames at 16 KB. The largest legitimate payload today is
// `hello` with a 3-ally roster (~1 KB). 16 KB leaves comfortable headroom
// and rules out OOM-via-fat-frame attacks. See
// docs/MULTIPLAYER-AUDIT-2026-05-15.md #5.
const WS_MAX_PAYLOAD = 16 * 1024;

// Cap concurrent WS connections per source IP. Realistic households share
// one IP across multiple devices, but ten simultaneous logins from one IP
// is more likely an attacker than a family. See audit #10.
const MAX_CONN_PER_IP = 10;
const _connsByIp = new Map();   // ip → count

function _getRemoteIp(req) {
  // Trust X-Forwarded-For from nginx (only one hop). Falls back to socket
  // address for direct connections.
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

export function attachWebSocketPresence(httpServer) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });

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
    // Verify with revocation check — `verifyTokenWithRevocation` does the
    // signature + expiry check AND compares iat against the user's
    // `token_iat_min` watermark so /api/logout-all actually kills WS
    // sessions. Pre-beta P3.
    const decoded = verifyTokenWithRevocation(token);
    if (!decoded) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const userId = decoded.userId;

    // Per-IP connection cap — audit #10. Stale-replace below still counts
    // against the user (it's a same-user reload), but blocks one-IP fanout
    // from many fake userIds.
    const ip = _getRemoteIp(req);
    const ipCount = _connsByIp.get(ip) || 0;
    if (ipCount >= MAX_CONN_PER_IP) {
      socket.write('HTTP/1.1 429 Too Many Connections\r\n\r\n');
      socket.destroy();
      return;
    }

    // If a previous WS is still open for this user (page reload race),
    // close it. The new connection wins.
    const stale = _connected.get(userId);
    if (stale && stale.ws.readyState <= 1) {
      try { stale.ws.close(4001, 'replaced'); } catch { /* drop */ }
      _connected.delete(userId);
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const entry = { ws, userId, profile: null, loc: null, helloed: false, ip };
      _connected.set(userId, entry);
      _connsByIp.set(ip, ipCount + 1);

      ws.on('message', (data) => _handleMessage(entry, data.toString()));
      ws.on('close', () => {
        const cur = _connected.get(userId);
        if (cur === entry) _connected.delete(userId);
        // Release the IP slot. Only count this close once; double-close (a
        // stale-replace + a network drop) shouldn't underflow the bucket.
        if (!entry._ipReleased) {
          entry._ipReleased = true;
          const n = (_connsByIp.get(entry.ip) || 1) - 1;
          if (n > 0) _connsByIp.set(entry.ip, n);
          else _connsByIp.delete(entry.ip);
        }
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
        // Notify PvP partner that we dropped (battle effectively ended).
        const partnerId = _pvpPartners.get(userId);
        if (partnerId) {
          _pvpPartners.delete(userId);
          _pvpPartners.delete(partnerId);
          const partner = _connected.get(partnerId);
          if (partner && partner.helloed) {
            _send(partner.ws, { type: 'pvp-action', kind: 'disconnect' });
          }
        }
        // Notify co-op encounter peers we dropped. They take over the
        // dropped player's actions locally (skip-as-defend / AI fallback)
        // and clear their own group on receipt.
        const epeers = _encounterGroups.get(userId);
        if (epeers) {
          for (const peerId of epeers) {
            const peer = _connected.get(peerId);
            if (peer && peer.helloed) {
              _send(peer.ws, { type: 'encounter-action', userId, kind: 'disconnect' });
            }
          }
          _clearEncounterGroup(userId);
        }
        // Clean up pending party invites involving this user.
        _partyInvites.delete(userId);  // outgoing
        for (const [chId, tgtId] of [..._partyInvites]) {
          if (tgtId === userId) {
            _partyInvites.delete(chId);
            const challenger = _connected.get(chId);
            if (challenger && challenger.helloed) {
              _send(challenger.ws, { type: 'party-invite-result', accept: false, reason: 'offline' });
            }
          }
        }
        // Clean up party memberships involving this user (as member or as
        // inviter — both directions) and notify the surviving side so they
        // can clear their local party state.
        const wasInPartyOf = _partyMemberships.get(userId);
        _partyMemberships.delete(userId);
        if (wasInPartyOf) {
          // This user was a member; tell their inviter.
          const inviter = _connected.get(wasInPartyOf);
          if (inviter && inviter.helloed) {
            _send(inviter.ws, {
              type:        'party-member-left',
              memberUserId: userId,
              memberName:  entry.profile?.name || '',
            });
          }
        }
        for (const [memberId, inviterId] of [..._partyMemberships]) {
          if (inviterId !== userId) continue;
          _partyMemberships.delete(memberId);
          // This user was the inviter; tell each ex-member their party
          // disbanded.
          const member = _connected.get(memberId);
          if (member && member.helloed) {
            _send(member.ws, {
              type:           'party-disbanded',
              inviterUserId:  userId,
              inviterName:    entry.profile?.name || '',
            });
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

// Test-only surface for `tools/pvp-wire-sim.js`. Production code paths
// never touch this; it just hands the wire-sim a reference to internal
// helpers + state maps so the regression harness can exercise the same
// code that runs in prod without re-implementing it.
export const _testHooks = {
  normalizeProfileField: _normalizeProfileField,
  pvpHookChance: _pvpHookChance,
  inSameParty: _inSameParty,
  rateAllow: _rateAllow,
  rateAllowKind: _rateAllowKind,
  perKindRates: PER_KIND_RATES,
  state: {
    connected: _connected,
    pvpSearches: _pvpSearches,
    pvpPartners: _pvpPartners,
    partyInvites: _partyInvites,
    partyMemberships: _partyMemberships,
    encounterGroups: _encounterGroups,
    connsByIp: _connsByIp,
  },
  resetState() {
    _connected.clear();
    _pvpSearches.clear();
    _pvpPartners.clear();
    _partyInvites.clear();
    _partyMemberships.clear();
    _encounterGroups.clear();
    _connsByIp.clear();
  },
};
