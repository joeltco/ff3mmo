#!/usr/bin/env node
// check-floor-variety.mjs — a floor must not be the same map every time.
//
// Altar Cave reseeds with `Date.now()` on every entry, so "procedural" is a
// claim about what DIFFERENT PLAYERS SEE. It was measurably false: floor 3
// produced the same 73% of its walkable tiles for any two seeds, put 85 of its
// ~122 walkable tiles in the same place in 9 runs out of 10, and never once
// moved its entrance across 200 seeds. Its skeleton was literals —
// `entranceX = 16`, `roomCenterY = 9`.
//
// Correctness gates (dungeon-sweep, check-floor-plan) cannot see this: a
// perfectly-connected floor with every chest reachable can still be the same
// floor every time. Hence a separate gate, with thresholds pinned per floor.
//
// ⛔ FLOOR 4 IS EXEMPT AND MUST STAY THAT WAY. The crystal chamber is AUTHORED;
// a boss arena is designed, not rolled. Jaccard 1.000 is correct there.
//
//   node tools/check-floor-variety.mjs [seeds]
//   node tools/check-floor-variety.mjs --report   # print, never fail

import fs from 'node:fs';

const rom = new Uint8Array(fs.readFileSync(process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname));
const { generateFloor } = await import('../src/dungeon-generator.js');
const { reachableFrom } = await import('./dungeon-sweep.mjs');

const REPORT = process.argv.includes('--report');
const SEEDS = parseInt(process.argv.find(a => /^\d+$/.test(a)) || '200', 10);
const BASE = 1761000000000;

// Per floor: [max mean pairwise Jaccard, max tiles present in >=90% of seeds,
//             min distinct entrance positions]. null = exempt (authored).
const LIMITS = new Map([
  [0, { jaccard: 0.70, always: 90,  entrances: 2 }],
  [1, { jaccard: 0.40, always: 20,  entrances: 15 }],
  [2, { jaccard: 0.30, always: 10,  entrances: 2 }],
  [3, { jaccard: 0.40, always: 15,  entrances: 12 }],   // v1.10.29: was 0.749 / 85 / 1
  [4, null],
]);

const fails = [];
console.log(`floor  walkTiles  jaccard  alwaysTiles  entrances   limits`);
for (const [f, lim] of LIMITS) {
  const masks = []; const count = new Uint16Array(1024); const ents = new Set();
  let tot = 0;
  for (let k = 0; k < SEEDS; k++) {
    const r = generateFloor(rom, f, BASE + k * 7919);
    const seen = reachableFrom(r.tilemap, r.entranceX, r.entranceY);
    ents.add(`${r.entranceX},${r.entranceY}`);
    const m = new Set();
    for (let i = 0; i < 1024; i++) if (seen[i]) { count[i]++; m.add(i); tot++; }
    masks.push(m);
  }
  let always = 0;
  for (let i = 0; i < 1024; i++) if (count[i] / SEEDS >= 0.9) always++;
  // mean pairwise Jaccard over disjoint pairs
  let js = 0, n = 0;
  const half = Math.floor(masks.length / 2);
  for (let a = 0; a < half; a++) {
    const A = masks[a], B = masks[a + half];
    let inter = 0; for (const i of A) if (B.has(i)) inter++;
    const uni = A.size + B.size - inter;
    if (uni) { js += inter / uni; n++; }
  }
  const jac = n ? js / n : 0;
  const line = String(f).padEnd(7) + String(Math.round(tot / SEEDS)).padStart(9)
    + jac.toFixed(3).padStart(9) + String(always).padStart(13) + String(ents.size).padStart(11)
    + '   ' + (lim ? `j<=${lim.jaccard} a<=${lim.always} e>=${lim.entrances}` : 'exempt (authored)');
  console.log(line);
  if (!lim) continue;
  if (jac > lim.jaccard)        fails.push(`floor ${f}: two seeds share ${(jac * 100).toFixed(0)}% of their walkable tiles (limit ${(lim.jaccard * 100).toFixed(0)}%) — it is the same map every run`);
  if (always > lim.always)      fails.push(`floor ${f}: ${always} tiles are walkable in >=90% of seeds (limit ${lim.always}) — that much of the floor is fixed`);
  if (ents.size < lim.entrances) fails.push(`floor ${f}: only ${ents.size} distinct entrance position(s) across ${SEEDS} seeds (need ${lim.entrances})`);
}

if (REPORT) { console.log('\n(--report: measured only, never fails)'); process.exit(0); }
if (fails.length) { console.log(`\nFAIL (${fails.length}):`); for (const f of fails) console.log('  ' + f); process.exit(1); }
console.log('\nevery floor varies');
