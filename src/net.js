// net.js — WebSocket presence client. Mirrors ws-presence.js on the server.
//
// Lifecycle:
//   1. Page loads → user authenticates → JWT in localStorage as `ff3_token`.
//   2. Save slot is selected and the game starts → `connectNet(profile, locFn)`
//      is called from `main.js` / `save-state.js`.
//   3. WebSocket opens to `/api/ws?token=<JWT>`. On `ready`, client sends
//      `hello` with the current profile + location. Server snapshots back
//      the rest of the online roster.
//   4. Polling loop (500 ms) checks `locFn()` and emits `location` on change.
//   5. `sendNetUpdate(fields)` is the seam for equipment / level / HP changes.
//
// Auto-reconnect: on close, retry with exponential backoff up to 30 s.
// Reconnect re-sends `hello` so the snapshot rebuilds without losing
// presence on the local client.

const _onlinePlayers = new Map();  // userId → { userId, name, jobIdx, level, palIdx, ..., loc, isReal: true }
let _ws = null;
let _ready = false;          // server sent `ready` — safe to `hello`
let _helloed = false;        // we've sent at least one `hello`
let _profileFn = null;       // () → profile object
let _locFn = null;           // () → location string
let _lastSentLoc = null;
let _lastSentAlliesSig = '';
let _lastSentPlayerSig = '';
let _locPollHandle = null;
let _reconnectDelay = 1000;
let _myUserId = null;
let _onChat = null;          // (msg) → void — set via setNetChatHandler
let _onPVPMatch = null;      // ({opponent}) → void — set via setNetPVPMatchHandler
let _onPVPFailed = null;     // ({reason}) → void — set via setNetPVPFailedHandler
let _onPVPNone = null;       // () → void — set via setNetPVPEncounterNoneHandler
let _onPVPAction = null;     // (action) → void — set via setNetPVPActionHandler
let _onPVPAllyJoin = null;   // ({name}) → void — partner picked a fake-roster ally; mirror on our side
let _onPartyInvite = null;   // ({challenger}) → void — invite arrived; auto-respond or prompt
let _onPartyResult = null;   // ({accept, partner?, reason?}) → void — our outgoing invite resolved
let _onPartyMemberLeft = null;  // ({memberUserId, memberName}) → void — a member of OUR party disconnected/left
let _onPartyDisbanded = null;   // ({inviterUserId, inviterName}) → void — the party WE were in disbanded
const MAX_RECONNECT_DELAY = 30000;

function _getToken() {
  try { return localStorage.getItem('ff3_token') || null; }
  catch { return null; }
}

function _send(payload) {
  if (!_ws || _ws.readyState !== WebSocket.OPEN) return false;
  try { _ws.send(JSON.stringify(payload)); return true; }
  catch { return false; }
}

function _sendHello() {
  if (!_ready) return;
  if (!_profileFn || !_locFn) return;
  const profile = _profileFn();
  const loc = _locFn();
  if (!profile || !loc) return;
  if (_send({ type: 'hello', profile, loc })) {
    _helloed = true;
    _lastSentLoc = loc;
  }
}

function _handleMessage(data) {
  let msg;
  try { msg = JSON.parse(data); } catch { return; }
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'ready':
      _ready = true;
      _myUserId = msg.userId;
      _sendHello();
      return;
    case 'snapshot':
      _onlinePlayers.clear();
      for (const p of (msg.players || [])) {
        if (p.userId === _myUserId) continue;
        _onlinePlayers.set(p.userId, { ...p, isReal: true });
      }
      return;
    case 'player-join':
      if (msg.player && msg.player.userId !== _myUserId) {
        _onlinePlayers.set(msg.player.userId, { ...msg.player, isReal: true });
      }
      return;
    case 'player-leave':
      _onlinePlayers.delete(msg.userId);
      return;
    case 'player-move': {
      const p = _onlinePlayers.get(msg.userId);
      if (p) p.loc = msg.loc;
      return;
    }
    case 'player-update': {
      const p = _onlinePlayers.get(msg.userId);
      if (p && msg.fields) Object.assign(p, msg.fields);
      return;
    }
    case 'chat':
      // { userId, name, channel, text, to? } — relay to the registered
      // chat handler. If nothing is registered (no chat module imported
      // yet), drop silently.
      if (_onChat) {
        try { _onChat(msg); }
        catch (e) { console.warn('[net] chat handler error', e); }
      }
      return;
    case 'pvp-match':
      // { opponent: {userId, name, jobIdx, level, ..., loc} } — server says
      // we're matched into a PvP battle. Both parties (challenger + target)
      // receive this. Hand off to the registered handler so pvp-search.js
      // can transition to the battle UI.
      if (_onPVPMatch) {
        try { _onPVPMatch(msg); }
        catch (e) { console.warn('[net] pvp-match handler error', e); }
      }
      return;
    case 'pvp-search-failed':
      // { reason: 'offline'|'different-location'|'target-left'|'target-engaged' }
      if (_onPVPFailed) {
        try { _onPVPFailed(msg); }
        catch (e) { console.warn('[net] pvp-search-failed handler error', e); }
      }
      return;
    case 'pvp-encounter-none':
      // Reply to our `pvp-encounter` ping: no challenger hooked, proceed with
      // the regular monster encounter.
      if (_onPVPNone) {
        try { _onPVPNone(); }
        catch (e) { console.warn('[net] pvp-encounter-none handler error', e); }
      }
      return;
    case 'pvp-action':
      // Opponent's chosen action arrived. Apply it on our side so the
      // opponent's turn runs from real input rather than local AI.
      if (_onPVPAction) {
        try { _onPVPAction(msg); }
        catch (e) { console.warn('[net] pvp-action handler error', e); }
      }
      return;
    case 'pvp-ally-join':
      if (_onPVPAllyJoin) {
        try { _onPVPAllyJoin(msg); }
        catch (e) { console.warn('[net] pvp-ally-join handler error', e); }
      }
      return;
    case 'party-invite-incoming':
      if (_onPartyInvite) {
        try { _onPartyInvite(msg); }
        catch (e) { console.warn('[net] party-invite-incoming handler error', e); }
      }
      return;
    case 'party-invite-result':
      if (_onPartyResult) {
        try { _onPartyResult(msg); }
        catch (e) { console.warn('[net] party-invite-result handler error', e); }
      }
      return;
    case 'party-member-left':
      if (_onPartyMemberLeft) {
        try { _onPartyMemberLeft(msg); }
        catch (e) { console.warn('[net] party-member-left handler error', e); }
      }
      return;
    case 'party-disbanded':
      if (_onPartyDisbanded) {
        try { _onPartyDisbanded(msg); }
        catch (e) { console.warn('[net] party-disbanded handler error', e); }
      }
      return;
  }
}

function _scheduleReconnect() {
  if (_locPollHandle) { clearInterval(_locPollHandle); _locPollHandle = null; }
  setTimeout(() => _open(), _reconnectDelay);
  _reconnectDelay = Math.min(MAX_RECONNECT_DELAY, _reconnectDelay * 2);
}

function _open() {
  const token = _getToken();
  if (!token) return;  // not logged in — silent no-op
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/api/ws?token=${encodeURIComponent(token)}`;
  try { _ws = new WebSocket(url); }
  catch { _scheduleReconnect(); return; }

  _ws.addEventListener('open', () => {
    _reconnectDelay = 1000;  // reset backoff
    _startLocPoll();
  });
  _ws.addEventListener('message', (ev) => _handleMessage(ev.data));
  _ws.addEventListener('close', () => {
    _ready = false;
    _helloed = false;
    _onlinePlayers.clear();
    _scheduleReconnect();
  });
  _ws.addEventListener('error', () => { /* close fires next */ });
}

function _startLocPoll() {
  if (_locPollHandle) clearInterval(_locPollHandle);
  _locPollHandle = setInterval(() => {
    if (!_locFn || !_ready) return;
    const loc = _locFn();
    if (!loc) return;
    if (!_helloed) { _sendHello(); return; }
    if (loc !== _lastSentLoc) {
      if (_send({ type: 'location', loc })) _lastSentLoc = loc;
    }
    // MP — re-sync local profile (allies AND main-player fields) on change
    // so the server has fresh data for any party member who's looking at us.
    // Two diffs: the ally roster (changes on recruit/dismiss/death) and the
    // main-player profile (changes on level-up, equipment swap, etc).
    if (_profileFn) {
      const profile = _profileFn();
      if (profile) {
        const allies = profile.allies || [];
        const alliesSig = JSON.stringify(allies);
        if (alliesSig !== _lastSentAlliesSig) {
          _send({ type: 'update', allies });
          _lastSentAlliesSig = alliesSig;
        }
        // Strip `allies` from the player payload so we don't redundantly
        // send it again, then signature the rest. Wire is small — even a
        // full re-send on every change is fine.
        const { allies: _drop, ...playerOnly } = profile;
        const playerSig = JSON.stringify(playerOnly);
        if (playerSig !== _lastSentPlayerSig) {
          _send({ type: 'update', ...playerOnly });
          _lastSentPlayerSig = playerSig;
        }
      }
    }
  }, 500);
}

// Public API ────────────────────────────────────────────────────────────────

export function connectNet(profileFn, locFn) {
  _profileFn = profileFn;
  _locFn = locFn;
  if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) {
    // Already connecting / connected — re-hello with the new profile so the
    // server sees this client's identity even if the save slot was swapped
    // since the last connection.
    _sendHello();
    return;
  }
  _open();
}

export function sendNetUpdate(fields) {
  if (!_helloed) return;
  _send({ type: 'update', ...fields });
}

// Relay a chat message over the wire. Channel = 'world' (location-scoped),
// 'party' (party-membership-scoped — server uses `_partyMemberships`), or
// 'pm' (targeted by userId, with display-name fallback). For PM, the caller
// passes the recipient's display name; we resolve to a userId from the
// online roster so the server routes the message directly to that
// connection — closes the audit #8 name-spoofing gap.
export function sendNetChat(channel, text, to) {
  if (!_helloed) return false;
  const payload = { type: 'chat', channel, text };
  if (to) {
    payload.to = to;
    const target = getOnlinePlayerByName(to);
    if (target && target.userId) payload.toUserId = target.userId;
  }
  return _send(payload);
}

// Register a callback for incoming chat messages. Called by `chat.js`
// during init. Replaces any previous handler.
export function setNetChatHandler(fn) {
  _onChat = typeof fn === 'function' ? fn : null;
}

// PvP search wire (MP Step 3). Replaces the v1.7.222 client-side sim
// timer in `pvp-search.js`. Server runs the roll loop and broadcasts
// `pvp-match` to both parties when a hook fires.
export function sendNetPVPSearch(targetUserId) {
  if (!_helloed || !targetUserId) return false;
  return _send({ type: 'pvp-search', targetUserId });
}

export function sendNetPVPCancel() {
  if (!_helloed) return false;
  return _send({ type: 'pvp-cancel' });
}

export function setNetPVPMatchHandler(fn) {
  _onPVPMatch = typeof fn === 'function' ? fn : null;
}

export function setNetPVPFailedHandler(fn) {
  _onPVPFailed = typeof fn === 'function' ? fn : null;
}

// MP Step 3 — target-side hook: B's client signals an imminent random
// encounter so the server can roll challenger hooks at that moment (the
// "hook fires on the target's next encounter" rule the user clarified).
// Returns false if not connected — caller falls back to the local monster
// encounter immediately.
export function sendNetPVPEncounter() {
  if (!_helloed) return false;
  return _send({ type: 'pvp-encounter' });
}

export function setNetPVPEncounterNoneHandler(fn) {
  _onPVPNone = typeof fn === 'function' ? fn : null;
}

// MP Step 4 part 2 — relay the local player's action to the PvP partner so
// their client can drive the opponent's turn from real input. Action shape:
//   { kind: 'attack' | 'defend' | 'magic' | 'item' | 'run' | 'disconnect',
//     target?: 'me' | 'opp',      // for magic / item — perspective from sender
//     spellId?: number,           // for magic
//     itemId?: number,            // for item
//   }
export function sendNetPVPAction(action) {
  if (!_helloed) return false;
  return _send({ type: 'pvp-action', ...action });
}

// Tell the server the local PvP battle has ended (clears the partner pair).
export function sendNetPVPEnd() {
  if (!_helloed) return false;
  return _send({ type: 'pvp-end' });
}

// MP Step 4 part 3 — report the local battle outcome so the server can
// flag divergence between the two clients. With seed + action sync, the
// two reports should be opposite-and-matching ('won' vs 'lost') or both
// 'fled'. Anything else is logged server-side as a bug.
export function sendNetPVPResult(outcome) {
  if (!_helloed || !outcome) return false;
  return _send({ type: 'pvp-result', outcome });
}

export function setNetPVPActionHandler(fn) {
  _onPVPAction = typeof fn === 'function' ? fn : null;
}

// Ally-join — sender's `_tryJoinPlayerAlly` picked an ally for their team.
// Wire carries the full raw profile (`name, jobIdx, level, palIdx, loc,
// weapon*, armor*, helm*, shield*, knownSpells, jobLevel`) so the receiver
// can run its own `generateAllyStats` for identical output without needing
// the name to resolve in the local PLAYER_POOL. With fakes disabled by
// default (v1.7.386) and party members coming from `partyMemberProfiles`,
// the name-only path was a silent no-op on the receiver.
// See docs/MULTIPLAYER-AUDIT-2026-05-15.md #18.
export function sendNetPVPAllyJoin(profile) {
  if (!_helloed || !profile || !profile.name) return false;
  return _send({ type: 'pvp-ally-join', profile });
}

export function setNetPVPAllyJoinHandler(fn) {
  _onPVPAllyJoin = typeof fn === 'function' ? fn : null;
}

// Real party invites over the wire. Mirror of `pvp-search` lifecycle:
// challenger emits `party-invite`; server forwards to target as
// `party-invite-incoming` with the challenger's profile; target auto-rolls
// (or prompts) and emits `party-invite-response`; server relays to
// challenger as `party-invite-result` with the target's profile on accept.
export function sendNetPartyInvite(targetUserId) {
  if (!_helloed || !targetUserId) return false;
  return _send({ type: 'party-invite', targetUserId });
}

export function sendNetPartyCancel() {
  if (!_helloed) return false;
  return _send({ type: 'party-cancel' });
}

export function sendNetPartyResponse(accept) {
  if (!_helloed) return false;
  return _send({ type: 'party-invite-response', accept: !!accept });
}

// Inviter side — tell server we're removing this real-player member from
// our party so the server clears their `_partyMemberships` entry and
// future invites targeting them stop hitting the 'busy' rejection.
export function sendNetPartyDismiss(memberUserId) {
  if (!_helloed || !memberUserId) return false;
  return _send({ type: 'party-dismiss', memberUserId });
}

// Member side — voluntarily leave the current party. No UI surface today;
// hook exists for a future "Leave party" menu option.
export function sendNetPartyLeave() {
  if (!_helloed) return false;
  return _send({ type: 'party-leave' });
}

export function setNetPartyInviteHandler(fn) {
  _onPartyInvite = typeof fn === 'function' ? fn : null;
}

export function setNetPartyResultHandler(fn) {
  _onPartyResult = typeof fn === 'function' ? fn : null;
}

export function setNetPartyMemberLeftHandler(fn) {
  _onPartyMemberLeft = typeof fn === 'function' ? fn : null;
}

export function setNetPartyDisbandedHandler(fn) {
  _onPartyDisbanded = typeof fn === 'function' ? fn : null;
}

export function getOnlinePlayers() {
  return [..._onlinePlayers.values()];
}

export function getOnlineAtLocation(loc) {
  const out = [];
  for (const p of _onlinePlayers.values()) {
    if (p.loc === loc) out.push(p);
  }
  return out;
}

// Find an online player by display name. Used by `tryJoinPlayerAlly` to
// pull a fresh profile when a party member is currently online — so any
// level-up / equipment change since the invite was accepted reflects in
// the next battle. Names aren't guaranteed unique; returns the first match.
export function getOnlinePlayerByName(name) {
  if (!name) return null;
  for (const p of _onlinePlayers.values()) {
    if (p.name === name) return p;
  }
  return null;
}

export function getMyUserId() { return _myUserId; }
