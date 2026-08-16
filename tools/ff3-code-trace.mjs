#!/usr/bin/env node
// ff3-code-trace.mjs — catch the instruction that reads a RAM address, and
// disassemble the routine around it.
//
// WHY
// Behavioural probing tells you a byte MATTERS; it cannot tell you what a byte
// that never visibly moves anything is FOR. `docs/FF3-MONSTERS.md` byte 15 is
// exactly that case: copied into the combatant entry, read every encounter, with
// a reader at `$A5F3` that touches no other field — and no observable effect.
// The only way past that is to read the code.
//
//   node tools/ff3-code-trace.mjs --addr 0x76AB
//   node tools/ff3-code-trace.mjs --addr 0x76AB --from 0xA5C0 --to 0xA620
//
// ⛔ `$8000-$DFFF` is MMC3-banked, so an address alone does not identify code.
// jsnes copies the mapped bank into `cpu.mem`, so the bytes are read from there
// at the moment of the hit and then located in the ROM file by searching for
// them — which also recovers the bank.
// ⛔ jsnes `REG_PC` is the byte AFTER the instruction, so the instruction that
// did the read STARTS at `REG_PC - length`.

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
const ADDR = Number(flag('addr', '0x76AB'));
const FROM = Number(flag('from', '0'));
const TO = Number(flag('to', '0'));
const ROUNDS = Number(flag('rounds', '40'));
// --set 0x60018=0x10 --set ... : ROM bytes to patch, so a conditional branch that
// depends on the field under test actually RUNS. ⛔ Tracing with natural values
// only ever finds consumers on the paths that happened to execute.
const SETS = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--set') {
  const [o, v] = args[i + 1].split('='); SETS.push([Number(o), Number(v)]);
}
const SHIELD = args.includes('--shield');

const rom = new Uint8Array(fs.readFileSync(path.join(HERE, '..', 'FF3-English.nes')));
const SNAP = zlib.gunzipSync(
  fs.readFileSync(path.join(HERE, 'states', 'ff3-freeroam.state.gz'))).toString('utf8');

import { hx, disasm1, listing, OP } from './lib/m6502.mjs';

// ── run to the read, and photograph the machine ─────────────────────────────
const p = Uint8Array.from(rom);
p[M3.MONSTER_PROPS + M3.FIELDS.hp[0]] = 0xFF;
p[M3.MONSTER_PROPS + M3.FIELDS.hp[1]] = 0x0F;
p[M3.MONSTER_PROPS + M3.FIELDS.spAtkRate] = 0xFF;      // keep the monster busy
p[M3.STAT_TABLE + rom[M3.MONSTER_PROPS + M3.FIELDS.atkHitIdx] * M3.STAT_ENTRY + M3.STAT_ATK_OFF] = 0xFF;
for (const [o, v] of SETS) p[o] = v;
const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
nes.loadROM(Buffer.from(p).toString('binary'));
nes.fromJSON(JSON.parse(SNAP));
const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
const lines = () => {
  const v = nes.ppu.vramMem, out = [];
  for (let r = 0; r < 30; r++) {
    let s = '';
    for (let c = 0; c < 32; c++) { const g = glyph(v[0x2000 + r * 32 + c]); s += (g === null ? ' ' : g); }
    if (s.trim()) out.push(s.replace(/\s+/g, ' ').trim());
  }
  return out;
};

const hits = [];
const orig = nes.mmap.load.bind(nes.mmap);
nes.mmap.load = (addr) => {
  const val = orig(addr);
  if (addr === ADDR) {
    hits.push({ pc: nes.cpu.REG_PC, a: nes.cpu.REG_ACC, x: nes.cpu.REG_X, y: nes.cpu.REG_Y, val,
                code: [...nes.cpu.mem.slice(0x8000, 0x10000)] });
  }
  return val;
};

run(30);
const D = [Controller.BUTTON_LEFT, Controller.BUTTON_RIGHT, Controller.BUTTON_UP, Controller.BUTTON_DOWN];
const arm = () => { if (SHIELD) for (let i = 0; i < 4; i++) nes.cpu.mem[M3.PARTY_B_BLOCK + i * M3.PARTY_B_STRIDE] = 0x5B; };
arm();
for (let s = 0; s < 400; s++) {
  arm();
  const b = D[Math.floor(s / 8) % 4];
  nes.buttonDown(1, b); run(10); nes.buttonUp(1, b); run(12);
  if (lines().some(l => /Guard|Item/i.test(l))) break;
}
for (let k = 0; k < ROUNDS; k++) {
  nes.buttonDown(1, Controller.BUTTON_A); run(8);
  nes.buttonUp(1, Controller.BUTTON_A); run(18);
}

console.log(`reads of $${hx(ADDR, 4)}: ${hits.length}\n`);
const byPc = new Map();
for (const h of hits) if (!byPc.has(h.pc)) byPc.set(h.pc, h);
for (const [pc, h] of byPc) {
  console.log(`── PC $${hx(pc, 4)}  (A=$${hx(h.a)} X=$${hx(h.x)} Y=$${hx(h.y)} read $${hx(h.val)}) ──`);
  const mem = { slice: (a, b) => h.code.slice(a - 0x8000, b - 0x8000), [Symbol.iterator]: undefined };
  // a flat view the disassembler can index like memory
  const view = new Proxy({}, { get: (_, k) => {
    if (k === 'slice') return (a, b) => h.code.slice(a - 0x8000, b - 0x8000);
    return h.code[Number(k) - 0x8000];
  } });
  // ⛔ jsnes reports REG_PC MID-instruction, so the accessing instruction is not
  // simply `pc - length`. Find the candidate whose span actually CONTAINS pc and
  // which is a memory-access opcode, then say whether it LOADS or STORES —
  // an indirect-indexed STA does a dummy read cycle at the target, which a naive
  // read hook counts as a read.
  const STORES = new Set(['STA', 'STX', 'STY']);
  let inst = null;
  for (const back of [1, 2, 3]) {
    const start = pc - back;
    const d = disasm1(view, start);
    if (start + d.len > pc && OP[view[start]] && d.text !== `.byte $${hx(view[start])}`) { inst = { start, d }; break; }
  }
  if (inst) {
    const mnem = inst.d.text.split(' ')[0];
    const kind = STORES.has(mnem) ? 'STORE (the dummy read cycle of an indexed write)'
                                  : 'LOAD  (a genuine read)';
    console.log(`  accessing instruction: $${hx(inst.start, 4)}  ${inst.d.text}   -> ${kind}`);
  } else console.log('  (could not identify the accessing instruction)');
  const from = FROM || (pc - 0x30), to = TO || (pc + 0x30);
  console.log(listing(view, from, to).join('\n'));
  // locate it in the ROM file, which also recovers the bank
  const sig = Buffer.from(h.code.slice(pc - 0x8000 - 8, pc - 0x8000 + 8));
  const at = Buffer.from(rom).indexOf(sig);
  if (at >= 0) console.log(`  ROM file offset of this code: 0x${hx(at + 8, 5)}  (bank ${((at + 8 - 16) / 0x2000) | 0})`);
  else console.log('  (could not locate these bytes in the ROM file)');
  console.log('');
  void mem;
}
