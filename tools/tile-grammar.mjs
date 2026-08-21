#!/usr/bin/env node
// tile-grammar.mjs — what tile arrangements does the CARTRIDGE actually use?
//
// ⛔ Built after shipping a wall arrangement that exists nowhere: a ceiling tile
// with rock ABOVE it. I had been checking rules I had written down in comments
// instead of what the ROM does, and the rules in the comments were incomplete.
//
// This censuses every ordered VERTICAL pair (tile above, tile below) and every
// ordered HORIZONTAL pair across the cartridge's own cave maps, then reports the
// pairs OUR generator produces that the cartridge never does.
//
//   node tools/tile-grammar.mjs            # the report
//   node tools/tile-grammar.mjs --seeds 50

import fs from 'node:fs';

const rom = new Uint8Array(fs.readFileSync(process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname));
const { loadMap } = await import('../src/map-loader.js');
const { generateFloor } = await import('../src/dungeon-generator.js');

const i = process.argv.indexOf('--seeds');
const SEEDS = i > 0 ? parseInt(process.argv[i + 1], 10) : 120;
const BASE = 1761000000000;

// The cartridge's Altar Cave, tileset 0. 148 is the crystal room (tileset 2) and
// is a different vocabulary, so it is not mixed in.
const ROM_CAVES = [111, 112, 113, 22, 115];

const NAME = {
  0x00: 'CEIL', 0x01: 'ROCK', 0x02: 'ROCK2', 0x03: 'ARCH', 0x04: 'WATER',
  0x08: 'WEDGE', 0x09: 'BONES', 0x23: 'WEDGE_N', 0x30: 'FLOOR', 0x41: 'PASS',
  0x42: 'STAIRARCH', 0x44: 'FAKECEIL', 0x49: 'PASSBTM', 0x5f: 'VOID',
  0x60: 'EVENT', 0x61: 'WARP', 0x68: 'EXITPREV', 0x6a: 'PASSENT', 0x6b: 'PASSENTB',
  0x70: 'DOOR', 0x73: 'STAIRS', 0x74: 'TRAP', 0x7c: 'CHEST', 0x7d: 'CHESTOPEN',
};
const nm = (t) => NAME[t] || '0x' + t.toString(16).padStart(2, '0');

function census(tm, vert, horiz) {
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const t = tm[y * 32 + x];
      if (y < 31) { const k = `${nm(t)} over ${nm(tm[(y + 1) * 32 + x])}`; vert.set(k, (vert.get(k) || 0) + 1); }
      if (x < 31) { const k = `${nm(t)} left-of ${nm(tm[y * 32 + x + 1])}`; horiz.set(k, (horiz.get(k) || 0) + 1); }
    }
  }
}

const romV = new Map(), romH = new Map();
for (const id of ROM_CAVES) census(loadMap(rom, id).tilemap, romV, romH);

console.log(`ROM cave maps ${ROM_CAVES.join(', ')} — ${romV.size} distinct vertical pairs, ${romH.size} horizontal`);

const oursV = new Map(), oursH = new Map();
for (const f of [0, 1, 2, 3]) {
  for (let k = 0; k < SEEDS; k++) census(generateFloor(rom, f, BASE + k * 7919).tilemap, oursV, oursH);
}
console.log(`ours, floors 0-3 x ${SEEDS} seeds — ${oursV.size} vertical, ${oursH.size} horizontal\n`);

// ⛔ SAMPLE SIZE DECIDES WHAT IS A LAW. The five ROM caves hold CEIL 2664,
// VOID 1712, FLOOR 348 and ROCK 326 — and then CHEST 16, BONES 12, WATER 7,
// DOOR 1. "The cartridge never puts rock above a door" is not a rule when the
// cartridge contains ONE door; it is noise. Only pairs made of the four
// structural tiles are treated as grammar. Everything else is listed separately
// as insufficient evidence, because reporting it as law is how a made-up rule
// gets treated as fact — which is the mistake this file exists to stop.
const romCount = new Map();
for (const id of ROM_CAVES) for (const t of loadMap(rom, id).tilemap) romCount.set(nm(t), (romCount.get(nm(t)) || 0) + 1);
const STRUCTURAL_MIN = 100;
const structural = new Set([...romCount].filter(([, n]) => n >= STRUCTURAL_MIN).map(([k]) => k));
console.log(`structural tiles (>= ${STRUCTURAL_MIN} in the ROM caves): ${[...structural].join(', ')}`);
const romTiles = new Set(romCount.keys());

function report(label, romM, ourM) {
  const law = [], weak = [];
  for (const [k, n] of ourM) {
    if (romM.has(k)) continue;
    const [a, , b] = k.split(' ');
    if (!romTiles.has(a) || !romTiles.has(b)) continue;   // novel tile, not a novel arrangement
    (structural.has(a) && structural.has(b) ? law : weak).push([k, n]);
  }
  law.sort((x, y) => y[1] - x[1]); weak.sort((x, y) => y[1] - x[1]);
  console.log(`── ${label} — VIOLATIONS (structural tiles only, this is the grammar) ──`);
  if (!law.length) console.log('  none');
  for (const [k, n] of law) console.log(`  ${String(n).padStart(7)}  ${k}`);
  console.log(`── ${label} — insufficient ROM evidence (rare tiles; NOT a rule) ──`);
  console.log(`  ${weak.length} pairs, e.g. ${weak.slice(0, 3).map(([k]) => k).join(' / ') || '(none)'}`);
  console.log('');
  return law;
}

const vLaw = report('VERTICAL', romV, oursV);
const hLaw = report('HORIZONTAL', romH, oursH);

// ── Anything that RENDERS as a structural tile is judged as one ────────────
// ⛔ A pair census keyed on tile IDS has a hole: `$44` FALSE_CEILING draws
// exactly like `$00` CEILING but is a different id, and the ROM caves contain no
// `$44` at all — so every arrangement involving it landed in "insufficient
// evidence" and was excused. That is precisely where the reported bug lived: a
// secret tunnel's mouth was `$44` with ROCK above it, which on screen is rock
// sitting on top of a ceiling tile. The ROM does that ZERO times.
// Judge by what a tile LOOKS like, not by its id.
const LOOKS_LIKE = new Map([['FAKECEIL', 'CEIL']]);
const canon = (k) => k.split(' ').map((w) => LOOKS_LIKE.get(w) || w).join(' ');
const extra = [];
for (const [k, n] of oursV) {
  const c = canon(k);
  if (c === k || romV.has(c)) continue;
  const [a, , b] = c.split(' ');
  if (structural.has(a) && structural.has(b)) extra.push([`${k}  (renders as ${c})`, n]);
}
console.log(`── LOOK-ALIKE VIOLATIONS (a tile drawn as a structural one, arranged illegally) ──`);
if (!extra.length) console.log('  none');
for (const [k, n] of extra) console.log(`  ${String(n).padStart(7)}  ${k}`);

if (process.argv.includes('--check')) {
  const bad = vLaw.length + hLaw.length + extra.length;
  if (bad) { console.log(`\nFAIL: ${bad} arrangement(s) the cartridge never uses`); process.exit(1); }
  console.log('\nevery tile arrangement is one the cartridge uses');
}
