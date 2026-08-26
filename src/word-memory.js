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
import { resolvePages, isVariantList } from './data/dialogue.js';
import { hasFlag } from './story-flags.js';
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

// An answer is authored either as bare pages, or as `{ pages, teaches }` when
// asking about that term is what hands over the NEXT one (v1.8.8). Both forms
// stay legal: most answers are just something the NPC knows, and only the ones
// carrying the chain need the longer shape.
//
//   answers: {
//     riders: ['They took the north road.', 'I poured for them.'],
//     cave:   { pages: ['The vein and the cave', 'are the same dark.'],
//               teaches: 'vein' },
//   }
function _answerEntry(npcSpec, id) {
  let a = npcSpec && npcSpec.answers && npcSpec.answers[id];
  // ⭐ An answer may be STATE-DEPENDENT — a list of `{ when, pages }` variants
  // keyed to story flags (data/dialogue.js). What somebody tells you about the
  // Djinn before the cave and after it are not the same sentence. Resolved
  // here, at the single place an answer is read, so every caller and every gate
  // sees the same one.
  if (isVariantList(a)) a = resolvePages(a, hasFlag);
  if (Array.isArray(a)) return a.length ? { pages: a, teaches: null } : null;
  if (a && typeof a === 'object' && Array.isArray(a.pages) && a.pages.length) {
    return { pages: a.pages, teaches: a.teaches || null };
  }
  return null;
}

/** This NPC's reply to a term, or null if they have nothing to say about it. */
export function answerFor(npcSpec, id) {
  const e = _answerEntry(npcSpec, id);
  return e ? e.pages : null;
}

/**
 * The term the player GAINS by asking this NPC about `id`, or null. This is the
 * only way one word gates another: `learnableFrom` reads the NPC's static
 * `teaches` list, which is what an NPC volunteers, and can never depend on what
 * was asked. Without this the vocabulary is a set of independent pickups and
 * the "chain" is a claim in a comment.
 */
export function answerTeaches(npcSpec, id) {
  const e = _answerEntry(npcSpec, id);
  return e && e.teaches && KEYWORDS[e.teaches] ? e.teaches : null;
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
