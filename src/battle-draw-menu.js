// Battle menu + victory box drawing — extracted from battle-drawing.js v1.7.183.
//
// Owns the bottom-panel HUD: enemy-name box, action menu (Fight/Guard|Magic/Item/Run),
// item list, spell list, victory celebration text, reward text. Pure rendering — no
// state mutation. The only outside callers are `drawBattleMenu` and `drawVictoryBox`
// invoked from `drawBattle` in `battle-drawing.js`.

import { battleSt, BATTLE_TEXT_STEPS, BATTLE_TEXT_STEP_MS } from './battle-state.js';
import { drawText, measureText } from './font-renderer.js';
import { nesColorFade, _makeFadedPal } from './palette.js';
import {
  BATTLE_GOBLIN_NAME, BATTLE_BOSS_NAME, BATTLE_LEVEL_UP, BATTLE_JOB_LEVEL_UP,
  BATTLE_FOUND, BATTLE_MENU_ITEMS, BATTLE_MAGIC,
} from './data/strings.js';
import { getMonsterName, getItemNameClean, getSpellNameClean } from './text-decoder.js';
import { getSpellMPCost } from './data/spells.js';
import { ps } from './player-stats.js';
import {
  _nameToBytes, _buildItemRowBytes, makeExpText, makeGilText, makeCpText, makeItemDropText,
} from './text-utils.js';
import { pvpSt } from './pvp.js';
import { inputSt } from './input-handler.js';
import { ui } from './ui-state.js';
import { isVictoryBattleState } from './battle-update.js';
import { drawCursorFaded, drawBorderedBox } from './hud-drawing.js';

// ── Layout constants (match battle-drawing.js) ────────────────────────────
const HUD_BOT_Y = 176, HUD_BOT_H = 64;
const CANVAS_W = 256;
const BATTLE_PANEL_W = 120;
const INV_SLOTS = 3;
// BATTLE_TEXT_STEPS / BATTLE_TEXT_STEP_MS now imported from battle-state.js (single source).
const BOSS_BOX_EXPAND_MS = 300;
const VICTORY_BOX_W = BATTLE_PANEL_W;
const VICTORY_BOX_H = HUD_BOT_H;
const VICTORY_BOX_ROWS = HUD_BOT_H / 8;
const VICTORY_ROW_FRAME_MS = 16.67;

// Mage jobs (White, Black, Red) see "Magic" in slot 1 instead of "Guard".
const _MAGE_JOBS = new Set([3, 4, 5]);

function _cursorTileCanvas() { return ui.cursorTileCanvas; }

// ── Item panel ────────────────────────────────────────────────────────────

function _drawBattleItemList(baseX, rightAreaW, invPal, slidePixel, totalInvPages) {
  const rowH = 14;
  const topY = HUD_BOT_Y + 12;
  ui.ctx.save();
  ui.ctx.beginPath();
  ui.ctx.rect(baseX - 8, HUD_BOT_Y + 8, rightAreaW + 8, HUD_BOT_H - 16);
  ui.ctx.clip();
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
      drawText(ui.ctx, px + 8, topY, rRow, invPal);
      const lName = ps.weaponL !== 0 ? getItemNameClean(ps.weaponL) : new Uint8Array([0xC2,0xC2,0xC2]);
      const lRow = new Uint8Array(LH_LABEL.length + lName.length);
      lRow.set(LH_LABEL, 0); lRow.set(lName, LH_LABEL.length);
      drawText(ui.ctx, px + 8, topY + rowH + 6, lRow, invPal);
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
        drawText(ui.ctx, px + 8, topY + r * rowH, rowBytes, invPal);
      }
    }
  }
  ui.ctx.restore();
}
function _drawBattleItemCursors(baseX) {
  if (!_cursorTileCanvas() || battleSt.battleState !== 'item-select') return;
  const rowH = 14;
  const topY = HUD_BOT_Y + 12;
  const rowY = (page, row) => page === 0 ? topY + row * (rowH + 6) : topY + row * rowH;
  const curPx = baseX - 8;
  if (inputSt.itemHeldIdx !== -1) {
    const heldIsEq = inputSt.itemHeldIdx <= -100;
    const heldPage = heldIsEq ? 0 : 1 + Math.floor(inputSt.itemHeldIdx / INV_SLOTS);
    const heldRow  = heldIsEq ? -(inputSt.itemHeldIdx + 100) : inputSt.itemHeldIdx % INV_SLOTS;
    if (heldPage === inputSt.itemPage) ui.ctx.drawImage(_cursorTileCanvas(), curPx, rowY(heldPage, heldRow) - 4);
  }
  const activeX = inputSt.itemHeldIdx !== -1 ? curPx - 4 : curPx;
  ui.ctx.drawImage(_cursorTileCanvas(), activeX, rowY(inputSt.itemPage, inputSt.itemPageCursor) - 4);
}
function _drawBattleItemPanel(menuX) {
  const ITEM_SLIDE_MS = 200;
  const rightAreaW = CANVAS_W - BATTLE_PANEL_W - 8;
  const invPal = [0x0F, 0x0F, 0x0F, 0x30];
  let invFadeStep = 0;
  if (battleSt.battleState === 'item-list-in') invFadeStep = BATTLE_TEXT_STEPS - Math.min(Math.floor(battleSt.battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
  else if (battleSt.battleState === 'item-cancel-out' || battleSt.battleState === 'item-list-out') invFadeStep = Math.min(Math.floor(battleSt.battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
  for (let s = 0; s < invFadeStep; s++) invPal[3] = nesColorFade(invPal[3]);
  if (inputSt.menuMode === 'magic') {
    _drawBattleSpellList(menuX, rightAreaW, invPal);
    _drawBattleSpellCursor(menuX);
    return;
  }
  const totalInvPages = Math.max(1, Math.ceil(inputSt.itemSelectList.length / INV_SLOTS));
  let slidePixel = 0;
  if (battleSt.battleState === 'item-slide') slidePixel = inputSt.itemSlideDir * Math.min(battleSt.battleTimer / ITEM_SLIDE_MS, 1) * rightAreaW;
  _drawBattleItemList(menuX, rightAreaW, invPal, slidePixel, totalInvPages);
  _drawBattleItemCursors(menuX);
}

// ── Spell panel ───────────────────────────────────────────────────────────

// Bottom-panel content area is HUD_BOT_H - 16 = 48 px tall after the 8 px
// inset on top + bottom. At rowH=12, exactly 4 rows fit. The list scrolls
// when the player knows more than 4 castable spells.
const SPELL_ROW_H = 12;
const SPELL_VISIBLE_ROWS = 4;

// Pure-derive scroll position from cursor so we don't need new persistent
// state: scrollTop centers the cursor in the 4-row window when possible,
// clamped so we never scroll past either end of the list.
function _spellScrollTop(list) {
  if (list.length <= SPELL_VISIBLE_ROWS) return 0;
  const half = Math.floor(SPELL_VISIBLE_ROWS / 2);
  return Math.max(0, Math.min(
    list.length - SPELL_VISIBLE_ROWS,
    inputSt.itemPageCursor - half,
  ));
}

function _drawBattleSpellList(baseX, rightAreaW, palette) {
  const topY = HUD_BOT_Y + 12;
  ui.ctx.save();
  ui.ctx.beginPath();
  ui.ctx.rect(baseX - 8, HUD_BOT_Y + 8, rightAreaW + 8, HUD_BOT_H - 16);
  ui.ctx.clip();
  const list = inputSt.spellSelectList;
  // Empty state — defensive. Magic action shouldn't be reachable without a
  // castable spell, but if it ever is, render "No spells" so the panel
  // isn't a blank box.
  if (list.length === 0) {
    const noSpellsBytes = _nameToBytes('No spells');
    drawText(ui.ctx, baseX + 8, topY, noSpellsBytes, palette);
    ui.ctx.restore();
    return;
  }
  // Gray palette for spells the player can't afford. Reuses the same
  // base palette but swaps the active text color (slot 3) to NES $10
  // (gray) — visually differentiates from full-color affordable rows
  // without re-rendering glyphs in a separate pass.
  const fadedPal = [...palette];
  fadedPal[3] = 0x10;
  const scrollTop = _spellScrollTop(list);
  const rowCount = Math.min(SPELL_VISIBLE_ROWS, list.length);
  for (let i = 0; i < rowCount; i++) {
    const idx = scrollTop + i;
    const spellId = list[idx];
    const name = getSpellNameClean(spellId);
    const cost = getSpellMPCost(spellId);
    const affordable = ps.mp >= cost;
    const rowPal = affordable ? palette : fadedPal;
    drawText(ui.ctx, baseX + 8, topY + i * SPELL_ROW_H, name, rowPal);
    if (cost > 0) {
      const costStr = String(cost);
      const costBytes = new Uint8Array(costStr.length);
      for (let c = 0; c < costStr.length; c++) costBytes[c] = 0x80 + parseInt(costStr[c]);
      // Bottom panel's outer clip is rect(8, HUD_BOT_Y, CANVAS_W-16, HUD_BOT_H) so the
      // right edge sits at x=248. Place cost so its right edge is at x=240 (8px margin).
      const PANEL_INNER_RIGHT = CANVAS_W - 16;
      const costX = PANEL_INNER_RIGHT - measureText(costBytes);
      drawText(ui.ctx, costX, topY + i * SPELL_ROW_H, costBytes, rowPal);
    }
  }
  // Scroll indicators — reuse the global 8×8 arrow tiles already cached in
  // `ui.scrollArrow{Up,Down}` (built once in sprite-init). Pinned to the
  // right edge of the panel area, blink at 250 ms cadence so they read as
  // active hints rather than static decoration.
  const arrowX = baseX + rightAreaW - 12;
  const blink = (Math.floor(Date.now() / 250) & 1) === 0;
  if (scrollTop > 0 && ui.scrollArrowUp && blink) {
    ui.ctx.drawImage(ui.scrollArrowUp, arrowX, topY - 4);
  }
  if (scrollTop + SPELL_VISIBLE_ROWS < list.length && ui.scrollArrowDown && blink) {
    ui.ctx.drawImage(ui.scrollArrowDown, arrowX, topY + SPELL_VISIBLE_ROWS * SPELL_ROW_H - 4);
  }
  ui.ctx.restore();
}

function _drawBattleSpellCursor(baseX) {
  if (!_cursorTileCanvas() || battleSt.battleState !== 'item-select' || inputSt.menuMode !== 'magic') return;
  const topY = HUD_BOT_Y + 12;
  const list = inputSt.spellSelectList;
  if (list.length === 0) return;
  const cursorRow = inputSt.itemPageCursor - _spellScrollTop(list);
  ui.ctx.drawImage(_cursorTileCanvas(), baseX - 8, topY + cursorRow * SPELL_ROW_H - 4);
}

// ── Battle menu (action selection + enemy name box) ───────────────────────

function _battleMenuStates() {
  const bs = battleSt.battleState;
  const isSlide   = bs === 'enemy-box-expand' || bs === 'encounter-box-expand';
  const isAppear  = bs === 'boss-appear' || bs === 'monster-slide-in';
  const isFade    = bs === 'battle-fade-in';
  const isMenu    = isFade || bs === 'menu-open' || bs === 'target-select' || bs === 'confirm-pause' ||
    bs === 'attack-back' || bs === 'attack-fwd' || bs === 'player-slash' || bs === 'player-hit-show' || bs === 'player-miss-show' ||
    bs === 'player-damage-show' || bs === 'pre-monster-death' || bs === 'monster-death' || bs === 'defend-anim' ||
    bs.startsWith('item-') ||
    bs === 'magic-cast' || bs === 'magic-hit' ||
    bs === 'run-success' || bs === 'run-fail' || bs === 'enemy-flash' ||
    bs === 'enemy-attack' || bs === 'enemy-damage-show' || bs === 'poison-tick' || bs === 'poison-end-tick' || bs === 'pvp-second-windup' ||
    bs === 'pvp-ally-appear' || bs === 'pvp-defend-anim' || bs === 'pvp-enemy-slash' ||
    bs === 'pvp-opp-potion' || bs === 'pvp-opp-sw-throw' || bs === 'pvp-opp-sw-hit' || bs === 'message-hold' || bs === 'msg-wait' ||
    bs.startsWith('ally-') || bs === 'boss-dissolve';
  const isVictory = isVictoryBattleState() || bs === 'victory-name-out' || bs === 'encounter-box-close' || bs === 'enemy-box-close';
  const isRunBox  = bs.startsWith('run-');
  const isClose   = bs === 'victory-box-close' || bs === 'encounter-box-close' || bs === 'enemy-box-close';
  return { isSlide, isAppear, isFade, isMenu, isVictory, isRunBox, isClose };
}
export function drawBattleMenu() {
  const { isSlide, isAppear, isFade, isMenu, isVictory, isRunBox, isClose } = _battleMenuStates();
  if (!isSlide && !isAppear && !isMenu && !isVictory) return;

  let panelOffX = 0;
  if (isSlide) panelOffX = Math.round(-CANVAS_W * (1 - Math.min(battleSt.battleTimer / BOSS_BOX_EXPAND_MS, 1)));
  else if (isClose) panelOffX = Math.round(-CANVAS_W * Math.min(battleSt.battleTimer / (VICTORY_BOX_ROWS * VICTORY_ROW_FRAME_MS), 1));

  ui.ctx.save();
  ui.ctx.beginPath(); ui.ctx.rect(8, HUD_BOT_Y, CANVAS_W - 16, HUD_BOT_H); ui.ctx.clip();
  ui.ctx.translate(panelOffX, 0);
  ui.ctx.fillStyle = '#000';
  ui.ctx.fillRect(8, HUD_BOT_Y + 8, CANVAS_W - 16, HUD_BOT_H - 16);

  const boxW = BATTLE_PANEL_W, boxH = HUD_BOT_H;
  if ((!isVictory && !isRunBox) || (battleSt.battleState === 'encounter-box-close' && battleSt.runSlideBack))
    drawBorderedBox(0, HUD_BOT_Y, boxW, boxH);
  if (!isMenu && !isVictory) { ui.ctx.restore(); return; }

  let fadeStep = 0;
  if (isFade) fadeStep = BATTLE_TEXT_STEPS - Math.min(Math.floor(battleSt.battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
  const fadedPal = _makeFadedPal(fadeStep);
  if (!isVictory && !isRunBox) {
    if (pvpSt.isPVPBattle) {
      // Collect all living PVP enemy names and stack them
      const names = [];
      if (!battleSt.enemyDefeated && pvpSt.pvpPlayerTargetIdx < 0 && pvpSt.pvpOpponentStats)
        names.push(_nameToBytes(pvpSt.pvpOpponentStats.name));
      for (let i = 0; i < pvpSt.pvpEnemyAllies.length; i++) {
        const a = pvpSt.pvpEnemyAllies[i];
        if (a && a.hp > 0 && i >= pvpSt.pvpPlayerTargetIdx)
          names.push(_nameToBytes(a.name));
      }
      const rowH = 10;
      const startY = HUD_BOT_Y + Math.floor((boxH - names.length * rowH) / 2);
      names.forEach((nb, i) => {
        drawText(ui.ctx, Math.floor((boxW - measureText(nb)) / 2), startY + i * rowH, nb, fadedPal);
      });
    } else if (battleSt.isRandomEncounter && battleSt.encounterMonsters) {
      const names = _battleEnemyNames();
      const rowH = 10;
      const startY = HUD_BOT_Y + Math.floor((boxH - names.length * rowH) / 2);
      names.forEach((nb, i) => {
        drawText(ui.ctx, Math.floor((boxW - measureText(nb)) / 2), startY + i * rowH, nb, fadedPal);
      });
    } else {
      const enemyName = _battleEnemyName();
      drawText(ui.ctx, Math.floor((boxW - measureText(enemyName)) / 2), HUD_BOT_Y + Math.floor((boxH - 8) / 2), enemyName, fadedPal);
    }
  }
  const menuX = boxW + 8;
  const positions = [[menuX, HUD_BOT_Y+16], [menuX+56, HUD_BOT_Y+16], [menuX, HUD_BOT_Y+32], [menuX+56, HUD_BOT_Y+32]];
  _drawBattleMenuItems(positions, isVictory, isClose, isFade, fadedPal, menuX);
  _drawBattleMenuCursor(positions, isFade, fadeStep);
  ui.ctx.restore();
}

function _drawBattleMenuItems(positions, isVictory, isClose, isFade, fadedPal, menuX) {
  const isMenuFade = battleSt.battleState === 'victory-menu-fade';
  const isItemMenuOut = battleSt.battleState === 'item-menu-out';
  const isItemMenuIn = battleSt.battleState === 'item-cancel-in' || battleSt.battleState === 'item-use-menu-in';
  const isItemShowInv = battleSt.battleState === 'item-list-in' || battleSt.battleState === 'item-select' ||
    battleSt.battleState === 'item-cancel-out' || battleSt.battleState === 'item-list-out' || battleSt.battleState === 'item-slide' ||
    battleSt.battleState === 'item-target-select';
  if (!isClose && !isItemShowInv) {
    let menuPal;
    if (isMenuFade || isItemMenuOut) {
      const mfStep = Math.min(Math.floor(battleSt.battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
      menuPal = [0x0F, 0x0F, 0x0F, 0x30];
      for (let s = 0; s < mfStep; s++) menuPal[3] = nesColorFade(menuPal[3]);
    } else if (isItemMenuIn) {
      const mfStep = BATTLE_TEXT_STEPS - Math.min(Math.floor(battleSt.battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
      menuPal = [0x0F, 0x0F, 0x0F, 0x30];
      for (let s = 0; s < mfStep; s++) menuPal[3] = nesColorFade(menuPal[3]);
    } else {
      menuPal = isVictory ? [0x0F, 0x0F, 0x0F, 0x30] : fadedPal;
    }
    const isMage = _MAGE_JOBS.has(ps.jobIdx);
    for (let i = 0; i < BATTLE_MENU_ITEMS.length; i++) {
      const label = (i === 1 && isMage) ? BATTLE_MAGIC : BATTLE_MENU_ITEMS[i];
      drawText(ui.ctx, positions[i][0], positions[i][1], label, menuPal);
    }
  }
  if (isItemShowInv) _drawBattleItemPanel(menuX);
}

function _drawBattleMenuCursor(positions, isFade, fadeStep) {
  if (!_cursorTileCanvas()) return;
  if (battleSt.battleState !== 'menu-open' && !isFade) return;
  if (battleSt.battleState === 'target-select') return;
  const curX = positions[inputSt.battleCursor][0] - 16;
  const curY = positions[inputSt.battleCursor][1] - 4;
  drawCursorFaded(curX, curY, fadeStep);
}

// ── Enemy name helpers (also used by victory box) ─────────────────────────

function _battleEnemyNames() {
  const names = [];
  const seen = new Set();
  for (const m of battleSt.encounterMonsters) {
    if (m.hp <= 0 || seen.has(m.monsterId)) continue;
    seen.add(m.monsterId);
    const baseName = getMonsterName(m.monsterId) || BATTLE_GOBLIN_NAME;
    const count = battleSt.encounterMonsters.filter(e => e.hp > 0 && e.monsterId === m.monsterId).length;
    if (count > 1) {
      const arr = Array.from(baseName);
      arr.push(0xFF, 0xE1, 0x80 + count);
      names.push(new Uint8Array(arr));
    } else {
      names.push(baseName);
    }
  }
  return names.length > 0 ? names : [BATTLE_GOBLIN_NAME];
}

function _battleEnemyName() {
  if (pvpSt.isPVPBattle) {
    const ti = pvpSt.pvpPlayerTargetIdx;
    if (ti >= 0 && pvpSt.pvpEnemyAllies[ti]) return _nameToBytes(pvpSt.pvpEnemyAllies[ti].name);
    if (pvpSt.pvpOpponentStats) return _nameToBytes(pvpSt.pvpOpponentStats.name);
  }
  if (battleSt.isRandomEncounter && battleSt.encounterMonsters) {
    // Use targeted monster's name (or first alive if no target)
    const ti = (inputSt.targetIndex >= 0 && inputSt.targetIndex < battleSt.encounterMonsters.length && battleSt.encounterMonsters[inputSt.targetIndex].hp > 0)
      ? inputSt.targetIndex
      : battleSt.encounterMonsters.findIndex(m => m.hp > 0);
    const monsterId = battleSt.encounterMonsters[ti >= 0 ? ti : 0].monsterId;
    const baseName = getMonsterName(monsterId) || BATTLE_GOBLIN_NAME;
    // Count how many of this same type are alive
    const aliveOfType = battleSt.encounterMonsters.filter(m => m.hp > 0 && m.monsterId === monsterId).length;
    if (aliveOfType > 1) {
      const arr = Array.from(baseName);
      arr.push(0xFF, 0xE1, 0x80 + aliveOfType);
      return new Uint8Array(arr);
    }
    return baseName;
  }
  return BATTLE_BOSS_NAME;
}

// ── Victory / reward box ──────────────────────────────────────────────────

function _isRewardState() {
  const bs = battleSt.battleState;
  return bs.startsWith('exp-') || bs.startsWith('gil-') || bs.startsWith('cp-') ||
    bs.startsWith('item-') || bs.startsWith('levelup-') || bs.startsWith('joblv-');
}
export function drawVictoryBox() {
  const bs = battleSt.battleState;
  const isNameOut    = bs === 'victory-name-out';
  const isCelebrate  = bs === 'victory-celebrate';
  const isClose      = bs === 'victory-box-close';
  const isOut        = bs === 'victory-text-out';
  const isMenuFade   = bs === 'victory-menu-fade';
  const isRun        = bs === 'run-success';
  const isRunFail    = bs === 'run-fail';
  const isReward     = _isRewardState();
  const showBox = isNameOut || isCelebrate || isClose ||
    isOut || isMenuFade || isRun || isRunFail || isReward;
  if (!showBox) return;

  let boxX = 0;
  const boxY = HUD_BOT_Y;
  if (isClose) boxX = Math.round(-(CANVAS_W - 8) * Math.min(battleSt.battleTimer / (VICTORY_BOX_ROWS * VICTORY_ROW_FRAME_MS), 1));

  if (isNameOut) { _drawVictoryNameOut(boxX, boxY); return; }
  drawBorderedBox(boxX, boxY, VICTORY_BOX_W, VICTORY_BOX_H);
  if (isReward) _drawRewardText(boxX, boxY);
}

function _drawVictoryNameOut(boxX, boxY) {
  drawBorderedBox(boxX, boxY, VICTORY_BOX_W, VICTORY_BOX_H);
  const fadeStep = Math.min(Math.floor(battleSt.battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
  const fadedPal = _makeFadedPal(fadeStep);
  const enemyName = _battleEnemyName();
  const nameTw = measureText(enemyName);
  drawText(ui.ctx, Math.floor((VICTORY_BOX_W - nameTw) / 2), boxY + Math.floor((VICTORY_BOX_H - 8) / 2), enemyName, fadedPal);
}

function _drawRewardText(boxX, boxY) {
  const bs = battleSt.battleState;
  let fadeStep = 0;
  if (bs.endsWith('-text-in'))
    fadeStep = BATTLE_TEXT_STEPS - Math.min(Math.floor(battleSt.battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
  else if (bs.endsWith('-fade-out'))
    fadeStep = Math.min(Math.floor(battleSt.battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
  const pal = _makeFadedPal(fadeStep);
  const midY = boxY + Math.floor(VICTORY_BOX_H / 2);
  const drawCentered = (msg, y) => {
    const tw = measureText(msg);
    drawText(ui.ctx, boxX + Math.floor((VICTORY_BOX_W - tw) / 2), y, msg, pal);
  };

  if (bs.startsWith('item-')) {
    if (battleSt.encounterDropItem === null) return;
    drawCentered(BATTLE_FOUND, midY - 10);
    drawCentered(makeItemDropText(battleSt.encounterDropItem), midY + 2);
    return;
  }

  let msg = null;
  if (bs.startsWith('exp-')) msg = makeExpText(battleSt.encounterExpGained);
  else if (bs.startsWith('gil-')) msg = makeGilText(battleSt.encounterGilGained);
  else if (bs.startsWith('cp-')) msg = makeCpText(battleSt.encounterCpGained);
  else if (bs.startsWith('levelup-')) msg = BATTLE_LEVEL_UP;
  else if (bs.startsWith('joblv-')) msg = battleSt.encounterJobLevelUp ? BATTLE_JOB_LEVEL_UP : null;
  if (!msg) return;
  drawCentered(msg, midY - 4);
}
