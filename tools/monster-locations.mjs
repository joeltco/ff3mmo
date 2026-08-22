#!/usr/bin/env node
// monster-locations.mjs — where each monster ACTUALLY appears, from the ROM.
//
//   node tools/monster-locations.mjs              # the catalog
//   node tools/monster-locations.mjs 0x0a         # one monster
//   node tools/monster-locations.mjs --diff       # vs the hand-authored field
//   node tools/monster-locations.mjs --emit       # JSON for gen-monsters-js.js
//
// `src/data/monsters.js` says so itself: "location is hand data". Seventy tag
// names, invented, surviving every regeneration because `gen-monsters-js.js`
// deliberately copies them forward — and shown to the player as "Found in" in
// the bestiary tab.
//
// It does not have to be hand data any more. The map -> encounter chain is
// decoded (`lib/ff3-map-encounters.mjs`), so the reverse index is just a walk:
//
//   every map 0-511 with a non-zero RATE
//     -> its group -> the group's 8 formation slots -> each slot's species
//   every world-map REGION
//     -> the same, via the region grids
//
// and the place NAMES come from the cartridge too — map property byte 2 is the
// banner string and byte 5 is the area id, both decoded in `tools/map-names.mjs`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ME from './lib/ff3-map-encounters.mjs';
import * as EN from './lib/ff3-encounters.mjs';
import { decodeString } from './lib/ff3-text.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const rom = new Uint8Array(fs.readFileSync(process.env.FF3_ROM || path.join(HERE, '..', 'FF3-English.nes')));
const { initTextDecoder, getMonsterName } = await import('../src/text-decoder.js');
initTextDecoder(rom);

const PROPS = 0x004010, MAPS = 512;
const NAME_BYTE = 2, AREA_BYTE = 5, NO_NAME = 0xFF;
const propOf = (m, b) => rom[PROPS + m * 16 + b];

function nesText(bytes) {
  let s = '';
  for (const b of bytes) {
    if (b >= 0xCA && b <= 0xE3) s += String.fromCharCode(b - 0xCA + 97);
    else if (b >= 0x8A && b <= 0xA3) s += String.fromCharCode(b - 0x8A + 65);
    else if (b >= 0x80 && b <= 0x89) s += String.fromCharCode(b - 0x80 + 48);
    else if (b === 0xFF) s += ' ';
  }
  return s.trim();
}
const mname = (id) => { try { return nesText(getMonsterName(id)) || `0x${id.toString(16)}`; } catch { return `0x${id.toString(16)}`; } };

/** The banner string a map draws, or null. ⛔ Strip the {xx} control codes. */
function mapName(m) {
  const b = propOf(m, NAME_BYTE);
  if (b === NO_NAME) return null;
  try {
    const s = decodeString(rom, 0x100 + b);
    return (s || '').replace(/\{[0-9a-f]+\}/gi, '')
      .replace(/\s+/g, ' ').replace(/^[^A-Za-z0-9]+/, '').trim() || null;
  } catch { return null; }
}

/** "B2F", "5F", "1F" — a floor label, not a place. */
const isFloorLabel = (n) => /^B?\d+F$/.test(n);

/**
 * A map's PLACE name.
 *
 * ⛔ THE AREA BYTE IS NOT A DUNGEON. Area $18 holds Round Table Hall, Summit
 * Road AND the Sealed Cave, so "the first named map in the area" — which is what
 * `map-names.mjs --areas` prints as a parent — files every Mummy in the game
 * under "Round Table Hall". That was the first version of this and it was wrong.
 *
 * The rule that survives the known cases: a map with its own place name IS that
 * place; a floor label or an unnamed map belongs to the NEAREST place name in
 * the same area, preferring one that comes before it (you walk in at the top).
 * Cases where the rule had to reach forwards are listed by `--audit`, because
 * they are the ones that could be wrong.
 *
 * ⚠ KNOWN ODDITY, map 158. Area $18 and song $1d put it with the Sealed Cave,
 * but its palette is $f4 (not $79) and its encounter group is 0 — Goblins. It is
 * why Goblin/Carbuncle/Eye Fang show up under "Sealed Cave". It looks like a
 * dummied duplicate; without a door graph there is nothing here that can rule on
 * it, so it is reported rather than quietly dropped.
 */
const ADJACENT_LIMIT = 24;
const placeCache = new Map();
const reachedForward = new Set();
const inferredByAdjacency = new Set();
function placeOf(m) {
  if (placeCache.has(m)) return placeCache.get(m);
  const own = mapName(m);
  if (own && !isFloorLabel(own)) { placeCache.set(m, own); return own; }
  const area = propOf(m, AREA_BYTE);
  // ⛔ AREA IDS REPEAT ACROSS THE TWO MAP BANKS. Maps 0-255 and 256-511 are
  // selected by `$78` and have their own group table ($92F0 vs $93F0); an area
  // byte in one says nothing about the other. Searching the whole 512 filed
  // late-game maps 413-415 under "Sasune:East Tower", an early-game castle,
  // because the byte happened to collide.
  const bank = Math.floor(m / 256), lo = bank * 256, hi = lo + 256;
  let back = null, fwd = null;
  for (let k = m - 1; k >= lo; k--) {
    if (propOf(k, AREA_BYTE) !== area) continue;
    const n = mapName(k);
    if (n && !isFloorLabel(n)) { back = n; break; }
  }
  if (!back) {
    for (let k = m + 1; k < hi; k++) {
      if (propOf(k, AREA_BYTE) !== area) continue;
      const n = mapName(k);
      if (n && !isFloorLabel(n)) { fwd = n; break; }
    }
  }
  // ⛔ A BIG DUNGEON SPANS SEVERAL AREA IDS — the Crystal Tower's floors sit in
  // 0x5b and 0x35, so "same area" alone leaves 33 floors calling themselves
  // "B5F". Floors are laid out CONTIGUOUSLY by map id (103-106, 111-115,
  // 116-119 all are), so fall back to the nearest real place name within a few
  // maps, in the same bank. Bounded on purpose: an unbounded walk would happily
  // file a dungeon under whatever town came before it.
  let near = null;
  if (!back && !fwd) {
    for (let k = m - 1; k >= Math.max(lo, m - ADJACENT_LIMIT); k--) {
      const n = mapName(k);
      if (n && !isFloorLabel(n)) { near = n; break; }
    }
  }
  const res = back || fwd || near || own || `map ${m}`;
  if (!back && fwd) reachedForward.add(m);
  if (near) inferredByAdjacency.add(m);
  placeCache.set(m, res);
  return res;
}

const speciesOfFormation = (f) =>
  EN.speciesOf(rom, EN.setEntry(rom, f)[0]).filter((s) => s !== EN.SPECIES_EMPTY);

/** monster id -> Map(place -> {maps:Set, weight:number}) */
export function buildIndex() {
  const idx = new Map();
  const add = (id, place, weight, where) => {
    if (!idx.has(id)) idx.set(id, new Map());
    const byPlace = idx.get(id);
    if (!byPlace.has(place)) byPlace.set(place, { weight: 0, where: new Set() });
    const e = byPlace.get(place);
    e.weight += weight; e.where.add(where);
  };
  const odds = ME.slotOdds(rom);

  // ── indoor maps ───────────────────────────────────────────────────────────
  // ⛔ RATE 0 MEANS NO RANDOM ENCOUNTERS. Every town and every shop shares
  // group 0 with the world's Goblins purely because 0 is the table's default;
  // without this filter every Goblin in the game would be "found in" Ur's inn.
  for (let m = 0; m < MAPS; m++) {
    if (ME.rateForMap(rom, m) === 0) continue;
    const g = ME.groupForMap(rom, m);
    // ⛔ maps 256-511 read the UPPER half of ENCOUNTER_SET — see formationBase.
    ME.slotsForGroup(rom, g, ME.formationBase(m < 256 ? 0 : 1)).forEach((f, i) => {
      for (const s of speciesOfFormation(f)) add(s, placeOf(m), odds[i], `map ${m}`);
    });
  }

  // ── world maps ────────────────────────────────────────────────────────────
  // ⛔ THE CARTRIDGE DOES NOT NAME ITS OVERWORLDS. `$78` selects which one and
  // the encounter code branches on 0 / 2 / 3; there is no banner string for any
  // of them, so they are labelled by that selector and nothing else. An earlier
  // pass called `$78 == 3` "Surface World" — a guess dressed as ROM data, in a
  // file whose whole purpose is to stop that.
  //
  // ⭐ World 0 is the one this game ships: `src/world-map-loader.js` loads it at
  // 128x128, and map 114 "Ur" sits on it.
  const worlds = [
    { label: 'Overworld (world 0)', grid: ME.WORLD0_GRID, cells: 16, world: 0 },
    { label: 'Overworld (world 3)', grid: ME.WORLD3_GRID, cells: 64, world: 3 },
  ];
  for (const w of worlds) {
    for (let i = 0; i < w.cells; i++) {
      const g = rom[w.grid + i];
      ME.slotsForGroup(rom, g, ME.formationBase(w.world)).forEach((f, k) => {
        for (const s of speciesOfFormation(f)) add(s, w.label, odds[k], `region ${i}`);
      });
    }
  }
  // ── the VEHICLE groups ────────────────────────────────────────────────────
  // ⛔ THE REGION GRIDS ARE THE ON-FOOT PATH ONLY. `$42` is the vehicle mode,
  // and bank 61 $BCD5/$BD15 branch on it into seven single-group entries at
  // $9D40-$9D46 — which is where every ship and airship encounter lives.
  // Leaving them out dropped 122 monsters as "never spawns", including whole
  // families the hand data had filed under sea and sky. Offsets and their
  // branch conditions, read off the disassembly:
  const cfg = [
    [0, 'Overworld (world 0), vehicle 2',  0],   // $BCD9  world 0, $42 == 2
    [1, 'Overworld (world 0), by vehicle', 0],   // $BCE0  world 0, other vehicle
    [2, 'Overworld (world 2)',             2],   // $BD0B  world 2, any
    [3, 'Overworld (world 3), vehicle 2',  3],   // $BD15  world 3, $42 == 2
    [4, 'Overworld (world 3), vehicle 3',  3],   // $BD1E  world 3, $42 == 3
    [5, 'Overworld (world 3), by vehicle', 3],   // $BD25  world 3, $42 >= 4
    [6, 'Overworld (other)',               1],   // $BD4A  $78 not 0/2/3
  ];
  for (const [off, label, world] of cfg) {
    const g = rom[ME.WORLD_CFG + off];
    ME.slotsForGroup(rom, g, ME.formationBase(world)).forEach((f, k) => {
      for (const s of speciesOfFormation(f)) add(s, label, odds[k], `$9D4${off}`);
    });
  }
  return idx;
}

const idx = buildIndex();

// ⛔ CLI ONLY WHEN RUN DIRECTLY. `gen-monsters-js.js` imports this module and
// writes `src/data/monsters.js` from ITS OWN stdout — an unguarded top-level
// `console.log` here lands in the generated file and makes it unparseable.
const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const args = IS_MAIN ? process.argv.slice(2) : [];
const nums = args.filter((a) => /^(0x)?[0-9a-f]+$/i.test(a)).map((a) => Number(a));

/** Places for one monster, commonest first. */
export const placesFor = (id) =>
  [...(idx.get(id) || new Map())].sort((a, b) => b[1].weight - a[1].weight).map(([p]) => p);

if (args.includes('--emit')) {
  const out = {};
  for (const [id] of idx) out[id] = placesFor(id);
  console.log(JSON.stringify(out, null, 1));
} else if (args.includes('--diff')) {
  const { MONSTERS } = await import('../src/data/monsters.js');
  let missing = 0, wrong = 0;
  for (const [id, v] of MONSTERS) {
    const real = placesFor(id);
    const hand = v.location || [];
    if (!real.length && hand.length) { missing++; console.log(`  0x${id.toString(16).padStart(2, '0')} ${mname(id).padEnd(12)} hand:[${hand}]  ROM: NEVER SPAWNS`); }
    else if (real.length) {
      console.log(`  0x${id.toString(16).padStart(2, '0')} ${mname(id).padEnd(12)} hand:[${hand.join(',')}]`);
      console.log(`       ${' '.repeat(13)}ROM :[${real.join(', ')}]`);
      wrong++;
    }
  }
  console.log(`\n${wrong} monsters have a ROM location; ${missing} are tagged by hand but the ROM never spawns them`);
} else if (nums.length) {
  for (const id of nums) {
    console.log(`0x${id.toString(16).padStart(2, '0')} ${mname(id)}`);
    for (const [place, e] of [...(idx.get(id) || new Map())].sort((a, b) => b[1].weight - a[1].weight))
      console.log(`   ${place.padEnd(28)} ${String(e.weight).padStart(4)} weight  (${[...e.where].slice(0, 6).join(', ')}${e.where.size > 6 ? ', …' : ''})`);
  }
} else if (args.includes('--audit')) {
  // Every map with encounters, the place the rule assigned it, and whether the
  // rule had to reach FORWARD to find that place (the fallible cases).
  for (let m = 0; m < MAPS; m++) {
    if (ME.rateForMap(rom, m) === 0) continue;
    const own = mapName(m);
    console.log(`  map ${String(m).padStart(3)}  area 0x${propOf(m, AREA_BYTE).toString(16).padStart(2, '0')}  ` +
                `own ${(own || '—').padEnd(22)} -> ${placeOf(m)}${reachedForward.has(m) ? '   ⚠ reached forward' : ''}` +
                `${inferredByAdjacency.has(m) ? '   ⚠ inferred by adjacency' : ''}`);
  }
} else if (IS_MAIN) {
  const ids = [...idx.keys()].sort((a, b) => a - b);
  console.log(`${ids.length} monsters have at least one ROM location\n`);
  for (const id of ids)
    console.log(`  0x${id.toString(16).padStart(2, '0')} ${mname(id).padEnd(13)} ${placesFor(id).join(', ')}`);
}
