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
    if (name) out.push({ id, name });
  }
  return out;
}
