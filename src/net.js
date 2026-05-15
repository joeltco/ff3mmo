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
let _locPollHandle = null;
let _reconnectDelay = 1000;
let _myUserId = null;
let _onChat = null;          // (msg) → void — set via setNetChatHandler
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
// 'party' (location-scoped today; party-aware in a future step), or 'pm'
// (targeted by recipient display name). The server broadcasts to other
// clients; the local message is added via `addChatMessage` by the caller.
export function sendNetChat(channel, text, to) {
  if (!_helloed) return false;
  const payload = { type: 'chat', channel, text };
  if (to) payload.to = to;
  return _send(payload);
}

// Register a callback for incoming chat messages. Called by `chat.js`
// during init. Replaces any previous handler.
export function setNetChatHandler(fn) {
  _onChat = typeof fn === 'function' ? fn : null;
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

export function getMyUserId() { return _myUserId; }
