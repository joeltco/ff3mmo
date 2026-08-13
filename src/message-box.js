// message-box.js — slide-in/hold/slide-out message box overlay (draws inside map viewport)

import { drawText, measureText } from './font-renderer.js';
import { isMobile } from './ui-state.js';

// ⛔ THE TEXT TYPE-OUT IS SILENT. Do not add a per-character blip back.
//
// v1.7.979 shipped one (FF3's CURSOR every third glyph). Joel: "why are messages
// having weird sfx as the words scroll". Removed in v1.7.986.
//
// It was never authentic either. v1.7.981 mapped FF2's sound engine end to end
// (tools/ff2-sound-map.mjs): every sound it can make is either a table entry
// requested through $E0 or one of three short pulse-2 routines, and only TWO of
// those three are called by anything in the ROM — the cursor blip and the
// confirm blip. FF2 has NO per-character text sound. Its prologue draws ~7,700
// frames of text without requesting a single one.
//
// FF2's real blips play on the ASK/LEARN menu (word-menu.js), where they belong.

// NES layout constants — must match game.js
const CANVAS_W   = 256;
const HUD_VIEW_Y = 32;
const HUD_VIEW_W = 144;
const HUD_VIEW_H = 144;

const SLIDE_MS  = 80;   // box slide-in/out duration
const SCROLL_MS = 160;  // inter-page text scroll duration

// FF2-style type-out: dialogue reveals a character at a time instead of the
// whole page snapping in. Silent — see the block above.
const TYPE_MS_PER_CHAR = 28;

// ── Key Term highlighting ─────────────────────────────────────────────────
//
// FF2 prints its Key Terms in a second colour inside the dialogue itself —
// that highlight IS the prompt to LEARN. Terms are registered once at boot
// (boot.js, from data/keywords.js) rather than imported here, so the box stays
// a generic widget and any future highlight source can register too.
//
// Matching runs on a case-folded copy of the page where every byte maps to one
// character, so a match index in that string is a byte index in the page. A
// term only counts on word boundaries: "cave" must not light up inside
// "caves"... it must, actually — plurals are still the term — so the boundary
// test allows a trailing 's' and stops at punctuation.
const TEXT_HIGHLIGHT = [0x0F, 0x06, 0x06, 0x16];   // TEXT_RED, matching the ASK list
let _highlightWords = [];    // lowercase strings

/** Register the words the box should colour. Replaces any previous set. */
export function registerMsgHighlights(words) {
  _highlightWords = (words || []).map(w => String(w).toLowerCase()).filter(Boolean);
}

// Byte -> lowercase letter, or '\u0000' for anything that is not a letter.
function _foldByte(b) {
  if (b >= 0x8A && b <= 0xA3) return String.fromCharCode(b - 0x8A + 97);   // A-Z
  if (b >= 0xA4 && b <= 0xBD) return String.fromCharCode(b - 0xA4 + 97);   // a-z
  return '\u0000';
}

/**
 * A Uint8Array parallel to `bytes`: 1 where that byte is part of a Key Term.
 * Returns null when nothing matches, so the common case allocates nothing.
 */
function _highlightMask(bytes) {
  if (!_highlightWords.length || !bytes || !bytes.length) return null;
  let fold = '';
  for (let i = 0; i < bytes.length; i++) fold += _foldByte(bytes[i]);
  let mask = null;
  for (const w of _highlightWords) {
    let from = 0;
    for (;;) {
      const at = fold.indexOf(w, from);
      if (at < 0) break;
      from = at + 1;
      const before = at === 0 ? '\u0000' : fold[at - 1];
      let end = at + w.length;
      if (fold[end] === 's') end++;              // plural still reads as the term
      const after = end >= fold.length ? '\u0000' : fold[end];
      if (before !== '\u0000' || after !== '\u0000') continue;   // inside a longer word
      if (!mask) mask = new Uint8Array(bytes.length);
      for (let i = at; i < end; i++) mask[i] = 1;
    }
  }
  return mask;
}

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
      msgState.typed++;
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
      // The OUTGOING page was fully revealed, so it scrolls away complete.
      _drawMsgText(ctx, msgState.scrollFromBytes, boxY, boxW, boxH, maxChars, lineH, oldOff);
    }
    // The INCOMING page scrolls in EMPTY and types out once the scroll lands.
    // Drawing it in full here (which is what an omitted `reveal` did) made the
    // whole page flash up during the scroll and then vanish, because the
    // page-scroll -> hold transition calls _restartTyping() and resets `typed`
    // to 0. That was "the text appears then disappears before it scrolls".
    // Page 1 already behaves this way: nothing is drawn during slide-in.
    _drawMsgText(ctx, msgState.bytes, boxY, boxW, boxH, maxChars, lineH, newOff, 0);
    ctx.restore();
  }

  ctx.restore();
}

function _drawMsgText(ctx, bytes, boxY, boxW, boxH, maxChars, lineH, yOff, reveal) {
  const ranges = _wrapMsgRanges(bytes, maxChars);
  const lines = ranges.map(([a, b]) => bytes.slice(a, b));
  const mask = _highlightMask(bytes);
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
    const shownLen = budget >= full.length ? full.length : budget;
    budget -= full.length + 1;             // +1 for the space the wrap consumed
    const tw = measureText(full);          // centre on the FULL line
    let tx = Math.floor((boxW - tw) / 2);
    const ty = startTY + i * lineH;
    const lineMask = mask ? mask.subarray(ranges[i][0], ranges[i][1]) : null;
    if (!lineMask) { drawText(ctx, tx, ty, full.slice(0, shownLen), fadedPal); continue; }
    // Split the visible part into runs of one colour. drawText returns the
    // width it drew, so the runs chain exactly — no re-measuring, no drift.
    let r = 0;
    while (r < shownLen) {
      const on = lineMask[r];
      let e = r + 1;
      while (e < shownLen && lineMask[e] === on) e++;
      tx += drawText(ctx, tx, ty, full.slice(r, e), on ? TEXT_HIGHLIGHT : fadedPal);
      r = e;
    }
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

// Wrap into [start, end) BYTE RANGES rather than slices, so the highlight mask
// (which is indexed against the unwrapped page) can be sliced the same way.
function _wrapMsgRanges(bytes, maxChars) {
  const ranges = [];
  let lineStart = 0, lastSpace = -1, lineLen = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x00) break;
    if (b === 0xFF) lastSpace = i;
    if (b >= 0x28) lineLen++;
    if (lineLen > maxChars && lastSpace > lineStart) {
      ranges.push([lineStart, lastSpace]);
      lineStart = lastSpace + 1;
      lastSpace = -1;
      lineLen = 0;
      for (let j = lineStart; j <= i; j++) { if (bytes[j] >= 0x28) lineLen++; }
    }
  }
  if (lineStart < bytes.length) ranges.push([lineStart, bytes.length]);
  return ranges;
}

function _wrapMsgBytes(bytes, maxChars) {
  return _wrapMsgRanges(bytes, maxChars).map(([a, b]) => bytes.slice(a, b));
}
