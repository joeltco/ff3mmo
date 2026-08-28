#!/usr/bin/env node
// audit-word-matrix.mjs — the ASK table, printed.
//
// check-words proves each term HAS a teacher and an answerer. It cannot show
// what the vocabulary actually feels like to use: how many of the 52 placed
// people answer anything at all, how many terms do something rather than say
// something, and which answers only ever exist in one story state.
import { createCanvas } from '@napi-rs/canvas';
globalThis.document = { createElement: (t) => (t === 'canvas' ? createCanvas(1, 1) : {}) };
const { KEYWORDS } = await import('../src/data/keywords.js');
const { TOWN_NPCS, GENERATED_NPCS } = await import('../src/data/town-npcs.js');
const { QUESTS } = await import('../src/data/quests.js');
const { allPageSets, isVariantList } = await import('../src/data/dialogue.js');

const placed = [];
for (const [mapId, list] of TOWN_NPCS) for (const e of list) placed.push({ mapId, ...e });
for (const [mapId, list] of GENERATED_NPCS) for (const e of list) placed.push({ mapId, ...e });

const startWords = new Map();
for (const q of Object.values(QUESTS)) if (q.startWord) startWords.set(q.startWord, q.id);

for (const term of Object.keys(KEYWORDS)) {
  const teach = [], ans = [];
  for (const p of placed) {
    if ((p.spec.teaches || []).includes(term)) teach.push(`${p.key}(map ${p.mapId})`);
    const a = p.spec.answers && p.spec.answers[term];
    if (!a) continue;
    const sets = isVariantList(a) ? allPageSets(a) : [Array.isArray(a) ? a : a.pages];
    const gains = !isVariantList(a) && !Array.isArray(a) && a.teaches ? ` +teaches ${a.teaches.toUpperCase()}` : '';
    const gated = isVariantList(a) ? ` [${a.map(v => v.when || 'default').join(' | ')}]` : '';
    ans.push(`    ${p.key.padEnd(22)}${gains}${gated}\n` +
      sets.map(s => '        ' + s.map(x => `"${x}"`).join(' / ')).join('\n'));
  }
  const q = startWords.get(term);
  console.log(`\n■ ${KEYWORDS[term].text}${q ? `   ⇒ STARTS QUEST ${q}` : '   (flavour only — starts nothing)'}`);
  console.log(`  taught by : ${teach.join(', ') || '(NOBODY — unlearnable)'}`);
  console.log(`  answered  : ${ans.length} of ${placed.length} people`);
  console.log(ans.join('\n') || '    (nobody)');
}

// Who participates in the word system at all?
const wordy = placed.filter(p => (p.spec.teaches || []).length || Object.keys(p.spec.answers || {}).length);
console.log(`\n── ${wordy.length} of ${placed.length} placed people have ANY word behaviour.`);
console.log('   silent on every term: ' + placed.filter(p => !wordy.includes(p)).map(p => p.key).join(', '));
