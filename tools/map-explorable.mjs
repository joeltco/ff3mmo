#!/usr/bin/env node
// map-explorable.mjs — can the player actually walk every map, and get back out?
//
// "The maps are in" is true: geometry, tilesets, collision, doors and overworld
// entrances all come from ROM generically. Explorable is a stronger claim, and
// this is what checks it:
//
//   spawn    — the entrance tile the player lands on is standable
//   exit     — the map has at least one way back (door, exit-prev, or mapExit)
//   floodfill— the walkable region reachable FROM the entrance actually contains
//              the map's doors, so a map isn't "fine" on paper while its exit
//              sits behind a wall
//
// Collision mirrors `map-renderer.js#isPassable` rather than approximating it.
// Guessing that rule is how an earlier tool spawned test parties inside solid
// rock and recorded four clean, silent, worthless runs (see map-trigger-dump).
//
//   node tools/map-explorable.mjs              # problems only
//   node tools/map-explorable.mjs --all        # every reachable map
//   node tools/map-explorable.mjs --json

import fs from 'node:fs';
import { loadWorldMap } from '../src/world-map-loader.js';
import { loadMap, processTriggerTiles } from '../src/map-loader.js';

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));
const args = process.argv.slice(2);
const SHOW_ALL = args.includes('--all');
const AS_JSON  = args.includes('--json');
const W = 32;

/**
 * Mirrors `map-renderer.js#isPassable` (line 475). Kept in the same order as
 * the original so a future divergence is easy to spot by reading them together.
 * `loadMap` has already run `processTriggerTiles`, which REWRITES the tilemap,
 * so trigger lookups must come from the returned triggerMap, not from tile ids.
 */
function passable(r, x, y) {
  if (x < 0 || x >= W || y < 0 || y >= W) return false;
  if (x === r.entranceX && y === r.entranceY) return true;
  const trig = r.triggerMap.get(`${x},${y}`);
  if (trig) return trig.type === 1 || trig.type === 4;
  const mid = r.tilemap[y * W + x];
  const m = mid < 128 ? mid : mid & 0x7F;
  const c = r.collision[m];
  if (c & 0x80) {
    const t = (r.collisionByte2[mid] >> 4) & 0x0F;
    return t === 0 || t === 4 || t === 5;
  }
  return (c & 0x07) !== 3;
}

/** Tiles reachable on foot from (sx,sy). */
function flood(r, sx, sy) {
  const seen = new Set();
  if (!passable(r, sx, sy)) return seen;
  const q = [[sx, sy]];
  seen.add(sy * W + sx);
  while (q.length) {
    const [x, y] = q.pop();
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const nx = x + dx, ny = y + dy;
      const k = ny * W + nx;
      if (seen.has(k) || !passable(r, nx, ny)) continue;
      seen.add(k); q.push([nx, ny]);
    }
  }
  return seen;
}

function inspect(mapId) {
  let r;
  try { r = loadMap(rom, mapId); } catch (e) { return { mapId, error: String(e.message || e) }; }
  // TWO independent exit mechanisms, and only one lives in the tilemap.
  //
  //   1. placeholder tiles $70-$77 → triggerMap type 1, dest via entranceData.
  //   2. ANY metatile whose collision byte has bit 7 set, kind in the high
  //      nibble of collisionByte2 — `map-renderer.js#isPassable`'s first
  //      branch. exit_prev (0) walks you back out the way you came; 4/5 are
  //      doors.
  //
  // Counting only (1) reported 50 maps as having no exit at all, including the
  // Ur magic shop that every session walks out of. Town exits are mechanism 2.
  const doors = [];
  for (const [key, t] of r.triggerMap) {
    if (t.type !== 1 && t.type !== 4) continue;
    const [x, y] = key.split(',').map(Number);
    doors.push({ x, y, kind: 'tile', trigId: t.trigId, dest: r.entranceData[t.trigId] | 0 });
  }
  for (let i = 0; i < r.tilemap.length; i++) {
    const mid = r.tilemap[i];
    const x0 = i % W, y0 = (i - x0) / W;
    if (r.triggerMap.has(`${x0},${y0}`)) continue;   // already counted above
    // NOT `if (mid >= 0x60) continue`. That looks like "skip placeholder
    // triggers" and instead skipped $68 — which IS the exit in town interiors
    // (map 3, the Ur magic shop, has no $70-$77 door at all, only $68). $60+
    // ids that aren't placeholders are ordinary metatiles, and the trigger bit
    // lives in their COLLISION byte, not in the id.
    if (!(r.collision[mid & 0x7F] & 0x80)) continue;
    const t = (r.collisionByte2[mid] >> 4) & 0x0F;
    if (t !== 0 && t !== 4 && t !== 5) continue;     // not an exit-ish trigger
    // exit_prev returns to the previous map — always a live way out, and it
    // has no entranceData slot, so `dest` is deliberately -1 (present, unknown)
    // rather than 0 (dead).
    doors.push({ x: x0, y: y0, kind: t === 0 ? 'exit_prev' : 'door', trigId: null, dest: -1 });
  }
  const spawnOk = passable(r, r.entranceX, r.entranceY);
  const reach = flood(r, r.entranceX, r.entranceY);
  const reachableDoors = doors.filter(d => {
    // A door is usable if the player can stand on it or beside it.
    if (reach.has(d.y * W + d.x)) return true;
    return [[0, 1], [0, -1], [1, 0], [-1, 0]]
      .some(([dx, dy]) => reach.has((d.y + dy) * W + (d.x + dx)));
  });
  const liveDoors = reachableDoors.filter(d => d.dest !== 0);   // -1 (exit_prev) counts as live
  return {
    mapId, spawnOk,
    walkable: reach.size,
    doors: doors.length,
    reachableDoors: reachableDoors.length,
    liveDoors: liveDoors.length,
    mapExit: r.mapExit,
    dests: [...new Set(liveDoors.map(d => d.dest).filter(d => d > 0))],
  };
}

// ── Reachable set: overworld entrances, then doors, transitively ───────────
const world = loadWorldMap(rom, 0);
const seeds = new Set();
for (let i = 0; i < world.tilemap.length; i++) {
  const m = world.tilemap[i] & 0x7F;
  const p = world.tileProps[m];
  if (!p || !(p.byte1 & 0x80)) continue;
  const dest = world.entranceTable[p.byte2 & 0x3F];
  if (dest) seeds.add(dest);
}
const reachable = new Set(seeds);
const queue = [...seeds];
const report = new Map();
while (queue.length) {
  const id = queue.shift();
  const info = inspect(id);
  report.set(id, info);
  for (const d of info.dests || []) {
    if (reachable.has(d)) continue;
    reachable.add(d); queue.push(d);
  }
}

// ── World-map gate ─────────────────────────────────────────────────────────
// Everything above reads the ROM, so it is blind to artificial gates the GAME
// adds on top — and for most of this project's life the world map had exactly
// one: a boulder hard-blocking tile (95,44), which sealed Ur's valley off from
// all 26 other entrances.
//
// So this walks the world with the REAL `WorldMapRenderer.prototype.isPassable`
// rather than a reimplementation of it. That is the whole point: a copy would
// keep reporting the world as open after someone restored the choke. The method
// only touches `this.data`, so it runs headless against a stub — no canvas.
const { WorldMapRenderer } = await import('../src/world-map-renderer.js');
const stub = { data: world };
const wPass = (x, y) => WorldMapRenderer.prototype.isPassable.call(stub, x, y);
const wTrig = (x, y) => WorldMapRenderer.prototype.getTriggerAt.call(stub, x, y);

const WSIZE = world.mapWidth;
// Seed at Ur, where the player actually starts.
let seed = null;
for (const [trigId, pos] of world.triggerPositions) {
  if (world.entranceTable[trigId] === 114) { seed = pos; break; }
}
const worldSeen = new Set();
const worldEntrances = new Set();
if (seed) {
  const q = [[seed.x, seed.y]];
  worldSeen.add(seed.y * WSIZE + seed.x);
  while (q.length) {
    const [x, y] = q.pop();
    const t = wTrig(x, y);
    if (t && t.destMap) worldEntrances.add(t.destMap);
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const nx = ((x + dx) % WSIZE + WSIZE) % WSIZE;
      const ny = ((y + dy) % WSIZE + WSIZE) % WSIZE;
      const k = ny * WSIZE + nx;
      if (worldSeen.has(k) || !wPass(nx, ny)) continue;
      worldSeen.add(k); q.push([nx, ny]);
    }
  }
}
// Threshold from MEASUREMENT, not from a guess. With the choke lifted the
// player reaches 429 world tiles and 8 entrances on foot from Ur; with it
// restored, 30 tiles and 2 (Ur and the Altar Cave itself). Both numbers were
// taken by actually toggling the block in `world-map-renderer.js`.
//
// 8 rather than 27 because the rest of the world map is gated by TERRAIN, not
// by us — FF3 puts most of its continents behind a ship or airship. Lifting the
// choke opens everything reachable on foot; the remainder needs vehicles.
//
// 6 sits well above the choked value and below the open one, so restoring the
// choke fails this immediately without pinning the exact count as the world
// grows.
const WORLD_GATE_MIN = 6;
const worldOk = worldEntrances.size >= WORLD_GATE_MIN;

const rows = [...report.values()].sort((a, b) => a.mapId - b.mapId);
const problems = rows.filter(r => r.error || !r.spawnOk || r.walkable < 4 || r.liveDoors === 0);

if (AS_JSON) {
  console.log(JSON.stringify({ rows, problems }, null, 1));
} else {
  console.log(`reachable maps: ${rows.length}   (${seeds.size} direct from the overworld)`);
  console.log(`clean: ${rows.length - problems.length}   problems: ${problems.length}\n`);
  const show = SHOW_ALL ? rows : problems;
  console.log('mapId  spawn  walkable  doors(reach/live)  exit  issue');
  for (const r of show) {
    if (r.error) { console.log(`  ${String(r.mapId).padStart(3)}  LOAD FAILED — ${r.error}`); continue; }
    const issue = !r.spawnOk ? 'spawns in a wall'
      : r.walkable < 4 ? 'nowhere to walk'
      : r.liveDoors === 0 ? 'no live exit from spawn'
      : '';
    console.log(`  ${String(r.mapId).padStart(3)}  ${r.spawnOk ? ' ok  ' : 'WALL '}`
      + `  ${String(r.walkable).padStart(4)}      ${String(r.reachableDoors).padStart(2)}/${String(r.liveDoors).padStart(2)}`
      + `           ${String(r.mapExit).padStart(3)}  ${issue}`);
  }
  if (!SHOW_ALL && problems.length) console.log('\n(pass --all for every map)');
  console.log(`\nworld map on foot from Ur: ${worldSeen.size} tiles, `
    + `${worldEntrances.size} entrance(s) reachable  `
    + (worldOk ? `— ok (>= ${WORLD_GATE_MIN})` : `— FAIL, expected >= ${WORLD_GATE_MIN}`));
}
if (!worldOk) {
  console.error(`\n✗ world map is gated: only ${worldEntrances.size} entrance(s) reachable on foot from Ur.`);
  process.exit(1);
}
