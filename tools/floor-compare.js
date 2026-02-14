#!/usr/bin/env node
// Floor Compare — dumps original ROM cave maps and generated floor 2 as ASCII grids
// Usage: node tools/floor-compare.js [seed]

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROM_PATH = join(__dirname, '..', 'Final Fantasy III (Japan).nes');
const rom = readFileSync(ROM_PATH);

// ─── ROM tilemap decompression ───

const TILEMAP_PTR_BASE = 0x022010;
const TILEMAP_ID_BASE  = 0x000A10;
const MAP_PROPS_BASE   = 0x004010;

function decompressTilemap(tmId) {
  const ptrIndex = (tmId * 2) & 0xFF;
  const ptrTableHi = (tmId & 0x80) ? 0x81 : 0x80;
  const ptrBase = TILEMAP_PTR_BASE + ((ptrTableHi - 0x80) << 8);
  const lo = rom[ptrBase + ptrIndex];
  const hi = rom[ptrBase + ptrIndex + 1];
  const nesHi = (hi & 0x1F) | 0x80;
  const bank = 0x11 + (hi >> 5);
  const offset = bank * 0x2000 + 0x10 + ((nesHi << 8 | lo) - 0x8000);

  const tilemap = new Uint8Array(1024);
  let rp = offset, wp = 0;
  while (wp < 1024) {
    const b = rom[rp++];
    if ((b & 0x80) === 0) {
      tilemap[wp++] = b;
    } else {
      const tile = b & 0x7F;
      const run = rom[rp++];
      for (let i = 0; i < run && wp < 1024; i++) tilemap[wp++] = tile;
    }
  }
  return tilemap;
}

function getRomTilemap(mapId) {
  const tmId = rom[TILEMAP_ID_BASE + mapId];
  return decompressTilemap(tmId);
}

// ─── Generated floor ───

import { generateFloor } from '../src/dungeon-generator.js';

// ─── ASCII rendering ───

function tileChar(t) {
  switch (t) {
    case 0x00: return 'C'; // CEILING
    case 0x01: return 'W'; // WALL_ROCKY
    case 0x30: return '.'; // FLOOR (walkable)
    case 0x5f: return ' '; // VOID
    case 0x44: return 'F'; // FALSE_CEILING
    case 0x03: return 'A'; // ENTRANCE_TOP (arch)
    case 0x41: return 'P'; // PASSAGE
    case 0x49: return 'v'; // PASSAGE_BTM
    case 0x68: return 'X'; // EXIT_PREV
    case 0x6a: return 'E'; // PASSAGE_ENTRY
    case 0x73: return 'S'; // STAIRS_DOWN
    case 0x72: return 'T'; // TRAP_HOLE
    case 0x7C: return '$'; // CHEST
    case 0x42: return 'a'; // STAIR_ARCH
    case 0x09: return 'b'; // BONES
    case 0x04: return '~'; // WATER_CENTER
    case 0x08: return '~'; // WATER_EDGE
    case 0x60: return '!'; // EVENT
    case 0x3A: case 0x3B: case 0x3C: case 0x3D: return 'O'; // WARP
    default:   return '?'; // unknown
  }
}

function printTilemap(label, tilemap) {
  console.log(`\n${'═'.repeat(34)}`);
  console.log(`  ${label}`);
  console.log(`${'═'.repeat(34)}`);
  console.log('   0123456789012345678901234567890 ');
  for (let y = 0; y < 32; y++) {
    let row = '';
    for (let x = 0; x < 32; x++) {
      row += tileChar(tilemap[y * 32 + x]);
    }
    console.log(`${String(y).padStart(2)}|${row}|`);
  }
  console.log(`${'─'.repeat(34)}`);
  console.log('Legend: C=ceiling W=wall .=floor  =void E=entry v=stair S=stairs $=chest');
}

// ─── Validation: check the 2-wall overhang rule ───

function validateOverhang(tilemap, label) {
  const violations = [];
  for (let x = 0; x < 32; x++) {
    for (let y = 0; y < 30; y++) {
      if (tilemap[y * 32 + x] !== 0x00) continue; // not ceiling
      const below1 = y + 1 < 32 ? tilemap[(y + 1) * 32 + x] : -1;
      const below2 = y + 2 < 32 ? tilemap[(y + 2) * 32 + x] : -1;
      // Check: if below1 is WALL, below2 should also be WALL (not floor)
      if (below1 === 0x01 && below2 === 0x30) {
        violations.push(`(${x},${y}): C→W→FLOOR (only 1 wall)`);
      }
      // Check: ceiling directly above floor (no wall at all)
      if (below1 === 0x30) {
        violations.push(`(${x},${y}): C→FLOOR (no wall)`);
      }
    }
  }
  if (violations.length > 0) {
    console.log(`\n⚠ ${label}: ${violations.length} overhang violations:`);
    violations.slice(0, 10).forEach(v => console.log(`  ${v}`));
    if (violations.length > 10) console.log(`  ... and ${violations.length - 10} more`);
  } else {
    console.log(`\n✓ ${label}: overhang rule OK (CEILING → 2 WALL → FLOOR everywhere)`);
  }
}

// ─── Main ───

// Original ROM cave maps
console.log('\n=== ORIGINAL ROM ALTAR CAVE MAPS ===');
const map112 = getRomTilemap(112);
printTilemap('Map 112 (Altar Cave B1)', map112);
validateOverhang(map112, 'Map 112');

const map113 = getRomTilemap(113);
printTilemap('Map 113 (Altar Cave B2)', map113);
validateOverhang(map113, 'Map 113');

// Generated floor 2
const seed = parseInt(process.argv[2], 10) || 42;
console.log(`\n=== GENERATED FLOOR 2 (seed=${seed}) ===`);
const floor = generateFloor(rom, 1, seed);
printTilemap(`Generated Floor 2 (floorIndex=1, seed=${seed})`, floor.tilemap);
validateOverhang(floor.tilemap, 'Generated Floor 2');

// Try a few more seeds to show variety
for (const s of [123, 777, 2024]) {
  const f = generateFloor(rom, 1, s);
  printTilemap(`Generated Floor 2 (seed=${s})`, f.tilemap);
  validateOverhang(f.tilemap, `Seed ${s}`);
}

// Generated floor 3 (rock puzzle)
const seeds3 = process.argv.slice(2).map(s => parseInt(s, 10)).filter(n => !isNaN(n));
if (seeds3.length === 0) seeds3.push(42);
console.log(`\n=== GENERATED FLOOR 3 (rock puzzle) ===`);
for (const s of seeds3) {
  const f = generateFloor(rom, 2, s);
  printTilemap(`Floor 3 (seed=${s})`, f.tilemap);
  validateOverhang(f.tilemap, `Floor 3 seed=${s}`);
  if (f.rockSwitch) {
    console.log(`  Rock: (${f.rockSwitch.rockX},${f.rockSwitch.rockY})  Wall tiles: ${f.rockSwitch.wallTiles.map(w => `(${w.x},${w.y})`).join(' ')}`);
  }
}
