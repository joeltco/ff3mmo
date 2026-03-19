// Game Client — canvas rendering, input handling, game loop

import { parseROM } from './rom-parser.js';
import { NES_SYSTEM_PALETTE, decodeTile, decodeTiles } from './tile-decoder.js';
import { Sprite, DIR_DOWN, DIR_UP, DIR_LEFT, DIR_RIGHT } from './sprite.js';
import { loadMap } from './map-loader.js';
import { MapRenderer } from './map-renderer.js';
import { loadWorldMap } from './world-map-loader.js';
import { WorldMapRenderer } from './world-map-renderer.js';
import { generateFloor, clearDungeonCache } from './dungeon-generator.js';
import { initMusic, playTrack, stopMusic, playSFX, stopSFX, TRACKS, SFX,
         initFF1Music, playFF1Track, stopFF1Music, getCurrentTrack, FF1_TRACKS,
         pauseMusic, resumeMusic } from './music.js';
import { applyIPS } from './ips-patcher.js';
import { initTextDecoder, getItemNameClean, getMonsterName } from './text-decoder.js';
import { initFont, drawText, measureText, TEXT_WHITE, TEXT_GREY, TEXT_YELLOW } from './font-renderer.js';
import { MONSTERS } from './data/monsters.js';
import { ITEMS } from './data/items.js';
import { ENCOUNTERS } from './data/encounters.js';

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
        maxHP: playerStats.maxHP, maxMP: playerStats.maxMP,
        weaponR: playerWeaponR, weaponL: playerWeaponL,
            head: playerHead, body: playerBody, arms: playerArms
      } : null),
      inventory: s.inventory || playerInventory
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
            if (Array.isArray(s)) return { name: new Uint8Array(s), level: 1, exp: 0, stats: null, inventory: {} };
            // New format: object with name, level, exp, stats, inventory
            return { name: new Uint8Array(s.name), level: s.level || 1, exp: s.exp || 0, stats: s.stats || null, inventory: s.inventory || {} };
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
let hudFadeCanvases = null;      // [fadeLevel 1..4] faded HUD canvases for game-start fade-in
let titleHudCanvas = null; // title screen HUD — no right boxes, full-width viewport
let titleHudFadeCanvases = null; // [fadeLevel 1..4] faded title HUD canvases for title fades
let borderTileCanvases = null; // [TL, TOP, TR, LEFT, RIGHT, BL, BOT, BR, FILL]
let borderBlueTileCanvases = null; // same but with blue (0x02) background instead of black
let borderFadeSets = null;    // [fadeLevel] → [TL, TOP, TR, LEFT, RIGHT, BL, BOT, BR, FILL]
let cornerMasks = null;       // [TL, TR, BL, BR] 8×8 canvases — black where outside, transparent inside

// Battle sprite — Onion Knight idle frame (16×24, 2×3 tiles)
const BATTLE_SPRITE_ROM = 0x050010;  // Bank 28/$8000 — battle character graphics (disasm 2F/AB3D)
const BATTLE_JOB_SIZE = 0x02A0;      // 672 bytes (42 tiles) per job
let battleSpriteCanvas = null;
let battleSpriteVictoryCanvas = null;
let battleSpriteAttackCanvas = null;   // right-hand attack frame 1 (arm raised)
let battleSpriteAttack2Canvas = null;  // attack frame 2 (arm swung — ROM frame 3)
let battleSpriteAttackLCanvas = null;  // left-hand attack frame 1
let battleSpriteKnifeRCanvas = null;   // R-hand knife front swing (single trace $2B/$2C/$39/$2E)
let battleSpriteKnifeLCanvas = null;   // L-hand knife front swing (single trace $01/$3F/$03/$40)
let battleSpriteKnifeBackCanvas = null;// knife back swing body (dual trace $43/$44/$45/$46)
let battleKnifeBladeCanvas = null;     // knife blade raised 16×16 (h-flipped, back swing)
let battleKnifeBladeSwungCanvas = null;// knife blade swung 16×16 (no flip, forward slash)
let battleDaggerBladeCanvas = null;    // dagger blade raised 16×16 (h-flipped, pal3 $0F/$1B/$2B/$30)
let battleDaggerBladeSwungCanvas = null;// dagger blade swung 16×16
let battleSwordBladeCanvas = null;     // sword blade raised 16×16 (h-flipped, back swing)
let battleSwordBladeSwungCanvas = null;// sword blade swung 16×16 (no flip, forward slash)
let battleSpriteHitCanvas = null;      // taking damage / recoil
let battleSpriteDefendCanvas = null;   // defend pose 16×24 (tiles $43-$48)
let battleSpriteKneelCanvas = null;    // low HP kneel pose 16×16 (PPU $09-$0C)
let sweatFrames = [];                  // 2 × 16×8 canvases (near-fatal dot animation)
let defendSparkleFrames = [];          // 4 × 8×8 canvases ($49-$4C)
let cureSparkleFrames = [];            // 2 × 16×16 canvases (config A/B from $4D/$4E)
let battleFistCanvas = null;           // fist sprite (8x8, same for both hands)
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

// Shared BG palettes for random encounter sprites (from FCEUX PPU dump, $3F00-$3F0F)
const ENC_PAL0 = [0x0F, 0x12, 0x22, 0x3B]; // black, dark-teal, purple, tan
const ENC_PAL1 = [0x0F, 0x15, 0x22, 0x37]; // black, dark-red, purple, orange

// Eye Fang ($02) — PPU tiles $70-$87, 4×6 = 32×48px
const EYE_FANG_TILE_PAL = [0,0,0,0,0,0,0,0, 1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1];
const EYE_FANG_RAW = new Uint8Array([
  0x00,0x0D,0x01,0x00,0x04,0x03,0x00,0x01,0x00,0x0E,0x01,0x00,0x00,0x00,0x00,0x00, // $70
  0x00,0x80,0x71,0x25,0x0B,0xE5,0x3B,0x95,0x00,0x00,0x80,0x38,0x0C,0x06,0x03,0x06, // $71
  0x00,0x70,0x41,0x06,0xDA,0x9C,0x00,0x98,0x00,0x00,0xC0,0x81,0x86,0xC0,0x80,0x00, // $72
  0x00,0x67,0x84,0x84,0x02,0x02,0x02,0x02,0x00,0x00,0x00,0x80,0x00,0x00,0x00,0x00, // $73
  0x00,0x00,0x00,0x00,0x00,0x00,0x05,0x04,0x01,0x00,0x00,0x00,0x00,0x03,0x06,0x0E, // $74
  0x06,0x08,0x1C,0x18,0xE0,0xA0,0x80,0x00,0x00,0x04,0x10,0x32,0x90,0xC0,0x00,0x00, // $75
  0xFC,0x62,0x13,0x01,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x10,0x00,0x00,0x00,0x00, // $76
  0x1C,0x30,0x24,0xEC,0xD0,0x10,0x00,0x00,0x00,0x00,0x00,0x00,0x04,0x00,0x00,0x00, // $77
  0x14,0x10,0x30,0x18,0x00,0x34,0x12,0x1F,0x08,0x0C,0x08,0x20,0x38,0x08,0x0C,0x00, // $78
  0x00,0x00,0x00,0x00,0x01,0x01,0x00,0x85,0x00,0x01,0x01,0x02,0x0D,0x1D,0x1A,0x34, // $79
  0x00,0x06,0x62,0x1A,0x3D,0xBC,0x7B,0x19,0x38,0xD6,0x62,0x80,0x01,0x80,0x03,0x01, // $7A
  0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, // $7B
  0x0F,0x00,0x04,0x02,0x09,0x15,0x0A,0x0D,0x00,0x00,0x03,0x1C,0x11,0x21,0x28,0x2C, // $7C
  0x84,0x00,0x01,0x67,0x2E,0x47,0xE7,0xC9,0x34,0x1B,0x87,0x63,0x25,0x0F,0x0F,0x07, // $7D
  0xC0,0x70,0xF8,0xDC,0xFE,0x42,0xA0,0x40,0x20,0xB9,0xDC,0xFC,0xFE,0xC2,0x9C,0x3E, // $7E
  0x00,0x00,0x40,0x40,0x40,0x9A,0xE8,0xF4,0x00,0x00,0xA0,0x58,0x44,0x18,0x0A,0x02, // $7F
  0x43,0x0F,0x1B,0x27,0x03,0x0D,0x00,0x00,0x20,0x40,0x58,0x40,0x30,0x0C,0x10,0x0B, // $80
  0xE3,0xC5,0xD1,0xB8,0xB2,0x0D,0x0B,0x05,0x07,0x03,0x03,0x01,0x00,0x2C,0x08,0x11, // $81
  0x40,0x40,0x40,0x31,0x00,0xED,0xF8,0x54,0x26,0x26,0x3C,0x88,0x00,0x01,0x00,0x04, // $82
  0xE4,0xD8,0x80,0x68,0x20,0x40,0x00,0xC0,0x02,0x18,0x04,0x60,0x20,0x00,0x00,0x00, // $83
  0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, // $84
  0x93,0x00,0x20,0x28,0x01,0x04,0x00,0x00,0x0B,0x0C,0x03,0x00,0x04,0x04,0x00,0x00, // $85
  0x26,0x60,0x30,0x04,0x90,0x00,0x08,0x80,0x26,0x68,0x80,0x00,0x48,0x88,0x88,0x80, // $86
  0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x80,0x80,0x00,0x00,0x00,0x00,0x00,0x00, // $87
]);

// Blue Wisp ($03) — PPU tiles $C0-$CF, 4×4 = 32×32px, all pal0
const BLUE_WISP_TILE_PAL = [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0];
const BLUE_WISP_RAW = new Uint8Array([
  0x00,0x00,0x00,0x00,0x02,0x01,0x01,0x00,0x00,0x00,0x00,0x00,0x04,0x00,0x00,0x00, // $C0
  0x00,0x10,0x08,0x0C,0x07,0x9F,0xFF,0xFC,0x00,0x10,0x00,0x00,0x00,0x00,0x00,0x03, // $C1
  0x00,0x00,0x18,0x91,0xD0,0xF8,0xFF,0x3F,0x00,0x04,0x00,0x01,0x00,0x00,0x00,0xC1, // $C2
  0x00,0x00,0x00,0xE0,0x1C,0x87,0x0E,0xF0,0x00,0x00,0x00,0xE0,0x1C,0x07,0x0F,0xFE, // $C3
  0x04,0x01,0x0F,0x33,0x43,0x47,0x63,0x3F,0x00,0x00,0x0E,0x38,0x60,0x60,0x71,0x3F, // $C4
  0xF0,0xE0,0xC3,0x8F,0x9F,0x9F,0xF1,0x0F,0x0F,0x1F,0x3F,0x7F,0x7F,0x7F,0xFF,0xFF, // $C5
  0x7F,0x1F,0xC1,0xF1,0xF8,0xF8,0xFC,0xFC,0xBF,0xE0,0xFE,0xFE,0xFF,0xFF,0xFF,0xFF, // $C6
  0x00,0xE0,0xF0,0xE0,0xF0,0x7C,0x70,0x70,0x00,0x00,0x00,0x00,0x02,0x80,0x80,0x80, // $C7
  0x1F,0x0F,0x07,0x3B,0x03,0x03,0x09,0x1F,0x1C,0x00,0x00,0x00,0x40,0x00,0x08,0x1F, // $C8
  0x7F,0x7F,0x1F,0x1F,0x8F,0xC3,0xF0,0xF0,0xBF,0xBF,0xFF,0xFF,0x7F,0x3F,0xFF,0x0F, // $C9
  0xFC,0xFC,0xF8,0xF9,0xF1,0xC3,0x0F,0x7F,0xFF,0xFF,0xFF,0xFE,0xFE,0xFC,0xF0,0x87, // $CA
  0x60,0xF0,0xEC,0xE0,0xFC,0xCE,0xE4,0x86,0x80,0x00,0x00,0x60,0x1C,0x0E,0x04,0x86, // $CB
  0x0C,0x00,0x01,0x00,0x00,0x00,0x00,0x00,0x0E,0x00,0x00,0x00,0x00,0x00,0x00,0x00, // $CC
  0xFC,0xBF,0x17,0x41,0x20,0x1F,0x00,0x00,0x03,0x00,0x00,0x40,0x60,0x3F,0x01,0x00, // $CD
  0xF8,0xFC,0xF7,0x81,0x00,0x80,0x7C,0x04,0x7F,0x00,0x00,0x00,0x00,0x80,0xFC,0x1E, // $CE
  0xFE,0x3C,0x00,0x00,0x00,0x00,0x00,0x00,0xFE,0x7E,0x3C,0x00,0x00,0x00,0x00,0x00, // $CF
]);

// Carbuncle ($01) — PPU tiles $E4-$F3, 4×4 = 32×32px, mixed pal
const CARBUNCLE_TILE_PAL = [0,0,0,0, 0,0,0,0, 0,0,1,1, 0,0,1,1];
const CARBUNCLE_RAW = new Uint8Array([
  0x00,0x00,0x00,0x00,0x00,0x01,0x01,0x05,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, // $E4
  0x00,0x3F,0x47,0x02,0x02,0x12,0x9D,0xB9,0x00,0x00,0x38,0xFC,0xFC,0xEC,0x61,0x41, // $E5
  0x00,0x00,0x18,0xBF,0xFE,0x43,0x03,0x41,0x00,0x00,0x00,0x80,0x81,0x3C,0x7C,0x3E, // $E6
  0x00,0x00,0x00,0x00,0x80,0x80,0x80,0x40,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x40, // $E7
  0x06,0x09,0x19,0x10,0x10,0x10,0x30,0x3C,0x00,0x06,0x06,0x0F,0x0F,0x0F,0x0F,0x03, // $E8
  0x36,0xC9,0xF1,0x71,0x20,0xC0,0x26,0xA9,0x06,0x08,0x06,0x86,0xCF,0x0F,0xA8,0x21, // $E9
  0x41,0xAF,0xD8,0xE7,0x65,0x10,0x30,0xCC,0x3E,0x10,0x00,0x00,0x86,0xD7,0x37,0xCF, // $EA
  0x40,0xA0,0x20,0xC0,0xE0,0x18,0x18,0x08,0x40,0x20,0x20,0x00,0x00,0xE0,0xE0,0xF0, // $EB
  0x18,0x03,0x34,0x2B,0x4B,0x51,0x41,0x61,0x00,0x03,0x04,0x08,0x28,0x26,0x3E,0x1E, // $EC
  0x46,0x98,0x20,0x70,0xA0,0xB0,0xB0,0x50,0x46,0x99,0x07,0x0F,0x1F,0x0F,0x0F,0x4F, // $ED
  0x00,0x00,0x00,0x00,0x00,0x03,0x07,0x0C,0x67,0x3B,0xBB,0xD9,0xC0,0xE7,0xCF,0xDF, // $EE
  0x00,0x00,0x00,0x00,0x00,0x00,0x80,0xC0,0xF8,0xF8,0xF0,0xC0,0x18,0x0C,0x9C,0xCE, // $EF
  0x61,0x32,0x3B,0x00,0x00,0x27,0x70,0x07,0x1E,0x0C,0x03,0x00,0x07,0x3E,0x70,0x06, // $F0
  0x5C,0x0F,0xB0,0x1C,0x03,0xF0,0xDE,0xC3,0x43,0x00,0xB0,0x1F,0x83,0x00,0xE0,0x00, // $F1
  0x08,0x08,0x0C,0x07,0x00,0x00,0x00,0x00,0xDC,0x9C,0x5F,0xCF,0xE7,0x70,0x70,0x1C, // $F2
  0x40,0x40,0xC0,0x80,0x00,0x00,0x00,0x00,0xCE,0xCE,0xCE,0x9C,0x08,0x70,0x18,0x08, // $F3
]);

// Per-monster canvas storage
const monsterBattleCanvas = new Map(); // monsterId → canvas
const monsterWhiteCanvas  = new Map(); // monsterId → white flash canvas
const monsterDeathFrames  = new Map(); // monsterId → death frame array

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
                                 // 'logo-fade-out' | 'select-box-open' | 'select-fade-in' | 'select' |
                                 // 'select-fade-out' | 'select-box-close-fwd' |
                                 // 'select-fade-out-back' | 'select-box-close' | 'logo-fade-in' |
                                 // 'name-entry' | 'main-out' | 'done'
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
let titleUnderwaterFrames = null; // [fade levels] 256×32 underwater battle BG (bgId 18)
let titleUnderwaterScroll = 0;    // horizontal scroll offset for underwater BG
let uwBubbleTiles = null;         // decoded bubble/fish sprite canvases
let uwBubbles = [];               // active bubble sprites [{x, y, tile, timer, speed}]
let uwFish = null;                // active fish sprite {x, y, frame, dir, timer} or null
let uwFishTriggered = false;      // fish starts after 1st message
let titleOceanFrames = null;     // [fade levels] 256×32 ocean battle BG (bgId 5) for viewport top 32px
let titleWaterScroll = 0;        // base scroll offset (parallax multiplied per row)
let titleLogoFrames = null;      // [TITLE_FADE_MAX+1] canvas array — FF3 logo from Sight screen sprite tiles
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

// HUD level ↔ HP cross-fade (0=level fully visible, 4=HP fully visible)
let hudHpLvStep = 0;
let hudHpLvTimer = 0;
const HUD_HPLV_STEP_MS = 60;

// Player stats — initialized from ROM in initPlayerStats()
let playerStats = null;  // { str, agi, vit, int, mnd, hp, maxHP, mp, maxMP, level, exp, expToNext }
let expTable = null;     // Uint32Array(98) — EXP thresholds from ROM
let leveledUp = false;   // set by grantExp() for victory display
let playerHP = 28;   // overwritten by initPlayerStats
let playerMP = 12;
let playerATK = 12;
let playerDEF = 4;
let playerGil = 0;
let playerWeaponR = 0x1E;  // right hand item ID (Knife), 0 = unarmed
let playerWeaponL = 0x00;  // left hand item ID, 0 = unarmed
let playerHead = 0x00;     // helmet item ID, 0 = empty
let playerBody = 0x00;     // body armor item ID, 0 = empty
let playerArms = 0x00;     // bracers item ID, 0 = empty

// Equip slot index mapping: -100=RH, -101=LH, -102=Head, -103=Body, -104=Arms
const EQUIP_SLOT_SUBTYPE = { '-102': 'helmet', '-103': 'body', '-104': 'arms' };

function getEquipSlotId(eqIdx) {
  switch (eqIdx) {
    case -100: return playerWeaponR;
    case -101: return playerWeaponL;
    case -102: return playerHead;
    case -103: return playerBody;
    case -104: return playerArms;
    default: return 0;
  }
}

function setEquipSlotId(eqIdx, id) {
  switch (eqIdx) {
    case -100: playerWeaponR = id; break;
    case -101: playerWeaponL = id; break;
    case -102: playerHead = id; break;
    case -103: playerBody = id; break;
    case -104: playerArms = id; break;
  }
}

function recalcDEF() {
  const rDef = ITEMS.get(playerWeaponR)?.def || 0;
  const lDef = ITEMS.get(playerWeaponL)?.def || 0;
  playerDEF = (playerStats ? playerStats.vit : 4)
    + rDef + lDef
    + (ITEMS.get(playerHead)?.def || 0)
    + (ITEMS.get(playerBody)?.def || 0)
    + (ITEMS.get(playerArms)?.def || 0);
}

function isHandEquippable(itemData) {
  return itemData && (itemData.type === 'weapon' || (itemData.type === 'armor' && itemData.subtype === 'shield'));
}
function isWeapon(id) {
  if (!id) return false;
  const item = ITEMS.get(id);
  return item && item.type === 'weapon';
}
function weaponSubtype(id) {
  if (!id) return null;
  const item = ITEMS.get(id);
  return (item && item.type === 'weapon') ? item.subtype : null;
}
function isBladedWeapon(id) {
  const st = weaponSubtype(id);
  return st === 'knife' || st === 'dagger' || st === 'sword';
}
function getSlashFramesForWeapon(id, rightHand) {
  const st = weaponSubtype(id);
  if (st === 'knife' || st === 'dagger') return rightHand ? knifeSlashFramesR : knifeSlashFramesL;
  if (st === 'sword') return rightHand ? swordSlashFramesR : swordSlashFramesL;
  return rightHand ? slashFramesR : slashFramesL; // punch
}
// Get the weapon ID for a given hit index (shields are not weapons)
function getHitWeapon(hitIdx) {
  const rW = isWeapon(playerWeaponR);
  const lW = isWeapon(playerWeaponL);
  if (rW && lW) return (hitIdx % 2 === 0) ? playerWeaponR : playerWeaponL;
  if (rW) return playerWeaponR;
  if (lW) return playerWeaponL;
  return 0; // unarmed
}
function isHitRightHand(hitIdx) {
  const rW = isWeapon(playerWeaponR);
  const lW = isWeapon(playerWeaponL);
  if (rW && lW) return hitIdx % 2 === 0;
  return rW; // single weapon hand, or unarmed defaults to R
}

// Inventory system
let playerInventory = {};    // { itemId: count } — e.g. { 0xA6: 3 }
let itemSelectList = [];     // [{id, count}] built when entering item-select
let itemSelectCursor = 0;    // cursor index in item list
let itemHealAmount = 0;      // actual HP restored (for green number display)
let playerHealNum = null;    // {value, timer} — green heal number on portrait
let enemyHealNum = null;     // {value, timer, index} — green heal number on enemy
let itemHeldIdx = -1;        // global index of held item (-1 = none), -100/-101 = equip R/L
let itemPage = 0;            // current page: 0=equip, 1+=inventory pages
let itemPageCursor = 0;      // cursor row within current page (0 to INV_SLOTS-1 or 0-1 for equip)
let itemSlideDir = 0;        // -1 = sliding left (page++), +1 = sliding right (page--)
let itemSlideCursor = 0;     // cursor row to set after slide completes
let itemTargetType = 'player'; // 'player' or 'enemy' — who to use item on
let itemTargetIndex = 0;       // which enemy index (for enemy target)
let itemTargetAllyIndex = -1;  // -1 = player, 0+ = ally index (when itemTargetType === 'player')
let itemTargetMode = 'single'; // 'single' | 'all' | 'col-left' | 'col-right' — for battle_items
let southWindTargets = [];     // ordered list of enemy indices to hit
let southWindHitIdx = 0;       // current target being hit
let southWindHitCanvas = null; // unused - kept for compat
let swPhaseCanvases = [];      // 3-phase expanding ice explosion [16×16, 32×32, 48×48]
let southWindDmgNums = {};     // {enemyIdx: {value, timer}} — damage numbers during sw-hit

// Inventory helpers
const INV_SLOTS = 3; // visible inventory rows per page
function addItem(id, count) {
  playerInventory[id] = (playerInventory[id] || 0) + count;
}
function removeItem(id) {
  if (playerInventory[id] > 0) playerInventory[id]--;
  if (playerInventory[id] <= 0) delete playerInventory[id];
}
function buildItemSelectList() {
  const entries = Object.entries(playerInventory).filter(([,c]) => c > 0);
  const list = entries.map(([id, count]) => ({ id: Number(id), count }));
  while (list.length < INV_SLOTS) list.push(null);
  return list;
}

// Boss fight state
let bossHP = 111;
const BOSS_ATK = 8, BOSS_DEF = 6, BOSS_MAX_HP = 111;

let battleState = 'none';
let battleTimer = 0;
let sfxCutTimerId = null;    // tracked setTimeout for knife SFX cut — prevents stacking
let battleCursor = 0;        // 0=Fight,1=Magic,2=Item,3=Run
let targetIndex = 0;         // which monster is targeted in target-select
let battleMessage = null;     // Uint8Array for status messages
let bossDamageNum = null;     // {value, timer}
let playerDamageNum = null;   // {value, timer}
let bossFlashTimer = 0;
let battleShakeTimer = 0;
let bossDefeated = false;
let isDefending = false;
let runSlideBack = false;

// Random encounter state
let encounterSteps = 0;
let isRandomEncounter = false;
let encounterMonsters = null;  // [{ hp, maxHP, atk, def, exp }] — array of enemies
let encounterExpGained = 0;
let encounterGilGained = 0;
let encounterDropItem = null;  // item id dropped on victory (or null)
let preBattleTrack = null;
let turnQueue = [];              // [{type:'player'|'enemy', index}] sorted by priority
let playerActionPending = null;  // {command:'fight'|'defend', targetIndex, hitResults, ...}
let currentAttacker = -1;      // index of monster currently attacking
let dyingMonsterIndices = new Map(); // index → startDelayMs for staggered death wipe

// Hit animation state
let hitResults = [];               // [{damage, crit}, {miss:true}, ...] pre-calculated per attack
let currentHitIdx = 0;             // which hit we're animating
let slashFrame = 0;                // current slash animation frame (0-3)
let slashX = 0, slashY = 0;       // slash effect base position (target center)
let slashOffX = 0, slashOffY = 0; // random offset per frame (punch scatter)
let slashFramesR = null;           // right-hand punch frames (frame $12, 4 effect sets)
let slashFramesL = null;           // left-hand punch frames (frame $13, 4 effect sets)
let slashFrames = null;            // alias — points to R or L based on current hit
let critFlashTimer = -1;           // >=0 while crit backdrop flash is active (1 frame = 16ms)
let knifeSlashFramesR = null;      // knife diagonal slash frames (right hand)
let knifeSlashFramesL = null;      // knife diagonal slash frames (left hand)
let swordSlashFramesR = null;      // sword diagonal slash frames (right hand)
let swordSlashFramesL = null;      // sword diagonal slash frames (left hand)
const BATTLE_MISS = new Uint8Array([0x96, 0xD2, 0xDC, 0xDC]); // "Miss" in ROM encoding
const BATTLE_GAME_OVER = new Uint8Array([0x90,0xCA,0xD6,0xCE,0xFF,0x98,0xDF,0xCE,0xDB]); // "Game Over"

// Battle timing constants
const BATTLE_SCROLL_MS = 150;
const BATTLE_TEXT_STEP_MS = 50;
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
const DEFEND_SPARKLE_FRAME_MS = 133;     // 8 NES frames per tile
const DEFEND_SPARKLE_TOTAL_MS = 533;     // 4 tiles × 133ms
const DEFEND_SPARKLE_PAL = [0x0F, 0x1B, 0x2B, 0x30];
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
const PLAYER_DMG_SHOW_MS = 700;         // pause after final hit before enemy counter/death
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
                               // |'inv-text-out'|'inv-expand'|'inv-items-in'|'inventory'
                               // |'inv-items-out'|'inv-shrink'|'inv-text-in'
                               // |'eq-text-out'|'eq-expand'|'eq-slots-in'|'equip'
                               // |'eq-items-in'|'eq-item-select'|'eq-items-out'
                               // |'eq-slots-out'|'eq-shrink'|'eq-text-in'
let pauseTimer = 0;
let pauseCursor = 0;           // 0-5
let pauseInvScroll = 0;        // scroll offset for inventory list
let pauseHeldItem = -1;        // index into inventory entries of held item (-1 = none)
let pauseHealNum = null;       // {value, timer} — green heal number during pause item use
let pauseUseItemId = 0;        // item ID stashed between target-select and use
let pauseInvAllyTarget = -1;   // -1 = player, 0+ = ally index for pause menu item targeting
let eqCursor = 0;              // 0-5: RH, LH, HD, BD, SH, AR
let eqSlotIdx = -100;          // which equip slot we're picking an item for
let eqItemList = [];           // filtered items that fit the selected slot
let eqItemCursor = 0;          // cursor in eqItemList
const PAUSE_EXPAND_MS = 150;   // border expand/shrink duration
let prePauseTrack = -1;        // FF3 track playing before pause opened
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

// --- Fake players (MMO roster) ---
// All locations players can be in
const LOCATIONS = ['world', 'ur', 'cave-0', 'cave-1', 'cave-2', 'cave-3', 'crystal'];
// Full player pool — each has a current location, moves around over time
const PLAYER_POOL = [
  { name: 'Zephyr',  level: 5,  palIdx: 1, camper: false, loc: 'ur' },
  { name: 'Mira',    level: 4,  palIdx: 2, camper: false, loc: 'world' },
  { name: 'Aldric',  level: 5,  palIdx: 3, camper: true,  loc: 'ur' },
  { name: 'Suki',    level: 3,  palIdx: 4, camper: false, loc: 'cave-0' },
  { name: 'Fenris',  level: 5,  palIdx: 5, camper: false, loc: 'cave-1' },
  { name: 'Lenna',   level: 5,  palIdx: 6, camper: true,  loc: 'ur' },
  { name: 'Grok',    level: 5,  palIdx: 7, camper: false, loc: 'cave-3' },
  { name: 'Ivy',     level: 2,  palIdx: 0, camper: false, loc: 'ur' },
  { name: 'Rook',    level: 5,  palIdx: 3, camper: false, loc: 'cave-2' },
  { name: 'Tora',    level: 5,  palIdx: 5, camper: false, loc: 'world' },
  { name: 'Blix',    level: 4,  palIdx: 7, camper: false, loc: 'cave-0' },
  { name: 'Cassia',  level: 5,  palIdx: 6, camper: true,  loc: 'cave-1' },
  { name: 'Duran',   level: 5,  palIdx: 1, camper: false, loc: 'crystal' },
  { name: 'Nyx',     level: 1,  palIdx: 4, camper: false, loc: 'ur' },
  { name: 'Orin',    level: 4,  palIdx: 0, camper: false, loc: 'world' },
  { name: 'Pip',     level: 3,  palIdx: 2, camper: false, loc: 'cave-0' },
  { name: 'Vex',     level: 5,  palIdx: 7, camper: false, loc: 'cave-2' },
  { name: 'Wren',    level: 4,  palIdx: 5, camper: false, loc: 'world' },
];

// --- Chat system ---
const CHAT_LINE_H = 9;          // 8px font + 1px gap
const CHAT_VISIBLE = 5;         // max lines shown when collapsed
const CHAT_HISTORY = 30;        // total messages kept in buffer
const CHAT_EXPAND_MS = 650;     // expand/collapse duration — tuned to match SCREEN_OPEN/CLOSE SFX
const CHAT_AUTO_MIN_MS = 5000;
const CHAT_AUTO_MAX_MS = 16000;
const CHAT_PHRASES = [
  'anyone near floor 3?',
  'need heals',
  'good luck!',
  'watch out for traps',
  'lfg crystal room',
  'found a chest!!',
  'that boss hits hard',
  'anyone selling armor?',
  'longsword on floor 3',
  'stay together',
  'almost to the boss',
  'gg everyone',
  'which floor is this?',
  'low hp, retreating',
  'nice one!',
  'any potions?',
  'boss incoming',
  'clear!',
  'level up!',
  'this dungeon is wild',
];

function getPlayerLocation() {
  if (onWorldMap) return 'world';
  if (currentMapId === 114) return 'ur';
  if (currentMapId === 1004) return 'crystal';
  if (currentMapId >= 1000 && currentMapId < 1004) return 'cave-' + (currentMapId - 1000);
  return 'ur'; // fallback
}

function getRosterPlayers() {
  const loc = getPlayerLocation();
  return PLAYER_POOL.filter(p => p.loc === loc);
}

// Generate combat stats for a roster ally based on their level and location
function generateAllyStats(player) {
  const lv = player.level;
  const str = 5 + lv;
  const agi = 5 + lv;
  const vit = 5 + lv;
  const hp = 28 + lv * 6;
  const loc = player.loc;
  // Gear by location (matches chest loot tiers)
  let weaponId = 0x1E, weaponAtk = 6, totalDef = 1; // default: Knife + Cap
  if (loc === 'cave-1') { weaponId = 0x1F; weaponAtk = 8; totalDef = 3; } // Dagger + Shield
  else if (loc === 'cave-2') { weaponId = 0x24; weaponAtk = 10; totalDef = 3; } // Longsword + LeatherArmor + Bracers
  else if (loc === 'cave-3' || loc === 'crystal') { weaponId = 0x24; weaponAtk = 10; totalDef = 7; } // Longsword + full armor
  const atk = str + weaponAtk;
  const def = vit + totalDef;
  return { name: player.name, palIdx: player.palIdx, level: lv, hp, maxHP: hp, atk, def, agi, weaponId, fadeStep: ROSTER_FADE_STEPS };
}
// Palette variants — only color 3 changes (original $16 = red outfit)
// Colors 0=$0F, 1=$36 (skin), 2=$30 (white) stay the same
const PLAYER_PALETTES = [
  [0x0F, 0x36, 0x30, 0x16], // original red
  [0x0F, 0x36, 0x30, 0x12], // blue
  [0x0F, 0x36, 0x30, 0x1A], // green
  [0x0F, 0x36, 0x30, 0x14], // purple
  [0x0F, 0x36, 0x30, 0x18], // yellow
  [0x0F, 0x36, 0x30, 0x11], // cyan
  [0x0F, 0x36, 0x30, 0x17], // orange
  [0x0F, 0x36, 0x30, 0x15], // pink
];
let fakePlayerPortraits = [];   // HTMLCanvasElement[palIdx][fadeStep]
let fakePlayerVictoryPortraits = [];  // HTMLCanvasElement[palIdx][fadeStep] — victory pose
let fakePlayerHitPortraits = [];      // hit/recoil pose
let fakePlayerDefendPortraits = [];   // defend pose
let fakePlayerKneelPortraits = [];    // near-fatal kneel pose
let fakePlayerAttackPortraits = [];   // attack pose (right-hand arm raised)
let rosterTimer = 0;             // ms until next movement event
const ROSTER_FADE_STEPS = 4;
const ROSTER_FADE_STEP_MS = 100;
let rosterFadeMap = {};          // {playerName: fadeStep} — 0=visible, 4=black
let rosterFadeTimers = {};       // {playerName: ms since last step}
let rosterFadeDir = {};          // {playerName: 'in'|'out'}
let rosterSlideY = {};           // {playerName: px offset} — animates toward 0
let rosterPrevLoc = null;        // last known player location
let rosterLocChanged = false;    // true when transition involves a location change
let rosterArrivalOrder = [];     // names in arrival order (most recent first)
const ROSTER_SLIDE_SPEED = 0.15; // px per ms
let chatMessages = [];       // [{text, type, timer}] type: 'chat'|'system'
let chatAutoTimer = 8000;    // ms until first auto message
let chatFontReady = false;
let chatInputActive = false; // t key opens chat input
let chatInputText = '';
let chatCursorTimer = 0;     // ms, blinks every 500ms
let chatExpanded = false;    // T (shift) toggles expanded chat view
let chatExpandAnim = 0;      // 0=collapsed, 1=expanded (animated)

let rosterBattleFade = 0;        // 0=visible, ROSTER_FADE_STEPS=black
let rosterBattleFadeTimer = 0;
let rosterBattleFading = 'none'; // 'none'|'out'|'in'

// Battle allies — roster players that join combat
let battleAllies = [];         // [{name, palIdx, level, hp, maxHP, atk, def, agi, fadeStep}]
let allyJoinTimer = 0;         // ms until next join check
let allyJoinRound = 0;         // combat round counter
let currentAllyAttacker = -1;  // index into battleAllies during ally turn
let allyTargetIndex = -1;      // which enemy the ally is attacking
let allyHitResult = null;      // single hit result {damage, crit} or {miss}
let allyDamageNums = {};       // {allyIdx: {value, timer, crit} or {miss, timer}}
let allyShakeTimer = {};       // {allyIdx: ms remaining}
let enemyTargetAllyIdx = -1;   // which ally an enemy is targeting (-1 = player)
let allyExitTimer = 0;         // ms since victory-celebrate started (for ally exit fade)
let turnTimer = 0;             // ms elapsed while player is deciding; auto-skip at TURN_TIME_MS
const TURN_TIME_MS = 10000;    // 10 seconds to act before turn is skipped
let rosterState = 'none';       // 'none'|'browse'|'menu-in'|'menu'|'menu-out'
let rosterCursor = 0;           // index into getRosterVisible()
let rosterScroll = 0;           // scroll offset
let rosterMenuCursor = 0;       // cursor in context menu
let rosterMenuTimer = 0;
const ROSTER_MENU_ITEMS = ['Party', 'Duel', 'Trade', 'Message', 'Inspect'];
const ROSTER_ROW_H = 32;        // pixels per roster row (matches HUD box height)
const ROSTER_VISIBLE = 3;       // max visible rows in panel (3×32=96px, 16px for scroll)
const ROSTER_TRI_H = 0;         // no top padding — scroll triangles go in bottom gap

// Chest message box state (same style as roar box)
// Universal message box — slide-in, instant text, Z dismiss, slide-out
let msgBoxState = 'none';      // 'slide-in'|'hold'|'slide-out'|'none'
let msgBoxTimer = 0;
let msgBoxBytes = null;        // Uint8Array text to display
let msgBoxOnClose = null;      // callback after slide-out completes

// Battle text byte arrays
const BATTLE_ROAR = new Uint8Array([0x9B,0x98,0x98,0x98,0x98,0x98,0x8A,0x9B,0xC4,0xC4]); // "ROOOOOAR!!"
const BATTLE_FIGHT = new Uint8Array([0x8F,0xD2,0xD0,0xD1,0xDD]); // "Fight"
const BATTLE_RUN = new Uint8Array([0x9B,0xDE,0xD7]); // "Run"
const BATTLE_CANT_ESCAPE = new Uint8Array([0x8C,0xCA,0xD7,0xDD,0xFF,0xCE,0xDC,0xCC,0xCA,0xD9,0xCE,0xC4]); // "Cant escape!"
const BATTLE_RAN_AWAY = new Uint8Array([0x9B,0xCA,0xD7,0xFF,0xCA,0xE0,0xCA,0xE2,0xC4,0xC4,0xC4]); // "Ran away..."
const BATTLE_DEFEND = new Uint8Array([0x8D,0xCE,0xCF,0xCE,0xD7,0xCD]); // "Defend"
const BATTLE_VICTORY = new Uint8Array([0x9F,0xD2,0xCC,0xDD,0xD8,0xDB,0xE2,0xC4]); // "Victory!"
const BATTLE_GOT_EXP = new Uint8Array([0x90,0xD8,0xDD,0xFF,0x82,0x80,0xFF,0x8E,0xA1,0x99,0xC4]); // "Got 20 EXP!"
const BATTLE_LEVEL_UP = new Uint8Array([0x95,0xCE,0xDF,0xCE,0xD5,0xFF,0x9E,0xD9,0xC4]); // "Level Up!"
const BATTLE_BOSS_NAME = new Uint8Array([0x95,0xCA,0xD7,0xCD,0xFF,0x9D,0xDE,0xDB,0xDD,0xD5,0xCE]); // "Land Turtle"
const BATTLE_GOBLIN_NAME = new Uint8Array([0x90,0xD8,0xCB,0xD5,0xD2,0xD7]); // "Goblin"
const BATTLE_MENU_ITEMS = [BATTLE_FIGHT, BATTLE_DEFEND, PAUSE_ITEMS[0]/*Item*/, BATTLE_RUN];

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
    // Chat input mode — capture all keys
    if (chatInputActive) {
      e.preventDefault();
      if (e.key === 'Enter') {
        if (chatInputText.length > 0) {
          const slot = saveSlots[selectCursor];
          const senderName = (slot && slot.name) ? _nesNameToString(slot.name) : 'You';
          addChatMessage(senderName + ': ' + chatInputText, 'chat');
        }
        chatInputActive = false;
        chatInputText = '';
      } else if (e.key === 'Escape') {
        chatInputActive = false;
        chatInputText = '';
      } else if (e.key === 'Backspace') {
        chatInputText = chatInputText.slice(0, -1);
      } else if (e.key.length === 1 && chatInputText.length < 42) {
        chatInputText += e.key;
      }
      return;
    }
    // Name entry mode — capture all keys, block game controls
    if (titleState === 'name-entry') {
      e.preventDefault();
      if (e.key === 'Enter' && nameBuffer.length > 0) {
        saveSlots[selectCursor] = { name: new Uint8Array(nameBuffer), level: 1, exp: 0, stats: null, inventory: {} };
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
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'z', 'Z', 'x', 'X', 'Enter', 's', 'S'].includes(e.key)) {
      e.preventDefault();
      keys[e.key] = true;
    }
    if (e.key === 'T' && titleState === 'done' && battleState === 'none' &&
        pauseState === 'none' && rosterState === 'none' && transState !== 'loading' && msgBoxState === 'none' && !chatInputActive) {
      e.preventDefault();
      chatExpanded = !chatExpanded;
      playSFX(chatExpanded ? SFX.SCREEN_OPEN : SFX.SCREEN_CLOSE);
    }
    if (e.key === 't' && titleState === 'done' && battleState === 'none' &&
        pauseState === 'none' && rosterState === 'none' && transState !== 'loading' && msgBoxState === 'none') {
      e.preventDefault();
      chatInputActive = true;
      chatInputText = '';
      chatCursorTimer = 0;
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

  // Corner masks for rounding battle BG edges — black where outside, transparent inside
  // TL=0, TR=2, BL=5, BR=7
  cornerMasks = [0, 2, 5, 7].map(idx => {
    const pixels = tiles[idx];
    const c = document.createElement('canvas');
    c.width = 8; c.height = 8;
    const tctx = c.getContext('2d');
    const img = tctx.createImageData(8, 8);
    for (let i = 0; i < 64; i++) {
      if (pixels[i] === 0) {
        // Outside pixel — opaque black mask
        img.data[i * 4 + 3] = 255;
      }
      // else: transparent (default 0 alpha)
    }
    tctx.putImageData(img, 0, 0);
    return c;
  });

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

  // Draw HUD panels (viewport has no fill — game shows through)
  // Top scenery box has NO static border — border drawn dynamically only when text shown
  drawBox(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H, false); // Game viewport (no fill)
  drawBox(HUD_RIGHT_X, HUD_VIEW_Y, 32, 32);                          // Right mini-left (16x16 interior)
  drawBox(HUD_RIGHT_X + 32, HUD_VIEW_Y, HUD_RIGHT_W - 32, 32);      // Right mini-right
  // Right main box omitted — each roster player has its own paired boxes drawn dynamically
  drawBox(0, HUD_BOT_Y, CANVAS_W, HUD_BOT_H);                      // Bottom box

  // Title screen HUD — full-width viewport (no right boxes)
  titleHudCanvas = document.createElement('canvas');
  titleHudCanvas.width = CANVAS_W;
  titleHudCanvas.height = CANVAS_H;
  const thctx = titleHudCanvas.getContext('2d');
  thctx.imageSmoothingEnabled = false;
  function drawBoxT(x, y, w, h, fill = true) {
    const [TL, TOP, TR, LEFT, RIGHT, BL, BOT, BR, FILL] = tileCanvases;
    thctx.drawImage(TL, x, y);
    thctx.drawImage(TR, x + w - 8, y);
    thctx.drawImage(BL, x, y + h - 8);
    thctx.drawImage(BR, x + w - 8, y + h - 8);
    for (let tx = x + 8; tx < x + w - 8; tx += 8)  { thctx.drawImage(TOP, tx, y); thctx.drawImage(BOT, tx, y + h - 8); }
    for (let ty = y + 8; ty < y + h - 8; ty += 8)  { thctx.drawImage(LEFT, x, ty); thctx.drawImage(RIGHT, x + w - 8, ty); }
    if (fill) { for (let ty = y + 8; ty < y + h - 8; ty += 8) for (let tx = x + 8; tx < x + w - 8; tx += 8) thctx.drawImage(FILL, tx, ty); }
  }
  drawBoxT(HUD_VIEW_X, HUD_VIEW_Y, CANVAS_W, HUD_VIEW_H, false); // full-width viewport
  drawBoxT(0, HUD_BOT_Y, CANVAS_W, HUD_BOT_H);                   // bottom box (same)

  // Pre-render faded HUD canvases for NES fade transitions (steps 1-4)
  function buildFadedHUDs(drawFn, boxes) {
    const arr = [];
    for (let step = 1; step <= LOAD_FADE_MAX; step++) {
      const c = document.createElement('canvas');
      c.width = CANVAS_W; c.height = CANVAS_H;
      const fctx = c.getContext('2d');
      fctx.imageSmoothingEnabled = false;
      const fset = borderFadeSets[step];
      const [fTL, fTOP, fTR, fLEFT, fRIGHT, fBL, fBOT, fBR, fFILL] = fset;
      for (const [bx, by, bw, bh, fill] of boxes) {
        fctx.drawImage(fTL, bx, by); fctx.drawImage(fTR, bx + bw - 8, by);
        fctx.drawImage(fBL, bx, by + bh - 8); fctx.drawImage(fBR, bx + bw - 8, by + bh - 8);
        for (let tx = bx + 8; tx < bx + bw - 8; tx += 8) { fctx.drawImage(fTOP, tx, by); fctx.drawImage(fBOT, tx, by + bh - 8); }
        for (let ty = by + 8; ty < by + bh - 8; ty += 8) { fctx.drawImage(fLEFT, bx, ty); fctx.drawImage(fRIGHT, bx + bw - 8, ty); }
        if (fill) { for (let ty = by + 8; ty < by + bh - 8; ty += 8) for (let tx = bx + 8; tx < bx + bw - 8; tx += 8) fctx.drawImage(fFILL, tx, ty); }
      }
      arr.push(c);
    }
    return arr;
  }
  hudFadeCanvases = buildFadedHUDs(null, [
    [HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H, false],
    [HUD_RIGHT_X, HUD_VIEW_Y, 32, 32, true],
    [HUD_RIGHT_X + 32, HUD_VIEW_Y, HUD_RIGHT_W - 32, 32, true],
    // Right main box excluded — player rows are drawn dynamically with individual paired boxes
  ]);
  titleHudFadeCanvases = buildFadedHUDs(null, [
    [HUD_VIEW_X, HUD_VIEW_Y, CANVAS_W, HUD_VIEW_H, false],
  ]);
}

function _renderPortrait(tiles, layout, palette) {
  const c = document.createElement('canvas');
  c.width = 16; c.height = 16;
  const pctx = c.getContext('2d');
  for (let i = 0; i < 4; i++) {
    const img = pctx.createImageData(8, 8);
    const px = tiles[i];
    for (let p = 0; p < 64; p++) {
      const ci = px[p];
      if (ci === 0) { img.data[p * 4 + 3] = 0; }
      else {
        const rgb = NES_SYSTEM_PALETTE[palette[ci]] || [0, 0, 0];
        img.data[p * 4] = rgb[0]; img.data[p * 4 + 1] = rgb[1];
        img.data[p * 4 + 2] = rgb[2]; img.data[p * 4 + 3] = 255;
      }
    }
    pctx.putImageData(img, layout[i][0], layout[i][1]);
  }
  return c;
}

function initFakePlayerPortraits(romData) {
  const tiles = [];
  for (let i = 0; i < 4; i++) {
    tiles.push(decodeTile(romData, BATTLE_SPRITE_ROM + i * 16));
  }
  const layout = [[0,0], [8,0], [0,8], [8,8]];
  // fakePlayerPortraits[palIdx][fadeStep] — fadeStep 0=full, 1-4=faded
  fakePlayerPortraits = PLAYER_PALETTES.map(basePal => {
    const frames = [];
    for (let step = 0; step <= ROSTER_FADE_STEPS; step++) {
      const pal = basePal.slice();
      for (let s = 0; s < step; s++) {
        pal[1] = nesColorFade(pal[1]);
        pal[2] = nesColorFade(pal[2]);
        pal[3] = nesColorFade(pal[3]);
      }
      frames.push(_renderPortrait(tiles, layout, pal));
    }
    return frames;
  });

  // Helper: generate palette-variant portraits for a set of decoded tiles
  function _genPosePortraits(poseTiles) {
    return PLAYER_PALETTES.map(basePal => {
      const frames = [];
      for (let step = 0; step <= ROSTER_FADE_STEPS; step++) {
        const pal = basePal.slice();
        for (let s = 0; s < step; s++) {
          pal[1] = nesColorFade(pal[1]);
          pal[2] = nesColorFade(pal[2]);
          pal[3] = nesColorFade(pal[3]);
        }
        frames.push(_renderPortrait(poseTiles, layout, pal));
      }
      return frames;
    });
  }

  // Victory pose — tiles 24-27 (frame 4)
  const vicTiles = [];
  for (let i = 0; i < 4; i++) vicTiles.push(decodeTile(romData, BATTLE_SPRITE_ROM + (24 + i) * 16));
  fakePlayerVictoryPortraits = _genPosePortraits(vicTiles);

  // Hit/recoil pose — tiles 30-33 (frame 5)
  const hitTiles = [];
  for (let i = 0; i < 4; i++) hitTiles.push(decodeTile(romData, BATTLE_SPRITE_ROM + (30 + i) * 16));
  fakePlayerHitPortraits = _genPosePortraits(hitTiles);

  // Defend pose — top 4 tiles from PPU dump ($43-$46)
  const defTileData = [
    new Uint8Array([0x05,0x0B,0x17,0x03,0x00,0x00,0x0E,0x1F, 0x07,0x0F,0x1F,0x3F,0x43,0x40,0x20,0x00]),
    new Uint8Array([0x00,0x00,0xA0,0xD0,0xE8,0x78,0x10,0x88, 0x2C,0x59,0xBE,0xD6,0xEF,0xFB,0x75,0x1A]),
    new Uint8Array([0x04,0xD6,0xD6,0x3F,0xEF,0xF0,0x63,0x0E, 0x00,0x00,0x00,0x24,0xE4,0xF0,0x6F,0x1F]),
    new Uint8Array([0x90,0x4C,0xCC,0x30,0x7C,0x78,0x30,0x00, 0x32,0x21,0x00,0xB0,0x7C,0x7C,0xB2,0xC2]),
  ];
  const defTiles = defTileData.map(d => decodeTile(d, 0));
  fakePlayerDefendPortraits = _genPosePortraits(defTiles);

  // Attack pose (right-hand) — idle top + ATK_R_39 bottom-left
  const ATK_R_39_DATA = new Uint8Array([0x1F,0x04,0x16,0x16,0x2F,0x7F,0x70,0x26,
                                         0x00,0x00,0x00,0x00,0x30,0x70,0x70,0x3E]);
  const atkTiles = [tiles[0], tiles[1], decodeTile(ATK_R_39_DATA, 0), tiles[3]];
  fakePlayerAttackPortraits = _genPosePortraits(atkTiles);

  // Kneel pose — tiles $09-$0C from PPU dump
  const kneelTileData = [
    new Uint8Array([0x00,0x00,0x00,0x00,0x02,0x05,0x0B,0x00, 0x00,0x00,0x00,0x00,0x03,0x07,0x0F,0x1F]),
    new Uint8Array([0x00,0x00,0x00,0x00,0x80,0xB8,0xDC,0xEE, 0x00,0x00,0x00,0x00,0x9B,0xBE,0xDD,0xEF]),
    new Uint8Array([0x00,0x03,0x07,0x05,0x01,0x01,0x1B,0x3B, 0x20,0x10,0x00,0x00,0x00,0x04,0x00,0x20]),
    new Uint8Array([0x36,0x1A,0xC6,0x20,0x92,0x81,0xDC,0xDE, 0xF6,0x3A,0x16,0x0C,0x0E,0x21,0x04,0x06]),
  ];
  const kneelTiles = kneelTileData.map(d => decodeTile(d, 0));
  fakePlayerKneelPortraits = _genPosePortraits(kneelTiles);
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

  // Helper: decode PPU tile bytes into canvas using palette (composites over existing pixels)
  function drawTileToCanvas(tileBytes, tctx, x, y) {
    const px = decodeTile(tileBytes, 0);
    const tmp = document.createElement('canvas');
    tmp.width = 8;
    tmp.height = 8;
    const tc = tmp.getContext('2d');
    const img = tc.createImageData(8, 8);
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
    tc.putImageData(img, 0, 0);
    tctx.drawImage(tmp, x, y);
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

  // Fist tile $49 (identical for both hands) — 8x8 canvas
  const FIST_TILE = new Uint8Array([0x00,0x00,0x00,0x0C,0x2C,0x4C,0x00,0x00,
                                     0x00,0x00,0x00,0x73,0x53,0x23,0x00,0x00]);
  battleFistCanvas = document.createElement('canvas');
  battleFistCanvas.width = 8;
  battleFistCanvas.height = 8;
  const fctx = battleFistCanvas.getContext('2d');
  drawTileToCanvas(FIST_TILE, fctx, 0, 0);

  // Left-hand punch canvas (mid-L = $3B, mid-R = $3C)
  battleSpriteAttackLCanvas = document.createElement('canvas');
  battleSpriteAttackLCanvas.width = 16;
  battleSpriteAttackLCanvas.height = 16;
  const alctx = battleSpriteAttackLCanvas.getContext('2d');
  alctx.drawImage(battleSpriteCanvas, 0, 0);
  drawTileToCanvas(ATK_L_3B, alctx, 0, 8);
  drawTileToCanvas(ATK_L_3C, alctx, 8, 8);

  // Knife attack body poses — from PPU trace dumps (knife integrated into body tiles)
  // R-hand: tiles $2B/$2C/$39/$2E from knife-trace4.txt
  const KNIFE_R_TILES = [
    new Uint8Array([0x00,0x00,0x0A,0x16,0x2F,0x03,0x00,0x0C, 0x00,0x00,0x0E,0x1E,0x3F,0x7F,0x83,0x40]), // $2B
    new Uint8Array([0x00,0x00,0x00,0xE0,0x70,0xB8,0xD8,0x68, 0x00,0x6C,0x19,0xFE,0x76,0xBB,0xDB,0xED]), // $2C
    new Uint8Array([0x1F,0x04,0x16,0x16,0x2F,0x7F,0x70,0x26, 0x00,0x00,0x00,0x00,0x30,0x70,0x70,0x3E]), // $39
    new Uint8Array([0x18,0x80,0x48,0xCC,0x00,0x00,0x70,0xD8, 0x59,0x32,0x38,0x0C,0xB0,0x78,0x70,0x1C]), // $2E
  ];
  battleSpriteKnifeRCanvas = document.createElement('canvas');
  battleSpriteKnifeRCanvas.width = 16;
  battleSpriteKnifeRCanvas.height = 16;
  const krctx = battleSpriteKnifeRCanvas.getContext('2d');
  for (let i = 0; i < 4; i++) {
    const px = decodeTile(KNIFE_R_TILES[i], 0);
    const kimg = krctx.createImageData(8, 8);
    for (let p = 0; p < 64; p++) {
      const ci = px[p];
      if (ci === 0) { kimg.data[p * 4 + 3] = 0; }
      else {
        const rgb = NES_SYSTEM_PALETTE[palette[ci]] || [0, 0, 0];
        kimg.data[p * 4] = rgb[0]; kimg.data[p * 4 + 1] = rgb[1];
        kimg.data[p * 4 + 2] = rgb[2]; kimg.data[p * 4 + 3] = 255;
      }
    }
    krctx.putImageData(kimg, layout[i][0], layout[i][1]);
  }
  // L-hand: tiles $01/$3F/$03/$40 from knife-trace4.txt PPU
  const KNIFE_L_TILES = [
    new Uint8Array([0x00,0x00,0x0A,0x16,0x2F,0x03,0x00,0x0C, 0x00,0x00,0x0E,0x1E,0x3F,0x7F,0x83,0x40]), // $01
    new Uint8Array([0x00,0x00,0x00,0xE0,0x70,0xB8,0xD8,0x68, 0x00,0x6C,0x19,0xFE,0x76,0xBB,0xDB,0xEC]), // $3F
    new Uint8Array([0x1F,0x04,0x16,0x16,0x0F,0x0F,0x60,0xC6, 0x00,0x00,0x00,0x00,0x50,0xE0,0x60,0x1E]), // $03
    new Uint8Array([0x13,0x87,0x57,0xF8,0x7E,0x3C,0x1C,0x08, 0x50,0x30,0x30,0x38,0xFE,0x7C,0xFE,0xFA]), // $40
  ];
  battleSpriteKnifeLCanvas = document.createElement('canvas');
  battleSpriteKnifeLCanvas.width = 16;
  battleSpriteKnifeLCanvas.height = 16;
  const klctx = battleSpriteKnifeLCanvas.getContext('2d');
  for (let i = 0; i < 4; i++) {
    const px = decodeTile(KNIFE_L_TILES[i], 0);
    const klimg = klctx.createImageData(8, 8);
    for (let p = 0; p < 64; p++) {
      const ci = px[p];
      if (ci === 0) { klimg.data[p * 4 + 3] = 0; }
      else {
        const rgb = NES_SYSTEM_PALETTE[palette[ci]] || [0, 0, 0];
        klimg.data[p * 4] = rgb[0]; klimg.data[p * 4 + 1] = rgb[1];
        klimg.data[p * 4 + 2] = rgb[2]; klimg.data[p * 4 + 3] = 255;
      }
    }
    klctx.putImageData(klimg, layout[i][0], layout[i][1]);
  }

  // Back-swing body pose — dual trace tiles $43/$44/$45/$46 (arm pulled back)
  // Rendered with player palette (same shape, just different palette slot in trace)
  const KNIFE_BACK_TILES = [
    new Uint8Array([0x05,0x0B,0x17,0x03,0x00,0x00,0x0E,0x1F, 0x07,0x0F,0x1F,0x3F,0x43,0x40,0x20,0x00]), // $43
    new Uint8Array([0x00,0x00,0xA0,0xD0,0xE8,0x78,0x10,0x88, 0x2C,0x59,0xBE,0xD6,0xEF,0xFB,0x75,0x1A]), // $44
    new Uint8Array([0x04,0xD6,0xD6,0x3F,0xEF,0xF0,0x63,0x0E, 0x00,0x00,0x00,0x24,0xE4,0xF0,0x6F,0x1F]), // $45
    new Uint8Array([0x90,0x4C,0xCC,0x30,0x7C,0x78,0x30,0x00, 0x32,0x21,0x00,0xB0,0x7C,0x7C,0xB2,0xC2]), // $46
  ];
  battleSpriteKnifeBackCanvas = document.createElement('canvas');
  battleSpriteKnifeBackCanvas.width = 16;
  battleSpriteKnifeBackCanvas.height = 16;
  const kbctx = battleSpriteKnifeBackCanvas.getContext('2d');
  for (let i = 0; i < 4; i++) {
    const px = decodeTile(KNIFE_BACK_TILES[i], 0);
    const kbimg = kbctx.createImageData(8, 8);
    for (let p = 0; p < 64; p++) {
      const ci = px[p];
      if (ci === 0) { kbimg.data[p * 4 + 3] = 0; }
      else {
        const rgb = NES_SYSTEM_PALETTE[palette[ci]] || [0, 0, 0];
        kbimg.data[p * 4] = rgb[0]; kbimg.data[p * 4 + 1] = rgb[1];
        kbimg.data[p * 4 + 2] = rgb[2]; kbimg.data[p * 4 + 3] = 255;
      }
    }
    kbctx.putImageData(kbimg, layout[i][0], layout[i][1]);
  }

  // Knife blade tiles — single trace (knife-trace4.txt) $49/$4A/$4B/$4C
  // Grid: $4A(0,0) $49(8,0) / $4C(0,8) $4B(8,8)
  // Palette 3 from single trace: $0F/$00/$32/$30
  const BLADE_PAL = [0x0F, 0x00, 0x32, 0x30];
  const BLADE_TILES = [
    new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x80]), // $4A
    new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x01, 0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x01]), // $49
    new Uint8Array([0x00,0x80,0x40,0x21,0x11,0x08,0x07,0x1B, 0xC0,0xE0,0x70,0x38,0x1C,0x0E,0x04,0x00]), // $4C
    new Uint8Array([0x01,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x01,0x00,0x00,0x00,0x00,0x00,0x00,0x00]), // $4B
  ];
  const BLADE_POS = [[0,0],[8,0],[0,8],[8,8]];
  // Swung grid order: $49(0,0) $4A(8,0) / $4B(0,8) $4C(8,8) — indices into BLADE_TILES
  const BLADE_SWUNG_ORDER = [1, 0, 3, 2];

  // Raised blade (h-flipped, attr $43) — back swing / windup
  battleKnifeBladeCanvas = document.createElement('canvas');
  battleKnifeBladeCanvas.width = 16;
  battleKnifeBladeCanvas.height = 16;
  const blctx = battleKnifeBladeCanvas.getContext('2d');
  for (let t = 0; t < 4; t++) {
    const bpx = decodeTile(BLADE_TILES[t], 0);
    const blimg = blctx.createImageData(8, 8);
    for (let p = 0; p < 64; p++) {
      const ci = bpx[p];
      if (ci === 0) continue;
      const rgb = NES_SYSTEM_PALETTE[BLADE_PAL[ci]] || [252, 252, 252];
      const row = Math.floor(p / 8), col = p % 8;
      const di = (row * 8 + (7 - col)) * 4; // h-flip
      blimg.data[di] = rgb[0]; blimg.data[di + 1] = rgb[1];
      blimg.data[di + 2] = rgb[2]; blimg.data[di + 3] = 255;
    }
    blctx.putImageData(blimg, BLADE_POS[t][0], BLADE_POS[t][1]);
  }

  // Swung blade (no flip, attr $03) — forward slash / hit
  battleKnifeBladeSwungCanvas = document.createElement('canvas');
  battleKnifeBladeSwungCanvas.width = 16;
  battleKnifeBladeSwungCanvas.height = 16;
  const bsctx = battleKnifeBladeSwungCanvas.getContext('2d');
  for (let t = 0; t < 4; t++) {
    const bpx = decodeTile(BLADE_TILES[BLADE_SWUNG_ORDER[t]], 0);
    const bsimg = bsctx.createImageData(8, 8);
    for (let p = 0; p < 64; p++) {
      const ci = bpx[p];
      if (ci === 0) continue;
      const rgb = NES_SYSTEM_PALETTE[BLADE_PAL[ci]] || [252, 252, 252];
      bsimg.data[p * 4] = rgb[0]; bsimg.data[p * 4 + 1] = rgb[1];
      bsimg.data[p * 4 + 2] = rgb[2]; bsimg.data[p * 4 + 3] = 255;
    }
    bsctx.putImageData(bsimg, BLADE_POS[t][0], BLADE_POS[t][1]);
  }

  // --- Dagger blade sprites (same tiles as knife, pal3 $0F/$1B/$2B/$30 from FCEUX) ---
  const DAGGER_PAL = [0x0F, 0x1B, 0x2B, 0x30];
  battleDaggerBladeCanvas = document.createElement('canvas');
  battleDaggerBladeCanvas.width = 16;
  battleDaggerBladeCanvas.height = 16;
  const dblctx = battleDaggerBladeCanvas.getContext('2d');
  for (let t = 0; t < 4; t++) {
    const bpx = decodeTile(BLADE_TILES[t], 0);
    const dblimg = dblctx.createImageData(8, 8);
    for (let p = 0; p < 64; p++) {
      const ci = bpx[p];
      if (ci === 0) continue;
      const rgb = NES_SYSTEM_PALETTE[DAGGER_PAL[ci]] || [252, 252, 252];
      const row = Math.floor(p / 8), col = p % 8;
      const di = (row * 8 + (7 - col)) * 4; // h-flip
      dblimg.data[di] = rgb[0]; dblimg.data[di + 1] = rgb[1];
      dblimg.data[di + 2] = rgb[2]; dblimg.data[di + 3] = 255;
    }
    dblctx.putImageData(dblimg, BLADE_POS[t][0], BLADE_POS[t][1]);
  }
  battleDaggerBladeSwungCanvas = document.createElement('canvas');
  battleDaggerBladeSwungCanvas.width = 16;
  battleDaggerBladeSwungCanvas.height = 16;
  const dbsctx = battleDaggerBladeSwungCanvas.getContext('2d');
  for (let t = 0; t < 4; t++) {
    const bpx = decodeTile(BLADE_TILES[BLADE_SWUNG_ORDER[t]], 0);
    const dbsimg = dbsctx.createImageData(8, 8);
    for (let p = 0; p < 64; p++) {
      const ci = bpx[p];
      if (ci === 0) continue;
      const rgb = NES_SYSTEM_PALETTE[DAGGER_PAL[ci]] || [252, 252, 252];
      dbsimg.data[p * 4] = rgb[0]; dbsimg.data[p * 4 + 1] = rgb[1];
      dbsimg.data[p * 4 + 2] = rgb[2]; dbsimg.data[p * 4 + 3] = 255;
    }
    dbsctx.putImageData(dbsimg, BLADE_POS[t][0], BLADE_POS[t][1]);
  }

  // --- Sword blade sprites (from FCEUX PPU capture, pal3 $0F/$00/$32/$30) ---
  const SWORD_BLADE_PAL = [0x0F, 0x00, 0x32, 0x30];
  // Grid for raised (h-flipped): $4A(0,0) $49(8,0) / $4C(0,8) $4B(8,8)
  const SWORD_BLADE_TILES = [
    new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x80,0xC0, 0x00,0x00,0x00,0x00,0x00,0x00,0x80,0xC0]), // $4A
    new Uint8Array([0x00,0x70,0x78,0x7C,0x3E,0x1F,0x0D,0x06, 0x00,0x70,0x78,0x7C,0x3E,0x1F,0x0F,0x07]), // $49
    new Uint8Array([0x60,0xB0,0xD9,0x6D,0x33,0x12,0x0D,0x3B, 0xE0,0xF0,0xF8,0x7C,0x3C,0x1C,0x02,0x00]), // $4C
    new Uint8Array([0x03,0x01,0x00,0x00,0x00,0x00,0x00,0x00, 0x03,0x01,0x00,0x00,0x00,0x00,0x00,0x00]), // $4B
  ];
  const SWORD_BLADE_POS = [[0,0],[8,0],[0,8],[8,8]];
  const SWORD_BLADE_SWUNG_ORDER = [1, 0, 3, 2];

  // Raised sword (h-flipped, attr $43) — back swing / windup
  battleSwordBladeCanvas = document.createElement('canvas');
  battleSwordBladeCanvas.width = 16;
  battleSwordBladeCanvas.height = 16;
  const sblctx = battleSwordBladeCanvas.getContext('2d');
  for (let t = 0; t < 4; t++) {
    const bpx = decodeTile(SWORD_BLADE_TILES[t], 0);
    const sblimg = sblctx.createImageData(8, 8);
    for (let p = 0; p < 64; p++) {
      const ci = bpx[p];
      if (ci === 0) continue;
      const rgb = NES_SYSTEM_PALETTE[SWORD_BLADE_PAL[ci]] || [252, 252, 252];
      const row = Math.floor(p / 8), col = p % 8;
      const di = (row * 8 + (7 - col)) * 4; // h-flip
      sblimg.data[di] = rgb[0]; sblimg.data[di + 1] = rgb[1];
      sblimg.data[di + 2] = rgb[2]; sblimg.data[di + 3] = 255;
    }
    sblctx.putImageData(sblimg, SWORD_BLADE_POS[t][0], SWORD_BLADE_POS[t][1]);
  }

  // Swung sword (no flip, attr $03) — forward slash / hit
  battleSwordBladeSwungCanvas = document.createElement('canvas');
  battleSwordBladeSwungCanvas.width = 16;
  battleSwordBladeSwungCanvas.height = 16;
  const sswctx = battleSwordBladeSwungCanvas.getContext('2d');
  for (let t = 0; t < 4; t++) {
    const bpx = decodeTile(SWORD_BLADE_TILES[SWORD_BLADE_SWUNG_ORDER[t]], 0);
    const sswimg = sswctx.createImageData(8, 8);
    for (let p = 0; p < 64; p++) {
      const ci = bpx[p];
      if (ci === 0) continue;
      const rgb = NES_SYSTEM_PALETTE[SWORD_BLADE_PAL[ci]] || [252, 252, 252];
      sswimg.data[p * 4] = rgb[0]; sswimg.data[p * 4 + 1] = rgb[1];
      sswimg.data[p * 4 + 2] = rgb[2]; sswimg.data[p * 4 + 3] = 255;
    }
    sswctx.putImageData(sswimg, SWORD_BLADE_POS[t][0], SWORD_BLADE_POS[t][1]);
  }

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

  // Hit/recoil pose: sprite frame 5 in job block (tiles 30-33), read from ROM like idle
  const HIT_SPRITE_OFFSET = BATTLE_SPRITE_ROM + 30 * 16;
  battleSpriteHitCanvas = document.createElement('canvas');
  battleSpriteHitCanvas.width = 16;
  battleSpriteHitCanvas.height = 16;
  const hctx = battleSpriteHitCanvas.getContext('2d');
  for (let i = 0; i < 4; i++) {
    const px = decodeTile(romData, HIT_SPRITE_OFFSET + i * 16);
    const himg = hctx.createImageData(8, 8);
    for (let p = 0; p < 64; p++) {
      const ci = px[p];
      if (ci === 0) {
        himg.data[p * 4 + 3] = 0;
      } else {
        const rgb = NES_SYSTEM_PALETTE[palette[ci]] || [0, 0, 0];
        himg.data[p * 4]     = rgb[0];
        himg.data[p * 4 + 1] = rgb[1];
        himg.data[p * 4 + 2] = rgb[2];
        himg.data[p * 4 + 3] = 255;
      }
    }
    hctx.putImageData(himg, layout[i][0], layout[i][1]);
  }

  // Defend pose: 16×24 crouching sprite from FCEUX PPU $1000 dump (defend-tiles-v2.txt)
  // Tiles $43-$48 in 2×3 grid, palette 0 (same as idle)
  const DEFEND_TILES = [
    new Uint8Array([0x05,0x0B,0x17,0x03,0x00,0x00,0x0E,0x1F, 0x07,0x0F,0x1F,0x3F,0x43,0x40,0x20,0x00]), // $43
    new Uint8Array([0x00,0x00,0xA0,0xD0,0xE8,0x78,0x10,0x88, 0x2C,0x59,0xBE,0xD6,0xEF,0xFB,0x75,0x1A]), // $44
    new Uint8Array([0x04,0xD6,0xD6,0x3F,0xEF,0xF0,0x63,0x0E, 0x00,0x00,0x00,0x24,0xE4,0xF0,0x6F,0x1F]), // $45
    new Uint8Array([0x90,0x4C,0xCC,0x30,0x7C,0x78,0x30,0x00, 0x32,0x21,0x00,0xB0,0x7C,0x7C,0xB2,0xC2]), // $46
    new Uint8Array([0x37,0x1F,0x0F,0x0F,0x07,0x00,0x00,0x00, 0x3F,0xDF,0xEF,0xEF,0x67,0x08,0x07,0x00]), // $47
    new Uint8Array([0xE0,0x80,0x00,0x00,0x00,0x00,0x00,0x00, 0xE2,0xB2,0x73,0x73,0x63,0x03,0xFB,0x00]), // $48
  ];
  battleSpriteDefendCanvas = document.createElement('canvas');
  battleSpriteDefendCanvas.width = 16;
  battleSpriteDefendCanvas.height = 16;
  const dctx = battleSpriteDefendCanvas.getContext('2d');
  for (let i = 0; i < 4; i++) {
    const dpx = decodeTile(DEFEND_TILES[i], 0);
    const dimg = dctx.createImageData(8, 8);
    for (let p = 0; p < 64; p++) {
      const ci = dpx[p];
      if (ci === 0) {
        dimg.data[p * 4 + 3] = 0;
      } else {
        const rgb = NES_SYSTEM_PALETTE[palette[ci]] || [0, 0, 0];
        dimg.data[p * 4]     = rgb[0];
        dimg.data[p * 4 + 1] = rgb[1];
        dimg.data[p * 4 + 2] = rgb[2];
        dimg.data[p * 4 + 3] = 255;
      }
    }
    dctx.putImageData(dimg, layout[i][0], layout[i][1]);
  }

  // Defend sparkle frames (4 × 8×8) — tiles $49-$4C from PPU $1000 dump (defend-tiles-v2.txt)
  const SPARKLE_TILES = [
    new Uint8Array([0x01,0x00,0x08,0x00,0x00,0x41,0x00,0x02, 0x00,0x00,0x01,0x02,0x00,0x09,0x00,0x12]), // $49
    new Uint8Array([0x00,0x00,0x00,0x04,0x0A,0x14,0x0A,0x01, 0x00,0x00,0x00,0x18,0x1C,0x0E,0x04,0x00]), // $4A
    new Uint8Array([0x00,0x00,0x20,0x10,0x08,0x04,0x00,0x00, 0x00,0x00,0x30,0x38,0x10,0x00,0x00,0x00]), // $4B
    new Uint8Array([0x80,0x00,0x20,0x00,0x00,0x00,0x00,0x00, 0x80,0x40,0x00,0x00,0x00,0x00,0x00,0x00]), // $4C
  ];
  defendSparkleFrames = [];
  for (let t = 0; t < 4; t++) {
    const sc = document.createElement('canvas');
    sc.width = 8; sc.height = 8;
    const sctx = sc.getContext('2d');
    const spx = decodeTile(SPARKLE_TILES[t], 0);
    const simg = sctx.createImageData(8, 8);
    for (let p = 0; p < 64; p++) {
      const ci = spx[p];
      if (ci === 0) { simg.data[p * 4 + 3] = 0; }
      else {
        const rgb = NES_SYSTEM_PALETTE[DEFEND_SPARKLE_PAL[ci]] || [0, 0, 0];
        simg.data[p * 4] = rgb[0]; simg.data[p * 4 + 1] = rgb[1];
        simg.data[p * 4 + 2] = rgb[2]; simg.data[p * 4 + 3] = 255;
      }
    }
    sctx.putImageData(simg, 0, 0);
    defendSparkleFrames.push(sc);
  }

  // Cure sparkle frames (2 × 16×16) — tiles $4D/$4E from PPU $1000 dump (potion-tiles.txt)
  // Two configs alternate every 4 NES frames (~67ms). Pal3: $0F $12 $22 $31
  // Config A: TL=$4E(H), TR=$4D(H), BL=$4D(V), BR=$4E(V)
  // Config B: TL=$4D, TR=$4E, BL=$4E(HV), BR=$4D(HV)
  const CURE_TILE_4D = new Uint8Array([0x00,0x40,0x00,0x10,0x08,0x04,0x03,0x03, 0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x01]);
  const CURE_TILE_4E = new Uint8Array([0x00,0x00,0x00,0x08,0x10,0x60,0x20,0x80, 0x00,0x00,0x00,0x00,0x00,0x00,0xC0,0xC0]);
  const CURE_PAL = [0x0F, 0x12, 0x22, 0x31]; // pal3 from trace
  const cureTiles = [CURE_TILE_4D, CURE_TILE_4E];
  // Decode both tiles into 8×8 canvases
  const cureTileCanvases = cureTiles.map(raw => {
    const c = document.createElement('canvas');
    c.width = 8; c.height = 8;
    const cx = c.getContext('2d');
    const px = decodeTile(raw, 0);
    const img = cx.createImageData(8, 8);
    for (let p = 0; p < 64; p++) {
      const ci = px[p];
      if (ci === 0) { img.data[p * 4 + 3] = 0; }
      else {
        const rgb = NES_SYSTEM_PALETTE[CURE_PAL[ci]] || [0, 0, 0];
        img.data[p * 4] = rgb[0]; img.data[p * 4 + 1] = rgb[1];
        img.data[p * 4 + 2] = rgb[2]; img.data[p * 4 + 3] = 255;
      }
    }
    cx.putImageData(img, 0, 0);
    return c;
  });
  // Build 16×16 config A and B canvases
  // Config A: TL=$4E(H), TR=$4D(H), BL=$4D(V), BR=$4E(V)
  // Config B: TL=$4D, TR=$4E, BL=$4E(HV), BR=$4D(HV)
  cureSparkleFrames = [];
  const configLayouts = [
    // [tileIdx, ox, oy, hFlip, vFlip]
    [ // Config A
      [1, 0, 0, true, false],   // TL = $4E H-flip
      [0, 8, 0, true, false],   // TR = $4D H-flip
      [0, 0, 8, false, true],   // BL = $4D V-flip
      [1, 8, 8, false, true],   // BR = $4E V-flip
    ],
    [ // Config B
      [0, 0, 0, false, false],  // TL = $4D
      [1, 8, 0, false, false],  // TR = $4E
      [1, 0, 8, true, true],    // BL = $4E HV-flip
      [0, 8, 8, true, true],    // BR = $4D HV-flip
    ],
  ];
  for (const config of configLayouts) {
    const c = document.createElement('canvas');
    c.width = 16; c.height = 16;
    const cx = c.getContext('2d');
    for (const [ti, ox, oy, hf, vf] of config) {
      cx.save();
      if (hf && vf) { cx.translate(ox + 8, oy + 8); cx.scale(-1, -1); cx.drawImage(cureTileCanvases[ti], 0, 0); }
      else if (hf) { cx.translate(ox + 8, oy); cx.scale(-1, 1); cx.drawImage(cureTileCanvases[ti], 0, 0); }
      else if (vf) { cx.translate(ox, oy + 8); cx.scale(1, -1); cx.drawImage(cureTileCanvases[ti], 0, 0); }
      else { cx.drawImage(cureTileCanvases[ti], ox, oy); }
      cx.restore();
    }
    cureSparkleFrames.push(c);
  }

  // Kneel / low HP pose: tiles $09-$0C from PPU $1000 dump (kneel-tiles.txt)
  // Triggers at HP ≤ maxHP/4 (FF3 "near fatal" status, disasm 34/9485)
  const KNEEL_TILES = [
    new Uint8Array([0x00,0x00,0x00,0x00,0x02,0x05,0x0B,0x00, 0x00,0x00,0x00,0x00,0x03,0x07,0x0F,0x1F]), // $09
    new Uint8Array([0x00,0x00,0x00,0x00,0x80,0xB8,0xDC,0xEE, 0x00,0x00,0x00,0x00,0x9B,0xBE,0xDD,0xEF]), // $0A
    new Uint8Array([0x00,0x03,0x07,0x05,0x01,0x01,0x1B,0x3B, 0x20,0x10,0x00,0x00,0x00,0x04,0x00,0x20]), // $0B
    new Uint8Array([0x36,0x1A,0xC6,0x20,0x92,0x81,0xDC,0xDE, 0xF6,0x3A,0x16,0x0C,0x0E,0x21,0x04,0x06]), // $0C
  ];
  battleSpriteKneelCanvas = document.createElement('canvas');
  battleSpriteKneelCanvas.width = 16;
  battleSpriteKneelCanvas.height = 16;
  const knctx = battleSpriteKneelCanvas.getContext('2d');
  for (let i = 0; i < 4; i++) {
    const px = decodeTile(KNEEL_TILES[i], 0);
    const knimg = knctx.createImageData(8, 8);
    for (let p = 0; p < 64; p++) {
      const ci = px[p];
      if (ci === 0) { knimg.data[p * 4 + 3] = 0; }
      else {
        const rgb = NES_SYSTEM_PALETTE[palette[ci]] || [0, 0, 0];
        knimg.data[p * 4] = rgb[0]; knimg.data[p * 4 + 1] = rgb[1];
        knimg.data[p * 4 + 2] = rgb[2]; knimg.data[p * 4 + 3] = 255;
      }
    }
    knctx.putImageData(knimg, layout[i][0], layout[i][1]);
  }

  // Near-fatal sweat: 2 frames of scattered white dots above character head
  // Tiles $49/$4A (frame A, 4 dots) and $4B/$4C (frame B, 6 dots) from PPU $1000
  // Pal0 color index 2 = $30 (white), alternates every 8 NES frames (~133ms)
  const SWEAT_FRAME_TILES = [
    // Frame A: $49 (left 8×8) + $4A (right 8×8)
    [new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x04,0x00,0x40,0x00,0x00,0x00,0x00,0x00]),
     new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x20,0x00,0x02,0x00,0x00,0x00,0x00,0x00])],
    // Frame B: $4B (left 8×8) + $4C (right 8×8)
    [new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x02,0x10,0x00,0x40,0x00]),
     new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x40,0x08,0x00,0x02,0x00])],
  ];
  sweatFrames = [];
  for (let f = 0; f < 2; f++) {
    const sc = document.createElement('canvas');
    sc.width = 16; sc.height = 8;
    const sctx2 = sc.getContext('2d');
    for (let t = 0; t < 2; t++) {
      const spx = decodeTile(SWEAT_FRAME_TILES[f][t], 0);
      const simg = sctx2.createImageData(8, 8);
      for (let p = 0; p < 64; p++) {
        const ci = spx[p];
        if (ci === 0) { simg.data[p * 4 + 3] = 0; }
        else {
          const rgb = NES_SYSTEM_PALETTE[palette[ci]] || [252, 252, 252];
          simg.data[p * 4] = rgb[0]; simg.data[p * 4 + 1] = rgb[1];
          simg.data[p * 4 + 2] = rgb[2]; simg.data[p * 4 + 3] = 255;
        }
      }
      sctx2.putImageData(simg, t * 8, 0);
    }
    sweatFrames.push(sc);
  }

  // Attack frame 2: ROM frame 3 (tiles 18-21, top 2×2 of 2×3 body)
  // NES attack alternates frame 2 (arm raised) and frame 3 (arm swung)
  const ATK2_OFFSET = BATTLE_SPRITE_ROM + 18 * 16;
  battleSpriteAttack2Canvas = document.createElement('canvas');
  battleSpriteAttack2Canvas.width = 16;
  battleSpriteAttack2Canvas.height = 16;
  const a2ctx = battleSpriteAttack2Canvas.getContext('2d');
  for (let i = 0; i < 4; i++) {
    const px = decodeTile(romData, ATK2_OFFSET + i * 16);
    const a2img = a2ctx.createImageData(8, 8);
    for (let p = 0; p < 64; p++) {
      const ci = px[p];
      if (ci === 0) {
        a2img.data[p * 4 + 3] = 0;
      } else {
        const rgb = NES_SYSTEM_PALETTE[palette[ci]] || [0, 0, 0];
        a2img.data[p * 4]     = rgb[0];
        a2img.data[p * 4 + 1] = rgb[1];
        a2img.data[p * 4 + 2] = rgb[2];
        a2img.data[p * 4 + 3] = 255;
      }
    }
    a2ctx.putImageData(a2img, layout[i][0], layout[i][1]);
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
  playerATK = str + (ITEMS.get(playerWeaponR)?.atk || 0) + (ITEMS.get(playerWeaponL)?.atk || 0);
  recalcDEF();
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
  while (playerStats.exp >= playerStats.expToNext && playerStats.level < 5) {
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
    playerATK = playerStats.str + (ITEMS.get(playerWeaponR)?.atk || 0) + (ITEMS.get(playerWeaponL)?.atk || 0);
    recalcDEF();

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

// Generic renderer for PPU-dumped enemy sprites.
// rawBytes: Uint8Array of (cols*rows*16) bytes — tiles in row-major order.
// SouthWind ice explosion — 3-phase expanding animation from battle-item-trace.txt
// Phase 1 (+024-+031): small crystal  16×16, tile $4F 2×2
// Phase 2 (+032-+039): medium splash  32×32, tiles $49/$4A/$4C/$4D 4×4
// Phase 3 (+040-+047): large blast    48×48, tiles $49-$4E/$4F/$50/$51 6×6
// All use pal3: $0F $11 $21 $31 (ice blue)
function initSouthWindSprite() {
  const SW_PAL = [0x0F, 0x11, 0x21, 0x31];
  const nesColors = SW_PAL.map(c => NES_SYSTEM_PALETTE[c] || [0,0,0]);

  // Raw PPU tile data from FCEUX trace (16 bytes each, planar 2BPP)
  const TILES = {
    0x4F: new Uint8Array([0x01,0x01,0x0F,0x18,0x27,0x4D,0x98,0xB0, 0x01,0x01,0x0F,0x1F,0x3E,0x7E,0xFF,0xFF]),
    0x49: new Uint8Array([0x3F,0x31,0x60,0xEE,0xE1,0x80,0x90,0xB0, 0x3F,0x3F,0x7F,0xFF,0xFF,0xFF,0xEF,0xCF]),
    0x4A: new Uint8Array([0x00,0x80,0x80,0x60,0x51,0x2B,0xB2,0x34, 0x00,0x80,0x80,0xE0,0xB1,0xDB,0xCB,0xC7]),
    0x4B: new Uint8Array([0x00,0x03,0x06,0x04,0xE7,0xF7,0x7B,0x2F, 0x00,0x03,0x07,0x07,0xE1,0xF1,0xF8,0xFC]),
    0x4C: new Uint8Array([0xD8,0xBC,0xAE,0x76,0x2F,0x1E,0x0D,0x01, 0xA7,0xC3,0xD1,0x69,0x31,0x1A,0x0D,0x01]),
    0x4D: new Uint8Array([0x66,0xCA,0xAA,0x5D,0xFD,0x8E,0x86,0xC7, 0x95,0x25,0x45,0x82,0x7A,0xF9,0xFD,0x3E]),
    0x4E: new Uint8Array([0x17,0x1B,0x01,0x05,0x8D,0xDB,0x7A,0x67, 0xFE,0xFF,0xFF,0xFF,0x7F,0x3E,0xB6,0x8C]),
    0x50: new Uint8Array([0x63,0xAD,0xD9,0x62,0xBC,0xD9,0x63,0xE3, 0x9E,0xD2,0xE6,0xFC,0x7C,0x30,0x91,0x12]),
    0x51: new Uint8Array([0xBF,0x3E,0x7A,0xFD,0xF7,0xCB,0xC7,0x83, 0x79,0x03,0x03,0x39,0x5C,0xBE,0x3E,0x7E]),
  };

  // Helper: decode tile to 8×8 pixel array of palette indices
  function decodeTileLocal(id) { return decodeTile(TILES[id], 0); }

  // Helper: draw one 8×8 tile into a canvas context at (dx,dy) with optional H/V flip
  function drawTile(cctx, id, dx, dy, hf, vf) {
    const px = decodeTileLocal(id);
    const img = cctx.createImageData(8, 8);
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const sr = vf ? 7-r : r, sc = hf ? 7-c : c;
      const ci = px[sr*8+sc];
      const i = (r*8+c)*4;
      if (ci === 0) { img.data[i+3] = 0; continue; }
      const [R,G,B] = nesColors[ci] || [0,0,0];
      img.data[i]=R; img.data[i+1]=G; img.data[i+2]=B; img.data[i+3]=255;
    }
    cctx.putImageData(img, dx, dy);
  }

  // Phase 1: 16×16 — tile $4F, 2×2 symmetric
  const c1 = document.createElement('canvas'); c1.width = 16; c1.height = 16;
  const x1 = c1.getContext('2d');
  drawTile(x1, 0x4F,  0, 0, false, false);
  drawTile(x1, 0x4F,  8, 0, true,  false);
  drawTile(x1, 0x4F,  0, 8, false, true);
  drawTile(x1, 0x4F,  8, 8, true,  true);

  // Phase 2: 32×32 — 4×4 grid, tiles $49/$4A/$4C/$4D
  // Row 0: $49(--) $4A(--) $4A(H) $49(H)
  // Row 1: $4C(--) $4D(--) $4D(H) $4C(H)
  // Row 2: $4C(V)  $4D(V)  $4D(HV) $4C(HV)
  // Row 3: $49(V)  $4A(V)  $4A(HV) $49(HV)
  const c2 = document.createElement('canvas'); c2.width = 32; c2.height = 32;
  const x2 = c2.getContext('2d');
  drawTile(x2, 0x49,  0, 0, false, false); drawTile(x2, 0x4A,  8, 0, false, false);
  drawTile(x2, 0x4A, 16, 0, true,  false); drawTile(x2, 0x49, 24, 0, true,  false);
  drawTile(x2, 0x4C,  0, 8, false, false); drawTile(x2, 0x4D,  8, 8, false, false);
  drawTile(x2, 0x4D, 16, 8, true,  false); drawTile(x2, 0x4C, 24, 8, true,  false);
  drawTile(x2, 0x4C,  0,16, false, true);  drawTile(x2, 0x4D,  8,16, false, true);
  drawTile(x2, 0x4D, 16,16, true,  true);  drawTile(x2, 0x4C, 24,16, true,  true);
  drawTile(x2, 0x49,  0,24, false, true);  drawTile(x2, 0x4A,  8,24, false, true);
  drawTile(x2, 0x4A, 16,24, true,  true);  drawTile(x2, 0x49, 24,24, true,  true);

  // Phase 3: 48×48 — 6×6 grid
  // Row 0: $49(--) $4A(--) $4B(--) $4B(H) $4A(H) $49(H)
  // Row 1: $4C(--) $4D(--) $4E(--) $4E(H) $4D(H) $4C(H)
  // Row 2: $4F(--) $50(--) $51(--) $51(H) $50(H) $4F(H)
  // Row 3: $4F(V)  $50(V)  $51(V)  $51(HV) $50(HV) $4F(HV)
  // Row 4: $4C(V)  $4D(V)  $4E(V)  $4E(HV) $4D(HV) $4C(HV)
  // Row 5: $49(V)  $4A(V)  $4B(V)  $4B(HV) $4A(HV) $49(HV)
  const c3 = document.createElement('canvas'); c3.width = 48; c3.height = 48;
  const x3 = c3.getContext('2d');
  const p3 = [
    [0x49,0x4A,0x4B,0x4B,0x4A,0x49],
    [0x4C,0x4D,0x4E,0x4E,0x4D,0x4C],
    [0x4F,0x50,0x51,0x51,0x50,0x4F],
    [0x4F,0x50,0x51,0x51,0x50,0x4F],
    [0x4C,0x4D,0x4E,0x4E,0x4D,0x4C],
    [0x49,0x4A,0x4B,0x4B,0x4A,0x49],
  ];
  for (let row = 0; row < 6; row++) for (let col = 0; col < 6; col++) {
    const hf = col >= 3, vf = row >= 3;
    drawTile(x3, p3[row][col], col*8, row*8, hf, vf);
  }

  swPhaseCanvases = [c1, c2, c3];
  southWindHitCanvas = c1; // compat
}

// Returns a canvas of (cols*8) × (rows*8).
function _renderEnemySprite(rawBytes, cols, rows, tilePalMap, pal0, pal1) {
  const w = cols * 8, h = rows * 8;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cctx = c.getContext('2d');
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const tileIdx = ty * cols + tx;
      const pal = tilePalMap[tileIdx] === 1 ? pal1 : pal0;
      const off = tileIdx * 16;
      const img = cctx.createImageData(8, 8);
      for (let row = 0; row < 8; row++) {
        const bp0 = rawBytes[off + row];
        const bp1 = rawBytes[off + row + 8];
        for (let col = 0; col < 8; col++) {
          const bit = 7 - col;
          const ci = (((bp1 >> bit) & 1) << 1) | ((bp0 >> bit) & 1);
          const p = (row * 8 + col) * 4;
          if (ci === 0) {
            img.data[p + 3] = 0;
          } else {
            const rgb = NES_SYSTEM_PALETTE[pal[ci]] || [0, 0, 0];
            img.data[p]     = rgb[0];
            img.data[p + 1] = rgb[1];
            img.data[p + 2] = rgb[2];
            img.data[p + 3] = 255;
          }
        }
      }
      cctx.putImageData(img, tx * 8, ty * 8);
    }
  }
  return c;
}

function _initEnemySprite(monsterId, rawBytes, cols, rows, tilePalMap, pal0, pal1) {
  const w = cols * 8, h = rows * 8;
  const canvas = _renderEnemySprite(rawBytes, cols, rows, tilePalMap, pal0, pal1);
  monsterBattleCanvas.set(monsterId, canvas);

  // White flash version for pre-attack blink
  const wc = document.createElement('canvas');
  wc.width = w; wc.height = h;
  const wctx = wc.getContext('2d');
  const srcData = canvas.getContext('2d').getImageData(0, 0, w, h);
  const whiteRGB = NES_SYSTEM_PALETTE[0x30] || [255, 255, 255];
  for (let p = 0; p < srcData.data.length; p += 4) {
    if (srcData.data[p + 3] > 0) {
      srcData.data[p]     = whiteRGB[0];
      srcData.data[p + 1] = whiteRGB[1];
      srcData.data[p + 2] = whiteRGB[2];
    }
  }
  wctx.putImageData(srcData, 0, 0);
  monsterWhiteCanvas.set(monsterId, wc);

  // Death deterioration frames — diagonal dither dissolve
  const origData = canvas.getContext('2d').getImageData(0, 0, w, h);
  const maxThreshold = (w - 1) + (h - 1) + 15;
  const frames = [];
  for (let f = 0; f < MONSTER_DEATH_FRAMES; f++) {
    const fc = document.createElement('canvas');
    fc.width = w; fc.height = h;
    const fctx = fc.getContext('2d');
    const fd = fctx.createImageData(w, h);
    const wave = (f / (MONSTER_DEATH_FRAMES - 1)) * (maxThreshold + 1);
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const idx = (py * w + px) * 4;
        const diag = (w - 1 - px) + py;
        const threshold = diag + BAYER4[py & 3][px & 3];
        if (threshold < wave) {
          fd.data[idx + 3] = 0;
        } else {
          fd.data[idx]     = origData.data[idx];
          fd.data[idx + 1] = origData.data[idx + 1];
          fd.data[idx + 2] = origData.data[idx + 2];
          fd.data[idx + 3] = origData.data[idx + 3];
        }
      }
    }
    fctx.putImageData(fd, 0, 0);
    frames.push(fc);
  }
  monsterDeathFrames.set(monsterId, frames);
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
const TITLE_SKY_BGID = 6;      // airship sky battle BG (blue/lavender/white clouds)

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
  const oceanBgId = 5;
  const palette = [
    0x0F,
    romData[BATTLE_BG_PAL_C1 + oceanBgId], // match ocean scene's sky blue ($21)
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

function initTitleUnderwater(romData) {
  const bgId = 18; // undersea Nautilus battle BG ($12/$22/$33 blue palette)
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

  titleUnderwaterFrames = [];
  const fadePal = [...palette];
  while (true) {
    titleUnderwaterFrames.push(renderBattleBgWithPalette(romData, bgId, fadePal, tiles, metaTiles, tilemap));
    if (fadePal[1] === 0x0F && fadePal[2] === 0x0F && fadePal[3] === 0x0F) break;
    fadePal[1] = nesColorFade(fadePal[1]);
    fadePal[2] = nesColorFade(fadePal[2]);
    fadePal[3] = nesColorFade(fadePal[3]);
  }
}

function initUnderwaterSprites(romData) {
  // Bubble/fish tiles at ROM 0x17F10 (bank $0B, $9F00)
  const SPRITE_ROM = 0x17F10;
  // Underwater sprite palette 3: $0F/$0F/$27/$30 (black/orange/white)
  const pal = [null, NES_SYSTEM_PALETTE[0x0F], NES_SYSTEM_PALETTE[0x27], NES_SYSTEM_PALETTE[0x30]];

  function renderSpriteTile(tileIdx) {
    const px = decodeTile(romData, SPRITE_ROM + tileIdx * 16);
    const c = document.createElement('canvas');
    c.width = 8; c.height = 8;
    const lctx = c.getContext('2d');
    const idata = lctx.createImageData(8, 8);
    const d = idata.data;
    for (let i = 0; i < 64; i++) {
      const ci = px[i];
      if (ci === 0) continue;
      const rgb = pal[ci];
      if (!rgb) continue;
      d[i * 4] = rgb[0]; d[i * 4 + 1] = rgb[1]; d[i * 4 + 2] = rgb[2]; d[i * 4 + 3] = 255;
    }
    lctx.putImageData(idata, 0, 0);
    return c;
  }

  uwBubbleTiles = [];
  // 0: small bubble, 1: NE fish frame 1 (tile 3), 2: NE fish frame 2 (tile 4)
  uwBubbleTiles.push(renderSpriteTile(0)); // small bubble
  uwBubbleTiles.push(renderSpriteTile(3)); // fish frame 1
  uwBubbleTiles.push(renderSpriteTile(4)); // fish frame 2
}

function initTitleOcean(romData) {
  const bgId = 5; // ocean battle BG

  // Sky row palette — match the sky box above (ocean's original c1 replaced with sky blue)
  const oceanBgId = 5;
  const skyPal = [
    0x0F,
    romData[BATTLE_BG_PAL_C1 + oceanBgId], // $21 — same sky blue as top box
    romData[BATTLE_BG_PAL_C2 + oceanBgId],
    romData[BATTLE_BG_PAL_C3 + oceanBgId],
  ];

  // Ocean row palette — remap to water tile colors
  // Water tiles: [$1A(dark teal), $0F(black), $22(blue), $31(light blue)]
  // Ocean BG color usage: c1=base, c2=highlight, c3=brightest
  const BG_PALETTE = 0x001650;
  const wPalOff = BG_PALETTE + TITLE_WATER_PAL_IDX * 4;
  const wavePal = [
    0x0F,
    romData[wPalOff],     // c1 → $1A (dark teal base)
    romData[wPalOff + 2], // c2 → $22 (blue mid)
    romData[wPalOff + 3], // c3 → $31 (light blue highlight)
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

  // Render helper: one 256×16 row with given palette and tilemap row offset
  function renderRow(pal, rowIdx) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 16;
    const rctx = c.getContext('2d');
    for (let col = 0; col < 16; col++) {
      const metaIdx = tilemap[rowIdx * 16 + col];
      const [tl, tr, bl, br] = metaTiles[metaIdx];
      const px = col * 16;
      const subTiles = [[tl, px, 0], [tr, px + 8, 0], [bl, px, 8], [br, px + 8, 8]];
      for (const [tIdx, sx, sy] of subTiles) {
        const img = rctx.createImageData(8, 8);
        const pix = tiles[tIdx];
        for (let p = 0; p < 64; p++) {
          const ci = pix[p];
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
        rctx.putImageData(img, sx, sy);
      }
    }
    return c;
  }

  titleOceanFrames = [];
  const fadeSky = [...skyPal];
  const fadeWave = [...wavePal];
  while (true) {
    const frame = document.createElement('canvas');
    frame.width = 256; frame.height = 32;
    const fctx = frame.getContext('2d');

    // Sky row (top 16px) — fill bg with sky blue, then draw tiles
    const skyBg = NES_SYSTEM_PALETTE[fadeSky[1]] || [0, 0, 0];
    fctx.fillStyle = `rgb(${skyBg[0]},${skyBg[1]},${skyBg[2]})`;
    fctx.fillRect(0, 0, 256, 16);
    fctx.drawImage(renderRow(fadeSky, 0), 0, 0);

    // Wave row (bottom 16px) — fill bg with water base color, then draw tiles
    const waveBg = NES_SYSTEM_PALETTE[fadeWave[1]] || [0, 0, 0];
    fctx.fillStyle = `rgb(${waveBg[0]},${waveBg[1]},${waveBg[2]})`;
    fctx.fillRect(0, 16, 256, 16);
    fctx.drawImage(renderRow(fadeWave, 1), 0, 16);

    titleOceanFrames.push(frame);

    const allBlack = fadeSky[1] === 0x0F && fadeSky[2] === 0x0F && fadeSky[3] === 0x0F &&
                     fadeWave[1] === 0x0F && fadeWave[2] === 0x0F && fadeWave[3] === 0x0F;
    if (allBlack) break;
    for (let i = 1; i <= 3; i++) { fadeSky[i] = nesColorFade(fadeSky[i]); fadeWave[i] = nesColorFade(fadeWave[i]); }
  }
}

// FF3 Sight screen logo — composited pixel data captured from FCEUX (BG+sprites)
// 160×16 pixels, hex digits: 0=transparent, 1=fill (NES $02/$03), 2=outline (NES $22)
const LOGO_PIXELS = [
  '0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000022222100000000000',
  '0002222200000021000000000000000000000000000000002100000000022222000000210000000000000000000000000000000000000000000000000000000000000000000022211122222222221222',
  '0021111122000210000000000000000000000000000000022100000000211111220002100000000000000000000000000000000000000000000000000000000000000000000000000222222222222210',
  '0210022111222100000110000000000000000000000000222100000002100221112221000000000000000000000000000000000000000000000000000000000000000000000000000221122112211100',
  '0210001211111000002211000000000000000000000002221000000002100012111110000000000000000000000000000000000000000000000000000000000000000000000000000220222022100000',
  '0211001210000000000110000000000000000000000021221000000002110012100000000000000000000000000000210000000000000000000000000000000000000000000000002220220022000000',
  '0021111222200000000000000000000000000000000202210000000000211112222000000000000000000000000002210000000000000000000000000000000000000000000000002202220220000000',
  '0002222111220000022100000000000000000000000002210000000000022221112200000000000000000000000002100000000000000000000000000000000000000000000000011101100110000000',
  '0000111110120000222100002022210000002221000022100000000000001111001200000222000002022210002222222100002220000022221000022100222000000000000000022022202200000000',
  '0000000000000022021000222221221000221122100022100000000000000000000100022112210222221221000022112100221122100221112102212100221000000000000000111011001100000000',
  '0000022100000000221000112211121002210022100221000000000000000221000000221002210002210121000021001002210022100022101000021002211000000000000000220022022000000000',
  '0000022100000000210000002100221002100111000221000000000000000221000000210011100002100211000221001002100111000002210000221002210000000000000001110110011000000000',
  '0000221000000002210000022100210022100221002210000000000000002210000002210022000022100210000210000022100220002100221000210002110000000000000111111110110000000000',
  '0000221111000002210000021002202022102210002210210000000000002211100002210221000021002102002210200022102210002210221002210022100000000000001111111111111111110000',
  '0022222221000001222100221002221012221222001222100000000000222222100001222122200221002221001222110012221222001222211002211221100000000000010001111111111110000000',
  '0011111110000000111100110000110001110110000111000000000000111111100000111011000110000110000111100001110110000111110000222221000000000000000000011111110000000000',
  '0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000211000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000120002210000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000122222110000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000012221100000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001111000000000000000000000000000000000000000',
].join('');
const LOGO_W = 160;
const LOGO_H = 21;

function initTitleLogo() {
  // Palette: 1=fill ($21 blue), 2=outline ($30 white)
  let pal = [0x0F, 0x21, 0x30];

  function renderLogo(palette) {
    const c = document.createElement('canvas');
    c.width = LOGO_W; c.height = LOGO_H;
    const lctx = c.getContext('2d');
    const idata = lctx.createImageData(LOGO_W, LOGO_H);
    const d = idata.data;
    for (let i = 0; i < LOGO_PIXELS.length; i++) {
      const ci = LOGO_PIXELS.charCodeAt(i) - 48; // '0'=0, '1'=1, '2'=2
      if (ci === 0) continue;
      const nesC = palette[ci];
      const rgb = NES_SYSTEM_PALETTE[nesC] || [0, 0, 0];
      const idx = i * 4;
      d[idx] = rgb[0]; d[idx + 1] = rgb[1]; d[idx + 2] = rgb[2]; d[idx + 3] = 255;
    }
    lctx.putImageData(idata, 0, 0);
    return c;
  }

  titleLogoFrames = [];
  const fadePal = [...pal];
  while (true) {
    titleLogoFrames.push(renderLogo(fadePal));
    const allBlack = fadePal[1] === 0x0F && fadePal[2] === 0x0F;
    if (allBlack) break;
    for (let i = 1; i <= 2; i++) fadePal[i] = nesColorFade(fadePal[i]);
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
  initFakePlayerPortraits(romRaw);
  initRoster();
  initLandTurtleBattle(romRaw);
  initGoblinSprite(romRaw);
  _initEnemySprite(0x02, EYE_FANG_RAW,   4, 6, EYE_FANG_TILE_PAL,   ENC_PAL0, ENC_PAL1);
  _initEnemySprite(0x03, BLUE_WISP_RAW,  4, 4, BLUE_WISP_TILE_PAL,  ENC_PAL0, ENC_PAL1);
  _initEnemySprite(0x01, CARBUNCLE_RAW,  4, 4, CARBUNCLE_TILE_PAL,  ENC_PAL0, ENC_PAL1);
  initSouthWindSprite();
  initSlashSprites();
  initKnifeSlashSprites();
  initSwordSlashSprites();
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
  initTitleUnderwater(romRaw);
  initUnderwaterSprites(romRaw);
  initTitleOcean(romRaw);
  initTitleLogo();

  // Load saved player slots from IndexedDB
  await loadSlotsFromDB();

  // Debug mode — skip title, spawn directly in crystal room
  if (window.DEBUG_BOSS) {
    titleState = 'done';
    dungeonSeed = 1;
    clearDungeonCache();
    loadMapById(1004);
    playTrack(TRACKS.CRYSTAL_ROOM);
    playerInventory = {};
    addItem(0x54, 5);
    lastTime = performance.now();
    requestAnimationFrame(gameLoop);
    return;
  }

  // Start with title screen — map loads after title sequence
  titleState = 'credit-wait';
  titleTimer = 0;
  titleWaterScroll = 0;
  titleShipTimer = 0;
  playTrack(TRACKS.TITLE_SCREEN);

  lastTime = performance.now();
  requestAnimationFrame(gameLoop);
}

export function loadFF12ROM(arrayBuffer) {
  ff12Raw = new Uint8Array(arrayBuffer);
  initAdamantoise(ff12Raw);
  initFF1Music(ff12Raw);
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
  bossDefeated = false;  // boss respawns on dungeon re-entry
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
      if (msgBoxState === 'hold' && (keys['z'] || keys['Z'])) {
        keys['z'] = false; keys['Z'] = false;
        msgBoxState = 'slide-out'; msgBoxTimer = 0;
      }
    } else if (battleState === 'defeat-text') {
      if (keys['z'] || keys['Z']) {
        keys['z'] = false; keys['Z'] = false;
        battleState = 'defeat-close'; battleTimer = 0;
      }
    } else if (battleState === 'victory-hold') {
      if (keys['z'] || keys['Z']) { keys['z'] = false; keys['Z'] = false; battleState = 'victory-fade-out'; battleTimer = 0; }
    } else if (battleState === 'exp-hold') {
      if (keys['z'] || keys['Z']) {
        keys['z'] = false; keys['Z'] = false;
        battleState = 'exp-fade-out'; battleTimer = 0;
      }
    } else if (battleState === 'gil-hold') {
      if (keys['z'] || keys['Z']) {
        keys['z'] = false; keys['Z'] = false;
        if (leveledUp || encounterDropItem !== null) { battleState = 'gil-fade-out'; } else { battleState = 'victory-text-out'; }
        battleTimer = 0;
      }
    } else if (battleState === 'item-hold') {
      if (keys['z'] || keys['Z']) {
        keys['z'] = false; keys['Z'] = false;
        if (leveledUp) { battleState = 'item-fade-out'; } else { battleState = 'victory-text-out'; }
        battleTimer = 0;
      }
    } else if (battleState === 'levelup-hold') {
      if (keys['z'] || keys['Z']) { keys['z'] = false; keys['Z'] = false; battleState = 'victory-text-out'; battleTimer = 0; }
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
        // Hit count: dual-wield/unarmed = min 2, single weapon = min 1
        // Shields in hand don't count as weapons for combat
        const rIsWeapon = isWeapon(playerWeaponR);
        const lIsWeapon = isWeapon(playerWeaponL);
        const dualWield = rIsWeapon && lIsWeapon;
        const unarmed = !rIsWeapon && !lIsWeapon;
        const baseHits = Math.max(1, Math.floor((playerStats ? playerStats.agi : 5) / 10));
        const potentialHits = (dualWield || unarmed) ? Math.max(2, baseHits) : Math.max(1, baseHits);
        const wpn = (rIsWeapon ? ITEMS.get(playerWeaponR) : null) || (lIsWeapon ? ITEMS.get(playerWeaponL) : null);
        const hitRate = wpn ? wpn.hit : BASE_HIT_RATE;
        if (isRandomEncounter && encounterMonsters) {
          const target = encounterMonsters[targetIndex];
          hitResults = rollHits(playerATK, target.def, hitRate, potentialHits);
        } else {
          hitResults = rollHits(playerATK, BOSS_DEF, hitRate, potentialHits);
        }
        // Determine which hand attacks per hit (skip shield hands)
        const weaponHandR = isWeapon(playerWeaponR);
        const weaponHandL = isWeapon(playerWeaponL);
        const firstHandR = weaponHandR || !weaponHandL; // prefer R, fallback if neither
        const firstWpnId = firstHandR ? playerWeaponR : playerWeaponL;
        const pendingSlashFrames = getSlashFramesForWeapon(firstWpnId, firstHandR);
        // Base position = target center
        const centerX = HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2);
        const centerY = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2);
        // Weapon-aware initial offset: bladed = diagonal sweep, unarmed = random scatter
        const firstWeapon0 = getHitWeapon(0);
        let pendingOffX, pendingOffY;
        if (isBladedWeapon(firstWeapon0)) {
          pendingOffX = 8; pendingOffY = -8; // diagonal sweep starts top-right
        } else {
          pendingOffX = Math.floor(Math.random() * 40) - 20;
          pendingOffY = Math.floor(Math.random() * 40) - 20;
        }
        playerActionPending = {
          command: 'fight', targetIndex, hitResults,
          slashFrames: pendingSlashFrames, slashOffX: pendingOffX, slashOffY: pendingOffY,
          slashX: centerX, slashY: centerY
        };
        battleState = 'confirm-pause';
        battleTimer = 0;
      }
      if (keys['x'] || keys['X']) {
        keys['x'] = false; keys['X'] = false;
        // Cancel — return to menu
        playSFX(SFX.CONFIRM);
        battleState = 'menu-open';
        battleTimer = 0;
      }
    } else if (battleState === 'item-select') {
      const isEquipPage = itemPage === 0;
      const pageRows = isEquipPage ? 2 : INV_SLOTS;
      const totalInvPages = Math.max(1, Math.ceil(itemSelectList.length / INV_SLOTS));
      const totalPages = 1 + totalInvPages; // page 0 = equip, pages 1+ = inventory

      // Global inventory index from current page + cursor
      function _curGlobalIdx() {
        if (isEquipPage) return -100 - itemPageCursor; // -100 = R.Hand, -101 = L.Hand
        return (itemPage - 1) * INV_SLOTS + itemPageCursor;
      }

      // Up/Down navigation — advance to next/prev page at boundaries
      if (keys['ArrowDown']) {
        keys['ArrowDown'] = false;
        if (itemPageCursor < pageRows - 1) {
          itemPageCursor++;
        } else if (itemPage < totalPages - 1) {
          itemSlideDir = -1; itemSlideCursor = 0;
          battleState = 'item-slide'; battleTimer = 0;
        }
        playSFX(SFX.CURSOR);
      }
      if (keys['ArrowUp']) {
        keys['ArrowUp'] = false;
        if (itemPageCursor > 0) {
          itemPageCursor--;
        } else if (itemPage > 0) {
          const prevPageRows = (itemPage - 1) === 0 ? 2 : INV_SLOTS;
          itemSlideDir = 1; itemSlideCursor = prevPageRows - 1;
          battleState = 'item-slide'; battleTimer = 0;
        }
        playSFX(SFX.CURSOR);
      }

      // Left/Right — page slide
      if (keys['ArrowLeft'] && itemPage > 0) {
        keys['ArrowLeft'] = false;
        playSFX(SFX.CURSOR);
        itemSlideDir = 1; itemSlideCursor = 0; // sliding right (previous page)
        battleState = 'item-slide';
        battleTimer = 0;
      }
      if (keys['ArrowRight'] && itemPage < totalPages - 1) {
        keys['ArrowRight'] = false;
        playSFX(SFX.CURSOR);
        itemSlideDir = -1; itemSlideCursor = 0; // sliding left (next page)
        battleState = 'item-slide';
        battleTimer = 0;
      }

      // Z — hold or place/use
      if (keys['z'] || keys['Z']) {
        keys['z'] = false; keys['Z'] = false;
        const gIdx = _curGlobalIdx();

        if (itemHeldIdx === -1) {
          // Nothing held — pick up
          if (isEquipPage) {
            const weaponId = itemPageCursor === 0 ? playerWeaponR : playerWeaponL;
            if (weaponId !== 0) { itemHeldIdx = gIdx; playSFX(SFX.CONFIRM); }
            else playSFX(SFX.ERROR);
          } else {
            const invIdx = (itemPage - 1) * INV_SLOTS + itemPageCursor;
            if (itemSelectList[invIdx] !== null) { itemHeldIdx = gIdx; playSFX(SFX.CONFIRM); }
            else playSFX(SFX.ERROR);
          }
        } else if (itemHeldIdx === gIdx) {
          // Same slot — use consumable or deselect
          if (!isEquipPage) {
            const invIdx = (itemPage - 1) * INV_SLOTS + itemPageCursor;
            const item = itemSelectList[invIdx];
            const itemDat = ITEMS.get(item.id);
            if (itemDat?.type === 'consumable' || itemDat?.type === 'battle_item') {
              playSFX(SFX.CONFIRM);
              itemHeldIdx = -1;
              itemTargetMode = 'single';
              if (itemDat.type === 'battle_item' && isRandomEncounter && encounterMonsters) {
                // Start cursor on rightmost alive enemy
                itemTargetType = 'enemy';
                const ecnt = encounterMonsters.length;
                const ealive = (i) => i < encounterMonsters.length && encounterMonsters[i].hp > 0;
                const rightCandidates = ecnt === 1 ? [0] : ecnt === 2 ? [1] : ecnt === 3 ? [1] : [1,3];
                const leftCandidates  = ecnt === 1 ? [0] : ecnt === 2 ? [0] : ecnt === 3 ? [0,2] : [0,2];
                const first = [...rightCandidates,...leftCandidates].find(i => ealive(i));
                itemTargetIndex = first !== undefined ? first : 0;
              } else if (itemDat.type === 'battle_item' && !isRandomEncounter) {
                itemTargetType = 'enemy'; itemTargetIndex = 0;
              } else {
                itemTargetType = 'player'; itemTargetIndex = 0;
              }
              itemTargetAllyIndex = -1;
              battleState = 'item-target-select';
              battleTimer = 0;
              // Stash the item id for when target is confirmed
              playerActionPending = { command: 'item', itemId: item.id };
            } else {
              itemHeldIdx = -1;
              playSFX(SFX.CONFIRM);
            }
          } else {
            itemHeldIdx = -1;
            playSFX(SFX.CONFIRM);
          }
        } else {
          // Different slot — swap/equip/unequip
          const srcEquip = itemHeldIdx <= -100;
          const dstEquip = isEquipPage;
          if (!srcEquip && !dstEquip) {
            // Inv → Inv swap
            const srcIdx = srcEquip ? 0 : itemHeldIdx;
            const dstIdx = (itemPage - 1) * INV_SLOTS + itemPageCursor;
            const tmp = itemSelectList[srcIdx];
            itemSelectList[srcIdx] = itemSelectList[dstIdx];
            itemSelectList[dstIdx] = tmp;
            itemHeldIdx = -1;
            playSFX(SFX.CONFIRM);
          } else if (!srcEquip && dstEquip) {
            // Inv → Equip (equip weapon from inventory to hand)
            const srcIdx = itemHeldIdx;
            const item = itemSelectList[srcIdx];
            const handIdx = itemPageCursor; // 0=R, 1=L
            if (item && isHandEquippable(ITEMS.get(item.id))) {
              const oldWeapon = handIdx === 0 ? playerWeaponR : playerWeaponL;
              if (handIdx === 0) playerWeaponR = item.id; else playerWeaponL = item.id;
              removeItem(item.id);
              if (oldWeapon !== 0) addItem(oldWeapon, 1);
              if (oldWeapon !== 0) {
                itemSelectList[srcIdx] = { id: oldWeapon, count: 1 };
              } else {
                itemSelectList[srcIdx] = null;
              }
              playerATK = playerStats.str + (ITEMS.get(playerWeaponR)?.atk || 0) + (ITEMS.get(playerWeaponL)?.atk || 0);
              itemHeldIdx = -1;
              playSFX(SFX.CONFIRM);
            } else {
              playSFX(SFX.ERROR);
              itemHeldIdx = -1;
            }
          } else if (srcEquip && !dstEquip) {
            // Equip → Inv (unequip hand weapon to inventory slot)
            const srcHand = -(itemHeldIdx + 100); // 0=R, 1=L
            const handWeaponId = srcHand === 0 ? playerWeaponR : playerWeaponL;
            const dstIdx = (itemPage - 1) * INV_SLOTS + itemPageCursor;
            const invItem = itemSelectList[dstIdx];
            if (invItem && isHandEquippable(ITEMS.get(invItem.id))) {
              if (srcHand === 0) playerWeaponR = invItem.id; else playerWeaponL = invItem.id;
              removeItem(invItem.id);
              addItem(handWeaponId, 1);
              itemSelectList[dstIdx] = { id: handWeaponId, count: 1 };
              playerATK = playerStats.str + (ITEMS.get(playerWeaponR)?.atk || 0) + (ITEMS.get(playerWeaponL)?.atk || 0);
              itemHeldIdx = -1;
              playSFX(SFX.CONFIRM);
            } else if (!invItem) {
              if (srcHand === 0) playerWeaponR = 0; else playerWeaponL = 0;
              addItem(handWeaponId, 1);
              itemSelectList[dstIdx] = { id: handWeaponId, count: 1 };
              playerATK = playerStats.str + (ITEMS.get(playerWeaponR)?.atk || 0) + (ITEMS.get(playerWeaponL)?.atk || 0);
              itemHeldIdx = -1;
              playSFX(SFX.CONFIRM);
            } else {
              playSFX(SFX.ERROR);
              itemHeldIdx = -1;
            }
          } else if (srcEquip && dstEquip) {
            // Equip → Equip (swap hands)
            const tmp = playerWeaponR;
            playerWeaponR = playerWeaponL;
            playerWeaponL = tmp;
            playerATK = playerStats.str + (ITEMS.get(playerWeaponR)?.atk || 0) + (ITEMS.get(playerWeaponL)?.atk || 0);
            itemHeldIdx = -1;
            playSFX(SFX.CONFIRM);
          }
        }
      }

      // X — cancel hold or exit inventory
      if (keys['x'] || keys['X']) {
        keys['x'] = false; keys['X'] = false;
        if (itemHeldIdx !== -1) {
          itemHeldIdx = -1;
          playSFX(SFX.CONFIRM);
        } else {
          playSFX(SFX.CONFIRM);
          battleState = 'item-cancel-out';
          battleTimer = 0;
        }
      }
    } else if (battleState === 'item-target-select') {
      // Spatial nav: Player ← right-col enemies ← left-col enemies
      // Grid: 0=TL, 1=TR, 2=BL, 3=BR. Right col = 1,3. Left col = 0,2.
      // 1 enemy: just index 0. 2 enemies: 0=left, 1=right. 3: 0=TL,1=TR,2=BL.
      const _alive = (i) => isRandomEncounter && encounterMonsters && i < encounterMonsters.length && encounterMonsters[i].hp > 0;
      const _cnt = isRandomEncounter && encounterMonsters ? encounterMonsters.length : (isRandomEncounter ? 0 : 1);
      // Which column is this index in? For 1 enemy, it's the right col (goes straight to player).
      const _isRightCol = (i) => _cnt === 1 || (_cnt === 2 && i === 1) || (_cnt >= 3 && (i === 1 || i === 3));
      const _isLeftCol = (i) => _cnt >= 2 && !_isRightCol(i);

      const _isBattleItem = playerActionPending && ITEMS.get(playerActionPending.itemId)?.type === 'battle_item';
      if (keys['ArrowLeft']) {
        keys['ArrowLeft'] = false;
        if (_isBattleItem && itemTargetMode !== 'single') {
          // In multi-target mode — LEFT goes back to single (leftmost alive)
          const leftCandidates = _cnt <= 1 ? [0] : _cnt === 2 ? [0] : [0, 2];
          const found = leftCandidates.find(i => _alive(i));
          if (found !== undefined) itemTargetIndex = found;
          itemTargetMode = 'single'; playSFX(SFX.CURSOR);
        } else if (itemTargetType === 'player') {
          // Player → nearest right-col alive enemy
          if (!isRandomEncounter) {
            itemTargetType = 'enemy'; itemTargetIndex = 0; itemTargetMode = 'single'; playSFX(SFX.CURSOR);
          } else {
            const rightCandidates = _cnt === 1 ? [0] : _cnt === 2 ? [1] : _cnt === 3 ? [1] : [1, 3];
            const leftCandidates = _cnt === 2 ? [0] : _cnt === 3 ? [0, 2] : _cnt >= 4 ? [0, 2] : [];
            let found = rightCandidates.find(i => _alive(i));
            if (found === undefined) found = leftCandidates.find(i => _alive(i));
            if (found !== undefined) {
              itemTargetType = 'enemy'; itemTargetIndex = found; itemTargetMode = 'single'; playSFX(SFX.CURSOR);
            }
          }
        } else if (isRandomEncounter && _isRightCol(itemTargetIndex)) {
          // Right col → left col (same row if possible)
          const leftPeer = itemTargetIndex === 1 ? 0 : itemTargetIndex === 3 ? 2 : -1;
          const leftOther = itemTargetIndex === 1 ? 2 : itemTargetIndex === 3 ? 0 : -1;
          if (leftPeer >= 0 && _alive(leftPeer)) { itemTargetIndex = leftPeer; playSFX(SFX.CURSOR); }
          else if (leftOther >= 0 && _alive(leftOther)) { itemTargetIndex = leftOther; playSFX(SFX.CURSOR); }
          else if (_isBattleItem) { itemTargetMode = 'all'; playSFX(SFX.CURSOR); } // no left col alive → all
        } else if (_isBattleItem && isRandomEncounter && _isLeftCol(itemTargetIndex)) {
          // Already on leftmost col — toggle to all-enemies mode
          itemTargetMode = 'all'; playSFX(SFX.CURSOR);
        }
      }
      if (keys['ArrowRight']) {
        keys['ArrowRight'] = false;
        if (itemTargetType === 'enemy') {
          if (_isRightCol(itemTargetIndex) || !isRandomEncounter) {
            // Right col or boss → player
            itemTargetType = 'player'; playSFX(SFX.CURSOR);
          } else {
            // Left col → right col (same row if possible)
            const rightPeer = itemTargetIndex === 0 ? 1 : itemTargetIndex === 2 ? 3 : -1;
            const rightOther = itemTargetIndex === 0 ? 3 : itemTargetIndex === 2 ? 1 : -1;
            if (rightPeer >= 0 && _alive(rightPeer)) { itemTargetIndex = rightPeer; playSFX(SFX.CURSOR); }
            else if (rightOther >= 0 && _alive(rightOther)) { itemTargetIndex = rightOther; playSFX(SFX.CURSOR); }
            else { itemTargetType = 'player'; playSFX(SFX.CURSOR); }
          }
        }
      }
      if (keys['ArrowUp'] || keys['ArrowDown']) {
        const goUp = !!keys['ArrowUp'];
        keys['ArrowUp'] = false; keys['ArrowDown'] = false;
        if (_isBattleItem && itemTargetType === 'enemy' && isRandomEncounter && encounterMonsters) {
          if (goUp && itemTargetMode === 'single') {
            // UP from single → select column
            itemTargetMode = _isLeftCol(itemTargetIndex) ? 'col-left' : 'col-right';
            playSFX(SFX.CURSOR);
          } else if (!goUp && itemTargetMode !== 'single') {
            // DOWN from column → back to single
            itemTargetMode = 'single'; playSFX(SFX.CURSOR);
          }
        } else if (itemTargetType === 'enemy' && isRandomEncounter && encounterMonsters) {
          // Vertical: TL↔BL (0↔2), TR↔BR (1↔3)
          const vertMap = _cnt >= 4 ? { 0: 2, 2: 0, 1: 3, 3: 1 } :
                          _cnt === 3 ? { 0: 2, 2: 0, 1: 1 } : {};
          const next = vertMap[itemTargetIndex];
          if (next !== undefined && next !== itemTargetIndex && _alive(next)) {
            itemTargetIndex = next; playSFX(SFX.CURSOR);
          }
        } else if (itemTargetType === 'player') {
          const livingAllies = battleAllies.filter(a => a.hp > 0);
          if (!goUp && itemTargetAllyIndex < livingAllies.length - 1) {
            itemTargetAllyIndex++; playSFX(SFX.CURSOR);
          } else if (goUp && itemTargetAllyIndex >= 0) {
            itemTargetAllyIndex--; playSFX(SFX.CURSOR);
          }
        }
      }
      if (keys['z'] || keys['Z']) {
        keys['z'] = false; keys['Z'] = false;
        playerActionPending.target = itemTargetType === 'player' ? 'player' : itemTargetIndex;
        playerActionPending.allyIndex = itemTargetType === 'player' ? itemTargetAllyIndex : -1;
        playerActionPending.targetMode = itemTargetMode;
        playSFX(SFX.CONFIRM);
        battleState = 'item-list-out';
        battleTimer = 0;
      }
      if (keys['x'] || keys['X']) {
        keys['x'] = false; keys['X'] = false;
        playerActionPending = null;
        playSFX(SFX.CONFIRM);
        battleState = 'item-select';
        battleTimer = 0;
      }
    }
    return;
  }

  // S — toggle roster browse / handle roster input
  if (keys['s'] || keys['S']) {
    keys['s'] = false; keys['S'] = false;
    if (rosterState === 'none' && battleState === 'none' && pauseState === 'none' && transState === 'none' && !shakeActive && !starEffect && !moving && msgBoxState === 'none') {
      rosterState = 'browse';
      rosterCursor = 0;
      rosterScroll = 0;
      playSFX(SFX.CONFIRM);
    } else if (rosterState === 'browse') {
      rosterState = 'none';
      playSFX(SFX.CONFIRM);
    }
    return;
  }
  // Roster browse controls
  if (rosterState === 'browse') {
    const rp = getRosterVisible();
    if (keys['ArrowDown']) {
      keys['ArrowDown'] = false;
      if (rosterCursor < rp.length - 1) {
        rosterCursor++;
        if (rosterCursor - rosterScroll >= ROSTER_VISIBLE) rosterScroll++;
        playSFX(SFX.CURSOR);
      }
    }
    if (keys['ArrowUp']) {
      keys['ArrowUp'] = false;
      if (rosterCursor > 0) {
        rosterCursor--;
        if (rosterCursor < rosterScroll) rosterScroll--;
        playSFX(SFX.CURSOR);
      }
    }
    if (keys['z'] || keys['Z']) {
      keys['z'] = false; keys['Z'] = false;
      rosterState = 'menu-in';
      rosterMenuTimer = 0;
      rosterMenuCursor = 0;
      playSFX(SFX.CONFIRM);
    }
    if (keys['x'] || keys['X']) {
      keys['x'] = false; keys['X'] = false;
      rosterState = 'none';
      playSFX(SFX.CONFIRM);
    }
    return;
  }
  // Roster context menu controls
  if (rosterState === 'menu') {
    if (keys['ArrowDown']) {
      keys['ArrowDown'] = false;
      rosterMenuCursor = (rosterMenuCursor + 1) % ROSTER_MENU_ITEMS.length;
      playSFX(SFX.CURSOR);
    }
    if (keys['ArrowUp']) {
      keys['ArrowUp'] = false;
      rosterMenuCursor = (rosterMenuCursor + ROSTER_MENU_ITEMS.length - 1) % ROSTER_MENU_ITEMS.length;
      playSFX(SFX.CURSOR);
    }
    if (keys['z'] || keys['Z']) {
      keys['z'] = false; keys['Z'] = false;
      // TODO: handle menu action (Party/Duel/Trade/Message/Inspect)
      const action = ROSTER_MENU_ITEMS[rosterMenuCursor];
      const target = getRosterVisible()[rosterCursor];
      const actionBytes = _nameToBytes(action);
      const nameBytes = _nameToBytes(target.name);
      const sep = new Uint8Array([0xFF]);
      const msg = new Uint8Array(actionBytes.length + 1 + nameBytes.length);
      msg.set(actionBytes, 0);
      msg.set(sep, actionBytes.length);
      msg.set(nameBytes, actionBytes.length + 1);
      showMsgBox(msg);
      rosterState = 'menu-out';
      rosterMenuTimer = 0;
      playSFX(SFX.CONFIRM);
    }
    if (keys['x'] || keys['X']) {
      keys['x'] = false; keys['X'] = false;
      rosterState = 'menu-out';
      rosterMenuTimer = 0;
      playSFX(SFX.CONFIRM);
    }
    return;
  }
  if (rosterState === 'menu-in' || rosterState === 'menu-out') return; // block input during slide

  // Enter — open pause menu
  if (keys['Enter']) {
    keys['Enter'] = false;
    if (pauseState === 'none' && battleState === 'none' && transState === 'none' && !shakeActive && !starEffect && !moving) {
      playSFX(SFX.CONFIRM);
      pauseMusic();
      playFF1Track(FF1_TRACKS.MENU_SCREEN);
      pauseState = 'scroll-in'; pauseTimer = 0; pauseCursor = 0;
    }
    return;
  }
  // X — close pause menu (back button) — only from main menu, not sub-states
  if (keys['x'] || keys['X']) {
    if (pauseState === 'open') {
      keys['x'] = false; keys['X'] = false;
      playSFX(SFX.CONFIRM);
      pauseState = 'text-out'; pauseTimer = 0;
      return;
    }
    // Don't consume X here — let sub-state handlers below handle it
  }
  // Pause menu cursor controls
  if (pauseState === 'open') {
    if (keys['ArrowDown']) { keys['ArrowDown'] = false; pauseCursor = (pauseCursor + 1) % 6; playSFX(SFX.CURSOR); }
    if (keys['ArrowUp'])   { keys['ArrowUp'] = false;   pauseCursor = (pauseCursor + 5) % 6; playSFX(SFX.CURSOR); }
    if (keys['z'] || keys['Z']) {
      keys['z'] = false; keys['Z'] = false;
      if (pauseCursor === 0) {
        // Item — fade out pause text, then expand to inventory
        playSFX(SFX.CONFIRM);
        pauseState = 'inv-text-out'; pauseTimer = 0; pauseInvScroll = 0;
      } else if (pauseCursor === 2) {
        // Equip — fade out pause text, then expand to equip slots
        playSFX(SFX.CONFIRM);
        pauseState = 'eq-text-out'; pauseTimer = 0; eqCursor = 0;
      }
    }
    return;
  }
  // Inventory sub-state — only accept input when fully open
  if (pauseState === 'inventory') {
    const entries = Object.entries(playerInventory).filter(([,c]) => c > 0);
    if (keys['ArrowDown']) {
      keys['ArrowDown'] = false;
      if (pauseInvScroll < entries.length - 1) { pauseInvScroll++; playSFX(SFX.CURSOR); }
    }
    if (keys['ArrowUp']) {
      keys['ArrowUp'] = false;
      if (pauseInvScroll > 0) { pauseInvScroll--; playSFX(SFX.CURSOR); }
    }
    if (keys['z'] || keys['Z']) {
      keys['z'] = false; keys['Z'] = false;
      if (pauseHeldItem === -1) {
        // Nothing held — pick up
        if (entries.length > 0 && entries[pauseInvScroll]) {
          pauseHeldItem = pauseInvScroll;
          playSFX(SFX.CONFIRM);
        } else {
          playSFX(SFX.ERROR);
        }
      } else if (pauseHeldItem === pauseInvScroll) {
        // Same slot — use consumable → target select, or deselect
        const [id] = entries[pauseHeldItem];
        const item = ITEMS.get(Number(id));
        if (item && item.type === 'consumable') {
          playSFX(SFX.CONFIRM);
          pauseHeldItem = -1;
          pauseState = 'inv-target'; pauseTimer = 0;
          pauseUseItemId = Number(id);
          pauseInvAllyTarget = -1;
        } else {
          pauseHeldItem = -1;
          playSFX(SFX.CONFIRM);
        }
      } else {
        // Different slot — move hold
        if (entries[pauseInvScroll]) {
          pauseHeldItem = pauseInvScroll;
          playSFX(SFX.CONFIRM);
        } else {
          pauseHeldItem = -1;
          playSFX(SFX.ERROR);
        }
      }
    }
    if (keys['x'] || keys['X']) {
      keys['x'] = false; keys['X'] = false;
      if (pauseHeldItem !== -1) {
        pauseHeldItem = -1;
        playSFX(SFX.CONFIRM);
      } else {
        playSFX(SFX.CONFIRM);
        pauseState = 'inv-items-out'; pauseTimer = 0;
      }
    }
    return;
  }
  // Inventory target select — cursor on player portrait, Z to confirm, X to cancel back
  if (pauseState === 'inv-target') {
    const rosterTargets = getRosterVisible();
    if (keys['ArrowDown']) {
      keys['ArrowDown'] = false;
      if (pauseInvAllyTarget < rosterTargets.length - 1) { pauseInvAllyTarget++; playSFX(SFX.CURSOR); }
    }
    if (keys['ArrowUp']) {
      keys['ArrowUp'] = false;
      if (pauseInvAllyTarget > -1) { pauseInvAllyTarget--; playSFX(SFX.CURSOR); }
    }
    if (keys['z'] || keys['Z']) {
      keys['z'] = false; keys['Z'] = false;
      const item = ITEMS.get(pauseUseItemId);
      if (item && item.effect === 'restore_hp') {
        if (pauseInvAllyTarget >= 0) {
          // Heal selected roster player
          const rp = rosterTargets[pauseInvAllyTarget];
          if (rp) {
            const heal = Math.min(item.value, rp.maxHP - rp.hp);
            rp.hp += heal;
            removeItem(pauseUseItemId);
            playSFX(SFX.CURE);
            pauseHealNum = { value: heal, timer: 0, rosterIdx: pauseInvAllyTarget };
            pauseState = 'inv-heal'; pauseTimer = 0;
            if (selectCursor >= 0 && saveSlots[selectCursor]) {
              saveSlots[selectCursor].inventory = { ...playerInventory };
              saveSlotsToDB();
            }
          } else {
            playSFX(SFX.ERROR);
          }
        } else {
          // Heal player
          const heal = Math.min(item.value, playerStats.maxHP - playerHP);
          playerHP += heal;
          removeItem(pauseUseItemId);
          playSFX(SFX.CURE);
          pauseHealNum = { value: heal, timer: 0 };
          pauseState = 'inv-heal'; pauseTimer = 0;
          if (selectCursor >= 0 && saveSlots[selectCursor]) {
            saveSlots[selectCursor].hp = playerHP;
            saveSlots[selectCursor].inventory = { ...playerInventory };
            saveSlotsToDB();
          }
        }
      } else {
        playSFX(SFX.ERROR);
      }
    }
    if (keys['x'] || keys['X']) {
      keys['x'] = false; keys['X'] = false;
      pauseState = 'inventory'; pauseTimer = 0;
      pauseHeldItem = -1;
      playSFX(SFX.CONFIRM);
    }
    return;
  }
  // Heal animation — block input until done
  if (pauseState === 'inv-heal') return;
  // Block input during inventory transitions
  if (pauseState.startsWith('inv-')) return;
  // Equip slot selection
  if (pauseState === 'equip') {
    if (keys['ArrowDown']) { keys['ArrowDown'] = false; eqCursor = (eqCursor + 1) % 6; playSFX(SFX.CURSOR); }
    if (keys['ArrowUp'])   { keys['ArrowUp'] = false;   eqCursor = (eqCursor + 5) % 6; playSFX(SFX.CURSOR); }
    if (keys['z'] || keys['Z']) {
      keys['z'] = false; keys['Z'] = false;
      if (eqCursor === 5) {
        // Optimum — auto-equip best gear in every slot
        const SLOT_DEFS = [
          { eq: -100, type: 'hand', stat: 'atk' },
          { eq: -102, type: 'armor', subtype: 'helmet', stat: 'def' },
          { eq: -103, type: 'armor', subtype: 'body',   stat: 'def' },
          { eq: -104, type: 'armor', subtype: 'arms',   stat: 'def' },
        ];
        for (const sd of SLOT_DEFS) {
          let bestId = 0, bestVal = 0;
          const curId = getEquipSlotId(sd.eq);
          const curItem = ITEMS.get(curId);
          if (curItem) bestVal = curItem[sd.stat] || 0;
          bestId = curId;
          for (const [idStr, count] of Object.entries(playerInventory)) {
            if (count <= 0) continue;
            const id = Number(idStr);
            const item = ITEMS.get(id);
            if (!item) continue;
            if (sd.type === 'hand' && !isHandEquippable(item)) continue;
            if (sd.type === 'armor' && (item.type !== 'armor' || item.subtype !== sd.subtype)) continue;
            const val = item[sd.stat] || 0;
            if (val > bestVal) { bestVal = val; bestId = id; }
          }
          if (bestId !== curId) {
            if (curId !== 0) addItem(curId, 1);
            if (bestId !== 0) { setEquipSlotId(sd.eq, bestId); removeItem(bestId); }
            else setEquipSlotId(sd.eq, 0);
          }
        }
        // L.Hand: prefer best weapon (atk), fall back to best shield (def) if no weapon found
        {
          const curId = getEquipSlotId(-101);
          let bestWepId = 0, bestWepAtk = 0;
          let bestShieldId = 0, bestShieldDef = 0;
          const curItem = ITEMS.get(curId);
          if (curItem && curItem.type === 'weapon') bestWepAtk = curItem.atk || 0, bestWepId = curId;
          else if (curItem && curItem.subtype === 'shield') bestShieldDef = curItem.def || 0, bestShieldId = curId;
          for (const [idStr, count] of Object.entries(playerInventory)) {
            if (count <= 0) continue;
            const id = Number(idStr);
            const item = ITEMS.get(id);
            if (!item || !isHandEquippable(item)) continue;
            if (item.type === 'weapon') { const v = item.atk || 0; if (v > bestWepAtk) { bestWepAtk = v; bestWepId = id; } }
            else if (item.subtype === 'shield') { const v = item.def || 0; if (v > bestShieldDef) { bestShieldDef = v; bestShieldId = id; } }
          }
          const bestId = bestShieldId !== 0 ? bestShieldId : bestWepId;
          if (bestId !== curId) {
            if (curId !== 0) addItem(curId, 1);
            if (bestId !== 0) { setEquipSlotId(-101, bestId); removeItem(bestId); }
            else setEquipSlotId(-101, 0);
          }
        }
        playerATK = playerStats.str + (ITEMS.get(playerWeaponR)?.atk || 0) + (ITEMS.get(playerWeaponL)?.atk || 0);
        recalcDEF();
        if (selectCursor >= 0 && saveSlots[selectCursor]) {
          saveSlots[selectCursor].inventory = { ...playerInventory };
          saveSlotsToDB();
        }
        playSFX(SFX.CONFIRM);
      } else {
        playSFX(SFX.CONFIRM);
        // Build filtered item list for this slot
        eqSlotIdx = -100 - eqCursor;
        const isWeaponSlot = eqSlotIdx >= -101;
        const slotSubtype = EQUIP_SLOT_SUBTYPE[String(eqSlotIdx)];
        eqItemList = [];
        // First entry: "(Remove)" if slot has something equipped
        const currentId = getEquipSlotId(eqSlotIdx);
        if (currentId !== 0) eqItemList.push({ id: 0, label: 'remove' });
        // Add matching items from inventory
        for (const [idStr, count] of Object.entries(playerInventory)) {
          if (count <= 0) continue;
          const id = Number(idStr);
          const item = ITEMS.get(id);
          if (!item) continue;
          if (isWeaponSlot && isHandEquippable(item)) eqItemList.push({ id, count });
          else if (!isWeaponSlot && item.type === 'armor' && item.subtype === slotSubtype) eqItemList.push({ id, count });
        }
        eqItemCursor = 0;
        pauseState = 'eq-items-in'; pauseTimer = 0;
      }
    }
    if (keys['x'] || keys['X']) {
      keys['x'] = false; keys['X'] = false;
      playSFX(SFX.CONFIRM);
      pauseState = 'eq-slots-out'; pauseTimer = 0;
    }
    return;
  }
  // Equip item selection
  if (pauseState === 'eq-item-select') {
    if (keys['ArrowDown']) { keys['ArrowDown'] = false; if (eqItemCursor < eqItemList.length - 1) { eqItemCursor++; playSFX(SFX.CURSOR); } }
    if (keys['ArrowUp'])   { keys['ArrowUp'] = false;   if (eqItemCursor > 0) { eqItemCursor--; playSFX(SFX.CURSOR); } }
    if (keys['z'] || keys['Z']) {
      keys['z'] = false; keys['Z'] = false;
      const pick = eqItemList[eqItemCursor];
      if (pick) {
        const oldId = getEquipSlotId(eqSlotIdx);
        if (pick.label === 'remove') {
          // Unequip
          setEquipSlotId(eqSlotIdx, 0);
          if (oldId !== 0) addItem(oldId, 1);
        } else {
          // Equip new item
          setEquipSlotId(eqSlotIdx, pick.id);
          removeItem(pick.id);
          if (oldId !== 0) addItem(oldId, 1);
        }
        playerATK = playerStats.str + (ITEMS.get(playerWeaponR)?.atk || 0) + (ITEMS.get(playerWeaponL)?.atk || 0);
        recalcDEF();
        // Save
        if (selectCursor >= 0 && saveSlots[selectCursor]) {
          saveSlots[selectCursor].inventory = { ...playerInventory };
          saveSlotsToDB();
        }
        playSFX(SFX.CONFIRM);
      }
      pauseState = 'eq-items-out'; pauseTimer = 0;
    }
    if (keys['x'] || keys['X']) {
      keys['x'] = false; keys['X'] = false;
      playSFX(SFX.CONFIRM);
      pauseState = 'eq-items-out'; pauseTimer = 0;
    }
    return;
  }
  // Block input during equip transitions
  if (pauseState.startsWith('eq-')) return;
  // Block all input during pause transitions
  if (pauseState !== 'none') return;

  // Universal message box — Z to dismiss during hold
  if (msgBoxState !== 'none') {
    if (msgBoxState === 'hold' && (keys['z'] || keys['Z'])) {
      keys['z'] = false; keys['Z'] = false;
      msgBoxState = 'slide-out'; msgBoxTimer = 0;
    }
    return;
  }

  if (moving) return;
  if (transState !== 'none') return;
  if (shakeActive) return;
  if (starEffect) return;
  if (chatExpanded) return;

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
    // Rarity-based loot — same pool any floor
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
    addItem(itemId, 1);
    playSFX(SFX.TREASURE);
    const itemName = getItemNameClean(itemId);
    const found = [0x8F, 0xD8, 0xDE, 0xD7, 0xCD, 0xFF]; // "Found "
    const msg = new Uint8Array(found.length + itemName.length + 1);
    msg.set(found, 0);
    msg.set(itemName, found.length);
    msg[found.length + itemName.length] = 0xC4; // "!"
    showMsgBox(msg);
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
            }, 'world');
          }
        };
        return;
      }
    }

    // Check for trigger at current tile
    if (checkTrigger()) return; // transition happened, skip input chaining

    // Random encounter step counter — dungeon floors 0-3 and world map grasslands
    if (battleState === 'none') {
      const inDungeon = dungeonFloor >= 0 && dungeonFloor < 4;
      const onGrass = onWorldMap && worldMapRenderer && (() => {
        const tileX = Math.floor(worldX / TILE_SIZE);
        const tileY = Math.floor(worldY / TILE_SIZE);
        return !worldMapRenderer.getTriggerAt(tileX, tileY);
      })();
      if (inDungeon || onGrass) {
        encounterSteps++;
        const threshold = onGrass
          ? 20 + Math.floor(Math.random() * 20)   // world map: 20-39 steps
          : 15 + Math.floor(Math.random() * 15);  // dungeon: 15-29 steps
        if (encounterSteps >= threshold) {
          encounterSteps = 0;
          startRandomEncounter();
          return;
        }
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

function startWipeTransition(action, destMapId) {
  transState = 'closing';
  transTimer = 0;
  // Determine if roster should fade (only when location actually changes)
  const curLoc = getPlayerLocation();
  rosterLocChanged = destMapId != null && _rosterLocForMapId(destMapId) !== curLoc;
  transPendingAction = action;
  playSFX(SFX.SCREEN_CLOSE);
}

function updateTransition(dt) {
  if (transState === 'none') return;

  transTimer += dt;

  if (transState === 'hud-fade-in') {
    if (transTimer >= (HUD_INFO_FADE_STEPS + 1) * HUD_INFO_FADE_STEP_MS) {
      transState = 'opening';
      transTimer = 0;
      playSFX(SFX.SCREEN_OPEN);
    }
    return;
  } else if (transState === 'trap-reveal') {
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
      rosterLocChanged = false;
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
  if (transState === 'hud-fade-in') {
    // Keep viewport blacked out while HUD borders fade in
    ctx.fillStyle = '#000';
    ctx.fillRect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);
    return;
  }

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

    // Bordered box with floors label + boss sprite + HP, centered in viewport
    const floorsBytes = new Uint8Array([0x84,0xFF,0x95,0xCE,0xDF,0xCE,0xD5,0xDC]); // "4 Levels"
    const hpBytes = new Uint8Array([0x91,0x99,0xFF,0xC5,0xC5,0xC5,0xC5,0xC5]); // "HP ?????"
    const hpW = measureText(hpBytes);
    const bossRowW = 16 + 4 + hpW; // boss sprite 16px + gap + HP text
    const infoBoxW = Math.ceil(Math.max(bossRowW + 16, 80) / 8) * 8; // pad + snap to 8px
    const infoBoxH = 48; // 8 border + 10 text + 4 gap + 16 boss + 2 pad + 8 border = 48
    const infoBoxX = Math.round(cx - infoBoxW / 2);
    const infoBoxY = Math.round(vpTop + (vpBot - vpTop) / 2 - infoBoxH / 2);
    // Draw bordered box with fade
    if (borderFadeSets && fadeLevel < borderFadeSets.length) {
      const fset = borderFadeSets[fadeLevel];
      const [fTL, fTOP, fTR, fLEFT, fRIGHT, fBL, fBOT, fBR, fFILL] = fset;
      // Interior fill (black)
      for (let ty = infoBoxY + 8; ty < infoBoxY + infoBoxH - 8; ty += 8)
        for (let tx = infoBoxX + 8; tx < infoBoxX + infoBoxW - 8; tx += 8)
          ctx.drawImage(fFILL, tx, ty);
      ctx.drawImage(fTL, infoBoxX, infoBoxY);
      ctx.drawImage(fTR, infoBoxX + infoBoxW - 8, infoBoxY);
      ctx.drawImage(fBL, infoBoxX, infoBoxY + infoBoxH - 8);
      ctx.drawImage(fBR, infoBoxX + infoBoxW - 8, infoBoxY + infoBoxH - 8);
      for (let tx = infoBoxX + 8; tx < infoBoxX + infoBoxW - 8; tx += 8) {
        ctx.drawImage(fTOP, tx, infoBoxY);
        ctx.drawImage(fBOT, tx, infoBoxY + infoBoxH - 8);
      }
      for (let ty = infoBoxY + 8; ty < infoBoxY + infoBoxH - 8; ty += 8) {
        ctx.drawImage(fLEFT, infoBoxX, ty);
        ctx.drawImage(fRIGHT, infoBoxX + infoBoxW - 8, ty);
      }
    }
    // "4 Levels" centered in box
    const floorsW = measureText(floorsBytes);
    drawText(ctx, infoBoxX + Math.floor((infoBoxW - floorsW) / 2), infoBoxY + 10, floorsBytes, fadedTextPal);
    // Boss sprite + HP below floors text
    const bossContentX = infoBoxX + Math.floor((infoBoxW - bossRowW) / 2);
    const bossRowY = infoBoxY + 22;
    if (bossFadeFrames) {
      const bFrame = Math.floor(transTimer / 400) & 1;
      ctx.drawImage(bossFadeFrames[fadeLevel][bFrame], bossContentX, bossRowY);
    } else if (adamantoiseFrames) {
      ctx.drawImage(adamantoiseFrames[0], bossContentX, bossRowY);
    }
    drawText(ctx, bossContentX + 20, bossRowY + 4, hpBytes, fadedTextPal);

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
      }, finalDest);
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
      rosterLocChanged = _rosterLocForMapId(dest.mapId) !== getPlayerLocation();
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
        const prevMapId = mapStack.length > 0 ? mapStack[mapStack.length - 1].mapId : null;
        startWipeTransition(() => {
          if (mapStack.length > 0) {
            const prev = mapStack.pop();
            loadMapById(prev.mapId, prev.x / TILE_SIZE, prev.y / TILE_SIZE);
            if (prev.mapId >= 1000 && prev.mapId < 1004) playTrack(TRACKS.CRYSTAL_CAVE);
          }
        }, prevMapId);
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
        rosterLocChanged = _rosterLocForMapId(dest.mapId) !== getPlayerLocation();
        transPendingAction = () => {
          mapStack.push({ mapId: currentMapId, x: savedX, y: savedY });
          loadMapById(dest.mapId);
        };
      } else {
        startWipeTransition(() => {
          mapStack.push({ mapId: currentMapId, x: savedX, y: savedY });
          loadMapById(dest.mapId);
        }, dest.mapId);
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
      rosterLocChanged = _rosterLocForMapId(destMap) !== getPlayerLocation();
      transPendingAction = () => {
        mapStack.push({ mapId: currentMapId, x: savedX, y: savedY });
        loadMapById(destMap);
      };
    } else {
      // Non-door entrance (well, stairs, etc.) — just wipe
      startWipeTransition(() => {
        mapStack.push({ mapId: currentMapId, x: savedX, y: savedY });
        loadMapById(destMap);
      }, destMap);
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
      }, dest.mapId);
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
      const exitDestMapId = mapStack.length > 0 ? mapStack[mapStack.length - 1].mapId : 'world';
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
      }, exitDestMapId);
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
  if ((transState === 'none' || transState === 'trap-reveal') && (battleState === 'none' || battleState === 'flash-strobe' || battleState.startsWith('roar-'))) {
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
  const isTitleActive = titleState !== 'done';
  if (isTitleActive && titleHudCanvas) {
    // Compute border fade level for title states
    let tfl = 0; // 0 = full brightness — only fade out when leaving title
    if (titleState === 'main-out') {
      tfl = Math.min(Math.floor(titleTimer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
    }
    if (tfl > 0 && titleHudFadeCanvases && tfl <= titleHudFadeCanvases.length) {
      // Draw faded viewport border + full-brightness bottom box
      ctx.drawImage(titleHudFadeCanvases[tfl - 1], 0, 0);
      // Bottom box from full-brightness canvas (clip to bottom area only)
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, HUD_BOT_Y, CANVAS_W, HUD_BOT_H);
      ctx.clip();
      ctx.drawImage(titleHudCanvas, 0, 0);
      ctx.restore();
    } else {
      ctx.drawImage(titleHudCanvas, 0, 0);
    }
  } else if (hudCanvas) {
    // Game-start border fade-in
    const borderFade = HUD_INFO_FADE_STEPS - Math.min(Math.floor(hudInfoFadeTimer / HUD_INFO_FADE_STEP_MS), HUD_INFO_FADE_STEPS);
    if (borderFade > 0 && hudFadeCanvases && borderFade <= hudFadeCanvases.length) {
      ctx.drawImage(hudFadeCanvases[borderFade - 1], 0, 0);
      // Bottom box always full brightness
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, HUD_BOT_Y, CANVAS_W, HUD_BOT_H);
      ctx.clip();
      ctx.drawImage(hudCanvas, 0, 0);
      ctx.restore();
    } else {
      ctx.drawImage(hudCanvas, 0, 0);
    }
  }

  // Top box content (full 256×32, no static border — border only with text)
  // Title screen handles its own top box (sky BG)
  if (titleState !== 'done') return;

  // Top box layers: (1) battle BG base, (2) transition fade, (3) border+text overlay
  const isFading = topBoxScrollState === 'fade-in' || topBoxScrollState === 'display' || topBoxScrollState === 'fade-out';

  // (1) Non-town battle BG: always draw as base layer (full 256×32)
  // Shake horizontally when player is hit during battle
  const topShake = (battleState === 'enemy-attack' && battleShakeTimer > 0)
    ? (Math.floor(battleShakeTimer / 67) & 1 ? 2 : -2) : 0;
  if (transState !== 'loading' && !topBoxIsTown && topBoxBgCanvas) {
    ctx.drawImage(topBoxBgCanvas, topShake, 0);
  }

  // (2) NES palette fade on battle BG during transitions — drawn BEFORE border so border stays on top
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
      ctx.drawImage(topBoxBgFadeFrames[fadeStep], 0, 0);
    }
  }

  // Round battle BG corners to match border tile shape
  if (!topBoxIsTown && transState !== 'loading') {
    roundTopBoxCorners();
  }

  // (3) Border + text overlay
  if (transState === 'loading') {
    // Loading screen: border fades with loading content
    let loadFade = LOAD_FADE_MAX;
    if (loadingFadeState === 'in') {
      loadFade = LOAD_FADE_MAX - Math.min(Math.floor(loadingFadeTimer / LOAD_FADE_STEP_MS), LOAD_FADE_MAX);
    } else if (loadingFadeState === 'visible') {
      loadFade = 0;
    } else if (loadingFadeState === 'out') {
      loadFade = Math.min(Math.floor(loadingFadeTimer / LOAD_FADE_STEP_MS), LOAD_FADE_MAX);
    }
    drawTopBoxBorder(loadFade);
    // Text fades with name fade (isFading block below) or loading content
    if (topBoxNameBytes && !isFading) {
      const fadedPal = [0x0F, 0x0F, 0x0F, 0x30];
      for (let s = 0; s < loadFade; s++) fadedPal[3] = nesColorFade(fadedPal[3]);
      const tw = measureText(topBoxNameBytes);
      const tx = 8 + Math.floor((240 - tw) / 2);
      const ty = 8 + Math.floor((16 - 8) / 2);
      drawText(ctx, tx, ty, topBoxNameBytes, fadedPal);
    }
  } else if (topBoxIsTown && topBoxMode === 'name' && topBoxNameBytes) {
    // Town: border fades in/out with text, stays at full brightness when permanent
    if (isFading) {
      // fade-in or fade-out: border tracks topBoxFadeStep
      drawTopBoxBorder(topBoxFadeStep);
    } else if (topBoxScrollState !== 'pending') {
      // Permanent display (after fade-in completed)
      drawTopBoxBorder(0);
    }
    // pending: no border, no text (waits for fade-in)
    if (!isFading && topBoxScrollState !== 'pending') {
      const tw = measureText(topBoxNameBytes);
      const tx = 8 + Math.floor((240 - tw) / 2);
      const ty = 8 + Math.floor((16 - 8) / 2);
      drawText(ctx, tx, ty, topBoxNameBytes, TEXT_WHITE);
    }
  }

  // Fading name text overlay — NES discrete palette steps
  if (isFading && topBoxNameBytes) {
    // Non-town, non-loading: draw border fading with text
    if (transState !== 'loading' && !topBoxIsTown) {
      drawTopBoxBorder(topBoxFadeStep);
    }
    const fadedPal = [0x0F, 0x0F, 0x0F, 0x30];
    for (let s = 0; s < topBoxFadeStep; s++) {
      fadedPal[3] = nesColorFade(fadedPal[3]);
    }
    const tw = measureText(topBoxNameBytes);
    const tx = 8 + Math.floor((240 - tw) / 2);
    const ty = 8 + Math.floor((16 - 8) / 2);
    drawText(ctx, tx, ty, topBoxNameBytes, fadedPal);
  }

  // HUD info fade-in (portrait + HP/MP)
  const infoFadeStep = HUD_INFO_FADE_STEPS - Math.min(Math.floor(hudInfoFadeTimer / HUD_INFO_FADE_STEP_MS), HUD_INFO_FADE_STEPS);

  // Portrait shake offset during enemy-attack
  const shakeOff = (battleState === 'enemy-attack' && battleShakeTimer > 0)
    ? (Math.floor(battleShakeTimer / 67) & 1 ? 2 : -2) : 0;

  // Portrait drawn in drawBattle() above border layer — just draw idle here during non-battle
  if (battleState === 'none' && battleSpriteCanvas) {
    const isPauseHeal = pauseState === 'inv-heal';
    const isPauseTarget = pauseState === 'inv-target';
    let nfPortrait;
    if (isPauseHeal && battleSpriteDefendCanvas) {
      nfPortrait = battleSpriteDefendCanvas;
    } else {
      nfPortrait = (playerHP > 0 && playerStats && playerHP <= Math.floor(playerStats.maxHP / 4) && battleSpriteKneelCanvas)
        ? battleSpriteKneelCanvas : battleSpriteCanvas;
    }
    const px = HUD_RIGHT_X + 8;
    const py = HUD_VIEW_Y + 8;
    if (infoFadeStep === 0) {
      ctx.drawImage(nfPortrait, px, py);
      if (!isPauseHeal && nfPortrait === battleSpriteKneelCanvas && sweatFrames.length === 2) {
        const swi = Math.floor(Date.now() / 133) & 1;
        ctx.drawImage(sweatFrames[swi], px, py - 3);
      }
    } else if (infoFadeStep < HUD_INFO_FADE_STEPS) {
      ctx.globalAlpha = 1 - infoFadeStep / HUD_INFO_FADE_STEPS;
      ctx.drawImage(nfPortrait, px, py);
      if (!isPauseHeal && nfPortrait === battleSpriteKneelCanvas && sweatFrames.length === 2) {
        const swi = Math.floor(Date.now() / 133) & 1;
        ctx.drawImage(sweatFrames[swi], px, py - 3);
      }
      ctx.globalAlpha = 1;
    }
    // Cure sparkle during pause heal — 16×16 config A/B alternating every 67ms
    if (isPauseHeal && cureSparkleFrames.length === 2 && !(pauseHealNum && pauseHealNum.rosterIdx >= 0)) { // sparkles on player only when healing self
      const fi = Math.floor(pauseTimer / 67) & 1;
      const frame = cureSparkleFrames[fi];
      // TL
      ctx.drawImage(frame, px - 8, py - 7);
      // TR: H-flip
      ctx.save(); ctx.scale(-1, 1);
      ctx.drawImage(frame, -(px + 23), py - 7);
      ctx.restore();
      // BL: V-flip
      ctx.save(); ctx.scale(1, -1);
      ctx.drawImage(frame, px - 8, -(py + 24));
      ctx.restore();
      // BR: HV-flip
      ctx.save(); ctx.scale(-1, -1);
      ctx.drawImage(frame, -(px + 23), -(py + 24));
      ctx.restore();
    }
    // Green heal number bounce during pause heal (player only)
    if (pauseHealNum && !(pauseHealNum.rosterIdx >= 0)) {
      const hpx = px + 8;
      const baseY = py + 8;
      const hpy = _dmgBounceY(baseY, pauseHealNum.timer);
      const digits = String(pauseHealNum.value);
      const numBytes = new Uint8Array(digits.length);
      for (let i = 0; i < digits.length; i++) numBytes[i] = 0x80 + parseInt(digits[i]);
      const tw = digits.length * 8;
      drawText(ctx, hpx - Math.floor(tw / 2), hpy, numBytes, [0x0F, 0x0F, 0x0F, 0x2B]);
    }
  }
  // Name + Level in right mini-right panel (right-aligned, like roster players)
  const sy = HUD_VIEW_Y + 8;       // interior y
  const panelRight = HUD_RIGHT_X + HUD_RIGHT_W - 8 + shakeOff; // right edge of interior
  const infoPal = [0x0F, 0x0F, 0x0F, 0x30];
  for (let s = 0; s < infoFadeStep; s++) {
    infoPal[3] = nesColorFade(infoPal[3]);
  }
  const slot = saveSlots[selectCursor];
  if (slot) {
    const nameW = measureText(slot.name);
    drawText(ctx, panelRight - nameW, sy, slot.name, infoPal);
    // Level fades out as battle starts, HP fades in (and vice versa)
    const lvFadeStep = infoFadeStep + hudHpLvStep;           // 0=visible → 4+=black
    if (hudHpLvStep < 4) {
      const lvLabel = _nameToBytes('Lv' + String(playerStats ? playerStats.level : slot.level));
      const lvPal = [0x0F, 0x0F, 0x0F, 0x10];
      for (let s = 0; s < lvFadeStep; s++) lvPal[3] = nesColorFade(lvPal[3]);
      const lvW = measureText(lvLabel);
      drawText(ctx, panelRight - lvW, sy + 9, lvLabel, lvPal);
    }
    if (hudHpLvStep > 0) {
      const maxHP = playerStats ? playerStats.maxHP : 28;
      const hpNes = playerHP <= Math.floor(maxHP / 4) ? 0x16
                  : playerHP <= Math.floor(maxHP / 2) ? 0x28 : 0x2A;
      const hpFadeStep = infoFadeStep + (4 - hudHpLvStep);  // 4=black → 0=visible
      const hpPal = [0x0F, 0x0F, 0x0F, hpNes];
      for (let s = 0; s < hpFadeStep; s++) hpPal[3] = nesColorFade(hpPal[3]);
      const hpLabel = _nameToBytes(String(playerHP));
      const hpW = measureText(hpLabel);
      drawText(ctx, panelRight - hpW, sy + 9, hpLabel, hpPal);
    }
  }

  // Moogle + chat bubble in right main panel during loading screen
  if (transState === 'loading' && loadingFadeState !== 'none') {
    let fadeLevel = 0;
    if (loadingFadeState === 'in') {
      const step = Math.min(Math.floor(loadingFadeTimer / LOAD_FADE_STEP_MS), LOAD_FADE_MAX);
      fadeLevel = LOAD_FADE_MAX - step;
    } else if (loadingFadeState === 'out') {
      fadeLevel = Math.min(Math.floor(loadingFadeTimer / LOAD_FADE_STEP_MS), LOAD_FADE_MAX);
    }
    // Draw right main panel box (only shown during loading screen)
    const _lbTiles = (borderFadeSets && borderFadeSets[fadeLevel]) || borderTileCanvases;
    if (_lbTiles) {
      const [lTL, lTOP, lTR, lLEFT, lRIGHT, lBL, lBOT, lBR, lFILL] = _lbTiles;
      const lx = HUD_RIGHT_X, ly = HUD_VIEW_Y + 32, lw = HUD_RIGHT_W, lh = HUD_VIEW_H - 32;
      ctx.drawImage(lTL, lx, ly); ctx.drawImage(lTR, lx + lw - 8, ly);
      ctx.drawImage(lBL, lx, ly + lh - 8); ctx.drawImage(lBR, lx + lw - 8, ly + lh - 8);
      for (let tx = lx + 8; tx < lx + lw - 8; tx += 8) { ctx.drawImage(lTOP, tx, ly); ctx.drawImage(lBOT, tx, ly + lh - 8); }
      for (let ty = ly + 8; ty < ly + lh - 8; ty += 8) { ctx.drawImage(lLEFT, lx, ty); ctx.drawImage(lRIGHT, lx + lw - 8, ty); }
      for (let ty = ly + 8; ty < ly + lh - 8; ty += 8) for (let tx = lx + 8; tx < lx + lw - 8; tx += 8) ctx.drawImage(lFILL, tx, ty);
    }
    const beatBytes = new Uint8Array([0x8B,0xCE,0xCA,0xDD,0xFF,0xDD,0xD1,0xCE]); // "Beat the"
    const bossBytes = new Uint8Array([0x8B,0xD8,0xDC,0xDC,0xFF,0x94,0xDE,0xD9,0xD8,0xC4]); // "Boss Kupo!"
    const rpX = HUD_RIGHT_X; // right panel x
    const rpY = HUD_VIEW_Y + 32; // below portrait/HP panels
    const rpW = HUD_RIGHT_W; // 112
    const rpCX = rpX + Math.floor(rpW / 2); // center x of right panel

    // Chat bubble — centered in right panel
    let fadedWhite = 0x30;
    for (let s = 0; s < fadeLevel; s++) fadedWhite = nesColorFade(fadedWhite);
    const whiteRgb = NES_SYSTEM_PALETTE[fadedWhite] || [0, 0, 0];
    ctx.fillStyle = `rgb(${whiteRgb[0]},${whiteRgb[1]},${whiteRgb[2]})`;
    const beatW = measureText(beatBytes);
    const bossW = measureText(bossBytes);
    const bgW = Math.max(beatW, bossW) + 6;
    const bubbleX = Math.round(rpCX - bgW / 2);
    const moogleSectionH = 22 + 5 + 16; // bubble + triangle + moogle
    const rpH = HUD_VIEW_H - 32; // right main panel height (112)
    const bubbleY = rpY + Math.floor((rpH - moogleSectionH) / 2);
    ctx.beginPath();
    ctx.roundRect(bubbleX, bubbleY, bgW, 22, 4);
    ctx.fill();
    // Triangle pointing down toward moogle (centered)
    const triCX = Math.round(bubbleX + bgW / 2);
    ctx.beginPath();
    ctx.moveTo(triCX - 4, bubbleY + 22);
    ctx.lineTo(triCX, bubbleY + 27);
    ctx.lineTo(triCX + 4, bubbleY + 22);
    ctx.fill();
    // Chat text
    const blackTextPal = [0x0F, fadedWhite, fadedWhite, 0x0F];
    drawText(ctx, bubbleX + 3, bubbleY + 2, beatBytes, blackTextPal);
    drawText(ctx, bubbleX + 3, bubbleY + 12, bossBytes, blackTextPal);

    // Moogle sprite below chat bubble
    const moogleX = Math.round(rpCX - 8); // center 16px sprite
    const moogleY = bubbleY + 30;
    if (moogleFadeFrames) {
      const mFrame = Math.floor(transTimer / 400) & 1;
      ctx.drawImage(moogleFadeFrames[fadeLevel][mFrame], moogleX, moogleY);
    }
  }
}

// ── Player Roster (right main panel) ──

// Draw a HUD border box on the main canvas ctx, with optional NES fade step
function _drawHudBox(x, y, w, h, fadeStep = 0) {
  const tiles = (fadeStep > 0 && borderFadeSets) ? borderFadeSets[fadeStep] : borderTileCanvases;
  if (!tiles) return;
  const [TL, TOP, TR, LEFT, RIGHT, BL, BOT, BR, FILL] = tiles;
  ctx.drawImage(TL, x, y); ctx.drawImage(TR, x + w - 8, y);
  ctx.drawImage(BL, x, y + h - 8); ctx.drawImage(BR, x + w - 8, y + h - 8);
  for (let tx = x + 8; tx < x + w - 8; tx += 8) { ctx.drawImage(TOP, tx, y); ctx.drawImage(BOT, tx, y + h - 8); }
  for (let ty = y + 8; ty < y + h - 8; ty += 8) { ctx.drawImage(LEFT, x, ty); ctx.drawImage(RIGHT, x + w - 8, ty); }
  for (let ty = y + 8; ty < y + h - 8; ty += 8) for (let tx = x + 8; tx < x + w - 8; tx += 8) ctx.drawImage(FILL, tx, ty);
}

function _nameToBytes(name) {
  const bytes = [];
  for (let i = 0; i < name.length; i++) {
    const ch = name.charCodeAt(i);
    if (ch >= 65 && ch <= 90) bytes.push(0x8A + (ch - 65));       // A-Z
    else if (ch >= 97 && ch <= 122) bytes.push(0xCA + (ch - 97)); // a-z
    else if (ch >= 48 && ch <= 57) bytes.push(0x80 + (ch - 48));  // 0-9
    else bytes.push(0xFF); // space
  }
  return new Uint8Array(bytes);
}

function _rosterLocForMapId(mapId) {
  if (mapId === 'world') return 'world';
  if (mapId === 114) return 'ur';
  if (mapId === 1004) return 'crystal';
  if (mapId >= 1000 && mapId < 1004) return 'cave-' + (mapId - 1000);
  return 'ur'; // sub-rooms (shops, houses) = same town
}

function _rosterTransFade() {
  const FADE_STEP_MS = WIPE_DURATION / ROSTER_FADE_STEPS;
  if (rosterLocChanged) {
    if (transState === 'closing') return Math.min(Math.floor(transTimer / FADE_STEP_MS), ROSTER_FADE_STEPS);
    if (transState === 'hold' || transState === 'trap-falling') return ROSTER_FADE_STEPS;
    if (transState === 'opening') return Math.max(ROSTER_FADE_STEPS - Math.floor(transTimer / FADE_STEP_MS), 0);
  }
  // Sync with HUD info fade-in on game start
  const infoFade = HUD_INFO_FADE_STEPS - Math.min(Math.floor(hudInfoFadeTimer / HUD_INFO_FADE_STEP_MS), HUD_INFO_FADE_STEPS);
  if (infoFade > 0) return infoFade;
  return 0;
}

function drawRoster() {
  if (titleState !== 'done') return;
  if (transState === 'loading') return;
  if (rosterBattleFade >= ROSTER_FADE_STEPS && battleState !== 'none') return;

  const panelTop = HUD_VIEW_Y + 32;          // rows start right below player boxes
  const panelH = HUD_VIEW_H - 32;            // 112px total
  const scrollAreaY = panelTop + ROSTER_VISIBLE * ROSTER_ROW_H; // 16px gap for triangles

  const players = getRosterVisible();
  const maxVisible = Math.min(ROSTER_VISIBLE, players.length);
  const maxScroll = Math.max(0, players.length - maxVisible);
  if (rosterScroll > maxScroll) rosterScroll = maxScroll;

  const canScrollUp = rosterScroll > 0;
  const canScrollDown = rosterScroll < maxScroll;

  // Clip to right panel area to contain slide animations
  ctx.save();
  ctx.beginPath();
  ctx.rect(HUD_RIGHT_X, panelTop, HUD_RIGHT_W, panelH);
  ctx.clip();

  for (let i = 0; i < maxVisible; i++) {
    const idx = rosterScroll + i;
    if (idx >= players.length) break;
    const p = players[idx];
    const slideOff = rosterSlideY[p.name] || 0;
    const rowY = panelTop + i * ROSTER_ROW_H + slideOff;
    const playerFade = rosterFadeMap[p.name] || 0;
    const transFade = _rosterTransFade();
    const fadeStep = Math.min(Math.max(playerFade, transFade, rosterBattleFade), ROSTER_FADE_STEPS);

    // Portrait box (32×32) + info box (80×32) — mirrors top player HUD boxes
    _drawHudBox(HUD_RIGHT_X, rowY, 32, ROSTER_ROW_H, fadeStep);
    _drawHudBox(HUD_RIGHT_X + 32, rowY, HUD_RIGHT_W - 32, ROSTER_ROW_H, fadeStep);

    // Portrait in interior of portrait box
    const portraits = fakePlayerPortraits[p.palIdx];
    if (portraits) ctx.drawImage(portraits[fadeStep], HUD_RIGHT_X + 8, rowY + 8);

    // Name (NES faded, right-aligned in info box interior — top text line)
    const namePal = [0x0F, 0x0F, 0x0F, 0x30];
    for (let s = 0; s < fadeStep; s++) namePal[3] = nesColorFade(namePal[3]);
    const nameBytes = _nameToBytes(p.name);
    const nameW = measureText(nameBytes);
    drawText(ctx, HUD_RIGHT_X + HUD_RIGHT_W - 8 - nameW, rowY + 8, nameBytes, namePal);

    // Level (NES faded, right-aligned — second text line)
    const lvPal = [0x0F, 0x0F, 0x0F, 0x10];
    for (let s = 0; s < fadeStep; s++) lvPal[3] = nesColorFade(lvPal[3]);
    const lvLabel = _nameToBytes('Lv' + String(p.level));
    const lvW = measureText(lvLabel);
    drawText(ctx, HUD_RIGHT_X + HUD_RIGHT_W - 8 - lvW, rowY + 16, lvLabel, lvPal);
  }

  ctx.restore();

  // Scroll triangles in the 16px gap below rows
  if (canScrollUp || canScrollDown) {
    const triFade = Math.min(Math.max(_rosterTransFade(), rosterBattleFade), ROSTER_FADE_STEPS);
    let triNes = 0x10;
    for (let s = 0; s < triFade; s++) triNes = nesColorFade(triNes);
    const triCol = NES_SYSTEM_PALETTE[triNes] || [0, 0, 0];
    ctx.fillStyle = `rgb(${triCol[0]},${triCol[1]},${triCol[2]})`;
    const triCX = HUD_RIGHT_X + Math.floor(HUD_RIGHT_W / 2);
    if (canScrollUp) {
      const ty = scrollAreaY + 2;
      ctx.beginPath();
      ctx.moveTo(triCX - 4, ty + 5); ctx.lineTo(triCX, ty); ctx.lineTo(triCX + 4, ty + 5);
      ctx.fill();
    }
    if (canScrollDown) {
      const ty = scrollAreaY + 9;
      ctx.beginPath();
      ctx.moveTo(triCX - 4, ty); ctx.lineTo(triCX, ty + 5); ctx.lineTo(triCX + 4, ty);
      ctx.fill();
    }
  }

  // Cure sparkle + heal number on roster player portrait during pause heal
  if (pauseHealNum && pauseHealNum.rosterIdx >= 0 && cureSparkleFrames.length === 2) {
    const visRow = pauseHealNum.rosterIdx - rosterScroll;
    if (visRow >= 0 && visRow < ROSTER_VISIBLE) {
      const px = HUD_RIGHT_X + 8;
      const py = panelTop + visRow * ROSTER_ROW_H + 8; // portrait interior y
      const fi = Math.floor(pauseTimer / 67) & 1;
      const frame = cureSparkleFrames[fi];
      ctx.drawImage(frame, px - 8, py - 7);
      ctx.save(); ctx.scale(-1, 1); ctx.drawImage(frame, -(px + 23), py - 7); ctx.restore();
      ctx.save(); ctx.scale(1, -1); ctx.drawImage(frame, px - 8, -(py + 24)); ctx.restore();
      ctx.save(); ctx.scale(-1, -1); ctx.drawImage(frame, -(px + 23), -(py + 24)); ctx.restore();
      // Heal number
      const digits = String(pauseHealNum.value);
      const numBytes = new Uint8Array(digits.length);
      for (let i = 0; i < digits.length; i++) numBytes[i] = 0x80 + parseInt(digits[i]);
      const tw = digits.length * 8;
      const hpy = _dmgBounceY(py + 8, pauseHealNum.timer);
      drawText(ctx, px + 8 - Math.floor(tw / 2), hpy, numBytes, [0x0F, 0x0F, 0x0F, 0x2B]);
    }
  }

  // Cursor (drawn OUTSIDE clip — overlaps portrait box border)
  if (rosterState === 'browse' || rosterState === 'menu' || rosterState === 'menu-in' || rosterState === 'menu-out') {
    const visIdx = rosterCursor - rosterScroll;
    const curTarget = players[rosterCursor];
    const curSlide = curTarget ? (rosterSlideY[curTarget.name] || 0) : 0;
    const curY = panelTop + visIdx * ROSTER_ROW_H + curSlide + 12;
    if (cursorTileCanvas) {
      ctx.drawImage(cursorTileCanvas, HUD_RIGHT_X - 4, curY);
    }
  }
}

function drawRosterMenu() {
  if (rosterState !== 'menu-in' && rosterState !== 'menu' && rosterState !== 'menu-out') return;

  // Blue bordered box slides in from right edge of viewport
  const menuW = 80;
  const menuH = 8 + ROSTER_MENU_ITEMS.length * 14 + 8;
  const finalX = HUD_VIEW_X + HUD_VIEW_W - menuW - 8;
  const menuY = HUD_VIEW_Y + 32;
  const SLIDE_MS = 150;

  let menuX = finalX;
  if (rosterState === 'menu-in') {
    const t = Math.min(rosterMenuTimer / SLIDE_MS, 1);
    menuX = (HUD_VIEW_X + HUD_VIEW_W) + (finalX - (HUD_VIEW_X + HUD_VIEW_W)) * t;
    if (t >= 1) { rosterState = 'menu'; rosterMenuTimer = 0; }
  } else if (rosterState === 'menu-out') {
    const t = Math.min(rosterMenuTimer / SLIDE_MS, 1);
    menuX = finalX + ((HUD_VIEW_X + HUD_VIEW_W) - finalX) * t;
    if (t >= 1) { rosterState = msgBoxState !== 'none' ? 'none' : 'browse'; rosterMenuTimer = 0; }
  }

  // Clip to viewport
  ctx.save();
  ctx.beginPath();
  ctx.rect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);
  ctx.clip();

  _drawBorderedBox(menuX, menuY, menuW, menuH, false);

  if (rosterState === 'menu') {
    const textPal = TEXT_WHITE;
    for (let i = 0; i < ROSTER_MENU_ITEMS.length; i++) {
      const label = ROSTER_MENU_ITEMS[i];
      const labelBytes = _nameToBytes(label);
      drawText(ctx, menuX + 16, menuY + 8 + i * 14, labelBytes, textPal);
    }
    // Cursor
    if (cursorTileCanvas) {
      ctx.drawImage(cursorTileCanvas, menuX + 2, menuY + 4 + rosterMenuCursor * 14);
    }
  }

  ctx.restore();
}

function initRoster() {
  document.fonts.load('8px "Press Start 2P"').then(() => {
    requestAnimationFrame(() => { chatFontReady = true; });
  });
  rosterTimer = 3000 + Math.random() * 5000;
  // Init HP for each player
  for (const p of PLAYER_POOL) {
    const maxHP = 28 + p.level * 6;
    if (p.maxHP === undefined) { p.maxHP = maxHP; p.hp = maxHP; }
  }
  // Init fade state — players already at our location start visible
  const loc = getPlayerLocation();
  rosterPrevLoc = loc;
  for (const p of PLAYER_POOL) {
    if (p.loc === loc) {
      rosterFadeMap[p.name] = 0; // fully visible
    }
  }
}

function _nesNameToString(bytes) {
  let s = '';
  for (const b of bytes) {
    if (b >= 0xCA) s += String.fromCharCode(b - 0xCA + 97);
    else if (b >= 0x8A) s += String.fromCharCode(b - 0x8A + 65);
    else if (b >= 0x80) s += String.fromCharCode(b - 0x80 + 48);
  }
  return s;
}

function addChatMessage(text, type) {
  chatMessages.push({ text, type: type || 'chat' });
  while (chatMessages.length > CHAT_HISTORY) chatMessages.shift();
}

function updateChat(dt) {
  const expandTarget = chatExpanded ? 1 : 0;
  if (chatExpandAnim < expandTarget) chatExpandAnim = Math.min(1, chatExpandAnim + dt / CHAT_EXPAND_MS);
  else if (chatExpandAnim > expandTarget) chatExpandAnim = Math.max(0, chatExpandAnim - dt / CHAT_EXPAND_MS);
  if (chatInputActive) chatCursorTimer += dt;
  if (battleState === 'none' && !chatInputActive) {
    chatAutoTimer -= dt;
    if (chatAutoTimer <= 0) {
      chatAutoTimer = CHAT_AUTO_MIN_MS + Math.random() * (CHAT_AUTO_MAX_MS - CHAT_AUTO_MIN_MS);
      const p = PLAYER_POOL[Math.floor(Math.random() * PLAYER_POOL.length)];
      const phrase = CHAT_PHRASES[Math.floor(Math.random() * CHAT_PHRASES.length)];
      addChatMessage(p.name + ': ' + phrase, 'chat');
    }
  }
}

// Wrap text to fit maxWidth using char-by-char measurement, breaking at spaces
function _chatWrap(ctx, text, maxWidth) {
  const lines = [];
  let start = 0;
  while (start < text.length) {
    let end = start;
    let lastSpace = -1;
    while (end < text.length && ctx.measureText(text.slice(start, end + 1)).width <= maxWidth) {
      if (text[end] === ' ') lastSpace = end;
      end++;
    }
    if (end >= text.length) { lines.push(text.slice(start)); break; }
    const cut = lastSpace > start ? lastSpace : end;
    lines.push(text.slice(start, cut));
    start = cut + (text[cut] === ' ' ? 1 : 0);
  }
  return lines.length ? lines : [text];
}

function drawChat() {
  if (!chatFontReady) return;
  const battleFadeAlpha = 1 - rosterBattleFade / ROSTER_FADE_STEPS;
  if (battleFadeAlpha <= 0) return;
  if (chatMessages.length === 0 && !chatInputActive && chatExpandAnim === 0) return;

  ctx.save();

  // ---- NES-stepped fade over the viewport area (4 discrete steps, 100ms each) ----
  if (chatExpandAnim > 0) {
    const NES_STEP_ALPHAS = [0, 0.28, 0.52, 0.76, 1.0];
    const step = Math.min(4, Math.round(chatExpandAnim * 4));
    ctx.globalAlpha = NES_STEP_ALPHAS[step] * battleFadeAlpha;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, HUD_VIEW_Y, CANVAS_W, HUD_BOT_Y - HUD_VIEW_Y);
  }

  // ---- Expanding border box: slides up in 8-px increments ----
  const fullBoxH = CANVAS_H - HUD_VIEW_Y;                               // 208 when fully open
  const curBoxH  = HUD_BOT_H + Math.round((fullBoxH - HUD_BOT_H) * chatExpandAnim / 8) * 8;
  const curBoxY  = CANVAS_H - curBoxH;                                  // top-left Y of box
  if (chatExpandAnim > 0) {
    ctx.globalAlpha = battleFadeAlpha;
    _drawHudBox(0, curBoxY, CANVAS_W, curBoxH, 0);
  }

  // ---- Text area inside the box ----
  const innerTop    = curBoxY + 8;
  const innerBottom = curBoxY + curBoxH - 10;
  const innerH      = innerBottom - innerTop;

  ctx.globalAlpha = battleFadeAlpha;
  ctx.beginPath();
  ctx.rect(8, innerTop, CANVAS_W - 16, curBoxH - 16);
  ctx.clip();
  ctx.font = '8px "Press Start 2P"';
  ctx.textBaseline = 'bottom';
  const startX = 12;
  const lineW  = CANVAS_W - 8 - startX;

  // Build flat row list from message history
  const rows = [];
  for (const m of chatMessages) {
    if (m.type === 'system') {
      for (const line of _chatWrap(ctx, m.text, lineW))
        rows.push({ color: '#7898c8', text: line, x: startX });
    } else {
      const colon = m.text.indexOf(':');
      if (colon > -1) {
        const namePart = m.text.slice(0, colon + 1);
        const msgPart  = m.text.slice(colon + 2);
        const nameW    = ctx.measureText(namePart).width;
        const firstLine = _chatWrap(ctx, msgPart, lineW - nameW)[0];
        rows.push({ namePart, nameW, msgPart: firstLine, x: startX });
        const remainder = msgPart.slice(firstLine.length).replace(/^ /, '');
        if (remainder.length > 0)
          rows.push({ color: '#e0e0e0', text: _chatWrap(ctx, remainder, lineW)[0], x: startX });
      } else {
        for (const line of _chatWrap(ctx, m.text, lineW))
          rows.push({ color: '#e0e0e0', text: line, x: startX });
      }
    }
  }

  const inputRows  = chatInputActive ? 2 : 0;
  const availRows  = Math.max(1, Math.floor(innerH / CHAT_LINE_H) - inputRows);
  const inputLine2Y = innerBottom;
  const inputLine1Y = inputLine2Y - CHAT_LINE_H;
  const bottomY    = chatInputActive ? inputLine1Y - CHAT_LINE_H : inputLine2Y;
  const visible    = rows.slice(-availRows);

  for (let i = 0; i < visible.length; i++) {
    const r = visible[i];
    const lineY = bottomY - (visible.length - 1 - i) * CHAT_LINE_H;
    if (r.namePart !== undefined) {
      ctx.fillStyle = '#d8b858';
      ctx.fillText(r.namePart, r.x, lineY);
      ctx.fillStyle = '#e0e0e0';
      ctx.fillText(r.msgPart, r.x + r.nameW, lineY);
    } else {
      ctx.fillStyle = r.color;
      ctx.fillText(r.text, r.x, lineY);
    }
  }

  // Input lines
  if (chatInputActive) {
    const promptW    = ctx.measureText('> ').width;
    const inputAvail = lineW - promptW;
    let splitIdx = chatInputText.length;
    for (let i = 1; i <= chatInputText.length; i++) {
      if (ctx.measureText(chatInputText.slice(0, i)).width > inputAvail) { splitIdx = i - 1; break; }
    }
    const line1Text = chatInputText.slice(0, splitIdx);
    const line2Text = chatInputText.slice(splitIdx);
    ctx.fillStyle = '#d8b858';
    ctx.fillText('>', startX, inputLine1Y);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(line1Text, startX + promptW, inputLine1Y);
    ctx.fillText(line2Text, startX, inputLine2Y);
    if (Math.floor(chatCursorTimer / 500) % 2 === 0) {
      if (line2Text.length > 0)
        ctx.fillRect(startX + ctx.measureText(line2Text).width, inputLine2Y - 7, 6, 8);
      else
        ctx.fillRect(startX + promptW + ctx.measureText(line1Text).width, inputLine1Y - 7, 6, 8);
    }
  }

  ctx.globalAlpha = 1;
  ctx.restore();
}

function _rosterNextTimer() {
  return 4000 + Math.random() * 8000;
}

function _rosterStartFadeIn(name) {
  // Insert at front of arrival order (most recent = top of list)
  rosterArrivalOrder = rosterArrivalOrder.filter(n => n !== name);
  rosterArrivalOrder.unshift(name);
  rosterFadeMap[name] = ROSTER_FADE_STEPS;
  rosterFadeDir[name] = 'in';
  rosterFadeTimers[name] = 0;
  rosterSlideY[name] = ROSTER_ROW_H; // new player slides in from below its row-0 position
  // All currently visible players shift down one row to make room at top
  const loc = getPlayerLocation();
  for (const p of PLAYER_POOL) {
    if (p.name !== name && p.loc === loc && rosterFadeMap[p.name] !== undefined) {
      rosterSlideY[p.name] = (rosterSlideY[p.name] || 0) - ROSTER_ROW_H;
    }
  }
  addChatMessage('* ' + name + ' entered the area', 'system');
}

function _rosterStartFadeOut(name) {
  rosterFadeDir[name] = 'out';
  rosterFadeTimers[name] = 0;
  addChatMessage('* ' + name + ' left the area', 'system');
}

// Get all players to show (at current loc OR fading out), newest arrivals first
function getRosterVisible() {
  const loc = getPlayerLocation();
  const atLoc = PLAYER_POOL.filter(p => p.loc === loc);
  const fadingOut = PLAYER_POOL.filter(p =>
    p.loc !== loc && rosterFadeDir[p.name] === 'out' && rosterFadeMap[p.name] < ROSTER_FADE_STEPS
  );
  // Sort at-location players by arrival order (most recent = index 0)
  atLoc.sort((a, b) => {
    const ai = rosterArrivalOrder.indexOf(a.name);
    const bi = rosterArrivalOrder.indexOf(b.name);
    // Not in arrival order (initial players) go after recent arrivals
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  return [...atLoc, ...fadingOut];
}

function _clampRosterCursor() {
  const visible = getRosterVisible();
  if (rosterCursor >= visible.length) rosterCursor = Math.max(0, visible.length - 1);
  const maxScroll = Math.max(0, visible.length - ROSTER_VISIBLE);
  if (rosterScroll > maxScroll) rosterScroll = maxScroll;
}

function updateRoster(dt) {
  if (rosterState === 'menu-in' || rosterState === 'menu-out') {
    rosterMenuTimer += Math.min(dt, 33);
  }
  if (titleState !== 'done') return;

  // Battle fade out/in
  if (battleState !== 'none' && rosterBattleFading !== 'out' && rosterBattleFade < ROSTER_FADE_STEPS) {
    rosterBattleFading = 'out';
    rosterBattleFadeTimer = 0;
  } else if (battleState === 'none' && rosterBattleFade > 0 && rosterBattleFading !== 'in') {
    rosterBattleFading = 'in';
    rosterBattleFadeTimer = 0;
  }
  if (rosterBattleFading === 'out') {
    rosterBattleFadeTimer += dt;
    if (rosterBattleFadeTimer >= ROSTER_FADE_STEP_MS) {
      rosterBattleFadeTimer -= ROSTER_FADE_STEP_MS;
      rosterBattleFade = Math.min(rosterBattleFade + 1, ROSTER_FADE_STEPS);
      if (rosterBattleFade >= ROSTER_FADE_STEPS) rosterBattleFading = 'none';
    }
  } else if (rosterBattleFading === 'in') {
    rosterBattleFadeTimer += dt;
    if (rosterBattleFadeTimer >= ROSTER_FADE_STEP_MS) {
      rosterBattleFadeTimer -= ROSTER_FADE_STEP_MS;
      rosterBattleFade = Math.max(rosterBattleFade - 1, 0);
      if (rosterBattleFade <= 0) rosterBattleFading = 'none';
    }
  }

  // Detect player location change (entering a new area) — reset roster state
  const curLoc = getPlayerLocation();
  if (rosterPrevLoc !== null && curLoc !== rosterPrevLoc) {
    // Clear all per-player fade/slide state
    rosterFadeMap = {}; rosterFadeDir = {}; rosterFadeTimers = {}; rosterSlideY = {};
    rosterArrivalOrder = [];
    // Mark all players at new location as visible
    for (const p of PLAYER_POOL) {
      if (p.loc === curLoc) rosterFadeMap[p.name] = 0;
    }
    rosterCursor = 0;
    rosterScroll = 0;
    rosterPrevLoc = curLoc;
  }

  // Tick fade timers
  for (const name in rosterFadeDir) {
    const dir = rosterFadeDir[name];
    if (dir === 'in' && rosterFadeMap[name] > 0) {
      rosterFadeTimers[name] = (rosterFadeTimers[name] || 0) + dt;
      if (rosterFadeTimers[name] >= ROSTER_FADE_STEP_MS) {
        rosterFadeTimers[name] -= ROSTER_FADE_STEP_MS;
        rosterFadeMap[name]--;
        if (rosterFadeMap[name] <= 0) { rosterFadeMap[name] = 0; delete rosterFadeDir[name]; }
      }
    } else if (dir === 'out') {
      rosterFadeTimers[name] = (rosterFadeTimers[name] || 0) + dt;
      if (rosterFadeTimers[name] >= ROSTER_FADE_STEP_MS) {
        rosterFadeTimers[name] -= ROSTER_FADE_STEP_MS;
        rosterFadeMap[name] = (rosterFadeMap[name] || 0) + 1;
        if (rosterFadeMap[name] >= ROSTER_FADE_STEPS) {
          // Find position before removal, slide players below it up
          const vis = getRosterVisible();
          const removeIdx = vis.findIndex(p => p.name === name);
          if (removeIdx >= 0) {
            for (let j = removeIdx + 1; j < vis.length; j++) {
              rosterSlideY[vis[j].name] = (rosterSlideY[vis[j].name] || 0) + ROSTER_ROW_H;
            }
          }
          delete rosterFadeMap[name];
          delete rosterFadeDir[name];
          delete rosterFadeTimers[name];
          delete rosterSlideY[name];
          _clampRosterCursor();
        }
      }
    }
  }

  // Tick slide offsets toward 0
  for (const name in rosterSlideY) {
    const sy = rosterSlideY[name];
    if (sy === 0) { delete rosterSlideY[name]; continue; }
    const move = ROSTER_SLIDE_SPEED * dt;
    if (Math.abs(sy) <= move) {
      rosterSlideY[name] = 0;
      delete rosterSlideY[name];
    } else {
      rosterSlideY[name] = sy > 0 ? sy - move : sy + move;
    }
  }

  // Simulate player movement — paused during battle to avoid silent list changes
  if (battleState === 'none') {
    rosterTimer -= dt;
    if (rosterTimer <= 0) {
      rosterTimer = _rosterNextTimer();

      const movers = PLAYER_POOL.filter(p => !p.camper);
      if (movers.length > 0) {
        const mover = movers[Math.floor(Math.random() * movers.length)];
        const wasHere = mover.loc === curLoc;
        const otherLocs = LOCATIONS.filter(l => l !== mover.loc);
        mover.loc = otherLocs[Math.floor(Math.random() * otherLocs.length)];
        const isHere = mover.loc === curLoc;

        if (wasHere && !isHere) {
          _rosterStartFadeOut(mover.name);
        } else if (!wasHere && isHere) {
          _rosterStartFadeIn(mover.name);
        }
      }
    }
  }
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
const SELECT_TITLE = new Uint8Array([0x99,0xD5,0xCA,0xE2,0xCE,0xDB,0xFF,0x9C,0xCE,0xD5,0xCE,0xCC,0xDD]); // "Player Select"
const SELECT_SLOT_TEXT = new Uint8Array([0x97,0xCE,0xE0,0xFF,0x90,0xCA,0xD6,0xCE]); // "New Game"
const SELECT_DELETE_TEXT = new Uint8Array([0x8D,0xCE,0xD5,0xCE,0xDD,0xCE]); // "Delete"
let deleteMode = false;

// Title box: "Final Fantasy" / "III MMORPG"
const TITLE_NAME_1 = new Uint8Array([0x8F,0xD2,0xD7,0xCA,0xD5,0xFF,0x8F,0xCA,0xD7,0xDD,0xCA,0xDC,0xE2]); // "Final Fantasy"
const TITLE_NAME_2 = new Uint8Array([0x92,0x92,0x92,0xFF,0x96,0x96,0x98,0x9B,0x99,0x90]); // "III MMORPG"
const TITLE_MMORPG = new Uint8Array([0x96,0x96,0x98,0x9B,0x99,0x90]); // "MMORPG"

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

  // Tick underwater scroll during early title states
  titleUnderwaterScroll += dt * 0.11; // ~110px/s

  // Update underwater bubbles + fish (only during early title states)
  if (uwBubbleTiles && titleState !== 'main-in' && titleState !== 'main' && titleState !== 'main-out' &&
      !titleState.startsWith('zbox') && !titleState.startsWith('select') && titleState !== 'name-entry') {
    // Spawn small bubbles randomly (up to 3)
    if (uwBubbles.length < 3 && Math.random() < dt * 0.0015) {
      uwBubbles.push({
        x: HUD_VIEW_X + 20 + Math.random() * (CANVAS_W - 40),
        y: HUD_VIEW_H - 4,
        speed: 18 + Math.random() * 12, // px/s rising
        zigPhase: Math.random() * Math.PI * 2, // start phase for zig-zag
        zigSpeed: 3 + Math.random() * 3, // zig-zag frequency
        zigAmp: 8 + Math.random() * 8, // zig-zag amplitude
        timer: 0,
      });
    }
    // Update bubbles — zig-zag upward
    for (let i = uwBubbles.length - 1; i >= 0; i--) {
      const b = uwBubbles[i];
      b.y -= b.speed * dt / 1000;
      b.timer += dt;
      if (b.y < -8) uwBubbles.splice(i, 1);
    }
    // Trigger fish after 1st message fades out
    if (!uwFishTriggered && titleState === 'disclaim-wait') {
      uwFishTriggered = true;
      uwFish = {
        x: -10,
        y: HUD_VIEW_H * 0.7, // start low
        timer: 0,
        speed: 80, // px/s northeast
        zigPhase: 0,
        zigSpeed: 4,
        zigAmp: 6,
      };
    }
    // Update fish — zig-zag northeast
    if (uwFish) {
      uwFish.x += uwFish.speed * dt / 1000;
      uwFish.y -= uwFish.speed * 0.4 * dt / 1000; // rise as it moves right
      uwFish.timer += dt;
      if (uwFish.x > CANVAS_W + 10 || uwFish.y < -10) uwFish = null;
    }
  }

  // Tick water animation during water-visible states
  if (titleState === 'main-in' || titleState === 'zbox-open' || titleState === 'main' || titleState === 'zbox-close' ||
      titleState === 'logo-fade-out' || titleState === 'logo-fade-in' || titleState === 'select-box-open' || titleState === 'select-box-close' || titleState === 'select-box-close-fwd' ||
      titleState === 'select-fade-in' || titleState === 'select' || titleState === 'select-fade-out' || titleState === 'select-fade-out-back' ||
      titleState === 'name-entry' || titleState === 'main-out') {
    waterTimer += dt;
    if (waterTimer >= WATER_TICK) {
      waterTimer %= WATER_TICK;
      waterTick++;
    }
    titleWaterScroll += dt * 0.12; // base scroll (~120px/s), parallax per row
    titleShipTimer += dt;
  }

  switch (titleState) {
    case 'credit-wait':
      if (titleTimer >= TITLE_FADE_MS) { titleState = 'credit-in'; titleTimer = 0; }
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
      if (titleTimer >= TITLE_ZBOX_MS) { titleState = 'logo-fade-out'; titleTimer = 0; }
      break;
    case 'logo-fade-out':
      if (titleTimer >= TITLE_FADE_MS) { titleState = 'select-box-open'; titleTimer = 0; selectCursor = 0; deleteMode = false; }
      break;
    case 'select-box-open':
      if (titleTimer >= BOSS_BOX_EXPAND_MS) { titleState = 'select-fade-in'; titleTimer = 0; }
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
      if (titleTimer >= (SELECT_TEXT_STEPS + 1) * SELECT_TEXT_STEP_MS) { titleState = 'select-box-close-fwd'; titleTimer = 0; }
      break;
    case 'select-box-close-fwd':
      if (titleTimer >= BOSS_BOX_EXPAND_MS) { titleState = 'main-out'; titleTimer = 0; }
      break;
    case 'select-fade-out-back':
      if (titleTimer >= (SELECT_TEXT_STEPS + 1) * SELECT_TEXT_STEP_MS) { titleState = 'select-box-close'; titleTimer = 0; }
      break;
    case 'select-box-close':
      if (titleTimer >= BOSS_BOX_EXPAND_MS) { titleState = 'logo-fade-in'; titleTimer = 0; }
      break;
    case 'logo-fade-in':
      if (titleTimer >= TITLE_FADE_MS) { titleState = 'zbox-open'; titleTimer = 0; }
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
          playerWeaponR = slot.stats.weaponR != null ? slot.stats.weaponR : 0x1E;
          playerWeaponL = slot.stats.weaponL != null ? slot.stats.weaponL : 0x00;
          playerHead = slot.stats.head || 0x00;
          playerBody = slot.stats.body || 0x00;
          playerArms = slot.stats.arms || 0x00;
          playerATK = playerStats.str + (ITEMS.get(playerWeaponR)?.atk || 0) + (ITEMS.get(playerWeaponL)?.atk || 0);
          recalcDEF();
        }
        playerInventory = (slot && slot.inventory) ? { ...slot.inventory } : {};
playerGil = (slot && slot.gil) || 0;
        loadMapById(114);
        worldY -= 6 * TILE_SIZE; // spawn 6 tiles north of entrance
        playTrack(TRACKS.TOWN_UR);
        // Delay screen open until HUD border fade-in completes
        transState = 'hud-fade-in';
        transTimer = 0;
      }
      break;
  }
}

let _titleCascadeCanvas = null; // reusable 16×16 scratch for per-row cascade

function drawTitleOcean(fadeLevel) {
  if (!titleOceanFrames || titleOceanFrames.length === 0) return;

  const maxStep = titleOceanFrames.length - 1;
  const frameIdx = Math.min(fadeLevel, maxStep);
  const oceanCanvas = titleOceanFrames[frameIdx];

  // Parallax: 2 rows (0=top, 1=bottom), row index 2-3 in the full scene
  // (sky rows 0-1 are drawn separately in the top box)
  ctx.save();
  ctx.beginPath();
  ctx.rect(HUD_VIEW_X, HUD_VIEW_Y, CANVAS_W, 32);
  ctx.clip();
  for (let row = 0; row < 2; row++) {
    const speed = _titleParallaxSpeed(2 + row); // scene rows 2-3
    const scrollX = Math.floor(titleWaterScroll * speed) % 256;
    const y = HUD_VIEW_Y + row * 16;
    // Draw the 16px-tall strip from the ocean canvas
    ctx.drawImage(oceanCanvas, 0, row * 16, 256, 16, -scrollX, y, 256, 16);
    ctx.drawImage(oceanCanvas, 0, row * 16, 256, 16, -scrollX + 256, y, 256, 16);
  }
  ctx.restore();
}

// Parallax speed for a given scene row (0=top sky, 10=bottom water)
// 11 total rows: sky(2) + ocean(2) + water(7)
function _titleParallaxSpeed(row) {
  // Row 0 (sky top) = 0.3, row 10 (water bottom) = 1.0
  return 0.3 + (row / 10) * 0.7;
}

function drawTitleWater(fadeLevel) {
  if (!titleWaterFrames) return;

  const twW = CANVAS_W; // full width during title
  const waterTop = HUD_VIEW_Y + 32; // below ocean BG
  const waterH = HUD_VIEW_H - 32;
  ctx.save();
  ctx.beginPath();
  ctx.rect(HUD_VIEW_X, waterTop, twW, waterH);
  ctx.clip();

  if (fadeLevel > 0 && titleWaterFadeTiles) {
    // Fading — per-row parallax with static fade tile
    const tile = titleWaterFadeTiles[Math.min(fadeLevel, titleWaterFadeTiles.length - 1)];
    for (let r = 0; r < 7; r++) {
      const speed = _titleParallaxSpeed(4 + r); // scene rows 4-10
      const scrollX = Math.floor(titleWaterScroll * speed) % 16;
      const y = waterTop + r * 16;
      for (let x = HUD_VIEW_X - scrollX; x < HUD_VIEW_X + twW + 16; x += 16) {
        ctx.drawImage(tile, x, y);
      }
    }
  } else {
    // Full brightness — per-row cascade + parallax
    const hShift = Math.floor(waterTick / 8) % 16;
    const hPrev = (hShift + 15) % 16;
    const subRow = waterTick % 8;
    const curTile = titleWaterFrames[hShift];
    const prevTile = titleWaterFrames[hPrev];

    if (!_titleCascadeCanvas) {
      _titleCascadeCanvas = document.createElement('canvas');
      _titleCascadeCanvas.width = 16;
      _titleCascadeCanvas.height = 16;
    }
    const cctx = _titleCascadeCanvas.getContext('2d');
    cctx.drawImage(prevTile, 0, 0);
    const h = subRow + 1;
    cctx.drawImage(curTile, 0, 0, 16, h, 0, 0, 16, h);
    cctx.drawImage(curTile, 0, 8, 16, h, 0, 8, 16, h);

    for (let r = 0; r < 7; r++) {
      const speed = _titleParallaxSpeed(4 + r); // scene rows 4-10
      const scrollX = Math.floor(titleWaterScroll * speed) % 16;
      const y = waterTop + r * 16;
      for (let x = HUD_VIEW_X - scrollX; x < HUD_VIEW_X + twW + 16; x += 16) {
        ctx.drawImage(_titleCascadeCanvas, x, y);
      }
    }
  }
  ctx.restore();
}

function drawTitleSky(fadeLevel) {
  if (!titleSkyFrames || titleSkyFrames.length === 0) return;

  const maxStep = titleSkyFrames.length - 1;
  const frameIdx = Math.min(fadeLevel, maxStep);
  const skyCanvas = titleSkyFrames[frameIdx];

  // Parallax: 2 rows (scene rows 0-1, slowest)
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, CANVAS_W, HUD_TOP_H);
  ctx.clip();
  for (let row = 0; row < 2; row++) {
    const speed = _titleParallaxSpeed(row); // scene rows 0-1
    const scrollX = Math.floor(titleWaterScroll * speed) % 256;
    const y = row * 16;
    ctx.drawImage(skyCanvas, 0, row * 16, 256, 16, -scrollX, y, 256, 16);
    ctx.drawImage(skyCanvas, 0, row * 16, 256, 16, -scrollX + 256, y, 256, 16);
  }
  ctx.restore();
}

function drawTitleUnderwater(fadeLevel) {
  if (!titleUnderwaterFrames || titleUnderwaterFrames.length === 0) return;
  const maxStep = titleUnderwaterFrames.length - 1;
  const frameIdx = Math.min(fadeLevel, maxStep);
  const uwCanvas = titleUnderwaterFrames[frameIdx];
  const scrollX = Math.floor(titleUnderwaterScroll) % 256;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, CANVAS_W, HUD_TOP_H);
  ctx.clip();
  ctx.drawImage(uwCanvas, -scrollX, 0);
  ctx.drawImage(uwCanvas, -scrollX + 256, 0);
  ctx.restore();
}

function drawUnderwaterSprites() {
  if (!uwBubbleTiles) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(HUD_VIEW_X, HUD_VIEW_Y, CANVAS_W, HUD_VIEW_H);
  ctx.clip();
  // Draw small bubbles with zig-zag
  for (const b of uwBubbles) {
    const zigX = Math.sin(b.zigPhase + b.timer / 1000 * b.zigSpeed) * b.zigAmp;
    ctx.drawImage(uwBubbleTiles[0], Math.round(b.x + zigX), Math.round(HUD_VIEW_Y + b.y));
  }
  // Draw fish zig-zagging northeast
  if (uwFish) {
    const frame = Math.floor(uwFish.timer / 200) % 2; // 2-frame animation
    const zigY = Math.sin(uwFish.zigPhase + uwFish.timer / 1000 * uwFish.zigSpeed) * uwFish.zigAmp;
    ctx.drawImage(uwBubbleTiles[1 + frame], Math.round(uwFish.x), Math.round(HUD_VIEW_Y + uwFish.y + zigY));
  }
  ctx.restore();
}

function drawTitleSkyInHUD() {
  if (titleState === 'main-in') {
    // NES fade in from black
    const fl = TITLE_FADE_MAX - Math.min(Math.floor(titleTimer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
    drawTitleSky(fl);
    roundTopBoxCorners();
  } else if (titleState === 'zbox-open' || titleState === 'main' || titleState === 'zbox-close' ||
             titleState === 'logo-fade-out' || titleState === 'logo-fade-in' || titleState === 'select-box-open' || titleState === 'select-box-close' || titleState === 'select-box-close-fwd' ||
             titleState === 'select-fade-in' || titleState === 'select' || titleState === 'select-fade-out' || titleState === 'select-fade-out-back' ||
             titleState === 'name-entry') {
    drawTitleSky(0);
    roundTopBoxCorners();
  } else if (titleState === 'main-out') {
    const fl = Math.min(Math.floor(titleTimer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
    drawTitleSky(fl);
    roundTopBoxCorners();
  } else if (titleState === 'disclaim-out') {
    // Underwater BG fades out with disclaimer text
    const fl = Math.min(Math.floor(titleTimer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
    drawTitleUnderwater(fl);
    roundTopBoxCorners();
  } else if (titleState === 'credit-wait') {
    // Fade in from black during initial wait
    const fl = TITLE_FADE_MAX - Math.min(Math.floor(titleTimer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
    drawTitleUnderwater(fl);
    roundTopBoxCorners();
  } else {
    // Credits, disclaimer: scrolling underwater BG at full brightness
    drawTitleUnderwater(0);
    roundTopBoxCorners();
  }
}

function drawTitle() {
  // Title uses full-width viewport (no right boxes)
  const TVW = CANVAS_W; // title viewport width
  ctx.fillStyle = '#000';
  ctx.fillRect(HUD_VIEW_X, HUD_VIEW_Y, TVW, HUD_VIEW_H);
  ctx.fillRect(0, 0, CANVAS_W, HUD_TOP_H); // full top box (no border)

  const cx = HUD_VIEW_X + TVW / 2;
  const cy = HUD_VIEW_Y + HUD_VIEW_H / 2;
  const vpBot = HUD_VIEW_Y + HUD_VIEW_H;

  if (titleState === 'credit-in' || titleState === 'credit-hold' || titleState === 'credit-out') {
    // NES fade in, hold, fade out
    const w1 = measureText(TITLE_CREDIT_1);
    const w2 = measureText(TITLE_CREDIT_2);
    const w3 = measureText(TITLE_CREDIT_3);
    let fl = 0;
    if (titleState === 'credit-in') {
      fl = TITLE_FADE_MAX - Math.min(Math.floor(titleTimer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
    } else if (titleState === 'credit-out') {
      fl = Math.min(Math.floor(titleTimer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
    }
    const pal = fl === 0 ? TEXT_WHITE : titleFadePal(fl);
    drawText(ctx, cx - w1 / 2, cy - 16, TITLE_CREDIT_1, pal);
    drawText(ctx, cx - w2 / 2, cy - 4, TITLE_CREDIT_2, pal);
    drawText(ctx, cx - w3 / 2, cy + 8, TITLE_CREDIT_3, pal);
  } else if (titleState === 'disclaim-in' || titleState === 'disclaim-hold' || titleState === 'disclaim-out') {
    // NES fade in, hold, fade out
    const w1 = measureText(TITLE_DISCLAIM_1);
    const w2 = measureText(TITLE_DISCLAIM_2);
    const w3 = measureText(TITLE_DISCLAIM_3);
    const w4 = measureText(TITLE_DISCLAIM_4);
    const w5 = measureText(TITLE_DISCLAIM_5);
    let fl = 0;
    if (titleState === 'disclaim-in') {
      fl = TITLE_FADE_MAX - Math.min(Math.floor(titleTimer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
    } else if (titleState === 'disclaim-out') {
      fl = Math.min(Math.floor(titleTimer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
    }
    const pal = fl === 0 ? TEXT_WHITE : titleFadePal(fl);
    drawText(ctx, cx - w1 / 2, cy - 24, TITLE_DISCLAIM_1, pal);
    drawText(ctx, cx - w2 / 2, cy - 14, TITLE_DISCLAIM_2, pal);
    drawText(ctx, cx - w3 / 2, cy - 4, TITLE_DISCLAIM_3, pal);
    drawText(ctx, cx - w4 / 2, cy + 10, TITLE_DISCLAIM_4, pal);
    drawText(ctx, cx - w5 / 2, cy + 24, TITLE_DISCLAIM_5, pal);
  }

  // Draw underwater sprites over text during early title states
  if (titleState === 'credit-wait' || titleState === 'credit-in' || titleState === 'credit-hold' || titleState === 'credit-out' ||
      titleState === 'disclaim-wait' || titleState === 'disclaim-in' || titleState === 'disclaim-hold' || titleState === 'disclaim-out') {
    drawUnderwaterSprites();
  }

  if (titleState === 'main-in' || titleState === 'zbox-open' || titleState === 'main' || titleState === 'zbox-close' ||
             titleState === 'logo-fade-out' || titleState === 'logo-fade-in' || titleState === 'select-box-open' || titleState === 'select-box-close' || titleState === 'select-box-close-fwd' ||
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

    // Clip viewport content
    ctx.save();
    ctx.beginPath();
    ctx.rect(HUD_VIEW_X + 8, HUD_VIEW_Y + 8, TVW - 16, HUD_VIEW_H - 16);
    ctx.clip();

    // Draw ocean BG (top 32px) and water (below)
    drawTitleOcean(fl);
    drawTitleWater(fl);

    // FF3 logo in bordered box
    const isSelectState = titleState === 'select-box-open' || titleState === 'select-box-close' || titleState === 'select-box-close-fwd' ||
      titleState === 'select-fade-in' || titleState === 'select' ||
      titleState === 'select-fade-out' || titleState === 'select-fade-out-back' || titleState === 'name-entry';
    // Logo fade level — separate from background fl
    let logoFl = fl;
    if (titleState === 'logo-fade-out') {
      logoFl = Math.min(Math.floor(titleTimer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
    } else if (titleState === 'logo-fade-in') {
      logoFl = TITLE_FADE_MAX - Math.min(Math.floor(titleTimer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
    } else if (isSelectState || titleState === 'main-out') {
      logoFl = TITLE_FADE_MAX; // hidden — already faded before reaching these states
    }
    if (titleLogoFrames && logoFl < TITLE_FADE_MAX) {
      const logoFrame = titleLogoFrames[Math.min(logoFl, titleLogoFrames.length - 1)];
      const tboxW = logoFrame.width + 16; // 8px border each side
      const tboxH = logoFrame.height + 24; // 8 border + logo + 4 gap + 8 text + 4 pad
      const tboxX = Math.round(cx - tboxW / 2);
      const tboxY = HUD_VIEW_Y + 12;
      const clampedFl = Math.min(logoFl, LOAD_FADE_MAX);
      const tBorderSet = (borderFadeSets && logoFl > 0)
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
      ctx.drawImage(logoFrame, tboxX + 8, tboxY + 8);
      // "MMORPG" subtitle below logo
      const tpal = logoFl === 0 ? TEXT_WHITE : titleFadePal(logoFl);
      const tw2 = measureText(TITLE_MMORPG);
      drawText(ctx, cx - tw2 / 2, tboxY + 8 + logoFrame.height + 0, TITLE_MMORPG, tpal);
    }

    // Invincible airship sprite — stays visible, fades only with background (fl)
    if (invincibleFadeFrames && fl < TITLE_FADE_MAX) {
      const frameIdx = Math.floor(titleShipTimer / TITLE_SHIP_ANIM_MS) % 2;
      const shipCanvas = invincibleFadeFrames[fl][frameIdx];
      const shipX = cx - 16;
      const bob = Math.sin(titleShipTimer / 2000 * Math.PI * 2) * 4;
      const shipY = Math.round(cy - 20 + bob);
      const shadowY = cy - 20 + 32;
      if (invincibleShadowFade && Math.floor(titleShipTimer / TITLE_SHADOW_ANIM_MS) % 2 === 0) {
        ctx.drawImage(invincibleShadowFade[fl], shipX, shadowY);
      }
      ctx.drawImage(shipCanvas, shipX, shipY);
    }

    ctx.restore(); // end viewport clip

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

    // Select box — expands from center, contains player select content
    if (isSelectState) {
      const SELECT_BOX_W = 128;
      const SELECT_BOX_H = 112;
      const sbCX = cx;
      const sbCY = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2);

      // Box open/close animation (same as encounter boxes)
      let sbt = 1; // 0=closed, 1=fully open
      if (titleState === 'select-box-open') {
        sbt = Math.min(titleTimer / BOSS_BOX_EXPAND_MS, 1);
      } else if (titleState === 'select-box-close' || titleState === 'select-box-close-fwd') {
        sbt = 1 - Math.min(titleTimer / BOSS_BOX_EXPAND_MS, 1);
      }

      const sbW = Math.max(16, Math.ceil(SELECT_BOX_W * sbt / 8) * 8);
      const sbH = Math.max(16, Math.ceil(SELECT_BOX_H * sbt / 8) * 8);
      const sbX = Math.round(sbCX - sbW / 2);
      const sbY = Math.round(sbCY - sbH / 2);

      if (borderTileCanvases) {
        _drawBorderedBox(sbX, sbY, sbW, sbH);
      }

      // Draw select content only when fully open and not closing
      if (sbt >= 1 && titleState !== 'select-box-close' && titleState !== 'select-box-close-fwd') {
        drawPlayerSelectContent(sbX, sbY, SELECT_BOX_W, SELECT_BOX_H);
      }
    }
  }
}

// --- Player select screen ---

function drawPlayerSelectContent(sbX, sbY, sbW, sbH) {
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

  const ix = sbX + 8; // interior left
  const iy = sbY + 8; // interior top
  const iw = sbW - 16;

  // "Player Select" header — centered
  const tw = measureText(SELECT_TITLE);
  drawText(ctx, ix + Math.floor((iw - tw) / 2), iy, SELECT_TITLE, fadedPal);

  // 3 save slots
  const slotStartY = iy + 16;
  const slotSpacing = 20;
  for (let i = 0; i < 3; i++) {
    const sy = slotStartY + i * slotSpacing;

    // Hand cursor
    if (i === selectCursor && cursorTileCanvas) {
      if (fadeStep === 0) {
        ctx.drawImage(cursorTileCanvas, ix, sy - 4);
      } else if (fadeStep < SELECT_TEXT_STEPS) {
        ctx.globalAlpha = 1 - fadeStep / SELECT_TEXT_STEPS;
        ctx.drawImage(cursorTileCanvas, ix, sy - 4);
        ctx.globalAlpha = 1;
      }
    }

    const isNameEntry = titleState === 'name-entry' && i === selectCursor;
    const textX = ix + 20;

    // Portrait
    if (isNameEntry) {
      if (silhouetteCanvas) ctx.drawImage(silhouetteCanvas, textX - 2, sy - 4);
    } else if (saveSlots[i] && battleSpriteCanvas) {
      if (fadeStep === 0) {
        ctx.drawImage(battleSpriteCanvas, textX - 2, sy - 4, 16, 16);
      } else if (fadeStep < SELECT_TEXT_STEPS) {
        ctx.globalAlpha = 1 - fadeStep / SELECT_TEXT_STEPS;
        ctx.drawImage(battleSpriteCanvas, textX - 2, sy - 4, 16, 16);
        ctx.globalAlpha = 1;
      }
    } else if (silhouetteCanvas) {
      if (fadeStep === 0) {
        ctx.drawImage(silhouetteCanvas, textX - 2, sy - 4);
      } else if (fadeStep < SELECT_TEXT_STEPS) {
        ctx.globalAlpha = 1 - fadeStep / SELECT_TEXT_STEPS;
        ctx.drawImage(silhouetteCanvas, textX - 2, sy - 4);
        ctx.globalAlpha = 1;
      }
    }

    // Slot text
    const nameX = textX + 18;
    if (isNameEntry) {
      if (nameBuffer.length > 0) {
        drawText(ctx, nameX, sy, new Uint8Array(nameBuffer), fadedPal);
      }
      if (nameBuffer.length < NAME_MAX_LEN && Math.floor(titleTimer / 400) % 2 === 0) {
        ctx.fillStyle = '#fcfcfc';
        ctx.fillRect(nameX + nameBuffer.length * 8 + 1, sy + 7, 6, 1);
      }
    } else if (saveSlots[i]) {
      drawText(ctx, nameX, sy, saveSlots[i].name, fadedPal);
    } else {
      drawText(ctx, nameX, sy, SELECT_SLOT_TEXT, fadedPal);
    }
  }

  // "Delete" option
  const delY = slotStartY + 3 * slotSpacing;
  const delPal = deleteMode
    ? [0x0F, 0x0F, 0x0F, 0x16]
    : [0x0F, 0x0F, 0x0F, fadedPal[3]];
  if (!deleteMode && selectCursor === 3 && cursorTileCanvas) {
    if (fadeStep === 0) {
      ctx.drawImage(cursorTileCanvas, ix, delY - 4);
    } else if (fadeStep < SELECT_TEXT_STEPS) {
      ctx.globalAlpha = 1 - fadeStep / SELECT_TEXT_STEPS;
      ctx.drawImage(cursorTileCanvas, ix, delY - 4);
      ctx.globalAlpha = 1;
    }
  }
  drawText(ctx, ix + 38, delY, SELECT_DELETE_TEXT, delPal);
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
    if (pauseTimer >= PAUSE_SCROLL_MS) {
      pauseState = 'none'; pauseTimer = 0;
      stopFF1Music();
      resumeMusic();
    }
  // Inventory transitions
  } else if (pauseState === 'inv-text-out') {
    if (pauseTimer >= (PAUSE_TEXT_STEPS + 1) * PAUSE_TEXT_STEP_MS) { pauseState = 'inv-expand'; pauseTimer = 0; }
  } else if (pauseState === 'inv-expand') {
    if (pauseTimer >= PAUSE_EXPAND_MS) { pauseState = 'inv-items-in'; pauseTimer = 0; }
  } else if (pauseState === 'inv-items-in') {
    if (pauseTimer >= (PAUSE_TEXT_STEPS + 1) * PAUSE_TEXT_STEP_MS) { pauseState = 'inventory'; pauseTimer = 0; }
  } else if (pauseState === 'inv-items-out') {
    if (pauseTimer >= (PAUSE_TEXT_STEPS + 1) * PAUSE_TEXT_STEP_MS) { pauseState = 'inv-shrink'; pauseTimer = 0; }
  } else if (pauseState === 'inv-shrink') {
    if (pauseTimer >= PAUSE_EXPAND_MS) { pauseState = 'inv-text-in'; pauseTimer = 0; }
  } else if (pauseState === 'inv-text-in') {
    if (pauseTimer >= (PAUSE_TEXT_STEPS + 1) * PAUSE_TEXT_STEP_MS) { pauseState = 'open'; pauseTimer = 0; }
  } else if (pauseState === 'inv-heal') {
    // Heal animation — defend pose + sparkle for same duration as battle
    if (pauseHealNum) {
      pauseHealNum.timer += dt;
      if (pauseHealNum.timer >= BATTLE_DMG_SHOW_MS) pauseHealNum = null;
    }
    if (pauseTimer >= DEFEND_SPARKLE_TOTAL_MS) {
      pauseHealNum = null;
      // Re-check if items remain, adjust scroll
      const entries = Object.entries(playerInventory).filter(([,c]) => c > 0);
      if (pauseInvScroll >= entries.length) pauseInvScroll = Math.max(0, entries.length - 1);
      pauseState = 'inventory'; pauseTimer = 0;
    }
  // Equip transitions (same pattern as inventory)
  } else if (pauseState === 'eq-text-out') {
    if (pauseTimer >= (PAUSE_TEXT_STEPS + 1) * PAUSE_TEXT_STEP_MS) { pauseState = 'eq-expand'; pauseTimer = 0; }
  } else if (pauseState === 'eq-expand') {
    if (pauseTimer >= PAUSE_EXPAND_MS) { pauseState = 'eq-slots-in'; pauseTimer = 0; }
  } else if (pauseState === 'eq-slots-in') {
    if (pauseTimer >= (PAUSE_TEXT_STEPS + 1) * PAUSE_TEXT_STEP_MS) { pauseState = 'equip'; pauseTimer = 0; }
  } else if (pauseState === 'eq-slots-out') {
    if (pauseTimer >= (PAUSE_TEXT_STEPS + 1) * PAUSE_TEXT_STEP_MS) { pauseState = 'eq-shrink'; pauseTimer = 0; }
  } else if (pauseState === 'eq-shrink') {
    if (pauseTimer >= PAUSE_EXPAND_MS) { pauseState = 'eq-text-in'; pauseTimer = 0; }
  } else if (pauseState === 'eq-text-in') {
    if (pauseTimer >= (PAUSE_TEXT_STEPS + 1) * PAUSE_TEXT_STEP_MS) { pauseState = 'open'; pauseTimer = 0; }
  } else if (pauseState === 'eq-items-in') {
    if (pauseTimer >= (PAUSE_TEXT_STEPS + 1) * PAUSE_TEXT_STEP_MS) { pauseState = 'eq-item-select'; pauseTimer = 0; }
  } else if (pauseState === 'eq-items-out') {
    if (pauseTimer >= (PAUSE_TEXT_STEPS + 1) * PAUSE_TEXT_STEP_MS) { pauseState = 'equip'; pauseTimer = 0; }
  }
}

function showMsgBox(bytes, onClose) {
  msgBoxBytes = bytes;
  msgBoxState = 'slide-in';
  msgBoxTimer = 0;
  msgBoxOnClose = onClose || null;
}

function updateMsgBox(dt) {
  if (msgBoxState === 'none') return;
  msgBoxTimer += Math.min(dt, 33);

  if (msgBoxState === 'slide-in') {
    if (msgBoxTimer >= BATTLE_SCROLL_MS) { msgBoxState = 'hold'; msgBoxTimer = 0; }
  } else if (msgBoxState === 'slide-out') {
    if (msgBoxTimer >= BATTLE_SCROLL_MS) {
      const cb = msgBoxOnClose;
      msgBoxState = 'none'; msgBoxTimer = 0; msgBoxBytes = null; msgBoxOnClose = null;
      if (cb) cb();
    }
  }
}

function _wrapMsgBytes(bytes, maxChars) {
  // Split msg bytes into lines that fit within maxChars
  // Word-break on 0xFF (space). Each printable byte = 1 char.
  const lines = [];
  let lineStart = 0, lastSpace = -1, lineLen = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x00) break;
    if (b === 0xFF) lastSpace = i;
    if (b >= 0x28) lineLen++;
    if (lineLen > maxChars && lastSpace > lineStart) {
      lines.push(bytes.slice(lineStart, lastSpace));
      lineStart = lastSpace + 1;
      lastSpace = -1;
      // Recount from lineStart
      lineLen = 0;
      for (let j = lineStart; j <= i; j++) { if (bytes[j] >= 0x28) lineLen++; }
    }
  }
  if (lineStart < bytes.length) lines.push(bytes.slice(lineStart));
  return lines;
}

function drawMsgBox() {
  if (msgBoxState === 'none' || !msgBoxBytes) return;

  const boxW = HUD_VIEW_W - 16;
  const interiorW = boxW - 16; // 8px border each side
  const maxChars = Math.floor(interiorW / 8);
  const lines = _wrapMsgBytes(msgBoxBytes, maxChars);
  const lineH = 12;
  const boxH = Math.max(48, 24 + lines.length * lineH);
  const vpTop = HUD_VIEW_Y;
  const finalY = vpTop + 8;
  const centerX = HUD_VIEW_X + Math.floor((HUD_VIEW_W - boxW) / 2);

  let boxY = finalY;
  if (msgBoxState === 'slide-in') {
    const t = Math.min(msgBoxTimer / BATTLE_SCROLL_MS, 1);
    boxY = (vpTop - boxH) + (finalY - (vpTop - boxH)) * t;
  } else if (msgBoxState === 'slide-out') {
    const t = Math.min(msgBoxTimer / BATTLE_SCROLL_MS, 1);
    boxY = finalY + ((vpTop - boxH) - finalY) * t;
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);
  ctx.clip();

  _drawBorderedBox(centerX, boxY, boxW, boxH, true);

  if (msgBoxState === 'hold' || msgBoxState === 'slide-out') {
    const fadedPal = [0x02, 0x02, 0x02, 0x30];
    const textBlockH = lines.length * lineH;
    const startTY = boxY + Math.floor((boxH - textBlockH) / 2);
    for (let i = 0; i < lines.length; i++) {
      const tw = measureText(lines[i]);
      const tx = centerX + Math.floor((boxW - tw) / 2);
      drawText(ctx, tx, startTY + i * lineH, lines[i], fadedPal);
    }
  }

  ctx.restore();
}

function _drawMonsterDeath(x, y, size, progress, monsterId) {
  // Dithered diagonal dissolve — pre-rendered frames with Bayer 4×4 dither pattern.
  const frames = monsterDeathFrames.get(monsterId) || goblinDeathFrames;
  if (!frames || !frames.length) return;
  const frameIdx = Math.min(frames.length - 1, Math.floor(progress * frames.length));
  ctx.drawImage(frames[frameIdx], x, y);
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

// Draw top box border dynamically using faded border tiles.
// Only called when text is displayed — otherwise the full 32px battle BG shows through.
function drawTopBoxBorder(fadeStep) {
  if (!borderFadeSets || fadeStep >= TOPBOX_FADE_STEPS) return;
  const tiles = borderFadeSets[fadeStep];
  const [TL, TOP, TR, LEFT, RIGHT, BL, BOT, BR, FILL] = tiles;
  const x = 0, y = 0, w = CANVAS_W, h = HUD_TOP_H;
  // Interior fill
  for (let ty = y + 8; ty < y + h - 8; ty += 8)
    for (let tx = x + 8; tx < x + w - 8; tx += 8)
      ctx.drawImage(FILL, tx, ty);
  // Corners
  ctx.drawImage(TL, x, y); ctx.drawImage(TR, x + w - 8, y);
  ctx.drawImage(BL, x, y + h - 8); ctx.drawImage(BR, x + w - 8, y + h - 8);
  // Top/bottom edges
  for (let tx = x + 8; tx < x + w - 8; tx += 8) {
    ctx.drawImage(TOP, tx, y); ctx.drawImage(BOT, tx, y + h - 8);
  }
  // Left/right edges
  for (let ty = y + 8; ty < y + h - 8; ty += 8) {
    ctx.drawImage(LEFT, x, ty); ctx.drawImage(RIGHT, x + w - 8, ty);
  }
}

// Round the corners of the top box content (battle BG / sky) using corner masks
function roundTopBoxCorners() {
  if (!cornerMasks) return;
  const [TL, TR, BL, BR] = cornerMasks;
  ctx.drawImage(TL, 0, 0);
  ctx.drawImage(TR, CANVAS_W - 8, 0);
  ctx.drawImage(BL, 0, HUD_TOP_H - 8);
  ctx.drawImage(BR, CANVAS_W - 8, HUD_TOP_H - 8);
}

function drawPauseMenu() {
  if (pauseState === 'none') return;

  const px = HUD_VIEW_X;
  const finalY = HUD_VIEW_Y;
  const pw = PAUSE_MENU_W;
  const ph = PAUSE_MENU_H;
  const isInvState = pauseState.startsWith('inv-') || pauseState === 'inventory';
  const isEqState = pauseState.startsWith('eq-') || pauseState === 'equip';

  // Scroll position (only for initial scroll-in/scroll-out)
  let panelY = finalY;
  if (pauseState === 'scroll-in') {
    const t = Math.min(pauseTimer / PAUSE_SCROLL_MS, 1);
    panelY = finalY - ph + t * ph;
  } else if (pauseState === 'scroll-out') {
    const t = Math.min(pauseTimer / PAUSE_SCROLL_MS, 1);
    panelY = finalY - t * ph;
  }

  // Clip to viewport
  ctx.save();
  ctx.beginPath();
  ctx.rect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);
  ctx.clip();

  // --- Bordered box ---
  // During inventory/equip transitions, animate size from pause dims to full viewport
  if (isInvState || isEqState) {
    let t = 1; // fully expanded
    if (pauseState === 'inv-expand' || pauseState === 'eq-expand') {
      t = Math.min(pauseTimer / PAUSE_EXPAND_MS, 1);
    } else if (pauseState === 'inv-shrink' || pauseState === 'eq-shrink') {
      t = 1 - Math.min(pauseTimer / PAUSE_EXPAND_MS, 1);
    } else if (pauseState === 'inv-text-out' || pauseState === 'eq-text-out') {
      t = 0; // still pause size during text fade out
    } else if (pauseState === 'inv-text-in' || pauseState === 'eq-text-in') {
      t = 0; // back to pause size during text fade in
    }
    const bw = Math.round(pw + (HUD_VIEW_W - pw) * t);
    const bh = Math.round(ph + (HUD_VIEW_H - ph) * t);
    _drawBorderedBox(px, finalY, bw, bh);
  } else {
    _drawBorderedBox(px, panelY, pw, ph);
  }

  // --- Pause menu text (shown during normal states + inv fade transitions) ---
  const showPauseText = pauseState === 'text-in' || pauseState === 'open' || pauseState === 'text-out' ||
                        pauseState === 'inv-text-out' || pauseState === 'inv-text-in' ||
                        pauseState === 'eq-text-out' || pauseState === 'eq-text-in';
  if (showPauseText) {
    let fadeStep = 0;
    if (pauseState === 'text-in' || pauseState === 'inv-text-in' || pauseState === 'eq-text-in') {
      fadeStep = PAUSE_TEXT_STEPS - Math.min(Math.floor(pauseTimer / PAUSE_TEXT_STEP_MS), PAUSE_TEXT_STEPS);
    } else if (pauseState === 'text-out' || pauseState === 'inv-text-out' || pauseState === 'eq-text-out') {
      fadeStep = Math.min(Math.floor(pauseTimer / PAUSE_TEXT_STEP_MS), PAUSE_TEXT_STEPS);
    }

    const fadedPal = [0x0F, 0x0F, 0x0F, 0x30];
    for (let s = 0; s < fadeStep; s++) fadedPal[3] = nesColorFade(fadedPal[3]);

    const textX = px + 24;
    const startY = ((isInvState || isEqState) ? finalY : panelY) + 12;
    for (let i = 0; i < PAUSE_ITEMS.length; i++) {
      drawText(ctx, textX, startY + i * 16, PAUSE_ITEMS[i], fadedPal);
    }

    // Hand cursor
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

  // --- Inventory items (shown when expanded) ---
  const showInvItems = pauseState === 'inv-items-in' || pauseState === 'inventory' || pauseState === 'inv-items-out' ||
    pauseState === 'inv-target' || pauseState === 'inv-heal';
  if (showInvItems) {
    let fadeStep = 0;
    if (pauseState === 'inv-items-in') {
      fadeStep = PAUSE_TEXT_STEPS - Math.min(Math.floor(pauseTimer / PAUSE_TEXT_STEP_MS), PAUSE_TEXT_STEPS);
    } else if (pauseState === 'inv-items-out') {
      fadeStep = Math.min(Math.floor(pauseTimer / PAUSE_TEXT_STEP_MS), PAUSE_TEXT_STEPS);
    }

    const fadedPal = [0x0F, 0x0F, 0x0F, 0x30];
    for (let s = 0; s < fadeStep; s++) fadedPal[3] = nesColorFade(fadedPal[3]);

    const entries = Object.entries(playerInventory).filter(([,c]) => c > 0);
    const maxVisible = Math.floor((HUD_VIEW_H - 16) / 14);
    const startIdx = Math.max(0, Math.min(pauseInvScroll, Math.max(0, entries.length - maxVisible)));

    for (let i = 0; i < maxVisible && startIdx + i < entries.length; i++) {
      const [id, count] = entries[startIdx + i];
      const nameBytes = getItemNameClean(Number(id));
      const countStr = String(count);
      const rowBytes = new Uint8Array(nameBytes.length + 2 + countStr.length);
      rowBytes.set(nameBytes, 0);
      rowBytes[nameBytes.length] = 0xFF;
      rowBytes[nameBytes.length + 1] = 0xE1;
      for (let d = 0; d < countStr.length; d++) rowBytes[nameBytes.length + 2 + d] = 0x80 + parseInt(countStr[d]);

      const iy = finalY + 12 + i * 14;
      drawText(ctx, px + 24, iy, rowBytes, fadedPal);

      // Pinned cursor at held item position
      if (pauseHeldItem >= 0 && startIdx + i === pauseHeldItem && cursorTileCanvas && pauseState !== 'inv-target' && pauseState !== 'inv-heal') {
        if (fadeStep === 0) {
          ctx.drawImage(cursorTileCanvas, px + 8, iy - 4);
        } else if (fadeStep < PAUSE_TEXT_STEPS) {
          ctx.globalAlpha = 1 - fadeStep / PAUSE_TEXT_STEPS;
          ctx.drawImage(cursorTileCanvas, px + 8, iy - 4);
          ctx.globalAlpha = 1;
        }
      }
      // Active cursor — offset 4px left if holding (duplicated cursor)
      if (startIdx + i === pauseInvScroll && cursorTileCanvas && pauseState !== 'inv-target' && pauseState !== 'inv-heal') {
        const activeX = pauseHeldItem >= 0 ? px + 4 : px + 8;
        if (fadeStep === 0) {
          ctx.drawImage(cursorTileCanvas, activeX, iy - 4);
        } else if (fadeStep < PAUSE_TEXT_STEPS) {
          ctx.globalAlpha = 1 - fadeStep / PAUSE_TEXT_STEPS;
          ctx.drawImage(cursorTileCanvas, activeX, iy - 4);
          ctx.globalAlpha = 1;
        }
      }
    }
  }

  // --- Equip slots (shown when expanded) ---
  const showEqSlots = pauseState === 'eq-slots-in' || pauseState === 'equip' || pauseState === 'eq-slots-out' ||
    pauseState === 'eq-items-in' || pauseState === 'eq-item-select' || pauseState === 'eq-items-out';
  if (showEqSlots) {
    let fadeStep = 0;
    if (pauseState === 'eq-slots-in') {
      fadeStep = PAUSE_TEXT_STEPS - Math.min(Math.floor(pauseTimer / PAUSE_TEXT_STEP_MS), PAUSE_TEXT_STEPS);
    } else if (pauseState === 'eq-slots-out') {
      fadeStep = Math.min(Math.floor(pauseTimer / PAUSE_TEXT_STEP_MS), PAUSE_TEXT_STEPS);
    }
    const fadedPal = [0x0F, 0x0F, 0x0F, 0x30];
    for (let s = 0; s < fadeStep; s++) fadedPal[3] = nesColorFade(fadedPal[3]);

    const EQ_LABELS = [
      new Uint8Array([0x9B,0xC4,0x91,0xCA,0xD7,0xCD]), // "R.Hand"
      new Uint8Array([0x95,0xC4,0x91,0xCA,0xD7,0xCD]), // "L.Hand"
      new Uint8Array([0x91,0xCE,0xCA,0xCD]),             // "Head"
      new Uint8Array([0x8B,0xD8,0xCD,0xE2]),             // "Body"
      new Uint8Array([0x8A,0xDB,0xD6,0xDC]),             // "Arms"
    ];
    const EQ_IDS = [-100, -101, -102, -103, -104];
    const eqRowH = 22;
    const eqStartY = finalY + 12;
    // Dim slots during item selection (show which slot is being filled)
    const dimSlots = pauseState === 'eq-items-in' || pauseState === 'eq-item-select' || pauseState === 'eq-items-out';
    for (let r = 0; r < 5; r++) {
      const slotId = getEquipSlotId(EQ_IDS[r]);
      const label = EQ_LABELS[r];
      const iy = eqStartY + r * eqRowH;
      // Label on left
      const labelPal = dimSlots ? [0x0F, 0x0F, 0x0F, 0x00] : fadedPal;
      const activePal = (dimSlots && r === eqCursor) ? fadedPal : labelPal;
      drawText(ctx, px + 24, iy, label, activePal);
      // Equipped item name on right (after label)
      if (slotId !== 0) {
        const name = getItemNameClean(slotId);
        drawText(ctx, px + 24, iy + 9, name, activePal);
      } else {
        const empty = new Uint8Array([0xC2,0xC2,0xC2]);
        drawText(ctx, px + 24, iy + 9, empty, activePal);
      }
    }
    // Optimum button (row 5, after a small gap)
    const optY = eqStartY + 5 * eqRowH + 4;
    const optPal = dimSlots ? [0x0F, 0x0F, 0x0F, 0x00] : fadedPal;
    const optText = new Uint8Array([0x98,0xD9,0xDD,0xD2,0xD6,0xDE,0xD6]); // "Optimum"
    drawText(ctx, px + 24, optY, optText, optPal);
    // Cursor on equip slots or optimum (not during item selection)
    if (cursorTileCanvas && (pauseState === 'equip') && fadeStep === 0) {
      const curY = eqCursor < 5 ? eqStartY + eqCursor * eqRowH - 4 : optY - 4;
      ctx.drawImage(cursorTileCanvas, px + 8, curY);
    }
  }

  // --- Equip item list (shown during item selection for a slot) ---
  const showEqItems = pauseState === 'eq-items-in' || pauseState === 'eq-item-select' || pauseState === 'eq-items-out';
  if (showEqItems) {
    let fadeStep = 0;
    if (pauseState === 'eq-items-in') {
      fadeStep = PAUSE_TEXT_STEPS - Math.min(Math.floor(pauseTimer / PAUSE_TEXT_STEP_MS), PAUSE_TEXT_STEPS);
    } else if (pauseState === 'eq-items-out') {
      fadeStep = Math.min(Math.floor(pauseTimer / PAUSE_TEXT_STEP_MS), PAUSE_TEXT_STEPS);
    }
    const fadedPal = [0x0F, 0x0F, 0x0F, 0x30];
    for (let s = 0; s < fadeStep; s++) fadedPal[3] = nesColorFade(fadedPal[3]);

    // Draw a blue separator line or just list items in the right portion
    const listX = px + 24;
    const listY = finalY + 12 + eqCursor * 22 + 22; // below the selected slot
    // If not enough room below, draw above
    const maxBelow = Math.floor((finalY + HUD_VIEW_H - 16 - listY) / 12);
    const useY = maxBelow >= eqItemList.length ? listY : finalY + 12;

    if (eqItemList.length === 0) {
      const noItems = new Uint8Array([0xC2,0xC2,0xC2]);
      drawText(ctx, listX, useY, noItems, fadedPal);
    } else {
      for (let i = 0; i < eqItemList.length; i++) {
        const entry = eqItemList[i];
        const iy = useY + i * 12;
        if (iy + 8 > finalY + HUD_VIEW_H - 8) break; // clip
        if (entry.label === 'remove') {
          const removeText = new Uint8Array([0x9B,0xCE,0xD6,0xD8,0xDF,0xCE]); // "Remove"
          drawText(ctx, listX + 16, iy, removeText, fadedPal);
        } else {
          const name = getItemNameClean(entry.id);
          drawText(ctx, listX + 16, iy, name, fadedPal);
        }
      }
      // Cursor
      if (cursorTileCanvas && pauseState === 'eq-item-select' && fadeStep === 0) {
        const curY = useY + eqItemCursor * 12 - 4;
        ctx.drawImage(cursorTileCanvas, listX, curY);
      }
    }
  }

  ctx.restore();

  // Target cursor on portrait during inv-target — drawn AFTER border+restore so it's on top, unclipped
  if (pauseState === 'inv-target' && cursorTileCanvas) {
    if (pauseInvAllyTarget >= 0) {
      // Cursor on selected roster player row in right panel
      const visRow = pauseInvAllyTarget - rosterScroll;
      if (visRow >= 0 && visRow < ROSTER_VISIBLE) {
        ctx.drawImage(cursorTileCanvas, HUD_RIGHT_X - 4, HUD_VIEW_Y + 32 + visRow * ROSTER_ROW_H + 12);
      }
    } else {
      // Cursor on player portrait
      ctx.drawImage(cursorTileCanvas, HUD_RIGHT_X - 4, HUD_VIEW_Y + 12);
    }
  }
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

function initKnifeSlashSprites() {
  // Diagonal slash effect for knife attacks — 3 frames (16×16 each)
  // Frame 0: slash start (top-right portion)
  // Frame 1: full diagonal slash
  // Frame 2: slash end (bottom-left portion, fading)
  // Uses pal3 from dual-knife trace: $0F/$1B/$2B/$30
  const white = NES_SYSTEM_PALETTE[0x30];   // white — main slash line
  const light = NES_SYSTEM_PALETTE[0x2B];   // light green — glow/trail
  const dark  = NES_SYSTEM_PALETTE[0x1B];   // dark blue-green — fading edge

  // Slash line: diagonal from (14,0) to (0,14) — 2px wide with 1px trail
  const FULL_LINE = [];
  for (let i = 0; i < 15; i++) {
    FULL_LINE.push([14 - i, i]);  // main diagonal
  }

  const frames = [];
  for (let f = 0; f < 3; f++) {
    const c = document.createElement('canvas');
    c.width = 16; c.height = 16;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(16, 16);

    function putPx(x, y, rgb) {
      if (x < 0 || x >= 16 || y < 0 || y >= 16) return;
      const di = (y * 16 + x) * 4;
      img.data[di] = rgb[0]; img.data[di+1] = rgb[1]; img.data[di+2] = rgb[2]; img.data[di+3] = 255;
    }

    let startI, endI;
    if (f === 0) { startI = 0; endI = 7; }       // top-right half
    else if (f === 1) { startI = 0; endI = 15; }  // full line
    else { startI = 7; endI = 15; }               // bottom-left half

    for (let i = startI; i < endI; i++) {
      const [x, y] = FULL_LINE[i];
      putPx(x, y, white);           // main line
      putPx(x + 1, y, light);       // right glow
      putPx(x, y + 1, light);       // bottom glow
      if (f === 2 && i < 10) {
        putPx(x, y, dark);          // fading portion in frame 2
        putPx(x + 1, y, dark);
      }
    }

    ctx.putImageData(img, 0, 0);
    frames.push(c);
  }

  knifeSlashFramesR = frames;
  knifeSlashFramesL = frames;
}

function initSwordSlashSprites() {
  // Sword slash effect from FCEUX PPU capture — tiles $4D/$4E/$4F
  // 3-frame diagonal sweep using actual NES tile data, pal3 $0F/$00/$32/$30
  const SWORD_SLASH_PAL = [0x0F, 0x00, 0x32, 0x30];
  const SLASH_4D = new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x03, 0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x03]);
  const SLASH_4E = new Uint8Array([0x00,0x04,0x00,0x18,0x30,0x60,0xC0,0x80, 0x02,0x10,0x28,0x00,0x60,0xC0,0x80,0x00]);
  const SLASH_4F = new Uint8Array([0x07,0x0E,0x1C,0x38,0x70,0xE0,0xC0,0x80, 0x07,0x0E,0x1C,0x38,0x70,0xE0,0xC0,0x80]);

  // Frame 0: top-right (tiles $4D at TL, $4E at TR)
  // Frame 1: middle (tiles $4D at TL, $4F at TR — or just $4F full)
  // Frame 2: bottom-left ($4F trailing)
  // Build 3 × 16×16 canvases from tile pairs
  const tilesets = [
    [SLASH_4D, SLASH_4E],  // frame 0: start
    [SLASH_4D, SLASH_4F],  // frame 1: middle
    [SLASH_4E, SLASH_4F],  // frame 2: end
  ];
  const frames = [];
  for (let f = 0; f < 3; f++) {
    const c = document.createElement('canvas');
    c.width = 16; c.height = 16;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(16, 16);
    const tiles = tilesets[f];
    for (let t = 0; t < 2; t++) {
      const d = tiles[t];
      const ox = t * 8;
      for (let row = 0; row < 8; row++) {
        const lo = d[row], hi = d[row + 8];
        for (let bit = 7; bit >= 0; bit--) {
          const val = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
          if (val === 0) continue;
          const rgb = NES_SYSTEM_PALETTE[SWORD_SLASH_PAL[val]] || [252, 252, 252];
          const px = ox + (7 - bit);
          const py = row;
          const di = (py * 16 + px) * 4;
          img.data[di] = rgb[0]; img.data[di+1] = rgb[1];
          img.data[di+2] = rgb[2]; img.data[di+3] = 255;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    frames.push(c);
  }
  swordSlashFramesR = frames;
  swordSlashFramesL = frames;
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
    } else {
      results.push({ miss: true });
    }
  }
  return results;
}

function buildTurnOrder() {
  const actors = [];
  const playerAgi = playerStats ? playerStats.agi : 5;
  actors.push({ type: 'player', priority: (playerAgi * 2) + Math.floor(Math.random() * 256) });
  // Allies participate in the same turn queue
  for (let i = 0; i < battleAllies.length; i++) {
    if (battleAllies[i].hp > 0)
      actors.push({ type: 'ally', index: i, priority: (battleAllies[i].agi * 2) + Math.floor(Math.random() * 256) });
  }
  if (isRandomEncounter && encounterMonsters) {
    for (let i = 0; i < encounterMonsters.length; i++) {
      if (encounterMonsters[i].hp > 0)
        actors.push({ type: 'enemy', index: i, priority: Math.floor(Math.random() * 256) });
    }
  } else {
    actors.push({ type: 'enemy', index: -1, priority: Math.floor(Math.random() * 256) });
  }
  actors.sort((a, b) => b.priority - a.priority);
  return actors;
}

let swBaseDamage = 0; // rolled once per throw, split among targets

function _applySWDamage(tidx) {
  if (!isRandomEncounter || !encounterMonsters) return;
  const mon = encounterMonsters[tidx];
  if (!mon || mon.hp <= 0) return;
  const dmg = Math.max(1, Math.floor(swBaseDamage / southWindTargets.length));
  mon.hp = Math.max(0, mon.hp - dmg);
  southWindDmgNums[tidx] = { value: dmg, timer: 0 };
  playSFX(SFX.SW_HIT);
}

function processNextTurn() {
  if (turnQueue.length === 0) {
    isDefending = false;
    battleCursor = 0;
    battleState = 'menu-open';
    battleTimer = 0;
    turnTimer = 0;
    return;
  }
  const turn = turnQueue.shift();
  if (turn.type === 'player') {
    if (playerActionPending.command === 'fight') {
      // Retarget if pre-selected enemy was killed by an ally this round
      let ti = playerActionPending.targetIndex;
      if (isRandomEncounter && encounterMonsters && ti >= 0 && encounterMonsters[ti].hp <= 0) {
        const living = encounterMonsters.findIndex(m => m.hp > 0);
        if (living < 0) {
          // All dead — skip player attack, victory will trigger
          processNextTurn();
          return;
        }
        ti = living;
      }
      currentHitIdx = 0;
      slashFrame = 0;
      hitResults = playerActionPending.hitResults;
      targetIndex = ti;
      slashFrames = playerActionPending.slashFrames;
      slashOffX = playerActionPending.slashOffX;
      slashOffY = playerActionPending.slashOffY;
      slashX = playerActionPending.slashX;
      slashY = playerActionPending.slashY;
      battleState = 'attack-start';
      battleTimer = 0;
    } else if (playerActionPending.command === 'defend') {
      playSFX(SFX.DEFEND_HIT);
      battleState = 'defend-anim';
      battleTimer = 0;
    } else if (playerActionPending.command === 'item') {
      isDefending = false;
      removeItem(playerActionPending.itemId);
      const _pendingItemDat = ITEMS.get(playerActionPending.itemId);
      if (_pendingItemDat?.type === 'battle_item') {
        // SouthWind / battle item — build target list and launch throw anim
        const _mode = playerActionPending.targetMode || 'single';
        const _rightCols = isRandomEncounter && encounterMonsters
          ? encounterMonsters.map((m, i) => (m.hp > 0 && (encounterMonsters.length === 1 || (encounterMonsters.length === 2 && i === 1) || (encounterMonsters.length >= 3 && (i === 1 || i === 3)))) ? i : -1).filter(i => i >= 0)
          : [];
        const _leftCols  = isRandomEncounter && encounterMonsters
          ? encounterMonsters.map((m, i) => (m.hp > 0 && (encounterMonsters.length >= 2) && !(_rightCols.includes(i))) ? i : -1).filter(i => i >= 0)
          : [];
        const _allAlive  = isRandomEncounter && encounterMonsters
          ? encounterMonsters.map((m, i) => m.hp > 0 ? i : -1).filter(i => i >= 0)
          : [];
        // 'all' order: TL→TR→BL→BR (left-to-right, top-to-bottom)
        if (_mode === 'all') {
          const ecnt = encounterMonsters ? encounterMonsters.length : 0;
          const rowOrder = ecnt <= 2 ? [0, 1] : [0, 1, 2, 3];
          southWindTargets = rowOrder.filter(i => i < ecnt && encounterMonsters[i].hp > 0);
        }
        else if (_mode === 'col-right') southWindTargets = _rightCols;
        else if (_mode === 'col-left') southWindTargets = _leftCols;
        else southWindTargets = [playerActionPending.target]; // single
        southWindHitIdx = 0;
        // SouthWind = spell $24, power 55. Formula: (INT/2 + 55) * rand / 2, split among targets
        const swInt = playerStats ? playerStats.int : 5;
        const swAttack = Math.floor(swInt / 2) + 55;
        const swRand = Math.floor(Math.random() * Math.floor(swAttack / 2 + 1));
        swBaseDamage = Math.floor((swAttack + swRand) / 2);
        battleState = 'sw-throw';
        battleTimer = 0;
      } else {
      playSFX(SFX.CURE);
      if (playerActionPending.target === 'player' && (playerActionPending.allyIndex === undefined || playerActionPending.allyIndex < 0)) {
        const heal = Math.min(50, playerStats.maxHP - playerHP);
        playerHP += heal;
        itemHealAmount = heal;
        playerHealNum = { value: heal, timer: 0 };
      } else if (playerActionPending.target === 'player' && playerActionPending.allyIndex >= 0) {
        const ally = battleAllies[playerActionPending.allyIndex];
        if (ally) {
          const heal = Math.min(50, ally.maxHP - ally.hp);
          ally.hp += heal;
          itemHealAmount = heal;
          allyDamageNums[playerActionPending.allyIndex] = { value: heal, timer: 0, heal: true };
        }
      } else {
        // Heal an enemy
        const ei = playerActionPending.target;
        const mon = isRandomEncounter && encounterMonsters ? encounterMonsters[ei] : null;
        if (mon) {
          const heal = Math.min(50, mon.maxHP - mon.hp);
          mon.hp += heal;
          itemHealAmount = heal;
          enemyHealNum = { value: heal, timer: 0, index: ei };
        } else {
          // Boss heal
          const heal = Math.min(50, BOSS_MAX_HP - bossHP);
          bossHP += heal;
          itemHealAmount = heal;
          enemyHealNum = { value: heal, timer: 0, index: 0 };
        }
      }
      battleState = 'item-use';
      battleTimer = 0;
      } // end else (consumable, not battle_item)
    } else if (playerActionPending.command === 'skip') {
      processNextTurn();
      return;
    } else if (playerActionPending.command === 'run') {
      // Escape chance: base 25 + AGI - avg enemy level / 4 (from FF3 disasm)
      const playerAgi = playerStats ? playerStats.agi : 5;
      let avgLevel = 1;
      if (encounterMonsters) {
        const alive = encounterMonsters.filter(m => m.hp > 0);
        if (alive.length > 0) avgLevel = alive.reduce((s, m) => s + (m.level || 1), 0) / alive.length;
      }
      const successRate = Math.min(99, Math.max(1, playerAgi + 25 - Math.floor(avgLevel / 4)));
      if (Math.floor(Math.random() * 100) < successRate) {
        // Success — monster name fades out, then "Ran away..." fades in
        battleState = 'run-name-out';
        battleTimer = 0;
      } else {
        // Failed — monster name fades out, "Can't run" fades in, turn consumed
        battleState = 'run-fail-name-out';
        battleTimer = 0;
      }
    }
  } else if (turn.type === 'ally') {
    // Ally turn — pick random living enemy target and attack
    currentAllyAttacker = turn.index;
    const ally = battleAllies[turn.index];
    if (!ally || ally.hp <= 0) { processNextTurn(); return; }
    if (isRandomEncounter && encounterMonsters) {
      const living = encounterMonsters.map((m, i) => m.hp > 0 ? i : -1).filter(i => i >= 0);
      if (living.length === 0) { processNextTurn(); return; }
      allyTargetIndex = living[Math.floor(Math.random() * living.length)];
    } else {
      allyTargetIndex = -1; // boss
    }
    const targetDef = allyTargetIndex >= 0 ? encounterMonsters[allyTargetIndex].def : BOSS_DEF;
    const hits = rollHits(ally.atk, targetDef, 85, 1);
    allyHitResult = hits[0];
    battleState = 'ally-attack-start';
    battleTimer = 0;
  } else {
    currentAttacker = turn.index;
    // Skip dead enemies (killed earlier this round)
    if (turn.index >= 0 && encounterMonsters && encounterMonsters[turn.index].hp <= 0) {
      processNextTurn();
      return;
    }
    battleState = 'boss-flash';
    battleTimer = 0;
  }
}

function startBattle() {
  battleState = 'roar-hold';
  battleTimer = 0;
  showMsgBox(BATTLE_ROAR, () => { battleState = 'flash-strobe'; battleTimer = 0; playSFX(SFX.BATTLE_SWIPE); });
  battleCursor = 0;
  battleMessage = null;
  bossDamageNum = null;
  playerDamageNum = null;
  playerHealNum = null;
  enemyHealNum = null;
  encounterDropItem = null;
  bossFlashTimer = 0;
  battleShakeTimer = 0;
  bossHP = BOSS_MAX_HP;
  isDefending = false;
  battleAllies = [];
  allyJoinRound = 0;
  currentAllyAttacker = -1;
  allyTargetIndex = -1;
  allyHitResult = null;
  allyDamageNums = {};
  allyShakeTimer = {};
  enemyTargetAllyIdx = -1;
  allyExitTimer = 0;
  southWindTargets = [];
  southWindHitIdx = 0;
  southWindDmgNums = {};
  playSFX(SFX.EARTHQUAKE);
}

function startRandomEncounter() {
  isRandomEncounter = true;

  // Pick encounter zone based on location
  const zoneKey = onWorldMap
    ? 'grasslands'
    : (['altar_cave_f1','altar_cave_f2','altar_cave_f3','altar_cave_f4'][dungeonFloor] || 'altar_cave_f1');
  const zone = ENCOUNTERS.get(zoneKey);
  const monPool = zone ? zone.monsters : [0x00];
  const minG = zone ? zone.minGroup : 1;
  const maxG = zone ? zone.maxGroup : 4;
  const count = minG + Math.floor(Math.random() * (maxG - minG + 1));

  encounterMonsters = [];
  for (let i = 0; i < count; i++) {
    const mid = monPool[Math.floor(Math.random() * monPool.length)];
    const mData = MONSTERS.get(mid) || MONSTERS.get(0x00);
    encounterMonsters.push({ monsterId: mid, hp: mData.hp, maxHP: mData.hp, atk: mData.atk, def: mData.def, exp: mData.exp, gil: mData.gil || 0, hitRate: GOBLIN_HIT_RATE });
  }
  preBattleTrack = TRACKS.CRYSTAL_CAVE;
  // Skip roar/earthquake — go straight to flash-strobe
  battleState = 'flash-strobe';
  battleTimer = 0;
  battleCursor = 0;
  battleMessage = null;
  bossDamageNum = null;
  playerDamageNum = null;
  playerHealNum = null;
  enemyHealNum = null;
  bossFlashTimer = 0;
  battleShakeTimer = 0;
  isDefending = false;
  battleAllies = [];
  allyJoinRound = 0;
  currentAllyAttacker = -1;
  allyTargetIndex = -1;
  allyHitResult = null;
  allyDamageNums = {};
  allyShakeTimer = {};
  enemyTargetAllyIdx = -1;
  allyExitTimer = 0;
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
    // Defend — pause for confirm SFX, then build turn queue
    playSFX(SFX.CONFIRM);
    isDefending = true;
    playerActionPending = { command: 'defend' };
    battleState = 'confirm-pause';
    battleTimer = 0;
  } else if (index === 2) {
    // Item — fade menu text out, show inventory on right side
    playSFX(SFX.CONFIRM);
    itemSelectList = buildItemSelectList();
    itemSelectCursor = 0;
    itemHeldIdx = -1;
    itemPage = 1;          // start on inventory page 1
    itemPageCursor = 0;
    itemSlideDir = 0;
    itemSlideCursor = 0;
    battleState = 'item-menu-out';
    battleTimer = 0;
  } else {
    // Run
    if (isRandomEncounter) {
      playSFX(SFX.CONFIRM);
      isDefending = false;
      playerActionPending = { command: 'run' };
      battleState = 'confirm-pause';
      battleTimer = 0;
    } else {
      playSFX(SFX.ERROR);
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
  for (const k of Object.keys(southWindDmgNums)) {
    southWindDmgNums[k].timer += dt;
    if (southWindDmgNums[k].timer >= 700) delete southWindDmgNums[k];
  }
  if (playerDamageNum) {
    playerDamageNum.timer += dt;
    if (playerDamageNum.timer >= BATTLE_DMG_SHOW_MS) playerDamageNum = null;
  }

  // Ally damage number timers
  for (const idx in allyDamageNums) {
    if (allyDamageNums[idx]) {
      allyDamageNums[idx].timer += dt;
      if (allyDamageNums[idx].timer >= BATTLE_DMG_SHOW_MS) delete allyDamageNums[idx];
    }
  }
  // Ally shake timers
  for (const idx in allyShakeTimer) {
    if (allyShakeTimer[idx] > 0) allyShakeTimer[idx] = Math.max(0, allyShakeTimer[idx] - dt);
  }

  // Turn timer — auto-skip player's turn after 10 seconds of inaction
  const isPlayerDeciding = battleState === 'menu-open' || battleState === 'target-select' ||
    battleState === 'item-select' || battleState === 'item-target-select' || battleState === 'item-slide';
  if (isPlayerDeciding) {
    turnTimer += dt;
    if (turnTimer >= TURN_TIME_MS) {
      turnTimer = 0;
      itemHeldIdx = -1;
      playerActionPending = { command: 'skip' };
      battleState = 'confirm-pause';
      battleTimer = 0;
    }
  }

  // Ally exit fade during victory — after 1.5s, NES-fade each ally out (1 step per 100ms)
  const ALLY_EXIT_DELAY_MS = 1500;
  const ALLY_EXIT_STEP_MS = 100;
  if (battleAllies.length > 0 && (
    battleState === 'victory-celebrate' || battleState === 'victory-text-in' ||
    battleState === 'victory-hold' || battleState === 'victory-fade-out' ||
    battleState === 'exp-text-in' || battleState === 'exp-hold' || battleState === 'exp-fade-out' ||
    battleState === 'gil-text-in' || battleState === 'gil-hold' || battleState === 'gil-fade-out' ||
    battleState === 'item-text-in' || battleState === 'item-hold' || battleState === 'item-fade-out' ||
    battleState === 'levelup-text-in' || battleState === 'levelup-hold' ||
    battleState === 'victory-text-out' || battleState === 'victory-menu-fade'
  )) {
    allyExitTimer += dt;
    if (allyExitTimer >= ALLY_EXIT_DELAY_MS) {
      const stepsDone = Math.floor((allyExitTimer - ALLY_EXIT_DELAY_MS) / ALLY_EXIT_STEP_MS);
      for (let i = 0; i < battleAllies.length; i++) {
        const targetFade = Math.min(4, stepsDone);
        if (battleAllies[i].fadeStep < targetFade) battleAllies[i].fadeStep = targetFade;
      }
    }
  }

  // State machine
  if (battleState === 'roar-hold') {
    // waits for msgBox Z dismiss → callback sets flash-strobe
  } else if (battleState === 'flash-strobe') {
    if (battleTimer >= BATTLE_FLASH_FRAMES * BATTLE_FLASH_FRAME_MS) {
      if (isRandomEncounter) {
        battleState = 'encounter-box-expand'; battleTimer = 0; pauseMusic(); playTrack(TRACKS.BATTLE);
      } else {
        battleState = 'boss-box-expand'; battleTimer = 0; pauseMusic(); playTrack(TRACKS.BOSS_BATTLE);
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
  } else if (battleState === 'confirm-pause') {
    // Brief pause so CONFIRM SFX is audible before turn queue starts
    if (battleTimer >= 150) {
      allyJoinRound++;
      // Ally join check: up to 3 allies (matches roster visible rows), 50% chance
      if (battleAllies.length < 3) {
        const loc = getPlayerLocation();
        const eligible = PLAYER_POOL.filter(p => p.loc === loc && !battleAllies.some(a => a.name === p.name));
        if (eligible.length > 0 && Math.random() < 0.5) {
          const pick = eligible[Math.floor(Math.random() * eligible.length)];
          const ally = generateAllyStats(pick);
          battleAllies.push(ally);
          battleState = 'ally-fade-in';
          battleTimer = 0;
          return;
        }
      }
      turnQueue = buildTurnOrder();
      processNextTurn();
    }
  } else if (battleState === 'attack-start') {
    // First hit: 100ms wind-up (confirm-pause already gave 150ms). Subsequent hits: 50ms (rapid combo)
    const startDelay = currentHitIdx === 0 ? 100 : 50;
    if (battleTimer >= startDelay) {
      const hw0 = getHitWeapon(currentHitIdx);
      const isBladed0 = isBladedWeapon(hw0);
      playSFX(isBladed0 ? SFX.KNIFE_HIT : SFX.ATTACK_HIT);
      if (isBladed0 && !(hitResults[currentHitIdx] && hitResults[currentHitIdx].crit)) { if (sfxCutTimerId) clearTimeout(sfxCutTimerId); sfxCutTimerId = setTimeout(() => { stopSFX(); sfxCutTimerId = null; }, 133); }
      battleState = 'player-slash';
      battleTimer = 0;
    }
  } else if (battleState === 'player-slash') {
    // 3-frame punch animation (50ms per frame = 150ms total)
    const frame = Math.floor(battleTimer / SLASH_FRAME_MS);
    if (frame !== slashFrame && frame < SLASH_FRAMES) {
      slashFrame = frame;
      // Weapon-aware frame positioning
      const handWeapon = getHitWeapon(currentHitIdx);
      if (isBladedWeapon(handWeapon)) {
        // Diagonal sweep: top-right to bottom-left over 3 frames
        slashOffX = 8 - slashFrame * 8;   // +8, 0, -8
        slashOffY = -8 + slashFrame * 8;  // -8, 0, +8
      } else {
        // Punch scatter
        slashOffX = Math.floor(Math.random() * 40) - 20;
        slashOffY = Math.floor(Math.random() * 40) - 20;
      }
    }
    if (battleTimer >= SLASH_FRAMES * SLASH_FRAME_MS) {
      const hit = hitResults[currentHitIdx];
      if (!hit.miss) {
        // Subtract damage from target (no number yet — total shown after combo)
        if (isRandomEncounter && encounterMonsters) {
          encounterMonsters[targetIndex].hp = Math.max(0, encounterMonsters[targetIndex].hp - hit.damage);
        } else {
          bossHP = Math.max(0, bossHP - hit.damage);
        }
        // Crit flash — 1 frame orange backdrop (NES: $27 for 1 frame)
        if (hit.crit) critFlashTimer = 0;
      }
      // Brief pause between slash and next action (no damage number shown yet)
      battleState = 'player-hit-show';
      battleTimer = 0;
    }
  } else if (battleState === 'player-hit-show') {
    // Brief pause between combo hits (50ms), or full HIT_PAUSE after last hit
    const hitPause = (currentHitIdx + 1 < hitResults.length) ? 50 : HIT_PAUSE_MS;
    if (battleTimer >= hitPause) {
      if (currentHitIdx + 1 < hitResults.length) {
        // More hits — next slash, alternate hands (R/L/R/L)
        // Route through attack-start for a pause between hits (250ms wind-up)
        currentHitIdx++;
        slashFrame = 0;
        { const handWeapon = getHitWeapon(currentHitIdx);
          slashFrames = getSlashFramesForWeapon(handWeapon, isHitRightHand(currentHitIdx));
          if (isBladedWeapon(handWeapon)) {
            slashOffX = 8; slashOffY = -8;
          } else {
            slashOffX = Math.floor(Math.random() * 40) - 20;
            slashOffY = Math.floor(Math.random() * 40) - 20;
          }
        }
        battleState = 'attack-start'; // pause before next hit (SFX plays in attack-start)
        battleTimer = 0;
      } else {
        // All hits done — total up damage, show number, then player-damage-show
        let totalDmg = 0, anyCrit = false, allMiss = true;
        for (const h of hitResults) {
          if (!h.miss) { totalDmg += h.damage; allMiss = false; if (h.crit) anyCrit = true; }
        }
        if (allMiss) {
          bossDamageNum = { miss: true, timer: 0 };
        } else {
          bossDamageNum = { value: totalDmg, crit: anyCrit, timer: 0 };
        }
        battleState = 'player-damage-show';
        battleTimer = 0;
      }
    }
  } else if (battleState === 'player-miss-show') {
    // Miss pause — same as hit-show but slightly longer
    if (battleTimer >= MISS_SHOW_MS) {
      if (currentHitIdx + 1 < hitResults.length) {
        // More hits to try, alternate hands
        currentHitIdx++;
        slashFrame = 0;
        { const handWeapon = getHitWeapon(currentHitIdx);
          slashFrames = getSlashFramesForWeapon(handWeapon, isHitRightHand(currentHitIdx));
          if (isBladedWeapon(handWeapon)) {
            slashOffX = 8; slashOffY = -8;
          } else {
            slashOffX = Math.floor(Math.random() * 40) - 20;
            slashOffY = Math.floor(Math.random() * 40) - 20;
          }
        }
        battleState = 'attack-start'; // pause before next hit
        battleTimer = 0;
      } else {
        // All hits done — total up damage
        let totalDmg = 0, anyCrit = false, allMiss = true;
        for (const h of hitResults) {
          if (!h.miss) { totalDmg += h.damage; allMiss = false; if (h.crit) anyCrit = true; }
        }
        if (allMiss) {
          bossDamageNum = { miss: true, timer: 0 };
        } else {
          bossDamageNum = { value: totalDmg, crit: anyCrit, timer: 0 };
        }
        battleState = 'player-damage-show';
        battleTimer = 0;
      }
    }
  } else if (battleState === 'player-damage-show') {
    if (battleTimer >= PLAYER_DMG_SHOW_MS) {
      // Check if targeted monster just died — play death stripe animation
      if (isRandomEncounter && encounterMonsters && encounterMonsters[targetIndex].hp <= 0) {
        dyingMonsterIndices = new Map([[targetIndex, 0]]);
        battleState = 'monster-death';
        battleTimer = 0;
        playSFX(SFX.MONSTER_DEATH);
      } else if (!isRandomEncounter && bossHP <= 0) {
        // Boss defeated — dissolve out
        battleState = 'boss-dissolve';
        battleTimer = 0;
        playSFX(SFX.BOSS_DEATH);
      } else {
        // Remaining turns in queue (enemies that haven't acted yet)
        processNextTurn();
      }
    }
  } else if (battleState === 'monster-death') {
    const _maxDelay = dyingMonsterIndices.size > 0 ? Math.max(...dyingMonsterIndices.values()) : 0;
    if (battleTimer >= MONSTER_DEATH_MS + _maxDelay) {
      dyingMonsterIndices = new Map();
      const allDead = encounterMonsters.every(m => m.hp <= 0);
      if (allDead) {
        encounterExpGained = encounterMonsters.reduce((sum, m) => sum + m.exp, 0);
        encounterGilGained = encounterMonsters.reduce((sum, m) => sum + (m.gil || 0), 0);
        grantExp(encounterExpGained);
        playerGil += encounterGilGained;
        // Roll item drops — 25% chance per monster, keep first hit
        encounterDropItem = null;
        for (const m of encounterMonsters) {
          const mData = MONSTERS.get(m.monsterId);
          if (mData && mData.drops && mData.drops.length && Math.random() < 0.25) {
            encounterDropItem = mData.drops[Math.floor(Math.random() * mData.drops.length)];
            break;
          }
        }
        if (encounterDropItem !== null) addItem(encounterDropItem, 1);
        if (saveSlots[selectCursor]) {
          saveSlots[selectCursor].level = playerStats.level;
          saveSlots[selectCursor].exp = playerStats.exp;
          saveSlots[selectCursor].stats = {
            str: playerStats.str, agi: playerStats.agi, vit: playerStats.vit,
            int: playerStats.int, mnd: playerStats.mnd,
            maxHP: playerStats.maxHP, maxMP: playerStats.maxMP,
            weaponR: playerWeaponR, weaponL: playerWeaponL,
            head: playerHead, body: playerBody, arms: playerArms
          };
          saveSlots[selectCursor].inventory = { ...playerInventory };
          saveSlots[selectCursor].gil = playerGil;
        }
        saveSlotsToDB();
        isDefending = false;
        battleState = 'victory-name-out';
        battleTimer = 0;
      } else {
        // Remaining turns in queue
        processNextTurn();
      }
    }
  } else if (battleState === 'defend-anim') {
    // Defend pose + sparkle for 32 frames (~533ms), then enemy turn
    if (battleTimer >= DEFEND_SPARKLE_TOTAL_MS) {
      // Remaining turns in queue
      processNextTurn();
    }
  } else if (battleState === 'item-use') {
    // Heal animation — same duration as defend sparkle, then next turn
    if (playerHealNum) {
      playerHealNum.timer += dt;
      if (playerHealNum.timer >= BATTLE_DMG_SHOW_MS) playerHealNum = null;
    }
    if (enemyHealNum) {
      enemyHealNum.timer += dt;
      if (enemyHealNum.timer >= BATTLE_DMG_SHOW_MS) enemyHealNum = null;
    }
    if (battleTimer >= DEFEND_SPARKLE_TOTAL_MS) {
      playerHealNum = null;
      enemyHealNum = null;
      processNextTurn();
    }
  } else if (battleState === 'sw-throw') {
    // Player throw pose for 250ms, then hit first target
    if (battleTimer >= 250) {
      if (southWindTargets.length === 0) { processNextTurn(); }
      else {
        southWindHitIdx = 0;
        _applySWDamage(southWindTargets[0]);
        battleState = 'sw-hit'; battleTimer = 0;
      }
    }
  } else if (battleState === 'sw-hit') {
    // Explosion animation: 3 phases × 133ms = 399ms, then hold damage number until 700ms
    if (battleTimer >= 700) {
      southWindHitIdx++;
      if (southWindHitIdx < southWindTargets.length) {
        _applySWDamage(southWindTargets[southWindHitIdx]);
        battleTimer = 0; // stay in sw-hit for next target
      } else {
        // All targets hit — check kills
        const killed = isRandomEncounter && encounterMonsters
          ? southWindTargets.filter(i => encounterMonsters[i] && encounterMonsters[i].hp <= 0)
          : [];
        if (killed.length > 0) {
          // Wave order: TR(1) → TL(0) → BR(3) → BL(2), 60ms stagger each
          const waveOrder = [1, 0, 3, 2];
          const ordered = waveOrder.filter(i => killed.includes(i));
          // Any killed not in wave order (e.g. single enemy idx 0) append last
          for (const i of killed) { if (!ordered.includes(i)) ordered.push(i); }
          dyingMonsterIndices = new Map(ordered.map((i, n) => [i, n * 60]));
          playSFX(SFX.MONSTER_DEATH);
          battleState = 'monster-death'; battleTimer = 0;
        } else { processNextTurn(); }
      }
    }
  } else if (battleState === 'item-menu-out') {
    // Menu text fades out, then inventory fades in on right side
    if (battleTimer >= (BATTLE_TEXT_STEPS + 1) * BATTLE_TEXT_STEP_MS) {
      battleState = 'item-list-in';
      battleTimer = 0;
    }
  } else if (battleState === 'item-list-in') {
    if (battleTimer >= (BATTLE_TEXT_STEPS + 1) * BATTLE_TEXT_STEP_MS) {
      battleState = 'item-select';
      battleTimer = 0;
    }
  } else if (battleState === 'item-slide') {
    // Slide transition between pages (200ms)
    if (battleTimer >= 200) {
      itemPage += (itemSlideDir < 0) ? 1 : -1;
      itemSlideDir = 0;
      itemPageCursor = itemSlideCursor;
      itemSlideCursor = 0;
      battleState = 'item-select';
      battleTimer = 0;
    }
  } else if (battleState === 'item-cancel-out') {
    // Inventory fades out on cancel
    if (battleTimer >= (BATTLE_TEXT_STEPS + 1) * BATTLE_TEXT_STEP_MS) {
      battleState = 'item-cancel-in';
      battleTimer = 0;
    }
  } else if (battleState === 'item-cancel-in') {
    // Menu text fades back in
    if (battleTimer >= (BATTLE_TEXT_STEPS + 1) * BATTLE_TEXT_STEP_MS) {
      itemPage = 1;
      battleState = 'menu-open';
      battleTimer = 0;
    }
  } else if (battleState === 'item-list-out') {
    // Inventory fades out after selecting a potion
    if (battleTimer >= (BATTLE_TEXT_STEPS + 1) * BATTLE_TEXT_STEP_MS) {
      battleState = 'item-use-menu-in';
      battleTimer = 0;
    }
  } else if (battleState === 'item-use-menu-in') {
    // Menu text fades back in before confirm-pause
    if (battleTimer >= (BATTLE_TEXT_STEPS + 1) * BATTLE_TEXT_STEP_MS) {
      battleState = 'confirm-pause';
      battleTimer = 0;
    }
  } else if (battleState === 'run-name-out') {
    // Monster name fades out (same as victory-name-out)
    if (battleTimer >= (BATTLE_TEXT_STEPS + 1) * BATTLE_TEXT_STEP_MS) {
      sprite.setDirection(DIR_DOWN);
      playSFX(SFX.RUN_AWAY);
      battleState = 'run-text-in';
      battleTimer = 0;
    }
  } else if (battleState === 'run-text-in') {
    // "Ran away..." fades in
    if (battleTimer >= (BATTLE_TEXT_STEPS + 1) * BATTLE_TEXT_STEP_MS) {
      battleState = 'run-hold';
      battleTimer = 0;
    }
  } else if (battleState === 'run-hold') {
    // Hold for ~1.35s (total ~1.85s including fade-in)
    if (battleTimer >= 1350) {
      battleState = 'run-text-out';
      battleTimer = 0;
    }
  } else if (battleState === 'run-text-out') {
    // "Ran away..." fades out, then close encounter box
    if (battleTimer >= (BATTLE_TEXT_STEPS + 1) * BATTLE_TEXT_STEP_MS) {
      runSlideBack = true;
      battleState = 'encounter-box-close';
      battleTimer = 0;
    }
  } else if (battleState === 'run-fail-name-out') {
    // Monster name fades out (fast)
    if (battleTimer >= (BATTLE_TEXT_STEPS + 1) * 50) {
      battleState = 'run-fail-text-in';
      battleTimer = 0;
    }
  } else if (battleState === 'run-fail-text-in') {
    // "Can't run" fades in (fast)
    if (battleTimer >= (BATTLE_TEXT_STEPS + 1) * 50) {
      battleState = 'run-fail-hold';
      battleTimer = 0;
    }
  } else if (battleState === 'run-fail-hold') {
    // Hold ~300ms
    if (battleTimer >= 300) {
      battleState = 'run-fail-text-out';
      battleTimer = 0;
    }
  } else if (battleState === 'run-fail-text-out') {
    // "Can't run" fades out (fast)
    if (battleTimer >= (BATTLE_TEXT_STEPS + 1) * 50) {
      battleState = 'run-fail-name-in';
      battleTimer = 0;
    }
  } else if (battleState === 'run-fail-name-in') {
    // Monster name fades back in (fast)
    if (battleTimer >= (BATTLE_TEXT_STEPS + 1) * 50) {
      processNextTurn();
    }
  } else if (battleState === 'ally-fade-in') {
    // Fade the newly joined ally portrait in (4 steps × 100ms)
    const newAlly = battleAllies[battleAllies.length - 1];
    if (newAlly && battleTimer >= 100) {
      newAlly.fadeStep = Math.max(0, newAlly.fadeStep - 1);
      battleTimer = 0;
      if (newAlly.fadeStep <= 0) {
        turnQueue = buildTurnOrder();
        processNextTurn();
      }
    }
  } else if (battleState === 'ally-attack-start') {
    // 100ms wind-up, flash ally row, play weapon SFX
    if (battleTimer >= 100) {
      const ally = battleAllies[currentAllyAttacker];
      const bladed = ally && isBladedWeapon(ally.weaponId);
      playSFX(bladed ? SFX.KNIFE_HIT : SFX.ATTACK_HIT);
      if (bladed && !(allyHitResult && allyHitResult.crit)) {
        if (sfxCutTimerId) clearTimeout(sfxCutTimerId);
        sfxCutTimerId = setTimeout(() => { stopSFX(); sfxCutTimerId = null; }, 133);
      }
      battleState = 'ally-slash';
      battleTimer = 0;
    }
  } else if (battleState === 'ally-slash') {
    // Punch effect on target (3 frames × ~67ms = ~200ms)
    if (battleTimer >= 200) {
      // Apply damage to target
      if (allyHitResult && !allyHitResult.miss) {
        if (allyTargetIndex >= 0 && encounterMonsters) {
          encounterMonsters[allyTargetIndex].hp = Math.max(0, encounterMonsters[allyTargetIndex].hp - allyHitResult.damage);
        } else if (allyTargetIndex < 0) {
          bossHP = Math.max(0, bossHP - allyHitResult.damage);
        }
        if (allyHitResult.crit) critFlashTimer = 0;
        bossDamageNum = { value: allyHitResult.damage, crit: allyHitResult.crit, timer: 0 };
        // Temporarily set targetIndex for damage number positioning
        targetIndex = allyTargetIndex;
      } else {
        bossDamageNum = { miss: true, timer: 0 };
        targetIndex = allyTargetIndex;
      }
      battleState = 'ally-damage-show';
      battleTimer = 0;
    }
  } else if (battleState === 'ally-damage-show') {
    if (battleTimer >= 700) {
      // Check if targeted monster/boss died
      if (isRandomEncounter && encounterMonsters && allyTargetIndex >= 0 && encounterMonsters[allyTargetIndex].hp <= 0) {
        dyingMonsterIndices = new Map([[allyTargetIndex, 0]]);
        battleState = 'monster-death';
        battleTimer = 0;
        playSFX(SFX.MONSTER_DEATH);
      } else if (!isRandomEncounter && bossHP <= 0) {
        battleState = 'boss-dissolve';
        battleTimer = 0;
        playSFX(SFX.BOSS_DEATH);
      } else {
        processNextTurn();
      }
    }
  } else if (battleState === 'ally-hit') {
    // Ally taking damage — shake portrait
    if (battleTimer >= BATTLE_SHAKE_MS) {
      battleState = 'ally-damage-show-enemy';
      battleTimer = 0;
    }
  } else if (battleState === 'ally-damage-show-enemy') {
    if (battleTimer >= BATTLE_DMG_SHOW_MS) {
      const ally = battleAllies[enemyTargetAllyIdx];
      if (ally && ally.hp <= 0) {
        // Ally KO — fade out and show retreat message
        battleState = 'ally-ko-fade';
        battleTimer = 0;
      } else {
        enemyTargetAllyIdx = -1;
        processNextTurn();
      }
    }
  } else if (battleState === 'ally-ko-fade') {
    // Fade out KO'd ally (4 steps × 100ms)
    const koAlly = battleAllies[enemyTargetAllyIdx];
    if (koAlly && battleTimer >= 100) {
      koAlly.fadeStep = Math.min(ROSTER_FADE_STEPS, koAlly.fadeStep + 1);
      battleTimer = 0;
      if (koAlly.fadeStep >= ROSTER_FADE_STEPS) {
        const retreatBytes = _nameToBytes(koAlly.name + ' retreated!');
        showMsgBox(retreatBytes, () => {
          // Remove from turn queue
          turnQueue = turnQueue.filter(t => !(t.type === 'ally' && t.index === enemyTargetAllyIdx));
          enemyTargetAllyIdx = -1;
          processNextTurn();
        });
        battleState = 'ally-ko-msg';
      }
    }
  } else if (battleState === 'ally-ko-msg') {
    // Waiting for message box dismiss
  } else if (battleState === 'boss-flash') {
    if (battleTimer >= BOSS_PREFLASH_MS) {
      // Choose target: player or an ally
      const livingAllies = battleAllies.filter(a => a.hp > 0);
      let targetAlly = -1;
      if (livingAllies.length > 0) {
        // 1/(1+livingAllies) chance to target player, else random ally
        if (Math.random() >= 1 / (1 + livingAllies.length)) {
          const allyOptions = battleAllies.map((a, i) => a.hp > 0 ? i : -1).filter(i => i >= 0);
          targetAlly = allyOptions[Math.floor(Math.random() * allyOptions.length)];
        }
      }
      // Roll accuracy for current attacker
      const monHitRate = (currentAttacker >= 0 && encounterMonsters)
        ? (encounterMonsters[currentAttacker].hitRate || GOBLIN_HIT_RATE) : BOSS_HIT_RATE;
      if (targetAlly >= 0) {
        // Targeting an ally
        enemyTargetAllyIdx = targetAlly;
        const monAtk = (currentAttacker >= 0 && encounterMonsters)
          ? encounterMonsters[currentAttacker].atk : BOSS_ATK;
        if (Math.random() * 100 < monHitRate) {
          let dmg = calcDamage(monAtk, battleAllies[targetAlly].def);
          battleAllies[targetAlly].hp = Math.max(0, battleAllies[targetAlly].hp - dmg);
          allyDamageNums[targetAlly] = { value: dmg, timer: 0 };
          allyShakeTimer[targetAlly] = BATTLE_SHAKE_MS;
          playSFX(SFX.ATTACK_HIT);
          battleState = 'ally-hit';
          battleTimer = 0;
        } else {
          allyDamageNums[targetAlly] = { miss: true, timer: 0 };
          battleState = 'ally-damage-show-enemy';
          battleTimer = 0;
        }
      } else {
        // Targeting player (original logic)
        if (Math.random() * 100 < monHitRate) {
          const monAtk = (currentAttacker >= 0 && encounterMonsters)
            ? encounterMonsters[currentAttacker].atk : BOSS_ATK;
          let dmg = calcDamage(monAtk, playerDEF);
          if (isDefending) dmg = Math.max(1, Math.floor(dmg / 2));
          playerHP = Math.max(0, playerHP - dmg);
          playerDamageNum = { value: dmg, timer: 0 };
          playSFX(SFX.ATTACK_HIT);
          battleShakeTimer = BATTLE_SHAKE_MS;
          battleState = 'enemy-attack';
          battleTimer = 0;
        } else {
          playerDamageNum = { miss: true, timer: 0 };
          battleState = 'enemy-damage-show';
          battleTimer = 0;
        }
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
        // Player defeated — monster fade out → game over → respawn
        isDefending = false;
        battleState = 'defeat-monster-fade';
        battleTimer = 0;
      } else {
        // Next turn in queue (or back to menu if empty)
        processNextTurn();
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
      encounterGilGained = 500;
      grantExp(20);
      playerGil += encounterGilGained;
      // Update active save slot with current stats
      if (saveSlots[selectCursor]) {
        saveSlots[selectCursor].level = playerStats.level;
        saveSlots[selectCursor].exp = playerStats.exp;
        saveSlots[selectCursor].stats = {
          str: playerStats.str, agi: playerStats.agi, vit: playerStats.vit,
          int: playerStats.int, mnd: playerStats.mnd,
          maxHP: playerStats.maxHP, maxMP: playerStats.maxMP,
          weaponR: playerWeaponR, weaponL: playerWeaponL,
            head: playerHead, body: playerBody, arms: playerArms
        };
        saveSlots[selectCursor].inventory = { ...playerInventory };
      }
      saveSlotsToDB();
      isDefending = false;
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
      battleState = 'victory-text-in';
      battleTimer = 0;
    }
  } else if (battleState === 'victory-text-in') {
    if (battleTimer >= (BATTLE_TEXT_STEPS + 1) * BATTLE_TEXT_STEP_MS) { battleState = 'victory-hold'; battleTimer = 0; }
  } else if (battleState === 'victory-hold') {
    // waits for Z press in handleInput
  } else if (battleState === 'victory-fade-out') {
    if (battleTimer >= (BATTLE_TEXT_STEPS + 1) * BATTLE_TEXT_STEP_MS) { battleState = 'exp-text-in'; battleTimer = 0; }
  } else if (battleState === 'exp-text-in') {
    if (battleTimer >= (BATTLE_TEXT_STEPS + 1) * BATTLE_TEXT_STEP_MS) { battleState = 'exp-hold'; battleTimer = 0; }
  } else if (battleState === 'exp-hold') {
    // waits for Z press in handleInput
  } else if (battleState === 'exp-fade-out') {
    if (battleTimer >= (BATTLE_TEXT_STEPS + 1) * BATTLE_TEXT_STEP_MS) { battleState = 'gil-text-in'; battleTimer = 0; }
  } else if (battleState === 'gil-text-in') {
    if (battleTimer >= (BATTLE_TEXT_STEPS + 1) * BATTLE_TEXT_STEP_MS) { battleState = 'gil-hold'; battleTimer = 0; }
  } else if (battleState === 'gil-hold') {
    // waits for Z press in handleInput
  } else if (battleState === 'gil-fade-out') {
    if (battleTimer >= (BATTLE_TEXT_STEPS + 1) * BATTLE_TEXT_STEP_MS) {
      battleState = encounterDropItem !== null ? 'item-text-in' : 'levelup-text-in'; battleTimer = 0;
    }
  } else if (battleState === 'item-text-in') {
    if (battleTimer >= (BATTLE_TEXT_STEPS + 1) * BATTLE_TEXT_STEP_MS) { battleState = 'item-hold'; battleTimer = 0; }
  } else if (battleState === 'item-hold') {
    // waits for Z press in handleInput
  } else if (battleState === 'item-fade-out') {
    if (battleTimer >= (BATTLE_TEXT_STEPS + 1) * BATTLE_TEXT_STEP_MS) { battleState = 'levelup-text-in'; battleTimer = 0; }
  } else if (battleState === 'levelup-text-in') {
    if (battleTimer >= (BATTLE_TEXT_STEPS + 1) * BATTLE_TEXT_STEP_MS) { battleState = 'levelup-hold'; battleTimer = 0; }
  } else if (battleState === 'levelup-hold') {
    // waits for Z press in handleInput
  } else if (battleState === 'victory-text-out') {
    if (battleTimer >= (BATTLE_TEXT_STEPS + 1) * BATTLE_TEXT_STEP_MS) {
      battleState = 'victory-menu-fade'; battleTimer = 0;
    }
  } else if (battleState === 'victory-menu-fade') {
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
      runSlideBack = false;
      sprite.setDirection(DIR_DOWN);
      isRandomEncounter = false;
      encounterMonsters = null;
      dyingMonsterIndices = new Map();
      battleAllies = [];
      allyJoinRound = 0;
      stopMusic(); resumeMusic();
    }
  } else if (battleState === 'boss-box-close') {
    if (battleTimer >= BOSS_BOX_EXPAND_MS) {
      battleState = 'none';
      battleTimer = 0;
      sprite.setDirection(DIR_DOWN);
      battleAllies = [];
      allyJoinRound = 0;
      playTrack(TRACKS.CRYSTAL_ROOM);
    }
  } else if (battleState === 'defeat-monster-fade') {
    stopMusic();
    if (battleTimer >= 500) {
      battleState = 'defeat-text';
      battleTimer = 0;
    }
  } else if (battleState === 'defeat-text') {
    // Z to dismiss — handled in handleInput
  } else if (battleState === 'defeat-close') {
    if (battleTimer >= BOSS_BOX_EXPAND_MS) {
      // Clean up battle state
      battleState = 'none';
      battleTimer = 0;
      isRandomEncounter = false;
      encounterMonsters = null;
      turnQueue = [];
      battleAllies = [];
      allyJoinRound = 0;
      playerHP = playerStats ? playerStats.maxHP : 28;
      playerMP = playerStats ? playerStats.maxMP : 0;
      // Screen close → respawn outside dungeon entrance on world map → screen open
      startWipeTransition(() => {
        const exitIdx = findWorldExitIndex(111);
        dungeonFloor = -1;
        encounterSteps = 0;
        mapStack = [];
        loadWorldMapAt(exitIdx);
      }, 'world');
    }
  }
}

function drawSWExplosion() {
  if (battleState !== 'sw-hit') return;
  if (!swPhaseCanvases.length || !isRandomEncounter || !encounterMonsters) return;

  const count = encounterMonsters.length;
  const { fullW, fullH, sprH } = _encounterBoxDims();
  const boxX = HUD_VIEW_X + Math.floor((HUD_VIEW_W - fullW) / 2);
  const boxY = HUD_VIEW_Y + Math.floor((HUD_VIEW_H - fullH) / 2);
  const swGridPos = _encounterGridPos(boxX, boxY, fullW, fullH, count, sprH);

  const tidx = southWindTargets[southWindHitIdx];
  if (tidx === undefined || tidx >= swGridPos.length) return;

  const tp = swGridPos[tidx];
  const m = encounterMonsters[tidx];
  const mc = monsterBattleCanvas.get(m?.monsterId) || goblinBattleCanvas;
  const mh = mc ? mc.height : sprH;

  // Phase = 0/1/2 based on 133ms intervals
  const phase = Math.min(2, Math.floor(battleTimer / 133));
  const phaseCanvas = swPhaseCanvases[phase];
  if (!phaseCanvas) return;

  // Center explosion on the target monster sprite
  const cx = tp.x + 16; // center x of 32px sprite
  const cy = tp.y + (sprH - mh) + Math.floor(mh / 2); // vertical center
  const ex = cx - Math.floor(phaseCanvas.width / 2);
  const ey = cy - Math.floor(phaseCanvas.height / 2);

  ctx.drawImage(phaseCanvas, ex, ey);
}

function drawSWDamageNumbers() {
  if (battleState !== 'sw-hit' || !isRandomEncounter || !encounterMonsters) return;
  const count = encounterMonsters.length;
  const { fullW, fullH, sprH: dSprH } = _encounterBoxDims();
  const boxX = HUD_VIEW_X + Math.floor((HUD_VIEW_W - fullW) / 2);
  const boxY = HUD_VIEW_Y + Math.floor((HUD_VIEW_H - fullH) / 2);
  const swGridPos = _encounterGridPos(boxX, boxY, fullW, fullH, count, dSprH);
  for (const [k, dn] of Object.entries(southWindDmgNums)) {
    const idx = parseInt(k);
    if (idx >= swGridPos.length) continue;
    const tp = swGridPos[idx];
    const m = encounterMonsters[idx];
    const mc = monsterBattleCanvas.get(m?.monsterId) || goblinBattleCanvas;
    const mh = mc ? mc.height : dSprH;
    const bx = tp.x + 16;
    const baseY = tp.y + (dSprH - mh) + Math.floor(mh / 2) - 8;
    const by = _dmgBounceY(baseY, dn.timer);
    const digits = String(dn.value);
    const numBytes = new Uint8Array(digits.length);
    for (let i = 0; i < digits.length; i++) numBytes[i] = 0x80 + parseInt(digits[i]);
    drawText(ctx, bx - Math.floor(digits.length * 4), by, numBytes, DMG_NUM_PAL);
  }
}

function drawBattle() {
  if (battleState === 'none') return;

  // Crit flash — 1 frame orange backdrop behind everything (NES $27 = #DAA336)
  if (critFlashTimer >= 0) {
    if (critFlashTimer === 0) critFlashTimer = Date.now();
    if (Date.now() - critFlashTimer < 17) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);
      ctx.clip();
      ctx.fillStyle = '#DAA336';
      ctx.fillRect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);
      ctx.restore();
    } else {
      critFlashTimer = -1;
    }
  }

  // Player sprite portrait — drawn over border during battle
  const shakeOff = (battleState === 'enemy-attack' && battleShakeTimer > 0)
    ? (Math.floor(battleShakeTimer / 67) & 1 ? 2 : -2) : 0;
  const isVictoryPose = battleState === 'victory-celebrate' ||
    battleState === 'victory-text-in' || battleState === 'victory-hold' || battleState === 'victory-fade-out' ||
    battleState === 'exp-text-in' || battleState === 'exp-hold' || battleState === 'exp-fade-out' ||
    battleState === 'gil-text-in' || battleState === 'gil-hold' || battleState === 'gil-fade-out' ||
    battleState === 'levelup-text-in' || battleState === 'levelup-hold' ||
    battleState === 'item-text-in' || battleState === 'item-hold' || battleState === 'item-fade-out' ||
    battleState === 'victory-text-out' || battleState === 'victory-menu-fade' || battleState === 'victory-box-close';
  const isAttackPose = battleState === 'attack-start' || battleState === 'player-slash';
  const isHitPose = battleState === 'enemy-attack' ||
    (battleState === 'enemy-damage-show' && playerDamageNum && !playerDamageNum.miss);
  const isDefendPose = battleState === 'defend-anim';
  const isItemUsePose = battleState === 'item-use' || battleState === 'sw-throw' || battleState === 'sw-hit';
  const isRunPose = battleState === 'run-name-out' || battleState === 'run-text-in' ||
    battleState === 'run-hold' || battleState === 'run-text-out';
  const isNearFatal = playerHP > 0 && playerStats && playerHP <= Math.floor(playerStats.maxHP / 4);
  let portraitSrc = (isNearFatal && battleSpriteKneelCanvas) ? battleSpriteKneelCanvas : battleSpriteCanvas;
  if (isAttackPose) {
    // Frame 1 (attack-start): arm raised (R=$39, L=$3B/$3C) — same for all weapons
    // Frame 2 (player-slash): body returns to idle
    if (battleState === 'attack-start') {
      if (isHitRightHand(currentHitIdx)) {
        portraitSrc = battleSpriteAttackCanvas || portraitSrc;
      } else {
        portraitSrc = battleSpriteAttackLCanvas || portraitSrc;
      }
    }
    // else: portraitSrc stays as battleSpriteCanvas (idle) — correct per trace
  } else if ((isDefendPose || isItemUsePose) && battleSpriteDefendCanvas) {
    portraitSrc = battleSpriteDefendCanvas;
  } else if (isHitPose && battleSpriteHitCanvas) {
    portraitSrc = battleSpriteHitCanvas;
  } else if (isVictoryPose && battleSpriteVictoryCanvas) {
    if (Math.floor(Date.now() / 250) & 1) portraitSrc = battleSpriteVictoryCanvas;
  }
  if (portraitSrc) {
    const px = HUD_RIGHT_X + 8 + shakeOff;
    const py = HUD_VIEW_Y + 8;
    if (isAttackPose) {
      const handWeapon = getHitWeapon(currentHitIdx);
      const wpnSt = weaponSubtype(handWeapon);
      // Back swing: right hand blade BEHIND body, left hand blade IN FRONT
      if (battleState === 'attack-start' && isHitRightHand(currentHitIdx)) {
        if (wpnSt === 'knife' && battleKnifeBladeCanvas) {
          ctx.drawImage(battleKnifeBladeCanvas, px + 8, py - 7);
        } else if (wpnSt === 'dagger' && battleDaggerBladeCanvas) {
          ctx.drawImage(battleDaggerBladeCanvas, px + 8, py - 7);
        } else if (wpnSt === 'sword' && battleSwordBladeCanvas) {
          ctx.drawImage(battleSwordBladeCanvas, px + 8, py - 7);
        }
      }
    }
    if (isRunPose) {
      // H-flip and slide right out of the portrait box, clipped to border
      let slideX = 0;
      if (battleState === 'run-text-in') {
        slideX = Math.min(battleTimer / 300, 1) * 20;
      } else if (battleState === 'run-hold' || battleState === 'run-text-out') {
        slideX = 20;
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(HUD_RIGHT_X + 8, HUD_VIEW_Y + 8, 16, 16);
      ctx.clip();
      ctx.translate(px + 16 + slideX, py);
      ctx.scale(-1, 1);
      ctx.drawImage(portraitSrc, 0, 0);
      ctx.restore();
    } else if (battleState === 'encounter-box-close' && runSlideBack) {
      // Slide back up into position from below
      const t = Math.min(battleTimer / 300, 1);
      const slideY = (1 - t) * 20;
      ctx.save();
      ctx.beginPath();
      ctx.rect(HUD_RIGHT_X + 8, HUD_VIEW_Y + 8, 16, 16);
      ctx.clip();
      ctx.drawImage(portraitSrc, px, py + slideY);
      ctx.restore();
    } else {
      ctx.drawImage(portraitSrc, px, py);
    }
    if (isAttackPose) {
      const handWeapon = getHitWeapon(currentHitIdx);
      const wpnSt = weaponSubtype(handWeapon);
      // Left hand back swing: blade OVER body
      if (battleState === 'attack-start' && !isHitRightHand(currentHitIdx)) {
        if (wpnSt === 'knife' && battleKnifeBladeCanvas) {
          ctx.drawImage(battleKnifeBladeCanvas, px + 8, py - 7);
        } else if (wpnSt === 'dagger' && battleDaggerBladeCanvas) {
          ctx.drawImage(battleDaggerBladeCanvas, px + 8, py - 7);
        } else if (wpnSt === 'sword' && battleSwordBladeCanvas) {
          ctx.drawImage(battleSwordBladeCanvas, px + 8, py - 7);
        }
      }
      if (battleState === 'player-slash') {
        if (wpnSt === 'knife' && battleKnifeBladeSwungCanvas) {
          ctx.drawImage(battleKnifeBladeSwungCanvas, px - 16, py + 1);
        } else if (wpnSt === 'dagger' && battleDaggerBladeSwungCanvas) {
          ctx.drawImage(battleDaggerBladeSwungCanvas, px - 16, py + 1);
        } else if (wpnSt === 'sword' && battleSwordBladeSwungCanvas) {
          ctx.drawImage(battleSwordBladeSwungCanvas, px - 16, py + 1);
        } else if (!wpnSt && handWeapon === 0 && battleFistCanvas) {
          ctx.drawImage(battleFistCanvas, px - 4, py + 10);
        }
      }
    }
    // Defend sparkle — 4 corners cycling $49→$4A→$4B→$4C during defend-anim
    // Adjusted for 16×16 portrait: TL(-8,-7), TR(+16,-7), BL(-8,+17), BR(+16,+17)
    if (isDefendPose && defendSparkleFrames.length === 4) {
      const fi = Math.min(3, Math.floor(battleTimer / DEFEND_SPARKLE_FRAME_MS));
      const frame = defendSparkleFrames[fi];
      // TL: normal
      ctx.drawImage(frame, px - 8, py - 7);
      // TR: H-flip
      ctx.save(); ctx.scale(-1, 1);
      ctx.drawImage(frame, -(px + 23), py - 7);
      ctx.restore();
      // BL: V-flip
      ctx.save(); ctx.scale(1, -1);
      ctx.drawImage(frame, px - 8, -(py + 24));
      ctx.restore();
      // BR: HV-flip
      ctx.save(); ctx.scale(-1, -1);
      ctx.drawImage(frame, -(px + 23), -(py + 24));
      ctx.restore();
    }
    // Cure sparkle — $4D/$4E at 4 corners, alternating flips every 67ms
    // Same corner positions as defend: TL(-8,-7), TR(+16,-7), BL(-8,+17), BR(+16,+17)
    if (battleState === 'item-use' && cureSparkleFrames.length === 2 && !(playerActionPending && playerActionPending.allyIndex >= 0)) {
      const fi = Math.floor(battleTimer / 67) & 1;
      const frame = cureSparkleFrames[fi];
      // TL
      ctx.drawImage(frame, px - 8, py - 7);
      // TR: H-flip
      ctx.save(); ctx.scale(-1, 1);
      ctx.drawImage(frame, -(px + 23), py - 7);
      ctx.restore();
      // BL: V-flip
      ctx.save(); ctx.scale(1, -1);
      ctx.drawImage(frame, px - 8, -(py + 24));
      ctx.restore();
      // BR: HV-flip
      ctx.save(); ctx.scale(-1, -1);
      ctx.drawImage(frame, -(px + 23), -(py + 24));
      ctx.restore();
    }
    // Near-fatal sweat — scattered white dots above portrait (PPU tiles $49-$4C)
    // 2 frames alternating every 133ms (8 NES frames), positioned 3px above portrait
    if (isNearFatal && sweatFrames.length === 2 && !isAttackPose && !isHitPose && !isVictoryPose && !isDefendPose && !isItemUsePose) {
      const sweatIdx = Math.floor(Date.now() / 133) & 1;
      if (isRunPose) {
        let slideX = 0;
        if (battleState === 'run-text-in') slideX = Math.min(battleTimer / 300, 1) * 20;
        else if (battleState === 'run-hold' || battleState === 'run-text-out') slideX = 20;
        ctx.save();
        ctx.beginPath();
        ctx.rect(HUD_RIGHT_X + 8, HUD_VIEW_Y + 8 - 3, 16, 19);
        ctx.clip();
        ctx.drawImage(sweatFrames[sweatIdx], px + slideX, py - 3);
        ctx.restore();
      } else if (battleState === 'encounter-box-close' && runSlideBack) {
        const t = Math.min(battleTimer / 300, 1);
        const slideY = (1 - t) * 20;
        ctx.save();
        ctx.beginPath();
        ctx.rect(HUD_RIGHT_X + 8, HUD_VIEW_Y + 8 - 3, 16, 19);
        ctx.clip();
        ctx.drawImage(sweatFrames[sweatIdx], px, py - 3 + slideY);
        ctx.restore();
      } else {
        ctx.drawImage(sweatFrames[sweatIdx], px, py - 3);
      }
    }

    // Item target cursor on player portrait (only when not targeting an ally)
    if (battleState === 'item-target-select' && itemTargetType === 'player' && itemTargetAllyIndex < 0 && cursorTileCanvas) {
      ctx.drawImage(cursorTileCanvas, px - 12, py + 4);
    }
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

  // roar box now drawn by universal drawMsgBox()
  drawEncounterBox();
  drawBossSpriteBox();
  drawBattleMenu();
  drawBattleMessage();
  drawVictoryBox();

  drawDamageNumbers();

  // Defeat — monster fade out (alpha decreasing over 500ms)
  if (battleState === 'defeat-monster-fade' || battleState === 'defeat-text' || battleState === 'defeat-close') {
    // Fade monsters to black by drawing black overlay with increasing alpha over encounter box
    if (battleState === 'defeat-monster-fade') {
      const alpha = Math.min(battleTimer / 500, 1);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#000';
      const ecx = HUD_VIEW_X + HUD_VIEW_W / 2;
      const ecy = HUD_VIEW_Y + HUD_VIEW_H / 2;
      if (isRandomEncounter && encounterMonsters) {
        const { fullW: fw, fullH: fh } = _encounterBoxDims();
        ctx.fillRect(Math.round(ecx - fw / 2) + 8, Math.round(ecy - fh / 2) + 8, fw - 16, fh - 16);
      } else {
        ctx.fillRect(ecx - 24, ecy - 24, 48, 48);
      }
      ctx.restore();
    }
  }

  // "Game Over" text centered in encounter/boss box (viewport)
  if (battleState === 'defeat-text') {
    const ecx = HUD_VIEW_X + HUD_VIEW_W / 2;
    const ecy = HUD_VIEW_Y + HUD_VIEW_H / 2;
    const tw = measureText(BATTLE_GAME_OVER);
    drawText(ctx, Math.floor(ecx - tw / 2), Math.floor(ecy - 4), BATTLE_GAME_OVER, TEXT_WHITE);
  }
}

// drawRoarBox removed — now uses universal msgBox

function drawBattleMenu() {
  const isSlide = battleState === 'boss-box-expand' || battleState === 'encounter-box-expand';
  const isAppear = battleState === 'boss-appear' || battleState === 'monster-slide-in';
  const isFade = battleState === 'battle-fade-in';
  const isMenu = isFade ||
                 battleState === 'menu-open' || battleState === 'target-select' || battleState === 'confirm-pause' ||
                 battleState === 'attack-start' || battleState === 'player-slash' || battleState === 'player-hit-show' ||
                 battleState === 'player-miss-show' ||
                 battleState === 'player-damage-show' || battleState === 'monster-death' ||
                 battleState === 'defend-anim' || battleState.startsWith('item-') || battleState === 'sw-throw' || battleState === 'sw-hit' || battleState === 'run-name-out' || battleState === 'run-text-in' || battleState === 'run-hold' || battleState === 'run-text-out' || battleState === 'run-fail-name-out' || battleState === 'run-fail-text-in' || battleState === 'run-fail-hold' || battleState === 'run-fail-text-out' || battleState === 'run-fail-name-in' || battleState === 'boss-flash' ||
                 battleState === 'enemy-attack' ||
                 battleState === 'enemy-damage-show' || battleState === 'message-hold' ||
                 battleState.startsWith('ally-') ||
                 battleState === 'boss-dissolve' ||
                 battleState === 'defeat-monster-fade' || battleState === 'defeat-text';
  const isVictory = battleState === 'victory-name-out' || battleState === 'victory-celebrate' ||
                    battleState === 'victory-text-in' || battleState === 'victory-hold' || battleState === 'victory-fade-out' ||
                    battleState === 'exp-text-in' || battleState === 'exp-hold' || battleState === 'exp-fade-out' ||
                    battleState === 'gil-text-in' || battleState === 'gil-hold' || battleState === 'gil-fade-out' ||
                    battleState === 'levelup-text-in' || battleState === 'levelup-hold' ||
    battleState === 'item-text-in' || battleState === 'item-hold' || battleState === 'item-fade-out' ||
                    battleState === 'victory-text-out' || battleState === 'victory-menu-fade' || battleState === 'victory-box-close' ||
                    battleState === 'encounter-box-close' || battleState === 'boss-box-close' || battleState === 'defeat-close';
  const isRunBox = battleState.startsWith('run-');
  if (!isSlide && !isAppear && !isMenu && !isVictory) return;

  // Whole-panel horizontal slide: in from left, out to left
  let panelOffX = 0;
  const isClose = battleState === 'victory-box-close' || battleState === 'encounter-box-close' || battleState === 'boss-box-close' || battleState === 'defeat-close';
  if (isSlide) {
    const t = Math.min(battleTimer / BOSS_BOX_EXPAND_MS, 1);
    panelOffX = Math.round(-CANVAS_W * (1 - t));
  } else if (isClose) {
    const t = Math.min(battleTimer / (VICTORY_BOX_ROWS * VICTORY_ROW_FRAME_MS), 1);
    panelOffX = Math.round(-CANVAS_W * t);
  }

  ctx.save();
  // Clip to bottom panel interior (full height, inset left/right 8px for HUD border)
  ctx.beginPath();
  ctx.rect(8, HUD_BOT_Y, CANVAS_W - 16, HUD_BOT_H);
  ctx.clip();
  ctx.translate(panelOffX, 0);

  // Clear bottom panel interior
  ctx.fillStyle = '#000';
  ctx.fillRect(8, HUD_BOT_Y + 8, CANVAS_W - 16, HUD_BOT_H - 16);

  // Left bordered box — skip during victory/run states (drawVictoryBox handles left area)
  const boxW = BATTLE_PANEL_W;
  const boxH = HUD_BOT_H;
  if ((!isVictory && !isRunBox) || (battleState === 'encounter-box-close' && runSlideBack)) {
    _drawBorderedBox(0, HUD_BOT_Y, boxW, boxH);
  }

  // Text only after slide + dissolve complete (or during victory for right side)
  if (!isMenu && !isVictory) { ctx.restore(); return; }

  let fadeStep = 0;
  if (isFade) {
    fadeStep = BATTLE_TEXT_STEPS - Math.min(Math.floor(battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
  }

  const fadedPal = [0x0F, 0x0F, 0x0F, 0x30];
  for (let s = 0; s < fadeStep; s++) fadedPal[3] = nesColorFade(fadedPal[3]);

  // Enemy name centered in left box (skip during victory/run — drawVictoryBox handles it)
  if (!isVictory && !isRunBox) {
    const enemyName = _battleEnemyName();
    const nameTw = measureText(enemyName);
    const nameX = Math.floor((boxW - nameTw) / 2);
    const nameY = HUD_BOT_Y + Math.floor((boxH - 8) / 2);
    drawText(ctx, nameX, nameY, enemyName, fadedPal);
  }

  // 2×2 menu grid on right side of bottom panel (visible during combat AND victory)
  const menuX = boxW + 8;
  const colL = menuX;
  const colR = menuX + 56;
  const row0 = HUD_BOT_Y + 16;
  const row1 = HUD_BOT_Y + 32;
  const positions = [[colL, row0], [colR, row0], [colL, row1], [colR, row1]];

  // During victory, draw menu text at full brightness — except during menu fade-out
  // After menu fade completes (victory-box-close), hide text entirely
  const isMenuFade = battleState === 'victory-menu-fade';
  const isItemMenuOut = battleState === 'item-menu-out';
  const isItemMenuIn = battleState === 'item-cancel-in' || battleState === 'item-use-menu-in';
  // Hide menu text during item-select/list/slide states — inventory/equip draws instead
  const isItemShowInv = battleState === 'item-list-in' || battleState === 'item-select' ||
    battleState === 'item-cancel-out' || battleState === 'item-list-out' || battleState === 'item-slide' ||
    battleState === 'item-target-select';
  if (!isClose && !isItemShowInv) {
    let menuPal;
    if (isMenuFade || isItemMenuOut) {
      const mfStep = Math.min(Math.floor(battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
      menuPal = [0x0F, 0x0F, 0x0F, 0x30];
      for (let s = 0; s < mfStep; s++) menuPal[3] = nesColorFade(menuPal[3]);
    } else if (isItemMenuIn) {
      const mfStep = BATTLE_TEXT_STEPS - Math.min(Math.floor(battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
      menuPal = [0x0F, 0x0F, 0x0F, 0x30];
      for (let s = 0; s < mfStep; s++) menuPal[3] = nesColorFade(menuPal[3]);
    } else {
      menuPal = isVictory ? [0x0F, 0x0F, 0x0F, 0x30] : fadedPal;
    }
    for (let i = 0; i < BATTLE_MENU_ITEMS.length; i++) {
      drawText(ctx, positions[i][0], positions[i][1], BATTLE_MENU_ITEMS[i], menuPal);
    }
  }

  // Draw inventory / equipment on right side during item states
  if (isItemShowInv) {
    const ITEM_SLIDE_MS = 200;
    const rowH = 14;
    const rightAreaW = CANVAS_W - BATTLE_PANEL_W - 8;
    const baseX = menuX;
    const invPal = [0x0F, 0x0F, 0x0F, 0x30];
    // NES text fade on entry/exit
    let invFadeStep = 0;
    if (battleState === 'item-list-in') invFadeStep = BATTLE_TEXT_STEPS - Math.min(Math.floor(battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
    else if (battleState === 'item-cancel-out' || battleState === 'item-list-out') invFadeStep = Math.min(Math.floor(battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
    for (let s = 0; s < invFadeStep; s++) invPal[3] = nesColorFade(invPal[3]);

    // Page layout: page 0 = equip, pages 1+ = inventory (INV_SLOTS per page)
    const totalInvPages = Math.max(1, Math.ceil(itemSelectList.length / INV_SLOTS));
    // Slide offset: each page is rightAreaW wide, current page at offset 0
    let slidePixel = 0;
    if (battleState === 'item-slide') {
      const t = Math.min(battleTimer / ITEM_SLIDE_MS, 1);
      slidePixel = itemSlideDir * t * rightAreaW; // +rightAreaW = sliding right, -rightAreaW = sliding left
    }

    // Clip to right panel area
    ctx.save();
    ctx.beginPath();
    ctx.rect(baseX - 8, HUD_BOT_Y + 8, rightAreaW + 8, HUD_BOT_H - 16);
    ctx.clip();

    const topY = HUD_BOT_Y + 12;

    // Draw visible pages (current page + neighbor being slid to)
    for (let pg = 0; pg <= 1 + totalInvPages; pg++) {
      const pageOff = (pg - itemPage) * rightAreaW + slidePixel;
      const px = baseX + pageOff;
      // Skip pages fully off-screen
      if (px > baseX + rightAreaW || px < baseX - rightAreaW) continue;

      if (pg === 0) {
        // Equipment page — "RH WeaponName" / "LH WeaponName"
        const RH_LABEL = new Uint8Array([0x9B,0x91,0xFF]); // "RH "
        const LH_LABEL = new Uint8Array([0x95,0x91,0xFF]); // "LH "
        const rName = playerWeaponR !== 0 ? getItemNameClean(playerWeaponR) : new Uint8Array([0xC2,0xC2,0xC2]);
        const rRow = new Uint8Array(RH_LABEL.length + rName.length);
        rRow.set(RH_LABEL, 0); rRow.set(rName, RH_LABEL.length);
        drawText(ctx, px + 8, topY, rRow, invPal);
        const lName = playerWeaponL !== 0 ? getItemNameClean(playerWeaponL) : new Uint8Array([0xC2,0xC2,0xC2]);
        const lRow = new Uint8Array(LH_LABEL.length + lName.length);
        lRow.set(LH_LABEL, 0); lRow.set(lName, LH_LABEL.length);
        drawText(ctx, px + 8, topY + rowH + 6, lRow, invPal);
      } else {
        // Inventory page
        const startIdx = (pg - 1) * INV_SLOTS;
        for (let r = 0; r < INV_SLOTS; r++) {
          const idx = startIdx + r;
          if (idx >= itemSelectList.length) break;
          const item = itemSelectList[idx];
          if (!item) continue;
          const nameBytes = getItemNameClean(item.id);
          const countStr = String(item.count);
          const rowBytes = new Uint8Array(nameBytes.length + 2 + countStr.length);
          rowBytes.set(nameBytes, 0);
          rowBytes[nameBytes.length] = 0xFF;
          rowBytes[nameBytes.length + 1] = 0xE1;
          for (let d = 0; d < countStr.length; d++) rowBytes[nameBytes.length + 2 + d] = 0x80 + parseInt(countStr[d]);
          drawText(ctx, px + 8, topY + r * rowH, rowBytes, invPal);
        }
      }
    }

    ctx.restore();

    // -- Cursors drawn OUTSIDE clip so they render over borders --
    // Row Y helper: equip page has 6px gap between rows
    function _rowY(page, row) {
      if (page === 0) return topY + row * (rowH + 6);
      return topY + row * rowH;
    }

    if (cursorTileCanvas && battleState === 'item-select') {
      const curPx = baseX - 8;
      const cursorY = _rowY(itemPage, itemPageCursor) - 4;

      // Pinned cursor at held item (if on current page)
      if (itemHeldIdx !== -1) {
        const heldIsEq = itemHeldIdx <= -100;
        let heldPage, heldRow;
        if (heldIsEq) {
          heldPage = 0;
          heldRow = -(itemHeldIdx + 100);
        } else {
          heldPage = 1 + Math.floor(itemHeldIdx / INV_SLOTS);
          heldRow = itemHeldIdx % INV_SLOTS;
        }
        if (heldPage === itemPage) {
          const pinY = _rowY(heldPage, heldRow) - 4;
          ctx.drawImage(cursorTileCanvas, curPx, pinY);
        }
      }

      // Active cursor (ghost — offset 4px left if holding)
      const activeX = itemHeldIdx !== -1 ? curPx - 4 : curPx;
      ctx.drawImage(cursorTileCanvas, activeX, cursorY);
    }
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
  ctx.restore();
}

function _encounterBoxDims() {
  if (!encounterMonsters) return { fullW: 64, fullH: 64, sprH: 32 };
  const count = encounterMonsters.length;
  const sprH = encounterMonsters.reduce((h, m) => {
    const c = monsterBattleCanvas.get(m.monsterId) || goblinBattleCanvas;
    return Math.max(h, c ? c.height : 32);
  }, 32);
  const fullW = count === 1 ? 64 : 96;
  const rowsNeeded = count <= 2 ? 1 : 2;
  const gapY = 8;
  const innerH = rowsNeeded === 1 ? sprH : sprH * 2 + gapY;
  const fullH = Math.ceil((innerH + 24) / 8) * 8;
  return { fullW, fullH, sprH };
}

function _encounterGridPos(boxX, boxY, boxW, boxH, count, sprH) {
  sprH = sprH || 32;
  const cx = boxX + Math.floor(boxW / 2);
  const cy = boxY + Math.floor(boxH / 2);
  const hs = 16; // half sprite width (32px wide)
  const gapX = 20;
  const gapY = 8;
  // For 2-row layouts: top of grid is centered on cy
  const gridH2 = sprH * 2 + gapY; // total height of 2-row grid
  const row0y = cy - Math.floor(gridH2 / 2);
  const row1y = row0y + sprH + gapY;
  if (count === 1) return [{ x: cx - hs, y: cy - Math.floor(sprH / 2) }];
  if (count === 2) return [
    { x: cx - gapX - hs, y: cy - Math.floor(sprH / 2) },
    { x: cx + gapX - hs, y: cy - Math.floor(sprH / 2) },
  ];
  if (count === 3) return [
    { x: cx - gapX - hs, y: row0y },
    { x: cx + gapX - hs, y: row0y },
    { x: cx - hs,         y: row1y },
  ];
  return [ // 4
    { x: cx - gapX - hs, y: row0y },
    { x: cx + gapX - hs, y: row0y },
    { x: cx - gapX - hs, y: row1y },
    { x: cx + gapX - hs, y: row1y },
  ];
}

function drawEncounterBox() {
  if (!isRandomEncounter || !encounterMonsters) return;
  const isExpand = battleState === 'encounter-box-expand';
  const isClose = battleState === 'encounter-box-close' || battleState === 'defeat-close';
  const isSlideIn = battleState === 'monster-slide-in';
  const isCombat = isSlideIn || battleState === 'battle-fade-in' ||
                   battleState === 'menu-open' || battleState === 'target-select' || battleState === 'confirm-pause' ||
                   battleState === 'attack-start' || battleState === 'player-slash' || battleState === 'player-hit-show' ||
                   battleState === 'player-miss-show' ||
                   battleState === 'player-damage-show' || battleState === 'monster-death' ||
                   battleState === 'defend-anim' || battleState.startsWith('item-') || battleState === 'sw-throw' || battleState === 'sw-hit' || battleState === 'run-name-out' || battleState === 'run-text-in' || battleState === 'run-hold' || battleState === 'run-text-out' || battleState === 'run-fail-name-out' || battleState === 'run-fail-text-in' || battleState === 'run-fail-hold' || battleState === 'run-fail-text-out' || battleState === 'run-fail-name-in' || battleState === 'boss-flash' ||
                   battleState === 'enemy-attack' ||
                   battleState === 'enemy-damage-show' || battleState === 'message-hold' ||
                   battleState.startsWith('ally-') ||
                   battleState === 'defeat-monster-fade' || battleState === 'defeat-text';
  const isVictory = battleState === 'victory-name-out' || battleState === 'victory-celebrate' ||
                    battleState === 'victory-text-in' || battleState === 'victory-hold' || battleState === 'victory-fade-out' ||
                    battleState === 'exp-text-in' || battleState === 'exp-hold' || battleState === 'exp-fade-out' ||
                    battleState === 'gil-text-in' || battleState === 'gil-hold' || battleState === 'gil-fade-out' ||
                    battleState === 'levelup-text-in' || battleState === 'levelup-hold' ||
    battleState === 'item-text-in' || battleState === 'item-hold' || battleState === 'item-fade-out' ||
                    battleState === 'victory-text-out' || battleState === 'victory-menu-fade' || battleState === 'victory-box-close';
  if (!isExpand && !isClose && !isCombat && !isVictory) return;

  const count = encounterMonsters.length;
  const { fullW, fullH, sprH } = _encounterBoxDims();
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

  // No content during expand, close, or defeat (monsters already faded)
  if (isExpand || isClose || battleState === 'defeat-text') { ctx.restore(); return; }

  // Draw monster sprites in grid
  const gridPos = _encounterGridPos(boxX, boxY, fullW, fullH, count, sprH);
  // Helper: visual center Y of a monster slot after bottom-alignment
  const _slotCenterY = (idx) => {
    if (!gridPos[idx] || !encounterMonsters[idx]) return 0;
    const m = encounterMonsters[idx];
    const c = monsterBattleCanvas.get(m.monsterId) || goblinBattleCanvas;
    const h = c ? c.height : sprH;
    return gridPos[idx].y + (sprH - h) + Math.floor(h / 2);
  };
  if (goblinBattleCanvas || monsterBattleCanvas.size > 0) {
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
      const isDying = dyingMonsterIndices.has(i) && battleState === 'monster-death';
      // Keep dead monster visible during slash + hit-show + miss-show + damage show
      const isBeingHit = (i === targetIndex &&
        (battleState === 'player-slash' || battleState === 'player-hit-show' ||
         battleState === 'player-miss-show' || battleState === 'player-damage-show')) ||
        (i === allyTargetIndex &&
        (battleState === 'ally-slash' || battleState === 'ally-damage-show')) ||
        (battleState === 'sw-hit' && southWindTargets.includes(i));

      if (!alive && !isDying && !isBeingHit) continue;

      const pos = gridPos[i];
      const drawX = pos.x - slideOffX;

      const mid = encounterMonsters[i].monsterId;
      const sprNormal = monsterBattleCanvas.get(mid) || goblinBattleCanvas;
      const sprWhite  = monsterWhiteCanvas.get(mid)  || goblinWhiteCanvas;
      const thisH = sprNormal ? sprNormal.height : sprH;
      const drawY = pos.y + (sprH - thisH); // bottom-align to shared baseline

      if (isDying) {
        const delay = dyingMonsterIndices.get(i) || 0;
        const progress = Math.min(Math.max(0, battleTimer - delay) / MONSTER_DEATH_MS, 1);
        _drawMonsterDeath(drawX, drawY, thisH, progress, mid);
      } else {
        // Hit blink during player-slash or ally-slash (60ms toggle, not on miss)
        const curHit = hitResults && hitResults[currentHitIdx];
        const isPlayerHitBlink = isBeingHit && battleState === 'player-slash' &&
                           curHit && !curHit.miss && (Math.floor(battleTimer / 60) & 1);
        const isAllyHitBlink = isBeingHit && battleState === 'ally-slash' &&
                           allyHitResult && !allyHitResult.miss && (Math.floor(battleTimer / 60) & 1);
        const isHitBlink = isPlayerHitBlink || isAllyHitBlink;
        // White flash blink during boss-flash for current attacker
        const isFlashing = battleState === 'boss-flash' && currentAttacker === i &&
                           Math.floor(battleTimer / 33) % 2 === 1;
        if (!isHitBlink) {
          ctx.drawImage(isFlashing ? sprWhite : sprNormal, drawX, drawY);
        }
      }
    }

    // Draw punch impact on target during player-slash (16×16 centered on target + scatter, not on miss)
    if (battleState === 'player-slash' && slashFrames && slashFrame < SLASH_FRAMES && hitResults && hitResults[currentHitIdx] && !hitResults[currentHitIdx].miss) {
      const pos = gridPos[targetIndex];
      const sx = pos.x - slideOffX + slashOffX + 8;  // center 16px on 32px sprite
      const sy = _slotCenterY(targetIndex) + slashOffY;
      ctx.drawImage(slashFrames[slashFrame], sx, sy);
    }

    // Ally slash — weapon-appropriate slash sprites on target during ally-slash
    if (battleState === 'ally-slash' && allyHitResult && !allyHitResult.miss) {
      const ally = battleAllies[currentAllyAttacker];
      const allySlashFrames = ally ? getSlashFramesForWeapon(ally.weaponId, true) : slashFramesR;
      const af = Math.min(Math.floor(battleTimer / 67), 2); // 3 frames
      const pos = gridPos[allyTargetIndex];
      if (pos && allySlashFrames && allySlashFrames[af]) {
        const scatterX = [0, 10, -8][af];
        const scatterY = [0, -6, 8][af];
        ctx.drawImage(allySlashFrames[af], pos.x + 8 + scatterX, _slotCenterY(allyTargetIndex) + scatterY);
      }
    }
    ctx.restore();
  }

  // Target-select cursor — hand cursor to the left of selected monster(s)
  if ((battleState === 'target-select' || (battleState === 'item-target-select' && itemTargetType === 'enemy')) && cursorTileCanvas) {
    if (battleState === 'target-select') {
      const pos = gridPos[targetIndex];
      ctx.drawImage(cursorTileCanvas, pos.x - 10, _slotCenterY(targetIndex) - 4);
    } else if (itemTargetMode === 'single') {
      // Single target cursor (standard)
      const pos = gridPos[itemTargetIndex];
      if (pos) ctx.drawImage(cursorTileCanvas, pos.x - 10, _slotCenterY(itemTargetIndex) - 4);
    } else {
      // Multi-target: flash cursors on all targeted enemies
      const flash = Math.floor(Date.now() / 133) & 1;
      if (flash) {
        const _rightCols = count === 1 ? [0] : count === 2 ? [1] : [1, 3];
        const _leftCols  = count === 2 ? [0] : count >= 3 ? [0, 2] : [];
        let targets = [];
        if (itemTargetMode === 'all') targets = encounterMonsters.map((m, i) => m.hp > 0 ? i : -1).filter(i => i >= 0);
        else if (itemTargetMode === 'col-right') targets = _rightCols.filter(i => i < count && encounterMonsters[i]?.hp > 0);
        else if (itemTargetMode === 'col-left') targets = _leftCols.filter(i => i < count && encounterMonsters[i]?.hp > 0);
        for (const ti of targets) {
          if (gridPos[ti]) ctx.drawImage(cursorTileCanvas, gridPos[ti].x - 10, _slotCenterY(ti) - 4);
        }
      }
    }
  }

  ctx.restore();
}

function drawBossSpriteBox() {
  if (isRandomEncounter) return;
  if (!landTurtleBattleCanvas) return;

  const isExpand = battleState === 'boss-box-expand';
  const isClose = battleState === 'boss-box-close' || (!isRandomEncounter && battleState === 'defeat-close');
  const isAppear = battleState === 'boss-appear';
  const isDissolve = battleState === 'boss-dissolve';
  const isCombat = battleState === 'battle-fade-in' ||
                   battleState === 'menu-open' || battleState === 'target-select' || battleState === 'confirm-pause' ||
                   battleState === 'attack-start' || battleState === 'player-slash' || battleState === 'player-hit-show' ||
                   battleState === 'player-miss-show' ||
                   battleState === 'player-damage-show' || battleState === 'defend-anim' || battleState.startsWith('item-') || battleState === 'sw-throw' || battleState === 'sw-hit' || battleState === 'run-name-out' || battleState === 'run-text-in' || battleState === 'run-hold' || battleState === 'run-text-out' || battleState === 'run-fail-name-out' || battleState === 'run-fail-text-in' || battleState === 'run-fail-hold' || battleState === 'run-fail-text-out' || battleState === 'run-fail-name-in' || battleState === 'boss-flash' ||
                   battleState === 'enemy-attack' ||
                   battleState === 'enemy-damage-show' || battleState === 'message-hold' ||
                   battleState.startsWith('ally-') ||
                   battleState === 'defeat-monster-fade' || battleState === 'defeat-text';
  const isVictory = battleState === 'victory-name-out' || battleState === 'victory-celebrate' ||
                    battleState === 'victory-text-in' || battleState === 'victory-hold' || battleState === 'victory-fade-out' ||
                    battleState === 'exp-text-in' || battleState === 'exp-hold' || battleState === 'exp-fade-out' ||
                    battleState === 'gil-text-in' || battleState === 'gil-hold' || battleState === 'gil-fade-out' ||
                    battleState === 'levelup-text-in' || battleState === 'levelup-hold' ||
    battleState === 'item-text-in' || battleState === 'item-hold' || battleState === 'item-fade-out' ||
                    battleState === 'victory-text-out' || battleState === 'victory-menu-fade' || battleState === 'victory-box-close';
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

  // No sprite during expand, close, or defeat (boss already faded)
  if (isExpand || isClose || battleState === 'defeat-text') { ctx.restore(); return; }

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
    // Draw punch impact with random scatter offset (16×16 metasprite, not on miss)
    if (slashFrames && slashFrame < SLASH_FRAMES && !bossDefeated && hitResults && hitResults[currentHitIdx] && !hitResults[currentHitIdx].miss) {
      ctx.drawImage(slashFrames[slashFrame], centerX - 8 + slashOffX, centerY - 8 + slashOffY);
    }
  } else if (battleState === 'ally-slash') {
    // Blink during ally slash (60ms toggle)
    const blinkHidden = allyHitResult && !allyHitResult.miss && (Math.floor(battleTimer / 60) & 1);
    if (!blinkHidden && !bossDefeated) {
      ctx.drawImage(landTurtleBattleCanvas, sprX, sprY);
    }
    // Draw slash effect on boss
    if (!bossDefeated && allyHitResult && !allyHitResult.miss) {
      const ally = battleAllies[currentAllyAttacker];
      const allySlashFrames = ally ? getSlashFramesForWeapon(ally.weaponId, true) : slashFramesR;
      const af = Math.min(Math.floor(battleTimer / 67), 2);
      if (allySlashFrames && allySlashFrames[af]) {
        const scatterX = [0, 10, -8][af];
        const scatterY = [0, -6, 8][af];
        ctx.drawImage(allySlashFrames[af], centerX - 8 + scatterX, centerY - 8 + scatterY);
      }
    }
  } else {
    // Full sprite — normal draw
    if (!bossDefeated) {
      ctx.drawImage(landTurtleBattleCanvas, sprX, sprY);
    }
  }

  // Target-select cursor — hand cursor on boss sprite box (solid, no blink)
  if ((battleState === 'target-select' || (battleState === 'item-target-select' && itemTargetType === 'enemy')) && cursorTileCanvas) {
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

function makeGilText(amount) {
  // Build "Got N Gil!" — G=0x90, o=0xD8, t=0xDD, i=0xD2, l=0xD5
  const digits = String(amount);
  const arr = [0x90, 0xD8, 0xDD, 0xFF]; // "Got "
  for (let i = 0; i < digits.length; i++) arr.push(0x80 + parseInt(digits[i]));
  arr.push(0xFF, 0x90, 0xD2, 0xD5, 0xC4); // " Gil!"
  return new Uint8Array(arr);
}

function makeFoundItemText(itemId) {
  // "Found [name]!" — F=0x8F, o=0xD8, u=0xDE, n=0xD7, d=0xCD, space=0xFF, !=0xC4
  const found = [0x8F, 0xD8, 0xDE, 0xD7, 0xCD, 0xFF];
  const name = getItemNameClean(itemId);
  const arr = new Uint8Array(found.length + name.length + 1);
  arr.set(found, 0);
  arr.set(name, found.length);
  arr[found.length + name.length] = 0xC4;
  return arr;
}

// Victory box — reuses left box area (120×64 px), row-by-row expand
const VICTORY_BOX_W = BATTLE_PANEL_W;  // 120px (same as left box)
const VICTORY_BOX_H = HUD_BOT_H;       // 64px
const VICTORY_BOX_ROWS = HUD_BOT_H / 8; // 8 rows
const VICTORY_ROW_FRAME_MS = 16.67; // 1 NES frame per row

function _battleEnemyName() {
  if (isRandomEncounter && encounterMonsters) {
    // Use targeted monster's name (or first alive if no target)
    const ti = (targetIndex >= 0 && targetIndex < encounterMonsters.length && encounterMonsters[targetIndex].hp > 0)
      ? targetIndex
      : encounterMonsters.findIndex(m => m.hp > 0);
    const monsterId = encounterMonsters[ti >= 0 ? ti : 0].monsterId;
    const baseName = getMonsterName(monsterId) || BATTLE_GOBLIN_NAME;
    // Count how many of this same type are alive
    const aliveOfType = encounterMonsters.filter(m => m.hp > 0 && m.monsterId === monsterId).length;
    if (aliveOfType > 1) {
      const arr = Array.from(baseName);
      arr.push(0xFF, 0xE1, 0x80 + aliveOfType);
      return new Uint8Array(arr);
    }
    return baseName;
  }
  return BATTLE_BOSS_NAME;
}

function drawVictoryBox() {
  const isNameOut = battleState === 'victory-name-out';
  const isCelebrate = battleState === 'victory-celebrate';
  const isClose = battleState === 'victory-box-close';
  const isVicText = battleState === 'victory-text-in';
  const isVicHold = battleState === 'victory-hold';
  const isVicFadeOut = battleState === 'victory-fade-out';
  const isExpText = battleState === 'exp-text-in';
  const isExpHold = battleState === 'exp-hold';
  const isExpFadeOut = battleState === 'exp-fade-out';
  const isGilText = battleState === 'gil-text-in';
  const isGilHold = battleState === 'gil-hold';
  const isGilFadeOut = battleState === 'gil-fade-out';
  const isLevelText = battleState === 'levelup-text-in';
  const isLevelHold = battleState === 'levelup-hold';
  const isItemText = battleState === 'item-text-in';
  const isItemHold = battleState === 'item-hold';
  const isItemFadeOut = battleState === 'item-fade-out';
  const isOut = battleState === 'victory-text-out';
  const isMenuFadeState = battleState === 'victory-menu-fade';
  // Run states
  const isRunNameOut = battleState === 'run-name-out';
  const isRunTextIn = battleState === 'run-text-in';
  const isRunHold = battleState === 'run-hold';
  const isRunTextOut = battleState === 'run-text-out';
  const isRunFailNameOut = battleState === 'run-fail-name-out';
  const isRunFailTextIn = battleState === 'run-fail-text-in';
  const isRunFailHold = battleState === 'run-fail-hold';
  const isRunFailTextOut = battleState === 'run-fail-text-out';
  const isRunFailNameIn = battleState === 'run-fail-name-in';
  const isRun = isRunNameOut || isRunTextIn || isRunHold || isRunTextOut;
  const isRunFail = isRunFailNameOut || isRunFailTextIn || isRunFailHold || isRunFailTextOut || isRunFailNameIn;
  const showBox = isNameOut || isCelebrate || isClose || isVicText || isVicHold || isVicFadeOut ||
    isExpText || isExpHold || isExpFadeOut || isGilText || isGilHold || isGilFadeOut ||
    isItemText || isItemHold || isItemFadeOut ||
    isLevelText || isLevelHold || isOut || isMenuFadeState ||
    isRun || isRunFail;
  if (!showBox) return;

  let boxX = 0;
  const boxY = HUD_BOT_Y;

  // Slide left during victory-box-close (matches drawBattleMenu panelOffX)
  if (isClose) {
    const t = Math.min(battleTimer / (VICTORY_BOX_ROWS * VICTORY_ROW_FRAME_MS), 1);
    boxX = Math.round(-(CANVAS_W - 8) * t);
  }

  // victory-name-out / run-name-out / run-fail-name-out: monster name fades out
  if (isNameOut || isRunNameOut || isRunFailNameOut) {
    _drawBorderedBox(boxX, boxY, VICTORY_BOX_W, VICTORY_BOX_H);
    const stepMs = isRunFailNameOut ? 50 : BATTLE_TEXT_STEP_MS;
    const fadeStep = Math.min(Math.floor(battleTimer / stepMs), BATTLE_TEXT_STEPS);
    const fadedPal = [0x0F, 0x0F, 0x0F, 0x30];
    for (let s = 0; s < fadeStep; s++) fadedPal[3] = nesColorFade(fadedPal[3]);
    const enemyName = _battleEnemyName();
    const nameTw = measureText(enemyName);
    const nameX = Math.floor((VICTORY_BOX_W - nameTw) / 2);
    const nameY = boxY + Math.floor((VICTORY_BOX_H - 8) / 2);
    drawText(ctx, nameX, nameY, enemyName, fadedPal);
    return;
  }

  // Run success: "Ran away..." fade in / hold / fade out
  if (isRun) {
    _drawBorderedBox(boxX, boxY, VICTORY_BOX_W, VICTORY_BOX_H);
    let fadeStep = 0;
    if (isRunTextIn) fadeStep = BATTLE_TEXT_STEPS - Math.min(Math.floor(battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
    else if (isRunTextOut) fadeStep = Math.min(Math.floor(battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
    const fadedPal = [0x0F, 0x0F, 0x0F, 0x30];
    for (let s = 0; s < fadeStep; s++) fadedPal[3] = nesColorFade(fadedPal[3]);
    const tw = measureText(BATTLE_RAN_AWAY);
    drawText(ctx, boxX + Math.floor((VICTORY_BOX_W - tw) / 2), boxY + Math.floor((VICTORY_BOX_H - 8) / 2), BATTLE_RAN_AWAY, fadedPal);
    return;
  }

  // Run fail: "Can't run" fade in / hold / fade out, then monster name fades back in (fast 50ms steps)
  if (isRunFail) {
    _drawBorderedBox(boxX, boxY, VICTORY_BOX_W, VICTORY_BOX_H);
    const RUN_FAIL_STEP_MS = 50;
    if (isRunFailNameIn) {
      // Monster name fading back in
      const fadeStep = BATTLE_TEXT_STEPS - Math.min(Math.floor(battleTimer / RUN_FAIL_STEP_MS), BATTLE_TEXT_STEPS);
      const fadedPal = [0x0F, 0x0F, 0x0F, 0x30];
      for (let s = 0; s < fadeStep; s++) fadedPal[3] = nesColorFade(fadedPal[3]);
      const enemyName = _battleEnemyName();
      const nameTw = measureText(enemyName);
      drawText(ctx, boxX + Math.floor((VICTORY_BOX_W - nameTw) / 2), boxY + Math.floor((VICTORY_BOX_H - 8) / 2), enemyName, fadedPal);
    } else {
      // "Can't run" text
      let fadeStep = 0;
      if (isRunFailTextIn) fadeStep = BATTLE_TEXT_STEPS - Math.min(Math.floor(battleTimer / RUN_FAIL_STEP_MS), BATTLE_TEXT_STEPS);
      else if (isRunFailTextOut) fadeStep = Math.min(Math.floor(battleTimer / RUN_FAIL_STEP_MS), BATTLE_TEXT_STEPS);
      const fadedPal = [0x0F, 0x0F, 0x0F, 0x30];
      for (let s = 0; s < fadeStep; s++) fadedPal[3] = nesColorFade(fadedPal[3]);
      const tw = measureText(BATTLE_CANT_ESCAPE);
      drawText(ctx, boxX + Math.floor((VICTORY_BOX_W - tw) / 2), boxY + Math.floor((VICTORY_BOX_H - 8) / 2), BATTLE_CANT_ESCAPE, fadedPal);
    }
    return;
  }

  // victory-celebrate: left box stays (no text), then victory text fades in
  if (isCelebrate) {
    _drawBorderedBox(boxX, boxY, VICTORY_BOX_W, VICTORY_BOX_H);
    return;
  }

  _drawBorderedBox(boxX, boxY, VICTORY_BOX_W, VICTORY_BOX_H);

  if (isClose) return;

  // Calculate fade step for current state
  let fadeStep = 0;
  if (isVicText || isExpText || isGilText || isItemText || isLevelText) {
    // Fade in
    fadeStep = BATTLE_TEXT_STEPS - Math.min(Math.floor(battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
  } else if (isVicFadeOut || isExpFadeOut || isGilFadeOut || isItemFadeOut || isOut) {
    // Fade out
    fadeStep = Math.min(Math.floor(battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
  }
  // Hold states: fadeStep stays 0 (fully bright)

  const fadedPal = [0x0F, 0x0F, 0x0F, 0x30];
  for (let s = 0; s < fadeStep; s++) fadedPal[3] = nesColorFade(fadedPal[3]);

  // Pick which message to draw
  let msg;
  if (isVicText || isVicHold || isVicFadeOut) {
    msg = BATTLE_VICTORY;
  } else if (isExpText || isExpHold || isExpFadeOut) {
    msg = makeExpText(encounterExpGained);
  } else if (isGilText || isGilHold || isGilFadeOut) {
    msg = makeGilText(encounterGilGained);
  } else if (isItemText || isItemHold || isItemFadeOut) {
    msg = encounterDropItem !== null ? makeFoundItemText(encounterDropItem) : null;
  } else if (isLevelText || isLevelHold) {
    msg = BATTLE_LEVEL_UP;
  } else if (isOut) {
    // Final fade-out: show whichever message was last
    if (leveledUp) msg = BATTLE_LEVEL_UP;
    else if (encounterDropItem !== null) msg = makeFoundItemText(encounterDropItem);
    else msg = makeGilText(encounterGilGained);
  }

  if (msg) {
    const tw = measureText(msg);
    drawText(ctx, boxX + Math.floor((VICTORY_BOX_W - tw) / 2), boxY + Math.floor((VICTORY_BOX_H - 8) / 2), msg, fadedPal);
  }
}

function _dmgBounceY(baseY, timer) {
  // Authentic NES bounce from FCEUX trace — 26 keyframes at 60fps
  const frame = Math.min(Math.floor(timer / DMG_BOUNCE_FRAME_MS), DMG_BOUNCE_TABLE.length - 1);
  return baseY + DMG_BOUNCE_TABLE[frame];
}

function drawBattleAllies() {
  if (battleAllies.length === 0) return;
  if (battleState === 'none') return;

  const panelTop = HUD_VIEW_Y + 32;   // rows start right below player boxes

  // Collect weapon sprite draws to render OUTSIDE clip
  let weaponDraws = [];

  ctx.save();
  ctx.beginPath();
  ctx.rect(HUD_RIGHT_X, panelTop, HUD_RIGHT_W, HUD_VIEW_H - 32);
  ctx.clip();

  for (let i = 0; i < battleAllies.length; i++) {
    const ally = battleAllies[i];
    const shakeOff = (allyShakeTimer[i] > 0) ? (Math.floor(allyShakeTimer[i] / 67) & 1 ? 2 : -2) : 0;
    const rowY = panelTop + i * ROSTER_ROW_H + shakeOff;

    // Portrait (faded) — pose matches player sprite mechanics
    const isVicPose = battleState === 'victory-celebrate' ||
      battleState === 'victory-text-in' || battleState === 'victory-hold' || battleState === 'victory-fade-out' ||
      battleState === 'exp-text-in' || battleState === 'exp-hold' || battleState === 'exp-fade-out' ||
      battleState === 'gil-text-in' || battleState === 'gil-hold' || battleState === 'gil-fade-out' ||
      battleState === 'levelup-text-in' || battleState === 'levelup-hold' ||
    battleState === 'item-text-in' || battleState === 'item-hold' || battleState === 'item-fade-out' ||
      battleState === 'victory-text-out' || battleState === 'victory-menu-fade' || battleState === 'victory-box-close';
    const isAllyHit = (battleState === 'ally-hit' || battleState === 'ally-damage-show-enemy') &&
      enemyTargetAllyIdx === i && allyDamageNums[i] && !allyDamageNums[i].miss;
    const isAllyAttack = (battleState === 'ally-attack-start') && currentAllyAttacker === i;
    const isAllyHeal = battleState === 'item-use' && playerActionPending && playerActionPending.allyIndex === i;
    const isNearFatal = ally.hp > 0 && ally.hp <= Math.floor(ally.maxHP / 4);
    let portraits;
    if (isVicPose && (Math.floor(Date.now() / 250) & 1) && fakePlayerVictoryPortraits[ally.palIdx]) {
      portraits = fakePlayerVictoryPortraits[ally.palIdx];
    } else if (isAllyAttack && fakePlayerAttackPortraits[ally.palIdx]) {
      portraits = fakePlayerAttackPortraits[ally.palIdx];
    } else if (isAllyHit && fakePlayerHitPortraits[ally.palIdx]) {
      portraits = fakePlayerHitPortraits[ally.palIdx];
    } else if (isNearFatal && fakePlayerKneelPortraits[ally.palIdx]) {
      portraits = fakePlayerKneelPortraits[ally.palIdx];
    } else {
      portraits = fakePlayerPortraits[ally.palIdx];
    }
    // Portrait box (32×32) + info box (80×32)
    _drawHudBox(HUD_RIGHT_X, rowY, 32, ROSTER_ROW_H, ally.fadeStep);
    _drawHudBox(HUD_RIGHT_X + 32, rowY, HUD_RIGHT_W - 32, ROSTER_ROW_H, ally.fadeStep);

    const ppx = HUD_RIGHT_X + 8;  // portrait interior x
    const ppy = rowY + 8;          // portrait interior y
    if (portraits) {
      ctx.drawImage(portraits[ally.fadeStep], ppx, ppy);
      // Queue weapon sprites for drawing outside clip
      if (isAllyAttack) {
        const wpnSt = weaponSubtype(ally.weaponId);
        if (wpnSt === 'knife' && battleKnifeBladeCanvas) weaponDraws.push({ img: battleKnifeBladeCanvas, x: ppx + 8, y: ppy - 7 });
        else if (wpnSt === 'dagger' && battleDaggerBladeCanvas) weaponDraws.push({ img: battleDaggerBladeCanvas, x: ppx + 8, y: ppy - 7 });
        else if (wpnSt === 'sword' && battleSwordBladeCanvas) weaponDraws.push({ img: battleSwordBladeCanvas, x: ppx + 8, y: ppy - 7 });
      }
      if (battleState === 'ally-slash' && currentAllyAttacker === i) {
        const wpnSt = weaponSubtype(ally.weaponId);
        if (wpnSt === 'knife' && battleKnifeBladeSwungCanvas) weaponDraws.push({ img: battleKnifeBladeSwungCanvas, x: ppx - 16, y: ppy + 1 });
        else if (wpnSt === 'dagger' && battleDaggerBladeSwungCanvas) weaponDraws.push({ img: battleDaggerBladeSwungCanvas, x: ppx - 16, y: ppy + 1 });
        else if (wpnSt === 'sword' && battleSwordBladeSwungCanvas) weaponDraws.push({ img: battleSwordBladeSwungCanvas, x: ppx - 16, y: ppy + 1 });
        else if (battleFistCanvas) weaponDraws.push({ img: battleFistCanvas, x: ppx - 4, y: ppy + 10 });
      }
    }

    // Name (right-aligned in info box interior — top text line)
    const namePal = [0x0F, 0x0F, 0x0F, 0x30];
    for (let s = 0; s < ally.fadeStep; s++) namePal[3] = nesColorFade(namePal[3]);
    const nameBytes = _nameToBytes(ally.name);
    const nameW = measureText(nameBytes);
    drawText(ctx, HUD_RIGHT_X + HUD_RIGHT_W - 8 - nameW, rowY + 8, nameBytes, namePal);

    // HP (right-aligned — second text line, green/yellow/red by ratio)
    const hpStr = String(ally.hp);
    const hpBytes = _nameToBytes(hpStr);
    const hpW = measureText(hpBytes);
    const allyHpNes = ally.hp <= Math.floor(ally.maxHP / 4) ? 0x16
                    : ally.hp <= Math.floor(ally.maxHP / 2) ? 0x28 : 0x2A;
    const hpPal = [0x0F, 0x0F, 0x0F, allyHpNes];
    for (let s = 0; s < ally.fadeStep; s++) hpPal[3] = nesColorFade(hpPal[3]);
    drawText(ctx, HUD_RIGHT_X + HUD_RIGHT_W - 8 - hpW, rowY + 16, hpBytes, hpPal);

    // Collect damage numbers for drawing above HUD (outside clip)
    const dn = allyDamageNums[i];
    if (dn) {
      const bx = HUD_RIGHT_X + 16; // center of portrait
      const baseY2 = rowY + 8 + 8;
      const by = _dmgBounceY(baseY2, dn.timer);
      weaponDraws.push({ type: 'dmg', dn, bx, by });
    }

    // Cure sparkle on healing ally — queued outside clip
    if (isAllyHeal && cureSparkleFrames.length === 2) {
      const fi = Math.floor(battleTimer / 67) & 1;
      weaponDraws.push({ type: 'sparkle', frame: cureSparkleFrames[fi], px: ppx, py: ppy });
    }
  }


  ctx.restore();

  // Item-target cursor on selected ally row — drawn OUTSIDE clip over HUD border
  if (battleState === 'item-target-select' && itemTargetType === 'player' && itemTargetAllyIndex >= 0 && cursorTileCanvas) {
    const cursorRowY = panelTop + itemTargetAllyIndex * ROSTER_ROW_H;
    ctx.drawImage(cursorTileCanvas, HUD_RIGHT_X - 4, cursorRowY + 12);
  }

  // Weapon blade sprites + damage numbers drawn ABOVE HUD (outside clip)
  for (const wd of weaponDraws) {
    if (wd.type === 'dmg') {
      const { dn, bx, by } = wd;
      if (dn.miss) {
        drawText(ctx, bx - 8, by, BATTLE_MISS, [0x0F, 0x0F, 0x0F, 0x2B]);
      } else {
        const digits = String(dn.value);
        const numBytes = new Uint8Array(digits.length);
        for (let d = 0; d < digits.length; d++) numBytes[d] = 0x80 + parseInt(digits[d]);
        const tw = digits.length * 8;
        const pal = dn.heal ? [0x0F, 0x0F, 0x0F, 0x2B] : DMG_NUM_PAL;
        drawText(ctx, bx - Math.floor(tw / 2), by, numBytes, pal);
      }
    } else if (wd.type === 'sparkle') {
      const { frame, px, py } = wd;
      ctx.drawImage(frame, px - 8, py - 7);
      ctx.save(); ctx.scale(-1, 1); ctx.drawImage(frame, -(px + 23), py - 7); ctx.restore();
      ctx.save(); ctx.scale(1, -1); ctx.drawImage(frame, px - 8, -(py + 24)); ctx.restore();
      ctx.save(); ctx.scale(-1, -1); ctx.drawImage(frame, -(px + 23), -(py + 24)); ctx.restore();
    } else {
      ctx.drawImage(wd.img, wd.x, wd.y);
    }
  }
}

function drawDamageNumbers() {
  // Boss/monster damage number — bounces centered on the target
  if (bossDamageNum && (!bossDefeated || isRandomEncounter)) {
    let bx, baseY;
    if (isRandomEncounter && encounterMonsters) {
      // Center on targeted monster in encounter grid
      const count = encounterMonsters.length;
      const { fullW, fullH, sprH: dSprH } = _encounterBoxDims();
      const boxX = HUD_VIEW_X + Math.floor((HUD_VIEW_W - fullW) / 2);
      const boxY = HUD_VIEW_Y + Math.floor((HUD_VIEW_H - fullH) / 2);
      const gridPos = _encounterGridPos(boxX, boxY, fullW, fullH, count, dSprH);
      const idx = targetIndex < gridPos.length ? targetIndex : 0;
      const pos = gridPos[idx];
      const m = encounterMonsters[idx];
      const mc = monsterBattleCanvas.get(m?.monsterId) || goblinBattleCanvas;
      const mh = mc ? mc.height : dSprH;
      bx = pos.x + 16; // center of 32px sprite
      baseY = pos.y + (dSprH - mh) + Math.floor(mh / 2) - 8;
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

  // Player heal number — green bounce on portrait during item-use
  if (playerHealNum) {
    const px = HUD_RIGHT_X + 16;
    const baseY = HUD_VIEW_Y + 16;
    const py = _dmgBounceY(baseY, playerHealNum.timer);
    const digits = String(playerHealNum.value);
    const numBytes = new Uint8Array(digits.length);
    for (let i = 0; i < digits.length; i++) numBytes[i] = 0x80 + parseInt(digits[i]);
    const tw = digits.length * 8;
    drawText(ctx, px - Math.floor(tw / 2), py, numBytes, [0x0F, 0x0F, 0x0F, 0x2B]);
  }

  // Enemy heal number — green bounce on targeted enemy during item-use
  if (enemyHealNum) {
    let bx, baseY;
    if (isRandomEncounter && encounterMonsters) {
      const count = encounterMonsters.length;
      const { fullW, fullH, sprH: dSprH } = _encounterBoxDims();
      const boxX = HUD_VIEW_X + Math.floor((HUD_VIEW_W - fullW) / 2);
      const boxY = HUD_VIEW_Y + Math.floor((HUD_VIEW_H - fullH) / 2);
      const gridPos = _encounterGridPos(boxX, boxY, fullW, fullH, count, dSprH);
      const idx = (enemyHealNum.index < gridPos.length) ? enemyHealNum.index : 0;
      const pos = gridPos[idx];
      const m = encounterMonsters[idx];
      const mc = monsterBattleCanvas.get(m?.monsterId) || goblinBattleCanvas;
      const mh = mc ? mc.height : dSprH;
      bx = pos.x + 16;
      baseY = pos.y + (dSprH - mh) + Math.floor(mh / 2) - 8;
    } else {
      bx = HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2) - 4;
      baseY = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2) - 8;
    }
    const hy = _dmgBounceY(baseY, enemyHealNum.timer);
    ctx.save();
    ctx.beginPath();
    ctx.rect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);
    ctx.clip();
    const digits = String(enemyHealNum.value);
    const numBytes = new Uint8Array(digits.length);
    for (let i = 0; i < digits.length; i++) numBytes[i] = 0x80 + parseInt(digits[i]);
    const tw = digits.length * 8;
    drawText(ctx, bx - Math.floor(tw / 2), hy, numBytes, [0x0F, 0x0F, 0x0F, 0x2B]);
    ctx.restore();
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
    // Player select now drawn inside drawTitle() viewport
    requestAnimationFrame(gameLoop);
    return;
  }

  // Tick HUD info fade-in
  if (hudInfoFadeTimer < HUD_INFO_FADE_STEPS * HUD_INFO_FADE_STEP_MS) {
    hudInfoFadeTimer += dt;
  }

  // Tick HUD level ↔ HP cross-fade — HP fades in once enemies have entered
  const _hudHpLvEarly = battleState === 'none' || battleState === 'flash-strobe' ||
    battleState === 'encounter-box-expand' || battleState === 'monster-slide-in' ||
    battleState === 'boss-box-expand' || battleState === 'boss-appear';
  const _hudHpLvTarget = _hudHpLvEarly ? 0 : 4;
  if (hudHpLvStep !== _hudHpLvTarget) {
    hudHpLvTimer += dt;
    while (hudHpLvTimer >= HUD_HPLV_STEP_MS) {
      hudHpLvTimer -= HUD_HPLV_STEP_MS;
      hudHpLvStep += hudHpLvStep < _hudHpLvTarget ? 1 : -1;
      if (hudHpLvStep === _hudHpLvTarget) { hudHpLvTimer = 0; break; }
    }
  }

  handleInput();
  updateRoster(dt);
  updateChat(dt);
  updatePauseMenu(dt);
  updateMsgBox(dt);
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

  drawHUD();
  if (battleAllies.length > 0 && battleState !== 'none') {
    drawBattleAllies();
  } else {
    drawRoster();
  }

  // Chat panel in bottom box (only outside battle)
  drawChat();

  // Pause menu overlays everything
  drawPauseMenu();

  // Chest message box
  drawMsgBox();

  // Roster context menu (drawn over viewport, above HUD)
  drawRosterMenu();

  // Battle UI overlays everything
  drawBattle();

  // SW explosion drawn last — must be above HUD and all other layers
  drawSWExplosion();
  drawSWDamageNumbers(); // damage numbers above explosion

  if (jukeboxMode) {
    ctx.font = '8px monospace';
    ctx.fillStyle = '#c8a832';
    ctx.textAlign = 'left';
    ctx.fillText(`JUKEBOX: Song $${jukeboxTrack.toString(16).toUpperCase().padStart(2, '0')} (${jukeboxTrack})  +/- to change`, 4, 12);
  }

  requestAnimationFrame(gameLoop);
}
