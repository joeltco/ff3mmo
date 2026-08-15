#!/usr/bin/env node
// ff1-block-diff.mjs — find the instruction that actually stops the player.
//
// WHY
// `$CBE2` reads a tile's properties and does `AND #$C2`, and that looked like
// the collision check — but measured moves contradict it (tile 0x38, prop0
// 0x01, is blocked; tile 0x44, prop0 0x80, is passable), and a BLOCKED move
// never even reaches `$CBD7`. So `$CBE2` is something else.
//
// THE METHOD
// From ONE position, do a move that is blocked and a move that succeeds, and
// diff the set of executed PCs. Code that runs only on the blocked attempt is
// the refusal path; code that runs only on the successful one is the commit
// path. The branch that separates them sits just before both.
//
//   node tools/ff1-block-diff.mjs --state ff1-castle.state
//
// ⛔ Collect PCs into a Set, not the ring buffer — a press is ~300,000
// instructions and the 65,536-entry ring wraps five times over.
// ⛔ `onAnyRead` is required to see RAM reads; `onRead` is cartridge-only.

import fs from 'node:fs';
import { NES, Controller } from 'jsnes';
import { makeTracer, hex } from './lib/nes-trace.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const STATE = flag('state', null);
const ROMP = process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes';

const B = { up: Controller.BUTTON_UP, down: Controller.BUTTON_DOWN,
            left: Controller.BUTTON_LEFT, right: Controller.BUTTON_RIGHT };

/** Fresh machine, walked to the probe spot: (11,25) on map 8. */
function atProbeSpot() {
  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(fs.readFileSync(ROMP, 'binary'));
  nes.fromJSON(JSON.parse(fs.readFileSync(STATE, 'utf8')));
  const run = (k) => { for (let i = 0; i < k; i++) nes.frame(); };
  const P = (d) => { nes.buttonDown(1, B[d]); run(6); nes.buttonUp(1, B[d]); run(24); };
  run(20);
  for (let i = 0; i < 10; i++) P('up');
  P('left');
  return nes;
}

/** Execute one direction, returning the PC set, the RAM reads, and whether it moved. */
function attempt(dir) {
  const nes = atProbeSpot();
  const t = makeTracer(nes);
  const run = (k) => { for (let i = 0; i < k; i++) nes.frame(); };
  const x0 = nes.cpu.mem[0x68], y0 = nes.cpu.mem[0x69];
  const pcs = new Set();
  const reads = [];
  const origEmu = nes.cpu.emulate.bind(nes.cpu);
  nes.cpu.emulate = function () { if (t.recording) pcs.add((nes.cpu.REG_PC + 1) & 0xFFFF); return origEmu(); };
  t.onAnyRead = (addr, val, pc) => {
    if (addr >= 0x0400 && addr <= 0x04FF) reads.push({ addr, val, pc });
  };
  t.recording = true;
  nes.buttonDown(1, B[dir]); run(6); nes.buttonUp(1, B[dir]); run(24);
  t.recording = false;
  const moved = nes.cpu.mem[0x68] !== x0 || nes.cpu.mem[0x69] !== y0;
  return { pcs, reads, moved, from: [x0, y0] };
}

if (!STATE) { console.error('--state is required'); process.exit(1); }
const blocked = attempt('left');    // (11,25) -> (10,25) is blocked
const passed = attempt('down');     // (11,25) -> (11,26) is open
console.log(`probe spot (${blocked.from}) — left moved: ${blocked.moved}, down moved: ${passed.moved}`);
if (blocked.moved || !passed.moved) {
  console.error('the probe spot no longer behaves as expected; re-derive it');
  process.exit(1);
}

const onlyBlocked = [...blocked.pcs].filter(p => !passed.pcs.has(p)).sort((a, b) => a - b);
const onlyPassed = [...passed.pcs].filter(p => !blocked.pcs.has(p)).sort((a, b) => a - b);
console.log(`\nPCs executed on the BLOCKED attempt only: ${onlyBlocked.length}`);
console.log('  ' + onlyBlocked.map(p => hex(p)).join(' ').slice(0, 900));
console.log(`\nPCs executed on the SUCCESSFUL attempt only: ${onlyPassed.length}`);
console.log('  ' + onlyPassed.map(p => hex(p)).join(' ').slice(0, 900));

const fmt = (rs) => [...new Map(rs.map(r => [`${r.pc}:${r.addr}`, r])).values()]
  .map(r => `${hex(r.pc)} $${r.addr.toString(16)}=0x${r.val.toString(16)}`);
console.log(`\n$0400-$04FF reads on the BLOCKED attempt (${blocked.reads.length}):`);
console.log('  ' + (fmt(blocked.reads).join('  ') || '(none)'));
console.log(`\n$0400-$04FF reads on the SUCCESSFUL attempt (${passed.reads.length}):`);
console.log('  ' + (fmt(passed.reads).join('  ') || '(none)'));
