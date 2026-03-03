// Game Client — canvas rendering, input handling, game loop

import { parseROM } from './rom-parser.js';
import { NES_SYSTEM_PALETTE, decodeTile, decodeTiles } from './tile-decoder.js';
import { Sprite, DIR_DOWN, DIR_UP, DIR_LEFT, DIR_RIGHT } from './sprite.js';
import { loadMap } from './map-loader.js';
import { MapRenderer } from './map-renderer.js';
import { loadWorldMap } from './world-map-loader.js';
import { WorldMapRenderer } from './world-map-renderer.js';
import { generateFloor, clearDungeonCache } from './dungeon-generator.js';
import { initMusic, playTrack, stopMusic, playSFX, TRACKS, SFX } from './music.js';
import { applyIPS } from './ips-patcher.js';
import { initTextDecoder } from './text-decoder.js';
import { initFont, drawText, measureText, TEXT_WHITE, TEXT_YELLOW } from './font-renderer.js';
import { MONSTERS } from './data/monsters.js';

// --- Save data persistence (IndexedDB) ---
function openSaveDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ff3mmo-roms', 1);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveSlotsToDB() {
  try {
    const data = saveSlots.map(s => s ? {
      name: Array.from(s.name),
      level: s.level || (playerStats ? playerStats.level : 1),
      exp: s.exp != null ? s.exp : (playerStats ? playerStats.exp : 0),
      stats: s.stats || (playerStats ? {
        str: playerStats.str, agi: playerStats.agi, vit: playerStats.vit,
        int: playerStats.int, mnd: playerStats.mnd,
        maxHP: playerStats.maxHP, maxMP: playerStats.maxMP
      } : null)
    } : null);
    const db = await openSaveDB();
    const tx = db.transaction('roms', 'readwrite');
    tx.objectStore('roms').put(data, 'saves');
  } catch (e) { /* silent fail */ }
}

async function loadSlotsFromDB() {
  try {
    const db = await openSaveDB();
    const tx = db.transaction('roms', 'readonly');
    const req = tx.objectStore('roms').get('saves');
    return new Promise((resolve) => {
      req.onsuccess = () => {
        const data = req.result;
        if (Array.isArray(data)) {
          saveSlots = data.map(s => {
            if (!s) return null;
            // Old format: plain array of name bytes
            if (Array.isArray(s)) return { name: new Uint8Array(s), level: 1, exp: 0, stats: null };
            // New format: object with name, level, exp, stats
            return { name: new Uint8Array(s.name), level: s.level || 1, exp: s.exp || 0, stats: s.stats || null };
          });
        }
        resolve();
      };
      req.onerror = () => resolve();
    });
  } catch (e) { /* silent fail */ }
}

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
let borderTileCanvases = null; // [TL, TOP, TR, LEFT, RIGHT, BL, BOT, BR, FILL]
let borderBlueTileCanvases = null; // same but with blue (0x02) background instead of black
let borderFadeSets = null;    // [fadeLevel] → [TL, TOP, TR, LEFT, RIGHT, BL, BOT, BR, FILL]

// Battle sprite — Onion Knight idle frame (16×24, 2×3 tiles)
const BATTLE_SPRITE_ROM = 0x050010;  // Bank 28/$8000 — battle character graphics (disasm 2F/AB3D)
const BATTLE_JOB_SIZE = 0x02A0;      // 672 bytes (42 tiles) per job
let battleSpriteCanvas = null;
let battleSpriteVictoryCanvas = null;
let battleSpriteAttackCanvas = null;   // right-hand punch
let battleSpriteAttackLCanvas = null;  // left-hand punch
let silhouetteCanvas = null;

// FF1&2 ROM — secondary ROM for monster sprites, etc.
let ff12Raw = null;
const FF2_OFFSET = 0x040000;  // FF2 data starts at 256KB in compilation ROM
const FF2_ADAMANTOISE_SPRITE = 0x04BF10;  // 4 tiles, 16×16, row-major (TL,TR,BL,BR)
let adamantoiseFrames = null; // [normal, flipped] canvases

// Boss sprite — positioned in dungeon boss room
let bossSprite = null;  // { canvas, px, py } or null

// Land Turtle battle sprite — 6×6 tiles (48×48 pixels) from FF3 ROM
// Boss graphics: bank pair $24/$25 (register $12), address $9B00, 144 tiles total
// Tilemap shows only tiles $70-$93 (36 tiles) in a 6×6 grid
const LAND_TURTLE_GFX_OFF = 0x49B10;  // Bank $24:$9B00 — boss tile data
const LAND_TURTLE_PAL_TOP = [0x0F, 0x13, 0x23, 0x28]; // shell/head: black, purple, lavender, yellow (palette $47)
const LAND_TURTLE_PAL_BOT = [0x0F, 0x19, 0x18, 0x28]; // legs/body: black, green, olive, yellow (palette $22)
const LAND_TURTLE_TILES = 36;   // 6×6 grid
const LAND_TURTLE_COLS = 6;
let landTurtleBattleCanvas = null; // 48×48 canvas
let landTurtleWhiteCanvas = null;  // 48×48 all-white version for pre-attack flash

// Goblin battle sprite — random encounters
const GOBLIN_GFX_OFF = 0x40010;  // Bank $20:$8000 — size 0 (4×4), gfxID 0
const GOBLIN_PAL0 = [0x0F, 0x17, 0x28, 0x3C]; // palette $89: black, brown, yellow-green, pale cyan
const GOBLIN_PAL1 = [0x0F, 0x18, 0x28, 0x11]; // palette $A0: black, olive, yellow-green, blue
// Per-tile palette assignment (derived from reference sprite)
const GOBLIN_TILE_PAL = [0,0,0,0, 1,0,1,0, 1,1,1,1, 1,1,1,1];
const GOBLIN_TILES = 16;  // 4×4 grid
const GOBLIN_COLS = 4;
let goblinBattleCanvas = null;  // 32×32 canvas
let goblinWhiteCanvas = null;   // 32×32 all-white version for pre-attack flash
let goblinDeathFrames = null;   // pre-rendered diagonal deterioration frames

// Bayer 4×4 ordered dither matrix — creates the pixelated deterioration pattern
const BAYER4 = [
  [ 0, 8, 2,10],
  [12, 4,14, 6],
  [ 3,11, 1, 9],
  [15, 7,13, 5],
];
const MONSTER_DEATH_FRAMES = 16;

// Moogle NPC sprite — loading screen decoration
const MOOGLE_GFX_ID = 42;
const MOOGLE_SPRITE_OFF = 0x01C010 + MOOGLE_GFX_ID * 256; // 0x01EA10
const MOOGLE_PAL = [0x0F, 0x0F, 0x16, 0x30]; // transparent, black outline, red pom-pom, white body
let moogleFrames = null; // [normal, flipped] canvases

// Invincible airship sprite — title screen, facing east
const INVINCIBLE_TILE_ROM = 0x17A90;  // Bank $0B:$9A80 — tiles $C0-$FF (64 tiles)
const INVINCIBLE_PAL = [0x0F, 0x0F, 0x27, 0x30]; // transparent, black, gold, white
let invincibleFrames = null; // [frameA, frameB] 32×32 canvases (east-facing)
let invincibleFadeFrames = null; // [fadeLevel][frameIdx] faded canvases

// Player stats — ROM offsets (iNES +16 header)
const JOB_BASE_STATS_OFF = 0x072010;  // 22 jobs × 8 bytes: [adj, minLvl, STR, AGI, VIT, INT, MND, mpIdx]
const CHAR_INIT_HP_OFF   = 0x073BE8;  // 2 bytes little-endian
const CHAR_INIT_MP_OFF   = 0x073B98;  // 10 entries × 8 bytes (indexed by job mpIdx)
const LEVEL_EXP_TABLE_OFF  = 0x0720C0;  // 98 × 3 bytes (24-bit LE per level)
const LEVEL_STAT_BONUS_OFF = 0x0721E6;  // 22 jobs × 98 levels × 2 bytes
let invincibleShadowFade = null; // [fadeLevel] 32×8 shadow canvases

// Loading screen fade state
let loadingFadeState = 'none'; // 'in' | 'visible' | 'out' | 'none'
let loadingFadeTimer = 0;
const LOAD_FADE_STEP_MS = 133;  // same rate as battle BG fade
const LOAD_FADE_MAX = 4;        // 4 steps: $30→$20→$10→$00→$0F

// Loading screen pre-rendered fade frames
let moogleFadeFrames = null; // [step0=bright, step1, step2, step3=black] per walk frame pair
let bossFadeFrames = null;   // same structure for adamantoise
let loadingBgScroll = 0;     // horizontal scroll for loading screen battle BG
let loadingBgFadeFrames = null; // battle BG fade frames for loading screen

// Title screen state
let titleState = 'credit-wait'; // 'credit-wait' | 'credit-in' | 'credit-hold' | 'credit-out' |
                                 // 'disclaim-wait' | 'disclaim-in' | 'disclaim-hold' | 'disclaim-out' |
                                 // 'main-in' | 'zbox-open' | 'main' | 'zbox-close' |
                                 // 'select-fade-in' | 'select' | 'select-fade-out' | 'select-fade-out-back' |
                                 // 'main-out' | 'done'
let titleTimer = 0;
// Title timing — 6 seconds total for credit+disclaimer (3s each)
const TITLE_FADE_MAX = 4;          // 4 steps to reach $0F: $30→$20→$10→$00→$0F
const TITLE_FADE_STEP_MS = 100;    // 100ms per step
const TITLE_FADE_MS = (TITLE_FADE_MAX + 1) * TITLE_FADE_STEP_MS; // 500ms (extra step holds at black)
const TITLE_WAIT_MS = 0;           // no black pause — fade starts immediately
const TITLE_HOLD_MS = 2000;        // text visible
// Per screen: 0 + 500 + 2000 + 500 = 3000ms. Two screens = 6000ms.

// Title screen water + sky
let titleWaterFrames = null;     // [16 animation frames] 16×16 canvases at full brightness
let titleWaterFadeTiles = null;  // [TITLE_FADE_MAX+1 fade levels] 16×16 static ocean metatile
let titleSkyFrames = null;       // [fade levels] 256×32 battle BG strips (0=bright, last=black)
let titleWaterScroll = 0;        // pixel scroll offset
let titleSkyScroll = 0;
let titleShipTimer = 0;          // animation toggle for Invincible sprite
const TITLE_SHIP_ANIM_MS = 100;  // 100ms per frame toggle
const TITLE_SHADOW_ANIM_MS = 50; // 50ms shadow blink
const TITLE_ZBOX_MS = 200;       // ms for Press Z box open/close animation

// Player select screen state
let selectCursor = 0;             // 0-2 (which slot)
const SELECT_TEXT_STEP_MS = 100;  // NES fade step duration
const SELECT_TEXT_STEPS = 4;      // 4 steps: $30→$20→$10→$00→$0F
let saveSlots = [null, null, null]; // null = empty, or Uint8Array of name bytes
let nameBuffer = [];                // bytes being typed
const NAME_MAX_LEN = 7;

// HUD info fade-in after title screen ends
let hudInfoFadeTimer = 0;
const HUD_INFO_FADE_STEPS = 4;
const HUD_INFO_FADE_STEP_MS = 100;

// Player stats — initialized from ROM in initPlayerStats()
let playerStats = null;  // { str, agi, vit, int, mnd, hp, maxHP, mp, maxMP, level, exp, expToNext }
let expTable = null;     // Uint32Array(98) — EXP thresholds from ROM
let leveledUp = false;   // set by grantExp() for victory display
let playerHP = 28;   // overwritten by initPlayerStats
let playerMP = 12;
let playerATK = 12;
let playerDEF = 4;

// Boss fight state
let bossHP = 111;
const BOSS_ATK = 8, BOSS_DEF = 6, BOSS_MAX_HP = 111;

let battleState = 'none';
let battleTimer = 0;
let battleCursor = 0;        // 0=Fight,1=Magic,2=Item,3=Run
let targetIndex = 0;         // which monster is targeted in target-select
let battleMessage = null;     // Uint8Array for status messages
let bossDamageNum = null;     // {value, timer}
let playerDamageNum = null;   // {value, timer}
let bossFlashTimer = 0;
let battleShakeTimer = 0;
let bossDefeated = false;

// Random encounter state
let encounterSteps = 0;
let isRandomEncounter = false;
let encounterMonsters = null;  // [{ hp, maxHP, atk, def, exp }] — array of enemies
let encounterExpGained = 0;
let preBattleTrack = null;
let enemyAttackQueue = [];     // indices of alive monsters still to attack this turn
let currentAttacker = -1;      // index of monster currently attacking
let dyingMonsterIndex = -1;    // index of monster playing death stripe animation

// Hit animation state
let hitResults = [];               // [{damage, crit}, {miss:true}, ...] pre-calculated per attack
let currentHitIdx = 0;             // which hit we're animating
let slashFrame = 0;                // current slash animation frame (0-3)
let slashX = 0, slashY = 0;       // slash effect base position (target center)
let slashOffX = 0, slashOffY = 0; // random offset per frame (punch scatter)
let slashFramesR = null;           // right-hand punch frames (frame $12, 4 effect sets)
let slashFramesL = null;           // left-hand punch frames (frame $13, 4 effect sets)
let slashFrames = null;            // alias — points to R or L based on current hit
const BATTLE_MISS = new Uint8Array([0x96, 0xD2, 0xDC, 0xDC]); // "Miss" in ROM encoding
const BATTLE_DEFEATED = new Uint8Array([0x8D,0xE8,0xEF,0xE8,0xE4,0xDD,0xE8,0xE7]); // "Defeated"

// Battle timing constants
const BATTLE_SCROLL_MS = 150;
const BATTLE_TEXT_STEP_MS = 100;
const BATTLE_TEXT_STEPS = 4;
const BATTLE_ROAR_HOLD_MS = 800;
const BATTLE_FLASH_FRAMES = 65;      // 65 frames of grayscale strobe (~1.08s at 60fps)
const BATTLE_FLASH_FRAME_MS = 16.67; // ~1 frame at 60fps
const BATTLE_MSG_HOLD_MS = 1200;
const BATTLE_HIT_FLASH_MS = 400;
const BATTLE_DMG_SHOW_MS = 550;
const BATTLE_SHAKE_MS = 300;
const BATTLE_VICTORY_HOLD_MS = 1500;
const BOSS_BLOCK_SIZE = 16;            // 16×16 pixel blocks for dissolve
const BOSS_BLOCK_COLS = 3;             // 48/16 = 3 blocks wide
const BOSS_BLOCKS = 9;                 // 3×3 blocks
const BOSS_DISSOLVE_STEPS = 8;         // 8 pixel-shift steps per block
const BOSS_DISSOLVE_FRAME_MS = 16.67;  // 1 NES frame per step
const BOSS_BOX_EXPAND_MS = 300;        // box expand from center duration
const BATTLE_PANEL_W = 120;            // left section width in bottom panel
const BOSS_PREFLASH_MS = 133;            // 8 NES frames — boss pre-attack white blink
const MONSTER_DEATH_MS = 250;            // diagonal tile wipe — 7 visible steps × 33ms (ROM: 2F/BC68)
const MONSTER_SLIDE_MS = 267;            // 16 frames at 60fps — sprites slide in from left
// Authentic damage bounce keyframes from FCEUX trace (Y offsets from baseline, up = negative)
// 30 frames total = 500ms at 60fps
const DMG_BOUNCE_TABLE = [
  0, -6, -11, -16, -20, -23, -25,    // fast rise (7 frames)
  -25, -25,                           // hang at peak (2 frames)
  -23, -20, -16, -11, -6, 0,         // fall back to baseline (6 frames)
  6, 5, 3, 2, 1, 0,                  // small overshoot + settle (6 frames)
  -1, -1, -1, -1, -1,                // tiny second bounce hold (5 frames)
  0, 1, 2, 3                         // final settle (4 frames)
];
const DMG_BOUNCE_FRAME_MS = 16.67;
const TARGET_CURSOR_BLINK_MS = 133;      // cursor blink rate during target select
// Damage number palette — sprite pal3 during damage display (FCEUX PPU dump)
// $0F=black, $0F=black, $25=purple, $2B=green
const DMG_NUM_PAL = [0x0F, 0x0F, 0x0F, 0x25];

// Hit stats & slash animation constants
const SLASH_FRAME_MS = 50;               // per frame of slash sprite (3 frames = 150ms)
const SLASH_FRAMES = 3;                  // number of slash animation frames (one per effect set)
const HIT_PAUSE_MS = 150;               // pause showing damage number per hit
const MISS_SHOW_MS = 300;               // "Miss" text display time
const PLAYER_DMG_SHOW_MS = 400;         // pause after final hit before enemy counter
const CRIT_RATE = 5;                     // 5% crit chance per hit
const CRIT_MULT = 1.5;                  // critical hit damage multiplier
const BASE_HIT_RATE = 80;               // 80% accuracy per hit (unarmed Onion Knight)
const BOSS_HIT_RATE = 85;               // boss accuracy
const GOBLIN_HIT_RATE = 75;             // goblin accuracy

// Top box — battle scene BG or area name
let topBoxMode = 'name';       // 'name' | 'battle'
let topBoxNameBytes = null;    // Uint8Array for area name text
let topBoxBgCanvas = null;     // Pre-rendered 256×32 battle BG strip (frame 0 = original)
let topBoxBgFadeFrames = null; // [original, step1, step2, ..., black] — NES palette fade
let topBoxIsTown = false;      // true = always show name, never switch to battle

// Top box scroll animation — blue name banner slides in/out
let topBoxScrollState = 'none'; // 'none' | 'pending' | 'fade-in' | 'display' | 'fade-out'
let topBoxScrollTimer = 0;
let topBoxFadeStep = 0;         // 0 = full bright, 4 = fully black ($0F)
let topBoxScrollOnDone = null;  // callback when fade-out finishes
const TOPBOX_FADE_STEP_MS = 100;     // ms per NES fade step
const TOPBOX_FADE_STEPS = 4;         // 4 steps: $30→$20→$10→$00→$0F
const TOPBOX_DISPLAY_HOLD = 1800;    // ms to show area name

// White text on blue background — colors 1&2 = NES $02 (blue) so cell bg matches fill
const TEXT_WHITE_ON_BLUE = [0x02, 0x02, 0x02, 0x30];

// Area name tile bytes (see text-system.md for encoding)
const AREA_NAMES = new Map([
  [114, new Uint8Array([0x9E, 0xDB])],  // "Ur"
]);
const DUNGEON_NAME = new Uint8Array([0x8A, 0xD5, 0xDD, 0xCA, 0xDB, 0xFF, 0x8C, 0xCA, 0xDF, 0xCE]); // "Altar Cave"

// Pause menu state
let pauseState = 'none';       // 'none'|'scroll-in'|'text-in'|'open'|'text-out'|'scroll-out'
let pauseTimer = 0;
let pauseCursor = 0;           // 0-5
const PAUSE_SCROLL_MS = 150;   // bordered panel scroll down/up
const PAUSE_TEXT_STEP_MS = 100; // NES fade step duration
const PAUSE_TEXT_STEPS = 4;    // 4 steps: $30→$20→$10→$00→$0F
const PAUSE_MENU_W = 80;       // 10 tiles wide (left half of viewport)
const PAUSE_MENU_H = 112;      // 14 tiles tall
const CURSOR_TILE_ROM = 0x01B450;  // hand cursor (4 tiles, 2x2 = 16x16)
let cursorTileCanvas = null;
const PAUSE_ITEMS = [
  new Uint8Array([0x92,0xDD,0xCE,0xD6]),           // "Item"
  new Uint8Array([0x96,0xCA,0xD0,0xD2,0xCC]),       // "Magic"
  new Uint8Array([0x8E,0xDA,0xDE,0xD2,0xD9]),       // "Equip"
  new Uint8Array([0x9C,0xDD,0xCA,0xDD,0xDC]),       // "Stats"
  new Uint8Array([0x93,0xD8,0xCB]),                 // "Job"
  new Uint8Array([0x9C,0xCA,0xDF,0xCE]),             // "Save"
];

// Battle text byte arrays
const BATTLE_ROAR = new Uint8Array([0x9B,0x98,0x98,0x98,0x98,0x98,0x8A,0x9B,0xC4,0xC4]); // "ROOOOOAR!!"
const BATTLE_FIGHT = new Uint8Array([0x8F,0xD2,0xD0,0xD1,0xDD]); // "Fight"
const BATTLE_RUN = new Uint8Array([0x9B,0xDE,0xD7]); // "Run"
const BATTLE_CANT_ESCAPE = new Uint8Array([0x8C,0xCA,0xD7,0xDD,0xFF,0xCE,0xDC,0xCC,0xCA,0xD9,0xCE,0xC4]); // "Cant escape!"
const BATTLE_NO_MAGIC = new Uint8Array([0x97,0xD8,0xFF,0xD6,0xCA,0xD0,0xD2,0xCC,0xC4]); // "No magic!"
const BATTLE_NO_ITEMS = new Uint8Array([0x97,0xD8,0xFF,0xD2,0xDD,0xCE,0xD6,0xDC,0xC4]); // "No items!"
const BATTLE_VICTORY = new Uint8Array([0x9F,0xD2,0xCC,0xDD,0xD8,0xDB,0xE2,0xC4]); // "Victory!"
const BATTLE_GOT_EXP = new Uint8Array([0x90,0xD8,0xDD,0xFF,0x82,0x80,0xFF,0x8E,0xA1,0x99,0xC4]); // "Got 20 EXP!"
const BATTLE_LEVEL_UP = new Uint8Array([0x95,0xCE,0xDF,0xCE,0xD5,0xFF,0x9E,0xD9,0xC4]); // "Level Up!"
const BATTLE_BOSS_NAME = new Uint8Array([0x95,0xCA,0xD7,0xCD,0xFF,0x9D,0xDE,0xDB,0xDD,0xD5,0xCE]); // "Land Turtle"
const BATTLE_GOBLIN_NAME = new Uint8Array([0x90,0xD8,0xCB,0xD5,0xD2,0xD7]); // "Goblin"
const BATTLE_MENU_ITEMS = [BATTLE_FIGHT, PAUSE_ITEMS[1]/*Magic*/, PAUSE_ITEMS[0]/*Item*/, BATTLE_RUN];

// Player sprite palettes — from FCEUX PPU trace (dual palette: top/bottom tiles)
const SPRITE_PAL_TOP = [0x0F, 0x0F, 0x16, 0x30];    // spr_pal0: black, dark red, white
const SPRITE_PAL_BTM = [0x1A, 0x0F, 0x15, 0x30];    // spr_pal1: black, magenta, white

let canvas, ctx;
let sprite = null;
let mapRenderer = null;
let mapData = null;
let lastTime = 0;
const keys = {};

// Room transition state
let romRaw = null;
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
    // Name entry mode — capture all keys, block game controls
    if (titleState === 'name-entry') {
      e.preventDefault();
      if (e.key === 'Enter' && nameBuffer.length > 0) {
        saveSlots[selectCursor] = { name: new Uint8Array(nameBuffer), level: 1, exp: 0, stats: null };
        saveSlotsToDB();
        titleState = 'select'; titleTimer = 0;
      } else if (e.key === 'Backspace') {
        if (nameBuffer.length > 0) nameBuffer.pop();
        else { titleState = 'select'; titleTimer = 0; } // cancel
      } else if (e.key.length === 1 && /[a-zA-Z]/.test(e.key) && nameBuffer.length < NAME_MAX_LEN) {
        const ch = e.key;
        if (ch >= 'A' && ch <= 'Z') nameBuffer.push(0x8A + ch.charCodeAt(0) - 65);
        else nameBuffer.push(0xCA + ch.charCodeAt(0) - 97);
      }
      return; // block all other key handling (Z, X, arrows disabled)
    }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'z', 'Z', 'x', 'X', 'Enter'].includes(e.key)) {
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

  // Save on exit
  window.addEventListener('beforeunload', () => saveSlotsToDB());
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
  borderTileCanvases = tileCanvases;

  // Blue-background variant — palette index 0 uses 0x02 instead of 0x0F
  const BLUE_MENU_PALETTE = [0x02, 0x00, 0x02, 0x30];
  borderBlueTileCanvases = tiles.map(pixels => {
    const c = document.createElement('canvas');
    c.width = 8; c.height = 8;
    const tctx = c.getContext('2d');
    const img = tctx.createImageData(8, 8);
    for (let i = 0; i < 64; i++) {
      const nesIdx = BLUE_MENU_PALETTE[pixels[i]];
      const rgb = NES_SYSTEM_PALETTE[nesIdx] || [0, 0, 0];
      img.data[i * 4]     = rgb[0];
      img.data[i * 4 + 1] = rgb[1];
      img.data[i * 4 + 2] = rgb[2];
      img.data[i * 4 + 3] = 255;
    }
    tctx.putImageData(img, 0, 0);
    return c;
  });

  // Pre-render border tiles at each fade level for loading screen
  borderFadeSets = [];
  for (let step = 0; step <= LOAD_FADE_MAX; step++) {
    const fadedPal = MENU_PALETTE.map(c => {
      let fc = c;
      for (let s = 0; s < step; s++) fc = nesColorFade(fc);
      return fc;
    });
    const set = tiles.map(pixels => {
      const c = document.createElement('canvas');
      c.width = 8; c.height = 8;
      const tctx = c.getContext('2d');
      const img = tctx.createImageData(8, 8);
      for (let i = 0; i < 64; i++) {
        const nesIdx = fadedPal[pixels[i]];
        const rgb = NES_SYSTEM_PALETTE[nesIdx] || [0, 0, 0];
        img.data[i * 4]     = rgb[0];
        img.data[i * 4 + 1] = rgb[1];
        img.data[i * 4 + 2] = rgb[2];
        img.data[i * 4 + 3] = 255;
      }
      tctx.putImageData(img, 0, 0);
      return c;
    });
    borderFadeSets.push(set);
  }

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

function initCursorTile(romData) {
  const palette = [0x0F, 0x00, 0x10, 0x30]; // cursor palette: black, dark gray, gray, white
  cursorTileCanvas = document.createElement('canvas');
  cursorTileCanvas.width = 16; cursorTileCanvas.height = 16;
  const cctx = cursorTileCanvas.getContext('2d');
  // 4 tiles in 2x2: TL(0), TR(1), BL(2), BR(3)
  const layout = [[0, 0], [8, 0], [0, 8], [8, 8]];
  for (let t = 0; t < 4; t++) {
    const pixels = decodeTile(romData, CURSOR_TILE_ROM + t * 16);
    const img = cctx.createImageData(8, 8);
    for (let i = 0; i < 64; i++) {
      const ci = pixels[i];
      if (ci === 0) {
        img.data[i * 4 + 3] = 0;
      } else {
        const rgb = NES_SYSTEM_PALETTE[palette[ci]] || [0, 0, 0];
        img.data[i * 4]     = rgb[0];
        img.data[i * 4 + 1] = rgb[1];
        img.data[i * 4 + 2] = rgb[2];
        img.data[i * 4 + 3] = 255;
      }
    }
    cctx.putImageData(img, layout[t][0], layout[t][1]);
  }
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

  // Silhouette: same shape, all non-transparent pixels → NES $00 (grey)
  silhouetteCanvas = document.createElement('canvas');
  silhouetteCanvas.width = 16;
  silhouetteCanvas.height = 16;
  const sctx = silhouetteCanvas.getContext('2d');
  sctx.drawImage(battleSpriteCanvas, 0, 0);
  const sdata = sctx.getImageData(0, 0, 16, 16);
  const darkRgb = NES_SYSTEM_PALETTE[0x00] || [0, 0, 0];
  for (let p = 0; p < 16 * 16; p++) {
    if (sdata.data[p * 4 + 3] > 0) {
      sdata.data[p * 4]     = darkRgb[0];
      sdata.data[p * 4 + 1] = darkRgb[1];
      sdata.data[p * 4 + 2] = darkRgb[2];
    }
  }
  sctx.putImageData(sdata, 0, 0);

  // Helper: decode PPU tile bytes into canvas ImageData using palette
  function drawTileToCanvas(tileBytes, tctx, x, y) {
    const px = decodeTile(tileBytes, 0);
    const img = tctx.createImageData(8, 8);
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
    tctx.putImageData(img, x, y);
  }

  // Attack pose tiles from FCEUX PPU dump (unarmed, weapons zeroed)
  // Right hand: mid-L changes $03→$39 (mid-R $04 stays)
  // Left hand: mid-L changes $03→$3B, mid-R changes $04→$3C
  const ATK_R_39 = new Uint8Array([0x1F,0x04,0x16,0x16,0x2F,0x7F,0x70,0x26,
                                    0x00,0x00,0x00,0x00,0x30,0x70,0x70,0x3E]);
  const ATK_L_3B = new Uint8Array([0x1F,0x04,0x16,0x16,0x0C,0x08,0x38,0x7C,
                                    0x00,0x00,0x00,0x00,0x11,0x03,0x38,0x7D]);
  const ATK_L_3C = new Uint8Array([0x18,0x80,0x48,0xCC,0x00,0x00,0x00,0x00,
                                    0x59,0x32,0x38,0x0C,0x80,0xC0,0x00,0x60]);

  // Right-hand punch canvas (mid-L = $39)
  battleSpriteAttackCanvas = document.createElement('canvas');
  battleSpriteAttackCanvas.width = 16;
  battleSpriteAttackCanvas.height = 16;
  const actx = battleSpriteAttackCanvas.getContext('2d');
  actx.drawImage(battleSpriteCanvas, 0, 0);
  drawTileToCanvas(ATK_R_39, actx, 0, 8);

  // Left-hand punch canvas (mid-L = $3B, mid-R = $3C)
  battleSpriteAttackLCanvas = document.createElement('canvas');
  battleSpriteAttackLCanvas.width = 16;
  battleSpriteAttackLCanvas.height = 16;
  const alctx = battleSpriteAttackLCanvas.getContext('2d');
  alctx.drawImage(battleSpriteCanvas, 0, 0);
  drawTileToCanvas(ATK_L_3B, alctx, 0, 8);
  drawTileToCanvas(ATK_L_3C, alctx, 8, 8);

  // Victory pose: sprite frame 4 in job block (tiles 24-27), read from ROM like idle
  const VICTORY_SPRITE_OFFSET = BATTLE_SPRITE_ROM + 24 * 16;
  battleSpriteVictoryCanvas = document.createElement('canvas');
  battleSpriteVictoryCanvas.width = 16;
  battleSpriteVictoryCanvas.height = 16;
  const vctx = battleSpriteVictoryCanvas.getContext('2d');
  for (let i = 0; i < 4; i++) {
    const px = decodeTile(romData, VICTORY_SPRITE_OFFSET + i * 16);
    const vimg = vctx.createImageData(8, 8);
    for (let p = 0; p < 64; p++) {
      const ci = px[p];
      if (ci === 0) {
        vimg.data[p * 4 + 3] = 0;
      } else {
        const rgb = NES_SYSTEM_PALETTE[palette[ci]] || [0, 0, 0];
        vimg.data[p * 4]     = rgb[0];
        vimg.data[p * 4 + 1] = rgb[1];
        vimg.data[p * 4 + 2] = rgb[2];
        vimg.data[p * 4 + 3] = 255;
      }
    }
    vctx.putImageData(vimg, layout[i][0], layout[i][1]);
  }
}

function initAdamantoise(romData) {
  // 4 tiles at FF2_ADAMANTOISE_SPRITE, row-major: TL, TR, BL, BR
  // Battle colors with black outline (index 1) for small map sprite
  const palTop = [0x0F, 0x0F, LAND_TURTLE_PAL_TOP[1], LAND_TURTLE_PAL_TOP[2]];
  const palBot = [0x0F, 0x0F, LAND_TURTLE_PAL_BOT[3], LAND_TURTLE_PAL_BOT[2]];
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

function initPlayerStats(romData) {
  // Job 0 (Onion Knight): 8 bytes at JOB_BASE_STATS_OFF
  const jobOff = JOB_BASE_STATS_OFF;
  const str = romData[jobOff + 2];
  const agi = romData[jobOff + 3];
  const vit = romData[jobOff + 4];
  const int_ = romData[jobOff + 5];
  const mnd = romData[jobOff + 6];
  const mpIdx = romData[jobOff + 7];

  // Starting HP — 2 bytes little-endian
  const hp = romData[CHAR_INIT_HP_OFF] | (romData[CHAR_INIT_HP_OFF + 1] << 8);

  // Starting MP — indexed by mpIdx, 8 bytes per entry (levels 1-8), take level 1
  const mp = romData[CHAR_INIT_MP_OFF + mpIdx * 8];

  playerStats = { str, agi, vit, int: int_, mnd, hp, maxHP: hp, mp, maxMP: mp, level: 1, exp: 0, expToNext: 0 };
  playerHP = hp;
  playerMP = mp;
  playerATK = str;
  playerDEF = vit;
}

function initExpTable(romData) {
  expTable = new Uint32Array(98);
  for (let i = 0; i < 98; i++) {
    const off = LEVEL_EXP_TABLE_OFF + i * 3;
    expTable[i] = romData[off] | (romData[off + 1] << 8) | (romData[off + 2] << 16);
  }
  playerStats.expToNext = expTable[0];
}

function grantExp(amount) {
  playerStats.exp += amount;
  leveledUp = false;
  while (playerStats.exp >= playerStats.expToNext && playerStats.level < 99) {
    playerStats.level++;
    const lv = playerStats.level;

    // HP growth: vit + random(0, floor(vit/2)) + level * 2 (from disasm 35/BECA-BF09)
    const hpGain = playerStats.vit + Math.floor(Math.random() * (Math.floor(playerStats.vit / 2) + 1)) + lv * 2;
    playerStats.maxHP = Math.min(9999, playerStats.maxHP + hpGain);

    // Stat bonuses from ROM — job 0 (Onion Knight), 2 bytes per level
    const bonusOff = LEVEL_STAT_BONUS_OFF + 0 * 196 + (lv - 1) * 2;
    const byte1 = romRaw[bonusOff];
    const byte2 = romRaw[bonusOff + 1];
    const bonusAmt = byte1 & 0x07;
    if (byte1 & 0x80) playerStats.str += bonusAmt;
    if (byte1 & 0x40) playerStats.agi += bonusAmt;
    if (byte1 & 0x20) playerStats.vit += bonusAmt;
    if (byte1 & 0x10) playerStats.int += bonusAmt;
    if (byte1 & 0x08) playerStats.mnd += bonusAmt;

    // MP bonus — count set bits in byte2
    let mpBits = byte2;
    let mpGain = 0;
    while (mpBits) { mpGain += mpBits & 1; mpBits >>= 1; }
    playerStats.maxMP += mpGain;

    // Full heal on level-up (matches FF3)
    playerStats.hp = playerStats.maxHP;
    playerStats.mp = playerStats.maxMP;
    playerHP = playerStats.maxHP;
    playerMP = playerStats.maxMP;

    // Update derived combat stats
    playerATK = playerStats.str;
    playerDEF = playerStats.vit;

    // Next threshold
    if (lv - 1 < 98) playerStats.expToNext = expTable[lv - 1];
    else playerStats.expToNext = 0xFFFFFF; // max level

    leveledUp = true;
  }
  return { leveledUp };
}

function initLandTurtleBattle(romData) {
  // 36 tiles at LAND_TURTLE_GFX_OFF, sequentially (6×6 grid = 48×48 pixels)
  // Tilemap IDs $70-$93 are PPU positions; ROM data starts at tile 0
  const tiles = [];
  for (let i = 0; i < LAND_TURTLE_TILES; i++) {
    tiles.push(decodeTile(romData, LAND_TURTLE_GFX_OFF + i * 16));
  }

  const c = document.createElement('canvas');
  c.width = LAND_TURTLE_COLS * 8;   // 48
  c.height = LAND_TURTLE_COLS * 8;  // 48
  const cctx = c.getContext('2d');

  for (let ty = 0; ty < LAND_TURTLE_COLS; ty++) {
    const pal = ty < 4 ? LAND_TURTLE_PAL_TOP : LAND_TURTLE_PAL_BOT;
    for (let tx = 0; tx < LAND_TURTLE_COLS; tx++) {
      const img = cctx.createImageData(8, 8);
      const px = tiles[ty * LAND_TURTLE_COLS + tx];
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
      cctx.putImageData(img, tx * 8, ty * 8);
    }
  }

  landTurtleBattleCanvas = c;

  // Create all-white version for pre-attack flash blink
  const wc = document.createElement('canvas');
  wc.width = 48; wc.height = 48;
  const wctx = wc.getContext('2d');
  const srcData = cctx.getImageData(0, 0, 48, 48);
  const whiteRGB = NES_SYSTEM_PALETTE[0x30] || [255, 255, 255];
  for (let p = 0; p < srcData.data.length; p += 4) {
    if (srcData.data[p + 3] > 0) {
      srcData.data[p]     = whiteRGB[0];
      srcData.data[p + 1] = whiteRGB[1];
      srcData.data[p + 2] = whiteRGB[2];
    }
  }
  wctx.putImageData(srcData, 0, 0);
  landTurtleWhiteCanvas = wc;
}

function _renderGoblinSprite(tiles, pal0, pal1, tilePalMap) {
  const c = document.createElement('canvas');
  c.width = GOBLIN_COLS * 8;   // 32
  c.height = GOBLIN_COLS * 8;  // 32
  const cctx = c.getContext('2d');
  for (let ty = 0; ty < GOBLIN_COLS; ty++) {
    for (let tx = 0; tx < GOBLIN_COLS; tx++) {
      const tileIdx = ty * GOBLIN_COLS + tx;
      const pal = tilePalMap[tileIdx] === 1 ? pal1 : pal0;
      const img = cctx.createImageData(8, 8);
      const px = tiles[tileIdx];
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
      cctx.putImageData(img, tx * 8, ty * 8);
    }
  }
  return c;
}

function initGoblinSprite(romData) {
  const tiles = [];
  for (let i = 0; i < GOBLIN_TILES; i++) {
    tiles.push(decodeTile(romData, GOBLIN_GFX_OFF + i * 16));
  }

  // Render full-color sprite
  goblinBattleCanvas = _renderGoblinSprite(tiles, GOBLIN_PAL0, GOBLIN_PAL1, GOBLIN_TILE_PAL);

  // Create all-white version for pre-attack flash blink
  const wc = document.createElement('canvas');
  wc.width = 32; wc.height = 32;
  const wctx = wc.getContext('2d');
  const cctx = goblinBattleCanvas.getContext('2d');
  const srcData = cctx.getImageData(0, 0, 32, 32);
  const whiteRGB = NES_SYSTEM_PALETTE[0x30] || [255, 255, 255];
  for (let p = 0; p < srcData.data.length; p += 4) {
    if (srcData.data[p + 3] > 0) {
      srcData.data[p]     = whiteRGB[0];
      srcData.data[p + 1] = whiteRGB[1];
      srcData.data[p + 2] = whiteRGB[2];
    }
  }
  wctx.putImageData(srcData, 0, 0);
  goblinWhiteCanvas = wc;

  // Pre-render death deterioration frames — dithered diagonal dissolve
  // Uses Bayer 4×4 matrix for the pixelated look, diagonal sweep top-right → bottom-left
  const origData = goblinBattleCanvas.getContext('2d').getImageData(0, 0, 32, 32);
  const maxThreshold = 62 + 15; // (31-0+31) + max bayer value
  goblinDeathFrames = [];
  for (let f = 0; f < MONSTER_DEATH_FRAMES; f++) {
    const fc = document.createElement('canvas');
    fc.width = 32; fc.height = 32;
    const fctx = fc.getContext('2d');
    const fd = fctx.createImageData(32, 32);
    const wave = (f / (MONSTER_DEATH_FRAMES - 1)) * (maxThreshold + 1);
    for (let py = 0; py < 32; py++) {
      for (let px = 0; px < 32; px++) {
        const idx = (py * 32 + px) * 4;
        const diag = (31 - px) + py;
        const threshold = diag + BAYER4[py & 3][px & 3];
        if (threshold < wave) {
          fd.data[idx + 3] = 0; // erased — transparent
        } else {
          fd.data[idx]     = origData.data[idx];
          fd.data[idx + 1] = origData.data[idx + 1];
          fd.data[idx + 2] = origData.data[idx + 2];
          fd.data[idx + 3] = origData.data[idx + 3];
        }
      }
    }
    fctx.putImageData(fd, 0, 0);
    goblinDeathFrames.push(fc);
  }
}

function initInvincibleSprite(romData) {
  // Decode tiles $C0-$FF from ROM (64 tiles, 16 bytes each)
  const tilePixels = new Map();
  for (let i = 0; i < 64; i++) {
    tilePixels.set(0xC0 + i, decodeTile(romData, INVINCIBLE_TILE_ROM + i * 16));
  }

  // H-flip a decoded 8×8 tile
  function hflipTile(pixels) {
    const out = new Uint8Array(64);
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        out[row * 8 + col] = pixels[row * 8 + (7 - col)];
      }
    }
    return out;
  }

  // Render a 32×32 frame from a 4×4 tile grid (east-facing = h-flipped tiles)
  function renderFrame(grid, pal) {
    const c = document.createElement('canvas');
    c.width = 32; c.height = 32;
    const fctx = c.getContext('2d');
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        const tileId = grid[row * 4 + col];
        let pixels = tilePixels.get(tileId);
        if (!pixels) continue;
        pixels = hflipTile(pixels); // east-facing tiles are all h-flipped
        const img = fctx.createImageData(8, 8);
        for (let p = 0; p < 64; p++) {
          const ci = pixels[p];
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
        fctx.putImageData(img, col * 8, row * 8);
      }
    }
    return c;
  }

  // East-facing frame a (from OAM at 3C:8586) — tiles reversed per row + h-flip
  const frameA_grid = [
    0xE5, 0xE4, 0xE3, 0xE2,  // row 0
    0xE9, 0xE8, 0xE7, 0xE6,  // row 1
    0xED, 0xEC, 0xEB, 0xEA,  // row 2
    0xF1, 0xF0, 0xEF, 0xEE,  // row 3
  ];
  // East-facing frame b (from OAM at 3C:85C7) — alt animation
  const frameB_grid = [
    0xF5, 0xF4, 0xF3, 0xF2,  // row 0
    0xF6, 0xE8, 0xE7, 0xE6,  // row 1
    0xF7, 0xEC, 0xEB, 0xEA,  // row 2
    0xFB, 0xFA, 0xF9, 0xF8,  // row 3
  ];

  invincibleFrames = [
    renderFrame(frameA_grid, INVINCIBLE_PAL),
    renderFrame(frameB_grid, INVINCIBLE_PAL),
  ];

  // Pre-render faded frames for NES palette fade
  invincibleFadeFrames = [];
  for (let fl = 0; fl <= TITLE_FADE_MAX; fl++) {
    const fadedPal = INVINCIBLE_PAL.map((c, i) => {
      if (i === 0) return c;
      let fc = c;
      for (let s = 0; s < fl; s++) fc = nesColorFade(fc);
      return fc;
    });
    invincibleFadeFrames.push([
      renderFrame(frameA_grid, fadedPal),
      renderFrame(frameB_grid, fadedPal),
    ]);
  }

  // Shadow — 4 tiles wide × 1 tall (32×8): C0, C1, C1, C0-hflip (from OAM at 3C:8608)
  function renderShadow(pal) {
    const c = document.createElement('canvas');
    c.width = 32; c.height = 8;
    const sctx = c.getContext('2d');
    const shadowTiles = [0xC0, 0xC1, 0xC1, 0xC0];
    const shadowFlip  = [false, false, false, true];
    for (let col = 0; col < 4; col++) {
      let pixels = tilePixels.get(shadowTiles[col]);
      if (!pixels) continue;
      if (shadowFlip[col]) pixels = hflipTile(pixels);
      const img = sctx.createImageData(8, 8);
      for (let p = 0; p < 64; p++) {
        const ci = pixels[p];
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
      sctx.putImageData(img, col * 8, 0);
    }
    return c;
  }

  invincibleShadowFade = [];
  for (let fl = 0; fl <= TITLE_FADE_MAX; fl++) {
    const fadedPal = INVINCIBLE_PAL.map((c, i) => {
      if (i === 0) return c;
      let fc = c;
      for (let s = 0; s < fl; s++) fc = nesColorFade(fc);
      return fc;
    });
    invincibleShadowFade.push(renderShadow(fadedPal));
  }
}

function initMoogleSprite(romData) {
  // South-facing walk: tiles 0-3 (TL, TR, BL, BR) at MOOGLE_SPRITE_OFF
  const tiles = [];
  for (let i = 0; i < 4; i++) {
    tiles.push(decodeTile(romData, MOOGLE_SPRITE_OFF + i * 16));
  }

  const normal = document.createElement('canvas');
  normal.width = 16; normal.height = 16;
  const mctx = normal.getContext('2d');
  const layout = [[0,0], [8,0], [0,8], [8,8]];

  for (let i = 0; i < 4; i++) {
    const img = mctx.createImageData(8, 8);
    const px = tiles[i];
    for (let p = 0; p < 64; p++) {
      const ci = px[p];
      if (ci === 0) {
        img.data[p * 4 + 3] = 0;
      } else {
        const rgb = NES_SYSTEM_PALETTE[MOOGLE_PAL[ci]] || [0, 0, 0];
        img.data[p * 4]     = rgb[0];
        img.data[p * 4 + 1] = rgb[1];
        img.data[p * 4 + 2] = rgb[2];
        img.data[p * 4 + 3] = 255;
      }
    }
    mctx.putImageData(img, layout[i][0], layout[i][1]);
  }

  const flipped = document.createElement('canvas');
  flipped.width = 16; flipped.height = 16;
  const fctx = flipped.getContext('2d');
  fctx.translate(16, 0);
  fctx.scale(-1, 1);
  fctx.drawImage(normal, 0, 0);

  moogleFrames = [normal, flipped];
}

// Pre-render a 16x16 sprite with a faded palette (NES color fade steps applied)
function renderSpriteFaded(romData, spriteOff, basePal, fadeSteps) {
  const fadedPal = basePal.map((c, i) => {
    if (i === 0) return c; // transparent slot stays
    let fc = c;
    for (let s = 0; s < fadeSteps; s++) fc = nesColorFade(fc);
    return fc;
  });

  const tiles = [];
  for (let i = 0; i < 4; i++) {
    tiles.push(decodeTile(romData, spriteOff + i * 16));
  }

  const c = document.createElement('canvas');
  c.width = 16; c.height = 16;
  const cctx = c.getContext('2d');
  const layout = [[0,0], [8,0], [0,8], [8,8]];

  for (let i = 0; i < 4; i++) {
    const img = cctx.createImageData(8, 8);
    const px = tiles[i];
    for (let p = 0; p < 64; p++) {
      const ci = px[p];
      if (ci === 0) {
        img.data[p * 4 + 3] = 0;
      } else {
        const rgb = NES_SYSTEM_PALETTE[fadedPal[ci]] || [0, 0, 0];
        img.data[p * 4]     = rgb[0];
        img.data[p * 4 + 1] = rgb[1];
        img.data[p * 4 + 2] = rgb[2];
        img.data[p * 4 + 3] = 255;
      }
    }
    cctx.putImageData(img, layout[i][0], layout[i][1]);
  }
  return c;
}

// Pre-render fade frames for adamantoise (different palette for top/bottom halves)
function renderBossFaded(romData, fadeSteps) {
  const palTop = [0x0F, 0x0F, LAND_TURTLE_PAL_TOP[1], LAND_TURTLE_PAL_TOP[2]];
  const palBot = [0x0F, 0x0F, LAND_TURTLE_PAL_BOT[3], LAND_TURTLE_PAL_BOT[2]];
  const fadedTop = palTop.map((c, i) => {
    if (i === 0) return c;
    let fc = c; for (let s = 0; s < fadeSteps; s++) fc = nesColorFade(fc);
    return fc;
  });
  const fadedBot = palBot.map((c, i) => {
    if (i === 0) return c;
    let fc = c; for (let s = 0; s < fadeSteps; s++) fc = nesColorFade(fc);
    return fc;
  });

  const tiles = [];
  for (let i = 0; i < 4; i++) {
    tiles.push(decodeTile(romData, FF2_ADAMANTOISE_SPRITE + i * 16));
  }

  const c = document.createElement('canvas');
  c.width = 16; c.height = 16;
  const cctx = c.getContext('2d');
  const layout = [[0,0], [8,0], [0,8], [8,8]];

  for (let i = 0; i < 4; i++) {
    const pal = i < 2 ? fadedTop : fadedBot;
    const img = cctx.createImageData(8, 8);
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
    cctx.putImageData(img, layout[i][0], layout[i][1]);
  }
  return c;
}

function initLoadingScreenFadeFrames(romData) {
  // Moogle: 4 fade levels (0=bright, 3=black)
  moogleFadeFrames = [];
  for (let step = 0; step <= LOAD_FADE_MAX; step++) {
    const normal = renderSpriteFaded(romData, MOOGLE_SPRITE_OFF, MOOGLE_PAL, step);
    const flipped = document.createElement('canvas');
    flipped.width = 16; flipped.height = 16;
    const fctx = flipped.getContext('2d');
    fctx.translate(16, 0);
    fctx.scale(-1, 1);
    fctx.drawImage(normal, 0, 0);
    moogleFadeFrames.push([normal, flipped]);
  }

  // Boss (adamantoise from FF1&2 ROM): only if ff12Raw loaded
  if (ff12Raw) {
    bossFadeFrames = [];
    for (let step = 0; step <= LOAD_FADE_MAX; step++) {
      const normal = renderBossFaded(ff12Raw, step);
      const flipped = document.createElement('canvas');
      flipped.width = 16; flipped.height = 16;
      const fctx = flipped.getContext('2d');
      fctx.translate(16, 0);
      fctx.scale(-1, 1);
      fctx.drawImage(normal, 0, 0);
      bossFadeFrames.push([normal, flipped]);
    }
  }
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

// ── Title Screen Init ──

const TITLE_OCEAN_CHR = [0x22, 0x23, 0x24, 0x25]; // horizontal water CHR tile IDs
const TITLE_WATER_PAL_IDX = 2; // world map palette index for ocean
const TITLE_SKY_BGID = 5;      // ocean battle BG (blue sky + waves)

function initTitleWater(romData) {
  const COMMON_CHR = 0x014C10;
  const BG_PALETTE = 0x001650;

  // Decode the 4 ocean CHR tiles
  const chrTiles = {};
  for (const ci of TITLE_OCEAN_CHR) {
    chrTiles[ci] = decodeTile(romData, COMMON_CHR + ci * 16);
  }

  // Water palette from world map
  const palOff = BG_PALETTE + TITLE_WATER_PAL_IDX * 4;
  const basePal = [romData[palOff], romData[palOff+1], romData[palOff+2], romData[palOff+3]];

  // Pre-compute 16 horizontal shift frames for each CHR pair
  const pairs = [[0x22, 0x23], [0x24, 0x25]];
  const shifted = {}; // ci → [frame0..frame15] pixel arrays
  for (const [ciL, ciR] of pairs) {
    const bL = chrTiles[ciL], bR = chrTiles[ciR];
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
        nL[r] = ((l >> 1) | ((ri & 1) << 7)) & 0xFF;
        nR[r] = ((ri >> 1) | ((l & 1) << 7)) & 0xFF;
      }
      cL = nL; cR = nR;
    }
    shifted[ciL] = arrL;
    shifted[ciR] = arrR;
  }

  // Helper: render one 16×16 ocean metatile with given palette
  function renderOceanTile(pal, animFrame) {
    const rgbPal = pal.map(ni => NES_SYSTEM_PALETTE[ni & 0x3F] || [0,0,0]);
    const c = document.createElement('canvas');
    c.width = 16; c.height = 16;
    const tctx = c.getContext('2d');
    const quads = [
      [shifted[0x22][animFrame], 0, 0], [shifted[0x23][animFrame], 8, 0],
      [shifted[0x24][animFrame], 0, 8], [shifted[0x25][animFrame], 8, 8],
    ];
    for (const [pixels, ox, oy] of quads) {
      const img = tctx.createImageData(8, 8);
      for (let p = 0; p < 64; p++) {
        const ci = pixels[p];
        const rgb = rgbPal[ci];
        img.data[p*4] = rgb[0]; img.data[p*4+1] = rgb[1];
        img.data[p*4+2] = rgb[2]; img.data[p*4+3] = 255;
      }
      tctx.putImageData(img, ox, oy);
    }
    return c;
  }

  // 16 animation frames at full brightness
  titleWaterFrames = [];
  for (let f = 0; f < 16; f++) {
    titleWaterFrames.push(renderOceanTile(basePal, f));
  }

  // Fade levels (0=bright, TITLE_FADE_MAX=black) — static frame 0
  titleWaterFadeTiles = [];
  const fadePal = [...basePal];
  for (let step = 0; step <= TITLE_FADE_MAX; step++) {
    titleWaterFadeTiles.push(renderOceanTile(step === 0 ? basePal : fadePal, 0));
    if (step < TITLE_FADE_MAX) {
      fadePal[0] = nesColorFade(fadePal[0]);
      fadePal[1] = nesColorFade(fadePal[1]);
      fadePal[2] = nesColorFade(fadePal[2]);
      fadePal[3] = nesColorFade(fadePal[3]);
    }
  }
}

function initTitleSky(romData) {
  const bgId = TITLE_SKY_BGID;
  const palette = [
    0x0F,
    romData[BATTLE_BG_PAL_C1 + bgId],
    romData[BATTLE_BG_PAL_C2 + bgId],
    romData[BATTLE_BG_PAL_C3 + bgId],
  ];

  const tiles = [];
  const tileBase = BATTLE_BG_TILES_ROM + bgId * 0x100;
  for (let i = 0; i < 16; i++) tiles.push(decodeTile(romData, tileBase + i * 16));

  const metaTiles = [];
  for (let m = 0; m < 4; m++) {
    const ids = [];
    for (let j = 0; j < 4; j++) ids.push(romData[BATTLE_BG_META_TILES + m*4 + j] - 0x60);
    metaTiles.push(ids);
  }

  const tilemapIdx = romData[BATTLE_BG_TMID_TABLE + bgId];
  const tmBase = BATTLE_BG_TILEMAPS + tilemapIdx * 32;
  const tilemap = [];
  for (let i = 0; i < 32; i++) tilemap.push(romData[tmBase + i]);

  // Pre-render fade frames (same approach as renderBattleBg but stored separately)
  titleSkyFrames = [];
  const fadePal = [...palette];
  while (true) {
    titleSkyFrames.push(renderBattleBgWithPalette(romData, bgId, fadePal, tiles, metaTiles, tilemap));
    if (fadePal[1] === 0x0F && fadePal[2] === 0x0F && fadePal[3] === 0x0F) break;
    fadePal[1] = nesColorFade(fadePal[1]);
    fadePal[2] = nesColorFade(fadePal[2]);
    fadePal[3] = nesColorFade(fadePal[3]);
  }
}

/**
 * Set up top box state for a given area.
 * @param {number} mapId — map being loaded
 * @param {boolean} isWorldMap — true if entering world map
 */
function setupTopBox(mapId, isWorldMap) {
  if (isWorldMap) {
    const bgId = romRaw[BATTLE_BG_MAP_LOOKUP] & 0x1F;
    topBoxBgCanvas = renderBattleBg(romRaw, bgId);
    topBoxMode = 'battle';
    topBoxIsTown = false;
    topBoxNameBytes = null;
    topBoxScrollState = 'none';
    topBoxFadeStep = TOPBOX_FADE_STEPS;
    return;
  }

  if (mapId >= 1000) {
    const romMap = (mapId === 1004) ? 148 : 111;
    const bgId = romRaw[BATTLE_BG_MAP_LOOKUP + romMap] & 0x1F;
    topBoxBgCanvas = renderBattleBg(romRaw, bgId);
    loadingBgFadeFrames = topBoxBgFadeFrames;
    topBoxNameBytes = DUNGEON_NAME;
    topBoxMode = 'battle';
    topBoxIsTown = false;
    topBoxScrollState = 'none';
    topBoxFadeStep = TOPBOX_FADE_STEPS;
    return;
  }

  // Regular map
  if (mapId === 114) {
    if (!topBoxIsTown) {
      topBoxScrollState = 'pending';
    }
    topBoxIsTown = true;
    topBoxNameBytes = AREA_NAMES.get(114);
    topBoxMode = 'name';
  } else if (!topBoxIsTown) {
    const bgId = romRaw[BATTLE_BG_MAP_LOOKUP + mapId] & 0x1F;
    topBoxBgCanvas = renderBattleBg(romRaw, bgId);
    topBoxMode = 'battle';
  }
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

  romRaw = rom.raw;

  // Initialize text decoder and font renderer with patched ROM
  initTextDecoder(romRaw);
  initFont(romRaw);

  initHUD(romRaw);
  initCursorTile(romRaw);
  initBattleSprite(romRaw);
  initLandTurtleBattle(romRaw);
  initGoblinSprite(romRaw);
  initSlashSprites();
  initPlayerStats(romRaw);
  initExpTable(romRaw);
  initMoogleSprite(romRaw);
  initLoadingScreenFadeFrames(romRaw);
  initMusic(romRaw);
  _initFlameRawTiles(romRaw);
  _initStarTiles(romRaw);

  sprite = new Sprite(romRaw, SPRITE_PAL_TOP, SPRITE_PAL_BTM);

  // Pre-load world map data
  worldMapData = loadWorldMap(romRaw, 0);
  worldMapRenderer = new WorldMapRenderer(worldMapData);
  _waterCache = null; // rebuild water frames for this world

  // Title screen assets
  initInvincibleSprite(romRaw);
  initTitleWater(romRaw);
  initTitleSky(romRaw);

  // Load saved player slots from IndexedDB
  await loadSlotsFromDB();

  // Debug mode — skip title, spawn directly in crystal room
  if (window.DEBUG_BOSS) {
    titleState = 'done';
    dungeonSeed = 1;
    clearDungeonCache();
    loadMapById(1004);
    playTrack(TRACKS.CRYSTAL_ROOM);
    lastTime = performance.now();
    requestAnimationFrame(gameLoop);
    return;
  }

  // Start with title screen — map loads after title sequence
  titleState = 'credit-wait';
  titleTimer = 0;
  titleWaterScroll = 0;
  titleSkyScroll = 0;
  titleShipTimer = 0;
  playTrack(TRACKS.TITLE_SCREEN);

  lastTime = performance.now();
  requestAnimationFrame(gameLoop);
}

export function loadFF12ROM(arrayBuffer) {
  ff12Raw = new Uint8Array(arrayBuffer);
  initAdamantoise(ff12Raw);
  if (romRaw) initLoadingScreenFadeFrames(romRaw); // rebuild with boss fade frames
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
    bossSprite = (floorIndex === 4 && adamantoiseFrames && !bossDefeated)
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
  dungeonFloor = -1;
  encounterSteps = 0;
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
  dungeonFloor = -1;
  encounterSteps = 0;
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

  // Block walking onto boss sprite tile
  if (bossSprite && !bossDefeated && tileX === bossSprite.px / TILE_SIZE && tileY === bossSprite.py / TILE_SIZE) {
    sprite.setDirection(dir);
    sprite.resetFrame();
    return;
  }

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

  // Battle menu input — block all other input during battle
  if (battleState !== 'none') {
    if (battleState === 'roar-hold') {
      if (keys['z'] || keys['Z']) { keys['z'] = false; keys['Z'] = false; battleState = 'roar-text-out'; battleTimer = 0; }
    } else if (battleState === 'victory-hold') {
      if (keys['z'] || keys['Z']) { keys['z'] = false; keys['Z'] = false; playSFX(SFX.CONFIRM); battleState = 'exp-text-in'; battleTimer = 0; }
    } else if (battleState === 'exp-hold') {
      if (keys['z'] || keys['Z']) { keys['z'] = false; keys['Z'] = false; playSFX(SFX.CONFIRM); battleState = 'victory-text-out'; battleTimer = 0; }
    } else if (battleState === 'menu-open') {
      // 2×2 grid: 0=Fight(TL) 1=Magic(TR) 2=Item(BL) 3=Run(BR)
      if (keys['ArrowDown'])  { keys['ArrowDown'] = false;  battleCursor ^= 2; playSFX(SFX.CURSOR); }
      if (keys['ArrowUp'])    { keys['ArrowUp'] = false;    battleCursor ^= 2; playSFX(SFX.CURSOR); }
      if (keys['ArrowRight']) { keys['ArrowRight'] = false; battleCursor ^= 1; playSFX(SFX.CURSOR); }
      if (keys['ArrowLeft'])  { keys['ArrowLeft'] = false;  battleCursor ^= 1; playSFX(SFX.CURSOR); }
      if (keys['z'] || keys['Z']) { keys['z'] = false; keys['Z'] = false; executeBattleCommand(battleCursor); }
    } else if (battleState === 'target-select') {
      // Cycle between alive monsters with left/right
      if (isRandomEncounter && encounterMonsters) {
        const aliveIdx = [];
        for (let i = 0; i < encounterMonsters.length; i++) {
          if (encounterMonsters[i].hp > 0) aliveIdx.push(i);
        }
        if (keys['ArrowRight'] || keys['ArrowDown']) {
          keys['ArrowRight'] = false; keys['ArrowDown'] = false;
          const cur = aliveIdx.indexOf(targetIndex);
          targetIndex = aliveIdx[(cur + 1) % aliveIdx.length];
          playSFX(SFX.CURSOR);
        }
        if (keys['ArrowLeft'] || keys['ArrowUp']) {
          keys['ArrowLeft'] = false; keys['ArrowUp'] = false;
          const cur = aliveIdx.indexOf(targetIndex);
          targetIndex = aliveIdx[(cur - 1 + aliveIdx.length) % aliveIdx.length];
          playSFX(SFX.CURSOR);
        }
      }
      if (keys['z'] || keys['Z']) {
        keys['z'] = false; keys['Z'] = false;
        // Confirm target — roll hits, transition to player-slash
        playSFX(SFX.CONFIRM);
        // Unarmed: both hands → minimum 2 hits
        const potentialHits = Math.max(2, Math.floor((playerStats ? playerStats.agi : 5) / 10));
        if (isRandomEncounter && encounterMonsters) {
          const target = encounterMonsters[targetIndex];
          hitResults = rollHits(playerATK, target.def, BASE_HIT_RATE, potentialHits);
        } else {
          hitResults = rollHits(playerATK, BOSS_DEF, BASE_HIT_RATE, potentialHits);
        }
        currentHitIdx = 0;
        slashFrame = 0;
        slashFrames = slashFramesR; // first hit = right hand
        // Base position = target center
        const centerX = HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2);
        const centerY = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2);
        slashX = centerX;
        slashY = centerY;
        // Random offset for punch scatter (ROM: center + random 0-31)
        slashOffX = Math.floor(Math.random() * 40) - 20;
        slashOffY = Math.floor(Math.random() * 40) - 20;
        battleState = 'attack-start';
        battleTimer = 0;
      }
      if (keys['x'] || keys['X']) {
        keys['x'] = false; keys['X'] = false;
        // Cancel — return to menu
        playSFX(SFX.CONFIRM);
        battleState = 'menu-open';
        battleTimer = 0;
      }
    }
    return;
  }

  // Enter — open pause menu
  if (keys['Enter']) {
    keys['Enter'] = false;
    if (pauseState === 'none' && battleState === 'none' && transState === 'none' && !shakeActive && !starEffect && !moving) {
      pauseState = 'scroll-in'; pauseTimer = 0; pauseCursor = 0;
    }
    return;
  }
  // X — close pause menu (back button)
  if (keys['x'] || keys['X']) {
    keys['x'] = false; keys['X'] = false;
    if (pauseState === 'open') {
      pauseState = 'text-out'; pauseTimer = 0;
    }
    return;
  }
  // Pause menu cursor controls
  if (pauseState === 'open') {
    if (keys['ArrowDown']) { keys['ArrowDown'] = false; pauseCursor = (pauseCursor + 1) % 6; playSFX(SFX.CURSOR); }
    if (keys['ArrowUp'])   { keys['ArrowUp'] = false;   pauseCursor = (pauseCursor + 5) % 6; playSFX(SFX.CURSOR); }
    if (keys['z'] || keys['Z']) { keys['z'] = false; keys['Z'] = false; /* placeholder — no action yet */ }
    return;
  }
  // Block all input during pause transitions
  if (pauseState !== 'none') return;

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

  // Boss fight trigger — face Adamantoise at crystal room center
  if (bossSprite && !bossDefeated && facedX === 6 && facedY === 8) {
    startBattle();
    return;
  }

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
        playerHP = playerStats.maxHP;
        playerMP = playerStats.maxMP;
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

    // Random encounter step counter (dungeon floors 0-3 only, not crystal room)
    if (dungeonFloor >= 0 && dungeonFloor < 4 && battleState === 'none') {
      encounterSteps++;
      const threshold = 15 + Math.floor(Math.random() * 15);
      if (encounterSteps >= threshold) {
        encounterSteps = 0;
        startRandomEncounter();
        return;
      }
    }

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
      topBoxScrollState = 'fade-in';
      topBoxScrollTimer = 0;
      topBoxFadeStep = TOPBOX_FADE_STEPS; // start fully faded
    }
    return;
  }

  topBoxScrollTimer += Math.min(dt, 33); // cap so generation lag doesn't skip

  if (topBoxScrollState === 'fade-in') {
    topBoxFadeStep = TOPBOX_FADE_STEPS - Math.min(Math.floor(topBoxScrollTimer / TOPBOX_FADE_STEP_MS), TOPBOX_FADE_STEPS);
    if (topBoxScrollTimer >= (TOPBOX_FADE_STEPS + 1) * TOPBOX_FADE_STEP_MS) {
      topBoxFadeStep = 0;
      if (topBoxIsTown) {
        topBoxScrollState = 'none';
      } else {
        topBoxScrollState = 'display';
        topBoxScrollTimer = 0;
      }
    }
  } else if (topBoxScrollState === 'display') {
    if (transState !== 'loading' && topBoxScrollTimer >= TOPBOX_DISPLAY_HOLD) {
      topBoxScrollState = 'fade-out';
      topBoxScrollTimer = 0;
    }
  } else if (topBoxScrollState === 'fade-out') {
    topBoxFadeStep = Math.min(Math.floor(topBoxScrollTimer / TOPBOX_FADE_STEP_MS), TOPBOX_FADE_STEPS);
    if (topBoxScrollTimer >= (TOPBOX_FADE_STEPS + 1) * TOPBOX_FADE_STEP_MS) {
      topBoxScrollState = 'none';
      topBoxFadeStep = TOPBOX_FADE_STEPS;
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
        loadingFadeState = 'in';
        loadingFadeTimer = 0;
        loadingBgScroll = 0;
        playTrack(TRACKS.PIANO_3);
        // Generate the dungeon floor during the loading screen
        if (transPendingAction) {
          transPendingAction();
          transPendingAction = null;
        }
        // Fade dungeon name in during loading screen
        if (topBoxNameBytes) {
          topBoxScrollState = 'fade-in';
          topBoxScrollTimer = 0;
          topBoxFadeStep = TOPBOX_FADE_STEPS;
        }
      } else {
        transState = 'opening';
        transTimer = 0;
        playSFX(SFX.SCREEN_OPEN);
        // Fade in area name alongside opening wipe
        if (topBoxScrollState === 'pending') {
          topBoxScrollState = 'fade-in';
          topBoxScrollTimer = 0;
          topBoxFadeStep = TOPBOX_FADE_STEPS;
        }
            }
    }
  } else if (transState === 'loading') {
    // Advance fade timer and scroll
    loadingFadeTimer += dt;
    loadingBgScroll += dt * 0.08;
    if (loadingFadeState === 'in') {
      if (loadingFadeTimer >= (LOAD_FADE_MAX + 1) * LOAD_FADE_STEP_MS) {
        loadingFadeState = 'visible';
        loadingFadeTimer = 0;
      }
    } else if (loadingFadeState === 'out') {
      if (loadingFadeTimer >= (LOAD_FADE_MAX + 1) * LOAD_FADE_STEP_MS) {
        // Fade out complete — open screen
        loadingFadeState = 'none';
        transState = 'opening';
        transTimer = 0;
        transDungeon = false;
        playSFX(SFX.SCREEN_OPEN);
        playTrack(TRACKS.CRYSTAL_CAVE);
      }
    }
    // Z press — only start fade-out when fully visible
    if (loadingFadeState === 'visible' && (keys['z'] || keys['Z'])) {
      keys['z'] = false;
      keys['Z'] = false;
      loadingFadeState = 'out';
      loadingFadeTimer = 0;
      // Fade out area name alongside loading screen
      if (topBoxScrollState !== 'none' && topBoxScrollState !== 'fade-out') {
        topBoxScrollState = 'fade-out';
        topBoxScrollTimer = 0;
        topBoxFadeStep = 0;
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

  // Loading screen — dungeon briefing with sprites + NES fade
  if (transState === 'loading') {
    // Compute current fade level (0 = full bright, LOAD_FADE_MAX = black)
    let fadeLevel = 0;
    if (loadingFadeState === 'in') {
      const step = Math.min(Math.floor(loadingFadeTimer / LOAD_FADE_STEP_MS), LOAD_FADE_MAX);
      fadeLevel = LOAD_FADE_MAX - step; // count down: black → bright
    } else if (loadingFadeState === 'out') {
      fadeLevel = Math.min(Math.floor(loadingFadeTimer / LOAD_FADE_STEP_MS), LOAD_FADE_MAX);
    } else if (loadingFadeState === 'visible') {
      fadeLevel = 0;
    } else {
      fadeLevel = LOAD_FADE_MAX; // fully black when done
    }

    // Faded text palette — apply fade steps to TEXT_WHITE ($30 → $20 → $10 → $0F)
    const fadedTextPal = TEXT_WHITE.map((c, i) => {
      if (i === 0) return c;
      let fc = c;
      for (let s = 0; s < fadeLevel; s++) fc = nesColorFade(fc);
      return fc;
    });

    // Text byte arrays
    const loadingBytes = new Uint8Array([0x95,0xD8,0xCA,0xCD,0xD2,0xD7,0xD0,0xFF,0x8D,0xDE,0xD7,0xD0,0xCE,0xD8,0xD7]); // "Loading Dungeon"
    const loadedBytes = new Uint8Array([0x8D,0xDE,0xD7,0xD0,0xCE,0xD8,0xD7,0xFF,0x95,0xD8,0xCA,0xCD,0xCE,0xCD]); // "Dungeon Loaded"
    const promptBytes = new Uint8Array([0x99,0xDB,0xCE,0xDC,0xDC,0xFF,0xA3]); // "Press Z"
    const beatBytes = new Uint8Array([0x8B,0xCE,0xCA,0xDD,0xFF,0xDD,0xD1,0xCE]); // "Beat the"
    const bossBytes = new Uint8Array([0x8B,0xD8,0xDC,0xDC,0xFF,0x94,0xDE,0xD9,0xD8,0xC4]); // "Boss Kupo!"
    const vpTop = HUD_VIEW_Y;
    const vpBot = vpTop + HUD_VIEW_H;
    const cx = HUD_VIEW_X + HUD_VIEW_W / 2;

    // Scrolling battle scene row at top of viewport
    if (loadingBgFadeFrames && loadingBgFadeFrames.length > 0) {
      const maxStep = loadingBgFadeFrames.length - 1;
      const frameIdx = Math.min(fadeLevel, maxStep);
      const bgCanvas = loadingBgFadeFrames[frameIdx];
      const scrollX = Math.floor(loadingBgScroll) % 256;
      ctx.save();
      ctx.beginPath();
      ctx.rect(HUD_VIEW_X, vpTop, HUD_VIEW_W, 32);
      ctx.clip();
      ctx.drawImage(bgCanvas, HUD_VIEW_X - scrollX, vpTop);
      ctx.drawImage(bgCanvas, HUD_VIEW_X - scrollX + 256, vpTop);
      ctx.restore();
    }

    // "Floors: 4" label centered above boss
    const floorsBytes = new Uint8Array([0x84,0xFF,0x95,0xCE,0xDF,0xCE,0xD5,0xDC]); // "4 Levels"
    const floorsW = measureText(floorsBytes);
    drawText(ctx, cx - floorsW / 2, vpTop + 48, floorsBytes, fadedTextPal);

    // Boss sprite + HP side by side, centered (below floors label)
    const hpBytes = new Uint8Array([0x91,0x99,0xFF,0xC5,0xC5,0xC5,0xC5,0xC5]); // "HP ?????"
    const hpW = measureText(hpBytes);
    const bossRowW = 16 + 4 + hpW;
    const bossRowX = cx - bossRowW / 2;
    const bossRowY = vpTop + 60;
    if (bossFadeFrames) {
      const bFrame = Math.floor(transTimer / 400) & 1;
      ctx.drawImage(bossFadeFrames[fadeLevel][bFrame], bossRowX, bossRowY);
    } else if (adamantoiseFrames) {
      ctx.drawImage(adamantoiseFrames[0], bossRowX, bossRowY);
    }
    drawText(ctx, bossRowX + 20, bossRowY + 4, hpBytes, fadedTextPal);

    // Moogle sprite on left + chat bubble to the right (below boss)
    const moogleY = vpBot - 54;
    const moogleX = cx - 52;
    const textX = moogleX + 24;
    if (moogleFadeFrames) {
      const mFrame = Math.floor(transTimer / 400) & 1;
      const mCanvas = moogleFadeFrames[fadeLevel][mFrame];
      ctx.drawImage(mCanvas, moogleX, moogleY);
    }
    // Chat bubble — white rounded box + triangle pointer toward moogle
    let fadedWhite = 0x30;
    for (let s = 0; s < fadeLevel; s++) fadedWhite = nesColorFade(fadedWhite);
    const whiteRgb = NES_SYSTEM_PALETTE[fadedWhite] || [0, 0, 0];
    ctx.fillStyle = `rgb(${whiteRgb[0]},${whiteRgb[1]},${whiteRgb[2]})`;
    const beatW = measureText(beatBytes);
    const bossW = measureText(bossBytes);
    const bgW = Math.max(beatW, bossW) + 4;
    const bubbleX = textX - 2;
    const bubbleY = moogleY - 2;
    ctx.beginPath();
    ctx.roundRect(bubbleX, bubbleY, bgW, 22, 4);
    ctx.fill();
    // Triangle pointing left toward moogle
    ctx.beginPath();
    ctx.moveTo(bubbleX, bubbleY + 8);
    ctx.lineTo(bubbleX - 5, bubbleY + 11);
    ctx.lineTo(bubbleX, bubbleY + 14);
    ctx.fill();
    const blackTextPal = [0x0F, fadedWhite, fadedWhite, 0x0F];
    drawText(ctx, textX, moogleY, beatBytes, blackTextPal);
    drawText(ctx, textX, moogleY + 10, bossBytes, blackTextPal);

    // Bottom area: "Loading Dungeon" during fade-in, "Dungeon Loaded" + "Press Z" once visible
    if (loadingFadeState === 'in') {
      const lw = measureText(loadingBytes);
      drawText(ctx, cx - lw / 2, vpBot - 32, loadingBytes, fadedTextPal);
    } else if (loadingFadeState === 'visible') {
      const dw = measureText(loadedBytes);
      drawText(ctx, cx - dw / 2, vpBot - 32, loadedBytes, fadedTextPal);
      if (Math.floor(transTimer / 500) % 2 === 0) {
        const pw = measureText(promptBytes);
        drawText(ctx, cx - pw / 2, vpBot - 20, promptBytes, fadedTextPal);
      }
    } else if (loadingFadeState === 'out') {
      const dw = measureText(loadedBytes);
      drawText(ctx, cx - dw / 2, vpBot - 32, loadedBytes, fadedTextPal);
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
      // Only fade out town name when actually leaving to world map
      const goingToWorld = mapStack.length === 0 || mapStack[mapStack.length - 1].mapId === 'world';
      if (goingToWorld && topBoxIsTown && topBoxNameBytes) {
        topBoxScrollState = 'fade-out';
        topBoxScrollTimer = 0;
        topBoxFadeStep = 0;
      }
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

  // Battle shake (enemy attack)
  if (battleShakeTimer > 0) {
    const frame = Math.floor(battleShakeTimer / (1000 / 60));
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

  // Hide all sprites/objects during transitions and battles (show during trap reveal and flash-strobe)
  if ((transState === 'none' || transState === 'trap-reveal') && (battleState === 'none' || battleState === 'flash-strobe')) {
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
    // During battle hit: blink on/off every 60ms
    if (bossSprite) {
      const blinkHidden = bossFlashTimer > 0 && (Math.floor(bossFlashTimer / 60) & 1);
      if (!blinkHidden) {
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
  // Title screen handles its own top box (sky BG)
  if (titleState !== 'done') return;

  // Base layer: battle BG or town name
  const isFading = topBoxScrollState === 'fade-in' || topBoxScrollState === 'display' || topBoxScrollState === 'fade-out';
  const showTownName = topBoxMode === 'name' && !isFading;

  if (transState === 'loading') {
    // Loading screen: black top box base, draw name if present
    ctx.fillStyle = '#000';
    ctx.fillRect(8, 8, 240, 16);
    if (topBoxNameBytes && !isFading) {
      const tw = measureText(topBoxNameBytes);
      const tx = 8 + Math.floor((240 - tw) / 2);
      const ty = 8 + Math.floor((16 - 8) / 2);
      drawText(ctx, tx, ty, topBoxNameBytes, TEXT_WHITE);
    }
  } else if (topBoxScrollState === 'pending' || topBoxScrollState === 'fade-out' || (isFading && topBoxIsTown)) {
    // Black base
    ctx.fillStyle = '#000';
    ctx.fillRect(8, 8, 240, 16);
  } else if (showTownName) {
    // Permanent town display (after fade-in completes)
    ctx.fillStyle = '#000';
    ctx.fillRect(8, 8, 240, 16);
    if (topBoxNameBytes) {
      const tw = measureText(topBoxNameBytes);
      const tx = 8 + Math.floor((240 - tw) / 2);
      const ty = 8 + Math.floor((16 - 8) / 2);
      drawText(ctx, tx, ty, topBoxNameBytes, TEXT_WHITE);
    }
  } else if (topBoxBgCanvas) {
    // Battle BG base layer
    ctx.drawImage(topBoxBgCanvas, 8, 0, 240, 16, 8, 8, 240, 16);
  }

  // Fading name text overlay — NES discrete palette steps
  if (isFading && topBoxNameBytes) {
    ctx.fillStyle = '#000';
    ctx.fillRect(8, 8, 240, 16);
    const fadedPal = [0x0F, 0x0F, 0x0F, 0x30];
    for (let s = 0; s < topBoxFadeStep; s++) {
      fadedPal[3] = nesColorFade(fadedPal[3]);
    }
    const tw = measureText(topBoxNameBytes);
    const tx = 8 + Math.floor((240 - tw) / 2);
    const ty = 8 + Math.floor((16 - 8) / 2);
    drawText(ctx, tx, ty, topBoxNameBytes, fadedPal);
  }

  // NES palette fade on battle BG during transitions
  if (!topBoxIsTown && topBoxBgFadeFrames && transState !== 'none' && transState !== 'door-opening' && transState !== 'loading') {
    const maxStep = topBoxBgFadeFrames.length - 1;
    const FADE_STEP_MS = 100;
    let fadeStep = 0;
    if (transState === 'closing') {
      fadeStep = Math.min(Math.floor(transTimer / FADE_STEP_MS), maxStep);
    } else if (transState === 'hold' || transState === 'trap-falling') {
      fadeStep = maxStep;
    } else if (transState === 'opening') {
      fadeStep = Math.max(maxStep - Math.floor(transTimer / FADE_STEP_MS), 0);
    }
    if (fadeStep > 0) {
      ctx.drawImage(topBoxBgFadeFrames[fadeStep], 8, 0, 240, 16, 8, 8, 240, 16);
    }
  }

  // HUD info fade-in (portrait + HP/MP)
  const infoFadeStep = HUD_INFO_FADE_STEPS - Math.min(Math.floor(hudInfoFadeTimer / HUD_INFO_FADE_STEP_MS), HUD_INFO_FADE_STEPS);

  // Portrait shake offset during enemy-attack
  const shakeOff = (battleState === 'enemy-attack' && battleShakeTimer > 0)
    ? (Math.floor(battleShakeTimer / 67) & 1 ? 2 : -2) : 0;

  // Portrait drawn in drawBattle() above border layer — just draw idle here during non-battle
  if (battleState === 'none' && battleSpriteCanvas) {
    if (infoFadeStep === 0) {
      ctx.drawImage(battleSpriteCanvas, HUD_RIGHT_X + 8, HUD_VIEW_Y + 8);
    } else if (infoFadeStep < HUD_INFO_FADE_STEPS) {
      ctx.globalAlpha = 1 - infoFadeStep / HUD_INFO_FADE_STEPS;
      ctx.drawImage(battleSpriteCanvas, HUD_RIGHT_X + 8, HUD_VIEW_Y + 8);
      ctx.globalAlpha = 1;
    }
  }
  // HP/MP in right mini-right panel (8 chars × 2 rows)
  const sx = HUD_RIGHT_X + 32 + 8 + shakeOff; // interior x (shakes with portrait)
  const sy = HUD_VIEW_Y + 8;       // interior y
  const infoPal = [0x0F, 0x0F, 0x0F, 0x30];
  for (let s = 0; s < infoFadeStep; s++) {
    infoPal[3] = nesColorFade(infoPal[3]);
  }
  drawText(ctx, sx, sy,     statRowBytes(0x91, 0x99, playerHP), infoPal); // HP
  drawText(ctx, sx, sy + 8, statRowBytes(0x96, 0x99, playerMP), infoPal); // MP
}

// ── Title Screen ──

// Credit text: "A fan game" / "made by" / "JoeltCo"
const TITLE_CREDIT_1 = new Uint8Array([0x8A,0xFF,0xCF,0xCA,0xD7,0xFF,0xD0,0xCA,0xD6,0xCE]);
const TITLE_CREDIT_2 = new Uint8Array([0xD6,0xCA,0xCD,0xCE,0xFF,0xCB,0xE2]);
const TITLE_CREDIT_3 = new Uint8Array([0x93,0xD8,0xCE,0xD5,0xDD,0x8C,0xD8]);

// Disclaimer: "All characters" / "and music are" / "property of" / "SQUARE ENIX" / "No affiliation"
const TITLE_DISCLAIM_1 = new Uint8Array([0x8A,0xD5,0xD5,0xFF,0xCC,0xD1,0xCA,0xDB,0xCA,0xCC,0xDD,0xCE,0xDB,0xDC]);
const TITLE_DISCLAIM_2 = new Uint8Array([0xCA,0xD7,0xCD,0xFF,0xD6,0xDE,0xDC,0xD2,0xCC,0xFF,0xCA,0xDB,0xCE]);
const TITLE_DISCLAIM_3 = new Uint8Array([0xD9,0xDB,0xD8,0xD9,0xCE,0xDB,0xDD,0xE2,0xFF,0xD8,0xCF]);
const TITLE_DISCLAIM_4 = new Uint8Array([0x9C,0x9A,0x9E,0x8A,0x9B,0x8E,0xFF,0x8E,0x97,0x92,0xA1]);
const TITLE_DISCLAIM_5 = new Uint8Array([0x97,0xD8,0xFF,0xCA,0xCF,0xCF,0xD2,0xD5,0xD2,0xCA,0xDD,0xD2,0xD8,0xD7]);

const TITLE_PRESS_Z = new Uint8Array([0x99,0xDB,0xCE,0xDC,0xDC,0xFF,0xA3]); // "Press Z"

// Player select text
const SELECT_TITLE_1 = new Uint8Array([0x9C,0xCE,0xD5,0xCE,0xCC,0xDD]); // "Select"
const SELECT_TITLE_2 = new Uint8Array([0x99,0xD5,0xCA,0xE2,0xCE,0xDB]); // "Player"
const SELECT_SLOT_TEXT = new Uint8Array([0x97,0xCE,0xE0,0xFF,0x90,0xCA,0xD6,0xCE]); // "New Game"
const SELECT_DELETE_TEXT = new Uint8Array([0x8D,0xCE,0xD5,0xCE,0xDD,0xCE]); // "Delete"
let deleteMode = false;

// Title box: "Final Fantasy" / "III MMORPG"
const TITLE_NAME_1 = new Uint8Array([0x8F,0xD2,0xD7,0xCA,0xD5,0xFF,0x8F,0xCA,0xD7,0xDD,0xCA,0xDC,0xE2]); // "Final Fantasy"
const TITLE_NAME_2 = new Uint8Array([0x92,0x92,0x92,0xFF,0x96,0x96,0x98,0x9B,0x99,0x90]); // "III MMORPG"

function titleFadeLevel(state, timer) {
  if (state.endsWith('-in')) {
    const step = Math.min(Math.floor(timer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
    return TITLE_FADE_MAX - step;
  } else if (state.endsWith('-out')) {
    return Math.min(Math.floor(timer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
  } else if (state.endsWith('-hold')) {
    return 0;
  }
  return TITLE_FADE_MAX; // black
}

function titleFadePal(fadeLevel) {
  return TEXT_WHITE.map((c, i) => {
    if (i === 0) return c;
    let fc = c;
    for (let s = 0; s < fadeLevel; s++) fc = nesColorFade(fc);
    return fc;
  });
}

function updateTitle(dt) {
  titleTimer += dt;

  // Tick water animation during water-visible states
  if (titleState === 'main-in' || titleState === 'zbox-open' || titleState === 'main' || titleState === 'zbox-close' ||
      titleState === 'select-fade-in' || titleState === 'select' || titleState === 'select-fade-out' || titleState === 'select-fade-out-back' ||
      titleState === 'name-entry' || titleState === 'main-out') {
    waterTimer += dt;
    if (waterTimer >= WATER_TICK) {
      waterTimer %= WATER_TICK;
      waterTick++;
    }
    titleWaterScroll += dt * 0.12; // ~120px/s leftward scroll
    titleSkyScroll += dt * 0.08;   // ~80px/s leftward scroll
    titleShipTimer += dt;
  }

  switch (titleState) {
    case 'credit-wait':
      if (titleTimer >= TITLE_WAIT_MS) { titleState = 'credit-in'; titleTimer = 0; }
      break;
    case 'credit-in':
      if (titleTimer >= TITLE_FADE_MS) { titleState = 'credit-hold'; titleTimer = 0; }
      break;
    case 'credit-hold':
      if (titleTimer >= TITLE_HOLD_MS) { titleState = 'credit-out'; titleTimer = 0; }
      break;
    case 'credit-out':
      if (titleTimer >= TITLE_FADE_MS) { titleState = 'disclaim-wait'; titleTimer = 0; }
      break;
    case 'disclaim-wait':
      if (titleTimer >= TITLE_WAIT_MS) { titleState = 'disclaim-in'; titleTimer = 0; }
      break;
    case 'disclaim-in':
      if (titleTimer >= TITLE_FADE_MS) { titleState = 'disclaim-hold'; titleTimer = 0; }
      break;
    case 'disclaim-hold':
      if (titleTimer >= TITLE_HOLD_MS) { titleState = 'disclaim-out'; titleTimer = 0; }
      break;
    case 'disclaim-out':
      if (titleTimer >= TITLE_FADE_MS) { titleState = 'main-in'; titleTimer = 0; }
      break;
    case 'main-in':
      if (titleTimer >= TITLE_FADE_MS) { titleState = 'zbox-open'; titleTimer = 0; }
      break;
    case 'zbox-open':
      if (titleTimer >= TITLE_ZBOX_MS) { titleState = 'main'; titleTimer = 0; }
      break;
    case 'main':
      if (keys['z'] || keys['Z']) {
        keys['z'] = false;
        keys['Z'] = false;
        playSFX(SFX.CONFIRM);
        titleState = 'zbox-close';
        titleTimer = 0;
      }
      break;
    case 'zbox-close':
      if (titleTimer >= TITLE_ZBOX_MS) { titleState = 'select-fade-in'; titleTimer = 0; selectCursor = 0; deleteMode = false; }
      break;
    case 'select-fade-in':
      if (titleTimer >= (SELECT_TEXT_STEPS + 1) * SELECT_TEXT_STEP_MS) { titleState = 'select'; titleTimer = 0; }
      break;
    case 'select':
      if (keys['z'] || keys['Z']) {
        keys['z'] = false; keys['Z'] = false;
        if (deleteMode) {
          if (selectCursor < 3 && saveSlots[selectCursor]) {
            // Delete the selected save
            playSFX(SFX.CONFIRM);
            saveSlots[selectCursor] = null;
            saveSlotsToDB();
            deleteMode = false;
          }
        } else if (selectCursor === 3) {
          // Activate delete mode
          playSFX(SFX.CONFIRM);
          deleteMode = true;
          selectCursor = 0;
        } else if (saveSlots[selectCursor]) {
          // Named slot — start game
          playSFX(SFX.CONFIRM);
          titleState = 'select-fade-out'; titleTimer = 0;
        } else {
          // New Game — enter name inline
          playSFX(SFX.CONFIRM);
          nameBuffer = [];
          titleState = 'name-entry'; titleTimer = 0;
        }
      }
      if (deleteMode) {
        if (keys['ArrowDown']) { keys['ArrowDown'] = false; selectCursor = (selectCursor + 1) % 3; playSFX(SFX.CURSOR); }
        if (keys['ArrowUp'])   { keys['ArrowUp'] = false;   selectCursor = (selectCursor + 2) % 3; playSFX(SFX.CURSOR); }
      } else {
        if (keys['ArrowDown']) { keys['ArrowDown'] = false; selectCursor = (selectCursor + 1) % 4; playSFX(SFX.CURSOR); }
        if (keys['ArrowUp'])   { keys['ArrowUp'] = false;   selectCursor = (selectCursor + 3) % 4; playSFX(SFX.CURSOR); }
      }
      if (keys['x'] || keys['X']) {
        keys['x'] = false; keys['X'] = false;
        if (deleteMode) {
          playSFX(SFX.CONFIRM);
          deleteMode = false;
        } else {
          playSFX(SFX.CONFIRM);
          titleState = 'select-fade-out-back'; titleTimer = 0;
        }
      }
      break;
    case 'name-entry':
      // Input handled in keydown listener — just tick timer for cursor blink
      break;
    case 'select-fade-out':
      if (titleTimer >= (SELECT_TEXT_STEPS + 1) * SELECT_TEXT_STEP_MS) { titleState = 'main-out'; titleTimer = 0; }
      break;
    case 'select-fade-out-back':
      if (titleTimer >= (SELECT_TEXT_STEPS + 1) * SELECT_TEXT_STEP_MS) { titleState = 'zbox-open'; titleTimer = 0; }
      break;
    case 'main-out':
      if (titleTimer >= TITLE_FADE_MS) {
        titleState = 'done';
        hudInfoFadeTimer = 0;
        // Restore saved stats if available
        const slot = saveSlots[selectCursor];
        if (slot && slot.stats) {
          playerStats.str = slot.stats.str;
          playerStats.agi = slot.stats.agi;
          playerStats.vit = slot.stats.vit;
          playerStats.int = slot.stats.int;
          playerStats.mnd = slot.stats.mnd;
          playerStats.maxHP = slot.stats.maxHP;
          playerStats.maxMP = slot.stats.maxMP;
          playerStats.level = slot.level;
          playerStats.exp = slot.exp;
          playerStats.expToNext = (slot.level - 1 < 98) ? expTable[slot.level - 1] : 0xFFFFFF;
          playerStats.hp = playerStats.maxHP;
          playerStats.mp = playerStats.maxMP;
          playerHP = playerStats.maxHP;
          playerMP = playerStats.maxMP;
          playerATK = playerStats.str;
          playerDEF = playerStats.vit;
        }
        loadMapById(114);
        playTrack(TRACKS.TOWN_UR);
        // Opening wipe reveals the town
        playSFX(SFX.SCREEN_OPEN);
        transState = 'opening';
        transTimer = 0;
      }
      break;
  }
}

let _titleCascadeCanvas = null; // reusable 16×16 scratch for per-row cascade

function drawTitleWater(fadeLevel) {
  if (!titleWaterFrames) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);
  ctx.clip();

  const scrollX = Math.floor(titleWaterScroll) % 16;

  if (fadeLevel > 0 && titleWaterFadeTiles) {
    // Fading — use static tile at this fade level
    const tile = titleWaterFadeTiles[Math.min(fadeLevel, titleWaterFadeTiles.length - 1)];
    for (let y = HUD_VIEW_Y; y < HUD_VIEW_Y + HUD_VIEW_H; y += 16) {
      for (let x = HUD_VIEW_X - scrollX; x < HUD_VIEW_X + HUD_VIEW_W + 16; x += 16) {
        ctx.drawImage(tile, x, y);
      }
    }
  } else {
    // Full brightness — per-row cascade (NES tick effect)
    const hShift = Math.floor(waterTick / 8) % 16;
    const hPrev = (hShift + 15) % 16;
    const subRow = waterTick % 8; // rows 0..subRow use current shift
    const curTile = titleWaterFrames[hShift];
    const prevTile = titleWaterFrames[hPrev];

    // Build cascade tile: prev shift as base, current shift for updated rows
    if (!_titleCascadeCanvas) {
      _titleCascadeCanvas = document.createElement('canvas');
      _titleCascadeCanvas.width = 16;
      _titleCascadeCanvas.height = 16;
    }
    const cctx = _titleCascadeCanvas.getContext('2d');
    cctx.drawImage(prevTile, 0, 0);
    // Overdraw current shift for rows 0..subRow in each 8×8 half
    const h = subRow + 1;
    cctx.drawImage(curTile, 0, 0, 16, h, 0, 0, 16, h);  // top 8×8 half
    cctx.drawImage(curTile, 0, 8, 16, h, 0, 8, 16, h);  // bottom 8×8 half

    for (let y = HUD_VIEW_Y; y < HUD_VIEW_Y + HUD_VIEW_H; y += 16) {
      for (let x = HUD_VIEW_X - scrollX; x < HUD_VIEW_X + HUD_VIEW_W + 16; x += 16) {
        ctx.drawImage(_titleCascadeCanvas, x, y);
      }
    }
  }
  ctx.restore();
}

function drawTitleSky(fadeLevel) {
  if (!titleSkyFrames || titleSkyFrames.length === 0) return;

  // Pick fade frame: 0=bright, last=black
  const maxStep = titleSkyFrames.length - 1;
  const frameIdx = Math.min(fadeLevel, maxStep);
  const skyCanvas = titleSkyFrames[frameIdx];

  // Scroll left, wrapping at 256px
  const scrollX = Math.floor(titleSkyScroll) % 256;

  ctx.save();
  ctx.beginPath();
  ctx.rect(8, 8, 240, 16); // top box interior
  ctx.clip();
  ctx.drawImage(skyCanvas, 8 - scrollX, 8);
  ctx.drawImage(skyCanvas, 8 - scrollX + 256, 8);
  ctx.restore();
}

function drawTitleSkyInHUD() {
  if (titleState === 'main-in') {
    const fl = TITLE_FADE_MAX - Math.min(Math.floor(titleTimer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
    drawTitleSky(fl);
  } else if (titleState === 'zbox-open' || titleState === 'main' || titleState === 'zbox-close' ||
             titleState === 'select-fade-in' || titleState === 'select' || titleState === 'select-fade-out' || titleState === 'select-fade-out-back' ||
             titleState === 'name-entry') {
    drawTitleSky(0);
  } else if (titleState === 'main-out') {
    const fl = Math.min(Math.floor(titleTimer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
    drawTitleSky(fl);
  }
}

function drawTitle() {
  // Black fill inside viewport + top box interior
  ctx.fillStyle = '#000';
  ctx.fillRect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);
  ctx.fillRect(8, 8, 240, 16); // top box interior

  const cx = HUD_VIEW_X + HUD_VIEW_W / 2;
  const cy = HUD_VIEW_Y + HUD_VIEW_H / 2;
  const vpBot = HUD_VIEW_Y + HUD_VIEW_H;

  if (titleState === 'credit-in' || titleState === 'credit-hold' || titleState === 'credit-out') {
    // Skip credit-wait (black screen, no text)
    const fl = titleFadeLevel(titleState, titleTimer);
    const pal = titleFadePal(fl);
    const w1 = measureText(TITLE_CREDIT_1);
    const w2 = measureText(TITLE_CREDIT_2);
    const w3 = measureText(TITLE_CREDIT_3);
    drawText(ctx, cx - w1 / 2, cy - 16, TITLE_CREDIT_1, pal);
    drawText(ctx, cx - w2 / 2, cy - 4, TITLE_CREDIT_2, pal);
    drawText(ctx, cx - w3 / 2, cy + 8, TITLE_CREDIT_3, pal);
  } else if (titleState === 'disclaim-in' || titleState === 'disclaim-hold' || titleState === 'disclaim-out') {
    const fl = titleFadeLevel(titleState, titleTimer);
    const pal = titleFadePal(fl);
    const w1 = measureText(TITLE_DISCLAIM_1);
    const w2 = measureText(TITLE_DISCLAIM_2);
    const w3 = measureText(TITLE_DISCLAIM_3);
    const w4 = measureText(TITLE_DISCLAIM_4);
    const w5 = measureText(TITLE_DISCLAIM_5);
    drawText(ctx, cx - w1 / 2, cy - 24, TITLE_DISCLAIM_1, pal);
    drawText(ctx, cx - w2 / 2, cy - 14, TITLE_DISCLAIM_2, pal);
    drawText(ctx, cx - w3 / 2, cy - 4, TITLE_DISCLAIM_3, pal);
    drawText(ctx, cx - w4 / 2, cy + 10, TITLE_DISCLAIM_4, pal);
    drawText(ctx, cx - w5 / 2, cy + 24, TITLE_DISCLAIM_5, pal);
  } else if (titleState === 'main-in' || titleState === 'zbox-open' || titleState === 'main' || titleState === 'zbox-close' ||
             titleState === 'select-fade-in' || titleState === 'select' || titleState === 'select-fade-out' || titleState === 'select-fade-out-back' ||
             titleState === 'name-entry' || titleState === 'main-out') {
    let fl;
    if (titleState === 'main-in') {
      fl = TITLE_FADE_MAX - Math.min(Math.floor(titleTimer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
    } else if (titleState === 'main-out') {
      fl = Math.min(Math.floor(titleTimer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
    } else {
      fl = 0;
    }
    drawTitleWater(fl);

    // Title name box — above the ship
    if (fl < TITLE_FADE_MAX) {
      const tw1 = measureText(TITLE_NAME_1);
      const tw2 = measureText(TITLE_NAME_2);
      const tboxW = Math.max(tw1, tw2) + 16; // 8px border each side
      const tboxH = 32; // 8 border + 8 line1 + 8 line2 + 8 border
      const tboxX = cx - tboxW / 2;
      const tboxY = HUD_VIEW_Y + 12; // near top of viewport
      const clampedFl = Math.min(fl, LOAD_FADE_MAX);
      const tBorderSet = (borderFadeSets && fl > 0)
        ? borderFadeSets[clampedFl] : borderTileCanvases;
      if (tBorderSet) {
        const [TL, TOP, TR, LEFT, RIGHT, BL, BOT, BR, FILL] = tBorderSet;
        ctx.drawImage(TL, tboxX, tboxY);
        ctx.drawImage(TR, tboxX + tboxW - 8, tboxY);
        ctx.drawImage(BL, tboxX, tboxY + tboxH - 8);
        ctx.drawImage(BR, tboxX + tboxW - 8, tboxY + tboxH - 8);
        for (let tx = tboxX + 8; tx < tboxX + tboxW - 8; tx += 8) {
          ctx.drawImage(TOP, tx, tboxY);
          ctx.drawImage(BOT, tx, tboxY + tboxH - 8);
        }
        for (let ty = tboxY + 8; ty < tboxY + tboxH - 8; ty += 8) {
          ctx.drawImage(LEFT, tboxX, ty);
          ctx.drawImage(RIGHT, tboxX + tboxW - 8, ty);
        }
        for (let ty = tboxY + 8; ty < tboxY + tboxH - 8; ty += 8) {
          for (let tx = tboxX + 8; tx < tboxX + tboxW - 8; tx += 8) {
            ctx.drawImage(FILL, tx, ty);
          }
        }
      }
      const tpal = fl === 0 ? TEXT_WHITE : titleFadePal(fl);
      drawText(ctx, cx - tw1 / 2, tboxY + 8, TITLE_NAME_1, tpal);
      drawText(ctx, cx - tw2 / 2, tboxY + 16, TITLE_NAME_2, tpal);
    }

    // Invincible airship sprite — centered in viewport
    if (invincibleFadeFrames && fl < TITLE_FADE_MAX) {
      const frameIdx = Math.floor(titleShipTimer / TITLE_SHIP_ANIM_MS) % 2;
      const shipCanvas = invincibleFadeFrames[fl][frameIdx];
      const shipX = cx - 16;  // center 32px sprite in 144px viewport
      const bob = Math.sin(titleShipTimer / 2000 * Math.PI * 2) * 4; // 4px bob, ~2s cycle
      const shipY = Math.round(cy - 20 + bob); // +4px down
      // Shadow stays fixed, ship bobs above it
      const shadowY = cy - 20 + 32; // fixed base, +4px down
      if (invincibleShadowFade && Math.floor(titleShipTimer / TITLE_SHADOW_ANIM_MS) % 2 === 0) {
        ctx.drawImage(invincibleShadowFade[fl], shipX, shadowY);
      }
      ctx.drawImage(shipCanvas, shipX, shipY);
    }

    // Press Z box — opens after fade-in, closes on Z press
    if (titleState === 'zbox-open' || titleState === 'main' || titleState === 'zbox-close') {
      const pw = measureText(TITLE_PRESS_Z);
      const fullW = pw + 16; // 8px border each side
      const fullH = 24;      // 8 border + 8 text + 8 border
      const boxCY = vpBot - 44 + fullH / 2; // center Y of box

      // Animate: expand from horizontal line (open) or shrink to line (close)
      let t = 1; // 0=closed, 1=fully open
      if (titleState === 'zbox-open') {
        t = Math.min(titleTimer / TITLE_ZBOX_MS, 1);
      } else if (titleState === 'zbox-close') {
        t = 1 - Math.min(titleTimer / TITLE_ZBOX_MS, 1);
      }

      const boxW = fullW; // width stays full
      const boxH = Math.max(8, Math.round(fullH * t)); // min 8px (one tile row)
      const boxX = cx - boxW / 2;
      const boxY = Math.round(boxCY - boxH / 2);

      const borderSet = borderTileCanvases;
      if (borderSet) {
        const [TL, TOP, TR, LEFT, RIGHT, BL, BOT, BR, FILL] = borderSet;
        ctx.drawImage(TL, boxX, boxY);
        ctx.drawImage(TR, boxX + boxW - 8, boxY);
        ctx.drawImage(BL, boxX, boxY + boxH - 8);
        ctx.drawImage(BR, boxX + boxW - 8, boxY + boxH - 8);
        for (let tx = boxX + 8; tx < boxX + boxW - 8; tx += 8) {
          ctx.drawImage(TOP, tx, boxY);
          ctx.drawImage(BOT, tx, boxY + boxH - 8);
        }
        for (let ty = boxY + 8; ty < boxY + boxH - 8; ty += 8) {
          ctx.drawImage(LEFT, boxX, ty);
          ctx.drawImage(RIGHT, boxX + boxW - 8, ty);
        }
        for (let ty = boxY + 8; ty < boxY + boxH - 8; ty += 8) {
          for (let tx = boxX + 8; tx < boxX + boxW - 8; tx += 8) {
            ctx.drawImage(FILL, tx, ty);
          }
        }
      }

      // Text only when fully open
      if (t >= 1) {
        const pal = TEXT_WHITE;
        if (Math.floor(titleTimer / 500) % 2 === 0) {
          drawText(ctx, boxX + 8, boxY + 8, TITLE_PRESS_Z, pal);
        }
      }
    }
  }
}

// --- Player select screen ---

function drawPlayerSelect() {
  const isSelect = titleState === 'select-fade-in' || titleState === 'select' ||
                   titleState === 'select-fade-out' || titleState === 'select-fade-out-back' ||
                   titleState === 'name-entry';
  if (!isSelect) return;

  // Compute NES fade step (0=full bright, 4=fully black)
  let fadeStep = 0;
  if (titleState === 'select-fade-in') {
    fadeStep = SELECT_TEXT_STEPS - Math.min(Math.floor(titleTimer / SELECT_TEXT_STEP_MS), SELECT_TEXT_STEPS);
  } else if (titleState === 'select-fade-out' || titleState === 'select-fade-out-back') {
    fadeStep = Math.min(Math.floor(titleTimer / SELECT_TEXT_STEP_MS), SELECT_TEXT_STEPS);
  }

  // Build faded palette
  const fadedPal = [0x0F, 0x0F, 0x0F, 0x30];
  for (let s = 0; s < fadeStep; s++) {
    fadedPal[3] = nesColorFade(fadedPal[3]);
  }

  // Right main box interior: x=152, y=72, w=96, h=96
  const ix = HUD_RIGHT_X + 8;
  const iy = HUD_VIEW_Y + 32 + 8;
  const iw = 96;

  // "Select" / "Player" header — centered
  const w1 = measureText(SELECT_TITLE_1);
  const w2 = measureText(SELECT_TITLE_2);
  drawText(ctx, ix + Math.floor((iw - w1) / 2), iy, SELECT_TITLE_1, fadedPal);
  drawText(ctx, ix + Math.floor((iw - w2) / 2), iy + 10, SELECT_TITLE_2, fadedPal);

  // 3 save slots — cursor + portrait + text
  const slotStartY = iy + 28;
  const slotSpacing = 20;
  for (let i = 0; i < 3; i++) {
    const sy = slotStartY + i * slotSpacing;

    // Hand cursor — floats over left border to give text room
    const curX = HUD_RIGHT_X - 4;  // overlap border by 12px
    if (i === selectCursor && cursorTileCanvas) {
      if (fadeStep === 0) {
        ctx.drawImage(cursorTileCanvas, curX, sy - 4);
      } else if (fadeStep < SELECT_TEXT_STEPS) {
        ctx.globalAlpha = 1 - fadeStep / SELECT_TEXT_STEPS;
        ctx.drawImage(cursorTileCanvas, curX, sy - 4);
        ctx.globalAlpha = 1;
      }
    }

    const rowShift = (i === selectCursor) ? 0 : -4;
    const isNameEntry = titleState === 'name-entry' && i === selectCursor;

    // Portrait — colored for named slots, silhouette for empty, hidden during name entry
    if (isNameEntry) {
      // No portrait during name entry — keep silhouette
      if (silhouetteCanvas) ctx.drawImage(silhouetteCanvas, ix + 8 + rowShift, sy - 4);
    } else if (saveSlots[i] && battleSpriteCanvas) {
      // Named slot — colored Onion Knight portrait
      if (fadeStep === 0) {
        ctx.drawImage(battleSpriteCanvas, ix + 8 + rowShift, sy - 4, 16, 16);
      } else if (fadeStep < SELECT_TEXT_STEPS) {
        ctx.globalAlpha = 1 - fadeStep / SELECT_TEXT_STEPS;
        ctx.drawImage(battleSpriteCanvas, ix + 8 + rowShift, sy - 4, 16, 16);
        ctx.globalAlpha = 1;
      }
    } else if (silhouetteCanvas) {
      if (fadeStep === 0) {
        ctx.drawImage(silhouetteCanvas, ix + 8 + rowShift, sy - 4);
      } else if (fadeStep < SELECT_TEXT_STEPS) {
        ctx.globalAlpha = 1 - fadeStep / SELECT_TEXT_STEPS;
        ctx.drawImage(silhouetteCanvas, ix + 8 + rowShift, sy - 4);
        ctx.globalAlpha = 1;
      }
    }

    // Slot text
    const textX = ix + 28 + rowShift;
    if (isNameEntry) {
      // Draw typed name bytes + blinking underscore
      if (nameBuffer.length > 0) {
        drawText(ctx, textX, sy, new Uint8Array(nameBuffer), fadedPal);
      }
      // Blinking underscore, or blinking period at max length
      if (nameBuffer.length >= NAME_MAX_LEN && Math.floor(titleTimer / 400) % 2 === 0) {
        ctx.fillStyle = '#fcfcfc';
        ctx.fillRect(textX + nameBuffer.length * 8 + 2, sy + 7, 2, 2);
      } else if (nameBuffer.length < NAME_MAX_LEN && Math.floor(titleTimer / 400) % 2 === 0) {
        ctx.fillStyle = '#fcfcfc';
        ctx.fillRect(textX + nameBuffer.length * 8 + 1, sy + 7, 6, 1);
      }
    } else if (saveSlots[i]) {
      // Named slot — draw saved name
      drawText(ctx, textX, sy, saveSlots[i].name, fadedPal);
    } else {
      drawText(ctx, textX, sy, SELECT_SLOT_TEXT, fadedPal);
    }
  }

  // "Delete" option below the 3 slots
  const delY = slotStartY + 3 * slotSpacing;
  const delPal = deleteMode
    ? [0x0F, 0x0F, 0x0F, 0x16] // red when active
    : [0x0F, 0x0F, 0x0F, fadedPal[3]];
  if (!deleteMode && selectCursor === 3 && cursorTileCanvas) {
    if (fadeStep === 0) {
      ctx.drawImage(cursorTileCanvas, HUD_RIGHT_X - 4, delY - 4);
    } else if (fadeStep < SELECT_TEXT_STEPS) {
      ctx.globalAlpha = 1 - fadeStep / SELECT_TEXT_STEPS;
      ctx.drawImage(cursorTileCanvas, HUD_RIGHT_X - 4, delY - 4);
      ctx.globalAlpha = 1;
    }
  }
  drawText(ctx, ix + 28, delY, SELECT_DELETE_TEXT, delPal);

  // Portrait in mini-left panel — colored for named slot, silhouette for empty/delete
  const slotData = selectCursor < 3 ? saveSlots[selectCursor] : null;
  const portraitCanvas = slotData ? battleSpriteCanvas : silhouetteCanvas;
  if (portraitCanvas) {
    if (fadeStep === 0) {
      ctx.drawImage(portraitCanvas, HUD_RIGHT_X + 8, HUD_VIEW_Y + 8);
    } else if (fadeStep < SELECT_TEXT_STEPS) {
      ctx.globalAlpha = 1 - fadeStep / SELECT_TEXT_STEPS;
      ctx.drawImage(portraitCanvas, HUD_RIGHT_X + 8, HUD_VIEW_Y + 8);
      ctx.globalAlpha = 1;
    }
  }

  // Mini-right panel — show slot name, "New Game", or "Delete"
  const hpX = HUD_RIGHT_X + 32 + 8;
  const hpY = HUD_VIEW_Y + 12;
  if (selectCursor === 3) {
    drawText(ctx, hpX, hpY, SELECT_DELETE_TEXT, deleteMode ? delPal : fadedPal);
  } else if (slotData) {
    drawText(ctx, hpX, hpY, slotData.name, fadedPal);
  } else {
    drawText(ctx, hpX, hpY, SELECT_SLOT_TEXT, fadedPal);
  }
}

// --- Pause menu ---

function updatePauseMenu(dt) {
  if (pauseState === 'none') return;
  pauseTimer += Math.min(dt, 33);

  if (pauseState === 'scroll-in') {
    if (pauseTimer >= PAUSE_SCROLL_MS) { pauseState = 'text-in'; pauseTimer = 0; }
  } else if (pauseState === 'text-in') {
    if (pauseTimer >= (PAUSE_TEXT_STEPS + 1) * PAUSE_TEXT_STEP_MS) { pauseState = 'open'; pauseTimer = 0; }
  } else if (pauseState === 'text-out') {
    if (pauseTimer >= (PAUSE_TEXT_STEPS + 1) * PAUSE_TEXT_STEP_MS) { pauseState = 'scroll-out'; pauseTimer = 0; }
  } else if (pauseState === 'scroll-out') {
    if (pauseTimer >= PAUSE_SCROLL_MS) { pauseState = 'none'; pauseTimer = 0; }
  }
}

function _drawMonsterDeath(x, y, size, progress) {
  // Dithered diagonal dissolve — pre-rendered frames with Bayer 4×4 dither pattern.
  // Top-right deteriorates first, sweeping diagonally to bottom-left.
  if (!goblinDeathFrames || !goblinDeathFrames.length) return;
  const frameIdx = Math.min(goblinDeathFrames.length - 1,
                            Math.floor(progress * goblinDeathFrames.length));
  ctx.drawImage(goblinDeathFrames[frameIdx], x, y);
}

function _drawBorderedBox(x, y, w, h, blue = false) {
  if (!borderTileCanvases) return;
  const tileSet = blue ? borderBlueTileCanvases : borderTileCanvases;
  const [TL, TOP, TR, LEFT, RIGHT, BL, BOT, BR, FILL] = tileSet;
  // Interior fill
  if (blue) {
    const nb = NES_SYSTEM_PALETTE[0x02];
    ctx.fillStyle = `rgb(${nb[0]},${nb[1]},${nb[2]})`;
    ctx.fillRect(x + 8, y + 8, w - 16, h - 16);
  } else {
    for (let ty = y + 8; ty < y + h - 8; ty += 8) {
      for (let tx = x + 8; tx < x + w - 8; tx += 8) {
        ctx.drawImage(FILL, tx, ty);
      }
    }
  }
  // Corners
  ctx.drawImage(TL, x, y);
  ctx.drawImage(TR, x + w - 8, y);
  ctx.drawImage(BL, x, y + h - 8);
  ctx.drawImage(BR, x + w - 8, y + h - 8);
  // Top/bottom edges
  for (let tx = x + 8; tx < x + w - 8; tx += 8) {
    ctx.drawImage(TOP, tx, y);
    ctx.drawImage(BOT, tx, y + h - 8);
  }
  // Left/right edges
  for (let ty = y + 8; ty < y + h - 8; ty += 8) {
    ctx.drawImage(LEFT, x, ty);
    ctx.drawImage(RIGHT, x + w - 8, ty);
  }
}

function drawPauseMenu() {
  if (pauseState === 'none') return;

  // Panel position: left side of viewport
  const px = HUD_VIEW_X;
  const finalY = HUD_VIEW_Y;
  const pw = PAUSE_MENU_W;
  const ph = PAUSE_MENU_H;

  // Scroll position
  let panelY = finalY;
  if (pauseState === 'scroll-in') {
    const t = Math.min(pauseTimer / PAUSE_SCROLL_MS, 1);
    panelY = finalY - ph + t * ph;
  } else if (pauseState === 'scroll-out') {
    const t = Math.min(pauseTimer / PAUSE_SCROLL_MS, 1);
    panelY = finalY - t * ph;
  }

  // Clip to viewport so panel hides behind top border
  ctx.save();
  ctx.beginPath();
  ctx.rect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);
  ctx.clip();

  // Draw bordered panel with black interior
  _drawBorderedBox(px, panelY, pw, ph);

  // Text + cursor only during text-in, open, text-out
  if (pauseState === 'text-in' || pauseState === 'open' || pauseState === 'text-out') {
    // NES discrete palette fade: compute fade step (0=full bright, 3=fully black)
    let fadeStep = 0;
    if (pauseState === 'text-in') {
      fadeStep = PAUSE_TEXT_STEPS - Math.min(Math.floor(pauseTimer / PAUSE_TEXT_STEP_MS), PAUSE_TEXT_STEPS);
    } else if (pauseState === 'text-out') {
      fadeStep = Math.min(Math.floor(pauseTimer / PAUSE_TEXT_STEP_MS), PAUSE_TEXT_STEPS);
    }

    // Build faded TEXT_WHITE palette: step each color toward $0F
    const fadedPal = [0x0F, 0x0F, 0x0F, 0x30];
    for (let s = 0; s < fadeStep; s++) {
      fadedPal[3] = nesColorFade(fadedPal[3]);
    }

    // Menu items inside panel border — 16px vertical spacing
    const textX = px + 24;
    const startY = panelY + 12;
    for (let i = 0; i < PAUSE_ITEMS.length; i++) {
      drawText(ctx, textX, startY + i * 16, PAUSE_ITEMS[i], fadedPal);
    }

    // Hand cursor from ROM — fade with same discrete steps
    if (cursorTileCanvas) {
      if (fadeStep === 0) {
        ctx.drawImage(cursorTileCanvas, px + 8, startY + pauseCursor * 16 - 4);
      } else if (fadeStep < PAUSE_TEXT_STEPS) {
        ctx.globalAlpha = 1 - fadeStep / PAUSE_TEXT_STEPS;
        ctx.drawImage(cursorTileCanvas, px + 8, startY + pauseCursor * 16 - 4);
        ctx.globalAlpha = 1;
      }
    }
  }

  ctx.restore();
}

// --- Slash Sprites (procedural) ---

function initSlashSprites() {
  // Unarmed punch hit effect — actual PPU tile bytes dumped from FCEUX
  // 2×2 metasprite (16×16), tiles $4A-$4D from pattern table $1000
  // Both hands use identical impact sprite (only fist tile differs)
  // Sprite palette 3: $0F/$16/$27/$30
  const TILE_DATA = [
    [0x01,0x09,0x4E,0x3C,0x18,0xF8,0x30,0x10, 0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00], // $4A TL
    [0x00,0x20,0xE8,0x30,0x10,0x0C,0x08,0x00, 0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00], // $4B TR
    [0x10,0x30,0xF8,0x18,0x3C,0x4E,0x09,0x01, 0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00], // $4C BL
    [0x00,0x08,0x0C,0x10,0x30,0xE8,0x20,0x00, 0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00], // $4D BR
  ];
  const HIT_PAL = [0x0F, 0x16, 0x27, 0x30]; // actual battle sprite palette 3

  const c = document.createElement('canvas');
  c.width = 16; c.height = 16;
  const sctx = c.getContext('2d');
  const imgData = sctx.createImageData(16, 16);
  const layout = [[0,0],[8,0],[0,8],[8,8]]; // TL TR BL BR
  for (let t = 0; t < 4; t++) {
    const [ox, oy] = layout[t];
    const d = TILE_DATA[t];
    for (let row = 0; row < 8; row++) {
      const lo = d[row], hi = d[row + 8];
      for (let bit = 7; bit >= 0; bit--) {
        const val = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
        if (val === 0) continue;
        const rgb = NES_SYSTEM_PALETTE[HIT_PAL[val]] || [252, 252, 252];
        const px = ox + (7 - bit);
        const py = oy + row;
        const di = (py * 16 + px) * 4;
        imgData.data[di]     = rgb[0];
        imgData.data[di + 1] = rgb[1];
        imgData.data[di + 2] = rgb[2];
        imgData.data[di + 3] = 255;
      }
    }
  }
  sctx.putImageData(imgData, 0, 0);

  // Both hands use same impact sprite; animation is positional scatter only
  slashFramesR = [c, c, c];
  slashFramesL = [c, c, c];
  slashFrames = slashFramesR;
}

// --- Battle System ---

function calcDamage(atk, def) {
  return Math.max(1, atk - Math.floor(def / 2) + Math.floor(Math.random() * (Math.floor(atk / 4) + 1)));
}

function rollHits(atk, def, hitRate, potentialHits) {
  const results = [];
  for (let i = 0; i < potentialHits; i++) {
    if (Math.random() * 100 < hitRate) {
      let dmg = calcDamage(atk, def);
      const crit = Math.random() * 100 < CRIT_RATE;
      if (crit) dmg = Math.floor(dmg * CRIT_MULT);
      results.push({ damage: dmg, crit });
    }
  }
  // At least 1 result — if all missed, return single miss entry
  if (results.length === 0) results.push({ miss: true });
  return results;
}

function startBattle() {
  battleState = 'roar-slide-in';
  battleTimer = 0;
  battleCursor = 0;
  battleMessage = null;
  bossDamageNum = null;
  playerDamageNum = null;
  bossFlashTimer = 0;
  battleShakeTimer = 0;
  bossHP = BOSS_MAX_HP;
  playSFX(SFX.EARTHQUAKE);
}

function startRandomEncounter() {
  isRandomEncounter = true;
  const goblin = MONSTERS.get(0x00);
  const count = 1 + Math.floor(Math.random() * 4); // 1-4 goblins
  encounterMonsters = [];
  for (let i = 0; i < count; i++) {
    encounterMonsters.push({ hp: goblin.hp, maxHP: goblin.hp, atk: goblin.atk, def: goblin.def, exp: goblin.exp, hitRate: GOBLIN_HIT_RATE });
  }
  preBattleTrack = TRACKS.CRYSTAL_CAVE;
  // Skip roar/earthquake — go straight to flash-strobe
  battleState = 'flash-strobe';
  battleTimer = 0;
  battleCursor = 0;
  battleMessage = null;
  bossDamageNum = null;
  playerDamageNum = null;
  bossFlashTimer = 0;
  battleShakeTimer = 0;
  playSFX(SFX.BATTLE_SWIPE);
}

function executeBattleCommand(index) {
  if (index === 0) {
    // Fight — go to target select (cursor on enemy)
    playSFX(SFX.CONFIRM);
    if (isRandomEncounter && encounterMonsters) {
      targetIndex = encounterMonsters.findIndex(m => m.hp > 0);
    }
    battleState = 'target-select';
    battleTimer = 0;
  } else if (index === 1) {
    // Magic
    playSFX(SFX.CANCEL);
    battleMessage = BATTLE_NO_MAGIC;
    battleState = 'message-hold';
    battleTimer = 0;
  } else if (index === 2) {
    // Item
    playSFX(SFX.CANCEL);
    battleMessage = BATTLE_NO_ITEMS;
    battleState = 'message-hold';
    battleTimer = 0;
  } else {
    // Run
    if (isRandomEncounter) {
      playSFX(SFX.CONFIRM);
      battleState = 'none';
      battleTimer = 0;
      isRandomEncounter = false;
      encounterMonsters = null;
      dyingMonsterIndex = -1;
      sprite.setDirection(DIR_DOWN);
      playTrack(preBattleTrack);
    } else {
      playSFX(SFX.CANCEL);
      battleMessage = BATTLE_CANT_ESCAPE;
      battleState = 'message-hold';
      battleTimer = 0;
    }
  }
}

function updateBattle(dt) {
  if (battleState === 'none') return;
  battleTimer += Math.min(dt, 33);

  // Boss blink countdown
  if (bossFlashTimer > 0) bossFlashTimer = Math.max(0, bossFlashTimer - dt);

  // Battle shake countdown
  if (battleShakeTimer > 0) battleShakeTimer = Math.max(0, battleShakeTimer - dt);

  // Damage number timers
  if (bossDamageNum) {
    bossDamageNum.timer += dt;
    if (bossDamageNum.timer >= BATTLE_DMG_SHOW_MS) bossDamageNum = null;
  }
  if (playerDamageNum) {
    playerDamageNum.timer += dt;
    if (playerDamageNum.timer >= BATTLE_DMG_SHOW_MS) playerDamageNum = null;
  }

  // State machine
  if (battleState === 'roar-slide-in') {
    if (battleTimer >= BATTLE_SCROLL_MS) { battleState = 'roar-text-in'; battleTimer = 0; }
  } else if (battleState === 'roar-text-in') {
    if (battleTimer >= BATTLE_TEXT_STEPS * BATTLE_TEXT_STEP_MS) { battleState = 'roar-hold'; battleTimer = 0; }
  } else if (battleState === 'roar-hold') {
    // waits for Z press in handleInput
  } else if (battleState === 'roar-text-out') {
    if (battleTimer >= BATTLE_TEXT_STEPS * BATTLE_TEXT_STEP_MS) { battleState = 'roar-slide-out'; battleTimer = 0; }
  } else if (battleState === 'roar-slide-out') {
    if (battleTimer >= BATTLE_SCROLL_MS) { battleState = 'flash-strobe'; battleTimer = 0; playSFX(SFX.BATTLE_SWIPE); }
  } else if (battleState === 'flash-strobe') {
    if (battleTimer >= BATTLE_FLASH_FRAMES * BATTLE_FLASH_FRAME_MS) {
      if (isRandomEncounter) {
        battleState = 'encounter-box-expand'; battleTimer = 0; playTrack(TRACKS.BATTLE);
      } else {
        battleState = 'boss-box-expand'; battleTimer = 0; playTrack(TRACKS.BOSS_BATTLE);
      }
    }
  } else if (battleState === 'encounter-box-expand') {
    if (battleTimer >= BOSS_BOX_EXPAND_MS) { battleState = 'monster-slide-in'; battleTimer = 0; }
  } else if (battleState === 'monster-slide-in') {
    if (battleTimer >= MONSTER_SLIDE_MS) { battleState = 'battle-fade-in'; battleTimer = 0; }
  } else if (battleState === 'boss-box-expand') {
    if (battleTimer >= BOSS_BOX_EXPAND_MS) { battleState = 'boss-appear'; battleTimer = 0; }
  } else if (battleState === 'boss-appear') {
    if (battleTimer >= BOSS_BLOCKS * BOSS_DISSOLVE_STEPS * BOSS_DISSOLVE_FRAME_MS) { battleState = 'battle-fade-in'; battleTimer = 0; }
  } else if (battleState === 'battle-fade-in') {
    if (battleTimer >= (BATTLE_TEXT_STEPS + 1) * BATTLE_TEXT_STEP_MS) { battleState = 'menu-open'; battleTimer = 0; }
  } else if (battleState === 'message-hold') {
    if (battleTimer >= BATTLE_MSG_HOLD_MS) { battleState = 'menu-open'; battleTimer = 0; battleMessage = null; }
  } else if (battleState === 'attack-start') {
    // Brief pause so CONFIRM SFX is audible before first punch
    if (battleTimer >= 250) {
      playSFX(SFX.ATTACK_HIT);
      battleState = 'player-slash';
      battleTimer = 0;
    }
  } else if (battleState === 'player-slash') {
    // 3-frame punch animation (50ms per frame = 150ms total)
    const frame = Math.floor(battleTimer / SLASH_FRAME_MS);
    if (frame !== slashFrame && frame < SLASH_FRAMES) {
      slashFrame = frame;
      // Randomize position each frame — punch scatter (ROM: every 2 ticks)
      slashOffX = Math.floor(Math.random() * 40) - 20;
      slashOffY = Math.floor(Math.random() * 40) - 20;
    }
    if (battleTimer >= SLASH_FRAMES * SLASH_FRAME_MS) {
      const hit = hitResults[currentHitIdx];
      if (hit.miss) {
        battleState = 'player-miss-show';
        battleTimer = 0;
        bossDamageNum = { miss: true, timer: 0 };
      } else {
        // Subtract damage from target
        if (isRandomEncounter && encounterMonsters) {
          encounterMonsters[targetIndex].hp = Math.max(0, encounterMonsters[targetIndex].hp - hit.damage);
        } else {
          bossHP = Math.max(0, bossHP - hit.damage);
        }
        bossDamageNum = { value: hit.damage, crit: hit.crit, timer: 0 };
        battleState = 'player-hit-show';
        battleTimer = 0;
      }
    }
  } else if (battleState === 'player-hit-show') {
    if (battleTimer >= HIT_PAUSE_MS) {
      // Check if target died mid-combo
      const targetDead = isRandomEncounter && encounterMonsters
        ? encounterMonsters[targetIndex].hp <= 0
        : bossHP <= 0;
      if (targetDead) {
        // Remaining hits wasted — go to death animation
        if (isRandomEncounter && encounterMonsters) {
          dyingMonsterIndex = targetIndex;
          battleState = 'monster-death';
          battleTimer = 0;
          playSFX(SFX.MONSTER_DEATH);
        } else {
          battleState = 'boss-dissolve';
          battleTimer = 0;
          playSFX(SFX.BOSS_DEATH);
        }
      } else if (currentHitIdx + 1 < hitResults.length) {
        // More hits — next slash, alternate hands (R/L/R/L)
        currentHitIdx++;
        slashFrame = 0;
        slashFrames = (currentHitIdx % 2 === 0) ? slashFramesR : slashFramesL;
        slashOffX = Math.floor(Math.random() * 40) - 20;
        slashOffY = Math.floor(Math.random() * 40) - 20;
        playSFX(SFX.ATTACK_HIT);
        battleState = 'player-slash';
        battleTimer = 0;
      } else {
        // All hits done — transition to player-damage-show for brief final display, then enemies counter
        battleState = 'player-damage-show';
        battleTimer = 0;
      }
    }
  } else if (battleState === 'player-miss-show') {
    if (battleTimer >= MISS_SHOW_MS) {
      if (currentHitIdx + 1 < hitResults.length) {
        // More hits to try, alternate hands
        currentHitIdx++;
        slashFrame = 0;
        slashFrames = (currentHitIdx % 2 === 0) ? slashFramesR : slashFramesL;
        slashOffX = Math.floor(Math.random() * 40) - 20;
        slashOffY = Math.floor(Math.random() * 40) - 20;
        playSFX(SFX.ATTACK_HIT);
        battleState = 'player-slash';
        battleTimer = 0;
      } else {
        // All hits done (all missed) — enemies counter
        battleState = 'player-damage-show';
        battleTimer = 0;
      }
    }
  } else if (battleState === 'player-damage-show') {
    if (battleTimer >= PLAYER_DMG_SHOW_MS) {
      // Check if targeted monster just died — play death stripe animation
      if (isRandomEncounter && encounterMonsters && encounterMonsters[targetIndex].hp <= 0) {
        dyingMonsterIndex = targetIndex;
        battleState = 'monster-death';
        battleTimer = 0;
        playSFX(SFX.MONSTER_DEATH);
      } else if (!isRandomEncounter && bossHP <= 0) {
        // Boss defeated — dissolve out
        battleState = 'boss-dissolve';
        battleTimer = 0;
        playSFX(SFX.BOSS_DEATH);
      } else {
        // Build attack queue — all alive monsters attack in sequence
        if (isRandomEncounter && encounterMonsters) {
          enemyAttackQueue = [];
          for (let i = 0; i < encounterMonsters.length; i++) {
            if (encounterMonsters[i].hp > 0) enemyAttackQueue.push(i);
          }
        } else {
          enemyAttackQueue = [-1]; // boss uses -1 sentinel
        }
        currentAttacker = enemyAttackQueue.shift();
        battleState = 'boss-flash';
        battleTimer = 0;
      }
    }
  } else if (battleState === 'monster-death') {
    if (battleTimer >= MONSTER_DEATH_MS) {
      dyingMonsterIndex = -1;
      const allDead = encounterMonsters.every(m => m.hp <= 0);
      if (allDead) {
        encounterExpGained = encounterMonsters.reduce((sum, m) => sum + m.exp, 0);
        grantExp(encounterExpGained);
        if (saveSlots[selectCursor]) {
          saveSlots[selectCursor].level = playerStats.level;
          saveSlots[selectCursor].exp = playerStats.exp;
          saveSlots[selectCursor].stats = {
            str: playerStats.str, agi: playerStats.agi, vit: playerStats.vit,
            int: playerStats.int, mnd: playerStats.mnd,
            maxHP: playerStats.maxHP, maxMP: playerStats.maxMP
          };
        }
        saveSlotsToDB();
        battleState = 'victory-name-out';
        battleTimer = 0;
      } else {
        // Remaining enemies attack
        enemyAttackQueue = [];
        for (let i = 0; i < encounterMonsters.length; i++) {
          if (encounterMonsters[i].hp > 0) enemyAttackQueue.push(i);
        }
        currentAttacker = enemyAttackQueue.shift();
        battleState = 'boss-flash';
        battleTimer = 0;
      }
    }
  } else if (battleState === 'boss-flash') {
    if (battleTimer >= BOSS_PREFLASH_MS) {
      // Roll accuracy for current attacker
      const monHitRate = (currentAttacker >= 0 && encounterMonsters)
        ? (encounterMonsters[currentAttacker].hitRate || GOBLIN_HIT_RATE) : BOSS_HIT_RATE;
      if (Math.random() * 100 < monHitRate) {
        // Hit — deal damage
        const monAtk = (currentAttacker >= 0 && encounterMonsters)
          ? encounterMonsters[currentAttacker].atk : BOSS_ATK;
        const dmg = calcDamage(monAtk, playerDEF);
        playerHP = Math.max(0, playerHP - dmg);
        playerDamageNum = { value: dmg, timer: 0 };
        playSFX(SFX.ATTACK_HIT);
        battleShakeTimer = BATTLE_SHAKE_MS;
        battleState = 'enemy-attack';
        battleTimer = 0;
      } else {
        // Miss — show miss text, skip shake, go to enemy-damage-show
        playerDamageNum = { miss: true, timer: 0 };
        battleState = 'enemy-damage-show';
        battleTimer = 0;
      }
    }
  } else if (battleState === 'enemy-attack') {
    if (battleTimer >= BATTLE_SHAKE_MS) {
      battleState = 'enemy-damage-show';
      battleTimer = 0;
    }
  } else if (battleState === 'enemy-damage-show') {
    if (battleTimer >= BATTLE_DMG_SHOW_MS) {
      if (playerHP <= 0) {
        // Player defeated — reload after 2s
        battleState = 'defeat';
        battleTimer = 0;
      } else if (enemyAttackQueue.length > 0) {
        // Next monster in queue attacks
        currentAttacker = enemyAttackQueue.shift();
        battleState = 'boss-flash';
        battleTimer = 0;
      } else {
        // All enemies attacked — back to menu
        battleState = 'menu-open';
        battleTimer = 0;
      }
    }
  } else if (battleState === 'boss-dissolve') {
    // Play death SFX every 4 blocks
    const dFrame = Math.floor(battleTimer / BOSS_DISSOLVE_FRAME_MS);
    const dBlock = Math.floor(dFrame / BOSS_DISSOLVE_STEPS);
    const prevFrame = Math.floor((battleTimer - dt) / BOSS_DISSOLVE_FRAME_MS);
    const prevBlock = Math.floor(prevFrame / BOSS_DISSOLVE_STEPS);
    if (dBlock !== prevBlock && dBlock > 0 && (dBlock & 3) === 0) playSFX(SFX.BOSS_DEATH);
    if (battleTimer >= BOSS_BLOCKS * BOSS_DISSOLVE_STEPS * BOSS_DISSOLVE_FRAME_MS) {
      bossDefeated = true;
      bossSprite = null;
      encounterExpGained = 20;
      grantExp(20);
      // Update active save slot with current stats
      if (saveSlots[selectCursor]) {
        saveSlots[selectCursor].level = playerStats.level;
        saveSlots[selectCursor].exp = playerStats.exp;
        saveSlots[selectCursor].stats = {
          str: playerStats.str, agi: playerStats.agi, vit: playerStats.vit,
          int: playerStats.int, mnd: playerStats.mnd,
          maxHP: playerStats.maxHP, maxMP: playerStats.maxMP
        };
      }
      saveSlotsToDB();
      battleState = 'victory-name-out';
      battleTimer = 0;
    }
  } else if (battleState === 'victory-name-out') {
    if (battleTimer >= (BATTLE_TEXT_STEPS + 1) * BATTLE_TEXT_STEP_MS) {
      battleState = 'victory-celebrate';
      battleTimer = 0;
      playTrack(TRACKS.VICTORY);
    }
  } else if (battleState === 'victory-celebrate') {
    if (battleTimer >= 400) {
      battleState = 'victory-box-open';
      battleTimer = 0;
    }
  } else if (battleState === 'victory-box-open') {
    if (battleTimer >= VICTORY_BOX_ROWS * VICTORY_ROW_FRAME_MS) { battleState = 'victory-text-in'; battleTimer = 0; }
  } else if (battleState === 'victory-text-in') {
    if (battleTimer >= (BATTLE_TEXT_STEPS + 1) * BATTLE_TEXT_STEP_MS) { battleState = 'victory-hold'; battleTimer = 0; }
  } else if (battleState === 'victory-hold') {
    // waits for Z press in handleInput
  } else if (battleState === 'exp-text-in') {
    if (battleTimer >= (BATTLE_TEXT_STEPS + 1) * BATTLE_TEXT_STEP_MS) { battleState = 'exp-hold'; battleTimer = 0; }
  } else if (battleState === 'exp-hold') {
    // waits for Z press in handleInput
  } else if (battleState === 'victory-text-out') {
    if (battleTimer >= (BATTLE_TEXT_STEPS + 1) * BATTLE_TEXT_STEP_MS) {
      battleState = 'victory-box-close'; battleTimer = 0;
    }
  } else if (battleState === 'victory-box-close') {
    if (battleTimer >= VICTORY_BOX_ROWS * VICTORY_ROW_FRAME_MS) {
      if (isRandomEncounter) {
        battleState = 'encounter-box-close'; battleTimer = 0;
      } else {
        battleState = 'boss-box-close'; battleTimer = 0;
      }
    }
  } else if (battleState === 'encounter-box-close') {
    if (battleTimer >= BOSS_BOX_EXPAND_MS) {
      battleState = 'none';
      battleTimer = 0;
      sprite.setDirection(DIR_DOWN);
      isRandomEncounter = false;
      encounterMonsters = null;
      dyingMonsterIndex = -1;
      playTrack(preBattleTrack);
    }
  } else if (battleState === 'boss-box-close') {
    if (battleTimer >= BOSS_BOX_EXPAND_MS) {
      battleState = 'none';
      battleTimer = 0;
      sprite.setDirection(DIR_DOWN);
      playTrack(TRACKS.CRYSTAL_ROOM);
    }
  } else if (battleState === 'defeat') {
    stopMusic();
    battleState = 'defeat-fade';
    battleTimer = 0;
  } else if (battleState === 'defeat-fade') {
    if (battleTimer >= 400) {
      battleState = 'defeat-text';
      battleTimer = 0;
    }
  } else if (battleState === 'defeat-text') {
    if (battleTimer >= 3000 || (battleTimer >= 500 && (keys['z'] || keys['Z']))) {
      location.reload();
    }
  }
}

function drawBattle() {
  if (battleState === 'none') return;

  // Player sprite portrait — drawn here (above border layer) during battle
  const shakeOff = (battleState === 'enemy-attack' && battleShakeTimer > 0)
    ? (Math.floor(battleShakeTimer / 67) & 1 ? 2 : -2) : 0;
  const isVictoryPose = battleState === 'victory-celebrate' ||
    battleState === 'victory-box-open' || battleState === 'victory-text-in' ||
    battleState === 'victory-hold' || battleState === 'exp-text-in' || battleState === 'exp-hold' ||
    battleState === 'victory-text-out' || battleState === 'victory-box-close';
  const isAttackPose = battleState === 'attack-start' || battleState === 'player-slash';
  let portraitSrc = battleSpriteCanvas;
  if (isAttackPose && battleSpriteAttackCanvas) {
    // Alternate right/left hand every 150ms during attack
    const atkHand = Math.floor(battleTimer / 150) & 1;
    portraitSrc = (atkHand && battleSpriteAttackLCanvas) ? battleSpriteAttackLCanvas : battleSpriteAttackCanvas;
  } else if (isVictoryPose && battleSpriteVictoryCanvas) {
    // Alternate idle/victory every 250ms throughout victory sequence
    if (Math.floor(Date.now() / 250) & 1) portraitSrc = battleSpriteVictoryCanvas;
  }
  if (portraitSrc) {
    ctx.drawImage(portraitSrc, HUD_RIGHT_X + 8 + shakeOff, HUD_VIEW_Y + 8);
  }

  // NES grayscale strobe — toggle grayscale every frame for 65 frames
  if (battleState === 'flash-strobe') {
    const frame = Math.floor(battleTimer / BATTLE_FLASH_FRAME_MS);
    if (frame & 1) {
      // Odd frames: grayscale (matches NES PPUMASK bit 0)
      ctx.save();
      ctx.beginPath();
      ctx.rect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);
      ctx.clip();
      ctx.filter = 'saturate(0)';
      ctx.drawImage(ctx.canvas, HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H,
                                HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);
      ctx.filter = 'none';
      ctx.restore();
    }
  }

  drawRoarBox();
  drawEncounterBox();
  drawBossSpriteBox();
  drawBattleMenu();
  drawBattleMessage();
  drawVictoryBox();

  drawDamageNumbers();

  // Defeat fade — black overlay increasing opacity over viewport
  if (battleState === 'defeat-fade') {
    const alpha = Math.min(battleTimer / 400, 1);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#000';
    ctx.fillRect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);
    ctx.restore();
  }

  // Defeat text — black viewport with "Defeated" text NES fade-in
  if (battleState === 'defeat-text') {
    ctx.fillStyle = '#000';
    ctx.fillRect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);
    // NES palette fade-in: $0F → $10 → $20 → $30 over 400ms (4 steps × 100ms)
    const fadeStep = Math.min(Math.floor(battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
    const DEFEAT_FADE = [0x0F, 0x10, 0x20, 0x30, 0x30];
    const textPal = [DEFEAT_FADE[fadeStep], DEFEAT_FADE[fadeStep], DEFEAT_FADE[fadeStep], DEFEAT_FADE[fadeStep]];
    const tw = measureText(BATTLE_DEFEATED);
    const tx = HUD_VIEW_X + Math.floor((HUD_VIEW_W - tw) / 2);
    const ty = HUD_VIEW_Y + Math.floor((HUD_VIEW_H - 8) / 2);
    drawText(ctx, tx, ty, BATTLE_DEFEATED, textPal);
  }
}

function drawRoarBox() {
  const isRoar = battleState.startsWith('roar-');
  if (!isRoar) return;

  const boxW = HUD_VIEW_W - 16;
  const boxH = 48;
  const vpBot = HUD_VIEW_Y + HUD_VIEW_H;
  const finalY = vpBot - boxH - 8;
  const centerX = HUD_VIEW_X + Math.floor((HUD_VIEW_W - boxW) / 2);

  let boxY = finalY;
  if (battleState === 'roar-slide-in') {
    const t = Math.min(battleTimer / BATTLE_SCROLL_MS, 1);
    boxY = vpBot + (finalY - vpBot) * t;
  } else if (battleState === 'roar-slide-out') {
    const t = Math.min(battleTimer / BATTLE_SCROLL_MS, 1);
    boxY = finalY + (vpBot - finalY) * t;
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);
  ctx.clip();

  _drawBorderedBox(centerX, boxY, boxW, boxH, true);

  // Text with NES fade — from blue (0x02) to white (0x30)
  if (battleState === 'roar-text-in' || battleState === 'roar-hold' || battleState === 'roar-text-out') {
    const ROAR_FADE = [0x02, 0x12, 0x20, 0x30]; // blue → light blue → grey → white
    let step = ROAR_FADE.length - 1; // fully bright
    if (battleState === 'roar-text-in') {
      step = Math.min(Math.floor(battleTimer / BATTLE_TEXT_STEP_MS), ROAR_FADE.length - 1);
    } else if (battleState === 'roar-text-out') {
      step = (ROAR_FADE.length - 1) - Math.min(Math.floor(battleTimer / BATTLE_TEXT_STEP_MS), ROAR_FADE.length - 1);
    }

    const fadedPal = [0x02, 0x02, 0x02, ROAR_FADE[step]];

    const tw = measureText(BATTLE_ROAR);
    const tx = centerX + Math.floor((boxW - tw) / 2);
    const ty = boxY + Math.floor((boxH - 8) / 2);
    drawText(ctx, tx, ty, BATTLE_ROAR, fadedPal);
  }

  ctx.restore();
}

function drawBattleMenu() {
  const isSlide = battleState === 'boss-box-expand' || battleState === 'encounter-box-expand';
  const isAppear = battleState === 'boss-appear';
  const isFade = battleState === 'battle-fade-in';
  const isMenu = isFade ||
                 battleState === 'menu-open' || battleState === 'target-select' ||
                 battleState === 'attack-start' || battleState === 'player-slash' || battleState === 'player-hit-show' ||
                 battleState === 'player-miss-show' ||
                 battleState === 'player-damage-show' || battleState === 'monster-death' ||
                 battleState === 'boss-flash' ||
                 battleState === 'enemy-attack' ||
                 battleState === 'enemy-damage-show' || battleState === 'message-hold' ||
                 battleState === 'boss-dissolve' || battleState === 'defeat' ||
                 battleState === 'defeat-fade';
  const isVictory = battleState === 'victory-name-out' || battleState === 'victory-celebrate' ||
                    battleState === 'victory-box-open' || battleState === 'victory-text-in' ||
                    battleState === 'victory-hold' || battleState === 'exp-text-in' ||
                    battleState === 'exp-hold' || battleState === 'victory-text-out' ||
                    battleState === 'victory-box-close';
  if (!isSlide && !isAppear && !isMenu && !isVictory) return;

  // Clear bottom panel interior
  ctx.fillStyle = '#000';
  ctx.fillRect(8, HUD_BOT_Y + 8, CANVAS_W - 16, HUD_BOT_H - 16);

  // Left bordered box — slides in during boss-box-expand, stays put after
  // Skip left box during victory states (drawVictoryBox handles left area)
  const boxW = BATTLE_PANEL_W;
  const boxH = HUD_BOT_H;
  if (!isVictory) {
    let boxX = 0;
    if (isSlide) {
      const t = Math.min(battleTimer / BOSS_BOX_EXPAND_MS, 1);
      boxX = -boxW + boxW * t;
    }
    _drawBorderedBox(Math.round(boxX), HUD_BOT_Y, boxW, boxH);
  }

  // Text only after slide + dissolve complete (or during victory for right side)
  if (!isMenu && !isVictory) return;

  let fadeStep = 0;
  if (isFade) {
    fadeStep = BATTLE_TEXT_STEPS - Math.min(Math.floor(battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
  }

  const fadedPal = [0x0F, 0x0F, 0x0F, 0x30];
  for (let s = 0; s < fadeStep; s++) fadedPal[3] = nesColorFade(fadedPal[3]);

  // Enemy name centered in left box (skip during victory — drawVictoryBox handles it)
  if (!isVictory) {
    let enemyName;
    if (isRandomEncounter && encounterMonsters) {
      const alive = encounterMonsters.filter(m => m.hp > 0).length;
      if (alive > 1) {
        const arr = Array.from(BATTLE_GOBLIN_NAME);
        arr.push(0xFF, 0xE1, 0x80 + alive);
        enemyName = new Uint8Array(arr);
      } else {
        enemyName = BATTLE_GOBLIN_NAME;
      }
    } else {
      enemyName = BATTLE_BOSS_NAME;
    }
    const nameTw = measureText(enemyName);
    const nameX = Math.floor((boxW - nameTw) / 2);
    const nameY = HUD_BOT_Y + Math.floor((boxH - 8) / 2);
    drawText(ctx, nameX, nameY, enemyName, fadedPal);
  }

  // 2×2 menu grid on right side of bottom panel (visible during combat AND victory)
  const menuX = boxW + 16;
  const colL = menuX;
  const colR = menuX + 64;
  const row0 = HUD_BOT_Y + 16;
  const row1 = HUD_BOT_Y + 32;
  const positions = [[colL, row0], [colR, row0], [colL, row1], [colR, row1]];

  // During victory, draw menu text at full brightness (no fade)
  const menuPal = isVictory ? [0x0F, 0x0F, 0x0F, 0x30] : fadedPal;
  for (let i = 0; i < BATTLE_MENU_ITEMS.length; i++) {
    drawText(ctx, positions[i][0], positions[i][1], BATTLE_MENU_ITEMS[i], menuPal);
  }

  // Hand cursor (hidden during target-select and victory states)
  if (cursorTileCanvas && (battleState === 'menu-open' || isFade) && battleState !== 'target-select') {
    const ci = battleCursor;
    const curX = positions[ci][0] - 16;
    const curY = positions[ci][1] - 4;
    if (fadeStep === 0) {
      ctx.drawImage(cursorTileCanvas, curX, curY);
    } else if (fadeStep < BATTLE_TEXT_STEPS) {
      ctx.globalAlpha = 1 - fadeStep / BATTLE_TEXT_STEPS;
      ctx.drawImage(cursorTileCanvas, curX, curY);
      ctx.globalAlpha = 1;
    }
  }
}

function _encounterGridPos(boxX, boxY, boxW, boxH, count) {
  // Returns top-left positions for 32×32 sprite rendering in 2×2 grid.
  const cx = boxX + Math.floor(boxW / 2);
  const cy = boxY + Math.floor(boxH / 2);
  const s = 32;
  const hs = 16;
  if (count === 1) return [{ x: cx - hs, y: cy - hs }];
  const gapX = 20, gapY = 20;
  if (count === 2) return [
    { x: cx - gapX - hs, y: cy - hs },
    { x: cx + gapX - hs, y: cy - hs },
  ];
  if (count === 3) return [
    { x: cx - gapX - hs, y: cy - gapY - hs },
    { x: cx + gapX - hs, y: cy - gapY - hs },
    { x: cx - hs,         y: cy + gapY - hs },
  ];
  return [ // 4
    { x: cx - gapX - hs, y: cy - gapY - hs },
    { x: cx + gapX - hs, y: cy - gapY - hs },
    { x: cx - gapX - hs, y: cy + gapY - hs },
    { x: cx + gapX - hs, y: cy + gapY - hs },
  ];
}

function drawEncounterBox() {
  if (!isRandomEncounter || !encounterMonsters) return;
  const isExpand = battleState === 'encounter-box-expand';
  const isClose = battleState === 'encounter-box-close';
  const isSlideIn = battleState === 'monster-slide-in';
  const isCombat = isSlideIn || battleState === 'battle-fade-in' ||
                   battleState === 'menu-open' || battleState === 'target-select' ||
                   battleState === 'attack-start' || battleState === 'player-slash' || battleState === 'player-hit-show' ||
                   battleState === 'player-miss-show' ||
                   battleState === 'player-damage-show' || battleState === 'monster-death' ||
                   battleState === 'boss-flash' ||
                   battleState === 'enemy-attack' ||
                   battleState === 'enemy-damage-show' || battleState === 'message-hold' ||
                   battleState === 'defeat' || battleState === 'defeat-fade';
  const isVictory = battleState === 'victory-name-out' || battleState === 'victory-celebrate' ||
                    battleState === 'victory-box-open' || battleState === 'victory-text-in' ||
                    battleState === 'victory-hold' || battleState === 'exp-text-in' ||
                    battleState === 'exp-hold' || battleState === 'victory-text-out' ||
                    battleState === 'victory-box-close';
  if (!isExpand && !isClose && !isCombat && !isVictory) return;

  const count = encounterMonsters.length;
  const fullW = count === 1 ? 64 : 96;
  const fullH = count <= 2 ? 64 : 96;
  const centerX = HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2);
  const centerY = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2);

  // Box expand/close from center
  let boxW = fullW, boxH = fullH;
  if (isExpand) {
    const t = Math.min(battleTimer / BOSS_BOX_EXPAND_MS, 1);
    boxW = Math.max(16, Math.ceil(fullW * t / 8) * 8);
    boxH = Math.max(16, Math.ceil(fullH * t / 8) * 8);
  } else if (isClose) {
    const t = 1 - Math.min(battleTimer / BOSS_BOX_EXPAND_MS, 1);
    boxW = Math.max(16, Math.ceil(fullW * t / 8) * 8);
    boxH = Math.max(16, Math.ceil(fullH * t / 8) * 8);
  }
  const boxX = centerX - Math.floor(boxW / 2);
  const boxY = centerY - Math.floor(boxH / 2);

  ctx.save();
  ctx.beginPath();
  ctx.rect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);
  ctx.clip();
  _drawBorderedBox(boxX, boxY, boxW, boxH);

  // No content during expand or close
  if (isExpand || isClose) { ctx.restore(); return; }

  // Draw goblin sprites in 2×2 grid
  const gridPos = _encounterGridPos(boxX, boxY, fullW, fullH, count);
  if (goblinBattleCanvas) {
    // Slide-in: sprites start off left edge of box, slide right to final position
    // ROM: 16 frames × 16px/frame via PPU scroll. We offset sprites leftward and clip to box interior.
    let slideOffX = 0;
    if (isSlideIn) {
      const t = Math.min(battleTimer / MONSTER_SLIDE_MS, 1);
      slideOffX = Math.floor((1 - t) * (fullW + 32)); // start fully off-screen left
    }

    // Clip sprites to box interior (inside the 8px border)
    ctx.save();
    ctx.beginPath();
    ctx.rect(boxX + 8, boxY + 8, boxW - 16, boxH - 16);
    ctx.clip();

    ctx.imageSmoothingEnabled = false;
    for (let i = 0; i < count; i++) {
      const alive = encounterMonsters[i].hp > 0;
      const isDying = i === dyingMonsterIndex && battleState === 'monster-death';
      // Keep dead monster visible during slash + hit-show + miss-show + damage show
      const isBeingHit = i === targetIndex &&
        (battleState === 'player-slash' || battleState === 'player-hit-show' ||
         battleState === 'player-miss-show' || battleState === 'player-damage-show');

      if (!alive && !isDying && !isBeingHit) continue;

      const pos = gridPos[i];
      const drawX = pos.x - slideOffX;

      if (isDying) {
        _drawMonsterDeath(drawX, pos.y, 32, Math.min(battleTimer / MONSTER_DEATH_MS, 1));
      } else {
        // Hit blink during player-slash (60ms toggle)
        const isHitBlink = isBeingHit && battleState === 'player-slash' &&
                           (Math.floor(battleTimer / 60) & 1);
        // White flash blink during boss-flash for current attacker
        const isFlashing = battleState === 'boss-flash' && currentAttacker === i &&
                           Math.floor(battleTimer / 33) % 2 === 1;
        if (!isHitBlink) {
          const spr = isFlashing ? goblinWhiteCanvas : goblinBattleCanvas;
          ctx.drawImage(spr, drawX, pos.y);
        }
      }
    }

    // Draw punch impact on target during player-slash (16×16 centered on target + scatter)
    if (battleState === 'player-slash' && slashFrames && slashFrame < SLASH_FRAMES) {
      const pos = gridPos[targetIndex];
      const sx = pos.x - slideOffX + slashOffX + 8;  // center 16px on 32px sprite
      const sy = pos.y + slashOffY + 8;
      ctx.drawImage(slashFrames[slashFrame], sx, sy);
    }
    ctx.restore();
  }

  // Target-select cursor — hand cursor to the left of selected monster
  if (battleState === 'target-select' && cursorTileCanvas) {
    const pos = gridPos[targetIndex];
    ctx.drawImage(cursorTileCanvas, pos.x - 10, pos.y + 12);
  }

  ctx.restore();
}

function drawBossSpriteBox() {
  if (isRandomEncounter) return;
  if (!landTurtleBattleCanvas) return;

  const isExpand = battleState === 'boss-box-expand';
  const isClose = battleState === 'boss-box-close';
  const isAppear = battleState === 'boss-appear';
  const isDissolve = battleState === 'boss-dissolve';
  const isCombat = battleState === 'battle-fade-in' ||
                   battleState === 'menu-open' || battleState === 'target-select' ||
                   battleState === 'attack-start' || battleState === 'player-slash' || battleState === 'player-hit-show' ||
                   battleState === 'player-miss-show' ||
                   battleState === 'player-damage-show' || battleState === 'boss-flash' ||
                   battleState === 'enemy-attack' ||
                   battleState === 'enemy-damage-show' || battleState === 'message-hold' ||
                   battleState === 'defeat' || battleState === 'defeat-fade';
  const isVictory = battleState === 'victory-name-out' || battleState === 'victory-celebrate' ||
                    battleState === 'victory-box-open' || battleState === 'victory-text-in' ||
                    battleState === 'victory-hold' || battleState === 'exp-text-in' ||
                    battleState === 'exp-hold' || battleState === 'victory-text-out' ||
                    battleState === 'victory-box-close';
  if (!isExpand && !isClose && !isAppear && !isDissolve && !isCombat && !isVictory) return;

  const fullW = 64;  // 48px sprite + 8px border each side
  const fullH = 64;
  const centerX = HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2);
  const centerY = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2);

  ctx.save();
  ctx.beginPath();
  ctx.rect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);
  ctx.clip();

  // Box expand/close from center
  let boxW = fullW, boxH = fullH;
  if (isExpand) {
    const t = Math.min(battleTimer / BOSS_BOX_EXPAND_MS, 1);
    boxW = Math.max(16, Math.ceil(fullW * t / 8) * 8);
    boxH = Math.max(16, Math.ceil(fullH * t / 8) * 8);
  } else if (isClose) {
    const t = 1 - Math.min(battleTimer / BOSS_BOX_EXPAND_MS, 1);
    boxW = Math.max(16, Math.ceil(fullW * t / 8) * 8);
    boxH = Math.max(16, Math.ceil(fullH * t / 8) * 8);
  }
  const boxX = centerX - Math.floor(boxW / 2);
  const boxY = centerY - Math.floor(boxH / 2);
  _drawBorderedBox(boxX, boxY, boxW, boxH);

  // No sprite during expand or close
  if (isExpand || isClose) { ctx.restore(); return; }

  // Battle sprite — dissolve in/out or full draw
  const sprX = centerX - 24;  // 48/2 = 24
  const sprY = centerY - 24;
  ctx.imageSmoothingEnabled = false;

  if (isAppear || isDissolve) {
    _drawDissolvedSprite(sprX, sprY, isDissolve);
  } else if (battleState === 'boss-flash') {
    // Pre-attack white blink — alternate normal/white every other frame (~16.67ms each)
    const frame = Math.floor(battleTimer / (BOSS_PREFLASH_MS / 8));
    if (!bossDefeated) {
      if (frame & 1) {
        ctx.drawImage(landTurtleWhiteCanvas || landTurtleBattleCanvas, sprX, sprY);
      } else {
        ctx.drawImage(landTurtleBattleCanvas, sprX, sprY);
      }
    }
  } else if (battleState === 'player-slash') {
    // Blink during slash (60ms toggle)
    const blinkHidden = Math.floor(battleTimer / 60) & 1;
    if (!blinkHidden && !bossDefeated) {
      ctx.drawImage(landTurtleBattleCanvas, sprX, sprY);
    }
    // Draw punch impact with random scatter offset (16×16 metasprite)
    if (slashFrames && slashFrame < SLASH_FRAMES && !bossDefeated) {
      ctx.drawImage(slashFrames[slashFrame], centerX - 8 + slashOffX, centerY - 8 + slashOffY);
    }
  } else {
    // Full sprite — normal draw
    if (!bossDefeated) {
      ctx.drawImage(landTurtleBattleCanvas, sprX, sprY);
    }
  }

  // Target-select cursor — hand cursor on boss sprite box (solid, no blink)
  if (battleState === 'target-select' && cursorTileCanvas) {
    const curX = centerX - 32 - 16;
    const curY = centerY - 8;
    ctx.drawImage(cursorTileCanvas, curX, curY);
  }

  ctx.restore();
}

function _drawDissolvedSprite(sprX, sprY, reverse) {
  // Interlaced pixel-shift dissolve per 16×16 block
  const frame = Math.floor(battleTimer / BOSS_DISSOLVE_FRAME_MS);
  const src = landTurtleBattleCanvas;
  const sctx = src.getContext('2d');

  for (let bi = 0; bi < BOSS_BLOCKS; bi++) {
    const bx = (bi % BOSS_BLOCK_COLS) * BOSS_BLOCK_SIZE;
    const by = Math.floor(bi / BOSS_BLOCK_COLS) * BOSS_BLOCK_SIZE;
    const blockFrame = frame - bi * BOSS_DISSOLVE_STEPS;

    if (!reverse) {
      // Appear: blocks before current are fully visible, after are invisible
      if (blockFrame >= BOSS_DISSOLVE_STEPS) {
        // Fully revealed
        ctx.drawImage(src, bx, by, BOSS_BLOCK_SIZE, BOSS_BLOCK_SIZE,
                      sprX + bx, sprY + by, BOSS_BLOCK_SIZE, BOSS_BLOCK_SIZE);
      } else if (blockFrame >= 0) {
        // Dissolving in: shift = 7 - blockFrame (7→0)
        const shift = 7 - blockFrame;
        _drawShiftedBlock(sctx, sprX, sprY, bx, by, shift);
      }
      // else: not yet started, invisible
    } else {
      // Dissolve out: blocks before current are invisible, after are fully visible
      if (blockFrame >= BOSS_DISSOLVE_STEPS) {
        // Fully dissolved — invisible
      } else if (blockFrame >= 0) {
        // Dissolving out: shift = 1 + blockFrame (1→8)
        const shift = 1 + blockFrame;
        _drawShiftedBlock(sctx, sprX, sprY, bx, by, shift);
      } else {
        // Not yet started — still fully visible
        ctx.drawImage(src, bx, by, BOSS_BLOCK_SIZE, BOSS_BLOCK_SIZE,
                      sprX + bx, sprY + by, BOSS_BLOCK_SIZE, BOSS_BLOCK_SIZE);
      }
    }
  }
}

let _shiftBlockCanvas = null;
function _drawShiftedBlock(sctx, sprX, sprY, bx, by, shift) {
  // Horizontal interlaced pixel shift: even rows left, odd rows right
  // Uses a temp canvas so clipping is respected (putImageData ignores clip)
  if (!_shiftBlockCanvas) {
    _shiftBlockCanvas = document.createElement('canvas');
    _shiftBlockCanvas.width = BOSS_BLOCK_SIZE;
    _shiftBlockCanvas.height = BOSS_BLOCK_SIZE;
  }
  const tc = _shiftBlockCanvas.getContext('2d');
  const imgData = sctx.getImageData(bx, by, BOSS_BLOCK_SIZE, BOSS_BLOCK_SIZE);
  const out = tc.createImageData(BOSS_BLOCK_SIZE, BOSS_BLOCK_SIZE);
  const s = imgData.data;
  const d = out.data;

  for (let row = 0; row < BOSS_BLOCK_SIZE; row++) {
    const dir = (row & 1) ? shift : -shift; // odd rows right, even rows left
    for (let col = 0; col < BOSS_BLOCK_SIZE; col++) {
      const srcCol = col - dir;
      if (srcCol < 0 || srcCol >= BOSS_BLOCK_SIZE) continue;
      const si = (row * BOSS_BLOCK_SIZE + srcCol) * 4;
      const di = (row * BOSS_BLOCK_SIZE + col) * 4;
      d[di]     = s[si];
      d[di + 1] = s[si + 1];
      d[di + 2] = s[si + 2];
      d[di + 3] = s[si + 3];
    }
  }

  tc.putImageData(out, 0, 0);
  ctx.drawImage(_shiftBlockCanvas, sprX + bx, sprY + by);
}

function drawBattleMessage() {
  if (battleState !== 'message-hold' || !battleMessage) return;

  const boxW = 104;
  const boxH = 24;
  const bossCenterY = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2);
  const msgY = bossCenterY + 32 + 8; // below boss box (64/2 = 32) + gap
  const centerX = HUD_VIEW_X + Math.floor((HUD_VIEW_W - boxW) / 2);

  ctx.save();
  ctx.beginPath();
  ctx.rect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);
  ctx.clip();

  _drawBorderedBox(centerX, msgY, boxW, boxH, true);

  const tw = measureText(battleMessage);
  const tx = centerX + Math.floor((boxW - tw) / 2);
  const ty = msgY + Math.floor((boxH - 8) / 2);
  drawText(ctx, tx, ty, battleMessage, TEXT_WHITE_ON_BLUE);

  ctx.restore();
}

function makeExpText(amount) {
  // Build "Got N EXP!" as Uint8Array using ROM font encoding
  // G=0x90, o=0xD8, t=0xDD, space=0xFF, E=0x8E, X=0xA1, P=0x99, !=0xC4
  const digits = String(amount);
  const arr = [0x90, 0xD8, 0xDD, 0xFF]; // "Got "
  for (let i = 0; i < digits.length; i++) arr.push(0x80 + parseInt(digits[i]));
  arr.push(0xFF, 0x8E, 0xA1, 0x99, 0xC4); // " EXP!"
  return new Uint8Array(arr);
}

// Victory box — reuses left box area (120×64 px), row-by-row expand
const VICTORY_BOX_W = BATTLE_PANEL_W;  // 120px (same as left box)
const VICTORY_BOX_H = HUD_BOT_H;       // 64px
const VICTORY_BOX_ROWS = HUD_BOT_H / 8; // 8 rows
const VICTORY_ROW_FRAME_MS = 16.67; // 1 NES frame per row

function drawVictoryBox() {
  const isNameOut = battleState === 'victory-name-out';
  const isCelebrate = battleState === 'victory-celebrate';
  const isOpen = battleState === 'victory-box-open';
  const isClose = battleState === 'victory-box-close';
  const isVicText = battleState === 'victory-text-in';
  const isVicHold = battleState === 'victory-hold';
  const isExpText = battleState === 'exp-text-in';
  const isExpHold = battleState === 'exp-hold';
  const isOut = battleState === 'victory-text-out';
  const showBox = isNameOut || isCelebrate || isOpen || isClose || isVicText || isVicHold || isExpText || isExpHold || isOut;
  if (!showBox) return;

  const boxX = 0;
  const boxY = HUD_BOT_Y;

  // victory-name-out: left box stays with border, monster name fades out
  if (isNameOut) {
    _drawBorderedBox(boxX, boxY, VICTORY_BOX_W, VICTORY_BOX_H);
    const fadeStep = Math.min(Math.floor(battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
    const fadedPal = [0x0F, 0x0F, 0x0F, 0x30];
    for (let s = 0; s < fadeStep; s++) fadedPal[3] = nesColorFade(fadedPal[3]);
    // Draw fading enemy name
    let enemyName;
    if (isRandomEncounter && encounterMonsters) {
      enemyName = BATTLE_GOBLIN_NAME;
    } else {
      enemyName = BATTLE_BOSS_NAME;
    }
    const nameTw = measureText(enemyName);
    const nameX = Math.floor((VICTORY_BOX_W - nameTw) / 2);
    const nameY = boxY + Math.floor((VICTORY_BOX_H - 8) / 2);
    drawText(ctx, nameX, nameY, enemyName, fadedPal);
    return;
  }

  // victory-celebrate: left area empty (cleared by drawBattleMenu)
  if (isCelebrate) return;

  // Row-by-row expand / close
  let drawH = VICTORY_BOX_H;
  if (isOpen) {
    const rows = Math.min(Math.floor(battleTimer / VICTORY_ROW_FRAME_MS) + 1, VICTORY_BOX_ROWS);
    drawH = rows * 8;
  } else if (isClose) {
    const rows = VICTORY_BOX_ROWS - Math.min(Math.floor(battleTimer / VICTORY_ROW_FRAME_MS), VICTORY_BOX_ROWS);
    drawH = Math.max(8, rows * 8);
  }
  _drawBorderedBox(boxX, boxY, VICTORY_BOX_W, drawH);

  if (isOpen || isClose) return;

  // Determine which message to show
  const showExp = isExpText || isExpHold || isOut;

  let fadeStep = 0;
  if (isVicText || isExpText) {
    fadeStep = BATTLE_TEXT_STEPS - Math.min(Math.floor(battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
  } else if (isOut) {
    fadeStep = Math.min(Math.floor(battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
  }
  const fadedPal = [0x0F, 0x0F, 0x0F, 0x30];
  for (let s = 0; s < fadeStep; s++) fadedPal[3] = nesColorFade(fadedPal[3]);

  if (!showExp) {
    // "Victory!" centered in box
    const tw = measureText(BATTLE_VICTORY);
    drawText(ctx, boxX + Math.floor((VICTORY_BOX_W - tw) / 2), boxY + Math.floor((VICTORY_BOX_H - 8) / 2), BATTLE_VICTORY, fadedPal);
  } else {
    // "Got N EXP!" and optional "Level Up!"
    const expText = makeExpText(encounterExpGained);
    const lines = leveledUp ? 2 : 1;
    const blockH = lines * 10;
    const startY = boxY + Math.floor((VICTORY_BOX_H - blockH) / 2);
    const tw2 = measureText(expText);
    drawText(ctx, boxX + Math.floor((VICTORY_BOX_W - tw2) / 2), startY, expText, fadedPal);
    if (leveledUp) {
      const tw3 = measureText(BATTLE_LEVEL_UP);
      drawText(ctx, boxX + Math.floor((VICTORY_BOX_W - tw3) / 2), startY + 10, BATTLE_LEVEL_UP, fadedPal);
    }
  }
}

function _dmgBounceY(baseY, timer) {
  // Authentic NES bounce from FCEUX trace — 26 keyframes at 60fps
  const frame = Math.min(Math.floor(timer / DMG_BOUNCE_FRAME_MS), DMG_BOUNCE_TABLE.length - 1);
  return baseY + DMG_BOUNCE_TABLE[frame];
}

function drawDamageNumbers() {
  // Boss/monster damage number — bounces centered on the target
  if (bossDamageNum && !bossDefeated) {
    let bx, baseY;
    if (isRandomEncounter && encounterMonsters) {
      // Center on targeted monster in encounter grid
      const count = encounterMonsters.length;
      const fullW = count === 1 ? 64 : 96;
      const fullH = count <= 2 ? 64 : 96;
      const boxX = HUD_VIEW_X + Math.floor((HUD_VIEW_W - fullW) / 2);
      const boxY = HUD_VIEW_Y + Math.floor((HUD_VIEW_H - fullH) / 2);
      const gridPos = _encounterGridPos(boxX, boxY, fullW, fullH, count);
      const pos = gridPos[targetIndex] || gridPos[0];
      bx = pos.x + 8; // center of 32px sprite
      baseY = pos.y + 8;
    } else {
      // Center on boss sprite
      bx = HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2) - 4;
      baseY = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2) - 8;
    }
    const by = _dmgBounceY(baseY, bossDamageNum.timer);

    ctx.save();
    ctx.beginPath();
    ctx.rect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);
    ctx.clip();
    if (bossDamageNum.miss) {
      drawText(ctx, bx - 8, by, BATTLE_MISS, [0x0F, 0x0F, 0x0F, 0x2B]);
    } else {
      const digits = String(bossDamageNum.value);
      const numBytes = new Uint8Array(digits.length);
      for (let i = 0; i < digits.length; i++) numBytes[i] = 0x80 + parseInt(digits[i]);
      const tw = digits.length * 8;
      drawText(ctx, bx - Math.floor(tw / 2), by, numBytes, DMG_NUM_PAL);
    }
    ctx.restore();
  }

  // Player damage number — bounces centered on portrait
  if (playerDamageNum) {
    const px = HUD_RIGHT_X + 16; // center of 16×16 portrait
    const baseY = HUD_VIEW_Y + 16;
    const py = _dmgBounceY(baseY, playerDamageNum.timer);

    if (playerDamageNum.miss) {
      drawText(ctx, px - 8, py, BATTLE_MISS, [0x0F, 0x0F, 0x0F, 0x2B]);
    } else {
      const digits = String(playerDamageNum.value);
      const numBytes = new Uint8Array(digits.length);
      for (let i = 0; i < digits.length; i++) numBytes[i] = 0x80 + parseInt(digits[i]);
      const tw = digits.length * 8;
      drawText(ctx, px - Math.floor(tw / 2), py, numBytes, DMG_NUM_PAL);
    }
  }
}

function gameLoop(timestamp) {
  const dt = timestamp - lastTime;
  lastTime = timestamp;

  // Title screen — runs before game starts
  if (titleState !== 'done') {
    updateTitle(dt);
    drawTitle();    // viewport: water + text
    drawHUD();      // HUD border (returns early, skips top box content)
    drawTitleSkyInHUD(); // sky BG in top box, drawn after HUD border
    drawPlayerSelect();  // player select in right panel
    requestAnimationFrame(gameLoop);
    return;
  }

  // Tick HUD info fade-in
  if (hudInfoFadeTimer < HUD_INFO_FADE_STEPS * HUD_INFO_FADE_STEP_MS) {
    hudInfoFadeTimer += dt;
  }

  handleInput();
  updatePauseMenu(dt);
  updateBattle(dt);
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

  // Pause menu overlays everything
  drawPauseMenu();

  // Battle UI overlays everything
  drawBattle();

  if (jukeboxMode) {
    ctx.font = '8px monospace';
    ctx.fillStyle = '#c8a832';
    ctx.textAlign = 'left';
    ctx.fillText(`JUKEBOX: Song $${jukeboxTrack.toString(16).toUpperCase().padStart(2, '0')} (${jukeboxTrack})  +/- to change`, 4, 12);
  }

  requestAnimationFrame(gameLoop);
}
