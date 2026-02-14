#!/usr/bin/env node
// find-stars.js — Scan FF3 ROM for 4-pointed star/sparkle sprites
// Decodes every 8x8 2BPP tile and checks for star-like patterns

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROM_PATH = path.join(__dirname, '..', 'Final Fantasy III (Japan).nes');
const rom = fs.readFileSync(ROM_PATH);

// Skip 16-byte iNES header
const HEADER_SIZE = 16;
const prgData = rom.slice(HEADER_SIZE);

// Each 2BPP tile is 16 bytes -> 8x8 pixels, colors 0-3
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

function analyzeTile(pixels) {
  let totalNonZero = 0;
  const colorCounts = [0, 0, 0, 0];
  const nonZeroColors = new Set();

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const v = pixels[r][c];
      colorCounts[v]++;
      if (v !== 0) {
        totalNonZero++;
        nonZeroColors.add(v);
      }
    }
  }

  return { totalNonZero, colorCounts, nonZeroColors };
}

// Check horizontal symmetry (left-right mirror)
function hSymmetry(pixels) {
  let match = 0, total = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 4; c++) {
      total++;
      if (pixels[r][c] === pixels[r][7 - c]) match++;
    }
  }
  return match / total;
}

// Check vertical symmetry (top-bottom mirror)
function vSymmetry(pixels) {
  let match = 0, total = 0;
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 8; c++) {
      total++;
      if (pixels[r][c] === pixels[7 - r][c]) match++;
    }
  }
  return match / total;
}

// Check diagonal symmetry (transpose)
function dSymmetry(pixels) {
  let match = 0, total = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (r !== c) {
        total++;
        if (pixels[r][c] === pixels[c][r]) match++;
      }
    }
  }
  return match / total;
}

// Check if tile looks like a 4-pointed star
function isStarCandidate(pixels) {
  const { totalNonZero, colorCounts, nonZeroColors } = analyzeTile(pixels);

  // Filter: need 10-32 non-zero pixels (star shape, not too sparse/dense)
  if (totalNonZero < 10 || totalNonZero > 32) return null;

  // Need at least 2 different non-zero colors (white + tan/detail)
  if (nonZeroColors.size < 2) return null;

  // Center area (rows 3-4, cols 3-4) should have non-zero pixels
  let centerFilled = 0;
  for (let r = 3; r <= 4; r++) {
    for (let c = 3; c <= 4; c++) {
      if (pixels[r][c] !== 0) centerFilled++;
    }
  }
  if (centerFilled < 2) return null;

  // Should have some symmetry (at least one axis)
  const hs = hSymmetry(pixels);
  const vs = vSymmetry(pixels);
  const ds = dSymmetry(pixels);

  // Need decent symmetry on at least one axis
  if (hs < 0.6 && vs < 0.6 && ds < 0.6) return null;

  // Check for arm extension: non-zero pixels should reach toward edges
  // Check 4 cardinal directions from center
  let arms = 0;

  // Up arm: any non-zero in rows 0-2, cols 3-4
  let upArm = false;
  for (let r = 0; r <= 2; r++) {
    for (let c = 2; c <= 5; c++) {
      if (pixels[r][c] !== 0) upArm = true;
    }
  }
  if (upArm) arms++;

  // Down arm
  let downArm = false;
  for (let r = 5; r <= 7; r++) {
    for (let c = 2; c <= 5; c++) {
      if (pixels[r][c] !== 0) downArm = true;
    }
  }
  if (downArm) arms++;

  // Left arm
  let leftArm = false;
  for (let r = 2; r <= 5; r++) {
    for (let c = 0; c <= 2; c++) {
      if (pixels[r][c] !== 0) leftArm = true;
    }
  }
  if (leftArm) arms++;

  // Right arm
  let rightArm = false;
  for (let r = 2; r <= 5; r++) {
    for (let c = 5; c <= 7; c++) {
      if (pixels[r][c] !== 0) rightArm = true;
    }
  }
  if (rightArm) arms++;

  // Need all 4 arms for a 4-pointed star
  if (arms < 4) return null;

  // Corner density check: corners should be mostly empty for a star shape
  let cornerPixels = 0;
  // top-left 2x2
  for (let r = 0; r <= 1; r++)
    for (let c = 0; c <= 1; c++)
      if (pixels[r][c] !== 0) cornerPixels++;
  // top-right 2x2
  for (let r = 0; r <= 1; r++)
    for (let c = 6; c <= 7; c++)
      if (pixels[r][c] !== 0) cornerPixels++;
  // bottom-left 2x2
  for (let r = 6; r <= 7; r++)
    for (let c = 0; c <= 1; c++)
      if (pixels[r][c] !== 0) cornerPixels++;
  // bottom-right 2x2
  for (let r = 6; r <= 7; r++)
    for (let c = 6; c <= 7; c++)
      if (pixels[r][c] !== 0) cornerPixels++;

  // For a cross/plus star: corners should be mostly empty
  // For an X star: corners have pixels, center column/row more empty
  // Accept both patterns
  const crossLike = cornerPixels <= 6;  // cross pattern: empty corners

  // For X-shape: check diagonals
  let diagPixels = 0;
  for (let i = 0; i < 8; i++) {
    if (pixels[i][i] !== 0) diagPixels++;
    if (pixels[i][7 - i] !== 0) diagPixels++;
  }
  const xLike = diagPixels >= 8;  // X pattern: filled diagonals

  if (!crossLike && !xLike) return null;

  const shape = crossLike ? (xLike ? 'CROSS+X' : 'CROSS') : 'X';

  return {
    totalNonZero,
    colorCounts,
    nonZeroColors: [...nonZeroColors],
    hSym: hs.toFixed(2),
    vSym: vs.toFixed(2),
    dSym: ds.toFixed(2),
    arms,
    cornerPixels,
    diagPixels,
    shape,
    score: (hs + vs + ds) * (nonZeroColors.size >= 2 ? 1.5 : 1) * (crossLike || xLike ? 1.2 : 0.8)
  };
}

function renderTile(pixels) {
  const chars = ['.', '1', '2', '3'];
  const lines = [];
  for (let r = 0; r < 8; r++) {
    lines.push('    ' + pixels[r].map(v => chars[v]).join(' '));
  }
  return lines.join('\n');
}

// Scan the entire ROM
const totalTiles = Math.floor(prgData.length / 16);
const candidates = [];

for (let i = 0; i < totalTiles; i++) {
  const offset = i * 16;
  const romOffset = offset + HEADER_SIZE;
  const pixels = decodeTile(prgData, offset);
  const result = isStarCandidate(pixels);

  if (result) {
    candidates.push({
      index: i,
      dataOffset: offset,
      romOffset,
      pixels,
      ...result
    });
  }
}

console.log(`=== FF3 ROM Star/Sparkle Sprite Scanner ===`);
console.log(`Total tiles scanned: ${totalTiles}`);
console.log(`Candidates found: ${candidates.length}`);
console.log();

// Sort by score descending
candidates.sort((a, b) => b.score - a.score);

// Look for pairs (adjacent tiles that are both candidates)
const pairSet = new Set();
for (let i = 0; i < candidates.length; i++) {
  for (let j = i + 1; j < candidates.length; j++) {
    if (Math.abs(candidates[i].index - candidates[j].index) === 1) {
      pairSet.add(i);
      pairSet.add(j);
    }
  }
}

// Print pairs first
console.log('========================================');
console.log('  PAIRED CANDIDATES (adjacent tiles)');
console.log('========================================');
console.log();

const printed = new Set();
for (let i = 0; i < candidates.length; i++) {
  if (!pairSet.has(i) || printed.has(i)) continue;

  // Find its partner
  for (let j = 0; j < candidates.length; j++) {
    if (i === j || printed.has(j)) continue;
    if (Math.abs(candidates[i].index - candidates[j].index) === 1) {
      const a = candidates[i].index < candidates[j].index ? candidates[i] : candidates[j];
      const b = candidates[i].index < candidates[j].index ? candidates[j] : candidates[i];

      const bankA = Math.floor(a.dataOffset / 0x2000);
      const bankB = Math.floor(b.dataOffset / 0x2000);

      console.log(`--- PAIR at ROM 0x${a.romOffset.toString(16).toUpperCase()} / 0x${b.romOffset.toString(16).toUpperCase()} (Bank $${bankA.toString(16).toUpperCase()} / $${bankB.toString(16).toUpperCase()}) ---`);

      // Check if one is cross-like and one is X-like
      const pairType = (a.shape !== b.shape) ? ' *** CROSS+X PAIR ***' : ` (both ${a.shape})`;
      console.log(`  Pair type:${pairType}`);

      console.log(`  Tile A (index ${a.index}, offset 0x${a.romOffset.toString(16).toUpperCase()}):`);
      console.log(`    Shape: ${a.shape} | Pixels: ${a.totalNonZero} | Colors: ${a.nonZeroColors.join(',')} | Sym H=${a.hSym} V=${a.vSym} D=${a.dSym} | Score: ${a.score.toFixed(2)}`);
      console.log(renderTile(a.pixels));
      console.log();

      console.log(`  Tile B (index ${b.index}, offset 0x${b.romOffset.toString(16).toUpperCase()}):`);
      console.log(`    Shape: ${b.shape} | Pixels: ${b.totalNonZero} | Colors: ${b.nonZeroColors.join(',')} | Sym H=${b.hSym} V=${b.vSym} D=${b.dSym} | Score: ${b.score.toFixed(2)}`);
      console.log(renderTile(b.pixels));
      console.log();

      printed.add(i);
      printed.add(j);
      break;
    }
  }
}

// Print remaining singles grouped by region
console.log('========================================');
console.log('  SINGLE CANDIDATES (no adjacent pair)');
console.log('========================================');
console.log();

// Define priority regions
function getRegion(offset) {
  if (offset >= 0x38000 && offset < 0x40000) return 'BATTLE CHR ($0E-$0F)';
  if (offset >= 0x54000 && offset < 0x60000) return 'BATTLE CHR ($14-$17)';
  if (offset >= 0x40000 && offset < 0x54000) return 'CHR ($10-$13)';
  if (offset >= 0x60000 && offset < 0x80000) return 'CHR ($18-$1F)';
  if (offset >= 0x00000 && offset < 0x38000) return 'PRG/EARLY ($00-$0D)';
  return 'OTHER';
}

for (let i = 0; i < candidates.length; i++) {
  if (printed.has(i)) continue;
  const c = candidates[i];
  const bank = Math.floor(c.dataOffset / 0x2000);
  const region = getRegion(c.romOffset);

  console.log(`  Tile ${c.index} at ROM 0x${c.romOffset.toString(16).toUpperCase()} (Bank $${bank.toString(16).toUpperCase()}, ${region})`);
  console.log(`    Shape: ${c.shape} | Pixels: ${c.totalNonZero} | Colors: ${c.nonZeroColors.join(',')} | Sym H=${c.hSym} V=${c.vSym} D=${c.dSym} | Score: ${c.score.toFixed(2)}`);
  console.log(renderTile(c.pixels));
  console.log();
}

// Summary by region
console.log('========================================');
console.log('  SUMMARY BY REGION');
console.log('========================================');
const regionCounts = {};
for (const c of candidates) {
  const region = getRegion(c.romOffset);
  regionCounts[region] = (regionCounts[region] || 0) + 1;
}
for (const [region, count] of Object.entries(regionCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${region}: ${count} candidates`);
}
