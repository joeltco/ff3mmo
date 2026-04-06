#!/usr/bin/env node
// Extract FF3 NES data using Data Crystal ROM map offsets
// Weapon stats, armor stats, magic data, monster stats, encounter tables

import { readFileSync } from 'fs';
import { initTextDecoder, getSpellName, getItemName, getMonsterName } from '../src/text-decoder.js';

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
    else if (b >= 0x5C && b <= 0x7B) continue; // icon
  }
  return s.trim();
}
function itemStr(id) { try { return nesText(getItemName(id)); } catch { return `item_${id}`; } }
function spellStr(id) { try { return nesText(getSpellName(id & 0x7F)); } catch { return `spell_${id}`; } }
function monsterStr(id) { try { return nesText(getMonsterName(id)); } catch { return `mon_${id}`; } }

const ELEMENTS = { 0x01:'recovery', 0x02:'dark', 0x04:'bolt', 0x08:'ice', 0x10:'fire', 0x20:'air', 0x40:'earth', 0x80:'holy' };
function elemStr(byte) {
  if (!byte) return 'none';
  const e = [];
  for (const [bit, name] of Object.entries(ELEMENTS)) if (byte & parseInt(bit)) e.push(name);
  return e.join('+') || 'none';
}

const STATUS = { 0x02:'poison', 0x03:'petrify1/3', 0x04:'blind', 0x08:'mini', 0x10:'silence', 0x20:'toad', 0x40:'petrify', 0x80:'death', 0x81:'paralysis' };
function statusStr(byte) { return STATUS[byte] || (byte ? `0x${byte.toString(16)}` : 'none'); }

const section = process.argv[2] || 'all';

// ── WEAPONS ──
if (section === 'all' || section === 'weapons') {
  console.log('\n=== WEAPON STATS ($61410) ===\n');
  // Items 0x01-0x56 are weapons roughly
  for (let id = 0x01; id <= 0x56; id++) {
    const off = 0x061410 + id * 8;
    const element = rom[off];
    const hit = rom[off + 1];
    const atk = rom[off + 2];
    const status = rom[off + 3];
    const magicCast = rom[off + 4];
    const special = rom[off + 5];
    const statBonus = rom[off + 6];
    if (atk === 0 && hit === 0) continue;
    const name = itemStr(id);
    let extras = [];
    if (element) extras.push(`elem:${elemStr(element)}`);
    if (status) extras.push(`status:${statusStr(status)}`);
    if (magicCast !== 0x7F && magicCast !== 0xFF) extras.push(`casts:${spellStr(magicCast)}`);
    if (magicCast === 0xFF) extras.push('two-handed');
    if (statBonus) {
      const bonuses = [];
      if (statBonus & 0x80) bonuses.push('+5 STR');
      if (statBonus & 0x40) bonuses.push('+5 AGI');
      if (statBonus & 0x20) bonuses.push('+5 VIT');
      if (statBonus & 0x10) bonuses.push('+5 INT');
      if (statBonus & 0x08) bonuses.push('+5 MND');
      if (statBonus & 0x04) bonuses.push('fire+');
      if (statBonus & 0x02) bonuses.push('ice+');
      if (statBonus & 0x01) bonuses.push('bolt+');
      extras.push(bonuses.join(','));
    }
    console.log(`[0x${id.toString(16).padStart(2,'0')}] ${name.padEnd(14)} ATK:${atk.toString().padStart(3)} HIT:${hit.toString().padStart(3)}%  ${extras.join('  ')}`);
  }
}

// ── ARMOR ──
if (section === 'all' || section === 'armor') {
  console.log('\n=== ARMOR STATS ($616D0) ===\n');
  for (let id = 0x57; id <= 0x96; id++) {
    const off = 0x0616D0 + id * 8;
    const elemResist = rom[off];
    const evade = rom[off + 1];
    const def = rom[off + 2];
    const statusResist = rom[off + 3];
    const mdef = rom[off + 4];
    const statBonus = rom[off + 6];
    if (def === 0 && evade === 0 && mdef === 0) continue;
    const name = itemStr(id);
    let extras = [];
    if (elemResist) extras.push(`resist:${elemStr(elemResist)}`);
    if (evade) extras.push(`evade:${evade}%`);
    if (mdef) extras.push(`mdef:${mdef}`);
    if (statusResist) extras.push(`sResist:0x${statusResist.toString(16)}`);
    if (statBonus) {
      const bonuses = [];
      if (statBonus & 0x80) bonuses.push('+5 STR');
      if (statBonus & 0x40) bonuses.push('+5 AGI');
      if (statBonus & 0x20) bonuses.push('+5 VIT');
      if (statBonus & 0x10) bonuses.push('+5 INT');
      if (statBonus & 0x08) bonuses.push('+5 MND');
      extras.push(bonuses.join(','));
    }
    console.log(`[0x${id.toString(16).padStart(2,'0')}] ${name.padEnd(14)} DEF:${def.toString().padStart(3)} ${extras.join('  ')}`);
  }
}

// ── MAGIC/SPELLS ──
if (section === 'all' || section === 'magic') {
  console.log('\n=== MAGIC/SPELL DATA ($618D0) ===\n');
  for (let id = 0; id < 88; id++) {
    const off = 0x0618D0 + id * 8;
    const element = rom[off];
    const hit = rom[off + 1];
    const power = rom[off + 2];
    const type = rom[off + 3];
    const target = rom[off + 4];
    const targeting = rom[off + 5];
    const anim = rom[off + 6];
    const name = spellStr(id);
    let typeStr = 'dmg';
    if (type === 0xFF) typeStr = 'heal';
    else if (type === 0x51) typeStr = 'sleep';
    else if (type === 0x04) typeStr = 'blind';
    else if (type === 0x02) typeStr = 'poison';
    else if (type === 0x80) typeStr = 'death';
    else if (type === 0x40) typeStr = 'petrify';
    else if (type === 0x10) typeStr = 'silence';
    else if (type === 0x20) typeStr = 'toad';
    else if (type === 0x07) typeStr = 'haste';
    else if (type === 0x05) typeStr = 'petrify';
    else if (type) typeStr = `type:0x${type.toString(16)}`;
    console.log(`[${id.toString().padStart(2)}] ${name.padEnd(12)} pwr:${power.toString().padStart(3)} hit:${hit.toString().padStart(3)}% elem:${elemStr(element).padEnd(8)} ${typeStr}`);
  }
}

// ── ENCOUNTER DATA ──
if (section === 'all' || section === 'encounters') {
  console.log('\n=== ENCOUNTER STRUCTURES ($5CA10) ===\n');
  for (let i = 0; i < 64; i++) {
    const off = 0x05CA10 + i * 4;
    const groups = [];
    for (let g = 0; g < 4; g++) {
      const byte = rom[off + g];
      const min = (byte >> 4) & 0x0F;
      const max = byte & 0x0F;
      if (max > 0) groups.push(`${min}-${max}`);
    }
    if (groups.length === 0) continue;
    console.log(`struct ${i.toString().padStart(2)}: ${groups.join(' / ')}`);
  }
}

// ── CHEST CONTENTS ──
if (section === 'all' || section === 'chests') {
  console.log('\n=== CHEST CONTENTS ($3C10) ===\n');
  // Read first 128 chest entries
  for (let i = 0; i < 128; i++) {
    const off = 0x003C10 + i;
    const itemId = rom[off];
    if (itemId === 0) continue;
    const name = itemStr(itemId);
    console.log(`chest ${i.toString().padStart(3)}: [0x${itemId.toString(16).padStart(2,'0')}] ${name}`);
  }
}

// ── STEAL/DROP GROUPS ──
if (section === 'all' || section === 'drops') {
  console.log('\n=== STEAL/DROP GROUPS ($21A90) ===\n');
  for (let i = 0; i < 32; i++) {
    const off = 0x021A90 + i * 8;
    const items = [];
    for (let j = 0; j < 4; j++) {
      const id = rom[off + j];
      if (id) items.push(itemStr(id));
    }
    const secondary = [];
    for (let j = 4; j < 8; j++) {
      const id = rom[off + j];
      if (id) secondary.push(itemStr(id));
    }
    if (items.length === 0 && secondary.length === 0) continue;
    console.log(`group ${i.toString().padStart(2)}: drops=[${items.join(', ')}]  secondary=[${secondary.join(', ')}]`);
  }
}
