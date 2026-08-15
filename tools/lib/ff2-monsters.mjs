// ff2-monsters.mjs — FF2's monster name table.
//
// 128 names, Leg Eater through the Emperor. Found by encoding a known name
// through the shipped glyph table, locating it in the ROM, and fitting a
// pointer table against THREE consecutive entries (Goblin, GoblinGuard,
// GoblinPrince) — then walking outward while entries stayed valid.
//
// ⛔ VERIFICATION. Unlike FF1's, this table is not pinned to an instruction —
// FF2's battle code has not been traced. It is confirmed a different way, and a
// stronger one than a single sample: `ff2-type-sweep.mjs` found that object
// types 73-76 are monster GUARDS which name their monster in dialogue and then
// start the fight. Talking to each and reading the battle screen gives four
// confirmations spread across the table, and each agrees with what the guard
// said it was guarding:
//
//   type 73  "めがみのベルをまもるかいぶつ アダマンタイマイだ!!"  -> index 11
//   type 74  "エギルのたいまつをまもるかいぶつ レッドソウルだ!!"  -> index 79
//   type 75  "くろいかめんをまもるかいぶつ ビッグホーンだ!!"      -> index 47
//   type 76  "ふねのまえに たちふさがる かいぶつ ラウンドウォームだ!!" -> index 72

export const NAME_PTR_TABLE = 0x16C54;          // bank 5, 2 bytes LE per id
export const NAME_BANK_BASE = 0x10 + 5 * 0x4000;
export const NAME_COUNT = 128;

/** Ids read off a real battle, with the guard type that starts it. */
export const CONFIRMED = [
  { type: 73, id: 11, name: 'アダマンタイマイ' },
  { type: 74, id: 79, name: 'レッドソウル' },
  { type: 75, id: 47, name: 'ビッグホーン' },
  { type: 76, id: 72, name: 'ラウンドウォーム' },
];

// ── stats ───────────────────────────────────────────────────────────────────
// The record is TEN bytes, and almost nothing in it is a value — it is indexes.
// From the loader at 12/$9962-$9A20:
//
//   $9962  LDA $04 / ADC #$C3 -> $7A ; LDA $05 / ADC #$87 -> $7B
//                                     ; $87C3 + monster*10, so record byte 0
//                                     ; is read with LDY #$01
//   $996E  LDY #$01 / LDA ($7A),Y     ; record byte 0
//   $9972  ASL A / ADC #$C3 / #$8C    ; -> $8CC3 + idx*2, a 16-bit VALUE POOL
//   $997E  LDA ($78),Y -> $4E and $52 ; ...that is HP
//   $998D  LDY #$02 / (same pool)     ; record byte 1 -> $50 and $54 (MP)
//   $99B0  LDY #$03 / JSR $FD07       ; record byte 2: a NIBBLE SPLIT
//   $99B8  LDA $8D03,Y -> $5C ; LDA $8D13,X -> $5D
//   $99C2  LDY #$04 / ... $8D23,Y -> $5E ; $8D33,X -> $61
//
// ⭐ So HP is NOT stored anywhere as a number. Searching the whole ROM at every
// stride 1-32 for "450" finds nothing, because 450 lives in a shared pool and
// the record only holds the index 0x0E. Every later byte packs TWO 4-bit indexes
// into 16-entry tables. This is why a direct search approach fails on FF2.
//
// $9A32  LDA $44,X / STA ($76),Y / CPX #$30  — 48 bytes per enemy in RAM, x8.
export const STAT_TABLE = 0x10 + 12 * 0x4000 + (0x87C4 - 0x8000);   // 0x307D4
export const STAT_STRIDE = 10;
export const VALUE_POOL = 0x10 + 12 * 0x4000 + (0x8CC3 - 0x8000);   // 0x30CD3
export const NIBBLE_TABLES = [0x8D03, 0x8D13, 0x8D23, 0x8D33];      // 16 entries each
export const ENEMY_RAM = 0x7E30, ENEMY_RAM_STRIDE = 0x30;           // $9A32 CPX #$30
export const RAM_HP_OFF = 0x14;   // measured: it counts down when the monster is hit

/** Which record byte is which. Only HP is behaviourally proven — see below. */
export const STAT_FIELDS = { hp: 0, mp: 1 };

export const poolValue = (rom, idx) =>
  rom[VALUE_POOL + idx * 2] | (rom[VALUE_POOL + idx * 2 + 1] << 8);
export const statRecord = (rom, id) =>
  [...rom.slice(STAT_TABLE + id * STAT_STRIDE, STAT_TABLE + (id + 1) * STAT_STRIDE)];
/** A monster's HP: record byte 0 is an INDEX into the value pool. */
export const monsterHP = (rom, id) =>
  poolValue(rom, rom[STAT_TABLE + id * STAT_STRIDE + STAT_FIELDS.hp]);
export const monsterMP = (rom, id) =>
  poolValue(rom, rom[STAT_TABLE + id * STAT_STRIDE + STAT_FIELDS.mp]);

export function monsterName(rom, id, glyph) {
  const o = NAME_PTR_TABLE + id * 2;
  const p = rom[o] | (rom[o + 1] << 8);
  if (p < 0x8000 || p >= 0xC000) return null;
  let f = NAME_BANK_BASE + (p - 0x8000), s = '';
  while (rom[f] !== 0 && s.length < 20) {
    const g = glyph(rom[f]);
    if (g !== null && g !== '\n') s += g;
    f++;
  }
  return s.trim();
}

export function allMonsters(rom, glyph, count = NAME_COUNT) {
  const out = [];
  for (let id = 0; id < count; id++) {
    const name = monsterName(rom, id, glyph);
    if (name) out.push({ id, name, hp: monsterHP(rom, id), mp: monsterMP(rom, id),
                         stats: statRecord(rom, id) });
  }
  return out;
}
