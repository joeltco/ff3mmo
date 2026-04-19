// Battle enemy turn update logic — extracted from game.js

import { battleSt, getEnemyHP, setEnemyHP,
         BATTLE_SHAKE_MS, BATTLE_DMG_SHOW_MS, BOSS_PREFLASH_MS, BOSS_ATK } from './battle-state.js';
import { calcDamage, elemMultiplier, BOSS_HIT_RATE, GOBLIN_HIT_RATE } from './battle-math.js';
import { ps, getShieldEvade } from './player-stats.js';
import { SFX, playSFX } from './music.js';
import { tryInflictStatus, blindHitPenalty, wakeOnHit } from './status-effects.js';
import { queueBattleMsg, isBattleMsgBusy } from './battle-msg.js';
import { getMonsterName } from './text-decoder.js';
import { _nameToBytes } from './text-utils.js';
import { getPlayerDamageNum, setPlayerDamageNum, getAllyDamageNums } from './damage-numbers.js';
import { selectCursor, saveSlots } from './save-state.js';

// Injected at boot — avoids circular import on main.js
let _processNextTurn = () => {};
let _isTeamWiped = () => false;
export function initBattleEnemy({ processNextTurn, isTeamWiped }) {
  _processNextTurn = processNextTurn;
  _isTeamWiped = isTeamWiped;
}

function _playerName() { return saveSlots[selectCursor]?.name || null; }

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
    const ally = battleSt.battleAllies[targetAlly];
    if (!ally || ally.hp <= 0) { _processNextTurn(); return; }
    if (spec.type === 'damage') {
      const eMult = elemMultiplier(spec.element, null, null);
      const raw = Math.floor(spec.power * eMult) - (ally.mdef || 0);
      const dmg = Math.max(1, raw);
      ally.hp = Math.max(0, ally.hp - dmg);
      getAllyDamageNums()[targetAlly] = { value: dmg, timer: 0 };
      battleSt.allyShakeTimer[targetAlly] = BATTLE_SHAKE_MS;
      playSFX(SFX.ATTACK_HIT);
      battleSt.battleState = 'ally-hit'; battleSt.battleTimer = 0;
    } else if (spec.type === 'status' && ally.status) {
      const applied = tryInflictStatus(ally.status, spec.status, spec.hit);
      getAllyDamageNums()[targetAlly] = applied
        ? { value: 0, timer: 0, status: spec.status }
        : { miss: true, timer: 0 };
      battleSt.battleState = 'ally-damage-show-enemy'; battleSt.battleTimer = 0;
    } else if (spec.type === 'multi_status' && ally.status) {
      let anyApplied = false;
      for (const s of spec.statuses) { if (tryInflictStatus(ally.status, s, spec.hit)) anyApplied = true; }
      getAllyDamageNums()[targetAlly] = anyApplied
        ? { value: 0, timer: 0, status: 'multi' }
        : { miss: true, timer: 0 };
      battleSt.battleState = 'ally-damage-show-enemy'; battleSt.battleTimer = 0;
    } else { _processNextTurn(); }
    return;
  }
  if (spec.type === 'damage') {
    // Magic damage: power - mdef, with elemental multiplier
    const eMult = elemMultiplier(spec.element, null, ps.elemResist);
    const raw = Math.floor(spec.power * eMult) - (ps.mdef || 0);
    const dmg = Math.max(1, raw);
    if (battleSt.isDefending) {
      const reduced = Math.max(1, Math.floor(dmg / 2));
      ps.hp = Math.max(0, ps.hp - reduced);
      setPlayerDamageNum({ value: reduced, timer: 0 });
    } else {
      ps.hp = Math.max(0, ps.hp - dmg);
      setPlayerDamageNum({ value: dmg, timer: 0 });
    }
    playSFX(SFX.ATTACK_HIT);
    battleSt.battleShakeTimer = BATTLE_SHAKE_MS;
    battleSt.battleState = 'enemy-attack'; battleSt.battleTimer = 0;
  } else if (spec.type === 'status' && ps.status) {
    const applied = tryInflictStatus(ps.status, spec.status, spec.hit);
    if (applied) {
      setPlayerDamageNum({ value: 0, timer: 0, status: spec.status });
      battleSt.battleShakeTimer = BATTLE_SHAKE_MS;
    } else {
      setPlayerDamageNum({ miss: true, timer: 0 });
    }
    battleSt.battleState = 'enemy-damage-show'; battleSt.battleTimer = 0;
  } else if (spec.type === 'multi_status' && ps.status) {
    let anyApplied = 0;
    for (const s of spec.statuses) {
      const result = tryInflictStatus(ps.status, s, spec.hit);
      if (result) anyApplied = result;
    }
    if (anyApplied) {
      setPlayerDamageNum({ value: 0, timer: 0, status: 'multi' });
      battleSt.battleShakeTimer = BATTLE_SHAKE_MS;
    } else {
      setPlayerDamageNum({ miss: true, timer: 0 });
    }
    battleSt.battleState = 'enemy-damage-show'; battleSt.battleTimer = 0;
  } else {
    // No-op attacks (Reflect, Sence, etc.) — wait for msg then skip
    if (isBattleMsgBusy()) { battleSt.battleState = 'msg-wait'; battleSt.battleTimer = 0; }
    else _processNextTurn();
  }
}

// ── Enemy flash → targeting + hit calc ──────────────────────────────────────
function _processEnemyFlash() {
  if (battleSt.battleState !== 'enemy-flash' || battleSt.battleTimer < BOSS_PREFLASH_MS) return false;
  const livingAllies = battleSt.battleAllies.filter(a => a.hp > 0);
  let targetAlly = -1;
  if (livingAllies.length > 0) {
    const allyOptions = battleSt.battleAllies.map((a, i) => a.hp > 0 ? i : -1).filter(i => i >= 0);
    if (ps.hp <= 0) {
      targetAlly = allyOptions[Math.floor(Math.random() * allyOptions.length)];
    } else if (Math.random() >= 1 / (1 + livingAllies.length)) {
      targetAlly = allyOptions[Math.floor(Math.random() * allyOptions.length)];
    }
  }
  const mon = (battleSt.currentAttacker >= 0 && battleSt.encounterMonsters) ? battleSt.encounterMonsters[battleSt.currentAttacker] : null;

  // Queue enemy actor name
  if (mon) {
    const monName = getMonsterName(mon.monsterId) || _nameToBytes('Enemy');
    queueBattleMsg(monName);
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

  let hitRate = mon ? (mon.hitRate || GOBLIN_HIT_RATE) : BOSS_HIT_RATE;
  if (mon && mon.status) hitRate *= blindHitPenalty(mon.status);
  const atk = mon ? mon.atk : BOSS_ATK;
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
    battleSt.enemyTargetAllyIdx = targetAlly;
    const { total, landed } = rollMultiHit(battleSt.battleAllies[targetAlly].def, null);
    if (landed > 0) {
      battleSt.battleAllies[targetAlly].hp = Math.max(0, battleSt.battleAllies[targetAlly].hp - total);
      getAllyDamageNums()[targetAlly] = { value: total, timer: 0 };
      battleSt.allyShakeTimer[targetAlly] = BATTLE_SHAKE_MS;
      playSFX(SFX.ATTACK_HIT); battleSt.battleState = 'ally-hit'; battleSt.battleTimer = 0;
    } else {
      getAllyDamageNums()[targetAlly] = { miss: true, timer: 0 };
      battleSt.battleState = 'ally-damage-show-enemy'; battleSt.battleTimer = 0;
    }
  } else {
    const shieldEvade = getShieldEvade();
    const { total, landed } = rollMultiHit(ps.def, ps.elemResist, shieldEvade, ps.evade);
    if (landed > 0) {
      let dmg = total;
      if (battleSt.isDefending) dmg = Math.max(1, Math.floor(dmg / 2));
      ps.hp = Math.max(0, ps.hp - dmg);
      setPlayerDamageNum({ value: dmg, timer: 0 });
      // Physical hit wakes sleeping targets
      if (ps.status) wakeOnHit(ps.status);
      // Monster statusAtk: try to inflict status on player
      const monStatus = mon ? mon.statusAtk : null;
      if (monStatus && ps.status) {
        const arr = Array.isArray(monStatus) ? monStatus : [monStatus];
        for (const s of arr) tryInflictStatus(ps.status, s, hitRate);
      }
      playSFX(SFX.ATTACK_HIT);
      battleSt.battleShakeTimer = BATTLE_SHAKE_MS;
      battleSt.battleState = 'enemy-attack'; battleSt.battleTimer = 0;
    } else {
      setPlayerDamageNum({ miss: true, timer: 0 });
      battleSt.battleState = 'enemy-damage-show'; battleSt.battleTimer = 0;
    }
  }
  return true;
}

// ── After damage show: check team wipe or advance ───────────────────────────
function _processEnemyDamageShowState() {
  if (battleSt.battleTimer < BATTLE_DMG_SHOW_MS) return;
  if (_isTeamWiped()) {
    battleSt.isDefending = false; battleSt.battleState = 'team-wipe'; battleSt.battleTimer = 0;
  } else if (isBattleMsgBusy()) { battleSt.battleState = 'msg-wait'; battleSt.battleTimer = 0;
  } else { _processNextTurn(); }
}

export function updateBattleEnemyTurn() {
  if (_processEnemyFlash()) return true;
  if (battleSt.battleState === 'enemy-attack') {
    if (battleSt.battleTimer >= BATTLE_SHAKE_MS) { battleSt.battleState = 'enemy-damage-show'; battleSt.battleTimer = 0; }
  } else if (battleSt.battleState === 'enemy-damage-show') { _processEnemyDamageShowState();
  } else { return false; }
  return true;
}
