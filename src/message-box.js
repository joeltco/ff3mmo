// message-box.js — slide-in/hold/slide-out message box overlay

import { drawText, measureText } from './font-renderer.js';

// NES layout constants — must match game.js
const HUD_VIEW_X = 0;
const HUD_VIEW_Y = 32;
const HUD_VIEW_W = 144;

const BATTLE_SCROLL_MS = 150;

// ── Mutable state ──────────────────────────────────────────────────────────
export const msgState = {
  state:   'none',  // 'slide-in'|'hold'|'slide-out'|'none'
  timer:   0,
  bytes:   null,    // Uint8Array text
  onClose: null,    // callback after slide-out completes
};

// ── Public API ─────────────────────────────────────────────────────────────

export function showMsgBox(bytes, onClose) {
  msgState.bytes   = bytes;
  msgState.state   = 'slide-in';
  msgState.timer   = 0;
  msgState.onClose = onClose || null;
}

export function updateMsgBox(dt) {
  if (msgState.state === 'none') return;
  msgState.timer += Math.min(dt, 33);

  if (msgState.state === 'slide-in') {
    if (msgState.timer >= BATTLE_SCROLL_MS) { msgState.state = 'hold'; msgState.timer = 0; }
  } else if (msgState.state === 'slide-out') {
    if (msgState.timer >= BATTLE_SCROLL_MS) {
      const cb = msgState.onClose;
      msgState.state = 'none'; msgState.timer = 0; msgState.bytes = null; msgState.onClose = null;
      if (cb) cb();
    }
  }
}

export function drawMsgBox(ctx, clipToViewportFn, drawBorderedBoxFn) {
  if (msgState.state === 'none' || !msgState.bytes) return;

  const boxW      = HUD_VIEW_W - 16;
  const interiorW = boxW - 16;
  const maxChars  = Math.floor(interiorW / 8);
  const lines     = _wrapMsgBytes(msgState.bytes, maxChars);
  const lineH     = 12;
  const boxH      = Math.max(48, 24 + lines.length * lineH);
  const vpTop     = HUD_VIEW_Y;
  const finalY    = vpTop + 8;
  const centerX   = HUD_VIEW_X + Math.floor((HUD_VIEW_W - boxW) / 2);

  let boxY = finalY;
  if (msgState.state === 'slide-in') {
    const t = Math.min(msgState.timer / BATTLE_SCROLL_MS, 1);
    boxY = (vpTop - boxH) + (finalY - (vpTop - boxH)) * t;
  } else if (msgState.state === 'slide-out') {
    const t = Math.min(msgState.timer / BATTLE_SCROLL_MS, 1);
    boxY = finalY + ((vpTop - boxH) - finalY) * t;
  }

  clipToViewportFn();
  drawBorderedBoxFn(centerX, boxY, boxW, boxH, true);

  if (msgState.state === 'hold' || msgState.state === 'slide-out') {
    const fadedPal   = [0x02, 0x02, 0x02, 0x30];
    const textBlockH = lines.length * lineH;
    const startTY    = boxY + Math.floor((boxH - textBlockH) / 2);
    for (let i = 0; i < lines.length; i++) {
      const tw = measureText(lines[i]);
      const tx = centerX + Math.floor((boxW - tw) / 2);
      drawText(ctx, tx, startTY + i * lineH, lines[i], fadedPal);
    }
  }

  ctx.restore();
}

// ── Private helpers ────────────────────────────────────────────────────────

function _wrapMsgBytes(bytes, maxChars) {
  // Split msg bytes into lines that fit within maxChars.
  // Word-break on 0xFF (space). Each printable byte (>=0x28) = 1 char.
  const lines = [];
  let lineStart = 0, lastSpace = -1, lineLen = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x00) break;
    if (b === 0xFF) lastSpace = i;
    if (b >= 0x28) lineLen++;
    if (lineLen > maxChars && lastSpace > lineStart) {
      lines.push(bytes.slice(lineStart, lastSpace));
      lineStart = lastSpace + 1;
      lastSpace = -1;
      lineLen = 0;
      for (let j = lineStart; j <= i; j++) { if (bytes[j] >= 0x28) lineLen++; }
    }
  }
  if (lineStart < bytes.length) lines.push(bytes.slice(lineStart));
  return lines;
}
