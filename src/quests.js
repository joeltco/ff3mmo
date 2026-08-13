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
// words, not by following a bubble.

import { ps } from './player-stats.js';
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
 * Talking to a quest giver. Returns the pages to show and advances the quest,
 * or null when this NPC has nothing quest-related to say (caller then falls
 * back to the NPC's ordinary idle dialogue).
 */
export function talkQuest(mapId, npcKey, grantReward) {
  for (const quest of Object.values(QUESTS)) {
    if (quest.giver.mapId !== mapId || quest.giver.npcKey !== npcKey) continue;
    if (!ps.quests || typeof ps.quests !== 'object') ps.quests = {};
    const e = _entry(quest.id);

    if (!e) {
      // Word-gated quests stay shut until the player ASKs about the start
      // term (see askQuestWord). Returning null drops the caller back to the
      // giver's ordinary idle dialogue — which is where the ASK menu opens.
      if (quest.startWord) return null;
      ps.quests[quest.id] = { s: QUEST_ACTIVE, n: 0 };
      return quest.offer;
    }
    if (e.s === QUEST_DONE) return quest.done;
    if (_objectiveMet(quest, e)) {
      e.s = QUEST_DONE;
      if (typeof grantReward === 'function') grantReward(quest.reward);
      return quest.complete;
    }
    return quest.active;
  }
  return null;
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
    return { id: quest.id, pages: quest.offer, accepted: quest.accepted, denied: quest.denied };
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
  return true;
}

/**
 * An encounter was won in `zoneKey`. Advances every active quest whose
 * objective matches. Counting client-side is fine because the REWARD is what
 * matters, and that is granted through the same path the server already
 * validates; the count only decides which colour the bubble is.
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
