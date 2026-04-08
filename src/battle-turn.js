// Battle turn order + turn dispatch — extracted from game.js

import { rollHits, calcPotentialHits } from './battle-math.js';
import { BATTLE_RAN_AWAY, BATTLE_CANT_ESCAPE } from './data/strings.js';
import { makeNameMsg } from './text-utils.js';
import { ps } from './player-stats.js';
import { ITEMS, isWeapon } from './data/items.js';
import { SFX, playSFX } from './music.js';
import { processTurnStart, removeStatus, STATUS } from './status-effects.js';

let _s = null; // shared state object, set each call

// ── Turn order ─────────────────────────────────────────────────────────────
export function buildTurnOrder(shared) {
  _s = shared;
  const actors = [];
  if (ps.hp > 0) {
    const playerAgi = ps.stats ? ps.stats.agi : 5;
    actors.push({ type: 'player', priority: (playerAgi * 2) + Math.floor(Math.random() * 256) });
  }
  for (let i = 0; i < _s.battleAllies.length; i++) {
    if (_s.battleAllies[i].hp > 0)
      actors.push({ type: 'ally', index: i, priority: (_s.battleAllies[i].agi * 2) + Math.floor(Math.random() * 256) });
  }
  if (_s.isRandomEncounter && _s.encounterMonsters) {
    for (let i = 0; i < _s.encounterMonsters.length; i++) {
      if (_s.encounterMonsters[i].hp > 0)
        actors.push({ type: 'enemy', index: i, priority: Math.floor(Math.random() * 256) });
    }
  } else if (_s.pvpSt.isPVPBattle) {
    if (_s.pvpSt.pvpOpponentStats && _s.pvpSt.pvpOpponentStats.hp > 0)
      actors.push({ type: 'enemy', index: -1, pvpAllyIdx: -1, priority: Math.floor(Math.random() * 256) });
    for (let i = 0; i < _s.pvpSt.pvpEnemyAllies.length; i++) {
      if (_s.pvpSt.pvpEnemyAllies[i].hp > 0)
        actors.push({ type: 'enemy', index: -1, pvpAllyIdx: i, priority: Math.floor(Math.random() * 256) });
    }
  } else {
    actors.push({ type: 'enemy', index: -1, priority: Math.floor(Math.random() * 256) });
  }
  actors.sort((a, b) => b.priority - a.priority);
  return actors;
}

// ── Turn dispatch ──────────────────────────────────────────────────────────
export function processNextTurn(shared) {
  _s = shared;
  if (_s.turnQueue.length === 0) {
    _s.isDefending = false; _s.inputSt.battleCursor = 0; _s.turnTimer = 0;
    if (ps.hp <= 0) {
      _s.turnQueue = buildTurnOrder(_s);
      if (_s.turnQueue.length === 0) return;
      processNextTurn(_s);
      return;
    }
    _s.battleState = 'menu-open'; _s.battleTimer = 0;
    return;
  }
  const turn = _s.turnQueue.shift();
  if (turn.type === 'player') {
    if (ps.hp <= 0) { processNextTurn(_s); return; }
    // Status turn-start: poison damage, paralysis/sleep skip, confuse flag
    if (ps.status && !turn._statusDone) {
      const { canAct, poisonDmg, confused } = processTurnStart(ps.status, ps.stats ? ps.stats.maxHP : ps.hp);
      if (!canAct) { processNextTurn(_s); return; }
      if (poisonDmg > 0) {
        ps.hp = Math.max(1, ps.hp - poisonDmg);
        _s.setPlayerDamageNum({ value: poisonDmg, timer: 0 });
        _s.battleShakeTimer = _s.BATTLE_SHAKE_MS;
        playSFX(SFX.ATTACK_HIT);
        turn._statusDone = true;
        _s.turnQueue.unshift(turn);
        _s.battleState = 'poison-tick'; _s.battleTimer = 0;
        return;
      }
      // Confused: force attack on random alive monster
      if (confused && _s.isRandomEncounter && _s.encounterMonsters) {
        const living = _s.encounterMonsters.map((m, i) => m.hp > 0 ? i : -1).filter(i => i >= 0);
        if (living.length > 0) {
          const rIdx = living[Math.floor(Math.random() * living.length)];
          _s.inputSt.playerActionPending = { command: 'fight', targetIndex: rIdx,
            hitResults: rollHits(ps.atk, _s.encounterMonsters[rIdx].def, ps.hitRate || 80, calcPotentialHits(ps.stats?.level || 1, ps.stats?.agi || 5, false)),
            slashFrames: _s.inputSt.playerActionPending.slashFrames,
            slashOffX: _s.inputSt.playerActionPending.slashOffX,
            slashOffY: _s.inputSt.playerActionPending.slashOffY,
            slashX: _s.inputSt.playerActionPending.slashX,
            slashY: _s.inputSt.playerActionPending.slashY };
        }
      }
    }
    const cmd = _s.inputSt.playerActionPending.command;
    const pn = _s.playerName;
    if (cmd === 'fight') { if (pn) _s.queueBattleMsg(makeNameMsg(pn, ' attacks!')); _playerTurnFight(); }
    else if (cmd === 'defend') { _s.inputSt.battleActionCount++; if (pn) _s.queueBattleMsg(makeNameMsg(pn, ' defends!')); playSFX(SFX.DEFEND_HIT); _s.battleState = 'defend-anim'; _s.battleTimer = 0; }
    else if (cmd === 'item') { _s.inputSt.battleActionCount++; _playerTurnItem(); }
    else if (cmd === 'skip') processNextTurn(_s);
    else if (cmd === 'run') _playerTurnRun();
  } else if (turn.type === 'ally') {
    _s.currentAllyAttacker = turn.index;
    _s.allyHitIsLeft = false;
    const ally = _s.battleAllies[turn.index];
    if (!ally || ally.hp <= 0) { processNextTurn(_s); return; }
    // Ally status turn-start
    if (ally.status && !turn._statusDone) {
      const { canAct, poisonDmg } = processTurnStart(ally.status, ally.maxHP || ally.hp);
      if (!canAct) { processNextTurn(_s); return; }
      if (poisonDmg > 0) {
        ally.hp = Math.max(0, ally.hp - poisonDmg);
        _s.getAllyDamageNums()[turn.index] = { value: poisonDmg, timer: 0 };
        playSFX(SFX.ATTACK_HIT);
        turn._statusDone = true;
        _s.turnQueue.unshift(turn);
        _s.battleState = 'poison-tick'; _s.battleTimer = 0;
        return;
      }
    }
    if (_s.isRandomEncounter && _s.encounterMonsters) {
      const living = _s.encounterMonsters.map((m, i) => m.hp > 0 ? i : -1).filter(i => i >= 0);
      if (living.length === 0) { processNextTurn(_s); return; }
      _s.allyTargetIndex = living[Math.floor(Math.random() * living.length)];
    } else { _s.allyTargetIndex = -1; }
    const targetDef = _s.allyTargetIndex >= 0 ? _s.encounterMonsters[_s.allyTargetIndex].def
      : _s.pvpSt.isPVPBattle
        ? (_s.pvpSt.pvpPlayerTargetIdx >= 0
            ? (_s.pvpSt.pvpEnemyAllies[_s.pvpSt.pvpPlayerTargetIdx] || _s.pvpSt.pvpOpponentStats).def
            : _s.pvpSt.pvpOpponentStats.def)
        : _s.BOSS_DEF;
    const dualWield = isWeapon(ally.weaponId) && isWeapon(ally.weaponL);
    const potentialHits = calcPotentialHits(ally.level || 1, ally.agi, dualWield);
    _s.allyHitResults = rollHits(ally.atk, targetDef, ally.hitRate || 85, potentialHits);
    _s.allyHitIdx = 0;
    _s.allyHitResult = _s.allyHitResults[0];
    _s.battleState = 'ally-attack-back'; _s.battleTimer = 0;
  } else {
    _s.currentAttacker = turn.index;
    // Monster status turn-start: poison damage, paralysis skip
    if (turn.index >= 0 && _s.encounterMonsters && _s.encounterMonsters[turn.index] && !turn._statusDone) {
      const mon = _s.encounterMonsters[turn.index];
      if (mon.status) {
        const { canAct, poisonDmg } = processTurnStart(mon.status, mon.maxHP);
        if (!canAct || mon.hp <= 0) { processNextTurn(_s); return; }
        if (poisonDmg > 0) {
          mon.hp = Math.max(0, mon.hp - poisonDmg);
          _s.setEnemyDmgNum({ value: poisonDmg, timer: 0 });
          playSFX(SFX.ATTACK_HIT);
          turn._statusDone = true;
          _s.turnQueue.unshift(turn);
          _s.battleState = 'poison-tick'; _s.battleTimer = 0;
          return;
        }
      }
    }
    if (_s.pvpSt.isPVPBattle) {
      const pai = turn.pvpAllyIdx ?? -1;
      _s.pvpSt.pvpCurrentEnemyAllyIdx = pai;
      if (pai < 0 && (!_s.pvpSt.pvpOpponentStats || _s.pvpSt.pvpOpponentStats.hp <= 0)) { processNextTurn(_s); return; }
      if (pai >= 0 && (_s.pvpSt.pvpEnemyAllies[pai]?.hp ?? 0) <= 0) { processNextTurn(_s); return; }
      if (pai < 0) _s.pvpSt.pvpEnemyHitIdx = 0;
    }
    if (turn.index >= 0 && _s.encounterMonsters && _s.encounterMonsters[turn.index].hp <= 0) { processNextTurn(_s); return; }
    _s.battleState = 'enemy-flash'; _s.battleTimer = 0; _s.pvpSt.pvpPreflashDecided = false;
  }
}

// ── Player turn actions ────────────────────────────────────────────────────
function _playerTurnFight() {
  let ti = _s.inputSt.playerActionPending.targetIndex;
  if (_s.isRandomEncounter && _s.encounterMonsters && ti >= 0 && _s.encounterMonsters[ti].hp <= 0) {
    const living = _s.encounterMonsters.findIndex(m => m.hp > 0);
    if (living < 0) { processNextTurn(_s); return; }
    ti = living;
  }
  _s.currentHitIdx = 0; _s.slashFrame = 0;
  _s.inputSt.hitResults = _s.inputSt.playerActionPending.hitResults;
  _s.inputSt.targetIndex = ti;
  _s.slashFrames = _s.inputSt.playerActionPending.slashFrames;
  _s.slashOffX = _s.inputSt.playerActionPending.slashOffX; _s.slashOffY = _s.inputSt.playerActionPending.slashOffY;
  _s.slashX = _s.inputSt.playerActionPending.slashX; _s.slashY = _s.inputSt.playerActionPending.slashY;
  _s.battleState = 'attack-back'; _s.battleTimer = 0;
}

const CURE_NAME_TO_FLAG = {
  poison: STATUS.POISON, blind: STATUS.BLIND, silence: STATUS.SILENCE,
  mini: STATUS.MINI, toad: STATUS.TOAD, petrify: STATUS.PETRIFY,
  paralysis: STATUS.PARALYSIS,
};

function _playerTurnConsumable() {
  const itemId = _s.inputSt.playerActionPending.itemId;
  const itemDat = ITEMS.get(itemId);
  const effect = itemDat?.effect || 'heal';
  const power = itemDat?.power || 50;

  playSFX(SFX.CURE);
  const { target, allyIndex } = _s.inputSt.playerActionPending;

  if (effect === 'cure_status') {
    // Status cure items — only target player for now
    const flag = CURE_NAME_TO_FLAG[itemDat.cures];
    if (flag && ps.status) removeStatus(ps.status, flag);
    _s.itemHealAmount = 0;
    _s.battleState = 'item-use'; _s.battleTimer = 0;
    return;
  }

  if (effect === 'full_heal') {
    // Elixir — full HP restore
    if (target === 'player' && (allyIndex === undefined || allyIndex < 0)) {
      const heal = ps.stats.maxHP - ps.hp;
      ps.hp = ps.stats.maxHP; _s.itemHealAmount = heal; _s.setPlayerHealNum({ value: heal, timer: 0 });
    }
    _s.battleState = 'item-use'; _s.battleTimer = 0;
    return;
  }

  // Default: heal HP by power amount
  if (target === 'player' && (allyIndex === undefined || allyIndex < 0)) {
    const heal = Math.min(power, ps.stats.maxHP - ps.hp);
    ps.hp += heal; _s.itemHealAmount = heal; _s.setPlayerHealNum({ value: heal, timer: 0 });
  } else if (target === 'player' && allyIndex >= 0) {
    const ally = _s.battleAllies[allyIndex];
    if (ally) {
      const heal = Math.min(power, ally.maxHP - ally.hp);
      ally.hp += heal; _s.itemHealAmount = heal;
      _s.getAllyDamageNums()[allyIndex] = { value: heal, timer: 0, heal: true };
    }
  } else {
    const mon = _s.isRandomEncounter && _s.encounterMonsters ? _s.encounterMonsters[target] : null;
    if (mon) {
      const heal = Math.min(power, mon.maxHP - mon.hp);
      mon.hp += heal; _s.itemHealAmount = heal; _s.setEnemyHealNum({ value: heal, timer: 0, index: target });
    } else {
      const curHP = _s.getEnemyHP();
      const maxHP = _s.pvpSt.isPVPBattle ? (_s.pvpSt.pvpOpponentStats ? _s.pvpSt.pvpOpponentStats.maxHP : 1) : _s.BOSS_MAX_HP;
      const heal = Math.min(power, maxHP - curHP);
      _s.setEnemyHP(curHP + heal); _s.itemHealAmount = heal; _s.setEnemyHealNum({ value: heal, timer: 0, index: 0 });
    }
  }
  _s.battleState = 'item-use'; _s.battleTimer = 0;
}

function _playerTurnItem() {
  _s.isDefending = false;
  _s.removeItem(_s.inputSt.playerActionPending.itemId);
  if (_s.ITEMS.get(_s.inputSt.playerActionPending.itemId)?.type === 'battle_item') _s.startMagicItem();
  else _playerTurnConsumable();
}

function _playerTurnRun() {
  const playerAgi = ps.stats ? ps.stats.agi : 5;
  let avgLevel = 1;
  if (_s.encounterMonsters) {
    const alive = _s.encounterMonsters.filter(m => m.hp > 0);
    if (alive.length > 0) avgLevel = alive.reduce((s, m) => s + (m.level || 1), 0) / alive.length;
  }
  const successRate = Math.min(99, Math.max(1, playerAgi + 25 - Math.floor(avgLevel / 4)));
  if (Math.floor(Math.random() * 100) < successRate) {
    _s.queueBattleMsg(BATTLE_RAN_AWAY);
    playSFX(SFX.RUN_AWAY);
    _s.battleState = 'run-success'; _s.battleTimer = 0;
  } else {
    _s.queueBattleMsg(BATTLE_CANT_ESCAPE);
    _s.battleState = 'run-fail'; _s.battleTimer = 0;
  }
}
