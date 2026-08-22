// ff3-map-encounters.mjs — WHICH monsters a given MAP fights, from the ROM.
//
// `ff3-encounters.mjs` decoded everything downstream of the choice: $7CED holds
// a formation id, ENCOUNTER_SET turns it into a species record and a count
// pattern. What was missing was the step BEFORE — how a map picks that id — so
// every zone in `src/data/encounters.js` was hand-authored.
//
// ⛔ It is NOT a map property byte. All 16 were decoded as formation ids and
// checked against species; the two that appeared to match were the tileset byte
// and the song byte. Traced on the CPU instead (`tools/ff3-zone-trace.mjs`).
//
// ── THE INDOOR PATH (bank 61, $BDB9) ────────────────────────────────────────
//
//   $BDBD  JSR $C711 / CMP $F8 / BCS      ; random(0..255) < $F8 -> fight
//   $BDC9  LDX $48                        ; ⭐ $48 IS THE MAP ID
//   $BDCB  LDA $78 / BNE $BDDA
//   $BDCF  LDA $92F0,X                    ; ⭐ map -> encounter GROUP  (maps 0-255)
//   $BDDA  LDA $93F0,X                    ; ⭐ ...and maps 256-511
//   $BDD2  JSR $BD4D
//
// ── THE GROUP (bank 61, $BD4D) ──────────────────────────────────────────────
//
//   $BD4D  LDY #$00 / STY $81
//   $BD51  ASL A / ROL $81   (x3)         ; group * 8
//   $BD5B  ADC #$F0 / STA $80
//   $BD61  ADC #$94 / STA $81             ; ⭐ pointer = $94F0 + group*8
//   $BD65  INC $F7 / LDX $F7
//   $BD69  LDA $FE00,X / AND #$3F / TAX   ; random 0..63
//   $BD6F  LDY $BD78,X                    ; ⭐ 64-byte WEIGHT table -> slot 0..7
//   $BD72  LDA ($80),Y / STA $6A          ; the formation id
//
// ⭐ So a GROUP is EIGHT formation ids and the slot is drawn from a fixed
// distribution — 12/12/12/12/6/6/3/1 out of 64. Slot 7 is a 1-in-64 rarity.
//
// ── THE WORLD MAP (bank 61, $BCD1) ──────────────────────────────────────────
//
//   $BCD1  LDA $78 / BNE $BD07            ; $78 = which world
//   $BCD5  LDX $42 / BEQ $BCE6            ; $42 = vehicle mode; 0 = on foot
//   $BCE6  LDA $27 +7 AND #$7F LSR x5     ; x region 0..3
//   $BCF4  LDA $28 +7 AND #$60 LSR x3     ; y region 0,4,8,12
//   $BD00  TAX / LDA $9CF0,X              ; ⭐ world 0: a 4x4 REGION GRID
//   $BD44  LDA $9D00,X                    ; ⭐ world 3: an 8x8 grid (256-wide map)
//
// `src/world-map-loader.js` loads world 0 at MAP_SIZE 128, so the 4x4 grid over
// 32-tile regions is the one this game is on.
//
// ── THE RATE (bank 63, $E8AA — runs at MAP LOAD) ────────────────────────────
//
//   $E8AA  LDX $48 / LDA $78 / BEQ
//   $E8B6  LDA $BE00,X / STA $F8          ; ⭐ per-map encounter rate, /256 per check
//   $E8B0  LDA $BF00,X                    ; ...maps 256-511
//
// MEASURED against $F8 in a running game for maps 103/104/106/111/114/7/12 —
// 7/7, across all three of the table's non-zero values AND both zeros.
//
// ⛔ BANK TRAP, and it nearly landed: the encounter code runs with bank 61 at
// $A000 and bank 46 at $8000, but the map LOAD runs with bank 57 at $A000. The
// rate table is bank 57's $BE00, not bank 61's — bank 61's $BE00 is executable
// code. Resolve every table's bank at the moment its reader runs.

/** bank 46 @ $8000 — all of these are read by the encounter roll. */
const B46 = (addr) => 0x10 + 46 * 0x2000 + (addr - 0x8000);
/** bank 61 @ $A000 — the encounter code's own bank. */
const B61 = (addr) => 0x10 + 61 * 0x2000 + (addr - 0xA000);
/** bank 57 @ $A000 — mapped during a map LOAD, which is when the rate is read. */
const B57 = (addr) => 0x10 + 57 * 0x2000 + (addr - 0xA000);

export const MAP_GROUP_LO = B46(0x92F0);   // 0x05D300, maps 0-255
export const MAP_GROUP_HI = B46(0x93F0);   // 0x05D400, maps 256-511
export const GROUP_TABLE  = B46(0x94F0);   // 0x05D500
export const GROUP_STRIDE = 8;
export const GROUP_COUNT  = 256;
export const WORLD0_GRID  = B46(0x9CF0);   // 0x05DD00, 16 entries (4x4)
export const WORLD3_GRID  = B46(0x9D00);   // 0x05DD10, 64 entries (8x8)
export const WORLD_CFG    = B46(0x9D40);   // 0x05DD50, 16 bytes
export const SLOT_WEIGHTS = B61(0xBD78);   // 0x07BD88, 64 bytes
export const RATE_LO      = B57(0xBE00);   // 0x073E10, maps 0-255
export const RATE_HI      = B57(0xBF00);   // 0x073F10, maps 256-511
export const MAP_COUNT    = 256;

/** RAM: the live map id, and the world/high-map selector. */
export const MAP_ID_ZP = 0x48;
export const WORLD_ZP  = 0x78;
export const RATE_ZP   = 0xF8;
export const VEHICLE_ZP = 0x42;
export const FORMATION_ZP = 0x6A;

/** ⭐ Which of the 8 slots each of the 64 random values selects. */
export const slotWeights = (rom) => [...rom.slice(SLOT_WEIGHTS, SLOT_WEIGHTS + 64)];

/** slot -> how many of the 64 random values land on it. */
export function slotOdds(rom) {
  const w = slotWeights(rom), out = new Array(GROUP_STRIDE).fill(0);
  for (const s of w) out[s]++;
  return out;
}

export const groupForMap = (rom, map) =>
  rom[(map < MAP_COUNT ? MAP_GROUP_LO + map : MAP_GROUP_HI + map - MAP_COUNT)];

export const rateForMap = (rom, map) =>
  rom[(map < MAP_COUNT ? RATE_LO + map : RATE_HI + map - MAP_COUNT)];

/** The eight formation ids a group can roll, slot order. */
export const slotsForGroup = (rom, g) =>
  [...rom.slice(GROUP_TABLE + g * GROUP_STRIDE, GROUP_TABLE + (g + 1) * GROUP_STRIDE)];

/** World 0 is 128x128 in 32-tile regions: index = xreg | (yreg*4). */
export const world0Region = (x, y) => (((x + 7) & 0x7F) >> 5) | ((((y + 7) & 0x60) >> 3));
export const world0Group = (rom, x, y) => rom[WORLD0_GRID + world0Region(x, y)];
/** ⭐ On foot in world 0 the rate is a single constant, $9D47. */
export const WORLD0_FOOT_RATE_OFF = 7;
export const world0FootRate = (rom) => rom[WORLD_CFG + WORLD0_FOOT_RATE_OFF];

/**
 * A group as weighted formations: `[{ formation, weight }]`, weight out of 64,
 * duplicate slots merged.
 */
export function weightedGroup(rom, g) {
  const slots = slotsForGroup(rom, g), odds = slotOdds(rom);
  const by = new Map();
  slots.forEach((f, i) => by.set(f, (by.get(f) || 0) + odds[i]));
  return [...by].map(([formation, weight]) => ({ formation, weight }))
                .sort((a, b) => b.weight - a.weight);
}
