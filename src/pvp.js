// PVP duel system — state, AI logic, rendering
// Shared context pattern: exported entry-points set module-level _s = shared,
// private helpers access _s directly.

import { playSFX, stopSFX, SFX, pauseMusic, playTrack, TRACKS } from './music.js';
import { calcDamage, BOSS_HIT_RATE, GOBLIN_HIT_RATE, CRIT_RATE } from './battle-math.js';
import { ITEMS, isWeapon, weaponSubtype } from './data/items.js';
import { PLAYER_POOL, generateAllyStats } from './data/players.js';
import { MONSTERS } from './data/monsters.js';
import { ps } from './player-stats.js';
import { inputSt } from './input-handler.js';
import { getShieldEvade } from './player-stats.js';
import { pvpGridLayout, PVP_CELL_W, PVP_CELL_H } from './pvp-math.js';
import { playSlashSFX } from './battle-sfx.js';

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

// ── Mutable PVP state (imported directly by game.js) ─────────────────────────
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
let _s = null;
// _playSlashSFX moved to battle-sfx.js → playSlashSFX

// ── Init / teardown ───────────────────────────────────────────────────────────
export function startPVPBattle(shared, target) {
  _s = shared;
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
  _s.enemyHP       = pvpSt.pvpOpponentStats.maxHP;
  _s.enemyDefeated = false;
  _s.isRandomEncounter = false;
  _s.preBattleTrack    = TRACKS.CRYSTAL_CAVE;
  _s.battleState  = 'flash-strobe';
  _s.battleTimer  = 0;
  playSFX(SFX.BATTLE_SWIPE);
  _s.resetBattleVars();
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
  pvpSt._oppSWTargets           = [];
  pvpSt._oppSWHitIdx            = 0;
  pvpSt._oppSWPerDmg            = 0;
  pvpSt._swDmgApplied           = false;
  pvpSt._oppSWExplosionPlayed   = false;
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
  _s.battleState = 'pvp-ally-appear';
  _s.battleTimer = 0;
  return true;
}

// ── Full PVP battle update (called from game.js updateBattle when isPVPBattle) ─
function _updatePVPOpening() {
  const bs = _s.battleState;
  if (bs === 'flash-strobe') {
    if (_s.battleTimer >= BATTLE_FLASH_FRAMES * BATTLE_FLASH_FRAME_MS) {
      _s.battleState = 'enemy-box-expand'; _s.battleTimer = 0;
      playTrack(TRACKS.BATTLE); // map music already paused in startPVPBattle
    }
  } else if (bs === 'enemy-box-expand') {
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
      if (_s.tryJoinPlayerAlly()) return true;
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
function _buildPVPDyingMap() {
  // Current target: main opponent (grid idx 0) or the ally the player just defeated
  const dyingIdx = pvpSt.pvpPlayerTargetIdx < 0 ? 0 : pvpSt.pvpPlayerTargetIdx + 1;
  pvpSt.pvpDyingMap = new Map([[dyingIdx, 0]]);
}
function _updatePVPDissolve() {
  if (_s.battleState !== 'pvp-dissolve') return false;
  if (pvpSt.pvpDyingMap.size === 0) _buildPVPDyingMap();
  const _maxDelay = pvpSt.pvpDyingMap.size > 0 ? Math.max(...pvpSt.pvpDyingMap.values()) : 0;
  if (_s.battleTimer >= MONSTER_DEATH_MS + _maxDelay) {
    pvpSt.pvpDyingMap = new Map();
    _s.battleTimer = 0;
    _s.advancePVPTargetOrVictory();
  }
  return true;
}
export function updatePVPBattle(dt, shared) {
  _s = shared;
  _s.updateTimers(dt);
  _updatePVPOpening()         ||
  _updatePVPMenuConfirm()     ||
  _updatePVPAllyAppear()      ||
  _updatePVPDissolve()        ||
  _s.handlePlayerAttack()     ||
  _s.handleDefendItem(dt)     ||
  _s.handleAlly()             ||
  updateBattleEnemyTurn(_s)   ||
  _s.handleEndSequence(dt);
}

// ── Enemy turn update ─────────────────────────────────────────────────────────
export function updateBattleEnemyTurn(shared) {
  _s = shared;
  if (_processEnemyFlash()) return true;
  if (_processPVPDefendAnim()) return true;
  if (_processPVPEnemySlash()) return true;
  if (_processPVPOppPotion()) return true;
  if (_processPVPOppSWThrow()) return true;
  if (_processPVPOppSWHit()) return true;
  if (_s.battleState === 'enemy-attack') {
    if (_s.battleTimer >= BATTLE_SHAKE_MS) { _s.battleState = 'enemy-damage-show'; _s.battleTimer = 0; }
  } else if (_s.battleState === 'enemy-damage-show') { _processEnemyDamageShow();
  } else if (_s.battleState === 'pvp-second-windup') { _processPVPSecondWindup();
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
  if (targetAlly >= 0) {
    // Ally target — sum all pre-rolled hits, apply total at once
    _s.enemyTargetAllyIdx = targetAlly;
    let totalDmg = 0, anyCrit = false, allMiss = true;
    for (const h of pvpSt.pvpEnemyHitResults) {
      if (!h.miss) { totalDmg += h.dmg; allMiss = false; if (h.crit) anyCrit = true; }
    }
    if (!allMiss) {
      _s.battleAllies[targetAlly].hp = Math.max(0, _s.battleAllies[targetAlly].hp - totalDmg);
      _s.allyDamageNums[targetAlly] = { value: totalDmg, crit: anyCrit, timer: 0 };
      _s.allyShakeTimer[targetAlly] = BATTLE_SHAKE_MS;
      if (anyCrit) _s.critFlashTimer = 0;
      playSFX(attackerStats ? _pvpAttackerSFX(attackerStats.weaponId) : SFX.ATTACK_HIT);
      _s.battleState = 'ally-hit'; _s.battleTimer = 0;
    } else {
      _s.allyDamageNums[targetAlly] = { miss: true, timer: 0 };
      _s.battleState = 'ally-damage-show-enemy'; _s.battleTimer = 0;
    }
  } else {
    // Player target — stage first hit for slash combo
    pvpSt.pvpPendingAttack = pvpSt.pvpEnemyHitResults[0] || { miss: true, shieldBlock: false, dmg: 0, crit: false };
    const pendingCrit = pvpSt.pvpPendingAttack && pvpSt.pvpPendingAttack.crit;
    const wId = attackerStats ? attackerStats.weaponId : null;
    if (wId != null) playSlashSFX(wId, pendingCrit); else playSFX(SFX.ATTACK_HIT);
    _s.battleState = 'pvp-enemy-slash'; _s.battleTimer = 0;
  }
}

function _processEnemyFlash() {
  if (_s.battleState !== 'enemy-flash') return false;

  // On first tick of enemy-flash, decide defend/item for PVP main opponent (skip backswing for non-attack)
  if (!pvpSt.pvpPreflashDecided && pvpSt.isPVPBattle && pvpSt.pvpCurrentEnemyAllyIdx < 0) {
    pvpSt.pvpPreflashDecided = true;
    if (Math.random() < 0.30) {
      pvpSt.pvpOpponentIsDefending = true;
      pvpSt.pvpPendingTargetAlly = -1;
      playSFX(SFX.DEFEND_HIT);
      _s.battleState = 'pvp-defend-anim'; _s.battleTimer = 0;
      return true;
    }
    const maxHP = pvpSt.pvpOpponentStats.maxHP;
    const curHP = pvpSt.pvpOpponentStats.hp;
    const heal = Math.min(50, maxHP - curHP);
    if (curHP < maxHP * 0.5 && heal > 0 && Math.random() < 0.25) {
      pvpSt.pvpOpponentStats.hp = curHP + heal;
      _s.enemyHealNum = { value: heal, timer: 0 };
      playSFX(SFX.CURE);
      _s.battleState = 'pvp-opp-potion'; _s.battleTimer = 0;
      return true;
    }
    if (Math.random() < 0.15) {
      _s.battleState = 'pvp-opp-sw-throw'; _s.battleTimer = 0;
      return true;
    }
    // Decided: will attack — fall through to windup animation
  }

  if (_s.battleTimer < BOSS_PREFLASH_MS) return false;

  // Pre-flash elapsed — resolve attack
  const livingAllies = _s.battleAllies.filter(a => a.hp > 0);
  let targetAlly = -1;
  if (livingAllies.length > 0) {
    const allyOptions = _s.battleAllies.map((a, i) => a.hp > 0 ? i : -1).filter(i => i >= 0);
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
  const baseHits = attackerStats?.attackRoll || Math.max(1, Math.floor((attackerStats ? attackerStats.agi : 5) / 10));
  const potentialHits = dualWield ? Math.max(2, baseHits) : Math.max(1, baseHits);

  pvpSt.pvpEnemyHitResults = [];
  pvpSt.pvpEnemyHitIdx = 0;
  pvpSt.pvpEnemyDualWield = dualWield;
  const critBonus = Math.floor(atk / 4);
  if (targetAlly >= 0) {
    const def = _s.battleAllies[targetAlly].def;
    for (let i = 0; i < potentialHits; i++) {
      if (Math.random() * 100 < hitRate) {
        const crit = Math.random() * 100 < CRIT_RATE;
        const dmg = calcDamage(atk, def, crit, critBonus);
        pvpSt.pvpEnemyHitResults.push({ miss: false, shieldBlock: false, dmg, crit });
      } else {
        pvpSt.pvpEnemyHitResults.push({ miss: true, shieldBlock: false, dmg: 0, crit: false });
      }
    }
  } else {
    const shieldEvade = getShieldEvade(ITEMS);
    for (let i = 0; i < potentialHits; i++) {
      const shieldBlocked = shieldEvade > 0 && Math.random() * 100 < shieldEvade;
      if (shieldBlocked) {
        pvpSt.pvpEnemyHitResults.push({ miss: false, shieldBlock: true, dmg: 0, crit: false });
      } else if (ps.evade > 0 && Math.random() * 100 < ps.evade) {
        pvpSt.pvpEnemyHitResults.push({ miss: true, shieldBlock: false, dmg: 0, crit: false });
      } else if (Math.random() * 100 < hitRate) {
        const crit = Math.random() * 100 < CRIT_RATE;
        let dmg = calcDamage(atk, ps.def, crit, critBonus);
        if (_s.isDefending) dmg = Math.max(1, Math.floor(dmg / 2));
        pvpSt.pvpEnemyHitResults.push({ miss: false, shieldBlock: false, dmg, crit });
      } else {
        pvpSt.pvpEnemyHitResults.push({ miss: true, shieldBlock: false, dmg: 0, crit: false });
      }
    }
  }

  _runEnemyAttack(targetAlly);
  return true;
}

function _processPVPDefendAnim() {
  if (_s.battleState !== 'pvp-defend-anim') return false;
  if (_s.battleTimer >= DEFEND_SPARKLE_TOTAL_MS) _s.processNextTurn(); // defend is the full action
  return true;
}

function _processPVPOppPotion() {
  if (_s.battleState !== 'pvp-opp-potion') return false;
  if (_s.battleTimer >= DEFEND_SPARKLE_TOTAL_MS) {
    _s.enemyHealNum = null;
    _s.processNextTurn();
  }
  return true;
}

function _processPVPOppSWThrow() {
  if (_s.battleState !== 'pvp-opp-sw-throw') return false;
  if (_s.battleTimer >= 250) {
    // Build target list: player + living allies
    const targets = [];
    if (ps.hp > 0) targets.push(-1);
    for (let i = 0; i < _s.battleAllies.length; i++) {
      if (_s.battleAllies[i].hp > 0) targets.push(i);
    }
    if (targets.length === 0) { _s.processNextTurn(); return true; }
    // Roll damage using INT (5 + level), matching player formula (no defense calc)
    const int = 5 + (pvpSt.pvpOpponentStats.level || 1);
    const swAtk = Math.floor(int / 2) + 55;
    const swBase = Math.floor((swAtk + Math.floor(Math.random() * Math.floor(swAtk / 2 + 1))) / 2);
    pvpSt._oppSWTargets = targets;
    pvpSt._oppSWHitIdx = 0;
    pvpSt._oppSWPerDmg = Math.max(1, Math.floor(swBase / targets.length));
    pvpSt._swDmgApplied = false;
    _s.battleState = 'pvp-opp-sw-hit'; _s.battleTimer = 0;
  }
  return true;
}

function _processPVPOppSWHit() {
  if (_s.battleState !== 'pvp-opp-sw-hit') return false;
  const targets = pvpSt._oppSWTargets;
  if (!targets || targets.length === 0) { _s.processNextTurn(); return true; }
  const tidx = targets[pvpSt._oppSWHitIdx];
  // At 0ms: explosion SFX
  if (!pvpSt._oppSWExplosionPlayed) {
    pvpSt._oppSWExplosionPlayed = true;
    playSFX(SFX.SW_HIT);
  }
  // At 400ms: apply damage + hit SFX
  if (_s.battleTimer >= 400 && !pvpSt._swDmgApplied) {
    const dmg = pvpSt._oppSWPerDmg;
    if (tidx === -1) {
      ps.hp = Math.max(0, ps.hp - dmg);
      _s.playerDamageNum = { value: dmg, timer: 0 };
      _s.battleShakeTimer = BATTLE_SHAKE_MS;
    } else {
      const ally = _s.battleAllies[tidx];
      if (ally && ally.hp > 0) {
        ally.hp = Math.max(0, ally.hp - dmg);
        _s.allyDamageNums[tidx] = { value: dmg, timer: 0 };
        _s.allyShakeTimer[tidx] = BATTLE_SHAKE_MS;
      }
    }
    playSFX(SFX.ATTACK_HIT);
    pvpSt._swDmgApplied = true;
  }
  // At 1100ms: next target or done
  if (_s.battleTimer >= 1100) {
    if (tidx === -1) _s.playerDamageNum = null;
    pvpSt._oppSWHitIdx++;
    pvpSt._swDmgApplied = false;
    pvpSt._oppSWExplosionPlayed = false;
    if (pvpSt._oppSWHitIdx < targets.length) {
      _s.battleTimer = 0;
    } else {
      pvpSt._oppSWTargets = [];
      pvpSt._oppSWHitIdx = 0;
      // Trigger death animations for killed allies
      for (let i = 0; i < _s.battleAllies.length; i++) {
        const ally = _s.battleAllies[i];
        if (ally.hp <= 0 && ally.deathTimer == null) {
          ally.deathTimer = 0;
          _s.turnQueue = _s.turnQueue.filter(t => !(t.type === 'ally' && t.index === i));
        }
      }
      if (_s.isTeamWiped()) {
        _s.isDefending = false; _s.battleState = 'team-wipe'; _s.battleTimer = 0;
      } else {
        _s.processNextTurn();
      }
    }
  }
  return true;
}

function _processEnemyDamageShow() {
  if (_s.battleTimer < BATTLE_DMG_SHOW_MS) return;
  if (_s.isTeamWiped()) {
    _s.isDefending = false; _s.battleState = 'team-wipe'; _s.battleTimer = 0;
  } else { _s.processNextTurn(); }
}

function _processPVPSecondWindup() {
  if (_s.battleTimer < BOSS_PREFLASH_MS) return;
  // Stage next pre-rolled hit from combo
  const hit = pvpSt.pvpEnemyHitResults[pvpSt.pvpEnemyHitIdx];
  pvpSt.pvpPendingAttack = hit || { miss: true, shieldBlock: false, dmg: 0, crit: false };
  const attackerStats = pvpSt.pvpCurrentEnemyAllyIdx >= 0
    ? pvpSt.pvpEnemyAllies[pvpSt.pvpCurrentEnemyAllyIdx]
    : pvpSt.pvpOpponentStats;
  // Alternate weapon hand: even = R, odd = L
  const isLeftHit = (pvpSt.pvpEnemyHitIdx % 2 === 1) && attackerStats && isWeapon(attackerStats.weaponL);
  const wId = isLeftHit ? attackerStats.weaponL : (attackerStats ? attackerStats.weaponId : null);
  if (wId != null) playSlashSFX(wId, hit && hit.crit); else playSFX(SFX.ATTACK_HIT);
  _s.battleState = 'pvp-enemy-slash'; _s.battleTimer = 0;
}

function _processPVPEnemySlash() {
  if (_s.battleState !== 'pvp-enemy-slash') return false;
  if (_s.battleTimer < ENEMY_SLASH_TOTAL_MS) return true;
  const pending = pvpSt.pvpPendingAttack;
  pvpSt.pvpPendingAttack = null;
  // Apply this hit's damage immediately (but don't show number yet — sum at end)
  if (pending && !pending.miss && !pending.shieldBlock) {
    ps.hp = Math.max(0, ps.hp - pending.dmg);
    if (pending.crit) _s.critFlashTimer = 0;
    _s.battleShakeTimer = BATTLE_SHAKE_MS;
  }
  if (pending && pending.shieldBlock) {
    // shield block counts as an action for JP
  }
  // Advance combo
  if (pvpSt.pvpEnemyHitIdx + 1 < pvpSt.pvpEnemyHitResults.length) {
    pvpSt.pvpEnemyHitIdx++;
    // More hits — windup for next slash
    _s.battleState = 'pvp-second-windup'; _s.battleTimer = 0;
  } else {
    // Finalize — sum all hits into one damage number
    let totalDmg = 0, anyCrit = false, allMiss = true;
    for (const h of pvpSt.pvpEnemyHitResults) {
      if (!h.miss && !h.shieldBlock) { totalDmg += h.dmg; allMiss = false; if (h.crit) anyCrit = true; }
    }
    _s.playerDamageNum = allMiss ? { miss: true, timer: 0 } : { value: totalDmg, crit: anyCrit, timer: 0 };
    _s.battleState = 'enemy-attack'; _s.battleTimer = 0;
  }
  return true;
}

// ── Rendering ─────────────────────────────────────────────────────────────────
// Mirrors game.js _drawSparkleCorners but uses _s.ctx. Wraps a 16×24 body at (sprX, sprY).
function _drawSparkleAtCorners(sprX, sprY, frame) {
  const ctx = _s.ctx;
  ctx.drawImage(frame, sprX - 8, sprY - 7);
  ctx.save(); ctx.scale(-1, 1); ctx.drawImage(frame, -(sprX + 23), sprY - 7); ctx.restore();
  ctx.save(); ctx.scale(1, -1); ctx.drawImage(frame, sprX - 8, -(sprY + 32)); ctx.restore();
  ctx.save(); ctx.scale(-1, -1); ctx.drawImage(frame, -(sprX + 23), -(sprY + 32)); ctx.restore();
}

export function drawBossSpriteBoxPVP(shared, centerX, centerY) {
  _s = shared;
  const bs = _s.battleState;
  const isExpand = bs === 'enemy-box-expand';
  const isClose  = bs === 'enemy-box-close' || (!_s.isRandomEncounter && bs === 'defeat-close');
  const totalEnemies = 1 + pvpSt.pvpEnemyAllies.length;
  const { cols, rows, gridPos } = pvpGridLayout(totalEnemies);
  const pvpBoxW = cols * PVP_CELL_W + 16;
  const pvpBoxH = rows * PVP_CELL_H + 16;

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
    const intLeft = centerX - cols * Math.floor(PVP_CELL_W / 2);
    const intTop  = centerY - rows * Math.floor(PVP_CELL_H / 2);
    const allEnemies = [pvpSt.pvpOpponentStats, ...pvpSt.pvpEnemyAllies.slice(0, visibleAllies)];
    allEnemies.forEach((enemy, idx) => {
      if (enemy) _drawPVPEnemyCell(enemy, idx, gridPos, intLeft, intTop, PVP_CELL_W, PVP_CELL_H, resizeT);
    });
    // Target cursor during target-select or item-target-select
    if ((bs === 'target-select' || (bs === 'item-target-select' && inputSt.itemTargetType === 'enemy')) && _s.cursorTileCanvas) {
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
            _s.ctx.drawImage(_s.cursorTileCanvas, tx - 14, ty + 4);
          }
        }
      } else {
        const tIdx = bs === 'item-target-select'
          ? inputSt.itemTargetIndex
          : (pvpSt.pvpPlayerTargetIdx < 0 ? 0 : pvpSt.pvpPlayerTargetIdx + 1);
        const [gr, gc] = gridPos[tIdx] || gridPos[0];
        const tx = intLeft + gc * PVP_CELL_W + 4;
        const ty = intTop  + gr * PVP_CELL_H + 4;
        _s.ctx.drawImage(_s.cursorTileCanvas, tx - 14, ty + 4);
      }
    }
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
  const _ej = enemy.jobIdx || 0;
  const _fpb = (map) => (map[_ej] || map[0])[palIdx];
  const fullBody = _fpb(_s.fullBodyCanvases) || (_s.fullBodyCanvases[0] || [])[0];
  if (!fullBody) return;
  // Hide dead enemies — but keep visible during dissolve and attack sequence
  const isDying = pvpSt.pvpDyingMap.has(idx) && bs === 'pvp-dissolve';
  const isCurrentTarget = isMain ? pvpSt.pvpPlayerTargetIdx < 0 : (idx - 1) === pvpSt.pvpPlayerTargetIdx;
  const isSWHit = bs === 'sw-hit' || bs === 'sw-throw';
  const isBeingKilled = isCurrentTarget && (bs === 'player-slash' || bs === 'player-hit-show' ||
    bs === 'player-damage-show' || bs === 'ally-slash' || bs === 'ally-damage-show');
  if (isMain && (_s.enemyDefeated || (pvpSt.pvpOpponentStats && pvpSt.pvpOpponentStats.hp <= 0)) && !isDying && !isBeingKilled && !isSWHit) return;
  if (!isMain && (_s.enemyDefeated || enemy.hp <= 0) && !isDying && !isBeingKilled && !isSWHit) return;
  // Shake left when taking damage (mirrors player's right-shake on hit)
  if (isCurrentTarget && pvpSt.pvpOpponentShakeTimer > 0) {
    sprX += (Math.floor(pvpSt.pvpOpponentShakeTimer / 67) & 1) ? -2 : 2;
  }
  const isThisAttacking = isMain
    ? pvpSt.pvpCurrentEnemyAllyIdx < 0
    : pvpSt.pvpCurrentEnemyAllyIdx === idx - 1;
  // Hit pose: only during the slash impact and brief flinch — NOT the full 700ms damage display
  const playerHitLanded = bs === 'player-slash' &&
    inputSt.hitResults && inputSt.hitResults[_s.currentHitIdx] && !inputSt.hitResults[_s.currentHitIdx].miss;
  const allyHitLanded = bs === 'ally-slash' && _s.allyHitResult && !_s.allyHitResult.miss;
  const playerHitShowLanded = bs === 'player-hit-show' && inputSt.hitResults && inputSt.hitResults[_s.currentHitIdx] && !inputSt.hitResults[_s.currentHitIdx].miss;
  const isOppHit = isCurrentTarget && (playerHitLanded || playerHitShowLanded || allyHitLanded ||
    (bs === 'ally-damage-show' && _s.allyHitResult && !_s.allyHitResult.miss));
  const blinkHidden = isCurrentTarget && (playerHitLanded || allyHitLanded) && (Math.floor(_s.battleTimer / 60) & 1);
  const isWindUp = isThisAttacking && ((bs === 'enemy-flash' && (pvpSt.pvpPreflashDecided || !isMain)) || bs === 'pvp-second-windup');
  if (blinkHidden) return;

  // Which hand is this enemy using right now?
  // Even hit index = right hand, odd = left hand (if dual-wielding)
  const isAttackState = isThisAttacking && (bs === 'enemy-attack' || bs === 'pvp-enemy-slash' || bs === 'ally-hit');
  const isLeftHandWind = isMain && bs === 'pvp-second-windup' && pvpSt.pvpEnemyHitIdx % 2 === 1 && pvpSt.pvpEnemyDualWield;
  const isLeftHandAtk  = isMain && isAttackState && pvpSt.pvpEnemyHitIdx % 2 === 1 && pvpSt.pvpEnemyDualWield;
  const activeWeaponId = (isLeftHandWind || isLeftHandAtk)
    ? (enemy.weaponL != null ? enemy.weaponL : enemy.weaponId)
    : enemy.weaponId;
  const wpn = weaponSubtype(activeWeaponId);

  // Body canvas — drawn directly (pre-h-flipped canvases face left, matching enemy-side visual style)
  // MIRRORING RULE: opponent faces left, so R-hand canvases look like L-hand after flip and vice versa.
  // Use the opposite hand's canvas to get the correct visual for each hand.
  const oppHP   = isMain ? (pvpSt.pvpOpponentStats ? pvpSt.pvpOpponentStats.hp : _s.enemyHP) : (enemy.hp != null ? enemy.hp : 0);
  const oppMaxHP = isMain ? (pvpSt.pvpOpponentStats ? pvpSt.pvpOpponentStats.maxHP : 1) : (enemy.maxHP || 1);
  const isNearFatalOpp = oppHP > 0 && oppHP <= Math.floor(oppMaxHP / 4);
  // Opponent victory = team wiped or old defeat path
  const isOppVictory = _s.battleState === 'team-wipe' || _s.battleState === 'defeat-monster-fade';
  const isOppDefending = isMain && pvpSt.pvpOpponentIsDefending && bs === 'pvp-defend-anim';
  const isOppItemUse   = isMain && (bs === 'pvp-opp-sw-throw' || bs === 'pvp-opp-sw-hit' || bs === 'pvp-opp-potion');
  let body = fullBody;
  if (isOppHit && _fpb(_s.hitFullBodyCanvases)) {
    body = _fpb(_s.hitFullBodyCanvases);
  } else if (isWindUp) {
    // *** PERMANENT RULE — DO NOT CHANGE ***
    // Opponent faces RIGHT. Right-hand swings use LEFT-hand pose sprites, and vice versa.
    // This is NOT a bug — it's how the NES tile layout works for a right-facing sprite.
    // First attack = right hand → knifeLFullBodyCanvases (L pose = correct visual for R-hand swing)
    // Second attack = left hand → knifeRFullBodyCanvases (R pose = correct visual for L-hand swing)
    body = _fpb(isLeftHandWind ? _s.knifeRFullBodyCanvases : _s.knifeLFullBodyCanvases) || fullBody;
  } else if (isAttackState) {
    // *** PERMANENT RULE — DO NOT CHANGE ***
    // Opponent faces RIGHT. Right-hand → L pose sprites. Left-hand → R pose sprites.
    body = _fpb(isLeftHandAtk ? _s.knifeRFwdFullBodyCanvases : _s.knifeLFwdFullBodyCanvases) || fullBody;
  } else if ((isOppDefending || isOppItemUse) && _s.victoryFullBodyCanvases) {
    body = _fpb(_s.victoryFullBodyCanvases) || fullBody;
  } else if (isOppVictory && _s.victoryFullBodyCanvases && (Math.floor(Date.now() / 250) & 1)) {
    body = _fpb(_s.victoryFullBodyCanvases) || fullBody;
  } else if (isNearFatalOpp && !isOppVictory && _s.kneelFullBodyCanvases) {
    body = _fpb(_s.kneelFullBodyCanvases) || fullBody;
  }

  // Opponent faces RIGHT (pre-flipped body canvas), player faces LEFT.
  // Player (faces left): wind-up at px+8 (right/behind), swung at px-16 (left/forward).
  // Opponent (faces right): body is pre-h-flipped, so blade uses translate+scale(-1,1) to mirror offsets.
  const blades = _s.blades;
  let blade = null;
  if (isWindUp || isAttackState) {
    // Same as NES: raised (hflip tile) = back-swing, swung (normal tile) = forward strike
    if      (wpn === 'knife' && activeWeaponId === 0x1F) blade = isAttackState ? blades.dagger.swung : blades.dagger.raised;
    else if (wpn === 'knife')  blade = isAttackState ? blades.knife.swung  : blades.knife.raised;
    else if (wpn === 'sword')  blade = isAttackState ? blades.sword.swung  : blades.sword.raised;
    else if (isAttackState)    blade = blades.fist;
  }
  const drawBlade = () => {
    const ctx = _s.ctx;
    // Opponent body is pre-h-flipped — mirror blade coords to match.
    ctx.save();
    ctx.translate(sprX + 16, sprY);
    ctx.scale(-1, 1);
    if (isAttackState && blade === blades.fist) {
      ctx.drawImage(blade, -4, 10);
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
    const deathFrames = _s.fakePlayerDeathFrames && _fpb(_s.fakePlayerDeathFrames);
    if (deathFrames && deathFrames.length) {
      const progress = Math.min(Math.max(0, _s.battleTimer - delay) / MONSTER_DEATH_MS, 1);
      const fi = Math.min(deathFrames.length - 1, Math.floor(progress * deathFrames.length));
      _s.ctx.drawImage(deathFrames[fi], sprX, sprY);
    }
  } else {
    _s.ctx.drawImage(body, sprX, sprY);
  }
  if (isAttackState && blade) drawBlade();

  // Near-fatal sweat — h-flipped to match opponent facing left
  if (isNearFatalOpp && !isOppVictory && !isDying && _s.sweatFrames && _s.sweatFrames.length === 2) {
    const sf = _s.sweatFrames[Math.floor(Date.now() / 133) & 1];
    const ctx = _s.ctx;
    ctx.save();
    ctx.translate(sprX + sf.width, sprY - 3);
    ctx.scale(-1, 1);
    ctx.drawImage(sf, 0, 0);
    ctx.restore();
  }

  // Defend sparkle — 4 frames cycling over 533ms, full-body corners
  if (isOppDefending && _s.defendSparkleFrames && _s.defendSparkleFrames.length === 4) {
    const fi = Math.min(3, Math.floor(_s.battleTimer / DEFEND_SPARKLE_FRAME_MS));
    _drawSparkleAtCorners(sprX, sprY, _s.defendSparkleFrames[fi]);
  }
  // Cure sparkle — alternating over main opponent during potion use
  if (isMain && bs === 'pvp-opp-potion' && _s.cureSparkleFrames && _s.cureSparkleFrames.length === 2) {
    const fi = Math.floor(_s.battleTimer / 67) & 1;
    _drawSparkleAtCorners(sprX, sprY, _s.cureSparkleFrames[fi]);
  }

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
