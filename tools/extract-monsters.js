#!/usr/bin/env node
// Extract real monster stats + sprite data from FF3 NES ROM
// Usage: node tools/extract-monsters.js [path-to-rom]

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const romPath = process.argv[2] || join(__dirname, '..', 'Final Fantasy III (Japan).nes');
const rom = readFileSync(romPath);

// ── ROM offset helper ──────────────────────────────────────────────
// MMC3: 8KB PRG banks.  $8000-$9FFF and $A000-$BFFF are switchable.
function romOff(bank, addr) {
  const windowBase = addr >= 0xA000 ? 0xA000 : 0x8000;
  return bank * 0x2000 + (addr - windowBase) + 0x10;
}

// ── KEY ROM TABLES ─────────────────────────────────────────────────
const PROP_OFF     = romOff(0x30, 0x8000);   // Monster properties: 16 bytes/monster
const STAT_SET_OFF = romOff(0x30, 0x9000);   // Stat sets: 3 bytes each [evade, atk, def]
const GFX_TABLE    = romOff(0x2E, 0x8B00);   // Per-monster gfx attribute (1 byte each)
const MON_SET_OFF  = romOff(0x2E, 0x8400);   // Monster set data: 6 bytes each [pal0,pal1,id0-3]
const PAL_TABLE    = romOff(0x2E, 0x8C00);   // Palette table: 3 bytes each [c1,c2,c3]
const SIZE_PTR     = romOff(0x2F, 0xA4B4);   // Size category table: 4 bytes each
const SIZE_DIM     = romOff(0x2F, 0xA4CC);   // Dimensions: 2 bytes each [cols, rows]

// ── SIZE CATEGORIES ────────────────────────────────────────────────
const SIZE_CATS = [];
for (let i = 0; i < 6; i++) {
  const b = SIZE_PTR + i * 4;
  const baseAddr = rom[b] | (rom[b + 1] << 8);
  const bank = rom[b + 2] * 2; // ROM stores 16KB bank, actual is 8KB (×2)
  const cols = rom[SIZE_DIM + i * 2];
  const rows = rom[SIZE_DIM + i * 2 + 1];
  SIZE_CATS.push({ baseAddr, bank, cols, rows, tiles: cols * rows, bytes: cols * rows * 16 });
}

// ── STAT EXTRACTION ────────────────────────────────────────────────
function readMonsterStats(id) {
  const base = PROP_OFF + id * 16;
  const level = rom[base];
  const hp    = rom[base + 1] | (rom[base + 2] << 8);
  const atkSetIdx = rom[base + 9];
  const defSetIdx = rom[base + 12];
  const atk = rom[STAT_SET_OFF + atkSetIdx * 3 + 1];
  const def = rom[STAT_SET_OFF + defSetIdx * 3 + 2];
  return { level, hp, atk, def };
}

// ── BOSS BANK MAPPING ──────────────────────────────────────────────
// Emulates 6502 ROL×3 on hi byte to compute 16KB bank pair index
const BOSS_PTR = romOff(0x2E, 0x9068);
const CAT6_COLS = 18, CAT6_ROWS = 12;
const CAT6_BYTES = CAT6_COLS * CAT6_ROWS * 16; // 3456 bytes

function bossBank16k(hi) {
  let a = hi, c = 0;
  for (let i = 0; i < 3; i++) {
    const newC = (a >> 7) & 1;
    a = ((a << 1) | c) & 0xFF;
    c = newC;
  }
  if (c) return 0x06; // summon graphics bank
  return (a & 0x03) + 0x10;
}

function extractBossSprite(gfxId) {
  const lo = rom[BOSS_PTR + gfxId * 2];
  const hi = rom[BOSS_PTR + gfxId * 2 + 1];
  const tileOff = ((hi & 0x03) << 8) | lo;
  const bank16k = bossBank16k(hi);
  const spriteRomOff = bank16k * 0x4000 + tileOff * 16 + 0x10;
  if (spriteRomOff + CAT6_BYTES > rom.length) return null;
  const raw = rom.slice(spriteRomOff, spriteRomOff + CAT6_BYTES);
  return { cols: CAT6_COLS, rows: CAT6_ROWS, raw: Array.from(raw), catIdx: 6, gfxId };
}

// ── SPRITE EXTRACTION ──────────────────────────────────────────────
function extractSprite(monsterId) {
  const attr = rom[GFX_TABLE + monsterId];
  const catIdx = (attr & 0xE0) >> 5;
  const gfxId = attr & 0x1F;

  if (catIdx === 6) return extractBossSprite(gfxId); // Cat 6: boss graphics path

  if (catIdx >= SIZE_CATS.length) return null;

  const cat = SIZE_CATS[catIdx];
  const bankBase = cat.bank * 0x2000 + 0x10;
  const baseOff = cat.baseAddr - 0x8000;
  const spriteRomOff = bankBase + baseOff + gfxId * cat.bytes;

  if (spriteRomOff + cat.bytes > rom.length) return null;

  const raw = rom.slice(spriteRomOff, spriteRomOff + cat.bytes);
  return { cols: cat.cols, rows: cat.rows, raw: Array.from(raw), catIdx, gfxId };
}

// ── PALETTE EXTRACTION ─────────────────────────────────────────────
function readPalette(idx) {
  const off = PAL_TABLE + idx * 3;
  return [0x0F, rom[off], rom[off + 1], rom[off + 2]];
}

// ── MONSTER SET → PALETTE MAPPING ──────────────────────────────────
// Build map: monsterId → {pal0, pal1} from first encounter that contains it
function buildPaletteMap() {
  const palMap = new Map();
  // Scan all monster sets (up to ~300 entries)
  for (let i = 0; i < 300; i++) {
    const base = MON_SET_OFF + i * 6;
    if (base + 6 > rom.length) break;
    const pal0Idx = rom[base];
    const pal1Idx = rom[base + 1];
    for (let slot = 0; slot < 4; slot++) {
      const monId = rom[base + 2 + slot];
      if (monId === 0xFF) continue;
      if (!palMap.has(monId)) {
        palMap.set(monId, {
          pal0: readPalette(pal0Idx),
          pal1: readPalette(pal1Idx),
          pal0Idx, pal1Idx
        });
      }
    }
  }
  return palMap;
}

// ── TILE PALETTE ASSIGNMENT (per 16×16 block) ──────────────────────
// NES attribute table assigns palette per 16×16 pixel area.
// We default to pal0 for all tiles, which is the most common pattern.
// Per-block assignment can be refined with visual verification.
function defaultTilePal(cols, rows) {
  return new Array(cols * rows).fill(0);
}

// ── VERIFY AGAINST KNOWN DATA ──────────────────────────────────────
console.log('=== VERIFICATION ===');
const testCases = [
  { id: 0x00, name: 'Goblin',    expLv: 1, expHp: 5 },
  { id: 0x01, name: 'Carbuncle', expLv: 1, expHp: 7 },
  { id: 0x02, name: 'Eye Fang',  expLv: 1, expHp: 8 },
  { id: 0x03, name: 'Blue Wisp', expLv: 2, expHp: 10 },
];

for (const t of testCases) {
  const s = readMonsterStats(t.id);
  const sprite = extractSprite(t.id);
  const dims = sprite ? `${sprite.cols}x${sprite.rows}` : 'BOSS';
  const lvOk = s.level === t.expLv ? '✓' : '✗';
  const hpOk = s.hp === t.expHp ? '✓' : '✗';
  console.log(`  ${t.name}: Lv=${s.level}${lvOk} HP=${s.hp}${hpOk} ATK=${s.atk} DEF=${s.def} sprite=${dims} (${sprite?.raw.length} bytes)`);
}

// Verify Eye Fang first 16 bytes match PPU capture
const efSprite = extractSprite(0x02);
const efPpuFirst16 = [0x00,0x0D,0x01,0x00,0x04,0x03,0x00,0x01,0x00,0x0E,0x01,0x00,0x00,0x00,0x00,0x00];
const efMatch = efPpuFirst16.every((b, i) => b === efSprite.raw[i]);
console.log(`  Eye Fang ROM↔PPU match: ${efMatch ? '✓' : '✗'}`);

// ── COUNT UNIQUE SPRITES ───────────────────────────────────────────
const spriteKeys = new Set();
let extractable = 0, failed = 0;
for (let id = 0; id <= 0xC2; id++) {
  const sprite = extractSprite(id);
  if (sprite) { extractable++; spriteKeys.add(`${sprite.catIdx}_${sprite.gfxId}`); }
  else failed++;
}
for (let id = 0xCC; id <= 0xE9; id++) {
  const sprite = extractSprite(id);
  if (sprite) { extractable++; spriteKeys.add(`${sprite.catIdx}_${sprite.gfxId}`); }
  else failed++;
}
console.log(`\n  Extractable: ${extractable} (${spriteKeys.size} unique sprites), failed: ${failed}`);

// ── BUILD PALETTE MAP ──────────────────────────────────────────────
const palMap = buildPaletteMap();
console.log(`\n  Palette map: ${palMap.size} monsters have palette data`);

// ── GENERATE OUTPUT FILES ──────────────────────────────────────────
console.log('\n=== GENERATING monster-sprites.js ===');

// Deduplicate sprites: multiple monsters share the same sprite data
const spriteCache = new Map(); // key → { cols, rows, raw }
const monsterSprites = new Map(); // monsterId → spriteKey

// Include all monster IDs: regular 0x00-0xC2 + boss 0xCC-0xE9
const allIds = [];
for (let id = 0; id <= 0xC2; id++) allIds.push(id);
for (let id = 0xCC; id <= 0xE9; id++) allIds.push(id);

for (const id of allIds) {
  const sprite = extractSprite(id);
  if (!sprite) continue;
  const key = `c${sprite.catIdx}_g${sprite.gfxId}`;
  if (!spriteCache.has(key)) {
    spriteCache.set(key, { cols: sprite.cols, rows: sprite.rows, raw: sprite.raw });
  }
  monsterSprites.set(id, key);
}

// Determine which sprites each file needs
const regularIds = [];
for (let id = 0; id <= 0xC2; id++) regularIds.push(id);
const bossIds = [];
for (let id = 0; id <= 0xC2; id++) {
  const attr = rom[GFX_TABLE + id];
  if (((attr & 0xE0) >> 5) === 6) bossIds.push(id); // regular monsters with boss-size sprites
}
for (let id = 0xCC; id <= 0xE9; id++) bossIds.push(id);

// Collect sprites needed by each file
const regularSprites = new Map();
const bossSprites = new Map();
for (const id of regularIds) {
  const key = monsterSprites.get(id);
  if (key && spriteCache.has(key)) regularSprites.set(key, spriteCache.get(key));
}
for (const id of bossIds) {
  const key = monsterSprites.get(id);
  if (key && spriteCache.has(key)) bossSprites.set(key, spriteCache.get(key));
}
console.log(`  ${regularSprites.size} regular + ${bossSprites.size} boss unique sprite sheets`);

// ── Helper to write a data file ────────────────────────────────────
function writeDataFile(path, label, sprites, monsterIds) {
  let out = `// ${label} — extracted from FF3 NES ROM\n`;
  out += `// Generated by tools/extract-monsters.js — do not edit manually\n`;
  out += `// Format: raw 2BPP tile bytes, cols×rows tile grid. Each tile = 16 bytes.\n\n`;

  for (const [key, data] of sprites) {
    const v = key.toUpperCase();
    out += `export const ${v}_COLS = ${data.cols};\n`;
    out += `export const ${v}_ROWS = ${data.rows};\n`;
    out += `export const ${v}_RAW = new Uint8Array([\n`;
    for (let t = 0; t < data.raw.length; t += 16) {
      const tile = data.raw.slice(t, t + 16);
      out += `  ${tile.map(b => '0x' + b.toString(16).padStart(2, '0')).join(',')},\n`;
    }
    out += `]);\n\n`;
  }

  // Palette table — shared between both files
  out += `export const PALETTE_TABLE = [\n`;
  const usedPals = new Set();
  for (const id of monsterIds) {
    const pData = palMap.get(id);
    if (pData) { usedPals.add(pData.pal0Idx); usedPals.add(pData.pal1Idx); }
  }
  const maxPal = usedPals.size ? Math.max(...usedPals) + 1 : 0;
  for (let i = 0; i < maxPal; i++) {
    const pal = readPalette(i);
    out += `  [${pal.map(c => '0x' + c.toString(16).padStart(2, '0')).join(', ')}], // ${i}\n`;
  }
  out += `];\n\n`;

  // Registry
  out += `export const MONSTER_REGISTRY = new Map([\n`;
  for (const id of monsterIds) {
    const spriteKey = monsterSprites.get(id);
    if (!spriteKey) continue;
    const pData = palMap.get(id);
    const v = spriteKey.toUpperCase();
    const p0 = pData ? pData.pal0Idx : 0;
    const p1 = pData ? pData.pal1Idx : 0;
    out += `  [0x${id.toString(16).padStart(2, '0')}, { raw: ${v}_RAW, cols: ${v}_COLS, rows: ${v}_ROWS, pal0: ${p0}, pal1: ${p1} }],\n`;
  }
  out += `]);\n`;

  writeFileSync(path, out);
  console.log(`  Written ${path} (${(out.length / 1024).toFixed(1)} KB)`);
}

writeDataFile(join(__dirname, '..', 'src', 'data', 'monster-sprites-rom.js'),
  'Regular monster sprite data (cats 0-5)', regularSprites, regularIds);

writeDataFile(join(__dirname, '..', 'src', 'data', 'boss-sprites-rom.js'),
  'Boss sprite data (includes cat 6 + any regular-size boss sprites)', bossSprites, bossIds);

// ── GENERATE UPDATED STATS ─────────────────────────────────────────
console.log('\n=== STATS COMPARISON (first 20 regulars) ===');
console.log('ID   | Name area        | Old ATK→ROM | Old DEF→ROM');

// Read current monsters.js to show comparison
for (let id = 0; id < 20; id++) {
  const s = readMonsterStats(id);
  const oldAtk = s.level + 4; // old estimate formula
  const oldDef = Math.max(1, Math.floor(s.level / 4));
  console.log(`0x${id.toString(16).padStart(2, '0')} | Lv${String(s.level).padStart(2)} HP${String(s.hp).padStart(5)} | ATK ${String(oldAtk).padStart(3)}→${String(s.atk).padStart(3)} | DEF ${String(oldDef).padStart(2)}→${String(s.def).padStart(2)}`);
}

// Write a stats update helper
let statsOut = '// Real ATK/DEF values from ROM (stat set table at bank $30)\n';
statsOut += '// Replace estimated atk/def in monsters.js with these values\n';
statsOut += '// Format: [id, atk, def]\n';
statsOut += 'export const REAL_STATS = [\n';
for (let id = 0; id <= 0xC2; id++) {
  const s = readMonsterStats(id);
  statsOut += `  [0x${id.toString(16).padStart(2, '0')}, ${s.atk}, ${s.def}],\n`;
}
for (let id = 0xCC; id <= 0xE9; id++) {
  const s = readMonsterStats(id);
  statsOut += `  [0x${id.toString(16).padStart(2, '0')}, ${s.atk}, ${s.def}],\n`;
}
statsOut += '];\n';
writeFileSync(join(__dirname, 'real-stats.js'), statsOut);
console.log(`\n  Stats written to tools/real-stats.js`);

console.log('\n=== DONE ===');
console.log('Next steps:');
console.log('  1. Update monsters.js with real ATK/DEF from tools/real-stats.js');
console.log('  2. Update game.js to use monster-sprites-rom.js instead of old monster-sprites.js');
console.log('  3. Add per-tile palette assignment (default all-pal0 for now)');
console.log('  4. Visual verification in-game');
