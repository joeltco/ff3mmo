// MMO roster data — fake player pool, palette table, chat phrases
import { ITEMS } from './items.js';

export const LOCATIONS = ['world', 'ur', 'cave-0', 'cave-1', 'cave-2', 'cave-3', 'crystal'];

// Each player has a current location that changes over time (loc is mutated at runtime)
export const PLAYER_POOL = [
  // jobIdx: 0=Onion Knight, 1=Fighter. Sword users are Fighters.
  { name: 'Zephyr',  level: 5,  palIdx: 1, camper: false, loc: 'ur',      jobIdx: 0, weaponR: 0x1E,               armorId: 0x73, helmId: 0x62, shieldId: 0x58 }, // OK — Knife / Leather+Cap+Shield
  { name: 'Mira',    level: 4,  palIdx: 2, camper: false, loc: 'world',   jobIdx: 0, weaponR: 0x1E, weaponL: 0x1E, armorId: 0x73, helmId: 0x62 },                // OK — Knife×2 / Leather+Cap
  { name: 'Aldric',  level: 5,  palIdx: 3, camper: true,  loc: 'ur',      jobIdx: 1, weaponR: 0x24,               armorId: 0x73, helmId: 0x62, shieldId: 0x58 }, // Fi — Longsword / Leather+Cap+Shield
  { name: 'Suki',    level: 3,  palIdx: 4, camper: false, loc: 'cave-0',  jobIdx: 0, weaponR: 0x1E,               armorId: 0x73, helmId: 0x62 },                 // OK — Knife / Leather+Cap
  { name: 'Fenris',  level: 5,  palIdx: 5, camper: false, loc: 'cave-1',  jobIdx: 1, weaponR: 0x1F,               armorId: 0x73, helmId: 0x62, shieldId: 0x58 }, // Fi — Dagger / Leather+Cap+Shield
  { name: 'Lenna',   level: 5,  palIdx: 6, camper: true,  loc: 'ur',      jobIdx: 0, weaponR: 0x1E,               armorId: 0x73, helmId: 0x62 },                 // OK — Knife / Leather+Cap
  { name: 'Grok',    level: 5,  palIdx: 7, camper: false, loc: 'cave-3',  jobIdx: 1, weaponR: 0x24,               armorId: 0x73, helmId: 0x62, shieldId: 0x58 }, // Fi — Longsword / Leather+Cap+Shield
  { name: 'Ivy',     level: 2,  palIdx: 0, camper: false, loc: 'ur',      jobIdx: 0, weaponR: 0x1E,               armorId: 0x73, helmId: 0x62 },                 // OK — Knife / Leather+Cap
  { name: 'Rook',    level: 5,  palIdx: 3, camper: false, loc: 'cave-2',  jobIdx: 1, weaponR: 0x24,               armorId: 0x73, helmId: 0x62, shieldId: 0x58 }, // Fi — Longsword / Leather+Cap+Shield
  { name: 'Tora',    level: 5,  palIdx: 5, camper: false, loc: 'world',   jobIdx: 0, weaponR: 0x1F,               armorId: 0x73, helmId: 0x62 },                 // OK — Dagger / Leather+Cap
  { name: 'Blix',    level: 4,  palIdx: 7, camper: false, loc: 'cave-0',  jobIdx: 0, weaponR: 0x1F,               armorId: 0x73, helmId: 0x62 },                 // OK — Dagger / Leather+Cap
  { name: 'Cassia',  level: 5,  palIdx: 6, camper: true,  loc: 'cave-1',  jobIdx: 1, weaponR: 0x28,               armorId: 0x73, helmId: 0x62, shieldId: 0x58 }, // Fi — Serpent Sword / Leather+Cap+Shield
  { name: 'Duran',   level: 5,  palIdx: 1, camper: false, loc: 'crystal', jobIdx: 1, weaponR: 0x24,               armorId: 0x73, helmId: 0x62, shieldId: 0x58 }, // Fi — Longsword / Leather+Cap+Shield
  { name: 'Nyx',     level: 1,  palIdx: 4, camper: false, loc: 'ur',      jobIdx: 0, weaponR: 0x1E,               armorId: 0x73, helmId: 0x62 },                 // OK — Knife / Leather+Cap
  { name: 'Orin',    level: 4,  palIdx: 0, camper: false, loc: 'world',   jobIdx: 1, weaponR: 0x1F, weaponL: 0x1E, armorId: 0x73, helmId: 0x62 },                // Fi — Dagger+Knife / Leather+Cap
  { name: 'Pip',     level: 3,  palIdx: 2, camper: false, loc: 'cave-0',  jobIdx: 0, weaponR: 0x1E,               armorId: 0x73, helmId: 0x62 },                 // OK — Knife / Leather+Cap
  { name: 'Vex',     level: 5,  palIdx: 7, camper: false, loc: 'cave-2',  jobIdx: 1, weaponR: 0x24,               armorId: 0x73, helmId: 0x62, shieldId: 0x58 }, // Fi — Longsword / Leather+Cap+Shield
  { name: 'Wren',    level: 4,  palIdx: 5, camper: false, loc: 'world',   jobIdx: 0, weaponR: 0x1F,               armorId: 0x73, helmId: 0x62 },                 // OK — Dagger / Leather+Cap
  { name: 'Kasumi',  level: 4,  palIdx: 4, camper: false, loc: 'cave-0',  jobIdx: 2, weaponR: 0x06,               armorId: 0x73, helmId: 0x62 },                 // Mo — Nunchuck / Leather+Cap
  { name: 'Jiro',    level: 5,  palIdx: 2, camper: false, loc: 'ur',      jobIdx: 2, weaponR: 0,                  armorId: 0x73, helmId: 0x62 },                 // Mo — Unarmed / Leather+Cap
  { name: 'Ryuji',   level: 5,  palIdx: 7, camper: false, loc: 'cave-2',  jobIdx: 2, weaponR: 0x06,               armorId: 0x73, helmId: 0x62 },                 // Mo — Nunchuck / Leather+Cap
  { name: 'Hana',    level: 3,  palIdx: 5, camper: false, loc: 'world',   jobIdx: 2, weaponR: 0,                  armorId: 0x73, helmId: 0x62 },                 // Mo — Unarmed / Leather+Cap
  { name: 'Tetsuo',  level: 5,  palIdx: 3, camper: true,  loc: 'cave-1',  jobIdx: 2, weaponR: 0,                  armorId: 0x73, helmId: 0x62 },                 // Mo — Unarmed / Leather+Cap
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
  // Calculate totalDef from explicit armor if defined
  if (player.armorId != null || player.helmId != null || player.shieldId != null) {
    totalDef = 0;
    if (player.armorId  != null) totalDef += (ITEMS.get(player.armorId)  || {}).def || 0;
    if (player.helmId   != null) totalDef += (ITEMS.get(player.helmId)   || {}).def || 0;
    if (player.shieldId != null) totalDef += (ITEMS.get(player.shieldId) || {}).def || 0;
  }
  const atk = str + weaponAtk;
  const def = vit + totalDef;
  // Evade/mdef/sResist from armor
  let evade = 0, mdef = 0, statusResist = 0;
  if (player.armorId != null) { const a = ITEMS.get(player.armorId) || {}; evade += a.evade || 0; mdef += a.mdef || 0; statusResist |= a.sResist || 0; }
  if (player.helmId != null) { const a = ITEMS.get(player.helmId) || {}; evade += a.evade || 0; mdef += a.mdef || 0; statusResist |= a.sResist || 0; }
  let shieldEvade = 0;
  if (player.shieldId != null) { const a = ITEMS.get(player.shieldId) || {}; mdef += a.mdef || 0; statusResist |= a.sResist || 0; shieldEvade = a.evade || 0; }
  // Hit rate from weapon, attack roll from AGI
  const wpnItem = ITEMS.get(weaponId);
  const hitRate = wpnItem ? (wpnItem.hit || 80) : 80;
  return { name: player.name, palIdx: player.palIdx, jobIdx: player.jobIdx || 0, level: lv, hp, maxHP: hp, atk, def, agi, evade, mdef, shieldEvade, statusResist, hitRate, weaponId, weaponL, jobLevel: 1, fadeStep: ROSTER_FADE_STEPS };
}
