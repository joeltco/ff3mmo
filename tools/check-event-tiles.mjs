#!/usr/bin/env node
// check-event-tiles.mjs — event tiles ($60-$63) must stay PASSABLE.
//
// This behaviour has been flipped before (v1.7.906 blocked them, v1.7.907 tried
// a fire-on-approach model, v1.7.908 reverted), so it gets a gate.
//
// The ROM is unambiguous. A tile whose collision byte2 high nibble is $F routes
// to the player's event handler at 3F/$E6BE, which runs the event and exits via
//   LDA $2D / LSR A / BCC $E714
// and $E714 is a bare RTS reached with carry CLEAR. Carry clear is "move
// allowed" — identical to the type-0 handler at $E689 (LDA #$40 / STA $AB /
// CLC / RTS). The comment that once justified blocking cited 3B/90EB and
// 3B/B0C5; those are the NPC/entity collision routines, not the player's.
//
// Blocking them walls off most of several towns, because these tiles sit in
// doorways with plain floor either side. Map 10 is the clearest case: the whole
// town hid behind ONE event tile at (8,28).
//
//   node tools/check-event-tiles.mjs

import fs from 'node:fs';

const ctx2d = {
  createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4), width: w, height: h }),
  putImageData() {}, drawImage() {}, fillRect() {}, clearRect() {},
  save() {}, restore() {}, translate() {}, scale() {}, beginPath() {}, rect() {}, clip() {},
};
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }) };

const { loadMap } = await import('../src/map-loader.js');
const { MapRenderer } = await import('../src/map-renderer.js');

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));
const W = 32;

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.error('  ✗ ' + m); failed++; };

function reach(mapId) {
  const md = loadMap(rom, mapId);
  const sx = md.entranceX, sy = md.entranceY;
  const r = new MapRenderer(md, sx, sy);
  const seen = new Set([sy * W + sx]);
  const q = [[sx, sy]];
  while (q.length) {
    const [x, y] = q.pop();
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const nx = x + dx, ny = y + dy, k = ny * W + nx;
      if (nx < 0 || nx >= W || ny < 0 || ny >= W || seen.has(k)) continue;
      if (!r.isPassable(nx, ny)) continue;
      seen.add(k); q.push([nx, ny]);
    }
  }
  return { md, r, seen };
}

// ── 1. The specific tile that hid a whole town ────────────────────────────
{
  const { md, r } = reach(10);
  const t = md.triggerMap.get('8,28');
  if (t && t.type === 0) ok('map 10 (8,28) is an event tile (trigger type 0)');
  else bad(`map 10 (8,28) is not the expected event trigger: ${JSON.stringify(t)}`);
  if (r.isPassable(8, 28)) ok('that event tile is PASSABLE');
  else bad('that event tile is BLOCKED — the town behind it is sealed off');
}

// ── 2. Map 10's town is actually reachable ────────────────────────────────
{
  const { md, seen } = reach(10);
  if (seen.size >= 180) ok(`map 10 reachable area is ${seen.size} tiles`);
  else bad(`map 10 reachable area collapsed to ${seen.size} tiles (expected ~196)`);

  // Every door out of the town must be standable-next-to.
  let doors = 0, reachable = 0;
  for (const [key, t] of md.triggerMap) {
    if (t.type !== 1) continue;
    const [x, y] = key.split(',').map(Number);
    doors++;
    if (seen.has(y * W + x) ||
        [[0, 1], [0, -1], [1, 0], [-1, 0]].some(([dx, dy]) => seen.has((y + dy) * W + (x + dx)))) reachable++;
  }
  if (doors && reachable === doors) ok(`all ${doors} town doors on map 10 are reachable`);
  else bad(`only ${reachable}/${doors} town doors reachable on map 10`);
}

// ── 3. Treasure stays blocked — you walk UP to a chest, never onto it ─────
{
  let checked = 0, blocked = 0;
  for (const id of [114, 10, 18]) {
    const { md, r } = reach(id);
    for (const [key, t] of md.triggerMap) {
      if (t.type !== 2) continue;          // treasure / hidden-treasure
      const [x, y] = key.split(',').map(Number);
      checked++;
      if (!r.isPassable(x, y)) blocked++;
    }
  }
  if (checked === 0) ok('no treasure tiles on the sampled maps (nothing to check)');
  else if (blocked === checked) ok(`all ${checked} treasure tiles stay blocked`);
  else bad(`${checked - blocked}/${checked} treasure tiles became walkable`);
}

if (failed) { console.error(`\ncheck-event-tiles: FAIL (${failed})`); process.exit(1); }
console.log('\ncheck-event-tiles: OK');
