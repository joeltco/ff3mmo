#!/usr/bin/env node
// ff2-build-playable-rom.mjs — hex patch FF2 so the intro's name entry can be
// finished headlessly, which is what unblocks capturing in-game sounds.
//
// THE PROBLEM
// FF2's kana name grid has no confirm cell. Measured exhaustively: A appends a
// kana, B is BACKSPACE (the portrait only changes on the 6th press, once all six
// are deleted), the grid scrolls through hiragana / dakuten / small kana /
// digits / katakana with no END anywhere, and NOTHING exits it — all 36 single
// and two-button combinations, A on every bottom-row cell, repeated B cascades,
// and a poke of EVERY byte in zero page, $0200-$07FF and $6000-$7FFF (20480
// pokes) all failed to leave the screen.
//
// THE CODE (bank 14, correctly aligned)
//   $b57f: LDA $24          ; A-press flag
//   $b581: BEQ $b54b        ; not pressed -> loop
//   $b583: JSR $905e
//   $b586: LDA $08          ; current name length
//   $b588: CMP #$06
//   $b58a: BCC $b592        ; length < 6 -> append a kana
//   $b58c: LDA #$00
//   $b58e: STA $08
//   $b590: CLC
//   $b591: RTS              ; <-- the ONLY way out of the routine
//
// The exit needs length >= 6, but the length saturates at 5, so `BCC` is taken
// forever and the RTS is unreachable. Every `$07` branch further down loops back
// via `JMP $b54c`, so none of those is the exit either.
//
// THE PATCH: one byte. CMP #$06 -> CMP #$05 at ROM 0x3b59a. The name still fills
// normally; the press that would have been the sixth kana now falls through to
// the RTS and the intro continues.
//
//   node tools/ff2-build-playable-rom.mjs out.nes
//
// NOTE ON READING FF2 CODE: jsnes' `cpu.mem` / `mmap.load` return the byte at
// ADDRESS-1 for this ROM, so a naive dump is shifted by one and decodes into
// garbage. Two earlier patches were aimed at addresses derived from such a dump
// and did nothing. Always verify a decode against an executed PC sequence.

import fs from 'node:fs';

const OUT = process.argv[2];
if (!OUT) { console.error('usage: ff2-build-playable-rom.mjs <out.nes>'); process.exit(2); }
const SRC = process.env.FF2_ROM || '/home/joeltco/roms/ff2-jp.nes';

const rom = new Uint8Array(fs.readFileSync(SRC));

// Locate by signature, never by a bare offset — a different ROM revision would
// otherwise be patched in the wrong place silently.
const SIG = [0xa5, 0x08, 0xc9, 0x06, 0x90, 0x06, 0xa9, 0x00, 0x85, 0x08, 0x18, 0x60];
const hits = [];
for (let i = 0; i < rom.length - SIG.length; i++) {
  let ok = true;
  for (let j = 0; j < SIG.length; j++) if (rom[i + j] !== SIG[j]) { ok = false; break; }
  if (ok) hits.push(i);
}
if (hits.length !== 1) {
  console.error(`expected exactly one name-length gate, found ${hits.length}`);
  process.exit(1);
}
const at = hits[0] + 3;                    // the CMP operand
console.log(`name-length gate at ROM 0x${at.toString(16)} (bank ${Math.floor((hits[0] - 16) / 0x4000)})`);
console.log(`  CMP #$${rom[at].toString(16).padStart(2, '0')} -> CMP #$05`);
rom[at] = 0x05;
fs.writeFileSync(OUT, Buffer.from(rom));
console.log('wrote ' + OUT);
