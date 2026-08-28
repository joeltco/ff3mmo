#!/usr/bin/env node
// check-script-split.mjs — prose stays OUT of the file the server boots from.
//
// `data/quests.js` is imported by `api.js` and `economy-arbiter.js` so the
// SERVER validates claims against the same table the client uses. Until the
// split it was also roughly 45% English: the process that decides whether a
// player gets paid carried the King's dialogue around, and no line could be
// rewritten without touching a file two server modules boot from.
//
// This gate pins the separation in both directions:
//   1. `data/quests.js` declares no prose field.
//   2. Nothing the server imports can reach `data/script.js`.
//   3. Both data leaves stay import-free.
//   4. Every stage that needs pages HAS them, so the split lost nothing.
//
//   node tools/check-script-split.mjs

import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
// ⛔ CODE, NEVER COMMENTS. `audit-quests` learned this the expensive way: a
// gate that greps the raw file passes on a reverted fix, because the comment
// above the deleted code still names the symbol.
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

let failed = 0;
const bad = (m) => { console.error(`  ✗ ${m}`); failed++; };
const ok  = (m) => console.log(`  ✓ ${m}`);

// ── 1. no prose in the server's table ─────────────────────────────────────
const PROSE_FIELDS = ['offer', 'accepted', 'denied', 'say', 'onAdvance', 'also', 'after', 'voice'];
const questsSrc = strip(read('src/data/quests.js'));
for (const f of PROSE_FIELDS) {
  // A declaration, not a mention: `offer:` as an object key.
  const re = new RegExp(`(^|[{,\\s])${f}\\s*:`, 'm');
  if (re.test(questsSrc)) bad(`data/quests.js declares a \`${f}:\` field — prose belongs in data/script.js`);
}
if (!failed) ok(`data/quests.js declares none of: ${PROSE_FIELDS.join(', ')}`);

// ⛔ WALK THE LOADED DATA, not the source text. The first cut of this check
// regexed `'[^']{16,}'` over the file and matched from one string's CLOSING
// quote to the next string's OPENING quote — 33 "sentences" that were really
// spans of code. A prose field can also be named anything, so a field-name
// blocklist alone is not enough: what makes a value prose is that it reads like
// a sentence, wherever it is hiding.
const { QUESTS: _Q } = await import('../src/data/quests.js');
const proseValues = [];
(function walkValues(v, path) {
  if (typeof v === 'string') {
    // Ids, flags, zone keys and stage names are short and unspaced. A page has
    // a space and is long enough to be a line somebody says.
    if (v.length >= 12 && /\s/.test(v)) proseValues.push(`${path} = ${JSON.stringify(v)}`);
    return;
  }
  if (Array.isArray(v)) return v.forEach((x, i) => walkValues(x, `${path}[${i}]`));
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walkValues(x, `${path}.${k}`);
})(_Q, 'QUESTS');
if (proseValues.length) bad(`data/quests.js still holds ${proseValues.length} sentence-like value(s): ${proseValues.slice(0, 3).join(' | ')}`);
else ok('no value anywhere in QUESTS reads like a sentence');

// ── 2. the server cannot reach the script ─────────────────────────────────
// Walk what the server actually imports, transitively, and fail if script.js
// is anywhere in that closure. Naming the entry points by hand is the point:
// adding a server module means adding it here.
const SERVER_ENTRIES = ['api.js', 'economy-arbiter.js', 'ws-presence.js', 'server.js', 'pve-arbiter.js'];
const seen = new Set();
const reaches = [];
function walk(path, chain) {
  if (seen.has(path)) return;
  seen.add(path);
  let src;
  try { src = strip(read(path)); } catch { return; }
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) {
    // Resolve the relative specifier against this file's directory.
    const parts = (dir ? dir.split('/') : []).concat(m[1].split('/'));
    const out = [];
    for (const p of parts) {
      if (p === '.' || p === '') continue;
      if (p === '..') out.pop(); else out.push(p);
    }
    const next = out.join('/');
    if (next.endsWith('data/script.js')) reaches.push(`${chain} -> ${next}`);
    walk(next, `${chain} -> ${next}`);
  }
}
for (const e of SERVER_ENTRIES) { seen.clear(); walk(e, e); }
if (reaches.length) for (const r of reaches) bad(`a SERVER module reaches the script: ${r}`);
else ok(`none of ${SERVER_ENTRIES.length} server entry points reaches data/script.js`);

// ── 3. both leaves stay import-free ───────────────────────────────────────
for (const leaf of ['src/data/quests.js', 'src/data/flags.js', 'src/data/keywords.js']) {
  const imports = strip(read(leaf)).match(/^\s*import\s/gm) || [];
  if (imports.length) bad(`${leaf} has ${imports.length} import(s) — it must stay an import-free leaf`);
  else ok(`${leaf} is import-free`);
}

// ── 4. the split lost nothing ─────────────────────────────────────────────
const { QUESTS } = await import('../src/data/quests.js');
const { stagePages } = await import('../src/data/script.js');
for (const q of Object.values(QUESTS)) {
  const stages = q.stages || [];
  stages.forEach((st, i) => {
    // Stage 0 ends in a CHOICE; every later stage ends in a STEP.
    const need = i === 0 ? ['offer', 'accepted', 'denied'] : ['onAdvance'];
    for (const f of need) {
      const pages = stagePages(q.id, st.id, f);
      if (!Array.isArray(pages) || !pages.length) bad(`${q.id}/${st.id}: no \`${f}\` pages in data/script.js`);
    }
  });
}
if (!failed) ok('every stage still has the pages its shape requires');

if (failed) { console.error(`\ncheck-script-split: FAIL — ${failed} problem(s)`); process.exit(1); }
console.log('\ncheck-script-split: OK — prose and mechanics are separated, and the server cannot see the script');
