// Map triggers — tile-based and walk-on event handlers
// Extracted from game.js: checkTrigger, _checkWorldMapTrigger, _checkHiddenTrap,
// _checkDynType1, _checkDynType4, _checkExitPrev, _triggerMapTransition,
// _handleChest, _handleSecretWall, _handleRockPuzzle, _handlePondHeal,
// applyPassage, openPassage, findWorldExitIndex

import { playSFX, SFX, playTrack, TRACKS } from './music.js';
import { MapRenderer } from './map-renderer.js';
import { clearDungeonCache } from './dungeon-generator.js';
import { transSt, topBoxSt } from './transitions.js';
import { resetIndoorWaterCache } from './water-animation.js';
import { showMsgBox } from './message-box.js';
import { POND_RESTORED } from './data/strings.js';
import { ps } from './player-stats.js';
import { getItemNameClean } from './text-decoder.js';

// Module-level shared context — set at the start of each exported entry point
let _s = null;

// --- Z-action handlers (called from handleAction in game.js) ---

export function handleChest(facedX, facedY, shared) {
  _s = shared;
  _s.mapData.tilemap[facedY * 32 + facedX] = 0x7D;
  const LOOT_TIERS = [
    { weight: 60, pool: [0xA6] },                    // Common:     Potion
    { weight: 28, pool: [0x62, 0x58, 0x1F] },        // Uncommon:   Leather Cap, Leather Shield, Dagger
    { weight: 10, pool: [0x73, 0x8B, 0x24] },        // Rare:       Leather Armor, Bronze Bracers, Longsword
    { weight:  2, pool: [0xB2] },                    // Legendary:  SouthWind
  ];
  let roll = Math.random() * 100;
  let tier = LOOT_TIERS[0];
  for (const t of LOOT_TIERS) { if (roll < t.weight) { tier = t; break; } roll -= t.weight; }
  const itemId = tier.pool[Math.floor(Math.random() * tier.pool.length)];
  _s.addItem(itemId, 1);
  playSFX(SFX.TREASURE);
  const itemName = getItemNameClean(itemId);
  const found = [0x8F, 0xD8, 0xDE, 0xD7, 0xCD, 0xFF]; // "Found "
  const msg = new Uint8Array(found.length + itemName.length + 1);
  msg.set(found, 0); msg.set(itemName, found.length);
  msg[found.length + itemName.length] = 0xC4; // "!"
  showMsgBox(msg);
  _s.mapRenderer = new MapRenderer(_s.mapData, _s.worldX / _s.TILE_SIZE, _s.worldY / _s.TILE_SIZE);
  resetIndoorWaterCache();
}

export function handleSecretWall(facedX, facedY, shared) {
  _s = shared;
  _s.mapData.tilemap[facedY * 32 + facedX] = 0x30;
  _s.secretWalls.delete(`${facedX},${facedY}`);
  _s.mapRenderer = new MapRenderer(_s.mapData, _s.worldX / _s.TILE_SIZE, _s.worldY / _s.TILE_SIZE);
  resetIndoorWaterCache();
}

export function handleRockPuzzle(shared) {
  _s = shared;
  playSFX(SFX.EARTHQUAKE);
  _s.shakeActive = true; _s.shakeTimer = 0;
  _s.shakePendingAction = () => {
    playSFX(SFX.DOOR);
    for (const wt of _s.rockSwitch.wallTiles) _s.mapData.tilemap[wt.y * 32 + wt.x] = wt.newTile;
    _s.rockSwitch = null;
    _s.mapRenderer = new MapRenderer(_s.mapData, _s.worldX / _s.TILE_SIZE, _s.worldY / _s.TILE_SIZE);
    resetIndoorWaterCache();
  };
}

export function handlePondHeal(shared) {
  _s = shared;
  playSFX(SFX.POND_DRINK);
  _s.starEffect = {
    frame: 0, radius: 60, angle: 0, spin: false,
    onComplete: () => {
      playSFX(SFX.CURE);
      ps.hp = ps.stats.maxHP;
      ps.mp = ps.stats.maxMP;
      _s.pondStrobeTimer = _s.BATTLE_FLASH_FRAMES * _s.BATTLE_FLASH_FRAME_MS;
      setTimeout(() => showMsgBox(POND_RESTORED, null), _s.BATTLE_FLASH_FRAMES * _s.BATTLE_FLASH_FRAME_MS);
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

export function openPassage(shared) {
  _s = shared;
  playSFX(SFX.EARTHQUAKE);
  _s.shakeActive = true;
  _s.shakeTimer = 0;
  _s.shakePendingAction = () => {
    playSFX(SFX.DOOR);
    applyPassage(_s.mapData.tilemap);
    const sx = _s.worldX / _s.TILE_SIZE;
    const sy = _s.worldY / _s.TILE_SIZE;
    _s.mapRenderer = new MapRenderer(_s.mapData, sx, sy);
    resetIndoorWaterCache();
    _s._rebuildFlameSprites();
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
  const trigger = _s.worldMapRenderer.getTriggerAt(tileX, tileY);
  if (!trigger || trigger.type !== 'entrance') return false;
  let destMap = trigger.destMap;
  if (destMap === 0) return false;
  const savedX = tileX, savedY = tileY;
  if (destMap === 111) {
    _s.dungeonSeed = Date.now();
    clearDungeonCache();
    destMap = 1000;
    transSt.dungeon = true;
  }
  const finalDest = destMap;
  _s._triggerWipe(() => {
    _s.mapStack.push({ mapId: 'world', worldId: 0, x: savedX, y: savedY });
    _s.onWorldMap = false;
    _s.loadMapById(finalDest);
    _s.disabledTrigger = { x: _s.worldX / _s.TILE_SIZE, y: _s.worldY / _s.TILE_SIZE };
  }, finalDest);
  return true;
}

function _checkHiddenTrap(trigger, tileX, tileY) {
  if (!_s.hiddenTraps || !_s.hiddenTraps.has(`${tileX},${tileY}`)) return false;
  _s.hiddenTraps.delete(`${tileX},${tileY}`);
  _s.mapData.tilemap[tileY * 32 + tileX] = 0x74;
  _s.mapRenderer = new MapRenderer(_s.mapData, tileX, tileY);
  resetIndoorWaterCache();
  playSFX(SFX.DOOR);
  if (trigger.source === 'dynamic' && trigger.type === 1 &&
      _s.dungeonDestinations && _s.dungeonDestinations.has(trigger.trigId)) {
    const dest = _s.dungeonDestinations.get(trigger.trigId);
    const savedX = _s.worldX, savedY = _s.worldY;
    transSt.pendingAction = () => {
      _s.mapStack.push({ mapId: _s.currentMapId, x: savedX, y: savedY });
      _s.loadMapById(dest.mapId);
    };
    transSt.rosterLocChanged = _s.rosterLocForMapId(dest.mapId) !== _s.getPlayerLocation();
    transSt.state = 'trap-reveal'; transSt.timer = 0;
    transSt.dungeon = false; transSt.trapFallPending = true;
    return true;
  }
  return false;
}

function _triggerMapTransition(tileX, tileY, destMapId) {
  const tileId = _s.mapData.tilemap[tileY * 32 + tileX];
  const tileM = tileId < 128 ? tileId : tileId & 0x7F;
  const savedX = _s.worldX, savedY = _s.worldY;
  if ((((_s.mapData.collisionByte2[tileM] >> 4) & 0x0F) === 5)) {
    _s.mapRenderer.updateTileAt(tileX, tileY, 0x7E); playSFX(SFX.DOOR);
    transSt.state = 'door-opening'; transSt.timer = 0;
    transSt.rosterLocChanged = _s.rosterLocForMapId(destMapId) !== _s.getPlayerLocation();
    transSt.pendingAction = () => { _s.mapStack.push({ mapId: _s.currentMapId, x: savedX, y: savedY }); _s.loadMapById(destMapId); };
  } else {
    _s._triggerWipe(() => { _s.mapStack.push({ mapId: _s.currentMapId, x: savedX, y: savedY }); _s.loadMapById(destMapId); }, destMapId);
  }
}

function _checkDynType1(trigger, tileX, tileY) {
  if (!(trigger.source === 'dynamic' && trigger.type === 1)) return false;
  if (_s.dungeonDestinations && _s.dungeonDestinations.has(trigger.trigId)) {
    const dest = _s.dungeonDestinations.get(trigger.trigId);
    if (dest.goBack) {
      const prevMapId = _s.mapStack.length > 0 ? _s.mapStack[_s.mapStack.length - 1].mapId : null;
      _s._triggerWipe(() => {
        if (_s.mapStack.length > 0) {
          const prev = _s.mapStack.pop();
          _s.loadMapById(prev.mapId, prev.x / _s.TILE_SIZE, prev.y / _s.TILE_SIZE);
          if (prev.mapId >= 1000 && prev.mapId < 1004) playTrack(TRACKS.CRYSTAL_CAVE);
        }
      }, prevMapId);
      return true;
    }
    _triggerMapTransition(tileX, tileY, dest.mapId);
    return true;
  }
  const destMap = _s.mapData.entranceData[trigger.trigId];
  if (destMap === 0) return false;
  _triggerMapTransition(tileX, tileY, destMap);
  return true;
}

function _checkDynType4(trigger, tileX, tileY) {
  if (!(trigger.source === 'dynamic' && trigger.type === 4)) return false;
  if (!_s.dungeonDestinations || !_s.dungeonDestinations.has(trigger.trigId)) return false;
  const dest = _s.dungeonDestinations.get(trigger.trigId);
  const savedX = _s.worldX, savedY = _s.worldY;
  _s._triggerWipe(() => {
    _s.mapStack.push({ mapId: _s.currentMapId, x: savedX, y: savedY });
    _s.loadMapById(dest.mapId);
  }, dest.mapId);
  return true;
}

function _checkExitPrev() {
  const exitingCrystalRoom = _s.currentMapId === 1004;
  const goingToWorld = _s.mapStack.length === 0 || _s.mapStack[_s.mapStack.length - 1].mapId === 'world';
  if (goingToWorld && topBoxSt.isTown && topBoxSt.nameBytes) {
    topBoxSt.state = 'fade-out'; topBoxSt.timer = 0; topBoxSt.fadeStep = 0;
  }
  const exitDestMapId = _s.mapStack.length > 0 ? _s.mapStack[_s.mapStack.length - 1].mapId : 'world';
  _s._triggerWipe(() => {
    if (_s.mapStack.length > 0) {
      const prev = _s.mapStack.pop();
      if (prev.mapId === 'world') {
        _s.loadWorldMapAtPosition(prev.x, prev.y);
      } else {
        _s.loadMapById(prev.mapId, prev.x / _s.TILE_SIZE, prev.y / _s.TILE_SIZE);
        if (exitingCrystalRoom) playTrack(TRACKS.CRYSTAL_CAVE);
      }
    } else {
      _s.loadWorldMapAt(findWorldExitIndex(_s.currentMapId, _s.worldMapData));
    }
  }, exitDestMapId);
  return true;
}

export function checkTrigger(shared) {
  _s = shared;
  const tileX = _s.worldX / _s.TILE_SIZE;
  const tileY = _s.worldY / _s.TILE_SIZE;
  if (_s.disabledTrigger && tileX === _s.disabledTrigger.x && tileY === _s.disabledTrigger.y) return false;
  if (_s.onWorldMap) return _checkWorldMapTrigger(tileX, tileY);
  if (!_s.mapRenderer || !_s.mapData) return false;
  const trigger = _s.mapRenderer.getTriggerAt(tileX, tileY);
  if (!trigger) return false;
  if (_checkHiddenTrap(trigger, tileX, tileY)) return true;
  if (_checkDynType1(trigger, tileX, tileY)) return true;
  if (_checkDynType4(trigger, tileX, tileY)) return true;
  if ((trigger.source === 'collision' || trigger.source === 'entrance') && trigger.trigType === 0) {
    return _checkExitPrev();
  }
  return false;
}
