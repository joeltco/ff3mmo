#!/usr/bin/env node
// map-encounters.mjs — which monsters a MAP actually fights, from the ROM.
//
// `gen-encounters-js.js` decodes all 512 formations but never says which map
// uses which; the zone keys in `data/encounters.js` were hand-curated on top.
// The missing link is now decoded — see `tools/lib/ff3-map-encounters.mjs` for
// the CPU trace behind every address used here:
//
//   map id ($48) -> $92F0[map]              = encounter GROUP
//   group        -> $94F0 + group*8         = EIGHT formation ids
//   slot         -> $BD78[random & 0x3F]    = 12/12/12/12/6/6/3/1 out of 64
//   formation    -> ENCOUNTER_SET $5C010    = species record + count pattern
//   rate         -> $BE00[map]              = chance out of 256, per step check
//
//   node tools/map-encounters.mjs 103 104 105 106
//   node tools/map-encounters.mjs --area 24        # every map in an area
//   node tools/map-encounters.mjs --world          # the world-0 region grid
//   node tools/map-encounters.mjs --all            # every map with encounters
//
// ⛔ An earlier version of this file tested the hypothesis "map property byte 12
// is the encounter set" and self-tested against our own hand-authored zones.
// Both were wrong: the byte is not an encounter index, and our zones are not an
// oracle. The oracle is the running game — `tools/check-map-encounters.mjs`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ME from './lib/ff3-map-encounters.mjs';
import * as EN from './lib/ff3-encounters.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROMP = process.env.FF3_ROM || path.join(HERE, '..', 'FF3-English.nes');
const rom = new Uint8Array(fs.readFileSync(ROMP));
const { initTextDecoder, getMonsterName } = await import('../src/text-decoder.js');
initTextDecoder(rom);

const PROPS = 0x004010;
const areaOf = (m) => rom[PROPS + m * 16 + 5];
/** FF3's glyph codes -> ASCII. Same mapping `gen-encounters-js.js` uses. */
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
const name = (id) => {
  try { return nesText(getMonsterName(id)) || `mon$${id.toString(16)}`; }
  catch { return `mon$${id.toString(16)}`; }
};

/** A formation id -> the groups the expander would build. */
export function formation(f) {
  const [recIdx, countByte] = EN.setEntry(rom, f);
  const species = EN.speciesOf(rom, recIdx);
  const counts = EN.countsOf(rom, countByte & EN.COUNT_INDEX_MASK);
  const groups = [];
  for (let g = 0; g < EN.SPECIES_SLOTS; g++) {
    const [min, max] = EN.countRange(counts[g]);
    if (max > 0 && species[g] !== EN.SPECIES_EMPTY) groups.push({ id: species[g], min, max });
  }
  return { f, recIdx, countByte, isBoss: !!(countByte & 0x40), groups };
}

const fmtGroups = (gs) => gs.map((g) => `${name(g.id)}(0x${g.id.toString(16)}) x${g.min}-${g.max}`).join(' + ') || '(empty)';

export function describeMap(m) {
  const rate = ME.rateForMap(rom, m), g = ME.groupForMap(rom, m);
  const w = ME.weightedGroup(rom, g);
  console.log(`map ${String(m).padStart(3)}  area 0x${areaOf(m).toString(16)}  ` +
              `rate ${String(rate).padStart(2)}/256  group 0x${g.toString(16).padStart(2, '0')}` +
              `${rate === 0 ? '   (no random encounters)' : ''}`);
  for (const { formation: f, weight } of w)
    console.log(`     ${String(weight).padStart(2)}/64  formation 0x${f.toString(16).padStart(2, '0')}  ${fmtGroups(formation(f).groups)}`);
  return { map: m, rate, group: g, weighted: w };
}

const args = process.argv.slice(2);
const nums = args.filter((a) => /^\d+$/.test(a)).map(Number);
const flag = (n) => args.includes('--' + n);

if (flag('world')) {
  console.log(`world 0 (128x128, 32-tile regions) — on-foot rate ${ME.world0FootRate(rom)}/256\n`);
  for (let yr = 0; yr < 4; yr++) {
    for (let xr = 0; xr < 4; xr++) {
      const g = rom[ME.WORLD0_GRID + (xr | (yr * 4))];
      console.log(`region x ${xr * 32}-${xr * 32 + 31}, y ${yr * 32}-${yr * 32 + 31}  group 0x${g.toString(16)}`);
      for (const { formation: f, weight } of ME.weightedGroup(rom, g))
        console.log(`     ${String(weight).padStart(2)}/64  formation 0x${f.toString(16).padStart(2, '0')}  ${fmtGroups(formation(f).groups)}`);
    }
  }
} else if (flag('area')) {
  const a = nums[0];
  for (let m = 0; m < ME.MAP_COUNT; m++) if (areaOf(m) === a) describeMap(m);
} else if (flag('all')) {
  for (let m = 0; m < ME.MAP_COUNT; m++) if (ME.rateForMap(rom, m) !== 0) describeMap(m);
} else if (nums.length) {
  for (const m of nums) describeMap(m);
} else {
  console.log('usage: map-encounters.mjs <mapId...> | --area <n> | --world | --all');
  console.log(`\nslot odds out of 64: ${ME.slotOdds(rom).join(', ')}`);
}
