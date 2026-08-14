#!/usr/bin/env node
// check-word-flow.mjs — WALK the Ur word chain, key by key.
//
// check-words.mjs proves the data is wired up. This one proves the MENU works:
// it imports the real word-menu.js and drives it with the same key objects
// movement.js passes, from "learn BROTHER off ur_npc_09" through "ask the
// quest giver about it" to ACCEPT and a live ps.quests entry.
//
// A gate that only reads data would have passed every version of this file
// where the rows were built but Z did nothing.
//
//   node tools/check-word-flow.mjs

globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.document = {
  createElement: () => ({ getContext: () => ({}), style: {}, width: 0, height: 0 }),
  addEventListener() {}, getElementById: () => null,
};

const wm       = await import('../src/word-menu.js');
const { ps }   = await import('../src/player-stats.js');
const { mapSt } = await import('../src/map-state.js');
const { TOWN_NPCS } = await import('../src/data/town-npcs.js');
const { msgState } = await import('../src/message-box.js');
// `knownWords()` rather than a `hasWord` seam: it is what `_askRows` actually
// calls to build the list, so this asserts the path the game runs. hasWord was
// exported for this gate alone and is module-private again as of v1.8.7.
const { knownWords } = await import('../src/word-memory.js');
const hasWord = (id) => knownWords().includes(id);
const { talkQuest } = await import('../src/quests.js');

const fail = [];
const err = (m) => fail.push(m);
const spec = (mapId, key) => {
  const e = (TOWN_NPCS.get(mapId) || []).find(n => n.key === key);
  if (!e) throw new Error(`no NPC ${key} on map ${mapId}`);
  return e.spec;
};
// A stand-in for the runtime NPC object talkToNpc hands the menu.
const npcOf = (mapId, key) => ({ key, scene: spec(mapId, key) });

// The menu only takes input while the box is parked on a page with nothing
// left to advance — that's the state showMsgBoxPages(keepOpen) leaves behind.
// Here we jump straight to it rather than tick real slide/scroll timers.
function settle() {
  if (msgState.state === 'none') return;
  // Page through everything the menu just queued — a multi-page reply leaves
  // onAdvance set, and the menu deliberately ignores keys until it clears.
  for (let i = 0; i < 32 && msgState.onAdvance; i++) msgState.onAdvance();
  if (msgState.state !== 'none') {
    msgState.state = 'hold';
    msgState.typed = msgState.bytes ? msgState.bytes.length : 0;
  }
}
const press = (k) => { const keys = { [k]: true }; wm.handleWordMenuInput(keys); settle(); };
const labels = () => wm.wordMenuSt.rows.map(r => r.label);
const pick = (label) => {
  const i = wm.wordMenuSt.rows.findIndex(r => r.label === label);
  if (i < 0) { err(`no "${label}" row — saw [${labels().join(', ')}]`); return false; }
  wm.wordMenuSt.index = i;
  press('z');
  return true;
};

ps.words = {};
ps.quests = {};
mapSt.currentMapId = 114;

// ── 1. LEARN off the man who says it, ONE WORD AT A TIME ─────────────────
// v1.8.8: a teacher who knows two words opens a choice instead of handing both
// over. ur_npc_09 says "Mind the cave north. It took my brother." — two terms,
// and the player takes them one at a time.
const teacher = npcOf(114, 'ur_npc_09');   // "It took my brother."
msgState.state = 'hold'; msgState.bytes = new Uint8Array([0]);
if (!wm.openWordMenu(teacher, () => {})) err('ur_npc_09 offers no menu at all');
if (!labels().includes('LEARN')) err(`ur_npc_09 has no LEARN row — saw [${labels().join(', ')}]`);
pick('LEARN');
if (!labels().includes('BROTHER') || !labels().includes('CAVE')) {
  err(`LEARN did not offer the two words to choose from — saw [${labels().join(', ')}]`);
}
if (hasWord('brother') || hasWord('cave')) err('opening the LEARN list already took a word');
pick('BROTHER');
if (!hasWord('brother')) err('picking BROTHER did not store it');
if (hasWord('cave')) err('picking BROTHER also took CAVE — LEARN must take one word');
// The row is still there for the word not yet taken.
if (!labels().includes('LEARN')) err('LEARN vanished with a word still unlearned');
// With ONE word left there is no choice to make, so LEARN takes it directly
// rather than opening a one-row menu. (Flipping word-menu.js to always-list
// would make this a two-step; the assertion below is the behaviour we ship.)
pick('LEARN');
if (!hasWord('cave')) err('the last LEARN did not store CAVE');
if (labels().includes('LEARN')) err('LEARN row survived being emptied — it would teach forever');
wm.closeWordMenu();

// ── 1b. A word EARNED by asking, not volunteered ─────────────────────────
// The one real chain in Ur (v1.8.8): nobody teaches VEIN. The tavern miner
// hands it over when asked about CAVE — "The vein and the cave are the same
// dark." — and only then does it appear in the ASK list.
msgState.state = 'hold'; msgState.bytes = new Uint8Array([0]);
const miner = npcOf(9, 'ur_tavern_drinker_b');
wm.openWordMenu(miner, () => {});
if (labels().includes('LEARN')) err('the miner volunteers a word — VEIN must be earned by asking');
if (hasWord('vein')) err('VEIN was known before anyone was asked about the cave');
pick('ASK');
pick('CAVE');
settle();
if (!hasWord('vein')) err('asking the miner about CAVE did not hand over VEIN');
wm.closeWordMenu();
msgState.state = 'hold'; msgState.bytes = new Uint8Array([0]);
wm.openWordMenu(miner, () => {});
pick('ASK');
if (!labels().includes('VEIN')) err(`VEIN is not in the ASK list after being earned — saw [${labels().join(', ')}]`);
wm.closeWordMenu();

// ── 2. ASK the wrong person: listed, greyed, answered with a shrug ────────
msgState.state = 'hold'; msgState.bytes = new Uint8Array([0]);
const bystander = npcOf(114, 'ur_npc_0d');
wm.openWordMenu(bystander, () => {});
pick('ASK');
// VEIN has been earned by now (step 1b), so it IS listed — and ur_npc_0d has
// no answer for it, which is the greying case checked below.
const veinRow = wm.wordMenuSt.rows.find(r => r.id === 'vein');
if (!veinRow) err('VEIN is missing from the ASK list after being earned');
else if (veinRow.has !== false) err('ur_npc_0d cannot answer VEIN; the row should be greyed');
const caveRow = wm.wordMenuSt.rows.find(r => r.id === 'cave');
if (!caveRow || caveRow.has !== true) err('ur_npc_0d answers CAVE but the row is not marked answerable');
const brotherRow = wm.wordMenuSt.rows.find(r => r.id === 'brother');
if (!brotherRow || brotherRow.has !== false) err('ur_npc_0d cannot answer BROTHER; the row should be greyed');
wm.closeWordMenu();

// ── 3. Plain talk must NOT hand out a word-gated quest ───────────────────
// Before the word gate, walking up to the giver accepted the quest outright.
// If that ever comes back, the whole chain is decoration.
if (talkQuest(114, 'ur_npc_05', () => {}) !== null) {
  err('talking to the giver returned quest pages without the start word');
}
if (ps.quests.ur_missing_brother) err('talking to the giver started the quest without ASK');

// ── 4. Carry the word to the giver: offer, DENY, then ACCEPT ─────────────
msgState.state = 'hold'; msgState.bytes = new Uint8Array([0]);
const giver = npcOf(114, 'ur_npc_05');
wm.openWordMenu(giver, () => {});
pick('ASK');
pick('BROTHER');
if (!labels().includes('ACCEPT') || !labels().includes('DENY')) {
  err(`asking the giver about BROTHER did not offer the quest — saw [${labels().join(', ')}]`);
}
pick('DENY');
if (ps.quests.ur_missing_brother) err('DENY started the quest anyway');

pick('ASK');
pick('BROTHER');
pick('ACCEPT');
const e = ps.quests.ur_missing_brother;
if (!e || e.s !== 'active' || e.n !== 0) err(`ACCEPT did not start the quest (got ${JSON.stringify(e)})`);
wm.closeWordMenu();

// ── 5. Someone with nothing to say opens no menu ─────────────────────────
if (wm.openWordMenu({ key: 'nobody', scene: { dialogue: ['Hi.'] } }, () => {})) {
  err('a wordless NPC opened the menu — the box would hang on an empty list');
}

if (fail.length) {
  for (const m of fail) console.error(`  ✗ ${m}`);
  console.error(`\ncheck-word-flow: FAIL — ${fail.length} problem(s)`);
  process.exit(1);
}
console.log('check-word-flow: OK — learn -> ask -> offer -> deny -> accept walks end to end');
