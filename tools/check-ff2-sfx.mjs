#!/usr/bin/env node
// check-ff2-sfx.mjs — EXECUTE the NSF stubs we hand-assembled.
//
// src/ff2-nsf-builder.js writes raw 6502 opcodes byte by byte, including
// relative branches whose offsets are counted by hand. A miscount assembles
// cleanly, builds a valid-looking NSF, and produces either silence or a stuck
// note — and `node --check` cannot see any of it. (The first draft of this
// builder had exactly that bug: BCS +11 where the song path is 10 bytes, so
// every sound effect landed one byte into the middle of an instruction.)
//
// So this runs the bytes. A minimal 6502 core — only the opcodes the builder
// emits — executes INIT and PLAY against fake memory and asserts the APU sees
// the values MEASURED off the FF2 ROM, for the right number of frames.
//
//   node tools/check-ff2-sfx.mjs

import { readFileSync } from 'node:fs';

const { buildFF2NSF, FF2_SFX, ff2SfxTrack } = await import('../src/ff2-nsf-builder.js');

const ROM_PATH = process.env.FF2_ROM || '/home/joeltco/roms/ff2-jp.nes';
let rom;
try { rom = new Uint8Array(readFileSync(ROM_PATH)); }
catch { console.error(`check-ff2-sfx: SKIP — no FF2 ROM at ${ROM_PATH}`); process.exit(0); }

// ── ground truth: read each blip's registers back out of the FF2 ROM ──────
// The expected values must NOT come from FF2_SFX — that is the thing under
// test, and a typo there would then agree with itself and pass. Walk the
// routine's actual bytes in the ROM's fixed bank instead, tracking A through
// `LDA #imm` and recording every `STA $4004-$4007` / `STA $E5`.
const PRG = rom.subarray(16, 16 + rom[4] * 16384);
const FIXED = PRG.length - 0x4000;
function romBlip(addr) {
  if (addr < 0xC000) return null;                 // only the fixed bank is stable
  let o = FIXED + (addr - 0xC000), a = null;
  const regs = {}; let dur = null;
  for (let n = 0; n < 24; n++) {
    const op = PRG[o];
    if (op === 0xA9) { a = PRG[o + 1]; o += 2; continue; }                        // LDA #
    if (op === 0x8D) {                                                            // STA abs
      const t = PRG[o + 1] | (PRG[o + 2] << 8);
      if (t >= 0x4004 && t <= 0x4007) regs[t] = a;
      o += 3; continue;
    }
    if (op === 0x85) { if (PRG[o + 1] === 0xE5) dur = a; o += 2; continue; }      // STA zp
    if (op === 0x60) break;                                                       // RTS
    break;                                                                        // anything else: stop
  }
  return { regs, dur };
}

const nsf = buildFF2NSF(rom);
const HEADER = 128, PAGE = 0x1000;

// ── memory: $8000-$BFFF = pages 0-3, $C000-$CFFF = page 4 ─────────────────
const mem = new Uint8Array(0x10000);
for (let p = 0; p < 5; p++) {
  mem.set(nsf.subarray(HEADER + p * PAGE, HEADER + (p + 1) * PAGE), 0x8000 + p * PAGE);
}
const apu = new Map();          // every $40xx write, in order
const fail = [];
const err = (m) => fail.push(m);

// ── a 6502 that knows exactly the opcodes the builder emits ───────────────
// Anything else is a hard error: an unknown opcode means the stub bytes are
// not the program we think they are.
function run(pc, a) {
  let X = 0, C = 0, Z = 0;
  const rd = (ad) => mem[ad & 0xFFFF];
  const wr = (ad, v) => {
    if ((ad & 0xFF00) === 0x4000) apu.set(ad, v);
    mem[ad & 0xFFFF] = v;
  };
  const setNZ = (v) => { Z = (v & 0xFF) === 0 ? 1 : 0; };
  for (let steps = 0; steps < 5000; steps++) {
    const op = rd(pc);
    switch (op) {
      case 0x4C: pc = rd(pc + 1) | (rd(pc + 2) << 8); break;               // JMP abs
      case 0xC9: { const m = rd(pc + 1); C = a >= m ? 1 : 0; setNZ(a - m); pc += 2; break; }  // CMP #
      case 0xB0: { const o = rd(pc + 1); pc += 2; if (C) pc += o < 128 ? o : o - 256; break; } // BCS
      case 0xD0: { const o = rd(pc + 1); pc += 2; if (!Z) pc += o < 128 ? o : o - 256; break; }// BNE
      case 0xF0: { const o = rd(pc + 1); pc += 2; if (Z) pc += o < 128 ? o : o - 256; break; } // BEQ
      case 0x85: wr(rd(pc + 1), a); pc += 2; break;                        // STA zp
      case 0x8D: wr(rd(pc + 1) | (rd(pc + 2) << 8), a); pc += 3; break;    // STA abs
      case 0xA9: a = rd(pc + 1); setNZ(a); pc += 2; break;                 // LDA #
      case 0xA5: a = rd(rd(pc + 1)); setNZ(a); pc += 2; break;             // LDA zp
      case 0xAD: a = rd(rd(pc + 1) | (rd(pc + 2) << 8)); setNZ(a); pc += 3; break;   // LDA abs
      case 0xBD: a = rd(((rd(pc + 1) | (rd(pc + 2) << 8)) + X) & 0xFFFF); setNZ(a); pc += 3; break; // LDA abs,X
      case 0xE9: { const m = rd(pc + 1); const r = a - m - (1 - C); C = r >= 0 ? 1 : 0; a = r & 0xFF; setNZ(a); pc += 2; break; } // SBC #
      case 0x0A: C = (a >> 7) & 1; a = (a << 1) & 0xFF; setNZ(a); pc += 1; break;    // ASL A
      case 0xAA: X = a; setNZ(a); pc += 1; break;                          // TAX
      case 0xC6: { const ad = rd(pc + 1); mem[ad] = (mem[ad] - 1) & 0xFF; setNZ(mem[ad]); pc += 2; break; } // DEC zp
      case 0x60: return { a, X };                                          // RTS
      case 0xEA: pc += 1; break;                                           // NOP
      default:
        throw new Error(`unknown opcode $${op.toString(16)} at $${pc.toString(16)} — the stub is not the program we assembled`);
    }
  }
  throw new Error('ran away — a branch offset is wrong');
}

// FF2's real driver lives at $9800/$9867. We never want to execute it here, so
// stub both with RTS: reaching one is itself the assertion that the song path
// was taken.
let hitDriverPlay = 0;
mem[0x9867] = 0x60; mem[0x9800] = 0x60;

const INIT = 0xC000, PLAY = 0xC020, SFX_FLAG = 0x0790;

// ── 1. a song track must still reach FF2's own init ───────────────────────
mem[0xE0] = 0xFF;
run(INIT, 7);
if (mem[0xE0] !== 7) err(`song track 7: FF2's init reads $E0, which holds ${mem[0xE0]} not 7`);
if (mem[SFX_FLAG] !== 0) err('song track left the sfx flag set — PLAY would never advance the music');
apu.clear(); run(PLAY, 0); hitDriverPlay++;
if (apu.size) err(`song PLAY wrote APU registers directly: ${[...apu.keys()].map(k => '$' + k.toString(16))}`);

// ── 2. every sfx track writes its MEASURED registers ──────────────────────
for (const s of FF2_SFX) {
  const track = ff2SfxTrack(s.name);
  if (track < 0) { err(`ff2SfxTrack("${s.name}") returned -1`); continue; }
  apu.clear();
  mem[0xE5] = 0;
  try { run(INIT, track); }
  catch (e) { err(`${s.name}: INIT crashed — ${e.message}`); continue; }

  const truth = romBlip(s.at);
  if (!truth || truth.dur == null) { err(`${s.name}: no blip routine readable at $${s.at.toString(16)} in the ROM`); continue; }
  for (const reg of [0x4004, 0x4005, 0x4006, 0x4007]) {
    const want = truth.regs[reg];
    if (want === undefined) { err(`${s.name}: the ROM routine at $${s.at.toString(16)} never writes $${reg.toString(16)}`); continue; }
    const got = apu.get(reg);
    if (got !== want) err(`${s.name}: $${reg.toString(16)} = ${got === undefined ? '(never written)' : '$' + got.toString(16)}, the ROM at $${s.at.toString(16)} writes $${want.toString(16)}`);
  }
  if (apu.get(0x4015) !== 0x0F) err(`${s.name}: $4015 not enabled`);
  if (mem[0xE5] !== truth.dur) err(`${s.name}: $E5 = ${mem[0xE5]}, the ROM sets ${truth.dur}`);
  if (s.dur !== truth.dur) err(`${s.name}: FF2_SFX says dur ${s.dur}, the ROM says ${truth.dur}`);
  if (mem[SFX_FLAG] !== 1) err(`${s.name}: sfx flag not set — PLAY would run the music driver instead`);

  // ...and PLAY must silence pulse 2 on exactly the ROM's frame, not before.
  let silencedAt = -1;
  for (let f = 1; f <= truth.dur + 4; f++) {
    apu.clear();
    run(PLAY, 0);
    if (apu.get(0x4004) === 0x30 && silencedAt < 0) silencedAt = f;
  }
  if (silencedAt !== truth.dur) {
    err(`${s.name}: pulse 2 silenced on frame ${silencedAt < 0 ? 'never' : silencedAt}, the ROM's countdown says ${truth.dur}`);
  }
}

// ── 3. the header must actually advertise the extra tracks ────────────────
const advertised = nsf[0x06];
if (advertised !== 31 + FF2_SFX.length) {
  err(`NSF header advertises ${advertised} tracks; 31 songs + ${FF2_SFX.length} sfx = ${31 + FF2_SFX.length}. libgme refuses a track past the count.`);
}

if (fail.length) {
  for (const m of fail) console.error(`  ✗ ${m}`);
  console.error(`\ncheck-ff2-sfx: FAIL — ${fail.length} problem(s)`);
  process.exit(1);
}
console.log(`check-ff2-sfx: OK — ${FF2_SFX.length} ripped blips execute and self-silence on the ROM's own frame ` +
            `(driver stubs reached ${hitDriverPlay ? 'on the song path' : 'never'})`);
