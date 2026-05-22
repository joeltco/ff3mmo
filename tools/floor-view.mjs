#!/usr/bin/env node
// Terminal dungeon viewer — renders a procedurally-generated cave floor as an
// ASCII grid, marks the entrance + exit, and flags connectivity (passable tiles
// the player CANNOT reach from the entrance show as `!`). Built to iterate on
// floor layout/renovation without launching the game.
//
// Usage:
//   node tools/floor-view.mjs [floor] [seed] [count]
//     floor : 0-4   (default 0)
//     seed  : int   (default 1)
//     count : int   (default 1) — render this many consecutive seeds
//   node tools/floor-view.mjs 0 1 5      # floor 0, seeds 1..5
//   FF3_ROM=/path/to.nes node tools/floor-view.mjs 0 7

import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { generateFloor } from '../src/dungeon-generator.js';

// ── Locate the ROM (env → repo root → ~/roms) ──────────────────────────────
function findRom() {
  const candidates = [
    process.env.FF3_ROM,
    join(process.cwd(), 'Final Fantasy III (Japan).nes'),
    join(os.homedir(), 'roms', 'ff3-jp.nes'),
  ].filter(Boolean);
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch { /* ignore */ } }
  console.error('ROM not found. Set FF3_ROM=/path/to/ff3.nes or place it at repo root / ~/roms/ff3-jp.nes');
  process.exit(1);
}
const rom = new Uint8Array(fs.readFileSync(findRom()));

// ── Tile → glyph (cave tileset 0) ──────────────────────────────────────────
const GLYPH = {
  0x30: '.',   // floor (walkable)
  0x09: ',',   // bones / skeleton (walkable decoration)
  0x00: '#',   // ceiling (wall)
  0x01: '%',   // rocky wall
  0x44: '+',   // false ceiling (secret passage — passable)
  0x5f: ' ',   // fill void (black)
  0x7c: 'C',   // chest
  0x73: '>',   // stairs down (exit)
  0x42: 'n',   // stair arch
  0x03: '^',   // entrance arch
  0x68: 'E',   // exit-prev (entry tile)
  0x6a: 'e',   // passage entry (deeper floors)
  0x41: ':',   // passage
  0x49: ';',   // passage bottom
  0x74: 'T',   // trap hole (usually swapped to floor before return)
  0x04: '~',   // water center
  0x08: '~',   // water edge
};
// Tiles the player can walk on (for connectivity flood-fill).
const PASS = new Set([0x30, 0x09, 0x41, 0x49, 0x44, 0x73, 0x42, 0x68, 0x6a, 0x60]);

function glyph(t) { return GLYPH[t] ?? t.toString(16).padStart(2, '0')[0]; }

// ── Connectivity: reachable passable tiles from the entrance ───────────────
function reachable(tm, entranceX, entranceY) {
  const seen = new Uint8Array(1024);
  const q = [];
  const push = (x, y) => {
    if (x < 0 || x > 31 || y < 0 || y > 31) return;
    const i = y * 32 + x;
    if (!seen[i] && PASS.has(tm[i])) { seen[i] = 1; q.push(i); }
  };
  for (let dy = 0; dy <= 4; dy++) push(entranceX, entranceY + dy);
  while (q.length) { const i = q.pop(); const x = i % 32, y = (i - x) / 32; push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1); }
  return seen;
}

function render(floor, seed) {
  const r = generateFloor(rom, floor, seed);
  const tm = r.tilemap;
  const seen = reachable(tm, r.entranceX, r.entranceY);

  let chests = 0, bones = 0, floorTiles = 0, stairsAt = -1;
  for (let i = 0; i < 1024; i++) {
    if (tm[i] === 0x7c) chests++;
    if (tm[i] === 0x09) bones++;
    if (tm[i] === 0x30) floorTiles++;
    if (tm[i] === 0x73 && stairsAt < 0) stairsAt = i;
  }
  const exitOk = stairsAt >= 0 && seen[stairsAt];

  console.log(`\n── floor ${floor}  seed ${seed}  ──  chests=${chests} skeletons=${bones} floor=${floorTiles}  exit ${exitOk ? 'REACHABLE' : 'UNREACHABLE'}`);
  console.log('   ' + Array.from({ length: 32 }, (_, x) => (x % 10)).join(''));
  for (let y = 0; y < 32; y++) {
    let row = '';
    for (let x = 0; x < 32; x++) {
      const i = y * 32 + x;
      let g = glyph(tm[i]);
      // entrance marker
      if (x === r.entranceX && y === r.entranceY) g = 'I';
      // unreachable passable tile → `!`
      else if (PASS.has(tm[i]) && !seen[i]) g = '!';
      row += g;
    }
    console.log(String(y).padStart(2, ' ') + ' ' + row);
  }
}

const floor = parseInt(process.argv[2] ?? '0', 10);
const seed0 = parseInt(process.argv[3] ?? '1', 10);
const count = parseInt(process.argv[4] ?? '1', 10);
for (let s = seed0; s < seed0 + count; s++) render(floor, s);
console.log('\nlegend: . floor  , bones  # ceiling  % rock  + secret-pass  C chest  > exit  n arch  ^ entrance-arch  E/e entry  : ; passage  ~ water  I=entrance  !=unreachable\n');
