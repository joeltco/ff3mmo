// One final gameplay contract for authored AND legacy generated maps.
// Construction is material-specific; movement semantics come from the renderer.
import { mapCollisionView } from '../map-renderer.js';
import { applyFeature } from './features.js';
import { dungeonForMapId, sideRoomForMapId } from '../data/dungeons.js';

export const neighbours = i => {
  const x = i % 32, y = Math.floor(i / 32);
  return [x > 0 ? i - 1 : -1, x < 31 ? i + 1 : -1, y > 0 ? i - 32 : -1, y < 31 ? i + 32 : -1].filter(n => n >= 0);
};
export function walkDungeon(map, start = [map.entranceX, map.entranceY]) {
  const view = mapCollisionView(map, ...start), distance = new Int16Array(1024).fill(-1);
  const states = new Uint8Array(3072), queue = [];
  const first = start[1] * 32 + start[0];
  if (!view.isPassable(...start, view._playerZ)) return { distance, view };
  states[view._playerZ * 1024 + first] = 1; distance[first] = 0; queue.push([first, view._playerZ, 0]);
  for (let h = 0; h < queue.length; h++) {
    const [i, z, d] = queue[h];
    for (const n of neighbours(i)) {
      const x = n % 32, y = Math.floor(n / 32);
      if (!view.isPassable(x, y, z)) continue;
      const nz = view.zAfterEntering(x, y, z), key = nz * 1024 + n;
      if (states[key]) continue;
      states[key] = 1; if (distance[n] < 0) distance[n] = d + 1;
      queue.push([n, nz, d + 1]);
    }
  }
  return { distance, view };
}
const copyMap = map => ({ ...map, tilemap: map.tilemap.slice(), triggerMap: new Map(map.triggerMap), dungeonDestinations: new Map(map.dungeonDestinations) });
const usable = (d, i) => neighbours(i).some(n => d[n] >= 0);
const fail = message => { throw new Error(`Dungeon contract: ${message}`); };
export function validateDungeonFloor(map, dungeon) {
  const ex = map.entranceX, ey = map.entranceY;
  const validPoint = p => Array.isArray(p) && p.length === 2 && p.every(n => Number.isInteger(n) && n >= 0 && n < 32);
  for (const feature of map.features || []) if (!validPoint(feature.at)) fail(`invalid feature position ${feature.id}`);
  const validDestination = dest => dest.goBack === true || Number.isInteger(dest.mapId) && dest.mapId >= 0 &&
    (dest.mapId < 512 || dest.mapId >= dungeon.base && dest.mapId < dungeon.base + dungeon.floors || dungeonForMapId(dest.mapId) || sideRoomForMapId(dest.mapId));
  if (![ex, ey].every(n => Number.isInteger(n) && n >= 0 && n < 32)) fail('arrival out of bounds');
  const initial = walkDungeon(map), i = ey * 32 + ex;
  // A frame can have one step out, but the landing immediately beyond must
  // offer a 2x2 manoeuvring pocket. A shaft's later catwalk may be one wide.
  let landing = false;
  for (let y = Math.max(0, ey - 2); y <= Math.min(30, ey + 2); y++) for (let x = Math.max(0, ex - 2); x <= Math.min(30, ex + 2); x++) {
    if ([y * 32 + x, y * 32 + x + 1, (y + 1) * 32 + x, (y + 1) * 32 + x + 1].every(n => initial.distance[n] >= 0 && initial.distance[n] <= 5)) landing = true;
  }
  if (initial.distance[i] !== 0 || !neighbours(i).some(n => initial.distance[n] === 1 && !map.triggerMap.has(`${n % 32},${Math.floor(n / 32)}`))) fail('unsafe arrival: no free step off the entrance');
  if (dungeon.design && !landing) fail('unsafe arrival: no nearby manoeuvring pocket');
  const opened = copyMap(map), remaining = new Set((map.features || []).filter(f => f.kind === 'passage'));
  const secrets = new Set(map.secretWalls || []);
  let rock = map.rockSwitch, progress = true;
  while (progress) {
    progress = false;
    const { distance } = walkDungeon(opened);
    for (const feature of remaining) {
      if (!usable(distance, feature.at[1] * 32 + feature.at[0])) continue;
      const before = walkDungeon(opened).distance;
      applyFeature(opened, feature, dungeon);
      const after = walkDungeon(opened).distance;
      if (feature.openingOnly && before.some((d, n) => d >= 0 && after[n] < 0)) fail(`control ${feature.id} closes occupied floor`);
      remaining.delete(feature); progress = true;
    }
    for (const key of secrets) {
      const [x, y] = key.split(',').map(Number);
      if (!usable(distance, y * 32 + x)) continue;
      opened.tilemap[y * 32 + x] = 0x30; secrets.delete(key); progress = true;
    }
    if (rock && rock.rocks.some(p => usable(distance, p.y * 32 + p.x))) {
      for (const p of rock.wallTiles) opened.tilemap[p.y * 32 + p.x] = p.newTile;
      rock = null; progress = true;
    }
  }
  if (remaining.size || rock) fail('unreachable control');
  const { distance, view } = walkDungeon(opened);
  // Generated dungeons use the land layer (z=1). Pond water on z=2 is
  // scenery reached by interaction, not an isolated floor to be filled.
  // ⛔ A CHEST IS NOT A WALL. A chest tile is solid to the renderer, so the one
  // floor tile a chest is backed against reads as "isolated" to a plain flood
  // fill. That is scenery behind furniture, not unreachable content — Joel,
  // 2026-09-15: "chests shouldn't be blocking anything." Flagging it condemned
  // 40 of 40 perfectly good Altar/Seals floors (every hit a single tile with a
  // chest beside it) and would have re-rolled three shipped floor layouts for
  // nothing. Treat a pocket as isolated only when nothing adjacent is a chest.
  const isChestTile = t => t >= 0x78 && t <= 0x7c;
  const behindChest = n => neighbours(n).some(m => isChestTile(opened.tilemap[m]));
  for (let n = 0; n < 1024; n++) {
    const x = n % 32, y = Math.floor(n / 32);
    if (view.isPassable(x, y, 1) && distance[n] < 0 && !behindChest(n)) fail(`isolated floor at ${x},${y}`);
    if (opened.tilemap[n] === 0x7c && !usable(distance, n)) fail(`unusable treasure at ${x},${y}`);
  }
  for (const [key, dest] of opened.dungeonDestinations || []) {
    if (!validDestination(dest)) fail(`invalid transition ${key}`);
    const match = [...opened.triggerMap].find(([, t]) => `${t.type}:${t.trigId}` === key);
    if (!match) fail(`transition ${key} has no trigger`);
    const [x, y] = match[0].split(',').map(Number);
    if (distance[y * 32 + x] < 0) fail(`unreachable transition ${key}`);
  }
  for (const [coord, dest] of map.falseWalls || []) {
    const at = coord.split(',').map(Number);
    if (!validPoint(at) || !validDestination(dest)) fail(`invalid secret transition ${coord}`);
    if (distance[at[1] * 32 + at[0]] < 0) fail(`unreachable secret transition ${coord}`);
  }
  for (const f of map.features || []) if (f.kind === 'landmark' && distance[f.at[1] * 32 + f.at[0]] < 0) fail(`unreachable objective ${f.id}`);
  if (map.warpTile && distance[map.warpTile.y * 32 + map.warpTile.x] < 0) fail('unreachable warp objective');
  return { initial: initial.distance, opened: distance };
}
