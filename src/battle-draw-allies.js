// Ally roster row drawing — extracted from battle-drawing.js v1.7.185.
//
// Owns the right-hand panel: per-ally portrait, weapon overlays, name + LV/HP
// text, status sprite, cast windup, heal sparkles, death animation (kneel
// slide → text fade → death pose), PVP enemy slash overlay on targeted ally,
// item-target cursors. Pure rendering — no state mutation. Outside callers:
// `drawBattleAllies` invoked from `drawBattle` in `battle-drawing.js` and
// from `game-loop.js` (post-battle visibility window).

import { battleSt, DEATH_SLIDE_MS, DEATH_TXTFADE_MS, DEATH_POSEFADE_MS, DEATH_TOTAL_MS } from './battle-state.js';
import { drawText, measureText } from './font-renderer.js';
import { nesColorFade } from './palette.js';
import { _dmgBounceY } from './data/animation-tables.js';
import { DMG_NUM_PAL, HEAL_NUM_PAL, drawDmgPopup, getAllyDamageNums } from './damage-numbers.js';
import { weaponSubtype, isWeapon } from './data/items.js';
import { isLeftHandHit } from './battle-math.js';
import { pickAttackPoseKey, pickAttackWeaponSpec, attackWeaponLayer, pickCombatantBody } from './combatant-pose.js';
import { inputSt } from './input-handler.js';
import { bsc, getSlashFramesForWeapon } from './battle-sprite-cache.js';
import { drawSlashOverlay } from './slash-effects.js';
import { getCastAnimElapsedMs, getCurrentSpellId, getSpellTargets, getSpellHitIdx } from './spell-cast.js';
import { CAST_T_HEAL_ANIM_START, CAST_T_HEAL_ANIM_END, CAST_PHASE_MS_HEAL } from './cast-anim.js';
import { drawCastWindup } from './combatant-cast.js';
import { getSpellAnim } from './spell-anim.js';
import { fakePlayerPortraits, fakePlayerVictoryPortraits, fakePlayerHitPortraits,
         fakePlayerKneelPortraits, fakePlayerDeathPoseCanvases } from './fake-player-sprites.js';
import { _nameToBytes, drawLvHpRow } from './text-utils.js';
import { pvpSt } from './pvp.js';
import { ui } from './ui-state.js';
import { isVictoryBattleState } from './battle-update.js';
import { drawHudBox } from './hud-drawing.js';
// `_jobPalette`, `_itemSparkleFrames`, `drawStatusSpriteAbove` are defined in
// battle-drawing.js and re-exported back to here. Keeping the same circular
// shape that worked for `drawBattleMenu` etc. — both halves only use the
// imports inside functions, so module-evaluation order doesn't matter.
import { _jobPalette, _itemSparkleFrames, drawStatusSpriteAbove } from './battle-drawing.js';

// ── Layout constants (match battle-drawing.js) ────────────────────────────
const HUD_VIEW_Y = 32;
const HUD_RIGHT_X = 144, HUD_RIGHT_W = 112;
const ROSTER_ROW_H = 32;

// Death-animation constants now imported from battle-state.js (single source).

function _cursorTileCanvas() { return ui.cursorTileCanvas; }

function _drawAllyRow(i, ally, panelTop, weaponDraws) {
  const shakeOff = (battleSt.allyShakeTimer[i] > 0) ? (Math.floor(battleSt.allyShakeTimer[i] / 67) & 1 ? 2 : -2) : 0;
  const rowY = panelTop + i * ROSTER_ROW_H + shakeOff;
  const isVicPose = isVictoryBattleState();
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
  const _allyMagicSparkle = isAllyHealMagic && _allyCureMs >= CAST_T_HEAL_ANIM_START && _allyCureMs < CAST_T_HEAL_ANIM_END
    && _allyMagicBundle && _allyMagicBundle.kind === 'portrait-2frame'
    ? _allyMagicBundle.frames : null;
  const _allyItemSparkle = isAllyHealItem
    ? _itemSparkleFrames(inputSt.playerActionPending?.itemId)
    : null;
  // WM ally cast magic OR item on this ally. The item AI sets allyMagicSpellId
  // to a sentinel (0x34 Cure for potion, 0x35 Poisona for antidote) so the
  // per-spell-id lookup picks the correct target frames for both modes.
  //
  // Sparkle window is time-based (preImpactGap..preImpactGap+impact within
  // ally-magic-hit) — NOT gated on `allyMagicEffectApplied` anymore. Apply
  // happens AFTER the sparkle ends + postImpactGap, so the heal number bounces
  // sequentially rather than overlapping the spell anim.
  const _allyHealAnimStart = CAST_PHASE_MS_HEAL.preImpactGap;
  const _allyHealAnimEnd   = _allyHealAnimStart + CAST_PHASE_MS_HEAL.impact;
  const isAllyHealOnAlly = battleSt.battleState === 'ally-magic-hit'
    && battleSt.allyMagicTargetType === 'ally'
    && battleSt.allyMagicTargetIdx === i
    && battleSt.battleTimer >= _allyHealAnimStart
    && battleSt.battleTimer < _allyHealAnimEnd;
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
  // Mirror the ally-update hand selection (RRLL via `isLeftHandHit`).
  const _allyTotalHits = battleSt.allyHitResults ? battleSt.allyHitResults.length : 0;
  const _allyUpcomingLeft = isLeftHandHit(battleSt.allyHitIdx, _allyTotalHits, _allyRw, _allyLw);
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
  // Kneel pose on near-fatal HP OR active status — matches the player rule
  // at hud-drawing.js (v1.7.209). Previously allies kneeled only on
  // near-fatal, so a Silenced/Blinded ally read as "fine" even though the
  // player counterpart kneels.
  else if ((isNearFatal || (ally.status && ally.status.mask !== 0)) && _fp(fakePlayerKneelPortraits)) portraits = _fp(fakePlayerKneelPortraits);
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
  // Near-fatal sweat — 2 frames alternating every 133ms, 3px above portrait.
  // Suppressed when an active status would render its icon in the same
  // space (status sprite priority, v1.7.209).
  const allyHasActiveStatus = ally.status && ally.status.mask !== 0;
  if (isNearFatal && bsc.sweatFrames.length === 2 && !isAllyAttack && !isAllyHit && !isVicPose && !isThisAllySlash && !allyHasActiveStatus) {
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
  const namePal = [0x0F, 0x30, 0x0F, 0x30];
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
      drawDmgPopup(ui.ctx, dn, bx, by, dn.heal ? HEAL_NUM_PAL : DMG_NUM_PAL);
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

export function drawBattleAllies() {
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
