// Game Client — canvas rendering, input handling, game loop

import { parseROM } from './rom-parser.js';
import { NES_SYSTEM_PALETTE, decodeTiles } from './tile-decoder.js';
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
import { PLAYER_POOL, PLAYER_PALETTES, ROSTER_FADE_STEPS, generateAllyStats } from './data/players.js';
import { BATTLE_MISS, BATTLE_GAME_OVER, BATTLE_ROAR, BATTLE_FIGHT, BATTLE_RUN,
         BATTLE_CANT_ESCAPE, BATTLE_RAN_AWAY, BATTLE_DEFEND, BATTLE_VICTORY,
         BATTLE_GOT_EXP, BATTLE_LEVEL_UP, BATTLE_BOSS_NAME, BATTLE_GOBLIN_NAME,
         BATTLE_MENU_ITEMS, PAUSE_ITEMS, AREA_NAMES, DUNGEON_NAME,
         POND_RESTORED } from './data/strings.js';
import { initMonsterSprites, getMonsterCanvas, getMonsterWhiteCanvas,
         getMonsterDeathFrames, hasMonsterSprites } from './monster-sprites.js';
import { loadBossSprite, getBossBattleCanvas, getBossWhiteCanvas } from './boss-sprites.js';
// serverDeleteSlot → title-screen.js
import { selectCursor, saveSlots,
         setSelectCursor, setSaveSlots,
         saveSlotsToDB, loadSlotsFromDB, setInventoryGetter } from './save-state.js';
import { _nameToBytes, _buildItemRowBytes, _makeGotNText, makeExpText, makeGilText, makeFoundItemText, makeProfLevelUpText } from './text-utils.js';
import { nesColorFade, _makeFadedPal, _stepPalFade } from './palette.js';
import { _getPlane0, _rebuild, _shiftHorizWater, _isWater, _buildHorizMixed } from './tile-math.js';
import { _dmgBounceY } from './data/animation-tables.js';
import { _calcBoxExpandSize, _encounterGridPos } from './battle-layout.js';
// _makeCanvas16, _makeCanvas16ctx, _hflipCanvas16, _makeWhiteCanvas → sprite-init.js
import { _updateWorldWater, _updateIndoorWater, resetWorldWaterCache, resetIndoorWaterCache, _buildHorizWaterPair } from './water-animation.js';
import { initSlashSprites, initKnifeSlashSprites, initSwordSlashSprites } from './slash-effects.js';
import { initSouthWindSprite } from './south-wind.js';
import { initFlameRawTiles, initStarTiles, rebuildFlameSprites, clearFlameSprites,
         getFlameSprites, getFlameFrames, getStarTiles } from './flame-sprites.js';
import { BATTLE_BG_MAP_LOOKUP, renderBattleBg } from './battle-bg.js';
import { LOAD_FADE_STEP_MS, LOAD_FADE_MAX, drawLoadingOverlay, drawHUDLoadingMoogle } from './loading-screen.js';
import { initTitleWater, initTitleSky, initTitleUnderwater, initUnderwaterSprites, initTitleOcean, initTitleLogo } from './title-animations.js';
// BATTLE_SPRITE_ROM, BATTLE_JOB_SIZE, BATTLE_PAL_ROM → sprite-init.js
import { ps, EQUIP_SLOT_SUBTYPE, getEquipSlotId, setEquipSlotId, recalcDEF, recalcCombatStats, getHitWeapon, isHitRightHand, initPlayerStats, initExpTable, grantExp, fullHeal, gainProficiency, getProfHits, getProfLevel, getShieldEvade, PROF_CATEGORIES, WEAPON_PROF_CATEGORY } from './player-stats.js';
import { initProfIcons, getProfIcon } from './prof-icons.js';
import { chatState, addChatMessage, updateChat, drawChat, onChatKeyDown, consoleLog, setCommandContext } from './chat.js';
import { rosterBattleFade, setLocationGetter, getPlayerLocation, rosterLocForMapId,
         getRosterVisible, initRoster, updateRoster,
         drawRoster, drawRosterMenu } from './roster.js';
import { msgState, showMsgBox, updateMsgBox, drawMsgBox } from './message-box.js';
import { titleSt, isTitleActiveState, titleFadeLevel, titleFadePal, drawTitleOcean, drawTitleWater, drawTitleSky, drawTitleUnderwater, drawUnderwaterSprites, drawTitleSkyInHUD, drawTitle, drawPlayerSelectContent,
         updateTitleUnderwater, updateTitleSelect, onNameEntryKeyDown } from './title-screen.js';
import { pauseSt, updatePauseMenu, drawPauseMenu } from './pause-menu.js';
import { transSt, topBoxSt, loadingSt, startWipeTransition, updateTransition, updateTopBoxScroll, drawTransitionOverlay } from './transitions.js';
import { inputSt, handleBattleInput, handleRosterInput, handlePauseInput } from './input-handler.js';
import { checkTrigger, applyPassage, openPassage, handleChest, handleSecretWall, handleRockPuzzle, handlePondHeal, findWorldExitIndex } from './map-triggers.js';
import { pvpSt, startPVPBattle, resetPVPState, updatePVPBattle } from './pvp.js';
import { drawBattle, drawBattleAllies, drawSWExplosion, drawSWDamageNumbers } from './battle-drawing.js';
import { playSlashSFX } from './battle-sfx.js';
import { getKnifeBladeCanvas, getKnifeBladeSwungCanvas,
         getDaggerBladeCanvas, getDaggerBladeSwungCanvas,
         getSwordBladeCanvas, getSwordBladeSwungCanvas,
         getFistCanvas, getBlades } from './weapon-sprites.js';
import { updateBattleAlly } from './battle-ally.js';
import { updateBattleEnemyTurn } from './battle-enemy.js';
import { resetBattleItemVars, getTargets, getHitIdx, startMagicItem, updateMagicItemThrowHit } from './battle-items.js';
import { initBattleSprite as _initBattleSprite, initFakePlayerPortraits as _initFakePlayerPortraits,
         initCursorTile as _initCursorTile, initAdamantoise as _initAdamantoise,
         initGoblinSprite as _initGoblinSprite, initInvincibleSprite as _initInvincibleSprite,
         initMoogleSprite as _initMoogleSprite, initLoadingScreenFadeFrames as _initLoadingScreenFadeFrames } from './sprite-init.js';
import { HEAL_NUM_PAL, DMG_SHOW_MS, resetAllDmgNums, tickDmgNums, tickHealNums, clearHealNums, initMissSprite,
         getEnemyDmgNum, setEnemyDmgNum, getPlayerDamageNum, setPlayerDamageNum,
         getPlayerHealNum, setPlayerHealNum, getEnemyHealNum, setEnemyHealNum,
         getAllyDamageNums, getSwDmgNums,
         drawBattleNum } from './damage-numbers.js';
// OK_IDLE, OK_VICTORY, etc. → sprite-init.js

const isMobile = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

// Save state (selectCursor, saveSlots, saveSlotsToDB, loadSlotsFromDB) → save-state.js


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
// Weapon blade + fist canvases → weapon-sprites.js
let battleSpriteHitCanvas = null;      // taking damage / recoil
let battleSpriteDefendCanvas = null;   // defend pose 16×24 (tiles $43-$48)
let battleSpriteKneelCanvas = null;    // low HP kneel pose 16×16 (PPU $09-$0C)
let sweatFrames = [];                  // 2 × 16×8 canvases (near-fatal dot animation)
let defendSparkleFrames = [];          // 4 × 8×8 canvases ($49-$4C)
let cureSparkleFrames = [];            // 2 × 16×16 canvases (config A/B from $4D/$4E)
// battleFistCanvas → weapon-sprites.js
let silhouetteCanvas = null;

// FF1&2 ROM — secondary ROM for monster sprites, etc.
let ff12Raw = null;
// FF2_OFFSET, FF2_ADAMANTOISE_SPRITE → sprite-init.js
let adamantoiseFrames = null; // [normal, flipped] canvases

// Boss sprite — positioned in dungeon boss room
let bossSprite = null;  // { canvas, px, py } or null

// LAND_TURTLE_PAL_*, GOBLIN_*, MOOGLE_*, INVINCIBLE_* constants → sprite-init.js
// MONSTER_DEATH_FRAMES → sprite-init.js (imported)
let goblinBattleCanvas = null;  // 32×32 canvas
let goblinWhiteCanvas = null;   // 32×32 all-white version for pre-attack flash
let goblinDeathFrames = null;   // pre-rendered diagonal deterioration frames
let moogleFrames = null; // [normal, flipped] canvases
let invincibleFrames = null; // [frameA, frameB] 32×32 canvases (east-facing)

// Loading screen fade state — LOAD_FADE_STEP_MS, LOAD_FADE_MAX imported from loading-screen.js

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

// Player select screen state → save-state.js (selectCursor, saveSlots, nameBuffer, etc.)

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
let swPhaseCanvases = [];      // 3-phase expanding ice explosion [16×16, 32×32, 48×48]

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

// Boss fight state — stats read from monsters.js (Land Turtle 0xCC)
const _BOSS_DATA = MONSTERS.get(0xCC) || { hp: 120, atk: 8, def: 1 };
let enemyHP = _BOSS_DATA.hp;
const BOSS_ATK = _BOSS_DATA.atk, BOSS_DEF = _BOSS_DATA.def, BOSS_MAX_HP = _BOSS_DATA.hp;

let battleState = 'none';
let battleTimer = 0;
// sfxCutTimerId moved to battle-sfx.js
let battleMessage = null;     // Uint8Array for status messages
let bossFlashTimer = 0;
let battleShakeTimer = 0;
let enemyDefeated = false;
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
const BATTLE_DMG_SHOW_MS = DMG_SHOW_MS;
const BATTLE_SHAKE_MS = 300;
const BATTLE_VICTORY_HOLD_MS = 1500;
const BOSS_BLOCK_SIZE = 16;            // 16×16 pixel blocks for dissolve
const BOSS_BLOCK_COLS = 3;             // 48/16 = 3 blocks wide
const BOSS_BLOCKS = 9;                 // 3×3 blocks
const BOSS_DISSOLVE_STEPS = 8;         // 8 pixel-shift steps per block
const BOSS_DISSOLVE_FRAME_MS = 16.67;  // 1 NES frame per step
const BOSS_BOX_EXPAND_MS = 300;        // box expand from center duration
const BATTLE_PANEL_W = 120;            // left section width in bottom panel
const VICTORY_BOX_ROWS = 8;             // HUD_BOT_H / 8 — row-by-row expand
const VICTORY_ROW_FRAME_MS = 16.67;     // 1 NES frame per row
const BOSS_PREFLASH_MS = 133;            // 8 NES frames — boss pre-attack white blink
const MONSTER_DEATH_MS = 250;            // diagonal tile wipe — 7 visible steps × 33ms (ROM: 2F/BC68)
const MONSTER_SLIDE_MS = 267;            // 16 frames at 60fps — sprites slide in from left
const DEFEND_SPARKLE_FRAME_MS = 133;     // 8 NES frames per tile
const DEFEND_SPARKLE_TOTAL_MS = 533;     // 4 tiles × 133ms
// DEFEND_SPARKLE_PAL → sprite-init.js
// Authentic damage bounce keyframes from FCEUX trace (Y offsets from baseline, up = negative)
// 30 frames total = 500ms at 60fps

const TARGET_CURSOR_BLINK_MS = 133;      // cursor blink rate during target select

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
// CURSOR_TILE_ROM → sprite-init.js
let cursorTileCanvas = null;
let cursorFadeCanvases = null; // [step1..step4] NES-faded cursor canvases
// PAUSE_ITEMS → data/strings.js

// getPlayerLocation, getRosterPlayers, getRosterVisible, roster state/update/draw ��� roster.js
// fakePlayer portrait vars stay here (shared by battle-drawing, battle-ally, pvp)
let fakePlayerPortraits = [];
let fakePlayerFullBodyCanvases = [];
let fakePlayerHitFullBodyCanvases = [];
let fakePlayerVictoryPortraits = [];
let fakePlayerHitPortraits = [];
let fakePlayerDefendPortraits = [];
let fakePlayerKneelPortraits = [];
let fakePlayerAttackPortraits = [];
let fakePlayerAttackLPortraits = [];
let fakePlayerKnifeBackPortraits = [];
let fakePlayerKnifeRPortraits = [];
let fakePlayerKnifeLPortraits = [];
let fakePlayerKnifeRFullBodyCanvases = [];
let fakePlayerKnifeLFullBodyCanvases = [];
let fakePlayerKnifeBackFullBodyCanvases = [];
let fakePlayerKnifeRFwdFullBodyCanvases = [];
let fakePlayerKnifeLFwdFullBodyCanvases = [];
let fakePlayerKneelFullBodyCanvases = [];
let fakePlayerVictoryFullBodyCanvases = [];
let fakePlayerDeathFrames = [];
let fakePlayerDeathPoseCanvases = [];

// Battle allies — roster players that join combat
let battleAllies = [];         // [{name, palIdx, level, hp, maxHP, atk, def, agi, fadeStep}]
let allyJoinTimer = 0;         // ms until next join check
let allyJoinRound = 0;         // combat round counter
let currentAllyAttacker = -1;  // index into battleAllies during ally turn
let allyTargetIndex = -1;      // which enemy the ally is attacking
let allyHitResult = null;      // current hit result {damage, crit} or {miss} (for drawing compat)
let allyHitResults = [];       // full combo hit array for current ally turn
let allyHitIdx = 0;            // current hit index in ally combo
let allyHitIsLeft = false;     // true when current ally hit is L-hand
let allyShakeTimer = {};       // {allyIdx: ms remaining}
let playerDeathTimer = null;   // null = alive, number = ms into death animation
let _teamWipeMsgShown = false;
let enemyTargetAllyIdx = -1;   // which ally an enemy is targeting (-1 = player)
let allyExitTimer = 0;         // ms since victory-celebrate started (for ally exit fade)
let turnTimer = 0;             // ms elapsed while player is deciding; auto-skip at TURN_TIME_MS
const TURN_TIME_MS = 10000;    // 10 seconds to act before turn is skipped
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

// Flame sprite state → flame-sprites.js
// Star sprite tiles → flame-sprites.js
let starEffect = null;     // {frame, radius, angle, spin, onComplete} or null
let pondStrobeTimer = 0;  // >0 = pond strobe active


// Screen wipe timing constants → transitions.js
// WIPE_DURATION → transitions.js (roster.js gets it via shared context)

// Screen shake state (earthquake effect for secret passages)
const SHAKE_DURATION = 34 * (1000 / 60);  // 2 × 17 NES frames ≈ 567ms
let shakeActive = false;
let shakeTimer = 0;
let shakePendingAction = null;

// _onChatKeyDown → chat.js (onChatKeyDown)
// _onNameEntryKeyDown → title-screen.js (onNameEntryKeyDown)
export function init() {
  setInventoryGetter(() => playerInventory);
  setLocationGetter(() => ({ onWorldMap, currentMapId }));
  canvas = document.getElementById('game-canvas');
  ctx = canvas.getContext('2d');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  ctx.imageSmoothingEnabled = false;

  window.addEventListener('keydown', (e) => {
    if (chatState.inputActive) { onChatKeyDown(e); return; }
    if (titleSt.state === 'name-entry') { onNameEntryKeyDown(e); return; }
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
  window.addEventListener('beforeunload', () => { saveSlotsToDB(); });
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

// _renderPortrait through initLoadingScreenFadeFrames → sprite-init.js

// _pauseFadeStep → pause-menu.js
function _drawHudWithFade(fullCanvas, fadeCanvases, fadeStep) {
  if (fadeStep > 0 && fadeCanvases && fadeStep <= fadeCanvases.length) {
    ctx.drawImage(fadeCanvases[fadeStep - 1], 0, 0);
    ctx.save(); ctx.beginPath(); ctx.rect(0, HUD_BOT_Y, CANVAS_W, HUD_BOT_H); ctx.clip();
    ctx.drawImage(fullCanvas, 0, 0); ctx.restore();
  } else { ctx.drawImage(fullCanvas, 0, 0); }
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
  resetAllDmgNums();
  encounterDropItem = null; bossFlashTimer = 0; battleShakeTimer = 0;
  isDefending = false; battleAllies = []; allyJoinRound = 0;
  currentAllyAttacker = -1; allyTargetIndex = -1; allyHitResult = null; allyHitIsLeft = false;
  allyShakeTimer = {}; enemyTargetAllyIdx = -1; allyExitTimer = 0;
  resetBattleItemVars();
  playerDeathTimer = null; _teamWipeMsgShown = false;
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

function returnToTitle() {
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
  return { drawLoadingOverlay: () => drawLoadingOverlay(_loadingShared()) };
}
function _loadingShared() {
  return {
    ctx,
    get transTimer()          { return transSt.timer; },
    get loadingBgFadeFrames() { return loadingBgFadeFrames; },
    get moogleFadeFrames()    { return moogleFadeFrames; },
    get bossFadeFrames()      { return bossFadeFrames; },
    get adamantoiseFrames()   { return adamantoiseFrames; },
    get borderFadeSets()      { return borderFadeSets; },
    get borderTileCanvases()  { return borderTileCanvases; },
    get isMobile()            { return isMobile; },
    drawText, measureText, TEXT_WHITE,
    drawBoxOnCtx: _drawBoxOnCtx,
    HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H,
    HUD_RIGHT_X, HUD_RIGHT_W,
  };
}
// Wrapper that pre-computes rosterLocChanged before calling transitions.js
function _triggerWipe(action, destMapId) {
  const rc = destMapId != null && rosterLocForMapId(destMapId) !== getPlayerLocation();
  startWipeTransition(action, destMapId, rc);
}

// Team wipe check — true when player AND all allies are dead
function _isTeamWiped() {
  if (ps.hp > 0) return false;
  return battleAllies.every(a => a.hp <= 0);
}

// PVP-aware enemy HP access — reads/writes authoritative source directly, no proxy sync needed
function _getEnemyHP() {
  if (pvpSt.isPVPBattle) {
    if (pvpSt.pvpPlayerTargetIdx < 0) return pvpSt.pvpOpponentStats.hp;
    return pvpSt.pvpEnemyAllies[pvpSt.pvpPlayerTargetIdx].hp;
  }
  return enemyHP;
}
function _setEnemyHP(v) {
  if (pvpSt.isPVPBattle) {
    if (pvpSt.pvpPlayerTargetIdx < 0) pvpSt.pvpOpponentStats.hp = v;
    else pvpSt.pvpEnemyAllies[pvpSt.pvpPlayerTargetIdx].hp = v;
  }
  enemyHP = v;
}

// Shared state object passed to input-handler.js functions
function _inputShared() {
  return {
    keys,
    playerInventory,
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
    get isPVPBattle()           { return pvpSt.isPVPBattle; },
    get pvpOpponentStats()      { return pvpSt.pvpOpponentStats; },
    get pvpEnemyAllies()        { return pvpSt.pvpEnemyAllies; },
    get pvpPlayerTargetIdx()    { return pvpSt.pvpPlayerTargetIdx; },
    set pvpPlayerTargetIdx(v)   { pvpSt.pvpPlayerTargetIdx = v; },
    get enemyHP()                { return _getEnemyHP(); },
    set enemyHP(v)               { _setEnemyHP(v); },
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
    get enemyHP()                { return _getEnemyHP(); },
    set enemyHP(v)               { _setEnemyHP(v); },
    get enemyDefeated()          { return enemyDefeated; },
    set enemyDefeated(v)         { enemyDefeated = v; },
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
    get playerDamageNum()       { return getPlayerDamageNum(); },
    set playerDamageNum(v)      { setPlayerDamageNum(v); },
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
    get allyDamageNums()        { return getAllyDamageNums(); },
    get allyShakeTimer()        { return allyShakeTimer; },
    ctx,
    // ── Weapon sprite canvases (stable after init) ────────────────────────────
    get blades() {
      return {
        ...getBlades(),
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
    get deathPoseCanvases()           { return fakePlayerDeathPoseCanvases; },
    get victoryFullBodyCanvases()      { return fakePlayerVictoryFullBodyCanvases; },
    get fakePlayerDeathFrames()        { return fakePlayerDeathFrames; },
    get defendSparkleFrames()          { return defendSparkleFrames; },
    get cureSparkleFrames()            { return cureSparkleFrames; },
    get swPhaseCanvases()              { return swPhaseCanvases; },
    get enemyHealNum()                 { return getEnemyHealNum(); },
    set enemyHealNum(v)                { setEnemyHealNum(v); },
    advancePVPTargetOrVictory: _advancePVPTargetOrVictory,
    // ── Delegated update functions ────────────────────────────────────────────
    updateTimers:           (dt) => _updateBattleTimers(dt),
    handlePlayerAttack:     ()   => _updateBattlePlayerAttack(),
    handleDefendItem:       (dt) => _updateBattleDefendItem(dt),
    handleAlly:             ()   => updateBattleAlly(_allyShared()),
    handleEndSequence:      (dt) => _updateBattleEndSequence(dt),
    tryJoinPlayerAlly:       ()  => _tryJoinPlayerAlly(),
    buildAndProcessNextTurn: ()  => { turnQueue = buildTurnOrder(); processNextTurn(); },
    // ── Other functions ───────────────────────────────────────────────────────
    resetBattleVars:     _resetBattleVars,
    processNextTurn,
    isTeamWiped:         _isTeamWiped,
    getPlayerLocation,
    getSlashFramesForWeapon,
    clipToViewport:  _clipToViewport,
    drawBorderedBox: _drawBorderedBox,
    drawText,
    measureText,
    nameToBytes: _nameToBytes,
    get cursorTileCanvas() { return cursorTileCanvas; },
    get sweatFrames() { return sweatFrames; },
    get critFlashTimer()  { return critFlashTimer; },
    set critFlashTimer(v) { critFlashTimer = v; },
  };
}

function _allyShared() {
  return {
    get battleState()           { return battleState; },
    set battleState(v)          { battleState = v; },
    get battleTimer()           { return battleTimer; },
    set battleTimer(v)          { battleTimer = v; },
    get enemyHP()                { return _getEnemyHP(); },
    set enemyHP(v)               { _setEnemyHP(v); },
    get isRandomEncounter()     { return isRandomEncounter; },
    get battleAllies()          { return battleAllies; },
    get currentAllyAttacker()   { return currentAllyAttacker; },
    get allyTargetIndex()       { return allyTargetIndex; },
    get allyHitResult()         { return allyHitResult; },
    set allyHitResult(v)        { allyHitResult = v; },
    get allyHitResults()        { return allyHitResults; },
    get allyHitIdx()            { return allyHitIdx; },
    set allyHitIdx(v)           { allyHitIdx = v; },
    get allyHitIsLeft()         { return allyHitIsLeft; },
    set allyHitIsLeft(v)        { allyHitIsLeft = v; },
    get encounterMonsters()     { return encounterMonsters; },
    get dyingMonsterIndices()   { return dyingMonsterIndices; },
    set dyingMonsterIndices(v)  { dyingMonsterIndices = v; },
    get enemyTargetAllyIdx()    { return enemyTargetAllyIdx; },
    set enemyTargetAllyIdx(v)   { enemyTargetAllyIdx = v; },
    get critFlashTimer()        { return critFlashTimer; },
    set critFlashTimer(v)       { critFlashTimer = v; },
    get enemyDmgNum()         { return getEnemyDmgNum(); },
    set enemyDmgNum(v)        { setEnemyDmgNum(v); },
    get turnQueue()             { return turnQueue; },
    set turnQueue(v)            { turnQueue = v; },
    get pvpSt()                 { return pvpSt; },
    get inputSt()               { return inputSt; },
    BOSS_DEF,
    BATTLE_SHAKE_MS,
    BATTLE_DMG_SHOW_MS,
    ROSTER_FADE_STEPS,
    processNextTurn,
    buildTurnOrder,
    isTeamWiped: _isTeamWiped,
  };
}

function _magicItemShared() {
  return {
    get battleState()           { return battleState; },
    set battleState(v)          { battleState = v; },
    get battleTimer()           { return battleTimer; },
    set battleTimer(v)          { battleTimer = v; },
    get isRandomEncounter()     { return isRandomEncounter; },
    get encounterMonsters()     { return encounterMonsters; },
    get dyingMonsterIndices()   { return dyingMonsterIndices; },
    set dyingMonsterIndices(v)  { dyingMonsterIndices = v; },
    get ps()                    { return ps; },
    get inputSt()               { return inputSt; },
    get pvpSt()                 { return pvpSt; },
    getEnemyHP: _getEnemyHP,
    setEnemyHP: _setEnemyHP,
    processNextTurn,
  };
}

function _enemyShared() {
  return {
    get battleState()           { return battleState; },
    set battleState(v)          { battleState = v; },
    get battleTimer()           { return battleTimer; },
    set battleTimer(v)          { battleTimer = v; },
    get battleAllies()          { return battleAllies; },
    get encounterMonsters()     { return encounterMonsters; },
    get currentAttacker()       { return currentAttacker; },
    get enemyTargetAllyIdx()    { return enemyTargetAllyIdx; },
    set enemyTargetAllyIdx(v)   { enemyTargetAllyIdx = v; },
    get allyDamageNums()        { return getAllyDamageNums(); },
    get allyShakeTimer()        { return allyShakeTimer; },
    get playerDamageNum()       { return getPlayerDamageNum(); },
    set playerDamageNum(v)      { setPlayerDamageNum(v); },
    get battleShakeTimer()      { return battleShakeTimer; },
    set battleShakeTimer(v)     { battleShakeTimer = v; },
    get isDefending()           { return isDefending; },
    set isDefending(v)          { isDefending = v; },
    get ps()                    { return ps; },
    get inputSt()               { return inputSt; },
    ITEMS,
    BOSS_HIT_RATE,
    GOBLIN_HIT_RATE,
    BOSS_ATK,
    BOSS_PREFLASH_MS,
    BATTLE_SHAKE_MS,
    BATTLE_DMG_SHOW_MS,
    processNextTurn,
    isTeamWiped: _isTeamWiped,
  };
}

function _battleDrawShared() {
  return {
    get battleState() { return battleState; },
    get battleTimer() { return battleTimer; },
    get enemyHP() { return _getEnemyHP(); },
    get enemyDefeated() { return enemyDefeated; },
    get isRandomEncounter() { return isRandomEncounter; },
    get isDefending() { return isDefending; },
    get enemyDmgNum() { return getEnemyDmgNum(); },
    get playerDamageNum() { return getPlayerDamageNum(); },
    get playerHealNum() { return getPlayerHealNum(); },
    get enemyHealNum() { return getEnemyHealNum(); },
    get battleShakeTimer() { return battleShakeTimer; },
    get playerDeathTimer() { return playerDeathTimer; },
    get deathPoseCanvases() { return fakePlayerDeathPoseCanvases; },
    get critFlashTimer() { return critFlashTimer; },
    set critFlashTimer(v) { critFlashTimer = v; },
    get currentHitIdx() { return currentHitIdx; },
    get currentAttacker() { return currentAttacker; },
    get slashFrame() { return slashFrame; },
    get slashOffX() { return slashOffX; },
    get slashOffY() { return slashOffY; },
    get slashFrames() { return slashFrames; },
    get slashFramesR() { return slashFramesR; },
    get currentAllyAttacker() { return currentAllyAttacker; },
    get allyHitResult() { return allyHitResult; },
    get allyHitIsLeft() { return allyHitIsLeft; },
    get allyTargetIndex() { return allyTargetIndex; },
    get enemyTargetAllyIdx() { return enemyTargetAllyIdx; },
    get allyJoinRound() { return allyJoinRound; },
    get runSlideBack() { return runSlideBack; },
    get encounterExpGained() { return encounterExpGained; },
    get encounterGilGained() { return encounterGilGained; },
    get encounterDropItem() { return encounterDropItem; },
    get encounterProfLevelUps() { return encounterProfLevelUps; },
    get profLevelUpIdx() { return profLevelUpIdx; },
    get southWindTargets() { return getTargets(); },
    get southWindHitIdx() { return getHitIdx(); },
    get southWindDmgNums() { return getSwDmgNums(); },
    get dyingMonsterIndices() { return dyingMonsterIndices; },
    get encounterMonsters() { return encounterMonsters; },
    get battleAllies() { return battleAllies; },
    get allyDamageNums() { return getAllyDamageNums(); },
    get allyShakeTimer() { return allyShakeTimer; },
    get battleMessage() { return battleMessage; },
    ctx,
    get battleSpriteCanvas() { return battleSpriteCanvas; },
    get battleSpriteAttackCanvas() { return battleSpriteAttackCanvas; },
    get battleSpriteAttack2Canvas() { return battleSpriteAttack2Canvas; },
    get battleSpriteAttackLCanvas() { return battleSpriteAttackLCanvas; },
    get battleSpriteKnifeRCanvas() { return battleSpriteKnifeRCanvas; },
    get battleSpriteKnifeLCanvas() { return battleSpriteKnifeLCanvas; },
    get battleSpriteKnifeBackCanvas() { return battleSpriteKnifeBackCanvas; },
    get battleSpriteHitCanvas() { return battleSpriteHitCanvas; },
    get battleSpriteDefendCanvas() { return battleSpriteDefendCanvas; },
    get battleSpriteKneelCanvas() { return battleSpriteKneelCanvas; },
    get battleSpriteVictoryCanvas() { return battleSpriteVictoryCanvas; },
    get battleSpriteFadeCanvases() { return battleSpriteFadeCanvases; },
    get battleSpriteDefendFadeCanvases() { return battleSpriteDefendFadeCanvases; },
    get battleSpriteKneelFadeCanvases() { return battleSpriteKneelFadeCanvases; },
    get battleKnifeBladeCanvas() { return getKnifeBladeCanvas(); },
    get battleKnifeBladeSwungCanvas() { return getKnifeBladeSwungCanvas(); },
    get battleDaggerBladeCanvas() { return getDaggerBladeCanvas(); },
    get battleDaggerBladeSwungCanvas() { return getDaggerBladeSwungCanvas(); },
    get battleSwordBladeCanvas() { return getSwordBladeCanvas(); },
    get battleSwordBladeSwungCanvas() { return getSwordBladeSwungCanvas(); },
    get battleFistCanvas() { return getFistCanvas(); },
    get fakePlayerPortraits() { return fakePlayerPortraits; },
    get fakePlayerVictoryPortraits() { return fakePlayerVictoryPortraits; },
    get fakePlayerHitPortraits() { return fakePlayerHitPortraits; },
    get fakePlayerDefendPortraits() { return fakePlayerDefendPortraits; },
    get fakePlayerKneelPortraits() { return fakePlayerKneelPortraits; },
    get fakePlayerAttackPortraits() { return fakePlayerAttackPortraits; },
    get fakePlayerAttackLPortraits() { return fakePlayerAttackLPortraits; },
    get fakePlayerKnifeBackPortraits() { return fakePlayerKnifeBackPortraits; },
    get fakePlayerKnifeRPortraits() { return fakePlayerKnifeRPortraits; },
    get fakePlayerKnifeLPortraits() { return fakePlayerKnifeLPortraits; },
    get goblinBattleCanvas() { return goblinBattleCanvas; },
    get goblinWhiteCanvas() { return goblinWhiteCanvas; },
    get goblinDeathFrames() { return goblinDeathFrames; },
    get swPhaseCanvases() { return swPhaseCanvases; },
    get defendSparkleFrames() { return defendSparkleFrames; },
    get cureSparkleFrames() { return cureSparkleFrames; },
    get sweatFrames() { return sweatFrames; },
    get cursorTileCanvas() { return cursorTileCanvas; },
    get cursorFadeCanvases() { return cursorFadeCanvases; },
    get topBoxBgCanvas() { return topBoxBgCanvas; },
    get topBoxBgFadeFrames() { return topBoxBgFadeFrames; },
    topBoxSt,
    clipToViewport: _clipToViewport,
    grayViewport: _grayViewport,
    drawBorderedBox: _drawBorderedBox,
    drawSparkleCorners: _drawSparkleCorners,
    drawCursorFaded: _drawCursorFaded,
    drawHudBox: _drawHudBox,
    isVictoryBattleState: _isVictoryBattleState,
    drawMonsterDeath: _drawMonsterDeath,
    getSlashFramesForWeapon,
    pvpShared: () => _pvpShared(),
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
    rosterLocForMapId,
    getPlayerLocation,
  };
}

// Shared state object passed to title-screen.js draw functions
function _titleShared() {
  return {
    waterTick,
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

  // Cursor tile (sprite-init.js)
  const ct = _initCursorTile(romRaw);
  cursorTileCanvas = ct.cursorTileCanvas;
  cursorFadeCanvases = ct.cursorFadeCanvases;

  // Battle sprite (sprite-init.js)
  const bs = _initBattleSprite(romRaw);
  battleSpriteCanvas = bs.battleSpriteCanvas;
  battleSpriteFadeCanvases = bs.battleSpriteFadeCanvases;
  silhouetteCanvas = bs.silhouetteCanvas;
  battleSpriteAttackCanvas = bs.battleSpriteAttackCanvas;
  battleSpriteAttackLCanvas = bs.battleSpriteAttackLCanvas;
  battleSpriteKnifeRCanvas = bs.battleSpriteKnifeRCanvas;
  battleSpriteKnifeLCanvas = bs.battleSpriteKnifeLCanvas;
  battleSpriteKnifeBackCanvas = bs.battleSpriteKnifeBackCanvas;
  battleSpriteVictoryCanvas = bs.battleSpriteVictoryCanvas;
  battleSpriteHitCanvas = bs.battleSpriteHitCanvas;
  battleSpriteAttack2Canvas = bs.battleSpriteAttack2Canvas;
  battleSpriteDefendCanvas = bs.battleSpriteDefendCanvas;
  battleSpriteDefendFadeCanvases = bs.battleSpriteDefendFadeCanvases;
  defendSparkleFrames = bs.defendSparkleFrames;
  cureSparkleFrames = bs.cureSparkleFrames;
  battleSpriteKneelCanvas = bs.battleSpriteKneelCanvas;
  battleSpriteKneelFadeCanvases = bs.battleSpriteKneelFadeCanvases;
  sweatFrames = bs.sweatFrames;

  // Fake player portraits & full bodies (sprite-init.js)
  const fp = _initFakePlayerPortraits(romRaw);
  fakePlayerPortraits = fp.fakePlayerPortraits;
  fakePlayerVictoryPortraits = fp.fakePlayerVictoryPortraits;
  fakePlayerHitPortraits = fp.fakePlayerHitPortraits;
  fakePlayerDefendPortraits = fp.fakePlayerDefendPortraits;
  fakePlayerAttackPortraits = fp.fakePlayerAttackPortraits;
  fakePlayerAttackLPortraits = fp.fakePlayerAttackLPortraits;
  fakePlayerKnifeBackPortraits = fp.fakePlayerKnifeBackPortraits;
  fakePlayerKnifeRPortraits = fp.fakePlayerKnifeRPortraits;
  fakePlayerKnifeLPortraits = fp.fakePlayerKnifeLPortraits;
  fakePlayerKneelPortraits = fp.fakePlayerKneelPortraits;
  fakePlayerFullBodyCanvases = fp.fakePlayerFullBodyCanvases;
  fakePlayerKnifeRFullBodyCanvases = fp.fakePlayerKnifeRFullBodyCanvases;
  fakePlayerKnifeLFullBodyCanvases = fp.fakePlayerKnifeLFullBodyCanvases;
  fakePlayerKnifeBackFullBodyCanvases = fp.fakePlayerKnifeBackFullBodyCanvases;
  fakePlayerKnifeLFwdFullBodyCanvases = fp.fakePlayerKnifeLFwdFullBodyCanvases;
  fakePlayerKnifeRFwdFullBodyCanvases = fp.fakePlayerKnifeRFwdFullBodyCanvases;
  fakePlayerKneelFullBodyCanvases = fp.fakePlayerKneelFullBodyCanvases;
  fakePlayerVictoryFullBodyCanvases = fp.fakePlayerVictoryFullBodyCanvases;
  fakePlayerHitFullBodyCanvases = fp.fakePlayerHitFullBodyCanvases;
  fakePlayerDeathPoseCanvases = fp.fakePlayerDeathPoseCanvases;
  fakePlayerDeathFrames = fp.fakePlayerDeathFrames;

  initRoster();
  loadBossSprite(0xCC); // Land Turtle — loaded eagerly for now (only boss in game)

  // Goblin sprite (sprite-init.js)
  const gs = _initGoblinSprite(romRaw);
  goblinBattleCanvas = gs.goblinBattleCanvas;
  goblinWhiteCanvas = gs.goblinWhiteCanvas;
  goblinDeathFrames = gs.goblinDeathFrames;

  initMonsterSprites();
  swPhaseCanvases = initSouthWindSprite();
  initMissSprite();
  slashFrames = slashFramesR = slashFramesL = initSlashSprites();
  knifeSlashFramesR = knifeSlashFramesL = initKnifeSlashSprites();
  swordSlashFramesR = swordSlashFramesL = initSwordSlashSprites();
  initPlayerStats(romRaw);
  initExpTable(romRaw);

  // Moogle sprite (sprite-init.js)
  const ms = _initMoogleSprite(romRaw);
  moogleFrames = ms.moogleFrames;

  // Loading screen fade frames (sprite-init.js)
  const lf = _initLoadingScreenFadeFrames(romRaw, ff12Raw);
  moogleFadeFrames = lf.moogleFadeFrames;
  bossFadeFrames = lf.bossFadeFrames;

  initMusic(romRaw);
  initFlameRawTiles(romRaw);
  initStarTiles(romRaw);
}
function _initTitleAssets(romRaw) {
  const inv = _initInvincibleSprite(romRaw, TITLE_FADE_MAX);
  invincibleFrames = inv.invincibleFrames;
  titleSt.shipFadeFrames = inv.shipFadeFrames;
  titleSt.shadowFade = inv.shadowFade;
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

  // Wire console command context
  setCommandContext({
    getRosterNames: () => PLAYER_POOL.filter(p => p.loc === getPlayerLocation()).map(p => p.name),
  });

  // Startup console log
  consoleLog('FF3 MMO v1.2.4');
  consoleLog('ROM: ' + rom.prgBanks + ' PRG, ' + rom.chrBanks + ' CHR, mapper ' + rom.mapper);
  consoleLog('English patch applied');
  const email = localStorage.getItem('ff3_email');
  consoleLog('Auth: ' + (email || 'guest'));
  const saveSrc = window.ff3Auth ? 'server' : 'local';
  const slotCount = saveSlots.filter(s => s !== null).length;
  consoleLog('Saves: ' + slotCount + '/3 slots (' + saveSrc + ')');
  consoleLog('Type /help for commands');
}

export function loadFF12ROM(arrayBuffer) {
  ff12Raw = new Uint8Array(arrayBuffer);
  const ad = _initAdamantoise(ff12Raw);
  adamantoiseFrames = ad.adamantoiseFrames;
  initFF1Music(ff12Raw);
  if (romRaw) initProfIcons(romRaw, ff12Raw);
  if (romRaw) { // rebuild loading screen fade frames with boss fade
    const lf2 = _initLoadingScreenFadeFrames(romRaw, ff12Raw);
    moogleFadeFrames = lf2.moogleFadeFrames;
    bossFadeFrames = lf2.bossFadeFrames;
  }
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
  clearFlameSprites();
  bossSprite = (floorIndex === 4 && adamantoiseFrames && !enemyDefeated)
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
  enemyDefeated = false;  // boss respawns on dungeon re-entry
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
  if (bossSprite && !enemyDefeated && tileX === bossSprite.px / TILE_SIZE && tileY === bossSprite.py / TILE_SIZE) {
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
  if (pondStrobeTimer > 0) return;
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
  if (bossSprite && !enemyDefeated && facedX === 6 && facedY === 8) {
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

// Loading screen overlay + info box → loading-screen.js

// findWorldExitIndex, _checkWorldMapTrigger, _checkHiddenTrap, _triggerMapTransition,
// _checkDynType1, _checkDynType4, _checkExitPrev, checkTrigger → map-triggers.js

function _startMoveFromKeys(resetOnIdle) {
  if (keys['ArrowDown']) startMove(DIR_DOWN);
  else if (keys['ArrowUp']) startMove(DIR_UP);
  else if (keys['ArrowLeft']) startMove(DIR_LEFT);
  else if (keys['ArrowRight']) startMove(DIR_RIGHT);
  else if (resetOnIdle) sprite.resetFrame();
}


// Flame/star sprite decode + rendering → flame-sprites.js
function _rebuildFlameSprites() { rebuildFlameSprites(mapData, mapRenderer, TILE_SIZE); }




function _renderSprites(camX, camY, originX, originY, spriteY) {
  const _fs = getFlameSprites();
  if (!onWorldMap && _fs.length > 0) {
    const flameFrame = Math.floor(waterTick / 8) & 1;
    const wLeft = camX - originX;
    const wTop = camY - originY;
    const _ff = getFlameFrames();
    for (const flame of _fs) {
      const sx = flame.px - wLeft;
      const sy = flame.py - wTop;
      if (sx < -16 || sx > CANVAS_W || sy < -16 || sy > CANVAS_H) continue;
      const frames = _ff.get(flame.npcId);
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
  const _st = getStarTiles();
  if (!starEffect || !_st) return;
  const { radius, angle, frame } = starEffect;
  const tile = _st[(frame >> 4) & 1];
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
  const topShake = ((battleState === 'enemy-attack' || battleState === 'pvp-opp-sw-hit') && battleShakeTimer > 0)
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
function _drawHealNum(bx, by, value, pal) {
  drawBattleNum(ctx, bx, by, value, pal);
}
function _drawPauseHealNum(px, py) {
  if (!pauseSt.healNum || pauseSt.healNum.rosterIdx >= 0) return;
  _drawHealNum(px + 8, _dmgBounceY(py + 8, pauseSt.healNum.timer), pauseSt.healNum.value, HEAL_NUM_PAL);
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

  // Player death: text stays during slide, fades out after slide ends (500-800ms)
  if (playerDeathTimer != null) {
    if (playerDeathTimer < 500) {
      // Phase 1 (slide): text stays visible
    } else if (playerDeathTimer < 800) {
      // Phase 2 (text fade): alpha fades from 1→0
      const deathAlpha = 1 - (playerDeathTimer - 500) / 300;
      ctx.save();
      ctx.globalAlpha = deathAlpha;
    } else {
      return; // Phase 3+: no text
    }
  }

  const shakeOff = ((battleState === 'enemy-attack' || battleState === 'pvp-opp-sw-hit') && battleShakeTimer > 0)
    ? (Math.floor(battleShakeTimer / 67) & 1 ? 2 : -2) : 0;
  const sy = HUD_VIEW_Y + 8;
  const panelRight = HUD_RIGHT_X + HUD_RIGHT_W - 8 + shakeOff;
  const slot = saveSlots[selectCursor];
  const deathTextFading = playerDeathTimer != null && playerDeathTimer >= 500 && playerDeathTimer < 800;
  if (!slot) { if (deathTextFading) ctx.restore(); return; }
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

  if (deathTextFading) ctx.restore();
}

// Loading right panel, moogle, chat bubble → loading-screen.js

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
    drawHUDLoadingMoogle(_loadingShared());
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


// roster draw/update/state → roster.js
// _drawRosterSparkle stays here as callback (needs pauseSt, cureSparkleFrames, _drawHealNum)
function _drawRosterSparkle(panelTop) {
  if (!pauseSt.healNum || pauseSt.healNum.rosterIdx < 0 || cureSparkleFrames.length !== 2) return;
  const visRow = pauseSt.healNum.rosterIdx - inputSt.rosterScroll;
  if (visRow < 0 || visRow >= 3) return;
  const px = HUD_RIGHT_X + 8;
  const py = panelTop + visRow * 32 + 8;
  const fi = Math.floor(pauseSt.timer / 67) & 1;
  const frame = cureSparkleFrames[fi];
  _drawSparkleCorners(frame, px, py);
  _drawHealNum(px + 8, _dmgBounceY(py + 8, pauseSt.healNum.timer), pauseSt.healNum.value, HEAL_NUM_PAL);
}

// ── Title Screen — titleFadeLevel, titleFadePal, draw functions → title-screen.js ──

// _updateTitleUnderwater, _updateTitleSelectCase → title-screen.js
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
  updateTitleUnderwater(dt);

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
    case 'logo-fade-out':        if (titleSt.timer >= TITLE_FADE_MS) { titleSt.state = 'select-box-open'; titleSt.timer = 0; setSelectCursor(0); titleSt.deleteMode = false; } break;
    case 'select-box-open':      if (titleSt.timer >= BOSS_BOX_EXPAND_MS) { titleSt.state = 'select-fade-in'; titleSt.timer = 0; } break;
    case 'select-fade-in':       if (titleSt.timer >= (SELECT_TEXT_STEPS + 1) * SELECT_TEXT_STEP_MS) { titleSt.state = 'select'; titleSt.timer = 0; } break;
    case 'select':               updateTitleSelect(keys); break;
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
  const frames = getMonsterDeathFrames(monsterId, goblinDeathFrames);
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
  if (ps.hp > 0) {
    const playerAgi = ps.stats ? ps.stats.agi : 5;
    actors.push({ type: 'player', priority: (playerAgi * 2) + Math.floor(Math.random() * 256) });
  }
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
    // Main opponent — only if still alive (use authoritative HP, not enemyHP proxy)
    if (pvpSt.pvpOpponentStats && pvpSt.pvpOpponentStats.hp > 0)
      actors.push({ type: 'enemy', index: -1, pvpAllyIdx: -1, priority: Math.floor(Math.random() * 256) });
    // PVP enemy allies — only alive ones
    for (let i = 0; i < pvpSt.pvpEnemyAllies.length; i++) {
      if (pvpSt.pvpEnemyAllies[i].hp > 0)
        actors.push({ type: 'enemy', index: -1, pvpAllyIdx: i, priority: Math.floor(Math.random() * 256) });
    }
  } else {
    actors.push({ type: 'enemy', index: -1, priority: Math.floor(Math.random() * 256) });
  }
  actors.sort((a, b) => b.priority - a.priority);
  return actors;
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


function _playerTurnConsumable() {
  playSFX(SFX.CURE);
  const { target, allyIndex } = inputSt.playerActionPending;
  if (target === 'player' && (allyIndex === undefined || allyIndex < 0)) {
    const heal = Math.min(50, ps.stats.maxHP - ps.hp);
    ps.hp += heal; itemHealAmount = heal; setPlayerHealNum({ value: heal, timer: 0 });
  } else if (target === 'player' && allyIndex >= 0) {
    const ally = battleAllies[allyIndex];
    if (ally) {
      const heal = Math.min(50, ally.maxHP - ally.hp);
      ally.hp += heal; itemHealAmount = heal;
      getAllyDamageNums()[allyIndex] = { value: heal, timer: 0, heal: true };
    }
  } else {
    const mon = isRandomEncounter && encounterMonsters ? encounterMonsters[target] : null;
    if (mon) {
      const heal = Math.min(50, mon.maxHP - mon.hp);
      mon.hp += heal; itemHealAmount = heal; setEnemyHealNum({ value: heal, timer: 0, index: target });
    } else {
      const curHP = _getEnemyHP();
      const maxHP = pvpSt.isPVPBattle ? (pvpSt.pvpOpponentStats ? pvpSt.pvpOpponentStats.maxHP : 1) : BOSS_MAX_HP;
      const heal = Math.min(50, maxHP - curHP);
      _setEnemyHP(curHP + heal); itemHealAmount = heal; setEnemyHealNum({ value: heal, timer: 0, index: 0 });
    }
  }
  battleState = 'item-use'; battleTimer = 0;
}

function _playerTurnItem() {
  isDefending = false;
  removeItem(inputSt.playerActionPending.itemId);
  if (ITEMS.get(inputSt.playerActionPending.itemId)?.type === 'battle_item') startMagicItem(_magicItemShared());
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
    isDefending = false; inputSt.battleCursor = 0; turnTimer = 0;
    if (ps.hp <= 0) {
      // Player dead but allies alive — auto-rebuild turn order, skip menu
      turnQueue = buildTurnOrder();
      if (turnQueue.length === 0) return; // safety: nobody alive
      processNextTurn();
      return;
    }
    battleState = 'menu-open'; battleTimer = 0;
    return;
  }
  const turn = turnQueue.shift();
  if (turn.type === 'player') {
    if (ps.hp <= 0) { processNextTurn(); return; } // dead player — skip
    const cmd = inputSt.playerActionPending.command;
    if (cmd === 'fight') _playerTurnFight();
    else if (cmd === 'defend') { playSFX(SFX.DEFEND_HIT); battleState = 'defend-anim'; battleTimer = 0; }
    else if (cmd === 'item') _playerTurnItem();
    else if (cmd === 'skip') processNextTurn();
    else if (cmd === 'run') _playerTurnRun();
  } else if (turn.type === 'ally') {
    currentAllyAttacker = turn.index;
    allyHitIsLeft = false;
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
    const dualWield = isWeapon(ally.weaponId) && isWeapon(ally.weaponL);
    const baseHits = Math.max(1, Math.floor(ally.agi / 10));
    const potentialHits = dualWield ? Math.max(2, baseHits) : Math.max(1, baseHits);
    allyHitResults = rollHits(ally.atk, targetDef, 85, potentialHits);
    allyHitIdx = 0;
    allyHitResult = allyHitResults[0];
    battleState = 'ally-attack-start'; battleTimer = 0;
  } else {
    currentAttacker = turn.index;
    if (pvpSt.isPVPBattle) {
      const pai = turn.pvpAllyIdx ?? -1;
      pvpSt.pvpCurrentEnemyAllyIdx = pai;
      // Skip if this attacker is dead
      if (pai < 0 && (!pvpSt.pvpOpponentStats || pvpSt.pvpOpponentStats.hp <= 0)) { processNextTurn(); return; }
      if (pai >= 0 && (pvpSt.pvpEnemyAllies[pai]?.hp ?? 0) <= 0) { processNextTurn(); return; }
      // Reset combo index for each fresh main-opponent turn
      if (pai < 0) pvpSt.pvpEnemyHitIdx = 0;
    }
    if (turn.index >= 0 && encounterMonsters && encounterMonsters[turn.index].hp <= 0) { processNextTurn(); return; }
    battleState = 'enemy-flash'; battleTimer = 0; pvpSt.pvpPreflashDecided = false;
  }
}


function startBattle() {
  battleState = 'roar-hold';
  battleTimer = 0;
  showMsgBox(BATTLE_ROAR, () => { battleState = 'flash-strobe'; battleTimer = 0; playSFX(SFX.BATTLE_SWIPE); });
  _resetBattleVars();
  enemyHP = BOSS_MAX_HP;
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
  // Sort tallest monsters first so they land on the top row of the grid
  encounterMonsters.sort((a, b) => {
    const ha = getMonsterCanvas(a.monsterId, goblinBattleCanvas)?.height || 32;
    const hb = getMonsterCanvas(b.monsterId, goblinBattleCanvas)?.height || 32;
    return hb - ha;
  });
  preBattleTrack = TRACKS.CRYSTAL_CAVE;
  _resetBattleVars();
  // Skip roar/earthquake — go straight to flash-strobe
  battleState = 'flash-strobe';
  battleTimer = 0;
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
  if (pvpSt.pvpOpponentShakeTimer > 0) pvpSt.pvpOpponentShakeTimer = Math.max(0, pvpSt.pvpOpponentShakeTimer - dt);

  tickDmgNums(dt);
  for (const idx in allyShakeTimer) {
    if (allyShakeTimer[idx] > 0) allyShakeTimer[idx] = Math.max(0, allyShakeTimer[idx] - dt);
  }
  // Start player death animation on first frame of hp=0
  if (ps.hp <= 0 && playerDeathTimer == null && battleState !== 'none') { playerDeathTimer = 0; }
  if (playerDeathTimer != null) playerDeathTimer += dt;
  for (const ally of battleAllies) {
    if (ally.deathTimer != null) ally.deathTimer += dt;
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
        battleState = 'enemy-box-expand'; battleTimer = 0; pauseMusic(); playTrack(TRACKS.BOSS_BATTLE);
      }
    }
  } else if (battleState === 'encounter-box-expand') {
    if (battleTimer >= BOSS_BOX_EXPAND_MS) { battleState = 'monster-slide-in'; battleTimer = 0; }
  } else if (battleState === 'monster-slide-in') {
    if (battleTimer >= MONSTER_SLIDE_MS) { battleState = 'battle-fade-in'; battleTimer = 0; }
  } else if (battleState === 'enemy-box-expand') {
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
  setEnemyDmgNum(allMiss ? { miss: true, timer: 0 } : { value: totalDmg, crit: anyCrit, timer: 0 });
  if (pvpSt.isPVPBattle && !allMiss) pvpSt.pvpOpponentShakeTimer = BATTLE_SHAKE_MS;
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
    const isCrit0 = inputSt.hitResults[currentHitIdx] && inputSt.hitResults[currentHitIdx].crit;
    playSlashSFX(hw0, isCrit0);
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
        _setEnemyHP(Math.max(0, _getEnemyHP() - hit.damage));
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
    } else if (!isRandomEncounter && _getEnemyHP() <= 0) {
      if (pvpSt.isPVPBattle) {
        battleState = 'pvp-dissolve'; battleTimer = 0; playSFX(SFX.MONSTER_DEATH);
      } else { battleState = 'boss-dissolve'; battleTimer = 0; playSFX(SFX.BOSS_DEATH); }
    } else {
      processNextTurn();
    }
  }
  return true;
}
function _advancePVPTargetOrVictory() {
  if (pvpSt.pvpOpponentStats && pvpSt.pvpOpponentStats.hp > 0) {
    pvpSt.pvpPlayerTargetIdx = -1;
    processNextTurn();
    return;
  }
  const aliveAllyIdx = pvpSt.pvpEnemyAllies.findIndex(a => a.hp > 0);
  if (aliveAllyIdx >= 0) {
    pvpSt.pvpPlayerTargetIdx = aliveAllyIdx;
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
  saveSlotsToDB();
  enemyDefeated = true;
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
    tickHealNums(dt);
    if (battleTimer >= DEFEND_SPARKLE_TOTAL_MS) {
      clearHealNums();
      processNextTurn();
    }
  } else if (battleState === 'sw-throw' || battleState === 'sw-hit') {
    return updateMagicItemThrowHit(_magicItemShared());
  } else if (_updateItemMenuFades()) {
    return true;
  } else { return false; }
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

// Ally battle update logic extracted to battle-ally.js

// Enemy turn update logic extracted to battle-enemy.js

function _updateBossDissolve(dt) {
  if (battleState !== 'boss-dissolve') return false;
  const dFrame = Math.floor(battleTimer / BOSS_DISSOLVE_FRAME_MS);
  const dBlock = Math.floor(dFrame / BOSS_DISSOLVE_STEPS);
  const prevBlock = Math.floor(Math.floor((battleTimer - dt) / BOSS_DISSOLVE_FRAME_MS) / BOSS_DISSOLVE_STEPS);
  if (dBlock !== prevBlock && dBlock > 0 && (dBlock & 3) === 0) playSFX(SFX.BOSS_DEATH);
  if (battleTimer >= BOSS_BLOCKS * BOSS_DISSOLVE_STEPS * BOSS_DISSOLVE_FRAME_MS) {
    enemyDefeated = true; bossSprite = null;
    const _bossData = MONSTERS.get(0xCC);
    encounterExpGained = _bossData?.exp || 132; encounterGilGained = _bossData?.gil || 500;
    grantExp(encounterExpGained); ps.gil += encounterGilGained;
    const _bossLv = _bossData?.level || 8;
    encounterProfLevelUps = gainProficiency(inputSt.battleProfHits, _bossLv); inputSt.battleProfHits = {}; profLevelUpIdx = 0;
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
      battleState = isRandomEncounter ? 'encounter-box-close' : 'enemy-box-close'; battleTimer = 0;
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
  if (battleState === 'enemy-box-close') {
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
  if (battleState === 'team-wipe') {
    if (!_teamWipeMsgShown) { _teamWipeMsgShown = true; }
    if (battleTimer >= 1200 || _zPressed()) {
      battleState = 'defeat-close'; battleTimer = 0;
    }
    return true;
  }
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
      playerDeathTimer = null; _teamWipeMsgShown = false;
      ps.hp = ps.stats ? ps.stats.maxHP : 28;
      ps.mp = ps.stats ? ps.stats.maxMP : 0;
      const worldEntry = mapStack.slice().reverse().find(e => e.mapId === 'world');
      _triggerWipe(() => {
        dungeonFloor = -1; encounterSteps = 0; mapStack = [];
        if (worldEntry) {
          loadWorldMapAtPosition(worldEntry.x, worldEntry.y);
        } else {
          loadWorldMapAt(findWorldExitIndex(currentMapId, worldMapData));
        }
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
  updateBattleAlly(_allyShared()) ||
  updateBattleEnemyTurn(_enemyShared()) ||
  _updateBattleEndSequence(dt);
}

// Battle draw functions extracted to battle-drawing.js

function _updateHudHpLvStep(dt) {
  const target = (battleState === 'none' || battleState === 'flash-strobe' ||
    battleState === 'encounter-box-expand' || battleState === 'monster-slide-in' ||
    battleState === 'enemy-box-expand' || battleState === 'boss-appear') ? 0 : 4;
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
  updateRoster(dt, { battleState, transSt, wipeDuration: 44 * (1000 / 60), hudInfoFadeTimer, hudInfoFadeSteps: HUD_INFO_FADE_STEPS, hudInfoFadeStepMs: HUD_INFO_FADE_STEP_MS });
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
    fetch('/api/client-error', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ msg: e.message, stack: e.stack }) }).catch(() => {});
  }
  drawHUD();
  const _bds = _battleDrawShared();
  try {
    const _rds = {
      ctx, drawHudBox: _drawHudBox, drawBorderedBox: _drawBorderedBox,
      clipToViewport: _clipToViewport, cursorTileCanvas,
      fakePlayerPortraits, drawSparkle: _drawRosterSparkle,
      transSt, wipeDuration: 44 * (1000 / 60),
      hudInfoFadeTimer, hudInfoFadeSteps: HUD_INFO_FADE_STEPS, hudInfoFadeStepMs: HUD_INFO_FADE_STEP_MS,
      battleState, msgState,
    };
    if (battleAllies.length > 0 && battleState !== 'none') drawBattleAllies(_bds);
    else drawRoster(_rds);
    drawChat(ctx, _drawHudBox, rosterBattleFade);
    drawPauseMenu(ctx, _pauseShared());
    drawMsgBox(ctx, _clipToViewport, _drawBorderedBox);
    drawRosterMenu(_rds);
    drawBattle(_bds);
    drawSWExplosion(_bds);
    drawSWDamageNumbers(_bds);
  } catch (e) {
    console.error('[BATTLE DRAW ERROR]', e);
    fetch('/api/client-error', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ msg: e.message, stack: e.stack }) }).catch(() => {});
  }
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
    updateChat(dt, 'none', true);
    drawChat(ctx, _drawHudBox, 0, true);
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
