// Quest runtime — stage state and the talk handler.
//
// State lives in `ps.quests[id] = { s, n }` — the STAGE id the player is on and
// that stage's objective count — and nothing more; the static half is in
// data/quests.js so the server has a fixed table to check claims against.
// Persisted through BOTH the client serializer (save-state.js) and the server
// validator (api.js): a `ps.*` field added to only one of those silently
// vanishes on the next login.
//
// There is NO overhead marker. v1.7.990 removed it and v1.7.991 deleted the
// sprite data with it: the Word Memory system carries the signposting now, the
// FF2 way — you find out who matters by talking to people and carrying their
// words, not by following a bubble. Progress rides the same channel: the pages
// carry `{n}` / `{count}` / `{left}` and the speaker reads the number out.
//
// ⛔ EVERY state transition here calls saveSlotsToDB. The reward is durable the
// instant it is granted (gil goes to the server mirror, which writes SQLite),
// so an unsaved final stage is not a lost flag — it is a repeatable payout. The
// v1.8.6 audit reproduced 900 gil from one save by handing in three times, and
// it needed no modding: on iOS `beforeunload` never fires, so closing the tab
// after a hand-in was the whole exploit. The server-side claim ledger
// (economy-arbiter.js#validateQuestClaim) is the second lock on the same door.
//
// ── WHAT REPLACED THE SORT RANKS ─────────────────────────────────────────
//
// The old `talkQuest` expressed the lifecycle as four `_RANK_*` constants, sorted
// the candidates, then mutated, persisted and paid out inside the same function.
// The states were not written down anywhere — they were inferred from which rank
// won. `resolveTalk` below returns a described intent (`advance` / `waiting` /
// `offer` / `aside` / `after`) and `talkQuest` acts on it, so the machine can be
// read, and tested, without running a payout.

import { ps } from './player-stats.js';
import { saveSlotsToDB } from './save-state.js';
import { setFlag, clearFlag } from './story-flags.js';
import { QUESTS, QUEST_DONE, stageById, stageIndex, firstStage, maxObjectiveCount,
         isLegalStage } from './data/quests.js';
// ⛔ PROSE COMES FROM HERE, NOT FROM THE QUEST RECORD. `data/quests.js` is
// imported by the SERVER (api.js, economy-arbiter.js) and now carries no
// English at all; every page a quest makes somebody say lives in
// `data/script.js`, which the server never touches. Gate:
// `tools/check-script-split.mjs`.
import { stagePages, asidePages } from './data/script.js';
import { objectiveCount, objectiveMatches, isTalkObjective } from './quest-objectives.js';

// ── state ─────────────────────────────────────────────────────────────────
function _entry(id) {
  if (!ps.quests || typeof ps.quests !== 'object') return null;
  const e = ps.quests[id];
  return e && typeof e === 'object' ? e : null;
}

function _bag() {
  if (!ps.quests || typeof ps.quests !== 'object') ps.quests = {};
  return ps.quests;
}

/** The stage a player is currently on, or null if untaken/finished. */
function _currentStage(quest, entry) {
  if (!entry || entry.s === QUEST_DONE) return null;
  return stageById(quest, entry.s);
}

/** True once this stage's objective count is met (or it has no counter). */
function _stageMet(stage, entry) {
  if (!stage) return false;
  if (isTalkObjective(stage.objective)) return true;   // talking is the objective
  return (entry.n | 0) >= objectiveCount(stage.objective);
}

/**
 * Fill the progress tokens a page may carry. Returns a NEW array — the caller
 * must not compare the result against the source pages by identity.
 *
 *   {n}      objectives done      {count}  objectives needed
 *   {left}   still to go
 */
function _fill(pages, stage, entry) {
  if (!pages) return pages;
  const total = stage && stage.objective ? objectiveCount(stage.objective) : 0;
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

const _at = (stage, mapId, npcKey) =>
  !!stage && !!stage.at && stage.at.map === mapId && stage.at.npc === npcKey;

// ── talk resolution ───────────────────────────────────────────────────────
//
// Priority when several quests have something to say at the same NPC. A finished
// quest must never shadow a live one — pre-v1.8.6 `talkQuest` returned on the
// FIRST matching quest, so the first quest's `done` pages answered forever and a
// second quest from the same giver was unreachable.
// ⛔ THERE IS NO `after` RANK ANY MORE. A finished quest used to contribute an
// `after` candidate that outranked the NPC's own dialogue for the rest of the
// save — which made endgame idle variants unreachable (measured: 2 of them, in
// all 384 world states). A finished quest now contributes NOTHING, and the
// parting line is a flag-guarded variant on the person's own row. See
// data/script.js's header.
const _RANK = { advance: 0, waiting: 1, offer: 2, aside: 3 };

/**
 * What does this NPC have to say about quests right now, and what would talking
 * to them do? Pure — reads state, writes nothing. `applyTalk` is the half that
 * acts.
 *
 * ⭐ PAGES COME BACK TOKEN-FILLED. They used to be raw, with `talkQuest` doing
 * the `{n}`/`{count}`/`{left}` substitution on the way out — which meant every
 * tool that wanted to know what a player would READ had to re-implement `_fill`.
 * Three of them did. Filling here makes "what does this say" one question with
 * one answer.
 *
 * ⛔ The fill happens at RESOLVE time, before any mutation, which is the state
 * the numbers must describe: "2 of 3 cleared" is the count as the player walks
 * up, not after the stage advances.
 *
 * Returns `{ intent, quest, stage, pages }` or null.
 */
export function resolveTalk(mapId, npcKey) {
  let best = null;
  for (const quest of Object.values(QUESTS)) {
    const entry = _entry(quest.id);
    let cand = null;

    if (!entry) {
      // Word-gated quests stay shut until the player ASKs about the start term
      // (see askQuestWord) — they are not candidates for plain talk at all, so
      // they neither answer nor block.
      const s0 = firstStage(quest);
      if (!quest.startWord && _at(s0, mapId, npcKey)) {
        cand = { intent: 'offer', quest, stage: s0, pages: stagePages(quest.id, s0.id, 'offer') };
      }
    } else if (entry.s === QUEST_DONE) {
      // Finished. It has nothing further to say; the world does — through the
      // flag its last stage set, read by this person's own dialogue variants.
      cand = null;
    } else {
      const stage = _currentStage(quest, entry);
      if (stage && _at(stage, mapId, npcKey)) {
        cand = _stageMet(stage, entry)
          ? { intent: 'advance', quest, stage, pages: stagePages(quest.id, stage.id, 'onAdvance') }
          : { intent: 'waiting', quest, stage, pages: stagePages(quest.id, stage.id, 'say') };
      } else if (stage && asidePages(quest.id, stage.id, npcKey)) {
        // ⭐ The quest's OTHER people, mid-stage. Walking back to the King while
        // you are still looking for his daughter should not be silence.
        cand = { intent: 'aside', quest, stage, pages: asidePages(quest.id, stage.id, npcKey) };
      }
    }

    if (cand && cand.pages) {
      cand.pages = _fill(cand.pages, cand.stage, entry);
      if (!best || _RANK[cand.intent] < _RANK[best.intent]) best = cand;
    }
  }
  return best;
}

/**
 * ACT on an already-resolved talk. Returns the pages to show, or null when a
 * grant was refused and the beat must not happen.
 *
 * ⭐ SPLIT OUT OF `talkQuest` so the decision and the mutation are separable.
 * `speech.js` needs to know what an NPC would say — and what pressing Z would
 * DO — without doing it, because the gates and the transcript tools ask exactly
 * that question and must never pay a reward to answer it.
 *
 * Only `offer` and `advance` change anything; `waiting` / `aside` / `after`
 * say their line and leave.
 */
export function applyTalk(r, grantReward) {
  if (!r) return null;
  if (r.intent === 'offer') {
    // An unguarded quest offers on sight, and taking it is the offer itself.
    _startQuest(r.quest);
    return r.pages;
  }
  if (r.intent === 'advance') return _advance(r.quest, r.stage, grantReward);
  return r.pages;
}

/** Does acting on this talk mutate anything? `speech.js` reads this. */
export function talkMutates(r) {
  return !!r && (r.intent === 'offer' || r.intent === 'advance');
}

/**
 * Talking to somebody a quest cares about. Returns the pages to show and
 * advances the quest, or null when this NPC has nothing quest-related to say
 * (caller then falls back to the NPC's ordinary idle dialogue).
 */
export function talkQuest(mapId, npcKey, grantReward) {
  return applyTalk(resolveTalk(mapId, npcKey), grantReward);
}

/** Put a player onto a quest's SECOND stage — stage 0 is the offer itself. */
function _startQuest(quest) {
  const next = (quest.stages || [])[1];
  _bag()[quest.id] = next ? { s: next.id, n: 0 } : { s: QUEST_DONE, n: 0 };
  _persist();
}

/**
 * Finish the current stage and move on. When it was the LAST stage the quest is
 * done and the reward is paid.
 *
 * ⛔ Flags are set BEFORE the stage moves, and the save happens BEFORE the
 * payout — the same ordering the pre-stage code used, for the same reason.
 */
function _advance(quest, stage, grantReward) {
  const entry = _entry(quest.id);
  // Already token-filled by `resolveTalk`, at the pre-advance count.
  const pages = _fill(stagePages(quest.id, stage.id, 'onAdvance'), stage, entry);

  // ⭐ A STAGE MAY HAND SOMETHING OVER — the King's canoe, four stages before
  // the quest closes. Granted BEFORE the stage moves and before any flag is
  // set, because a full bag has to be able to stop the whole beat: advance
  // first and the player has walked past the one chance to be given it.
  //
  // ⛔ THROUGH THE SAME VALIDATED CLAIM THE REWARD USES, keyed per stage
  // (`questId#stageId` in `quest_claims`). A bare `addItem` here would be an
  // unvalidated bag add under `SERVER_ECONOMY`, and the mirror's next push
  // would take it straight back — the player watches the item vanish.
  if (stage.item && typeof grantReward === 'function') {
    if (grantReward({ item: stage.item }, quest.id, stage.id) === false) return null;
  }

  for (const flag of stage.sets || []) {
    if (setFlag(flag)) _noteEvent('flag-set', flag);
  }

  // ⭐ A STAGE MAY PARK A CRAFT, not just the finished quest.
  //
  // Joel, 2026-08-27: *"the king should have a quest to go find sara where we
  // receive the canoe to go there."* The canoe used to be the quest's REWARD, so
  // it arrived only after Sara was found — which is why she could not be in the
  // Sealed Cave the canoe exists to reach. The craft has to arrive mid-chain,
  // at the beat that tells you where she went.
  if (stage.vehicle) _parkCraft(stage.vehicle);

  const idx = stageIndex(quest, stage.id);
  const next = (quest.stages || [])[idx + 1];
  if (next) {
    entry.s = next.id;
    entry.n = 0;
    _persist();
    return pages;
  }

  entry.s = QUEST_DONE;
  _persist();                                   // BEFORE the payout, not after
  if (typeof grantReward === 'function') grantReward(quest.reward, quest.id);
  _grantVehicle(quest);
  return pages;
}

/**
 * Park a quest's craft on the world map.
 *
 * ⛔ PARKED, NOT BOARDED. Boarding is by POSITION (`movement.js`), so leaving
 * the craft in the sand makes the player walk out and climb in — that is the
 * sequence. Dropping them aboard on the spot skips it and, worse, puts a flying
 * craft under a player standing in a town interior.
 *
 * Idempotent by quest state: `_advance` only reaches the final branch once, and
 * a REFUSED server claim calls `revertQuestHandIn`, which puts the quest back to
 * its last stage — so the craft can be re-granted on the retry rather than being
 * lost. Re-parking an already-parked craft is harmless.
 */
function _grantVehicle(quest) {
  _parkCraft(quest.reward && quest.reward.vehicle);
}

/**
 * Park one craft. Shared by the quest reward and by `stage.vehicle`, so a
 * mid-chain grant behaves identically to an end-of-quest one — including the
 * "already aboard" guard and the idempotency `_advance` relies on.
 */
function _parkCraft(g) {
  if (!g) return;
  // Already aboard it — do not yank it out from under the player.
  if ((ps.vehicle | 0) === (g.mode | 0)) return;
  ps.vehicleParked = 1;
  ps.vehicleParkedMode = g.mode | 0;
  ps.vehicleParkedX = g.x | 0;
  ps.vehicleParkedY = g.y | 0;
  _persist();
}

/**
 * The player asked this NPC about `wordId`. Returns the quest's offer when that
 * is the start term of an untaken quest whose FIRST stage is this NPC, else null
 * — the caller then falls back to the NPC's ordinary answer for the word.
 *
 * Nothing is written here: the offer is a question, and `acceptQuest` is what
 * actually starts it.
 */
export function askQuestWord(mapId, npcKey, wordId) {
  for (const quest of Object.values(QUESTS)) {
    if (quest.startWord !== wordId) continue;
    if (_entry(quest.id)) continue;                 // already offered and taken
    const s0 = firstStage(quest);
    if (!_at(s0, mapId, npcKey)) continue;
    return {
      id: quest.id,
      pages:    _fill(stagePages(quest.id, s0.id, 'offer'), s0, null),
      accepted: _fill(stagePages(quest.id, s0.id, 'accepted'), s0, null),
      denied:   _fill(stagePages(quest.id, s0.id, 'denied'), s0, null),
    };
  }
  return null;
}

/** Take the quest that askQuestWord offered. */
export function acceptQuest(id) {
  const quest = QUESTS[id];
  if (!quest) return false;
  if (_entry(id)) return false;
  _startQuest(quest);
  return true;
}

/**
 * Put a hand-in back. The client finishes a quest and credits the reward
 * optimistically; if the server then refuses to pay (`quest-result` rejected,
 * see npc.js) the quest must go back to its LAST stage — objective still met —
 * so the player can walk up and try again. Without this a refused claim leaves a
 * finished quest that was never paid for.
 *
 * ⛔ FLAGS SET BY THE FINAL STAGE ARE ROLLED BACK TOO. A refused claim that left
 * `curse_lifted` standing would leave two towns permanently un-cursed for a
 * quest the player was never paid for — the world would have moved on without
 * the errand.
 *
 * No-op on a quest that isn't done, so a stray reject can't un-finish a quest
 * the player is in the middle of.
 */
export function revertQuestHandIn(id) {
  const quest = QUESTS[id];
  const e = _entry(id);
  if (!quest || !e || e.s !== QUEST_DONE) return false;
  const last = (quest.stages || [])[(quest.stages || []).length - 1];
  if (!last) return false;
  for (const flag of last.sets || []) clearFlag(flag);
  e.s = last.id;
  e.n = last.objective ? objectiveCount(last.objective) : 0;
  _persist();
  return true;
}

// ── objective events ──────────────────────────────────────────────────────

/**
 * Something happened. Advances every live stage whose objective matches.
 *
 * ⛔ GENERIC BY DESIGN. The old runtime hard-coded `if (obj.kind !== 'defeat')
 * continue;` here, which is the whole reason every quest in the game was the
 * same errand — a second kind had nowhere to land. Kinds live in
 * quest-objectives.js and this function knows none of them by name.
 *
 * Counting client-side is fine because the REWARD is what matters, and that is
 * granted through the server-validated `quest-claim` channel; the count only
 * decides what the speaker says.
 */
function _noteEvent(event, payload) {
  if (!ps.quests || typeof ps.quests !== 'object') return;
  for (const quest of Object.values(QUESTS)) {
    const e = _entry(quest.id);
    if (!e || e.s === QUEST_DONE) continue;
    const stage = _currentStage(quest, e);
    if (!stage || !stage.objective) continue;
    if (!objectiveMatches(stage.objective, event, payload)) continue;
    const need = objectiveCount(stage.objective);
    if ((e.n | 0) >= need) continue;
    e.n = (e.n | 0) + 1;
  }
}

/**
 * An encounter was won in `zoneKey`. No save here — the battle-end path calls
 * saveSlotsToDB a few frames later (battle-update.js), and an IndexedDB write
 * per kill mid-encounter buys nothing.
 */
export function noteEncounterVictory(zoneKey) {
  if (!zoneKey) return;
  _noteEvent('encounter-victory', zoneKey);
}

/** A boss was beaten. `bossId` is the monster id — Djinn is 0xCD. */
export function noteBossDefeated(bossId) {
  if (bossId == null) return;
  _noteEvent('boss-defeated', bossId | 0);
}

/** Sanitise a `quests` blob loaded from a save or pushed by the server. */
export function sanitizeQuests(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, v] of Object.entries(raw)) {
    const quest = QUESTS[id];
    if (!quest || !v || typeof v !== 'object') continue;   // unknown id -> drop
    // ⛔ An unknown STAGE is dropped, not coerced. Coercing it to stage 0 would
    // silently restart a finished quest; coercing it to done would hand the
    // player a finished quest they never ran. A stage that no longer exists
    // means the quest was rewritten under the save, and the honest answer is
    // that this player has not taken it.
    if (!isLegalStage(quest, v.s)) continue;
    const n = Math.max(0, Math.min(maxObjectiveCount(quest), v.n | 0));
    out[id] = { s: v.s, n };
  }
  return out;
}
