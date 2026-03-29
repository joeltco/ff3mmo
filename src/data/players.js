// MMO roster data — fake player pool, palette table, chat phrases

export const LOCATIONS = ['world', 'ur', 'cave-0', 'cave-1', 'cave-2', 'cave-3', 'crystal'];

// Each player has a current location that changes over time (loc is mutated at runtime)
export const PLAYER_POOL = [
  { name: 'Zephyr',  level: 5,  palIdx: 1, camper: false, loc: 'ur',      weaponR: 0x1E },                    // Knife
  { name: 'Mira',    level: 4,  palIdx: 2, camper: false, loc: 'world',   weaponR: 0x1E, weaponL: 0x1E },     // Knife × 2 (dual)
  { name: 'Aldric',  level: 5,  palIdx: 3, camper: true,  loc: 'ur',      weaponR: 0x1E },                    // Knife
  { name: 'Suki',    level: 3,  palIdx: 4, camper: false, loc: 'cave-0',  weaponR: 0x1E },                    // Knife
  { name: 'Fenris',  level: 5,  palIdx: 5, camper: false, loc: 'cave-1',  weaponR: 0x1F },                    // Dagger
  { name: 'Lenna',   level: 5,  palIdx: 6, camper: true,  loc: 'ur',      weaponR: 0x1E },                    // Knife
  { name: 'Grok',    level: 5,  palIdx: 7, camper: false, loc: 'cave-3',  weaponR: 0x24 },                    // Longsword
  { name: 'Ivy',     level: 2,  palIdx: 0, camper: false, loc: 'ur',      weaponR: 0x1E },                    // Knife
  { name: 'Rook',    level: 5,  palIdx: 3, camper: false, loc: 'cave-2',  weaponR: 0x24 },                    // Longsword
  { name: 'Tora',    level: 5,  palIdx: 5, camper: false, loc: 'world',   weaponR: 0x1F },                    // Dagger
  { name: 'Blix',    level: 4,  palIdx: 7, camper: false, loc: 'cave-0',  weaponR: 0x1F },                    // Dagger
  { name: 'Cassia',  level: 5,  palIdx: 6, camper: true,  loc: 'cave-1',  weaponR: 0x1F },                    // Dagger
  { name: 'Duran',   level: 5,  palIdx: 1, camper: false, loc: 'crystal', weaponR: 0x24 },                    // Longsword
  { name: 'Nyx',     level: 1,  palIdx: 4, camper: false, loc: 'ur',      weaponR: 0x1E },                    // Knife
  { name: 'Orin',    level: 4,  palIdx: 0, camper: false, loc: 'world',   weaponR: 0x1F, weaponL: 0x1E },     // Dagger + Knife (dual)
  { name: 'Pip',     level: 3,  palIdx: 2, camper: false, loc: 'cave-0',  weaponR: 0x1E },                    // Knife
  { name: 'Vex',     level: 5,  palIdx: 7, camper: false, loc: 'cave-2',  weaponR: 0x24 },                    // Longsword
  { name: 'Wren',    level: 4,  palIdx: 5, camper: false, loc: 'world',   weaponR: 0x1F },                    // Dagger
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


export const ROSTER_FADE_STEPS = 4;

export function generateAllyStats(player) {
  const lv = player.level;
  const str = 5 + lv;
  const agi = 5 + lv;
  const vit = 5 + lv;
  const hp = 28 + lv * 6;
  const loc = player.loc;
  // Gear by location (matches chest loot tiers)
  let weaponId = 0x1E, weaponAtk = 6, totalDef = 1; // default: Knife + Cap
  if (loc === 'cave-1') { weaponId = 0x1F; weaponAtk = 8; totalDef = 3; }
  else if (loc === 'cave-2') { weaponId = 0x24; weaponAtk = 10; totalDef = 3; }
  else if (loc === 'cave-3' || loc === 'crystal') { weaponId = 0x24; weaponAtk = 10; totalDef = 7; }
  // Override with explicit weapon slots if defined on player entry
  if (player.weaponR != null) weaponId = player.weaponR;
  const weaponL = player.weaponL != null ? player.weaponL : null;
  const atk = str + weaponAtk;
  const def = vit + totalDef;
  return { name: player.name, palIdx: player.palIdx, level: lv, hp, maxHP: hp, atk, def, agi, weaponId, weaponL, fadeStep: ROSTER_FADE_STEPS };
}
