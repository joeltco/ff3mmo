// roster.js — MMO player roster: state, update (fade/slide/movement), draw (rows/menu/scroll)

import { LOCATIONS, PLAYER_POOL, ROSTER_FADE_STEPS } from './data/players.js';
import { inputSt } from './input-handler.js';
import { titleSt } from './title-screen.js';
import { chatState, addChatMessage } from './chat.js';
import { nesColorFade } from './palette.js';
import { _nameToBytes, drawLvHpRow } from './text-utils.js';
import { drawText, measureText, TEXT_WHITE } from './font-renderer.js';
import { isSearchingFor } from './pvp-search.js';
import { isInvitingTarget, isInParty } from './party-invite.js';
import { isTradingWith } from './trade.js';
import { fakePlayerPortraits, fakePlayerKneelPortraits } from './fake-player-sprites.js';
import { bsc } from './battle-sprite-cache.js';
import { ui } from './ui-state.js';
import { transSt, WIPE_DURATION } from './transitions.js';
import { battleSt } from './battle-state.js';
import { hudSt, HUD_INFO_FADE_STEPS, HUD_INFO_FADE_STEP_MS } from './hud-state.js';
import { msgState } from './message-box.js';
import { drawHudBox, drawBorderedBox, clipToViewport, drawRosterSparkle } from './hud-drawing.js';
import { getOnlineAtLocation } from './net.js';

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
export const ROSTER_MENU_ITEMS = ['Party', 'Battle', 'Trade', 'Message', 'Inspect'];

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
  // Real online players (multiplayer Step 1) appear above the fake pool.
  // Pre-MP they're always [] so the existing single-player flow is unchanged.
  const real = getOnlineAtLocation(loc);
  const fake = PLAYER_POOL.filter(p => p.loc === loc);
  return [...real, ...fake];
}

// ── Visible roster (at loc + fading out), sorted by arrival ───────────────
export function getRosterVisible() {
  const loc = getPlayerLocation();
  // Real players first — they don't participate in the fake-pool fade/slide
  // animation (presence is driven by WebSocket join/leave/move events).
  const real = getOnlineAtLocation(loc);
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
  return [...real, ...atLoc, ...fadingOut];
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

function _rosterTransFade() {
  const FADE_STEP_MS = WIPE_DURATION / ROSTER_FADE_STEPS;
  // Roster syncs to every wipe — see HUD top-box handling in
  // `hud-drawing.js:160-171` for the matching pattern. v1.7.230
  // adds `'hud-fade-in'` + the `topBoxAlreadyBright` short-circuit
  // for the title→game flow, which goes directly hud-fade-in →
  // opening (skipping closing/hold). Pre-fix, the title-screen
  // transition flashed the roster bright during hud-fade-in and
  // then re-faded it from black during opening.
  if (transSt.state === 'closing') return Math.min(Math.floor(transSt.timer / FADE_STEP_MS), ROSTER_FADE_STEPS);
  if (transSt.state === 'hold' || transSt.state === 'loading' || transSt.state === 'trap-falling') return ROSTER_FADE_STEPS;
  if (transSt.state === 'hud-fade-in') {
    return Math.max(ROSTER_FADE_STEPS - Math.floor(hudSt.hudInfoFadeTimer / HUD_INFO_FADE_STEP_MS), 0);
  }
  if (transSt.state === 'opening') {
    if (transSt.topBoxAlreadyBright) return 0;  // hud-fade-in already brought the roster up; don't re-fade
    return Math.max(ROSTER_FADE_STEPS - Math.floor(transSt.timer / FADE_STEP_MS), 0);
  }
  const infoFade = HUD_INFO_FADE_STEPS - Math.min(Math.floor(hudSt.hudInfoFadeTimer / HUD_INFO_FADE_STEP_MS), HUD_INFO_FADE_STEPS);
  if (infoFade > 0) return infoFade;
  return 0;
}

function _updateBattleFade(dt, battleState) {
  if (battleState !== 'none' && battleState !== 'roar-hold' && rosterBattleFading !== 'out' && rosterBattleFade < ROSTER_FADE_STEPS) {
    rosterBattleFading = 'out';
    rosterBattleFadeTimer = 0;
  } else if (
    battleState === 'none' &&
    // While a wipe is closing or holding, the trans-fade owns the
    // visible roster fade (synced to WIPE_DURATION). Letting the
    // 400 ms battle fade ramp-in run concurrently caused the roster
    // to brighten under the still-closing wipe bars during the
    // defeat → respawn flow. v1.7.227.
    transSt.state !== 'closing' && transSt.state !== 'hold' && transSt.state !== 'loading' && transSt.state !== 'trap-falling' &&
    rosterBattleFade > 0 &&
    rosterBattleFading !== 'in'
  ) {
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

export function updateRoster(dt) {
  if (inputSt.rosterState === 'menu-in' || inputSt.rosterState === 'menu-out') inputSt.rosterMenuTimer += Math.min(dt, 33);
  if (titleSt.state !== 'done') return;
  _updateBattleFade(dt, battleSt.battleState);
  const curLoc = getPlayerLocation();
  _updateLocationReset(curLoc);
  _updateFadeTicks(dt);
  _updateSlideTicks(dt);
  _updateMovement(dt, curLoc, battleSt.battleState);
}

// ── Draw ──────────────────────────────────────────────────────────────────

function _drawRosterRow(p, i, panelTop) {
  const slideOff = rosterSlideY[p.name] || 0;
  const rowY = panelTop + i * ROSTER_ROW_H + slideOff;
  const playerFade = rosterFadeMap[p.name] || 0;
  const transFade = _rosterTransFade();
  const fadeStep = Math.min(Math.max(playerFade, transFade, rosterBattleFade), ROSTER_FADE_STEPS);

  drawHudBox(HUD_RIGHT_X, rowY, 32, ROSTER_ROW_H, fadeStep);
  drawHudBox(HUD_RIGHT_X + 32, rowY, HUD_RIGHT_W - 32, ROSTER_ROW_H, fadeStep);

  // Low-HP pose: real wire players carry `hp` / `maxHP` in their snapshot
  // entry, so swap to the kneel portrait once the threshold matches the
  // in-battle convention (hp <= maxHP / 4, hp > 0). Fake-pool entries don't
  // ship hp at runtime and fall through to the idle portrait. v1.7.415.
  const _hp = (typeof p.hp === 'number') ? p.hp : null;
  const _maxHP = (typeof p.maxHP === 'number') ? p.maxHP : null;
  const isNearFatal = _hp != null && _maxHP != null && _hp > 0 && _hp <= Math.floor(_maxHP / 4);
  const portraitSet = isNearFatal ? fakePlayerKneelPortraits : fakePlayerPortraits;
  const jobPortraits = portraitSet[p.jobIdx || 0] || portraitSet[0];
  const portraits = jobPortraits && jobPortraits[p.palIdx];
  if (portraits) ui.ctx.drawImage(portraits[fadeStep], HUD_RIGHT_X + 8, rowY + 8);
  // Sweat overlay — 2-frame alternation matching the battle pose (133 ms cadence).
  // Fade with the row so it doesn't pop in/out as the row slides.
  if (isNearFatal && fadeStep < ROSTER_FADE_STEPS && bsc.sweatFrames && bsc.sweatFrames.length === 2) {
    const sweat = bsc.sweatFrames[Math.floor(Date.now() / 133) & 1];
    ui.ctx.drawImage(sweat, HUD_RIGHT_X + 8, rowY + 8 - 3);
  }

  // Online badge — small green dot at top-right of the portrait box for any
  // real wire-presence player (`isReal: true` from net.js snapshot/join).
  // Solves the "fakes hidden + empty roster looks broken" first-impression
  // problem in v1.7.386+. NES-faithful: 3×3 fillRect in NES-palette green
  // (#5cdc14 = $2A), fades with the row.
  if (p.isReal && fadeStep < ROSTER_FADE_STEPS) {
    ui.ctx.fillStyle = fadeStep === 0 ? '#5cdc14' : fadeStep === 1 ? '#3a9210' : '#1f4f08';
    ui.ctx.fillRect(HUD_RIGHT_X + 32 - 5, rowY + 2, 3, 3);
  }
  // In-battle badge — small red dot at top-left of the portrait box for
  // any real wire-presence player who's currently in combat (inBattle
  // flag wire-pushed by main.js profile builder). Drives the "Assist"
  // action on the roster menu. v1.7.422.
  if (p.isReal && p.inBattle && fadeStep < ROSTER_FADE_STEPS) {
    ui.ctx.fillStyle = fadeStep === 0 ? '#f83800' : fadeStep === 1 ? '#a32200' : '#5e1300';
    ui.ctx.fillRect(HUD_RIGHT_X + 2, rowY + 2, 3, 3);
  }

  const namePal = [0x0F, 0x10, 0x0F, 0x30];
  for (let s = 0; s < fadeStep; s++) namePal[3] = nesColorFade(namePal[3]);
  const nameBytes = _nameToBytes(p.name);
  const nameW = measureText(nameBytes);
  drawText(ui.ctx, HUD_RIGHT_X + HUD_RIGHT_W - 8 - nameW, rowY + 8, nameBytes, namePal);

  const panelLeft = HUD_RIGHT_X + 32 + 8;
  const _searchingHere = isSearchingFor(p);
  const _invitingHere  = isInvitingTarget(p);
  if (_searchingHere || _invitingHere) {
    // Search/invite active on this target — replace Lv/HP with status text.
    // Marquee-scrolled when wider than the 64-px box; two copies offset by
    // `period` make the wrap seamless. v1.7.223 (search), v1.7.235 (invite).
    const statusPal = [0x0F, 0x0F, 0x0F, 0x28];
    for (let s = 0; s < fadeStep; s++) statusPal[3] = nesColorFade(statusPal[3]);
    const textBytes = _nameToBytes(_searchingHere ? 'Searching...' : 'Inviting...');
    const textW     = measureText(textBytes);
    const boxRight  = HUD_RIGHT_X + HUD_RIGHT_W - 8;
    const boxW      = boxRight - panelLeft;
    if (textW <= boxW) {
      drawText(ui.ctx, panelLeft, rowY + 16, textBytes, statusPal);
    } else {
      const SCROLL_PX_MS = 0.05;   // 50 px / s — readable NES-ish cadence
      const GAP_PX       = 12;
      const period       = textW + GAP_PX;
      const offset       = Math.floor((performance.now() * SCROLL_PX_MS) % period);
      ui.ctx.save();
      ui.ctx.beginPath();
      ui.ctx.rect(panelLeft, rowY + 14, boxW, 12);
      ui.ctx.clip();
      drawText(ui.ctx, panelLeft - offset, rowY + 16, textBytes, statusPal);
      drawText(ui.ctx, panelLeft - offset + period, rowY + 16, textBytes, statusPal);
      ui.ctx.restore();
    }
  } else {
    const maxHP = p.maxHP || 28;
    const hp = p.hp != null ? p.hp : maxHP;
    drawLvHpRow(ui.ctx, panelLeft, HUD_RIGHT_X + HUD_RIGHT_W - 8, rowY + 16, p.level, hp, maxHP, fadeStep);
  }
}

function _drawScrollArrows(panelTop, maxVisible, canScrollUp, canScrollDown) {
  if (!canScrollUp && !canScrollDown) return;
  const blink = Math.floor(Date.now() / 500) & 1;
  if (!blink) return;
  const fadeStep = Math.min(Math.max(_rosterTransFade(), rosterBattleFade), ROSTER_FADE_STEPS);
  // Info box right edge minus arrow width minus padding
  const ax = HUD_RIGHT_X + HUD_RIGHT_W - 8 - 2;
  if (canScrollUp) {
    const rowY = panelTop; // top-most row
    const ay = rowY + 2;   // top-right of info box
    const arrow = (fadeStep > 0 && ui.scrollArrowUpFade) ? ui.scrollArrowUpFade[fadeStep - 1] : ui.scrollArrowUp;
    if (arrow) ui.ctx.drawImage(arrow, ax, ay);
  }
  if (canScrollDown) {
    const rowY = panelTop + (maxVisible - 1) * ROSTER_ROW_H; // bottom-most row
    const ay = rowY + ROSTER_ROW_H - 8 - 2; // bottom-right of info box
    const arrow = (fadeStep > 0 && ui.scrollArrowDownFade) ? ui.scrollArrowDownFade[fadeStep - 1] : ui.scrollArrowDown;
    if (arrow) ui.ctx.drawImage(arrow, ax, ay);
  }
}

export function drawRoster() {
  if (titleSt.state !== 'done') return;
  if (transSt.state === 'loading') return;
  if (rosterBattleFade >= ROSTER_FADE_STEPS && battleSt.battleState !== 'none') return;

  const panelTop = HUD_VIEW_Y + 32;
  const panelH = HUD_VIEW_H - 32;

  const players = getRosterVisible();
  const maxVisible = Math.min(ROSTER_VISIBLE, players.length);
  const maxScroll = Math.max(0, players.length - maxVisible);
  if (inputSt.rosterScroll > maxScroll) inputSt.rosterScroll = maxScroll;

  const canScrollUp = inputSt.rosterScroll > 0;
  const canScrollDown = inputSt.rosterScroll < maxScroll;

  ui.ctx.save();
  ui.ctx.beginPath();
  ui.ctx.rect(HUD_RIGHT_X, panelTop, HUD_RIGHT_W, panelH);
  ui.ctx.clip();
  for (let i = 0; i < maxVisible; i++) {
    const idx = inputSt.rosterScroll + i;
    if (idx >= players.length) break;
    _drawRosterRow(players[idx], i, panelTop);
  }
  ui.ctx.restore();

  _drawScrollArrows(panelTop, maxVisible, canScrollUp, canScrollDown);

  drawRosterSparkle(panelTop);

  // Cursor
  if (inputSt.rosterState === 'browse' || inputSt.rosterState === 'menu' || inputSt.rosterState === 'menu-in' || inputSt.rosterState === 'menu-out') {
    const visIdx = inputSt.rosterCursor - inputSt.rosterScroll;
    const curTarget = players[inputSt.rosterCursor];
    const curSlide = curTarget ? (rosterSlideY[curTarget.name] || 0) : 0;
    const curY = panelTop + visIdx * ROSTER_ROW_H + curSlide + 12;
    if (ui.cursorTileCanvas) ui.ctx.drawImage(ui.cursorTileCanvas, HUD_RIGHT_X - 4, curY);
  }
}

export function drawRosterMenu() {
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
    if (t >= 1) {
      // Exit target is set by the dispatch (Battle → 'none', stubs/cancel → 'browse').
      // v1.7.221 — replaces the old msgState race that could flip between 'none' and 'browse'
      // during the 1.5–4 s gap of Battle's two-message flow.
      inputSt.rosterState = inputSt.rosterMenuExitTo || 'browse';
      inputSt.rosterMenuTimer = 0;
      inputSt.rosterMenuTarget = null;
      inputSt.rosterMenuExitTo = 'browse';
    }
  }

  clipToViewport();
  drawBorderedBox(menuX, menuY, menuW, menuH, false);

  if (inputSt.rosterState === 'menu') {
    const textPal = TEXT_WHITE;
    // Battle → "Cancel" when search is active on the stashed target.
    // v1.7.222 — gives the user a discoverable cancel without inventing a
    // new keybinding.
    const searching = isSearchingFor(inputSt.rosterMenuTarget);
    const inviting  = isInvitingTarget(inputSt.rosterMenuTarget);
    const inParty   = isInParty(inputSt.rosterMenuTarget);
    const trading   = isTradingWith(inputSt.rosterMenuTarget);
    for (let i = 0; i < ROSTER_MENU_ITEMS.length; i++) {
      let label = ROSTER_MENU_ITEMS[i];
      if (label === 'Battle' && searching) label = 'Cancel';
      // Party: 'Cancel' mid-invite, 'Dismiss' once they're a member,
      // 'Party' otherwise. Single source — stashed target carries through
      // the menu fade-out, same as Battle. v1.7.235.
      else if (label === 'Party' && inviting) label = 'Cancel';
      else if (label === 'Party' && inParty)  label = 'Dismiss';
      else if (label === 'Trade' && trading)  label = 'Cancel';
      const labelBytes = _nameToBytes(label);
      drawText(ui.ctx, menuX + 16, menuY + 8 + i * 14, labelBytes, textPal);
    }
    if (ui.cursorTileCanvas) {
      ui.ctx.drawImage(ui.cursorTileCanvas, menuX + 2, menuY + 4 + inputSt.rosterMenuCursor * 14);
    }
  }

  ui.ctx.restore();
}
