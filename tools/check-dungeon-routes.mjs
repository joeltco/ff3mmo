#!/usr/bin/env node
// Rare chest/exit regressions: flood with the game's collision predicate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
globalThis.document = { createElement: () => createCanvas(256, 240) };
const { MapRenderer } = await import('../src/map-renderer.js');
const { generateFloor } = await import('../src/dungeon-generator.js');
const { DUNGEONS } = await import('../src/data/dungeons.js');
const rom = fs.readFileSync(new URL('../FF3-English.nes', import.meta.url));
const cases = [
  ['hein', 0, 1754900087109], ['mines', 0, 1754900435545],
  ['mines', 1, 1754901369987], ['mines', 1, 1754902795407],
  ['bahamut', 2, 1754901362068], ['bahamut', 2, 1754901884722],
  ['nepto', 1, 1754901995588], ['nepto', 2, 1754902866678],
  ['owen', 0, 1754900554330], ['flame', 2, 1754900902766],
];
function flood(data) {
  const mr = new MapRenderer(data, data.entranceX, data.entranceY);
  const seen = new Set(), queue = [[data.entranceX, data.entranceY]];
  while (queue.length) {
    const [x, y] = queue.pop(), i = y * 32 + x;
    if (x < 0 || x > 31 || y < 0 || y > 31 || seen.has(i) || !mr.isPassable(x, y, 0)) continue;
    seen.add(i);
    queue.push([x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]);
  }
  return seen;
}
function adjacent(seen, x, y) {
  return [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]
    .some(([a, b]) => a >= 0 && a < 32 && b >= 0 && b < 32 && seen.has(b * 32 + a));
}
for (const [id, floor, seed] of cases) {
  const dg = DUNGEONS.find(d => d.id === id);
  const data = generateFloor(rom, floor, seed, dg);
  assert.deepEqual(data.tilemap, generateFloor(rom, floor, seed, dg).tilemap, 'MMO seed must reproduce');
  if (data.rockSwitch) {
    const before = flood(data);
    assert(data.rockSwitch.rocks.some(({ x, y }) => adjacent(before, x, y)), 'switch reachable before opening');
    data.tilemap = new Uint8Array(data.tilemap);
    for (const { x, y, newTile } of data.rockSwitch.wallTiles) data.tilemap[y * 32 + x] = newTile;
  }
  const seen = flood(data);
  for (let i = 0; i < data.tilemap.length; i++) {
    if (data.tilemap[i] === 0x7c) assert(adjacent(seen, i % 32, Math.floor(i / 32)), `${id}: chest ${i} unreachable`);
    if ([0x30, 0x09].includes(data.tilemap[i])) assert(seen.has(i), `${id}: floor ${i} unreachable`);
  }
  let onward = 0;
  for (const [coord, trigger] of data.triggerMap) {
    const dest = data.dungeonDestinations.get(`${trigger.type}:${trigger.trigId}`);
    if (dest?.mapId !== dg.base + floor + 1) continue;
    const [x, y] = coord.split(',').map(Number);
    assert(seen.has(y * 32 + x), `${id}: onward exit unreachable`);
    onward++;
  }
  assert(onward > 0, `${id}: onward exit missing`);
}
console.log(`PASS: ${cases.length} rare layouts have usable chests, switches and onward exits in the game renderer.`);
