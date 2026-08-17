#!/usr/bin/env node
// check-ff1-formation-pattern.mjs — FF1 formation byte 0 stays decoded.
//
// Byte 0 is the enemy ARRANGEMENT / SIZE pattern, and only its high nibble is
// live. Ways the decode can rot:
//
//   ⛔ reading byte 0 as a 0-255 value — the low nibble is measured inert;
//   ⛔ assuming it is a clean index OR a bitfield. It is neither: 0x30 does not
//      combine 0x10 and 0x20, and 0x50-0xF0 all collapse onto 0x80. The gate
//      pins the OUTCOMES that were measured, not a selection rule that was not;
//   ⛔ losing the fact that 0x10 renders total garbage — that is a real, drawn
//      state, not a crash, and it is what a wrong byte 0 looks like in play.
//
//   node tools/check-ff1-formation-pattern.mjs
//   node tools/check-ff1-formation-pattern.mjs --prove-revert
//
// ⛔ ~9 real battles, ~35s. None of this is visible in the ROM bytes.

import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { NES, Controller } from 'jsnes';
import * as F1 from './lib/ff1-text.mjs';
import * as MN from './lib/ff1-monsters.mjs';

const args = process.argv.slice(2);
const ROMP = process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes';
const rom = new Uint8Array(fs.readFileSync(ROMP));
const raw = fs.readFileSync('tools/states/ff1-world.state.gz');
const SNAP = (raw[0] === 0x1f && raw[1] === 0x8b) ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
const D = [Controller.BUTTON_LEFT, Controller.BUTTON_RIGHT];
const REC = MN.FORMATION_TABLE;
const sha = (b) => crypto.createHash('sha1').update(Buffer.from(b)).digest('hex').slice(0, 8);

function fight(val, off = MN.FORMATION_PATTERN_OFF) {
  const p = Uint8Array.from(rom);
  p[REC + off] = val & 0xFF;
  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(Buffer.from(p).toString('binary'));
  nes.fromJSON(JSON.parse(SNAP));
  const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
  const lines = () => {
    const v = nes.ppu.vramMem, out = [];
    for (let r = 0; r < 30; r++) {
      let s = '';
      for (let c = 0; c < 32; c++) { const g = F1.glyph(v[0x2000 + r * 32 + c]); s += (g === null || g === '\n') ? ' ' : g; }
      out.push(s);
    }
    return out;
  };
  run(20);
  nes.cpu.mem[0x27] = 150; nes.cpu.mem[0x28] = 170;
  run(20);
  for (let s = 0; s < 300; s++) {
    const b = D[Math.floor(s / 6) % 2];
    nes.buttonDown(1, b); run(8); nes.buttonUp(1, b); run(12);
    if (lines().some(l => /\bRUN\b/.test(l))) {
      run(30);
      const m = nes.cpu.mem;
      let bodies = 0;
      for (let i = 0; i < 9; i++) {
        const a = MN.ENEMY_RAM + i * MN.ENEMY_RAM_STRIDE;
        if ((m[a + MN.ENEMY_MAXHP_OFF] | (m[a + MN.ENEMY_MAXHP_OFF + 1] << 8)) > 0) bodies++;
      }
      return {
        bodies,
        nt: sha([...nes.ppu.vramMem.slice(0x2000, 0x23C0)]),
        attr: sha([...nes.ppu.vramMem.slice(0x23C0, 0x2400)]),
      };
    }
  }
  return null;
}

let bad = 0, n = 0;
const ok = (label, cond, detail) => {
  n++; if (!cond) bad++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  return cond;
};

console.log('FF1 formation byte 0 — the enemy arrangement / size pattern\n');
const base = fight(MN.FORMATION_PATTERN_DEFAULT);
if (!base) { console.error('⛔ the default pattern never reached a battle'); process.exit(1); }
console.log(`  default 0x00: ${base.bodies} bodies, nt ${base.nt}\n`);

// ── the low nibble is inert ─────────────────────────────────────────────────
let inert = true; const lowVals = [0x01, 0x02, 0x08];
for (const v of lowVals) {
  const r = fight(v);
  if (!r || r.nt !== base.nt || r.attr !== base.attr || r.bodies !== base.bodies) inert = false;
}
ok(`the low nibble is inert (mask 0x${MN.FORMATION_PATTERN_MASK.toString(16)})`, inert,
   `tested 0x${lowVals.map(v => v.toString(16)).join(' 0x')}`);

// ── the measured outcomes ───────────────────────────────────────────────────
const rep = fight(MN.FORMATION_PATTERN_REPOSITION);
ok('0x20 keeps the same bodies but REPOSITIONS them',
   rep && rep.bodies === base.bodies && rep.nt !== base.nt,
   rep ? `${rep.bodies} bodies, nt ${rep.nt}` : 'no battle');

const one = fight(MN.FORMATION_PATTERN_ONE_LARGE);
ok('0x40 drops to a SINGLE large slot', one && one.bodies === 1,
   one ? `${one.bodies} bodies` : 'no battle');

const corrupt = fight(MN.FORMATION_PATTERN_CORRUPT);
ok('0x10 renders garbage with NO bodies', corrupt && corrupt.bodies === 0,
   corrupt ? `${corrupt.bodies} bodies, nt ${corrupt.nt}` : 'no battle');
ok('...and 0x10 is a DRAWN state, not a failure to reach battle', !!corrupt);

// ⛔ the collapse is part of the finding — 0x80 and 0x50 land on ONE outcome.
const a80 = fight(0x80), a50 = fight(0x50);
ok('0x50 and 0x80 collapse onto the same outcome',
   a80 && a50 && a80.nt === a50.nt && a80.bodies === a50.bodies,
   a80 && a50 ? `${a80.nt} vs ${a50.nt}` : 'no battle');
ok('...so byte 0 is neither a clean index nor a bitfield',
   a80 && rep && a80.nt !== rep.nt);

// ── the field wiring ────────────────────────────────────────────────────────
ok('byte 0 is off the unknown list', !MN.FORMATION_UNKNOWN_OFF.includes(MN.FORMATION_PATTERN_OFF),
   `unknown = ${MN.FORMATION_UNKNOWN_OFF.join(',')}`);
ok('it does not collide with any other decoded field',
   ![...MN.FORMATION_SPECIES_OFF, ...MN.FORMATION_COUNT_OFF, ...MN.FORMATION_PAL_OFF,
     MN.FORMATION_GFX_OFF, MN.FORMATION_AMBUSH_OFF].includes(MN.FORMATION_PATTERN_OFF));

// ── ⭐ revert proof ─────────────────────────────────────────────────────────
if (args.includes('--prove-revert')) {
  console.log('\n  revert proof — the same values on a NEIGHBOURING byte:');
  let survived = 0;
  for (const off of [13, 14]) {
    const r = fight(MN.FORMATION_PATTERN_ONE_LARGE, off);
    const same = r && r.bodies === 1 && r.nt !== base.nt;
    console.log(`     byte ${off}: ${same ? '⛔ ALSO drops to one body' : 'does not — good'}`);
    if (same) survived++;
  }
  ok('only byte 0 carries the arrangement pattern', survived === 0);
}

console.log(`\n${n - bad}/${n} checks passed`);
process.exit(bad ? 1 : 0);
