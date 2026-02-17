// Game Client — canvas rendering, input handling, game loop

import { parseROM, getBytesAt } from './rom-parser.js';
import { readPalettes, NES_SYSTEM_PALETTE, decodeTile, decodeTiles } from './tile-decoder.js';
import { Sprite, DIR_DOWN, DIR_UP, DIR_LEFT, DIR_RIGHT } from './sprite.js';
import { loadMap } from './map-loader.js';
import { MapRenderer } from './map-renderer.js';
import { loadWorldMap } from './world-map-loader.js';
import { WorldMapRenderer } from './world-map-renderer.js';
import { generateFloor, clearDungeonCache } from './dungeon-generator.js';
import { initMusic, playTrack, stopMusic, playSFX, TRACKS, SFX } from './music.js';
import { applyIPS } from './ips-patcher.js';
import { initTextDecoder } from './text-decoder.js';
import { initFont, drawText, measureText, TEXT_WHITE } from './font-renderer.js';

// Jukebox debug mode — press J to toggle, +/- to cycle songs
let jukeboxMode = false;
let jukeboxTrack = 0;

const CANVAS_W = 256;          // 16 metatiles wide (NES resolution)
const CANVAS_H = 240;          // 15 metatiles tall (NES resolution)
const TILE_SIZE = 16;
const WALK_DURATION = 16 * (1000 / 60);  // 16 NES frames at 60fps ≈ 267ms per tile

// HUD layout — 4 panels: top scenery, game viewport, right box, bottom box
const HUD_TOP_H = 32;                              // 2 tiles — battle scenery (future)
const HUD_VIEW_X = 0;
const HUD_VIEW_Y = HUD_TOP_H;                      // 32
const HUD_VIEW_W = 144;                             // 9 tiles
const HUD_VIEW_H = 144;                             // 9 tiles
const HUD_RIGHT_X = HUD_VIEW_W;                     // 144
const HUD_RIGHT_W = CANVAS_W - HUD_VIEW_W;          // 112 (7 tiles)
const HUD_BOT_Y = HUD_VIEW_Y + HUD_VIEW_H;          // 176
const HUD_BOT_H = CANVAS_H - HUD_BOT_Y;             // 64 (4 tiles)

// Menu border tiles — ROM offset: bank 0D, $1700 into bank, tiles $F7-$FF
const BORDER_TILE_ROM = 0x1B710 + (0xF7 - 0x70) * 16;  // 0x1BF80
const BORDER_TILE_COUNT = 9;  // $F7 TL, $F8 top, $F9 TR, $FA left, $FB right, $FC BL, $FD bot, $FE BR, $FF fill
const MENU_PALETTE = [0x0F, 0x00, 0x0F, 0x30];  // black, grey, black (interior), white
let hudCanvas = null;

// Battle sprite — Onion Knight idle frame (16×24, 2×3 tiles)
const BATTLE_SPRITE_ROM = 0x050010;  // Bank 28/$8000 — battle character graphics (disasm 2F/AB3D)
const BATTLE_JOB_SIZE = 0x02A0;      // 672 bytes (42 tiles) per job
let battleSpriteCanvas = null;

// FF1&2 ROM — secondary ROM for monster sprites, etc.
let ff12Raw = null;
const FF2_OFFSET = 0x040000;  // FF2 data starts at 256KB in compilation ROM
const FF2_ADAMANTOISE_SPRITE = 0x04BF10;  // 4 tiles, 16×16, row-major (TL,TR,BL,BR)
let adamantoiseFrames = null; // [normal, flipped] canvases

// Boss sprite — positioned in dungeon boss room
let bossSprite = null;  // { canvas, px, py } or null

// Player stats (placeholder)
let playerHP = 28;
let playerMP = 12;

// Top box — battle scene BG or area name
let topBoxMode = 'name';       // 'name' | 'battle'
let topBoxNameBytes = null;    // Uint8Array for area name text
let topBoxBgCanvas = null;     // Pre-rendered 256×32 battle BG strip (frame 0 = original)
let topBoxBgFadeFrames = null; // [original, step1, step2, ..., black] — NES palette fade
let topBoxIsTown = false;      // true = always show name, never switch to battle

// Top box scroll animation — blue name banner slides in/out
let topBoxScrollState = 'none'; // 'none' | 'pending' | 'scroll-in' | 'display' | 'scroll-out'
let topBoxScrollTimer = 0;
let topBoxScrollOffset = -16;   // -16 = hidden above, 0 = fully visible
let topBoxScrollOnDone = null;  // callback when scroll-out finishes
const TOPBOX_SCROLL_DURATION = 150;  // ms for scroll in/out
const TOPBOX_DISPLAY_HOLD = 1800;    // ms to show area name

// White text on blue background — colors 1&2 = NES $02 (blue) so cell bg matches fill
const TEXT_WHITE_ON_BLUE = [0x02, 0x02, 0x02, 0x30];

// Area name tile bytes (see text-system.md for encoding)
const AREA_NAMES = new Map([
  [114, new Uint8Array([0x9E, 0xDB])],  // "Ur"
]);
const DUNGEON_NAME = new Uint8Array([0x8A, 0xD5, 0xDD, 0xCA, 0xDB, 0xFF, 0x8C, 0xCA, 0xDF, 0xCE]); // "Altar Cave"

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
let hiddenTraps = null;
let rockSwitch = null;
let warpTile = null;
let pondTiles = null;
let trapFallPending = false;
let trapShakePending = false;

// Player world position in pixels
let worldX = 0;
let worldY = 0;

// Where the sprite draws on screen (centered in viewport)
const SCREEN_CENTER_X = HUD_VIEW_X + (HUD_VIEW_W - 16) / 2;    // 64
const SCREEN_CENTER_Y = HUD_VIEW_Y + (HUD_VIEW_H - 16) / 2 - 3; // 93

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

// Star sprite effect state (teleport warp + pond healing)
let _starTiles = null;     // [canvas, canvas, canvas] — 3 animation frames (8×8)
let starEffect = null;     // {frame, radius, angle, spin, onComplete} or null


// Screen wipe transition state (FF3-style horizontal band wipe)
// Black bars close from top/bottom edges toward center, then open to reveal new map
const WIPE_DURATION = 44 * (1000 / 60);  // 44 NES frames ≈ 733ms
const WIPE_HOLD = 100;                    // ms to hold on full black
const DOOR_OPEN_DURATION = 400;
const TRAP_REVEAL_DURATION = 400; // ms to show the hole before wipe
const SPIN_DIRS = [DIR_LEFT, DIR_UP, DIR_RIGHT, DIR_DOWN];
const SPIN_INTERVAL = 110;  // ms per direction change
const SPIN_CYCLES = 4;      // full rotations, ends facing south
let transState = 'none';  // 'none' | 'door-opening' | 'trap-falling' | 'closing' | 'hold' | 'loading' | 'opening'
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

function initHUD(romData) {
  // Decode 9 border tiles ($F7-$FF) from ROM
  const tiles = decodeTiles(romData, BORDER_TILE_ROM, BORDER_TILE_COUNT);
  // TL=0, top=1, TR=2, left=3, right=4, BL=5, bot=6, BR=7, fill=8

  // Render each tile to an 8x8 canvas with the menu palette
  const tileCanvases = tiles.map(pixels => {
    const c = document.createElement('canvas');
    c.width = 8; c.height = 8;
    const tctx = c.getContext('2d');
    const img = tctx.createImageData(8, 8);
    for (let i = 0; i < 64; i++) {
      const nesIdx = MENU_PALETTE[pixels[i]];
      const rgb = NES_SYSTEM_PALETTE[nesIdx] || [0, 0, 0];
      img.data[i * 4]     = rgb[0];
      img.data[i * 4 + 1] = rgb[1];
      img.data[i * 4 + 2] = rgb[2];
      img.data[i * 4 + 3] = 255;
    }
    tctx.putImageData(img, 0, 0);
    return c;
  });

  // Pre-render entire HUD to a cached canvas
  hudCanvas = document.createElement('canvas');
  hudCanvas.width = CANVAS_W;
  hudCanvas.height = CANVAS_H;
  const hctx = hudCanvas.getContext('2d');
  hctx.imageSmoothingEnabled = false;

  // Draw a bordered box using the 9 tile canvases
  // fill=false skips interior (for game viewport — game rendering shows through)
  function drawBox(x, y, w, h, fill = true) {
    const [TL, TOP, TR, LEFT, RIGHT, BL, BOT, BR, FILL] = tileCanvases;
    // Corners
    hctx.drawImage(TL, x, y);
    hctx.drawImage(TR, x + w - 8, y);
    hctx.drawImage(BL, x, y + h - 8);
    hctx.drawImage(BR, x + w - 8, y + h - 8);
    // Top/bottom edges
    for (let tx = x + 8; tx < x + w - 8; tx += 8) {
      hctx.drawImage(TOP, tx, y);
      hctx.drawImage(BOT, tx, y + h - 8);
    }
    // Left/right edges
    for (let ty = y + 8; ty < y + h - 8; ty += 8) {
      hctx.drawImage(LEFT, x, ty);
      hctx.drawImage(RIGHT, x + w - 8, ty);
    }
    // Interior fill
    if (fill) {
      for (let ty = y + 8; ty < y + h - 8; ty += 8) {
        for (let tx = x + 8; tx < x + w - 8; tx += 8) {
          hctx.drawImage(FILL, tx, ty);
        }
      }
    }
  }

  // Draw all 5 HUD panels (viewport has no fill — game shows through)
  drawBox(0, 0, CANVAS_W, HUD_TOP_H);                              // Top scenery box
  drawBox(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H, false); // Game viewport (no fill)
  drawBox(HUD_RIGHT_X, HUD_VIEW_Y, 32, 32);                          // Right mini-left (16x16 interior)
  drawBox(HUD_RIGHT_X + 32, HUD_VIEW_Y, HUD_RIGHT_W - 32, 32);      // Right mini-right
  drawBox(HUD_RIGHT_X, HUD_VIEW_Y + 32, HUD_RIGHT_W, HUD_VIEW_H - 32); // Right main box
  drawBox(0, HUD_BOT_Y, CANVAS_W, HUD_BOT_H);                      // Bottom box
}

function initBattleSprite(romData) {
  // Battle palette: character palette 0 (ID $FC) at ROM 0x05CF04
  // 3 bytes = colors 1-3, color 0 always $0F (disasm 2E/9E28 + 2E/9DA2)
  const BATTLE_PAL_ROM = 0x05CF04;
  const palette = [0x0F, romData[BATTLE_PAL_ROM], romData[BATTLE_PAL_ROM + 1], romData[BATTLE_PAL_ROM + 2]];

  // Decode idle frame top half: tiles 0-3 (head+body), 2×2 grid (16×16)
  const tiles = [];
  for (let i = 0; i < 4; i++) {
    tiles.push(decodeTile(romData, BATTLE_SPRITE_ROM + i * 16));
  }

  battleSpriteCanvas = document.createElement('canvas');
  battleSpriteCanvas.width = 16;
  battleSpriteCanvas.height = 16;
  const bctx = battleSpriteCanvas.getContext('2d');

  // 2×2 layout: row-major (confirmed via disasm 3C/82FA OAM data)
  const layout = [[0,0], [8,0], [0,8], [8,8]];
  for (let i = 0; i < 4; i++) {
    const img = bctx.createImageData(8, 8);
    const px = tiles[i];
    for (let p = 0; p < 64; p++) {
      const ci = px[p];
      if (ci === 0) {
        img.data[p * 4 + 3] = 0;
      } else {
        const rgb = NES_SYSTEM_PALETTE[palette[ci]] || [0, 0, 0];
        img.data[p * 4]     = rgb[0];
        img.data[p * 4 + 1] = rgb[1];
        img.data[p * 4 + 2] = rgb[2];
        img.data[p * 4 + 3] = 255;
      }
    }
    bctx.putImageData(img, layout[i][0], layout[i][1]);
  }
}

function initAdamantoise(romData) {
  // 4 tiles at FF2_ADAMANTOISE_SPRITE, row-major: TL, TR, BL, BR
  // Land Turtle palette — top half vs bottom half swapped
  const palTop = [0x0F, 0x0F, 0x14, 0x27]; // black outline, purple, yellow
  const palBot = [0x0F, 0x0F, 0x27, 0x14]; // black outline, yellow, purple
  const tiles = [];
  for (let i = 0; i < 4; i++) {
    tiles.push(decodeTile(romData, FF2_ADAMANTOISE_SPRITE + i * 16));
  }

  const normal = document.createElement('canvas');
  normal.width = 16;
  normal.height = 16;
  const actx = normal.getContext('2d');

  const layout = [[0,0], [8,0], [0,8], [8,8]];
  for (let i = 0; i < 4; i++) {
    const pal = i < 2 ? palTop : palBot;
    const img = actx.createImageData(8, 8);
    const px = tiles[i];
    for (let p = 0; p < 64; p++) {
      const ci = px[p];
      if (ci === 0) {
        img.data[p * 4 + 3] = 0;
      } else {
        const rgb = NES_SYSTEM_PALETTE[pal[ci]] || [0, 0, 0];
        img.data[p * 4]     = rgb[0];
        img.data[p * 4 + 1] = rgb[1];
        img.data[p * 4 + 2] = rgb[2];
        img.data[p * 4 + 3] = 255;
      }
    }
    actx.putImageData(img, layout[i][0], layout[i][1]);
  }

  // Flipped frame
  const flipped = document.createElement('canvas');
  flipped.width = 16;
  flipped.height = 16;
  const fctx = flipped.getContext('2d');
  fctx.translate(16, 0);
  fctx.scale(-1, 1);
  fctx.drawImage(normal, 0, 0);

  adamantoiseFrames = [normal, flipped];
}

// Battle BG ROM offsets (verified from ff3-disasm)
const BATTLE_BG_TILES_ROM   = 0x018010;  // bank 0C/$8000, 256 bytes per bgId (16 tiles)
const BATTLE_BG_MAP_LOOKUP  = 0x073C10;  // bank 39/$BC00, 256 entries (bits 0-4=bgId)
const BATTLE_BG_PAL_C1      = 0x001110;  // bank 00/$9100, color 1 per bgId
const BATTLE_BG_PAL_C2      = 0x001210;  // bank 00/$9200, color 2 per bgId
const BATTLE_BG_PAL_C3      = 0x001310;  // bank 00/$9300, color 3 per bgId
const BATTLE_BG_TMID_TABLE  = 0x05E512;  // bank 2F/$A502, tilemap ID per bgId (24 entries)
const BATTLE_BG_META_TILES  = 0x05E52A;  // bank 2F/$A51A, 4 metatiles × 4 tile IDs
const BATTLE_BG_TILEMAPS    = 0x05E53A;  // bank 2F/$A52A, 3 tilemaps × 32 bytes

/**
 * Pre-render battle background strip (256×32) for a given bgId.
 * @param {Uint8Array} romData — full ROM
 * @param {number} bgId — battle background ID (0-23)
 * @returns {HTMLCanvasElement} 256×32 canvas
 */
// NES palette fade — one step toward black, matches FF3 $FA87 routine
function nesColorFade(c) {
  if (c === 0x0F) return 0x0F;
  const hi = c & 0x30;
  if (hi === 0) return 0x0F;
  return (hi - 0x10) | (c & 0x0F);
}

function renderBattleBgWithPalette(romData, bgId, palette, tiles, metaTiles, tilemap) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 32;
  const bctx = c.getContext('2d');

  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 16; col++) {
      const metaIdx = tilemap[row * 16 + col];
      const [tl, tr, bl, br] = metaTiles[metaIdx];
      const px = col * 16;
      const py = row * 16;

      const subTiles = [[tl, px, py], [tr, px + 8, py], [bl, px, py + 8], [br, px + 8, py + 8]];
      for (const [tIdx, sx, sy] of subTiles) {
        const img = bctx.createImageData(8, 8);
        const pix = tiles[tIdx];
        for (let p = 0; p < 64; p++) {
          const ci = pix[p];
          if (ci === 0) {
            img.data[p * 4 + 3] = 0;
          } else {
            const rgb = NES_SYSTEM_PALETTE[palette[ci]] || [0, 0, 0];
            img.data[p * 4]     = rgb[0];
            img.data[p * 4 + 1] = rgb[1];
            img.data[p * 4 + 2] = rgb[2];
            img.data[p * 4 + 3] = 255;
          }
        }
        bctx.putImageData(img, sx, sy);
      }
    }
  }
  return c;
}

function renderBattleBg(romData, bgId) {
  // Palette: color 0 = $0F (black), colors 1-3 from ROM
  const palette = [
    0x0F,
    romData[BATTLE_BG_PAL_C1 + bgId],
    romData[BATTLE_BG_PAL_C2 + bgId],
    romData[BATTLE_BG_PAL_C3 + bgId],
  ];

  // Decode 16 tiles (8×8 each, 2BPP)
  const tiles = [];
  const tileBase = BATTLE_BG_TILES_ROM + bgId * 0x100;
  for (let i = 0; i < 16; i++) {
    tiles.push(decodeTile(romData, tileBase + i * 16));
  }

  // Read metatile expansion table (4 metatiles × 4 tile IDs)
  const metaTiles = [];
  for (let m = 0; m < 4; m++) {
    const ids = [];
    for (let j = 0; j < 4; j++) {
      ids.push(romData[BATTLE_BG_META_TILES + m * 4 + j] - 0x60);
    }
    metaTiles.push(ids);
  }

  // Read tilemap (2 rows × 16 metatile entries)
  const tilemapIdx = romData[BATTLE_BG_TMID_TABLE + bgId];
  const tmBase = BATTLE_BG_TILEMAPS + tilemapIdx * 32;
  const tilemap = [];
  for (let i = 0; i < 32; i++) tilemap.push(romData[tmBase + i]);

  // Pre-render all fade frames (original → progressively darker → black)
  const frames = [];
  const fadePal = [...palette];
  while (true) {
    frames.push(renderBattleBgWithPalette(romData, bgId, fadePal, tiles, metaTiles, tilemap));
    // Check if all colors are black
    if (fadePal[1] === 0x0F && fadePal[2] === 0x0F && fadePal[3] === 0x0F) break;
    // Step each color toward black
    fadePal[1] = nesColorFade(fadePal[1]);
    fadePal[2] = nesColorFade(fadePal[2]);
    fadePal[3] = nesColorFade(fadePal[3]);
  }

  topBoxBgFadeFrames = frames;
  return frames[0]; // original = topBoxBgCanvas
}

/**
 * Set up top box state for a given area.
 * @param {number} mapId — map being loaded
 * @param {boolean} isWorldMap — true if entering world map
 */
function setupTopBox(mapId, isWorldMap) {
  if (isWorldMap) {
    const wasTown = topBoxIsTown;
    const bgId = romRaw[BATTLE_BG_MAP_LOOKUP] & 0x1F; // map 0
    topBoxBgCanvas = renderBattleBg(romRaw, bgId);
    topBoxMode = 'battle';
    topBoxIsTown = false;
    if (wasTown && topBoxNameBytes) {
      // Leaving town — scroll name banner UP during opening phase
      topBoxScrollState = 'scroll-out';
      topBoxScrollTimer = 0;
      topBoxScrollOffset = 0;
      // Keep topBoxNameBytes alive for scroll-out rendering
    } else {
      topBoxNameBytes = null;
      topBoxScrollState = 'none';
      topBoxScrollOffset = -16;
    }
    return;
  }

  if (mapId >= 1000) {
    // Dungeon floor — crystal room (floor 4) uses map 148's BG, others use map 111's
    const romMap = (mapId === 1004) ? 148 : 111;
    const bgId = romRaw[BATTLE_BG_MAP_LOOKUP + romMap] & 0x1F;
    topBoxBgCanvas = renderBattleBg(romRaw, bgId);
    topBoxNameBytes = DUNGEON_NAME;
    topBoxMode = 'battle';
    topBoxIsTown = false;
    // Name shown during loading screen only — no scroll after
    topBoxScrollState = 'none';
    topBoxScrollOffset = -16;
    return;
  }

  // Regular map
  if (mapId === 114) {
    if (!topBoxIsTown) {
      // First entry to town — scroll name in
      topBoxScrollState = 'pending';
    }
    topBoxIsTown = true;
    topBoxNameBytes = AREA_NAMES.get(114);
    topBoxMode = 'name';
  } else if (!topBoxIsTown) {
    // Non-town indoor map — show battle scene immediately
    const bgId = romRaw[BATTLE_BG_MAP_LOOKUP + mapId] & 0x1F;
    topBoxBgCanvas = renderBattleBg(romRaw, bgId);
    topBoxMode = 'battle';
  }
  // If topBoxIsTown is true and mapId !== 114, keep current state (sub-room within town)
}

export async function loadROM(arrayBuffer) {
  // Apply English translation patch (IPS) before parsing
  const romBytes = new Uint8Array(arrayBuffer);
  try {
    const ipsResp = await fetch('patches/ff3-english.ips');
    if (ipsResp.ok) {
      const ipsData = new Uint8Array(await ipsResp.arrayBuffer());
      applyIPS(romBytes, ipsData);
    }
  } catch (_) { /* no patch file — continue with unpatched ROM */ }

  const rom = parseROM(romBytes.buffer);

  document.getElementById('rom-info').textContent =
    `PRG: ${rom.prgBanks} banks (${rom.prgSize / 1024}KB), ` +
    `CHR: ${rom.chrBanks} banks, Mapper: ${rom.mapper}`;

  // Sprite palette (persists across maps)
  const paletteData = getBytesAt(rom, PALETTE_OFFSET, 32);
  const allPalettes = readPalettes(paletteData, 0, 8);
  spritePalette = allPalettes[0];
  romRaw = rom.raw;

  // Initialize text decoder and font renderer with patched ROM
  initTextDecoder(romRaw);
  initFont(romRaw);

  initHUD(romRaw);
  initBattleSprite(romRaw);
  initMusic(romRaw);
  _initFlameRawTiles(romRaw);
  _initStarTiles(romRaw);

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

export function loadFF12ROM(arrayBuffer) {
  ff12Raw = new Uint8Array(arrayBuffer);
  initAdamantoise(ff12Raw);
}

function loadMapById(mapId, returnX, returnY) {
  onWorldMap = false;
  setupTopBox(mapId, false);

  if (mapId >= 1000) {
    // Synthetic dungeon floor
    const floorIndex = mapId - 1000;
    dungeonFloor = floorIndex;
    const result = generateFloor(romRaw, floorIndex, dungeonSeed);
    mapData = result;
    secretWalls = result.secretWalls;
    falseWalls = result.falseWalls;
    hiddenTraps = result.hiddenTraps;
    rockSwitch = result.rockSwitch || null;
    warpTile = result.warpTile || null;
    pondTiles = result.pondTiles || null;
    dungeonDestinations = result.dungeonDestinations;
    currentMapId = mapId;

    const playerX = returnX !== undefined ? returnX : result.entranceX;
    const playerY = returnY !== undefined ? returnY : result.entranceY;
    worldX = playerX * TILE_SIZE;
    worldY = playerY * TILE_SIZE;

    mapRenderer = new MapRenderer(mapData, playerX, playerY); _indoorWaterCache = null;
    _flameSprites = [];
    // Place boss sprite in crystal room (floor 5) center stage
    bossSprite = (floorIndex === 4 && adamantoiseFrames)
      ? { frames: adamantoiseFrames, px: 6 * TILE_SIZE, py: 8 * TILE_SIZE }
      : null;
    disabledTrigger = { x: playerX, y: playerY };
    moving = false;
    sprite.setDirection(DIR_DOWN);
    sprite.resetFrame();
    if (floorIndex === 4) playTrack(TRACKS.CRYSTAL_ROOM);

    // If returning to a door tile, show it open until player walks off
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
    return;
  }

  // Clear dungeon state when loading a non-dungeon map
  dungeonDestinations = null;
  secretWalls = null;
  falseWalls = null;
  hiddenTraps = null;
  rockSwitch = null;
  warpTile = null;
  pondTiles = null;
  bossSprite = null;

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
  bossSprite = null;
  setupTopBox(0, true);

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
  setupTopBox(0, true);

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
  if (starEffect) return;

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

  // Rock puzzle — press Z on rock → earthquake → false wall opens
  if (rockSwitch && rockSwitch.rocks.some(r => facedX === r.x && facedY === r.y)) {
    playSFX(SFX.EARTHQUAKE);
    shakeActive = true;
    shakeTimer = 0;
    shakePendingAction = () => {
      playSFX(SFX.DOOR);
      for (const wt of rockSwitch.wallTiles) {
        mapData.tilemap[wt.y * 32 + wt.x] = wt.newTile;
      }
      rockSwitch = null;
      const sx = worldX / TILE_SIZE;
      const sy = worldY / TILE_SIZE;
      mapRenderer = new MapRenderer(mapData, sx, sy); _indoorWaterCache = null;
    };
    return;
  }

  // Pond healing — star spiral when facing dungeon pond water
  if (pondTiles && pondTiles.has(`${facedX},${facedY}`)) {
    playSFX(SFX.POND_DRINK);
    starEffect = {
      frame: 0, radius: 60, angle: 0, spin: false,
      onComplete: () => {
        playSFX(SFX.CURE);
        // TODO: actual HP healing
      }
    };
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

    // Warp tile — star spiral + teleport to world map
    if (warpTile) {
      const tx = worldX / TILE_SIZE;
      const ty = worldY / TILE_SIZE;
      if (tx === warpTile.x && ty === warpTile.y) {
        sprite.setDirection(DIR_DOWN);
        playSFX(SFX.WARP);
        starEffect = {
          frame: 0, radius: 60, angle: 0, spin: true,
          onComplete: () => {
            startWipeTransition(() => {
              while (mapStack.length > 0) {
                const entry = mapStack.pop();
                if (entry.mapId === 'world') {
                  playTrack(TRACKS.WORLD_MAP);
                  loadWorldMapAtPosition(entry.x, entry.y);
                  return;
                }
              }
            });
          }
        };
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

function updateTopBoxScroll(dt) {
  if (topBoxScrollState === 'none') return;

  // If pending and no active transition, start immediately (e.g. initial load)
  if (topBoxScrollState === 'pending') {
    if (transState === 'none') {
      topBoxScrollState = 'scroll-in';
      topBoxScrollTimer = 0;
      topBoxScrollOffset = -16;
    }
    return;
  }

  topBoxScrollTimer += Math.min(dt, 33); // cap so generation lag doesn't skip scroll

  if (topBoxScrollState === 'scroll-in') {
    const t = Math.min(topBoxScrollTimer / TOPBOX_SCROLL_DURATION, 1);
    topBoxScrollOffset = -16 + t * 16; // -16 → 0
    if (t >= 1) {
      topBoxScrollOffset = 0;
      if (topBoxIsTown) {
        // Town: name stays visible permanently
        topBoxScrollState = 'none';
      } else {
        // Non-town: hold then scroll out
        topBoxScrollState = 'display';
        topBoxScrollTimer = 0;
      }
    }
  } else if (topBoxScrollState === 'display') {
    // During loading screen, stay displayed until Z is pressed
    if (transState !== 'loading' && topBoxScrollTimer >= TOPBOX_DISPLAY_HOLD) {
      topBoxScrollState = 'scroll-out';
      topBoxScrollTimer = 0;
    }
  } else if (topBoxScrollState === 'scroll-out') {
    const t = Math.min(topBoxScrollTimer / TOPBOX_SCROLL_DURATION, 1);
    topBoxScrollOffset = -t * 16; // 0 → -16
    if (t >= 1) {
      topBoxScrollState = 'none';
      topBoxScrollOffset = -16;
      topBoxNameBytes = null;
      if (topBoxScrollOnDone) {
        const cb = topBoxScrollOnDone;
        topBoxScrollOnDone = null;
        cb();
      }
    }
  }
}

function startWipeTransition(action) {
  transState = 'closing';
  transTimer = 0;
  transPendingAction = action;
  playSFX(SFX.SCREEN_CLOSE);
}

function updateTransition(dt) {
  if (transState === 'none') return;

  transTimer += dt;

  if (transState === 'trap-reveal') {
    if (transTimer >= TRAP_REVEAL_DURATION) {
      transState = 'closing';
      transTimer = 0;
      playSFX(SFX.SCREEN_CLOSE);
        }
  } else if (transState === 'trap-falling') {
    const totalSpinTime = SPIN_INTERVAL * SPIN_DIRS.length * SPIN_CYCLES;
    const dirIndex = Math.floor(transTimer / SPIN_INTERVAL) % SPIN_DIRS.length;
    sprite.setDirection(SPIN_DIRS[dirIndex]);
    if (transTimer >= totalSpinTime) {
      // Load the new map while still black
      if (transPendingAction) { transPendingAction(); transPendingAction = null; }
      trapShakePending = true;
      transState = 'opening';
      transTimer = 0;
      playSFX(SFX.SCREEN_OPEN);
        }
  } else if (transState === 'door-opening') {
    if (transTimer >= DOOR_OPEN_DURATION) {
      transState = 'closing';
      transTimer = 0;
      playSFX(SFX.SCREEN_CLOSE);
        }
  } else if (transState === 'closing') {
    if (transTimer >= WIPE_DURATION) {
      if (trapFallPending) {
        trapFallPending = false;
        transState = 'trap-falling';
        transTimer = 0;
        playSFX(SFX.FALL);
      } else {
        transState = 'hold';
        transTimer = 0;
        // For dungeon transitions, defer map load to the loading screen
        if (!transDungeon && transPendingAction) {
          transPendingAction();
          transPendingAction = null;
        }
      }
    }
  } else if (transState === 'hold') {
    if (transTimer >= WIPE_HOLD) {
      if (transDungeon) {
        transState = 'loading';
        transTimer = 0;
        playTrack(TRACKS.PIANO_3);
        // Generate the dungeon floor during the loading screen
        if (transPendingAction) {
          transPendingAction();
          transPendingAction = null;
        }
        // Scroll dungeon name banner down during loading screen
        if (topBoxNameBytes) {
          topBoxScrollState = 'scroll-in';
          topBoxScrollTimer = 0;
          topBoxScrollOffset = -16;
        }
      } else {
        transState = 'opening';
        transTimer = 0;
        playSFX(SFX.SCREEN_OPEN);
            }
    }
  } else if (transState === 'loading') {
    if (keys['z'] || keys['Z']) {
      keys['z'] = false;
      keys['Z'] = false;
      if (topBoxScrollState !== 'none' && topBoxScrollState !== 'scroll-out') {
        // Scroll name banner up first, then open
        topBoxScrollState = 'scroll-out';
        topBoxScrollTimer = 0;
        topBoxScrollOffset = 0;
        topBoxScrollOnDone = () => {
          transState = 'opening';
          transTimer = 0;
          transDungeon = false;
          playSFX(SFX.SCREEN_OPEN);
          playTrack(TRACKS.CRYSTAL_CAVE);
        };
      } else if (topBoxScrollState !== 'scroll-out') {
        transState = 'opening';
        transTimer = 0;
        transDungeon = false;
        playSFX(SFX.SCREEN_OPEN);
        playTrack(TRACKS.CRYSTAL_CAVE);
      }
    }
  } else if (transState === 'opening') {
    if (transTimer >= WIPE_DURATION) {
      transState = 'none';
      transTimer = 0;
      if (trapShakePending) {
        trapShakePending = false;
        playSFX(SFX.EARTHQUAKE);
        shakeActive = true;
        shakeTimer = 0;
      }
      // Kick off name banner scroll after transition opens
      if (topBoxScrollState === 'pending') {
        topBoxScrollState = 'scroll-in';
        topBoxScrollTimer = 0;
        topBoxScrollOffset = -16;
      }
    }
  }
}

function drawTransitionOverlay() {
  if (transState === 'none' || transState === 'door-opening') return;

  // Wipe bars animate within the game viewport
  const vpMidY = HUD_VIEW_Y + HUD_VIEW_H / 2;
  const halfH = HUD_VIEW_H / 2;
  let barHeight;

  if (transState === 'closing') {
    const t = Math.min(transTimer / WIPE_DURATION, 1);
    barHeight = t * halfH;
  } else if (transState === 'hold' || transState === 'loading' || transState === 'trap-falling') {
    barHeight = halfH;
  } else if (transState === 'opening') {
    const t = Math.min(transTimer / WIPE_DURATION, 1);
    barHeight = (1 - t) * halfH;
  }

  ctx.fillStyle = '#000';
  ctx.fillRect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, Math.ceil(barHeight));
  ctx.fillRect(HUD_VIEW_X, HUD_VIEW_Y + HUD_VIEW_H - Math.ceil(barHeight), HUD_VIEW_W, Math.ceil(barHeight));

  // Loading screen text overlay (ROM font, centered in viewport)
  if (transState === 'loading') {
    const titleBytes = new Uint8Array([0x8A,0x95,0x9D,0x8A,0x9B,0xFF,0x8C,0x8A,0x9F,0x8E]);
    const promptBytes = new Uint8Array([0x99,0xDB,0xCE,0xDC,0xDC,0xFF,0xA3]);

    const titleW = measureText(titleBytes);
    const promptW = measureText(promptBytes);
    const cx = HUD_VIEW_X + HUD_VIEW_W / 2;

    drawText(ctx, cx - titleW / 2, vpMidY - 8, titleBytes, TEXT_WHITE);
    if (Math.floor(transTimer / 500) % 2 === 0) {
      drawText(ctx, cx - promptW / 2, vpMidY + 16, promptBytes, TEXT_WHITE);
    }
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

  // Reveal hidden trap on step — show hole, play SFX, then fall
  if (hiddenTraps && hiddenTraps.has(`${tileX},${tileY}`)) {
    hiddenTraps.delete(`${tileX},${tileY}`);
    mapData.tilemap[tileY * 32 + tileX] = 0x74;
    mapRenderer = new MapRenderer(mapData, tileX, tileY); _indoorWaterCache = null;
    playSFX(SFX.DOOR);
    if (trigger.source === 'dynamic' && trigger.type === 1 &&
        dungeonDestinations && dungeonDestinations.has(trigger.trigId)) {
      const dest = dungeonDestinations.get(trigger.trigId);
      const savedX = worldX;
      const savedY = worldY;
      transPendingAction = () => {
        mapStack.push({ mapId: currentMapId, x: savedX, y: savedY });
        loadMapById(dest.mapId);
      };
      transState = 'trap-reveal';
      transTimer = 0;
      transDungeon = false;
      trapFallPending = true;
      return true;
    }
  }

  if (trigger.source === 'dynamic' && trigger.type === 1) {
    // Check dungeon destinations first (synthetic maps)
    if (dungeonDestinations && dungeonDestinations.has(trigger.trigId)) {
      const dest = dungeonDestinations.get(trigger.trigId);
      if (dest.goBack) {
        // Go back — pop mapStack (same as exit_prev)
        startWipeTransition(() => {
          if (mapStack.length > 0) {
            const prev = mapStack.pop();
            loadMapById(prev.mapId, prev.x / TILE_SIZE, prev.y / TILE_SIZE);
            if (prev.mapId >= 1000 && prev.mapId < 1004) playTrack(TRACKS.CRYSTAL_CAVE);
          }
        });
        return true;
      }
      const savedX = worldX;
      const savedY = worldY;
      // Check if this is a door tile — play creak SFX + open animation
      const destTileId = mapData.tilemap[tileY * 32 + tileX];
      const destTileM = destTileId < 128 ? destTileId : destTileId & 0x7F;
      const destIsDoor = ((mapData.collisionByte2[destTileM] >> 4) & 0x0F) === 5;
      if (destIsDoor) {
        mapRenderer.updateTileAt(tileX, tileY, 0x7E);
        playSFX(SFX.DOOR);
        transState = 'door-opening';
        transTimer = 0;
        transPendingAction = () => {
          mapStack.push({ mapId: currentMapId, x: savedX, y: savedY });
          loadMapById(dest.mapId);
        };
      } else {
        startWipeTransition(() => {
          mapStack.push({ mapId: currentMapId, x: savedX, y: savedY });
          loadMapById(dest.mapId);
        });
      }
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

  // Type 4 dynamic triggers (PASSAGE_ENTRY) — check dungeon destinations
  if (trigger.source === 'dynamic' && trigger.type === 4) {
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
  }

  if (trigger.source === 'collision' || trigger.source === 'entrance') {
    if (trigger.trigType === 0) {
      // exit_prev — wipe out, then pop from map stack
      const exitingCrystalRoom = currentMapId === 1004;
      startWipeTransition(() => {
        if (mapStack.length > 0) {
          const prev = mapStack.pop();
          if (prev.mapId === 'world') {
            // Return to world map at saved position
            loadWorldMapAtPosition(prev.x, prev.y);
          } else {
            loadMapById(prev.mapId, prev.x / TILE_SIZE, prev.y / TILE_SIZE);
            if (exitingCrystalRoom) playTrack(TRACKS.CRYSTAL_CAVE);
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
// Horizontal ($22-$25): 8-bit circular RIGHT shift per tile
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
      // 16-bit circular RIGHT shift: bit 0 of R wraps to bit 7 of L
      const nL = new Uint8Array(8), nR = new Uint8Array(8);
      for (let r = 0; r < 8; r++) {
        const l = cL[r], ri = cR[r];
        const carryL = l & 1;          // LSB of left
        const carryR = ri & 1;         // LSB of right
        nL[r] = ((l >> 1) | (carryR << 7)) & 0xFF; // right's LSB wraps to left's MSB
        nR[r] = ((ri >> 1) | (carryL << 7)) & 0xFF; // left's LSB wraps to right's MSB
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

// --- Star sprite decoding ---
// Star sprites from ROM: 2x2 metatile (16x16) — two frames that alternate
// Frame A (0x014790): diamond star — rays up/down/left/right
// Frame B (0x0147C0): diagonal star — rays to corners (rotated 45°)
const STAR_FRAMES = [0x014790, 0x0147D0]; // each is 4 consecutive 8x8 tiles (TL, TR, BL, BR)
// Palette: 1=dark orange edge, 2=tan/warm yellow body, 3=white center
const STAR_PALETTE = [null, NES_SYSTEM_PALETTE[0x17], NES_SYSTEM_PALETTE[0x27], NES_SYSTEM_PALETTE[0x30]];

function _initStarTiles(romData) {
  if (_starTiles) return;
  _starTiles = [];
  for (const baseOffset of STAR_FRAMES) {
    const c = document.createElement('canvas');
    c.width = 16; c.height = 16;
    const cctx = c.getContext('2d');
    // 4 tiles: TL(+0), TR(+16), BL(+32), BR(+48)
    const positions = [[0, 0], [8, 0], [0, 8], [8, 8]];
    for (let t = 0; t < 4; t++) {
      const pixels = decodeTile(romData, baseOffset + t * 16);
      const img = cctx.createImageData(8, 8);
      for (let i = 0; i < 64; i++) {
        const ci = pixels[i];
        if (ci === 0) { img.data[i * 4 + 3] = 0; continue; }
        const rgb = STAR_PALETTE[ci];
        img.data[i * 4] = rgb[0];
        img.data[i * 4 + 1] = rgb[1];
        img.data[i * 4 + 2] = rgb[2];
        img.data[i * 4 + 3] = 255;
      }
      cctx.putImageData(img, positions[t][0], positions[t][1]);
    }
    _starTiles.push(c);
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

  // Horizontal: 16-bit paired RIGHT shift, 16 frames
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
        const carryL = l & 1;
        const carryR = ri & 1;
        nL[r] = ((l >> 1) | (carryR << 7)) & 0xFF;
        nR[r] = ((ri >> 1) | (carryL << 7)) & 0xFF;
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
  // Clear canvas to black (HUD background)
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

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

  // Clip game rendering to viewport
  ctx.save();
  ctx.beginPath();
  ctx.rect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);
  ctx.clip();

  if (onWorldMap && worldMapRenderer) {
    worldMapRenderer.draw(ctx, camX, camY, originX, originY);
    // Water animation: update atlas directly from game.js (bypasses module cache)
    _updateWorldWater(worldMapRenderer);
  } else if (mapRenderer) {
    mapRenderer.draw(ctx, camX, camY, originX, originY);
    _updateIndoorWater(mapRenderer);
  }

  // Hide all sprites/objects during transitions (show during trap reveal)
  if (transState === 'none' || transState === 'trap-reveal') {
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

    // Boss sprite (crystal room) — alternates normal/flipped like walking
    if (bossSprite) {
      const wLeft = camX - originX;
      const wTop = camY - originY;
      const bx = bossSprite.px - wLeft;
      const by = bossSprite.py - wTop;
      if (bx > -16 && bx < CANVAS_W && by > -16 && by < CANVAS_H) {
        const frame = Math.floor(waterTick / 8) & 1;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(bossSprite.frames[frame], bx, by);
      }
    }

    if (sprite) {
      sprite.draw(ctx, SCREEN_CENTER_X, spriteY);
    }
  }

  // Draw overlay tiles (grass, trees) on top of sprite
  if (onWorldMap && worldMapRenderer) {
    worldMapRenderer.drawOverlay(ctx, camX, camY, originX, originY, SCREEN_CENTER_X, spriteY);
  } else if (mapRenderer) {
    mapRenderer.drawOverlay(ctx, camX, camY, originX, originY, SCREEN_CENTER_X, spriteY);
  }

  // Star spiral effect — 8 stars orbiting inward around player
  if (starEffect && _starTiles) {
    const cx = SCREEN_CENTER_X + 8;  // player sprite center X
    const cy = SCREEN_CENTER_Y + 8;  // player sprite center Y
    const { radius, angle, frame } = starEffect;
    // Flicker: alternate + and X shapes every ~16 frames
    const tile = _starTiles[(frame >> 4) & 1];
    for (let i = 0; i < 8; i++) {
      const a = angle + i * Math.PI / 4;
      const sx = Math.round(cx + radius * Math.cos(a) - 8);
      const sy = Math.round(cy + radius * Math.sin(a) - 8);
      ctx.drawImage(tile, sx, sy);
    }
  }

  ctx.restore(); // end viewport clip
}

function statRowBytes(label1, label2, value) {
  // Build 8-byte row: "HP   28" or "MP   12" — label + right-aligned number
  const digits = String(value);
  const bytes = new Uint8Array(8);
  bytes[0] = label1;
  bytes[1] = label2;
  const numStart = 8 - digits.length;
  for (let i = 2; i < numStart; i++) bytes[i] = 0xFF; // space
  for (let i = 0; i < digits.length; i++) bytes[numStart + i] = 0x80 + parseInt(digits[i]);
  return bytes;
}

function drawHUD() {
  if (hudCanvas) ctx.drawImage(hudCanvas, 0, 0);

  // Top box content (interior: 8,8 to 248,24 = 240×16)
  // Base layer: battle BG or permanent town blue fill
  const isScrolling = topBoxScrollState === 'scroll-in' || topBoxScrollState === 'display' || topBoxScrollState === 'scroll-out';
  const showTownBlue = topBoxMode === 'name' && !isScrolling;

  if (transState === 'loading' && topBoxNameBytes && !isScrolling) {
    // Loading screen: static blue + name (only when scroll isn't handling it)
    const nesBlue = NES_SYSTEM_PALETTE[0x02] || [0, 0, 116];
    ctx.fillStyle = `rgb(${nesBlue[0]},${nesBlue[1]},${nesBlue[2]})`;
    ctx.fillRect(8, 8, 240, 16);
    const tw = measureText(topBoxNameBytes);
    const tx = 8 + Math.floor((240 - tw) / 2);
    const ty = 8 + Math.floor((16 - 8) / 2);
    drawText(ctx, tx, ty, topBoxNameBytes, TEXT_WHITE_ON_BLUE);
  } else if (topBoxScrollState === 'pending' || topBoxScrollState === 'scroll-out' || (isScrolling && (topBoxIsTown || transState === 'loading'))) {
    // Black base: pending, any scroll-out, town scroll, or loading screen scroll
  } else if (showTownBlue) {
    // Permanent town display (after scroll-in completes)
    const nesBlue = NES_SYSTEM_PALETTE[0x02] || [0, 0, 116];
    ctx.fillStyle = `rgb(${nesBlue[0]},${nesBlue[1]},${nesBlue[2]})`;
    ctx.fillRect(8, 8, 240, 16);
    if (topBoxNameBytes) {
      const tw = measureText(topBoxNameBytes);
      const tx = 8 + Math.floor((240 - tw) / 2);
      const ty = 8 + Math.floor((16 - 8) / 2);
      drawText(ctx, tx, ty, topBoxNameBytes, TEXT_WHITE_ON_BLUE);
    }
  } else if (topBoxBgCanvas) {
    // Battle BG base layer
    ctx.drawImage(topBoxBgCanvas, 8, 8, 240, 16, 8, 8, 240, 16);
  }

  // Scrolling name banner overlay (clips to interior)
  if (isScrolling && topBoxNameBytes) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(8, 8, 240, 16);
    ctx.clip();
    const bannerY = 8 + topBoxScrollOffset;
    const nesBlue = NES_SYSTEM_PALETTE[0x02] || [0, 0, 116];
    ctx.fillStyle = `rgb(${nesBlue[0]},${nesBlue[1]},${nesBlue[2]})`;
    ctx.fillRect(8, bannerY, 240, 16);
    const tw = measureText(topBoxNameBytes);
    const tx = 8 + Math.floor((240 - tw) / 2);
    const ty = bannerY + Math.floor((16 - 8) / 2);
    drawText(ctx, tx, ty, topBoxNameBytes, TEXT_WHITE_ON_BLUE);
    ctx.restore();
  }

  // NES palette fade on top box during transitions
  // Skip when town blue is showing or scroll is handling the transition
  const skipFade = topBoxIsTown || topBoxScrollState !== 'none';
  if (!skipFade && topBoxBgFadeFrames && transState !== 'none' && transState !== 'door-opening' && transState !== 'loading') {
    const maxStep = topBoxBgFadeFrames.length - 1; // last frame = all black
    const FADE_STEP_MS = 133; // ~8 NES frames per step
    let fadeStep = 0;
    if (transState === 'closing') {
      fadeStep = Math.min(Math.floor(transTimer / FADE_STEP_MS), maxStep);
    } else if (transState === 'hold' || transState === 'trap-falling') {
      fadeStep = maxStep;
    } else if (transState === 'opening') {
      fadeStep = Math.max(maxStep - Math.floor(transTimer / FADE_STEP_MS), 0);
    }
    // Draw the faded frame over the base (which is frame 0)
    if (fadeStep > 0) {
      ctx.drawImage(topBoxBgFadeFrames[fadeStep], 8, 8, 240, 16, 8, 8, 240, 16);
    }
  }

  // Battle sprite portrait in mini-left panel interior (16×16 exact fit)
  if (battleSpriteCanvas) {
    ctx.drawImage(battleSpriteCanvas, HUD_RIGHT_X + 8, HUD_VIEW_Y + 8);
  }
  // HP/MP in right mini-right panel (8 chars × 2 rows)
  const sx = HUD_RIGHT_X + 32 + 8; // interior x
  const sy = HUD_VIEW_Y + 8;       // interior y
  drawText(ctx, sx, sy,     statRowBytes(0x91, 0x99, playerHP), TEXT_WHITE); // HP
  drawText(ctx, sx, sy + 8, statRowBytes(0x96, 0x99, playerMP), TEXT_WHITE); // MP
}

function gameLoop(timestamp) {
  const dt = timestamp - lastTime;
  lastTime = timestamp;

  handleInput();
  updateMovement(dt);
  updateTransition(dt);
  updateTopBoxScroll(dt);

  // Screen shake update
  if (shakeActive) {
    shakeTimer += dt;
    if (shakeTimer >= SHAKE_DURATION) {
      shakeActive = false;
      if (shakePendingAction) { shakePendingAction(); shakePendingAction = null; }
    }
  }

  // Star spiral effect update — matches NES: radius $EA→$0C, -2/frame, ~111 frames
  if (starEffect) {
    starEffect.frame++;
    starEffect.angle += 0.06;
    starEffect.radius -= 0.55;
    // Player spin: cycle directions every 14 frames (DOWN→LEFT→UP→RIGHT)
    if (starEffect.spin && starEffect.frame % 14 === 0) {
      const SPIN_ORDER = [DIR_DOWN, DIR_LEFT, DIR_UP, DIR_RIGHT];
      const spinIdx = Math.floor(starEffect.frame / 14) % 4;
      sprite.setDirection(SPIN_ORDER[spinIdx]);
    }
    if (starEffect.radius < 4) {
      const cb = starEffect.onComplete;
      starEffect = null;
      if (cb) cb();
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

  // Draw spinning sprite on top of black during trap fall
  if (transState === 'trap-falling' && sprite) {
    sprite.draw(ctx, SCREEN_CENTER_X, SCREEN_CENTER_Y);
  }

  // HUD always on top
  drawHUD();

  if (jukeboxMode) {
    ctx.font = '8px monospace';
    ctx.fillStyle = '#c8a832';
    ctx.textAlign = 'left';
    ctx.fillText(`JUKEBOX: Song $${jukeboxTrack.toString(16).toUpperCase().padStart(2, '0')} (${jukeboxTrack})  +/- to change`, 4, 12);
  }

  requestAnimationFrame(gameLoop);
}
