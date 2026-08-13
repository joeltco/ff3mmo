#!/usr/bin/env node
// check-save-lockstep.mjs — a persisted field must survive ALL FOUR hops.
//
// Spells and job levels are not wire-managed like gil and equipment: the mirror
// only snapshots them at /api/save, so their "does the server know" question is
// really "does the SAVE carry them". A save field passes through four places and
// dropping out of any one of them fails silently — the player keeps playing,
// and the value is gone at the next login:
//
//   1. ps -> slot        `slot.x = ps.x`            (save-state.js)
//   2. slot -> payload   `x: s.x`                   (save-state.js data literal)
//   3. server validator  `out.x = ...`              (api.js _validateSaveData)
//   4. payload -> ps     `ps.x = slot.x`            (title-screen.js load)
//
// Hop 3 is the one the codebase already warns about ("a ps.* field must be added
// to BOTH this serializer and the server validator"). Hop 4 is just as fatal and
// nothing was checking it: a field can persist perfectly and never be read back.
//
//   node tools/check-save-lockstep.mjs
//   node tools/check-save-lockstep.mjs --all

import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../' + f, import.meta.url).pathname, 'utf8');
const saveSrc  = read('src/save-state.js');
const apiSrc   = read('api.js');
const titleSrc = read('src/title-screen.js');
const SHOW_ALL = process.argv.includes('--all');

// The payload literal in saveSlotsToDB is the authoritative "what we persist".
const literal = saveSrc.slice(saveSrc.indexOf('const data = saveSlots.map'));
const payloadFields = [...new Set(
  literal.slice(0, literal.indexOf('} : null)'))
    .split('\n')
    .map(l => (l.match(/^\s{6}([a-zA-Z][a-zA-Z0-9_]*):/) || [])[1])
    .filter(Boolean)
)];

// Fields whose hop is satisfied in a way the regexes cannot see, with the reason.
const EXEMPT = {
  1: {   // ps -> slot
    name: 'written by the name-entry flow, not copied per-save',
    level: 'slot.level = ps.stats.level', exp: 'slot.exp = ps.stats.exp',
    worldX: 'position block — only written when _getPosition() returns non-null',
    worldY: 'position block', onWorldMap: 'position block', currentMapId: 'position block',
    playTime: 'accumulated by the play-clock, not mirrored off a ps field',
  },
  4: {   // payload -> ps
    level: 'restored through ps.stats', exp: 'restored through ps.stats',
    hp: 'restored through ps.stats/hp handling', mp: 'restored through ps.stats/mp handling',
    stats: 'the stats blob is applied field-by-field',
    statusMask: 'rebuilt into ps.status by the load path',
    statusPoisonTick: 'rebuilt into ps.status by the load path',
    inventory: 'applied via setPlayerInventory', inventoryOrder: 'applied via setPlayerInventory',
    name: 'applied to the name buffer, not a ps.* scalar',
    // Position is restored by REPLAYING it, not by assigning ps fields:
    // title-screen.js:766-773 calls loadWorldMapAtPosition(slot.worldX/TILE_SIZE,
    // ...) or loadMapById(slot.currentMapId, tx, ty). Verified, not assumed —
    // these four flagged when hop 4 was tightened and the load path was read
    // before exempting them.
    worldX: 'replayed via loadWorldMapAtPosition / loadMapById',
    worldY: 'replayed via loadWorldMapAtPosition / loadMapById',
    onWorldMap: 'selects WHICH of those two loaders runs',
    currentMapId: 'replayed via loadMapById',
  },
};

const hop1 = (f) => new RegExp('slot\\.' + f + '\\s*=').test(saveSrc);
const hop2 = (f) => new RegExp('^\\s{6}' + f + ':', 'm').test(literal);
const hop3 = (f) => new RegExp('out\\.' + f + '\\s*=').test(apiSrc);
// Hop 4 requires a real assignment INTO ps. Accepting any mention of
// `slot.<field>` in title-screen.js is too loose: the NEW GAME slot template on
// line 657 lists half these field names, so a field could pass hop 4 while the
// load path never restored it.
const hop4 = (f) => new RegExp('ps\\.' + f + '\\s*=(?!=)').test(titleSrc);

const HOPS = [
  [1, 'ps -> slot        (save-state.js)', hop1],
  [2, 'slot -> payload   (save-state.js)', hop2],
  [3, 'server validator  (api.js)',        hop3],
  [4, 'payload -> ps     (title-screen.js)', hop4],
];

const findings = [];
const rows = [];
for (const f of payloadFields) {
  const missing = [];
  for (const [n, label, test] of HOPS) {
    if (test(f)) continue;
    if (EXEMPT[n] && EXEMPT[n][f]) continue;
    missing.push({ n, label });
  }
  rows.push({ f, missing });
  if (missing.length) findings.push({ f, missing });
}

if (SHOW_ALL) {
  console.log(`${payloadFields.length} persisted fields:\n`);
  for (const r of rows) {
    console.log(`  ${r.missing.length ? '✗' : 'ok'}  ${r.f}`);
  }
  console.log('');
}
for (const { f, missing } of findings) {
  console.log(`  ✗  "${f}" is persisted but breaks the chain:`);
  for (const m of missing) console.log(`       hop ${m.n} missing — ${m.label}`);
}

console.log(`\n${payloadFields.length} persisted field(s) checked across 4 hops, ${findings.length} broken.`);
if (findings.length) {
  console.log('\nA field missing hop 3 resets on the next server round-trip; missing hop 4');
  console.log('persists but is never read back. Both are silent — the player just loses it.');
  process.exit(1);
}
console.log('check-save-lockstep: OK — every persisted field survives all four hops');
