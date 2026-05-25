// chat.js — console + chat: message buffer, commands, auto-chat, expand/collapse, HUD rendering

import { PLAYER_POOL, CHAT_PHRASES, ROSTER_FADE_STEPS } from './data/players.js';
import { selectCursor, saveSlots } from './save-state.js';
import { _nesNameToString, _nameToBytes } from './text-utils.js';
import { drawText, measureText, TEXT_WHITE } from './font-renderer.js';
import { drawCursorFaded } from './hud-drawing.js';
import { nesColorFade } from './palette.js';
import { partyInviteSt, disbandMyParty } from './party-invite.js';
import { sendNetPartyLeave } from './net.js';
import { mapSt } from './map-state.js';
import { battleSt } from './battle-state.js';
import { sprite } from './player-sprite.js';
import { DIR_DOWN, DIR_UP, DIR_LEFT, DIR_RIGHT } from './sprite.js';
import { playFF1Track, stopFF1Music, playFF2Track, stopFF2Music, pauseMusic, resumeMusic, playMentionChime, playSFX } from './music.js';
import { ui } from './ui-state.js';
import { ps, changeJob, fullHeal, grantExp, MAX_LEVEL } from './player-stats.js';
import { JOBS } from './data/jobs.js';
import { swapBattleSprites } from './job-sprites.js';
import { saveSlotsToDB } from './save-state.js';
import { sendNetChat, setNetChatHandler, getOnlinePlayerByName, getOnlinePlayers } from './net.js';
import { ITEMS } from './data/items.js';
import { addItem } from './inventory.js';
import { getItemNameClean, getSpellNameClean, bytesToAscii } from './text-decoder.js';
import { applyBuff, hasBuff, clearAllBuffs, ALL_BUFFS } from './buffs.js';

// ── Constants ──────────────────────────────────────────────────────────────
const CHAT_LINE_H      = 9;
const CHAT_HISTORY     = 30;
const CHAT_EXPAND_MS   = 650;
const CHAT_AUTO_MIN_MS = 5000;
const CHAT_AUTO_MAX_MS = 16000;
// Player bug report: 42 was too tight for `/bug` descriptions + longer chat.
// Server still caps at 200 (see api.js); 80 fits ~3 visual rows in the
// expanded panel — see _wrapInputText. v1.7.637 (second attempt; v1.7.628's
// raise was reverted because the panel grew without a BG; we now auto-expand
// instead, which reuses _drawChatExpandBG and avoids that whole class of bug).
const CHAT_INPUT_CAP   = 80;

// NES layout — must match game.js
const CANVAS_W   = 256;
const CANVAS_H   = 240;
const HUD_VIEW_Y = 32;
const HUD_BOT_H  = 64;

// ── Chat tabs ─────────────────────────────────────────────────────────────
// `CHAT_TABS` is the static IDENTITY array — code that branches on
// "which tab is this?" (e.g. `CHAT_TABS[activeTab] === 'Private'`) keeps
// using these literals. For VISUAL labels go through `getTabLabel(idx)`
// — the Private tab renders the focused PM partner's name instead of the
// literal "Private" (v1.7.703). Falls back to "Private" when no
// conversation is focused so the tab is never blank.
export const CHAT_TABS = ['World', 'Party', 'Private', 'System'];
export function getTabLabel(tabIdx) {
  if (CHAT_TABS[tabIdx] === 'Private') {
    const partner = _pmTarget();
    return partner || 'Private';
  }
  return CHAT_TABS[tabIdx];
}
export let activeTab = 0;  // index into CHAT_TABS
export let tabSelectMode = false;
let _tabBlinkStart = 0;
let _tabScrollX = 0;      // current scroll offset (animated)
let _tabScrollTarget = 0;  // target scroll offset
const _tabUnread = [false, false, false, false]; // unread notification per tab
export let chatScrollOffset = 0; // how many rows scrolled up from bottom
export function setChatScrollOffset(v) { chatScrollOffset = Math.max(0, Math.min(v, _chatMaxScroll)); }
export function setActiveTab(i) { activeTab = i; _tabBlinkStart = Date.now(); _tabScrollTarget = 0; _tabUnread[i] = false; chatScrollOffset = 0; }
export function setTabSelectMode(v) { tabSelectMode = v; _tabBlinkStart = Date.now(); if (!v) chatScrollOffset = 0; }

// Cached during the last _drawChatTextArea call. Used by the input handler
// (movement.js) to clamp scroll without re-running row layout, and by the
// arrow renderer below.
let _chatTotalRows = 0;
let _chatAvailRows = 0;
let _chatMaxScroll = 0;
export function getChatMaxScroll() { return _chatMaxScroll; }
export function canChatScrollUp() { return chatScrollOffset < _chatMaxScroll; }
export function canChatScrollDown() { return chatScrollOffset > 0; }

// ── Mutable state (exported so game.js can read/write directly) ────────────
export const chatState = {
  messages:    [],     // [{ text, type, channel }] type: 'chat'|'system'|'console', channel: 'all'|'party'|'world'|'pm'|'sys'
  autoTimer:   8000,   // ms until next auto message
  fontReady:   false,
  inputActive: false,  // t key opens input
  inputText:   '',
  cursorTimer: 0,      // blinks every 500 ms
  expanded:    false,  // T (shift) toggles expanded view
  expandAnim:  0,      // 0=collapsed, 1=expanded (animated)
  pendingRecipient: null,  // PM recipient name, stashed when roster Message
                           // action opens chat input. Cleared on send / escape
                           // / fresh 't' open. v1.7.238.
};

// ── Mentions + PM state ─────────────────────────────────────────────────────

// Active save-slot name — labels outgoing messages and detects @-mentions in
// incoming ones. Falls back to 'You' before a slot is chosen.
export function localPlayerName() {
  const slot = saveSlots[selectCursor];
  return (slot && slot.name) ? _nesNameToString(slot.name) : 'You';
}

let _lastPmFrom = null;     // last player who PM'd us — target for `/r`
let _lastPmPartner = null;  // last PM peer (either direction) — default Private-tab target
let _pmSession = null;      // conversation currently in focus on the Private tab

// The partner name a pm message belongs to, from the local player's POV:
// outgoing → recipient, incoming → sender. Partnerless pm lines (hints/errors)
// return null so they show in every conversation.
function _pmPartnerOf(msg) {
  if (msg.channel !== 'pm') return null;
  const me = localPlayerName();
  if (msg.from && msg.from === me) return msg.to || null;
  return msg.from || null;
}

// Distinct PM partners in first-seen order — the navigable session list.
export function pmPartners() {
  const seen = [];
  for (const m of chatState.messages) {
    const p = _pmPartnerOf(m);
    if (p && !seen.includes(p)) seen.push(p);
  }
  return seen;
}

// Conversation currently in focus: explicit session pick wins, then a roster /
// `/pm` recipient, then the last partner, then the newest conversation.
function _activePmPartner() {
  if (_pmSession) return _pmSession;
  if (chatState.pendingRecipient) return chatState.pendingRecipient;
  if (_lastPmPartner) return _lastPmPartner;
  const list = pmPartners();
  return list.length ? list[list.length - 1] : null;
}

// Up/down on the Private tab pages through conversations (wraps). The reply
// target follows the focused session and the view resets to its latest line.
export function pmSessionStep(dir) {
  const list = pmPartners();
  if (list.length === 0) return;
  let idx = list.indexOf(_activePmPartner());
  if (idx < 0) idx = list.length - 1;
  _pmSession = list[(idx + dir + list.length) % list.length];
  chatState.pendingRecipient = _pmSession;
  setChatScrollOffset(0);
}

// Number of distinct conversations — drives the "more sessions" arrow cue.
export function pmSessionCount() { return pmPartners().length; }

// Focus a conversation and make it the reply target — used by the roster
// "Message" action. Sets _pmSession (which outranks pendingRecipient in
// _activePmPartner) so opening Message on a new player overrides whatever
// conversation was previously in focus.
export function focusPmSession(name) {
  _pmSession = name || null;
  chatState.pendingRecipient = name || null;
  setChatScrollOffset(0);
}

// Reply target = the focused conversation. Used by the send path + prompt.
function _pmTarget() { return _activePmPartner(); }

// True if `text` @-mentions `name`. Case-insensitive; the name's spaces are
// stripped so "@JohnDoe" pings "John Doe". Matches the whole @-token only, so
// "@jo" won't ping "John" (autocomplete inserts the full name).
function _mentions(text, name) {
  const compact = String(name || '').replace(/\s+/g, '').toLowerCase();
  if (!compact) return false;
  const toks = String(text).toLowerCase().match(/@([a-z0-9]+)/g);
  return !!toks && toks.some(t => t.slice(1) === compact);
}

// ── Public API ─────────────────────────────────────────────────────────────

export function addChatMessage(text, type, channel, meta) {
  // Default channel based on type. Untyped user chat lands on 'party'
  // (was 'room' pre-v1.7.236 when Room was the location-scoped tab).
  if (!channel) {
    if (type === 'console' || type === 'system') channel = 'sys';
    else channel = 'party';
  }
  const msg = { text, type: type || 'chat', channel };
  // Optional sender / recipient for pm-channel routing — used by the
  // websocket layer to filter Private to conversations the local
  // player is part of. v1.7.238.
  if (meta) {
    if (meta.from) msg.from = meta.from;
    if (meta.to)   msg.to   = meta.to;
    if (meta.mention) msg.mention = true;  // renders highlighted (see _buildChatRows)
  }
  chatState.messages.push(msg);
  while (chatState.messages.length > CHAT_HISTORY) chatState.messages.shift();
  // Mark background tabs as unread
  const tabMap = { world: 0, party: 1, pm: 2, sys: 3 };
  const tabIdx = tabMap[channel];
  if (tabIdx !== undefined && tabIdx !== activeTab && tabIdx !== 3) _tabUnread[tabIdx] = true;
}

// Client-side block list. Persisted in localStorage so /block survives a
// page reload. Matched on either userId (preferred — spoof-proof since
// PM-by-userId landed in v1.7.388) or name (fallback for old messages).
// Stored as plain arrays in localStorage so the contents are inspectable.
// See docs/MULTIPLAYER-AUDIT-2026-05-15.md — pre-beta P1 #3.
const _blockedIds   = new Set();
const _blockedNames = new Set();
try {
  const ids = JSON.parse(localStorage.getItem('ff3_blocked_ids')   || '[]');
  const names = JSON.parse(localStorage.getItem('ff3_blocked_names') || '[]');
  ids.forEach(i => _blockedIds.add(i | 0));
  names.forEach(n => _blockedNames.add(String(n)));
} catch { /* corrupt JSON — ignore */ }
function _persistBlocks() {
  try {
    localStorage.setItem('ff3_blocked_ids',   JSON.stringify([..._blockedIds]));
    localStorage.setItem('ff3_blocked_names', JSON.stringify([..._blockedNames]));
  } catch { /* quota / private mode — silent */ }
}

// Multiplayer Step 2 — install the network chat receiver. Module-load time
// registration is fine: `net.js` only invokes the handler after WebSocket
// connect, which happens later in the boot sequence.
setNetChatHandler((msg) => {
  // msg = { userId, name, channel, text, to? }
  if (!msg || !msg.text) return;
  // Block filter — silently drop messages from anyone the user has /block'd.
  // Match by userId first (resilient to renames); name fallback covers old
  // wire payloads that don't carry userId.
  if (msg.userId != null && _blockedIds.has(msg.userId | 0)) return;
  if (msg.name && _blockedNames.has(msg.name)) return;
  const senderName = msg.name || 'Player';
  const channel = msg.channel || 'world';
  const mentioned = _mentions(msg.text, localPlayerName());
  const meta = {};
  if (msg.to) { meta.from = senderName; meta.to = msg.to; }
  if (mentioned) meta.mention = true;
  const displayText = msg.to
    ? senderName + ' → ' + msg.to + ': ' + msg.text
    : senderName + ': ' + msg.text;
  addChatMessage(displayText, 'chat', channel, Object.keys(meta).length ? meta : null);
  if (channel === 'pm') {
    _lastPmFrom = senderName; _lastPmPartner = senderName;
    if (!_pmSession) _pmSession = senderName;  // focus first convo; don't yank an active one
  }
  // Chime on an @-mention always; on an incoming PM only when you're not
  // already watching the Private tab (no point pinging a live conversation).
  if (mentioned || (channel === 'pm' && activeTab !== 2)) playMentionChime();
});

function _passesTabFilter(msg) {
  const tab = CHAT_TABS[activeTab];
  if (tab === 'World') return msg.channel === 'world' || msg.channel === 'sys';
  if (tab === 'Party') return msg.channel === 'party';
  if (tab === 'Private') {
    // Show only the focused conversation. Partnerless pm lines (hints/errors)
    // pass through; before any PM exists, show nothing.
    if (msg.channel !== 'pm') return false;
    const partner = _pmPartnerOf(msg);
    if (!partner) return true;
    return partner === _activePmPartner();
  }
  if (tab === 'System') return msg.channel === 'sys';
  return true;
}

// ── Commands ──────────────────────────────────────────────────────────────

// Dev whitelist — emails that can run state-mutating commands. Authoritative
// only as a UX gate (client-side state mutation only); the day server-auth
// PVP ships, the server has to enforce. Add teammate emails here.
const DEV_EMAILS = new Set([
  'joeltaylor734@gmail.com',
]);

export function isDev() {
  const email = (localStorage.getItem('ff3_email') || '').toLowerCase();
  return DEV_EMAILS.has(email);
}

const COMMANDS = new Map();

function registerCommand(name, desc, handler, opts = {}) {
  COMMANDS.set(name, { desc, handler, dev: !!opts.dev });
}

registerCommand('help', 'List available commands', () => {
  addChatMessage('Available commands:', 'console');
  const dev = isDev();
  for (const [name, cmd] of COMMANDS) {
    if (cmd.dev && !dev) continue;
    const tag = cmd.dev ? ' [dev]' : '';
    addChatMessage('  /' + name + tag + ' — ' + cmd.desc, 'console');
  }
});

registerCommand('clear', 'Clear console', () => {
  chatState.messages.length = 0;
});

registerCommand('who', 'Show players in area', (_args, ctx) => {
  if (!ctx.getRosterNames) { addChatMessage('Roster not available', 'console'); return; }
  const names = ctx.getRosterNames();
  addChatMessage(names.length + ' player(s) in area:', 'console');
  for (const n of names) addChatMessage('  ' + n, 'console');
});

registerCommand('block', 'Block a player: /block <name>  |  /block (list)  |  /block clear', (args) => {
  const a = (args || '').trim();
  if (a === '') {
    if (_blockedIds.size === 0 && _blockedNames.size === 0) {
      addChatMessage('No blocked players.', 'console');
      return;
    }
    addChatMessage('Blocked:', 'console');
    for (const n of _blockedNames) addChatMessage('  ' + n, 'console');
    return;
  }
  if (a.toLowerCase() === 'clear') {
    _blockedIds.clear(); _blockedNames.clear(); _persistBlocks();
    addChatMessage('Block list cleared.', 'console');
    return;
  }
  // Resolve to userId via the online roster. If they're offline, store by
  // name only — block still applies the next time their messages arrive.
  const target = getOnlinePlayerByName(a);
  _blockedNames.add(a);
  if (target && target.userId) _blockedIds.add(target.userId | 0);
  _persistBlocks();
  addChatMessage('Blocked ' + a + '.', 'console');
});

registerCommand('unblock', 'Unblock a player: /unblock <name>', (args) => {
  const a = (args || '').trim();
  if (!a) { addChatMessage('Usage: /unblock <name>', 'console'); return; }
  _blockedNames.delete(a);
  const target = getOnlinePlayerByName(a);
  if (target && target.userId) _blockedIds.delete(target.userId | 0);
  _persistBlocks();
  addChatMessage('Unblocked ' + a + '.', 'console');
});

registerCommand('report', 'Report a player: /report <name> <reason>', (args) => {
  const m = (args || '').trim().match(/^(\S+)\s+(.+)$/);
  if (!m) { addChatMessage('Usage: /report <name> <reason>', 'console'); return; }
  const name = m[1], reason = m[2].slice(0, 200);
  const target = getOnlinePlayerByName(name);
  const targetUserId = target && target.userId ? (target.userId | 0) : null;
  const token = localStorage.getItem('ff3_token');
  if (!token) {
    addChatMessage('Log in to file reports.', 'console');
    return;
  }
  fetch('/api/chat-report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ targetUserId, targetName: name, reason }),
  })
  .then(r => {
    if (r.ok)         addChatMessage('Report sent. Thanks.', 'console');
    else if (r.status === 429) addChatMessage('Slow down — too many reports.', 'console');
    else              addChatMessage('Report failed (HTTP ' + r.status + ').', 'console');
  })
  .catch(() => addChatMessage('Report failed (network).', 'console'));
});

registerCommand('bug', 'Report a bug: /bug <description>', (args) => {
  const text = (args || '').trim().slice(0, 500);
  if (!text) { addChatMessage('Usage: /bug <description of the problem>', 'console'); return; }
  const token = localStorage.getItem('ff3_token');
  if (!token) { addChatMessage('Log in to report bugs.', 'console'); return; }
  // Auto-attach context for repro. Position is pixels → tiles (16px). The
  // server already knows userId from the JWT; we send the rest.
  let version = '';
  try { version = localStorage.getItem('ff3_build') || ''; } catch (_) {}
  const ctx = {
    text,
    playerName: localPlayerName(),
    version,
    mapId: mapSt.currentMapId,
    tileX: Math.round((mapSt.worldX || 0) / 16),
    tileY: Math.round((mapSt.worldY || 0) / 16),
    onWorldMap: !!mapSt.onWorldMap,
    dungeonFloor: mapSt.dungeonFloor,
    battleState: battleSt.battleState,
  };
  fetch('/api/bug-report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify(ctx),
  })
  .then(r => {
    if (r.ok)         addChatMessage('Bug report sent. Thanks for helping!', 'console');
    else if (r.status === 429) addChatMessage('Slow down — too many reports.', 'console');
    else              addChatMessage('Report failed (HTTP ' + r.status + ').', 'console');
  })
  .catch(() => addChatMessage('Report failed (network).', 'console'));
});

// Send a PM: echo it locally on the Private tab, relay over the wire, and
// remember the recipient as the current conversation partner. PM hints/echoes
// use channel 'pm' (not 'console') so they land on the Private tab the user is
// looking at, not the System tab.
function _sendPm(name, message) {
  const text = String(message || '').trim();
  if (!name) { addChatMessage('No PM recipient. Use /pm <name> <message>.', 'system', 'pm'); return; }
  if (!text) return;
  const me = localPlayerName();
  addChatMessage(me + ' → ' + name + ': ' + text, 'chat', 'pm', { from: me, to: name });
  sendNetChat('pm', text, name);
  chatState.pendingRecipient = name;
  _lastPmPartner = name;
  _pmSession = name;  // sending focuses that conversation on the Private tab
}

function _pmCommand(args) {
  const m = (args || '').match(/^(\S+)\s+([\s\S]+)$/);
  if (!m) { addChatMessage('Usage: /pm <name> <message>', 'system', 'pm'); return; }
  const target = getOnlinePlayerByName(m[1]);
  if (!target || !target.name) { addChatMessage('No online player "' + m[1] + '".', 'system', 'pm'); return; }
  _sendPm(target.name, m[2]);
}
registerCommand('pm',   'Private message: /pm <name> <message>', _pmCommand);
registerCommand('w',    'Whisper — alias of /pm: /w <name> <message>', _pmCommand);
registerCommand('tell', 'Alias of /pm: /tell <name> <message>', _pmCommand);
registerCommand('msg',  'Alias of /pm: /msg <name> <message>', _pmCommand);
registerCommand('r', 'Reply to the last player who PM\'d you: /r <message>', (args) => {
  if (!_lastPmFrom) { addChatMessage('No one has messaged you yet.', 'system', 'pm'); return; }
  _sendPm(_lastPmFrom, args);
});

// Diagnostic: print the client-side party state (what
// `tryJoinPlayerAlly` actually iterates when battle starts). Useful when
// "party help isn't appearing in battle" — confirms whether the local
// mirror has the expected names AND whether each is currently online (the
// fill loop drops anyone `getOnlinePlayerByName` can't find). v1.7.701.
registerCommand('party', 'Show your party + each member\'s online state', () => {
  const names = partyInviteSt.partyMembers || [];
  if (names.length === 0) {
    addChatMessage('You are not in a party.', 'console');
    return;
  }
  addChatMessage('Party (' + names.length + '):', 'console');
  for (const n of names) {
    const online = !!getOnlinePlayerByName(n);
    addChatMessage('  ' + n + (online ? '  ONLINE' : '  offline'), 'console');
  }
});

registerCommand('disband', 'Dismiss your entire party (inviter only)', () => {
  if (disbandMyParty()) {
    addChatMessage('* You disbanded the party', 'system');
  } else {
    addChatMessage('No party to disband.', 'console');
  }
});

registerCommand('leave', 'Leave the party you\'re currently in', () => {
  // Member-side leave. Server's `party-leave` handler clears persistence +
  // notifies remaining members via party-member-left. Local partyMembers
  // mostly tracks the inviter-side roster; for members we still clear so
  // any stale view drops too.
  if (partyInviteSt.partyMembers.length === 0) {
    addChatMessage('You\'re not in a party.', 'console');
    return;
  }
  partyInviteSt.partyMembers.length = 0;
  partyInviteSt.partyMemberProfiles.clear();
  sendNetPartyLeave();
  addChatMessage('* You left the party', 'system');
});

registerCommand('ff1', 'Play FF1 NSF track N (or "stop" to resume map music)', (args) => {
  const a = (args || '').trim().toLowerCase();
  if (a === '' || a === 'stop' || a === 'off') {
    stopFF1Music(); resumeMusic();
    addChatMessage('FF1 NSF stopped, map music resumed', 'console');
    return;
  }
  const n = parseInt(a, 10);
  if (!Number.isFinite(n) || n < 0) { addChatMessage('Usage: /ff1 <track-index> | /ff1 stop', 'console'); return; }
  pauseMusic(); playFF1Track(n);
  addChatMessage('FF1 NSF track ' + n, 'console');
}, { dev: true });

registerCommand('ff2', 'Play FF2 NSF track N (or "stop" to resume map music)', (args) => {
  const a = (args || '').trim().toLowerCase();
  if (a === '' || a === 'stop' || a === 'off') {
    stopFF2Music(); resumeMusic();
    addChatMessage('FF2 NSF stopped, map music resumed', 'console');
    return;
  }
  const n = parseInt(a, 10);
  if (!Number.isFinite(n) || n < 0) { addChatMessage('Usage: /ff2 <track-index> | /ff2 stop', 'console'); return; }
  pauseMusic(); playFF2Track(n);
  addChatMessage('FF2 NSF track ' + n, 'console');
}, { dev: true });

registerCommand('sfx', 'Audition FF3 SFX by NSF track number (e.g. /sfx 127). Accepts decimal or 0x-hex.', (args) => {
  const a = (args || '').trim();
  if (!a) { addChatMessage('Usage: /sfx <track>  (decimal or 0x-hex; SFX live ~0x41-0xC0)', 'console'); return; }
  const n = a.startsWith('0x') ? parseInt(a, 16) : parseInt(a, 10);
  if (!Number.isFinite(n) || n < 0 || n > 255) { addChatMessage('Track must be 0-255', 'console'); return; }
  playSFX(n);
  addChatMessage('SFX track ' + n + ' (0x' + n.toString(16).toUpperCase() + ')', 'console');
});

registerCommand('pos', 'Show player tile + faced tile', () => {
  if (mapSt.onWorldMap) {
    const tx = (mapSt.worldX / 16) | 0, ty = (mapSt.worldY / 16) | 0;
    addChatMessage('world ' + tx + ',' + ty, 'console');
    return;
  }
  if (!mapSt.mapData || !sprite) { addChatMessage('No map loaded', 'console'); return; }
  const tx = (mapSt.worldX / 16) | 0, ty = (mapSt.worldY / 16) | 0;
  const dir = sprite.getDirection();
  const dx = dir === DIR_RIGHT ? 1 : dir === DIR_LEFT ? -1 : 0;
  const dy = dir === DIR_DOWN ? 1 : dir === DIR_UP ? -1 : 0;
  const dirName = dir === DIR_DOWN ? 'down' : dir === DIR_UP ? 'up' : dir === DIR_LEFT ? 'left' : 'right';
  const fx = tx + dx, fy = ty + dy;
  const inB = fx >= 0 && fx < 32 && fy >= 0 && fy < 32;
  const tile = inB ? mapSt.mapData.tilemap[fy * 32 + fx] : -1;
  const tileHex = inB ? '0x' + tile.toString(16).padStart(2, '0') : 'oob';
  addChatMessage('map ' + mapSt.currentMapId + ' @ ' + tx + ',' + ty + ' face ' + dirName, 'console');
  addChatMessage('faced ' + fx + ',' + fy + ' tile ' + tileHex, 'console');
});

registerCommand('job', 'Switch to job N (0-21). Bypasses CP cost. /job lists all.', (args) => {
  if (!args) {
    addChatMessage('Current: ' + ps.jobIdx + ' (' + (JOBS[ps.jobIdx]?.name || '?') + ')', 'console');
    JOBS.forEach((j, i) => addChatMessage(i + ': ' + j.name, 'console'));
    return;
  }
  const n = parseInt(args, 10);
  if (isNaN(n) || n < 0 || n >= JOBS.length) { addChatMessage('Bad job idx', 'console'); return; }
  ps.unlockedJobs |= (1 << n);
  changeJob(n);
  fullHeal();
  swapBattleSprites(n);
  saveSlotsToDB();
  addChatMessage('Job: ' + n + ' (' + JOBS[n].name + ') HP/MP refilled', 'console');
  if (ps.knownSpells && ps.knownSpells.length > 0) {
    const list = ps.knownSpells.map(s => '$' + s.toString(16).padStart(2, '0')).join(',');
    addChatMessage('Known spells: ' + list, 'console');
  }
}, { dev: true });

registerCommand('heal', 'Restore HP and MP to max', () => {
  fullHeal();
  saveSlotsToDB();
  addChatMessage('HP ' + ps.hp + '/' + ps.stats.maxHP + '  MP ' + ps.mp + '/' + ps.stats.maxMP, 'console');
}, { dev: true });

registerCommand('hp', 'Set current HP to N (or show current). N=0 = KO test.', (args) => {
  if (!args || !ps.stats) { addChatMessage('HP ' + ps.hp + '/' + (ps.stats?.maxHP || '?'), 'console'); return; }
  const n = parseInt(args, 10);
  if (!Number.isFinite(n)) { addChatMessage('Bad HP', 'console'); return; }
  ps.hp = Math.max(0, Math.min(n, ps.stats.maxHP));
  saveSlotsToDB();
  addChatMessage('HP ' + ps.hp + '/' + ps.stats.maxHP, 'console');
}, { dev: true });

registerCommand('mp', 'Set current MP to N (or show current)', (args) => {
  if (!args) { addChatMessage('MP ' + ps.mp + '/' + ps.stats.maxMP, 'console'); return; }
  const n = parseInt(args, 10);
  if (isNaN(n)) { addChatMessage('Bad MP', 'console'); return; }
  ps.mp = Math.max(0, Math.min(n, ps.stats.maxMP));
  saveSlotsToDB();
  addChatMessage('MP ' + ps.mp + '/' + ps.stats.maxMP, 'console');
}, { dev: true });

registerCommand('gil', 'Set gil to N (or show current)', (args) => {
  if (!args) { addChatMessage('Gil: ' + ps.gil, 'console'); return; }
  const n = parseInt(args, 10);
  if (!Number.isFinite(n) || n < 0) { addChatMessage('Bad gil', 'console'); return; }
  ps.gil = Math.min(999999, n);
  saveSlotsToDB();
  addChatMessage('Gil: ' + ps.gil, 'console');
}, { dev: true });

registerCommand('cp', 'Set capacity points to N (or show current)', (args) => {
  if (!args) { addChatMessage('CP: ' + (ps.cp || 0), 'console'); return; }
  const n = parseInt(args, 10);
  if (!Number.isFinite(n) || n < 0) { addChatMessage('Bad CP', 'console'); return; }
  ps.cp = Math.min(99999, n);
  saveSlotsToDB();
  addChatMessage('CP: ' + ps.cp, 'console');
}, { dev: true });

registerCommand('level', `Force player level to N via grantExp loop (1-${MAX_LEVEL})`, (args) => {
  if (!args) { addChatMessage('Level: ' + ps.stats.level, 'console'); return; }
  const target = parseInt(args, 10);
  if (!Number.isFinite(target) || target < 1 || target > MAX_LEVEL) { addChatMessage(`Bad level (1-${MAX_LEVEL})`, 'console'); return; }
  let safety = 200;  // cap loops in case grantExp can't push level (edge case)
  while (ps.stats.level < target && safety-- > 0) grantExp(ps.stats.expToNext || 1);
  saveSlotsToDB();
  addChatMessage('Level: ' + ps.stats.level + '  HP=' + ps.hp + '/' + ps.stats.maxHP + '  MP=' + ps.mp + '/' + ps.stats.maxMP, 'console');
}, { dev: true });

registerCommand('give', 'Give item: /give <hexId> [qty]. e.g. /give b1 3', (args) => {
  const parts = (args || '').trim().split(/\s+/);
  if (!parts[0]) { addChatMessage('Usage: /give <hexId> [qty]', 'console'); return; }
  const id = parseInt(parts[0], 16);
  const qty = parts[1] ? parseInt(parts[1], 10) : 1;
  if (!Number.isFinite(id) || id < 0 || id > 0xFF) { addChatMessage('Bad item id', 'console'); return; }
  if (!Number.isFinite(qty) || qty < 1) { addChatMessage('Bad qty', 'console'); return; }
  if (!ITEMS.get(id)) { addChatMessage('Unknown item $' + id.toString(16).padStart(2, '0'), 'console'); return; }
  addItem(id, qty);
  saveSlotsToDB();
  const name = bytesToAscii(getItemNameClean(id) || []);
  addChatMessage('+' + qty + 'x $' + id.toString(16).padStart(2, '0') + ' ' + name, 'console');
}, { dev: true });

registerCommand('spell', 'Grant spell: /spell <hexId>. e.g. /spell 33', (args) => {
  if (!args) { addChatMessage('Usage: /spell <hexId>', 'console'); return; }
  const id = parseInt(args.trim(), 16);
  if (!Number.isFinite(id) || id < 0 || id > 0xFF) { addChatMessage('Bad spell id', 'console'); return; }
  if (!ps.knownSpells) ps.knownSpells = [];
  if (ps.knownSpells.includes(id)) {
    addChatMessage('Already known: $' + id.toString(16).padStart(2, '0'), 'console');
    return;
  }
  ps.knownSpells.push(id);
  saveSlotsToDB();
  const name = bytesToAscii(getSpellNameClean(id) || []);
  addChatMessage('Learned $' + id.toString(16).padStart(2, '0') + ' ' + name, 'console');
}, { dev: true });

registerCommand('buff', 'Set buff: /buff haste|protect|reflect, /buff clear, or /buff (show)', (args) => {
  const a = (args || '').trim().toLowerCase();
  if (!a) {
    const active = ALL_BUFFS.filter(k => hasBuff(ps, k));
    addChatMessage('Buffs: ' + (active.length ? active.join(',') : '(none)'), 'console');
    return;
  }
  if (a === 'clear' || a === 'off' || a === 'none') {
    clearAllBuffs(ps);
    addChatMessage('Buffs cleared', 'console');
    return;
  }
  if (!ALL_BUFFS.includes(a)) { addChatMessage('Unknown buff: ' + a + '. Try haste|protect|reflect', 'console'); return; }
  applyBuff(ps, a);
  addChatMessage('Applied: ' + a + '  (clears at next battle start)', 'console');
}, { dev: true });

registerCommand('warp', 'Teleport to map id N (decimal)', (args, ctx) => {
  if (!args) { addChatMessage('Current map: ' + mapSt.currentMapId, 'console'); return; }
  if (!ctx.loadMapById) { addChatMessage('Warp not available', 'console'); return; }
  const id = parseInt(args, 10);
  if (!Number.isFinite(id) || id < 0) { addChatMessage('Bad map id', 'console'); return; }
  ctx.loadMapById(id);
  addChatMessage('Warped to map ' + id, 'console');
}, { dev: true });

// /devhelp — categorized listing of dev-only commands. Hidden for non-devs.
// Public /help already filters out dev commands; /devhelp gives a tighter,
// grouped view for fast lookup during testing.
registerCommand('devhelp', 'Dev commands grouped by category', () => {
  const groups = [
    ['Player state',  ['hp', 'mp', 'heal', 'level', 'gil', 'cp']],
    ['Buffs',         ['buff']],
    ['Job & spells',  ['job', 'spell']],
    ['Items',         ['give']],
    ['Navigation',    ['warp']],
    ['Audio',         ['ff1', 'ff2']],
  ];
  addChatMessage('Dev commands:', 'console');
  for (const [label, names] of groups) {
    addChatMessage('  -- ' + label + ' --', 'console');
    for (const n of names) {
      const cmd = COMMANDS.get(n);
      if (cmd) addChatMessage('  /' + n + ' — ' + cmd.desc, 'console');
    }
  }
}, { dev: true });

let _commandCtx = {};
export function setCommandContext(ctx) { _commandCtx = ctx; }

function _execCommand(input) {
  const trimmed = input.slice(1).trim();
  const spaceIdx = trimmed.indexOf(' ');
  const name = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
  const cmd = COMMANDS.get(name);
  // Non-devs see "Unknown command" for dev commands too — no leak that they
  // exist. /help filters them out so a real player has no surface area.
  if (!cmd || (cmd.dev && !isDev())) {
    addChatMessage('Unknown command: /' + name + '. Type /help', 'console');
    return;
  }
  cmd.handler(args, _commandCtx);
}

// ── Console messages ──────────────────────────────────────────────────────

export function consoleLog(text) { addChatMessage(text, 'console'); }

// ── Chat input handler (moved from game.js) ──────────────────────────────

// Tab-complete a trailing "@partial" against the online roster. Names are
// compacted (spaces removed) so the inserted mention is a single @-token that
// _mentions() can match exactly. No-op when the input doesn't end in a partial
// @-token or nothing matches.
function _autocompleteMention() {
  const m = chatState.inputText.match(/@([A-Za-z0-9]*)$/);
  if (!m) return;
  const partial = m[1].toLowerCase();
  const names = getOnlinePlayers().map(p => p.name).filter(Boolean);
  const hit = names.find(n => n.replace(/\s+/g, '').toLowerCase().startsWith(partial));
  if (!hit) return;
  const completed = chatState.inputText.slice(0, m.index) + '@' + hit.replace(/\s+/g, '') + ' ';
  if (completed.length <= 60) chatState.inputText = completed;
}

// Stamp set when chat closes via Enter/Escape so the pause-menu Enter-toggle
// can suppress itself for a few hundred ms — without this, holding Enter to
// send a chat message bled the auto-repeat keydown through to the pause
// open trigger (player bug 2026-05-23). Read by `chatJustClosedRecently`.
let _chatClosedAt = 0;
export function chatJustClosedRecently() {
  return performance.now() - _chatClosedAt < 250;
}

export function onChatKeyDown(e) {
  e.preventDefault();
  if (e.key === 'Enter') {
    if (chatState.inputText.length > 0) {
      if (chatState.inputText[0] === '/') {
        _execCommand(chatState.inputText);
      } else {
        // Route to the channel of the active tab so the user's own message
        // renders wherever they're typing. CHAT_TABS = [World, Party, Private,
        // System]; System falls back to 'party' since users can't post there.
        const TAB_TO_CHANNEL = ['world', 'party', 'pm', 'party'];
        const channel = TAB_TO_CHANNEL[activeTab];
        if (channel === 'pm') {
          // PM goes to the explicit pick or the last conversation partner.
          _sendPm(_pmTarget(), chatState.inputText);
        } else {
          addChatMessage(localPlayerName() + ': ' + chatState.inputText, 'chat', channel);
          sendNetChat(channel, chatState.inputText);
        }
      }
    }
    // Keep pendingRecipient so a follow-up reply on the Private tab still has a
    // target; it's only dropped on Escape or a fresh 't' open (input-handler).
    chatState.inputActive = false; chatState.inputText = '';
    _chatClosedAt = performance.now();
  } else if (e.key === 'Escape') {
    chatState.inputActive = false; chatState.inputText = '';
    chatState.pendingRecipient = null;
    _chatClosedAt = performance.now();
  } else if (e.key === 'Tab') {
    _autocompleteMention();
  } else if (e.key === 'Backspace') {
    chatState.inputText = chatState.inputText.slice(0, -1);
  } else if (e.key.length === 1 && chatState.inputText.length < CHAT_INPUT_CAP) {
    chatState.inputText += e.key;
  }
}

// ── Update / Draw ─────────────────────────────────────────────────────────

export function updateChat(dt, battleState, titleActive) {
  const expandTarget = chatState.expanded ? 1 : 0;
  if (chatState.expandAnim < expandTarget)
    chatState.expandAnim = Math.min(1, chatState.expandAnim + dt / CHAT_EXPAND_MS);
  else if (chatState.expandAnim > expandTarget)
    chatState.expandAnim = Math.max(0, chatState.expandAnim - dt / CHAT_EXPAND_MS);

  if (chatState.inputActive) chatState.cursorTimer += dt;

  if (!titleActive && battleState === 'none' && !chatState.inputActive) {
    chatState.autoTimer -= dt;
    if (chatState.autoTimer <= 0) {
      chatState.autoTimer = CHAT_AUTO_MIN_MS + Math.random() * (CHAT_AUTO_MAX_MS - CHAT_AUTO_MIN_MS);
      // v1.7.236: Room → Party. 60% party-member chatter when the user
      // has any party members; 40% world hubbub from non-party. Empty
      // party → 100% world. No location filter — global pool minus party
      // is the world feed.
      const partyMembers = PLAYER_POOL.filter(p => partyInviteSt.partyMembers.includes(p.name));
      const others = PLAYER_POOL.filter(p => !partyInviteSt.partyMembers.includes(p.name));
      const useParty = partyMembers.length > 0 && (others.length === 0 || Math.random() < 0.6);
      const p = useParty
        ? partyMembers[Math.floor(Math.random() * partyMembers.length)]
        : others[Math.floor(Math.random() * others.length)];
      if (!p) return;
      const phrase = CHAT_PHRASES[Math.floor(Math.random() * CHAT_PHRASES.length)];
      addChatMessage(p.name + ': ' + phrase, 'chat', useParty ? 'party' : 'world');
    }
  }
}

export function drawChat(ctx, drawHudBoxFn, rosterBattleFade, titleActive) {
  if (!chatState.fontReady) return;
  const battleFadeAlpha = 1 - rosterBattleFade / ROSTER_FADE_STEPS;
  if (battleFadeAlpha <= 0) return;
  if (chatState.messages.length === 0 && !chatState.inputActive && chatState.expandAnim === 0) return;

  const curBoxH = HUD_BOT_H + Math.round((CANVAS_H - HUD_VIEW_Y - HUD_BOT_H) * chatState.expandAnim / 8) * 8;
  const curBoxY = CANVAS_H - curBoxH;
  ctx.save();
  _drawChatExpandBG(ctx, drawHudBoxFn, curBoxY, curBoxH, battleFadeAlpha, rosterBattleFade);
  _drawChatTextArea(ctx, curBoxY, curBoxH, battleFadeAlpha, titleActive);
  ctx.globalAlpha = 1;
  ctx.restore();
}

// ── Tab bar (16px gap between roster and chat HUD) ───────────────────────

const TAB_BAR_Y = HUD_VIEW_Y + 32 + 3 * 32; // 160 — bottom of roster panel
const TAB_BAR_H = 24;  // 3 tile rows — overlaps chat HUD top border by 8px
const HUD_RIGHT_X = 144;

const TAB_PAD = 8;       // padding inside each tab box (4px each side)
const TAB_GAP = 0;       // gap between tabs
const TAB_SCROLL_SPEED = 0.4; // px per ms

function _getTabWidths() {
  // Each tab: 8px border left + 4px pad + text + 4px pad + 8px border right = text + 24px
  // But with shared borders between tabs, middle borders overlap
  // Width uses the displayed label so the Private tab grows / shrinks with
  // the focused PM partner's name length. v1.7.703.
  return CHAT_TABS.map((_, i) => measureText(_nameToBytes(getTabLabel(i))) + 16);
}

export function updateChatTabs(dt) {
  // Animate scroll toward target
  if (_tabScrollX !== _tabScrollTarget) {
    const diff = _tabScrollTarget - _tabScrollX;
    const move = TAB_SCROLL_SPEED * dt;
    _tabScrollX = Math.abs(diff) <= move ? _tabScrollTarget : _tabScrollX + Math.sign(diff) * move;
  }
}

const TAB_PEEK = 8; // px each collapsed tab peeks out past the one on top

export function drawChatTabs(ctx, fadeStep, drawHudBox) {
  if (!chatState.fontReady) return;
  if (fadeStep >= ROSTER_FADE_STEPS) return;

  const widths = _getTabWidths();
  const panelW = CANVAS_W - HUD_RIGHT_X;
  const selectedW = widths[activeTab];
  const selectedRight = HUD_RIGHT_X + selectedW;

  // Order: selected first (leftmost, drawn last on top), rest after
  const order = [activeTab];
  for (let i = 0; i < CHAT_TABS.length; i++) {
    if (i !== activeTab) order.push(i);
  }

  // Distribute unselected tabs evenly across remaining space
  const remaining = panelW - selectedW;
  const numUnselected = order.length - 1;
  const peek = numUnselected > 0 ? Math.floor(remaining / numUnselected) : 0;
  const positions = [HUD_RIGHT_X];
  for (let oi = 1; oi < order.length; oi++) {
    positions.push(selectedRight + oi * peek - widths[order[oi]]);
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(HUD_RIGHT_X, TAB_BAR_Y, panelW, TAB_BAR_H);
  ctx.clip();

  // Draw back-to-front: rightmost first, selected last on top
  for (let oi = order.length - 1; oi >= 0; oi--) {
    const tabIdx = order[oi];
    const isActive = tabIdx === activeTab;
    const tabFade = isActive ? fadeStep : Math.min(fadeStep + 2, ROSTER_FADE_STEPS);
    const tx = positions[oi];
    const w = widths[tabIdx];

    drawHudBox(tx, TAB_BAR_Y, w, TAB_BAR_H, tabFade);

    // Selected tab: erase bottom border to connect interior with chat HUD below
    if (isActive) {
      ctx.fillStyle = '#000';
      ctx.fillRect(tx + 8, TAB_BAR_Y + TAB_BAR_H - 8, w - 16, 8);
    }

    // Blink text: active tab in select mode, or background tab with unread
    const selectBlink = isActive && tabSelectMode && (Math.floor((Date.now() - _tabBlinkStart) / 400) & 1);
    const unreadBlink = !isActive && _tabUnread[tabIdx] && (Math.floor(Date.now() / 500) & 1);
    if (!selectBlink && !unreadBlink) {
      let pal = [...TEXT_WHITE];
      for (let s = 0; s < tabFade; s++) pal = pal.map(c => nesColorFade(c));
      const label = _nameToBytes(getTabLabel(tabIdx));
      const lw = measureText(label);
      drawText(ctx, tx + Math.floor((w - lw) / 2), TAB_BAR_Y + 8, label, pal);
    }

  }

  ctx.restore();
}

// v1.7.453 — cursor must render AFTER the roster + chat panels so it doesn't
// get hidden behind their borders, and OUTSIDE the tab's left border tile
// (the v1.7.448 inside-the-tab placement landed under the border decoration
// and looked broken). Sits just left of the active tab's left edge; the
// chat tabs clip rectangle in drawChatTabs would have cut this off so we
// draw it on its own pass.
export function drawChatTabCursor(_ctx) {
  if (!tabSelectMode) return;
  // Recompute the active tab's left edge — same math as drawChatTabs.
  // The active tab is always order[0] = HUD_RIGHT_X (positions[0]).
  // Fade matches what drawChatTabs used (rosterBattleFade-driven), but we
  // don't need exact parity here — full cursor is fine while select mode
  // is on (user is actively interacting with the tab bar).
  drawCursorFaded(HUD_RIGHT_X - 8, TAB_BAR_Y + 8, 0);
}

// ── Private helpers ────────────────────────────────────────────────────────

function _chatWrap(ctx, text, maxWidth) {
  const lines = [];
  let start = 0;
  while (start < text.length) {
    let end = start;
    let lastSpace = -1;
    while (end < text.length && ctx.measureText(text.slice(start, end + 1)).width <= maxWidth) {
      if (text[end] === ' ') lastSpace = end;
      end++;
    }
    if (end >= text.length) { lines.push(text.slice(start)); break; }
    const cut = lastSpace > start ? lastSpace : end;
    lines.push(text.slice(start, cut));
    start = cut + (text[cut] === ' ' ? 1 : 0);
  }
  return lines.length ? lines : [text];
}

function _buildChatRows(ctx, lineW, startX, titleActive) {
  const rows = [];
  for (const m of chatState.messages) {
    if (titleActive && m.type !== 'console') continue;
    if (!titleActive && !_passesTabFilter(m)) continue;
    if (m.type === 'console') {
      for (const line of _chatWrap(ctx, m.text, lineW))
        rows.push({ color: '#58c858', text: line, x: startX });
    } else if (m.type === 'system') {
      for (const line of _chatWrap(ctx, m.text, lineW))
        rows.push({ color: '#7898c8', text: line, x: startX });
    } else {
      const mention = m.mention || false;  // highlight messages that @ you
      const colon = m.text.indexOf(':');
      if (colon > -1) {
        const namePart  = m.text.slice(0, colon + 1);
        const msgPart   = m.text.slice(colon + 2);
        const nameW     = ctx.measureText(namePart).width;
        const firstLine = _chatWrap(ctx, msgPart, lineW - nameW)[0];
        rows.push({ namePart, nameW, msgPart: firstLine, x: startX, mention });
        // Loop ALL remaining wrap lines — pre-v1.7.638 took only [0] and
        // silently dropped the tail. Hidden by the 42-char cap (messages
        // rarely wrapped past 2 visual rows); the 80-char cap exposed it
        // as "half the message cut off after sending".
        const remainder = msgPart.slice(firstLine.length).replace(/^ /, '');
        if (remainder.length > 0) {
          for (const line of _chatWrap(ctx, remainder, lineW))
            rows.push({ color: '#e0e0e0', text: line, x: startX, mention });
        }
      } else {
        for (const line of _chatWrap(ctx, m.text, lineW))
          rows.push({ color: '#e0e0e0', text: line, x: startX, mention });
      }
    }
  }
  return rows;
}

// Word-aware wrap for the input text — breaks at the last space inside the
// row when one exists, falls back to a hard char-break for super-long words.
// Mirrors `_chatWrap`'s algorithm (used for the chat history) but row 0
// reserves promptW and rows 1+ get the full lineW. Always returns at least
// [''] so a fresh-open empty input still renders the prompt + cursor row.
// v1.7.639 (word wrap; v1.7.637-638 cut mid-word).
function _wrapInputText(ctx, text, lineW, promptW) {
  const lines = [];
  let start = 0;
  let avail = lineW - promptW;  // row 0 budget
  while (start < text.length) {
    let end = start;
    let lastSpace = -1;
    while (end < text.length && ctx.measureText(text.slice(start, end + 1)).width <= avail) {
      if (text[end] === ' ') lastSpace = end;
      end++;
    }
    if (end >= text.length) { lines.push(text.slice(start)); break; }
    const cut = lastSpace > start ? lastSpace : end;  // word break, else hard
    lines.push(text.slice(start, cut));
    start = cut + (text[cut] === ' ' ? 1 : 0);
    avail = lineW;  // rows 1+ are full-width
  }
  return lines.length ? lines : [''];
}

function _inputPromptStr() {
  // Universal "> " — the Private tab used to show "→Name " to identify the PM
  // recipient, but as of v1.7.703 the recipient name IS the tab label
  // (`getTabLabel('Private') → partner name`), so the prompt no longer needs
  // to repeat it. Cleaner and matches every other tab.
  return '> ';
}

function _drawChatInput(ctx, lineW, startX, inputBottomY, lines) {
  const promptStr = _inputPromptStr();
  const promptW    = ctx.measureText(promptStr).width;
  // Render top→bottom so visual row 0 (with prompt) stays at the top of the
  // input block and the cursor sits on the last (bottom) row.
  for (let i = 0; i < lines.length; i++) {
    const y = inputBottomY - (lines.length - 1 - i) * CHAT_LINE_H;
    if (i === 0) {
      ctx.fillStyle = '#d8b858'; ctx.fillText(promptStr, startX, y);
      ctx.fillStyle = '#ffffff'; ctx.fillText(lines[i], startX + promptW, y);
    } else {
      ctx.fillStyle = '#ffffff'; ctx.fillText(lines[i], startX, y);
    }
  }
  if (Math.floor(chatState.cursorTimer / 500) % 2 === 0) {
    const lastIdx = lines.length - 1;
    const last    = lines[lastIdx];
    const lastX   = lastIdx === 0
      ? startX + promptW + ctx.measureText(last).width
      : startX + ctx.measureText(last).width;
    ctx.fillRect(lastX, inputBottomY - 7, 6, 8);
  }
}

function _drawChatExpandBG(ctx, drawHudBoxFn, curBoxY, curBoxH, battleFadeAlpha, battleFadeStep) {
  if (chatState.expandAnim <= 0) return;
  const NES_STEP_ALPHAS = [0, 0.28, 0.52, 0.76, 1.0];
  ctx.globalAlpha = NES_STEP_ALPHAS[Math.min(4, Math.round(chatState.expandAnim * 4))] * battleFadeAlpha;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, HUD_VIEW_Y, CANVAS_W, CANVAS_H - HUD_VIEW_Y - HUD_BOT_H);
  ctx.globalAlpha = 1;
  drawHudBoxFn(0, curBoxY, CANVAS_W, curBoxH, battleFadeStep);
}

function _drawChatTextArea(ctx, curBoxY, curBoxH, battleFadeAlpha, titleActive) {
  const innerTop    = curBoxY + 8;
  const innerBottom = curBoxY + curBoxH - 10;
  const innerH      = innerBottom - innerTop;
  ctx.globalAlpha = battleFadeAlpha;
  ctx.beginPath(); ctx.rect(8, innerTop, CANVAS_W - 16, curBoxH - 16); ctx.clip();
  ctx.font = '8px "Press Start 2P"'; ctx.textBaseline = 'bottom';
  const startX = 12;
  const lineW  = CANVAS_W - 8 - startX;
  const rows = _buildChatRows(ctx, lineW, startX, titleActive);
  // Wrap the input once so the row-budget calc and the renderer agree.
  let inputLines = null;
  let inputRows  = 0;
  if (chatState.inputActive) {
    const promptW = ctx.measureText(_inputPromptStr()).width;
    inputLines = _wrapInputText(ctx, chatState.inputText, lineW, promptW);
    inputRows  = inputLines.length;
  }
  const availRows = Math.max(1, Math.floor(innerH / CHAT_LINE_H) - inputRows);
  const bottomY = chatState.inputActive
    ? innerBottom - inputRows * CHAT_LINE_H
    : innerBottom;
  // Cache for input handler + arrow renderer. Re-clamp scroll if the buffer
  // shrank since the last frame (e.g., tab switch dropped the visible row count).
  _chatTotalRows = rows.length;
  _chatAvailRows = availRows;
  _chatMaxScroll = Math.max(0, rows.length - availRows);
  if (chatScrollOffset > _chatMaxScroll) chatScrollOffset = _chatMaxScroll;
  // Apply the offset whenever the chat is expanded (open log) OR in the
  // legacy Private-tab tab-select mode.
  const scrollActive = chatState.expanded || (CHAT_TABS[activeTab] === 'Private' && tabSelectMode);
  const scroll = scrollActive ? chatScrollOffset : 0;
  const endIdx = rows.length - scroll;
  const visible = rows.slice(Math.max(0, endIdx - availRows), endIdx);
  for (let i = 0; i < visible.length; i++) {
    const r = visible[i];
    const lineY = bottomY - (visible.length - 1 - i) * CHAT_LINE_H;
    if (r.namePart !== undefined) {
      ctx.fillStyle = '#d8b858'; ctx.fillText(r.namePart, r.x, lineY);
      ctx.fillStyle = r.mention ? '#ffd84a' : '#e0e0e0'; ctx.fillText(r.msgPart, r.x + r.nameW, lineY);
    } else {
      ctx.fillStyle = r.mention ? '#ffd84a' : r.color; ctx.fillText(r.text, r.x, lineY);
    }
  }
  if (chatState.inputActive) {
    _drawChatInput(ctx, lineW, startX, innerBottom, inputLines);
  }
  if (scrollActive) _drawChatScrollArrows(ctx, innerTop, innerBottom);
}

// Up/down scroll-arrow indicators — same blink rhythm + ui sprites as
// roster.js:_drawScrollArrows. Renders in the right margin of the chat
// box so it doesn't overlap text. Only fires when scrolling is "active"
// (chat expanded or Private-tab select mode).
function _drawChatScrollArrows(ctx, innerTop, innerBottom) {
  const blink = Math.floor(Date.now() / 500) & 1;
  if (!blink) return;
  const ax = CANVAS_W - 8 - 8; // 8px arrow tile inset from the chat box edge
  // In Private select mode up/down pages conversations (a cycle), so show both
  // arrows whenever there's more than one to page through. Elsewhere the
  // arrows reflect row scrolling in the expanded log.
  const pmMode = CHAT_TABS[activeTab] === 'Private' && tabSelectMode;
  const showUp   = pmMode ? pmSessionCount() > 1 : canChatScrollUp();
  const showDown = pmMode ? pmSessionCount() > 1 : canChatScrollDown();
  if (showUp && ui.scrollArrowUp) {
    ctx.drawImage(ui.scrollArrowUp, ax, innerTop + 2);
  }
  if (showDown && ui.scrollArrowDown) {
    ctx.drawImage(ui.scrollArrowDown, ax, innerBottom - 8 - 2);
  }
}
