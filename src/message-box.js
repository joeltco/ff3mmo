// message-box.js — slide-in/hold/slide-out message box overlay (draws inside map viewport)

import { drawText, measureText } from './font-renderer.js';

// NES layout constants — must match game.js
const CANVAS_W   = 256;
const HUD_VIEW_Y = 32;
const HUD_VIEW_W = 144;
const HUD_VIEW_H = 144;

const SLIDE_MS = 80;  // faster slide than old viewport box

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
    if (msgState.timer >= SLIDE_MS) { msgState.state = 'hold'; msgState.timer = 0; }
  } else if (msgState.state === 'slide-out') {
    if (msgState.timer >= SLIDE_MS) {
      const cb = msgState.onClose;
      msgState.state = 'none'; msgState.timer = 0; msgState.bytes = null; msgState.onClose = null;
      if (cb) cb();
    }
  }
}

export function drawMsgBox(ctx, _clipUnused, drawBorderedBoxFn) {
  if (msgState.state === 'none' || !msgState.bytes) return;

  const boxW      = HUD_VIEW_W;
  const boxH      = 48;
  const interiorW = boxW - 16;
  const maxChars  = Math.floor(interiorW / 8);
  const lines     = _wrapMsgBytes(msgState.bytes, maxChars);
  const lineH     = 12;
  const finalY    = HUD_VIEW_Y;

  let boxY = finalY;
  if (msgState.state === 'slide-in') {
    const t = Math.min(msgState.timer / SLIDE_MS, 1);
    boxY = HUD_VIEW_Y - boxH + boxH * t;  // slide down from top of viewport
  } else if (msgState.state === 'slide-out') {
    const t = Math.min(msgState.timer / SLIDE_MS, 1);
    boxY = finalY - boxH * t; // slide back up out of viewport
  }

  // Clip to map viewport area
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);
  ctx.clip();

  drawBorderedBoxFn(0, boxY, boxW, boxH, true);

  if (msgState.state === 'hold' || msgState.state === 'slide-out') {
    const fadedPal   = [0x02, 0x02, 0x02, 0x30];
    const textBlockH = lines.length * lineH;
    const startTY    = boxY + Math.floor((boxH - textBlockH) / 2);
    for (let i = 0; i < lines.length; i++) {
      const tw = measureText(lines[i]);
      const tx = Math.floor((boxW - tw) / 2);
      drawText(ctx, tx, startTY + i * lineH, lines[i], fadedPal);
    }
  }

  ctx.restore();
}

// ── Private helpers ────────────────────────────────────────────────────────

function _wrapMsgBytes(bytes, maxChars) {
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
