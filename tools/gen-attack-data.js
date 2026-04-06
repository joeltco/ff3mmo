#!/usr/bin/env node
// Generate spAtkRate + attacks data for monsters.js
// Outputs JS-ready data to paste into monsters.js

import { readFileSync } from 'fs';
import { initTextDecoder, getSpellName } from '../src/text-decoder.js';

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
    else if (b >= 0x5C && b <= 0x7B) continue;
  }
  return s.trim();
}

function getSpellStr(id) {
  try { return nesTextToAscii(getSpellName(id & 0x7F)); } catch { return `spell${id&0x7F}`; }
}

// Read attack scripts
const scripts = [];
for (let i = 0; i < 49; i++) {
  const off = ATTACK_SCRIPTS + i * 8;
  const spells = [];
  for (let j = 0; j < 8; j++) {
    const raw = rom[off + j];
    spells.push({ id: raw & 0x7F, self: !!(raw & 0x80), name: getSpellStr(raw) });
  }
  scripts.push(spells);
}

// For each monster, output the attack fields
for (let id = 0; id < 256; id++) {
  const off = MONSTER_PROPS + id * 16;
  const spAtkRate = rom[off + 3];
  const scriptIdx = rom[off + 0x0E];
  const isBoss = !!(rom[BOSS_BIT + Math.floor(id / 8)] & (1 << (id % 8)));

  if (spAtkRate === 0 && scriptIdx === 0) continue;

  const script = scriptIdx < 49 ? scripts[scriptIdx] : null;
  if (!script) continue;

  // Build compact attacks array
  const unique = [...new Set(script.map(s => s.name))];
  let attacksStr;
  if (unique.length === 1) {
    attacksStr = `['${unique[0]}']`;
  } else {
    attacksStr = `[${script.map(s => `'${s.name}'`).join(',')}]`;
  }

  console.log(`0x${id.toString(16).padStart(2,'0').toUpperCase()}: spAtkRate: ${spAtkRate}, attacks: ${attacksStr}${isBoss ? ', boss: true' : ''}`);
}
