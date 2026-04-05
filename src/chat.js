// chat.js — console + chat: message buffer, commands, auto-chat, expand/collapse, HUD rendering

import { PLAYER_POOL, CHAT_PHRASES, ROSTER_FADE_STEPS } from './data/players.js';
import { selectCursor, saveSlots } from './save-state.js';
import { _nesNameToString, _nameToBytes } from './text-utils.js';
import { drawText, measureText, TEXT_YELLOW, TEXT_GREY } from './font-renderer.js';

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
export const CHAT_TABS = ['ALL', 'ROOM', 'PM', 'SYS'];
export let activeTab = 0;  // index into CHAT_TABS
export let tabSelectMode = false;
export function setActiveTab(i) { activeTab = i; }
export function setTabSelectMode(v) { tabSelectMode = v; }

// ── Mutable state (exported so game.js can read/write directly) ────────────
export const chatState = {
  messages:    [],     // [{ text, type, channel }] type: 'chat'|'system'|'console', channel: 'all'|'room'|'pm'|'sys'
  autoTimer:   8000,   // ms until next auto message
  fontReady:   false,
  inputActive: false,  // t key opens input
  inputText:   '',
  cursorTimer: 0,      // blinks every 500 ms
  expanded:    false,  // T (shift) toggles expanded view
  expandAnim:  0,      // 0=collapsed, 1=expanded (animated)
};

// ── Public API ─────────────────────────────────────────────────────────────

export function addChatMessage(text, type, channel) {
  // Default channel based on type
  if (!channel) {
    if (type === 'console' || type === 'system') channel = 'sys';
    else channel = 'room';
  }
  chatState.messages.push({ text, type: type || 'chat', channel });
  while (chatState.messages.length > CHAT_HISTORY) chatState.messages.shift();
}

function _passesTabFilter(msg) {
  const tab = CHAT_TABS[activeTab];
  if (tab === 'ALL') return true;
  if (tab === 'ROOM') return msg.channel === 'room';
  if (tab === 'PM') return msg.channel === 'pm';
  if (tab === 'SYS') return msg.channel === 'sys';
  return true;
}

// ── Commands ──────────────────────────────────────────────────────────────

const COMMANDS = new Map();

function registerCommand(name, desc, handler) {
  COMMANDS.set(name, { desc, handler });
}

registerCommand('help', 'List available commands', () => {
  addChatMessage('Available commands:', 'console');
  for (const [name, cmd] of COMMANDS)
    addChatMessage('  /' + name + ' — ' + cmd.desc, 'console');
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

let _commandCtx = {};
export function setCommandContext(ctx) { _commandCtx = ctx; }

function _execCommand(input) {
  const trimmed = input.slice(1).trim();
  const spaceIdx = trimmed.indexOf(' ');
  const name = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
  const cmd = COMMANDS.get(name);
  if (!cmd) { addChatMessage('Unknown command: /' + name + '. Type /help', 'console'); return; }
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
        addChatMessage(senderName + ': ' + chatState.inputText, 'chat');
      }
    }
    chatState.inputActive = false; chatState.inputText = '';
  } else if (e.key === 'Escape') {
    chatState.inputActive = false; chatState.inputText = '';
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
      const p      = PLAYER_POOL[Math.floor(Math.random() * PLAYER_POOL.length)];
      const phrase = CHAT_PHRASES[Math.floor(Math.random() * CHAT_PHRASES.length)];
      addChatMessage(p.name + ': ' + phrase, 'chat');
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
const TAB_BAR_H = 16;
const HUD_RIGHT_X = 144;

export function drawChatTabs(ctx, drawHudBoxFn, rosterBattleFade) {
  if (!chatState.fontReady) return;
  const battleFadeAlpha = 1 - rosterBattleFade / ROSTER_FADE_STEPS;
  if (battleFadeAlpha <= 0) return;

  // Draw tab background box
  drawHudBoxFn(HUD_RIGHT_X, TAB_BAR_Y, CANVAS_W - HUD_RIGHT_X, TAB_BAR_H, 0);

  ctx.save();
  ctx.globalAlpha = battleFadeAlpha;

  // Layout tabs evenly across the box
  const innerX = HUD_RIGHT_X + 4;
  const innerW = CANVAS_W - HUD_RIGHT_X - 8;
  const tabW = Math.floor(innerW / CHAT_TABS.length);

  for (let i = 0; i < CHAT_TABS.length; i++) {
    const label = _nameToBytes(CHAT_TABS[i]);
    const lw = measureText(label);
    const tx = innerX + i * tabW + Math.floor((tabW - lw) / 2);
    const ty = TAB_BAR_Y + 4;
    const isActive = i === activeTab;
    const isSelected = tabSelectMode && i === activeTab;

    // Blink cursor on selected tab in tab-select mode
    if (isSelected && (Math.floor(Date.now() / 400) & 1)) {
      drawText(ctx, tx, ty, label, TEXT_GREY);
    } else {
      drawText(ctx, tx, ty, label, isActive ? TEXT_YELLOW : TEXT_GREY);
    }
  }

  ctx.globalAlpha = 1;
  ctx.restore();
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
  const visible = rows.slice(-availRows);
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
}
