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
// It also gates CONTOUR: how flat the top edge of the rocky overhang band is.
// `addOverhang` lays exactly two rocky rows under every ceiling, which gives a
// room a straight dark lid — measured at 70%/61%/79% of adjacent band tops being
// level on floors 1/2/3, against **42-63% in the cartridge's own caves** (ROM
// maps 22, 113, 115). `roughenOverhang` brought ours to 46%/44%/48%, inside the
// ROM's range. This is the one number that separated our look from the ROM's;
// two earlier attempts at measuring "boxiness" did not discriminate at all.
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
  [0, { jaccard: 0.50, always: 35,  entrances: 6, secretRate: 0.45, lockedRate: 0.35 }],  // v1.10.31: was 0.610 / 72 / 2
  [1, { jaccard: 0.40, always: 20,  entrances: 15, secretRate: 0.35, lockedRate: 0, flatBand: 0.58, topologies: 2 }],
  [2, { jaccard: 0.30, always: 10,  entrances: 2, secretRate: 0.40, lockedRate: 0.35, flatBand: 0.58, topologies: 2 }],
  [3, { jaccard: 0.35, always: 15,  entrances: 12, topologies: 4, secretRate: 0.40, lockedRate: 0, flatBand: 0.58 }],  // v1.10.29-32: was 0.749 / 85 / 1
  [4, null],
]);

// How flat is the top edge of the rocky band? For each column carrying a band,
// find its topmost rocky row and ask how often a neighbouring column's is level.
// A rectangular lid approaches 100%; a band that follows the floor is far lower.
function bandFlatness(tm) {
  const top = new Array(32).fill(null);
  for (let x = 0; x < 32; x++) {
    for (let y = 0; y < 32; y++) if (tm[y * 32 + x] === 0x01) { top[x] = y; break; }
  }
  let pairs = 0, same = 0;
  for (let x = 0; x < 31; x++) {
    if (top[x] == null || top[x + 1] == null) continue;
    pairs++; if (top[x] === top[x + 1]) same++;
  }
  return pairs ? same / pairs : 0;
}

const fails = [];
console.log(`floor  walkTiles  jaccard  alwaysTiles  entrances   limits`);
for (const [f, lim] of LIMITS) {
  const masks = []; const count = new Uint16Array(1024); const ents = new Set();
  const topos = new Map();
  let secretSeeds = 0, lockedSeeds = 0, flatSum = 0;
  let tot = 0;
  for (let k = 0; k < SEEDS; k++) {
    const r = generateFloor(rom, f, BASE + k * 7919);
    const seen = reachableFrom(r.tilemap, r.entranceX, r.entranceY);
    ents.add(`${r.entranceX},${r.entranceY}`);
    if (r.plan?.topology) topos.set(r.plan.topology, (topos.get(r.plan.topology) || 0) + 1);
    // Floor 0 records secrets as `falseWalls`; the slab floors record rock
    // tunnels in the plan. Both count as "this floor has a secret".
    if (r.falseWalls?.size || r.plan?.links?.some(l => l.kind === 'secret')) secretSeeds++;
    if (lim?.flatBand != null) flatSum += bandFlatness(r.tilemap);
    if (r.lockedDoors?.size) lockedSeeds++;
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
  if (lim.flatBand != null) {
    const flat = flatSum / SEEDS;
    console.log(`         band contour: ${Math.round(flat * 100)}% of adjacent band tops level (ROM caves 42-63%, limit ${Math.round(lim.flatBand * 100)}%)`);
    if (flat > lim.flatBand) fails.push(`floor ${f}: ${Math.round(flat * 100)}% of adjacent overhang-band tops are level (limit ${Math.round(lim.flatBand * 100)}%) — the band is a straight lid again, not a contour`);
  }
  // ⛔ VARIETY MUST NOT DELETE CONTENT. Moving a floor's rooms around changes
  // where its optional features can be placed: floor 0's secret corridor needs
  // void columns outside the room wall, so a geometry change can quietly stop it
  // being placeable. Rates are gated so "more varied" can never mean "emptier".
  if (lim.secretRate != null) {
    const sr = secretSeeds / SEEDS, lr = lockedSeeds / SEEDS;
    console.log(`         features: secret path ${secretSeeds}/${SEEDS} (${Math.round(sr * 100)}%), locked door ${lockedSeeds}/${SEEDS} (${Math.round(lr * 100)}%)`);
    if (sr < lim.secretRate) fails.push(`floor ${f}: secret path in only ${Math.round(sr * 100)}% of seeds (need ${Math.round(lim.secretRate * 100)}%) — a geometry change has made secrets harder to place`);
    if (lr < lim.lockedRate) fails.push(`floor ${f}: locked door in only ${Math.round(lr * 100)}% of seeds (need ${Math.round(lim.lockedRate * 100)}%)`);
  }
  if (lim.topologies) {
    const spread = [...topos.entries()].map(([k, v]) => `${k} ${v}`).join(', ');
    console.log(`         topologies: ${spread || '(none recorded)'}`);
    if (topos.size < lim.topologies) fails.push(`floor ${f}: only ${topos.size} topology/topologies across ${SEEDS} seeds (need ${lim.topologies}) — the shape itself is not varying, only its measurements`);
    // A topology that shows up once in a blue moon is not really in the game.
    for (const [k, v] of topos) if (v / SEEDS < 0.15) fails.push(`floor ${f}: topology '${k}' appears in only ${v}/${SEEDS} seeds — too rare to count as variety`);
  }
}

if (REPORT) { console.log('\n(--report: measured only, never fails)'); process.exit(0); }
if (fails.length) { console.log(`\nFAIL (${fails.length}):`); for (const f of fails) console.log('  ' + f); process.exit(1); }
console.log('\nevery floor varies');
