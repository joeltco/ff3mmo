// Speech resolution — the ONE place that decides what a person says.
//
// ⛔ THIS ORDER USED TO LIVE IN TWENTY LINES OF `npc.js#talkToNpc`, and every
// tool that wanted to know what a player would read re-derived it. Three did,
// and they drifted: two of them re-implemented `_fill` (the `{n}`/`{count}`
// token substitution) and one modelled quest pages as outranking idle dialogue
// without modelling that a FINISHED quest outranks it forever — which is the
// bug that made Cid's post-curse line unreachable on every save.
//
// Three systems speak to the player and nothing owned the arbitration between
// them:
//
//   quests        src/quests.js          offers, nags, hand-ins, asides
//   idle lines    src/data/dialogue.js   flag-keyed variants on the NPC row
//   word memory   src/word-memory.js     ASK/LEARN answers (a separate verb,
//                                        reached AFTER the pages are shown)
//
// Now they are layers, highest first, and this is the only file that says so:
//
//   1. notice   a pending server-reject explanation. The player is owed a
//               reason before the hand-in is offered again.
//   2. advance  a live quest beat this NPC completes.
//   3. waiting  a live quest beat this NPC owns, not yet met.
//   4. offer    an unguarded quest this NPC offers on sight.
//   5. aside    a live quest that names this NPC somewhere else.
//   6. after    a finished quest's parting line.
//   7. idle     the NPC's own lines, resolved against the story flags.
//
// ⛔ LAYERS 2-6 ARE RANKED INSIDE `quests.js#resolveTalk`, not here — a
// finished quest must never shadow a live one, and that rule belongs with the
// quest state machine. This file owns only the boundaries BETWEEN systems.
//
// ── PURE BY CONSTRUCTION ──────────────────────────────────────────────────
//
// `resolveSpeech` writes nothing. When acting would change something it hands
// back an `apply` function instead of calling it, so a gate can ask "what does
// the King say at this stage" ten thousand times without paying a reward or
// advancing a save. `npc.js` is the only caller that invokes `apply`.

import { resolveTalk, applyTalk, talkMutates } from './quests.js';
import { resolvePages } from './data/dialogue.js';
import { hasFlag } from './story-flags.js';

/**
 * What this person says right now, and what pressing Z would do.
 *
 * @param mapId   the map they are standing on
 * @param npcKey  their identity — NOT their costume. Two states of one person
 *                share a key (Cid cursed and Cid himself); `when` on the
 *                placement row picks which is in the room.
 * @param who     the NPC record or spec — read for `.dialogue` only
 * @param opts    { notice } pages owed to the player before anything else
 *
 * @returns {{ source, pages, quest, stage, apply }|null}
 *          `apply(grantReward)` performs the mutation and returns the final
 *          pages; it is null when talking changes nothing. null overall means
 *          this person has genuinely nothing to say.
 */
export function resolveSpeech(mapId, npcKey, who, opts = {}) {
  // 1. A refused claim is owed an explanation before anything else happens.
  if (opts.notice && opts.notice.length) {
    return { source: 'notice', pages: opts.notice, quest: null, stage: null, apply: null };
  }

  // 2-6. Whatever the quest system has to say, already ranked and token-filled.
  //      ⛔ Keyless NPCs are skipped: `resolveTalk` matches on npcKey, and a
  //      null key would match a quest stage whose `at.npc` is also null.
  const r = npcKey ? resolveTalk(mapId, npcKey) : null;
  if (r && r.pages && r.pages.length) {
    return {
      source: r.intent,
      pages: r.pages,
      quest: r.quest,
      stage: r.stage,
      // Only offers and hand-ins mutate. A nag or an aside is just a line.
      apply: talkMutates(r) ? (grantReward) => applyTalk(r, grantReward) : null,
    };
  }

  // 7. Their own lines. A variant list whose every entry is guarded and none
  //    hold resolves to null — an authoring mistake — and we stay silent rather
  //    than render `undefined`.
  const idle = resolvePages(who && who.dialogue, hasFlag);
  if (!idle || !idle.length) return null;
  return { source: 'idle', pages: idle, quest: null, stage: null, apply: null };
}

/**
 * The same question, guaranteed side-effect free even for layers that mutate.
 * Gates and transcript tools use this so they cannot accidentally advance a
 * quest by asking about it.
 */
export function previewSpeech(mapId, npcKey, who, opts = {}) {
  const s = resolveSpeech(mapId, npcKey, who, opts);
  return s ? { ...s, apply: null, mutates: !!s.apply } : null;
}
