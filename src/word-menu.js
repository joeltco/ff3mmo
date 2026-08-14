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
import { drawText, measureText } from './font-renderer.js';

// Row palettes. Slots 1-2 are the BOX's blue, matching how message-box.js draws
// its body text — font-renderer paints those two indices solid, so the shared
// TEXT_WHITE / TEXT_RED / TEXT_GREY constants (built for a black background)
// stamp a dark block behind every label. Only slot 3, the glyph fill, differs.
const ROW_PLAIN     = [0x02, 0x02, 0x02, 0x30];   // white — a verb
const ROW_TERM      = [0x02, 0x02, 0x02, 0x16];   // red — a Key Term, as FF2 shows them
const ROW_TERM_DIM  = [0x02, 0x02, 0x02, 0x10];   // grey — a term this NPC cannot answer
import { _nameToBytes } from './text-utils.js';
import { playFF2Sfx, playWordLearnedJingle, FF2_SFX_NAMES } from './music.js';
import { keywordText } from './data/keywords.js';
import { knownWords, learnableFrom, answerFor, answerTeaches, learnWord } from './word-memory.js';
import { showMsgBoxPages, dismissMsgBox, msgState } from './message-box.js';
import { mapSt } from './map-state.js';
import { askQuestWord, acceptQuest } from './quests.js';

const HUD_VIEW_X = 0;
const HUD_VIEW_Y = 32;
const HUD_VIEW_W = 144;
const HUD_VIEW_H = 144;
const MSG_BOX_H  = 48;          // message-box.js draws 48px tall at HUD_VIEW_Y

// Geometry copied from the shop's ROOT menu (src/shop.js#_drawRootMenu), which
// is the same widget: a short labelled list with a hand cursor.
//   text   at MENU_X + 16,  row pitch MENU_STEP = 16
//   cursor at MENU_X,       drawn 4px high
// The cursor tile is 16x16 — MEASURED off initCursorTile, not assumed. The 12px
// row pitch that shipped made a 16px hand overlap the rows above and below and
// collide with its own label; that is what "the cursor is sloppily thrown on
// there" was. Render it with tools/word-menu-shot.mjs before touching any of
// these numbers.
const ROW_STEP    = 16;
const PAD_X       = 8;
const PAD_Y       = 10;   // 8px border + 2 so the glyphs don't touch the frame
const TEXT_INDENT = 16;
const CURSOR_DY   = -4;
// 4 rows max: the box hangs under the 48px message box at y=80, so
// 4*16 + 20 = 84 puts its bottom at 164, inside the 176 viewport floor.
const MAX_VISIBLE = 4;

export const wordMenuSt = {
  open:   false,
  mode:   'verbs',   // 'verbs' | 'ask' | 'learn'
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
    if (wordMenuSt.mode === 'ask' || wordMenuSt.mode === 'learn') { playFF2Sfx(FF2_SFX_NAMES.CURSOR); _backToVerbs(); }
    else closeWordMenu();
    return true;
  }
  return true;   // menu is modal even on keys it ignores
}

// Learn exactly one term, with FF2's own keyword-learned jingle — but ONLY
// when something was actually learned. "Nothing new to learn." keeps the plain
// confirm blip: a reward cue that fires when nothing happened teaches the
// player it means nothing. The jingle rides its own emulator, so the map music
// is untouched.
function _learnOne(id) {
  const got = !!id && learnWord(id);
  if (got) playWordLearnedJingle();
  const page = got ? `Learned the word ${keywordText(id)}.` : 'Nothing new to learn.';
  showMsgBoxPages([_nameToBytes(page)], _backToVerbs, null, { keepOpen: true });
}

function _choose(row) {
  if (!row) { closeWordMenu(); return; }
  playFF2Sfx(FF2_SFX_NAMES.CONFIRM);

  // ONE word per LEARN (v1.8.8). Pre-fix a single press took everything the
  // NPC had — ur_npc_09 handed over CAVE and BROTHER together — which is the
  // opposite of FF2, where you pick the word out of what was just said.
  // The list only opens when there is a choice to make; skipping a menu with
  // one option is not an inconsistency, and every teacher in Ur but one
  // teaches exactly one word. Flip this to always-list by dropping the
  // length check.
  if (row.act === 'learn') {
    const ids = row.ids || [];
    if (ids.length > 1) {
      wordMenuSt.mode = 'learn';
      _setRows(ids.map(id => ({
        label: keywordText(id) || id.toUpperCase(),
        act: 'learn-one', id, term: true, has: true,
      })));
      return;
    }
    _learnOne(ids[0]);
    return;
  }

  if (row.act === 'learn-one') { _learnOne(row.id); return; }

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
    const spec  = _spec(npc);
    const reply = answerFor(spec, row.id) || ['I know nothing', 'about that.'];
    // An answer can hand over the next term — the FF2 chain, and as of v1.8.8
    // actually wired: `answers: { cave: { pages, teaches: 'vein' } }`. The
    // gained word lands AFTER the reply has been read, with the same jingle
    // LEARN uses, and the verb list is rebuilt (not restored) so ASK picks the
    // new term up immediately.
    const gained = answerTeaches(spec, row.id);
    showMsgBoxPages(reply.map(p => _nameToBytes(p)), () => {
      if (gained && learnWord(gained)) {
        playWordLearnedJingle();
        showMsgBoxPages([_nameToBytes(`Learned the word ${keywordText(gained)}.`)],
          _backToVerbs, null, { keepOpen: true });
        return;
      }
      _backToVerbs();
    }, null, { keepOpen: true });
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

  // A scrolling list needs a gutter for the arrow, or it lands on top of the
  // last glyph of the longest label: "BROTHER" ends at x=80 in an 88-wide box
  // and the arrow draws at boxW-12 = 76. MEASURED, not eyeballed — the shot
  // tool draws it.
  const needArrows = rows.length > vis;
  const ARROW_GUTTER = 12;
  const boxW = Math.min(HUD_VIEW_W,
    Math.max(64, widest + PAD_X * 2 + TEXT_INDENT + (needArrows ? ARROW_GUTTER : 0)));
  const boxH = vis * ROW_STEP + PAD_Y * 2;
  const boxX = HUD_VIEW_X;
  const boxY = Math.min(HUD_VIEW_Y + MSG_BOX_H, HUD_VIEW_Y + HUD_VIEW_H - boxH);

  // BLUE, like the message box it sits under (message-box.js draws its own with
  // `blue = true`). The default is a black interior, which stacked a black panel
  // directly beneath a blue one.
  drawBorderedBox(boxX, boxY, boxW, boxH, true);

  const ctx = ui.ctx;
  for (let i = 0; i < vis; i++) {
    const row = rows[first + i];
    // Key Terms read red like FF2's highlighted words; a term this NPC has no
    // answer for is greyed instead.
    const pal = !row.term ? ROW_PLAIN : row.has ? ROW_TERM : ROW_TERM_DIM;
    drawText(ctx, boxX + PAD_X + TEXT_INDENT, boxY + PAD_Y + i * ROW_STEP, _nameToBytes(row.label), pal);
  }

  // Scroll arrows — the SAME primitives the shop list and the pause inventory
  // use (`ui.scrollArrowUp/Down`, 8x8 ROM tiles, 250 ms blink), not a new
  // marker. MAX_VISIBLE is 4 because a 5th row puts the box past the 176 px
  // viewport floor, and the vocabulary was ALREADY 4 when this shipped: the
  // next term added would have started the list scrolling with nothing on
  // screen saying so, and a player holding six words would see four. v1.8.7.
  if (needArrows) {
    const arrowX = boxX + boxW - ARROW_GUTTER;
    const blink = (Math.floor(Date.now() / 250) & 1) === 0;
    // Inside the frame, not on it. The 8px border runs boxY..boxY+8, so an
    // arrow at boxY+2 straddles the white edge and reads as a smudge — drawn
    // and looked at, which is the only way that shows up.
    if (first > 0 && ui.scrollArrowUp && blink) {
      ctx.drawImage(ui.scrollArrowUp, arrowX, boxY + 8);
    }
    if (first + vis < rows.length && ui.scrollArrowDown && blink) {
      ctx.drawImage(ui.scrollArrowDown, arrowX, boxY + boxH - 16);
    }
  }
  drawCursorFaded(boxX + PAD_X, boxY + PAD_Y + (wordMenuSt.index - first) * ROW_STEP + CURSOR_DY, 0);
}
