// Game Client — canvas rendering, input handling, game loop

import { parseROM } from './rom-parser.js';
import { NES_SYSTEM_PALETTE, decodeTiles } from './tile-decoder.js';
import { Sprite, DIR_DOWN, DIR_UP, DIR_LEFT, DIR_RIGHT } from './sprite.js';
// loadMap, MapRenderer → map-loading.js
import { loadWorldMap } from './world-map-loader.js';
import { WorldMapRenderer } from './world-map-renderer.js';
import { clearDungeonCache } from './dungeon-generator.js';
import { initMusic, playTrack, stopMusic, fadeOutMusic, playSFX, stopSFX, TRACKS, SFX,
         initFF1Music, playFF1Track, stopFF1Music, fadeOutFF1Music, clearMusicStash,
         getCurrentTrack, FF1_TRACKS, pauseMusic, resumeMusic } from './music.js';
import { applyIPS } from './ips-patcher.js';
import { initTextDecoder, getItemNameClean, getMonsterName } from './text-decoder.js';
import { initFont, drawText, measureText, TEXT_WHITE, TEXT_GREY, TEXT_YELLOW } from './font-renderer.js';
import { MONSTERS } from './data/monsters.js';
import { ITEMS, isHandEquippable, isWeapon, weaponSubtype, isBladedWeapon } from './data/items.js';
import { ENCOUNTERS } from './data/encounters.js';
import { CRIT_RATE, BASE_HIT_RATE, BOSS_HIT_RATE, GOBLIN_HIT_RATE,
         calcDamage, rollHits } from './battle-math.js';
import { PLAYER_POOL, PLAYER_PALETTES, ROSTER_FADE_STEPS, generateAllyStats } from './data/players.js';
import { BATTLE_MISS, BATTLE_GAME_OVER, BATTLE_ROAR, BATTLE_FIGHT, BATTLE_RUN,
         BATTLE_CANT_ESCAPE, BATTLE_RAN_AWAY, BATTLE_DEFEND, BATTLE_VICTORY,
         BATTLE_GOT_EXP, BATTLE_LEVEL_UP, BATTLE_BOSS_NAME, BATTLE_GOBLIN_NAME,
         BATTLE_CRITICAL, BATTLE_STRIKE_1ST, BATTLE_AMBUSHED, BATTLE_INEFFECTIVE, BATTLE_SLAIN,
         BATTLE_MENU_ITEMS, PAUSE_ITEMS,
         POND_RESTORED, VERSION } from './data/strings.js';
import { initMonsterSprites, getMonsterCanvas, getMonsterWhiteCanvas,
         getMonsterDeathFrames, hasMonsterSprites } from './monster-sprites.js';
import { loadBossSprite, getBossBattleCanvas, getBossWhiteCanvas } from './boss-sprites.js';
// serverDeleteSlot → title-screen.js
import { selectCursor, saveSlots,
         setSelectCursor, setSaveSlots,
         saveSlotsToDB, loadSlotsFromDB, setInventoryGetter, setPositionGetter } from './save-state.js';
import { _nameToBytes, _buildItemRowBytes, _makeGotNText, makeExpText, makeGilText, makeCpText, makeFoundItemText, makeJobLevelUpText } from './text-utils.js';
import { nesColorFade, _stepPalFade } from './palette.js';
import { _getPlane0, _rebuild, _shiftHorizWater, _isWater, _buildHorizMixed } from './tile-math.js';
// _dmgBounceY → hud-drawing.js
import { _calcBoxExpandSize, _encounterGridPos } from './battle-layout.js';
// _makeCanvas16, _makeCanvas16ctx, _hflipCanvas16, _makeWhiteCanvas → sprite-init.js
import { _updateWorldWater, _updateIndoorWater, resetWorldWaterCache, _buildHorizWaterPair } from './water-animation.js';
import { initSlashSprites, initKnifeSlashSprites, initSwordSlashSprites } from './slash-effects.js';
import { initSouthWindSprite } from './south-wind.js';
import { initFlameRawTiles, initStarTiles, rebuildFlameSprites,
         getFlameSprites, getFlameFrames, getStarTiles } from './flame-sprites.js';
// BATTLE_BG_MAP_LOOKUP, renderBattleBg → map-loading.js
import { LOAD_FADE_STEP_MS, LOAD_FADE_MAX, drawLoadingOverlay } from './loading-screen.js';
import { initTitleWater, initTitleSky, initTitleUnderwater, initUnderwaterSprites, initTitleOcean, initTitleLogo } from './title-animations.js';
// BATTLE_SPRITE_ROM, BATTLE_JOB_SIZE, BATTLE_PAL_ROM → sprite-init.js
import { ps, EQUIP_SLOT_SUBTYPE, getEquipSlotId, setEquipSlotId, recalcDEF, recalcCombatStats, getHitWeapon, isHitRightHand, initPlayerStats, initExpTable, grantExp, grantCP, fullHeal, getShieldEvade, getJobLevel, gainJobJP } from './player-stats.js';
import { chatState, addChatMessage, updateChat, updateChatTabs, drawChat, drawChatTabs, onChatKeyDown, consoleLog, setCommandContext,
         CHAT_TABS, activeTab, tabSelectMode, setActiveTab, setTabSelectMode } from './chat.js';
import { rosterBattleFade, setLocationGetter, getPlayerLocation, rosterLocForMapId,
         getRosterVisible, initRoster, updateRoster,
         drawRoster, drawRosterMenu } from './roster.js';
import { msgState, showMsgBox, updateMsgBox, drawMsgBox } from './message-box.js';
import { titleSt, isTitleActiveState, titleFadeLevel, titleFadePal, drawTitleOcean, drawTitleWater, drawTitleSky, drawTitleUnderwater, drawUnderwaterSprites, drawTitleSkyInHUD, drawTitle,
         updateTitleUnderwater, updateTitleSelect, onNameEntryKeyDown, updateShipDrift } from './title-screen.js';
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
import { initHudDrawing, drawHUD, clipToViewport, drawCursorFaded, drawHudBox,
         drawSparkleCorners, drawBorderedBox, drawHealNum, drawTopBoxBorder,
         roundTopBoxCorners, grayViewport, drawRosterSparkle, statRowBytes } from './hud-drawing.js';
import { initMapLoading, loadMapById, loadWorldMapAt, loadWorldMapAtPosition, setupTopBox } from './map-loading.js';
import { updateBattleAlly } from './battle-ally.js';
import { updateBattleEnemyTurn } from './battle-enemy.js';
import { buildTurnOrder as _buildTurnOrder, processNextTurn as _processNextTurn } from './battle-turn.js';
import { createStatusState, clearAll as clearAllStatus, tryInflictStatus, wakeOnHit } from './status-effects.js';
import { tickRandomEncounter as _tickRandomEncounter, startRandomEncounter as _startRandomEncounter } from './battle-encounter.js';
import { resetBattleItemVars, getTargets, getHitIdx, startMagicItem, updateMagicItemThrowHit } from './battle-items.js';
import { initBattleSprite as _initBattleSprite, initBattleSpriteForJob as _initBattleSpriteForJob,
         initFakePlayerPortraits as _initFakePlayerPortraits,
         initCursorTile as _initCursorTile, initScrollArrows as _initScrollArrows,
         initAdamantoise as _initAdamantoise,
         initGoblinSprite as _initGoblinSprite, initInvincibleSprite as _initInvincibleSprite,
         initMoogleSprite as _initMoogleSprite, initLoadingScreenFadeFrames as _initLoadingScreenFadeFrames,
         initStatusSprites as _initStatusSprites } from './sprite-init.js';
import { DMG_SHOW_MS, resetAllDmgNums, tickDmgNums, tickHealNums, clearHealNums, initMissSprite,
         getEnemyDmgNum, setEnemyDmgNum, getPlayerDamageNum, setPlayerDamageNum,
         getPlayerHealNum, setPlayerHealNum, getEnemyHealNum, setEnemyHealNum,
         getAllyDamageNums, getSwDmgNums } from './damage-numbers.js';
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

// Battle sprite poses — keyed map replaces 14+ individual canvas variables
let battlePoses = { idle: null, idleFade: [], rBack: null, lBack: null, rFwd: null, lFwd: null,
  knifeR: null, knifeL: null, knifeBack: null, victory: null, defend: null, defendFade: [],
  hit: null, kneel: null, kneelFade: [], silhouette: null };
// Effect sprites (not poses)
let sweatFrames = [];                  // 2 × 16×8 canvases (near-fatal dot animation)
let defendSparkleFrames = [];          // 4 × 8×8 canvases ($49-$4C)
let cureSparkleFrames = [];            // 2 × 16×16 canvases (config A/B from $4D/$4E)
let statusSpriteMap = new Map();        // Map<statusFlag, [frame0, frame1]> — all status animations
let poisonBubbleFrames = [];           // backward compat ref to poison frames

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
const TITLE_TRANSITION_MS = 800;
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
let encounterCpGained = 0;
let encounterJobLevelUp = null; // new job level on level-up, or null
let encounterDropItem = null;  // item id dropped on victory (or null)
let preBattleTrack = null;
let turnQueue = [];              // [{type:'player'|'enemy', index}] sorted by priority
let currentAttacker = -1;      // index of monster currently attacking
let dyingMonsterIndices = new Map(); // index → startDelayMs for staggered death wipe

// Battle message queue — renders in right panel strip (144, 160, 112, 16)
let battleMsgQueue = [];       // [{ bytes: Uint8Array, waitForZ: bool }]
let battleMsgCurrent = null;   // current message object or null
let battleMsgTimer = 0;        // ms into current message display
const MSG_FADE_IN_MS = 200;
const MSG_HOLD_MS = 800;
const MSG_FADE_OUT_MS = 200;
const MSG_TOTAL_MS = MSG_FADE_IN_MS + MSG_HOLD_MS + MSG_FADE_OUT_MS;

function queueBattleMsg(bytes, waitForZ = false) {
  battleMsgQueue.push({ bytes, waitForZ });
  if (!battleMsgCurrent) _advanceBattleMsg();
}
function _advanceBattleMsg() {
  if (battleMsgQueue.length > 0) {
    battleMsgCurrent = battleMsgQueue.shift();
    battleMsgTimer = 0;
  } else {
    battleMsgCurrent = null;
  }
}
function _updateBattleMsg(dt) {
  if (!battleMsgCurrent) return;
  battleMsgTimer += dt;
  if (battleMsgCurrent.persist) return;
  if (!battleMsgCurrent.waitForZ) {
    // Extend hold for long messages that need to scroll (8px per char, 112px strip)
    const textW = battleMsgCurrent.bytes.length * 8;
    const overflow = Math.max(0, textW - 112);
    const scrollTime = overflow > 0 ? 400 + overflow / 0.06 + 400 : 0; // pause + scroll + pause
    const totalMs = MSG_FADE_IN_MS + Math.max(MSG_HOLD_MS, scrollTime) + MSG_FADE_OUT_MS;
    if (battleMsgTimer >= totalMs) _advanceBattleMsg();
  }
}
function advanceBattleMsgZ() {
  // Called by input-handler on Z press during victory-msg state
  // Require minimum display time (fade-in + hold) before Z can advance
  if (battleMsgCurrent && battleMsgCurrent.waitForZ) {
    const textW = battleMsgCurrent.bytes.length * 8;
    const overflow = Math.max(0, textW - 112);
    const scrollTime = overflow > 0 ? 400 + overflow / 0.06 + 400 : 0;
    const minTime = MSG_FADE_IN_MS + Math.max(MSG_HOLD_MS, scrollTime);
    if (battleMsgTimer >= minTime) {
      _advanceBattleMsg();
      return true;
    }
  }
  return false;
}
function isBattleMsgBusy() {
  return battleMsgCurrent !== null;
}
function clearBattleMsgQueue() {
  battleMsgQueue = [];
  battleMsgCurrent = null;
  battleMsgTimer = 0;
}

function _queueVictoryRewards() {
  // Victory! persists in message strip throughout reward screens
  battleMsgCurrent = { bytes: BATTLE_VICTORY, waitForZ: false, persist: true };
  battleMsgTimer = 0;
}

// Hit animation state
let currentHitIdx = 0;             // which hit we're animating
let slashFrame = 0;                // current slash animation frame (0-3)
let slashX = 0, slashY = 0;       // slash effect base position (target center)
let slashOffX = 0, slashOffY = 0; // random offset per frame (punch scatter)
let slashFramesR = null;           // right-hand punch frames (frame $12, 4 effect sets)
let slashFramesL = null;           // left-hand punch frames (frame $13, 4 effect sets)
let slashFrames = null;            // alias — points to R or L based on current hit
let critFlashTimer = -1;           // >=0 while crit backdrop flash is active (1 frame = 16ms)
let poisonFlashTimer = -1;         // >=0 while overworld poison flash is active
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
const SLASH_FRAME_MS = 30;               // per frame of slash sprite (3 frames = 90ms)
const SLASH_FRAMES = 3;                  // number of slash animation frames (one per effect set)
const BACK_SWING_MS = 80;               // back-swing pose duration
const FWD_SWING_MS = 80;                // forward-swing pose duration
const HIT_PAUSE_MS = 100;               // pause showing damage number after final hit
const HIT_COMBO_PAUSE_MS = 30;          // pause between hits in a combo
const MISS_SHOW_MS = 300;               // "Miss" text display time
const PLAYER_DMG_SHOW_MS = 700;         // pause after final hit before enemy counter/death
// CRIT_RATE, BASE_HIT_RATE, BOSS_HIT_RATE, GOBLIN_HIT_RATE → battle-math.js

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
let scrollArrowDown = null;
let scrollArrowUp = null;
let scrollArrowDownFade = null;  // [step1..step4]
let scrollArrowUpFade = null;    // [step1..step4]
// PAUSE_ITEMS → data/strings.js

// getPlayerLocation, getRosterPlayers, getRosterVisible, roster state/update/draw ��� roster.js
// fakePlayer portrait vars stay here (shared by battle-drawing, battle-ally, pvp)
// All fakePlayer* vars are objects keyed by jobIdx: { 0: [...palIdx entries...], 1: [...] }
let fakePlayerPortraits = {};
let fakePlayerFullBodyCanvases = {};
let fakePlayerHitFullBodyCanvases = {};
let fakePlayerVictoryPortraits = {};
let fakePlayerHitPortraits = {};
let fakePlayerDefendPortraits = {};
let fakePlayerKneelPortraits = {};
let fakePlayerAttackPortraits = {};
let fakePlayerAttackLPortraits = {};
let fakePlayerKnifeBackPortraits = {};
let fakePlayerKnifeRPortraits = {};
let fakePlayerKnifeLPortraits = {};
let fakePlayerKnifeRFullBodyCanvases = {};
let fakePlayerKnifeLFullBodyCanvases = {};
let fakePlayerKnifeBackFullBodyCanvases = {};
let fakePlayerKnifeRFwdFullBodyCanvases = {};
let fakePlayerKnifeLFwdFullBodyCanvases = {};
let fakePlayerKneelFullBodyCanvases = {};
let fakePlayerVictoryFullBodyCanvases = {};
let fakePlayerDeathFrames = {};
let fakePlayerDeathPoseCanvases = {};

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
const SPRITE_PAL_BTM = [0x1A, 0x0F, 0x15, 0x30];    // spr_pal1: green, black, magenta, white
// Per-job walk sprite palettes: [topPal, bottomPal]
const JOB_WALK_PALS = {
  0: [SPRITE_PAL_TOP, SPRITE_PAL_BTM],   // Onion Knight: red top, green/magenta bottom
  1: [SPRITE_PAL_TOP, SPRITE_PAL_TOP],   // Warrior: all red
};

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
let _tabWasLoading = false; // tracks if we just came from a loading screen

// Screen shake state (earthquake effect for secret passages)
const SHAKE_DURATION = 34 * (1000 / 60);  // 2 × 17 NES frames ≈ 567ms
let shakeActive = false;
let shakeTimer = 0;
let shakePendingAction = null;

// _onChatKeyDown → chat.js (onChatKeyDown)
// _onNameEntryKeyDown → title-screen.js (onNameEntryKeyDown)
export function init() {
  setInventoryGetter(() => playerInventory);
  setPositionGetter(() => ({ worldX, worldY, onWorldMap, currentMapId }));
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

function _tileToCanvas(pixels, palette, transparentBg = false) {
  const c = document.createElement('canvas');
  c.width = 8; c.height = 8;
  const tctx = c.getContext('2d');
  const img = tctx.createImageData(8, 8);
  for (let i = 0; i < 64; i++) {
    const rgb = NES_SYSTEM_PALETTE[palette[pixels[i]]] || [0, 0, 0];
    img.data[i * 4] = rgb[0]; img.data[i * 4 + 1] = rgb[1];
    img.data[i * 4 + 2] = rgb[2]; img.data[i * 4 + 3] = (transparentBg && pixels[i] === 0) ? 0 : 255;
  }
  tctx.putImageData(img, 0, 0);
  return c;
}

function _drawBoxOnCtx(pctx, tileCanvases, x, y, w, h, fill = true) {
  const [TL, TOP, TR, LEFT, RIGHT, BL, BOT, BR] = tileCanvases;
  if (fill) { pctx.fillStyle = '#000'; pctx.fillRect(x + 8, y + 8, w - 16, h - 16); }
  pctx.drawImage(TL, x, y); pctx.drawImage(TR, x + w - 8, y);
  pctx.drawImage(BL, x, y + h - 8); pctx.drawImage(BR, x + w - 8, y + h - 8);
  for (let tx = x + 8; tx < x + w - 8; tx += 8) { pctx.drawImage(TOP, tx, y); pctx.drawImage(BOT, tx, y + h - 8); }
  for (let ty = y + 8; ty < y + h - 8; ty += 8) { pctx.drawImage(LEFT, x, ty); pctx.drawImage(RIGHT, x + w - 8, ty); }
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
  borderBlueTileCanvases = tiles.map(p => _tileToCanvas(p, [0x02, 0x00, 0x02, 0x30], true));
  borderFadeSets = [];
  for (let step = 0; step <= LOAD_FADE_MAX; step++) {
    const fadedPal = MENU_PALETTE.map(c => { let fc = c; for (let s = 0; s < step; s++) fc = nesColorFade(fc); return fc; });
    borderFadeSets.push(tiles.map(p => _tileToCanvas(p, fadedPal)));
  }
  // Title screen gets transparent-background border tiles (no black outer edge)
  titleSt.borderTiles = tiles.map(p => _tileToCanvas(p, MENU_PALETTE, true));
  const titleFadeSets = [];
  for (let step = 0; step <= LOAD_FADE_MAX; step++) {
    const fadedPal = MENU_PALETTE.map(c => { let fc = c; for (let s = 0; s < step; s++) fc = nesColorFade(fc); return fc; });
    titleFadeSets.push(tiles.map(p => _tileToCanvas(p, fadedPal, true)));
  }
  titleSt.borderFadeSets = titleFadeSets;
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
// _drawHudWithFade, _grayViewport → hud-drawing.js
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
  inputSt.battleActionCount = 0;
  clearBattleMsgQueue();
}
function _zPressed() { if (!keys['z'] && !keys['Z']) return false; keys['z'] = false; keys['Z'] = false; return true; }
function _xPressed() { if (!keys['x'] && !keys['X']) return false; keys['x'] = false; keys['X'] = false; return true; }

function _swapBattleSprites(jobIdx) {
  const bs = _initBattleSpriteForJob(romRaw, jobIdx);
  battlePoses = bs.poses;
  defendSparkleFrames = bs.defendSparkleFrames;
  cureSparkleFrames = bs.cureSparkleFrames;
  sweatFrames = bs.sweatFrames;
  // Re-init hud drawing shared context so it picks up new canvases
  initHudDrawing(_hudDrawShared());
  // Swap walk sprite to match job
  if (sprite) {
    sprite.setGfxID(jobIdx);
    const pals = JOB_WALK_PALS[jobIdx] || JOB_WALK_PALS[0];
    sprite.setPalette(pals[0], pals[1]);
  }
}

// _landOnWorldMap → map-loading.js

function returnToTitle() {
  saveSlotsToDB();
  pauseSt.state = 'none';
  fadeOutFF1Music((HUD_INFO_FADE_STEPS + 1) * HUD_INFO_FADE_STEP_MS);
  clearMusicStash();
  transSt.state = 'hud-fade-out';
  transSt.timer = 0;
  transSt.pendingAction = () => { battleState = 'none'; hudInfoFadeTimer = HUD_INFO_FADE_STEPS * HUD_INFO_FADE_STEP_MS; _startTitleScreen(); };
}
// setupTopBox → map-loading.js

function _hudDrawShared() {
  return {
    get ctx() { return ctx; },
    get cursorTileCanvas() { return cursorTileCanvas; },
    get cursorFadeCanvases() { return cursorFadeCanvases; },
    get borderTileCanvases() { return borderTileCanvases; },
    get borderFadeSets() { return borderFadeSets; },
    get borderBlueTileCanvases() { return borderBlueTileCanvases; },
    get cornerMasks() { return cornerMasks; },
    get hudCanvas() { return hudCanvas; },
    get hudFadeCanvases() { return hudFadeCanvases; },
    get titleHudCanvas() { return titleHudCanvas; },
    get titleHudFadeCanvases() { return titleHudFadeCanvases; },
    get battlePoses() { return battlePoses; },
    get sweatFrames() { return sweatFrames; },
    get poisonBubbleFrames() { return poisonBubbleFrames; },
    get statusSpriteMap() { return statusSpriteMap; },
    get cureSparkleFrames() { return cureSparkleFrames; },
    get battleState() { return battleState; },
    get battleShakeTimer() { return battleShakeTimer; },
    get topBoxBgCanvas() { return topBoxBgCanvas; },
    get topBoxBgFadeFrames() { return topBoxBgFadeFrames; },
    get topBoxMode() { return topBoxMode; },
    get hudInfoFadeTimer() { return hudInfoFadeTimer; },
    get hudHpLvStep() { return hudHpLvStep; },
    get playerDeathTimer() { return playerDeathTimer; },
    get titleState() { return titleSt.state; },
    get titleTimer() { return titleSt.timer; },
    TITLE_FADE_STEP_MS,
    TITLE_FADE_MAX,
    loadingShared: () => _loadingShared(),
  };
}

function _mapLoadShared() {
  return {
    get romRaw() { return romRaw; },
    get sprite() { return sprite; },
    get mapData() { return mapData; },
    set mapData(v) { mapData = v; },
    get mapRenderer() { return mapRenderer; },
    set mapRenderer(v) { mapRenderer = v; },
    get worldX() { return worldX; },
    set worldX(v) { worldX = v; },
    get worldY() { return worldY; },
    set worldY(v) { worldY = v; },
    get currentMapId() { return currentMapId; },
    set currentMapId(v) { currentMapId = v; },
    get onWorldMap() { return onWorldMap; },
    set onWorldMap(v) { onWorldMap = v; },
    get dungeonFloor() { return dungeonFloor; },
    set dungeonFloor(v) { dungeonFloor = v; },
    get dungeonSeed() { return dungeonSeed; },
    get dungeonDestinations() { return dungeonDestinations; },
    set dungeonDestinations(v) { dungeonDestinations = v; },
    get secretWalls() { return secretWalls; },
    set secretWalls(v) { secretWalls = v; },
    get falseWalls() { return falseWalls; },
    set falseWalls(v) { falseWalls = v; },
    get hiddenTraps() { return hiddenTraps; },
    set hiddenTraps(v) { hiddenTraps = v; },
    get rockSwitch() { return rockSwitch; },
    set rockSwitch(v) { rockSwitch = v; },
    get warpTile() { return warpTile; },
    set warpTile(v) { warpTile = v; },
    get pondTiles() { return pondTiles; },
    set pondTiles(v) { pondTiles = v; },
    get bossSprite() { return bossSprite; },
    set bossSprite(v) { bossSprite = v; },
    get disabledTrigger() { return disabledTrigger; },
    set disabledTrigger(v) { disabledTrigger = v; },
    get moving() { return moving; },
    set moving(v) { moving = v; },
    get encounterSteps() { return encounterSteps; },
    set encounterSteps(v) { encounterSteps = v; },
    get enemyDefeated() { return enemyDefeated; },
    set enemyDefeated(v) { enemyDefeated = v; },
    get openDoor() { return openDoor; },
    set openDoor(v) { openDoor = v; },
    get adamantoiseFrames() { return adamantoiseFrames; },
    get worldMapData() { return worldMapData; },
    get topBoxBgCanvas() { return topBoxBgCanvas; },
    set topBoxBgCanvas(v) { topBoxBgCanvas = v; },
    get topBoxBgFadeFrames() { return topBoxBgFadeFrames; },
    set topBoxBgFadeFrames(v) { topBoxBgFadeFrames = v; },
    get loadingBgFadeFrames() { return loadingBgFadeFrames; },
    set loadingBgFadeFrames(v) { loadingBgFadeFrames = v; },
    get topBoxMode() { return topBoxMode; },
    set topBoxMode(v) { topBoxMode = v; },
    get topBoxSt() { return topBoxSt; },
    applyPassage: (tilemap) => applyPassage(tilemap),
    rebuildFlameSprites: _rebuildFlameSprites,
  };
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
    get encounterJobLevelUp() { return encounterJobLevelUp; },
    advanceBattleMsgZ,
    queueBattleMsg,
    get playerName() { return saveSlots[selectCursor]?.name || null; },
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
    toggleCrt() { document.getElementById('canvas-wrapper').classList.toggle('crt'); },
    swapBattleSprites: _swapBattleSprites,
  };
}

function _pauseShared() {
  return {
    playerInventory,
    cursorTileCanvas,
    rosterScroll: inputSt.rosterScroll,
    _drawBorderedBox: drawBorderedBox,
    _clipToViewport: clipToViewport,
    _drawCursorFaded: drawCursorFaded,
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
    queueBattleMsg,
    isBattleMsgBusy,
    isTeamWiped:         _isTeamWiped,
    getPlayerLocation,
    getSlashFramesForWeapon,
    clipToViewport,
    drawBorderedBox,
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
    queueBattleMsg,
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
    queueBattleMsg,
    isBattleMsgBusy,
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
    get encounterCpGained() { return encounterCpGained; },
    get encounterDropItem() { return encounterDropItem; },
    get encounterJobLevelUp() { return encounterJobLevelUp; },
    get battleMsgCurrent() { return battleMsgCurrent; },
    get battleMsgTimer() { return battleMsgTimer; },
    MSG_FADE_IN_MS, MSG_HOLD_MS, MSG_FADE_OUT_MS, MSG_TOTAL_MS,
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
    get battlePoses() { return battlePoses; },
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
    get poisonBubbleFrames() { return poisonBubbleFrames; },
    get statusSpriteMap() { return statusSpriteMap; },
    get cursorTileCanvas() { return cursorTileCanvas; },
    get cursorFadeCanvases() { return cursorFadeCanvases; },
    get topBoxBgCanvas() { return topBoxBgCanvas; },
    get topBoxBgFadeFrames() { return topBoxBgFadeFrames; },
    topBoxSt,
    clipToViewport,
    grayViewport,
    drawBorderedBox,
    drawSparkleCorners,
    drawCursorFaded,
    drawHudBox,
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
    battleSpriteCanvas: battlePoses.idle,
    battleSpriteFadeCanvases: battlePoses.idleFade,
    silhouetteCanvas: battlePoses.silhouette,
    fakePlayerPortraits,
    drawBorderedBox,
    drawHudBox,
    drawCursorFaded,
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

  // Scroll arrows (sprite-init.js)
  const sa = _initScrollArrows(romRaw);
  scrollArrowDown = sa.scrollArrowDown;
  scrollArrowUp = sa.scrollArrowUp;
  scrollArrowDownFade = sa.scrollArrowDownFade;
  scrollArrowUpFade = sa.scrollArrowUpFade;

  // Battle sprite (sprite-init.js)
  const bs = _initBattleSpriteForJob(romRaw, ps.jobIdx);
  battlePoses = bs.poses;
  defendSparkleFrames = bs.defendSparkleFrames;
  cureSparkleFrames = bs.cureSparkleFrames;
  sweatFrames = bs.sweatFrames;
  statusSpriteMap = _initStatusSprites();
  poisonBubbleFrames = statusSpriteMap.get(0x02) || [];

  // Fake player portraits & full bodies (sprite-init.js) — keyed by jobIdx
  const fp = _initFakePlayerPortraits(romRaw, [0, 1]);
  const _fpMap = (key) => { const m = {}; for (const j of [0, 1]) m[j] = fp[j][key]; return m; };
  fakePlayerPortraits = _fpMap('fakePlayerPortraits');
  fakePlayerVictoryPortraits = _fpMap('fakePlayerVictoryPortraits');
  fakePlayerHitPortraits = _fpMap('fakePlayerHitPortraits');
  fakePlayerDefendPortraits = _fpMap('fakePlayerDefendPortraits');
  fakePlayerAttackPortraits = _fpMap('fakePlayerAttackPortraits');
  fakePlayerAttackLPortraits = _fpMap('fakePlayerAttackLPortraits');
  fakePlayerKnifeBackPortraits = _fpMap('fakePlayerKnifeBackPortraits');
  fakePlayerKnifeRPortraits = _fpMap('fakePlayerKnifeRPortraits');
  fakePlayerKnifeLPortraits = _fpMap('fakePlayerKnifeLPortraits');
  fakePlayerKneelPortraits = _fpMap('fakePlayerKneelPortraits');
  fakePlayerFullBodyCanvases = _fpMap('fakePlayerFullBodyCanvases');
  fakePlayerKnifeRFullBodyCanvases = _fpMap('fakePlayerKnifeRFullBodyCanvases');
  fakePlayerKnifeLFullBodyCanvases = _fpMap('fakePlayerKnifeLFullBodyCanvases');
  fakePlayerKnifeBackFullBodyCanvases = _fpMap('fakePlayerKnifeBackFullBodyCanvases');
  fakePlayerKnifeLFwdFullBodyCanvases = _fpMap('fakePlayerKnifeLFwdFullBodyCanvases');
  fakePlayerKnifeRFwdFullBodyCanvases = _fpMap('fakePlayerKnifeRFwdFullBodyCanvases');
  fakePlayerKneelFullBodyCanvases = _fpMap('fakePlayerKneelFullBodyCanvases');
  fakePlayerVictoryFullBodyCanvases = _fpMap('fakePlayerVictoryFullBodyCanvases');
  fakePlayerHitFullBodyCanvases = _fpMap('fakePlayerHitFullBodyCanvases');
  fakePlayerDeathPoseCanvases = _fpMap('fakePlayerDeathPoseCanvases');
  fakePlayerDeathFrames = _fpMap('fakePlayerDeathFrames');

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
  _initSpriteAssets(romRaw);
  sprite = new Sprite(romRaw, SPRITE_PAL_TOP, SPRITE_PAL_BTM);
  worldMapData = loadWorldMap(romRaw, 0);
  worldMapRenderer = new WorldMapRenderer(worldMapData);
  resetWorldWaterCache();
  _initTitleAssets(romRaw);
  initHudDrawing(_hudDrawShared());
  initMapLoading(_mapLoadShared());

  await loadSlotsFromDB();

  if (window.DEBUG_BOSS) { _startDebugMode(); return; }
  _startTitleScreen();

  // Wire console command context
  setCommandContext({
    getRosterNames: () => PLAYER_POOL.filter(p => p.loc === getPlayerLocation()).map(p => p.name),
  });

  // Startup console log — staggered one at a time
  const email = localStorage.getItem('ff3_email');
  const startupMsgs = [
    'FF3 MMO v' + VERSION,
    'ROM: ' + rom.prgBanks + ' PRG, ' + rom.chrBanks + ' CHR, mapper ' + rom.mapper,
    'Auth: ' + (email || 'guest'),
    'Type /help for commands',
  ];
  startupMsgs.forEach((msg, i) => setTimeout(() => consoleLog(msg), i * 500));
}

export function loadFF12ROM(arrayBuffer) {
  ff12Raw = new Uint8Array(arrayBuffer);
  const ad = _initAdamantoise(ff12Raw);
  adamantoiseFrames = ad.adamantoiseFrames;
  initFF1Music(ff12Raw);
  if (romRaw) { // rebuild loading screen fade frames with boss fade
    const lf2 = _initLoadingScreenFadeFrames(romRaw, ff12Raw);
    moogleFadeFrames = lf2.moogleFadeFrames;
    bossFadeFrames = lf2.bossFadeFrames;
  }
}

// _calcSpawnY, _openReturnDoor, _loadDungeonFloor, _loadRegularMap,
// loadMapById, loadWorldMapAt, loadWorldMapAtPosition → map-loading.js

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
  if (tabSelectMode) return;

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

// _tickRandomEncounter → battle-encounter.js

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

  // NES poison step damage: -1 HP per step, min 1, SFX + flash
  if (ps.status && ps.status.mask & 0x02 && ps.hp > 1) {
    ps.hp -= 1;
    playSFX(SFX.ATTACK_HIT);
    poisonFlashTimer = 0;
  }

  if (_checkFalseWall()) return;
  if (_checkWarpTile()) return;

  // Check for trigger at current tile
  if (checkTrigger(_triggerShared())) return;

  if (_tickRandomEncounter(_encounterShared())) return;

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

  clipToViewport();
  try {
    _renderMapAndWater(camX, camY, SCREEN_CENTER_X, SCREEN_CENTER_Y + 3, SCREEN_CENTER_Y);
    _renderStarSpiral();
  } finally {
    ctx.restore();
  }
}

// statRowBytes → hud-drawing.js

// _drawTopBoxBattleBG, _drawTopBoxOverlay, _drawHUDTopBox, _drawPortraitImage,
// _drawCureSparkle, _drawHealNum, _drawPauseHealNum, _drawHUDPortrait,
// _drawHUDInfoPanel, drawHUD, _drawSparkleCorners, _drawCursorFaded,
// clipToViewport, drawHudBox, drawRosterSparkle → hud-drawing.js

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
    if (slot.hp != null) { ps.hp = Math.min(slot.hp, ps.stats.maxHP); ps.mp = ps.stats.maxMP; }
    else fullHeal();
    ps.weaponR = slot.stats.weaponR != null ? slot.stats.weaponR : 0x1E;
    ps.weaponL = slot.stats.weaponL != null ? slot.stats.weaponL : 0x00;
    ps.head = slot.stats.head || 0x00;
    ps.body = slot.stats.body || 0x00;
    ps.arms = slot.stats.arms || 0x00;
    recalcCombatStats();
  }
  playerInventory = (slot && slot.inventory) ? { ...slot.inventory } : {};
  ps.gil = (slot && slot.gil) || 0;
  ps.jobLevels = (slot && slot.jobLevels) ? JSON.parse(JSON.stringify(slot.jobLevels)) : {};
  ps.jobIdx = (slot && slot.jobIdx) || 0;
  ps.unlockedJobs = (slot && slot.unlockedJobs != null) ? slot.unlockedJobs : 0x01;
  ps.cp = (slot && slot.cp) || 0;
  ps.status.mask = (slot && slot.statusMask) || 0;
  ps.playTime = (slot && slot.playTime) || 0;
  // Swap battle sprites to match saved job
  _swapBattleSprites(ps.jobIdx);
  // Always spawn in Ur
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
    const _s = titleSt.state;
    if (_s === 'select-fade-in' || _s === 'select' || _s === 'name-entry' || _s === 'select-fade-out-back') updateShipDrift(dt);
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
    case 'main-in':        if (titleSt.timer >= TITLE_FADE_MS) { titleSt.state = 'logo-content-in';  titleSt.timer = 0; } break;
    case 'logo-content-in': if (titleSt.timer >= TITLE_FADE_MS) { titleSt.state = 'pressz-fade-in';    titleSt.timer = 0; } break;
    case 'pressz-fade-in': if (titleSt.timer >= TITLE_FADE_MS) { titleSt.state = 'main';          titleSt.timer = 0; } break;
    case 'main':
      if (keys['z'] || keys['Z']) { keys['z'] = false; keys['Z'] = false; playSFX(SFX.CONFIRM); titleSt.state = 'logo-content-out'; titleSt.timer = 0; }
      break;
    case 'logo-content-out': if (titleSt.timer >= TITLE_FADE_MS) { titleSt.state = 'to-select'; titleSt.timer = 0; } break;
    case 'to-select':            if (titleSt.timer >= TITLE_TRANSITION_MS) { titleSt.state = 'select-fade-in'; titleSt.timer = 0; titleSt.shipPosX = 0; setSelectCursor(0); titleSt.deleteMode = false; } break;
    case 'select-fade-in':       if (titleSt.timer >= (SELECT_TEXT_STEPS + 1) * SELECT_TEXT_STEP_MS) { titleSt.state = 'select'; titleSt.timer = 0; } break;
    case 'select':               updateTitleSelect(keys); break;
    case 'name-entry':           break;
    case 'select-fade-out':      if (titleSt.timer >= (SELECT_TEXT_STEPS + 1) * SELECT_TEXT_STEP_MS) { titleSt.state = 'main-out'; titleSt.timer = 0; fadeOutMusic(TITLE_FADE_MS); } break;
    case 'select-fade-out-back': if (titleSt.timer >= (SELECT_TEXT_STEPS + 1) * SELECT_TEXT_STEP_MS) { titleSt.state = 'to-main'; titleSt.timer = 0; } break;
    case 'to-main':              if (titleSt.timer >= TITLE_TRANSITION_MS) { titleSt.state = 'logo-content-in-back'; titleSt.timer = 0; } break;
    case 'logo-content-in-back': if (titleSt.timer >= TITLE_FADE_MS) { titleSt.state = 'main'; titleSt.timer = 0; } break;
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

// drawBorderedBox, drawTopBoxBorder, roundTopBoxCorners → hud-drawing.js

// _drawPauseBox, _drawPauseMenuText, _drawPauseInventory, _drawPauseEquipSlots, _drawPauseEquipItems, _drawPauseStats, drawPauseMenu → pause-menu.js

// --- Slash Sprites (procedural) ---


// --- Battle System ---

// calcDamage, rollHits → battle-math.js
// buildTurnOrder, processNextTurn → battle-turn.js
// startRandomEncounter, tickRandomEncounter → battle-encounter.js

function _turnShared() {
  return {
    get battleState()           { return battleState; },
    set battleState(v)          { battleState = v; },
    get battleTimer()           { return battleTimer; },
    set battleTimer(v)          { battleTimer = v; },
    get battleAllies()          { return battleAllies; },
    get isRandomEncounter()     { return isRandomEncounter; },
    set isRandomEncounter(v)    { isRandomEncounter = v; },
    get encounterMonsters()     { return encounterMonsters; },
    set encounterMonsters(v)    { encounterMonsters = v; },
    get turnQueue()             { return turnQueue; },
    set turnQueue(v)            { turnQueue = v; },
    get turnTimer()             { return turnTimer; },
    set turnTimer(v)            { turnTimer = v; },
    get isDefending()           { return isDefending; },
    set isDefending(v)          { isDefending = v; },
    get currentAttacker()       { return currentAttacker; },
    set currentAttacker(v)      { currentAttacker = v; },
    get currentAllyAttacker()   { return currentAllyAttacker; },
    set currentAllyAttacker(v)  { currentAllyAttacker = v; },
    get allyTargetIndex()       { return allyTargetIndex; },
    set allyTargetIndex(v)      { allyTargetIndex = v; },
    get allyHitResults()        { return allyHitResults; },
    set allyHitResults(v)       { allyHitResults = v; },
    get allyHitIdx()            { return allyHitIdx; },
    set allyHitIdx(v)           { allyHitIdx = v; },
    get allyHitResult()         { return allyHitResult; },
    set allyHitResult(v)        { allyHitResult = v; },
    get allyHitIsLeft()         { return allyHitIsLeft; },
    set allyHitIsLeft(v)        { allyHitIsLeft = v; },
    get currentHitIdx()         { return currentHitIdx; },
    set currentHitIdx(v)        { currentHitIdx = v; },
    get slashFrame()            { return slashFrame; },
    set slashFrame(v)           { slashFrame = v; },
    get slashFrames()           { return slashFrames; },
    set slashFrames(v)          { slashFrames = v; },
    get slashOffX()             { return slashOffX; },
    set slashOffX(v)            { slashOffX = v; },
    get slashOffY()             { return slashOffY; },
    set slashOffY(v)            { slashOffY = v; },
    get slashX()                { return slashX; },
    set slashX(v)               { slashX = v; },
    get slashY()                { return slashY; },
    set slashY(v)               { slashY = v; },
    get itemHealAmount()        { return itemHealAmount; },
    set itemHealAmount(v)       { itemHealAmount = v; },
    get inputSt()               { return inputSt; },
    get pvpSt()                 { return pvpSt; },
    get battleShakeTimer()      { return battleShakeTimer; },
    set battleShakeTimer(v)     { battleShakeTimer = v; },
    BOSS_DEF,
    BOSS_MAX_HP,
    BATTLE_SHAKE_MS,
    ITEMS,
    setPlayerDamageNum,
    setPlayerHealNum,
    setEnemyDmgNum,
    setEnemyHealNum,
    getAllyDamageNums,
    getEnemyHP: _getEnemyHP,
    setEnemyHP: _setEnemyHP,
    removeItem,
    startMagicItem: () => startMagicItem(_magicItemShared()),
    queueBattleMsg,
    isBattleMsgBusy,
    get playerName() { return saveSlots[selectCursor]?.name || null; },
    get sprite() { return sprite; },
  };
}

function buildTurnOrder() { return _buildTurnOrder(_turnShared()); }
function processNextTurn() { _processNextTurn(_turnShared()); }


function startBattle() {
  battleState = 'roar-hold';
  battleTimer = 0;
  showMsgBox(BATTLE_ROAR, () => { battleState = 'flash-strobe'; battleTimer = 0; playSFX(SFX.BATTLE_SWIPE); });
  _resetBattleVars();
  enemyHP = BOSS_MAX_HP;
  playSFX(SFX.EARTHQUAKE);
}

// startRandomEncounter → battle-encounter.js
function _encounterShared() {
  return {
    get battleState()           { return battleState; },
    set battleState(v)          { battleState = v; },
    get battleTimer()           { return battleTimer; },
    set battleTimer(v)          { battleTimer = v; },
    get isRandomEncounter()     { return isRandomEncounter; },
    set isRandomEncounter(v)    { isRandomEncounter = v; },
    get encounterMonsters()     { return encounterMonsters; },
    set encounterMonsters(v)    { encounterMonsters = v; },
    get encounterSteps()        { return encounterSteps; },
    set encounterSteps(v)       { encounterSteps = v; },
    get preBattleTrack()        { return preBattleTrack; },
    set preBattleTrack(v)       { preBattleTrack = v; },
    get onWorldMap()            { return onWorldMap; },
    get worldMapRenderer()      { return worldMapRenderer; },
    get worldX()                { return worldX; },
    get worldY()                { return worldY; },
    get dungeonFloor()          { return dungeonFloor; },
    get inputSt()               { return inputSt; },
    TILE_SIZE,
    getMonsterCanvas: (id) => getMonsterCanvas(id, goblinBattleCanvas),
    resetBattleVars: _resetBattleVars,
  };
}
function startRandomEncounter() { _startRandomEncounter(_encounterShared()); }

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
  return battleState === 'victory-celebrate' ||
    battleState === 'exp-text-in' || battleState === 'exp-hold' || battleState === 'exp-fade-out' ||
    battleState === 'gil-text-in' || battleState === 'gil-hold' || battleState === 'gil-fade-out' ||
    battleState === 'cp-text-in' || battleState === 'cp-hold' || battleState === 'cp-fade-out' ||
    battleState === 'item-text-in' || battleState === 'item-hold' || battleState === 'item-fade-out' ||
    battleState === 'levelup-text-in' || battleState === 'levelup-hold' || battleState === 'levelup-fade-out' ||
    battleState === 'joblv-text-in' || battleState === 'joblv-hold' || battleState === 'joblv-fade-out' ||
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
  let totalDmg = 0, anyCrit = false, allMiss = true, hitsLanded = 0;
  for (const h of inputSt.hitResults) {
    if (!h.miss) { totalDmg += h.damage; allMiss = false; hitsLanded++; if (h.crit) anyCrit = true; }
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
    const handWeapon = getHitWeapon(currentHitIdx, inputSt.rHandHitCount);
    slashFrames = getSlashFramesForWeapon(handWeapon, isHitRightHand(currentHitIdx, inputSt.rHandHitCount));
    if (isBladedWeapon(handWeapon)) { slashOffX = 8; slashOffY = -8; }
    else { slashOffX = Math.floor(Math.random() * 40) - 20; slashOffY = Math.floor(Math.random() * 40) - 20; }
    battleState = 'attack-back';
    battleTimer = 0;
  } else {
    _finalizeComboHits();
  }
}
function _updatePlayerAttackBack() {
  if (battleState !== 'attack-back') return false;
  const delay = currentHitIdx === 0 ? BACK_SWING_MS : HIT_COMBO_PAUSE_MS;
  if (battleTimer >= delay) {
    battleState = 'attack-fwd';
    battleTimer = 0;
  }
  return true;
}
function _updatePlayerAttackFwd() {
  if (battleState !== 'attack-fwd') return false;
  if (battleTimer >= FWD_SWING_MS) {
    const hw0 = getHitWeapon(currentHitIdx, inputSt.rHandHitCount);
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
    const handWeapon = getHitWeapon(currentHitIdx, inputSt.rHandHitCount);
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
        const targetMon = encounterMonsters[inputSt.targetIndex];
        targetMon.hp = Math.max(0, targetMon.hp - hit.damage);
        // Physical hit wakes sleeping targets
        if (targetMon.status) wakeOnHit(targetMon.status);
        // Weapon on-hit status infliction
        if (targetMon.status && targetMon.hp > 0) {
          const wpnId = getHitWeapon(currentHitIdx, inputSt.rHandHitCount);
          const wpnData = ITEMS.get(wpnId);
          if (wpnData && wpnData.status) {
            const arr = Array.isArray(wpnData.status) ? wpnData.status : [wpnData.status];
            for (const s of arr) tryInflictStatus(targetMon.status, s, wpnData.hit || 50);
          }
        }
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
  const hitPause = (currentHitIdx + 1 < inputSt.hitResults.length) ? HIT_COMBO_PAUSE_MS : HIT_PAUSE_MS;
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
      if (battleMsgCurrent) { battleState = 'msg-wait'; battleTimer = 0; }
      else processNextTurn();
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
  encounterGilGained = Math.max(1, Math.floor(10 * oppLv / 4));
  grantExp(encounterExpGained);
  encounterCpGained = Math.max(1, Math.floor(oppLv / 4)); grantCP(encounterCpGained);
  ps.gil += encounterGilGained;
  encounterJobLevelUp = gainJobJP(inputSt.battleActionCount || 1);
  inputSt.battleActionCount = 0;
  saveSlotsToDB();
  _queueVictoryRewards();
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
      encounterGilGained = Math.max(1, Math.floor(encounterMonsters.reduce((sum, m) => sum + (m.gil || 0), 0) / 4));
      grantExp(encounterExpGained);
      encounterCpGained = Math.max(1, Math.floor(encounterMonsters.reduce((sum, m) => sum + (m.cp || 1), 0) / 4)); grantCP(encounterCpGained);
      ps.gil += encounterGilGained;
      encounterJobLevelUp = gainJobJP(inputSt.battleActionCount || 1);
      inputSt.battleActionCount = 0;
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
      _queueVictoryRewards();
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
  return _updatePlayerAttackBack() ||
         _updatePlayerAttackFwd() ||
         _updatePlayerSlash() ||
         _updatePlayerHitShow() ||
         _updatePlayerMissShow() ||
         _updatePlayerDamageShow() ||
         _updateMonsterDeath();
}


function _updateBattleDefendItem(dt) {
  if (battleState === 'defend-anim') {
    // Defend pose + sparkle for 32 frames (~533ms), then wait for msg, then enemy turn
    if (battleTimer >= DEFEND_SPARKLE_TOTAL_MS) {
      if (battleMsgCurrent) { battleState = 'msg-wait'; battleTimer = 0; }
      else processNextTurn();
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
  if (battleState === 'run-success') {
    // Queue message, then wait for it to finish auto-advancing
    if (!battleMsgCurrent && battleMsgQueue.length === 0) {
      runSlideBack = true; battleState = 'encounter-box-close'; battleTimer = 0;
    }
  } else { return false; }
  return true;
}

function _updateBattleRunFail() {
  if (battleState === 'run-fail') {
    if (!battleMsgCurrent && battleMsgQueue.length === 0) {
      processNextTurn();
    }
  } else { return false; }
  return true;
}

function _updateBattleRun() {
  if (battleState === 'run-fail') return _updateBattleRunFail();
  if (battleState === 'run-success') return _updateBattleRunSuccess();
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
    ps.unlockedJobs |= 0x3E; // Wind Crystal: bits 1-5 (Warrior, Monk, White Mage, Black Mage, Red Mage)
    const _bossData = MONSTERS.get(0xCC);
    encounterExpGained = _bossData?.exp || 132; encounterGilGained = Math.max(1, Math.floor((_bossData?.gil || 500) / 4));
    grantExp(encounterExpGained); ps.gil += encounterGilGained;
    encounterCpGained = Math.max(1, Math.floor((_bossData?.cp || 10) / 4)); grantCP(encounterCpGained);
    encounterJobLevelUp = gainJobJP(inputSt.battleActionCount || 1);
    inputSt.battleActionCount = 0;
    saveSlotsToDB();
    _queueVictoryRewards();
    isDefending = false; battleState = 'victory-name-out'; battleTimer = 0;
  }
  return true;
}

function _updateVictorySequence() {
  const _textMs = (BATTLE_TEXT_STEPS + 1) * BATTLE_TEXT_STEP_MS;
  if (battleState === 'victory-name-out') {
    if (battleTimer >= _textMs) { battleState = 'victory-celebrate'; battleTimer = 0; playTrack(TRACKS.VICTORY); }
  } else if (battleState === 'victory-celebrate') {
    if (battleTimer >= 400) { battleState = 'exp-text-in'; battleTimer = 0; }
  } else if (battleState === 'exp-text-in') {
    if (battleTimer >= _textMs) { battleState = 'exp-hold'; battleTimer = 0; }
  } else if (battleState === 'exp-hold') {
  } else if (battleState === 'exp-fade-out') {
    if (battleTimer >= _textMs) { battleState = 'gil-text-in'; battleTimer = 0; }
  } else if (battleState === 'gil-text-in') {
    if (battleTimer >= _textMs) { battleState = 'gil-hold'; battleTimer = 0; }
  } else if (battleState === 'gil-hold') {
  } else if (battleState === 'gil-fade-out') {
    if (battleTimer >= _textMs) { battleState = 'cp-text-in'; battleTimer = 0; }
  } else if (battleState === 'cp-text-in') {
    if (battleTimer >= _textMs) { battleState = 'cp-hold'; battleTimer = 0; }
  } else if (battleState === 'cp-hold') {
  } else if (battleState === 'cp-fade-out') {
    if (battleTimer >= _textMs) { battleState = encounterDropItem !== null ? 'item-text-in' : ps.leveledUp ? 'levelup-text-in' : encounterJobLevelUp ? 'joblv-text-in' : 'victory-text-out'; battleTimer = 0; }
  } else if (battleState === 'item-text-in') {
    if (battleTimer >= _textMs) { battleState = 'item-hold'; battleTimer = 0; }
  } else if (battleState === 'item-hold') {
  } else if (battleState === 'item-fade-out') {
    if (battleTimer >= _textMs) { battleState = ps.leveledUp ? 'levelup-text-in' : encounterJobLevelUp ? 'joblv-text-in' : 'victory-text-out'; battleTimer = 0; }
  } else if (battleState === 'levelup-text-in') {
    if (battleTimer >= _textMs) { battleState = 'levelup-hold'; battleTimer = 0; }
  } else if (battleState === 'levelup-hold') {
  } else if (battleState === 'levelup-fade-out') {
    if (battleTimer >= _textMs) { battleState = encounterJobLevelUp ? 'joblv-text-in' : 'victory-text-out'; battleTimer = 0; }
  } else if (battleState === 'joblv-text-in') {
    if (battleTimer >= _textMs) { battleState = 'joblv-hold'; battleTimer = 0; }
  } else if (battleState === 'joblv-hold') {
  } else if (battleState === 'joblv-fade-out') {
    if (battleTimer >= _textMs) { battleState = 'victory-text-out'; battleTimer = 0; }
  } else if (battleState === 'victory-text-out') {
    if (battleTimer >= _textMs) { battleMsgCurrent = null; battleState = 'victory-menu-fade'; battleTimer = 0; }
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

const POISON_TICK_MS = 500;
function _updatePoisonTick() {
  if (battleState !== 'poison-tick') return false;
  if (battleTimer >= POISON_TICK_MS) { processNextTurn(); }
  return true;
}

function updateBattle(dt) {
  if (battleState === 'none') return;
  battleTimer += Math.min(dt, 33);
  _updateBattleMsg(dt);
  if (battleState === 'msg-wait') { if (!battleMsgCurrent) processNextTurn(); return; }
  if (pvpSt.isPVPBattle) { updatePVPBattle(dt, _pvpShared()); return; }
  _updateBattleTimers(dt);
  _updatePoisonTick()         ||
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

function _drawPoisonFlash() {
  if (poisonFlashTimer < 0) return;
  if (poisonFlashTimer === 0) poisonFlashTimer = Date.now();
  if (Date.now() - poisonFlashTimer < 67) {
    clipToViewport();
    ctx.fillStyle = 'rgba(128, 0, 64, 0.35)';
    ctx.fillRect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);
    ctx.restore();
  } else { poisonFlashTimer = -1; }
}

function _drawPondStrobe() {
  if (pondStrobeTimer <= 0) return;
  const frame = Math.floor((BATTLE_FLASH_FRAMES * BATTLE_FLASH_FRAME_MS - pondStrobeTimer) / BATTLE_FLASH_FRAME_MS);
  if (!(frame & 1)) return;
  clipToViewport();
  grayViewport();
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
  updateChatTabs(dt);
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
    _drawPoisonFlash();
    drawTransitionOverlay(ctx, _transDrawShared());
    _drawPondStrobe();
    if (transSt.state === 'trap-falling' && sprite) sprite.draw(ctx, SCREEN_CENTER_X, SCREEN_CENTER_Y);
  } catch (e) {
    console.error('[RENDER ERROR]', e);
    fetch('/api/client-error', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ msg: e.message, stack: e.stack }) }).catch(() => {});
  }
  // Draw tabs BEFORE HUD so static HUD canvas draws on top of tab overlap
  const _infoFade = HUD_INFO_FADE_STEPS - Math.min(Math.floor(hudInfoFadeTimer / HUD_INFO_FADE_STEP_MS), HUD_INFO_FADE_STEPS);
  let _tabFade = Math.max(rosterBattleFade, _infoFade);
  const _wipeDur = 44 * (1000 / 60);
  const _wFadeMs = _wipeDur / ROSTER_FADE_STEPS;
  if (transSt.dungeon && transSt.state === 'closing') _tabFade = Math.max(_tabFade, Math.min(Math.floor(transSt.timer / _wFadeMs), ROSTER_FADE_STEPS));
  else if (transSt.dungeon && (transSt.state === 'hold' || transSt.state === 'trap-falling')) _tabFade = ROSTER_FADE_STEPS;
  else if (transSt.state === 'loading') {
    _tabWasLoading = true;
    _tabFade = ROSTER_FADE_STEPS;
    if (loadingSt.state === 'out') _tabFade = LOAD_FADE_MAX - Math.min(Math.floor(loadingSt.timer / LOAD_FADE_STEP_MS), LOAD_FADE_MAX);
  }
  else if (transSt.state === 'opening' && _tabWasLoading) _tabFade = Math.max(_tabFade, ROSTER_FADE_STEPS - Math.min(Math.floor(transSt.timer / _wFadeMs), ROSTER_FADE_STEPS));
  else _tabWasLoading = false;
  drawChatTabs(ctx, _tabFade, drawHudBox);
  drawHUD();
  const _bds = _battleDrawShared();
  try {
    const _rds = {
      ctx, drawHudBox: drawHudBox, drawBorderedBox: drawBorderedBox,
      clipToViewport: clipToViewport, cursorTileCanvas,
      scrollArrowUp, scrollArrowDown, scrollArrowUpFade, scrollArrowDownFade,
      fakePlayerPortraits, drawSparkle: drawRosterSparkle,
      transSt, wipeDuration: 44 * (1000 / 60),
      hudInfoFadeTimer, hudInfoFadeSteps: HUD_INFO_FADE_STEPS, hudInfoFadeStepMs: HUD_INFO_FADE_STEP_MS,
      battleState, msgState,
    };
    if (battleAllies.length > 0 && battleState !== 'none') drawBattleAllies(_bds);
    else drawRoster(_rds);
    drawChat(ctx, drawHudBox, rosterBattleFade);
    drawPauseMenu(ctx, _pauseShared());
    drawMsgBox(ctx, clipToViewport, drawBorderedBox);
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
    drawChat(ctx, drawHudBox, 0, true);
    requestAnimationFrame(gameLoop);
    return;
  }

  ps.playTime += dt / 1000;

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
