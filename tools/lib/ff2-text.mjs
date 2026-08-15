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
// Sub-0x8A codes are NOT a dictionary — they are more characters (dakuten and
// handakuten kana, see BLOCKS below). Mean literal coverage is ~95%; anything
// still unresolved prints as {xx} rather than being guessed at.
//
// The objType -> dialogue link is SOLVED (v1.8.32) by disassembling the talk
// routine — see `stringIdForType`. ⛔ It is NOT `dialogueId == objType`; that
// shipped as "verified" in v1.8.26 and was retracted in v1.8.31.

import fs from 'node:fs';

export const PTR_TABLE = 0x28010;
export const TEXT_BANK = 0x28010;

/**
 * The LOW string table (bank 6). Object types below 0x60 read this one.
 *
 * ⛔ NOT indexed by object type. v1.8.26 shipped `dialogueId == objType` as
 * verified; it was FALSE and was retracted in v1.8.31 — the same
 * coincidence-as-rule failure as FF1's. Hilda is object type 1 and does say
 * string 1, so the very first thing anyone checks agrees. Minwu is object
 * type 8 and says string 49. See `stringIdForType` for the real rule.
 */
export const DIALOGUE_TABLE = 0x18010;
/** The HIGH string table (bank 10). Object types 0x60..0xBF read this one. */
export const DIALOGUE_TABLE_HI = 0x28010;

// ── objType -> dialogue, SOLVED by disassembly (v1.8.32) ──────────────────
//
// Found with `tools/ff2-talk-trace.mjs`: hook every cartridge read, talk to
// Minwu, and catch the instruction that reads his string pointer. That landed
// on the generic fetch routine at $EA8C ($92 = string id, $93 = bank,
// $94/$95 = table base), so the question became "who writes $92". Watching
// zero-page writes answered it: `$CBD0 JSR $9794` returns the id in A.
//
//   $9794 (bank 14):
//     LDA #$06 / STA $93          ; default bank 6
//     LDA #$00 / STA $94
//     LDA #$80 / STA $95          ; default table base $8000  -> file 0x18010
//     LDA $7500,X                 ; the object TYPE (X = object slot)
//     CMP #$C0 / BCS $97FE        ; >= 0xC0 -> RTS, no handler
//     CMP #$60 / BCC +            ; >= 0x60 -> LDX #$0A / STX $93  (bank 10)
//     ASL A / TAX                 ; type * 2
//     LDA $8200,X / $8201,X       ; -> $84/$85, a POINTER PER OBJECT TYPE
//     LDY #$17 / LDA ($84),Y / STA $7B00,Y ...   ; copy a 24-byte RECORD
//     LDA $A0 / ASL A / TAY
//     LDA $9923,Y / $9924,Y / JMP ($0086)        ; per-type CODE handler
//
// Each type then runs its own handler, e.g. Minwu's at $9C82:
//     LDY #$50 / JSR $989E        ; test a story flag
//     BNE (alternate line)
//     LDA $7B00                   ; <- byte 0 of the record IS the string id
//     RTS                         ; caller does STA $92
//
// So the default line is `record[0]`, and the handler picks a different byte
// of the record once story flags are set. ⛔ That means an NPC's line is
// STATE-DEPENDENT — `record[0]` is the line before any flag is set, which is
// what a fresh game shows, and is all a static tool can report.

/** Bank 14 holds both the record-pointer table and the handler jump table. */
export const BANK14 = 0x38010;
const b14 = (addr) => BANK14 + (addr - 0x8000);
/** $8200 in bank 14: 2 bytes per objType -> pointer to a 24-byte record. */
export const RECORD_PTR_TABLE = b14(0x8200);
/** $9923 in bank 14: 2 bytes per objType -> the type's code handler. */
export const HANDLER_TABLE = b14(0x9923);
/** Types at or above this read the HIGH table in bank 10 (CMP #$60). */
export const HI_TABLE_FIRST = 0x60;
/** Types at or above this get no handler at all (CMP #$C0 / BCS -> RTS). */
export const NO_HANDLER_FIRST = 0xC0;

/** File offset of an object type's 24-byte record, or null. */
export function recordOffsetForType(rom, type) {
  if (type >= NO_HANDLER_FIRST) return null;
  const e = RECORD_PTR_TABLE + type * 2;
  const a = rom[e] | (rom[e + 1] << 8);
  if (a < 0x8000 || a > 0xBFFF) return null;   // not a bank-14 window address
  return b14(a);
}

/** Address of the per-type handler routine (for disassembly), or null. */
export function handlerForType(rom, type) {
  if (type >= NO_HANDLER_FIRST) return null;
  const e = HANDLER_TABLE + type * 2;
  return rom[e] | (rom[e + 1] << 8);
}

/** Which string table an object type reads. */
export const tableForType = (type) =>
  type >= NO_HANDLER_FIRST ? null
    : type >= HI_TABLE_FIRST ? DIALOGUE_TABLE_HI : DIALOGUE_TABLE;

/**
 * The string an object type says with NO story flags set, as `{id, table}`.
 *
 * ⛔ This is the DEFAULT line only. The per-type handler swaps in other bytes
 * of the record as the story advances, so a late-game player sees something
 * else. Nothing static can resolve those.
 */
export function stringIdForType(rom, type) {
  const rec = recordOffsetForType(rom, type);
  if (rec === null) return null;
  return { id: rom[rec], table: tableForType(type) };
}

/** The default line an object type says, decoded. '' when it has no handler. */
export function lineForType(rom, type, opts = {}) {
  const s = stringIdForType(rom, type);
  return s ? decodeLine(rom, s.id, { table: s.table, ...opts }) : '';
}

/**
 * The speaker a string names, or null. FF2 writes one as `NAME「…」`, 0xB9
 * being the opening quote.
 *
 * ⛔ THE NAME IS WRITTEN TWO WAYS and a detector must take both:
 *     Hilda  -> 18 EF B9 …   a 0x18 name INSERT
 *     Minwu  -> E9 F6 CC B9  LITERAL KANA (ミンウ)
 * Only handling the insert form silently drops Minwu, Paul, Josef and the rest
 * — the sheet showed their lines but left them unnamed.
 *
 * ⛔ 【…】 MID-line are ASK/LEARN keywords, not speakers: "【ヒルダ】さまに
 * はけんされてきた?" is a guard talking ABOUT Hilda. Requiring the quote in the
 * OPENING position is what separates the two.
 */
export function speakerOfString(rom, table, id, maxLen = 8) {
  const raw = rawString(rom, table, id);
  if (!raw) return null;
  const q = raw.indexOf(0xB9);
  if (q < 1) return null;
  const head = raw.slice(0, q);
  // a name runs unbroken up to the quote: no space, no newline, no 【 】
  if (head.some(b => b === 0xFF || b === 0x01 || b === 0x78 || b === 0x79)) return null;
  let name = '';
  for (let i = 0; i < head.length; i++) {
    if (head[i] === INSERT_CODE && i + 1 < head.length) {
      name += plainString(rom, PTR_TABLE, 0x100 | head[i + 1]); i++; continue;
    }
    const c = glyph(head[i]);
    if (c === null) return null;      // a control code in the name = not a name
    name += c;
  }
  return name.length >= 2 && name.length <= maxLen ? name : null;
}

/** The speaker of an object type's DEFAULT line, or null. */
export function speakerForType(rom, type) {
  const s = stringIdForType(rom, type);
  return s ? speakerOfString(rom, s.table, s.id) : null;
}
// ── map objects: ONE table, not two blocks ────────────────────────────────
//
// CONFIRMED from the CPU (bank 0, $9E15):
//   ASL A / ASL A          ; mapId * 4
//   ASL A / ROL $81  x3    ; mapId * 32
//   ADC $80                ; 32x + 4x = mapId * 36
//   LDA $81 / ADC #$B5     ; + $B500  ->  file 0x3510
//   LDY #$23 / LDA ($80),Y / STA $0780,Y   ; copy 36 bytes = 12 objects x 3
//
// ⛔ THIS REPLACES the old `MAPOBJ_BLOCKS = [{0x3510,17},{0x3990,32}]` model.
// There is no second block: 0x3990 is simply map 32 (0x3990-0x3510 = 32*36).
// That model read maps 0-16 and 32-63 and SKIPPED maps 17-31 entirely — 79
// objects, plus everything past map 63. Corrected in v1.8.39.
export const MAPOBJ_TABLE = 0x3510;
export const MAPOBJ_STRIDE = 36;
export const MAPOBJ_PER_MAP = 12;
/**
 * How many maps the table holds.
 *
 * ⛔ NOT read from code — the loader takes whatever map id it is given. This is
 * the extent over which the data still satisfies the Y <= 63 invariant: maps
 * 0-69 are all clean and 70+ break. Treat it as a measured bound, not a
 * constant the game enforces.
 */
export const MAPOBJ_MAPS = 70;
/** 0x18 N -> string (0x100 | N) from PTR_TABLE. */
export const INSERT_CODE = 0x18;

/**
 * objType -> sprite.  ROM offset = SPRITE_BASE + SPRITE_TABLE[objType] * 0x100.
 *
 * MEASURED the same way as FF1's: patch every object on the Altair throne room
 * (block 0x3510, map 4) to ONE type, boot in, and read which single sprite the
 * PPU loads. Five clean probes (types 1, 8, 13, 97, 150 -> entries 20, 14, 16,
 * 37, 30) leave exactly ONE table in the whole ROM that reproduces them.
 *
 * It then predicts that map's seven objects 7/7 against a PPU trace captured
 * before any of this was known.
 *
 * ⛔ 0xD10 sits in a region of mostly-small bytes that an early structural scan
 * dismissed as a trivial match. Structure did not find it; measurement did.
 */
export const SPRITE_TABLE = 0xD10;
export const SPRITE_BASE = 0x9B10;
export const spriteOffsetForType = (rom, type) => SPRITE_BASE + rom[SPRITE_TABLE + type] * 0x100;
/** 0..47 index into the 0x9010 bank, for cross-checking a PPU trace. */
export const spriteEntryForType = (rom, type) => rom[SPRITE_TABLE + type] + 11;

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

/**
 * Decode the string at `id`, expanding 0x18 N name/keyword inserts.
 *
 * ⛔ `id` is a STRING id, not an object type — see DIALOGUE_TABLE.
 */
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

/** The 12 object slots of one map, as {slot,type,x,y,...}. */
export function mapObjects(rom, mapId) {
  const o = MAPOBJ_TABLE + mapId * MAPOBJ_STRIDE;
  const out = [];
  for (let i = 0; i < MAPOBJ_PER_MAP; i++) {
    const t = rom[o + i * 3];
    if (!t) break;                       // lists are packed: a zero ends them
    const say = stringIdForType(rom, t);
    out.push({
      slot: i, type: t, x: rom[o + i * 3 + 1] & 0x3F, y: rom[o + i * 3 + 2],
      sprite: rom[SPRITE_TABLE + t] + 11,
      spriteOffset: SPRITE_BASE + rom[SPRITE_TABLE + t] * 0x100,
      // ⛔ the DEFAULT line only — the per-type handler swaps in other bytes of
      // the record once story flags are set. null = objType >= 0xC0, no handler.
      stringId: say ? say.id : null,
      stringTable: say ? say.table : null,
    });
  }
  return out;
}

// ── map -> NPC palette, traced off the CPU ────────────────────────────────
//
//   $9D52  LDA $48 / LSR A x4 / ORA #$A0 / STA $81   ; high byte
//          LDA $48 / ASL A x4                        ; low  -> $A000 + mapId*16
//   $9D3C  LDA ($80),Y / TAY                         ; a palette INDEX
//   $9D3F  LDA $8E00,Y / STA $03C0,X                 ; colour 1
//   $9D45  LDA $8E80,Y / STA $03C1,X                 ; colour 2
//   $9D4B  LDA $8F00,Y / STA $03C2,X                 ; colour 3
//
// So FF2 has THREE PARALLEL COLOUR TABLES — the same shape as FF3's
// 0x1110/0x1210/0x1310 — indexed by a 16-byte list the map owns.
//
// Which list entry feeds which PPU slot, MEASURED against the live $03C0
// buffer in the Altair throne room (map 4), 5/5 exact:
//   BG 0/1/2 = list[1], list[2], list[3]
//   NPC top    (sprite palette 2) = list[4]
//   NPC bottom (sprite palette 3) = list[5]
// ⛔ BG 3 is the hardcoded menu palette ($9D2E writes $03CD-$03CF directly) and
// sprite palettes 0/1 are the PARTY's — neither comes from the map.

const b0 = (addr) => 0x10 + (addr - 0x8000);       // bank 0
export const PAL_COLOR_TABLES = [b0(0x8E00), b0(0x8E80), b0(0x8F00)];
export const PAL_LIST_TABLE = b0(0xA000);
export const PAL_LIST_SIZE = 16;
/** Which entry of a map's list feeds the NPC's top / bottom half. */
export const PAL_LIST_NPC_TOP = 4, PAL_LIST_NPC_BTM = 5;

/** A palette from its index: colour 0 is the backdrop, 1-3 come from the tables. */
export const paletteForIndex = (rom, i) =>
  [0x0F, ...PAL_COLOR_TABLES.map(t => rom[t + i])];

/** A map's 16-byte palette index list. */
export const paletteListForMap = (rom, mapId) =>
  [...rom.slice(PAL_LIST_TABLE + mapId * PAL_LIST_SIZE,
                PAL_LIST_TABLE + (mapId + 1) * PAL_LIST_SIZE)];

/** The two palettes an NPC wears on a map, as `{top, btm}`. */
export function npcPalettesForMap(rom, mapId) {
  const list = paletteListForMap(rom, mapId);
  return {
    top: paletteForIndex(rom, list[PAL_LIST_NPC_TOP]),
    btm: paletteForIndex(rom, list[PAL_LIST_NPC_BTM]),
  };
}

// ⛔ `globalMapId` is gone. It existed to paper over the two-block model, and
// its second-block guess (17) was wrong anyway — 0x3990 is map 32. Map ids are
// now just map ids.
