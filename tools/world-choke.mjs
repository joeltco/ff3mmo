#!/usr/bin/env node
// world-choke.mjs — find the articulation points on the world map, i.e. the
// single tiles that, if blocked, split Ur's reachable region in two.
//
// Uses the REAL `WorldMapRenderer.prototype.isPassable` (same reason
// map-explorable.mjs does): a reimplementation would keep reporting the world
// as open after someone restores a boulder.
//
//   node tools/world-choke.mjs             # list every articulation point
//   node tools/world-choke.mjs --map 88 32 112 64   # ASCII a region

import fs from 'node:fs';

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));

const { loadWorldMap } = await import('../src/world-map-loader.js');
const { WorldMapRenderer } = await import('../src/world-map-renderer.js');

const world = loadWorldMap(rom, 0);
const stub = { data: world };
const pass = (x, y) => WorldMapRenderer.prototype.isPassable.call(stub, x, y);
const W = world.mapWidth;
const key = (x, y) => y * W + x;

// Ur's entrance is where the player actually stands.
let seed = null;
for (const [trigId, pos] of world.triggerPositions) {
  if (world.entranceTable[trigId] === 114) { seed = pos; break; }
}
if (!seed) { console.error('could not locate Ur on the world map'); process.exit(1); }

// Every overworld entrance, so we can say what each side of a cut costs.
const entrances = new Map();               // key -> destination map id
for (const [trigId, pos] of world.triggerPositions) {
  const dest = world.entranceTable[trigId];
  if (dest) entrances.set(key(pos.x, pos.y), dest);
}

function flood(blocked) {
  const seen = new Set([key(seed.x, seed.y)]);
  const q = [[seed.x, seed.y]];
  while (q.length) {
    const [x, y] = q.pop();
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const nx = ((x + dx) % W + W) % W, ny = ((y + dy) % W + W) % W;
      const k = key(nx, ny);
      if (seen.has(k) || k === blocked) continue;
      if (!pass(nx, ny)) continue;
      seen.add(k); q.push([nx, ny]);
    }
  }
  return seen;
}

const base = flood(-1);
const baseEntrances = [...entrances].filter(([k]) => base.has(k)).map(([, d]) => d);

const args = process.argv.slice(2);
if (args[0] === '--map') {
  const [x0, y0, x1, y1] = args.slice(1, 5).map(Number);
  console.log(`region (${x0},${y0})-(${x1},${y1})   # = wall  . = reachable  , = walkable-but-cut-off  E = entrance`);
  let head = '     ';
  for (let x = x0; x <= x1; x++) head += (x % 10);
  console.log(head);
  for (let y = y0; y <= y1; y++) {
    let row = String(y).padStart(4) + ' ';
    for (let x = x0; x <= x1; x++) {
      const k = key(x, y);
      row += entrances.has(k) ? 'E' : !pass(x, y) ? '#' : base.has(k) ? '.' : ',';
    }
    console.log(row);
  }
  process.exit(0);
}

console.log(`Ur entrance at (${seed.x},${seed.y})`);
console.log(`world open from Ur: ${base.size} tiles, ${baseEntrances.length} entrances\n`);
console.log('articulation points (blocking this ONE tile splits the region):');
console.log('  tile        cuts off  entrances lost');

const cuts = [];
for (const k of base) {
  if (entrances.has(k)) continue;                 // never block a door itself
  const after = flood(k);
  const lost = base.size - after.size - 1;
  if (lost <= 0) continue;
  const lostDests = baseEntrances.filter(d => {
    const ek = [...entrances].find(([, dd]) => dd === d)?.[0];
    return ek != null && !after.has(ek);
  });
  cuts.push({ x: k % W, y: (k - k % W) / W, lost, lostDests });
}
cuts.sort((a, b) => a.lost - b.lost);
for (const c of cuts) {
  console.log(`  (${String(c.x).padStart(3)},${String(c.y).padStart(3)})   ${String(c.lost).padStart(5)}     ${c.lostDests.join(', ') || '(none)'}`);
}
if (!cuts.length) console.log('  (none — the region has no single-tile cut)');
