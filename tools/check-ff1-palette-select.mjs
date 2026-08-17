#!/usr/bin/env node
// check-ff1-palette-select.mjs — FF1 formation byte 13 bit 7 stays decoded.
//
// Bytes 10 and 11 load TWO palettes (BG palette 1 and BG palette 2). Byte 13 bit 7
// decides WHICH ONE THE MONSTERS ARE ACTUALLY DRAWN WITH, by flipping every
// monster block's attribute selector from palette 1 to palette 2. Ways this rots:
//
//   ⛔ concluding byte 13 does nothing. It touches neither the nametable nor the
//      palette RAM — only the ATTRIBUTE table. A probe that watches tiles and
//      colours but not attributes reports "identical" and is wrong;
//   ⛔ treating bytes 10 and 11 as "the two monster palettes" as if both were in
//      use. Only one is; the other is loaded and unused until byte 13 says so;
//   ⛔ reading byte 13 as a 0-255 value — bits 0-6 are measured inert.
//
//   node tools/check-ff1-palette-select.mjs
//   node tools/check-ff1-palette-select.mjs --prove-revert
//
// ⛔ ~14 real battles, ~50s.

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
const W = 256;
const sha = (b) => crypto.createHash('sha1').update(Buffer.from(b)).digest('hex').slice(0, 8);

/** ⭐ Hash ONLY the monster panel — party sprites and the HP boxes must not vote. */
function monsterHash(fb) {
  const px = [];
  for (let y = 40; y < 145; y++) for (let x = 12; x < 128; x++) px.push(fb[y * W + x] & 0xFFFFFF);
  return crypto.createHash('sha1').update(Buffer.from(new Int32Array(px).buffer)).digest('hex').slice(0, 10);
}

function fight(patch = {}) {
  const p = Uint8Array.from(rom);
  for (const [o, v] of Object.entries(patch)) p[REC + Number(o)] = v & 0xFF;
  let fb = null;
  const nes = new NES({ onFrame: (b) => { fb = b; }, onAudioSample: () => {} });
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
      return {
        mon: monsterHash(fb),
        nt: sha([...nes.ppu.vramMem.slice(0x2000, 0x23C0)]),
        attr: sha([...nes.ppu.vramMem.slice(0x23C0, 0x2400)]),
        pal: [...nes.ppu.vramMem.slice(0x3F00, 0x3F20)],
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

console.log('FF1 formation byte 13 bit 7 — which palette the monsters actually use\n');
const OFF = MN.FORMATION_PAL_SELECT_OFF, BIT = MN.FORMATION_PAL_SELECT_BIT;
const base = fight();
const set = fight({ [OFF]: rom[REC + OFF] | BIT });
ok('both reach a battle', !!base && !!set);

// ── it moves ONLY the attribute table ───────────────────────────────────────
ok('bit 7 changes the ATTRIBUTE table', set && set.attr !== base.attr,
   set ? `${base.attr} -> ${set.attr}` : '');
ok('...but NOT the nametable — the same tiles are drawn', set && set.nt === base.nt);
ok('...and NOT the palette RAM — both palettes are loaded either way',
   set && set.pal.every((v, i) => v === base.pal[i]));
ok('...yet the monsters LOOK different', set && set.mon !== base.mon);

// ── ⭐ the crossover: this is the finding ───────────────────────────────────
// With the bit clear only byte 10 recolours; with it set, only byte 11. Either
// half alone is explainable; the CROSSOVER is not.
const clearV = rom[REC + OFF] & ~BIT, setV = rom[REC + OFF] | BIT;
const probe = (b13, palOff) => {
  const a = fight({ [OFF]: b13, [palOff]: 0x00 });
  const b = fight({ [OFF]: b13, [palOff]: 0x06 });
  return a && b ? a.mon !== b.mon : null;
};
const c10 = probe(clearV, MN.FORMATION_PAL_OFF[0]);
const c11 = probe(clearV, MN.FORMATION_PAL_OFF[1]);
const s10 = probe(setV, MN.FORMATION_PAL_OFF[0]);
const s11 = probe(setV, MN.FORMATION_PAL_OFF[1]);
console.log(`\n     bit7 clear: byte10 ${c10 ? 'recolours' : 'inert'}, byte11 ${c11 ? 'recolours' : 'inert'}`);
console.log(`     bit7 set  : byte10 ${s10 ? 'recolours' : 'inert'}, byte11 ${s11 ? 'recolours' : 'inert'}\n`);
ok('bit 7 CLEAR -> the monsters follow byte 10 only', c10 === true && c11 === false);
ok('bit 7 SET   -> the monsters follow byte 11 only', s11 === true && s10 === false);
ok('⭐ the selection CROSSES OVER — that is the decode', c10 && s11 && !c11 && !s10);

// ── bits 0-6 are inert ──────────────────────────────────────────────────────
let inert = true;
for (const v of [0x00, 0x01, 0x20]) {
  const r = fight({ [OFF]: v });
  if (!r || r.attr !== base.attr || r.mon !== base.mon) inert = false;
}
ok('bits 0-6 are inert', inert, 'tested 0x00 0x01 0x20 against the 0x40 default');

// ── wiring ──────────────────────────────────────────────────────────────────
ok('byte 13 is off the unknown list', !MN.FORMATION_UNKNOWN_OFF.includes(OFF),
   `unknown = ${MN.FORMATION_UNKNOWN_OFF.join(',')}`);

// ── ⭐ revert proof ─────────────────────────────────────────────────────────
if (args.includes('--prove-revert')) {
  console.log('\n  revert proof — the same bit on a NEIGHBOURING byte:');
  let survived = 0;
  for (const o of [12, 14]) {
    const r = fight({ [o]: BIT });
    const same = r && r.attr !== base.attr && r.nt === base.nt;
    console.log(`     byte ${o}: ${same ? '⛔ ALSO flips attributes only' : 'does not — good'}`);
    if (same) survived++;
  }
  ok('only byte 13 carries the palette-select bit', survived === 0);
}

console.log(`\n${n - bad}/${n} checks passed`);
process.exit(bad ? 1 : 0);
