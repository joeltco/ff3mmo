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

// v1.7.736 — buffer for player-update messages that arrive before the
// corresponding player-join (network reordering, esp. on a fresh hello
// fanout where the server emits join + update back-to-back). Drained
// from the `case 'player-join'` branch when the join finally lands.
// Capped to defend against unbounded growth from a misbehaving server.
const _pendingPlayerUpdates = new Map();   // userId → merged fields
const PENDING_PLAYER_UPDATES_CAP = 64;
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
let _onPlayerUpdate = null;  // (userId, mergedEntry) → void — fired after _onlinePlayers merge (v1.7.737)
let _onPVPMatch = null;      // ({opponent}) → void — set via setNetPVPMatchHandler
let _onPVPFailed = null;     // ({reason}) → void — set via setNetPVPFailedHandler
let _onPVPNone = null;       // () → void — set via setNetPVPEncounterNoneHandler
let _onPVPAction = null;     // (action) → void — set via setNetPVPActionHandler
let _onPVPAllyJoin = null;   // ({name}) → void — partner picked a fake-roster ally; mirror on our side
let _onPartyInvite = null;   // ({challenger}) → void — invite arrived; auto-respond or prompt
let _onPartyResult = null;   // ({accept, partner?, reason?}) → void — our outgoing invite resolved
let _onPartyMemberLeft = null;  // ({memberUserId, memberName}) → void — a member of OUR party disconnected/left
let _onPartyDisbanded = null;   // ({inviterUserId, inviterName, reason?}) → void — the party WE were in disbanded (reason: 'dismissed' = just us; absent = full disband, v1.7.721)
let _onPartyMemberJoined = null; // ({member}) → void — a NEW member joined OUR party (existing-member side)
let _onPartySnapshot = null;    // ({members}) → void — list of existing party peers (new-joiner side)
let _onPartyInviteCancelled = null; // ({challengerUserId, challengerName}) → void — inviter cancelled before we responded; dismiss the modal (v1.7.721)
let _onGiveItem = null;         // ({fromUserId, fromName, itemId}) → void — partner used a heal/cure item on us
let _onGiveItemFailed = null;   // ({targetUserId, itemId, reason}) → void — our outgoing give-item couldn't be delivered (v1.7.735)
let _onTradeOffer = null;       // ({fromUserId, fromName, itemId}) → void — incoming roster trade offer, prompt user
let _onTradeResult = null;      // ({targetUserId, targetName, accept}) → void — our outgoing trade resolved
let _onTradeCancelled = null;   // ({fromUserId, fromName}) → void — offerer cancelled before we responded
let _onPmFailed = null;         // ({to, toUserId?, reason}) → void — our outgoing PM couldn't be delivered (v1.7.735)
let _onInvState = null;         // ({slot, inventory, gil, equipped, ...}) → void — server pushed full inventory mirror snapshot (v1.7.741 Phase 1a)
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
        // v1.7.736 — drain any buffered player-update fields for this
        // userId that arrived BEFORE the join (network reordering).
        // Pre-fix the early update silently no-op'd (unknown userId
        // branch) and the field was lost until the next periodic update
        // or snapshot refresh.
        const pending = _pendingPlayerUpdates.get(msg.player.userId);
        if (pending) {
          Object.assign(_onlinePlayers.get(msg.player.userId), pending);
          _pendingPlayerUpdates.delete(msg.player.userId);
        }
      }
      return;
    case 'player-leave':
      _onlinePlayers.delete(msg.userId);
      // Drop any pending buffer for this user — they left, the fields
      // are stale anyway.
      _pendingPlayerUpdates.delete(msg.userId);
      return;
    case 'player-move': {
      const p = _onlinePlayers.get(msg.userId);
      if (p) p.loc = msg.loc;
      return;
    }
    case 'player-update': {
      const p = _onlinePlayers.get(msg.userId);
      if (p && msg.fields) {
        Object.assign(p, msg.fields);
        // D-2 (v1.7.737) — fire any registered subscriber (e.g.
        // party-invite.js refreshes `partyMemberProfiles` from this hook
        // so partymate level/HP/equipment caches stay live with the
        // wire). Pre-fix the cache was set at join time only and lagged
        // until the next snapshot.
        if (_onPlayerUpdate) {
          try { _onPlayerUpdate(msg.userId, p); }
          catch (e) { console.warn('[net] player-update subscriber error', e); }
        }
      }
      else if (!p && msg.fields) {
        // v1.7.736 — update arrived before the player-join for this user
        // (network reordering). Stash the fields; the player-join branch
        // above will merge them when it lands. Bounded to PENDING_CAP
        // to defend against unbounded growth from a misbehaving server
        // (or a userId that never joins).
        const existing = _pendingPlayerUpdates.get(msg.userId) || {};
        _pendingPlayerUpdates.set(msg.userId, { ...existing, ...msg.fields });
        if (_pendingPlayerUpdates.size > PENDING_PLAYER_UPDATES_CAP) {
          // Evict the oldest entry (Map preserves insertion order).
          const oldest = _pendingPlayerUpdates.keys().next().value;
          _pendingPlayerUpdates.delete(oldest);
        }
        return;
      }
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
    case 'party-member-joined':
      // An existing member of OUR party was told a new joiner accepted.
      // Existing local partyMembers list is missing that joiner; this msg
      // backfills them so views stay in sync across the whole party.
      if (_onPartyMemberJoined) {
        try { _onPartyMemberJoined(msg); }
        catch (e) { console.warn('[net] party-member-joined handler error', e); }
      }
      return;
    case 'party-snapshot':
      // We just accepted an invite and the party already had other members.
      // Server is telling us about them so our partyMembers list mirrors
      // the inviter's view.
      if (_onPartySnapshot) {
        try { _onPartySnapshot(msg); }
        catch (e) { console.warn('[net] party-snapshot handler error', e); }
      }
      return;
    case 'party-invite-cancelled':
      // The inviter cancelled (or disbanded) before we responded. Dismiss
      // the local invite-incoming modal silently so the user isn't stuck
      // staring at a stale "X wants party" prompt. v1.7.721.
      if (_onPartyInviteCancelled) {
        try { _onPartyInviteCancelled(msg); }
        catch (e) { console.warn('[net] party-invite-cancelled handler error', e); }
      }
      return;
    case 'give-item':
      if (_onGiveItem) {
        try { _onGiveItem(msg); }
        catch (e) { console.warn('[net] give-item handler error', e); }
      }
      return;
    case 'give-item-failed':
      // v1.7.735 — server couldn't deliver our give-item (target went
      // offline in the race window). Sender already consumed the item
      // locally; the handler should re-grant it.
      if (_onGiveItemFailed) {
        try { _onGiveItemFailed(msg); }
        catch (e) { console.warn('[net] give-item-failed handler error', e); }
      }
      return;
    case 'chat-pm-failed':
      // v1.7.735 — server couldn't deliver our PM (target offline). Sender's
      // local echo already painted on Private tab; the handler should flag
      // the message as undelivered.
      if (_onPmFailed) {
        try { _onPmFailed(msg); }
        catch (e) { console.warn('[net] chat-pm-failed handler error', e); }
      }
      return;
    case 'inv-state':
      // v1.7.741 Phase 1a — server pushed a full inventory mirror snapshot
      // (in 1a only via explicit `inv-state-request`; 1b will push on
      // rejection). Handler — when wired — should wholesale-replace local
      // inventory / gil / equipment / spells / jobs from the payload.
      if (_onInvState) {
        try { _onInvState(msg); }
        catch (e) { console.warn('[net] inv-state handler error', e); }
      }
      return;
    case 'trade-offer-incoming':
      if (_onTradeOffer) {
        try { _onTradeOffer(msg); }
        catch (e) { console.warn('[net] trade-offer-incoming handler error', e); }
      }
      return;
    case 'trade-result':
      if (_onTradeResult) {
        try { _onTradeResult(msg); }
        catch (e) { console.warn('[net] trade-result handler error', e); }
      }
      return;
    case 'trade-cancelled':
      if (_onTradeCancelled) {
        try { _onTradeCancelled(msg); }
        catch (e) { console.warn('[net] trade-cancelled handler error', e); }
      }
      return;
  }
}

function _scheduleReconnect() {
  if (_locPollHandle) { clearInterval(_locPollHandle); _locPollHandle = null; }
  setTimeout(() => _open(), _reconnectDelay);
  _reconnectDelay = Math.min(MAX_RECONNECT_DELAY, _reconnectDelay * 2);
}

let _retryScheduled = false;
// Tracks "did this open attempt close before the WS handshake completed?"
// Pre-handshake 401/429/network-reject all surface to the browser WS API as
// a `close` event with no useful code (1006). We infer auth failure from
// the close firing very soon after construction (no `open` event seen).
// Triggers a one-shot `/api/refresh` to fix the stale-JWT failure mode that
// otherwise produces a 401-storm of retries with the same dead token.
// v1.7.682 (Fire HD Kids tablet 7-401 storm seen in nginx access log).
let _openSawConnect = false;
let _openStartedAt = 0;
let _refreshInFlight = false;
const FAST_CLOSE_MS = 1500;  // close within this window = likely auth/server reject

async function _tryRefreshToken() {
  if (_refreshInFlight) return false;
  _refreshInFlight = true;
  try {
    const token = _getToken();
    if (!token) return false;
    const r = await fetch('/api/refresh', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (!r.ok) return false;
    const body = await r.json();
    if (!body || !body.token) return false;
    try { localStorage.setItem('ff3_token', body.token); }
    catch { /* private mode — refresh still useful for this session */ }
    return true;
  } catch { return false; }
  finally { _refreshInFlight = false; }
}

function _open() {
  if (_ws && (_ws.readyState === WebSocket.CONNECTING || _ws.readyState === WebSocket.OPEN)) return;
  const token = _getToken();
  if (!token) {
    // Fresh-page registration boot order: connectNet runs from init() before
    // the user has logged in, so the token is null. Poll for it so a successful
    // /api/register or /api/login picks up multiplayer without a page reload.
    // One timer at a time (_retryScheduled guard) — no exponential growth even
    // if connectNet or _scheduleReconnect call us repeatedly.
    if (_retryScheduled) return;
    _retryScheduled = true;
    setTimeout(() => { _retryScheduled = false; _open(); }, 2000);
    return;
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/api/ws?token=${encodeURIComponent(token)}`;
  _openSawConnect = false;
  _openStartedAt = Date.now();
  try { _ws = new WebSocket(url); }
  catch { _scheduleReconnect(); return; }

  _ws.addEventListener('open', () => {
    _openSawConnect = true;
    _reconnectDelay = 1000;  // reset backoff
    _startLocPoll();
  });
  _ws.addEventListener('message', (ev) => _handleMessage(ev.data));
  _ws.addEventListener('close', async () => {
    _ready = false;
    _helloed = false;
    _onlinePlayers.clear();
    // Fast-close before the WS handshake completed → almost certainly a
    // pre-handshake 401 (stale JWT) or 429 (per-IP cap). Try refreshing
    // the token ONCE before falling through to plain backoff retries. If
    // the refresh succeeds, retry immediately; if it fails, the user is
    // truly logged out — let the boot index.html refresh flow handle it
    // on next page load.
    const elapsed = Date.now() - _openStartedAt;
    if (!_openSawConnect && elapsed < FAST_CLOSE_MS) {
      const refreshed = await _tryRefreshToken();
      if (refreshed) {
        _reconnectDelay = 1000;
        setTimeout(() => _open(), 250);
        return;
      }
    }
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
// v1.7.737 — fires on every `player-update` AFTER _onlinePlayers merge.
// `party-invite.js` registers a subscriber that refreshes its
// `partyMemberProfiles` cache (which lags otherwise — only set at join /
// snapshot). Wired here to avoid a circular import from net.js → party-invite.js.
export function setNetPlayerUpdateHandler(fn) {
  _onPlayerUpdate = typeof fn === 'function' ? fn : null;
}

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

// Wire-give — sender used a heal / cure item on a roster target. Server
// forwards to `targetUserId`. Receiver applies the effect to their own `ps`
// in `pause-menu.js#setNetGiveItemHandler`, mirroring the local apply path.
// v1.7.416.
export function sendNetGiveItem(targetUserId, itemId) {
  if (!_helloed || !targetUserId || !itemId) return false;
  return _send({ type: 'give-item', targetUserId, itemId });
}

export function setNetGiveItemHandler(fn) {
  _onGiveItem = typeof fn === 'function' ? fn : null;
}

// v1.7.735 — sender's give-item couldn't be delivered (target offline in the
// race window). Wired in `pause-menu.js` to re-grant the consumed item and
// post a chat line so the user understands what happened.
export function setNetGiveItemFailedHandler(fn) {
  _onGiveItemFailed = typeof fn === 'function' ? fn : null;
}

// v1.7.735 — sender's PM couldn't be delivered (target offline). Wired in
// `chat.js` to flag the optimistic-echo line as undelivered.
export function setNetPmFailedHandler(fn) {
  _onPmFailed = typeof fn === 'function' ? fn : null;
}

// ── Inventory mirror Phase 1a (v1.7.741) ──────────────────────────────
//
// `INV_MIRROR_AUTHORITATIVE` is the feature flag for the mirror rollout.
// Phase 1a (this version): scaffold + ONE call site (chest open) wired
// to fire `inv-event` — but the flag is FALSE, so the local apply path
// (addItem / removeItem / etc.) still runs as the source of truth.
// Server logs `[mirror divergence]` when events disagree with mirror.
//
// Phase 1b (future flip): flag → true. Local apply paths become
// optimistic; on server rejection the client receives `inv-state` and
// wholesale-replaces local state. Flip is a one-line change here +
// matching `INV_MIRROR_AUTHORITATIVE_SERVER` in ws-presence.js.
//
// Phase 1c (multi-session): every other inventory mutation site
// (shop / loot / item-use / equip-swap / scroll / trade-resolution)
// gets migrated. Each migration is independently shippable while the
// flag is still false.
//
// Full plan: `docs/INVENTORY-MIRROR-PLAN.md`.
export const INV_MIRROR_AUTHORITATIVE = false;

// Send an inventory mutation event to the server. `kind` is one of
// 'add' | 'remove' | 'equip' | 'gil-delta'. `source` is a free-text reason
// used for divergence logging — keep it consistent with the documented
// enum so log queries are stable. Fire-and-forget: success is silent,
// rejection logs server-side (Phase 1a) or pushes inv-state back (Phase 1b).
export function sendNetInvEvent(kind, itemId, qty, source) {
  if (!_helloed) return false;
  return _send({
    type:   'inv-event',
    kind:   String(kind || ''),
    itemId: itemId | 0,
    qty:    qty | 0,
    source: String(source || 'other'),
  });
}

// Request a fresh mirror snapshot for the active slot. Phase 1a exposes
// the wire for completeness even though no client path uses it yet;
// Phase 1c will call this at hello time + as a defensive resync hook.
export function sendNetInvStateRequest() {
  if (!_helloed) return false;
  return _send({ type: 'inv-state-request' });
}

// Server pushed a full inventory-state snapshot. Phase 1a: not yet
// driven by any server event (handler is exposed but inert). Phase 1b
// will fire this on rejection — handler should wholesale-replace the
// local inventory/gil/equipment/spells/jobs from `msg`.
export function setNetInvStateHandler(fn) {
  _onInvState = typeof fn === 'function' ? fn : null;
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

// v1.7.734 — `expectChallengerUserId` lets the server send a defensive
// `party-invite-cancelled` BACK to the responder if its lookup for the
// pending invite returns empty (challenger disconnected, switched targets,
// or cancelled in the same tick). Server uses the value verbatim as the
// `challengerUserId` field on the cancelled message so the client's
// `_pendingIncomingInviteFrom`-match check passes and the prompt dismisses.
// Optional — pre-v1.7.734 callers (or any 0/missing value) still work, they
// just lose the fallback dismiss path.
export function sendNetPartyResponse(accept, expectChallengerUserId) {
  if (!_helloed) return false;
  return _send({
    type: 'party-invite-response',
    accept: !!accept,
    expectChallengerUserId: expectChallengerUserId || 0,
  });
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

// Inviter side — dissolve our ENTIRE party in one server call. Server
// emits party-disbanded to each member (who clear their local lists)
// and one DELETE FROM parties WHERE inviter_user_id=?. Caller should
// also clear their own local partyMembers — the inviter doesn't get
// echoed since they aren't in `_partyMemberships`.
export function sendNetPartyDisband() {
  if (!_helloed) return false;
  return _send({ type: 'party-disband' });
}

// Defensive resync — ask the server to send a fresh party-snapshot. The
// `setNetPartySnapshotHandler` consumer will REPLACE local partyMembers
// from the response. Used by `/party` chat command + by other client-
// suspects-drift sites. v1.7.720.
export function sendNetPartyResync() {
  if (!_helloed) return false;
  return _send({ type: 'party-resync' });
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

// Roster trade (v1.7.598). Sender → server: offer/cancel; server →
// receiver: offer-incoming/cancelled; server → sender: result. No
// server-side inventory truth — clients mutate on the result (same
// trust model as give-item).
export function sendNetTradeOffer(targetUserId, itemId) {
  if (!_helloed || !targetUserId) return false;
  return _send({ type: 'trade-offer', targetUserId: targetUserId | 0, itemId: itemId | 0 });
}
export function sendNetTradeResponse(fromUserId, accept) {
  if (!_helloed || !fromUserId) return false;
  return _send({ type: 'trade-response', fromUserId: fromUserId | 0, accept: !!accept });
}
export function sendNetTradeCancel() {
  if (!_helloed) return false;
  return _send({ type: 'trade-cancel' });
}

export function setNetTradeOfferHandler(fn) {
  _onTradeOffer = typeof fn === 'function' ? fn : null;
}
export function setNetTradeResultHandler(fn) {
  _onTradeResult = typeof fn === 'function' ? fn : null;
}
export function setNetTradeCancelledHandler(fn) {
  _onTradeCancelled = typeof fn === 'function' ? fn : null;
}

export function setNetPartyDisbandedHandler(fn) {
  _onPartyDisbanded = typeof fn === 'function' ? fn : null;
}

export function setNetPartyMemberJoinedHandler(fn) {
  _onPartyMemberJoined = typeof fn === 'function' ? fn : null;
}

export function setNetPartySnapshotHandler(fn) {
  _onPartySnapshot = typeof fn === 'function' ? fn : null;
}

export function setNetPartyInviteCancelledHandler(fn) {
  _onPartyInviteCancelled = typeof fn === 'function' ? fn : null;
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
