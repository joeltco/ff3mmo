#!/usr/bin/env node
// clip-info.mjs — why did THIS map's room clip come out this shape?
//
// Prints the clip rectangle next to the numbers that produced it, plus an
// ASCII grid of the clipped area. Every trailing-tile investigation needs
// exactly this, and rebuilding it ad hoc is how a wrong diagnosis got filed:
// a throwaway script seeded the renderer from the RAW ROM ENTRANCE instead of
// the computed spawn and reported a room with one walkable tile.
//
// Seeds from the spawn the game actually uses (same helper map-shot uses).
//
//   node tools/clip-info.mjs 13
//   node tools/clip-info.mjs 13 --seed 3,11
//
// Legend:  .  walkable     #  drawn, not walkable     ~  fill tile
//          space = outside the clip (never painted)

import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

globalThis.document = { createElement: (t) => (t === 'canvas' ? createCanvas(1, 1) : {}) };

const { loadMap } = await import('../src/map-loader.js');
const { MapRenderer } = await import('../src/map-renderer.js');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const id = parseInt(args[0], 10);
const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));

const md = loadMap(rom, id);
if (md.tilemap[16 * 32 + 8] !== 0x32) {
  for (let i = 0; i < md.tilemap.length; i++) {
    if (md.tilemap[i] === 0x5B) md.tilemap[i] = 0x5D;
    if (md.tilemap[i] === 0x5C) md.tilemap[i] = 0x5E;
  }
}

// Mirrors src/map-loading.js#_calcSpawnY (same as tools/map-shot.mjs).
function calcSpawnY(m, ex, ey) {
  const at2 = (x, y) => m.tilemap[y * 32 + x];
  const collOf = (mid) => m.collision[mid < 128 ? mid : mid & 0x7F];
  if ((collOf(at2(ex, ey)) & 0x07) === 3) {
    for (let d = 1; d < 32; d++) { const ny = (ey - d + 32) % 32; if (at2(ex, ny) === 0x44) return ny; }
    for (let d = 1; d <= 16; d++) { const ny = ey + d; if (ny >= 32) break; const mid = at2(ex, ny);
      if (mid === m.fillTile) break; const c = collOf(mid);
      if ((c & 0x07) !== 3 && !(c & 0x80)) return ny; }
    for (let d = 1; d <= 16; d++) { const ny = ey - d; if (ny < 0) break; const mid = at2(ex, ny);
      if (mid === m.fillTile) break; const c = collOf(mid);
      if ((c & 0x07) !== 3 && !(c & 0x80)) return ny; }
    return ey;
  }
  const entMid = at2(ex, ey);
  const entM = entMid < 128 ? entMid : entMid & 0x7F;
  if (entMid === 0x44) return ey;
  if ((m.collision[entM] & 0x80) && ((m.collisionByte2[entM] >> 4) & 0x0F) === 0) {
    for (let d = 1; d <= 8; d++) { const ny = ey - d; if (ny < 0) break; if (at2(ex, ny) === 0x44) return ny; }
  }
  return ey;
}

let sx = md.entranceX, sy = calcSpawnY(md, md.entranceX, md.entranceY);
const seed = flag('seed', null);
if (seed) { const [a, b] = seed.split(',').map(Number); sx = a; sy = b; }

const r = new MapRenderer(md, sx, sy);
const c = r._roomClip;
const d = r._clipDiag || {};

console.log(`map ${id}  tileset ${md.tileset}  fill $${md.fillTile.toString(16)}`);
console.log(`ROM entrance (${md.entranceX},${md.entranceY})  ->  spawn (${sx},${sy})`);
if (!c) { console.log('roomClip: null — whole map is drawn'); process.exit(0); }

const L = c.x / 16, T = c.y / 16, R = (c.x + c.w) / 16, B = (c.y + c.h) / 16;
console.log(`roomClip: x ${L}..${R - 1}   y ${T}..${B - 1}   (${R - L} x ${B - T} tiles)`);
console.log(`room bbox: x ${d.rminX}..${d.rmaxX}   y ${d.rminY}..${d.rmaxY}`);
console.log(`bottom: phase1 ${d.bottomBeforeUnion} -> final ${B}   ` +
            `(rmaxY ${d.rmaxY}, so rows ${d.rmaxY + 1}..${B - 1} are BELOW the room` +
            `${B - 1 > d.rmaxY ? ' <-- candidate trailing tiles' : ''})`);
console.log(`enclosed room? ${d.isEnclosedRoom}   ` +
            `[fill is void ${d.fillIsVoid}, room ${d.roomSize} tiles (<=60), ` +
            `${(d.roomFraction ?? 0).toFixed(2)} of ${d.totalWalkable} walkable (<0.50)]`);

console.log('\n   ' + [...Array(32).keys()].map(i => i % 10).join(''));
for (let y = 0; y < 32; y++) {
  let line = '';
  for (let x = 0; x < 32; x++) {
    if (x < L || x >= R || y < T || y >= B) { line += ' '; continue; }
    line += r.isPassable(x, y, 0) ? '.' : (md.tilemap[y * 32 + x] === md.fillTile ? '~' : '#');
  }
  if (line.trim()) console.log(String(y).padStart(2) + ' ' + line);
}
