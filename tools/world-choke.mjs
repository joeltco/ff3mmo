#!/usr/bin/env node
// world-choke.mjs — find the articulation points on the world map, i.e. the
// single tiles that, if blocked, split Ur's reachable region in two.
//
// Uses the REAL `WorldMapRenderer.prototype.isPassable` (same reason
// map-explorable.mjs does): a reimplementation would keep reporting the world
// as open after someone restores a boulder.
//
//   node tools/world-choke.mjs             # list every articulation point
//   node tools/world-choke.mjs --ocean     # rank cuts by how much COAST they kill
//   node tools/world-choke.mjs --map 88 32 112 64   # ASCII a region
//
// `--ocean` is the one that matters for placing the choke boulder: a cut is
// only worth making if it seals the ocean while leaving the inland towns open.
// Ranking by tiles-removed (the default mode) does NOT answer that — the two
// biggest cuts on the map both zero the coast, but one costs 2 entrances and
// the other costs 6.

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
// Read through the REAL `getTriggerAt` rather than off `entranceTable`, for the
// same reason the flood uses the real `isPassable`: entrances the game switches
// off (`REMOVED_ENTRANCES`) must not show up here as things a cut can cost.
const entrances = new Map();               // key -> destination map id
for (const [, pos] of world.triggerPositions) {
  const t = WorldMapRenderer.prototype.getTriggerAt.call(stub, pos.x, pos.y);
  if (t && t.destMap) entrances.set(key(pos.x, pos.y), t.destMap);
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

// A metatile is water if it uses one of the CHR tiles the renderer animates —
// the same $22-$27 set `_initWaterAnimation` keys off, so this can't drift from
// what the player actually sees moving.
const ANIM_CHR = new Set([0x22, 0x23, 0x24, 0x25, 0x26, 0x27]);
const waterMetas = new Set();
for (let m = 0; m < 128; m++) {
  const mt = world.metatiles[m];
  if (ANIM_CHR.has(mt.tl) || ANIM_CHR.has(mt.tr) || ANIM_CHR.has(mt.bl) || ANIM_CHR.has(mt.br)) waterMetas.add(m);
}
const isWater = (x, y) => waterMetas.has(world.tilemap[key(x, y)] & 0x7F);
// Coast = a reachable LAND tile orthogonally touching water, i.e. somewhere the
// player can stand and see the ocean.
const coast = [...base].filter(k => {
  const x = k % W, y = (k - k % W) / W;
  return [[0, 1], [0, -1], [1, 0], [-1, 0]]
    .some(([dx, dy]) => isWater(((x + dx) % W + W) % W, ((y + dy) % W + W) % W));
});

const args = process.argv.slice(2);
if (args[0] === '--ocean') {
  console.log(`world open from Ur: ${base.size} tiles, ${baseEntrances.length} entrances`);
  console.log(`reachable coastline: ${coast.length} tiles\n`);
  console.log('cuts that reduce the coast, best first:');
  console.log('  tile        coastLeft  tilesLeft  entrances kept');
  const rows = [];
  for (const k of base) {
    if (entrances.has(k)) continue;
    const after = flood(k);
    const coastLeft = coast.filter(c => after.has(c)).length;
    if (coastLeft === coast.length) continue;
    const kept = baseEntrances.filter(d => {
      const ek = [...entrances].find(([, dd]) => dd === d)?.[0];
      return ek != null && after.has(ek);
    });
    rows.push({ x: k % W, y: (k - k % W) / W, coastLeft, tiles: after.size, kept });
  }
  rows.sort((a, b) => a.coastLeft - b.coastLeft || b.tiles - a.tiles);
  for (const r of rows.slice(0, 15)) {
    console.log(`  (${String(r.x).padStart(3)},${String(r.y).padStart(3)})   ${String(r.coastLeft).padStart(6)}     ${String(r.tiles).padStart(6)}     ${r.kept.join(', ')}`);
  }
  if (!rows.length) console.log('  (none — no single tile touches the coast\'s connectivity)');
  process.exit(0);
}
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
