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
// ⭐ 15 IS THE MONSTER'S STEAL-TABLE INDEX — read by the THIEF'S STEAL, and by
//      nothing else. Chased down through four instruments, each one correcting
//      the last.
//
//      THE CHAIN. A battle action dispatcher in bank 52 turns a per-actor action
//      id into a handler:
//
//        $99D9  BD 00 74  LDA $7400,X     ; the action id for this actor
//        $99E1  0A        ASL A
//        $99E3  69 16     ADC #$16        ; pointer = $9A16 + id*2
//        $99E9  69 9A     ADC #$9A
//        $99FA  6C 18 00  JMP ($0018)
//
//      That fixes the table at $9A16 (file 0x69A26), so the byte-15 routine
//      ($AB9F, file 0x69A42) is ENTRY 14. Driving each job's menu rows and
//      logging what the dispatcher jumps to maps the commands outright:
//
//        Thief   row1 -> entry 14 ($AB9F)   STEAL      <-- reads byte 15
//        Scholar row1 -> entry 12 ($AB6E)   Study
//        Dragoon row1 -> entry  8 ($A9AB)   Jump
//        Attack       -> entries 4/5        Item -> entry 20, in every job
//
//      THE HANDLER, bank 53 (which the dispatcher confirms IS the $A000 bank):
//
//        $ABDE  A0 36     LDY #$36        ; entry offset $36 = byte 15
//        $ABE0  B1 70     LDA ($70),Y     ; from the TARGET — the monster robbed
//        $ABE2  29 1F     AND #$1F        ; low 5 bits = the steal-table index
//        $ABE4  85 18     STA $18
//        $ABE6  ...pointer $9B80, count 8, JSR $FDA6   ; load that 8-byte entry
//
//      ⭐ CONFIRMED BY WATCHING IT STEAL. Steal's roll fails at low level, so the
//      read is never reached ("Couldn't steal"). ⛔ HEX PATCH THE ROM: force the
//      guard and the roll (0x6ABC3 `B1 70` -> `A9 FF`, 0x6ABDF `C5 24` -> `C9 FF`)
//      and the read fires — with the index exactly `byte15 & $1F`, and DIFFERENT
//      ITEMS on screen:
//
//        byte 15 = 0x00 -> index  0 -> "Potion"
//        byte 15 = 0x20 -> index  0 -> "Potion"
//        byte 15 = 0x29 -> index  9 -> "Potion"
//        byte 15 = 0x0A -> index 10 -> "Bomb Arm" / "Tranquilizer"
//
//      ⭐ THE TABLE ITSELF: bank 16, `$9B80`, file 0x21B90 — 32 entries of EIGHT
//      ITEM IDS, one of which the steal rolls. ⛔ `$9B80` is not in the bank that
//      sets the pointer: `$FDA6` switches to bank 16 first, so reading it out of
//      the calling bank yields that bank's CODE (which a first pass duly dumped).
//      The bank was settled by capturing the RESOLVED pointer inside the copy
//      loop instead of computing it.
//
//        [ 0]  Potion x4, Hi-Potion x2, PhoenixDown, Elixir      <- 185 monsters
//        [ 5]  Wood/Holy/Iron/Bolt/Fire/Ice/Medusa/Yoichi Arrow
//        [ 6]  GoldNeedle x8
//        [10]  Hi-Potion, Bomb Arm x2, Tranquilizer, ...         <- what was seen
//        [15..28]  all zero, and NO monster points at them
//        [29]  Elixir x4, OnionSword x3, Onion Shield   <- Red Dragon    (0xFD)
//        [30]  Elixir x4, Onion Shield/Helm/Armor/Sword <- Green Dragon  (0xFE)
//        [31]  Elixir x4, Onion Gloves/Armor/Helm/Sword <- Yellow Dragon (0xFF)
//
//      ⭐ AND IT IS ALSO THE DROP TABLE. Victory has no table of its own — the
//      record loader parks this same entry at $7413 and the victory code rolls a
//      slot (see DROP_SLOT_THRESHOLDS). Slots 0-3 are ~18.75% each; the tail is
//      9.4 / 9.4 / 4.7 / 1.6%. That is why the dragons' Onion gear — sitting in
//      slots 4-7 — is the famous rare farm, and it is a DROP, not only a steal.
//      Confirmed live: beating a Goblin prints "Treasure: Potion" and puts 0xA6
//      in the bag, and Potion occupies slots 0-3 of its entry.
//
//      ⭐ Entry 10 lists Bomb Arm and Tranquilizer — precisely the items watched
//      being stolen. And the three "sentinel-looking" byte-15 values 0xFD/FE/FF
//      turn out to be the ONION EQUIPMENT entries, reached only by the three
//      DRAGONS. That the famous Onion gear falls out of the decode, on the
//      monsters it is famously stolen from, is the strongest check available.
//
//      ⭐ And the DATA agrees, which is what makes the mask more than a reading:
//      179 of 232 monsters have byte 15 = 0 (the default entry), and every nonzero
//      value is 0x20-0x2E or 0xFD-0xFF — masked, 0x00-0x0E and 0x1D-0x1F. Bit 5 is
//      a separate flag: 0x00 and 0x20 both give index 0 and both yield a Potion.
//
// ⛔ FOUR EARLIER ANSWERS, each from an instrument that had not been controlled:
//      v1.8.67  "a dedicated reader at $A5F3" — that is the second byte of the STA
//               that WRITES it. A RAM hook counts the dummy read cycle of an
//               indirect-indexed store.
//      v1.8.68  "$AA06 genuinely loads it" — indirect-indexed LOADS also do a
//               spurious read at the un-carried address when crossing a page.
//      v1.8.69  "copied and never read" — true only of ordinary battle; the
//               differential trace could not see a path that never ran.
//      v1.8.70  reader at "$8BE0" — wrong by $2000; bank 53 is in the $A000 window.
//      ⛔ Also nearly shipped: "the routine runs 48 times, so it is part of normal
//      resolution". Counting PC hits WITHOUT verifying the mapped bank gave 48;
//      verified against the opcode bytes it is ZERO.
//
//      ⭐ What finally worked was asking the game instead of the addresses: log
//      what the DISPATCHER jumps to while driving each command.

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
/** Byte 15: written at setup, read by exactly one routine, never by a monster
 *  script. Its low 5 bits are an index; bit 5 is a separate flag. */
export const BYTE15_HOME_OFF = 0x33;
export const BYTE15_ENTRY_OFF = 0x36;          // as the code addresses it, via ($70)
export const BYTE15_WRITER_PC = 0xA5F2;
export const BYTE15_WRITER_FILE_OFF = 0x625FC;
export const BYTE15_READER_PC = 0xABE0;        // bank 53, in the $A000 window
export const BYTE15_READER_FILE_OFF = 0x6ABF0;
export const BYTE15_INDEX_MASK = 0x1F;
export const BYTE15_ROUTINE_PC = 0xAB9F;
/** The battle-action dispatch table (bank 52) and the ids that reach each one. */
export const ACTION_DISPATCH_PC = 0x9A16, ACTION_DISPATCH_FILE = 0x69A26;
export const ACTION_DISPATCHER_PC = 0x99FA;
export const ACTION_ID_RAM = 0x7400;
export const STEAL_ACTION_ID = 14;
export const ACTION_IDS = { steal: 14, study: 12, jump: 8, item: 20 };
/** ⭐ Byte 15 is the monster's STEAL-TABLE index — the Thief's Steal reads it. */
export const BYTE15_MEANING = 'steal-table index';
/** The steal table itself. ⛔ `$9B80` is NOT in the bank that sets the pointer —
 *  `$FDA6` switches to bank 16 first, so the table is file 0x21B90. Reading it
 *  out of the calling bank yields that bank's CODE, which is what a first pass
 *  dumped. The bank was settled by capturing the RESOLVED pointer inside the
 *  copy loop rather than by arithmetic. */
export const STEAL_TABLE_PTR = 0x9B80;
export const STEAL_TABLE_BANK = 16;
export const STEAL_TABLE_FILE = 0x21B90;
export const STEAL_ENTRY_LEN = 8;
export const STEAL_ENTRIES = 32;
/** Entries 29-31 are the Onion equipment, and only the three DRAGONS reach them
 *  (byte 15 = 0xFD/0xFE/0xFF -> 29/30/31). Entries 15-28 are all-zero and no
 *  monster points at them. */
export const STEAL_ONION_ENTRIES = [29, 30, 31];
export const STEAL_DEAD_ENTRIES = [15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28];
/** ⭐ THE DROP TABLE IS THE STEAL TABLE. Victory does not consult a table of its
 *  own: the record loader parks the same 8-slot entry at $7413, and the victory
 *  code picks a slot with its own weighted roll (bank 53, $BC86 onward):
 *
 *    LDA #$06 / JSR $A564 / CMP $2E / BCS   ; a gate — fail and nothing drops
 *    LDA #$FF / JSR $A564                   ; then random 0..255 picks the slot
 *      < 0x30 -> 0   < 0x60 -> 1   < 0x90 -> 2   < 0xC0 -> 3
 *      < 0xD8 -> 4   < 0xF0 -> 5   < 0xFC -> 6   else  -> 7
 *    LDA $7413,Y / BEQ (0 = nothing) / JSR $BFB3   ; add to the bag
 *
 *  So slots 0-3 are ~18.75% each and the tail 4-7 is 9.4/9.4/4.7/1.6% — which is
 *  why the DRAGONS' Onion gear, sitting in slots 4-7, is the famous rare farm. */
export const DROP_USES_STEAL_TABLE = true;
export const DROP_SLOT_RAM = 0x7413;
export const DROP_SLOT_THRESHOLDS = [0x30, 0x60, 0x90, 0xC0, 0xD8, 0xF0, 0xFC];
export const DROP_LADDER_FILE = 0x6BCA4;   // the CMP #$30 that starts the ladder
export const DROP_ADD_ITEM_PC = 0xBFB3;    // add-to-bag, item id in A
export const DROP_GATE_ZP = 0x2E;          // the roll is compared against this
/** Slot odds in 256ths, from the thresholds above. */
export const dropSlotOdds = () => {
  const t = [0, ...DROP_SLOT_THRESHOLDS, 0x100];
  return t.slice(1).map((v, i) => v - t[i]);
};
/** The index a monster resolves to, and its eight steal slots (one is rolled). */
export const stealIndex = (rom, id) =>
  rom[MONSTER_PROPS + id * PROPS_STRIDE + 15] & BYTE15_INDEX_MASK;
export const stealSlots = (rom, id) => stealEntry(rom, stealIndex(rom, id));
export const stealEntry = (rom, idx) =>
  [...rom.slice(STEAL_TABLE_FILE + idx * STEAL_ENTRY_LEN,
                STEAL_TABLE_FILE + (idx + 1) * STEAL_ENTRY_LEN)];
/** Forcing a steal to succeed, for harnesses: guard + roll. */
export const STEAL_FORCE_PATCHES = [[0x6ABC3, 0xA9], [0x6ABC4, 0xFF],
                                    [0x6ABDF, 0xC9], [0x6ABE0, 0xFF]];
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
/** ⭐ Empty: every byte of the record is now measured, byte 15 included. */
export const NOT_ISOLATED = {};
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
