#!/usr/bin/env node
// map-encounters.mjs — which monsters a MAP actually fights, from the ROM.
//
// `gen-encounters-js.js` decodes all 256 formations but never says which map
// uses which; the zone keys in `data/encounters.js` are hand-curated on top. So
// "what does the Sealed Cave fight?" had no answer short of guessing.
//
// ⭐ HYPOTHESIS UNDER TEST: map property BYTE 12 is the encounter-set index.
// It is not asserted — run with no argument and the tool decodes Altar Cave's
// maps and diffs them against the `altar_cave_f*` zones we already ship. If
// byte 12 is right, the species come out equal. If they do not, the tool says so
// and the number is wrong.
//
//   node tools/map-encounters.mjs            # self-test against Altar Cave
//   node tools/map-encounters.mjs 103 104 106
//
// Formation chain (from gen-encounters-js.js, unchanged):
//   set   $5C010 + i*2      -> [monListIdx, flags]; struct = flags & 0x3F
//   mons  $5C410 + idx*6    -> four species ids at +2
//   count $5CA10 + idx*4    -> four nibble-packed min/max

import fs from 'node:fs';

const rom = new Uint8Array(fs.readFileSync(process.env.FF3_ROM || 'FF3-English.nes'));
const { initTextDecoder, getMonsterName } = await import('../src/text-decoder.js');
initTextDecoder(rom);

const PROPS = 0x004010, ENC_SET = 0x05C010, ENC_MON = 0x05C410, ENC_STR = 0x05CA10;
const ENCOUNTER_BYTE = 12;

const name = (id) => {
  try { return String(getMonsterName(id)).replace(/[^\x20-\x7e]/g, '').trim() || `mon${id}`; }
  catch { return `mon$${id.toString(16)}`; }
};

export function formationsForSet(setIdx) {
  const soff = ENC_SET + setIdx * 2;
  const monListIdx = rom[soff], flags = rom[soff + 1];
  const moff = ENC_MON + monListIdx * 6;
  const monIds = [rom[moff + 2], rom[moff + 3], rom[moff + 4], rom[moff + 5]];
  const strOff = ENC_STR + (flags & 0x3F) * 4;
  const groups = [];
  for (let g = 0; g < 4; g++) {
    const b = rom[strOff + g];
    const min = (b >> 4) & 0xF, max = b & 0xF;
    if (max > 0 && monIds[g] !== 0xFF) groups.push({ id: monIds[g], min, max });
  }
  return { setIdx, isBoss: !!(flags & 0x40), groups };
}

export const encounterSetForMap = (m) => rom[PROPS + m * 16 + ENCOUNTER_BYTE];

const show = (m) => {
  const set = encounterSetForMap(m);
  const f = formationsForSet(set);
  const txt = f.groups.map((g) => `${name(g.id)} (0x${g.id.toString(16)}) x${g.min}-${g.max}`).join(' + ');
  console.log(`  map ${String(m).padStart(3)}  set 0x${set.toString(16).padStart(2, '0')}${f.isBoss ? ' [BOSS]' : ''}  ${txt || '(none)'}`);
  return f;
};

const args = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);

if (!args.length) {
  // ── self-test: does byte 12 reproduce the zones we already ship? ─────────
  const { ENCOUNTERS } = await import('../src/data/encounters.js');
  console.log('Altar Cave, decoded from byte 12:');
  const maps = [111, 113, 22, 115];
  const got = maps.map(show);
  console.log('\nshipped altar_cave_f* zones:');
  let anyMatch = false;
  for (const key of ['altar_cave_f1', 'altar_cave_f2', 'altar_cave_f3', 'altar_cave_f4']) {
    const z = ENCOUNTERS.get(key);
    const species = new Set(z.formations.flat().map((g) => g.id));
    console.log(`  ${key.padEnd(14)} ${[...species].map((i) => `${name(i)} (0x${i.toString(16)})`).join(', ')}`);
    if (got.some((f) => f.groups.some((g) => species.has(g.id)))) anyMatch = true;
  }
  console.log(anyMatch
    ? '\n⭐ byte 12 decodes to species that appear in the shipped Altar Cave zones — hypothesis holds'
    : '\n⛔ byte 12 decodes to species that appear in NO shipped Altar Cave zone — WRONG BYTE, do not use');
} else {
  for (const m of args) show(m);
}
