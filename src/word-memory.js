// Word Memory runtime — which Key Terms the player has learned.
//
// State is `ps.words = { termId: 1 }` and nothing more; the vocabulary lives in
// data/keywords.js and the teach/answer tables on the NPC specs. Persisted
// through BOTH the client serializer (save-state.js) and the server validator
// (api.js) — a ps.* field added to only one silently resets on next login.
//
// ⛔ LEARNING WRITES TO DISK IMMEDIATELY. Pre-v1.8.7 `learnWord` only mutated
// `ps.words` and nothing on the LEARN path called saveSlotsToDB, so a term was
// held in memory until some unrelated event (a battle ending, a map change)
// happened to write it. Learn a word in the tavern, close the tab, and it was
// gone — and on iOS `beforeunload` never fires, so that is a swipe. A word is
// the only thing the player earns by exploring rather than fighting; losing one
// is losing the exploration.

import { ps } from './player-stats.js';
import { saveSlotsToDB } from './save-state.js';
import { KEYWORDS } from './data/keywords.js';

/** Has the player learned this term? Module-private — see learnableFrom. */
function hasWord(id) {
  return !!(ps.words && ps.words[id]);
}

/** Learn a term. Returns false if it was already known (so callers can stay quiet). */
export function learnWord(id) {
  if (!KEYWORDS[id]) return false;              // unknown id — never store it
  if (!ps.words || typeof ps.words !== 'object') ps.words = {};
  if (ps.words[id]) return false;
  ps.words[id] = 1;
  try { saveSlotsToDB(); } catch (_) { /* pre-boot / headless harness */ }
  return true;
}

/** Learned term ids, in the vocabulary's own order so the ASK list is stable. */
export function knownWords() {
  if (!ps.words || typeof ps.words !== 'object') return [];
  return Object.keys(KEYWORDS).filter(id => ps.words[id]);
}

/**
 * Terms this NPC could teach that the player does not have yet. FF2 only offers
 * LEARN when there is genuinely something new in what was just said.
 */
export function learnableFrom(npcSpec) {
  const teaches = (npcSpec && npcSpec.teaches) || [];
  return teaches.filter(id => KEYWORDS[id] && !hasWord(id));
}

/** This NPC's reply to a term, or null if they have nothing to say about it. */
export function answerFor(npcSpec, id) {
  const answers = npcSpec && npcSpec.answers;
  const a = answers && answers[id];
  return Array.isArray(a) && a.length ? a : null;
}

/** Sanitise a `words` blob from a save or a server push. */
export function sanitizeWords(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const id of Object.keys(raw)) {
    if (KEYWORDS[id] && raw[id]) out[id] = 1;   // drop unknown / removed terms
  }
  return out;
}
