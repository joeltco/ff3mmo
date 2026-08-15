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
// ── map objects, RE-DERIVED from the CPU ──────────────────────────────────
//
//   $E7F3  LDA #$0F / STA $1B      ; FIFTEEN slots
//   $E7FB  LDA $48 / ASL A x4      ; mapId * 16
//   $E80D  ASL $1C / ROL $1D       ; mapId * 32
//   $E812  ADC $1C                 ; 16x + 32x  =  mapId * 48
//   $E819  ADC #$B4                ; + $B400  ->  file 0x3410 (bank 0)
//   $E824  LDA ($1C),Y             ; the object TYPE
//   $E82C  ADC #$03                ; 3 bytes per entry
//   $E836  DEC $1B / BNE           ; exactly 15 — a zero is NOT a terminator
//
// ⛔ 15 slots x 3 = 45 bytes, but the STRIDE IS 48. Bytes 45-47 of each map are
// DEAD — the loader never reaches them. Three maps have leftover object data
// there (28, 30, 31: all type 87), so reading 16 slots injects 3 phantom NPCs.
// This was checked because FF2's "two blocks" turned out to be one table; here
// the existing model held up.
export const MAPOBJ_TABLE = 0x3410;
export const MAPOBJ_PER_MAP = 15;      // LDA #$0F — fifteen, and zero is not a terminator
export const MAPOBJ_STRIDE = 48;
/**
 * How many maps the table holds.
 *
 * ⛔ NOT enforced in code — the loader takes whatever `$48` holds. 64 is fixed
 * two independent ways: every map 0-63 keeps its raw Y byte within the #$3F
 * mask while ALL of 64-127 exceed it, and `0x3410 + 64*48 = 0x4010`, which is
 * exactly the end of bank 0.
 */
export const MAPOBJ_MAPS = 64;

// ── the X/Y flag bits, read off the loader ────────────────────────────────
//
//   $E84D  LDA ($1C),Y / STA $16   ; the X byte, raw
//   $E851  AND #$C0 / STA ($1E),Y  ; object+1 = FLAGS (bits 6-7)
//   $E85C  AND #$3F / STA ($1E),Y  ; object+2 = X  (bits 0-5)
//   $E864  LDA $17 / AND #$3F      ; the Y byte -> object+3 and +5
//
// ⛔ THE Y BYTE HAS NO FLAGS. Its top two bits are masked off and never stored
// anywhere — the game DISCARDS them. (The old note said only that no object
// sets them, which is a fact about the data; this is a fact about the code, and
// it means data could set them and nothing would happen.)
export const FLAG_LAYER = 0x80;   // bit 7 — see below
export const FLAG_STILL = 0x40;   // bit 6
export const COORD_MASK = 0x3F;

// bit 6 (FLAG_STILL) — MEASURED at $E51F:
//     LDA $6F01,X / AND #$40 / ORA $6F0C,X / BEQ + / RTS
//   set -> the update routine returns early and the object skips that work.
//   "does not move" is supported by the code.
//
// bit 7 (FLAG_LAYER) — MEASURED at $E6D8:
//     LDA $0D / AND #$01 / BEQ E6E5
//     LDA $6F01,X / BMI E6EA   ; $0D.0 set + bit7 set   -> proceed
//                  / BPL E72C  ; $0D.0 set + bit7 clear -> skip
//     LDA $6F01,X / BMI E72C   ; $0D.0 clear + bit7 set -> skip
//                              ; $0D.0 clear + bit7 clear -> proceed
//   The object is processed ONLY when bit 7 EQUALS $0D bit 0 — a layer match
//   against a global player state.
//
// ⛔ THE FIELD WAS CALLED `inRoom`. That name is RETRACTED (v1.8.43): it was
// never derived from anything, and everything since measured argues against it
// (`tools/ff1-flag0d-probe.mjs`):
//   * `$0D` bit 0 is **0 in every reachable state** — castle courtyard, castle
//     interior, overworld — so bit-7 objects are never processed there at all.
//   * It does NOT flip while walking, and does NOT flip across a map transition
//     (overworld -> Coneria Castle). "Inside a room" would have to.
//   * It is not frame parity either: `$0D` reads 0 for 24 consecutive frames.
//   * `$0D` is PUSHED/POPPED alongside `$48`, the map id ($C95C-$C964 /
//     $C991-$C998); it is ASL'd at $CE65, EOR #$84 at $CE48, cleared at $C20D /
//     $C70E / $C903, and written inside the PPU nametable routines. It behaves
//     like a BITFIELD of engine state, not a boolean.
//
// So the field is named for the MECHANISM: the object belongs to the alternate
// layer selected by `$0D` bit 0. ⛔ What that layer IS remains UNDETERMINED.
//
// ── what $0D turned out to be (v1.8.44) ───────────────────────────────────
// `$0D` is a MULTI-PURPOSE engine byte, not a layer flag:
//   * $CEBB dispatches its LOW THREE BITS as a small enum —
//       LDA $0D / BEQ (nothing) / BMI (nothing) / AND #$07 /
//       CMP #$01 / CMP #$02 / CMP #$05 -> three handlers, then it is CLEARED.
//     So it is a PENDING-REQUEST code, and "bit 0" is just odd-vs-even request.
//   * every other bank-15 writer CLEARS it ($C20D, $C70E, $C903), shifts it
//     ($CE67 ASL), toggles bits 7 and 2 ($CE48 EOR #$84), or restores it from
//     the stack next to the map id ($C998 PLA).
//   * NO observed bank-15 path SETS bit 0, and it measured 0 in every reachable
//     state. Forcing it to 1 for 90 frames changed nothing on screen (the engine
//     simply set bit 7 too, leaving $0D = 0x81).
//
// ⛔ So bit-7 objects were NEVER OBSERVED to be processed. Whether they are
// dead data or wait on a state we could not reach is still open. Settling it
// needs a savestate somewhere `$0D` bit 0 is genuinely 1 — see the note in
// `tools/ff1-flag0d-probe.mjs` about why that could not be produced.
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
 * The 15 object slots of one map: {type, x, y, altLayer, still, sprite}.
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
      altLayer: !!(xb & FLAG_LAYER), still: !!(xb & FLAG_STILL),
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

// ── map -> palette set, decoded off the CPU ───────────────────────────────
//
//   $CC49  LDA $48 / ASL A x4       ; $10/$11 = mapId * 16
//   $CC55  LDX $11                  ; save the HIGH byte of mapId*16
//   $CC57  ASL $10 / ROL $11        ; $10/$11 = mapId * 32
//   $CC5C  ADC $10 / TXA / ADC $11  ; 16x + 32x = mapId * 48
//   $CC63  ORA #$A0                 ; -> $A000 + mapId*48   (bank 0)
//   $CC69  LDA ($10),Y / STA $0780,Y  (0x30 bytes)
//   $D8AD  LDA $0780,X / STA $03C0,X  (0x20)   $D880 -> $2007 every frame
//
// ⛔ X is NOT a palette selector — it is the carry-high of mapId*16, held so the
// two halves can be summed. The set index IS THE MAP ID. Confirmed by capturing
// the pointer on two entries: map 8 -> $A180, map 24 -> $A480.
export const PALETTE_TABLE = 0x10 + (0xA000 - 0x8000);   // bank 0, file 0x2010
export const PALETTE_SET_SIZE = 0x30;                    // $CC6F: CPY #$30

/** The 48-byte palette set a map loads. */
export const paletteSetForMap = (rom, mapId) =>
  [...rom.slice(PALETTE_TABLE + mapId * PALETTE_SET_SIZE,
                PALETTE_TABLE + (mapId + 1) * PALETTE_SET_SIZE)];

/**
 * The two palettes an NPC wears on a map, as `{top, btm}` of 4 NES colours.
 *
 * MEASURED off OAM: the top half draws on sprite palette 2 and the bottom on
 * palette 3 (the player takes 0 and 1). Sprite palettes are set bytes 16..31.
 */
export function npcPalettesForMap(rom, mapId) {
  const s = paletteSetForMap(rom, mapId);
  return { top: s.slice(24, 28), btm: s.slice(28, 32) };
}
