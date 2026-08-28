#!/usr/bin/env node
// audit-quest-coverage.mjs — does everybody a quest touches have a line at
// every point of that quest?
//
// A quest names people in three places: a stage's `at`, a stage's `also`, and
// `after`. `check-quest-stages` proves each `at` person is PLACED. Nothing
// checks the far more common failure: the person is standing there and answers
// with an idle line written before the quest existed, so the King forgets his
// own daughter mid-search and the smith still says she is in Kazus.
//
// Prints one row per (quest person x quest stage) with what they actually say.
import { createCanvas } from '@napi-rs/canvas';
globalThis.document = { createElement: (t) => (t === 'canvas' ? createCanvas(1, 1) : {}) };
const { ps } = await import('../src/player-stats.js');
const { QUESTS, QUEST_DONE } = await import('../src/data/quests.js');
const { TOWN_NPCS, GENERATED_NPCS } = await import('../src/data/town-npcs.js');
const { previewSpeech } = await import('../src/speech.js');
// ⛔ THE CAST COMES FROM THE SCRIPT NOW. Reading `st.also` / `quest.after` off
// the quest record silently returned {} after the prose split, which dropped
// Sara and the King out of `kazus_sealed_cave`'s cast and made this harness
// report 10 gaps where there are 12. A missing person reads as no problem.
const { asideKeys, voiceKeys } = await import('../src/data/script.js');
const { hasFlag } = await import('../src/story-flags.js');
const { objectiveCount } = await import('../src/quest-objectives.js');

// ⛔ ALL rows for a key, not the first. Cid and the King each have TWO rows —
// cursed and not — selected by `when` at placement time. Taking the first row
// reports the ghost's lines in a world where the curse has lifted, which is the
// exact class of bug this harness is looking for.
const byKey = new Map();
for (const [mapId, rows] of [...TOWN_NPCS, ...GENERATED_NPCS])
  for (const r of rows) { if (!byKey.has(r.key)) byKey.set(r.key, []); byKey.get(r.key).push({ mapId, ...r }); }
const questDone = (id) => !!(ps.quests[id] && ps.quests[id].s === QUEST_DONE);
const placedRow = (key) => (byKey.get(key) || []).find(r => !r.when || r.when(questDone, hasFlag)) || null;

let gaps = 0;
for (const quest of Object.values(QUESTS)) {
  // Everyone this quest ever names.
  const cast = new Set();
  for (const st of quest.stages) { cast.add(st.at.npc); for (const k of asideKeys(quest.id, st.id)) cast.add(k); }
  for (const k of voiceKeys(quest.id)) cast.add(k);

  console.log(`\n══ ${quest.id}   cast: ${[...cast].join(', ')}`);
  const states = quest.stages.slice(1).map(s => ({ label: s.id, e: { s: s.id, n: 0 } }));
  states.push({ label: 'DONE', e: { s: QUEST_DONE, n: 0 } });

  for (const st of states) {
    // Flags this quest has set by now, so idle variants resolve honestly.
    const idx = st.e.s === QUEST_DONE ? quest.stages.length : quest.stages.findIndex(s => s.id === st.e.s);
    ps.flags = {};
    for (let i = 0; i < idx; i++) for (const f of quest.stages[i].sets || []) ps.flags[f] = 1;
    ps.quests = { [quest.id]: { ...st.e } };
    console.log(`  ── stage ${st.label}  flags=[${Object.keys(ps.flags).join(',')}]`);
    for (const key of cast) {
      const row = placedRow(key);
      if (!row) { console.log(`     ${key.padEnd(22)} !! NOT PLACED IN THIS STATE`); gaps++; continue; }
      const sp = previewSpeech(row.mapId, key, row.spec);
      if (sp && sp.source !== 'idle') {
        console.log(`     ${key.padEnd(22)} [${sp.source}] ${sp.pages.map(p=>`"${p}"`).join(' / ')}`);
      } else {
        const line = sp ? sp.pages.map(p=>`"${p}"`).join(' / ') : '*** SILENT ***';
        console.log(`     ${key.padEnd(22)} [IDLE — no quest line] ${line}`);
        gaps++;
      }
    }
  }
}
console.log(`\n${gaps} point(s) where somebody the quest names has no quest line.`);
