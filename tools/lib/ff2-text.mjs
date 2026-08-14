// ff2-text.mjs — FF2 (JP) kana, decoded.
//
// ── the encoding ──────────────────────────────────────────────────────────
// Calibrated off the game's OWN verb menu in Altair, which reads
// たずねる / おぼえる / アイテム (ask / learn / item) and renders as tile
// indices 99 96 a1 b2 / 8e a7 8d b2 / ca cb dc ea. That fixes:
//
//     hiragana  = 0x8A + i        katakana = 0xCA + i        space = 0xFF
//
// Same shape as FF1 (A-Z at 0x8A) and FF3 (a-z at 0xCA) — one engine family.
//
// ⛔ The kana run is 45 long, NOT the usual 46: there is no を. Byte 0xB6 is
// ん. The text proves it — 0xB6 appears mid-word in はんらん ("rebellion")
// and さくせんかいぎ ("strategy meeting"), where を is impossible.
//
// ── the string table ──────────────────────────────────────────────────────
// 2-byte little-endian pointers at file 0x28010 — the SAME offset as FF1.
// Text lives in the same bank: file = 0x28010 + (addr - 0x8000).
//
// ── what is NOT decoded ───────────────────────────────────────────────────
// Bytes below 0x8A are a dictionary and are left as {xx}. About 78% of the
// script is literal kana without it. Some codes are single dakuten kana
// (0x49 = で, 0x3D = ぎ, 0x3E = ぐ, 0x69 = パ, derived from context), so it is
// NOT a uniform two-character DTE the way FF1's and FF3's are, and no table
// has been located. Codes are printed as {xx} rather than guessed.
//
// FF2's map-object table has NOT been found either — it is not at FF1's
// 0x3410 (332 of 569 entries there decode to Y > 63, i.e. nonsense), so there
// is no NPC -> dialogue link for FF2 yet.

import fs from 'node:fs';

export const PTR_TABLE = 0x28010;
export const TEXT_BANK = 0x28010;

/** 45 kana — no を; 0xB6 is ん. See the header. */
export const HIRAGANA = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわん';
export const KATAKANA = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン';

const SYM = { 0xC1: '。', 0xC0: '、', 0x01: '\n' };

export function glyph(b) {
  if (b >= 0x8A && b < 0x8A + HIRAGANA.length) return HIRAGANA[b - 0x8A];
  if (b >= 0xCA && b < 0xCA + KATAKANA.length) return KATAKANA[b - 0xCA];
  if (b === 0xFF) return ' ';
  if (SYM[b] !== undefined) return SYM[b];
  return null;
}

export const stringPtr = (rom, id) => rom[PTR_TABLE + id * 2] | (rom[PTR_TABLE + id * 2 + 1] << 8);

export function decodeString(rom, id, { nl = ' / ', max = 200 } = {}) {
  const p = stringPtr(rom, id);
  if (p < 0x8000 || p >= 0xC000) return '';
  const off = TEXT_BANK + (p - 0x8000);
  let s = '';
  for (let i = 0; i < max; i++) {
    const b = rom[off + i];
    if (b === undefined || b === 0x00) break;
    const c = glyph(b);
    if (c === '\n') { s += nl; continue; }
    s += (c === null ? '{' + b.toString(16) + '}' : c);
  }
  return s.trim();
}

/** Fraction of a string that decoded to real kana — how much to trust it. */
export function literalRatio(rom, id) {
  const p = stringPtr(rom, id);
  if (p < 0x8000 || p >= 0xC000) return 0;
  const off = TEXT_BANK + (p - 0x8000);
  let lit = 0, tot = 0;
  for (let i = 0; i < 200; i++) {
    const b = rom[off + i];
    if (b === undefined || b === 0x00) break;
    tot++; if (glyph(b) !== null) lit++;
  }
  return tot ? lit / tot : 0;
}

export const loadRom = (p) =>
  new Uint8Array(fs.readFileSync(p || process.env.FF2_ROM || '/home/joeltco/roms/ff2-jp.nes'));
