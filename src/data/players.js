// MMO roster data — fake player pool, palette table, chat phrases
import { ITEMS } from './items.js';
import { calcAttackerAtk } from '../battle-math.js';
import { createStatusState } from '../status-effects.js';

export const LOCATIONS = ['world', 'ur', 'cave-0', 'cave-1', 'cave-2', 'cave-3', 'crystal'];

// Each player has a current location that changes over time (loc is mutated at runtime)
export const PLAYER_POOL = [
  // jobIdx: 0=Onion Knight, 1=Fighter. Sword users are Fighters.
  { name: 'Zephyr',  level: 5,  palIdx: 1, camper: false, loc: 'cave-3',  jobIdx: 3, weaponR: 0x0E,               armorId: 0x73, helmId: 0x62, knownSpells: [0x34, 0x35] }, // WM — Staff / Leather+Cap (Cure, Poisona)
  { name: 'Mira',    level: 4,  palIdx: 2, camper: false, loc: 'world',   jobIdx: 3, weaponR: 0x0E,               armorId: 0x73, helmId: 0x62, knownSpells: [0x34, 0x35] }, // WM — Staff / Leather+Cap (Cure, Poisona)
  { name: 'Aldric',  level: 5,  palIdx: 3, camper: true,  loc: 'ur',      jobIdx: 1, weaponR: 0x24,               armorId: 0x73, helmId: 0x62, shieldId: 0x58 }, // Fi — Longsword / Leather+Cap+Shield
  { name: 'Suki',    level: 3,  palIdx: 4, camper: false, loc: 'cave-1',  jobIdx: 3, weaponR: 0x0E,               armorId: 0x73, helmId: 0x62, knownSpells: [0x34, 0x35] }, // WM — Staff / Leather+Cap (Cure, Poisona)
  { name: 'Fenris',  level: 5,  palIdx: 5, camper: false, loc: 'cave-1',  jobIdx: 1, weaponR: 0x1F,               armorId: 0x73, helmId: 0x62, shieldId: 0x58 }, // Fi — Dagger / Leather+Cap+Shield
  { name: 'Lenna',   level: 5,  palIdx: 6, camper: true,  loc: 'ur',      jobIdx: 3, weaponR: 0x0E,               armorId: 0x73, helmId: 0x62, knownSpells: [0x34, 0x35] }, // WM — Staff / Leather+Cap (Cure, Poisona)
  { name: 'Grok',    level: 5,  palIdx: 7, camper: false, loc: 'cave-3',  jobIdx: 1, weaponR: 0x24,               armorId: 0x73, helmId: 0x62, shieldId: 0x58 }, // Fi — Longsword / Leather+Cap+Shield
  { name: 'Ivy',     level: 2,  palIdx: 0, camper: false, loc: 'ur',      jobIdx: 3, weaponR: 0x0E,               armorId: 0x73, helmId: 0x62, knownSpells: [0x34] },       // WM — Staff / Leather+Cap (Cure)
  { name: 'Rook',    level: 5,  palIdx: 3, camper: false, loc: 'cave-2',  jobIdx: 1, weaponR: 0x24,               armorId: 0x73, helmId: 0x62, shieldId: 0x58 }, // Fi — Longsword / Leather+Cap+Shield
  { name: 'Tora',    level: 5,  palIdx: 5, camper: false, loc: 'world',   jobIdx: 3, weaponR: 0x0E,               armorId: 0x73, helmId: 0x62, knownSpells: [0x34, 0x35] }, // WM — Staff / Leather+Cap (Cure, Poisona)
  { name: 'Blix',    level: 4,  palIdx: 7, camper: false, loc: 'cave-2',  jobIdx: 3, weaponR: 0x0E,               armorId: 0x73, helmId: 0x62, knownSpells: [0x34, 0x35] }, // WM — Staff / Leather+Cap (Cure, Poisona)
  { name: 'Cassia',  level: 5,  palIdx: 6, camper: true,  loc: 'cave-1',  jobIdx: 1, weaponR: 0x28,               armorId: 0x73, helmId: 0x62, shieldId: 0x58 }, // Fi — Serpent Sword / Leather+Cap+Shield
  { name: 'Duran',   level: 5,  palIdx: 1, camper: false, loc: 'crystal', jobIdx: 1, weaponR: 0x24,               armorId: 0x73, helmId: 0x62, shieldId: 0x58 }, // Fi — Longsword / Leather+Cap+Shield
  { name: 'Nyx',     level: 1,  palIdx: 4, camper: false, loc: 'ur',      jobIdx: 0, weaponR: 0x1E,               armorId: 0x73, helmId: 0x62 },                 // OK — Knife / Leather+Cap
  { name: 'Orin',    level: 4,  palIdx: 0, camper: false, loc: 'world',   jobIdx: 1, weaponR: 0x1F, weaponL: 0x1E, armorId: 0x73, helmId: 0x62 },                // Fi — Dagger+Knife / Leather+Cap
  { name: 'Pip',     level: 3,  palIdx: 2, camper: false, loc: 'cave-0',  jobIdx: 3, weaponR: 0x0E,               armorId: 0x73, helmId: 0x62, knownSpells: [0x34, 0x35] }, // WM — Staff / Leather+Cap (Cure, Poisona)
  { name: 'Vex',     level: 5,  palIdx: 7, camper: false, loc: 'cave-3',  jobIdx: 1, weaponR: 0x24,               armorId: 0x73, helmId: 0x62, shieldId: 0x58 }, // Fi — Longsword / Leather+Cap+Shield
  { name: 'Wren',    level: 4,  palIdx: 5, camper: false, loc: 'cave-0',  jobIdx: 0, weaponR: 0x1F,               armorId: 0x73, helmId: 0x62 },                 // OK — Dagger / Leather+Cap
  { name: 'Kasumi',  level: 4,  palIdx: 4, camper: false, loc: 'cave-0',  jobIdx: 2, weaponR: 0x06,               armorId: 0x73, helmId: 0x62 },                 // Mo — Nunchuck / Leather+Cap
  { name: 'Jiro',    level: 5,  palIdx: 2, camper: false, loc: 'crystal', jobIdx: 2, weaponR: 0,                  armorId: 0x73, helmId: 0x62 },                 // Mo — Unarmed / Leather+Cap
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
  // MND scales harder for white-magic jobs so their Cure heals are useful;
  // formula: 5 + lv*W where W=3 for WM (jobIdx 3), W=2 for Red Mage (5), W=1 otherwise.
  const mndW = player.jobIdx === 3 ? 3 : player.jobIdx === 5 ? 2 : 1;
  const mnd = 5 + lv * mndW;
  const hp = 28 + lv * 6;
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
  return { name: player.name, palIdx: player.palIdx, jobIdx: player.jobIdx || 0, level: lv, hp, maxHP: hp, atk, def, agi, mnd, evade, mdef, shieldEvade, statusResist, hitRate, weaponId, weaponL, knownSpells, jobLevel: 1, fadeStep: ROSTER_FADE_STEPS, status: createStatusState() };
}
