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
/**
 * The four 16-entry tables a nibble resolves through. Dumping them says most of
 * what they are without a single experiment:
 *
 *   $8D03  0 1 2 3 4 5 6 7 8 10 12 14 16 18 20 255   small COUNTS
 *   $8D13  0 10 20 30 40 50 60 65 70 75 80 85 90 95 100 255   PERCENTAGES
 *   $8D23  0 4 9 17 25 35 40 50 60 70 85 100 120 150 180 210  MAGNITUDES
 *   $8D33  0 129 65 17 9 5 3 130 66 10 6 70 134 254 4 8       BIT MASKS
 *
 * and the loader pairs them: record byte 2 -> ($8D03, $8D13) = a count and a
 * percentage; byte 3 -> ($8D23, $8D33) = a magnitude and a mask; and so on.
 *
 * ⛔ Which count is which is NOT established — no experiment isolated them, and
 * the shapes above are suggestive, not proof. They are described, not named.
 */
export const NIBBLE_TABLES = [0x8D03, 0x8D13, 0x8D23, 0x8D33];      // 16 entries each
export const nibbleTable = (rom, cpu) =>
  [...rom.slice(0x10 + 12 * 0x4000 + (cpu - 0x8000),
                0x10 + 12 * 0x4000 + (cpu - 0x8000) + 16)];
// ⛔ CORRECTED: the record starts at $7E3A, not $7E30. $9878 fills $7E30-$7E39
// and $9A3A starts the record proper. HP goes to zero-page $4E = $44 + 0x0A, and
// $7E3A + 0x0A = $7E44, which is the byte measured counting down. The old
// 0x7E30/+0x14 pair described the same byte from the wrong base and made every
// other offset in this file off by ten.
export const ENEMY_RAM = 0x7E3A, ENEMY_RAM_STRIDE = 0x30;           // $9A3C CPX #$30
export const RAM_HP_OFF = 0x0A;   // measured: it counts down when the monster is hit

/**
 * The record's TEN bytes, and where each nibble ends up. Bytes 2 and up are
 * nibble-split: the high nibble indexes one table, the low nibble another, and
 * each result lands at a different offset in the 48-byte enemy record.
 *
 *   byte 0  -> pool          -> +0x0A   HP        (proven: the battle loads it,
 *                                                  it counts down, patching the
 *                                                  index changes it)
 *   byte 1  -> pool          -> +0x0C   MP        (code only)
 *   byte 2  -> $8D03 / $8D13 -> +0x18 / +0x19     to-hit ($AFBD adds +0x18 to
 *                                                  +0x07 then subtracts 20)
 *   byte 3  -> $8D23 / $8D33 -> +0x1A / +0x1D  ⭐ ATTACK / a property mask
 *   byte 4  -> $8D03 / $8D13 -> +0x00 / +0x01
 *   byte 5  -> $8D23 / $8D03 -> +0x02 / +0x03  ⭐ DEFENCE
 *   byte 6  -> $8D13 / $8D43 -> +0x04 / +0x15  ⭐ ...a WEAKNESS mask
 *   byte 7  -> $8D53 / $8D63 -> +0x05 / +0x16  ⭐ ...the second one
 *   byte 8  -> $8D23 / $8D63 -> +0x14 / +0x17
 *
 * THE DAMAGE FORMULA, which is what names them (12/$B084):
 *   $B084  LDY #$1A / LDA ($9F),Y      ; the attacker's +0x1A is the base damage
 *   $B08E  LDY #$1C / AND ($A1),Y @$15 ; attacker mask vs the DEFENDER's +0x15
 *   $B098  LDY #$1B / AND ($A1),Y @$16 ; ...and the second pair
 *   $B0A5  ADC #$14                    ; either match is worth +20
 *   $B0AF  LDY #$02 / LDA ($A1),Y      ; then the defender's +0x02 comes off
 *
 * ⭐ VERIFIED by changing only that nibble, on Adamantoise:
 *   ATTACK  byte 3 high: 0x00 -> the party takes 0 damage; 0x70/0xF0 -> 96
 *   DEFENCE byte 5 high: 0x01 -> the party deals 56; 0x81/0xF1 -> 10
 *
 * ⛔ The masks are named from the formula, not from behaviour — this party has
 * no matching weakness bit, so the AND never fires and no experiment can see it.
 * The same blindness applies in FF1. Bytes 2, 4 and 8 measurably move the fight
 * but were not isolated to a single stat, so they are DESCRIBED, not named.
 */
export const STAT_FIELDS = { hp: 0, mp: 1, attackByte: 3, defenceByte: 5 };
/** High nibble indexes the first table, low nibble the second. */
export const hiNibble = (v) => (v >> 4) & 0x0F;
export const loNibble = (v) => v & 0x0F;
/** Enemy-record offsets the damage formula reads. */
export const RAM_ATTACK_OFF = 0x1A, RAM_DEFENCE_OFF = 0x02;
export const RAM_WEAKNESS_OFFS = [0x15, 0x16];
export const WEAKNESS_BONUS = 0x14;    // $B0A5 ADC #$14

export const monsterAttack = (rom, id) => {
  const b = rom[STAT_TABLE + id * STAT_STRIDE + STAT_FIELDS.attackByte];
  return nibbleTable(rom, 0x8D23)[hiNibble(b)];
};
export const monsterDefence = (rom, id) => {
  const b = rom[STAT_TABLE + id * STAT_STRIDE + STAT_FIELDS.defenceByte];
  return nibbleTable(rom, 0x8D23)[hiNibble(b)];
};

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
                         attack: monsterAttack(rom, id), defence: monsterDefence(rom, id),
                         stats: statRecord(rom, id) });
  }
  return out;
}
