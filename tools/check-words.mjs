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
const { allPageSets, isVariantList, hasDefault } = await import('../src/data/dialogue.js');
const { TOWN_NPCS } = await import('../src/data/town-npcs.js');
const { QUESTS } = await import('../src/data/quests.js');
// Stage prose lives in data/script.js since the split — data/quests.js is
// mechanics only, because the SERVER imports it.
const { stagePages } = await import('../src/data/script.js');
const { _nameToBytes } = await import('../src/text-utils.js');
const { msgLineCount, MSG_MAX_LINES } = await import('../src/message-box.js');

const fail = [];
const err = (m) => fail.push(m);

// ── Placed cast ────────────────────────────────────────────────────────────
const placed = [];
for (const [mapId, list] of TOWN_NPCS) for (const e of list) placed.push({ mapId, ...e });

// An answer is either bare pages or `{ pages, teaches }` (v1.8.8) — the second
// form is how one word gates another. Normalise once, here, so every rule below
// reads the same shape.
const answerEntry = (a) => Array.isArray(a)
  ? { pages: a, teaches: null }
  : (a && typeof a === 'object' ? { pages: a.pages, teaches: a.teaches || null } : null);

const teachers = new Map();   // term -> [who]        (volunteered via `teaches`)
const answerers = new Map();  // term -> [who]
const gatedBy = new Map();    // term -> [{ who, viaTerm }]  (earned by asking)
for (const p of placed) {
  const who = `map ${p.mapId} ${p.key}`;
  for (const t of p.spec.teaches || []) {
    if (!KEYWORDS[t]) { err(`${who} teaches unknown term "${t}"`); continue; }
    if (!teachers.has(t)) teachers.set(t, []);
    teachers.get(t).push(who);
  }
  for (const [t, rawAnswer] of Object.entries(p.spec.answers || {})) {
    if (!KEYWORDS[t]) { err(`${who} answers unknown term "${t}"`); continue; }
    // A state-dependent answer is answerable in every state it declares; each
    // variant is checked on its own so an empty branch is caught.
    if (isVariantList(rawAnswer)) {
      const sets = allPageSets(rawAnswer);
      if (!sets.length || sets.some((pg) => !Array.isArray(pg) || !pg.length)) {
        err(`${who} answers.${t} has an empty variant`); continue;
      }
      if (!hasDefault(rawAnswer)) {
        err(`${who} answers.${t} has no unguarded default — silent for anyone who has not hit the flag`);
        continue;
      }
      if (!answerers.has(t)) answerers.set(t, []);
      answerers.get(t).push(who);
      continue;
    }
    const e = answerEntry(rawAnswer);
    if (!e || !Array.isArray(e.pages) || !e.pages.length) { err(`${who} answers.${t} is empty`); continue; }
    if (!answerers.has(t)) answerers.set(t, []);
    answerers.get(t).push(who);
    if (e.teaches) {
      if (!KEYWORDS[e.teaches]) { err(`${who} answers.${t} teaches unknown term "${e.teaches}"`); continue; }
      if (e.teaches === t) { err(`${who} answers.${t} teaches "${t}" — asking for a word you already hold`); continue; }
      if (!gatedBy.has(e.teaches)) gatedBy.set(e.teaches, []);
      gatedBy.get(e.teaches).push({ who, viaTerm: t });
      // Same honesty rule LEARN has: the word must be IN what you were told.
      const said = e.pages.join(' ').toLowerCase();
      if (!said.includes(KEYWORDS[e.teaches].text.toLowerCase())) {
        err(`${who} answers.${t} hands over "${e.teaches}" but never says "${KEYWORDS[e.teaches].text}"`);
      }
    }
  }
}

// ── Every term is reachable from both ends ────────────────────────────────
for (const term of Object.keys(KEYWORDS)) {
  if (!teachers.has(term) && !gatedBy.has(term)) {
    err(`term "${term}" has NO teacher and no answer that hands it over — it can never be learned`);
  }
  if (!answerers.has(term)) err(`term "${term}" has NO answerer among placed NPCs — asking it always fails`);
}

// ── A gated term must be REACHABLE ────────────────────────────────────────
// "Earned by asking" only works if the term you have to ask about is itself
// obtainable. Walk out from the freely-taught words; anything the closure does
// not reach is a word no save can ever hold, and a cycle (A gates B gates A)
// locks both out with no error anywhere.
{
  const held = new Set(teachers.keys());
  for (let grew = true; grew;) {
    grew = false;
    for (const [term, vias] of gatedBy) {
      if (held.has(term)) continue;
      if (vias.some(v => held.has(v.viaTerm))) { held.add(term); grew = true; }
    }
  }
  for (const term of Object.keys(KEYWORDS)) {
    if (!held.has(term)) {
      const vias = (gatedBy.get(term) || []).map(v => `${v.who} via ${v.viaTerm}`).join(', ');
      err(`term "${term}" is UNREACHABLE: nobody volunteers it and the only way in is ${vias || '(nothing)'} — ` +
          `whose gating term is itself unreachable (a cycle, or a chain with no free start)`);
    }
  }
}

// ── Every term is a word an NPC actually says ─────────────────────────────
// LEARN means "take that word out of what I was just told". A term whose
// teacher never says it in their own dialogue is a word appearing from nowhere.
for (const [term, def] of Object.entries(KEYWORDS)) {
  for (const p of placed) {
    if (!(p.spec.teaches || []).includes(term)) continue;
    // ⛔ EVERY VARIANT MUST SAY IT, not just one. Lines can be state-dependent
    // now (data/dialogue.js), and a teacher whose CURSED lines name the word
    // while their restored lines do not is a teacher who silently stops being
    // one halfway through the story — the ASK list would offer LEARN on a word
    // they no longer utter. `.join(' ')` on a variant list yields
    // "[object Object]", so the old form failed every variant NPC for the wrong
    // reason.
    for (const pages of allPageSets(p.spec.dialogue)) {
      const said = (pages || []).join(' ').toLowerCase();
      if (!said.includes(def.text.toLowerCase())) {
        err(`map ${p.mapId} ${p.key} teaches "${term}" but one of their dialogue variants never says "${def.text}"`);
      }
    }
  }
}

// ── Word-gated quests ─────────────────────────────────────────────────────
for (const q of Object.values(QUESTS)) {
  if (!q.startWord) continue;
  if (!KEYWORDS[q.startWord]) { err(`quest ${q.id} startWord "${q.startWord}" is not a term`); continue; }
  if (!teachers.has(q.startWord)) err(`quest ${q.id} can never be started: nobody teaches "${q.startWord}"`);
  // ⛔ The START WORD is put to STAGE 0's NPC, not to "the giver" — a quest has
  // several people now and only the first can be asked to open it.
  const s0 = (q.stages || [])[0];
  if (!s0 || !s0.at) { err(`quest ${q.id} has no stage 0`); continue; }
  const giver = placed.find(p => p.mapId === s0.at.map && p.key === s0.at.npc);
  if (!giver) { err(`quest ${q.id} stage-0 NPC ${s0.at.npc} is not placed on map ${s0.at.map}`); continue; }
  // The ASK list greys out terms the NPC has no answer for. Without an entry
  // the giver's own start word reads as a dead end right up until you pick it.
  if (!(giver.spec.answers || {})[q.startWord]) {
    err(`quest ${q.id} stage-0 NPC has no answers.${q.startWord} — the start word looks unanswerable in the ASK list`);
  }
  for (const part of ['offer', 'accepted', 'denied']) {
    const pages = stagePages(q.id, s0.id, part);
    if (!Array.isArray(pages) || !pages.length) err(`quest ${q.id} stage 0 is missing ${part} pages`);
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
            `${teachers.size} volunteered, ${gatedBy.size} earned by asking, ` +
            `${answerers.size} answerable, persistence intact`);
