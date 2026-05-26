// party-invite.js — roster "Party" → invite-and-accept flow (v1.7.235).
//
// Mirror of pvp-search.js for the Party action. Picking Party starts a
// persistent "Inviting X..." invitation. The target rolls an accept
// chance every 5-12 s on a per-target sim timer. On accept, the target
// is added to `partyInviteSt.partyMembers` and will auto-join the
// player's battleAllies at the start of every future battle while they
// share the player's location. Manual-dismiss lifetime — they stay in
// the party until the user picks Party → Dismiss on the same target.
//
// Today the target's accept roll is *simulated* on a per-target timer
// (fake players don't decide anything). When real networked players
// land, swap the sim timer for the websocket-relayed "invite_response"
// signal — the rest of the flow is the same. Same cutover seam as the
// PVP search.
//
// Accept formula: level-differential + job bonus (Bard / Ranger /
// Knight), clamped. AGI doesn't fit here — see getAcceptChance for the
// constants.

import { ps } from './player-stats.js';
import { generateAllyStats } from './data/players.js';
import { battleSt } from './battle-state.js';
import { _nameToBytes } from './text-utils.js';
import { showMsgBox, replaceMsgBoxText, dismissMsgBox, showMsgBoxPrompt, yesNoLabels, msgState } from './message-box.js';
import { battleSt as _battleSt } from './battle-state.js';
import { playSFX, SFX, playPartyJoinJingle } from './music.js';
import { sendNetPartyInvite, sendNetPartyCancel, sendNetPartyResponse,
         sendNetPartyDismiss, sendNetPartyDisband, sendNetPartyResync,
         setNetPartyInviteHandler, setNetPartyResultHandler,
         setNetPartyMemberLeftHandler, setNetPartyDisbandedHandler,
         setNetPartyMemberJoinedHandler, setNetPartySnapshotHandler,
         setNetPartyInviteCancelledHandler,
         getOnlinePlayerByName } from './net.js';
import { addChatMessage } from './chat.js';

const BASE_ACCEPT   = 0.35;
const LEVEL_PER_PT  = 0.01;
const ACCEPT_MIN    = 0.15;
const ACCEPT_MAX    = 0.80;

// Bard (16) charisma/leader, Ranger (6) easy-going scout, Knight (7) formal recruiter.
const JOB_BONUS = {
  6: 0.08,
  7: 0.05,
  16: 0.20,
};

const INVITE_TIMEOUT_MS  = 5 * 60 * 1000;
const MAX_MISSED_ROLLS   = 3;
const TARGET_ROLL_MIN_MS = 5000;
const TARGET_ROLL_MAX_MS = 12000;
const COOLDOWN_MS        = 60 * 1000;
const JOINED_HOLD_MS     = 5000;   // bumped from 1000 in v1.7.722 — matches the FF3 NSF track 44 party-join jingle length so the "Joined" message and the jingle ring out together

export const PARTY_MAX = 3;

export const partyInviteSt = {
  active: false,
  target: null,
  startedAtMs: 0,
  missedRolls: 0,
  targetRollTimer: 0,
  resolving: false,
  joinedHoldMs: 0,
  isRealTarget: false,        // true when the active invite is wire-driven
  cooldowns: new Map(),       // targetName -> expiresAtMs
  partyMembers: [],           // array of player names, persistent until dismissed
  // Real-player party members — name → wire-delivered profile. Looked up by
  // `tryJoinPlayerAlly` when the name isn't in PLAYER_POOL.
  partyMemberProfiles: new Map(),
};

function _rollTimerMs() {
  return TARGET_ROLL_MIN_MS + Math.random() * (TARGET_ROLL_MAX_MS - TARGET_ROLL_MIN_MS);
}

function _now() { return performance.now(); }

export function isInviteOnCooldown(targetName) {
  const exp = partyInviteSt.cooldowns.get(targetName);
  return !!exp && exp > _now();
}

export function isInvitingTarget(target) {
  return partyInviteSt.active && !!target && partyInviteSt.target === target;
}

export function isInviteActive() {
  return partyInviteSt.active;
}

export function isInviteResolving() {
  return partyInviteSt.resolving;
}

export function getActiveInviteTargetName() {
  return partyInviteSt.active && partyInviteSt.target ? partyInviteSt.target.name : null;
}

export function isInParty(target) {
  return !!target && partyInviteSt.partyMembers.includes(target.name);
}

export function isPartyFull() {
  return partyInviteSt.partyMembers.length >= PARTY_MAX;
}

export function removeFromParty(targetName) {
  const i = partyInviteSt.partyMembers.indexOf(targetName);
  if (i >= 0) partyInviteSt.partyMembers.splice(i, 1);
  // MP — drop the cached real-player profile and tell the server to clear
  // its `_partyMemberships` entry so the dismissed player can accept new
  // invites again (one-party-per-player). v1.7.720: send the dismiss even
  // if the local cache is empty — server's authoritative and we may have
  // lost our cache on a hard reload while the server still has the
  // membership. Look up the userId from `_onlinePlayers` if cache misses.
  const profile = partyInviteSt.partyMemberProfiles.get(targetName);
  let userId = profile && profile.userId;
  if (!userId) {
    const live = getOnlinePlayerByName(targetName);
    if (live && live.userId) userId = live.userId;
  }
  if (profile) partyInviteSt.partyMemberProfiles.delete(targetName);
  if (userId) sendNetPartyDismiss(userId);
}

// Inviter-side disband. Clears every local party-mate + cached profile and
// tells the server to drop all members in one shot (server emits
// party-disbanded to each so their local lists clear too). v1.7.615.
// Members do not have an inviter-side party — they should /leave instead.
//
// v1.7.720: ALWAYS sends `party-disband` to the server, even when the
// local list is empty. Pre-fix the local-empty early-return left a phantom
// party on the server (P1 drift class) that the user couldn't clean up.
// Server is the authoritative source — local emptiness is a guess.
// Returns true to confirm the request fired (no useful "you weren't in
// a party" feedback possible without a server round-trip).
export function disbandMyParty() {
  partyInviteSt.partyMembers.length = 0;
  partyInviteSt.partyMemberProfiles.clear();
  sendNetPartyDisband();
  return true;
}

// Accept chance formula: level differential + job bonus, clamped. Lower-
// level player inviting a high-level target → harder to land; Bard/
// Ranger/Knight get a recruit bonus.
export function getAcceptChance(target) {
  const chLevel  = (typeof ps.level === 'number') ? ps.level : 1;
  const tgtStats = generateAllyStats(target);
  const tgtLevel = (tgtStats && typeof tgtStats.level === 'number') ? tgtStats.level : 1;
  const jobBonus = JOB_BONUS[ps.jobIdx] || 0;
  const raw = BASE_ACCEPT + (chLevel - tgtLevel) * LEVEL_PER_PT + jobBonus;
  return Math.max(ACCEPT_MIN, Math.min(ACCEPT_MAX, raw));
}

export function startPartyInvite(target) {
  if (partyInviteSt.active) return false;
  if (!target) return false;
  if (isInParty(target)) return false;
  if (isPartyFull()) return false;
  if (isInviteOnCooldown(target.name)) return false;
  partyInviteSt.active           = true;
  partyInviteSt.target           = target;
  partyInviteSt.startedAtMs      = _now();
  partyInviteSt.missedRolls      = 0;
  partyInviteSt.isRealTarget     = !!(target.isReal && target.userId);
  // Real-player invites have the server gate the response; local sim timer
  // is parked at Infinity so `tickPartyInvite` only watches death/timeout.
  partyInviteSt.targetRollTimer  = partyInviteSt.isRealTarget ? Infinity : _rollTimerMs();
  partyInviteSt.resolving        = false;
  showMsgBox(_nameToBytes('Inviting ' + target.name + '...'));
  if (partyInviteSt.isRealTarget) sendNetPartyInvite(target.userId);
  return true;
}

function _endInvite(targetName) {
  partyInviteSt.active = false;
  partyInviteSt.target = null;
  partyInviteSt.resolving = false;
  partyInviteSt.missedRolls = 0;
  partyInviteSt.targetRollTimer = 0;
  partyInviteSt.isRealTarget = false;
  if (targetName) {
    partyInviteSt.cooldowns.set(targetName, _now() + COOLDOWN_MS);
  }
}

export function cancelPartyInvite(reason = 'user') {
  if (!partyInviteSt.active) return;
  const targetName = partyInviteSt.target && partyInviteSt.target.name;
  const wasReal = partyInviteSt.isRealTarget;
  _endInvite(targetName);
  // Real-target invites — tell the server to drop the pending invite.
  if (wasReal && reason !== 'server') sendNetPartyCancel();
  if (reason === 'user') {
    showMsgBox(_nameToBytes('Cancelled'));
    playSFX(SFX.CONFIRM);
  } else if (reason === 'timeout' || reason === 'missed-cap') {
    showMsgBox(_nameToBytes('Invite expired'));
  } else if (reason === 'death') {
    // Silent — game-over flow owns the screen
  } else if (reason === 'rejected') {
    showMsgBox(_nameToBytes('Declined'));
  } else if (reason === 'offline') {
    showMsgBox(_nameToBytes('Target offline'));
  } else if (reason === 'busy') {
    showMsgBox(_nameToBytes('In a party'));
  } else if (reason === 'self-busy') {
    showMsgBox(_nameToBytes('Already in a party'));
  } else if (reason === 'cooldown') {
    // Server-enforced re-invite cooldown — survives client reload. v1.7.721.
    showMsgBox(_nameToBytes('Try later'));
  }
}

// Can the invite actually resolve right now? Mid-battle adds-to-party
// would be jarring — the invite *itself* persists, but resolution waits
// for the user to be out of combat.
function _canResolveInvite() {
  return battleSt.battleState === 'none';
}

function _runAcceptCheck() {
  if (!_canResolveInvite()) {
    partyInviteSt.missedRolls++;
    return;
  }
  const target = partyInviteSt.target;
  const chance = getAcceptChance(target);
  if (Math.random() < chance) {
    _resolveAsJoin();
  } else {
    partyInviteSt.missedRolls++;
  }
}

function _resolveAsJoin(remotePartner) {
  // `remotePartner` is the wire-delivered profile when a real player
  // accepted the invite — stashed into `partyMemberProfiles` so
  // `tryJoinPlayerAlly` can find them at battle start. Fake-roster path
  // passes null (the name lookup hits PLAYER_POOL directly).
  const target = remotePartner || partyInviteSt.target;
  partyInviteSt.resolving = true;
  partyInviteSt.joinedHoldMs = JOINED_HOLD_MS;
  // v1.7.722 — party-join celebration jingle (FF3 NSF track 44) on every
  // accepted invite, both inviter side (here) and acceptor side (in the
  // setNetPartyInviteHandler accept callback) and existing-member side
  // (setNetPartyMemberJoinedHandler). The jingle helper guards against
  // concurrent triggers so rapid joins don't double-stash the map music.
  playPartyJoinJingle();
  replaceMsgBoxText(_nameToBytes('Joined'), () => {
    if (target && target.name) {
      if (!partyInviteSt.partyMembers.includes(target.name) && !isPartyFull()) {
        partyInviteSt.partyMembers.push(target.name);
      }
      if (remotePartner) {
        partyInviteSt.partyMemberProfiles.set(target.name, remotePartner);
      }
    }
    _endInvite(target && target.name);
  });
}

// MP party-invite wire — receiver side (B). Server forwards A's invite with
// A's full profile. Show a Z/X prompt in the message box; the player picks.
// If B is busy (in a battle or another msg already on screen), auto-decline
// rather than overlay — protects the FSM from incoming UI during combat.
// v1.7.721 stashes the challengerUserId in `_pendingIncomingInviteFrom`
// so the `party-invite-cancelled` handler can verify it's dismissing OUR
// prompt and not some unrelated one.
let _pendingIncomingInviteFrom = null;
setNetPartyInviteHandler((msg) => {
  const challenger = msg && msg.challenger;
  if (!challenger) return;
  if (_battleSt.battleState !== 'none' || msgState.state !== 'none') {
    sendNetPartyResponse(false, challenger.userId);
    return;
  }
  _pendingIncomingInviteFrom = challenger.userId || null;
  // Two-line prompt: name + invite verb on line 1 (wraps), prompt cue on line 2.
  // The 16-char wrap puts "<Name> wants party" on line 1 (typ.) and the cue
  // on line 2.
  const text = _nameToBytes(challenger.name + ' wants party ' + yesNoLabels());
  showMsgBoxPrompt(text,
    // Accept — mirror the inviter's `_resolveAsJoin` locally so the invitee's
    // own random encounters also pull the inviter in as an ally. Server only
    // echoes the join confirmation back to the inviter (`party-invite-result`),
    // so without this stash the invitee's `partyInviteSt.partyMembers` stays
    // empty and `tryJoinPlayerAlly`'s pre-pass finds nothing → invitee fights
    // solo despite being in the party. v1.7.412.
    () => {
      // v1.7.734 — pass challenger.userId as `expectChallengerUserId` so the
      // server can defensively dismiss our modal if the invite is stale.
      const challengerUid = challenger.userId || 0;
      _pendingIncomingInviteFrom = null;
      if (challenger.name && !partyInviteSt.partyMembers.includes(challenger.name) && !isPartyFull()) {
        partyInviteSt.partyMembers.push(challenger.name);
        partyInviteSt.partyMemberProfiles.set(challenger.name, challenger);
      }
      // v1.7.722 — accepter-side celebration jingle. Mirrors the inviter
      // side (`_resolveAsJoin`) so both ends of the new pair hear it.
      playPartyJoinJingle();
      sendNetPartyResponse(true, challengerUid);
    },
    () => {
      const challengerUid = challenger.userId || 0;
      _pendingIncomingInviteFrom = null;
      sendNetPartyResponse(false, challengerUid);
    },
  );
});

// MP disband cleanup — when a real-player party member disconnects or
// leaves, drop them from the local party list + clear their cached
// profile so the next battle doesn't try to spawn a ghost ally from
// stale data. Server enforces one-party-per-player by clearing the
// membership too (so the dropped player can accept new invites).
setNetPartyMemberLeftHandler((msg) => {
  const name = msg && msg.memberName;
  if (!name) return;
  const i = partyInviteSt.partyMembers.indexOf(name);
  if (i >= 0) partyInviteSt.partyMembers.splice(i, 1);
  partyInviteSt.partyMemberProfiles.delete(name);
  addChatMessage('* ' + name + ' left the party', 'system');
});

// MP disband cleanup — this client was a MEMBER of someone's party (the
// inviter). The inviter dropped, so the party is broken. No local party
// state to clear on the member side today (members don't track which
// party they're in), but log a system message so the player knows what
// happened.
// MP party-sync — a NEW member just accepted an invite to our party. Server
// notifies every existing member so all views stay in lockstep (pre-v1.7.460
// the server only notified the inviter, leaving members with a stale star-
// topology view: A sees [B,C] but B saw only [A] and C saw only [A]).
setNetPartyMemberJoinedHandler((msg) => {
  const m = msg && msg.member;
  if (!m || !m.name) return;
  const wasNew = !partyInviteSt.partyMembers.includes(m.name);
  if (wasNew && !isPartyFull()) {
    partyInviteSt.partyMembers.push(m.name);
    partyInviteSt.partyMemberProfiles.set(m.name, m);
    addChatMessage('* ' + m.name + ' joined the party', 'system');
  }
  // v1.7.722 — celebration jingle ONLY when the server marks this as a
  // freshly accepted invite (`reason: 'accepted'`). The reconnect-fanout
  // `party-member-joined` (in ws-presence.js `case 'hello'`) deliberately
  // omits the reason so we don't re-jingle every time a partymate's phone
  // wakes from pocket. Also gated on `wasNew` so a duplicate accepted
  // event (defensive resync race) doesn't double-fire.
  if (wasNew && msg.reason === 'accepted') {
    playPartyJoinJingle();
  }
});

// MP party-sync — full party-pool snapshot from the server. Sent in three
// places: (1) inviter-side accept response (joiner gets the existing
// pool), (2) reconnect hello-time fanout (returning user gets their
// party), (3) `/party` chat command's defensive resync (v1.7.720).
//
// v1.7.720: REPLACE semantics. Server is authoritative for membership; any
// local divergence (lost cache on hard reload, missed party-member-left
// during a network blip) is corrected by trusting the snapshot in full.
// Offline mates carry `online: 0` + their last-known profile from
// `_lastSeenProfiles` on the server — stashed locally so the roster's
// `_partyRosterEntries` fallback can render them without a live lookup.
// Pre-fix: append-only loop, so a stale local entry could survive a
// snapshot that removed it server-side.
setNetPartySnapshotHandler((msg) => {
  const members = Array.isArray(msg && msg.members) ? msg.members : [];
  partyInviteSt.partyMembers.length = 0;
  partyInviteSt.partyMemberProfiles.clear();
  for (const m of members) {
    if (!m || !m.name) continue;
    if (isPartyFull()) break;
    partyInviteSt.partyMembers.push(m.name);
    partyInviteSt.partyMemberProfiles.set(m.name, m);
  }
  // Pending /party render — fire the one-shot callback the chat command
  // registered before issuing the resync. setTimeout guarantees the
  // command's setTimeout (fallback) doesn't race the snapshot reply.
  if (_pendingResyncCallback) {
    const cb = _pendingResyncCallback;
    _pendingResyncCallback = null;
    try { cb(); } catch (e) { /* swallow — diagnostic only */ }
  }
});

// One-shot callback for the `/party` chat command (and any other site that
// wants to render after a fresh resync). `requestPartyResync(cb)` sends
// the wire message + arms the callback; the snapshot handler above fires
// it on the next snapshot. Fallback timer fires the callback after 800 ms
// in case the server doesn't reply (offline, rate-limited, etc.).
let _pendingResyncCallback = null;
export function requestPartyResync(cb) {
  if (typeof cb !== 'function') { sendNetPartyResync(); return; }
  if (_pendingResyncCallback) {
    // Coalesce — earlier caller wins, new one fires too via shared timer.
    const prev = _pendingResyncCallback;
    _pendingResyncCallback = () => { try { prev(); } catch (_) {} try { cb(); } catch (_) {} };
  } else {
    _pendingResyncCallback = cb;
  }
  sendNetPartyResync();
  setTimeout(() => {
    if (!_pendingResyncCallback) return;
    const fallback = _pendingResyncCallback;
    _pendingResyncCallback = null;
    try { fallback(); } catch (_) {}
  }, 800);
}

setNetPartyDisbandedHandler((msg) => {
  const name = msg && msg.inviterName;
  if (!name) return;
  // The whole party we were in is gone (inviter disbanded, or we were
  // dismissed from a party that was otherwise empty). Clear EVERY local
  // party-mate + cached profile — not just the inviter — so future
  // battles don't pull in any ghost ally. v1.7.412 cleared one name;
  // v1.7.615 generalized to the full party since /disband (inviter-side)
  // and the inviter-side party-dismiss both route through this handler.
  partyInviteSt.partyMembers.length = 0;
  partyInviteSt.partyMemberProfiles.clear();
  // P8 (v1.7.721) — server now flags single-member dismissals with
  // `reason: 'dismissed'` so the chat message reads accurately. Pre-fix
  // a dismissed member saw "X's party disbanded" even though the party
  // could still have other members; just THEY were kicked.
  const txt = msg.reason === 'dismissed'
    ? '* You were dismissed from ' + name + "'s party"
    : '* ' + name + "'s party disbanded";
  addChatMessage(txt, 'system');
});

// v1.7.721 — inviter (challenger) cancelled their invite before we
// responded. Dismiss the modal silently so we're not stuck staring at
// the stale prompt. Defensive against the unlikely case where another
// prompt has overlaid since: only dismiss if `_pendingIncomingInviteFrom`
// matches the cancelling challenger. The msgState.isPrompt block in
// movement.js owns Z/X for open msgboxes since v1.7.643 — we just need
// to call `dismissMsgBox` to clear it.
setNetPartyInviteCancelledHandler((msg) => {
  const fromUid = msg && msg.challengerUserId;
  if (_pendingIncomingInviteFrom == null) return;
  if (fromUid != null && fromUid !== _pendingIncomingInviteFrom) return;
  _pendingIncomingInviteFrom = null;
  if (msgState.isPrompt) dismissMsgBox();
});

// Inviter side (A) — server relays B's response. On accept we have B's
// fresh profile; route through the existing `_resolveAsJoin` swap so the
// "Joined" message + cooldown logic stays in one place.
setNetPartyResultHandler((msg) => {
  if (!partyInviteSt.active || !partyInviteSt.isRealTarget) return;
  if (msg && msg.accept && msg.partner) {
    _resolveAsJoin(msg.partner);
    return;
  }
  if (msg && msg.reason === 'offline') {
    cancelPartyInvite('offline');
    return;
  }
  if (msg && msg.reason === 'busy') {
    cancelPartyInvite('busy');
    return;
  }
  // v1.7.711 — server rejected because the INVITER (us) is already in a
  // party. Different from `busy` (which means the TARGET is). Distinct
  // cancel reason so the message reads "You're already in a party"
  // instead of "<Name> is busy".
  if (msg && msg.reason === 'self-busy') {
    cancelPartyInvite('self-busy');
    return;
  }
  // v1.7.721 — server-enforced cooldown on a recently-declined target.
  if (msg && msg.reason === 'cooldown') {
    cancelPartyInvite('cooldown');
    return;
  }
  // Server reported a rejection — show the "Declined" message and apply
  // the standard cooldown.
  cancelPartyInvite('rejected');
});

export function tickPartyInvite(dt) {
  if (!partyInviteSt.active) return;
  if (partyInviteSt.resolving) {
    if (partyInviteSt.joinedHoldMs > 0) {
      partyInviteSt.joinedHoldMs -= dt;
      if (partyInviteSt.joinedHoldMs <= 0) {
        partyInviteSt.joinedHoldMs = 0;
        dismissMsgBox();
      }
    }
    return;
  }
  if (ps.hp <= 0) {
    cancelPartyInvite('death');
    return;
  }
  if (_now() - partyInviteSt.startedAtMs > INVITE_TIMEOUT_MS) {
    cancelPartyInvite('timeout');
    return;
  }
  if (partyInviteSt.missedRolls >= MAX_MISSED_ROLLS) {
    cancelPartyInvite('missed-cap');
    return;
  }
  // Real-target invites are gated by the server's relay of the target's
  // response — no local sim roll. `tickPartyInvite` only watches death /
  // timeout in that branch.
  if (partyInviteSt.isRealTarget) return;
  partyInviteSt.targetRollTimer -= dt;
  if (partyInviteSt.targetRollTimer <= 0) {
    _runAcceptCheck();
    partyInviteSt.targetRollTimer = _rollTimerMs();
  }
}
