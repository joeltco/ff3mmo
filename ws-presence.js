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
import {
  verifyTokenWithRevocation,
  partyAddMember, partyRemoveMember, partyRemoveByInviter, partyLoadAll,
  tradeLog,
  presenceFlushBatch, presenceDelete, presenceLoadRecent, presenceReap,
  mirrorApplyInvEvent, mirrorReadFullState,    // v1.7.741 Phase 1a
  mirrorReadWireState,                          // v1.7.796 wire-managed-only snapshot
  mirrorReadEquippedBroadcast,                  // v1.7.746 Phase 5
  consumedTileMark, consumedTilesReap,          // v1.7.787 chest/vase replay block
} from './api.js';
import { sanitizeName, isCleanName, cleanChatText } from './moderation.js';
import { ITEMS } from './src/data/items.js';
// v1.7.747 P-1 — server-arbitrated PvP battle FSM. Behind PVP_ARBITER flag.
// Module is self-contained; ws-presence just plumbs the wire frames through.
import {
  createBattle as pvpArbCreate, buildStartFrame as pvpArbStartFrame,
  endBattle as pvpArbEnd, handleIntent as pvpArbIntent,
  resolveTurn as pvpArbResolveTurn,
  handleDisconnect as pvpArbDisconnect, getActiveCount as pvpArbActiveCount,
  _testReset as pvpArbTestReset,
} from './pvp-arbiter.js';
// v1.7.772 P-2 — PvE replay-validate arbiter. Server picks monsters + seed,
// client runs battle locally, server replays + validates on end. See
// docs/PVE-REWRITE-PLAN.md. Module is self-contained.
import {
  createPveBattle, createMimicBattle, recordIntent as pveRecordIntent,
  endPveBattle, cancelPveBattle,
} from './pve-arbiter.js';
// v1.7.776 P-8/P-9 — server economy validator. Shops first; chests/vases/inn follow.
import { validateShopTransaction, validateChestOpen, validateVaseSearch } from './economy-arbiter.js';

// Item types blocked from roster trade. Key items aren't really inventory —
// they're quest flags carried in the item table. Everything else
// (weapon/armor/consumable/battle_item/scroll) is tradeable.
const NON_TRADEABLE_ITEM_TYPES = new Set(['key']);
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

// PvP master switch (server side). DISABLED v1.7.502 — PvP roster battles are
// off pending the authoritative-host battle-sync rewrite (client-side lockstep
// desynced live). This is the hard kill switch: with it off, the server never
// registers a search and never fires a `pvp-match`, so no PvP battle can start
// even from a stale-cached client that still sends `pvp-search`/`pvp-encounter`.
// Re-enable by flipping this AND the client `PVP_ENABLED` in pvp-search.js.
// Mutable so the pvp-wire-sim can turn it on (via `_testHooks.setPvpEnabled`)
// to keep regression-testing the wire contract while prod stays off.
// v1.7.758 — FLIPPED ON together with PVP_ARBITER_SERVER + the two client
// flags. PvP is back, now running through the server-arbitrated path
// (the legacy lockstep relay's `_emitWirePVPAction` is unreachable
// because both arbiter flags route the hook to pvpArbCreate). To
// roll back: set BOTH this and PVP_ARBITER_SERVER false + redeploy.
// v1.7.770 — OFF AGAIN. Disabling PvP while P-6d animation gaps + magic/item
// P-4c land. PVP_ARBITER_SERVER stays on (no-op without PVP_ENABLED) so a
// re-enable is just flipping this one flag + the client one + restoring the
// roster 'Battle' menu item.
let PVP_ENABLED = false;

// v1.7.757 P-9 — server-side counterpart to the client's PVP_ARBITER flag
// (src/net.js). When BOTH are true (and PVP_ENABLED is true), a successful
// encounter hook spawns an arbiter battle via pvpArbCreate instead of the
// legacy lockstep pvp-match relay. The two flags must flip together because
// a server arbiter battle + legacy client (or vice versa) leaves one side
// in a broken state. Mutable so the wire-sim can set independently.
// v1.7.758 — FLIPPED ON. Paired with PVP_ENABLED (above) + the two
// client flags. See [[ff3mmo-pvp-arbiter-rewrite]] memory.
let PVP_ARBITER_SERVER = true;

// v1.7.772 P-2 — PvE replay-validate gate. When true, the server accepts
// `pve-encounter-request` frames + spawns server-rolled monsters with a
// seed; when false, the wire handlers reject so the client stays on the
// existing local-encounter path. Mutable so the wire-sim (P-12) can flip.
// v1.7.779 P-13 — FLIPPED ON. Paired with SERVER_ECONOMY + the two client
// flags. Encounter rewards (exp/gil/cp/drop) now server-validated.
// To roll back: set this + SERVER_ECONOMY + both client flags back to false.
let PVE_ARBITER = true;

// v1.7.794 — loc → allowed zoneKeys for pve-encounter-request. `entry.loc`
// is set from the client's `location` wire and broadcast in the roster,
// so a cheater who fakes zoneKey must also fake loc to slip past this
// gate — and that lie is visible to every peer. Default {} → reject.
// Mirrors the client zone resolution in `currentEncounterZoneKey()`:
//   - world  → grasslands_valley (Ur choke valley) OR grasslands_wild (south)
//   - ur     → grasslands_wild (the dark-tile patch in the town overworld)
//   - cave-N → the matching altar_cave_fN
// `altar_cave_boss` is intentionally absent — the boss is server-triggered,
// not client-requested. New zones / new encounter patches must update
// this table alongside `currentEncounterZoneKey` and the loc table in
// src/roster.js#rosterLocForMapId.
const _LOC_ZONE_ALLOWLIST = new Map([
  ['world',  new Set(['grasslands_valley', 'grasslands_wild'])],
  ['ur',     new Set(['grasslands_wild'])],
  ['cave-0', new Set(['altar_cave_f1'])],
  ['cave-1', new Set(['altar_cave_f2'])],
  ['cave-2', new Set(['altar_cave_f3'])],
  ['cave-3', new Set(['altar_cave_f4'])],
]);

// v1.7.776 P-8 — server-side economy validation gate (shops + chests +
// vases + inn). When true, client sends transaction requests + waits for
// server's authoritative ok/reject; when false, client owns the writes.
// v1.7.779 P-13 — FLIPPED ON. Shops route through server-validate. Chest /
// vase / inn server endpoints exist but client doesn't call them yet
// (P-10b/P-11b). To roll back: set this + PVE_ARBITER + both client
// flags back to false.
let SERVER_ECONOMY = true;

// v1.7.775 P-6 — apply a validated canonical outcome to the user's
// inventory mirror. Gil + drop are the two server-owned writes when
// PVE_ARBITER is on (client gates its own sendNetInvEvent for source='loot').
// Exp / cp / level remain client-asserted via the save column — those
// require the full battle FSM replay (P-5b deferred). v1 closes the
// largest cheat vector (currency/drop fabrication).
function _applyPveCanonical(userId, slot, canonical) {
  if (!canonical) return;
  if ((canonical.gilGained | 0) > 0) {
    mirrorApplyInvEvent(userId, slot, {
      kind: 'gil-delta',
      qty:  canonical.gilGained | 0,
      source: 'pve-loot',
    });
  }
  if (canonical.drop != null) {
    mirrorApplyInvEvent(userId, slot, {
      kind:   'add',
      itemId: canonical.drop | 0,
      qty:    1,
      source: 'pve-loot',
    });
  }
}

// Active PvP battle partners — userId → partnerUserId. Set on pvp-match,
// cleared on disconnect. The server relays `pvp-action` between partners
// so each client drives its opponent's turn from the remote player's actual
// chosen action instead of local AI (MP Step 4 part 2).
const _pvpPartners = new Map();

// Pending party invites — challengerUserId → targetUserId. Set on
// `party-invite`, cleared on `party-cancel` / response / disconnect.
const _partyInvites = new Map();

// Per-pair invite cooldown (v1.7.721) — `${challengerUserId}:${targetUserId}`
// → expiresAtMs. Set on decline / cancel; checked at the top of
// `party-invite`. Pre-fix the cooldown was client-only (`partyInviteSt.
// cooldowns`) so a reload wiped it and the player could spam the same
// target instantly. Server enforces the rate now; client-side cooldown
// stays as a UX hint that avoids the round-trip-then-reject pattern when
// nothing has changed.
const _partyInviteCooldowns = new Map();
const PARTY_INVITE_COOLDOWN_MS = 60 * 1000;

function _partyCooldownKey(challengerUserId, targetUserId) {
  return challengerUserId + ':' + targetUserId;
}
function _isInviteOnCooldown(challengerUserId, targetUserId) {
  const key = _partyCooldownKey(challengerUserId, targetUserId);
  const exp = _partyInviteCooldowns.get(key);
  if (!exp) return false;
  if (exp <= Date.now()) {
    _partyInviteCooldowns.delete(key);     // lazy reap
    return false;
  }
  return true;
}
function _setInviteCooldown(challengerUserId, targetUserId) {
  _partyInviteCooldowns.set(
    _partyCooldownKey(challengerUserId, targetUserId),
    Date.now() + PARTY_INVITE_COOLDOWN_MS
  );
}

// Active party memberships — memberUserId → inviterUserId. Enforces the
// one-party-per-player invariant: server rejects a new `party-invite`
// targeting someone who's already a member. Cleared by explicit
// `party-dismiss` from the inviter, `party-leave` from the member, or
// disconnect of either side.
const _partyMemberships = new Map();

// Last-known profile per userId — written on hello + every `update` so a
// partymate's profile survives their voluntary disconnect (the WS-close
// handler deletes `presence_shadows` for voluntary disconnects, leaving
// us nothing to populate "offline partymate" rows with otherwise). Used
// by the reconnect party-snapshot fanout (v1.7.720) to ship offline
// mates' profiles to a reconnecting client so the client's local
// partyMembers can rebuild without waiting for the mate to come back
// online. Bounded by reaping on `party-leave` / `party-dismiss` /
// `party-disband` — wired in those handlers as of v1.7.737. (Pre-v1.7.737
// this comment claimed it was reaped but the deletes were never landed,
// so the map grew unbounded per ever-online user.)
const _lastSeenProfiles = new Map();   // userId → profile (without userId/loc)

// Pending roster-trade offers (v1.7.598). offererUserId → { targetUserId,
// itemId, expiresAt }. Server doesn't track inventory — it relays + arbitrates
// the offer/response. Same trust model as give-item: a malicious sender can
// claim an item they don't own and dup it on the recipient's side. Open-beta
// limitation; harden with a server-side inventory mirror later if abuse shows.
const _pendingTrades = new Map();
const TRADE_OFFER_TTL_MS = 6 * 60 * 1000;   // 6min — longer than client 5min

// Seed `_partyMemberships` from the persistent `parties` table at boot
// (v1.7.595). Parties survive disconnect + server restart; the table is the
// source of truth, this Map the in-memory mirror. Only explicit leave /
// dismiss removes rows from either side.
for (const row of partyLoadAll()) {
  _partyMemberships.set(row.memberUserId, row.inviterUserId);
}

// "Is this user in any party right now?" — member of someone's party OR
// inviter with members. Used to derive the `inParty` profile flag that
// goes in every wire-shaped profile (hello snapshot, player-join,
// player-update) so partymate clients can disable the roster "Party"
// menu BEFORE the user tries to invite a partied target (server still
// enforces with `self-busy` / `busy` rejects as defense). v1.7.711.
function _isUserInParty(userId) {
  if (_partyMemberships.has(userId)) return true;
  for (const inviterId of _partyMemberships.values()) {
    if (inviterId === userId) return true;
  }
  return false;
}

// Broadcast a player-update with the user's current `inParty` flag.
// Call after every `_partyMemberships.set/.delete` so peers' roster
// menus refresh in real time. Reuses the existing player-update wire
// shape — no new handler needed on the client (`_onlinePlayers` merges
// `msg.fields` already).
function _broadcastInPartyChange(userId) {
  const inParty = _isUserInParty(userId) ? 1 : 0;
  _broadcast({ type: 'player-update', userId, fields: { inParty } });
}

// Returns every userId in the same party as `userId` — the inviter (if
// `userId` is a member), every peer member under the same inviter, and any
// members `userId` themselves invited. Excludes `userId`. Used by the hello
// fan-out to re-introduce a returning user to their online party-mates.
function _getPartyMates(userId) {
  const mates = new Set();
  const myInviter = _partyMemberships.get(userId);
  if (myInviter != null && myInviter !== userId) {
    mates.add(myInviter);
    for (const [memberId, inviterId] of _partyMemberships) {
      if (inviterId === myInviter && memberId !== userId) mates.add(memberId);
    }
  }
  for (const [memberId, inviterId] of _partyMemberships) {
    if (inviterId === userId) mates.add(memberId);
  }
  return [...mates];
}


// Presence persistence (v1.7.596). `_shadows` is the in-memory cache of users
// who were online when the server last died — restored at boot from SQLite
// so newcomers see a populated world rather than an empty roster. Real
// `hello` evicts the matching shadow; stale entries age out via TTL reap.
const PRESENCE_TTL_SEC   = 10 * 60;    // shadows older than this drop
const PRESENCE_FLUSH_MS  = 30 * 1000;  // periodic write of helloed users
const PRESENCE_REAP_MS   = 60 * 1000;  // periodic stale-shadow cull

// Consumed-tile reap: chest + vase rows are gated by a 24h TTL in
// economy-arbiter.js. Once past TTL the row is just dead weight (still
// indexed via idx_consumed_tiles_consumed_at). Reap hourly; one cutoff
// covers both kinds since they share the same TTL.
const CONSUMED_TILE_TTL_SEC = 24 * 3600;
const CONSUMED_TILE_REAP_MS = 60 * 60 * 1000;
const _shadows = new Map();   // userId → { userId, profile, loc, lastSeen }

// SIGTERM flag — pm2 restart sends SIGTERM, we set the flag and DON'T exit;
// pm2 escalates to SIGKILL after its grace period, and SIGKILL doesn't run
// close handlers, so shadows persist across the restart. Local dev Ctrl-C
// (SIGINT) we leave alone — default Node exit wipes shadows for connected
// users, which is fine.
let _gracefulShutdown = false;
process.on('SIGTERM', () => { _gracefulShutdown = true; });

// Boot load — restore shadows for users who were online recently. Older
// entries drop on the next reap. v1.7.596.
{
  const cutoff = Math.floor(Date.now() / 1000) - PRESENCE_TTL_SEC;
  for (const row of presenceLoadRecent(cutoff)) {
    try {
      const profile = JSON.parse(row.profileJson || '{}');
      _shadows.set(row.userId, {
        userId: row.userId,
        profile,
        loc: row.loc || 'ur',
        lastSeen: row.lastSeen,
      });
      // v1.7.723: seed _lastSeenProfiles too. Pre-fix the cache was
      // populated only by live hello/update during this server's
      // lifetime — after restart it was empty, so offline-mate
      // party-snapshot entries fell back to skeleton {name:'Player'}
      // and rendered as anonymous "Player" rows in the partymate's
      // roster. Now any recently-online user (within PRESENCE_TTL)
      // has their full profile available for the offline-mate
      // snapshot path.
      _lastSeenProfiles.set(row.userId, profile);
    } catch { /* corrupt JSON — skip */ }
  }
  if (_shadows.size > 0) console.log(`Presence: restored ${_shadows.size} shadows`);
}

function _flushPresence() {
  const now = Math.floor(Date.now() / 1000);
  const rows = [];
  for (const [uid, entry] of _connected) {
    if (!entry.helloed) continue;
    rows.push({
      userId:      uid,
      name:        entry.profile?.name || '',
      loc:         entry.loc || '',
      profileJson: JSON.stringify(entry.profile || {}),
      lastSeen:    now,
    });
  }
  if (rows.length > 0) presenceFlushBatch(rows);
}

function _reapPresence() {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - PRESENCE_TTL_SEC;
  for (const [uid, shadow] of _shadows) {
    if (shadow.lastSeen < cutoff) {
      _shadows.delete(uid);
      // Live clients that received this shadow in their initial snapshot
      // need to know it's gone, or it'll stick in their roster forever.
      _broadcast({ type: 'player-leave', userId: uid });
    }
  }
  // SQLite has its own retention — rows for users we evicted via `hello`
  // get overwritten on the next flush, but stale ones must be cleaned.
  presenceReap(cutoff);
}

function _reapConsumedTiles() {
  const cutoff = Math.floor(Date.now() / 1000) - CONSUMED_TILE_TTL_SEC;
  consumedTilesReap('chest', cutoff);
  consumedTilesReap('vase',  cutoff);
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
    // Strip to renderable glyphs (no emoji/zero-width/homoglyph spoofs); a
    // profane or empty result falls back to 'Player' rather than broadcasting.
    case 'name': {
      const n = sanitizeName(value);
      return (n && isCleanName(n)) ? n : 'Player';
    }
    case 'jobIdx':   return _clamp(value, 0, 31);
    case 'level':    return _clamp(value, 1, 99);
    case 'palIdx':   return _clamp(value, 0, 31);
    // v1.7.741 — Phase 1a inventory mirror. `slot` is the active save slot
    // the client is currently playing. Server stashes on entry.slot so
    // subsequent inv-event frames know which (userId, slot) to mutate.
    // Defaults to 0 if the client doesn't send it (pre-1a clients).
    case 'slot':     return _clamp(value, 0, 2);
    case 'hp':       return _clamp(value, 0, 9999);
    case 'maxHP':    return _clamp(value, 1, 9999);
    case 'agi':      return _clamp(value, 1, 99);
    case 'inBattle': return _clamp(value, 0, 1);
    case 'statusMask': return _clamp(value, 0, 0x3FF);   // 10-bit mask (STATUS.* up to CONFUSE 0x200)
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
// burst would exhaust the bucket for that connection's `pvp-action`.
// These smaller per-kind buckets cap the kinds that are user-action-driven
// (not poll-driven) so spamming one can't starve the others. Frames not
// listed here are global-bucket-only. v1.7.426.
const PER_KIND_RATES = {
  'chat':                      { cap: 20, refill: 5 },
  'give-item':                 { cap: 6,  refill: 1 },
  'party-invite':              { cap: 6,  refill: 1 },
  // v1.7.741 Phase 1a — inv-event is per-mutation. A burst (mid-battle
  // item-use, opening a chest with 4 stack) can hit 4-6 events in a
  // second; refill 4/s keeps sustained mutation fine while capping
  // malicious flood.
  'inv-event':                 { cap: 30, refill: 4 },
  // v1.7.747 P-1 — pvp-intent is once-per-turn. Even a fast player can't
  // legitimately exceed ~1/s. Tight cap (3 burst, 1/s sustained) so a
  // misbehaving client can't grief the FSM by spamming intents.
  'pvp-intent':                { cap: 3,  refill: 1 },
  // v1.7.793 — economy wires landed in the v1.7.598 / v1.7.779 / v1.7.780
  // arcs without per-kind caps. The dungeon-chest replay exploit (v1.7.789
  // accepted) lets a cheater claim repeatedly inside a regenerating cave;
  // capping `chest-open` here bounds the abuse rate. `vase-search` shares
  // the same shape. Shop transactions are slower (qty-driven UI). PvE
  // battle wires are once-per-encounter / once-per-turn legitimately.
  // Trade-offer matches the existing party-invite cap.
  'chest-open':                { cap: 8,  refill: 4 },
  'vase-search':               { cap: 8,  refill: 4 },
  'shop-transaction':          { cap: 6,  refill: 2 },
  'pve-encounter-request':     { cap: 4,  refill: 1 },
  'pve-battle-end':            { cap: 4,  refill: 1 },
  'trade-offer':               { cap: 6,  refill: 1 },
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
// Fan a member-leaves event out to every remaining party member (inviter
// + other accepted members). Pre-v1.7.460 only the inviter got the notice;
// peer members kept stale local `partyMembers` entries until reconnect.
// Caller must have already removed `leaverUserId` from `_partyMemberships`
// before invoking — this only walks live memberships.
function _broadcastPartyMemberLeft(inviterId, leaverUserId, leaverName) {
  const recipients = new Set();
  recipients.add(inviterId);
  for (const [memberId, mInviterId] of _partyMemberships) {
    if (mInviterId === inviterId) recipients.add(memberId);
  }
  recipients.delete(leaverUserId);
  for (const uid of recipients) {
    const peer = _connected.get(uid);
    if (!peer || !peer.helloed) continue;
    _send(peer.ws, {
      type:         'party-member-left',
      memberUserId: leaverUserId,
      memberName:   leaverName,
    });
  }
}

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
  // v1.7.757 P-9 — when both PVP_ARBITER_SERVER and the client flag
  // are flipped, the hook spawns a server-arbitrated battle instead of
  // the legacy lockstep relay. Mates pulled from _getPartyMates; slot
  // defaults to whichever the entry has cached at hello (api save-load
  // path stamps entry.slot v1.7.741).
  if (PVP_ARBITER_SERVER) {
    const sideAMates = _getPartyMates(hookedChallenger.userId);
    const sideBMates = _getPartyMates(targetUserId);
    const slot = (hookedChallenger.slot | 0);
    let battle;
    try {
      battle = pvpArbCreate(hookedChallenger.userId, targetUserId, {
        sideAMates, sideBMates, slot,
      });
    } catch (e) {
      console.log('[pvp-arb-hook] reject reason=' + e.message);
      _send(hookedChallenger.ws, { type: 'pvp-search-failed', reason: 'arbiter-create-failed' });
      _send(targetEntry.ws,      { type: 'pvp-encounter-none' });
      return;
    }
    _send(hookedChallenger.ws, pvpArbStartFrame(battle, hookedChallenger.userId));
    _send(targetEntry.ws,      pvpArbStartFrame(battle, targetUserId));
    console.log('[pvp-arb-hook] battle=' + battle.battleId + ' A=' + hookedChallenger.userId +
      ' B=' + targetUserId + ' cells=' + battle.combatants.length);
    _clearSearch(hookedChallenger.userId);
    // Cancel every other search like the legacy path does (below) — same logic, same cleanup.
    for (const [chId, s] of [..._pvpSearches]) {
      if (s.targetUserId === targetUserId || s.targetUserId === hookedChallenger.userId) {
        _clearSearch(chId);
        const otherCh = _connected.get(chId);
        if (otherCh && otherCh.helloed) {
          _send(otherCh.ws, { type: 'pvp-search-failed', reason: 'target-engaged' });
        }
      }
    }
    if (_pvpSearches.has(targetUserId)) _clearSearch(targetUserId);
    return;
  }
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
  const seen = new Set();
  for (const [uid, entry] of _connected) {
    if (uid === excludeUserId) continue;
    if (!entry.helloed) continue;
    // `inParty` is server-derived so clients can't fake it (and so the
    // roster menu can disable "Party" for partied targets before the user
    // even tries — server enforces with self-busy / busy fallback). v1.7.711.
    players.push({
      userId: uid, ...entry.profile, loc: entry.loc,
      inParty: _isUserInParty(uid) ? 1 : 0,
    });
    seen.add(uid);
  }
  // Shadow entries — users who were online before the last server restart
  // and haven't reconnected yet. Same shape as live entries so the client
  // doesn't have to differentiate; a real `hello` will broadcast
  // `player-join` which upserts in the client roster. v1.7.596.
  for (const [uid, shadow] of _shadows) {
    if (uid === excludeUserId) continue;
    if (seen.has(uid)) continue;
    players.push({
      userId: uid, ...shadow.profile, loc: shadow.loc,
      inParty: _isUserInParty(uid) ? 1 : 0,
    });
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
        // statusMask in the hello whitelist (v1.7.717) — without this, a fresh
        // connection's snapshot for an already-poisoned peer wouldn't carry the
        // mask until that peer's next ≤500ms diff-poll. Self-corrects fast but
        // showed up as "join → blank → bubble appears" flicker.
        statusMask: _normalizeProfileField('statusMask', profile.statusMask) ?? 0,
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
      // v1.7.741 — Phase 1a inventory mirror. Stash the active save slot
      // on entry (NOT in profile — peers don't need to know my slot).
      // Defaults to 0 if missing for pre-1a client compat. `inv-event`
      // frames use entry.slot as the default mutation target; explicit
      // `slot` in the event payload overrides.
      entry.slot = _normalizeProfileField('slot', profile.slot) ?? 0;
      const wasHelloed = entry.helloed;
      entry.helloed = true;
      // Cache for offline partymate snapshots (v1.7.720). Strip userId/loc —
      // they're carried by the wrapping snapshot entry, not the profile.
      _lastSeenProfiles.set(entry.userId, { ...entry.profile });
      // A real connection takes over from any restored shadow for the same
      // user. The `player-join` broadcast below upserts in clients that
      // had the shadow in their initial snapshot, so no extra cleanup
      // message is needed. v1.7.596.
      _shadows.delete(entry.userId);
      // Send the current snapshot to the new client so they see everyone else.
      _send(entry.ws, _snapshotPayload(entry.userId));
      // Broadcast join to OTHER clients. If `hello` is resent (re-identify
      // after a save-slot swap), broadcast a `player-update` instead.
      if (!wasHelloed) {
        _broadcast({
          type: 'player-join',
          player: {
            userId: entry.userId, ...entry.profile, loc: entry.loc,
            inParty: _isUserInParty(entry.userId) ? 1 : 0,
          },
        }, entry.userId);
        // Re-establish persistent party relationships (v1.7.595). If this
        // user has any party-mates in `_partyMemberships` (either as a
        // member of someone's party or an inviter of others), tell them
        // about the online mates via party-snapshot and tell each online
        // mate that this user is back via party-member-joined. Reuses the
        // existing client handlers — no client change needed.
        //
        // v1.7.720: snapshot now ships ALL mates, online + offline. Offline
        // mates carry their last-known profile from `_lastSeenProfiles` so
        // the reconnecting client can rebuild `partyMembers` + roster pin
        // immediately rather than waiting for the mate to come back. Each
        // entry has an `online: 0|1` flag so client knows which path to
        // take (live lookup vs cached). Pre-v1.7.720 a reconnect with all
        // mates offline got NO snapshot at all and lived in a phantom-
        // party state.
        // v1.7.733 — ALWAYS send the snapshot at hello, even if mateIds is
        // empty. Pre-fix the `if (mateIds.length > 0)` short-circuit meant a
        // soft-reconnecting inviter (mobile WS unsuspend, page memory still
        // alive) whose members had all `/leave`-d during the offline window
        // got NO snapshot — leaving their local `partyInviteSt.partyMembers`
        // in a phantom-party state until they ran `/party`. Now the empty
        // snapshot rides through `setNetPartySnapshotHandler`'s REPLACE
        // semantics (party-invite.js:367) and scrubs the stale local list.
        // The `party-member-joined` fanout below is a no-op when mateIds is
        // empty, so the cost is one extra wire frame on every hello (cheap).
        const mateIds = _getPartyMates(entry.userId);
        // v1.7.723: only include mates we have real profile data for.
        // Skeleton fallback `{name:'Player'}` was rendering as anonymous
        // "Player" entries in the partymate's roster — looked like fake
        // players to the user. Skipped mates can still recover later
        // when they come back online (the reconnect fanout will send
        // a fresh `party-member-joined`); for mates that NEVER come
        // back, /disband cleans up the server side.
        const members = [];
        for (const uid of mateIds) {
          const live = _connected.get(uid);
          if (live && live.helloed) {
            members.push({ userId: uid, ...live.profile, loc: live.loc, online: 1 });
            continue;
          }
          const cached = _lastSeenProfiles.get(uid);
          if (cached) {
            members.push({ userId: uid, ...cached, online: 0 });
          }
          // No data — skip (don't render a 'Player' phantom)
        }
        _send(entry.ws, { type: 'party-snapshot', members });
        // Tell each online mate this user is back via party-member-joined.
        // Empty when mateIds is empty (no party); harmless.
        const selfMember = { userId: entry.userId, ...entry.profile, loc: entry.loc };
        for (const uid of mateIds) {
          const m = _connected.get(uid);
          if (!m || !m.helloed) continue;
          _send(m.ws, { type: 'party-member-joined', member: selfMember });
        }
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
                       'allies', 'inBattle', 'statusMask']) {
        if (parsed[k] == null) continue;
        const v = _normalizeProfileField(k, parsed[k]);
        if (v === undefined) continue;
        entry.profile[k] = v;
        fields[k] = v;
      }
      // v1.7.741 — `slot` is a per-WS field, not broadcast to peers. Update
      // entry.slot without adding it to the player-update fanout.
      if (parsed.slot != null) {
        const s = _normalizeProfileField('slot', parsed.slot);
        if (s !== undefined) entry.slot = s;
      }
      // v1.7.746 Phase 5 — equipment cross-check vs inv_equipped mirror.
      // The wire is authoritative for equipped state (Phase 1b), so a
      // claimed `update` field that disagrees with the mirror is either
      // (a) a cheating client trying to inflate AI-ally stats / roster
      // display, or (b) a benign race where update arrived before the
      // equip event applied. Both cases get the same treatment:
      // overwrite the broadcast field with mirror's view. Peers + the
      // entry's own profile cache only ever see authoritative equipment.
      if (fields.weaponR != null || fields.weaponL != null ||
          fields.helmId != null || fields.armorId != null || fields.shieldId != null) {
        try {
          const mirror = mirrorReadEquippedBroadcast(entry.userId, entry.slot | 0);
          if (mirror) {
            for (const k of ['weaponR', 'weaponL', 'helmId', 'armorId', 'shieldId']) {
              if (fields[k] == null) continue;
              if (fields[k] === mirror[k]) continue;
              console.warn('[update divergence] user=' + entry.userId + ' slot=' + (entry.slot | 0) +
                ' ' + k + ' claimed=' + fields[k] + ' mirror=' + mirror[k]);
              fields[k] = mirror[k];
              entry.profile[k] = mirror[k];
            }
          }
        } catch (e) {
          console.warn('[update equip-check] failed user=' + entry.userId + ': ' + e.message);
        }
      }
      if (Object.keys(fields).length === 0) return;
      // Refresh the offline-snapshot cache so a future reconnect sees the
      // latest realized stats / palette / status mask. v1.7.720.
      _lastSeenProfiles.set(entry.userId, { ...entry.profile });
      _broadcast({ type: 'player-update', userId: entry.userId, fields }, entry.userId);
      return;
    }
    case 'pvp-search': {
      if (!PVP_ENABLED) {
        console.log('[pvp-search] reject reason=pvp-disabled user=' + entry.userId);
        _send(entry.ws, { type: 'pvp-search-failed', reason: 'offline' });
        return;
      }
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
      if (!PVP_ENABLED) {
        // PvP disabled — never hook; the client proceeds to a normal monster
        // encounter on `pvp-encounter-none`.
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
    case 'pvp-arb-start': {
      // v1.7.747 P-1 — TEST-ONLY entry point for the server-arbitrated PvP
      // FSM scaffold. Lets wire-sim spin up a battle without going through
      // the full pvp-search → encounter hook path. P-9 wires the search
      // hook to call `pvpArbCreate` directly when PVP_ARBITER is on; until
      // then this case is the only way to land in the arbiter from a
      // client. Authentication still required (entry.helloed) and the
      // opponent must be a real online user; production exposure is low
      // (a client could only stall their own session by calling it).
      if (!entry.helloed) return;
      const opponentUserId = parsed.opponentUserId | 0;
      if (!opponentUserId || opponentUserId === entry.userId) return;
      const opponent = _connected.get(opponentUserId);
      if (!opponent || !opponent.helloed) {
        _send(entry.ws, { type: 'pvp-cancel', battleId: 0, reason: 'opponent-offline' });
        return;
      }
      // P-2 — gather each side's party mate userIds so the arbiter can
      // spawn AI combatants for the full 1+3-vs-1+3 max layout. Solo
      // players (no party) just send a 1-vs-N or N-vs-1 battle; the
      // arbiter handles asymmetric sides.
      const sideAMates = _getPartyMates(entry.userId);
      const sideBMates = _getPartyMates(opponentUserId);
      // Active slot for stat read — both clients defaulted to slot 0
      // until the user picks at the title screen + sends it on hello.
      // `entry.slot` was added in v1.7.741.
      const slotA = (entry.slot | 0);
      let battle;
      try {
        battle = pvpArbCreate(entry.userId, opponentUserId, {
          sideAMates, sideBMates, slot: slotA,
        });
      } catch (e) {
        console.log('[pvp-arb-start] reject reason=' + e.message + ' user=' + entry.userId);
        // Distinguish no-save errors from already-in-battle for the
        // client (better UX: "save data missing" vs "you're in a fight").
        const reason = e.message.includes('no save') ? 'no-save' : 'already-in-battle';
        _send(entry.ws, { type: 'pvp-cancel', battleId: 0, reason });
        return;
      }
      _send(entry.ws, pvpArbStartFrame(battle, entry.userId));
      _send(opponent.ws, pvpArbStartFrame(battle, opponentUserId));
      // v1.7.750 P-4 — battle now lives until naturally terminated by
      // side defeat. Clients send `pvp-intent` per round; the intent
      // handler below resolves + broadcasts `pvp-turn` frames as each
      // round closes. P-1's immediate-end stub is gone.
      console.log('[pvp-arb-start] battle=' + battle.battleId + ' A=' + entry.userId + ' B=' + opponentUserId +
        ' cells=' + battle.combatants.length);
      return;
    }
    case 'pvp-intent': {
      // v1.7.750 P-4 — client emits one intent per round; server validates,
      // queues, and when every alive human on the battle has submitted
      // (`result.ready === true`) drives the resolution + broadcasts a
      // `pvp-turn` frame to both clients. End deltas trigger battle GC
      // inside the arbiter; ws-presence just dispatches the frame.
      if (!entry.helloed) return;
      const result = pvpArbIntent(entry.userId, parsed);
      if (!result.ok) {
        console.log('[pvp-intent] reject user=' + entry.userId + ' reason=' + result.reason);
        return;
      }
      if (!result.ready) return;     // waiting on the other human
      const turnFrame = pvpArbResolveTurn(result.battle);
      const sideA = _connected.get(result.battle.sideA.userId);
      const sideB = _connected.get(result.battle.sideB.userId);
      if (sideA && sideA.helloed) _send(sideA.ws, turnFrame);
      if (sideB && sideB.helloed) _send(sideB.ws, turnFrame);
      console.log('[pvp-turn] battle=' + result.battle.battleId + ' turn=' + turnFrame.turnIdx +
        ' deltas=' + turnFrame.deltas.length +
        (turnFrame.deltas.some(d => d.kind === 'end') ? ' END' : ''));
      return;
    }
    case 'pve-encounter-request': {
      // v1.7.772 P-2 — server-rolled encounter. Gated on PVE_ARBITER (off
      // through P-2, flips at P-13). Replies `pve-battle-start` with the
      // chosen monsters + seed; client mirrors them into battleSt and
      // runs the battle locally. P-3 wires the client side.
      if (!entry.helloed) return;
      if (!PVE_ARBITER) {
        _send(entry.ws, { type: 'pve-cancel', reason: 'arbiter-disabled' });
        return;
      }
      // v1.7.794 — gate zoneKey against the user's tracked loc. Pre-fix
      // a cheater could claim `zoneKey: 'altar_cave_f4'` from anywhere
      // and farm high-tier monster rewards. `entry.loc` is set from the
      // location wire and broadcast on the roster, so the cheater would
      // have to also lie about loc to bypass — visible to peers.
      const allowed = _LOC_ZONE_ALLOWLIST.get(entry.loc);
      if (!allowed || !allowed.has(String(parsed.zoneKey || ''))) {
        console.log('[pve-encounter] reject user=' + entry.userId +
          ' loc=' + entry.loc + ' zone=' + parsed.zoneKey + ' reason=wrong-zone');
        _send(entry.ws, { type: 'pve-cancel', reason: 'wrong-zone' });
        return;
      }
      const slot = (entry.slot | 0);
      const result = createPveBattle(entry.userId, {
        slot,
        zoneKey: parsed.zoneKey,
        mapId:   parsed.mapId | 0,
      });
      if (result.error) {
        console.log('[pve-encounter] reject user=' + entry.userId + ' reason=' + result.error);
        _send(entry.ws, { type: 'pve-cancel', reason: result.error });
        return;
      }
      _send(entry.ws, {
        type: 'pve-battle-start',
        battleId: result.battleId,
        rngSeed:  result.rngSeed,
        monsters: result.monsters,
      });
      console.log('[pve-start] battle=' + result.battleId + ' user=' + entry.userId +
        ' zone=' + parsed.zoneKey + ' mons=' + result.monsters.length);
      return;
    }
    case 'pve-intent': {
      // v1.7.772 P-2 — buffer per-turn intents. No validation in P-2;
      // replay (P-5) consumes the buffer. Silent on success — failures
      // log for forensics.
      if (!entry.helloed) return;
      if (!PVE_ARBITER) return;
      const ok = pveRecordIntent(entry.userId, parsed);
      if (!ok) console.log('[pve-intent] reject user=' + entry.userId + ' battle=' + parsed.battleId);
      return;
    }
    case 'pve-battle-end': {
      // v1.7.775 P-5/P-6 — validate the client's claim against the
      // server-canonical monster list (outcome-validate model). On accept,
      // server applies the canonical gil + drop via the inventory mirror
      // (sole writer for currency/inv when PVE_ARBITER on; client gates
      // its own sendNetInvEvent for the 'loot' source). On reject, the
      // client gets the reason + a corrective inv-state push.
      if (!entry.helloed) return;
      if (!PVE_ARBITER) return;
      const slot = (entry.slot | 0);
      const result = endPveBattle(entry.userId, parsed);
      if (result.status === 'applied' && result.canonical) {
        _applyPveCanonical(entry.userId, slot, result.canonical);
      }
      _send(entry.ws, {
        type: 'pve-battle-result',
        battleId: parsed.battleId,
        status:   result.status,
        reason:   result.reason,
        canonical: result.canonical,
      });
      // After apply, push the fresh mirror snapshot so the client's
      // inv state matches server. This is the same protocol used for
      // mirror-divergence pushes (case 'inv-event' above).
      if (result.status === 'applied') {
        _send(entry.ws, {
          type: 'inv-state',
          reason: 'pve-applied',
          ...mirrorReadWireState(entry.userId, slot),
        });
      }
      console.log('[pve-end] battle=' + parsed.battleId + ' user=' + entry.userId +
        ' status=' + result.status + (result.reason ? ' reason=' + result.reason : ''));
      return;
    }
    case 'shop-transaction': {
      // v1.7.776 P-9 — atomic buy/sell. Server validates against the
      // shop catalog + ITEMS price + current mirror state; on ok,
      // applies the gil + inv events via mirrorApplyInvEvent (single
      // writer). Reply carries `gilAfter` + `invDelta` so the client
      // can reconcile its UI without a follow-up inv-state-request.
      if (!entry.helloed) return;
      if (!SERVER_ECONOMY) {
        _send(entry.ws, { type: 'shop-result', txnId: parsed.txnId | 0,
          status: 'rejected', reason: 'economy-disabled' });
        return;
      }
      const slot = (entry.slot | 0);
      const result = validateShopTransaction(entry.userId, slot, parsed);
      if (!result.ok) {
        console.log('[shop-txn] reject user=' + entry.userId +
          ' action=' + parsed.action + ' item=0x' + ((parsed.itemId|0).toString(16)) +
          ' qty=' + (parsed.qty|0) + ' reason=' + result.reason);
        _send(entry.ws, { type: 'shop-result', txnId: parsed.txnId | 0,
          status: 'rejected', reason: result.reason });
        return;
      }
      let applyOk = true;
      let applyReason = null;
      for (const ev of result.events) {
        const r = mirrorApplyInvEvent(entry.userId, slot, ev);
        if (!r.ok) { applyOk = false; applyReason = r.reason; break; }
      }
      if (!applyOk) {
        console.warn('[shop-txn] mirror apply failed user=' + entry.userId + ' reason=' + applyReason);
        _send(entry.ws, { type: 'shop-result', txnId: parsed.txnId | 0,
          status: 'rejected', reason: 'mirror-' + applyReason });
        return;
      }
      const fresh = mirrorReadFullState(entry.userId, slot);
      _send(entry.ws, {
        type: 'shop-result',
        txnId: parsed.txnId | 0,
        status: 'ok',
        action: parsed.action,
        itemId: parsed.itemId | 0,
        qty:    parsed.qty | 0,
        gilAfter: fresh.gil | 0,
      });
      console.log('[shop-txn] ok user=' + entry.userId + ' action=' + parsed.action +
        ' item=0x' + ((parsed.itemId|0).toString(16)) + ' qty=' + (parsed.qty|0));
      return;
    }
    case 'chest-open': {
      // v1.7.780 P-10b — validate-only. Client rolls locally + submits
      // `claim` (item id / gil amount / monster). Server checks the claim
      // is in the pool, applies gil/item via mirror. Mimic claim → no
      // event (client starts the battle locally; PvE arbiter takes over).
      if (!entry.helloed) return;
      if (!SERVER_ECONOMY) {
        _send(entry.ws, { type: 'chest-result', txnId: parsed.txnId | 0,
          status: 'rejected', reason: 'economy-disabled' });
        return;
      }
      const slot = (entry.slot | 0);
      const r = validateChestOpen(entry.userId, slot, parsed);
      if (!r.ok) {
        console.log('[chest] reject user=' + entry.userId + ' map=' + parsed.mapId +
          ' claim=' + JSON.stringify(parsed.claim) + ' reason=' + r.reason);
        _send(entry.ws, { type: 'chest-result', txnId: parsed.txnId | 0,
          status: 'rejected', reason: r.reason });
        return;
      }
      for (const ev of r.events) mirrorApplyInvEvent(entry.userId, slot, ev);
      if (r.mark) {
        consumedTileMark(entry.userId, slot,
          parsed.mapId | 0, parsed.x | 0, parsed.y | 0, 'chest');
      }
      const fresh = mirrorReadFullState(entry.userId, slot);
      _send(entry.ws, {
        type: 'chest-result',
        txnId: parsed.txnId | 0,
        status: 'ok',
        gilAfter: fresh.gil | 0,
      });
      // v1.7.804 — mimic claim: server picks the monster + creates an
      // arbiter battle so the battle-end claim validates against a
      // canonical monster instead of whatever the client invented.
      // zoneKey passed in the claim is validated against the same
      // `_LOC_ZONE_ALLOWLIST[entry.loc]` map as `pve-encounter-request`
      // (v1.7.794) so a cheater can't claim `altar_cave_f4` mimics from
      // Ur for the fat reward pool. If PVE_ARBITER is off, fall back to
      // the legacy local-pick flow on the client side.
      if (parsed.claim?.type === 'monster' && PVE_ARBITER) {
        const zoneKey = String(parsed.claim?.zoneKey || '');
        const loc = entry.loc;
        const allowed = _LOC_ZONE_ALLOWLIST.get(loc);
        if (!allowed || !allowed.has(zoneKey)) {
          console.log('[chest-mimic] reject user=' + entry.userId +
            ' loc=' + loc + ' zone=' + zoneKey + ' reason=wrong-zone');
          return;
        }
        const battle = createMimicBattle(entry.userId, {
          slot, zoneKey, mapId: parsed.mapId | 0,
        });
        if (battle.error) {
          console.log('[chest-mimic] battle-create-failed user=' + entry.userId +
            ' zone=' + zoneKey + ' reason=' + battle.error);
          return;
        }
        console.log('[chest-mimic] start battle=' + battle.battleId +
          ' user=' + entry.userId + ' zone=' + zoneKey +
          ' mon=0x' + (battle.monsters[0]?.monsterId | 0).toString(16));
        _send(entry.ws, {
          type: 'pve-battle-start',
          battleId: battle.battleId,
          rngSeed:  battle.rngSeed,
          monsters: battle.monsters,
        });
      }
      return;
    }
    case 'vase-search': {
      // v1.7.780 P-10b — validate-only. Client rolls hit/miss + loot
      // locally, submits `claim`. Server validates against the vase pool
      // (mimic tiers excluded).
      if (!entry.helloed) return;
      if (!SERVER_ECONOMY) {
        _send(entry.ws, { type: 'vase-result', txnId: parsed.txnId | 0,
          status: 'rejected', reason: 'economy-disabled' });
        return;
      }
      const slot = (entry.slot | 0);
      const r = validateVaseSearch(entry.userId, slot, parsed);
      if (!r.ok) {
        console.log('[vase] reject user=' + entry.userId + ' map=' + parsed.mapId +
          ' claim=' + JSON.stringify(parsed.claim) + ' reason=' + r.reason);
        _send(entry.ws, { type: 'vase-result', txnId: parsed.txnId | 0,
          status: 'rejected', reason: r.reason });
        return;
      }
      for (const ev of r.events) mirrorApplyInvEvent(entry.userId, slot, ev);
      if (r.mark) {
        consumedTileMark(entry.userId, slot,
          parsed.mapId | 0, parsed.x | 0, parsed.y | 0, 'vase');
      }
      const fresh = mirrorReadFullState(entry.userId, slot);
      _send(entry.ws, {
        type: 'vase-result',
        txnId: parsed.txnId | 0,
        status: 'ok',
        gilAfter: fresh.gil | 0,
      });
      return;
    }
    case 'inv-event': {
      // v1.7.741 Phase 1a — inventory mirror authoritative-write scaffold.
      // Client emits an event for every inventory mutation; server
      // validates bounds + applies to the (userId, slot) mirror.
      //
      // Shadow mode: never rejects on state mismatch — just logs
      // `[mirror divergence]` to pm2 for forensic review. Phase 1b will
      // flip a flag to start rejecting + pushing corrective `inv-state`
      // on mismatch. See `docs/INVENTORY-MIRROR-PLAN.md` Phase 1a/1b.
      //
      // Per-kind rate limit: inv-event is user-action-driven; cap stops
      // a malicious client from flooding the mirror with no-op writes.
      // Bucket constants in PER_KIND_RATES below.
      if (!entry.helloed) return;
      // Default to entry.slot (set at hello time); explicit slot in
      // payload overrides for the rare mid-session save swap. Clamp 0-2.
      const slot = parsed.slot != null
        ? _clamp(parsed.slot | 0, 0, 2)
        : (entry.slot | 0);
      const result = mirrorApplyInvEvent(entry.userId, slot, parsed);
      if (!result.ok) {
        // Bad event — log. Two categories:
        //   bounds violations (`bad-qty`, `bad-itemId`, `bad-kind`,
        //     `bad-slot`, `use-equip-from-inv`, `no-equipped-row`) →
        //     developer bug or stale-client legacy frame; don't push
        //     corrective state, client local is canonical.
        //   divergence rejections (`divergent-remove`, `divergent-gil`,
        //     `divergent-equip`) → only emitted when
        //     INV_MIRROR_AUTHORITATIVE_SERVER is on (v1.7.745 Phase 1b /
        //     v1.7.808 for equip); push the full mirror snapshot back so
        //     the client wholesale-replaces its state to match.
        console.warn('[inv-event] reject user=' + entry.userId + ' slot=' + slot +
          ' kind=' + (parsed.kind || '?') + ' reason=' + result.reason);
        if (result.reason === 'divergent-remove' || result.reason === 'divergent-gil' ||
            result.reason === 'divergent-equip') {
          _send(entry.ws, {
            type: 'inv-state',
            reason: 'rejected',
            rejectedKind: parsed.kind || null,
            rejectedItemId: (parsed.itemId | 0),
            ...mirrorReadWireState(entry.userId, slot),
          });
        }
        return;
      }
      // Successful apply — shadow-mode divergence (if any) was already
      // logged inside mirrorApplyInvEvent.
      return;
    }
    case 'inv-state-request': {
      // v1.7.741 Phase 1a — client requests a fresh snapshot of mirror
      // state for the active slot. Used by future Phase 1c hello-sync
      // path; exposed early so clients can defensively re-pull state
      // (similar to party-resync).
      if (!entry.helloed) return;
      const slot = parsed.slot != null
        ? _clamp(parsed.slot | 0, 0, 2)
        : (entry.slot | 0);
      _send(entry.ws, {
        type: 'inv-state',
        reason: 'requested',
        ...mirrorReadWireState(entry.userId, slot),
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
      const itemId = parsed.itemId | 0;
      if (itemId <= 0 || itemId > 255) return;
      // Mirror the trade-offer type whitelist (v1.7.616) — key items aren't
      // give-able. Receiver's give-item handler in pause-menu.js silently
      // drops anything without a heal/cure effect today, so a key item
      // wouldn't apply anyway; we reject at the relay so the sender's
      // local "consume before send" doesn't burn the key on a no-op. The
      // refund channel (`give-item-failed`) re-grants the item. v1.7.793.
      const itemMeta = ITEMS.get(itemId);
      if (!itemMeta || NON_TRADEABLE_ITEM_TYPES.has(itemMeta.type)) {
        _send(entry.ws, {
          type:         'give-item-failed',
          targetUserId,
          itemId,
          reason:       'blocked',
        });
        return;
      }
      const target = _connected.get(targetUserId);
      if (!target || !target.helloed) {
        // GI-1 (v1.7.735) — sender already consumed the item locally
        // (`pause-menu.js#removeItem` runs BEFORE `sendNetGiveItem`). Tell them
        // the relay failed so their client can re-grant the item; otherwise
        // a target-just-went-offline race silently destroys the sender's
        // inventory slot. Mirror of the trade-result `reason:'offline'` shape.
        _send(entry.ws, {
          type:         'give-item-failed',
          targetUserId,
          itemId,
          reason:       'offline',
        });
        return;
      }
      console.log('[give-item] relay user=' + entry.userId + ' → ' + targetUserId + ' item=0x' + itemId.toString(16));
      _send(target.ws, {
        type: 'give-item',
        fromUserId: entry.userId,
        fromName: entry.profile.name,
        itemId,
      });
      return;
    }
    // Roster trade — sender offers an item; server stores the pending offer
    // and relays it to the target. Single outstanding offer per sender; new
    // offer overwrites old. Same trust model as 'give-item' — server doesn't
    // validate the sender actually has the item. v1.7.598.
    case 'trade-offer': {
      if (!entry.helloed) return;
      const targetUserId = parsed.targetUserId | 0;
      const itemId = parsed.itemId | 0;
      if (!targetUserId || targetUserId === entry.userId) return;
      if (itemId < 1 || itemId > 255) return;
      // Type whitelist (v1.7.616). Key items aren't transferable — they're
      // quest flags, not inventory. Server has no inventory mirror so we
      // can't validate ownership, but type filtering blocks the obvious
      // dup-equivalent on key/quest items.
      const itemMeta = ITEMS.get(itemId);
      if (!itemMeta || NON_TRADEABLE_ITEM_TYPES.has(itemMeta.type)) {
        tradeLog(entry.userId, entry.profile?.name, targetUserId, '', itemId, 0, 'blocked-type');
        _send(entry.ws, {
          type: 'trade-result', targetUserId, targetName: '', accept: false, reason: 'blocked',
        });
        return;
      }
      const target = _connected.get(targetUserId);
      if (!target || !target.helloed) {
        // Tell the sender the target isn't reachable. Same shape as
        // accept/decline so the client's `trade-result` handler covers it.
        tradeLog(entry.userId, entry.profile?.name, targetUserId, '', itemId, 0, 'offline');
        _send(entry.ws, {
          type: 'trade-result', targetUserId, targetName: '', accept: false, reason: 'offline',
        });
        return;
      }
      // Overwrite any prior outstanding offer from this sender — last write
      // wins. If the prior target is still prompting, they'll receive a
      // cancel below so their UI dismisses.
      const prior = _pendingTrades.get(entry.userId);
      if (prior && prior.targetUserId !== targetUserId) {
        const priorTarget = _connected.get(prior.targetUserId);
        if (priorTarget && priorTarget.helloed) {
          _send(priorTarget.ws, {
            type: 'trade-cancelled', fromUserId: entry.userId, fromName: entry.profile.name,
          });
        }
      }
      _pendingTrades.set(entry.userId, {
        targetUserId, itemId, expiresAt: Date.now() + TRADE_OFFER_TTL_MS,
      });
      _send(target.ws, {
        type: 'trade-offer-incoming',
        fromUserId: entry.userId,
        fromName: entry.profile.name,
        itemId,
      });
      return;
    }
    case 'trade-response': {
      if (!entry.helloed) return;
      const fromUserId = parsed.fromUserId | 0;
      const accept = !!parsed.accept;
      if (!fromUserId) return;
      const pending = _pendingTrades.get(fromUserId);
      // Validate the response actually matches an outstanding offer to US.
      // A stale or spoofed response is silently dropped — the offerer's
      // client will time out locally.
      if (!pending || pending.targetUserId !== entry.userId) return;
      _pendingTrades.delete(fromUserId);
      const offerer = _connected.get(fromUserId);
      // Decline path — log + relay, no mirror touch.
      if (!accept) {
        tradeLog(
          fromUserId, offerer?.profile?.name,
          entry.userId, entry.profile.name,
          pending.itemId, false, 'decline',
        );
        if (offerer && offerer.helloed) {
          _send(offerer.ws, {
            type: 'trade-result',
            targetUserId: entry.userId,
            targetName: entry.profile.name,
            accept: false,
          });
        }
        return;
      }
      // v1.7.802 — server-atomic accept. Pre-fix the clients drove their
      // own inv-events: receiver's `add` always landed before sender's
      // `remove`, so a crafted sender with inflated local qty could trade
      // away N items while their mirror only had 1 — mirror rejected the
      // 2nd+ removes, but the 2nd+ receivers had already added to their
      // mirrors. V-A wasn't actually closed by v1.7.745 like the changelog
      // claimed. Now the server validates sender ownership via the mirror,
      // applies both sides via `mirrorApplyInvEvent`, and pushes the fresh
      // wire state to both clients. Clients no longer emit `inv-event` for
      // trades (see `src/trade.js` v1.7.802).
      if (!offerer || !offerer.helloed) {
        // Offerer disconnected mid-prompt. Receiver doesn't preempt the
        // mirror anymore, so nothing to roll back.
        tradeLog(
          fromUserId, offerer?.profile?.name,
          entry.userId, entry.profile.name,
          pending.itemId, false, 'offerer-gone',
        );
        return;
      }
      const senderSlot   = (offerer.slot | 0);
      const receiverSlot = (entry.slot | 0);
      // Try the sender's remove first. The mirror's authoritative-mode
      // reject (`divergent-remove`) is the ownership check — if sender
      // doesn't have it, this fails BEFORE any add lands on the receiver.
      const rm = mirrorApplyInvEvent(fromUserId, senderSlot, {
        kind: 'remove', itemId: pending.itemId, qty: 1, source: 'trade',
      });
      if (!rm.ok) {
        console.warn('[trade] sender lacks item user=' + fromUserId +
          ' slot=' + senderSlot + ' item=0x' + pending.itemId.toString(16) +
          ' reason=' + rm.reason);
        tradeLog(
          fromUserId, offerer.profile?.name,
          entry.userId, entry.profile.name,
          pending.itemId, false, 'no-item',
        );
        _send(offerer.ws, {
          type: 'trade-result',
          targetUserId: entry.userId,
          targetName: entry.profile.name,
          accept: false,
          reason: 'no-item',
        });
        _send(offerer.ws, {
          type: 'inv-state',
          reason: 'trade-rejected',
          ...mirrorReadWireState(fromUserId, senderSlot),
        });
        return;
      }
      // Add to receiver. On failure or stack-cap (`add.after === add.before`
      // means the bag-stack was at 99 and the qty=1 add was clamped),
      // roll back sender's remove and bail.
      const add = mirrorApplyInvEvent(entry.userId, receiverSlot, {
        kind: 'add', itemId: pending.itemId, qty: 1, source: 'trade',
      });
      if (!add.ok || add.after === add.before) {
        // Roll back the remove. mirrorApplyInvEvent 'add' with qty=1
        // restores the slot. If that fails too (it shouldn't), log loud.
        const rb = mirrorApplyInvEvent(fromUserId, senderSlot, {
          kind: 'add', itemId: pending.itemId, qty: 1, source: 'trade-rollback',
        });
        if (!rb.ok) {
          console.error('[trade] rollback FAILED — sender lost item! user=' + fromUserId +
            ' item=0x' + pending.itemId.toString(16) + ' reason=' + rb.reason);
        }
        const reason = !add.ok ? 'mirror-error' : 'receiver-full';
        console.warn('[trade] receiver apply rejected receiver=' + entry.userId +
          ' add=' + (add.reason || 'cap') + ' → ' + reason);
        tradeLog(
          fromUserId, offerer.profile?.name,
          entry.userId, entry.profile.name,
          pending.itemId, false, reason,
        );
        _send(offerer.ws, {
          type: 'trade-result',
          targetUserId: entry.userId,
          targetName: entry.profile.name,
          accept: false,
          reason,
        });
        _send(offerer.ws, {
          type: 'inv-state',
          reason: 'trade-rejected',
          ...mirrorReadWireState(fromUserId, senderSlot),
        });
        _send(entry.ws, {
          type: 'inv-state',
          reason: 'trade-rejected',
          ...mirrorReadWireState(entry.userId, receiverSlot),
        });
        return;
      }
      // Success — log accept, tell sender, push fresh state to both so
      // clients re-render local inventory from the mirror.
      tradeLog(
        fromUserId, offerer.profile?.name,
        entry.userId, entry.profile.name,
        pending.itemId, true, 'accept',
      );
      _send(offerer.ws, {
        type: 'trade-result',
        targetUserId: entry.userId,
        targetName: entry.profile.name,
        accept: true,
      });
      _send(offerer.ws, {
        type: 'inv-state',
        reason: 'trade-applied',
        ...mirrorReadWireState(fromUserId, senderSlot),
      });
      _send(entry.ws, {
        type: 'inv-state',
        reason: 'trade-applied',
        ...mirrorReadWireState(entry.userId, receiverSlot),
      });
      return;
    }
    case 'trade-cancel': {
      if (!entry.helloed) return;
      const pending = _pendingTrades.get(entry.userId);
      if (!pending) return;
      _pendingTrades.delete(entry.userId);
      const target = _connected.get(pending.targetUserId);
      if (target && target.helloed) {
        _send(target.ws, {
          type: 'trade-cancelled',
          fromUserId: entry.userId,
          fromName: entry.profile.name,
        });
      }
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
      // One-party-per-player — reject if either side is already a member of
      // someone's party. Target check protects B from double-membership;
      // INVITER check (added v1.7.711) prevents the cascading-party bug
      // where Bob (member of Alice's party) invites Carol → Bob ends up
      // both Alice's member AND Carol's inviter, leaving the topology
      // inconsistent. A gets `self-busy` so the client can surface
      // "You're already in a party" specifically.
      if (_partyMemberships.has(entry.userId)) {
        _send(entry.ws, { type: 'party-invite-result', accept: false, reason: 'self-busy' });
        return;
      }
      if (_partyMemberships.has(targetUserId)) {
        _send(entry.ws, { type: 'party-invite-result', accept: false, reason: 'busy' });
        return;
      }
      // Server-side cooldown (v1.7.721) — survives client reload, so a
      // declined target can't be spammed by force-reloading the page.
      if (_isInviteOnCooldown(entry.userId, targetUserId)) {
        _send(entry.ws, { type: 'party-invite-result', accept: false, reason: 'cooldown' });
        return;
      }
      // Gap B (v1.7.734) — if this user already has an outgoing invite to a
      // DIFFERENT target, dismiss that target's modal before overwriting.
      // Pre-fix the previous target's `party-invite-incoming` modal stayed
      // open indefinitely; clicking Accept fell into `case 'party-invite-
      // response'`'s silent-no-op branch because the lookup found A→<new
      // target> instead of A→<old target>. Mirrors the equivalent guard in
      // `case 'trade-offer'` (line ~879).
      const priorTargetId = _partyInvites.get(entry.userId);
      if (priorTargetId && priorTargetId !== targetUserId) {
        const priorTarget = _connected.get(priorTargetId);
        if (priorTarget && priorTarget.helloed) {
          _send(priorTarget.ws, {
            type:             'party-invite-cancelled',
            challengerUserId: entry.userId,
            challengerName:   entry.profile?.name || '',
          });
        }
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
      // Inviter (A) is cancelling their own outgoing invite. Pre-v1.7.721
      // the server silently dropped the entry — target's `party-invite-
      // incoming` modal stayed open. If B then accepted, the server
      // looked up `_partyInvites`, found nothing, and silently returned;
      // B was left with A locally-added to their partyMembers despite no
      // actual party (asymmetric phantom). Now we notify B so the modal
      // dismisses, and we set the cooldown so A can't re-spam after their
      // own cancel.
      const targetUserId = _partyInvites.get(entry.userId);
      _partyInvites.delete(entry.userId);
      if (targetUserId) {
        _setInviteCooldown(entry.userId, targetUserId);
        const target = _connected.get(targetUserId);
        if (target && target.helloed) {
          _send(target.ws, {
            type:             'party-invite-cancelled',
            challengerUserId: entry.userId,
            challengerName:   entry.profile?.name || '',
          });
        }
      }
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
      if (!challengerId) {
        // Gap D (v1.7.734) — stale response (invite was cancelled, overwritten,
        // or its challenger disconnected). Pre-fix the responder's modal
        // hung forever; now we send `party-invite-cancelled` back so their
        // local prompt dismisses. Client provides the expected challenger
        // via `expectChallengerUserId` (set from `_pendingIncomingInviteFrom`)
        // so the cancelled-handler's challengerUserId-match check passes.
        const expected = parsed.expectChallengerUserId | 0;
        if (expected) {
          _send(entry.ws, {
            type:             'party-invite-cancelled',
            challengerUserId: expected,
            challengerName:   '',
          });
        }
        return;
      }
      _partyInvites.delete(challengerId);
      const challenger = _connected.get(challengerId);
      if (!challenger || !challenger.helloed) return;
      // One-party-per-player — record membership on accept so future invites
      // targeting B get the early 'busy' rejection. Reject doesn't set.
      if (accept) {
        _partyMemberships.set(entry.userId, challengerId);
        partyAddMember(entry.userId, challengerId);    // persist (v1.7.595)
        // Broadcast inParty=1 for both joiner and inviter so peer rosters
        // disable their "Party" menu against either of them. v1.7.711.
        _broadcastInPartyChange(entry.userId);
        _broadcastInPartyChange(challengerId);
      } else {
        // Decline → set the (challenger, target) cooldown so A can't
        // immediately re-invite B (with or without a client reload). The
        // expiry mirrors the client-side `COOLDOWN_MS` in party-invite.js.
        // v1.7.721.
        _setInviteCooldown(challengerId, entry.userId);
      }
      _send(challenger.ws, {
        type:    'party-invite-result',
        accept,
        partner: { userId: entry.userId, ...entry.profile, loc: entry.loc },
      });
      // Party star-topology sync (v1.7.460) — when a new member accepts and
      // the inviter already has other members, every existing member needs
      // to learn about the joiner, and the joiner needs to learn about the
      // existing members. Without this fanout the local `partyMembers` list
      // diverges across the three views: A sees [B,C] but B saw only [A]
      // and C saw only [A].
      //
      // v1.7.702 — INCLUDE THE INVITER IN THE JOINER'S SNAPSHOT.
      // Pre-fix the snapshot only listed _partyMemberships entries (which
      // is members→inviter, never the inviter themselves). The joiner's
      // ONLY source for "the inviter is in my party" was the local
      // accept-callback at party-invite.js:271-277 — if that silently
      // failed for any reason (modal race, prompt state, page reload), the
      // joiner ended up with empty partyMembers and the inviter never
      // appeared as an AI battle ally on the joiner's screen (while the
      // inviter, who learned about the joiner via the official
      // party-invite-result message, saw them just fine — the reported
      // "JoeltCo sees jointc but jointc doesn't see JoeltCo" asymmetry).
      // Server now backfills the inviter into the snapshot so both sides
      // share the same party pool authoritatively.
      if (accept) {
        const partyPool = [];
        // Inviter (challenger) first — the missing piece pre-v1.7.702.
        partyPool.push({
          userId: challengerId, ...challenger.profile, loc: challenger.loc,
        });
        for (const [memberId, inviterId] of _partyMemberships) {
          if (inviterId !== challengerId) continue;
          if (memberId === entry.userId) continue;  // skip the new joiner themselves
          const m = _connected.get(memberId);
          if (!m || !m.helloed) continue;
          partyPool.push({ userId: memberId, ...m.profile, loc: m.loc });
          // v1.7.722 — reason:'accepted' tells the client to play the
          // celebration jingle. The reconnect-fanout `party-member-joined`
          // (in `case 'hello'` above) deliberately omits the reason so
          // mates' clients don't re-jingle every time a partymate's
          // phone wakes from pocket.
          _send(m.ws, {
            type:   'party-member-joined',
            member: { userId: entry.userId, ...entry.profile, loc: entry.loc },
            reason: 'accepted',
          });
        }
        _send(entry.ws, { type: 'party-snapshot', members: partyPool });
      }
      return;
    }
    case 'party-dismiss': {
      // Inviter explicitly dismisses a member (Party → Dismiss in roster
      // menu). Only the CURRENT inviter for that member can clear it; an
      // attempt by anyone else is silently ignored.
      if (!entry.helloed) return;
      const memberUserId = parsed.memberUserId | 0;
      if (!memberUserId) return;
      if (_partyMemberships.get(memberUserId) !== entry.userId) return;
      const dismissedPeer = _connected.get(memberUserId);
      const dismissedName = dismissedPeer?.profile?.name || '';
      _partyMemberships.delete(memberUserId);
      _lastSeenProfiles.delete(memberUserId);   // D-1 (v1.7.737) — bounded growth
      partyRemoveMember(memberUserId);    // persist (v1.7.595)
      _broadcastInPartyChange(memberUserId);
      // Inviter's `inParty` may flip off if that was their last member.
      _broadcastInPartyChange(entry.userId);
      // Tell remaining party-mates (inviter + other members) the dismissed
      // member is gone so their local rosters stay in sync.
      _broadcastPartyMemberLeft(entry.userId, memberUserId, dismissedName);
      // Tell the dismissed member their party is over so they can clear
      // their whole local partyMembers (reusing the party-disbanded handler
      // — same effect from their POV: the party they were in is dead).
      if (dismissedPeer?.helloed) {
        // `reason: 'dismissed'` distinguishes this from a full disband
        // (v1.7.721). Client's handler renders "You were dismissed from
        // X's party" instead of "X's party disbanded" — accurate since
        // the party may still exist with other members.
        _send(dismissedPeer.ws, {
          type:          'party-disbanded',
          inviterUserId: entry.userId,
          inviterName:   entry.profile?.name || '',
          reason:        'dismissed',
        });
      }
      return;
    }
    case 'party-disband': {
      // Inviter dissolves their ENTIRE party in one action (chat /disband).
      // Equivalent to dismissing every member one by one but in a single
      // SQLite write + a clean party-disbanded broadcast to each member.
      if (!entry.helloed) return;
      if (_partyMemberships.has(entry.userId)) return; // I'm a member, not an inviter
      const inviterName = entry.profile?.name || '';
      // P9 (v1.7.721): also cancel any pending OUTGOING invite from this
      // user. Pre-fix the invite survived the disband — if the target then
      // accepted, the server treated it as a fresh new party with just
      // that target. Now we cancel + notify the target so their pending
      // invite-incoming modal dismisses.
      const pendingTargetUserId = _partyInvites.get(entry.userId);
      if (pendingTargetUserId) {
        _partyInvites.delete(entry.userId);
        _setInviteCooldown(entry.userId, pendingTargetUserId);
        const target = _connected.get(pendingTargetUserId);
        if (target && target.helloed) {
          _send(target.ws, {
            type:             'party-invite-cancelled',
            challengerUserId: entry.userId,
            challengerName:   inviterName,
          });
        }
      }
      const memberIds = [];
      for (const [memberId, mInviterId] of _partyMemberships) {
        if (mInviterId === entry.userId) memberIds.push(memberId);
      }
      // If there are no members AND no pending invite, the disband is a
      // no-op — the v1.7.720 unconditional-send means many `/disband`s
      // will land here harmlessly. Old behavior was to early-return at
      // `memberIds.length === 0` before any cleanup happened.
      if (memberIds.length === 0) return;
      for (const memberId of memberIds) _partyMemberships.delete(memberId);
      // D-1 (v1.7.737) — drop cached profiles for everyone leaving the
      // party. Comment at `_lastSeenProfiles` claimed this happened; the
      // delete calls were never wired. They rebuild on the user's next
      // hello / update.
      for (const memberId of memberIds) _lastSeenProfiles.delete(memberId);
      _lastSeenProfiles.delete(entry.userId);
      partyRemoveByInviter(entry.userId);   // persist (v1.7.595)
      _broadcastInPartyChange(entry.userId);          // inviter no longer in party
      for (const memberId of memberIds) _broadcastInPartyChange(memberId);
      for (const memberId of memberIds) {
        const peer = _connected.get(memberId);
        if (!peer || !peer.helloed) continue;
        _send(peer.ws, {
          type:          'party-disbanded',
          inviterUserId: entry.userId,
          inviterName,
        });
      }
      return;
    }
    case 'party-resync': {
      // Client-requested party-snapshot — used by `/party` (chat command)
      // to repair any client-server drift, and as a defensive resync from
      // anywhere the client suspects its local `partyMembers` is stale.
      // Same payload shape as the hello-time party-snapshot, including
      // offline mates from `_lastSeenProfiles`. v1.7.720; v1.7.723 stops
      // emitting skeleton entries for mates without profile data.
      if (!entry.helloed) return;
      const mateIds = _getPartyMates(entry.userId);
      const members = [];
      for (const uid of mateIds) {
        const live = _connected.get(uid);
        if (live && live.helloed) {
          members.push({ userId: uid, ...live.profile, loc: live.loc, online: 1 });
          continue;
        }
        const cached = _lastSeenProfiles.get(uid);
        if (cached) members.push({ userId: uid, ...cached, online: 0 });
      }
      _send(entry.ws, { type: 'party-snapshot', members });
      return;
    }
    case 'party-leave': {
      // Member voluntarily leaves their current party. Fan out to every
      // member (inviter + peer members), not just the inviter, so all local
      // views stay in sync. v1.7.460.
      //
      // Gap C (v1.7.734) — if the leaver is actually the INVITER (no row
      // keyed by their own userId; they only appear as the VALUE of member
      // rows), redirect into the disband path. Pre-fix `/leave` by an
      // inviter silently no-op'd server-side (the early-return at "no
      // inviterId" branch) while the client cleared local state and printed
      // "* You left the party" — on reconnect they'd get a fresh
      // party-snapshot listing every member and find themselves right back
      // as inviter, confused.
      if (!entry.helloed) return;
      const inviterId = _partyMemberships.get(entry.userId);
      if (inviterId == null) {
        // Maybe this user is an INVITER. Collect every member under them
        // and run the disband path inline (same cleanup as case 'party-
        // disband'). If they're neither member nor inviter, fall through
        // to silent no-op.
        const inviterName = entry.profile?.name || '';
        const memberIds = [];
        for (const [memberId, mInviterId] of _partyMemberships) {
          if (mInviterId === entry.userId) memberIds.push(memberId);
        }
        if (memberIds.length === 0) return;   // neither role — silent
        for (const memberId of memberIds) _partyMemberships.delete(memberId);
        // D-1 (v1.7.737) — drop cached profiles for everyone leaving.
        for (const memberId of memberIds) _lastSeenProfiles.delete(memberId);
        _lastSeenProfiles.delete(entry.userId);
        partyRemoveByInviter(entry.userId);   // persist
        _broadcastInPartyChange(entry.userId);
        for (const memberId of memberIds) _broadcastInPartyChange(memberId);
        for (const memberId of memberIds) {
          const peer = _connected.get(memberId);
          if (!peer || !peer.helloed) continue;
          _send(peer.ws, {
            type:          'party-disbanded',
            inviterUserId: entry.userId,
            inviterName,
          });
        }
        return;
      }
      _partyMemberships.delete(entry.userId);
      _lastSeenProfiles.delete(entry.userId);   // D-1 (v1.7.737) — bounded growth
      partyRemoveMember(entry.userId);    // persist (v1.7.595)
      _broadcastInPartyChange(entry.userId);
      _broadcastInPartyChange(inviterId);   // may have been the last member
      _broadcastPartyMemberLeft(inviterId, entry.userId, entry.profile?.name || '');
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
      //   - world: GLOBAL — broadcast to every helloed client (v1.7.700).
      //            Was location-scoped through v1.7.699 (`target.loc !==
      //            entry.loc → skip`), which meant Ur visitors and cave
      //            divers couldn't see each other's "world" chat — felt
      //            broken for an MMO. Per-IP / per-kind rate limits +
      //            cleanChatText profanity mask + name sanitization still
      //            apply; nothing else changes.
      //   - party: by party-membership lookup (`_inSameParty`), not by loc.
      //            See docs/MULTIPLAYER-AUDIT-2026-05-15.md #22.
      //   - pm:    targeted by `toUserId` (preferred) or `to` display name
      //            fallback. PM-by-name was the entire chat security model
      //            since v1.7.366 — anyone could rename to "Joel" and read
      //            every PM sent to Joel. See audit #8.
      if (!entry.helloed) return;
      const channel = String(parsed.channel || 'world').slice(0, 8);
      // Profanity is masked server-side so every recipient sees cleaned text
      // regardless of client (the sender's own local echo stays raw — they
      // already know what they typed). Applies to world / party / pm alike.
      const text = cleanChatText(String(parsed.text || '').slice(0, 200));
      if (!text) return;
      const senderName = entry.profile?.name || 'Player';
      if (channel === 'pm') {
        const toUserId = (parsed.toUserId | 0) || 0;
        const toName   = String(parsed.to || '').slice(0, 16);
        if (toUserId) {
          // Preferred path — direct userId target. Spoof-proof.
          const target = _connected.get(toUserId);
          if (!target || !target.helloed) {
            // PM-1 (v1.7.735) — target went offline between sender's online
            // check and the wire trip. Sender's local echo already painted
            // their message on the Private tab. Tell them so they can flag
            // the line as undelivered instead of silently misleading. Mirror
            // of `give-item-failed`.
            _send(entry.ws, {
              type:   'chat-pm-failed',
              to:     toName,
              toUserId,
              reason: 'offline',
            });
            return;
          }
          _send(target.ws, { type: 'chat', userId: entry.userId, name: senderName,
                             channel, text, to: target.profile?.name || toName });
          return;
        }
        // Legacy fallback — name-based routing. Keeps old clients working
        // until everyone is on the new wire. NEW clients should always send
        // `toUserId`.
        if (!toName) return;
        let delivered = false;
        for (const [, target] of _connected) {
          if (!target.helloed) continue;
          if (target.profile?.name !== toName) continue;
          _send(target.ws, { type: 'chat', userId: entry.userId, name: senderName,
                             channel, text, to: toName });
          delivered = true;
          break;  // stop at the first match — name collisions no longer broadcast.
        }
        if (!delivered) {
          _send(entry.ws, {
            type:   'chat-pm-failed',
            to:     toName,
            reason: 'offline',
          });
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
      // World — broadcast to every helloed client. Sender's own client
      // already added the message locally, so exclude them. Global as of
      // v1.7.700 (was per-loc; see header comment above).
      for (const [uid, target] of _connected) {
        if (uid === entry.userId) continue;
        if (!target.helloed) continue;
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

// Counts of currently-connected players. `total` includes authed-but-not-yet-
// helloed sockets; `visible` is the count other clients would see in a snapshot
// (the count UptimeRobot / status pages should display).
export function getPlayerCounts() {
  let visible = 0;
  for (const p of _connected.values()) if (p.helloed) visible++;
  return { total: _connected.size, visible };
}

// v1.7.736 — close any live WS for `userId` whose token iat is older than
// `iatMinSec` (Unix seconds). Called from `api.js#/api/logout-all` AFTER
// the `users.token_iat_min` DB bump so the user's other sessions get
// kicked off immediately rather than waiting for their next HTTP call to
// 401. The caller's NEW session (issued a fresh token with iat=now)
// won't match this filter because it hasn't upgraded its WS yet — the
// client's net.js retry loop reconnects with the fresh token. Close
// code 4002 distinguishes this from the v1.7.624 4001 "replaced" path.
export function revokeWsBeforeIat(userId, iatMinSec) {
  const entry = _connected.get(userId);
  if (!entry) return false;
  if ((entry.tokenIat | 0) >= (iatMinSec | 0)) return false;
  try { entry.ws.close(4002, 'logout-all'); } catch { /* drop */ }
  return true;
}

export function attachWebSocketPresence(httpServer) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });

  // Periodic presence snapshot + stale-shadow reap. Started here (not at
  // module load) so a Node test that imports this file without attaching
  // the server doesn't have a timer running forever. v1.7.596.
  setInterval(_flushPresence,     PRESENCE_FLUSH_MS).unref?.();
  setInterval(_reapPresence,      PRESENCE_REAP_MS).unref?.();
  setInterval(_reapConsumedTiles, CONSUMED_TILE_REAP_MS).unref?.();

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
      // v1.7.736 — stash token iat on the entry so `/api/logout-all` can
      // selectively close stale WS connections. Pre-fix the watermark bump
      // only blocked NEW requests; existing WS kept running because they
      // were validated at upgrade and never re-verified. The user's intent
      // of "kick my other devices NOW" wasn't fulfilled until each stale
      // session made its next HTTP call.
      const tokenIat = (decoded.iat | 0) || 0;
      const entry = { ws, userId, profile: null, loc: null, helloed: false, ip, tokenIat };
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
        // v1.7.747 P-1 — server-arbitrated PvP disconnect path. If this
        // user was in an arbiter-managed battle, end it and notify the
        // survivor with `pvp-cancel reason: 'opponent-disconnect'`. Lives
        // in parallel with the legacy `_pvpPartners` cleanup above; under
        // PVP_ARBITER both could fire but only one will have state for
        // any given user. P-10 cleanup deletes the legacy path.
        try {
          const arbCancel = pvpArbDisconnect(userId);
          if (arbCancel) {
            const survivor = _connected.get(arbCancel.survivorId);
            if (survivor && survivor.helloed) _send(survivor.ws, arbCancel.frame);
          }
        } catch (e) {
          console.warn('[pvp-arb] disconnect handler failed user=' + userId + ': ' + e.message);
        }
        // v1.7.772 P-2 — release the user's PvE battle slot on drop. No
        // peer to notify (PvE is single-player); just frees the tracking.
        try { cancelPveBattle(userId, 'disconnect'); }
        catch (e) { console.warn('[pve-arb] disconnect cleanup failed user=' + userId + ': ' + e.message); }
        // Clean up pending party invites involving this user.
        // Gap A (v1.7.734) — if this user had an OUTGOING invite pending,
        // tell the target so their `party-invite-incoming` modal dismisses.
        // Pre-fix the modal hung forever and any subsequent accept silently
        // no-op'd (the server's lookup found nothing to resolve). Mirror of
        // the v1.7.721 explicit `case 'party-cancel'` notify path.
        const outgoingTargetId = _partyInvites.get(userId);
        if (outgoingTargetId) {
          const outgoingTarget = _connected.get(outgoingTargetId);
          if (outgoingTarget && outgoingTarget.helloed) {
            _send(outgoingTarget.ws, {
              type:             'party-invite-cancelled',
              challengerUserId: userId,
              challengerName:   entry.profile?.name || '',
            });
          }
        }
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
        // Clean up any pending roster-trade offers involving this user.
        // Trades, unlike parties, are short-lived per-action state — they
        // don't survive a disconnect on either side. v1.7.598.
        const ownPending = _pendingTrades.get(userId);
        if (ownPending) {
          _pendingTrades.delete(userId);
          const target = _connected.get(ownPending.targetUserId);
          if (target && target.helloed) {
            _send(target.ws, {
              type: 'trade-cancelled', fromUserId: userId, fromName: entry.profile?.name || '',
            });
          }
        }
        for (const [offererId, pending] of [..._pendingTrades]) {
          if (pending.targetUserId !== userId) continue;
          _pendingTrades.delete(offererId);
          const offerer = _connected.get(offererId);
          if (offerer && offerer.helloed) {
            _send(offerer.ws, {
              type: 'trade-result',
              targetUserId: userId, targetName: entry.profile?.name || '',
              accept: false, reason: 'offline',
            });
          }
        }
        // Party memberships are PRESERVED across disconnect (v1.7.595) —
        // SQLite + `_partyMemberships` rows survive until an explicit
        // leave/dismiss. Pre-v1.7.707 we ALSO broadcast `party-member-left`
        // on every disconnect, which made peer clients prune the leaver
        // from their local partyMembers + battleAllies — so a phone going
        // into a pocket (mobile Safari suspends the WS) caused the partied
        // player to pop in and out of every active battle on the peer's
        // screen as the connection cycled. The peer still gets
        // `player-leave` (their `_onlinePlayers` updates), and on
        // reconnect the hello fanout sends a fresh party-snapshot /
        // party-member-joined so any pruned state recovers — but the
        // intermediate "left the party" hop was lossy and felt broken.
        // No party-member-left broadcast on disconnect; it now fires
        // ONLY from explicit `party-leave` / `party-dismiss` server
        // handlers. v1.7.707.
        if (entry.helloed) {
          _broadcast({ type: 'player-leave', userId }, userId);
        }
        // Voluntary disconnect drops the SQLite shadow so the user doesn't
        // appear in roster snapshots after a future server restart. A
        // graceful pm2 restart (_gracefulShutdown=true) takes the SIGKILL
        // path before close handlers run, so this branch isn't reached and
        // shadows survive — that's the design. v1.7.596.
        if (!_gracefulShutdown) {
          presenceDelete(userId);
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
  setPvpEnabled(v) { PVP_ENABLED = !!v; },
  setPvpArbiterServer(v) { PVP_ARBITER_SERVER = !!v; },
  setPveArbiter(v) { PVE_ARBITER = !!v; },
  setServerEconomy(v) { SERVER_ECONOMY = !!v; },
  pvpHookChance: _pvpHookChance,
  inSameParty: _inSameParty,
  rateAllow: _rateAllow,
  rateAllowKind: _rateAllowKind,
  perKindRates: PER_KIND_RATES,
  revokeWsBeforeIat,   // v1.7.736 — exposed for wire-sim regression test
  state: {
    connected: _connected,
    pvpSearches: _pvpSearches,
    pvpPartners: _pvpPartners,
    partyInvites: _partyInvites,
    partyMemberships: _partyMemberships,
    partyInviteCooldowns: _partyInviteCooldowns,
    lastSeenProfiles: _lastSeenProfiles,
    connsByIp: _connsByIp,
  },
  resetState() {
    _connected.clear();
    _pvpSearches.clear();
    _pvpPartners.clear();
    _partyInvites.clear();
    _partyMemberships.clear();
    _partyInviteCooldowns.clear();
    _lastSeenProfiles.clear();
    _connsByIp.clear();
  },
};
