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
// ⛔ The FIELDS are NOT identified. The copy at $AFC1 goes through a scatter
// table at $AFCB, so the RAM record is a PERMUTATION of the ROM one plus some
// runtime state (the last four bytes are identical for every monster). Neither a
// byte-for-byte nor a multiset search of the ROM finds the RAM record, which is
// how that was established. The raw records are cataloged; naming a byte "HP"
// would be a guess.
export const MONSTER_SLOTS = 0x6BC9;   // $FBD4 LDA $6BC9,X
export const EMPTY_SLOT = 0xFF;       // $FBD7 CMP #$FF

export const STAT_TABLE = 0x10 + 12 * 0x4000 + (0x8520 - 0x8000);   // 0x30530
export const STAT_STRIDE = 20;

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
