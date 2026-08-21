#!/usr/bin/env node
// check-boss-warp.mjs — the crystal room's warp out must require the boss.
//
// ⛔ THE BOSS DOES NOT BLOCK THE WAY TO IT. Flooding the generated crystal room
// with the REAL `MapRenderer.isPassable` and the Land Turtle's tile (6,8)
// treated as solid still reaches the warp at (6,5): 71 tiles against 72, losing
// only the turtle's own tile. Positional blocking was assumed and never held, so
// before v1.10.19 a player could walk around the boss and warp straight out of
// the dungeon. The gate is `battleSt.enemyDefeated` in `_checkWarpTile`.
//
// This drives a REAL step onto the warp tile through the public
// `startMove` / `updateMovement` pair and watches for `mapSt.starEffect`, the
// warp's own side effect — rather than grepping the source for the guard, which
// would pass on a comment.
//
//   node tools/check-boss-warp.mjs

import fs from 'node:fs';

const _c = {
  createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4), width: Math.max(1, w), height: Math.max(1, h) }),
  putImageData() {}, drawImage() {}, fillRect() {}, clearRect() {}, save() {}, restore() {},
  translate() {}, scale() {}, beginPath() {}, rect() {}, clip() {}, createPattern: () => ({}),
};
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => _c }), getElementById: () => null, addEventListener() {} };
globalThis.window = { addEventListener() {}, location: { href: '' } };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const rom = new Uint8Array(fs.readFileSync(process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname));
const { generateFloor } = await import('../src/dungeon-generator.js');
const { MapRenderer } = await import('../src/map-renderer.js');
const { mapSt } = await import('../src/map-state.js');
const { battleSt } = await import('../src/battle-state.js');
const { startMove, updateMovement } = await import('../src/movement.js');
const { setPlayerSprite } = await import('../src/player-sprite.js');
const { DIR_UP } = await import('../src/sprite.js');

// Minimal player sprite — these are every `sprite.*` movement.js touches.
let _dir = 0;
setPlayerSprite({
  setDirection(d) { _dir = d; }, getDirection() { return _dir; },
  setWalkProgress() {}, resetFrame() {},
});

const TILE = 16;
const fails = [];

// ── 1. The reachability fact the gate exists because of ────────────────────
const room = generateFloor(rom, 4, 1761000000000);
const mr = new MapRenderer(room, room.entranceX, room.entranceY);
const flood = (blockBoss) => {
  const seen = new Set([room.entranceY * 32 + room.entranceX]);
  const q = [[room.entranceX, room.entranceY]];
  while (q.length) {
    const [cx, cy] = q.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || nx > 31 || ny < 0 || ny > 31) continue;
      if (blockBoss && nx === 6 && ny === 8) continue;
      const i = ny * 32 + nx;
      if (seen.has(i) || !mr.isPassable(nx, ny)) continue;
      seen.add(i); q.push([nx, ny]);
    }
  }
  return seen;
};
const w = room.warpTile;
const around = flood(true).has(w.y * 32 + w.x);
console.log(`warp ${w.x},${w.y} reachable with the boss tile blocked: ${around}`);
if (!around) fails.push('the boss now DOES block the warp — re-check whether the enemyDefeated gate is still the right mechanism');

// ── 2. Drive a real step onto the warp tile, both ways ──────────────────────
function stepOntoWarp(defeated) {
  mapSt.mapData = room;
  mapSt.mapRenderer = mr;
  mapSt.currentMapId = 1004;
  mapSt.onWorldMap = false;
  mapSt.warpTile = { x: w.x, y: w.y };
  mapSt.disabledTrigger = null;
  mapSt.starEffect = null;
  mapSt.moving = false;
  battleSt.enemyDefeated = defeated;
  // stand one tile below the warp, walk up onto it
  mapSt.worldX = w.x * TILE;
  mapSt.worldY = (w.y + 1) * TILE;
  startMove(DIR_UP, true);   // dir constant, NOT a (dx,dy) delta
  for (let i = 0; i < 200 && mapSt.moving; i++) updateMovement(16);
  return { landed: mapSt.worldX / TILE === w.x && mapSt.worldY / TILE === w.y, warped: !!mapSt.starEffect };
}

const before = stepOntoWarp(false);
const after = stepOntoWarp(true);
console.log(`boss alive   — landed on warp: ${before.landed}, warp fired: ${before.warped}`);
console.log(`boss beaten  — landed on warp: ${after.landed}, warp fired: ${after.warped}`);

if (!before.landed || !after.landed) fails.push('the step never landed on the warp tile — this check is not exercising the warp, fix the harness before trusting either result');
else {
  if (before.warped) fails.push('WARP FIRED WITH THE BOSS ALIVE — the player can leave the dungeon without fighting it');
  if (!after.warped) fails.push('warp did NOT fire after the boss was beaten — the way out is broken');
}

if (fails.length) { console.log('\nFAIL:'); for (const f of fails) console.log('  ' + f); process.exit(1); }
console.log('\nboss warp gated correctly');
