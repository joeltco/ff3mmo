// The talk verb menu — FF2's ASK / LEARN, in our furniture.
//
// FF2 keeps the dialogue window on screen and opens a small verb list beside
// it: LEARN takes a Key Term out of what was just said, ASK repeats a term you
// already know at whoever you're standing in front of. This is that, drawn with
// the project's existing `drawBorderedBox` + `drawCursorFaded` + `drawText`
// rather than a parallel UI, so it inherits the HUD's border tiles and palette.
//
// The row list is deliberately open-ended — ACCEPT / DENY / ITEM slot in as
// more `act` values without touching the drawing or the input loop.
//
// The cursor and confirm blips are FF2's OWN, ripped from the ROM in v1.7.981
// (src/ff2-nsf-builder.js FF2_SFX) rather than borrowed from FF3 — measured by
// pressing directions and A on FF2's kana grid and watching which routine ran.

import { ui } from './ui-state.js';
import { drawBorderedBox, drawCursorFaded } from './hud-drawing.js';
import { drawText, measureText, TEXT_WHITE, TEXT_RED, TEXT_GREY } from './font-renderer.js';
import { _nameToBytes } from './text-utils.js';
import { playFF2Sfx, FF2_SFX_NAMES } from './music.js';
import { keywordText } from './data/keywords.js';
import { knownWords, learnableFrom, answerFor, learnWord } from './word-memory.js';
import { showMsgBoxPages, dismissMsgBox, msgState } from './message-box.js';
import { mapSt } from './map-state.js';
import { askQuestWord, acceptQuest } from './quests.js';

const HUD_VIEW_X = 0;
const HUD_VIEW_Y = 32;
const HUD_VIEW_W = 144;
const HUD_VIEW_H = 144;
const MSG_BOX_H  = 48;          // message-box.js draws 48px tall at HUD_VIEW_Y

const ROW_H       = 12;
const PAD         = 8;
const MAX_VISIBLE = 6;          // the vocabulary can outgrow the viewport

export const wordMenuSt = {
  open:   false,
  mode:   'verbs',   // 'verbs' | 'ask'
  rows:   [],        // [{ label, act, ... }]
  index:  0,
  scroll: 0,
  npc:    null,
  onDone: null,
};

/** Is the talk menu taking input right now? */
export function isWordMenuOpen() { return wordMenuSt.open; }

function _spec(npc) { return (npc && npc.scene) || null; }

function _verbRows(npc) {
  const spec = _spec(npc);
  // Someone with no word behaviour at all gets no menu — plain villagers keep
  // the plain dialogue box. Everyone who DOES take part gets ASK for every term
  // you know, answerable or not: hiding the ones they can't answer would tell
  // you which NPC matters before you've asked.
  const participates = !!spec && (((spec.teaches || []).length > 0) ||
                                  Object.keys(spec.answers || {}).length > 0);
  if (!participates) return [];
  const rows = [];
  // LEARN only appears when this NPC actually said something new — FF2 never
  // offers it as dead furniture.
  const learnable = learnableFrom(spec);
  if (learnable.length) rows.push({ label: 'LEARN', act: 'learn', ids: learnable });
  if (knownWords().length) rows.push({ label: 'ASK', act: 'ask' });
  return rows;
}

function _askRows(npc) {
  const spec = _spec(npc);
  return knownWords().map(id => ({
    label: keywordText(id) || id.toUpperCase(),
    act:   'say',
    id,
    // A term this NPC can't answer stays in the list, dimmed. Hiding it would
    // leak which NPC matters, and asking the wrong person is half of FF2.
    has:   !!answerFor(spec, id),
    term:  true,
  }));
}

function _setRows(rows) {
  wordMenuSt.rows = rows;
  wordMenuSt.index = 0;
  wordMenuSt.scroll = 0;
}

/**
 * Open the verb menu for an NPC. Call it from the dialogue's completion
 * callback with `keepOpen` set, so the message box is still parked on the last
 * page underneath. Returns false when the NPC has nothing to offer, so the
 * caller can just let the box slide out.
 */
export function openWordMenu(npc, onDone) {
  const rows = _verbRows(npc);
  if (!rows.length) return false;
  wordMenuSt.open = true;
  wordMenuSt.mode = 'verbs';
  wordMenuSt.npc = npc;
  wordMenuSt.onDone = onDone || null;
  _setRows(rows);
  return true;
}

export function closeWordMenu() {
  const cb = wordMenuSt.onDone;
  wordMenuSt.open = false;
  wordMenuSt.npc = null;
  wordMenuSt.onDone = null;
  _setRows([]);
  wordMenuSt.mode = 'verbs';
  // The menu owns the box while it's up (openWordMenu is called with keepOpen),
  // so it also owns getting rid of it.
  if (msgState.state !== 'none') dismissMsgBox();
  if (cb) cb();
}

// Rebuild the verb list after an action; drop out entirely once nothing's left.
function _backToVerbs() {
  wordMenuSt.mode = 'verbs';
  const rows = _verbRows(wordMenuSt.npc);
  if (!rows.length) { closeWordMenu(); return; }
  _setRows(rows);
}

function _moveCursor(delta) {
  const n = wordMenuSt.rows.length;
  if (!n) return;
  wordMenuSt.index = (wordMenuSt.index + delta + n) % n;
  const vis = Math.min(MAX_VISIBLE, n);
  if (wordMenuSt.index < wordMenuSt.scroll) wordMenuSt.scroll = wordMenuSt.index;
  else if (wordMenuSt.index >= wordMenuSt.scroll + vis) wordMenuSt.scroll = wordMenuSt.index - vis + 1;
  playFF2Sfx(FF2_SFX_NAMES.CURSOR);
}

/**
 * Drives the menu. Called from movement.js's modal message-box block — the
 * box is still open underneath, and that block is the only place Z/X reaches
 * a msgbox. Returns true whenever the menu is up, so nothing downstream sees
 * the keys.
 */
export function handleWordMenuInput(keys) {
  if (!wordMenuSt.open) return false;
  // A reply is still typing / sliding: let the normal msgbox handler advance it.
  if (msgState.state !== 'hold' || msgState.onAdvance) return false;

  if (keys['ArrowUp'] || keys['w'] || keys['W']) {
    keys['ArrowUp'] = false; keys['w'] = false; keys['W'] = false;
    _moveCursor(-1);
    return true;
  }
  if (keys['ArrowDown'] || keys['s'] || keys['S']) {
    keys['ArrowDown'] = false; keys['s'] = false; keys['S'] = false;
    _moveCursor(1);
    return true;
  }
  if (keys['z'] || keys['Z']) {
    keys['z'] = false; keys['Z'] = false;
    _choose(wordMenuSt.rows[wordMenuSt.index]);
    return true;
  }
  if (keys['x'] || keys['X'] || keys['Escape']) {
    keys['x'] = false; keys['X'] = false; keys['Escape'] = false;
    if (wordMenuSt.mode === 'ask') { playFF2Sfx(FF2_SFX_NAMES.CURSOR); _backToVerbs(); }
    else closeWordMenu();
    return true;
  }
  return true;   // menu is modal even on keys it ignores
}

function _choose(row) {
  if (!row) { closeWordMenu(); return; }
  playFF2Sfx(FF2_SFX_NAMES.CONFIRM);

  if (row.act === 'learn') {
    const names = row.ids.filter(id => learnWord(id)).map(id => keywordText(id)).filter(Boolean);
    const pages = names.length ? names.map(n => `Learned the word ${n}.`)
                               : ['Nothing new to learn.'];
    showMsgBoxPages(pages.map(p => _nameToBytes(p)), _backToVerbs, null, { keepOpen: true });
    return;
  }

  if (row.act === 'ask') {
    const rows = _askRows(wordMenuSt.npc);
    if (!rows.length) return;
    wordMenuSt.mode = 'ask';
    _setRows(rows);
    return;
  }

  if (row.act === 'say') {
    const npc = wordMenuSt.npc;
    // Bringing a quest giver their start term opens the offer instead of an
    // ordinary answer — this is the whole point of the word chain.
    const offer = npc.key ? askQuestWord(mapSt.currentMapId, npc.key, row.id) : null;
    if (offer) {
      showMsgBoxPages(offer.pages.map(p => _nameToBytes(p)), () => _setRows([
        { label: 'ACCEPT', act: 'accept', quest: offer },
        { label: 'DENY',   act: 'deny',   quest: offer },
      ]), null, { keepOpen: true });
      return;
    }
    const reply = answerFor(_spec(npc), row.id) || ['I know nothing', 'about that.'];
    // An answer can hand over the next term — that's the FF2 chain, and it's
    // why the verb list is rebuilt (not restored) when the reply closes.
    showMsgBoxPages(reply.map(p => _nameToBytes(p)), _backToVerbs, null, { keepOpen: true });
    return;
  }

  if (row.act === 'accept' || row.act === 'deny') {
    const q = row.quest;
    const taken = row.act === 'accept' && acceptQuest(q.id);
    const pages = (taken ? q.accepted : q.denied) || ['...'];
    showMsgBoxPages(pages.map(p => _nameToBytes(p)), _backToVerbs, null, { keepOpen: true });
  }
}

/**
 * The menu lives on top of a box it keeps parked open. Anything that wipes
 * that box out from under it — a battle starting, a map transition, a roster
 * fade, all of which call forceCloseMsgBox — has to take the menu with it, or
 * it stays up over the next screen eating keys. v1.7.980.
 */
export function updateWordMenu() {
  if (wordMenuSt.open && msgState.state === 'none') closeWordMenu();
}

/** Draw the verb list under the dialogue box. */
export function drawWordMenu() {
  if (!wordMenuSt.open) return;
  const rows = wordMenuSt.rows;
  if (!rows.length) return;
  // Hidden while a reply types out — the box is the focus then, same as FF2.
  if (msgState.state !== 'hold' || msgState.onAdvance) return;

  const vis   = Math.min(MAX_VISIBLE, rows.length);
  const first = Math.min(wordMenuSt.scroll, Math.max(0, rows.length - vis));
  let widest = 0;
  for (let i = first; i < first + vis; i++) widest = Math.max(widest, measureText(_nameToBytes(rows[i].label)));

  const boxW = Math.min(HUD_VIEW_W, Math.max(56, widest + PAD * 2 + 10));
  const boxH = vis * ROW_H + PAD * 2;
  const boxX = HUD_VIEW_X;
  const boxY = Math.min(HUD_VIEW_Y + MSG_BOX_H, HUD_VIEW_Y + HUD_VIEW_H - boxH);

  drawBorderedBox(boxX, boxY, boxW, boxH);

  const ctx = ui.ctx;
  for (let i = 0; i < vis; i++) {
    const row = rows[first + i];
    // Key Terms read red like FF2's highlighted words; a term this NPC has no
    // answer for is greyed instead.
    const pal = !row.term ? TEXT_WHITE : row.has ? TEXT_RED : TEXT_GREY;
    drawText(ctx, boxX + PAD + 10, boxY + PAD + i * ROW_H, _nameToBytes(row.label), pal);
  }
  drawCursorFaded(boxX + PAD, boxY + PAD + (wordMenuSt.index - first) * ROW_H, 0);
}
