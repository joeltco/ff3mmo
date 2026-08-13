#!/usr/bin/env node
// check-dialogue-fit.mjs — every dialogue page must FIT THE BOX.
//
// The message box is 144px wide (16 glyphs a line) and 48px tall with text
// centred at 12px per line. Two lines sit comfortably; three are flush against
// the border; FOUR start above the interior, which draws the words outside the
// box. That shipped in v1.7.971 because the pages were checked by counting
// characters (<=48) instead of running the wrapper — word wrap turns a 37-char
// line into four lines easily.
//
// This runs the REAL `_wrapMsgBytes` from message-box.js, via the exported
// `msgLineCount`, over every page in the game.
//
//   node tools/check-dialogue-fit.mjs

// message-box.js pulls in ui-state.js, which touches `window` at module load.
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };

globalThis.document = { createElement: () => ({ getContext: () => ({}) }), addEventListener() {} };

const { _nameToBytes } = await import('../src/text-utils.js');
const { msgLineCount, MSG_MAX_LINES, MSG_MAX_CHARS } = await import('../src/message-box.js');
const { TOWN_NPCS } = await import('../src/data/town-npcs.js');
const { QUESTS } = await import('../src/data/quests.js');

let failed = 0, checked = 0;
const check = (where, page) => {
  checked++;
  const n = msgLineCount(_nameToBytes(page));
  if (n > MSG_MAX_LINES) {
    console.error(`  ✗ ${where}: wraps to ${n} lines (max ${MSG_MAX_LINES})`);
    console.error(`      "${page}"`);
    failed++;
  }
};

for (const [mapId, list] of TOWN_NPCS) {
  for (const e of list) {
    for (const page of e.spec.dialogue || []) check(`map ${mapId} ${e.key}`, page);
  }
}
for (const q of Object.values(QUESTS)) {
  for (const stage of ['offer', 'active', 'complete', 'done']) {
    for (const page of q[stage] || []) check(`quest ${q.id}.${stage}`, page);
  }
}

if (failed) {
  console.error(`\ncheck-dialogue-fit: FAIL — ${failed} of ${checked} pages overflow the box ` +
                `(${MSG_MAX_CHARS} chars x ${MSG_MAX_LINES} lines)`);
  process.exit(1);
}
console.log(`check-dialogue-fit: OK — all ${checked} pages fit in ${MSG_MAX_LINES} lines`);
