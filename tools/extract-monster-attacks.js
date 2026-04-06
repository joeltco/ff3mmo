#!/usr/bin/env node
// Extract monster special attack data from FF3 ROM
// Monster properties: 30/8000 (ROM 0x060010), 256 × 16 bytes
// Attack scripts:     30/9200 (ROM 0x061210), 49 × 8 bytes

import { readFileSync } from 'fs';
import { initTextDecoder, getSpellName, getMonsterName } from '../src/text-decoder.js';

const rom = readFileSync('FF3-English.nes');
initTextDecoder(rom);

const MONSTER_PROPS = 0x060010;
const ATTACK_SCRIPTS = 0x061210;
const BOSS_BIT = 0x05CF10;

function nesTextToAscii(bytes) {
  let s = '';
  for (const b of bytes) {
    if (b >= 0xCA && b <= 0xE3) s += String.fromCharCode(b - 0xCA + 'a'.charCodeAt(0));
    else if (b >= 0x80 && b <= 0x89) s += String.fromCharCode(b - 0x80 + '0'.charCodeAt(0));
    else if (b >= 0x8A && b <= 0xA3) s += String.fromCharCode(b - 0x8A + 'A'.charCodeAt(0));
    else if (b === 0xFF) s += ' ';
    else if (b === 0xC4) s += '!';
    else if (b === 0xC5) s += '?';
    else if (b === 0xC8) s += ':';
    else if (b === 0xC9) s += '-';
    else if (b >= 0x5C && b <= 0x7B) continue; // icon tile
  }
  return s.trim();
}

function getSpellStr(id) {
  try { return nesTextToAscii(getSpellName(id & 0x7F)); } catch { return `?0x${(id&0x7F).toString(16)}`; }
}
function getMonsterStr(id) {
  try { return nesTextToAscii(getMonsterName(id)); } catch { return `?0x${id.toString(16)}`; }
}

// Read all 49 attack scripts
const scripts = [];
for (let i = 0; i < 49; i++) {
  const off = ATTACK_SCRIPTS + i * 8;
  const spells = [];
  for (let j = 0; j < 8; j++) {
    const raw = rom[off + j];
    const targetSelf = !!(raw & 0x80);
    const spellId = raw & 0x7F;
    spells.push({ raw, spellId, targetSelf, name: getSpellStr(raw) });
  }
  scripts.push(spells);
}

console.log('=== MONSTER SPECIAL ATTACKS ===\n');

for (let id = 0; id < 256; id++) {
  const off = MONSTER_PROPS + id * 16;
  const level = rom[off];
  const hp = rom[off + 1] | (rom[off + 2] << 8);
  const spAtkRate = rom[off + 3];
  const scriptIdx = rom[off + 0x0E];
  const isBoss = !!(rom[BOSS_BIT + Math.floor(id / 8)] & (1 << (id % 8)));

  if (spAtkRate === 0 && scriptIdx === 0) continue;

  const name = getMonsterStr(id);
  const script = scriptIdx < 49 ? scripts[scriptIdx] : null;

  console.log(`[0x${id.toString(16).padStart(2,'0')}] ${name} (Lv${level} HP:${hp}) — rate:${spAtkRate}% script:${scriptIdx} ${isBoss ? 'BOSS' : ''}`);
  if (script) {
    const unique = [...new Set(script.map(s => s.name))];
    if (unique.length === 1) {
      const s = script[0];
      console.log(`  all slots: ${s.name} ${s.targetSelf ? '[self]' : ''}`);
    } else {
      for (let j = 0; j < 8; j++) {
        const s = script[j];
        console.log(`  ${j}: ${s.name} ${s.targetSelf ? '[self]' : ''}`);
      }
    }
  }
  console.log('');
}
