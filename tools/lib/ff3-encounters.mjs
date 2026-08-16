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
// ── THE TOP TWO BITS OF THE COUNT BYTE — partially answered ──────────────────
//
// ⭐ BIT 6 IS LIVE. It is read at four sites, all with the same idiom (`ASL A`
// moves bit 6 into the sign, then a branch):
//
//   bank 46 $9D6B  LDA $7D68 / ASL A / BMI  -> clear: LDA #$20
//                                             set:   $7D73 & $1F vs 8, LDA #$28
//   bank 47 $A3AB  LDA $7D68 / ASL A / BMI  -> clear: JSR $A3B8 / JSR $A40B
//   bank 47 $B480  LDA $7D68 / ASL A / BPL  -> set:   JSR $BE97
//   bank 47 $BB88  LDA $7D68 / ASL A / BPL  -> set:   JSR $BEA4 / JMP $BB44
//
// and setting it really does change execution: a differential trace over 12.6M
// instructions parts control flow during encounter SETUP.
//
// ⛔ BUT ITS MEANING IS NOT DETERMINED, and this is where the chase was stopped.
// With bit 6 set on the freeroam zone the battle is byte-for-byte the same —
// same body count, same layout, same palettes, same framebuffer hash and the same
// 2792 lit pixels. The first divergence is a `BMI` on `$7ED8`, i.e. the flag has
// already propagated into other state by then, so naming it means following that
// chain rather than this one.
//
// ⚠ A HYPOTHESIS, explicitly NOT a measurement: the `#$20` / `#$28` constants
// (32 and 40) at $9D6B and the two different draw routines at $B480/$BB88 look
// like a monster SIZE or LAYOUT mode. That is a reading of the code, and this
// file does not record readings as facts.
//
// ⛔ (An earlier note here said bit 7 was probably unused. It is not — see the
// merge below. The claim was made from a site that masked the top nibble.)
// ⭐ WHERE THEY GO — followed to the byte they land in. Bank 46 $9F46:
//
//   $9F46  AD 68 7D  LDA $7D68
//   $9F49  4A x6     LSR A         ; the top TWO bits...
//   $9F4F  29 03     AND #$03
//   $9F51  0D D8 7E  ORA $7ED8
//   $9F54  8D D8 7E  STA $7ED8     ; ...merged into $7ED8
//
// and measured end to end, patching the zone's count byte and reading $7ED8 back
// out of a live encounter:
//
//   0x07 (neither) -> $7ED8 = 0x00
//   0x47 (bit 6)   -> $7ED8 = 0x80     ; ⭐ count bit 6 -> $7ED8 BIT 7
//   0x87 (bit 7)   -> $7ED8 = 0x01     ; ⭐ count bit 7 -> $7ED8 BIT 0
//   0xC7 (both)    -> $7ED8 = 0x81
//
// ⭐ So bit 7 IS used after all — the earlier "no evidence it is read" was wrong,
// and it was wrong because the only site I had found masked the top nibble. It
// travels; it just travels through $7ED8 rather than being tested in place.
//
// $7ED8 bit 7 is then what `BMI $886E` at bank 52 $880A tests, skipping a
// percentage roll (`LDA #$64 / JSR $A564 / CMP $28 / BCS / INC $2A`).
//
// ⭐ AND THE ROLL IS THE AMBUSH / PRE-EMPTIVE CONTEST. `$2A` and `$2B` are two
// tallies, rolled against each other at bank 52 $8830:
//
//   $8830  JSR $886F / STA $29     ; a per-side value
//   $8835  LDA #$64 / JSR $A564    ; random 0..100
//   $883A  CMP $29 / BCS $8840
//   $883E  INC $2B                 ; one side scores
//   $8840  INC $2A                 ; the other tally always advances
//   $8844  LDA $2B / CMP $2A       ; compare them
//   $8848  BEQ $886E               ; tie      -> an ordinary battle
//   $884A  BCS $8852               ; $2B > $2A -> the party is AMBUSHED
//   $884C  INC $78BA               ; $2B < $2A -> the party's advantage
//
// ⭐ Measured by forcing each outcome (patching `LDA $2B` to an immediate):
//
//   $2B > $2A -> the screen says "Ambushed.", the party loses a free round
//                (HP 118 -> 103) and $78C3 = 0x80
//   $2B < $2A -> $78BA = 1, no message, no HP lost
//   tie       -> nothing
//
// ⭐⭐ SO BIT 6 MEANS "THIS FORMATION IS NEVER PART OF A SURPRISE". With bit 6
// set the `BMI $886E` skips the contest outright, and even a FORCED ambush does
// not happen — party HP untouched at 118, $78C3 = 0x00, no message. With bit 7
// set instead the ambush still fires, so it is bit 6 specifically.
//
// ⛔ BIT 7 remains unexplained. It reaches $7ED8 bit 0, and bit 0 is not what
// gates the contest (bit 7 is). Bounded, not identified.
export const COUNT_FLAG_BIT6 = 0x40;
export const COUNT_FLAG_BIT7 = 0x80;
export const COUNT_BIT6_TEST_SITES = [0x5DD7B, 0x5E3BB, 0x5F490, 0x5FB98];
/** Where the two flag bits are merged, and where they end up. */
export const FLAG_MERGE_FILE = 0x5DF56;    // bank 46, CPU $9F46
export const FLAG_DEST = 0x7ED8;
/** count byte -> the $7ED8 value it produces, measured live. */
export const FLAG_DEST_VALUES = { 0x00: 0x00, 0x40: 0x80, 0x80: 0x01, 0xC0: 0x81 };
/** The exact instruction sequence that does the merge. */
export const FLAG_MERGE_BYTES = [0xAD, 0x68, 0x7D, 0x4A, 0x4A, 0x4A, 0x4A, 0x4A, 0x4A,
                                 0x29, 0x03, 0x0D, 0xD8, 0x7E, 0x8D, 0xD8, 0x7E];
/** ⭐ Count-byte bit 6 = "no surprise": the ambush/pre-emptive contest is skipped. */
export const COUNT_FLAG_NO_SURPRISE = 0x40;
/** The ambush contest's two tallies, and where its verdict lands. */
export const AMBUSH_TALLY_A = 0x2A, AMBUSH_TALLY_B = 0x2B;
export const AMBUSH_FLAG = 0x78C3, AMBUSH_FLAG_SET = 0x80;   // party was ambushed
export const PREEMPT_FLAG = 0x78BA;                          // party's advantage
/** `LDA $2B` immediately before the compare — patch it to force an outcome. */
export const AMBUSH_CMP_FILE = 0x68854;

// ── THE TWO HEADER BYTES ARE PALETTE INDICES ─────────────────────────────────
//
//   $9E28  LDX #$03 / JSR $F8EA      ; index * 3
//   $9E33  ADC #$8C / STA $83        ; pointer = $8C00 + index*3
//   $9E3F  LDA ($82),Y / STA $7F,X   ; copy the THREE colours
//
// The table at `$8C00` (bank 46, file 0x5CC10) is 256 entries of 3 bytes, and
// ⭐ EVERY ONE of those 768 bytes is <= 0x3F — a valid NES colour. The entries
// read like palettes too: `00 10 13`, `00 10 16`, `00 10 17`.
//
// ⭐ Confirmed against the hardware. Patching each header byte writes a different
// PPU palette, and the bytes written ARE the table entry:
//
//   byte 0 = 0x00 -> $3F01..$3F03 = 00 10 13   (entry 0)
//   byte 0 = 0x0F -> $3F01..$3F03 = 02 12 16   (entry 15)
//   byte 1 = 0x00 -> $3F05..$3F07 = 00 10 13
//   byte 1 = 0x0F -> $3F05..$3F07 = 02 12 16
//
// So byte 0 is BG palette 0 and byte 1 is BG palette 1 — and FF3 draws battle
// monsters as BG tiles, so these are the FORMATION'S MONSTER PALETTES. That is
// why formations sharing monsters share a header (records 1-3 all `35 5e`).
//
// ⛔ The framebuffer is what settled it. A nametable hash showed NOTHING — not
// even for the control that swaps the species — so it could not have supported
// any conclusion. Hashing the drawn frame shows every header value changing the
// image while the LIT-PIXEL COUNT stays at exactly 1753: the same silhouette in
// different colours, which is the signature of a palette and not of a sprite.
export const PALETTE_TABLE = 0x05CC10;     // bank 46, CPU $8C00
export const PALETTE_STRIDE = 3;
export const PALETTE_ENTRIES = 256;
export const PALETTE_MAX_COLOUR = 0x3F;
/** Header byte 0 -> BG palette 0, byte 1 -> BG palette 1. */
export const HEADER_PPU_SLOTS = [0x3F01, 0x3F05];
export const paletteOf = (rom, idx) => [...rom.slice(
  PALETTE_TABLE + idx * PALETTE_STRIDE, PALETTE_TABLE + (idx + 1) * PALETTE_STRIDE)];

/** 6 bytes per formation: 2 header PALETTE INDICES, then 4 species ids. */
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

// ── ENCOUNTER_SET: zone -> (species record, count pattern) ───────────────────
//
//   $A02A  LDA $7CED / STA $7E      ; a 16-bit ZONE id
//   $A02F  LDA $7CEE / STA $7F
//   $A034  ASL $7E / ROL $7F        ; zone * 2
//   $A041  ADC #$80                 ; pointer = $8000 + zone*2
//   $A047  LDA ($7E),Y / STA $7D67  ; byte 0 = the SPECIES record index
//   $A04D  LDA ($7E),Y / STA $7D68  ; byte 1 = the COUNT index (+ 2 flag bits)
//   $A052  LDA $7D67 / LDX #$06 / JSR $F8EA    ; index * 6 -> the species record
//
// ⭐ So an entry is a PAIR of indices, and that is why the species record and the
// count record are looked up at different offsets — they are chosen separately.
// Verified by patching entry 0 of the freeroam zone:
//
//   byte 0 = 6 -> Zombie      byte 1 = 0 -> 1 Goblin
//   byte 0 = 7 -> Mummy       byte 1 = 2 -> 3 Goblins
//   byte 0 = 3 -> Eye Fang, a THREE-species record (ids 2,3,1)
//   byte 1 = 3 -> 4 Goblins
//
// ⭐ And COUNT_TABLE turns out to be a shared library of count PATTERNS rather
// than per-formation data — index 0 is 1..1, 1 is 2..2, 2 is 3..3, 3 is 4..4,
// 6 is 1..2, 7 is 2..4 (the freeroam zone), 9 is 4..8.
export const ENCOUNTER_SET = 0x05C010;
export const ENCOUNTER_SET_ENTRIES = 512;
export const ENCOUNTER_SET_STRIDE = 2;
export const ZONE_ID_ZP = 0x7CED;          // 16-bit, little-endian
export const SPECIES_INDEX_ZP = 0x7D67;
/** ⛔ The top TWO bits of byte 1 survive the `AND #$3F` — purpose unidentified. */
export const COUNT_INDEX_FLAG_BITS = 0xC0;
export const setEntry = (rom, zone) => [
  rom[ENCOUNTER_SET + zone * ENCOUNTER_SET_STRIDE],
  rom[ENCOUNTER_SET + zone * ENCOUNTER_SET_STRIDE + 1]];

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
