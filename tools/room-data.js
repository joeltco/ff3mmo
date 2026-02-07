#!/usr/bin/env node
// Room Data Tool — extracts comprehensive map data from FF3 ROM
// Usage: node tools/room-data.js [mapId|all]
// Outputs: tools/out/room-data.json and tools/out/room-data.md

import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const rom = readFileSync('Final Fantasy III (Japan).nes');
const arg = process.argv[2] || '114';

// ROM offsets (file offsets, including 16-byte iNES header)
const MAP_PROPS_BASE     = 0x004010;  // 512 maps × 16 bytes
const TILESET_BASE       = 0x002390;  // 7 tilesets × 512 bytes
const NAME_TABLE_BASE    = 0x003190;  // 7 × 128 bytes
const COLLISION_BASE     = 0x003510;  // 7 × 256 bytes (interleaved)
const GFX_SUBSET_ID_BASE = 0x000C10;  // 512 × 1 byte
const TILEMAP_ID_BASE    = 0x000A10;  // 512 × 1 byte
const TILEMAP_PTR_BASE   = 0x022010;  // pointer table
const PAL_TABLE_1        = 0x001110;
const PAL_TABLE_2        = 0x001210;
const PAL_TABLE_3        = 0x001310;

// Bank $10 at NES $A000 = file offset 0x020010
// Treasure pointers: $A000 (index 0-127), $A100 (index 128-255)
// Trigger pointers:  $A200 (index 0-127), $A300 (index 128-255)
const BANK10_BASE = 0x020010;

// NPC pointer table: bank $2C at NES $8000
const NPC_PTR_BASE = 0x058010;

// Map title names (from disassembly)
const MAP_TITLES = {};

// ─── Read map properties ───
function readMapProps(mapId) {
  const off = MAP_PROPS_BASE + mapId * 16;
  const d = rom.slice(off, off + 16);
  return {
    mapId,
    tileset: (d[0] >> 5) & 0x07,
    entranceX: d[0] & 0x1F,
    entranceY: d[1] & 0x1F,
    titleId: d[2],
    fillTile: d[3],
    npcIndex: d[4],
    bgPalette0: d[5],
    bgPalette1: d[6],
    bgPalette2: d[7],
    spritePal6: d[8],
    spritePal7: d[9],
    songId: d[10],
    mapExit: d[11],
    entrancePtrLo: d[12],
    entrancePtrHi: d[13],
    treasureIdx: d[14],
    triggerIdx: d[15],
    raw: Array.from(d).map(b => '0x' + b.toString(16).padStart(2, '0')),
  };
}

// ─── Read entrance data (16 bytes, direct pointer in bank $10) ───
function readEntranceData(props) {
  // Pointer: lo=byte12, hi=byte13|0x20 → NES address in $A000-$BFFF (bank $10)
  const nesAddr = ((props.entrancePtrHi | 0x20) << 8) | props.entrancePtrLo;
  // Only valid if in $A000-$BFFF range
  if (nesAddr < 0xA000 || nesAddr >= 0xC000) return null;
  const fileOff = BANK10_BASE + (nesAddr - 0xA000);
  const data = [];
  for (let i = 0; i < 16; i++) {
    data.push(rom[fileOff + i]);
  }
  return data;
}

// ─── Read treasure data (16 bytes, indexed pointer in bank $10) ───
function readTreasureData(props) {
  const idx = props.treasureIdx;
  const shifted = idx << 1;  // ASL
  const carry = idx >= 128;
  const tableBase = carry ? (BANK10_BASE + 0x100) : BANK10_BASE; // $A000 or $A100
  const ptrOff = tableBase + (shifted & 0xFF);
  const ptrLo = rom[ptrOff];
  const ptrHi = rom[ptrOff + 1];
  const nesAddr = ((ptrHi | 0x20) << 8) | ptrLo;
  if (nesAddr < 0xA000 || nesAddr >= 0xC000) return null;
  const fileOff = BANK10_BASE + (nesAddr - 0xA000);
  const data = [];
  for (let i = 0; i < 16; i++) data.push(rom[fileOff + i]);
  return data;
}

// ─── Read trigger data (16 bytes, indexed pointer in bank $10) ───
function readTriggerData(props) {
  const idx = props.triggerIdx;
  const shifted = idx << 1;
  const carry = idx >= 128;
  const tableBase = carry ? (BANK10_BASE + 0x300) : (BANK10_BASE + 0x200); // $A200 or $A300
  const ptrOff = tableBase + (shifted & 0xFF);
  const ptrLo = rom[ptrOff];
  const ptrHi = rom[ptrOff + 1];
  const nesAddr = ((ptrHi | 0x20) << 8) | ptrLo;
  if (nesAddr < 0xA000 || nesAddr >= 0xC000) return null;
  const fileOff = BANK10_BASE + (nesAddr - 0xA000);
  const data = [];
  for (let i = 0; i < 16; i++) data.push(rom[fileOff + i]);
  return data;
}

// ─── Read NPC data (4 bytes each, null-terminated) ───
function readNPCs(props) {
  const npcIdx = props.npcIndex;
  const shifted = npcIdx << 1;
  const carry = npcIdx >= 128;
  const ptrTableOff = NPC_PTR_BASE + (carry ? 0x100 : 0) + (shifted & 0xFF);
  const ptrLo = rom[ptrTableOff];
  const ptrHi = rom[ptrTableOff + 1];
  const nesAddr = ((ptrHi | 0x80) << 8) | ptrLo;
  // NPC data is in bank $2C at $8000-$9FFF
  const fileOff = 0x058010 + (nesAddr - 0x8000);
  if (fileOff < 0x058010 || fileOff >= 0x05C010) return [];

  const npcs = [];
  let pos = fileOff;
  for (let i = 0; i < 16; i++) { // max 16 NPCs
    const id = rom[pos];
    if (id === 0) break;
    npcs.push({
      id,
      x: rom[pos + 1],
      y: rom[pos + 2],
      flags: rom[pos + 3],
      movementType: (rom[pos + 3] >> 6) & 0x03,
      palette: (rom[pos + 3] >> 4) & 0x03,
      direction: rom[pos + 3] & 0x0F,
    });
    pos += 4;
  }
  return npcs;
}

// ─── Decompress tilemap ───
function decompressTilemap(mapId) {
  const tilemapId = rom[TILEMAP_ID_BASE + mapId];
  const ptrIndex = (tilemapId * 2) & 0xFF;
  const ptrTableHi = (tilemapId & 0x80) ? 0x81 : 0x80;
  const ptrTableRomBase = TILEMAP_PTR_BASE + ((ptrTableHi - 0x80) << 8);
  const ptrLo = rom[ptrTableRomBase + ptrIndex];
  const ptrHi = rom[ptrTableRomBase + ptrIndex + 1];
  const nesAddrLo = ptrLo;
  const nesAddrHi = (ptrHi & 0x1F) | 0x80;
  const bank = 0x11 + (ptrHi >> 5);
  const offset = bank * 0x2000 + 0x10 + ((nesAddrHi << 8 | nesAddrLo) - 0x8000);

  let readPos = offset;
  const tilemap = new Uint8Array(1024);
  let writePos = 0;
  while (writePos < 1024) {
    const byte = rom[readPos++];
    if ((byte & 0x80) === 0) {
      tilemap[writePos++] = byte;
    } else {
      const tile = byte & 0x7F;
      const runLen = rom[readPos++];
      for (let i = 0; i < runLen && writePos < 1024; i++) {
        tilemap[writePos++] = tile;
      }
    }
  }
  return tilemap;
}

// ─── Load collision data ───
function loadCollision(tilesetIdx) {
  const off = COLLISION_BASE + tilesetIdx * 256;
  const byte1 = new Uint8Array(128);
  for (let i = 0; i < 128; i++) {
    byte1[i] = rom[off + i * 2]; // de-interleave
  }
  return byte1;
}

// ─── Load collision byte2 (tile properties byte 2) ───
function loadCollisionByte2(tilesetIdx) {
  const off = COLLISION_BASE + tilesetIdx * 256;
  const byte2 = new Uint8Array(128);
  for (let i = 0; i < 128; i++) {
    byte2[i] = rom[off + i * 2 + 1]; // odd bytes = byte2
  }
  return byte2;
}

// Collision byte2 trigger type names (upper nibble of static collision data)
const BYTE2_TRIG_TYPES = {
  0: 'exit_prev', 1: 'exit_world', 4: 'entrance', 5: 'door',
  6: 'locked_door', 12: 'impassable', 13: 'impassable', 14: 'impassable', 15: 'event'
};

// Dynamic trigger init tables (from disassembly at 3A/921F and 3A/923F)
// Trigger type per placeholder tile (indexed by tile - 0x60)
// Type 0 = generic trigger, 1 = entrance/door, 2 = treasure
const TRIGGER_TYPE_TABLE = [
  0, 0, 0, 0,                          // $60-$63: generic triggers
  4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, // $64-$6F: (skipped in scan)
  1, 1, 1, 1, 1, 1, 1, 1,             // $70-$77: entrances/doors
  2, 2, 2, 2,                          // $78-$7B: treasures
  2,                                    // $7C: treasure chest
  4, 4, 4,                             // $7D-$7F: (skipped in scan)
];

// Tile ID base per placeholder tile (indexed by tile - 0x60)
const TILE_ID_BASE_TABLE = [
  0xF0, 0xF4, 0xF8, 0xFC,             // $60-$63
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // $64-$6F
  0x80, 0x90, 0xA0, 0xB0, 0xC0, 0xC4, 0xC8, 0xCC, // $70-$77
  0xE0, 0xE4, 0xE8, 0xEC,             // $78-$7B
  0xD0,                                 // $7C
  0x00, 0x00, 0x00,                    // $7D-$7F
];

// Dynamic trigger type names (for the trigger init system)
const DYN_TRIG_TYPES = { 0: 'event', 1: 'entrance', 2: 'treasure' };

// ─── Simulate post-decompression trigger tile init (3A/91A0-91C7) ───
// Scans the decompressed tilemap for placeholder tiles ($60-$63, $70-$7C)
// and converts them to special tiles ($80+) with sequential trigger IDs.
function processTriggerTiles(tilemap) {
  const perTileCounts = new Array(32).fill(0);  // per placeholder type count ($0740,X)
  const perTypeCounts = new Array(8).fill(0);   // per trigger type count ($0760,Y)
  const triggers = [];

  for (let i = 0; i < 1024; i++) {
    const tile = tilemap[i];

    // Only process $60-$63 and $70-$7C (matches scan conditions at 3A/91A4-91B2)
    const isTrigger = (tile >= 0x60 && tile < 0x64) || (tile >= 0x70 && tile < 0x7D);
    if (!isTrigger) continue;

    const x = i % 32;
    const y = Math.floor(i / 32);
    const idx = tile - 0x60;

    const tileCount = perTileCounts[idx];
    perTileCounts[idx]++;

    const trigType = TRIGGER_TYPE_TABLE[idx];
    const trigId = perTypeCounts[trigType];
    perTypeCounts[trigType]++;

    const newTileId = (TILE_ID_BASE_TABLE[idx] + tileCount) & 0xFF;

    // Replace tile in tilemap (matches STA ($80),Y at 3A/91B9)
    tilemap[i] = newTileId;

    triggers.push({
      x, y,
      originalTile: tile,
      newTileId,
      trigType,
      trigTypeName: DYN_TRIG_TYPES[trigType] || `dynType${trigType}`,
      trigId,
    });
  }

  return triggers;
}

// ─── Analyze tilemap for collision-based triggers and overlay tiles ───
function analyzeTilemap(tilemap, collision, byte2Data) {
  const collisionTriggers = [];
  const overlayTiles = [];

  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const tid = tilemap[y * 32 + x];
      const m = tid < 128 ? tid : tid & 0x7F;
      if (m >= collision.length) continue;

      const b1 = collision[m];

      // Collision-based trigger tiles (byte1 bit 7) — boundary exits etc.
      if (b1 & 0x80) {
        const b2 = byte2Data[m];
        const trigType = (b2 >> 4) & 0x0F;
        const trigId = b2 & 0x0F;
        collisionTriggers.push({
          x, y, tileId: tid, metatile: m,
          trigType, trigTypeName: BYTE2_TRIG_TYPES[trigType] || `type${trigType}`,
          trigId
        });
      }

      // Overlay tiles (sprite priority)
      if (b1 & 0x30) {
        overlayTiles.push({
          x, y, tileId: tid, metatile: m,
          upper: !!(b1 & 0x20), lower: !!(b1 & 0x10)
        });
      }
    }
  }

  return { collisionTriggers, overlayTiles };
}

// ─── Build room data for one map ───
function buildRoomData(mapId) {
  const props = readMapProps(mapId);

  // Skip empty/unused maps (all zeros)
  const allZero = props.raw.every(b => b === '0x00');
  if (allZero && mapId > 0) return null;

  const collision = loadCollision(props.tileset);
  const byte2Data = loadCollisionByte2(props.tileset);

  let tilemap = null;
  let analysis = null;
  let dynamicTriggers = null;
  try {
    tilemap = decompressTilemap(mapId);
    dynamicTriggers = processTriggerTiles(tilemap); // modifies tilemap in-place
    analysis = analyzeTilemap(tilemap, collision, byte2Data);
  } catch (e) {
    // Some maps may have invalid tilemap data
  }

  const entrances = readEntranceData(props);
  const treasures = readTreasureData(props);
  const triggerData = readTriggerData(props);
  const npcs = readNPCs(props);

  // Build exit summary from both dynamic triggers and collision-based triggers
  const exits = [];
  const seenPositions = new Set();

  // Dynamic trigger tiles — entrance/door triggers with sequential IDs
  if (dynamicTriggers && entrances) {
    for (const dt of dynamicTriggers) {
      if (dt.trigType === 1) { // entrance/door
        const key = `${dt.x},${dt.y}`;
        if (seenPositions.has(key)) continue;
        seenPositions.add(key);
        exits.push({
          type: 'entrance',
          position: `(${dt.x}, ${dt.y})`,
          index: dt.trigId,
          destination: entrances[dt.trigId],
          originalTile: dt.originalTile,
        });
      }
    }
  }

  // Collision-based trigger tiles (byte1 bit 7) — boundary exits, etc.
  if (analysis) {
    for (const ct of analysis.collisionTriggers) {
      const key = `${ct.x},${ct.y}`;
      if (seenPositions.has(key)) continue;
      seenPositions.add(key);

      if (['entrance', 'door', 'locked_door', 'exit_prev', 'exit_world'].includes(ct.trigTypeName)) {
        const dest = ct.trigTypeName === 'exit_prev' ? props.mapExit
          : ct.trigTypeName === 'exit_world' ? 'world'
          : entrances ? entrances[ct.trigId] : null;
        exits.push({
          type: ct.trigTypeName,
          position: `(${ct.x}, ${ct.y})`,
          index: ct.trigId,
          destination: dest,
          metatile: ct.metatile,
        });
      }
    }
  }

  // Build treasure list from dynamic triggers
  const chests = [];
  if (dynamicTriggers) {
    for (const dt of dynamicTriggers) {
      if (dt.trigType === 2) { // treasure
        chests.push({
          x: dt.x, y: dt.y,
          index: dt.trigId,
          originalTile: dt.originalTile,
          contents: treasures ? treasures[dt.trigId] : null,
        });
      }
    }
  }

  // Build event list from dynamic triggers
  const events = [];
  if (dynamicTriggers) {
    for (const dt of dynamicTriggers) {
      if (dt.trigType === 0) { // generic trigger/event
        events.push({
          x: dt.x, y: dt.y,
          index: dt.trigId,
          originalTile: dt.originalTile,
        });
      }
    }
  }

  return {
    mapId,
    properties: props,
    npcs,
    exits,
    chests,
    events,
    entranceData: entrances,
    treasureData: treasures,
    triggerData: triggerData,
    analysis: analysis ? {
      collisionTriggers: analysis.collisionTriggers.length,
      overlayTiles: analysis.overlayTiles.length,
      dynamicTriggers: dynamicTriggers ? dynamicTriggers.length : 0,
    } : null,
    defaultExit: props.mapExit,
  };
}

// ─── Format as markdown ───
function toMarkdown(rooms) {
  let md = '# FF3 Room Data Reference\n\n';
  md += `Generated from ROM, ${rooms.length} maps.\n\n`;

  for (const room of rooms) {
    if (!room) continue;
    const p = room.properties;
    md += `## Map ${room.mapId} — Tileset ${p.tileset}\n\n`;
    md += `- **Entrance**: (${p.entranceX}, ${p.entranceY})\n`;
    md += `- **Fill tile**: ${p.fillTile}\n`;
    md += `- **Song**: ${p.songId}\n`;
    md += `- **Default exit**: map ${p.mapExit}\n`;
    md += `- **Palettes**: BG [${p.bgPalette0}, ${p.bgPalette1}, ${p.bgPalette2}]\n`;
    md += `- **NPC index**: ${p.npcIndex}\n\n`;

    if (room.npcs.length > 0) {
      md += `### NPCs (${room.npcs.length})\n`;
      md += `| ID | Position | Movement | Dir |\n|---|---|---|---|\n`;
      for (const npc of room.npcs) {
        const mvTypes = ['stationary', 'wander', 'type2', 'type3'];
        md += `| ${npc.id} | (${npc.x}, ${npc.y}) | ${mvTypes[npc.movementType] || npc.movementType} | ${npc.direction} |\n`;
      }
      md += '\n';
    }

    if (room.exits.length > 0) {
      md += `### Exits (${room.exits.length})\n`;
      md += `| Type | Position | Idx | Dest Map |\n|---|---|---|---|\n`;
      for (const e of room.exits) {
        md += `| ${e.type} | ${e.position} | ${e.index} | ${e.destination} |\n`;
      }
      md += '\n';
    }

    if (room.chests && room.chests.length > 0) {
      md += `### Treasure Chests (${room.chests.length})\n`;
      for (const c of room.chests) {
        md += `- Chest at (${c.x}, ${c.y}) index ${c.index} → item ${c.contents}\n`;
      }
      md += '\n';
    }

    if (room.events && room.events.length > 0) {
      md += `### Event Triggers (${room.events.length})\n`;
      for (const ev of room.events) {
        md += `- Event at (${ev.x}, ${ev.y}) index ${ev.index}\n`;
      }
      md += '\n';
    }

    if (room.analysis) {
      md += `### Tile Stats\n`;
      md += `- Dynamic triggers: ${room.analysis.dynamicTriggers}, Collision triggers: ${room.analysis.collisionTriggers}, Overlay: ${room.analysis.overlayTiles}\n`;
      md += '\n';
    }
    md += '---\n\n';
  }
  return md;
}

// ─── Main ───
mkdirSync('tools/out', { recursive: true });

let mapIds;
if (arg === 'all') {
  mapIds = Array.from({ length: 512 }, (_, i) => i);
} else if (arg.includes('-')) {
  const [start, end] = arg.split('-').map(Number);
  mapIds = Array.from({ length: end - start + 1 }, (_, i) => start + i);
} else {
  // Single map + connected maps
  const baseId = parseInt(arg, 10);
  const baseRoom = buildRoomData(baseId);
  const connectedIds = new Set([baseId]);

  // Find all maps connected via exits
  if (baseRoom && baseRoom.exits) {
    for (const e of baseRoom.exits) {
      if (typeof e.destination === 'number' && e.destination > 0 && e.destination < 512) connectedIds.add(e.destination);
    }
  }
  if (baseRoom && baseRoom.defaultExit > 0) connectedIds.add(baseRoom.defaultExit);

  // Also check connected maps' exits (one level deep)
  const firstLevel = [...connectedIds];
  for (const id of firstLevel) {
    const room = buildRoomData(id);
    if (room && room.exits) {
      for (const e of room.exits) {
        if (typeof e.destination === 'number' && e.destination > 0 && e.destination < 512) connectedIds.add(e.destination);
      }
    }
    if (room && room.defaultExit > 0) connectedIds.add(room.defaultExit);
  }

  mapIds = [...connectedIds].sort((a, b) => a - b);
  console.log(`Map ${baseId} + connected maps: [${mapIds.join(', ')}]`);
}

const rooms = [];
for (const id of mapIds) {
  const room = buildRoomData(id);
  if (room) {
    rooms.push(room);
    const npcCount = room.npcs.length;
    const exitCount = room.exits.length;
    const chestCount = room.chests ? room.chests.length : 0;
    const eventCount = room.events ? room.events.length : 0;
    console.log(`Map ${id}: ${npcCount} NPCs, ${exitCount} exits, ${chestCount} chests, ${eventCount} events`);
  }
}

writeFileSync('tools/out/room-data.json', JSON.stringify(rooms, null, 2));
console.log(`\nWrote tools/out/room-data.json (${rooms.length} maps)`);

const md = toMarkdown(rooms);
writeFileSync('tools/out/room-data.md', md);
console.log(`Wrote tools/out/room-data.md`);
