// ff3-encounters.mjs — FF3's encounter FORMATION tables, measured.
//
// The addresses were floating around `tools/monscan/*.cjs` as bare literals with
// no account of what the bytes mean. This is what the game actually does with
// them, traced through the expander that builds a battle.
//
// ── THE EXPANDER (bank 47, $A064 onward) ─────────────────────────────────────
//
//   $A064  LDY #$00
//   $A066  LDA ($7E),Y / STA $7D69,Y / INY / CPY #$06 / BNE   ; SIX bytes
//
// so a formation RECORD is 6 bytes, landing at $7D69: two header bytes then the
// FOUR SPECIES IDS at $7D6B..$7D6E, `0xFF` meaning "no species here".
//
//   $A08B  LDA $7D68 / AND #$3F      ; the COUNT index — only 6 bits
//   $A096  ASL / ROL (x2)            ; ...times 4
//   $A0A7  ADC #$8A                  ; pointer = $8A00 + idx*4
//   $A0AD  LDA ($7E),Y / STA $7D6F,Y / INY / CPY #$04 / BNE   ; FOUR bytes
//
// so the COUNTS are a separate 4-byte record — one per species slot — and each
// raw byte is then resolved:
//
//   $A0B9  LDA $7D6F,X / JSR $A0C8 / STA $7D6F,X
//   $A0C8  ... AND #$F0 / LSR x4 / TAX   ; X = HIGH nibble
//          ... AND #$0F / JSR $FBEF      ; A = LOW nibble
//   $FBEF  random in [X, A]; if A is 0 or A == X, just X
//
// ⭐ SO THE COUNT BYTE IS NIBBLE-PACKED: high = MIN, low = MAX, rolled per
// battle. Verified by patching the live record and counting bodies on the field:
//
//   0x24 (the natural value)  -> 2      0x33 -> 3
//   0x11 -> 1                           0x44 -> 4
//   0x00 -> no battle at all
//
// ⛔ THE TWO INDICES ARE NOT THE SAME. Captured live, the species record came
// from index 0 while the count record came from `$7D68 & 0x3F` = 7. Patching
// `COUNT_TABLE + 0*4` therefore does nothing and looks like the table is inert —
// which is exactly the wrong conclusion an earlier pass drew from it.
//
// ⛔ NOT identified: the two header bytes of the species record (`0x89 0xA0` for
// the freeroam formation), what `ENCOUNTER_SET` selects, and how either index is
// chosen. Recorded as unknown rather than guessed.

/** 6 bytes per formation: 2 header, then 4 species ids. */
export const SPECIES_TABLE = 0x05C410;
export const SPECIES_STRIDE = 6;
export const SPECIES_ID_OFF = 2;
export const SPECIES_SLOTS = 4;
export const SPECIES_EMPTY = 0xFF;

/** 4 bytes per index: one nibble-packed min/max count per species slot. */
export const COUNT_TABLE = 0x05CA10;
export const COUNT_STRIDE = 4;
export const COUNT_INDEX_MASK = 0x3F;      // $A08E AND #$3F
export const COUNT_INDEX_ZP = 0x7D68;      // the byte it is taken from

/** ⛔ Purpose not identified — 2 bytes x 512, and contiguous with SPECIES_TABLE. */
export const ENCOUNTER_SET = 0x05C010;
export const ENCOUNTER_SET_ENTRIES = 512;

/** Where the expander leaves its work. */
export const RAM_RECORD = 0x7D69;          // 6 bytes
export const RAM_SPECIES = 0x7D6B;         // 4 ids
export const RAM_COUNTS = 0x7D6F;          // 4 resolved counts

export const speciesOf = (rom, f) => [...rom.slice(
  SPECIES_TABLE + f * SPECIES_STRIDE + SPECIES_ID_OFF,
  SPECIES_TABLE + f * SPECIES_STRIDE + SPECIES_ID_OFF + SPECIES_SLOTS)];
export const headerOf = (rom, f) => [...rom.slice(
  SPECIES_TABLE + f * SPECIES_STRIDE, SPECIES_TABLE + f * SPECIES_STRIDE + SPECIES_ID_OFF)];
export const countsOf = (rom, i) => [...rom.slice(
  COUNT_TABLE + i * COUNT_STRIDE, COUNT_TABLE + (i + 1) * COUNT_STRIDE)];
/** A raw count byte as the game reads it: [min, max]. */
export const countRange = (b) => [(b >> 4) & 0x0F, b & 0x0F];
