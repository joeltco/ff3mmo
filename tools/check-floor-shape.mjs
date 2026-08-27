#!/usr/bin/env node
// check-floor-shape.mjs — the cave wall must follow the cartridge's rule.
//
// ⛔ A CEILING THAT CAPS A ROCK BAND HAS EXACTLY TWO ROCKY TILES BELOW IT.
// Measured in the cartridge's own caves — ROM maps 111, 113, 22 and 115 — and it
// is absolute there: 125 of 125 sampled are depth 2. No 1s, no 3s.
//
// v1.10.34's `roughenOverhang` deepened the band to make it look less like a
// straight lid, and shipped 652 / 831 / 1376 three-deep bands on floors 1 / 2 / 3
// plus a handful four and five deep. It was reported from play as "ceiling has 3
// wall tiles underneath — that's a rule break", which it was. The pass is gone.
//
// ⛔ THIS GATE DOES NOT ASSERT ZERO, because zero is not where the generator is.
// A residual of a few per hundred floors survives from a different and
// unidentified cause — bands stacking where a corridor's wall sits directly над
// a room's — and pretending otherwise would mean either a gate that always fails
// or a threshold hiding a regression. The limits are set just above the measured
// residual, so the systematic case cannot come back while the rare one stays
// visible in the printout.
//
//   node tools/check-floor-shape.mjs [seeds]

import fs from 'node:fs';

const rom = new Uint8Array(fs.readFileSync(process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname));
const { generateFloor } = await import('../src/dungeon-generator.js');
const { loadMap } = await import('../src/map-loader.js');
const { DUNGEONS, layoutForFloor } = await import('../src/data/dungeons.js');

const SEEDS = parseInt(process.argv[2] || '200', 10);
const BASE = 1761000000000;
const CEIL = 0x00, ROCK = 0x01;
// Deep bands allowed per SEEDS floors. Measured residual is well under each.
// ⛔ KEYED BY LAYOUT, MEASURED PER DUNGEON. Was `[[0,5],[1,25],[2,20],[3,30]]`
// over floor indices against the default dungeon, so the Cave of Seals was never
// checked and a limit belonged to a POSITION rather than to a carve.
// `boulder-chamber` is pinned at ZERO because it MEASURES zero: 2,000 seeds
// across five bases, not one three-deep band. A limit of 25 next to a measured 0
// is not a gate, it is a comment. Its sibling `trap-chamber` also measures 0 and
// keeps its historical 25 — tightening a shipped floor's limit is a separate
// call from pinning a new one honestly.
const DEEP_LIMIT = new Map([
  ['snake', 5], ['trap-chamber', 25], ['boulder-chamber', 0], ['rock-switch', 20], ['spine', 30],
  // Pinned at ZERO because it MEASURES zero, the same standard `boulder-chamber`
  // is held to: 10,000 floors across five seed bases, not one band off depth 2.
  ['chamber-run', 0],
]);

function depths(tm) {
  const hist = {};
  for (let y = 0; y < 31; y++) for (let x = 0; x < 32; x++) {
    if (tm[y * 32 + x] !== CEIL || tm[(y + 1) * 32 + x] !== ROCK) continue;
    let n = 0;
    for (let k = y + 1; k < 32 && tm[k * 32 + x] === ROCK; k++) n++;
    hist[n] = (hist[n] || 0) + 1;
  }
  return hist;
}

const fails = [];
// Restate the rule from the ROM every run, so the number this gate defends is
// never just an assertion in a comment.
let romOther = 0, romTwo = 0;
for (const id of [111, 113, 22, 115]) {
  const h = depths(loadMap(rom, id).tilemap);
  for (const [d, n] of Object.entries(h)) { if (+d === 2) romTwo += n; else romOther += n; }
}
console.log(`ROM caves: ${romTwo} bands at depth 2, ${romOther} at any other depth`);
if (romOther !== 0) fails.push(`the ROM itself shows ${romOther} bands off depth 2 — the rule this gate defends is wrong, re-derive it before trusting this file`);

console.log(`floor                    depth1  depth2  depth3+  limit`);
for (const dg of DUNGEONS) {
  for (let f = 0; f < dg.floors; f++) {
    const lay = layoutForFloor(dg, f);
    if (lay === null) continue;                 // boss chamber — authored
    const limit = DEEP_LIMIT.get(lay);
    if (limit === undefined) { fails.push(`layout '${lay}' has no depth limit — pin one from a measurement`); continue; }
    const label = `${dg.id} f${f} ${lay}`;
    const tot = {};
    for (let k = 0; k < SEEDS; k++) {
      const h = depths(generateFloor(rom, f, BASE + k * 7919, dg).tilemap);
      for (const [d, n] of Object.entries(h)) tot[d] = (tot[d] || 0) + n;
    }
    const one = tot[1] || 0;
    let deep = 0;
    for (const [d, n] of Object.entries(tot)) if (+d >= 3) deep += n;
    console.log(`${label.padEnd(25)}${String(one).padStart(6)}${String(tot[2] || 0).padStart(8)}${String(deep).padStart(9)}${String(limit).padStart(7)}`);
    if (deep > limit) fails.push(`${label}: ${deep} ceilings with THREE OR MORE rocky tiles below (limit ${limit}) — the cartridge never does this`);
  }
}

if (fails.length) { console.log('\nFAIL:'); for (const f of fails) console.log('  ' + f); process.exit(1); }
console.log('\nwall depth follows the cartridge');
