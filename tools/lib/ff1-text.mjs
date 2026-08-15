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
// ── NPCs — from the disassembly of the map-load routine ───────────────────
// $E7FB  LDA $48        ; <- $0048 IS the current map id
//        ASL/ROL x4     ; mapId * 16 (16-bit)
//        ...            ; *2 then + itself  => mapId * 48
//        ADC #$B4       ; + $B400
//        LDA #$00 / JSR $FE03   ; switch to BANK 0
// $E824  LDA ($1C),Y    ; read the object TYPE
// $E82C  ADC #$03       ; 3 bytes per entry
// $E7F3  LDA #$0F       ; <- FIFTEEN slots, always
//
// So: 15 slots of 3 bytes per map at file 0x3410, stride 48.
//
// ⛔ FIFTEEN, not sixteen, and a zero type is NOT a terminator — the loader
// reads all 15 regardless.
// ⛔ BOTH coordinate bytes are masked with #$3F ($E85C and $E866); bits 6-7 of
// each are flags. The X mask is observable — 108 of 287 objects have high bits
// there. The Y mask is NOT: no object in this ROM has bit 6 or 7 set in byte 2,
// so masking it changes nothing. It is applied because the code applies it, and
// the gate does not pretend to test it.
//
// ── objType -> sprite ─────────────────────────────────────────────────────
//     sprite ROM offset = 0xA210 + SPRITE_TABLE[objType] * 0x100
//
// The table is at file 0x2E10 (CPU $AE00, bank 0). MEASURED: patching every
// object on a map to one type and reading which single sprite the PPU loads
// gives objType -> entry directly, with no alignment assumption. Six such
// probes (types 49, 32, 63, 100, 150, 200) yield exactly ONE table in the
// whole ROM that reproduces them, and it then predicts the unpatched map's
// ten objects 10/10. All 182 placed types resolve to entries 18-47 — exactly
// the NPC half of the 48-entry bank (0-17 are the player classes/vehicles).
//
// ── objType -> dialogue ───────────────────────────────────────────────────
// From the talk path, traced by hooking the string-pointer fetch and walking
// the stack back ($DB71 <- $D4B1 <- $CA03 <- $902B in bank 14):
//
//   $902B  LDA $6F00,X    ; the object's TYPE, out of the RAM object array
//          ASL A / ASL A  ; type * 4
//          ADC #$D5 ...   ; + $95D5
//   $9046  LDA ($14),Y    ; four bytes
//   $9059  ...            ; JMP ($0016) into a per-type handler
//                         ; (jump table $90D3 for type<128, $91D3 for >=128)
//
// So each type has a FOUR-BYTE entry at CPU $95D5 in bank 14 = file 0x395E5:
//
//     [0] a game-flag / condition index
//     [1] the dialogue id shown by default     <- this is the line you hear
//     [2] the dialogue id after that event
//     [3] usually 0
//
// The per-type handler chooses between [1] and [2] on a flag, so there is no
// single "the" id — but [1] is the first line an NPC gives you.
//
// MEASURED: a Coneria Castle guard displayed string 49, and type 32's entry is
// (18, 49, 50, 0). Decoding [1] for whole maps comes out location-coherent:
// map 8 is Coneria Castle (King / LUTE / Queen locked inside), map 2 is ElfLand
// (Save our Prince / Astos / Dark Elf), map 12 is the Temple of Fiends past.
//
// ── ⛔ dialogueId is NOT objType ──────────────────────────────────────────
// An earlier version of this file claimed it was. That was WRONG, and the
// "confirmation" was a coincidence: talking in Coneria Castle produced string
// 49, and some map happened to contain an object of type 49.
//
// Coneria Castle is map 8 (read out of $0048). Its object types are
// 32,34,35,37,38,41,42,44,46 — whose strings are about Bahamut, a submarine
// and Garland, nonsense for that castle. And patching every map-8 object to
// type 100 still made a talk fetch string 120, not 100.
//
// The TEXT decoding below is unaffected and still verified against the screen
// (string 49 is exactly the line the game displayed). The real link is the
// four-byte table above.

import fs from 'node:fs';

export const PTR_TABLE = 0x28010;
export const TEXT_BANK = 0x28010;
export const DTE_SECOND = 0x3F060;
export const DTE_FIRST_CH = 0x3F0B0;
export const DTE_COUNT = 80;
export const DTE_FIRST = 0x1A;
export const MAPOBJ_TABLE = 0x3410;
export const MAPOBJ_PER_MAP = 15;      // LDA #$0F — fifteen, and zero is not a terminator
export const MAPOBJ_STRIDE = 48;
/** objType -> sprite index; ROM offset = SPRITE_BASE + v * 0x100. */
export const SPRITE_TABLE = 0x2E10;
export const SPRITE_BASE = 0xA210;
export const MAP_ID_ADDR = 0x0048;     // RAM: the current map
/** Four bytes per objType: [flag, defaultStringId, afterStringId, 0]. */
export const DIALOGUE_TABLE = 0x395E5;

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

// ── objType -> dialogue, confirmed off the CPU ────────────────────────────
//
// `tools/ff1-talk-trace.mjs` hooks every cartridge read and catches the talk
// path in bank 14:
//
//   $902B  LDA $6F00,X          ; the object TYPE (X = live object slot)
//   $9034  ASL A / ROL $15      ; type * 2, SIXTEEN-BIT (the table spans pages)
//   $9037  ASL A / ROL $15      ; type * 4
//   $903A  ADC #$D5 / LDA #$95  ; + $95D5  ->  file 0x395E5
//   $9046  LDA ($14),Y ...      ; all FOUR record bytes -> $10 $11 $12 $13
//   $9059  LDA $16 / ASL A / TAY
//   $906C  LDA $90D3,Y / $90D4,Y / JMP ($0016)    ; a per-type CODE HANDLER
//
// ⛔ Like FF2, the id is data but WHICH byte gets used is code. The two common
// handler shapes:
//
//   $941B  LDY $10 / JSR $9091      ; test the story flag in byte 0
//          BCS -> LDA $12           ; flag set  -> the "after" line
//          LDA $11 / RTS            ; flag clear -> byte 1   <- THE DEFAULT
//   $9492  LDA $11 / RTS            ; unconditional: always byte 1
//
// So byte 1 is the DEFAULT line — what a fresh game shows — and byte 2 is the
// post-flag line. Nothing static can resolve which one a mid-game player sees.

/** $90D3 in bank 14: 2 bytes per objType -> that type's dialogue handler. */
export const BANK14 = 0x38010;
export const HANDLER_TABLE = BANK14 + (0x90D3 - 0x8000);
/** Address of the per-type handler routine (for disassembly). */
export const handlerForType = (rom, type) => {
  const e = HANDLER_TABLE + type * 2;
  return rom[e] | (rom[e + 1] << 8);
};
/** The unconditional handler — `LDA $11 / RTS`, ignores flag and after-line. */
export const HANDLER_PLAIN = 0x9492;
/** The flag-gated handler — byte 0 is a flag id, byte 2 the post-flag line. */
export const HANDLER_FLAGGED = 0x941B;

/** The four-byte dialogue record for an object type: [flag, default, after, x]. */
export const dialogueRecordForType = (rom, type) =>
  [0, 1, 2, 3].map(k => rom[DIALOGUE_TABLE + type * 4 + k]);
/** The string id an object type says by default (record byte 1). */
export const dialogueForType = (rom, type) => rom[DIALOGUE_TABLE + type * 4 + 1];

/** The sprite ROM offset an object type wears. */
export const spriteOffsetForType = (rom, type) => SPRITE_BASE + rom[SPRITE_TABLE + type] * 0x100;
/** The 0..47 bank index, for cross-checking against a PPU trace. */
export const spriteEntryForType = (rom, type) => rom[SPRITE_TABLE + type] + 18;

/**
 * The 15 object slots of one map: {type, x, y, inRoom, still, sprite}.
 * Both coords are masked with $3F — bits 6-7 of each byte are flags.
 */
export function mapObjects(rom, mapId) {
  const base = MAPOBJ_TABLE + mapId * MAPOBJ_STRIDE;
  const out = [];
  for (let i = 0; i < MAPOBJ_PER_MAP; i++) {
    const t = rom[base + i * 3], xb = rom[base + i * 3 + 1], yb = rom[base + i * 3 + 2];
    if (!t) continue;                  // skip empties, but do NOT stop: see header
    out.push({
      slot: i, type: t, x: xb & 0x3F, y: yb & 0x3F,
      inRoom: !!(xb & 0x80), still: !!(xb & 0x40),
      sprite: rom[SPRITE_TABLE + t] + 18,
      spriteOffset: SPRITE_BASE + rom[SPRITE_TABLE + t] * 0x100,
      dialogueId: rom[DIALOGUE_TABLE + t * 4 + 1],
      dialogueAfter: rom[DIALOGUE_TABLE + t * 4 + 2],
    });
  }
  return out;
}

export const loadRom = (p) =>
  new Uint8Array(fs.readFileSync(p || process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes'));
