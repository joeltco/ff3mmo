#!/usr/bin/env node
// check-speech-coverage.mjs — everybody a quest NAMES has something to say at
// every point of that quest.
//
// `check-quest-stages` proves each stage's NPC is PLACED. Nothing checked the
// far more common failure: the person is standing right there and answers with
// an idle line written before the quest existed. Measured 2026-08-27 — TWELVE
// such points, including the King forgetting his own daughter mid-search and
// the smith still telling you she is in Kazus.
//
// A "cast member" is anyone the quest names: a stage's `at` or anyone in the
// `voice` block. Two rules, because the two situations are different:
//
//   WHILE the quest is live — each of them must resolve to a QUEST layer
//   (advance / waiting / offer / aside), never a bare idle line, never silence.
//
//   ONCE it is DONE — there is no quest layer any more, by design: the parting
//   line is a flag-guarded variant on the person's own row. So the rule is that
//   their line must have CHANGED. Saying exactly what they said before the
//   player ever took the quest is the failure, and it is the one that shipped:
//   the smith reverts to "I cut the ring here" for the rest of the game.
//
// ⛔ RESOLVED THROUGH `speech.js`, the function the game runs. A gate with its
// own copy of the layer order keeps agreeing with itself after the order
// changes.
//
// ── THE ALLOWLIST ─────────────────────────────────────────────────────────
//
// `KNOWN_GAPS` holds the twelve that exist today, each with the reason. It
// drains as Phase 3 writes the missing lines. The gate fails BOTH ways:
//   * a gap that is not listed          -> a new hole, blocked
//   * a listed gap that is no longer one -> stale entry, delete it
// That second half is what stops the list quietly becoming permission.
//
//   node tools/check-speech-coverage.mjs [--list]

import { createCanvas } from '@napi-rs/canvas';
globalThis.document = { createElement: (t) => (t === 'canvas' ? createCanvas(1, 1) : {}) };

const { ps } = await import('../src/player-stats.js');
const { QUESTS, QUEST_DONE } = await import('../src/data/quests.js');
const { TOWN_NPCS, GENERATED_NPCS } = await import('../src/data/town-npcs.js');
const { asideKeys, voiceKeys } = await import('../src/data/script.js');
const { previewSpeech } = await import('../src/speech.js');
const { hasFlag } = await import('../src/story-flags.js');

// questId/stageId/npcKey -> why it is still open. Delete a line when you write
// the missing pages; the gate fails if you forget.
// ⭐ THREE ENTRIES CAME OFF THIS LIST when `after` collapsed into flag-keyed
// idle dialogue (v1.11.15): the hall servant, Sara and the King all already had
// endgame variants written — they were simply being shadowed by the quest layer
// and could never be reached. Deleting the layer made three shipped page sets
// visible without a word being written.
const KNOWN_GAPS = new Map([
  ['sasune_missing_daughter/errand/kazus_smith', 'smith has no line while you chase the runner'],
  ['sasune_missing_daughter/errand/sara',        'reachable early via the canoe; she does not react'],
  ['sasune_missing_daughter/forge/sasune_hall_servant', 're-reads the lead he already gave'],
  ['sasune_missing_daughter/forge/sara',         'same as errand'],
  ['sasune_missing_daughter/found/sasune_king',  'THE KING FORGETS HIS OWN DAUGHTER — no voice entry for `found`'],
  ['sasune_missing_daughter/found/sasune_hall_servant', 're-reads the lead he already gave'],
  ['sasune_missing_daughter/return/sasune_hall_servant', 'falls back to his sara_found idle'],
  ['sasune_missing_daughter/return/kazus_smith', 'reverts to his PRE-QUEST line'],
  ['sasune_missing_daughter/DONE/kazus_smith',   'reverts to his PRE-QUEST line for the rest of the game'],
]);

const LIST = process.argv.includes('--list');
let failed = 0;
const bad = (m) => { console.error(`  ✗ ${m}`); failed++; };

// Every placement row for a key — Cid and the King each have two costumes.
const rows = new Map();
for (const [mapId, list] of [...TOWN_NPCS, ...GENERATED_NPCS])
  for (const r of list) { if (!rows.has(r.key)) rows.set(r.key, []); rows.get(r.key).push({ mapId, ...r }); }
const questDone = (id) => !!(ps.quests[id] && ps.quests[id].s === QUEST_DONE);
const placedRow = (key) => (rows.get(key) || []).find((r) => !r.when || r.when(questDone, hasFlag)) || null;

// What everybody says on a FRESH save, so "did this person's line change once
// the quest was over" is answerable. Captured before any state is applied.
ps.quests = {}; ps.flags = {};
const FRESH = new Map();
for (const [key, list] of rows) {
  const r = list.find((x) => !x.when || x.when(questDone, hasFlag));
  if (!r) continue;
  const sp = previewSpeech(r.mapId, key, r.spec);
  FRESH.set(key, sp ? sp.pages.join(' / ') : '');
}

const seenGaps = new Set();
for (const quest of Object.values(QUESTS)) {
  const cast = new Set();
  for (const st of quest.stages) { cast.add(st.at.npc); for (const k of asideKeys(quest.id, st.id)) cast.add(k); }
  for (const k of voiceKeys(quest.id)) cast.add(k);

  // Stage 0 is the offer; the quest is not live until it is taken.
  const states = quest.stages.slice(1).map((s) => s.id).concat([QUEST_DONE]);
  for (const sid of states) {
    // Flags this quest has set by the time it reaches this stage.
    const idx = sid === QUEST_DONE ? quest.stages.length : quest.stages.findIndex((s) => s.id === sid);
    ps.flags = {};
    for (let i = 0; i < idx; i++) for (const f of quest.stages[i].sets || []) ps.flags[f] = 1;
    ps.quests = { [quest.id]: { s: sid, n: 0 } };

    const done = sid === QUEST_DONE;
    for (const key of cast) {
      const row = placedRow(key);
      const label = `${quest.id}/${done ? 'DONE' : sid}/${key}`;
      if (!row) { bad(`${label}: nobody with that key is placed in this state`); continue; }
      const sp = previewSpeech(row.mapId, key, row.spec);
      let isGap, why;
      if (done) {
        // Their line must not be the one they had before the quest existed.
        isGap = !sp || sp.pages.join(' / ') === (FRESH.get(key) || '');
        why = sp ? `says exactly what they said before the quest: ${JSON.stringify(sp.pages.join(' / '))}`
                 : 'says nothing at all once the quest is over';
      } else {
        isGap = !sp || sp.source === 'idle';
        why = sp ? `falls back to idle dialogue — ${JSON.stringify(sp.pages.join(' / '))}`
                 : 'falls back to SILENCE';
      }
      if (LIST && !isGap) console.log(`  ok  ${label.padEnd(52)} [${sp.source}]`);
      if (!isGap) continue;
      seenGaps.add(label);
      if (KNOWN_GAPS.has(label)) {
        if (LIST) console.log(`  --  ${label.padEnd(52)} KNOWN: ${KNOWN_GAPS.get(label)}`);
        continue;
      }
      bad(`${label}: ${why}`);
    }
  }
}

// ⛔ The other direction: a listed gap that is no longer one must be deleted,
// or the list becomes a place regressions can hide.
for (const [label, why] of KNOWN_GAPS) {
  if (!seenGaps.has(label)) bad(`KNOWN_GAPS lists ${label} ("${why}") but it is no longer a gap — delete the entry`);
}

if (failed) {
  console.error(`\ncheck-speech-coverage: FAIL — ${failed} problem(s)`);
  process.exit(1);
}
console.log(`check-speech-coverage: OK — no new gaps; ${KNOWN_GAPS.size} known one(s) still open (Phase 3)`);
