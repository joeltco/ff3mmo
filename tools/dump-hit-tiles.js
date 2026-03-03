#!/usr/bin/env node
// Dump battle animation hit effect tiles from ROM
// Usage: node tools/dump-hit-tiles.js

import { readFileSync } from 'fs';

const rom = readFileSync('Final Fantasy III (Japan).nes');

// Animation graphics table at 33/BEB2 — 6-byte entries
// Entry $09 = weapons: 60 B4 D0 14 0D 15
//   source addr=$B460, PPU dest=$14D0, size=$0D, bank=$15
// PPU $14D0 = tile $4D in sprite table (at $1000)
// So weapon tiles start at tile $4D

// Weapon graphics entry: bank $15, addr $B460
// ROM offset = bank * 0x2000 + 0x10 + (addr - 0xA000)
const WEAPON_GFX_BANK = 0x15;
const WEAPON_GFX_ADDR = 0xB460;
const WEAPON_GFX_SIZE = 0x0D; // possibly tile count or blocks
const WEAPON_GFX_ROM = WEAPON_GFX_BANK * 0x2000 + 0x10 + (WEAPON_GFX_ADDR - 0xA000);

console.log(`Weapon graphics ROM offset: 0x${WEAPON_GFX_ROM.toString(16).toUpperCase()}`);
console.log(`First 64 bytes at weapon graphics:`);
const weaponBytes = rom.slice(WEAPON_GFX_ROM, WEAPON_GFX_ROM + 256);
for (let row = 0; row < 16; row++) {
  const hex = Array.from(weaponBytes.slice(row * 16, (row + 1) * 16))
    .map(b => b.toString(16).padStart(2, '0')).join(' ');
  console.log(`  +${(row * 16).toString(16).padStart(3, '0')}: ${hex}`);
}

// Now let's look at the animation graphics table itself
// 33/BEB2 → ROM = 0x33 * 0x2000 + 0x10 + (0xBEB2 - 0xA000) = 0x66010 + 0x1EB2 = 0x67EC2
const TABLE_ROM = 0x33 * 0x2000 + 0x10 + (0xBEB2 - 0xA000);
console.log(`\nAnimation graphics table at ROM offset: 0x${TABLE_ROM.toString(16).toUpperCase()}`);
console.log('Entries:');
for (let i = 0; i < 18; i++) {
  const off = TABLE_ROM + i * 6;
  const b = rom.slice(off, off + 6);
  const srcAddr = b[0] | (b[1] << 8);
  const ppuDest = b[2] | (b[3] << 8);
  const size = b[4];
  const bank = b[5];
  console.log(`  $${i.toString(16).padStart(2, '0')}: bank=$${bank.toString(16).padStart(2, '0')} src=$${srcAddr.toString(16).padStart(4, '0')} ppu=$${ppuDest.toString(16).padStart(4, '0')} size=$${size.toString(16).padStart(2, '0')}  raw=[${Array.from(b).map(v=>v.toString(16).padStart(2,'0')).join(' ')}]`);
}

// Weapon animation properties table at 2E/9098
// ROM = 0x2E * 0x2000 + 0x10 + (0x9098 - 0x8000) = 0x5C010 + 0x1098 = 0x5D0A8
const WPROP_ROM = 0x2E * 0x2000 + 0x10 + (0x9098 - 0x8000);
console.log(`\nWeapon animation properties at ROM offset: 0x${WPROP_ROM.toString(16).toUpperCase()}`);
console.log('Entries (3 bytes each: animID, gfxID, palID):');
const wpropNames = ['unarmed','sword','axe/hammer','bow','harp','boomerang','fullmoon','shuriken','arrow','claw'];
for (let i = 0; i < 10; i++) {
  const off = WPROP_ROM + i * 3;
  const b = rom.slice(off, off + 3);
  console.log(`  ${i} (${wpropNames[i] || '?'}): animID=$${b[0].toString(16).padStart(2, '0')} gfxID=$${b[1].toString(16).padStart(2, '0')} palID=$${b[2].toString(16).padStart(2, '0')}`);
}

// Decode a 2BPP tile to ASCII art
function decodeTile(data, offset) {
  const pixels = [];
  for (let y = 0; y < 8; y++) {
    const lo = data[offset + y];
    const hi = data[offset + y + 8];
    let row = '';
    for (let x = 7; x >= 0; x--) {
      const val = ((lo >> x) & 1) | (((hi >> x) & 1) << 1);
      row += ['.', '░', '▒', '█'][val];
    }
    pixels.push(row);
  }
  return pixels;
}

// Dump tiles from weapon graphics offset
console.log('\n--- Weapon GFX tiles (starting at PPU tile $4D) ---');
for (let t = 0; t < 16; t++) {
  const tileOff = WEAPON_GFX_ROM + t * 16;
  const tile = decodeTile(rom, tileOff);
  console.log(`\nTile $${(0x4D + t).toString(16)} (offset +${(t * 16).toString(16)}):`);
  tile.forEach(r => console.log('  ' + r));
}

// Also look at what's BEFORE the weapon tiles (tiles $49-$4C)
// These might be loaded by a different graphics entry
// Entry $08: 40 A7 10 16 08 15 → bank=$15 src=$A740 ppu=$1610 size=$08
const ENTRY08_ROM = 0x15 * 0x2000 + 0x10 + (0xA740 - 0xA000);
console.log(`\n--- Entry $08 tiles (bank $15, src=$A740, ppu=$1610 = tile $61) ---`);
console.log(`ROM offset: 0x${ENTRY08_ROM.toString(16).toUpperCase()}`);
for (let t = 0; t < 8; t++) {
  const tileOff = ENTRY08_ROM + t * 16;
  const tile = decodeTile(rom, tileOff);
  console.log(`\nTile $${(0x61 + t).toString(16)} (offset +${(t * 16).toString(16)}):`);
  tile.forEach(r => console.log('  ' + r));
}

// Now check: where do tiles $49-$4C come from?
// PPU $1490-$14CF = tiles $49-$4C
// Let me check all entries that load to nearby PPU addresses
console.log('\n--- Searching for graphics entries that load near PPU $1490-$14D0 ---');
for (let i = 0; i < 18; i++) {
  const off = TABLE_ROM + i * 6;
  const b = rom.slice(off, off + 6);
  const ppuDest = b[2] | (b[3] << 8);
  if (ppuDest >= 0x1400 && ppuDest <= 0x1500) {
    const srcAddr = b[0] | (b[1] << 8);
    const bank = b[5];
    const size = b[4];
    console.log(`  Entry $${i.toString(16).padStart(2,'0')}: ppu=$${ppuDest.toString(16)} bank=$${bank.toString(16)} src=$${srcAddr.toString(16)} size=$${size.toString(16)}`);
  }
}
