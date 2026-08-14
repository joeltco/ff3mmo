// Quest runtime — state and the talk handler.
//
// State lives in `ps.quests[id] = { s, n }` (state + objective count) and
// nothing more; the static half is in data/quests.js so the server has a fixed
// table to check claims against. Persisted through BOTH the client serializer
// (save-state.js) and the server validator (api.js) — a `ps.*` field added to
// only one of those silently vanishes on the next login.
//
// There is NO overhead marker. v1.7.990 removed it and v1.7.991 deleted the
// sprite data with it: the Word Memory system carries the signposting now, the
// FF2 way — you find out who matters by talking to people and carrying their
// words, not by following a bubble. Progress rides the same channel: the pages
// carry `{n}` / `{count}` / `{left}` and the giver reads the number out.
//
// ⛔ EVERY state transition here calls saveSlotsToDB. The reward is durable the
// instant it is granted (gil goes to the server mirror, which writes SQLite),
// so an unsaved `s: 'done'` is not a lost flag — it is a repeatable payout. The
// v1.8.6 audit reproduced 900 gil from one save by handing in three times, and
// it needed no modding: on iOS `beforeunload` never fires, so closing the tab
// after a hand-in was the whole exploit. The server-side claim ledger
// (economy-arbiter.js#validateQuestClaim) is the second lock on the same door.

import { ps } from './player-stats.js';
import { saveSlotsToDB } from './save-state.js';
import { QUESTS, QUEST_ACTIVE, QUEST_DONE } from './data/quests.js';

// ── state ─────────────────────────────────────────────────────────────────
function _entry(id) {
  if (!ps.quests || typeof ps.quests !== 'object') return null;
  const e = ps.quests[id];
  return e && typeof e === 'object' ? e : null;
}

/** True once the objective count is met. */
function _objectiveMet(quest, entry) {
  return !!entry && (entry.n | 0) >= (quest.objective.count | 0);
}

/**
 * Fill the progress tokens a page may carry. Returns a NEW array — the caller
 * must not compare the result against `quest.active` by identity.
 *
 *   {n}      objectives done      {count}  objectives needed
 *   {left}   still to go
 */
function _fill(pages, quest, entry) {
  if (!pages) return pages;
  const total = quest.objective ? (quest.objective.count | 0) : 0;
  const done  = Math.min(total, entry ? (entry.n | 0) : 0);
  return pages.map(p => String(p)
    .replace(/\{n\}/g, String(done))
    .replace(/\{count\}/g, String(total))
    .replace(/\{left\}/g, String(Math.max(0, total - done))));
}

// Quest state is durable-or-exploitable, never "nice to have". See the header.
function _persist() {
  try { saveSlotsToDB(); } catch (_) { /* pre-boot / headless harness */ }
}

// Talk priority. A giver may hold several quests over the life of a save, and
// the finished ones must not shadow the live one — pre-v1.8.6 `talkQuest`
// returned on the FIRST matching quest, so the first quest's `done` pages
// answered forever and a second quest from the same NPC was unreachable.
const _RANK_HANDIN = 0;   // objective met, waiting to be handed in
const _RANK_ACTIVE = 1;   // taken, still running
const _RANK_OFFER  = 2;   // not taken, offers on sight (no startWord)
const _RANK_DONE   = 3;   // finished — only if nothing above matched

/**
 * Talking to a quest giver. Returns the pages to show and advances the quest,
 * or null when this NPC has nothing quest-related to say (caller then falls
 * back to the NPC's ordinary idle dialogue).
 */
export function talkQuest(mapId, npcKey, grantReward) {
  let best = null, bestRank = Infinity;
  for (const quest of Object.values(QUESTS)) {
    if (quest.giver.mapId !== mapId || quest.giver.npcKey !== npcKey) continue;
    const e = _entry(quest.id);
    let rank;
    if (!e) {
      // Word-gated quests stay shut until the player ASKs about the start
      // term (see askQuestWord) — they are not candidates for plain talk at
      // all, so they neither answer nor block.
      if (quest.startWord) continue;
      rank = _RANK_OFFER;
    } else if (e.s === QUEST_DONE) rank = _RANK_DONE;
    else rank = _objectiveMet(quest, e) ? _RANK_HANDIN : _RANK_ACTIVE;
    if (rank < bestRank) { best = quest; bestRank = rank; }
  }
  if (!best) return null;

  if (!ps.quests || typeof ps.quests !== 'object') ps.quests = {};
  const e = _entry(best.id);

  if (bestRank === _RANK_OFFER) {
    ps.quests[best.id] = { s: QUEST_ACTIVE, n: 0 };
    _persist();
    return _fill(best.offer, best, ps.quests[best.id]);
  }
  if (bestRank === _RANK_DONE) return _fill(best.done, best, e);
  if (bestRank === _RANK_HANDIN) {
    e.s = QUEST_DONE;
    _persist();                                   // BEFORE the payout, not after
    if (typeof grantReward === 'function') grantReward(best.reward, best.id);
    return _fill(best.complete, best, e);
  }
  return _fill(best.active, best, e);
}

/**
 * The player asked this NPC about `wordId`. Returns the quest's offer when
 * that is the start term of an untaken quest they give, else null — the caller
 * then falls back to the NPC's ordinary answer for the word.
 *
 * Nothing is written here: the offer is a question, and `acceptQuest` is what
 * actually starts it.
 */
export function askQuestWord(mapId, npcKey, wordId) {
  for (const quest of Object.values(QUESTS)) {
    if (quest.giver.mapId !== mapId || quest.giver.npcKey !== npcKey) continue;
    if (quest.startWord !== wordId) continue;
    if (_entry(quest.id)) continue;                 // already offered and taken
    return {
      id: quest.id,
      pages: _fill(quest.offer, quest, null),
      accepted: _fill(quest.accepted, quest, null),
      denied: _fill(quest.denied, quest, null),
    };
  }
  return null;
}

/** Take the quest that askQuestWord offered. */
export function acceptQuest(id) {
  const quest = QUESTS[id];
  if (!quest) return false;
  if (!ps.quests || typeof ps.quests !== 'object') ps.quests = {};
  if (ps.quests[id]) return false;
  ps.quests[id] = { s: QUEST_ACTIVE, n: 0 };
  _persist();
  return true;
}

/**
 * Put a hand-in back. The client flips a quest to DONE and credits the reward
 * optimistically; if the server then refuses to pay (`quest-result` rejected,
 * see npc.js) the quest must go back to waiting-to-hand-in — objective still
 * met — so the player can walk up and try again. Without this a refused claim
 * leaves a finished quest that was never paid for.
 *
 * No-op on a quest that isn't done, so a stray reject can't un-finish a quest
 * the player is in the middle of.
 */
export function revertQuestHandIn(id) {
  const quest = QUESTS[id];
  const e = _entry(id);
  if (!quest || !e || e.s !== QUEST_DONE) return false;
  e.s = QUEST_ACTIVE;
  e.n = quest.objective ? (quest.objective.count | 0) : (e.n | 0);
  _persist();
  return true;
}

/**
 * An encounter was won in `zoneKey`. Advances every active quest whose
 * objective matches. Counting client-side is fine because the REWARD is what
 * matters, and that is granted through the server-validated `quest-claim`
 * channel; the count only decides what the giver says. No save here — the
 * battle-end path calls saveSlotsToDB a few frames later (battle-update.js),
 * and an IndexedDB write per kill mid-encounter buys nothing.
 */
export function noteEncounterVictory(zoneKey) {
  if (!zoneKey || !ps.quests || typeof ps.quests !== 'object') return;
  for (const quest of Object.values(QUESTS)) {
    const e = _entry(quest.id);
    if (!e || e.s !== QUEST_ACTIVE) continue;
    const obj = quest.objective;
    if (obj.kind !== 'defeat') continue;
    if (!String(zoneKey).startsWith(obj.zonePrefix)) continue;
    if ((e.n | 0) >= obj.count) continue;
    e.n = (e.n | 0) + 1;
  }
}

/** Sanitise a `quests` blob loaded from a save or pushed by the server. */
export function sanitizeQuests(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, v] of Object.entries(raw)) {
    const quest = QUESTS[id];
    if (!quest || !v || typeof v !== 'object') continue;   // unknown id -> drop
    const s = v.s === QUEST_DONE ? QUEST_DONE : QUEST_ACTIVE;
    const n = Math.max(0, Math.min(quest.objective.count | 0, v.n | 0));
    out[id] = { s, n };
  }
  return out;
}
