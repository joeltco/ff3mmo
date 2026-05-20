// chat.js — console + chat: message buffer, commands, auto-chat, expand/collapse, HUD rendering

import { PLAYER_POOL, CHAT_PHRASES, ROSTER_FADE_STEPS } from './data/players.js';
import { selectCursor, saveSlots } from './save-state.js';
import { _nesNameToString, _nameToBytes } from './text-utils.js';
import { drawText, measureText, TEXT_WHITE } from './font-renderer.js';
import { drawCursorFaded } from './hud-drawing.js';
import { nesColorFade } from './palette.js';
import { partyInviteSt } from './party-invite.js';
import { mapSt } from './map-state.js';
import { sprite } from './player-sprite.js';
import { DIR_DOWN, DIR_UP, DIR_LEFT, DIR_RIGHT } from './sprite.js';
import { playFF1Track, stopFF1Music, pauseMusic, resumeMusic, playSFX, stopSFX } from './music.js';
import { ui } from './ui-state.js';
import { ps, changeJob, fullHeal, grantExp } from './player-stats.js';
import { JOBS } from './data/jobs.js';
import { swapBattleSprites } from './job-sprites.js';
import { saveSlotsToDB } from './save-state.js';
import { sendNetChat, setNetChatHandler, getOnlinePlayerByName } from './net.js';
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

// NES layout — must match game.js
const CANVAS_W   = 256;
const CANVAS_H   = 240;
const HUD_VIEW_Y = 32;
const HUD_BOT_H  = 64;

// ── Chat tabs ─────────────────────────────────────────────────────────────
export const CHAT_TABS = ['World', 'Party', 'Private', 'System'];
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
  const meta = msg.to ? { from: senderName, to: msg.to } : null;
  const displayText = msg.to
    ? senderName + ' → ' + msg.to + ': ' + msg.text
    : senderName + ': ' + msg.text;
  addChatMessage(displayText, 'chat', channel, meta);
});

function _passesTabFilter(msg) {
  const tab = CHAT_TABS[activeTab];
  if (tab === 'World') return msg.channel === 'world' || msg.channel === 'sys';
  if (tab === 'Party') return msg.channel === 'party';
  if (tab === 'Private') return msg.channel === 'pm';
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

// Audition FF3 NSF tracks by ear (one-shot, on the SFX channel) — for finding
// jingles/SFX like the inn rest tune. Accepts decimal or 0xNN hex.
registerCommand('sfx', 'Play FF3 NSF track N once (decimal or 0xNN). /sfx stop to cut.', (args) => {
  const a = (args || '').trim().toLowerCase();
  if (a === 'stop' || a === 'off') { stopSFX(); addChatMessage('SFX cut', 'console'); return; }
  const n = a.startsWith('0x') ? parseInt(a, 16) : parseInt(a, 10);
  if (!Number.isFinite(n) || n < 0) { addChatMessage('Usage: /sfx <track> (e.g. /sfx 0x46) | /sfx stop', 'console'); return; }
  playSFX(n);
  addChatMessage('FF3 NSF track 0x' + n.toString(16) + ' (' + n + ')', 'console');
}, { dev: true });

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

registerCommand('level', 'Force player level to N via grantExp loop (1-99)', (args) => {
  if (!args) { addChatMessage('Level: ' + ps.stats.level, 'console'); return; }
  const target = parseInt(args, 10);
  if (!Number.isFinite(target) || target < 1 || target > 99) { addChatMessage('Bad level (1-99)', 'console'); return; }
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
    ['Audio',         ['ff1']],
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

export function onChatKeyDown(e) {
  e.preventDefault();
  if (e.key === 'Enter') {
    if (chatState.inputText.length > 0) {
      if (chatState.inputText[0] === '/') {
        _execCommand(chatState.inputText);
      } else {
        const slot = saveSlots[selectCursor];
        const senderName = (slot && slot.name) ? _nesNameToString(slot.name) : 'You';
        // Route to the channel of the active tab so the user's own message renders
        // wherever they're typing. CHAT_TABS = [World, Party, Private, System];
        // System tab falls back to 'party' since users can't post to system.
        const TAB_TO_CHANNEL = ['world', 'party', 'pm', 'party'];
        const channel = TAB_TO_CHANNEL[activeTab];
        // PM: prepend `→ <recipient>` to the display text and tag the
        // message with from/to so the websocket relay knows who to
        // deliver to. v1.7.238.
        const recipient = (channel === 'pm') ? chatState.pendingRecipient : null;
        const text = recipient
          ? senderName + ' → ' + recipient + ': ' + chatState.inputText
          : senderName + ': ' + chatState.inputText;
        const meta = recipient ? { from: senderName, to: recipient } : null;
        addChatMessage(text, 'chat', channel, meta);
        // Multiplayer Step 2 — relay over the wire. The server broadcasts to
        // other clients (location-scoped for world/party, recipient-targeted
        // for pm). `chatState.inputText` is the raw message; receivers format
        // their own "Name: text" display. Returns false if not connected — no
        // harm, the message still shows locally.
        const rawText = chatState.inputText;
        if (channel === 'pm' && recipient) sendNetChat('pm', rawText, recipient);
        else if (channel === 'world' || channel === 'party') sendNetChat(channel, rawText);
      }
    }
    chatState.inputActive = false; chatState.inputText = '';
    chatState.pendingRecipient = null;
  } else if (e.key === 'Escape') {
    chatState.inputActive = false; chatState.inputText = '';
    chatState.pendingRecipient = null;
  } else if (e.key === 'Backspace') {
    chatState.inputText = chatState.inputText.slice(0, -1);
  } else if (e.key.length === 1 && chatState.inputText.length < 42) {
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
  return CHAT_TABS.map(name => measureText(_nameToBytes(name)) + 16);
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
      const label = _nameToBytes(CHAT_TABS[tabIdx]);
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
      const colon = m.text.indexOf(':');
      if (colon > -1) {
        const namePart  = m.text.slice(0, colon + 1);
        const msgPart   = m.text.slice(colon + 2);
        const nameW     = ctx.measureText(namePart).width;
        const firstLine = _chatWrap(ctx, msgPart, lineW - nameW)[0];
        rows.push({ namePart, nameW, msgPart: firstLine, x: startX });
        const remainder = msgPart.slice(firstLine.length).replace(/^ /, '');
        if (remainder.length > 0)
          rows.push({ color: '#e0e0e0', text: _chatWrap(ctx, remainder, lineW)[0], x: startX });
      } else {
        for (const line of _chatWrap(ctx, m.text, lineW))
          rows.push({ color: '#e0e0e0', text: line, x: startX });
      }
    }
  }
  return rows;
}

function _drawChatInput(ctx, lineW, startX, inputLine1Y, inputLine2Y) {
  const promptW    = ctx.measureText('> ').width;
  const inputAvail = lineW - promptW;
  let splitIdx = chatState.inputText.length;
  for (let i = 1; i <= chatState.inputText.length; i++) {
    if (ctx.measureText(chatState.inputText.slice(0, i)).width > inputAvail) { splitIdx = i - 1; break; }
  }
  const line1Text = chatState.inputText.slice(0, splitIdx);
  const line2Text = chatState.inputText.slice(splitIdx);
  ctx.fillStyle = '#d8b858';
  ctx.fillText('>', startX, inputLine1Y);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(line1Text, startX + promptW, inputLine1Y);
  ctx.fillText(line2Text, startX, inputLine2Y);
  if (Math.floor(chatState.cursorTimer / 500) % 2 === 0) {
    if (line2Text.length > 0)
      ctx.fillRect(startX + ctx.measureText(line2Text).width, inputLine2Y - 7, 6, 8);
    else
      ctx.fillRect(startX + promptW + ctx.measureText(line1Text).width, inputLine1Y - 7, 6, 8);
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
  let inputRows = 0;
  if (chatState.inputActive) {
    const promptW = ctx.measureText('> ').width;
    const inputFits = chatState.inputText.length === 0 ||
      ctx.measureText(chatState.inputText).width <= lineW - promptW;
    inputRows = inputFits ? 1 : 2;
  }
  const availRows = Math.max(1, Math.floor(innerH / CHAT_LINE_H) - inputRows);
  const inputLineY = innerBottom - (inputRows - 1) * CHAT_LINE_H;
  const bottomY = chatState.inputActive ? inputLineY - CHAT_LINE_H : innerBottom;
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
      ctx.fillStyle = '#e0e0e0'; ctx.fillText(r.msgPart, r.x + r.nameW, lineY);
    } else {
      ctx.fillStyle = r.color; ctx.fillText(r.text, r.x, lineY);
    }
  }
  if (chatState.inputActive) {
    const line1Y = inputRows === 2 ? innerBottom - CHAT_LINE_H : innerBottom;
    const line2Y = innerBottom;
    _drawChatInput(ctx, lineW, startX, line1Y, line2Y);
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
  if (canChatScrollUp() && ui.scrollArrowUp) {
    ctx.drawImage(ui.scrollArrowUp, ax, innerTop + 2);
  }
  if (canChatScrollDown() && ui.scrollArrowDown) {
    ctx.drawImage(ui.scrollArrowDown, ax, innerBottom - 8 - 2);
  }
}
