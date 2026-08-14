#!/usr/bin/env node
// check-roster-locs.mjs — every map a player can stand on reports where they
// actually are.
//
// `rosterLocForMapId` ends in `|| 'ur'`. That default is a REAL ANSWER, not an
// "unknown" — so a map nobody listed does not look broken, it just quietly
// tells every other player that whoever is standing there is in Ur.
//
// This has already happened twice. Kazus's room locations shipped in v1.8.12,
// the revert of that version removed them, and the rebuild restored the NPCs
// without them — exactly as it did with all three Kazus shops. For several
// versions, standing in Kazus reported as Ur and nothing anywhere complained.
//
//   node tools/check-roster-locs.mjs
//
// So: every map that has placed NPCs, or a shop, or is a known town/castle,
// must resolve to something other than the default.

import fs from 'node:fs';

globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.document = { createElement: () => ({ getContext: () => ({}) }), getElementById: () => null, addEventListener() {} };

const { rosterLocForMapId } = await import('../src/roster.js');
const { TOWN_NPCS } = await import('../src/data/town-npcs.js');
const { SHOPS } = await import('../src/data/shops.js');

let failed = 0;
const bad = (m) => { console.error('  ✗ ' + m); failed++; };

// Map 114 IS Ur, so 'ur' is correct there and only there.
const UR_OVERWORLD = 114;

const inhabited = new Set();
for (const [mapId] of TOWN_NPCS) inhabited.add(mapId);
for (const [, shop] of SHOPS) inhabited.add(shop.mapId);

for (const mapId of [...inhabited].sort((a, b) => a - b)) {
  if (mapId === UR_OVERWORLD) continue;
  const loc = rosterLocForMapId(mapId);
  if (loc === 'ur') {
    bad(`map ${mapId} has NPCs or a shop but reports loc 'ur' — the default. ` +
        'Players standing there show up in Ur on everyone else\'s roster.');
  }
}
if (!failed) console.log(`  ✓ all ${inhabited.size} inhabited maps report a real location`);

// The wire clamps `loc` to 16 characters (ws-presence.js), so a longer key is
// silently truncated and two rooms can collide into one.
{
  const seen = new Map();
  let clash = 0;
  for (const mapId of inhabited) {
    const loc = rosterLocForMapId(mapId);
    if (loc.length > 16) { bad(`map ${mapId} loc '${loc}' is ${loc.length} chars — the wire clamps to 16`); continue; }
    if (seen.has(loc) && loc !== 'ur') {
      bad(`maps ${seen.get(loc)} and ${mapId} share loc '${loc}' — two rooms grouped as one`);
      clash++;
    }
    seen.set(loc, mapId);
  }
  if (!clash && !failed) console.log('  ✓ every location key is unique and within the 16-char wire limit');
}

if (failed) { console.error(`\ncheck-roster-locs: FAIL (${failed})`); process.exit(1); }
console.log('\ncheck-roster-locs: OK');
