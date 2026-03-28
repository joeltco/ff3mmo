// PVP duel system — state, AI logic, rendering
// Shared context pattern: exported entry-points set module-level _s = shared,
// private helpers access _s directly.

import { playSFX, SFX, pauseMusic, playTrack, TRACKS } from './music.js';
import { calcDamage, BOSS_HIT_RATE, GOBLIN_HIT_RATE } from './battle-math.js';
import { ITEMS, isWeapon, weaponSubtype } from './data/items.js';
import { PLAYER_POOL, generateAllyStats } from './data/players.js';
import { ps } from './player-stats.js';
import { inputSt } from './input-handler.js';
import { getShieldEvade } from './player-stats.js';

// ── Local constants (mirrors game.js values — keep in sync) ──────────────────
const HUD_VIEW_X = 0, HUD_VIEW_Y = 32, HUD_VIEW_W = 144, HUD_VIEW_H = 144;
const BOSS_PREFLASH_MS       = 133;
const BOSS_BOX_EXPAND_MS     = 300;
const PVP_BOX_RESIZE_MS      = 300;
const BATTLE_SHAKE_MS        = 300;
const BATTLE_DMG_SHOW_MS     = 550;
const SLASH_FRAMES           = 3;
const BOSS_ATK               = 8;
const BATTLE_FLASH_FRAMES    = 65;
const BATTLE_FLASH_FRAME_MS  = 16.67;
const BATTLE_TEXT_STEPS      = 4;
const BATTLE_TEXT_STEP_MS    = 50;
const BATTLE_MSG_HOLD_MS     = 1200;

// ── Mutable PVP state (imported directly by game.js) ─────────────────────────
export const pvpSt = {
  isPVPBattle:            false,
  pvpOpponent:            null,   // PLAYER_POOL entry being dueled
  pvpOpponentStats:       null,   // {hp, maxHP, atk, def, agi, level, name, palIdx, weaponId}
  pvpOpponentIsDefending: false,  // AI defend state
  pvpOpponentHitIdx:      0,      // increments per opponent attack (even=R hand, odd=L hand)
  pvpOpponentHitsThisTurn:0,      // gates dual-wield 2nd hit
  pvpEnemyAllies:         [],     // fake players who join opponent's side
  pvpCurrentEnemyAllyIdx:-1,      // -1 = main opponent, >=0 = pvpEnemyAllies[i]
  pvpPlayerTargetIdx:    -1,      // which enemy the player is currently fighting (-1=main opp, >=0=pvpEnemyAllies[i])
  pvpBoxResizeFromW:      0,
  pvpBoxResizeFromH:      0,
  pvpBoxResizeStartTime:  0,
  pvpEnemySlidePosFrom:   [],
};

// ── Shared context ────────────────────────────────────────────────────────────
let _s = null;

// ── Init / teardown ───────────────────────────────────────────────────────────
export function startPVPBattle(shared, target) {
  _s = shared;
  pvpSt.isPVPBattle             = true;
  pvpSt.pvpOpponent             = target;
  pvpSt.pvpOpponentStats        = generateAllyStats(target);
  pvpSt.pvpOpponentIsDefending  = false;
  pvpSt.pvpOpponentHitIdx       = 0;
  pvpSt.pvpOpponentHitsThisTurn = 0;
  pvpSt.pvpEnemyAllies          = [];
  pvpSt.pvpCurrentEnemyAllyIdx  = -1;
  pvpSt.pvpPlayerTargetIdx      = -1;
  pvpSt.pvpBoxResizeStartTime   = 0;
  _s.bossHP       = pvpSt.pvpOpponentStats.maxHP;
  _s.bossDefeated = false;
  _s.isRandomEncounter = false;
  _s.preBattleTrack    = TRACKS.CRYSTAL_CAVE;
  _s.battleState  = 'flash-strobe';
  _s.battleTimer  = 0;
  _s.resetBattleVars();
  pauseMusic(); // pause map music now; battle track plays when box expands
}

export function resetPVPState() {
  pvpSt.isPVPBattle             = false;
  pvpSt.pvpOpponent             = null;
  pvpSt.pvpOpponentStats        = null;
  pvpSt.pvpOpponentIsDefending  = false;
  pvpSt.pvpEnemyAllies          = [];
  pvpSt.pvpCurrentEnemyAllyIdx  = -1;
  pvpSt.pvpPlayerTargetIdx      = -1;
}

// ── Ally joining ──────────────────────────────────────────────────────────────
export function tryJoinPVPEnemyAlly(shared) {
  _s = shared;
  if (!pvpSt.isPVPBattle || pvpSt.pvpEnemyAllies.length >= 3) return false;
  const loc = _s.getPlayerLocation();
  const inBattle = new Set([
    pvpSt.pvpOpponent && pvpSt.pvpOpponent.name,
    ...pvpSt.pvpEnemyAllies.map(a => a.name),
    ..._s.battleAllies.map(a => a.name),
  ]);
  const eligible = PLAYER_POOL.filter(p => p.loc === loc && !inBattle.has(p.name));
  if (eligible.length === 0 || Math.random() >= 0.3) return false;
  const pick = eligible[Math.floor(Math.random() * eligible.length)];
  const oldTotal = 1 + pvpSt.pvpEnemyAllies.length;
  const oldCols = oldTotal <= 1 ? 1 : 2, oldRows = oldTotal <= 2 ? 1 : 2;
  pvpSt.pvpBoxResizeFromW = oldCols * 24 + 16;
  pvpSt.pvpBoxResizeFromH = oldRows * 32 + 16;
  const _cx = HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2);
  const _cy = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2);
  const _oldGP = [[oldRows-1,oldCols-1],[oldRows-1,0],[0,oldCols-1],[0,0]];
  pvpSt.pvpEnemySlidePosFrom = Array.from({length: oldTotal}, (_, i) => {
    const [gr, gc] = _oldGP[i] || [0, 0];
    return { x: _cx - oldCols*12 + gc*24 + 4, y: _cy - oldRows*16 + gr*32 + 4 };
  });
  pvpSt.pvpEnemyAllies.push(generateAllyStats(pick));
  _s.battleState = 'pvp-ally-appear';
  _s.battleTimer = 0;
  return true;
}

// ── Full PVP battle update (called from game.js updateBattle when isPVPBattle) ─
function _updatePVPOpening() {
  const bs = _s.battleState;
  if (bs === 'flash-strobe') {
    if (_s.battleTimer >= BATTLE_FLASH_FRAMES * BATTLE_FLASH_FRAME_MS) {
      _s.battleState = 'boss-box-expand'; _s.battleTimer = 0;
      playTrack(TRACKS.BATTLE); // map music already paused in startPVPBattle
    }
  } else if (bs === 'boss-box-expand') {
    // Skip boss-appear (land turtle) — PVP box goes straight to battle-fade-in
    if (_s.battleTimer >= BOSS_BOX_EXPAND_MS) { _s.battleState = 'battle-fade-in'; _s.battleTimer = 0; }
  } else if (bs === 'battle-fade-in') {
    if (_s.battleTimer >= (BATTLE_TEXT_STEPS + 1) * BATTLE_TEXT_STEP_MS) { _s.battleState = 'menu-open'; _s.battleTimer = 0; }
  } else { return false; }
  return true;
}
function _updatePVPMenuConfirm() {
  const bs = _s.battleState;
  if (bs === 'message-hold') {
    if (_s.battleTimer >= BATTLE_MSG_HOLD_MS) { _s.battleState = 'menu-open'; _s.battleTimer = 0; _s.battleMessage = null; }
  } else if (bs === 'confirm-pause') {
    if (_s.battleTimer >= 150) {
      _s.allyJoinRound++;
      if (tryJoinPVPEnemyAlly(_s)) return true;
      _s.buildAndProcessNextTurn();
    }
  } else { return false; }
  return true;
}
function _updatePVPAllyAppear() {
  if (_s.battleState !== 'pvp-ally-appear') return false;
  if (_s.battleTimer >= PVP_BOX_RESIZE_MS) _s.buildAndProcessNextTurn();
  return true;
}
export function updatePVPBattle(dt, shared) {
  _s = shared;
  _s.updateTimers(dt);
  _updatePVPOpening()         ||
  _updatePVPMenuConfirm()     ||
  _updatePVPAllyAppear()      ||
  _s.handlePlayerAttack()     ||
  _s.handleDefendItem(dt)     ||
  _s.handleAlly()             ||
  updateBattleEnemyTurn(_s)   ||
  _s.handleEndSequence(dt);
}

// ── Enemy turn update ─────────────────────────────────────────────────────────
export function updateBattleEnemyTurn(shared) {
  _s = shared;
  if (_processBossFlash()) return true;
  if (_s.battleState === 'enemy-attack') {
    if (_s.battleTimer >= BATTLE_SHAKE_MS) { _s.battleState = 'enemy-damage-show'; _s.battleTimer = 0; }
  } else if (_s.battleState === 'enemy-damage-show') { _processEnemyDamageShow();
  } else if (_s.battleState === 'pvp-second-windup') { _processPVPSecondWindup();
  } else { return false; }
  return true;
}

function _processBossFlash() {
  if (_s.battleState !== 'boss-flash' || _s.battleTimer < BOSS_PREFLASH_MS) return false;
  const livingAllies = _s.battleAllies.filter(a => a.hp > 0);
  let targetAlly = -1;
  if (livingAllies.length > 0 && !(pvpSt.isPVPBattle && pvpSt.pvpCurrentEnemyAllyIdx < 0)) {
    if (Math.random() >= 1 / (1 + livingAllies.length)) {
      const allyOptions = _s.battleAllies.map((a, i) => a.hp > 0 ? i : -1).filter(i => i >= 0);
      targetAlly = allyOptions[Math.floor(Math.random() * allyOptions.length)];
    }
  }
  pvpSt.pvpOpponentIsDefending = (pvpSt.isPVPBattle && targetAlly < 0) ? Math.random() < 0.30 : false;
  const hitRate = (_s.currentAttacker >= 0 && _s.encounterMonsters)
    ? (_s.encounterMonsters[_s.currentAttacker].hitRate || GOBLIN_HIT_RATE) : BOSS_HIT_RATE;
  const atk = pvpSt.isPVPBattle
    ? (pvpSt.pvpCurrentEnemyAllyIdx >= 0
        ? pvpSt.pvpEnemyAllies[pvpSt.pvpCurrentEnemyAllyIdx].atk
        : pvpSt.pvpOpponentStats.atk)
    : (_s.currentAttacker >= 0 && _s.encounterMonsters)
        ? _s.encounterMonsters[_s.currentAttacker].atk : BOSS_ATK;
  if (targetAlly >= 0) {
    _s.enemyTargetAllyIdx = targetAlly;
    if (Math.random() * 100 < hitRate) {
      const dmg = calcDamage(atk, _s.battleAllies[targetAlly].def);
      _s.battleAllies[targetAlly].hp = Math.max(0, _s.battleAllies[targetAlly].hp - dmg);
      _s.allyDamageNums[targetAlly] = { value: dmg, timer: 0 };
      _s.allyShakeTimer[targetAlly] = BATTLE_SHAKE_MS;
      playSFX(SFX.ATTACK_HIT); _s.battleState = 'ally-hit'; _s.battleTimer = 0;
    } else {
      _s.allyDamageNums[targetAlly] = { miss: true, timer: 0 };
      _s.battleState = 'ally-damage-show-enemy'; _s.battleTimer = 0;
    }
  } else {
    const shieldEvade = getShieldEvade(ITEMS);
    const shieldBlocked = shieldEvade > 0 && Math.random() * 100 < shieldEvade;
    if (shieldBlocked) {
      _s.playerDamageNum = { miss: true, timer: 0 };
      _s.battleState = 'enemy-damage-show'; _s.battleTimer = 0;
      inputSt.battleProfHits['shield'] = (inputSt.battleProfHits['shield'] || 0) + 1;
    } else if (Math.random() * 100 < hitRate) {
      let dmg = calcDamage(atk, ps.def);
      if (_s.isDefending) dmg = Math.max(1, Math.floor(dmg / 2));
      ps.hp = Math.max(0, ps.hp - dmg);
      _s.playerDamageNum = { value: dmg, timer: 0 };
      playSFX(SFX.ATTACK_HIT);
      _s.battleShakeTimer = BATTLE_SHAKE_MS;
      _s.battleState = 'enemy-attack';
      pvpSt.pvpOpponentHitIdx++;
      _s.battleTimer = 0;
    } else {
      _s.playerDamageNum = { miss: true, timer: 0 };
      _s.battleState = 'enemy-damage-show'; _s.battleTimer = 0;
    }
  }
  return true;
}

function _processEnemyDamageShow() {
  if (_s.battleTimer < BATTLE_DMG_SHOW_MS) return;
  if (ps.hp <= 0) {
    _s.isDefending = false; _s.battleState = 'defeat-monster-fade'; _s.battleTimer = 0;
  } else if (pvpSt.isPVPBattle && pvpSt.pvpCurrentEnemyAllyIdx < 0 && pvpSt.pvpOpponentHitsThisTurn === 0) {
    const oppL = pvpSt.pvpOpponent && pvpSt.pvpOpponent.weaponL;
    const oppR = pvpSt.pvpOpponent && pvpSt.pvpOpponent.weaponR;
    if ((oppL != null && isWeapon(oppL)) || (!isWeapon(oppR) && !isWeapon(oppL))) {
      pvpSt.pvpOpponentHitsThisTurn = 1; _s.battleState = 'pvp-second-windup'; _s.battleTimer = 0;
    } else { _s.processNextTurn(); }
  } else { _s.processNextTurn(); }
}

function _processPVPSecondWindup() {
  if (_s.battleTimer < BOSS_PREFLASH_MS) return;
  const atk = pvpSt.pvpOpponentStats.atk;
  const shieldEvade = getShieldEvade(ITEMS);
  const shieldBlocked = shieldEvade > 0 && Math.random() * 100 < shieldEvade;
  if (shieldBlocked) {
    _s.playerDamageNum = { miss: true, timer: 0 };
    _s.battleState = 'enemy-damage-show'; _s.battleTimer = 0;
    inputSt.battleProfHits['shield'] = (inputSt.battleProfHits['shield'] || 0) + 1;
  } else if (Math.random() * 100 < BOSS_HIT_RATE) {
    let dmg = calcDamage(atk, ps.def);
    if (_s.isDefending) dmg = Math.max(1, Math.floor(dmg / 2));
    ps.hp = Math.max(0, ps.hp - dmg);
    _s.playerDamageNum = { value: dmg, timer: 0 };
    playSFX(SFX.ATTACK_HIT);
    _s.battleShakeTimer = BATTLE_SHAKE_MS;
    _s.battleState = 'enemy-attack'; _s.battleTimer = 0;
  } else {
    _s.playerDamageNum = { miss: true, timer: 0 };
    _s.battleState = 'enemy-damage-show'; _s.battleTimer = 0;
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────
export function drawBossSpriteBoxPVP(shared, centerX, centerY) {
  _s = shared;
  const bs = _s.battleState;
  const isExpand = bs === 'boss-box-expand';
  const isClose  = bs === 'boss-box-close' || (!_s.isRandomEncounter && bs === 'defeat-close');
  const totalEnemies = 1 + pvpSt.pvpEnemyAllies.length;
  const cols = totalEnemies <= 1 ? 1 : 2;
  const rows = totalEnemies <= 2 ? 1 : 2;
  const cellW = 24, cellH = 32;
  const pvpBoxW = cols * cellW + 16;
  const pvpBoxH = rows * cellH + 16;

  _s.clipToViewport();
  _s.ctx.imageSmoothingEnabled = false;

  let drawW = pvpBoxW, drawH = pvpBoxH, resizeT = 1;
  if (isExpand) {
    const t = Math.min(_s.battleTimer / BOSS_BOX_EXPAND_MS, 1);
    drawW = Math.max(16, Math.ceil(pvpBoxW * t / 8) * 8);
    drawH = Math.max(16, Math.ceil(pvpBoxH * t / 8) * 8);
  } else if (isClose) {
    const t = 1 - Math.min(_s.battleTimer / BOSS_BOX_EXPAND_MS, 1);
    drawW = Math.max(16, Math.ceil(pvpBoxW * t / 8) * 8);
    drawH = Math.max(16, Math.ceil(pvpBoxH * t / 8) * 8);
  } else if (bs === 'pvp-ally-appear') {
    resizeT = Math.min(_s.battleTimer / PVP_BOX_RESIZE_MS, 1);
    drawW = Math.round(pvpSt.pvpBoxResizeFromW + (pvpBoxW - pvpSt.pvpBoxResizeFromW) * resizeT);
    drawH = Math.round(pvpSt.pvpBoxResizeFromH + (pvpBoxH - pvpSt.pvpBoxResizeFromH) * resizeT);
  }
  _s.drawBorderedBox(centerX - Math.floor(drawW / 2), centerY - Math.floor(drawH / 2), drawW, drawH);

  const visibleAllies = resizeT >= 1 ? pvpSt.pvpEnemyAllies.length : pvpSt.pvpEnemyAllies.length - 1;
  if (!isExpand && !isClose && bs !== 'defeat-text') {
    const gridPos = [[rows-1,cols-1],[rows-1,0],[0,cols-1],[0,0]];
    const intLeft = centerX - cols * Math.floor(cellW / 2);
    const intTop  = centerY - rows * Math.floor(cellH / 2);
    const allEnemies = [pvpSt.pvpOpponentStats, ...pvpSt.pvpEnemyAllies.slice(0, visibleAllies)];
    allEnemies.forEach((enemy, idx) => {
      if (enemy) _drawPVPEnemyCell(enemy, idx, gridPos, intLeft, intTop, cellW, cellH, resizeT);
    });
  }
  _s.ctx.restore();
}

function _drawPVPEnemyCell(enemy, idx, gridPos, intLeft, intTop, cellW, cellH, resizeT) {
  const bs = _s.battleState;
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
  const fullBody = _s.fullBodyCanvases[palIdx] || _s.fullBodyCanvases[0];
  if (!fullBody) return;
  // Hide main opponent if player has moved on to fighting an ally
  if (isMain && (_s.bossDefeated || pvpSt.pvpPlayerTargetIdx >= 0)) return;
  // Hide ally if the player hasn't reached them yet (and they were already defeated)
  if (!isMain && (idx - 1) < pvpSt.pvpPlayerTargetIdx) return;

  // isCurrentTarget: which enemy the player is currently attacking
  const isCurrentTarget = isMain ? pvpSt.pvpPlayerTargetIdx < 0 : (idx - 1) === pvpSt.pvpPlayerTargetIdx;
  const isThisAttacking = isMain
    ? pvpSt.pvpCurrentEnemyAllyIdx < 0
    : pvpSt.pvpCurrentEnemyAllyIdx === idx - 1;
  // Hit pose: only during the slash impact and brief flinch — NOT the full 700ms damage display
  const playerHitLanded = bs === 'player-slash' &&
    inputSt.hitResults && inputSt.hitResults[_s.currentHitIdx] && !inputSt.hitResults[_s.currentHitIdx].miss;
  const allyHitLanded = bs === 'ally-slash' && _s.allyHitResult && !_s.allyHitResult.miss;
  const isOppHit = isCurrentTarget && (playerHitLanded || bs === 'player-hit-show' || allyHitLanded || bs === 'ally-damage-show');
  const blinkHidden = isCurrentTarget && (playerHitLanded || allyHitLanded) && (Math.floor(_s.battleTimer / 60) & 1);
  const isWindUp = isThisAttacking && (bs === 'boss-flash' || bs === 'pvp-second-windup');
  if (blinkHidden) return;

  // Which hand is this enemy using right now?
  // boss-flash = right hand (first attack), pvp-second-windup = left hand, allies = always right
  const isAttackState = isThisAttacking && bs === 'enemy-attack';
  const isLeftHandWind = isMain && bs === 'pvp-second-windup';
  const isLeftHandAtk  = isMain && isAttackState && pvpSt.pvpOpponentHitsThisTurn === 1;
  const activeWeaponId = (isLeftHandWind || isLeftHandAtk)
    ? (enemy.weaponL != null ? enemy.weaponL : enemy.weaponId)
    : enemy.weaponId;
  const wpn = weaponSubtype(activeWeaponId);

  // Body canvas — drawn directly (pre-h-flipped canvases face left, matching enemy-side visual style)
  let body = fullBody;
  if (isOppHit && _s.hitFullBodyCanvases[palIdx]) {
    body = _s.hitFullBodyCanvases[palIdx];
  } else if (isWindUp) {
    body = _s.knifeBackFullBodyCanvases[palIdx] || fullBody;
  } else if (isAttackState) {
    // Mirror of player: right-hand attack uses knifeR canvas, left-hand uses knifeL canvas
    const atkCvs = isLeftHandAtk ? _s.knifeLFullBodyCanvases : _s.knifeRFullBodyCanvases;
    body = (atkCvs && atkCvs[palIdx]) || fullBody;
  }

  // Opponent faces LEFT — blade positions and tile orientation are mirrored vs player portrait.
  // Player (faces right): wind-up at px+8 (right/behind), swung at px-16 (left/forward).
  // Opponent (faces left): wind-up at sprX-8 (left/behind), swung at sprX+16 (right/forward).
  // Blade canvas h-flipped via translate+scale so tile content matches the facing direction.
  const blades = _s.blades;
  let blade = null;
  if (isWindUp || isAttackState) {
    // Opponent faces LEFT — swap raised/swung vs player (opponent's forward = player's back)
    if      (wpn === 'knife' && activeWeaponId === 0x1F) blade = isAttackState ? blades.dagger.raised : blades.dagger.swung;
    else if (wpn === 'knife')  blade = isAttackState ? blades.knife.raised  : blades.knife.swung;
    else if (wpn === 'sword')  blade = isAttackState ? blades.sword.raised  : blades.sword.swung;
    else if (isAttackState)    blade = blades.fist;
  }
  const drawBlade = () => {
    const ctx = _s.ctx;
    if (isAttackState && blade === blades.fist) {
      ctx.drawImage(blade, sprX + 4,  sprY + 10); // mirror of px-4
    } else if (isAttackState) {
      ctx.drawImage(blade, sprX + 16, sprY + 1);  // mirror of px-16
    } else {
      ctx.drawImage(blade, sprX - 8,  sprY - 7);  // mirror of px+8
    }
  };

  // Wind-up: blade behind body (pulled back); swung/fist: blade in front
  if (isWindUp && blade) drawBlade();
  _s.ctx.drawImage(body, sprX, sprY);
  if (isAttackState && blade) drawBlade();

  // Slash effect overlays on the current target
  if (isCurrentTarget) {
    if (bs === 'player-slash' && _s.slashFrames && _s.slashFrame < SLASH_FRAMES && playerHitLanded) {
      _s.ctx.drawImage(_s.slashFrames[_s.slashFrame], sprX + _s.slashOffX, sprY + _s.slashOffY);
    }
    if (bs === 'ally-slash' && allyHitLanded) {
      const ally = _s.battleAllies[_s.currentAllyAttacker];
      const aSlashF = ally ? _s.getSlashFramesForWeapon(ally.weaponId, true) : _s.slashFramesR;
      const af = Math.min(Math.floor(_s.battleTimer / 67), 2);
      if (aSlashF && aSlashF[af]) _s.ctx.drawImage(aSlashF[af], sprX + [0,10,-8][af], sprY + [0,-6,8][af]);
    }
  }
}
