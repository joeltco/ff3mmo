// Battle drawing functions — extracted from game.js (pure rendering, no state mutation except critFlashTimer)

import { battleSt, getEnemyHP, setEnemyHP } from './battle-state.js';
import { drawText, measureText, TEXT_WHITE } from './font-renderer.js';
import { nesColorFade, _makeFadedPal } from './palette.js';
import { _calcBoxExpandSize, _encounterGridPos } from './battle-layout.js';
import { _dmgBounceY } from './data/animation-tables.js';
import { DMG_NUM_PAL, HEAL_NUM_PAL, drawBattleNum as _drawBattleNumCtx, getMissCanvas } from './damage-numbers.js';
import { getBossBattleCanvas, getBossWhiteCanvas } from './boss-sprites.js';
import { getMonsterCanvas, getMonsterWhiteCanvas, hasMonsterSprites } from './monster-sprites.js';
import { getItemNameClean, getMonsterName } from './text-decoder.js';
import { weaponSubtype, isWeapon } from './data/items.js';
import { PLAYER_PALETTES, MONK_PALETTES } from './data/players.js';
import { pickAttackPoseKey, pickAttackWeaponSpec, attackWeaponLayer } from './combatant-pose.js';

// Player canvas pool fallback chain (player pool collapses knife back/fwd into one canvas).
const PLAYER_POSE_FALLBACK = { rFwd: 'rBack', lFwd: 'lBack', knifeRFwd: 'knifeR', knifeLFwd: 'knifeL' };
function _playerPoseCanvas(p, key) {
  return p[key] || (PLAYER_POSE_FALLBACK[key] && p[PLAYER_POSE_FALLBACK[key]]) || null;
}

function _jobPalette(jobIdx, palIdx) {
  const pool = jobIdx === 2 ? MONK_PALETTES : PLAYER_PALETTES;
  return pool[palIdx] || pool[0];
}

import { ps, getHitWeapon, isHitRightHand } from './player-stats.js';
import { _nameToBytes, _buildItemRowBytes, drawLvHpRow, makeExpText, makeGilText, makeCpText, makeItemDropText } from './text-utils.js';
import { pvpEnemyCellCenter } from './pvp-math.js';
import { pvpSt, drawBossSpriteBoxPVP } from './pvp.js';
import { inputSt } from './input-handler.js';
import { bsc, getSlashFramesForWeapon } from './battle-sprite-cache.js';
import { hudSt } from './hud-state.js';
import { fakePlayerPortraits, fakePlayerVictoryPortraits, fakePlayerHitPortraits,
         fakePlayerKneelPortraits, fakePlayerAttackPortraits, fakePlayerAttackLPortraits,
         fakePlayerKnifeRPortraits, fakePlayerKnifeLPortraits,
         fakePlayerKnifeRFwdPortraits, fakePlayerKnifeLFwdPortraits,
         fakePlayerDeathPoseCanvases } from './fake-player-sprites.js';
import { BATTLE_GAME_OVER, BATTLE_DEFEATED, BATTLE_LEVEL_UP, BATTLE_JOB_LEVEL_UP, BATTLE_FOUND,
         BATTLE_BOSS_NAME, BATTLE_GOBLIN_NAME, BATTLE_MENU_ITEMS } from './data/strings.js';
import { getAllyDamageNums, getEnemyDmgNum, getPlayerDamageNum, getPlayerHealNum, getEnemyHealNum,
         getSwDmgNums } from './damage-numbers.js';
import { getBattleMsgCurrent, getBattleMsgTimer, MSG_FADE_IN_MS, MSG_HOLD_MS, MSG_FADE_OUT_MS } from './battle-msg.js';
import { getHitIdx, getTargets } from './battle-items.js';
// (weapon canvas selection moved to combatant-pose.js — pickAttackWeaponSpec handles all blade/fist getters)
import { clipToViewport, drawCursorFaded, drawHudBox, drawSparkleCorners, drawBorderedBox,
         grayViewport } from './hud-drawing.js';
import { drawMonsterDeath as _drawMonsterDeath } from './render.js';
import { ui } from './ui-state.js';
import { isVictoryBattleState as _isVictoryBattleState } from './battle-update.js';

function _cursorTileCanvas() { return ui.cursorTileCanvas; }

const HUD_VIEW_X = 0, HUD_VIEW_Y = 32, HUD_VIEW_W = 144, HUD_VIEW_H = 144;
const HUD_RIGHT_X = 144, HUD_RIGHT_W = 112;
const HUD_BOT_Y = 176, HUD_BOT_H = 64;
const CANVAS_W = 256;
const BATTLE_PANEL_W = 120;
const INV_SLOTS = 3;
const ROSTER_ROW_H = 32;

// Ally portrait pool adapter: maps the canonical pose key to the fake-player canvas dict.
// Ally pool collapses fwd vs back for knives (no separate KnifeRFwdPortraits) and uses
// AttackPortraits/AttackLPortraits for non-knife back-swing.
const ALLY_POSE_MAP = {
  rBack:     fakePlayerAttackPortraits,
  lBack:     fakePlayerAttackLPortraits,
  rFwd:      fakePlayerKnifeRFwdPortraits,
  lFwd:      fakePlayerKnifeLFwdPortraits,
  knifeR:    fakePlayerKnifeRPortraits,
  knifeL:    fakePlayerKnifeLPortraits,
  knifeRFwd: fakePlayerKnifeRFwdPortraits,
  knifeLFwd: fakePlayerKnifeLFwdPortraits,
};
const BATTLE_TEXT_STEP_MS = 50;
const BATTLE_TEXT_STEPS = 4;
const BATTLE_FLASH_FRAME_MS = 16.67;
const BOSS_BOX_EXPAND_MS = 300;
const BOSS_PREFLASH_MS = 133;
const BOSS_BLOCK_SIZE = 16;
const BOSS_BLOCK_COLS = 3;
const BOSS_BLOCKS = 9;
const BOSS_DISSOLVE_STEPS = 8;
const BOSS_DISSOLVE_FRAME_MS = 16.67;
const BATTLE_SHAKE_MS = 300;
const MONSTER_DEATH_MS = 250;
const MONSTER_SLIDE_MS = 267;
const SLASH_FRAME_MS = 50;
const SLASH_FRAMES = 3;
const TEXT_WHITE_ON_BLUE = [0x02, 0x02, 0x02, 0x30];
const DEFEND_SPARKLE_FRAME_MS = 133;
const VICTORY_BOX_W = BATTLE_PANEL_W;
const VICTORY_BOX_H = HUD_BOT_H;
const VICTORY_BOX_ROWS = HUD_BOT_H / 8;
const VICTORY_ROW_FRAME_MS = 16.67;

// _s bag retired
let _shiftBlockCanvas = null;

function _pvpEnemyCellCenter(idx) {
  return pvpEnemyCellCenter(idx, 1 + pvpSt.pvpEnemyAllies.length);
}

function _encounterGridLayout() {
  const count = battleSt.encounterMonsters.length;
  const { fullW, fullH, sprH, row0H, row1H } = _encounterBoxDims();
  const boxX = HUD_VIEW_X + Math.floor((HUD_VIEW_W - fullW) / 2);
  const boxY = HUD_VIEW_Y + Math.floor((HUD_VIEW_H - fullH) / 2);
  const gridPos = _encounterGridPos(boxX, boxY, fullW, fullH, count, sprH, row0H, row1H);
  return { count, boxX, boxY, sprH, row0H, row1H, fullW, fullH, gridPos };
}

function drawSWExplosion() {
  // PVP opponent South Wind — explosion centered on current target (player or ally)
  if (pvpSt.isPVPBattle && battleSt.battleState === 'pvp-opp-sw-hit' && battleSt.battleTimer < 400) {
    if (!bsc.swPhaseCanvases.length) return;
    const phase = Math.min(2, Math.floor(battleSt.battleTimer / 133));
    const canvas = bsc.swPhaseCanvases[phase];
    if (!canvas) return;
    const targets = pvpSt._oppSWTargets;
    const tidx = targets ? targets[pvpSt._oppSWHitIdx] : -1;
    let cx, cy;
    if (tidx === -1) {
      cx = HUD_RIGHT_X + 8 + 8;
      cy = HUD_VIEW_Y + 8 + 12;
    } else {
      const panelTop = HUD_VIEW_Y + 32;
      cx = HUD_RIGHT_X + 8 + 8;
      cy = panelTop + tidx * ROSTER_ROW_H + 8 + 8;
    }
    const half = canvas.width / 2;
    ui.ctx.save();
    ui.ctx.beginPath(); ui.ctx.rect(0, HUD_VIEW_Y, CANVAS_W, HUD_VIEW_H); ui.ctx.clip();
    ui.ctx.imageSmoothingEnabled = false;
    ui.ctx.drawImage(canvas, cx - half, cy - half);
    ui.ctx.restore();
    return;
  }
  if (battleSt.battleState !== 'sw-hit' || battleSt.battleTimer >= 400) return;
  if (pvpSt.isPVPBattle) {
    if (!bsc.swPhaseCanvases.length) return;
    const phase = Math.min(2, Math.floor(battleSt.battleTimer / 133));
    const canvas = bsc.swPhaseCanvases[phase];
    if (!canvas) return;
    const tidx = getTargets()[getHitIdx()];
    if (tidx === undefined) return;
    const { x: cx, y: cy } = _pvpEnemyCellCenter(tidx);
    ui.ctx.drawImage(canvas, cx - Math.floor(canvas.width / 2), cy - Math.floor(canvas.height / 2));
    return;
  }
  if (!bsc.swPhaseCanvases.length) return;
  const phase = Math.min(2, Math.floor(battleSt.battleTimer / 133));
  const phaseCanvas = bsc.swPhaseCanvases[phase];
  if (!phaseCanvas) return;

  if (battleSt.isRandomEncounter && battleSt.encounterMonsters) {
    const { count, boxX, boxY, sprH, row0H, row1H, gridPos: swGridPos } = _encounterGridLayout();
    const tidx = getTargets()[getHitIdx()];
    if (tidx === undefined || tidx >= swGridPos.length) return;
    const tp = swGridPos[tidx];
    const m = battleSt.encounterMonsters[tidx];
    const mc = getMonsterCanvas(m?.monsterId, battleSt.goblinBattleCanvas);
    const rH = tidx < 2 ? (row0H || sprH) : (row1H || sprH);
    const mh = mc ? mc.height : rH;
    const cx = tp.x + 16;
    const cy = tp.y + (rH - mh) + Math.floor(mh / 2);
    ui.ctx.drawImage(phaseCanvas, cx - Math.floor(phaseCanvas.width / 2), cy - Math.floor(phaseCanvas.height / 2));
  } else {
    // Boss — center on boss sprite
    const cx = HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2);
    const cy = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2);
    ui.ctx.drawImage(phaseCanvas, cx - Math.floor(phaseCanvas.width / 2), cy - Math.floor(phaseCanvas.height / 2));
  }
}

function drawSWDamageNumbers() {
  if (battleSt.battleState !== 'sw-hit') return;
  if (pvpSt.isPVPBattle) {
    for (const [k, dn] of Object.entries(getSwDmgNums())) {
      const { x: cx, y: cy } = _pvpEnemyCellCenter(parseInt(k));
      _drawBattleNum(cx + 8, _dmgBounceY(cy + 12, dn.timer), dn.value, DMG_NUM_PAL);
    }
    return;
  }
  if (battleSt.isRandomEncounter && battleSt.encounterMonsters) {
    const { count, boxX, boxY, sprH, row0H, row1H, gridPos: swGridPos } = _encounterGridLayout();
    for (const [k, dn] of Object.entries(getSwDmgNums())) {
      const idx = parseInt(k);
      if (idx >= swGridPos.length) continue;
      const tp = swGridPos[idx];
      const m = battleSt.encounterMonsters[idx];
      const mc = getMonsterCanvas(m?.monsterId, battleSt.goblinBattleCanvas);
      const rH = idx < 2 ? (row0H || sprH) : (row1H || sprH);
      const mh = mc ? mc.height : rH;
      const mw = mc ? mc.width : 32;
      const bx = tp.x + mw - 4;
      const baseY = tp.y + rH - 8;
      const by = _dmgBounceY(baseY, dn.timer);
      _drawBattleNum(bx, by, dn.value, DMG_NUM_PAL);
    }
  } else {
    // Boss — damage number on bottom-right of boss sprite
    const bc = getBossBattleCanvas();
    const bw = bc ? bc.width : 48;
    const bh = bc ? bc.height : 48;
    for (const [k, dn] of Object.entries(getSwDmgNums())) {
      const bx = HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2) + Math.floor(bw / 2) - 4;
      const baseY = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2) + Math.floor(bh / 2) - 8;
      _drawBattleNum(bx, _dmgBounceY(baseY, dn.timer), dn.value, DMG_NUM_PAL);
    }
  }
}

function _getPortraitSrc(isNearFatal, isAttackPose, isHitPose, isDefendPose, isItemUsePose, isVictoryPose) {
  const hasActiveStatus = ps.status && ps.status.mask !== 0;
  const p = bsc.battlePoses;
  let src = ((isNearFatal || hasActiveStatus) && p.kneel) ? p.kneel : p.idle;
  if (isAttackPose) {
    const _wpn = getHitWeapon(battleSt.currentHitIdx, inputSt.rHandHitCount);
    const rh = isHitRightHand(battleSt.currentHitIdx, inputSt.rHandHitCount);
    // Inter-hit hand-change gap: hold idle pose during attack-back (after first hit, when hand swaps).
    const handChangeGap = battleSt.battleState === 'attack-back' && battleSt.currentHitIdx > 0 &&
      isHitRightHand(battleSt.currentHitIdx - 1, inputSt.rHandHitCount) !== rh;
    if (!handChangeGap) {
      const key = pickAttackPoseKey({
        weaponSubtype: weaponSubtype(_wpn),
        isUnarmed: _wpn === 0,
        hand: rh ? 'R' : 'L',
        attackPhase: battleSt.battleState === 'attack-back' ? 'back' : 'fwd',
        mirror: false,
      });
      src = _playerPoseCanvas(p, key) || src;
    }
    // else: leave src at default (idle) so the R→L (or L→R) hand swap reads cleanly
  } else if ((isDefendPose || isItemUsePose) && p.defend) {
    src = p.defend;
  } else if (isHitPose && p.hit) {
    src = p.hit;
  } else if (isVictoryPose && p.victory) {
    if (Math.floor(Date.now() / 250) & 1) src = p.victory;
  }
  return src;
}

function _drawPortraitFrame(px, py, portraitSrc, isRunPose) {
  if (isRunPose) {
    let slideX = 0;
    slideX = Math.min(battleSt.battleTimer / 300, 1) * 20;
    ui.ctx.save();
    ui.ctx.beginPath();
    ui.ctx.rect(HUD_RIGHT_X + 8, HUD_VIEW_Y + 8, 16, 16);
    ui.ctx.clip();
    ui.ctx.translate(px + 16 + slideX, py);
    ui.ctx.scale(-1, 1);
    ui.ctx.drawImage(portraitSrc, 0, 0);
    ui.ctx.restore();
  } else if (battleSt.battleState === 'encounter-box-close' && battleSt.runSlideBack) {
    const t = Math.min(battleSt.battleTimer / 300, 1);
    ui.ctx.save();
    ui.ctx.beginPath();
    ui.ctx.rect(HUD_RIGHT_X + 8, HUD_VIEW_Y + 8, 16, 16);
    ui.ctx.clip();
    ui.ctx.drawImage(portraitSrc, px, py + (1 - t) * 20);
    ui.ctx.restore();
  } else {
    ui.ctx.drawImage(portraitSrc, px, py);
  }
}

function _drawPortraitWeapon(px, py, before) {
  // before=true: behind body (drawn before body); false: in front (drawn after body)
  const handWeapon = getHitWeapon(battleSt.currentHitIdx, inputSt.rHandHitCount);
  const phase = battleSt.battleState === 'attack-back' ? 'back'
              : (battleSt.battleState === 'attack-fwd' || battleSt.battleState === 'player-slash') ? 'fwd'
              : null;
  if (!phase) return;
  const rightHand = isHitRightHand(battleSt.currentHitIdx, inputSt.rHandHitCount);
  const hand = rightHand ? 'R' : 'L';
  const spec = pickAttackWeaponSpec({
    weaponId: handWeapon,
    weaponSubtype: weaponSubtype(handWeapon),
    isUnarmed: handWeapon === 0,
    hand, attackPhase: phase, mirror: false,
    fistPalette: bsc.battlePoses && bsc.battlePoses.palette,
    fistTimerMs: battleSt.battleTimer,
  });
  if (!spec) return;
  const layer = attackWeaponLayer({ attackPhase: phase, hand, mirror: false });
  if ((before && layer === 'behind') || (!before && layer === 'front')) {
    ui.ctx.drawImage(spec.canvas, px + spec.dx, py + spec.dy);
  }
}

function _drawPortraitOverlays(px, py, isDefendPose, isItemUsePose, isNearFatal, isRunPose,
                                isAttackPose, isHitPose, isVictoryPose) {
  // Defend sparkle — 4 corners cycling during defend-anim
  if (isDefendPose && bsc.defendSparkleFrames.length === 4) {
    const fi = Math.min(3, Math.floor(battleSt.battleTimer / DEFEND_SPARKLE_FRAME_MS));
    const frame = bsc.defendSparkleFrames[fi];
    drawSparkleCorners(frame, px, py);
  }
  // Cure sparkle — alternating flips every 67ms during item-use
  if (battleSt.battleState === 'item-use' && bsc.cureSparkleFrames.length === 2 && !(inputSt.playerActionPending && inputSt.playerActionPending.allyIndex >= 0)) {
    const fi = Math.floor(battleSt.battleTimer / 67) & 1;
    const frame = bsc.cureSparkleFrames[fi];
    drawSparkleCorners(frame, px, py);
  }
  // Near-fatal sweat — 2 frames alternating every 133ms, 3px above portrait
  if (isNearFatal && bsc.sweatFrames.length === 2 && !isAttackPose && !isHitPose && !isVictoryPose && !isDefendPose && !isItemUsePose) {
    const sweatIdx = Math.floor(Date.now() / 133) & 1;
    if (isRunPose) {
      let slideX = 0;
      slideX = Math.min(battleSt.battleTimer / 300, 1) * 20;
      ui.ctx.save();
      ui.ctx.beginPath();
      ui.ctx.rect(HUD_RIGHT_X + 8, HUD_VIEW_Y + 8 - 3, 16, 19);
      ui.ctx.clip();
      ui.ctx.drawImage(bsc.sweatFrames[sweatIdx], px + slideX, py - 3);
      ui.ctx.restore();
    } else if (battleSt.battleState === 'encounter-box-close' && battleSt.runSlideBack) {
      const t = Math.min(battleSt.battleTimer / 300, 1);
      ui.ctx.save();
      ui.ctx.beginPath();
      ui.ctx.rect(HUD_RIGHT_X + 8, HUD_VIEW_Y + 8 - 3, 16, 19);
      ui.ctx.clip();
      ui.ctx.drawImage(bsc.sweatFrames[sweatIdx], px, py - 3 + (1 - t) * 20);
      ui.ctx.restore();
    } else {
      ui.ctx.drawImage(bsc.sweatFrames[sweatIdx], px, py - 3);
    }
  }
  // Status sprite above portrait — show highest priority active status
  if (ps.status && ps.status.mask !== 0 && bsc.statusSpriteMap) {
    // Priority order: petrify, sleep, confuse, paralysis, silence, blind, poison
    const prio = [0x40, 0x100, 0x200, 0x01, 0x10, 0x04, 0x02];
    for (const flag of prio) {
      if (ps.status.mask & flag) {
        const frames = bsc.statusSpriteMap.get(flag);
        if (frames && frames.length === 2) {
          const f = frames[Math.floor(Date.now() / 133) & 1];
          ui.ctx.drawImage(f, px, py - 4);
        }
        break;
      }
    }
  }
  // Item target cursor on player portrait (only when not targeting an ally)
  if (battleSt.battleState === 'item-target-select' && inputSt.itemTargetType === 'player' && inputSt.itemTargetAllyIndex < 0 && _cursorTileCanvas()) {
    ui.ctx.drawImage(_cursorTileCanvas(), px - 12, py + 4);
  }
  // Enemy slash effect on player portrait during PVP melee attack swing.
  // Skip when the opponent is targeting an ally — the slash gets drawn on that ally's portrait instead (see _drawAllyPortrait).
  if (battleSt.battleState === 'pvp-enemy-slash' && battleSt.enemyTargetAllyIdx < 0) {
    const eWpnId = pvpSt.pvpCurrentEnemyAllyIdx >= 0
      ? pvpSt.pvpEnemyAllies[pvpSt.pvpCurrentEnemyAllyIdx]?.weaponId
      : pvpSt.pvpOpponentStats?.weaponId;
    const eSlashF = getSlashFramesForWeapon(eWpnId, true);
    const af = Math.min(2, Math.floor(battleSt.battleTimer / 67));
    if (eSlashF && eSlashF[af]) {
      const sf = eSlashF[af];
      ui.ctx.save();
      ui.ctx.translate(px + sf.width + [-0, -10, 8][af], py + [0, -6, 8][af]);
      ui.ctx.scale(-1, 1);
      ui.ctx.drawImage(sf, 0, 0);
      ui.ctx.restore();
    }
  }
}

function _drawBattlePortrait() {
  const px = HUD_RIGHT_X + 8;
  const py = HUD_VIEW_Y + 8;

  // Player death animation: slide → text fade → death pose fade
  if (hudSt.playerDeathTimer != null) {
    const dt = Math.min(hudSt.playerDeathTimer, DEATH_TOTAL_MS);

    // Phase 1: kneel slides down, clipped to inner portrait area (16×16)
    if (dt < DEATH_SLIDE_MS) {
      ui.ctx.save();
      ui.ctx.beginPath();
      ui.ctx.rect(px, py, 16, 16);
      ui.ctx.clip();
      const slideT = dt / DEATH_SLIDE_MS;
      const slideY = Math.floor(slideT * 16);
      if (bsc.battlePoses.kneel) ui.ctx.drawImage(bsc.battlePoses.kneel, px, py + slideY);
      ui.ctx.restore();
    }

    // Phase 3: death pose fades in, centered in the name/HP info box
    if (dt >= DEATH_SLIDE_MS + DEATH_TXTFADE_MS) {
      const fadeT = Math.min((dt - DEATH_SLIDE_MS - DEATH_TXTFADE_MS) / DEATH_POSEFADE_MS, 1);
      const deathCanvas = (fakePlayerDeathPoseCanvases[ps.jobIdx] || fakePlayerDeathPoseCanvases[0])?.[0];
      if (deathCanvas) {
        ui.ctx.globalAlpha = fadeT;
        const dx = HUD_RIGHT_X + HUD_RIGHT_W - 24 - 8;
        const dy = HUD_VIEW_Y + Math.floor((32 - 16) / 2);
        ui.ctx.drawImage(deathCanvas, dx, dy);
        ui.ctx.globalAlpha = 1;
      }
    }
    return;
  }

  const shakeOff = ((battleSt.battleState === 'enemy-attack' || battleSt.battleState === 'poison-tick' || battleSt.battleState === 'pvp-opp-sw-hit') && battleSt.battleShakeTimer > 0)
    ? (Math.floor(battleSt.battleShakeTimer / 67) & 1 ? 2 : -2) : 0;
  const isVictoryPose = _isVictoryBattleState();
  const isAttackPose = battleSt.battleState === 'attack-back' || battleSt.battleState === 'attack-fwd' || battleSt.battleState === 'player-slash';
  const isHitPose = (battleSt.battleState === 'poison-tick' && getPlayerDamageNum() && !getPlayerDamageNum().miss) ||
    (battleSt.battleState === 'enemy-attack' && getPlayerDamageNum() && !getPlayerDamageNum().miss) ||
    (battleSt.battleState === 'enemy-damage-show' && getPlayerDamageNum() && !getPlayerDamageNum().miss) ||
    (battleSt.battleState === 'pvp-opp-sw-hit' && battleSt.battleShakeTimer > 0) ||
    (battleSt.battleState === 'pvp-enemy-slash' && pvpSt.pvpPendingAttack && !pvpSt.pvpPendingAttack.miss && !pvpSt.pvpPendingAttack.shieldBlock);
  const isDefendPose = battleSt.battleState === 'defend-anim';
  const isItemUsePose = battleSt.battleState === 'item-use' || battleSt.battleState === 'sw-throw' || battleSt.battleState === 'sw-hit';
  const isRunPose = battleSt.battleState === 'run-success';
  const isNearFatal = ps.hp > 0 && ps.stats && ps.hp <= Math.floor(ps.stats.maxHP / 4);
  const portraitSrc = _getPortraitSrc(isNearFatal, isAttackPose, isHitPose, isDefendPose, isItemUsePose, isVictoryPose);
  if (!portraitSrc) return;
  const pxs = px + shakeOff;
  // Blink portrait when enemy slash is landing (mirrors opponent blink on player hit)
  const portraitBlink = battleSt.battleState === 'pvp-enemy-slash' &&
    pvpSt.pvpPendingAttack && !pvpSt.pvpPendingAttack.miss && !pvpSt.pvpPendingAttack.shieldBlock &&
    (Math.floor(battleSt.battleTimer / 60) & 1);
  if (!portraitBlink) {
    if (isAttackPose) _drawPortraitWeapon(pxs, py, true);
    _drawPortraitFrame(pxs, py, portraitSrc, isRunPose);
    if (isAttackPose) _drawPortraitWeapon(pxs, py, false);
  }
  _drawPortraitOverlays(pxs, py, isDefendPose, isItemUsePose, isNearFatal, isRunPose, isAttackPose, isHitPose, isVictoryPose);
}

function _drawBattleCritFlash() {
  if (battleSt.critFlashTimer < 0) return;
  if (battleSt.critFlashTimer === 0) battleSt.critFlashTimer = Date.now();
  if (Date.now() - battleSt.critFlashTimer < 17) {
    clipToViewport();
    ui.ctx.fillStyle = '#DAA336';
    ui.ctx.fillRect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);
    ui.ctx.restore();
  } else { battleSt.critFlashTimer = -1; }
}
function _drawBattleStrobeFlash() {
  if (battleSt.battleState !== 'flash-strobe') return;
  if (!(Math.floor(battleSt.battleTimer / BATTLE_FLASH_FRAME_MS) & 1)) return;
  clipToViewport();
  grayViewport();
}
function _drawBattleDefeat() {
  const ecx = HUD_VIEW_X + HUD_VIEW_W / 2;
  const ecy = HUD_VIEW_Y + HUD_VIEW_H / 2;
  if (battleSt.battleState === 'defeat-monster-fade') {
    ui.ctx.save();
    ui.ctx.globalAlpha = Math.min(battleSt.battleTimer / 500, 1);
    ui.ctx.fillStyle = '#000';
    if (battleSt.isRandomEncounter && battleSt.encounterMonsters) {
      const { fullW: fw, fullH: fh } = _encounterBoxDims();
      ui.ctx.fillRect(Math.round(ecx - fw / 2) + 8, Math.round(ecy - fh / 2) + 8, fw - 16, fh - 16);
    } else {
      if (!pvpSt.isPVPBattle) ui.ctx.fillRect(ecx - 24, ecy - 24, 48, 48);
    }
    ui.ctx.restore();
  }
  if (battleSt.battleState === 'defeat-text') {
    const tw = measureText(BATTLE_GAME_OVER);
    drawText(ui.ctx, Math.floor(ecx - tw / 2), Math.floor(ecy - 4), BATTLE_GAME_OVER, TEXT_WHITE);
  }
}
function drawBattle() {
  if (battleSt.battleState === 'none') return;
  if (battleSt.battleState === 'game-over') { _drawGameOver(); return; }
  _drawBattleCritFlash();
  _drawBattlePortrait();
  _drawBattleStrobeFlash();
  drawEncounterBox();
  drawBossSpriteBox();
  drawBattleMenu();
  drawBattleMessage();
  drawVictoryBox();
  drawBattleMessageStrip();
  drawDamageNumbers();
  _drawBattleDefeat();
}

function _drawGameOver() {
  // Small bordered HUD box centered in the battle viewport with "GAME OVER" + blinking "Press Z".
  const boxW = 96, boxH = 40;
  const bx = HUD_VIEW_X + Math.floor((HUD_VIEW_W - boxW) / 2);
  const by = HUD_VIEW_Y + Math.floor((HUD_VIEW_H - boxH) / 2);
  drawBorderedBox(bx, by, boxW, boxH);
  const cx = bx + boxW / 2;
  const textY = by + 10;
  const tw = measureText(BATTLE_GAME_OVER);
  drawText(ui.ctx, Math.floor(cx - tw / 2), Math.floor(textY), BATTLE_GAME_OVER, TEXT_WHITE);
  // Blinking "Press Z" prompt every 500ms
  if ((Math.floor(Date.now() / 500) & 1) === 0) {
    const prompt = _nameToBytes('Press Z');
    const pw = measureText(prompt);
    drawText(ui.ctx, Math.floor(cx - pw / 2), Math.floor(textY + 12), prompt, TEXT_WHITE);
  }
}

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
  const totalInvPages = Math.max(1, Math.ceil(inputSt.itemSelectList.length / INV_SLOTS));
  let slidePixel = 0;
  if (battleSt.battleState === 'item-slide') slidePixel = inputSt.itemSlideDir * Math.min(battleSt.battleTimer / ITEM_SLIDE_MS, 1) * rightAreaW;
  _drawBattleItemList(menuX, rightAreaW, invPal, slidePixel, totalInvPages);
  _drawBattleItemCursors(menuX);
}
function _battleMenuStates() {
  const bs = battleSt.battleState;
  const isSlide   = bs === 'enemy-box-expand' || bs === 'encounter-box-expand';
  const isAppear  = bs === 'boss-appear' || bs === 'monster-slide-in';
  const isFade    = bs === 'battle-fade-in';
  const isMenu    = isFade || bs === 'menu-open' || bs === 'target-select' || bs === 'confirm-pause' ||
    bs === 'attack-back' || bs === 'attack-fwd' || bs === 'player-slash' || bs === 'player-hit-show' || bs === 'player-miss-show' ||
    bs === 'player-damage-show' || bs === 'monster-death' || bs === 'defend-anim' ||
    bs.startsWith('item-') || bs === 'sw-throw' || bs === 'sw-hit' ||
    bs === 'run-success' || bs === 'run-fail' || bs === 'enemy-flash' ||
    bs === 'enemy-attack' || bs === 'enemy-damage-show' || bs === 'poison-tick' || bs === 'pvp-second-windup' ||
    bs === 'pvp-ally-appear' || bs === 'pvp-defend-anim' || bs === 'pvp-enemy-slash' ||
    bs === 'pvp-opp-potion' || bs === 'pvp-opp-sw-throw' || bs === 'pvp-opp-sw-hit' || bs === 'message-hold' || bs === 'msg-wait' ||
    bs.startsWith('ally-') || bs === 'boss-dissolve' ||
    bs === 'defeat-monster-fade' || bs === 'defeat-text' || bs === 'team-wipe';
  const isVictory = _isVictoryBattleState() || bs === 'victory-name-out' || bs === 'encounter-box-close' || bs === 'enemy-box-close' || bs === 'defeat-close';
  const isRunBox  = bs.startsWith('run-');
  const isClose   = bs === 'victory-box-close' || bs === 'encounter-box-close' || bs === 'enemy-box-close' || bs === 'defeat-close';
  return { isSlide, isAppear, isFade, isMenu, isVictory, isRunBox, isClose };
}
function drawBattleMenu() {
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
    const isTeamWipe = battleSt.battleState === 'team-wipe';
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
      if (isTeamWipe) {
        // Crossfade: names out (0-400ms), "Defeated" in (400-800ms)
        const t = battleSt.battleTimer;
        if (t < 400) {
          const alpha = 1 - t / 400;
          ui.ctx.globalAlpha = alpha;
          const rowH = 10;
          const startY = HUD_BOT_Y + Math.floor((boxH - names.length * rowH) / 2);
          names.forEach((nb, i) => {
            drawText(ui.ctx, Math.floor((boxW - measureText(nb)) / 2), startY + i * rowH, nb, fadedPal);
          });
          ui.ctx.globalAlpha = 1;
        } else {
          const alpha = Math.min((t - 400) / 400, 1);
          ui.ctx.globalAlpha = alpha;
          const tw = measureText(BATTLE_DEFEATED);
          drawText(ui.ctx, Math.floor((boxW - tw) / 2), HUD_BOT_Y + Math.floor((boxH - 8) / 2), BATTLE_DEFEATED, fadedPal);
          ui.ctx.globalAlpha = 1;
        }
      } else {
        const rowH = 10;
        const startY = HUD_BOT_Y + Math.floor((boxH - names.length * rowH) / 2);
        names.forEach((nb, i) => {
          drawText(ui.ctx, Math.floor((boxW - measureText(nb)) / 2), startY + i * rowH, nb, fadedPal);
        });
      }
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
    for (let i = 0; i < BATTLE_MENU_ITEMS.length; i++)
      drawText(ui.ctx, positions[i][0], positions[i][1], BATTLE_MENU_ITEMS[i], menuPal);
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


function _encounterBoxDims() {
  if (!battleSt.encounterMonsters) return { fullW: 64, fullH: 64, sprH: 32, row0H: 32, row1H: 0 };
  const count = battleSt.encounterMonsters.length;
  const heights = battleSt.encounterMonsters.map(m => {
    const c = getMonsterCanvas(m.monsterId, battleSt.goblinBattleCanvas);
    return c ? c.height : 32;
  });
  const fullW = count === 1 ? 64 : 96;
  // Row 0 = indices 0-1, row 1 = indices 2-3 (monsters pre-sorted tallest first)
  const row0H = Math.max(heights[0] || 32, heights[1] || 0);
  const row1H = count > 2 ? Math.max(heights[2] || 32, heights[3] || 0) : 0;
  const sprH = Math.max(row0H, row1H); // legacy — tallest overall
  const gapY = row1H > 0 ? 2 : 0;
  const padding = 16;
  const innerH = row1H > 0 ? row0H + gapY + row1H : row0H;
  const fullH = Math.ceil((innerH + padding) / 8) * 8;
  return { fullW, fullH, sprH, row0H, row1H };
}


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
    const isBeingHit = (i === inputSt.targetIndex &&
      (battleSt.battleState === 'player-slash' || battleSt.battleState === 'player-hit-show' ||
       battleSt.battleState === 'player-miss-show' || battleSt.battleState === 'player-damage-show')) ||
      (i === battleSt.allyTargetIndex && (battleSt.battleState === 'ally-slash' || battleSt.battleState === 'ally-damage-show')) ||
      (battleSt.battleState === 'sw-hit' && getTargets().includes(i));
    if (!alive && !isDying && !isBeingHit) continue;

    const pos = gridPos[i];
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
      const isHitBlink = (isBeingHit && battleSt.battleState === 'player-slash' && curHit && !curHit.miss && (Math.floor(battleSt.battleTimer / 60) & 1)) ||
                         (isBeingHit && battleSt.battleState === 'ally-slash' && battleSt.allyHitResult && !battleSt.allyHitResult.miss && (Math.floor(battleSt.battleTimer / 60) & 1));
      const isFlashing = battleSt.battleState === 'enemy-flash' && battleSt.currentAttacker === i && Math.floor(battleSt.battleTimer / 33) % 2 === 1;
      if (!isHitBlink) ui.ctx.drawImage(isFlashing ? sprWhite : sprNormal, drawX, drawY);
    }
  }

  _drawEncounterSlashEffects(gridPos, slideOffX, slotCenterY);
  ui.ctx.restore();
}
function _drawEncounterSlashEffects(gridPos, slideOffX, slotCenterY) {
  if (battleSt.battleState === 'player-slash' && bsc.slashFrames && battleSt.slashFrame < SLASH_FRAMES && inputSt.hitResults && inputSt.hitResults[battleSt.currentHitIdx] && !inputSt.hitResults[battleSt.currentHitIdx].miss) {
    const pos = gridPos[inputSt.targetIndex];
    ui.ctx.drawImage(bsc.slashFrames[battleSt.slashFrame], pos.x - slideOffX + battleSt.slashOffX + 8, slotCenterY(inputSt.targetIndex) + battleSt.slashOffY);
  }
  if (battleSt.battleState === 'ally-slash' && battleSt.allyHitResult && !battleSt.allyHitResult.miss) {
    const ally = battleSt.battleAllies[battleSt.currentAllyAttacker];
    const isLeft = battleSt.allyHitIsLeft;
    const activeWpnId = ally ? (isLeft ? ally.weaponL : ally.weaponId) : 0;
    const allySlashFrames = ally ? getSlashFramesForWeapon(activeWpnId, !isLeft) : bsc.slashFramesR;
    const af = Math.min(Math.floor(battleSt.battleTimer / SLASH_FRAME_MS), 2);
    const pos = gridPos[battleSt.allyTargetIndex];
    if (pos && allySlashFrames && allySlashFrames[af]) {
      const scatterX = [0, 10, -8][af], scatterY = [0, -6, 8][af];
      ui.ctx.drawImage(allySlashFrames[af], pos.x + 8 + scatterX, slotCenterY(battleSt.allyTargetIndex) + scatterY);
    }
  }
}

function _drawEncounterCursors(gridPos, count, slotCenterY) {
  if (!(battleSt.battleState === 'target-select' || (battleSt.battleState === 'item-target-select' && inputSt.itemTargetType === 'enemy')) || !_cursorTileCanvas()) return;
  if (battleSt.battleState === 'target-select') {
    const pos = gridPos[inputSt.targetIndex];
    ui.ctx.drawImage(_cursorTileCanvas(), pos.x - 10, slotCenterY(inputSt.targetIndex) - 4);
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
    battleSt.battleState === 'player-damage-show' || battleSt.battleState === 'monster-death' || battleSt.battleState === 'defend-anim' ||
    battleSt.battleState.startsWith('item-') || battleSt.battleState === 'sw-throw' || battleSt.battleState === 'sw-hit' ||
    battleSt.battleState === 'run-success' || battleSt.battleState === 'run-fail' ||
    battleSt.battleState === 'enemy-flash' || battleSt.battleState === 'enemy-attack' || battleSt.battleState === 'enemy-damage-show' ||
    battleSt.battleState === 'poison-tick' || battleSt.battleState === 'message-hold' || battleSt.battleState === 'msg-wait' || battleSt.battleState.startsWith('ally-') ||
    battleSt.battleState === 'defeat-monster-fade' || battleSt.battleState === 'defeat-text';
}
function drawEncounterBox() {
  if (!battleSt.isRandomEncounter || !battleSt.encounterMonsters) return;
  const isExpand = battleSt.battleState === 'encounter-box-expand';
  const isClose = battleSt.battleState === 'encounter-box-close' || battleSt.battleState === 'defeat-close';
  const isSlideIn = battleSt.battleState === 'monster-slide-in';
  const isCombat = _isEncounterCombatState();
  const isVictory = _isVictoryBattleState() || battleSt.battleState === 'victory-name-out';
  if (!isExpand && !isClose && !isCombat && !isVictory) return;

  const count = battleSt.encounterMonsters.length;
  const { fullW, fullH, sprH, row0H, row1H } = _encounterBoxDims();
  const centerX = HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2);
  const centerY = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2);

  const { boxW, boxH } = _calcBoxExpandSize(fullW, fullH, isExpand, isClose, battleSt.battleTimer);
  const boxX = centerX - Math.floor(boxW / 2);
  const boxY = centerY - Math.floor(boxH / 2);

  clipToViewport();
  drawBorderedBox(boxX, boxY, boxW, boxH);

  if (isExpand || isClose || battleSt.battleState === 'defeat-text') { ui.ctx.restore(); return; }

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
    if (bsc.slashFrames && battleSt.slashFrame < SLASH_FRAMES && !battleSt.enemyDefeated && inputSt.hitResults && inputSt.hitResults[battleSt.currentHitIdx] && !inputSt.hitResults[battleSt.currentHitIdx].miss)
      ui.ctx.drawImage(bsc.slashFrames[battleSt.slashFrame], centerX - 8 + battleSt.slashOffX, centerY - 8 + battleSt.slashOffY);
  } else if (battleSt.battleState === 'ally-slash') {
    const blinkHidden = battleSt.allyHitResult && !battleSt.allyHitResult.miss && (Math.floor(battleSt.battleTimer / 60) & 1);
    if (!blinkHidden && !battleSt.enemyDefeated) ui.ctx.drawImage(getBossBattleCanvas(), sprX, sprY);
    if (!battleSt.enemyDefeated && battleSt.allyHitResult && !battleSt.allyHitResult.miss) {
      const ally = battleSt.battleAllies[battleSt.currentAllyAttacker];
      const isLeft = battleSt.allyHitIsLeft;
      const activeWpnId = ally ? (isLeft ? ally.weaponL : ally.weaponId) : 0;
      const allySlashFrames = ally ? getSlashFramesForWeapon(activeWpnId, !isLeft) : bsc.slashFramesR;
      const af = Math.min(Math.floor(battleSt.battleTimer / SLASH_FRAME_MS), 2);
      if (allySlashFrames && allySlashFrames[af])
        ui.ctx.drawImage(allySlashFrames[af], centerX - 8 + [0,10,-8][af], centerY - 8 + [0,-6,8][af]);
    }
  } else {
    if (!battleSt.enemyDefeated) ui.ctx.drawImage(getBossBattleCanvas(), sprX, sprY);
  }
}
function _drawBossSpriteBoxBoss(centerX, centerY) {
  const isExpand = battleSt.battleState === 'enemy-box-expand';
  const isClose  = battleSt.battleState === 'enemy-box-close' || (!battleSt.isRandomEncounter && battleSt.battleState === 'defeat-close');
  const fullW = 64, fullH = 64;

  clipToViewport();

  const { boxW, boxH } = _calcBoxExpandSize(fullW, fullH, isExpand, isClose, battleSt.battleTimer);
  drawBorderedBox(centerX - Math.floor(boxW / 2), centerY - Math.floor(boxH / 2), boxW, boxH);

  if (isExpand || isClose || battleSt.battleState === 'defeat-text') { ui.ctx.restore(); return; }

  _drawBossSprite(centerX, centerY);

  if ((battleSt.battleState === 'target-select' || (battleSt.battleState === 'item-target-select' && inputSt.itemTargetType === 'enemy')) && _cursorTileCanvas())
    ui.ctx.drawImage(_cursorTileCanvas(), centerX - 32 - 16, centerY - 8);

  ui.ctx.restore();
}
function drawBossSpriteBox() {
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
                    battleSt.battleState === 'sw-throw' || battleSt.battleState === 'sw-hit' ||
                    battleSt.battleState === 'enemy-flash' || battleSt.battleState === 'enemy-attack' ||
                    battleSt.battleState === 'enemy-damage-show' || battleSt.battleState === 'poison-tick' || battleSt.battleState === 'pvp-second-windup' ||
                    battleSt.battleState === 'pvp-ally-appear' || battleSt.battleState === 'message-hold' || battleSt.battleState === 'msg-wait' ||
                    battleSt.battleState.startsWith('ally-') ||
                    battleSt.battleState === 'pvp-dissolve' || battleSt.battleState === 'pvp-defend-anim' ||
                    battleSt.battleState === 'pvp-enemy-slash' || battleSt.battleState === 'pvp-opp-potion' ||
                    battleSt.battleState === 'pvp-opp-sw-throw' || battleSt.battleState === 'pvp-opp-sw-hit' ||
                    battleSt.battleState === 'defeat-monster-fade' || battleSt.battleState === 'defeat-text' || battleSt.battleState === 'defeat-close' || battleSt.battleState === 'team-wipe' ||
                    _isVictoryBattleState() || battleSt.battleState === 'victory-name-out';
    if (isCombatPVP) drawBossSpriteBoxPVP(centerX, centerY);
    return;
  }

  if (!getBossBattleCanvas()) return;

  const isExpand = battleSt.battleState === 'enemy-box-expand';
  const isClose = battleSt.battleState === 'enemy-box-close' || battleSt.battleState === 'defeat-close';
  const isAppear = battleSt.battleState === 'boss-appear';
  const isDissolve = battleSt.battleState === 'boss-dissolve';
  const isCombat = battleSt.battleState === 'battle-fade-in' ||
                   battleSt.battleState === 'menu-open' || battleSt.battleState === 'target-select' || battleSt.battleState === 'confirm-pause' ||
                   battleSt.battleState === 'attack-back' || battleSt.battleState === 'attack-fwd' || battleSt.battleState === 'player-slash' || battleSt.battleState === 'player-hit-show' ||
                   battleSt.battleState === 'player-miss-show' ||
                   battleSt.battleState === 'player-damage-show' || battleSt.battleState === 'defend-anim' || battleSt.battleState.startsWith('item-') || battleSt.battleState === 'sw-throw' || battleSt.battleState === 'sw-hit' || battleSt.battleState === 'run-success' || battleSt.battleState === 'run-fail' || battleSt.battleState === 'enemy-flash' ||
                   battleSt.battleState === 'enemy-attack' ||
                   battleSt.battleState === 'enemy-damage-show' || battleSt.battleState === 'poison-tick' || battleSt.battleState === 'message-hold' || battleSt.battleState === 'msg-wait' ||
                   battleSt.battleState.startsWith('ally-') ||
                   battleSt.battleState === 'defeat-monster-fade' || battleSt.battleState === 'defeat-text';
  const isVictory = _isVictoryBattleState() || battleSt.battleState === 'victory-name-out';
  if (!isExpand && !isClose && !isAppear && !isDissolve && !isCombat && !isVictory) return;

  _drawBossSpriteBoxBoss(centerX, centerY);
}


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

function drawBattleMessage() {
  if (battleSt.battleState !== 'message-hold' || !battleSt.battleMessage) return;

  const boxW = 104;
  const boxH = 24;
  const bossCenterY = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2);
  const msgY = bossCenterY + 32 + 8; // below boss box (64/2 = 32) + gap
  const centerX = HUD_VIEW_X + Math.floor((HUD_VIEW_W - boxW) / 2);

  clipToViewport();

  drawBorderedBox(centerX, msgY, boxW, boxH, true);

  const tw = measureText(battleSt.battleMessage);
  const tx = centerX + Math.floor((boxW - tw) / 2);
  const ty = msgY + Math.floor((boxH - 8) / 2);
  drawText(ui.ctx, tx, ty, battleSt.battleMessage, TEXT_WHITE_ON_BLUE);

  ui.ctx.restore();
}


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

function _isRewardState() {
  const bs = battleSt.battleState;
  return bs.startsWith('exp-') || bs.startsWith('gil-') || bs.startsWith('cp-') ||
    bs.startsWith('item-') || bs.startsWith('levelup-') || bs.startsWith('joblv-');
}
function drawVictoryBox() {
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

const DEATH_SLIDE_MS    = 500;
const DEATH_TXTFADE_MS  = 300;
const DEATH_POSEFADE_MS = 300;
const DEATH_TOTAL_MS    = DEATH_SLIDE_MS + DEATH_TXTFADE_MS + DEATH_POSEFADE_MS;

function _drawAllyRow(i, ally, panelTop, weaponDraws) {
  const shakeOff = (battleSt.allyShakeTimer[i] > 0) ? (Math.floor(battleSt.allyShakeTimer[i] / 67) & 1 ? 2 : -2) : 0;
  const rowY = panelTop + i * ROSTER_ROW_H + shakeOff;
  const isVicPose = _isVictoryBattleState();
  const isAllyHit = ((battleSt.battleState === 'ally-hit' || battleSt.battleState === 'ally-damage-show-enemy') &&
    battleSt.enemyTargetAllyIdx === i && getAllyDamageNums()[i] && !getAllyDamageNums()[i].miss) ||
    (battleSt.battleState === 'pvp-opp-sw-hit' && battleSt.allyShakeTimer[i] > 0);
  const isAllyAttack = (battleSt.battleState === 'ally-attack-back' || battleSt.battleState === 'ally-attack-fwd') && battleSt.currentAllyAttacker === i;
  const isAllyHeal = battleSt.battleState === 'item-use' && inputSt.playerActionPending && inputSt.playerActionPending.allyIndex === i;
  const ppx = HUD_RIGHT_X + 8, ppy = rowY + 8;
  drawHudBox(HUD_RIGHT_X, rowY, 32, ROSTER_ROW_H, ally.fadeStep);
  drawHudBox(HUD_RIGHT_X + 32, rowY, HUD_RIGHT_W - 32, ROSTER_ROW_H, ally.fadeStep);

  // Death animation: slide → text fade → death pose fade
  if (ally.deathTimer != null) {
    const dt = Math.min(ally.deathTimer, DEATH_TOTAL_MS);
    ui.ctx.save();

    // Phase 1: kneel portrait slides down, clipped to inner portrait area (16×16)
    if (dt < DEATH_SLIDE_MS) {
      const slideT = dt / DEATH_SLIDE_MS;
      const slideY = Math.floor(slideT * 16);
      const kneelFrames = (fakePlayerKneelPortraits[ally.jobIdx || 0] || fakePlayerKneelPortraits[0])[ally.palIdx];
      const kneel = kneelFrames && kneelFrames[ally.fadeStep];
      if (kneel) {
        ui.ctx.save();
        ui.ctx.beginPath();
        ui.ctx.rect(ppx, ppy, 16, 16);
        ui.ctx.clip();
        ui.ctx.drawImage(kneel, ppx, ppy + slideY);
        ui.ctx.restore();
      }
      _drawAllyTexts(i, ally, rowY, false, ppx, ppy, weaponDraws);
    } else if (dt < DEATH_SLIDE_MS + DEATH_TXTFADE_MS) {
      // Phase 2: name/HP text fades out
      const textAlpha = 1 - (dt - DEATH_SLIDE_MS) / DEATH_TXTFADE_MS;
      ui.ctx.globalAlpha = textAlpha;
      _drawAllyTexts(i, ally, rowY, false, ppx, ppy, weaponDraws);
      ui.ctx.globalAlpha = 1;
    } else {
      // Phase 3: death pose fades in (24×16, centered in the name/HP info box)
      const fadeT = Math.min((dt - DEATH_SLIDE_MS - DEATH_TXTFADE_MS) / DEATH_POSEFADE_MS, 1);
      const deathCanvas = (fakePlayerDeathPoseCanvases[ally.jobIdx || 0] || fakePlayerDeathPoseCanvases[0])?.[ally.palIdx];
      if (deathCanvas) {
        ui.ctx.globalAlpha = fadeT;
        const dx = HUD_RIGHT_X + HUD_RIGHT_W - 24 - 8;
        const dy = rowY + Math.floor((ROSTER_ROW_H - 16) / 2);
        ui.ctx.drawImage(deathCanvas, dx, dy);
        ui.ctx.globalAlpha = 1;
      }
    }
    ui.ctx.restore();
    return;
  }

  const isNearFatal = ally.hp > 0 && ally.hp <= Math.floor(ally.maxHP / 4);
  _drawAllyPortrait(i, ally, isVicPose, isAllyAttack, isAllyHit, isNearFatal, ppx, ppy, weaponDraws);
  _drawAllyTexts(i, ally, rowY, isAllyHeal, ppx, ppy, weaponDraws);
}
function _drawAllyPortrait(i, ally, isVicPose, isAllyAttack, isAllyHit, isNearFatal, ppx, ppy, weaponDraws) {
  const isThisAllySlash = battleSt.battleState === 'ally-slash' && battleSt.currentAllyAttacker === i;
  const hitLeft = isAllyAttack && battleSt.allyHitIsLeft;
  const _j = ally.jobIdx || 0;
  const _fp = (map) => (map[_j] || map[0])[ally.palIdx];
  let portraits;
  const allyUnarmed = !isWeapon(ally.weaponId) && !isWeapon(ally.weaponL);
  // Inter-hit hand-change gap: during ally-attack-back after hit 0, if the upcoming hand differs
  // from the previous hit's hand, hold idle pose so R↔L transitions read as separate strikes.
  const _allyRw = isWeapon(ally.weaponId), _allyLw = isWeapon(ally.weaponL);
  const _allyDualOrUnarmed = (_allyRw && _allyLw) || (!_allyRw && !_allyLw);
  const _allyUpcomingLeft = _allyDualOrUnarmed ? (battleSt.allyHitIdx % 2 === 1) : !_allyRw;
  const allyHandChangeGap = battleSt.battleState === 'ally-attack-back' && battleSt.allyHitIdx > 0 &&
    battleSt.allyHitIsLeft !== _allyUpcomingLeft && battleSt.currentAllyAttacker === i;
  if (isVicPose && (Math.floor(Date.now() / 250) & 1) && _fp(fakePlayerVictoryPortraits)) {
    portraits = _fp(fakePlayerVictoryPortraits);
  } else if (allyHandChangeGap) {
    portraits = _fp(fakePlayerPortraits); // idle during the gap, no weapon overlay
  } else if (isAllyAttack || isThisAllySlash) {
    const useLeft = isThisAllySlash ? battleSt.allyHitIsLeft : hitLeft;
    const wpnId = useLeft ? ally.weaponL : ally.weaponId;
    const key = pickAttackPoseKey({
      weaponSubtype: weaponSubtype(wpnId),
      isUnarmed: allyUnarmed,
      hand: useLeft ? 'L' : 'R',
      attackPhase: isThisAllySlash ? 'fwd' : 'back',
      mirror: false,
    });
    portraits = _fp(ALLY_POSE_MAP[key]);
  } else if (isAllyHit && _fp(fakePlayerHitPortraits)) portraits = _fp(fakePlayerHitPortraits);
  else if (isNearFatal && _fp(fakePlayerKneelPortraits)) portraits = _fp(fakePlayerKneelPortraits);
  else portraits = _fp(fakePlayerPortraits);
  if (!portraits) return;
  // Ally weapon draws (back-swing during isAllyAttack, forward strike during isThisAllySlash).
  // Uses the same pose module as player + opponent — layer rule = R-back behind body, L-back/fwd in front.
  // Hand-change gap suppresses the weapon overlay so the body reads as a clean idle frame.
  if ((isAllyAttack || isThisAllySlash) && !allyHandChangeGap) {
    const useLeft = isThisAllySlash ? battleSt.allyHitIsLeft : hitLeft;
    const wpnId = useLeft ? ally.weaponL : ally.weaponId;
    const phase = isThisAllySlash ? 'fwd' : 'back';
    const hand = useLeft ? 'L' : 'R';
    const allyUnarmedHand = !isWeapon(ally.weaponId) && !isWeapon(ally.weaponL);
    const spec = pickAttackWeaponSpec({
      weaponId: wpnId,
      weaponSubtype: weaponSubtype(wpnId),
      isUnarmed: allyUnarmedHand,
      hand, attackPhase: phase, mirror: false,
      fistPalette: _jobPalette(ally.jobIdx || 0, ally.palIdx || 0),
      fistTimerMs: battleSt.battleTimer,
    });
    if (spec) {
      const layer = attackWeaponLayer({ attackPhase: phase, hand, mirror: false });
      if (layer === 'behind') ui.ctx.drawImage(spec.canvas, ppx + spec.dx, ppy + spec.dy);
      // 'front' draws are queued — they layer above the body, drawn after portrait.
      else weaponDraws.push({ img: spec.canvas, x: ppx + spec.dx, y: ppy + spec.dy });
    }
  }
  ui.ctx.drawImage(portraits[ally.fadeStep], ppx, ppy);
  // Near-fatal sweat — 2 frames alternating every 133ms, 3px above portrait
  if (isNearFatal && bsc.sweatFrames.length === 2 && !isAllyAttack && !isAllyHit && !isVicPose && !isThisAllySlash) {
    const sweatIdx = Math.floor(Date.now() / 133) & 1;
    ui.ctx.drawImage(bsc.sweatFrames[sweatIdx], ppx, ppy - 3);
  }
  // PVP enemy slash overlay on targeted ally — h-flipped (opponent attacks from left).
  // Fires per-hit during the multi-hit pvp-enemy-slash combo, plus the final ally-hit shake state.
  if (pvpSt.isPVPBattle && battleSt.enemyTargetAllyIdx === i &&
      (battleSt.battleState === 'pvp-enemy-slash' || battleSt.battleState === 'ally-hit')) {
    const eWpnId = pvpSt.pvpCurrentEnemyAllyIdx >= 0
      ? pvpSt.pvpEnemyAllies[pvpSt.pvpCurrentEnemyAllyIdx]?.weaponId
      : pvpSt.pvpOpponentStats?.weaponId;
    const eSlashF = getSlashFramesForWeapon(eWpnId, true);
    const af = Math.min(2, Math.floor(battleSt.battleTimer / 67));
    if (eSlashF && eSlashF[af]) {
      const sf = eSlashF[af];
      ui.ctx.save();
      ui.ctx.translate(ppx + sf.width + [-0, -10, 8][af], ppy + [0, -6, 8][af]);
      ui.ctx.scale(-1, 1);
      ui.ctx.drawImage(sf, 0, 0);
      ui.ctx.restore();
    }
  }
}
function _drawAllyTexts(i, ally, rowY, isAllyHeal, ppx, ppy, weaponDraws) {
  const namePal = [0x0F, 0x0F, 0x0F, 0x30];
  for (let s = 0; s < ally.fadeStep; s++) namePal[3] = nesColorFade(namePal[3]);
  const nameBytes = _nameToBytes(ally.name);
  drawText(ui.ctx, HUD_RIGHT_X + HUD_RIGHT_W - 8 - measureText(nameBytes), rowY + 8, nameBytes, namePal);
  const panelLeft = HUD_RIGHT_X + 32 + 8;
  drawLvHpRow(ui.ctx, panelLeft, HUD_RIGHT_X + HUD_RIGHT_W - 8, rowY + 16, ally.level || 1, ally.hp, ally.maxHP, ally.fadeStep);
  const dn = getAllyDamageNums()[i];
  if (dn) weaponDraws.push({ type: 'dmg', dn, bx: HUD_RIGHT_X + 20, by: _dmgBounceY(rowY + 16, dn.timer) });
  if (isAllyHeal && bsc.cureSparkleFrames.length === 2) {
    weaponDraws.push({ type: 'sparkle', frame: bsc.cureSparkleFrames[Math.floor(battleSt.battleTimer / 67) & 1], px: ppx, py: ppy });
  }
}

function _flushAllyWeaponDraws(weaponDraws) {
  for (const wd of weaponDraws) {
    if (wd.type === 'dmg') {
      const { dn, bx, by } = wd;
      if (dn.miss) {
        const mc = getMissCanvas();
        if (mc) ui.ctx.drawImage(mc, bx - 8, by);
      } else {
        _drawBattleNum(bx, by, dn.value, dn.heal ? HEAL_NUM_PAL : DMG_NUM_PAL);
      }
    } else if (wd.type === 'sparkle') {
      const { frame, px, py } = wd;
      drawSparkleCorners(frame, px, py);
    } else {
      ui.ctx.drawImage(wd.img, wd.x, wd.y);
    }
  }
}

function drawBattleAllies() {
  if (battleSt.battleAllies.length === 0 || battleSt.battleState === 'none') return;
  const panelTop = HUD_VIEW_Y + 32;
  const weaponDraws = [];
  ui.ctx.save();
  ui.ctx.beginPath();
  ui.ctx.rect(HUD_RIGHT_X, panelTop, HUD_RIGHT_W, HUD_VIEW_H - 32);
  ui.ctx.clip();
  for (let i = 0; i < battleSt.battleAllies.length; i++) _drawAllyRow(i, battleSt.battleAllies[i], panelTop, weaponDraws);
  ui.ctx.restore();
  if (battleSt.battleState === 'item-target-select' && inputSt.itemTargetType === 'player' && inputSt.itemTargetAllyIndex >= 0 && _cursorTileCanvas()) {
    ui.ctx.drawImage(_cursorTileCanvas(), HUD_RIGHT_X - 4, panelTop + inputSt.itemTargetAllyIndex * ROSTER_ROW_H + 12);
  }
  _flushAllyWeaponDraws(weaponDraws);
}

function _encounterMonsterPos(idx) {
  const { sprH: dSprH, row0H, row1H, gridPos } = _encounterGridLayout();
  const safeIdx = idx < gridPos.length ? idx : 0;
  const pos = gridPos[safeIdx];
  const m = battleSt.encounterMonsters[safeIdx];
  const mc = getMonsterCanvas(m?.monsterId, battleSt.goblinBattleCanvas);
  const rH = safeIdx < 2 ? (row0H || dSprH) : (row1H || dSprH);
  const mh = mc ? mc.height : rH;
  const mw = mc ? mc.width : 32;
  return { bx: pos.x + mw - 4, baseY: pos.y + rH - 8 };
}
function _drawBossDmgNum() {
  if (!getEnemyDmgNum() || (battleSt.enemyDefeated && !battleSt.isRandomEncounter)) return;
  let bx, baseY;
  if (battleSt.isRandomEncounter && battleSt.encounterMonsters) {
    ({ bx, baseY } = _encounterMonsterPos(inputSt.targetIndex));
  } else if (pvpSt.isPVPBattle) {
    const tidx = pvpSt.pvpPlayerTargetIdx < 0 ? 0 : pvpSt.pvpPlayerTargetIdx + 1;
    const { x: cx, y: cy } = _pvpEnemyCellCenter(tidx);
    bx = cx + 8;
    baseY = cy + 12;
  } else {
    const bc = getBossBattleCanvas();
    const bw = bc ? bc.width : 48;
    const bh = bc ? bc.height : 48;
    bx = HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2) + Math.floor(bw / 2) - 4;
    baseY = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2) + Math.floor(bh / 2) - 8;
  }
  const by = _dmgBounceY(baseY, getEnemyDmgNum().timer);
  clipToViewport();
  if (getEnemyDmgNum().miss) {
    const mc = getMissCanvas();
    if (mc) ui.ctx.drawImage(mc, bx - 8, by);
  } else {
    _drawBattleNum(bx, by, getEnemyDmgNum().value, DMG_NUM_PAL);
  }
  ui.ctx.restore();
}

function _drawEnemyHealNum() {
  if (!getEnemyHealNum()) return;
  let bx, baseY;
  if (battleSt.isRandomEncounter && battleSt.encounterMonsters) {
    ({ bx, baseY } = _encounterMonsterPos(getEnemyHealNum().index));
  } else if (pvpSt.isPVPBattle) {
    const { x: cx, y: cy } = _pvpEnemyCellCenter(0);
    bx = cx + 8;
    baseY = cy + 12;
  } else {
    const bc = getBossBattleCanvas();
    const bw = bc ? bc.width : 48;
    const bh = bc ? bc.height : 48;
    bx = HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2) + Math.floor(bw / 2) - 4;
    baseY = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2) + Math.floor(bh / 2) - 8;
  }
  const hy = _dmgBounceY(baseY, getEnemyHealNum().timer);
  clipToViewport();
  _drawBattleNum(bx, hy, getEnemyHealNum().value, HEAL_NUM_PAL);
  ui.ctx.restore();
}

function _drawBattleNum(bx, by, value, pal) {
  _drawBattleNumCtx(ui.ctx, bx, by, value, pal);
}
function drawDamageNumbers() {
  _drawBossDmgNum();

  // Player damage number — bounces on right side of portrait
  if (getPlayerDamageNum()) {
    const px = HUD_RIGHT_X + 20;
    const baseY = HUD_VIEW_Y + 16;
    const py = _dmgBounceY(baseY, getPlayerDamageNum().timer);
    if (getPlayerDamageNum().miss) {
      const mc = getMissCanvas();
      if (mc) ui.ctx.drawImage(mc, px - 8, py);
    } else {
      _drawBattleNum(px, py, getPlayerDamageNum().value, DMG_NUM_PAL);
    }
  }

  // Player heal number — green bounce on right side of portrait during item-use
  if (getPlayerHealNum()) {
    const px = HUD_RIGHT_X + 20;
    const baseY = HUD_VIEW_Y + 16;
    const py = _dmgBounceY(baseY, getPlayerHealNum().timer);
    _drawBattleNum(px, py, getPlayerHealNum().value, HEAL_NUM_PAL);
  }

  _drawEnemyHealNum();
}

// Battle message strip — renders in right panel where chat tabs normally are
const MSG_STRIP_X = 144;
const MSG_STRIP_Y = 160;
const MSG_STRIP_W = 112;

function drawBattleMessageStrip() {
  const msg = getBattleMsgCurrent();
  if (!msg) return;
  const t = getBattleMsgTimer();
  const tw = measureText(msg.bytes);
  const overflow = Math.max(0, tw - MSG_STRIP_W);
  const scrollTime = overflow > 0 ? 400 + overflow / 0.06 + 400 : 0;
  const effectiveHold = Math.max(MSG_HOLD_MS, scrollTime);
  let fadeStep = 0;
  if (msg.persist && battleSt.battleState === 'victory-text-out') {
    fadeStep = Math.min(Math.floor(battleSt.battleTimer / (MSG_FADE_OUT_MS / BATTLE_TEXT_STEPS)), BATTLE_TEXT_STEPS);
  } else if (t < MSG_FADE_IN_MS) {
    fadeStep = BATTLE_TEXT_STEPS - Math.min(Math.floor(t / (MSG_FADE_IN_MS / BATTLE_TEXT_STEPS)), BATTLE_TEXT_STEPS);
  } else if (msg.waitForZ || msg.persist || t < MSG_FADE_IN_MS + effectiveHold) {
    fadeStep = 0; // waitForZ/persist: stay solid after fade-in
  } else {
    fadeStep = Math.min(Math.floor((t - MSG_FADE_IN_MS - effectiveHold) / (MSG_FADE_OUT_MS / BATTLE_TEXT_STEPS)), BATTLE_TEXT_STEPS);
  }
  if (fadeStep >= BATTLE_TEXT_STEPS) return;
  const pal = _makeFadedPal(fadeStep);
  const y = MSG_STRIP_Y + 4;
  if (tw <= MSG_STRIP_W) {
    drawText(ui.ctx, MSG_STRIP_X, y, msg.bytes, pal);
  } else {
    const SCROLL_PAUSE = 400;
    const SCROLL_SPEED = 0.06;
    const scrollMs = overflow / SCROLL_SPEED;
    const holdT = t - MSG_FADE_IN_MS; // time in hold phase
    let scrollX = 0;
    if (holdT < SCROLL_PAUSE) scrollX = 0;
    else if (holdT < SCROLL_PAUSE + scrollMs) scrollX = (holdT - SCROLL_PAUSE) * SCROLL_SPEED;
    else scrollX = overflow;
    ui.ctx.save();
    ui.ctx.beginPath();
    ui.ctx.rect(MSG_STRIP_X, MSG_STRIP_Y, MSG_STRIP_W, 16);
    ui.ctx.clip();
    drawText(ui.ctx, MSG_STRIP_X - scrollX, y, msg.bytes, pal);
    ui.ctx.restore();
  }
}

export { drawBattle, drawBattleAllies, drawSWExplosion, drawSWDamageNumbers };
