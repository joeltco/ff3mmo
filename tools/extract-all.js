#!/usr/bin/env node
// Extract ALL FF3 NES game data from ROM using Data Crystal offsets
// One unified item stat table at $61410 indexed by item ID

import { readFileSync } from 'fs';
import { initTextDecoder, getItemName, getSpellName, getMonsterName, getJobName } from '../src/text-decoder.js';

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
function itemStr(id) { try { return nesText(getItemName(id)); } catch { return `?${id}`; } }
function spellStr(id) { try { return nesText(getSpellName(id & 0x7F)); } catch { return `?${id}`; } }
function monStr(id) { try { return nesText(getMonsterName(id)); } catch { return `?${id}`; } }
function jobStr(id) { try { return nesText(getJobName(id)); } catch { return `?${id}`; } }

const ELEM_BITS = { 0x01:'recovery', 0x02:'dark', 0x04:'bolt', 0x08:'ice', 0x10:'fire', 0x20:'air', 0x40:'earth', 0x80:'holy' };
function elemStr(b) { if (!b) return ''; const e=[]; for (const [bit,n] of Object.entries(ELEM_BITS)) if (b&parseInt(bit)) e.push(n); return e.join('+'); }

const STAT_BITS = { 0x80:'+5STR', 0x40:'+5AGI', 0x20:'+5VIT', 0x10:'+5INT', 0x08:'+5MND', 0x04:'fire+', 0x02:'ice+', 0x01:'bolt+' };
function statBonusStr(b) { if (!b) return ''; const s=[]; for (const [bit,n] of Object.entries(STAT_BITS)) if (b&parseInt(bit)) s.push(n); return s.join(','); }

// ROM offsets (Data Crystal, includes iNES header)
const ITEM_STATS    = 0x061410;  // 8 bytes per item, indexed by item ID
const ITEM_PRICES   = 0x021E10;  // 2 bytes per item (LE)
const EQUIP_USABLE  = 0x000910;  // 3 bytes per item (22-bit class bitmask)
const MONSTER_PROPS  = 0x060010;  // 16 bytes per monster
const MONSTER_ATKSCR = 0x061210;  // 49 x 8 bytes (special attack scripts)
const MONSTER_GIL    = 0x061C68;  // 2 bytes per monster (LE)
const MONSTER_CP     = 0x0732BE;  // 1 byte per monster
const MONSTER_EXP_ID = 0x021C90;  // 1 byte per monster (exp group index)
const MONSTER_EXP_VAL= 0x021D90;  // 2 bytes per exp group (LE)
const JOB_BASE_STATS = 0x072010;  // 8 bytes per job
const JOB_COMMANDS   = 0x069B31;  // 4 bytes per job
const SPELL_DATA     = 0x0618D0;  // 8 bytes per spell
const CHEST_DATA     = 0x003C10;  // 1 byte per chest
const SHOP_DATA_FC   = 0x059CBB;  // floating continent shops
const ENCOUNTER_SET  = 0x05C010;  // 2 bytes per encounter
const ENCOUNTER_MON  = 0x05C410;  // 6 bytes per encounter (monster list)
const ENCOUNTER_STR  = 0x05CA10;  // 4 bytes per encounter structure
const BOSS_BIT       = 0x05CF10;  // 256 bits

const section = process.argv[2] || 'all';

// ── WEAPON + ARMOR STATS (unified table) ──
if (section === 'all' || section === 'items') {
  console.log('\n=== ITEM STATS (unified table at $61410) ===\n');

  // Weapons: 0x01-0x56
  console.log('--- WEAPONS ---');
  for (let id = 0x01; id <= 0x56; id++) {
    const off = ITEM_STATS + id * 8;
    const element = rom[off+0];
    const hit = rom[off+1];
    const atk = rom[off+2];
    const status = rom[off+3];
    const magicCast = rom[off+4];
    const special = rom[off+5];
    const statBonus = rom[off+6];
    const usability = rom[off+7];
    // Price
    const poff = ITEM_PRICES + id * 2;
    const price = rom[poff] | (rom[poff+1] << 8);

    const name = itemStr(id);
    const parts = [`ATK:${atk}`, `HIT:${hit}%`];
    if (element) parts.push(`elem:${elemStr(element)}`);
    if (status) parts.push(`status:0x${status.toString(16)}`);
    if (magicCast !== 0x7F && magicCast !== 0xFF && magicCast !== 0x00) parts.push(`casts:${spellStr(magicCast)}(0x${magicCast.toString(16)})`);
    if (magicCast === 0xFF) parts.push('two-handed');
    if (statBonus) parts.push(`bonus:${statBonusStr(statBonus)}`);
    parts.push(`price:${price}`);
    // Raw bytes for verification
    parts.push(`raw:[${Array.from(rom.slice(off,off+8)).map(b=>'0x'+b.toString(16).padStart(2,'0')).join(',')}]`);

    console.log(`[0x${id.toString(16).padStart(2,'0')}] ${name.padEnd(14)} ${parts.join('  ')}`);
  }

  // Armor: 0x57-0x96
  console.log('\n--- ARMOR ---');
  for (let id = 0x57; id <= 0x96; id++) {
    const off = ITEM_STATS + id * 8;
    const elemResist = rom[off+0];
    const evade = rom[off+1];
    const def = rom[off+2];
    const statusResist = rom[off+3];
    const mdef = rom[off+4];
    const byte5 = rom[off+5];
    const statBonus = rom[off+6];
    const usability = rom[off+7];
    // Price
    const poff = ITEM_PRICES + id * 2;
    const price = rom[poff] | (rom[poff+1] << 8);

    const name = itemStr(id);
    const parts = [`DEF:${def}`, `EVADE:${evade}%`, `MDEF:${mdef}`];
    if (elemResist) parts.push(`resist:${elemStr(elemResist)}`);
    if (statusResist) parts.push(`sResist:0x${statusResist.toString(16)}`);
    if (statBonus) parts.push(`bonus:${statBonusStr(statBonus)}`);
    parts.push(`price:${price}`);
    parts.push(`raw:[${Array.from(rom.slice(off,off+8)).map(b=>'0x'+b.toString(16).padStart(2,'0')).join(',')}]`);

    console.log(`[0x${id.toString(16).padStart(2,'0')}] ${name.padEnd(14)} ${parts.join('  ')}`);
  }

  // Consumables/items: 0x97-0xC7
  console.log('\n--- CONSUMABLE ITEMS ---');
  for (let id = 0x97; id <= 0xC7; id++) {
    const poff = ITEM_PRICES + id * 2;
    const price = rom[poff] | (rom[poff+1] << 8);
    const name = itemStr(id);
    if (name && name.length > 0) console.log(`[0x${id.toString(16).padStart(2,'0')}] ${name.padEnd(14)} price:${price}`);
  }
}

// ── SPELLS ──
if (section === 'all' || section === 'spells') {
  console.log('\n=== SPELL DATA ($618D0) ===\n');
  for (let id = 0; id < 88; id++) {
    const off = SPELL_DATA + id * 8;
    const element = rom[off+0];
    const hit = rom[off+1];
    const power = rom[off+2];
    const type = rom[off+3];
    const target = rom[off+4];
    const targeting = rom[off+5];
    const anim = rom[off+6];
    const usability = rom[off+7];
    const name = spellStr(id);
    console.log(`[${id.toString().padStart(2)}] ${name.padEnd(14)} pwr:${power.toString().padStart(3)} hit:${hit.toString().padStart(3)}% elem:${(elemStr(element)||'none').padEnd(12)} type:0x${type.toString(16).padStart(2,'0')} tgt:0x${target.toString(16).padStart(2,'0')} anim:0x${anim.toString(16).padStart(2,'0')}  raw:[${Array.from(rom.slice(off,off+8)).map(b=>'0x'+b.toString(16).padStart(2,'0')).join(',')}]`);
  }
}

// ── JOB STATS ──
if (section === 'all' || section === 'jobs') {
  console.log('\n=== JOB BASE STATS ($72010) ===\n');
  for (let id = 0; id < 22; id++) {
    const off = JOB_BASE_STATS + id * 8;
    const cpCost = rom[off+0];
    const lvReq = rom[off+1];
    const str = rom[off+2];
    const agi = rom[off+3];
    const vit = rom[off+4];
    const int_ = rom[off+5];
    const mnd = rom[off+6];
    const mpIdx = rom[off+7];
    const name = jobStr(id);
    console.log(`[${id.toString().padStart(2)}] ${name.padEnd(14)} CP:${cpCost} LvReq:${lvReq} STR:${str} AGI:${agi} VIT:${vit} INT:${int_} MND:${mnd} mpIdx:${mpIdx}`);
  }

  // Job commands
  console.log('\n=== JOB COMMANDS ($69B31) ===\n');
  const CMD_NAMES = {0x00:'Fight',0x01:'Defend',0x02:'Run',0x03:'Item',0x04:'Attack',0x05:'Guard',0x06:'Flee',0x07:'Escape',
    0x08:'Jump',0x09:'Steal',0x0A:'Peep',0x0B:'Guard2',0x0C:'Scan',0x0D:'Terrain',0x0E:'Build',0x0F:'Sing',
    0x10:'Guard3',0x11:'Charm',0x12:'Throw',0x13:'Dark',0x14:'Item',0x15:'Magic',0x16:'Summon',0x17:'White',
    0x18:'Black',0x19:'Call',0x1A:'White2',0x1B:'Black2',0x1C:'AllMagic',0x1D:'Dark2'};
  for (let id = 0; id < 22; id++) {
    const off = JOB_COMMANDS + id * 4;
    const cmds = [];
    for (let c = 0; c < 4; c++) cmds.push(CMD_NAMES[rom[off+c]] || `0x${rom[off+c].toString(16)}`);
    const name = jobStr(id);
    console.log(`[${id.toString().padStart(2)}] ${name.padEnd(14)} ${cmds.join(', ')}`);
  }
}

// ── MONSTERS (full) ──
if (section === 'all' || section === 'monsters') {
  // Attack scripts
  const scripts = [];
  for (let i = 0; i < 64; i++) {
    const off = MONSTER_ATKSCR + i * 8;
    scripts.push(Array.from(rom.slice(off, off+8)));
  }

  console.log('\n=== MONSTER STATS ($60010) ===\n');
  for (let id = 0; id < 230; id++) {
    const off = MONSTER_PROPS + id * 16;
    const level = rom[off+0];
    const hp = rom[off+1] | (rom[off+2] << 8);
    if (level === 0 && hp === 0) continue;
    const spAtkRate = rom[off+3];
    const skill = rom[off+4];
    const weakness = rom[off+5];
    const mevIdx = rom[off+6];
    const spiritInt = rom[off+7];
    const atkElem = rom[off+8];
    const atkHitIdx = rom[off+9];
    const statusOnAtk = rom[off+10];
    const elemResist = rom[off+11];
    const defEvdIdx = rom[off+12];
    const statusResist = rom[off+13];
    const spAtkIdx = rom[off+14];
    const stealDropIdx = rom[off+15];
    const isBoss = !!(rom[BOSS_BIT + Math.floor(id/8)] & (1 << (id%8)));

    // Gil
    const goff = MONSTER_GIL + id * 2;
    const gil = rom[goff] | (rom[goff+1] << 8);
    // CP
    const cp = rom[MONSTER_CP + id];
    // EXP
    const expGrp = rom[MONSTER_EXP_ID + id];
    const eoff = MONSTER_EXP_VAL + expGrp * 2;
    const exp = rom[eoff] | (rom[eoff+1] << 8);

    // Stat indices → actual values from multiplier table at $61010
    const STAT_TABLE = 0x061010;
    const atkStatOff = STAT_TABLE + atkHitIdx * 3;
    const atkMult = rom[atkStatOff]; const hitMult = rom[atkStatOff+1]; const atkPow = rom[atkStatOff+2];
    const defStatOff = STAT_TABLE + defEvdIdx * 3;
    const defMult = rom[defStatOff]; const evdPct = rom[defStatOff+1]; const defPow = rom[defStatOff+2];
    const mdefOff = STAT_TABLE + mevIdx * 3;
    const mevPct = rom[mdefOff]; const mdefVal = rom[mdefOff+1];

    const name = monStr(id);
    const parts = [`Lv:${level}`, `HP:${hp}`, `ATK:${atkPow}`, `HIT:${hitMult}`, `DEF:${defPow}`, `EVD:${evdPct}`, `MDEF:${mdefVal}`, `MEVD:${mevPct}`];
    parts.push(`EXP:${exp}`, `GIL:${gil}`, `CP:${cp}`);
    if (weakness) parts.push(`weak:${elemStr(weakness)}`);
    if (elemResist) parts.push(`resist:${elemStr(elemResist)}`);
    if (atkElem) parts.push(`atkElem:${elemStr(atkElem)}`);
    if (statusOnAtk) parts.push(`status:0x${statusOnAtk.toString(16)}`);
    if (spAtkRate) parts.push(`spRate:${spAtkRate}%`);
    if (spAtkIdx) {
      const scr = scripts[spAtkIdx];
      if (scr) parts.push(`spells:[${scr.map(s=>spellStr(s)).join(',')}]`);
    }
    if (isBoss) parts.push('BOSS');

    console.log(`[0x${id.toString(16).padStart(2,'0')}] ${name.padEnd(14)} ${parts.join('  ')}`);
  }
}

// ── CHESTS ──
if (section === 'all' || section === 'chests') {
  console.log('\n=== CHEST CONTENTS ($3C10) ===\n');
  for (let i = 0; i < 256; i++) {
    const itemId = rom[CHEST_DATA + i];
    if (itemId === 0) continue;
    console.log(`chest ${i.toString().padStart(3)}: [0x${itemId.toString(16).padStart(2,'0')}] ${itemStr(itemId)}`);
  }
}

// ── ENCOUNTER TABLES ──
if (section === 'all' || section === 'encounters') {
  console.log('\n=== ENCOUNTER TABLES ===\n');
  for (let i = 0; i < 256; i++) {
    const soff = ENCOUNTER_SET + i * 2;
    const monListIdx = rom[soff];
    const flags = rom[soff+1];
    const structIdx = flags & 0x3F;
    const isBossEnc = !!(flags & 0x40);

    // Monster list (6 bytes: 2 palette bytes + 4 monster IDs)
    const moff = ENCOUNTER_MON + monListIdx * 6;
    const pal1 = rom[moff]; const pal2 = rom[moff+1];
    const mons = [rom[moff+2], rom[moff+3], rom[moff+4], rom[moff+5]];
    const monNames = mons.filter(m => m !== 0xFF).map(m => `${monStr(m)}(0x${m.toString(16)})`);
    if (monNames.length === 0) continue;

    // Structure (min/max per group)
    const strOff = ENCOUNTER_STR + structIdx * 4;
    const groups = [];
    for (let g = 0; g < 4; g++) {
      const b = rom[strOff+g];
      const min = (b >> 4) & 0xF;
      const max = b & 0xF;
      if (max > 0) groups.push(`${min}-${max}`);
    }

    console.log(`enc ${i.toString().padStart(3)}: ${isBossEnc?'BOSS ':''}monsters=[${monNames.join(', ')}]  groups=[${groups.join(', ')}]`);
  }
}

// ── ITEM PRICES (full list) ──
if (section === 'all' || section === 'prices') {
  console.log('\n=== ITEM PRICES ($21E10) ===\n');
  for (let id = 0; id < 200; id++) {
    const poff = ITEM_PRICES + id * 2;
    const price = rom[poff] | (rom[poff+1] << 8);
    if (price === 0) continue;
    const name = itemStr(id);
    if (!name || name.length === 0) continue;
    console.log(`[0x${id.toString(16).padStart(2,'0')}] ${name.padEnd(14)} ${price} gil`);
  }
}

// ── EQUIP CLASS RESTRICTIONS ──
if (section === 'all' || section === 'equip') {
  console.log('\n=== EQUIP CLASS RESTRICTIONS ($910) ===\n');
  for (let id = 0x01; id <= 0x96; id++) {
    const off = EQUIP_USABLE + id * 3;
    const b0 = rom[off]; const b1 = rom[off+1]; const b2 = rom[off+2];
    const mask = b0 | (b1 << 8) | (b2 << 16);
    if (mask === 0) continue;
    const jobs = [];
    for (let j = 0; j < 22; j++) { if (mask & (1 << j)) jobs.push(jobStr(j)); }
    const name = itemStr(id);
    console.log(`[0x${id.toString(16).padStart(2,'0')}] ${name.padEnd(14)} ${jobs.join(', ')}`);
  }
}
