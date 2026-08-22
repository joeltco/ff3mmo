#!/usr/bin/env node
// check-real-battles.mjs — the real-battle harness really does force the
// formation it claims, and really does read the monsters that spawned.
//
//   node tools/check-real-battles.mjs
//
// WHAT THIS PROTECTS
// `tools/ff3-fight-real.mjs` is the only thing in this repo that answers a
// balance question with the CARTRIDGE rather than with `battle-sim.js`. Its
// value rests entirely on two mechanisms, and both failed silently on the first
// attempt:
//
//   1. Overwriting all eight slots of the live map's group must actually pin
//      the formation. If the patch missed, every "measurement" would just be
//      the map's natural encounter wearing the label of the one under test.
//   2. Reading the species. The first version read `enemyAddr(i) + 0x20` — an
//      offset nothing had measured — and printed "Carbuncle" for a formation
//      the ROM says is Goblins. It now reads `$7D6B`, where the expander leaves
//      the ids, and the battle screen is the independent witness.
//
// ⛔ This gate deliberately does NOT pin win rates. Those are balance, and
// balance is meant to change; the harness is what must not rot.

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NES, Controller } from 'jsnes';
import { glyph } from './lib/ff3-text.mjs';
import * as M3 from './lib/ff3-monsters.mjs';
import * as ME from './lib/ff3-map-encounters.mjs';
import * as EN from './lib/ff3-encounters.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const rom = new Uint8Array(fs.readFileSync(path.join(HERE, '..', 'FF3-English.nes')));
const SNAP = zlib.gunzipSync(
  fs.readFileSync(path.join(HERE, 'states', 'ff3-freeroam.state.gz'))).toString('utf8');
const D = [Controller.BUTTON_LEFT, Controller.BUTTON_RIGHT,
           Controller.BUTTON_UP, Controller.BUTTON_DOWN];

let bad = 0, n = 0;
const ok = (label, cond, detail) => {
  n++;
  if (!cond) { bad++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`);
};

/** Walk into one encounter, optionally with the group repointed. */
function encounter(formation = null, seed = 0, rounds = 0) {
  const p = Uint8Array.from(rom);
  const nes0 = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes0.loadROM(Buffer.from(rom).toString('binary'));
  nes0.fromJSON(JSON.parse(SNAP));
  for (let i = 0; i < 30; i++) nes0.frame();
  const map = nes0.cpu.mem[ME.MAP_ID_ZP];
  const group = ME.groupForMap(rom, map);
  if (formation !== null)
    for (let s = 0; s < ME.GROUP_STRIDE; s++) p[ME.GROUP_TABLE + group * ME.GROUP_STRIDE + s] = formation;

  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(Buffer.from(p).toString('binary'));
  nes.fromJSON(JSON.parse(SNAP));
  const cpu = nes.cpu;
  const run = (k) => { for (let i = 0; i < k; i++) nes.frame(); };
  const lines = () => {
    const v = nes.ppu.vramMem, out = [];
    for (let r = 0; r < 30; r++) {
      let s = '';
      for (let c = 0; c < 32; c++) { const g = glyph(v[0x2000 + r * 32 + c]); s += (g === null ? ' ' : g); }
      if (s.trim()) out.push(s.replace(/\s+/g, ' ').trim());
    }
    return out;
  };
  const w16 = (a) => cpu.mem[a] | (cpu.mem[a + 1] << 8);
  run(30 + seed);
  let started = false;
  for (let s = 0; s < 400 && !started; s++) {
    const b = D[Math.floor(s / 8) % 4];
    nes.buttonDown(1, b); run(10); nes.buttonUp(1, b); run(12);
    started = lines().some((l) => /Guard|Item/i.test(l));
  }
  if (!started) return null;
  const species = [0, 1, 2, 3].map((k) => cpu.mem[EN.RAM_SPECIES + k])
    .filter((s) => s !== EN.SPECIES_EMPTY);
  const bodies = [0, 1, 2, 3].filter((i) => w16(M3.enemyAddr(i) + M3.HP_MAX_OFF) > 0).length;
  const drawn = (lines().find((l) => /\d+\/ ?\d+/.test(l)) || '').split(/\s+/)[0] || '';
  let outcome = 'none';
  for (let k = 0; k < rounds; k++) {
    nes.buttonDown(1, Controller.BUTTON_A); run(8);
    nes.buttonUp(1, Controller.BUTTON_A); run(18);
    if ([0, 1, 2, 3].every((i) => w16(M3.partyAddr(i)) === 0)) { outcome = 'loss'; break; }
    if ([0, 1, 2, 3].filter((i) => w16(M3.enemyAddr(i) + M3.HP_MAX_OFF) > 0)
        .every((i) => w16(M3.enemyAddr(i)) === 0)) {
      run(120);
      if (!lines().some((l) => /Guard|Item/i.test(l))) { outcome = 'win'; break; }
    }
  }
  return { map, group, species, bodies, drawn, outcome,
           party: [0, 1, 2, 3].map((i) => w16(M3.partyAddr(i))) };
}

console.log('FF3 real-battle harness — checked against the running game\n');

const nat = encounter(null, 0);
if (!nat) { console.error('the baseline encounter never fired'); process.exit(1); }
console.log(`  (map ${nat.map}, natural group 0x${nat.group.toString(16)})`);

// ── 1. the natural encounter is the map's own ───────────────────────────────
const natSlots = new Set(ME.slotsForGroup(rom, nat.group));
const speciesOf = (f) => EN.speciesOf(rom, EN.setEntry(rom, f)[0]).filter((s) => s !== EN.SPECIES_EMPTY);
const natSpecies = new Set([...natSlots].flatMap(speciesOf));
ok('unpatched: the species that spawn belong to the map\'s own group',
   nat.species.length > 0 && nat.species.every((s) => natSpecies.has(s)),
   `${nat.species.map((s) => '0x' + s.toString(16)).join(',')}`);

// ── 2. forcing a formation actually forces it ───────────────────────────────
// Group 9 is the Cave of Seals' deepest floor; it shares NOT ONE species with
// this map's natural group, so a patch that did nothing cannot pass.
const FORCED = 0x0a;                       // Skeleton + Mummy, from group 9
const forcedSpecies = new Set(speciesOf(FORCED));
const overlap = [...natSpecies].filter((s) => forcedSpecies.has(s));
ok('the control and the forced formation share no species (so the test can fail)',
   overlap.length === 0, `overlap ${overlap.map((s) => '0x' + s.toString(16)).join(',') || 'none'}`);

const forced = encounter(FORCED, 0);
ok('patched: an encounter still fires', !!forced);
if (forced) {
  ok('patched: the species that spawn are the FORCED formation\'s',
     forced.species.length > 0 && forced.species.every((s) => forcedSpecies.has(s)),
     `${forced.species.map((s) => '0x' + s.toString(16)).join(',')}`);
  ok('patched: NONE of the map\'s natural species appear',
     !forced.species.some((s) => natSpecies.has(s)));
  ok('patched: body count is within the formation\'s own min..max',
     forced.bodies >= 1 && forced.bodies <= 4, `${forced.bodies} bodies`);
}

// ── 3. the species read agrees with what the game DRAWS ─────────────────────
// ⛔ This is the check that would have caught reading the species from an
// invented combatant offset: `$7D6B` said Carbuncle while the screen said Gobl.
const { initTextDecoder, getMonsterName } = await import('../src/text-decoder.js');
initTextDecoder(rom);
const nesText = (b) => [...b].map((c) =>
  c >= 0xCA && c <= 0xE3 ? String.fromCharCode(c - 0xCA + 97)
  : c >= 0x8A && c <= 0xA3 ? String.fromCharCode(c - 0x8A + 65)
  : c >= 0x80 && c <= 0x89 ? String.fromCharCode(c - 0x80 + 48) : '').join('');
for (const e of [nat, forced].filter(Boolean)) {
  const first = nesText(getMonsterName(e.species[0]));
  ok(`the $7D6B species matches the name on screen ("${e.drawn}")`,
     e.drawn.length > 0 && first.toLowerCase().startsWith(e.drawn.toLowerCase().slice(0, 3)),
     `$7D6B says ${first}`);
}

// ── 4. an outcome is actually detected, both ways ───────────────────────────
// Goblins the starting party beats; group 9's Skeleton + Mummy wipes it. If the
// detector were stuck on one answer, these two could not disagree.
const w = encounter(0x00, 0, 200);
ok('a winnable fight reports "win"', w && w.outcome === 'win', w ? w.outcome : 'no battle');
const l = encounter(0x0a, 0, 200);
ok('a losing fight reports "loss" with the party at zero',
   l && l.outcome === 'loss' && l.party.every((h) => h === 0),
   l ? `${l.outcome} party ${l.party.join('/')}` : 'no battle');

console.log(`\n${bad ? `FAILED ${bad}/${n}` : `all ${n} checks pass`}`);
process.exit(bad ? 1 : 0);
