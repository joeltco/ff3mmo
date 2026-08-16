#!/usr/bin/env node
// check-ff1-encounters.mjs — FF1's formation record stays decoded.
//
// Byte 2 was already pinned as "a monster id". This holds the rest: FOUR species
// ids at 2-5, each with its own NIBBLE-PACKED min..max count at 6-9 — the same
// shape FF3 uses.
//
//   node tools/check-ff1-encounters.mjs
//
// ⛔ Count bodies by MAX hp (RAM 9), not current hp (RAM 13): a just-spawned
// enemy has not had current hp filled in yet and the tally reads one short.
// ⛔ The party is teleported with $27/$28 — pokeable on the overworld, unlike the
// $68/$69 every other map uses.

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NES, Controller } from 'jsnes';
import * as F1 from './lib/ff1-text.mjs';
import * as MN from './lib/ff1-monsters.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROMP = process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes';
const rom = new Uint8Array(fs.readFileSync(ROMP));
const SNAP = zlib.gunzipSync(
  fs.readFileSync(path.join(HERE, 'states', 'ff1-world.state.gz'))).toString('utf8');
const D = [Controller.BUTTON_LEFT, Controller.BUTTON_RIGHT];

let bad = 0, n = 0;
const ok = (label, cond, detail) => {
  n++;
  if (!cond) { bad++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`);
};

/** Patch formation 0 and walk into a real encounter. */
function fight(patch = {}) {
  const p = Uint8Array.from(rom);
  for (const [o, v] of Object.entries(patch)) {
    const off = Number(o);
    if (!Number.isInteger(off)) throw new Error(`bad patch key ${JSON.stringify(o)}`);
    p[MN.FORMATION_TABLE + off] = v;
  }
  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  try { nes.loadROM(Buffer.from(p).toString('binary')); nes.fromJSON(JSON.parse(SNAP)); } catch { return null; }
  const run = (k) => { for (let i = 0; i < k; i++) nes.frame(); };
  const lines = () => {
    const v = nes.ppu.vramMem, out = [];
    for (let r = 0; r < 30; r++) {
      let s = '';
      for (let c = 0; c < 32; c++) { const g = F1.glyph(v[0x2000 + r * 32 + c]); s += (g === null || g === '\n') ? ' ' : g; }
      if (s.trim()) out.push(s.trim());
    }
    return out;
  };
  try {
    run(20);
    nes.cpu.mem[0x27] = 150; nes.cpu.mem[0x28] = 170;
    run(20);
    for (let s = 0; s < 300; s++) {
      const b = D[Math.floor(s / 6) % 2];
      nes.buttonDown(1, b); run(8); nes.buttonUp(1, b); run(12);
      if (lines().some(l => /\bRUN\b/.test(l))) {
        const slots = [...nes.cpu.mem.slice(MN.MONSTER_SLOTS, MN.MONSTER_SLOTS + MN.FORMATION_MAX_SPECIES)];
        let bodies = 0;
        for (let i = 0; i < 9; i++) {
          const a = MN.ENEMY_RAM + i * MN.ENEMY_RAM_STRIDE;
          if ((nes.cpu.mem[a + MN.ENEMY_MAXHP_OFF] | (nes.cpu.mem[a + MN.ENEMY_MAXHP_OFF + 1] << 8)) > 0) bodies++;
        }
        return { bodies, species: slots.filter(v => v !== MN.EMPTY_SLOT), slots };
      }
    }
  } catch { /* fall through */ }
  return null;
}

console.log('FF1 formations — the 16-byte record vs a real encounter\n');
const base = fight();
if (!base) { console.error('no encounter'); process.exit(1); }
const rec = MN.formationOf(rom, 0);
const [lo, hi] = MN.countRange(rec[MN.FORMATION_COUNT_OFF[0]]);
ok('formation 0 is a single species', base.species.length === 1, `[${base.species.join(',')}]`);
ok('its body count sits inside the record\'s range',
   base.bodies >= lo && base.bodies <= hi, `${base.bodies} in ${lo}..${hi}`);

// ⭐ a FIXED range must produce exactly that many, every time.
console.log('\nthe count byte is nibble-packed min..max');
for (const [raw, want] of [[0x11, 1], [0x33, 3], [0x66, 6], [0x99, 9]]) {
  const r = fight({ [MN.FORMATION_COUNT_OFF[0]]: raw });
  ok(`count 0x${raw.toString(16)} puts ${want} on the field`, r && r.bodies === want,
     r ? `${r.bodies}` : 'no battle');
}

// ⭐ each id is inert until ITS OWN count says otherwise — the pairing.
console.log('\neach species id pairs with its own count');
for (let i = 1; i < MN.FORMATION_MAX_SPECIES; i++) {
  const idOff = MN.FORMATION_SPECIES_OFF[i], cOff = MN.FORMATION_COUNT_OFF[i];
  const idOnly = fight({ [idOff]: 0x3A });
  ok(`byte ${idOff} alone adds nothing (its count is 0)`,
     idOnly && !idOnly.species.includes(0x3A), idOnly ? `[${idOnly.species.join(',')}]` : '');
  const both = fight({ [idOff]: 0x3A, [cOff]: 0x22 });
  ok(`...but with byte ${cOff} set, species 0x3A appears`,
     both && both.species.includes(0x3A) && both.bodies > base.bodies,
     both ? `[${both.species.join(',')}] ${both.bodies} bodies` : '');
}
console.log(`\n${n - bad}/${n} checks passed`);
process.exit(bad ? 1 : 0);
