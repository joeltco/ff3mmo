// Player portrait drawing — extracted from battle-drawing.js v1.7.186.
//
// Owns the player's left-side portrait + everything that overlays it: pose
// resolution (idle/attack/hit/defend/victory/run/death), weapon overlays
// (front + behind), per-spell heal sparkle, status icons, near-fatal sweat,
// PVP enemy slash overlay, item-target cursor, run-away slide, kneel-slide
// death animation, crit/strobe full-viewport flashes. Pure rendering — no
// state mutation. Outside callers: `drawBattlePortrait`,
// `drawBattleCritFlash`, `drawBattleStrobeFlash` invoked from `drawBattle`
// in `battle-drawing.js`.

import { battleSt, DEATH_SLIDE_MS, DEATH_TXTFADE_MS, DEATH_POSEFADE_MS, DEATH_TOTAL_MS } from './battle-state.js';
import { _dmgBounceY } from './data/animation-tables.js';
import { weaponSubtype } from './data/items.js';
import { pickAttackPoseKey, pickAttackWeaponSpec, attackWeaponLayer } from './combatant-pose.js';
import { ps, getHitWeapon, isHitRightHand } from './player-stats.js';
import { pvpSt } from './pvp.js';
import { inputSt } from './input-handler.js';
import { bsc, getSlashFramesForWeapon } from './battle-sprite-cache.js';
import { drawSlashOverlay } from './slash-effects.js';
import { getCastAnimElapsedMs, getCurrentSpellId, getSpellTargets } from './spell-cast.js';
import { CAST_T_HEAL_ANIM_START, CAST_T_HEAL_ANIM_END, CAST_PHASE_MS_HEAL } from './cast-anim.js';
import { drawCastWindup } from './combatant-cast.js';
import { getSpellAnim } from './spell-anim.js';
import { hudSt } from './hud-state.js';
import { fakePlayerDeathPoseCanvases } from './fake-player-sprites.js';
import { getPlayerDamageNum } from './damage-numbers.js';
import { ui } from './ui-state.js';
import { isVictoryBattleState } from './battle-update.js';
import { clipToViewport, drawSparkleCorners, grayViewport } from './hud-drawing.js';
// Shared helpers re-imported from battle-drawing.js — same circular shape that
// works for the menu/encounter/ally splits. `_itemSparkleFrames` is also used
// by the ally module; `drawStatusSpriteAbove` is used by both ally and player.
import { _itemSparkleFrames, drawStatusSpriteAbove } from './battle-drawing.js';
import { isFenixReviving, fenixRevivePhase, fenixRiseProgress, fenixAngelFrame, fenixAngelProgress } from './battle-fenix-revive.js';
import { getReviveAngelFrames } from './data/revive-angel-sprite.js';

// ── Layout constants (match battle-drawing.js) ────────────────────────────
const HUD_VIEW_X = 0, HUD_VIEW_Y = 32, HUD_VIEW_W = 144, HUD_VIEW_H = 144;
const HUD_RIGHT_X = 144, HUD_RIGHT_W = 112;
const BATTLE_FLASH_FRAME_MS = 16.67;
const DEFEND_SPARKLE_FRAME_MS = 133;

function _cursorTileCanvas() { return ui.cursorTileCanvas; }

// ── Player canvas pool fallback chain ─────────────────────────────────────
// (player pool collapses knife back/fwd into one canvas)
const PLAYER_POSE_FALLBACK = { rFwd: 'rBack', lFwd: 'lBack', knifeRFwd: 'knifeR', knifeLFwd: 'knifeL' };
function _playerPoseCanvas(p, key) {
  return p[key] || (PLAYER_POSE_FALLBACK[key] && p[PLAYER_POSE_FALLBACK[key]]) || null;
}

// Death-animation constants now imported from battle-state.js (single source).

// ── Pose source resolution ────────────────────────────────────────────────

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
  if (isCureMagicSelf && cureMs >= CAST_T_HEAL_ANIM_START && cureMs < CAST_T_HEAL_ANIM_END) {
    const _bundle = getSpellAnim(getCurrentSpellId());
    if (_bundle && _bundle.kind === 'portrait-2frame') {
      ui.ctx.drawImage(_bundle.frames[_sparkleFi], px, py);
    }
  }
  // Ally-cast magic OR item on player. The ally-item AI sets allyMagicSpellId
  // to a sentinel (0x34 Cure for potion, 0x35 Poisona for antidote) so the
  // per-spell-id lookup picks the correct frames for both modes.
  //
  // Sparkle window is time-based (preImpactGap..preImpactGap+impact within
  // ally-magic-hit) — NOT gated on `allyMagicEffectApplied` anymore. Apply
  // happens AFTER the sparkle ends + postImpactGap, so the heal number bounces
  // sequentially rather than overlapping the spell anim.
  const _allyHealAnimStart = CAST_PHASE_MS_HEAL.preImpactGap;
  const _allyHealAnimEnd   = _allyHealAnimStart + CAST_PHASE_MS_HEAL.impact;
  const isAllyHealOnPlayer = battleSt.battleState === 'ally-magic-hit'
    && battleSt.allyMagicTargetType === 'player'
    && battleSt.battleTimer >= _allyHealAnimStart
    && battleSt.battleTimer < _allyHealAnimEnd;
  if (isAllyHealOnPlayer) {
    const _allyBundle = getSpellAnim(battleSt.allyMagicSpellId);
    const _frames = (_allyBundle && _allyBundle.kind === 'portrait-2frame')
      ? _allyBundle.frames : bsc.cureSparkleFrames;
    if (_frames && _frames.length === 2) {
      ui.ctx.drawImage(_frames[_sparkleFi], px, py);
    }
  }
  // Near-fatal sweat — 2 frames alternating every 133ms, 3px above portrait.
  // Suppressed when an active status would render its icon in the same
  // space (status sprite priority, v1.7.209).
  const playerHasActiveStatus = ps.status && ps.status.mask !== 0;
  if (isNearFatal && bsc.sweatFrames.length === 2 && !isAttackPose && !isHitPose && !isVictoryPose && !isDefendPose && !isItemUsePose && !playerHasActiveStatus) {
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

// ── Player portrait entry ─────────────────────────────────────────────────

export function drawBattlePortrait() {
  const px = HUD_RIGHT_X + 8;
  const py = HUD_VIEW_Y + 8;

  // Player death animation: slide → text fade → death pose fade.
  // FenixDown auto-revive extends this: after the death pose fades in, a revive
  // sparkle plays ('anim' phase), then the death pose fades back OUT while the
  // live portrait rises from the bottom of the slot ('rise' phase).
  if (hudSt.playerDeathTimer != null) {
    const dt = Math.min(hudSt.playerDeathTimer, DEATH_TOTAL_MS);
    const reviving = isFenixReviving();
    const phase = reviving ? fenixRevivePhase() : null;
    const riseT = fenixRiseProgress();

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

    // Phase 3: death pose fades in, centered in the name/HP info box. During a
    // FenixDown 'rise' it fades back out (alpha 1→0) as the portrait rises.
    if (dt >= DEATH_SLIDE_MS + DEATH_TXTFADE_MS) {
      const fadeIn = Math.min((dt - DEATH_SLIDE_MS - DEATH_TXTFADE_MS) / DEATH_POSEFADE_MS, 1);
      const deathAlpha = (phase === 'rise') ? (1 - riseT) : fadeIn;
      const deathCanvas = (fakePlayerDeathPoseCanvases[ps.jobIdx] || fakePlayerDeathPoseCanvases[0])?.[0];
      if (deathCanvas && deathAlpha > 0) {
        ui.ctx.globalAlpha = deathAlpha;
        const dx = HUD_RIGHT_X + HUD_RIGHT_W - 24 - 8;
        const dy = HUD_VIEW_Y + Math.floor((32 - 16) / 2);
        ui.ctx.drawImage(deathCanvas, dx, dy);
        ui.ctx.globalAlpha = 1;
      }
    }

    // FenixDown revive: the angel flaps to the LEFT of the death pose, drifting
    // slightly upward (mirrors FF3's party-death spirit). Captured OAM sprite.
    if (phase === 'angel') {
      const angel = getReviveAngelFrames()[fenixAngelFrame()];
      const dpx = HUD_RIGHT_X + HUD_RIGHT_W - 24 - 8;
      const dpy = HUD_VIEW_Y + Math.floor((32 - 16) / 2);
      const rise = Math.floor(fenixAngelProgress() * 8);
      ui.ctx.drawImage(angel, dpx - 16, dpy - rise);
    }

    // FenixDown revive: live portrait rises from the bottom of the slot.
    if (phase === 'rise' && bsc.battlePoses.idle) {
      ui.ctx.save();
      ui.ctx.beginPath();
      ui.ctx.rect(px, py, 16, 16);
      ui.ctx.clip();
      ui.ctx.globalAlpha = riseT;
      ui.ctx.drawImage(bsc.battlePoses.idle, px, py + Math.floor((1 - riseT) * 16));
      ui.ctx.globalAlpha = 1;
      ui.ctx.restore();
    }
    return;
  }

  // Keep shaking through the FenixDown 'dmg-hold' (seized off enemy-attack, but
  // the hit shake should still read while the damage number holds, before the fall).
  const _dmgHoldShake = isFenixReviving() && fenixRevivePhase() === 'dmg-hold';
  const shakeOff = ((battleSt.battleState === 'enemy-attack' || battleSt.battleState === 'poison-tick' || battleSt.battleState === 'pvp-opp-sw-hit' || _dmgHoldShake) && battleSt.battleShakeTimer > 0)
    ? (Math.floor(battleSt.battleShakeTimer / 67) & 1 ? 2 : -2) : 0;
  const isVictoryPose = isVictoryBattleState();
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

// ── Full-viewport flashes (crit gold flash + boss-strobe) ─────────────────

export function drawBattleCritFlash() {
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
export function drawBattleStrobeFlash() {
  if (battleSt.battleState !== 'flash-strobe') return;
  if (!(Math.floor(battleSt.battleTimer / BATTLE_FLASH_FRAME_MS) & 1)) return;
  clipToViewport();
  grayViewport();
}
