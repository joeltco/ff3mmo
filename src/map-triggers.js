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
import { startChestMimic } from './battle-encounter.js';
import { _nameToBytes } from './text-utils.js';
import { POND_RESTORED } from './data/strings.js';
import { openBed } from './bed.js';
import { ps, grantGil } from './player-stats.js';
import { getItemNameShrines } from './text-decoder.js';
import { mapSt } from './map-state.js';
import { rebuildFlameSprites } from './flame-sprites.js';
import { loadMapById, loadWorldMapAt, loadWorldMapAtPosition } from './map-loading.js';
import { rosterLocForMapId, getPlayerLocation } from './roster.js';
import { addItem } from './inventory.js';
import { saveSlotsToDB } from './save-state.js';

const TILE_SIZE = 16;
const BATTLE_FLASH_FRAMES = 65;
const BATTLE_FLASH_FRAME_MS = 16.67;

// Chest tiles: 0x7C closed (walk-up trigger), 0x7D opened (post-loot).
const OPENED_CHEST = 0x7D;
// Ur town respawns its chests 24h after they're looted. Map set = Ur overworld
// (114) + every Ur interior room (see project_ff3mmo_ur_buildout). Dungeon
// chests (mapId >= 1000) are NOT in here — those reset on cave re-entry via
// the procedural-regen wipe in _checkWorldMapTrigger.
const CHEST_RESET_MS = 24 * 60 * 60 * 1000;
const UR_CHEST_MAPS = new Set([114, 1, 2, 3, 4, 5, 6, 7, 8, 9, 147]);

// Invisible chests — tiles that look like normal terrain (grass, etc.) but
// trigger a chest open on Z, then go silent for 24h. Player discovers by
// pressing Z on the right grass square. Same cooldown machinery as regular
// chests (`ps.consumedTilesAt[mapId][key]`); no `consumedTiles` entry, so
// `_replayConsumedTiles` doesn't paint anything visible. Loot rolls from
// SECRET_LOOT_POOLS (richer than the host map's regular chest pool).
const SECRET_TREASURES = {
  114: new Set([
    '27,8',   // Ur overworld — grass tile near the inn corner.
    '6,12',   // Ur overworld — second hidden treasure.
  ]),
};
// Inlined `{ gil: [...] }` literal here instead of GIL() — GIL is declared
// further down the file and this object literal evaluates at module load.
const SECRET_LOOT_POOLS = {
  114: [
    { weight: 35, pool: [0xA6, 0xAF] },              // Potion, Antidote (common)
    { weight: 30, pool: [{ gil: [100, 250] }] },     // 4-10× a normal Ur chest
    { weight: 20, pool: [0xA9] },                    // Phoenix Down (rare reward)
    { weight: 15, pool: [0xE3] },                    // Cure scroll
  ],
};

export function isSecretTreasure(mapId, x, y) {
  const set = SECRET_TREASURES[mapId];
  return !!(set && set.has(`${x},${y}`));
}

function rollSecretLoot(mapId) {
  const tiers = SECRET_LOOT_POOLS[mapId];
  if (!tiers) return null;
  const total = tiers.reduce((s, t) => s + t.weight, 0);
  let roll = Math.random() * total;
  let tier = tiers[0];
  for (const t of tiers) { if (roll < t.weight) { tier = t; break; } roll -= t.weight; }
  return tier.pool[Math.floor(Math.random() * tier.pool.length)];
}

// Chest loot pools, keyed by map ID. Each tier has a `weight` and a `pool` of
// either item IDs (numbers) or `{ gil: [min, max] }` entries.
// Crystal room (1004) is a boss room and has no chests.
const GIL = (min, max) => ({ gil: [min, max] });
const LOOT_POOLS = {
  114: [ // Ur (town)
    { weight: 70, pool: [0xA6, 0xA6, 0xAF] },                     // Potion(2x), Antidote
    { weight: 30, pool: [GIL(10, 30)] },
  ],
  1000: [ // Altar Cave F1
    { weight: 16, pool: [0xA6] },                                 // Potion (rarer — was 52)
    { weight: 30, pool: [GIL(20, 60)] },
    { weight: 15, pool: [0x62] },                                 // Leather Cap
    { weight:  3, pool: [0xE3, 0xE1] },                           // Cure scroll, Ice scroll (rare)
    { weight: 12, monster: true },                                // Chest mimic — 1 random monster
  ],
  1001: [ // Altar Cave F2
    { weight: 12, pool: [0xA6] },                                 // Potion (rarer — was 42)
    { weight: 30, pool: [GIL(40, 100)] },
    { weight: 20, pool: [0x62, 0x1F, 0x06, 0x0E] },               // Leather Cap, Dagger, Nunchuck, Staff
    { weight:  5, pool: [0x58] },                                 // Leather Shield
    { weight:  3, pool: [0xE3, 0xE1] },                           // Cure scroll, Ice scroll (rare)
    { weight:  2, pool: [0xA9] },                                 // Phoenix Down (very rare revive)
    { weight: 12, monster: true },                                // Chest mimic — 1 random monster
  ],
  1002: [ // Altar Cave F3
    { weight: 9, pool: [0xA6] },                                  // Potion (rarer — was 32)
    { weight: 30, pool: [GIL(75, 175)] },
    { weight: 25, pool: [0x58, 0x1F] },                           // Leather Shield, Dagger
    { weight: 10, pool: [0x73] },                                 // Leather Armor
    { weight:  3, pool: [0xE3, 0xE1] },                           // Cure scroll, Ice scroll (rare)
    { weight:  2, pool: [0xA9] },                                 // Phoenix Down (very rare revive)
    { weight: 12, monster: true },                                // Chest mimic — 1 random monster
  ],
  1003: [ // Altar Cave F4
    { weight: 6, pool: [0xA6] },                                  // Potion (rarer — was 22)
    { weight: 30, pool: [GIL(125, 275)] },
    { weight: 25, pool: [0x73, 0x1F] },                           // Leather Armor, Dagger
    { weight: 20, pool: [0x8B, 0x24] },                           // Bronze Bracers (mage arm), Longsword
    { weight:  3, pool: [0xE3, 0xE1] },                           // Cure scroll, Ice scroll (rare)
    { weight:  3, pool: [0xA9] },                                 // Phoenix Down (rare revive — best floor odds)
    { weight: 12, monster: true },                                // Chest mimic — 1 random monster
  ],
};
const DEFAULT_LOOT = LOOT_POOLS[1000];

function rollLootEntry(mapId) {
  const tiers = LOOT_POOLS[mapId] || DEFAULT_LOOT;
  const total = tiers.reduce((s, t) => s + t.weight, 0);
  let roll = Math.random() * total;
  let tier = tiers[0];
  for (const t of tiers) { if (roll < t.weight) { tier = t; break; } roll -= t.weight; }
  if (tier.monster) return { monster: true };   // chest mimic — caller starts a battle
  return tier.pool[Math.floor(Math.random() * tier.pool.length)];
}

function encodeNumber(n) {
  const s = String(n);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = 0x80 + (s.charCodeAt(i) - 48);
  return out;
}

function foundItemMsg(itemId) {
  const itemName = getItemNameShrines(itemId); // icon byte + Shrines full name
  const found = [0x8F,0xB2,0xB8,0xB1,0xA7,0xFF]; // "Found "
  const msg = new Uint8Array(found.length + itemName.length + 1);
  msg.set(found, 0); msg.set(itemName, found.length);
  msg[found.length + itemName.length] = 0xC4; // "!"
  return msg;
}

function foundGilMsg(amount) {
  const found = [0x8F,0xB2,0xB8,0xB1,0xA7,0xFF];             // "Found "
  const num = encodeNumber(amount);
  const gilWord = [0xFF,0xAA,0xAC,0xAF,0xC4];                 // " gil!"
  const msg = new Uint8Array(found.length + num.length + gilWord.length);
  msg.set(found, 0);
  msg.set(num, found.length);
  msg.set(gilWord, found.length + num.length);
  return msg;
}

// Wipe-transition helper — used here and by game.js
export function triggerWipe(action, destMapId) {
  const rc = destMapId != null && rosterLocForMapId(destMapId) !== getPlayerLocation();
  startWipeTransition(action, destMapId, rc);
}

// --- Z-action handlers (called from handleAction in game.js) ---

// Stamp a tile-mutation into ps.consumedTiles so the change persists across
// map re-entry / save+load (v1.7.215 SAVE-STATE-AUDIT.md #1-3). Mutates the
// in-memory tilemap AND records the mutation keyed by (mapId, "x,y").
function _consumeTile(facedX, facedY, newTileId) {
  mapSt.mapData.tilemap[facedY * 32 + facedX] = newTileId;
  const mapId = mapSt.currentMapId;
  if (mapId == null) return;
  if (!ps.consumedTiles) ps.consumedTiles = {};
  if (!ps.consumedTiles[mapId]) ps.consumedTiles[mapId] = {};
  ps.consumedTiles[mapId][`${facedX},${facedY}`] = newTileId;
}

// Record when a chest was opened so expireResettableChests can respawn it
// later. Parallel to consumedTiles; persisted alongside it (save-state.js).
function _stampChestTime(facedX, facedY) {
  const mapId = mapSt.currentMapId;
  if (mapId == null) return;
  if (!ps.consumedTilesAt) ps.consumedTilesAt = {};
  if (!ps.consumedTilesAt[mapId]) ps.consumedTilesAt[mapId] = {};
  ps.consumedTilesAt[mapId][`${facedX},${facedY}`] = Date.now();
}

// Respawn Ur town chests on a 24h timer. Called on map load BEFORE
// _replayConsumedTiles: any opened-chest mutation that has aged out (or has no
// recorded open-time — i.e. it predates this feature) is dropped from
// consumedTiles, so the fresh-from-ROM tilemap keeps its closed chest. Only
// OPENED_CHEST mutations are touched; secret walls / rock puzzles never expire.
export function expireResettableChests(mapId) {
  if (!UR_CHEST_MAPS.has(mapId)) return;
  const consumed = ps.consumedTiles && ps.consumedTiles[mapId];
  if (!consumed) return;
  const times = (ps.consumedTilesAt && ps.consumedTilesAt[mapId]) || null;
  const now = Date.now();
  for (const key of Object.keys(consumed)) {
    if (consumed[key] !== OPENED_CHEST) continue;
    const t = times && times[key];
    if (t != null && now - t < CHEST_RESET_MS) continue; // still on cooldown
    delete consumed[key];
    if (times) delete times[key];
  }
}

export function handleChest(facedX, facedY) {
  _consumeTile(facedX, facedY, OPENED_CHEST);
  _stampChestTime(facedX, facedY);
  // v1.7.454 — patch the one changed metatile instead of rebuilding the
  // entire MapRenderer (was a ~50-200ms synchronous canvas-rebuild that
  // produced a visible screen flicker on chest open in cave maps).
  if (mapSt.mapRenderer) mapSt.mapRenderer.redrawMetatileAt(facedX, facedY);
  resetIndoorWaterCache();
  saveSlotsToDB();   // chest is consumed regardless of outcome

  const entry = rollLootEntry(mapSt.currentMapId);

  // Chest mimic — "Monster appeared!", then (on dismiss) the normal battle
  // flash + one random monster from this floor's pool.
  if (entry && entry.monster) {
    showMsgBox(_nameToBytes('Monster appeared!'), () => startChestMimic());
    return;
  }

  let msg;
  if (typeof entry === 'object' && entry.gil) {
    const [min, max] = entry.gil;
    const amount = min + Math.floor(Math.random() * (max - min + 1));
    grantGil(amount);
    msg = foundGilMsg(amount);
  } else {
    addItem(entry, 1);
    msg = foundItemMsg(entry);
  }
  playSFX(SFX.TREASURE);
  showMsgBox(msg);
}

// Invisible chest at a hidden-treasure tile. Caller (movement._handleAction)
// has already confirmed via isSecretTreasure that (facedX, facedY) is a
// registered secret on the current map. Returns true if loot was awarded,
// false if the secret is still on its 24h cooldown (caller falls through —
// no Z action, tile reads as plain grass).
export function handleSecretTreasure(facedX, facedY) {
  const mapId = mapSt.currentMapId;
  if (mapId == null) return false;
  const key = `${facedX},${facedY}`;
  const lootedAt = ps.consumedTilesAt && ps.consumedTilesAt[mapId] && ps.consumedTilesAt[mapId][key];
  if (lootedAt != null && Date.now() - lootedAt < CHEST_RESET_MS) return false;

  _stampChestTime(facedX, facedY);  // cooldown only — no _consumeTile, tile stays grass
  saveSlotsToDB();

  const entry = rollSecretLoot(mapId);
  if (entry == null) return false;
  let msg;
  if (typeof entry === 'object' && entry.gil) {
    const [min, max] = entry.gil;
    const amount = min + Math.floor(Math.random() * (max - min + 1));
    grantGil(amount);
    msg = foundGilMsg(amount);
  } else {
    addItem(entry, 1);
    msg = foundItemMsg(entry);
  }
  playSFX(SFX.TREASURE);
  showMsgBox(msg);
  return true;
}

export function handleSecretWall(facedX, facedY) {
  _consumeTile(facedX, facedY, 0x30);
  mapSt.secretWalls.delete(`${facedX},${facedY}`);
  // v1.7.454 — single-tile patch.
  if (mapSt.mapRenderer) mapSt.mapRenderer.redrawMetatileAt(facedX, facedY);
  resetIndoorWaterCache();
  saveSlotsToDB();
}

export function handleRockPuzzle() {
  playSFX(SFX.EARTHQUAKE);
  mapSt.shakeActive = true; mapSt.shakeTimer = 0;
  mapSt.shakePendingAction = () => {
    playSFX(SFX.DOOR);
    // v1.7.454 — patch each changed wall tile in place rather than rebuilding
    // the renderer. Capture the list before _consumeTile mutates state.
    const wallTiles = mapSt.rockSwitch.wallTiles.slice();
    for (const wt of wallTiles) _consumeTile(wt.x, wt.y, wt.newTile);
    mapSt.rockSwitch = null;
    if (mapSt.mapRenderer) {
      for (const wt of wallTiles) mapSt.mapRenderer.redrawMetatileAt(wt.x, wt.y);
    }
    resetIndoorWaterCache();
    saveSlotsToDB();
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
      saveSlotsToDB();
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
    // Procedural dungeon: each run gets a fresh seed → fresh layout. The
    // `ps.consumedTiles[mapId]` overrides from a previous run point at
    // (x,y) coords that no longer correspond to anything in the new
    // layout, so leaving them in place draws "ghost" open chests on
    // floor tiles. Wipe any dungeon-range mapIds (>=1000) to clear the
    // slate; town mapIds (<1000) keep their persisted state.
    if (ps.consumedTiles) {
      for (const key of Object.keys(ps.consumedTiles)) {
        if (Number(key) >= 1000) delete ps.consumedTiles[key];
      }
    }
    if (ps.consumedTilesAt) {
      for (const key of Object.keys(ps.consumedTilesAt)) {
        if (Number(key) >= 1000) delete ps.consumedTilesAt[key];
      }
    }
    destMap = 1000;
    transSt.dungeon = true;
  }
  const finalDest = destMap;
  triggerWipe(() => {
    mapSt.mapStack.push({ mapId: 'world', worldId: 0, x: savedX, y: savedY });
    // DO NOT pre-flip `mapSt.onWorldMap = false` here. `loadMapById` captures
    // the entrance tile into `ps.lastWorldExitX/Y` + saves the slot's
    // `worldX/Y/onWorldMap/currentMapId` ONLY when `mapSt.onWorldMap` is still
    // true at entry. Flipping early means the slot's position never updates
    // to the town/dungeon entrance, and logout-then-login respawns wherever
    // `_landOnWorldMap` last wrote — typically the previous cave exit tile.
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
  // Bed tiles aren't ROM trigger tiles, so check them before the trigger
  // lookup (which would early-return null). Stepping onto a bed → rest scene.
  if (mapSt.mapRenderer.isBedTileAt(tileX, tileY)) { openBed(); return true; }
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
