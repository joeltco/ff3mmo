// Spell Catalog — keyed by spell ID (0x00–0x57)
// AUTO-GENERATED from FF3 NES ROM via tools/gen-spells-js.js
// Stats from Data Crystal ROM map ($618D0, 8 bytes per spell)
// IDs 0-55: player/enemy magic, 56+: monster-only abilities

export const SPELLS = new Map([
  [0x00, { power: 200, hit: 100, element: null, type: 'damage', target: 'enemy', anim: 0x00 }], // Flare
  [0x01, { power:   0, hit:  35, element: null, type: 'death', target: 'enemy_status', anim: 0x00 }], // Death
  [0x02, { power: 180, hit: 100, element: null, type: 'damage', target: 'enemy', anim: 0x03 }], // Meteor
  [0x03, { power:   4, hit:  40, element: 'air', type: 'damage', target: 'enemy', anim: 0x00 }], // Tornado
  [0x04, { power: 255, hit:   0, element: 'recovery', type: 'death', target: 'revive', anim: 0x05 }], // Arise
  [0x05, { power: 160, hit: 100, element: 'holy', type: 'damage', target: 'enemy', anim: 0x00 }], // Holy
  [0x06, { power: 250, hit: 100, element: null, type: 'damage', target: 'enemy', anim: 0x00 }], // Bahamur
  [0x07, { power: 133, hit: 100, element: 'earth', type: 'damage', target: 'enemy', anim: 0x02 }], // Quake
  [0x08, { power:   0, hit:  40, element: 'earth', type: 'petrify', target: 'enemy_status', anim: 0x07 }], // Breakga
  [0x09, { power: 160, hit: 100, element: 'recovery', type: 'damage', target: 'drain', anim: 0x04 }], // Drain
  [0x0a, { power: 220, hit: 100, element: 'recovery', type: 'damage', target: 'ally', anim: 0x00 }], // Curaja
  [0x0b, { power:   0, hit:  60, element: null, type: 'cure_status', target: 'cure_status', anim: 0x00 }], // Esuna
  [0x0c, { power:   0, hit:  75, element: null, type: 'damage', target: 'reflect', anim: 0x00 }], // Reflect
  [0x0d, { power: 180, hit: 100, element: null, type: 'damage', target: 'enemy', anim: 0x00 }], // Leviath
  [0x0e, { power: 150, hit: 100, element: 'fire', type: 'damage', target: 'enemy', anim: 0x00 }], // Firaga
  [0x0f, { power: 130, hit: 100, element: null, type: 'damage', target: 'enemy', anim: 0x00 }], // Bio
  [0x10, { power:   0, hit:   0, element: null, type: 'death', target: 'enemy_status', anim: 0x00 }], // Warp
  [0x11, { power: 115, hit: 100, element: ['ice','air'], type: 'damage', target: 'enemy', anim: 0x00 }], // Aeroga
  [0x12, { power:   0, hit:  60, element: null, type: 'haste', target: 'cure_status', anim: 0x00 }], // Stone
  [0x13, { power:   5, hit:  16, element: null, type: 'damage', target: 'haste', anim: 0x00 }], // Haste
  [0x14, { power: 150, hit: 100, element: null, type: 'damage', target: 'enemy', anim: 0x00 }], // Catas
  [0x15, { power: 110, hit: 100, element: 'bolt', type: 'damage', target: 'enemy', anim: 0x00 }], // Taga
  [0x16, { power: 100, hit: 100, element: null, type: 'death', target: 'enemy_status', anim: 0x01 }], // Raze
  [0x17, { power:   0, hit:  60, element: null, type: 'damage', target: 'erase', anim: 0x00 }], // Erase
  [0x18, { power: 180, hit: 100, element: 'recovery', type: 'damage', target: 'ally', anim: 0x00 }], // Curaga
  [0x19, { power:   1, hit:  15, element: 'recovery', type: 'death', target: 'revive', anim: 0x05 }], // Raise
  [0x1a, { power:   5, hit:  75, element: null, type: 'damage', target: 'protect', anim: 0x00 }], // Protect
  [0x1b, { power: 120, hit: 100, element: null, type: 'damage', target: 'enemy', anim: 0x00 }], // Hyper
  [0x1c, { power:   0, hit:  50, element: 'earth', type: 'petrify', target: 'enemy', anim: 0x00 }], // Break
  [0x1d, { power:  85, hit: 100, element: 'ice', type: 'damage', target: 'enemy', anim: 0x00 }], // Bzzaga
  [0x1e, { power:   0, hit:  80, element: null, type: 'all_status', target: 'enemy_status', anim: 0x00 }], // Shade
  [0x1f, { power:   0, hit: 100, element: null, type: 'damage', target: 'libra', anim: 0x00 }], // Libra
  [0x20, { power:   0, hit:  25, element: null, type: 'confuse', target: 'enemy_status', anim: 0x00 }], // Confuse
  [0x21, { power:   0, hit:  60, element: null, type: 'silence', target: 'enemy_status', anim: 0x00 }], // Sence
  [0x22, { power:  85, hit: 100, element: null, type: 'damage', target: 'enemy', anim: 0x00 }], // Heatra
  [0x23, { power:  55, hit: 100, element: 'fire', type: 'damage', target: 'enemy', anim: 0x00 }], // Fira
  [0x24, { power:  55, hit: 100, element: 'ice', type: 'damage', target: 'enemy', anim: 0x00 }], // Bzzara
  [0x25, { power:  55, hit: 100, element: 'bolt', type: 'damage', target: 'enemy', anim: 0x00 }], // Tara
  [0x26, { power: 125, hit: 100, element: 'recovery', type: 'damage', target: 'ally', anim: 0x00 }], // Cura
  [0x27, { power:   0, hit:   0, element: null, type: 'death', target: 'enemy_status', anim: 0x00 }], // Tport
  [0x28, { power:   0, hit:  75, element: null, type: 'blind', target: 'cure_status', anim: 0x00 }], // Bndna
  [0x29, { power:  65, hit: 100, element: null, type: 'damage', target: 'enemy', anim: 0x00 }], // Spark
  [0x2a, { power:  35, hit: 100, element: 'bolt', type: 'damage', target: 'enemy', anim: 0x00 }], // Thunder
  [0x2b, { power:  20, hit:  60, element: null, type: 'poison', target: 'enemy', anim: 0x00 }], // Poison
  [0x2c, { power:  10, hit:  60, element: null, type: 'blind', target: 'enemy_status', anim: 0x00 }], // Blind
  [0x2d, { power:  45, hit: 100, element: ['ice','air'], type: 'damage', target: 'enemy', anim: 0x00 }], // Aero
  [0x2e, { power:   0, hit:   0, element: null, type: 'toad', target: 'toggle_status', anim: 0x08 }], // Toad
  [0x2f, { power:   0, hit:   0, element: null, type: 'mini', target: 'toggle_status', anim: 0x0d }], // Mini
  [0x30, { power:  50, hit: 100, element: null, type: 'damage', target: 'enemy', anim: 0x00 }], // Icen
  [0x31, { power:  25, hit: 100, element: 'fire', type: 'damage', target: 'enemy', anim: 0x00 }], // Fire
  [0x32, { power:  25, hit: 100, element: 'ice', type: 'damage', target: 'enemy', anim: 0x00 }], // Bzzard
  [0x33, { power:   0, hit:  15, element: null, type: 'sleep', target: 'enemy_status', anim: 0x00 }], // Sleep
  [0x34, { power:  42, hit: 100, element: 'recovery', type: 'damage', target: 'ally', anim: 0x00 }], // Cure
  [0x35, { power:   0, hit:  50, element: null, type: 'poison', target: 'cure_status', anim: 0x00 }], // Poisona
  [0x36, { power:   0, hit: 100, element: null, type: 'damage', target: 'sight', anim: 0x00 }], // Sight
  [0x37, { power:  40, hit: 100, element: null, type: 'damage', target: 'enemy', anim: 0x00 }], // Escape
  [0x38, { power:  32, hit: 100, element: null, type: 'damage', target: 'enemy', anim: 0x00 }], // Zantetsuken
  [0x39, { power:  40, hit: 100, element: 'fire', type: 'damage', target: 'enemy', anim: 0x10 }], // Fire
  [0x3a, { power:  40, hit: 100, element: 'ice', type: 'damage', target: 'enemy', anim: 0x11 }], // Blizzard
  [0x3b, { power:  40, hit: 100, element: 'bolt', type: 'damage', target: 'enemy', anim: 0x12 }], // Thunder
  [0x3c, { power:   0, hit:  80, element: null, type: 'poison', target: 'enemy', anim: 0x00 }], // Poison
  [0x3d, { power:  80, hit: 100, element: 'earth', type: 'damage', target: 'enemy', anim: 0x02 }], // Earthquake
  [0x3e, { power:   0, hit:  80, element: 'earth', type: 'petrify', target: 'enemy_status', anim: 0x0b }], // Glare
  [0x3f, { power:  30, hit: 100, element: 'recovery', type: 'damage', target: 'restore', anim: 0x00 }], // Restore 1
  [0x40, { power:   0, hit: 100, element: null, type: 'damage', target: 'elixir', anim: 0x00 }], // Elixir
  [0x41, { power:  37, hit: 100, element: null, type: 'damage', target: 'enemy', anim: 0x0a }], // Tidal Wave
  [0x42, { power:  80, hit: 100, element: null, type: 'damage', target: 'all_enemies', anim: 0x09 }], // ParcleBeam
  [0x43, { power:   0, hit: 100, element: null, type: 'damage', target: 'explode', anim: 0x0c }], // Explosion
  [0x44, { power:   0, hit:  80, element: null, type: 'sleep', target: 'enemy_status', anim: 0x0b }], // Glare
  [0x45, { power:   0, hit:  80, element: null, type: 'confuse', target: 'enemy_status', anim: 0x0b }], // Glare
  [0x46, { power:   0, hit:  60, element: null, type: 'all_status', target: 'enemy_status', anim: 0x00 }], // Bad Breath
  [0x47, { power:   0, hit:  80, element: null, type: 'all_status', target: 'enemy_status', anim: 0x0b }], // Mind Blast
  [0x48, { power:   0, hit: 100, element: null, type: 'damage', target: 'summon', anim: 0x06 }], // Summon
  [0x49, { power:   0, hit: 100, element: null, type: 'damage', target: 'divide', anim: 0x06 }], // Divide 1
  [0x4a, { power:  80, hit: 100, element: null, type: 'damage', target: 'enemy', anim: 0x0b }], // Mega Flare
  [0x4b, { power:   0, hit: 100, element: null, type: 'damage', target: 'guard', anim: 0x00 }], // Guard
  [0x4c, { power:  40, hit: 100, element: null, type: 'damage', target: 'bite', anim: 0x00 }], // Bite
  [0x4d, { power:   0, hit: 100, element: null, type: 'damage', target: 'barrier_shift', anim: 0x0b }], // BarrrShift
  [0x4e, { power:   0, hit: 100, element: null, type: 'damage', target: 'multiply', anim: 0x06 }], // Multiply
  [0x4f, { power:   0, hit: 100, element: null, type: 'damage', target: 'divide', anim: 0x06 }], // Divide 2
  [0x50, { power:  90, hit:  50, element: 'earth', type: 'damage', target: 'enemy', anim: 0x0e }], // Earthquake
  [0x51, { power:   0, hit:  30, element: null, type: 'death', target: 'enemy_status', anim: 0x00 }], // Quicksand
  [0x52, { power: 120, hit:  30, element: 'air', type: 'damage', target: 'all_enemies', anim: 0x00 }], // Wind Slash
  [0x53, { power:   0, hit:  40, element: null, type: 'death', target: 'enemy_status', anim: 0x00 }], // Swamp
  [0x54, { power:   0, hit:  40, element: 'bolt', type: 'death', target: 'enemy_status', anim: 0x00 }], // FastCurrent
  [0x55, { power: 120, hit:  60, element: 'air', type: 'damage', target: 'enemy', anim: 0x00 }], // Whirlpool
  [0x56, { power: 120, hit:  60, element: 'air', type: 'damage', target: 'enemy', anim: 0x00 }], // Tornado
  [0x57, { power: 120, hit:  40, element: 'earth', type: 'damage', target: 'enemy', anim: 0x03 }], // Avalanche
]);
