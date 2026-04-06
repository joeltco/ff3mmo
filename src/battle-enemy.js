// Battle enemy turn update logic — extracted from game.js

import { calcDamage } from './battle-math.js';
import { ps, getShieldEvade } from './player-stats.js';
import { SFX, playSFX } from './music.js';

let _s = null;

// ── Enemy flash → targeting + hit calc ──────────────────────────────────────
function _processEnemyFlash() {
  if (_s.battleState !== 'enemy-flash' || _s.battleTimer < _s.BOSS_PREFLASH_MS) return false;
  const livingAllies = _s.battleAllies.filter(a => a.hp > 0);
  let targetAlly = -1;
  if (livingAllies.length > 0) {
    const allyOptions = _s.battleAllies.map((a, i) => a.hp > 0 ? i : -1).filter(i => i >= 0);
    if (_s.ps.hp <= 0) {
      // Player dead — must target a living ally
      targetAlly = allyOptions[Math.floor(Math.random() * allyOptions.length)];
    } else if (Math.random() >= 1 / (1 + livingAllies.length)) {
      targetAlly = allyOptions[Math.floor(Math.random() * allyOptions.length)];
    }
  }
  const mon = (_s.currentAttacker >= 0 && _s.encounterMonsters) ? _s.encounterMonsters[_s.currentAttacker] : null;
  const hitRate = mon ? (mon.hitRate || _s.GOBLIN_HIT_RATE) : _s.BOSS_HIT_RATE;
  const atk = mon ? mon.atk : _s.BOSS_ATK;
  const rolls = mon ? (mon.attackRoll || 1) : 1;
  // NES multi-hit: roll attackRoll times, sum damage from hits that land
  function rollMultiHit(def) {
    let total = 0, landed = 0;
    for (let i = 0; i < rolls; i++) {
      if (Math.random() * 100 < hitRate) { total += calcDamage(atk, def); landed++; }
    }
    return { total, landed };
  }
  if (targetAlly >= 0) {
    _s.enemyTargetAllyIdx = targetAlly;
    const { total, landed } = rollMultiHit(_s.battleAllies[targetAlly].def);
    if (landed > 0) {
      _s.battleAllies[targetAlly].hp = Math.max(0, _s.battleAllies[targetAlly].hp - total);
      _s.allyDamageNums[targetAlly] = { value: total, timer: 0 };
      _s.allyShakeTimer[targetAlly] = _s.BATTLE_SHAKE_MS;
      playSFX(SFX.ATTACK_HIT); _s.battleState = 'ally-hit'; _s.battleTimer = 0;
    } else {
      _s.allyDamageNums[targetAlly] = { miss: true, timer: 0 };
      _s.battleState = 'ally-damage-show-enemy'; _s.battleTimer = 0;
    }
  } else {
    const shieldEvade = getShieldEvade(_s.ITEMS);
    const shieldBlocked = shieldEvade > 0 && Math.random() * 100 < shieldEvade;
    if (shieldBlocked) {
      _s.playerDamageNum = { miss: true, timer: 0 };
      _s.battleState = 'enemy-damage-show'; _s.battleTimer = 0;
      _s.inputSt.battleProfHits['shield'] = (_s.inputSt.battleProfHits['shield'] || 0) + 1;
    } else if (ps.evade > 0 && Math.random() * 100 < ps.evade) {
      _s.playerDamageNum = { miss: true, timer: 0 };
      _s.battleState = 'enemy-damage-show'; _s.battleTimer = 0;
    } else {
      const { total, landed } = rollMultiHit(_s.ps.def);
      if (landed > 0) {
        let dmg = total;
        if (_s.isDefending) dmg = Math.max(1, Math.floor(dmg / 2));
        _s.ps.hp = Math.max(0, _s.ps.hp - dmg);
        _s.playerDamageNum = { value: dmg, timer: 0 };
        playSFX(SFX.ATTACK_HIT);
        _s.battleShakeTimer = _s.BATTLE_SHAKE_MS;
        _s.battleState = 'enemy-attack'; _s.battleTimer = 0;
      } else {
        _s.playerDamageNum = { miss: true, timer: 0 };
        _s.battleState = 'enemy-damage-show'; _s.battleTimer = 0;
      }
    }
  }
  return true;
}

// ── After damage show: check team wipe or advance ───────────────────────────
function _processEnemyDamageShowState() {
  if (_s.battleTimer < _s.BATTLE_DMG_SHOW_MS) return;
  if (_s.isTeamWiped()) {
    _s.isDefending = false; _s.battleState = 'team-wipe'; _s.battleTimer = 0;
  } else { _s.processNextTurn(); }
}

export function updateBattleEnemyTurn(shared) {
  _s = shared;
  if (_processEnemyFlash()) return true;
  if (_s.battleState === 'enemy-attack') {
    if (_s.battleTimer >= _s.BATTLE_SHAKE_MS) { _s.battleState = 'enemy-damage-show'; _s.battleTimer = 0; }
  } else if (_s.battleState === 'enemy-damage-show') { _processEnemyDamageShowState();
  } else { return false; }
  return true;
}
