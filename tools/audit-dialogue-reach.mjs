#!/usr/bin/env node
// audit-dialogue-reach.mjs — is every authored line ever SEEN?
//
// `check-dialogue-fit` measures every page set. `check-npc-dialogue` checks the
// shape. Neither asks whether a state exists in which the player reads it. A
// quest's `after` pages outrank an NPC's idle dialogue for the rest of the save,
// so a flag-gated idle variant written for the endgame can be shadowed forever
// by the hand-in line — authored, measured, gated, and impossible to see.
//
// This enumerates EVERY consistent world state (the cross product of per-quest
// stages, with story flags derived from them exactly as the quests set them),
// asks the real `resolveTalk` / `resolvePages` what comes out, and reports any
// authored page set that never does.
import { createCanvas } from '@napi-rs/canvas';
globalThis.document = { createElement: (t) => (t === 'canvas' ? createCanvas(1, 1) : {}) };

const { ps } = await import('../src/player-stats.js');
const { QUESTS, QUEST_DONE } = await import('../src/data/quests.js');
const { TOWN_NPCS, GENERATED_NPCS } = await import('../src/data/town-npcs.js');
const { isVariantList, allPageSets } = await import('../src/data/dialogue.js');
// ⭐ The shadowing this harness exists to find is a RULE, and the rule lives in
// speech.js. Asking it directly means the harness cannot disagree with the game
// about which layer wins.
const { previewSpeech } = await import('../src/speech.js');
const { hasFlag } = await import('../src/story-flags.js');
const { objectiveCount } = await import('../src/quest-objectives.js');
const { answerFor } = await import('../src/word-memory.js');

const ROSTER = [];
for (const [mapId, rows] of TOWN_NPCS) for (const r of rows) ROSTER.push({ mapId, ...r });
for (const [mapId, rows] of GENERATED_NPCS) for (const r of rows) ROSTER.push({ mapId, ...r });

// ── every state one quest can be in ───────────────────────────────────────
function questStates(quest) {
  const out = [null];                                  // untaken
  for (let i = 1; i < quest.stages.length; i++) {
    const st = quest.stages[i];
    const need = st.objective ? objectiveCount(st.objective) : 0;
    out.push({ s: st.id, n: 0 });
    if (need) out.push({ s: st.id, n: need });
  }
  out.push({ s: QUEST_DONE, n: 0 });
  return out;
}

// Flags are NOT free variables: each is set by a named stage, so a state's flag
// set is derived from how far each quest has gone. Deriving rather than
// enumerating is what keeps "unreachable" honest.
function flagsFor(state) {
  const flags = {};
  for (const [qid, e] of Object.entries(state)) {
    if (!e) continue;
    const quest = QUESTS[qid];
    const idx = e.s === QUEST_DONE ? quest.stages.length : quest.stages.findIndex(s => s.id === e.s);
    for (let i = 0; i < idx; i++) for (const f of quest.stages[i].sets || []) flags[f] = 1;
  }
  return flags;
}

const ids = Object.keys(QUESTS);
const combos = [];
(function walk(i, acc) {
  if (i === ids.length) { combos.push({ ...acc }); return; }
  for (const st of questStates(QUESTS[ids[i]])) walk(i + 1, { ...acc, [ids[i]]: st });
})(0, {});

// ── collect what is actually produced ─────────────────────────────────────
const seenIdle = new Map();       // npcKey -> Set(joined pages)
const seenAnswer = new Map();     // npcKey|term -> Set
const flagSets = new Set();
for (const combo of combos) {
  ps.quests = {}; for (const [k, v] of Object.entries(combo)) if (v) ps.quests[k] = { ...v };
  ps.flags = flagsFor(combo);
  flagSets.add(Object.keys(ps.flags).sort().join(','));
  const questDone = (id) => !!(ps.quests[id] && ps.quests[id].s === QUEST_DONE);
  for (const row of ROSTER) {
    if (row.when && !row.when(questDone, hasFlag)) continue;
    const k = `${row.mapId}/${row.key}`;
    if (!seenIdle.has(k)) seenIdle.set(k, new Set());
    // Quest pages OUTRANK idle dialogue — that shadowing is the whole reason
    // this harness exists, so ask the resolver which layer actually answers.
    const sp = previewSpeech(row.mapId, row.key, row.spec);
    if (!sp || sp.source !== 'idle') continue;
    seenIdle.get(k).add(sp.pages.join(' / '));
    for (const term of Object.keys(row.spec.answers || {})) {
      const a = answerFor(row.spec, term);
      const ak = `${k}|${term}`;
      if (!seenAnswer.has(ak)) seenAnswer.set(ak, new Set());
      if (a) seenAnswer.get(ak).add(a.join(' / '));
    }
  }
}

// ── report ────────────────────────────────────────────────────────────────
console.log(`walked ${combos.length} consistent world states, ${flagSets.size} distinct flag sets\n`);
let dead = 0, silent = 0;
for (const row of ROSTER) {
  const k = `${row.mapId}/${row.key}`;
  const got = seenIdle.get(k) || new Set();
  const authored = allPageSets(row.spec && row.spec.dialogue).filter(Boolean);
  if (!authored.length) {
    console.log(`[SILENT]      ${k} has no dialogue at all — pressing Z does nothing`); silent++;
  }
  for (const set of authored) {
    if (!got.has(set.join(' / '))) {
      const guard = isVariantList(row.spec.dialogue)
        ? (row.spec.dialogue.find(v => v.pages === set) || {}).when || 'default' : '-';
      console.log(`[UNREACHABLE] ${k} idle [${guard}]: ${set.map(s => `"${s}"`).join(' / ')}`); dead++;
    }
  }
  for (const [term, raw] of Object.entries(row.spec.answers || {})) {
    const sets = isVariantList(raw) ? allPageSets(raw) : null;
    if (!sets) continue;
    const gotA = seenAnswer.get(`${k}|${term}`) || new Set();
    for (const set of sets) {
      if (!gotA.has(set.join(' / '))) {
        const guard = (raw.find(v => v.pages === set) || {}).when || 'default';
        console.log(`[UNREACHABLE] ${k} ASK ${term.toUpperCase()} [${guard}]: ${set.map(s => `"${s}"`).join(' / ')}`); dead++;
      }
    }
  }
}
console.log(`\n${dead} unreachable page set(s), ${silent} NPC(s) with nothing to say.`);
