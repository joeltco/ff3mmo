#!/usr/bin/env node
// rom-patch.mjs — apply byte patches to a COPY of the ROM.
//
// For building instrumented/debug ROMs to get ground truth out of the real
// game. Never writes to the source ROM.
//
// Address forms:
//   0x7B8F6=4C,28,B9          absolute file offset
//   3D:B8E6=4C,28,B9          bank:NES-address (MMC3 windows; $8000/$A000
//                             are the switchable pair, $C000/$E000 fixed)
//
//   node tools/rom-patch.mjs out.nes 3D:B8E6=4C,28,B9
//   node tools/rom-patch.mjs out.nes --verify 3D:B8E6=A6,07,BD
//
// `--verify` checks the CURRENT bytes match instead of writing, so a patch
// can assert what it is overwriting before it overwrites it.

import fs from 'node:fs';

const args = process.argv.slice(2);
const out = args[0];
const VERIFY = args.includes('--verify');
const specs = args.slice(1).filter(a => a.includes('='));

const SRC = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(SRC));

function resolve(addr) {
  if (addr.includes(':')) {
    const [bankStr, addrStr] = addr.split(':');
    const bank = parseInt(bankStr, 16);
    const a = parseInt(addrStr, 16);
    const base = a >= 0xE000 ? 0xE000 : a >= 0xC000 ? 0xC000 : a >= 0xA000 ? 0xA000 : 0x8000;
    return bank * 0x2000 + 0x10 + (a - base);
  }
  return parseInt(addr, 16);
}

let failed = 0;
for (const spec of specs) {
  const [addrPart, bytesPart] = spec.split('=');
  const off = resolve(addrPart);
  const bytes = bytesPart.split(',').map(b => parseInt(b, 16));
  const cur = [...rom.slice(off, off + bytes.length)];
  const hex = (a) => a.map(b => b.toString(16).padStart(2, '0')).join(' ');
  if (VERIFY) {
    const ok = cur.every((b, i) => b === bytes[i]);
    console.log(`${ok ? '  ✓' : '  ✗'} ${addrPart} (0x${off.toString(16)}): expected ${hex(bytes)}, found ${hex(cur)}`);
    if (!ok) failed++;
    continue;
  }
  console.log(`  patch ${addrPart} (0x${off.toString(16)}): ${hex(cur)} -> ${hex(bytes)}`);
  for (let i = 0; i < bytes.length; i++) rom[off + i] = bytes[i];
}

if (VERIFY) { process.exit(failed ? 1 : 0); }
fs.writeFileSync(out, rom);
console.log(`wrote ${out} (${rom.length} bytes)`);
