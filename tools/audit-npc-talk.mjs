#!/usr/bin/env node
// audit-npc-talk.mjs — TRANSCRIBE the game.
//
// Every gate in deploy.sh asks a structural question ("is the giver placed",
// "does every page fit the box"). None of them ask the only question a player
// asks: WHAT DOES THIS PERSON SAY TO ME RIGHT NOW. So a line that is stale,
// duplicated, contradicted by the quest it belongs to, or simply absent passes
// every gate we own.
//
// This walks the canonical story beats, and at each one prints what EVERY
// placed NPC says when you press Z on them — through the real `resolveTalk`
// and the real `resolvePages`, never a re-implementation.
//
//   node tools/audit-npc-talk.mjs            # changes only
//   node tools/audit-npc-talk.mjs --all      # every NPC at every beat
//   node tools/audit-npc-talk.mjs --beat=4
import { createCanvas } from '@napi-rs/canvas';
globalThis.document = { createElement: (t) => (t === 'canvas' ? createCanvas(1, 1) : {}) };

const { ps } = await import('../src/player-stats.js');
const { QUESTS, QUEST_DONE } = await import('../src/data/quests.js');
const { TOWN_NPCS, GENERATED_NPCS } = await import('../src/data/town-npcs.js');
// ⭐ ONE RESOLVER. This tool used to call `resolveTalk`, re-implement the
// progress-token fill, and then fall back to `resolvePages` itself — three
// copies of a rule that lives in `speech.js`. `previewSpeech` is the same
// function the game runs, with the mutating half removed.
const { previewSpeech } = await import('../src/speech.js');
const { hasFlag } = await import('../src/story-flags.js');
const { objectiveCount } = await import('../src/quest-objectives.js');

const ARG_ALL  = process.argv.includes('--all');
const ONLY     = (process.argv.find(a => a.startsWith('--beat=')) || '').split('=')[1];

// ── the roster, flattened: every person the player can walk up to ─────────
const ROSTER = [];
for (const [mapId, rows] of TOWN_NPCS) for (const r of rows) ROSTER.push({ mapId, ...r, generated: false });
for (const [mapId, rows] of GENERATED_NPCS) for (const r of rows) ROSTER.push({ mapId, ...r, generated: true });

// ── beats: the canonical walk, in order ───────────────────────────────────
// `n: -1` means "objective met" for that stage.
const B = (name, quests, flags) => ({ name, quests, flags });
const BEATS = [
  B('1  fresh save', {}, []),
  B('2  brother taken', { ur_missing_brother: ['clear', 0] }, []),
  B('3  brother met', { ur_missing_brother: ['clear', -1] }, []),
  B('4  brother done', { ur_missing_brother: [QUEST_DONE, 0] }, []),
  B('5  riders taken', { ur_missing_brother: [QUEST_DONE, 0], ur_lost_riders: ['clear', 0] }, []),
  B('6  riders done', { ur_missing_brother: [QUEST_DONE, 0], ur_lost_riders: [QUEST_DONE, 0] }, []),
  B('7  sara: accepted -> errand', { sasune_missing_daughter: ['errand', 0] }, ['canoe_granted']),
  B('8  sara: -> forge', { sasune_missing_daughter: ['forge', 0] }, ['canoe_granted']),
  B('9  sara: -> found', { sasune_missing_daughter: ['found', 0] }, ['canoe_granted']),
  B('10 sara: -> return', { sasune_missing_daughter: ['return', 0] }, ['canoe_granted', 'sara_found']),
  B('11 sara: done', { sasune_missing_daughter: [QUEST_DONE, 0] }, ['canoe_granted', 'sara_found']),
  B('12 djinn taken', { sasune_missing_daughter: [QUEST_DONE, 0], kazus_sealed_cave: ['seal', 0] },
    ['canoe_granted', 'sara_found']),
  B('13 djinn beaten (unclaimed)', { sasune_missing_daughter: [QUEST_DONE, 0], kazus_sealed_cave: ['seal', -1] },
    ['canoe_granted', 'sara_found']),
  B('14 djinn done', { sasune_missing_daughter: [QUEST_DONE, 0], kazus_sealed_cave: [QUEST_DONE, 0] },
    ['canoe_granted', 'sara_found', 'djinn_sealed', 'curse_lifted']),
];

function applyBeat(beat) {
  // ⛔ FLAGS ARE DERIVED, NOT LISTED. They used to be hand-written per beat,
  // which silently went stale the moment a quest gained a flag: after `after`
  // collapsed into flag-keyed idle dialogue, every finished quest in this
  // transcript reverted to its opening line because the beat table had never
  // heard of `brother_avenged`. A quest state IMPLIES its flags — every stage
  // before the current one has run — so compute them.
  ps.flags = {};
  for (const [id, [s]] of Object.entries(beat.quests)) {
    const q = QUESTS[id];
    const idx = s === QUEST_DONE ? q.stages.length : q.stages.findIndex((x) => x.id === s);
    for (let i = 0; i < idx; i++) for (const f of q.stages[i].sets || []) ps.flags[f] = 1;
  }
  // A beat may still name extra flags for state a quest does not set.
  for (const f of beat.flags) ps.flags[f] = 1;
  ps.quests = {};
  for (const [id, [s, n]] of Object.entries(beat.quests)) {
    const quest = QUESTS[id];
    let count = n;
    if (n === -1) {
      const st = (quest.stages || []).find(x => x.id === s);
      count = st && st.objective ? objectiveCount(st.objective) : 0;
    }
    ps.quests[id] = { s, n: count };
  }
}

const questDone = (id) => !!(ps.quests[id] && ps.quests[id].s === QUEST_DONE);

/** Exactly what pressing Z on this person produces, or null for silence. */
function saysNow(row) {
  if (row.when && !row.when(questDone, hasFlag)) return { placed: false };
  const sp = previewSpeech(row.mapId, row.key, row.spec);
  if (!sp) return { placed: true, src: 'SILENT', pages: null };
  const src = sp.source === 'idle' ? 'idle' : `${sp.source}:${sp.quest.id}`;
  return { placed: true, src, pages: sp.pages };
}

const fmt = (r) => r.placed === false ? '(not placed)'
  : r.pages === null ? '*** SILENT ***'
  : r.pages.map(p => `"${p}"`).join(' / ');

// ── walk it ───────────────────────────────────────────────────────────────
const prev = new Map();
for (const beat of BEATS) {
  if (ONLY && !beat.name.startsWith(ONLY + ' ')) { applyBeat(beat); for (const row of ROSTER) prev.set(row.mapId + '/' + row.key + '/' + (row.when ? String(row.when) : ''), fmt(saysNow(row))); continue; }
  applyBeat(beat);
  const lines = [];
  for (const row of ROSTER) {
    const id = row.mapId + '/' + row.key + '/' + (row.when ? String(row.when) : '');
    const now = fmt(saysNow(row));
    const was = prev.get(id);
    if (ARG_ALL || was === undefined || was !== now) {
      lines.push(`  map ${String(row.mapId).padStart(4)}  ${row.key.padEnd(24)} [${saysNow(row).src || '-'}] ${now}`);
    }
    prev.set(id, now);
  }
  console.log(`\n━━ BEAT ${beat.name}  flags=[${beat.flags.join(',')}] ━━`);
  if (!lines.length) console.log('  (nothing changed)');
  else console.log(lines.join('\n'));
}
