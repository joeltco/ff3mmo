#!/usr/bin/env node
// Room Data Tool — extracts comprehensive map data from FF3 ROM
// Usage: node tools/room-data.js [mapId|start-end|all]
// Outputs: tools/out/room-data.json and tools/out/room-data.md

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT   = join(__dirname, '..');
const ROM_PATH  = join(PROJECT, 'Final Fantasy III (Japan).nes');
const OUT_DIR   = join(__dirname, 'out');

const rom = readFileSync(ROM_PATH);
const arg = process.argv[2] || '114';

// ─── ROM offsets (file offsets, including 16-byte iNES header) ───
const MAP_PROPS_BASE     = 0x004010;
const COLLISION_BASE     = 0x003510;
const GFX_SUBSET_ID_BASE = 0x000C10;
const TILEMAP_ID_BASE    = 0x000A10;
const TILEMAP_PTR_BASE   = 0x022010;
const PAL_TABLE_1        = 0x001110;
const PAL_TABLE_2        = 0x001210;
const PAL_TABLE_3        = 0x001310;
const BANK10_BASE        = 0x020010;
const NPC_PTR_BASE       = 0x058010;

// Collision trigger type names (upper nibble of byte2)
const COLL_TRIG_TYPES = {
  0: 'exit_prev', 1: 'exit_world', 4: 'entrance', 5: 'door',
  6: 'locked_door', 12: 'impassable', 13: 'impassable', 14: 'impassable', 15: 'event',
};

// Dynamic trigger init tables (from disassembly 3A/921F and 3A/923F)
const DYN_TYPE_TABLE = [
  0, 0, 0, 0,                            // $60-$63: events
  4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,   // $64-$6F: skipped
  1, 1, 1, 1, 1, 1, 1, 1,               // $70-$77: entrances/doors
  2, 2, 2, 2, 2,                         // $78-$7C: treasures
  4, 4, 4,                               // $7D-$7F: skipped
];

const DYN_TILE_ID_BASE = [
  0xF0, 0xF4, 0xF8, 0xFC,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x80, 0x90, 0xA0, 0xB0, 0xC0, 0xC4, 0xC8, 0xCC,
  0xE0, 0xE4, 0xE8, 0xEC, 0xD0,
  0x00, 0x00, 0x00,
];

const DYN_TRIG_TYPES = { 0: 'event', 1: 'entrance', 2: 'treasure' };

// ─── Helpers ───

function hex(v, w = 2) { return '0x' + v.toString(16).padStart(w, '0'); }

function readMapProps(mapId) {
  const off = MAP_PROPS_BASE + mapId * 16;
  const d = rom.slice(off, off + 16);
  return {
    mapId,
    tileset:       (d[0] >> 5) & 0x07,
    entranceX:     d[0] & 0x1F,
    entranceY:     d[1] & 0x1F,
    titleId:       d[2],
    fillTile:      d[3],
    npcIndex:      d[4],
    bgPalette0:    d[5],
    bgPalette1:    d[6],
    bgPalette2:    d[7],
    spritePal6:    d[8],
    spritePal7:    d[9],
    songId:        d[10],
    mapExit:       d[11],
    entrancePtrLo: d[12],
    entrancePtrHi: d[13],
    treasureIdx:   d[14],
    triggerIdx:    d[15],
    raw: Array.from(d).map(b => hex(b)),
  };
}

function readBankedData(ptrLo, ptrHi) {
  const nesAddr = ((ptrHi | 0x20) << 8) | ptrLo;
  if (nesAddr < 0xA000 || nesAddr >= 0xC000) return null;
  return Array.from(rom.slice(BANK10_BASE + (nesAddr - 0xA000), BANK10_BASE + (nesAddr - 0xA000) + 16));
}

function readIndexedBankData(idx, tableOffset) {
  const shifted = idx << 1;
  const carry = idx >= 128;
  const base = carry ? (BANK10_BASE + tableOffset + 0x100) : (BANK10_BASE + tableOffset);
  const ptrOff = base + (shifted & 0xFF);
  const lo = rom[ptrOff], hi = rom[ptrOff + 1];
  const nesAddr = ((hi | 0x20) << 8) | lo;
  if (nesAddr < 0xA000 || nesAddr >= 0xC000) return null;
  return Array.from(rom.slice(BANK10_BASE + (nesAddr - 0xA000), BANK10_BASE + (nesAddr - 0xA000) + 16));
}

function readNPCs(npcIdx) {
  const shifted = npcIdx << 1;
  const carry = npcIdx >= 128;
  const ptrOff = NPC_PTR_BASE + (carry ? 0x100 : 0) + (shifted & 0xFF);
  const lo = rom[ptrOff], hi = rom[ptrOff + 1];
  const nesAddr = ((hi | 0x80) << 8) | lo;
  const fileOff = 0x058010 + (nesAddr - 0x8000);
  if (fileOff < 0x058010 || fileOff >= 0x05C010) return [];

  const npcs = [];
  let pos = fileOff;
  for (let i = 0; i < 16; i++) {
    const id = rom[pos];
    if (id === 0) break;
    const flags = rom[pos + 3];
    npcs.push({
      id,
      x: rom[pos + 1],
      y: rom[pos + 2],
      movementType: (flags >> 6) & 0x03,
      palette: (flags >> 4) & 0x03,
      direction: flags & 0x0F,
    });
    pos += 4;
  }
  return npcs;
}

function decompressTilemap(mapId) {
  const tmId = rom[TILEMAP_ID_BASE + mapId];
  const ptrIndex = (tmId * 2) & 0xFF;
  const ptrTableHi = (tmId & 0x80) ? 0x81 : 0x80;
  const ptrBase = TILEMAP_PTR_BASE + ((ptrTableHi - 0x80) << 8);
  const lo = rom[ptrBase + ptrIndex];
  const hi = rom[ptrBase + ptrIndex + 1];
  const nesHi = (hi & 0x1F) | 0x80;
  const bank = 0x11 + (hi >> 5);
  const offset = bank * 0x2000 + 0x10 + ((nesHi << 8 | lo) - 0x8000);

  const tilemap = new Uint8Array(1024);
  let rp = offset, wp = 0;
  while (wp < 1024) {
    const b = rom[rp++];
    if ((b & 0x80) === 0) {
      tilemap[wp++] = b;
    } else {
      const tile = b & 0x7F;
      const run = rom[rp++];
      for (let i = 0; i < run && wp < 1024; i++) tilemap[wp++] = tile;
    }
  }
  return tilemap;
}

function loadCollision(tilesetIdx) {
  const off = COLLISION_BASE + tilesetIdx * 256;
  const byte1 = new Uint8Array(128);
  const byte2 = new Uint8Array(128);
  for (let i = 0; i < 128; i++) {
    byte1[i] = rom[off + i * 2];
    byte2[i] = rom[off + i * 2 + 1];
  }
  return { byte1, byte2 };
}

function describeCollision(b1, b2) {
  const z = b1 & 0x07;
  if (b1 & 0x80) {
    const tt = (b2 >> 4) & 0x0F;
    return COLL_TRIG_TYPES[tt] || `trigType${tt}`;
  }
  if (z === 3) return 'wall';
  if (z === 2) return 'water';
  return 'passable';
}

// ─── Process dynamic trigger tiles ($60-$63, $70-$7C) ───
function processTriggerTiles(tilemap) {
  const perTileCounts = new Array(32).fill(0);
  const perTypeCounts = new Array(8).fill(0);
  const triggers = [];

  for (let i = 0; i < 1024; i++) {
    const tile = tilemap[i];
    if (!((tile >= 0x60 && tile < 0x64) || (tile >= 0x70 && tile < 0x7D))) continue;

    const idx = tile - 0x60;
    const tileCount = perTileCounts[idx]++;
    const trigType = DYN_TYPE_TABLE[idx];
    if (trigType === 4) continue; // skip unused range
    const trigId = perTypeCounts[trigType]++;
    const newTileId = (DYN_TILE_ID_BASE[idx] + tileCount) & 0xFF;

    tilemap[i] = newTileId;

    triggers.push({
      x: i % 32,
      y: Math.floor(i / 32),
      originalTile: tile,
      newTileId,
      trigType,
      trigTypeName: DYN_TRIG_TYPES[trigType] || `dynType${trigType}`,
      trigId,
    });
  }
  return triggers;
}

// ─── Analyze tilemap for collision-based triggers ───
function analyzeTilemap(tilemap, coll) {
  const collisionTriggers = [];
  const overlayTiles = [];

  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const tid = tilemap[y * 32 + x];
      const m = tid < 128 ? tid : tid & 0x7F;
      if (m >= coll.byte1.length) continue;

      const b1 = coll.byte1[m];

      if (b1 & 0x80) {
        const b2 = coll.byte2[m];
        const trigType = (b2 >> 4) & 0x0F;
        collisionTriggers.push({
          x, y, tileId: tid, metatile: m,
          trigType, trigTypeName: COLL_TRIG_TYPES[trigType] || `type${trigType}`,
          trigId: b2 & 0x0F,
        });
      }

      if (b1 & 0x30) {
        overlayTiles.push({
          x, y, tileId: tid, metatile: m,
          upper: !!(b1 & 0x20), lower: !!(b1 & 0x10),
        });
      }
    }
  }
  return { collisionTriggers, overlayTiles };
}

// ─── Build room data for one map ───
function buildRoomData(mapId) {
  const props = readMapProps(mapId);
  if (props.raw.every(b => b === '0x00') && mapId > 0) return null;

  const coll = loadCollision(props.tileset);
  const tilemapId = rom[TILEMAP_ID_BASE + mapId];

  let tilemap = null, analysis = null, dynamicTriggers = null;
  try {
    tilemap = decompressTilemap(mapId);
    dynamicTriggers = processTriggerTiles(tilemap);
    analysis = analyzeTilemap(tilemap, coll);
  } catch (e) { /* invalid tilemap data */ }

  const entrances = readBankedData(props.entrancePtrLo, props.entrancePtrHi);
  const treasures = readIndexedBankData(props.treasureIdx, 0x000);
  const triggerData = readIndexedBankData(props.triggerIdx, 0x200);
  const npcs = readNPCs(props.npcIndex);

  // Entrance tile collision type
  let entranceCollision = null;
  if (tilemap) {
    const eTile = tilemap[props.entranceY * 32 + props.entranceX];
    const eM = eTile < 128 ? eTile : eTile & 0x7F;
    if (eM < coll.byte1.length) {
      entranceCollision = describeCollision(coll.byte1[eM], coll.byte2[eM]);
    }
  }

  // Build exit summary
  const exits = [];
  const seenPositions = new Set();

  if (dynamicTriggers && entrances) {
    for (const dt of dynamicTriggers) {
      if (dt.trigType !== 1) continue;
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

  // Treasures
  const chests = [];
  if (dynamicTriggers) {
    for (const dt of dynamicTriggers) {
      if (dt.trigType !== 2) continue;
      chests.push({
        x: dt.x, y: dt.y,
        index: dt.trigId,
        originalTile: dt.originalTile,
        contents: treasures ? treasures[dt.trigId] : null,
      });
    }
  }

  // Events
  const events = [];
  if (dynamicTriggers) {
    for (const dt of dynamicTriggers) {
      if (dt.trigType !== 0) continue;
      events.push({ x: dt.x, y: dt.y, index: dt.trigId, originalTile: dt.originalTile });
    }
  }

  return {
    mapId,
    tilemapId,
    properties: props,
    entranceCollision,
    npcs,
    exits,
    chests,
    events,
    entranceData: entrances,
    treasureData: treasures,
    triggerData,
    analysis: analysis ? {
      collisionTriggers: analysis.collisionTriggers.length,
      overlayTiles: analysis.overlayTiles.length,
      dynamicTriggers: dynamicTriggers ? dynamicTriggers.length : 0,
    } : null,
    defaultExit: props.mapExit,
  };
}

// ─── Markdown output ───
function toMarkdown(rooms) {
  const mvNames = ['stationary', 'wander', 'type2', 'type3'];
  let md = `# FF3 Room Data Reference\n\n`;
  md += `${rooms.length} maps extracted from ROM.\n\n`;

  for (const room of rooms) {
    if (!room) continue;
    const p = room.properties;
    md += `## Map ${room.mapId}\n\n`;
    md += `| Property | Value |\n|---|---|\n`;
    md += `| Tileset | ${p.tileset} |\n`;
    md += `| Tilemap | ${room.tilemapId} |\n`;
    md += `| Entrance | (${p.entranceX}, ${p.entranceY}) — ${room.entranceCollision || '?'} |\n`;
    md += `| Fill tile | ${hex(p.fillTile)} |\n`;
    md += `| Default exit | map ${p.mapExit} |\n`;
    md += `| Song | ${p.songId} |\n`;
    md += `| BG palettes | [${p.bgPalette0}, ${p.bgPalette1}, ${p.bgPalette2}] |\n`;
    md += `| NPC index | ${p.npcIndex} |\n\n`;

    if (room.npcs.length > 0) {
      md += `### NPCs (${room.npcs.length})\n\n`;
      md += `| ID | Position | Movement | Dir |\n|---|---|---|---|\n`;
      for (const npc of room.npcs) {
        md += `| ${npc.id} | (${npc.x}, ${npc.y}) | ${mvNames[npc.movementType]} | ${npc.direction} |\n`;
      }
      md += '\n';
    }

    if (room.exits.length > 0) {
      md += `### Exits (${room.exits.length})\n\n`;
      md += `| Type | Position | Idx | Dest Map |\n|---|---|---|---|\n`;
      for (const e of room.exits) {
        md += `| ${e.type} | ${e.position} | ${e.index} | ${e.destination} |\n`;
      }
      md += '\n';
    }

    if (room.chests.length > 0) {
      md += `### Treasures (${room.chests.length})\n\n`;
      for (const c of room.chests) {
        md += `- Chest at (${c.x}, ${c.y}) index ${c.index} → item ${c.contents}\n`;
      }
      md += '\n';
    }

    if (room.events.length > 0) {
      md += `### Events (${room.events.length})\n\n`;
      for (const ev of room.events) {
        md += `- Event at (${ev.x}, ${ev.y}) index ${ev.index}\n`;
      }
      md += '\n';
    }

    if (room.analysis) {
      md += `### Stats\n\n`;
      md += `Dynamic triggers: ${room.analysis.dynamicTriggers} | `;
      md += `Collision triggers: ${room.analysis.collisionTriggers} | `;
      md += `Overlay tiles: ${room.analysis.overlayTiles}\n\n`;
    }
    md += '---\n\n';
  }
  return md;
}

// ─── Main ───
mkdirSync(OUT_DIR, { recursive: true });

let mapIds;
if (arg === 'all') {
  mapIds = Array.from({ length: 512 }, (_, i) => i);
} else if (arg.includes('-')) {
  const [start, end] = arg.split('-').map(Number);
  mapIds = Array.from({ length: end - start + 1 }, (_, i) => start + i);
} else {
  // Single map + connected maps (2 levels deep)
  const baseId = parseInt(arg, 10);
  const baseRoom = buildRoomData(baseId);
  const connectedIds = new Set([baseId]);

  if (baseRoom) {
    for (const e of baseRoom.exits) {
      if (typeof e.destination === 'number' && e.destination > 0 && e.destination < 512) connectedIds.add(e.destination);
    }
    if (baseRoom.defaultExit > 0) connectedIds.add(baseRoom.defaultExit);
  }

  const firstLevel = [...connectedIds];
  for (const id of firstLevel) {
    const room = buildRoomData(id);
    if (!room) continue;
    for (const e of room.exits) {
      if (typeof e.destination === 'number' && e.destination > 0 && e.destination < 512) connectedIds.add(e.destination);
    }
    if (room.defaultExit > 0) connectedIds.add(room.defaultExit);
  }

  mapIds = [...connectedIds].sort((a, b) => a - b);
  console.log(`Map ${baseId} + connected: [${mapIds.join(', ')}]`);
}

const rooms = [];
for (const id of mapIds) {
  const room = buildRoomData(id);
  if (!room) continue;
  rooms.push(room);
  const parts = [
    `${room.npcs.length} NPCs`,
    `${room.exits.length} exits`,
    `${room.chests.length} chests`,
    `${room.events.length} events`,
  ];
  console.log(`  Map ${id} (tm ${room.tilemapId}): ${parts.join(', ')}`);
}

writeFileSync(join(OUT_DIR, 'room-data.json'), JSON.stringify(rooms, null, 2));
console.log(`\nWrote ${OUT_DIR}/room-data.json (${rooms.length} maps)`);

const md = toMarkdown(rooms);
writeFileSync(join(OUT_DIR, 'room-data.md'), md);
console.log(`Wrote ${OUT_DIR}/room-data.md`);
