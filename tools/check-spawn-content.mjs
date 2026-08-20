#!/usr/bin/env node
// check-spawn-content.mjs — the player spawns where the content is.
//
// Every shop counter, shop keeper and placed NPC on a map has to be REACHABLE
// from that map's spawn. FF3 packs several interiors into one 32x32 tilemap, so
// "the spawn moved two tiles" and "the spawn moved to another room and left the
// shopkeeper behind" look identical in a diff and identical on the map.
//
//   node tools/check-spawn-content.mjs
//   node tools/check-spawn-content.mjs --list
//
// ⭐ WHY THIS EXISTS. `door-probe.cjs` measured the cartridge's landing tile on
// 44 maps; 39 agree with ours, 5 do not, and the obvious "fix" — take the ROM's
// spawn — would have been a disaster on four of them:
//
//   map  5 / 16   ROM spawn (3,26) reaches 8 tiles in this engine, a vestibule
//                 with NO route to the shop room; the keeper sits at (3,14)
//   map 12        ROM spawn (14,31) reaches ONE tile — the player cannot move
//
// So the rule is not "match the ROM". It is "the spawn and the content are in
// the same room", which is what a player can tell the difference between.
import fs from 'node:fs';

const ctx2d = {
  createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4), width: w, height: h }),
  putImageData() {}, drawImage() {}, fillRect() {}, clearRect() {},
  save() {}, restore() {}, translate() {}, scale() {}, beginPath() {}, rect() {}, clip() {},
};
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.document = { addEventListener() {}, createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }), getElementById: () => null };

const { loadMap } = await import('../src/map-loader.js');
const { MapRenderer } = await import('../src/map-renderer.js');
const { applyPassage } = await import('../src/map-passage.js');
const { SHIPPED_MAPS } = await import('../src/data/areas.js');
const { SHOPS } = await import('../src/data/shops.js');
const { TOWN_NPCS } = await import('../src/data/town-npcs.js');

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));
const W = 32;
let fails = 0;
const fail = (m) => { console.log('  ⛔ ' + m); fails++; };
const verbose = process.argv.includes('--list');

// Mirrors map-loading.js#_calcSpawnY, on the tilemap the engine has.
function calcSpawnY(md, ex, ey) {
  const eMid = md.tilemap[ey * 32 + ex], eColl = md.collision[eMid < 128 ? eMid : eMid & 0x7F];
  if ((eColl & 0x07) !== 3) return ey;
  for (let dy = 1; dy < 32; dy++) { const ny = (ey - dy + 32) % 32; if (md.tilemap[ny * 32 + ex] === 0x44) return ny; }
  for (const d of [1, -1]) for (let dy = 1; dy <= 16; dy++) {
    const ny = ey + d * dy; if (ny < 0 || ny >= 32) break;
    const mid = md.tilemap[ny * 32 + ex]; if (mid === md.fillTile) break;
    const mm = mid & 0x7F;
    if ((md.collision[mm] & 0x07) !== 3 && !(md.collision[mm] & 0x80)) return ny;
  }
  return ey;
}

/** What the engine does on a fresh entry, spawn override included. */
function spawnAndRegion(mapId) {
  const md = loadMap(rom, mapId);
  // Same condition map-loading.js uses: maps carrying the torch puzzle keep it
  // closed until the player solves it.
  if (md.tilemap[16 * 32 + 8] !== 0x32) applyPassage(md.tilemap);
  const sx = md.entranceX;
  const sy = calcSpawnY(md, md.entranceX, md.entranceY);
  const r = new MapRenderer(md, sx, sy);
  const seen = new Set([sy * W + sx]);
  const q = [[sx, sy]];
  while (q.length) {
    const [x, y] = q.pop();
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const nx = x + dx, ny = y + dy, k = ny * W + nx;
      if (nx < 0 || ny < 0 || nx > 31 || ny > 31 || seen.has(k)) continue;
      if (!r.isPassable(nx, ny)) continue;
      seen.add(k); q.push([nx, ny]);
    }
  }
  return { sx, sy, seen };
}

// ⛔ "ORTHOGONALLY ADJACENT TO THE WALK" IS THE WRONG TEST, and it fails six
// shops that work. A keeper stands BEHIND a counter: player on the floor, the
// counter tile impassable between them, keeper on the far side. Ur's armor
// keeper at (3,4) is two tiles from anywhere standable and the shop is fine —
// `findShopAtCounter` only needs the player to face the COUNTER.
//
// What this gate is for is "the spawn moved to a different ROOM and left the
// content behind", which is an eight-tile error, not a two-tile one. So: the
// content has to be within 2 tiles of somewhere the player can stand.
const NEAR_ENOUGH = 2;
function usable(seen, x, y) {
  for (const k of seen) {
    const sxk = k % W, syk = (k - sxk) / W;
    if (Math.abs(sxk - x) + Math.abs(syk - y) <= NEAR_ENOUGH) return true;
  }
  return false;
}

console.log('spawn vs content');

const placed = new Map();   // mapId -> [{what, x, y}]
const add = (mapId, what, x, y) => {
  if (!SHIPPED_MAPS.has(Number(mapId))) return;
  if (!placed.has(Number(mapId))) placed.set(Number(mapId), []);
  placed.get(Number(mapId)).push({ what, x, y });
};
for (const [key, shop] of Object.entries(SHOPS)) {
  if (shop && shop.mapId != null && shop.counter) add(shop.mapId, `shop counter ${key}`, shop.counter.x, shop.counter.y);
}
const npcTable = TOWN_NPCS instanceof Map ? TOWN_NPCS : new Map(Object.entries(TOWN_NPCS));
for (const [mapId, cast] of npcTable) for (const n of (cast || [])) add(mapId, `npc ${n.key}`, n.x, n.y);

let checked = 0;
for (const [mapId, items] of [...placed].sort((a, b) => a[0] - b[0])) {
  const { sx, sy, seen } = spawnAndRegion(mapId);
  for (const it of items) {
    checked++;
    if (!usable(seen, it.x, it.y)) {
      fail(`map ${mapId}: ${it.what} at (${it.x},${it.y}) is not reachable from the spawn (${sx},${sy}) — ${seen.size} tile region`);
    } else if (verbose) {
      console.log(`     map ${String(mapId).padStart(3)} spawn (${sx},${sy})  ${it.what} @(${it.x},${it.y}) ✓`);
    }
  }
}

if (!fails) console.log(`  ✓ all ${checked} placed shop counters and NPCs across ${placed.size} maps are reachable from their spawn`);
console.log(fails ? `\ncheck-spawn-content: ${fails} FAILURE(S)` : '\ncheck-spawn-content: OK');
process.exit(fails ? 1 : 0);
