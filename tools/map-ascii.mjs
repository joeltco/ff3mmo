#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// ⛔⛔⛔  DO NOT HALF-ASS THE DATA PULL.  ⛔⛔⛔
//
// A ROM record has N FIELDS. If you use fewer than N, YOU HAVE NOT READ IT —
// you have guessed while holding the answer. This banner exists because that
// happened over and over in one day:
//
//   * FF3's NPC record is {id, x, y, FLAGS}. The flags byte was DISASSEMBLED
//     (bits 2-3 = FACING, bits 4-7 = MOVEMENT) and then DROPPED on the floor,
//     so ten Ur townsfolk shipped frozen in "random spots" facing wrong.
//   * Cid took THREE releases and Joel pointing at the tile — while
//     `npc-dump.mjs 12` had printed `id $2c @(6,23) ... DRAWN` the whole time.
//   * `$67` was called the "black magic sign" without checking its ATTRIBUTE
//     palette. It is the same star on pal1, the TREE/WOOD palette. Green
//     corners shipped.
//   * Characters were identified from `npcId + 0x202` instead of by RENDERING
//     THE SPRITE — which put Cid's line on the Castle Sasune gate guard.
//   * `check-shops` asked `findShopAtCounter` for the shop's OWN coords, so it
//     agreed with itself wherever the counter pointed.
//   * "0 of 28 bundles match" was a `+0x10` applied twice. SELF-TEST THE
//     INSTRUMENT BEFORE BELIEVING A NEGATIVE.
//
// BEFORE YOU SAY "DONE", ANSWER THIS OUT LOUD:
//   List every field/byte/column of the record you just read. Point at the line
//   of code that CONSUMES each one. If any field is unconsumed, you are NOT
//   done — wire it or say plainly which one you dropped and why.
//
// AND: RENDER IT AND LOOK. `map-png --grid --box`, `tileset-sheet.mjs`,
// `npc-sheet-ff3.mjs`, `npc-cast.cjs`. "The code looks right" is not a check.
// ═══════════════════════════════════════════════════════════════════════════
// map-ascii.mjs — print one map as a grid, so "no live exit from spawn" can be
// looked at instead of inferred.
//
//   node tools/map-ascii.mjs 180
//
// Legend:
//   S spawn (ex, _calcSpawnY(ex,ey))    @ ROM entrance, if different
//   + walkable AND reachable from spawn
//   . walkable but NOT reachable from spawn (another room on a shared tilemap)
//   # solid
//   W exit-to-world (collision trigType 1)     P exit_prev (trigType 0)
//   D door (trigType 4/5, or tilemap $70-$77)  C chest/treasure   e event

import fs from 'node:fs';

// Use the REAL MapRenderer for passability. This tool used to reimplement it,
// and the copy drifted: after v1.7.944 made event tiles passable, the game
// reported map 10 as 196 reachable tiles while this printed 31. A map viewer
// that disagrees with the game is worse than no viewer.
const _ctx = {
  createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4), width: w, height: h }),
  putImageData() {}, drawImage() {}, fillRect() {}, clearRect() {},
  save() {}, restore() {}, translate() {}, scale() {}, beginPath() {}, rect() {}, clip() {},
};
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => _ctx }) };

const { loadMap } = await import('../src/map-loader.js');
const { MapRenderer } = await import('../src/map-renderer.js');
const { calcSpawnY } = await import('./lib/spawn.mjs');

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));
const W = 32;
const mapId = parseInt(process.argv[2], 10);
const r = loadMap(rom, mapId);

// Spawn comes from tools/lib/spawn.mjs — the ONE copy, which mirrors
// src/map-loading.js#_calcSpawnY. This file used to carry its own BOUNDED
// variant (doorway search capped at 3 tiles, floor scans `break`ing after one
// step). That is the REJECTED proposal, not the shipped rule, so this viewer
// reported map 2 as spawning at (8,31) into a 5-tile dead end when the game
// actually spawns at (8,21) with 28 tiles. A viewer that disagrees with the
// game is worse than no viewer — the header of this file already said so.
const sx = r.entranceX, sy = calcSpawnY(r, r.entranceX, r.entranceY);
const _renderer = new MapRenderer(r, sx, sy);
const passable = (x, y) => (x >= 0 && x < W && y >= 0 && y < W) && _renderer.isPassable(x, y);
const reach = new Set();
if (passable(sx, sy)) {
  const q = [[sx, sy]]; reach.add(sy * W + sx);
  while (q.length) { const [x, y] = q.pop();
    for (const [dx, dy] of [[0,1],[0,-1],[1,0],[-1,0]]) { const nx = x+dx, ny = y+dy, k = ny*W+nx;
      if (reach.has(k) || !passable(nx, ny)) continue; reach.add(k); q.push([nx, ny]); } }
}

function glyph(x, y) {
  if (x === sx && y === sy) return 'S';
  const t = r.triggerMap.get(`${x},${y}`);
  if (t) return t.type === 2 ? 'C' : t.type === 0 ? 'e' : 'D';
  const mid = r.tilemap[y * W + x];
  const c = r.collision[mid < 128 ? mid : mid & 0x7F];
  if (c & 0x80) {
    const tt = (r.collisionByte2[mid] >> 4) & 0x0F;
    if (tt === 0) return 'P';
    if (tt === 1) return 'W';
    if (tt === 4 || tt === 5) return 'D';
    return '#';
  }
  if (x === r.entranceX && y === r.entranceY) return '@';
  return reach.has(y * W + x) ? '+' : ((c & 0x07) !== 3 ? '.' : '#');
}

console.log(`map ${mapId}  tileset ${r.tileset}  ROM entrance (${r.entranceX},${r.entranceY}) -> spawn (${sx},${sy})`);
console.log(`entranceData: ${Array.from(r.entranceData).slice(0, 8).join(',')}   reachable tiles: ${reach.size}`);
console.log('    ' + Array.from({ length: W }, (_, i) => (i % 10)).join(''));
for (let y = 0; y < W; y++) {
  let row = '';
  for (let x = 0; x < W; x++) row += glyph(x, y);
  console.log(String(y).padStart(3) + ' ' + row);
}
