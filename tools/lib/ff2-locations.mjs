// ff2-locations.mjs — FF2's location chain, and the warp that finally works.
//
// ⭐⭐ THIS UNBLOCKS FF2. Three approaches dead-ended before this one (walking from
// `ff2-outside`, boot-driving, hunting a warp table — see `ff2-encounters.mjs`).
// The way in is not a warp table at all: it is the location loader plus the fact
// that FF2's NMI VECTOR LIVES IN RAM.
//
// THE CHAIN (read off the ROM, then proven by patching it):
//   $48                    zero page, the CURRENT LOCATION ID
//   file 0x3210 = $B200    location -> TILEMAP id, bank 0, stride 1
//   $D348 LDA $B200,X      the single reader
//   $D341                  the loader: tilemap bit 7 picks bank 4/5, a 2-byte
//                          pointer at $8000 gives the compressed map, which is
//                          decompressed to $7400
//   $D083                  ⭐ the routine the GAME uses: kills rendering, calls
//                          $D341, re-banks, continues. Invoke THIS, not $D341.
//
// ⭐⭐ HOW TO INVOKE IT. `$FFFA` (the NMI vector) holds **$0100** — RAM. `$0100`
// holds `4C A1 FE` (JMP $FEA1) and `$0103`-`$010F` are free `$FF`. So: write a
// stub `JSR $D083 / JMP $FEA1` at `$0103`, point `$0100` at it, run ONE frame, and
// restore the trampoline. The game's own interrupt calls the loader with the bank,
// stack and timing it expects.
//
// ⛔ PC INJECTION DOES NOT WORK, and the trace that looked like a derail
// ($D341 -> $0100 -> $FEA1) was never a derail — that IS the NMI vector doing its
// job, and the injected PC lost the race to it. Don't fight the NMI; use it.
// ⛔ `m6502.mjs#listing` labels lines with FILE OFFSETS, not CPU addresses. For
// this bank `cpu = file - 0x30010`. Copying those labels put every address 0x11
// too high and made the routine look inert.
// ⛔ DO NOT hash $7400 after the loader returns to compare two locations: $D083
// keeps writing PER-LOCATION data into that region, so two locations sharing a
// tilemap still differ. Snapshot at `LOADER_RETURN_PC`.

import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { NES } from 'jsnes';

export const LOC_ID_ZP = 0x48;
export const LOC_TILEMAP_TABLE = 0x3210;   // file offset; CPU $B200, bank 0
export const LOC_TILEMAP_STRIDE = 1;
export const LOC_TABLE_CPU = 0xB200;
export const LOC_TABLE_READ_PC = 0xD348;   // LDA $B200,X
export const LOC_LOADER_PC = 0xD341;
export const ENTER_LOCATION_PC = 0xD083;   // what the game itself calls
export const LOADER_RETURN_PC = 0xD08F;    // the instruction after JSR $D341
export const MAP_RAM = 0x7400, MAP_RAM_LEN = 0x400;
export const NMI_VECTOR_RAM = 0x0100;
export const NMI_STUB_RAM = 0x0103;
export const NMI_TRAMPOLINE = [0x4C, 0xA1, 0xFE];
/** TCRF's two documented anchors, used only to FIND the table. */
export const TCRF_ANCHORS = [{ loc: 0x5C, tilemap: 0x2E }, { loc: 0x60, tilemap: 0x30 }];
export const UNREFERENCED_TILEMAP = 0x2F;

export const tilemapOf = (rom, loc) => rom[LOC_TILEMAP_TABLE + loc * LOC_TILEMAP_STRIDE];

// ── ⭐⭐ THE WARP TABLE — the thing three earlier attempts failed to find ────
// It is not a "warp table" with destination records; it is FOUR parallel arrays
// indexed by the DESTINATION location id, which the transition at $CAC0 reads:
//
//   $CAD6  LDX $45                                        ; destination id
//   $CAD8  LDA $B000,X / AND #$1F / SEC / SBC #$07 / AND #$3F / STA $29   ; X
//   $CAE4  LDA $B100,X            / SEC / SBC #$07 / AND #$3F / STA $2A   ; Y
//   $CAEE  STX $48                                        ; becomes current
//   $CAF0  JSR $CA41                                      ; full entry
//
// ⭐ `$CA41` RETURNS — it is the location-entry-and-run body — so a full warp is:
// poke $29/$2A/$48/$45 and call $CA41 through the NMI stub. THAT redraws the
// screen and places the party; `$D083` alone loads the map buffer and neither.
// ⛔ `$B000` carries the X in its LOW 5 BITS ONLY — the top 3 bits are a separate
// field (`$E534 LDA $B000,X / AND #$E0` builds a graphics pointer from them).
export const DEST_X_TABLE = 0x3010;        // file; CPU $B000, bank 0
export const DEST_Y_TABLE = 0x3110;        // file; CPU $B100, bank 0
export const LOC_TILESET_TABLE = 0x3310;   // file; CPU $B300 — bit 0 picks a tileset
export const DEST_ID_ZP = 0x45;
export const PARTY_X_ZP = 0x29, PARTY_Y_ZP = 0x2A;
export const LOC_ENTRY_PC = 0xCA41;
export const DEST_X_MASK = 0x1F, DEST_BIAS = 7, DEST_WRAP = 0x3F;

/** Where the game will put the party when it enters `dest`. */
export const destX = (rom, dest) => ((rom[DEST_X_TABLE + dest] & DEST_X_MASK) - DEST_BIAS) & DEST_WRAP;
export const destY = (rom, dest) => ((rom[DEST_Y_TABLE + dest]) - DEST_BIAS) & DEST_WRAP;

/**
 * ⭐ A FULL warp: the screen redraws and the party is placed, unlike `warp()`
 * which only drives the map loader. Returns the live machine so callers can walk.
 */
export function enterLocation(rom, snapshot, dest, { patch = null, frames = 150 } = {}) {
  const r = patch ? Uint8Array.from(rom) : rom;
  if (patch) for (const [off, val] of Object.entries(patch)) r[Number(off)] = val;
  let fb = null;
  const nes = new NES({ onFrame: (b) => { fb = b; }, onAudioSample: () => {} });
  nes.loadROM(Buffer.from(r).toString('binary'));
  nes.fromJSON(JSON.parse(snapshot));
  nes.frame();
  const c = nes.cpu;
  c.mem[PARTY_X_ZP] = destX(r, dest);
  c.mem[PARTY_Y_ZP] = destY(r, dest);
  c.mem[LOC_ID_ZP] = dest; c.mem[DEST_ID_ZP] = dest;
  const stub = [0x20, LOC_ENTRY_PC & 0xFF, LOC_ENTRY_PC >> 8, ...NMI_TRAMPOLINE];
  stub.forEach((b, i) => { c.mem[NMI_STUB_RAM + i] = b; });
  c.mem[NMI_VECTOR_RAM] = 0x4C;
  c.mem[NMI_VECTOR_RAM + 1] = NMI_STUB_RAM & 0xFF;
  c.mem[NMI_VECTOR_RAM + 2] = NMI_STUB_RAM >> 8;
  nes.frame();
  NMI_TRAMPOLINE.forEach((b, i) => { c.mem[NMI_VECTOR_RAM + i] = b; });
  for (let i = 0; i < frames; i++) nes.frame();
  return { nes, cpu: c, fb, x: c.mem[PARTY_X_ZP], y: c.mem[PARTY_Y_ZP],
           nt: [...nes.ppu.vramMem.slice(0x2000, 0x23C0)] };
}

/**
 * Warp to `loc` and return what the game decompressed.
 * `patch` is {fileOffset: byte} applied to an in-memory ROM copy first.
 */
export function warp(rom, snapshot, loc, { patch = null, frames = 24 } = {}) {
  const r = patch ? Uint8Array.from(rom) : rom;
  if (patch) for (const [off, val] of Object.entries(patch)) r[Number(off)] = val;

  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(Buffer.from(r).toString('binary'));
  nes.fromJSON(JSON.parse(snapshot));        // ⛔ this REPLACES nes.cpu
  nes.frame();
  const cpu = nes.cpu;

  let readTable = false, tilemapLive = null, mapAtReturn = null;
  const oE = cpu.emulate.bind(cpu);
  cpu.emulate = function () {
    const pc = (cpu.REG_PC + 1) & 0xFFFF;
    if (pc === LOC_TABLE_READ_PC) readTable = true;
    if (pc === LOADER_RETURN_PC && mapAtReturn === null)
      mapAtReturn = Buffer.from(cpu.mem.slice(MAP_RAM, MAP_RAM + MAP_RAM_LEN));
    const res = oE();
    if (pc === LOC_TABLE_READ_PC && tilemapLive === null) tilemapLive = cpu.REG_ACC;
    return res;
  };

  cpu.mem[LOC_ID_ZP] = loc & 0xFF;
  const stub = [0x20, ENTER_LOCATION_PC & 0xFF, ENTER_LOCATION_PC >> 8, ...NMI_TRAMPOLINE];
  stub.forEach((b, i) => { cpu.mem[NMI_STUB_RAM + i] = b; });
  cpu.mem[NMI_VECTOR_RAM] = 0x4C;
  cpu.mem[NMI_VECTOR_RAM + 1] = NMI_STUB_RAM & 0xFF;
  cpu.mem[NMI_VECTOR_RAM + 2] = NMI_STUB_RAM >> 8;

  nes.frame();                                       // one NMI -> one load
  NMI_TRAMPOLINE.forEach((b, i) => { cpu.mem[NMI_VECTOR_RAM + i] = b; });
  for (let i = 0; i < frames; i++) nes.frame();

  const map = mapAtReturn || Buffer.from(cpu.mem.slice(MAP_RAM, MAP_RAM + MAP_RAM_LEN));
  return {
    loc, readTable,
    capturedAtReturn: mapAtReturn !== null,
    tilemapLive,
    tilemap: tilemapOf(r, loc),
    hash: crypto.createHash('sha1').update(map).digest('hex').slice(0, 12),
    nonzero: map.filter(b => b !== 0).length,
    nes,
  };
}

/** Load the ROM + the in-game savestate the warp starts from. */
export function loadFixtures(romPath = process.env.FF2_ROM || '/home/joeltco/roms/ff2-jp.nes',
                             statePath = 'tools/states/ff2-outside.state.gz') {
  const rom = new Uint8Array(fs.readFileSync(romPath));
  const raw = fs.readFileSync(statePath);
  const snapshot = (raw[0] === 0x1f && raw[1] === 0x8b)
    ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
  return { rom, snapshot };
}
