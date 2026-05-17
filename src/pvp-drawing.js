// PVP enemy drawing — extracted from pvp.js v1.7.190.
//
// Owns the central PVP-enemy box rendering: opponent + enemy ally cells
// (full-body sprites, weapon overlays, hit / dying / cast / defend / item-use
// poses, status icons, near-fatal sweat, sparkles, slash overlays). Pure
// rendering — no state mutation. Outside callers: `drawBossSpriteBoxPVP`
// invoked from `battle-draw-encounter.js:drawBossSpriteBox`.
//
// Mirrors the structure of `battle-draw-encounter.js` (encounter monsters)
// + `battle-draw-allies.js` (ally row portraits) — same `combatant-pose`
// helpers, same `combatant-cast` cast-windup hookup, same shared status-
// sprite + slash overlays. Only the box layout (`pvpGridLayout`) differs.

import { battleSt, getEnemyHP, MONSTER_DEATH_MS } from './battle-state.js';
import { pvpSt } from './pvp.js';
import { ui } from './ui-state.js';
import { inputSt } from './input-handler.js';
import { pvpGridLayout, PVP_CELL_W, PVP_CELL_H } from './pvp-math.js';
import { bsc, getSlashFramesForWeapon } from './battle-sprite-cache.js';
import { drawSlashOverlay, SLASH_FRAMES } from './slash-effects.js';
import { isWeapon, weaponSubtype } from './data/items.js';
import { isLeftHandHit } from './battle-math.js';
import { pickAttackPoseKey, pickAttackWeaponSpec, attackWeaponLayer, pickCombatantBody, IDLE_FRAME_MS } from './combatant-pose.js';
import { drawCastWindup } from './combatant-cast.js';
import { CAST_PHASE_MS_HEAL } from './cast-anim.js';
import { getSpellAnim, getSpellAnimForItem } from './spell-anim.js';
import { getSpellTargets } from './spell-cast.js';
import { fakePlayerFullBodyCanvases, fakePlayerHitFullBodyCanvases,
         fakePlayerKneelFullBodyCanvases, fakePlayerVictoryFullBodyCanvases,
         fakePlayerDeathFrames } from './fake-player-sprites.js';
import { clipToViewport, drawBorderedBox } from './hud-drawing.js';
// Shared helpers from battle-drawing.js (`_jobPalette`, `drawStatusSpriteAbove`)
// — same circular shape that worked for the menu/encounter/ally/player splits.
import { _jobPalette, drawStatusSpriteAbove } from './battle-drawing.js';

// ── Layout constants (match pvp.js) ───────────────────────────────────────
const BOSS_BOX_EXPAND_MS      = 300;
const PVP_BOX_RESIZE_MS       = 300;
const DEFEND_SPARKLE_FRAME_MS = 133;

function _cursorTileCanvas() { return ui.cursorTileCanvas; }

// Mirrors game.js _drawSparkleCorners but uses ui.ctx. Wraps a 16×24 body at (sprX, sprY).
function _drawSparkleAtCorners(sprX, sprY, frame) {
  const ctx = ui.ctx;
  ctx.drawImage(frame, sprX - 8, sprY - 7);
  ctx.save(); ctx.scale(-1, 1); ctx.drawImage(frame, -(sprX + 23), sprY - 7); ctx.restore();
  ctx.save(); ctx.scale(1, -1); ctx.drawImage(frame, sprX - 8, -(sprY + 32)); ctx.restore();
  ctx.save(); ctx.scale(-1, -1); ctx.drawImage(frame, -(sprX + 23), -(sprY + 32)); ctx.restore();
}

export function drawBossSpriteBoxPVP(centerX, centerY) {
  const bs = battleSt.battleState;
  const isExpand = bs === 'enemy-box-expand';
  const isClose  = bs === 'enemy-box-close';
  const totalEnemies = 1 + pvpSt.pvpEnemyAllies.length;
  const { cols, rows, gridPos } = pvpGridLayout(totalEnemies);
  const pvpBoxW = cols * PVP_CELL_W + 16;
  const pvpBoxH = rows * PVP_CELL_H + 16;

  clipToViewport();
  ui.ctx.imageSmoothingEnabled = false;

  let drawW = pvpBoxW, drawH = pvpBoxH, resizeT = 1;
  if (isExpand) {
    const t = Math.min(battleSt.battleTimer / BOSS_BOX_EXPAND_MS, 1);
    drawW = Math.max(16, Math.ceil(pvpBoxW * t / 8) * 8);
    drawH = Math.max(16, Math.ceil(pvpBoxH * t / 8) * 8);
  } else if (isClose) {
    const t = 1 - Math.min(battleSt.battleTimer / BOSS_BOX_EXPAND_MS, 1);
    drawW = Math.max(16, Math.ceil(pvpBoxW * t / 8) * 8);
    drawH = Math.max(16, Math.ceil(pvpBoxH * t / 8) * 8);
  } else if (bs === 'pvp-ally-appear') {
    resizeT = Math.min(battleSt.battleTimer / PVP_BOX_RESIZE_MS, 1);
    drawW = Math.round(pvpSt.pvpBoxResizeFromW + (pvpBoxW - pvpSt.pvpBoxResizeFromW) * resizeT);
    drawH = Math.round(pvpSt.pvpBoxResizeFromH + (pvpBoxH - pvpSt.pvpBoxResizeFromH) * resizeT);
  }
  drawBorderedBox(centerX - Math.floor(drawW / 2), centerY - Math.floor(drawH / 2), drawW, drawH, false, true);

  const visibleAllies = resizeT >= 1 ? pvpSt.pvpEnemyAllies.length : pvpSt.pvpEnemyAllies.length - 1;
  if (!isExpand && !isClose) {
    const intLeft = centerX - cols * Math.floor(PVP_CELL_W / 2);
    const intTop  = centerY - rows * Math.floor(PVP_CELL_H / 2);
    const allEnemies = [pvpSt.pvpOpponentStats, ...pvpSt.pvpEnemyAllies.slice(0, visibleAllies)];
    allEnemies.forEach((enemy, idx) => {
      if (enemy) _drawPVPEnemyCell(enemy, idx, gridPos, intLeft, intTop, PVP_CELL_W, PVP_CELL_H, resizeT);
    });
    // Target cursor during target-select or item-target-select
    if ((bs === 'target-select' || (bs === 'item-target-select' && inputSt.itemTargetType === 'enemy')) && _cursorTileCanvas()) {
      // Fight cursor uses pvpPlayerTargetIdx; item cursor uses itemTargetIndex (grid index directly)
      if (bs === 'item-target-select' && inputSt.itemTargetMode !== 'single') {
        // Multi-target: draw blinking cursors on all targeted enemies
        if (Math.floor(Date.now() / 133) & 1) {
          const allEnemies = [pvpSt.pvpOpponentStats, ...pvpSt.pvpEnemyAllies];
          for (let ei = 0; ei < allEnemies.length; ei++) {
            if (!allEnemies[ei] || allEnemies[ei].hp <= 0) continue;
            if (inputSt.itemTargetMode !== 'all') {
              // col mode: check if this enemy is in the target column
              const [er, ec] = gridPos[ei] || [0, 0];
              const isLeft = ec === 0;
              if (inputSt.itemTargetMode === 'col-left' && !isLeft) continue;
              if (inputSt.itemTargetMode === 'col-right' && isLeft) continue;
            }
            const [gr, gc] = gridPos[ei] || [0, 0];
            const tx = intLeft + gc * PVP_CELL_W + 4;
            const ty = intTop  + gr * PVP_CELL_H + 4;
            ui.ctx.drawImage(_cursorTileCanvas(), tx - 14, ty + 4);
          }
        }
      } else {
        const tIdx = bs === 'item-target-select'
          ? inputSt.itemTargetIndex
          : (pvpSt.pvpPlayerTargetIdx < 0 ? 0 : pvpSt.pvpPlayerTargetIdx + 1);
        const [gr, gc] = gridPos[tIdx] || gridPos[0];
        const tx = intLeft + gc * PVP_CELL_W + 4;
        const ty = intTop  + gr * PVP_CELL_H + 4;
        ui.ctx.drawImage(_cursorTileCanvas(), tx - 14, ty + 4);
      }
    }
  }
  ui.ctx.restore();
}

function _drawPVPEnemyCell(enemy, idx, gridPos, intLeft, intTop, cellW, cellH, resizeT) {
  const bs = battleSt.battleState;
  const [gr, gc] = gridPos[idx] || [0, 0];
  const targetX = intLeft + gc * cellW + 4;
  const targetY = intTop  + gr * cellH + 4;
  let sprX = targetX, sprY = targetY;
  if (bs === 'pvp-ally-appear' && pvpSt.pvpEnemySlidePosFrom[idx]) {
    const from = pvpSt.pvpEnemySlidePosFrom[idx];
    sprX = Math.round(from.x + (targetX - from.x) * resizeT);
    sprY = Math.round(from.y + (targetY - from.y) * resizeT);
  }
  const isMain = idx === 0;
  const palIdx = enemy.palIdx;
  const _ej = enemy.jobIdx || 0;
  const _fpb = (map) => (map[_ej] || map[0])[palIdx];
  const fullBody = _fpb(fakePlayerFullBodyCanvases) || (fakePlayerFullBodyCanvases[0] || [])[0];
  if (!fullBody) return;
  // Hide dead enemies — but keep visible during dissolve, attack, and magic-hit sequences.
  const isDying = pvpSt.pvpDyingMap.has(idx) && bs === 'pvp-dissolve';
  const isCurrentTarget = isMain ? pvpSt.pvpPlayerTargetIdx < 0 : (idx - 1) === pvpSt.pvpPlayerTargetIdx;
  const isBeingKilled = isCurrentTarget && (bs === 'player-slash' || bs === 'player-hit-show' ||
    bs === 'player-damage-show' || bs === 'ally-slash' || bs === 'ally-damage-show');
  // Magic-hit kills: keep this PVP cell rendered through the impact burst window
  // even after HP hits 0, so the target doesn't vanish mid-animation. Player
  // cast → check `getSpellTargets` (idx convention 0 = opponent, 1+ = enemy
  // ally idx-1). Ally cast → check `battleSt.allyMagicTargetType === 'pvp-enemy'`
  // with the same idx convention.
  const isMagicHitKill = bs === 'magic-hit' && getSpellTargets().some(t => t.type === 'enemy' && t.index === idx);
  const isAllyMagicHitKill = bs === 'ally-magic-hit' &&
    battleSt.allyMagicTargetType === 'pvp-enemy' &&
    battleSt.allyMagicTargetIdx === idx;
  const keepVisible = isDying || isBeingKilled || isMagicHitKill || isAllyMagicHitKill;
  if (isMain && (battleSt.enemyDefeated || (pvpSt.pvpOpponentStats && pvpSt.pvpOpponentStats.hp <= 0)) && !keepVisible) return;
  if (!isMain && (battleSt.enemyDefeated || enemy.hp <= 0) && !keepVisible) return;
  // Shake left when taking damage (mirrors player's right-shake on hit)
  if (isCurrentTarget && pvpSt.pvpOpponentShakeTimer > 0) {
    sprX += (Math.floor(pvpSt.pvpOpponentShakeTimer / 67) & 1) ? -2 : 2;
  }
  const isThisAttacking = isMain
    ? pvpSt.pvpCurrentEnemyAllyIdx < 0
    : pvpSt.pvpCurrentEnemyAllyIdx === idx - 1;
  // Hit pose: only during the slash impact and brief flinch — NOT the full 700ms damage display
  const playerHitLanded = bs === 'player-slash' &&
    inputSt.hitResults && inputSt.hitResults[battleSt.currentHitIdx] && !inputSt.hitResults[battleSt.currentHitIdx].miss;
  const allyHitLanded = bs === 'ally-slash' && battleSt.allyHitResult && !battleSt.allyHitResult.miss;
  const playerHitShowLanded = bs === 'player-hit-show' && inputSt.hitResults && inputSt.hitResults[battleSt.currentHitIdx] && !inputSt.hitResults[battleSt.currentHitIdx].miss;
  const isOppHit = isCurrentTarget && (playerHitLanded || playerHitShowLanded || allyHitLanded ||
    (bs === 'ally-damage-show' && battleSt.allyHitResult && !battleSt.allyHitResult.miss));
  const blinkHidden = isCurrentTarget && (playerHitLanded || allyHitLanded) && (Math.floor(battleSt.battleTimer / 60) & 1);
  const isWindUp = isThisAttacking && ((bs === 'enemy-flash' && (pvpSt.pvpPreflashDecided || !isMain)) || bs === 'pvp-second-windup');
  if (blinkHidden) return;

  // Which hand is this enemy using right now?
  // Even hit index = right hand, odd = left hand (if dual-wielding)
  const isAttackState = isThisAttacking && (bs === 'enemy-attack' || bs === 'pvp-enemy-slash' || bs === 'ally-hit');
  // Hand selection — RRLL via `isLeftHandHit` (single source). Drives
  // off isThisAttacking (not isMain) so PVP enemy allies use the same
  // split as the lead enemy.
  const eRw = enemy && isWeapon(enemy.weaponId);
  const eLw = enemy && isWeapon(enemy.weaponL);
  const _enemyTotalHits = pvpSt.pvpEnemyHitResults ? pvpSt.pvpEnemyHitResults.length : 0;
  const _altIsL = isLeftHandHit(pvpSt.pvpEnemyHitIdx, _enemyTotalHits, eRw, eLw);
  const isLeftHandWind = isThisAttacking && bs === 'pvp-second-windup' && _altIsL;
  const isLeftHandAtk  = isThisAttacking && isAttackState && _altIsL;
  const activeWeaponId = (isLeftHandWind || isLeftHandAtk)
    ? (enemy.weaponL != null ? enemy.weaponL : enemy.weaponId)
    : enemy.weaponId;
  const wpn = weaponSubtype(activeWeaponId);

  // Body canvas — drawn directly (pre-h-flipped canvases face right, matching the player).
  // Mirroring rule lives in pickAttackPoseKey via mirror:true — it inverts L↔R so the swinging
  // hand renders with the opposite hand's pose tiles (visually correct after the pre-flip).
  const oppHP   = isMain ? (pvpSt.pvpOpponentStats ? pvpSt.pvpOpponentStats.hp : getEnemyHP()) : (enemy.hp != null ? enemy.hp : 0);
  const oppMaxHP = isMain ? (pvpSt.pvpOpponentStats ? pvpSt.pvpOpponentStats.maxHP : 1) : (enemy.maxHP || 1);
  const isNearFatalOpp = oppHP > 0 && oppHP <= Math.floor(oppMaxHP / 4);
  // PvP opponent never enters a victory phase — the battle ends when one
  // side dies, so the opposing team never gets a celebratory pose visible
  // to the survivor. Predicate stayed false in v1.7.387+ but the dead
  // branches were kept for parity with the ally pose machine. Removed in
  // v1.7.427.
  const isOppDefending = isMain && pvpSt.pvpOpponentIsDefending && bs === 'pvp-defend-anim';
  // Caster victory pose: any cell that's the active item caster during pvp-opp-potion,
  // any cell that's the active magic caster during pvp-enemy-magic-cast/hit, OR main
  // opp during the legacy SW-throw / SW-hit paths. Mirrors the ally-magic caster pose.
  const isPotionCaster = bs === 'pvp-opp-potion' && pvpSt.pvpItemCasterCellIdx === idx;
  const isMagicCaster  = (bs === 'pvp-enemy-magic-cast' || bs === 'pvp-enemy-magic-hit') &&
                          pvpSt.pvpMagicCasterCellIdx === idx;
  const isLegacySWUse  = isMain && (bs === 'pvp-opp-sw-throw' || bs === 'pvp-opp-sw-hit');
  const isOppItemUse   = isPotionCaster || isMagicCaster || isLegacySWUse;
  // Hand-change inter-hit gap (during wind-up of a subsequent hit when hand swaps): render idle body
  // for the first IDLE_FRAME_MS only, then transition to back-swing pose for the remaining wind-up.
  const oppHandChangeGap = isWindUp && isThisAttacking && pvpSt.pvpEnemyDualWield
    && pvpSt.pvpEnemyHitIdx > 0 && battleSt.battleTimer < IDLE_FRAME_MS;
  let body = fullBody;
  if (isOppHit && _fpb(fakePlayerHitFullBodyCanvases)) {
    body = _fpb(fakePlayerHitFullBodyCanvases);
  } else if (oppHandChangeGap) {
    body = fullBody; // idle pose during the gap
  } else if (isWindUp || isAttackState) {
    // Centralized pose-pick. Mirror rule (opponent face-right pre-flipped canvas) lives in pickAttackPoseKey;
    // unarmed-no-windup rule lives there too — both render the strike pose for back & fwd phases.
    const handIsL = isWindUp ? isLeftHandWind : isLeftHandAtk;
    const key = pickAttackPoseKey({
      weaponSubtype: wpn,
      isUnarmed: !!pvpSt.pvpEnemyUnarmed,
      hand: handIsL ? 'L' : 'R',
      attackPhase: isWindUp ? 'back' : 'fwd',
      mirror: true,
    });
    body = pickCombatantBody('opp', key, _ej, palIdx) || fullBody;
  } else if (isOppDefending || isOppItemUse) {
    body = _fpb(fakePlayerVictoryFullBodyCanvases) || fullBody;
  } else if (isNearFatalOpp) {
    body = _fpb(fakePlayerKneelFullBodyCanvases) || fullBody;
  }

  // Opponent face-right pre-flipped canvas — pickAttackWeaponSpec returns offsets in post-flip space.
  // Suppressed entirely during the hand-change idle gap.
  const _phase = oppHandChangeGap ? null : (isWindUp ? 'back' : (isAttackState ? 'fwd' : null));
  const _handIsL = isWindUp ? isLeftHandWind : isLeftHandAtk;
  const weaponSpec = _phase ? pickAttackWeaponSpec({
    weaponId: activeWeaponId,
    weaponSubtype: wpn,
    isUnarmed: !!pvpSt.pvpEnemyUnarmed,
    hand: _handIsL ? 'L' : 'R',
    attackPhase: _phase,
    mirror: true,
    fistPalette: _jobPalette(_ej, palIdx),
    fistTimerMs: battleSt.battleTimer,
  }) : null;
  const _weaponLayer = _phase ? attackWeaponLayer({ attackPhase: _phase, hand: _handIsL ? 'L' : 'R', mirror: true }) : null;
  const drawBlade = () => {
    if (!weaponSpec) return;
    const ctx = ui.ctx;
    ctx.save();
    ctx.translate(sprX + 16, sprY);
    ctx.scale(-1, 1);
    ctx.drawImage(weaponSpec.canvas, weaponSpec.dx, weaponSpec.dy);
    ctx.restore();
  };

  // Layer: 'behind' draws before body, 'front' draws after.
  if (weaponSpec && _weaponLayer === 'behind') drawBlade();
  // Cast windup BEHIND — same `drawCastWindup` helper player + ally use.
  // mirror=true since PVP opponents face right.
  drawCastWindup('behind', ui.ctx, 'pvp-enemy', idx, sprX + 8, sprY + 12, true);
  if (isDying) {
    const delay = pvpSt.pvpDyingMap.get(idx) || 0;
    const deathFrames = _fpb(fakePlayerDeathFrames);
    if (deathFrames && deathFrames.length) {
      const progress = Math.min(Math.max(0, battleSt.battleTimer - delay) / MONSTER_DEATH_MS, 1);
      const fi = Math.min(deathFrames.length - 1, Math.floor(progress * deathFrames.length));
      ui.ctx.drawImage(deathFrames[fi], sprX, sprY);
    }
  } else {
    ui.ctx.drawImage(body, sprX, sprY);
  }
  if (weaponSpec && _weaponLayer === 'front') drawBlade();

  // Near-fatal sweat — h-flipped to match opponent facing left
  if (isNearFatalOpp && !isDying && bsc.sweatFrames && bsc.sweatFrames.length === 2) {
    const sf = bsc.sweatFrames[Math.floor(Date.now() / 133) & 1];
    const ctx = ui.ctx;
    ctx.save();
    ctx.translate(sprX + sf.width, sprY - 3);
    ctx.scale(-1, 1);
    ctx.drawImage(sf, 0, 0);
    ctx.restore();
  }

  // Status sprite — h-flipped to match the body's right-facing orientation.
  // Same single-source helper as player + ally; only the mirror flag differs.
  if (!isDying) drawStatusSpriteAbove(ui.ctx, enemy && enemy.status, sprX, sprY - 4, true);

  // Defend sparkle — 4 frames cycling over 533ms, full-body corners
  if (isOppDefending && bsc.defendSparkleFrames && bsc.defendSparkleFrames.length === 4) {
    const fi = Math.min(3, Math.floor(battleSt.battleTimer / DEFEND_SPARKLE_FRAME_MS));
    _drawSparkleAtCorners(sprX, sprY, bsc.defendSparkleFrames[fi]);
  }
  // Cure sparkle — drawn on the TARGET cell during item use AND during the hit
  // phase of an enemy magic cast. Item routes via the item's `animSpellId`
  // (declarative on the item record); magic routes by `pvpMagicSpellId` via
  // the per-spell bundle.
  //
  // Magic-target window is time-gated: sparkle plays during the heal-anim
  // window (preImpactGap..preImpactGap+impact), NOT for the entire pvp-enemy
  // -magic-hit phase. This keeps it sequential with the heal number bounce
  // that follows the postImpactGap. Item-use keeps the full-phase render
  // (item flow doesn't have the same staged timing).
  const _pvpHealAnimStart = CAST_PHASE_MS_HEAL.preImpactGap;
  const _pvpHealAnimEnd   = _pvpHealAnimStart + CAST_PHASE_MS_HEAL.impact;
  const isPotionTarget = bs === 'pvp-opp-potion' && pvpSt.pvpItemTargetCellIdx === idx;
  const isMagicTarget  = bs === 'pvp-enemy-magic-hit'
    && pvpSt.pvpMagicTargetCellIdx === idx
    && battleSt.battleTimer >= _pvpHealAnimStart
    && battleSt.battleTimer < _pvpHealAnimEnd;
  if (isPotionTarget || isMagicTarget) {
    let _frames = null;
    if (isPotionTarget) {
      const _b = getSpellAnimForItem(pvpSt.pvpItemId);
      _frames = (_b && _b.kind === 'portrait-2frame') ? _b.frames : null;
    } else {
      const _b = getSpellAnim(pvpSt.pvpMagicSpellId);
      _frames = (_b && _b.kind === 'portrait-2frame') ? _b.frames : null;
    }
    if (!(_frames && _frames.length === 2)) _frames = bsc.cureSparkleFrames;
    if (_frames && _frames.length === 2) {
      const fi = Math.floor(battleSt.battleTimer / 67) & 1;
      // 16×16 sparkle vertically centered on the 16×24 PVP body — matches
      // the offensive-magic `_getMagicTargetCenter` convention (cellTop + 16
      // = body center). Player/ally render the same call at portrait-top-
      // left because their portrait IS 16×16; PVP's full body needs +4 to
      // land mid-torso instead of head/shoulders.
      ui.ctx.drawImage(_frames[fi], sprX, sprY + 4);
    }
  }

  // Slash effect overlays on the current target
  if (isCurrentTarget) {
    if (bs === 'player-slash' && bsc.slashFrames && battleSt.slashFrame < SLASH_FRAMES && playerHitLanded) {
      ui.ctx.drawImage(bsc.slashFrames[battleSt.slashFrame], sprX + battleSt.slashOffX, sprY + battleSt.slashOffY);
    }
    if (bs === 'ally-slash' && allyHitLanded) {
      const ally = battleSt.battleAllies[battleSt.currentAllyAttacker];
      const isLeft = battleSt.allyHitIsLeft;
      const activeWpnId = ally ? (isLeft ? ally.weaponL : ally.weaponId) : 0;
      const aSlashF = ally ? getSlashFramesForWeapon(activeWpnId, !isLeft) : bsc.slashFramesR;
      const af = Math.min(Math.floor(battleSt.battleTimer / 30), 2);
      drawSlashOverlay(ui.ctx, aSlashF && aSlashF[af], af, sprX, sprY, { weaponId: activeWpnId || 0, hit: battleSt.allyHitResult });
    }
  }

  // Cast windup FRONT — same shared helper.
  drawCastWindup('front', ui.ctx, 'pvp-enemy', idx, sprX + 8, sprY + 12, true);
}
