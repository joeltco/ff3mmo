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
const { allPageSets, isVariantList } = await import('../src/data/dialogue.js');
const { QUESTS } = await import('../src/data/quests.js');
// Prose moved out of the server's table — read it where it lives now.
const { stagePages, asidePages, asideKeys } = await import('../src/data/script.js');

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

// ⛔ EVERY VARIANT, not the one that happens to be showing. Lines may be
// state-dependent (`[{ when, pages }, ...]`, data/dialogue.js), and a variant
// that only appears after the curse lifts still has to fit the box — it would
// otherwise overflow for the first time in front of a player who got that far.
for (const [mapId, list] of TOWN_NPCS) {
  for (const e of list) {
    for (const pages of allPageSets(e.spec.dialogue)) {
      for (const page of pages || []) check(`map ${mapId} ${e.key}`, page);
    }
    // ASK replies go through the same box.
    // An answer is bare pages, or `{ pages, teaches }` when asking about it
    // hands over the next term (v1.8.8), or a variant list. All render here.
    for (const [term, a] of Object.entries(e.spec.answers || {})) {
      const sets = isVariantList(a) ? allPageSets(a)
                 : [Array.isArray(a) ? a : (a && a.pages) || []];
      for (const pages of sets) {
        for (const page of pages || []) check(`map ${mapId} ${e.key} answers.${term}`, page);
      }
    }
  }
}
// Quest pages carry {n} / {count} / {left} progress tokens (v1.8.6), filled in
// by quests.js#talkQuest. Check the RAW page and every expansion: raw happens
// to be the wider string for a single-digit objective, and relying on that
// silently stops being true the day a quest wants 12 of something.
const _expansions = (page, stage) => {
  const total = stage && stage.objective ? (stage.objective.count | 0) : 0;
  const out = [page];
  for (let n = 0; n <= total; n++) {
    out.push(String(page).replace(/\{n\}/g, String(n))
                         .replace(/\{count\}/g, String(total))
                         .replace(/\{left\}/g, String(total - n)));
  }
  return out;
};
// ⛔ EVERY page a quest can put on screen, from every stage — including `also`
// (what the quest's OTHER people say mid-stage) and `after`. A page that only
// appears on one branch still has to fit the box.
for (const q of Object.values(QUESTS)) {
  for (const stage of q.stages || []) {
    for (const part of ['offer', 'accepted', 'denied', 'say', 'onAdvance']) {
      for (const page of stagePages(q.id, stage.id, part) || []) {
        for (const variant of _expansions(page, stage)) check(`quest ${q.id}.${stage.id}.${part}`, variant);
      }
    }
    for (const npcKey of asideKeys(q.id, stage.id)) {
      for (const page of asidePages(q.id, stage.id, npcKey) || []) {
        for (const variant of _expansions(page, stage)) check(`quest ${q.id}.${stage.id}.also.${npcKey}`, variant);
      }
    }
  }
  // ⛔ No `after` block to walk: a quest's parting line is now a flag-guarded
  // variant on the person's own row, and the TOWN_NPCS pass above already wraps
  // every variant of every spec.
}

if (failed) {
  console.error(`\ncheck-dialogue-fit: FAIL — ${failed} of ${checked} pages overflow the box ` +
                `(${MSG_MAX_CHARS} chars x ${MSG_MAX_LINES} lines)`);
  process.exit(1);
}
console.log(`check-dialogue-fit: OK — all ${checked} pages fit in ${MSG_MAX_LINES} lines`);
