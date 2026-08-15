#!/usr/bin/env node
// ff1-flag0d-probe.mjs — what does FF1's `$0D` bit 0 actually mean?
//
// WHY
// An object's X-byte bit 7 gates its update against `$0D` bit 0 ($E6D8: the
// object is processed only when the two MATCH). That much is proven. The name
// `inRoom` is not — it is an inference, and this is the tool that tests it.
//
// THE METHOD
// Hook every write to `$0D` and report only the ones that FLIP BIT 0, with the
// instruction that did it and where the player was standing. A flag whose
// meaning is "inside a room" has to change exactly when the player crosses into
// one; a flag that never flips during ordinary walking means something else.
//
//   node tools/ff1-flag0d-probe.mjs --state ff1-castle.state --walk "up:14"
//   node tools/ff1-flag0d-probe.mjs --state ff1-world.state --walk "up:14"
//
// ⛔ Build the tracer AFTER `nes.fromJSON` — it replaces `nes.cpu`.
// ⛔ Resolve a PC's bank AT WRITE TIME; banks switch and a post-hoc lookup
// disassembles a different routine.

import fs from 'node:fs';
import { NES, Controller } from 'jsnes';
import { makeTracer, bankAt, hex } from './lib/nes-trace.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const STATE = flag('state', null);
const WALK = flag('walk', 'up:20');
const ROMP = process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes';

const PLAYER_X = 0x68, PLAYER_Y = 0x69, MAP_ID = 0x48, FLAG = 0x0D;

const rom = new Uint8Array(fs.readFileSync(ROMP));
const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
nes.loadROM(fs.readFileSync(ROMP, 'binary'));
if (!STATE) { console.error('--state is required'); process.exit(1); }
nes.fromJSON(JSON.parse(fs.readFileSync(STATE, 'utf8')));

const t = makeTracer(nes);              // ⛔ after fromJSON
const cpu = nes.cpu;
const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
const B = {
  up: Controller.BUTTON_UP, down: Controller.BUTTON_DOWN,
  left: Controller.BUTTON_LEFT, right: Controller.BUTTON_RIGHT,
  a: Controller.BUTTON_A, b: Controller.BUTTON_B,
};
const press = (k, hold = 6, after = 26) => {
  nes.buttonDown(1, B[k]); run(hold); nes.buttonUp(1, B[k]); run(after);
};
const at = () => `${cpu.mem[PLAYER_X]},${cpu.mem[PLAYER_Y]}`;

const TOTAL = (rom.length - 0x10) / 0x4000;
const flips = [];
let prev = cpu.mem[FLAG];
t.onWrite = (addr, val, pc) => {
  if (addr !== FLAG) return;
  if (((val ^ prev) & 0x01) === 0) { prev = val; return; }   // bit 0 unchanged
  const fixed = pc >= 0xC000;
  const bank = fixed ? TOTAL - 1 : bankAt(nes, rom, 0x8000);
  flips.push({
    pc, bank, from: prev, to: val,
    bit0: val & 1, at: at(), map: cpu.mem[MAP_ID],
    file: 0x10 + bank * 0x4000 + ((pc - 2) - (fixed ? 0xC000 : 0x8000)),
  });
  prev = val;
};

run(20);
console.log(`start: map ${cpu.mem[MAP_ID]} at (${at()})  $0D = 0x${cpu.mem[FLAG].toString(16)} bit0=${cpu.mem[FLAG] & 1}`);
t.recording = true;
for (const step of WALK.split(',')) {
  const [d, n] = step.split(':');
  for (let i = 0; i < parseInt(n || '1', 10); i++) press(d.trim());
}
run(60);
t.recording = false;
console.log(`end:   map ${cpu.mem[MAP_ID]} at (${at()})  $0D = 0x${cpu.mem[FLAG].toString(16)} bit0=${cpu.mem[FLAG] & 1}`);

console.log(`\n── writes that FLIPPED $0D bit 0: ${flips.length} ──`);
for (const f of flips) {
  console.log(`  ${hex(f.pc)} (bank ${f.bank})  0x${f.from.toString(16)} -> 0x${f.to.toString(16)}` +
              `  bit0 now ${f.bit0}   map ${f.map} at (${f.at})`);
  console.log(`      -> node tools/dis6502-ff1.mjs ${f.bank} 0x${(f.file - 0x20).toString(16)} 24   (lead-in, then find ${hex(f.pc - 2)})`);
}
if (!flips.length) {
  console.log('  none — bit 0 did not change anywhere on this walk.');
  console.log('  ⛔ That is evidence AGAINST any name that implies it tracks ordinary movement.');
}
