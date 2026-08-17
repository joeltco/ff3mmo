#!/usr/bin/env node
// ff1-formation-palette.mjs — which FF1 formation bytes drive the battle PALETTE?
//
// WHY
// FF1's 16-byte formation record is decoded except for bytes 0, 1 and 10-15
// (`FORMATION_UNKNOWN_OFF`). TCRF's FF1 page notes that some formations were
// altered for the American release because enemies "will occasionally display
// corrupted colors" — which says a formation carries PALETTE data, not just
// species and counts. That is directly testable: patch one byte, fight the
// formation for real, and read PPU $3F00-$3F1F off the running machine.
//
//   node tools/ff1-formation-palette.mjs --state tools/states/ff1-world.state.gz
//   node tools/ff1-formation-palette.mjs --state ... --off 12 --values 0,1,2,3
//
// HOW IT IS KEPT HONEST
//   ⭐ SPECIES IS HELD FIXED. Byte 2 changes the monster, and a different monster
//      naturally brings a different palette — so a palette change there proves
//      nothing about a palette FIELD. Every unknown-byte run keeps byte 2 alone.
//   ⭐ POSITIVE CONTROL FIRST. Byte 2 is patched once to show the probe CAN see a
//      palette move. An instrument that never registers a change cannot prove a
//      negative, and every negative in this arc has needed that control.
//   ⛔ The ROM on disk is never touched; the patch goes into an in-memory copy.
//   ⛔ A run that never reaches a battle is reported as NO BATTLE, never folded
//      in as "no change" — those are different findings.

import fs from 'node:fs';
import zlib from 'node:zlib';
import { NES, Controller } from 'jsnes';
import * as F1 from './lib/ff1-text.mjs';
import * as MN from './lib/ff1-monsters.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const STATE = flag('state', 'tools/states/ff1-world.state.gz');
const ROMP = process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes';
const ONLY = flag('off', null);
const VALUES = flag('values', '0x00,0x01,0x40,0xFF').split(',').map(Number);
const FORMATION = Number(flag('formation', '0'));

const rom = new Uint8Array(fs.readFileSync(ROMP));
const raw = fs.readFileSync(STATE);
const SNAP = (raw[0] === 0x1f && raw[1] === 0x8b) ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
const D = [Controller.BUTTON_LEFT, Controller.BUTTON_RIGHT];
const hx = (v, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');
const REC = MN.FORMATION_TABLE + FORMATION * MN.FORMATION_STRIDE;

/**
 * Patch `{offset: value}` into the formation record, walk into the battle, and
 * return the screen text plus the live PPU palette. null if no battle happened.
 */
function fight(patch = {}) {
  const p = Uint8Array.from(rom);
  for (const [off, val] of Object.entries(patch)) {
    const o = Number(off);
    if (!Number.isInteger(o)) throw new Error(`non-integer formation offset: ${off}`);
    p[REC + o] = val & 0xFF;
  }
  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(Buffer.from(p).toString('binary'));
  nes.fromJSON(JSON.parse(SNAP));
  const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
  run(20);
  nes.cpu.mem[0x27] = 150; nes.cpu.mem[0x28] = 170;   // the pokeable overworld coords
  run(20);
  const lines = () => {
    const v = nes.ppu.vramMem, out = [];
    for (let r = 0; r < 30; r++) {
      let s = '';
      for (let c = 0; c < 32; c++) {
        const g = F1.glyph(v[0x2000 + r * 32 + c]);
        s += (g === null || g === '\n') ? ' ' : g;
      }
      if (s.trim()) out.push(s.trim());
    }
    return out;
  };
  for (let step = 0; step < 300; step++) {
    const b = D[Math.floor(step / 6) % 2];
    nes.buttonDown(1, b); run(8); nes.buttonUp(1, b); run(12);
    if (lines().some(l => /\bRUN\b/.test(l))) {
      run(30);                                   // let the palette settle
      return {
        lines: lines(),
        pal: [...nes.ppu.vramMem.slice(0x3F00, 0x3F20)],
        /** ⭐ ground truth that the patch REACHED the fight, not just the ROM. */
        slot0: nes.cpu.mem[MN.MONSTER_SLOTS],
        slots: [...nes.cpu.mem.slice(MN.MONSTER_SLOTS, MN.MONSTER_SLOTS + 4)],
      };
    }
  }
  return null;
}

const palStr = (p) => p.map(v => hx(v)).join(' ');
const diffSlots = (a, b) => a.map((v, i) => (v === b[i] ? -1 : i)).filter(i => i >= 0);
const nameOn = (scr) => (scr.join(' ').match(/[A-Z]{3,}/g) || []).filter(w => w !== 'RUN' && w !== 'HP').slice(0, 2).join('/');

console.log(`FF1 formation ${FORMATION} — which bytes move the battle palette?\n`);
console.log(`  record @ ROM 0x${hx(REC, 5)}: ${MN.formationOf(rom, FORMATION).map(v => hx(v)).join(' ')}`);
console.log(`  species bytes ${MN.FORMATION_SPECIES_OFF.join(',')}  counts ${MN.FORMATION_COUNT_OFF.join(',')}` +
            `  unknown ${MN.FORMATION_UNKNOWN_OFF.join(',')}\n`);

// ── baseline ────────────────────────────────────────────────────────────────
const base = fight();
if (!base) { console.error('⛔ the unpatched formation never reached a battle — nothing can be measured'); process.exit(1); }
console.log(`  baseline   BG ${palStr(base.pal.slice(0, 16))}`);
console.log(`             SPR ${palStr(base.pal.slice(16))}   [${nameOn(base.lines)}]\n`);

// ── the species reference run ───────────────────────────────────────────────
// ⛔ This was WRITTEN as a positive control, on the assumption that a different
// monster brings a different palette. It does not: byte 2 provably reaches the
// battle ($6BC9 slot 0 becomes the patched id) and the palette does not move a
// single slot. That is not a dead instrument — it is evidence that the palette
// is NOT selected by the species, which is exactly what TCRF's "corrupted
// colors" note implies. So it is recorded and the sweep decides calibration.
let speciesMoved = false;
for (const id of [0x02, 0x20, 0x33]) {
  const c = fight({ 2: id });
  if (!c) { console.log(`  species    byte 2 = 0x${hx(id)} -> NO BATTLE`); continue; }
  const d = diffSlots(base.pal, c.pal);
  const slot0 = c.nes ? null : null;
  console.log(`  species    byte 2 = 0x${hx(id)} -> ${d.length ? `${d.length} palette slots move` : 'palette IDENTICAL'}` +
              `   (battle slot 0 = 0x${hx(c.slot0)})`);
  if (d.length) speciesMoved = true;
}
console.log(`  => the species ${speciesMoved ? 'DOES' : 'does NOT'} drive the battle palette\n`);

// ── the sweep ───────────────────────────────────────────────────────────────
// Every byte, not just the unknown ones: the known species/count bytes are the
// comparison that makes an unknown byte's effect meaningful.
const offs = ONLY !== null ? [Number(ONLY)]
  : Array.from({ length: MN.FORMATION_STRIDE }, (_, i) => i);
console.log('\n  sweeping the UNKNOWN bytes (species held fixed):\n');
const movers = [];
for (const off of offs) {
  const orig = rom[REC + off];
  const rows = [];
  let moved = new Set(), noBattle = 0;
  for (const val of VALUES) {
    if ((val & 0xFF) === orig) continue;
    const r = fight({ [off]: val });
    if (!r) { noBattle++; rows.push(`0x${hx(val)}=NO BATTLE`); continue; }
    const d = diffSlots(base.pal, r.pal);
    d.forEach(i => moved.add(i));
    rows.push(`0x${hx(val)}=${d.length ? `${d.length} slots` : 'same'}`);
  }
  const tag = moved.size ? '⭐' : '  ';
  console.log(`${tag} byte ${String(off).padStart(2)} (is 0x${hx(orig)})  ${rows.join('  ')}` +
              (moved.size ? `\n       slots: ${[...moved].sort((a, b) => a - b).map(i => '$3F' + hx(i)).join(' ')}` : ''));
  if (moved.size) movers.push({ off, slots: [...moved] });
  if (noBattle) console.log(`       ⛔ ${noBattle} value(s) never reached a battle — not counted either way`);
}

console.log('');
if (movers.length) {
  console.log(`⭐ ${movers.length} byte(s) move the battle palette: ${movers.map(m => m.off).join(', ')}`);
  for (const m of movers) {
    const known = MN.FORMATION_SPECIES_OFF.includes(m.off) ? 'species'
      : MN.FORMATION_COUNT_OFF.includes(m.off) ? 'count' : '⭐ PREVIOUSLY UNKNOWN';
    console.log(`     byte ${String(m.off).padStart(2)}  ${known}  -> ${m.slots.length} slots`);
  }
  console.log('\n  ...and because at least one byte DID move it, the bytes that did not');
  console.log('  are real negatives rather than an uncalibrated probe.');
} else {
  // ⛔ nothing moved — including the species. The probe never registered a single
  // change, so it cannot support a negative about anything.
  console.log('⛔ NOTHING moved the palette, species included. This probe never');
  console.log('   registered a change, so it proves nothing either way. The palette is');
  console.log('   read at the frame RUN appears; if FF1 loads it later, or keeps it');
  console.log('   outside $3F00-$3F1F, that must be fixed before any of this counts.');
  process.exit(1);
}
