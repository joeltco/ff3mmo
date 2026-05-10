// Encounter monsters + boss sprite box drawing — extracted from
// battle-drawing.js v1.7.184. Owns the central enemy-area rendering: random
// encounter grid (1-4 monsters), boss sprite, dissolve animation, slash hit
// overlays on enemies, target-select cursors. Pure rendering — no state
// mutation. Outside callers: `drawEncounterBox` and `drawBossSpriteBox`
// invoked from `drawBattle` in `battle-drawing.js`.

import { battleSt } from './battle-state.js';
import { _calcBoxExpandSize } from './battle-layout.js';
import { encounterBoxDims } from './battle-grid.js';
import { getMonsterCanvas, getMonsterWhiteCanvas, hasMonsterSprites } from './monster-sprites.js';
import { getBossBattleCanvas, getBossWhiteCanvas } from './boss-sprites.js';
import { inputSt } from './input-handler.js';
import { bsc, getSlashFramesForWeapon } from './battle-sprite-cache.js';
import { drawSlashOverlay, SLASH_FRAME_MS, shouldDrawSlash } from './slash-effects.js';
import { getSpellTargets } from './spell-cast.js';
import { pvpSt } from './pvp.js';
import { drawBossSpriteBoxPVP } from './pvp-drawing.js';
import { ui } from './ui-state.js';
import { isVictoryBattleState } from './battle-update.js';
import { clipToViewport, drawBorderedBox } from './hud-drawing.js';
import { drawMonsterDeath as _drawMonsterDeath } from './render.js';
import { _encounterGridPos } from './battle-layout.js';

// ── Layout constants (match battle-drawing.js) ────────────────────────────
const HUD_VIEW_X = 0, HUD_VIEW_Y = 32, HUD_VIEW_W = 144, HUD_VIEW_H = 144;
const BOSS_PREFLASH_MS = 133;
const BOSS_BLOCK_SIZE = 16;
const BOSS_BLOCK_COLS = 3;
const BOSS_BLOCKS = 9;
const BOSS_DISSOLVE_STEPS = 8;
const BOSS_DISSOLVE_FRAME_MS = 16.67;
const MONSTER_DEATH_MS = 250;
const MONSTER_SLIDE_MS = 267;
const SLASH_FRAMES = 3;

function _cursorTileCanvas() { return ui.cursorTileCanvas; }

// Module-local cache for the boss-dissolve pixel-shift block buffer.
let _shiftBlockCanvas = null;

// ── Encounter grid (random encounter, 1-4 monsters) ───────────────────────

function _drawEncounterMonsters(gridPos, sprH, boxX, boxY, boxW, boxH, isSlideIn, fullW, slotCenterY, row0H, row1H) {
  if (!battleSt.goblinBattleCanvas && !hasMonsterSprites()) return;
  let slideOffX = 0;
  if (isSlideIn) slideOffX = Math.floor((1 - Math.min(battleSt.battleTimer / MONSTER_SLIDE_MS, 1)) * (fullW + 32));

  ui.ctx.save();
  ui.ctx.beginPath();
  ui.ctx.rect(boxX + 8, boxY + 8, boxW - 16, boxH - 16);
  ui.ctx.clip();
  ui.ctx.imageSmoothingEnabled = false;

  const count = battleSt.encounterMonsters.length;
  for (let i = 0; i < count; i++) {
    const alive = battleSt.encounterMonsters[i].hp > 0;
    const isDying = battleSt.dyingMonsterIndices.has(i) && battleSt.battleState === 'monster-death';
    // Spell targets must keep rendering during magic-hit even after HP hits 0 —
    // damage applies mid-state for thrown spells, then the state runs another
    // ~500 ms (damage-number bounce window) before transitioning to
    // monster-death. Without this branch the sprite vanishes for that window
    // and the death wipe looks like a sudden flash-then-disappear.
    const isMagicHitTarget = battleSt.battleState === 'magic-hit' &&
      getSpellTargets().some(t => t.type === 'enemy' && t.index === i);
    // Same rule for ALLY cast on encounter monster — the impact burst plays
    // for ~850 ms after damage applies; without this the killed monster
    // vanishes mid-burst (caught 2026-05-09 — user reported "spell animation
    // makes target disappear during").
    const isAllyMagicHitTarget = battleSt.battleState === 'ally-magic-hit' &&
      battleSt.allyMagicTargetType === 'enemy' &&
      battleSt.allyMagicTargetIdx === i;
    const isBeingHit = (i === inputSt.targetIndex &&
      (battleSt.battleState === 'player-slash' || battleSt.battleState === 'player-hit-show' ||
       battleSt.battleState === 'player-miss-show' || battleSt.battleState === 'player-damage-show' ||
       battleSt.battleState === 'pre-monster-death')) ||
      (i === battleSt.allyTargetIndex && (battleSt.battleState === 'ally-slash' || battleSt.battleState === 'ally-damage-show')) ||
      isMagicHitTarget || isAllyMagicHitTarget;
    if (!alive && !isDying && !isBeingHit) continue;

    const pos = gridPos[i];
    if (!pos) continue;  // gridPos / encounterMonsters length mismatch — skip rather than crash the rest of drawBattle
    const drawX = pos.x - slideOffX;
    const mid = battleSt.encounterMonsters[i].monsterId;
    const sprNormal = getMonsterCanvas(mid, battleSt.goblinBattleCanvas);
    const sprWhite  = getMonsterWhiteCanvas(mid, battleSt.goblinWhiteCanvas);
    const thisH = sprNormal ? sprNormal.height : sprH;
    const rH = i < 2 ? (row0H || sprH) : (row1H || sprH);
    const drawY = pos.y + (rH - thisH);

    if (isDying) {
      const delay = battleSt.dyingMonsterIndices.get(i) || 0;
      _drawMonsterDeath(drawX, drawY, thisH, Math.min(Math.max(0, battleSt.battleTimer - delay) / MONSTER_DEATH_MS, 1), mid);
    } else {
      const curHit = inputSt.hitResults && inputSt.hitResults[battleSt.currentHitIdx];
      const isHitBlink = (isBeingHit && battleSt.battleState === 'player-slash' && shouldDrawSlash(curHit) && (Math.floor(battleSt.battleTimer / 60) & 1)) ||
                         (isBeingHit && battleSt.battleState === 'ally-slash' && shouldDrawSlash(battleSt.allyHitResult) && (Math.floor(battleSt.battleTimer / 60) & 1));
      const isFlashing = battleSt.battleState === 'enemy-flash' && battleSt.currentAttacker === i && Math.floor(battleSt.battleTimer / 33) % 2 === 1;
      if (!isHitBlink) ui.ctx.drawImage(isFlashing ? sprWhite : sprNormal, drawX, drawY);
    }
  }

  _drawEncounterSlashEffects(gridPos, slideOffX, slotCenterY);
  ui.ctx.restore();
}
function _drawEncounterSlashEffects(gridPos, slideOffX, slotCenterY) {
  if (battleSt.battleState === 'player-slash' && bsc.slashFrames && battleSt.slashFrame < SLASH_FRAMES &&
      shouldDrawSlash(inputSt.hitResults && inputSt.hitResults[battleSt.currentHitIdx])) {
    // Same defensive guard as _drawEncounterCursors below — targetIndex can
    // drift out of gridPos if a monster died mid-frame.
    const pos = gridPos[inputSt.targetIndex];
    if (pos) ui.ctx.drawImage(bsc.slashFrames[battleSt.slashFrame], pos.x - slideOffX + battleSt.slashOffX + 8, slotCenterY(inputSt.targetIndex) + battleSt.slashOffY);
  }
  if (battleSt.battleState === 'ally-slash' && shouldDrawSlash(battleSt.allyHitResult)) {
    const ally = battleSt.battleAllies[battleSt.currentAllyAttacker];
    const isLeft = battleSt.allyHitIsLeft;
    const activeWpnId = ally ? (isLeft ? ally.weaponL : ally.weaponId) : 0;
    const allySlashFrames = ally ? getSlashFramesForWeapon(activeWpnId, !isLeft) : bsc.slashFramesR;
    const af = Math.min(Math.floor(battleSt.battleTimer / SLASH_FRAME_MS), 2);
    const pos = gridPos[battleSt.allyTargetIndex];
    if (pos && allySlashFrames) {
      drawSlashOverlay(ui.ctx, allySlashFrames[af], af, pos.x + 8, slotCenterY(battleSt.allyTargetIndex), { weaponId: activeWpnId || 0, hit: battleSt.allyHitResult });
    }
  }
}

function _drawEncounterCursors(gridPos, count, slotCenterY) {
  if (!(battleSt.battleState === 'target-select' || (battleSt.battleState === 'item-target-select' && inputSt.itemTargetType === 'enemy')) || !_cursorTileCanvas()) return;
  if (battleSt.battleState === 'target-select') {
    // Defensive: if targetIndex drifted out of gridPos (monster died mid-frame,
    // sticky targetIndex from a previous N-monster encounter, etc.), skip the
    // cursor draw rather than throw. The item-target branch below already
    // guards the same way. Crash here used to wipe the rest of drawBattle
    // every frame, taking the chat / msg strip / damage nums with it.
    const pos = gridPos[inputSt.targetIndex];
    if (pos) ui.ctx.drawImage(_cursorTileCanvas(), pos.x - 10, slotCenterY(inputSt.targetIndex) - 4);
  } else if (inputSt.itemTargetMode === 'single') {
    const pos = gridPos[inputSt.itemTargetIndex];
    if (pos) ui.ctx.drawImage(_cursorTileCanvas(), pos.x - 10, slotCenterY(inputSt.itemTargetIndex) - 4);
  } else if (Math.floor(Date.now() / 133) & 1) {
    const _rightCols = count === 1 ? [0] : count === 2 ? [1] : [1, 3];
    const _leftCols  = count === 2 ? [0] : count >= 3 ? [0, 2] : [];
    let targets = [];
    if (inputSt.itemTargetMode === 'all') targets = battleSt.encounterMonsters.map((m, i) => m.hp > 0 ? i : -1).filter(i => i >= 0);
    else if (inputSt.itemTargetMode === 'col-right') targets = _rightCols.filter(i => i < count && battleSt.encounterMonsters[i]?.hp > 0);
    else if (inputSt.itemTargetMode === 'col-left') targets = _leftCols.filter(i => i < count && battleSt.encounterMonsters[i]?.hp > 0);
    for (const ti of targets) if (gridPos[ti]) ui.ctx.drawImage(_cursorTileCanvas(), gridPos[ti].x - 10, slotCenterY(ti) - 4);
  }
}

function _isEncounterCombatState() {
  return battleSt.battleState === 'monster-slide-in' || battleSt.battleState === 'battle-fade-in' || battleSt.battleState === 'menu-open' ||
    battleSt.battleState === 'target-select' || battleSt.battleState === 'confirm-pause' || battleSt.battleState === 'attack-back' || battleSt.battleState === 'attack-fwd' ||
    battleSt.battleState === 'player-slash' || battleSt.battleState === 'player-hit-show' || battleSt.battleState === 'player-miss-show' ||
    battleSt.battleState === 'player-damage-show' || battleSt.battleState === 'pre-monster-death' || battleSt.battleState === 'monster-death' || battleSt.battleState === 'defend-anim' ||
    battleSt.battleState.startsWith('item-') ||
    battleSt.battleState === 'magic-cast' || battleSt.battleState === 'magic-hit' ||
    battleSt.battleState === 'run-success' || battleSt.battleState === 'run-fail' ||
    battleSt.battleState === 'enemy-flash' || battleSt.battleState === 'enemy-attack' || battleSt.battleState === 'enemy-damage-show' ||
    battleSt.battleState === 'poison-tick' || battleSt.battleState === 'poison-end-tick' || battleSt.battleState === 'message-hold' || battleSt.battleState === 'msg-wait' || battleSt.battleState.startsWith('ally-');
}
export function drawEncounterBox() {
  if (!battleSt.isRandomEncounter || !battleSt.encounterMonsters) return;
  const isExpand = battleSt.battleState === 'encounter-box-expand';
  const isClose = battleSt.battleState === 'encounter-box-close';
  const isSlideIn = battleSt.battleState === 'monster-slide-in';
  const isCombat = _isEncounterCombatState();
  const isVictory = isVictoryBattleState() || battleSt.battleState === 'victory-name-out';
  if (!isExpand && !isClose && !isCombat && !isVictory) return;

  const count = battleSt.encounterMonsters.length;
  const { fullW, fullH, sprH, row0H, row1H } = encounterBoxDims();
  const centerX = HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2);
  const centerY = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2);

  const { boxW, boxH } = _calcBoxExpandSize(fullW, fullH, isExpand, isClose, battleSt.battleTimer);
  const boxX = centerX - Math.floor(boxW / 2);
  const boxY = centerY - Math.floor(boxH / 2);

  clipToViewport();
  // Transparent-edge border tiles (same as title player-select boxes) — no
  // black halo around the encounter box.
  drawBorderedBox(boxX, boxY, boxW, boxH, false, true);

  if (isExpand || isClose) { ui.ctx.restore(); return; }

  const gridPos = _encounterGridPos(boxX, boxY, fullW, fullH, count, sprH, row0H, row1H);
  const rowH = (idx) => idx < 2 ? row0H : row1H;
  const slotCenterY = (idx) => {
    if (!gridPos[idx] || !battleSt.encounterMonsters[idx]) return 0;
    const c = getMonsterCanvas(battleSt.encounterMonsters[idx].monsterId, battleSt.goblinBattleCanvas);
    const h = c ? c.height : rowH(idx);
    return gridPos[idx].y + (rowH(idx) - h) + Math.floor(h / 2);
  };
  _drawEncounterMonsters(gridPos, sprH, boxX, boxY, boxW, boxH, isSlideIn, fullW, slotCenterY, row0H, row1H);
  _drawEncounterCursors(gridPos, count, slotCenterY);
  ui.ctx.restore();
}

// ── Boss sprite box (single-enemy boss / PVP duel) ────────────────────────

function _drawBossSprite(centerX, centerY) {
  const sprX = centerX - 24, sprY = centerY - 24;
  ui.ctx.imageSmoothingEnabled = false;
  if (battleSt.battleState === 'boss-appear' || battleSt.battleState === 'boss-dissolve') {
    _drawDissolvedSprite(sprX, sprY, battleSt.battleState === 'boss-dissolve');
  } else if (battleSt.battleState === 'enemy-flash') {
    const frame = Math.floor(battleSt.battleTimer / (BOSS_PREFLASH_MS / 8));
    if (!battleSt.enemyDefeated) ui.ctx.drawImage((frame & 1) ? (getBossWhiteCanvas() || getBossBattleCanvas()) : getBossBattleCanvas(), sprX, sprY);
  } else if (battleSt.battleState === 'player-slash') {
    if (!(Math.floor(battleSt.battleTimer / 60) & 1) && !battleSt.enemyDefeated) ui.ctx.drawImage(getBossBattleCanvas(), sprX, sprY);
    if (bsc.slashFrames && battleSt.slashFrame < SLASH_FRAMES && !battleSt.enemyDefeated &&
        shouldDrawSlash(inputSt.hitResults && inputSt.hitResults[battleSt.currentHitIdx]))
      ui.ctx.drawImage(bsc.slashFrames[battleSt.slashFrame], centerX - 8 + battleSt.slashOffX, centerY - 8 + battleSt.slashOffY);
  } else if (battleSt.battleState === 'ally-slash') {
    const blinkHidden = shouldDrawSlash(battleSt.allyHitResult) && (Math.floor(battleSt.battleTimer / 60) & 1);
    if (!blinkHidden && !battleSt.enemyDefeated) ui.ctx.drawImage(getBossBattleCanvas(), sprX, sprY);
    if (!battleSt.enemyDefeated && shouldDrawSlash(battleSt.allyHitResult)) {
      const ally = battleSt.battleAllies[battleSt.currentAllyAttacker];
      const isLeft = battleSt.allyHitIsLeft;
      const activeWpnId = ally ? (isLeft ? ally.weaponL : ally.weaponId) : 0;
      const allySlashFrames = ally ? getSlashFramesForWeapon(activeWpnId, !isLeft) : bsc.slashFramesR;
      const af = Math.min(Math.floor(battleSt.battleTimer / SLASH_FRAME_MS), 2);
      drawSlashOverlay(ui.ctx, allySlashFrames && allySlashFrames[af], af, centerX - 8, centerY - 8, { weaponId: activeWpnId || 0, hit: battleSt.allyHitResult });
    }
  } else {
    if (!battleSt.enemyDefeated) ui.ctx.drawImage(getBossBattleCanvas(), sprX, sprY);
  }
}
function _drawBossSpriteBoxBoss(centerX, centerY) {
  const isExpand = battleSt.battleState === 'enemy-box-expand';
  const isClose  = battleSt.battleState === 'enemy-box-close';
  const fullW = 64, fullH = 64;

  clipToViewport();

  const { boxW, boxH } = _calcBoxExpandSize(fullW, fullH, isExpand, isClose, battleSt.battleTimer);
  drawBorderedBox(centerX - Math.floor(boxW / 2), centerY - Math.floor(boxH / 2), boxW, boxH, false, true);

  if (isExpand || isClose) { ui.ctx.restore(); return; }

  _drawBossSprite(centerX, centerY);

  if ((battleSt.battleState === 'target-select' || (battleSt.battleState === 'item-target-select' && inputSt.itemTargetType === 'enemy')) && _cursorTileCanvas())
    ui.ctx.drawImage(_cursorTileCanvas(), centerX - 32 - 16, centerY - 8);

  ui.ctx.restore();
}
export function drawBossSpriteBox() {
  if (battleSt.isRandomEncounter) return;

  const centerX = HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2);
  const centerY = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2);

  if (pvpSt.isPVPBattle) {
    const isCombatPVP = battleSt.battleState === 'battle-fade-in' ||
                    battleSt.battleState === 'enemy-box-expand' || battleSt.battleState === 'enemy-box-close' ||
                    battleSt.battleState === 'menu-open' || battleSt.battleState === 'target-select' || battleSt.battleState === 'confirm-pause' ||
                    battleSt.battleState === 'attack-back' || battleSt.battleState === 'attack-fwd' || battleSt.battleState === 'player-slash' || battleSt.battleState === 'player-hit-show' ||
                    battleSt.battleState === 'player-miss-show' ||
                    battleSt.battleState === 'player-damage-show' || battleSt.battleState === 'defend-anim' || battleSt.battleState.startsWith('item-') ||
                    battleSt.battleState === 'magic-cast' || battleSt.battleState === 'magic-hit' ||
                    battleSt.battleState === 'enemy-flash' || battleSt.battleState === 'enemy-attack' ||
                    battleSt.battleState === 'enemy-damage-show' || battleSt.battleState === 'poison-tick' || battleSt.battleState === 'poison-end-tick' || battleSt.battleState === 'pvp-second-windup' ||
                    battleSt.battleState === 'pvp-ally-appear' || battleSt.battleState === 'message-hold' || battleSt.battleState === 'msg-wait' ||
                    battleSt.battleState.startsWith('ally-') ||
                    battleSt.battleState === 'pvp-dissolve' || battleSt.battleState === 'pvp-defend-anim' ||
                    battleSt.battleState === 'pvp-enemy-slash' || battleSt.battleState === 'pvp-opp-potion' ||
                    battleSt.battleState === 'pvp-opp-sw-throw' || battleSt.battleState === 'pvp-opp-sw-hit' ||
                    battleSt.battleState === 'pvp-enemy-magic-cast' || battleSt.battleState === 'pvp-enemy-magic-hit' ||
                    isVictoryBattleState() || battleSt.battleState === 'victory-name-out';
    if (isCombatPVP) drawBossSpriteBoxPVP(centerX, centerY);
    return;
  }

  if (!getBossBattleCanvas()) return;

  const isExpand = battleSt.battleState === 'enemy-box-expand';
  const isClose = battleSt.battleState === 'enemy-box-close';
  const isAppear = battleSt.battleState === 'boss-appear';
  const isDissolve = battleSt.battleState === 'boss-dissolve';
  const isCombat = battleSt.battleState === 'battle-fade-in' ||
                   battleSt.battleState === 'menu-open' || battleSt.battleState === 'target-select' || battleSt.battleState === 'confirm-pause' ||
                   battleSt.battleState === 'attack-back' || battleSt.battleState === 'attack-fwd' || battleSt.battleState === 'player-slash' || battleSt.battleState === 'player-hit-show' ||
                   battleSt.battleState === 'player-miss-show' ||
                   battleSt.battleState === 'player-damage-show' || battleSt.battleState === 'defend-anim' || battleSt.battleState.startsWith('item-') || battleSt.battleState === 'magic-cast' || battleSt.battleState === 'magic-hit' || battleSt.battleState === 'run-success' || battleSt.battleState === 'run-fail' || battleSt.battleState === 'enemy-flash' ||
                   battleSt.battleState === 'enemy-attack' ||
                   battleSt.battleState === 'enemy-damage-show' || battleSt.battleState === 'poison-tick' || battleSt.battleState === 'poison-end-tick' || battleSt.battleState === 'message-hold' || battleSt.battleState === 'msg-wait' ||
                   battleSt.battleState.startsWith('ally-');
  const isVictory = isVictoryBattleState() || battleSt.battleState === 'victory-name-out';
  if (!isExpand && !isClose && !isAppear && !isDissolve && !isCombat && !isVictory) return;

  _drawBossSpriteBoxBoss(centerX, centerY);
}

// ── Boss dissolve animation ───────────────────────────────────────────────

function _drawDissolvedSprite(sprX, sprY, reverse) {
  // Interlaced pixel-shift dissolve per 16×16 block
  const frame = Math.floor(battleSt.battleTimer / BOSS_DISSOLVE_FRAME_MS);
  const src = getBossBattleCanvas();
  const sctx = src.getContext('2d');

  for (let bi = 0; bi < BOSS_BLOCKS; bi++) {
    const bx = (bi % BOSS_BLOCK_COLS) * BOSS_BLOCK_SIZE;
    const by = Math.floor(bi / BOSS_BLOCK_COLS) * BOSS_BLOCK_SIZE;
    const blockFrame = frame - bi * BOSS_DISSOLVE_STEPS;

    if (!reverse) {
      // Appear: blocks before current are fully visible, after are invisible
      if (blockFrame >= BOSS_DISSOLVE_STEPS) {
        // Fully revealed
        ui.ctx.drawImage(src, bx, by, BOSS_BLOCK_SIZE, BOSS_BLOCK_SIZE,
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
        ui.ctx.drawImage(src, bx, by, BOSS_BLOCK_SIZE, BOSS_BLOCK_SIZE,
                      sprX + bx, sprY + by, BOSS_BLOCK_SIZE, BOSS_BLOCK_SIZE);
      }
    }
  }
}

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
  ui.ctx.drawImage(_shiftBlockCanvas, sprX + bx, sprY + by);
}

// `encounterGridLayout` + `pvpEnemyCellCenter` live in `./battle-grid.js`
// — callers in battle-drawing.js (FX, ally rows, spell projectile/effect)
// import them directly from there. Keeping the import surface flat avoids
// circular imports between the draw-* files.
