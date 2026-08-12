#!/usr/bin/env node
// event-dump.mjs — FF3 event scripts, from the ROM.
//
// Chain, all verified with tools/dis6502.mjs (v1.7.910):
//
//   tile $60-$63           collision byte2 = $F0 in every tileset -> handler
//                          type 15 in the $E669 jump table
//   $E6BE (type 15)        LDA $45 / AND #$0F -> trigId
//                          LDA $0720,X        -> EVENT ID for this instance
//                          JSR $EB23          -> LDA #$2C / JMP $FF03  (bank $2C)
//                          LDA $8880,X / $8881,X -> 16-bit script pointer
//                          JSR $EA1B          -> copy 64 bytes to $7B00
//                          JSR $EB28          -> back to bank $3C
//   $3C/931B               the evaluator, over $7B00
//
// Script format (from $3C/931B):
//   A script is a sequence of RECORDS. Each record is a run of condition
//   bytes terminated by $FF, followed by one result byte.
//     - condition byte bit 7 = polarity (set -> branch on true, clear -> on
//       false; $9328/$9332 take opposite exits)
//     - low 3 bits index a bit-mask table at $3C/935A
//   Records are tried in order; the first whose conditions pass has its
//   result byte stored to $6C and the evaluator returns. $FF followed by the
//   result is also the terminator of the whole script.
//
// v1.7.911 — reading the scripts from bank $2D (see below) makes them parse as
// records with $FF terminators and small result codes, matching the evaluator.
// Events also SHARE SUFFIXES: event 1's pointer is event 0's + 6, and event 1's
// bytes are event 0's tail, so a failing record falls through into the next
// event's chain. The result-code semantics ($6C) are still unmapped.
//
//   node tools/event-dump.mjs            # pointer table + record structure
//   node tools/event-dump.mjs 12         # one event, raw bytes + parse
//   node tools/event-dump.mjs --raw 12

import fs from 'node:fs';

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));

// $FF03 -> $FF17 sets BOTH MMC3 slots: R6 = bank A at $8000-$9FFF and
// R7 = bank A+1 at $A000-$BFFF. So `LDA #$2C / JSR $FF03` maps $2C at $8000
// AND $2D at $A000. The pointer table ($8880) is in $2C; the scripts it points
// at ($A1xx) are in $2D. Reading both from $2C is what made the script bytes
// look like a list of $99xx pointers and produced nonsense like "54
// conditions" — the block was never a pointer list, it was the wrong bank.
const PTR_BANK   = 0x2C;
const DATA_BANK  = 0x2D;
const PTR_TABLE  = 0x8880;                 // in the $8000 window of bank $2C
const bankOff = (bank, addr) => bank * 0x2000 + 0x10 + (addr >= 0xA000 ? addr - 0xA000 : addr - 0x8000);
const MASKS = () => {                       // $3C/935A, low-3-bits mask table
  const off = bankOff(0x3C, 0x935A);
  return Array.from(rom.slice(off, off + 8));
};

const hex2 = v => v.toString(16).toUpperCase().padStart(2, '0');

export function eventPointer(id) {
  const off = bankOff(PTR_BANK, PTR_TABLE) + id * 2;
  return rom[off] | (rom[off + 1] << 8);
}

/** The 64 bytes the ROM copies to $7B00 for this event. */
export function eventBytes(id) {
  const ptr = eventPointer(id);
  const off = bankOff(DATA_BANK, ptr);
  return Array.from(rom.slice(off, off + 64));
}

/**
 * Split the block into records the way $3C/931B walks it: conditions until
 * $FF, then one result byte. Stops at the first record with no conditions,
 * since that is the script's own terminator.
 */
export function parseEvent(id) {
  const b = eventBytes(id);
  const records = [];
  let i = 0;
  while (i < b.length && records.length < 16) {
    const conds = [];
    while (i < b.length && b[i] !== 0xFF) { conds.push(b[i]); i++; }
    if (i >= b.length) break;
    i++;                                   // the $FF
    if (i >= b.length) break;              // no result byte — ran off the block
    const result = b[i]; i++;
    records.push({ conds, result });
    if (conds.length === 0) break;         // terminator record
  }
  return { id, ptr: eventPointer(id), records };
}

function describe(c) {
  const polarity = (c & 0x80) ? 'if SET' : 'if CLEAR';
  const maskIdx = c & 0x07;
  const flagIdx = (c & 0x7F) >> 3;
  return `$${hex2(c)} (${polarity}, flag byte ${flagIdx}, mask idx ${maskIdx})`;
}

const args = process.argv.slice(2);
const RAW = args.includes('--raw');
const one = args.find(a => /^\d+$/.test(a));

if (one != null) {
  const id = parseInt(one, 10);
  const p = parseEvent(id);
  console.log(`event ${id}  script at bank $2C:$${p.ptr.toString(16).toUpperCase()}  (ROM 0x${bankOff(DATA_BANK, p.ptr).toString(16)})`);
  if (RAW) console.log('raw 64B: ' + eventBytes(id).map(hex2).join(' '));
  p.records.forEach((r, i) => {
    console.log(`  record ${i}: result $${hex2(r.result)}`);
    if (!r.conds.length) console.log('    (no conditions — terminator / unconditional)');
    for (const c of r.conds) console.log('    ' + describe(c));
  });
} else {
  console.log(`condition mask table ($3C/935A): ${MASKS().map(hex2).join(' ')}`);
  console.log('\n id   ptr     records  first result');
  for (let id = 0; id < 32; id++) {
    const p = parseEvent(id);
    const first = p.records[0];
    console.log(`  ${String(id).padStart(2)}  $${p.ptr.toString(16).toUpperCase()}   ${String(p.records.length).padStart(2)}       `
      + (first ? `$${hex2(first.result)} after ${first.conds.length} cond(s)` : '(none)'));
  }
  console.log('\nOne event: node tools/event-dump.mjs <id>');
}
