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
const { isObjectiveKind } = await import('../src/quest-objectives.js');
const { setFlag, hasFlag } = await import('../src/story-flags.js');

let failed = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { console.error(`  ✗ ${m}`); failed++; };
const is = (got, want, what) =>
  got === want ? ok(`${what}: ${JSON.stringify(got)}`)
               : bad(`${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

const QID = 'ur_missing_brother';
const quest = QUESTS[QID];
if (!quest) { console.error('quest ur_missing_brother missing'); process.exit(1); }
const S0 = quest.stages[0];
const SLAST = quest.stages[quest.stages.length - 1];
const { map: mapId, npc: npcKey } = S0.at;

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
is(offer && offer.pages.join('|'), S0.offer.join('|'), 'asking about the start word returns the OFFER pages');
is(ps.quests[QID] === undefined, true, 'the offer alone does not start the quest');
is(q.acceptQuest(QID), true, 'ACCEPT starts it');
is(ps.quests[QID].s, quest.stages[1].id, 'quest advanced to stage 1');
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
is(pagesMid.length, SLAST.say.length, 'talking mid-quest returns the WAITING nag, not the reward');
is(/\b2 of 3\b/.test(pagesMid.join(' ')), true, 'the WAITING nag reads the progress count out');

q.noteEncounterVictory('altar_cave_boss');
is(ps.quests[QID].n, 3, 'third win counted');

q.noteEncounterVictory('altar_cave_f1');
is(ps.quests[QID].n, 3, 'count does not overshoot the objective');

const pages2 = q.talkQuest(mapId, npcKey, (r) => { rewarded = r; });
is(pages2.join('|'), SLAST.onAdvance.join('|'), 'handing in returns the onAdvance pages');
is(rewarded && rewarded.gil, quest.reward.gil, 'reward gil paid out');
is(rewarded && rewarded.item, quest.reward.item, 'reward ITEM handed over — the line promises an object');
is(ps.quests[QID].s, 'done', 'quest is done');

rewarded = null;
const pages3 = q.talkQuest(mapId, npcKey, (r) => { rewarded = r; });
is(pages3.join('|'), quest.after[npcKey].join('|'), 'talking again returns the AFTER pages');
is(rewarded, null, 'reward is NOT paid twice');

// ── persistence ───────────────────────────────────────────────────────────
const round = q.sanitizeQuests(JSON.parse(JSON.stringify(ps.quests)));
is(round[QID].s, 'done', 'state survives a save round-trip');
is(Object.keys(q.sanitizeQuests({ not_a_quest: { s: 'done', n: 5 } })).length, 0,
   'an unknown quest id is dropped on load');
is(q.sanitizeQuests({ [QID]: { s: SLAST.id, n: 9999 } })[QID].n, SLAST.objective.count,
   'a hand-edited count is clamped to the objective');
is(q.sanitizeQuests({ [QID]: { s: SLAST.id, n: -5 } })[QID].n, 0,
   'a negative count is clamped to 0');
// ⛔ An unknown STAGE is DROPPED, not coerced. Coercing to stage 0 restarts a
// finished quest; coercing to done hands out one never run. Both are worse than
// treating the save as not having taken it.
is(Object.keys(q.sanitizeQuests({ [QID]: { s: 'nonsense', n: 1 } })).length, 0,
   'an unknown stage id is dropped, not coerced');

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
const vBad = _testValidateSaveData({ quests: { [QID]: { s: SLAST.id, n: 999999 } } });
const e = vBad && vBad.ok && vBad.data.quests && vBad.data.quests[QID];
if (e && e.s === SLAST.id && e.n === SLAST.objective.count) ok('server clamps a forged count to the objective');
else bad(`server did not clamp a forged entry to ${SLAST.objective.count}: ${JSON.stringify(e)}`);
// ⛔ A forged STAGE is dropped by the server too, not coerced — same rule as
// the client. A save claiming a stage that does not exist has not taken the
// quest; inventing one for it would either restart or finish it behind the
// player's back.
const vStage = _testValidateSaveData({ quests: { [QID]: { s: 'hax', n: 1 } } });
if (vStage.ok && vStage.data.quests && !vStage.data.quests[QID]) ok('server drops a forged stage id, same as the client');
else bad(`server kept a forged stage: ${JSON.stringify(vStage.data && vStage.data.quests)}`);
const vUnknown = _testValidateSaveData({ quests: { not_a_quest: { s: 'done', n: 3 } } });
if (vUnknown.ok && vUnknown.data.quests && !vUnknown.data.quests.not_a_quest) ok('server drops an unknown quest id, same as the client');
else bad('server kept an unknown quest id the client would have dropped');

// ── EVERY quest walks, not just the one this file was written around ──────
// The detailed walk above is hand-written against ur_missing_brother. A second
// quest landed in v1.8.9 and nothing here touched it, which is how a broken
// giver / unteachable start word / unreachable objective ships. This is the
// generic loop, now STAGE BY STAGE: offer -> each stage's objective -> advance
// -> finished, driven from the table, for every quest defined.
//
// ⛔ THIS WALK DRIVES THE QUEST API DIRECTLY and therefore CANNOT see whether
// the stage's NPC is actually standing in the room. That blind spot is exactly
// how `kazus_cid_airship` shipped dead. `tools/check-quest-stages.mjs` is the
// gate that closes it; this one proves the machine, that one proves the cast.
console.log('\n── every quest, generically ──');
for (const [id, qq] of Object.entries(QUESTS)) {
  const tag = `${id}`;
  ps.quests = {};
  ps.flags = {};
  let paid = null;
  const stages = qq.stages || [];
  if (stages.length < 2) { bad(`${tag}: needs at least an offer stage and one more`); continue; }
  const s0 = stages[0];

  // Word-gated quests must NOT open on plain talk; ungated ones must.
  const plain = q.talkQuest(s0.at.map, s0.at.npc, () => { bad(`${tag}: paid on plain talk`); });
  if (qq.startWord) {
    if (plain !== null) bad(`${tag}: word-gated but plain talk returned pages`);
    const offer = q.askQuestWord(s0.at.map, s0.at.npc, qq.startWord);
    if (!offer) { bad(`${tag}: asking stage 0 about "${qq.startWord}" opened nothing`); continue; }
    if (!q.acceptQuest(id)) { bad(`${tag}: ACCEPT did not start it`); continue; }
  } else if (!ps.quests[id]) {
    bad(`${tag}: ungated quest did not start on talk`); continue;
  }
  if (!ps.quests[id] || ps.quests[id].s !== stages[1].id) {
    bad(`${tag}: after accept, stage is ${ps.quests[id] && ps.quests[id].s}, expected ${stages[1].id}`);
    continue;
  }

  // ── walk the remaining stages ──
  const trail = [];
  let broke = false;
  for (let i = 1; i < stages.length; i++) {
    const st = stages[i];
    if (ps.quests[id].s !== st.id) { bad(`${tag}: expected stage ${st.id}, at ${ps.quests[id].s}`); broke = true; break; }
    const obj = st.objective;

    if (obj) {
      if (!isObjectiveKind(obj.kind)) { bad(`${tag}/${st.id}: undeclared objective kind "${obj.kind}"`); broke = true; break; }
      if (obj.kind === 'defeat') {
        // Does any zone the game can actually roll match this prefix? A prefix
        // that matches nothing is an objective no player can ever finish.
        const zones = [...ENCOUNTERS.keys()].filter(z => String(z).startsWith(obj.zonePrefix));
        if (!zones.length) {
          bad(`${tag}/${st.id}: zonePrefix "${obj.zonePrefix}" matches NO zone in encounters.js — unfinishable`);
          broke = true; break;
        }
        if ((obj.count | 0) <= 0) { bad(`${tag}/${st.id}: objective count is ${obj.count}`); broke = true; break; }
        q.noteEncounterVictory('zzz_not_this_zone');
        if (ps.quests[id].n !== 0) bad(`${tag}/${st.id}: a win in another zone counted`);
        for (let k = 0; k < obj.count; k++) q.noteEncounterVictory(zones[k % zones.length]);
        if (ps.quests[id].n !== obj.count) { bad(`${tag}/${st.id}: count stuck at ${ps.quests[id].n}/${obj.count}`); broke = true; break; }
        // ⛔ A boss objective must NOT be satisfiable by ordinary encounters.
      } else if (obj.kind === 'boss') {
        if (obj.bossId == null) { bad(`${tag}/${st.id}: boss objective names no bossId`); broke = true; break; }
        q.noteBossDefeated((obj.bossId | 0) ^ 0xFF);        // some OTHER boss
        if (ps.quests[id].n !== 0) bad(`${tag}/${st.id}: the wrong boss counted`);
        q.noteBossDefeated(obj.bossId);
        if (ps.quests[id].n !== 1) { bad(`${tag}/${st.id}: the right boss did not count`); broke = true; break; }
      } else if (obj.kind === 'flag') {
        if (!obj.flag) { bad(`${tag}/${st.id}: flag objective names no flag`); broke = true; break; }
        setFlag(obj.flag);
        // A flag objective is advanced by the flag being SET, which quests.js
        // fires from a stage's `sets:` — a flag set from elsewhere still counts.
      }
      // 'talk' needs nothing: talking to `at` is the objective.
    }

    // Mid-stage, the stage's own NPC nags rather than advancing — but only when
    // there is something left to do.
    const isLast = i === stages.length - 1;
    const pages = q.talkQuest(st.at.map, st.at.npc, (r) => { paid = r; });
    if (!pages || !pages.length) { bad(`${tag}/${st.id}: advancing returned no pages`); broke = true; break; }
    trail.push(st.id);

    // Flags the stage declares must actually be true afterwards.
    for (const f of st.sets || []) {
      if (!hasFlag(f)) { bad(`${tag}/${st.id}: declared sets:['${f}'] but the flag is not set`); broke = true; }
    }
    if (broke) break;

    if (!isLast && ps.quests[id].s === 'done') { bad(`${tag}/${st.id}: finished early`); broke = true; break; }
    if (isLast && ps.quests[id].s !== 'done') { bad(`${tag}/${st.id}: last stage did not finish the quest`); broke = true; break; }
  }
  if (broke) continue;

  if (!paid) bad(`${tag}: hand-in paid nothing`);
  else {
    if ((paid.gil | 0) !== (qq.reward.gil | 0)) bad(`${tag}: paid ${paid.gil} gil, table says ${qq.reward.gil}`);
    if ((paid.item | 0) !== (qq.reward.item | 0)) bad(`${tag}: paid item ${paid.item}, table says ${qq.reward.item}`);
  }

  // Talking again must not pay twice, and must fall to the `after` lines.
  paid = null;
  const lastNpc = stages[stages.length - 1].at;
  const again = q.talkQuest(lastNpc.map, lastNpc.npc, (r) => { paid = r; });
  if (paid) bad(`${tag}: paid a second time`);
  if (qq.after && qq.after[lastNpc.npc] && (!again || !again.length)) {
    bad(`${tag}: declares after[${lastNpc.npc}] but says nothing once finished`);
  }

  ok(`${tag}: ${qq.startWord ? `ask ${qq.startWord} -> ` : ''}${trail.join(' -> ')} -> paid ${qq.reward.gil}g` +
     (qq.reward.item ? ` + item 0x${(qq.reward.item).toString(16)}` : '') +
     (qq.reward.vehicle ? ` + vehicle mode ${qq.reward.vehicle.mode}` : '') + ' -> done, once');
}
ps.quests = {};

if (failed) { console.error(`\ncheck-quests: FAIL (${failed})`); process.exit(1); }
console.log('\ncheck-quests: OK');
