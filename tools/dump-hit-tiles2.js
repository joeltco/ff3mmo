#!/usr/bin/env node
// Dump the hit effect base tiles (entries $00-$03) to see what's available
// These load to PPU $1490 = tile $49, 16 tiles each
import { readFileSync } from 'fs';

const rom = readFileSync('Final Fantasy III (Japan).nes');

function decodeTile(data, offset) {
  const rows = [];
  for (let y = 0; y < 8; y++) {
    const lo = data[offset + y];
    const hi = data[offset + y + 8];
    let row = '';
    for (let x = 7; x >= 0; x--) {
      const val = ((lo >> x) & 1) | (((hi >> x) & 1) << 1);
      row += ['.', '░', '▒', '█'][val];
    }
    rows.push(row);
  }
  return rows;
}

// Base effect entries all load to PPU $1490 = tile $49
const entries = [
  { id: 0, bank: 0x06, addr: 0xAFA0, name: 'effect set 0 (magic 0)' },
  { id: 1, bank: 0x06, addr: 0xAFE0, name: 'effect set 1 (magic 1)' },
  { id: 2, bank: 0x06, addr: 0xB020, name: 'effect set 2 (magic 2)' },
  { id: 3, bank: 0x06, addr: 0xB120, name: 'effect set 3 (magic 3)' },
  { id: 0x0E, bank: 0x15, addr: 0xB420, name: 'effect $0E (4 tiles to $49)' },
];

for (const e of entries) {
  const romOff = e.bank * 0x2000 + 0x10 + (e.addr >= 0xA000 ? e.addr - 0xA000 : e.addr - 0x8000);
  console.log(`\n=== Entry $${e.id.toString(16).padStart(2,'0')}: ${e.name} ===`);
  console.log(`ROM offset: 0x${romOff.toString(16).toUpperCase()}`);
  const numTiles = e.id === 0x0E ? 4 : 16;
  for (let t = 0; t < numTiles; t++) {
    const tile = decodeTile(rom, romOff + t * 16);
    const tileId = 0x49 + t;
    console.log(`\n  Tile $${tileId.toString(16)} (#${t}):`);
    tile.forEach(r => console.log('    ' + r));
  }
}

// Also dump the "unarmed" specific entry $0E which loads 4 tiles to PPU $1490
// Entry $0E: bank=$15, src=$B420, ppu=$1490, size=$04
// ROM = $15 * $2000 + $10 + ($B420 - $A000) = $2A010 + $1420 = $2B430
// This is RIGHT BEFORE the weapon graphics at $2B470 ($B460)
const E0E_ROM = 0x15 * 0x2000 + 0x10 + (0xB420 - 0xA000);
console.log(`\n=== Entry $0E: pre-weapon tiles (4 tiles to PPU $1490 = tile $49) ===`);
console.log(`ROM offset: 0x${E0E_ROM.toString(16).toUpperCase()}`);
for (let t = 0; t < 4; t++) {
  const tile = decodeTile(rom, E0E_ROM + t * 16);
  console.log(`\n  Tile $${(0x49 + t).toString(16)} (#${t}):`);
  tile.forEach(r => console.log('    ' + r));
}

// Now let's check what the weapon animation loader actually loads for unarmed
// The unarmed gfxID is $66 — but that's beyond the 18-entry table
// Maybe gfxID is split into two parts? Let's look at how gfxID is used
// in the battle graphics loading code

// Also check entry $10 (loads 4 tiles to $1490 from bank $15 addr $B160)
const E10_ROM = 0x15 * 0x2000 + 0x10 + (0xB160 - 0xA000);
console.log(`\n=== Entry $10: 4 tiles to PPU $1490 = tile $49 ===`);
console.log(`ROM offset: 0x${E10_ROM.toString(16).toUpperCase()}`);
for (let t = 0; t < 4; t++) {
  const tile = decodeTile(rom, E10_ROM + t * 16);
  console.log(`\n  Tile $${(0x49 + t).toString(16)} (#${t}):`);
  tile.forEach(r => console.log('    ' + r));
}

// Check what's at bank $06 for the magic effect base set
// The claw animation specifically uses tiles $49-$4C and $4D
// with tiles $49-$4C being the "base" effect and $4D from weapon set
// Let's focus on entry $00 tiles $49-$4C (first 4 tiles)
console.log('\n=== Summary: Claw/Punch uses tiles $4A-$4D (frame $12) ===');
console.log('Tiles $4A,$4B,$4C from the base effect set');
console.log('Tile $4D from the weapon graphics set');
console.log('\nFor unarmed, the hit animation is type 2 (claw)');
console.log('Frame $12: arrangement $09 = 2x2 with flips');
console.log('Frame $13: arrangement $0A = 2x2 mirrored');
