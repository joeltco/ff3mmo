// World Map Loader — reads FF3 world map data from ROM

import { decodeTile } from './tile-decoder.js';

// ROM offsets (file offsets, including 16-byte iNES header)
const COMMON_TILESET   = 0x000010;  // 256B: 4 planes × 64 metatiles
const PERWORLD_TILESET = 0x000110;  // 256B per world (world 0 at +0)
const COMMON_ATTRS     = 0x000410;  // 64B: palette index per metatile
const PERWORLD_ATTRS   = 0x000450;  // 64B per world
const TILE_PROPS       = 0x000510;  // 256B: 128 × 2 bytes interleaved
const ENTRANCE_TABLE   = 0x000810;  // 64B: destination map IDs (world 0)
const EXIT_X_TABLE     = 0x000890;  // 64B: world X positions
const EXIT_Y_TABLE     = 0x0008D0;  // 64B: world Y positions
const COMMON_CHR       = 0x014C10;  // 2048B: 128 tiles × 16 bytes
const PERWORLD_CHR     = 0x015410;  // 2048B: 128 tiles
const BG_PALETTE       = 0x001650;  // 16B: 4 sub-palettes

const MAP_SIZE = 128;

export function loadWorldMap(romData, worldId) {
  const metatiles = loadWorldTileset(romData, worldId);
  const chrTiles = loadWorldCHR(romData, worldId);
  const palettes = loadWorldPalettes(romData);
  const tileAttrs = loadWorldAttrs(romData, worldId);
  const tileProps = loadWorldTileProps(romData);
  const tilemap = decompressWorldTilemap(romData);
  const entranceTable = new Uint8Array(romData.slice(ENTRANCE_TABLE, ENTRANCE_TABLE + 64));

  // Build reverse lookup: trigId → first matching tile position on the map.
  // Used to place the player near a town when exiting for the first time.
  const triggerPositions = new Map();
  for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      const mid = tilemap[y * MAP_SIZE + x];
      const m = mid & 0x7F;
      const props = tileProps[m];
      if (!(props.byte1 & 0x80)) continue; // not a trigger
      const trigId = props.byte2 & 0x3F;
      if (!triggerPositions.has(trigId)) {
        triggerPositions.set(trigId, { x, y });
      }
    }
  }

  return {
    worldId,
    mapWidth: MAP_SIZE,
    mapHeight: MAP_SIZE,
    metatiles,
    chrTiles,
    palettes,
    tileAttrs,
    tileProps,
    tilemap,
    entranceTable,
    triggerPositions,
  };
}

function loadWorldTileset(romData, worldId) {
  const common = romData.slice(COMMON_TILESET, COMMON_TILESET + 256);
  const perWorld = romData.slice(PERWORLD_TILESET + worldId * 256, PERWORLD_TILESET + worldId * 256 + 256);

  const metatiles = [];
  for (let m = 0; m < 128; m++) {
    if (m < 64) {
      // Common metatiles 0-63
      metatiles.push({
        tl: common[m],
        tr: common[m + 64],
        bl: common[m + 128],
        br: common[m + 192],
      });
    } else {
      // Per-world metatiles 64-127
      const i = m - 64;
      metatiles.push({
        tl: perWorld[i],
        tr: perWorld[i + 64],
        bl: perWorld[i + 128],
        br: perWorld[i + 192],
      });
    }
  }
  return metatiles;
}

function loadWorldCHR(romData, worldId) {
  const tiles = [];
  // Common CHR: tiles 0-127
  for (let i = 0; i < 128; i++) {
    tiles.push(decodeTile(romData, COMMON_CHR + i * 16));
  }
  // Per-world CHR: tiles 128-255
  const perWorldBase = PERWORLD_CHR + worldId * 2048;
  for (let i = 0; i < 128; i++) {
    tiles.push(decodeTile(romData, perWorldBase + i * 16));
  }
  return tiles;
}

function loadWorldPalettes(romData) {
  const raw = romData.slice(BG_PALETTE, BG_PALETTE + 16);
  const palettes = [];
  for (let i = 0; i < 4; i++) {
    palettes.push([
      raw[i * 4],
      raw[i * 4 + 1],
      raw[i * 4 + 2],
      raw[i * 4 + 3],
    ]);
  }
  return palettes;
}

function loadWorldAttrs(romData, worldId) {
  const common = romData.slice(COMMON_ATTRS, COMMON_ATTRS + 64);
  const perWorld = romData.slice(PERWORLD_ATTRS + worldId * 64, PERWORLD_ATTRS + worldId * 64 + 64);

  const attrs = new Uint8Array(128);
  for (let i = 0; i < 64; i++) attrs[i] = common[i];
  for (let i = 0; i < 64; i++) attrs[64 + i] = perWorld[i];
  return attrs;
}

function loadWorldTileProps(romData) {
  const raw = romData.slice(TILE_PROPS, TILE_PROPS + 256);
  const props = [];
  for (let i = 0; i < 128; i++) {
    props.push({
      byte1: raw[i * 2],
      byte2: raw[i * 2 + 1],
    });
  }
  return props;
}

function decompressWorldTilemap(romData) {
  const tilemap = new Uint8Array(MAP_SIZE * MAP_SIZE);

  // Pointer table: 256 rows × 2 bytes at 0x00D010
  // Each pointer encodes bank + NES address
  const ptrTableROM = 0x00D010;

  for (let row = 0; row < MAP_SIZE; row++) {
    const lo = romData[ptrTableROM + row * 2];
    const hi = romData[ptrTableROM + row * 2 + 1];

    // Decode pointer: same scheme as indoor tilemaps but different base bank
    const adjusted = (hi + 0x10) & 0xFF;
    const nesHi = (adjusted & 0x1F) | 0x80;
    const bank = 6 + (adjusted >> 5);
    const dataROM = bank * 0x2000 + 0x10 + (nesHi * 256 + lo) - 0x8000;

    // Decompress one row with RLE (same bit-7 format as indoor)
    let readPos = dataROM;
    let writePos = row * MAP_SIZE;
    const rowEnd = writePos + MAP_SIZE;

    // Decompress up to 256 bytes (full NES row), but only keep first 128
    let decompressed = 0;
    while (decompressed < 256) {
      const byte = romData[readPos++];
      if ((byte & 0x80) === 0) {
        // Literal tile
        if (decompressed < MAP_SIZE) {
          tilemap[writePos + decompressed] = byte;
        }
        decompressed++;
      } else {
        // RLE: tile = byte & 0x7F, run = next byte
        const tile = byte & 0x7F;
        const runLen = romData[readPos++];
        for (let i = 0; i < runLen; i++) {
          if (decompressed < MAP_SIZE) {
            tilemap[writePos + decompressed] = tile;
          }
          decompressed++;
        }
      }
    }
  }

  return tilemap;
}
