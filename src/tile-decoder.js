// Tile Decoder — decodes NES 2BPP tiles and applies palette colors

// Standard NES system palette (64 colors, RGB)
// Source: commonly accepted NES palette (2C02 PPU)
const NES_SYSTEM_PALETTE = [
  [0x62, 0x62, 0x62], [0x00, 0x2E, 0x98], [0x12, 0x12, 0xAB], [0x35, 0x00, 0x9E],
  [0x4E, 0x00, 0x7A], [0x5B, 0x00, 0x45], [0x5A, 0x04, 0x00], [0x4A, 0x18, 0x00],
  [0x30, 0x2E, 0x00], [0x14, 0x40, 0x00], [0x00, 0x49, 0x00], [0x00, 0x47, 0x12],
  [0x00, 0x3E, 0x4B], [0x00, 0x00, 0x00], [0x00, 0x00, 0x00], [0x00, 0x00, 0x00],

  [0xAB, 0xAB, 0xAB], [0x0F, 0x63, 0xE7], [0x37, 0x40, 0xFF], [0x6C, 0x2E, 0xFF],
  [0x9C, 0x22, 0xD4], [0xAF, 0x22, 0x83], [0xAD, 0x31, 0x2E], [0x96, 0x4B, 0x00],
  [0x71, 0x66, 0x00], [0x45, 0x7C, 0x00], [0x1E, 0x87, 0x00], [0x07, 0x84, 0x2E],
  [0x00, 0x79, 0x76], [0x00, 0x00, 0x00], [0x00, 0x00, 0x00], [0x00, 0x00, 0x00],

  [0xFF, 0xFF, 0xFF], [0x56, 0xB4, 0xFF], [0x7B, 0x97, 0xFF], [0xAF, 0x87, 0xFF],
  [0xE0, 0x7C, 0xFF], [0xF2, 0x7D, 0xD2], [0xF0, 0x8B, 0x82], [0xDA, 0xA3, 0x36],
  [0xBA, 0xBC, 0x14], [0x8E, 0xD1, 0x1A], [0x6A, 0xDA, 0x42], [0x54, 0xD7, 0x82],
  [0x4F, 0xCE, 0xC6], [0x4E, 0x4E, 0x4E], [0x00, 0x00, 0x00], [0x00, 0x00, 0x00],

  [0xFF, 0xFF, 0xFF], [0xBE, 0xDF, 0xFF], [0xCC, 0xD3, 0xFF], [0xE1, 0xCB, 0xFF],
  [0xF3, 0xC7, 0xFF], [0xFB, 0xC7, 0xED], [0xFA, 0xCD, 0xCA], [0xF2, 0xD7, 0xAB],
  [0xE4, 0xE2, 0x9D], [0xD1, 0xEB, 0x9E], [0xC1, 0xEF, 0xAE], [0xB7, 0xEE, 0xC9],
  [0xB5, 0xEA, 0xE7], [0xB0, 0xB0, 0xB0], [0x00, 0x00, 0x00], [0x00, 0x00, 0x00],
];

// Decode a single 8x8 NES 2BPP tile from raw bytes (16 bytes)
// Returns an 8x8 array of 2-bit color indices (0-3)
export function decodeTile(tileData, offset = 0) {
  const pixels = new Uint8Array(64); // 8x8

  for (let row = 0; row < 8; row++) {
    const bp0 = tileData[offset + row];       // bitplane 0
    const bp1 = tileData[offset + row + 8];   // bitplane 1

    for (let col = 0; col < 8; col++) {
      const bit = 7 - col;
      const lo = (bp0 >> bit) & 1;
      const hi = (bp1 >> bit) & 1;
      pixels[row * 8 + col] = (hi << 1) | lo;
    }
  }

  return pixels;
}

// Decode a range of tiles from ROM data
// Returns array of decoded tiles (each is Uint8Array of 64 color indices)
export function decodeTiles(data, offset, count) {
  const tiles = [];
  for (let i = 0; i < count; i++) {
    tiles.push(decodeTile(data, offset + i * 16));
  }
  return tiles;
}

// Read palette data from ROM and build sub-palettes
// Each sub-palette is 4 NES color indices
// paletteData is 16 bytes = 4 sub-palettes (for sprites, bytes 16-31 are the sprite palettes)
export function readPalettes(romData, offset, count = 8) {
  const palettes = [];
  for (let i = 0; i < count; i++) {
    const pal = [];
    for (let j = 0; j < 4; j++) {
      const nesColorIndex = romData[offset + i * 4 + j] & 0x3F;
      pal.push(nesColorIndex);
    }
    palettes.push(pal);
  }
  return palettes;
}


// Draw a decoded tile onto a canvas context at (x, y)
export function drawTile(ctx, tilePixels, subPalette, x, y) {
  const rgba = tileToRGBA(tilePixels, subPalette);
  const imageData = ctx.createImageData(8, 8);
  imageData.data.set(rgba);
  ctx.putImageData(imageData, x, y);
}

// Animated water CHR tile indices (same across all tilesets)
// Horizontal pairs: ($22,$23) and ($24,$25) — NES shifts them as 16-bit pairs
const WATER_HORIZ_PAIRS = [[0x22, 0x23], [0x24, 0x25]];
const WATER_VERT  = [0x26, 0x27];

// Pre-compute animation frames for water CHR tiles.
// Horizontal: 16-bit circular RIGHT shift across paired tiles (bank 3D $B864)
// Vertical: row rotation DOWN (bank 3D $B83F)
// Returns Map<chrIndex, Uint8Array[]> — each entry is an array of frame pixel arrays.
// Only animates tiles that are actually water: all pixels must be color 2 or 3.
export function buildWaterFrames(chrTiles, horizCount, vertCount) {
  const frames = new Map();

  // Horizontal: 16-bit paired circular right shift (matching NES bank 3D $B864)
  for (const [ciL, ciR] of WATER_HORIZ_PAIRS) {
    const baseL = chrTiles[ciL];
    const baseR = chrTiles[ciR];
    if (!baseL || !baseR || !isWaterTile(baseL) || !isWaterTile(baseR)) continue;

    const plane0L = extractPlane0(baseL);
    const plane0R = extractPlane0(baseR);
    const plane1L = baseL.map(p => p & 2);
    const plane1R = baseR.map(p => p & 2);

    const arrL = [];
    const arrR = [];

    // Start with current plane0 state, apply 1-bit right shift each frame
    let curL = new Uint8Array(plane0L);
    let curR = new Uint8Array(plane0R);

    for (let f = 0; f < horizCount; f++) {
      arrL.push(rebuildPixels(curL, plane1L));
      arrR.push(rebuildPixels(curR, plane1R));

      // 16-bit circular right shift: for each row, shift [byteL, byteR] right by 1
      // Matches: LSR byteR → carry; ROR byteL (carry→bit7, bit0→carry); ROR byteR (carry→bit7)
      const nextL = new Uint8Array(8);
      const nextR = new Uint8Array(8);
      for (let row = 0; row < 8; row++) {
        const bL = curL[row];
        const bR = curR[row];
        // LSR bR: bit0 of R → carry
        const carryFromR = bR & 1;
        // ROR bL: carry(R bit0) → bL bit7, bL bit0 → carry
        const carryFromL = bL & 1;
        nextL[row] = ((bL >> 1) | (carryFromR << 7)) & 0xFF;
        // ROR bR: carry(L bit0) → bR bit7
        nextR[row] = ((bR >> 1) | (carryFromL << 7)) & 0xFF;
      }
      curL = nextL;
      curR = nextR;
    }

    frames.set(ciL, arrL);
    frames.set(ciR, arrR);
  }

  // Vertical: row rotation down (matching NES bank 3D $B83F)
  for (const ci of WATER_VERT) {
    const base = chrTiles[ci];
    if (!base || !isWaterTile(base)) continue;
    const plane0 = extractPlane0(base);
    const plane1Pixels = base.map(p => p & 2);
    const arr = [];
    for (let f = 0; f < vertCount; f++) {
      const rotated = new Uint8Array(8);
      for (let row = 0; row < 8; row++) {
        rotated[row] = plane0[((row - f) % 8 + 8) % 8];
      }
      arr.push(rebuildPixels(rotated, plane1Pixels));
    }
    frames.set(ci, arr);
  }

  return frames;
}

function isWaterTile(pixels) {
  // Water tiles only use colors 2 and 3 (bit 1 always set).
  // If any pixel is color 0 or 1, this isn't a water tile.
  for (let i = 0; i < 64; i++) {
    if (!(pixels[i] & 2)) return false;
  }
  return true;
}

function extractPlane0(pixels) {
  // Extract 8 bytes of plane 0 from decoded 8x8 pixel array
  const plane = new Uint8Array(8);
  for (let row = 0; row < 8; row++) {
    let byte = 0;
    for (let col = 0; col < 8; col++) {
      byte |= (pixels[row * 8 + col] & 1) << (7 - col);
    }
    plane[row] = byte;
  }
  return plane;
}


function rebuildPixels(shiftedPlane0, plane1Pixels) {
  // Combine shifted plane 0 with original plane 1 to get new pixel array
  const pixels = new Uint8Array(64);
  for (let row = 0; row < 8; row++) {
    const byte = shiftedPlane0[row];
    for (let col = 0; col < 8; col++) {
      const bit0 = (byte >> (7 - col)) & 1;
      pixels[row * 8 + col] = plane1Pixels[row * 8 + col] | bit0;
    }
  }
  return pixels;
}


export { NES_SYSTEM_PALETTE };
