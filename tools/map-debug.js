#!/usr/bin/env node
// Diagnostic script: dump ROM data for map 114 (Ur) to verify the pipeline

import { readFileSync } from 'fs';

const rom = readFileSync('Final Fantasy III (Japan).nes');
console.log(`ROM size: ${rom.length} bytes`);

// === Map Properties ===
const MAP_ID = 114;
const MAP_PROPS_BASE = 0x004010;
const propOffset = MAP_PROPS_BASE + MAP_ID * 16;
const props = rom.slice(propOffset, propOffset + 16);
console.log(`\n=== Map ${MAP_ID} Properties (at 0x${propOffset.toString(16)}) ===`);
console.log(`Raw bytes: ${Array.from(props).map(b => b.toString(16).padStart(2,'0')).join(' ')}`);
const tileset = (props[0] >> 5) & 0x07;
const entrX = props[0] & 0x1F;
const entrY = props[1] & 0x1F;
const fillTile = props[3];
console.log(`Tileset: ${tileset}, Entrance: (${entrX}, ${entrY}), Fill tile: ${fillTile}`);
console.log(`BG palette indices: [${props[5]}, ${props[6]}, ${props[7]}]`);

// === Graphics Subset ===
const GFX_SUBSET_ID_BASE = 0x000C10;
const GFX_SUBSET_BASE = 0x000E10;
const subsetId = rom[GFX_SUBSET_ID_BASE + MAP_ID];
const subsetOffset = GFX_SUBSET_BASE + subsetId * 16;
const subsetData = rom.slice(subsetOffset, subsetOffset + 16);
console.log(`\n=== Graphics Subset (ID: ${subsetId}, at 0x${subsetOffset.toString(16)}) ===`);
console.log(`Raw bytes: ${Array.from(subsetData).map(b => b.toString(16).padStart(2,'0')).join(' ')}`);

const GFX_SLOT_COUNTS = [0x1A, 0x08, 0x08, 0x0E, 0x08, 0x10, 0x10, 0x10];
const MAP_BG_GFX_BASE = 0x006010;
let totalTiles = 0;
for (let i = 0; i < 8; i++) {
  const ptr = subsetData[i*2] | (subsetData[i*2+1] << 8);
  const count = GFX_SLOT_COUNTS[i];
  totalTiles += count;
  // Try different pointer interpretations
  const offsetTimes1 = MAP_BG_GFX_BASE + ptr;
  const offsetTimes2 = MAP_BG_GFX_BASE + ptr * 2;
  const offsetTimes16 = MAP_BG_GFX_BASE + ptr * 16;
  // Also try: pointer as a CHR tile index (each tile = 16 bytes)
  console.log(`Slot ${i}: ptr=0x${ptr.toString(16).padStart(4,'0')} (${ptr}), count=${count}, ×1=0x${offsetTimes1.toString(16)}, ×2=0x${offsetTimes2.toString(16)}, ×16=0x${offsetTimes16.toString(16)}`);

  // Show first 4 bytes at each interpretation to see which looks like valid 2BPP tile data
  console.log(`  ×1 first bytes: ${Array.from(rom.slice(offsetTimes1, offsetTimes1+8)).map(b=>b.toString(16).padStart(2,'0')).join(' ')}`);
  console.log(`  ×2 first bytes: ${Array.from(rom.slice(offsetTimes2, offsetTimes2+8)).map(b=>b.toString(16).padStart(2,'0')).join(' ')}`);
  console.log(`  ×16 first bytes: ${Array.from(rom.slice(offsetTimes16, offsetTimes16+8)).map(b=>b.toString(16).padStart(2,'0')).join(' ')}`);
}
console.log(`Total CHR tiles expected: ${totalTiles}`);

// === Tileset ===
const TILESET_BASE = 0x002390;
const tilesetOffset = TILESET_BASE + tileset * 512;
const tilesetData = rom.slice(tilesetOffset, tilesetOffset + 512);
console.log(`\n=== Tileset ${tileset} (at 0x${tilesetOffset.toString(16)}) ===`);
console.log(`First 64 bytes: ${Array.from(tilesetData.slice(0, 64)).map(b => b.toString(16).padStart(2,'0')).join(' ')}`);
// Show metatile 0 decode
const m0off = ((0 & 0x70) << 2) | ((0 & 0x0F) << 1);
console.log(`Metatile 0: offset=${m0off}, TL=${tilesetData[m0off]}, TR=${tilesetData[m0off+1]}, BL=${tilesetData[m0off+32]}, BR=${tilesetData[m0off+33]}`);
const m1off = ((1 & 0x70) << 2) | ((1 & 0x0F) << 1);
console.log(`Metatile 1: offset=${m1off}, TL=${tilesetData[m1off]}, TR=${tilesetData[m1off+1]}, BL=${tilesetData[m1off+32]}, BR=${tilesetData[m1off+33]}`);

// Max CHR tile index in the tileset
let maxChr = 0;
for (let m = 0; m < 128; m++) {
  const off = ((m & 0x70) << 2) | ((m & 0x0F) << 1);
  maxChr = Math.max(maxChr, tilesetData[off], tilesetData[off+1], tilesetData[off+32], tilesetData[off+33]);
}
console.log(`Max CHR tile index referenced by tileset: ${maxChr} (we load ${totalTiles} tiles)`);

// === Tilemap ===
const TILEMAP_PTR_BASE = 0x022010;
const TILEMAP_DATA_BASE = 0x022210;
const tmapPtrOff = TILEMAP_PTR_BASE + MAP_ID * 2;
const tmapPtr = rom[tmapPtrOff] | (rom[tmapPtrOff+1] << 8);
const tmapDataOff = TILEMAP_DATA_BASE + tmapPtr;
console.log(`\n=== Tilemap (ptr=0x${tmapPtr.toString(16)}, data at 0x${tmapDataOff.toString(16)}) ===`);
console.log(`First 32 bytes: ${Array.from(rom.slice(tmapDataOff, tmapDataOff+32)).map(b => b.toString(16).padStart(2,'0')).join(' ')}`);

// Decompress and show first row
const tilemap = new Uint8Array(1024);
let pos = 0;
let readOff = tmapDataOff;
while (pos < 1024) {
  const byte = rom[readOff++];
  if (byte < 0x80) {
    tilemap[pos++] = byte;
  } else if (byte < 0xC0) {
    const count = (byte & 0x3F) + 3;
    const tile = rom[readOff++];
    for (let i = 0; i < count && pos < 1024; i++) tilemap[pos++] = tile;
  } else {
    const count = (byte & 0x3F) + 3;
    for (let i = 0; i < count && pos < 1024; i++) tilemap[pos++] = fillTile;
  }
}
console.log(`Decompressed first row: ${Array.from(tilemap.slice(0, 32)).join(', ')}`);
console.log(`Bytes consumed: ${readOff - tmapDataOff}`);
console.log(`Unique metatile IDs used: ${[...new Set(tilemap)].sort((a,b)=>a-b).join(', ')}`);

// === Palettes ===
const PALETTE_TABLE_1 = 0x001110;
const PALETTE_TABLE_2 = 0x001210;
const PALETTE_TABLE_3 = 0x001310;
console.log(`\n=== Map Palettes ===`);
for (let i = 0; i < 3; i++) {
  const idx = props[5 + i];
  const c1 = rom[PALETTE_TABLE_1 + idx];
  const c2 = rom[PALETTE_TABLE_2 + idx];
  const c3 = rom[PALETTE_TABLE_3 + idx];
  console.log(`Palette ${i} (index ${idx}): [0x0F, 0x${c1.toString(16)}, 0x${c2.toString(16)}, 0x${c3.toString(16)}]`);
}

// === Name Table ===
const NAME_TABLE_BASE = 0x003190;
const ntOffset = NAME_TABLE_BASE + tileset * 128;
const ntData = rom.slice(ntOffset, ntOffset + 128);
console.log(`\n=== Name Table (tileset ${tileset}, at 0x${ntOffset.toString(16)}) ===`);
console.log(`First 32 bytes: ${Array.from(ntData.slice(0, 32)).map(b => b.toString(16).padStart(2,'0')).join(' ')}`);
console.log(`Unique palette indices (bits 0-1): ${[...new Set(Array.from(ntData).map(b => b & 0x03))].sort().join(', ')}`);

// === Collision ===
const COLLISION_BASE = 0x003510;
const collOffset = COLLISION_BASE + tileset * 256;
const collData = rom.slice(collOffset, collOffset + 128);
console.log(`\n=== Collision byte1 (tileset ${tileset}) ===`);
console.log(`First 32 bytes: ${Array.from(collData.slice(0, 32)).map(b => b.toString(16).padStart(2,'0')).join(' ')}`);
// Show which metatiles are passable
const passable = [];
const walls = [];
const triggers = [];
for (let i = 0; i < 128; i++) {
  if (collData[i] & 0x80) triggers.push(i);
  else if ((collData[i] & 0x03) === 0x03) walls.push(i);
  else passable.push(i);
}
console.log(`Passable metatiles: ${passable.length}, Walls: ${walls.length}, Triggers: ${triggers.length}`);
