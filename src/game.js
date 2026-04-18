// Game Client — canvas rendering, input handling, game loop

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
import { PLAYER_POOL, ROSTER_FADE_STEPS } from './data/players.js';
import { VERSION } from './data/strings.js';
import { initMonsterSprites } from './monster-sprites.js';
import { loadBossSprite } from './boss-sprites.js';
import { saveSlotsToDB, loadSlotsFromDB, setInventoryGetter, setPositionGetter } from './save-state.js';
import { resetWorldWaterCache } from './water-animation.js';
import { initBattleSpriteCache, loadJobBattleSprites } from './battle-sprite-cache.js';
import { hudSt, HUD_INFO_FADE_STEPS, HUD_INFO_FADE_STEP_MS } from './hud-state.js';
import { mapSt } from './map-state.js';
import { ui, isMobile } from './ui-state.js';
import { battleSt } from './battle-state.js';
import { initFlameRawTiles, initStarTiles } from './flame-sprites.js';
import { LOAD_FADE_STEP_MS, LOAD_FADE_MAX } from './loading-screen.js';
import { initTitleWater, initTitleSky, initTitleUnderwater, initUnderwaterSprites, initTitleOcean, initTitleLogo } from './title-animations.js';
import { ps, initPlayerStats, initExpTable } from './player-stats.js';
import { chatState, updateChat, updateChatTabs, drawChat, drawChatTabs, consoleLog, setCommandContext } from './chat.js';
import { rosterBattleFade, setLocationGetter, getPlayerLocation, getRosterVisible, initRoster, updateRoster, drawRoster, drawRosterMenu } from './roster.js';
import { msgState, updateMsgBox, drawMsgBox } from './message-box.js';
import { titleSt, drawTitleSkyInHUD, drawTitle, updateTitle, initTitleUpdate } from './title-screen.js';
import { pauseSt, updatePauseMenu, drawPauseMenu, initPauseMenu } from './pause-menu.js';
import { transSt, loadingSt, updateTransition, updateTopBoxScroll, drawTransitionOverlay, initTransitions } from './transitions.js';
import { inputSt, initInputHandler, initKeyboardListeners } from './input-handler.js';
import { initMapTriggers } from './map-triggers.js';
import { startPVPBattle, initPVP } from './pvp.js';
import { drawBattle, drawBattleAllies, drawSWExplosion, drawSWDamageNumbers, initBattleDrawing } from './battle-drawing.js';
import { initRender, render, drawPoisonFlash, drawPondStrobe, updateStarEffect } from './render.js';
import { getBlades } from './weapon-sprites.js';
import { drawHUD, clipToViewport, drawHudBox, drawBorderedBox, roundTopBoxCorners, drawRosterSparkle, updateHudHpLvStep } from './hud-drawing.js';
import { initMapLoading, loadMapById } from './map-loading.js';
import { updateBattleAlly, initBattleAlly } from './battle-ally.js';
import { initBattleEnemy } from './battle-enemy.js';
import { buildTurnOrder, processNextTurn, initBattleTurn } from './battle-turn.js';
import { initBattleEncounter } from './battle-encounter.js';
import { initMovement, handleInput, updateMovement } from './movement.js';
import { initBattleItems } from './battle-items.js';
import { initBattleUpdate, resetBattleVars, isTeamWiped, isVictoryBattleState, executeBattleCommand, updateBattle, updateBattleTimers, updateBattlePlayerAttack, updateBattleDefendItem, updateBattleEndSequence, tryJoinPlayerAlly, advancePVPTargetOrVictory } from './battle-update.js';
import { initCursorTile as _initCursorTile, initScrollArrows as _initScrollArrows,
         initAdamantoise as _initAdamantoise,
         initGoblinSprite as _initGoblinSprite, initInvincibleSprite as _initInvincibleSprite,
         initMoogleSprite as _initMoogleSprite, initLoadingScreenFadeFrames as _initLoadingScreenFadeFrames } from './sprite-init.js';
import { initFakePlayerSprites } from './fake-player-sprites.js';
import { initMissSprite } from './damage-numbers.js';

const CANVAS_W = 256;          // 16 metatiles wide (NES resolution)
const CANVAS_H = 240;          // 15 metatiles tall (NES resolution)

const HUD_VIEW_X = 0;
const HUD_VIEW_Y = 32;
const HUD_VIEW_W = 144;
const HUD_VIEW_H = 144;
let ff12Raw = null;  // FF1&2 ROM for Adamantoise sprite + FF1 music
const TITLE_FADE_MAX = 4;

const INV_SLOTS = 3; // visible inventory rows per page
let playerInventory = {};    // { itemId: count } — e.g. { 0xA6: 3 }
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

let cursorTileCanvas = null;
let cursorFadeCanvases = null; // [step1..step4] NES-faded cursor canvases
let scrollArrowDown = null;
let scrollArrowUp = null;
let scrollArrowDownFade = null;
let scrollArrowUpFade = null;

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
let lastTime = 0;
const keys = {};

let romRaw = null;

// Where the sprite draws on screen (centered in viewport)
const SCREEN_CENTER_X = HUD_VIEW_X + (HUD_VIEW_W - 16) / 2;    // 64
const SCREEN_CENTER_Y = HUD_VIEW_Y + (HUD_VIEW_H - 16) / 2 - 3; // 93

// Water animation state — shared with title-screen.js via waterSt ref
const waterSt = { timer: 0, tick: 0 };
const WATER_TICK = 4 * (1000 / 60);  // ~67ms per tick

let _tabWasLoading = false; // tracks if we just came from a loading screen

// Screen shake state (earthquake effect for secret passages)
const SHAKE_DURATION = 34 * (1000 / 60);  // 2 × 17 NES frames ≈ 567ms

export function init() {
  setInventoryGetter(() => playerInventory);
  setPositionGetter(() => ({ worldX: mapSt.worldX, worldY: mapSt.worldY, onWorldMap: mapSt.onWorldMap, currentMapId: mapSt.currentMapId }));
  setLocationGetter(() => ({ onWorldMap: mapSt.onWorldMap, currentMapId: mapSt.currentMapId }));
  canvas = document.getElementById('game-canvas');
  ctx = canvas.getContext('2d');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  ctx.imageSmoothingEnabled = false;
  ui.canvas = canvas; ui.ctx = ctx;

  initKeyboardListeners(keys);
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
  cursorTileCanvas = ct.cursorTileCanvas;
  cursorFadeCanvases = ct.cursorFadeCanvases;
  ui.cursorTileCanvas = cursorTileCanvas; ui.cursorFadeCanvases = cursorFadeCanvases;

  // Scroll arrows (sprite-init.js)
  const sa = _initScrollArrows(romRaw);
  scrollArrowDown = sa.scrollArrowDown;
  scrollArrowUp = sa.scrollArrowUp;
  scrollArrowDownFade = sa.scrollArrowDownFade;
  scrollArrowUpFade = sa.scrollArrowUpFade;

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
  mapSt.worldMapData = loadWorldMap(romRaw, 0);
  mapSt.worldMapRenderer = new WorldMapRenderer(mapSt.worldMapData);
  resetWorldWaterCache();
  _initTitleAssets(romRaw);
  initMapLoading(romRaw, sprite);
  initMapTriggers({ addItem });
  initBattleItems({ processNextTurn });
  initPauseMenu({ playerInventory: () => playerInventory });
  initTransitions({ keys, getSprite: () => sprite, onShake: () => { mapSt.shakeActive = true; mapSt.shakeTimer = 0; } });
  initMovement({ keys, getSprite: () => sprite });
  initTitleUpdate({ keys, waterSt, setPlayerInventory: (inv) => { playerInventory = inv; }, swapBattleSprites: _swapBattleSprites });
  initBattleUpdate({ keys, getSprite: () => sprite, addItem, buildItemSelectList });
  initBattleEncounter({ resetBattleVars });
  initBattleAlly({ buildTurnOrder, processNextTurn, isTeamWiped });
  initBattleEnemy({ processNextTurn, isTeamWiped });
  initBattleTurn({ removeItem });
  initInputHandler({
    keys, playerInventory: () => playerInventory, addItem, removeItem,
    executeBattleCommand, returnToTitle, swapBattleSprites: _swapBattleSprites,
    startPVPBattle,
    toggleCrt: () => document.getElementById('canvas-wrapper').classList.toggle('crt'),
  });
  initRender({ ctx, getSprite: () => sprite, waterSt });
  initBattleDrawing({
    ctx,
    cursorTileCanvas: () => cursorTileCanvas,
    isVictoryBattleState,
  });
  initPVP({
    ctx,
    cursorTileCanvas: () => cursorTileCanvas,
    blades: () => ({ ...getBlades() }),
    processNextTurn,
    handleAlly: updateBattleAlly,
    updateTimers: updateBattleTimers,
    handlePlayerAttack: updateBattlePlayerAttack,
    handleDefendItem: updateBattleDefendItem,
    handleEndSequence: updateBattleEndSequence,
    tryJoinPlayerAlly,
    buildAndProcessNextTurn: () => { battleSt.turnQueue = buildTurnOrder(); processNextTurn(); },
    resetBattleVars,
    isTeamWiped,
    advancePVPTargetOrVictory,
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

function _gameLoopUpdate(dt) {
  if (hudSt.hudInfoFadeTimer < HUD_INFO_FADE_STEPS * HUD_INFO_FADE_STEP_MS) hudSt.hudInfoFadeTimer += dt;
  updateHudHpLvStep(dt);
  handleInput();
  updateRoster(dt, { battleState: battleSt.battleState, transSt, wipeDuration: 44 * (1000 / 60), hudInfoFadeTimer: hudSt.hudInfoFadeTimer, hudInfoFadeSteps: HUD_INFO_FADE_STEPS, hudInfoFadeStepMs: HUD_INFO_FADE_STEP_MS });
  updateChat(dt, battleSt.battleState);
  updateChatTabs(dt);
  updatePauseMenu(dt, playerInventory);
  updateMsgBox(dt);
  updateBattle(dt);
  updateMovement(dt);
  updateTransition(dt);
  updateTopBoxScroll(dt);
  if (mapSt.pondStrobeTimer > 0) mapSt.pondStrobeTimer = Math.max(0, mapSt.pondStrobeTimer - dt);
  if (mapSt.shakeActive) {
    mapSt.shakeTimer += dt;
    if (mapSt.shakeTimer >= SHAKE_DURATION) {
      mapSt.shakeActive = false;
      if (mapSt.shakePendingAction) { mapSt.shakePendingAction(); mapSt.shakePendingAction = null; }
    }
  }
  updateStarEffect(dt);
  waterSt.timer += dt;
  if (waterSt.timer >= WATER_TICK) { waterSt.timer %= WATER_TICK; waterSt.tick++; }
}

function _gameLoopDraw() {
  try {
    render();
    drawPoisonFlash();
    drawTransitionOverlay(ctx);
    drawPondStrobe();
    if (transSt.state === 'trap-falling' && sprite) sprite.draw(ctx, SCREEN_CENTER_X, SCREEN_CENTER_Y);
  } catch (e) {
    console.error('[RENDER ERROR]', e);
    fetch('/api/client-error', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ msg: e.message, stack: e.stack }) }).catch(() => {});
  }
  // Draw tabs BEFORE HUD so static HUD canvas draws on top of tab overlap
  const _infoFade = HUD_INFO_FADE_STEPS - Math.min(Math.floor(hudSt.hudInfoFadeTimer / HUD_INFO_FADE_STEP_MS), HUD_INFO_FADE_STEPS);
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
  try {
    const _rds = {
      ctx, drawHudBox: drawHudBox, drawBorderedBox: drawBorderedBox,
      clipToViewport: clipToViewport, cursorTileCanvas,
      scrollArrowUp, scrollArrowDown, scrollArrowUpFade, scrollArrowDownFade,
      drawSparkle: drawRosterSparkle,
      transSt, wipeDuration: 44 * (1000 / 60),
      hudInfoFadeTimer: hudSt.hudInfoFadeTimer, hudInfoFadeSteps: HUD_INFO_FADE_STEPS, hudInfoFadeStepMs: HUD_INFO_FADE_STEP_MS,
      battleState: battleSt.battleState, msgState,
    };
    if (battleSt.battleAllies.length > 0 && battleSt.battleState !== 'none') drawBattleAllies();
    else drawRoster(_rds);
    drawChat(ctx, drawHudBox, rosterBattleFade);
    drawPauseMenu(ctx);
    drawMsgBox(ctx, clipToViewport, drawBorderedBox);
    drawRosterMenu(_rds);
    drawBattle();
    drawSWExplosion();
    drawSWDamageNumbers();
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
    updateTitle(dt); drawTitle(ctx, waterSt.tick); drawHUD();
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
    console.error('[GAME LOOP ERROR] transSt.state=' + transSt.state + ' battleSt.battleState=' + battleSt.battleState, e);
    requestAnimationFrame(gameLoop);
    return;
  }

  requestAnimationFrame(gameLoop);
}
