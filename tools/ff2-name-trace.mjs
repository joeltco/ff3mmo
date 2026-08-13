#!/usr/bin/env node
// ff2-name-trace.mjs — why does FF2's name entry never finish?
//
// FF2's kana grid has no END cell. Measured: A fills a character, B ADVANCES to
// the next party member (the portrait changes), START/SELECT do nothing, and
// after the last member it CYCLES BACK to the first. So there is an exit
// condition somewhere that is never satisfied headlessly, and the way to find
// it is to watch the machine, not to keep pressing buttons.
//
// Two measurements:
//   --diff   RAM before/after a B press -> which byte is the member index
//   --trace  ring-buffer of executed PCs during a B press -> the handler, and
//            the compare/branch that decides "advance" vs "done"
//
//   node tools/ff2-name-trace.mjs --state <file> --diff
//   node tools/ff2-name-trace.mjs --state <file> --trace --depth 400
//
// Needs a savestate parked on the name grid (tools/ff2-sfx-rip.mjs --savestate).

import fs from 'node:fs';
import { NES, Controller } from 'jsnes';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const has = (n) => args.includes('--' + n);

const ROM = process.env.FF2_ROM || '/home/joeltco/roms/ff2-jp.nes';
const STATE = flag('state', null);
const DEPTH = parseInt(flag('depth', '400'), 10);
const BTN = flag('btn', 'b');

const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
nes.loadROM(fs.readFileSync(ROM, 'binary'));
if (STATE) { nes.fromJSON(JSON.parse(fs.readFileSync(STATE, 'utf8'))); for (let i = 0; i < 8; i++) nes.frame(); }

const B = {
  a: Controller.BUTTON_A, b: Controller.BUTTON_B,
  select: Controller.BUTTON_SELECT, start: Controller.BUTTON_START,
  up: Controller.BUTTON_UP, down: Controller.BUTTON_DOWN,
  left: Controller.BUTTON_LEFT, right: Controller.BUTTON_RIGHT,
};
const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
const press = (name, hold = 6, after = 30) => {
  nes.buttonDown(1, B[name]); run(hold); nes.buttonUp(1, B[name]); run(after);
};

// Snapshot the two regions FF2 actually keeps state in: zero page / stack /
// work RAM ($0000-$07FF) and battery RAM ($6000-$7FFF).
function snap() {
  const out = new Uint8Array(0x800 + 0x2000);
  for (let i = 0; i < 0x800; i++) out[i] = nes.cpu.mem[i] & 0xFF;
  for (let i = 0; i < 0x2000; i++) out[0x800 + i] = nes.cpu.mem[0x6000 + i] & 0xFF;
  return out;
}
const addrOf = (i) => (i < 0x800 ? i : 0x6000 + (i - 0x800));

if (has('diff')) {
  // Fill the current name first so the press is a real "advance", not a fill.
  for (let i = 0; i < 30; i++) press('a', 6, 14);
  run(60);
  const before = snap();
  press(BTN, 6, 60);
  const after = snap();
  const changed = [];
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== after[i]) changed.push({ a: addrOf(i), from: before[i], to: after[i] });
  }
  console.log(`RAM bytes changed by pressing ${BTN.toUpperCase()} on a full name: ${changed.length}`);
  // A member index is a small number that stepped by exactly 1.
  const stepped = changed.filter(c => c.to === ((c.from + 1) & 0xFF) && c.to < 8);
  console.log('\ncandidates that incremented and stayed small (member index?):');
  for (const c of stepped) console.log(`  $${c.a.toString(16).padStart(4, '0')}  ${c.from} -> ${c.to}`);
  console.log('\nall changed zero-page bytes:');
  for (const c of changed.filter(c => c.a < 0x100)) {
    console.log(`  $${c.a.toString(16).padStart(2, '0')}  $${c.from.toString(16).padStart(2, '0')} -> $${c.to.toString(16).padStart(2, '0')}`);
  }
}

if (has('trace')) {
  for (let i = 0; i < 30; i++) press('a', 6, 14);
  run(60);
  const ring = new Int32Array(8192), rA = new Int32Array(8192), rX = new Int32Array(8192);
  let ri = 0;
  const cpu = nes.cpu;
  const orig = cpu.emulate.bind(cpu);
  cpu.emulate = function () {
    // Game code only — the NMI/sound engine would swamp the window.
    if (cpu.REG_PC >= 0xf000) return orig();
    ring[ri] = cpu.REG_PC; rA[ri] = cpu.REG_ACC; rX[ri] = cpu.REG_X;
    ri = (ri + 1) % ring.length;
    return orig();
  };
  press(BTN, 6, 40);
  cpu.emulate = orig;
  const out = [];
  for (let k = DEPTH; k >= 1; k--) {
    const i = (ri - k + ring.length) % ring.length;
    if (ring[i]) out.push({ pc: ring[i], a: rA[i], x: rX[i] });
  }
  console.log(`last ${out.length} game-code instructions during the ${BTN.toUpperCase()} press:\n`);
  let prev = -1;
  for (const e of out) {
    const gap = prev >= 0 && Math.abs(e.pc - prev) > 8 ? '  <-- jump' : '';
    console.log(`  $${e.pc.toString(16).padStart(4, '0')}  A=$${e.a.toString(16).padStart(2, '0')} X=$${e.x.toString(16).padStart(2, '0')}${gap}`);
    prev = e.pc;
  }
  const uniq = [...new Set(out.map(e => e.pc))].sort((a, b) => a - b);
  console.log('\ndistinct PCs: ' + uniq.map(p => '$' + p.toString(16)).join(' '));
}
