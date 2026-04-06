// map-loading.js — map/dungeon/world loading functions extracted from game.js

import { loadMap } from './map-loader.js';
import { MapRenderer } from './map-renderer.js';
import { generateFloor, clearDungeonCache } from './dungeon-generator.js';
import { playTrack, TRACKS } from './music.js';
import { DIR_DOWN } from './sprite.js';
import { resetIndoorWaterCache } from './water-animation.js';
import { clearFlameSprites } from './flame-sprites.js';
import { transSt } from './transitions.js';
import { BATTLE_BG_MAP_LOOKUP, renderBattleBg } from './battle-bg.js';
import { AREA_NAMES, DUNGEON_NAME } from './data/strings.js';

const TILE_SIZE = 16;

// Shared state — set once via initMapLoading()
let _s = null;

export function initMapLoading(shared) { _s = shared; }

function _calcSpawnY(ex, ey) {
  const mapData = _s.mapData;
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
  _s.openDoor = null;
  const mapRenderer = _s.mapRenderer;
  const mapData = _s.mapData;
  const trig = mapRenderer.getTriggerAt(playerX, playerY);
  if (trig && trig.source === 'dynamic' && trig.type === 1) {
    const origTileId = mapData.tilemap[playerY * 32 + playerX];
    const origM = origTileId < 128 ? origTileId : origTileId & 0x7F;
    if (((mapData.collisionByte2[origM] >> 4) & 0x0F) === 5) {
      mapRenderer.updateTileAt(playerX, playerY, 0x7E);
      _s.openDoor = { x: playerX, y: playerY, tileId: origTileId };
    }
  }
}

function _loadDungeonFloor(mapId, returnX, returnY) {
  const floorIndex = mapId - 1000;
  _s.dungeonFloor = floorIndex;
  const result = generateFloor(_s.romRaw, floorIndex, _s.dungeonSeed);
  _s.mapData = result;
  _s.secretWalls = result.secretWalls;
  _s.falseWalls = result.falseWalls;
  _s.hiddenTraps = result.hiddenTraps;
  _s.rockSwitch = result.rockSwitch || null;
  _s.warpTile = result.warpTile || null;
  _s.pondTiles = result.pondTiles || null;
  _s.dungeonDestinations = result.dungeonDestinations;
  _s.currentMapId = mapId;
  const playerX = returnX !== undefined ? returnX : result.entranceX;
  const playerY = returnY !== undefined ? returnY : result.entranceY;
  _s.worldX = playerX * TILE_SIZE;
  _s.worldY = playerY * TILE_SIZE;
  _s.mapRenderer = new MapRenderer(result, playerX, playerY);
  resetIndoorWaterCache();
  clearFlameSprites();
  _s.bossSprite = (floorIndex === 4 && _s.adamantoiseFrames && !_s.enemyDefeated)
    ? { frames: _s.adamantoiseFrames, px: 6 * TILE_SIZE, py: 8 * TILE_SIZE } : null;
  _s.disabledTrigger = { x: playerX, y: playerY };
  _s.moving = false;
  _s.sprite.setDirection(DIR_DOWN);
  _s.sprite.resetFrame();
  if (floorIndex === 4) playTrack(TRACKS.CRYSTAL_ROOM);
  if (returnX !== undefined) _openReturnDoor(playerX, playerY);
}

function _loadRegularMap(mapId, returnX, returnY) {
  _s.dungeonFloor = -1;
  _s.encounterSteps = 0;
  _s.dungeonDestinations = null;
  _s.secretWalls = null;
  _s.falseWalls = null;
  _s.hiddenTraps = null;
  _s.rockSwitch = null;
  _s.warpTile = null;
  _s.pondTiles = null;
  _s.bossSprite = null;
  const mapData = loadMap(_s.romRaw, mapId);
  _s.mapData = mapData;
  _s.currentMapId = mapId;
  if (returnX !== undefined) _s.applyPassage(mapData.tilemap);
  const ex = mapData.entranceX;
  const ey = mapData.entranceY;
  const playerX = returnX !== undefined ? returnX : ex;
  const playerY = returnY !== undefined ? returnY : _calcSpawnY(ex, ey);
  _s.worldX = playerX * TILE_SIZE;
  _s.worldY = playerY * TILE_SIZE;
  const mapRenderer = new MapRenderer(mapData, playerX, playerY);
  _s.mapRenderer = mapRenderer;
  resetIndoorWaterCache();
  if (mapRenderer.hasRoomClip()) {
    const spawnMid = mapData.tilemap[playerY * 32 + playerX];
    _s.disabledTrigger = (spawnMid === 0x44 || playerY !== ey) ? { x: playerX, y: playerY } : null;
  } else { _s.disabledTrigger = null; }
  _s.rebuildFlameSprites();
  _s.moving = false;
  _s.sprite.setDirection(DIR_DOWN);
  _s.sprite.resetFrame();
  if (returnX !== undefined) _openReturnDoor(playerX, playerY);
  if (mapId === 114 && transSt.pendingTrack == null) playTrack(TRACKS.TOWN_UR);
}

export function setupTopBox(mapId, isWorldMap) {
  if (isWorldMap) {
    const bgId = _s.romRaw[BATTLE_BG_MAP_LOOKUP] & 0x1F;
    const result = renderBattleBg(_s.romRaw, bgId);
    _s.topBoxBgCanvas = result.bgCanvas;
    _s.topBoxBgFadeFrames = result.fadeFrames;
    _s.topBoxMode = 'battle';
    _s.topBoxSt.isTown = false;
    _s.topBoxSt.nameBytes = null;
    _s.topBoxSt.state = 'none';
    _s.topBoxSt.fadeStep = 4;
    return;
  }
  if (mapId >= 1000) {
    const romMap = (mapId === 1004) ? 148 : 111;
    const bgId = _s.romRaw[BATTLE_BG_MAP_LOOKUP + romMap] & 0x1F;
    const result = renderBattleBg(_s.romRaw, bgId);
    _s.topBoxBgCanvas = result.bgCanvas;
    _s.topBoxBgFadeFrames = result.fadeFrames;
    _s.loadingBgFadeFrames = result.fadeFrames;
    _s.topBoxSt.nameBytes = DUNGEON_NAME;
    _s.topBoxMode = 'battle';
    _s.topBoxSt.isTown = false;
    _s.topBoxSt.state = 'none';
    _s.topBoxSt.fadeStep = 4;
    return;
  }
  if (mapId === 114) {
    if (!_s.topBoxSt.isTown) { _s.topBoxSt.state = 'pending'; }
    _s.topBoxSt.isTown = true;
    _s.topBoxSt.nameBytes = AREA_NAMES.get(114);
    _s.topBoxMode = 'name';
  } else if (!_s.topBoxSt.isTown) {
    const bgId = _s.romRaw[BATTLE_BG_MAP_LOOKUP + mapId] & 0x1F;
    const result = renderBattleBg(_s.romRaw, bgId);
    _s.topBoxBgCanvas = result.bgCanvas;
    _s.topBoxBgFadeFrames = result.fadeFrames;
    _s.topBoxMode = 'battle';
  }
}

export function loadMapById(mapId, returnX, returnY) {
  _s.onWorldMap = false;
  setupTopBox(mapId, false);
  if (mapId >= 1000) { _loadDungeonFloor(mapId, returnX, returnY); return; }
  _loadRegularMap(mapId, returnX, returnY);
}

function _landOnWorldMap(tileX, tileY) {
  _s.worldX = tileX * TILE_SIZE;
  _s.worldY = tileY * TILE_SIZE;
  _s.disabledTrigger = { x: tileX, y: tileY };
  _s.moving = false;
  _s.sprite.setDirection(DIR_DOWN);
  _s.sprite.resetFrame();
  playTrack(TRACKS.WORLD_MAP);
}

export function loadWorldMapAt(trigId) {
  _s.onWorldMap = true;
  _s.mapRenderer = null;
  _s.mapData = null;
  _s.bossSprite = null;
  setupTopBox(0, true);
  const pos = _s.worldMapData.triggerPositions.get(trigId);
  const tileX = pos ? pos.x : 0;
  const tileY = pos ? pos.y : 0;
  _landOnWorldMap(tileX, tileY);
}

export function loadWorldMapAtPosition(tileX, tileY) {
  _s.onWorldMap = true;
  _s.dungeonFloor = -1;
  _s.encounterSteps = 0;
  _s.enemyDefeated = false;
  _s.mapRenderer = null;
  _s.mapData = null;
  setupTopBox(0, true);
  _landOnWorldMap(tileX, tileY);
}
