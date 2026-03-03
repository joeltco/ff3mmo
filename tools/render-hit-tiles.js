#!/usr/bin/env node
// Render battle hit effect tiles from ROM as PPM images for visual inspection
import { readFileSync, writeFileSync } from 'fs';

const rom = readFileSync('Final Fantasy III (Japan).nes');

// Decode one 8x8 2BPP tile → array of 64 palette indices (0-3)
function decodeTile(data, offset) {
  const px = [];
  for (let y = 0; y < 8; y++) {
    const lo = data[offset + y];
    const hi = data[offset + y + 8];
    for (let x = 7; x >= 0; x--) {
      px.push(((lo >> x) & 1) | (((hi >> x) & 1) << 1));
    }
  }
  return px;
}

// Flip tile horizontally
function hflip(px) {
  const out = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 7; x >= 0; x--) out.push(px[y * 8 + x]);
  }
  return out;
}

// Flip tile vertically
function vflip(px) {
  const out = [];
  for (let y = 7; y >= 0; y--) {
    for (let x = 0; x < 8; x++) out.push(px[y * 8 + x]);
  }
  return out;
}

// Grayscale palette for raw tile viewing
const GRAY = [[0,0,0], [85,85,85], [170,170,170], [255,255,255]];
// White-on-black (hit effect style)
const WHITE_PAL = [[0,0,0], [170,170,170], [220,220,220], [252,252,252]];

// Write a grid of 8x8 tiles as PPM (scaled up)
function writePPM(filename, tiles, cols, palette, scale) {
  scale = scale || 4;
  palette = palette || GRAY;
  const rows = Math.ceil(tiles.length / cols);
  const w = cols * 8 * scale;
  const h = rows * 8 * scale;
  const buf = Buffer.alloc(w * h * 3);

  for (let ti = 0; ti < tiles.length; ti++) {
    const tx = (ti % cols) * 8;
    const ty = Math.floor(ti / cols) * 8;
    const px = tiles[ti];
    for (let py = 0; py < 8; py++) {
      for (let px2 = 0; px2 < 8; px2++) {
        const val = px[py * 8 + px2];
        const rgb = palette[val];
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const ox = (tx + px2) * scale + sx;
            const oy = (ty + py) * scale + sy;
            const idx = (oy * w + ox) * 3;
            buf[idx] = rgb[0]; buf[idx+1] = rgb[1]; buf[idx+2] = rgb[2];
          }
        }
      }
    }
  }

  const header = `P6\n${w} ${h}\n255\n`;
  writeFileSync(filename, Buffer.concat([Buffer.from(header), buf]));
  console.log(`Wrote ${filename} (${w}x${h})`);
}

// Compose a 16x16 sprite from 4 tiles in 2x2 arrangement with flip flags
function compose2x2(tiles, flags) {
  // flags: array of 4 values, each is {hflip, vflip}
  const out = new Array(16 * 16).fill(0);
  const positions = [[0,0],[8,0],[0,8],[8,8]]; // TL, TR, BL, BR
  for (let i = 0; i < 4; i++) {
    let px = tiles[i];
    if (flags[i].h) px = hflip(px);
    if (flags[i].v) px = vflip(px);
    const [ox, oy] = positions[i];
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        out[(oy + y) * 16 + (ox + x)] = px[y * 8 + x];
      }
    }
  }
  return out;
}

// Write a 16x16 composed sprite as PPM
function writeSpritePPM(filename, pixels16, palette, scale) {
  scale = scale || 8;
  palette = palette || WHITE_PAL;
  const w = 16 * scale, h = 16 * scale;
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const val = pixels16[y * 16 + x];
      const rgb = palette[val];
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const idx = ((y * scale + sy) * w + (x * scale + sx)) * 3;
          buf[idx] = rgb[0]; buf[idx+1] = rgb[1]; buf[idx+2] = rgb[2];
        }
      }
    }
  }
  writeFileSync(filename, Buffer.concat([Buffer.from(`P6\n${w} ${h}\n255\n`), buf]));
  console.log(`Wrote ${filename} (${w}x${h})`);
}

// === Dump all candidate effect tile sets ===

// Entry $00: bank $06 src $AFA0 → ROM offset
const sets = [
  { name: 'effect0', bank: 0x06, addr: 0xAFA0 },
  { name: 'effect1', bank: 0x06, addr: 0xAFE0 },
  { name: 'effect2', bank: 0x06, addr: 0xB020 },
  { name: 'effect3', bank: 0x06, addr: 0xB120 },
  { name: 'weapon',  bank: 0x15, addr: 0xB460 },
  { name: 'pre-weapon', bank: 0x15, addr: 0xB420 },
];

for (const s of sets) {
  const romOff = s.bank * 0x2000 + 0x10 + (s.addr >= 0xA000 ? s.addr - 0xA000 : s.addr - 0x8000);
  const tiles = [];
  for (let t = 0; t < 16; t++) {
    tiles.push(decodeTile(rom, romOff + t * 16));
  }
  writePPM(`tools/tiles-${s.name}.ppm`, tiles, 8, WHITE_PAL, 6);
}

// === Compose the claw/punch 2x2 sprites ===
// Claw frame $12: arrangement $09
//   TL: normal, TR: h-flip, BL: v-flip, BR: hv-flip
//   Tile indices from $968A+$24: $4A, $4B, $4C, $4D
// These are PPU tile positions: $49=first loaded tile, so offset from base
// In effect set 0: tile $4A = index 1, $4B = index 2, $4C = index 3, $4D = index 4

// Compose using effect0 set (which loads to PPU $1490 = tile $49)
for (let setIdx = 0; setIdx < 4; setIdx++) {
  const s = sets[setIdx];
  const romOff = s.bank * 0x2000 + 0x10 + (s.addr >= 0xA000 ? s.addr - 0xA000 : s.addr - 0x8000);

  // Claw uses tiles at PPU positions $4A,$4B,$4C,$4D
  // PPU $49 = first tile in this set, so:
  // $4A = index 1, $4B = index 2, $4C = index 3, $4D = index 4
  const t4A = decodeTile(rom, romOff + 1 * 16);
  const t4B = decodeTile(rom, romOff + 2 * 16);
  const t4C = decodeTile(rom, romOff + 3 * 16);
  const t4D = decodeTile(rom, romOff + 4 * 16);

  // Frame $12 arrangement $09: TL=normal, TR=h-flip, BL=v-flip, BR=hv-flip
  const claw12 = compose2x2(
    [t4A, t4B, t4C, t4D],
    [{h:false,v:false}, {h:true,v:false}, {h:false,v:true}, {h:true,v:true}]
  );
  writeSpritePPM(`tools/claw-f12-set${setIdx}.ppm`, claw12, WHITE_PAL, 8);

  // Frame $13 arrangement $0A: swapped left/right
  // Tiles from $968A+$28: $52, $53, $54, $55 = indices 9, 10, 11, 12
  const t52 = decodeTile(rom, romOff + 9 * 16);
  const t53 = decodeTile(rom, romOff + 10 * 16);
  const t54 = decodeTile(rom, romOff + 11 * 16);
  const t55 = decodeTile(rom, romOff + 12 * 16);

  const claw13 = compose2x2(
    [t52, t53, t54, t55],
    [{h:true,v:false}, {h:false,v:false}, {h:true,v:true}, {h:false,v:true}]
  );
  writeSpritePPM(`tools/claw-f13-set${setIdx}.ppm`, claw13, WHITE_PAL, 8);
}

// === Also compose the SLICE hit effect (for comparison) ===
// Slice uses tiles $4D-$50 from weapon set (entry $09)
// ROM = 0x2B470
const wRom = 0x2B470;
const sliceTiles = [];
for (let t = 0; t < 4; t++) {
  sliceTiles.push(decodeTile(rom, wRom + t * 16));
}
// Slice has 12 sprites in a sweeping pattern, but let's just show the 4 tiles
writePPM(`tools/tiles-slice-4d-50.ppm`, sliceTiles, 4, WHITE_PAL, 8);

console.log('\nDone! Check tools/*.ppm for rendered tiles.');
console.log('Key files:');
console.log('  claw-f12-set0..3.ppm — Claw/punch frame 1 (4 animation frames)');
console.log('  claw-f13-set0..3.ppm — Claw/punch frame 2 (4 animation frames)');
console.log('  tiles-effect0..3.ppm — Full 16-tile effect sets');
console.log('  tiles-weapon.ppm     — Weapon-specific tiles (slice at $4D+)');
console.log('  tiles-slice-4d-50.ppm — Just the 4 slice tiles');
