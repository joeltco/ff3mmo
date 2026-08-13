#!/usr/bin/env node
// ff2-sound-map.mjs — map FF2 (J)'s sound driver: entry points and the RAM
// bytes the game writes to REQUEST a sound.
//
// FF2's whole audio engine lives in PRG bank $0D mapped at $8000-$BFFF
// (see src/ff2-nsf-builder.js). ff2-sound-re.mjs only maps the FIXED last bank
// at $C000, so it cannot see the driver at all. This one maps $0D.
//
// The point of this tool is to answer, from the ROM itself:
//   1. where the driver's entry points are (song init, sfx init, per-frame),
//   2. which RAM address the GAME writes to ask for a sound,
// so tools/ff2-sfx-rip.mjs can watch that address while the game plays and
// report the sound id behind a specific moment (text typing, cursor, confirm).
//
//   node tools/ff2-sound-map.mjs                  # entry points + RAM refs
//   node tools/ff2-sound-map.mjs --disasm 9867 60
//   node tools/ff2-sound-map.mjs --bank 0D --disasm 9800 40

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };

const ROM_PATH = process.env.FF2_ROM || '/home/joeltco/roms/ff2-jp.nes';
const rom = readFileSync(ROM_PATH);
const PRG = rom.subarray(16, 16 + rom[4] * 16384);
const BANK = parseInt(flag('bank', '0D'), 16);
const BANK_OFF = BANK * 0x4000;
const FIXED_OFF = PRG.length - 0x4000;

// $8000-$BFFF = the selected bank; $C000-$FFFF = the fixed last bank.
function cpuToPrg(a) {
  if (a >= 0xC000) return FIXED_OFF + (a - 0xC000);
  if (a >= 0x8000) return BANK_OFF + (a - 0x8000);
  return null;
}
const rd = (a) => { const o = cpuToPrg(a); return o == null ? undefined : PRG[o]; };

const T = {
  0x00:['BRK',1],0x01:['ORA (zp,X)',2],0x05:['ORA zp',2],0x06:['ASL zp',2],0x08:['PHP',1],0x09:['ORA #',2],0x0A:['ASL A',1],0x0D:['ORA abs',3],0x0E:['ASL abs',3],
  0x10:['BPL',2],0x11:['ORA (zp),Y',2],0x15:['ORA zp,X',2],0x16:['ASL zp,X',2],0x18:['CLC',1],0x19:['ORA abs,Y',3],0x1D:['ORA abs,X',3],0x1E:['ASL abs,X',3],
  0x20:['JSR abs',3],0x21:['AND (zp,X)',2],0x24:['BIT zp',2],0x25:['AND zp',2],0x26:['ROL zp',2],0x28:['PLP',1],0x29:['AND #',2],0x2A:['ROL A',1],0x2C:['BIT abs',3],0x2D:['AND abs',3],0x2E:['ROL abs',3],
  0x30:['BMI',2],0x31:['AND (zp),Y',2],0x35:['AND zp,X',2],0x36:['ROL zp,X',2],0x38:['SEC',1],0x39:['AND abs,Y',3],0x3D:['AND abs,X',3],0x3E:['ROL abs,X',3],
  0x40:['RTI',1],0x41:['EOR (zp,X)',2],0x45:['EOR zp',2],0x46:['LSR zp',2],0x48:['PHA',1],0x49:['EOR #',2],0x4A:['LSR A',1],0x4C:['JMP abs',3],0x4D:['EOR abs',3],0x4E:['LSR abs',3],
  0x50:['BVC',2],0x51:['EOR (zp),Y',2],0x55:['EOR zp,X',2],0x56:['LSR zp,X',2],0x58:['CLI',1],0x59:['EOR abs,Y',3],0x5D:['EOR abs,X',3],0x5E:['LSR abs,X',3],
  0x60:['RTS',1],0x61:['ADC (zp,X)',2],0x65:['ADC zp',2],0x66:['ROR zp',2],0x68:['PLA',1],0x69:['ADC #',2],0x6A:['ROR A',1],0x6C:['JMP (abs)',3],0x6D:['ADC abs',3],0x6E:['ROR abs',3],
  0x70:['BVS',2],0x71:['ADC (zp),Y',2],0x75:['ADC zp,X',2],0x76:['ROR zp,X',2],0x78:['SEI',1],0x79:['ADC abs,Y',3],0x7D:['ADC abs,X',3],0x7E:['ROR abs,X',3],
  0x81:['STA (zp,X)',2],0x84:['STY zp',2],0x85:['STA zp',2],0x86:['STX zp',2],0x88:['DEY',1],0x8A:['TXA',1],0x8C:['STY abs',3],0x8D:['STA abs',3],0x8E:['STX abs',3],
  0x90:['BCC',2],0x91:['STA (zp),Y',2],0x94:['STY zp,X',2],0x95:['STA zp,X',2],0x96:['STX zp,Y',2],0x98:['TYA',1],0x99:['STA abs,Y',3],0x9A:['TXS',1],0x9D:['STA abs,X',3],
  0xA0:['LDY #',2],0xA1:['LDA (zp,X)',2],0xA2:['LDX #',2],0xA4:['LDY zp',2],0xA5:['LDA zp',2],0xA6:['LDX zp',2],0xA8:['TAY',1],0xA9:['LDA #',2],0xAA:['TAX',1],0xAC:['LDY abs',3],0xAD:['LDA abs',3],0xAE:['LDX abs',3],
  0xB0:['BCS',2],0xB1:['LDA (zp),Y',2],0xB4:['LDY zp,X',2],0xB5:['LDA zp,X',2],0xB6:['LDX zp,Y',2],0xB8:['CLV',1],0xB9:['LDA abs,Y',3],0xBA:['TSX',1],0xBC:['LDY abs,X',3],0xBD:['LDA abs,X',3],0xBE:['LDX abs,Y',3],
  0xC0:['CPY #',2],0xC1:['CMP (zp,X)',2],0xC4:['CPY zp',2],0xC5:['CMP zp',2],0xC6:['DEC zp',2],0xC8:['INY',1],0xC9:['CMP #',2],0xCA:['DEX',1],0xCC:['CPY abs',3],0xCD:['CMP abs',3],0xCE:['DEC abs',3],
  0xD0:['BNE',2],0xD1:['CMP (zp),Y',2],0xD5:['CMP zp,X',2],0xD6:['DEC zp,X',2],0xD8:['CLD',1],0xD9:['CMP abs,Y',3],0xDD:['CMP abs,X',3],0xDE:['DEC abs,X',3],
  0xE0:['CPX #',2],0xE1:['SBC (zp,X)',2],0xE4:['CPX zp',2],0xE5:['SBC zp',2],0xE6:['INC zp',2],0xE8:['INX',1],0xE9:['SBC #',2],0xEA:['NOP',1],0xEC:['CPX abs',3],0xED:['SBC abs',3],0xEE:['INC abs',3],
  0xF0:['BEQ',2],0xF1:['SBC (zp),Y',2],0xF5:['SBC zp,X',2],0xF6:['INC zp,X',2],0xF8:['SED',1],0xF9:['SBC abs,Y',3],0xFD:['SBC abs,X',3],0xFE:['INC abs,X',3],
};
const hx = (v, n = 2) => '$' + v.toString(16).padStart(n, '0');

function decode(a) {
  const op = rd(a), e = T[op];
  if (!e) return { text: `.byte ${hx(op)}`, len: 1, op };
  const [mn, len] = e;
  let operand = '', target = null;
  if (len === 2) {
    const b = rd(a + 1);
    if (mn[0] === 'B' && mn !== 'BIT' && mn !== 'BRK') { target = (a + 2 + (b < 128 ? b : b - 256)) & 0xFFFF; operand = hx(target, 4); }
    else operand = hx(b);
  } else if (len === 3) { target = (rd(a + 2) << 8) | rd(a + 1); operand = hx(target, 4); }
  return { text: `${mn} ${operand}`, len, mn, op, target, imm: len === 2 ? rd(a + 1) : null };
}

function disasm(start, count) {
  let a = start;
  for (let n = 0; n < count; n++) {
    const d = decode(a);
    console.log(`  ${hx(a, 4)}: ${d.text}`);
    a += d.len;
  }
}

if (args.includes('--disasm')) {
  const at = parseInt(flag('disasm', '9800'), 16);
  disasm(at, parseInt(args[args.indexOf('--disasm') + 2] || '40', 10));
  process.exit(0);
}

// ── Entry points ───────────────────────────────────────────────────────────
// Known from the builder: PLAY $9800, INIT-song $9867. Anything else the rest
// of the ROM JSRs into inside $9800-$99FF is another driver entry.
console.log(`ROM ${ROM_PATH} — PRG ${PRG.length} bytes, bank $${BANK.toString(16).toUpperCase()} at $8000`);

const jsrTargets = new Map();   // driver addr -> [{bank, site}]
for (let bank = 0; bank * 0x4000 < PRG.length; bank++) {
  const base = bank * 0x4000;
  const isFixed = base === FIXED_OFF;
  for (let o = base; o < Math.min(base + 0x4000, PRG.length) - 2; o++) {
    if (PRG[o] !== 0x20) continue;                       // JSR abs
    const t = PRG[o + 1] | (PRG[o + 2] << 8);
    if (t < 0x9700 || t > 0x9A00) continue;              // driver window
    const cpu = isFixed ? 0xC000 + (o - base) : 0x8000 + (o - base);
    if (!jsrTargets.has(t)) jsrTargets.set(t, []);
    jsrTargets.get(t).push({ bank, cpu });
  }
}
// Only calls from the FIXED bank are real: a JSR $98xx from a swappable bank
// lands in THAT bank's own $98xx, not the driver. The driver is reached through
// fixed-bank wrappers that swap $0D in first.
const FIXED_BANK = FIXED_OFF / 0x4000;
console.log('\nJSR into $9700-$9A00 from the FIXED bank (these are real driver calls):');
for (const [t, sites] of [...jsrTargets].sort((a, b) => a[0] - b[0])) {
  const fixed = sites.filter(s => s.bank === FIXED_BANK);
  if (!fixed.length) continue;
  console.log(`  ${hx(t, 4)}  <- ${fixed.map(s => hx(s.cpu, 4)).join(' ')}`);
}
console.log('\n(ignored: ' +
  [...jsrTargets.values()].reduce((n, s) => n + s.filter(x => x.bank !== FIXED_BANK).length, 0) +
  ' JSRs from swappable banks — those hit their own bank, not the driver)');

// ── What each entry reads ─────────────────────────────────────────────────
// The request byte is whatever the entry LOADs first. $9867 is documented to
// read zero page $E0; the sfx entry should read a sibling.
console.log('\nFirst loads of each entry point (the "request" byte it consumes):');
for (const t of [...jsrTargets.keys()].sort()) {
  let a = t;
  const reads = [];
  for (let i = 0; i < 24 && reads.length < 3; i++) {
    const d = decode(a);
    if (/^LD[AXY] (zp|abs)$/.test(d.mn || '')) reads.push(`${d.mn.split(' ')[0]} ${hx(d.target != null ? d.target : d.imm, d.mn.endsWith('abs') ? 4 : 2)}`);
    if (d.mn === 'RTS' || d.mn === 'JMP abs') break;
    a += d.len;
  }
  console.log(`  ${hx(t, 4)}: ${reads.join(' , ') || '(no direct load in first 24 ops)'}`);
}
