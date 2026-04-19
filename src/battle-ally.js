// Battle ally update logic — extracted from game.js

import { battleSt, getEnemyHP, setEnemyHP, BATTLE_SHAKE_MS, BATTLE_DMG_SHOW_MS } from './battle-state.js';
import { playSlashSFX } from './battle-sfx.js';
import { isWeapon } from './data/items.js';
import { SFX, playSFX } from './music.js';
import { _nameToBytes } from './text-utils.js';
import { queueBattleMsg } from './battle-msg.js';
import { pvpSt } from './pvp.js';
import { inputSt } from './input-handler.js';
import { getEnemyDmgNum, setEnemyDmgNum } from './damage-numbers.js';
import { ROSTER_FADE_STEPS } from './data/players.js';

// Injected at boot — avoids circular import on main.js
let _buildTurnOrder = () => [];
let _processNextTurn = () => {};
let _isTeamWiped = () => false;
export function initBattleAlly({ buildTurnOrder, processNextTurn, isTeamWiped }) {
  _buildTurnOrder = buildTurnOrder;
  _processNextTurn = processNextTurn;
  _isTeamWiped = isTeamWiped;
}

// ── Combo finalization ───────────────────────────────────────────────────────
function _finalizeAllyCombo() {
  let totalDmg = 0, anyCrit = false, allMiss = true, hitsLanded = 0;
  for (const h of battleSt.allyHitResults) {
    if (!h.miss) { totalDmg += h.damage; allMiss = false; hitsLanded++; if (h.crit) anyCrit = true; }
  }
  setEnemyDmgNum(allMiss ? { miss: true, timer: 0 } : { value: totalDmg, crit: anyCrit, timer: 0 });
  inputSt.targetIndex = battleSt.allyTargetIndex;
}

// ── After damage-show: check for death/dissolve or advance turn ──────────────
function _updateAllyDamageShow() {
  if (battleSt.isRandomEncounter && battleSt.encounterMonsters && battleSt.allyTargetIndex >= 0 && battleSt.encounterMonsters[battleSt.allyTargetIndex].hp <= 0) {
    battleSt.dyingMonsterIndices = new Map([[battleSt.allyTargetIndex, 0]]);
    battleSt.battleState = 'monster-death'; battleSt.battleTimer = 0; playSFX(SFX.MONSTER_DEATH);
  } else if (!battleSt.isRandomEncounter && getEnemyHP() <= 0) {
    if (pvpSt.isPVPBattle) {
      battleSt.battleState = 'pvp-dissolve'; battleSt.battleTimer = 0; playSFX(SFX.MONSTER_DEATH);
    } else { battleSt.battleState = 'boss-dissolve'; battleSt.battleTimer = 0; playSFX(SFX.BOSS_DEATH); }
  } else {
    _processNextTurn();
  }
}

// ── Ally join fade-in ────────────────────────────────────────────────────────
function _updateAllyJoin() {
  if (battleSt.battleState === 'ally-fade-in') {
    const newAlly = battleSt.battleAllies[battleSt.battleAllies.length - 1];
    if (newAlly && battleSt.battleTimer >= 100) {
      newAlly.fadeStep = Math.max(0, newAlly.fadeStep - 1);
      battleSt.battleTimer = 0;
      if (newAlly.fadeStep <= 0) { battleSt.turnQueue = _buildTurnOrder(); _processNextTurn(); }
    }
    return true;
  }
  return false;
}

// ── Ally attack combo (multi-hit with summed damage) ─────────────────────────
const ALLY_BACK_MS = 40;
const ALLY_FWD_MS = 40;
const ALLY_SLASH_MS = 90;
const ALLY_COMBO_PAUSE_MS = 30;

function _updateAllyAttack() {
  if (battleSt.battleState === 'ally-attack-back') {
    const delay = battleSt.allyHitIdx === 0 ? ALLY_BACK_MS : ALLY_COMBO_PAUSE_MS;
    if (battleSt.battleTimer >= delay) {
      const ally = battleSt.battleAllies[battleSt.currentAllyAttacker];
      if (battleSt.allyHitIdx === 0 && ally) {
        queueBattleMsg(_nameToBytes(ally.name || 'Ally'));
      }
      const isLeft = (battleSt.allyHitIdx % 2 === 1) && ally && isWeapon(ally.weaponL);
      battleSt.allyHitIsLeft = isLeft;
      battleSt.battleState = 'ally-attack-fwd';
      battleSt.battleTimer = 0;
    }
    return true;
  }
  if (battleSt.battleState === 'ally-attack-fwd') {
    if (battleSt.battleTimer >= ALLY_FWD_MS) {
      const ally = battleSt.battleAllies[battleSt.currentAllyAttacker];
      const isLeft = battleSt.allyHitIsLeft;
      const activeWpn = isLeft ? ally.weaponL : (ally && ally.weaponId);
      const hit = battleSt.allyHitResults[battleSt.allyHitIdx];
      battleSt.allyHitResult = hit;
      playSlashSFX(activeWpn, hit && hit.crit);
      battleSt.battleState = 'ally-slash';
      battleSt.battleTimer = 0;
    }
    return true;
  }
  if (battleSt.battleState === 'ally-slash') {
    if (battleSt.battleTimer >= ALLY_SLASH_MS) {
      const hit = battleSt.allyHitResults[battleSt.allyHitIdx];
      if (hit && !hit.miss) {
        // Defend halving for PVP opponent
        if (pvpSt.isPVPBattle && pvpSt.pvpOpponentIsDefending && battleSt.allyTargetIndex < 0)
          hit.damage = Math.max(1, Math.floor(hit.damage / 2));
        // Apply damage per hit
        if (battleSt.allyTargetIndex >= 0 && battleSt.encounterMonsters) {
          battleSt.encounterMonsters[battleSt.allyTargetIndex].hp = Math.max(0, battleSt.encounterMonsters[battleSt.allyTargetIndex].hp - hit.damage);
        } else if (battleSt.allyTargetIndex < 0) {
          setEnemyHP(Math.max(0, getEnemyHP() - hit.damage));
          if (pvpSt.isPVPBattle) pvpSt.pvpOpponentShakeTimer = BATTLE_SHAKE_MS;
        }
        if (hit.crit) battleSt.critFlashTimer = 0;
      }
      // Advance combo
      battleSt.allyHitIdx = battleSt.allyHitIdx + 1;
      if (battleSt.allyHitIdx < battleSt.allyHitResults.length) {
        const nextAlly = battleSt.battleAllies[battleSt.currentAllyAttacker];
        battleSt.allyHitIsLeft = (battleSt.allyHitIdx % 2 === 1) && nextAlly && isWeapon(nextAlly.weaponL);
        battleSt.battleState = 'ally-attack-back';
        battleSt.battleTimer = 0;
      } else {
        _finalizeAllyCombo();
        battleSt.allyHitIsLeft = false;
        battleSt.battleState = 'ally-damage-show';
        battleSt.battleTimer = 0;
      }
    }
    return true;
  }
  return false;
}

// ── Ally taking enemy hit ────────────────────────────────────────────────────
function _updateAllyEnemyHit() {
  if (battleSt.battleState === 'ally-hit') {
    if (battleSt.battleTimer >= BATTLE_SHAKE_MS) { battleSt.battleState = 'ally-damage-show-enemy'; battleSt.battleTimer = 0; }
    return true;
  }
  if (battleSt.battleState === 'ally-damage-show-enemy') {
    if (battleSt.battleTimer >= BATTLE_DMG_SHOW_MS) {
      const ally = battleSt.battleAllies[battleSt.enemyTargetAllyIdx];
      if (ally && ally.hp <= 0) {
        // Start death animation — visual only, battle continues
        ally.deathTimer = 0;
        battleSt.turnQueue = battleSt.turnQueue.filter(t => !(t.type === 'ally' && t.index === battleSt.enemyTargetAllyIdx));
        battleSt.enemyTargetAllyIdx = -1;
        if (_isTeamWiped()) {
          battleSt.battleState = 'team-wipe'; battleSt.battleTimer = 0;
        } else {
          _processNextTurn();
        }
      } else { battleSt.enemyTargetAllyIdx = -1; _processNextTurn(); }
    }
    return true;
  }
  return false;
}

// ── Ally KO sequence ─────────────────────────────────────────────────────────
function _updateAllyKOSequence() {
  if (battleSt.battleState === 'ally-ko-fade') {
    const koAlly = battleSt.battleAllies[battleSt.enemyTargetAllyIdx];
    if (koAlly && battleSt.battleTimer >= 100) {
      koAlly.fadeStep = Math.min(ROSTER_FADE_STEPS, koAlly.fadeStep + 1);
      battleSt.battleTimer = 0;
      if (koAlly.fadeStep >= ROSTER_FADE_STEPS) {
        battleSt.turnQueue = battleSt.turnQueue.filter(t => !(t.type === 'ally' && t.index === battleSt.enemyTargetAllyIdx));
        battleSt.enemyTargetAllyIdx = -1;
        if (_isTeamWiped()) {
          battleSt.battleState = 'team-wipe'; battleSt.battleTimer = 0;
        } else {
          _processNextTurn();
        }
      }
    }
    return true;
  }
  if (battleSt.battleState === 'ally-ko-msg') return true;
  return false;
}

export function updateBattleAlly() {
  if (_updateAllyJoin()) return true;
  if (_updateAllyAttack()) return true;
  if (battleSt.battleState === 'ally-damage-show') { if (battleSt.battleTimer >= 700) _updateAllyDamageShow(); return true; }
  if (_updateAllyEnemyHit()) return true;
  if (_updateAllyKOSequence()) return true;
  return false;
}
