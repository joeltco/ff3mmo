// ff3-monsters.mjs — FF3's monster tables, checked against the running game.
//
// WHY THIS EXISTS
// `tools/gen-monsters-js.js` already generates `src/data/monsters.js` from these
// tables, but its header says the layout comes "from Data Crystal ROM map" — a
// secondary source. Every other bestiary in this project was measured, and this
// project's own rule is that the ROM beats a wiki. So the layout was put in front
// of the running game the same way FF1's and FF2's were.
//
// ⭐ THE TABLES ARE REAL. Tracing an actual encounter (a Goblin, bestiary id 0)
// and mapping every cartridge read back to a file offset shows the game reading
// EXACTLY the claimed addresses: all sixteen bytes of `0x60010`-`0x6001F`, the
// monster's gil pair at `0x61C68`, entries in the stat table at `0x61010`, and
// the EXP and CP tables. That is no longer a citation, it is a measurement.
//
// ⭐ HP is props +1/+2. Patching it to 300 and then 400 puts exactly those values
// in the enemy block in RAM.
//
// ⭐ ATTACK is byte 2 of the stat-table entry that props +9 points at. Patching
// that byte to 0 and then 255 moves the damage the party takes from 34 to 118.
//
// ⛔ RETRACTED — $7678 IS NOT THE MONSTER'S CURRENT HP. It is a copy that HP is
// loaded into and that never moves again. An earlier pass measured damage there,
// read "0 dealt" every time, and concluded from that the party simply could not
// hurt a Goblin — so defence and evade were reported as unverifiable. That was
// wrong twice over. Patching HP to 500 and scanning EVERY address that holds it:
//
//   $7678: 500 -> 500     $76B8: 500 -> 485   <-- the only one that moves
//   $767A: 500 -> 500     $76BA: 500 -> 500
//
// CURRENT hp is $76B8; $76BA is the max beside it. The party could hurt a Goblin
// the whole time. ⛔ The lesson: an address that merely HOLDS the right value at
// battle start has not been shown to be the live one — make it move first.
//
// ⭐ DEFENCE and EVADE are now both measured, off the entry props +12 points at
// (Goblin: idx 0, bytes [0,10,1]). They separate on the SAME signature FF1's do —
// evasion drives damage to ZERO, defence FLOORS it above zero:
//
//   byte 0 = 0/32/64/128/192/255  ->  99  0  0  0  0  0     floor ZERO
//   byte 2 = 0/32/64/128/192/255  -> 111 12 12 12 12 12     floor TWELVE
//
// and the battle text settles it outright — at byte 0 = 255 the screen prints
// "Miss" x26, a word that appears NOWHERE at baseline or with defence maxed,
// while byte 2 = 255 leaves the hit counts pixel-identical to baseline (1xHit
// x28, 2xHit x12, 3xHit x2) and only collapses the damage. Byte 0 makes the
// party miss; byte 2 lets them land and soaks it.
//
// ⛔ Byte 1 of that entry (Goblin's natural 10) does NOTHING measurable — 0 and
// 255 both leave the damage at exactly 99, on a measurement sensitive enough to
// catch both of its neighbours. It is NOT the evade byte, whatever it is. Left
// unnamed rather than guessed at.
//
// ⛔ Everything else in the 16-byte record (level, spAtkRate, weakness, spirit,
// atkElem, statusOnAtk, elemResist, statusResist, spAtkIdx) is INHERITED from
// Data Crystal, not measured. Do not cite it as verified.

export const MONSTER_PROPS = 0x060010;   // 16 bytes per bestiary id
export const PROPS_STRIDE = 16;
export const STAT_TABLE = 0x061010;      // 3 bytes per entry
export const STAT_ENTRY = 3;
export const MONSTER_ATKSCR = 0x061210;
export const MONSTER_GIL = 0x061C68;     // 2 bytes LE
export const MONSTER_CP = 0x0732BE;
export const MONSTER_EXP_ID = 0x021C90;
export const MONSTER_EXP_VAL = 0x021D90;
/** Where HP is LOADED. ⛔ Never moves again — do not measure damage here. */
export const ENEMY_RAM = 0x7678, ENEMY_RAM_STRIDE = 0x40;
/** The LIVE hp, the only address that counts down when the monster is hit. */
export const ENEMY_CUR_HP = 0x76B8;
/** Its max, sitting immediately beside it and staying put. */
export const ENEMY_MAX_HP = 0x76BA;

/** Fields proven by changing them and watching the game differ. */
export const VERIFIED_FIELDS = { hp: [1, 2], atkHitIdx: 9, defEvdIdx: 12 };
/** Byte within the stat-table entry `props +9` resolves to. */
export const STAT_ATK_OFF = 2, STAT_HIT_OFF = 1, STAT_ROLL_OFF = 0;
/** Byte within the stat-table entry `props +12` resolves to. */
export const STAT_EVADE_OFF = 0, STAT_DEF_OFF = 2;
/** Byte 1 of that entry moves nothing measurable. Unnamed on purpose. */
export const STAT_DEF_ENTRY_UNKNOWN = 1;
/** Fields taken on Data Crystal's word — NOT measured. Say so when citing them. */
export const INHERITED_FIELDS = {
  level: 0, spAtkRate: 3, weakness: 5, mEvadeIdx: 6, spiritInt: 7, atkElem: 8,
  statusOnAtk: 10, elemResist: 11, statusResist: 13, spAtkIdx: 14,
};

export const props = (rom, id) =>
  [...rom.slice(MONSTER_PROPS + id * PROPS_STRIDE, MONSTER_PROPS + (id + 1) * PROPS_STRIDE)];
export const monsterHP = (rom, id) =>
  rom[MONSTER_PROPS + id * PROPS_STRIDE + 1] | (rom[MONSTER_PROPS + id * PROPS_STRIDE + 2] << 8);
export const statEntry = (rom, idx) =>
  [...rom.slice(STAT_TABLE + idx * STAT_ENTRY, STAT_TABLE + (idx + 1) * STAT_ENTRY)];
export const monsterAttack = (rom, id) =>
  statEntry(rom, rom[MONSTER_PROPS + id * PROPS_STRIDE + VERIFIED_FIELDS.atkHitIdx])[STAT_ATK_OFF];
/** The defence/evade entry a monster resolves to, and the two measured bytes. */
export const defEntry = (rom, id) =>
  statEntry(rom, rom[MONSTER_PROPS + id * PROPS_STRIDE + VERIFIED_FIELDS.defEvdIdx]);
export const monsterDefence = (rom, id) => defEntry(rom, id)[STAT_DEF_OFF];
export const monsterEvade = (rom, id) => defEntry(rom, id)[STAT_EVADE_OFF];
export const monsterGil = (rom, id) =>
  rom[MONSTER_GIL + id * 2] | (rom[MONSTER_GIL + id * 2 + 1] << 8);
