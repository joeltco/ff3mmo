// Battle ally update logic — extracted from game.js

import { playSlashSFX } from './battle-sfx.js';
import { isWeapon } from './data/items.js';
import { SFX, playSFX } from './music.js';
import { _nameToBytes, makeVsMsg } from './text-utils.js';
import { replaceBattleMsg } from './battle-msg.js';
import { BATTLE_CRITICAL } from './data/strings.js';
import { getMonsterName } from './text-decoder.js';

let _s = null;

// ── Combo finalization ───────────────────────────────────────────────────────
function _finalizeAllyCombo() {
  let totalDmg = 0, anyCrit = false, allMiss = true, hitsLanded = 0;
  for (const h of _s.allyHitResults) {
    if (!h.miss) { totalDmg += h.damage; allMiss = false; hitsLanded++; if (h.crit) anyCrit = true; }
  }
  _s.enemyDmgNum = allMiss ? { miss: true, timer: 0 } : { value: totalDmg, crit: anyCrit, timer: 0 };
  _s.inputSt.targetIndex = _s.allyTargetIndex;
  if (!allMiss) {
    if (anyCrit) replaceBattleMsg(BATTLE_CRITICAL);
    else if (hitsLanded > 1) replaceBattleMsg(_nameToBytes(hitsLanded + ' hits!'));
  }
}

// ── After damage-show: check for death/dissolve or advance turn ──────────────
function _updateAllyDamageShow() {
  if (_s.isRandomEncounter && _s.encounterMonsters && _s.allyTargetIndex >= 0 && _s.encounterMonsters[_s.allyTargetIndex].hp <= 0) {
    _s.dyingMonsterIndices = new Map([[_s.allyTargetIndex, 0]]);
    _s.battleState = 'monster-death'; _s.battleTimer = 0; playSFX(SFX.MONSTER_DEATH);
  } else if (!_s.isRandomEncounter && _s.enemyHP <= 0) {
    if (_s.pvpSt.isPVPBattle) {
      _s.battleState = 'pvp-dissolve'; _s.battleTimer = 0; playSFX(SFX.MONSTER_DEATH);
    } else { _s.battleState = 'boss-dissolve'; _s.battleTimer = 0; playSFX(SFX.BOSS_DEATH); }
  } else {
    _s.processNextTurn();
  }
}

// ── Ally join fade-in ────────────────────────────────────────────────────────
function _updateAllyJoin() {
  if (_s.battleState === 'ally-fade-in') {
    const newAlly = _s.battleAllies[_s.battleAllies.length - 1];
    if (newAlly && _s.battleTimer >= 100) {
      newAlly.fadeStep = Math.max(0, newAlly.fadeStep - 1);
      _s.battleTimer = 0;
      if (newAlly.fadeStep <= 0) { _s.turnQueue = _s.buildTurnOrder(); _s.processNextTurn(); }
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
  if (_s.battleState === 'ally-attack-back') {
    const delay = _s.allyHitIdx === 0 ? ALLY_BACK_MS : ALLY_COMBO_PAUSE_MS;
    if (_s.battleTimer >= delay) {
      const ally = _s.battleAllies[_s.currentAllyAttacker];
      if (_s.allyHitIdx === 0 && ally && _s.queueBattleMsg) {
        const allyName = _nameToBytes(ally.name || 'Ally');
        const ti = _s.allyTargetIndex;
        const targetName = (_s.encounterMonsters && ti >= 0)
          ? (getMonsterName(_s.encounterMonsters[ti].monsterId) || _nameToBytes('Enemy'))
          : null;
        _s.queueBattleMsg(targetName ? makeVsMsg(allyName, targetName) : _nameToBytes((ally.name || 'Ally') + ' attacks!'));
      }
      const isLeft = (_s.allyHitIdx % 2 === 1) && ally && isWeapon(ally.weaponL);
      _s.allyHitIsLeft = isLeft;
      _s.battleState = 'ally-attack-fwd';
      _s.battleTimer = 0;
    }
    return true;
  }
  if (_s.battleState === 'ally-attack-fwd') {
    if (_s.battleTimer >= ALLY_FWD_MS) {
      const ally = _s.battleAllies[_s.currentAllyAttacker];
      const isLeft = _s.allyHitIsLeft;
      const activeWpn = isLeft ? ally.weaponL : (ally && ally.weaponId);
      const hit = _s.allyHitResults[_s.allyHitIdx];
      _s.allyHitResult = hit;
      playSlashSFX(activeWpn, hit && hit.crit);
      _s.battleState = 'ally-slash';
      _s.battleTimer = 0;
    }
    return true;
  }
  if (_s.battleState === 'ally-slash') {
    if (_s.battleTimer >= ALLY_SLASH_MS) {
      const hit = _s.allyHitResults[_s.allyHitIdx];
      if (hit && !hit.miss) {
        // Defend halving for PVP opponent
        if (_s.pvpSt.isPVPBattle && _s.pvpSt.pvpOpponentIsDefending && _s.allyTargetIndex < 0)
          hit.damage = Math.max(1, Math.floor(hit.damage / 2));
        // Apply damage per hit
        if (_s.allyTargetIndex >= 0 && _s.encounterMonsters) {
          _s.encounterMonsters[_s.allyTargetIndex].hp = Math.max(0, _s.encounterMonsters[_s.allyTargetIndex].hp - hit.damage);
        } else if (_s.allyTargetIndex < 0) {
          _s.enemyHP = Math.max(0, _s.enemyHP - hit.damage);
          if (_s.pvpSt.isPVPBattle) _s.pvpSt.pvpOpponentShakeTimer = _s.BATTLE_SHAKE_MS;
        }
        if (hit.crit) _s.critFlashTimer = 0;
      }
      // Advance combo
      _s.allyHitIdx = _s.allyHitIdx + 1;
      if (_s.allyHitIdx < _s.allyHitResults.length) {
        const nextAlly = _s.battleAllies[_s.currentAllyAttacker];
        _s.allyHitIsLeft = (_s.allyHitIdx % 2 === 1) && nextAlly && isWeapon(nextAlly.weaponL);
        _s.battleState = 'ally-attack-back';
        _s.battleTimer = 0;
      } else {
        _finalizeAllyCombo();
        _s.allyHitIsLeft = false;
        _s.battleState = 'ally-damage-show';
        _s.battleTimer = 0;
      }
    }
    return true;
  }
  return false;
}

// ── Ally taking enemy hit ────────────────────────────────────────────────────
function _updateAllyEnemyHit() {
  if (_s.battleState === 'ally-hit') {
    if (_s.battleTimer >= _s.BATTLE_SHAKE_MS) { _s.battleState = 'ally-damage-show-enemy'; _s.battleTimer = 0; }
    return true;
  }
  if (_s.battleState === 'ally-damage-show-enemy') {
    if (_s.battleTimer >= _s.BATTLE_DMG_SHOW_MS) {
      const ally = _s.battleAllies[_s.enemyTargetAllyIdx];
      if (ally && ally.hp <= 0) {
        // Start death animation — visual only, battle continues
        ally.deathTimer = 0;
        _s.turnQueue = _s.turnQueue.filter(t => !(t.type === 'ally' && t.index === _s.enemyTargetAllyIdx));
        _s.enemyTargetAllyIdx = -1;
        if (_s.isTeamWiped()) {
          _s.battleState = 'team-wipe'; _s.battleTimer = 0;
        } else {
          _s.processNextTurn();
        }
      } else { _s.enemyTargetAllyIdx = -1; _s.processNextTurn(); }
    }
    return true;
  }
  return false;
}

// ── Ally KO sequence ─────────────────────────────────────────────────────────
function _updateAllyKOSequence() {
  if (_s.battleState === 'ally-ko-fade') {
    const koAlly = _s.battleAllies[_s.enemyTargetAllyIdx];
    if (koAlly && _s.battleTimer >= 100) {
      koAlly.fadeStep = Math.min(_s.ROSTER_FADE_STEPS, koAlly.fadeStep + 1);
      _s.battleTimer = 0;
      if (koAlly.fadeStep >= _s.ROSTER_FADE_STEPS) {
        _s.turnQueue = _s.turnQueue.filter(t => !(t.type === 'ally' && t.index === _s.enemyTargetAllyIdx));
        _s.enemyTargetAllyIdx = -1;
        if (_s.isTeamWiped()) {
          _s.battleState = 'team-wipe'; _s.battleTimer = 0;
        } else {
          _s.processNextTurn();
        }
      }
    }
    return true;
  }
  if (_s.battleState === 'ally-ko-msg') return true;
  return false;
}

export function updateBattleAlly(shared) {
  _s = shared;
  if (_updateAllyJoin()) return true;
  if (_updateAllyAttack()) return true;
  if (_s.battleState === 'ally-damage-show') { if (_s.battleTimer >= 700) _updateAllyDamageShow(); return true; }
  if (_updateAllyEnemyHit()) return true;
  if (_updateAllyKOSequence()) return true;
  return false;
}
