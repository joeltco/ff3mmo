// map-loading.js — map/dungeon/world loading functions extracted from game.js

import { loadMap } from './map-loader.js';
import { MapRenderer } from './map-renderer.js';
import { generateFloor } from './dungeon-generator.js';
import { playTrack, TRACKS } from './music.js';
import { DIR_DOWN } from './sprite.js';
import { sprite } from './player-sprite.js';
import { resetIndoorWaterCache } from './water-animation.js';
import { clearFlameSprites, rebuildFlameSprites } from './flame-sprites.js';
import { transSt, topBoxSt } from './transitions.js';
import { BATTLE_BG_MAP_LOOKUP, renderBattleBg } from './battle-bg.js';
import { AREA_NAMES, DUNGEON_NAME } from './data/strings.js';
import { hudSt } from './hud-state.js';
import { mapSt } from './map-state.js';
import { battleSt } from './battle-state.js';
import { applyPassage } from './map-triggers.js';
import { ps } from './player-stats.js';

const TILE_SIZE = 16;

// Init-once ROM ref — set by game.js at boot
let romRaw = null;

export function initMapLoading(rom) { romRaw = rom; }

function _calcSpawnY(ex, ey) {
  const mapData = mapSt.mapData;
  const eMid = mapData.tilemap[ey * 32 + ex];
  const eM = eMid < 128 ? eMid : eMid & 0x7F;
  const eColl = mapData.collision[eM];
  if ((eColl & 0x07) === 3) {
    for (let dy = 1; dy < 32; dy++) {
      const ny = (ey - dy + 32) % 32;
      if (mapData.tilemap[ny * 32 + ex] === 0x44) return ny;
    }
    for (let dy = 1; dy <= 16; dy++) {
      const ny = ey + dy;
      if (ny >= 32) break;
      const mid = mapData.tilemap[ny * 32 + ex];
      if (mid === mapData.fillTile) break;
      const m = mid < 128 ? mid : mid & 0x7F;
      if ((mapData.collision[m] & 0x07) !== 3 && !(mapData.collision[m] & 0x80)) return ny;
    }
    for (let dy = 1; dy <= 16; dy++) {
      const ny = ey - dy;
      if (ny < 0) break;
      const mid = mapData.tilemap[ny * 32 + ex];
      if (mid === mapData.fillTile) break;
      const m = mid < 128 ? mid : mid & 0x7F;
      if ((mapData.collision[m] & 0x07) !== 3 && !(mapData.collision[m] & 0x80)) return ny;
    }
    return ey;
  }
  const entMid = mapData.tilemap[ey * 32 + ex];
  const entM = entMid < 128 ? entMid : entMid & 0x7F;
  const entColl = mapData.collision[entM];
  if (entMid === 0x44) return ey;
  if ((entColl & 0x80) && ((mapData.collisionByte2[entM] >> 4) & 0x0F) === 0) {
    for (let dy = 1; dy <= 8; dy++) {
      const ny = ey - dy;
      if (ny < 0) break;
      if (mapData.tilemap[ny * 32 + ex] === 0x44) return ny;
    }
  }
  return ey;
}

function _openReturnDoor(playerX, playerY) {
  mapSt.openDoor = null;
  const mapRenderer = mapSt.mapRenderer;
  const mapData = mapSt.mapData;
  const trig = mapRenderer.getTriggerAt(playerX, playerY);
  if (trig && trig.source === 'dynamic' && trig.type === 1) {
    const origTileId = mapData.tilemap[playerY * 32 + playerX];
    const origM = origTileId < 128 ? origTileId : origTileId & 0x7F;
    if (((mapData.collisionByte2[origM] >> 4) & 0x0F) === 5) {
      mapRenderer.updateTileAt(playerX, playerY, 0x7E);
      mapSt.openDoor = { x: playerX, y: playerY, tileId: origTileId };
    }
  }
}

function _loadDungeonFloor(mapId, returnX, returnY) {
  const floorIndex = mapId - 1000;
  mapSt.dungeonFloor = floorIndex;
  const result = generateFloor(romRaw, floorIndex, mapSt.dungeonSeed);
  mapSt.mapData = result;
  mapSt.secretWalls = result.secretWalls;
  mapSt.falseWalls = result.falseWalls;
  mapSt.hiddenTraps = result.hiddenTraps;
  mapSt.rockSwitch = result.rockSwitch || null;
  mapSt.warpTile = result.warpTile || null;
  mapSt.pondTiles = result.pondTiles || null;
  mapSt.dungeonDestinations = result.dungeonDestinations;
  mapSt.currentMapId = mapId;
  const playerX = returnX !== undefined ? returnX : result.entranceX;
  const playerY = returnY !== undefined ? returnY : result.entranceY;
  mapSt.worldX = playerX * TILE_SIZE;
  mapSt.worldY = playerY * TILE_SIZE;
  mapSt.mapRenderer = new MapRenderer(result, playerX, playerY);
  resetIndoorWaterCache();
  clearFlameSprites();
  mapSt.bossSprite = (floorIndex === 4 && hudSt.adamantoiseFrames && !battleSt.enemyDefeated)
    ? { frames: hudSt.adamantoiseFrames, px: 6 * TILE_SIZE, py: 8 * TILE_SIZE } : null;
  mapSt.disabledTrigger = { x: playerX, y: playerY };
  mapSt.moving = false;
  sprite.setDirection(DIR_DOWN);
  sprite.resetFrame();
  if (floorIndex === 4) playTrack(TRACKS.CRYSTAL_ROOM);
  if (returnX !== undefined) _openReturnDoor(playerX, playerY);
}

function _loadRegularMap(mapId, returnX, returnY) {
  mapSt.dungeonFloor = -1;
  mapSt.encounterSteps = 0;
  mapSt.dungeonDestinations = null;
  mapSt.secretWalls = null;
  mapSt.falseWalls = null;
  mapSt.hiddenTraps = null;
  mapSt.rockSwitch = null;
  mapSt.warpTile = null;
  mapSt.pondTiles = null;
  mapSt.bossSprite = null;
  const mapData = loadMap(romRaw, mapId);
  mapSt.mapData = mapData;
  mapSt.currentMapId = mapId;
  if (AREA_NAMES.has(mapId)) ps.lastTown = mapId;
  if (returnX !== undefined) applyPassage(mapData.tilemap);
  const ex = mapData.entranceX;
  const ey = mapData.entranceY;
  const playerX = returnX !== undefined ? returnX : ex;
  const playerY = returnY !== undefined ? returnY : _calcSpawnY(ex, ey);
  mapSt.worldX = playerX * TILE_SIZE;
  mapSt.worldY = playerY * TILE_SIZE;
  const mapRenderer = new MapRenderer(mapData, playerX, playerY);
  mapSt.mapRenderer = mapRenderer;
  resetIndoorWaterCache();
  if (mapRenderer.hasRoomClip()) {
    const spawnMid = mapData.tilemap[playerY * 32 + playerX];
    mapSt.disabledTrigger = (spawnMid === 0x44 || playerY !== ey) ? { x: playerX, y: playerY } : null;
  } else { mapSt.disabledTrigger = null; }
  rebuildFlameSprites(mapSt.mapData, mapSt.mapRenderer, TILE_SIZE);
  mapSt.moving = false;
  sprite.setDirection(DIR_DOWN);
  sprite.resetFrame();
  if (returnX !== undefined) _openReturnDoor(playerX, playerY);
  if (mapId === 114 && transSt.pendingTrack == null) playTrack(TRACKS.TOWN_UR);
}

export function setupTopBox(mapId, isWorldMap) {
  if (isWorldMap) {
    const bgId = romRaw[BATTLE_BG_MAP_LOOKUP] & 0x1F;
    const result = renderBattleBg(romRaw, bgId);
    hudSt.topBoxBgCanvas = result.bgCanvas;
    hudSt.topBoxBgFadeFrames = result.fadeFrames;
    hudSt.topBoxMode = 'battle';
    topBoxSt.isTown = false;
    topBoxSt.nameBytes = null;
    topBoxSt.state = 'none';
    topBoxSt.fadeStep = 4;
    return;
  }
  if (mapId >= 1000) {
    const romMap = (mapId === 1004) ? 148 : 111;
    const bgId = romRaw[BATTLE_BG_MAP_LOOKUP + romMap] & 0x1F;
    const result = renderBattleBg(romRaw, bgId);
    hudSt.topBoxBgCanvas = result.bgCanvas;
    hudSt.topBoxBgFadeFrames = result.fadeFrames;
    hudSt.loadingBgFadeFrames = result.fadeFrames;
    topBoxSt.nameBytes = DUNGEON_NAME;
    hudSt.topBoxMode = 'battle';
    topBoxSt.isTown = false;
    topBoxSt.state = 'none';
    topBoxSt.fadeStep = 4;
    return;
  }
  if (mapId === 114) {
    if (!topBoxSt.isTown) { topBoxSt.state = 'pending'; }
    topBoxSt.isTown = true;
    topBoxSt.nameBytes = AREA_NAMES.get(114);
    hudSt.topBoxMode = 'name';
  } else if (!topBoxSt.isTown) {
    const bgId = romRaw[BATTLE_BG_MAP_LOOKUP + mapId] & 0x1F;
    const result = renderBattleBg(romRaw, bgId);
    hudSt.topBoxBgCanvas = result.bgCanvas;
    hudSt.topBoxBgFadeFrames = result.fadeFrames;
    hudSt.topBoxMode = 'battle';
  }
}

export function loadMapById(mapId, returnX, returnY) {
  mapSt.onWorldMap = false;
  setupTopBox(mapId, false);
  if (mapId >= 1000) { _loadDungeonFloor(mapId, returnX, returnY); return; }
  _loadRegularMap(mapId, returnX, returnY);
}

function _landOnWorldMap(tileX, tileY) {
  mapSt.worldX = tileX * TILE_SIZE;
  mapSt.worldY = tileY * TILE_SIZE;
  mapSt.disabledTrigger = { x: tileX, y: tileY };
  mapSt.moving = false;
  sprite.setDirection(DIR_DOWN);
  sprite.resetFrame();
  playTrack(TRACKS.WORLD_MAP);
}

export function loadWorldMapAt(trigId) {
  mapSt.onWorldMap = true;
  mapSt.mapRenderer = null;
  mapSt.mapData = null;
  mapSt.bossSprite = null;
  setupTopBox(0, true);
  const pos = mapSt.worldMapData.triggerPositions.get(trigId);
  const tileX = pos ? pos.x : 0;
  const tileY = pos ? pos.y : 0;
  _landOnWorldMap(tileX, tileY);
}

export function loadWorldMapAtPosition(tileX, tileY) {
  mapSt.onWorldMap = true;
  mapSt.dungeonFloor = -1;
  mapSt.encounterSteps = 0;
  battleSt.enemyDefeated = false;
  mapSt.mapRenderer = null;
  mapSt.mapData = null;
  setupTopBox(0, true);
  _landOnWorldMap(tileX, tileY);
}
