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

// ── a 6502 disassembler, only as complete as this job needs ─────────────────
const IMP = 1, IMM = 2, ZP = 3, ZPX = 4, ZPY = 5, ABS = 6, ABSX = 7, ABSY = 8,
      IND = 9, INDX = 10, INDY = 11, REL = 12, ACC = 13;
const LEN = { [IMP]: 1, [ACC]: 1, [IMM]: 2, [ZP]: 2, [ZPX]: 2, [ZPY]: 2, [REL]: 2,
              [INDX]: 2, [INDY]: 2, [ABS]: 3, [ABSX]: 3, [ABSY]: 3, [IND]: 3 };
const OP = {};
const def = (code, name, mode) => { OP[code] = { name, mode }; };
// load / store
def(0xA9, 'LDA', IMM); def(0xA5, 'LDA', ZP); def(0xB5, 'LDA', ZPX); def(0xAD, 'LDA', ABS);
def(0xBD, 'LDA', ABSX); def(0xB9, 'LDA', ABSY); def(0xA1, 'LDA', INDX); def(0xB1, 'LDA', INDY);
def(0xA2, 'LDX', IMM); def(0xA6, 'LDX', ZP); def(0xB6, 'LDX', ZPY); def(0xAE, 'LDX', ABS); def(0xBE, 'LDX', ABSY);
def(0xA0, 'LDY', IMM); def(0xA4, 'LDY', ZP); def(0xB4, 'LDY', ZPX); def(0xAC, 'LDY', ABS); def(0xBC, 'LDY', ABSX);
def(0x85, 'STA', ZP); def(0x95, 'STA', ZPX); def(0x8D, 'STA', ABS); def(0x9D, 'STA', ABSX);
def(0x99, 'STA', ABSY); def(0x81, 'STA', INDX); def(0x91, 'STA', INDY);
def(0x86, 'STX', ZP); def(0x96, 'STX', ZPY); def(0x8E, 'STX', ABS);
def(0x84, 'STY', ZP); def(0x94, 'STY', ZPX); def(0x8C, 'STY', ABS);
// arithmetic / logic
def(0x69, 'ADC', IMM); def(0x65, 'ADC', ZP); def(0x75, 'ADC', ZPX); def(0x6D, 'ADC', ABS);
def(0x7D, 'ADC', ABSX); def(0x79, 'ADC', ABSY); def(0x61, 'ADC', INDX); def(0x71, 'ADC', INDY);
def(0xE9, 'SBC', IMM); def(0xE5, 'SBC', ZP); def(0xF5, 'SBC', ZPX); def(0xED, 'SBC', ABS);
def(0xFD, 'SBC', ABSX); def(0xF9, 'SBC', ABSY); def(0xE1, 'SBC', INDX); def(0xF1, 'SBC', INDY);
def(0x29, 'AND', IMM); def(0x25, 'AND', ZP); def(0x35, 'AND', ZPX); def(0x2D, 'AND', ABS);
def(0x3D, 'AND', ABSX); def(0x39, 'AND', ABSY); def(0x21, 'AND', INDX); def(0x31, 'AND', INDY);
def(0x09, 'ORA', IMM); def(0x05, 'ORA', ZP); def(0x15, 'ORA', ZPX); def(0x0D, 'ORA', ABS);
def(0x1D, 'ORA', ABSX); def(0x19, 'ORA', ABSY); def(0x01, 'ORA', INDX); def(0x11, 'ORA', INDY);
def(0x49, 'EOR', IMM); def(0x45, 'EOR', ZP); def(0x55, 'EOR', ZPX); def(0x4D, 'EOR', ABS);
def(0x5D, 'EOR', ABSX); def(0x59, 'EOR', ABSY); def(0x41, 'EOR', INDX); def(0x51, 'EOR', INDY);
def(0xC9, 'CMP', IMM); def(0xC5, 'CMP', ZP); def(0xD5, 'CMP', ZPX); def(0xCD, 'CMP', ABS);
def(0xDD, 'CMP', ABSX); def(0xD9, 'CMP', ABSY); def(0xC1, 'CMP', INDX); def(0xD1, 'CMP', INDY);
def(0xE0, 'CPX', IMM); def(0xE4, 'CPX', ZP); def(0xEC, 'CPX', ABS);
def(0xC0, 'CPY', IMM); def(0xC4, 'CPY', ZP); def(0xCC, 'CPY', ABS);
def(0x24, 'BIT', ZP); def(0x2C, 'BIT', ABS);
// shifts
def(0x0A, 'ASL', ACC); def(0x06, 'ASL', ZP); def(0x16, 'ASL', ZPX); def(0x0E, 'ASL', ABS); def(0x1E, 'ASL', ABSX);
def(0x4A, 'LSR', ACC); def(0x46, 'LSR', ZP); def(0x56, 'LSR', ZPX); def(0x4E, 'LSR', ABS); def(0x5E, 'LSR', ABSX);
def(0x2A, 'ROL', ACC); def(0x26, 'ROL', ZP); def(0x36, 'ROL', ZPX); def(0x2E, 'ROL', ABS); def(0x3E, 'ROL', ABSX);
def(0x6A, 'ROR', ACC); def(0x66, 'ROR', ZP); def(0x76, 'ROR', ZPX); def(0x6E, 'ROR', ABS); def(0x7E, 'ROR', ABSX);
def(0xE6, 'INC', ZP); def(0xF6, 'INC', ZPX); def(0xEE, 'INC', ABS); def(0xFE, 'INC', ABSX);
def(0xC6, 'DEC', ZP); def(0xD6, 'DEC', ZPX); def(0xCE, 'DEC', ABS); def(0xDE, 'DEC', ABSX);
// branches / jumps
for (const [c, n] of [[0x10, 'BPL'], [0x30, 'BMI'], [0x50, 'BVC'], [0x70, 'BVS'],
                      [0x90, 'BCC'], [0xB0, 'BCS'], [0xD0, 'BNE'], [0xF0, 'BEQ']]) def(c, n, REL);
def(0x4C, 'JMP', ABS); def(0x6C, 'JMP', IND); def(0x20, 'JSR', ABS);
// implied
for (const [c, n] of [[0x60, 'RTS'], [0x40, 'RTI'], [0xEA, 'NOP'], [0x18, 'CLC'], [0x38, 'SEC'],
                      [0x58, 'CLI'], [0x78, 'SEI'], [0xB8, 'CLV'], [0xD8, 'CLD'], [0xF8, 'SED'],
                      [0xAA, 'TAX'], [0x8A, 'TXA'], [0xA8, 'TAY'], [0x98, 'TYA'], [0xBA, 'TSX'],
                      [0x9A, 'TXS'], [0x48, 'PHA'], [0x68, 'PLA'], [0x08, 'PHP'], [0x28, 'PLP'],
                      [0xE8, 'INX'], [0xCA, 'DEX'], [0xC8, 'INY'], [0x88, 'DEY'], [0x00, 'BRK']]) def(c, n, IMP);

const hx = (v, w = 2) => v.toString(16).toUpperCase().padStart(w, '0');
function disasm1(mem, pc) {
  const o = OP[mem[pc]];
  if (!o) return { text: `.byte $${hx(mem[pc])}`, len: 1 };
  const len = LEN[o.mode];
  const b1 = mem[pc + 1], b2 = mem[pc + 2];
  const w = b1 | (b2 << 8);
  let arg = '';
  switch (o.mode) {
    case IMP: break;
    case ACC: arg = ' A'; break;
    case IMM: arg = ` #$${hx(b1)}`; break;
    case ZP: arg = ` $${hx(b1)}`; break;
    case ZPX: arg = ` $${hx(b1)},X`; break;
    case ZPY: arg = ` $${hx(b1)},Y`; break;
    case ABS: arg = ` $${hx(w, 4)}`; break;
    case ABSX: arg = ` $${hx(w, 4)},X`; break;
    case ABSY: arg = ` $${hx(w, 4)},Y`; break;
    case IND: arg = ` ($${hx(w, 4)})`; break;
    case INDX: arg = ` ($${hx(b1)},X)`; break;
    case INDY: arg = ` ($${hx(b1)}),Y`; break;
    case REL: arg = ` $${hx((pc + 2 + ((b1 << 24) >> 24)) & 0xFFFF, 4)}`; break;
  }
  return { text: `${o.name}${arg}`, len };
}
function listing(mem, from, to) {
  const out = [];
  for (let pc = from; pc < to;) {
    const d = disasm1(mem, pc);
    const raw = [...mem.slice(pc, pc + d.len)].map(v => hx(v)).join(' ').padEnd(8);
    out.push(`  $${hx(pc, 4)}  ${raw}  ${d.text}`);
    pc += d.len;
  }
  return out;
}

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
