#!/usr/bin/env node
// dis6502-ff1.mjs — 6502 disassembler for the FF1 / FF2 (MMC1) ROMs.
//
// `tools/dis6502.mjs` models MMC3's four windows and is FF3-specific. MMC1 is
// simpler: 16KB at $8000-$BFFF (switchable) and 16KB at $C000-$FFFF (fixed to
// the LAST bank). So a file offset maps to CPU $8000 + (off - bankStart) when
// you say which bank you are reading.
//
//   node tools/dis6502-ff1.mjs 9 0x27cc4 30        # bank, file offset, count
//   node tools/dis6502-ff1.mjs --ff2 0 0x3410 20
//
// The bank argument only affects the printed address; the bytes come from the
// file offset you give, so it cannot silently disassemble the wrong data.

import fs from 'node:fs';

const args = process.argv.slice(2);
const FF2 = args.includes('--ff2');
const rest = args.filter(a => a !== '--ff2');
const ROM = new Uint8Array(fs.readFileSync(
  FF2 ? (process.env.FF2_ROM || '/home/joeltco/roms/ff2-jp.nes')
      : (process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes')));

const bank = parseInt(rest[0], 10);
const start = parseInt(rest[1], 16);
const count = parseInt(rest[2] || '24', 10);

// addressing modes: [mnemonic, mode] ; mode gives operand length + format
const IMP = 'imp', IMM = 'imm', ZP = 'zp', ZPX = 'zpx', ZPY = 'zpy',
      ABS = 'abs', ABX = 'abx', ABY = 'aby', IND = 'ind',
      IZX = 'izx', IZY = 'izy', REL = 'rel', ACC = 'acc';
const LEN = { imp: 1, acc: 1, imm: 2, zp: 2, zpx: 2, zpy: 2, izx: 2, izy: 2, rel: 2, abs: 3, abx: 3, aby: 3, ind: 3 };

const T = {};
const set = (op, m, mode) => { T[op] = [m, mode]; };
// load/store
set(0xA9,'LDA',IMM); set(0xA5,'LDA',ZP); set(0xB5,'LDA',ZPX); set(0xAD,'LDA',ABS);
set(0xBD,'LDA',ABX); set(0xB9,'LDA',ABY); set(0xA1,'LDA',IZX); set(0xB1,'LDA',IZY);
set(0xA2,'LDX',IMM); set(0xA6,'LDX',ZP); set(0xB6,'LDX',ZPY); set(0xAE,'LDX',ABS); set(0xBE,'LDX',ABY);
set(0xA0,'LDY',IMM); set(0xA4,'LDY',ZP); set(0xB4,'LDY',ZPX); set(0xAC,'LDY',ABS); set(0xBC,'LDY',ABX);
set(0x85,'STA',ZP); set(0x95,'STA',ZPX); set(0x8D,'STA',ABS); set(0x9D,'STA',ABX);
set(0x99,'STA',ABY); set(0x81,'STA',IZX); set(0x91,'STA',IZY);
set(0x86,'STX',ZP); set(0x96,'STX',ZPY); set(0x8E,'STX',ABS);
set(0x84,'STY',ZP); set(0x94,'STY',ZPX); set(0x8C,'STY',ABS);
// transfers / stack
set(0xAA,'TAX',IMP); set(0xA8,'TAY',IMP); set(0x8A,'TXA',IMP); set(0x98,'TYA',IMP);
set(0xBA,'TSX',IMP); set(0x9A,'TXS',IMP); set(0x48,'PHA',IMP); set(0x68,'PLA',IMP);
set(0x08,'PHP',IMP); set(0x28,'PLP',IMP);
// arithmetic
set(0x69,'ADC',IMM); set(0x65,'ADC',ZP); set(0x75,'ADC',ZPX); set(0x6D,'ADC',ABS);
set(0x7D,'ADC',ABX); set(0x79,'ADC',ABY); set(0x61,'ADC',IZX); set(0x71,'ADC',IZY);
set(0xE9,'SBC',IMM); set(0xE5,'SBC',ZP); set(0xF5,'SBC',ZPX); set(0xED,'SBC',ABS);
set(0xFD,'SBC',ABX); set(0xF9,'SBC',ABY); set(0xE1,'SBC',IZX); set(0xF1,'SBC',IZY);
set(0xC9,'CMP',IMM); set(0xC5,'CMP',ZP); set(0xD5,'CMP',ZPX); set(0xCD,'CMP',ABS);
set(0xDD,'CMP',ABX); set(0xD9,'CMP',ABY); set(0xC1,'CMP',IZX); set(0xD1,'CMP',IZY);
set(0xE0,'CPX',IMM); set(0xE4,'CPX',ZP); set(0xEC,'CPX',ABS);
set(0xC0,'CPY',IMM); set(0xC4,'CPY',ZP); set(0xCC,'CPY',ABS);
set(0xE6,'INC',ZP); set(0xF6,'INC',ZPX); set(0xEE,'INC',ABS); set(0xFE,'INC',ABX);
set(0xC6,'DEC',ZP); set(0xD6,'DEC',ZPX); set(0xCE,'DEC',ABS); set(0xDE,'DEC',ABX);
set(0xE8,'INX',IMP); set(0xC8,'INY',IMP); set(0xCA,'DEX',IMP); set(0x88,'DEY',IMP);
// logic / shifts
set(0x29,'AND',IMM); set(0x25,'AND',ZP); set(0x35,'AND',ZPX); set(0x2D,'AND',ABS);
set(0x3D,'AND',ABX); set(0x39,'AND',ABY); set(0x21,'AND',IZX); set(0x31,'AND',IZY);
set(0x09,'ORA',IMM); set(0x05,'ORA',ZP); set(0x15,'ORA',ZPX); set(0x0D,'ORA',ABS);
set(0x1D,'ORA',ABX); set(0x19,'ORA',ABY); set(0x01,'ORA',IZX); set(0x11,'ORA',IZY);
set(0x49,'EOR',IMM); set(0x45,'EOR',ZP); set(0x55,'EOR',ZPX); set(0x4D,'EOR',ABS);
set(0x5D,'EOR',ABX); set(0x59,'EOR',ABY); set(0x41,'EOR',IZX); set(0x51,'EOR',IZY);
set(0x0A,'ASL',ACC); set(0x06,'ASL',ZP); set(0x16,'ASL',ZPX); set(0x0E,'ASL',ABS); set(0x1E,'ASL',ABX);
set(0x4A,'LSR',ACC); set(0x46,'LSR',ZP); set(0x56,'LSR',ZPX); set(0x4E,'LSR',ABS); set(0x5E,'LSR',ABX);
set(0x2A,'ROL',ACC); set(0x26,'ROL',ZP); set(0x36,'ROL',ZPX); set(0x2E,'ROL',ABS); set(0x3E,'ROL',ABX);
set(0x6A,'ROR',ACC); set(0x66,'ROR',ZP); set(0x76,'ROR',ZPX); set(0x6E,'ROR',ABS); set(0x7E,'ROR',ABX);
set(0x24,'BIT',ZP); set(0x2C,'BIT',ABS);
// control
set(0x4C,'JMP',ABS); set(0x6C,'JMP',IND); set(0x20,'JSR',ABS);
set(0x60,'RTS',IMP); set(0x40,'RTI',IMP); set(0x00,'BRK',IMP); set(0xEA,'NOP',IMP);
set(0x10,'BPL',REL); set(0x30,'BMI',REL); set(0x50,'BVC',REL); set(0x70,'BVS',REL);
set(0x90,'BCC',REL); set(0xB0,'BCS',REL); set(0xD0,'BNE',REL); set(0xF0,'BEQ',REL);
set(0x18,'CLC',IMP); set(0x38,'SEC',IMP); set(0x58,'CLI',IMP); set(0x78,'SEI',IMP);
set(0xB8,'CLV',IMP); set(0xD8,'CLD',IMP); set(0xF8,'SED',IMP);

const hx = (v, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');
const bankStart = 0x10 + bank * 0x4000;
// MMC1's LAST bank is fixed at $C000-$FFFF, every other bank shows at $8000.
// Printing bank 15 as $8000-based puts every address 0x4000 too low.
const TOTAL_BANKS = (ROM.length - 0x10) / 0x4000;
const winBase = (bank === TOTAL_BANKS - 1) ? 0xC000 : 0x8000;
const cpuOf = (off) => winBase + (off - bankStart);

let off = start;
for (let n = 0; n < count; n++) {
  const op = ROM[off];
  const e = T[op];
  const pc = cpuOf(off);
  if (!e) { console.log(`  ${hx(pc, 4)}  ${hx(op)}         .byte $${hx(op)}`); off += 1; continue; }
  const [m, mode] = e;
  const len = LEN[mode];
  const b = [...ROM.slice(off, off + len)].map(v => hx(v)).join(' ').padEnd(8);
  let txt;
  const o1 = ROM[off + 1], o2 = ROM[off + 2];
  const a16 = o1 | (o2 << 8);
  switch (mode) {
    case IMP: txt = m; break;
    case ACC: txt = `${m} A`; break;
    case IMM: txt = `${m} #$${hx(o1)}`; break;
    case ZP:  txt = `${m} $${hx(o1)}`; break;
    case ZPX: txt = `${m} $${hx(o1)},X`; break;
    case ZPY: txt = `${m} $${hx(o1)},Y`; break;
    case IZX: txt = `${m} ($${hx(o1)},X)`; break;
    case IZY: txt = `${m} ($${hx(o1)}),Y`; break;
    case REL: txt = `${m} $${hx((pc + 2 + ((o1 << 24) >> 24)) & 0xFFFF, 4)}`; break;
    case ABS: txt = `${m} $${hx(a16, 4)}`; break;
    case ABX: txt = `${m} $${hx(a16, 4)},X`; break;
    case ABY: txt = `${m} $${hx(a16, 4)},Y`; break;
    case IND: txt = `${m} ($${hx(a16, 4)})`; break;
  }
  console.log(`  ${hx(pc, 4)}  ${b}  ${txt}`);
  off += len;
}
