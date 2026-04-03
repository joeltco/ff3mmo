// Battle ally update logic — extracted from game.js

import { rollHits } from './battle-math.js';
import { playSlashSFX } from './battle-sfx.js';
import { isWeapon } from './data/items.js';
import { SFX, playSFX } from './music.js';

let _s = null;

function _updateAllyDamageShow() {
  if (_s.isRandomEncounter && _s.encounterMonsters && _s.allyTargetIndex >= 0 && _s.encounterMonsters[_s.allyTargetIndex].hp <= 0) {
    _s.allyHitIsLeft = false;
    _s.dyingMonsterIndices = new Map([[_s.allyTargetIndex, 0]]);
    _s.battleState = 'monster-death'; _s.battleTimer = 0; playSFX(SFX.MONSTER_DEATH);
  } else if (!_s.isRandomEncounter && _s.bossHP <= 0) {
    _s.allyHitIsLeft = false;
    if (_s.pvpSt.isPVPBattle) {
      if (_s.pvpSt.pvpPlayerTargetIdx < 0) _s.pvpSt.pvpOpponentStats.hp = 0;
      else _s.pvpSt.pvpEnemyAllies[_s.pvpSt.pvpPlayerTargetIdx].hp = 0;
      _s.battleState = 'pvp-dissolve'; _s.battleTimer = 0; playSFX(SFX.MONSTER_DEATH);
    } else { _s.battleState = 'boss-dissolve'; _s.battleTimer = 0; playSFX(SFX.BOSS_DEATH); }
  } else {
    const ally = _s.battleAllies[_s.currentAllyAttacker];
    if (!_s.allyHitIsLeft && ally && isWeapon(ally.weaponL)) {
      _s.allyHitIsLeft = true;
      const targetDef = _s.allyTargetIndex >= 0 && _s.encounterMonsters ? _s.encounterMonsters[_s.allyTargetIndex].def
        : _s.pvpSt.isPVPBattle
          ? (_s.pvpSt.pvpPlayerTargetIdx >= 0
              ? (_s.pvpSt.pvpEnemyAllies[_s.pvpSt.pvpPlayerTargetIdx] || _s.pvpSt.pvpOpponentStats).def
              : _s.pvpSt.pvpOpponentStats.def)
          : _s.BOSS_DEF;
      _s.allyHitResult = rollHits(ally.atk, targetDef, 85, 1)[0];
      _s.battleState = 'ally-attack-start'; _s.battleTimer = 0;
    } else {
      _s.allyHitIsLeft = false;
      _s.processNextTurn();
    }
  }
}

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

function _updateAllyAttack() {
  if (_s.battleState === 'ally-attack-start') {
    if (_s.battleTimer >= 100) {
      const ally = _s.battleAllies[_s.currentAllyAttacker];
      const activeWpn = _s.allyHitIsLeft ? (ally && ally.weaponL) : (ally && ally.weaponId);
      playSlashSFX(activeWpn, _s.allyHitResult && _s.allyHitResult.crit);
      _s.battleState = 'ally-slash';
      _s.battleTimer = 0;
    }
    return true;
  }
  if (_s.battleState === 'ally-slash') {
    if (_s.battleTimer >= 200) {
      if (_s.allyHitResult && !_s.allyHitResult.miss) {
        if (_s.pvpSt.isPVPBattle && _s.pvpSt.pvpOpponentIsDefending && _s.allyTargetIndex < 0)
          _s.allyHitResult.damage = Math.max(1, Math.floor(_s.allyHitResult.damage / 2));
        if (_s.allyTargetIndex >= 0 && _s.encounterMonsters) {
          _s.encounterMonsters[_s.allyTargetIndex].hp = Math.max(0, _s.encounterMonsters[_s.allyTargetIndex].hp - _s.allyHitResult.damage);
        } else if (_s.allyTargetIndex < 0) {
          _s.bossHP = Math.max(0, _s.bossHP - _s.allyHitResult.damage);
          if (_s.pvpSt.isPVPBattle) {
            _s.pvpSt.pvpOpponentShakeTimer = _s.BATTLE_SHAKE_MS;
            if (_s.pvpSt.pvpPlayerTargetIdx < 0) _s.pvpSt.pvpOpponentStats.hp = _s.bossHP;
            else if (_s.pvpSt.pvpEnemyAllies[_s.pvpSt.pvpPlayerTargetIdx]) _s.pvpSt.pvpEnemyAllies[_s.pvpSt.pvpPlayerTargetIdx].hp = _s.bossHP;
          }
        }
        if (_s.allyHitResult.crit) _s.critFlashTimer = 0;
        _s.bossDamageNum = { value: _s.allyHitResult.damage, crit: _s.allyHitResult.crit, timer: 0 };
        _s.inputSt.targetIndex = _s.allyTargetIndex;
      } else {
        _s.bossDamageNum = { miss: true, timer: 0 };
        _s.inputSt.targetIndex = _s.allyTargetIndex;
      }
      _s.battleState = 'ally-damage-show';
      _s.battleTimer = 0;
    }
    return true;
  }
  return false;
}

function _updateAllyEnemyHit() {
  if (_s.battleState === 'ally-hit') {
    if (_s.battleTimer >= _s.BATTLE_SHAKE_MS) { _s.battleState = 'ally-damage-show-enemy'; _s.battleTimer = 0; }
    return true;
  }
  if (_s.battleState === 'ally-damage-show-enemy') {
    if (_s.battleTimer >= _s.BATTLE_DMG_SHOW_MS) {
      const ally = _s.battleAllies[_s.enemyTargetAllyIdx];
      if (ally && ally.hp <= 0) { _s.battleState = 'ally-ko-fade'; _s.battleTimer = 0; }
      else { _s.enemyTargetAllyIdx = -1; _s.processNextTurn(); }
    }
    return true;
  }
  return false;
}

function _updateAllyKOSequence() {
  if (_s.battleState === 'ally-ko-fade') {
    const koAlly = _s.battleAllies[_s.enemyTargetAllyIdx];
    if (koAlly && _s.battleTimer >= 100) {
      koAlly.fadeStep = Math.min(_s.ROSTER_FADE_STEPS, koAlly.fadeStep + 1);
      _s.battleTimer = 0;
      if (koAlly.fadeStep >= _s.ROSTER_FADE_STEPS) {
        _s.turnQueue = _s.turnQueue.filter(t => !(t.type === 'ally' && t.index === _s.enemyTargetAllyIdx));
        _s.enemyTargetAllyIdx = -1;
        _s.processNextTurn();
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
