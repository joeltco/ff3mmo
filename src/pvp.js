// PVP duel system — state, AI logic, rendering

import { battleSt, getEnemyHP, setEnemyHP } from './battle-state.js';
import { clipToViewport, drawBorderedBox } from './hud-drawing.js';
import { getPlayerLocation } from './roster.js';
import { queueBattleMsg } from './battle-msg.js';
import { getBlades, getFistCanvas } from './weapon-sprites.js';
import { getAllyDamageNums, getPlayerDamageNum, setPlayerDamageNum, getEnemyHealNum, setEnemyHealNum } from './damage-numbers.js';
import { ui } from './ui-state.js';
import { buildTurnOrder, processNextTurn } from './battle-turn.js';
import { updateBattleAlly } from './battle-ally.js';
import { resetBattleVars, isTeamWiped, updateBattleTimers,
         updateBattlePlayerAttack, updateBattleDefendItem, updateBattleEndSequence,
         tryJoinPlayerAlly, advancePVPTargetOrVictory } from './battle-update.js';
import { playSFX, stopSFX, SFX, pauseMusic, playTrack, TRACKS } from './music.js';
import { rollHits, calcPotentialHits, BOSS_HIT_RATE, GOBLIN_HIT_RATE } from './battle-math.js';
import { ITEMS, isWeapon, weaponSubtype } from './data/items.js';
import { _nameToBytes } from './text-utils.js';
import { PLAYER_POOL, PLAYER_PALETTES, MONK_PALETTES, generateAllyStats } from './data/players.js';

function _jobPalette(jobIdx, palIdx) {
  const pool = jobIdx === 2 ? MONK_PALETTES : PLAYER_PALETTES;
  return pool[palIdx] || pool[0];
}
import { JOBS } from './data/jobs.js';
import { MONSTERS } from './data/monsters.js';
import { ps } from './player-stats.js';
import { inputSt } from './input-handler.js';
import { getShieldEvade } from './player-stats.js';
import { pvpGridLayout, PVP_CELL_W, PVP_CELL_H } from './pvp-math.js';
import { playSlashSFX } from './battle-sfx.js';
import { bsc, getSlashFramesForWeapon } from './battle-sprite-cache.js';
import { fakePlayerFullBodyCanvases, fakePlayerHitFullBodyCanvases,
         fakePlayerKnifeRFullBodyCanvases, fakePlayerKnifeLFullBodyCanvases,
         fakePlayerKnifeRFwdFullBodyCanvases, fakePlayerKnifeLFwdFullBodyCanvases,
         fakePlayerKneelFullBodyCanvases, fakePlayerVictoryFullBodyCanvases,
         fakePlayerDeathFrames } from './fake-player-sprites.js';

function _cursorTileCanvas() { return ui.cursorTileCanvas; }
function _buildAndProcessNextTurn() { battleSt.turnQueue = buildTurnOrder(); processNextTurn(); }

// ── Local constants (mirrors game.js values — keep in sync) ──────────────────
const HUD_VIEW_X = 0, HUD_VIEW_Y = 32, HUD_VIEW_W = 144, HUD_VIEW_H = 144;
const BOSS_PREFLASH_MS       = 133;
const BOSS_BOX_EXPAND_MS     = 300;
const PVP_BOX_RESIZE_MS      = 300;
const BATTLE_SHAKE_MS        = 300;
const BATTLE_DMG_SHOW_MS     = 550;
const SLASH_FRAMES           = 3;
const BOSS_ATK               = (MONSTERS.get(0xCC) || { atk: 8 }).atk;
const BATTLE_FLASH_FRAMES    = 65;
const BATTLE_FLASH_FRAME_MS  = 16.67;
const BATTLE_TEXT_STEPS      = 4;
const BATTLE_TEXT_STEP_MS    = 50;
const BATTLE_MSG_HOLD_MS     = 1200;
const MONSTER_DEATH_MS       = 250;
const DEFEND_SPARKLE_FRAME_MS = 133;
const DEFEND_SPARKLE_TOTAL_MS = 533;
const ENEMY_SLASH_TOTAL_MS    = 201; // 3 frames × 67ms — slash on player portrait before shake

// ── Mutable PVP state (imported directly by main.js) ─────────────────────────
export const pvpSt = {
  isPVPBattle:            false,
  pvpOpponent:            null,   // PLAYER_POOL entry being dueled
  pvpOpponentStats:       null,   // {hp, maxHP, atk, def, agi, level, name, palIdx, weaponId}
  pvpOpponentIsDefending: false,  // AI defend state — halves incoming player/ally damage this round
  pvpPendingTargetAlly:   -1,     // saved targeting decision during pvp-defend-anim
  pvpOpponentShakeTimer:      0,      // drives opponent left-shake on damage (mirrors battleShakeTimer)
  pvpEnemyHitResults:     [],     // pre-rolled hits for current enemy combo
  pvpEnemyHitIdx:         0,      // current hit index in enemy combo
  pvpEnemyDualWield:      false,  // true if current attacker is dual-wielding
  pvpEnemyUnarmed:        false,  // true if current attacker has no weapons (alternates R/L per OAM)
  pvpPendingAttack:       null,   // {miss, shieldBlock, dmg} — staged during pvp-enemy-slash, applied at end
  pvpPreflashDecided:     false,  // true after defend/item/attack decision made for current enemy-flash
  pvpEnemyAllies:         [],     // fake players who join opponent's side
  pvpCurrentEnemyAllyIdx:-1,      // -1 = main opponent, >=0 = pvpEnemyAllies[i]
  pvpPlayerTargetIdx:    -1,      // which enemy the player is currently fighting (-1=main opp, >=0=pvpEnemyAllies[i])
  pvpBoxResizeFromW:      0,
  pvpBoxResizeFromH:      0,
  pvpBoxResizeStartTime:  0,
  pvpEnemySlidePosFrom:   [],
  pvpDyingMap:            new Map(), // enemyIdx → startDelayMs for staggered death wipe
  // Opponent South Wind multi-target state
  _oppSWTargets:          [],       // target indices: -1=player, 0+=ally index
  _oppSWHitIdx:           0,        // current target in sequence
  _oppSWPerDmg:           0,        // pre-rolled damage per target
  _swDmgApplied:          false,    // damage applied this cycle
  _oppSWExplosionPlayed:  false,    // explosion SFX played this target
};

// ── Shared context ────────────────────────────────────────────────────────────
// _s bag retired — direct imports + injected callbacks above
// _playSlashSFX moved to battle-sfx.js → playSlashSFX

// ── Init / teardown ───────────────────────────────────────────────────────────
export function startPVPBattle(target) {
  pvpSt.isPVPBattle             = true;
  pvpSt.pvpOpponent             = target;
  pvpSt.pvpOpponentStats        = generateAllyStats(target);
  pvpSt.pvpOpponentIsDefending  = false;
  pvpSt.pvpPendingTargetAlly    = -1;
  pvpSt.pvpOpponentShakeTimer       = 0;
  pvpSt.pvpEnemyHitResults      = [];
  pvpSt.pvpEnemyHitIdx          = 0;
  pvpSt.pvpPendingAttack        = null;
  pvpSt.pvpPreflashDecided      = false;
  pvpSt.pvpEnemyAllies          = [];
  pvpSt.pvpCurrentEnemyAllyIdx  = -1;
  pvpSt.pvpPlayerTargetIdx      = -1;
  pvpSt.pvpBoxResizeStartTime   = 0;
  setEnemyHP(pvpSt.pvpOpponentStats.maxHP);
  battleSt.enemyDefeated = false;
  battleSt.isRandomEncounter = false;
  battleSt.preBattleTrack    = TRACKS.CRYSTAL_CAVE;
  battleSt.battleState  = 'flash-strobe';
  battleSt.battleTimer  = 0;
  playSFX(SFX.BATTLE_SWIPE);
  resetBattleVars();
  pauseMusic(); // pause map music now; battle track plays when box expands
}

export function resetPVPState() {
  pvpSt.isPVPBattle             = false;
  pvpSt.pvpOpponent             = null;
  pvpSt.pvpOpponentStats        = null;
  pvpSt.pvpOpponentIsDefending  = false;
  pvpSt.pvpPendingTargetAlly    = -1;
  pvpSt.pvpOpponentShakeTimer       = 0;
  pvpSt.pvpEnemyAllies          = [];
  pvpSt.pvpCurrentEnemyAllyIdx  = -1;
  pvpSt.pvpPlayerTargetIdx      = -1;
  pvpSt.pvpDyingMap             = new Map();
  pvpSt.pvpPreflashDecided      = false;
  pvpSt.pvpEnemyHitResults      = [];
  pvpSt.pvpEnemyHitIdx          = 0;
  pvpSt.pvpEnemyDualWield       = false;
  pvpSt.pvpEnemyUnarmed         = false;
  pvpSt._oppSWTargets           = [];
  pvpSt._oppSWHitIdx            = 0;
  pvpSt._oppSWPerDmg            = 0;
  pvpSt._swDmgApplied           = false;
  pvpSt._oppSWExplosionPlayed   = false;
}

// ── Ally joining ──────────────────────────────────────────────────────────────
export function tryJoinPVPEnemyAlly() {
  if (!pvpSt.isPVPBattle || pvpSt.pvpEnemyAllies.length >= 3) return false;
  const loc = getPlayerLocation();
  const inBattle = new Set([
    pvpSt.pvpOpponent && pvpSt.pvpOpponent.name,
    ...pvpSt.pvpEnemyAllies.map(a => a.name),
    ...battleSt.battleAllies.map(a => a.name),
  ]);
  const eligible = PLAYER_POOL.filter(p => p.loc === loc && !inBattle.has(p.name));
  if (eligible.length === 0 || Math.random() >= 0.3) return false;
  const pick = eligible[Math.floor(Math.random() * eligible.length)];
  const oldTotal = 1 + pvpSt.pvpEnemyAllies.length;
  const { cols: oldCols, rows: oldRows, gridPos: oldGP } = pvpGridLayout(oldTotal);
  pvpSt.pvpBoxResizeFromW = oldCols * PVP_CELL_W + 16;
  pvpSt.pvpBoxResizeFromH = oldRows * PVP_CELL_H + 16;
  const _cx = HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2);
  const _cy = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2);
  pvpSt.pvpEnemySlidePosFrom = Array.from({length: oldTotal}, (_, i) => {
    const [gr, gc] = oldGP[i] || [0, 0];
    return { x: _cx - oldCols*12 + gc*PVP_CELL_W + 4, y: _cy - oldRows*16 + gr*PVP_CELL_H + 4 };
  });
  pvpSt.pvpEnemyAllies.push(generateAllyStats(pick));
  battleSt.battleState = 'pvp-ally-appear';
  battleSt.battleTimer = 0;
  return true;
}

// ── Full PVP battle update (called from game.js updateBattle when isPVPBattle) ─
function _updatePVPOpening() {
  const bs = battleSt.battleState;
  if (bs === 'flash-strobe') {
    if (battleSt.battleTimer >= BATTLE_FLASH_FRAMES * BATTLE_FLASH_FRAME_MS) {
      battleSt.battleState = 'enemy-box-expand'; battleSt.battleTimer = 0;
      playTrack(TRACKS.BATTLE); // map music already paused in startPVPBattle
    }
  } else if (bs === 'enemy-box-expand') {
    // Skip boss-appear (land turtle) — PVP box goes straight to battle-fade-in
    if (battleSt.battleTimer >= BOSS_BOX_EXPAND_MS) { battleSt.battleState = 'battle-fade-in'; battleSt.battleTimer = 0; }
  } else if (bs === 'battle-fade-in') {
    if (battleSt.battleTimer >= (BATTLE_TEXT_STEPS + 1) * BATTLE_TEXT_STEP_MS) { battleSt.battleState = 'menu-open'; battleSt.battleTimer = 0; }
  } else { return false; }
  return true;
}
function _updatePVPMenuConfirm() {
  const bs = battleSt.battleState;
  if (bs === 'message-hold') {
    if (battleSt.battleTimer >= BATTLE_MSG_HOLD_MS) { battleSt.battleState = 'menu-open'; battleSt.battleTimer = 0; battleSt.battleMessage = null; }
  } else if (bs === 'confirm-pause') {
    if (battleSt.battleTimer >= 150) {
      battleSt.allyJoinRound++;
      if (tryJoinPVPEnemyAlly()) return true;
      if (tryJoinPlayerAlly()) return true;
      _buildAndProcessNextTurn();
    }
  } else { return false; }
  return true;
}
function _updatePVPAllyAppear() {
  if (battleSt.battleState !== 'pvp-ally-appear') return false;
  if (battleSt.battleTimer >= PVP_BOX_RESIZE_MS) _buildAndProcessNextTurn();
  return true;
}
function _buildPVPDyingMap() {
  // Current target: main opponent (grid idx 0) or the ally the player just defeated
  const dyingIdx = pvpSt.pvpPlayerTargetIdx < 0 ? 0 : pvpSt.pvpPlayerTargetIdx + 1;
  pvpSt.pvpDyingMap = new Map([[dyingIdx, 0]]);
}
function _updatePVPDissolve() {
  if (battleSt.battleState !== 'pvp-dissolve') return false;
  if (pvpSt.pvpDyingMap.size === 0) _buildPVPDyingMap();
  const _maxDelay = pvpSt.pvpDyingMap.size > 0 ? Math.max(...pvpSt.pvpDyingMap.values()) : 0;
  if (battleSt.battleTimer >= MONSTER_DEATH_MS + _maxDelay) {
    pvpSt.pvpDyingMap = new Map();
    battleSt.battleTimer = 0;
    advancePVPTargetOrVictory();
  }
  return true;
}
export function updatePVPBattle(dt) {
  updateBattleTimers(dt);
  _updatePVPOpening()         ||
  _updatePVPMenuConfirm()     ||
  _updatePVPAllyAppear()      ||
  _updatePVPDissolve()        ||
  updateBattlePlayerAttack()     ||
  updateBattleDefendItem(dt)     ||
  updateBattleAlly()             ||
  updateBattleEnemyTurn()   ||
  updateBattleEndSequence(dt);
}

// ── Enemy turn update ─────────────────────────────────────────────────────────
function updateBattleEnemyTurn() {
  if (_processEnemyFlash()) return true;
  if (_processPVPDefendAnim()) return true;
  if (_processPVPEnemySlash()) return true;
  if (_processPVPOppPotion()) return true;
  if (_processPVPOppSWThrow()) return true;
  if (_processPVPOppSWHit()) return true;
  if (battleSt.battleState === 'enemy-attack') {
    if (battleSt.battleTimer >= BATTLE_SHAKE_MS) { battleSt.battleState = 'enemy-damage-show'; battleSt.battleTimer = 0; }
  } else if (battleSt.battleState === 'enemy-damage-show') { _processEnemyDamageShow();
  } else if (battleSt.battleState === 'pvp-second-windup') { _processPVPSecondWindup();
  } else { return false; }
  return true;
}

function _pvpAttackerSFX(weaponId) {
  const sub = weaponSubtype(weaponId);
  return (sub === 'knife' || sub === 'sword') ? SFX.KNIFE_HIT : SFX.ATTACK_HIT;
}

function _runEnemyAttack(targetAlly) {
  const attackerStats = pvpSt.pvpCurrentEnemyAllyIdx >= 0
    ? pvpSt.pvpEnemyAllies[pvpSt.pvpCurrentEnemyAllyIdx]
    : pvpSt.pvpOpponentStats;
  // Queue attacker name message
  if (queueBattleMsg && attackerStats && attackerStats.name) {
    queueBattleMsg(_nameToBytes(attackerStats.name + ' attacks!'));
  }
  if (targetAlly >= 0) {
    // Ally target — sum all pre-rolled hits, apply total at once
    battleSt.enemyTargetAllyIdx = targetAlly;
    let totalDmg = 0, anyCrit = false, allMiss = true;
    for (const h of pvpSt.pvpEnemyHitResults) {
      if (!h.miss) { totalDmg += h.dmg; allMiss = false; if (h.crit) anyCrit = true; }
    }
    if (!allMiss) {
      battleSt.battleAllies[targetAlly].hp = Math.max(0, battleSt.battleAllies[targetAlly].hp - totalDmg);
      getAllyDamageNums()[targetAlly] = { value: totalDmg, crit: anyCrit, timer: 0 };
      battleSt.allyShakeTimer[targetAlly] = BATTLE_SHAKE_MS;
      if (anyCrit) battleSt.critFlashTimer = 0;
      playSFX(attackerStats ? _pvpAttackerSFX(attackerStats.weaponId) : SFX.ATTACK_HIT);
      battleSt.battleState = 'ally-hit'; battleSt.battleTimer = 0;
    } else {
      getAllyDamageNums()[targetAlly] = { miss: true, timer: 0 };
      battleSt.battleState = 'ally-damage-show-enemy'; battleSt.battleTimer = 0;
    }
  } else {
    // Player target — stage first hit for slash combo
    pvpSt.pvpPendingAttack = pvpSt.pvpEnemyHitResults[0] || { miss: true, shieldBlock: false, dmg: 0, crit: false };
    const pendingCrit = pvpSt.pvpPendingAttack && pvpSt.pvpPendingAttack.crit;
    const wId = attackerStats ? attackerStats.weaponId : null;
    if (wId != null) playSlashSFX(wId, pendingCrit); else playSFX(SFX.ATTACK_HIT);
    battleSt.battleState = 'pvp-enemy-slash'; battleSt.battleTimer = 0;
  }
}

function _processEnemyFlash() {
  if (battleSt.battleState !== 'enemy-flash') return false;

  // On first tick of enemy-flash, decide defend/item for PVP main opponent (skip backswing for non-attack)
  if (!pvpSt.pvpPreflashDecided && pvpSt.isPVPBattle && pvpSt.pvpCurrentEnemyAllyIdx < 0) {
    pvpSt.pvpPreflashDecided = true;
    if (Math.random() < 0.30) {
      pvpSt.pvpOpponentIsDefending = true;
      pvpSt.pvpPendingTargetAlly = -1;
      playSFX(SFX.DEFEND_HIT);
      battleSt.battleState = 'pvp-defend-anim'; battleSt.battleTimer = 0;
      return true;
    }
    const maxHP = pvpSt.pvpOpponentStats.maxHP;
    const curHP = pvpSt.pvpOpponentStats.hp;
    const heal = Math.min(50, maxHP - curHP);
    if (curHP < maxHP * 0.5 && heal > 0 && Math.random() < 0.25) {
      pvpSt.pvpOpponentStats.hp = curHP + heal;
      setEnemyHealNum({ value: heal, timer: 0 });
      playSFX(SFX.CURE);
      battleSt.battleState = 'pvp-opp-potion'; battleSt.battleTimer = 0;
      return true;
    }
    if (Math.random() < 0.15) {
      battleSt.battleState = 'pvp-opp-sw-throw'; battleSt.battleTimer = 0;
      return true;
    }
    // Decided: will attack — fall through to windup animation
  }

  // OAM-canonical: unarmed opponents skip the wind-up wait — straight to the strike.
  const _earlyAttacker = pvpSt.pvpCurrentEnemyAllyIdx >= 0
    ? pvpSt.pvpEnemyAllies[pvpSt.pvpCurrentEnemyAllyIdx]
    : pvpSt.pvpOpponentStats;
  const _earlyUnarmed = !!(_earlyAttacker && !isWeapon(_earlyAttacker.weaponId) && !isWeapon(_earlyAttacker.weaponL));
  if (!_earlyUnarmed && battleSt.battleTimer < BOSS_PREFLASH_MS) return false;

  // Pre-flash elapsed — resolve attack
  const livingAllies = battleSt.battleAllies.filter(a => a.hp > 0);
  let targetAlly = -1;
  if (livingAllies.length > 0) {
    const allyOptions = battleSt.battleAllies.map((a, i) => a.hp > 0 ? i : -1).filter(i => i >= 0);
    if (ps.hp <= 0) {
      // Player dead — must target a living ally
      targetAlly = allyOptions[Math.floor(Math.random() * allyOptions.length)];
    } else if (Math.random() >= 1 / (1 + livingAllies.length)) {
      targetAlly = allyOptions[Math.floor(Math.random() * allyOptions.length)];
    }
  }
  pvpSt.pvpOpponentIsDefending = false;

  // Roll multi-hit combo for PVP attacker
  const attackerStats = pvpSt.pvpCurrentEnemyAllyIdx >= 0
    ? pvpSt.pvpEnemyAllies[pvpSt.pvpCurrentEnemyAllyIdx]
    : pvpSt.pvpOpponentStats;
  const atk = attackerStats ? attackerStats.atk : BOSS_ATK;
  const hitRate = attackerStats?.hitRate || BOSS_HIT_RATE;
  const dualWield = attackerStats && isWeapon(attackerStats.weaponId) && isWeapon(attackerStats.weaponL);
  const isUnarmed = !!(attackerStats && !isWeapon(attackerStats.weaponId) && !isWeapon(attackerStats.weaponL));
  // Unarmed treats both fists as separate "weapons" → 2x hits, matching dual-wield (so R/L alternation is visible)
  const potentialHits = calcPotentialHits(attackerStats?.level || 1, attackerStats?.agi || 5, dualWield || isUnarmed);

  pvpSt.pvpEnemyHitIdx = 0;
  pvpSt.pvpEnemyDualWield = dualWield;
  pvpSt.pvpEnemyUnarmed = isUnarmed;
  const def = targetAlly >= 0 ? battleSt.battleAllies[targetAlly].def : ps.def;
  const attackerJob = JOBS[attackerStats?.jobIdx || 0] || {};
  const baseOpts = { critPct: attackerJob.critPct || 0, critBonus: attackerJob.critBonus || 0 };
  const opts = targetAlly >= 0 ? baseOpts : {
    ...baseOpts,
    shieldEvade: getShieldEvade(ITEMS),
    evade: ps.evade,
    defendHalve: battleSt.isDefending,
  };
  const raw = rollHits(atk, def, hitRate, potentialHits, opts);
  // Map to PVP result format: { miss, shieldBlock, dmg, crit }
  pvpSt.pvpEnemyHitResults = raw.map(h => {
    if (h.shieldBlock) return { miss: false, shieldBlock: true, dmg: 0, crit: false };
    if (h.miss) return { miss: true, shieldBlock: false, dmg: 0, crit: false };
    return { miss: false, shieldBlock: false, dmg: h.damage, crit: h.crit };
  });

  _runEnemyAttack(targetAlly);
  return true;
}

function _processPVPDefendAnim() {
  if (battleSt.battleState !== 'pvp-defend-anim') return false;
  if (battleSt.battleTimer >= DEFEND_SPARKLE_TOTAL_MS) processNextTurn(); // defend is the full action
  return true;
}

function _processPVPOppPotion() {
  if (battleSt.battleState !== 'pvp-opp-potion') return false;
  if (battleSt.battleTimer >= DEFEND_SPARKLE_TOTAL_MS) {
    setEnemyHealNum(null);
    processNextTurn();
  }
  return true;
}

function _processPVPOppSWThrow() {
  if (battleSt.battleState !== 'pvp-opp-sw-throw') return false;
  if (battleSt.battleTimer >= 250) {
    // Build target list: player + living allies
    const targets = [];
    if (ps.hp > 0) targets.push(-1);
    for (let i = 0; i < battleSt.battleAllies.length; i++) {
      if (battleSt.battleAllies[i].hp > 0) targets.push(i);
    }
    if (targets.length === 0) { processNextTurn(); return true; }
    // Roll damage using INT (5 + level), matching player formula (no defense calc)
    const int = 5 + (pvpSt.pvpOpponentStats.level || 1);
    const swAtk = Math.floor(int / 2) + 55;
    const swBase = Math.floor((swAtk + Math.floor(Math.random() * Math.floor(swAtk / 2 + 1))) / 2);
    pvpSt._oppSWTargets = targets;
    pvpSt._oppSWHitIdx = 0;
    pvpSt._oppSWPerDmg = Math.max(1, Math.floor(swBase / targets.length));
    pvpSt._swDmgApplied = false;
    battleSt.battleState = 'pvp-opp-sw-hit'; battleSt.battleTimer = 0;
  }
  return true;
}

function _processPVPOppSWHit() {
  if (battleSt.battleState !== 'pvp-opp-sw-hit') return false;
  const targets = pvpSt._oppSWTargets;
  if (!targets || targets.length === 0) { processNextTurn(); return true; }
  const tidx = targets[pvpSt._oppSWHitIdx];
  // At 0ms: explosion SFX
  if (!pvpSt._oppSWExplosionPlayed) {
    pvpSt._oppSWExplosionPlayed = true;
    playSFX(SFX.SW_HIT);
  }
  // At 400ms: apply damage + hit SFX
  if (battleSt.battleTimer >= 400 && !pvpSt._swDmgApplied) {
    const dmg = pvpSt._oppSWPerDmg;
    if (tidx === -1) {
      ps.hp = Math.max(0, ps.hp - dmg);
      setPlayerDamageNum({ value: dmg, timer: 0 });
      battleSt.battleShakeTimer = BATTLE_SHAKE_MS;
    } else {
      const ally = battleSt.battleAllies[tidx];
      if (ally && ally.hp > 0) {
        ally.hp = Math.max(0, ally.hp - dmg);
        getAllyDamageNums()[tidx] = { value: dmg, timer: 0 };
        battleSt.allyShakeTimer[tidx] = BATTLE_SHAKE_MS;
      }
    }
    playSFX(SFX.ATTACK_HIT);
    pvpSt._swDmgApplied = true;
  }
  // At 1100ms: next target or done
  if (battleSt.battleTimer >= 1100) {
    if (tidx === -1) setPlayerDamageNum(null);
    pvpSt._oppSWHitIdx++;
    pvpSt._swDmgApplied = false;
    pvpSt._oppSWExplosionPlayed = false;
    if (pvpSt._oppSWHitIdx < targets.length) {
      battleSt.battleTimer = 0;
    } else {
      pvpSt._oppSWTargets = [];
      pvpSt._oppSWHitIdx = 0;
      // Trigger death animations for killed allies
      for (let i = 0; i < battleSt.battleAllies.length; i++) {
        const ally = battleSt.battleAllies[i];
        if (ally.hp <= 0 && ally.deathTimer == null) {
          ally.deathTimer = 0;
          battleSt.turnQueue = battleSt.turnQueue.filter(t => !(t.type === 'ally' && t.index === i));
        }
      }
      if (isTeamWiped()) {
        battleSt.isDefending = false; battleSt.battleState = 'team-wipe'; battleSt.battleTimer = 0;
      } else {
        processNextTurn();
      }
    }
  }
  return true;
}

function _processEnemyDamageShow() {
  if (battleSt.battleTimer < BATTLE_DMG_SHOW_MS) return;
  if (isTeamWiped()) {
    battleSt.isDefending = false; battleSt.battleState = 'team-wipe'; battleSt.battleTimer = 0;
  } else { processNextTurn(); }
}

function _processPVPSecondWindup() {
  // OAM-canonical: unarmed skips the wind-up entirely.
  if (!pvpSt.pvpEnemyUnarmed && battleSt.battleTimer < BOSS_PREFLASH_MS) return;
  // Stage next pre-rolled hit from combo
  const hit = pvpSt.pvpEnemyHitResults[pvpSt.pvpEnemyHitIdx];
  pvpSt.pvpPendingAttack = hit || { miss: true, shieldBlock: false, dmg: 0, crit: false };
  const attackerStats = pvpSt.pvpCurrentEnemyAllyIdx >= 0
    ? pvpSt.pvpEnemyAllies[pvpSt.pvpCurrentEnemyAllyIdx]
    : pvpSt.pvpOpponentStats;
  // Hand selection: dual or unarmed → alternate per hit; single weapon → that hand only
  const rW = attackerStats && isWeapon(attackerStats.weaponId);
  const lW = attackerStats && isWeapon(attackerStats.weaponL);
  const isLeftHit = (rW && lW) || (!rW && !lW)
    ? (pvpSt.pvpEnemyHitIdx % 2 === 1)
    : !rW;
  const wId = isLeftHit ? (attackerStats ? attackerStats.weaponL : null) : (attackerStats ? attackerStats.weaponId : null);
  if (wId != null) playSlashSFX(wId, hit && hit.crit); else playSFX(SFX.ATTACK_HIT);
  battleSt.battleState = 'pvp-enemy-slash'; battleSt.battleTimer = 0;
}

function _processPVPEnemySlash() {
  if (battleSt.battleState !== 'pvp-enemy-slash') return false;
  if (battleSt.battleTimer < ENEMY_SLASH_TOTAL_MS) return true;
  const pending = pvpSt.pvpPendingAttack;
  pvpSt.pvpPendingAttack = null;
  // Apply this hit's damage immediately (but don't show number yet — sum at end)
  if (pending && !pending.miss && !pending.shieldBlock) {
    ps.hp = Math.max(0, ps.hp - pending.dmg);
    if (pending.crit) battleSt.critFlashTimer = 0;
    battleSt.battleShakeTimer = BATTLE_SHAKE_MS;
  }
  if (pending && pending.shieldBlock) {
    // shield block counts as an action for JP
  }
  // Advance combo
  if (pvpSt.pvpEnemyHitIdx + 1 < pvpSt.pvpEnemyHitResults.length) {
    pvpSt.pvpEnemyHitIdx++;
    // More hits — windup for next slash
    battleSt.battleState = 'pvp-second-windup'; battleSt.battleTimer = 0;
  } else {
    // Finalize — sum all hits into one damage number
    let totalDmg = 0, anyCrit = false, allMiss = true;
    for (const h of pvpSt.pvpEnemyHitResults) {
      if (!h.miss && !h.shieldBlock) { totalDmg += h.dmg; allMiss = false; if (h.crit) anyCrit = true; }
    }
    setPlayerDamageNum(allMiss ? { miss: true, timer: 0 } : { value: totalDmg, crit: anyCrit, timer: 0 });
    battleSt.battleState = 'enemy-attack'; battleSt.battleTimer = 0;
  }
  return true;
}

// ── Rendering ─────────────────────────────────────────────────────────────────
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
  const isClose  = bs === 'enemy-box-close' || (!battleSt.isRandomEncounter && bs === 'defeat-close');
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
  drawBorderedBox(centerX - Math.floor(drawW / 2), centerY - Math.floor(drawH / 2), drawW, drawH);

  const visibleAllies = resizeT >= 1 ? pvpSt.pvpEnemyAllies.length : pvpSt.pvpEnemyAllies.length - 1;
  if (!isExpand && !isClose && bs !== 'defeat-text') {
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
  // Hide dead enemies — but keep visible during dissolve and attack sequence
  const isDying = pvpSt.pvpDyingMap.has(idx) && bs === 'pvp-dissolve';
  const isCurrentTarget = isMain ? pvpSt.pvpPlayerTargetIdx < 0 : (idx - 1) === pvpSt.pvpPlayerTargetIdx;
  const isSWHit = bs === 'sw-hit' || bs === 'sw-throw';
  const isBeingKilled = isCurrentTarget && (bs === 'player-slash' || bs === 'player-hit-show' ||
    bs === 'player-damage-show' || bs === 'ally-slash' || bs === 'ally-damage-show');
  if (isMain && (battleSt.enemyDefeated || (pvpSt.pvpOpponentStats && pvpSt.pvpOpponentStats.hp <= 0)) && !isDying && !isBeingKilled && !isSWHit) return;
  if (!isMain && (battleSt.enemyDefeated || enemy.hp <= 0) && !isDying && !isBeingKilled && !isSWHit) return;
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
  // Hand selection: dual or unarmed → alternate per hit; single weapon → that hand only.
  const eRw = enemy && isWeapon(enemy.weaponId);
  const eLw = enemy && isWeapon(enemy.weaponL);
  const altByHit = (eRw && eLw) || (!eRw && !eLw);
  const _altIsL = altByHit ? (pvpSt.pvpEnemyHitIdx % 2 === 1) : !eRw;
  const isLeftHandWind = isMain && bs === 'pvp-second-windup' && _altIsL;
  const isLeftHandAtk  = isMain && isAttackState && _altIsL;
  const activeWeaponId = (isLeftHandWind || isLeftHandAtk)
    ? (enemy.weaponL != null ? enemy.weaponL : enemy.weaponId)
    : enemy.weaponId;
  const wpn = weaponSubtype(activeWeaponId);

  // Body canvas — drawn directly (pre-h-flipped canvases face left, matching enemy-side visual style)
  // MIRRORING RULE: opponent faces left, so R-hand canvases look like L-hand after flip and vice versa.
  // Use the opposite hand's canvas to get the correct visual for each hand.
  const oppHP   = isMain ? (pvpSt.pvpOpponentStats ? pvpSt.pvpOpponentStats.hp : getEnemyHP()) : (enemy.hp != null ? enemy.hp : 0);
  const oppMaxHP = isMain ? (pvpSt.pvpOpponentStats ? pvpSt.pvpOpponentStats.maxHP : 1) : (enemy.maxHP || 1);
  const isNearFatalOpp = oppHP > 0 && oppHP <= Math.floor(oppMaxHP / 4);
  // Opponent victory = team wiped or old defeat path
  const isOppVictory = battleSt.battleState === 'team-wipe' || battleSt.battleState === 'defeat-monster-fade';
  const isOppDefending = isMain && pvpSt.pvpOpponentIsDefending && bs === 'pvp-defend-anim';
  const isOppItemUse   = isMain && (bs === 'pvp-opp-sw-throw' || bs === 'pvp-opp-sw-hit' || bs === 'pvp-opp-potion');
  let body = fullBody;
  if (isOppHit && _fpb(fakePlayerHitFullBodyCanvases)) {
    body = _fpb(fakePlayerHitFullBodyCanvases);
  } else if (isWindUp && pvpSt.pvpEnemyUnarmed) {
    // OAM: unarmed has NO wind-up — show the strike pose the entire animation.
    // Mirror rule (opponent faces right): R-strike → L-fwd body, L-strike → R-back body.
    body = _fpb(isLeftHandWind ? fakePlayerKnifeRFullBodyCanvases : fakePlayerKnifeLFwdFullBodyCanvases) || fullBody;
  } else if (isWindUp) {
    // *** PERMANENT RULE — DO NOT CHANGE ***
    // Opponent faces RIGHT. Right-hand swings use LEFT-hand pose sprites, and vice versa.
    // First attack = right hand → knifeLFullBodyCanvases (L pose = correct visual for R-hand swing)
    // Second attack = left hand → knifeRFullBodyCanvases (R pose = correct visual for L-hand swing)
    body = _fpb(isLeftHandWind ? fakePlayerKnifeRFullBodyCanvases : fakePlayerKnifeLFullBodyCanvases) || fullBody;
  } else if (isAttackState && pvpSt.pvpEnemyUnarmed) {
    // Unarmed mirror: R-strike → L-fwd body (atkLTiles), L-strike → R-back body (knifeRTiles).
    // KnifeRFwd canvas uses idle tiles for Monk fake-player, so use KnifeR (back-pose body) for L-strike.
    body = _fpb(isLeftHandAtk ? fakePlayerKnifeRFullBodyCanvases : fakePlayerKnifeLFwdFullBodyCanvases) || fullBody;
  } else if (isAttackState) {
    // *** PERMANENT RULE — DO NOT CHANGE ***
    // Opponent faces RIGHT. Right-hand → L pose sprites. Left-hand → R pose sprites.
    body = _fpb(isLeftHandAtk ? fakePlayerKnifeRFwdFullBodyCanvases : fakePlayerKnifeLFwdFullBodyCanvases) || fullBody;
  } else if (isOppDefending || isOppItemUse) {
    body = _fpb(fakePlayerVictoryFullBodyCanvases) || fullBody;
  } else if (isOppVictory && (Math.floor(Date.now() / 250) & 1)) {
    body = _fpb(fakePlayerVictoryFullBodyCanvases) || fullBody;
  } else if (isNearFatalOpp && !isOppVictory) {
    body = _fpb(fakePlayerKneelFullBodyCanvases) || fullBody;
  }

  // Opponent faces RIGHT (pre-flipped body canvas), player faces LEFT.
  // Player (faces left): wind-up at px+8 (right/behind), swung at px-16 (left/forward).
  // Opponent (faces right): body is pre-h-flipped, so blade uses translate+scale(-1,1) to mirror offsets.
  const blades = getBlades();
  let blade = null;
  if (isWindUp || isAttackState) {
    // Same as NES: raised (hflip tile) = back-swing, swung (normal tile) = forward strike
    if      (wpn === 'knife' && activeWeaponId === 0x1F) blade = isAttackState ? blades.dagger.swung : blades.dagger.raised;
    else if (wpn === 'knife')  blade = isAttackState ? blades.knife.swung  : blades.knife.raised;
    else if (wpn === 'sword')  blade = isAttackState ? blades.sword.swung  : blades.sword.raised;
    else if (wpn === 'nunchaku') blade = isAttackState ? blades.nunchaku.swung : blades.nunchaku.raised;
    else if (isAttackState)    blade = blades.fist;
  }
  const drawBlade = () => {
    const ctx = ui.ctx;
    // Opponent body is pre-h-flipped — mirror blade coords to match.
    ctx.save();
    ctx.translate(sprX + 16, sprY);
    ctx.scale(-1, 1);
    if (isAttackState && blade === blades.fist) {
      const fistC = getFistCanvas(_jobPalette(_ej, palIdx)) || blade;
      // Opponent slash lasts ~200ms; 100ms cadence → 1 clean up-down bounce per strike, synced with slash frames.
      const fistDy = (Math.floor(battleSt.battleTimer / 100) & 1);
      ctx.drawImage(fistC, -4, 10 + fistDy);
    } else if (isAttackState) {
      ctx.drawImage(blade, -16, 1);
    } else {
      // L-hand back-swing sits 8px further from body than R-hand (NES: +16 vs +8)
      ctx.drawImage(blade, isLeftHandWind ? 8 : 16, -7);
    }
    ctx.restore();
  };

  // Wind-up: blade behind body (pulled back); swung/fist: blade in front
  if (isWindUp && blade) drawBlade();
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
  if (isAttackState && blade) drawBlade();

  // Near-fatal sweat — h-flipped to match opponent facing left
  if (isNearFatalOpp && !isOppVictory && !isDying && bsc.sweatFrames && bsc.sweatFrames.length === 2) {
    const sf = bsc.sweatFrames[Math.floor(Date.now() / 133) & 1];
    const ctx = ui.ctx;
    ctx.save();
    ctx.translate(sprX + sf.width, sprY - 3);
    ctx.scale(-1, 1);
    ctx.drawImage(sf, 0, 0);
    ctx.restore();
  }

  // Defend sparkle — 4 frames cycling over 533ms, full-body corners
  if (isOppDefending && bsc.defendSparkleFrames && bsc.defendSparkleFrames.length === 4) {
    const fi = Math.min(3, Math.floor(battleSt.battleTimer / DEFEND_SPARKLE_FRAME_MS));
    _drawSparkleAtCorners(sprX, sprY, bsc.defendSparkleFrames[fi]);
  }
  // Cure sparkle — alternating over main opponent during potion use
  if (isMain && bs === 'pvp-opp-potion' && bsc.cureSparkleFrames && bsc.cureSparkleFrames.length === 2) {
    const fi = Math.floor(battleSt.battleTimer / 67) & 1;
    _drawSparkleAtCorners(sprX, sprY, bsc.cureSparkleFrames[fi]);
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
      if (aSlashF && aSlashF[af]) ui.ctx.drawImage(aSlashF[af], sprX + [0,10,-8][af], sprY + [0,-6,8][af]);
    }
  }
}
