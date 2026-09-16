// Adapter from a complete authored route to the existing map renderer.
import { processTriggerTiles } from '../map-loader.js';
import { planMines } from './definitions/mines.js';
import { installPort, applyFeature as mutateFeature } from './features.js';
import { validateDungeonFloor } from './validate.js';
import { planOwen } from './definitions/owen.js';
import { paintMachinery } from './materials/machinery.js';
import { paintMineRoute } from './materials/mine.js';

const planners = { mines: planMines, owen: planOwen };
const materials = { 'mine-rock': paintMineRoute, machinery: paintMachinery };

export { installPort } from './features.js';
export function applyFeature(map, feature, dungeon) {
  const candidate = { ...map, tilemap: map.tilemap.slice(), triggerMap: new Map(map.triggerMap), dungeonDestinations: new Map(map.dungeonDestinations) };
  mutateFeature(candidate, feature, dungeon);
  validateDungeonFloor(candidate, dungeon);
  mutateFeature(map, feature, dungeon);
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
    tilemap[(y - 1) * 32 + x] = port.topTile ?? 0x42;
    tilemap[y * 32 + x] = port.tile ?? 0x73;
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
    hiddenTraps: new Set(), lockedDoors: new Set(), rockSwitch: null, warpTile: route.warpTile ?? null, pondTiles: null,
    designVersion: dungeon.design.version, sectionId: route.id, sectionName: route.name,
    features: route.features, route,
    plan: { floorIndex, complete: true, topology: route.topology || 'authored-mine', chambers: route.rooms.map(r => ({ ...r, role: r.id, kind: r.kind || 'excavation' })), links: route.links.map(l => ({ ...l, kind: l.kind || 'gallery' })) },
    chamberLog: [],
  };
  for (const port of route.ports) installPort(map, port, dungeon);
  validateDungeonFloor(map, dungeon);
  return map;
}
