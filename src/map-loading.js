// map-loading.js — map/dungeon/world loading functions extracted from game.js

import { loadMap } from './map-loader.js';
import { MapRenderer } from './map-renderer.js';
import { generateFloor } from './dungeon-generator.js';
import { playTrack, TRACKS } from './music.js';
import { DIR_DOWN } from './sprite.js';
import { sprite } from './player-sprite.js';
import { resetIndoorWaterCache } from './water-animation.js';
import { clearFlameSprites, rebuildFlameSprites } from './flame-sprites.js';
import { clearNpcs, placeMoogleAtCaveCenter, placeOpeningScene, addBlackMageShopkeeper, addBossNpc, getLandTurtleFrames } from './npc.js';
import { transSt, topBoxSt } from './transitions.js';
import { BATTLE_BG_MAP_LOOKUP, renderBattleBg } from './battle-bg.js';
import { AREA_NAMES, DUNGEON_NAME } from './data/strings.js';
import { hudSt } from './hud-state.js';
import { mapSt } from './map-state.js';
import { battleSt } from './battle-state.js';
import { applyPassage, triggerWipe } from './map-triggers.js';
import { ps } from './player-stats.js';
import { saveSlotsToDB } from './save-state.js';

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

// Replay persisted tile mutations (chests opened, secret walls revealed,
// rock puzzles solved) onto a freshly-generated tilemap. Stored at
// ps.consumedTiles[mapId][`${x},${y}`] = newTileId. See SAVE-STATE-AUDIT.md
// #1-3 (v1.7.215). Also tidies the relevant `secretWalls` set so a revealed
// wall doesn't keep its "still hidden" trigger.
function _replayConsumedTiles(mapId, mapData) {
  const consumed = ps.consumedTiles && ps.consumedTiles[mapId];
  if (!consumed) return;
  for (const key of Object.keys(consumed)) {
    const [x, y] = key.split(',').map(Number);
    if (Number.isNaN(x) || Number.isNaN(y)) continue;
    mapData.tilemap[y * 32 + x] = consumed[key];
    if (mapSt.secretWalls && mapSt.secretWalls.has(key)) mapSt.secretWalls.delete(key);
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
  _replayConsumedTiles(mapId, result);
  const playerX = returnX !== undefined ? returnX : result.entranceX;
  const playerY = returnY !== undefined ? returnY : result.entranceY;
  mapSt.worldX = playerX * TILE_SIZE;
  mapSt.worldY = playerY * TILE_SIZE;
  mapSt.mapRenderer = new MapRenderer(result, playerX, playerY);
  resetIndoorWaterCache();
  clearFlameSprites();
  clearNpcs();
  if (floorIndex === 0) placeMoogleAtCaveCenter(result);
  // Boss is now an NPC rendered through `drawNpcs`. Keep `mapSt.bossSprite`
  // as a no-frames presence flag for the existing battle-trigger / collision
  // checks in movement.js + battle code.
  if (floorIndex === 4 && getLandTurtleFrames() && !battleSt.enemyDefeated) {
    mapSt.bossSprite = { px: 6 * TILE_SIZE, py: 8 * TILE_SIZE };
    addBossNpc(6, 8);
  } else {
    mapSt.bossSprite = null;
  }
  mapSt.disabledTrigger = { x: playerX, y: playerY };
  mapSt.moving = false;
  sprite.setDirection(DIR_DOWN);
  sprite.resetFrame();
  if (floorIndex === 4) playTrack(TRACKS.CRYSTAL_ROOM);
  if (returnX !== undefined) _openReturnDoor(playerX, playerY);
}

// Flood-fill the tilemap from (sx, sy), matching the same tile ID 4-way.
// Returns a Set of y*32+x indices the player triggers encounters on. Used
// by town encounter-patch zones — see Ur (114) where the dark-tile patch
// (tile 0x2f at 22,8) runs `grasslands_wild`.
function _floodFillTilePatch(tilemap, sx, sy) {
  const targetId = tilemap[sy * 32 + sx];
  const out = new Set();
  const stack = [[sx, sy]];
  while (stack.length > 0) {
    const [x, y] = stack.pop();
    if (x < 0 || x >= 32 || y < 0 || y >= 32) continue;
    const idx = y * 32 + x;
    if (out.has(idx)) continue;
    if (tilemap[idx] !== targetId) continue;
    out.add(idx);
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  return out;
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
  mapSt.encounterPatch = null;
  mapSt.encounterPatchZone = null;
  const mapData = loadMap(romRaw, mapId);
  mapSt.mapData = mapData;
  mapSt.currentMapId = mapId;
  _replayConsumedTiles(mapId, mapData);
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
  clearNpcs();
  if (mapId === 3) addBlackMageShopkeeper(4, 4, 'ur_magic');
  if (mapId === 7) placeOpeningScene();
  // Ur (114) has a dark-tile patch in the town that spawns wild
  // grasslands encounters (Werewolves + Bees). Flood-fill from the seed
  // tile so adding/extending the patch in the ROM just works.
  if (mapId === 114) {
    mapSt.encounterPatch = _floodFillTilePatch(mapData.tilemap, 22, 8);
    mapSt.encounterPatchZone = 'grasslands_wild';
  }
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
    // Wipe any stale battle BG carried over from a non-town map (e.g.
    // walking out of the elder house via map 7 → map 6 → Ur chain leaves
    // map 6's battle BG in the canvas). The render gate on `!isTown`
    // SHOULD suppress it, but if anything draws unconditionally we'd flash
    // grass under the Ur name box during transitions.
    hudSt.topBoxBgCanvas = null;
    hudSt.topBoxBgFadeFrames = null;
  } else if (!topBoxSt.isTown) {
    const bgId = romRaw[BATTLE_BG_MAP_LOOKUP + mapId] & 0x1F;
    const result = renderBattleBg(romRaw, bgId);
    hudSt.topBoxBgCanvas = result.bgCanvas;
    hudSt.topBoxBgFadeFrames = result.fadeFrames;
    hudSt.topBoxMode = 'battle';
  }
}

export function loadMapById(mapId, returnX, returnY) {
  // Entering a town / dungeon FROM overworld? Capture the entrance tile
  // before flipping `mapSt.onWorldMap`, so:
  //   1. `ps.lastWorldExitX/Y` (death respawn point) updates to the
  //      entrance tile. Dying inside the Altar Cave then dumps the
  //      player back at the cave entrance on overworld, not at the
  //      last town gate they walked through.
  //   2. The `saveSlotsToDB` here fires while `onWorldMap` is still
  //      true, so the position getter (v1.7.268, overworld-only) accepts
  //      and writes the entrance into the slot. Logging out inside the
  //      dungeon then reloads at the same entrance.
  if (mapSt.onWorldMap) {
    ps.lastWorldExitX = Math.floor(mapSt.worldX / TILE_SIZE);
    ps.lastWorldExitY = Math.floor(mapSt.worldY / TILE_SIZE);
    saveSlotsToDB();
  }
  mapSt.onWorldMap = false;
  setupTopBox(mapId, false);
  if (mapId >= 1000) { _loadDungeonFloor(mapId, returnX, returnY); }
  else {
    // Leaving dungeon → respawn the boss next time we re-enter.
    battleSt.enemyDefeated = false;
    _loadRegularMap(mapId, returnX, returnY);
  }
  // Secondary save for inventory / HP / etc. picked up between the
  // entrance and the new map load. Position is null (onWorldMap=false
  // now), so this won't touch the entrance coords we just wrote.
  saveSlotsToDB();
}

function _landOnWorldMap(tileX, tileY) {
  mapSt.worldX = tileX * TILE_SIZE;
  mapSt.worldY = tileY * TILE_SIZE;
  mapSt.disabledTrigger = { x: tileX, y: tileY };
  mapSt.moving = false;
  sprite.setDirection(DIR_DOWN);
  sprite.resetFrame();
  // Death-respawn point: any time the player lands on overworld (from a town
  // exit, dungeon exit, or warp), this is "the last place they exited" — used
  // as the respawn target if they die on overworld later.
  ps.lastWorldExitX = tileX;
  ps.lastWorldExitY = tileY;
  playTrack(TRACKS.WORLD_MAP);
}

export function loadWorldMapAt(trigId) {
  mapSt.onWorldMap = true;
  mapSt.dungeonFloor = -1;
  mapSt.mapRenderer = null;
  mapSt.mapData = null;
  mapSt.bossSprite = null;
  battleSt.enemyDefeated = false; // boss respawns whenever player exits to the world map
  clearNpcs();
  setupTopBox(0, true);
  const pos = mapSt.worldMapData.triggerPositions.get(trigId);
  const tileX = pos ? pos.x : 0;
  const tileY = pos ? pos.y : 0;
  _landOnWorldMap(tileX, tileY);
  saveSlotsToDB();
}

export function loadWorldMapAtPosition(tileX, tileY) {
  mapSt.onWorldMap = true;
  mapSt.dungeonFloor = -1;
  mapSt.encounterSteps = 0;
  battleSt.enemyDefeated = false;
  mapSt.mapRenderer = null;
  mapSt.mapData = null;
  clearNpcs();
  setupTopBox(0, true);
  _landOnWorldMap(tileX, tileY);
  saveSlotsToDB();
}

// Wipe-and-respawn after a player KO. Single chokepoint for the post-death
// load: battle-update calls this after resetting hp/mp/death timers.
//
// Rule: always respawn at the LAST OVERWORLD EXIT POINT (`ps.lastWorldExitX/Y`,
// set by `_landOnWorldMap` whenever the player lands on the world map from a
// town/dungeon exit or warp). This means:
//   - Die on overworld → respawn at the spot you most recently came out of a
//     structure (the meaningful "checkpoint").
//   - Die in a dungeon → respawn OUTSIDE the dungeon on the world map at its
//     overworld entrance tile. You lose dungeon progress; this matches the
//     user's expectation that "death dumps you outside the cave, not at floor
//     1's entrance tile inside it" (caught 2026-05-09 — Altar Cave death sent
//     player to the cave's interior entrance, which felt like progress retained
//     when really HP/MP got restored without leaving the dungeon).
//   - Die in a town → respawn outside on overworld, same rule.
//
// Fallback: if `lastWorldExitX/Y` is null (fresh save that died in its very
// first encounter before ever exiting Ur), fall back to `ps.lastTown` (default
// Ur, 114).
export function respawnAfterDeath() {
  // Death in Ur (the starting town) sends the player back to the
  // opening-scene spawn at map 7 (4, 4) — the "home/safe haven"
  // checkpoint. mapStack reseeds with the canonical Ur → elder house
  // ground floor (map 6) → upstairs (map 7) path so walking out drops
  // the player back at Ur via the natural door chain.
  if (mapSt.currentMapId === 114) {
    triggerWipe(() => {
      mapSt.dungeonFloor = -1;
      mapSt.encounterSteps = 0;
      mapSt.mapStack = [
        { mapId: 114, x:  9 * TILE_SIZE, y: 26 * TILE_SIZE },
        { mapId:   6, x: 12 * TILE_SIZE, y: 13 * TILE_SIZE },
      ];
      loadMapById(7, 4, 4);
    }, 7);
    return;
  }
  const exitX = ps.lastWorldExitX;
  const exitY = ps.lastWorldExitY;
  const useExit = exitX != null && exitY != null;
  const fallbackMapId = ps.lastTown || 114;
  // Pass a concrete destMapId so `rosterLocChanged` computes correctly
  // (`triggerWipe` returns false when destMapId is null — pre-v1.7.227
  // the world-exit respawn path skipped the trans-fade and let the
  // 400 ms battle fade ramp in *during* the 733 ms wipe-close,
  // brightening the roster panel under the closing bars).
  // `rosterLocForMapId('world')` returns 'world' — the roster module
  // already handles the string sentinel.
  const destForFade = useExit ? 'world' : fallbackMapId;
  triggerWipe(() => {
    mapSt.dungeonFloor = -1;
    mapSt.encounterSteps = 0;
    mapSt.mapStack = [];
    if (useExit) {
      loadWorldMapAtPosition(exitX, exitY);
    } else {
      loadMapById(fallbackMapId);
    }
  }, destForFade);
}
