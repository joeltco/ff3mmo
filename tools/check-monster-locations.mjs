#!/usr/bin/env node
// check-monster-locations.mjs — "Found in" stays the ROM's answer.
//
//   node tools/check-monster-locations.mjs
//
// `src/data/monsters.js` used to say so in its own header: "location is hand
// data". Seventy invented tag names, copied forward by the generator on every
// regeneration so nothing ever noticed, and shown to the player in the bestiary.
// They are now a reverse index over the decoded map -> encounter chain.
//
// The two claims that took real work, and that this pins:
//   * the formation id is 16-BIT — the group table holds only the low byte, and
//     `$78` picks the half. Without it 410 of 512 formations are unreachable and
//     122 monsters look like they never spawn.
//   * a rate-0 map has NO random encounters, so it contributes no location. Every
//     town shares group 0 with the world's Goblins purely because 0 is the
//     table's default.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ME from './lib/ff3-map-encounters.mjs';
import * as EN from './lib/ff3-encounters.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const rom = new Uint8Array(fs.readFileSync(path.join(HERE, '..', 'FF3-English.nes')));
const { MONSTERS } = await import('../src/data/monsters.js');
const { buildIndex, placesFor } = await import('./monster-locations.mjs');

let bad = 0, n = 0;
const ok = (label, cond, detail) => {
  n++;
  if (!cond) { bad++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`);
};

// ── the 16-bit formation id ────────────────────────────────────────────────
ok('formationBase(0) is 0 and any other world is +256',
   ME.formationBase(0) === 0 && ME.formationBase(1) === 256 && ME.formationBase(3) === 256);

// ⛔ The revert this is really guarding: drop the base and the upper half of
// ENCOUNTER_SET becomes unreachable. Count it rather than assert a symptom.
const reachable = (withBase) => {
  const forms = new Set();
  const push = (g, base) => { for (const f of ME.slotsForGroup(rom, g, base)) forms.add(f); };
  for (let m = 0; m < 512; m++) {
    if (ME.rateForMap(rom, m) === 0) continue;
    push(ME.groupForMap(rom, m), withBase ? ME.formationBase(m < 256 ? 0 : 1) : 0);
  }
  for (let i = 0; i < 16; i++) push(rom[ME.WORLD0_GRID + i], 0);
  for (let i = 0; i < 64; i++) push(rom[ME.WORLD3_GRID + i], withBase ? 256 : 0);
  for (let i = 0; i < 7; i++) push(rom[ME.WORLD_CFG + i], withBase && i >= 2 ? 256 : 0);
  return forms;
};
const withBase = reachable(true), without = reachable(false);
ok('the high half of ENCOUNTER_SET is reachable', withBase.size > without.size * 1.5,
   `${withBase.size} formations with the base, ${without.size} without`);
// ⛔ COUNT IS NOT AN ID. A first version asserted `size > 256` and read 174 as a
// failure — 174 distinct formations says nothing about WHICH half they are in.
const maxId = Math.max(...withBase), maxNo = Math.max(...without);
ok('reachable formations actually reach the UPPER half',
   maxId >= EN.ENCOUNTER_SET_ENTRIES / 2 && maxNo < EN.ENCOUNTER_SET_ENTRIES / 2,
   `highest id ${maxId} with the base, ${maxNo} without`);

// ── rate 0 contributes nothing ─────────────────────────────────────────────
// Ur's elder house (map 7) is rate 0 and group 0 — the same group as Altar
// Cave's Goblins. If the filter were dropped every Goblin would be "found in" it.
ok('map 7 (a house) is rate 0 while sharing group 0 with Altar Cave',
   ME.rateForMap(rom, 7) === 0 && ME.groupForMap(rom, 7) === ME.groupForMap(rom, 111));

// ── the shipped data is the index ──────────────────────────────────────────
const idx = buildIndex();
let drift = 0;
for (const [id, v] of MONSTERS) {
  const want = placesFor(id);
  const got = v.location || [];
  if (JSON.stringify(want) !== JSON.stringify(got)) {
    if (drift < 5) console.log(`  drift 0x${id.toString(16)}: shipped ${JSON.stringify(got)} vs ROM ${JSON.stringify(want)}`);
    drift++;
  }
}
ok('every shipped `location` equals the ROM index', drift === 0, `${drift} monsters differ`);

// ⛔ THE ORIGINAL SIN: hand-authored snake_case tags. If any survive, the
// generator has gone back to copying the old file forward.
const handish = [...MONSTERS].filter(([, v]) => (v.location || []).some((l) => /^[a-z][a-z0-9_]*$/.test(l)));
ok('no hand-authored snake_case tags remain', handish.length === 0,
   handish.slice(0, 4).map(([id, v]) => `0x${id.toString(16)}:${v.location.join(',')}`).join(' '));

// ── the two dungeons we ship, end to end ───────────────────────────────────
const inPlace = (place) => [...MONSTERS].filter(([, v]) => (v.location || []).includes(place)).map(([id]) => id);
const seals = new Set(inPlace('Sealed Cave'));
const UNDEAD = [0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f];
ok('the Sealed Cave lists all six undead the ROM spawns there',
   UNDEAD.every((i) => seals.has(i)), UNDEAD.filter((i) => !seals.has(i)).map((i) => '0x' + i.toString(16)).join(',') || 'all present');
// ⭐ Zombie ($09) is NOT in that cave — the hand data put it on floor 1.
ok('Zombie is NOT listed in the Sealed Cave', !seals.has(0x09));
const altar = new Set(inPlace('Altar Cave'));
ok('Altar Cave lists exactly Goblin / Carbuncle / Eye Fang / Blue Wisp',
   [0x00, 0x01, 0x02, 0x03].every((i) => altar.has(i)) && ![...altar].some((i) => i > 0x03),
   [...altar].map((i) => '0x' + i.toString(16)).join(','));

// ── bosses carry none ──────────────────────────────────────────────────────
// Boss battles are script-triggered, not rolled from a map's group, so the
// honest answer for them is no location at all rather than a guess.
ok('the Land Turtle and the Djinn carry no location',
   !MONSTERS.get(0xCC).location && !MONSTERS.get(0xCD).location);

const withLoc = [...MONSTERS].filter(([, v]) => v.location).length;
console.log(`\n  (${withLoc} of ${MONSTERS.size} monsters have a ROM location; the rest are bosses or unused)`);
console.log(`\n${bad ? `FAILED ${bad}/${n}` : `all ${n} checks pass`}`);
process.exit(bad ? 1 : 0);
