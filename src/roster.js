// roster.js — MMO player roster: state, update (fade/slide/movement), draw (rows/menu/scroll)

import { LOCATIONS, PLAYER_POOL, ROSTER_FADE_STEPS } from './data/players.js';
import { inputSt } from './input-handler.js';
import { titleSt } from './title-screen.js';
import { chatState, addChatMessage } from './chat.js';
import { nesColorFade } from './palette.js';
import { NES_SYSTEM_PALETTE } from './tile-decoder.js';
import { _nameToBytes } from './text-utils.js';
import { drawText, measureText, TEXT_WHITE } from './font-renderer.js';

// ── HUD layout constants (must match game.js) ────────────────────────────
const CANVAS_W   = 256;
const HUD_VIEW_X = 0;
const HUD_VIEW_Y = 32;
const HUD_VIEW_W = 144;
const HUD_VIEW_H = 144;
const HUD_RIGHT_X = HUD_VIEW_W;           // 144
const HUD_RIGHT_W = CANVAS_W - HUD_VIEW_W; // 112

// ── Roster constants ──────────────────────────────────────────────────────
const ROSTER_FADE_STEP_MS = 100;
const ROSTER_SLIDE_SPEED  = 0.15;  // px per ms
const ROSTER_ROW_H        = 32;
const ROSTER_VISIBLE      = 3;
const ROSTER_MENU_ITEMS   = ['Party', 'Battle', 'Trade', 'Message', 'Inspect'];

// ── Mutable state ─────────────────────────────────────────────────────────
let rosterTimer        = 0;
let rosterFadeMap      = {};   // {name: fadeStep} 0=visible, 4=black
let rosterFadeTimers   = {};
let rosterFadeDir      = {};   // {name: 'in'|'out'}
let rosterSlideY       = {};   // {name: px offset}
let rosterPrevLoc      = null;
let rosterArrivalOrder = [];

export let rosterBattleFade      = 0;   // 0=visible, ROSTER_FADE_STEPS=black
let rosterBattleFadeTimer = 0;
let rosterBattleFading    = 'none'; // 'none'|'out'|'in'

// ── Location getter (set by game.js at init) ─��────────────────────────────
let _getLocState = () => ({ onWorldMap: false, currentMapId: 114 });
export function setLocationGetter(fn) { _getLocState = fn; }

export function getPlayerLocation() {
  const { onWorldMap, currentMapId } = _getLocState();
  if (onWorldMap) return 'world';
  if (currentMapId === 114) return 'ur';
  if (currentMapId === 1004) return 'crystal';
  if (currentMapId >= 1000 && currentMapId < 1004) return 'cave-' + (currentMapId - 1000);
  return 'ur';
}

export function rosterLocForMapId(mapId) {
  if (mapId === 'world') return 'world';
  if (mapId === 114) return 'ur';
  if (mapId === 1004) return 'crystal';
  if (mapId >= 1000 && mapId < 1004) return 'cave-' + (mapId - 1000);
  return 'ur';
}

export function getRosterPlayers() {
  const loc = getPlayerLocation();
  return PLAYER_POOL.filter(p => p.loc === loc);
}

// ── Visible roster (at loc + fading out), sorted by arrival ───────────────
export function getRosterVisible() {
  const loc = getPlayerLocation();
  const atLoc = PLAYER_POOL.filter(p => p.loc === loc);
  const fadingOut = PLAYER_POOL.filter(p =>
    p.loc !== loc && rosterFadeDir[p.name] === 'out' && rosterFadeMap[p.name] < ROSTER_FADE_STEPS
  );
  atLoc.sort((a, b) => {
    const ai = rosterArrivalOrder.indexOf(a.name);
    const bi = rosterArrivalOrder.indexOf(b.name);
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

// ─�� Init ──────────────────────────────────────────────────────────────────
export function initRoster() {
  document.fonts.load('8px "Press Start 2P"').then(() => {
    requestAnimationFrame(() => { chatState.fontReady = true; });
  });
  rosterTimer = 3000 + Math.random() * 5000;
  for (const p of PLAYER_POOL) {
    const maxHP = 28 + p.level * 6;
    if (p.maxHP === undefined) { p.maxHP = maxHP; p.hp = maxHP; }
  }
  const loc = getPlayerLocation();
  rosterPrevLoc = loc;
  for (const p of PLAYER_POOL) {
    if (p.loc === loc) rosterFadeMap[p.name] = 0;
  }
}

// ── Fade in / out ─────────────────────────────────────────────────────��───
function _rosterNextTimer() { return 4000 + Math.random() * 8000; }

function _rosterStartFadeIn(name) {
  rosterArrivalOrder = rosterArrivalOrder.filter(n => n !== name);
  rosterArrivalOrder.unshift(name);
  rosterFadeMap[name] = ROSTER_FADE_STEPS;
  rosterFadeDir[name] = 'in';
  rosterFadeTimers[name] = 0;
  rosterSlideY[name] = ROSTER_ROW_H;
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

// ── Update ────────────────────────────────────────────────────────────────
// shared: { battleState, transSt, wipeDuration, hudInfoFadeTimer, hudInfoFadeSteps, hudInfoFadeStepMs }

function _rosterTransFade(shared) {
  const FADE_STEP_MS = shared.wipeDuration / ROSTER_FADE_STEPS;
  if (shared.transSt.rosterLocChanged) {
    if (shared.transSt.state === 'closing') return Math.min(Math.floor(shared.transSt.timer / FADE_STEP_MS), ROSTER_FADE_STEPS);
    if (shared.transSt.state === 'hold' || shared.transSt.state === 'trap-falling') return ROSTER_FADE_STEPS;
    if (shared.transSt.state === 'opening') return Math.max(ROSTER_FADE_STEPS - Math.floor(shared.transSt.timer / FADE_STEP_MS), 0);
  }
  const infoFade = shared.hudInfoFadeSteps - Math.min(Math.floor(shared.hudInfoFadeTimer / shared.hudInfoFadeStepMs), shared.hudInfoFadeSteps);
  if (infoFade > 0) return infoFade;
  return 0;
}

function _updateBattleFade(dt, battleState) {
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

function _updateLocationReset(curLoc) {
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

function _updateFadeTicks(dt) {
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

function _updateSlideTicks(dt) {
  for (const name in rosterSlideY) {
    const sy = rosterSlideY[name];
    if (sy === 0) { delete rosterSlideY[name]; continue; }
    const move = ROSTER_SLIDE_SPEED * dt;
    rosterSlideY[name] = Math.abs(sy) <= move ? 0 : sy > 0 ? sy - move : sy + move;
    if (rosterSlideY[name] === 0) delete rosterSlideY[name];
  }
}

function _updateMovement(dt, curLoc, battleState) {
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

export function updateRoster(dt, shared) {
  if (inputSt.rosterState === 'menu-in' || inputSt.rosterState === 'menu-out') inputSt.rosterMenuTimer += Math.min(dt, 33);
  if (titleSt.state !== 'done') return;
  _updateBattleFade(dt, shared.battleState);
  const curLoc = getPlayerLocation();
  _updateLocationReset(curLoc);
  _updateFadeTicks(dt);
  _updateSlideTicks(dt);
  _updateMovement(dt, curLoc, shared.battleState);
}

// ── Draw ──────────────────────────────────────────────────────────────────
// drawShared: { ctx, drawHudBox, drawBorderedBox, clipToViewport, cursorTileCanvas,
//               fakePlayerPortraits, drawSparkle, transSt, wipeDuration,
//               hudInfoFadeTimer, hudInfoFadeSteps, hudInfoFadeStepMs, battleState, msgState }

function _drawRosterRow(ds, p, i, panelTop) {
  const slideOff = rosterSlideY[p.name] || 0;
  const rowY = panelTop + i * ROSTER_ROW_H + slideOff;
  const playerFade = rosterFadeMap[p.name] || 0;
  const transFade = _rosterTransFade(ds);
  const fadeStep = Math.min(Math.max(playerFade, transFade, rosterBattleFade), ROSTER_FADE_STEPS);

  ds.drawHudBox(HUD_RIGHT_X, rowY, 32, ROSTER_ROW_H, fadeStep);
  ds.drawHudBox(HUD_RIGHT_X + 32, rowY, HUD_RIGHT_W - 32, ROSTER_ROW_H, fadeStep);

  const portraits = ds.fakePlayerPortraits[p.palIdx];
  if (portraits) ds.ctx.drawImage(portraits[fadeStep], HUD_RIGHT_X + 8, rowY + 8);

  const namePal = [0x0F, 0x0F, 0x0F, 0x30];
  for (let s = 0; s < fadeStep; s++) namePal[3] = nesColorFade(namePal[3]);
  const nameBytes = _nameToBytes(p.name);
  const nameW = measureText(nameBytes);
  drawText(ds.ctx, HUD_RIGHT_X + HUD_RIGHT_W - 8 - nameW, rowY + 8, nameBytes, namePal);

  const lvPal = [0x0F, 0x0F, 0x0F, 0x10];
  for (let s = 0; s < fadeStep; s++) lvPal[3] = nesColorFade(lvPal[3]);
  const lvLabel = _nameToBytes('Lv' + String(p.level));
  const lvW = measureText(lvLabel);
  drawText(ds.ctx, HUD_RIGHT_X + HUD_RIGHT_W - 8 - lvW, rowY + 16, lvLabel, lvPal);
}

function _drawScrollTriangles(ds, scrollAreaY, canScrollUp, canScrollDown) {
  if (!canScrollUp && !canScrollDown) return;
  const triFade = Math.min(Math.max(_rosterTransFade(ds), rosterBattleFade), ROSTER_FADE_STEPS);
  let triNes = 0x10;
  for (let s = 0; s < triFade; s++) triNes = nesColorFade(triNes);
  const triCol = NES_SYSTEM_PALETTE[triNes] || [0, 0, 0];
  ds.ctx.fillStyle = `rgb(${triCol[0]},${triCol[1]},${triCol[2]})`;
  const triCX = HUD_RIGHT_X + Math.floor(HUD_RIGHT_W / 2);
  if (canScrollUp) {
    const ty = scrollAreaY + 2;
    ds.ctx.beginPath(); ds.ctx.moveTo(triCX - 4, ty + 5); ds.ctx.lineTo(triCX, ty); ds.ctx.lineTo(triCX + 4, ty + 5); ds.ctx.fill();
  }
  if (canScrollDown) {
    const ty = scrollAreaY + 9;
    ds.ctx.beginPath(); ds.ctx.moveTo(triCX - 4, ty); ds.ctx.lineTo(triCX, ty + 5); ds.ctx.lineTo(triCX + 4, ty); ds.ctx.fill();
  }
}

export function drawRoster(ds) {
  if (titleSt.state !== 'done') return;
  if (ds.transSt.state === 'loading') return;
  if (rosterBattleFade >= ROSTER_FADE_STEPS && ds.battleState !== 'none') return;

  const panelTop = HUD_VIEW_Y + 32;
  const panelH = HUD_VIEW_H - 32;
  const scrollAreaY = panelTop + ROSTER_VISIBLE * ROSTER_ROW_H;

  const players = getRosterVisible();
  const maxVisible = Math.min(ROSTER_VISIBLE, players.length);
  const maxScroll = Math.max(0, players.length - maxVisible);
  if (inputSt.rosterScroll > maxScroll) inputSt.rosterScroll = maxScroll;

  const canScrollUp = inputSt.rosterScroll > 0;
  const canScrollDown = inputSt.rosterScroll < maxScroll;

  ds.ctx.save();
  ds.ctx.beginPath();
  ds.ctx.rect(HUD_RIGHT_X, panelTop, HUD_RIGHT_W, panelH);
  ds.ctx.clip();
  for (let i = 0; i < maxVisible; i++) {
    const idx = inputSt.rosterScroll + i;
    if (idx >= players.length) break;
    _drawRosterRow(ds, players[idx], i, panelTop);
  }
  ds.ctx.restore();

  _drawScrollTriangles(ds, scrollAreaY, canScrollUp, canScrollDown);

  ds.drawSparkle(panelTop);

  // Cursor
  if (inputSt.rosterState === 'browse' || inputSt.rosterState === 'menu' || inputSt.rosterState === 'menu-in' || inputSt.rosterState === 'menu-out') {
    const visIdx = inputSt.rosterCursor - inputSt.rosterScroll;
    const curTarget = players[inputSt.rosterCursor];
    const curSlide = curTarget ? (rosterSlideY[curTarget.name] || 0) : 0;
    const curY = panelTop + visIdx * ROSTER_ROW_H + curSlide + 12;
    if (ds.cursorTileCanvas) ds.ctx.drawImage(ds.cursorTileCanvas, HUD_RIGHT_X - 4, curY);
  }
}

export function drawRosterMenu(ds) {
  if (inputSt.rosterState !== 'menu-in' && inputSt.rosterState !== 'menu' && inputSt.rosterState !== 'menu-out') return;

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
    if (t >= 1) { inputSt.rosterState = ds.msgState.state !== 'none' ? 'none' : 'browse'; inputSt.rosterMenuTimer = 0; }
  }

  ds.clipToViewport();
  ds.drawBorderedBox(menuX, menuY, menuW, menuH, false);

  if (inputSt.rosterState === 'menu') {
    const textPal = TEXT_WHITE;
    for (let i = 0; i < ROSTER_MENU_ITEMS.length; i++) {
      const label = ROSTER_MENU_ITEMS[i];
      const labelBytes = _nameToBytes(label);
      drawText(ds.ctx, menuX + 16, menuY + 8 + i * 14, labelBytes, textPal);
    }
    if (ds.cursorTileCanvas) {
      ds.ctx.drawImage(ds.cursorTileCanvas, menuX + 2, menuY + 4 + inputSt.rosterMenuCursor * 14);
    }
  }

  ds.ctx.restore();
}
