#!/usr/bin/env node
// Rebuild items.js with ROM-verified stats + existing job masks from current items.js
// Outputs complete items.js to stdout

import { readFileSync } from 'fs';
import { ITEMS } from '../src/data/items.js';

const romStats = JSON.parse(readFileSync('tools/rom-item-stats.json', 'utf8'));

// Read current items.js to preserve header/footer
const currentSrc = readFileSync('src/data/items.js', 'utf8');

// Extract everything before "export const ITEMS" and after the closing ]);
const headerMatch = currentSrc.match(/^([\s\S]*?)export const ITEMS/);
const header = headerMatch ? headerMatch[1] : '';

// Rebuild each item entry
const lines = [];
lines.push(header + 'export const ITEMS = new Map([');

for (const [id, item] of ITEMS) {
  const hex = `0x${id.toString(16).padStart(2,'0')}`;
  const rom = romStats[hex];

  const props = [];

  if (item.type === 'weapon') {
    props.push(`type: 'weapon'`);
    props.push(`subtype: '${item.subtype}'`);
    props.push(`atk: ${rom ? rom.atk : item.atk}`);
    props.push(`hit: ${rom ? rom.hit : item.hit}`);

    // Element from ROM
    if (rom && rom.element) {
      if (Array.isArray(rom.element)) props.push(`element: [${rom.element.map(e=>`'${e}'`).join(', ')}]`);
      else props.push(`element: '${rom.element}'`);
    } else if (item.element && !rom) {
      if (Array.isArray(item.element)) props.push(`element: [${item.element.map(e=>`'${e}'`).join(', ')}]`);
      else props.push(`element: '${item.element}'`);
    }

    // Status from ROM
    if (rom && rom.status) {
      if (Array.isArray(rom.status)) props.push(`status: [${rom.status.map(s=>`'${s}'`).join(', ')}]`);
      else props.push(`status: '${rom.status}'`);
    }

    // Casts from ROM
    if (rom && rom.casts) props.push(`casts: ${rom.casts}`);

    // Two-handed from ROM
    if (rom && rom.twoHanded) props.push(`twoHanded: true`);

    // Stat bonuses from ROM
    if (rom && rom.strBonus) props.push(`strBonus: ${rom.strBonus}`);
    if (rom && rom.agiBonus) props.push(`agiBonus: ${rom.agiBonus}`);
    if (rom && rom.vitBonus) props.push(`vitBonus: ${rom.vitBonus}`);
    if (rom && rom.intBonus) props.push(`intBonus: ${rom.intBonus}`);
    if (rom && rom.mndBonus) props.push(`mndBonus: ${rom.mndBonus}`);

    props.push(`price: ${(rom ? rom.price : item.price).toString().padStart(5)}`);

    // Jobs — keep existing
    // Reconstruct jobs expression from the numeric value
    props.push(`jobs: ${reconstructJobs(item.jobs)}`);

  } else if (item.type === 'armor') {
    props.push(`type: 'armor'`);
    props.push(`subtype: '${item.subtype}'`);
    props.push(`def: ${rom ? rom.def : item.def}`);
    props.push(`evade: ${rom ? rom.evade : (item.evade || 0)}`);
    props.push(`mdef: ${rom ? rom.mdef : (item.mdef || 0)}`);

    // Resist from ROM
    if (rom && rom.resist) {
      if (Array.isArray(rom.resist)) props.push(`resist: [${rom.resist.map(e=>`'${e}'`).join(', ')}]`);
      else props.push(`resist: '${rom.resist}'`);
    }

    // Status resist from ROM
    if (rom && rom.sResist) props.push(`sResist: ${rom.sResist}`);

    // Stat bonuses from ROM
    if (rom && rom.strBonus) props.push(`strBonus: ${rom.strBonus}`);
    if (rom && rom.agiBonus) props.push(`agiBonus: ${rom.agiBonus}`);
    if (rom && rom.vitBonus) props.push(`vitBonus: ${rom.vitBonus}`);
    if (rom && rom.intBonus) props.push(`intBonus: ${rom.intBonus}`);
    if (rom && rom.mndBonus) props.push(`mndBonus: ${rom.mndBonus}`);

    props.push(`price: ${(rom ? rom.price : item.price).toString().padStart(5)}`);
    props.push(`jobs: ${reconstructJobs(item.jobs)}`);

  } else {
    // Consumable/battle/key items
    props.push(`type: '${item.type}'`);
    if (rom) props.push(`price: ${rom.price.toString().padStart(5)}`);
    else if (item.price != null) props.push(`price: ${item.price.toString().padStart(5)}`);
  }

  lines.push(`  [${hex}, { ${props.join(', ')} }],`);
}

lines.push(']);');
lines.push('');

// Utility exports
lines.push(`export function isWeapon(id) { const i = ITEMS.get(id); return i && i.type === 'weapon' && i.subtype !== 'shield'; }`);
lines.push(`export function weaponSubtype(id) { const i = ITEMS.get(id); return (i && i.type === 'weapon') ? i.subtype : null; }`);

console.log(lines.join('\n'));

// Job mask reconstruction
function reconstructJobs(mask) {
  if (mask === undefined || mask === null) return '0';
  const ALL = (1 << 22) - 1;
  if (mask === ALL) return 'ALL';
  if (mask === (ALL & ~(1<<14))) return 'ALL_BUT_MK';
  const names = ['On','Fi','Mo','Ww','Bw','Rw','Hu','Kn','Th','Sc','Ge','Dr','Vi','Ka','Mk','Co','Ba','Su','Sh','Wa','Sa','Ni'];
  const parts = [];
  for (let j = 0; j < 22; j++) {
    if (mask & (1 << j)) parts.push(names[j]);
  }
  return parts.join('|') || '0';
}
