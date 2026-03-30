// Game Client — canvas rendering, input handling, game loop

import { parseROM } from './rom-parser.js';
import { NES_SYSTEM_PALETTE, decodeTile, decodeTiles } from './tile-decoder.js';
import { Sprite, DIR_DOWN, DIR_UP, DIR_LEFT, DIR_RIGHT } from './sprite.js';
import { loadMap } from './map-loader.js';
import { MapRenderer } from './map-renderer.js';
import { loadWorldMap } from './world-map-loader.js';
import { WorldMapRenderer } from './world-map-renderer.js';
import { generateFloor, clearDungeonCache } from './dungeon-generator.js';
import { initMusic, playTrack, stopMusic, fadeOutMusic, playSFX, stopSFX, TRACKS, SFX,
         initFF1Music, playFF1Track, stopFF1Music, fadeOutFF1Music, clearMusicStash,
         getCurrentTrack, FF1_TRACKS, pauseMusic, resumeMusic } from './music.js';
import { applyIPS } from './ips-patcher.js';
import { initTextDecoder, getItemNameClean, getMonsterName } from './text-decoder.js';
import { initFont, drawText, measureText, TEXT_WHITE, TEXT_GREY, TEXT_YELLOW } from './font-renderer.js';
import { MONSTERS } from './data/monsters.js';
import { ITEMS, isHandEquippable, isWeapon, weaponSubtype, isBladedWeapon } from './data/items.js';
import { ENCOUNTERS } from './data/encounters.js';
import { CRIT_RATE, CRIT_MULT, BASE_HIT_RATE, BOSS_HIT_RATE, GOBLIN_HIT_RATE,
         calcDamage, rollHits } from './battle-math.js';
import { LOCATIONS, PLAYER_POOL, PLAYER_PALETTES, CHAT_PHRASES, ROSTER_FADE_STEPS, generateAllyStats } from './data/players.js';
import { BATTLE_MISS, BATTLE_GAME_OVER, BATTLE_ROAR, BATTLE_FIGHT, BATTLE_RUN,
         BATTLE_CANT_ESCAPE, BATTLE_RAN_AWAY, BATTLE_DEFEND, BATTLE_VICTORY,
         BATTLE_GOT_EXP, BATTLE_LEVEL_UP, BATTLE_BOSS_NAME, BATTLE_GOBLIN_NAME,
         BATTLE_MENU_ITEMS, PAUSE_ITEMS, AREA_NAMES, DUNGEON_NAME,
         POND_RESTORED } from './data/strings.js';
import { ENC_PAL0, ENC_PAL1, EYE_FANG_TILE_PAL, EYE_FANG_RAW,
         BLUE_WISP_TILE_PAL, BLUE_WISP_RAW,
         CARBUNCLE_TILE_PAL, CARBUNCLE_RAW } from './data/monster-sprites.js';
import { openSaveDB, serverDeleteSlot, parseSaveSlots } from './save.js';
import { _nameToBytes, _nesNameToString, _buildItemRowBytes, _makeGotNText, makeExpText, makeGilText, makeFoundItemText, makeProfLevelUpText } from './text-utils.js';
import { nesColorFade, _makeFadedPal, _stepPalFade } from './palette.js';
import { _getPlane0, _rebuild, _shiftHorizWater, _isWater, _buildHorizMixed, _writePixels64, _writeTilePixels } from './tile-math.js';
import { BAYER4, DMG_BOUNCE_TABLE, _dmgBounceY } from './data/animation-tables.js';
import { _calcBoxExpandSize, _encounterGridPos } from './battle-layout.js';
import { _makeCanvas16, _makeCanvas16ctx, _hflipCanvas16, _makeWhiteCanvas } from './canvas-utils.js';
import { _updateWorldWater, _updateIndoorWater, resetWorldWaterCache, resetIndoorWaterCache, _buildHorizWaterPair } from './water-animation.js';
import { initSlashSprites, initKnifeSlashSprites, initSwordSlashSprites } from './slash-effects.js';
import { initSouthWindSprite } from './south-wind.js';
import { BATTLE_BG_MAP_LOOKUP, renderBattleBg } from './battle-bg.js';
import { initTitleWater, initTitleSky, initTitleUnderwater, initUnderwaterSprites, initTitleOcean, initTitleLogo } from './title-animations.js';
import { BATTLE_SPRITE_ROM, BATTLE_JOB_SIZE, BATTLE_PAL_ROM } from './data/jobs.js';
import { ps, EQUIP_SLOT_SUBTYPE, getEquipSlotId, setEquipSlotId, recalcDEF, recalcCombatStats, getHitWeapon, isHitRightHand, initPlayerStats, initExpTable, grantExp, fullHeal, playerStatsSnapshot, gainProficiency, getProfHits, getProfLevel, getShieldEvade, PROF_CATEGORIES, WEAPON_PROF_CATEGORY } from './player-stats.js';
import { initProfIcons, getProfIcon } from './prof-icons.js';
import { chatState, addChatMessage, updateChat, drawChat } from './chat.js';
import { msgState, showMsgBox, updateMsgBox, drawMsgBox } from './message-box.js';
import { titleSt, isTitleActiveState, titleFadeLevel, titleFadePal, drawTitleOcean, drawTitleWater, drawTitleSky, drawTitleUnderwater, drawUnderwaterSprites, drawTitleSkyInHUD, drawTitle, drawPlayerSelectContent } from './title-screen.js';
import { pauseSt, updatePauseMenu, drawPauseMenu } from './pause-menu.js';
import { transSt, topBoxSt, loadingSt, startWipeTransition, updateTransition, updateTopBoxScroll, drawTransitionOverlay } from './transitions.js';
import { inputSt, handleBattleInput, handleRosterInput, handlePauseInput } from './input-handler.js';
import { checkTrigger, applyPassage, openPassage, handleChest, handleSecretWall, handleRockPuzzle, handlePondHeal, findWorldExitIndex } from './map-triggers.js';
import { pvpSt, startPVPBattle, resetPVPState, updatePVPBattle, drawBossSpriteBoxPVP } from './pvp.js';
import { OK_IDLE, OK_VICTORY, OK_L_BACK_SWING, OK_L_FWD_T2, OK_L_FWD_T3, OK_R_BACK_SWING, OK_R_FWD_T2, OK_KNEEL,
         OK_LEG_L_IDLE, OK_LEG_R_IDLE, OK_LEG_L_BACK_L, OK_LEG_R_BACK_L, OK_LEG_L_FWD_L, OK_LEG_R_FWD_L,
         OK_LEG_L_BACK_R, OK_LEG_R_SWING, OK_LEG_L_KNEEL, OK_LEG_R_KNEEL, OK_LEG_L_VICTORY, OK_LEG_R_VICTORY } from './data/job-sprites.js';

const isMobile = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

// --- Save data persistence (IndexedDB) ---
async function saveSlotsToDB() {
  if (!savesLoaded) return;
  try {
    const data = saveSlots.map(s => s ? {
      name: Array.from(s.name),
      level: s.level || (ps.stats ? ps.stats.level : 1),
      exp: s.exp != null ? s.exp : (ps.stats ? ps.stats.exp : 0),
      stats: s.stats || (ps.stats ? playerStatsSnapshot() : null),
      inventory: s.inventory || playerInventory
    } : null);
    // Local IndexedDB
    const db = await openSaveDB();
    const tx = db.transaction('roms', 'readwrite');
    tx.objectStore('roms').put(data, 'saves');
    // Server sync — push each changed slot
    if (window.ff3Auth) {
      data.forEach((slotData, i) => {
        if (slotData) window.ff3Auth.serverSave(i, slotData).catch(() => {});
      });
    }
  } catch (e) { /* silent fail */ }
}

async function loadSlotsFromDB() {
  try {
    // Try server first if logged in
    if (window.ff3Auth) {
      const serverSlots = await window.ff3Auth.serverLoadSaves().catch(() => null);
      if (serverSlots) {
        saveSlots = parseSaveSlots(serverSlots) || saveSlots;
        savesLoaded = true;
        return;
      }
    }
    // Fall back to IndexedDB
    const db = await openSaveDB();
    const tx = db.transaction('roms', 'readonly');
    const req = tx.objectStore('roms').get('saves');
    return new Promise((resolve) => {
      req.onsuccess = () => {
        saveSlots = parseSaveSlots(req.result) || saveSlots;
        savesLoaded = true;
        resolve();
      };
      req.onerror = () => { savesLoaded = true; resolve(); };
    });
  } catch (e) { savesLoaded = true; }
}


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
let battleSpriteCanvas = null;
let battleSpriteFadeCanvases = null;       // [step1..step4] NES-faded idle portrait for game-start fade-in
let battleSpriteDefendFadeCanvases = null; // same for defend pose
let battleSpriteKneelFadeCanvases = null;  // same for kneel pose
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

// ENC_PAL0/1, *_RAW, *_TILE_PAL → data/monster-sprites.js

// Per-monster canvas storage
const monsterBattleCanvas = new Map(); // monsterId → canvas
const monsterWhiteCanvas  = new Map(); // monsterId → white flash canvas
const monsterDeathFrames  = new Map(); // monsterId → death frame array

// Bayer 4×4 ordered dither matrix — creates the pixelated deterioration pattern

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
// titleSt.shipFadeFrames, titleSt.shadowFade → title-screen.js

// Loading screen fade state
const LOAD_FADE_STEP_MS = 133;  // same rate as battle BG fade
const LOAD_FADE_MAX = 4;        // 4 steps: $30→$20→$10→$00→$0F

// Loading screen pre-rendered fade frames
let moogleFadeFrames = null; // [step0=bright, step1, step2, step3=black] per walk frame pair
let bossFadeFrames = null;   // same structure for adamantoise
let loadingBgFadeFrames = null; // battle BG fade frames for loading screen

// Title screen state → titleSt in title-screen.js
// Title timing constants (needed by updateTitle and init functions in game.js)
const TITLE_FADE_MAX     = 4;
const TITLE_FADE_STEP_MS = 100;
const TITLE_FADE_MS      = (TITLE_FADE_MAX + 1) * TITLE_FADE_STEP_MS;
const TITLE_WAIT_MS      = 0;
const TITLE_HOLD_MS      = 2000;
const TITLE_ZBOX_MS      = 200;
const SELECT_TEXT_STEP_MS = 100;
const SELECT_TEXT_STEPS   = 4;

// Player select screen state
let selectCursor = 0;             // 0-2 (which slot)
let saveSlots = [null, null, null]; // null = empty, or Uint8Array of name bytes
let savesLoaded = false;            // guard: don't write to DB until loaded from DB first
let nameBuffer = [];                // bytes being typed
const NAME_MAX_LEN = 7;

// HUD info fade-in after title screen ends
let hudInfoFadeTimer = 0;
const HUD_INFO_FADE_STEPS = 4;
const HUD_INFO_FADE_STEP_MS = 200;

// HUD level ↔ HP cross-fade (0=level fully visible, 4=HP fully visible)
let hudHpLvStep = 0;
let hudHpLvTimer = 0;
const HUD_HPLV_STEP_MS = 60;

// Player stats are now in ps (imported from ./player-stats.js)

function getSlashFramesForWeapon(id, rightHand) {
  const st = weaponSubtype(id);
  if (st === 'knife' || st === 'dagger') return rightHand ? knifeSlashFramesR : knifeSlashFramesL;
  if (st === 'sword') return rightHand ? swordSlashFramesR : swordSlashFramesL;
  return rightHand ? slashFramesR : slashFramesL; // punch
}
// Inventory system
let playerInventory = {};    // { itemId: count } — e.g. { 0xA6: 3 }
let itemSelectCursor = 0;    // cursor index in item list
let itemHealAmount = 0;      // actual HP restored (for green number display)
let playerHealNum = null;    // {value, timer} — green heal number on portrait
let enemyHealNum = null;     // {value, timer, index} — green heal number on enemy
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
let encounterProfLevelUps = []; // [{cat, newLevel}] earned this battle
let profLevelUpIdx = 0;
let encounterDropItem = null;  // item id dropped on victory (or null)
let preBattleTrack = null;
let turnQueue = [];              // [{type:'player'|'enemy', index}] sorted by priority
let currentAttacker = -1;      // index of monster currently attacking
let dyingMonsterIndices = new Map(); // index → startDelayMs for staggered death wipe

// Hit animation state
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
// BATTLE_MISS, BATTLE_GAME_OVER → data/strings.js

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
// CRIT_RATE, CRIT_MULT, BASE_HIT_RATE, BOSS_HIT_RATE, GOBLIN_HIT_RATE → battle-math.js

// Top box — battle scene BG or area name
let topBoxMode = 'name';       // 'name' | 'battle'
let topBoxBgCanvas = null;     // Pre-rendered 256×32 battle BG strip (frame 0 = original)
let topBoxBgFadeFrames = null; // [original, step1, step2, ..., black] — NES palette fade

// Top box scroll animation — blue name banner slides in/out
const TOPBOX_FADE_STEPS = 4;         // 4 steps: $30→$20→$10→$00→$0F — still used by game.js draw functions

// White text on blue background — colors 1&2 = NES $02 (blue) so cell bg matches fill
const TEXT_WHITE_ON_BLUE = [0x02, 0x02, 0x02, 0x30];

// AREA_NAMES, DUNGEON_NAME → data/strings.js

// Pause menu state → pause-menu.js (pauseSt)
let prePauseTrack = -1;        // FF3 track playing before pause opened
const CURSOR_TILE_ROM = 0x01B450;  // hand cursor (4 tiles, 2x2 = 16x16)
let cursorTileCanvas = null;
let cursorFadeCanvases = null; // [step1..step4] NES-faded cursor canvases
// PAUSE_ITEMS → data/strings.js

// --- Fake players (MMO roster) ---
// All locations players can be in
// LOCATIONS, PLAYER_POOL → data/players.js

// Chat system → chat.js

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
// generateAllyStats, ROSTER_FADE_STEPS → data/players.js
// PLAYER_PALETTES → data/players.js
let fakePlayerPortraits = [];   // HTMLCanvasElement[palIdx][fadeStep]
let fakePlayerFullBodyCanvases = []; // HTMLCanvasElement[palIdx] — 16×24 h-flipped full body (idle)
let fakePlayerHitFullBodyCanvases = []; // HTMLCanvasElement[palIdx] — 16×24 h-flipped full body, hit pose legs
let fakePlayerVictoryPortraits = [];  // HTMLCanvasElement[palIdx][fadeStep] — victory pose
let fakePlayerHitPortraits = [];      // hit/recoil pose
let fakePlayerDefendPortraits = [];   // defend pose
let fakePlayerKneelPortraits = [];    // near-fatal kneel pose
let fakePlayerAttackPortraits = [];   // attack pose (right-hand arm raised)
let fakePlayerAttackLPortraits = [];  // attack pose (left-hand arm raised)
let fakePlayerKnifeBackPortraits = []; // knife back-swing body pose
let fakePlayerKnifeRPortraits = [];    // knife R-hand front-swing body pose
let fakePlayerKnifeLPortraits = [];    // knife L-hand front-swing body pose
let fakePlayerKnifeRFullBodyCanvases = []; // knife R-hand 16×24 h-flipped full body (back-swing pose)
let fakePlayerKnifeLFullBodyCanvases = []; // knife L-hand 16×24 h-flipped full body (back-swing pose)
let fakePlayerKnifeBackFullBodyCanvases = []; // knife back-swing 16×24 h-flipped full body (wind-up pose)
let fakePlayerKnifeRFwdFullBodyCanvases = []; // knife R-hand 16×24 h-flipped full body (forward-swing pose)
let fakePlayerKnifeLFwdFullBodyCanvases = []; // knife L-hand 16×24 h-flipped full body (forward-swing pose)
let fakePlayerKneelFullBodyCanvases = [];     // near-fatal kneel 16×24 h-flipped full body
let fakePlayerVictoryFullBodyCanvases = [];   // victory 16×24 h-flipped full body
let fakePlayerDeathFrames = [];               // death wipe frames per palette (for pvp-dissolve)
let rosterTimer = 0;             // ms until next movement event

const ROSTER_FADE_STEP_MS = 100;
let rosterFadeMap = {};          // {playerName: fadeStep} — 0=visible, 4=black
let rosterFadeTimers = {};       // {playerName: ms since last step}
let rosterFadeDir = {};          // {playerName: 'in'|'out'}
let rosterSlideY = {};           // {playerName: px offset} — animates toward 0
let rosterPrevLoc = null;        // last known player location
let rosterArrivalOrder = [];     // names in arrival order (most recent first)
const ROSTER_SLIDE_SPEED = 0.15; // px per ms
// chatState → chat.js

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
let allyHitIsLeft = false;     // true when current ally hit is L-hand (second strike)
let allyDamageNums = {};       // {allyIdx: {value, timer, crit} or {miss, timer}}
let allyShakeTimer = {};       // {allyIdx: ms remaining}
let enemyTargetAllyIdx = -1;   // which ally an enemy is targeting (-1 = player)
let allyExitTimer = 0;         // ms since victory-celebrate started (for ally exit fade)
let turnTimer = 0;             // ms elapsed while player is deciding; auto-skip at TURN_TIME_MS
const TURN_TIME_MS = 10000;    // 10 seconds to act before turn is skipped
const ROSTER_MENU_ITEMS = ['Party', 'Battle', 'Trade', 'Message', 'Inspect'];
const ROSTER_ROW_H = 32;        // pixels per roster row (matches HUD box height)
const ROSTER_VISIBLE = 3;       // max visible rows in panel (3×32=96px, 16px for scroll)
const ROSTER_TRI_H = 0;         // no top padding — scroll triangles go in bottom gap

// Chest message box state (same style as roar box)
// Universal message box — slide-in, instant text, Z dismiss, slide-out
// msgState → message-box.js

// Battle text byte arrays → data/strings.js

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
let pondStrobeTimer = 0;  // >0 = pond strobe active


// Screen wipe timing constants → transitions.js
// WIPE_DURATION still referenced by roster fade
const WIPE_DURATION = 44 * (1000 / 60);  // 44 NES frames ≈ 733ms

// Screen shake state (earthquake effect for secret passages)
const SHAKE_DURATION = 34 * (1000 / 60);  // 2 × 17 NES frames ≈ 567ms
let shakeActive = false;
let shakeTimer = 0;
let shakePendingAction = null;

function _onChatKeyDown(e) {
  e.preventDefault();
  if (e.key === 'Enter') {
    if (chatState.inputText.length > 0) {
      const slot = saveSlots[selectCursor];
      const senderName = (slot && slot.name) ? _nesNameToString(slot.name) : 'You';
      addChatMessage(senderName + ': ' + chatState.inputText, 'chat');
    }
    chatState.inputActive = false; chatState.inputText = '';
  } else if (e.key === 'Escape') {
    chatState.inputActive = false; chatState.inputText = '';
  } else if (e.key === 'Backspace') {
    chatState.inputText = chatState.inputText.slice(0, -1);
  } else if (e.key.length === 1 && chatState.inputText.length < 42) {
    chatState.inputText += e.key;
  }
}
function _onNameEntryKeyDown(e) {
  e.preventDefault();
  if (e.key === 'Enter' && nameBuffer.length > 0) {
    saveSlots[selectCursor] = { name: new Uint8Array(nameBuffer), level: 1, exp: 0, stats: null, inventory: {} };
    saveSlotsToDB();
    titleSt.state = 'select'; titleSt.timer = 0;
  } else if (e.key === 'Backspace') {
    if (nameBuffer.length > 0) nameBuffer.pop();
    else { titleSt.state = 'select'; titleSt.timer = 0; }
  } else if (e.key.length === 1 && /[a-zA-Z]/.test(e.key) && nameBuffer.length < NAME_MAX_LEN) {
    const ch = e.key;
    if (ch >= 'A' && ch <= 'Z') nameBuffer.push(0x8A + ch.charCodeAt(0) - 65);
    else nameBuffer.push(0xCA + ch.charCodeAt(0) - 97);
  }
}
export function init() {
  canvas = document.getElementById('game-canvas');
  ctx = canvas.getContext('2d');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  ctx.imageSmoothingEnabled = false;

  window.addEventListener('keydown', (e) => {
    if (chatState.inputActive) { _onChatKeyDown(e); return; }
    if (titleSt.state === 'name-entry') { _onNameEntryKeyDown(e); return; }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'z', 'Z', 'x', 'X', 'Enter', 's', 'S'].includes(e.key)) {
      e.preventDefault();
      keys[e.key] = true;
    }
    if (e.key === 'T' && titleSt.state === 'done' && battleState === 'none' &&
        pauseSt.state === 'none' && inputSt.rosterState === 'none' && transSt.state !== 'loading' && msgState.state === 'none' && !chatState.inputActive) {
      e.preventDefault();
      chatState.expanded = !chatState.expanded;
      playSFX(chatState.expanded ? SFX.SCREEN_OPEN : SFX.SCREEN_CLOSE);
    }
    if (e.key === 't' && titleSt.state === 'done' && battleState === 'none' &&
        pauseSt.state === 'none' && inputSt.rosterState === 'none' && transSt.state !== 'loading' && msgState.state === 'none') {
      e.preventDefault();
      chatState.inputActive = true; chatState.inputText = ''; chatState.cursorTimer = 0;
    }
  });
  window.addEventListener('keyup', (e) => { keys[e.key] = false; });
  window.addEventListener('beforeunload', () => saveSlotsToDB());
}

function _tileToCanvas(pixels, palette) {
  const c = document.createElement('canvas');
  c.width = 8; c.height = 8;
  const tctx = c.getContext('2d');
  const img = tctx.createImageData(8, 8);
  for (let i = 0; i < 64; i++) {
    const rgb = NES_SYSTEM_PALETTE[palette[pixels[i]]] || [0, 0, 0];
    img.data[i * 4] = rgb[0]; img.data[i * 4 + 1] = rgb[1];
    img.data[i * 4 + 2] = rgb[2]; img.data[i * 4 + 3] = 255;
  }
  tctx.putImageData(img, 0, 0);
  return c;
}

function _drawBoxOnCtx(pctx, tileCanvases, x, y, w, h, fill = true) {
  const [TL, TOP, TR, LEFT, RIGHT, BL, BOT, BR, FILL] = tileCanvases;
  pctx.drawImage(TL, x, y); pctx.drawImage(TR, x + w - 8, y);
  pctx.drawImage(BL, x, y + h - 8); pctx.drawImage(BR, x + w - 8, y + h - 8);
  for (let tx = x + 8; tx < x + w - 8; tx += 8) { pctx.drawImage(TOP, tx, y); pctx.drawImage(BOT, tx, y + h - 8); }
  for (let ty = y + 8; ty < y + h - 8; ty += 8) { pctx.drawImage(LEFT, x, ty); pctx.drawImage(RIGHT, x + w - 8, ty); }
  if (fill) for (let ty = y + 8; ty < y + h - 8; ty += 8) for (let tx = x + 8; tx < x + w - 8; tx += 8) pctx.drawImage(FILL, tx, ty);
}

function _initHUDBorderTiles(tiles) {
  borderTileCanvases = tiles.map(p => _tileToCanvas(p, MENU_PALETTE));
  cornerMasks = [0, 2, 5, 7].map(idx => {
    const pixels = tiles[idx];
    const c = document.createElement('canvas'); c.width = 8; c.height = 8;
    const tctx = c.getContext('2d'); const img = tctx.createImageData(8, 8);
    for (let i = 0; i < 64; i++) if (pixels[i] === 0) img.data[i * 4 + 3] = 255;
    tctx.putImageData(img, 0, 0); return c;
  });
  borderBlueTileCanvases = tiles.map(p => _tileToCanvas(p, [0x02, 0x00, 0x02, 0x30]));
  borderFadeSets = [];
  for (let step = 0; step <= LOAD_FADE_MAX; step++) {
    const fadedPal = MENU_PALETTE.map(c => { let fc = c; for (let s = 0; s < step; s++) fc = nesColorFade(fc); return fc; });
    borderFadeSets.push(tiles.map(p => _tileToCanvas(p, fadedPal)));
  }
  // Wire border tile refs into title-screen.js
  titleSt.borderTiles = borderTileCanvases;
  titleSt.borderFadeSets = borderFadeSets;
}

function _initHUDCanvases() {
  hudCanvas = document.createElement('canvas'); hudCanvas.width = CANVAS_W; hudCanvas.height = CANVAS_H;
  const hctx = hudCanvas.getContext('2d'); hctx.imageSmoothingEnabled = false;
  _drawBoxOnCtx(hctx, borderTileCanvases, HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H, false);
  _drawBoxOnCtx(hctx, borderTileCanvases, HUD_RIGHT_X, HUD_VIEW_Y, 32, 32);
  _drawBoxOnCtx(hctx, borderTileCanvases, HUD_RIGHT_X + 32, HUD_VIEW_Y, HUD_RIGHT_W - 32, 32);
  _drawBoxOnCtx(hctx, borderTileCanvases, 0, HUD_BOT_Y, CANVAS_W, HUD_BOT_H);
  titleHudCanvas = document.createElement('canvas'); titleHudCanvas.width = CANVAS_W; titleHudCanvas.height = CANVAS_H;
  const thctx = titleHudCanvas.getContext('2d'); thctx.imageSmoothingEnabled = false;
  _drawBoxOnCtx(thctx, borderTileCanvases, HUD_VIEW_X, HUD_VIEW_Y, CANVAS_W, HUD_VIEW_H, false);
  _drawBoxOnCtx(thctx, borderTileCanvases, 0, HUD_BOT_Y, CANVAS_W, HUD_BOT_H);
}

function _buildFadedHUDSet(boxes) {
  const arr = [];
  for (let step = 1; step <= LOAD_FADE_MAX; step++) {
    const c = document.createElement('canvas'); c.width = CANVAS_W; c.height = CANVAS_H;
    const fctx = c.getContext('2d'); fctx.imageSmoothingEnabled = false;
    for (const [bx, by, bw, bh, fill] of boxes) _drawBoxOnCtx(fctx, borderFadeSets[step], bx, by, bw, bh, fill);
    arr.push(c);
  }
  return arr;
}

function initHUD(romData) {
  _initHUDBorderTiles(decodeTiles(romData, BORDER_TILE_ROM, BORDER_TILE_COUNT));
  _initHUDCanvases();
  hudFadeCanvases = _buildFadedHUDSet([
    [HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H, false],
    [HUD_RIGHT_X, HUD_VIEW_Y, 32, 32, true],
    [HUD_RIGHT_X + 32, HUD_VIEW_Y, HUD_RIGHT_W - 32, 32, true],
  ]);
  titleHudFadeCanvases = _buildFadedHUDSet([[HUD_VIEW_X, HUD_VIEW_Y, CANVAS_W, HUD_VIEW_H, false]]);
}

function _renderPortrait(tiles, layout, palette) {
  const c = _makeCanvas16(); const pctx = c.getContext('2d');
  for (let i = 0; i < 4; i++) _blitTile(pctx, tiles[i], palette, layout[i][0], layout[i][1]);
  return c;
}

// Shared helper: generate palette-variant portrait frames for a set of decoded tiles
function _genPosePortraits(poseTiles) {
  return PLAYER_PALETTES.map(basePal => {
    const frames = [];
    for (let step = 0; step <= ROSTER_FADE_STEPS; step++) {
      const pal = basePal.slice();
      for (let s = 0; s < step; s++) { pal[1] = nesColorFade(pal[1]); pal[2] = nesColorFade(pal[2]); pal[3] = nesColorFade(pal[3]); }
      frames.push(_renderPortrait(poseTiles, _BATTLE_LAYOUT, pal));
    }
    return frames;
  });
}
// PPU tile data for player poses not already in _FP_IDLE/KNIFE constants
// Onion Knight pose tiles — imported from src/data/job-sprites.js
const _FP_ATK_R_TILE  = OK_R_FWD_T2;
const _FP_ATK_L_TILE3 = OK_L_FWD_T2;
const _FP_ATK_L_TILE4 = OK_L_FWD_T3;
const _FP_KNEEL       = OK_KNEEL;
function _initFakePosePortraits(romData) {
  const idleTiles = _FP_IDLE_PPU.map(d => decodeTile(d, 0));
  fakePlayerPortraits         = _genPosePortraits(idleTiles);
  fakePlayerVictoryPortraits  = _genPosePortraits(_FP_VICTORY.map(d => decodeTile(d, 0)));
  fakePlayerHitPortraits      = _genPosePortraits([0,1,2,3].map(i => decodeTile(romData, BATTLE_SPRITE_ROM + (30 + i) * 16)));
  fakePlayerDefendPortraits   = _genPosePortraits(_FP_DEFEND.map(d => decodeTile(d, 0)));
  fakePlayerAttackPortraits   = _genPosePortraits([idleTiles[0], idleTiles[1], decodeTile(_FP_ATK_R_TILE, 0), idleTiles[3]]);
  fakePlayerAttackLPortraits  = _genPosePortraits([idleTiles[0], idleTiles[1], idleTiles[2], decodeTile(_FP_KNIFE_L[3], 0)]);
  fakePlayerKnifeBackPortraits = _genPosePortraits(_FP_KNIFE_BACK.map(d => decodeTile(d, 0)));
  fakePlayerKnifeRPortraits   = _genPosePortraits(_FP_KNIFE_R.map(d => decodeTile(d, 0)));
  fakePlayerKnifeLPortraits   = _genPosePortraits(_FP_KNIFE_L.map(d => decodeTile(d, 0)));
  fakePlayerKneelPortraits    = _genPosePortraits(_FP_KNEEL.map(d => decodeTile(d, 0)));
}
// Build a 16×24 h-flipped full-body canvas from 4 top tiles + 2 leg tiles
function _renderDecodedTile(ctx, tile, pal, ox, oy) { _blitTile(ctx, tile, pal, ox, oy); }
function _buildFullBody16x24Canvas(topTiles4, legL, legR, pal) {
  const c = document.createElement('canvas'); c.width = 16; c.height = 24;
  const bctx = c.getContext('2d');
  topTiles4.forEach((tile, i) => { const [bx, by] = _BATTLE_LAYOUT[i]; _renderDecodedTile(bctx, tile, pal, bx, by); });
  [[legL, 0, 16], [legR, 8, 16]].forEach(([tile, lx, ly]) => _renderDecodedTile(bctx, tile, pal, lx, ly));
  const fl = document.createElement('canvas');
  fl.width = 16; fl.height = 24;
  const flctx = fl.getContext('2d');
  flctx.save(); flctx.translate(16, 0); flctx.scale(-1, 1); flctx.drawImage(c, 0, 0); flctx.restore();
  return fl;
}
// Onion Knight pose tiles — imported from src/data/job-sprites.js
const _FP_IDLE_PPU    = OK_IDLE;
const _FP_VICTORY     = OK_VICTORY;       // victory/defend body (arm raised)
const _FP_KNIFE_BACK  = OK_L_BACK_SWING; // L back swing body (idle + arm pulled)
const _FP_DEFEND      = OK_VICTORY;       // defend = victory body pose
const _FP_KNIFE_R     = OK_R_BACK_SWING;
const _FP_KNIFE_L     = OK_L_BACK_SWING; // L back swing body (fwd swing only changes T2+T3)
const _FP_LEG_L       = OK_LEG_L_IDLE;
const _FP_LEG_R       = OK_LEG_R_IDLE;
const _FP_LEG_L_BACK_L  = OK_LEG_L_BACK_L;
const _FP_LEG_R_BACK_L  = OK_LEG_R_BACK_L;
const _FP_LEG_L_FWD_L   = OK_LEG_L_FWD_L;
const _FP_LEG_R_FWD_L   = OK_LEG_R_FWD_L;
const _FP_LEG_L_BACK_R  = OK_LEG_L_BACK_R;
const _FP_LEG_R_SWING   = OK_LEG_R_SWING;
const _FP_LEG_L_KNEEL   = OK_LEG_L_KNEEL;
const _FP_LEG_R_KNEEL   = OK_LEG_R_KNEEL;
const _FP_LEG_L_VICTORY = OK_LEG_L_VICTORY;
const _FP_LEG_R_VICTORY = OK_LEG_R_VICTORY;
function _buildIdleFullBodies() {
  const legL = decodeTile(_FP_LEG_L, 0), legR = decodeTile(_FP_LEG_R, 0);
  const tiles = _FP_IDLE_PPU.map(d => decodeTile(d, 0));
  fakePlayerFullBodyCanvases = PLAYER_PALETTES.map(pal => _buildFullBody16x24Canvas(tiles, legL, legR, pal));
}
function _buildKnifeFullBodies() {
  const build = (data, lL, lR, pal) => _buildFullBody16x24Canvas(data.map(d => decodeTile(d, 0)), decodeTile(lL, 0), decodeTile(lR, 0), pal);
  fakePlayerKnifeRFullBodyCanvases    = PLAYER_PALETTES.map(pal => build(_FP_KNIFE_R,    _FP_LEG_L_BACK_R, _FP_LEG_R_SWING,   pal));
  fakePlayerKnifeLFullBodyCanvases    = PLAYER_PALETTES.map(pal => build(_FP_KNIFE_L,    _FP_LEG_L_BACK_L, _FP_LEG_R_BACK_L,  pal));
  fakePlayerKnifeBackFullBodyCanvases = PLAYER_PALETTES.map(pal => build(_FP_KNIFE_BACK, _FP_LEG_L_BACK_L, _FP_LEG_R_BACK_L, pal));
  // Forward-swing full bodies — arm extended, distinct leg tiles
  const _FP_L_FWD = [OK_IDLE[0], OK_IDLE[1], OK_L_FWD_T2, OK_L_FWD_T3];
  const _FP_R_FWD = [OK_IDLE[0], OK_IDLE[1], OK_R_FWD_T2, OK_IDLE[3]];
  fakePlayerKnifeLFwdFullBodyCanvases = PLAYER_PALETTES.map(pal => build(_FP_L_FWD, _FP_LEG_L_FWD_L, _FP_LEG_R_FWD_L, pal));
  fakePlayerKnifeRFwdFullBodyCanvases = PLAYER_PALETTES.map(pal => build(_FP_R_FWD, _FP_LEG_L_BACK_R, _FP_LEG_R_SWING, pal));
  fakePlayerKneelFullBodyCanvases    = PLAYER_PALETTES.map(pal => build(_FP_KNEEL, _FP_LEG_L_KNEEL, _FP_LEG_R_KNEEL, pal));
  fakePlayerVictoryFullBodyCanvases  = PLAYER_PALETTES.map(pal => build(_FP_VICTORY, _FP_LEG_L_VICTORY, _FP_LEG_R_VICTORY, pal));
}
function _buildHitFullBodies(romData) {
  const legL = decodeTile(_FP_LEG_L, 0), legR = decodeTile(_FP_LEG_R, 0);
  const hitPortrait4 = [0,1,2,3].map(i => decodeTile(romData, BATTLE_SPRITE_ROM + (30 + i) * 16));
  const hitLeg2 = [34,35].map(i => decodeTile(romData, BATTLE_SPRITE_ROM + i * 16));
  fakePlayerHitFullBodyCanvases = PLAYER_PALETTES.map(pal =>
    _buildFullBody16x24Canvas([...hitPortrait4], hitLeg2[0], hitLeg2[1], pal));
}
function _initFakeFullBodyCanvases(romData) {
  _buildIdleFullBodies();
  _buildKnifeFullBodies();
  _buildHitFullBodies(romData);
  fakePlayerDeathFrames = fakePlayerFullBodyCanvases.map(c => _makeDeathFrames(c));
}
function initFakePlayerPortraits(romData) {
  _initFakePosePortraits(romData);
  _initFakeFullBodyCanvases(romData);
}


function initCursorTile(romData) {
  const palette = [0x0F, 0x00, 0x10, 0x30]; // cursor palette: black, dark gray, gray, white
  cursorTileCanvas = _buildCanvas4ROM(romData, CURSOR_TILE_ROM, palette);
  cursorFadeCanvases = [];
  for (let step = 1; step <= 4; step++) {
    let fp = [...palette];
    for (let s = 0; s < step; s++) fp = fp.map(c => nesColorFade(c));
    cursorFadeCanvases.push(_buildCanvas4ROM(romData, CURSOR_TILE_ROM, fp));
  }
}

// --- Battle sprite low-level helpers ---
const _BATTLE_LAYOUT = [[0,0],[8,0],[0,8],[8,8]];

// Blit a decoded 8×8 tile onto a canvas context at (x, y), transparent on palette index 0
function _blitTile(ctx, px, palette, x, y) {
  const img = ctx.createImageData(8, 8);
  for (let p = 0; p < 64; p++) {
    const ci = px[p];
    if (ci === 0) { img.data[p * 4 + 3] = 0; }
    else {
      const rgb = NES_SYSTEM_PALETTE[palette[ci]] || [0, 0, 0];
      img.data[p * 4] = rgb[0]; img.data[p * 4 + 1] = rgb[1];
      img.data[p * 4 + 2] = rgb[2]; img.data[p * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, x, y);
}

// H-flipped blit — for blade sprite windup poses (NES attr bit $40)
function _blitTileH(ctx, px, palette, x, y) {
  const img = ctx.createImageData(8, 8);
  for (let p = 0; p < 64; p++) {
    const ci = px[p];
    if (ci === 0) continue;
    const rgb = NES_SYSTEM_PALETTE[palette[ci]] || [0, 0, 0];
    const di = (Math.floor(p / 8) * 8 + (7 - p % 8)) * 4;
    img.data[di] = rgb[0]; img.data[di + 1] = rgb[1];
    img.data[di + 2] = rgb[2]; img.data[di + 3] = 255;
  }
  ctx.putImageData(img, x, y);
}

// Build a 16×16 canvas from 4 PPU tile byte arrays using the battle 2×2 layout
function _buildCanvas4(tilesArr, palette) {
  const c = _makeCanvas16(); const cx = c.getContext('2d');
  for (let i = 0; i < 4; i++) {
    _blitTile(cx, decodeTile(tilesArr[i], 0), palette, _BATTLE_LAYOUT[i][0], _BATTLE_LAYOUT[i][1]);
  }
  return c;
}

// Generate HUD_INFO_FADE_STEPS NES-palette-faded versions of a _buildCanvas4 sprite
function _buildFadedCanvas4Set(tilesArr, palette) {
  const arr = [];
  for (let step = 1; step <= HUD_INFO_FADE_STEPS; step++) {
    let fp = [...palette];
    for (let s = 0; s < step; s++) fp = fp.map(c => nesColorFade(c));
    arr.push(_buildCanvas4(tilesArr, fp));
  }
  return arr;
}

// Build a 16×16 canvas from 4 sequential ROM tiles (16 bytes each) using the battle 2×2 layout
function _buildCanvas4ROM(romData, offset, palette) {
  const c = _makeCanvas16(); const cx = c.getContext('2d');
  for (let i = 0; i < 4; i++) {
    _blitTile(cx, decodeTile(romData, offset + i * 16), palette, _BATTLE_LAYOUT[i][0], _BATTLE_LAYOUT[i][1]);
  }
  return c;
}

// Draw a single decoded tile onto an existing canvas context (composite, no clear)
function _drawTileOnto(tileBytes, palette, ctx, x, y) {
  _blitTile(ctx, decodeTile(tileBytes, 0), palette, x, y);
}

function _initBattleIdleSprites(romData, palette) {
  const IDLE_PPU = OK_IDLE;
  // Idle portrait — 2×2 layout row-major (disasm 3C/82FA OAM data)
  battleSpriteCanvas = _buildCanvas4(IDLE_PPU, palette);
  battleSpriteFadeCanvases = _buildFadedCanvas4Set(IDLE_PPU, palette);

  // Silhouette — same shape, all opaque pixels → NES $00 (grey)
  silhouetteCanvas = document.createElement('canvas');
  silhouetteCanvas.width = 16; silhouetteCanvas.height = 16;
  const sctx = silhouetteCanvas.getContext('2d');
  sctx.drawImage(battleSpriteCanvas, 0, 0);
  const sdata = sctx.getImageData(0, 0, 16, 16);
  const darkRgb = NES_SYSTEM_PALETTE[0x00] || [0, 0, 0];
  for (let p = 0; p < 16 * 16; p++) {
    if (sdata.data[p * 4 + 3] > 0) {
      sdata.data[p * 4] = darkRgb[0];
      sdata.data[p * 4 + 1] = darkRgb[1];
      sdata.data[p * 4 + 2] = darkRgb[2];
    }
  }
  sctx.putImageData(sdata, 0, 0);
}

function _initBattleAttackSprites(palette) {
  const ATK_R_39 = OK_R_FWD_T2; // R fwd swing mid-L tile

  // Right-hand punch (mid-L = $39) — idle + modified lower-left tile
  battleSpriteAttackCanvas = document.createElement('canvas');
  battleSpriteAttackCanvas.width = 16; battleSpriteAttackCanvas.height = 16;
  const actx = battleSpriteAttackCanvas.getContext('2d');
  actx.drawImage(battleSpriteCanvas, 0, 0);
  _drawTileOnto(ATK_R_39, palette, actx, 0, 8);

  // Fist tile $49 — 8×8 canvas (identical for both hands)
  const FIST_TILE = new Uint8Array([0x00,0x00,0x00,0x0C,0x2C,0x4C,0x00,0x00,
                                     0x00,0x00,0x00,0x73,0x53,0x23,0x00,0x00]);
  battleFistCanvas = document.createElement('canvas');
  battleFistCanvas.width = 8; battleFistCanvas.height = 8;
  _drawTileOnto(FIST_TILE, palette, battleFistCanvas.getContext('2d'), 0, 0);

  // Left-hand punch (mid-L = $3B, mid-R = $3C)
  battleSpriteAttackLCanvas = document.createElement('canvas');
  battleSpriteAttackLCanvas.width = 16; battleSpriteAttackLCanvas.height = 16;
  const alctx = battleSpriteAttackLCanvas.getContext('2d');
  alctx.drawImage(battleSpriteCanvas, 0, 0);
  // L back swing: mid-left stays idle, mid-right = _FP_KNIFE_L[3]
  _drawTileOnto(_FP_KNIFE_L[3], palette, alctx, 8, 8);
}

function _initBattleKnifeBodySprites(palette) {
  // Knife R/L-hand body poses: same tiles as _FP_KNIFE_R / _FP_KNIFE_L
  battleSpriteKnifeRCanvas = _buildCanvas4(_FP_KNIFE_R, palette);
  battleSpriteKnifeLCanvas = _buildCanvas4(_FP_KNIFE_L, palette);

  // Back-swing body pose: same tiles as _FP_KNIFE_BACK
  battleSpriteKnifeBackCanvas = _buildCanvas4(_FP_KNIFE_BACK, palette);
}

function _buildBladeCanvas(tileDefs, pal, pos, swungOrder) {
  const raised = document.createElement('canvas'); raised.width = 16; raised.height = 16;
  const rctx = raised.getContext('2d');
  for (let t = 0; t < 4; t++) _blitTileH(rctx, decodeTile(tileDefs[t], 0), pal, pos[t][0], pos[t][1]);
  const swung = document.createElement('canvas'); swung.width = 16; swung.height = 16;
  const sctx = swung.getContext('2d');
  for (let t = 0; t < 4; t++) _blitTile(sctx, decodeTile(tileDefs[swungOrder[t]], 0), pal, pos[t][0], pos[t][1]);
  return { raised, swung };
}
function _initBattleBladeSprites(palette) {
  const pos = [[0,0],[8,0],[0,8],[8,8]];
  const so  = [1, 0, 3, 2]; // swung order
  const BLADE_TILES = [
    new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x80]),
    new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x01, 0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x01]),
    new Uint8Array([0x00,0x80,0x40,0x21,0x11,0x08,0x07,0x1B, 0xC0,0xE0,0x70,0x38,0x1C,0x0E,0x04,0x00]),
    new Uint8Array([0x01,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x01,0x00,0x00,0x00,0x00,0x00,0x00,0x00]),
  ];
  const SWORD_TILES = [
    new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x80,0xC0, 0x00,0x00,0x00,0x00,0x00,0x00,0x80,0xC0]),
    new Uint8Array([0x00,0x70,0x78,0x7C,0x3E,0x1F,0x0D,0x06, 0x00,0x70,0x78,0x7C,0x3E,0x1F,0x0F,0x07]),
    new Uint8Array([0x60,0xB0,0xD9,0x6D,0x33,0x12,0x0D,0x3B, 0xE0,0xF0,0xF8,0x7C,0x3C,0x1C,0x02,0x00]),
    new Uint8Array([0x03,0x01,0x00,0x00,0x00,0x00,0x00,0x00, 0x03,0x01,0x00,0x00,0x00,0x00,0x00,0x00]),
  ];
  let b;
  b = _buildBladeCanvas(BLADE_TILES, [0x0F,0x00,0x32,0x30], pos, so);
  battleKnifeBladeCanvas = b.raised; battleKnifeBladeSwungCanvas = b.swung;
  b = _buildBladeCanvas(BLADE_TILES, [0x0F,0x1B,0x2B,0x30], pos, so);
  battleDaggerBladeCanvas = b.raised; battleDaggerBladeSwungCanvas = b.swung;
  b = _buildBladeCanvas(SWORD_TILES, [0x0F,0x00,0x32,0x30], pos, so);
  battleSwordBladeCanvas = b.raised; battleSwordBladeSwungCanvas = b.swung;
}

function _initBattleRomPoses(romData, palette) {
  // Victory pose: OK_VICTORY tiles (arms raised, confirmed from PPU debugger)
  battleSpriteVictoryCanvas = _buildCanvas4(_FP_VICTORY, palette);
  // Hit/recoil pose: sprite frame 5 in job block (tiles 30-33)
  battleSpriteHitCanvas = _buildCanvas4ROM(romData, BATTLE_SPRITE_ROM + 30 * 16, palette);
  // Attack frame 2: ROM frame 3 (tiles 18-21, arm raised)
  battleSpriteAttack2Canvas = _buildCanvas4ROM(romData, BATTLE_SPRITE_ROM + 18 * 16, palette);
}

function _initBattleDefendSprites(palette) {
  // Defend pose: tiles $43-$46 (top 2×2 of 2×3 crouching body)
  const DEFEND_TILES = [
    new Uint8Array([0x05,0x0B,0x17,0x03,0x00,0x00,0x0E,0x1F, 0x07,0x0F,0x1F,0x3F,0x43,0x40,0x20,0x00]), // $43
    new Uint8Array([0x00,0x00,0xA0,0xD0,0xE8,0x78,0x10,0x88, 0x2C,0x59,0xBE,0xD6,0xEF,0xFB,0x75,0x1A]), // $44
    new Uint8Array([0x04,0xD6,0xD6,0x3F,0xEF,0xF0,0x63,0x0E, 0x00,0x00,0x00,0x24,0xE4,0xF0,0x6F,0x1F]), // $45
    new Uint8Array([0x90,0x4C,0xCC,0x30,0x7C,0x78,0x30,0x00, 0x32,0x21,0x00,0xB0,0x7C,0x7C,0xB2,0xC2]), // $46
  ];
  battleSpriteDefendCanvas = _buildCanvas4(DEFEND_TILES, palette);
  battleSpriteDefendFadeCanvases = _buildFadedCanvas4Set(DEFEND_TILES, palette);

  // Defend sparkle: tiles $49-$4C, 4 × 8×8 frames
  const SPARKLE_TILES = [
    new Uint8Array([0x01,0x00,0x08,0x00,0x00,0x41,0x00,0x02, 0x00,0x00,0x01,0x02,0x00,0x09,0x00,0x12]),
    new Uint8Array([0x00,0x00,0x00,0x04,0x0A,0x14,0x0A,0x01, 0x00,0x00,0x00,0x18,0x1C,0x0E,0x04,0x00]),
    new Uint8Array([0x00,0x00,0x20,0x10,0x08,0x04,0x00,0x00, 0x00,0x00,0x30,0x38,0x10,0x00,0x00,0x00]),
    new Uint8Array([0x80,0x00,0x20,0x00,0x00,0x00,0x00,0x00, 0x80,0x40,0x00,0x00,0x00,0x00,0x00,0x00]),
  ];
  defendSparkleFrames = SPARKLE_TILES.map(raw => {
    const sc = document.createElement('canvas');
    sc.width = 8; sc.height = 8;
    _blitTile(sc.getContext('2d'), decodeTile(raw, 0), DEFEND_SPARKLE_PAL, 0, 0);
    return sc;
  });

  _initCureSparkleFrames();
}

function _initCureSparkleFrames() {
  const CURE_TILE_4D = new Uint8Array([0x00,0x40,0x00,0x10,0x08,0x04,0x03,0x03, 0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x01]);
  const CURE_TILE_4E = new Uint8Array([0x00,0x00,0x00,0x08,0x10,0x60,0x20,0x80, 0x00,0x00,0x00,0x00,0x00,0x00,0xC0,0xC0]);
  const CURE_PAL = [0x0F, 0x12, 0x22, 0x31];
  const cureTileCanvases = [CURE_TILE_4D, CURE_TILE_4E].map(raw => {
    const c = document.createElement('canvas'); c.width = 8; c.height = 8;
    _blitTile(c.getContext('2d'), decodeTile(raw, 0), CURE_PAL, 0, 0); return c;
  });
  const configLayouts = [
    [[1,0,0,true,false],[0,8,0,true,false],[0,0,8,false,true],[1,8,8,false,true]],
    [[0,0,0,false,false],[1,8,0,false,false],[1,0,8,true,true],[0,8,8,true,true]],
  ];
  cureSparkleFrames = configLayouts.map(config => {
    const c = _makeCanvas16();
    const cx = c.getContext('2d');
    for (const [ti, ox, oy, hf, vf] of config) {
      cx.save();
      if (hf && vf) { cx.translate(ox + 8, oy + 8); cx.scale(-1, -1); cx.drawImage(cureTileCanvases[ti], 0, 0); }
      else if (hf)  { cx.translate(ox + 8, oy);     cx.scale(-1,  1); cx.drawImage(cureTileCanvases[ti], 0, 0); }
      else if (vf)  { cx.translate(ox,     oy + 8); cx.scale( 1, -1); cx.drawImage(cureTileCanvases[ti], 0, 0); }
      else          { cx.drawImage(cureTileCanvases[ti], ox, oy); }
      cx.restore();
    }
    return c;
  });
}

function _initBattleLowHPSprites(palette) {
  // Kneel pose: same tiles as _FP_KNEEL
  battleSpriteKneelCanvas = _buildCanvas4(_FP_KNEEL, palette);
  battleSpriteKneelFadeCanvases = _buildFadedCanvas4Set(_FP_KNEEL, palette);

  // Sweat frames: 2 × 16×8 (tiles $49/$4A frame A, $4B/$4C frame B)
  const SWEAT_FRAME_TILES = [
    [new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x04,0x00,0x40,0x00,0x00,0x00,0x00,0x00]),
     new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x20,0x00,0x02,0x00,0x00,0x00,0x00,0x00])],
    [new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x02,0x10,0x00,0x40,0x00]),
     new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x40,0x08,0x00,0x02,0x00])],
  ];
  sweatFrames = SWEAT_FRAME_TILES.map(frameTiles => {
    const sc = document.createElement('canvas');
    sc.width = 16; sc.height = 8;
    const sctx = sc.getContext('2d');
    for (let t = 0; t < 2; t++) {
      _blitTile(sctx, decodeTile(frameTiles[t], 0), palette, t * 8, 0);
    }
    return sc;
  });
}

function initBattleSprite(romData) {
  // Battle palette: character palette 0 (ID $FC) at ROM 0x05CF04
  // 3 bytes = colors 1-3, color 0 always $0F (disasm 2E/9E28 + 2E/9DA2)
  const palette = [0x0F, romData[BATTLE_PAL_ROM], romData[BATTLE_PAL_ROM + 1], romData[BATTLE_PAL_ROM + 2]];

  _initBattleIdleSprites(romData, palette);
  _initBattleAttackSprites(palette);
  _initBattleKnifeBodySprites(palette);
  _initBattleBladeSprites(palette);
  _initBattleRomPoses(romData, palette);
  _initBattleDefendSprites(palette);
  _initBattleLowHPSprites(palette);
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

  for (let i = 0; i < 4; i++) _renderDecodedTile(actx, tiles[i], i < 2 ? palTop : palBot, _BATTLE_LAYOUT[i][0], _BATTLE_LAYOUT[i][1]);

  // Flipped frame
  const flipped = _hflipCanvas16(normal);

  adamantoiseFrames = [normal, flipped];
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
      _blitTile(cctx, tiles[ty * LAND_TURTLE_COLS + tx], pal, tx * 8, ty * 8);
    }
  }

  landTurtleBattleCanvas = c;

  landTurtleWhiteCanvas = _makeWhiteCanvas(landTurtleBattleCanvas);
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
      _blitTile(cctx, tiles[tileIdx], pal, tx * 8, ty * 8);
    }
  }
  return c;
}



function _makeDeathFrames(srcCanvas) {
  const { width: w, height: h } = srcCanvas;
  const origData = srcCanvas.getContext('2d').getImageData(0, 0, w, h);
  const maxThreshold = (w - 1) + (h - 1) + 15;
  const frames = [];
  for (let f = 0; f < MONSTER_DEATH_FRAMES; f++) {
    const fc = document.createElement('canvas'); fc.width = w; fc.height = h;
    const fctx = fc.getContext('2d'); const fd = fctx.createImageData(w, h);
    const wave = (f / (MONSTER_DEATH_FRAMES - 1)) * (maxThreshold + 1);
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const idx = (py * w + px) * 4;
        const threshold = (w - 1 - px) + py + BAYER4[py & 3][px & 3];
        if (threshold < wave) { fd.data[idx + 3] = 0; }
        else { fd.data[idx] = origData.data[idx]; fd.data[idx+1] = origData.data[idx+1]; fd.data[idx+2] = origData.data[idx+2]; fd.data[idx+3] = origData.data[idx+3]; }
      }
    }
    fctx.putImageData(fd, 0, 0); frames.push(fc);
  }
  return frames;
}

function initGoblinSprite(romData) {
  const tiles = [];
  for (let i = 0; i < GOBLIN_TILES; i++) {
    tiles.push(decodeTile(romData, GOBLIN_GFX_OFF + i * 16));
  }

  // Render full-color sprite
  goblinBattleCanvas = _renderGoblinSprite(tiles, GOBLIN_PAL0, GOBLIN_PAL1, GOBLIN_TILE_PAL);

  goblinWhiteCanvas = _makeWhiteCanvas(goblinBattleCanvas);
  goblinDeathFrames = _makeDeathFrames(goblinBattleCanvas);
}

// Generic renderer for PPU-dumped enemy sprites.
// rawBytes: Uint8Array of (cols*rows*16) bytes — tiles in row-major order.

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

  monsterWhiteCanvas.set(monsterId, _makeWhiteCanvas(canvas));
  const frames = _makeDeathFrames(canvas);
  monsterDeathFrames.set(monsterId, frames);
}

function _hflipTile(pixels) {
  const out = new Uint8Array(64);
  for (let row = 0; row < 8; row++)
    for (let col = 0; col < 8; col++)
      out[row * 8 + col] = pixels[row * 8 + (7 - col)];
  return out;
}

function _renderInvFrame(tilePixels, grid, pal) {
  const c = document.createElement('canvas');
  c.width = 32; c.height = 32;
  const fctx = c.getContext('2d');
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const tileId = grid[row * 4 + col];
      let pixels = tilePixels.get(tileId);
      if (!pixels) continue;
      pixels = _hflipTile(pixels);
      const img = fctx.createImageData(8, 8);
      _writePixels64(img, pixels, pal);
      fctx.putImageData(img, col * 8, row * 8);
    }
  }
  return c;
}

function _renderInvShadow(tilePixels, pal) {
  const c = document.createElement('canvas');
  c.width = 32; c.height = 8;
  const sctx = c.getContext('2d');
  const shadowTiles = [0xC0, 0xC1, 0xC1, 0xC0];
  const shadowFlip  = [false, false, false, true];
  for (let col = 0; col < 4; col++) {
    let pixels = tilePixels.get(shadowTiles[col]);
    if (!pixels) continue;
    if (shadowFlip[col]) pixels = _hflipTile(pixels);
    const img = sctx.createImageData(8, 8);
    _writePixels64(img, pixels, pal);
    sctx.putImageData(img, col * 8, 0);
  }
  return c;
}

function initInvincibleSprite(romData) {
  const tilePixels = new Map();
  for (let i = 0; i < 64; i++)
    tilePixels.set(0xC0 + i, decodeTile(romData, INVINCIBLE_TILE_ROM + i * 16));

  // East-facing frame a (OAM 3C:8586) — tiles reversed per row + h-flip
  const frameA_grid = [0xE5,0xE4,0xE3,0xE2, 0xE9,0xE8,0xE7,0xE6, 0xED,0xEC,0xEB,0xEA, 0xF1,0xF0,0xEF,0xEE];
  // East-facing frame b (OAM 3C:85C7) — alt animation
  const frameB_grid = [0xF5,0xF4,0xF3,0xF2, 0xF6,0xE8,0xE7,0xE6, 0xF7,0xEC,0xEB,0xEA, 0xFB,0xFA,0xF9,0xF8];

  invincibleFrames = [
    _renderInvFrame(tilePixels, frameA_grid, INVINCIBLE_PAL),
    _renderInvFrame(tilePixels, frameB_grid, INVINCIBLE_PAL),
  ];

  const fadePals = Array.from({ length: TITLE_FADE_MAX + 1 }, (_, fl) =>
    INVINCIBLE_PAL.map((c, i) => { if (i === 0) return c; let fc = c; for (let s = 0; s < fl; s++) fc = nesColorFade(fc); return fc; })
  );
  titleSt.shipFadeFrames = fadePals.map(p => [_renderInvFrame(tilePixels, frameA_grid, p), _renderInvFrame(tilePixels, frameB_grid, p)]);
  titleSt.shadowFade = fadePals.map(p => _renderInvShadow(tilePixels, p));
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
  for (let i = 0; i < 4; i++) {
    _blitTile(mctx, tiles[i], MOOGLE_PAL, _BATTLE_LAYOUT[i][0], _BATTLE_LAYOUT[i][1]);
  }

  const flipped = _hflipCanvas16(normal);

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

  const [c, cctx] = _makeCanvas16ctx();
  for (let i = 0; i < 4; i++) {
    _blitTile(cctx, tiles[i], fadedPal, _BATTLE_LAYOUT[i][0], _BATTLE_LAYOUT[i][1]);
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

  const [c, cctx] = _makeCanvas16ctx();
  for (let i = 0; i < 4; i++) _renderDecodedTile(cctx, tiles[i], i < 2 ? fadedTop : fadedBot, _BATTLE_LAYOUT[i][0], _BATTLE_LAYOUT[i][1]);
  return c;
}

function initLoadingScreenFadeFrames(romData) {
  // Moogle: 4 fade levels (0=bright, 3=black)
  moogleFadeFrames = [];
  for (let step = 0; step <= LOAD_FADE_MAX; step++) {
    const normal = renderSpriteFaded(romData, MOOGLE_SPRITE_OFF, MOOGLE_PAL, step);
    const flipped = _hflipCanvas16(normal);
    moogleFadeFrames.push([normal, flipped]);
  }

  // Boss (adamantoise from FF1&2 ROM): only if ff12Raw loaded
  if (ff12Raw) {
    bossFadeFrames = [];
    for (let step = 0; step <= LOAD_FADE_MAX; step++) {
      const normal = renderBossFaded(ff12Raw, step);
      const flipped = _hflipCanvas16(normal);
      bossFadeFrames.push([normal, flipped]);
    }
  }
}



// _pauseFadeStep → pause-menu.js
function _drawHudWithFade(fullCanvas, fadeCanvases, fadeStep) {
  if (fadeStep > 0 && fadeCanvases && fadeStep <= fadeCanvases.length) {
    ctx.drawImage(fadeCanvases[fadeStep - 1], 0, 0);
    ctx.save(); ctx.beginPath(); ctx.rect(0, HUD_BOT_Y, CANVAS_W, HUD_BOT_H); ctx.clip();
    ctx.drawImage(fullCanvas, 0, 0); ctx.restore();
  } else { ctx.drawImage(fullCanvas, 0, 0); }
}
function _encounterGridLayout() {
  const count = encounterMonsters.length;
  const { fullW, fullH, sprH } = _encounterBoxDims();
  const boxX = HUD_VIEW_X + Math.floor((HUD_VIEW_W - fullW) / 2);
  const boxY = HUD_VIEW_Y + Math.floor((HUD_VIEW_H - fullH) / 2);
  const gridPos = _encounterGridPos(boxX, boxY, fullW, fullH, count, sprH);
  return { count, boxX, boxY, sprH, fullW, fullH, gridPos };
}

function _grayViewport() {
  ctx.filter = 'saturate(0)';
  ctx.drawImage(ctx.canvas, HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H,
                            HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);
  ctx.filter = 'none'; ctx.restore();
}
// _pausePanelLayout → pause-menu.js
function _resetBattleVars() {
  inputSt.battleCursor = 0; battleMessage = null;
  bossDamageNum = null; playerDamageNum = null; playerHealNum = null; enemyHealNum = null;
  encounterDropItem = null; bossFlashTimer = 0; battleShakeTimer = 0;
  isDefending = false; battleAllies = []; allyJoinRound = 0;
  currentAllyAttacker = -1; allyTargetIndex = -1; allyHitResult = null; allyHitIsLeft = false;
  allyDamageNums = {}; allyShakeTimer = {}; enemyTargetAllyIdx = -1; allyExitTimer = 0;
  southWindTargets = []; southWindHitIdx = 0; southWindDmgNums = {};
  inputSt.battleProfHits = {};
}
function _zPressed() { if (!keys['z'] && !keys['Z']) return false; keys['z'] = false; keys['Z'] = false; return true; }
function _xPressed() { if (!keys['x'] && !keys['X']) return false; keys['x'] = false; keys['X'] = false; return true; }

function _landOnWorldMap(tileX, tileY) {
  worldX = tileX * TILE_SIZE; worldY = tileY * TILE_SIZE;
  disabledTrigger = { x: tileX, y: tileY };
  moving = false; sprite.setDirection(DIR_DOWN); sprite.resetFrame();
  playTrack(TRACKS.WORLD_MAP);
}

function _syncSaveSlotProgress() {
  if (!saveSlots[selectCursor]) return;
  saveSlots[selectCursor].level = ps.stats.level;
  saveSlots[selectCursor].exp = ps.stats.exp;
  saveSlots[selectCursor].stats = playerStatsSnapshot();
  saveSlots[selectCursor].inventory = { ...playerInventory };
  saveSlots[selectCursor].gil = ps.gil;
  saveSlots[selectCursor].proficiency = { ...ps.proficiency };
}
function returnToTitle() {
  _syncSaveSlotProgress();
  saveSlotsToDB();
  pauseSt.state = 'none';
  fadeOutFF1Music((HUD_INFO_FADE_STEPS + 1) * HUD_INFO_FADE_STEP_MS);
  clearMusicStash();
  transSt.state = 'hud-fade-out';
  transSt.timer = 0;
  transSt.pendingAction = () => { battleState = 'none'; hudInfoFadeTimer = HUD_INFO_FADE_STEPS * HUD_INFO_FADE_STEP_MS; _startTitleScreen(); };
}
/**
 * Set up top box state for a given area.
 * @param {number} mapId — map being loaded
 * @param {boolean} isWorldMap — true if entering world map
 */
function setupTopBox(mapId, isWorldMap) {
  if (isWorldMap) {
    const bgId = romRaw[BATTLE_BG_MAP_LOOKUP] & 0x1F;
    ({ bgCanvas: topBoxBgCanvas, fadeFrames: topBoxBgFadeFrames } = renderBattleBg(romRaw, bgId));
    topBoxMode = 'battle';
    topBoxSt.isTown = false;
    topBoxSt.nameBytes = null;
    topBoxSt.state = 'none';
    topBoxSt.fadeStep = TOPBOX_FADE_STEPS;
    return;
  }

  if (mapId >= 1000) {
    const romMap = (mapId === 1004) ? 148 : 111;
    const bgId = romRaw[BATTLE_BG_MAP_LOOKUP + romMap] & 0x1F;
    ({ bgCanvas: topBoxBgCanvas, fadeFrames: topBoxBgFadeFrames } = renderBattleBg(romRaw, bgId));
    loadingBgFadeFrames = topBoxBgFadeFrames;
    topBoxSt.nameBytes = DUNGEON_NAME;
    topBoxMode = 'battle';
    topBoxSt.isTown = false;
    topBoxSt.state = 'none';
    topBoxSt.fadeStep = TOPBOX_FADE_STEPS;
    return;
  }

  // Regular map
  if (mapId === 114) {
    if (!topBoxSt.isTown) {
      topBoxSt.state = 'pending';
    }
    topBoxSt.isTown = true;
    topBoxSt.nameBytes = AREA_NAMES.get(114);
    topBoxMode = 'name';
  } else if (!topBoxSt.isTown) {
    const bgId = romRaw[BATTLE_BG_MAP_LOOKUP + mapId] & 0x1F;
    ({ bgCanvas: topBoxBgCanvas, fadeFrames: topBoxBgFadeFrames } = renderBattleBg(romRaw, bgId));
    topBoxMode = 'battle';
  }
}

// Shared state objects passed to transitions.js functions
function _transShared() {
  return {
    sprite,
    keys,
    onShake: () => { shakeActive = true; shakeTimer = 0; },
  };
}
function _transDrawShared() {
  return { drawLoadingOverlay: _drawLoadingOverlay };
}
// Wrapper that pre-computes rosterLocChanged before calling transitions.js
function _triggerWipe(action, destMapId) {
  const rc = destMapId != null && _rosterLocForMapId(destMapId) !== getPlayerLocation();
  startWipeTransition(action, destMapId, rc);
}

// Shared state object passed to input-handler.js functions
function _inputShared() {
  return {
    keys,
    playerInventory,
    saveSlots,
    battleAllies,
    get battleState()          { return battleState; },
    set battleState(v)          { battleState = v; },
    get battleTimer()           { return battleTimer; },
    set battleTimer(v)          { battleTimer = v; },
    get isRandomEncounter()     { return isRandomEncounter; },
    get encounterMonsters()     { return encounterMonsters; },
    get encounterDropItem()     { return encounterDropItem; },
    get encounterProfLevelUps() { return encounterProfLevelUps; },
    get profLevelUpIdx()        { return profLevelUpIdx; },
    set profLevelUpIdx(v)       { profLevelUpIdx = v; },
    get shakeActive()           { return shakeActive; },
    get starEffect()            { return starEffect; },
    get moving()                { return moving; },
    get onWorldMap()            { return onWorldMap; },
    get dungeonFloor()          { return dungeonFloor; },
    get selectCursor()          { return selectCursor; },
    get isPVPBattle()           { return pvpSt.isPVPBattle; },
    get pvpOpponentStats()      { return pvpSt.pvpOpponentStats; },
    saveSlotsToDB,
    addItem,
    removeItem,
    getRosterVisible,
    getSlashFramesForWeapon,
    executeBattleCommand,
    returnToTitle,
    startPVPBattle: (target) => startPVPBattle(_pvpShared(), target),
  };
}

function _pauseShared() {
  return {
    playerInventory,
    saveSlots,
    selectCursor,
    cursorTileCanvas,
    rosterScroll: inputSt.rosterScroll,
    _drawBorderedBox,
    _clipToViewport,
    _drawCursorFaded,
  };
}

// Shared state object passed to pvp.js
function _pvpShared() {
  return {
    // ── Primitive game state (getters/setters so pvp always reads live values) ──
    get bossHP()                { return bossHP; },
    set bossHP(v)               { bossHP = v; },
    get bossDefeated()          { return bossDefeated; },
    set bossDefeated(v)         { bossDefeated = v; },
    get isRandomEncounter()     { return isRandomEncounter; },
    set isRandomEncounter(v)    { isRandomEncounter = v; },
    get preBattleTrack()        { return preBattleTrack; },
    set preBattleTrack(v)       { preBattleTrack = v; },
    get battleState()           { return battleState; },
    set battleState(v)          { battleState = v; },
    get battleTimer()           { return battleTimer; },
    set battleTimer(v)          { battleTimer = v; },
    get currentAttacker()       { return currentAttacker; },
    get encounterMonsters()     { return encounterMonsters; },
    get enemyTargetAllyIdx()    { return enemyTargetAllyIdx; },
    set enemyTargetAllyIdx(v)   { enemyTargetAllyIdx = v; },
    get playerDamageNum()       { return playerDamageNum; },
    set playerDamageNum(v)      { playerDamageNum = v; },
    get isDefending()           { return isDefending; },
    set isDefending(v)          { isDefending = v; },
    get battleShakeTimer()      { return battleShakeTimer; },
    set battleShakeTimer(v)     { battleShakeTimer = v; },
    get battleMessage()         { return battleMessage; },
    set battleMessage(v)        { battleMessage = v; },
    get allyJoinRound()         { return allyJoinRound; },
    set allyJoinRound(v)        { allyJoinRound = v; },
    get slashFrames()           { return slashFrames; },
    get slashFrame()            { return slashFrame; },
    get slashOffX()             { return slashOffX; },
    get slashOffY()             { return slashOffY; },
    get slashFramesR()          { return slashFramesR; },
    get currentHitIdx()         { return currentHitIdx; },
    get currentAllyAttacker()   { return currentAllyAttacker; },
    get allyHitResult()         { return allyHitResult; },
    // ── Array/object refs (getters so pvp always gets the live array) ─────────
    get battleAllies()          { return battleAllies; },
    get allyDamageNums()        { return allyDamageNums; },
    get allyShakeTimer()        { return allyShakeTimer; },
    ctx,
    // ── Weapon sprite canvases (stable after init) ────────────────────────────
    get blades() {
      return {
        knife:  { raised: battleKnifeBladeCanvas,  swung: battleKnifeBladeSwungCanvas },
        dagger: { raised: battleDaggerBladeCanvas, swung: battleDaggerBladeSwungCanvas },
        sword:  { raised: battleSwordBladeCanvas,  swung: battleSwordBladeSwungCanvas },
        fist:   battleFistCanvas,
      };
    },
    get fullBodyCanvases()          { return fakePlayerFullBodyCanvases; },
    get hitFullBodyCanvases()       { return fakePlayerHitFullBodyCanvases; },
    get knifeBackFullBodyCanvases()    { return fakePlayerKnifeBackFullBodyCanvases; },
    get knifeRFullBodyCanvases()       { return fakePlayerKnifeRFullBodyCanvases; },
    get knifeLFullBodyCanvases()       { return fakePlayerKnifeLFullBodyCanvases; },
    get knifeRFwdFullBodyCanvases()    { return fakePlayerKnifeRFwdFullBodyCanvases; },
    get knifeLFwdFullBodyCanvases()    { return fakePlayerKnifeLFwdFullBodyCanvases; },
    get kneelFullBodyCanvases()        { return fakePlayerKneelFullBodyCanvases; },
    get victoryFullBodyCanvases()      { return fakePlayerVictoryFullBodyCanvases; },
    get fakePlayerDeathFrames()        { return fakePlayerDeathFrames; },
    get defendSparkleFrames()          { return defendSparkleFrames; },
    get cureSparkleFrames()            { return cureSparkleFrames; },
    get swPhaseCanvases()              { return swPhaseCanvases; },
    get enemyHealNum()                 { return enemyHealNum; },
    set enemyHealNum(v)                { enemyHealNum = v; },
    advancePVPTargetOrVictory: _advancePVPTargetOrVictory,
    // ── Delegated update functions ────────────────────────────────────────────
    updateTimers:           (dt) => _updateBattleTimers(dt),
    handlePlayerAttack:     ()   => _updateBattlePlayerAttack(),
    handleDefendItem:       (dt) => _updateBattleDefendItem(dt),
    handleAlly:             ()   => _updateBattleAlly(),
    handleEndSequence:      (dt) => _updateBattleEndSequence(dt),
    tryJoinPlayerAlly:       ()  => _tryJoinPlayerAlly(),
    buildAndProcessNextTurn: ()  => { turnQueue = buildTurnOrder(); processNextTurn(); },
    // ── Other functions ───────────────────────────────────────────────────────
    resetBattleVars:     _resetBattleVars,
    processNextTurn,
    getPlayerLocation,
    getSlashFramesForWeapon,
    clipToViewport:  _clipToViewport,
    drawBorderedBox: _drawBorderedBox,
    drawText,
    measureText,
    nameToBytes: _nameToBytes,
    get cursorTileCanvas() { return cursorTileCanvas; },
    get sweatFrames() { return sweatFrames; },
  };
}

// Shared state object passed to map-triggers.js
function _triggerShared() {
  return {
    // read-only constants
    TILE_SIZE,
    BATTLE_FLASH_FRAMES,
    BATTLE_FLASH_FRAME_MS,
    // read-only primitives
    get worldX()            { return worldX; },
    get worldY()            { return worldY; },
    get currentMapId()      { return currentMapId; },
    get onWorldMap()        { return onWorldMap; },
    set onWorldMap(v)       { onWorldMap = v; },
    get disabledTrigger()   { return disabledTrigger; },
    set disabledTrigger(v)  { disabledTrigger = v; },
    get dungeonSeed()       { return dungeonSeed; },
    set dungeonSeed(v)      { dungeonSeed = v; },
    get mapRenderer()       { return mapRenderer; },
    set mapRenderer(v)      { mapRenderer = v; },
    get rockSwitch()        { return rockSwitch; },
    set rockSwitch(v)       { rockSwitch = v; },
    set shakeActive(v)      { shakeActive = v; },
    set shakeTimer(v)       { shakeTimer = v; },
    set shakePendingAction(v) { shakePendingAction = v; },
    set starEffect(v)       { starEffect = v; },
    set pondStrobeTimer(v)  { pondStrobeTimer = v; },
    // object refs (mutated, not reassigned)
    mapData,
    worldMapData,
    worldMapRenderer,
    mapStack,
    dungeonDestinations,
    hiddenTraps,
    secretWalls,
    // functions
    addItem,
    loadMapById,
    loadWorldMapAtPosition,
    loadWorldMapAt,
    _triggerWipe,
    _rebuildFlameSprites,
    _rosterLocForMapId,
    getPlayerLocation,
  };
}

// Shared state object passed to title-screen.js draw functions
function _titleShared() {
  return {
    waterTick,
    selectCursor,
    saveSlots,
    nameBuffer,
    nameMaxLen: NAME_MAX_LEN,
    battleSpriteCanvas,
    battleSpriteFadeCanvases,
    silhouetteCanvas,
    drawBorderedBox: _drawBorderedBox,
    drawCursorFaded: _drawCursorFaded,
  };
}

export function getMobileInputMode() {
  if (chatState.inputActive) return 'chat';
  if (titleSt.state === 'name-entry') return 'name';
  return 'none';
}

function _initSpriteAssets(romRaw) {
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
  swPhaseCanvases = initSouthWindSprite(); southWindHitCanvas = swPhaseCanvases[0];
  slashFrames = slashFramesR = slashFramesL = initSlashSprites();
  knifeSlashFramesR = knifeSlashFramesL = initKnifeSlashSprites();
  swordSlashFramesR = swordSlashFramesL = initSwordSlashSprites();
  initPlayerStats(romRaw);
  initExpTable(romRaw);
  initMoogleSprite(romRaw);
  initLoadingScreenFadeFrames(romRaw);
  initMusic(romRaw);
  _initFlameRawTiles(romRaw);
  _initStarTiles(romRaw);
}
function _initTitleAssets(romRaw) {
  initInvincibleSprite(romRaw);
  const _tw = initTitleWater(romRaw, TITLE_FADE_MAX); titleSt.waterFrames = _tw.titleWaterFrames; titleSt.waterFadeTiles = _tw.titleWaterFadeTiles;
  titleSt.skyFrames = initTitleSky(romRaw);
  titleSt.underwaterFrames = initTitleUnderwater(romRaw);
  titleSt.bubbleTiles = initUnderwaterSprites(romRaw).uwBubbleTiles;
  titleSt.oceanFrames = initTitleOcean(romRaw);
  titleSt.logoFrames = initTitleLogo();
}
function _startDebugMode() {
  titleSt.state = 'done';
  dungeonSeed = 1;
  clearDungeonCache();
  loadMapById(1004);
  playTrack(TRACKS.CRYSTAL_ROOM);
  playerInventory = {};
  addItem(0x54, 5);
  lastTime = performance.now();
  requestAnimationFrame(gameLoop);
}
function _startTitleScreen() {
  titleSt.state = 'credit-wait';
  titleSt.timer = 0;
  titleSt.waterScroll = 0;
  titleSt.shipTimer = 0;
  titleSt.pressZ = isMobile
    ? new Uint8Array([0x99,0xDB,0xCE,0xDC,0xDC,0xFF,0x8A])  // "Press A"
    : new Uint8Array([0x99,0xDB,0xCE,0xDC,0xDC,0xFF,0xA3]); // "Press Z"
  playTrack(TRACKS.TITLE_SCREEN);
  lastTime = performance.now();
  requestAnimationFrame(gameLoop);
}
export async function loadROM(arrayBuffer) {
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
  initTextDecoder(romRaw);
  initFont(romRaw);
  if (ff12Raw) initProfIcons(romRaw, ff12Raw);

  _initSpriteAssets(romRaw);
  sprite = new Sprite(romRaw, SPRITE_PAL_TOP, SPRITE_PAL_BTM);
  worldMapData = loadWorldMap(romRaw, 0);
  worldMapRenderer = new WorldMapRenderer(worldMapData);
  resetWorldWaterCache();
  _initTitleAssets(romRaw);

  await loadSlotsFromDB();

  if (window.DEBUG_BOSS) { _startDebugMode(); return; }
  _startTitleScreen();
}

export function loadFF12ROM(arrayBuffer) {
  ff12Raw = new Uint8Array(arrayBuffer);
  initAdamantoise(ff12Raw);
  initFF1Music(ff12Raw);
  if (romRaw) initProfIcons(romRaw, ff12Raw);
  if (romRaw) initLoadingScreenFadeFrames(romRaw); // rebuild with boss fade frames
}

function _calcSpawnY(ex, ey) {
  // Calculate the correct spawn Y for a non-dungeon map entrance.
  // Returns the adjusted startY (startX stays = ex).
  const eMid = mapData.tilemap[ey * 32 + ex];
  const eM = eMid < 128 ? eMid : eMid & 0x7F;
  const eColl = mapData.collision[eM];
  if ((eColl & 0x07) === 3) {
    // Wall tile — scan north for door $44, then fallback south/north for passable
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
  // Passable entrance — door $44 stays, exit_prev scans north for inner door
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
  // If returning to a door tile, show it open until player walks off
  openDoor = null;
  const trig = mapRenderer.getTriggerAt(playerX, playerY);
  if (trig && trig.source === 'dynamic' && trig.type === 1) {
    const origTileId = mapData.tilemap[playerY * 32 + playerX];
    const origM = origTileId < 128 ? origTileId : origTileId & 0x7F;
    if (((mapData.collisionByte2[origM] >> 4) & 0x0F) === 5) {
      mapRenderer.updateTileAt(playerX, playerY, 0x7E);
      openDoor = { x: playerX, y: playerY, tileId: origTileId };
    }
  }
}

function _loadDungeonFloor(mapId, returnX, returnY) {
  const floorIndex = mapId - 1000;
  dungeonFloor = floorIndex;
  const result = generateFloor(romRaw, floorIndex, dungeonSeed);
  mapData = result;
  secretWalls = result.secretWalls; falseWalls = result.falseWalls;
  hiddenTraps = result.hiddenTraps; rockSwitch = result.rockSwitch || null;
  warpTile = result.warpTile || null; pondTiles = result.pondTiles || null;
  dungeonDestinations = result.dungeonDestinations;
  currentMapId = mapId;
  const playerX = returnX !== undefined ? returnX : result.entranceX;
  const playerY = returnY !== undefined ? returnY : result.entranceY;
  worldX = playerX * TILE_SIZE; worldY = playerY * TILE_SIZE;
  mapRenderer = new MapRenderer(mapData, playerX, playerY); resetIndoorWaterCache();
  _flameSprites = [];
  bossSprite = (floorIndex === 4 && adamantoiseFrames && !bossDefeated)
    ? { frames: adamantoiseFrames, px: 6 * TILE_SIZE, py: 8 * TILE_SIZE } : null;
  disabledTrigger = { x: playerX, y: playerY };
  moving = false; sprite.setDirection(DIR_DOWN); sprite.resetFrame();
  if (floorIndex === 4) playTrack(TRACKS.CRYSTAL_ROOM);
  if (returnX !== undefined) _openReturnDoor(playerX, playerY);
}

function _loadRegularMap(mapId, returnX, returnY) {
  dungeonFloor = -1; encounterSteps = 0; dungeonDestinations = null;
  secretWalls = null; falseWalls = null; hiddenTraps = null;
  rockSwitch = null; warpTile = null; pondTiles = null; bossSprite = null;
  mapData = loadMap(romRaw, mapId);
  currentMapId = mapId;
  if (returnX !== undefined) applyPassage(mapData.tilemap);
  const ex = mapData.entranceX; const ey = mapData.entranceY;
  const playerX = returnX !== undefined ? returnX : ex;
  const playerY = returnY !== undefined ? returnY : _calcSpawnY(ex, ey);
  worldX = playerX * TILE_SIZE; worldY = playerY * TILE_SIZE;
  mapRenderer = new MapRenderer(mapData, playerX, playerY); resetIndoorWaterCache();
  if (mapRenderer.hasRoomClip()) {
    const spawnMid = mapData.tilemap[playerY * 32 + playerX];
    disabledTrigger = (spawnMid === 0x44 || playerY !== ey) ? { x: playerX, y: playerY } : null;
  } else { disabledTrigger = null; }
  _rebuildFlameSprites();
  moving = false; sprite.setDirection(DIR_DOWN); sprite.resetFrame();
  if (returnX !== undefined) _openReturnDoor(playerX, playerY);
  if (mapId === 114 && transSt.pendingTrack == null) playTrack(TRACKS.TOWN_UR);
}

function loadMapById(mapId, returnX, returnY) {
  onWorldMap = false;
  setupTopBox(mapId, false);
  if (mapId >= 1000) { _loadDungeonFloor(mapId, returnX, returnY); return; }
  _loadRegularMap(mapId, returnX, returnY);
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
  _landOnWorldMap(tileX, tileY);
}

function loadWorldMapAtPosition(tileX, tileY) {
  onWorldMap = true;
  dungeonFloor = -1;
  encounterSteps = 0;
  bossDefeated = false;  // boss respawns on dungeon re-entry
  mapRenderer = null;
  mapData = null;
  setupTopBox(0, true);

  _landOnWorldMap(tileX, tileY);
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
    if (onWorldMap && tileX === 95 && tileY === 45) {
      showMsgBox(new Uint8Array([0x8C,0xD8,0xD6,0xD2,0xD7,0xD0,0xFF,0x9C,0xD8,0xD8,0xD7,0xC4])); // "Coming Soon!"
    }
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


// _battleTargetNav…_handlePauseInput → input-handler.js


function handleInput() {
  if (!sprite) return;
  if (handleBattleInput(_inputShared())) return;
  if (handleRosterInput(_inputShared())) return;
  if (handlePauseInput(_inputShared())) return;

  // Universal message box — Z to dismiss during hold
  if (msgState.state !== 'none') {
    if (msgState.state === 'hold' && (keys['z'] || keys['Z'])) {
      keys['z'] = false; keys['Z'] = false;
      msgState.state = 'slide-out'; msgState.timer = 0;
    }
    return;
  }

  if (moving) return;
  if (transSt.state !== 'none') return;
  if (shakeActive) return;
  if (starEffect) return;
  if (chatState.expanded) return;

  if (keys['z'] || keys['Z']) {
    keys['z'] = false;
    keys['Z'] = false;
    handleAction();
    return;
  }

  _startMoveFromKeys();
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
    openPassage(_triggerShared());
    return;
  }

  if (facedTile === 0x7C)                                         { handleChest(facedX, facedY, _triggerShared()); return; }
  if (secretWalls && secretWalls.has(`${facedX},${facedY}`))      { handleSecretWall(facedX, facedY, _triggerShared()); return; }
  if (rockSwitch && rockSwitch.rocks.some(r => facedX === r.x && facedY === r.y)) { handleRockPuzzle(_triggerShared()); return; }
  if (pondTiles && pondTiles.has(`${facedX},${facedY}`))          { handlePondHeal(_triggerShared()); return; }
}

// _handleChest, _handleSecretWall, _handleRockPuzzle, _handlePondHeal,
// applyPassage, openPassage → map-triggers.js

function updateMovement(dt) {
  if (!moving) return;

  moveTimer += dt;
  const t = Math.min(moveTimer / WALK_DURATION, 1);

  worldX = moveStartX + (moveTargetX - moveStartX) * t;
  worldY = moveStartY + (moveTargetY - moveStartY) * t;

  sprite.setWalkProgress(t);

  if (t >= 1) _onMoveComplete();
}

function _tickRandomEncounter() {
  if (battleState !== 'none') return false;
  const inDungeon = dungeonFloor >= 0 && dungeonFloor < 4;
  const onGrass = onWorldMap && worldMapRenderer && (() => {
    const tileX = Math.floor(worldX / TILE_SIZE);
    const tileY = Math.floor(worldY / TILE_SIZE);
    return !worldMapRenderer.getTriggerAt(tileX, tileY);
  })();
  if (!inDungeon && !onGrass) return false;
  encounterSteps++;
  const threshold = onGrass
    ? 20 + Math.floor(Math.random() * 20)
    : 15 + Math.floor(Math.random() * 15);
  if (encounterSteps >= threshold) {
    encounterSteps = 0;
    startRandomEncounter();
    return true;
  }
  return false;
}

function _checkFalseWall() {
  if (!falseWalls || falseWalls.size === 0) return false;
  const key = `${worldX / TILE_SIZE},${worldY / TILE_SIZE}`;
  if (!falseWalls.has(key)) return false;
  const dest = falseWalls.get(key);
  _triggerWipe(() => {
    worldX = dest.destX * TILE_SIZE;
    worldY = dest.destY * TILE_SIZE;
    sprite.setDirection(DIR_DOWN);
    mapRenderer = new MapRenderer(mapData, dest.destX, dest.destY); resetIndoorWaterCache();
  });
  return true;
}

function _checkWarpTile() {
  if (!warpTile) return false;
  const tx = worldX / TILE_SIZE;
  const ty = worldY / TILE_SIZE;
  if (tx !== warpTile.x || ty !== warpTile.y) return false;
  sprite.setDirection(DIR_DOWN);
  playSFX(SFX.WARP);
  starEffect = {
    frame: 0, radius: 60, angle: 0, spin: true,
    onComplete: () => {
      _triggerWipe(() => {
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
  return true;
}

function _onMoveComplete() {
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

  if (_checkFalseWall()) return;
  if (_checkWarpTile()) return;

  // Check for trigger at current tile
  if (checkTrigger(_triggerShared())) return;

  if (_tickRandomEncounter()) return;

  _startMoveFromKeys(true);
}

// startWipeTransition, updateTransition, _updateTransition*, updateTopBoxScroll, drawTransitionOverlay → transitions.js

// Loading screen NES-encoded text constants
const _LOADING_BYTES = new Uint8Array([0x95,0xD8,0xCA,0xCD,0xD2,0xD7,0xD0,0xFF,0x8D,0xDE,0xD7,0xD0,0xCE,0xD8,0xD7]);
const _LOADED_BYTES  = new Uint8Array([0x8D,0xDE,0xD7,0xD0,0xCE,0xD8,0xD7,0xFF,0x95,0xD8,0xCA,0xCD,0xCE,0xCD]);
const _FLOORS_BYTES  = new Uint8Array([0x84,0xFF,0x95,0xCE,0xDF,0xCE,0xD5,0xDC]);
const _LODHP_BYTES   = new Uint8Array([0x91,0x99,0xFF,0xC5,0xC5,0xC5,0xC5,0xC5]);
function _drawLoadingBG(vpTop, fadeLevel) {
  if (!loadingBgFadeFrames || loadingBgFadeFrames.length === 0) return;
  const bgCanvas = loadingBgFadeFrames[Math.min(fadeLevel, loadingBgFadeFrames.length - 1)];
  const scrollX = Math.floor(loadingSt.bgScroll) % 256;
  ctx.save();
  ctx.beginPath(); ctx.rect(HUD_VIEW_X, vpTop, HUD_VIEW_W, 32); ctx.clip();
  ctx.drawImage(bgCanvas, HUD_VIEW_X - scrollX, vpTop);
  ctx.drawImage(bgCanvas, HUD_VIEW_X - scrollX + 256, vpTop);
  ctx.restore();
}
function _drawLoadingInfoBox(cx, vpTop, vpBot, fadeLevel, fadedTextPal) {
  const hpW = measureText(_LODHP_BYTES);
  const bossRowW = 16 + 4 + hpW;
  const infoBoxW = Math.ceil(Math.max(bossRowW + 16, 80) / 8) * 8;
  const infoBoxH = 48;
  const infoBoxX = Math.round(cx - infoBoxW / 2);
  const infoBoxY = Math.round(vpTop + (vpBot - vpTop) / 2 - infoBoxH / 2);
  if (borderFadeSets && fadeLevel < borderFadeSets.length)
    _drawBoxOnCtx(ctx, borderFadeSets[fadeLevel], infoBoxX, infoBoxY, infoBoxW, infoBoxH);
  const floorsW = measureText(_FLOORS_BYTES);
  drawText(ctx, infoBoxX + Math.floor((infoBoxW - floorsW) / 2), infoBoxY + 10, _FLOORS_BYTES, fadedTextPal);
  const bossContentX = infoBoxX + Math.floor((infoBoxW - bossRowW) / 2);
  const bossRowY = infoBoxY + 22;
  if (bossFadeFrames) ctx.drawImage(bossFadeFrames[fadeLevel][Math.floor(transSt.timer / 400) & 1], bossContentX, bossRowY);
  else if (adamantoiseFrames) ctx.drawImage(adamantoiseFrames[0], bossContentX, bossRowY);
  drawText(ctx, bossContentX + 20, bossRowY + 4, _LODHP_BYTES, fadedTextPal);
}
function _drawLoadingOverlay() {
  let fadeLevel = 0;
  if (loadingSt.state === 'in') fadeLevel = LOAD_FADE_MAX - Math.min(Math.floor(loadingSt.timer / LOAD_FADE_STEP_MS), LOAD_FADE_MAX);
  else if (loadingSt.state === 'out') fadeLevel = Math.min(Math.floor(loadingSt.timer / LOAD_FADE_STEP_MS), LOAD_FADE_MAX);
  else if (loadingSt.state !== 'visible') fadeLevel = LOAD_FADE_MAX;
  const fadedTextPal = TEXT_WHITE.map((c, i) => {
    if (i === 0) return c;
    let fc = c; for (let s = 0; s < fadeLevel; s++) fc = nesColorFade(fc); return fc;
  });
  const vpTop = HUD_VIEW_Y, vpBot = vpTop + HUD_VIEW_H;
  const cx = HUD_VIEW_X + HUD_VIEW_W / 2;
  _drawLoadingBG(vpTop, fadeLevel);
  _drawLoadingInfoBox(cx, vpTop, vpBot, fadeLevel, fadedTextPal);
  const promptBytes = isMobile
    ? new Uint8Array([0x99,0xDB,0xCE,0xDC,0xDC,0xFF,0x8A])
    : new Uint8Array([0x99,0xDB,0xCE,0xDC,0xDC,0xFF,0xA3]);
  if (loadingSt.state === 'in') {
    drawText(ctx, cx - measureText(_LOADING_BYTES) / 2, vpBot - 32, _LOADING_BYTES, fadedTextPal);
  } else if (loadingSt.state === 'visible') {
    drawText(ctx, cx - measureText(_LOADED_BYTES) / 2, vpBot - 32, _LOADED_BYTES, fadedTextPal);
    if (Math.floor(transSt.timer / 500) % 2 === 0)
      drawText(ctx, cx - measureText(promptBytes) / 2, vpBot - 20, promptBytes, fadedTextPal);
  } else if (loadingSt.state === 'out') {
    drawText(ctx, cx - measureText(_LOADED_BYTES) / 2, vpBot - 32, _LOADED_BYTES, fadedTextPal);
  }
}

// findWorldExitIndex, _checkWorldMapTrigger, _checkHiddenTrap, _triggerMapTransition,
// _checkDynType1, _checkDynType4, _checkExitPrev, checkTrigger → map-triggers.js

function _startMoveFromKeys(resetOnIdle) {
  if (keys['ArrowDown']) startMove(DIR_DOWN);
  else if (keys['ArrowUp']) startMove(DIR_UP);
  else if (keys['ArrowLeft']) startMove(DIR_LEFT);
  else if (keys['ArrowRight']) startMove(DIR_RIGHT);
  else if (resetOnIdle) sprite.resetFrame();
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
    const [c, cctx] = _makeCanvas16ctx();
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
function _buildNpcPalIdxMap() {
  const npcPalIdx = new Map();
  if (mapData.npcs) {
    for (const npc of mapData.npcs) {
      if (!_flameRawTiles.has(npc.id) || npcPalIdx.has(npc.id)) continue;
      npcPalIdx.set(npc.id, ((npc.flags >> 2) & 3) >= 2 ? 1 : 0);
    }
  }
  if (!npcPalIdx.has(193)) npcPalIdx.set(193, 0);
  if (!npcPalIdx.has(194)) npcPalIdx.set(194, 1);
  return npcPalIdx;
}

function _buildFlameCanvas(rawFrames, rgbPal) {
  const canvases = [];
  const offsets = [[0, 0], [8, 0], [0, 8], [8, 8]];
  for (const tiles of rawFrames) {
    const c = _makeCanvas16();
    const fctx = c.getContext('2d'); const img = fctx.createImageData(16, 16); const d = img.data;
    for (let q = 0; q < 4; q++) {
      const tile = tiles[q]; const [ox, oy] = offsets[q];
      for (let py = 0; py < 8; py++) {
        for (let px = 0; px < 8; px++) {
          const ci = tile[py * 8 + px]; const di = ((oy + py) * 16 + (ox + px)) * 4;
          if (ci === 0) { d[di + 3] = 0; }
          else { const rgb = rgbPal[ci]; d[di] = rgb[0]; d[di+1] = rgb[1]; d[di+2] = rgb[2]; d[di+3] = 255; }
        }
      }
    }
    fctx.putImageData(img, 0, 0); canvases.push(c);
  }
  return canvases;
}

function _renderFlameFrames() {
  if (!_flameRawTiles || !mapData || !mapData.spritePalettes) return;
  _flameFrames = new Map();
  const sp = mapData.spritePalettes;
  const npcPalIdx = _buildNpcPalIdxMap();
  for (const [id, rawFrames] of _flameRawTiles) {
    const rgbPal = sp[npcPalIdx.get(id) || 0].map(ci => NES_SYSTEM_PALETTE[ci & 0x3F]);
    _flameFrames.set(id, _buildFlameCanvas(rawFrames, rgbPal));
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




function _renderSprites(camX, camY, originX, originY, spriteY) {
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
  // Boss sprite (crystal room) — blink on hit
  if (bossSprite) {
    const blinkHidden = bossFlashTimer > 0 && (Math.floor(bossFlashTimer / 60) & 1);
    if (!blinkHidden) {
      const wLeft = camX - originX;
      const wTop = camY - originY;
      const bx = bossSprite.px - wLeft;
      const by = bossSprite.py - wTop;
      if (bx > -16 && bx < CANVAS_W && by > -16 && by < CANVAS_H) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(bossSprite.frames[Math.floor(waterTick / 8) & 1], bx, by);
      }
    }
  }
  if (sprite) sprite.draw(ctx, SCREEN_CENTER_X, spriteY);
}

function _renderMapAndWater(camX, camY, originX, originY, spriteY) {
  if (onWorldMap && worldMapRenderer) {
    worldMapRenderer.draw(ctx, camX, camY, originX, originY);
    _updateWorldWater(worldMapRenderer, waterTick);
  } else if (mapRenderer) {
    mapRenderer.draw(ctx, camX, camY, originX, originY);
    _updateIndoorWater(mapRenderer, waterTick);
  }
  if (transSt.state === 'none' &&
      (battleState === 'none' || battleState === 'flash-strobe' || battleState.startsWith('roar-'))) {
    _renderSprites(camX, camY, originX, originY, spriteY);
  }
  if (onWorldMap && worldMapRenderer) {
    worldMapRenderer.drawOverlay(ctx, camX, camY, originX, originY, SCREEN_CENTER_X, spriteY);
  } else if (mapRenderer) {
    mapRenderer.drawOverlay(ctx, camX, camY, originX, originY, SCREEN_CENTER_X, spriteY);
  }
}
function _renderStarSpiral() {
  if (!starEffect || !_starTiles) return;
  const { radius, angle, frame } = starEffect;
  const tile = _starTiles[(frame >> 4) & 1];
  for (let i = 0; i < 8; i++) {
    const a = angle + i * Math.PI / 4;
    ctx.drawImage(tile,
      Math.round(SCREEN_CENTER_X + 8 + radius * Math.cos(a) - 8),
      Math.round(SCREEN_CENTER_Y + 8 + radius * Math.sin(a) - 8));
  }
}
function render() {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  let camX = Math.round(worldX);
  const camY = Math.round(worldY);
  if (shakeActive) camX += (Math.floor(shakeTimer / (1000 / 60)) & 2) ? 2 : -2;
  if (battleShakeTimer > 0) camX += (Math.floor(battleShakeTimer / (1000 / 60)) & 2) ? 2 : -2;

  _clipToViewport();
  try {
    _renderMapAndWater(camX, camY, SCREEN_CENTER_X, SCREEN_CENTER_Y + 3, SCREEN_CENTER_Y);
    _renderStarSpiral();
  } finally {
    ctx.restore();
  }
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

function _drawTopBoxBattleBG() {
  const topShake = (battleState === 'enemy-attack' && battleShakeTimer > 0)
    ? (Math.floor(battleShakeTimer / 67) & 1 ? 2 : -2) : 0;
  if (transSt.state !== 'loading' && !topBoxSt.isTown && topBoxBgCanvas) {
    ctx.drawImage(topBoxBgCanvas, topShake, 0);
  }
  if (!topBoxSt.isTown && topBoxBgFadeFrames && transSt.state !== 'none' && transSt.state !== 'door-opening' && transSt.state !== 'loading') {
    const maxStep = topBoxBgFadeFrames.length - 1;
    const FADE_STEP_MS = 100;
    let fadeStep = 0;
    if (transSt.state === 'closing') {
      fadeStep = Math.min(Math.floor(transSt.timer / FADE_STEP_MS), maxStep);
    } else if (transSt.state === 'hold' || transSt.state === 'trap-falling') {
      fadeStep = maxStep;
    } else if (transSt.state === 'opening') {
      if (transSt.topBoxAlreadyBright) fadeStep = 0; // came from hud-fade-in, already bright
      else fadeStep = Math.max(maxStep - Math.floor(transSt.timer / FADE_STEP_MS), 0);
    } else if (transSt.state === 'hud-fade-in') {
      fadeStep = Math.max(maxStep - Math.floor(hudInfoFadeTimer / HUD_INFO_FADE_STEP_MS), 0);
    }
    if (fadeStep > 0) ctx.drawImage(topBoxBgFadeFrames[fadeStep], 0, 0);
  }
  if (!topBoxSt.isTown && transSt.state !== 'loading') roundTopBoxCorners();
}
function _drawTopBoxOverlay(isFading) {
  if (transSt.state === 'loading') {
    let loadFade = LOAD_FADE_MAX;
    if (loadingSt.state === 'in') {
      loadFade = LOAD_FADE_MAX - Math.min(Math.floor(loadingSt.timer / LOAD_FADE_STEP_MS), LOAD_FADE_MAX);
    } else if (loadingSt.state === 'visible') {
      loadFade = 0;
    } else if (loadingSt.state === 'out') {
      loadFade = Math.min(Math.floor(loadingSt.timer / LOAD_FADE_STEP_MS), LOAD_FADE_MAX);
    }
    drawTopBoxBorder(loadFade);
    if (topBoxSt.nameBytes && !isFading) {
      const fadedPal = _makeFadedPal(loadFade);
      const tw = measureText(topBoxSt.nameBytes);
      drawText(ctx, 8 + Math.floor((240 - tw) / 2), 12, topBoxSt.nameBytes, fadedPal);
    }
  } else if (topBoxSt.isTown && topBoxMode === 'name' && topBoxSt.nameBytes) {
    if (isFading) drawTopBoxBorder(topBoxSt.fadeStep);
    else if (topBoxSt.state !== 'pending') drawTopBoxBorder(0);
    if (!isFading && topBoxSt.state !== 'pending') {
      const tw = measureText(topBoxSt.nameBytes);
      drawText(ctx, 8 + Math.floor((240 - tw) / 2), 12, topBoxSt.nameBytes, TEXT_WHITE);
    }
  }
  if (isFading && topBoxSt.nameBytes) {
    if (transSt.state !== 'loading' && !topBoxSt.isTown) drawTopBoxBorder(topBoxSt.fadeStep);
    const fadedPal = _makeFadedPal(topBoxSt.fadeStep);
    const tw = measureText(topBoxSt.nameBytes);
    drawText(ctx, 8 + Math.floor((240 - tw) / 2), 12, topBoxSt.nameBytes, fadedPal);
  }
}
function _drawHUDTopBox() {
  const isFading = topBoxSt.state === 'fade-in' || topBoxSt.state === 'display' || topBoxSt.state === 'fade-out';
  _drawTopBoxBattleBG();
  _drawTopBoxOverlay(isFading);
}

function _drawPortraitImage(px, py, nfPortrait, isPauseHeal, infoFadeStep) {
  if (infoFadeStep >= HUD_INFO_FADE_STEPS) return;
  if (infoFadeStep > 0) {
    const fadeSets = nfPortrait === battleSpriteKneelCanvas ? battleSpriteKneelFadeCanvases
                   : nfPortrait === battleSpriteDefendCanvas ? battleSpriteDefendFadeCanvases
                   : battleSpriteFadeCanvases;
    if (fadeSets) { ctx.drawImage(fadeSets[infoFadeStep - 1], px, py); return; }
  }
  ctx.drawImage(nfPortrait, px, py);
  if (!isPauseHeal && nfPortrait === battleSpriteKneelCanvas && sweatFrames.length === 2)
    ctx.drawImage(sweatFrames[Math.floor(Date.now() / 133) & 1], px, py - 3);
}
function _drawCureSparkle(px, py, isPauseHeal) {
  if (!isPauseHeal || cureSparkleFrames.length !== 2 || (pauseSt.healNum && pauseSt.healNum.rosterIdx >= 0)) return;
  const frame = cureSparkleFrames[Math.floor(pauseSt.timer / 67) & 1];
  ctx.drawImage(frame, px - 8, py - 7);
  ctx.save(); ctx.scale(-1,  1); ctx.drawImage(frame, -(px + 23),  py - 7);  ctx.restore();
  ctx.save(); ctx.scale( 1, -1); ctx.drawImage(frame,   px - 8,  -(py + 24)); ctx.restore();
  ctx.save(); ctx.scale(-1, -1); ctx.drawImage(frame, -(px + 23), -(py + 24)); ctx.restore();
}
function _drawPauseHealNum(px, py) {
  if (!pauseSt.healNum || pauseSt.healNum.rosterIdx >= 0) return;
  _drawBattleNum(px + 8, _dmgBounceY(py + 8, pauseSt.healNum.timer), pauseSt.healNum.value, [0x0F, 0x0F, 0x0F, 0x2B]);
}
function _drawHUDPortrait() {
  const infoFadeStep = HUD_INFO_FADE_STEPS - Math.min(Math.floor(hudInfoFadeTimer / HUD_INFO_FADE_STEP_MS), HUD_INFO_FADE_STEPS);
  if (battleState !== 'none' || !battleSpriteCanvas) return;
  const isPauseHeal = pauseSt.state === 'inv-heal';
  const nfPortrait = isPauseHeal && battleSpriteDefendCanvas ? battleSpriteDefendCanvas
    : (ps.hp > 0 && ps.stats && ps.hp <= Math.floor(ps.stats.maxHP / 4) && battleSpriteKneelCanvas
       ? battleSpriteKneelCanvas : battleSpriteCanvas);
  const px = HUD_RIGHT_X + 8, py = HUD_VIEW_Y + 8;
  _drawPortraitImage(px, py, nfPortrait, isPauseHeal, infoFadeStep);
  _drawCureSparkle(px, py, isPauseHeal);
  _drawPauseHealNum(px, py);
}

function _drawHUDInfoPanel() {
  // Name + Level in right mini-right panel (right-aligned, like roster players)
  const infoFadeStep = HUD_INFO_FADE_STEPS - Math.min(Math.floor(hudInfoFadeTimer / HUD_INFO_FADE_STEP_MS), HUD_INFO_FADE_STEPS);
  if (infoFadeStep >= HUD_INFO_FADE_STEPS) return;
  const shakeOff = (battleState === 'enemy-attack' && battleShakeTimer > 0)
    ? (Math.floor(battleShakeTimer / 67) & 1 ? 2 : -2) : 0;
  const sy = HUD_VIEW_Y + 8;
  const panelRight = HUD_RIGHT_X + HUD_RIGHT_W - 8 + shakeOff;
  const slot = saveSlots[selectCursor];
  if (!slot) return;
  // Name — NES palette fade toward black for game-start fade-in
  const namePal = [...TEXT_WHITE];
  for (let s = 0; s < infoFadeStep; s++) namePal[3] = nesColorFade(namePal[3]);
  const nameW = measureText(slot.name);
  drawText(ctx, panelRight - nameW, sy, slot.name, namePal);
  // Level fades out as battle starts, HP fades in — combined with game-start infoFadeStep
  if (hudHpLvStep < 4) {
    const lvLabel = _nameToBytes('Lv' + String(ps.stats ? ps.stats.level : slot.level));
    const lvPal = [0x0F, 0x0F, 0x0F, 0x10];
    for (let s = 0; s < hudHpLvStep + infoFadeStep; s++) lvPal[3] = nesColorFade(lvPal[3]);
    const lvW = measureText(lvLabel);
    drawText(ctx, panelRight - lvW, sy + 9, lvLabel, lvPal);
  }
  if (hudHpLvStep > 0) {
    const maxHP = ps.stats ? ps.stats.maxHP : 28;
    const hpNes = ps.hp <= Math.floor(maxHP / 4) ? 0x16
                : ps.hp <= Math.floor(maxHP / 2) ? 0x28 : 0x2A;
    const hpPal = [0x0F, 0x0F, 0x0F, hpNes];
    for (let s = 0; s < (4 - hudHpLvStep) + infoFadeStep; s++) hpPal[3] = nesColorFade(hpPal[3]);
    const hpLabel = _nameToBytes(String(ps.hp));
    const hpW = measureText(hpLabel);
    drawText(ctx, panelRight - hpW, sy + 9, hpLabel, hpPal);
  }
}

function _drawLoadingRightPanel(fadeLevel) {
  const tiles = (borderFadeSets && borderFadeSets[fadeLevel]) || borderTileCanvases;
  if (!tiles) return;
  const [TL, TOP, TR, LEFT, RIGHT, BL, BOT, BR, FILL] = tiles;
  const lx = HUD_RIGHT_X, ly = HUD_VIEW_Y + 32, lw = HUD_RIGHT_W, lh = HUD_VIEW_H - 32;
  ctx.drawImage(TL, lx, ly); ctx.drawImage(TR, lx+lw-8, ly);
  ctx.drawImage(BL, lx, ly+lh-8); ctx.drawImage(BR, lx+lw-8, ly+lh-8);
  for (let tx = lx+8; tx < lx+lw-8; tx += 8) { ctx.drawImage(TOP, tx, ly); ctx.drawImage(BOT, tx, ly+lh-8); }
  for (let ty = ly+8; ty < ly+lh-8; ty += 8) { ctx.drawImage(LEFT, lx, ty); ctx.drawImage(RIGHT, lx+lw-8, ty); }
  for (let ty = ly+8; ty < ly+lh-8; ty += 8) for (let tx = lx+8; tx < lx+lw-8; tx += 8) ctx.drawImage(FILL, tx, ty);
}
function _drawLoadingChatBubble(rpCX, rpY, rpH, fadeLevel) {
  const beatBytes = new Uint8Array([0x8B,0xCE,0xCA,0xDD,0xFF,0xDD,0xD1,0xCE]);
  const bossBytes = new Uint8Array([0x8B,0xD8,0xDC,0xDC,0xFF,0x94,0xDE,0xD9,0xD8,0xC4]);
  let fadedWhite = 0x30;
  for (let s = 0; s < fadeLevel; s++) fadedWhite = nesColorFade(fadedWhite);
  const whiteRgb = NES_SYSTEM_PALETTE[fadedWhite] || [0,0,0];
  ctx.fillStyle = `rgb(${whiteRgb[0]},${whiteRgb[1]},${whiteRgb[2]})`;
  const bgW = Math.max(measureText(beatBytes), measureText(bossBytes)) + 6;
  const bubbleX = Math.round(rpCX - bgW / 2);
  const bubbleY = rpY + Math.floor((rpH - (22 + 5 + 16)) / 2);
  ctx.beginPath(); ctx.roundRect(bubbleX, bubbleY, bgW, 22, 4); ctx.fill();
  const triCX = Math.round(bubbleX + bgW / 2);
  ctx.beginPath();
  ctx.moveTo(triCX-4, bubbleY+22); ctx.lineTo(triCX, bubbleY+27); ctx.lineTo(triCX+4, bubbleY+22);
  ctx.fill();
  const blackTextPal = [0x0F, fadedWhite, fadedWhite, 0x0F];
  drawText(ctx, bubbleX+3, bubbleY+2,  beatBytes, blackTextPal);
  drawText(ctx, bubbleX+3, bubbleY+12, bossBytes, blackTextPal);
  return bubbleY;
}
function _drawLoadingMoogleSprite(moogleX, moogleY, fadeLevel) {
  if (!moogleFadeFrames) return;
  ctx.drawImage(moogleFadeFrames[fadeLevel][Math.floor(transSt.timer / 400) & 1], moogleX, moogleY);
}
function _drawHUDLoadingMoogle() {
  let fadeLevel = 0;
  if (loadingSt.state === 'in') fadeLevel = LOAD_FADE_MAX - Math.min(Math.floor(loadingSt.timer / LOAD_FADE_STEP_MS), LOAD_FADE_MAX);
  else if (loadingSt.state === 'out') fadeLevel = Math.min(Math.floor(loadingSt.timer / LOAD_FADE_STEP_MS), LOAD_FADE_MAX);
  _drawLoadingRightPanel(fadeLevel);
  const rpCX = HUD_RIGHT_X + Math.floor(HUD_RIGHT_W / 2);
  const bubbleY = _drawLoadingChatBubble(rpCX, HUD_VIEW_Y + 32, HUD_VIEW_H - 32, fadeLevel);
  _drawLoadingMoogleSprite(Math.round(rpCX - 8), bubbleY + 30, fadeLevel);
}

function drawHUD() {
  const isTitleActive = titleSt.state !== 'done';
  if (isTitleActive && titleHudCanvas) {
    // Compute border fade level for title states
    let tfl = 0; // 0 = full brightness — only fade out when leaving title
    if (titleSt.state === 'main-out') {
      tfl = Math.min(Math.floor(titleSt.timer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
    }
    _drawHudWithFade(titleHudCanvas, titleHudFadeCanvases, tfl);
  } else if (hudCanvas) {
    const fadeStep = HUD_INFO_FADE_STEPS - Math.min(Math.floor(hudInfoFadeTimer / HUD_INFO_FADE_STEP_MS), HUD_INFO_FADE_STEPS);
    _drawHudWithFade(hudCanvas, hudFadeCanvases, fadeStep);
  }

  // Top box content (full 256×32, no static border — border only with text)
  // Title screen handles its own top box (sky BG)
  if (titleSt.state !== 'done') return;

  _drawHUDTopBox();
  _drawHUDPortrait();
  _drawHUDInfoPanel();
  if (transSt.state === 'loading' && loadingSt.state !== 'none') {
    _drawHUDLoadingMoogle();
  }
}

// ── Player Roster (right main panel) ──

// Draw a HUD border box on the main canvas ctx, with optional NES fade step
function _drawSparkleCorners(frame, px, py) {
  ctx.drawImage(frame, px - 8, py - 7);
  ctx.save(); ctx.scale(-1, 1); ctx.drawImage(frame, -(px + 23), py - 7); ctx.restore();
  ctx.save(); ctx.scale(1, -1); ctx.drawImage(frame, px - 8, -(py + 24)); ctx.restore();
  ctx.save(); ctx.scale(-1, -1); ctx.drawImage(frame, -(px + 23), -(py + 24)); ctx.restore();
}
function _drawCursorFaded(cx, cy, fadeStep) {
  if (!cursorTileCanvas) return;
  if (fadeStep <= 0) { ctx.drawImage(cursorTileCanvas, cx, cy); return; }
  if (fadeStep < 4 && cursorFadeCanvases) ctx.drawImage(cursorFadeCanvases[fadeStep - 1], cx, cy);
}
function _clipToViewport() {
  ctx.save(); ctx.beginPath(); ctx.rect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H); ctx.clip();
}
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


function _rosterLocForMapId(mapId) {
  if (mapId === 'world') return 'world';
  if (mapId === 114) return 'ur';
  if (mapId === 1004) return 'crystal';
  if (mapId >= 1000 && mapId < 1004) return 'cave-' + (mapId - 1000);
  return 'ur'; // sub-rooms (shops, houses) = same town
}

function _rosterTransFade() {
  const FADE_STEP_MS = WIPE_DURATION / ROSTER_FADE_STEPS;
  if (transSt.rosterLocChanged) {
    if (transSt.state === 'closing') return Math.min(Math.floor(transSt.timer / FADE_STEP_MS), ROSTER_FADE_STEPS);
    if (transSt.state === 'hold' || transSt.state === 'trap-falling') return ROSTER_FADE_STEPS;
    if (transSt.state === 'opening') return Math.max(ROSTER_FADE_STEPS - Math.floor(transSt.timer / FADE_STEP_MS), 0);
  }
  // Sync with HUD info fade-in on game start
  const infoFade = HUD_INFO_FADE_STEPS - Math.min(Math.floor(hudInfoFadeTimer / HUD_INFO_FADE_STEP_MS), HUD_INFO_FADE_STEPS);
  if (infoFade > 0) return infoFade;
  return 0;
}

function _drawRosterRow(p, i, panelTop) {
  const slideOff = rosterSlideY[p.name] || 0;
  const rowY = panelTop + i * ROSTER_ROW_H + slideOff;
  const playerFade = rosterFadeMap[p.name] || 0;
  const transFade = _rosterTransFade();
  const fadeStep = Math.min(Math.max(playerFade, transFade, rosterBattleFade), ROSTER_FADE_STEPS);

  _drawHudBox(HUD_RIGHT_X, rowY, 32, ROSTER_ROW_H, fadeStep);
  _drawHudBox(HUD_RIGHT_X + 32, rowY, HUD_RIGHT_W - 32, ROSTER_ROW_H, fadeStep);

  const portraits = fakePlayerPortraits[p.palIdx];
  if (portraits) ctx.drawImage(portraits[fadeStep], HUD_RIGHT_X + 8, rowY + 8);

  const namePal = [0x0F, 0x0F, 0x0F, 0x30];
  for (let s = 0; s < fadeStep; s++) namePal[3] = nesColorFade(namePal[3]);
  const nameBytes = _nameToBytes(p.name);
  const nameW = measureText(nameBytes);
  drawText(ctx, HUD_RIGHT_X + HUD_RIGHT_W - 8 - nameW, rowY + 8, nameBytes, namePal);

  const lvPal = [0x0F, 0x0F, 0x0F, 0x10];
  for (let s = 0; s < fadeStep; s++) lvPal[3] = nesColorFade(lvPal[3]);
  const lvLabel = _nameToBytes('Lv' + String(p.level));
  const lvW = measureText(lvLabel);
  drawText(ctx, HUD_RIGHT_X + HUD_RIGHT_W - 8 - lvW, rowY + 16, lvLabel, lvPal);
}

function _drawRosterSparkle(panelTop) {
  if (!pauseSt.healNum || pauseSt.healNum.rosterIdx < 0 || cureSparkleFrames.length !== 2) return;
  const visRow = pauseSt.healNum.rosterIdx - inputSt.rosterScroll;
  if (visRow < 0 || visRow >= ROSTER_VISIBLE) return;
  const px = HUD_RIGHT_X + 8;
  const py = panelTop + visRow * ROSTER_ROW_H + 8;
  const fi = Math.floor(pauseSt.timer / 67) & 1;
  const frame = cureSparkleFrames[fi];
  _drawSparkleCorners(frame, px, py);
  _drawBattleNum(px + 8, _dmgBounceY(py + 8, pauseSt.healNum.timer), pauseSt.healNum.value, [0x0F, 0x0F, 0x0F, 0x2B]);
}

function _drawRosterScrollTriangles(scrollAreaY, canScrollUp, canScrollDown) {
  if (!canScrollUp && !canScrollDown) return;
  const triFade = Math.min(Math.max(_rosterTransFade(), rosterBattleFade), ROSTER_FADE_STEPS);
  let triNes = 0x10;
  for (let s = 0; s < triFade; s++) triNes = nesColorFade(triNes);
  const triCol = NES_SYSTEM_PALETTE[triNes] || [0, 0, 0];
  ctx.fillStyle = `rgb(${triCol[0]},${triCol[1]},${triCol[2]})`;
  const triCX = HUD_RIGHT_X + Math.floor(HUD_RIGHT_W / 2);
  if (canScrollUp) {
    const ty = scrollAreaY + 2;
    ctx.beginPath(); ctx.moveTo(triCX - 4, ty + 5); ctx.lineTo(triCX, ty); ctx.lineTo(triCX + 4, ty + 5); ctx.fill();
  }
  if (canScrollDown) {
    const ty = scrollAreaY + 9;
    ctx.beginPath(); ctx.moveTo(triCX - 4, ty); ctx.lineTo(triCX, ty + 5); ctx.lineTo(triCX + 4, ty); ctx.fill();
  }
}

function drawRoster() {
  if (titleSt.state !== 'done') return;
  if (transSt.state === 'loading') return;
  if (rosterBattleFade >= ROSTER_FADE_STEPS && battleState !== 'none') return;

  const panelTop = HUD_VIEW_Y + 32;
  const panelH = HUD_VIEW_H - 32;
  const scrollAreaY = panelTop + ROSTER_VISIBLE * ROSTER_ROW_H;

  const players = getRosterVisible();
  const maxVisible = Math.min(ROSTER_VISIBLE, players.length);
  const maxScroll = Math.max(0, players.length - maxVisible);
  if (inputSt.rosterScroll > maxScroll) inputSt.rosterScroll = maxScroll;

  const canScrollUp = inputSt.rosterScroll > 0;
  const canScrollDown = inputSt.rosterScroll < maxScroll;

  ctx.save();
  ctx.beginPath();
  ctx.rect(HUD_RIGHT_X, panelTop, HUD_RIGHT_W, panelH);
  ctx.clip();
  for (let i = 0; i < maxVisible; i++) {
    const idx = inputSt.rosterScroll + i;
    if (idx >= players.length) break;
    _drawRosterRow(players[idx], i, panelTop);
  }
  ctx.restore();

  _drawRosterScrollTriangles(scrollAreaY, canScrollUp, canScrollDown);

  _drawRosterSparkle(panelTop);

  // Cursor (drawn outside clip — overlaps portrait box border)
  if (inputSt.rosterState === 'browse' || inputSt.rosterState === 'menu' || inputSt.rosterState === 'menu-in' || inputSt.rosterState === 'menu-out') {
    const visIdx = inputSt.rosterCursor - inputSt.rosterScroll;
    const curTarget = players[inputSt.rosterCursor];
    const curSlide = curTarget ? (rosterSlideY[curTarget.name] || 0) : 0;
    const curY = panelTop + visIdx * ROSTER_ROW_H + curSlide + 12;
    if (cursorTileCanvas) ctx.drawImage(cursorTileCanvas, HUD_RIGHT_X - 4, curY);
  }
}

function drawRosterMenu() {
  if (inputSt.rosterState !== 'menu-in' && inputSt.rosterState !== 'menu' && inputSt.rosterState !== 'menu-out') return;

  // Blue bordered box slides in from right edge of viewport
  const menuW = 80;
  const menuH = 8 + ROSTER_MENU_ITEMS.length * 14 + 8;
  const finalX = HUD_VIEW_X + HUD_VIEW_W - menuW - 8;
  const menuY = HUD_VIEW_Y + 32;
  const SLIDE_MS = 150;

  let menuX = finalX;
  if (inputSt.rosterState === 'menu-in') {
    const t = Math.min(inputSt.rosterMenuTimer / SLIDE_MS, 1);
    menuX = (HUD_VIEW_X + HUD_VIEW_W) + (finalX - (HUD_VIEW_X + HUD_VIEW_W)) * t;
    if (t >= 1) { inputSt.rosterState = 'menu'; inputSt.rosterMenuTimer = 0; }
  } else if (inputSt.rosterState === 'menu-out') {
    const t = Math.min(inputSt.rosterMenuTimer / SLIDE_MS, 1);
    menuX = finalX + ((HUD_VIEW_X + HUD_VIEW_W) - finalX) * t;
    if (t >= 1) { inputSt.rosterState = msgState.state !== 'none' ? 'none' : 'browse'; inputSt.rosterMenuTimer = 0; }
  }

  // Clip to viewport
  _clipToViewport();

  _drawBorderedBox(menuX, menuY, menuW, menuH, false);

  if (inputSt.rosterState === 'menu') {
    const textPal = TEXT_WHITE;
    for (let i = 0; i < ROSTER_MENU_ITEMS.length; i++) {
      const label = ROSTER_MENU_ITEMS[i];
      const labelBytes = _nameToBytes(label);
      drawText(ctx, menuX + 16, menuY + 8 + i * 14, labelBytes, textPal);
    }
    // Cursor
    if (cursorTileCanvas) {
      ctx.drawImage(cursorTileCanvas, menuX + 2, menuY + 4 + inputSt.rosterMenuCursor * 14);
    }
  }

  ctx.restore();
}

function initRoster() {
  document.fonts.load('8px "Press Start 2P"').then(() => {
    requestAnimationFrame(() => { chatState.fontReady = true; });
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


// addChatMessage, updateChat, drawChat → chat.js

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
  if (inputSt.rosterCursor >= visible.length) inputSt.rosterCursor = Math.max(0, visible.length - 1);
  const maxScroll = Math.max(0, visible.length - ROSTER_VISIBLE);
  if (inputSt.rosterScroll > maxScroll) inputSt.rosterScroll = maxScroll;
}

function _updateRosterBattleFade(dt) {
  // Battle fade out/in — don't fade during roar-hold (wait until roar box closes)
  if (battleState !== 'none' && battleState !== 'roar-hold' && rosterBattleFading !== 'out' && rosterBattleFade < ROSTER_FADE_STEPS) {
    rosterBattleFading = 'out';
    rosterBattleFadeTimer = 0;
  } else if (battleState === 'none' && rosterBattleFade > 0 && rosterBattleFading !== 'in') {
    rosterBattleFading = 'in';
    rosterBattleFadeTimer = 0;
  }
  if (rosterBattleFading !== 'none') {
    rosterBattleFadeTimer += dt;
    if (rosterBattleFadeTimer >= ROSTER_FADE_STEP_MS) {
      rosterBattleFadeTimer -= ROSTER_FADE_STEP_MS;
      const dir = rosterBattleFading === 'out' ? 1 : -1;
      rosterBattleFade = Math.max(0, Math.min(ROSTER_FADE_STEPS, rosterBattleFade + dir));
      if (rosterBattleFade === 0 || rosterBattleFade >= ROSTER_FADE_STEPS) rosterBattleFading = 'none';
    }
  }
}

function _updateRosterLocationReset(curLoc) {
  if (rosterPrevLoc === null || curLoc === rosterPrevLoc) return;
  rosterFadeMap = {}; rosterFadeDir = {}; rosterFadeTimers = {}; rosterSlideY = {};
  rosterArrivalOrder = [];
  for (const p of PLAYER_POOL) {
    if (p.loc === curLoc) rosterFadeMap[p.name] = 0;
  }
  inputSt.rosterCursor = 0;
  inputSt.rosterScroll = 0;
  rosterPrevLoc = curLoc;
}

function _updateRosterFadeTicks(dt) {
  for (const name in rosterFadeDir) {
    const dir = rosterFadeDir[name];
    rosterFadeTimers[name] = (rosterFadeTimers[name] || 0) + dt;
    if (rosterFadeTimers[name] < ROSTER_FADE_STEP_MS) continue;
    rosterFadeTimers[name] -= ROSTER_FADE_STEP_MS;
    if (dir === 'in') {
      if (rosterFadeMap[name] > 0) rosterFadeMap[name]--;
      if (rosterFadeMap[name] <= 0) { rosterFadeMap[name] = 0; delete rosterFadeDir[name]; }
    } else if (dir === 'out') {
      rosterFadeMap[name] = (rosterFadeMap[name] || 0) + 1;
      if (rosterFadeMap[name] >= ROSTER_FADE_STEPS) {
        const vis = getRosterVisible();
        const removeIdx = vis.findIndex(p => p.name === name);
        if (removeIdx >= 0) {
          for (let j = removeIdx + 1; j < vis.length; j++)
            rosterSlideY[vis[j].name] = (rosterSlideY[vis[j].name] || 0) + ROSTER_ROW_H;
        }
        delete rosterFadeMap[name]; delete rosterFadeDir[name];
        delete rosterFadeTimers[name]; delete rosterSlideY[name];
        _clampRosterCursor();
      }
    }
  }
}
function _updateRosterSlideTicks(dt) {
  for (const name in rosterSlideY) {
    const sy = rosterSlideY[name];
    if (sy === 0) { delete rosterSlideY[name]; continue; }
    const move = ROSTER_SLIDE_SPEED * dt;
    rosterSlideY[name] = Math.abs(sy) <= move ? 0 : sy > 0 ? sy - move : sy + move;
    if (rosterSlideY[name] === 0) delete rosterSlideY[name];
  }
}
function _updateRosterMovement(dt, curLoc) {
  if (battleState !== 'none') return;
  rosterTimer -= dt;
  if (rosterTimer > 0) return;
  rosterTimer = _rosterNextTimer();
  const movers = PLAYER_POOL.filter(p => !p.camper);
  if (movers.length === 0) return;
  const mover = movers[Math.floor(Math.random() * movers.length)];
  const wasHere = mover.loc === curLoc;
  mover.loc = LOCATIONS.filter(l => l !== mover.loc)[Math.floor(Math.random() * (LOCATIONS.length - 1))];
  if (wasHere && mover.loc !== curLoc) _rosterStartFadeOut(mover.name);
  else if (!wasHere && mover.loc === curLoc) _rosterStartFadeIn(mover.name);
}
function updateRoster(dt) {
  if (inputSt.rosterState === 'menu-in' || inputSt.rosterState === 'menu-out') inputSt.rosterMenuTimer += Math.min(dt, 33);
  if (titleSt.state !== 'done') return;
  _updateRosterBattleFade(dt);
  const curLoc = getPlayerLocation();
  _updateRosterLocationReset(curLoc);
  _updateRosterFadeTicks(dt);
  _updateRosterSlideTicks(dt);
  _updateRosterMovement(dt, curLoc);
}

// ── Title Screen — titleFadeLevel, titleFadePal, draw functions → title-screen.js ──

function _updateTitleUnderwater(dt) {
  if (!titleSt.bubbleTiles) return;
  if (titleSt.state === 'main-in' || titleSt.state === 'main' || titleSt.state === 'main-out' ||
      titleSt.state.startsWith('zbox') || titleSt.state.startsWith('select') || titleSt.state === 'name-entry') return;
  if (titleSt.bubbles.length < 3 && Math.random() < dt * 0.0015) {
    titleSt.bubbles.push({
      x: HUD_VIEW_X + 20 + Math.random() * (CANVAS_W - 40),
      y: HUD_VIEW_H - 4,
      speed: 18 + Math.random() * 12,
      zigPhase: Math.random() * Math.PI * 2,
      zigSpeed: 3 + Math.random() * 3,
      zigAmp: 8 + Math.random() * 8,
      timer: 0,
    });
  }
  for (let i = titleSt.bubbles.length - 1; i >= 0; i--) {
    const b = titleSt.bubbles[i];
    b.y -= b.speed * dt / 1000;
    b.timer += dt;
    if (b.y < -8) titleSt.bubbles.splice(i, 1);
  }
  if (!titleSt.fishTriggered && titleSt.state === 'disclaim-wait') {
    titleSt.fishTriggered = true;
    titleSt.fish = { x: -10, y: HUD_VIEW_H * 0.7, timer: 0, speed: 80, zigPhase: 0, zigSpeed: 4, zigAmp: 6 };
  }
  if (titleSt.fish) {
    titleSt.fish.x += titleSt.fish.speed * dt / 1000;
    titleSt.fish.y -= titleSt.fish.speed * 0.4 * dt / 1000;
    titleSt.fish.timer += dt;
    if (titleSt.fish.x > CANVAS_W + 10 || titleSt.fish.y < -10) titleSt.fish = null;
  }
}
function _updateTitleSelectCase() {
  if (_zPressed()) {
    if (titleSt.deleteMode) {
      if (selectCursor < 3 && saveSlots[selectCursor]) {
        playSFX(SFX.CONFIRM);
        saveSlots[selectCursor] = null;
        serverDeleteSlot(selectCursor);
        saveSlotsToDB();
        titleSt.deleteMode = false;
      }
    } else if (selectCursor === 3) {
      playSFX(SFX.CONFIRM);
      titleSt.deleteMode = true;
      selectCursor = 0;
    } else if (saveSlots[selectCursor]) {
      playSFX(SFX.CONFIRM);
      titleSt.state = 'select-fade-out'; titleSt.timer = 0;
    } else {
      playSFX(SFX.CONFIRM);
      nameBuffer = [];
      titleSt.state = 'name-entry'; titleSt.timer = 0;
    }
  }
  if (titleSt.deleteMode) {
    if (keys['ArrowDown']) { keys['ArrowDown'] = false; selectCursor = (selectCursor + 1) % 3; playSFX(SFX.CURSOR); }
    if (keys['ArrowUp'])   { keys['ArrowUp'] = false;   selectCursor = (selectCursor + 2) % 3; playSFX(SFX.CURSOR); }
  } else {
    if (keys['ArrowDown']) { keys['ArrowDown'] = false; selectCursor = (selectCursor + 1) % 4; playSFX(SFX.CURSOR); }
    if (keys['ArrowUp'])   { keys['ArrowUp'] = false;   selectCursor = (selectCursor + 3) % 4; playSFX(SFX.CURSOR); }
  }
  if (_xPressed()) {
    if (titleSt.deleteMode) { playSFX(SFX.CONFIRM); titleSt.deleteMode = false; }
    else { playSFX(SFX.CONFIRM); titleSt.state = 'select-fade-out-back'; titleSt.timer = 0; }
  }
}
function _updateTitleMainOutCase() {
  titleSt.state = 'done';
  hudInfoFadeTimer = 0;
  const slot = saveSlots[selectCursor];
  if (slot && slot.stats) {
    ps.stats.str = slot.stats.str;
    ps.stats.agi = slot.stats.agi;
    ps.stats.vit = slot.stats.vit;
    ps.stats.int = slot.stats.int;
    ps.stats.mnd = slot.stats.mnd;
    ps.stats.maxHP = slot.stats.maxHP;
    ps.stats.maxMP = slot.stats.maxMP;
    ps.stats.level = slot.level;
    ps.stats.exp = slot.exp;
    ps.stats.expToNext = (slot.level - 1 < 98) ? ps.expTable[slot.level - 1] : 0xFFFFFF;
    fullHeal();
    ps.weaponR = slot.stats.weaponR != null ? slot.stats.weaponR : 0x1E;
    ps.weaponL = slot.stats.weaponL != null ? slot.stats.weaponL : 0x00;
    ps.head = slot.stats.head || 0x00;
    ps.body = slot.stats.body || 0x00;
    ps.arms = slot.stats.arms || 0x00;
    recalcCombatStats();
  }
  playerInventory = (slot && slot.inventory) ? { ...slot.inventory } : {};
  ps.gil = (slot && slot.gil) || 0;
  ps.proficiency = (slot && slot.proficiency) ? { ...slot.proficiency } : {};
  transSt.pendingTrack = TRACKS.TOWN_UR;
  loadMapById(114);
  worldY -= 6 * TILE_SIZE;
  transSt.state = 'hud-fade-in';
  transSt.timer = 0;
}
function updateTitle(dt) {
  titleSt.timer += dt;
  titleSt.underwaterScroll += dt * 0.11;
  _updateTitleUnderwater(dt);

  if (isTitleActiveState()) {
    waterTimer += dt;
    if (waterTimer >= WATER_TICK) { waterTimer %= WATER_TICK; waterTick++; }
    titleSt.waterScroll += dt * 0.12;
    titleSt.shipTimer += dt;
  }

  switch (titleSt.state) {
    case 'credit-wait':    if (titleSt.timer >= TITLE_FADE_MS) { titleSt.state = 'credit-in';     titleSt.timer = 0; } break;
    case 'credit-in':      if (titleSt.timer >= TITLE_FADE_MS) { titleSt.state = 'credit-hold';   titleSt.timer = 0; } break;
    case 'credit-hold':    if (titleSt.timer >= TITLE_HOLD_MS) { titleSt.state = 'credit-out';    titleSt.timer = 0; } break;
    case 'credit-out':     if (titleSt.timer >= TITLE_FADE_MS) { titleSt.state = 'disclaim-wait'; titleSt.timer = 0; } break;
    case 'disclaim-wait':  if (titleSt.timer >= TITLE_WAIT_MS) { titleSt.state = 'disclaim-in';   titleSt.timer = 0; } break;
    case 'disclaim-in':    if (titleSt.timer >= TITLE_FADE_MS) { titleSt.state = 'disclaim-hold'; titleSt.timer = 0; } break;
    case 'disclaim-hold':  if (titleSt.timer >= TITLE_HOLD_MS) { titleSt.state = 'disclaim-out';  titleSt.timer = 0; } break;
    case 'disclaim-out':   if (titleSt.timer >= TITLE_FADE_MS) { titleSt.state = 'main-in';       titleSt.timer = 0; } break;
    case 'main-in':        if (titleSt.timer >= TITLE_FADE_MS) { titleSt.state = 'zbox-open';     titleSt.timer = 0; } break;
    case 'zbox-open':      if (titleSt.timer >= TITLE_ZBOX_MS) { titleSt.state = 'main';          titleSt.timer = 0; } break;
    case 'main':
      if (keys['z'] || keys['Z']) { keys['z'] = false; keys['Z'] = false; playSFX(SFX.CONFIRM); titleSt.state = 'zbox-close'; titleSt.timer = 0; }
      break;
    case 'zbox-close':           if (titleSt.timer >= TITLE_ZBOX_MS) { titleSt.state = 'logo-fade-out'; titleSt.timer = 0; } break;
    case 'logo-fade-out':        if (titleSt.timer >= TITLE_FADE_MS) { titleSt.state = 'select-box-open'; titleSt.timer = 0; selectCursor = 0; titleSt.deleteMode = false; } break;
    case 'select-box-open':      if (titleSt.timer >= BOSS_BOX_EXPAND_MS) { titleSt.state = 'select-fade-in'; titleSt.timer = 0; } break;
    case 'select-fade-in':       if (titleSt.timer >= (SELECT_TEXT_STEPS + 1) * SELECT_TEXT_STEP_MS) { titleSt.state = 'select'; titleSt.timer = 0; } break;
    case 'select':               _updateTitleSelectCase(); break;
    case 'name-entry':           break;
    case 'select-fade-out':      if (titleSt.timer >= (SELECT_TEXT_STEPS + 1) * SELECT_TEXT_STEP_MS) { titleSt.state = 'select-box-close-fwd'; titleSt.timer = 0; } break;
    case 'select-box-close-fwd': if (titleSt.timer >= BOSS_BOX_EXPAND_MS) { titleSt.state = 'main-out'; titleSt.timer = 0; fadeOutMusic(TITLE_FADE_MS); } break;
    case 'select-fade-out-back': if (titleSt.timer >= (SELECT_TEXT_STEPS + 1) * SELECT_TEXT_STEP_MS) { titleSt.state = 'select-box-close'; titleSt.timer = 0; } break;
    case 'select-box-close':     if (titleSt.timer >= BOSS_BOX_EXPAND_MS) { titleSt.state = 'logo-fade-in'; titleSt.timer = 0; } break;
    case 'logo-fade-in':         if (titleSt.timer >= TITLE_FADE_MS) { titleSt.state = 'zbox-open'; titleSt.timer = 0; } break;
    case 'main-out':             if (titleSt.timer >= TITLE_FADE_MS) _updateTitleMainOutCase(); break;
  }
}


// drawTitleOcean..drawPlayerSelectContent → title-screen.js

// --- Pause menu (updatePauseMenu, drawPauseMenu → pause-menu.js) ---

// showMsgBox, updateMsgBox, drawMsgBox → message-box.js

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

// _drawPauseBox, _drawPauseMenuText, _drawPauseInventory, _drawPauseEquipSlots, _drawPauseEquipItems, _drawPauseStats, drawPauseMenu → pause-menu.js

// --- Slash Sprites (procedural) ---


// --- Battle System ---

// calcDamage, rollHits → battle-math.js

function buildTurnOrder() {
  const actors = [];
  const playerAgi = ps.stats ? ps.stats.agi : 5;
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
  } else if (pvpSt.isPVPBattle) {
    // Main opponent — only if player hasn't advanced past them
    if (pvpSt.pvpPlayerTargetIdx < 0)
      actors.push({ type: 'enemy', index: -1, pvpAllyIdx: -1, priority: Math.floor(Math.random() * 256) });
    // PVP enemy allies — only those the player hasn't defeated yet
    for (let i = 0; i < pvpSt.pvpEnemyAllies.length; i++) {
      if (pvpSt.pvpPlayerTargetIdx <= i)
        actors.push({ type: 'enemy', index: -1, pvpAllyIdx: i, priority: Math.floor(Math.random() * 256) });
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

function _playerTurnFight() {
  let ti = inputSt.playerActionPending.targetIndex;
  if (isRandomEncounter && encounterMonsters && ti >= 0 && encounterMonsters[ti].hp <= 0) {
    const living = encounterMonsters.findIndex(m => m.hp > 0);
    if (living < 0) { processNextTurn(); return; } // all dead — skip, victory will trigger
    ti = living;
  }
  currentHitIdx = 0; slashFrame = 0;
  inputSt.hitResults = inputSt.playerActionPending.hitResults;
  inputSt.targetIndex = ti;
  slashFrames = inputSt.playerActionPending.slashFrames;
  slashOffX = inputSt.playerActionPending.slashOffX; slashOffY = inputSt.playerActionPending.slashOffY;
  slashX = inputSt.playerActionPending.slashX; slashY = inputSt.playerActionPending.slashY;
  battleState = 'attack-start'; battleTimer = 0;
}

function _playerTurnSouthWind() {
  const _mode = inputSt.playerActionPending.targetMode || 'single';
  const mons = isRandomEncounter && encounterMonsters;
  const _rightCols = mons ? encounterMonsters.map((m, i) =>
    (m.hp > 0 && (encounterMonsters.length === 1 || (encounterMonsters.length === 2 && i === 1) || (encounterMonsters.length >= 3 && (i === 1 || i === 3)))) ? i : -1).filter(i => i >= 0) : [];
  const _leftCols = mons ? encounterMonsters.map((m, i) =>
    (m.hp > 0 && encounterMonsters.length >= 2 && !_rightCols.includes(i)) ? i : -1).filter(i => i >= 0) : [];
  if (_mode === 'all') {
    const ecnt = encounterMonsters ? encounterMonsters.length : 0;
    southWindTargets = (ecnt <= 2 ? [0, 1] : [0, 1, 2, 3]).filter(i => i < ecnt && encounterMonsters[i].hp > 0);
  } else if (_mode === 'col-right') southWindTargets = _rightCols;
  else if (_mode === 'col-left') southWindTargets = _leftCols;
  else southWindTargets = [inputSt.playerActionPending.target];
  southWindHitIdx = 0;
  const swAttack = Math.floor((ps.stats ? ps.stats.int : 5) / 2) + 55;
  swBaseDamage = Math.floor((swAttack + Math.floor(Math.random() * Math.floor(swAttack / 2 + 1))) / 2);
  battleState = 'sw-throw'; battleTimer = 0;
}

function _playerTurnConsumable() {
  playSFX(SFX.CURE);
  const { target, allyIndex } = inputSt.playerActionPending;
  if (target === 'player' && (allyIndex === undefined || allyIndex < 0)) {
    const heal = Math.min(50, ps.stats.maxHP - ps.hp);
    ps.hp += heal; itemHealAmount = heal; playerHealNum = { value: heal, timer: 0 };
  } else if (target === 'player' && allyIndex >= 0) {
    const ally = battleAllies[allyIndex];
    if (ally) {
      const heal = Math.min(50, ally.maxHP - ally.hp);
      ally.hp += heal; itemHealAmount = heal;
      allyDamageNums[allyIndex] = { value: heal, timer: 0, heal: true };
    }
  } else {
    const mon = isRandomEncounter && encounterMonsters ? encounterMonsters[target] : null;
    if (mon) {
      const heal = Math.min(50, mon.maxHP - mon.hp);
      mon.hp += heal; itemHealAmount = heal; enemyHealNum = { value: heal, timer: 0, index: target };
    } else {
      const heal = Math.min(50, BOSS_MAX_HP - bossHP);
      bossHP += heal; itemHealAmount = heal; enemyHealNum = { value: heal, timer: 0, index: 0 };
    }
  }
  battleState = 'item-use'; battleTimer = 0;
}

function _playerTurnItem() {
  isDefending = false;
  removeItem(inputSt.playerActionPending.itemId);
  if (ITEMS.get(inputSt.playerActionPending.itemId)?.type === 'battle_item') _playerTurnSouthWind();
  else _playerTurnConsumable();
}

function _playerTurnRun() {
  const playerAgi = ps.stats ? ps.stats.agi : 5;
  let avgLevel = 1;
  if (encounterMonsters) {
    const alive = encounterMonsters.filter(m => m.hp > 0);
    if (alive.length > 0) avgLevel = alive.reduce((s, m) => s + (m.level || 1), 0) / alive.length;
  }
  const successRate = Math.min(99, Math.max(1, playerAgi + 25 - Math.floor(avgLevel / 4)));
  battleState = Math.floor(Math.random() * 100) < successRate ? 'run-name-out' : 'run-fail-name-out';
  battleTimer = 0;
}

function processNextTurn() {
  if (turnQueue.length === 0) {
    isDefending = false; inputSt.battleCursor = 0; battleState = 'menu-open'; battleTimer = 0; turnTimer = 0;
    return;
  }
  const turn = turnQueue.shift();
  if (turn.type === 'player') {
    const cmd = inputSt.playerActionPending.command;
    if (cmd === 'fight') _playerTurnFight();
    else if (cmd === 'defend') { playSFX(SFX.DEFEND_HIT); battleState = 'defend-anim'; battleTimer = 0; }
    else if (cmd === 'item') _playerTurnItem();
    else if (cmd === 'skip') processNextTurn();
    else if (cmd === 'run') _playerTurnRun();
  } else if (turn.type === 'ally') {
    currentAllyAttacker = turn.index;
    const ally = battleAllies[turn.index];
    if (!ally || ally.hp <= 0) { processNextTurn(); return; }
    if (isRandomEncounter && encounterMonsters) {
      const living = encounterMonsters.map((m, i) => m.hp > 0 ? i : -1).filter(i => i >= 0);
      if (living.length === 0) { processNextTurn(); return; }
      allyTargetIndex = living[Math.floor(Math.random() * living.length)];
    } else { allyTargetIndex = -1; }
    const targetDef = allyTargetIndex >= 0 ? encounterMonsters[allyTargetIndex].def
      : pvpSt.isPVPBattle
        ? (pvpSt.pvpPlayerTargetIdx >= 0
            ? (pvpSt.pvpEnemyAllies[pvpSt.pvpPlayerTargetIdx] || pvpSt.pvpOpponentStats).def
            : pvpSt.pvpOpponentStats.def)
        : BOSS_DEF;
    allyHitResult = rollHits(ally.atk, targetDef, 85, 1)[0];
    battleState = 'ally-attack-start'; battleTimer = 0;
  } else {
    currentAttacker = turn.index;
    if (pvpSt.isPVPBattle) {
      const pai = turn.pvpAllyIdx ?? -1;
      pvpSt.pvpCurrentEnemyAllyIdx = pai;
      // Skip if this attacker has already been defeated (player advanced past them)
      if (pai < 0 && pvpSt.pvpPlayerTargetIdx >= 0) { processNextTurn(); return; }
      if (pai >= 0 && pvpSt.pvpPlayerTargetIdx > pai) { processNextTurn(); return; }
      // Reset dual-wield counter for each fresh main-opponent turn
      if (pai < 0) pvpSt.pvpOpponentHitsThisTurn = 0;
    }
    if (turn.index >= 0 && encounterMonsters && encounterMonsters[turn.index].hp <= 0) { processNextTurn(); return; }
    battleState = 'boss-flash'; battleTimer = 0; pvpSt.pvpPreflashDecided = false;
  }
}


function startBattle() {
  battleState = 'roar-hold';
  battleTimer = 0;
  showMsgBox(BATTLE_ROAR, () => { battleState = 'flash-strobe'; battleTimer = 0; playSFX(SFX.BATTLE_SWIPE); });
  _resetBattleVars();
  bossHP = BOSS_MAX_HP;
  playSFX(SFX.EARTHQUAKE);
}

function startRandomEncounter() {
  isRandomEncounter = true;
  inputSt.battleProfHits = {};

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
  inputSt.battleCursor = 0;
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
  allyHitResult = null; allyHitIsLeft = false;
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
      inputSt.targetIndex = encounterMonsters.findIndex(m => m.hp > 0);
    }
    battleState = 'target-select';
    battleTimer = 0;
  } else if (index === 1) {
    // Defend — pause for confirm SFX, then build turn queue
    playSFX(SFX.CONFIRM);
    isDefending = true;
    inputSt.playerActionPending = { command: 'defend' };
    battleState = 'confirm-pause';
    battleTimer = 0;
  } else if (index === 2) {
    // Item — fade menu text out, show inventory on right side
    playSFX(SFX.CONFIRM);
    inputSt.itemSelectList = buildItemSelectList();
    itemSelectCursor = 0;
    inputSt.itemHeldIdx = -1;
    inputSt.itemPage = 1;          // start on inventory page 1
    inputSt.itemPageCursor = 0;
    inputSt.itemSlideDir = 0;
    inputSt.itemSlideCursor = 0;
    battleState = 'item-menu-out';
    battleTimer = 0;
  } else {
    // Run
    if (isRandomEncounter) {
      playSFX(SFX.CONFIRM);
      isDefending = false;
      inputSt.playerActionPending = { command: 'run' };
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

// --- Battle update sub-handlers ---
// Each returns true if it handled the current battleState, false otherwise.
// Called in order from updateBattle; short-circuits on first match (mirrors old if-else chain).

function _updateBattleTimers(dt) {
  if (bossFlashTimer > 0) bossFlashTimer = Math.max(0, bossFlashTimer - dt);
  if (battleShakeTimer > 0) battleShakeTimer = Math.max(0, battleShakeTimer - dt);
  if (pvpSt.pvpBossShakeTimer > 0) pvpSt.pvpBossShakeTimer = Math.max(0, pvpSt.pvpBossShakeTimer - dt);

  if (bossDamageNum) { bossDamageNum.timer += dt; if (bossDamageNum.timer >= BATTLE_DMG_SHOW_MS) bossDamageNum = null; }
  for (const k of Object.keys(southWindDmgNums)) {
    southWindDmgNums[k].timer += dt;
    if (southWindDmgNums[k].timer >= 700) delete southWindDmgNums[k];
  }
  if (playerDamageNum) { playerDamageNum.timer += dt; if (playerDamageNum.timer >= BATTLE_DMG_SHOW_MS) playerDamageNum = null; }

  for (const idx in allyDamageNums) {
    if (allyDamageNums[idx]) { allyDamageNums[idx].timer += dt; if (allyDamageNums[idx].timer >= BATTLE_DMG_SHOW_MS) delete allyDamageNums[idx]; }
  }
  for (const idx in allyShakeTimer) {
    if (allyShakeTimer[idx] > 0) allyShakeTimer[idx] = Math.max(0, allyShakeTimer[idx] - dt);
  }

  _updateTurnTimer(dt);
  _updateAllyExitFade(dt);
}

function _updateTurnTimer(dt) {
  const isPlayerDeciding = battleState === 'menu-open' || battleState === 'target-select' ||
    battleState === 'item-select' || battleState === 'item-target-select' || battleState === 'item-slide';
  if (!isPlayerDeciding) return;
  turnTimer += dt;
  if (turnTimer >= TURN_TIME_MS) {
    turnTimer = 0; inputSt.itemHeldIdx = -1;
    inputSt.playerActionPending = { command: 'skip' }; battleState = 'confirm-pause'; battleTimer = 0;
  }
}

// _isTitleActiveState → isTitleActiveState() in title-screen.js
function _isVictoryBattleState() {
  return battleState === 'victory-celebrate' || battleState === 'victory-text-in' ||
    battleState === 'victory-hold' || battleState === 'victory-fade-out' ||
    battleState === 'exp-text-in' || battleState === 'exp-hold' || battleState === 'exp-fade-out' ||
    battleState === 'gil-text-in' || battleState === 'gil-hold' || battleState === 'gil-fade-out' ||
    battleState === 'levelup-text-in' || battleState === 'levelup-hold' ||
    battleState === 'item-text-in' || battleState === 'item-hold' || battleState === 'item-fade-out' ||
    battleState === 'prof-levelup-text-in' || battleState === 'prof-levelup-hold' ||
    battleState === 'victory-text-out' || battleState === 'victory-menu-fade' || battleState === 'victory-box-close';
}
function _updateAllyExitFade(dt) {
  if (battleAllies.length === 0) return;
  const isVicState = _isVictoryBattleState() && battleState !== 'victory-box-close';
  if (!isVicState) return;
  const ALLY_EXIT_DELAY_MS = 1500, ALLY_EXIT_STEP_MS = 100;
  allyExitTimer += dt;
  if (allyExitTimer >= ALLY_EXIT_DELAY_MS) {
    const stepsDone = Math.floor((allyExitTimer - ALLY_EXIT_DELAY_MS) / ALLY_EXIT_STEP_MS);
    const targetFade = Math.min(4, stepsDone);
    for (let i = 0; i < battleAllies.length; i++) {
      if (battleAllies[i].fadeStep < targetFade) battleAllies[i].fadeStep = targetFade;
    }
  }
}

function _updateBattleOpening() {
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
  } else { return false; }
  return true;
}


function _tryJoinPlayerAlly() {
  if (battleAllies.length >= 3) return false;
  const loc = getPlayerLocation();
  const pvpNames = new Set([
    pvpSt.pvpOpponent && pvpSt.pvpOpponent.name,
    ...pvpSt.pvpEnemyAllies.map(a => a.name),
  ].filter(Boolean));
  const eligible = PLAYER_POOL.filter(p =>
    p.loc === loc &&
    !battleAllies.some(a => a.name === p.name) &&
    !pvpNames.has(p.name)
  );
  if (eligible.length === 0 || Math.random() >= 0.5) return false;
  battleAllies.push(generateAllyStats(eligible[Math.floor(Math.random() * eligible.length)]));
  battleState = 'ally-fade-in'; battleTimer = 0;
  return true;
}

function _updateBattleMenuConfirm() {
  if (battleState === 'message-hold') {
    if (battleTimer >= BATTLE_MSG_HOLD_MS) { battleState = 'menu-open'; battleTimer = 0; battleMessage = null; }
  } else if (battleState === 'confirm-pause') {
    if (battleTimer >= 150) {
      allyJoinRound++;
      if (_tryJoinPlayerAlly()) return true;
      turnQueue = buildTurnOrder(); processNextTurn();
    }
  } else { return false; }
  return true;
}

function _finalizeComboHits() {
  let totalDmg = 0, anyCrit = false, allMiss = true;
  for (const h of inputSt.hitResults) {
    if (!h.miss) { totalDmg += h.damage; allMiss = false; if (h.crit) anyCrit = true; }
  }
  bossDamageNum = allMiss ? { miss: true, timer: 0 } : { value: totalDmg, crit: anyCrit, timer: 0 };
  if (pvpSt.isPVPBattle && !allMiss) pvpSt.pvpBossShakeTimer = BATTLE_SHAKE_MS;
  battleState = 'player-damage-show';
  battleTimer = 0;
}
function _advanceHitCombo() {
  if (currentHitIdx + 1 < inputSt.hitResults.length) {
    currentHitIdx++;
    slashFrame = 0;
    const handWeapon = getHitWeapon(currentHitIdx);
    slashFrames = getSlashFramesForWeapon(handWeapon, isHitRightHand(currentHitIdx));
    if (isBladedWeapon(handWeapon)) { slashOffX = 8; slashOffY = -8; }
    else { slashOffX = Math.floor(Math.random() * 40) - 20; slashOffY = Math.floor(Math.random() * 40) - 20; }
    battleState = 'attack-start';
    battleTimer = 0;
  } else {
    _finalizeComboHits();
  }
}
function _updatePlayerAttackStart() {
  if (battleState !== 'attack-start') return false;
  const startDelay = currentHitIdx === 0 ? 100 : 50;
  if (battleTimer >= startDelay) {
    const hw0 = getHitWeapon(currentHitIdx);
    const isBladed0 = isBladedWeapon(hw0);
    playSFX(isBladed0 ? SFX.KNIFE_HIT : SFX.ATTACK_HIT);
    if (isBladed0 && !(inputSt.hitResults[currentHitIdx] && inputSt.hitResults[currentHitIdx].crit)) {
      if (sfxCutTimerId) clearTimeout(sfxCutTimerId);
      sfxCutTimerId = setTimeout(() => { stopSFX(); sfxCutTimerId = null; }, 133);
    }
    battleState = 'player-slash';
    battleTimer = 0;
  }
  return true;
}
function _updatePlayerSlash() {
  if (battleState !== 'player-slash') return false;
  const frame = Math.floor(battleTimer / SLASH_FRAME_MS);
  if (frame !== slashFrame && frame < SLASH_FRAMES) {
    slashFrame = frame;
    const handWeapon = getHitWeapon(currentHitIdx);
    if (isBladedWeapon(handWeapon)) {
      slashOffX = 8 - slashFrame * 8;
      slashOffY = -8 + slashFrame * 8;
    } else {
      slashOffX = Math.floor(Math.random() * 40) - 20;
      slashOffY = Math.floor(Math.random() * 40) - 20;
    }
  }
  if (battleTimer >= SLASH_FRAMES * SLASH_FRAME_MS) {
    const hit = inputSt.hitResults[currentHitIdx];
    if (!hit.miss) {
      if (pvpSt.isPVPBattle && pvpSt.pvpOpponentIsDefending)
        hit.damage = Math.max(1, Math.floor(hit.damage / 2));
      if (isRandomEncounter && encounterMonsters) {
        encounterMonsters[inputSt.targetIndex].hp = Math.max(0, encounterMonsters[inputSt.targetIndex].hp - hit.damage);
      } else {
        bossHP = Math.max(0, bossHP - hit.damage);
      }
      if (hit.crit) critFlashTimer = 0;
    }
    battleState = 'player-hit-show';
    battleTimer = 0;
  }
  return true;
}
function _updatePlayerHitShow() {
  if (battleState !== 'player-hit-show') return false;
  const hitPause = (currentHitIdx + 1 < inputSt.hitResults.length) ? 50 : HIT_PAUSE_MS;
  if (battleTimer >= hitPause) _advanceHitCombo();
  return true;
}
function _updatePlayerMissShow() {
  if (battleState !== 'player-miss-show') return false;
  if (battleTimer >= MISS_SHOW_MS) _advanceHitCombo();
  return true;
}
function _updatePlayerDamageShow() {
  if (battleState !== 'player-damage-show') return false;
  if (battleTimer >= PLAYER_DMG_SHOW_MS) {
    if (isRandomEncounter && encounterMonsters && encounterMonsters[inputSt.targetIndex].hp <= 0) {
      dyingMonsterIndices = new Map([[inputSt.targetIndex, 0]]);
      battleState = 'monster-death';
      battleTimer = 0;
      playSFX(SFX.MONSTER_DEATH);
    } else if (!isRandomEncounter && bossHP <= 0) {
      if (pvpSt.isPVPBattle) { battleState = 'pvp-dissolve'; battleTimer = 0; playSFX(SFX.MONSTER_DEATH); }
      else { battleState = 'boss-dissolve'; battleTimer = 0; playSFX(SFX.BOSS_DEATH); }
    } else {
      processNextTurn();
    }
  }
  return true;
}
function _advancePVPTargetOrVictory() {
  const nextIdx = pvpSt.pvpPlayerTargetIdx + 1;
  if (nextIdx < pvpSt.pvpEnemyAllies.length) {
    pvpSt.pvpPlayerTargetIdx = nextIdx;
    bossHP = pvpSt.pvpEnemyAllies[nextIdx].hp;
    processNextTurn();
  } else {
    _triggerPVPVictory();
  }
}
function _triggerPVPVictory() {
  const oppLv = pvpSt.pvpOpponentStats ? pvpSt.pvpOpponentStats.level : 1;
  encounterExpGained = 5 * oppLv;
  encounterGilGained = 10 * oppLv;
  grantExp(encounterExpGained);
  ps.gil += encounterGilGained;
  encounterProfLevelUps = gainProficiency(inputSt.battleProfHits, oppLv);
  inputSt.battleProfHits = {}; profLevelUpIdx = 0;
  _syncSaveSlotProgress();
  saveSlotsToDB();
  bossDefeated = true;
  isDefending = false; battleState = 'victory-name-out'; battleTimer = 0;
  playSFX(SFX.BOSS_DEATH);
}
function _updateMonsterDeath() {
  if (battleState !== 'monster-death') return false;
  const _maxDelay = dyingMonsterIndices.size > 0 ? Math.max(...dyingMonsterIndices.values()) : 0;
  if (battleTimer >= MONSTER_DEATH_MS + _maxDelay) {
    dyingMonsterIndices = new Map();
    const allDead = encounterMonsters.every(m => m.hp <= 0);
    if (allDead) {
      encounterExpGained = encounterMonsters.reduce((sum, m) => sum + m.exp, 0);
      encounterGilGained = encounterMonsters.reduce((sum, m) => sum + (m.gil || 0), 0);
      grantExp(encounterExpGained);
      ps.gil += encounterGilGained;
      const _avgEnemyLv = Math.round(encounterMonsters.reduce((s, m) => s + (MONSTERS.get(m.monsterId)?.level || 1), 0) / encounterMonsters.length);
      encounterProfLevelUps = gainProficiency(inputSt.battleProfHits, _avgEnemyLv); inputSt.battleProfHits = {}; profLevelUpIdx = 0;
      encounterDropItem = null;
      for (const m of encounterMonsters) {
        const mData = MONSTERS.get(m.monsterId);
        if (mData && mData.drops && mData.drops.length && Math.random() < 0.25) {
          encounterDropItem = mData.drops[Math.floor(Math.random() * mData.drops.length)];
          break;
        }
      }
      if (encounterDropItem !== null) addItem(encounterDropItem, 1);
      _syncSaveSlotProgress();
      saveSlotsToDB();
      isDefending = false;
      battleState = 'victory-name-out';
      battleTimer = 0;
    } else {
      processNextTurn();
    }
  }
  return true;
}
function _updateBattlePlayerAttack() {
  return _updatePlayerAttackStart() ||
         _updatePlayerSlash() ||
         _updatePlayerHitShow() ||
         _updatePlayerMissShow() ||
         _updatePlayerDamageShow() ||
         _updateMonsterDeath();
}


function _updateBattleDefendItem(dt) {
  if (battleState === 'defend-anim') {
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
  } else if (battleState === 'sw-throw' || battleState === 'sw-hit') {
    return _updateSWThrowHit();
  } else if (_updateItemMenuFades()) {
    return true;
  } else { return false; }
  return true;
}

function _updateSWThrowHit() {
  if (battleState === 'sw-throw') {
    if (battleTimer >= 250) {
      if (southWindTargets.length === 0) { processNextTurn(); }
      else {
        southWindHitIdx = 0;
        _applySWDamage(southWindTargets[0]);
        battleState = 'sw-hit'; battleTimer = 0;
      }
    }
    return true;
  }
  // sw-hit: explosion 3 phases × 133ms, hold until 700ms
  if (battleTimer >= 700) {
    southWindHitIdx++;
    if (southWindHitIdx < southWindTargets.length) {
      _applySWDamage(southWindTargets[southWindHitIdx]);
      battleTimer = 0;
    } else {
      const killed = isRandomEncounter && encounterMonsters
        ? southWindTargets.filter(i => encounterMonsters[i] && encounterMonsters[i].hp <= 0)
        : [];
      if (killed.length > 0) {
        const waveOrder = [1, 0, 3, 2];
        const ordered = waveOrder.filter(i => killed.includes(i));
        for (const i of killed) { if (!ordered.includes(i)) ordered.push(i); }
        dyingMonsterIndices = new Map(ordered.map((i, n) => [i, n * 60]));
        playSFX(SFX.MONSTER_DEATH);
        battleState = 'monster-death'; battleTimer = 0;
      } else { processNextTurn(); }
    }
  }
  return true;
}

function _updateItemMenuFades() {
  const FADE_DUR = (BATTLE_TEXT_STEPS + 1) * BATTLE_TEXT_STEP_MS;
  if (battleState === 'item-menu-out') {
    if (battleTimer >= FADE_DUR) { battleState = 'item-list-in'; battleTimer = 0; }
  } else if (battleState === 'item-list-in') {
    if (battleTimer >= FADE_DUR) { battleState = 'item-select'; battleTimer = 0; }
  } else if (battleState === 'item-slide') {
    if (battleTimer >= 200) {
      inputSt.itemPage += (inputSt.itemSlideDir < 0) ? 1 : -1;
      inputSt.itemSlideDir = 0; inputSt.itemPageCursor = inputSt.itemSlideCursor; inputSt.itemSlideCursor = 0;
      battleState = 'item-select'; battleTimer = 0;
    }
  } else if (battleState === 'item-cancel-out') {
    if (battleTimer >= FADE_DUR) { battleState = 'item-cancel-in'; battleTimer = 0; }
  } else if (battleState === 'item-cancel-in') {
    if (battleTimer >= FADE_DUR) { inputSt.itemPage = 1; battleState = 'menu-open'; battleTimer = 0; }
  } else if (battleState === 'item-list-out') {
    if (battleTimer >= FADE_DUR) { battleState = 'item-use-menu-in'; battleTimer = 0; }
  } else if (battleState === 'item-use-menu-in') {
    if (battleTimer >= FADE_DUR) { battleState = 'confirm-pause'; battleTimer = 0; }
  } else { return false; }
  return true;
}

function _updateBattleRunSuccess() {
  const T = (BATTLE_TEXT_STEPS + 1) * BATTLE_TEXT_STEP_MS;
  if (battleState === 'run-name-out') {
    if (battleTimer >= T) { sprite.setDirection(DIR_DOWN); playSFX(SFX.RUN_AWAY); battleState = 'run-text-in'; battleTimer = 0; }
  } else if (battleState === 'run-text-in') {
    if (battleTimer >= T) { battleState = 'run-hold'; battleTimer = 0; }
  } else if (battleState === 'run-hold') {
    if (battleTimer >= 1350) { battleState = 'run-text-out'; battleTimer = 0; }
  } else if (battleState === 'run-text-out') {
    if (battleTimer >= T) { runSlideBack = true; battleState = 'encounter-box-close'; battleTimer = 0; }
  } else { return false; }
  return true;
}

function _updateBattleRunFail() {
  const T = (BATTLE_TEXT_STEPS + 1) * 50;
  if (battleState === 'run-fail-name-out') {
    if (battleTimer >= T) { battleState = 'run-fail-text-in'; battleTimer = 0; }
  } else if (battleState === 'run-fail-text-in') {
    if (battleTimer >= T) { battleState = 'run-fail-hold'; battleTimer = 0; }
  } else if (battleState === 'run-fail-hold') {
    if (battleTimer >= 300) { battleState = 'run-fail-text-out'; battleTimer = 0; }
  } else if (battleState === 'run-fail-text-out') {
    if (battleTimer >= T) { battleState = 'run-fail-name-in'; battleTimer = 0; }
  } else if (battleState === 'run-fail-name-in') {
    if (battleTimer >= T) processNextTurn();
  } else { return false; }
  return true;
}

function _updateBattleRun() {
  if (battleState.startsWith('run-fail-')) return _updateBattleRunFail();
  if (battleState.startsWith('run-')) return _updateBattleRunSuccess();
  return false;
}

function _updateAllyDamageShow() {
  if (isRandomEncounter && encounterMonsters && allyTargetIndex >= 0 && encounterMonsters[allyTargetIndex].hp <= 0) {
    dyingMonsterIndices = new Map([[allyTargetIndex, 0]]);
    battleState = 'monster-death'; battleTimer = 0; playSFX(SFX.MONSTER_DEATH);
  } else if (!isRandomEncounter && bossHP <= 0) {
    if (pvpSt.isPVPBattle) { battleState = 'pvp-dissolve'; battleTimer = 0; playSFX(SFX.MONSTER_DEATH); }
    else { battleState = 'boss-dissolve'; battleTimer = 0; playSFX(SFX.BOSS_DEATH); }
  } else {
    const ally = battleAllies[currentAllyAttacker];
    if (!allyHitIsLeft && ally && isWeapon(ally.weaponL)) {
      allyHitIsLeft = true;
      const targetDef = allyTargetIndex >= 0 && encounterMonsters ? encounterMonsters[allyTargetIndex].def
        : pvpSt.isPVPBattle
          ? (pvpSt.pvpPlayerTargetIdx >= 0
              ? (pvpSt.pvpEnemyAllies[pvpSt.pvpPlayerTargetIdx] || pvpSt.pvpOpponentStats).def
              : pvpSt.pvpOpponentStats.def)
          : BOSS_DEF;
      allyHitResult = rollHits(ally.atk, targetDef, 85, 1)[0];
      battleState = 'ally-attack-start'; battleTimer = 0;
    } else {
      allyHitIsLeft = false;
      processNextTurn();
    }
  }
}

function _updateAllyJoin() {
  if (battleState === 'ally-fade-in') {
    const newAlly = battleAllies[battleAllies.length - 1];
    if (newAlly && battleTimer >= 100) {
      newAlly.fadeStep = Math.max(0, newAlly.fadeStep - 1);
      battleTimer = 0;
      if (newAlly.fadeStep <= 0) { turnQueue = buildTurnOrder(); processNextTurn(); }
    }
    return true;
  }
  return false;
}
function _updateAllyAttack() {
  if (battleState === 'ally-attack-start') {
    if (battleTimer >= 100) {
      const ally = battleAllies[currentAllyAttacker];
      const activeWpn = allyHitIsLeft ? (ally && ally.weaponL) : (ally && ally.weaponId);
      const bladed = isBladedWeapon(activeWpn);
      playSFX(bladed ? SFX.KNIFE_HIT : SFX.ATTACK_HIT);
      if (bladed && !(allyHitResult && allyHitResult.crit)) {
        if (sfxCutTimerId) clearTimeout(sfxCutTimerId);
        sfxCutTimerId = setTimeout(() => { stopSFX(); sfxCutTimerId = null; }, 133);
      }
      battleState = 'ally-slash';
      battleTimer = 0;
    }
    return true;
  }
  if (battleState === 'ally-slash') {
    if (battleTimer >= 200) {
      if (allyHitResult && !allyHitResult.miss) {
        if (pvpSt.isPVPBattle && pvpSt.pvpOpponentIsDefending && allyTargetIndex < 0)
          allyHitResult.damage = Math.max(1, Math.floor(allyHitResult.damage / 2));
        if (allyTargetIndex >= 0 && encounterMonsters) {
          encounterMonsters[allyTargetIndex].hp = Math.max(0, encounterMonsters[allyTargetIndex].hp - allyHitResult.damage);
        } else if (allyTargetIndex < 0) {
          bossHP = Math.max(0, bossHP - allyHitResult.damage);
          if (pvpSt.isPVPBattle) pvpSt.pvpBossShakeTimer = BATTLE_SHAKE_MS;
        }
        if (allyHitResult.crit) critFlashTimer = 0;
        bossDamageNum = { value: allyHitResult.damage, crit: allyHitResult.crit, timer: 0 };
        inputSt.targetIndex = allyTargetIndex;
      } else {
        bossDamageNum = { miss: true, timer: 0 };
        inputSt.targetIndex = allyTargetIndex;
      }
      battleState = 'ally-damage-show';
      battleTimer = 0;
    }
    return true;
  }
  return false;
}
function _updateAllyEnemyHit() {
  if (battleState === 'ally-hit') {
    if (battleTimer >= BATTLE_SHAKE_MS) { battleState = 'ally-damage-show-enemy'; battleTimer = 0; }
    return true;
  }
  if (battleState === 'ally-damage-show-enemy') {
    if (battleTimer >= BATTLE_DMG_SHOW_MS) {
      const ally = battleAllies[enemyTargetAllyIdx];
      if (ally && ally.hp <= 0) { battleState = 'ally-ko-fade'; battleTimer = 0; }
      else { enemyTargetAllyIdx = -1; processNextTurn(); }
    }
    return true;
  }
  return false;
}
function _updateAllyKOSequence() {
  if (battleState === 'ally-ko-fade') {
    const koAlly = battleAllies[enemyTargetAllyIdx];
    if (koAlly && battleTimer >= 100) {
      koAlly.fadeStep = Math.min(ROSTER_FADE_STEPS, koAlly.fadeStep + 1);
      battleTimer = 0;
      if (koAlly.fadeStep >= ROSTER_FADE_STEPS) {
        const retreatBytes = _nameToBytes(koAlly.name + ' retreated!');
        showMsgBox(retreatBytes, () => {
          turnQueue = turnQueue.filter(t => !(t.type === 'ally' && t.index === enemyTargetAllyIdx));
          enemyTargetAllyIdx = -1;
          processNextTurn();
        });
        battleState = 'ally-ko-msg';
      }
    }
    return true;
  }
  if (battleState === 'ally-ko-msg') return true;
  return false;
}
function _updateBattleAlly() {
  if (_updateAllyJoin()) return true;
  if (_updateAllyAttack()) return true;
  if (battleState === 'ally-damage-show') { if (battleTimer >= 700) _updateAllyDamageShow(); return true; }
  if (_updateAllyEnemyHit()) return true;
  if (_updateAllyKOSequence()) return true;
  return false;
}

// Enemy turn update
function _processBossFlashEnemy() {
  if (battleState !== 'boss-flash' || battleTimer < BOSS_PREFLASH_MS) return false;
  const livingAllies = battleAllies.filter(a => a.hp > 0);
  let targetAlly = -1;
  if (livingAllies.length > 0) {
    if (Math.random() >= 1 / (1 + livingAllies.length)) {
      const allyOptions = battleAllies.map((a, i) => a.hp > 0 ? i : -1).filter(i => i >= 0);
      targetAlly = allyOptions[Math.floor(Math.random() * allyOptions.length)];
    }
  }
  const hitRate = (currentAttacker >= 0 && encounterMonsters)
    ? (encounterMonsters[currentAttacker].hitRate || GOBLIN_HIT_RATE) : BOSS_HIT_RATE;
  const atk = (currentAttacker >= 0 && encounterMonsters)
    ? encounterMonsters[currentAttacker].atk : BOSS_ATK;
  if (targetAlly >= 0) {
    enemyTargetAllyIdx = targetAlly;
    if (Math.random() * 100 < hitRate) {
      const dmg = calcDamage(atk, battleAllies[targetAlly].def);
      battleAllies[targetAlly].hp = Math.max(0, battleAllies[targetAlly].hp - dmg);
      allyDamageNums[targetAlly] = { value: dmg, timer: 0 };
      allyShakeTimer[targetAlly] = BATTLE_SHAKE_MS;
      playSFX(SFX.ATTACK_HIT); battleState = 'ally-hit'; battleTimer = 0;
    } else {
      allyDamageNums[targetAlly] = { miss: true, timer: 0 };
      battleState = 'ally-damage-show-enemy'; battleTimer = 0;
    }
  } else {
    const shieldEvade = getShieldEvade(ITEMS);
    const shieldBlocked = shieldEvade > 0 && Math.random() * 100 < shieldEvade;
    if (shieldBlocked) {
      playerDamageNum = { miss: true, timer: 0 };
      battleState = 'enemy-damage-show'; battleTimer = 0;
      inputSt.battleProfHits['shield'] = (inputSt.battleProfHits['shield'] || 0) + 1;
    } else if (Math.random() * 100 < hitRate) {
      let dmg = calcDamage(atk, ps.def);
      if (isDefending) dmg = Math.max(1, Math.floor(dmg / 2));
      ps.hp = Math.max(0, ps.hp - dmg);
      playerDamageNum = { value: dmg, timer: 0 };
      playSFX(SFX.ATTACK_HIT);
      battleShakeTimer = BATTLE_SHAKE_MS;
      battleState = 'enemy-attack'; battleTimer = 0;
    } else {
      playerDamageNum = { miss: true, timer: 0 };
      battleState = 'enemy-damage-show'; battleTimer = 0;
    }
  }
  return true;
}
function _processEnemyDamageShowState() {
  if (battleTimer < BATTLE_DMG_SHOW_MS) return;
  if (ps.hp <= 0) {
    isDefending = false; battleState = 'defeat-monster-fade'; battleTimer = 0;
  } else { processNextTurn(); }
}
function _updateBattleEnemyTurn() {
  if (_processBossFlashEnemy()) return true;
  if (battleState === 'enemy-attack') {
    if (battleTimer >= BATTLE_SHAKE_MS) { battleState = 'enemy-damage-show'; battleTimer = 0; }
  } else if (battleState === 'enemy-damage-show') { _processEnemyDamageShowState();
  } else { return false; }
  return true;
}

function _updateBossDissolve(dt) {
  if (battleState !== 'boss-dissolve') return false;
  const dFrame = Math.floor(battleTimer / BOSS_DISSOLVE_FRAME_MS);
  const dBlock = Math.floor(dFrame / BOSS_DISSOLVE_STEPS);
  const prevBlock = Math.floor(Math.floor((battleTimer - dt) / BOSS_DISSOLVE_FRAME_MS) / BOSS_DISSOLVE_STEPS);
  if (dBlock !== prevBlock && dBlock > 0 && (dBlock & 3) === 0) playSFX(SFX.BOSS_DEATH);
  if (battleTimer >= BOSS_BLOCKS * BOSS_DISSOLVE_STEPS * BOSS_DISSOLVE_FRAME_MS) {
    bossDefeated = true; bossSprite = null;
    encounterExpGained = 20; encounterGilGained = 500;
    grantExp(20); ps.gil += encounterGilGained;
    const _bossLv = MONSTERS.get(0xCC)?.level || 4;
    encounterProfLevelUps = gainProficiency(inputSt.battleProfHits, _bossLv); inputSt.battleProfHits = {}; profLevelUpIdx = 0;
    _syncSaveSlotProgress();
    saveSlotsToDB();
    isDefending = false; battleState = 'victory-name-out'; battleTimer = 0;
  }
  return true;
}

function _updateVictorySequence() {
  const _textMs = (BATTLE_TEXT_STEPS + 1) * BATTLE_TEXT_STEP_MS;
  if (battleState === 'victory-name-out') {
    if (battleTimer >= _textMs) { battleState = 'victory-celebrate'; battleTimer = 0; playTrack(TRACKS.VICTORY); }
  } else if (battleState === 'victory-celebrate') {
    if (battleTimer >= 400) { battleState = 'victory-text-in'; battleTimer = 0; }
  } else if (battleState === 'victory-text-in') {
    if (battleTimer >= _textMs) { battleState = 'victory-hold'; battleTimer = 0; }
  } else if (battleState === 'victory-hold') {
    // waits for Z press
  } else if (battleState === 'victory-fade-out') {
    if (battleTimer >= _textMs) { battleState = 'exp-text-in'; battleTimer = 0; }
  } else if (battleState === 'exp-text-in') {
    if (battleTimer >= _textMs) { battleState = 'exp-hold'; battleTimer = 0; }
  } else if (battleState === 'exp-hold') {
    // waits for Z press
  } else if (battleState === 'exp-fade-out') {
    if (battleTimer >= _textMs) { battleState = 'gil-text-in'; battleTimer = 0; }
  } else if (battleState === 'gil-text-in') {
    if (battleTimer >= _textMs) { battleState = 'gil-hold'; battleTimer = 0; }
  } else if (battleState === 'gil-hold') {
    // waits for Z press
  } else if (battleState === 'gil-fade-out') {
    if (battleTimer >= _textMs) { battleState = encounterDropItem !== null ? 'item-text-in' : 'levelup-text-in'; battleTimer = 0; }
  } else if (battleState === 'item-text-in') {
    if (battleTimer >= _textMs) { battleState = 'item-hold'; battleTimer = 0; }
  } else if (battleState === 'item-hold') {
    // waits for Z press
  } else if (battleState === 'item-fade-out') {
    if (battleTimer >= _textMs) { battleState = 'levelup-text-in'; battleTimer = 0; }
  } else if (battleState === 'levelup-text-in') {
    if (battleTimer >= _textMs) { battleState = 'levelup-hold'; battleTimer = 0; }
  } else if (battleState === 'levelup-hold') {
    // waits for Z press
  } else if (battleState === 'prof-levelup-text-in') {
    if (battleTimer >= _textMs) { battleState = 'prof-levelup-hold'; battleTimer = 0; }
  } else if (battleState === 'prof-levelup-hold') {
    // waits for Z press
  } else if (battleState === 'victory-text-out') {
    if (battleTimer >= _textMs) { battleState = 'victory-menu-fade'; battleTimer = 0; }
  } else if (battleState === 'victory-menu-fade') {
    if (battleTimer >= _textMs) { battleState = 'victory-box-close'; battleTimer = 0; }
  } else if (battleState === 'victory-box-close') {
    if (battleTimer >= VICTORY_BOX_ROWS * VICTORY_ROW_FRAME_MS) {
      battleState = isRandomEncounter ? 'encounter-box-close' : 'boss-box-close'; battleTimer = 0;
    }
  } else { return false; }
  return true;
}

function _updateBoxClose() {
  if (battleState === 'encounter-box-close') {
    if (battleTimer >= BOSS_BOX_EXPAND_MS) {
      battleState = 'none'; battleTimer = 0; runSlideBack = false;
      sprite.setDirection(DIR_DOWN); isRandomEncounter = false; encounterMonsters = null;
      dyingMonsterIndices = new Map(); battleAllies = []; allyJoinRound = 0;
      stopMusic(); resumeMusic();
    }
    return true;
  }
  if (battleState === 'boss-box-close') {
    if (battleTimer >= BOSS_BOX_EXPAND_MS) {
      const wasPVP = pvpSt.isPVPBattle;
      resetPVPState();
      battleState = 'none'; battleTimer = 0; sprite.setDirection(DIR_DOWN);
      battleAllies = []; allyJoinRound = 0;
      if (!wasPVP) playTrack(TRACKS.CRYSTAL_ROOM);
      else resumeMusic();
    }
    return true;
  }
  return false;
}

function _updateDefeatStates() {
  if (battleState === 'defeat-monster-fade') {
    stopMusic();
    if (battleTimer >= 500) { battleState = 'defeat-text'; battleTimer = 0; }
    return true;
  }
  if (battleState === 'defeat-text') return true; // Z to dismiss handled in handleInput
  if (battleState === 'defeat-close') {
    if (battleTimer >= BOSS_BOX_EXPAND_MS) {
      resetPVPState();
      battleState = 'none'; battleTimer = 0;
      isRandomEncounter = false;
      encounterMonsters = null; turnQueue = []; battleAllies = []; allyJoinRound = 0;
      ps.hp = ps.stats ? ps.stats.maxHP : 28;
      ps.mp = ps.stats ? ps.stats.maxMP : 0;
      _triggerWipe(() => {
        dungeonFloor = -1; encounterSteps = 0; mapStack = [];
        loadWorldMapAt(findWorldExitIndex(111, worldMapData));
      }, 'world');
    }
    return true;
  }
  return false;
}

function _updateBattleEndSequence(dt) {
  return _updateBossDissolve(dt) || _updateVictorySequence() || _updateBoxClose() || _updateDefeatStates();
}

function updateBattle(dt) {
  if (battleState === 'none') return;
  battleTimer += Math.min(dt, 33);
  if (pvpSt.isPVPBattle) { updatePVPBattle(dt, _pvpShared()); return; }
  _updateBattleTimers(dt);
  _updateBattleOpening()      ||
  _updateBattleMenuConfirm()  ||
  _updateBattlePlayerAttack() ||
  _updateBattleDefendItem(dt) ||
  _updateBattleRun()          ||
  _updateBattleAlly()         ||
  _updateBattleEnemyTurn()    ||
  _updateBattleEndSequence(dt);
}

function drawSWExplosion() {
  // PVP opponent South Wind — explosion centered on player portrait
  if (pvpSt.isPVPBattle && battleState === 'pvp-opp-sw-hit') {
    if (!swPhaseCanvases.length) return;
    const phase = Math.min(2, Math.floor(battleTimer / 133));
    const canvas = swPhaseCanvases[phase];
    if (!canvas) return;
    const cx = HUD_RIGHT_X + 8 + 8;   // portrait left + half portrait width
    const cy = HUD_VIEW_Y + 8 + 12;   // portrait top + half portrait height
    const half = canvas.width / 2;
    // Clip to full HUD view height (not just viewport — portrait is in right panel x>144)
    ctx.save();
    ctx.beginPath(); ctx.rect(0, HUD_VIEW_Y, CANVAS_W, HUD_VIEW_H); ctx.clip();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(canvas, cx - half, cy - half);
    ctx.restore();
    return;
  }
  if (battleState !== 'sw-hit') return;
  if (!swPhaseCanvases.length || !isRandomEncounter || !encounterMonsters) return;

  const { count, boxX, boxY, sprH, gridPos: swGridPos } = _encounterGridLayout();

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
  const { count, boxX, boxY, gridPos: swGridPos } = _encounterGridLayout();
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

function _getPortraitSrc(isNearFatal, isAttackPose, isHitPose, isDefendPose, isItemUsePose, isVictoryPose) {
  let src = (isNearFatal && battleSpriteKneelCanvas) ? battleSpriteKneelCanvas : battleSpriteCanvas;
  if (isAttackPose) {
    const _ws = weaponSubtype(getHitWeapon(currentHitIdx));
    if (_ws === 'knife' || _ws === 'dagger') {
      src = (isHitRightHand(currentHitIdx) ? battleSpriteKnifeRCanvas : battleSpriteKnifeLCanvas) || src;
    } else if (battleState === 'attack-start') {
      src = (isHitRightHand(currentHitIdx) ? battleSpriteAttackCanvas : battleSpriteAttackLCanvas) || src;
    }
  } else if ((isDefendPose || isItemUsePose) && battleSpriteDefendCanvas) {
    src = battleSpriteDefendCanvas;
  } else if (isHitPose && battleSpriteHitCanvas) {
    src = battleSpriteHitCanvas;
  } else if (isVictoryPose && battleSpriteVictoryCanvas) {
    if (Math.floor(Date.now() / 250) & 1) src = battleSpriteVictoryCanvas;
  }
  return src;
}

function _drawPortraitFrame(px, py, portraitSrc, isRunPose) {
  if (isRunPose) {
    let slideX = 0;
    if (battleState === 'run-text-in') slideX = Math.min(battleTimer / 300, 1) * 20;
    else if (battleState === 'run-hold' || battleState === 'run-text-out') slideX = 20;
    ctx.save();
    ctx.beginPath();
    ctx.rect(HUD_RIGHT_X + 8, HUD_VIEW_Y + 8, 16, 16);
    ctx.clip();
    ctx.translate(px + 16 + slideX, py);
    ctx.scale(-1, 1);
    ctx.drawImage(portraitSrc, 0, 0);
    ctx.restore();
  } else if (battleState === 'encounter-box-close' && runSlideBack) {
    const t = Math.min(battleTimer / 300, 1);
    ctx.save();
    ctx.beginPath();
    ctx.rect(HUD_RIGHT_X + 8, HUD_VIEW_Y + 8, 16, 16);
    ctx.clip();
    ctx.drawImage(portraitSrc, px, py + (1 - t) * 20);
    ctx.restore();
  } else {
    ctx.drawImage(portraitSrc, px, py);
  }
}

function _drawPortraitWeapon(px, py, before) {
  // before=true: back-swing blade BEHIND body; false: front blade IN FRONT or swung
  const handWeapon = getHitWeapon(currentHitIdx);
  const wpnSt = weaponSubtype(handWeapon);
  if (battleState === 'attack-start') {
    const rightHand = isHitRightHand(currentHitIdx);
    if (before && rightHand) {
      if (wpnSt === 'knife' && handWeapon === 0x1F && battleDaggerBladeCanvas) ctx.drawImage(battleDaggerBladeCanvas, px + 8, py - 7);
      else if (wpnSt === 'knife' && battleKnifeBladeCanvas) ctx.drawImage(battleKnifeBladeCanvas, px + 8, py - 7);
      else if (wpnSt === 'sword' && battleSwordBladeCanvas) ctx.drawImage(battleSwordBladeCanvas, px + 8, py - 7);
    } else if (!before && !rightHand) {
      if (wpnSt === 'knife' && handWeapon === 0x1F && battleDaggerBladeCanvas) ctx.drawImage(battleDaggerBladeCanvas, px + 16, py - 7);
      else if (wpnSt === 'knife' && battleKnifeBladeCanvas) ctx.drawImage(battleKnifeBladeCanvas, px + 16, py - 7);
      else if (wpnSt === 'sword' && battleSwordBladeCanvas) ctx.drawImage(battleSwordBladeCanvas, px + 16, py - 7);
    }
  } else if (!before && battleState === 'player-slash') {
    if (wpnSt === 'knife' && handWeapon === 0x1F && battleDaggerBladeSwungCanvas) ctx.drawImage(battleDaggerBladeSwungCanvas, px - 16, py + 1);
    else if (wpnSt === 'knife' && battleKnifeBladeSwungCanvas) ctx.drawImage(battleKnifeBladeSwungCanvas, px - 16, py + 1);
    else if (wpnSt === 'sword' && battleSwordBladeSwungCanvas) ctx.drawImage(battleSwordBladeSwungCanvas, px - 16, py + 1);
    else if (!wpnSt && handWeapon === 0 && battleFistCanvas) ctx.drawImage(battleFistCanvas, px - 4, py + 10);
  }
}

function _drawPortraitOverlays(px, py, isDefendPose, isItemUsePose, isNearFatal, isRunPose,
                                isAttackPose, isHitPose, isVictoryPose) {
  // Defend sparkle — 4 corners cycling during defend-anim
  if (isDefendPose && defendSparkleFrames.length === 4) {
    const fi = Math.min(3, Math.floor(battleTimer / DEFEND_SPARKLE_FRAME_MS));
    const frame = defendSparkleFrames[fi];
    _drawSparkleCorners(frame, px, py);
  }
  // Cure sparkle — alternating flips every 67ms during item-use
  if (battleState === 'item-use' && cureSparkleFrames.length === 2 && !(inputSt.playerActionPending && inputSt.playerActionPending.allyIndex >= 0)) {
    const fi = Math.floor(battleTimer / 67) & 1;
    const frame = cureSparkleFrames[fi];
    _drawSparkleCorners(frame, px, py);
  }
  // Near-fatal sweat — 2 frames alternating every 133ms, 3px above portrait
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
      ctx.save();
      ctx.beginPath();
      ctx.rect(HUD_RIGHT_X + 8, HUD_VIEW_Y + 8 - 3, 16, 19);
      ctx.clip();
      ctx.drawImage(sweatFrames[sweatIdx], px, py - 3 + (1 - t) * 20);
      ctx.restore();
    } else {
      ctx.drawImage(sweatFrames[sweatIdx], px, py - 3);
    }
  }
  // Item target cursor on player portrait (only when not targeting an ally)
  if (battleState === 'item-target-select' && inputSt.itemTargetType === 'player' && inputSt.itemTargetAllyIndex < 0 && cursorTileCanvas) {
    ctx.drawImage(cursorTileCanvas, px - 12, py + 4);
  }
  // Enemy slash effect on player portrait during PVP melee attack swing
  if (battleState === 'pvp-enemy-slash') {
    const eWpnId = pvpSt.pvpCurrentEnemyAllyIdx >= 0
      ? pvpSt.pvpEnemyAllies[pvpSt.pvpCurrentEnemyAllyIdx]?.weaponId
      : pvpSt.pvpOpponentStats?.weaponId;
    const eSlashF = getSlashFramesForWeapon(eWpnId, true);
    const af = Math.min(2, Math.floor(battleTimer / 67));
    if (eSlashF && eSlashF[af]) {
      const sf = eSlashF[af];
      ctx.save();
      ctx.translate(px + sf.width + [-0, -10, 8][af], py + [0, -6, 8][af]);
      ctx.scale(-1, 1);
      ctx.drawImage(sf, 0, 0);
      ctx.restore();
    }
  }
}

function _drawBattlePortrait() {
  const shakeOff = ((battleState === 'enemy-attack' || battleState === 'pvp-opp-sw-hit') && battleShakeTimer > 0)
    ? (Math.floor(battleShakeTimer / 67) & 1 ? 2 : -2) : 0;
  const isVictoryPose = _isVictoryBattleState();
  const isAttackPose = battleState === 'attack-start' || battleState === 'player-slash';
  const isHitPose = battleState === 'enemy-attack' ||
    (battleState === 'enemy-damage-show' && playerDamageNum && !playerDamageNum.miss) ||
    battleState === 'pvp-opp-sw-hit' ||
    (battleState === 'pvp-enemy-slash' && pvpSt.pvpPendingAttack && !pvpSt.pvpPendingAttack.miss && !pvpSt.pvpPendingAttack.shieldBlock);
  const isDefendPose = battleState === 'defend-anim';
  const isItemUsePose = battleState === 'item-use' || battleState === 'sw-throw' || battleState === 'sw-hit';
  const isRunPose = battleState === 'run-name-out' || battleState === 'run-text-in' ||
    battleState === 'run-hold' || battleState === 'run-text-out';
  const isNearFatal = ps.hp > 0 && ps.stats && ps.hp <= Math.floor(ps.stats.maxHP / 4);
  const portraitSrc = _getPortraitSrc(isNearFatal, isAttackPose, isHitPose, isDefendPose, isItemUsePose, isVictoryPose);
  if (!portraitSrc) return;
  const px = HUD_RIGHT_X + 8 + shakeOff;
  const py = HUD_VIEW_Y + 8;
  // Blink portrait when enemy slash is landing (mirrors opponent blink on player hit)
  const portraitBlink = battleState === 'pvp-enemy-slash' &&
    pvpSt.pvpPendingAttack && !pvpSt.pvpPendingAttack.miss && !pvpSt.pvpPendingAttack.shieldBlock &&
    (Math.floor(battleTimer / 60) & 1);
  if (!portraitBlink) {
    if (isAttackPose) _drawPortraitWeapon(px, py, true);
    _drawPortraitFrame(px, py, portraitSrc, isRunPose);
    if (isAttackPose) _drawPortraitWeapon(px, py, false);
  }
  _drawPortraitOverlays(px, py, isDefendPose, isItemUsePose, isNearFatal, isRunPose, isAttackPose, isHitPose, isVictoryPose);
}

function _drawBattleCritFlash() {
  if (critFlashTimer < 0) return;
  if (critFlashTimer === 0) critFlashTimer = Date.now();
  if (Date.now() - critFlashTimer < 17) {
    _clipToViewport();
    ctx.fillStyle = '#DAA336';
    ctx.fillRect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);
    ctx.restore();
  } else { critFlashTimer = -1; }
}
function _drawBattleStrobeFlash() {
  if (battleState !== 'flash-strobe') return;
  if (!(Math.floor(battleTimer / BATTLE_FLASH_FRAME_MS) & 1)) return;
  _clipToViewport();
  _grayViewport();
}
function _drawBattleDefeat() {
  const ecx = HUD_VIEW_X + HUD_VIEW_W / 2;
  const ecy = HUD_VIEW_Y + HUD_VIEW_H / 2;
  if (battleState === 'defeat-monster-fade') {
    ctx.save();
    ctx.globalAlpha = Math.min(battleTimer / 500, 1);
    ctx.fillStyle = '#000';
    if (isRandomEncounter && encounterMonsters) {
      const { fullW: fw, fullH: fh } = _encounterBoxDims();
      ctx.fillRect(Math.round(ecx - fw / 2) + 8, Math.round(ecy - fh / 2) + 8, fw - 16, fh - 16);
    } else {
      if (!pvpSt.isPVPBattle) ctx.fillRect(ecx - 24, ecy - 24, 48, 48);
    }
    ctx.restore();
  }
  if (battleState === 'defeat-text') {
    const tw = measureText(BATTLE_GAME_OVER);
    drawText(ctx, Math.floor(ecx - tw / 2), Math.floor(ecy - 4), BATTLE_GAME_OVER, TEXT_WHITE);
  }
}
function drawBattle() {
  if (battleState === 'none') return;
  _drawBattleCritFlash();
  _drawBattlePortrait();
  _drawBattleStrobeFlash();
  drawEncounterBox();
  drawBossSpriteBox();
  drawBattleMenu();
  drawBattleMessage();
  drawVictoryBox();
  drawDamageNumbers();
  _drawBattleDefeat();
}

// drawRoarBox removed — now uses universal msgBox

function _drawBattleItemList(baseX, rightAreaW, invPal, slidePixel, totalInvPages) {
  const rowH = 14;
  const topY = HUD_BOT_Y + 12;
  ctx.save();
  ctx.beginPath();
  ctx.rect(baseX - 8, HUD_BOT_Y + 8, rightAreaW + 8, HUD_BOT_H - 16);
  ctx.clip();
  for (let pg = 0; pg <= 1 + totalInvPages; pg++) {
    const pageOff = (pg - inputSt.itemPage) * rightAreaW + slidePixel;
    const px = baseX + pageOff;
    if (px > baseX + rightAreaW || px < baseX - rightAreaW) continue;
    if (pg === 0) {
      const RH_LABEL = new Uint8Array([0x9B,0x91,0xFF]);
      const LH_LABEL = new Uint8Array([0x95,0x91,0xFF]);
      const rName = ps.weaponR !== 0 ? getItemNameClean(ps.weaponR) : new Uint8Array([0xC2,0xC2,0xC2]);
      const rRow = new Uint8Array(RH_LABEL.length + rName.length);
      rRow.set(RH_LABEL, 0); rRow.set(rName, RH_LABEL.length);
      drawText(ctx, px + 8, topY, rRow, invPal);
      const lName = ps.weaponL !== 0 ? getItemNameClean(ps.weaponL) : new Uint8Array([0xC2,0xC2,0xC2]);
      const lRow = new Uint8Array(LH_LABEL.length + lName.length);
      lRow.set(LH_LABEL, 0); lRow.set(lName, LH_LABEL.length);
      drawText(ctx, px + 8, topY + rowH + 6, lRow, invPal);
    } else {
      const startIdx = (pg - 1) * INV_SLOTS;
      for (let r = 0; r < INV_SLOTS; r++) {
        const idx = startIdx + r;
        if (idx >= inputSt.itemSelectList.length) break;
        const item = inputSt.itemSelectList[idx];
        if (!item) continue;
        const nameBytes = getItemNameClean(item.id);
        const countStr = String(item.count);
        const rowBytes = _buildItemRowBytes(nameBytes, countStr);
        drawText(ctx, px + 8, topY + r * rowH, rowBytes, invPal);
      }
    }
  }
  ctx.restore();
}
function _drawBattleItemCursors(baseX) {
  if (!cursorTileCanvas || battleState !== 'item-select') return;
  const rowH = 14;
  const topY = HUD_BOT_Y + 12;
  const rowY = (page, row) => page === 0 ? topY + row * (rowH + 6) : topY + row * rowH;
  const curPx = baseX - 8;
  if (inputSt.itemHeldIdx !== -1) {
    const heldIsEq = inputSt.itemHeldIdx <= -100;
    const heldPage = heldIsEq ? 0 : 1 + Math.floor(inputSt.itemHeldIdx / INV_SLOTS);
    const heldRow  = heldIsEq ? -(inputSt.itemHeldIdx + 100) : inputSt.itemHeldIdx % INV_SLOTS;
    if (heldPage === inputSt.itemPage) ctx.drawImage(cursorTileCanvas, curPx, rowY(heldPage, heldRow) - 4);
  }
  const activeX = inputSt.itemHeldIdx !== -1 ? curPx - 4 : curPx;
  ctx.drawImage(cursorTileCanvas, activeX, rowY(inputSt.itemPage, inputSt.itemPageCursor) - 4);
}
function _drawBattleItemPanel(menuX) {
  const ITEM_SLIDE_MS = 200;
  const rightAreaW = CANVAS_W - BATTLE_PANEL_W - 8;
  const invPal = [0x0F, 0x0F, 0x0F, 0x30];
  let invFadeStep = 0;
  if (battleState === 'item-list-in') invFadeStep = BATTLE_TEXT_STEPS - Math.min(Math.floor(battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
  else if (battleState === 'item-cancel-out' || battleState === 'item-list-out') invFadeStep = Math.min(Math.floor(battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
  for (let s = 0; s < invFadeStep; s++) invPal[3] = nesColorFade(invPal[3]);
  const totalInvPages = Math.max(1, Math.ceil(inputSt.itemSelectList.length / INV_SLOTS));
  let slidePixel = 0;
  if (battleState === 'item-slide') slidePixel = inputSt.itemSlideDir * Math.min(battleTimer / ITEM_SLIDE_MS, 1) * rightAreaW;
  _drawBattleItemList(menuX, rightAreaW, invPal, slidePixel, totalInvPages);
  _drawBattleItemCursors(menuX);
}
function _battleMenuStates() {
  const bs = battleState;
  const isSlide   = bs === 'boss-box-expand' || bs === 'encounter-box-expand';
  const isAppear  = bs === 'boss-appear' || bs === 'monster-slide-in';
  const isFade    = bs === 'battle-fade-in';
  const isMenu    = isFade || bs === 'menu-open' || bs === 'target-select' || bs === 'confirm-pause' ||
    bs === 'attack-start' || bs === 'player-slash' || bs === 'player-hit-show' || bs === 'player-miss-show' ||
    bs === 'player-damage-show' || bs === 'monster-death' || bs === 'defend-anim' ||
    bs.startsWith('item-') || bs === 'sw-throw' || bs === 'sw-hit' ||
    bs === 'run-name-out' || bs === 'run-text-in' || bs === 'run-hold' || bs === 'run-text-out' ||
    bs === 'run-fail-name-out' || bs === 'run-fail-text-in' || bs === 'run-fail-hold' ||
    bs === 'run-fail-text-out' || bs === 'run-fail-name-in' || bs === 'boss-flash' ||
    bs === 'enemy-attack' || bs === 'enemy-damage-show' || bs === 'pvp-second-windup' ||
    bs === 'pvp-ally-appear' || bs === 'pvp-defend-anim' || bs === 'pvp-enemy-slash' ||
    bs === 'pvp-opp-potion' || bs === 'pvp-opp-sw-throw' || bs === 'pvp-opp-sw-hit' || bs === 'message-hold' ||
    bs.startsWith('ally-') || bs === 'boss-dissolve' ||
    bs === 'defeat-monster-fade' || bs === 'defeat-text';
  const isVictory = _isVictoryBattleState() || bs === 'victory-name-out' || bs === 'encounter-box-close' || bs === 'boss-box-close' || bs === 'defeat-close';
  const isRunBox  = bs.startsWith('run-');
  const isClose   = bs === 'victory-box-close' || bs === 'encounter-box-close' || bs === 'boss-box-close' || bs === 'defeat-close';
  return { isSlide, isAppear, isFade, isMenu, isVictory, isRunBox, isClose };
}
function drawBattleMenu() {
  const { isSlide, isAppear, isFade, isMenu, isVictory, isRunBox, isClose } = _battleMenuStates();
  if (!isSlide && !isAppear && !isMenu && !isVictory) return;

  let panelOffX = 0;
  if (isSlide) panelOffX = Math.round(-CANVAS_W * (1 - Math.min(battleTimer / BOSS_BOX_EXPAND_MS, 1)));
  else if (isClose) panelOffX = Math.round(-CANVAS_W * Math.min(battleTimer / (VICTORY_BOX_ROWS * VICTORY_ROW_FRAME_MS), 1));

  ctx.save();
  ctx.beginPath(); ctx.rect(8, HUD_BOT_Y, CANVAS_W - 16, HUD_BOT_H); ctx.clip();
  ctx.translate(panelOffX, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(8, HUD_BOT_Y + 8, CANVAS_W - 16, HUD_BOT_H - 16);

  const boxW = BATTLE_PANEL_W, boxH = HUD_BOT_H;
  if ((!isVictory && !isRunBox) || (battleState === 'encounter-box-close' && runSlideBack))
    _drawBorderedBox(0, HUD_BOT_Y, boxW, boxH);
  if (!isMenu && !isVictory) { ctx.restore(); return; }

  let fadeStep = 0;
  if (isFade) fadeStep = BATTLE_TEXT_STEPS - Math.min(Math.floor(battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
  const fadedPal = _makeFadedPal(fadeStep);
  if (!isVictory && !isRunBox) {
    if (pvpSt.isPVPBattle) {
      // Collect all living PVP enemy names and stack them
      const names = [];
      if (!bossDefeated && pvpSt.pvpPlayerTargetIdx < 0 && pvpSt.pvpOpponentStats)
        names.push(_nameToBytes(pvpSt.pvpOpponentStats.name));
      for (let i = 0; i < pvpSt.pvpEnemyAllies.length; i++) {
        const a = pvpSt.pvpEnemyAllies[i];
        if (a && a.hp > 0 && i >= pvpSt.pvpPlayerTargetIdx)
          names.push(_nameToBytes(a.name));
      }
      const rowH = 10;
      const startY = HUD_BOT_Y + Math.floor((boxH - names.length * rowH) / 2);
      names.forEach((nb, i) => {
        drawText(ctx, Math.floor((boxW - measureText(nb)) / 2), startY + i * rowH, nb, fadedPal);
      });
    } else {
      const enemyName = _battleEnemyName();
      drawText(ctx, Math.floor((boxW - measureText(enemyName)) / 2), HUD_BOT_Y + Math.floor((boxH - 8) / 2), enemyName, fadedPal);
    }
  }
  const menuX = boxW + 8;
  const positions = [[menuX, HUD_BOT_Y+16], [menuX+56, HUD_BOT_Y+16], [menuX, HUD_BOT_Y+32], [menuX+56, HUD_BOT_Y+32]];
  _drawBattleMenuItems(positions, isVictory, isClose, isFade, fadedPal, menuX);
  _drawBattleMenuCursor(positions, isFade, fadeStep);
  ctx.restore();
}

function _drawBattleMenuItems(positions, isVictory, isClose, isFade, fadedPal, menuX) {
  const isMenuFade = battleState === 'victory-menu-fade';
  const isItemMenuOut = battleState === 'item-menu-out';
  const isItemMenuIn = battleState === 'item-cancel-in' || battleState === 'item-use-menu-in';
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
    for (let i = 0; i < BATTLE_MENU_ITEMS.length; i++)
      drawText(ctx, positions[i][0], positions[i][1], BATTLE_MENU_ITEMS[i], menuPal);
  }
  if (isItemShowInv) _drawBattleItemPanel(menuX);
}

function _drawBattleMenuCursor(positions, isFade, fadeStep) {
  if (!cursorTileCanvas) return;
  if (battleState !== 'menu-open' && !isFade) return;
  if (battleState === 'target-select') return;
  const curX = positions[inputSt.battleCursor][0] - 16;
  const curY = positions[inputSt.battleCursor][1] - 4;
  _drawCursorFaded(curX, curY, fadeStep);
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


function _drawEncounterMonsters(gridPos, sprH, boxX, boxY, boxW, boxH, isSlideIn, fullW, slotCenterY) {
  if (!goblinBattleCanvas && monsterBattleCanvas.size === 0) return;
  let slideOffX = 0;
  if (isSlideIn) slideOffX = Math.floor((1 - Math.min(battleTimer / MONSTER_SLIDE_MS, 1)) * (fullW + 32));

  ctx.save();
  ctx.beginPath();
  ctx.rect(boxX + 8, boxY + 8, boxW - 16, boxH - 16);
  ctx.clip();
  ctx.imageSmoothingEnabled = false;

  const count = encounterMonsters.length;
  for (let i = 0; i < count; i++) {
    const alive = encounterMonsters[i].hp > 0;
    const isDying = dyingMonsterIndices.has(i) && battleState === 'monster-death';
    const isBeingHit = (i === inputSt.targetIndex &&
      (battleState === 'player-slash' || battleState === 'player-hit-show' ||
       battleState === 'player-miss-show' || battleState === 'player-damage-show')) ||
      (i === allyTargetIndex && (battleState === 'ally-slash' || battleState === 'ally-damage-show')) ||
      (battleState === 'sw-hit' && southWindTargets.includes(i));
    if (!alive && !isDying && !isBeingHit) continue;

    const pos = gridPos[i];
    const drawX = pos.x - slideOffX;
    const mid = encounterMonsters[i].monsterId;
    const sprNormal = monsterBattleCanvas.get(mid) || goblinBattleCanvas;
    const sprWhite  = monsterWhiteCanvas.get(mid)  || goblinWhiteCanvas;
    const thisH = sprNormal ? sprNormal.height : sprH;
    const drawY = pos.y + (sprH - thisH);

    if (isDying) {
      const delay = dyingMonsterIndices.get(i) || 0;
      _drawMonsterDeath(drawX, drawY, thisH, Math.min(Math.max(0, battleTimer - delay) / MONSTER_DEATH_MS, 1), mid);
    } else {
      const curHit = inputSt.hitResults && inputSt.hitResults[currentHitIdx];
      const isHitBlink = (isBeingHit && battleState === 'player-slash' && curHit && !curHit.miss && (Math.floor(battleTimer / 60) & 1)) ||
                         (isBeingHit && battleState === 'ally-slash' && allyHitResult && !allyHitResult.miss && (Math.floor(battleTimer / 60) & 1));
      const isFlashing = battleState === 'boss-flash' && currentAttacker === i && Math.floor(battleTimer / 33) % 2 === 1;
      if (!isHitBlink) ctx.drawImage(isFlashing ? sprWhite : sprNormal, drawX, drawY);
    }
  }

  _drawEncounterSlashEffects(gridPos, slideOffX, slotCenterY);
  ctx.restore();
}
function _drawEncounterSlashEffects(gridPos, slideOffX, slotCenterY) {
  if (battleState === 'player-slash' && slashFrames && slashFrame < SLASH_FRAMES && inputSt.hitResults && inputSt.hitResults[currentHitIdx] && !inputSt.hitResults[currentHitIdx].miss) {
    const pos = gridPos[inputSt.targetIndex];
    ctx.drawImage(slashFrames[slashFrame], pos.x - slideOffX + slashOffX + 8, slotCenterY(inputSt.targetIndex) + slashOffY);
  }
  if (battleState === 'ally-slash' && allyHitResult && !allyHitResult.miss) {
    const ally = battleAllies[currentAllyAttacker];
    const allySlashFrames = ally ? getSlashFramesForWeapon(ally.weaponId, true) : slashFramesR;
    const af = Math.min(Math.floor(battleTimer / 67), 2);
    const pos = gridPos[allyTargetIndex];
    if (pos && allySlashFrames && allySlashFrames[af]) {
      const scatterX = [0, 10, -8][af], scatterY = [0, -6, 8][af];
      ctx.drawImage(allySlashFrames[af], pos.x + 8 + scatterX, slotCenterY(allyTargetIndex) + scatterY);
    }
  }
}

function _drawEncounterCursors(gridPos, count, slotCenterY) {
  if (!(battleState === 'target-select' || (battleState === 'item-target-select' && inputSt.itemTargetType === 'enemy')) || !cursorTileCanvas) return;
  if (battleState === 'target-select') {
    const pos = gridPos[inputSt.targetIndex];
    ctx.drawImage(cursorTileCanvas, pos.x - 10, slotCenterY(inputSt.targetIndex) - 4);
  } else if (inputSt.itemTargetMode === 'single') {
    const pos = gridPos[inputSt.itemTargetIndex];
    if (pos) ctx.drawImage(cursorTileCanvas, pos.x - 10, slotCenterY(inputSt.itemTargetIndex) - 4);
  } else if (Math.floor(Date.now() / 133) & 1) {
    const _rightCols = count === 1 ? [0] : count === 2 ? [1] : [1, 3];
    const _leftCols  = count === 2 ? [0] : count >= 3 ? [0, 2] : [];
    let targets = [];
    if (inputSt.itemTargetMode === 'all') targets = encounterMonsters.map((m, i) => m.hp > 0 ? i : -1).filter(i => i >= 0);
    else if (inputSt.itemTargetMode === 'col-right') targets = _rightCols.filter(i => i < count && encounterMonsters[i]?.hp > 0);
    else if (inputSt.itemTargetMode === 'col-left') targets = _leftCols.filter(i => i < count && encounterMonsters[i]?.hp > 0);
    for (const ti of targets) if (gridPos[ti]) ctx.drawImage(cursorTileCanvas, gridPos[ti].x - 10, slotCenterY(ti) - 4);
  }
}

function _isEncounterCombatState() {
  return battleState === 'monster-slide-in' || battleState === 'battle-fade-in' || battleState === 'menu-open' ||
    battleState === 'target-select' || battleState === 'confirm-pause' || battleState === 'attack-start' ||
    battleState === 'player-slash' || battleState === 'player-hit-show' || battleState === 'player-miss-show' ||
    battleState === 'player-damage-show' || battleState === 'monster-death' || battleState === 'defend-anim' ||
    battleState.startsWith('item-') || battleState === 'sw-throw' || battleState === 'sw-hit' ||
    battleState === 'run-name-out' || battleState === 'run-text-in' || battleState === 'run-hold' ||
    battleState === 'run-text-out' || battleState === 'run-fail-name-out' || battleState === 'run-fail-text-in' ||
    battleState === 'run-fail-hold' || battleState === 'run-fail-text-out' || battleState === 'run-fail-name-in' ||
    battleState === 'boss-flash' || battleState === 'enemy-attack' || battleState === 'enemy-damage-show' ||
    battleState === 'message-hold' || battleState.startsWith('ally-') ||
    battleState === 'defeat-monster-fade' || battleState === 'defeat-text';
}
function drawEncounterBox() {
  if (!isRandomEncounter || !encounterMonsters) return;
  const isExpand = battleState === 'encounter-box-expand';
  const isClose = battleState === 'encounter-box-close' || battleState === 'defeat-close';
  const isSlideIn = battleState === 'monster-slide-in';
  const isCombat = _isEncounterCombatState();
  const isVictory = _isVictoryBattleState() || battleState === 'victory-name-out';
  if (!isExpand && !isClose && !isCombat && !isVictory) return;

  const count = encounterMonsters.length;
  const { fullW, fullH, sprH } = _encounterBoxDims();
  const centerX = HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2);
  const centerY = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2);

  const { boxW, boxH } = _calcBoxExpandSize(fullW, fullH, isExpand, isClose, battleTimer);
  const boxX = centerX - Math.floor(boxW / 2);
  const boxY = centerY - Math.floor(boxH / 2);

  _clipToViewport();
  _drawBorderedBox(boxX, boxY, boxW, boxH);

  if (isExpand || isClose || battleState === 'defeat-text') { ctx.restore(); return; }

  const gridPos = _encounterGridPos(boxX, boxY, fullW, fullH, count, sprH);
  const slotCenterY = (idx) => {
    if (!gridPos[idx] || !encounterMonsters[idx]) return 0;
    const c = monsterBattleCanvas.get(encounterMonsters[idx].monsterId) || goblinBattleCanvas;
    const h = c ? c.height : sprH;
    return gridPos[idx].y + (sprH - h) + Math.floor(h / 2);
  };
  _drawEncounterMonsters(gridPos, sprH, boxX, boxY, boxW, boxH, isSlideIn, fullW, slotCenterY);
  _drawEncounterCursors(gridPos, count, slotCenterY);
  ctx.restore();
}

function _drawBossSprite(centerX, centerY) {
  const sprX = centerX - 24, sprY = centerY - 24;
  ctx.imageSmoothingEnabled = false;
  if (battleState === 'boss-appear' || battleState === 'boss-dissolve') {
    _drawDissolvedSprite(sprX, sprY, battleState === 'boss-dissolve');
  } else if (battleState === 'boss-flash') {
    const frame = Math.floor(battleTimer / (BOSS_PREFLASH_MS / 8));
    if (!bossDefeated) ctx.drawImage((frame & 1) ? (landTurtleWhiteCanvas || landTurtleBattleCanvas) : landTurtleBattleCanvas, sprX, sprY);
  } else if (battleState === 'player-slash') {
    if (!(Math.floor(battleTimer / 60) & 1) && !bossDefeated) ctx.drawImage(landTurtleBattleCanvas, sprX, sprY);
    if (slashFrames && slashFrame < SLASH_FRAMES && !bossDefeated && inputSt.hitResults && inputSt.hitResults[currentHitIdx] && !inputSt.hitResults[currentHitIdx].miss)
      ctx.drawImage(slashFrames[slashFrame], centerX - 8 + slashOffX, centerY - 8 + slashOffY);
  } else if (battleState === 'ally-slash') {
    const blinkHidden = allyHitResult && !allyHitResult.miss && (Math.floor(battleTimer / 60) & 1);
    if (!blinkHidden && !bossDefeated) ctx.drawImage(landTurtleBattleCanvas, sprX, sprY);
    if (!bossDefeated && allyHitResult && !allyHitResult.miss) {
      const ally = battleAllies[currentAllyAttacker];
      const allySlashFrames = ally ? getSlashFramesForWeapon(ally.weaponId, true) : slashFramesR;
      const af = Math.min(Math.floor(battleTimer / 67), 2);
      if (allySlashFrames && allySlashFrames[af])
        ctx.drawImage(allySlashFrames[af], centerX - 8 + [0,10,-8][af], centerY - 8 + [0,-6,8][af]);
    }
  } else {
    if (!bossDefeated) ctx.drawImage(landTurtleBattleCanvas, sprX, sprY);
  }
}
function _drawBossSpriteBoxBoss(centerX, centerY) {
  const isExpand = battleState === 'boss-box-expand';
  const isClose  = battleState === 'boss-box-close' || (!isRandomEncounter && battleState === 'defeat-close');
  const fullW = 64, fullH = 64;

  _clipToViewport();

  const { boxW, boxH } = _calcBoxExpandSize(fullW, fullH, isExpand, isClose, battleTimer);
  _drawBorderedBox(centerX - Math.floor(boxW / 2), centerY - Math.floor(boxH / 2), boxW, boxH);

  if (isExpand || isClose || battleState === 'defeat-text') { ctx.restore(); return; }

  _drawBossSprite(centerX, centerY);

  if ((battleState === 'target-select' || (battleState === 'item-target-select' && inputSt.itemTargetType === 'enemy')) && cursorTileCanvas)
    ctx.drawImage(cursorTileCanvas, centerX - 32 - 16, centerY - 8);

  ctx.restore();
}
function drawBossSpriteBox() {
  if (isRandomEncounter) return;

  const centerX = HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2);
  const centerY = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2);

  if (pvpSt.isPVPBattle) {
    const isCombatPVP = battleState === 'battle-fade-in' ||
                    battleState === 'boss-box-expand' || battleState === 'boss-box-close' ||
                    battleState === 'menu-open' || battleState === 'target-select' || battleState === 'confirm-pause' ||
                    battleState === 'attack-start' || battleState === 'player-slash' || battleState === 'player-hit-show' ||
                    battleState === 'player-miss-show' ||
                    battleState === 'player-damage-show' || battleState === 'defend-anim' || battleState.startsWith('item-') ||
                    battleState === 'boss-flash' || battleState === 'enemy-attack' ||
                    battleState === 'enemy-damage-show' || battleState === 'pvp-second-windup' ||
                    battleState === 'pvp-ally-appear' || battleState === 'message-hold' ||
                    battleState.startsWith('ally-') ||
                    battleState === 'pvp-dissolve' || battleState === 'pvp-defend-anim' ||
                    battleState === 'pvp-enemy-slash' || battleState === 'pvp-opp-potion' ||
                    battleState === 'pvp-opp-sw-throw' || battleState === 'pvp-opp-sw-hit' ||
                    battleState === 'defeat-monster-fade' || battleState === 'defeat-text' || battleState === 'defeat-close' ||
                    battleState === 'victory-name-out' || battleState === 'victory-celebrate' ||
                    battleState === 'victory-text-in' || battleState === 'victory-hold' || battleState === 'victory-fade-out' ||
                    battleState === 'exp-text-in' || battleState === 'exp-hold' || battleState === 'exp-fade-out' ||
                    battleState === 'gil-text-in' || battleState === 'gil-hold' || battleState === 'gil-fade-out' ||
                    battleState === 'levelup-text-in' || battleState === 'levelup-hold' ||
                    battleState === 'item-text-in' || battleState === 'item-hold' || battleState === 'item-fade-out' ||
                    battleState === 'prof-levelup-text-in' || battleState === 'prof-levelup-hold' ||
                    battleState === 'victory-text-out' || battleState === 'victory-menu-fade' || battleState === 'victory-box-close';
    if (isCombatPVP) drawBossSpriteBoxPVP(_pvpShared(), centerX, centerY);
    return;
  }

  if (!landTurtleBattleCanvas) return;

  const isExpand = battleState === 'boss-box-expand';
  const isClose = battleState === 'boss-box-close' || battleState === 'defeat-close';
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
                    battleState === 'prof-levelup-text-in' || battleState === 'prof-levelup-hold' ||
                    battleState === 'victory-text-out' || battleState === 'victory-menu-fade' || battleState === 'victory-box-close';
  if (!isExpand && !isClose && !isAppear && !isDissolve && !isCombat && !isVictory) return;

  _drawBossSpriteBoxBoss(centerX, centerY);
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

  _clipToViewport();

  _drawBorderedBox(centerX, msgY, boxW, boxH, true);

  const tw = measureText(battleMessage);
  const tx = centerX + Math.floor((boxW - tw) / 2);
  const ty = msgY + Math.floor((boxH - 8) / 2);
  drawText(ctx, tx, ty, battleMessage, TEXT_WHITE_ON_BLUE);

  ctx.restore();
}



// Victory box — reuses left box area (120×64 px), row-by-row expand
const VICTORY_BOX_W = BATTLE_PANEL_W;  // 120px (same as left box)
const VICTORY_BOX_H = HUD_BOT_H;       // 64px
const VICTORY_BOX_ROWS = HUD_BOT_H / 8; // 8 rows
const VICTORY_ROW_FRAME_MS = 16.67; // 1 NES frame per row

function _battleEnemyName() {
  if (pvpSt.isPVPBattle) {
    const ti = pvpSt.pvpPlayerTargetIdx;
    if (ti >= 0 && pvpSt.pvpEnemyAllies[ti]) return _nameToBytes(pvpSt.pvpEnemyAllies[ti].name);
    if (pvpSt.pvpOpponentStats) return _nameToBytes(pvpSt.pvpOpponentStats.name);
  }
  if (isRandomEncounter && encounterMonsters) {
    // Use targeted monster's name (or first alive if no target)
    const ti = (inputSt.targetIndex >= 0 && inputSt.targetIndex < encounterMonsters.length && encounterMonsters[inputSt.targetIndex].hp > 0)
      ? inputSt.targetIndex
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

function _victoryBoxStates() {
  const bs = battleState;
  const isNameOut    = bs === 'victory-name-out';
  const isCelebrate  = bs === 'victory-celebrate';
  const isClose      = bs === 'victory-box-close';
  const isVicText    = bs === 'victory-text-in';
  const isVicHold    = bs === 'victory-hold';
  const isVicFadeOut = bs === 'victory-fade-out';
  const isExpText    = bs === 'exp-text-in';
  const isExpHold    = bs === 'exp-hold';
  const isExpFadeOut = bs === 'exp-fade-out';
  const isGilText    = bs === 'gil-text-in';
  const isGilHold    = bs === 'gil-hold';
  const isGilFadeOut = bs === 'gil-fade-out';
  const isLevelText  = bs === 'levelup-text-in';
  const isLevelHold  = bs === 'levelup-hold';
  const isProfLvText = bs === 'prof-levelup-text-in';
  const isProfLvHold = bs === 'prof-levelup-hold';
  const isItemText   = bs === 'item-text-in';
  const isItemHold   = bs === 'item-hold';
  const isItemFadeOut = bs === 'item-fade-out';
  const isOut        = bs === 'victory-text-out';
  const isMenuFadeState = bs === 'victory-menu-fade';
  const isRunNameOut = bs === 'run-name-out';
  const isRunTextIn  = bs === 'run-text-in';
  const isRunHold    = bs === 'run-hold';
  const isRunTextOut = bs === 'run-text-out';
  const isRunFailNameOut  = bs === 'run-fail-name-out';
  const isRunFailTextIn   = bs === 'run-fail-text-in';
  const isRunFailHold     = bs === 'run-fail-hold';
  const isRunFailTextOut  = bs === 'run-fail-text-out';
  const isRunFailNameIn   = bs === 'run-fail-name-in';
  const isRun     = isRunNameOut || isRunTextIn || isRunHold || isRunTextOut;
  const isRunFail = isRunFailNameOut || isRunFailTextIn || isRunFailHold || isRunFailTextOut || isRunFailNameIn;
  return { isNameOut, isCelebrate, isClose, isVicText, isVicHold, isVicFadeOut,
           isExpText, isExpHold, isExpFadeOut, isGilText, isGilHold, isGilFadeOut,
           isLevelText, isLevelHold, isItemText, isItemHold, isItemFadeOut,
           isProfLvText, isProfLvHold,
           isOut, isMenuFadeState, isRunNameOut, isRunTextIn, isRunHold, isRunTextOut,
           isRunFailNameOut, isRunFailTextIn, isRunFailHold, isRunFailTextOut, isRunFailNameIn,
           isRun, isRunFail };
}
function _drawVictoryMessage(boxX, boxY, s) {
  let fadeStep = 0;
  if (s.isVicText || s.isExpText || s.isGilText || s.isItemText || s.isLevelText || s.isProfLvText)
    fadeStep = BATTLE_TEXT_STEPS - Math.min(Math.floor(battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
  else if (s.isVicFadeOut || s.isExpFadeOut || s.isGilFadeOut || s.isItemFadeOut || s.isOut)
    fadeStep = Math.min(Math.floor(battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
  const fadedPal = _makeFadedPal(fadeStep);
  let msg;
  if (s.isVicText || s.isVicHold || s.isVicFadeOut) msg = BATTLE_VICTORY;
  else if (s.isExpText || s.isExpHold || s.isExpFadeOut) msg = makeExpText(encounterExpGained);
  else if (s.isGilText || s.isGilHold || s.isGilFadeOut) msg = makeGilText(encounterGilGained);
  else if (s.isItemText || s.isItemHold || s.isItemFadeOut) msg = encounterDropItem !== null ? makeFoundItemText(encounterDropItem) : null;
  else if (s.isLevelText || s.isLevelHold) msg = BATTLE_LEVEL_UP;
  else if (s.isProfLvText || s.isProfLvHold) { const p = encounterProfLevelUps[profLevelUpIdx]; msg = p ? makeProfLevelUpText(p.cat, p.newLevel) : null; }
  else if (s.isOut) msg = ps.leveledUp ? BATTLE_LEVEL_UP : encounterDropItem !== null ? makeFoundItemText(encounterDropItem) : makeGilText(encounterGilGained);
  if (msg) {
    const tw = measureText(msg);
    drawText(ctx, boxX + Math.floor((VICTORY_BOX_W - tw) / 2), boxY + Math.floor((VICTORY_BOX_H - 8) / 2), msg, fadedPal);
  }
}
function drawVictoryBox() {
  const s = _victoryBoxStates();
  const showBox = s.isNameOut || s.isCelebrate || s.isClose || s.isVicText || s.isVicHold || s.isVicFadeOut ||
    s.isExpText || s.isExpHold || s.isExpFadeOut || s.isGilText || s.isGilHold || s.isGilFadeOut ||
    s.isItemText || s.isItemHold || s.isItemFadeOut || s.isLevelText || s.isLevelHold ||
    s.isProfLvText || s.isProfLvHold ||
    s.isOut || s.isMenuFadeState || s.isRun || s.isRunFail;
  if (!showBox) return;

  let boxX = 0;
  const boxY = HUD_BOT_Y;
  if (s.isClose) boxX = Math.round(-(CANVAS_W - 8) * Math.min(battleTimer / (VICTORY_BOX_ROWS * VICTORY_ROW_FRAME_MS), 1));

  if (s.isNameOut || s.isRunNameOut || s.isRunFailNameOut) { _drawVictoryNameOut(boxX, boxY, s.isRunFailNameOut); return; }
  if (s.isRun) { _drawVictoryRunText(boxX, boxY, s.isRunTextIn, s.isRunTextOut); return; }
  if (s.isRunFail) { _drawVictoryRunFail(boxX, boxY, s.isRunFailNameIn, s.isRunFailTextIn, s.isRunFailTextOut); return; }
  if (s.isCelebrate) { _drawBorderedBox(boxX, boxY, VICTORY_BOX_W, VICTORY_BOX_H); return; }
  _drawBorderedBox(boxX, boxY, VICTORY_BOX_W, VICTORY_BOX_H);
  if (s.isClose) return;
  _drawVictoryMessage(boxX, boxY, s);
}

function _drawVictoryNameOut(boxX, boxY, isRunFail) {
  _drawBorderedBox(boxX, boxY, VICTORY_BOX_W, VICTORY_BOX_H);
  const stepMs = isRunFail ? 50 : BATTLE_TEXT_STEP_MS;
  const fadeStep = Math.min(Math.floor(battleTimer / stepMs), BATTLE_TEXT_STEPS);
  const fadedPal = _makeFadedPal(fadeStep);
  const enemyName = _battleEnemyName();
  const nameTw = measureText(enemyName);
  drawText(ctx, Math.floor((VICTORY_BOX_W - nameTw) / 2), boxY + Math.floor((VICTORY_BOX_H - 8) / 2), enemyName, fadedPal);
}

function _drawVictoryRunText(boxX, boxY, isIn, isOut) {
  _drawBorderedBox(boxX, boxY, VICTORY_BOX_W, VICTORY_BOX_H);
  let fadeStep = 0;
  if (isIn) fadeStep = BATTLE_TEXT_STEPS - Math.min(Math.floor(battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
  else if (isOut) fadeStep = Math.min(Math.floor(battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
  const fadedPal = _makeFadedPal(fadeStep);
  const tw = measureText(BATTLE_RAN_AWAY);
  drawText(ctx, boxX + Math.floor((VICTORY_BOX_W - tw) / 2), boxY + Math.floor((VICTORY_BOX_H - 8) / 2), BATTLE_RAN_AWAY, fadedPal);
}

function _drawVictoryRunFail(boxX, boxY, isNameIn, isTextIn, isTextOut) {
  _drawBorderedBox(boxX, boxY, VICTORY_BOX_W, VICTORY_BOX_H);
  const RUN_FAIL_STEP_MS = 50;
  if (isNameIn) {
    const fadeStep = BATTLE_TEXT_STEPS - Math.min(Math.floor(battleTimer / RUN_FAIL_STEP_MS), BATTLE_TEXT_STEPS);
    const fadedPal = _makeFadedPal(fadeStep);
    const enemyName = _battleEnemyName();
    const nameTw = measureText(enemyName);
    drawText(ctx, boxX + Math.floor((VICTORY_BOX_W - nameTw) / 2), boxY + Math.floor((VICTORY_BOX_H - 8) / 2), enemyName, fadedPal);
  } else {
    const fadeStep = isTextIn ? BATTLE_TEXT_STEPS - Math.min(Math.floor(battleTimer / RUN_FAIL_STEP_MS), BATTLE_TEXT_STEPS)
                              : isTextOut ? Math.min(Math.floor(battleTimer / RUN_FAIL_STEP_MS), BATTLE_TEXT_STEPS) : 0;
    const fadedPal = _makeFadedPal(fadeStep);
    const tw = measureText(BATTLE_CANT_ESCAPE);
    drawText(ctx, boxX + Math.floor((VICTORY_BOX_W - tw) / 2), boxY + Math.floor((VICTORY_BOX_H - 8) / 2), BATTLE_CANT_ESCAPE, fadedPal);
  }
}


function _drawAllyRow(i, ally, panelTop, weaponDraws) {
  const shakeOff = (allyShakeTimer[i] > 0) ? (Math.floor(allyShakeTimer[i] / 67) & 1 ? 2 : -2) : 0;
  const rowY = panelTop + i * ROSTER_ROW_H + shakeOff;
  const isVicPose = _isVictoryBattleState();
  const isAllyHit = (battleState === 'ally-hit' || battleState === 'ally-damage-show-enemy') &&
    enemyTargetAllyIdx === i && allyDamageNums[i] && !allyDamageNums[i].miss;
  const isAllyAttack = (battleState === 'ally-attack-start') && currentAllyAttacker === i;
  const isAllyHeal = battleState === 'item-use' && inputSt.playerActionPending && inputSt.playerActionPending.allyIndex === i;
  const isNearFatal = ally.hp > 0 && ally.hp <= Math.floor(ally.maxHP / 4);
  const ppx = HUD_RIGHT_X + 8, ppy = rowY + 8;
  _drawHudBox(HUD_RIGHT_X, rowY, 32, ROSTER_ROW_H, ally.fadeStep);
  _drawHudBox(HUD_RIGHT_X + 32, rowY, HUD_RIGHT_W - 32, ROSTER_ROW_H, ally.fadeStep);
  _drawAllyPortrait(i, ally, isVicPose, isAllyAttack, isAllyHit, isNearFatal, ppx, ppy, weaponDraws);
  _drawAllyTexts(i, ally, rowY, isAllyHeal, ppx, ppy, weaponDraws);
}
function _drawAllyPortrait(i, ally, isVicPose, isAllyAttack, isAllyHit, isNearFatal, ppx, ppy, weaponDraws) {
  const isThisAllySlash = battleState === 'ally-slash' && currentAllyAttacker === i;
  const hitLeft = isAllyAttack && allyHitIsLeft;
  let portraits;
  if (isVicPose && (Math.floor(Date.now() / 250) & 1) && fakePlayerVictoryPortraits[ally.palIdx]) portraits = fakePlayerVictoryPortraits[ally.palIdx];
  else if (isAllyAttack) portraits = (hitLeft ? fakePlayerAttackLPortraits : fakePlayerAttackPortraits)[ally.palIdx];
  else if (isThisAllySlash) portraits = (allyHitIsLeft ? fakePlayerKnifeLPortraits : fakePlayerKnifeRPortraits)[ally.palIdx];
  else if (isAllyHit && fakePlayerHitPortraits[ally.palIdx]) portraits = fakePlayerHitPortraits[ally.palIdx];
  else if (isNearFatal && fakePlayerKneelPortraits[ally.palIdx]) portraits = fakePlayerKneelPortraits[ally.palIdx];
  else portraits = fakePlayerPortraits[ally.palIdx];
  if (!portraits) return;
  if (isAllyAttack) {
    // R-hand back-swing blade goes BEHIND portrait (NES OAM: weapon spr06-09 loses to body spr00-05)
    // L-hand back-swing blade goes IN FRONT (NES OAM: weapon spr00-03 beats body spr04-09)
    if (!hitLeft) {
      const wpnSt = weaponSubtype(ally.weaponId);
      const backX = ppx + 8;
      if (wpnSt === 'knife' && ally.weaponId === 0x1F && battleDaggerBladeCanvas) ctx.drawImage(battleDaggerBladeCanvas, backX, ppy - 7);
      else if (wpnSt === 'knife' && battleKnifeBladeCanvas) ctx.drawImage(battleKnifeBladeCanvas, backX, ppy - 7);
      else if (wpnSt === 'sword' && battleSwordBladeCanvas) ctx.drawImage(battleSwordBladeCanvas, backX, ppy - 7);
    }
  }
  ctx.drawImage(portraits[ally.fadeStep], ppx, ppy);
  if (isAllyAttack) {
    if (hitLeft) {
      const wpnSt = weaponSubtype(ally.weaponL);
      if (wpnSt === 'knife' && ally.weaponL === 0x1F && battleDaggerBladeCanvas) weaponDraws.push({ img: battleDaggerBladeCanvas, x: ppx + 16, y: ppy - 7 });
      else if (wpnSt === 'knife' && battleKnifeBladeCanvas) weaponDraws.push({ img: battleKnifeBladeCanvas, x: ppx + 16, y: ppy - 7 });
      else if (wpnSt === 'sword' && battleSwordBladeCanvas) weaponDraws.push({ img: battleSwordBladeCanvas, x: ppx + 16, y: ppy - 7 });
    }
  }
  if (isThisAllySlash) {
    const activeWpnId = allyHitIsLeft ? ally.weaponL : ally.weaponId;
    const wpnSt = weaponSubtype(activeWpnId);
    if (wpnSt === 'knife' && activeWpnId === 0x1F && battleDaggerBladeSwungCanvas) weaponDraws.push({ img: battleDaggerBladeSwungCanvas, x: ppx - 16, y: ppy + 1 });
    else if (wpnSt === 'knife' && battleKnifeBladeSwungCanvas) weaponDraws.push({ img: battleKnifeBladeSwungCanvas, x: ppx - 16, y: ppy + 1 });
    else if (wpnSt === 'sword' && battleSwordBladeSwungCanvas) weaponDraws.push({ img: battleSwordBladeSwungCanvas, x: ppx - 16, y: ppy + 1 });
    else if (battleFistCanvas) weaponDraws.push({ img: battleFistCanvas, x: ppx - 4, y: ppy + 10 });
  }
  // PVP enemy slash overlay on targeted ally during ally-hit — h-flipped (opponent attacks from left)
  if (pvpSt.isPVPBattle && battleState === 'ally-hit' && enemyTargetAllyIdx === i) {
    const eWpnId = pvpSt.pvpCurrentEnemyAllyIdx >= 0
      ? pvpSt.pvpEnemyAllies[pvpSt.pvpCurrentEnemyAllyIdx]?.weaponId
      : pvpSt.pvpOpponentStats?.weaponId;
    const eSlashF = getSlashFramesForWeapon(eWpnId, true);
    const af = Math.min(2, Math.floor(battleTimer / 67));
    if (eSlashF && eSlashF[af]) {
      const sf = eSlashF[af];
      ctx.save();
      ctx.translate(ppx + sf.width + [-0, -10, 8][af], ppy + [0, -6, 8][af]);
      ctx.scale(-1, 1);
      ctx.drawImage(sf, 0, 0);
      ctx.restore();
    }
  }
}
function _drawAllyTexts(i, ally, rowY, isAllyHeal, ppx, ppy, weaponDraws) {
  const namePal = [0x0F, 0x0F, 0x0F, 0x30];
  for (let s = 0; s < ally.fadeStep; s++) namePal[3] = nesColorFade(namePal[3]);
  const nameBytes = _nameToBytes(ally.name);
  drawText(ctx, HUD_RIGHT_X + HUD_RIGHT_W - 8 - measureText(nameBytes), rowY + 8, nameBytes, namePal);
  const hpBytes = _nameToBytes(String(ally.hp));
  const allyHpNes = ally.hp <= Math.floor(ally.maxHP / 4) ? 0x16 : ally.hp <= Math.floor(ally.maxHP / 2) ? 0x28 : 0x2A;
  const hpPal = [0x0F, 0x0F, 0x0F, allyHpNes];
  for (let s = 0; s < ally.fadeStep; s++) hpPal[3] = nesColorFade(hpPal[3]);
  drawText(ctx, HUD_RIGHT_X + HUD_RIGHT_W - 8 - measureText(hpBytes), rowY + 16, hpBytes, hpPal);
  const dn = allyDamageNums[i];
  if (dn) weaponDraws.push({ type: 'dmg', dn, bx: HUD_RIGHT_X + 16, by: _dmgBounceY(rowY + 16, dn.timer) });
  if (isAllyHeal && cureSparkleFrames.length === 2) {
    weaponDraws.push({ type: 'sparkle', frame: cureSparkleFrames[Math.floor(battleTimer / 67) & 1], px: ppx, py: ppy });
  }
}

function _flushAllyWeaponDraws(weaponDraws) {
  for (const wd of weaponDraws) {
    if (wd.type === 'dmg') {
      const { dn, bx, by } = wd;
      if (dn.miss) {
        drawText(ctx, bx - 8, by, BATTLE_MISS, [0x0F, 0x0F, 0x0F, 0x2B]);
      } else {
        _drawBattleNum(bx, by, dn.value, dn.heal ? [0x0F, 0x0F, 0x0F, 0x2B] : DMG_NUM_PAL);
      }
    } else if (wd.type === 'sparkle') {
      const { frame, px, py } = wd;
      _drawSparkleCorners(frame, px, py);
    } else {
      ctx.drawImage(wd.img, wd.x, wd.y);
    }
  }
}

function drawBattleAllies() {
  if (battleAllies.length === 0 || battleState === 'none') return;
  const panelTop = HUD_VIEW_Y + 32;
  const weaponDraws = [];
  ctx.save();
  ctx.beginPath();
  ctx.rect(HUD_RIGHT_X, panelTop, HUD_RIGHT_W, HUD_VIEW_H - 32);
  ctx.clip();
  for (let i = 0; i < battleAllies.length; i++) _drawAllyRow(i, battleAllies[i], panelTop, weaponDraws);
  ctx.restore();
  if (battleState === 'item-target-select' && inputSt.itemTargetType === 'player' && inputSt.itemTargetAllyIndex >= 0 && cursorTileCanvas) {
    ctx.drawImage(cursorTileCanvas, HUD_RIGHT_X - 4, panelTop + inputSt.itemTargetAllyIndex * ROSTER_ROW_H + 12);
  }
  _flushAllyWeaponDraws(weaponDraws);
}

function _encounterMonsterPos(idx) {
  const { sprH: dSprH, gridPos } = _encounterGridLayout();
  const safeIdx = idx < gridPos.length ? idx : 0;
  const pos = gridPos[safeIdx];
  const m = encounterMonsters[safeIdx];
  const mc = monsterBattleCanvas.get(m?.monsterId) || goblinBattleCanvas;
  const mh = mc ? mc.height : dSprH;
  return { bx: pos.x + 16, baseY: pos.y + (dSprH - mh) + Math.floor(mh / 2) - 8 };
}
function _drawBossDmgNum() {
  if (!bossDamageNum || (bossDefeated && !isRandomEncounter)) return;
  let bx, baseY;
  if (isRandomEncounter && encounterMonsters) {
    ({ bx, baseY } = _encounterMonsterPos(inputSt.targetIndex));
  } else if (pvpSt.isPVPBattle) {
    const totalEnemies = 1 + pvpSt.pvpEnemyAllies.length;
    const cols = totalEnemies <= 1 ? 1 : 2;
    const rows = totalEnemies <= 2 ? 1 : 2;
    const cellW = 24, cellH = 32;
    const centerX = HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2);
    const centerY = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2);
    const intLeft = centerX - cols * Math.floor(cellW / 2);
    const intTop  = centerY - rows * Math.floor(cellH / 2);
    const gridPos = [[rows-1,cols-1],[rows-1,0],[0,cols-1],[0,0]];
    const tIdx = pvpSt.pvpPlayerTargetIdx < 0 ? 0 : pvpSt.pvpPlayerTargetIdx + 1;
    const [gr, gc] = gridPos[Math.min(tIdx, gridPos.length - 1)];
    bx = intLeft + gc * cellW + 12;
    baseY = intTop + gr * cellH + 4;
  } else {
    bx = HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2) - 4;
    baseY = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2) - 8;
  }
  const by = _dmgBounceY(baseY, bossDamageNum.timer);
  _clipToViewport();
  if (bossDamageNum.miss) {
    drawText(ctx, bx - 8, by, BATTLE_MISS, [0x0F, 0x0F, 0x0F, 0x2B]);
  } else {
    _drawBattleNum(bx, by, bossDamageNum.value, DMG_NUM_PAL);
  }
  ctx.restore();
}

function _drawEnemyHealNum() {
  if (!enemyHealNum) return;
  let bx, baseY;
  if (isRandomEncounter && encounterMonsters) {
    ({ bx, baseY } = _encounterMonsterPos(enemyHealNum.index));
  } else {
    bx = HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2) - 4;
    baseY = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2) - 8;
  }
  const hy = _dmgBounceY(baseY, enemyHealNum.timer);
  _clipToViewport();
  _drawBattleNum(bx, hy, enemyHealNum.value, [0x0F, 0x0F, 0x0F, 0x2B]);
  ctx.restore();
}

function _drawBattleNum(bx, by, value, pal) {
  const digits = String(value);
  const b = new Uint8Array(digits.length);
  for (let i = 0; i < digits.length; i++) b[i] = 0x80 + parseInt(digits[i]);
  drawText(ctx, bx - Math.floor(digits.length * 4), by, b, pal);
}
function drawDamageNumbers() {
  _drawBossDmgNum();

  // Player damage number — bounces centered on portrait
  if (playerDamageNum) {
    const px = HUD_RIGHT_X + 16;
    const baseY = HUD_VIEW_Y + 16;
    const py = _dmgBounceY(baseY, playerDamageNum.timer);
    if (playerDamageNum.miss) {
      drawText(ctx, px - 8, py, BATTLE_MISS, [0x0F, 0x0F, 0x0F, 0x2B]);
    } else {
      _drawBattleNum(px, py, playerDamageNum.value, DMG_NUM_PAL);
    }
  }

  // Player heal number — green bounce on portrait during item-use
  if (playerHealNum) {
    const px = HUD_RIGHT_X + 16;
    const baseY = HUD_VIEW_Y + 16;
    const py = _dmgBounceY(baseY, playerHealNum.timer);
    _drawBattleNum(px, py, playerHealNum.value, [0x0F, 0x0F, 0x0F, 0x2B]);
  }

  _drawEnemyHealNum();
}

function _updateHudHpLvStep(dt) {
  const target = (battleState === 'none' || battleState === 'flash-strobe' ||
    battleState === 'encounter-box-expand' || battleState === 'monster-slide-in' ||
    battleState === 'boss-box-expand' || battleState === 'boss-appear') ? 0 : 4;
  if (hudHpLvStep === target) return;
  hudHpLvTimer += dt;
  while (hudHpLvTimer >= HUD_HPLV_STEP_MS) {
    hudHpLvTimer -= HUD_HPLV_STEP_MS;
    hudHpLvStep += hudHpLvStep < target ? 1 : -1;
    if (hudHpLvStep === target) { hudHpLvTimer = 0; break; }
  }
}

function _drawPondStrobe() {
  if (pondStrobeTimer <= 0) return;
  const frame = Math.floor((BATTLE_FLASH_FRAMES * BATTLE_FLASH_FRAME_MS - pondStrobeTimer) / BATTLE_FLASH_FRAME_MS);
  if (!(frame & 1)) return;
  _clipToViewport();
  _grayViewport();
}

function _updateStarEffect(dt) {
  if (!starEffect) return;
  starEffect.acc = (starEffect.acc || 0) + dt;
  while (starEffect.acc >= 16.67) {
    starEffect.acc -= 16.67;
    starEffect.frame++;
    starEffect.angle += 0.06;
    starEffect.radius -= 0.55;
    // Player spin: cycle directions every 14 frames
    if (starEffect.spin && starEffect.frame % 14 === 0) {
      const SPIN_ORDER = [DIR_DOWN, DIR_LEFT, DIR_UP, DIR_RIGHT];
      sprite.setDirection(SPIN_ORDER[Math.floor(starEffect.frame / 14) % 4]);
    }
    if (starEffect.radius < 4) {
      const cb = starEffect.onComplete;
      starEffect = null;
      if (cb) cb();
      break;
    }
  }
}

function _gameLoopUpdate(dt) {
  if (hudInfoFadeTimer < HUD_INFO_FADE_STEPS * HUD_INFO_FADE_STEP_MS) hudInfoFadeTimer += dt;
  _updateHudHpLvStep(dt);
  handleInput();
  updateRoster(dt);
  updateChat(dt, battleState);
  updatePauseMenu(dt, playerInventory);
  updateMsgBox(dt);
  updateBattle(dt);
  updateMovement(dt);
  updateTransition(dt, _transShared());
  updateTopBoxScroll(dt);
  if (pondStrobeTimer > 0) pondStrobeTimer = Math.max(0, pondStrobeTimer - dt);
  if (shakeActive) {
    shakeTimer += dt;
    if (shakeTimer >= SHAKE_DURATION) {
      shakeActive = false;
      if (shakePendingAction) { shakePendingAction(); shakePendingAction = null; }
    }
  }
  _updateStarEffect(dt);
  waterTimer += dt;
  if (waterTimer >= WATER_TICK) { waterTimer %= WATER_TICK; waterTick++; }
}

function _gameLoopDraw() {
  try {
    render();
    drawTransitionOverlay(ctx, _transDrawShared());
    _drawPondStrobe();
    if (transSt.state === 'trap-falling' && sprite) sprite.draw(ctx, SCREEN_CENTER_X, SCREEN_CENTER_Y);
  } catch (e) {
    console.error('[RENDER ERROR]', e);
  }
  drawHUD();
  if (battleAllies.length > 0 && battleState !== 'none') drawBattleAllies();
  else drawRoster();
  drawChat(ctx, _drawHudBox, rosterBattleFade);
  drawPauseMenu(ctx, _pauseShared());
  drawMsgBox(ctx, _clipToViewport, _drawBorderedBox);
  drawRosterMenu();
  drawBattle();
  drawSWExplosion();
  drawSWDamageNumbers();
  if (transSt.state === 'hud-fade-out') {
    const alpha = Math.min(transSt.timer / ((HUD_INFO_FADE_STEPS + 1) * HUD_INFO_FADE_STEP_MS), 1);
    ctx.fillStyle = `rgba(0,0,0,${alpha})`;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  }
}

function gameLoop(timestamp) {
  const dt = Math.min(timestamp - lastTime, 50); // cap at 50ms to prevent frame-spike skipping animations
  lastTime = timestamp;

  if (titleSt.state !== 'done') {
    updateTitle(dt); drawTitle(ctx, _titleShared()); drawHUD();
    if (titleSt.state !== 'done') drawTitleSkyInHUD(ctx, roundTopBoxCorners); // guard: updateTitle may have set titleSt.state='done'
    requestAnimationFrame(gameLoop);
    return;
  }

  try {
    _gameLoopUpdate(dt);
    _gameLoopDraw();
  } catch (e) {
    console.error('[GAME LOOP ERROR] transSt.state=' + transSt.state + ' battleState=' + battleState, e);
    requestAnimationFrame(gameLoop);
    return;
  }

  requestAnimationFrame(gameLoop);
}
