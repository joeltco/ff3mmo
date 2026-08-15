// ff1-monsters.mjs — FF1's monster name table.
//
// Found by tracing a real battle: the party was teleported to open overworld
// ($27/$28 are pokeable) and walked until an encounter fired, with a read hook
// armed on the table.
//
// WHAT THE CPU DOES (fixed bank):
//   $FC72  ASL A / CLC / ADC $94 / TAX
//   $FC77  LDA $6BE4,X          ; the monster id, out of the battle's RAM block
//   $FC7B  LDA #$0B / JSR $FE03 ; ...switch to bank 11
//   $FC81  PLA / ASL A / TAX
//   $FC83  LDA $94E0,X -> $94   ; the NAME POINTER, two bytes per id
//   $FC88  LDA $94E1,X -> $95
//   $FC94  LDY #$00 / LDA ($94),Y / BEQ   ; print until the 00
//
// So the table is `$94E0` in bank 11 — file 0x2D4F0 — and a name is a
// 00-terminated string, also in bank 11.
//
// ⭐ VERIFICATION. All 128 names have now been made to appear in a real battle
// and read off the screen — 128/128 (`tools/ff1-monster-verify.mjs`). The table
// ADDRESS is separately pinned to the instruction at $FC83.

export const FORMATION_TABLE = 0x10 + 11 * 0x4000 + 0x400;   // CPU $8400, bank 11
export const FORMATION_STRIDE = 16;      // $F2B8 LDX #$10
export const FORMATION_MONSTER_OFF = 2;  // measured, see above

// The 20-byte STAT record per monster. Located by hooking the source read of the
// copy loop ($AFB6 LDA ($9C),Y): monster 0 reads from $8520, monster 58 from
// $89A8 — exactly 58 * 20 further on, in bank 12.
//
// The copy at $AFC1 goes through a scatter table at $AFCB, so the RAM record is a
// PERMUTATION of the ROM one plus runtime state. The mapping was MEASURED by
// patching each ROM byte to a sentinel and seeing which RAM byte moved
// (`tools/ff1-stat-fields.mjs --map`):
//
//   ROM  0 -> RAM  4     ROM  5 -> RAM 14
//   ROM  1 -> RAM  5     ROM  6 -> RAM  0
//   ROM  2 -> RAM  6     ROM  7 -> RAM  3
//   ROM  3 -> RAM  7     ROM  8 -> RAM  1
//   ROM  4 -> RAM  9 AND 13   (max and CURRENT hp)
//   ROM  9 -> RAM 15     ROM 12 -> RAM  2
//   ROM 10, 11, 13-19 are not copied into the enemy block at all.
export const ROM_TO_RAM = { 0: [4], 1: [5], 2: [6], 3: [7], 4: [9, 13], 5: [14],
                            6: [0], 7: [3], 8: [1], 9: [15], 12: [2] };
export const MONSTER_SLOTS = 0x6BC9;   // $FBD4 LDA $6BC9,X
export const EMPTY_SLOT = 0xFF;       // $FBD7 CMP #$FF

export const STAT_TABLE = 0x10 + 12 * 0x4000 + (0x8520 - 0x8000);   // 0x30530
export const STAT_STRIDE = 20;

/**
 * What each byte DOES. Every entry was established by changing that byte and
 * watching the game behave differently — never by matching against a wiki.
 *
 *   0-1  EXP    award = field / 2, linear over five values (6, 18, 438, 1337,
 *               4242 -> 3, 9, 219, 668, 2121 on the victory screen)
 *   2-3  GIL    award = field * 2, linear over five values (6, 18, 108, 999,
 *               777 -> 12, 36, 216, 1998, 1554)
 *   4-5  HP     RAM 13 is CURRENT hp: it counts down as the monster is hit,
 *               reaches 0, and RAM 17 flips to a dead flag. IMP 8, TIGER 132,
 *               CHAOS 2000.
 *   8    EVADE  damage the party lands falls monotonically to ZERO as it rises
 *               (0/32/128/255 -> 32/19/1/0 over 120 rounds)
 *   9    DEF    damage falls too, but FLOORS at a nonzero minimum
 *               (0/32/128/255 -> 59/9/9/9). That floor is what separates a
 *               damage reduction from a miss chance.
 *   12   ATTACK zeroing it drops the damage the party TAKES from 7 to 1;
 *               raising it multiplies it (0/64/200 -> 1/35/35)
 *
 *   7    SPECIAL  a special-attack id; 0xFF means "none". $B2A6 LDY #$07 /
 *               LDA ($9C),Y / CMP #$FF / BNE takes the special branch. 46 of the
 *               128 monsters have one, ids 0x00-0x2B in sequence, ending
 *               CHAOS 0x2A and ASTOS 0x2B.
 *   13   CRIT   the critical-hit rate. Raising it makes the game print
 *               "Critical hit!!"; at 0 and 1 the message never appears. Its
 *               natural range across all 128 monsters is 0..70.
 *   10   HITS   $A761 LDA $6871 / LDX $6870 / JSR $AE09 — a MULTIPLY, clamped to
 *               a minimum of 1. Raising it raises the damage the party takes.
 *   16,18 MASK  $A6C0 LDA $686D / AND $6876 and $A6C9 LDA $686E / AND $6877,
 *               then ORA / BEQ skip / x40. Two attack-property masks ANDed
 *               against two defender fields; a match adds a x40 damage term.
 *   15   STATUS $A85F LDA $6873 / BEQ skip gates a path that immediately ANDs
 *               with byte 18's mask — a status/effect attack, off when 0.
 *   11   a second multiplier term ($A71F LDX $686F / JSR $AEDD, the same routine
 *               the x40 weakness bonus goes through).
 *
 * ⛔ Bytes 14, 17 and 19 are never read during a battle and no test moved them.
 * Byte 6 gates whether the monster attacks but was not isolated further. Those
 * four stay unnamed.
 *
 * ⛔ The MASK bytes could not be confirmed behaviourally: patching them changes
 * nothing measurable because this party has no matching weakness bit, so the
 * AND never fires. The disassembly is unambiguous; the black-box test is simply
 * blind to it, and that is why they are named from code and labelled as such.
 */
export const STAT_FIELDS = {
  exp: [0, 1], gil: [2, 3], hp: [4, 5], evade: 8, defense: 9, attack: 12,
  special: 7, crit: 13, hits: 10, status: 15, mask1: 16, mask2: 18,
};
/** 0xFF in the SPECIAL byte means the monster has no special attack. */
export const NO_SPECIAL = 0xFF;
export const specialsOf = (rom, count = NAME_COUNT) => {
  const out = [];
  for (let id = 0; id < count; id++) {
    const v = rom[STAT_TABLE + id * STAT_STRIDE + STAT_FIELDS.special];
    if (v !== NO_SPECIAL) out.push({ id, special: v });
  }
  return out;
};
export const statValue = (rom, id, field) => {
  const f = STAT_FIELDS[field];
  const o = STAT_TABLE + id * STAT_STRIDE;
  return Array.isArray(f) ? (rom[o + f[0]] | (rom[o + f[1]] << 8)) : rom[o + f];
};

export const NAME_PTR_TABLE = 0x2D4F0;          // CPU $94E0, bank 11
export const NAME_BANK_BASE = 0x10 + 11 * 0x4000;
export const NAME_COUNT = 128;                  // ids that resolve to a real name

/** Every id was read off a running battle; these are the gate's spot checks. */
export const CONFIRMED = [
  { id: 0, name: 'IMP' }, { id: 58, name: 'TIGER' }, { id: 127, name: 'CHAOS' },
];

export function monsterName(rom, id, glyph) {
  const o = NAME_PTR_TABLE + id * 2;
  const p = rom[o] | (rom[o + 1] << 8);
  if (p < 0x8000 || p >= 0xC000) return null;   // outside bank 11's window
  let f = NAME_BANK_BASE + (p - 0x8000), s = '';
  while (rom[f] !== 0 && s.length < 16) {
    const g = glyph(rom[f]);
    if (g !== null && g !== '\n') s += g;
    f++;
  }
  return s.trim();
}

export const statRecord = (rom, id) =>
  [...rom.slice(STAT_TABLE + id * STAT_STRIDE, STAT_TABLE + (id + 1) * STAT_STRIDE)];

export function allMonsters(rom, glyph, count = NAME_COUNT) {
  const out = [];
  for (let id = 0; id < count; id++) {
    const name = monsterName(rom, id, glyph);
    if (name) out.push({ id, name, stats: statRecord(rom, id) });
  }
  return out;
}
