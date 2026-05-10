// Battle drawing functions — extracted from game.js (pure rendering, no state mutation except critFlashTimer)

import { battleSt, getEnemyHP, setEnemyHP } from './battle-state.js';
import { drawText, measureText, TEXT_WHITE } from './font-renderer.js';
import { nesColorFade, _makeFadedPal } from './palette.js';
import { _dmgBounceY } from './data/animation-tables.js';
import { DMG_NUM_PAL, HEAL_NUM_PAL, drawBattleNum as _drawBattleNumCtx, getMissCanvas } from './damage-numbers.js';
import { getBossBattleCanvas } from './boss-sprites.js';
import { getMonsterCanvas } from './monster-sprites.js';
import { encounterGridLayout, pvpEnemyCellCenterLocal } from './battle-grid.js';
import { drawEncounterBox, drawBossSpriteBox } from './battle-draw-encounter.js';
import { SPELLS } from './data/spells.js';
import { weaponSubtype, isWeapon } from './data/items.js';
import { PLAYER_PALETTES, MONK_PALETTES, BLACK_MAGE_PALETTES, RED_MAGE_PALETTES } from './data/players.js';
import { pickAttackPoseKey, pickAttackWeaponSpec, attackWeaponLayer, pickCombatantBody } from './combatant-pose.js';

// Player canvas pool fallback chain (player pool collapses knife back/fwd into one canvas).
const PLAYER_POSE_FALLBACK = { rFwd: 'rBack', lFwd: 'lBack', knifeRFwd: 'knifeR', knifeLFwd: 'knifeL' };
function _playerPoseCanvas(p, key) {
  return p[key] || (PLAYER_POSE_FALLBACK[key] && p[PLAYER_POSE_FALLBACK[key]]) || null;
}

function _jobPalette(jobIdx, palIdx) {
  const pool = jobIdx === 2 ? MONK_PALETTES
             : jobIdx === 4 ? BLACK_MAGE_PALETTES
             : jobIdx === 5 ? RED_MAGE_PALETTES
             : PLAYER_PALETTES;
  return pool[palIdx] || pool[0];
}

import { ps, getHitWeapon, isHitRightHand } from './player-stats.js';
import { _nameToBytes, _buildItemRowBytes, drawLvHpRow } from './text-utils.js';
import { pvpSt } from './pvp.js';
import { inputSt } from './input-handler.js';
import { bsc, getSlashFramesForWeapon } from './battle-sprite-cache.js';
import { drawSlashOverlay } from './slash-effects.js';
import { getCastAnimElapsedMs, getCurrentSpellId, getSpellTargets, getSpellHitIdx, isCurrentCastItemUse, getMagicHitPhase } from './spell-cast.js';
import { drawCasterCastBehind, drawCasterCastFront,
         jobToCastKey, CAST_T_LUNGE, CAST_T_HEAL, CAST_T_RETURN, CAST_PHASE_MS,
         CAST_T_THROW_PROJ_START, CAST_T_THROW_IMPACT_START, CAST_T_THROW_RETURN,
         CAST_PHASE_MS_THROW } from './cast-anim.js';
import { drawCastWindup, drawSpellThrow } from './combatant-cast.js';
import { drawBattleMenu, drawVictoryBox } from './battle-draw-menu.js';
import { getSpellAnim, getSpellAnimForItem, getSpellAnimFrame } from './spell-anim.js';
import { getProjectileTile } from './projectile-anim.js';
import { hudSt } from './hud-state.js';
import { fakePlayerPortraits, fakePlayerVictoryPortraits, fakePlayerHitPortraits,
         fakePlayerKneelPortraits, fakePlayerAttackPortraits, fakePlayerAttackLPortraits,
         fakePlayerKnifeRPortraits, fakePlayerKnifeLPortraits,
         fakePlayerKnifeRFwdPortraits, fakePlayerKnifeLFwdPortraits,
         fakePlayerDeathPoseCanvases } from './fake-player-sprites.js';
import { getAllyDamageNums, getEnemyDmgNum, getPlayerDamageNum, getPlayerHealNum, getEnemyHealNum,
         getSwDmgNums } from './damage-numbers.js';
import { getBattleMsgCurrent, getBattleMsgTimer, computeMsgTimings,
         MSG_FADE_IN_MS, MSG_FADE_OUT_MS,
         MSG_STRIP_X, MSG_STRIP_Y, MSG_STRIP_W,
         MSG_SCROLL_PAUSE_MS, MSG_SCROLL_SPEED_PX_MS } from './battle-msg.js';
// (weapon canvas selection moved to combatant-pose.js — pickAttackWeaponSpec handles all blade/fist getters)
import { clipToViewport, drawHudBox, drawSparkleCorners, drawBorderedBox,
         grayViewport } from './hud-drawing.js';
import { ui } from './ui-state.js';
import { isVictoryBattleState as _isVictoryBattleState } from './battle-update.js';

function _cursorTileCanvas() { return ui.cursorTileCanvas; }

const HUD_VIEW_X = 0, HUD_VIEW_Y = 32, HUD_VIEW_W = 144, HUD_VIEW_H = 144;
const HUD_RIGHT_X = 144, HUD_RIGHT_W = 112;
const CANVAS_W = 256;
const ROSTER_ROW_H = 32;

// (Ally portrait pose map moved to combatant-pose.js — `pickCombatantBody('ally', ...)`
//  is the single source of truth for both ally portraits and opp full-bodies as of v1.7.161.)
const BATTLE_TEXT_STEPS = 4;
const BATTLE_FLASH_FRAME_MS = 16.67;
const BOSS_PREFLASH_MS = 133;
const BOSS_BLOCK_SIZE = 16;
const BOSS_BLOCK_COLS = 3;
const BOSS_BLOCKS = 9;
const BOSS_DISSOLVE_STEPS = 8;
const BOSS_DISSOLVE_FRAME_MS = 16.67;
const MONSTER_DEATH_MS = 250;
const MONSTER_SLIDE_MS = 267;
// SLASH_FRAME_MS imported from slash-effects.js (single source of truth — pre-1.7.4
// this was 50 here vs 30 in battle-update.js, which made ally `af` sprite-frame
// indexing lag the state machine).
const SLASH_FRAMES = 3;
const DEFEND_SPARKLE_FRAME_MS = 133;


function drawSWExplosion() {
  // PVP opponent South Wind — explosion centered on current target (player or ally)
  if (!pvpSt.isPVPBattle || battleSt.battleState !== 'pvp-opp-sw-hit' || battleSt.battleTimer >= 400) return;
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
}

function drawSWDamageNumbers() {
  if (battleSt.battleState !== 'magic-hit' && battleSt.battleState !== 'ally-magic-hit') return;
  const mc = getMissCanvas();
  if (pvpSt.isPVPBattle) {
    for (const [k, dn] of Object.entries(getSwDmgNums())) {
      const { x: cx, y: cy } = pvpEnemyCellCenterLocal(parseInt(k));
      const by = _dmgBounceY(cy + 12, dn.timer);
      if (dn.miss && mc) ui.ctx.drawImage(mc, cx + 8 - 8, by - 4);
      else _drawBattleNum(cx + 8, by, dn.value, DMG_NUM_PAL);
    }
    return;
  }
  if (battleSt.isRandomEncounter && battleSt.encounterMonsters) {
    const { count, boxX, boxY, sprH, row0H, row1H, gridPos: swGridPos } = encounterGridLayout();
    for (const [k, dn] of Object.entries(getSwDmgNums())) {
      const idx = parseInt(k);
      if (idx >= swGridPos.length) continue;
      const tp = swGridPos[idx];
      const m = battleSt.encounterMonsters[idx];
      const mcv = getMonsterCanvas(m?.monsterId, battleSt.goblinBattleCanvas);
      const rH = idx < 2 ? (row0H || sprH) : (row1H || sprH);
      const mh = mcv ? mcv.height : rH;
      const mw = mcv ? mcv.width : 32;
      const bx = tp.x + mw - 4;
      const baseY = tp.y + rH - 8;
      const by = _dmgBounceY(baseY, dn.timer);
      if (dn.miss && mc) ui.ctx.drawImage(mc, bx - 8, by - 4);
      else _drawBattleNum(bx, by, dn.value, DMG_NUM_PAL);
    }
  } else {
    // Boss — damage number on bottom-right of boss sprite
    const bc = getBossBattleCanvas();
    const bw = bc ? bc.width : 48;
    const bh = bc ? bc.height : 48;
    for (const [k, dn] of Object.entries(getSwDmgNums())) {
      const bx = HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2) + Math.floor(bw / 2) - 4;
      const baseY = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2) + Math.floor(bh / 2) - 8;
      const by = _dmgBounceY(baseY, dn.timer);
      if (dn.miss && mc) ui.ctx.drawImage(mc, bx - 8, by - 4);
      else _drawBattleNum(bx, by, dn.value, DMG_NUM_PAL);
    }
  }
}

// Pick the right on-target sparkle frames for an item being used. Routes via
// the item's declared `animSpellId` through spell-anim.js; items whose spell
// animation hasn't been captured yet fall back to the legacy 4-corner Cure
// sparkle from sprite-init.js.
function _itemSparkleFrames(itemId) {
  const bundle = getSpellAnimForItem(itemId);
  if (bundle && bundle.frames && bundle.frames.length === 2) return bundle.frames;
  return bsc.cureSparkleFrames && bsc.cureSparkleFrames.length === 2 ? bsc.cureSparkleFrames : null;
}

function _getPortraitSrc(isNearFatal, isAttackPose, isHitPose, isDefendPose, isItemUsePose, isVictoryPose) {
  const hasActiveStatus = ps.status && ps.status.mask !== 0;
  const p = bsc.battlePoses;
  let src = ((isNearFatal || hasActiveStatus) && p.kneel) ? p.kneel : p.idle;
  if (isAttackPose) {
    const _wpn = getHitWeapon(battleSt.currentHitIdx, inputSt.rHandHitCount);
    const rh = isHitRightHand(battleSt.currentHitIdx, inputSt.rHandHitCount);
    // Idle pose held only at hand change (R→L or L→R) during attack-back, so the new
    // hand's swing reads as a fresh strike. Same-hand subsequent hits stay in back-swing.
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
    // Body-group wiggle (applied at the parent draw site for fist-only player-slash)
    // already shifts px/py — fist sprite follows the body, no extra wiggle here.
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
  // Cast FRONT pass — drawn AFTER the portrait. WM = rotating stars +
  // flame on left; BM = spark on left ("by the hand"). The behind-pass
  // (BM halo only) runs in `_drawBattlePortrait` BEFORE the portrait draw.
  const isMagicState = battleSt.battleState === 'magic-cast' || battleSt.battleState === 'magic-hit';
  const isCureItemUse = battleSt.battleState === 'item-use' && !(inputSt.playerActionPending && inputSt.playerActionPending.allyIndex >= 0);
  const _curSpellTargets = isMagicState ? getSpellTargets() : null;
  const isCureMagicSelf = isMagicState && _curSpellTargets &&
    _curSpellTargets.some(t => t && t.type === 'player');
  const cureMs = isMagicState ? getCastAnimElapsedMs() : -1;
  // Cast windup FRONT — single entry point shared with ally + PVP enemy.
  // `combatant-cast.js:drawCastWindup` resolves state per role (player here
  // means engine-tracked elapsed via getCastAnimElapsedMs).
  drawCastWindup('front', ui.ctx, 'player', 0, px + 8, py + 8);
  // On-target sparkle — per-spell visual on the target portrait during heal
  // phase. Items route by `item.animSpellId` through spell-anim.
  const _sparkleFi = Math.floor(battleSt.battleTimer / 67) & 1;
  if (isCureItemUse) {
    const _frames = _itemSparkleFrames(inputSt.playerActionPending?.itemId);
    if (_frames && _frames.length === 2) ui.ctx.drawImage(_frames[_sparkleFi], px, py);
  }
  if (isCureMagicSelf && cureMs >= CAST_T_HEAL && cureMs < CAST_T_RETURN) {
    const _bundle = getSpellAnim(getCurrentSpellId());
    if (_bundle && _bundle.kind === 'portrait-2frame') {
      ui.ctx.drawImage(_bundle.frames[_sparkleFi], px, py);
    }
  }
  // Ally-cast magic OR item on player. The ally-item AI sets allyMagicSpellId
  // to a sentinel (0x34 Cure for potion, 0x35 Poisona for antidote) so the
  // per-spell-id lookup picks the correct frames for both modes.
  const isAllyHealOnPlayer = battleSt.battleState === 'ally-magic-hit'
    && battleSt.allyMagicTargetType === 'player'
    && battleSt.allyMagicEffectApplied;
  if (isAllyHealOnPlayer) {
    const _allyBundle = getSpellAnim(battleSt.allyMagicSpellId);
    const _frames = (_allyBundle && _allyBundle.kind === 'portrait-2frame')
      ? _allyBundle.frames : bsc.cureSparkleFrames;
    if (_frames && _frames.length === 2) {
      ui.ctx.drawImage(_frames[_sparkleFi], px, py);
    }
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
  // Status sprite above portrait — show highest priority active status.
  drawStatusSpriteAbove(ui.ctx, ps.status, px, py - 4);
  // Item target cursor on player portrait. Single-target: solid cursor when
  // the player slot is picked. All-allies: blink (133 ms, same cadence as the
  // encounter all/col cursors) on every ally including the player.
  if (battleSt.battleState === 'item-target-select' && inputSt.itemTargetType === 'player' && _cursorTileCanvas()) {
    const isAll = inputSt.itemTargetMode !== 'single';
    const showSingle = !isAll && inputSt.itemTargetAllyIndex < 0;
    const showAll = isAll && (Math.floor(Date.now() / 133) & 1);
    if (showSingle || showAll) ui.ctx.drawImage(_cursorTileCanvas(), px - 12, py + 4);
  }
  // Enemy slash effect on player portrait during PVP melee attack swing.
  // Skip when the opponent is targeting an ally — the slash gets drawn on that ally's portrait instead (see _drawAllyPortrait).
  // Hit/miss gating is enforced inside drawSlashOverlay via the `hit` opt (single source).
  if (battleSt.battleState === 'pvp-enemy-slash' && battleSt.enemyTargetAllyIdx < 0) {
    const eWpnId = pvpSt.pvpCurrentEnemyAllyIdx >= 0
      ? pvpSt.pvpEnemyAllies[pvpSt.pvpCurrentEnemyAllyIdx]?.weaponId
      : pvpSt.pvpOpponentStats?.weaponId;
    const eSlashF = getSlashFramesForWeapon(eWpnId, true);
    const af = Math.min(2, Math.floor(battleSt.battleTimer / 67));
    drawSlashOverlay(ui.ctx, eSlashF && eSlashF[af], af, px, py, { mirror: true, weaponId: eWpnId || 0, hit: pvpSt.pvpPendingAttack });
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
    (battleSt.battleState === 'pvp-enemy-slash' && battleSt.enemyTargetAllyIdx < 0 && pvpSt.pvpPendingAttack && !pvpSt.pvpPendingAttack.miss && !pvpSt.pvpPendingAttack.shieldBlock);
  const isDefendPose = battleSt.battleState === 'defend-anim';
  const isItemUsePose = battleSt.battleState === 'item-use' || battleSt.battleState === 'magic-cast' || battleSt.battleState === 'magic-hit';
  const isRunPose = battleSt.battleState === 'run-success';
  const isNearFatal = ps.hp > 0 && ps.stats && ps.hp <= Math.floor(ps.stats.maxHP / 4);
  const portraitSrc = _getPortraitSrc(isNearFatal, isAttackPose, isHitPose, isDefendPose, isItemUsePose, isVictoryPose);
  if (!portraitSrc) return;
  // Fist impact wiggle — whole body (incl. fist sprite) jitters ±1 px x at ~30ms
  // cadence during a fist's player-slash. Matches the NES OAM trace where the
  // entire Monk body group origin alternates 180/181 between impact frames.
  // Only fires when this hit is unarmed; bladed strikes hold rock-steady.
  let bodyWiggleX = 0;
  if (battleSt.battleState === 'player-slash' &&
      getHitWeapon(battleSt.currentHitIdx, inputSt.rHandHitCount) === 0) {
    bodyWiggleX = (Math.floor(battleSt.battleTimer / 33) & 1) ? 1 : -1;
  }
  const pxs = px + shakeOff + bodyWiggleX;
  // Blink portrait when enemy slash is landing (mirrors opponent blink on player hit)
  const portraitBlink = battleSt.battleState === 'pvp-enemy-slash' &&
    battleSt.enemyTargetAllyIdx < 0 &&
    pvpSt.pvpPendingAttack && !pvpSt.pvpPendingAttack.miss && !pvpSt.pvpPendingAttack.shieldBlock &&
    (Math.floor(battleSt.battleTimer / 60) & 1);
  // Cast windup BEHIND — single entry point shared with ally + PVP enemy.
  drawCastWindup('behind', ui.ctx, 'player', 0, pxs + 8, py + 8);
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
  // 67ms = ~4 frames at 60fps. 17ms (1 frame) was below the perceptual floor —
  // crits felt invisible. 67ms registers as a deliberate flash without strobing.
  if (Date.now() - battleSt.critFlashTimer < 67) {
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
function drawBattle() {
  if (battleSt.battleState === 'none') return;
  _drawBattleCritFlash();
  _drawBattlePortrait();
  _drawBattleStrobeFlash();
  drawEncounterBox();
  drawBossSpriteBox();
  _drawPlayerSpellTargetSparkleOnEnemy();
  _drawPVPEnemyOffensiveCast();
  _drawAllyOffensiveCast();
  drawBattleMenu();
  drawVictoryBox();
  drawBattleMessageStrip();
  drawDamageNumbers();
}

// ── Centralized magic render helpers ─────────────────────────────────────
//
// These are the SINGLE source of truth for cast / projectile / on-target
// rendering during magic-cast / magic-hit phases. All three render paths
// (player, ally, PVP enemy) call into them so adding a new spell or
// adjusting a phase only requires editing one site.
//
// Faction-axis projectile rule (the user's standing rule): a projectile
// renders only when caster.faction !== target.faction (cross-faction).
// Same-faction casts (heal on self, ally) skip the projectile and jump
// straight to the on-target effect.

// Cast render helpers `drawCasterCastBehind` / `drawCasterCastFront` are
// imported from cast-anim.js — single source of truth, no per-render-site
// reimplementation. Called below by player + ally + (PVP via pvp.js).

// Status overlay — single source for the 16×8 status sprite drawn above a
// combatant's body. Player + roster ally + PVP enemy all route here so the
// priority order, frame cadence, and tile cache lookup live in one place.
//
// Priority order: petrify > sleep > confuse > paralysis > silence > blind > poison.
// Highest-priority active flag wins; lower flags don't draw concurrently.
//
// `mirror=true` h-flips the sprite around its 16-px width — used for PVP
// enemy bodies (which face right, opposite the player party). Status sprite
// tiles are asymmetric (the sleep "Z"s are slanted), so PVP must flip to
// match the body orientation.
const _STATUS_PRIO = [0x40, 0x100, 0x200, 0x01, 0x10, 0x04, 0x02];
export function drawStatusSpriteAbove(ctx, statusObj, x, y, mirror = false) {
  if (!statusObj || !statusObj.mask || !bsc.statusSpriteMap) return;
  for (const flag of _STATUS_PRIO) {
    if (!(statusObj.mask & flag)) continue;
    const frames = bsc.statusSpriteMap.get(flag);
    if (!frames || frames.length !== 2) return;
    const f = frames[Math.floor(Date.now() / 133) & 1];
    if (mirror) {
      ctx.save();
      ctx.translate(x + f.width, y);
      ctx.scale(-1, 1);
      ctx.drawImage(f, 0, 0);
      ctx.restore();
    } else {
      ctx.drawImage(f, x, y);
    }
    return;
  }
}

// Resolve the (x, y) center of a magic target. Used by the projectile fan
// and on-target effect helpers. Returns null if the target can't be
// resolved (dead enemy, missing layout data).
function _getMagicTargetCenter(tgt) {
  if (!tgt) return null;
  if (tgt.type === 'player') {
    return { x: HUD_RIGHT_X + 8 + 8, y: HUD_VIEW_Y + 8 + 8 };
  }
  if (tgt.type === 'ally') {
    const panelTop = HUD_VIEW_Y + 32;
    const ppy = panelTop + tgt.index * ROSTER_ROW_H + 8;
    return { x: HUD_RIGHT_X + 8 + 8, y: ppy + 8 };
  }
  // tgt.type === 'enemy'
  if (battleSt.isRandomEncounter && battleSt.encounterMonsters) {
    const m = battleSt.encounterMonsters[tgt.index];
    if (!m) return null;
    const { sprH, row0H, row1H, gridPos } = encounterGridLayout();
    if (tgt.index >= gridPos.length) return null;
    const pos = gridPos[tgt.index];
    const mc = getMonsterCanvas(m.monsterId, battleSt.goblinBattleCanvas);
    const mw = mc ? mc.width : 32;
    const mh = mc ? mc.height : sprH;
    const rH = tgt.index < 2 ? (row0H || sprH) : (row1H || sprH);
    return {
      x: pos.x + Math.floor(mw / 2),
      y: pos.y + (rH - mh) + Math.floor(mh / 2),
    };
  }
  if (pvpSt.isPVPBattle) {
    // pvpEnemyCellCenter returns the 24×32 CELL center; the body inside is
    // 16×24 starting 4 px from cell top, so body center is 4 px below cell
    // center. Aim the projectile + burst at body center for vertical
    // alignment with the PVP-side cast halo (which centers on the body).
    const { x, y } = pvpEnemyCellCenterLocal(tgt.index);
    return { x, y: y + 4 };
  }
  // Boss
  return {
    x: HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2),
    y: HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2),
  };
}

// Caster faction: player + ally = 'party'; pvp-enemy + encounter-enemy = 'foe'.
// Same-faction caster→target skips projectile.
function _isCrossFaction(casterFaction, tgt) {
  if (!tgt) return false;
  const tgtFaction = (tgt.type === 'enemy') ? 'foe' : 'party';
  return casterFaction !== tgtFaction;
}

// Draw a projectile fan-out from caster center to each target center.
// Renders ONLY for cross-faction targets (same-faction targets render no
// projectile per the user's standing rule). The $58 tile has a directional
// trailing flame — canonical capture is right→left (player→enemy), so we
// auto-h-flip when the projectile travels left→right (e.g. a PVP enemy
// casting toward the player party). Per-target hflip means a multi-target
// fan can mix directions if the layout demands.
export function drawProjectileFan(ctx, sx, sy, casterFaction, targets, spellId, spell, t01) {
  if (t01 < 0 || t01 > 1) return;
  for (const tgt of targets) {
    if (!_isCrossFaction(casterFaction, tgt)) continue;
    const tc = _getMagicTargetCenter(tgt);
    if (!tc) continue;
    const hflip = sx < tc.x;
    const tile = getProjectileTile(spellId, spell, hflip);
    if (!tile) continue;
    const x = sx + (tc.x - sx) * t01;
    const y = sy + (tc.y - sy) * t01;
    ctx.drawImage(tile, Math.round(x - 4), Math.round(y - 4));
  }
}

// Draw the on-target spell-anim effect at every target. Bundles can be
// 'portrait-2frame' (16×16, anchored at portrait top-left) or
// 'burst-strip-2frame' (variable size, anchored at sprite center).
export function drawSpellEffectAtTargets(ctx, targets, spellId, elapsedMs) {
  const bundle = getSpellAnim(spellId);
  if (!bundle) return;
  const frame = getSpellAnimFrame(bundle, elapsedMs);
  if (!frame) return;
  for (const tgt of targets) {
    const tc = _getMagicTargetCenter(tgt);
    if (!tc) continue;
    if (bundle.kind === 'portrait-2frame') {
      // Portrait-anchored 16×16: draw at (centerX - 8, centerY - 8) which
      // matches portrait top-left (since portrait is 16×16 centered on tc).
      ctx.drawImage(frame, tc.x - 8, tc.y - 8);
    } else if (bundle.kind === 'burst-strip-2frame') {
      ctx.drawImage(frame, tc.x - Math.floor(bundle.width / 2),
                           tc.y - Math.floor(bundle.height / 2));
    } else if (bundle.kind === 'aoe-3phase') {
      // 3-phase expanding burst — each phase has a different canvas size, so
      // center per-frame (frame.width / 2) rather than from the bundle.
      ctx.drawImage(frame, tc.x - Math.floor(frame.width / 2),
                           tc.y - Math.floor(frame.height / 2));
    }
  }
}

// Player-cast magic targeting an enemy — render the projectile fan +
// on-target burst on every cross-faction target. Same-faction targets
// (player-self, ally) render their on-target effect via portrait overlay
// helpers in _drawPortraitOverlays / _drawAllyRow.
// Spell-ID source: getCurrentSpellId() (player-cast). Ally-cast and
// PVP-cast versions read from battleSt.allyMagicSpellId / pvpSt.pvpMagicSpellId
// when offensive magic ships for those paths.
function _drawPlayerSpellTargetSparkleOnEnemy() {
  // All player throw flows (item-use, thrown, heal-style) resolved inside
  // `drawSpellThrow('player', ...)`. Caster = player portrait center.
  const sx = HUD_RIGHT_X + 8 + 8;
  const sy = HUD_VIEW_Y + 8 + 8;
  drawSpellThrow('player', ui.ctx, { x: sx, y: sy, faction: 'party' }, null);
}

// PVP-enemy offensive cast — mirror of `_drawPlayerSpellTargetSparkleOnEnemy`
// for the opposite direction. When a fake-player BM/RM in PVP casts Fire /
// Blizzard / Sleep on the player party, this renders the projectile fan
// (parallel) and impact burst (single target — current AI picks one) using
// the same `drawProjectileFan` + `drawSpellEffectAtTargets` helpers. The
// helpers auto-handle hflip via sx vs tx, so the trailing flame stays
// behind the orb regardless of travel direction.
function _drawPVPEnemyOffensiveCast() {
  if (!pvpSt.isPVPBattle) return;
  if (pvpSt.pvpMagicCasterCellIdx < 0) return;
  if (pvpSt.pvpMagicPartyTargetIdx <= -100) return;
  // Caller resolves caster position + target spec; the shared `drawSpellThrow`
  // helper in combatant-cast.js handles state gating, projectile/impact phase
  // split, spell-anim dispatch.
  const cc = pvpEnemyCellCenterLocal(pvpSt.pvpMagicCasterCellIdx);
  const partyIdx = pvpSt.pvpMagicPartyTargetIdx;
  const target = partyIdx === -1
    ? { type: 'player' }
    : { type: 'ally', index: partyIdx };
  drawSpellThrow('pvp-enemy', ui.ctx, { x: cc.x, y: cc.y, faction: 'foe' }, target);
}

// Roster-ally offensive cast — Fire / Bzzard / Sleep on an encounter monster
// or PVP-enemy cell. Mirror of `_drawPVPEnemyOffensiveCast` for the ally
// caster on the player side. Source = ally portrait center (right column,
// row N); target = `{type:'enemy', index}` which `_getMagicTargetCenter`
// resolves to encounterMonsters[idx] OR pvpEnemyCellCenterLocal(idx) (idx 0 =
// opponent, 1+ = enemy ally idx-1) — same convention used everywhere else.
function _drawAllyOffensiveCast() {
  if (battleSt.allyMagicCasterIdx < 0) return;
  // Caller resolves caster position; shared `drawSpellThrow` does the rest.
  const panelTop = HUD_VIEW_Y + 32;
  const sx = HUD_RIGHT_X + 8 + 8;
  const sy = panelTop + battleSt.allyMagicCasterIdx * ROSTER_ROW_H + 8 + 8;
  const target = { type: 'enemy', index: battleSt.allyMagicTargetIdx };
  drawSpellThrow('ally', ui.ctx, { x: sx, y: sy, faction: 'party' }, target);
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
  const isAllyHealItem = battleSt.battleState === 'item-use' && inputSt.playerActionPending && inputSt.playerActionPending.allyIndex === i;
  // Iterator-based ally-target gate (mirrors the player-self path above).
  // Single-target Cure on this ally: _curSpellTgt = {type:'ally', index:i}.
  // Multi-target Cure: same shape — sparkle walks each ally as _hitIdx ticks.
  const _aMagicState = battleSt.battleState === 'magic-cast' || battleSt.battleState === 'magic-hit';
  const _aTargets = _aMagicState ? getSpellTargets() : null;
  const _aCurTgt = _aTargets && _aTargets.length > 0
    ? _aTargets[Math.min(getSpellHitIdx(), _aTargets.length - 1)] : null;
  const isAllyHealMagic = _aMagicState && _aCurTgt && _aCurTgt.type === 'ally' && _aCurTgt.index === i;
  const _allyCureMs = isAllyHealMagic ? getCastAnimElapsedMs() : -1;
  // For magic, only show heal sparkles during phase 4 (the actual heal moment).
  // Per-school palette pickup mirrors the player path: magic uses the active
  // spell's bundle (`Cure → blue`, `Poisona → magenta`); item-use routes by
  // item.effect (heal → recovery sparkle, cure_status → poisona magenta).
  const _allyMagicBundle = isAllyHealMagic ? getSpellAnim(getCurrentSpellId()) : null;
  const _allyMagicSparkle = isAllyHealMagic && _allyCureMs >= CAST_T_HEAL && _allyCureMs < CAST_T_RETURN
    && _allyMagicBundle && _allyMagicBundle.kind === 'portrait-2frame'
    ? _allyMagicBundle.frames : null;
  const _allyItemSparkle = isAllyHealItem
    ? _itemSparkleFrames(inputSt.playerActionPending?.itemId)
    : null;
  // WM ally cast magic OR item on this ally. The item AI sets allyMagicSpellId
  // to a sentinel (0x34 Cure for potion, 0x35 Poisona for antidote) so the
  // per-spell-id lookup picks the correct target frames for both modes.
  const isAllyHealOnAlly = battleSt.battleState === 'ally-magic-hit'
    && battleSt.allyMagicTargetType === 'ally'
    && battleSt.allyMagicTargetIdx === i
    && battleSt.allyMagicEffectApplied;
  let _allyAllyCureSparkle = null;
  if (isAllyHealOnAlly) {
    const _aaBundle = getSpellAnim(battleSt.allyMagicSpellId);
    _allyAllyCureSparkle = (_aaBundle && _aaBundle.kind === 'portrait-2frame')
      ? _aaBundle.frames
      : (bsc.cureSparkleFrames.length === 2 ? bsc.cureSparkleFrames : null);
  }
  const _allyHealSparkleSet = _allyMagicSparkle || _allyItemSparkle || _allyAllyCureSparkle;
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
  _drawAllyTexts(i, ally, rowY, _allyHealSparkleSet, ppx, ppy, weaponDraws);
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
  // WM caster pose during ally-magic-cast / ally-magic-hit — same arm-up pose as
  // victory/defend/magic. Held steady (no flicker) for the full cast duration.
  const isAllyCastingMagic = (battleSt.battleState === 'ally-magic-cast' || battleSt.battleState === 'ally-magic-hit')
    && battleSt.allyMagicCasterIdx === i;
  if (isAllyCastingMagic && _fp(fakePlayerVictoryPortraits)) {
    portraits = _fp(fakePlayerVictoryPortraits);
  } else if (isVicPose && (Math.floor(Date.now() / 250) & 1) && _fp(fakePlayerVictoryPortraits)) {
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
    portraits = pickCombatantBody('ally', key, _j, ally.palIdx);
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
  // Cast windup — same `drawCastWindup` helper player uses. Behind portrait
  // for halo, after portrait for stars/flame. Identical call shape; only the
  // role + idx differ.
  drawCastWindup('behind', ui.ctx, 'ally', i, ppx + 8, ppy + 8);
  ui.ctx.drawImage(portraits[ally.fadeStep], ppx, ppy);
  drawCastWindup('front', ui.ctx, 'ally', i, ppx + 8, ppy + 8);
  // Near-fatal sweat — 2 frames alternating every 133ms, 3px above portrait
  if (isNearFatal && bsc.sweatFrames.length === 2 && !isAllyAttack && !isAllyHit && !isVicPose && !isThisAllySlash) {
    const sweatIdx = Math.floor(Date.now() / 133) & 1;
    ui.ctx.drawImage(bsc.sweatFrames[sweatIdx], ppx, ppy - 3);
  }
  // Status sprite — same priority + cadence as the player portrait. Allies
  // face left like the player, so no mirror.
  drawStatusSpriteAbove(ui.ctx, ally.status, ppx, ppy - 4);
  // PVP enemy slash overlay on targeted ally — h-flipped (opponent attacks from left).
  // Fires per-hit during the multi-hit pvp-enemy-slash combo, plus the final ally-hit shake state.
  if (pvpSt.isPVPBattle && battleSt.enemyTargetAllyIdx === i &&
      (battleSt.battleState === 'pvp-enemy-slash' || battleSt.battleState === 'ally-hit')) {
    const eWpnId = pvpSt.pvpCurrentEnemyAllyIdx >= 0
      ? pvpSt.pvpEnemyAllies[pvpSt.pvpCurrentEnemyAllyIdx]?.weaponId
      : pvpSt.pvpOpponentStats?.weaponId;
    const eSlashF = getSlashFramesForWeapon(eWpnId, true);
    const af = Math.min(2, Math.floor(battleSt.battleTimer / 67));
    drawSlashOverlay(ui.ctx, eSlashF && eSlashF[af], af, ppx, ppy, { mirror: true, weaponId: eWpnId || 0, hit: pvpSt.pvpPendingAttack });
  }
}
function _drawAllyTexts(i, ally, rowY, healSparkleSet, ppx, ppy, weaponDraws) {
  const namePal = [0x0F, 0x0F, 0x0F, 0x30];
  for (let s = 0; s < ally.fadeStep; s++) namePal[3] = nesColorFade(namePal[3]);
  const nameBytes = _nameToBytes(ally.name);
  drawText(ui.ctx, HUD_RIGHT_X + HUD_RIGHT_W - 8 - measureText(nameBytes), rowY + 8, nameBytes, namePal);
  const panelLeft = HUD_RIGHT_X + 32 + 8;
  drawLvHpRow(ui.ctx, panelLeft, HUD_RIGHT_X + HUD_RIGHT_W - 8, rowY + 16, ally.level || 1, ally.hp, ally.maxHP, ally.fadeStep);
  const dn = getAllyDamageNums()[i];
  if (dn) weaponDraws.push({ type: 'dmg', dn, bx: HUD_RIGHT_X + 20, by: _dmgBounceY(rowY + 16, dn.timer) });
  if (healSparkleSet) {
    const fi = Math.floor(battleSt.battleTimer / 67) & 1;
    weaponDraws.push({ type: 'sparkle', frame: healSparkleSet[fi], px: ppx, py: ppy });
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
      // OAM has a single 16×16 sparkle on the target body at [0,5]-[16,13],
      // not a corner-mirrored quadruple — match the captured pattern.
      ui.ctx.drawImage(frame, px, py);
    } else {
      ui.ctx.drawImage(wd.img, wd.x, wd.y);
    }
  }
}

function drawBattleAllies() {
  if (battleSt.battleAllies.length === 0 || battleSt.battleState === 'none') return;
  const panelTop = HUD_VIEW_Y + 32;
  const weaponDraws = [];
  // No global panel clip — matches the player path. `_drawBattlePortrait` runs
  // without a wrapping clip, which is why its inline cast block at line 451
  // works without the BM flame getting cut off. Ally rows now mirror that:
  // each row's content (portrait + cast + weapon + text + status) renders
  // without being constrained to the panel rect. Local clips inside helpers
  // (death-slide phase 1) still apply.
  for (let i = 0; i < battleSt.battleAllies.length; i++) _drawAllyRow(i, battleSt.battleAllies[i], panelTop, weaponDraws);
  if (battleSt.battleState === 'item-target-select' && inputSt.itemTargetType === 'player' && _cursorTileCanvas()) {
    // Single-target ally pick: one solid cursor on the picked row.
    // All-allies: blinking cursor on every living ally (player handled in _drawBattlePortrait).
    if (inputSt.itemTargetMode === 'single' && inputSt.itemTargetAllyIndex >= 0) {
      ui.ctx.drawImage(_cursorTileCanvas(), HUD_RIGHT_X - 4, panelTop + inputSt.itemTargetAllyIndex * ROSTER_ROW_H + 12);
    } else if (inputSt.itemTargetMode !== 'single' && (Math.floor(Date.now() / 133) & 1)) {
      for (let i = 0; i < battleSt.battleAllies.length; i++) {
        const a = battleSt.battleAllies[i];
        if (!a || a.hp <= 0) continue;
        ui.ctx.drawImage(_cursorTileCanvas(), HUD_RIGHT_X - 4, panelTop + i * ROSTER_ROW_H + 12);
      }
    }
  }
  _flushAllyWeaponDraws(weaponDraws);
}

function _encounterMonsterPos(idx) {
  const { sprH: dSprH, row0H, row1H, gridPos } = encounterGridLayout();
  if (gridPos.length === 0) return { bx: 0, baseY: 0 };  // empty layout — caller will draw at (0,0); same guard rail as the other gridPos sites.
  const safeIdx = (idx >= 0 && idx < gridPos.length) ? idx : 0;
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
    const { x: cx, y: cy } = pvpEnemyCellCenterLocal(tidx);
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
    const cellIdx = getEnemyHealNum().index || 0;
    const { x: cx, y: cy } = pvpEnemyCellCenterLocal(cellIdx);
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

// Battle message strip — renders in right panel where chat tabs normally are.
// Layout + timings come from battle-msg.js so update + render share one source.

function drawBattleMessageStrip() {
  const msg = getBattleMsgCurrent();
  if (!msg) return;
  const t = getBattleMsgTimer();
  const { overflow, scrollMs, hold } = computeMsgTimings(msg);
  let fadeStep = 0;
  if (msg.persist && battleSt.battleState === 'victory-text-out') {
    fadeStep = Math.min(Math.floor(battleSt.battleTimer / (MSG_FADE_OUT_MS / BATTLE_TEXT_STEPS)), BATTLE_TEXT_STEPS);
  } else if (t < MSG_FADE_IN_MS) {
    fadeStep = BATTLE_TEXT_STEPS - Math.min(Math.floor(t / (MSG_FADE_IN_MS / BATTLE_TEXT_STEPS)), BATTLE_TEXT_STEPS);
  } else if (msg.waitForZ || msg.persist || t < MSG_FADE_IN_MS + hold) {
    fadeStep = 0; // waitForZ/persist: stay solid after fade-in
  } else {
    fadeStep = Math.min(Math.floor((t - MSG_FADE_IN_MS - hold) / (MSG_FADE_OUT_MS / BATTLE_TEXT_STEPS)), BATTLE_TEXT_STEPS);
  }
  if (fadeStep >= BATTLE_TEXT_STEPS) return;
  const pal = _makeFadedPal(fadeStep);
  const y = MSG_STRIP_Y + 4;
  if (overflow === 0) {
    drawText(ui.ctx, MSG_STRIP_X, y, msg.bytes, pal);
  } else {
    const holdT = t - MSG_FADE_IN_MS;
    let scrollX = 0;
    if (holdT < MSG_SCROLL_PAUSE_MS) scrollX = 0;
    else if (holdT < MSG_SCROLL_PAUSE_MS + scrollMs) scrollX = (holdT - MSG_SCROLL_PAUSE_MS) * MSG_SCROLL_SPEED_PX_MS;
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
