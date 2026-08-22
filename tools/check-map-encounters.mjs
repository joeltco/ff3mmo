#!/usr/bin/env node
// check-map-encounters.mjs — the map -> encounter chain stays decoded, and the
// shipped zones stay the cartridge's.
//
//   node tools/check-map-encounters.mjs
//
// WHY THIS GATE EXISTS
// Every zone in `src/data/encounters.js` used to be hand-authored, because
// nothing connected a map to a formation. That link is now traced (see
// `tools/lib/ff3-map-encounters.mjs`), and this pins it three ways:
//
//   1. the ROM tables still say what the trace said,
//   2. a RUNNING GAME agrees — patch a map's group byte and the monsters that
//      walk onto the field change to the patched group's, and back again,
//   3. `src/data/encounters.js` is still a faithful read of those tables, and
//      every zone the client can ask for is one the server will allow.
//
// ⛔ (2) is the one that matters. (1) and (3) would both pass if the addresses
// were wrong in the same way in the lib and the generator — they share a lib.

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NES, Controller } from 'jsnes';
import { makeTracer } from './lib/nes-trace.mjs';
import * as ME from './lib/ff3-map-encounters.mjs';
import * as EN from './lib/ff3-encounters.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROMP = process.env.FF3_ROM || path.join(HERE, '..', 'FF3-English.nes');
const rom = new Uint8Array(fs.readFileSync(ROMP));
const SNAP = zlib.gunzipSync(
  fs.readFileSync(path.join(HERE, 'states', 'ff3-freeroam.state.gz'))).toString('utf8');

let bad = 0, n = 0;
const ok = (label, cond, detail) => {
  n++;
  if (!cond) { bad++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`);
};

// ── 1. the ROM tables ───────────────────────────────────────────────────────
console.log('── ROM tables ──');
ok('slot odds are 12/12/12/12/6/6/3/1 out of 64',
   JSON.stringify(ME.slotOdds(rom)) === JSON.stringify([12, 12, 12, 12, 6, 6, 3, 1]),
   ME.slotOdds(rom).join('/'));

// The Sealed Cave's four maps climb 7 -> 8 -> 8 -> 9, and the Altar Cave's five
// climb 0 -> 1 -> 2 -> 3 -> 3. Those two ladders are the whole reason to believe
// $92F0 is the encounter table and not a coincidence: an unrelated byte does not
// come out monotone across two dungeons at once.
const GROUPS = { 103: 0x07, 104: 0x08, 105: 0x08, 106: 0x09,
                 111: 0x00, 115: 0x01, 112: 0x02, 113: 0x03, 22: 0x03,
                 116: 0x1e, 118: 0x1f, 119: 0x20 };
for (const [m, g] of Object.entries(GROUPS))
  ok(`$92F0[${m}] = ${g}`, ME.groupForMap(rom, Number(m)) === g, `got ${ME.groupForMap(rom, Number(m))}`);

ok('group 7 slots are [7,7,7,7,8,8,9,11]',
   JSON.stringify(ME.slotsForGroup(rom, 7)) === JSON.stringify([7, 7, 7, 7, 8, 8, 9, 11]),
   ME.slotsForGroup(rom, 7).join(','));

// ⛔ THE RATE TABLE IS IN A DIFFERENT BANK from everything else here — it is read
// during a map LOAD (bank 57 at $A000), not during the encounter roll (bank 61).
// Bank 61's own $BE00 is executable code, and reading it there produces a table
// of plausible-looking small numbers. These are the values measured off $F8 in a
// running game, so a wrong bank cannot pass.
const RATES = { 103: 6, 104: 6, 106: 6, 111: 6, 114: 18, 7: 0, 12: 0, 92: 8 };
for (const [m, r] of Object.entries(RATES))
  ok(`rate[${m}] = ${r}`, ME.rateForMap(rom, Number(m)) === r, `got ${ME.rateForMap(rom, Number(m))}`);

ok('world 0 on-foot rate is 5/256', ME.world0FootRate(rom) === 5, String(ME.world0FootRate(rom)));
ok("Ur's world region is 7", ME.world0Region(95, 41) === 7, String(ME.world0Region(95, 41)));

// ── 2. the running game ─────────────────────────────────────────────────────
console.log('\n── hardware ──');

const D = [Controller.BUTTON_LEFT, Controller.BUTTON_RIGHT];
/** Walk in the freeroam state until a formation is expanded; report it. */
function fight({ groupPatch = null, ratePatch = null } = {}) {
  const p = Uint8Array.from(rom);
  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(Buffer.from(p).toString('binary'));
  nes.fromJSON(JSON.parse(SNAP));
  const cpu = nes.cpu;
  const run = (k) => { for (let i = 0; i < k; i++) nes.frame(); };
  run(8);
  const map = cpu.mem[ME.MAP_ID_ZP];
  // ⛔ Patch AFTER the state is restored and the map id is known — the patch is
  // keyed on the map the run is actually standing in, not the one we assumed.
  // (A run that answers about a different map than the one it names is how the
  // last harness bug got past review.)
  if (groupPatch !== null) {
    const p2 = Uint8Array.from(rom);
    p2[ME.MAP_GROUP_LO + map] = groupPatch;
    if (ratePatch !== null) p2[ME.RATE_LO + map] = ratePatch;
    const nes2 = new NES({ onFrame: () => {}, onAudioSample: () => {} });
    nes2.loadROM(Buffer.from(p2).toString('binary'));
    nes2.fromJSON(JSON.parse(SNAP));
    return walk(nes2, map);
  }
  return walk(nes, map);
}

function walk(nes, map) {
  const cpu = nes.cpu;
  const t = makeTracer(nes);                     // ⛔ after fromJSON
  let hit = null;
  t.onRead = (addr, val, pc) => {
    if (hit) return;
    // the ENCOUNTER_SET fetch: bank 46's first 1024 bytes. Identify it by the
    // bytes rather than the mapper registers.
    if (addr < 0x8000 || addr >= 0x8400) return;
    if (cpu.mem[0x8000] !== rom[EN.ENCOUNTER_SET] || cpu.mem[0x8001] !== rom[EN.ENCOUNTER_SET + 1]) return;
    hit = { formation: (addr - 0x8000) >> 1 };
    t.recording = false;
  };
  t.recording = true;
  outer:
  for (let step = 0; step < 900 && !hit; step++) {
    const b = D[step % D.length];
    nes.buttonDown(1, b);
    for (let i = 0; i < 16; i++) { nes.frame(); if (hit) break outer; }
    nes.buttonUp(1, b);
    for (let i = 0; i < 16; i++) { nes.frame(); if (hit) break outer; }
  }
  if (!hit) return null;
  for (let i = 0; i < 30; i++) nes.frame();      // let the expander finish
  return { map, formation: hit.formation,
           speciesIdx: cpu.mem[EN.SPECIES_INDEX_ZP],
           species: [0, 1, 2, 3].map((k) => cpu.mem[EN.RAM_SPECIES + k]) };
}

const natural = fight();
if (!natural) {
  ok('an encounter fires in the freeroam state', false, 'no ENCOUNTER_SET fetch in 900 steps');
} else {
  const map = natural.map;
  const nat = ME.groupForMap(rom, map);
  const natSlots = new Set(ME.slotsForGroup(rom, nat));
  console.log(`  (the run is standing on map ${map}, natural group 0x${nat.toString(16)}, ` +
              `slots ${[...natSlots].join(',')})`);
  ok(`unpatched: formation ${natural.formation} is one of map ${map}'s own slots`,
     natSlots.has(natural.formation), `slots ${[...natSlots].join(',')}`);

  // ⭐ THE REVERT-PROOF. Group 9 is the Sealed Cave's deepest floor; its
  // formations and map 181's share NOT ONE species, so if the group byte were
  // inert — or read from the wrong offset — this could not pass.
  const PATCH = 0x09;
  const patchSlots = new Set(ME.slotsForGroup(rom, PATCH));
  const speciesOfGroup = (g) => new Set([...new Set(ME.slotsForGroup(rom, g))]
    .flatMap((f) => EN.speciesOf(rom, EN.setEntry(rom, f)[0]))
    .filter((s) => s !== EN.SPECIES_EMPTY));
  const natSpecies = speciesOfGroup(nat), patchSpecies = speciesOfGroup(PATCH);
  const overlap = [...natSpecies].filter((s) => patchSpecies.has(s));
  ok('the control and the patch share no species (so the test can fail)',
     overlap.length === 0, `overlap ${overlap.join(',') || 'none'}`);

  const patched = fight({ groupPatch: PATCH });
  ok('patched: an encounter still fires', !!patched);
  if (patched) {
    ok(`patched: formation ${patched.formation} is one of GROUP 9's slots`,
       patchSlots.has(patched.formation), `slots ${[...patchSlots].join(',')}`);
    ok('patched: formation is NOT one the natural group could roll',
       !natSlots.has(patched.formation));
    const live = patched.species.filter((s) => s !== EN.SPECIES_EMPTY);
    ok('patched: the species ON THE FIELD are the patched group\'s',
       live.length > 0 && live.every((s) => patchSpecies.has(s)),
       `field ${live.map((s) => '0x' + s.toString(16)).join(',')}`);
  }
}

// ── 3. the shipped data ─────────────────────────────────────────────────────
console.log('\n── src/data/encounters.js ──');
const { ENCOUNTERS, SLOT_ODDS, pickFormation, world0ZoneKey } = await import('../src/data/encounters.js');
const { DUNGEONS, isBossFloor, romMapForFloor } = await import('../src/data/dungeons.js');

ok('SLOT_ODDS matches the ROM', JSON.stringify(SLOT_ODDS) === JSON.stringify(ME.slotOdds(rom)));

/** Recompute a zone straight from the ROM and compare, field by field. */
function expectZone(key, group, rate) {
  const z = ENCOUNTERS.get(key);
  if (!z) { ok(`zone ${key} exists`, false); return; }
  const w = ME.weightedGroup(rom, group);
  const wantWeights = w.map((x) => x.weight);
  const wantForms = w.map(({ formation: f }) => {
    const [recIdx, countByte] = EN.setEntry(rom, f);
    const species = EN.speciesOf(rom, recIdx);
    const counts = EN.countsOf(rom, countByte & EN.COUNT_INDEX_MASK);
    const out = [];
    for (let g = 0; g < EN.SPECIES_SLOTS; g++) {
      const [min, max] = EN.countRange(counts[g]);
      if (max > 0 && species[g] !== EN.SPECIES_EMPTY) out.push({ id: species[g], min, max });
    }
    return out;
  });
  ok(`${key}: weights`, JSON.stringify(z.weights) === JSON.stringify(wantWeights),
     `${JSON.stringify(z.weights)} vs ${JSON.stringify(wantWeights)}`);
  ok(`${key}: formations`, JSON.stringify(z.formations) === JSON.stringify(wantForms));
  ok(`${key}: rate ${rate}`, z.rate === rate, `got ${z.rate}`);
}

for (const d of DUNGEONS) {
  for (let f = 0; f < d.floors; f++) {
    const map = romMapForFloor(d, f);
    expectZone(`${d.encounterZonePrefix}_f${f + 1}`, ME.groupForMap(rom, map),
               isBossFloor(d, f) ? 0 : ME.rateForMap(rom, map));
  }
  const bz = ENCOUNTERS.get(`${d.encounterZonePrefix}_boss`);
  ok(`${d.id}: boss zone is the registry's bossId`,
     !!bz && bz.formations[0][0].id === d.bossId && bz.rate === 0);
}
for (let i = 0; i < 16; i++) expectZone(`world_r${i}`, rom[ME.WORLD0_GRID + i], ME.world0FootRate(rom));
// ⛔ The Ur patch is a patch on ROM MAP 114 and takes that map's row — not the
// world region Ur stands in. They are genuinely different (map 114 has no
// Berserker and runs at 18/256 against the grass's 5), so getting this wrong is
// observable rather than cosmetic.
expectZone('grasslands_wild', ME.groupForMap(rom, 114), ME.rateForMap(rom, 114));
ok('the Ur patch is not just its world region',
   ME.groupForMap(rom, 114) !== rom[ME.WORLD0_GRID + ME.world0Region(95, 41)],
   `map 114 group 0x${ME.groupForMap(rom, 114).toString(16)} vs region group 0x${rom[ME.WORLD0_GRID + ME.world0Region(95, 41)].toString(16)}`);
ok('rate[114] is hotter than open grass', ME.rateForMap(rom, 114) > ME.world0FootRate(rom),
   `${ME.rateForMap(rom, 114)}/256 vs ${ME.world0FootRate(rom)}/256`);

// ⛔ THE ONE ZONE THAT IS OURS. Asserted as ours ON PURPOSE, so that a later
// "make everything ROM-true" pass has to delete this line rather than silently
// take Ur's starting radius from Goblins to Berserkers.
const gv = ENCOUNTERS.get('grasslands_valley');
ok('grasslands_valley is still the hand-made safe zone', !!gv && gv.rom === null &&
   gv.formations.length === 1 && gv.formations[0][0].id === 0x00);

// The client can only ask for zones the server allows.
const wsSrc = fs.readFileSync(path.join(HERE, '..', 'ws-presence.js'), 'utf8');
ok('the server allowlist is derived, not hand-listed',
   /_LOC_ZONE_ALLOWLIST = \(\(\) => \{/.test(wsSrc) && /for \(const d of DUNGEONS\)/.test(wsSrc));

// ⛔ Coverage alone is not enough — every region key exists, so a zone key that
// is merely WRONG still resolves. Compare tile by tile against the ROM's own
// arithmetic instead. (Dropping the ROM's `+7` moves Ur from r7 to r2, and
// those two regions happen to share a group, so a spot check would pass.)
ok('world0ZoneKey matches the ROM region for all 16384 tiles', (() => {
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const k = world0ZoneKey(x, y);
    if (k !== `world_r${ME.world0Region(x, y)}` || !ENCOUNTERS.has(k)) return false;
  }
  return true;
})());

// The wiring itself. A perfect table that nothing reads is the failure mode
// this repo has shipped before.
const beSrc = fs.readFileSync(path.join(HERE, '..', 'src', 'battle-encounter.js'), 'utf8');
ok('battle-encounter rolls the ROM rate', /rollEncounter\(zone\)/.test(beSrc) && !/RATE_STEPS/.test(beSrc));
ok('battle-encounter picks weighted', /pickFormation\(zone\)/.test(beSrc));
ok('battle-encounter resolves world zones from the region grid', /world0ZoneKey\(tileX, tileY\)/.test(beSrc));
const paSrc = fs.readFileSync(path.join(HERE, '..', 'pve-arbiter.js'), 'utf8');
ok('the PvE arbiter shares the picker', /pickFormation\(zone, rng\)/.test(paSrc) &&
   !/formations\[Math\.floor\(rng/.test(paSrc));

// pickFormation must respect the weights, not fall back to uniform.
const z7 = ENCOUNTERS.get('seals_cave_f1');
let rare = 0;
for (let i = 0; i < 64000; i++) if (pickFormation(z7) === z7.formations[3]) rare++;
ok('pickFormation honours the 1-in-64 slot', rare > 700 && rare < 1350, `${rare}/64000, want ~1000`);

console.log(`\n${bad ? `FAILED ${bad}/${n}` : `all ${n} checks pass`}`);
process.exit(bad ? 1 : 0);
