// m6502.mjs — a 6502 disassembler, only as complete as this project needs.
//
// Extracted from `ff3-code-trace.mjs` so the opcode table has exactly ONE home.
// A second copy is how a correction lands in one file and not the other.
//
// ⛔ `listing()` decodes forward from wherever you start it. Starting on an
// operand byte produces confident nonsense, so anchor on something known.

// ── a 6502 disassembler, only as complete as this job needs ─────────────────
const IMP = 1, IMM = 2, ZP = 3, ZPX = 4, ZPY = 5, ABS = 6, ABSX = 7, ABSY = 8,
      IND = 9, INDX = 10, INDY = 11, REL = 12, ACC = 13;
const LEN = { [IMP]: 1, [ACC]: 1, [IMM]: 2, [ZP]: 2, [ZPX]: 2, [ZPY]: 2, [REL]: 2,
              [INDX]: 2, [INDY]: 2, [ABS]: 3, [ABSX]: 3, [ABSY]: 3, [IND]: 3 };
export const OP = {};
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

export const hx = (v, w = 2) => v.toString(16).toUpperCase().padStart(w, '0');
export function disasm1(mem, pc) {
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
export function listing(mem, from, to) {
  const out = [];
  for (let pc = from; pc < to;) {
    const d = disasm1(mem, pc);
    const raw = [...mem.slice(pc, pc + d.len)].map(v => hx(v)).join(' ').padEnd(8);
    out.push(`  $${hx(pc, 4)}  ${raw}  ${d.text}`);
    pc += d.len;
  }
  return out;
}

