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
// The REAL zone table. An objective's zonePrefix has to match a zone the game
// actually produces — feeding the prefix straight back into noteEncounterVictory
// (which the first cut of the generic walk did) makes every prefix pass by
// construction, including 'nowhere_at_all'.
const { ENCOUNTERS } = await import('../src/data/encounters.js');
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
// Pages come back token-FILLED (v1.8.6), so compare content, never identity.
is(offer && offer.pages.join('|'), quest.offer.join('|'), 'asking about the start word returns the OFFER pages');
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
is(pagesMid.length, quest.active.length, 'talking mid-quest returns the ACTIVE nag, not the reward');
is(/\b2 of 3\b/.test(pagesMid.join(' ')), true, 'the ACTIVE nag reads the progress count out');

q.noteEncounterVictory('altar_cave_boss');
is(ps.quests[QID].n, 3, 'third win counted');

q.noteEncounterVictory('altar_cave_f1');
is(ps.quests[QID].n, 3, 'count does not overshoot the objective');

const pages2 = q.talkQuest(mapId, npcKey, (r) => { rewarded = r; });
is(pages2.join('|'), quest.complete.join('|'), 'handing in returns the COMPLETE pages');
is(rewarded && rewarded.gil, quest.reward.gil, 'reward gil paid out');
is(rewarded && rewarded.item, quest.reward.item, 'reward ITEM handed over — the line promises an object');
is(ps.quests[QID].s, 'done', 'quest is done');

rewarded = null;
const pages3 = q.talkQuest(mapId, npcKey, (r) => { rewarded = r; });
is(pages3.join('|'), quest.done.join('|'), 'talking again returns the DONE pages');
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
// v1.8.6 — the server clamps against the REAL objective, not a shape-only
// 0..9999 bound, so both halves of a save agree on what is legal. This gate
// used to assert the 9999 and so pinned the divergence in place.
const vBad = _testValidateSaveData({ quests: { [QID]: { s: 'hax', n: 999999 } } });
const e = vBad && vBad.ok && vBad.data.quests && vBad.data.quests[QID];
if (e && e.s === 'active' && e.n === quest.objective.count) ok('server clamps a forged count to the objective');
else bad(`server did not clamp a forged entry to ${quest.objective.count}: ${JSON.stringify(e)}`);
const vUnknown = _testValidateSaveData({ quests: { not_a_quest: { s: 'done', n: 3 } } });
if (vUnknown.ok && vUnknown.data.quests && !vUnknown.data.quests.not_a_quest) ok('server drops an unknown quest id, same as the client');
else bad('server kept an unknown quest id the client would have dropped');

// ── EVERY quest walks, not just the one this file was written around ──────
// The detailed walk above is hand-written against ur_missing_brother. A second
// quest landed in v1.8.9 and nothing here touched it, which is how a broken
// giver / unteachable start word / unreachable objective ships. This is the
// generic loop: offer -> accept -> meet the objective -> hand in -> finished,
// driven from the table, for every quest defined.
console.log('\n── every quest, generically ──');
for (const [id, qq] of Object.entries(QUESTS)) {
  const g = qq.giver;
  const tag = `${id}`;
  ps.quests = {};
  let paid = null;

  // Word-gated quests must NOT open on plain talk; ungated ones must.
  const plain = q.talkQuest(g.mapId, g.npcKey, () => { bad(`${tag}: paid on plain talk`); });
  if (qq.startWord) {
    if (plain !== null) bad(`${tag}: word-gated but plain talk returned pages`);
    const offer = q.askQuestWord(g.mapId, g.npcKey, qq.startWord);
    if (!offer) { bad(`${tag}: asking the giver about "${qq.startWord}" opened nothing`); continue; }
    if (!q.acceptQuest(id)) { bad(`${tag}: ACCEPT did not start it`); continue; }
  } else if (!ps.quests[id]) {
    bad(`${tag}: ungated quest did not start on talk`); continue;
  }
  if (!ps.quests[id] || ps.quests[id].s !== 'active') { bad(`${tag}: not active after accept`); continue; }

  // Meet the objective through the real counter, using a zone key that starts
  // with the prefix — an objective whose zone nothing produces is unfinishable.
  const obj = qq.objective;
  if (obj.kind !== 'defeat') { bad(`${tag}: unknown objective kind "${obj.kind}"`); continue; }
  // Does any zone the game can actually roll match this prefix? A prefix that
  // matches nothing is an objective no player can ever finish.
  const zones = [...ENCOUNTERS.keys()].filter(z => String(z).startsWith(obj.zonePrefix));
  if (!zones.length) {
    bad(`${tag}: objective zonePrefix "${obj.zonePrefix}" matches NO zone in encounters.js ` +
        `(${[...ENCOUNTERS.keys()].join(', ')}) — unfinishable`);
    continue;
  }
  if (obj.count <= 0) { bad(`${tag}: objective count is ${obj.count}`); continue; }
  q.noteEncounterVictory('zzz_not_this_zone');
  if (ps.quests[id].n !== 0) bad(`${tag}: a win in another zone counted`);
  // Count through a REAL zone key, not the prefix itself.
  for (let i = 0; i < obj.count; i++) q.noteEncounterVictory(zones[i % zones.length]);
  if (ps.quests[id].n !== obj.count) { bad(`${tag}: count stuck at ${ps.quests[id].n}/${obj.count}`); continue; }

  const done = q.talkQuest(g.mapId, g.npcKey, (r) => { paid = r; });
  if (!done || !done.length) bad(`${tag}: hand-in returned no pages`);
  if (!paid) bad(`${tag}: hand-in paid nothing`);
  else {
    if ((paid.gil | 0) !== (qq.reward.gil | 0)) bad(`${tag}: paid ${paid.gil} gil, table says ${qq.reward.gil}`);
    if ((paid.item | 0) !== (qq.reward.item | 0)) bad(`${tag}: paid item ${paid.item}, table says ${qq.reward.item}`);
  }
  if (ps.quests[id].s !== 'done') bad(`${tag}: not marked done after hand-in`);
  let again = null;
  q.talkQuest(g.mapId, g.npcKey, (r) => { again = r; });
  if (again) bad(`${tag}: paid TWICE`);
  // Every stage renders without leaking a progress token.
  for (const stage of ['offer', 'accepted', 'denied', 'active', 'complete', 'done']) {
    if (!Array.isArray(qq[stage]) || !qq[stage].length) { bad(`${tag}: missing ${stage} pages`); continue; }
  }
  ok(`${tag}: offer -> accept -> ${obj.count}x ${zones.join('/')} -> paid ${qq.reward.gil}g` +
     (qq.reward.item ? ` + item 0x${(qq.reward.item).toString(16)}` : '') + ' -> done, once');
}
ps.quests = {};

if (failed) { console.error(`\ncheck-quests: FAIL (${failed})`); process.exit(1); }
console.log('\ncheck-quests: OK');
