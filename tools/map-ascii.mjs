#!/usr/bin/env node
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
import { loadMap } from '../src/map-loader.js';

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));
const W = 32;
const mapId = parseInt(process.argv[2], 10);
const r = loadMap(rom, mapId);

function calcSpawnY(m, ex, ey) {
  const eMid = m.tilemap[ey * 32 + ex];
  const eColl = m.collision[eMid < 128 ? eMid : eMid & 0x7F];
  if ((eColl & 0x07) === 3) {
    for (let dy = 1; dy < 32; dy++) { const ny = (ey - dy + 32) % 32; if (m.tilemap[ny * 32 + ex] === 0x44) return ny; }
    for (let dy = 1; dy <= 16; dy++) { const ny = ey + dy; if (ny >= 32) break; const mid = m.tilemap[ny * 32 + ex];
      if (mid === m.fillTile) break; const mm = mid < 128 ? mid : mid & 0x7F;
      if ((m.collision[mm] & 0x07) !== 3 && !(m.collision[mm] & 0x80)) return ny; }
    for (let dy = 1; dy <= 16; dy++) { const ny = ey - dy; if (ny < 0) break; const mid = m.tilemap[ny * 32 + ex];
      if (mid === m.fillTile) break; const mm = mid < 128 ? mid : mid & 0x7F;
      if ((m.collision[mm] & 0x07) !== 3 && !(m.collision[mm] & 0x80)) return ny; }
    return ey;
  }
  const entMid = m.tilemap[ey * 32 + ex];
  const entM = entMid < 128 ? entMid : entMid & 0x7F;
  if (entMid === 0x44) return ey;
  if ((m.collision[entM] & 0x80) && ((m.collisionByte2[entM] >> 4) & 0x0F) === 0) {
    for (let dy = 1; dy <= 8; dy++) { const ny = ey - dy; if (ny < 0) break; if (m.tilemap[ny * 32 + ex] === 0x44) return ny; }
  }
  return ey;
}

function passable(x, y) {
  if (x < 0 || x >= W || y < 0 || y >= W) return false;
  if (x === r.entranceX && y === r.entranceY) return true;
  const t = r.triggerMap.get(`${x},${y}`);
  if (t) return t.type === 1 || t.type === 4;
  const mid = r.tilemap[y * W + x];
  const c = r.collision[mid < 128 ? mid : mid & 0x7F];
  if (c & 0x80) { const tt = (r.collisionByte2[mid] >> 4) & 0x0F; return tt === 0 || tt === 4 || tt === 5; }
  return (c & 0x07) !== 3;
}

const sx = r.entranceX, sy = calcSpawnY(r, r.entranceX, r.entranceY);
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
