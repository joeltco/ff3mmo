// chat.js — chat message buffer, auto-chat, expand/collapse animation, and HUD rendering

import { PLAYER_POOL, CHAT_PHRASES, ROSTER_FADE_STEPS } from './data/players.js';

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

// ── Mutable state (exported so game.js can read/write directly) ────────────
export const chatState = {
  messages:    [],     // [{ text, type }] type: 'chat'|'system'
  autoTimer:   8000,   // ms until next auto message
  fontReady:   false,
  inputActive: false,  // t key opens input
  inputText:   '',
  cursorTimer: 0,      // blinks every 500 ms
  expanded:    false,  // T (shift) toggles expanded view
  expandAnim:  0,      // 0=collapsed, 1=expanded (animated)
};

// ── Public API ─────────────────────────────────────────────────────────────

export function addChatMessage(text, type) {
  chatState.messages.push({ text, type: type || 'chat' });
  while (chatState.messages.length > CHAT_HISTORY) chatState.messages.shift();
}

export function updateChat(dt, battleState) {
  const expandTarget = chatState.expanded ? 1 : 0;
  if (chatState.expandAnim < expandTarget)
    chatState.expandAnim = Math.min(1, chatState.expandAnim + dt / CHAT_EXPAND_MS);
  else if (chatState.expandAnim > expandTarget)
    chatState.expandAnim = Math.max(0, chatState.expandAnim - dt / CHAT_EXPAND_MS);

  if (chatState.inputActive) chatState.cursorTimer += dt;

  if (battleState === 'none' && !chatState.inputActive) {
    chatState.autoTimer -= dt;
    if (chatState.autoTimer <= 0) {
      chatState.autoTimer = CHAT_AUTO_MIN_MS + Math.random() * (CHAT_AUTO_MAX_MS - CHAT_AUTO_MIN_MS);
      const p      = PLAYER_POOL[Math.floor(Math.random() * PLAYER_POOL.length)];
      const phrase = CHAT_PHRASES[Math.floor(Math.random() * CHAT_PHRASES.length)];
      addChatMessage(p.name + ': ' + phrase, 'chat');
    }
  }
}

export function drawChat(ctx, drawHudBoxFn, rosterBattleFade) {
  if (!chatState.fontReady) return;
  const battleFadeAlpha = 1 - rosterBattleFade / ROSTER_FADE_STEPS;
  if (battleFadeAlpha <= 0) return;
  if (chatState.messages.length === 0 && !chatState.inputActive && chatState.expandAnim === 0) return;

  const curBoxH = HUD_BOT_H + Math.round((CANVAS_H - HUD_VIEW_Y - HUD_BOT_H) * chatState.expandAnim / 8) * 8;
  const curBoxY = CANVAS_H - curBoxH;
  ctx.save();
  _drawChatExpandBG(ctx, drawHudBoxFn, curBoxY, curBoxH, battleFadeAlpha, rosterBattleFade);
  _drawChatTextArea(ctx, curBoxY, curBoxH, battleFadeAlpha);
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

function _buildChatRows(ctx, lineW, startX) {
  const rows = [];
  for (const m of chatState.messages) {
    if (m.type === 'system') {
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

function _drawChatTextArea(ctx, curBoxY, curBoxH, battleFadeAlpha) {
  const innerTop    = curBoxY + 8;
  const innerBottom = curBoxY + curBoxH - 10;
  const innerH      = innerBottom - innerTop;
  ctx.globalAlpha = battleFadeAlpha;
  ctx.beginPath(); ctx.rect(8, innerTop, CANVAS_W - 16, curBoxH - 16); ctx.clip();
  ctx.font = '8px "Press Start 2P"'; ctx.textBaseline = 'bottom';
  const startX = 12;
  const lineW  = CANVAS_W - 8 - startX;
  const rows      = _buildChatRows(ctx, lineW, startX);
  const inputRows = chatState.inputActive ? 2 : 0;
  const availRows = Math.max(1, Math.floor(innerH / CHAT_LINE_H) - inputRows);
  const inputLine2Y = innerBottom;
  const inputLine1Y = inputLine2Y - CHAT_LINE_H;
  const bottomY   = chatState.inputActive ? inputLine1Y - CHAT_LINE_H : inputLine2Y;
  const visible   = rows.slice(-availRows);
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
  if (chatState.inputActive) _drawChatInput(ctx, lineW, startX, inputLine1Y, inputLine2Y);
}
