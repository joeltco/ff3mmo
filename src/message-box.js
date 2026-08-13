// message-box.js — slide-in/hold/slide-out message box overlay (draws inside map viewport)

import { drawText, measureText } from './font-renderer.js';
import { isMobile } from './ui-state.js';
import { playSFX, SFX } from './music.js';

// Per-character tick. CURSOR is the shortest measured blip we have (see the
// SFX table in music.js — every entry there was captured from the running ROM).
// It is OUR pick from that table, NOT FF2's actual text sound: FF2's blip is an
// FF2 NSF track and picking one needs ears, so audition with /ff2 <n> and this
// constant can point at it instead.
const MSG_TYPE_SFX = SFX.CURSOR;

// NES layout constants — must match game.js
const CANVAS_W   = 256;
const HUD_VIEW_Y = 32;
const HUD_VIEW_W = 144;
const HUD_VIEW_H = 144;

const SLIDE_MS  = 80;   // box slide-in/out duration
const SCROLL_MS = 160;  // inter-page text scroll duration

// FF2-style type-out. FF2 reveals dialogue a character at a time with a short
// tick rather than snapping the whole page in. `TYPE_BLIP_EVERY` is why it
// reads as speech and not a machine gun — FF2 does not sound one tick per
// glyph.
const TYPE_MS_PER_CHAR = 28;
const TYPE_BLIP_EVERY  = 3;

// ── Mutable state ──────────────────────────────────────────────────────────
export const msgState = {
  state:           'none',  // 'slide-in'|'hold'|'slide-out'|'page-scroll'|'none'
  timer:           0,
  bytes:           null,    // current Uint8Array text (the page being shown)
  onClose:         null,    // callback after slide-out completes
  onAdvance:       null,    // if set, Z calls this instead of dismissMsgBox
  scrollFromBytes: null,    // during 'page-scroll', the outgoing page text
  // Prompt mode (v1.7.379) — when `isPrompt` is true, Z fires `onAccept` and
  // X fires `onDecline` instead of the normal dismiss flow. Used for the
  // incoming party invite y/n prompt; reusable for any future yes/no UI.
  isPrompt:        false,
  onAccept:        null,
  onDecline:       null,
  // Type-out: how many BYTES of the current page are revealed so far, and the
  // accumulator that advances it. `typed` is byte-based, not glyph-based, so
  // the wrapped lines can be sliced directly without re-deriving glyph counts.
  typed:           0,
  typeTimer:       0,
  typeBlips:       0,
};

/** True while the current page is still revealing. */
export function isMsgTyping() {
  return msgState.state === 'hold' && msgState.bytes &&
         msgState.typed < msgState.bytes.length;
}

/** Reveal the rest of the page immediately (Z during type-out). */
export function completeMsgTyping() {
  if (msgState.bytes) msgState.typed = msgState.bytes.length;
  msgState.typeTimer = 0;
}

function _restartTyping() {
  msgState.typed = 0;
  msgState.typeTimer = 0;
  msgState.typeBlips = 0;
}

// ── Public API ─────────────────────────────────────────────────────────────

export function showMsgBox(bytes, onClose) {
  msgState.bytes   = bytes;
  msgState.state   = 'slide-in';
  msgState.timer   = 0;
  msgState.onClose = onClose || null;
  msgState.isPrompt = false;
  msgState.onAccept = null;
  msgState.onDecline = null;
}

// Mobile-aware key-cue label for yes/no prompts. Mobile deck maps A→z, B→x
// (index.html `data-key`), so the visible letter changes but the actual key
// codes don't. Single source for every `showMsgBoxPrompt` caller — append it
// to your question text so players see the right keys. v1.7.688.
export function yesNoLabels() {
  return isMobile ? 'A=ok B=no' : 'Z=ok X=no';
}

// Yes/no prompt. Z fires `onAccept` then dismisses; X fires `onDecline` then
// dismisses. Caller is responsible for putting the y/n cue in the message
// text (use `yesNoLabels()` above) — the primitive itself stays UI-free so
// future prompts can render whatever style fits the context.
export function showMsgBoxPrompt(bytes, onAccept, onDecline) {
  msgState.bytes     = bytes;
  msgState.state     = 'slide-in';
  msgState.timer     = 0;
  msgState.onClose   = null;
  msgState.onAdvance = null;
  msgState.isPrompt  = true;
  msgState.onAccept  = onAccept || null;
  msgState.onDecline = onDecline || null;
}

// Trigger slide-out from the 'hold' phase. No-op if not currently held.
export function dismissMsgBox() {
  if (msgState.state !== 'hold') return;
  msgState.state = 'slide-out';
  msgState.timer = 0;
}

// v1.7.446 — unconditional hide. Use when a state transition (battle entry,
// roster fade, etc.) needs to drop any in-flight message regardless of which
// phase it's in (slide-in / hold / page-scroll / slide-out). `dismissMsgBox`
// only handles 'hold'; this one wipes everything. No slide-out animation —
// the caller's wipe usually covers the visual.
export function forceCloseMsgBox() {
  msgState.state     = 'none';
  msgState.timer     = 0;
  msgState.bytes     = null;
  msgState.onClose   = null;
  msgState.onAdvance = null;
  msgState.isPrompt  = false;
  msgState.onAccept  = null;
  msgState.onDecline = null;
  msgState.scrollFromBytes = null;
}

// Smooth swap: when a message is already on screen and held, replace
// the text + onClose without re-animating slide-in. Falls back to
// `showMsgBox` if no message is currently held — caller doesn't need
// to know which case applies. Used by the PVP search flow to slide
// "Searching..." into "Connecting..." without a flicker. v1.7.226.
export function replaceMsgBoxText(bytes, onClose) {
  if (msgState.state === 'hold') {
    msgState.bytes   = bytes;
    msgState.onClose = onClose || null;
  } else {
    showMsgBox(bytes, onClose);
  }
}

// Show a sequence of pages through a single box. Slide-in plays once on
// page 1, every Z-advance after that scrolls the old text UP and the new
// text in from below (no box re-animation between pages), and slide-out
// only plays after the final page. `onAllDone` fires once the slide-out
// completes (after the last page).
// onPage(idx) — optional, fires as each page becomes the active one (page 0 at
// open, then on every advance). Used by the opening-scene intro to turn the
// player to face whichever NPC is speaking.
export function showMsgBoxPages(pages, onAllDone, onPage, opts) {
  if (!pages || pages.length === 0) return;
  const keepOpen = !!(opts && opts.keepOpen);
  let idx = 0;
  const advance = () => {
    idx++;
    if (idx >= pages.length) {
      msgState.onAdvance = null;
      if (keepOpen) {
        // The conversation isn't over — park on the last page instead of
        // sliding out and hand control to whoever asked (the ASK/LEARN menu).
        // They own dismissMsgBox from here.
        msgState.scrollFromBytes = null;
        msgState.state = 'hold';
        msgState.timer = 0;
        if (onAllDone) onAllDone();
        return;
      }
      msgState.onClose = onAllDone || null;
      // Final page: slide the whole box out. If still mid-scroll, snap.
      msgState.scrollFromBytes = null;
      msgState.state = 'slide-out';
      msgState.timer = 0;
      return;
    }
    if (onPage) onPage(idx);
    // Mid-scroll spam press: snap to the new page and skip remaining scroll.
    if (msgState.state === 'page-scroll') {
      msgState.bytes = pages[idx];
      msgState.scrollFromBytes = null;
      msgState.state = 'hold';
      msgState.timer = 0;
      return;
    }
    if (msgState.state === 'hold') {
      msgState.scrollFromBytes = msgState.bytes;
      msgState.bytes = pages[idx];
      msgState.state = 'page-scroll';
      msgState.timer = 0;
    } else {
      // Slide-in still running (unlikely but possible). Just swap text.
      msgState.bytes = pages[idx];
    }
  };
  // A keepOpen sequence opened on top of a box that's already held (an ASK
  // reply following the NPC's dialogue) scrolls the new text up into place
  // instead of re-animating the whole box — same as a page advance.
  if (keepOpen && msgState.state === 'hold' && msgState.bytes) {
    msgState.scrollFromBytes = msgState.bytes;
    msgState.bytes     = pages[0];
    msgState.state     = 'page-scroll';
    msgState.timer     = 0;
    msgState.onClose   = null;
    msgState.isPrompt  = false;
    msgState.onAccept  = null;
    msgState.onDecline = null;
  } else {
    showMsgBox(pages[0]);
  }
  if (onPage) onPage(0);
  msgState.onAdvance = advance;
}

export function updateMsgBox(dt) {
  if (msgState.state === 'none') return;
  msgState.timer += Math.min(dt, 33);

  if (msgState.state === 'hold' && msgState.bytes && msgState.typed < msgState.bytes.length) {
    msgState.typeTimer += Math.min(dt, 33);
    while (msgState.typeTimer >= TYPE_MS_PER_CHAR && msgState.typed < msgState.bytes.length) {
      msgState.typeTimer -= TYPE_MS_PER_CHAR;
      const b = msgState.bytes[msgState.typed++];
      // Tick only on visible glyphs, and only every few of them.
      if (b >= 0x28 && b !== 0xFF && (msgState.typeBlips++ % TYPE_BLIP_EVERY) === 0) {
        playSFX(MSG_TYPE_SFX);
      }
    }
  }

  if (msgState.state === 'slide-in') {
    if (msgState.timer >= SLIDE_MS) { msgState.state = 'hold'; msgState.timer = 0; _restartTyping(); }
  } else if (msgState.state === 'page-scroll') {
    if (msgState.timer >= SCROLL_MS) {
      msgState.state = 'hold';
      msgState.timer = 0;
      msgState.scrollFromBytes = null;
      _restartTyping();
    }
  } else if (msgState.state === 'slide-out') {
    if (msgState.timer >= SLIDE_MS) {
      const cb = msgState.onClose;
      msgState.state = 'none'; msgState.timer = 0; msgState.bytes = null;
      msgState.onClose = null; msgState.onAdvance = null;
      msgState.scrollFromBytes = null;
      msgState.isPrompt = false; msgState.onAccept = null; msgState.onDecline = null;
      if (cb) cb();
    }
  }
}

export function drawMsgBox(ctx, drawBorderedBoxFn) {
  if (msgState.state === 'none' || !msgState.bytes) return;

  const boxW      = HUD_VIEW_W;
  const boxH      = 48;
  const interiorW = boxW - 16;
  const maxChars  = Math.floor(interiorW / 8);
  const lineH     = 12;
  const finalY    = HUD_VIEW_Y;

  let boxY = finalY;
  if (msgState.state === 'slide-in') {
    const t = Math.min(msgState.timer / SLIDE_MS, 1);
    boxY = HUD_VIEW_Y - boxH + boxH * t;
  } else if (msgState.state === 'slide-out') {
    const t = Math.min(msgState.timer / SLIDE_MS, 1);
    boxY = finalY - boxH * t;
  }

  // Clip to map viewport (outer clip — keeps box + text inside the map view)
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);
  ctx.clip();

  drawBorderedBoxFn(0, boxY, boxW, boxH, true);

  if (msgState.state === 'hold' || msgState.state === 'slide-out') {
    _drawMsgText(ctx, msgState.bytes, boxY, boxW, boxH, maxChars, lineH, 0, msgState.typed);
  } else if (msgState.state === 'page-scroll') {
    // Inner clip — keep scrolling text inside the box, so it doesn't bleed
    // over the borders as old/new pages slide past each other.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, boxY + 4, boxW, boxH - 8);
    ctx.clip();
    const t = Math.min(msgState.timer / SCROLL_MS, 1);
    const oldOff = -Math.round(boxH * t);
    const newOff = Math.round(boxH * (1 - t));
    if (msgState.scrollFromBytes) {
      _drawMsgText(ctx, msgState.scrollFromBytes, boxY, boxW, boxH, maxChars, lineH, oldOff);
    }
    _drawMsgText(ctx, msgState.bytes, boxY, boxW, boxH, maxChars, lineH, newOff);
    ctx.restore();
  }

  ctx.restore();
}

function _drawMsgText(ctx, bytes, boxY, boxW, boxH, maxChars, lineH, yOff, reveal) {
  const lines = _wrapMsgBytes(bytes, maxChars);
  const fadedPal = [0x02, 0x02, 0x02, 0x30];
  // Glyphs are 8px tall but lineH is 12 — the trailing 4px gap below the
  // last line throws off geometric centering (visually biased upward, most
  // obvious in the 3-line case). Subtract one gap to get the actual visual
  // height, then center on that.
  const GLYPH_H = 8;
  const visualH = lines.length === 0 ? 0 : lines.length * lineH - (lineH - GLYPH_H);
  const startTY = boxY + Math.floor((boxH - visualH) / 2) + yOff;
  // Type-out: `reveal` caps how many BYTES of the page are drawn. The layout
  // (line breaks, centring) is computed from the FULL page first, so revealed
  // text does not shift around as more of it appears — FF2 reveals into a fixed
  // block, it does not re-flow on every character.
  let budget = reveal == null ? Infinity : reveal;
  for (let i = 0; i < lines.length; i++) {
    if (budget <= 0) break;
    const full = lines[i];
    const shown = budget >= full.length ? full : full.slice(0, budget);
    budget -= full.length + 1;             // +1 for the space the wrap consumed
    const tw = measureText(full);          // centre on the FULL line
    const tx = Math.floor((boxW - tw) / 2);
    drawText(ctx, tx, startTY + i * lineH, shown, fadedPal);
  }
}

// ── Private helpers ────────────────────────────────────────────────────────

// The box is 144px wide with an 8px border each side, so 16 glyphs per line;
// it is 48px tall and text is vertically centred at 12px per line. Two lines
// sit comfortably, three are flush against the border, and FOUR start ABOVE
// the interior — i.e. the text renders outside the box. Any dialogue page must
// therefore wrap to at most 2 lines.
export const MSG_MAX_CHARS = 16;
export const MSG_MAX_LINES = 2;

/** Wrapped line count for a page, using the real wrapper. */
export function msgLineCount(bytes, maxChars = MSG_MAX_CHARS) {
  return _wrapMsgBytes(bytes, maxChars).length;
}

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
