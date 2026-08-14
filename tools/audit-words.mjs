#!/usr/bin/env node
// audit-words.mjs — push on the Word Memory system, rather than confirming the
// path it was built along.
//
// `check-words.mjs` is a good gate and passes: every term has a teacher and an
// answerer among PLACED NPCs, every teacher says their own word, the LEARN line
// fits the box, and ps.words survives all five persistence hops. What it does
// not ask is whether the SYSTEM does what its own design notes claim — whether
// a word ever gates another word, whether a learned word survives a force-quit,
// whether an authored answer can be reached at all.
//
// Findings print as [HOLE]; each is reproduced with the real modules.
//
//   node tools/audit-words.mjs

import fs from 'node:fs';

globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
// message-box.js pulls in data/strings.js, which reads a DOM node at module
// load — the shim needs getElementById or the import throws.
globalThis.document = {
  createElement: () => ({ getContext: () => ({}) }),
  getElementById: () => null,
  addEventListener() {},
};

const { ps } = await import('../src/player-stats.js');
const { KEYWORDS } = await import('../src/data/keywords.js');
const { TOWN_NPCS } = await import('../src/data/town-npcs.js');
const { QUESTS } = await import('../src/data/quests.js');
const wm = await import('../src/word-memory.js');

const holes = [];
const pendings = [];
const hole = (title, detail) => { holes.push(title); console.log(`\n[HOLE] ${title}\n       ${detail}`); };
// A known-open DESIGN item, not a defect: printed every run so it cannot be
// quietly forgotten, but it does not fail the deploy, because closing it means
// re-authoring who in Ur knows what and that is a decision, not a fix. Anything
// that IS a defect must use hole() and fail.
const pending = (title, detail) => { pendings.push(title); console.log(`\n[OPEN — design] ${title}\n       ${detail}`); };
const okay = (m) => console.log(`  ok   ${m}`);

const raw = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
// Source checks read CODE, never comments — a gate a comment can satisfy is not
// a gate (learned the hard way in the v1.8.6 quest audit).
const _strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const src = (p) => _strip(raw(p));

// The placed cast, which is the only cast that matters — town-npcs.js exports
// people the maps have no sprite bundle for.
const placed = [];
for (const [mapId, list] of TOWN_NPCS) for (const e of list) placed.push({ mapId, ...e });
if (placed.length < 10) { console.error(`harness self-test FAILED: only ${placed.length} placed NPCs`); process.exit(2); }
okay(`${placed.length} placed NPCs, ${Object.keys(KEYWORDS).length} terms`);

// ── 1. a learned word is not written down ─────────────────────────────────
console.log('\n── 1. does LEARN survive the tab closing?');
{
  const learnPath = src('src/word-menu.js') + src('src/word-memory.js');
  if (/saveSlotsToDB\s*\(/.test(learnPath)) okay('the LEARN path persists ps.words');
  else {
    ps.words = {};
    const lastSave = JSON.parse(JSON.stringify(ps.words));   // what save-state.js last wrote
    const teacher = placed.find(p => (p.spec.teaches || []).length);
    for (const id of wm.learnableFrom(teacher.spec)) wm.learnWord(id);
    const learned = wm.knownWords();
    // The force-quit: nothing called saveSlotsToDB, so the reload restores the
    // last written blob. On iOS `beforeunload` never fires, so this is a swipe.
    ps.words = wm.sanitizeWords(lastSave);
    hole('a learned word is lost if the player closes the tab',
      `learned [${learned.join(', ')}] from ${teacher.key}, reloaded, vocabulary is ` +
      `[${wm.knownWords().join(', ')}]. learnWord mutates ps.words and nothing on the LEARN ` +
      `path calls saveSlotsToDB — the next save (a battle, a map change) happens to write it, ` +
      `so the loss is invisible until someone learns a word and stops playing.`);
  }
}

// ── 2. is the vocabulary a CHAIN, or four loose words? ────────────────────
// word-menu.js says: "An answer can hand over the next term — that's the FF2
// chain, and it's why the verb list is rebuilt (not restored) when the reply
// closes." That is the claim. FF2's whole structure is word -> person -> word.
console.log('\n── 2. does any word gate any other word?');
{
  // A term is GATED if it cannot be obtained with an empty vocabulary — i.e.
  // reaching it requires having asked something first.
  ps.words = {};
  const freeFromTheStart = [];
  for (const term of Object.keys(KEYWORDS)) {
    for (const p of placed) {
      // learnableFrom is the only thing that puts a LEARN row on screen, and it
      // reads the NPC's static `teaches` — never what the player asked.
      if (wm.learnableFrom(p.spec).includes(term)) { freeFromTheStart.push(term); break; }
    }
  }
  const answersCanTeach = placed.some(p => Object.values(p.spec.answers || {})
    .some(a => !Array.isArray(a)));          // a richer shape than pages[] would be needed
  const gated = Object.keys(KEYWORDS).filter(t => !freeFromTheStart.includes(t));
  if (gated.length || answersCanTeach) {
    okay(`${gated.length} term(s) are gated behind asking: ${gated.join(', ') || '(shape supports it)'}`);
  } else {
    pending('no word gates any other word — the "chain" does not exist',
      `all ${freeFromTheStart.length} terms (${freeFromTheStart.join(', ')}) are learnable from an empty ` +
      `vocabulary by walking up to the right person and pressing LEARN. An answer is authored as ` +
      `pages[] and nothing else, so there is no way to author "asking X about Y teaches you Z" — ` +
      `the shape word-menu.js's own comment describes cannot be expressed. What is left is a lookup ` +
      `table: the ONLY thing any term unlocks is ${Object.values(QUESTS).filter(q => q.startWord).length} quest offer.`);
  }

  // Second half of the same problem: one LEARN press empties the NPC.
  const multi = placed.filter(p => (p.spec.teaches || []).length > 1);
  if (multi.length) {
    const code = src('src/word-menu.js');
    if (/row\.ids\.filter\(id => learnWord\(id\)\)/.test(code)) {
      pending('one LEARN press takes every word an NPC has',
        multi.map(p => `${p.key} teaches ${(p.spec.teaches || []).join(' + ')}`).join('; ') +
        '. FF2 makes you pick the word out of the sentence; here the single LEARN row hands over ' +
        'the whole set, which is the same flattening as above seen from the other side.');
    }
  }
}

// ── 3. client and server disagree about what a word is ────────────────────
console.log('\n── 3. persistence clamps');
{
  const { _testValidateSaveData } = await import('../api.js');
  const forged = { words: { brother: 1, not_a_term: 1, ['x'.repeat(60)]: 1 } };
  const server = _testValidateSaveData(forged).data.words || {};
  const client = wm.sanitizeWords(forged.words);
  const extra = Object.keys(server).filter(k => !(k in client));
  if (extra.length) {
    hole('the server keeps word ids the client throws away',
      `server kept ${JSON.stringify(Object.keys(server))}, client keeps ${JSON.stringify(Object.keys(client))}. ` +
      `api.js shape-validates (any string <= 64 chars, 256 of them) because "the server doesn't import ` +
      `the client's keyword table" — but data/keywords.js has ZERO imports and data/quests.js is already ` +
      `imported there for exactly this reason (v1.8.6). The two halves of one save disagree on what is legal.`);
  } else okay('client and server agree on which term ids are legal');
}

// ── 4. dead API ───────────────────────────────────────────────────────────
// "Is the name mentioned anywhere" is not the question — a local
// `const hasWord = (id) => ...` in a harness satisfies that while the real
// export sits unused, which is exactly what happened on the first pass here.
// The question is whether anything IMPORTS it from word-memory.js.
console.log('\n── 4. unused exports');
{
  const files = fs.readdirSync(new URL('../src', import.meta.url), { recursive: true })
    .filter(f => String(f).endsWith('.js') && !String(f).endsWith('word-memory.js'))
    .map(f => 'src/' + f);
  const toolFiles = fs.readdirSync(new URL('../tools', import.meta.url))
    .filter(f => /\.(js|mjs|cjs)$/.test(String(f)) && !String(f).startsWith('audit-words'))
    .map(f => 'tools/' + f);
  const imported = new Set();
  for (const f of [...files, ...toolFiles, 'api.js']) {
    let code; try { code = src(f); } catch { continue; }
    // `import { a, b } from '...word-memory.js'` and the await-import form.
    const re = /(?:import|const)\s*\{([^}]*)\}\s*(?:=\s*await\s+import\(|from\s*)['"][^'"]*word-memory\.js['"]/g;
    for (const m of code.matchAll(re)) {
      for (const name of m[1].split(',')) {
        const n = name.split(/\s+as\s+/)[0].trim();
        if (n) imported.add(n);
      }
    }
  }
  const names = [...src('src/word-memory.js').matchAll(/^export function (\w+)/gm)].map(m => m[1]);
  const dead = names.filter(n => !imported.has(n));
  if (dead.length) hole(`src/word-memory.js exports nothing imports: ${dead.join(', ')}`,
    'exported and imported by no module in src/, tools/ or api.js — reads as live API, is not.');
  else okay(`all ${names.length} word-memory exports are imported somewhere`);
}

// ── 5. can every authored answer actually be reached? ─────────────────────
// The two ways an NPC opens a shop are DISJOINT, and word behaviour depends on
// them staying that way:
//   - the keepers in TOWN_NPCS are ordinary talkable NPCs; the shop opens from
//     the counter TILE, so `answers` on them works normally.
//   - `addBlackMageShopkeeper` makes an NPC with `shopId`, and talkToNpc calls
//     openShop and RETURNS before the verb menu. It takes no spec, so nothing
//     can be authored on it — but only because `addSceneNpc` does not forward
//     `spec.shopId`. Both halves are asserted; either one changing makes word
//     behaviour on that NPC die with no error.
console.log('\n── 5. is every authored answer reachable?');
{
  const talk = src('src/npc.js');
  const shopFirst = /if \(npc\.shopId\) \{[\s\S]{0,120}?openShop\(npc\.shopId\);[\s\S]{0,40}?return;/.test(talk);
  const sceneNpc = talk.match(/export function addSceneNpc[\s\S]*?\n}/)[0];
  const forwardsShopId = /shopId/.test(sceneNpc);
  const specShops = placed.filter(p => p.spec.shopId != null);
  if (shopFirst && (forwardsShopId || specShops.length)) {
    hole('a spec-driven NPC can now open a shop, which kills its word behaviour',
      (specShops.length ? `specs carrying shopId: ${specShops.map(p => p.key).join(', ')}. ` : '') +
      (forwardsShopId ? 'addSceneNpc forwards shopId. ' : '') +
      'talkToNpc opens the shop and returns before the verb menu, so teaches/answers on that ' +
      'NPC silently never run. Reorder talkToNpc, or keep the mechanisms disjoint.');
  } else if (shopFirst) {
    okay('shop-opening and word-bearing NPCs are disjoint (addSceneNpc drops shopId)');
  } else okay('shop keepers reach the verb menu');

  // And the inverse: an answer nobody can ask, because the term has no teacher.
  const teachable = new Set();
  for (const p of placed) for (const t of p.spec.teaches || []) teachable.add(t);
  const unaskable = [];
  for (const p of placed) for (const t of Object.keys(p.spec.answers || {})) {
    if (!teachable.has(t)) unaskable.push(`${p.key}.${t}`);
  }
  if (unaskable.length) hole('authored answers for terms nobody teaches', unaskable.join(', '));
  else okay('every authored answer is for a term the player can actually hold');
}

// ── 6. the ASK list at the size it is about to be ─────────────────────────
// Behavioural, not textual: run the REAL drawWordMenu with more rows than fit
// and watch whether the arrow images are drawn. A grep for "arrow" passes on a
// leftover constant, which is exactly how the first cut of this check stayed
// green with the whole draw block deleted.
console.log('\n── 6. the ASK list as the vocabulary grows');
{
  const { ui } = await import('../src/ui-state.js');
  const menu = await import('../src/word-menu.js');
  const mb = await import('../src/message-box.js');
  const drawn = [];
  ui.ctx = { drawImage: (img) => drawn.push(img && img.__tag), fillRect() {}, drawText() {} };
  ui.scrollArrowUp = { __tag: 'up' };
  ui.scrollArrowDown = { __tag: 'down' };
  ui.cursorTileCanvas = { __tag: 'cursor', width: 16, height: 16 };
  ui.cursorFadeCanvases = [ui.cursorTileCanvas];

  const terms = Object.keys(KEYWORDS).length;
  const rows = Array.from({ length: terms + 2 }, (_, i) => ({
    label: 'TERM' + i, act: 'say', term: true, has: true,
  }));
  menu.wordMenuSt.open = true;
  menu.wordMenuSt.rows = rows;
  menu.wordMenuSt.index = 2;
  menu.wordMenuSt.scroll = 1;              // scrolled: content above AND below
  mb.msgState.state = 'hold';
  mb.msgState.onAdvance = null;
  // The arrows blink on a 250 ms wall-clock phase, so an un-pinned draw is a
  // coin flip — which is how the first run of this check reported both arrows
  // MISSING against code that draws them. Pin the ON phase, and check the OFF
  // phase too so the blink is asserted rather than assumed.
  const _realNow = Date.now;
  Date.now = () => 0;                      // ON half
  menu.drawWordMenu();
  const gotUp = drawn.includes('up'), gotDown = drawn.includes('down');
  drawn.length = 0;
  Date.now = () => 250;                    // OFF half
  menu.drawWordMenu();
  const blinksOff = !drawn.includes('up') && !drawn.includes('down');
  Date.now = _realNow;
  menu.wordMenuSt.open = false;
  if (gotUp && gotDown && !blinksOff) {
    hole('the scroll arrows do not blink',
      'they are drawn on both halves of the 250 ms phase — the shop list and pause inventory blink theirs.');
  }
  if (!gotUp || !gotDown) {
    hole('the ASK list scrolls with nothing on screen saying so',
      `drew a ${rows.length}-row list scrolled to the middle; up arrow ${gotUp ? 'drawn' : 'MISSING'}, ` +
      `down arrow ${gotDown ? 'drawn' : 'MISSING'}. The vocabulary is already ${terms} and MAX_VISIBLE is 4, ` +
      `so the next term added starts silent scrolling — a player holding six words would see four.`);
  } else okay(`scroll arrows drawn both ways at ${rows.length} rows (vocabulary is ${terms})`);
}

console.log(`\naudit-words: ${holes.length} hole(s), ${pendings.length} open design item(s)`);
for (const h of holes) console.log('  ✗ ' + h);
for (const p of pendings) console.log('  … ' + p + '  (design decision, does not fail the gate)');
process.exit(holes.length ? 1 : 0);
