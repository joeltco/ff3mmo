#!/usr/bin/env node
// check-ff3-encounters.mjs — FF3's formation tables stay decoded.
//
// Pins the two claims that took real work: a formation RECORD is 6 bytes with the
// four species ids at +2, and the COUNT record is 4 nibble-packed min/max bytes
// that the game rolls per battle. Both are checked against a running encounter —
// the count by patching the live record and counting bodies on the field.
//
//   node tools/check-ff3-encounters.mjs
//
// ⛔ The species record and the count record use DIFFERENT indices (0 and 7 for
// the freeroam encounter). Patching `COUNT_TABLE + 0*4` changes nothing and looks
// like the table is inert — the live index has to be used.

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NES, Controller } from 'jsnes';
import { glyph } from './lib/ff3-text.mjs';
import * as M3 from './lib/ff3-monsters.mjs';
import * as EN from './lib/ff3-encounters.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const rom = new Uint8Array(fs.readFileSync(path.join(HERE, '..', 'FF3-English.nes')));
const SNAP = zlib.gunzipSync(
  fs.readFileSync(path.join(HERE, 'states', 'ff3-freeroam.state.gz'))).toString('utf8');
const D = [Controller.BUTTON_LEFT, Controller.BUTTON_RIGHT,
           Controller.BUTTON_UP, Controller.BUTTON_DOWN];
const LIVE_COUNT_INDEX = 7;          // measured off $7D68 & 0x3F

let bad = 0, n = 0;
const ok = (label, cond, detail) => {
  n++;
  if (!cond) { bad++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`);
};

/** Walk into an encounter with `patch` applied; report the field. */
function fight(patch = {}) {
  const p = Uint8Array.from(rom);
  p[M3.MONSTER_PROPS + 1] = 0xFF; p[M3.MONSTER_PROPS + 2] = 0x0F;
  for (const [o, v] of Object.entries(patch)) p[Number(o)] = v;
  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  try { nes.loadROM(Buffer.from(p).toString('binary')); nes.fromJSON(JSON.parse(SNAP)); } catch { return null; }
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
  try {
    run(30);
    for (let s = 0; s < 300; s++) {
      const b = D[Math.floor(s / 8) % 4];
      nes.buttonDown(1, b); run(10); nes.buttonUp(1, b); run(12);
      if (lines().some(l => /Guard|Item/i.test(l))) {
        let bodies = 0;
        for (let i = 0; i < 4; i++) {
          const a = M3.enemyAddr(i);
          if ((nes.cpu.mem[a] | (nes.cpu.mem[a + 1] << 8)) > 0) bodies++;
        }
        return { bodies,
                 species: [...nes.cpu.mem.slice(EN.RAM_SPECIES, EN.RAM_SPECIES + 4)],
                 counts: [...nes.cpu.mem.slice(EN.RAM_COUNTS, EN.RAM_COUNTS + 4)],
                 screen: lines() };
      }
    }
  } catch { /* fall through */ }
  return null;
}

console.log('FF3 encounter formations — the tables vs a real encounter\n');

const base = fight();
if (!base) { console.error('no encounter'); process.exit(1); }

// ── the species record ──────────────────────────────────────────────────────
ok('the expander leaves the ROM species ids in RAM',
   JSON.stringify(base.species) === JSON.stringify(EN.speciesOf(rom, 0)),
   `${base.species.join(',')} vs ${EN.speciesOf(rom, 0).join(',')}`);
ok('unused species slots are 0xFF', base.species.slice(1).every(v => v === EN.SPECIES_EMPTY));
// ⭐ patching the species id changes WHO shows up — the name on screen follows.
const tiger = fight({ [EN.SPECIES_TABLE + EN.SPECIES_ID_OFF]: 0x29 });   // Flyer
ok('patching the species id changes the monster drawn',
   tiger && tiger.screen.some(l => /Flye/i.test(l)) && base.screen.some(l => /Gobl/i.test(l)),
   tiger ? tiger.screen.filter(l => /[A-Za-z]{3,}/.test(l))[0] : 'no battle');

// ── the count record ────────────────────────────────────────────────────────
const CB = EN.COUNT_TABLE + LIVE_COUNT_INDEX * EN.COUNT_STRIDE;
const [minN, maxN] = EN.countRange(rom[CB]);
ok('the natural count byte is a min/max range', minN >= 1 && maxN >= minN,
   `0x${rom[CB].toString(16)} -> ${minN}..${maxN}`);
ok('the rolled count sits inside that range',
   base.counts[0] >= minN && base.counts[0] <= maxN, `${base.counts[0]} in ${minN}..${maxN}`);
ok('bodies on the field match the rolled count', base.bodies === base.counts[0],
   `${base.bodies} bodies, count ${base.counts[0]}`);
// ⭐ the discriminator: a FIXED range must produce exactly that many, every time.
for (const [raw, want] of [[0x11, 1], [0x33, 3], [0x44, 4]]) {
  const r = fight({ [CB]: raw });
  ok(`count byte 0x${raw.toString(16)} puts ${want} on the field`, r && r.bodies === want,
     r ? `${r.bodies}` : 'no battle');
}
// ⛔ and the wrong index must NOT work — that is what made this look inert.
const wrongIdx = fight({ [EN.COUNT_TABLE + 0 * EN.COUNT_STRIDE]: 0x44 });
ok('patching index 0 does NOT change the field — the indices differ',
   wrongIdx && wrongIdx.bodies === base.bodies, wrongIdx ? `${wrongIdx.bodies}` : 'no battle');

// ── ENCOUNTER_SET: the pair of indices ──────────────────────────────────────
// ⭐ This is what explains the two different offsets: the zone entry picks the
// species record and the count pattern SEPARATELY.
console.log('\nENCOUNTER_SET — zone -> (species record, count pattern)');
const [s0, c0] = EN.setEntry(rom, 0);
ok('entry 0 holds the indices the expander used', s0 === 0 && (c0 & EN.COUNT_INDEX_MASK) === LIVE_COUNT_INDEX,
   `species ${s0}, count ${c0}`);
// ⛔ Zone 0 cannot test the STRIDE — zone*stride is 0 whatever the stride is, so
// a wrong stride sails through. Check a NONZERO zone against a file offset taken
// from the disassembly (`ASL $7E / ROL $7F` = *2), not from the constant.
ok('the entry stride is 2 — checked on a NONZERO zone',
   JSON.stringify(EN.setEntry(rom, 1)) === JSON.stringify([rom[0x05C012], rom[0x05C013]]),
   `zone 1 = ${EN.setEntry(rom, 1).join(',')} vs ROM ${rom[0x05C012]},${rom[0x05C013]}`);
ok('...and zone 3 too', JSON.stringify(EN.setEntry(rom, 3)) === JSON.stringify([rom[0x05C016], rom[0x05C017]]),
   `zone 3 = ${EN.setEntry(rom, 3).join(',')}`);
for (const [v, want] of [[6, 9], [7, 10]]) {
  const r = fight({ [EN.ENCOUNTER_SET]: v });
  ok(`byte 0 = ${v} spawns species record ${v} (id ${want})`,
     r && r.species[0] === want, r ? `species ${r.species[0]}` : 'no battle');
}
for (const [v, want] of [[0, 1], [2, 3], [3, 4]]) {
  const r = fight({ [EN.ENCOUNTER_SET + 1]: v });
  ok(`byte 1 = ${v} puts ${want} on the field`, r && r.bodies === want,
     r ? `${r.bodies}` : 'no battle');
}
// ⭐ the count table is a SHARED library of patterns, not per-formation data.
ok('COUNT_TABLE is a library of ranges (0=1..1, 3=4..4, 9=4..8)',
   EN.countRange(EN.countsOf(rom, 0)[0]).join() === '1,1'
   && EN.countRange(EN.countsOf(rom, 3)[0]).join() === '4,4'
   && EN.countRange(EN.countsOf(rom, 9)[0]).join() === '4,8');

console.log(`\n${n - bad}/${n} checks passed`);
process.exit(bad ? 1 : 0);
