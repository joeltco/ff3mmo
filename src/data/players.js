// MMO roster data — fake player pool, palette table, chat phrases
import { ITEMS } from './items.js';
import { calcAttackerAtk } from '../battle-math.js';
import { createStatusState } from '../status-effects.js';

export const LOCATIONS = ['world', 'ur', 'cave-0', 'cave-1', 'cave-2', 'cave-3', 'crystal'];

// ─────────────────────────────────────────────────────────────────────────
// PLAYER_POOL — fake players the local player encounters across the world.
// Used by the roster HUD, chat sender pool, and PVP enemy generation.
// 5 entries per starting job (OK/Fi/Mo/WM/BM/RM = 30 total).
//
// Tier: Altar Cave + Ur. NO items, weapons, or armor past `cave-3`/`crystal`
// drops. Players are pre-Altar-Cave to early-post-Altar-Cave. Anything
// pricier than ~150 gil is off-limits unless it lives in an Altar-Cave
// chest pool (see `LOOT_POOLS` in `map-triggers.js`).
//
// Per-job equip matrix (cross-checked against `data/items.js` jobs masks
// 2026-05-08 — all entries below have been verified to satisfy their job's
// equip mask):
//
//   OK (jobIdx 0):
//     Weapons: Knife $1E, Dagger $1F, Longsword $24
//     Body: Leather $73 | Helm: Cap $62 | Shield: Leather Shield $58 ✓
//     (no Bracers — `Ww|Bw|Rw|...` mask, OK not in)
//     (Bow $4A / Arrow $4F exist in items.js with `twoHanded: true` but the
//      flag isn't read by the battle/draw code yet — bow ammo + ranged
//      attack mechanics are not wired. Don't equip bows on pool entries
//      until that lands.)
//
//   Fi (jobIdx 1):
//     Weapons: Knife $1E, Dagger $1F, Longsword $24
//     Body: Leather | Helm: Cap | Shield ✓
//     (no Bracers)
//
//   Mo (jobIdx 2):
//     Weapons: Nunchuck $06 (Mo|Ni only) OR Unarmed (str-scaled)
//     Body: Leather | Helm: Cap | NO Shield (mask: On|Fi|Rw|Kn|Th|Dr|Vi|Ni)
//
//   WM (jobIdx 3):
//     Weapons: Staff $0E (Ww|Rw|Sh|Sa|Ni)
//     Body: Leather | Helm: Cap | NO Shield
//     (Bracers $8B is Ww-equippable but `armsId` slot isn't tracked yet
//      in `generateAllyStats` — defer once that lands)
//
//   BM (jobIdx 4):
//     Weapons: Knife $1E, Dagger $1F (Bw in mask). NOTE: Bw is NOT in any
//       basic Staff $0E-$13 mask in this codebase — staves are Ww/Rw only.
//       Rod $09 is Bw-equippable (atk 5 / hit 60 / 400 gil) but isn't sold
//       in Ur and isn't in the Altar-Cave chest pool, so BMs at this tier
//       wield Knife or Dagger.
//     Body: Leather | Helm: Cap | NO Shield
//
//   RM (jobIdx 5) — hybrid; the most equipment options at this tier:
//     Weapons: Knife $1E, Dagger $1F, Staff $0E
//     Body: Leather | Helm: Cap | Shield $58 ✓ (Rw in mask)
//
// `palIdx` 0..7 picks the per-job palette slot. Within each job, slots are
// varied so two characters at the same location don't collide visually:
// PLAYER_PALETTES (OK/Fi default), MONK_PALETTES (Mo), BLACK_MAGE_PALETTES
// (all blue tints, BM), RED_MAGE_PALETTES (all red tints, RM).
//
// `knownSpells` is what fake-player AI casts in PVP. Sight $36 is dead
// weight on AI (it's the player's enemy-HP peek) — never include it on
// fake-player entries.
// ─────────────────────────────────────────────────────────────────────────
export const PLAYER_POOL = [
  // ── Onion Knight (5) — apprentice / orphan vibe ──
  { name: 'Nyx',     level: 1, palIdx: 0, camper: false, loc: 'ur',      jobIdx: 0, weaponR: 0x1E,                armorId: 0x73, helmId: 0x62 },                                  // OK — Knife
  { name: 'Wren',    level: 4, palIdx: 5, camper: false, loc: 'cave-0',  jobIdx: 0, weaponR: 0x1F,                armorId: 0x73, helmId: 0x62, shieldId: 0x58 },                  // OK — Dagger + Shield
  { name: 'Brom',    level: 3, palIdx: 6, camper: false, loc: 'cave-1',  jobIdx: 0, weaponR: 0x1F, weaponL: 0x1E, armorId: 0x73, helmId: 0x62 },                                  // OK — Dagger + Knife (dual-wield)
  { name: 'Lir',     level: 2, palIdx: 2, camper: false, loc: 'world',   jobIdx: 0, weaponR: 0x1E,                armorId: 0x73, helmId: 0x62 },                                  // OK — Knife
  { name: 'Eska',    level: 3, palIdx: 4, camper: true,  loc: 'crystal', jobIdx: 0, weaponR: 0x1F,                armorId: 0x73, helmId: 0x62, shieldId: 0x58 },                  // OK — Dagger + Shield
  // ── Fighter (5) — strong/martial names ──
  { name: 'Aldric',  level: 5, palIdx: 3, camper: true,  loc: 'ur',      jobIdx: 1, weaponR: 0x24,                armorId: 0x73, helmId: 0x62, shieldId: 0x58 },                  // Fi — Longsword + Shield (classic knight)
  { name: 'Fenris',  level: 5, palIdx: 5, camper: false, loc: 'cave-1',  jobIdx: 1, weaponR: 0x1F,                armorId: 0x73, helmId: 0x62, shieldId: 0x58 },                  // Fi — Dagger + Shield (light fighter)
  { name: 'Grok',    level: 5, palIdx: 7, camper: false, loc: 'cave-3',  jobIdx: 1, weaponR: 0x24,                armorId: 0x73, helmId: 0x62, shieldId: 0x58 },                  // Fi — Longsword + Shield
  { name: 'Cassia',  level: 5, palIdx: 6, camper: true,  loc: 'cave-2',  jobIdx: 1, weaponR: 0x24,                armorId: 0x73, helmId: 0x62, shieldId: 0x58 },                  // Fi — Longsword + Shield (was Serpent Sword $28 — out of tier, fixed v1.7.133)
  { name: 'Duran',   level: 5, palIdx: 1, camper: false, loc: 'crystal', jobIdx: 1, weaponR: 0x1F, weaponL: 0x1E, armorId: 0x73, helmId: 0x62 },                                  // Fi — Dagger + Knife (dual-wield, agile fighter)
  // ── Monk (5) — Japanese names ──
  { name: 'Kasumi',  level: 4, palIdx: 4, camper: false, loc: 'cave-0',  jobIdx: 2, weaponR: 0x06,                armorId: 0x73, helmId: 0x62 },                                  // Mo — Nunchuck
  { name: 'Jiro',    level: 5, palIdx: 2, camper: false, loc: 'crystal', jobIdx: 2, weaponR: 0,                   armorId: 0x73, helmId: 0x62 },                                  // Mo — Unarmed
  { name: 'Ryuji',   level: 5, palIdx: 7, camper: false, loc: 'cave-2',  jobIdx: 2, weaponR: 0x06,                armorId: 0x73, helmId: 0x62 },                                  // Mo — Nunchuck
  { name: 'Hana',    level: 3, palIdx: 5, camper: false, loc: 'world',   jobIdx: 2, weaponR: 0,                   armorId: 0x73, helmId: 0x62 },                                  // Mo — Unarmed
  { name: 'Tetsuo',  level: 5, palIdx: 3, camper: true,  loc: 'cave-1',  jobIdx: 2, weaponR: 0,                   armorId: 0x73, helmId: 0x62 },                                  // Mo — Unarmed
  // ── White Mage (5) — soft/healer names ──
  { name: 'Zephyr',  level: 5, palIdx: 1, camper: false, loc: 'cave-3',  jobIdx: 3, weaponR: 0x0E,                armorId: 0x73, helmId: 0x62, knownSpells: [0x34, 0x35] },       // WM — Staff (Cure, Poisona)
  { name: 'Mira',    level: 4, palIdx: 2, camper: false, loc: 'world',   jobIdx: 3, weaponR: 0x0E,                armorId: 0x73, helmId: 0x62, knownSpells: [0x34, 0x35] },       // WM — Staff (Cure, Poisona)
  { name: 'Suki',    level: 3, palIdx: 4, camper: false, loc: 'cave-1',  jobIdx: 3, weaponR: 0x0E,                armorId: 0x73, helmId: 0x62, knownSpells: [0x34] },             // WM — Staff (Cure)
  { name: 'Lenna',   level: 5, palIdx: 6, camper: true,  loc: 'ur',      jobIdx: 3, weaponR: 0x0E,                armorId: 0x73, helmId: 0x62, knownSpells: [0x34, 0x35] },       // WM — Staff (Cure, Poisona)
  { name: 'Ivy',     level: 2, palIdx: 0, camper: false, loc: 'cave-0',  jobIdx: 3, weaponR: 0x0E,                armorId: 0x73, helmId: 0x62, knownSpells: [0x34] },             // WM — Staff (Cure)
  // ── Black Mage (5) — mage names; palette is all-blue tints (BLACK_MAGE_PALETTES) ──
  // BM CAN'T equip basic Staff $0E in this codebase (mask is Ww|Rw|Sh|Sa|Ni;
  // Bw not in). They wield Knives/Daggers at Altar-Cave tier — offensive
  // output comes from Lv1 Black Magic, not weapon ATK.
  { name: 'Vivi',    level: 4, palIdx: 1, camper: false, loc: 'world',   jobIdx: 4, weaponR: 0x1F,                armorId: 0x73, helmId: 0x62, knownSpells: [0x31, 0x32] },       // BM — Dagger (Fire, Blizzard)
  { name: 'Nephele', level: 5, palIdx: 2, camper: true,  loc: 'cave-2',  jobIdx: 4, weaponR: 0x1F,                armorId: 0x73, helmId: 0x62, knownSpells: [0x31, 0x32, 0x33] }, // BM — Dagger (Fire, Blizzard, Sleep)
  { name: 'Korra',   level: 3, palIdx: 4, camper: false, loc: 'cave-0',  jobIdx: 4, weaponR: 0x1E,                armorId: 0x73, helmId: 0x62, knownSpells: [0x31] },             // BM — Knife (Fire)
  { name: 'Theron',  level: 5, palIdx: 6, camper: false, loc: 'crystal', jobIdx: 4, weaponR: 0x1F,                armorId: 0x73, helmId: 0x62, knownSpells: [0x31, 0x32, 0x33] }, // BM — Dagger (Fire, Blizzard, Sleep)
  { name: 'Mara',    level: 4, palIdx: 0, camper: false, loc: 'ur',      jobIdx: 4, weaponR: 0x1E,                armorId: 0x73, helmId: 0x62, knownSpells: [0x31, 0x33] },       // BM — Knife (Fire, Sleep)
  // ── Red Mage (5) — hybrid heroic names; palette is all-red tints (RED_MAGE_PALETTES) ──
  // RM is the most-equippable hybrid at this tier: Knife/Dagger/Staff +
  // Shield. Mix here to show range — sword-style RM, dagger-only caster
  // RM, staff-and-shield staff RM.
  { name: 'Asher',   level: 5, palIdx: 1, camper: false, loc: 'ur',      jobIdx: 5, weaponR: 0x1F,                armorId: 0x73, helmId: 0x62, shieldId: 0x58, knownSpells: [0x34, 0x31] },               // RM — Dagger + Shield (knight-mage)
  { name: 'Verena',  level: 4, palIdx: 3, camper: false, loc: 'cave-1',  jobIdx: 5, weaponR: 0x1F,                armorId: 0x73, helmId: 0x62,                 knownSpells: [0x34, 0x31, 0x32] },         // RM — Dagger (caster RM, no shield)
  { name: 'Caelum',  level: 5, palIdx: 5, camper: true,  loc: 'cave-3',  jobIdx: 5, weaponR: 0x0E,                armorId: 0x73, helmId: 0x62, shieldId: 0x58, knownSpells: [0x34, 0x31, 0x32, 0x33] },   // RM — Staff + Shield (staff RM)
  { name: 'Quill',   level: 3, palIdx: 7, camper: false, loc: 'world',   jobIdx: 5, weaponR: 0x1F,                armorId: 0x73, helmId: 0x62,                 knownSpells: [0x34] },                     // RM — Dagger (caster RM)
  { name: 'Soren',   level: 4, palIdx: 0, camper: false, loc: 'cave-2',  jobIdx: 5, weaponR: 0x1E,                armorId: 0x73, helmId: 0x62, shieldId: 0x58, knownSpells: [0x34, 0x31] },               // RM — Knife + Shield
];

// Palette variants — only color 3 changes (original $16 = red outfit)
// Colors 0=$0F, 1=$36 (skin), 2=$30 (white) stay the same
export const PLAYER_PALETTES = [
  [0x0F, 0x36, 0x30, 0x16], // original red
  [0x0F, 0x36, 0x30, 0x12], // blue
  [0x0F, 0x36, 0x30, 0x1A], // green
  [0x0F, 0x36, 0x30, 0x14], // purple
  [0x0F, 0x36, 0x30, 0x18], // yellow
  [0x0F, 0x36, 0x30, 0x11], // cyan
  [0x0F, 0x36, 0x30, 0x17], // orange
  [0x0F, 0x36, 0x30, 0x15], // pink
];

// Monk variants — base palette from PPU capture: 0x27 skin, 0x18 hair, 0x21 gi.
// Only color 3 (gi) changes across palIdx slots; skin and hair stay fixed.
export const MONK_PALETTES = [
  [0x0F, 0x27, 0x18, 0x21], // canonical blue
  [0x0F, 0x27, 0x18, 0x16], // red
  [0x0F, 0x27, 0x18, 0x1A], // green
  [0x0F, 0x27, 0x18, 0x14], // purple
  [0x0F, 0x27, 0x18, 0x28], // yellow
  [0x0F, 0x27, 0x18, 0x11], // cyan
  [0x0F, 0x27, 0x18, 0x17], // orange
  [0x0F, 0x27, 0x18, 0x15], // pink
];

// Black Mage variants — only the ROBE color (color 3) varies, and it's
// always a tint of blue. PPU capture 2026-05-07 confirmed SP1 = [0x0F, 0x27,
// 0x18, 0x21] for the canon default; remaining slots are 7 different blue
// tints from the NES system palette. Skin/hair/outline stay fixed across
// all 8 slots.
export const BLACK_MAGE_PALETTES = [
  [0x0F, 0x27, 0x18, 0x21], // canon light blue (default)
  [0x0F, 0x27, 0x18, 0x11], // azure / royal blue
  [0x0F, 0x27, 0x18, 0x12], // deep blue-violet
  [0x0F, 0x27, 0x18, 0x22], // sky blue
  [0x0F, 0x27, 0x18, 0x1C], // cyan
  [0x0F, 0x27, 0x18, 0x2C], // light cyan
  [0x0F, 0x27, 0x18, 0x01], // deep blue
  [0x0F, 0x27, 0x18, 0x31], // pale blue
];

// Red Mage variants — only the ROBE color (color 3) varies, and it's
// always a tint of red. Skin (0x36) + outline (0x0F) + white inner (0x30)
// stay fixed; canonical red ($16) is slot 0. Same palette skeleton as
// PLAYER_PALETTES but the row only spans the red half of the system palette.
export const RED_MAGE_PALETTES = [
  [0x0F, 0x36, 0x30, 0x16], // canon red (default)
  [0x0F, 0x36, 0x30, 0x15], // magenta
  [0x0F, 0x36, 0x30, 0x14], // purple-red
  [0x0F, 0x36, 0x30, 0x17], // orange-red
  [0x0F, 0x36, 0x30, 0x25], // light red
  [0x0F, 0x36, 0x30, 0x24], // pink
  [0x0F, 0x36, 0x30, 0x05], // dark red
  [0x0F, 0x36, 0x30, 0x35], // pale red
];

export const CHAT_PHRASES = [
  'anyone near floor 3?',
  'need heals',
  'good luck!',
  'watch out for traps',
  'lfg crystal room',
  'found a chest!!',
  'that boss hits hard',
  'anyone selling armor?',
  'longsword on floor 3',
  'stay together',
  'almost to the boss',
  'gg everyone',
  'which floor is this?',
  'low hp, retreating',
  'nice one!',
  'any potions?',
  'boss incoming',
  'clear!',
  'level up!',
  'this dungeon is wild',
];


export const ROSTER_FADE_STEPS = 4;

// ─────────────────────────────────────────────────────────────────────────
// Per-job stat-weight matrix — SINGLE SOURCE OF TRUTH for both local-player
// and fake-player stats. Each stat is `5 + level * W` (or `level * W_mp` for
// MP, since non-casters have no MP at all). HP is always `28 + level * 6`
// regardless of job — HP scales with level, not job — so it's not in the
// matrix.
//
// Specialist jobs hit W=3 in their core stat (Fi/Mo str+vit, WM mnd, BM
// int). Red Mage is the hybrid: W=2 in BOTH int AND mnd, putting their
// magic output at ~67% of a specialist's at the same level — meaningful
// magic, but a focused WM/BM still outclasses them per-school. RM phys is
// the same as the pure casters (W=1) — they're not melee fighters.
//
//          str  agi  vit  int  mnd  mp
//   OK (0)  1    1    1    1    1   0    apprentice — flat baseline, no MP
//   Fi (1)  2    1    2    1    1   0    melee — strong + tanky, no MP
//   Mo (2)  2    2    2    1    1   0    melee — strong + agile + tanky, no MP
//   WM (3)  1    1    1    1    3   3    pure white caster
//   BM (4)  1    1    1    3    1   3    pure black caster
//   RM (5)  1    1    1    2    2   2    hybrid — medium in both schools
//
// Both `generateAllyStats` (PVP enemies + roster allies) AND `initPlayerStats`
// / `grantExp` / `changeJob` (local player) read from this matrix via
// `computeJobStats`. There is no second stat path.
// Per-job stat weights drive `computeJobStats(jobIdx, level)`. All 22 jobs
// covered. Entries 6+ added 2026-05-10 — previously fell through to default
// 1/1/1/1/1, leaving Knight/Thief/Ranger/Black Belt/etc. as stat-clones at
// every level (caught by tools/battle-sim.js statistical sweep).
const _JOB_STAT_WEIGHTS = {
   0: { str: 1, agi: 1, vit: 1, int: 1, mnd: 1, mp: 0 }, // Onion Knight
   1: { str: 2, agi: 1, vit: 2, int: 1, mnd: 1, mp: 0 }, // Fighter
   2: { str: 2, agi: 2, vit: 2, int: 1, mnd: 1, mp: 0 }, // Monk
   3: { str: 1, agi: 1, vit: 1, int: 1, mnd: 3, mp: 3 }, // White Mage
   4: { str: 1, agi: 1, vit: 1, int: 3, mnd: 1, mp: 3 }, // Black Mage
   5: { str: 1, agi: 1, vit: 1, int: 2, mnd: 2, mp: 2 }, // Red Mage
  // --- L9 unlocks ---
   6: { str: 1, agi: 2, vit: 1, int: 1, mnd: 1, mp: 0 }, // Ranger — bow + speed
   7: { str: 2, agi: 1, vit: 3, int: 1, mnd: 1, mp: 0 }, // Knight — heavy tank
   8: { str: 1, agi: 3, vit: 1, int: 1, mnd: 1, mp: 0 }, // Thief — speed king
   9: { str: 1, agi: 1, vit: 1, int: 2, mnd: 2, mp: 0 }, // Scholar — knowledge
  // --- L14 unlocks ---
  10: { str: 1, agi: 2, vit: 1, int: 1, mnd: 2, mp: 0 }, // Geomancer
  11: { str: 2, agi: 1, vit: 2, int: 1, mnd: 1, mp: 0 }, // Dragoon
  12: { str: 3, agi: 1, vit: 3, int: 1, mnd: 1, mp: 0 }, // Viking — heaviest tank
  13: { str: 3, agi: 3, vit: 3, int: 1, mnd: 1, mp: 0 }, // Black Belt — Monk evolved
  14: { str: 2, agi: 1, vit: 2, int: 1, mnd: 1, mp: 1 }, // Magic Knight — hybrid
  15: { str: 1, agi: 1, vit: 1, int: 1, mnd: 3, mp: 4 }, // Conjurer
  16: { str: 1, agi: 2, vit: 1, int: 1, mnd: 2, mp: 0 }, // Bard
  // --- L29+ unlocks (high tier) ---
  17: { str: 1, agi: 1, vit: 1, int: 1, mnd: 3, mp: 4 }, // Summoner
  18: { str: 1, agi: 1, vit: 1, int: 1, mnd: 4, mp: 5 }, // Devout
  19: { str: 1, agi: 1, vit: 1, int: 4, mnd: 1, mp: 5 }, // Magus
  20: { str: 1, agi: 1, vit: 1, int: 3, mnd: 3, mp: 5 }, // Sage
  21: { str: 2, agi: 3, vit: 2, int: 1, mnd: 1, mp: 0 }, // Ninja — speed god
};
const _DEFAULT_STAT_WEIGHTS = { str: 1, agi: 1, vit: 1, int: 1, mnd: 1, mp: 0 };

// Single helper: compute all stats for any (jobIdx, level). Used by both
// the local-player path and the fake-player path so RM (or any job) is
// the same character whether you're playing it or fighting it.
export function computeJobStats(jobIdx, level) {
  const w = _JOB_STAT_WEIGHTS[jobIdx] || _DEFAULT_STAT_WEIGHTS;
  return {
    str:    5 + level * w.str,
    agi:    5 + level * w.agi,
    vit:    5 + level * w.vit,
    int:    5 + level * w.int,
    mnd:    5 + level * w.mnd,
    maxHP: 28 + level * 6,
    maxMP: w.mp > 0 ? (5 + level * w.mp) : 0,
  };
}

// Per-level deltas — for incremental level-up bookkeeping. Same matrix as
// `computeJobStats` but expressed as the diff that gets added per level.
export function getJobLevelDelta(jobIdx) {
  const w = _JOB_STAT_WEIGHTS[jobIdx] || _DEFAULT_STAT_WEIGHTS;
  return {
    str: w.str, agi: w.agi, vit: w.vit, int: w.int, mnd: w.mnd,
    hpGain: 6,
    mpGain: w.mp,
  };
}

export function generateAllyStats(player) {
  const lv = player.level;
  const s = computeJobStats(player.jobIdx, lv);
  const { str, agi, vit, mnd } = s;
  const int_ = s.int;
  const hp = s.maxHP;
  const loc = player.loc;
  // Gear by location (matches chest loot tiers)
  let weaponId = 0x1E, totalDef = 1; // default: Knife + Cap
  if (loc === 'cave-1') { weaponId = 0x1F; totalDef = 3; }
  else if (loc === 'cave-2') { weaponId = 0x24; totalDef = 3; }
  else if (loc === 'cave-3' || loc === 'crystal') { weaponId = 0x24; totalDef = 7; }
  // Override with explicit weapon slots if defined on player entry
  if (player.weaponR != null) weaponId = player.weaponR;
  const weaponL = player.weaponL != null ? player.weaponL : null;
  // Calculate totalDef from explicit armor if defined
  if (player.armorId != null || player.helmId != null || player.shieldId != null) {
    totalDef = 0;
    if (player.armorId  != null) totalDef += (ITEMS.get(player.armorId)  || {}).def || 0;
    if (player.helmId   != null) totalDef += (ITEMS.get(player.helmId)   || {}).def || 0;
    if (player.shieldId != null) totalDef += (ITEMS.get(player.shieldId) || {}).def || 0;
  }
  // Derive weapon ATK from the actual equipped items (so explicit weaponR/weaponL — including 0 for unarmed — overrides the loc default).
  const rWpnItem = ITEMS.get(weaponId);
  const lWpnItem = weaponL != null ? ITEMS.get(weaponL) : null;
  const rIsWpn = !!(rWpnItem && rWpnItem.type === 'weapon' && rWpnItem.subtype !== 'shield');
  const lIsWpn = !!(lWpnItem && lWpnItem.type === 'weapon' && lWpnItem.subtype !== 'shield');
  const rWpnAtk = rIsWpn ? (rWpnItem.atk || 0) : 0;
  const lWpnAtk = lIsWpn ? (lWpnItem.atk || 0) : 0;
  const isMonkClass = player.jobIdx === 2 || player.jobIdx === 13; // Monk / BlackBelt
  const atk = calcAttackerAtk({
    rWpnAtk, lWpnAtk, isMonkClass, level: lv, str, jobLevel: 1,
  });
  // floor(vit/2) — mirrors the player's recalcDEF and the floor(str/2) attacker
  // formula. Prior `vit + totalDef` left NPC allies tankier than their stat-screen
  // ATK could overcome, especially in PVP where both sides use this helper.
  const def = Math.floor(vit / 2) + totalDef;
  // Evade/mdef/sResist from armor
  let evade = 0, mdef = 0, statusResist = 0;
  if (player.armorId != null) { const a = ITEMS.get(player.armorId) || {}; evade += a.evade || 0; mdef += a.mdef || 0; statusResist |= a.sResist || 0; }
  if (player.helmId != null) { const a = ITEMS.get(player.helmId) || {}; evade += a.evade || 0; mdef += a.mdef || 0; statusResist |= a.sResist || 0; }
  let shieldEvade = 0;
  if (player.shieldId != null) { const a = ITEMS.get(player.shieldId) || {}; mdef += a.mdef || 0; statusResist |= a.sResist || 0; shieldEvade = a.evade || 0; }
  // Hit rate from weapon, attack roll from AGI
  const wpnItem = ITEMS.get(weaponId);
  const hitRate = wpnItem ? (wpnItem.hit || 80) : 80;
  // Pass through known spells so battle-turn's WM heal AI can decide what to cast.
  const knownSpells = Array.isArray(player.knownSpells) ? [...player.knownSpells] : [];
  return { name: player.name, palIdx: player.palIdx, jobIdx: player.jobIdx || 0, level: lv, hp, maxHP: hp, atk, def, agi, int: int_, mnd, evade, mdef, shieldEvade, statusResist, hitRate, weaponId, weaponL, knownSpells, jobLevel: 1, fadeStep: ROSTER_FADE_STEPS, status: createStatusState() };
}
