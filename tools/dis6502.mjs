#!/usr/bin/env node
// dis6502.mjs — 6502 disassembler for the FF3 ROM, in bank/address terms.
//
// Existing code cites disassembly sites in `BB/AAAA` form (`TRIGGER_TYPE_TABLE`
// is "from disassembly at 3A/921F"; `isPassable`'s z-rule "matches the NPC check
// at 3B/B0C5"). Those citations were only checkable by hand until now.
//
//   node tools/dis6502.mjs 3A 921F 40        # disassemble 40 instructions
//   node tools/dis6502.mjs --find 3A 921F    # find code referencing that address
//   node tools/dis6502.mjs --bytes 3A 921F 32
//
// Mapping: file = bank*0x2000 + 0x10 (iNES header) + (addr - window base),
// window base $8000 for $8000-$9FFF and $A000 for $A000-$BFFF. Verified against
// TRIGGER_TYPE_TABLE at 3A/921F, whose 32 bytes match `map-loader.js` exactly.

import fs from 'node:fs';

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));

export function fileOff(bank, addr) {
  const base = addr >= 0xA000 ? 0xA000 : 0x8000;
  return bank * 0x2000 + 0x10 + (addr - base);
}

// addressing modes: imp, acc, imm, zp, zpx, zpy, izx, izy, abs, abx, aby, ind, rel
const M = { imp: 1, acc: 1, imm: 2, zp: 2, zpx: 2, zpy: 2, izx: 2, izy: 2, abs: 3, abx: 3, aby: 3, ind: 3, rel: 2 };
const OPS = {};
function d(hex, name, mode) { OPS[hex] = { name, mode }; }
// load/store
d(0xA9,'LDA','imm'); d(0xA5,'LDA','zp'); d(0xB5,'LDA','zpx'); d(0xAD,'LDA','abs'); d(0xBD,'LDA','abx'); d(0xB9,'LDA','aby'); d(0xA1,'LDA','izx'); d(0xB1,'LDA','izy');
d(0xA2,'LDX','imm'); d(0xA6,'LDX','zp'); d(0xB6,'LDX','zpy'); d(0xAE,'LDX','abs'); d(0xBE,'LDX','aby');
d(0xA0,'LDY','imm'); d(0xA4,'LDY','zp'); d(0xB4,'LDY','zpx'); d(0xAC,'LDY','abs'); d(0xBC,'LDY','abx');
d(0x85,'STA','zp'); d(0x95,'STA','zpx'); d(0x8D,'STA','abs'); d(0x9D,'STA','abx'); d(0x99,'STA','aby'); d(0x81,'STA','izx'); d(0x91,'STA','izy');
d(0x86,'STX','zp'); d(0x96,'STX','zpy'); d(0x8E,'STX','abs');
d(0x84,'STY','zp'); d(0x94,'STY','zpx'); d(0x8C,'STY','abs');
// transfers / stack
d(0xAA,'TAX','imp'); d(0xA8,'TAY','imp'); d(0xBA,'TSX','imp'); d(0x8A,'TXA','imp'); d(0x9A,'TXS','imp'); d(0x98,'TYA','imp');
d(0x48,'PHA','imp'); d(0x08,'PHP','imp'); d(0x68,'PLA','imp'); d(0x28,'PLP','imp');
// logic
d(0x29,'AND','imm'); d(0x25,'AND','zp'); d(0x35,'AND','zpx'); d(0x2D,'AND','abs'); d(0x3D,'AND','abx'); d(0x39,'AND','aby'); d(0x21,'AND','izx'); d(0x31,'AND','izy');
d(0x49,'EOR','imm'); d(0x45,'EOR','zp'); d(0x55,'EOR','zpx'); d(0x4D,'EOR','abs'); d(0x5D,'EOR','abx'); d(0x59,'EOR','aby'); d(0x41,'EOR','izx'); d(0x51,'EOR','izy');
d(0x09,'ORA','imm'); d(0x05,'ORA','zp'); d(0x15,'ORA','zpx'); d(0x0D,'ORA','abs'); d(0x1D,'ORA','abx'); d(0x19,'ORA','aby'); d(0x01,'ORA','izx'); d(0x11,'ORA','izy');
d(0x24,'BIT','zp'); d(0x2C,'BIT','abs');
// arithmetic
d(0x69,'ADC','imm'); d(0x65,'ADC','zp'); d(0x75,'ADC','zpx'); d(0x6D,'ADC','abs'); d(0x7D,'ADC','abx'); d(0x79,'ADC','aby'); d(0x61,'ADC','izx'); d(0x71,'ADC','izy');
d(0xE9,'SBC','imm'); d(0xE5,'SBC','zp'); d(0xF5,'SBC','zpx'); d(0xED,'SBC','abs'); d(0xFD,'SBC','abx'); d(0xF9,'SBC','aby'); d(0xE1,'SBC','izx'); d(0xF1,'SBC','izy');
d(0xC9,'CMP','imm'); d(0xC5,'CMP','zp'); d(0xD5,'CMP','zpx'); d(0xCD,'CMP','abs'); d(0xDD,'CMP','abx'); d(0xD9,'CMP','aby'); d(0xC1,'CMP','izx'); d(0xD1,'CMP','izy');
d(0xE0,'CPX','imm'); d(0xE4,'CPX','zp'); d(0xEC,'CPX','abs');
d(0xC0,'CPY','imm'); d(0xC4,'CPY','zp'); d(0xCC,'CPY','abs');
// inc/dec
d(0xE6,'INC','zp'); d(0xF6,'INC','zpx'); d(0xEE,'INC','abs'); d(0xFE,'INC','abx'); d(0xE8,'INX','imp'); d(0xC8,'INY','imp');
d(0xC6,'DEC','zp'); d(0xD6,'DEC','zpx'); d(0xCE,'DEC','abs'); d(0xDE,'DEC','abx'); d(0xCA,'DEX','imp'); d(0x88,'DEY','imp');
// shifts
d(0x0A,'ASL','acc'); d(0x06,'ASL','zp'); d(0x16,'ASL','zpx'); d(0x0E,'ASL','abs'); d(0x1E,'ASL','abx');
d(0x4A,'LSR','acc'); d(0x46,'LSR','zp'); d(0x56,'LSR','zpx'); d(0x4E,'LSR','abs'); d(0x5E,'LSR','abx');
d(0x2A,'ROL','acc'); d(0x26,'ROL','zp'); d(0x36,'ROL','zpx'); d(0x2E,'ROL','abs'); d(0x3E,'ROL','abx');
d(0x6A,'ROR','acc'); d(0x66,'ROR','zp'); d(0x76,'ROR','zpx'); d(0x6E,'ROR','abs'); d(0x7E,'ROR','abx');
// jumps / branches
d(0x4C,'JMP','abs'); d(0x6C,'JMP','ind'); d(0x20,'JSR','abs'); d(0x60,'RTS','imp'); d(0x40,'RTI','imp'); d(0x00,'BRK','imp');
d(0x10,'BPL','rel'); d(0x30,'BMI','rel'); d(0x50,'BVC','rel'); d(0x70,'BVS','rel');
d(0x90,'BCC','rel'); d(0xB0,'BCS','rel'); d(0xD0,'BNE','rel'); d(0xF0,'BEQ','rel');
// flags / nop
d(0x18,'CLC','imp'); d(0x38,'SEC','imp'); d(0x58,'CLI','imp'); d(0x78,'SEI','imp');
d(0xB8,'CLV','imp'); d(0xD8,'CLD','imp'); d(0xF8,'SED','imp'); d(0xEA,'NOP','imp');

const hex2 = v => v.toString(16).toUpperCase().padStart(2, '0');
const hex4 = v => v.toString(16).toUpperCase().padStart(4, '0');

export function disasm(bank, addr, count = 40) {
  const out = [];
  let pc = addr;
  for (let i = 0; i < count; i++) {
    const off = fileOff(bank, pc);
    if (off < 0 || off >= rom.length) break;
    const op = rom[off];
    const info = OPS[op];
    if (!info) { out.push({ pc, text: `.byte $${hex2(op)}`, raw: [op] }); pc += 1; continue; }
    const len = M[info.mode];
    const b = [...rom.slice(off, off + len)];
    const lo = b[1], hi = b[2];
    let arg = '';
    switch (info.mode) {
      case 'imp': break;
      case 'acc': arg = 'A'; break;
      case 'imm': arg = `#$${hex2(lo)}`; break;
      case 'zp':  arg = `$${hex2(lo)}`; break;
      case 'zpx': arg = `$${hex2(lo)},X`; break;
      case 'zpy': arg = `$${hex2(lo)},Y`; break;
      case 'izx': arg = `($${hex2(lo)},X)`; break;
      case 'izy': arg = `($${hex2(lo)}),Y`; break;
      case 'abs': arg = `$${hex4(lo | hi << 8)}`; break;
      case 'abx': arg = `$${hex4(lo | hi << 8)},X`; break;
      case 'aby': arg = `$${hex4(lo | hi << 8)},Y`; break;
      case 'ind': arg = `($${hex4(lo | hi << 8)})`; break;
      case 'rel': arg = `$${hex4((pc + 2 + ((lo & 0x80) ? lo - 256 : lo)) & 0xFFFF)}`; break;
    }
    out.push({ pc, text: `${info.name}${arg ? ' ' + arg : ''}`, raw: b });
    pc += len;
  }
  return out;
}

function print(bank, addr, count) {
  for (const l of disasm(bank, addr, count)) {
    const bytes = l.raw.map(hex2).join(' ').padEnd(9);
    console.log(`${hex2(bank)}/${hex4(l.pc)}  ${bytes}  ${l.text}`);
  }
}

/** Every absolute reference to `addr` inside one bank — how callers are found. */
function find(bank, addr) {
  const lo = addr & 0xFF, hi = (addr >> 8) & 0xFF;
  const start = bank * 0x2000 + 0x10;
  const hits = [];
  for (let i = start; i < start + 0x2000 - 2; i++) {
    if (rom[i + 1] === lo && rom[i + 2] === hi) {
      const op = OPS[rom[i]];
      if (!op || M[op.mode] !== 3) continue;
      const base = 0x8000 + (i - start);
      hits.push({ addr: base, op: op.name, mode: op.mode });
    }
  }
  return hits;
}

const a = process.argv.slice(2);
if (a[0] === '--find') {
  const bank = parseInt(a[1], 16), target = parseInt(a[2], 16);
  const hits = find(bank, target);
  console.log(`references to $${hex4(target)} in bank ${hex2(bank)}: ${hits.length}`);
  for (const h of hits) console.log(`  ${hex2(bank)}/${hex4(h.addr)}  ${h.op} (${h.mode})`);
} else if (a[0] === '--bytes') {
  const bank = parseInt(a[1], 16), addr = parseInt(a[2], 16), n = parseInt(a[3] || '32', 10);
  const off = fileOff(bank, addr);
  console.log(Array.from(rom.slice(off, off + n)).map(hex2).join(' '));
} else if (a.length >= 2) {
  print(parseInt(a[0], 16), parseInt(a[1], 16), parseInt(a[2] || '40', 10));
} else {
  console.log('usage: dis6502.mjs <bank> <addr> [count] | --find <bank> <addr> | --bytes <bank> <addr> [n]');
}
