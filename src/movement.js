// movement.js — player movement, input dispatch, tile collision, action handling

import { DIR_DOWN, DIR_UP, DIR_LEFT, DIR_RIGHT } from './sprite.js';
import { mapSt } from './map-state.js';
import { battleSt } from './battle-state.js';
import { transSt } from './transitions.js';
import { inputSt, handleBattleInput, handleRosterInput, handlePauseInput } from './input-handler.js';
import { pauseSt } from './pause-menu.js';
import { msgState, showMsgBox } from './message-box.js';
import { chatState, tabSelectMode } from './chat.js';
import { ps } from './player-stats.js';
import { playSFX, playTrack, TRACKS, SFX } from './music.js';
import { checkTrigger, openPassage, handleChest, handleSecretWall,
         handleRockPuzzle, handlePondHeal, triggerWipe } from './map-triggers.js';
import { loadWorldMapAtPosition } from './map-loading.js';
import { tickRandomEncounter } from './battle-encounter.js';
import { startBattle } from './battle-update.js';
import { MapRenderer } from './map-renderer.js';
import { resetIndoorWaterCache } from './water-animation.js';

const TILE_SIZE = 16;
const WALK_DURATION = 16 * (1000 / 60);  // 16 NES frames at 60fps ≈ 267ms per tile

// ── Injected by initMovement() ─────────────────────────────────────────────
let _keys = {};
let _getSprite = () => null;

export function initMovement({ keys, getSprite }) {
  _keys = keys;
  _getSprite = getSprite;
}

// ── Movement state ─────────────────────────────────────────────────────────
let moveStartX = 0;
let moveStartY = 0;
let moveTargetX = 0;
let moveTargetY = 0;
let moveTimer = 0;

export let poisonFlashTimer = -1;
export function setPoisonFlashTimer(v) { poisonFlashTimer = v; }

// ── Movement ───────────────────────────────────────────────────────────────

export function startMove(dir) {
  const sprite = _getSprite();
  const dx = dir === DIR_RIGHT ? TILE_SIZE : dir === DIR_LEFT ? -TILE_SIZE : 0;
  const dy = dir === DIR_DOWN ? TILE_SIZE : dir === DIR_UP ? -TILE_SIZE : 0;
  const targetX = mapSt.worldX + dx;
  const targetY = mapSt.worldY + dy;

  const tileX = targetX / TILE_SIZE;
  const tileY = targetY / TILE_SIZE;

  // Block walking onto boss sprite tile
  if (mapSt.bossSprite && !battleSt.enemyDefeated && tileX === mapSt.bossSprite.px / TILE_SIZE && tileY === mapSt.bossSprite.py / TILE_SIZE) {
    sprite.setDirection(dir);
    sprite.resetFrame();
    return;
  }

  const renderer = mapSt.onWorldMap ? mapSt.worldMapRenderer : mapSt.mapRenderer;
  if (renderer && !renderer.isPassable(tileX, tileY)) {
    sprite.setDirection(dir);
    sprite.resetFrame();
    if (mapSt.onWorldMap && tileX === 95 && tileY === 45) {
      showMsgBox(new Uint8Array([0x8C,0xD8,0xD6,0xD2,0xD7,0xD0,0xFF,0x9C,0xD8,0xD8,0xD7,0xC4])); // "Coming Soon!"
    }
    return;
  }

  sprite.setDirection(dir);
  mapSt.moving = true;
  moveStartX = mapSt.worldX;
  moveStartY = mapSt.worldY;
  moveTimer = 0;
  moveTargetX = targetX;
  moveTargetY = targetY;

  // Close open door when player walks off it
  if (mapSt.openDoor) {
    mapSt.mapRenderer.updateTileAt(mapSt.openDoor.x, mapSt.openDoor.y, mapSt.openDoor.tileId);
    mapSt.openDoor = null;
  }
}

export function updateMovement(dt) {
  if (!mapSt.moving) return;

  moveTimer += dt;
  const t = Math.min(moveTimer / WALK_DURATION, 1);

  mapSt.worldX = moveStartX + (moveTargetX - moveStartX) * t;
  mapSt.worldY = moveStartY + (moveTargetY - moveStartY) * t;

  _getSprite().setWalkProgress(t);

  if (t >= 1) _onMoveComplete();
}

// ── Input dispatch ─────────────────────────────────────────────────────────

export function handleInput() {
  const sprite = _getSprite();
  if (!sprite) return;
  if (handleBattleInput()) return;
  if (handleRosterInput()) return;
  if (handlePauseInput()) return;

  // Universal message box — Z to dismiss during hold
  if (msgState.state !== 'none') {
    if (msgState.state === 'hold' && (_keys['z'] || _keys['Z'])) {
      _keys['z'] = false; _keys['Z'] = false;
      msgState.state = 'slide-out'; msgState.timer = 0;
    }
    return;
  }

  if (mapSt.moving) return;
  if (transSt.state !== 'none') return;
  if (mapSt.shakeActive) return;
  if (mapSt.starEffect) return;
  if (mapSt.pondStrobeTimer > 0) return;
  if (chatState.expanded) return;
  if (tabSelectMode) return;

  if (_keys['z'] || _keys['Z']) {
    _keys['z'] = false;
    _keys['Z'] = false;
    handleAction();
    return;
  }

  startMoveFromKeys();
}

// ── Tile action (Z press) ──────────────────────────────────────────────────

function handleAction() {
  const sprite = _getSprite();
  if (mapSt.onWorldMap || !mapSt.mapRenderer || !mapSt.mapData) return;

  const dir = sprite.getDirection();
  const tileX = mapSt.worldX / TILE_SIZE;
  const tileY = mapSt.worldY / TILE_SIZE;
  const dx = dir === DIR_RIGHT ? 1 : dir === DIR_LEFT ? -1 : 0;
  const dy = dir === DIR_DOWN ? 1 : dir === DIR_UP ? -1 : 0;
  const facedX = tileX + dx;
  const facedY = tileY + dy;

  if (facedX < 0 || facedX >= 32 || facedY < 0 || facedY >= 32) return;

  // Boss fight trigger
  if (mapSt.bossSprite && !battleSt.enemyDefeated && facedX === 6 && facedY === 8) {
    startBattle();
    return;
  }

  const facedTile = mapSt.mapData.tilemap[facedY * 32 + facedX];

  // Third torch opens hidden passage
  if (facedTile === 0x32 && facedX === 8 && facedY === 16) {
    openPassage();
    return;
  }

  if (facedTile === 0x7C)                                         { handleChest(facedX, facedY); return; }
  if (mapSt.secretWalls && mapSt.secretWalls.has(`${facedX},${facedY}`))      { handleSecretWall(facedX, facedY); return; }
  if (mapSt.rockSwitch && mapSt.rockSwitch.rocks.some(r => facedX === r.x && facedY === r.y)) { handleRockPuzzle(); return; }
  if (mapSt.pondTiles && mapSt.pondTiles.has(`${facedX},${facedY}`))          { handlePondHeal(); return; }
}

// ── Move complete ──────────────────────────────────────────────────────────

function _onMoveComplete() {
  const sprite = _getSprite();
  mapSt.worldX = moveTargetX;
  mapSt.worldY = moveTargetY;
  mapSt.moving = false;

  // Wrap world coordinates on world map
  if (mapSt.onWorldMap) {
    const mapPx = mapSt.worldMapData.mapWidth * TILE_SIZE;
    mapSt.worldX = ((mapSt.worldX % mapPx) + mapPx) % mapPx;
    mapSt.worldY = ((mapSt.worldY % mapPx) + mapPx) % mapPx;
  }

  // Clear disabled trigger once player moves off it
  if (mapSt.disabledTrigger) {
    const curTX = mapSt.worldX / TILE_SIZE;
    const curTY = mapSt.worldY / TILE_SIZE;
    if (curTX !== mapSt.disabledTrigger.x || curTY !== mapSt.disabledTrigger.y) {
      mapSt.disabledTrigger = null;
    }
  }

  // NES poison step damage: -1 HP per step, min 1, SFX + flash
  if (ps.status && ps.status.mask & 0x02 && ps.hp > 1) {
    ps.hp -= 1;
    playSFX(SFX.ATTACK_HIT);
    poisonFlashTimer = 0;
  }

  if (_checkFalseWall()) return;
  if (_checkWarpTile()) return;

  if (checkTrigger()) return;
  if (tickRandomEncounter()) return;

  startMoveFromKeys(true);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function _checkFalseWall() {
  if (!mapSt.falseWalls || mapSt.falseWalls.size === 0) return false;
  const key = `${mapSt.worldX / TILE_SIZE},${mapSt.worldY / TILE_SIZE}`;
  if (!mapSt.falseWalls.has(key)) return false;
  const dest = mapSt.falseWalls.get(key);
  triggerWipe(() => {
    mapSt.worldX = dest.destX * TILE_SIZE;
    mapSt.worldY = dest.destY * TILE_SIZE;
    _getSprite().setDirection(DIR_DOWN);
    mapSt.mapRenderer = new MapRenderer(mapSt.mapData, dest.destX, dest.destY); resetIndoorWaterCache();
  });
  return true;
}

function _checkWarpTile() {
  if (!mapSt.warpTile) return false;
  const tx = mapSt.worldX / TILE_SIZE;
  const ty = mapSt.worldY / TILE_SIZE;
  if (tx !== mapSt.warpTile.x || ty !== mapSt.warpTile.y) return false;
  _getSprite().setDirection(DIR_DOWN);
  playSFX(SFX.WARP);
  mapSt.starEffect = {
    frame: 0, radius: 60, angle: 0, spin: true,
    onComplete: () => {
      triggerWipe(() => {
        while (mapSt.mapStack.length > 0) {
          const entry = mapSt.mapStack.pop();
          if (entry.mapId === 'world') {
            playTrack(TRACKS.WORLD_MAP);
            loadWorldMapAtPosition(entry.x, entry.y);
            return;
          }
        }
      }, 'world');
    }
  };
  return true;
}

export function startMoveFromKeys(resetOnIdle) {
  if (_keys['ArrowDown']) startMove(DIR_DOWN);
  else if (_keys['ArrowUp']) startMove(DIR_UP);
  else if (_keys['ArrowLeft']) startMove(DIR_LEFT);
  else if (_keys['ArrowRight']) startMove(DIR_RIGHT);
  else if (resetOnIdle) _getSprite().resetFrame();
}
