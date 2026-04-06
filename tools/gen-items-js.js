#!/usr/bin/env node
// Generate a complete items.js from FF3 NES ROM data
// Uses Data Crystal offsets, outputs JS source to stdout

import { readFileSync } from 'fs';
import { initTextDecoder, getItemName, getSpellName } from '../src/text-decoder.js';

const rom = readFileSync('FF3-English.nes');
initTextDecoder(rom);

function nesText(bytes) {
  let s = '';
  for (const b of bytes) {
    if (b >= 0xCA && b <= 0xE3) s += String.fromCharCode(b - 0xCA + 97);
    else if (b >= 0x80 && b <= 0x89) s += String.fromCharCode(b - 0x80 + 48);
    else if (b >= 0x8A && b <= 0xA3) s += String.fromCharCode(b - 0x8A + 65);
    else if (b === 0xFF) s += ' ';
    else if (b === 0xC4) s += '!';
    else if (b === 0xC5) s += '?';
    else if (b === 0xC8) s += ':';
    else if (b === 0xC9) s += '-';
    else if (b >= 0x5C && b <= 0x7B) continue;
  }
  return s.trim();
}
function itemStr(id) { try { return nesText(getItemName(id)); } catch { return ''; } }
function spellStr(id) { try { return nesText(getSpellName(id & 0x7F)); } catch { return ''; } }

const ITEM_STATS  = 0x061410;
const ITEM_PRICES = 0x021E10;
const EQUIP_USABLE = 0x000910;

const ELEM_MAP = { 0x01:'recovery', 0x02:'dark', 0x04:'bolt', 0x08:'ice', 0x10:'fire', 0x20:'air', 0x40:'earth', 0x80:'holy' };
function elemArr(b) { if (!b) return null; const e=[]; for (const [bit,n] of Object.entries(ELEM_MAP)) if (b&parseInt(bit)) e.push(`'${n}'`); return e.length===1?e[0]:`[${e.join(',')}]`; }

// Weapon subtypes by item ID range (from existing items.js structure)
const WEAPON_SUBTYPES = {};
for (let i=0x01;i<=0x05;i++) WEAPON_SUBTYPES[i]='claw';
for (let i=0x06;i<=0x08;i++) WEAPON_SUBTYPES[i]='nunchaku';
for (let i=0x09;i<=0x0D;i++) WEAPON_SUBTYPES[i]='rod';
for (let i=0x0E;i<=0x14;i++) WEAPON_SUBTYPES[i]='staff';
WEAPON_SUBTYPES[0x15]='hammer'; WEAPON_SUBTYPES[0x16]='hammer';
WEAPON_SUBTYPES[0x17]='axe'; WEAPON_SUBTYPES[0x18]='axe'; WEAPON_SUBTYPES[0x19]='axe';
for (let i=0x1A;i<=0x1D;i++) WEAPON_SUBTYPES[i]='spear';
for (let i=0x1E;i<=0x23;i++) WEAPON_SUBTYPES[i]='knife';
for (let i=0x24;i<=0x2E;i++) WEAPON_SUBTYPES[i]='sword';
WEAPON_SUBTYPES[0x2F]='katana'; WEAPON_SUBTYPES[0x30]='sword'; WEAPON_SUBTYPES[0x31]='sword';
WEAPON_SUBTYPES[0x32]='hammer'; WEAPON_SUBTYPES[0x33]='katana'; WEAPON_SUBTYPES[0x34]='katana';
WEAPON_SUBTYPES[0x35]='sword'; WEAPON_SUBTYPES[0x36]='sword'; WEAPON_SUBTYPES[0x37]='katana';
WEAPON_SUBTYPES[0x38]='sword'; WEAPON_SUBTYPES[0x39]='sword';
for (let i=0x3A;i<=0x3E;i++) WEAPON_SUBTYPES[i]='book';
WEAPON_SUBTYPES[0x42]='book';
WEAPON_SUBTYPES[0x3F]='boomerang'; WEAPON_SUBTYPES[0x40]='boomerang';
WEAPON_SUBTYPES[0x41]='shuriken';
for (let i=0x43;i<=0x45;i++) WEAPON_SUBTYPES[i]='bell';
for (let i=0x46;i<=0x49;i++) WEAPON_SUBTYPES[i]='harp';
for (let i=0x4A;i<=0x4E;i++) WEAPON_SUBTYPES[i]='bow';
for (let i=0x4F;i<=0x56;i++) WEAPON_SUBTYPES[i]='arrow';

// Armor subtypes
const ARMOR_SUBTYPES = {};
for (let i=0x58;i<=0x61;i++) ARMOR_SUBTYPES[i]='shield';
for (let i=0x62;i<=0x71;i++) ARMOR_SUBTYPES[i]='helmet';
for (let i=0x72;i<=0x8A;i++) ARMOR_SUBTYPES[i]='body';
for (let i=0x8B;i<=0x96;i++) ARMOR_SUBTYPES[i]='arms';

// Job bitmask constants
const JOB_NAMES = ['On','Fi','Mo','Ww','Bw','Rw','Hu','Kn','Th','Sc','Ge','Dr','Vi','Ka','Mk','Co','Ba','Su','Sh','Wa','Sa','Ni'];

function jobMaskStr(id) {
  const off = EQUIP_USABLE + id * 3;
  const mask = rom[off] | (rom[off+1] << 8) | (rom[off+2] << 16);
  if (mask === 0) return '0';
  if ((mask & 0x3FFFFF) === 0x3FFFFF) return 'ALL';
  const jobs = [];
  for (let j = 0; j < 22; j++) { if (mask & (1 << j)) jobs.push(JOB_NAMES[j]); }
  return jobs.join('|');
}

// Status effect names
function statusStr(b) {
  if (!b) return null;
  const effects = [];
  if (b & 0x80) effects.push('death');
  if (b & 0x40) effects.push('petrify');
  if (b & 0x20) effects.push('toad');
  if (b & 0x10) effects.push('silence');
  if (b & 0x08) effects.push('mini');
  if (b & 0x04) effects.push('blind');
  if (b & 0x02) effects.push('poison');
  if (b & 0x01) effects.push('paralysis');
  return effects.length === 1 ? `'${effects[0]}'` : `[${effects.map(e=>`'${e}'`).join(',')}]`;
}

// Output
const lines = [];
lines.push(`// Item Catalog — keyed by ROM item ID (0x00–0xC7)`);
lines.push(`// AUTO-GENERATED from FF3 NES ROM via tools/gen-items-js.js`);
lines.push(`// Stats source: Data Crystal ROM map ($61410 weapon/armor, $21E10 prices, $910 equip)`);
lines.push(``);
lines.push(`// Job bitmask constants — bit N = job index N can equip`);
for (let j = 0; j < 22; j++) {
  lines.push(`const ${JOB_NAMES[j].padEnd(2)} = 1 << ${j};${j<10?' ':''}  // ${['Onion Knight','Fighter','Monk','White Mage','Black Mage','Red Mage','Hunter/Ranger','Knight','Thief','Scholar','Geomancer','Dragoon','Viking','Karateka/Black Belt','Magic Knight','Conjurer','Bard','Summoner','Shaman/Devout','Warlock/Magus','Sage','Ninja'][j]}`);
}
lines.push(`const ALL = ${(1<<22)-1};`);
lines.push(``);
lines.push(`export const ITEMS = new Map([`);

// Weapons
for (let id = 0x01; id <= 0x56; id++) {
  const off = ITEM_STATS + id * 8;
  const element = rom[off+0];
  const hit = rom[off+1];
  const atk = rom[off+2];
  const status = rom[off+3];
  const magicCast = rom[off+4];
  const special = rom[off+5];
  const statBonus = rom[off+6];
  const poff = ITEM_PRICES + id * 2;
  const price = rom[poff] | (rom[poff+1] << 8);
  const name = itemStr(id);
  const subtype = WEAPON_SUBTYPES[id] || 'weapon';
  const jobs = jobMaskStr(id);
  const twoHanded = magicCast === 0xFF;

  const props = [`type: 'weapon'`, `subtype: '${subtype}'`, `atk: ${atk}`, `hit: ${hit}`];
  if (element) props.push(`element: ${elemArr(element)}`);
  if (status) props.push(`status: ${statusStr(status)}`);
  if (magicCast !== 0x7F && magicCast !== 0xFF && magicCast !== 0x00) props.push(`casts: 0x${magicCast.toString(16).padStart(2,'0')}`);
  if (twoHanded) props.push(`twoHanded: true`);
  if (statBonus & 0x80) props.push(`strBonus: 5`);
  if (statBonus & 0x40) props.push(`agiBonus: 5`);
  if (statBonus & 0x20) props.push(`vitBonus: 5`);
  if (statBonus & 0x10) props.push(`intBonus: 5`);
  if (statBonus & 0x08) props.push(`mndBonus: 5`);
  props.push(`price: ${price.toString().padStart(5)}`);
  props.push(`jobs: ${jobs}`);

  lines.push(`  [0x${id.toString(16).padStart(2,'0')}, { ${props.join(', ')} }], // ${name}`);
}

// Armor
for (let id = 0x57; id <= 0x96; id++) {
  const off = ITEM_STATS + id * 8;
  const elemResist = rom[off+0];
  const evade = rom[off+1];
  const def = rom[off+2];
  const statusResist = rom[off+3];
  const mdef = rom[off+4];
  const statBonus = rom[off+6];
  const poff = ITEM_PRICES + id * 2;
  const price = rom[poff] | (rom[poff+1] << 8);
  const name = itemStr(id);
  const subtype = ARMOR_SUBTYPES[id] || 'armor';
  const jobs = jobMaskStr(id);

  const props = [`type: 'armor'`, `subtype: '${subtype}'`, `def: ${def}`, `evade: ${evade}`, `mdef: ${mdef}`];
  if (elemResist) props.push(`resist: ${elemArr(elemResist)}`);
  if (statusResist) props.push(`sResist: 0x${statusResist.toString(16).padStart(2,'0')}`);
  if (statBonus & 0x80) props.push(`strBonus: 5`);
  if (statBonus & 0x40) props.push(`agiBonus: 5`);
  if (statBonus & 0x20) props.push(`vitBonus: 5`);
  if (statBonus & 0x10) props.push(`intBonus: 5`);
  if (statBonus & 0x08) props.push(`mndBonus: 5`);
  props.push(`price: ${price.toString().padStart(5)}`);
  props.push(`jobs: ${jobs}`);

  lines.push(`  [0x${id.toString(16).padStart(2,'0')}, { ${props.join(', ')} }], // ${name}`);
}

// Consumable items (keep simple — type, price)
for (let id = 0x97; id <= 0xC7; id++) {
  const poff = ITEM_PRICES + id * 2;
  const price = rom[poff] | (rom[poff+1] << 8);
  const name = itemStr(id);
  if (!name || name.length === 0) continue;
  // Battle items
  const battleItems = new Set([0xB1,0xB2,0xB3,0xB4,0xB5,0xB6,0xB7,0xB8,0xB9,0xBA,0xBB,0xBC,0xBD,0xBE,0xBF,0xC1,0xC3,0xC5,0xC6,0xC7]);
  const healItems = new Set([0xA6,0xA7,0xA8,0xA9,0xAA,0xAB,0xAC,0xAD,0xAE,0xAF,0xB0]);
  const keyItems = new Set([0x98,0x99,0x9A,0x9B,0x9C,0x9D,0x9E,0x9F,0xA0,0xA1,0xA2,0xA3,0xA4,0xA5]);
  let type = 'item';
  if (battleItems.has(id)) type = 'battle_item';
  else if (healItems.has(id)) type = 'consumable';
  else if (keyItems.has(id)) type = 'key_item';
  lines.push(`  [0x${id.toString(16).padStart(2,'0')}, { type: '${type}', price: ${price.toString().padStart(5)} }], // ${name}`);
}

lines.push(`]);`);
lines.push(``);

// Utility functions
lines.push(`export function isWeapon(id) { const i = ITEMS.get(id); return i && i.type === 'weapon' && i.subtype !== 'shield'; }`);
lines.push(`export function weaponSubtype(id) { const i = ITEMS.get(id); return (i && i.type === 'weapon') ? i.subtype : null; }`);

console.log(lines.join('\n'));
