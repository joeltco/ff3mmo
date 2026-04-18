// Game Client — boot wiring, ROM loading, composition root

import { parseROM } from './rom-parser.js';
import { initHUD } from './hud-init.js';
import { Sprite } from './sprite.js';
import { loadWorldMap } from './world-map-loader.js';
import { WorldMapRenderer } from './world-map-renderer.js';
import { clearDungeonCache } from './dungeon-generator.js';
import { initMusic, playTrack, TRACKS, initFF1Music, fadeOutFF1Music, clearMusicStash } from './music.js';
import { applyIPS } from './ips-patcher.js';
import { initTextDecoder } from './text-decoder.js';
import { initFont } from './font-renderer.js';
import { PLAYER_POOL } from './data/players.js';
import { VERSION } from './data/strings.js';
import { initMonsterSprites } from './monster-sprites.js';
import { loadBossSprite } from './boss-sprites.js';
import { saveSlotsToDB, loadSlotsFromDB, setPositionGetter } from './save-state.js';
import { resetWorldWaterCache } from './water-animation.js';
import { initBattleSpriteCache, loadJobBattleSprites } from './battle-sprite-cache.js';
import { hudSt, HUD_INFO_FADE_STEPS, HUD_INFO_FADE_STEP_MS } from './hud-state.js';
import { mapSt } from './map-state.js';
import { ui, isMobile } from './ui-state.js';
import { battleSt } from './battle-state.js';
import { initFlameRawTiles, initStarTiles } from './flame-sprites.js';
import { initTitleWater, initTitleSky, initTitleUnderwater, initUnderwaterSprites, initTitleOcean, initTitleLogo } from './title-animations.js';
import { ps, initPlayerStats, initExpTable } from './player-stats.js';
import { chatState, consoleLog, setCommandContext } from './chat.js';
import { setLocationGetter, getPlayerLocation, initRoster } from './roster.js';
import { titleSt, initTitleUpdate } from './title-screen.js';
import { pauseSt } from './pause-menu.js';
import { transSt } from './transitions.js';
import { initInputHandler, initKeyboardListeners } from './input-handler.js';
import { sprite, setPlayerSprite } from './player-sprite.js';
import { startPVPBattle } from './pvp.js';
import { initMapLoading, loadMapById } from './map-loading.js';
import { initBattleAlly } from './battle-ally.js';
import { initBattleEnemy } from './battle-enemy.js';
import { buildTurnOrder, processNextTurn } from './battle-turn.js';
import { initBattleEncounter } from './battle-encounter.js';
import { initBattleItems } from './battle-items.js';
import { addItem, setPlayerInventory } from './inventory.js';
import { resetBattleVars, isTeamWiped, executeBattleCommand } from './battle-update.js';
import { initCursorTile as _initCursorTile, initScrollArrows as _initScrollArrows,
         initAdamantoise as _initAdamantoise,
         initGoblinSprite as _initGoblinSprite, initInvincibleSprite as _initInvincibleSprite,
         initMoogleSprite as _initMoogleSprite, initLoadingScreenFadeFrames as _initLoadingScreenFadeFrames } from './sprite-init.js';
import { initFakePlayerSprites } from './fake-player-sprites.js';
import { initMissSprite } from './damage-numbers.js';
import { startGameLoop } from './game-loop.js';

const CANVAS_W = 256;          // 16 metatiles wide (NES resolution)
const CANVAS_H = 240;          // 15 metatiles tall (NES resolution)

let ff12Raw = null;  // FF1&2 ROM for Adamantoise sprite + FF1 music
const TITLE_FADE_MAX = 4;

// Player sprite palettes — from FCEUX PPU trace (dual palette: top/bottom tiles)
const SPRITE_PAL_TOP = [0x0F, 0x0F, 0x16, 0x30];    // spr_pal0: black, dark red, white
const SPRITE_PAL_BTM = [0x1A, 0x0F, 0x15, 0x30];    // spr_pal1: green, black, magenta, white
// Per-job walk sprite palettes: [topPal, bottomPal]
const JOB_WALK_PALS = {
  0: [SPRITE_PAL_TOP, SPRITE_PAL_BTM],   // Onion Knight: red top, green/magenta bottom
  1: [SPRITE_PAL_TOP, SPRITE_PAL_TOP],   // Warrior: all red
};

let romRaw = null;

export function init() {
  setPositionGetter(() => ({ worldX: mapSt.worldX, worldY: mapSt.worldY, onWorldMap: mapSt.onWorldMap, currentMapId: mapSt.currentMapId }));
  setLocationGetter(() => ({ onWorldMap: mapSt.onWorldMap, currentMapId: mapSt.currentMapId }));
  const canvas = document.getElementById('game-canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  ctx.imageSmoothingEnabled = false;
  ui.canvas = canvas; ui.ctx = ctx;

  initKeyboardListeners();
  window.addEventListener('beforeunload', () => { saveSlotsToDB(); });
}

function _swapBattleSprites(jobIdx) {
  loadJobBattleSprites(romRaw, jobIdx);
  // Swap walk sprite to match job
  if (sprite) {
    sprite.setGfxID(jobIdx);
    const pals = JOB_WALK_PALS[jobIdx] || JOB_WALK_PALS[0];
    sprite.setPalette(pals[0], pals[1]);
  }
}

function returnToTitle() {
  saveSlotsToDB();
  pauseSt.state = 'none';
  fadeOutFF1Music((HUD_INFO_FADE_STEPS + 1) * HUD_INFO_FADE_STEP_MS);
  clearMusicStash();
  transSt.state = 'hud-fade-out';
  transSt.timer = 0;
  transSt.pendingAction = () => { battleSt.battleState = 'none'; hudSt.hudInfoFadeTimer = HUD_INFO_FADE_STEPS * HUD_INFO_FADE_STEP_MS; _startTitleScreen(); };
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
  ui.cursorTileCanvas = ct.cursorTileCanvas;
  ui.cursorFadeCanvases = ct.cursorFadeCanvases;

  // Scroll arrows (sprite-init.js)
  const sa = _initScrollArrows(romRaw);
  ui.scrollArrowDown = sa.scrollArrowDown;
  ui.scrollArrowUp = sa.scrollArrowUp;
  ui.scrollArrowDownFade = sa.scrollArrowDownFade;
  ui.scrollArrowUpFade = sa.scrollArrowUpFade;

  // Battle sprite cache — per-job poses + init-once slash/SW/status
  loadJobBattleSprites(romRaw, ps.jobIdx);
  initBattleSpriteCache();

  // Fake player portraits & full bodies — keyed by jobIdx, owned by fake-player-sprites.js
  initFakePlayerSprites(romRaw, [0, 1]);

  initRoster();
  loadBossSprite(0xCC); // Land Turtle — loaded eagerly for now (only boss in game)

  // Goblin sprite (sprite-init.js)
  const gs = _initGoblinSprite(romRaw);
  battleSt.goblinBattleCanvas = gs.goblinBattleCanvas;
  battleSt.goblinWhiteCanvas = gs.goblinWhiteCanvas;
  battleSt.goblinDeathFrames = gs.goblinDeathFrames;

  initMonsterSprites();
  initMissSprite();
  initPlayerStats(romRaw);
  initExpTable(romRaw);

  // Moogle sprite (sprite-init.js)
  const ms = _initMoogleSprite(romRaw);
  hudSt.moogleFrames = ms.moogleFrames;

  // Loading screen fade frames (sprite-init.js)
  const lf = _initLoadingScreenFadeFrames(romRaw, ff12Raw);
  hudSt.moogleFadeFrames = lf.moogleFadeFrames;
  hudSt.bossFadeFrames = lf.bossFadeFrames;

  initMusic(romRaw);
  initFlameRawTiles(romRaw);
  initStarTiles(romRaw);
}
function _initTitleAssets(romRaw) {
  const inv = _initInvincibleSprite(romRaw, TITLE_FADE_MAX);
  hudSt.invincibleFrames = inv.invincibleFrames;
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
  mapSt.dungeonSeed = 1;
  clearDungeonCache();
  loadMapById(1004);
  playTrack(TRACKS.CRYSTAL_ROOM);
  setPlayerInventory({});
  addItem(0x54, 5);
  startGameLoop();
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
  startGameLoop();
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
  setPlayerSprite(new Sprite(romRaw, SPRITE_PAL_TOP, SPRITE_PAL_BTM));
  mapSt.worldMapData = loadWorldMap(romRaw, 0);
  mapSt.worldMapRenderer = new WorldMapRenderer(mapSt.worldMapData);
  resetWorldWaterCache();
  _initTitleAssets(romRaw);
  initMapLoading(romRaw);
  initBattleItems({ processNextTurn });
  initTitleUpdate({ swapBattleSprites: _swapBattleSprites });
  initBattleEncounter({ resetBattleVars });
  initBattleAlly({ buildTurnOrder, processNextTurn, isTeamWiped });
  initBattleEnemy({ processNextTurn, isTeamWiped });
  initInputHandler({
    executeBattleCommand, returnToTitle, swapBattleSprites: _swapBattleSprites,
    startPVPBattle,
    toggleCrt: () => document.getElementById('canvas-wrapper').classList.toggle('crt'),
  });

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
  hudSt.adamantoiseFrames = ad.adamantoiseFrames;
  initFF1Music(ff12Raw);
  if (romRaw) { // rebuild loading screen fade frames with boss fade
    const lf2 = _initLoadingScreenFadeFrames(romRaw, ff12Raw);
    hudSt.moogleFadeFrames = lf2.moogleFadeFrames;
    hudSt.bossFadeFrames = lf2.bossFadeFrames;
  }
}

