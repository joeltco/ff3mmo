// Battle enemy turn update logic — extracted from game.js

import { calcDamage, elemMultiplier } from './battle-math.js';
import { ps, getShieldEvade } from './player-stats.js';
import { SFX, playSFX } from './music.js';
import { tryInflictStatus, blindHitPenalty, wakeOnHit } from './status-effects.js';
import { getMonsterName } from './text-decoder.js';
import { _nameToBytes } from './text-utils.js';

let _s = null;

// ── Monster special attack definitions ─────────────────────────────────────
// Maps attack name → { type, power, hit, element, status }
// Derived from spells.js ROM data but kept flat here for battle use
const SPECIAL_ATTACKS = {
  'Fire':        { type: 'damage', power: 25, hit: 100, element: 'fire' },
  'Fira':        { type: 'damage', power: 60, hit: 100, element: 'fire' },
  'Firaga':      { type: 'damage', power: 150, hit: 100, element: 'fire' },
  'Bzzard':      { type: 'damage', power: 25, hit: 100, element: 'ice' },
  'Bzzara':      { type: 'damage', power: 60, hit: 100, element: 'ice' },
  'Bzzaga':      { type: 'damage', power: 130, hit: 100, element: 'ice' },
  'Thunder':     { type: 'damage', power: 35, hit: 100, element: 'bolt' },
  'Thundara':    { type: 'damage', power: 75, hit: 100, element: 'bolt' },
  'Thundaga':    { type: 'damage', power: 110, hit: 100, element: 'bolt' },
  'Tornado':     { type: 'damage', power: 4, hit: 40, element: 'air' },
  'Aeroga':      { type: 'damage', power: 115, hit: 100, element: null },
  'Quake':       { type: 'damage', power: 133, hit: 100, element: 'earth' },
  'Holy':        { type: 'damage', power: 160, hit: 100, element: 'holy' },
  'Flare':       { type: 'damage', power: 200, hit: 100, element: null },
  'Meteor':      { type: 'damage', power: 180, hit: 100, element: null },
  'Bio':         { type: 'damage', power: 130, hit: 100, element: null },
  'Drain':       { type: 'damage', power: 160, hit: 100, element: null },
  'Blind':       { type: 'status', hit: 60, status: 'blind' },
  'Poison':      { type: 'status', hit: 60, status: 'poison' },
  'Glare':       { type: 'status', hit: 80, status: 'paralysis' },
  'Sleep':       { type: 'status', hit: 60, status: 'sleep' },
  'Confuse':     { type: 'status', hit: 60, status: 'confuse' },
  'Toad':        { type: 'status', hit: 80, status: 'toad' },
  'Mini':        { type: 'status', hit: 80, status: 'mini' },
  'Silence':     { type: 'status', hit: 80, status: 'silence' },
  'Bad Breath':  { type: 'multi_status', hit: 60, statuses: ['poison', 'blind', 'silence', 'toad', 'mini'] },
  'Reflect':     { type: 'none' },
  'Sence':       { type: 'none' },
};

// ── Execute special attack against player or ally ──────────────────────────
function _doSpecialAttack(mon, spec, targetAlly = -1) {
  if (targetAlly >= 0) {
    const ally = _s.battleAllies[targetAlly];
    if (!ally || ally.hp <= 0) { _s.processNextTurn(); return; }
    if (spec.type === 'damage') {
      const eMult = elemMultiplier(spec.element, null, null);
      const raw = Math.floor(spec.power * eMult) - (ally.mdef || 0);
      const dmg = Math.max(1, raw);
      ally.hp = Math.max(0, ally.hp - dmg);
      _s.allyDamageNums[targetAlly] = { value: dmg, timer: 0 };
      _s.allyShakeTimer[targetAlly] = _s.BATTLE_SHAKE_MS;
      playSFX(SFX.ATTACK_HIT);
      _s.battleState = 'ally-hit'; _s.battleTimer = 0;
    } else if (spec.type === 'status' && ally.status) {
      const applied = tryInflictStatus(ally.status, spec.status, spec.hit);
      _s.allyDamageNums[targetAlly] = applied
        ? { value: 0, timer: 0, status: spec.status }
        : { miss: true, timer: 0 };
      _s.battleState = 'ally-damage-show-enemy'; _s.battleTimer = 0;
    } else if (spec.type === 'multi_status' && ally.status) {
      let anyApplied = false;
      for (const s of spec.statuses) { if (tryInflictStatus(ally.status, s, spec.hit)) anyApplied = true; }
      _s.allyDamageNums[targetAlly] = anyApplied
        ? { value: 0, timer: 0, status: 'multi' }
        : { miss: true, timer: 0 };
      _s.battleState = 'ally-damage-show-enemy'; _s.battleTimer = 0;
    } else { _s.processNextTurn(); }
    return;
  }
  if (spec.type === 'damage') {
    // Magic damage: power - mdef, with elemental multiplier
    const eMult = elemMultiplier(spec.element, null, ps.elemResist);
    const raw = Math.floor(spec.power * eMult) - (ps.mdef || 0);
    const dmg = Math.max(1, raw);
    if (_s.isDefending) {
      const reduced = Math.max(1, Math.floor(dmg / 2));
      _s.ps.hp = Math.max(0, _s.ps.hp - reduced);
      _s.playerDamageNum = { value: reduced, timer: 0 };
    } else {
      _s.ps.hp = Math.max(0, _s.ps.hp - dmg);
      _s.playerDamageNum = { value: dmg, timer: 0 };
    }
    playSFX(SFX.ATTACK_HIT);
    _s.battleShakeTimer = _s.BATTLE_SHAKE_MS;
    _s.battleState = 'enemy-attack'; _s.battleTimer = 0;
  } else if (spec.type === 'status' && ps.status) {
    const applied = tryInflictStatus(ps.status, spec.status, spec.hit);
    // Status-only attacks show as miss if resisted
    if (applied) {
      _s.playerDamageNum = { value: 0, timer: 0, status: spec.status };
      _s.battleShakeTimer = _s.BATTLE_SHAKE_MS;
    } else {
      _s.playerDamageNum = { miss: true, timer: 0 };
    }
    _s.battleState = 'enemy-damage-show'; _s.battleTimer = 0;
  } else if (spec.type === 'multi_status' && ps.status) {
    let anyApplied = false;
    for (const s of spec.statuses) {
      if (tryInflictStatus(ps.status, s, spec.hit)) anyApplied = true;
    }
    if (anyApplied) {
      _s.playerDamageNum = { value: 0, timer: 0, status: 'multi' };
      _s.battleShakeTimer = _s.BATTLE_SHAKE_MS;
    } else {
      _s.playerDamageNum = { miss: true, timer: 0 };
    }
    _s.battleState = 'enemy-damage-show'; _s.battleTimer = 0;
  } else {
    // No-op attacks (Reflect, Sence, etc.) — wait for msg then skip
    if (_s.isBattleMsgBusy()) { _s.battleState = 'msg-wait'; _s.battleTimer = 0; }
    else _s.processNextTurn();
  }
}

// ── Enemy flash → targeting + hit calc ──────────────────────────────────────
function _processEnemyFlash() {
  if (_s.battleState !== 'enemy-flash' || _s.battleTimer < _s.BOSS_PREFLASH_MS) return false;
  const livingAllies = _s.battleAllies.filter(a => a.hp > 0);
  let targetAlly = -1;
  if (livingAllies.length > 0) {
    const allyOptions = _s.battleAllies.map((a, i) => a.hp > 0 ? i : -1).filter(i => i >= 0);
    if (_s.ps.hp <= 0) {
      targetAlly = allyOptions[Math.floor(Math.random() * allyOptions.length)];
    } else if (Math.random() >= 1 / (1 + livingAllies.length)) {
      targetAlly = allyOptions[Math.floor(Math.random() * allyOptions.length)];
    }
  }
  const mon = (_s.currentAttacker >= 0 && _s.encounterMonsters) ? _s.encounterMonsters[_s.currentAttacker] : null;

  // Queue enemy attack message
  if (mon) {
    _s.queueBattleMsg(getMonsterName(mon.monsterId) || _nameToBytes('Enemy'));
  }

  // ── Monster special attack check ──────────────────────────────────────────
  if (mon && mon.spAtkRate > 0 && mon.attacks && mon.attacks.length > 0) {
    if (Math.random() * 100 < mon.spAtkRate) {
      const atkName = mon.attacks[Math.floor(Math.random() * mon.attacks.length)];
      const spec = SPECIAL_ATTACKS[atkName];
      if (spec && spec.type !== 'none') {
        _doSpecialAttack(mon, spec, targetAlly);
        return true;
      }
    }
  }

  let hitRate = mon ? (mon.hitRate || _s.GOBLIN_HIT_RATE) : _s.BOSS_HIT_RATE;
  if (mon && mon.status) hitRate *= blindHitPenalty(mon.status);
  const atk = mon ? mon.atk : _s.BOSS_ATK;
  const rolls = mon ? (mon.attackRoll || 1) : 1;
  const monAtkElem = mon ? (mon.atkElem || null) : null;
  // NES multi-hit: roll attackRoll times, per-hit shield/evade/hitRate checks
  function rollMultiHit(def, targetResist, shieldEvade = 0, armorEvade = 0) {
    const eMult = elemMultiplier(monAtkElem, null, targetResist);
    let total = 0, landed = 0;
    for (let i = 0; i < rolls; i++) {
      if (shieldEvade > 0 && Math.random() * 100 < shieldEvade) continue;
      if (armorEvade > 0 && Math.random() * 100 < armorEvade) continue;
      if (Math.random() * 100 < hitRate) { total += calcDamage(atk, def, false, 0, eMult); landed++; }
    }
    return { total, landed };
  }
  if (targetAlly >= 0) {
    _s.enemyTargetAllyIdx = targetAlly;
    const { total, landed } = rollMultiHit(_s.battleAllies[targetAlly].def, null);
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
    const shieldEvade = getShieldEvade();
    const { total, landed } = rollMultiHit(_s.ps.def, ps.elemResist, shieldEvade, ps.evade);
    if (landed > 0) {
      let dmg = total;
      if (_s.isDefending) dmg = Math.max(1, Math.floor(dmg / 2));
      _s.ps.hp = Math.max(0, _s.ps.hp - dmg);
      _s.playerDamageNum = { value: dmg, timer: 0 };
      // Physical hit wakes sleeping targets
      if (ps.status) wakeOnHit(ps.status);
      // Monster statusAtk: try to inflict status on player
      const monStatus = mon ? mon.statusAtk : null;
      if (monStatus && ps.status) {
        const arr = Array.isArray(monStatus) ? monStatus : [monStatus];
        for (const s of arr) tryInflictStatus(ps.status, s, hitRate);
      }
      playSFX(SFX.ATTACK_HIT);
      _s.battleShakeTimer = _s.BATTLE_SHAKE_MS;
      _s.battleState = 'enemy-attack'; _s.battleTimer = 0;
    } else {
      _s.playerDamageNum = { miss: true, timer: 0 };
      _s.battleState = 'enemy-damage-show'; _s.battleTimer = 0;
    }
  }
  return true;
}

// ── After damage show: check team wipe or advance ───────────────────────────
function _processEnemyDamageShowState() {
  if (_s.battleTimer < _s.BATTLE_DMG_SHOW_MS) return;
  if (_s.isTeamWiped()) {
    _s.isDefending = false; _s.battleState = 'team-wipe'; _s.battleTimer = 0;
  } else if (_s.isBattleMsgBusy()) { _s.battleState = 'msg-wait'; _s.battleTimer = 0;
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
