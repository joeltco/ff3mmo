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

/** NPC dialogue lives in its own bank; 0x28010 holds names + keywords. */
export const DIALOGUE_TABLE = 0x18010;
/** {type, x, y} x 12 per map. Two blocks — see the header. */
export const MAPOBJ_BLOCKS = [{ base: 0x3510, maps: 17 }, { base: 0x3990, maps: 32 }];
export const MAPOBJ_PER_MAP = 12;
/** 0x18 N -> string (0x100 | N) from PTR_TABLE. */
export const INSERT_CODE = 0x18;

/** 45 kana — no を; 0xB6 is ん. See the header. */
export const HIRAGANA = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわん';
export const KATAKANA = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン';

// ── the sub-0x8A codes are NOT a dictionary ───────────────────────────────
// They are more CHARACTERS: dakuten and handakuten kana, in four contiguous
// blocks. Seven values had already been derived from context independently
// (0x3D=ぎ, 0x3E=ぐ, 0x49=で, 0x4B=ば, 0x5A=ダ, 0x5D=デ, 0x69=パ) and this
// layout reproduces all seven.
const BLOCKS = [
  [0x3C, 'がぎぐげござじずぜぞだぢづでどばびぶべぼ'],   // hiragana dakuten
  [0x50, 'ガギグゲゴザジズゼゾダヂヅデドバビブベボ'],   // katakana dakuten
  [0x64, 'ぱぴぷぺぽ'],                                  // hiragana handakuten
  [0x69, 'パピプペポ'],                                  // katakana handakuten
];

// Small kana and punctuation, each derived from context in the script:
//   っ  "かぎが かかっている"      ゃ  "じゃくてん"     ゅ  "きゅうに"
//   ょ  "もんしょう"               を  "…のを みた"
//   ッ  "スコット"                 ュ  "カシュオーン"   ィ  "ミシディア"
//   「  always follows a speaker-name insert, and the screen shows it
const SYM = {
  0x7B: 'を', 0x7C: 'っ', 0x7D: 'ゃ', 0x7E: 'ゅ', 0x7F: 'ょ',
  0xB7: 'ァ', 0xB8: 'ィ', 0xBA: 'ェ', 0xBB: 'ォ',
  0xBC: 'ッ', 0xBD: 'ャ', 0xBE: 'ュ', 0xBF: 'ョ',   // ャ from ジャイアントビーバー
  0xB9: '「', 0xC1: '。', 0xC2: 'ー', 0xC3: '…', 0xC4: '!', 0xC5: '?',
  0x78: '【', 0x79: '】',
  0x01: '\n',
};

// Digits, same slot as FF1 and FF3. "しろの{81}かい" is a floor number.
for (let i = 0; i <= 9; i++) SYM[0x80 + i] = String.fromCharCode(48 + i);

const DAKUTEN = (() => {
  const m = {};
  for (const [base, run] of BLOCKS) [...run].forEach((c, i) => { m[base + i] = c; });
  return m;
})();

export function glyph(b) {
  if (DAKUTEN[b] !== undefined) return DAKUTEN[b];
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

/** Raw bytes of a string in table `T`. */
export function rawString(rom, T, id, max = 220) {
  const p = rom[T + id * 2] | (rom[T + id * 2 + 1] << 8);
  if (p < 0x8000 || p >= 0xC000) return null;
  const off = T + (p - 0x8000);
  const out = [];
  for (let i = 0; i < max; i++) {
    const b = rom[off + i];
    if (b === undefined || b === 0x00) break;
    out.push(b);
  }
  return out;
}

/** A string with every known glyph resolved (unknown codes dropped). */
export function plainString(rom, T, id) {
  const b = rawString(rom, T, id) || [];
  let s = '';
  for (const x of b) { const c = glyph(x); if (c !== null) s += c; }
  return s;
}

/** Literal kana of a string, codes dropped — used for matching against screen text. */
export function skeleton(rom, T, id) {
  const b = rawString(rom, T, id) || [];
  let s = '';
  for (const x of b) { const c = glyph(x); if (c && c !== ' ') s += c; }
  return s;
}

/** Decode an NPC line, expanding 0x18 N name/keyword inserts as 【…】. */
export function decodeLine(rom, id, { table = DIALOGUE_TABLE, nl = ' / ' } = {}) {
  const b = rawString(rom, table, id);
  if (!b) return '';
  let s = '';
  for (let i = 0; i < b.length; i++) {
    if (b[i] === INSERT_CODE && i + 1 < b.length) {
      // Insert the name PLAIN. The script supplies its own 【 】 (0x78/0x79)
      // around keyword inserts; speaker-name inserts have none. Adding a pair
      // here double-bracketed every keyword.
      s += plainString(rom, PTR_TABLE, 0x100 | b[i + 1]); i++; continue;
    }
    if (b[i] === 0x01) { s += nl; continue; }
    const c = glyph(b[i]);
    s += (c === null ? '{' + b[i].toString(16) + '}' : c);
  }
  return s.trim();
}

/** The 12 object slots of one map, as {slot,type,x,y}. */
export function mapObjects(rom, base, mapIndex) {
  const o = base + mapIndex * MAPOBJ_PER_MAP * 3;
  const out = [];
  for (let i = 0; i < MAPOBJ_PER_MAP; i++) {
    const t = rom[o + i * 3];
    if (!t) break;                       // lists are packed: a zero ends them
    out.push({ slot: i, type: t, x: rom[o + i * 3 + 1] & 0x3F, y: rom[o + i * 3 + 2] });
  }
  return out;
}
