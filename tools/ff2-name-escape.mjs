#!/usr/bin/env node
// ff2-name-escape.mjs — brute-force every way out of FF2's kana name grid.
//
// The grid has no END cell. Measured so far: A fills a kana, B advances to the
// next party member, START/SELECT do nothing, and after the last member it
// cycles back to the first. A disassembly of the live mapped bank shows the
// scene tests only the direction bits and A/B — there is no `AND #$10` (START)
// anywhere in it.
//
// So instead of guessing which button is "confirm", try them ALL, including
// two-button combinations and long holds, and detect a SCENE CHANGE by looking
// at the screen. Mechanical beats clever.
//
//   node tools/ff2-name-escape.mjs --state <name.state>
//   node tools/ff2-name-escape.mjs --state <s> --fill 30 --frames 300
//
// A trial "escapes" when the kana grid stops covering the lower screen.

import fs from 'node:fs';
import { NES, Controller } from 'jsnes';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const STATE = flag('state', null);
const FILL = parseInt(flag('fill', '30'), 10);
const FRAMES = parseInt(flag('frames', '260'), 10);
const ROM = process.env.FF2_ROM || '/home/joeltco/roms/ff2-jp.nes';

const W = 256, H = 240;
const fb = new Uint32Array(W * H);
const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));

const NAMES = ['a', 'b', 'select', 'start', 'up', 'down', 'left', 'right'];
const BTN = {
  a: Controller.BUTTON_A, b: Controller.BUTTON_B,
  select: Controller.BUTTON_SELECT, start: Controller.BUTTON_START,
  up: Controller.BUTTON_UP, down: Controller.BUTTON_DOWN,
  left: Controller.BUTTON_LEFT, right: Controller.BUTTON_RIGHT,
};

function fresh() {
  const nes = new NES({ onFrame: (b) => fb.set(b), onAudioSample: () => {} });
  nes.loadROM(fs.readFileSync(ROM, 'binary'));
  nes.fromJSON(JSON.parse(JSON.stringify(state)));
  for (let i = 0; i < 8; i++) nes.frame();
  return nes;
}
const run = (nes, n) => { for (let i = 0; i < n; i++) nes.frame(); };

/** Fraction of the LOWER half that is the grid's blue. The grid is a slab there. */
function gridBlue() {
  let blue = 0, total = 0;
  for (let y = 170; y < 235; y++) {
    for (let x = 20; x < 236; x++) {
      const p = fb[y * W + x];
      const r = p & 0xFF, g = (p >> 8) & 0xFF, b = (p >> 16) & 0xFF;
      if (b > 100 && b > r + 40 && b > g + 40) blue++;
      total++;
    }
  }
  return blue / total;
}

// Baseline: the grid as it sits.
{
  const nes = fresh(); run(nes, 30);
  console.log('baseline grid-blue = ' + gridBlue().toFixed(3));
}

const trials = [];
for (const n of NAMES) trials.push([n]);
for (let i = 0; i < NAMES.length; i++) {
  for (let j = i + 1; j < NAMES.length; j++) trials.push([NAMES[i], NAMES[j]]);
}

console.log(`\ntrying ${trials.length} input combinations (fill=${FILL}, then hold, then ${FRAMES}f)\n`);
const escaped = [];
for (const combo of trials) {
  const nes = fresh();
  for (let i = 0; i < FILL; i++) {                     // fill the current name
    nes.buttonDown(1, BTN.a); run(nes, 6); nes.buttonUp(1, BTN.a); run(nes, 12);
  }
  run(nes, 30);
  for (const b of combo) nes.buttonDown(1, BTN[b]);    // hold the combo
  run(nes, 30);
  for (const b of combo) nes.buttonUp(1, BTN[b]);
  run(nes, FRAMES);
  const blue = gridBlue();
  const out = blue < 0.15;
  if (out) escaped.push({ combo, blue });
  console.log(`  ${combo.join('+').padEnd(16)} grid-blue ${blue.toFixed(3)}${out ? '   <-- ESCAPED' : ''}`);
}

console.log('');
if (!escaped.length) {
  console.log('NO input combination leaves the name grid.');
  console.log('The exit is not reachable by input — it has to be patched or poked.');
  process.exitCode = 1;
} else {
  for (const e of escaped) console.log('ESCAPE: ' + e.combo.join('+') + '  (grid-blue ' + e.blue.toFixed(3) + ')');
}
