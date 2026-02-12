// Game Client — canvas rendering, input handling, game loop

import { parseROM, getBytesAt } from './rom-parser.js';
import { readPalettes, NES_SYSTEM_PALETTE, decodeTile } from './tile-decoder.js';
import { Sprite, DIR_DOWN, DIR_UP, DIR_LEFT, DIR_RIGHT } from './sprite.js';
import { loadMap } from './map-loader.js';
import { MapRenderer } from './map-renderer.js';
import { loadWorldMap } from './world-map-loader.js';
import { WorldMapRenderer } from './world-map-renderer.js';
import { generateFloor, clearDungeonCache } from './dungeon-generator.js';
import { initMusic, playTrack, stopMusic, playSFX, startWipeSFX, updateWipeSFX, stopWipeSFX, TRACKS, SFX } from './music.js';

// Jukebox debug mode — press J to toggle, +/- to cycle songs
let jukeboxMode = false;
let jukeboxTrack = 0;

const CANVAS_W = 256;          // 16 metatiles wide (NES resolution)
const CANVAS_H = 240;          // 15 metatiles tall (NES resolution)
const TILE_SIZE = 16;
const WALK_DURATION = 16 * (1000 / 60);  // 16 NES frames at 60fps ≈ 267ms per tile

// ROM offsets
const PALETTE_OFFSET = 0x001680;

let canvas, ctx;
let sprite = null;
let mapRenderer = null;
let mapData = null;
let lastTime = 0;
const keys = {};

// Room transition state
let romRaw = null;
let spritePalette = null;
let currentMapId = 114;
let mapStack = [];  // [{mapId, x, y}] for exit_prev
let disabledTrigger = null;  // {x, y} — spawn exit_prev, disabled so player can't immediately exit
let openDoor = null;         // {x, y, tileId} — door shown open, swap back when player walks off

// World map state
let onWorldMap = false;
let worldMapData = null;
let worldMapRenderer = null;

// Dungeon state
let dungeonSeed = null;
let dungeonFloor = -1;
let dungeonDestinations = null;
let secretWalls = null;
let falseWalls = null;

// Player world position in pixels
let worldX = 0;
let worldY = 0;

// Where the sprite draws on screen (always centered)
const SCREEN_CENTER_X = (CANVAS_W - 16) / 2;    // 120
const SCREEN_CENTER_Y = (CANVAS_H - 16) / 2 - 3; // 109

// Movement state
let moving = false;
let moveStartX = 0;
let moveStartY = 0;
let moveTargetX = 0;
let moveTargetY = 0;
let moveTimer = 0;

// Water animation state
let waterTimer = 0;
let waterTick = 0;    // master tick counter
const WATER_TICK = 4 * (1000 / 60);  // ~67ms per tick

// Flame sprite state
let _flameRawTiles = null; // Map<npcId, [[tl,tr,bl,br], [tl,tr,bl,br]]> — raw decoded pixels
let _flameFrames = null;   // Map<npcId, [canvas, canvas]> — rendered with current map palette
let _flameSprites = [];    // [{npcId, px, py}] — active flame positions for current map

// Screen wipe transition state (FF3-style horizontal band wipe)
// Black bars close from top/bottom edges toward center, then open to reveal new map
const WIPE_DURATION = 27 * (1000 / 60);  // 27 NES frames ≈ 450ms
const WIPE_HOLD = 100;                    // ms to hold on full black
const DOOR_OPEN_DURATION = 0;
let transState = 'none';  // 'none' | 'door-opening' | 'closing' | 'hold' | 'loading' | 'opening'
let transTimer = 0;
let transPendingAction = null;
let transDungeon = false;      // true when this transition is a dungeon entry

// Screen shake state (earthquake effect for secret passages)
const SHAKE_DURATION = 34 * (1000 / 60);  // 2 × 17 NES frames ≈ 567ms
let shakeActive = false;
let shakeTimer = 0;
let shakePendingAction = null;

export function init() {
  canvas = document.getElementById('game-canvas');
  ctx = canvas.getContext('2d');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  ctx.imageSmoothingEnabled = false;

  // Input
  window.addEventListener('keydown', (e) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'z', 'Z'].includes(e.key)) {
      e.preventDefault();
      keys[e.key] = true;
    }
    if (e.key === 'j' || e.key === 'J') {
      jukeboxMode = !jukeboxMode;
      if (!jukeboxMode) stopMusic();
    }
    if (jukeboxMode && (e.key === '=' || e.key === '+')) {
      jukeboxTrack = Math.min(jukeboxTrack + 1, 64);
      playTrack(jukeboxTrack);
    }
    if (jukeboxMode && (e.key === '-' || e.key === '_')) {
      jukeboxTrack = Math.max(jukeboxTrack - 1, 0);
      playTrack(jukeboxTrack);
    }
  });
  window.addEventListener('keyup', (e) => {
    keys[e.key] = false;
  });
}

export function loadROM(arrayBuffer) {
  const rom = parseROM(arrayBuffer);

  document.getElementById('rom-info').textContent =
    `PRG: ${rom.prgBanks} banks (${rom.prgSize / 1024}KB), ` +
    `CHR: ${rom.chrBanks} banks, Mapper: ${rom.mapper}`;

  // Sprite palette (persists across maps)
  const paletteData = getBytesAt(rom, PALETTE_OFFSET, 32);
  const allPalettes = readPalettes(paletteData, 0, 8);
  spritePalette = allPalettes[0];
  romRaw = rom.raw;

  initMusic(romRaw);
  _initFlameRawTiles(romRaw);

  sprite = new Sprite(romRaw, spritePalette);

  // Pre-load world map data
  worldMapData = loadWorldMap(romRaw, 0);
  worldMapRenderer = new WorldMapRenderer(worldMapData);
  _waterCache = null; // rebuild water frames for this world

  // Load starting map
  loadMapById(114);

  lastTime = performance.now();
  requestAnimationFrame(gameLoop);
}

function loadMapById(mapId, returnX, returnY) {
  onWorldMap = false;

  if (mapId >= 1000) {
    // Synthetic dungeon floor
    const floorIndex = mapId - 1000;
    dungeonFloor = floorIndex;
    const result = generateFloor(romRaw, floorIndex, dungeonSeed);
    mapData = result;
    secretWalls = result.secretWalls;
    falseWalls = result.falseWalls;
    dungeonDestinations = result.dungeonDestinations;
    currentMapId = mapId;

    const playerX = returnX !== undefined ? returnX : result.entranceX;
    const playerY = returnY !== undefined ? returnY : result.entranceY;
    worldX = playerX * TILE_SIZE;
    worldY = playerY * TILE_SIZE;

    mapRenderer = new MapRenderer(mapData, playerX, playerY); _indoorWaterCache = null;
    _flameSprites = [];
    disabledTrigger = { x: playerX, y: playerY };
    moving = false;
    sprite.setDirection(DIR_DOWN);
    sprite.resetFrame();
    return;
  }

  // Clear dungeon state when loading a non-dungeon map
  dungeonDestinations = null;
  secretWalls = null;
  falseWalls = null;

  mapData = loadMap(romRaw, mapId);
  currentMapId = mapId;

  // Re-open passage if returning to the secret side
  if (returnX !== undefined) {
    applyPassage(mapData.tilemap);
  }

  // Calculate player start position
  const ex = mapData.entranceX;
  const ey = mapData.entranceY;
  let startX = ex;
  let startY = ey;

  const eMid = mapData.tilemap[ey * 32 + ex];
  const eM = eMid < 128 ? eMid : eMid & 0x7F;
  const eColl = mapData.collision[eM];

  if ((eColl & 0x07) === 3) {
    // Entrance is a wall tile (door from outside). Scan north for the
    // next door tile ($44) and spawn inside the room beyond it.
    let found = false;
    for (let dy = 1; dy < 32 && !found; dy++) {
      const ny = (ey - dy + 32) % 32;
      const mid = mapData.tilemap[ny * 32 + ex];
      if (mid === 0x44) {
        // Found door — spawn at the door tile.
        startY = ny;
        found = true;
      }
    }
    // Fallback: first passable tile south, then north
    if (!found) {
      for (let dy = 1; dy <= 16; dy++) {
        const ny = ey + dy;
        if (ny >= 32) break;
        const mid = mapData.tilemap[ny * 32 + ex];
        if (mid === mapData.fillTile) break;
        const m = mid < 128 ? mid : mid & 0x7F;
        const coll = mapData.collision[m];
        if ((coll & 0x07) !== 3 && !(coll & 0x80)) { startY = ny; found = true; break; }
      }
    }
    if (!found) {
      for (let dy = 1; dy <= 16; dy++) {
        const ny = ey - dy;
        if (ny < 0) break;
        const mid = mapData.tilemap[ny * 32 + ex];
        if (mid === mapData.fillTile) break;
        const m = mid < 128 ? mid : mid & 0x7F;
        const coll = mapData.collision[m];
        if ((coll & 0x07) !== 3 && !(coll & 0x80)) { startY = ny; break; }
      }
    }
  } else {
    // Passable entrance — for door tiles ($44) and exit_prev tiles ($68),
    // spawn 4 tiles north (inside the room). The door/entrance is the exit.
    const entMid = mapData.tilemap[ey * 32 + ex];
    const entM = entMid < 128 ? entMid : entMid & 0x7F;
    const entColl = mapData.collision[entM];
    if (entMid === 0x44) {
      startY = ey;
    } else if ((entColl & 0x80) && ((mapData.collisionByte2[entM] >> 4) & 0x0F) === 0) {
      // Exit_prev entrance — scan north for door $44, spawn there
      for (let dy = 1; dy <= 8; dy++) {
        const ny = ey - dy;
        if (ny < 0) break;
        if (mapData.tilemap[ny * 32 + ex] === 0x44) { startY = ny; break; }
      }
    } else {
      startY = ey;
    }
  }

  // Use return position if provided (coming back via mapStack), else spawn position
  const playerX = returnX !== undefined ? returnX : startX;
  const playerY = returnY !== undefined ? returnY : startY;

  worldX = playerX * TILE_SIZE;
  worldY = playerY * TILE_SIZE;

  // Create renderer with player's actual position for room clip BFS
  mapRenderer = new MapRenderer(mapData, playerX, playerY); _indoorWaterCache = null;

  // Disable the spawn trigger so player doesn't immediately exit.
  // $44 door entrances: always disable (separate exit exists below).
  // Moved spawns (startY !== ey): disable the new position.
  // Exit_prev entrances at original pos (e.g. well): don't disable — it IS the exit.
  if (mapRenderer.hasRoomClip()) {
    const spawnMid = mapData.tilemap[playerY * 32 + playerX];
    if (spawnMid === 0x44 || playerY !== ey) {
      disabledTrigger = { x: playerX, y: playerY };
    } else {
      disabledTrigger = null;
    }
  } else {
    disabledTrigger = null;
  }

  _rebuildFlameSprites();

  // Reset movement state
  moving = false;
  sprite.setDirection(DIR_DOWN);
  sprite.resetFrame();

  // If returning to a door tile, show it as open until player walks off
  openDoor = null;
  if (returnX !== undefined) {
    const trig = mapRenderer.getTriggerAt(playerX, playerY);
    if (trig && trig.source === 'dynamic' && trig.type === 1) {
      const origTileId = mapData.tilemap[playerY * 32 + playerX];
      const origM = origTileId < 128 ? origTileId : origTileId & 0x7F;
      const wasDoor = ((mapData.collisionByte2[origM] >> 4) & 0x0F) === 5;
      if (wasDoor) {
        mapRenderer.updateTileAt(playerX, playerY, 0x7E);
        openDoor = { x: playerX, y: playerY, tileId: origTileId };
      }
    }
  }

  // Music — only change track for top-level maps (towns), not indoor rooms
  if (mapId === 114) playTrack(TRACKS.TOWN_UR);
}

function loadWorldMapAt(trigId) {
  onWorldMap = true;
  mapRenderer = null;
  mapData = null;

  // Place player on the leftmost entrance trigger tile
  const pos = worldMapData.triggerPositions.get(trigId);
  const tileX = pos ? pos.x : 0;
  const tileY = pos ? pos.y : 0;
  worldX = tileX * TILE_SIZE;
  worldY = tileY * TILE_SIZE;

  disabledTrigger = { x: tileX, y: tileY };
  moving = false;
  sprite.setDirection(DIR_DOWN);
  sprite.resetFrame();
  playTrack(TRACKS.WORLD_MAP);
}

function loadWorldMapAtPosition(tileX, tileY) {
  onWorldMap = true;
  mapRenderer = null;
  mapData = null;

  worldX = tileX * TILE_SIZE;
  worldY = tileY * TILE_SIZE;

  disabledTrigger = { x: tileX, y: tileY };
  moving = false;
  sprite.setDirection(DIR_DOWN);
  sprite.resetFrame();
  playTrack(TRACKS.WORLD_MAP);
}

function startMove(dir) {
  // Calculate target tile
  const dx = dir === DIR_RIGHT ? TILE_SIZE : dir === DIR_LEFT ? -TILE_SIZE : 0;
  const dy = dir === DIR_DOWN ? TILE_SIZE : dir === DIR_UP ? -TILE_SIZE : 0;
  const targetX = worldX + dx;
  const targetY = worldY + dy;

  // Check collision — face the direction but don't walk
  const tileX = targetX / TILE_SIZE;
  const tileY = targetY / TILE_SIZE;
  const renderer = onWorldMap ? worldMapRenderer : mapRenderer;
  if (renderer && !renderer.isPassable(tileX, tileY)) {
    sprite.setDirection(dir);
    sprite.resetFrame();
    return;
  }

  sprite.setDirection(dir);
  moving = true;
  moveStartX = worldX;
  moveStartY = worldY;
  moveTimer = 0;
  moveTargetX = targetX;
  moveTargetY = targetY;

  // Close open door when player walks off it
  if (openDoor) {
    mapRenderer.updateTileAt(openDoor.x, openDoor.y, openDoor.tileId);
    openDoor = null;
  }
}

function handleInput() {
  if (!sprite) return;
  if (moving) return;
  if (transState !== 'none') return;
  if (shakeActive) return;

  if (keys['z'] || keys['Z']) {
    keys['z'] = false;
    keys['Z'] = false;
    handleAction();
    return;
  }

  if (keys['ArrowDown']) {
    startMove(DIR_DOWN);
  } else if (keys['ArrowUp']) {
    startMove(DIR_UP);
  } else if (keys['ArrowLeft']) {
    startMove(DIR_LEFT);
  } else if (keys['ArrowRight']) {
    startMove(DIR_RIGHT);
  }
}

function handleAction() {
  if (onWorldMap || !mapRenderer || !mapData) return;

  // Get the tile the player is facing
  const dir = sprite.getDirection();
  const tileX = worldX / TILE_SIZE;
  const tileY = worldY / TILE_SIZE;
  const dx = dir === DIR_RIGHT ? 1 : dir === DIR_LEFT ? -1 : 0;
  const dy = dir === DIR_DOWN ? 1 : dir === DIR_UP ? -1 : 0;
  const facedX = tileX + dx;
  const facedY = tileY + dy;

  if (facedX < 0 || facedX >= 32 || facedY < 0 || facedY >= 32) return;

  const facedTile = mapData.tilemap[facedY * 32 + facedX];

  // Third torch ($32 at col 8, row 16) opens hidden passage
  if (facedTile === 0x32 && facedX === 8 && facedY === 16) {
    openPassage();
    return;
  }

  // Chest — press Z to open
  if (facedTile === 0x7C) {
    mapData.tilemap[facedY * 32 + facedX] = 0x7D;
    const sx = worldX / TILE_SIZE;
    const sy = worldY / TILE_SIZE;
    mapRenderer = new MapRenderer(mapData, sx, sy); _indoorWaterCache = null;
    return;
  }

  // Secret wall in dungeon — press Z to open
  if (secretWalls && secretWalls.has(`${facedX},${facedY}`)) {
    mapData.tilemap[facedY * 32 + facedX] = 0x30; // replace with floor
    secretWalls.delete(`${facedX},${facedY}`);
    const sx = worldX / TILE_SIZE;
    const sy = worldY / TILE_SIZE;
    mapRenderer = new MapRenderer(mapData, sx, sy); _indoorWaterCache = null;
    return;
  }

}

function applyPassage(tm) {
  // FF3 $D6/$D7: $5B → $5D (doorframe top), $5C → $5E (walkable passage)
  for (let i = 0; i < tm.length; i++) {
    if (tm[i] === 0x5B) tm[i] = 0x5D;
    if (tm[i] === 0x5C) tm[i] = 0x5E;
  }
}

function openPassage() {
  playSFX(SFX.EARTHQUAKE);
  shakeActive = true;
  shakeTimer = 0;
  shakePendingAction = () => {
    playSFX(SFX.DOOR);
    applyPassage(mapData.tilemap);
    const sx = worldX / TILE_SIZE;
    const sy = worldY / TILE_SIZE;
    mapRenderer = new MapRenderer(mapData, sx, sy); _indoorWaterCache = null;
    _rebuildFlameSprites();
  };
}

function updateMovement(dt) {
  if (!moving) return;

  moveTimer += dt;
  const t = Math.min(moveTimer / WALK_DURATION, 1);

  worldX = moveStartX + (moveTargetX - moveStartX) * t;
  worldY = moveStartY + (moveTargetY - moveStartY) * t;

  sprite.setWalkProgress(t);

  if (t >= 1) {
    worldX = moveTargetX;
    worldY = moveTargetY;
    moving = false;

    // Wrap world coordinates on world map
    if (onWorldMap) {
      const mapPx = worldMapData.mapWidth * TILE_SIZE;
      worldX = ((worldX % mapPx) + mapPx) % mapPx;
      worldY = ((worldY % mapPx) + mapPx) % mapPx;
    }

    // Clear disabled trigger once player moves off it
    if (disabledTrigger) {
      const curTX = worldX / TILE_SIZE;
      const curTY = worldY / TILE_SIZE;
      if (curTX !== disabledTrigger.x || curTY !== disabledTrigger.y) {
        disabledTrigger = null;
      }
    }

    // False ceiling teleport — stepped onto a $44 registered as a teleport
    if (falseWalls && falseWalls.size > 0) {
      const tx = worldX / TILE_SIZE;
      const ty = worldY / TILE_SIZE;
      const key = `${tx},${ty}`;
      if (falseWalls.has(key)) {
        const dest = falseWalls.get(key);
        startWipeTransition(() => {
          worldX = dest.destX * TILE_SIZE;
          worldY = dest.destY * TILE_SIZE;
          sprite.setDirection(DIR_DOWN);
          mapRenderer = new MapRenderer(mapData, dest.destX, dest.destY); _indoorWaterCache = null;
        });
        return;
      }
    }

    // Check for trigger at current tile
    if (checkTrigger()) return; // transition happened, skip input chaining

    if (keys['ArrowDown']) {
      startMove(DIR_DOWN);
    } else if (keys['ArrowUp']) {
      startMove(DIR_UP);
    } else if (keys['ArrowLeft']) {
      startMove(DIR_LEFT);
    } else if (keys['ArrowRight']) {
      startMove(DIR_RIGHT);
    } else {
      sprite.resetFrame();
    }
  }
}

function startWipeTransition(action) {
  transState = 'closing';
  transTimer = 0;
  transPendingAction = action;
  startWipeSFX();
}

function updateTransition(dt) {
  if (transState === 'none') return;

  transTimer += dt;

  if (transState === 'door-opening') {
    if (transTimer >= DOOR_OPEN_DURATION) {
      transState = 'closing';
      transTimer = 0;
      startWipeSFX();
    }
  } else if (transState === 'closing') {
    updateWipeSFX(Math.min(transTimer / WIPE_DURATION, 1));
    if (transTimer >= WIPE_DURATION) {
      transState = 'hold';
      transTimer = 0;
      stopWipeSFX();
      // Execute the map load while screen is fully black
      if (transPendingAction) {
        transPendingAction();
        transPendingAction = null;
      }
    }
  } else if (transState === 'hold') {
    if (transTimer >= WIPE_HOLD) {
      if (transDungeon) {
        transState = 'loading';
        transTimer = 0;
        playTrack(TRACKS.PIANO_3);
      } else {
        transState = 'opening';
        transTimer = 0;
        startWipeSFX();
      }
    }
  } else if (transState === 'loading') {
    if (keys['z'] || keys['Z']) {
      keys['z'] = false;
      keys['Z'] = false;
      transState = 'opening';
      transTimer = 0;
      transDungeon = false;
      playTrack(TRACKS.CRYSTAL_CAVE);
      startWipeSFX();
    }
  } else if (transState === 'opening') {
    updateWipeSFX(1 - Math.min(transTimer / WIPE_DURATION, 1));
    if (transTimer >= WIPE_DURATION) {
      transState = 'none';
      transTimer = 0;
      stopWipeSFX();
    }
  }
}

function drawTransitionOverlay() {
  if (transState === 'none' || transState === 'door-opening') return;

  const halfH = CANVAS_H / 2;
  let barHeight;

  if (transState === 'closing') {
    const t = Math.min(transTimer / WIPE_DURATION, 1);
    barHeight = t * halfH;
  } else if (transState === 'hold' || transState === 'loading') {
    barHeight = halfH;
  } else if (transState === 'opening') {
    const t = Math.min(transTimer / WIPE_DURATION, 1);
    barHeight = (1 - t) * halfH;
  }

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, CANVAS_W, Math.ceil(barHeight));
  ctx.fillRect(0, CANVAS_H - Math.ceil(barHeight), CANVAS_W, Math.ceil(barHeight));

  // Loading screen text overlay
  if (transState === 'loading') {
    ctx.fillStyle = '#fff';
    ctx.font = '16px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('ALTAR CAVE', CANVAS_W / 2, CANVAS_H / 2 - 12);
    if (Math.floor(transTimer / 500) % 2 === 0) {
      ctx.font = '10px monospace';
      ctx.fillText('Press Z', CANVAS_W / 2, CANVAS_H / 2 + 20);
    }
    ctx.textAlign = 'start';
  }
}

function findWorldExitIndex(mapId) {
  // Search the world map entrance table for the entry that leads to this map
  const table = worldMapData.entranceTable;
  for (let i = 0; i < table.length; i++) {
    if (table[i] === mapId) return i;
  }
  return 0; // fallback
}

function checkTrigger() {
  const tileX = worldX / TILE_SIZE;
  const tileY = worldY / TILE_SIZE;

  // Skip the disabled spawn trigger tile
  if (disabledTrigger && tileX === disabledTrigger.x && tileY === disabledTrigger.y) {
    return false;
  }

  // --- World map triggers ---
  if (onWorldMap) {
    const trigger = worldMapRenderer.getTriggerAt(tileX, tileY);
    if (!trigger) return false;

    if (trigger.type === 'entrance') {
      let destMap = trigger.destMap;
      if (destMap === 0) return false;
      const savedX = tileX;
      const savedY = tileY;
      // Altar Cave redirect: intercept map 111 → procedural dungeon
      if (destMap === 111) {
        dungeonSeed = Date.now();
        clearDungeonCache();
        destMap = 1000;
        transDungeon = true;
      }
      const finalDest = destMap;
      startWipeTransition(() => {
        mapStack.push({ mapId: 'world', worldId: 0, x: savedX, y: savedY });
        onWorldMap = false;
        loadMapById(finalDest);
        disabledTrigger = { x: worldX / TILE_SIZE, y: worldY / TILE_SIZE };
      });
      return true;
    }
    return false;
  }

  // --- Indoor map triggers ---
  if (!mapRenderer || !mapData) return false;

  const trigger = mapRenderer.getTriggerAt(tileX, tileY);
  if (!trigger) return false;

  if (trigger.source === 'dynamic' && trigger.type === 1) {
    // Check dungeon destinations first (synthetic maps)
    if (dungeonDestinations && dungeonDestinations.has(trigger.trigId)) {
      const dest = dungeonDestinations.get(trigger.trigId);
      const savedX = worldX;
      const savedY = worldY;
      startWipeTransition(() => {
        mapStack.push({ mapId: currentMapId, x: savedX, y: savedY });
        loadMapById(dest.mapId);
      });
      return true;
    }
    // Entrance/door — load destination map
    const destMap = mapData.entranceData[trigger.trigId];
    if (destMap === 0) return false;
    const savedX = worldX;
    const savedY = worldY;
    // Check if this trigger tile is a door (collision byte2 type 5) vs well/other entrance
    const trigTileId = mapData.tilemap[tileY * 32 + tileX];
    const trigM = trigTileId < 128 ? trigTileId : trigTileId & 0x7F;
    const isDoor = ((mapData.collisionByte2[trigM] >> 4) & 0x0F) === 5;
    if (isDoor) {
      // Swap door tile to open ($7E) and play door creak SFX
      mapRenderer.updateTileAt(tileX, tileY, 0x7E);
      playSFX(SFX.DOOR);
      transState = 'door-opening';
      transTimer = 0;
      transPendingAction = () => {
        mapStack.push({ mapId: currentMapId, x: savedX, y: savedY });
        loadMapById(destMap);
      };
    } else {
      // Non-door entrance (well, stairs, etc.) — just wipe
      startWipeTransition(() => {
        mapStack.push({ mapId: currentMapId, x: savedX, y: savedY });
        loadMapById(destMap);
      });
    }
    return true;
  }

  if (trigger.source === 'collision' || trigger.source === 'entrance') {
    if (trigger.trigType === 0) {
      // exit_prev — wipe out, then pop from map stack
      startWipeTransition(() => {
        if (mapStack.length > 0) {
          const prev = mapStack.pop();
          if (prev.mapId === 'world') {
            // Return to world map at saved position
            loadWorldMapAtPosition(prev.x, prev.y);
          } else {
            loadMapById(prev.mapId, prev.x / TILE_SIZE, prev.y / TILE_SIZE);
          }
        } else {
          // Empty stack — exit to world map. Find the entrance table entry
          // that points back to this map to get the correct exit position.
          const exitIndex = findWorldExitIndex(currentMapId);
          loadWorldMapAt(exitIndex);
        }
      });
      return true;
    }
  }

  return false;
}

// Self-contained water animation (bypasses cached renderer modules)
// Horizontal ($22-$25): 8-bit circular LEFT shift per tile (user-approved)
// Vertical ($26-$27): row rotation DOWN (NES bank 3D $B83F)
const HORIZ_CHR = new Set([0x22, 0x23, 0x24, 0x25]);
const VERT_CHR = [0x26, 0x27];
const ANIM_CHR = new Set([0x22, 0x23, 0x24, 0x25, 0x26, 0x27]);
let _waterCache = null;

function _getPlane0(pixels) {
  const p = new Uint8Array(8);
  for (let r = 0; r < 8; r++) {
    let b = 0;
    for (let c = 0; c < 8; c++) b |= (pixels[r * 8 + c] & 1) << (7 - c);
    p[r] = b;
  }
  return p;
}

function _rebuild(plane0, plane1pix) {
  const px = new Uint8Array(64);
  for (let r = 0; r < 8; r++) {
    const b = plane0[r];
    for (let c = 0; c < 8; c++)
      px[r * 8 + c] = plane1pix[r * 8 + c] | ((b >> (7 - c)) & 1);
  }
  return px;
}

function _isWater(pixels) {
  for (let i = 0; i < 64; i++) if (!(pixels[i] & 2)) return false;
  return true;
}

function _buildWaterCache(wmr) {
  const { metatiles, chrTiles } = wmr.data;
  const frames = new Map();

  // Horizontal: 16-bit paired circular LEFT shift
  // Pairs ($22,$23) and ($24,$25) shift as 16-bit values across tile boundaries
  const HORIZ_PAIRS = [[0x22, 0x23], [0x24, 0x25]];
  for (const [ciL, ciR] of HORIZ_PAIRS) {
    const bL = chrTiles[ciL], bR = chrTiles[ciR];
    if (!bL || !bR || !_isWater(bL) || !_isWater(bR)) continue;
    const p0L = _getPlane0(bL), p0R = _getPlane0(bR);
    const p1L = bL.map(p => p & 2), p1R = bR.map(p => p & 2);
    const arrL = [], arrR = [];
    let cL = new Uint8Array(p0L), cR = new Uint8Array(p0R);
    for (let f = 0; f < 16; f++) {
      arrL.push(_rebuild(cL, p1L));
      arrR.push(_rebuild(cR, p1R));
      // 16-bit circular LEFT shift: bit 7 of L wraps to bit 0 of R
      const nL = new Uint8Array(8), nR = new Uint8Array(8);
      for (let r = 0; r < 8; r++) {
        const l = cL[r], ri = cR[r];
        const carryL = (l >> 7) & 1;  // MSB of left
        const carryR = (ri >> 7) & 1; // MSB of right
        nL[r] = ((l << 1) | carryR) & 0xFF; // right's MSB wraps to left's LSB
        nR[r] = ((ri << 1) | carryL) & 0xFF; // left's MSB wraps to right's LSB
      }
      cL = nL; cR = nR;
    }
    frames.set(ciL, arrL);
    frames.set(ciR, arrR);
  }

  // Vertical: row rotation down, 8 frames (no per-row offset — NES
  // refreshes all 16 vertical bytes within one rotation period)
  for (const ci of VERT_CHR) {
    const base = chrTiles[ci];
    if (!base || !_isWater(base)) continue;
    const p0 = _getPlane0(base);
    const p1 = base.map(p => p & 2);
    const arr = [];
    for (let f = 0; f < 8; f++) {
      const rot = new Uint8Array(8);
      for (let r = 0; r < 8; r++) rot[r] = p0[((r - f) % 8 + 8) % 8];
      arr.push(_rebuild(rot, p1));
    }
    frames.set(ci, arr);
  }

  // Find animated metatiles
  const metas = [];
  for (let m = 0; m < 128; m++) {
    const mt = metatiles[m];
    if (ANIM_CHR.has(mt.tl) || ANIM_CHR.has(mt.tr) ||
        ANIM_CHR.has(mt.bl) || ANIM_CHR.has(mt.br)) {
      metas.push(m);
    }
  }
  return { frames, metas };
}

function _updateWorldWater(wmr) {
  if (!wmr || !wmr._atlas) return;
  if (!_waterCache) _waterCache = _buildWaterCache(wmr);
  const { frames, metas } = _waterCache;
  if (metas.length === 0) return;

  const { metatiles, chrTiles, palettes, tileAttrs } = wmr.data;
  const actx = wmr._atlas.getContext('2d');
  const tileImg = actx.createImageData(8, 8);
  const td = tileImg.data;

  // Derive shift state and cascade progress from waterTick
  const hShift = Math.floor(waterTick / 8) % 16;    // current shift (16-bit cycle)
  const hPrev = (hShift + 15) % 16;                  // previous shift
  const subRow = waterTick % 8;                       // which row is being "refreshed" (0-7)
  const vFrame = Math.floor(waterTick / 8) % 8;

  for (const m of metas) {
    const meta = metatiles[m];
    const palIdx = tileAttrs[m] & 0x03;
    const pal = palettes[palIdx];
    const rgbPal = pal.map(ni => NES_SYSTEM_PALETTE[ni & 0x3F] || [0, 0, 0]);
    const chrs = [meta.tl, meta.tr, meta.bl, meta.br];
    const offs = [[0, 0], [8, 0], [0, 8], [8, 8]];

    for (let q = 0; q < 4; q++) {
      const ci = chrs[q];
      const fr = frames.get(ci);
      if (!fr) {
        // Non-animated quadrant: draw from static CHR
        const tile = chrTiles[ci];
        if (!tile) continue;
        for (let py = 0; py < 8; py++) {
          for (let px = 0; px < 8; px++) {
            const cIdx = tile[py * 8 + px];
            const rgb = rgbPal[cIdx];
            const di = (py * 8 + px) * 4;
            td[di] = rgb[0]; td[di+1] = rgb[1];
            td[di+2] = rgb[2]; td[di+3] = 255;
          }
        }
        actx.putImageData(tileImg, m * 16 + offs[q][0], offs[q][1]);
        continue;
      }

      if (HORIZ_CHR.has(ci)) {
        // Horizontal: per-row cascade. Rows <= subRow use hShift, others use hPrev.
        const curTile = fr[hShift % fr.length];
        const prevTile = fr[hPrev % fr.length];
        for (let py = 0; py < 8; py++) {
          const src = (py <= subRow) ? curTile : prevTile;
          for (let px = 0; px < 8; px++) {
            const cIdx = src[py * 8 + px];
            const rgb = rgbPal[cIdx];
            const di = (py * 8 + px) * 4;
            td[di] = rgb[0]; td[di+1] = rgb[1];
            td[di+2] = rgb[2]; td[di+3] = 255;
          }
        }
      } else {
        // Vertical: uniform frame
        const tile = fr[vFrame % fr.length];
        for (let py = 0; py < 8; py++) {
          for (let px = 0; px < 8; px++) {
            const cIdx = tile[py * 8 + px];
            const rgb = rgbPal[cIdx];
            const di = (py * 8 + px) * 4;
            td[di] = rgb[0]; td[di+1] = rgb[1];
            td[di+2] = rgb[2]; td[di+3] = 255;
          }
        }
      }
      actx.putImageData(tileImg, m * 16 + offs[q][0], offs[q][1]);
    }
  }
}

// --- Flame sprite decoding ---
// Two-frame sprite graphics bank $0A: file offset 0x14010
// NPC #193 (large torch): gfxByte=$40, offset 0x14010, 8 tiles (2 frames × 4)
// NPC #194 (small candle): gfxByte=$41, offset 0x14090, 8 tiles (2 frames × 4)
// Sprite palette 3: transparent, $0F(black), $27(orange), $30(white)
const FLAME_NPC_DEFS = [
  { id: 193, offset: 0x14010 },  // large torch flame
  { id: 194, offset: 0x14090 },  // small candle flame
];
// Decode raw flame tile pixels once from ROM (no palette applied yet)
function _initFlameRawTiles(romData) {
  if (_flameRawTiles) return;
  _flameRawTiles = new Map();

  for (const { id, offset } of FLAME_NPC_DEFS) {
    const frames = [];
    for (let f = 0; f < 2; f++) {
      const tileOff = offset + f * 4 * 16;
      frames.push([
        decodeTile(romData, tileOff),
        decodeTile(romData, tileOff + 16),
        decodeTile(romData, tileOff + 32),
        decodeTile(romData, tileOff + 48),
      ]);
    }
    _flameRawTiles.set(id, frames);
  }
}

// Render flame frame canvases using the current map's actual sprite palettes
function _renderFlameFrames() {
  if (!_flameRawTiles || !mapData || !mapData.spritePalettes) return;
  _flameFrames = new Map();

  const sp = mapData.spritePalettes; // [pal6, pal7] — NES color indices

  // Determine which palette each flame NPC type uses from map's NPC flags
  // palCombo (flags bits 3-2): 0,1 → sprite pal 2 (pal6), 2,3 → sprite pal 3 (pal7)
  const npcPalIdx = new Map(); // npcId → 0 (pal6) or 1 (pal7)
  if (mapData.npcs) {
    for (const npc of mapData.npcs) {
      if (!_flameRawTiles.has(npc.id) || npcPalIdx.has(npc.id)) continue;
      const palCombo = (npc.flags >> 2) & 3;
      npcPalIdx.set(npc.id, palCombo >= 2 ? 1 : 0);
    }
  }
  // Defaults: torch #193 → pal6(0), candle #194 → pal7(1)
  if (!npcPalIdx.has(193)) npcPalIdx.set(193, 0);
  if (!npcPalIdx.has(194)) npcPalIdx.set(194, 1);

  for (const [id, rawFrames] of _flameRawTiles) {
    const nesPal = sp[npcPalIdx.get(id) || 0];
    // Convert NES color indices to RGB via system palette
    const rgbPal = nesPal.map(ci => NES_SYSTEM_PALETTE[ci & 0x3F]);

    const canvases = [];
    for (const tiles of rawFrames) {
      const c = document.createElement('canvas');
      c.width = 16; c.height = 16;
      const fctx = c.getContext('2d');
      const img = fctx.createImageData(16, 16);
      const d = img.data;

      const offsets = [[0, 0], [8, 0], [0, 8], [8, 8]];
      for (let q = 0; q < 4; q++) {
        const tile = tiles[q];
        const [ox, oy] = offsets[q];
        for (let py = 0; py < 8; py++) {
          for (let px = 0; px < 8; px++) {
            const ci = tile[py * 8 + px];
            const di = ((oy + py) * 16 + (ox + px)) * 4;
            if (ci === 0) {
              d[di + 3] = 0; // transparent
            } else {
              const rgb = rgbPal[ci];
              d[di] = rgb[0]; d[di + 1] = rgb[1];
              d[di + 2] = rgb[2]; d[di + 3] = 255;
            }
          }
        }
      }
      fctx.putImageData(img, 0, 0);
      canvases.push(c);
    }
    _flameFrames.set(id, canvases);
  }
}

// Tileset 5 background tiles that need flame overlays
const FLAME_TILE_MAP_TS5 = new Map([
  [0x02, 194],  // candle wall → small candle flame
  [0x31, 193],  // torch mount → large torch flame
  [0x32, 194],  // torch → small candle flame
]);

function _rebuildFlameSprites() {
  _flameSprites = [];
  if (!mapData || !_flameRawTiles) return;
  _renderFlameFrames();
  const flameMap = mapData.tileset === 5 ? FLAME_TILE_MAP_TS5 : null;
  if (!flameMap) return;
  const rc = mapRenderer && mapRenderer.hasRoomClip() ? mapRenderer.getRoomClip() : null;
  const { tilemap } = mapData;
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const mid = tilemap[y * 32 + x];
      const npcId = flameMap.get(mid);
      if (npcId === undefined) continue;
      const px = x * TILE_SIZE;
      const py = y * TILE_SIZE;
      if (rc && (px < rc.x || px >= rc.x + rc.w || py < rc.y || py >= rc.y + rc.h)) continue;
      _flameSprites.push({ npcId, px, py });
    }
  }
}

let _indoorWaterCache = null;

function _buildIndoorWaterCache(mr) {
  const { chrTiles, metatiles, tilemap } = mr.mapData;
  const frames = new Map();

  // Horizontal: 16-bit paired LEFT shift, 16 frames
  const HORIZ_PAIRS_I = [[0x22, 0x23], [0x24, 0x25]];
  for (const [ciL, ciR] of HORIZ_PAIRS_I) {
    const bL = chrTiles[ciL], bR = chrTiles[ciR];
    if (!bL || !bR || !_isWater(bL) || !_isWater(bR)) continue;
    const p0L = _getPlane0(bL), p0R = _getPlane0(bR);
    const p1L = bL.map(p => p & 2), p1R = bR.map(p => p & 2);
    const arrL = [], arrR = [];
    let cL = new Uint8Array(p0L), cR = new Uint8Array(p0R);
    for (let f = 0; f < 16; f++) {
      arrL.push(_rebuild(cL, p1L));
      arrR.push(_rebuild(cR, p1R));
      const nL = new Uint8Array(8), nR = new Uint8Array(8);
      for (let r = 0; r < 8; r++) {
        const l = cL[r], ri = cR[r];
        nL[r] = ((l << 1) | ((ri >> 7) & 1)) & 0xFF;
        nR[r] = ((ri << 1) | ((l >> 7) & 1)) & 0xFF;
      }
      cL = nL; cR = nR;
    }
    frames.set(ciL, arrL);
    frames.set(ciR, arrR);
  }

  // Vertical: row rotation down, 8 frames
  for (const ci of VERT_CHR) {
    const base = chrTiles[ci];
    if (!base || !_isWater(base)) continue;
    const p0 = _getPlane0(base);
    const p1 = base.map(p => p & 2);
    const arr = [];
    for (let f = 0; f < 8; f++) {
      const rot = new Uint8Array(8);
      for (let r = 0; r < 8; r++) rot[r] = p0[((r - f) % 8 + 8) % 8];
      arr.push(_rebuild(rot, p1));
    }
    frames.set(ci, arr);
  }

  // Find animated positions
  const positions = [];
  const MAP_SIZE = 32;
  for (let ty = 0; ty < MAP_SIZE; ty++) {
    for (let tx = 0; tx < MAP_SIZE; tx++) {
      const mid = tilemap[ty * MAP_SIZE + tx];
      const m = mid < 128 ? mid : mid & 0x7F;
      const mt = metatiles[m];
      if (ANIM_CHR.has(mt.tl) || ANIM_CHR.has(mt.tr) ||
          ANIM_CHR.has(mt.bl) || ANIM_CHR.has(mt.br)) {
        positions.push({ tx, ty, m });
      }
    }
  }
  return { frames, positions };
}

function _updateIndoorWater(mr) {
  if (!mr || !mr._mapCanvas) return;
  if (!_indoorWaterCache) _indoorWaterCache = _buildIndoorWaterCache(mr);
  const { frames, positions } = _indoorWaterCache;
  if (positions.length === 0) return;

  const { metatiles, chrTiles, palettes, tileAttrs } = mr.mapData;
  const fctx = mr._mapCanvas.getContext('2d');
  const tileImg = fctx.createImageData(8, 8);
  const td = tileImg.data;

  const hShift = Math.floor(waterTick / 8) % 16;
  const hPrev = (hShift + 15) % 16;
  const subRow = waterTick % 8;
  const vFrame = Math.floor(waterTick / 8) % 8;

  for (const { tx, ty, m } of positions) {
    const meta = metatiles[m];
    const palIdx = tileAttrs[m] & 0x03;
    const pal = palettes[palIdx];
    const rgbPal = pal.map(ni => NES_SYSTEM_PALETTE[ni & 0x3F] || [0, 0, 0]);
    const chrs = [meta.tl, meta.tr, meta.bl, meta.br];
    const offs = [[0, 0], [8, 0], [0, 8], [8, 8]];

    for (let q = 0; q < 4; q++) {
      const ci = chrs[q];
      const fr = frames.get(ci);
      if (!fr) continue;

      if (HORIZ_CHR.has(ci)) {
        const curTile = fr[hShift % fr.length];
        const prevTile = fr[hPrev % fr.length];
        for (let py = 0; py < 8; py++) {
          const src = (py <= subRow) ? curTile : prevTile;
          for (let px = 0; px < 8; px++) {
            const cIdx = src[py * 8 + px];
            const rgb = rgbPal[cIdx];
            const di = (py * 8 + px) * 4;
            td[di] = rgb[0]; td[di+1] = rgb[1];
            td[di+2] = rgb[2]; td[di+3] = 255;
          }
        }
      } else {
        const tile = fr[vFrame % fr.length];
        for (let py = 0; py < 8; py++) {
          for (let px = 0; px < 8; px++) {
            const cIdx = tile[py * 8 + px];
            const rgb = rgbPal[cIdx];
            const di = (py * 8 + px) * 4;
            td[di] = rgb[0]; td[di+1] = rgb[1];
            td[di+2] = rgb[2]; td[di+3] = 255;
          }
        }
      }
      fctx.putImageData(tileImg, tx * 16 + offs[q][0], ty * 16 + offs[q][1]);
    }
  }
}

function render() {
  let camX = Math.round(worldX);
  const camY = Math.round(worldY);

  // Horizontal screen shake (alternates ±2px on bit 1 of frame counter)
  if (shakeActive) {
    const frame = Math.floor(shakeTimer / (1000 / 60));
    camX += (frame & 2) ? 2 : -2;
  }

  // Camera origin: screen pixel where the camera world position maps to
  const originX = SCREEN_CENTER_X;
  const originY = SCREEN_CENTER_Y + 3; // sprite draws 3px above tile

  const spriteY = SCREEN_CENTER_Y;

  if (onWorldMap && worldMapRenderer) {
    worldMapRenderer.draw(ctx, camX, camY, originX, originY);
    // Water animation: update atlas directly from game.js (bypasses module cache)
    _updateWorldWater(worldMapRenderer);
  } else if (mapRenderer) {
    mapRenderer.draw(ctx, camX, camY, originX, originY);
    _updateIndoorWater(mapRenderer);
  }

  // Flame sprites: draw after background, before player
  if (!onWorldMap && _flameSprites.length > 0) {
    const flameFrame = Math.floor(waterTick / 8) & 1;
    const wLeft = camX - originX;
    const wTop = camY - originY;
    for (const flame of _flameSprites) {
      const sx = flame.px - wLeft;
      const sy = flame.py - wTop;
      if (sx < -16 || sx > CANVAS_W || sy < -16 || sy > CANVAS_H) continue;
      const frames = _flameFrames.get(flame.npcId);
      ctx.drawImage(frames[flameFrame], sx, sy);
    }
  }

  if (sprite) {
    sprite.draw(ctx, SCREEN_CENTER_X, spriteY);
  }

  // Draw overlay tiles (grass, trees) on top of sprite
  if (onWorldMap && worldMapRenderer) {
    worldMapRenderer.drawOverlay(ctx, camX, camY, originX, originY, SCREEN_CENTER_X, spriteY);
  } else if (mapRenderer) {
    mapRenderer.drawOverlay(ctx, camX, camY, originX, originY, SCREEN_CENTER_X, spriteY);
  }
}

function gameLoop(timestamp) {
  const dt = timestamp - lastTime;
  lastTime = timestamp;

  handleInput();
  updateMovement(dt);
  updateTransition(dt);

  // Screen shake update
  if (shakeActive) {
    shakeTimer += dt;
    if (shakeTimer >= SHAKE_DURATION) {
      shakeActive = false;
      if (shakePendingAction) { shakePendingAction(); shakePendingAction = null; }
    }
  }

  // Water animation tick (~67ms each)
  // Shift advances every 8 ticks (~533ms). Rows cascade 1-per-tick.
  waterTimer += dt;
  if (waterTimer >= WATER_TICK) {
    waterTimer %= WATER_TICK;
    waterTick++;
    // Indoor maps: handled by _updateIndoorWater in render()
  }

  render();
  drawTransitionOverlay();

  if (jukeboxMode) {
    ctx.font = '8px monospace';
    ctx.fillStyle = '#c8a832';
    ctx.textAlign = 'left';
    ctx.fillText(`JUKEBOX: Song $${jukeboxTrack.toString(16).toUpperCase().padStart(2, '0')} (${jukeboxTrack})  +/- to change`, 4, 12);
  }

  requestAnimationFrame(gameLoop);
}
