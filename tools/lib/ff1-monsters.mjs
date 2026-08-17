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

// ── THE REST OF THE 16-BYTE FORMATION RECORD ────────────────────────────────
// Byte 2 was pinned long ago as "a" monster id. It is the first of FOUR, each
// with its own COUNT — and the counts are NIBBLE-PACKED min..max, exactly the
// shape FF3 uses. Measured by patching the record and counting bodies:
//
//   count byte  0x11 0x22 0x33 0x44 0x55 0x66 0x88 0x99
//   bodies         1    2    3    4    5    6    8    9
//   and a range rolls inside itself: 0x35 -> 5, 0x39 -> 7, 0x19 -> 7
//
// ⭐ The PAIRING is what makes it more than a guess. Patching byte 3 alone does
// nothing at all — its species never appears, because its count (byte 7) is 0 in
// this formation. Patch byte 7 and byte 3's species shows up; byte 8 brings in
// byte 4's, byte 9 brings in byte 5's. Each id is inert until its own count says
// otherwise.
//
// ⛔ Counting bodies by CURRENT hp (RAM 13) reads one short — a just-spawned
// enemy has not had it filled in. MAX hp (RAM 9) is set for every live body, and
// switching to it turned a ragged off-by-one into the clean table above.
export const FORMATION_SPECIES_OFF = [2, 3, 4, 5];
export const FORMATION_COUNT_OFF = [6, 7, 8, 9];
export const FORMATION_MAX_SPECIES = 4;
export const ENEMY_RAM = 0x6BDC, ENEMY_RAM_STRIDE = 20;
export const ENEMY_MAXHP_OFF = 9, ENEMY_CURHP_OFF = 13;
/** A raw count byte as the game reads it: [min, max]. */
export const countRange = (b) => [(b >> 4) & 0x0F, b & 0x0F];
export const formationOf = (rom, f) =>
  [...rom.slice(FORMATION_TABLE + f * FORMATION_STRIDE,
                FORMATION_TABLE + (f + 1) * FORMATION_STRIDE)];
export const formationSpecies = (rom, f) => {
  const r = formationOf(rom, f);
  return FORMATION_SPECIES_OFF.map((o, i) => ({ id: r[o], count: countRange(r[FORMATION_COUNT_OFF[i]]) }))
    .filter(e => e.count[0] > 0 || e.count[1] > 0);
};
// ── ⭐ BYTES 10 AND 11 ARE THE BATTLE PALETTE INDICES ───────────────────────
// TCRF notes that formations were altered for the American release because
// enemies "will occasionally display corrupted colors". That is a consequence of
// this: the colours travel with the FORMATION, not with the monster. Measured by
// `tools/ff1-formation-palette.mjs` — patching the SPECIES (byte 2) provably
// reaches the fight ($6BC9 slot 0 becomes the patched id) and does not move a
// single palette slot, while byte 10 repaints BG palette 1 ($3F05-07) and byte
// 11 repaints BG palette 2 ($3F09-0B). Pair a formation with the wrong index and
// the monster draws in another monster's colours.
//
// Both are indices into ONE 4-byte-per-entry table, found by reading the colours
// off the PPU for 16 indices each and searching the ROM for the table that
// reproduces every one — exactly ONE offset in the whole ROM does, and bytes 10
// and 11 agree on it. Entry = [0x0F, c1, c2, c3]; byte 0 is the NES backdrop and
// is 0x0F for every entry, which is why $3F04/$3F08 never move.
//
// The single reader: `LDA $8F20,X` at CPU $F478 (bank 15).
export const BATTLE_PAL_TABLE = 0x30F30;   // bank 12, CPU $8F20
export const BATTLE_PAL_STRIDE = 4;
export const BATTLE_PAL_BACKDROP = 0x0F;   // entry byte 0, constant
export const BATTLE_PAL_READER_PC = 0xF478;      // CPU, bank 15
export const BATTLE_PAL_READER_FILE = 0x3F488;   // the LDA abs,X opcode
export const FORMATION_PAL_OFF = [10, 11];       // -> BG palette 1, BG palette 2
export const FORMATION_PAL_PPU = [0x3F05, 0x3F09];
/** The 4 NES colour indices for palette entry `i`. */
export const battlePalette = (rom, i) =>
  [...rom.slice(BATTLE_PAL_TABLE + i * BATTLE_PAL_STRIDE,
                BATTLE_PAL_TABLE + (i + 1) * BATTLE_PAL_STRIDE)];

// ── ⭐ BYTE 1 IS THE MONSTER SIZE / LAYOUT CLASS — ONLY BITS 0-1 ARE LIVE ────
// It repaints 23 of 32 palette slots, which reads like a palette field and is
// not one: it changes WHICH TILES ARE DRAWN. Measured by `ff1-formation-byte1.mjs`
// (body count + nametable + attribute table + framebuffer, four signals) and by
// looking at the rendered frames.
//
//   bits 2-7   INERT. 0x04/0x08/0x10/0x20/0x40/0x80 are byte-identical to 0x00
//              on every signal — so the field is 2 bits wide.
//   bit 1      ⭐ ALTERNATE MONSTER ART. The per-slot attribute array flips from
//              0x00 to 0x80 and the same formation draws WOLVES instead of IMPs
//              — same species ids, same name in the box, same stats, palette
//              untouched. A formation with this bit wrong shows the wrong
//              creature, which is the class of bug TCRF records for FF1.
//   bit 0      ⭐ ALTERNATE SLOT LAYOUT. Placement changes from the 9-slot two
//              column grid to 3 slots in one column. ⛔ With THIS formation's own
//              count byte (0x35 = 3..5) nothing is placed at all — the field is
//              empty and the screen draws garbage. Set the counts to 0x11 and it
//              places 3. So bit 0 alone is not "no monsters"; the counts have to
//              suit the layout.
//
// ⛔ A 128-species sweep with bit 0 set and the natural counts put a body on the
// field ZERO times. So the empty field is NOT "this species has no large art" —
// it is the count/placement path. Don't re-run that sweep.
// ⚠ "size class" is a READING of the two bits, not a measured name. What is
// measured: which tiles are drawn, the placement arrays, and the slot count.
export const FORMATION_GFX_OFF = 1;
export const FORMATION_GFX_MASK = 0x03;      // bits 2-7 measured inert
export const FORMATION_GFX_ALT_LAYOUT = 0x01;
export const FORMATION_GFX_ALT_ART = 0x02;
/** Two parallel 9-byte arrays: slot -> enemy index, then slot -> art attribute. */
export const ENEMY_PLACE_SLOTS = 0x6BB7, ENEMY_PLACE_ATTR = 0x6BC0, ENEMY_PLACE_LEN = 9;
export const ENEMY_PLACE_EMPTY = 0xFF;
export const ALT_ART_ATTR = 0x80;
/** The 16-byte record is copied here at setup ($F2BC STA $6D84,Y). */
export const FORMATION_RAM_COPY = 0x6D84;

// ── ⭐ BYTE 12 BIT 7 = "MONSTERS STRIKE FIRST" (the ambush flag) ────────────
// It looked like a palette field too — it moves $3F08 and $3F18-1B. It isn't:
// those five slots move because an extra ROUND happens before the first menu.
// ⭐ THE GAME SAYS IT IN WORDS, which is the whole finding: with the bit clear the
// battle opens "Chance strike first"; with it set, "Monsters strike first", the
// party takes a free round of hits, and only THEN does the menu appear.
//
// ⛔ FORCED, NOT A RATE. A single sample cannot tell those apart, and the first
// pass here was exactly that — 6 "trials" that varied no RNG at all and returned
// 6 identical results. With the walk genuinely varied (12 distinct step-counts):
//   0x00 -> ambushed  0/12      0x40 -> ambushed  0/12      0x80 -> ambushed 12/12
// ⛔ Bits 0-6 are INERT: 0x01 through 0x40 are byte-identical to 0x00 on every
// signal. Do not read byte 12 as a 0-255 surprise RATE — measured, it is one bit.
// ⛔ The ambush damage is IDENTICAL across runs with different step counts, so it
// is not evidence of RNG; don't treat repeated damage values as a control.
export const FORMATION_AMBUSH_OFF = 12;
export const FORMATION_AMBUSH_BIT = 0x80;
export const AMBUSH_MSG = 'Monsters strike first';
export const PREEMPT_MSG = 'Chance strike first';
/** Party current HP, verified against the on-screen boxes (35/30/33/30). */
export const PARTY_HP = 0x610A, PARTY_HP_STRIDE = 0x40;

/** ⛔ Bytes 0, 13, 14, 15 are still NOT identified. */
export const FORMATION_UNKNOWN_OFF = [0, 13, 14, 15];
export const FORMATION_MOVES_PALETTE_UNIDENTIFIED = [];

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
 *               ⭐ PROVEN behaviourally, once the party was GIVEN a weakness:
 *               the defender's fields live at $6800 + n*0x12, +0x0D and +0x0E,
 *               and every party member's are 0x00 in a stock save — which is
 *               why patching the monster alone had looked like it did nothing.
 *               Poke them and the AND fires. IMP's natural byte 16 is 0x04:
 *                 party weakness 0x04  -> 24 damage   (the ONE matching bit)
 *                 party weakness 0xFB  -> 12 damage   (every bit EXCEPT it)
 *                 masks 0xFF, party 0x00 -> 12 ; both 0xFF -> 24
 *               Only the specific bit matters, in both directions.
 *   15   STATUS $A85F LDA $6873 / BEQ skip gates a path that immediately ANDs
 *               with byte 18's mask — a status/effect attack, off when 0.
 *   11   a second multiplier term ($A71F LDX $686F / JSR $AEDD, the same routine
 *               the x40 weakness bonus goes through).
 *
 * ⛔ Bytes 14, 17 and 19 are never read during a battle and no test moved them.
 * Byte 6 gates whether the monster attacks but was not isolated further. Those
 * four stay unnamed.
 *
 *   6    MORALE  the flee threshold. $B23C LDY #$09 / LDA ($9A),Y / SBC, then a
 *               random 0..0x32 is added and the total compared against
 *               $B253 CMP #$50. Below it the monster RUNS: at byte 6 = 0 or 40
 *               the game prints "Run away" and the party takes no damage; at 80
 *               and above it stays and fights. The behavioural flip lands exactly
 *               on that 0x50, and every monster's natural value (104..255) sits
 *               above it.
 *
 * ⛔ BYTES 14, 17 AND 19 ARE NEVER READ. Not a shrug — measured. Hooking the
 * record's address range across a full encounter (walk in, the monster acts and
 * deals damage, it dies, the reward is paid) shows 17 of the 20 offsets being
 * read and exactly these three not, for several monsters including one with a
 * special attack and a boss. They are not zero either: byte 14 takes 3 distinct
 * values, byte 17 takes 62 across 14..200, byte 19 takes 24. Real data that no
 * battle path consumes.
 */
/** The DEFENDER's weakness fields, as addressed live at $A5EA / $A5F1. */
export const DEFENDER_BASE = 0x6800, DEFENDER_STRIDE = 0x12;
export const DEFENDER_WEAK_OFFS = [0x0D, 0x0E];
export const MASK_BONUS_X = 0x28;    // $A6DC LDX #$28 — the x40 term
export const MORALE_THRESHOLD = 0x50;   // $B253 CMP #$50 — below it, it flees
/** Offsets no battle path reads, and the distinct-value count each still holds. */
export const UNREAD_OFFSETS = [14, 17, 19];
export const STAT_FIELDS = {
  exp: [0, 1], gil: [2, 3], hp: [4, 5], evade: 8, defense: 9, attack: 12,
  special: 7, crit: 13, hits: 10, status: 15, mask1: 16, mask2: 18, morale: 6,
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
