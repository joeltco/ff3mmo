#!/usr/bin/env node
// check-ff1-map.mjs — FF1's collision, door byte and tile specials stay decoded.
//
// Everything `lib/ff1-map.mjs` claims is a claim about a SPECIFIC INSTRUCTION in
// the ROM, so this gate checks each constant against the bytes at the address
// the module cites. Change `BLOCK_MASK` to 0x0F and the gate fails, because
// $CA83 really is `29 1F`.
//
// The special-id LABELS are different in kind: no ROM table names them, they
// were measured by driving the game's own request for each id and reading the
// shop's banner back off the nametable. So those are checked the only honest
// way — by doing it again for a few ids, live.
//
//   node tools/check-ff1-map.mjs
//
// ⛔ Do NOT let this gate derive an expectation from the value under test. Each
// expectation below is a literal opcode/operand written out by hand from the
// listing; the module is only ever the thing being compared AGAINST.

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NES } from 'jsnes';
import * as M from './lib/ff1-map.mjs';
import * as F1 from './lib/ff1-text.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROMP = process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes';
const STATE_GZ = path.join(HERE, 'states', 'ff1-hall.state.gz');

const rom = new Uint8Array(fs.readFileSync(ROMP));
// MMC1, 16KB banks, the LAST one fixed at $C000 — so a $C000-$FFFF address is
// at file offset 0x10 + (banks-1)*0x4000 + (addr - 0xC000).
const BANKS = (rom.length - 0x10) / 0x4000;
const fileOf = (addr) => 0x10 + (BANKS - 1) * 0x4000 + (addr - 0xC000);
const bytesAt = (addr, n) => [...rom.slice(fileOf(addr), fileOf(addr) + n)];

let fails = 0, checks = 0;
function eq(what, got, want) {
  checks++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { fails++; console.log(`  FAIL  ${what}\n          got ${g}  want ${w}`); }
  else console.log(`  ok    ${what}`);
}
/** The bytes at `addr` must be this instruction — that is what pins the constant. */
function instr(addr, want, what) {
  eq(`$${addr.toString(16).toUpperCase()}  ${what}`, bytesAt(addr, want.length), want);
}

console.log('FF1 map rules — the constants vs the instructions they claim\n');

console.log('collision  ($CA76, found by diffing blocked vs successful moves)');
instr(0xCA81, [0xA5, 0x44], 'LDA $44          — prop0 is the terrain byte');
instr(0xCA83, [0x29, M.BLOCK_MASK], `AND #$${M.BLOCK_MASK.toString(16)}         — BLOCK_MASK`);
instr(0xCA85, [0xC9, M.BLOCK_VALUE], `CMP #$${M.BLOCK_VALUE.toString(16).padStart(2, '0')}         — BLOCK_VALUE`);
instr(0xCA87, [0xF0, 0x11], 'BEQ $CA9A        — ...and equal means BLOCKED');
instr(0xCA89, [0x29, M.HANDLER_MASK], `AND #$${M.HANDLER_MASK.toString(16)}         — HANDLER_MASK`);
instr(0xCA8C, [0xBD, M.HANDLER_TABLE & 0xFF, M.HANDLER_TABLE >> 8], 'LDA $CDA1,X      — HANDLER_TABLE');
instr(0xCA96, [0x8A], 'TXA              — so the handler is entered with A = prop0 & $1E');
// ⛔ the rule this replaced: the routine at $CBE2 masks with `AND #$C2` at
// $CBEF and is NOT the move check.
instr(0xCBE2, [0x20, 0xBE, 0xCB], 'JSR $CBBE        — the LOOKALIKE routine...');
instr(0xCBEF, [0x29, 0xC2], 'AND #$C2         — ...and its mask, deliberately not used');

console.log('\nterrain dispatch (table at $CDA1)');
const handler = (x) => bytesAt(M.HANDLER_TABLE + x, 2).reduce((lo, hi) => lo | (hi << 8));
for (const x of M.HANDLER_DOOR_OPEN) eq(`$CDA1[${x}] -> $CE53 (door open)`, handler(x), 0xCE53);
eq(`$CDA1[${M.HANDLER_DOOR_CLOSE}] -> $CE44 (door close)`, handler(M.HANDLER_DOOR_CLOSE), 0xCE44);
eq('$CDA1[0] -> $CE51 (plain floor)', handler(0), 0xCE51);

console.log('\n$0D is the DOOR byte — not an inside/outside flag');
instr(0xCE53, [0x4A], 'LSR A            — doorVariantFor shifts by 1');
instr(0xCE54, [0x29, 0x03], 'AND #$03         — ...and masks 3');
eq('doorVariantFor(prop0 0x03) === 1', M.doorVariantFor(0x03), 1);
instr(0xCE65, [0x06, M.DOOR_STATE], 'ASL $0D          — for the CARRY (old bit 7) only');
instr(0xCE67, [0x85, M.DOOR_STATE], 'STA $0D          — DOOR_STATE');
instr(0xCE69, [0xB0, 0x03], 'BCS +            — already open -> skip the sound');
instr(0xCEBB, [0xA5, M.DOOR_STATE], 'LDA $0D          — the draw routine');
instr(0xCEBF, [0x30, 0xF9], 'BMI -            — bit 7 set = already drawn');
instr(0xCEC1, [0x29, M.DOOR_VARIANT_MASK], `AND #$0${M.DOOR_VARIANT_MASK} — DOOR_VARIANT_MASK`);
instr(0xCEE4, [0xA9, 0x81, 0xA2, M.DOOR_TILE_BY_VARIANT[1]], 'LDA #$81 / LDX #$37 — variant 1');
instr(0xCEDD, [0xA9, 0x82, 0xA2, M.DOOR_TILE_BY_VARIANT[2]], 'LDA #$82 / LDX #$37 — variant 2');
instr(0xCED6, [0xA9, 0x00, 0xA2, M.DOOR_TILE_BY_VARIANT[5]], 'LDA #$00 / LDX #$36 — variant 5');
instr(0xCECF, [0xA9, 0x00, 0xA2, M.DOOR_TILE_DEFAULT], 'LDA #$00 / LDX #$3B — the default');
eq('the serviced states both carry DOOR_SERVICED', [0x81 & M.DOOR_SERVICED, 0x82 & M.DOOR_SERVICED],
   [M.DOOR_SERVICED, M.DOOR_SERVICED]);
instr(0xCE44, [0xA5, M.DOOR_STATE, 0x10, 0x07, 0x49, 0x84], 'LDA $0D / BPL + / EOR #$84 — the close path');
// $CF1E is the door SOUND. An earlier pass read it as a layer redraw, which is
// what made "$0D switches rooms" look plausible.
instr(0xCF1E, [0xA9, 0x0C, 0x8D, 0x0C, 0x40], 'LDA #$0C / STA $400C — the NOISE channel');
instr(0xCF25, [0x8D, 0x0E, 0x40], 'STA $400E        — ...still the noise channel');

console.log('\ntile specials ($50 / $51)');
instr(0xCEB0, [0xA5, 0x45], 'LDA $45          — prop1 is the special id');
instr(0xCEB2, [0xF0, 0x04], 'BEQ +            — prop1 == 0 does nothing');
instr(0xCEB4, [0x85, M.SPECIAL_ID], 'STA $51          — SPECIAL_ID');
instr(0xCEB6, [0xE6, M.SPECIAL_PENDING], 'INC $50          — SPECIAL_PENDING');
instr(0xC8E5, [0xA5, M.SPECIAL_PENDING], 'LDA $50          — the pending branch');

console.log('\nthe id bands cover 0..70 with no gap and no overlap');
let next = 0, contiguous = true;
for (const b of M.SPECIAL_BANDS) { if (b.lo !== next || b.hi < b.lo) contiguous = false; next = b.hi + 1; }
eq('bands are contiguous from 0', contiguous, true);
eq('bands end at SPECIAL_ID_MAX', next - 1, M.SPECIAL_ID_MAX);

// ── the labels, re-measured ──────────────────────────────────────────────────
// No ROM table names these, so the only honest check is to open them again.
console.log('\nspecial ids, re-opened live (the label is the word the game draws)');
if (!fs.existsSync(STATE_GZ)) {
  fails++;
  console.log(`  FAIL  ${STATE_GZ} is missing — the live half of this gate cannot run`);
} else {
  const snap = zlib.gunzipSync(fs.readFileSync(STATE_GZ)).toString('utf8');
  const romBin = fs.readFileSync(ROMP, 'binary');
  const banner = (id) => {
    const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
    nes.loadROM(romBin);
    nes.fromJSON(JSON.parse(snap));
    for (let i = 0; i < 20; i++) nes.frame();
    nes.cpu.mem[M.SPECIAL_ID] = id;
    nes.cpu.mem[M.SPECIAL_PENDING] = 1;
    for (let i = 0; i < 260; i++) nes.frame();
    const v = nes.ppu.vramMem;
    let first = null;
    for (const base of [0x2000, 0x2400, 0x2800, 0x2C00]) {
      for (let r = 0; r < 30 && !first; r++) {
        let s = '';
        for (let c = 0; c < 32; c++) {
          const g = F1.glyph(v[base + r * 32 + c]);
          s += (g === null || g === '\n') ? ' ' : g;
        }
        s = s.trim();
        if (/^[A-Z]{3,}$/.test(s)) first = s;
      }
      if (first) break;
    }
    return { banner: first, flag: nes.cpu.mem[M.DOOR_STATE] };
  };
  // one id from the middle of each band, plus both sides of a boundary
  for (const id of [5, 12, 20, 21, 35, 45, 55, 65, 70]) {
    const r = banner(id);
    eq(`id ${String(id).padStart(2)} draws "${M.specialKind(id)}"`, r.banner, M.specialKind(id));
    // THE QUESTION THIS AROSE FROM: $0D inside a shop.
    eq(`id ${String(id).padStart(2)} — $0D bit 0 is clear in the shop`, r.flag & 1, 0);
  }
}

console.log(`\n${checks - fails}/${checks} checks passed`);
if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
