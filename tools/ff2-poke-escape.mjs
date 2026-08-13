#!/usr/bin/env node
// ff2-poke-escape.mjs — find the byte that ends FF2's name-entry scene, by
// poking every candidate instead of reverse-engineering the scene.
//
// Everything cheaper has been ruled out by measurement:
//   * A appends a kana (max 6); B is BACKSPACE; B on an empty name leaves the
//     member (the portrait only changes on the 6th B).
//   * The grid scrolls through hiragana / dakuten / small kana / digits /
//     katakana and has NO end cell; A on every bottom-row cell escapes nothing.
//   * All 36 single and two-button combinations: no escape.
//   * Backing out with repeated B: no escape.
//   * $b619 CMP #$06 is the cursor-BLINK gate, not the name length — patching
//     it to 12 left the name six kana long.
//
// So: the scene is driven by state, and state lives in RAM. Zero page is 256
// bytes; poke each one, run, and look at the screen. Mechanical beats clever.
//
//   node tools/ff2-poke-escape.mjs --state <name.state>
//   node tools/ff2-poke-escape.mjs --state <s> --values 0,1,255 --frames 180
//
// A hit is a byte+value where the name-entry screen goes away and STAYS away.

import fs from 'node:fs';
import { NES } from 'jsnes';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const STATE = flag('state', null);
const FRAMES = parseInt(flag('frames', '150'), 10);
const VALUES = flag('values', '0,1,255').split(',').map(Number);
const LO = parseInt(flag('lo', '0'), 10);
const HI = parseInt(flag('hi', '256'), 10);
const ROM = process.env.FF2_ROM || '/home/joeltco/roms/ff2-jp.nes';

const fb = new Uint32Array(256 * 240);
const romBin = fs.readFileSync(ROM, 'binary');
const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));

// ONE emulator, restored per trial. Building a fresh NES for each of 512 trials
// allocates a new set of large arrays every time and the run died partway
// through with no summary; restoring state into a single machine is both faster
// and survives the whole sweep.
const NES1 = new NES({ onFrame: (b) => fb.set(b), onAudioSample: () => {} });
NES1.loadROM(romBin);
function fresh() {
  NES1.fromJSON(structuredClone(state));
  for (let i = 0; i < 6; i++) NES1.frame();
  return NES1;
}

/**
 * Has the name-entry screen gone away?
 *
 * v1 tested the PORTRAIT alone and produced a false hit: $6e is the portrait
 * graphic index, so poking it blanked the face while the scene carried on
 * underneath. The screen is only gone when the portrait is dark AND the kana
 * grid — the big blue slab that fills the lower half — is gone with it.
 */
function portraitFace() {
  let face = 0, total = 0;
  for (let y = 18; y < 52; y++) {
    for (let x = 62; x < 102; x++) {
      const p = fb[y * 256 + x];
      const r = p & 0xFF, b = (p >> 16) & 0xFF;
      if (r > 90 && r > b + 20) face++;
      total++;
    }
  }
  return face / total;
}
function gridBlue() {
  let blue = 0, total = 0;
  for (let y = 95; y < 225; y++) {
    for (let x = 24; x < 232; x += 2) {
      const p = fb[y * 256 + x];
      const r = p & 0xFF, g = (p >> 8) & 0xFF, b = (p >> 16) & 0xFF;
      if (b > 100 && b > r + 40 && b > g + 40) blue++;
      total++;
    }
  }
  return blue / total;
}
const sceneGone = () => portraitFace() < 0.05 && gridBlue() < 0.20;

const base = fresh();
for (let i = 0; i < 30; i++) base.frame();
const BASE_FACE = portraitFace(), BASE_GRID = gridBlue();
console.log(`baseline portrait-face = ${BASE_FACE.toFixed(3)}, grid-blue = ${BASE_GRID.toFixed(3)}`);
if (BASE_FACE < 0.05 || BASE_GRID < 0.20) { console.error('the savestate is not on the name-entry screen'); process.exit(1); }

const hits = [];
const crashes = [];
let tried = 0;
for (let addr = LO; addr < HI; addr++) {
  for (const val of VALUES) {
    const nes = fresh();
    nes.cpu.mem[addr] = val & 0xFF;
    let gone = 0, crashed = false;
    try {
      for (let f = 0; f < FRAMES; f++) {
        nes.frame();
        // Re-assert: one frame of the scene's own bookkeeping would undo a
        // single poke, and that would read as "this byte does nothing".
        if (f < 20) nes.cpu.mem[addr] = val & 0xFF;
        if (f > 40 && f % 10 === 0 && sceneGone()) gone++;
      }
    } catch (e) {
      // Poking arbitrary state can drive the CPU into an invalid opcode. That
      // is not an escape, but it IS a signal: a byte that crashes the machine is
      // usually a pointer or a state index, so record it instead of dying.
      crashed = true;
      crashes.push({ addr, val, why: (e.message || '').slice(0, 60) });
    }
    tried++;
    if (crashed) continue;
    if (gone >= 6) {
      hits.push({ addr, val, gone });
      console.log(`  HIT  $${addr.toString(16).padStart(2, '0')} = ${val}  (portrait gone on ${gone} samples)`);
    }
  }
  if (addr % 32 === 31) process.stderr.write(`  ...$${addr.toString(16)} (${tried} trials, ${hits.length} hits)\n`);
}

console.log(`\n${tried} pokes tried, ${hits.length} left the name-entry screen`);
for (const h of hits) console.log(`  $${h.addr.toString(16).padStart(2, '0')} = ${h.val}`);
if (!hits.length) console.log('  none — the scene is not driven by a single zero-page byte');
console.log(`\n${crashes.length} pokes crashed the CPU (pointer / state candidates):`);
const byAddr = new Map();
for (const c of crashes) byAddr.set(c.addr, (byAddr.get(c.addr) || 0) + 1);
console.log('  ' + [...byAddr.keys()].map(a => '$' + a.toString(16).padStart(2, '0')).join(' '));
