#!/usr/bin/env node
// check-words.mjs — the Word Memory chain must be WALKABLE and PERSISTED.
//
// A Key Term is only worth having if some NPC the player can actually stand in
// front of teaches it, and some NPC answers it. A term with no teacher can
// never be learned; a term with no answerer is a menu row that always says
// "I know nothing about that." Both are invisible in play until someone hunts
// the whole town for a word that was never there.
//
// "Actually stand in front of" means placed in TOWN_NPCS — the spec objects
// exported from town-npcs.js include people who are defined but not placed
// (Ur's ROM roster is ten, the map holds five sprite bundles), so checking the
// exports instead of the placement table would pass on an unreachable teacher.
//
//   node tools/check-words.mjs

import { readFileSync } from 'node:fs';

globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.document = { createElement: () => ({ getContext: () => ({}) }), addEventListener() {} };

const { KEYWORDS } = await import('../src/data/keywords.js');
const { TOWN_NPCS } = await import('../src/data/town-npcs.js');
const { QUESTS } = await import('../src/data/quests.js');
const { _nameToBytes } = await import('../src/text-utils.js');
const { msgLineCount, MSG_MAX_LINES } = await import('../src/message-box.js');

const fail = [];
const err = (m) => fail.push(m);

// ── Placed cast ────────────────────────────────────────────────────────────
const placed = [];
for (const [mapId, list] of TOWN_NPCS) for (const e of list) placed.push({ mapId, ...e });

const teachers = new Map();   // term -> [who]
const answerers = new Map();  // term -> [who]
for (const p of placed) {
  const who = `map ${p.mapId} ${p.key}`;
  for (const t of p.spec.teaches || []) {
    if (!KEYWORDS[t]) { err(`${who} teaches unknown term "${t}"`); continue; }
    if (!teachers.has(t)) teachers.set(t, []);
    teachers.get(t).push(who);
  }
  for (const [t, pages] of Object.entries(p.spec.answers || {})) {
    if (!KEYWORDS[t]) { err(`${who} answers unknown term "${t}"`); continue; }
    if (!Array.isArray(pages) || !pages.length) { err(`${who} answers.${t} is empty`); continue; }
    if (!answerers.has(t)) answerers.set(t, []);
    answerers.get(t).push(who);
  }
}

// ── Every term is reachable from both ends ────────────────────────────────
for (const term of Object.keys(KEYWORDS)) {
  if (!teachers.has(term))  err(`term "${term}" has NO teacher among placed NPCs — it can never be learned`);
  if (!answerers.has(term)) err(`term "${term}" has NO answerer among placed NPCs — asking it always fails`);
}

// ── Every term is a word an NPC actually says ─────────────────────────────
// LEARN means "take that word out of what I was just told". A term whose
// teacher never says it in their own dialogue is a word appearing from nowhere.
for (const [term, def] of Object.entries(KEYWORDS)) {
  for (const p of placed) {
    if (!(p.spec.teaches || []).includes(term)) continue;
    const said = (p.spec.dialogue || []).join(' ').toLowerCase();
    if (!said.includes(def.text.toLowerCase())) {
      err(`map ${p.mapId} ${p.key} teaches "${term}" but never says "${def.text}" in their dialogue`);
    }
  }
}

// ── Word-gated quests ─────────────────────────────────────────────────────
for (const q of Object.values(QUESTS)) {
  if (!q.startWord) continue;
  if (!KEYWORDS[q.startWord]) { err(`quest ${q.id} startWord "${q.startWord}" is not a term`); continue; }
  if (!teachers.has(q.startWord)) err(`quest ${q.id} can never be started: nobody teaches "${q.startWord}"`);
  const giver = placed.find(p => p.mapId === q.giver.mapId && p.key === q.giver.npcKey);
  if (!giver) { err(`quest ${q.id} giver ${q.giver.npcKey} is not placed on map ${q.giver.mapId}`); continue; }
  // The ASK list greys out terms the NPC has no answer for. Without an entry
  // the giver's own start word reads as a dead end right up until you pick it.
  if (!(giver.spec.answers || {})[q.startWord]) {
    err(`quest ${q.id} giver has no answers.${q.startWord} — the start word looks unanswerable in the ASK list`);
  }
  for (const stage of ['offer', 'accepted', 'denied']) {
    if (!Array.isArray(q[stage]) || !q[stage].length) err(`quest ${q.id} is missing ${stage} pages`);
  }
}

// ── The LEARN confirmation is generated, so check it against the real box ──
for (const [term, def] of Object.entries(KEYWORDS)) {
  const page = `Learned the word ${def.text}.`;
  const n = msgLineCount(_nameToBytes(page));
  if (n > MSG_MAX_LINES) err(`LEARN line for "${term}" wraps to ${n} lines: "${page}"`);
}

// ── Persistence lockstep ──────────────────────────────────────────────────
// ps.words has to survive a round trip through all four hops. Missing any one
// of them and the player's vocabulary silently resets — the exact failure the
// quest whitelist rule exists for.
// Anchored to the start of the line so a commented-out hop reads as missing —
// `// out.words = w;` is exactly how this silently regresses.
const hops = [
  ['src/player-stats.js',  /^\s*words:\s*\{\}/m,            'ps.words default'],
  ['src/save-state.js',    /^\s*slot\.words\s*=/m,           'client serializer (slot.words)'],
  ['src/save-state.js',    /^\s*words:\s*s\.words/m,         'DB payload (words: s.words)'],
  ['api.js',               /^\s*out\.words\s*=/m,            'server validator (_validateSaveData)'],
  ['src/title-screen.js',  /^\s*ps\.words\s*=\s*sanitizeWords/m, 'load path (sanitizeWords)'],
];
for (const [file, re, what] of hops) {
  if (!re.test(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))) {
    err(`ps.words is not persisted: ${what} missing from ${file}`);
  }
}

if (fail.length) {
  for (const m of fail) console.error(`  ✗ ${m}`);
  console.error(`\ncheck-words: FAIL — ${fail.length} problem(s)`);
  process.exit(1);
}
console.log(`check-words: OK — ${Object.keys(KEYWORDS).length} terms, ` +
            `${teachers.size} teachable, ${answerers.size} answerable, persistence intact`);
