#!/usr/bin/env node
// Generate items.js stat updates from ROM — preserves existing job masks
// Outputs JSON with ROM-verified stats per item ID

import { readFileSync } from 'fs';
import { initTextDecoder, getSpellName } from '../src/text-decoder.js';

const rom = readFileSync('FF3-English.nes');
initTextDecoder(rom);

function nesText(bytes) {
  let s = '';
  for (const b of bytes) {
    if (b >= 0xCA && b <= 0xE3) s += String.fromCharCode(b - 0xCA + 97);
    else if (b >= 0x8A && b <= 0xA3) s += String.fromCharCode(b - 0x8A + 65);
    else if (b === 0xFF) s += ' ';
    else if (b >= 0x5C && b <= 0x7B) continue;
  }
  return s.trim();
}
function spellStr(id) { try { return nesText(getSpellName(id & 0x7F)); } catch { return `spell_${id}`; } }

const ITEM_STATS  = 0x061410;
const ITEM_PRICES = 0x021E10;

const ELEM_MAP = { 1:'recovery', 2:'dark', 4:'bolt', 8:'ice', 16:'fire', 32:'air', 64:'earth', 128:'holy' };
function elemVal(b) {
  if (!b) return null;
  const e = [];
  for (const [bit, n] of Object.entries(ELEM_MAP)) if (b & parseInt(bit)) e.push(n);
  return e.length === 1 ? e[0] : e;
}

function statusVal(b) {
  if (!b) return null;
  const s = [];
  if (b & 0x80) s.push('death');
  if (b & 0x40) s.push('petrify');
  if (b & 0x20) s.push('toad');
  if (b & 0x10) s.push('silence');
  if (b & 0x08) s.push('mini');
  if (b & 0x04) s.push('blind');
  if (b & 0x02) s.push('poison');
  if (b & 0x01) s.push('paralysis');
  return s.length === 1 ? s[0] : s;
}

const results = {};

// Weapons 0x01-0x56
for (let id = 0x01; id <= 0x56; id++) {
  const off = ITEM_STATS + id * 8;
  const element = rom[off+0];
  const hit = rom[off+1];
  const atk = rom[off+2];
  const status = rom[off+3];
  const magicCast = rom[off+4];
  const statBonus = rom[off+6];
  const poff = ITEM_PRICES + id * 2;
  const price = rom[poff] | (rom[poff+1] << 8);
  const twoHanded = magicCast === 0xFF;

  const entry = { atk, hit, price };
  if (element) entry.element = elemVal(element);
  if (status) entry.status = statusVal(status);
  if (magicCast !== 0x7F && magicCast !== 0xFF && magicCast !== 0x00) {
    entry.casts = `0x${magicCast.toString(16).padStart(2,'0')}`;
    entry.castsName = spellStr(magicCast);
  }
  if (twoHanded) entry.twoHanded = true;
  if (statBonus & 0x80) entry.strBonus = 5;
  if (statBonus & 0x40) entry.agiBonus = 5;
  if (statBonus & 0x20) entry.vitBonus = 5;
  if (statBonus & 0x10) entry.intBonus = 5;
  if (statBonus & 0x08) entry.mndBonus = 5;

  results[`0x${id.toString(16).padStart(2,'0')}`] = entry;
}

// Armor 0x57-0x96
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

  const entry = { def, evade, mdef, price };
  if (elemResist) entry.resist = elemVal(elemResist);
  if (statusResist) entry.sResist = `0x${statusResist.toString(16).padStart(2,'0')}`;
  if (statBonus & 0x80) entry.strBonus = 5;
  if (statBonus & 0x40) entry.agiBonus = 5;
  if (statBonus & 0x20) entry.vitBonus = 5;
  if (statBonus & 0x10) entry.intBonus = 5;
  if (statBonus & 0x08) entry.mndBonus = 5;

  results[`0x${id.toString(16).padStart(2,'0')}`] = entry;
}

// Consumables
for (let id = 0x97; id <= 0xC7; id++) {
  const poff = ITEM_PRICES + id * 2;
  const price = rom[poff] | (rom[poff+1] << 8);
  if (price > 0) results[`0x${id.toString(16).padStart(2,'0')}`] = { price };
}

console.log(JSON.stringify(results, null, 2));
