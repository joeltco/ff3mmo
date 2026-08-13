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
const { hasWord } = await import('../src/word-memory.js');
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

// ── 1. LEARN off the man who says it ──────────────────────────────────────
const teacher = npcOf(114, 'ur_npc_09');   // "It took my brother."
msgState.state = 'hold'; msgState.bytes = new Uint8Array([0]);
if (!wm.openWordMenu(teacher, () => {})) err('ur_npc_09 offers no menu at all');
if (!labels().includes('LEARN')) err(`ur_npc_09 has no LEARN row — saw [${labels().join(', ')}]`);
pick('LEARN');
if (!hasWord('brother')) err('LEARN did not store BROTHER');
if (!hasWord('cave'))    err('LEARN did not store CAVE');
if (labels().includes('LEARN')) err('LEARN row survived being taken — it would teach forever');
wm.closeWordMenu();

// ── 2. ASK the wrong person: listed, greyed, answered with a shrug ────────
msgState.state = 'hold'; msgState.bytes = new Uint8Array([0]);
const bystander = npcOf(114, 'ur_npc_0d');
wm.openWordMenu(bystander, () => {});
pick('ASK');
// VEIN is taught in the tavern and hasn't been learned — it must not be listed.
if (wm.wordMenuSt.rows.find(r => r.id === 'vein')) err('VEIN is listed without having been learned');
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
