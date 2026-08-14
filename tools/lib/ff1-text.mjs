// ff1-text.mjs — FF1's script and its NPCs, decoded.
//
// ── the encoding ──────────────────────────────────────────────────────────
// Calibrated off the game's OWN class-select menu, which reads FIGHTER /
// THIEF / Bl.BELT / RedMAGE. "FIGHTER" renders as tile indices
// 8f 92 90 91 9d 8e 9b, which fixes:
//
//     A-Z = 0x8A + i      a-z = 0xA4 + i      space = 0xFF
//
// (Nametable tile index == character code, the same trick that cracked FF3.)
//
// ── the string table ──────────────────────────────────────────────────────
// A 2-byte little-endian pointer table at file 0x28010 — the SAME offset FF2
// uses, which is what you would expect from one engine family. Pointers are
// NES addresses in $8000-$BFFF and the text lives in the same bank, so
//
//     file = 0x28010 + (addr - 0x8000)
//
// ── the DTE table ─────────────────────────────────────────────────────────
// Bytes 0x1A..0x69 are one byte, two characters. 80 entries stored as two
// parallel arrays — and FF1 puts them in the OPPOSITE order to FF3:
//
//     second chars @ 0x3F060      first chars @ 0x3F0B0
//
// Every "pairs" and "firsts-then-seconds" search fails because of that
// reversal. It was found by deriving 16 codes from a single line read off the
// running game, then searching for each half independently with a
// delta-invariant match.
//
// The derivation: string 0x31's bytes aligned against the box the game
// actually displayed —
//     "The King is looking for the LIGHT WARRIORS. You do not happen to be
//      them, do you?"
// which forces 0x1a="e ", 0x1c="th", 0x1f="in", 0x26="ou", 0x41="ha", …
//
// ── NPCs ──────────────────────────────────────────────────────────────────
// Each map has 16 object slots of 3 bytes at file 0x3410 (bank 0, CPU $B400):
// type, X (bits 0-5; bit 7 = in a room, bit 6 = does not move), Y. Verified:
// all 290 placed objects have Y <= 63.
//
//     dialogueId == objType        (exactly, 1:1)
//
// Confirmed by talking to a Coneria Castle guard in the running game and
// getting string 49, which is object type 49 on map 0. Map 0 then reads as a
// coherent castle cast (Honor Guard, the Queen locked inside, the LUTE) and
// map 1's object 4 is Garland.

import fs from 'node:fs';

export const PTR_TABLE = 0x28010;
export const TEXT_BANK = 0x28010;
export const DTE_SECOND = 0x3F060;
export const DTE_FIRST_CH = 0x3F0B0;
export const DTE_COUNT = 80;
export const DTE_FIRST = 0x1A;
export const MAPOBJ_TABLE = 0x3410;
export const MAPOBJ_PER_MAP = 16;

const SYM = {
  0xBF: ',', 0xC0: '.', 0xC2: '!', 0xC3: ':', 0xC4: "'", 0xC5: '?', 0xBE: "'",
  0x05: '\n', 0x01: '', 0x02: '', 0x03: '',
};

export function glyph(b) {
  if (b >= 0x8A && b <= 0xA3) return String.fromCharCode(65 + (b - 0x8A));
  if (b >= 0xA4 && b <= 0xBD) return String.fromCharCode(97 + (b - 0xA4));
  if (b >= 0x80 && b <= 0x89) return String.fromCharCode(48 + (b - 0x80));
  if (b === 0xFF) return ' ';
  if (SYM[b] !== undefined) return SYM[b];
  return null;
}

export function buildDte(rom) {
  const t = [];
  for (let i = 0; i < DTE_COUNT; i++) {
    const a = glyph(rom[DTE_FIRST_CH + i]);
    const b = glyph(rom[DTE_SECOND + i]);
    t.push((a === null ? '?' : a) + (b === null ? '?' : b));
  }
  return t;
}

export const stringPtr = (rom, id) => rom[PTR_TABLE + id * 2] | (rom[PTR_TABLE + id * 2 + 1] << 8);

/** Decode string `id`. Unknown bytes come back as {xx} rather than dropped. */
export function decodeString(rom, id, { nl = ' / ', max = 260 } = {}) {
  const dte = buildDte(rom);
  const p = stringPtr(rom, id);
  if (p < 0x8000 || p >= 0xC000) return '';
  const off = TEXT_BANK + (p - 0x8000);
  let s = '';
  for (let i = 0; i < max; i++) {
    const b = rom[off + i];
    if (b === undefined || b === 0x00) break;
    if (b >= DTE_FIRST && b < DTE_FIRST + DTE_COUNT) { s += dte[b - DTE_FIRST]; continue; }
    const c = glyph(b);
    if (c === '\n') { s += nl; continue; }
    s += (c === null ? '{' + b.toString(16) + '}' : c);
  }
  return s.replace(/\s+/g, ' ').trim();
}

/** The 16 object slots of one map: {type, x, y, inRoom, still}. */
export function mapObjects(rom, mapId) {
  const base = MAPOBJ_TABLE + mapId * MAPOBJ_PER_MAP * 3;
  const out = [];
  for (let i = 0; i < MAPOBJ_PER_MAP; i++) {
    const t = rom[base + i * 3], xb = rom[base + i * 3 + 1], y = rom[base + i * 3 + 2];
    if (!t) continue;
    out.push({ slot: i, type: t, x: xb & 0x3F, y, inRoom: !!(xb & 0x80), still: !!(xb & 0x40) });
  }
  return out;
}

export const loadRom = (p) =>
  new Uint8Array(fs.readFileSync(p || process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes'));
