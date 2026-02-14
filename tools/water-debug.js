// Diagnostic: extract water tile CHR data and show animation frames
import { readFileSync } from 'fs';

const rom = readFileSync('Final Fantasy III (Japan).nes');

// World map common CHR at 0x014C10, tiles 0-127
const COMMON_CHR = 0x014C10;

// Indoor CHR: need GFX subset for a map with water. Use map 114 (Town of Ur)
const GFX_SUBSET_ID_BASE = 0x000C10;
const GFX_SUBSET_BASE = 0x000E10;
const MAP_BG_GFX_BASE = 0x004810;
const GFX_SLOT_COUNTS = [0x1A, 0x08, 0x08, 0x0E, 0x08, 0x10, 0x10, 0x10];

function decodeTilePlane0(data, offset) {
  const plane = new Uint8Array(8);
  for (let row = 0; row < 8; row++) {
    plane[row] = data[offset + row]; // plane 0 = first 8 bytes
  }
  return plane;
}

function decodeTilePlane1(data, offset) {
  const plane = new Uint8Array(8);
  for (let row = 0; row < 8; row++) {
    plane[row] = data[offset + row + 8]; // plane 1 = next 8 bytes
  }
  return plane;
}

function byteToBin(b) {
  return b.toString(2).padStart(8, '0');
}

function renderPlane0AsAscii(plane0, label) {
  console.log(`  ${label}:`);
  for (let row = 0; row < 8; row++) {
    const bits = byteToBin(plane0[row]).replace(/0/g, '.').replace(/1/g, '#');
    console.log(`    ${bits}  (0x${plane0[row].toString(16).padStart(2, '0')})`);
  }
}

// Extract world map water CHR tiles $22-$27
console.log('=== WORLD MAP CHR TILES ===');
for (let ci = 0x22; ci <= 0x27; ci++) {
  const offset = COMMON_CHR + ci * 16;
  const p0 = decodeTilePlane0(rom, offset);
  const p1 = decodeTilePlane1(rom, offset);
  console.log(`\nCHR $${ci.toString(16)} (world map):`);
  renderPlane0AsAscii(p0, 'plane 0');
  console.log(`  plane 1: all FF? ${p1.every(b => b === 0xFF)}`);
}

// Extract indoor water CHR tiles (map 114 = Town of Ur)
const mapId = 114;
const subsetId = rom[GFX_SUBSET_ID_BASE + mapId];
const subsetOffset = GFX_SUBSET_BASE + subsetId * 16;
const pointers = [];
for (let i = 0; i < 8; i++) {
  pointers.push(rom[subsetOffset + i * 2] | (rom[subsetOffset + i * 2 + 1] << 8));
}

// Build indoor CHR tile array
let indoorChrOffset = 0;
const indoorSlotOffsets = [];
for (let slot = 0; slot < 8; slot++) {
  const count = GFX_SLOT_COUNTS[slot];
  const ptr = pointers[slot];
  const gfxOffset = MAP_BG_GFX_BASE + ptr;
  indoorSlotOffsets.push({ start: indoorChrOffset, count, gfxOffset });
  indoorChrOffset += count;
}

console.log('\n=== INDOOR CHR TILES (Map 114 - Ur) ===');
for (let ci = 0x22; ci <= 0x27; ci++) {
  // Find which slot contains this CHR index
  let romOffset = null;
  for (const { start, count, gfxOffset } of indoorSlotOffsets) {
    if (ci >= start && ci < start + count) {
      romOffset = gfxOffset + (ci - start) * 16;
      break;
    }
  }
  if (romOffset === null) {
    console.log(`\nCHR $${ci.toString(16)} (indoor): NOT FOUND in GFX slots`);
    continue;
  }
  const p0 = decodeTilePlane0(rom, romOffset);
  const p1 = decodeTilePlane1(rom, romOffset);
  console.log(`\nCHR $${ci.toString(16)} (indoor):`);
  renderPlane0AsAscii(p0, 'plane 0');
  console.log(`  plane 1: all FF? ${p1.every(b => b === 0xFF)}`);
}

// Now show animation frames for world map tiles
console.log('\n=== ANIMATION FRAMES (World Map) ===');

// Horizontal pair: $22 + $23
const p0_22 = decodeTilePlane0(rom, COMMON_CHR + 0x22 * 16);
const p0_23 = decodeTilePlane0(rom, COMMON_CHR + 0x23 * 16);

console.log('\n--- Horizontal pair $22+$23, 16-bit RIGHT shift ---');
let curL = new Uint8Array(p0_22);
let curR = new Uint8Array(p0_23);
for (let f = 0; f < 4; f++) {
  console.log(`\n  Frame ${f}:`);
  for (let row = 0; row < 8; row++) {
    const bitsL = byteToBin(curL[row]).replace(/0/g, '.').replace(/1/g, '#');
    const bitsR = byteToBin(curR[row]).replace(/0/g, '.').replace(/1/g, '#');
    console.log(`    ${bitsL}|${bitsR}`);
  }
  // Apply 16-bit right shift
  const nextL = new Uint8Array(8);
  const nextR = new Uint8Array(8);
  for (let row = 0; row < 8; row++) {
    const bL = curL[row], bR = curR[row];
    const carryFromR = bR & 1;
    const carryFromL = bL & 1;
    nextL[row] = ((bL >> 1) | (carryFromR << 7)) & 0xFF;
    nextR[row] = ((bR >> 1) | (carryFromL << 7)) & 0xFF;
  }
  curL = nextL;
  curR = nextR;
}

console.log('\n--- Horizontal $22 only, 8-bit LEFT shift ---');
let curSingle = new Uint8Array(p0_22);
for (let f = 0; f < 4; f++) {
  console.log(`\n  Frame ${f}:`);
  for (let row = 0; row < 8; row++) {
    const bits = byteToBin(curSingle[row]).replace(/0/g, '.').replace(/1/g, '#');
    console.log(`    ${bits}`);
  }
  // Apply 8-bit left shift
  const next = new Uint8Array(8);
  for (let row = 0; row < 8; row++) {
    const b = curSingle[row];
    next[row] = ((b << 1) | (b >> 7)) & 0xFF;
  }
  curSingle = next;
}

console.log('\n--- Horizontal $22 only, 8-bit RIGHT shift ---');
curSingle = new Uint8Array(p0_22);
for (let f = 0; f < 4; f++) {
  console.log(`\n  Frame ${f}:`);
  for (let row = 0; row < 8; row++) {
    const bits = byteToBin(curSingle[row]).replace(/0/g, '.').replace(/1/g, '#');
    console.log(`    ${bits}`);
  }
  // Apply 8-bit right shift
  const next = new Uint8Array(8);
  for (let row = 0; row < 8; row++) {
    const b = curSingle[row];
    next[row] = ((b >> 1) | (b << 7)) & 0xFF;
  }
  curSingle = next;
}

// Vertical: $26, row rotation down
const p0_26 = decodeTilePlane0(rom, COMMON_CHR + 0x26 * 16);
console.log('\n--- Vertical $26, row rotation DOWN ---');
for (let f = 0; f < 4; f++) {
  console.log(`\n  Frame ${f}:`);
  for (let row = 0; row < 8; row++) {
    const srcRow = ((row - f) % 8 + 8) % 8;
    const bits = byteToBin(p0_26[srcRow]).replace(/0/g, '.').replace(/1/g, '#');
    console.log(`    ${bits}`);
  }
}

// Check world map metatile layouts
console.log('\n=== WORLD MAP METATILE LAYOUTS ===');
const COMMON_TILESET = 0x000010;
const PERWORLD_TILESET = 0x000110;
const worldId = 0;

// Load metatiles (same as world-map-loader.js)
for (let m of [13, 14, 15, 29, 30, 31, 45, 46, 47, 60]) {
  let tl, tr, bl, br;
  if (m < 64) {
    // Common tileset
    tl = rom[COMMON_TILESET + m];
    tr = rom[COMMON_TILESET + m + 64];
    bl = rom[COMMON_TILESET + m + 128];
    br = rom[COMMON_TILESET + m + 192];
  } else {
    // Per-world tileset
    const base = PERWORLD_TILESET + worldId * 256;
    const i = m - 64;
    tl = rom[base + i];
    tr = rom[base + i + 64];
    bl = rom[base + i + 128];
    br = rom[base + i + 192];
  }
  console.log(`Metatile ${m}: TL=$${tl.toString(16)} TR=$${tr.toString(16)} BL=$${bl.toString(16)} BR=$${br.toString(16)}`);
}
