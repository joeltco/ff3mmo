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

// Convert a sub-palette (4 NES color indices) to RGBA colors
export function paletteToRGBA(subPalette) {
  return subPalette.map((nesIndex) => {
    const rgb = NES_SYSTEM_PALETTE[nesIndex] || [0, 0, 0];
    return [...rgb, 255];
  });
}

// Render a decoded tile to RGBA pixel data (64 pixels * 4 channels = 256 bytes)
// colorIndex 0 = transparent
export function tileToRGBA(tilePixels, subPalette) {
  const rgbaPalette = paletteToRGBA(subPalette);
  const rgba = new Uint8Array(64 * 4);

  for (let i = 0; i < 64; i++) {
    const colorIdx = tilePixels[i];
    if (colorIdx === 0) {
      // Transparent
      rgba[i * 4 + 0] = 0;
      rgba[i * 4 + 1] = 0;
      rgba[i * 4 + 2] = 0;
      rgba[i * 4 + 3] = 0;
    } else {
      const [r, g, b, a] = rgbaPalette[colorIdx];
      rgba[i * 4 + 0] = r;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = b;
      rgba[i * 4 + 3] = a;
    }
  }

  return rgba;
}

// Draw a decoded tile onto a canvas context at (x, y)
export function drawTile(ctx, tilePixels, subPalette, x, y) {
  const rgba = tileToRGBA(tilePixels, subPalette);
  const imageData = ctx.createImageData(8, 8);
  imageData.data.set(rgba);
  ctx.putImageData(imageData, x, y);
}

export { NES_SYSTEM_PALETTE };
