#!/usr/bin/env node
// ff2-scene-entry.mjs — find the code that ENTERS FF2's name-entry scene, so it
// can be patched out of the ROM.
//
// Established by measurement, not guesswork:
//   * A appends a kana (max 6), B is BACKSPACE, and B on an EMPTY name leaves
//     the member (the portrait only changes on the 6th B).
//   * The grid SCROLLS — hiragana, dakuten, small kana, digits, katakana — and
//     the last row is digits. There is no END cell anywhere in it.
//   * Pressing A on every cell of the bottom row: no escape.
//   * All 36 single/two-button combinations: no escape.
//   * Backing out with B repeatedly: no escape.
// So the scene has no input-reachable exit and the ROM has to be patched.
//
// This boots the intro while ring-buffering every executed game PC, watches for
// the frame the kana grid APPEARS, and dumps the instructions that ran just
// before — the call into the scene.
//
//   node tools/ff2-scene-entry.mjs --depth 600
//   node tools/ff2-scene-entry.mjs --save pre-name.state   # park just before it

import fs from 'node:fs';
import { NES, Controller } from 'jsnes';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const DEPTH = parseInt(flag('depth', '600'), 10);
const SAVE = flag('save', null);
const ROM = process.env.FF2_ROM || '/home/joeltco/roms/ff2-jp.nes';

const fb = new Uint32Array(256 * 240);
const nes = new NES({ onFrame: (b) => fb.set(b), onAudioSample: () => {} });
nes.loadROM(fs.readFileSync(ROM, 'binary'));

const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
const press = (b, h = 6, a = 24) => { nes.buttonDown(1, b); run(h); nes.buttonUp(1, b); run(a); };

/**
 * Is the NAME ENTRY on screen? Not "is there blue" — the prologue crawl is a
 * full blue screen too, which is why a grid-blue detector never fired.
 *
 * The name-entry screen is the only one with a PORTRAIT: a small box at the top
 * left holding a face, i.e. warm non-blue pixels. That is the discriminator.
 */
function portraitFace() {
  let face = 0, total = 0;
  for (let y = 18; y < 52; y++) {
    for (let x = 62; x < 102; x++) {
      const p = fb[y * 256 + x];
      const r = p & 0xFF, g = (p >> 8) & 0xFF, b = (p >> 16) & 0xFF;
      if (r > 90 && r > b + 20) face++;      // skin / hair, never the blue UI
      total++;
    }
  }
  return face / total;
}

const ring = new Int32Array(16384), rA = new Int32Array(16384);
let ri = 0, recording = true;
const cpu = nes.cpu;
const orig = cpu.emulate.bind(cpu);
cpu.emulate = function () {
  if (!recording || cpu.REG_PC >= 0xf000) return orig();   // skip NMI/sound engine
  ring[ri] = cpu.REG_PC; rA[ri] = cpu.REG_ACC;
  ri = (ri + 1) % ring.length;
  return orig();
};

// Intro: title -> start -> A -> prologue crawl. The grid appears after it.
run(400);
press(Controller.BUTTON_START, 6, 240);
press(Controller.BUTTON_A, 6, 120);

let appearedAt = -1;
let stateBefore = null;
let ring2 = [];
for (let f = 0; f < 30000; f++) {
  if (f === 9000 && SAVE) stateBefore = nes.toJSON();
  nes.frame();
  if (f % 4 === 0) {
    const face = portraitFace();
    ring2.push(face); if (ring2.length > 8) ring2.shift();
    // Sustained face = the portrait box is up, not a one-frame flicker.
    if (face > 0.10 && ring2.filter(v => v > 0.10).length >= 4) { appearedAt = f; break; }
  }
  // The crawl needs steady A presses; one every 900 frames stalled it.
  if (f % 60 === 0) { nes.buttonDown(1, Controller.BUTTON_A); nes.frame(); nes.frame(); nes.buttonUp(1, Controller.BUTTON_A); }
}

if (appearedAt < 0) { console.error('the name-entry screen never appeared'); process.exit(1); }
recording = false;
console.log(`name-entry portrait appeared at intro frame ${appearedAt}`);
if (SAVE && stateBefore) { fs.writeFileSync(SAVE, JSON.stringify(stateBefore)); console.log('parked pre-name state -> ' + SAVE); }

const out = [];
for (let k = DEPTH; k >= 1; k--) {
  const i = (ri - k + ring.length) % ring.length;
  if (ring[i]) out.push({ pc: ring[i], a: rA[i] });
}
console.log(`\nlast ${out.length} game-code instructions before the grid appeared:\n`);
let prevPc = -1;
for (const e of out) {
  const jump = prevPc >= 0 && Math.abs(e.pc - prevPc) > 8 ? '   <-- jump' : '';
  console.log(`  $${e.pc.toString(16).padStart(4, '0')}  A=$${e.a.toString(16).padStart(2, '0')}${jump}`);
  prevPc = e.pc;
}

// Regions, so the scene routine stands out from the loop it sits in.
const counts = new Map();
for (const e of out) { const page = e.pc & 0xff00; counts.set(page, (counts.get(page) || 0) + 1); }
console.log('\ninstructions per page in the window:');
for (const [p, n] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(`  $${p.toString(16).padStart(4, '0')}xx  ${n}`);
}
