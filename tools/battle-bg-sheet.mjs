#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// ⛔⛔⛔  RENDER IT AND LOOK.  ⛔⛔⛔
//
// battle-bg-sheet.mjs — the BACKDROP CATALOG. All 24 strips FF3 ships, drawn
// through the shipped decoder, each labelled with everywhere this game uses it.
//
// ⛔ These strips are ff3mmo's AMBIENT ART LAYER — HUD top box, dungeon loading
// screen, title screen. NOT a battle-screen backdrop. See docs/BATTLE-BACKDROPS.md.
//
//   node tools/battle-bg-sheet.mjs out.png
//
// Usage is resolved through `resolveBackdrop` — the same function the game calls
// — so the catalog cannot claim a placement the game would not make.
import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));
const outPath = process.argv[2] || 'battle-bg-sheet.png';

globalThis.window = { addEventListener() {} };
globalThis.document = { createElement: () => createCanvas(8, 8), addEventListener() {} };

const { getBattleBg, battleBgIdForWorldProps, WORLD_TILE_PROPS } = await import('../src/battle-bg.js');
const { BACKDROPS, BATTLE_BG_COUNT, resolveBackdrop } = await import('../src/data/backdrops.js');
const { DUNGEONS } = await import('../src/data/dungeons.js');
const { loadWorldMap } = await import('../src/world-map-loader.js');

// ── Where each backdrop is actually used ────────────────────────────────────
const maps = new Map();          // id -> [mapId]
for (let mapId = 0; mapId < 512; mapId++) {
  const id = resolveBackdrop(rom, { onWorldMap: false, mapId });
  if (!maps.has(id)) maps.set(id, []);
  maps.get(id).push(mapId);
}

const floors = new Map();        // id -> ['altar f0', ...]
for (const d of DUNGEONS) {
  for (let f = 0; f < d.floors; f++) {
    const id = resolveBackdrop(rom, { onWorldMap: false, mapId: d.base + f });
    if (!floors.has(id)) floors.set(id, []);
    floors.get(id).push(`${d.id} f${f}${f === d.floors - 1 ? '*' : ''}`);
  }
}

// World tiles that SELECT each backdrop, and how many of them are on the map.
//
// ⛔ ALL THREE world tables, not just world 0. Scanning only world 0 makes
// backdrop 18 (undersea) look like an orphan, which would put this catalog at
// odds with `check-battle-bg` — that gate pins the orphan set to exactly {6}
// across all three. Two readers of one table disagreeing is how a wrong answer
// gets a second opinion that agrees with it.
const worldTiles = new Map(), worldCount = new Map(), otherWorlds = new Map();
for (let world = 0; world < WORLD_TILE_PROPS.length; world++) {
  const base = WORLD_TILE_PROPS[world];
  for (let t = 0; t < 128; t++) {
    const props = { byte1: rom[base + t * 2], byte2: rom[base + t * 2 + 1] };
    if (props.byte1 & 0x80) continue;                      // warp: byte 2 is a destination
    const id = battleBgIdForWorldProps(props);
    if (world === 0) {
      if (!worldTiles.has(id)) worldTiles.set(id, []);
      worldTiles.get(id).push(t);
    } else {
      if (!otherWorlds.has(id)) otherWorlds.set(id, new Set());
      otherWorlds.get(id).add(world);
    }
  }
}
// How a placed tile is REACHED — foot, or only by a vehicle. The ROM's own mask
// table at $C6CD: blocked iff every mask bit is set in byte 1.
const MODE_MASKS = [['foot', 0x01], ['canoe', 0x03], ['ship', 0x02], ['mode3', 0x04], ['flight', 0x10]];
const reachBy = new Map();
{
  const w = loadWorldMap(rom, 0);
  const modes = new Map();
  for (let i = 0; i < w.tilemap.length; i++) {
    const p = w.tileProps[w.tilemap[i] & 0x7F];
    if (p.byte1 & 0x80) continue;
    const id = battleBgIdForWorldProps(p);
    worldCount.set(id, (worldCount.get(id) || 0) + 1);
    if (!modes.has(id)) modes.set(id, new Set());
    for (const [name, mask] of MODE_MASKS) if ((p.byte1 & mask) !== mask) modes.get(id).add(name);
  }
  for (const [id, set] of modes) reachBy.set(id, set.size ? [...set].join('/') : 'unreachable');
}

// ── Sheet ───────────────────────────────────────────────────────────────────
// ⛔ The usage line is the POINT of this sheet — it is what says a strip is a
// lake and not a mountain. An earlier version clipped it at the canvas edge,
// which is the same as not printing it. Wrap it; size the sheet to the text.
const SCALE = 2, W = 256 * SCALE, PAD = 10, GAP = 12;
const H = 32 * SCALE;
const CHAR_W = 6.62, MAXW = 118;                 // 11px monospace
const SHEET_W = Math.max(W, Math.ceil(MAXW * CHAR_W)) + PAD * 2;

function wrap(text, cols) {
  const out = [];
  for (const chunk of text.split('   ·   ')) {
    let line = '';
    for (const word of chunk.split(' ')) {
      if (line && (line + ' ' + word).length > cols) { out.push(line); line = '   ' + word; }
      else line = line ? line + ' ' + word : word;
    }
    if (line) out.push(line);
  }
  return out;
}

const rows = [];
for (let id = 0; id < BATTLE_BG_COUNT; id++) {
  const row = BACKDROPS[id];
  const bits = [];
  const wt = worldTiles.get(id);
  // ⛔ SAY WHO CAN STAND THERE. A tile you cannot stand on can never be the tile
  // a fight starts from, so its byte 2 is dead — and reading the art without
  // checking this is how backdrop 4 got called `mountain` when it is a LAKE.
  if (wt) bits.push(`world tiles ${wt.map((t) => '$' + t.toString(16).padStart(2, '0')).join(' ')}` +
    ` — ${worldCount.get(id) || 0} placed, reached by ${reachBy.get(id) || 'NOTHING'}`);
  const fl = floors.get(id);
  if (fl) bits.push(`dungeon: ${fl.join(' ')}`);
  const m = maps.get(id) || [];
  if (m.length) bits.push(`${m.length} map${m.length === 1 ? '' : 's'}: ${m.slice(0, 14).join(',')}${m.length > 14 ? `,+${m.length - 14}` : ''}`);
  const ow = otherWorlds.get(id);
  if (ow) bits.push(`world ${[...ow].join('/')} terrain (⚠ stride-derived, unmeasured)`);
  const lines = bits.length ? wrap(bits.join('   ·   '), MAXW)
                            : ['⛔ ORPHAN — no map and no world tile in this cartridge selects it'];
  rows.push({ id, row, lines });
}

const HEAD = 20;
const rowH = (r) => HEAD + r.lines.length * 13 + 4 + H + GAP;
const sheet = createCanvas(SHEET_W, rows.reduce((a, r) => a + rowH(r), 0) + PAD * 2);
const ctx = sheet.getContext('2d');
ctx.fillStyle = '#0e0e13';
ctx.fillRect(0, 0, sheet.width, sheet.height);
ctx.imageSmoothingEnabled = false;
ctx.textBaseline = 'top';

let y = PAD;
for (const r of rows) {
  const { bgCanvas } = getBattleBg(rom, r.id);
  ctx.font = 'bold 14px monospace';
  ctx.fillStyle = r.row.biome ? '#9ee7a0' : '#e8e8f0';
  ctx.fillText(`${String(r.id).padStart(2)}  ${r.row.name}${r.row.biome ? `   [overworld biome: ${r.row.biome}]` : ''}`, PAD, y + 2);
  ctx.font = '11px monospace';
  ctx.fillStyle = r.lines[0].startsWith('⛔') ? '#e07a7a' : '#9aa0b4';
  r.lines.forEach((ln, i) => ctx.fillText(ln, PAD, y + HEAD + i * 13));
  ctx.drawImage(bgCanvas, PAD, y + HEAD + r.lines.length * 13 + 4, W, H);
  y += rowH(r);
}

fs.writeFileSync(outPath, sheet.toBuffer('image/png'));
console.log(`wrote ${outPath} — ${BATTLE_BG_COUNT} backdrops`);
console.log('  * = boss floor. Green name = selected by overworld terrain.');
for (let id = 0; id < BATTLE_BG_COUNT; id++) {
  const row = BACKDROPS[id];
  const m = (maps.get(id) || []).length, wt = (worldTiles.get(id) || []).length;
  const ow = otherWorlds.get(id);
  console.log(`  ${String(id).padStart(2)}  ${row.name.padEnd(17)} ${row.biome ? `biome:${row.biome}`.padEnd(15) : ''.padEnd(15)} ${String(m).padStart(3)} maps  ${wt ? `${String(worldCount.get(id) || 0).padStart(5)} tiles via ${reachBy.get(id) || 'NOTHING'}` : ''}${ow ? `  (+world ${[...ow].join('/')} unmeasured)` : ''}`);
}
