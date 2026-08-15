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
// ⛔ VERIFICATION STATUS. The table ADDRESS is pinned by the instruction at
// $FC83, which is as strong as it gets. The CONTENTS are decoded but only
// index 0 is confirmed on screen: a live battle read `$94E0` (index 0) and drew
// "IMP". Sweeping the rest needs the encounter FORMATION table so a chosen
// monster can be made to appear, and that is not decoded yet — a harness fact,
// not a claim that the other 138 names are unreliable.

export const NAME_PTR_TABLE = 0x2D4F0;          // CPU $94E0, bank 11
export const NAME_BANK_BASE = 0x10 + 11 * 0x4000;
export const MONSTER_ID_RAM = 0x6BE4;           // $FC77 LDA $6BE4,X
export const NAME_COUNT = 128;                  // ids that resolve to a real name

/** The id whose name was read off a running battle. */
export const CONFIRMED = { id: 0, name: 'IMP' };

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

export function allMonsters(rom, glyph, count = NAME_COUNT) {
  const out = [];
  for (let id = 0; id < count; id++) {
    const name = monsterName(rom, id, glyph);
    if (name) out.push({ id, name });
  }
  return out;
}
