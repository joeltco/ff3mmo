// ff1-map.mjs — FF1's map, collision, doors and tile specials, as the CPU does it.
//
// Single source for the FF1 probe tools. Every constant here was read out of
// the running game, and the listing that proves it is quoted next to it — none
// of this is inferred from the shape of the data.
//
// ⛔ Do NOT re-derive any of this inside a tool. Four separate copies of FF3's
// `calcSpawnY` is exactly how this project learned that lesson.

// ── where things live ────────────────────────────────────────────────────────
export const MAP_RAM = 0x7000;          // the loaded 64x64 map, one byte per tile
export const MAP_W = 64, MAP_H = 64;
export const PROP_RAM = 0x0400;         // tile properties, TWO bytes per tile
export const PLAYER_X = 0x68, PLAYER_Y = 0x69;   // tile coords on a normal map
export const WORLD_X = 0x27, WORLD_Y = 0x28;     // ...but the OVERWORLD uses these
export const MAP_ID = 0x48;

// $CBBE builds the map address as $7000 + y*64 + x:
//   LDA $15 / LSR x2 / ORA #$70          -> high byte
//   LDA $15 / ROR x3 / AND #$C0 / ORA $14 -> low byte
//   LDY #$00 / LDA ($10),Y
export const tileAt = (mem, x, y) => mem[MAP_RAM + (y & 63) * MAP_W + (x & 63)];

// $CBD5  ASL A / TAY / LDA $0400,Y -> $44   ; prop0
//                     LDA $0401,Y -> $45   ; prop1
// The table is in RAM because it is loaded per TILESET, so read it live rather
// than resolving a ROM address — that way it is right for whatever map is up.
export const prop0 = (mem, x, y) => mem[PROP_RAM + tileAt(mem, x, y) * 2];
export const prop1 = (mem, x, y) => mem[PROP_RAM + tileAt(mem, x, y) * 2 + 1];

// ── collision ────────────────────────────────────────────────────────────────
// The PLAYER-MOVE check is $CA76, found by diffing the executed-PC sets of a
// blocked and a successful move from the same tile:
//   $CA79  JSR $CAA2 / BCS $CA9A     ; an earlier refusal (objects)
//   $CA7E  JSR $CBBE                 ; fetch properties -> $44/$45
//   $CA81  LDA $44 / AND #$1F
//   $CA85  CMP #$01 / BEQ $CA9A      ; BLOCKED
//   $CA89  AND #$1E / TAX
//   $CA8C  LDA $CDA1,X / STA $10 / LDA $CDA2,X / STA $11
//   $CA96  TXA / JMP ($0010)         ; per-terrain handler, entered with A = X
//
// ⛔ NOT the routine at $CBE2, whose mask is the `AND #$C2` at $CBEF. It also
// reads the tile properties, and an earlier pass mistook its mask for the
// collision rule — but it disagrees with reality: tile 0x38 (prop0 0x01) is
// blocked though 0x01 & 0xC2 == 0, and tile 0x44 (prop0 0x80) is passable
// though 0x80 & 0xC2 != 0. Both are exactly right under (prop0 & 0x1F) == 1.
export const BLOCK_MASK = 0x1F, BLOCK_VALUE = 0x01;
export const isBlocked = (mem, x, y) => (prop0(mem, x, y) & BLOCK_MASK) === BLOCK_VALUE;
export const isWalkable = (mem, x, y) => !isBlocked(mem, x, y);

/** $CA89 AND #$1E — the index into the terrain-handler table at $CDA1. */
export const HANDLER_MASK = 0x1E;
export const HANDLER_TABLE = 0xCDA1;
export const terrainType = (mem, x, y) => prop0(mem, x, y) & HANDLER_MASK;

/**
 * Which handler a tile dispatches to, measured from the table at $CDA1:
 *   0 -> $CE51 (plain floor: CLC / RTS)      4 -> $CE53 (door)
 *   2 -> $CE53 (door)                        6 -> $CE44 (door close)
 * Anything >= 8 is a different family ($CDC1 / $CDE4 ...).
 */
export const HANDLER_DOOR_OPEN = [2, 4];
export const HANDLER_DOOR_CLOSE = 6;

// ── $0D is the DOOR byte, NOT an inside/outside flag ─────────────────────────
// This is the correction to the earlier `altLayer` guess. The whole byte is a
// door-animation request:
//
//   $CE53 (open)   LSR A / AND #$03        ; A entered as prop0 & $1E, so this
//                                          ; is (prop0 >> 1) & 3 = the variant
//         $CE65    ASL $0D                 ; ⚠ for the CARRY ONLY (old bit 7);
//         $CE67    STA $0D                 ;   the ASL result is overwritten
//         $CE69    BCS +                   ; already open -> skip the sound
//                  JSR $CF1E               ; $400C/$400E/$400F = NOISE channel:
//                                          ; this is the door SFX, not a redraw
//   $CE44 (close)  LDA $0D / BPL +         ; only if a door IS open (bit 7)
//                  EOR #$84 / STA $0D / JSR $CF1E
//   $CEBB (draw)   LDA $0D / BEQ + / BMI + ; nothing pending / already drawn
//                  AND #$07                ; 1 -> tile $37 + state $81
//                                          ; 2 -> tile $37 + state $82
//                                          ; 5 -> tile $36 + state $00
//                                          ; else tile $3B + state $00
//         $CEE8    STA $0D
//         $CEEA    LDA $2002 / $0F,$0E -> $2006   ; poke it into the nametable
//   $C901          LDA #$00 / STA $0D      ; cleared when the tile special fires
//
// So bit 7 is an "already serviced" guard that makes the draw idempotent, and
// bits 0-2 pick the door graphic. Bit 0 is merely the low bit of that 3-bit
// field — it carries no inside/outside meaning. MEASURED: 0 outdoors in a town,
// 0 standing in a shop, and 1 only for the few frames a door is opening.
export const DOOR_STATE = 0x0D;
export const DOOR_SERVICED = 0x80;      // bit 7 — tested via ASL -> carry, or BMI
export const DOOR_VARIANT_MASK = 0x07;
export const doorVariantFor = (p0) => (p0 >> 1) & 0x03;   // $CE53 LSR / AND #$03
export const DOOR_TILE_BY_VARIANT = { 1: 0x37, 2: 0x37, 5: 0x36 };
export const DOOR_TILE_DEFAULT = 0x3B;

// ── tile specials (shops, inns, teleports) ───────────────────────────────────
// $CEB0  LDA $45 / BEQ +        ; prop1 == 0 -> this tile does nothing
//        STA $51                ; prop1 IS the special id
//        INC $50                ; ...and $50 means "a special is pending"
// $C8E5  LDA $50 / BNE $C8FE    ; the pending branch runs it ($CB94 ...)
//
// ⛔ prop1 is NOT an index into the overworld destination tables at
// $AC00/$AC20/$AC40. Those are indexed by the OVERWORLD entrance id, which is a
// different space: Coneria town's door carries prop1 = 12, and 12 is the ARMOR
// SHOP (measured — the shop drew "ARMOR / Welcome / Buy / Sell / Exit"), not
// "map 11" as that table would claim. Resolving prop1 through it prints
// confident nonsense.
export const SPECIAL_PENDING = 0x50;
export const SPECIAL_ID = 0x51;

/**
 * What each special id opens, MEASURED — `tools/ff1-warp.mjs --sweep 0,79`
 * drives the game's own request for every id and reads the shop's own banner
 * back off the nametable. Nothing here is named from a guess about the layout;
 * the label is the word the game drew.
 *
 * The bands are contiguous and each holds one instance per town, so the id
 * both picks the KIND of shop and which town's stock it sells.
 *
 * ⛔ Id 0 resolves to WEAPON when forced, but never occurs in play: prop1 == 0
 * is the "this tile does nothing" short-circuit at $CEB0, so a real tile can
 * only carry 1..70. Above 70 the sweep returns repeats — off the end of the
 * table, not more shops.
 */
export const SPECIAL_BANDS = [
  { lo: 0, hi: 9, kind: 'WEAPON' },
  { lo: 10, hi: 20, kind: 'ARMOR' },
  { lo: 21, hi: 30, kind: 'WMAGIC' },
  { lo: 31, hi: 40, kind: 'BMAGIC' },
  { lo: 41, hi: 50, kind: 'CLINIC' },
  { lo: 51, hi: 60, kind: 'INN' },
  { lo: 61, hi: 69, kind: 'ITEM' },
  { lo: 70, hi: 70, kind: 'OASIS' },
];
export const SPECIAL_ID_MAX = 70;
export function specialKind(id) {
  const b = SPECIAL_BANDS.find(b => id >= b.lo && id <= b.hi);
  return b ? b.kind : null;      // null = off the end of the table
}

// The overworld ENTRANCE tables, caught by hooking the reads that feed the
// write to $48 during an overworld -> map transition. Bank 0; file offsets
// include the 16-byte iNES header.
export const ENTRANCE_X = 0x2C10;       // CPU $AC00
export const ENTRANCE_Y = 0x2C30;       // CPU $AC20
export const ENTRANCE_MAP = 0x2C50;     // CPU $AC40
export const entranceFor = (rom, idx) =>
  ({ x: rom[ENTRANCE_X + idx], y: rom[ENTRANCE_Y + idx], map: rom[ENTRANCE_MAP + idx] });

// ── encounters (partly decoded — read the warning) ───────────────────────────
// prop1's BIT 7 is what separates a dungeon's encounter floor from a tile that
// opens something. The shop path only ever sees prop1 < 0x80:
//
//   $CDC3  LDA $45 / BPL $CDDC   ; prop1 < $80 -> not an encounter tile
//   $CDC7  JSR $C571 / CMP $F8   ; ...else roll against the encounter rate
//   $CDCE  LDA $48 / CLC / ADC #$40 / JSR $C54A   ; formation, selected BY MAP
//
//   $C54A  LDY #$10 / STY $11
//   $C54E  ASL A / ROL $11  (x3) ; => ($11:$10) = $8000 + (map + $40) * 8
//   $C559  LDA #$0B / JSR $FE03  ; bank 11
//   $C562  LDA $F100,X / AND #$3F / TAX
//   $C568  LDY $C58C,X           ; a weight table picks one of eight
//   $C56B  LDA ($10),Y / STA $6A ; the encounter GROUP id
//
// So each map has EIGHT group ids at bank 11, file 0x2C010 + (map + 0x40) * 8.
//
// ⛔ INCOMPLETE. `$6A` is a GROUP, not a monster — the hop from group to the
// monster ids at $6BC9 is still undecoded. Patching a map's eight bytes does NOT
// change which monster appears (tested on map 16, whose entry is all zeros
// anyway), so this is a decoded chain with a missing link, not a working lever.
export const ENCOUNTER_TABLE = (map) => 0x10 + 11 * 0x4000 + (map + 0x40) * 8;
export const ENCOUNTER_SLOTS = 8;
export const ENCOUNTER_TILE_BIT = 0x80;   // $CDC5 BPL — prop1 bit 7

// ── objects ──────────────────────────────────────────────────────────────────
// NPCs block movement, so pathfinding has to treat their live tiles as walls.
export const OBJ_RAM = 0x6F00, OBJ_STRIDE = 0x10, OBJ_SLOTS = 16;
export function objectTiles(mem) {
  const s = new Set();
  for (let i = 0; i < OBJ_SLOTS; i++) {
    const b = OBJ_RAM + i * OBJ_STRIDE;
    if (!mem[b]) continue;                   // slot empty / not spawned
    s.add(`${mem[b + 2]},${mem[b + 3]}`);
  }
  return s;
}
