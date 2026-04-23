#!/usr/bin/env node
// Generate monsters.js from FF3 NES ROM data
// Preserves steal/drops/location from existing monsters.js where available

import { readFileSync } from 'fs';
import { initTextDecoder, getSpellName, getMonsterName } from '../src/text-decoder.js';
import { MONSTERS as OLD_MONSTERS } from '../src/data/monsters.js';

const rom = readFileSync('FF3-English.nes');
initTextDecoder(rom);

function nesText(bytes) {
  let s = '';
  for (const b of bytes) {
    if (b >= 0xCA && b <= 0xE3) s += String.fromCharCode(b - 0xCA + 97);
    else if (b >= 0x8A && b <= 0xA3) s += String.fromCharCode(b - 0x8A + 65);
    else if (b >= 0x80 && b <= 0x89) s += String.fromCharCode(b - 0x80 + 48);
    else if (b === 0xFF) s += ' ';
    else if (b >= 0x5C && b <= 0x7B) continue;
  }
  return s.trim();
}
function spellStr(id) { try { return nesText(getSpellName(id & 0x7F)); } catch { return `spell${id}`; } }
function monStr(id) { try { return nesText(getMonsterName(id)); } catch { return `mon${id}`; } }

const MONSTER_PROPS  = 0x060010;
const MONSTER_ATKSCR = 0x061210;
const MONSTER_GIL    = 0x061C68;
const MONSTER_CP     = 0x0732BE;
const MONSTER_EXP_ID = 0x021C90;
const MONSTER_EXP_VAL= 0x021D90;
const STAT_TABLE     = 0x061010;
const BOSS_BIT       = 0x05CF10;

const ELEM_MAP = { 1:'recovery', 2:'dark', 4:'bolt', 8:'ice', 16:'fire', 32:'air', 64:'earth', 128:'holy' };
function elemVal(b) {
  if (!b) return null;
  const e = [];
  for (const [bit, n] of Object.entries(ELEM_MAP)) if (b & parseInt(bit)) e.push(n);
  return e;
}
function elemJS(arr) {
  if (!arr || arr.length === 0) return 'null';
  if (arr.length === 1) return `'${arr[0]}'`;
  return `[${arr.map(e=>`'${e}'`).join(',')}]`;
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
  return s;
}

// Read attack scripts
const scripts = [];
for (let i = 0; i < 64; i++) {
  const off = MONSTER_ATKSCR + i * 8;
  scripts.push(Array.from(rom.slice(off, off + 8)));
}

const lines = [];
lines.push(`// Monster Catalog — keyed by ROM bestiary ID`);
lines.push(`// AUTO-GENERATED from FF3 NES ROM via tools/gen-monsters-js.js`);
lines.push(`// Stats from Data Crystal ROM map ($60010 properties, $61010 stat table, $61210 attack scripts)`);
lines.push(`// Steal/drops/location preserved from previous manual data where available`);
lines.push(``);
lines.push(`export const MONSTERS = new Map([`);

for (let id = 0; id < 232; id++) {
  const off = MONSTER_PROPS + id * 16;
  const level = rom[off + 0];
  const hp = rom[off + 1] | (rom[off + 2] << 8);
  if (level === 0 && hp === 0) continue;

  const spAtkRate = rom[off + 3];
  const weakness = elemVal(rom[off + 5]);
  const spiritInt = rom[off + 7];
  const atkElem = elemVal(rom[off + 8]);
  const atkHitIdx = rom[off + 9];
  const statusOnAtk = rom[off + 10];
  const elemResist = elemVal(rom[off + 11]);
  const defEvdIdx = rom[off + 12];
  const statusResist = rom[off + 13];
  const spAtkIdx = rom[off + 14];
  const isBoss = !!(rom[BOSS_BIT + Math.floor(id / 8)] & (1 << (id % 8)));

  // Stat indices → actual values (3 bytes: attackRoll, hit%, attackPower)
  const atkOff = STAT_TABLE + atkHitIdx * 3;
  const attackRoll = rom[atkOff + 0];
  const atk = rom[atkOff + 2];
  const hitRate = rom[atkOff + 1];
  const defOff = STAT_TABLE + defEvdIdx * 3;
  const def = rom[defOff + 2];
  const evade = rom[defOff + 1];
  const mevIdx = rom[off + 6];
  const mdefOff = STAT_TABLE + mevIdx * 3;
  const mdef = rom[mdefOff + 1];
  const mevade = rom[mdefOff + 0];

  // Gil, CP, EXP
  const goff = MONSTER_GIL + id * 2;
  const gil = rom[goff] | (rom[goff + 1] << 8);
  const cp = rom[MONSTER_CP + id];
  const expGrp = rom[MONSTER_EXP_ID + id];
  const eoff = MONSTER_EXP_VAL + expGrp * 2;
  const exp = rom[eoff] | (rom[eoff + 1] << 8);

  // Special attack script
  let spAttacks = null;
  if (spAtkIdx > 0 && spAtkIdx < 64) {
    const scr = scripts[spAtkIdx];
    const unique = [...new Set(scr.map(s => spellStr(s)))];
    if (unique.length === 1) spAttacks = `['${unique[0]}']`;
    else spAttacks = `[${scr.map(s => `'${spellStr(s)}'`).join(',')}]`;
  }

  // Status on attack
  const statusAtk = statusVal(statusOnAtk);

  // Status resist (bitmask, same decoding as statusOnAtk)
  const statusResistArr = statusVal(statusResist);

  // Preserve steal/drops/location from old data
  const old = OLD_MONSTERS.get(id);

  const hex = `0x${id.toString(16).padStart(2, '0').toUpperCase()}`;
  const props = [];
  props.push(`level: ${level}`);
  props.push(`hp: ${hp.toString().padStart(5)}`);
  props.push(`atk: ${atk.toString().padStart(3)}`);
  props.push(`attackRoll: ${attackRoll}`);
  props.push(`hitRate: ${hitRate.toString().padStart(3)}`);
  props.push(`def: ${def}`);
  props.push(`evade: ${evade}`);
  props.push(`mdef: ${mdef}`);
  props.push(`mevade: ${mevade}`);
  props.push(`exp: ${exp.toString().padStart(5)}`);
  props.push(`gil: ${gil.toString().padStart(5)}`);
  props.push(`cp: ${cp}`);

  if (weakness && weakness.length) props.push(`weakness: ${elemJS(weakness)}`);
  if (elemResist && elemResist.length) props.push(`resist: ${elemJS(elemResist)}`);
  if (atkElem && atkElem.length) props.push(`atkElem: ${elemJS(atkElem)}`);
  if (statusAtk && statusAtk.length) props.push(`statusAtk: ${statusAtk.length===1?`'${statusAtk[0]}'`:`[${statusAtk.map(s=>`'${s}'`).join(',')}]`}`);
  if (spAtkRate > 0) props.push(`spAtkRate: ${spAtkRate}`);
  if (spAttacks) props.push(`attacks: ${spAttacks}`);
  if (statusResistArr && statusResistArr.length) props.push(`statusResist: ${statusResistArr.length===1?`'${statusResistArr[0]}'`:`[${statusResistArr.map(s=>`'${s}'`).join(',')}]`}`);
  if (spiritInt > 0) props.push(`spiritInt: ${spiritInt}`);
  if (isBoss) props.push(`boss: true`);

  // Preserve old fields
  if (old) {
    if (old.steal != null) props.push(`steal: 0x${old.steal.toString(16).toUpperCase()}`);
    if (old.drops && old.drops.length) props.push(`drops: [${old.drops.map(d => d != null ? `0x${d.toString(16).toUpperCase()}` : 'null').join(',')}]`);
    if (old.location) props.push(`location: [${old.location.map(l => `'${l}'`).join(',')}]`);
  }

  const name = monStr(id);
  lines.push(`  [${hex}, { ${props.join(', ')} }], // ${name}`);
}

lines.push(`]);`);
console.log(lines.join('\n'));
