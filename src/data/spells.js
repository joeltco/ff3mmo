// Spell Catalog — keyed by spell ID (0x00–0x57)
//
// ONLY the SPELLS map between the GENERATED markers below comes from the ROM.
// Everything after it — SPELL_NAMES_SHRINES, SPELL_MP_COST, SPELL_BUY_PRICE,
// MULTI_TARGET_SPELLS, SPELL_SCHOOL and every helper — is HAND-MAINTAINED and
// has no ROM source to rebuild it from.
//
// Regenerate with `node tools/gen-spells-js.js`, which splices the map in place
// and leaves the rest alone. Do NOT redirect it over this file
// (`... > src/data/spells.js`) the way gen-monsters-js.js is used: monsters.js
// really is generated end to end, this file is not, and the redirect would
// delete every table below.
//
// Stats from Data Crystal ROM map ($618D0, 8 bytes per spell)
// IDs 0-55: player/enemy magic, 56+: monster-only abilities

import { JOBS, MAG_WHITE, MAG_BLACK, MAG_CALL } from './jobs.js';
import { SUMMON_TIERS } from './summon-tiers.js';
import { STATUS_NAME_TO_FLAG } from '../status-effects.js';

// ─── BEGIN GENERATED (tools/gen-spells-js.js) ───
export const SPELLS = new Map([
  [0x00, { power: 200, hit: 100, element: null, type: 'damage', target: 'enemy', anim: 0x00, targeting: 0x0f, castAnim: 0x3d }], // Flare
  [0x01, { power:   0, hit:  35, element: null, type: 'death', target: 'enemy_status', anim: 0x00, targeting: 0x2f, castAnim: 0x3d }], // Death
  [0x02, { power: 180, hit: 100, element: null, type: 'damage', target: 'enemy', anim: 0x03, targeting: 0x4f, castAnim: 0x3d }], // Meteor
  [0x03, { power:   4, hit:  40, element: 'air', type: 'damage', target: 'enemy', anim: 0x00, targeting: 0x17, castAnim: 0x3e }], // Tornado
  [0x04, { power: 255, hit:   0, element: 'recovery', type: 'death', target: 'revive', anim: 0x05, targeting: 0xb7, castAnim: 0x3e }], // Arise
  [0x05, { power: 160, hit: 100, element: 'holy', type: 'damage', target: 'enemy', anim: 0x00, targeting: 0x37, castAnim: 0x3e }], // Holy
  [0x06, { power: 250, hit: 100, element: null, type: 'damage', target: 'enemy', anim: 0x00, targeting: 0x07, castAnim: 0x3f }], // Bahamur
  [0x07, { power: 133, hit: 100, element: 'earth', type: 'damage', target: 'enemy', anim: 0x02, targeting: 0x4e, castAnim: 0x2e }], // Quake
  [0x08, { power:   0, hit:  40, element: 'earth', type: 'petrify', target: 'enemy_status', anim: 0x07, targeting: 0x2e, castAnim: 0x2e }], // Breakga
  [0x09, { power: 160, hit: 100, element: 'recovery', type: 'damage', target: 'drain', anim: 0x04, targeting: 0x2e, castAnim: 0x2e }], // Drain
  [0x0a, { power: 220, hit: 100, element: 'recovery', type: 'damage', target: 'ally', anim: 0x00, targeting: 0x96, castAnim: 0x30 }], // Curaja
  [0x0b, { power:   0, hit:  60, element: null, type: 'cure_status', target: 'cure_status', statusMask: 0xff, anim: 0x00, targeting: 0xb6, castAnim: 0x30 }], // Esuna
  [0x0c, { power:   0, hit:  75, element: null, type: 'damage', target: 'reflect', anim: 0x00, targeting: 0xb6, castAnim: 0x30 }], // Reflect
  [0x0d, { power: 180, hit: 100, element: null, type: 'damage', target: 'enemy', anim: 0x00, targeting: 0x06, castAnim: 0x3f }], // Leviath
  [0x0e, { power: 150, hit: 100, element: 'fire', type: 'damage', target: 'enemy', anim: 0x00, targeting: 0x0d, castAnim: 0x2e }], // Firaga
  [0x0f, { power: 130, hit: 100, element: null, type: 'damage', target: 'enemy', anim: 0x00, targeting: 0x0d, castAnim: 0x2e }], // Bio
  [0x10, { power:   0, hit:   0, element: null, type: 'death', target: 'enemy_status', anim: 0x00, targeting: 0x2d, castAnim: 0x2e }], // Warp
  [0x11, { power: 115, hit: 100, element: ['ice','air'], type: 'damage', target: 'enemy', anim: 0x00, targeting: 0x15, castAnim: 0x30 }], // Aeroga
  [0x12, { power:   0, hit:  60, element: null, type: 'haste', target: 'cure_status', statusMask: 0x07, anim: 0x00, targeting: 0xb5, castAnim: 0x30 }], // Stone
  [0x13, { power:   5, hit:  16, element: null, type: 'damage', target: 'haste', anim: 0x00, targeting: 0xb5, castAnim: 0x30 }], // Haste
  [0x14, { power: 150, hit: 100, element: null, type: 'damage', target: 'enemy', anim: 0x00, targeting: 0x05, castAnim: 0x3f }], // Catas
  [0x15, { power: 110, hit: 100, element: 'bolt', type: 'damage', target: 'enemy', anim: 0x00, targeting: 0x0c, castAnim: 0x2e }], // Taga
  [0x16, { power: 100, hit: 100, element: null, type: 'death', target: 'enemy_status', anim: 0x01, targeting: 0x4c, castAnim: 0x2e }], // Raze
  [0x17, { power:   0, hit:  60, element: null, type: 'damage', target: 'erase', anim: 0x00, targeting: 0x0c, castAnim: 0x2e }], // Erase
  [0x18, { power: 180, hit: 100, element: 'recovery', type: 'damage', target: 'ally', anim: 0x00, targeting: 0x94, castAnim: 0x30 }], // Curaga
  [0x19, { power:   1, hit:  15, element: 'recovery', type: 'death', target: 'revive', anim: 0x05, targeting: 0xb4, castAnim: 0x30 }], // Raise
  [0x1a, { power:   5, hit:  75, element: null, type: 'damage', target: 'protect', anim: 0x00, targeting: 0xb4, castAnim: 0x30 }], // Protect
  [0x1b, { power: 120, hit: 100, element: null, type: 'damage', target: 'enemy', anim: 0x00, targeting: 0x04, castAnim: 0x3f }], // Hyper
  [0x1c, { power:   0, hit:  50, element: 'earth', type: 'petrify', target: 'enemy', anim: 0x00, targeting: 0x2b, castAnim: 0x2f }], // Break
  [0x1d, { power:  85, hit: 100, element: 'ice', type: 'damage', target: 'enemy', anim: 0x00, targeting: 0x0b, castAnim: 0x2f }], // Bzzaga
  [0x1e, { power:   0, hit:  80, element: null, type: 'all_status', target: 'enemy_status', anim: 0x00, targeting: 0x0b, castAnim: 0x2f }], // Shade
  [0x1f, { power:   0, hit: 100, element: null, type: 'damage', target: 'libra', anim: 0x00, targeting: 0x33, castAnim: 0x31 }], // Libra
  [0x20, { power:   0, hit:  25, element: null, type: 'confuse', target: 'enemy_status', anim: 0x00, targeting: 0x13, castAnim: 0x31 }], // Confuse
  [0x21, { power:   0, hit:  60, element: null, type: 'silence', target: 'enemy_status', anim: 0x00, targeting: 0x13, castAnim: 0x31 }], // Sence
  [0x22, { power:  85, hit: 100, element: null, type: 'damage', target: 'enemy', anim: 0x00, targeting: 0x03, castAnim: 0x3f }], // Heatra
  [0x23, { power:  55, hit: 100, element: 'fire', type: 'damage', target: 'enemy', anim: 0x00, targeting: 0x0a, castAnim: 0x2f }], // Fira
  [0x24, { power:  55, hit: 100, element: 'ice', type: 'damage', target: 'enemy', anim: 0x00, targeting: 0x0a, castAnim: 0x2f }], // Bzzara
  [0x25, { power:  55, hit: 100, element: 'bolt', type: 'damage', target: 'enemy', anim: 0x00, targeting: 0x0a, castAnim: 0x2f }], // Tara
  [0x26, { power: 125, hit: 100, element: 'recovery', type: 'damage', target: 'ally', anim: 0x00, targeting: 0x92, castAnim: 0x32 }], // Cura
  [0x27, { power:   0, hit:   0, element: null, type: 'death', target: 'enemy_status', anim: 0x00, targeting: 0x32, castAnim: 0x32 }], // Tport
  [0x28, { power:   0, hit:  75, element: null, type: 'blind', target: 'cure_status', statusMask: 0x04, anim: 0x00, targeting: 0xb1, castAnim: 0x32 }], // Bndna
  [0x29, { power:  65, hit: 100, element: null, type: 'damage', target: 'enemy', anim: 0x00, targeting: 0x02, castAnim: 0x3f }], // Spark
  [0x2a, { power:  35, hit: 100, element: 'bolt', type: 'damage', target: 'enemy', anim: 0x00, targeting: 0x09, castAnim: 0x2f }], // Thunder
  [0x2b, { power:  20, hit:  60, element: null, type: 'poison', target: 'enemy', anim: 0x00, targeting: 0x09, castAnim: 0x2f }], // Poison
  [0x2c, { power:  10, hit:  60, element: null, type: 'blind', target: 'enemy_status', anim: 0x00, targeting: 0x09, castAnim: 0x2f }], // Blind
  [0x2d, { power:  45, hit: 100, element: ['ice','air'], type: 'damage', target: 'enemy', anim: 0x00, targeting: 0x11, castAnim: 0x31 }], // Aero
  [0x2e, { power:   0, hit:   0, element: null, type: 'toad', target: 'toggle_status', statusMask: 0x20, anim: 0x08, targeting: 0x32, castAnim: 0x32 }], // Toad
  [0x2f, { power:   0, hit:   0, element: null, type: 'mini', target: 'toggle_status', statusMask: 0x08, anim: 0x0d, targeting: 0x31, castAnim: 0x32 }], // Mini
  [0x30, { power:  50, hit: 100, element: null, type: 'damage', target: 'enemy', anim: 0x00, targeting: 0x01, castAnim: 0x3f }], // Icen
  [0x31, { power:  25, hit: 100, element: 'fire', type: 'damage', target: 'enemy', anim: 0x00, targeting: 0x08, castAnim: 0x2f }], // Fire
  [0x32, { power:  25, hit: 100, element: 'ice', type: 'damage', target: 'enemy', anim: 0x00, targeting: 0x08, castAnim: 0x2f }], // Bzzard
  [0x33, { power:   0, hit:  15, element: null, type: 'sleep', target: 'enemy_status', anim: 0x00, targeting: 0x08, castAnim: 0x2f }], // Sleep
  [0x34, { power:  42, hit: 100, element: 'recovery', type: 'damage', target: 'ally', anim: 0x00, targeting: 0x90, castAnim: 0x32 }], // Cure
  [0x35, { power:   0, hit:  50, element: null, type: 'poison', target: 'cure_status', statusMask: 0x02, anim: 0x00, targeting: 0xb0, castAnim: 0x32 }], // Poisona
  [0x36, { power:   0, hit: 100, element: null, type: 'damage', target: 'sight', anim: 0x00, targeting: 0x30, castAnim: 0x32 }], // Sight
  [0x37, { power:  40, hit: 100, element: null, type: 'damage', target: 'enemy', anim: 0x00, targeting: 0x00, castAnim: 0x3f }], // Escape
  [0x38, { power:  32, hit: 100, element: null, type: 'damage', target: 'enemy', anim: 0x00, targeting: 0x4f, castAnim: 0x00 }], // Zantetsuken
  [0x39, { power:  40, hit: 100, element: 'fire', type: 'damage', target: 'enemy', anim: 0x10, targeting: 0x4d, castAnim: 0x00 }], // Fire
  [0x3a, { power:  40, hit: 100, element: 'ice', type: 'damage', target: 'enemy', anim: 0x11, targeting: 0x4a, castAnim: 0x00 }], // Blizzard
  [0x3b, { power:  40, hit: 100, element: 'bolt', type: 'damage', target: 'enemy', anim: 0x12, targeting: 0x4a, castAnim: 0x00 }], // Thunder
  [0x3c, { power:   0, hit:  80, element: null, type: 'poison', target: 'enemy', anim: 0x00, targeting: 0x49, castAnim: 0x00 }], // Poison
  [0x3d, { power:  80, hit: 100, element: 'earth', type: 'damage', target: 'enemy', anim: 0x02, targeting: 0x4e, castAnim: 0x00 }], // Earthquake
  [0x3e, { power:   0, hit:  80, element: 'earth', type: 'petrify', target: 'enemy_status', anim: 0x0b, targeting: 0x2e, castAnim: 0x00 }], // Glare
  [0x3f, { power:  30, hit: 100, element: 'recovery', type: 'damage', target: 'restore', anim: 0x00, targeting: 0xb0, castAnim: 0x00 }], // Restore 1
  [0x40, { power:   0, hit: 100, element: null, type: 'damage', target: 'elixir', anim: 0x00, targeting: 0xb0, castAnim: 0x00 }], // Elixir
  [0x41, { power:  37, hit: 100, element: null, type: 'damage', target: 'enemy', anim: 0x0a, targeting: 0x4e, castAnim: 0x00 }], // Tidal Wave
  [0x42, { power:  80, hit: 100, element: null, type: 'damage', target: 'all_enemies', anim: 0x09, targeting: 0x4e, castAnim: 0x00 }], // ParcleBeam
  [0x43, { power:   0, hit: 100, element: null, type: 'damage', target: 'explode', anim: 0x0c, targeting: 0x2a, castAnim: 0x00 }], // Explosion
  [0x44, { power:   0, hit:  80, element: null, type: 'sleep', target: 'enemy_status', anim: 0x0b, targeting: 0x28, castAnim: 0x00 }], // Glare
  [0x45, { power:   0, hit:  80, element: null, type: 'confuse', target: 'enemy_status', anim: 0x0b, targeting: 0x33, castAnim: 0x00 }], // Glare
  [0x46, { power:   0, hit:  60, element: null, type: 'all_status', target: 'enemy_status', anim: 0x00, targeting: 0x2b, castAnim: 0x00 }], // Bad Breath
  [0x47, { power:   0, hit:  80, element: null, type: 'all_status', target: 'enemy_status', anim: 0x0b, targeting: 0x4b, castAnim: 0x00 }], // Mind Blast
  [0x48, { power:   0, hit: 100, element: null, type: 'damage', target: 'summon', anim: 0x06, targeting: 0x80, castAnim: 0x00 }], // Summon
  [0x49, { power:   0, hit: 100, element: null, type: 'damage', target: 'divide', anim: 0x06, targeting: 0x2b, castAnim: 0x00 }], // Divide 1
  [0x4a, { power:  80, hit: 100, element: null, type: 'damage', target: 'enemy', anim: 0x0b, targeting: 0x4f, castAnim: 0x00 }], // Mega Flare
  [0x4b, { power:   0, hit: 100, element: null, type: 'damage', target: 'guard', anim: 0x00, targeting: 0xab, castAnim: 0x00 }], // Guard
  [0x4c, { power:  40, hit: 100, element: null, type: 'damage', target: 'bite', anim: 0x00, targeting: 0x2b, castAnim: 0x00 }], // Bite
  [0x4d, { power:   0, hit: 100, element: null, type: 'damage', target: 'barrier_shift', anim: 0x0b, targeting: 0xab, castAnim: 0x00 }], // BarrrShift
  [0x4e, { power:   0, hit: 100, element: null, type: 'damage', target: 'multiply', anim: 0x06, targeting: 0xab, castAnim: 0x00 }], // Multiply
  [0x4f, { power:   0, hit: 100, element: null, type: 'damage', target: 'divide', anim: 0x06, targeting: 0xab, castAnim: 0x00 }], // Divide 2
  [0x50, { power:  90, hit:  50, element: 'earth', type: 'damage', target: 'enemy', anim: 0x0e, targeting: 0x40, castAnim: 0x00 }], // Earthquake
  [0x51, { power:   0, hit:  30, element: null, type: 'death', target: 'enemy_status', anim: 0x00, targeting: 0x20, castAnim: 0x00 }], // Quicksand
  [0x52, { power: 120, hit:  30, element: 'air', type: 'damage', target: 'all_enemies', anim: 0x00, targeting: 0x20, castAnim: 0x00 }], // Wind Slash
  [0x53, { power:   0, hit:  40, element: null, type: 'death', target: 'enemy_status', anim: 0x00, targeting: 0x20, castAnim: 0x00 }], // Swamp
  [0x54, { power:   0, hit:  40, element: 'bolt', type: 'death', target: 'enemy_status', anim: 0x00, targeting: 0x20, castAnim: 0x00 }], // FastCurrent
  [0x55, { power: 120, hit:  60, element: 'air', type: 'damage', target: 'enemy', anim: 0x00, targeting: 0x20, castAnim: 0x00 }], // Whirlpool
  [0x56, { power: 120, hit:  60, element: 'air', type: 'damage', target: 'enemy', anim: 0x00, targeting: 0x20, castAnim: 0x00 }], // Tornado
  [0x57, { power: 120, hit:  40, element: 'earth', type: 'damage', target: 'enemy', anim: 0x03, targeting: 0x40, castAnim: 0x00 }], // Avalanche
]);
// ─── END GENERATED ───

// Short display names per RPG Shrines (shrines.rpgclassics.com/nes/ff3/spells.shtml).
// These override the IPS-patched ROM names (which use FF6-style Curaja/Curaga/Cura
// for the 4 cure tiers, "Bzzard/Bzzara/Bzzaga/Bzzra" for ice, IPS-author nicknames
// "Catas"/"Hyper" for Odin/Titan, etc.). Used by getSpellNameShrines for the four
// player-facing spell-list sites — battle Magic, pause Magic, magic shop, ally
// inspect — alongside the ROM-baked $72/$74/$75 magic-school icon. 5-char cap
// keeps every row at icon+5 = 6 char-widths, leaving comfortable margin for cost
// or price suffixes at every render site.
//
// Enemy-only spells (0x38+) aren't included; they never appear in the four
// override sites and fall through to ROM names for battle-log strings.
export const SPELL_NAMES_SHRINES = new Map([
  // Black Magic (icon $75)
  [0x02, 'Meteo'],          // L8
  [0x08, 'Brak2'], // L7
  [0x0e, 'Fire3'], // L6
  [0x15, 'Bolt3'], [0x16, 'Kill'],           // L5
  [0x1d, 'Ice3'],  // L4
  [0x23, 'Fire2'], [0x24, 'Ice2'],  [0x25, 'Bolt2'],          // L3
  [0x2a, 'Bolt'],  [0x2b, 'Venom'], // L2
  [0x32, 'Ice'],            // L1
  [0x3a, 'Ice2'],           // L2 (player-cast Bzzra / SouthWind delivery)
  // White Magic (icon $74)
  [0x03, 'WWind'], [0x04, 'Life2'], // L8
  [0x0a, 'Cure4'], [0x0c, 'Wall'],  [0x0b, 'Heal'],           // L7
  [0x11, 'Aero2'], [0x12, 'Soft'],  // L6
  [0x18, 'Cure3'], [0x19, 'Life'],  [0x1a, 'Safe'],           // L5
  [0x20, 'Confu'], [0x21, 'Mute'],           // L4
  [0x26, 'Cure2'], [0x28, 'Wash'],  [0x27, 'Exit'],           // L3
  [0x35, 'Pure'],                                              // L1
  // Call Magic / Summons (icon $72) — one per level
  [0x06, 'Baham'], [0x0d, 'Levia'], [0x14, 'Odin'],  [0x1b, 'Titan'],
  [0x22, 'Ifrit'], [0x29, 'Ramuh'], [0x30, 'Shiva'], [0x37, 'Chocb'],
]);

// MP cost per spell (player-cast). Approximates NES per-level slot cost as a flat MP value.
// In NES FF3, Cure + Poisona both consume one Lv1 white-magic slot — same cost.
// Equalised to 2 MP each so the WM start kit (~6 MP) gives ~3 casts before sleep,
// matching the canonical "3 Lv1 slots" feel.
// Adding a new player-castable spell? Put an entry here OR `getSpellMPCost` will
// warn and return 99 (effectively uncastable) so the omission shows up immediately.
export const SPELL_MP_COST = new Map([
  [0x31, 2],  // Fire (BM Lv1)
  [0x32, 2],  // Bzzard / Blizzard Lv1 (BM)
  [0x33, 3],  // Sleep (BM Lv1 status)
  [0x34, 2],  // Cure
  [0x35, 2],  // Poisona
  [0x36, 2],  // Sight
  [0x3a, 5],  // Blizzara / Bzzra / Ice2 (BM Lv2 — also delivered by SouthWind item)
]);

// Magic-shop buy price per spell (gil). NES FF3 sells level-1 white magic for 100 gil.
export const SPELL_BUY_PRICE = new Map([
  [0x31, 100],  // Fire (BM Lv1)
  [0x32, 100],  // Bzzard / Blizzard Lv1 (BM)
  [0x33, 200],  // Sleep (BM Lv1 status)
  [0x34, 100],  // Cure
  [0x35, 100],  // Poisona
  [0x36, 100],  // Sight
  [0x3a, 700],  // Blizzara / Bzzra (BM Lv2 — placeholder Lv2 price; revisit)
]);

export function getSpellBuyPrice(spellId) {
  return SPELL_BUY_PRICE.get(spellId) ?? 0;
}

// Spells whose target picker offers all-allies / all-enemies / column modes,
// with one rolled amount divided across the chosen targets — same Southwind-
// style split. Item path (potions) never reads this; it stays single-target.
// v1.7.850 — this used to BE the whole answer, and it listed four spells, so 52
// of 56 could only ever be aimed at a single target: Meteo, every Fire2/3,
// Bolt2/3, Ice2/3, Cure2/3/4 and the whole status family.
//
// ⛔ THE CLAIM THAT USED TO STAND HERE WAS WRONG. It read: "The ROM does NOT
// encode single-vs-all for player spells — checked, not assumed: no castable id
// uses the `all_enemies` target byte (0x17 / 0x33)". That check looked at the
// spell record's byte +4 and stopped. The record has EIGHT bytes, and byte +5 —
// which `tools/gen-spells-js.js` had been reading into a local named `targeting`
// and throwing away since the file was written — carries it in bit 6.
//
// Proven causally on the cartridge, both directions, by
// `tools/monscan/spell-target-probe.cjs`: Fire asks which goblin and damages one
// of four. Patch its byte +5 from 0x08 to 0x48 — one bit, nothing else — and the
// same spell stops asking and damages all four. Clear bit 6 on Quake and it
// starts asking. All 56 castable spells were then swept on the cartridge:
// 56/56 agree with "bit 6 set, or a summon".
//
// See `spellHitsAllEnemies` below for what that means, and note what it does
// NOT change: the all/column PICKER this set feeds is ff3mmo's own feature, the
// cartridge has no such thing, and it stays.
//
// The four entries below are ONE PER CATEGORY:
//   'enemy'         Fire 0x31, Blizzard 0x32
//   'enemy_status'  Sleep 0x33
//   'ally'          Cure 0x34
// The rule they demonstrate is generalized below rather than a per-spell list
// being invented, which would mean guessing canon the ROM does not carry.
const MULTI_TARGET_SCOPES = new Set(['enemy', 'enemy_status', 'ally']);

// Kept as an explicit OVERRIDE set for spells the scope rule cannot know about.
export const MULTI_TARGET_SPELLS = new Set([
  0x31,  // Fire    (BM Lv1)
  0x32,  // Blizzard (BM Lv1)
  0x33,  // Sleep   (BM Lv1 status)
  0x34,  // Cure    (WM Lv1)
]);

export function isMultiTargetSpell(spellId) {
  if (MULTI_TARGET_SPELLS.has(spellId)) return true;
  // Summons decide all-vs-single through the TIER system (`summon-tier.js`):
  // an Evoker's pick is single-target and a Summoner's is always all. Offering
  // the picker as well would let the player override the tier.
  if (SUMMON_TIERS.has(spellId)) return false;
  const spell = SPELLS.get(spellId);
  return !!spell && MULTI_TARGET_SCOPES.has(spell.target);
}

// Byte +5 of the spell record. Bit 6 is the one that matters here; bit 7 marks
// a party-side spell and the low bits are the effect/art index.
export const TARGETING_ALL_ENEMIES = 0x40;
export const TARGETING_PARTY_SIDE  = 0x80;

/**
 * Does this spell hit EVERY enemy on its own, with no target select at all?
 *
 * ⛔ MEASURED ON THE CARTRIDGE, NOT CHOSEN. Three spells: Meteor 0x02,
 * Quake 0x07, Raze 0x16. Picking any of them in FF3 commits immediately — the
 * game never opens a target cursor — and all four bodies of a four-goblin
 * formation lose HP within ONE FRAME of each other. Picking Fire opens a cursor
 * on one goblin and damages exactly that one. Full method and the 56/56 sweep:
 * `tools/monscan/spell-target-probe.cjs`, gate `tools/check-spell-targeting.mjs`.
 *
 * ⛔ SUMMONS ARE DELIBERATELY EXCLUDED. On the cartridge all eight also skip
 * target select, but in this game a summon's reach is the TIER system's call —
 * a Conjurer's roll can land on a single-target attack, a Summoner's third
 * effect always hits everyone (`resolveSummonEffect` / `summon-tiers.js`).
 * Routing them through here would silently overrule that. It is a KNOWN,
 * intentional divergence, not an oversight; see docs/design-notes.md#magic.
 */
export function spellHitsAllEnemies(spellId) {
  if (SUMMON_TIERS.has(spellId)) return false;
  const spell = SPELLS.get(spellId);
  return !!spell && (spell.targeting & TARGETING_ALL_ENEMIES) !== 0;
}

/**
 * The set of STATUS bits a cure-status / toggle-status spell acts on.
 *
 * SINGLE SOURCE for the three call sites that resolve this (in-battle cast,
 * out-of-battle cast, ally cast). All three used to do
 * `STATUS_NAME_TO_FLAG[spell.type]`, which is wrong for this spell family:
 * for target bytes 0x06 and 0x07 the ROM's byte +3 is a BITMASK of NES status
 * bits, not a single type, and the generator's `typeJS` names it lossily.
 *
 * Heal's mask is 0xFF and got named 'cure_status'; Soft's is 0x07 and collided
 * with the unrelated 'haste' entry. Neither name is in STATUS_NAME_TO_FLAG, so
 * both resolved to `undefined` and cured NOTHING — `mask &= ~undefined` leaves
 * the mask untouched. Wash (0x04) and Pure (0x02) only worked because their
 * masks happen to be single bits whose names round-trip.
 *
 * The mask's bit order IS `STATUS` in status-effects.js, which was derived
 * from this same NES byte. Falls back to the name for any spell the generator
 * has not stamped. v1.7.855.
 */
export function spellStatusMask(spell) {
  if (!spell) return 0;
  if (spell.statusMask != null) return spell.statusMask;
  return STATUS_NAME_TO_FLAG[spell.type] || 0;
}

// ── Spell school dispatch (job gating) ────────────────────────────────────
//
// Schools:
//   'white' — recovery, status-cure, revive, sight (defensive/utility)
//   'black' — damage, debuffs, instant-death (offensive)
//   'call'  — summons (Caller job, deferred — no entries yet)
//
// Only player-castable spells need entries. Add a row when you wire a new
// spell so the magic shop / battle menu / pause menu gate it correctly.
const SPELL_SCHOOL = new Map([
  [0x31, 'black'],  // Fire
  [0x32, 'black'],  // Bzzard / Blizzard Lv1
  [0x33, 'black'],  // Sleep Lv1
  [0x34, 'white'],  // Cure
  [0x35, 'white'],  // Poisona
  [0x36, 'white'],  // Sight
  [0x3a, 'black'],  // Blizzara / Bzzra Lv2 (also delivered by SouthWind item via animSpellId)
]);

/**
 * Magic level of a player-castable spell, 1-8, or 0 if it is not one.
 *
 * Layout read off the game's own magic menu: levels 8 down to 2 are blocks of
 * SEVEN — 3 black, 3 white, 1 summon — and level 1 is the short block $31-$36
 * with the summon at $37. IDs $38+ are monster-only abilities.
 */
export function getSpellLevel(spellId) {
  if (spellId == null || spellId < 0) return 0;
  if (spellId <= 0x30) return 8 - Math.floor(spellId / 7);
  if (spellId <= 0x37) return 1;
  return 0;
}

/**
 * School of a spell: 'black' | 'white' | 'call' | null.
 *
 * DERIVED, not enumerated. The old table listed seven spells — the ones that
 * shipped first — so every other spell resolved to null and was uncastable no
 * matter the job. That is why granting a full school produced an empty magic
 * menu. SPELL_SCHOOL now only holds exceptions the position rule cannot know,
 * such as $3a (a monster-ability ID the SouthWind item routes through).
 */
export function getSpellSchool(spellId) {
  const override = SPELL_SCHOOL.get(spellId);
  if (override) return override;
  if (spellId == null || spellId > 0x37 || spellId < 0) return null;
  const col = spellId <= 0x30 ? spellId % 7 : spellId - 0x31;
  if (col <= 2) return 'black';
  if (col <= 5) return 'white';
  return 'call';
}

/**
 * Can `jobIdx` cast `spellId`? School match AND magic-level cap.
 *
 * Reads the job's own `magic` flags rather than a hardcoded job list. The old
 * table covered jobs 3, 4, 5 and 9 only — so Sage, Conjurer, Summoner, Devout,
 * Magus, Ranger and Magic Knight could cast nothing at all, and its "9 = Caller"
 * entry was wrong anyway (job 9 is the Scholar).
 *
 * The level cap is real and the ROM enforces it: Black and White Mage stop at
 * magic level 7 and the game refuses a level-8 pick outright.
 */
export function canCastSpell(jobIdx, spellId) {
  const school = getSpellSchool(spellId);
  if (!school) return false;
  const job = JOBS[jobIdx];
  if (!job || !job.magic) return false;
  const bit = school === 'white' ? MAG_WHITE : school === 'black' ? MAG_BLACK : MAG_CALL;
  if (!(job.magic & bit)) return false;
  const lvl = getSpellLevel(spellId);
  return lvl > 0 && lvl <= job.maxMagicLv;
}

export function canLearnSpell(jobIdx, spellId) {
  return canCastSpell(jobIdx, spellId);
}

// Filter a known-spells list down to what the current job can actually cast.
// Use this anywhere the magic UI builds a list from ps.knownSpells (battle
// menu, pause menu) so a hybrid player carrying off-school spells from a
// past job doesn't see unusable entries.
export function getCastableKnownSpells(jobIdx, knownSpells) {
  if (!Array.isArray(knownSpells)) return [];
  return knownSpells.filter(id => canCastSpell(jobIdx, id));
}

// Returns the spell's flat MP cost. If a player-castable spell is missing from
// SPELL_MP_COST, that's a bug — warn once and return 99 (effectively uncastable)
// so the omission surfaces in playtest instead of silently making the spell free.
const _warnedMissingMP = new Set();
export function getSpellMPCost(spellId) {
  const v = SPELL_MP_COST.get(spellId);
  if (v != null) return v;
  // Scale by magic LEVEL rather than defaulting to 99. The explicit table holds
  // seven spells — the ones that shipped first — so the other fifty cost 99 MP
  // and were uncastable even once the menu listed them. Level x 2 matches the
  // entries that do exist (level-1 spells cost 2-3, the one level-2 entry 5),
  // so nothing already balanced moves; the table still wins where it has a row.
  const lvl = getSpellLevel(spellId);
  if (lvl > 0) return lvl * 2;
  if (!_warnedMissingMP.has(spellId)) {
    _warnedMissingMP.add(spellId);
    console.warn(`[spells] no SPELL_MP_COST entry and no level for spell $${spellId.toString(16).padStart(2,'0')} — defaulting to 99`);
  }
  return 99;
}
