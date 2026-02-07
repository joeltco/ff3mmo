// Game Client — canvas rendering, input handling, game loop

import { parseROM, getBytesAt } from './rom-parser.js';
import { readPalettes } from './tile-decoder.js';
import { Sprite, DIR_DOWN, DIR_UP, DIR_LEFT, DIR_RIGHT } from './sprite.js';
import { loadMap } from './map-loader.js';
import { MapRenderer } from './map-renderer.js';

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

export function init() {
  canvas = document.getElementById('game-canvas');
  ctx = canvas.getContext('2d');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  ctx.imageSmoothingEnabled = false;

  // Input
  window.addEventListener('keydown', (e) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
      keys[e.key] = true;
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

  sprite = new Sprite(romRaw, spritePalette);

  // Load starting map
  loadMapById(114);

  lastTime = performance.now();
  requestAnimationFrame(gameLoop);
}

function loadMapById(mapId) {
  mapData = loadMap(romRaw, mapId);
  currentMapId = mapId;

  // Calculate player start position (entrance, with wall-entrance nudge)
  const ex = mapData.entranceX;
  const ey = mapData.entranceY;
  let startX = ex;
  let startY = ey;

  // If entrance is a wall tile, nudge south to first walkable tile
  const eMid = mapData.tilemap[ey * 32 + ex];
  const eM = eMid < 128 ? eMid : eMid & 0x7F;
  const eColl = mapData.collision[eM];
  if ((eColl & 0x07) === 3) {
    for (let dy = 1; dy <= 16; dy++) {
      const ny = ey + dy;
      if (ny >= 32) break;
      const mid = mapData.tilemap[ny * 32 + ex];
      const m = mid < 128 ? mid : mid & 0x7F;
      const coll = mapData.collision[m];
      if ((coll & 0x07) !== 3 && !(coll & 0x80)) {
        startY = ny;
        break;
      }
    }
  }

  worldX = startX * TILE_SIZE;
  worldY = startY * TILE_SIZE;

  // Create renderer with player's actual position for room clip BFS
  mapRenderer = new MapRenderer(mapData, startX, startY);

  // Reset movement state
  moving = false;
  sprite.resetFrame();
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
  if (mapRenderer && !mapRenderer.isPassable(tileX, tileY)) {
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
}

function handleInput() {
  if (!sprite) return;
  if (moving) return;

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

function checkTrigger() {
  if (!mapRenderer || !mapData) return false;

  const tileX = worldX / TILE_SIZE;
  const tileY = worldY / TILE_SIZE;
  const trigger = mapRenderer.getTriggerAt(tileX, tileY);
  if (!trigger) return false;

  if (trigger.source === 'dynamic' && trigger.type === 1) {
    // Entrance/door — push current position, load destination map
    const destMap = mapData.entranceData[trigger.trigId];
    if (destMap === 0) return false;
    mapStack.push({ mapId: currentMapId, x: worldX, y: worldY });
    loadMapById(destMap);
    return true;
  }

  if (trigger.source === 'collision' || trigger.source === 'entrance') {
    if (trigger.trigType === 0) {
      // exit_prev — pop from map stack
      if (mapStack.length > 0) {
        const prev = mapStack.pop();
        loadMapById(prev.mapId);
        worldX = prev.x;
        worldY = prev.y;
      } else {
        // Fallback: use mapExit property
        const exitMap = mapData.mapExit;
        if (exitMap) loadMapById(exitMap);
      }
      return true;
    }
    // exit_world (trigType 1) — not implemented yet
  }

  return false;
}

function render() {
  const camX = Math.round(worldX);
  const camY = Math.round(worldY);

  // Camera origin: screen pixel where the camera world position maps to
  const originX = SCREEN_CENTER_X;
  const originY = SCREEN_CENTER_Y + 3; // sprite draws 3px above tile

  if (mapRenderer) {
    mapRenderer.draw(ctx, camX, camY, originX, originY);
  } else {
    // Fallback green grid
    ctx.fillStyle = '#1a3a1a';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    ctx.strokeStyle = '#2a5a2a';
    ctx.lineWidth = 1;
    const offsetX = -(camX % TILE_SIZE);
    const offsetY = -(camY % TILE_SIZE);
    for (let x = offsetX; x <= CANVAS_W; x += TILE_SIZE) {
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, CANVAS_H);
      ctx.stroke();
    }
    for (let y = offsetY; y <= CANVAS_H; y += TILE_SIZE) {
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(CANVAS_W, y + 0.5);
      ctx.stroke();
    }
  }

  if (sprite) {
    sprite.draw(ctx, SCREEN_CENTER_X, SCREEN_CENTER_Y);
  }

  // Draw overlay tiles (grass, trees) on top of sprite
  if (mapRenderer) {
    mapRenderer.drawOverlay(ctx, camX, camY, originX, originY, SCREEN_CENTER_X, SCREEN_CENTER_Y);
  }
}

function gameLoop(timestamp) {
  const dt = timestamp - lastTime;
  lastTime = timestamp;

  handleInput();
  updateMovement(dt);
  render();

  requestAnimationFrame(gameLoop);
}
