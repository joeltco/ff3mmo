// Battle drawing functions — extracted from game.js (pure rendering, no state mutation except critFlashTimer)

import { drawText, measureText, TEXT_WHITE } from './font-renderer.js';
import { nesColorFade, _makeFadedPal } from './palette.js';
import { _calcBoxExpandSize, _encounterGridPos } from './battle-layout.js';
import { _dmgBounceY } from './data/animation-tables.js';
import { DMG_NUM_PAL, HEAL_NUM_PAL, drawBattleNum as _drawBattleNumCtx, getMissCanvas } from './damage-numbers.js';
import { getBossBattleCanvas, getBossWhiteCanvas } from './boss-sprites.js';
import { getMonsterCanvas, getMonsterWhiteCanvas, hasMonsterSprites } from './monster-sprites.js';
import { getItemNameClean, getMonsterName } from './text-decoder.js';
import { weaponSubtype } from './data/items.js';
import { ps, getHitWeapon, isHitRightHand } from './player-stats.js';
import { _nameToBytes, _buildItemRowBytes, makeExpText, makeGilText, makeFoundItemText, makeProfLevelUpText, drawLvHpRow } from './text-utils.js';
import { pvpEnemyCellCenter } from './pvp-math.js';
import { pvpSt, drawBossSpriteBoxPVP } from './pvp.js';
import { inputSt } from './input-handler.js';
import { BATTLE_GAME_OVER, BATTLE_DEFEATED, BATTLE_VICTORY, BATTLE_RAN_AWAY,
         BATTLE_CANT_ESCAPE, BATTLE_BOSS_NAME, BATTLE_GOBLIN_NAME,
         BATTLE_LEVEL_UP, BATTLE_MENU_ITEMS } from './data/strings.js';

const HUD_VIEW_X = 0, HUD_VIEW_Y = 32, HUD_VIEW_W = 144, HUD_VIEW_H = 144;
const HUD_RIGHT_X = 144, HUD_RIGHT_W = 112;
const HUD_BOT_Y = 176, HUD_BOT_H = 64;
const CANVAS_W = 256;
const BATTLE_PANEL_W = 120;
const INV_SLOTS = 3;
const ROSTER_ROW_H = 32;
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

let _s = null;
let _shiftBlockCanvas = null;

function _pvpEnemyCellCenter(idx) {
  return pvpEnemyCellCenter(idx, 1 + pvpSt.pvpEnemyAllies.length);
}

function _encounterGridLayout() {
  const count = _s.encounterMonsters.length;
  const { fullW, fullH, sprH, row0H, row1H } = _encounterBoxDims();
  const boxX = HUD_VIEW_X + Math.floor((HUD_VIEW_W - fullW) / 2);
  const boxY = HUD_VIEW_Y + Math.floor((HUD_VIEW_H - fullH) / 2);
  const gridPos = _encounterGridPos(boxX, boxY, fullW, fullH, count, sprH, row0H, row1H);
  return { count, boxX, boxY, sprH, row0H, row1H, fullW, fullH, gridPos };
}

function drawSWExplosion(shared) {
  _s = shared;
  // PVP opponent South Wind — explosion centered on current target (player or ally)
  if (pvpSt.isPVPBattle && _s.battleState === 'pvp-opp-sw-hit' && _s.battleTimer < 400) {
    if (!_s.swPhaseCanvases.length) return;
    const phase = Math.min(2, Math.floor(_s.battleTimer / 133));
    const canvas = _s.swPhaseCanvases[phase];
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
    _s.ctx.save();
    _s.ctx.beginPath(); _s.ctx.rect(0, HUD_VIEW_Y, CANVAS_W, HUD_VIEW_H); _s.ctx.clip();
    _s.ctx.imageSmoothingEnabled = false;
    _s.ctx.drawImage(canvas, cx - half, cy - half);
    _s.ctx.restore();
    return;
  }
  if (_s.battleState !== 'sw-hit' || _s.battleTimer >= 400) return;
  if (pvpSt.isPVPBattle) {
    if (!_s.swPhaseCanvases.length) return;
    const phase = Math.min(2, Math.floor(_s.battleTimer / 133));
    const canvas = _s.swPhaseCanvases[phase];
    if (!canvas) return;
    const tidx = _s.southWindTargets[_s.southWindHitIdx];
    if (tidx === undefined) return;
    const { x: cx, y: cy } = _pvpEnemyCellCenter(tidx);
    _s.ctx.drawImage(canvas, cx - Math.floor(canvas.width / 2), cy - Math.floor(canvas.height / 2));
    return;
  }
  if (!_s.swPhaseCanvases.length) return;
  const phase = Math.min(2, Math.floor(_s.battleTimer / 133));
  const phaseCanvas = _s.swPhaseCanvases[phase];
  if (!phaseCanvas) return;

  if (_s.isRandomEncounter && _s.encounterMonsters) {
    const { count, boxX, boxY, sprH, row0H, row1H, gridPos: swGridPos } = _encounterGridLayout();
    const tidx = _s.southWindTargets[_s.southWindHitIdx];
    if (tidx === undefined || tidx >= swGridPos.length) return;
    const tp = swGridPos[tidx];
    const m = _s.encounterMonsters[tidx];
    const mc = getMonsterCanvas(m?.monsterId, _s.goblinBattleCanvas);
    const rH = tidx < 2 ? (row0H || sprH) : (row1H || sprH);
    const mh = mc ? mc.height : rH;
    const cx = tp.x + 16;
    const cy = tp.y + (rH - mh) + Math.floor(mh / 2);
    _s.ctx.drawImage(phaseCanvas, cx - Math.floor(phaseCanvas.width / 2), cy - Math.floor(phaseCanvas.height / 2));
  } else {
    // Boss — center on boss sprite
    const cx = HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2);
    const cy = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2);
    _s.ctx.drawImage(phaseCanvas, cx - Math.floor(phaseCanvas.width / 2), cy - Math.floor(phaseCanvas.height / 2));
  }
}

function drawSWDamageNumbers(shared) {
  _s = shared;
  if (_s.battleState !== 'sw-hit') return;
  if (pvpSt.isPVPBattle) {
    for (const [k, dn] of Object.entries(_s.southWindDmgNums)) {
      const { x: cx, y: cy } = _pvpEnemyCellCenter(parseInt(k));
      _drawBattleNum(cx + 8, _dmgBounceY(cy + 12, dn.timer), dn.value, DMG_NUM_PAL);
    }
    return;
  }
  if (_s.isRandomEncounter && _s.encounterMonsters) {
    const { count, boxX, boxY, sprH, row0H, row1H, gridPos: swGridPos } = _encounterGridLayout();
    for (const [k, dn] of Object.entries(_s.southWindDmgNums)) {
      const idx = parseInt(k);
      if (idx >= swGridPos.length) continue;
      const tp = swGridPos[idx];
      const m = _s.encounterMonsters[idx];
      const mc = getMonsterCanvas(m?.monsterId, _s.goblinBattleCanvas);
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
    for (const [k, dn] of Object.entries(_s.southWindDmgNums)) {
      const bx = HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2) + Math.floor(bw / 2) - 4;
      const baseY = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2) + Math.floor(bh / 2) - 8;
      _drawBattleNum(bx, _dmgBounceY(baseY, dn.timer), dn.value, DMG_NUM_PAL);
    }
  }
}

function _getPortraitSrc(isNearFatal, isAttackPose, isHitPose, isDefendPose, isItemUsePose, isVictoryPose) {
  const hasActiveStatus = ps.status && ps.status.mask !== 0;
  let src = ((isNearFatal || hasActiveStatus) && _s.battleSpriteKneelCanvas) ? _s.battleSpriteKneelCanvas : _s.battleSpriteCanvas;
  if (isAttackPose) {
    const _ws = weaponSubtype(getHitWeapon(_s.currentHitIdx));
    if (_ws === 'knife' || _ws === 'dagger') {
      src = (isHitRightHand(_s.currentHitIdx) ? _s.battleSpriteKnifeRCanvas : _s.battleSpriteKnifeLCanvas) || src;
    } else if (_s.battleState === 'attack-start') {
      src = (isHitRightHand(_s.currentHitIdx) ? _s.battleSpriteAttackCanvas : _s.battleSpriteAttackLCanvas) || src;
    }
  } else if ((isDefendPose || isItemUsePose) && _s.battleSpriteDefendCanvas) {
    src = _s.battleSpriteDefendCanvas;
  } else if (isHitPose && _s.battleSpriteHitCanvas) {
    src = _s.battleSpriteHitCanvas;
  } else if (isVictoryPose && _s.battleSpriteVictoryCanvas) {
    if (Math.floor(Date.now() / 250) & 1) src = _s.battleSpriteVictoryCanvas;
  }
  return src;
}

function _drawPortraitFrame(px, py, portraitSrc, isRunPose) {
  if (isRunPose) {
    let slideX = 0;
    if (_s.battleState === 'run-text-in') slideX = Math.min(_s.battleTimer / 300, 1) * 20;
    else if (_s.battleState === 'run-hold' || _s.battleState === 'run-text-out') slideX = 20;
    _s.ctx.save();
    _s.ctx.beginPath();
    _s.ctx.rect(HUD_RIGHT_X + 8, HUD_VIEW_Y + 8, 16, 16);
    _s.ctx.clip();
    _s.ctx.translate(px + 16 + slideX, py);
    _s.ctx.scale(-1, 1);
    _s.ctx.drawImage(portraitSrc, 0, 0);
    _s.ctx.restore();
  } else if (_s.battleState === 'encounter-box-close' && _s.runSlideBack) {
    const t = Math.min(_s.battleTimer / 300, 1);
    _s.ctx.save();
    _s.ctx.beginPath();
    _s.ctx.rect(HUD_RIGHT_X + 8, HUD_VIEW_Y + 8, 16, 16);
    _s.ctx.clip();
    _s.ctx.drawImage(portraitSrc, px, py + (1 - t) * 20);
    _s.ctx.restore();
  } else {
    _s.ctx.drawImage(portraitSrc, px, py);
  }
}

function _drawPortraitWeapon(px, py, before) {
  // before=true: back-swing blade BEHIND body; false: front blade IN FRONT or swung
  const handWeapon = getHitWeapon(_s.currentHitIdx);
  const wpnSt = weaponSubtype(handWeapon);
  if (_s.battleState === 'attack-start') {
    const rightHand = isHitRightHand(_s.currentHitIdx);
    if (before && rightHand) {
      if (wpnSt === 'knife' && handWeapon === 0x1F && _s.battleDaggerBladeCanvas) _s.ctx.drawImage(_s.battleDaggerBladeCanvas, px + 8, py - 7);
      else if (wpnSt === 'knife' && _s.battleKnifeBladeCanvas) _s.ctx.drawImage(_s.battleKnifeBladeCanvas, px + 8, py - 7);
      else if (wpnSt === 'sword' && _s.battleSwordBladeCanvas) _s.ctx.drawImage(_s.battleSwordBladeCanvas, px + 8, py - 7);
    } else if (!before && !rightHand) {
      if (wpnSt === 'knife' && handWeapon === 0x1F && _s.battleDaggerBladeCanvas) _s.ctx.drawImage(_s.battleDaggerBladeCanvas, px + 16, py - 7);
      else if (wpnSt === 'knife' && _s.battleKnifeBladeCanvas) _s.ctx.drawImage(_s.battleKnifeBladeCanvas, px + 16, py - 7);
      else if (wpnSt === 'sword' && _s.battleSwordBladeCanvas) _s.ctx.drawImage(_s.battleSwordBladeCanvas, px + 16, py - 7);
    }
  } else if (!before && _s.battleState === 'player-slash') {
    if (wpnSt === 'knife' && handWeapon === 0x1F && _s.battleDaggerBladeSwungCanvas) _s.ctx.drawImage(_s.battleDaggerBladeSwungCanvas, px - 16, py + 1);
    else if (wpnSt === 'knife' && _s.battleKnifeBladeSwungCanvas) _s.ctx.drawImage(_s.battleKnifeBladeSwungCanvas, px - 16, py + 1);
    else if (wpnSt === 'sword' && _s.battleSwordBladeSwungCanvas) _s.ctx.drawImage(_s.battleSwordBladeSwungCanvas, px - 16, py + 1);
    else if (!wpnSt && handWeapon === 0 && _s.battleFistCanvas) _s.ctx.drawImage(_s.battleFistCanvas, px - 4, py + 10);
  }
}

function _drawPortraitOverlays(px, py, isDefendPose, isItemUsePose, isNearFatal, isRunPose,
                                isAttackPose, isHitPose, isVictoryPose) {
  // Defend sparkle — 4 corners cycling during defend-anim
  if (isDefendPose && _s.defendSparkleFrames.length === 4) {
    const fi = Math.min(3, Math.floor(_s.battleTimer / DEFEND_SPARKLE_FRAME_MS));
    const frame = _s.defendSparkleFrames[fi];
    _s.drawSparkleCorners(frame, px, py);
  }
  // Cure sparkle — alternating flips every 67ms during item-use
  if (_s.battleState === 'item-use' && _s.cureSparkleFrames.length === 2 && !(inputSt.playerActionPending && inputSt.playerActionPending.allyIndex >= 0)) {
    const fi = Math.floor(_s.battleTimer / 67) & 1;
    const frame = _s.cureSparkleFrames[fi];
    _s.drawSparkleCorners(frame, px, py);
  }
  // Near-fatal sweat — 2 frames alternating every 133ms, 3px above portrait
  if (isNearFatal && _s.sweatFrames.length === 2 && !isAttackPose && !isHitPose && !isVictoryPose && !isDefendPose && !isItemUsePose) {
    const sweatIdx = Math.floor(Date.now() / 133) & 1;
    if (isRunPose) {
      let slideX = 0;
      if (_s.battleState === 'run-text-in') slideX = Math.min(_s.battleTimer / 300, 1) * 20;
      else if (_s.battleState === 'run-hold' || _s.battleState === 'run-text-out') slideX = 20;
      _s.ctx.save();
      _s.ctx.beginPath();
      _s.ctx.rect(HUD_RIGHT_X + 8, HUD_VIEW_Y + 8 - 3, 16, 19);
      _s.ctx.clip();
      _s.ctx.drawImage(_s.sweatFrames[sweatIdx], px + slideX, py - 3);
      _s.ctx.restore();
    } else if (_s.battleState === 'encounter-box-close' && _s.runSlideBack) {
      const t = Math.min(_s.battleTimer / 300, 1);
      _s.ctx.save();
      _s.ctx.beginPath();
      _s.ctx.rect(HUD_RIGHT_X + 8, HUD_VIEW_Y + 8 - 3, 16, 19);
      _s.ctx.clip();
      _s.ctx.drawImage(_s.sweatFrames[sweatIdx], px, py - 3 + (1 - t) * 20);
      _s.ctx.restore();
    } else {
      _s.ctx.drawImage(_s.sweatFrames[sweatIdx], px, py - 3);
    }
  }
  // Poison bubble — disabled until correct PPU tile data is captured
  // const hasActiveStatus = ps.status && ps.status.mask !== 0;
  // if (hasActiveStatus && _s.poisonBubbleFrames && ...) { ... }
  // Item target cursor on player portrait (only when not targeting an ally)
  if (_s.battleState === 'item-target-select' && inputSt.itemTargetType === 'player' && inputSt.itemTargetAllyIndex < 0 && _s.cursorTileCanvas) {
    _s.ctx.drawImage(_s.cursorTileCanvas, px - 12, py + 4);
  }
  // Enemy slash effect on player portrait during PVP melee attack swing
  if (_s.battleState === 'pvp-enemy-slash') {
    const eWpnId = pvpSt.pvpCurrentEnemyAllyIdx >= 0
      ? pvpSt.pvpEnemyAllies[pvpSt.pvpCurrentEnemyAllyIdx]?.weaponId
      : pvpSt.pvpOpponentStats?.weaponId;
    const eSlashF = _s.getSlashFramesForWeapon(eWpnId, true);
    const af = Math.min(2, Math.floor(_s.battleTimer / 67));
    if (eSlashF && eSlashF[af]) {
      const sf = eSlashF[af];
      _s.ctx.save();
      _s.ctx.translate(px + sf.width + [-0, -10, 8][af], py + [0, -6, 8][af]);
      _s.ctx.scale(-1, 1);
      _s.ctx.drawImage(sf, 0, 0);
      _s.ctx.restore();
    }
  }
}

function _drawBattlePortrait() {
  const px = HUD_RIGHT_X + 8;
  const py = HUD_VIEW_Y + 8;

  // Player death animation: slide → text fade → death pose fade
  if (_s.playerDeathTimer != null) {
    const dt = Math.min(_s.playerDeathTimer, DEATH_TOTAL_MS);

    // Phase 1: kneel slides down, clipped to inner portrait area (16×16)
    if (dt < DEATH_SLIDE_MS) {
      _s.ctx.save();
      _s.ctx.beginPath();
      _s.ctx.rect(px, py, 16, 16);
      _s.ctx.clip();
      const slideT = dt / DEATH_SLIDE_MS;
      const slideY = Math.floor(slideT * 16);
      if (_s.battleSpriteKneelCanvas) _s.ctx.drawImage(_s.battleSpriteKneelCanvas, px, py + slideY);
      _s.ctx.restore();
    }

    // Phase 3: death pose fades in, centered in the name/HP info box
    if (dt >= DEATH_SLIDE_MS + DEATH_TXTFADE_MS) {
      const fadeT = Math.min((dt - DEATH_SLIDE_MS - DEATH_TXTFADE_MS) / DEATH_POSEFADE_MS, 1);
      const deathCanvas = _s.deathPoseCanvases && (_s.deathPoseCanvases[ps.jobIdx] || _s.deathPoseCanvases[0])[0];
      if (deathCanvas) {
        _s.ctx.globalAlpha = fadeT;
        const dx = HUD_RIGHT_X + HUD_RIGHT_W - 24 - 8;
        const dy = HUD_VIEW_Y + Math.floor((32 - 16) / 2);
        _s.ctx.drawImage(deathCanvas, dx, dy);
        _s.ctx.globalAlpha = 1;
      }
    }
    return;
  }

  const shakeOff = ((_s.battleState === 'enemy-attack' || _s.battleState === 'poison-tick' || _s.battleState === 'pvp-opp-sw-hit') && _s.battleShakeTimer > 0)
    ? (Math.floor(_s.battleShakeTimer / 67) & 1 ? 2 : -2) : 0;
  const isVictoryPose = _s.isVictoryBattleState();
  const isAttackPose = _s.battleState === 'attack-start' || _s.battleState === 'player-slash';
  const isHitPose = (_s.battleState === 'poison-tick' && _s.playerDamageNum && !_s.playerDamageNum.miss) ||
    (_s.battleState === 'enemy-attack' && _s.playerDamageNum && !_s.playerDamageNum.miss) ||
    (_s.battleState === 'enemy-damage-show' && _s.playerDamageNum && !_s.playerDamageNum.miss) ||
    (_s.battleState === 'pvp-opp-sw-hit' && _s.battleShakeTimer > 0) ||
    (_s.battleState === 'pvp-enemy-slash' && pvpSt.pvpPendingAttack && !pvpSt.pvpPendingAttack.miss && !pvpSt.pvpPendingAttack.shieldBlock);
  const isDefendPose = _s.battleState === 'defend-anim';
  const isItemUsePose = _s.battleState === 'item-use' || _s.battleState === 'sw-throw' || _s.battleState === 'sw-hit';
  const isRunPose = _s.battleState === 'run-name-out' || _s.battleState === 'run-text-in' ||
    _s.battleState === 'run-hold' || _s.battleState === 'run-text-out';
  const isNearFatal = ps.hp > 0 && ps.stats && ps.hp <= Math.floor(ps.stats.maxHP / 4);
  const portraitSrc = _getPortraitSrc(isNearFatal, isAttackPose, isHitPose, isDefendPose, isItemUsePose, isVictoryPose);
  if (!portraitSrc) return;
  const pxs = px + shakeOff;
  // Blink portrait when enemy slash is landing (mirrors opponent blink on player hit)
  const portraitBlink = _s.battleState === 'pvp-enemy-slash' &&
    pvpSt.pvpPendingAttack && !pvpSt.pvpPendingAttack.miss && !pvpSt.pvpPendingAttack.shieldBlock &&
    (Math.floor(_s.battleTimer / 60) & 1);
  if (!portraitBlink) {
    if (isAttackPose) _drawPortraitWeapon(pxs, py, true);
    _drawPortraitFrame(pxs, py, portraitSrc, isRunPose);
    if (isAttackPose) _drawPortraitWeapon(pxs, py, false);
  }
  _drawPortraitOverlays(pxs, py, isDefendPose, isItemUsePose, isNearFatal, isRunPose, isAttackPose, isHitPose, isVictoryPose);
}

function _drawBattleCritFlash() {
  if (_s.critFlashTimer < 0) return;
  if (_s.critFlashTimer === 0) _s.critFlashTimer = Date.now();
  if (Date.now() - _s.critFlashTimer < 17) {
    _s.clipToViewport();
    _s.ctx.fillStyle = '#DAA336';
    _s.ctx.fillRect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);
    _s.ctx.restore();
  } else { _s.critFlashTimer = -1; }
}
function _drawBattleStrobeFlash() {
  if (_s.battleState !== 'flash-strobe') return;
  if (!(Math.floor(_s.battleTimer / BATTLE_FLASH_FRAME_MS) & 1)) return;
  _s.clipToViewport();
  _s.grayViewport();
}
function _drawBattleDefeat() {
  const ecx = HUD_VIEW_X + HUD_VIEW_W / 2;
  const ecy = HUD_VIEW_Y + HUD_VIEW_H / 2;
  if (_s.battleState === 'defeat-monster-fade') {
    _s.ctx.save();
    _s.ctx.globalAlpha = Math.min(_s.battleTimer / 500, 1);
    _s.ctx.fillStyle = '#000';
    if (_s.isRandomEncounter && _s.encounterMonsters) {
      const { fullW: fw, fullH: fh } = _encounterBoxDims();
      _s.ctx.fillRect(Math.round(ecx - fw / 2) + 8, Math.round(ecy - fh / 2) + 8, fw - 16, fh - 16);
    } else {
      if (!pvpSt.isPVPBattle) _s.ctx.fillRect(ecx - 24, ecy - 24, 48, 48);
    }
    _s.ctx.restore();
  }
  if (_s.battleState === 'defeat-text') {
    const tw = measureText(BATTLE_GAME_OVER);
    drawText(_s.ctx, Math.floor(ecx - tw / 2), Math.floor(ecy - 4), BATTLE_GAME_OVER, TEXT_WHITE);
  }
}
function drawBattle(shared) {
  _s = shared;
  if (_s.battleState === 'none') return;
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

function _drawBattleItemList(baseX, rightAreaW, invPal, slidePixel, totalInvPages) {
  const rowH = 14;
  const topY = HUD_BOT_Y + 12;
  _s.ctx.save();
  _s.ctx.beginPath();
  _s.ctx.rect(baseX - 8, HUD_BOT_Y + 8, rightAreaW + 8, HUD_BOT_H - 16);
  _s.ctx.clip();
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
      drawText(_s.ctx, px + 8, topY, rRow, invPal);
      const lName = ps.weaponL !== 0 ? getItemNameClean(ps.weaponL) : new Uint8Array([0xC2,0xC2,0xC2]);
      const lRow = new Uint8Array(LH_LABEL.length + lName.length);
      lRow.set(LH_LABEL, 0); lRow.set(lName, LH_LABEL.length);
      drawText(_s.ctx, px + 8, topY + rowH + 6, lRow, invPal);
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
        drawText(_s.ctx, px + 8, topY + r * rowH, rowBytes, invPal);
      }
    }
  }
  _s.ctx.restore();
}
function _drawBattleItemCursors(baseX) {
  if (!_s.cursorTileCanvas || _s.battleState !== 'item-select') return;
  const rowH = 14;
  const topY = HUD_BOT_Y + 12;
  const rowY = (page, row) => page === 0 ? topY + row * (rowH + 6) : topY + row * rowH;
  const curPx = baseX - 8;
  if (inputSt.itemHeldIdx !== -1) {
    const heldIsEq = inputSt.itemHeldIdx <= -100;
    const heldPage = heldIsEq ? 0 : 1 + Math.floor(inputSt.itemHeldIdx / INV_SLOTS);
    const heldRow  = heldIsEq ? -(inputSt.itemHeldIdx + 100) : inputSt.itemHeldIdx % INV_SLOTS;
    if (heldPage === inputSt.itemPage) _s.ctx.drawImage(_s.cursorTileCanvas, curPx, rowY(heldPage, heldRow) - 4);
  }
  const activeX = inputSt.itemHeldIdx !== -1 ? curPx - 4 : curPx;
  _s.ctx.drawImage(_s.cursorTileCanvas, activeX, rowY(inputSt.itemPage, inputSt.itemPageCursor) - 4);
}
function _drawBattleItemPanel(menuX) {
  const ITEM_SLIDE_MS = 200;
  const rightAreaW = CANVAS_W - BATTLE_PANEL_W - 8;
  const invPal = [0x0F, 0x0F, 0x0F, 0x30];
  let invFadeStep = 0;
  if (_s.battleState === 'item-list-in') invFadeStep = BATTLE_TEXT_STEPS - Math.min(Math.floor(_s.battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
  else if (_s.battleState === 'item-cancel-out' || _s.battleState === 'item-list-out') invFadeStep = Math.min(Math.floor(_s.battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
  for (let s = 0; s < invFadeStep; s++) invPal[3] = nesColorFade(invPal[3]);
  const totalInvPages = Math.max(1, Math.ceil(inputSt.itemSelectList.length / INV_SLOTS));
  let slidePixel = 0;
  if (_s.battleState === 'item-slide') slidePixel = inputSt.itemSlideDir * Math.min(_s.battleTimer / ITEM_SLIDE_MS, 1) * rightAreaW;
  _drawBattleItemList(menuX, rightAreaW, invPal, slidePixel, totalInvPages);
  _drawBattleItemCursors(menuX);
}
function _battleMenuStates() {
  const bs = _s.battleState;
  const isSlide   = bs === 'enemy-box-expand' || bs === 'encounter-box-expand';
  const isAppear  = bs === 'boss-appear' || bs === 'monster-slide-in';
  const isFade    = bs === 'battle-fade-in';
  const isMenu    = isFade || bs === 'menu-open' || bs === 'target-select' || bs === 'confirm-pause' ||
    bs === 'attack-start' || bs === 'player-slash' || bs === 'player-hit-show' || bs === 'player-miss-show' ||
    bs === 'player-damage-show' || bs === 'monster-death' || bs === 'defend-anim' ||
    bs.startsWith('item-') || bs === 'sw-throw' || bs === 'sw-hit' ||
    bs === 'run-name-out' || bs === 'run-text-in' || bs === 'run-hold' || bs === 'run-text-out' ||
    bs === 'run-fail-name-out' || bs === 'run-fail-text-in' || bs === 'run-fail-hold' ||
    bs === 'run-fail-text-out' || bs === 'run-fail-name-in' || bs === 'enemy-flash' ||
    bs === 'enemy-attack' || bs === 'enemy-damage-show' || bs === 'poison-tick' || bs === 'pvp-second-windup' ||
    bs === 'pvp-ally-appear' || bs === 'pvp-defend-anim' || bs === 'pvp-enemy-slash' ||
    bs === 'pvp-opp-potion' || bs === 'pvp-opp-sw-throw' || bs === 'pvp-opp-sw-hit' || bs === 'message-hold' ||
    bs.startsWith('ally-') || bs === 'boss-dissolve' ||
    bs === 'defeat-monster-fade' || bs === 'defeat-text' || bs === 'team-wipe';
  const isVictory = _s.isVictoryBattleState() || bs === 'victory-name-out' || bs === 'encounter-box-close' || bs === 'enemy-box-close' || bs === 'defeat-close';
  const isRunBox  = bs.startsWith('run-');
  const isClose   = bs === 'victory-box-close' || bs === 'encounter-box-close' || bs === 'enemy-box-close' || bs === 'defeat-close';
  return { isSlide, isAppear, isFade, isMenu, isVictory, isRunBox, isClose };
}
function drawBattleMenu() {
  const { isSlide, isAppear, isFade, isMenu, isVictory, isRunBox, isClose } = _battleMenuStates();
  if (!isSlide && !isAppear && !isMenu && !isVictory) return;

  let panelOffX = 0;
  if (isSlide) panelOffX = Math.round(-CANVAS_W * (1 - Math.min(_s.battleTimer / BOSS_BOX_EXPAND_MS, 1)));
  else if (isClose) panelOffX = Math.round(-CANVAS_W * Math.min(_s.battleTimer / (VICTORY_BOX_ROWS * VICTORY_ROW_FRAME_MS), 1));

  _s.ctx.save();
  _s.ctx.beginPath(); _s.ctx.rect(8, HUD_BOT_Y, CANVAS_W - 16, HUD_BOT_H); _s.ctx.clip();
  _s.ctx.translate(panelOffX, 0);
  _s.ctx.fillStyle = '#000';
  _s.ctx.fillRect(8, HUD_BOT_Y + 8, CANVAS_W - 16, HUD_BOT_H - 16);

  const boxW = BATTLE_PANEL_W, boxH = HUD_BOT_H;
  if ((!isVictory && !isRunBox) || (_s.battleState === 'encounter-box-close' && _s.runSlideBack))
    _s.drawBorderedBox(0, HUD_BOT_Y, boxW, boxH);
  if (!isMenu && !isVictory) { _s.ctx.restore(); return; }

  let fadeStep = 0;
  if (isFade) fadeStep = BATTLE_TEXT_STEPS - Math.min(Math.floor(_s.battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
  const fadedPal = _makeFadedPal(fadeStep);
  if (!isVictory && !isRunBox) {
    const isTeamWipe = _s.battleState === 'team-wipe';
    if (pvpSt.isPVPBattle) {
      // Collect all living PVP enemy names and stack them
      const names = [];
      if (!_s.enemyDefeated && pvpSt.pvpPlayerTargetIdx < 0 && pvpSt.pvpOpponentStats)
        names.push(_nameToBytes(pvpSt.pvpOpponentStats.name));
      for (let i = 0; i < pvpSt.pvpEnemyAllies.length; i++) {
        const a = pvpSt.pvpEnemyAllies[i];
        if (a && a.hp > 0 && i >= pvpSt.pvpPlayerTargetIdx)
          names.push(_nameToBytes(a.name));
      }
      if (isTeamWipe) {
        // Crossfade: names out (0-400ms), "Defeated" in (400-800ms)
        const t = _s.battleTimer;
        if (t < 400) {
          const alpha = 1 - t / 400;
          _s.ctx.globalAlpha = alpha;
          const rowH = 10;
          const startY = HUD_BOT_Y + Math.floor((boxH - names.length * rowH) / 2);
          names.forEach((nb, i) => {
            drawText(_s.ctx, Math.floor((boxW - measureText(nb)) / 2), startY + i * rowH, nb, fadedPal);
          });
          _s.ctx.globalAlpha = 1;
        } else {
          const alpha = Math.min((t - 400) / 400, 1);
          _s.ctx.globalAlpha = alpha;
          const tw = measureText(BATTLE_DEFEATED);
          drawText(_s.ctx, Math.floor((boxW - tw) / 2), HUD_BOT_Y + Math.floor((boxH - 8) / 2), BATTLE_DEFEATED, fadedPal);
          _s.ctx.globalAlpha = 1;
        }
      } else {
        const rowH = 10;
        const startY = HUD_BOT_Y + Math.floor((boxH - names.length * rowH) / 2);
        names.forEach((nb, i) => {
          drawText(_s.ctx, Math.floor((boxW - measureText(nb)) / 2), startY + i * rowH, nb, fadedPal);
        });
      }
    } else if (_s.isRandomEncounter && _s.encounterMonsters) {
      const names = _battleEnemyNames();
      const rowH = 10;
      const startY = HUD_BOT_Y + Math.floor((boxH - names.length * rowH) / 2);
      names.forEach((nb, i) => {
        drawText(_s.ctx, Math.floor((boxW - measureText(nb)) / 2), startY + i * rowH, nb, fadedPal);
      });
    } else {
      const enemyName = _battleEnemyName();
      drawText(_s.ctx, Math.floor((boxW - measureText(enemyName)) / 2), HUD_BOT_Y + Math.floor((boxH - 8) / 2), enemyName, fadedPal);
    }
  }
  const menuX = boxW + 8;
  const positions = [[menuX, HUD_BOT_Y+16], [menuX+56, HUD_BOT_Y+16], [menuX, HUD_BOT_Y+32], [menuX+56, HUD_BOT_Y+32]];
  _drawBattleMenuItems(positions, isVictory, isClose, isFade, fadedPal, menuX);
  _drawBattleMenuCursor(positions, isFade, fadeStep);
  _s.ctx.restore();
}

function _drawBattleMenuItems(positions, isVictory, isClose, isFade, fadedPal, menuX) {
  const isMenuFade = _s.battleState === 'victory-menu-fade';
  const isItemMenuOut = _s.battleState === 'item-menu-out';
  const isItemMenuIn = _s.battleState === 'item-cancel-in' || _s.battleState === 'item-use-menu-in';
  const isItemShowInv = _s.battleState === 'item-list-in' || _s.battleState === 'item-select' ||
    _s.battleState === 'item-cancel-out' || _s.battleState === 'item-list-out' || _s.battleState === 'item-slide' ||
    _s.battleState === 'item-target-select';
  if (!isClose && !isItemShowInv) {
    let menuPal;
    if (isMenuFade || isItemMenuOut) {
      const mfStep = Math.min(Math.floor(_s.battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
      menuPal = [0x0F, 0x0F, 0x0F, 0x30];
      for (let s = 0; s < mfStep; s++) menuPal[3] = nesColorFade(menuPal[3]);
    } else if (isItemMenuIn) {
      const mfStep = BATTLE_TEXT_STEPS - Math.min(Math.floor(_s.battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
      menuPal = [0x0F, 0x0F, 0x0F, 0x30];
      for (let s = 0; s < mfStep; s++) menuPal[3] = nesColorFade(menuPal[3]);
    } else {
      menuPal = isVictory ? [0x0F, 0x0F, 0x0F, 0x30] : fadedPal;
    }
    for (let i = 0; i < BATTLE_MENU_ITEMS.length; i++)
      drawText(_s.ctx, positions[i][0], positions[i][1], BATTLE_MENU_ITEMS[i], menuPal);
  }
  if (isItemShowInv) _drawBattleItemPanel(menuX);
}

function _drawBattleMenuCursor(positions, isFade, fadeStep) {
  if (!_s.cursorTileCanvas) return;
  if (_s.battleState !== 'menu-open' && !isFade) return;
  if (_s.battleState === 'target-select') return;
  const curX = positions[inputSt.battleCursor][0] - 16;
  const curY = positions[inputSt.battleCursor][1] - 4;
  _s.drawCursorFaded(curX, curY, fadeStep);
}


function _encounterBoxDims() {
  if (!_s.encounterMonsters) return { fullW: 64, fullH: 64, sprH: 32, row0H: 32, row1H: 0 };
  const count = _s.encounterMonsters.length;
  const heights = _s.encounterMonsters.map(m => {
    const c = getMonsterCanvas(m.monsterId, _s.goblinBattleCanvas);
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
  if (!_s.goblinBattleCanvas && !hasMonsterSprites()) return;
  let slideOffX = 0;
  if (isSlideIn) slideOffX = Math.floor((1 - Math.min(_s.battleTimer / MONSTER_SLIDE_MS, 1)) * (fullW + 32));

  _s.ctx.save();
  _s.ctx.beginPath();
  _s.ctx.rect(boxX + 8, boxY + 8, boxW - 16, boxH - 16);
  _s.ctx.clip();
  _s.ctx.imageSmoothingEnabled = false;

  const count = _s.encounterMonsters.length;
  for (let i = 0; i < count; i++) {
    const alive = _s.encounterMonsters[i].hp > 0;
    const isDying = _s.dyingMonsterIndices.has(i) && _s.battleState === 'monster-death';
    const isBeingHit = (i === inputSt.targetIndex &&
      (_s.battleState === 'player-slash' || _s.battleState === 'player-hit-show' ||
       _s.battleState === 'player-miss-show' || _s.battleState === 'player-damage-show')) ||
      (i === _s.allyTargetIndex && (_s.battleState === 'ally-slash' || _s.battleState === 'ally-damage-show')) ||
      (_s.battleState === 'sw-hit' && _s.southWindTargets.includes(i));
    if (!alive && !isDying && !isBeingHit) continue;

    const pos = gridPos[i];
    const drawX = pos.x - slideOffX;
    const mid = _s.encounterMonsters[i].monsterId;
    const sprNormal = getMonsterCanvas(mid, _s.goblinBattleCanvas);
    const sprWhite  = getMonsterWhiteCanvas(mid, _s.goblinWhiteCanvas);
    const thisH = sprNormal ? sprNormal.height : sprH;
    const rH = i < 2 ? (row0H || sprH) : (row1H || sprH);
    const drawY = pos.y + (rH - thisH);

    if (isDying) {
      const delay = _s.dyingMonsterIndices.get(i) || 0;
      _s.drawMonsterDeath(drawX, drawY, thisH, Math.min(Math.max(0, _s.battleTimer - delay) / MONSTER_DEATH_MS, 1), mid);
    } else {
      const curHit = inputSt.hitResults && inputSt.hitResults[_s.currentHitIdx];
      const isHitBlink = (isBeingHit && _s.battleState === 'player-slash' && curHit && !curHit.miss && (Math.floor(_s.battleTimer / 60) & 1)) ||
                         (isBeingHit && _s.battleState === 'ally-slash' && _s.allyHitResult && !_s.allyHitResult.miss && (Math.floor(_s.battleTimer / 60) & 1));
      const isFlashing = _s.battleState === 'enemy-flash' && _s.currentAttacker === i && Math.floor(_s.battleTimer / 33) % 2 === 1;
      if (!isHitBlink) _s.ctx.drawImage(isFlashing ? sprWhite : sprNormal, drawX, drawY);
    }
  }

  _drawEncounterSlashEffects(gridPos, slideOffX, slotCenterY);
  _s.ctx.restore();
}
function _drawEncounterSlashEffects(gridPos, slideOffX, slotCenterY) {
  if (_s.battleState === 'player-slash' && _s.slashFrames && _s.slashFrame < SLASH_FRAMES && inputSt.hitResults && inputSt.hitResults[_s.currentHitIdx] && !inputSt.hitResults[_s.currentHitIdx].miss) {
    const pos = gridPos[inputSt.targetIndex];
    _s.ctx.drawImage(_s.slashFrames[_s.slashFrame], pos.x - slideOffX + _s.slashOffX + 8, slotCenterY(inputSt.targetIndex) + _s.slashOffY);
  }
  if (_s.battleState === 'ally-slash' && _s.allyHitResult && !_s.allyHitResult.miss) {
    const ally = _s.battleAllies[_s.currentAllyAttacker];
    const allySlashFrames = ally ? _s.getSlashFramesForWeapon(ally.weaponId, true) : _s.slashFramesR;
    const af = Math.min(Math.floor(_s.battleTimer / 67), 2);
    const pos = gridPos[_s.allyTargetIndex];
    if (pos && allySlashFrames && allySlashFrames[af]) {
      const scatterX = [0, 10, -8][af], scatterY = [0, -6, 8][af];
      _s.ctx.drawImage(allySlashFrames[af], pos.x + 8 + scatterX, slotCenterY(_s.allyTargetIndex) + scatterY);
    }
  }
}

function _drawEncounterCursors(gridPos, count, slotCenterY) {
  if (!(_s.battleState === 'target-select' || (_s.battleState === 'item-target-select' && inputSt.itemTargetType === 'enemy')) || !_s.cursorTileCanvas) return;
  if (_s.battleState === 'target-select') {
    const pos = gridPos[inputSt.targetIndex];
    _s.ctx.drawImage(_s.cursorTileCanvas, pos.x - 10, slotCenterY(inputSt.targetIndex) - 4);
  } else if (inputSt.itemTargetMode === 'single') {
    const pos = gridPos[inputSt.itemTargetIndex];
    if (pos) _s.ctx.drawImage(_s.cursorTileCanvas, pos.x - 10, slotCenterY(inputSt.itemTargetIndex) - 4);
  } else if (Math.floor(Date.now() / 133) & 1) {
    const _rightCols = count === 1 ? [0] : count === 2 ? [1] : [1, 3];
    const _leftCols  = count === 2 ? [0] : count >= 3 ? [0, 2] : [];
    let targets = [];
    if (inputSt.itemTargetMode === 'all') targets = _s.encounterMonsters.map((m, i) => m.hp > 0 ? i : -1).filter(i => i >= 0);
    else if (inputSt.itemTargetMode === 'col-right') targets = _rightCols.filter(i => i < count && _s.encounterMonsters[i]?.hp > 0);
    else if (inputSt.itemTargetMode === 'col-left') targets = _leftCols.filter(i => i < count && _s.encounterMonsters[i]?.hp > 0);
    for (const ti of targets) if (gridPos[ti]) _s.ctx.drawImage(_s.cursorTileCanvas, gridPos[ti].x - 10, slotCenterY(ti) - 4);
  }
}

function _isEncounterCombatState() {
  return _s.battleState === 'monster-slide-in' || _s.battleState === 'battle-fade-in' || _s.battleState === 'menu-open' ||
    _s.battleState === 'target-select' || _s.battleState === 'confirm-pause' || _s.battleState === 'attack-start' ||
    _s.battleState === 'player-slash' || _s.battleState === 'player-hit-show' || _s.battleState === 'player-miss-show' ||
    _s.battleState === 'player-damage-show' || _s.battleState === 'monster-death' || _s.battleState === 'defend-anim' ||
    _s.battleState.startsWith('item-') || _s.battleState === 'sw-throw' || _s.battleState === 'sw-hit' ||
    _s.battleState === 'run-name-out' || _s.battleState === 'run-text-in' || _s.battleState === 'run-hold' ||
    _s.battleState === 'run-text-out' || _s.battleState === 'run-fail-name-out' || _s.battleState === 'run-fail-text-in' ||
    _s.battleState === 'run-fail-hold' || _s.battleState === 'run-fail-text-out' || _s.battleState === 'run-fail-name-in' ||
    _s.battleState === 'enemy-flash' || _s.battleState === 'enemy-attack' || _s.battleState === 'enemy-damage-show' ||
    _s.battleState === 'poison-tick' || _s.battleState === 'message-hold' || _s.battleState.startsWith('ally-') ||
    _s.battleState === 'defeat-monster-fade' || _s.battleState === 'defeat-text';
}
function drawEncounterBox() {
  if (!_s.isRandomEncounter || !_s.encounterMonsters) return;
  const isExpand = _s.battleState === 'encounter-box-expand';
  const isClose = _s.battleState === 'encounter-box-close' || _s.battleState === 'defeat-close';
  const isSlideIn = _s.battleState === 'monster-slide-in';
  const isCombat = _isEncounterCombatState();
  const isVictory = _s.isVictoryBattleState() || _s.battleState === 'victory-name-out';
  if (!isExpand && !isClose && !isCombat && !isVictory) return;

  const count = _s.encounterMonsters.length;
  const { fullW, fullH, sprH, row0H, row1H } = _encounterBoxDims();
  const centerX = HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2);
  const centerY = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2);

  const { boxW, boxH } = _calcBoxExpandSize(fullW, fullH, isExpand, isClose, _s.battleTimer);
  const boxX = centerX - Math.floor(boxW / 2);
  const boxY = centerY - Math.floor(boxH / 2);

  _s.clipToViewport();
  _s.drawBorderedBox(boxX, boxY, boxW, boxH);

  if (isExpand || isClose || _s.battleState === 'defeat-text') { _s.ctx.restore(); return; }

  const gridPos = _encounterGridPos(boxX, boxY, fullW, fullH, count, sprH, row0H, row1H);
  const rowH = (idx) => idx < 2 ? row0H : row1H;
  const slotCenterY = (idx) => {
    if (!gridPos[idx] || !_s.encounterMonsters[idx]) return 0;
    const c = getMonsterCanvas(_s.encounterMonsters[idx].monsterId, _s.goblinBattleCanvas);
    const h = c ? c.height : rowH(idx);
    return gridPos[idx].y + (rowH(idx) - h) + Math.floor(h / 2);
  };
  _drawEncounterMonsters(gridPos, sprH, boxX, boxY, boxW, boxH, isSlideIn, fullW, slotCenterY, row0H, row1H);
  _drawEncounterCursors(gridPos, count, slotCenterY);
  _s.ctx.restore();
}

function _drawBossSprite(centerX, centerY) {
  const sprX = centerX - 24, sprY = centerY - 24;
  _s.ctx.imageSmoothingEnabled = false;
  if (_s.battleState === 'boss-appear' || _s.battleState === 'boss-dissolve') {
    _drawDissolvedSprite(sprX, sprY, _s.battleState === 'boss-dissolve');
  } else if (_s.battleState === 'enemy-flash') {
    const frame = Math.floor(_s.battleTimer / (BOSS_PREFLASH_MS / 8));
    if (!_s.enemyDefeated) _s.ctx.drawImage((frame & 1) ? (getBossWhiteCanvas() || getBossBattleCanvas()) : getBossBattleCanvas(), sprX, sprY);
  } else if (_s.battleState === 'player-slash') {
    if (!(Math.floor(_s.battleTimer / 60) & 1) && !_s.enemyDefeated) _s.ctx.drawImage(getBossBattleCanvas(), sprX, sprY);
    if (_s.slashFrames && _s.slashFrame < SLASH_FRAMES && !_s.enemyDefeated && inputSt.hitResults && inputSt.hitResults[_s.currentHitIdx] && !inputSt.hitResults[_s.currentHitIdx].miss)
      _s.ctx.drawImage(_s.slashFrames[_s.slashFrame], centerX - 8 + _s.slashOffX, centerY - 8 + _s.slashOffY);
  } else if (_s.battleState === 'ally-slash') {
    const blinkHidden = _s.allyHitResult && !_s.allyHitResult.miss && (Math.floor(_s.battleTimer / 60) & 1);
    if (!blinkHidden && !_s.enemyDefeated) _s.ctx.drawImage(getBossBattleCanvas(), sprX, sprY);
    if (!_s.enemyDefeated && _s.allyHitResult && !_s.allyHitResult.miss) {
      const ally = _s.battleAllies[_s.currentAllyAttacker];
      const allySlashFrames = ally ? _s.getSlashFramesForWeapon(ally.weaponId, true) : _s.slashFramesR;
      const af = Math.min(Math.floor(_s.battleTimer / 67), 2);
      if (allySlashFrames && allySlashFrames[af])
        _s.ctx.drawImage(allySlashFrames[af], centerX - 8 + [0,10,-8][af], centerY - 8 + [0,-6,8][af]);
    }
  } else {
    if (!_s.enemyDefeated) _s.ctx.drawImage(getBossBattleCanvas(), sprX, sprY);
  }
}
function _drawBossSpriteBoxBoss(centerX, centerY) {
  const isExpand = _s.battleState === 'enemy-box-expand';
  const isClose  = _s.battleState === 'enemy-box-close' || (!_s.isRandomEncounter && _s.battleState === 'defeat-close');
  const fullW = 64, fullH = 64;

  _s.clipToViewport();

  const { boxW, boxH } = _calcBoxExpandSize(fullW, fullH, isExpand, isClose, _s.battleTimer);
  _s.drawBorderedBox(centerX - Math.floor(boxW / 2), centerY - Math.floor(boxH / 2), boxW, boxH);

  if (isExpand || isClose || _s.battleState === 'defeat-text') { _s.ctx.restore(); return; }

  _drawBossSprite(centerX, centerY);

  if ((_s.battleState === 'target-select' || (_s.battleState === 'item-target-select' && inputSt.itemTargetType === 'enemy')) && _s.cursorTileCanvas)
    _s.ctx.drawImage(_s.cursorTileCanvas, centerX - 32 - 16, centerY - 8);

  _s.ctx.restore();
}
function drawBossSpriteBox() {
  if (_s.isRandomEncounter) return;

  const centerX = HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2);
  const centerY = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2);

  if (pvpSt.isPVPBattle) {
    const isCombatPVP = _s.battleState === 'battle-fade-in' ||
                    _s.battleState === 'enemy-box-expand' || _s.battleState === 'enemy-box-close' ||
                    _s.battleState === 'menu-open' || _s.battleState === 'target-select' || _s.battleState === 'confirm-pause' ||
                    _s.battleState === 'attack-start' || _s.battleState === 'player-slash' || _s.battleState === 'player-hit-show' ||
                    _s.battleState === 'player-miss-show' ||
                    _s.battleState === 'player-damage-show' || _s.battleState === 'defend-anim' || _s.battleState.startsWith('item-') ||
                    _s.battleState === 'sw-throw' || _s.battleState === 'sw-hit' ||
                    _s.battleState === 'enemy-flash' || _s.battleState === 'enemy-attack' ||
                    _s.battleState === 'enemy-damage-show' || _s.battleState === 'poison-tick' || _s.battleState === 'pvp-second-windup' ||
                    _s.battleState === 'pvp-ally-appear' || _s.battleState === 'message-hold' ||
                    _s.battleState.startsWith('ally-') ||
                    _s.battleState === 'pvp-dissolve' || _s.battleState === 'pvp-defend-anim' ||
                    _s.battleState === 'pvp-enemy-slash' || _s.battleState === 'pvp-opp-potion' ||
                    _s.battleState === 'pvp-opp-sw-throw' || _s.battleState === 'pvp-opp-sw-hit' ||
                    _s.battleState === 'defeat-monster-fade' || _s.battleState === 'defeat-text' || _s.battleState === 'defeat-close' || _s.battleState === 'team-wipe' ||
                    _s.battleState === 'victory-name-out' || _s.battleState === 'victory-celebrate' ||
                    _s.battleState === 'victory-text-in' || _s.battleState === 'victory-hold' || _s.battleState === 'victory-fade-out' ||
                    _s.battleState === 'exp-text-in' || _s.battleState === 'exp-hold' || _s.battleState === 'exp-fade-out' ||
                    _s.battleState === 'gil-text-in' || _s.battleState === 'gil-hold' || _s.battleState === 'gil-fade-out' ||
                    _s.battleState === 'levelup-text-in' || _s.battleState === 'levelup-hold' ||
                    _s.battleState === 'item-text-in' || _s.battleState === 'item-hold' || _s.battleState === 'item-fade-out' ||
                    _s.battleState === 'prof-levelup-text-in' || _s.battleState === 'prof-levelup-hold' ||
                    _s.battleState === 'victory-text-out' || _s.battleState === 'victory-menu-fade' || _s.battleState === 'victory-box-close';
    if (isCombatPVP) drawBossSpriteBoxPVP(_s.pvpShared(), centerX, centerY);
    return;
  }

  if (!getBossBattleCanvas()) return;

  const isExpand = _s.battleState === 'enemy-box-expand';
  const isClose = _s.battleState === 'enemy-box-close' || _s.battleState === 'defeat-close';
  const isAppear = _s.battleState === 'boss-appear';
  const isDissolve = _s.battleState === 'boss-dissolve';
  const isCombat = _s.battleState === 'battle-fade-in' ||
                   _s.battleState === 'menu-open' || _s.battleState === 'target-select' || _s.battleState === 'confirm-pause' ||
                   _s.battleState === 'attack-start' || _s.battleState === 'player-slash' || _s.battleState === 'player-hit-show' ||
                   _s.battleState === 'player-miss-show' ||
                   _s.battleState === 'player-damage-show' || _s.battleState === 'defend-anim' || _s.battleState.startsWith('item-') || _s.battleState === 'sw-throw' || _s.battleState === 'sw-hit' || _s.battleState === 'run-name-out' || _s.battleState === 'run-text-in' || _s.battleState === 'run-hold' || _s.battleState === 'run-text-out' || _s.battleState === 'run-fail-name-out' || _s.battleState === 'run-fail-text-in' || _s.battleState === 'run-fail-hold' || _s.battleState === 'run-fail-text-out' || _s.battleState === 'run-fail-name-in' || _s.battleState === 'enemy-flash' ||
                   _s.battleState === 'enemy-attack' ||
                   _s.battleState === 'enemy-damage-show' || _s.battleState === 'poison-tick' || _s.battleState === 'message-hold' ||
                   _s.battleState.startsWith('ally-') ||
                   _s.battleState === 'defeat-monster-fade' || _s.battleState === 'defeat-text';
  const isVictory = _s.battleState === 'victory-name-out' || _s.battleState === 'victory-celebrate' ||
                    _s.battleState === 'victory-text-in' || _s.battleState === 'victory-hold' || _s.battleState === 'victory-fade-out' ||
                    _s.battleState === 'exp-text-in' || _s.battleState === 'exp-hold' || _s.battleState === 'exp-fade-out' ||
                    _s.battleState === 'gil-text-in' || _s.battleState === 'gil-hold' || _s.battleState === 'gil-fade-out' ||
                    _s.battleState === 'levelup-text-in' || _s.battleState === 'levelup-hold' ||
                    _s.battleState === 'item-text-in' || _s.battleState === 'item-hold' || _s.battleState === 'item-fade-out' ||
                    _s.battleState === 'prof-levelup-text-in' || _s.battleState === 'prof-levelup-hold' ||
                    _s.battleState === 'victory-text-out' || _s.battleState === 'victory-menu-fade' || _s.battleState === 'victory-box-close';
  if (!isExpand && !isClose && !isAppear && !isDissolve && !isCombat && !isVictory) return;

  _drawBossSpriteBoxBoss(centerX, centerY);
}


function _drawDissolvedSprite(sprX, sprY, reverse) {
  // Interlaced pixel-shift dissolve per 16×16 block
  const frame = Math.floor(_s.battleTimer / BOSS_DISSOLVE_FRAME_MS);
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
        _s.ctx.drawImage(src, bx, by, BOSS_BLOCK_SIZE, BOSS_BLOCK_SIZE,
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
        _s.ctx.drawImage(src, bx, by, BOSS_BLOCK_SIZE, BOSS_BLOCK_SIZE,
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
  _s.ctx.drawImage(_shiftBlockCanvas, sprX + bx, sprY + by);
}

function drawBattleMessage() {
  if (_s.battleState !== 'message-hold' || !_s.battleMessage) return;

  const boxW = 104;
  const boxH = 24;
  const bossCenterY = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2);
  const msgY = bossCenterY + 32 + 8; // below boss box (64/2 = 32) + gap
  const centerX = HUD_VIEW_X + Math.floor((HUD_VIEW_W - boxW) / 2);

  _s.clipToViewport();

  _s.drawBorderedBox(centerX, msgY, boxW, boxH, true);

  const tw = measureText(_s.battleMessage);
  const tx = centerX + Math.floor((boxW - tw) / 2);
  const ty = msgY + Math.floor((boxH - 8) / 2);
  drawText(_s.ctx, tx, ty, _s.battleMessage, TEXT_WHITE_ON_BLUE);

  _s.ctx.restore();
}


function _battleEnemyNames() {
  const names = [];
  const seen = new Set();
  for (const m of _s.encounterMonsters) {
    if (m.hp <= 0 || seen.has(m.monsterId)) continue;
    seen.add(m.monsterId);
    const baseName = getMonsterName(m.monsterId) || BATTLE_GOBLIN_NAME;
    const count = _s.encounterMonsters.filter(e => e.hp > 0 && e.monsterId === m.monsterId).length;
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
  if (_s.isRandomEncounter && _s.encounterMonsters) {
    // Use targeted monster's name (or first alive if no target)
    const ti = (inputSt.targetIndex >= 0 && inputSt.targetIndex < _s.encounterMonsters.length && _s.encounterMonsters[inputSt.targetIndex].hp > 0)
      ? inputSt.targetIndex
      : _s.encounterMonsters.findIndex(m => m.hp > 0);
    const monsterId = _s.encounterMonsters[ti >= 0 ? ti : 0].monsterId;
    const baseName = getMonsterName(monsterId) || BATTLE_GOBLIN_NAME;
    // Count how many of this same type are alive
    const aliveOfType = _s.encounterMonsters.filter(m => m.hp > 0 && m.monsterId === monsterId).length;
    if (aliveOfType > 1) {
      const arr = Array.from(baseName);
      arr.push(0xFF, 0xE1, 0x80 + aliveOfType);
      return new Uint8Array(arr);
    }
    return baseName;
  }
  return BATTLE_BOSS_NAME;
}

function _victoryBoxStates() {
  const bs = _s.battleState;
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
  const isProfLvText = bs === 'prof-levelup-text-in';
  const isProfLvHold = bs === 'prof-levelup-hold';
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
           isProfLvText, isProfLvHold,
           isOut, isMenuFadeState, isRunNameOut, isRunTextIn, isRunHold, isRunTextOut,
           isRunFailNameOut, isRunFailTextIn, isRunFailHold, isRunFailTextOut, isRunFailNameIn,
           isRun, isRunFail };
}
function _drawVictoryMessage(boxX, boxY, s) {
  let fadeStep = 0;
  if (s.isVicText || s.isExpText || s.isGilText || s.isItemText || s.isLevelText || s.isProfLvText)
    fadeStep = BATTLE_TEXT_STEPS - Math.min(Math.floor(_s.battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
  else if (s.isVicFadeOut || s.isExpFadeOut || s.isGilFadeOut || s.isItemFadeOut || s.isOut)
    fadeStep = Math.min(Math.floor(_s.battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
  const fadedPal = _makeFadedPal(fadeStep);
  let msg;
  if (s.isVicText || s.isVicHold || s.isVicFadeOut) msg = BATTLE_VICTORY;
  else if (s.isExpText || s.isExpHold || s.isExpFadeOut) msg = makeExpText(_s.encounterExpGained);
  else if (s.isGilText || s.isGilHold || s.isGilFadeOut) msg = makeGilText(_s.encounterGilGained);
  else if (s.isItemText || s.isItemHold || s.isItemFadeOut) msg = _s.encounterDropItem !== null ? makeFoundItemText(_s.encounterDropItem) : null;
  else if (s.isLevelText || s.isLevelHold) msg = BATTLE_LEVEL_UP;
  else if (s.isProfLvText || s.isProfLvHold) { const p = _s.encounterProfLevelUps[_s.profLevelUpIdx]; msg = p ? makeProfLevelUpText(p.cat, p.newLevel) : null; }
  else if (s.isOut) msg = ps.leveledUp ? BATTLE_LEVEL_UP : _s.encounterDropItem !== null ? makeFoundItemText(_s.encounterDropItem) : makeGilText(_s.encounterGilGained);
  if (msg) {
    const tw = measureText(msg);
    drawText(_s.ctx, boxX + Math.floor((VICTORY_BOX_W - tw) / 2), boxY + Math.floor((VICTORY_BOX_H - 8) / 2), msg, fadedPal);
  }
}
function drawVictoryBox() {
  const s = _victoryBoxStates();
  const showBox = s.isNameOut || s.isCelebrate || s.isClose || s.isVicText || s.isVicHold || s.isVicFadeOut ||
    s.isExpText || s.isExpHold || s.isExpFadeOut || s.isGilText || s.isGilHold || s.isGilFadeOut ||
    s.isItemText || s.isItemHold || s.isItemFadeOut || s.isLevelText || s.isLevelHold ||
    s.isProfLvText || s.isProfLvHold ||
    s.isOut || s.isMenuFadeState || s.isRun || s.isRunFail;
  if (!showBox) return;

  let boxX = 0;
  const boxY = HUD_BOT_Y;
  if (s.isClose) boxX = Math.round(-(CANVAS_W - 8) * Math.min(_s.battleTimer / (VICTORY_BOX_ROWS * VICTORY_ROW_FRAME_MS), 1));

  if (s.isNameOut || s.isRunNameOut || s.isRunFailNameOut) { _drawVictoryNameOut(boxX, boxY, s.isRunFailNameOut); return; }
  if (s.isRun) { _drawVictoryRunText(boxX, boxY, s.isRunTextIn, s.isRunTextOut); return; }
  if (s.isRunFail) { _drawVictoryRunFail(boxX, boxY, s.isRunFailNameIn, s.isRunFailTextIn, s.isRunFailTextOut); return; }
  if (s.isCelebrate) { _s.drawBorderedBox(boxX, boxY, VICTORY_BOX_W, VICTORY_BOX_H); return; }
  _s.drawBorderedBox(boxX, boxY, VICTORY_BOX_W, VICTORY_BOX_H);
  if (s.isClose) return;
  _drawVictoryMessage(boxX, boxY, s);
}

function _drawVictoryNameOut(boxX, boxY, isRunFail) {
  _s.drawBorderedBox(boxX, boxY, VICTORY_BOX_W, VICTORY_BOX_H);
  const stepMs = isRunFail ? 50 : BATTLE_TEXT_STEP_MS;
  const fadeStep = Math.min(Math.floor(_s.battleTimer / stepMs), BATTLE_TEXT_STEPS);
  const fadedPal = _makeFadedPal(fadeStep);
  const enemyName = _battleEnemyName();
  const nameTw = measureText(enemyName);
  drawText(_s.ctx, Math.floor((VICTORY_BOX_W - nameTw) / 2), boxY + Math.floor((VICTORY_BOX_H - 8) / 2), enemyName, fadedPal);
}

function _drawVictoryRunText(boxX, boxY, isIn, isOut) {
  _s.drawBorderedBox(boxX, boxY, VICTORY_BOX_W, VICTORY_BOX_H);
  let fadeStep = 0;
  if (isIn) fadeStep = BATTLE_TEXT_STEPS - Math.min(Math.floor(_s.battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
  else if (isOut) fadeStep = Math.min(Math.floor(_s.battleTimer / BATTLE_TEXT_STEP_MS), BATTLE_TEXT_STEPS);
  const fadedPal = _makeFadedPal(fadeStep);
  const tw = measureText(BATTLE_RAN_AWAY);
  drawText(_s.ctx, boxX + Math.floor((VICTORY_BOX_W - tw) / 2), boxY + Math.floor((VICTORY_BOX_H - 8) / 2), BATTLE_RAN_AWAY, fadedPal);
}

function _drawVictoryRunFail(boxX, boxY, isNameIn, isTextIn, isTextOut) {
  _s.drawBorderedBox(boxX, boxY, VICTORY_BOX_W, VICTORY_BOX_H);
  const RUN_FAIL_STEP_MS = 50;
  if (isNameIn) {
    const fadeStep = BATTLE_TEXT_STEPS - Math.min(Math.floor(_s.battleTimer / RUN_FAIL_STEP_MS), BATTLE_TEXT_STEPS);
    const fadedPal = _makeFadedPal(fadeStep);
    const enemyName = _battleEnemyName();
    const nameTw = measureText(enemyName);
    drawText(_s.ctx, boxX + Math.floor((VICTORY_BOX_W - nameTw) / 2), boxY + Math.floor((VICTORY_BOX_H - 8) / 2), enemyName, fadedPal);
  } else {
    const fadeStep = isTextIn ? BATTLE_TEXT_STEPS - Math.min(Math.floor(_s.battleTimer / RUN_FAIL_STEP_MS), BATTLE_TEXT_STEPS)
                              : isTextOut ? Math.min(Math.floor(_s.battleTimer / RUN_FAIL_STEP_MS), BATTLE_TEXT_STEPS) : 0;
    const fadedPal = _makeFadedPal(fadeStep);
    const tw = measureText(BATTLE_CANT_ESCAPE);
    drawText(_s.ctx, boxX + Math.floor((VICTORY_BOX_W - tw) / 2), boxY + Math.floor((VICTORY_BOX_H - 8) / 2), BATTLE_CANT_ESCAPE, fadedPal);
  }
}


const DEATH_SLIDE_MS    = 500;
const DEATH_TXTFADE_MS  = 300;
const DEATH_POSEFADE_MS = 300;
const DEATH_TOTAL_MS    = DEATH_SLIDE_MS + DEATH_TXTFADE_MS + DEATH_POSEFADE_MS;

function _drawAllyRow(i, ally, panelTop, weaponDraws) {
  const shakeOff = (_s.allyShakeTimer[i] > 0) ? (Math.floor(_s.allyShakeTimer[i] / 67) & 1 ? 2 : -2) : 0;
  const rowY = panelTop + i * ROSTER_ROW_H + shakeOff;
  const isVicPose = _s.isVictoryBattleState();
  const isAllyHit = ((_s.battleState === 'ally-hit' || _s.battleState === 'ally-damage-show-enemy') &&
    _s.enemyTargetAllyIdx === i && _s.allyDamageNums[i] && !_s.allyDamageNums[i].miss) ||
    (_s.battleState === 'pvp-opp-sw-hit' && _s.allyShakeTimer[i] > 0);
  const isAllyAttack = (_s.battleState === 'ally-attack-start') && _s.currentAllyAttacker === i;
  const isAllyHeal = _s.battleState === 'item-use' && inputSt.playerActionPending && inputSt.playerActionPending.allyIndex === i;
  const ppx = HUD_RIGHT_X + 8, ppy = rowY + 8;
  _s.drawHudBox(HUD_RIGHT_X, rowY, 32, ROSTER_ROW_H, ally.fadeStep);
  _s.drawHudBox(HUD_RIGHT_X + 32, rowY, HUD_RIGHT_W - 32, ROSTER_ROW_H, ally.fadeStep);

  // Death animation: slide → text fade → death pose fade
  if (ally.deathTimer != null) {
    const dt = Math.min(ally.deathTimer, DEATH_TOTAL_MS);
    _s.ctx.save();

    // Phase 1: kneel portrait slides down, clipped to inner portrait area (16×16)
    if (dt < DEATH_SLIDE_MS) {
      const slideT = dt / DEATH_SLIDE_MS;
      const slideY = Math.floor(slideT * 16);
      const kneelFrames = (_s.fakePlayerKneelPortraits[ally.jobIdx || 0] || _s.fakePlayerKneelPortraits[0])[ally.palIdx];
      const kneel = kneelFrames && kneelFrames[ally.fadeStep];
      if (kneel) {
        _s.ctx.save();
        _s.ctx.beginPath();
        _s.ctx.rect(ppx, ppy, 16, 16);
        _s.ctx.clip();
        _s.ctx.drawImage(kneel, ppx, ppy + slideY);
        _s.ctx.restore();
      }
      _drawAllyTexts(i, ally, rowY, false, ppx, ppy, weaponDraws);
    } else if (dt < DEATH_SLIDE_MS + DEATH_TXTFADE_MS) {
      // Phase 2: name/HP text fades out
      const textAlpha = 1 - (dt - DEATH_SLIDE_MS) / DEATH_TXTFADE_MS;
      _s.ctx.globalAlpha = textAlpha;
      _drawAllyTexts(i, ally, rowY, false, ppx, ppy, weaponDraws);
      _s.ctx.globalAlpha = 1;
    } else {
      // Phase 3: death pose fades in (24×16, centered in the name/HP info box)
      const fadeT = Math.min((dt - DEATH_SLIDE_MS - DEATH_TXTFADE_MS) / DEATH_POSEFADE_MS, 1);
      const deathCanvas = _s.deathPoseCanvases && (_s.deathPoseCanvases[ally.jobIdx || 0] || _s.deathPoseCanvases[0])[ally.palIdx];
      if (deathCanvas) {
        _s.ctx.globalAlpha = fadeT;
        const dx = HUD_RIGHT_X + HUD_RIGHT_W - 24 - 8;
        const dy = rowY + Math.floor((ROSTER_ROW_H - 16) / 2);
        _s.ctx.drawImage(deathCanvas, dx, dy);
        _s.ctx.globalAlpha = 1;
      }
    }
    _s.ctx.restore();
    return;
  }

  const isNearFatal = ally.hp > 0 && ally.hp <= Math.floor(ally.maxHP / 4);
  _drawAllyPortrait(i, ally, isVicPose, isAllyAttack, isAllyHit, isNearFatal, ppx, ppy, weaponDraws);
  _drawAllyTexts(i, ally, rowY, isAllyHeal, ppx, ppy, weaponDraws);
}
function _drawAllyPortrait(i, ally, isVicPose, isAllyAttack, isAllyHit, isNearFatal, ppx, ppy, weaponDraws) {
  const isThisAllySlash = _s.battleState === 'ally-slash' && _s.currentAllyAttacker === i;
  const hitLeft = isAllyAttack && _s.allyHitIsLeft;
  const _j = ally.jobIdx || 0;
  const _fp = (map) => (map[_j] || map[0])[ally.palIdx];
  let portraits;
  if (isVicPose && (Math.floor(Date.now() / 250) & 1) && _fp(_s.fakePlayerVictoryPortraits)) portraits = _fp(_s.fakePlayerVictoryPortraits);
  else if (isAllyAttack) portraits = _fp(hitLeft ? _s.fakePlayerAttackLPortraits : _s.fakePlayerAttackPortraits);
  else if (isThisAllySlash) portraits = _fp(_s.allyHitIsLeft ? _s.fakePlayerKnifeLPortraits : _s.fakePlayerKnifeRPortraits);
  else if (isAllyHit && _fp(_s.fakePlayerHitPortraits)) portraits = _fp(_s.fakePlayerHitPortraits);
  else if (isNearFatal && _fp(_s.fakePlayerKneelPortraits)) portraits = _fp(_s.fakePlayerKneelPortraits);
  else portraits = _fp(_s.fakePlayerPortraits);
  if (!portraits) return;
  if (isAllyAttack) {
    // R-hand back-swing blade goes BEHIND portrait (NES OAM: weapon spr06-09 loses to body spr00-05)
    // L-hand back-swing blade goes IN FRONT (NES OAM: weapon spr00-03 beats body spr04-09)
    if (!hitLeft) {
      const wpnSt = weaponSubtype(ally.weaponId);
      const backX = ppx + 8;
      if (wpnSt === 'knife' && ally.weaponId === 0x1F && _s.battleDaggerBladeCanvas) _s.ctx.drawImage(_s.battleDaggerBladeCanvas, backX, ppy - 7);
      else if (wpnSt === 'knife' && _s.battleKnifeBladeCanvas) _s.ctx.drawImage(_s.battleKnifeBladeCanvas, backX, ppy - 7);
      else if (wpnSt === 'sword' && _s.battleSwordBladeCanvas) _s.ctx.drawImage(_s.battleSwordBladeCanvas, backX, ppy - 7);
    }
  }
  _s.ctx.drawImage(portraits[ally.fadeStep], ppx, ppy);
  if (isAllyAttack) {
    if (hitLeft) {
      const wpnSt = weaponSubtype(ally.weaponL);
      if (wpnSt === 'knife' && ally.weaponL === 0x1F && _s.battleDaggerBladeCanvas) weaponDraws.push({ img: _s.battleDaggerBladeCanvas, x: ppx + 16, y: ppy - 7 });
      else if (wpnSt === 'knife' && _s.battleKnifeBladeCanvas) weaponDraws.push({ img: _s.battleKnifeBladeCanvas, x: ppx + 16, y: ppy - 7 });
      else if (wpnSt === 'sword' && _s.battleSwordBladeCanvas) weaponDraws.push({ img: _s.battleSwordBladeCanvas, x: ppx + 16, y: ppy - 7 });
    }
  }
  if (isThisAllySlash) {
    const activeWpnId = _s.allyHitIsLeft ? ally.weaponL : ally.weaponId;
    const wpnSt = weaponSubtype(activeWpnId);
    if (wpnSt === 'knife' && activeWpnId === 0x1F && _s.battleDaggerBladeSwungCanvas) weaponDraws.push({ img: _s.battleDaggerBladeSwungCanvas, x: ppx - 16, y: ppy + 1 });
    else if (wpnSt === 'knife' && _s.battleKnifeBladeSwungCanvas) weaponDraws.push({ img: _s.battleKnifeBladeSwungCanvas, x: ppx - 16, y: ppy + 1 });
    else if (wpnSt === 'sword' && _s.battleSwordBladeSwungCanvas) weaponDraws.push({ img: _s.battleSwordBladeSwungCanvas, x: ppx - 16, y: ppy + 1 });
    else if (_s.battleFistCanvas) weaponDraws.push({ img: _s.battleFistCanvas, x: ppx - 4, y: ppy + 10 });
  }
  // Near-fatal sweat — 2 frames alternating every 133ms, 3px above portrait
  if (isNearFatal && _s.sweatFrames.length === 2 && !isAllyAttack && !isAllyHit && !isVicPose && !isThisAllySlash) {
    const sweatIdx = Math.floor(Date.now() / 133) & 1;
    _s.ctx.drawImage(_s.sweatFrames[sweatIdx], ppx, ppy - 3);
  }
  // PVP enemy slash overlay on targeted ally during ally-hit — h-flipped (opponent attacks from left)
  if (pvpSt.isPVPBattle && _s.battleState === 'ally-hit' && _s.enemyTargetAllyIdx === i) {
    const eWpnId = pvpSt.pvpCurrentEnemyAllyIdx >= 0
      ? pvpSt.pvpEnemyAllies[pvpSt.pvpCurrentEnemyAllyIdx]?.weaponId
      : pvpSt.pvpOpponentStats?.weaponId;
    const eSlashF = _s.getSlashFramesForWeapon(eWpnId, true);
    const af = Math.min(2, Math.floor(_s.battleTimer / 67));
    if (eSlashF && eSlashF[af]) {
      const sf = eSlashF[af];
      _s.ctx.save();
      _s.ctx.translate(ppx + sf.width + [-0, -10, 8][af], ppy + [0, -6, 8][af]);
      _s.ctx.scale(-1, 1);
      _s.ctx.drawImage(sf, 0, 0);
      _s.ctx.restore();
    }
  }
}
function _drawAllyTexts(i, ally, rowY, isAllyHeal, ppx, ppy, weaponDraws) {
  const namePal = [0x0F, 0x0F, 0x0F, 0x30];
  for (let s = 0; s < ally.fadeStep; s++) namePal[3] = nesColorFade(namePal[3]);
  const nameBytes = _nameToBytes(ally.name);
  drawText(_s.ctx, HUD_RIGHT_X + HUD_RIGHT_W - 8 - measureText(nameBytes), rowY + 8, nameBytes, namePal);
  const panelLeft = HUD_RIGHT_X + 32 + 8;
  drawLvHpRow(_s.ctx, panelLeft, HUD_RIGHT_X + HUD_RIGHT_W - 8, rowY + 16, ally.level || 1, ally.hp, ally.maxHP, ally.fadeStep);
  const dn = _s.allyDamageNums[i];
  if (dn) weaponDraws.push({ type: 'dmg', dn, bx: HUD_RIGHT_X + 20, by: _dmgBounceY(rowY + 16, dn.timer) });
  if (isAllyHeal && _s.cureSparkleFrames.length === 2) {
    weaponDraws.push({ type: 'sparkle', frame: _s.cureSparkleFrames[Math.floor(_s.battleTimer / 67) & 1], px: ppx, py: ppy });
  }
}

function _flushAllyWeaponDraws(weaponDraws) {
  for (const wd of weaponDraws) {
    if (wd.type === 'dmg') {
      const { dn, bx, by } = wd;
      if (dn.miss) {
        const mc = getMissCanvas();
        if (mc) _s.ctx.drawImage(mc, bx - 8, by);
      } else {
        _drawBattleNum(bx, by, dn.value, dn.heal ? HEAL_NUM_PAL : DMG_NUM_PAL);
      }
    } else if (wd.type === 'sparkle') {
      const { frame, px, py } = wd;
      _s.drawSparkleCorners(frame, px, py);
    } else {
      _s.ctx.drawImage(wd.img, wd.x, wd.y);
    }
  }
}

function drawBattleAllies(shared) {
  _s = shared;
  if (_s.battleAllies.length === 0 || _s.battleState === 'none') return;
  const panelTop = HUD_VIEW_Y + 32;
  const weaponDraws = [];
  _s.ctx.save();
  _s.ctx.beginPath();
  _s.ctx.rect(HUD_RIGHT_X, panelTop, HUD_RIGHT_W, HUD_VIEW_H - 32);
  _s.ctx.clip();
  for (let i = 0; i < _s.battleAllies.length; i++) _drawAllyRow(i, _s.battleAllies[i], panelTop, weaponDraws);
  _s.ctx.restore();
  if (_s.battleState === 'item-target-select' && inputSt.itemTargetType === 'player' && inputSt.itemTargetAllyIndex >= 0 && _s.cursorTileCanvas) {
    _s.ctx.drawImage(_s.cursorTileCanvas, HUD_RIGHT_X - 4, panelTop + inputSt.itemTargetAllyIndex * ROSTER_ROW_H + 12);
  }
  _flushAllyWeaponDraws(weaponDraws);
}

function _encounterMonsterPos(idx) {
  const { sprH: dSprH, row0H, row1H, gridPos } = _encounterGridLayout();
  const safeIdx = idx < gridPos.length ? idx : 0;
  const pos = gridPos[safeIdx];
  const m = _s.encounterMonsters[safeIdx];
  const mc = getMonsterCanvas(m?.monsterId, _s.goblinBattleCanvas);
  const rH = safeIdx < 2 ? (row0H || dSprH) : (row1H || dSprH);
  const mh = mc ? mc.height : rH;
  const mw = mc ? mc.width : 32;
  return { bx: pos.x + mw - 4, baseY: pos.y + rH - 8 };
}
function _drawBossDmgNum() {
  if (!_s.enemyDmgNum || (_s.enemyDefeated && !_s.isRandomEncounter)) return;
  let bx, baseY;
  if (_s.isRandomEncounter && _s.encounterMonsters) {
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
  const by = _dmgBounceY(baseY, _s.enemyDmgNum.timer);
  _s.clipToViewport();
  if (_s.enemyDmgNum.miss) {
    const mc = getMissCanvas();
    if (mc) _s.ctx.drawImage(mc, bx - 8, by);
  } else {
    _drawBattleNum(bx, by, _s.enemyDmgNum.value, DMG_NUM_PAL);
  }
  _s.ctx.restore();
}

function _drawEnemyHealNum() {
  if (!_s.enemyHealNum) return;
  let bx, baseY;
  if (_s.isRandomEncounter && _s.encounterMonsters) {
    ({ bx, baseY } = _encounterMonsterPos(_s.enemyHealNum.index));
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
  const hy = _dmgBounceY(baseY, _s.enemyHealNum.timer);
  _s.clipToViewport();
  _drawBattleNum(bx, hy, _s.enemyHealNum.value, HEAL_NUM_PAL);
  _s.ctx.restore();
}

function _drawBattleNum(bx, by, value, pal) {
  _drawBattleNumCtx(_s.ctx, bx, by, value, pal);
}
function drawDamageNumbers() {
  _drawBossDmgNum();

  // Player damage number — bounces on right side of portrait
  if (_s.playerDamageNum) {
    const px = HUD_RIGHT_X + 20;
    const baseY = HUD_VIEW_Y + 16;
    const py = _dmgBounceY(baseY, _s.playerDamageNum.timer);
    if (_s.playerDamageNum.miss) {
      const mc = getMissCanvas();
      if (mc) _s.ctx.drawImage(mc, px - 8, py);
    } else {
      _drawBattleNum(px, py, _s.playerDamageNum.value, DMG_NUM_PAL);
    }
  }

  // Player heal number — green bounce on right side of portrait during item-use
  if (_s.playerHealNum) {
    const px = HUD_RIGHT_X + 20;
    const baseY = HUD_VIEW_Y + 16;
    const py = _dmgBounceY(baseY, _s.playerHealNum.timer);
    _drawBattleNum(px, py, _s.playerHealNum.value, HEAL_NUM_PAL);
  }

  _drawEnemyHealNum();
}

export { drawBattle, drawBattleAllies, drawSWExplosion, drawSWDamageNumbers };
