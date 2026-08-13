#!/usr/bin/env node
// check-quests.mjs — drive the quest state machine end to end.
//
// The loop is: no entry -> ASK the giver the start word (accept) -> fight ->
// objective met -> talk (hand in, reward) -> finished. Acceptance moved onto
// the FF2-style word menu in v1.7.980; plain talk no longer starts anything. Each step has a marker colour derived from
// state, and the whole thing has to survive a save round-trip. This asserts all
// of it headlessly, because the alternative is walking to Ur in a browser every
// time a line of it changes.
//
//   node tools/check-quests.mjs

import { createCanvas } from '@napi-rs/canvas';
import fs from 'node:fs';

globalThis.document = { createElement: (t) => (t === 'canvas' ? createCanvas(1, 1) : {}) };

const { ps } = await import('../src/player-stats.js');
const { QUESTS } = await import('../src/data/quests.js');
const q = await import('../src/quests.js');

let failed = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { console.error(`  ✗ ${m}`); failed++; };
const is = (got, want, what) =>
  got === want ? ok(`${what}: ${JSON.stringify(got)}`)
               : bad(`${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

const QID = 'ur_missing_brother';
const quest = QUESTS[QID];
if (!quest) { console.error('quest ur_missing_brother missing'); process.exit(1); }
const { mapId, npcKey } = quest.giver;

// ── the loop ──────────────────────────────────────────────────────────────
ps.quests = {};

let rewarded = null;
// Word-gated: he has nothing to say until you bring him the term, so talkQuest
// returns null and the caller falls back to his idle lines.
is(q.talkQuest(mapId, npcKey, () => { bad('accepted on plain talk!'); }), null,
   'talking without the start word returns no quest pages');
is(ps.quests[QID] === undefined, true, 'plain talk does NOT start the quest');

const offer = q.askQuestWord(mapId, npcKey, quest.startWord);
is(offer && offer.pages === quest.offer, true, 'asking about the start word returns the OFFER pages');
is(ps.quests[QID] === undefined, true, 'the offer alone does not start the quest');
is(q.acceptQuest(QID), true, 'ACCEPT starts it');
is(ps.quests[QID].s, 'active', 'quest is now active');
is(q.acceptQuest(QID), false, 'ACCEPT twice is a no-op');
is(q.askQuestWord(mapId, npcKey, quest.startWord), null, 'the offer does not come back once taken');
is(q.askQuestWord(mapId, npcKey, 'cave'), null, 'a different word does not open the offer');
is(rewarded, null, 'no reward on accept');

// Wrong zone must not count.
q.noteEncounterVictory('grasslands_wild');
is(ps.quests[QID].n, 0, 'a win outside the Altar Cave does not count');

q.noteEncounterVictory('altar_cave_f1');
q.noteEncounterVictory('altar_cave_f2');
is(ps.quests[QID].n, 2, 'two Altar Cave wins counted');

const pagesMid = q.talkQuest(mapId, npcKey, () => { bad('rewarded early!'); });
is(pagesMid === quest.active, true, 'talking mid-quest returns the ACTIVE nag, not the reward');

q.noteEncounterVictory('altar_cave_boss');
is(ps.quests[QID].n, 3, 'third win counted');

q.noteEncounterVictory('altar_cave_f1');
is(ps.quests[QID].n, 3, 'count does not overshoot the objective');

const pages2 = q.talkQuest(mapId, npcKey, (r) => { rewarded = r; });
is(pages2 === quest.complete, true, 'handing in returns the COMPLETE pages');
is(rewarded && rewarded.gil, quest.reward.gil, 'reward gil paid out');
is(ps.quests[QID].s, 'done', 'quest is done');

rewarded = null;
const pages3 = q.talkQuest(mapId, npcKey, (r) => { rewarded = r; });
is(pages3 === quest.done, true, 'talking again returns the DONE pages');
is(rewarded, null, 'reward is NOT paid twice');

// ── persistence ───────────────────────────────────────────────────────────
const round = q.sanitizeQuests(JSON.parse(JSON.stringify(ps.quests)));
is(round[QID].s, 'done', 'state survives a save round-trip');
is(Object.keys(q.sanitizeQuests({ not_a_quest: { s: 'done', n: 5 } })).length, 0,
   'an unknown quest id is dropped on load');
is(q.sanitizeQuests({ [QID]: { s: 'active', n: 9999 } })[QID].n, quest.objective.count,
   'a hand-edited count is clamped to the objective');
is(q.sanitizeQuests({ [QID]: { s: 'nonsense', n: -5 } })[QID].n, 0,
   'a negative count is clamped to 0');

// ── the marker is GONE ────────────────────────────────────────────────────
// v1.7.990 removed the overhead bubble; Word Memory carries the signposting.
// Asserted so it cannot creep back in as "just a small indicator" — the whole
// point of the FF2 system is that you find people by talking, not by following
// a marker.
{
  const src = fs.readFileSync(new URL('../src/npc.js', import.meta.url), 'utf8');
  if (/questMarkerState|getMarkerFrames|QUEST_MARKER/.test(src)) {
    bad('npc.js still draws a quest marker — the bubble was removed on purpose');
  } else ok('no overhead quest marker is drawn');
  for (const name of ['questMarkerState', 'getMarkerFrames', 'initQuestMarker']) {
    if (q[name]) bad(`quests.js still exports ${name}`);
  }
  ok('quests.js exports no marker API');
}

// ── the SERVER keeps it too ───────────────────────────────────────────────
// The save-whitelist lockstep rule: a ps.* field added to the client
// serializer but not to api.js's validator is silently dropped on the next
// server round-trip, and the player loses their progress on login.
const { _testValidateSaveData } = await import('../api.js');
const v = _testValidateSaveData({ quests: { [QID]: { s: 'done', n: 3 } }, words: { brother: 1 } });
if (v && v.ok && v.data && v.data.words && v.data.words.brother === 1) {
  ok('server whitelist keeps words: learned terms survive login');
} else {
  bad('server whitelist DROPPED words — the ASK list would empty on login');
}
if (v && v.ok && v.data && v.data.quests && v.data.quests[QID]) {
  ok(`server whitelist keeps quests: ${JSON.stringify(v.data.quests[QID])}`);
} else {
  bad('server whitelist DROPPED quests — progress would reset on login');
}
const vBad = _testValidateSaveData({ quests: { [QID]: { s: 'hax', n: 999999 } } });
const e = vBad && vBad.ok && vBad.data.quests && vBad.data.quests[QID];
if (e && e.s === 'active' && e.n === 9999) ok('server clamps a forged quest entry');
else bad(`server did not clamp a forged entry: ${JSON.stringify(e)}`);

if (failed) { console.error(`\ncheck-quests: FAIL (${failed})`); process.exit(1); }
console.log('\ncheck-quests: OK');
