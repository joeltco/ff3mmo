// FF2 (J) NSF Builder — assembles an NSF from the standalone FF2 Famicom ROM.
//
// FF2's entire music engine + song table + song data live in 16KB bank $0D
// ($8000-$BFFF, self-contained — verified no cross-bank calls in the play
// path). Addresses from the everything8215/ff2 disassembly + rom-map:
//   PLAY (per-frame "update music"): $9800
//   INIT (load song by id): $9867 — id in zero page $E0 (raw index 0-30)
//   song pointer table: $9E0D (31 entries)   current song: $6F25
//
// Same single-bank shape as ff1-nsf-builder.js. Build at runtime from the
// user's ROM (never distribute the rip).

const PAGE_SIZE = 0x1000;  // 4KB NSF page
const HEADER_SIZE = 128;
const TOTAL_PAGES = 5;     // 4 pages for bank $0D + 1 page for stubs
const TOTAL_SONGS = 31;    // FF2 song pointer table has 31 entries
const BANK_0D_OFF = 0x0D * 0x4000 + 0x10;  // ROM offset for bank $0D (+ iNES header)

// ── FF2's short sound effects ─────────────────────────────────────────────
//
// FF2 has no SFX table. Its menu blips are three routines in the FIXED bank
// that poke pulse 2 directly and set a frame countdown in zero page $E5; the
// music driver's own per-frame code ($9808) decrements $E5 and writes $30 to
// $4004 when it reaches 0, which is what ends the sound.
//
// MEASURED v1.7.981 with tools/ff2-sfx-rip.mjs, which hooks jsnes' CPU write
// path and logs $E5. On the kana name-entry grid, pressing a DIRECTION fired
// $DB45 four times out of four and never fired $DB2E; pressing A or B fired
// $DB2E and never $DB45. That contrast is the evidence — not the routine's
// address or its position in the ROM.
//
// The register values below are the ROM's own bytes, read straight out of the
// routines (tools/ff2-sound-map.mjs --disasm db2e / db45 / c921). Nothing here
// is composed: each entry is four APU writes and a duration lifted verbatim.
export const FF2_SFX = [
  // name              $4004 $4005 $4006 $4007  frames   ROM routine
  { name: 'cursor',  r: [0x7C, 0xBA, 0x20, 0x20], dur: 12, at: 0xDB45 },
  { name: 'confirm', r: [0x7D, 0xBA, 0x40, 0x10], dur: 16, at: 0xDB2E },
  // A third blip exists at $C921 with the same shape. NOTHING in the ROM calls
  // it — no JSR, no JMP, in any bank — so which moment it belongs to is
  // unknown and it is NOT wired to anything. Exposed only so the rip is
  // complete and the claim is checkable.
  { name: 'unused-c921', r: [0x3A, 0x81, 0x60, 0x60], dur: 6, at: 0xC921 },
];

/** NSF track index for a named FF2 sound effect, or -1. */
export function ff2SfxTrack(name) {
  const i = FF2_SFX.findIndex(s => s.name === name);
  return i < 0 ? -1 : TOTAL_SONGS + i;
}

export function buildFF2NSF(romData) {
  const nsf = new Uint8Array(HEADER_SIZE + TOTAL_PAGES * PAGE_SIZE);

  // --- Header ---
  nsf[0x00] = 0x4E; nsf[0x01] = 0x45; nsf[0x02] = 0x53; nsf[0x03] = 0x4D; nsf[0x04] = 0x1A;
  nsf[0x05] = 0x01; // version
  nsf[0x06] = TOTAL_SONGS + FF2_SFX.length;
  nsf[0x07] = 0x01; // starting song (1-based)

  // Load address: $8000
  nsf[0x08] = 0x00; nsf[0x09] = 0x80;
  // INIT address: $C000 (our stub)
  nsf[0x0A] = 0x00; nsf[0x0B] = 0xC0;
  // PLAY address: $C020 (our stub)
  nsf[0x0C] = 0x20; nsf[0x0D] = 0xC0;

  // Song name / artist / copyright
  writeStr(nsf, 0x0E, 'Final Fantasy II', 32);
  writeStr(nsf, 0x2E, 'Nobuo Uematsu', 32);
  writeStr(nsf, 0x4E, '1988 Square', 32);

  // NTSC speed: 16666 µs
  nsf[0x6E] = 0x1A; nsf[0x6F] = 0x41;

  // Bankswitch init: pages 0-3 for $8000-$BFFF, page 4 for $C000
  nsf[0x70] = 0; nsf[0x71] = 1; nsf[0x72] = 2; nsf[0x73] = 3;
  nsf[0x74] = 4; nsf[0x75] = 0; nsf[0x76] = 0; nsf[0x77] = 0;

  // PAL speed
  nsf[0x78] = 0x1D; nsf[0x79] = 0x4E;
  nsf[0x7A] = 0x00; // NTSC
  nsf[0x7B] = 0x00; // no expansion audio

  // --- Bank $0D data (pages 0-3, 16KB at $8000-$BFFF) ---
  const bankData = new Uint8Array(romData.slice(BANK_0D_OFF, BANK_0D_OFF + 0x4000));
  for (let p = 0; p < 4; p++) {
    nsf.set(bankData.subarray(p * PAGE_SIZE, (p + 1) * PAGE_SIZE), HEADER_SIZE + p * PAGE_SIZE);
  }

  // --- Custom stubs (page 4, at $C000) ---
  //
  // The NSF header pins INIT to $C000 and PLAY to $C020, which leaves 32 bytes
  // for INIT — not enough now that it also has to dispatch sound effects. So
  // both are one-line trampolines into real routines further up the page.
  //
  //   $C000  JMP init            $C040  init:  track < 31 -> FF2 song path
  //   $C020  JMP play                          track >= 31 -> sfx path
  //                              $C080  play:  sfx mode -> countdown, else $9800
  //                              $C100  sfx table, 8 bytes per entry
  const stubOff = HEADER_SIZE + 4 * PAGE_SIZE;
  const at = (cpu) => stubOff + (cpu - 0xC000);
  const SFX_TAB = 0xC100;
  const SFX_FLAG = 0x0790;   // "a sound effect owns the chip" — RAM, page 7 is
                             // untouched by the driver (it lives in zero page
                             // + $6F00-$6F80) and by these stubs.

  let i = at(0xC000);
  nsf[i++] = 0x4C; nsf[i++] = 0x40; nsf[i++] = 0xC0;   // JMP $C040
  i = at(0xC020);
  nsf[i++] = 0x4C; nsf[i++] = 0x80; nsf[i++] = 0xC0;   // JMP $C080

  // ── init ($C040): A = track number, passed in by the NSF player ──────────
  i = at(0xC040);
  nsf[i++] = 0xC9; nsf[i++] = TOTAL_SONGS;             // CMP #TOTAL_SONGS
  // Branch past the 10-byte song path: STA(2) + LDA(2) + STA abs(3) + JMP(3).
  nsf[i++] = 0xB0; nsf[i++] = 0x0A;                    // BCS +10 -> sfx
  // song: clear sfx mode, then FF2's own init-song, which reads $E0.
  nsf[i++] = 0x85; nsf[i++] = 0xE0;                    // STA $E0
  nsf[i++] = 0xA9; nsf[i++] = 0x00;                    // LDA #$00
  nsf[i++] = 0x8D; nsf[i++] = SFX_FLAG & 0xFF; nsf[i++] = SFX_FLAG >> 8;  // STA SFX_FLAG
  nsf[i++] = 0x4C; nsf[i++] = 0x67; nsf[i++] = 0x98;   // JMP $9867
  // sfx: index = A - TOTAL_SONGS, entries are 8 bytes so the shift is free.
  nsf[i++] = 0xE9; nsf[i++] = TOTAL_SONGS;             // SBC #TOTAL_SONGS (carry set by CMP)
  nsf[i++] = 0x0A; nsf[i++] = 0x0A; nsf[i++] = 0x0A;   // ASL A x3
  nsf[i++] = 0xAA;                                     // TAX
  nsf[i++] = 0xA9; nsf[i++] = 0x01;                    // LDA #$01
  nsf[i++] = 0x8D; nsf[i++] = SFX_FLAG & 0xFF; nsf[i++] = SFX_FLAG >> 8;  // STA SFX_FLAG
  nsf[i++] = 0xA9; nsf[i++] = 0x0F;                    // LDA #$0F
  nsf[i++] = 0x8D; nsf[i++] = 0x15; nsf[i++] = 0x40;   // STA $4015 (enable pulse/tri/noise)
  for (let r = 0; r < 4; r++) {                        // the four measured writes
    nsf[i++] = 0xBD; nsf[i++] = (SFX_TAB + r) & 0xFF; nsf[i++] = (SFX_TAB + r) >> 8;  // LDA tab+r,X
    nsf[i++] = 0x8D; nsf[i++] = 0x04 + r; nsf[i++] = 0x40;                            // STA $4004+r
  }
  nsf[i++] = 0xBD; nsf[i++] = (SFX_TAB + 4) & 0xFF; nsf[i++] = (SFX_TAB + 4) >> 8;    // LDA tab+4,X
  nsf[i++] = 0x85; nsf[i++] = 0xE5;                    // STA $E5 (frame countdown)
  nsf[i++] = 0x60;                                     // RTS

  // ── play ($C080): one frame ─────────────────────────────────────────────
  // Sound-effect mode runs the SAME countdown the FF2 driver runs at $9808 —
  // tick $E5 down and, at zero, write $30 to $4004. That $30 (duty 0, envelope
  // disabled, volume 0) is the ROM's own way of ending the blip.
  i = at(0xC080);
  nsf[i++] = 0xAD; nsf[i++] = SFX_FLAG & 0xFF; nsf[i++] = SFX_FLAG >> 8;  // LDA SFX_FLAG
  nsf[i++] = 0xD0; nsf[i++] = 0x03;                    // BNE +3 -> sfx tick
  nsf[i++] = 0x4C; nsf[i++] = 0x00; nsf[i++] = 0x98;   // JMP $9800 (music)
  nsf[i++] = 0xA5; nsf[i++] = 0xE5;                    // LDA $E5
  nsf[i++] = 0xF0; nsf[i++] = 0x09;                    // BEQ +9 -> done
  nsf[i++] = 0xC6; nsf[i++] = 0xE5;                    // DEC $E5
  nsf[i++] = 0xD0; nsf[i++] = 0x05;                    // BNE +5 -> done
  nsf[i++] = 0xA9; nsf[i++] = 0x30;                    // LDA #$30
  nsf[i++] = 0x8D; nsf[i++] = 0x04; nsf[i++] = 0x40;   // STA $4004
  nsf[i++] = 0x60;                                     // RTS

  // ── sfx table ($C100): 8 bytes per entry, 5 used ────────────────────────
  i = at(SFX_TAB);
  for (const s of FF2_SFX) {
    nsf[i++] = s.r[0]; nsf[i++] = s.r[1]; nsf[i++] = s.r[2]; nsf[i++] = s.r[3];
    nsf[i++] = s.dur;
    nsf[i++] = 0; nsf[i++] = 0; nsf[i++] = 0;
  }

  return nsf;
}

function writeStr(buf, off, str, maxLen) {
  for (let i = 0; i < maxLen; i++) buf[off + i] = i < str.length ? str.charCodeAt(i) : 0;
}
