// ff3-text.mjs — FF3's script, decoded. Shared by the dialogue tools.
//
// ── the string table ──────────────────────────────────────────────────────
// A global 2-byte pointer table at file 0x30010, indexed by string id. The
// high byte packs a bank in its top 3 bits:
//
//     bank = 0x18 + ((hi >> 5) & 7)
//     addr = ((hi & 0x1F) | 0x80) << 8 | lo
//     file = bank * 0x2000 + (addr - 0x8000) + 0x10
//
// (This scheme was already in `tools/text-decode.js`, which used it for item /
// monster / spell / job names. It works unchanged for dialogue.)
//
// ── the DTE table ─────────────────────────────────────────────────────────
// Bytes 0x29..0x5C are DUAL-TILE codes: one byte, two characters. The table is
// at 0x75FA1 and is stored as **two parallel 52-byte arrays** — all the first
// characters, then all the second characters — which is why searching for the
// pairs as adjacent bytes ("ed", "it") finds nothing and cost several attempts.
//
//     first  char of code c = rom[0x75FA1 + (c - 0x29)]
//     second char of code c = rom[0x75FA1 + 52 + (c - 0x29)]
//
// 52 entries, codes 0x29..0x5C inclusive — the ranges match exactly. Entry 30
// is "ed", which is what makes string 0x1E5 read "R{47} Mage" -> "Red Mage".
// A duplicate copy of the table sits at 0x7F4F1.
//
// Verified by decoding: "The party drank from the spring", "That earthquake
// buried the Crystal's altar. The world is ending!"

import fs from 'node:fs';

export const PTR_TABLE = 0x030010;
export const DTE_TABLE = 0x75FA1;
export const DTE_COUNT = 52;
export const DTE_FIRST = 0x29;

/** Dialogue occupies string ids 0..0x3FF; 0x400+ are item/spell/monster names. */
export const DIALOGUE_FIRST = 0x000;
export const DIALOGUE_LAST = 0x3FF;

// Punctuation and contractions outside the letter ranges. Derived from context
// while decoding ("It{a9} good" -> "It's good", "Wow{a5}great" -> "Wow, great").
const SYM = {
  0xA4: "'", 0xA5: ', ', 0xA9: "'s", 0xC0: '?', 0xC1: '. ', 0xC2: '-',
  0xC3: '!', 0xC4: '.', 0xC5: ',', 0xC6: '-', 0xC7: '/', 0xC8: ':', 0xC9: '!',
};

/** One byte -> its literal character, or null when it is not a plain glyph. */
export function glyph(b) {
  if (b >= 0x8A && b <= 0xA3) return String.fromCharCode(65 + (b - 0x8A));
  if (b >= 0xCA && b <= 0xE3) return String.fromCharCode(97 + (b - 0xCA));
  if (b >= 0x80 && b <= 0x89) return String.fromCharCode(48 + (b - 0x80));
  if (b === 0xFF) return ' ';
  if (SYM[b] !== undefined) return SYM[b];
  return null;
}

export function buildDte(rom) {
  const t = [];
  for (let i = 0; i < DTE_COUNT; i++) {
    const a = glyph(rom[DTE_TABLE + i]);
    const b = glyph(rom[DTE_TABLE + DTE_COUNT + i]);
    t.push((a === null ? '?' : a) + (b === null ? '?' : b));
  }
  return t;
}

export function stringOffset(rom, id) {
  const lo = rom[PTR_TABLE + id * 2], hi = rom[PTR_TABLE + id * 2 + 1];
  const bank = 0x18 + ((hi >> 5) & 7);
  const addr = (((hi & 0x1F) | 0x80) << 8) | lo;
  return bank * 0x2000 + (addr - 0x8000) + 0x10;
}

/**
 * Decode one string. `nl` is what a $01 line break becomes.
 * Unknown bytes come back as {xx} rather than being dropped — a decoder that
 * silently eats what it cannot read is how you ship a confident mistranslation.
 */
export function decodeString(rom, id, { nl = ' / ', max = 400 } = {}) {
  const dte = buildDte(rom);
  const off = stringOffset(rom, id);
  let s = '';
  for (let i = 0; i < max; i++) {
    const b = rom[off + i];
    if (b === undefined || b === 0x00) break;
    if (b === 0x01) { s += nl; continue; }
    if (b >= DTE_FIRST && b < DTE_FIRST + DTE_COUNT) { s += dte[b - DTE_FIRST]; continue; }
    const c = glyph(b);
    s += (c === null ? '{' + b.toString(16) + '}' : c);
  }
  return s.replace(/\s+/g, ' ').trim();
}

export function loadRom(p) {
  return new Uint8Array(fs.readFileSync(
    p || process.env.FF3_ROM || new URL('../../FF3-English.nes', import.meta.url).pathname));
}

/**
 * The name an NPC gives for ITSELF, or null.
 *
 * Only patterns where the character self-identifies count:
 *   "Topapa:I know..."                       -> speaker prefix
 *   "Nina, the adoptive mother of...:"       -> narrator label before a colon
 *   "Elder Topapa, the man who..."           -> title + name
 *
 * ⛔ "Takka is the finest blacksmith around" is someone talking ABOUT Takka —
 * that NPC is not Takka. Naming him Takka would invent a character, so
 * third-person mentions are deliberately NOT matched. FF1 had exactly this bug:
 * a loose "Name:" rule invented a character called "Oh" out of "Oh:: My
 * sister::" because FF1 writes an ellipsis as "::".
 */
export function selfName(text) {
  if (!text) return null;
  let m = /^([A-Z][a-z]+(?: [A-Z][a-z]+)?):/.exec(text);
  if (m) return m[1];
  m = /^([A-Z][a-z]+), (?:the|a) [^:]{0,60}:/.exec(text);
  if (m) return m[1];
  // ⛔ A TITLE + NAME ONLY COUNTS WITH ITS DESCRIPTIVE CLAUSE.
  // "Elder Topapa, the man who raised the four orphans." is a narrator label
  // introducing the speaker. Matching a bare "Princess Sara" instead names the
  // wrong NPC twice over — "Princess Sara.You're safe." is someone GREETING
  // her, and "Princess Sara wanted to see you guys" is someone talking ABOUT
  // her. Both were labelled «Sara» until the sheet was rendered and read.
  m = /^(?:Elder|King|Princess|Father) ([A-Z][a-z]+), (?:the|a) /.exec(text);
  if (m) return m[1];
  return null;
}
