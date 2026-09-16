import { mapCollisionView } from '../map-renderer.js';
// Shared authored feature mutations, used by runtime and validation.
export function installPort(map, port, dungeon) {
  const [x, y] = port.at;
  if (![x, y].every(Number.isInteger) || x < 0 || x > 31 || y < 0 || y > 31) throw new Error(`Port '${port.id}' is outside the map`);
  const floor = port.destination.floor;
  if (floor !== undefined && (!Number.isInteger(floor) || floor < 0 || floor >= dungeon.floors)) throw new Error(`Port '${port.id}' names a missing floor`);
  const key = `${x},${y}`;
  // Feature ports have stable IDs independent of native scan order.
  let trigger = map.triggerMap.get(key);
  if (trigger && trigger.type !== 1) throw new Error(`Port '${port.id}' overlaps another trigger`);
  if (!trigger) {
    const trigId = Math.max(-1, ...[...map.triggerMap.values()].filter(t => t.type === 1).map(t => t.trigId)) + 1;
    trigger = { type: 1, trigId };
    map.triggerMap.set(key, trigger);
  }
  const destination = { ...port.destination };
  if (destination.floor !== undefined) {
    destination.mapId = dungeon.base + destination.floor;
    delete destination.floor;
  }
  map.dungeonDestinations.set(`${trigger.type}:${trigger.trigId}`, destination);
}

export function applyFeature(map, feature, dungeon) {
  for (const p of feature.tiles || []) {
    if (![p.x, p.y].every(n => Number.isInteger(n) && n >= 0 && n < 32)) throw new Error('Feature tile outside map');
  }
  if (feature.openingOnly) {
    const candidate = { ...map, tilemap: map.tilemap.slice() };
    for (const p of feature.tiles || []) candidate.tilemap[p.y * 32 + p.x] = p.tile;
    const before = mapCollisionView(map), after = mapCollisionView(candidate);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) for (const z of [0, 1, 2]) {
      if (before.isPassable(x, y, z) && !after.isPassable(x, y, z)) throw new Error(`Control ${feature.id} may only open routes`);
    }
  }
  if (feature.kind === 'chest') {
    const [x, y] = feature.at;
    map.tilemap[y * 32 + x] = 0x7d;
    map.triggerMap.delete(`${x},${y}`);
  }
  for (const { x, y, tile } of feature.tiles || []) map.tilemap[y * 32 + x] = tile;
  if (feature.port) installPort(map, feature.port, dungeon);
}

