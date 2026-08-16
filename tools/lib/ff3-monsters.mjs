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
// ⭐ THE COMBATANT ARRAY. One array at $7578, stride 0x40, holds EVERY fighter:
// slots 0-3 are the party, slots 4-7 the monsters. Each entry is `+0` current hp
// and `+2` max hp. Confirmed against the party's own HP as DRAWN on the battle
// screen — slots 0-3 read 30/32, 30/32, 26/32, 32/32 and the screen showed
// exactly those four, and slot 2 tracked down 26 -> 22 as it got hit.
//
// ⛔ TWICE-RETRACTED, and the second retraction is the real one.
//
// v1.8.63 measured damage at $7678, read "0 dealt" every time, and concluded the
// party could not hurt a Goblin at all — so defence and evade shipped as
// unverifiable. v1.8.64 found that damage does land at $76B8, and called $7678 "a
// copy hp is loaded into that never moves". ⛔ THAT IS ALSO WRONG. $7678 is
// enemy slot 0 and $76B8 is enemy slot 1 — the freeroam encounter spawns TWO
// Goblins, and the party targets the second one first. Kill it and the screen
// prints "Enemy defeated.", the battle CONTINUES, and slot 0 immediately starts
// taking the hits:
//
//   round 31   slot4 = 25   slot5 =  2
//   round 36   slot4 = 25   slot5 =  0   "Enemy defeated."
//   round 58   slot4 = 18   slot5 =  0   <-- it moves after all
//   round 68   slot4 = 11   slot5 =  0
//
// ⛔ The lesson stands and sharpened: an address that merely HOLDS the right
// value has not been shown to be the live one — but "it never moved in my test"
// does not make it dead either. It may just be behind something else. Measure
// damage on the slot the party is ACTUALLY hitting.
//
// ⛔ A footnote on how the original error survived: "every fight ends identically
// at round 11" was itself an artifact. Round 11 is where the battle MENU stops
// being drawn while messages play; the battle runs on for 60+ more rounds.
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
// ─── THE REST OF THE RECORD, measured ────────────────────────────────────────
//
// Two instruments made the rest reachable, and both matter more than any single
// field below:
//
//   1. AN IMMORTAL PARTY. The party is topped back up to 999 hp every round, so
//      damage taken is a GRADIENT. Without it every probe saturates at 118 — the
//      party's total hp — and EVERY FIELD LOOKS INERT. A first pass reported
//      exactly that and was measuring nothing but "everyone died".
//   2. ELEMENTAL WEAPONS. Poking an item id into the party's weapon slots makes
//      their ordinary attacks elemental, so the receive-side fields can be probed
//      without giving anyone magic. The weapon slots were MEASURED, not guessed:
//      writing a sword into each byte of the char-B block in turn and watching
//      the damage, only `+3` and `+5` moved it — the two hands.
//
// ⭐ 3  SPECIAL RATE. How often it uses its special instead of swinging. At 0 the
//      special NEVER appears; at 0x20 it appears sometimes; at 0xFF it is used
//      every single turn. Read off the screen by name, not inferred.
//
// ⭐ 14 SPECIAL ID — selects WHICH special, and the game prints the name:
//        0 Fire   1 Blizzard   2 Thunder   3 Poison ("Poison damage.")
//        5 Glare + STONE        8 Glare + SLP.      32 BLIND      64 Flare
//      ⛔ It reads as inert unless byte 3 is raised first — with rate 0 the
//      special never fires and every id looks identical.
//
// ⭐ 10 STATUS-ON-ATTACK — a BITMASK, and seven of the eight bits name themselves
//      on screen when the monster lands a hit:
//        0x02 PSN.   0x04 BLIND   0x08 MINI   0x10 SLNC.
//        0x20 TOAD   0x40 STONE   0x80 Died.
//      0x01 produced no message and is not named here.
//
// ⭐ 5  WEAKNESS and ⭐ 11 ELEMENTAL RESIST — the same bit means the same element
//      in both fields, which is what makes the pair believable. Weakness DOUBLES
//      the damage of a matching attack, resistance HALVES it:
//
//                        ice weapon   flame weapon
//        (no bits set)         434            434
//        weakness   0x08       879            434     <- 0x08 is ICE
//        weakness   0x10       434            879     <- 0x10 is FIRE
//        elemResist 0x08       209            434
//        elemResist 0x10       434            209
//        elemResist 0x02       209            209     <- not elemental at all
//
//      ⭐ 0x02 cuts the plain STARTING weapons too (91 -> 37), so it is the
//      physical / non-elemental bit rather than a third element.
//
// ⭐ 13 STATUS RESIST. A rod carrying a petrify effect kills a Goblin outright
//      (the screen reaches the EXP/Level victory text). Setting bit 0x01, 0x02 or
//      0x04 blocks the kill and STONE stops appearing; 0x08 through 0x80 do not.
//      So the field really is status resistance — ⛔ but THREE bits each blocked
//      the same status, so the bit -> status map is NOT determined and is
//      deliberately not written down. It is plainly NOT the byte-10 order, where
//      STONE is 0x40.
//
// ⭐ NIBBLE-PACKED FIELDS. Three bytes carry their value in ONE nibble and ignore
//      the other entirely — swept across all 16 values of each nibble with the
//      other pinned at 0 (party damage taken, monster casting every turn):
//
//        byte 7  LOW nibble  1178 1265 1362 1930 2056 2168 3429 3600
//                            5344 5568 5844 8680 9070 9420 11958 12372   monotone
//                HIGH nibble 1178 across every value                     inert
//        byte 0  LOW nibble  1178 across all 16                          inert
//                HIGH nibble 1178 1576 2352 3312, then the encounter breaks
//        byte 4  LOW nibble  1178 across all 16                          inert
//                HIGH nibble 1178 1178 1576 1576 2352 2352               in PAIRS
//
//      Byte 4's high nibble tracks byte 0's at half weight (its 2,3 match byte
//      0's 1; its 4,5 match byte 0's 2), so the two feed the SAME damage term.
//      ⛔ Reading either as a plain 0-255 magnitude is wrong, and a coarse sweep
//      that happens to land on multiples of 16 will never notice.
//
// ⛔ STILL NOT ISOLATED — say so, do not fill these in from a wiki:
//      byte 6  (mEvadeIdx)   nothing moved it; the party never casts magic at it
//      byte 8  (atkElem)     flat across all 8 bits — the party has no elemental
//                            resistance for an attack element to show up against
//      byte 15               flat across its ENTIRE range in every configuration
//                            tried, including with the special active

export const MONSTER_PROPS = 0x060010;   // 16 bytes per bestiary id
export const PROPS_STRIDE = 16;
export const STAT_TABLE = 0x061010;      // 3 bytes per entry
export const STAT_ENTRY = 3;
export const MONSTER_ATKSCR = 0x061210;
export const MONSTER_GIL = 0x061C68;     // 2 bytes LE
export const MONSTER_CP = 0x0732BE;
export const MONSTER_EXP_ID = 0x021C90;
export const MONSTER_EXP_VAL = 0x021D90;
/** Every fighter in the battle, party and monsters alike. */
export const COMBATANT_BASE = 0x7578, COMBATANT_STRIDE = 0x40;
export const HP_CUR_OFF = 0, HP_MAX_OFF = 2;
export const PARTY_SLOT0 = 0, PARTY_SLOTS = 4;
export const ENEMY_SLOT0 = 4, ENEMY_SLOTS = 4;
export const slotAddr = (i) => COMBATANT_BASE + i * COMBATANT_STRIDE;
export const enemyAddr = (n = 0) => slotAddr(ENEMY_SLOT0 + n);
export const partyAddr = (n = 0) => slotAddr(PARTY_SLOT0 + n);
/** ⛔ Kept for the old names. Enemy slot 0 — NOT a dead copy, just usually
 *  the one standing behind the monster the party actually swings at. */
export const ENEMY_RAM = 0x7678, ENEMY_RAM_STRIDE = 0x40;
/** Enemy slot 1 — the one the party targets first, so damage shows up here. */
export const ENEMY_CUR_HP = 0x76B8;
export const ENEMY_MAX_HP = 0x76BA;

/** Fields proven by changing them and watching the game differ. */
export const VERIFIED_FIELDS = { hp: [1, 2], atkHitIdx: 9, defEvdIdx: 12 };
/** Byte within the stat-table entry `props +9` resolves to. */
export const STAT_ATK_OFF = 2, STAT_HIT_OFF = 1, STAT_ROLL_OFF = 0;
/** Byte within the stat-table entry `props +12` resolves to. */
export const STAT_EVADE_OFF = 0, STAT_DEF_OFF = 2;
/** Byte 1 of that entry moves nothing measurable. Unnamed on purpose. */
export const STAT_DEF_ENTRY_UNKNOWN = 1;
/** Measured fields — see the header for the experiment behind each one. */
export const FIELDS = {
  levelHi: 0, hp: [1, 2], spAtkRate: 3, powerHi: 4, weakness: 5, spiritLo: 7,
  atkHitIdx: 9, statusOnAtk: 10, elemResist: 11, defEvdIdx: 12, statusResist: 13,
  spAtkIdx: 14,
};
/** ⛔ Bytes 0 and 4 carry their value in the HIGH nibble, byte 7 in the LOW one.
 *  The other nibble is inert. Reading any of them as a plain 0-255 is wrong. */
export const HIGH_NIBBLE_FIELDS = [0, 4];
export const LOW_NIBBLE_FIELDS = [7];
export const hiNib = (v) => (v >> 4) & 0x0F, loNib = (v) => v & 0x0F;
/** Element bits, the same in `weakness` and `elemResist`. */
export const ELEM_BITS = { physical: 0x02, ice: 0x08, fire: 0x10 };
/** `statusOnAtk` bits, each read off the battle screen by name. */
export const STATUS_BITS = {
  0x02: 'PSN.', 0x04: 'BLIND', 0x08: 'MINI', 0x10: 'SLNC.',
  0x20: 'TOAD', 0x40: 'STONE', 0x80: 'Died.',
};
/** `spAtkIdx` values whose special was read off the screen by name. */
export const SPECIAL_NAMES = {
  0: 'Fire', 1: 'Blizzard', 2: 'Thunder', 3: 'Poison',
  5: 'Glare', 8: 'Glare', 32: 'BLIND', 64: 'Flare',
};
/** The party's two weapon hands, within the char-B block. Measured. */
export const PARTY_B_BLOCK = 0x6200, PARTY_B_STRIDE = 0x40;
export const WEAPON_SLOTS = [3, 5];
/** ⛔ Nothing moved these. Do not fill them in from a wiki. */
export const NOT_ISOLATED = { mEvadeIdx: 6, atkElem: 8, unknown15: 15 };
/** ⛔ Kept so older callers still resolve; every entry is now measured except
 *  the three in NOT_ISOLATED. */
export const INHERITED_FIELDS = { mEvadeIdx: 6, atkElem: 8 };

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
