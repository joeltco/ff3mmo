#!/usr/bin/env node
// Generate encounters.js from FF3 NES ROM data
// Maps encounter IDs to formations with per-group min/max

import { readFileSync } from 'fs';
import { initTextDecoder, getMonsterName } from '../src/text-decoder.js';

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
function monStr(id) { try { return nesText(getMonsterName(id)); } catch { return `mon${id}`; } }

const ENCOUNTER_SET = 0x05C010;
const ENCOUNTER_MON = 0x05C410;
const ENCOUNTER_STR = 0x05CA10;

// Read all 256 encounter formations
const formations = [];
for (let i = 0; i < 256; i++) {
  const soff = ENCOUNTER_SET + i * 2;
  const monListIdx = rom[soff];
  const flags = rom[soff + 1];
  const structIdx = flags & 0x3F;
  const isBoss = !!(flags & 0x40);

  const moff = ENCOUNTER_MON + monListIdx * 6;
  const monIds = [rom[moff + 2], rom[moff + 3], rom[moff + 4], rom[moff + 5]];

  const strOff = ENCOUNTER_STR + structIdx * 4;
  const groups = [];
  for (let g = 0; g < 4; g++) {
    const b = rom[strOff + g];
    const min = (b >> 4) & 0xF;
    const max = b & 0xF;
    if (max > 0 && monIds[g] !== 0xFF) {
      groups.push({ monsterId: monIds[g], min, max });
    }
  }

  formations.push({ id: i, groups, isBoss });
}

// Build the encounters.js output
// Zone-based structure matching our current system
// Each zone has an array of possible formations (picked randomly per encounter)

const lines = [];
lines.push(`// Encounter Catalog — zone-based with NES ROM formations`);
lines.push(`// AUTO-GENERATED from FF3 NES ROM via tools/gen-encounters-js.js`);
lines.push(`// Each formation has groups: [{ monsterId, min, max }, ...]`);
lines.push(`// Formation data from ROM $5C010 (settings), $5C410 (monster lists), $5CA10 (structures)`);
lines.push(``);

// Helper to format a formation
function fmtFormation(f) {
  const gs = f.groups.map(g => {
    const name = monStr(g.monsterId);
    return `{ id: 0x${g.monsterId.toString(16).padStart(2,'0')}, min: ${g.min}, max: ${g.max} }`;
  });
  return `[${gs.join(', ')}]`;
}

// Map NES encounters to our zones
// Altar Cave: enc 0-3 (floors 1-4 roughly), boss enc 77
// Grasslands: enc 45-48 (Killer Bee, Werewolf, Berserker)
// Sasoon Castle: enc 4-5
// Cave of the Seal: enc 6-12
// Summit Road: enc 13-15
// Nepto Shrine: enc 16-21
// Tower of Owen: enc 22-29
// Dwarven Cave: enc 30-34
// Flame Cave: enc 35-39
// Castle Hyne: enc 40-44
// World map grasslands near Ur uses Goblin encounters

lines.push(`export const ENCOUNTERS = new Map([`);

// --- World map grasslands ---
lines.push(`  // --- World map (grasslands near Ur) ---`);
lines.push(`  ['grasslands', {`);
lines.push(`    rate: 'low',`);
lines.push(`    formations: [`);
lines.push(`      ${fmtFormation(formations[0])}, // Goblin x2-4`);
lines.push(`      ${fmtFormation(formations[45])}, // Killer Bee x2-4`);
lines.push(`      ${fmtFormation(formations[46])}, // Werewolf x2-4`);
lines.push(`    ],`);
lines.push(`  }],`);

// --- Altar Cave ---
lines.push(`  // --- Altar Cave ---`);
lines.push(`  ['altar_cave_f1', {`);
lines.push(`    rate: 'normal',`);
lines.push(`    formations: [`);
lines.push(`      ${fmtFormation(formations[0])}, // Goblin x2-4`);
lines.push(`      ${fmtFormation(formations[1])}, // Eye Fang + Carbuncle`);
lines.push(`    ],`);
lines.push(`  }],`);

lines.push(`  ['altar_cave_f2', {`);
lines.push(`    rate: 'normal',`);
lines.push(`    formations: [`);
lines.push(`      ${fmtFormation(formations[1])}, // Eye Fang + Carbuncle`);
lines.push(`      ${fmtFormation(formations[2])}, // Blue Wisp + Carbuncle`);
lines.push(`      ${fmtFormation(formations[3])}, // Eye Fang + Blue Wisp + Carbuncle`);
lines.push(`    ],`);
lines.push(`  }],`);

lines.push(`  ['altar_cave_f3', {`);
lines.push(`    rate: 'normal',`);
lines.push(`    formations: [`);
lines.push(`      ${fmtFormation(formations[2])}, // Blue Wisp + Carbuncle`);
lines.push(`      ${fmtFormation(formations[3])}, // Eye Fang + Blue Wisp + Carbuncle`);
lines.push(`    ],`);
lines.push(`  }],`);

lines.push(`  ['altar_cave_f4', {`);
lines.push(`    rate: 'normal',`);
lines.push(`    formations: [`);
lines.push(`      ${fmtFormation(formations[2])}, // Blue Wisp + Carbuncle`);
lines.push(`      ${fmtFormation(formations[3])}, // Eye Fang + Blue Wisp + Carbuncle`);
lines.push(`    ],`);
lines.push(`  }],`);

lines.push(`  ['altar_cave_boss', {`);
lines.push(`    rate: 'fixed',`);
lines.push(`    formations: [`);
lines.push(`      ${fmtFormation(formations[77])}, // Land Turtle`);
lines.push(`    ],`);
lines.push(`  }],`);

lines.push(`]);`);
console.log(lines.join('\n'));
