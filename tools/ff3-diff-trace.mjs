#!/usr/bin/env node
// ff3-diff-trace.mjs — find what CONSUMES a ROM byte, by differential execution.
//
// WHY THIS EXISTS
// Watching a RAM address for reads does not work. It found no consumer for FF3's
// `atkElem` even with that field provably halving damage — because the code reads
// some other copy of the value. A search that cannot find a consumer known to
// exist can never justify "nothing reads it".
//
// THE METHOD
// Run TWO machines that differ in exactly one ROM byte, feed them identical
// input, and compare instruction by instruction. Wherever the value is used, the
// machines must diverge: in control flow if something BRANCHED on it, or in a
// register if something COMPUTED with it. Divergence needs no idea where the
// value lives, which is the whole point.
//
//   node tools/ff3-diff-trace.mjs --off 15 --a 0 --b 255
//   node tools/ff3-diff-trace.mjs --off 8 --a 0 --b 16 --shield     # the control
//
// ⛔ Both machines get the SAME savestate and the SAME button presses, so the run
// is deterministic and any difference is caused by the patched byte.
// ⛔ `nes.fromJSON` REPLACES `nes.cpu`, so the tracer must be installed AFTER it.
// ⛔ The setup COPY reads the byte too ($A5EE) — that divergence is expected and
// uninteresting. What matters is anything AFTER the value has been stored.

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NES, Controller } from 'jsnes';
import { glyph } from './lib/ff3-text.mjs';
import * as M3 from './lib/ff3-monsters.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const OFF = Number(flag('off', '15'));
const VA = Number(flag('a', '0'));
const VB = Number(flag('b', '255'));
const SHIELD = args.includes('--shield');
const FRAMES = Number(flag('frames', '900'));
// ⛔ spAtkRate decides WHICH path runs. At 0xFF the monster casts its special
// every turn and never swings — so a field that only matters to the PHYSICAL
// attack (atkElem) is never exercised and the trace shows nothing. That is not
// the method failing; it is the harness testing the wrong code path.
const RATE = flag('rate', null);
const TOPN = Number(flag('top', '12'));
// ⛔ Comparing only AFTER the battle has begun throws away encounter SETUP —
// which is exactly where the record is copied into the combatant entry. Without
// this the tracer cannot even see the load it is certain to make, so a clean
// negative would be unfalsifiable.
const FROM_START = args.includes('--from-start');

const rom = new Uint8Array(fs.readFileSync(path.join(HERE, '..', 'FF3-English.nes')));
const SNAP = zlib.gunzipSync(
  fs.readFileSync(path.join(HERE, 'states', 'ff3-freeroam.state.gz'))).toString('utf8');
const hx = (v, w = 4) => v.toString(16).toUpperCase().padStart(w, '0');

function build(val) {
  const p = Uint8Array.from(rom);
  p[M3.MONSTER_PROPS + M3.FIELDS.hp[0]] = 0xFF;
  p[M3.MONSTER_PROPS + M3.FIELDS.hp[1]] = 0x0F;          // survives the whole trace
  if (RATE !== null) p[M3.MONSTER_PROPS + M3.FIELDS.spAtkRate] = Number(RATE);
  p[M3.STAT_TABLE + rom[M3.MONSTER_PROPS + M3.FIELDS.atkHitIdx] * M3.STAT_ENTRY
    + M3.STAT_ATK_OFF] = 0xFF;                           // and it hits hard
  p[M3.MONSTER_PROPS + OFF] = val;
  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(Buffer.from(p).toString('binary'));
  nes.fromJSON(JSON.parse(SNAP));                        // ⛔ replaces nes.cpu
  const trace = [];
  const cpu = nes.cpu;
  const orig = cpu.emulate.bind(cpu);
  cpu.emulate = () => { trace.push(cpu.REG_PC, cpu.REG_ACC, cpu.REG_X, cpu.REG_Y); return orig(); };
  return { nes, trace };
}

const A = build(VA), B = build(VB);
const step = (m, n) => { for (let i = 0; i < n; i++) m.nes.frame(); };
const arm = (m) => { if (SHIELD) for (let i = 0; i < 4; i++) m.nes.cpu.mem[M3.PARTY_B_BLOCK + i * M3.PARTY_B_STRIDE] = 0x5B; };
const screen = (m) => {
  const v = m.nes.ppu.vramMem, out = [];
  for (let r = 0; r < 30; r++) {
    let s = '';
    for (let c = 0; c < 32; c++) { const g = glyph(v[0x2000 + r * 32 + c]); s += (g === null ? ' ' : g); }
    if (s.trim()) out.push(s.replace(/\s+/g, ' ').trim());
  }
  return out;
};
const clear = () => { A.trace.length = 0; B.trace.length = 0; };

const pcDiff = new Map();        // control flow parted here
const regDiff = new Map();       // same instruction, different register contents
let firstPc = null, frames = 0, instrs = 0;
/** Compare what both machines just executed, then drop it. */
function compare(f) {
  const n = Math.min(A.trace.length, B.trace.length);
  instrs += n / 4;
  for (let i = 0; i < n; i += 4) {
    if (A.trace[i] !== B.trace[i]) {
      const pc = A.trace[i];
      pcDiff.set(pc, (pcDiff.get(pc) || 0) + 1);
      if (firstPc === null) firstPc = { pc, other: B.trace[i], frame: f };
      break;
    }
    if (A.trace[i + 1] !== B.trace[i + 1] || A.trace[i + 2] !== B.trace[i + 2]
        || A.trace[i + 3] !== B.trace[i + 3]) {
      const pc = A.trace[i];
      regDiff.set(pc, (regDiff.get(pc) || 0) + 1);
    }
  }
  clear();
}

// ── walk both machines into the encounter with identical input ──────────────
const D = [Controller.BUTTON_LEFT, Controller.BUTTON_RIGHT, Controller.BUTTON_UP, Controller.BUTTON_DOWN];
for (const m of [A, B]) { step(m, 30); arm(m); }
let started = false;
for (let s = 0; s < 400 && !started; s++) {
  const b = D[Math.floor(s / 8) % 4];
  for (const m of [A, B]) {
    arm(m);
    m.nes.buttonDown(1, b); step(m, 10); m.nes.buttonUp(1, b); step(m, 12);
  }
  if (FROM_START) compare(-1); else clear();
  if (screen(A).some(l => /Guard|Item/i.test(l))) started = true;
}
if (!started) { console.error('never reached a battle'); process.exit(1); }
if (FROM_START && (pcDiff.size || regDiff.size))
  console.log('⭐ divergence seen during the WALK-IN / SETUP phase (before the menu)\n');
if (!FROM_START) clear();

console.log(`differential trace — monster record byte ${OFF}: ${VA} vs ${VB}` +
            `${SHIELD ? ' + fire-resist shield' : ''}` +
            `, spAtkRate=${RATE === null ? 'natural' : RATE}\n`);

// ── run in lockstep, comparing after every frame ────────────────────────────
for (let f = 0; f < FRAMES; f++) {
  const press = (f % 6 === 0);
  for (const m of [A, B]) {
    if (press) { m.nes.buttonDown(1, Controller.BUTTON_A); step(m, 4); m.nes.buttonUp(1, Controller.BUTTON_A); step(m, 1); }
    else step(m, 1);
  }
  frames++;
  compare(f);
  if (pcDiff.size && frames > 300) break;
}

console.log(`compared ~${Math.round(instrs / 1000)}k instructions across ${frames} frames\n`);
if (firstPc) {
  console.log(`⭐ CONTROL FLOW PARTED first at $${hx(firstPc.pc)} (the other machine was at ` +
              `$${hx(firstPc.other)}), frame ${firstPc.frame}`);
} else {
  console.log('⛔ control flow NEVER parted — nothing branched on this byte');
}
if (pcDiff.size) {
  console.log('\nevery PC where flow parted:');
  for (const [pc, n] of [...pcDiff.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOPN))
    console.log(`   $${hx(pc)}  x${n}`);
}
console.log(`\n${regDiff.size ? 'PCs reached with DIFFERENT register contents (the value flowing):' : '⛔ registers never differed either — the byte never even loads'}`);
for (const [pc, n] of [...regDiff.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOPN))
  console.log(`   $${hx(pc)}  x${n}`);
