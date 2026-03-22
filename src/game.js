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
import { CRIT_RATE, CRIT_MULT, BASE_HIT_RATE, BOSS_HIT_RATE, GOBLIN_HIT_RATE,
         calcDamage, rollHits } from './battle-math.js';
import { LOCATIONS, PLAYER_POOL, PLAYER_PALETTES, CHAT_PHRASES } from './data/players.js';
import { BATTLE_MISS, BATTLE_GAME_OVER, BATTLE_ROAR, BATTLE_FIGHT, BATTLE_RUN,
         BATTLE_CANT_ESCAPE, BATTLE_RAN_AWAY, BATTLE_DEFEND, BATTLE_VICTORY,
         BATTLE_GOT_EXP, BATTLE_LEVEL_UP, BATTLE_BOSS_NAME, BATTLE_GOBLIN_NAME,
         BATTLE_MENU_ITEMS, PAUSE_ITEMS, AREA_NAMES, DUNGEON_NAME,
         POND_RESTORED } from './data/strings.js';
import { ENC_PAL0, ENC_PAL1, EYE_FANG_TILE_PAL, EYE_FANG_RAW,
         BLUE_WISP_TILE_PAL, BLUE_WISP_RAW,
         CARBUNCLE_TILE_PAL, CARBUNCLE_RAW } from './data/monster-sprites.js';

const isMobile = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

// --- Save data persistence (IndexedDB) ---
function openSaveDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ff3mmo-roms', 1);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveSlotsToDB() {
  if (!savesLoaded) return;
  try {
    const data = saveSlots.map(s => s ? {
      name: Array.from(s.name),
      level: s.level || (playerStats ? playerStats.level : 1),
      exp: s.exp != null ? s.exp : (playerStats ? playerStats.exp : 0),
      stats: s.stats || (playerStats ? _playerStatsSnapshot() : null),
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

async function serverDeleteSlot(slot) {
  if (window.ff3Auth) window.ff3Auth.serverDeleteSave(slot).catch(() => {});
}

function _parseSaveSlots(data) {
  if (!Array.isArray(data)) return;
  saveSlots = data.map(s => {
    if (!s) return null;
    if (Array.isArray(s)) return { name: new Uint8Array(s), level: 1, exp: 0, stats: null, inventory: {} };
    return { name: new Uint8Array(s.name), level: s.level || 1, exp: s.exp || 0, stats: s.stats || null, inventory: s.inventory || {} };
  });
}

async function loadSlotsFromDB() {
  try {
    // Try server first if logged in
    if (window.ff3Auth) {
      const serverSlots = await window.ff3Auth.serverLoadSaves().catch(() => null);
      if (serverSlots) {
        _parseSaveSlots(serverSlots);
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
        _parseSaveSlots(req.result);
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

// ENC_PAL0/1, *_RAW, *_TILE_PAL → data/monster-sprites.js

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
let savesLoaded = false;            // guard: don't write to DB until loaded from DB first
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
  if (rW || lW) return rW; // single weapon hand
  return hitIdx % 2 === 0; // unarmed fists: alternate R/L starting with R
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

// PVP duel state
let isPVPBattle = false;       // true when in a player-vs-player duel
let pvpOpponent = null;        // PLAYER_POOL entry being dueled
let pvpOpponentStats = null;   // {hp, maxHP, atk, def, agi, level, name, palIdx, weaponId}
let pvpOpponentIsDefending = false; // AI defend state
let pvpOpponentHitIdx = 0;         // increments each attack, even=R hand odd=L hand
let pvpOpponentHitsThisTurn = 0;   // how many hits opponent has done this turn (for dual-wield 2nd hit)
let pvpEnemyAllies = [];        // fake players who join the opponent's side
let pvpCurrentEnemyAllyIdx = -1; // -1 = main opponent attacking, >=0 = pvpEnemyAllies[i]
let pvpBoxResizeFromW = 0;
let pvpBoxResizeFromH = 0;
let pvpBoxResizeStartTime = 0;
let pvpEnemySlidePosFrom = [];
const PVP_BOX_RESIZE_MS = 300;

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
// CRIT_RATE, CRIT_MULT, BASE_HIT_RATE, BOSS_HIT_RATE, GOBLIN_HIT_RATE → battle-math.js

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

// AREA_NAMES, DUNGEON_NAME → data/strings.js

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
// PAUSE_ITEMS → data/strings.js

// --- Fake players (MMO roster) ---
// All locations players can be in
// LOCATIONS, PLAYER_POOL → data/players.js

// --- Chat system ---
const CHAT_LINE_H = 9;          // 8px font + 1px gap
const CHAT_VISIBLE = 5;         // max lines shown when collapsed
const CHAT_HISTORY = 30;        // total messages kept in buffer
const CHAT_EXPAND_MS = 650;     // expand/collapse duration — tuned to match SCREEN_OPEN/CLOSE SFX
const CHAT_AUTO_MIN_MS = 5000;
const CHAT_AUTO_MAX_MS = 16000;
// CHAT_PHRASES → data/players.js

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
  if (loc === 'cave-1') { weaponId = 0x1F; weaponAtk = 8; totalDef = 3; }
  else if (loc === 'cave-2') { weaponId = 0x24; weaponAtk = 10; totalDef = 3; }
  else if (loc === 'cave-3' || loc === 'crystal') { weaponId = 0x24; weaponAtk = 10; totalDef = 7; }
  // Override with explicit weapon slots if defined on player entry
  if (player.weaponR != null) weaponId = player.weaponR;
  const weaponL = player.weaponL != null ? player.weaponL : null;
  const atk = str + weaponAtk;
  const def = vit + totalDef;
  return { name: player.name, palIdx: player.palIdx, level: lv, hp, maxHP: hp, atk, def, agi, weaponId, weaponL, fadeStep: ROSTER_FADE_STEPS };
}
// PLAYER_PALETTES → data/players.js
let fakePlayerPortraits = [];   // HTMLCanvasElement[palIdx][fadeStep]
let fakePlayerFullBodyCanvases = []; // HTMLCanvasElement[palIdx] — 16×24 h-flipped full body for PVP (idle)
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
let fakePlayerKnifeRFullBodyCanvases = []; // knife R-hand 16×24 h-flipped full body (attack portrait + idle legs)
let fakePlayerKnifeLFullBodyCanvases = []; // knife L-hand 16×24 h-flipped full body
let fakePlayerKnifeBackFullBodyCanvases = []; // knife back-swing 16×24 h-flipped full body (wind-up pose)
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
let pondStrobeTimer = 0;  // >0 = pond strobe active


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

function _onChatKeyDown(e) {
  e.preventDefault();
  if (e.key === 'Enter') {
    if (chatInputText.length > 0) {
      const slot = saveSlots[selectCursor];
      const senderName = (slot && slot.name) ? _nesNameToString(slot.name) : 'You';
      addChatMessage(senderName + ': ' + chatInputText, 'chat');
    }
    chatInputActive = false; chatInputText = '';
  } else if (e.key === 'Escape') {
    chatInputActive = false; chatInputText = '';
  } else if (e.key === 'Backspace') {
    chatInputText = chatInputText.slice(0, -1);
  } else if (e.key.length === 1 && chatInputText.length < 42) {
    chatInputText += e.key;
  }
}
function _onNameEntryKeyDown(e) {
  e.preventDefault();
  if (e.key === 'Enter' && nameBuffer.length > 0) {
    saveSlots[selectCursor] = { name: new Uint8Array(nameBuffer), level: 1, exp: 0, stats: null, inventory: {} };
    saveSlotsToDB();
    titleState = 'select'; titleTimer = 0;
  } else if (e.key === 'Backspace') {
    if (nameBuffer.length > 0) nameBuffer.pop();
    else { titleState = 'select'; titleTimer = 0; }
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
    if (chatInputActive) { _onChatKeyDown(e); return; }
    if (titleState === 'name-entry') { _onNameEntryKeyDown(e); return; }
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
      chatInputActive = true; chatInputText = ''; chatCursorTimer = 0;
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
const _FP_ATK_R_TILE = new Uint8Array([0x1F,0x04,0x16,0x16,0x2F,0x7F,0x70,0x26, 0x00,0x00,0x00,0x00,0x30,0x70,0x70,0x3E]);
const _FP_ATK_L_TILE3 = new Uint8Array([0x1F,0x04,0x16,0x16,0x0C,0x08,0x38,0x7C, 0x00,0x00,0x00,0x00,0x11,0x03,0x38,0x7D]);
const _FP_ATK_L_TILE4 = new Uint8Array([0x18,0x80,0x48,0xCC,0x00,0x00,0x00,0x00, 0x59,0x32,0x38,0x0C,0x80,0xC0,0x00,0x60]);
const _FP_KNEEL = [
  new Uint8Array([0x00,0x00,0x00,0x00,0x02,0x05,0x0B,0x00, 0x00,0x00,0x00,0x00,0x03,0x07,0x0F,0x1F]),
  new Uint8Array([0x00,0x00,0x00,0x00,0x80,0xB8,0xDC,0xEE, 0x00,0x00,0x00,0x00,0x9B,0xBE,0xDD,0xEF]),
  new Uint8Array([0x00,0x03,0x07,0x05,0x01,0x01,0x1B,0x3B, 0x20,0x10,0x00,0x00,0x00,0x04,0x00,0x20]),
  new Uint8Array([0x36,0x1A,0xC6,0x20,0x92,0x81,0xDC,0xDE, 0xF6,0x3A,0x16,0x0C,0x0E,0x21,0x04,0x06]),
];
function _initFakePosePortraits(romData) {
  const idleTiles = _FP_IDLE_PPU.map(d => decodeTile(d, 0));
  fakePlayerPortraits         = _genPosePortraits(idleTiles);
  fakePlayerVictoryPortraits  = _genPosePortraits([0,1,2,3].map(i => decodeTile(romData, BATTLE_SPRITE_ROM + (24 + i) * 16)));
  fakePlayerHitPortraits      = _genPosePortraits([0,1,2,3].map(i => decodeTile(romData, BATTLE_SPRITE_ROM + (30 + i) * 16)));
  fakePlayerDefendPortraits   = _genPosePortraits(_FP_DEFEND.map(d => decodeTile(d, 0)));
  fakePlayerAttackPortraits   = _genPosePortraits([idleTiles[0], idleTiles[1], decodeTile(_FP_ATK_R_TILE, 0), idleTiles[3]]);
  fakePlayerAttackLPortraits  = _genPosePortraits([idleTiles[0], idleTiles[1], decodeTile(_FP_ATK_L_TILE3, 0), decodeTile(_FP_ATK_L_TILE4, 0)]);
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
// PPU tile data constants for fake player poses (from FCEUX trace)
const _FP_IDLE_PPU = [
  new Uint8Array([0x00,0x00,0x0A,0x16,0x2F,0x03,0x00,0x0C, 0x00,0x00,0x0E,0x1E,0x3F,0x7F,0x83,0x40]),
  new Uint8Array([0x00,0x00,0x00,0xE0,0x70,0xB8,0xD8,0x68, 0x00,0x6C,0x19,0xFE,0x76,0xBB,0xDB,0xED]),
  new Uint8Array([0x1F,0x04,0x16,0x16,0x0F,0x0F,0x60,0xC6, 0x00,0x00,0x00,0x00,0x50,0xE0,0x60,0x1E]),
  new Uint8Array([0x18,0x80,0x48,0xCC,0x00,0x00,0x70,0xD8, 0x59,0x32,0x38,0x0C,0xB0,0x78,0x70,0x1C]),
];
const _FP_KNIFE_BACK = [
  new Uint8Array([0x05,0x0B,0x17,0x03,0x00,0x00,0x0E,0x1F, 0x07,0x0F,0x1F,0x3F,0x43,0x40,0x20,0x00]),
  new Uint8Array([0x00,0x00,0xA0,0xD0,0xE8,0x78,0x10,0x88, 0x2C,0x59,0xBE,0xD6,0xEF,0xFB,0x75,0x1A]),
  new Uint8Array([0x04,0xD6,0xD6,0x3F,0xEF,0xF0,0x63,0x0E, 0x00,0x00,0x00,0x24,0xE4,0xF0,0x6F,0x1F]),
  new Uint8Array([0x90,0x4C,0xCC,0x30,0x7C,0x78,0x30,0x00, 0x32,0x21,0x00,0xB0,0x7C,0x7C,0xB2,0xC2]),
];
const _FP_DEFEND = _FP_KNIFE_BACK; // same tiles as knife-back pose
const _FP_KNIFE_R = [
  new Uint8Array([0x00,0x00,0x0A,0x16,0x2F,0x03,0x00,0x0C, 0x00,0x00,0x0E,0x1E,0x3F,0x7F,0x83,0x40]),
  new Uint8Array([0x00,0x00,0x00,0xE0,0x70,0xB8,0xD8,0x68, 0x00,0x6C,0x19,0xFE,0x76,0xBB,0xDB,0xED]),
  new Uint8Array([0x1F,0x04,0x16,0x16,0x2F,0x7F,0x70,0x26, 0x00,0x00,0x00,0x00,0x30,0x70,0x70,0x3E]),
  new Uint8Array([0x18,0x80,0x48,0xCC,0x00,0x00,0x70,0xD8, 0x59,0x32,0x38,0x0C,0xB0,0x78,0x70,0x1C]),
];
const _FP_KNIFE_L = [
  new Uint8Array([0x00,0x00,0x0A,0x16,0x2F,0x03,0x00,0x0C, 0x00,0x00,0x0E,0x1E,0x3F,0x7F,0x83,0x40]),
  new Uint8Array([0x00,0x00,0x00,0xE0,0x70,0xB8,0xD8,0x68, 0x00,0x6C,0x19,0xFE,0x76,0xBB,0xDB,0xEC]),
  new Uint8Array([0x1F,0x04,0x16,0x16,0x0F,0x0F,0x60,0xC6, 0x00,0x00,0x00,0x00,0x50,0xE0,0x60,0x1E]),
  new Uint8Array([0x13,0x87,0x57,0xF8,0x7E,0x3C,0x1C,0x08, 0x50,0x30,0x30,0x38,0xFE,0x7C,0xFE,0xFA]),
];
const _FP_LEG_L = new Uint8Array([0xCC,0x58,0x2F,0x3F,0x3F,0x1F,0x00,0x00, 0x1E,0x5F,0x3F,0x3F,0x3F,0x1F,0x07,0x0F]);
const _FP_LEG_R = new Uint8Array([0xD8,0x70,0x80,0xE0,0xE0,0xC0,0x00,0x00, 0x1C,0x74,0x84,0xE6,0xE6,0xC6,0xC7,0xC7]);
function _buildIdleFullBodies() {
  const legL = decodeTile(_FP_LEG_L, 0), legR = decodeTile(_FP_LEG_R, 0);
  const tiles = _FP_IDLE_PPU.map(d => decodeTile(d, 0));
  fakePlayerFullBodyCanvases = PLAYER_PALETTES.map(pal => _buildFullBody16x24Canvas(tiles, legL, legR, pal));
}
function _buildKnifeFullBodies() {
  const legL = decodeTile(_FP_LEG_L, 0), legR = decodeTile(_FP_LEG_R, 0);
  const build = (data, pal) => _buildFullBody16x24Canvas(data.map(d => decodeTile(d, 0)), legL, legR, pal);
  fakePlayerKnifeRFullBodyCanvases    = PLAYER_PALETTES.map(pal => build(_FP_KNIFE_R, pal));
  fakePlayerKnifeLFullBodyCanvases    = PLAYER_PALETTES.map(pal => build(_FP_KNIFE_L, pal));
  fakePlayerKnifeBackFullBodyCanvases = PLAYER_PALETTES.map(pal => build(_FP_KNIFE_BACK, pal));
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
}
function initFakePlayerPortraits(romData) {
  _initFakePosePortraits(romData);
  _initFakeFullBodyCanvases(romData);
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
  const IDLE_PPU = [
    new Uint8Array([0x00,0x00,0x0A,0x16,0x2F,0x03,0x00,0x0C, 0x00,0x00,0x0E,0x1E,0x3F,0x7F,0x83,0x40]), // $01 TL
    new Uint8Array([0x00,0x00,0x00,0xE0,0x70,0xB8,0xD8,0x68, 0x00,0x6C,0x19,0xFE,0x76,0xBB,0xDB,0xED]), // $02 TR
    new Uint8Array([0x1F,0x04,0x16,0x16,0x0F,0x0F,0x60,0xC6, 0x00,0x00,0x00,0x00,0x50,0xE0,0x60,0x1E]), // $03 BL
    new Uint8Array([0x18,0x80,0x48,0xCC,0x00,0x00,0x70,0xD8, 0x59,0x32,0x38,0x0C,0xB0,0x78,0x70,0x1C]), // $04 BR
  ];
  // Idle portrait — 2×2 layout row-major (disasm 3C/82FA OAM data)
  battleSpriteCanvas = _buildCanvas4(IDLE_PPU, palette);

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
  // Attack pose tiles from FCEUX PPU dump (unarmed, weapons zeroed)
  // Right hand: mid-L changes $03→$39; left hand: mid-L→$3B, mid-R→$3C
  const ATK_R_39 = new Uint8Array([0x1F,0x04,0x16,0x16,0x2F,0x7F,0x70,0x26,
                                    0x00,0x00,0x00,0x00,0x30,0x70,0x70,0x3E]);
  const ATK_L_3B = new Uint8Array([0x1F,0x04,0x16,0x16,0x0C,0x08,0x38,0x7C,
                                    0x00,0x00,0x00,0x00,0x11,0x03,0x38,0x7D]);
  const ATK_L_3C = new Uint8Array([0x18,0x80,0x48,0xCC,0x00,0x00,0x00,0x00,
                                    0x59,0x32,0x38,0x0C,0x80,0xC0,0x00,0x60]);

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
  _drawTileOnto(ATK_L_3B, palette, alctx, 0, 8);
  _drawTileOnto(ATK_L_3C, palette, alctx, 8, 8);
}

function _initBattleKnifeBodySprites(palette) {
  // Knife R-hand body pose: $2B/$2C/$39/$2E
  const KNIFE_R_TILES = [
    new Uint8Array([0x00,0x00,0x0A,0x16,0x2F,0x03,0x00,0x0C, 0x00,0x00,0x0E,0x1E,0x3F,0x7F,0x83,0x40]),
    new Uint8Array([0x00,0x00,0x00,0xE0,0x70,0xB8,0xD8,0x68, 0x00,0x6C,0x19,0xFE,0x76,0xBB,0xDB,0xED]),
    new Uint8Array([0x1F,0x04,0x16,0x16,0x2F,0x7F,0x70,0x26, 0x00,0x00,0x00,0x00,0x30,0x70,0x70,0x3E]),
    new Uint8Array([0x18,0x80,0x48,0xCC,0x00,0x00,0x70,0xD8, 0x59,0x32,0x38,0x0C,0xB0,0x78,0x70,0x1C]),
  ];
  battleSpriteKnifeRCanvas = _buildCanvas4(KNIFE_R_TILES, palette);

  // Knife L-hand body pose: $01/$3F/$03/$40
  const KNIFE_L_TILES = [
    new Uint8Array([0x00,0x00,0x0A,0x16,0x2F,0x03,0x00,0x0C, 0x00,0x00,0x0E,0x1E,0x3F,0x7F,0x83,0x40]),
    new Uint8Array([0x00,0x00,0x00,0xE0,0x70,0xB8,0xD8,0x68, 0x00,0x6C,0x19,0xFE,0x76,0xBB,0xDB,0xEC]),
    new Uint8Array([0x1F,0x04,0x16,0x16,0x0F,0x0F,0x60,0xC6, 0x00,0x00,0x00,0x00,0x50,0xE0,0x60,0x1E]),
    new Uint8Array([0x13,0x87,0x57,0xF8,0x7E,0x3C,0x1C,0x08, 0x50,0x30,0x30,0x38,0xFE,0x7C,0xFE,0xFA]),
  ];
  battleSpriteKnifeLCanvas = _buildCanvas4(KNIFE_L_TILES, palette);

  // Back-swing body pose: $43/$44/$45/$46
  const KNIFE_BACK_TILES = [
    new Uint8Array([0x05,0x0B,0x17,0x03,0x00,0x00,0x0E,0x1F, 0x07,0x0F,0x1F,0x3F,0x43,0x40,0x20,0x00]),
    new Uint8Array([0x00,0x00,0xA0,0xD0,0xE8,0x78,0x10,0x88, 0x2C,0x59,0xBE,0xD6,0xEF,0xFB,0x75,0x1A]),
    new Uint8Array([0x04,0xD6,0xD6,0x3F,0xEF,0xF0,0x63,0x0E, 0x00,0x00,0x00,0x24,0xE4,0xF0,0x6F,0x1F]),
    new Uint8Array([0x90,0x4C,0xCC,0x30,0x7C,0x78,0x30,0x00, 0x32,0x21,0x00,0xB0,0x7C,0x7C,0xB2,0xC2]),
  ];
  battleSpriteKnifeBackCanvas = _buildCanvas4(KNIFE_BACK_TILES, palette);
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
  // Victory pose: sprite frame 4 in job block (tiles 24-27)
  battleSpriteVictoryCanvas = _buildCanvas4ROM(romData, BATTLE_SPRITE_ROM + 24 * 16, palette);
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
  // Kneel pose: tiles $09-$0C (near-fatal ≤ maxHP/4, disasm 34/9485)
  const KNEEL_TILES = [
    new Uint8Array([0x00,0x00,0x00,0x00,0x02,0x05,0x0B,0x00, 0x00,0x00,0x00,0x00,0x03,0x07,0x0F,0x1F]),
    new Uint8Array([0x00,0x00,0x00,0x00,0x80,0xB8,0xDC,0xEE, 0x00,0x00,0x00,0x00,0x9B,0xBE,0xDD,0xEF]),
    new Uint8Array([0x00,0x03,0x07,0x05,0x01,0x01,0x1B,0x3B, 0x20,0x10,0x00,0x00,0x00,0x04,0x00,0x20]),
    new Uint8Array([0x36,0x1A,0xC6,0x20,0x92,0x81,0xDC,0xDE, 0xF6,0x3A,0x16,0x0C,0x0E,0x21,0x04,0x06]),
  ];
  battleSpriteKneelCanvas = _buildCanvas4(KNEEL_TILES, palette);

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
  const BATTLE_PAL_ROM = 0x05CF04;
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

  const layout = [[0,0], [8,0], [0,8], [8,8]];
  for (let i = 0; i < 4; i++) _renderDecodedTile(actx, tiles[i], i < 2 ? palTop : palBot, layout[i][0], layout[i][1]);

  // Flipped frame
  const flipped = _hflipCanvas16(normal);

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

function _makeWhiteCanvas(srcCanvas) {
  const { width: w, height: h } = srcCanvas;
  const wc = document.createElement('canvas'); wc.width = w; wc.height = h;
  const wctx = wc.getContext('2d');
  const srcData = srcCanvas.getContext('2d').getImageData(0, 0, w, h);
  const [r, g, b] = NES_SYSTEM_PALETTE[0x30] || [255, 255, 255];
  for (let p = 0; p < srcData.data.length; p += 4) {
    if (srcData.data[p + 3] > 0) { srcData.data[p] = r; srcData.data[p+1] = g; srcData.data[p+2] = b; }
  }
  wctx.putImageData(srcData, 0, 0);
  return wc;
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
// SouthWind ice explosion — 3-phase expanding animation from battle-item-trace.txt
// Phase 1 (+024-+031): small crystal  16×16, tile $4F 2×2
// Phase 2 (+032-+039): medium splash  32×32, tiles $49/$4A/$4C/$4D 4×4
// Phase 3 (+040-+047): large blast    48×48, tiles $49-$4E/$4F/$50/$51 6×6
// All use pal3: $0F $11 $21 $31 (ice blue)
// Raw PPU tile data for SouthWind spell (planar 2BPP, from FCEUX trace)
const SW_TILES = {
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
function _drawSWTile(cctx, nesColors, id, dx, dy, hf, vf) {
  const px = decodeTile(SW_TILES[id], 0);
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
function _buildSWPhase1(nc) {
  const c = _makeCanvas16();
  const x = c.getContext('2d');
  _drawSWTile(x, nc, 0x4F,  0, 0, false, false); _drawSWTile(x, nc, 0x4F,  8, 0, true,  false);
  _drawSWTile(x, nc, 0x4F,  0, 8, false, true);  _drawSWTile(x, nc, 0x4F,  8, 8, true,  true);
  return c;
}
function _buildSWPhase2(nc) {
  const c = document.createElement('canvas'); c.width = 32; c.height = 32;
  const x = c.getContext('2d');
  _drawSWTile(x, nc, 0x49,  0, 0, false, false); _drawSWTile(x, nc, 0x4A,  8, 0, false, false);
  _drawSWTile(x, nc, 0x4A, 16, 0, true,  false); _drawSWTile(x, nc, 0x49, 24, 0, true,  false);
  _drawSWTile(x, nc, 0x4C,  0, 8, false, false); _drawSWTile(x, nc, 0x4D,  8, 8, false, false);
  _drawSWTile(x, nc, 0x4D, 16, 8, true,  false); _drawSWTile(x, nc, 0x4C, 24, 8, true,  false);
  _drawSWTile(x, nc, 0x4C,  0,16, false, true);  _drawSWTile(x, nc, 0x4D,  8,16, false, true);
  _drawSWTile(x, nc, 0x4D, 16,16, true,  true);  _drawSWTile(x, nc, 0x4C, 24,16, true,  true);
  _drawSWTile(x, nc, 0x49,  0,24, false, true);  _drawSWTile(x, nc, 0x4A,  8,24, false, true);
  _drawSWTile(x, nc, 0x4A, 16,24, true,  true);  _drawSWTile(x, nc, 0x49, 24,24, true,  true);
  return c;
}
function _buildSWPhase3(nc) {
  const c = document.createElement('canvas'); c.width = 48; c.height = 48;
  const x = c.getContext('2d');
  // 6×6 symmetric grid: left half normal, right half H-flipped; top half normal, bottom half V-flipped
  const p = [
    [0x49,0x4A,0x4B,0x4B,0x4A,0x49],
    [0x4C,0x4D,0x4E,0x4E,0x4D,0x4C],
    [0x4F,0x50,0x51,0x51,0x50,0x4F],
    [0x4F,0x50,0x51,0x51,0x50,0x4F],
    [0x4C,0x4D,0x4E,0x4E,0x4D,0x4C],
    [0x49,0x4A,0x4B,0x4B,0x4A,0x49],
  ];
  for (let row = 0; row < 6; row++) for (let col = 0; col < 6; col++)
    _drawSWTile(x, nc, p[row][col], col*8, row*8, col >= 3, row >= 3);
  return c;
}
function initSouthWindSprite() {
  const nc = [0x0F, 0x11, 0x21, 0x31].map(c => NES_SYSTEM_PALETTE[c] || [0,0,0]);
  swPhaseCanvases = [_buildSWPhase1(nc), _buildSWPhase2(nc), _buildSWPhase3(nc)];
  southWindHitCanvas = swPhaseCanvases[0];
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
      for (let p = 0; p < 64; p++) {
        const ci = pixels[p];
        if (ci === 0) { img.data[p * 4 + 3] = 0; }
        else {
          const rgb = NES_SYSTEM_PALETTE[pal[ci]] || [0, 0, 0];
          img.data[p * 4] = rgb[0]; img.data[p * 4 + 1] = rgb[1];
          img.data[p * 4 + 2] = rgb[2]; img.data[p * 4 + 3] = 255;
        }
      }
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
    for (let p = 0; p < 64; p++) {
      const ci = pixels[p];
      if (ci === 0) { img.data[p * 4 + 3] = 0; }
      else {
        const rgb = NES_SYSTEM_PALETTE[pal[ci]] || [0, 0, 0];
        img.data[p * 4] = rgb[0]; img.data[p * 4 + 1] = rgb[1];
        img.data[p * 4 + 2] = rgb[2]; img.data[p * 4 + 3] = 255;
      }
    }
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

  invincibleFadeFrames = [];
  for (let fl = 0; fl <= TITLE_FADE_MAX; fl++) {
    const fadedPal = INVINCIBLE_PAL.map((c, i) => {
      if (i === 0) return c;
      let fc = c;
      for (let s = 0; s < fl; s++) fc = nesColorFade(fc);
      return fc;
    });
    invincibleFadeFrames.push([
      _renderInvFrame(tilePixels, frameA_grid, fadedPal),
      _renderInvFrame(tilePixels, frameB_grid, fadedPal),
    ]);
  }

  invincibleShadowFade = [];
  for (let fl = 0; fl <= TITLE_FADE_MAX; fl++) {
    const fadedPal = INVINCIBLE_PAL.map((c, i) => {
      if (i === 0) return c;
      let fc = c;
      for (let s = 0; s < fl; s++) fc = nesColorFade(fc);
      return fc;
    });
    invincibleShadowFade.push(_renderInvShadow(tilePixels, fadedPal));
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
    _blitTile(mctx, tiles[i], MOOGLE_PAL, layout[i][0], layout[i][1]);
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

  const c = document.createElement('canvas');
  c.width = 16; c.height = 16;
  const cctx = c.getContext('2d');
  const layout = [[0,0], [8,0], [0,8], [8,8]];

  for (let i = 0; i < 4; i++) {
    _blitTile(cctx, tiles[i], fadedPal, layout[i][0], layout[i][1]);
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
  for (let i = 0; i < 4; i++) _renderDecodedTile(cctx, tiles[i], i < 2 ? fadedTop : fadedBot, layout[i][0], layout[i][1]);
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

function _makeCanvas16() {
  const c = document.createElement('canvas'); c.width = 16; c.height = 16; return c;
}
function _buildHorizWaterPair(bL, bR) {
  const p0L = _getPlane0(bL), p0R = _getPlane0(bR);
  const p1L = bL.map(p => p & 2), p1R = bR.map(p => p & 2);
  const arrL = [], arrR = [];
  let cL = new Uint8Array(p0L), cR = new Uint8Array(p0R);
  for (let f = 0; f < 16; f++) {
    arrL.push(_rebuild(cL, p1L)); arrR.push(_rebuild(cR, p1R));
    [cL, cR] = _shiftHorizWater(cL, cR);
  }
  return [arrL, arrR];
}
function _buildItemRowBytes(nameBytes, countStr) {
  const rowBytes = new Uint8Array(nameBytes.length + 2 + countStr.length);
  rowBytes.set(nameBytes, 0);
  rowBytes[nameBytes.length] = 0xFF; rowBytes[nameBytes.length + 1] = 0xE1;
  for (let d = 0; d < countStr.length; d++) rowBytes[nameBytes.length + 2 + d] = 0x80 + parseInt(countStr[d]);
  return rowBytes;
}
function _pauseFadeStep(inState, outState) {
  if (pauseState === inState) return PAUSE_TEXT_STEPS - Math.min(Math.floor(pauseTimer / PAUSE_TEXT_STEP_MS), PAUSE_TEXT_STEPS);
  if (pauseState === outState) return Math.min(Math.floor(pauseTimer / PAUSE_TEXT_STEP_MS), PAUSE_TEXT_STEPS);
  return 0;
}
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
function _shiftHorizWater(cL, cR) {
  const nL = new Uint8Array(8), nR = new Uint8Array(8);
  for (let r = 0; r < 8; r++) {
    const l = cL[r], ri = cR[r];
    nL[r] = ((l >> 1) | ((ri & 1) << 7)) & 0xFF;
    nR[r] = ((ri >> 1) | ((l & 1) << 7)) & 0xFF;
  }
  return [nL, nR];
}
function _grayViewport() {
  ctx.filter = 'saturate(0)';
  ctx.drawImage(ctx.canvas, HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H,
                            HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);
  ctx.filter = 'none'; ctx.restore();
}
function _pausePanelLayout() {
  const px = HUD_VIEW_X, finalY = HUD_VIEW_Y, pw = PAUSE_MENU_W, ph = PAUSE_MENU_H;
  const isInvState = pauseState.startsWith('inv-') || pauseState === 'inventory';
  const isEqState  = pauseState.startsWith('eq-')  || pauseState === 'equip';
  let panelY = finalY;
  if (pauseState === 'scroll-in') {
    const t = Math.min(pauseTimer / PAUSE_SCROLL_MS, 1);
    panelY = finalY - ph + t * ph;
  } else if (pauseState === 'scroll-out') {
    const t = Math.min(pauseTimer / PAUSE_SCROLL_MS, 1);
    panelY = finalY - t * ph;
  }
  return { px, finalY, pw, ph, isInvState, isEqState, panelY };
}
function _resetBattleVars() {
  battleCursor = 0; battleMessage = null;
  bossDamageNum = null; playerDamageNum = null; playerHealNum = null; enemyHealNum = null;
  encounterDropItem = null; bossFlashTimer = 0; battleShakeTimer = 0;
  isDefending = false; battleAllies = []; allyJoinRound = 0;
  currentAllyAttacker = -1; allyTargetIndex = -1; allyHitResult = null;
  allyDamageNums = {}; allyShakeTimer = {}; enemyTargetAllyIdx = -1; allyExitTimer = 0;
  southWindTargets = []; southWindHitIdx = 0; southWindDmgNums = {};
}
function _zPressed() { if (!keys['z'] && !keys['Z']) return false; keys['z'] = false; keys['Z'] = false; return true; }
function _xPressed() { if (!keys['x'] && !keys['X']) return false; keys['x'] = false; keys['X'] = false; return true; }
function _hflipCanvas16(src) {
  const c = _makeCanvas16(); const cx = c.getContext('2d');
  cx.translate(16, 0); cx.scale(-1, 1); cx.drawImage(src, 0, 0); return c;
}
function _playerStatsSnapshot() {
  return {
    str: playerStats.str, agi: playerStats.agi, vit: playerStats.vit,
    int: playerStats.int, mnd: playerStats.mnd,
    maxHP: playerStats.maxHP, maxMP: playerStats.maxMP,
    weaponR: playerWeaponR, weaponL: playerWeaponL,
    head: playerHead, body: playerBody, arms: playerArms,
  };
}
function _syncSaveSlotProgress() {
  if (!saveSlots[selectCursor]) return;
  saveSlots[selectCursor].level = playerStats.level;
  saveSlots[selectCursor].exp = playerStats.exp;
  saveSlots[selectCursor].stats = _playerStatsSnapshot();
  saveSlots[selectCursor].inventory = { ...playerInventory };
  saveSlots[selectCursor].gil = playerGil;
}
function _makeFadedPal(fadeStep) {
  const p = [0x0F, 0x0F, 0x0F, 0x30];
  for (let s = 0; s < fadeStep; s++) p[3] = nesColorFade(p[3]);
  return p;
}
function _stepPalFade(pal) {
  pal[1] = nesColorFade(pal[1]); pal[2] = nesColorFade(pal[2]); pal[3] = nesColorFade(pal[3]);
}
function _loadBattlePalette(romData, bgId) {
  return [0x0F, romData[BATTLE_BG_PAL_C1 + bgId], romData[BATTLE_BG_PAL_C2 + bgId], romData[BATTLE_BG_PAL_C3 + bgId]];
}
function _loadBattleMetaTiles(romData) {
  const metaTiles = [];
  for (let m = 0; m < 4; m++) {
    const ids = [];
    for (let j = 0; j < 4; j++) ids.push(romData[BATTLE_BG_META_TILES + m * 4 + j] - 0x60);
    metaTiles.push(ids);
  }
  return metaTiles;
}
function _loadBattleTilemap(romData, bgId) {
  const tilemap = _loadBattleTilemap(romData, bgId);
  return tilemap;
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
      for (const [tIdx, sx, sy] of subTiles) _renderDecodedTile(bctx, tiles[tIdx], palette, sx, sy);
    }
  }
  return c;
}

function renderBattleBg(romData, bgId) {
  // Palette: color 0 = $0F (black), colors 1-3 from ROM
  const palette = _loadBattlePalette(romData, bgId);

  // Decode 16 tiles (8×8 each, 2BPP)
  const tiles = [];
  const tileBase = BATTLE_BG_TILES_ROM + bgId * 0x100;
  for (let i = 0; i < 16; i++) {
    tiles.push(decodeTile(romData, tileBase + i * 16));
  }

  const metaTiles = _loadBattleMetaTiles(romData);

  // Read tilemap (2 rows × 16 metatile entries)
  const tilemap = _loadBattleTilemap(romData, bgId);

  // Pre-render all fade frames (original → progressively darker → black)
  const frames = [];
  const fadePal = [...palette];
  while (true) {
    frames.push(renderBattleBgWithPalette(romData, bgId, fadePal, tiles, metaTiles, tilemap));
    // Check if all colors are black
    if (fadePal[1] === 0x0F && fadePal[2] === 0x0F && fadePal[3] === 0x0F) break;
    // Step each color toward black
    _stepPalFade(fadePal);
  }

  topBoxBgFadeFrames = frames;
  return frames[0]; // original = topBoxBgCanvas
}

// ── Title Screen Init ──

const TITLE_OCEAN_CHR = [0x22, 0x23, 0x24, 0x25]; // horizontal water CHR tile IDs
const TITLE_WATER_PAL_IDX = 2; // world map palette index for ocean
const TITLE_SKY_BGID = 6;      // airship sky battle BG (blue/lavender/white clouds)

function _precomputeWaterShifts(chrTiles) {
  const shifted = {};
  for (const [ciL, ciR] of [[0x22, 0x23], [0x24, 0x25]]) {
    const bL = chrTiles[ciL], bR = chrTiles[ciR];
    const [arrL, arrR] = _buildHorizWaterPair(bL, bR);
    shifted[ciL] = arrL; shifted[ciR] = arrR;
  }
  return shifted;
}
function _renderOceanTile16(shifted, pal, animFrame) {
  const rgbPal = pal.map(ni => NES_SYSTEM_PALETTE[ni & 0x3F] || [0,0,0]);
  const c = document.createElement('canvas');
  c.width = 16; c.height = 16;
  const tctx = c.getContext('2d');
  for (const [pixels, ox, oy] of [
    [shifted[0x22][animFrame], 0, 0], [shifted[0x23][animFrame], 8, 0],
    [shifted[0x24][animFrame], 0, 8], [shifted[0x25][animFrame], 8, 8],
  ]) {
    const img = tctx.createImageData(8, 8);
    for (let p = 0; p < 64; p++) {
      const rgb = rgbPal[pixels[p]];
      img.data[p*4]=rgb[0]; img.data[p*4+1]=rgb[1]; img.data[p*4+2]=rgb[2]; img.data[p*4+3]=255;
    }
    tctx.putImageData(img, ox, oy);
  }
  return c;
}
function _buildTitleWaterFrames(shifted, basePal) {
  titleWaterFrames = [];
  for (let f = 0; f < 16; f++) titleWaterFrames.push(_renderOceanTile16(shifted, basePal, f));
  titleWaterFadeTiles = [];
  const fadePal = [...basePal];
  for (let step = 0; step <= TITLE_FADE_MAX; step++) {
    titleWaterFadeTiles.push(_renderOceanTile16(shifted, step === 0 ? basePal : fadePal, 0));
    if (step < TITLE_FADE_MAX) for (let i = 0; i < 4; i++) fadePal[i] = nesColorFade(fadePal[i]);
  }
}
function initTitleWater(romData) {
  const COMMON_CHR = 0x014C10;
  const chrTiles = {};
  for (const ci of TITLE_OCEAN_CHR) chrTiles[ci] = decodeTile(romData, COMMON_CHR + ci * 16);
  const palOff = 0x001650 + TITLE_WATER_PAL_IDX * 4;
  const basePal = [romData[palOff], romData[palOff+1], romData[palOff+2], romData[palOff+3]];
  _buildTitleWaterFrames(_precomputeWaterShifts(chrTiles), basePal);
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

  const metaTiles = _loadBattleMetaTiles(romData);

  const tilemap = _loadBattleTilemap(romData, bgId);

  // Pre-render fade frames (same approach as renderBattleBg but stored separately)
  titleSkyFrames = [];
  const fadePal = [...palette];
  while (true) {
    titleSkyFrames.push(renderBattleBgWithPalette(romData, bgId, fadePal, tiles, metaTiles, tilemap));
    if (fadePal[1] === 0x0F && fadePal[2] === 0x0F && fadePal[3] === 0x0F) break;
    _stepPalFade(fadePal);
  }
}

function initTitleUnderwater(romData) {
  const bgId = 18; // undersea Nautilus battle BG ($12/$22/$33 blue palette)
  const palette = _loadBattlePalette(romData, bgId);

  const tiles = [];
  const tileBase = BATTLE_BG_TILES_ROM + bgId * 0x100;
  for (let i = 0; i < 16; i++) tiles.push(decodeTile(romData, tileBase + i * 16));

  const metaTiles = _loadBattleMetaTiles(romData);

  const tilemap = _loadBattleTilemap(romData, bgId);

  titleUnderwaterFrames = [];
  const fadePal = [...palette];
  while (true) {
    titleUnderwaterFrames.push(renderBattleBgWithPalette(romData, bgId, fadePal, tiles, metaTiles, tilemap));
    if (fadePal[1] === 0x0F && fadePal[2] === 0x0F && fadePal[3] === 0x0F) break;
    _stepPalFade(fadePal);
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

function _renderOceanRow(tiles, metaTiles, tilemap, pal, rowIdx) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 16;
  const rctx = c.getContext('2d');
  for (let col = 0; col < 16; col++) {
    const metaIdx = tilemap[rowIdx * 16 + col];
    const [tl, tr, bl, br] = metaTiles[metaIdx];
    const px = col * 16;
    for (const [tIdx, sx, sy] of [[tl,px,0],[tr,px+8,0],[bl,px,8],[br,px+8,8]]) {
      const img = rctx.createImageData(8, 8);
      const pix = tiles[tIdx];
      for (let p = 0; p < 64; p++) {
        const ci = pix[p];
        if (ci === 0) { img.data[p * 4 + 3] = 0; continue; }
        const rgb = NES_SYSTEM_PALETTE[pal[ci]] || [0, 0, 0];
        img.data[p*4]=rgb[0]; img.data[p*4+1]=rgb[1]; img.data[p*4+2]=rgb[2]; img.data[p*4+3]=255;
      }
      rctx.putImageData(img, sx, sy);
    }
  }
  return c;
}

function _buildOceanPalettes(romData, bgId) {
  const skyPal = _loadBattlePalette(romData, bgId);
  const wPalOff = 0x001650 + TITLE_WATER_PAL_IDX * 4;
  const wavePal = [0x0F, romData[wPalOff], romData[wPalOff + 2], romData[wPalOff + 3]];
  return { skyPal, wavePal };
}
function _loadOceanTileData(romData, bgId) {
  const tileBase = BATTLE_BG_TILES_ROM + bgId * 0x100;
  const tiles = [];
  for (let i = 0; i < 16; i++) tiles.push(decodeTile(romData, tileBase + i * 16));
  const metaTiles = _loadBattleMetaTiles(romData);
  const tilemap = _loadBattleTilemap(romData, bgId);
  return { tiles, metaTiles, tilemap };
}
function _buildTitleOceanFrames(tiles, metaTiles, tilemap, skyPal, wavePal) {
  titleOceanFrames = [];
  const fadeSky = [...skyPal], fadeWave = [...wavePal];
  while (true) {
    const frame = document.createElement('canvas');
    frame.width = 256; frame.height = 32;
    const fctx = frame.getContext('2d');
    const skyBg = NES_SYSTEM_PALETTE[fadeSky[1]] || [0,0,0];
    fctx.fillStyle = `rgb(${skyBg[0]},${skyBg[1]},${skyBg[2]})`;
    fctx.fillRect(0, 0, 256, 16);
    fctx.drawImage(_renderOceanRow(tiles, metaTiles, tilemap, fadeSky, 0), 0, 0);
    const waveBg = NES_SYSTEM_PALETTE[fadeWave[1]] || [0,0,0];
    fctx.fillStyle = `rgb(${waveBg[0]},${waveBg[1]},${waveBg[2]})`;
    fctx.fillRect(0, 16, 256, 16);
    fctx.drawImage(_renderOceanRow(tiles, metaTiles, tilemap, fadeWave, 1), 0, 16);
    titleOceanFrames.push(frame);
    if (fadeSky[1] === 0x0F && fadeSky[2] === 0x0F && fadeSky[3] === 0x0F &&
        fadeWave[1] === 0x0F && fadeWave[2] === 0x0F && fadeWave[3] === 0x0F) break;
    for (let i = 1; i <= 3; i++) { fadeSky[i] = nesColorFade(fadeSky[i]); fadeWave[i] = nesColorFade(fadeWave[i]); }
  }
}
function initTitleOcean(romData) {
  const bgId = 5;
  const { skyPal, wavePal } = _buildOceanPalettes(romData, bgId);
  const { tiles, metaTiles, tilemap } = _loadOceanTileData(romData, bgId);
  _buildTitleOceanFrames(tiles, metaTiles, tilemap, skyPal, wavePal);
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

export function getMobileInputMode() {
  if (chatInputActive) return 'chat';
  if (titleState === 'name-entry') return 'name';
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
}
function _initTitleAssets(romRaw) {
  initInvincibleSprite(romRaw);
  initTitleWater(romRaw);
  initTitleSky(romRaw);
  initTitleUnderwater(romRaw);
  initUnderwaterSprites(romRaw);
  initTitleOcean(romRaw);
  initTitleLogo();
}
function _startDebugMode() {
  titleState = 'done';
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
  titleState = 'credit-wait';
  titleTimer = 0;
  titleWaterScroll = 0;
  titleShipTimer = 0;
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
  _waterCache = null;
  _initTitleAssets(romRaw);

  await loadSlotsFromDB();

  if (window.DEBUG_BOSS) { _startDebugMode(); return; }
  _startTitleScreen();
}

export function loadFF12ROM(arrayBuffer) {
  ff12Raw = new Uint8Array(arrayBuffer);
  initAdamantoise(ff12Raw);
  initFF1Music(ff12Raw);
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
  mapRenderer = new MapRenderer(mapData, playerX, playerY); _indoorWaterCache = null;
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
  mapRenderer = new MapRenderer(mapData, playerX, playerY); _indoorWaterCache = null;
  if (mapRenderer.hasRoomClip()) {
    const spawnMid = mapData.tilemap[playerY * 32 + playerX];
    disabledTrigger = (spawnMid === 0x44 || playerY !== ey) ? { x: playerX, y: playerY } : null;
  } else { disabledTrigger = null; }
  _rebuildFlameSprites();
  moving = false; sprite.setDirection(DIR_DOWN); sprite.resetFrame();
  if (returnX !== undefined) _openReturnDoor(playerX, playerY);
  if (mapId === 114) playTrack(TRACKS.TOWN_UR);
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

function _battleTargetNav() {
  if (!isRandomEncounter || !encounterMonsters) return;
  const aliveIdx = encounterMonsters.reduce((a, m, i) => (m.hp > 0 ? [...a, i] : a), []);
  if (keys['ArrowRight'] || keys['ArrowDown']) {
    keys['ArrowRight'] = false; keys['ArrowDown'] = false;
    targetIndex = aliveIdx[(aliveIdx.indexOf(targetIndex) + 1) % aliveIdx.length];
    playSFX(SFX.CURSOR);
  }
  if (keys['ArrowLeft'] || keys['ArrowUp']) {
    keys['ArrowLeft'] = false; keys['ArrowUp'] = false;
    targetIndex = aliveIdx[(aliveIdx.indexOf(targetIndex) - 1 + aliveIdx.length) % aliveIdx.length];
    playSFX(SFX.CURSOR);
  }
}
function _battleTargetConfirm() {
  if (!keys['z'] && !keys['Z']) return;
  keys['z'] = false; keys['Z'] = false;
  playSFX(SFX.CONFIRM);
  const rIsWeapon = isWeapon(playerWeaponR);
  const lIsWeapon = isWeapon(playerWeaponL);
  const dualWield = rIsWeapon && lIsWeapon;
  const unarmed = !rIsWeapon && !lIsWeapon;
  const baseHits = Math.max(1, Math.floor((playerStats ? playerStats.agi : 5) / 10));
  const potentialHits = (dualWield || unarmed) ? Math.max(2, baseHits) : Math.max(1, baseHits);
  const wpn = (rIsWeapon ? ITEMS.get(playerWeaponR) : null) || (lIsWeapon ? ITEMS.get(playerWeaponL) : null);
  const hitRate = wpn ? wpn.hit : BASE_HIT_RATE;
  if (isRandomEncounter && encounterMonsters) {
    hitResults = rollHits(playerATK, encounterMonsters[targetIndex].def, hitRate, potentialHits);
  } else {
    const targetDef = isPVPBattle && pvpOpponentStats ? pvpOpponentStats.def : BOSS_DEF;
    hitResults = rollHits(playerATK, targetDef, hitRate, potentialHits);
  }
  const firstHandR = isWeapon(playerWeaponR) || !isWeapon(playerWeaponL);
  const firstWpnId = firstHandR ? playerWeaponR : playerWeaponL;
  const pendingSlashFrames = getSlashFramesForWeapon(firstWpnId, firstHandR);
  const centerX = HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2);
  const centerY = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2);
  const firstWeapon0 = getHitWeapon(0);
  const pendingOffX = isBladedWeapon(firstWeapon0) ? 8 : Math.floor(Math.random() * 40) - 20;
  const pendingOffY = isBladedWeapon(firstWeapon0) ? -8 : Math.floor(Math.random() * 40) - 20;
  playerActionPending = {
    command: 'fight', targetIndex, hitResults,
    slashFrames: pendingSlashFrames, slashOffX: pendingOffX, slashOffY: pendingOffY,
    slashX: centerX, slashY: centerY
  };
  battleState = 'confirm-pause';
  battleTimer = 0;
}
function _battleInputTargetSelect() {
  _battleTargetNav();
  _battleTargetConfirm();
  if (_xPressed()) {
    playSFX(SFX.CONFIRM);
    battleState = 'menu-open';
    battleTimer = 0;
  }
}

function _itemSelectNav(isEquipPage, totalPages, pageRows) {
  if (keys['ArrowDown']) {
    keys['ArrowDown'] = false;
    if (itemPageCursor < pageRows - 1) itemPageCursor++;
    else if (itemPage < totalPages - 1) { itemSlideDir = -1; itemSlideCursor = 0; battleState = 'item-slide'; battleTimer = 0; }
    playSFX(SFX.CURSOR);
  }
  if (keys['ArrowUp']) {
    keys['ArrowUp'] = false;
    if (itemPageCursor > 0) itemPageCursor--;
    else if (itemPage > 0) { itemSlideDir = 1; itemSlideCursor = (itemPage - 1) === 0 ? 1 : INV_SLOTS - 1; battleState = 'item-slide'; battleTimer = 0; }
    playSFX(SFX.CURSOR);
  }
  if (keys['ArrowLeft'] && itemPage > 0) {
    keys['ArrowLeft'] = false; playSFX(SFX.CURSOR);
    itemSlideDir = 1; itemSlideCursor = 0; battleState = 'item-slide'; battleTimer = 0;
  }
  if (keys['ArrowRight'] && itemPage < totalPages - 1) {
    keys['ArrowRight'] = false; playSFX(SFX.CURSOR);
    itemSlideDir = -1; itemSlideCursor = 0; battleState = 'item-slide'; battleTimer = 0;
  }
}

function _itemSelectSwap(isEquipPage, gIdx) {
  const srcEquip = itemHeldIdx <= -100;
  const dstEquip = isEquipPage;
  const _atk = () => { playerATK = playerStats.str + (ITEMS.get(playerWeaponR)?.atk || 0) + (ITEMS.get(playerWeaponL)?.atk || 0); };
  if (!srcEquip && !dstEquip) {
    // Inv → Inv swap
    const dstIdx = (itemPage - 1) * INV_SLOTS + itemPageCursor;
    const tmp = itemSelectList[itemHeldIdx];
    itemSelectList[itemHeldIdx] = itemSelectList[dstIdx];
    itemSelectList[dstIdx] = tmp;
    itemHeldIdx = -1; playSFX(SFX.CONFIRM);
  } else if (!srcEquip && dstEquip) {
    // Inv → Equip
    const item = itemSelectList[itemHeldIdx];
    const handIdx = itemPageCursor;
    if (item && isHandEquippable(ITEMS.get(item.id))) {
      const oldWeapon = handIdx === 0 ? playerWeaponR : playerWeaponL;
      if (handIdx === 0) playerWeaponR = item.id; else playerWeaponL = item.id;
      removeItem(item.id);
      if (oldWeapon !== 0) addItem(oldWeapon, 1);
      itemSelectList[itemHeldIdx] = oldWeapon !== 0 ? { id: oldWeapon, count: 1 } : null;
      _atk(); itemHeldIdx = -1; playSFX(SFX.CONFIRM);
    } else { playSFX(SFX.ERROR); itemHeldIdx = -1; }
  } else if (srcEquip && !dstEquip) {
    // Equip → Inv
    const srcHand = -(itemHeldIdx + 100);
    const handWeaponId = srcHand === 0 ? playerWeaponR : playerWeaponL;
    const dstIdx = (itemPage - 1) * INV_SLOTS + itemPageCursor;
    const invItem = itemSelectList[dstIdx];
    if (invItem && isHandEquippable(ITEMS.get(invItem.id))) {
      if (srcHand === 0) playerWeaponR = invItem.id; else playerWeaponL = invItem.id;
      removeItem(invItem.id); addItem(handWeaponId, 1);
      itemSelectList[dstIdx] = { id: handWeaponId, count: 1 };
      _atk(); itemHeldIdx = -1; playSFX(SFX.CONFIRM);
    } else if (!invItem) {
      if (srcHand === 0) playerWeaponR = 0; else playerWeaponL = 0;
      addItem(handWeaponId, 1);
      itemSelectList[dstIdx] = { id: handWeaponId, count: 1 };
      _atk(); itemHeldIdx = -1; playSFX(SFX.CONFIRM);
    } else { playSFX(SFX.ERROR); itemHeldIdx = -1; }
  } else {
    // Equip → Equip (swap hands)
    const tmp = playerWeaponR; playerWeaponR = playerWeaponL; playerWeaponL = tmp;
    _atk(); itemHeldIdx = -1; playSFX(SFX.CONFIRM);
  }
}

function _itemSelectZ(isEquipPage, gIdx) {
  if (itemHeldIdx === -1) {
    // Nothing held — pick up
    if (isEquipPage) {
      const weaponId = itemPageCursor === 0 ? playerWeaponR : playerWeaponL;
      if (weaponId !== 0) { itemHeldIdx = gIdx; playSFX(SFX.CONFIRM); } else playSFX(SFX.ERROR);
    } else {
      const invIdx = (itemPage - 1) * INV_SLOTS + itemPageCursor;
      if (itemSelectList[invIdx] !== null) { itemHeldIdx = gIdx; playSFX(SFX.CONFIRM); } else playSFX(SFX.ERROR);
    }
  } else if (itemHeldIdx === gIdx) {
    // Same slot — use consumable or deselect
    if (!isEquipPage) {
      const invIdx = (itemPage - 1) * INV_SLOTS + itemPageCursor;
      const item = itemSelectList[invIdx];
      const itemDat = ITEMS.get(item.id);
      if (itemDat?.type === 'consumable' || itemDat?.type === 'battle_item') {
        playSFX(SFX.CONFIRM); itemHeldIdx = -1; itemTargetMode = 'single';
        if (itemDat.type === 'battle_item' && isRandomEncounter && encounterMonsters) {
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
        itemTargetAllyIndex = -1; battleState = 'item-target-select'; battleTimer = 0;
        playerActionPending = { command: 'item', itemId: item.id };
      } else { itemHeldIdx = -1; playSFX(SFX.CONFIRM); }
    } else { itemHeldIdx = -1; playSFX(SFX.CONFIRM); }
  } else {
    _itemSelectSwap(isEquipPage, gIdx);
  }
}

function _battleInputItemSelect() {
  const isEquipPage = itemPage === 0;
  const pageRows = isEquipPage ? 2 : INV_SLOTS;
  const totalPages = 1 + Math.max(1, Math.ceil(itemSelectList.length / INV_SLOTS));
  _itemSelectNav(isEquipPage, totalPages, pageRows);
  if (_zPressed()) {
    const gIdx = isEquipPage ? -100 - itemPageCursor : (itemPage - 1) * INV_SLOTS + itemPageCursor;
    _itemSelectZ(isEquipPage, gIdx);
  }
  if (_xPressed()) {
    if (itemHeldIdx !== -1) { itemHeldIdx = -1; playSFX(SFX.CONFIRM); }
    else { playSFX(SFX.CONFIRM); battleState = 'item-cancel-out'; battleTimer = 0; }
  }
}

function _battleInputItemTargetSelect() {
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
  if (_zPressed()) {
    playerActionPending.target = itemTargetType === 'player' ? 'player' : itemTargetIndex;
    playerActionPending.allyIndex = itemTargetType === 'player' ? itemTargetAllyIndex : -1;
    playerActionPending.targetMode = itemTargetMode;
    playSFX(SFX.CONFIRM);
    battleState = 'item-list-out';
    battleTimer = 0;
  }
  if (_xPressed()) {
    playerActionPending = null;
    playSFX(SFX.CONFIRM);
    battleState = 'item-select';
    battleTimer = 0;
  }
}

function _battleInputHoldStates() {
  const z = keys['z'] || keys['Z'];
  const clearZ = () => { keys['z'] = false; keys['Z'] = false; };
  if (battleState === 'roar-hold') {
    if (msgBoxState === 'hold' && z) { clearZ(); msgBoxState = 'slide-out'; msgBoxTimer = 0; }
  } else if (battleState === 'defeat-text') {
    if (z) { clearZ(); battleState = 'defeat-close'; battleTimer = 0; }
  } else if (battleState === 'victory-hold') {
    if (z) { clearZ(); battleState = 'victory-fade-out'; battleTimer = 0; }
  } else if (battleState === 'exp-hold') {
    if (z) { clearZ(); battleState = 'exp-fade-out'; battleTimer = 0; }
  } else if (battleState === 'gil-hold') {
    if (z) { clearZ(); battleState = (leveledUp || encounterDropItem !== null) ? 'gil-fade-out' : 'victory-text-out'; battleTimer = 0; }
  } else if (battleState === 'item-hold') {
    if (z) { clearZ(); battleState = leveledUp ? 'item-fade-out' : 'victory-text-out'; battleTimer = 0; }
  } else if (battleState === 'levelup-hold') {
    if (z) { clearZ(); battleState = 'victory-text-out'; battleTimer = 0; }
  } else { return false; }
  return true;
}

function _handleBattleInput() {
  if (battleState === 'none') return false;
  if (_battleInputHoldStates()) return true;
  if (battleState === 'menu-open') {
    if (keys['ArrowDown'])  { keys['ArrowDown'] = false;  battleCursor ^= 2; playSFX(SFX.CURSOR); }
    if (keys['ArrowUp'])    { keys['ArrowUp'] = false;    battleCursor ^= 2; playSFX(SFX.CURSOR); }
    if (keys['ArrowRight']) { keys['ArrowRight'] = false; battleCursor ^= 1; playSFX(SFX.CURSOR); }
    if (keys['ArrowLeft'])  { keys['ArrowLeft'] = false;  battleCursor ^= 1; playSFX(SFX.CURSOR); }
    if (keys['z'] || keys['Z']) { keys['z'] = false; keys['Z'] = false; executeBattleCommand(battleCursor); }
  } else if (battleState === 'target-select') { _battleInputTargetSelect();
  } else if (battleState === 'item-select') { _battleInputItemSelect();
  } else if (battleState === 'item-target-select') { _battleInputItemTargetSelect();
  }
  return true;
}

function _rosterInputBrowse() {
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
  if (_zPressed()) {
    rosterState = 'menu-in';
    rosterMenuTimer = 0;
    rosterMenuCursor = 0;
    playSFX(SFX.CONFIRM);
  }
  if (_xPressed()) {
    rosterState = 'none';
    playSFX(SFX.CONFIRM);
  }
}

function _rosterMenuDuelAction(target) {
  const challenged = _nameToBytes('Challenged ');
  const nameBytes = _nameToBytes(target.name);
  const exclam = new Uint8Array([0xC4]);
  const challengeMsg = new Uint8Array(challenged.length + nameBytes.length + 1);
  challengeMsg.set(challenged, 0); challengeMsg.set(nameBytes, challenged.length); challengeMsg.set(exclam, challenged.length + nameBytes.length);
  showMsgBox(challengeMsg, () => {
    setTimeout(() => showMsgBox(_nameToBytes(target.name + ' accepted!'), () => startPVPBattle(target)),
      1500 + Math.floor(Math.random() * 2500));
  });
}

function _rosterInputMenu() {
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
  if (_zPressed()) {
    const action = ROSTER_MENU_ITEMS[rosterMenuCursor];
    const target = getRosterVisible()[rosterCursor];
    rosterState = 'menu-out';
    rosterMenuTimer = 0;
    playSFX(SFX.CONFIRM);
    if (action === 'Duel' && (onWorldMap || dungeonFloor >= 0)) {
      _rosterMenuDuelAction(target);
    } else {
      const actionBytes = _nameToBytes(action), nameBytes = _nameToBytes(target.name);
      const sep = new Uint8Array([0xFF]);
      const msg = new Uint8Array(actionBytes.length + 1 + nameBytes.length);
      msg.set(actionBytes, 0); msg.set(sep, actionBytes.length); msg.set(nameBytes, actionBytes.length + 1);
      showMsgBox(msg);
    }
  }
  if (_xPressed()) {
    rosterState = 'menu-out';
    rosterMenuTimer = 0;
    playSFX(SFX.CONFIRM);
  }
}

function _handleRosterInput() {
  // S — toggle roster browse
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
    return true;
  }
  if (rosterState === 'browse') { _rosterInputBrowse(); return true; }
  if (rosterState === 'menu')   { _rosterInputMenu();   return true; }
  if ((rosterState === 'menu-in' || rosterState === 'menu-out') && msgBoxState === 'none') return true;
  return false;
}

function _pauseInputOpenClose() {
  if (keys['Enter']) {
    keys['Enter'] = false;
    if (pauseState === 'none' && battleState === 'none' && transState === 'none' && !shakeActive && !starEffect && !moving && msgBoxState === 'none') {
      playSFX(SFX.CONFIRM);
      pauseMusic();
      playFF1Track(FF1_TRACKS.MENU_SCREEN);
      pauseState = 'scroll-in'; pauseTimer = 0; pauseCursor = 0;
    }
    return true;
  }
  if (keys['x'] || keys['X']) {
    if (pauseState === 'open') {
      keys['x'] = false; keys['X'] = false;
      playSFX(SFX.CONFIRM);
      pauseState = 'text-out'; pauseTimer = 0;
      return true;
    }
  }
  return false;
}
function _pauseInputMainMenu() {
  if (pauseState !== 'open') return false;
  if (keys['ArrowDown']) { keys['ArrowDown'] = false; pauseCursor = (pauseCursor + 1) % 6; playSFX(SFX.CURSOR); }
  if (keys['ArrowUp'])   { keys['ArrowUp'] = false;   pauseCursor = (pauseCursor + 5) % 6; playSFX(SFX.CURSOR); }
  if (_zPressed()) {
    if (pauseCursor === 0) {
      playSFX(SFX.CONFIRM);
      pauseState = 'inv-text-out'; pauseTimer = 0; pauseInvScroll = 0;
    } else if (pauseCursor === 2) {
      playSFX(SFX.CONFIRM);
      pauseState = 'eq-text-out'; pauseTimer = 0; eqCursor = 0;
    }
  }
  return true;
}
function _pauseInvZPress(entries) {
  if (pauseHeldItem === -1) {
    if (entries.length > 0 && entries[pauseInvScroll]) { pauseHeldItem = pauseInvScroll; playSFX(SFX.CONFIRM); }
    else playSFX(SFX.ERROR);
  } else if (pauseHeldItem === pauseInvScroll) {
    const [id] = entries[pauseHeldItem]; const item = ITEMS.get(Number(id));
    if (item && item.type === 'consumable') {
      playSFX(SFX.CONFIRM); pauseHeldItem = -1;
      pauseState = 'inv-target'; pauseTimer = 0; pauseUseItemId = Number(id); pauseInvAllyTarget = -1;
    } else { pauseHeldItem = -1; playSFX(SFX.CONFIRM); }
  } else {
    if (entries[pauseInvScroll]) { pauseHeldItem = pauseInvScroll; playSFX(SFX.CONFIRM); }
    else { pauseHeldItem = -1; playSFX(SFX.ERROR); }
  }
}

function _pauseInputInventory() {
  if (pauseState !== 'inventory') return false;
  const entries = Object.entries(playerInventory).filter(([,c]) => c > 0);
  if (keys['ArrowDown']) {
    keys['ArrowDown'] = false;
    if (pauseInvScroll < entries.length - 1) { pauseInvScroll++; playSFX(SFX.CURSOR); }
  }
  if (keys['ArrowUp']) {
    keys['ArrowUp'] = false;
    if (pauseInvScroll > 0) { pauseInvScroll--; playSFX(SFX.CURSOR); }
  }
  if (keys['z'] || keys['Z']) { keys['z'] = false; keys['Z'] = false; _pauseInvZPress(entries); }
  if (_xPressed()) {
    if (pauseHeldItem !== -1) { pauseHeldItem = -1; playSFX(SFX.CONFIRM); }
    else { playSFX(SFX.CONFIRM); pauseState = 'inv-items-out'; pauseTimer = 0; }
  }
  return true;
}
function _applyPauseItemUse(item, rosterTargets) {
  if (!item || item.effect !== 'restore_hp') { playSFX(SFX.ERROR); return; }
  if (pauseInvAllyTarget >= 0) {
    const rp = rosterTargets[pauseInvAllyTarget];
    if (!rp) { playSFX(SFX.ERROR); return; }
    const heal = Math.min(item.value, rp.maxHP - rp.hp);
    rp.hp += heal; removeItem(pauseUseItemId); playSFX(SFX.CURE);
    pauseHealNum = { value: heal, timer: 0, rosterIdx: pauseInvAllyTarget };
    pauseState = 'inv-heal'; pauseTimer = 0;
    if (selectCursor >= 0 && saveSlots[selectCursor]) { saveSlots[selectCursor].inventory = { ...playerInventory }; saveSlotsToDB(); }
  } else {
    const heal = Math.min(item.value, playerStats.maxHP - playerHP);
    playerHP += heal; removeItem(pauseUseItemId); playSFX(SFX.CURE);
    pauseHealNum = { value: heal, timer: 0 };
    pauseState = 'inv-heal'; pauseTimer = 0;
    if (selectCursor >= 0 && saveSlots[selectCursor]) { saveSlots[selectCursor].hp = playerHP; saveSlots[selectCursor].inventory = { ...playerInventory }; saveSlotsToDB(); }
  }
}

function _pauseInputInvTarget() {
  if (pauseState !== 'inv-target') return false;
  const rosterTargets = getRosterVisible();
  if (keys['ArrowDown']) {
    keys['ArrowDown'] = false;
    if (pauseInvAllyTarget < rosterTargets.length - 1) { pauseInvAllyTarget++; playSFX(SFX.CURSOR); }
  }
  if (keys['ArrowUp']) {
    keys['ArrowUp'] = false;
    if (pauseInvAllyTarget > -1) { pauseInvAllyTarget--; playSFX(SFX.CURSOR); }
  }
  if (_zPressed()) {
    _applyPauseItemUse(ITEMS.get(pauseUseItemId), rosterTargets);
  }
  if (_xPressed()) {
    pauseState = 'inventory'; pauseTimer = 0;
    pauseHeldItem = -1;
    playSFX(SFX.CONFIRM);
  }
  return true;
}
function _equipBestMainSlots() {
  const SLOT_DEFS = [
    { eq: -100, type: 'hand', stat: 'atk' },
    { eq: -102, type: 'armor', subtype: 'helmet', stat: 'def' },
    { eq: -103, type: 'armor', subtype: 'body',   stat: 'def' },
    { eq: -104, type: 'armor', subtype: 'arms',   stat: 'def' },
  ];
  for (const sd of SLOT_DEFS) {
    const curId = getEquipSlotId(sd.eq); const curItem = ITEMS.get(curId);
    let bestId = curId, bestVal = curItem ? (curItem[sd.stat] || 0) : 0;
    for (const [idStr, count] of Object.entries(playerInventory)) {
      if (count <= 0) continue;
      const id = Number(idStr); const item = ITEMS.get(id); if (!item) continue;
      if (sd.type === 'hand' && !isHandEquippable(item)) continue;
      if (sd.type === 'armor' && (item.type !== 'armor' || item.subtype !== sd.subtype)) continue;
      const val = item[sd.stat] || 0; if (val > bestVal) { bestVal = val; bestId = id; }
    }
    if (bestId !== curId) {
      if (curId !== 0) addItem(curId, 1);
      if (bestId !== 0) { setEquipSlotId(sd.eq, bestId); removeItem(bestId); } else setEquipSlotId(sd.eq, 0);
    }
  }
}

function _equipBestLeftHand() {
  const curId = getEquipSlotId(-101); const curItem = ITEMS.get(curId);
  let bestWepId = 0, bestWepAtk = 0, bestShieldId = 0, bestShieldDef = 0;
  if (curItem?.type === 'weapon') { bestWepAtk = curItem.atk || 0; bestWepId = curId; }
  else if (curItem?.subtype === 'shield') { bestShieldDef = curItem.def || 0; bestShieldId = curId; }
  for (const [idStr, count] of Object.entries(playerInventory)) {
    if (count <= 0) continue;
    const id = Number(idStr); const item = ITEMS.get(id);
    if (!item || !isHandEquippable(item)) continue;
    if (item.type === 'weapon') { const v = item.atk || 0; if (v > bestWepAtk) { bestWepAtk = v; bestWepId = id; } }
    else if (item.subtype === 'shield') { const v = item.def || 0; if (v > bestShieldDef) { bestShieldDef = v; bestShieldId = id; } }
  }
  const bestId = bestShieldId !== 0 ? bestShieldId : bestWepId;
  if (bestId !== curId) {
    if (curId !== 0) addItem(curId, 1);
    if (bestId !== 0) { setEquipSlotId(-101, bestId); removeItem(bestId); } else setEquipSlotId(-101, 0);
  }
}

function _equipOptimum() {
  _equipBestMainSlots();
  _equipBestLeftHand();
  playerATK = playerStats.str + (ITEMS.get(playerWeaponR)?.atk || 0) + (ITEMS.get(playerWeaponL)?.atk || 0);
  recalcDEF();
  if (selectCursor >= 0 && saveSlots[selectCursor]) { saveSlots[selectCursor].inventory = { ...playerInventory }; saveSlotsToDB(); }
  playSFX(SFX.CONFIRM);
}

function _pauseInputEquip() {
  if (pauseState !== 'equip') return false;
  if (keys['ArrowDown']) { keys['ArrowDown'] = false; eqCursor = (eqCursor + 1) % 6; playSFX(SFX.CURSOR); }
  if (keys['ArrowUp'])   { keys['ArrowUp'] = false;   eqCursor = (eqCursor + 5) % 6; playSFX(SFX.CURSOR); }
  if (_zPressed()) {
    if (eqCursor === 5) {
      _equipOptimum();
    } else {
      playSFX(SFX.CONFIRM);
      eqSlotIdx = -100 - eqCursor;
      const isWeaponSlot = eqSlotIdx >= -101;
      const slotSubtype = EQUIP_SLOT_SUBTYPE[String(eqSlotIdx)];
      eqItemList = [];
      const currentId = getEquipSlotId(eqSlotIdx);
      if (currentId !== 0) eqItemList.push({ id: 0, label: 'remove' });
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
  if (_xPressed()) {
    playSFX(SFX.CONFIRM);
    pauseState = 'eq-slots-out'; pauseTimer = 0;
  }
  return true;
}
function _pauseInputEquipItemSelect() {
  if (pauseState !== 'eq-item-select') return false;
  if (keys['ArrowDown']) { keys['ArrowDown'] = false; if (eqItemCursor < eqItemList.length - 1) { eqItemCursor++; playSFX(SFX.CURSOR); } }
  if (keys['ArrowUp'])   { keys['ArrowUp'] = false;   if (eqItemCursor > 0) { eqItemCursor--; playSFX(SFX.CURSOR); } }
  if (_zPressed()) {
    const pick = eqItemList[eqItemCursor];
    if (pick) {
      const oldId = getEquipSlotId(eqSlotIdx);
      if (pick.label === 'remove') {
        setEquipSlotId(eqSlotIdx, 0);
        if (oldId !== 0) addItem(oldId, 1);
      } else {
        setEquipSlotId(eqSlotIdx, pick.id);
        removeItem(pick.id);
        if (oldId !== 0) addItem(oldId, 1);
      }
      playerATK = playerStats.str + (ITEMS.get(playerWeaponR)?.atk || 0) + (ITEMS.get(playerWeaponL)?.atk || 0);
      recalcDEF();
      if (selectCursor >= 0 && saveSlots[selectCursor]) {
        saveSlots[selectCursor].inventory = { ...playerInventory };
        saveSlotsToDB();
      }
      playSFX(SFX.CONFIRM);
    }
    pauseState = 'eq-items-out'; pauseTimer = 0;
  }
  if (_xPressed()) {
    playSFX(SFX.CONFIRM);
    pauseState = 'eq-items-out'; pauseTimer = 0;
  }
  return true;
}
function _handlePauseInput() {
  if (_pauseInputOpenClose()) return true;
  if (_pauseInputMainMenu()) return true;
  if (_pauseInputInventory()) return true;
  if (_pauseInputInvTarget()) return true;
  if (pauseState === 'inv-heal') return true;
  if (pauseState.startsWith('inv-')) return true;
  if (_pauseInputEquip()) return true;
  if (_pauseInputEquipItemSelect()) return true;
  if (pauseState.startsWith('eq-')) return true;
  if (pauseState !== 'none') return true;
  return false;
}


function handleInput() {
  if (!sprite) return;
  if (_handleBattleInput()) return;
  if (_handleRosterInput()) return;
  if (_handlePauseInput()) return;

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

  if (facedTile === 0x7C)                                         { _handleChest(facedX, facedY); return; }
  if (secretWalls && secretWalls.has(`${facedX},${facedY}`))      { _handleSecretWall(facedX, facedY); return; }
  if (rockSwitch && rockSwitch.rocks.some(r => facedX === r.x && facedY === r.y)) { _handleRockPuzzle(); return; }
  if (pondTiles && pondTiles.has(`${facedX},${facedY}`))          { _handlePondHeal(); return; }
}

function _handleChest(facedX, facedY) {
  mapData.tilemap[facedY * 32 + facedX] = 0x7D;
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
  msg.set(found, 0); msg.set(itemName, found.length);
  msg[found.length + itemName.length] = 0xC4; // "!"
  showMsgBox(msg);
  mapRenderer = new MapRenderer(mapData, worldX / TILE_SIZE, worldY / TILE_SIZE); _indoorWaterCache = null;
}

function _handleSecretWall(facedX, facedY) {
  mapData.tilemap[facedY * 32 + facedX] = 0x30;
  secretWalls.delete(`${facedX},${facedY}`);
  mapRenderer = new MapRenderer(mapData, worldX / TILE_SIZE, worldY / TILE_SIZE); _indoorWaterCache = null;
}

function _handleRockPuzzle() {
  playSFX(SFX.EARTHQUAKE);
  shakeActive = true; shakeTimer = 0;
  shakePendingAction = () => {
    playSFX(SFX.DOOR);
    for (const wt of rockSwitch.wallTiles) mapData.tilemap[wt.y * 32 + wt.x] = wt.newTile;
    rockSwitch = null;
    mapRenderer = new MapRenderer(mapData, worldX / TILE_SIZE, worldY / TILE_SIZE); _indoorWaterCache = null;
  };
}

function _handlePondHeal() {
  playSFX(SFX.POND_DRINK);
  starEffect = {
    frame: 0, radius: 60, angle: 0, spin: false,
    onComplete: () => {
      playSFX(SFX.CURE);
      playerHP = playerStats.maxHP;
      playerMP = playerStats.maxMP;
      pondStrobeTimer = BATTLE_FLASH_FRAMES * BATTLE_FLASH_FRAME_MS;
      setTimeout(() => showMsgBox(POND_RESTORED, null), BATTLE_FLASH_FRAMES * BATTLE_FLASH_FRAME_MS);
    }
  };
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
  startWipeTransition(() => {
    worldX = dest.destX * TILE_SIZE;
    worldY = dest.destY * TILE_SIZE;
    sprite.setDirection(DIR_DOWN);
    mapRenderer = new MapRenderer(mapData, dest.destX, dest.destY); _indoorWaterCache = null;
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
  if (checkTrigger()) return;

  if (_tickRandomEncounter()) return;

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

function _updateTransitionClosing() {
  if (transTimer < WIPE_DURATION) return;
  if (trapFallPending) {
    trapFallPending = false;
    transState = 'trap-falling'; transTimer = 0;
    playSFX(SFX.FALL);
  } else {
    transState = 'hold'; transTimer = 0;
    if (!transDungeon && transPendingAction) { transPendingAction(); transPendingAction = null; }
  }
}

function _updateTransitionHold() {
  if (transTimer < WIPE_HOLD) return;
  if (transDungeon) {
    transState = 'loading'; transTimer = 0;
    loadingFadeState = 'in'; loadingFadeTimer = 0; loadingBgScroll = 0;
    playTrack(TRACKS.PIANO_3);
    if (transPendingAction) { transPendingAction(); transPendingAction = null; }
    if (topBoxNameBytes) {
      topBoxScrollState = 'fade-in'; topBoxScrollTimer = 0; topBoxFadeStep = TOPBOX_FADE_STEPS;
    }
  } else {
    transState = 'opening'; transTimer = 0;
    playSFX(SFX.SCREEN_OPEN);
    if (topBoxScrollState === 'pending') {
      topBoxScrollState = 'fade-in'; topBoxScrollTimer = 0; topBoxFadeStep = TOPBOX_FADE_STEPS;
    }
  }
}

function _updateTransitionLoading(dt) {
  loadingFadeTimer += dt;
  loadingBgScroll += dt * 0.08;
  if (loadingFadeState === 'in') {
    if (loadingFadeTimer >= (LOAD_FADE_MAX + 1) * LOAD_FADE_STEP_MS) {
      loadingFadeState = 'visible'; loadingFadeTimer = 0;
    }
  } else if (loadingFadeState === 'out') {
    if (loadingFadeTimer >= (LOAD_FADE_MAX + 1) * LOAD_FADE_STEP_MS) {
      loadingFadeState = 'none'; transState = 'opening'; transTimer = 0;
      transDungeon = false; playSFX(SFX.SCREEN_OPEN); playTrack(TRACKS.CRYSTAL_CAVE);
    }
  }
  if (loadingFadeState === 'visible' && (keys['z'] || keys['Z'])) {
    keys['z'] = false; keys['Z'] = false;
    loadingFadeState = 'out'; loadingFadeTimer = 0;
    if (topBoxScrollState !== 'none' && topBoxScrollState !== 'fade-out') {
      topBoxScrollState = 'fade-out'; topBoxScrollTimer = 0; topBoxFadeStep = 0;
    }
  }
}

function _updateTransitionTrapFall() {
  const totalSpinTime = SPIN_INTERVAL * SPIN_DIRS.length * SPIN_CYCLES;
  sprite.setDirection(SPIN_DIRS[Math.floor(transTimer / SPIN_INTERVAL) % SPIN_DIRS.length]);
  if (transTimer >= totalSpinTime) {
    if (transPendingAction) { transPendingAction(); transPendingAction = null; }
    trapShakePending = true; transState = 'opening'; transTimer = 0; playSFX(SFX.SCREEN_OPEN);
  }
}

function _updateTransitionOpening() {
  if (transTimer >= WIPE_DURATION) {
    transState = 'none'; transTimer = 0; rosterLocChanged = false;
    if (trapShakePending) {
      trapShakePending = false; playSFX(SFX.EARTHQUAKE); shakeActive = true; shakeTimer = 0;
    }
  }
}

function updateTransition(dt) {
  if (transState === 'none') return;
  transTimer += dt;
  if (transState === 'hud-fade-in') {
    if (transTimer >= (HUD_INFO_FADE_STEPS + 1) * HUD_INFO_FADE_STEP_MS) { transState = 'opening'; transTimer = 0; playSFX(SFX.SCREEN_OPEN); }
    return;
  } else if (transState === 'trap-reveal') {
    if (transTimer >= TRAP_REVEAL_DURATION) { transState = 'closing'; transTimer = 0; playSFX(SFX.SCREEN_CLOSE); }
  } else if (transState === 'trap-falling') { _updateTransitionTrapFall();
  } else if (transState === 'door-opening') {
    if (transTimer >= DOOR_OPEN_DURATION) { transState = 'closing'; transTimer = 0; playSFX(SFX.SCREEN_CLOSE); }
  } else if (transState === 'closing') { _updateTransitionClosing();
  } else if (transState === 'hold') { _updateTransitionHold();
  } else if (transState === 'loading') { _updateTransitionLoading(dt);
  } else if (transState === 'opening') { _updateTransitionOpening();
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

  if (transState === 'loading') _drawLoadingOverlay();
}

// Loading screen NES-encoded text constants
const _LOADING_BYTES = new Uint8Array([0x95,0xD8,0xCA,0xCD,0xD2,0xD7,0xD0,0xFF,0x8D,0xDE,0xD7,0xD0,0xCE,0xD8,0xD7]);
const _LOADED_BYTES  = new Uint8Array([0x8D,0xDE,0xD7,0xD0,0xCE,0xD8,0xD7,0xFF,0x95,0xD8,0xCA,0xCD,0xCE,0xCD]);
const _FLOORS_BYTES  = new Uint8Array([0x84,0xFF,0x95,0xCE,0xDF,0xCE,0xD5,0xDC]);
const _LODHP_BYTES   = new Uint8Array([0x91,0x99,0xFF,0xC5,0xC5,0xC5,0xC5,0xC5]);
function _drawLoadingBG(vpTop, fadeLevel) {
  if (!loadingBgFadeFrames || loadingBgFadeFrames.length === 0) return;
  const bgCanvas = loadingBgFadeFrames[Math.min(fadeLevel, loadingBgFadeFrames.length - 1)];
  const scrollX = Math.floor(loadingBgScroll) % 256;
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
  if (bossFadeFrames) ctx.drawImage(bossFadeFrames[fadeLevel][Math.floor(transTimer / 400) & 1], bossContentX, bossRowY);
  else if (adamantoiseFrames) ctx.drawImage(adamantoiseFrames[0], bossContentX, bossRowY);
  drawText(ctx, bossContentX + 20, bossRowY + 4, _LODHP_BYTES, fadedTextPal);
}
function _drawLoadingOverlay() {
  let fadeLevel = 0;
  if (loadingFadeState === 'in') fadeLevel = LOAD_FADE_MAX - Math.min(Math.floor(loadingFadeTimer / LOAD_FADE_STEP_MS), LOAD_FADE_MAX);
  else if (loadingFadeState === 'out') fadeLevel = Math.min(Math.floor(loadingFadeTimer / LOAD_FADE_STEP_MS), LOAD_FADE_MAX);
  else if (loadingFadeState !== 'visible') fadeLevel = LOAD_FADE_MAX;
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
  if (loadingFadeState === 'in') {
    drawText(ctx, cx - measureText(_LOADING_BYTES) / 2, vpBot - 32, _LOADING_BYTES, fadedTextPal);
  } else if (loadingFadeState === 'visible') {
    drawText(ctx, cx - measureText(_LOADED_BYTES) / 2, vpBot - 32, _LOADED_BYTES, fadedTextPal);
    if (Math.floor(transTimer / 500) % 2 === 0)
      drawText(ctx, cx - measureText(promptBytes) / 2, vpBot - 20, promptBytes, fadedTextPal);
  } else if (loadingFadeState === 'out') {
    drawText(ctx, cx - measureText(_LOADED_BYTES) / 2, vpBot - 32, _LOADED_BYTES, fadedTextPal);
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

function _checkWorldMapTrigger(tileX, tileY) {
  const trigger = worldMapRenderer.getTriggerAt(tileX, tileY);
  if (!trigger || trigger.type !== 'entrance') return false;
  let destMap = trigger.destMap;
  if (destMap === 0) return false;
  const savedX = tileX, savedY = tileY;
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

function _checkHiddenTrap(trigger, tileX, tileY) {
  if (!hiddenTraps || !hiddenTraps.has(`${tileX},${tileY}`)) return false;
  hiddenTraps.delete(`${tileX},${tileY}`);
  mapData.tilemap[tileY * 32 + tileX] = 0x74;
  mapRenderer = new MapRenderer(mapData, tileX, tileY); _indoorWaterCache = null;
  playSFX(SFX.DOOR);
  if (trigger.source === 'dynamic' && trigger.type === 1 &&
      dungeonDestinations && dungeonDestinations.has(trigger.trigId)) {
    const dest = dungeonDestinations.get(trigger.trigId);
    const savedX = worldX, savedY = worldY;
    transPendingAction = () => {
      mapStack.push({ mapId: currentMapId, x: savedX, y: savedY });
      loadMapById(dest.mapId);
    };
    rosterLocChanged = _rosterLocForMapId(dest.mapId) !== getPlayerLocation();
    transState = 'trap-reveal'; transTimer = 0;
    transDungeon = false; trapFallPending = true;
    return true;
  }
  return false;
}

function _triggerMapTransition(tileX, tileY, destMapId) {
  const tileId = mapData.tilemap[tileY * 32 + tileX];
  const tileM = tileId < 128 ? tileId : tileId & 0x7F;
  const savedX = worldX, savedY = worldY;
  if (((mapData.collisionByte2[tileM] >> 4) & 0x0F) === 5) {
    mapRenderer.updateTileAt(tileX, tileY, 0x7E); playSFX(SFX.DOOR);
    transState = 'door-opening'; transTimer = 0;
    rosterLocChanged = _rosterLocForMapId(destMapId) !== getPlayerLocation();
    transPendingAction = () => { mapStack.push({ mapId: currentMapId, x: savedX, y: savedY }); loadMapById(destMapId); };
  } else {
    startWipeTransition(() => { mapStack.push({ mapId: currentMapId, x: savedX, y: savedY }); loadMapById(destMapId); }, destMapId);
  }
}

function _checkDynType1(trigger, tileX, tileY) {
  if (!(trigger.source === 'dynamic' && trigger.type === 1)) return false;
  if (dungeonDestinations && dungeonDestinations.has(trigger.trigId)) {
    const dest = dungeonDestinations.get(trigger.trigId);
    if (dest.goBack) {
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
    _triggerMapTransition(tileX, tileY, dest.mapId);
    return true;
  }
  const destMap = mapData.entranceData[trigger.trigId];
  if (destMap === 0) return false;
  _triggerMapTransition(tileX, tileY, destMap);
  return true;
}

function _checkDynType4(trigger, tileX, tileY) {
  if (!(trigger.source === 'dynamic' && trigger.type === 4)) return false;
  if (!dungeonDestinations || !dungeonDestinations.has(trigger.trigId)) return false;
  const dest = dungeonDestinations.get(trigger.trigId);
  const savedX = worldX, savedY = worldY;
  startWipeTransition(() => {
    mapStack.push({ mapId: currentMapId, x: savedX, y: savedY });
    loadMapById(dest.mapId);
  }, dest.mapId);
  return true;
}

function _checkExitPrev() {
  const exitingCrystalRoom = currentMapId === 1004;
  const goingToWorld = mapStack.length === 0 || mapStack[mapStack.length - 1].mapId === 'world';
  if (goingToWorld && topBoxIsTown && topBoxNameBytes) {
    topBoxScrollState = 'fade-out'; topBoxScrollTimer = 0; topBoxFadeStep = 0;
  }
  const exitDestMapId = mapStack.length > 0 ? mapStack[mapStack.length - 1].mapId : 'world';
  startWipeTransition(() => {
    if (mapStack.length > 0) {
      const prev = mapStack.pop();
      if (prev.mapId === 'world') {
        loadWorldMapAtPosition(prev.x, prev.y);
      } else {
        loadMapById(prev.mapId, prev.x / TILE_SIZE, prev.y / TILE_SIZE);
        if (exitingCrystalRoom) playTrack(TRACKS.CRYSTAL_CAVE);
      }
    } else {
      loadWorldMapAt(findWorldExitIndex(currentMapId));
    }
  }, exitDestMapId);
  return true;
}

function checkTrigger() {
  const tileX = worldX / TILE_SIZE;
  const tileY = worldY / TILE_SIZE;
  if (disabledTrigger && tileX === disabledTrigger.x && tileY === disabledTrigger.y) return false;
  if (onWorldMap) return _checkWorldMapTrigger(tileX, tileY);
  if (!mapRenderer || !mapData) return false;
  const trigger = mapRenderer.getTriggerAt(tileX, tileY);
  if (!trigger) return false;
  if (_checkHiddenTrap(trigger, tileX, tileY)) return true;
  if (_checkDynType1(trigger, tileX, tileY)) return true;
  if (_checkDynType4(trigger, tileX, tileY)) return true;
  if ((trigger.source === 'collision' || trigger.source === 'entrance') && trigger.trigType === 0) {
    return _checkExitPrev();
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

function _buildWorldHorizWaterFrames(chrTiles, frames) {
  const HORIZ_PAIRS = [[0x22, 0x23], [0x24, 0x25]];
  for (const [ciL, ciR] of HORIZ_PAIRS) {
    const bL = chrTiles[ciL], bR = chrTiles[ciR];
    if (!bL || !bR || !_isWater(bL) || !_isWater(bR)) continue;
    const [arrL, arrR] = _buildHorizWaterPair(bL, bR);
    frames.set(ciL, arrL); frames.set(ciR, arrR);
  }
}

function _buildWorldVertWaterFrames(chrTiles, frames) {
  for (const ci of VERT_CHR) {
    const base = chrTiles[ci];
    if (!base || !_isWater(base)) continue;
    const p0 = _getPlane0(base), p1 = base.map(p => p & 2);
    const arr = [];
    for (let f = 0; f < 8; f++) {
      const rot = new Uint8Array(8);
      for (let r = 0; r < 8; r++) rot[r] = p0[((r - f) % 8 + 8) % 8];
      arr.push(_rebuild(rot, p1));
    }
    frames.set(ci, arr);
  }
}

function _findAnimatedMetatiles(metatiles) {
  const metas = [];
  for (let m = 0; m < 128; m++) {
    const mt = metatiles[m];
    if (ANIM_CHR.has(mt.tl) || ANIM_CHR.has(mt.tr) || ANIM_CHR.has(mt.bl) || ANIM_CHR.has(mt.br)) metas.push(m);
  }
  return metas;
}

function _buildWaterCache(wmr) {
  const { metatiles, chrTiles } = wmr.data;
  const frames = new Map();
  _buildWorldHorizWaterFrames(chrTiles, frames);
  _buildWorldVertWaterFrames(chrTiles, frames);
  return { frames, metas: _findAnimatedMetatiles(metatiles) };
}

function _writeTilePixels(td, tile, rgbPal) {
  for (let p = 0; p < 64; p++) {
    const rgb = rgbPal[tile[p]]; const di = p * 4;
    td[di]=rgb[0]; td[di+1]=rgb[1]; td[di+2]=rgb[2]; td[di+3]=255;
  }
}
function _buildHorizMixed(curTile, prevTile, subRow) {
  const m = new Array(64);
  for (let py = 0; py < 8; py++) {
    const src = py <= subRow ? curTile : prevTile;
    for (let px = 0; px < 8; px++) m[py * 8 + px] = src[py * 8 + px];
  }
  return m;
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
  const hShift = Math.floor(waterTick / 8) % 16;
  const hPrev  = (hShift + 15) % 16;
  const subRow = waterTick % 8;
  const vFrame = Math.floor(waterTick / 8) % 8;

  for (const m of metas) {
    const meta = metatiles[m];
    const rgbPal = palettes[tileAttrs[m] & 0x03].map(ni => NES_SYSTEM_PALETTE[ni & 0x3F] || [0,0,0]);
    const chrs = [meta.tl, meta.tr, meta.bl, meta.br];
    const offs = [[0,0],[8,0],[0,8],[8,8]];

    for (let q = 0; q < 4; q++) {
      const ci = chrs[q];
      const fr = frames.get(ci);
      if (!fr) {
        const tile = chrTiles[ci];
        if (!tile) continue;
        _writeTilePixels(td, tile, rgbPal);
      } else if (HORIZ_CHR.has(ci)) {
        const curTile = fr[hShift % fr.length];
        const prevTile = fr[hPrev % fr.length];
        // Per-row cascade: rows <= subRow use current shift, others use previous
          _writeTilePixels(td, _buildHorizMixed(curTile, prevTile, subRow), rgbPal);
      } else {
        _writeTilePixels(td, fr[vFrame % fr.length], rgbPal);
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


let _indoorWaterCache = null;

function _buildHorizWaterFrames(chrTiles, frames) {
  for (const [ciL, ciR] of [[0x22, 0x23], [0x24, 0x25]]) {
    const bL = chrTiles[ciL], bR = chrTiles[ciR];
    if (!bL || !bR || !_isWater(bL) || !_isWater(bR)) continue;
    const [arrL, arrR] = _buildHorizWaterPair(bL, bR);
    frames.set(ciL, arrL); frames.set(ciR, arrR);
  }
}
function _buildVertWaterFrames(chrTiles, frames) {
  for (const ci of VERT_CHR) {
    const base = chrTiles[ci];
    if (!base || !_isWater(base)) continue;
    const p0 = _getPlane0(base), p1 = base.map(p => p & 2);
    const arr = [];
    for (let f = 0; f < 8; f++) {
      const rot = new Uint8Array(8);
      for (let r = 0; r < 8; r++) rot[r] = p0[((r - f) % 8 + 8) % 8];
      arr.push(_rebuild(rot, p1));
    }
    frames.set(ci, arr);
  }
}
function _findAnimatedPositions(tilemap, metatiles) {
  const positions = [];
  for (let ty = 0; ty < 32; ty++) for (let tx = 0; tx < 32; tx++) {
    const mid = tilemap[ty * 32 + tx];
    const mt = metatiles[mid < 128 ? mid : mid & 0x7F];
    if (ANIM_CHR.has(mt.tl) || ANIM_CHR.has(mt.tr) || ANIM_CHR.has(mt.bl) || ANIM_CHR.has(mt.br))
      positions.push({ tx, ty, m: mid < 128 ? mid : mid & 0x7F });
  }
  return positions;
}
function _buildIndoorWaterCache(mr) {
  const { chrTiles, metatiles, tilemap } = mr.mapData;
  const frames = new Map();
  _buildHorizWaterFrames(chrTiles, frames);
  _buildVertWaterFrames(chrTiles, frames);
  return { frames, positions: _findAnimatedPositions(tilemap, metatiles) };
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
        const curTile = fr[hShift % fr.length], prevTile = fr[hPrev % fr.length];
        _writeTilePixels(td, _buildHorizMixed(curTile, prevTile, subRow), rgbPal);
      } else {
        _writeTilePixels(td, fr[vFrame % fr.length], rgbPal);
      }
      fctx.putImageData(tileImg, tx * 16 + offs[q][0], ty * 16 + offs[q][1]);
    }
  }
}

function _renderSprites(camX, camY, originX, spriteY) {
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
    _updateWorldWater(worldMapRenderer);
  } else if (mapRenderer) {
    mapRenderer.draw(ctx, camX, camY, originX, originY);
    _updateIndoorWater(mapRenderer);
  }
  if ((transState === 'none' || transState === 'trap-reveal') &&
      (battleState === 'none' || battleState === 'flash-strobe' || battleState.startsWith('roar-'))) {
    _renderSprites(camX, camY, originX, spriteY);
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

  ctx.save();
  ctx.beginPath(); ctx.rect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H); ctx.clip();
  _renderMapAndWater(camX, camY, SCREEN_CENTER_X, SCREEN_CENTER_Y + 3, SCREEN_CENTER_Y);
  _renderStarSpiral();
  ctx.restore();
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
  if (transState !== 'loading' && !topBoxIsTown && topBoxBgCanvas) {
    ctx.drawImage(topBoxBgCanvas, topShake, 0);
  }
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
    if (fadeStep > 0) ctx.drawImage(topBoxBgFadeFrames[fadeStep], 0, 0);
  }
  if (!topBoxIsTown && transState !== 'loading') roundTopBoxCorners();
}
function _drawTopBoxOverlay(isFading) {
  if (transState === 'loading') {
    let loadFade = LOAD_FADE_MAX;
    if (loadingFadeState === 'in') {
      loadFade = LOAD_FADE_MAX - Math.min(Math.floor(loadingFadeTimer / LOAD_FADE_STEP_MS), LOAD_FADE_MAX);
    } else if (loadingFadeState === 'visible') {
      loadFade = 0;
    } else if (loadingFadeState === 'out') {
      loadFade = Math.min(Math.floor(loadingFadeTimer / LOAD_FADE_STEP_MS), LOAD_FADE_MAX);
    }
    drawTopBoxBorder(loadFade);
    if (topBoxNameBytes && !isFading) {
      const fadedPal = [0x0F, 0x0F, 0x0F, 0x30];
      for (let s = 0; s < loadFade; s++) fadedPal[3] = nesColorFade(fadedPal[3]);
      const tw = measureText(topBoxNameBytes);
      drawText(ctx, 8 + Math.floor((240 - tw) / 2), 12, topBoxNameBytes, fadedPal);
    }
  } else if (topBoxIsTown && topBoxMode === 'name' && topBoxNameBytes) {
    if (isFading) drawTopBoxBorder(topBoxFadeStep);
    else if (topBoxScrollState !== 'pending') drawTopBoxBorder(0);
    if (!isFading && topBoxScrollState !== 'pending') {
      const tw = measureText(topBoxNameBytes);
      drawText(ctx, 8 + Math.floor((240 - tw) / 2), 12, topBoxNameBytes, TEXT_WHITE);
    }
  }
  if (isFading && topBoxNameBytes) {
    if (transState !== 'loading' && !topBoxIsTown) drawTopBoxBorder(topBoxFadeStep);
    const fadedPal = [0x0F, 0x0F, 0x0F, 0x30];
    for (let s = 0; s < topBoxFadeStep; s++) fadedPal[3] = nesColorFade(fadedPal[3]);
    const tw = measureText(topBoxNameBytes);
    drawText(ctx, 8 + Math.floor((240 - tw) / 2), 12, topBoxNameBytes, fadedPal);
  }
}
function _drawHUDTopBox() {
  const isFading = topBoxScrollState === 'fade-in' || topBoxScrollState === 'display' || topBoxScrollState === 'fade-out';
  _drawTopBoxBattleBG();
  _drawTopBoxOverlay(isFading);
}

function _drawPortraitImage(px, py, nfPortrait, isPauseHeal, infoFadeStep) {
  if (infoFadeStep >= HUD_INFO_FADE_STEPS) return;
  if (infoFadeStep > 0) ctx.globalAlpha = 1 - infoFadeStep / HUD_INFO_FADE_STEPS;
  ctx.drawImage(nfPortrait, px, py);
  if (!isPauseHeal && nfPortrait === battleSpriteKneelCanvas && sweatFrames.length === 2)
    ctx.drawImage(sweatFrames[Math.floor(Date.now() / 133) & 1], px, py - 3);
  if (infoFadeStep > 0) ctx.globalAlpha = 1;
}
function _drawCureSparkle(px, py, isPauseHeal) {
  if (!isPauseHeal || cureSparkleFrames.length !== 2 || (pauseHealNum && pauseHealNum.rosterIdx >= 0)) return;
  const frame = cureSparkleFrames[Math.floor(pauseTimer / 67) & 1];
  ctx.drawImage(frame, px - 8, py - 7);
  ctx.save(); ctx.scale(-1,  1); ctx.drawImage(frame, -(px + 23),  py - 7);  ctx.restore();
  ctx.save(); ctx.scale( 1, -1); ctx.drawImage(frame,   px - 8,  -(py + 24)); ctx.restore();
  ctx.save(); ctx.scale(-1, -1); ctx.drawImage(frame, -(px + 23), -(py + 24)); ctx.restore();
}
function _drawPauseHealNum(px, py) {
  if (!pauseHealNum || pauseHealNum.rosterIdx >= 0) return;
  _drawBattleNum(px + 8, _dmgBounceY(py + 8, pauseHealNum.timer), pauseHealNum.value, [0x0F, 0x0F, 0x0F, 0x2B]);
}
function _drawHUDPortrait() {
  const infoFadeStep = HUD_INFO_FADE_STEPS - Math.min(Math.floor(hudInfoFadeTimer / HUD_INFO_FADE_STEP_MS), HUD_INFO_FADE_STEPS);
  if (battleState !== 'none' || !battleSpriteCanvas) return;
  const isPauseHeal = pauseState === 'inv-heal';
  const nfPortrait = isPauseHeal && battleSpriteDefendCanvas ? battleSpriteDefendCanvas
    : (playerHP > 0 && playerStats && playerHP <= Math.floor(playerStats.maxHP / 4) && battleSpriteKneelCanvas
       ? battleSpriteKneelCanvas : battleSpriteCanvas);
  const px = HUD_RIGHT_X + 8, py = HUD_VIEW_Y + 8;
  _drawPortraitImage(px, py, nfPortrait, isPauseHeal, infoFadeStep);
  _drawCureSparkle(px, py, isPauseHeal);
  _drawPauseHealNum(px, py);
}

function _drawHUDInfoPanel() {
  // Name + Level in right mini-right panel (right-aligned, like roster players)
  const infoFadeStep = HUD_INFO_FADE_STEPS - Math.min(Math.floor(hudInfoFadeTimer / HUD_INFO_FADE_STEP_MS), HUD_INFO_FADE_STEPS);
  const shakeOff = (battleState === 'enemy-attack' && battleShakeTimer > 0)
    ? (Math.floor(battleShakeTimer / 67) & 1 ? 2 : -2) : 0;
  const sy = HUD_VIEW_Y + 8;
  const panelRight = HUD_RIGHT_X + HUD_RIGHT_W - 8 + shakeOff;
  const infoPal = [0x0F, 0x0F, 0x0F, 0x30];
  for (let s = 0; s < infoFadeStep; s++) {
    infoPal[3] = nesColorFade(infoPal[3]);
  }
  const slot = saveSlots[selectCursor];
  if (!slot) return;
  const nameW = measureText(slot.name);
  drawText(ctx, panelRight - nameW, sy, slot.name, infoPal);
  // Level fades out as battle starts, HP fades in (and vice versa)
  const lvFadeStep = infoFadeStep + hudHpLvStep;
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
    const hpFadeStep = infoFadeStep + (4 - hudHpLvStep);
    const hpPal = [0x0F, 0x0F, 0x0F, hpNes];
    for (let s = 0; s < hpFadeStep; s++) hpPal[3] = nesColorFade(hpPal[3]);
    const hpLabel = _nameToBytes(String(playerHP));
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
  ctx.drawImage(moogleFadeFrames[fadeLevel][Math.floor(transTimer / 400) & 1], moogleX, moogleY);
}
function _drawHUDLoadingMoogle() {
  let fadeLevel = 0;
  if (loadingFadeState === 'in') fadeLevel = LOAD_FADE_MAX - Math.min(Math.floor(loadingFadeTimer / LOAD_FADE_STEP_MS), LOAD_FADE_MAX);
  else if (loadingFadeState === 'out') fadeLevel = Math.min(Math.floor(loadingFadeTimer / LOAD_FADE_STEP_MS), LOAD_FADE_MAX);
  _drawLoadingRightPanel(fadeLevel);
  const rpCX = HUD_RIGHT_X + Math.floor(HUD_RIGHT_W / 2);
  const bubbleY = _drawLoadingChatBubble(rpCX, HUD_VIEW_Y + 32, HUD_VIEW_H - 32, fadeLevel);
  _drawLoadingMoogleSprite(Math.round(rpCX - 8), bubbleY + 30, fadeLevel);
}

function drawHUD() {
  const isTitleActive = titleState !== 'done';
  if (isTitleActive && titleHudCanvas) {
    // Compute border fade level for title states
    let tfl = 0; // 0 = full brightness — only fade out when leaving title
    if (titleState === 'main-out') {
      tfl = Math.min(Math.floor(titleTimer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
    }
    _drawHudWithFade(titleHudCanvas, titleHudFadeCanvases, tfl);
  } else if (hudCanvas) {
    // Game-start border fade-in
    const borderFade = HUD_INFO_FADE_STEPS - Math.min(Math.floor(hudInfoFadeTimer / HUD_INFO_FADE_STEP_MS), HUD_INFO_FADE_STEPS);
    _drawHudWithFade(hudCanvas, hudFadeCanvases, borderFade);
  }

  // Top box content (full 256×32, no static border — border only with text)
  // Title screen handles its own top box (sky BG)
  if (titleState !== 'done') return;

  _drawHUDTopBox();
  _drawHUDPortrait();
  _drawHUDInfoPanel();
  if (transState === 'loading' && loadingFadeState !== 'none') {
    _drawHUDLoadingMoogle();
  }
}

// ── Player Roster (right main panel) ──

// Draw a HUD border box on the main canvas ctx, with optional NES fade step
function _drawSparkleCorners(frame, px, py) {
  _drawSparkleCorners(frame, px, py);
}
function _drawCursorFaded(cx, cy, fadeStep) {
  if (!cursorTileCanvas) return;
  if (fadeStep === 0) { ctx.drawImage(cursorTileCanvas, cx, cy); return; }
  if (fadeStep < 4) {
    ctx.globalAlpha = 1 - fadeStep / 4;
    ctx.drawImage(cursorTileCanvas, cx, cy);
    ctx.globalAlpha = 1;
  }
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
  if (!pauseHealNum || pauseHealNum.rosterIdx < 0 || cureSparkleFrames.length !== 2) return;
  const visRow = pauseHealNum.rosterIdx - rosterScroll;
  if (visRow < 0 || visRow >= ROSTER_VISIBLE) return;
  const px = HUD_RIGHT_X + 8;
  const py = panelTop + visRow * ROSTER_ROW_H + 8;
  const fi = Math.floor(pauseTimer / 67) & 1;
  const frame = cureSparkleFrames[fi];
  _drawSparkleCorners(frame, px, py);
  _drawBattleNum(px + 8, _dmgBounceY(py + 8, pauseHealNum.timer), pauseHealNum.value, [0x0F, 0x0F, 0x0F, 0x2B]);
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
  if (titleState !== 'done') return;
  if (transState === 'loading') return;
  if (rosterBattleFade >= ROSTER_FADE_STEPS && battleState !== 'none') return;

  const panelTop = HUD_VIEW_Y + 32;
  const panelH = HUD_VIEW_H - 32;
  const scrollAreaY = panelTop + ROSTER_VISIBLE * ROSTER_ROW_H;

  const players = getRosterVisible();
  const maxVisible = Math.min(ROSTER_VISIBLE, players.length);
  const maxScroll = Math.max(0, players.length - maxVisible);
  if (rosterScroll > maxScroll) rosterScroll = maxScroll;

  const canScrollUp = rosterScroll > 0;
  const canScrollDown = rosterScroll < maxScroll;

  ctx.save();
  ctx.beginPath();
  ctx.rect(HUD_RIGHT_X, panelTop, HUD_RIGHT_W, panelH);
  ctx.clip();
  for (let i = 0; i < maxVisible; i++) {
    const idx = rosterScroll + i;
    if (idx >= players.length) break;
    _drawRosterRow(players[idx], i, panelTop);
  }
  ctx.restore();

  _drawRosterScrollTriangles(scrollAreaY, canScrollUp, canScrollDown);

  _drawRosterSparkle(panelTop);

  // Cursor (drawn outside clip — overlaps portrait box border)
  if (rosterState === 'browse' || rosterState === 'menu' || rosterState === 'menu-in' || rosterState === 'menu-out') {
    const visIdx = rosterCursor - rosterScroll;
    const curTarget = players[rosterCursor];
    const curSlide = curTarget ? (rosterSlideY[curTarget.name] || 0) : 0;
    const curY = panelTop + visIdx * ROSTER_ROW_H + curSlide + 12;
    if (cursorTileCanvas) ctx.drawImage(cursorTileCanvas, HUD_RIGHT_X - 4, curY);
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
  _clipToViewport();

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

function _buildChatRows(ctx, lineW, startX) {
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
  return rows;
}

function _drawChatInput(ctx, lineW, startX, inputLine1Y, inputLine2Y) {
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

function _drawChatExpandBG(curBoxY, curBoxH, battleFadeAlpha) {
  if (chatExpandAnim <= 0) return;
  const NES_STEP_ALPHAS = [0, 0.28, 0.52, 0.76, 1.0];
  ctx.globalAlpha = NES_STEP_ALPHAS[Math.min(4, Math.round(chatExpandAnim * 4))] * battleFadeAlpha;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, HUD_VIEW_Y, CANVAS_W, HUD_BOT_Y - HUD_VIEW_Y);
  ctx.globalAlpha = battleFadeAlpha;
  _drawHudBox(0, curBoxY, CANVAS_W, curBoxH, 0);
}

function _drawChatTextArea(curBoxY, curBoxH, battleFadeAlpha) {
  const innerTop    = curBoxY + 8;
  const innerBottom = curBoxY + curBoxH - 10;
  const innerH      = innerBottom - innerTop;
  ctx.globalAlpha = battleFadeAlpha;
  ctx.beginPath(); ctx.rect(8, innerTop, CANVAS_W - 16, curBoxH - 16); ctx.clip();
  ctx.font = '8px "Press Start 2P"'; ctx.textBaseline = 'bottom';
  const startX = 12; const lineW = CANVAS_W - 8 - startX;
  const rows      = _buildChatRows(ctx, lineW, startX);
  const inputRows = chatInputActive ? 2 : 0;
  const availRows = Math.max(1, Math.floor(innerH / CHAT_LINE_H) - inputRows);
  const inputLine2Y = innerBottom;
  const inputLine1Y = inputLine2Y - CHAT_LINE_H;
  const bottomY   = chatInputActive ? inputLine1Y - CHAT_LINE_H : inputLine2Y;
  const visible   = rows.slice(-availRows);
  for (let i = 0; i < visible.length; i++) {
    const r = visible[i]; const lineY = bottomY - (visible.length - 1 - i) * CHAT_LINE_H;
    if (r.namePart !== undefined) {
      ctx.fillStyle = '#d8b858'; ctx.fillText(r.namePart, r.x, lineY);
      ctx.fillStyle = '#e0e0e0'; ctx.fillText(r.msgPart, r.x + r.nameW, lineY);
    } else { ctx.fillStyle = r.color; ctx.fillText(r.text, r.x, lineY); }
  }
  if (chatInputActive) _drawChatInput(ctx, lineW, startX, inputLine1Y, inputLine2Y);
}

function drawChat() {
  if (!chatFontReady) return;
  const battleFadeAlpha = 1 - rosterBattleFade / ROSTER_FADE_STEPS;
  if (battleFadeAlpha <= 0) return;
  if (chatMessages.length === 0 && !chatInputActive && chatExpandAnim === 0) return;
  const curBoxH = HUD_BOT_H + Math.round((CANVAS_H - HUD_VIEW_Y - HUD_BOT_H) * chatExpandAnim / 8) * 8;
  const curBoxY = CANVAS_H - curBoxH;
  ctx.save();
  _drawChatExpandBG(curBoxY, curBoxH, battleFadeAlpha);
  _drawChatTextArea(curBoxY, curBoxH, battleFadeAlpha);
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

function _updateRosterBattleFade(dt) {
  // Battle fade out/in — don't fade during roar-hold (wait until roar box closes)
  if (battleState !== 'none' && battleState !== 'roar-hold' && rosterBattleFading !== 'out' && rosterBattleFade < ROSTER_FADE_STEPS) {
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
}

function _updateRosterLocationReset(curLoc) {
  if (rosterPrevLoc === null || curLoc === rosterPrevLoc) return;
  rosterFadeMap = {}; rosterFadeDir = {}; rosterFadeTimers = {}; rosterSlideY = {};
  rosterArrivalOrder = [];
  for (const p of PLAYER_POOL) {
    if (p.loc === curLoc) rosterFadeMap[p.name] = 0;
  }
  rosterCursor = 0;
  rosterScroll = 0;
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
  if (rosterState === 'menu-in' || rosterState === 'menu-out') rosterMenuTimer += Math.min(dt, 33);
  if (titleState !== 'done') return;
  _updateRosterBattleFade(dt);
  const curLoc = getPlayerLocation();
  _updateRosterLocationReset(curLoc);
  _updateRosterFadeTicks(dt);
  _updateRosterSlideTicks(dt);
  _updateRosterMovement(dt, curLoc);
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

const TITLE_PRESS_Z = isMobile
  ? new Uint8Array([0x99,0xDB,0xCE,0xDC,0xDC,0xFF,0x8A]) // "Press A"
  : new Uint8Array([0x99,0xDB,0xCE,0xDC,0xDC,0xFF,0xA3]); // "Press Z"

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

function _updateTitleUnderwater(dt) {
  if (!uwBubbleTiles) return;
  if (titleState === 'main-in' || titleState === 'main' || titleState === 'main-out' ||
      titleState.startsWith('zbox') || titleState.startsWith('select') || titleState === 'name-entry') return;
  if (uwBubbles.length < 3 && Math.random() < dt * 0.0015) {
    uwBubbles.push({
      x: HUD_VIEW_X + 20 + Math.random() * (CANVAS_W - 40),
      y: HUD_VIEW_H - 4,
      speed: 18 + Math.random() * 12,
      zigPhase: Math.random() * Math.PI * 2,
      zigSpeed: 3 + Math.random() * 3,
      zigAmp: 8 + Math.random() * 8,
      timer: 0,
    });
  }
  for (let i = uwBubbles.length - 1; i >= 0; i--) {
    const b = uwBubbles[i];
    b.y -= b.speed * dt / 1000;
    b.timer += dt;
    if (b.y < -8) uwBubbles.splice(i, 1);
  }
  if (!uwFishTriggered && titleState === 'disclaim-wait') {
    uwFishTriggered = true;
    uwFish = { x: -10, y: HUD_VIEW_H * 0.7, timer: 0, speed: 80, zigPhase: 0, zigSpeed: 4, zigAmp: 6 };
  }
  if (uwFish) {
    uwFish.x += uwFish.speed * dt / 1000;
    uwFish.y -= uwFish.speed * 0.4 * dt / 1000;
    uwFish.timer += dt;
    if (uwFish.x > CANVAS_W + 10 || uwFish.y < -10) uwFish = null;
  }
}
function _updateTitleSelectCase() {
  if (_zPressed()) {
    if (deleteMode) {
      if (selectCursor < 3 && saveSlots[selectCursor]) {
        playSFX(SFX.CONFIRM);
        saveSlots[selectCursor] = null;
        serverDeleteSlot(selectCursor);
        saveSlotsToDB();
        deleteMode = false;
      }
    } else if (selectCursor === 3) {
      playSFX(SFX.CONFIRM);
      deleteMode = true;
      selectCursor = 0;
    } else if (saveSlots[selectCursor]) {
      playSFX(SFX.CONFIRM);
      titleState = 'select-fade-out'; titleTimer = 0;
    } else {
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
  if (_xPressed()) {
    if (deleteMode) { playSFX(SFX.CONFIRM); deleteMode = false; }
    else { playSFX(SFX.CONFIRM); titleState = 'select-fade-out-back'; titleTimer = 0; }
  }
}
function _updateTitleMainOutCase() {
  titleState = 'done';
  hudInfoFadeTimer = 0;
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
  worldY -= 6 * TILE_SIZE;
  playTrack(TRACKS.TOWN_UR);
  transState = 'hud-fade-in';
  transTimer = 0;
}
function updateTitle(dt) {
  titleTimer += dt;
  titleUnderwaterScroll += dt * 0.11;
  _updateTitleUnderwater(dt);

  if (titleState === 'main-in' || titleState === 'zbox-open' || titleState === 'main' || titleState === 'zbox-close' ||
      titleState === 'logo-fade-out' || titleState === 'logo-fade-in' || titleState === 'select-box-open' || titleState === 'select-box-close' || titleState === 'select-box-close-fwd' ||
      titleState === 'select-fade-in' || titleState === 'select' || titleState === 'select-fade-out' || titleState === 'select-fade-out-back' ||
      titleState === 'name-entry' || titleState === 'main-out') {
    waterTimer += dt;
    if (waterTimer >= WATER_TICK) { waterTimer %= WATER_TICK; waterTick++; }
    titleWaterScroll += dt * 0.12;
    titleShipTimer += dt;
  }

  switch (titleState) {
    case 'credit-wait':    if (titleTimer >= TITLE_FADE_MS) { titleState = 'credit-in';     titleTimer = 0; } break;
    case 'credit-in':      if (titleTimer >= TITLE_FADE_MS) { titleState = 'credit-hold';   titleTimer = 0; } break;
    case 'credit-hold':    if (titleTimer >= TITLE_HOLD_MS) { titleState = 'credit-out';    titleTimer = 0; } break;
    case 'credit-out':     if (titleTimer >= TITLE_FADE_MS) { titleState = 'disclaim-wait'; titleTimer = 0; } break;
    case 'disclaim-wait':  if (titleTimer >= TITLE_WAIT_MS) { titleState = 'disclaim-in';   titleTimer = 0; } break;
    case 'disclaim-in':    if (titleTimer >= TITLE_FADE_MS) { titleState = 'disclaim-hold'; titleTimer = 0; } break;
    case 'disclaim-hold':  if (titleTimer >= TITLE_HOLD_MS) { titleState = 'disclaim-out';  titleTimer = 0; } break;
    case 'disclaim-out':   if (titleTimer >= TITLE_FADE_MS) { titleState = 'main-in';       titleTimer = 0; } break;
    case 'main-in':        if (titleTimer >= TITLE_FADE_MS) { titleState = 'zbox-open';     titleTimer = 0; } break;
    case 'zbox-open':      if (titleTimer >= TITLE_ZBOX_MS) { titleState = 'main';          titleTimer = 0; } break;
    case 'main':
      if (keys['z'] || keys['Z']) { keys['z'] = false; keys['Z'] = false; playSFX(SFX.CONFIRM); titleState = 'zbox-close'; titleTimer = 0; }
      break;
    case 'zbox-close':           if (titleTimer >= TITLE_ZBOX_MS) { titleState = 'logo-fade-out'; titleTimer = 0; } break;
    case 'logo-fade-out':        if (titleTimer >= TITLE_FADE_MS) { titleState = 'select-box-open'; titleTimer = 0; selectCursor = 0; deleteMode = false; } break;
    case 'select-box-open':      if (titleTimer >= BOSS_BOX_EXPAND_MS) { titleState = 'select-fade-in'; titleTimer = 0; } break;
    case 'select-fade-in':       if (titleTimer >= (SELECT_TEXT_STEPS + 1) * SELECT_TEXT_STEP_MS) { titleState = 'select'; titleTimer = 0; } break;
    case 'select':               _updateTitleSelectCase(); break;
    case 'name-entry':           break;
    case 'select-fade-out':      if (titleTimer >= (SELECT_TEXT_STEPS + 1) * SELECT_TEXT_STEP_MS) { titleState = 'select-box-close-fwd'; titleTimer = 0; } break;
    case 'select-box-close-fwd': if (titleTimer >= BOSS_BOX_EXPAND_MS) { titleState = 'main-out'; titleTimer = 0; } break;
    case 'select-fade-out-back': if (titleTimer >= (SELECT_TEXT_STEPS + 1) * SELECT_TEXT_STEP_MS) { titleState = 'select-box-close'; titleTimer = 0; } break;
    case 'select-box-close':     if (titleTimer >= BOSS_BOX_EXPAND_MS) { titleState = 'logo-fade-in'; titleTimer = 0; } break;
    case 'logo-fade-in':         if (titleTimer >= TITLE_FADE_MS) { titleState = 'zbox-open'; titleTimer = 0; } break;
    case 'main-out':             if (titleTimer >= TITLE_FADE_MS) _updateTitleMainOutCase(); break;
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

function _drawTitleWaterRows(waterTop, twW, tile) {
  for (let r = 0; r < 7; r++) {
    const speed = _titleParallaxSpeed(4 + r);
    const scrollX = Math.floor(titleWaterScroll * speed) % 16;
    const y = waterTop + r * 16;
    for (let x = HUD_VIEW_X - scrollX; x < HUD_VIEW_X + twW + 16; x += 16) ctx.drawImage(tile, x, y);
  }
}

function drawTitleWater(fadeLevel) {
  if (!titleWaterFrames) return;
  const twW = CANVAS_W; const waterTop = HUD_VIEW_Y + 32;
  ctx.save(); ctx.beginPath(); ctx.rect(HUD_VIEW_X, waterTop, twW, HUD_VIEW_H - 32); ctx.clip();
  if (fadeLevel > 0 && titleWaterFadeTiles) {
    _drawTitleWaterRows(waterTop, twW, titleWaterFadeTiles[Math.min(fadeLevel, titleWaterFadeTiles.length - 1)]);
  } else {
    const hShift = Math.floor(waterTick / 8) % 16, hPrev = (hShift + 15) % 16, subRow = waterTick % 8;
    if (!_titleCascadeCanvas) {
      _titleCascadeCanvas = document.createElement('canvas'); _titleCascadeCanvas.width = 16; _titleCascadeCanvas.height = 16;
    }
    const cctx = _titleCascadeCanvas.getContext('2d');
    cctx.drawImage(titleWaterFrames[hPrev], 0, 0);
    const h = subRow + 1;
    cctx.drawImage(titleWaterFrames[hShift], 0, 0, 16, h, 0, 0, 16, h);
    cctx.drawImage(titleWaterFrames[hShift], 0, 8, 16, h, 0, 8, 16, h);
    _drawTitleWaterRows(waterTop, twW, _titleCascadeCanvas);
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

function _drawTitleCredit(cx, cy) {
  if (titleState === 'credit-in' || titleState === 'credit-hold' || titleState === 'credit-out') {
    let fl = 0;
    if (titleState === 'credit-in') fl = TITLE_FADE_MAX - Math.min(Math.floor(titleTimer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
    else if (titleState === 'credit-out') fl = Math.min(Math.floor(titleTimer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
    const pal = fl === 0 ? TEXT_WHITE : titleFadePal(fl);
    drawText(ctx, cx - measureText(TITLE_CREDIT_1) / 2, cy - 16, TITLE_CREDIT_1, pal);
    drawText(ctx, cx - measureText(TITLE_CREDIT_2) / 2, cy -  4, TITLE_CREDIT_2, pal);
    drawText(ctx, cx - measureText(TITLE_CREDIT_3) / 2, cy +  8, TITLE_CREDIT_3, pal);
  } else if (titleState === 'disclaim-in' || titleState === 'disclaim-hold' || titleState === 'disclaim-out') {
    let fl = 0;
    if (titleState === 'disclaim-in') fl = TITLE_FADE_MAX - Math.min(Math.floor(titleTimer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
    else if (titleState === 'disclaim-out') fl = Math.min(Math.floor(titleTimer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
    const pal = fl === 0 ? TEXT_WHITE : titleFadePal(fl);
    drawText(ctx, cx - measureText(TITLE_DISCLAIM_1) / 2, cy - 24, TITLE_DISCLAIM_1, pal);
    drawText(ctx, cx - measureText(TITLE_DISCLAIM_2) / 2, cy - 14, TITLE_DISCLAIM_2, pal);
    drawText(ctx, cx - measureText(TITLE_DISCLAIM_3) / 2, cy -  4, TITLE_DISCLAIM_3, pal);
    drawText(ctx, cx - measureText(TITLE_DISCLAIM_4) / 2, cy + 10, TITLE_DISCLAIM_4, pal);
    drawText(ctx, cx - measureText(TITLE_DISCLAIM_5) / 2, cy + 24, TITLE_DISCLAIM_5, pal);
  }
}
function _drawTitleLogo(cx, fl, isSelectState) {
  let logoFl = fl;
  if (titleState === 'logo-fade-out') {
    logoFl = Math.min(Math.floor(titleTimer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
  } else if (titleState === 'logo-fade-in') {
    logoFl = TITLE_FADE_MAX - Math.min(Math.floor(titleTimer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
  } else if (isSelectState || titleState === 'main-out') {
    logoFl = TITLE_FADE_MAX;
  }
  if (!titleLogoFrames || logoFl >= TITLE_FADE_MAX) return;
  const logoFrame = titleLogoFrames[Math.min(logoFl, titleLogoFrames.length - 1)];
  const tboxW = logoFrame.width + 16;
  const tboxH = logoFrame.height + 24;
  const tboxX = Math.round(cx - tboxW / 2);
  const tboxY = HUD_VIEW_Y + 12;
  const clampedFl = Math.min(logoFl, LOAD_FADE_MAX);
  const tBorderSet = (borderFadeSets && logoFl > 0) ? borderFadeSets[clampedFl] : borderTileCanvases;
  if (tBorderSet) {
    const [TL, TOP, TR, LEFT, RIGHT, BL, BOT, BR, FILL] = tBorderSet;
    ctx.drawImage(TL, tboxX, tboxY); ctx.drawImage(TR, tboxX + tboxW - 8, tboxY);
    ctx.drawImage(BL, tboxX, tboxY + tboxH - 8); ctx.drawImage(BR, tboxX + tboxW - 8, tboxY + tboxH - 8);
    for (let tx = tboxX + 8; tx < tboxX + tboxW - 8; tx += 8) { ctx.drawImage(TOP, tx, tboxY); ctx.drawImage(BOT, tx, tboxY + tboxH - 8); }
    for (let ty = tboxY + 8; ty < tboxY + tboxH - 8; ty += 8) { ctx.drawImage(LEFT, tboxX, ty); ctx.drawImage(RIGHT, tboxX + tboxW - 8, ty); }
    for (let ty = tboxY + 8; ty < tboxY + tboxH - 8; ty += 8)
      for (let tx = tboxX + 8; tx < tboxX + tboxW - 8; tx += 8) ctx.drawImage(FILL, tx, ty);
  }
  ctx.drawImage(logoFrame, tboxX + 8, tboxY + 8);
  const tw2 = measureText(TITLE_MMORPG);
  drawText(ctx, cx - tw2 / 2, tboxY + 8 + logoFrame.height, TITLE_MMORPG, logoFl === 0 ? TEXT_WHITE : titleFadePal(logoFl));
}
function _drawTitleShip(cx, cy, fl) {
  if (!invincibleFadeFrames || fl >= TITLE_FADE_MAX) return;
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
function _drawTitlePressZ(cx, vpBot) {
  if (titleState !== 'zbox-open' && titleState !== 'main' && titleState !== 'zbox-close') return;
  const pw = measureText(TITLE_PRESS_Z);
  const fullW = pw + 16, fullH = 24;
  const boxCY = vpBot - 44 + fullH / 2;
  let t = 1;
  if (titleState === 'zbox-open') t = Math.min(titleTimer / TITLE_ZBOX_MS, 1);
  else if (titleState === 'zbox-close') t = 1 - Math.min(titleTimer / TITLE_ZBOX_MS, 1);
  const boxW = fullW;
  const boxH = Math.max(8, Math.round(fullH * t));
  const boxX = cx - boxW / 2;
  const boxY = Math.round(boxCY - boxH / 2);
  if (borderTileCanvases) {
    const [TL, TOP, TR, LEFT, RIGHT, BL, BOT, BR, FILL] = borderTileCanvases;
    ctx.drawImage(TL, boxX, boxY); ctx.drawImage(TR, boxX + boxW - 8, boxY);
    ctx.drawImage(BL, boxX, boxY + boxH - 8); ctx.drawImage(BR, boxX + boxW - 8, boxY + boxH - 8);
    for (let tx = boxX + 8; tx < boxX + boxW - 8; tx += 8) { ctx.drawImage(TOP, tx, boxY); ctx.drawImage(BOT, tx, boxY + boxH - 8); }
    for (let ty = boxY + 8; ty < boxY + boxH - 8; ty += 8) { ctx.drawImage(LEFT, boxX, ty); ctx.drawImage(RIGHT, boxX + boxW - 8, ty); }
    for (let ty = boxY + 8; ty < boxY + boxH - 8; ty += 8)
      for (let tx = boxX + 8; tx < boxX + boxW - 8; tx += 8) ctx.drawImage(FILL, tx, ty);
  }
  if (t >= 1 && Math.floor(titleTimer / 500) % 2 === 0) {
    drawText(ctx, boxX + 8, boxY + 8, TITLE_PRESS_Z, TEXT_WHITE);
  }
}
function _drawTitleSelectBox(cx) {
  const isSelectState = titleState === 'select-box-open' || titleState === 'select-box-close' || titleState === 'select-box-close-fwd' ||
    titleState === 'select-fade-in' || titleState === 'select' ||
    titleState === 'select-fade-out' || titleState === 'select-fade-out-back' || titleState === 'name-entry';
  if (!isSelectState) return;
  const SELECT_BOX_W = 128, SELECT_BOX_H = 112;
  const sbCX = cx;
  const sbCY = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2);
  let sbt = 1;
  if (titleState === 'select-box-open') sbt = Math.min(titleTimer / BOSS_BOX_EXPAND_MS, 1);
  else if (titleState === 'select-box-close' || titleState === 'select-box-close-fwd') sbt = 1 - Math.min(titleTimer / BOSS_BOX_EXPAND_MS, 1);
  const sbW = Math.max(16, Math.ceil(SELECT_BOX_W * sbt / 8) * 8);
  const sbH = Math.max(16, Math.ceil(SELECT_BOX_H * sbt / 8) * 8);
  if (borderTileCanvases) _drawBorderedBox(Math.round(sbCX - sbW / 2), Math.round(sbCY - sbH / 2), sbW, sbH);
  if (sbt >= 1 && titleState !== 'select-box-close' && titleState !== 'select-box-close-fwd') {
    drawPlayerSelectContent(Math.round(sbCX - sbW / 2), Math.round(sbCY - sbH / 2), SELECT_BOX_W, SELECT_BOX_H);
  }
}
function drawTitle() {
  const TVW = CANVAS_W;
  ctx.fillStyle = '#000';
  ctx.fillRect(HUD_VIEW_X, HUD_VIEW_Y, TVW, HUD_VIEW_H);
  ctx.fillRect(0, 0, CANVAS_W, HUD_TOP_H);

  const cx = HUD_VIEW_X + TVW / 2;
  const cy = HUD_VIEW_Y + HUD_VIEW_H / 2;
  const vpBot = HUD_VIEW_Y + HUD_VIEW_H;

  _drawTitleCredit(cx, cy);

  if (titleState === 'credit-wait' || titleState === 'credit-in' || titleState === 'credit-hold' || titleState === 'credit-out' ||
      titleState === 'disclaim-wait' || titleState === 'disclaim-in' || titleState === 'disclaim-hold' || titleState === 'disclaim-out') {
    drawUnderwaterSprites();
  }

  if (titleState === 'main-in' || titleState === 'zbox-open' || titleState === 'main' || titleState === 'zbox-close' ||
      titleState === 'logo-fade-out' || titleState === 'logo-fade-in' || titleState === 'select-box-open' || titleState === 'select-box-close' || titleState === 'select-box-close-fwd' ||
      titleState === 'select-fade-in' || titleState === 'select' || titleState === 'select-fade-out' || titleState === 'select-fade-out-back' ||
      titleState === 'name-entry' || titleState === 'main-out') {
    let fl = 0;
    if (titleState === 'main-in') fl = TITLE_FADE_MAX - Math.min(Math.floor(titleTimer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);
    else if (titleState === 'main-out') fl = Math.min(Math.floor(titleTimer / TITLE_FADE_STEP_MS), TITLE_FADE_MAX);

    const isSelectState = titleState === 'select-box-open' || titleState === 'select-box-close' || titleState === 'select-box-close-fwd' ||
      titleState === 'select-fade-in' || titleState === 'select' ||
      titleState === 'select-fade-out' || titleState === 'select-fade-out-back' || titleState === 'name-entry';

    ctx.save();
    ctx.beginPath();
    ctx.rect(HUD_VIEW_X + 8, HUD_VIEW_Y + 8, TVW - 16, HUD_VIEW_H - 16);
    ctx.clip();

    drawTitleOcean(fl);
    drawTitleWater(fl);
    _drawTitleLogo(cx, fl, isSelectState);
    _drawTitleShip(cx, cy, fl);

    ctx.restore();

    _drawTitlePressZ(cx, vpBot);
    _drawTitleSelectBox(cx);
  }
}


// --- Player select screen ---

function _drawSelectSlot(i, ix, slotStartY, slotSpacing, fadeStep, fadedPal) {
  const sy = slotStartY + i * slotSpacing;
  const textX = ix + 20;
  const nameX = textX + 18;
  const isNameEntry = titleState === 'name-entry' && i === selectCursor;

  // Hand cursor
  if (i === selectCursor) _drawCursorFaded(ix, sy - 4, fadeStep);

  // Portrait
  if (isNameEntry) {
    if (silhouetteCanvas) ctx.drawImage(silhouetteCanvas, textX - 2, sy - 4);
  } else {
    const portraitSrc = (saveSlots[i] && battleSpriteCanvas) ? battleSpriteCanvas : silhouetteCanvas;
    if (portraitSrc) {
      if (fadeStep === 0) {
        ctx.drawImage(portraitSrc, textX - 2, sy - 4, ...(portraitSrc === battleSpriteCanvas ? [16,16] : []));
      } else if (fadeStep < SELECT_TEXT_STEPS) {
        ctx.globalAlpha = 1 - fadeStep / SELECT_TEXT_STEPS;
        ctx.drawImage(portraitSrc, textX - 2, sy - 4, ...(portraitSrc === battleSpriteCanvas ? [16,16] : []));
        ctx.globalAlpha = 1;
      }
    }
  }

  // Slot text
  if (isNameEntry) {
    if (nameBuffer.length > 0) drawText(ctx, nameX, sy, new Uint8Array(nameBuffer), fadedPal);
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

function drawPlayerSelectContent(sbX, sbY, sbW, sbH) {
  // Compute NES fade step (0=full bright, 4=fully black)
  let fadeStep = 0;
  if (titleState === 'select-fade-in') {
    fadeStep = SELECT_TEXT_STEPS - Math.min(Math.floor(titleTimer / SELECT_TEXT_STEP_MS), SELECT_TEXT_STEPS);
  } else if (titleState === 'select-fade-out' || titleState === 'select-fade-out-back') {
    fadeStep = Math.min(Math.floor(titleTimer / SELECT_TEXT_STEP_MS), SELECT_TEXT_STEPS);
  }

  // Build faded palette
  const fadedPal = _makeFadedPal(fadeStep);

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
    _drawSelectSlot(i, ix, slotStartY, slotSpacing, fadeStep, fadedPal);
  }

  // "Delete" option
  const delY = slotStartY + 3 * slotSpacing;
  const delPal = deleteMode
    ? [0x0F, 0x0F, 0x0F, 0x16]
    : [0x0F, 0x0F, 0x0F, fadedPal[3]];
  if (!deleteMode && selectCursor === 3) _drawCursorFaded(ix, delY - 4, fadeStep);
  drawText(ctx, ix + 38, delY, SELECT_DELETE_TEXT, delPal);
}

// --- Pause menu ---

function _updatePauseMainTransitions() {
  const T = (PAUSE_TEXT_STEPS + 1) * PAUSE_TEXT_STEP_MS;
  if (pauseState === 'scroll-in') {
    if (pauseTimer >= PAUSE_SCROLL_MS) { pauseState = 'text-in'; pauseTimer = 0; }
  } else if (pauseState === 'text-in') {
    if (pauseTimer >= T) { pauseState = 'open'; pauseTimer = 0; }
  } else if (pauseState === 'text-out') {
    if (pauseTimer >= T) { pauseState = 'scroll-out'; pauseTimer = 0; }
  } else if (pauseState === 'scroll-out') {
    if (pauseTimer >= PAUSE_SCROLL_MS) { pauseState = 'none'; pauseTimer = 0; stopFF1Music(); resumeMusic(); }
  }
}

function _updatePauseInvTransitions(dt) {
  const T = (PAUSE_TEXT_STEPS + 1) * PAUSE_TEXT_STEP_MS;
  if (pauseState === 'inv-text-out') {
    if (pauseTimer >= T) { pauseState = 'inv-expand'; pauseTimer = 0; }
  } else if (pauseState === 'inv-expand') {
    if (pauseTimer >= PAUSE_EXPAND_MS) { pauseState = 'inv-items-in'; pauseTimer = 0; }
  } else if (pauseState === 'inv-items-in') {
    if (pauseTimer >= T) { pauseState = 'inventory'; pauseTimer = 0; }
  } else if (pauseState === 'inv-items-out') {
    if (pauseTimer >= T) { pauseState = 'inv-shrink'; pauseTimer = 0; }
  } else if (pauseState === 'inv-shrink') {
    if (pauseTimer >= PAUSE_EXPAND_MS) { pauseState = 'inv-text-in'; pauseTimer = 0; }
  } else if (pauseState === 'inv-text-in') {
    if (pauseTimer >= T) { pauseState = 'open'; pauseTimer = 0; }
  } else if (pauseState === 'inv-heal') {
    if (pauseHealNum) { pauseHealNum.timer += dt; if (pauseHealNum.timer >= BATTLE_DMG_SHOW_MS) pauseHealNum = null; }
    if (pauseTimer >= DEFEND_SPARKLE_TOTAL_MS) {
      pauseHealNum = null;
      const entries = Object.entries(playerInventory).filter(([,c]) => c > 0);
      if (pauseInvScroll >= entries.length) pauseInvScroll = Math.max(0, entries.length - 1);
      pauseState = 'inventory'; pauseTimer = 0;
    }
  }
}

function _updatePauseEqTransitions() {
  const T = (PAUSE_TEXT_STEPS + 1) * PAUSE_TEXT_STEP_MS;
  if (pauseState === 'eq-text-out') {
    if (pauseTimer >= T) { pauseState = 'eq-expand'; pauseTimer = 0; }
  } else if (pauseState === 'eq-expand') {
    if (pauseTimer >= PAUSE_EXPAND_MS) { pauseState = 'eq-slots-in'; pauseTimer = 0; }
  } else if (pauseState === 'eq-slots-in') {
    if (pauseTimer >= T) { pauseState = 'equip'; pauseTimer = 0; }
  } else if (pauseState === 'eq-slots-out') {
    if (pauseTimer >= T) { pauseState = 'eq-shrink'; pauseTimer = 0; }
  } else if (pauseState === 'eq-shrink') {
    if (pauseTimer >= PAUSE_EXPAND_MS) { pauseState = 'eq-text-in'; pauseTimer = 0; }
  } else if (pauseState === 'eq-text-in') {
    if (pauseTimer >= T) { pauseState = 'open'; pauseTimer = 0; }
  } else if (pauseState === 'eq-items-in') {
    if (pauseTimer >= T) { pauseState = 'eq-item-select'; pauseTimer = 0; }
  } else if (pauseState === 'eq-items-out') {
    if (pauseTimer >= T) { pauseState = 'equip'; pauseTimer = 0; }
  }
}

function updatePauseMenu(dt) {
  if (pauseState === 'none') return;
  pauseTimer += Math.min(dt, 33);
  if (pauseState.startsWith('inv-')) _updatePauseInvTransitions(dt);
  else if (pauseState.startsWith('eq-')) _updatePauseEqTransitions();
  else _updatePauseMainTransitions();
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

  _clipToViewport();

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

function _drawPauseBox() {
  const { px, finalY, pw, ph, isInvState, isEqState, panelY } = _pausePanelLayout();
  if (isInvState || isEqState) {
    let t = 1;
    if (pauseState === 'inv-expand' || pauseState === 'eq-expand') {
      t = Math.min(pauseTimer / PAUSE_EXPAND_MS, 1);
    } else if (pauseState === 'inv-shrink' || pauseState === 'eq-shrink') {
      t = 1 - Math.min(pauseTimer / PAUSE_EXPAND_MS, 1);
    } else if (pauseState === 'inv-text-out' || pauseState === 'eq-text-out' ||
               pauseState === 'inv-text-in'  || pauseState === 'eq-text-in') {
      t = 0;
    }
    const bw = Math.round(pw + (HUD_VIEW_W - pw) * t);
    const bh = Math.round(ph + (HUD_VIEW_H - ph) * t);
    _drawBorderedBox(px, finalY, bw, bh);
  } else {
    _drawBorderedBox(px, panelY, pw, ph);
  }
}
function _drawPauseMenuText() {
  const { px, finalY, pw, ph, isInvState, isEqState, panelY } = _pausePanelLayout();
  const showPauseText = pauseState === 'text-in' || pauseState === 'open' || pauseState === 'text-out' ||
                        pauseState === 'inv-text-out' || pauseState === 'inv-text-in' ||
                        pauseState === 'eq-text-out' || pauseState === 'eq-text-in';
  if (!showPauseText) return;
  let fadeStep = 0;
  if (pauseState === 'text-in' || pauseState === 'inv-text-in' || pauseState === 'eq-text-in') {
    fadeStep = PAUSE_TEXT_STEPS - Math.min(Math.floor(pauseTimer / PAUSE_TEXT_STEP_MS), PAUSE_TEXT_STEPS);
  } else if (pauseState === 'text-out' || pauseState === 'inv-text-out' || pauseState === 'eq-text-out') {
    fadeStep = Math.min(Math.floor(pauseTimer / PAUSE_TEXT_STEP_MS), PAUSE_TEXT_STEPS);
  }
  const fadedPal = _makeFadedPal(fadeStep);
  const textX = px + 24;
  const startY = ((isInvState || isEqState) ? finalY : panelY) + 12;
  for (let i = 0; i < PAUSE_ITEMS.length; i++) {
    drawText(ctx, textX, startY + i * 16, PAUSE_ITEMS[i], fadedPal);
  }
  _drawCursorFaded(px + 8, startY + pauseCursor * 16 - 4, fadeStep);
}
function _drawPauseInventory() {
  const px = HUD_VIEW_X, finalY = HUD_VIEW_Y;
  const showInvItems = pauseState === 'inv-items-in' || pauseState === 'inventory' || pauseState === 'inv-items-out' ||
    pauseState === 'inv-target' || pauseState === 'inv-heal';
  if (!showInvItems) return;
  const fadedPal = _makeFadedPal(_pauseFadeStep('inv-items-in', 'inv-items-out'));
  const entries = Object.entries(playerInventory).filter(([,c]) => c > 0);
  const maxVisible = Math.floor((HUD_VIEW_H - 16) / 14);
  const startIdx = Math.max(0, Math.min(pauseInvScroll, Math.max(0, entries.length - maxVisible)));
  for (let i = 0; i < maxVisible && startIdx + i < entries.length; i++) {
    const [id, count] = entries[startIdx + i];
    const nameBytes = getItemNameClean(Number(id));
    const countStr = String(count);
    const rowBytes = _buildItemRowBytes(nameBytes, countStr);
    const iy = finalY + 12 + i * 14;
    drawText(ctx, px + 24, iy, rowBytes, fadedPal);
    if (pauseHeldItem >= 0 && startIdx + i === pauseHeldItem && pauseState !== 'inv-target' && pauseState !== 'inv-heal')
      _drawCursorFaded(px + 8, iy - 4, fadeStep);
    if (startIdx + i === pauseInvScroll && pauseState !== 'inv-target' && pauseState !== 'inv-heal') {
      const activeX = pauseHeldItem >= 0 ? px + 4 : px + 8;
      _drawCursorFaded(activeX, iy - 4, fadeStep);
    }
  }
}
function _drawPauseEquipSlots() {
  const px = HUD_VIEW_X, finalY = HUD_VIEW_Y;
  const showEqSlots = pauseState === 'eq-slots-in' || pauseState === 'equip' || pauseState === 'eq-slots-out' ||
    pauseState === 'eq-items-in' || pauseState === 'eq-item-select' || pauseState === 'eq-items-out';
  if (!showEqSlots) return;
  const fadedPal = _makeFadedPal(_pauseFadeStep('eq-slots-in', 'eq-slots-out'));
  const EQ_LABELS = [
    new Uint8Array([0x9B,0xC4,0x91,0xCA,0xD7,0xCD]),
    new Uint8Array([0x95,0xC4,0x91,0xCA,0xD7,0xCD]),
    new Uint8Array([0x91,0xCE,0xCA,0xCD]),
    new Uint8Array([0x8B,0xD8,0xCD,0xE2]),
    new Uint8Array([0x8A,0xDB,0xD6,0xDC]),
  ];
  const EQ_IDS = [-100, -101, -102, -103, -104];
  const eqRowH = 22;
  const eqStartY = finalY + 12;
  const dimSlots = pauseState === 'eq-items-in' || pauseState === 'eq-item-select' || pauseState === 'eq-items-out';
  for (let r = 0; r < 5; r++) {
    const slotId = getEquipSlotId(EQ_IDS[r]);
    const label = EQ_LABELS[r];
    const iy = eqStartY + r * eqRowH;
    const labelPal  = dimSlots ? [0x0F, 0x0F, 0x0F, 0x00] : fadedPal;
    const activePal = (dimSlots && r === eqCursor) ? fadedPal : labelPal;
    drawText(ctx, px + 24, iy, label, activePal);
    if (slotId !== 0) {
      drawText(ctx, px + 24, iy + 9, getItemNameClean(slotId), activePal);
    } else {
      drawText(ctx, px + 24, iy + 9, new Uint8Array([0xC2,0xC2,0xC2]), activePal);
    }
  }
  const optY   = eqStartY + 5 * eqRowH + 4;
  const optPal  = dimSlots ? [0x0F, 0x0F, 0x0F, 0x00] : fadedPal;
  const optText = new Uint8Array([0x98,0xD9,0xDD,0xD2,0xD6,0xDE,0xD6]);
  drawText(ctx, px + 24, optY, optText, optPal);
  if (cursorTileCanvas && pauseState === 'equip' && fadeStep === 0) {
    const curY = eqCursor < 5 ? eqStartY + eqCursor * eqRowH - 4 : optY - 4;
    ctx.drawImage(cursorTileCanvas, px + 8, curY);
  }
}
function _drawPauseEquipItems() {
  const px = HUD_VIEW_X, finalY = HUD_VIEW_Y;
  const showEqItems = pauseState === 'eq-items-in' || pauseState === 'eq-item-select' || pauseState === 'eq-items-out';
  if (!showEqItems) return;
  const fadedPal = _makeFadedPal(_pauseFadeStep('eq-items-in', 'eq-items-out'));
  const listX = px + 24;
  const listY = finalY + 12 + eqCursor * 22 + 22;
  const maxBelow = Math.floor((finalY + HUD_VIEW_H - 16 - listY) / 12);
  const useY = maxBelow >= eqItemList.length ? listY : finalY + 12;
  if (eqItemList.length === 0) {
    drawText(ctx, listX, useY, new Uint8Array([0xC2,0xC2,0xC2]), fadedPal);
  } else {
    for (let i = 0; i < eqItemList.length; i++) {
      const entry = eqItemList[i];
      const iy = useY + i * 12;
      if (iy + 8 > finalY + HUD_VIEW_H - 8) break;
      if (entry.label === 'remove') {
        drawText(ctx, listX + 16, iy, new Uint8Array([0x9B,0xCE,0xD6,0xD8,0xDF,0xCE]), fadedPal);
      } else {
        drawText(ctx, listX + 16, iy, getItemNameClean(entry.id), fadedPal);
      }
    }
    if (cursorTileCanvas && pauseState === 'eq-item-select' && fadeStep === 0) {
      ctx.drawImage(cursorTileCanvas, listX, useY + eqItemCursor * 12 - 4);
    }
  }
}
function drawPauseMenu() {
  if (pauseState === 'none') return;
  _drawPauseBox();
  _clipToViewport();
  _drawPauseMenuText();
  _drawPauseInventory();
  _drawPauseEquipSlots();
  _drawPauseEquipItems();
  ctx.restore();
  // Target cursor on portrait — drawn after restore so it's unclipped
  if (pauseState === 'inv-target' && cursorTileCanvas) {
    if (pauseInvAllyTarget >= 0) {
      const visRow = pauseInvAllyTarget - rosterScroll;
      if (visRow >= 0 && visRow < ROSTER_VISIBLE) {
        ctx.drawImage(cursorTileCanvas, HUD_RIGHT_X - 4, HUD_VIEW_Y + 32 + visRow * ROSTER_ROW_H + 12);
      }
    } else {
      ctx.drawImage(cursorTileCanvas, HUD_RIGHT_X - 4, HUD_VIEW_Y + 12);
    }
  }
}


// --- Slash Sprites (procedural) ---

function _decode2BPPTiles(imgData, tiles, layout, pal) {
  for (let t = 0; t < tiles.length; t++) {
    const [ox, oy] = layout[t]; const d = tiles[t];
    for (let row = 0; row < 8; row++) {
      const lo = d[row], hi = d[row + 8];
      for (let bit = 7; bit >= 0; bit--) {
        const val = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
        if (val === 0) continue;
        const rgb = NES_SYSTEM_PALETTE[pal[val]] || [252, 252, 252];
        const di = ((oy + row) * 16 + ox + (7 - bit)) * 4;
        imgData.data[di] = rgb[0]; imgData.data[di+1] = rgb[1]; imgData.data[di+2] = rgb[2]; imgData.data[di+3] = 255;
      }
    }
  }
}
function _buildSwordSlashFrame(tiles, pal) {
  const c = _makeCanvas16();
  const cctx = c.getContext('2d'); const img = cctx.createImageData(16, 16);
  _decode2BPPTiles(img, tiles, [[0, 0], [8, 0]], pal);
  cctx.putImageData(img, 0, 0); return c;
}
function initSlashSprites() {
  const TILE_DATA = [
    new Uint8Array([0x01,0x09,0x4E,0x3C,0x18,0xF8,0x30,0x10, 0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00]),
    new Uint8Array([0x00,0x20,0xE8,0x30,0x10,0x0C,0x08,0x00, 0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00]),
    new Uint8Array([0x10,0x30,0xF8,0x18,0x3C,0x4E,0x09,0x01, 0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00]),
    new Uint8Array([0x00,0x08,0x0C,0x10,0x30,0xE8,0x20,0x00, 0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00]),
  ];
  const c = _makeCanvas16();
  const sctx = c.getContext('2d'); const imgData = sctx.createImageData(16, 16);
  _decode2BPPTiles(imgData, TILE_DATA, [[0,0],[8,0],[0,8],[8,8]], [0x0F, 0x16, 0x27, 0x30]);
  sctx.putImageData(imgData, 0, 0);
  slashFramesR = [c, c, c]; slashFramesL = [c, c, c]; slashFrames = slashFramesR;
}

function _putPx16(img, x, y, rgb) {
  if (x < 0 || x >= 16 || y < 0 || y >= 16) return;
  const di = (y * 16 + x) * 4;
  img.data[di] = rgb[0]; img.data[di+1] = rgb[1]; img.data[di+2] = rgb[2]; img.data[di+3] = 255;
}

function initKnifeSlashSprites() {
  const white = NES_SYSTEM_PALETTE[0x30], light = NES_SYSTEM_PALETTE[0x2B], dark = NES_SYSTEM_PALETTE[0x1B];
  const FULL_LINE = Array.from({length: 15}, (_, i) => [14 - i, i]);
  const frames = [];
  for (let f = 0; f < 3; f++) {
    const c = _makeCanvas16();
    const cctx = c.getContext('2d'); const img = cctx.createImageData(16, 16);
    const startI = f === 0 ? 0 : f === 1 ? 0 : 7, endI = f === 1 ? 15 : f === 0 ? 7 : 15;
    for (let i = startI; i < endI; i++) {
      const [x, y] = FULL_LINE[i];
      _putPx16(img, x, y, white); _putPx16(img, x + 1, y, light); _putPx16(img, x, y + 1, light);
      if (f === 2 && i < 10) { _putPx16(img, x, y, dark); _putPx16(img, x + 1, y, dark); }
    }
    cctx.putImageData(img, 0, 0); frames.push(c);
  }
  knifeSlashFramesR = frames; knifeSlashFramesL = frames;
}

function initSwordSlashSprites() {
  const PAL = [0x0F, 0x00, 0x32, 0x30];
  const D = new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x03, 0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x03]);
  const E = new Uint8Array([0x00,0x04,0x00,0x18,0x30,0x60,0xC0,0x80, 0x02,0x10,0x28,0x00,0x60,0xC0,0x80,0x00]);
  const F = new Uint8Array([0x07,0x0E,0x1C,0x38,0x70,0xE0,0xC0,0x80, 0x07,0x0E,0x1C,0x38,0x70,0xE0,0xC0,0x80]);
  swordSlashFramesR = swordSlashFramesL = [[D,E],[D,F],[E,F]].map(t => _buildSwordSlashFrame(t, PAL));
}

// --- Battle System ---

// calcDamage, rollHits → battle-math.js

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
  if (isPVPBattle) {
    for (let i = 0; i < pvpEnemyAllies.length; i++) {
      if (pvpEnemyAllies[i].hp > 0)
        actors.push({ type: 'pvp-enemy-ally', index: i, priority: Math.floor(Math.random() * 256) });
    }
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
  let ti = playerActionPending.targetIndex;
  if (isRandomEncounter && encounterMonsters && ti >= 0 && encounterMonsters[ti].hp <= 0) {
    const living = encounterMonsters.findIndex(m => m.hp > 0);
    if (living < 0) { processNextTurn(); return; } // all dead — skip, victory will trigger
    ti = living;
  }
  currentHitIdx = 0; slashFrame = 0;
  hitResults = playerActionPending.hitResults;
  targetIndex = ti;
  slashFrames = playerActionPending.slashFrames;
  slashOffX = playerActionPending.slashOffX; slashOffY = playerActionPending.slashOffY;
  slashX = playerActionPending.slashX; slashY = playerActionPending.slashY;
  battleState = 'attack-start'; battleTimer = 0;
}

function _playerTurnSouthWind() {
  const _mode = playerActionPending.targetMode || 'single';
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
  else southWindTargets = [playerActionPending.target];
  southWindHitIdx = 0;
  const swAttack = Math.floor((playerStats ? playerStats.int : 5) / 2) + 55;
  swBaseDamage = Math.floor((swAttack + Math.floor(Math.random() * Math.floor(swAttack / 2 + 1))) / 2);
  battleState = 'sw-throw'; battleTimer = 0;
}

function _playerTurnConsumable() {
  playSFX(SFX.CURE);
  const { target, allyIndex } = playerActionPending;
  if (target === 'player' && (allyIndex === undefined || allyIndex < 0)) {
    const heal = Math.min(50, playerStats.maxHP - playerHP);
    playerHP += heal; itemHealAmount = heal; playerHealNum = { value: heal, timer: 0 };
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
      const maxHP = isPVPBattle && pvpOpponentStats ? pvpOpponentStats.maxHP : BOSS_MAX_HP;
      const heal = Math.min(50, maxHP - bossHP);
      bossHP += heal; itemHealAmount = heal; enemyHealNum = { value: heal, timer: 0, index: 0 };
    }
  }
  battleState = 'item-use'; battleTimer = 0;
}

function _playerTurnItem() {
  isDefending = false;
  removeItem(playerActionPending.itemId);
  if (ITEMS.get(playerActionPending.itemId)?.type === 'battle_item') _playerTurnSouthWind();
  else _playerTurnConsumable();
}

function _playerTurnRun() {
  const playerAgi = playerStats ? playerStats.agi : 5;
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
    isDefending = false; battleCursor = 0; battleState = 'menu-open'; battleTimer = 0; turnTimer = 0;
    return;
  }
  const turn = turnQueue.shift();
  if (turn.type === 'player') {
    const cmd = playerActionPending.command;
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
    const targetDef = allyTargetIndex >= 0 ? encounterMonsters[allyTargetIndex].def : (isPVPBattle && pvpOpponentStats ? pvpOpponentStats.def : BOSS_DEF);
    allyHitResult = rollHits(ally.atk, targetDef, 85, 1)[0];
    battleState = 'ally-attack-start'; battleTimer = 0;
  } else if (turn.type === 'pvp-enemy-ally') {
    const ea = pvpEnemyAllies[turn.index];
    if (!ea || ea.hp <= 0) { processNextTurn(); return; }
    pvpCurrentEnemyAllyIdx = turn.index; battleState = 'boss-flash'; battleTimer = 0;
  } else {
    pvpCurrentEnemyAllyIdx = -1; currentAttacker = turn.index; pvpOpponentHitsThisTurn = 0;
    if (turn.index >= 0 && encounterMonsters && encounterMonsters[turn.index].hp <= 0) { processNextTurn(); return; }
    battleState = 'boss-flash'; battleTimer = 0;
  }
}

function startPVPBattle(target) {
  isPVPBattle = true;
  isRandomEncounter = false;
  pvpOpponent = target;
  pvpOpponentStats = generateAllyStats(target);
  pvpOpponentIsDefending = false;
  pvpOpponentHitIdx = 0;
  pvpOpponentHitsThisTurn = 0;
  pvpEnemyAllies = [];
  pvpCurrentEnemyAllyIdx = -1;
  pvpBoxResizeStartTime = 0;
  bossHP = pvpOpponentStats.maxHP;
  bossDefeated = false;
  preBattleTrack = TRACKS.CRYSTAL_CAVE;
  // Use battle music (not boss music) for PVP
  battleState = 'flash-strobe';
  battleTimer = 0;
  _resetBattleVars();
  pauseMusic();
  playTrack(TRACKS.BATTLE);
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

// --- Battle update sub-handlers ---
// Each returns true if it handled the current battleState, false otherwise.
// Called in order from updateBattle; short-circuits on first match (mirrors old if-else chain).

function _updateBattleTimers(dt) {
  if (bossFlashTimer > 0) bossFlashTimer = Math.max(0, bossFlashTimer - dt);
  if (battleShakeTimer > 0) battleShakeTimer = Math.max(0, battleShakeTimer - dt);

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
    turnTimer = 0; itemHeldIdx = -1;
    playerActionPending = { command: 'skip' }; battleState = 'confirm-pause'; battleTimer = 0;
  }
}

function _isVictoryBattleState() {
  return battleState === 'victory-celebrate' || battleState === 'victory-text-in' ||
    battleState === 'victory-hold' || battleState === 'victory-fade-out' ||
    battleState === 'exp-text-in' || battleState === 'exp-hold' || battleState === 'exp-fade-out' ||
    battleState === 'gil-text-in' || battleState === 'gil-hold' || battleState === 'gil-fade-out' ||
    battleState === 'levelup-text-in' || battleState === 'levelup-hold' ||
    battleState === 'item-text-in' || battleState === 'item-hold' || battleState === 'item-fade-out' ||
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
      } else if (isPVPBattle) {
        battleState = 'boss-box-expand'; battleTimer = 0;
        // Music already started in startPVPBattle
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
    if (isPVPBattle) {
      // PVP: no dissolve-in — skip straight to fade-in
      if (battleTimer >= BOSS_BOX_EXPAND_MS) { battleState = 'battle-fade-in'; battleTimer = 0; }
    } else if (battleTimer >= BOSS_BLOCKS * BOSS_DISSOLVE_STEPS * BOSS_DISSOLVE_FRAME_MS) { battleState = 'battle-fade-in'; battleTimer = 0; }
  } else if (battleState === 'battle-fade-in') {
    if (battleTimer >= (BATTLE_TEXT_STEPS + 1) * BATTLE_TEXT_STEP_MS) { battleState = 'menu-open'; battleTimer = 0; }
  } else { return false; }
  return true;
}

function _tryJoinPVPEnemyAlly() {
  if (!isPVPBattle || pvpEnemyAllies.length >= 3) return false;
  const loc = getPlayerLocation();
  const inBattle = new Set([pvpOpponent && pvpOpponent.name, ...pvpEnemyAllies.map(a => a.name), ...battleAllies.map(a => a.name)]);
  const eligible = PLAYER_POOL.filter(p => p.loc === loc && !inBattle.has(p.name));
  if (eligible.length === 0 || Math.random() >= 0.3) return false;
  const pick = eligible[Math.floor(Math.random() * eligible.length)];
  const oldTotal = 1 + pvpEnemyAllies.length;
  const oldCols = oldTotal <= 1 ? 1 : 2, oldRows = oldTotal <= 2 ? 1 : 2;
  pvpBoxResizeFromW = oldCols * 24 + 16; pvpBoxResizeFromH = oldRows * 32 + 16;
  const _cx = HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2), _cy = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2);
  const _oldGP = [[oldRows-1,oldCols-1],[oldRows-1,0],[0,oldCols-1],[0,0]];
  pvpEnemySlidePosFrom = Array.from({length: oldTotal}, (_, i) => {
    const [gr, gc] = _oldGP[i] || [0, 0];
    return { x: _cx - oldCols*12 + gc*24 + 4, y: _cy - oldRows*16 + gr*32 + 4 };
  });
  pvpEnemyAllies.push(generateAllyStats(pick));
  battleState = 'pvp-ally-appear'; battleTimer = 0;
  return true;
}

function _tryJoinPlayerAlly() {
  if (isPVPBattle || battleAllies.length >= 3) return false;
  const loc = getPlayerLocation();
  const eligible = PLAYER_POOL.filter(p => p.loc === loc && !battleAllies.some(a => a.name === p.name));
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
      if (_tryJoinPVPEnemyAlly()) return true;
      if (_tryJoinPlayerAlly()) return true;
      turnQueue = buildTurnOrder(); processNextTurn();
    }
  } else { return false; }
  return true;
}

function _finalizeComboHits() {
  let totalDmg = 0, anyCrit = false, allMiss = true;
  for (const h of hitResults) {
    if (!h.miss) { totalDmg += h.damage; allMiss = false; if (h.crit) anyCrit = true; }
  }
  bossDamageNum = allMiss ? { miss: true, timer: 0 } : { value: totalDmg, crit: anyCrit, timer: 0 };
  battleState = 'player-damage-show';
  battleTimer = 0;
}
function _advanceHitCombo() {
  if (currentHitIdx + 1 < hitResults.length) {
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
    if (isBladed0 && !(hitResults[currentHitIdx] && hitResults[currentHitIdx].crit)) {
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
    const hit = hitResults[currentHitIdx];
    if (!hit.miss) {
      if (isRandomEncounter && encounterMonsters) {
        encounterMonsters[targetIndex].hp = Math.max(0, encounterMonsters[targetIndex].hp - hit.damage);
      } else {
        let dmgToApply = hit.damage;
        if (isPVPBattle && pvpOpponentIsDefending) dmgToApply = Math.max(1, Math.floor(dmgToApply / 2));
        bossHP = Math.max(0, bossHP - dmgToApply);
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
  const hitPause = (currentHitIdx + 1 < hitResults.length) ? 50 : HIT_PAUSE_MS;
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
    if (isRandomEncounter && encounterMonsters && encounterMonsters[targetIndex].hp <= 0) {
      dyingMonsterIndices = new Map([[targetIndex, 0]]);
      battleState = 'monster-death';
      battleTimer = 0;
      playSFX(SFX.MONSTER_DEATH);
    } else if (!isRandomEncounter && bossHP <= 0) {
      if (isPVPBattle) {
        const pvpExp = 5 * pvpOpponentStats.level;
        const pvpGil = 10 * pvpOpponentStats.level;
        encounterExpGained = pvpExp;
        encounterGilGained = pvpGil;
        grantExp(pvpExp);
        playerGil += pvpGil;
        _syncSaveSlotProgress();
        saveSlotsToDB();
        isDefending = false;
        bossDefeated = true;
        battleState = 'victory-name-out';
        battleTimer = 0;
      } else {
        battleState = 'boss-dissolve';
        battleTimer = 0;
        playSFX(SFX.BOSS_DEATH);
      }
    } else {
      processNextTurn();
    }
  }
  return true;
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
      playerGil += encounterGilGained;
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
      itemPage += (itemSlideDir < 0) ? 1 : -1;
      itemSlideDir = 0; itemPageCursor = itemSlideCursor; itemSlideCursor = 0;
      battleState = 'item-select'; battleTimer = 0;
    }
  } else if (battleState === 'item-cancel-out') {
    if (battleTimer >= FADE_DUR) { battleState = 'item-cancel-in'; battleTimer = 0; }
  } else if (battleState === 'item-cancel-in') {
    if (battleTimer >= FADE_DUR) { itemPage = 1; battleState = 'menu-open'; battleTimer = 0; }
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
    if (isPVPBattle) {
      const pvpExp = 5 * pvpOpponentStats.level;
      const pvpGil = 10 * pvpOpponentStats.level;
      encounterExpGained = pvpExp; encounterGilGained = pvpGil;
      grantExp(pvpExp); playerGil += pvpGil;
      _syncSaveSlotProgress();
      saveSlotsToDB();
      isDefending = false; bossDefeated = true;
      battleState = 'victory-name-out'; battleTimer = 0;
    } else {
      battleState = 'boss-dissolve'; battleTimer = 0; playSFX(SFX.BOSS_DEATH);
    }
  } else {
    processNextTurn();
  }
}

function _updateAllyJoin() {
  if (battleState === 'pvp-ally-appear') {
    if (battleTimer >= PVP_BOX_RESIZE_MS) { turnQueue = buildTurnOrder(); processNextTurn(); }
    return true;
  }
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
      const bladed = ally && isBladedWeapon(ally.weaponId);
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
        if (allyTargetIndex >= 0 && encounterMonsters) {
          encounterMonsters[allyTargetIndex].hp = Math.max(0, encounterMonsters[allyTargetIndex].hp - allyHitResult.damage);
        } else if (allyTargetIndex < 0) {
          bossHP = Math.max(0, bossHP - allyHitResult.damage);
        }
        if (allyHitResult.crit) critFlashTimer = 0;
        bossDamageNum = { value: allyHitResult.damage, crit: allyHitResult.crit, timer: 0 };
        targetIndex = allyTargetIndex;
      } else {
        bossDamageNum = { miss: true, timer: 0 };
        targetIndex = allyTargetIndex;
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

function _processBossFlash() {
  if (battleState !== 'boss-flash' || battleTimer < BOSS_PREFLASH_MS) return false;
  const livingAllies = battleAllies.filter(a => a.hp > 0);
  let targetAlly = -1;
  if (livingAllies.length > 0 && !(isPVPBattle && pvpCurrentEnemyAllyIdx < 0)) {
    if (Math.random() >= 1 / (1 + livingAllies.length)) {
      const allyOptions = battleAllies.map((a, i) => a.hp > 0 ? i : -1).filter(i => i >= 0);
      targetAlly = allyOptions[Math.floor(Math.random() * allyOptions.length)];
    }
  }
  pvpOpponentIsDefending = (isPVPBattle && targetAlly < 0) ? Math.random() < 0.30 : false;
  const monHitRate = (currentAttacker >= 0 && encounterMonsters)
    ? (encounterMonsters[currentAttacker].hitRate || GOBLIN_HIT_RATE) : BOSS_HIT_RATE;
  const monAtk = isPVPBattle
    ? (pvpCurrentEnemyAllyIdx >= 0 ? pvpEnemyAllies[pvpCurrentEnemyAllyIdx].atk : pvpOpponentStats.atk)
    : (currentAttacker >= 0 && encounterMonsters) ? encounterMonsters[currentAttacker].atk : BOSS_ATK;
  if (targetAlly >= 0) {
    enemyTargetAllyIdx = targetAlly;
    if (Math.random() * 100 < monHitRate) {
      let dmg = calcDamage(monAtk, battleAllies[targetAlly].def);
      battleAllies[targetAlly].hp = Math.max(0, battleAllies[targetAlly].hp - dmg);
      allyDamageNums[targetAlly] = { value: dmg, timer: 0 };
      allyShakeTimer[targetAlly] = BATTLE_SHAKE_MS;
      playSFX(SFX.ATTACK_HIT); battleState = 'ally-hit'; battleTimer = 0;
    } else {
      allyDamageNums[targetAlly] = { miss: true, timer: 0 };
      battleState = 'ally-damage-show-enemy'; battleTimer = 0;
    }
  } else {
    if (Math.random() * 100 < monHitRate) {
      let dmg = calcDamage(monAtk, playerDEF);
      if (isDefending) dmg = Math.max(1, Math.floor(dmg / 2));
      playerHP = Math.max(0, playerHP - dmg);
      playerDamageNum = { value: dmg, timer: 0 };
      playSFX(SFX.ATTACK_HIT); battleShakeTimer = BATTLE_SHAKE_MS;
      battleState = 'enemy-attack'; pvpOpponentHitIdx++; battleTimer = 0;
    } else {
      playerDamageNum = { miss: true, timer: 0 };
      battleState = 'enemy-damage-show'; battleTimer = 0;
    }
  }
  return true;
}

function _processEnemyDamageShow() {
  if (battleTimer < BATTLE_DMG_SHOW_MS) return;
  if (playerHP <= 0) {
    isDefending = false; battleState = 'defeat-monster-fade'; battleTimer = 0;
  } else if (isPVPBattle && pvpCurrentEnemyAllyIdx < 0 && pvpOpponentHitsThisTurn === 0) {
    const oppL = pvpOpponent && pvpOpponent.weaponL, oppR = pvpOpponent && pvpOpponent.weaponR;
    if ((oppL != null && isWeapon(oppL)) || (!isWeapon(oppR) && !isWeapon(oppL))) {
      pvpOpponentHitsThisTurn = 1; battleState = 'pvp-second-windup'; battleTimer = 0;
    } else { processNextTurn(); }
  } else { processNextTurn(); }
}

function _processPVPSecondWindup() {
  if (battleTimer < BOSS_PREFLASH_MS) return;
  const monAtk2 = pvpOpponentStats.atk;
  if (Math.random() * 100 < BOSS_HIT_RATE) {
    let dmg2 = calcDamage(monAtk2, playerDEF);
    if (isDefending) dmg2 = Math.max(1, Math.floor(dmg2 / 2));
    playerHP = Math.max(0, playerHP - dmg2);
    playerDamageNum = { value: dmg2, timer: 0 }; playSFX(SFX.ATTACK_HIT);
    battleShakeTimer = BATTLE_SHAKE_MS; battleState = 'enemy-attack'; battleTimer = 0;
  } else { playerDamageNum = { miss: true, timer: 0 }; battleState = 'enemy-damage-show'; battleTimer = 0; }
}

function _updateBattleEnemyTurn() {
  if (_processBossFlash()) return true;
  if (battleState === 'enemy-attack') {
    if (battleTimer >= BATTLE_SHAKE_MS) { battleState = 'enemy-damage-show'; battleTimer = 0; }
  } else if (battleState === 'enemy-damage-show') { _processEnemyDamageShow();
  } else if (battleState === 'pvp-second-windup') { _processPVPSecondWindup();
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
    grantExp(20); playerGil += encounterGilGained;
    if (saveSlots[selectCursor]) {
      saveSlots[selectCursor].level = playerStats.level;
      saveSlots[selectCursor].exp = playerStats.exp;
      saveSlots[selectCursor].stats = _playerStatsSnapshot();
      saveSlots[selectCursor].inventory = { ...playerInventory };
    }
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
      const wasPVP = isPVPBattle;
      battleState = 'none'; battleTimer = 0; sprite.setDirection(DIR_DOWN);
      battleAllies = []; allyJoinRound = 0;
      isPVPBattle = false; pvpOpponent = null; pvpOpponentStats = null;
      pvpOpponentIsDefending = false; pvpEnemyAllies = [];
      if (wasPVP) { stopMusic(); resumeMusic(); } else playTrack(TRACKS.CRYSTAL_ROOM);
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
      battleState = 'none'; battleTimer = 0;
      isRandomEncounter = false; isPVPBattle = false;
      pvpOpponent = null; pvpOpponentStats = null; pvpOpponentIsDefending = false; pvpEnemyAllies = [];
      encounterMonsters = null; turnQueue = []; battleAllies = []; allyJoinRound = 0;
      playerHP = playerStats ? playerStats.maxHP : 28;
      playerMP = playerStats ? playerStats.maxMP : 0;
      startWipeTransition(() => {
        dungeonFloor = -1; encounterSteps = 0; mapStack = [];
        loadWorldMapAt(findWorldExitIndex(111));
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
      if (wpnSt === 'knife' && battleKnifeBladeCanvas) ctx.drawImage(battleKnifeBladeCanvas, px + 8, py - 7);
      else if (wpnSt === 'dagger' && battleDaggerBladeCanvas) ctx.drawImage(battleDaggerBladeCanvas, px + 8, py - 7);
      else if (wpnSt === 'sword' && battleSwordBladeCanvas) ctx.drawImage(battleSwordBladeCanvas, px + 8, py - 7);
    } else if (!before && !rightHand) {
      if (wpnSt === 'knife' && battleKnifeBladeCanvas) ctx.drawImage(battleKnifeBladeCanvas, px + 8, py - 7);
      else if (wpnSt === 'dagger' && battleDaggerBladeCanvas) ctx.drawImage(battleDaggerBladeCanvas, px + 8, py - 7);
      else if (wpnSt === 'sword' && battleSwordBladeCanvas) ctx.drawImage(battleSwordBladeCanvas, px + 8, py - 7);
    }
  } else if (!before && battleState === 'player-slash') {
    if (wpnSt === 'knife' && battleKnifeBladeSwungCanvas) ctx.drawImage(battleKnifeBladeSwungCanvas, px - 16, py + 1);
    else if (wpnSt === 'dagger' && battleDaggerBladeSwungCanvas) ctx.drawImage(battleDaggerBladeSwungCanvas, px - 16, py + 1);
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
  if (battleState === 'item-use' && cureSparkleFrames.length === 2 && !(playerActionPending && playerActionPending.allyIndex >= 0)) {
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
  if (battleState === 'item-target-select' && itemTargetType === 'player' && itemTargetAllyIndex < 0 && cursorTileCanvas) {
    ctx.drawImage(cursorTileCanvas, px - 12, py + 4);
  }
}

function _drawBattlePortrait() {
  const shakeOff = (battleState === 'enemy-attack' && battleShakeTimer > 0)
    ? (Math.floor(battleShakeTimer / 67) & 1 ? 2 : -2) : 0;
  const isVictoryPose = _isVictoryBattleState();
  const isAttackPose = battleState === 'attack-start' || battleState === 'player-slash';
  const isHitPose = battleState === 'enemy-attack' ||
    (battleState === 'enemy-damage-show' && playerDamageNum && !playerDamageNum.miss);
  const isDefendPose = battleState === 'defend-anim';
  const isItemUsePose = battleState === 'item-use' || battleState === 'sw-throw' || battleState === 'sw-hit';
  const isRunPose = battleState === 'run-name-out' || battleState === 'run-text-in' ||
    battleState === 'run-hold' || battleState === 'run-text-out';
  const isNearFatal = playerHP > 0 && playerStats && playerHP <= Math.floor(playerStats.maxHP / 4);
  const portraitSrc = _getPortraitSrc(isNearFatal, isAttackPose, isHitPose, isDefendPose, isItemUsePose, isVictoryPose);
  if (!portraitSrc) return;
  const px = HUD_RIGHT_X + 8 + shakeOff;
  const py = HUD_VIEW_Y + 8;
  if (isAttackPose) _drawPortraitWeapon(px, py, true);
  _drawPortraitFrame(px, py, portraitSrc, isRunPose);
  if (isAttackPose) _drawPortraitWeapon(px, py, false);
  _drawPortraitOverlays(px, py, isDefendPose, isItemUsePose, isNearFatal, isRunPose, isAttackPose, isHitPose, isVictoryPose);
}

function _drawBattleCritFlash() {
  if (critFlashTimer < 0) return;
  if (critFlashTimer === 0) critFlashTimer = Date.now();
  if (Date.now() - critFlashTimer < 17) {
    ctx.save();
    ctx.beginPath(); ctx.rect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H); ctx.clip();
    ctx.fillStyle = '#DAA336';
    ctx.fillRect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);
    ctx.restore();
  } else { critFlashTimer = -1; }
}
function _drawBattleStrobeFlash() {
  if (battleState !== 'flash-strobe') return;
  if (!(Math.floor(battleTimer / BATTLE_FLASH_FRAME_MS) & 1)) return;
  ctx.save();
  ctx.beginPath(); ctx.rect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H); ctx.clip();
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
      ctx.fillRect(ecx - 24, ecy - 24, 48, 48);
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
    const pageOff = (pg - itemPage) * rightAreaW + slidePixel;
    const px = baseX + pageOff;
    if (px > baseX + rightAreaW || px < baseX - rightAreaW) continue;
    if (pg === 0) {
      const RH_LABEL = new Uint8Array([0x9B,0x91,0xFF]);
      const LH_LABEL = new Uint8Array([0x95,0x91,0xFF]);
      const rName = playerWeaponR !== 0 ? getItemNameClean(playerWeaponR) : new Uint8Array([0xC2,0xC2,0xC2]);
      const rRow = new Uint8Array(RH_LABEL.length + rName.length);
      rRow.set(RH_LABEL, 0); rRow.set(rName, RH_LABEL.length);
      drawText(ctx, px + 8, topY, rRow, invPal);
      const lName = playerWeaponL !== 0 ? getItemNameClean(playerWeaponL) : new Uint8Array([0xC2,0xC2,0xC2]);
      const lRow = new Uint8Array(LH_LABEL.length + lName.length);
      lRow.set(LH_LABEL, 0); lRow.set(lName, LH_LABEL.length);
      drawText(ctx, px + 8, topY + rowH + 6, lRow, invPal);
    } else {
      const startIdx = (pg - 1) * INV_SLOTS;
      for (let r = 0; r < INV_SLOTS; r++) {
        const idx = startIdx + r;
        if (idx >= itemSelectList.length) break;
        const item = itemSelectList[idx];
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
  if (itemHeldIdx !== -1) {
    const heldIsEq = itemHeldIdx <= -100;
    const heldPage = heldIsEq ? 0 : 1 + Math.floor(itemHeldIdx / INV_SLOTS);
    const heldRow  = heldIsEq ? -(itemHeldIdx + 100) : itemHeldIdx % INV_SLOTS;
    if (heldPage === itemPage) ctx.drawImage(cursorTileCanvas, curPx, rowY(heldPage, heldRow) - 4);
  }
  const activeX = itemHeldIdx !== -1 ? curPx - 4 : curPx;
  ctx.drawImage(cursorTileCanvas, activeX, rowY(itemPage, itemPageCursor) - 4);
}
function _drawBattleItemPanel(menuX) {
  const ITEM_SLIDE_MS = 200;
  const rightAreaW = CANVAS_W - BATTLE_PANEL_W - 8;
  const invPal = [0x0F, 0x0F, 0x0F, 0x30];
  let invFadeStep = 0;
  if (battleState === 'item-list-in') invFadeStep = BATTLE_TEXT_STEPS - Math.min(Math.floor(battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
  else if (battleState === 'item-cancel-out' || battleState === 'item-list-out') invFadeStep = Math.min(Math.floor(battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
  for (let s = 0; s < invFadeStep; s++) invPal[3] = nesColorFade(invPal[3]);
  const totalInvPages = Math.max(1, Math.ceil(itemSelectList.length / INV_SLOTS));
  let slidePixel = 0;
  if (battleState === 'item-slide') slidePixel = itemSlideDir * Math.min(battleTimer / ITEM_SLIDE_MS, 1) * rightAreaW;
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
    bs === 'enemy-attack' || bs === 'enemy-damage-show' || bs === 'message-hold' ||
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
    const enemyName = _battleEnemyName();
    drawText(ctx, Math.floor((boxW - measureText(enemyName)) / 2), HUD_BOT_Y + Math.floor((boxH - 8) / 2), enemyName, fadedPal);
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
  const curX = positions[battleCursor][0] - 16;
  const curY = positions[battleCursor][1] - 4;
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
    const isBeingHit = (i === targetIndex &&
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
      const curHit = hitResults && hitResults[currentHitIdx];
      const isHitBlink = (isBeingHit && battleState === 'player-slash' && curHit && !curHit.miss && (Math.floor(battleTimer / 60) & 1)) ||
                         (isBeingHit && battleState === 'ally-slash' && allyHitResult && !allyHitResult.miss && (Math.floor(battleTimer / 60) & 1));
      const isFlashing = battleState === 'boss-flash' && currentAttacker === i && Math.floor(battleTimer / 33) % 2 === 1;
      if (!isHitBlink) ctx.drawImage(isFlashing ? sprWhite : sprNormal, drawX, drawY);
    }
  }

  if (battleState === 'player-slash' && slashFrames && slashFrame < SLASH_FRAMES && hitResults && hitResults[currentHitIdx] && !hitResults[currentHitIdx].miss) {
    const pos = gridPos[targetIndex];
    ctx.drawImage(slashFrames[slashFrame], pos.x - slideOffX + slashOffX + 8, slotCenterY(targetIndex) + slashOffY);
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
  ctx.restore();
}

function _drawEncounterCursors(gridPos, count, slotCenterY) {
  if (!(battleState === 'target-select' || (battleState === 'item-target-select' && itemTargetType === 'enemy')) || !cursorTileCanvas) return;
  if (battleState === 'target-select') {
    const pos = gridPos[targetIndex];
    ctx.drawImage(cursorTileCanvas, pos.x - 10, slotCenterY(targetIndex) - 4);
  } else if (itemTargetMode === 'single') {
    const pos = gridPos[itemTargetIndex];
    if (pos) ctx.drawImage(cursorTileCanvas, pos.x - 10, slotCenterY(itemTargetIndex) - 4);
  } else if (Math.floor(Date.now() / 133) & 1) {
    const _rightCols = count === 1 ? [0] : count === 2 ? [1] : [1, 3];
    const _leftCols  = count === 2 ? [0] : count >= 3 ? [0, 2] : [];
    let targets = [];
    if (itemTargetMode === 'all') targets = encounterMonsters.map((m, i) => m.hp > 0 ? i : -1).filter(i => i >= 0);
    else if (itemTargetMode === 'col-right') targets = _rightCols.filter(i => i < count && encounterMonsters[i]?.hp > 0);
    else if (itemTargetMode === 'col-left') targets = _leftCols.filter(i => i < count && encounterMonsters[i]?.hp > 0);
    for (const ti of targets) if (gridPos[ti]) ctx.drawImage(cursorTileCanvas, gridPos[ti].x - 10, slotCenterY(ti) - 4);
  }
}

function drawEncounterBox() {
  if (!isRandomEncounter || !encounterMonsters) return;
  const isExpand = battleState === 'encounter-box-expand';
  const isClose = battleState === 'encounter-box-close' || battleState === 'defeat-close';
  const isSlideIn = battleState === 'monster-slide-in';
  const isCombat = isSlideIn || battleState === 'battle-fade-in' || battleState === 'menu-open' ||
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
  const isVictory = _isVictoryBattleState() || battleState === 'victory-name-out';
  if (!isExpand && !isClose && !isCombat && !isVictory) return;

  const count = encounterMonsters.length;
  const { fullW, fullH, sprH } = _encounterBoxDims();
  const centerX = HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2);
  const centerY = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2);

  let boxW = fullW, boxH = fullH;
  if (isExpand || isClose) {
    const t = isExpand ? Math.min(battleTimer / BOSS_BOX_EXPAND_MS, 1) : 1 - Math.min(battleTimer / BOSS_BOX_EXPAND_MS, 1);
    boxW = Math.max(16, Math.ceil(fullW * t / 8) * 8);
    boxH = Math.max(16, Math.ceil(fullH * t / 8) * 8);
  }
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

function _drawPVPEnemyCell(enemy, idx, gridPos, intLeft, intTop, cellW, cellH, resizeT) {
  const [gr, gc] = gridPos[idx] || [0, 0];
  const targetX = intLeft + gc * cellW + 4;
  const targetY = intTop  + gr * cellH + 4;
  let sprX = targetX, sprY = targetY;
  if (battleState === 'pvp-ally-appear' && pvpEnemySlidePosFrom[idx]) {
    const from = pvpEnemySlidePosFrom[idx];
    sprX = Math.round(from.x + (targetX - from.x) * resizeT);
    sprY = Math.round(from.y + (targetY - from.y) * resizeT);
  }
  const isMain = idx === 0;
  const palIdx = enemy.palIdx;
  const fullBody = fakePlayerFullBodyCanvases[palIdx] || fakePlayerFullBodyCanvases[0];
  if (!fullBody) return;
  if (isMain && bossDefeated) return;

  const isThisAttacking = isMain ? pvpCurrentEnemyAllyIdx < 0 : pvpCurrentEnemyAllyIdx === idx - 1;
  const isOppHit = isMain && (
    (battleState === 'player-slash' && hitResults && hitResults[currentHitIdx] && !hitResults[currentHitIdx].miss) ||
    battleState === 'player-hit-show' || battleState === 'player-damage-show' ||
    (battleState === 'ally-slash' && allyHitResult && !allyHitResult.miss) ||
    battleState === 'ally-damage-show');
  const blinkHidden = isMain && (
    (battleState === 'player-slash' && hitResults && hitResults[currentHitIdx] && !hitResults[currentHitIdx].miss) ||
    (battleState === 'ally-slash' && allyHitResult && !allyHitResult.miss)
  ) && (Math.floor(battleTimer / 60) & 1);
  const flashFrame = isThisAttacking && (battleState === 'boss-flash' || battleState === 'pvp-second-windup')
    ? Math.floor(battleTimer / (BOSS_PREFLASH_MS / 8)) : 0;
  const flashHidden = isThisAttacking && (battleState === 'boss-flash' || battleState === 'pvp-second-windup') && (flashFrame & 1);
  if (blinkHidden || flashHidden) return;

  let poseSrc = null;
  if (isOppHit && fakePlayerHitPortraits[palIdx]) poseSrc = fakePlayerHitPortraits[palIdx][0];

  if (isOppHit && fakePlayerHitFullBodyCanvases[palIdx]) {
    ctx.drawImage(fakePlayerHitFullBodyCanvases[palIdx], sprX, sprY);
  } else if (poseSrc) {
    ctx.drawImage(fullBody, 0, 16, 16, 8, sprX, sprY + 16, 16, 8);
    ctx.save(); ctx.translate(sprX + 16, sprY); ctx.scale(-1, 1);
    ctx.drawImage(poseSrc, 0, 0); ctx.restore();
  } else {
    ctx.drawImage(fullBody, sprX, sprY);
  }

  if (isMain) {
    if (battleState === 'player-slash' && slashFrames && slashFrame < SLASH_FRAMES &&
        hitResults && hitResults[currentHitIdx] && !hitResults[currentHitIdx].miss) {
      ctx.drawImage(slashFrames[slashFrame], sprX + slashOffX, sprY + slashOffY);
    }
    if (battleState === 'ally-slash' && allyHitResult && !allyHitResult.miss) {
      const ally = battleAllies[currentAllyAttacker];
      const aSlashF = ally ? getSlashFramesForWeapon(ally.weaponId, true) : slashFramesR;
      const af = Math.min(Math.floor(battleTimer / 67), 2);
      if (aSlashF && aSlashF[af]) ctx.drawImage(aSlashF[af], sprX + [0,10,-8][af], sprY + [0,-6,8][af]);
    }
  }
}

function _drawBossSpriteBoxPVP(centerX, centerY) {
  const isExpand = battleState === 'boss-box-expand';
  const isClose = battleState === 'boss-box-close' || (!isRandomEncounter && battleState === 'defeat-close');
  const totalEnemies = 1 + pvpEnemyAllies.length;
  const cols = totalEnemies <= 1 ? 1 : 2;
  const rows = totalEnemies <= 2 ? 1 : 2;
  const cellW = 24, cellH = 32;
  const pvpBoxW = cols * cellW + 16;
  const pvpBoxH = rows * cellH + 16;

  _clipToViewport();
  ctx.imageSmoothingEnabled = false;

  let drawW = pvpBoxW, drawH = pvpBoxH;
  let resizeT = 1;
  if (isExpand) {
    const t = Math.min(battleTimer / BOSS_BOX_EXPAND_MS, 1);
    drawW = Math.max(16, Math.ceil(pvpBoxW * t / 8) * 8);
    drawH = Math.max(16, Math.ceil(pvpBoxH * t / 8) * 8);
  } else if (isClose) {
    const t = 1 - Math.min(battleTimer / BOSS_BOX_EXPAND_MS, 1);
    drawW = Math.max(16, Math.ceil(pvpBoxW * t / 8) * 8);
    drawH = Math.max(16, Math.ceil(pvpBoxH * t / 8) * 8);
  } else if (battleState === 'pvp-ally-appear') {
    resizeT = Math.min(battleTimer / PVP_BOX_RESIZE_MS, 1);
    drawW = Math.round(pvpBoxResizeFromW + (pvpBoxW - pvpBoxResizeFromW) * resizeT);
    drawH = Math.round(pvpBoxResizeFromH + (pvpBoxH - pvpBoxResizeFromH) * resizeT);
  }
  _drawBorderedBox(centerX - Math.floor(drawW / 2), centerY - Math.floor(drawH / 2), drawW, drawH);

  const visibleAllies = resizeT >= 1 ? pvpEnemyAllies.length : pvpEnemyAllies.length - 1;

  if (!isExpand && !isClose && battleState !== 'defeat-text') {
    const gridPos = [[rows-1,cols-1],[rows-1,0],[0,cols-1],[0,0]];
    const intLeft = centerX - cols * Math.floor(cellW / 2);
    const intTop  = centerY - rows * Math.floor(cellH / 2);
    const allEnemies = [pvpOpponentStats, ...pvpEnemyAllies.slice(0, visibleAllies)];
    allEnemies.forEach((enemy, idx) => {
      if (enemy) _drawPVPEnemyCell(enemy, idx, gridPos, intLeft, intTop, cellW, cellH, resizeT);
    });
  }

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
    if (slashFrames && slashFrame < SLASH_FRAMES && !bossDefeated && hitResults && hitResults[currentHitIdx] && !hitResults[currentHitIdx].miss)
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

  ctx.save();
  ctx.beginPath(); ctx.rect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H); ctx.clip();

  let boxW = fullW, boxH = fullH;
  if (isExpand || isClose) {
    const t = isExpand ? Math.min(battleTimer / BOSS_BOX_EXPAND_MS, 1) : 1 - Math.min(battleTimer / BOSS_BOX_EXPAND_MS, 1);
    boxW = Math.max(16, Math.ceil(fullW * t / 8) * 8);
    boxH = Math.max(16, Math.ceil(fullH * t / 8) * 8);
  }
  _drawBorderedBox(centerX - Math.floor(boxW / 2), centerY - Math.floor(boxH / 2), boxW, boxH);

  if (isExpand || isClose || battleState === 'defeat-text') { ctx.restore(); return; }

  _drawBossSprite(centerX, centerY);

  if ((battleState === 'target-select' || (battleState === 'item-target-select' && itemTargetType === 'enemy')) && cursorTileCanvas)
    ctx.drawImage(cursorTileCanvas, centerX - 32 - 16, centerY - 8);

  ctx.restore();
}
function drawBossSpriteBox() {
  if (isRandomEncounter) return;
  if (!isPVPBattle && !landTurtleBattleCanvas) return;

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
                   battleState.startsWith('ally-') || battleState === 'pvp-ally-appear' ||
                   battleState === 'defeat-monster-fade' || battleState === 'defeat-text';
  const isVictory = battleState === 'victory-name-out' || battleState === 'victory-celebrate' ||
                    battleState === 'victory-text-in' || battleState === 'victory-hold' || battleState === 'victory-fade-out' ||
                    battleState === 'exp-text-in' || battleState === 'exp-hold' || battleState === 'exp-fade-out' ||
                    battleState === 'gil-text-in' || battleState === 'gil-hold' || battleState === 'gil-fade-out' ||
                    battleState === 'levelup-text-in' || battleState === 'levelup-hold' ||
    battleState === 'item-text-in' || battleState === 'item-hold' || battleState === 'item-fade-out' ||
                    battleState === 'victory-text-out' || battleState === 'victory-menu-fade' || battleState === 'victory-box-close';
  if (!isExpand && !isClose && !isAppear && !isDissolve && !isCombat && !isVictory) return;

  const centerX = HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2);
  const centerY = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2);

  if (isPVPBattle) {
    _drawBossSpriteBoxPVP(centerX, centerY);
  } else {
    _drawBossSpriteBoxBoss(centerX, centerY);
  }
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
  if (isPVPBattle && pvpOpponentStats) return _nameToBytes(pvpOpponentStats.name);
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
           isOut, isMenuFadeState, isRunNameOut, isRunTextIn, isRunHold, isRunTextOut,
           isRunFailNameOut, isRunFailTextIn, isRunFailHold, isRunFailTextOut, isRunFailNameIn,
           isRun, isRunFail };
}
function _drawVictoryMessage(boxX, boxY, s) {
  let fadeStep = 0;
  if (s.isVicText || s.isExpText || s.isGilText || s.isItemText || s.isLevelText)
    fadeStep = BATTLE_TEXT_STEPS - Math.min(Math.floor(battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
  else if (s.isVicFadeOut || s.isExpFadeOut || s.isGilFadeOut || s.isItemFadeOut || s.isOut)
    fadeStep = Math.min(Math.floor(battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
  const fadedPal = [0x0F, 0x0F, 0x0F, 0x30];
  for (let i = 0; i < fadeStep; i++) fadedPal[3] = nesColorFade(fadedPal[3]);
  let msg;
  if (s.isVicText || s.isVicHold || s.isVicFadeOut) msg = BATTLE_VICTORY;
  else if (s.isExpText || s.isExpHold || s.isExpFadeOut) msg = makeExpText(encounterExpGained);
  else if (s.isGilText || s.isGilHold || s.isGilFadeOut) msg = makeGilText(encounterGilGained);
  else if (s.isItemText || s.isItemHold || s.isItemFadeOut) msg = encounterDropItem !== null ? makeFoundItemText(encounterDropItem) : null;
  else if (s.isLevelText || s.isLevelHold) msg = BATTLE_LEVEL_UP;
  else if (s.isOut) msg = leveledUp ? BATTLE_LEVEL_UP : encounterDropItem !== null ? makeFoundItemText(encounterDropItem) : makeGilText(encounterGilGained);
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
  const fadedPal = [0x0F, 0x0F, 0x0F, 0x30];
  if (isNameIn) {
    const fadeStep = BATTLE_TEXT_STEPS - Math.min(Math.floor(battleTimer / RUN_FAIL_STEP_MS), BATTLE_TEXT_STEPS);
    for (let s = 0; s < fadeStep; s++) fadedPal[3] = nesColorFade(fadedPal[3]);
    const enemyName = _battleEnemyName();
    const nameTw = measureText(enemyName);
    drawText(ctx, boxX + Math.floor((VICTORY_BOX_W - nameTw) / 2), boxY + Math.floor((VICTORY_BOX_H - 8) / 2), enemyName, fadedPal);
  } else {
    let fadeStep = isTextIn ? BATTLE_TEXT_STEPS - Math.min(Math.floor(battleTimer / RUN_FAIL_STEP_MS), BATTLE_TEXT_STEPS)
                            : isTextOut ? Math.min(Math.floor(battleTimer / RUN_FAIL_STEP_MS), BATTLE_TEXT_STEPS) : 0;
    for (let s = 0; s < fadeStep; s++) fadedPal[3] = nesColorFade(fadedPal[3]);
    const tw = measureText(BATTLE_CANT_ESCAPE);
    drawText(ctx, boxX + Math.floor((VICTORY_BOX_W - tw) / 2), boxY + Math.floor((VICTORY_BOX_H - 8) / 2), BATTLE_CANT_ESCAPE, fadedPal);
  }
}

function _dmgBounceY(baseY, timer) {
  // Authentic NES bounce from FCEUX trace — 26 keyframes at 60fps
  const frame = Math.min(Math.floor(timer / DMG_BOUNCE_FRAME_MS), DMG_BOUNCE_TABLE.length - 1);
  return baseY + DMG_BOUNCE_TABLE[frame];
}

function _drawAllyRow(i, ally, panelTop, weaponDraws) {
  const shakeOff = (allyShakeTimer[i] > 0) ? (Math.floor(allyShakeTimer[i] / 67) & 1 ? 2 : -2) : 0;
  const rowY = panelTop + i * ROSTER_ROW_H + shakeOff;
  const isVicPose = _isVictoryBattleState();
  const isAllyHit = (battleState === 'ally-hit' || battleState === 'ally-damage-show-enemy') &&
    enemyTargetAllyIdx === i && allyDamageNums[i] && !allyDamageNums[i].miss;
  const isAllyAttack = (battleState === 'ally-attack-start') && currentAllyAttacker === i;
  const isAllyHeal = battleState === 'item-use' && playerActionPending && playerActionPending.allyIndex === i;
  const isNearFatal = ally.hp > 0 && ally.hp <= Math.floor(ally.maxHP / 4);
  let portraits;
  if (isVicPose && (Math.floor(Date.now() / 250) & 1) && fakePlayerVictoryPortraits[ally.palIdx]) portraits = fakePlayerVictoryPortraits[ally.palIdx];
  else if (isAllyAttack && fakePlayerAttackPortraits[ally.palIdx]) portraits = fakePlayerAttackPortraits[ally.palIdx];
  else if (isAllyHit && fakePlayerHitPortraits[ally.palIdx]) portraits = fakePlayerHitPortraits[ally.palIdx];
  else if (isNearFatal && fakePlayerKneelPortraits[ally.palIdx]) portraits = fakePlayerKneelPortraits[ally.palIdx];
  else portraits = fakePlayerPortraits[ally.palIdx];
  _drawHudBox(HUD_RIGHT_X, rowY, 32, ROSTER_ROW_H, ally.fadeStep);
  _drawHudBox(HUD_RIGHT_X + 32, rowY, HUD_RIGHT_W - 32, ROSTER_ROW_H, ally.fadeStep);
  const ppx = HUD_RIGHT_X + 8, ppy = rowY + 8;
  if (portraits) {
    ctx.drawImage(portraits[ally.fadeStep], ppx, ppy);
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
  if (battleState === 'item-target-select' && itemTargetType === 'player' && itemTargetAllyIndex >= 0 && cursorTileCanvas) {
    ctx.drawImage(cursorTileCanvas, HUD_RIGHT_X - 4, panelTop + itemTargetAllyIndex * ROSTER_ROW_H + 12);
  }
  _flushAllyWeaponDraws(weaponDraws);
}

function _drawBossDmgNum() {
  if (!bossDamageNum || (bossDefeated && !isRandomEncounter)) return;
  let bx, baseY;
  if (isRandomEncounter && encounterMonsters) {
    const { count, boxX, boxY, sprH: dSprH, gridPos } = _encounterGridLayout();
    const idx = targetIndex < gridPos.length ? targetIndex : 0;
    const pos = gridPos[idx];
    const m = encounterMonsters[idx];
    const mc = monsterBattleCanvas.get(m?.monsterId) || goblinBattleCanvas;
    const mh = mc ? mc.height : dSprH;
    bx = pos.x + 16;
    baseY = pos.y + (dSprH - mh) + Math.floor(mh / 2) - 8;
  } else if (isPVPBattle) {
    const tot = 1 + pvpEnemyAllies.length;
    const cols = tot <= 1 ? 1 : 2;
    const rows = tot <= 2 ? 1 : 2;
    const cx = HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2);
    const cy = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2);
    const intLeft = cx - cols * 12;
    const intTop  = cy - rows * 16;
    bx = intLeft + (cols - 1) * 24 + 4 + 8;
    baseY = intTop + (rows - 1) * 32 + 4 + 8;
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
    const { count, boxX, boxY, sprH: dSprH, gridPos } = _encounterGridLayout();
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
  updateChat(dt);
  updatePauseMenu(dt);
  updateMsgBox(dt);
  updateBattle(dt);
  updateMovement(dt);
  updateTransition(dt);
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
  render();
  drawTransitionOverlay();
  _drawPondStrobe();
  if (transState === 'trap-falling' && sprite) sprite.draw(ctx, SCREEN_CENTER_X, SCREEN_CENTER_Y);
  drawHUD();
  if (battleAllies.length > 0 && battleState !== 'none') drawBattleAllies();
  else drawRoster();
  drawChat();
  drawPauseMenu();
  drawMsgBox();
  drawRosterMenu();
  drawBattle();
  drawSWExplosion();
  drawSWDamageNumbers();
}

function gameLoop(timestamp) {
  const dt = timestamp - lastTime;
  lastTime = timestamp;

  if (titleState !== 'done') {
    updateTitle(dt); drawTitle(); drawHUD(); drawTitleSkyInHUD();
    requestAnimationFrame(gameLoop);
    return;
  }

  _gameLoopUpdate(dt);
  _gameLoopDraw();

  requestAnimationFrame(gameLoop);
}
