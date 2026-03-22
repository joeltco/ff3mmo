// MMO roster data — fake player pool, palette table, chat phrases

export const LOCATIONS = ['world', 'ur', 'cave-0', 'cave-1', 'cave-2', 'cave-3', 'crystal'];

// Each player has a current location that changes over time (loc is mutated at runtime)
export const PLAYER_POOL = [
  { name: 'Zephyr',  level: 5,  palIdx: 1, camper: false, loc: 'ur' },
  { name: 'Mira',    level: 4,  palIdx: 2, camper: false, loc: 'world' },
  { name: 'Aldric',  level: 5,  palIdx: 3, camper: true,  loc: 'ur' },
  { name: 'Suki',    level: 3,  palIdx: 4, camper: false, loc: 'cave-0' },
  { name: 'Fenris',  level: 5,  palIdx: 5, camper: false, loc: 'cave-1' },
  { name: 'Lenna',   level: 5,  palIdx: 6, camper: true,  loc: 'ur' },
  { name: 'Grok',    level: 5,  palIdx: 7, camper: false, loc: 'cave-3' },
  { name: 'Ivy',     level: 2,  palIdx: 0, camper: false, loc: 'ur' },
  { name: 'Rook',    level: 5,  palIdx: 3, camper: false, loc: 'cave-2' },
  { name: 'Tora',    level: 5,  palIdx: 5, camper: false, loc: 'world' },
  { name: 'Blix',    level: 4,  palIdx: 7, camper: false, loc: 'cave-0' },
  { name: 'Cassia',  level: 5,  palIdx: 6, camper: true,  loc: 'cave-1' },
  { name: 'Duran',   level: 5,  palIdx: 1, camper: false, loc: 'crystal' },
  { name: 'Nyx',     level: 1,  palIdx: 4, camper: false, loc: 'ur' },
  { name: 'Orin',    level: 4,  palIdx: 0, camper: false, loc: 'world' },
  { name: 'Pip',     level: 3,  palIdx: 2, camper: false, loc: 'cave-0' },
  { name: 'Vex',     level: 5,  palIdx: 7, camper: false, loc: 'cave-2' },
  { name: 'Wren',    level: 4,  palIdx: 5, camper: false, loc: 'world' },
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
