#!/usr/bin/env node
// Quick Map Reference — dumps key map data to terminal
// Usage: node tools/map-debug.js <mapId>

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROM_PATH = join(__dirname, '..', 'Final Fantasy III (Japan).nes');

const MAP_PROPS_BASE     = 0x004010;
const COLLISION_BASE     = 0x003510;
const TILEMAP_ID_BASE    = 0x000A10;
const TILEMAP_PTR_BASE   = 0x022010;
const GFX_SUBSET_ID_BASE = 0x000C10;
const PAL_TABLE_1        = 0x001110;
const PAL_TABLE_2        = 0x001210;
const PAL_TABLE_3        = 0x001310;
const BANK10_BASE        = 0x020010;
const NPC_PTR_BASE       = 0x058010;

const COLL_TRIG_TYPES = {
  0: 'exit_prev', 1: 'exit_world', 4: 'entrance', 5: 'door',
  6: 'locked_door', 12: 'impassable', 13: 'impassable', 14: 'impassable', 15: 'event',
};

const DYN_TRIG_TYPES = { 0: 'event', 1: 'entrance', 2: 'treasure' };
const DYN_TYPE_TABLE = [
  0, 0, 0, 0,                            // $60-$63: events
  4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,   // $64-$6F: skipped
  1, 1, 1, 1, 1, 1, 1, 1,               // $70-$77: entrances/doors
  2, 2, 2, 2, 2,                         // $78-$7C: treasures
  4, 4, 4,                               // $7D-$7F: skipped
];

const rom = readFileSync(ROM_PATH);

const mapId = parseInt(process.argv[2], 10);
if (isNaN(mapId) || mapId < 0 || mapId >= 512) {
  console.log('Usage: node tools/map-debug.js <mapId>');
  console.log('  mapId: 0-511');
  process.exit(1);
}

// ─── Helpers ───

function hex(v, w = 2) { return '$' + v.toString(16).padStart(w, '0'); }

function decompressTilemap(tmId) {
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

function readEntranceData(ptrLo, ptrHi) {
  const nesAddr = ((ptrHi | 0x20) << 8) | ptrLo;
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
    npcs.push({ id, x: rom[pos + 1], y: rom[pos + 2], flags: rom[pos + 3] });
    pos += 4;
  }
  return npcs;
}

function describeCollision(b1, b2) {
  const z = b1 & 0x07;
  if (b1 & 0x80) {
    const tt = (b2 >> 4) & 0x0F;
    return `trigger:${COLL_TRIG_TYPES[tt] || `type${tt}`} (z=${z})`;
  }
  if (z === 3) return 'wall (z=3)';
  if (z === 2) return 'water (z=2)';
  return `passable (z=${z})`;
}

// ─── Map Properties ───

const off = MAP_PROPS_BASE + mapId * 16;
const d = rom.slice(off, off + 16);
const tileset   = (d[0] >> 5) & 7;
const entrX     = d[0] & 0x1F;
const entrY     = d[1] & 0x1F;
const fillTile  = d[3];
const npcIdx    = d[4];
const palIdx    = [d[5], d[6], d[7]];
const songId    = d[10];
const mapExit   = d[11];
const tilemapId = rom[TILEMAP_ID_BASE + mapId];
const gfxSubset = rom[GFX_SUBSET_ID_BASE + mapId];

console.log(`\n══ Map ${mapId} ════════════════════════════════════`);
console.log(`  Tileset: ${tileset}    Tilemap: ${tilemapId}    Fill: ${hex(fillTile)}    GFX: ${gfxSubset}`);
console.log(`  Entrance: (${entrX}, ${entrY})    Exit: map ${mapExit}    Song: ${songId}`);
console.log(`  Raw: ${Array.from(d).map(b => hex(b)).join(' ')}`);

// ─── Palettes ───

console.log(`\n── Palettes ──`);
for (let i = 0; i < 3; i++) {
  const c1 = rom[PAL_TABLE_1 + palIdx[i]];
  const c2 = rom[PAL_TABLE_2 + palIdx[i]];
  const c3 = rom[PAL_TABLE_3 + palIdx[i]];
  console.log(`  BG${i} (idx ${palIdx[i].toString().padStart(2)}): $0F ${hex(c1)} ${hex(c2)} ${hex(c3)}`);
}

// ─── Entrance Collision ───

const collOff = COLLISION_BASE + tileset * 256;
const tilemap = decompressTilemap(tilemapId);
const entrTile = tilemap[entrY * 32 + entrX];
const entrMeta = entrTile < 128 ? entrTile : entrTile & 0x7F;
const entrB1 = rom[collOff + entrMeta * 2];
const entrB2 = rom[collOff + entrMeta * 2 + 1];
console.log(`\n── Entrance Tile ──`);
console.log(`  (${entrX}, ${entrY}): metatile ${hex(entrTile)} → ${describeCollision(entrB1, entrB2)}`);

// ─── Entrance Data ───

const entrData = readEntranceData(d[12], d[13]);
if (entrData) {
  console.log(`\n── Entrance Destinations ──`);
  console.log(`  [${entrData.join(', ')}]`);
}

// ─── Collision Summary ───

console.log(`\n── Collision (tileset ${tileset}) ──`);
const stats = { passable: 0, wall: 0, water: 0, trigger: 0 };
const trigTiles = [];
for (let i = 0; i < 128; i++) {
  const b1 = rom[collOff + i * 2];
  const b2 = rom[collOff + i * 2 + 1];
  const z = b1 & 0x07;
  if (b1 & 0x80) {
    stats.trigger++;
    const tt = (b2 >> 4) & 0x0F;
    trigTiles.push({ id: i, z, trigType: tt, name: COLL_TRIG_TYPES[tt] || `type${tt}`, b2 });
  } else if (z === 3) { stats.wall++; }
  else if (z === 2) { stats.water++; }
  else { stats.passable++; }
}
console.log(`  Passable: ${stats.passable}    Wall: ${stats.wall}    Water: ${stats.water}    Trigger: ${stats.trigger}`);
if (trigTiles.length > 0) {
  for (const t of trigTiles) {
    console.log(`    ${hex(t.id)} z=${t.z} → ${t.name} (byte2=${hex(t.b2)})`);
  }
}

// ─── Dynamic Triggers ───

const perType = [0, 0, 0, 0, 0, 0, 0, 0];
const dynTrigs = [];
for (let i = 0; i < 1024; i++) {
  const tile = tilemap[i];
  if (!((tile >= 0x60 && tile < 0x64) || (tile >= 0x70 && tile < 0x7D))) continue;
  const idx = tile - 0x60;
  const trigType = DYN_TYPE_TABLE[idx];
  if (trigType === 4) continue; // skip unused range
  const trigId = perType[trigType]++;
  dynTrigs.push({ x: i % 32, y: Math.floor(i / 32), tile, trigType, trigId });
}

if (dynTrigs.length > 0) {
  console.log(`\n── Dynamic Triggers ──`);
  for (const dt of dynTrigs) {
    const name = DYN_TRIG_TYPES[dt.trigType] || `type${dt.trigType}`;
    let extra = '';
    if (dt.trigType === 1 && entrData && entrData[dt.trigId] !== undefined) {
      extra = ` → map ${entrData[dt.trigId]}`;
    }
    console.log(`  ${name} #${dt.trigId} at (${dt.x}, ${dt.y})  tile=${hex(dt.tile)}${extra}`);
  }
}

// ─── Collision Triggers in Tilemap ───

const collTrigs = new Map(); // group by type
for (let y = 0; y < 32; y++) {
  for (let x = 0; x < 32; x++) {
    const tid = tilemap[y * 32 + x];
    const m = tid < 128 ? tid : tid & 0x7F;
    if (m >= 128) continue;
    const b1 = rom[collOff + m * 2];
    if (!(b1 & 0x80)) continue;
    const b2 = rom[collOff + m * 2 + 1];
    const tt = (b2 >> 4) & 0x0F;
    const name = COLL_TRIG_TYPES[tt] || `type${tt}`;
    if (!collTrigs.has(name)) collTrigs.set(name, []);
    collTrigs.get(name).push({ x, y });
  }
}

if (collTrigs.size > 0) {
  console.log(`\n── Collision Triggers (in tilemap) ──`);
  for (const [type, positions] of collTrigs) {
    if (positions.length <= 10) {
      console.log(`  ${type}: ${positions.map(p => `(${p.x},${p.y})`).join(' ')}`);
    } else {
      console.log(`  ${type}: ${positions.length} tiles`);
    }
  }
}

// ─── NPCs ───

const npcs = readNPCs(npcIdx);
if (npcs.length > 0) {
  const mvNames = ['stationary', 'wander', 'type2', 'type3'];
  console.log(`\n── NPCs (${npcs.length}) ──`);
  for (const npc of npcs) {
    const mv = mvNames[(npc.flags >> 6) & 3];
    const dir = npc.flags & 0x0F;
    console.log(`  #${npc.id.toString().padStart(3)} at (${npc.x.toString().padStart(2)}, ${npc.y.toString().padStart(2)})  ${mv}  dir=${dir}`);
  }
}

console.log('');
