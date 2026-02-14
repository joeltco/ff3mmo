#!/usr/bin/env node
// find-stars-refined.js — Focus on the best star/sparkle candidates
// Specifically targets the diamond-shaped sparkle animation pairs

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROM_PATH = path.join(__dirname, '..', 'Final Fantasy III (Japan).nes');
const rom = fs.readFileSync(ROM_PATH);
const HEADER_SIZE = 16;
const prgData = rom.slice(HEADER_SIZE);

function decodeTile(data, offset) {
  const pixels = [];
  for (let row = 0; row < 8; row++) {
    const plane0 = data[offset + row];
    const plane1 = data[offset + row + 8];
    const rowPixels = [];
    for (let col = 7; col >= 0; col--) {
      const bit0 = (plane0 >> col) & 1;
      const bit1 = (plane1 >> col) & 1;
      rowPixels.push(bit0 | (bit1 << 1));
    }
    pixels.push(rowPixels);
  }
  return pixels;
}

function renderTile(pixels, indent = '    ') {
  const chars = ['.', '1', '2', '3'];
  return pixels.map(row => indent + row.map(v => chars[v]).join(' ')).join('\n');
}

// The top candidates from the initial scan - let's examine them in detail
// and also look at neighboring tiles to find the full animation sequence
const interestingOffsets = [
  // Pair 1: Perfect diamond sparkle at 0x56C00 (CROSS+X pair, score 5.29/5.40)
  { start: 0x56C00 - HEADER_SIZE, label: 'Diamond sparkle pair #1 (0x56C00)' },
  // Pair 2: Diamond sparkle at 0x56620 (CROSS+X pair, score 5.29/5.06)
  { start: 0x56620 - HEADER_SIZE, label: 'Diamond sparkle pair #2 (0x56620)' },
  // Pair 3: Cross/X alternation at 0x560E0 (classic plus + X star)
  { start: 0x560E0 - HEADER_SIZE, label: 'Plus/X star pair (0x560E0)' },
  // Pair at 0x55800 (CROSS+X, slightly different)
  { start: 0x55800 - HEADER_SIZE, label: 'Star variant (0x55800)' },
];

console.log('=== FF3 Star/Sparkle Sprite — Refined Analysis ===\n');

for (const { start, label } of interestingOffsets) {
  console.log(`\n========== ${label} ==========`);

  // Show the tile and several neighbors (context: 4 tiles before, the pair, 4 tiles after)
  const contextBefore = 4;
  const contextAfter = 6;

  for (let i = -contextBefore; i < contextAfter; i++) {
    const offset = start + (i * 16);
    if (offset < 0 || offset + 16 > prgData.length) continue;

    const romOffset = offset + HEADER_SIZE;
    const pixels = decodeTile(prgData, offset);

    // Count non-zero pixels
    let nonZero = 0;
    const colors = new Set();
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        if (pixels[r][c] !== 0) {
          nonZero++;
          colors.add(pixels[r][c]);
        }
      }
    }

    const marker = (i === 0 || i === 1) ? ' <<<' : '';
    const isPair = (i === 0 || i === 1) ? ' ** TARGET **' : '';
    console.log(`\n  Tile at ROM 0x${romOffset.toString(16).toUpperCase()} (offset ${i >= 0 ? '+' : ''}${i})${isPair}${marker}`);
    console.log(`    Non-zero: ${nonZero}/64 | Colors used: [${[...colors].join(',')}]`);
    console.log(renderTile(pixels));
  }
}

// Now let's specifically search for the exact pattern: small diamond that grows/shrinks
// A "sparkle" in FF3 would be:
// Frame 1 (small): ~4x4 diamond centered, ~12 pixels
// Frame 2 (large): ~6x6 diamond centered, ~20-24 pixels
// Both with color 1 (outline), 2 (mid), 3 (center bright)

console.log('\n\n========== STRICT DIAMOND SPARKLE SEARCH ==========');
console.log('Looking for concentric diamond patterns with 3 color layers...\n');

function isDiamondSparkle(pixels) {
  // Check for concentric diamond: center bright, middle ring, outer ring
  // Centered at (3.5, 3.5) for 8x8 tile

  let nonZero = 0;
  const colors = new Set();
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (pixels[r][c] !== 0) {
        nonZero++;
        colors.add(pixels[r][c]);
      }
    }
  }

  // Need 2+ non-zero colors, reasonable density
  if (colors.size < 2 || nonZero < 8 || nonZero > 32) return false;

  // Center 2x2 must have non-zero pixels
  let centerFilled = 0;
  for (let r = 3; r <= 4; r++)
    for (let c = 3; c <= 4; c++)
      if (pixels[r][c] !== 0) centerFilled++;
  if (centerFilled < 3) return false;

  // Check diamond shape: pixels should be concentrated along the diamond pattern
  // Manhattan distance from center (3.5, 3.5)
  const distBuckets = [0, 0, 0, 0, 0, 0, 0, 0];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (pixels[r][c] !== 0) {
        const dist = Math.abs(r - 3.5) + Math.abs(c - 3.5);
        distBuckets[Math.floor(dist)]++;
      }
    }
  }

  // For a diamond: most pixels at distances 1-3 from center
  const nearCenter = distBuckets[0] + distBuckets[1] + distBuckets[2] + distBuckets[3];
  if (nearCenter < nonZero * 0.8) return false;

  // Check 4-fold symmetry (at least approximate)
  let symMatch = 0, symTotal = 0;
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const v = pixels[r][c] !== 0 ? 1 : 0;
      symTotal += 3;
      if ((pixels[r][7-c] !== 0 ? 1 : 0) === v) symMatch++;
      if ((pixels[7-r][c] !== 0 ? 1 : 0) === v) symMatch++;
      if ((pixels[7-r][7-c] !== 0 ? 1 : 0) === v) symMatch++;
    }
  }
  const sym = symMatch / symTotal;
  if (sym < 0.75) return false;

  return { nonZero, colors: [...colors], sym: sym.toFixed(2) };
}

const diamonds = [];
const totalTiles = Math.floor(prgData.length / 16);

for (let i = 0; i < totalTiles; i++) {
  const offset = i * 16;
  const pixels = decodeTile(prgData, offset);
  const result = isDiamondSparkle(pixels);
  if (result) {
    diamonds.push({ index: i, offset, romOffset: offset + HEADER_SIZE, pixels, ...result });
  }
}

console.log(`Found ${diamonds.length} diamond-shaped tiles\n`);

// Find pairs
for (let i = 0; i < diamonds.length; i++) {
  for (let j = i + 1; j < diamonds.length; j++) {
    if (diamonds[j].index - diamonds[i].index === 1) {
      const a = diamonds[i], b = diamonds[j];
      // One should be smaller than the other (animation frames)
      const sizeDiff = Math.abs(a.nonZero - b.nonZero);

      console.log(`--- Diamond Pair at ROM 0x${a.romOffset.toString(16).toUpperCase()} / 0x${b.romOffset.toString(16).toUpperCase()} ---`);
      console.log(`  Bank: $${Math.floor(a.offset / 0x2000).toString(16).toUpperCase()}`);
      console.log(`  Size: ${a.nonZero} -> ${b.nonZero} pixels (diff: ${sizeDiff})`);
      console.log(`  Colors A: [${a.colors.join(',')}] | Colors B: [${b.colors.join(',')}]`);
      console.log(`  Symmetry: ${a.sym} / ${b.sym}`);
      if (sizeDiff >= 4) console.log('  *** SIZE DIFFERENCE = ANIMATION FRAMES ***');

      console.log(`\n  Frame 1 (ROM 0x${a.romOffset.toString(16).toUpperCase()}):`);
      console.log(renderTile(a.pixels));
      console.log(`\n  Frame 2 (ROM 0x${b.romOffset.toString(16).toUpperCase()}):`);
      console.log(renderTile(b.pixels));
      console.log();
    }
  }
}

// Also show raw hex for the top candidates so they can be loaded
console.log('\n========== RAW HEX for top candidates ==========\n');
const topPairs = [
  [0x56C00 - HEADER_SIZE, 0x56C10 - HEADER_SIZE],
  [0x56620 - HEADER_SIZE, 0x56630 - HEADER_SIZE],
  [0x560E0 - HEADER_SIZE, 0x560F0 - HEADER_SIZE],
];

for (const [offA, offB] of topPairs) {
  const romA = offA + HEADER_SIZE;
  const romB = offB + HEADER_SIZE;
  console.log(`Pair 0x${romA.toString(16).toUpperCase()} / 0x${romB.toString(16).toUpperCase()}:`);
  const hexA = Array.from(prgData.slice(offA, offA + 16)).map(b => b.toString(16).padStart(2, '0')).join(' ');
  const hexB = Array.from(prgData.slice(offB, offB + 16)).map(b => b.toString(16).padStart(2, '0')).join(' ');
  console.log(`  Tile A: ${hexA}`);
  console.log(`  Tile B: ${hexB}`);
  console.log();
}
