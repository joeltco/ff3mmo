// Map Loader — reads FF3 map data from ROM and assembles all tile/palette/collision info

import { getBytesAt } from './rom-parser.js';
import { decodeTile } from './tile-decoder.js';

// ROM offsets (file offsets, including 16-byte iNES header)
const MAP_PROPS_BASE = 0x004010;      // 512 maps × 16 bytes each
const TILESET_BASE = 0x002390;        // 7 tilesets × 512 bytes
const NAME_TABLE_BASE = 0x003190;     // 7 × 128 bytes (palette per metatile)
const COLLISION_BASE = 0x003510;      // 7 × 256 bytes (128 byte1 + 128 byte2)
const GFX_SUBSET_ID_BASE = 0x000C10;  // 512 × 1 byte (graphics subset ID per map)
const GFX_SUBSET_BASE = 0x000E10;     // 48 × 16 bytes (8 × 2-byte pointers)
const MAP_BG_GFX_BASE = 0x006010;     // ~27KB of 2BPP tile graphics
const PALETTE_TABLE_1 = 0x001110;     // 256 bytes — palette color 1
const PALETTE_TABLE_2 = 0x001210;     // 256 bytes — palette color 2
const PALETTE_TABLE_3 = 0x001310;     // 256 bytes — palette color 3
const TILEMAP_ID_BASE = 0x000A10;     // 512 × 1 byte — tilemap ID per map
const TILEMAP_PTR_BASE = 0x022010;    // 2 bytes per tilemap ID (pointer table)
const BANK10_BASE = 0x020010;         // Bank $10 at NES $A000
const NPC_PTR_BASE = 0x058010;        // NPC property pointers (256 × 2 bytes)

// Dynamic trigger type table (from disassembly at 3A/921F)
// Indexed by (tile - 0x60). Type 0=event, 1=entrance/door, 2=treasure
const TRIGGER_TYPE_TABLE = [
  0, 0, 0, 0,                          // $60-$63: generic triggers
  4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, // $64-$6F: skipped
  1, 1, 1, 1, 1, 1, 1, 1,             // $70-$77: entrances/doors
  2, 2, 2, 2,                          // $78-$7B: treasures
  2,                                    // $7C: treasure chest
  4, 4, 4,                             // $7D-$7F: skipped
];

// Per-slot tile counts for graphics subsets
const GFX_SLOT_COUNTS = [0x1A, 0x08, 0x08, 0x0E, 0x08, 0x10, 0x10, 0x10]; // 130 tiles total

export function loadMap(romData, mapId) {
  const mapProps = parseMapProperties(romData, mapId);
  const metatiles = loadTileset(romData, mapProps.tileset);
  const chrTiles = loadCHRGraphics(romData, mapId);
  const tilemap = decompressTilemap(romData, mapId, mapProps.fillTile);
  const triggerMap = processTriggerTiles(tilemap); // must run before rendering (modifies tilemap)
  const palettes = buildMapPalettes(romData, mapProps);
  const collision = loadTileCollision(romData, mapProps.tileset);
  const collisionByte2 = loadTileCollisionByte2(romData, mapProps.tileset);
  const tileAttrs = loadNameTable(romData, mapProps.tileset);
  const entranceData = loadEntranceData(romData, mapProps);
  const npcs = readNPCs(romData, mapProps.npcIdx);
  const spritePalettes = buildSpritePalettes(romData, mapProps);

  return {
    tileset: mapProps.tileset,
    fillTile: mapProps.fillTile,
    entranceX: mapProps.entranceX,
    entranceY: mapProps.entranceY,
    mapExit: mapProps.mapExit,
    tilemap,
    chrTiles,
    metatiles,
    palettes,
    tileAttrs,
    collision,
    collisionByte2,
    entranceData,
    triggerMap,
    npcs,
    spritePalettes,
  };
}

export function parseMapProperties(romData, mapId) {
  const offset = MAP_PROPS_BASE + mapId * 16;
  const data = getBytesAt({ raw: romData }, offset, 16);

  const byte0 = data[0];
  const byte1 = data[1];

  return {
    _mapId: mapId,
    tileset: (byte0 >> 5) & 0x07,
    entranceX: byte0 & 0x1F,
    entranceY: byte1 & 0x1F,
    fillTile: data[3],
    bgPalette0: data[5],
    bgPalette1: data[6],
    bgPalette2: data[7],
    spritePalette6: data[8],
    spritePalette7: data[9],
    songId: data[10],
    mapExit: data[11],
    npcIdx: data[4],
  };
}

export function loadTileset(romData, tilesetIndex) {
  const offset = TILESET_BASE + tilesetIndex * 512;
  const data = getBytesAt({ raw: romData }, offset, 512);

  // Planar layout: 4 planes of 128 bytes each [TL×128][TR×128][BL×128][BR×128]
  const metatiles = [];
  for (let m = 0; m < 128; m++) {
    metatiles.push({
      tl: data[m],
      tr: data[m + 128],
      bl: data[m + 256],
      br: data[m + 384],
    });
  }
  return metatiles;
}

export function loadCHRGraphics(romData, mapId) {
  const subsetId = romData[GFX_SUBSET_ID_BASE + mapId];
  const subsetOffset = GFX_SUBSET_BASE + subsetId * 16;
  const subsetData = getBytesAt({ raw: romData }, subsetOffset, 16);

  // 8 pointers (2 bytes each, little-endian) pointing to tile data
  const pointers = [];
  for (let i = 0; i < 8; i++) {
    pointers.push(subsetData[i * 2] | (subsetData[i * 2 + 1] << 8));
  }

  // Load tiles from each slot
  const chrTiles = [];
  for (let slot = 0; slot < 8; slot++) {
    const count = GFX_SLOT_COUNTS[slot];
    // Pointers are direct byte offsets into the BG graphics region
    const ptr = pointers[slot];
    const gfxOffset = MAP_BG_GFX_BASE + ptr;

    for (let t = 0; t < count; t++) {
      const tileOffset = gfxOffset + t * 16;
      chrTiles.push(decodeTile(romData, tileOffset));
    }
  }

  return chrTiles;
}

function decompressTilemap(romData, mapId, fillTile) {
  // Step 1: Look up tilemap ID from the per-map table (00/8A00, ROM 0x000A10)
  const tilemapId = romData[TILEMAP_ID_BASE + mapId];

  // Step 2: Read 2-byte pointer from pointer table at 11/A000 (ROM 0x022010)
  // Index is tilemapId * 2, with bank selection based on bit 7
  const ptrIndex = (tilemapId * 2) & 0xFF;
  const ptrTableHi = (tilemapId & 0x80) ? 0x81 : 0x80;
  // NES $8000 in bank 0x11 = ROM 0x022010, $8100 = ROM 0x022110
  const ptrTableRomBase = 0x022010 + ((ptrTableHi - 0x80) << 8);
  const ptrLo = romData[ptrTableRomBase + ptrIndex];
  const ptrHi = romData[ptrTableRomBase + ptrIndex + 1];

  // Step 3: Decode the pointer into a ROM offset
  // Low byte of NES address = ptrLo
  // High byte = (ptrHi & 0x1F) | 0x80
  // Bank = 0x11 + (ptrHi >> 5)
  const nesAddrLo = ptrLo;
  const nesAddrHi = (ptrHi & 0x1F) | 0x80;
  const bank = 0x11 + (ptrHi >> 5);
  const offset = bank * 0x2000 + 0x10 + ((nesAddrHi << 8 | nesAddrLo) - 0x8000);

  // Step 4: Decompress RLE tilemap
  // Format: bit 7 clear = literal tile, bit 7 set = RLE (tile & 0x7F, next byte = run length)
  let readPos = offset;
  const tilemap = new Uint8Array(1024); // 32×32
  let writePos = 0;

  while (writePos < 1024) {
    const byte = romData[readPos++];
    if ((byte & 0x80) === 0) {
      tilemap[writePos++] = byte;
    } else {
      const tile = byte & 0x7F;
      const runLen = romData[readPos++];
      for (let i = 0; i < runLen && writePos < 1024; i++) {
        tilemap[writePos++] = tile;
      }
    }
  }

  return tilemap;
}

export function buildMapPalettes(romData, mapProps) {
  const paletteIndices = [mapProps.bgPalette0, mapProps.bgPalette1, mapProps.bgPalette2];
  const palettes = [];

  for (let i = 0; i < 3; i++) {
    const idx = paletteIndices[i];
    palettes.push([
      0x0F, // BG color always black
      romData[PALETTE_TABLE_1 + idx],
      romData[PALETTE_TABLE_2 + idx],
      romData[PALETTE_TABLE_3 + idx],
    ]);
  }

  // Palette 3 — menu/text window palette (hardcoded in game at 3A/9133)
  palettes.push([0x0F, 0x00, 0x02, 0x30]);

  return palettes;
}

// Build sprite palettes 6 and 7 (PPU palettes 6-7) as NES color indices
// Returns [[pal6: 4 NES colors], [pal7: 4 NES colors]]
function buildSpritePalettes(romData, mapProps) {
  return [mapProps.spritePalette6, mapProps.spritePalette7].map(idx => [
    0x0F, // color 0 transparent (rendered as black in NES)
    romData[PALETTE_TABLE_1 + idx],
    romData[PALETTE_TABLE_2 + idx],
    romData[PALETTE_TABLE_3 + idx],
  ]);
}

export function loadTileCollision(romData, tilesetIndex) {
  // Tile properties are interleaved: [tile0_byte1, tile0_byte2, tile1_byte1, tile1_byte2, ...]
  // De-interleave to get byte 1 for each of the 128 tiles
  const offset = COLLISION_BASE + tilesetIndex * 256;
  const raw = getBytesAt({ raw: romData }, offset, 256);
  const byte1 = new Uint8Array(128);
  for (let i = 0; i < 128; i++) {
    byte1[i] = raw[i * 2];
  }
  return byte1;
}

export function loadNameTable(romData, tilesetIndex) {
  const offset = NAME_TABLE_BASE + tilesetIndex * 128;
  const data = getBytesAt({ raw: romData }, offset, 128);
  return new Uint8Array(data);
}

export function loadTileCollisionByte2(romData, tilesetIndex) {
  const offset = COLLISION_BASE + tilesetIndex * 256;
  const raw = getBytesAt({ raw: romData }, offset, 256);
  const byte2 = new Uint8Array(128);
  for (let i = 0; i < 128; i++) {
    byte2[i] = raw[i * 2 + 1]; // odd bytes = byte2
  }
  return byte2;
}

function loadEntranceData(romData, mapProps) {
  // Pointer: lo=byte12(entrancePtrLo), hi=byte13(entrancePtrHi)|0x20
  // Points into bank $10 ($A000-$BFFF), 16 bytes of destination map IDs
  const offset = MAP_PROPS_BASE + mapProps._mapId * 16;
  const raw = getBytesAt({ raw: romData }, offset, 16);
  const ptrLo = raw[12];
  const ptrHi = raw[13];
  const nesAddr = ((ptrHi | 0x20) << 8) | ptrLo;
  if (nesAddr < 0xA000 || nesAddr >= 0xC000) return new Uint8Array(16);
  const fileOff = BANK10_BASE + (nesAddr - 0xA000);
  return new Uint8Array(getBytesAt({ raw: romData }, fileOff, 16));
}

function readNPCs(romData, npcIdx) {
  const shifted = npcIdx << 1;
  const carry = npcIdx >= 128;
  const ptrOff = NPC_PTR_BASE + (carry ? 0x100 : 0) + (shifted & 0xFF);
  const lo = romData[ptrOff], hi = romData[ptrOff + 1];
  const nesAddr = ((hi | 0x80) << 8) | lo;
  const fileOff = 0x058010 + (nesAddr - 0x8000);
  if (fileOff < 0x058010 || fileOff >= 0x05C010) return [];
  const npcs = [];
  let pos = fileOff;
  for (let i = 0; i < 16; i++) {
    const id = romData[pos];
    if (id === 0) break;
    npcs.push({ id, x: romData[pos + 1], y: romData[pos + 2], flags: romData[pos + 3] });
    pos += 4;
  }
  return npcs;
}

// Scan decompressed tilemap for placeholder tiles ($60-$63, $70-$7C),
// assign sequential trigger IDs per type, and replace them with special tile IDs.
// Returns Map<"x,y", {type, trigId}> for quick position lookup.
export function processTriggerTiles(tilemap) {
  const perTypeCounts = new Array(8).fill(0);
  const trigMap = new Map();

  for (let i = 0; i < 1024; i++) {
    const tile = tilemap[i];
    const isTrigger = (tile >= 0x60 && tile < 0x64) || (tile >= 0x70 && tile < 0x7D);
    if (!isTrigger) continue;

    const x = i % 32;
    const y = Math.floor(i / 32);
    const idx = tile - 0x60;

    const trigType = TRIGGER_TYPE_TABLE[idx];
    const trigId = perTypeCounts[trigType];
    perTypeCounts[trigType]++;

    trigMap.set(`${x},${y}`, { type: trigType, trigId });
  }

  return trigMap;
}
