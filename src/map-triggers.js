// Map triggers — tile-based and walk-on event handlers
// Extracted from game.js: checkTrigger, _checkWorldMapTrigger, _checkHiddenTrap,
// _checkDynType1, _checkDynType4, _checkExitPrev, _triggerMapTransition,
// _handleChest, _handleSecretWall, _handleRockPuzzle, _handlePondHeal,
// applyPassage, openPassage, findWorldExitIndex

import { playSFX, SFX, playTrack, TRACKS } from './music.js';
import { MapRenderer } from './map-renderer.js';
import { clearDungeonCache } from './dungeon-generator.js';
import { transSt, topBoxSt, startWipeTransition } from './transitions.js';
import { resetIndoorWaterCache } from './water-animation.js';
import { showMsgBox } from './message-box.js';
import { POND_RESTORED } from './data/strings.js';
import { ps } from './player-stats.js';
import { getItemNameClean } from './text-decoder.js';
import { mapSt } from './map-state.js';
import { rebuildFlameSprites } from './flame-sprites.js';
import { loadMapById, loadWorldMapAt, loadWorldMapAtPosition } from './map-loading.js';
import { rosterLocForMapId, getPlayerLocation } from './roster.js';

const TILE_SIZE = 16;
const BATTLE_FLASH_FRAMES = 65;
const BATTLE_FLASH_FRAME_MS = 16.67;

// Inventory callback — registered at boot to avoid circular import on game.js
let _addItem = null;
export function initMapTriggers({ addItem }) { _addItem = addItem; }

// Wipe-transition helper — used here and by game.js
export function triggerWipe(action, destMapId) {
  const rc = destMapId != null && rosterLocForMapId(destMapId) !== getPlayerLocation();
  startWipeTransition(action, destMapId, rc);
}

// --- Z-action handlers (called from handleAction in game.js) ---

export function handleChest(facedX, facedY) {
  mapSt.mapData.tilemap[facedY * 32 + facedX] = 0x7D;
  const LOOT_TIERS = [
    { weight: 60, pool: [0xA6, 0xA6, 0xAF, 0xAE] },  // Common:     Potion(2x), Antidote, Eye Drops
    { weight: 28, pool: [0x62, 0x58, 0x1F] },        // Uncommon:   Leather Cap, Leather Shield, Dagger
    { weight: 10, pool: [0x73, 0x8B, 0x24] },        // Rare:       Leather Armor, Bronze Bracers, Longsword
    { weight:  2, pool: [0xB2] },                    // Legendary:  SouthWind
  ];
  let roll = Math.random() * 100;
  let tier = LOOT_TIERS[0];
  for (const t of LOOT_TIERS) { if (roll < t.weight) { tier = t; break; } roll -= t.weight; }
  const itemId = tier.pool[Math.floor(Math.random() * tier.pool.length)];
  _addItem(itemId, 1);
  playSFX(SFX.TREASURE);
  const itemName = getItemNameClean(itemId);
  const found = [0x8F, 0xD8, 0xDE, 0xD7, 0xCD, 0xFF]; // "Found "
  const msg = new Uint8Array(found.length + itemName.length + 1);
  msg.set(found, 0); msg.set(itemName, found.length);
  msg[found.length + itemName.length] = 0xC4; // "!"
  showMsgBox(msg);
  mapSt.mapRenderer = new MapRenderer(mapSt.mapData, mapSt.worldX / TILE_SIZE, mapSt.worldY / TILE_SIZE);
  resetIndoorWaterCache();
}

export function handleSecretWall(facedX, facedY) {
  mapSt.mapData.tilemap[facedY * 32 + facedX] = 0x30;
  mapSt.secretWalls.delete(`${facedX},${facedY}`);
  mapSt.mapRenderer = new MapRenderer(mapSt.mapData, mapSt.worldX / TILE_SIZE, mapSt.worldY / TILE_SIZE);
  resetIndoorWaterCache();
}

export function handleRockPuzzle() {
  playSFX(SFX.EARTHQUAKE);
  mapSt.shakeActive = true; mapSt.shakeTimer = 0;
  mapSt.shakePendingAction = () => {
    playSFX(SFX.DOOR);
    for (const wt of mapSt.rockSwitch.wallTiles) mapSt.mapData.tilemap[wt.y * 32 + wt.x] = wt.newTile;
    mapSt.rockSwitch = null;
    mapSt.mapRenderer = new MapRenderer(mapSt.mapData, mapSt.worldX / TILE_SIZE, mapSt.worldY / TILE_SIZE);
    resetIndoorWaterCache();
  };
}

export function handlePondHeal() {
  playSFX(SFX.POND_DRINK);
  mapSt.starEffect = {
    frame: 0, radius: 60, angle: 0, spin: false,
    onComplete: () => {
      playSFX(SFX.CURE);
      ps.hp = ps.stats.maxHP;
      ps.mp = ps.stats.maxMP;
      mapSt.pondStrobeTimer = BATTLE_FLASH_FRAMES * BATTLE_FLASH_FRAME_MS;
      setTimeout(() => showMsgBox(POND_RESTORED, null), BATTLE_FLASH_FRAMES * BATTLE_FLASH_FRAME_MS);
    }
  };
}

// --- Passage helpers ---

// Pure — no shared state needed
export function applyPassage(tm) {
  // FF3 $D6/$D7: $5B → $5D (doorframe top), $5C → $5E (walkable passage)
  for (let i = 0; i < tm.length; i++) {
    if (tm[i] === 0x5B) tm[i] = 0x5D;
    if (tm[i] === 0x5C) tm[i] = 0x5E;
  }
}

export function openPassage() {
  playSFX(SFX.EARTHQUAKE);
  mapSt.shakeActive = true;
  mapSt.shakeTimer = 0;
  mapSt.shakePendingAction = () => {
    playSFX(SFX.DOOR);
    applyPassage(mapSt.mapData.tilemap);
    const sx = mapSt.worldX / TILE_SIZE;
    const sy = mapSt.worldY / TILE_SIZE;
    mapSt.mapRenderer = new MapRenderer(mapSt.mapData, sx, sy);
    resetIndoorWaterCache();
    rebuildFlameSprites(mapSt.mapData, mapSt.mapRenderer, TILE_SIZE);
  };
}

// --- Walk-on trigger system ---

export function findWorldExitIndex(mapId, worldMapData) {
  const table = worldMapData.entranceTable;
  for (let i = 0; i < table.length; i++) {
    if (table[i] === mapId) return i;
  }
  return 0; // fallback
}

function _checkWorldMapTrigger(tileX, tileY) {
  const trigger = mapSt.worldMapRenderer.getTriggerAt(tileX, tileY);
  if (!trigger || trigger.type !== 'entrance') return false;
  let destMap = trigger.destMap;
  if (destMap === 0) return false;
  const savedX = tileX, savedY = tileY;
  if (destMap === 111) {
    mapSt.dungeonSeed = Date.now();
    clearDungeonCache();
    destMap = 1000;
    transSt.dungeon = true;
  }
  const finalDest = destMap;
  triggerWipe(() => {
    mapSt.mapStack.push({ mapId: 'world', worldId: 0, x: savedX, y: savedY });
    mapSt.onWorldMap = false;
    loadMapById(finalDest);
    mapSt.disabledTrigger = { x: mapSt.worldX / TILE_SIZE, y: mapSt.worldY / TILE_SIZE };
  }, finalDest);
  return true;
}

function _checkHiddenTrap(trigger, tileX, tileY) {
  if (!mapSt.hiddenTraps || !mapSt.hiddenTraps.has(`${tileX},${tileY}`)) return false;
  mapSt.hiddenTraps.delete(`${tileX},${tileY}`);
  mapSt.mapData.tilemap[tileY * 32 + tileX] = 0x74;
  mapSt.mapRenderer = new MapRenderer(mapSt.mapData, tileX, tileY);
  resetIndoorWaterCache();
  playSFX(SFX.DOOR);
  if (trigger.source === 'dynamic' && trigger.type === 1 &&
      mapSt.dungeonDestinations && mapSt.dungeonDestinations.has(trigger.trigId)) {
    const dest = mapSt.dungeonDestinations.get(trigger.trigId);
    const savedX = mapSt.worldX, savedY = mapSt.worldY;
    transSt.pendingAction = () => {
      mapSt.mapStack.push({ mapId: mapSt.currentMapId, x: savedX, y: savedY });
      loadMapById(dest.mapId);
    };
    transSt.rosterLocChanged = rosterLocForMapId(dest.mapId) !== getPlayerLocation();
    transSt.state = 'trap-reveal'; transSt.timer = 0;
    transSt.dungeon = false; transSt.trapFallPending = true;
    return true;
  }
  return false;
}

function _triggerMapTransition(tileX, tileY, destMapId) {
  const tileId = mapSt.mapData.tilemap[tileY * 32 + tileX];
  const tileM = tileId < 128 ? tileId : tileId & 0x7F;
  const savedX = mapSt.worldX, savedY = mapSt.worldY;
  if ((((mapSt.mapData.collisionByte2[tileM] >> 4) & 0x0F) === 5)) {
    mapSt.mapRenderer.updateTileAt(tileX, tileY, 0x7E); playSFX(SFX.DOOR);
    transSt.state = 'door-opening'; transSt.timer = 0;
    transSt.rosterLocChanged = rosterLocForMapId(destMapId) !== getPlayerLocation();
    transSt.pendingAction = () => { mapSt.mapStack.push({ mapId: mapSt.currentMapId, x: savedX, y: savedY }); loadMapById(destMapId); };
  } else {
    triggerWipe(() => { mapSt.mapStack.push({ mapId: mapSt.currentMapId, x: savedX, y: savedY }); loadMapById(destMapId); }, destMapId);
  }
}

function _checkDynType1(trigger, tileX, tileY) {
  if (!(trigger.source === 'dynamic' && trigger.type === 1)) return false;
  if (mapSt.dungeonDestinations && mapSt.dungeonDestinations.has(trigger.trigId)) {
    const dest = mapSt.dungeonDestinations.get(trigger.trigId);
    if (dest.goBack) {
      const prevMapId = mapSt.mapStack.length > 0 ? mapSt.mapStack[mapSt.mapStack.length - 1].mapId : null;
      triggerWipe(() => {
        if (mapSt.mapStack.length > 0) {
          const prev = mapSt.mapStack.pop();
          loadMapById(prev.mapId, prev.x / TILE_SIZE, prev.y / TILE_SIZE);
          if (prev.mapId >= 1000 && prev.mapId < 1004) playTrack(TRACKS.CRYSTAL_CAVE);
        }
      }, prevMapId);
      return true;
    }
    _triggerMapTransition(tileX, tileY, dest.mapId);
    return true;
  }
  const destMap = mapSt.mapData.entranceData[trigger.trigId];
  if (destMap === 0) return false;
  _triggerMapTransition(tileX, tileY, destMap);
  return true;
}

function _checkDynType4(trigger, tileX, tileY) {
  if (!(trigger.source === 'dynamic' && trigger.type === 4)) return false;
  if (!mapSt.dungeonDestinations || !mapSt.dungeonDestinations.has(trigger.trigId)) return false;
  const dest = mapSt.dungeonDestinations.get(trigger.trigId);
  const savedX = mapSt.worldX, savedY = mapSt.worldY;
  triggerWipe(() => {
    mapSt.mapStack.push({ mapId: mapSt.currentMapId, x: savedX, y: savedY });
    loadMapById(dest.mapId);
  }, dest.mapId);
  return true;
}

function _checkExitPrev() {
  const exitingCrystalRoom = mapSt.currentMapId === 1004;
  const goingToWorld = mapSt.mapStack.length === 0 || mapSt.mapStack[mapSt.mapStack.length - 1].mapId === 'world';
  if (goingToWorld && topBoxSt.isTown && topBoxSt.nameBytes) {
    topBoxSt.state = 'fade-out'; topBoxSt.timer = 0; topBoxSt.fadeStep = 0;
  }
  const exitDestMapId = mapSt.mapStack.length > 0 ? mapSt.mapStack[mapSt.mapStack.length - 1].mapId : 'world';
  triggerWipe(() => {
    if (mapSt.mapStack.length > 0) {
      const prev = mapSt.mapStack.pop();
      if (prev.mapId === 'world') {
        loadWorldMapAtPosition(prev.x, prev.y);
      } else {
        loadMapById(prev.mapId, prev.x / TILE_SIZE, prev.y / TILE_SIZE);
        if (exitingCrystalRoom) playTrack(TRACKS.CRYSTAL_CAVE);
      }
    } else {
      loadWorldMapAt(findWorldExitIndex(mapSt.currentMapId, mapSt.worldMapData));
    }
  }, exitDestMapId);
  return true;
}

export function checkTrigger() {
  const tileX = mapSt.worldX / TILE_SIZE;
  const tileY = mapSt.worldY / TILE_SIZE;
  if (mapSt.disabledTrigger && tileX === mapSt.disabledTrigger.x && tileY === mapSt.disabledTrigger.y) return false;
  if (mapSt.onWorldMap) return _checkWorldMapTrigger(tileX, tileY);
  if (!mapSt.mapRenderer || !mapSt.mapData) return false;
  const trigger = mapSt.mapRenderer.getTriggerAt(tileX, tileY);
  if (!trigger) return false;
  if (_checkHiddenTrap(trigger, tileX, tileY)) return true;
  if (_checkDynType1(trigger, tileX, tileY)) return true;
  if (_checkDynType4(trigger, tileX, tileY)) return true;
  if ((trigger.source === 'collision' || trigger.source === 'entrance') && trigger.trigType === 0) {
    return _checkExitPrev();
  }
  return false;
}
