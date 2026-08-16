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
// ⛔ Everything below is checked by `tools/check-ff3-monster-fields.mjs`, which is
// a MANUAL audit — it is NOT in `deploy.sh` (27 real battles, ~17 min). If you
// change an offset, a bit value or a nibble split down here, nothing on the
// deploy path will notice. Run it by hand.
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
// ⭐ 6  MAGIC DEFENCE INDEX. A third instrument was needed: the party had to
//      actually CAST. Poking job 4 (Black Mage) into every char's SRAM block plus
//      MP turns the "Guard" command row into "Magic", and the level-1 black spell
//      can then be driven from the menu. ⛔ The party is LEVEL 0, so the spell
//      grid opens on levels 8-5 and every A press is refused — it must be
//      scrolled to level 1 first, which is what made this look impossible.
//
//      Byte 6 is an INDEX into the same STAT_TABLE bytes 9 and 12 index — which
//      is why it is never copied into RAM, exactly like them. Pointed at entry 5
//      and then patching that entry:
//
//        byte 6 = 5, entry untouched      magic dealt 220
//        byte 6 = 5, entry byte 0 = 255   magic dealt   0    <- evade, to ZERO
//        byte 6 = 5, entry byte 1 = 255   magic dealt 220    <- inert
//        byte 6 = 5, entry byte 2 = 255   magic dealt  14    <- FLOORS
//
//      ⭐ THE CONTROL, and it could have disagreed: with byte 6 left at its
//      natural 0, patching that SAME entry changes nothing at all (220/220/220).
//      The entry only matters when byte 6 points at it.
//
//      So the magic entry has the IDENTICAL shape to the physical one at byte 12
//      — byte 0 evades to zero, byte 2 floors above it, byte 1 does nothing. The
//      inert middle byte turning up in both is its own small confirmation.
//
// ⭐ 8  ATTACK ELEMENT, in the same bit vocabulary as weakness and resistance.
//      Measured from the ARMOUR side, which is independent of how those bits were
//      derived from the monster side. With a fire-resisting shield equipped:
//
//                              no shield   fire-resist shield
//        atkElem = 0 (none)         2785                 2722
//        atkElem = 0x10 FIRE        2785                 1308   <- halved
//        atkElem = 0x08 ICE         2785                 7992   <- TRIPLED
//        atkElem = 0x02 physical    2785                 2722
//
//      ⭐ The no-shield column is flat at 2785 for every value — the control. And
//      the ice row is the good kind of surprise: fire armour is WEAK to ice, so
//      the same bit map falls out of an inverted effect.
//
// ⛔ 15 STILL UNKNOWN — and the previous explanation of it was wrong twice.
//
//      v1.8.67 said byte 15 had "a dedicated reader at $A5F3 that touches no
//      other field". ⛔ $A5F3 IS NOT A READER. Disassembling it (the sequence is
//      UNIQUE in the ROM, file 0x625FC, bank 49, CPU $A5EC) shows the
//      battle-setup COPY:
//
//        $A5EC  A0 0F     LDY #$0F        ; record offset 15
//        $A5EE  B1 24     LDA ($24),Y     ; A = monster record byte 15
//        $A5F0  A0 36     LDY #$36        ; combatant-entry offset $36
//        $A5F2  91 5D     STA ($5D),Y     ; ...store it
//
//      $A5F3 is the second byte of that STA, and the "read" a RAM hook sees
//      there is the DUMMY READ CYCLE an indirect-indexed store performs on its
//      target. It is the code that PUTS byte 15 into RAM, not code that uses it.
//      (($5D) = $7675 for enemy slot 0 — 3 below the HP field — so the code's
//      +$36 and this file's +0x33 name the same byte.)
//
//      ⛔ The v1.8.67 "cross-check" is withdrawn with it. It claimed $A61D read
//      atkElem AND elemResist and $A65C read atkElem, statusOnAtk AND
//      statusResist, so "the code agrees with the labels". Those are $A61C and
//      $A65B, both `STA ($5D),Y` — the SAME setup copy. They group by which
//      fields are written together, not by which calculation consumes them. The
//      corroboration was an artifact of counting stores as reads.
//
// ⛔ AND THE METHOD FAILS ITS OWN POSITIVE CONTROL. Watching one RAM address
//      cannot find consumers at all. atkElem provably halves damage against a
//      fire-resisting shield — yet tracing its home $768B with that effect ACTIVE
//      still shows no genuine load except a bulk block-move ($AA06 `LDA ($82),Y`,
//      which touches every field alike) and one coincidental hit from a map/tile
//      routine ($CEE7, whose pointer happens to land in the same page). Whatever
//      consumes atkElem reads it from somewhere else.
//
//      So no "nothing reads it, therefore it is unused" conclusion is available
//      for byte 15: the instrument that would have to support it demonstrably
//      cannot detect a consumer that is KNOWN to exist. Byte 15 is simply still
//      unknown — no behavioural effect across its whole range, and the code-side
//      approach is inconclusive until it can pass its own control.
//
//      ⭐ What IS settled: `tools/ff3-code-trace.mjs` disassembles the routine
//      any RAM address is touched from, and classifies each hit as a real LOAD or
//      the dummy cycle of a STORE. That distinction is the whole lesson here.

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
  levelHi: 0, hp: [1, 2], spAtkRate: 3, powerHi: 4, weakness: 5, magicDefIdx: 6,
  spiritLo: 7, atkElem: 8, atkHitIdx: 9, statusOnAtk: 10, elemResist: 11,
  defEvdIdx: 12, statusResist: 13, spAtkIdx: 14,
};
/** Bytes that INDEX the stat table rather than holding a value. None of them is
 *  copied into RAM — that is how byte 6 was spotted as an index at all. */
export const INDEX_FIELDS = { atkHitIdx: 9, defEvdIdx: 12, magicDefIdx: 6, spAtkIdx: 14 };
/** ⛔ $A5F2 is the STA that COPIES byte 15 into the entry — not a consumer.
 *  No consumer has been found, and the search method fails its own control. */
export const BYTE15_HOME_OFF = 0x33;
export const BYTE15_WRITER_PC = 0xA5F2;
export const BYTE15_WRITER_FILE_OFF = 0x625FC;
/** The party members' SRAM blocks, and the job that gains a Magic command. */
export const PARTY_A_BLOCK = 0x6100, JOB_OFF = 0x00, MP_OFF = 0x30;
export const SPELL_LIST_OFF = 0x07, BLACK_MAGE_JOB = 4;
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
/** ⛔ Read, but its effect is unknown. Do not fill it in from a wiki. */
export const NOT_ISOLATED = { unknown15: 15 };
/** ⛔ Kept so older callers still resolve. Nothing is inherited any more —
 *  every byte of the record has been measured except 15's PURPOSE. */
export const INHERITED_FIELDS = {};

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
/** The MAGIC defence/evade entry — same shape, reached through byte 6. */
export const magicEntry = (rom, id) =>
  statEntry(rom, rom[MONSTER_PROPS + id * PROPS_STRIDE + FIELDS.magicDefIdx]);
export const monsterMagicDefence = (rom, id) => magicEntry(rom, id)[STAT_DEF_OFF];
export const monsterMagicEvade = (rom, id) => magicEntry(rom, id)[STAT_EVADE_OFF];
export const monsterAtkElem = (rom, id) => rom[MONSTER_PROPS + id * PROPS_STRIDE + FIELDS.atkElem];
export const monsterGil = (rom, id) =>
  rom[MONSTER_GIL + id * 2] | (rom[MONSTER_GIL + id * 2 + 1] << 8);
