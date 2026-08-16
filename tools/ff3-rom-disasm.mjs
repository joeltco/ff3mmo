#!/usr/bin/env node
// ff3-rom-disasm.mjs — disassemble a range of the ROM file, statically.
//
// The dynamic tracer only ever shows code that RAN. To answer "could any other
// monster's script read this byte", the question is about code that exists, not
// code that executed — so the ROM has to be read directly.
//
//   node tools/ff3-rom-disasm.mjs --at 0x61F8E --before 0x20 --len 0x40
//
// ⛔ A file offset alone does not fix the CPU address: `$8000-$DFFF` is banked.
// The CPU address is derived from the bank the offset falls in, and printed so
// the listing can be compared against a dynamic trace.
// ⛔ Decoding forward from an operand byte yields confident nonsense. `--before`
// starts earlier so the stream has a chance to self-synchronise; check that the
// instruction you care about lands where you expect.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hx, disasm1 } from './lib/m6502.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const AT = Number(flag('at', '0'));
const BEFORE = Number(flag('before', '0x10'));
const LEN = Number(flag('len', '0x30'));
const WINDOW = Number(flag('window', '0x8000'));   // which CPU window the bank is mapped to

const rom = new Uint8Array(fs.readFileSync(path.join(HERE, '..', 'FF3-English.nes')));
if (!AT) { console.error('give --at <file offset>'); process.exit(1); }

const bank = ((AT - 16) / 0x2000) | 0;
const bankStart = 16 + bank * 0x2000;
const cpuOf = (off) => WINDOW + (off - bankStart);

const from = AT - BEFORE, to = AT + LEN;
// a memory-like view so the shared disassembler can index it by CPU address
const view = new Proxy({}, { get: (_, k) => {
  if (k === 'slice') return (a, b) => rom.slice(a - WINDOW + bankStart, b - WINDOW + bankStart);
  return rom[Number(k) - WINDOW + bankStart];
} });

console.log(`file 0x${hx(AT, 5)}  bank ${bank}  CPU $${hx(cpuOf(AT), 4)}  ` +
            `(window $${hx(WINDOW, 4)})\n`);
for (let pc = cpuOf(from); pc < cpuOf(to);) {
  const d = disasm1(view, pc);
  const off = pc - WINDOW + bankStart;
  const raw = [...rom.slice(off, off + d.len)].map(v => hx(v)).join(' ').padEnd(8);
  const mark = (off <= AT && AT < off + d.len) ? ' <<<< ' : '      ';
  console.log(`  0x${hx(off, 5)}  $${hx(pc, 4)}  ${raw}${mark}${d.text}`);
  pc += d.len;
}
