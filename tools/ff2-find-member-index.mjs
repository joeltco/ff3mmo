#!/usr/bin/env node
// ff2-find-member-index.mjs — which RAM byte tracks WHICH party member is being
// named, and where does the code decide to wrap instead of finish?
//
// A single before/after diff of one B press was useless: dozens of bytes move
// every frame (RNG, animation counters, scroll). The signature of a member index
// is different — it takes a DISTINCT value at each of the four characters and
// then returns to the first. So snapshot at all four and keep only the bytes
// that form that pattern.
//
//   node tools/ff2-find-member-index.mjs --state <name.state>
//
// Then --watch <addr> to see it move, and --trace-wrap to catch the code that
// reads it on the press that WRAPS (which is the branch to patch).

import fs from 'node:fs';
import { NES, Controller } from 'jsnes';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const has = (n) => args.includes('--' + n);
const STATE = flag('state', null);
const ROM = process.env.FF2_ROM || '/home/joeltco/roms/ff2-jp.nes';
const CYCLES = parseInt(flag('cycles', '5'), 10);

const fb = new Uint32Array(256 * 240);
const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
const nes = new NES({ onFrame: (b) => fb.set(b), onAudioSample: () => {} });
nes.loadROM(fs.readFileSync(ROM, 'binary'));
nes.fromJSON(JSON.parse(JSON.stringify(state)));
const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
const press = (b, h = 6, a = 30) => { nes.buttonDown(1, b); run(h); nes.buttonUp(1, b); run(a); };
run(8);

// The portrait is the ground truth for "which member" — it is what visibly
// changes on B. Hash the portrait box so each member has its own signature and
// the index candidates can be checked against something real.
function portraitHash() {
  let h = 2166136261;
  // NATIVE NES coords (256x240). The first version used numbers read off a 2x
  // screenshot and hashed the kana grid instead of the portrait, so every member
  // "matched" and the search found nothing.
  for (let y = 28; y < 60; y++) for (let x = 62; x < 100; x += 2) {
    h ^= fb[y * 256 + x] & 0xFFFFFF; h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}
function snapRam() {
  const out = new Uint8Array(0x800 + 0x2000);
  for (let i = 0; i < 0x800; i++) out[i] = nes.cpu.mem[i] & 0xFF;
  for (let i = 0; i < 0x2000; i++) out[0x800 + i] = nes.cpu.mem[0x6000 + i] & 0xFF;
  return out;
}
const addrOf = (i) => (i < 0x800 ? i : 0x6000 + (i - 0x800));

// Walk the members: fill the name, snapshot, press B.
const snaps = [];
const portraits = [];
for (let c = 0; c < CYCLES; c++) {
  for (let i = 0; i < 30; i++) press(Controller.BUTTON_A, 6, 12);
  run(40);
  snaps.push(snapRam());
  portraits.push(portraitHash());
  // Advancing a member takes SIX B presses, not one: B is BACKSPACE (measured —
  // the portrait only changes on the 6th, after all six kana are deleted). The
  // first version pressed B once, never advanced, and concluded the party had
  // one member.
  for (let i = 0; i < 6; i++) press(Controller.BUTTON_B, 6, 40);
  run(40);
}
console.log('portrait per cycle: ' + portraits.join(' '));
const distinct = [...new Set(portraits)];
console.log(`distinct portraits: ${distinct.length} -> the party is ${distinct.length} member(s), then it wraps`);

// A member index is a byte that is CONSTANT within a cycle and takes a distinct
// value per member, repeating when the portrait repeats. Anything that differs
// where two portraits are the SAME is noise.
const cands = [];
for (let i = 0; i < snaps[0].length; i++) {
  const vals = snaps.map(s => s[i]);
  if (new Set(vals).size < 2) continue;
  let ok = true;
  for (let a = 0; a < snaps.length && ok; a++) {
    for (let b = a + 1; b < snaps.length && ok; b++) {
      const samePortrait = portraits[a] === portraits[b];
      const sameVal = vals[a] === vals[b];
      if (samePortrait !== sameVal) ok = false;   // must track the portrait exactly
    }
  }
  if (ok) cands.push({ addr: addrOf(i), vals });
}
console.log(`\nbytes that track the portrait EXACTLY: ${cands.length}`);
for (const c of cands.slice(0, 40)) {
  console.log(`  $${c.addr.toString(16).padStart(4, '0')}  [${c.vals.join(', ')}]`);
}
if (!cands.length) console.log('  (none — the member is not held in a byte that survives the fill)');
