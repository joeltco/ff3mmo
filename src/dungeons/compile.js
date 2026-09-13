// Adapter from a complete authored route to the existing map renderer.
import { processTriggerTiles } from '../map-loader.js';
import { planMines } from './definitions/mines.js';
import { paintMineRoute } from './materials/mine.js';

const planners = { mines: planMines };
const materials = { 'mine-rock': paintMineRoute };

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
  if (feature.kind === 'chest') {
    const [x, y] = feature.at;
    map.tilemap[y * 32 + x] = 0x7d;
    map.triggerMap.delete(`${x},${y}`);
  }
  for (const { x, y, tile } of feature.tiles || []) map.tilemap[y * 32 + x] = tile;
  if (feature.port) installPort(map, feature.port, dungeon);
}

export function planDungeonFloor(dungeon, floorIndex, seed) {
  const planner = planners[dungeon.design.id];
  if (!planner) throw new Error(`Unknown dungeon design ${dungeon.design.id}`);
  return planner(floorIndex, seed);
}

export function compileDungeonFloor(assets, floorIndex, seed, dungeon) {
  const paint = materials[dungeon.design.material];
  if (!paint) throw new Error(`Unknown dungeon material ${dungeon.design.material}`);
  const route = planDungeonFloor(dungeon, floorIndex, seed);
  const tilemap = paint(route);
  for (const port of route.ports) {
    const [x, y] = port.at;
    tilemap[(y - 1) * 32 + x] = 0x42;
    tilemap[y * 32 + x] = 0x73;
  }
  const featureIds = new Set();
  for (const feature of route.features) {
    if (featureIds.has(feature.id) || !dungeon.design.featureIds.includes(feature.id)) throw new Error(`Invalid feature '${feature.id}'`);
    featureIds.add(feature.id);
    if (feature.kind === 'chest') {
      const i = feature.at[1] * 32 + feature.at[0];
      if (tilemap[i] !== 0x30) throw new Error(`Chest '${feature.id}' needs unoccupied floor`);
      tilemap[i] = 0x7c;
    }
  }
  const map = {
    ...assets, tileset: dungeon.tileset, fillTile: 0, skipRoomClip: true,
    entranceX: route.entrance[0], entranceY: route.entrance[1], mapExit: 0,
    tilemap, entranceData: new Uint8Array(16), triggerMap: processTriggerTiles(tilemap),
    dungeonDestinations: new Map(), secretWalls: new Set(), falseWalls: new Map(),
    hiddenTraps: new Set(), lockedDoors: new Set(), rockSwitch: null, warpTile: null, pondTiles: null,
    designVersion: dungeon.design.version, sectionId: route.id, sectionName: route.name,
    features: route.features, route,
    plan: { floorIndex, complete: true, topology: 'authored-mine', chambers: route.rooms.map(r => ({ ...r, role: r.id, kind: 'excavation' })), links: route.links.map(l => ({ ...l, kind: 'gallery' })) },
    chamberLog: [],
  };
  for (const port of route.ports) installPort(map, port, dungeon);
  return map;
}
