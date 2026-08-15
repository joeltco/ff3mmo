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
 * ⛔ NOT identified, only bounded: 10 and 13 also raise the damage the party
 * takes but are not required for it (10 at 0 leaves the baseline). 6 and 7 gate
 * whether the monster attacks at all — 7 is 0xFF for every monster and any other
 * value stops it acting. 11 and 14-19 showed no effect in any test run here.
 * They are left unnamed rather than guessed at.
 */
export const STAT_FIELDS = {
  exp: [0, 1], gil: [2, 3], hp: [4, 5], evade: 8, defense: 9, attack: 12,
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
