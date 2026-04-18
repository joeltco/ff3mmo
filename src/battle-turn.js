// Battle turn order + turn dispatch — extracted from game.js

import { battleSt, getEnemyHP, setEnemyHP, BATTLE_SHAKE_MS, BOSS_DEF, BOSS_MAX_HP } from './battle-state.js';
import { rollHits, calcPotentialHits } from './battle-math.js';
import { BATTLE_RAN_AWAY, BATTLE_CANT_ESCAPE } from './data/strings.js';
import { makeNameMsg, makeVsMsg } from './text-utils.js';
import { getMonsterName } from './text-decoder.js';
import { ps, getJobLevelStatBonus } from './player-stats.js';
import { ITEMS, isWeapon, isBladedWeapon } from './data/items.js';
import { SFX, playSFX } from './music.js';
import { processTurnStart, removeStatus, STATUS, blindHitPenalty } from './status-effects.js';
import { bsc, getSlashFramesForWeapon } from './battle-sprite-cache.js';
import { pvpSt } from './pvp.js';
import { inputSt } from './input-handler.js';
import { queueBattleMsg } from './battle-msg.js';
import { getAllyDamageNums, setEnemyDmgNum, setEnemyHealNum, setPlayerDamageNum, setPlayerHealNum } from './damage-numbers.js';
import { startMagicItem } from './battle-items.js';
import { selectCursor, saveSlots } from './save-state.js';
import { removeItem } from './inventory.js';

function _playerName() { return saveSlots[selectCursor]?.name || null; }

// ── Turn order ─────────────────────────────────────────────────────────────
export function buildTurnOrder() {
  const actors = [];
  if (ps.hp > 0) {
    const playerAgi = (ps.stats ? ps.stats.agi : 5) + getJobLevelStatBonus().agi;
    actors.push({ type: 'player', priority: (playerAgi * 2) + Math.floor(Math.random() * 256) });
  }
  for (let i = 0; i < battleSt.battleAllies.length; i++) {
    if (battleSt.battleAllies[i].hp > 0)
      actors.push({ type: 'ally', index: i, priority: (battleSt.battleAllies[i].agi * 2) + Math.floor(Math.random() * 256) });
  }
  if (battleSt.isRandomEncounter && battleSt.encounterMonsters) {
    for (let i = 0; i < battleSt.encounterMonsters.length; i++) {
      if (battleSt.encounterMonsters[i].hp > 0) {
        const mAgi = battleSt.encounterMonsters[i].agi || 0;
        actors.push({ type: 'enemy', index: i, priority: (mAgi * 2) + Math.floor(Math.random() * 256) });
      }
    }
  } else if (pvpSt.isPVPBattle) {
    if (pvpSt.pvpOpponentStats && pvpSt.pvpOpponentStats.hp > 0) {
      const oAgi = pvpSt.pvpOpponentStats.agi || 0;
      actors.push({ type: 'enemy', index: -1, pvpAllyIdx: -1, priority: (oAgi * 2) + Math.floor(Math.random() * 256) });
    }
    for (let i = 0; i < pvpSt.pvpEnemyAllies.length; i++) {
      if (pvpSt.pvpEnemyAllies[i].hp > 0) {
        const aAgi = pvpSt.pvpEnemyAllies[i].agi || 0;
        actors.push({ type: 'enemy', index: -1, pvpAllyIdx: i, priority: (aAgi * 2) + Math.floor(Math.random() * 256) });
      }
    }
  } else {
    actors.push({ type: 'enemy', index: -1, priority: Math.floor(Math.random() * 256) });
  }
  actors.sort((a, b) => b.priority - a.priority);
  return actors;
}

// ── Turn dispatch ──────────────────────────────────────────────────────────
export function processNextTurn() {  if (battleSt.turnQueue.length === 0) {
    battleSt.isDefending = false; inputSt.battleCursor = 0; battleSt.turnTimer = 0;
    if (ps.hp <= 0) {
      battleSt.turnQueue = buildTurnOrder();
      if (battleSt.turnQueue.length === 0) return;
      processNextTurn();
      return;
    }
    battleSt.battleState = 'menu-open'; battleSt.battleTimer = 0;
    return;
  }
  const turn = battleSt.turnQueue.shift();
  if (turn.type === 'player') {
    if (ps.hp <= 0) { processNextTurn(); return; }
    // Status turn-start: poison damage, paralysis/sleep skip, confuse flag
    if (ps.status && !turn._statusDone) {
      const { canAct, poisonDmg, confused } = processTurnStart(ps.status, ps.stats ? ps.stats.maxHP : ps.hp);
      if (!canAct) { processNextTurn(); return; }
      if (poisonDmg > 0) {
        ps.hp = Math.max(1, ps.hp - poisonDmg);
        setPlayerDamageNum({ value: poisonDmg, timer: 0 });
        battleSt.battleShakeTimer = BATTLE_SHAKE_MS;
        playSFX(SFX.ATTACK_HIT);
        turn._statusDone = true;
        battleSt.turnQueue.unshift(turn);
        battleSt.battleState = 'poison-tick'; battleSt.battleTimer = 0;
        return;
      }
      // Confused: NES picks any random living target (self, ally, or enemy)
      if (confused) {
        const pool = [];
        pool.push({ type: 'self' });
        for (let i = 0; i < battleSt.battleAllies.length; i++) {
          if (battleSt.battleAllies[i].hp > 0) pool.push({ type: 'ally', index: i });
        }
        if (battleSt.isRandomEncounter && battleSt.encounterMonsters) {
          for (let i = 0; i < battleSt.encounterMonsters.length; i++) {
            if (battleSt.encounterMonsters[i].hp > 0) pool.push({ type: 'monster', index: i });
          }
        }
        const pick = pool[Math.floor(Math.random() * pool.length)];
        const blindMult = ps.status ? blindHitPenalty(ps.status) : 1;
        const effHitRate = (ps.hitRate || 80) * blindMult;
        const lv = ps.stats?.level || 1;
        const agi = (ps.stats?.agi || 5) + getJobLevelStatBonus().agi;
        const potHits = calcPotentialHits(lv, agi, false);
        if (pick.type === 'monster') {
          const mon = battleSt.encounterMonsters[pick.index];
          const firstWpnId = isWeapon(ps.weaponR) ? ps.weaponR : ps.weaponL;
          const firstHandR = isWeapon(ps.weaponR) || !isWeapon(ps.weaponL);
          const bladed = isBladedWeapon(firstWpnId);
          inputSt.playerActionPending = { command: 'fight', targetIndex: pick.index,
            hitResults: rollHits(ps.atk, mon.def, effHitRate, potHits),
            slashFrames: getSlashFramesForWeapon(firstWpnId, firstHandR),
            slashOffX: bladed ? 8 : Math.floor(Math.random() * 40) - 20,
            slashOffY: bladed ? -8 : Math.floor(Math.random() * 40) - 20,
            slashX: 0, slashY: 0 };
        } else {
          // Self or ally: roll hits, apply damage directly, skip slash animation
          const targetDef = pick.type === 'self' ? ps.def : (battleSt.battleAllies[pick.index].def || 0);
          const hits = rollHits(ps.atk, targetDef, effHitRate, potHits);
          let totalDmg = 0;
          for (const h of hits) { if (!h.miss && !h.shieldBlock) totalDmg += h.damage; }
          if (totalDmg > 0) {
            if (pick.type === 'self') {
              ps.hp = Math.max(0, ps.hp - totalDmg);
              setPlayerDamageNum({ value: totalDmg, timer: 0 });
            } else {
              const ally = battleSt.battleAllies[pick.index];
              ally.hp = Math.max(0, ally.hp - totalDmg);
              getAllyDamageNums()[pick.index] = { value: totalDmg, timer: 0 };
            }
            battleSt.battleShakeTimer = BATTLE_SHAKE_MS;
            playSFX(SFX.ATTACK_HIT);
          }
          battleSt.battleState = 'poison-tick'; battleSt.battleTimer = 0;
          return;
        }
      }
    }
    const cmd = inputSt.playerActionPending.command;
    const pn = _playerName();
    if (cmd === 'fight') {
      if (pn) {
        const ti = inputSt.playerActionPending.targetIndex;
        const targetName = (battleSt.isRandomEncounter && battleSt.encounterMonsters && ti >= 0)
          ? (getMonsterName(battleSt.encounterMonsters[ti].monsterId) || makeNameMsg(new Uint8Array(0), 'Enemy'))
          : null;
        queueBattleMsg(targetName ? makeVsMsg(pn, targetName) : makeNameMsg(pn, ' attacks!'));
      }
      _playerTurnFight();
    }
    else if (cmd === 'defend') { inputSt.battleActionCount++; if (pn) queueBattleMsg(makeNameMsg(pn, ' defends!')); playSFX(SFX.DEFEND_HIT); battleSt.battleState = 'defend-anim'; battleSt.battleTimer = 0; }
    else if (cmd === 'item') { inputSt.battleActionCount++; _playerTurnItem(); }
    else if (cmd === 'skip') processNextTurn();
    else if (cmd === 'run') _playerTurnRun();
  } else if (turn.type === 'ally') {
    battleSt.currentAllyAttacker = turn.index;
    battleSt.allyHitIsLeft = false;
    const ally = battleSt.battleAllies[turn.index];
    if (!ally || ally.hp <= 0) { processNextTurn(); return; }
    // Ally status turn-start
    if (ally.status && !turn._statusDone) {
      const { canAct, poisonDmg } = processTurnStart(ally.status, ally.maxHP || ally.hp);
      if (!canAct) { processNextTurn(); return; }
      if (poisonDmg > 0) {
        ally.hp = Math.max(1, ally.hp - poisonDmg);
        getAllyDamageNums()[turn.index] = { value: poisonDmg, timer: 0 };
        playSFX(SFX.ATTACK_HIT);
        turn._statusDone = true;
        battleSt.turnQueue.unshift(turn);
        battleSt.battleState = 'poison-tick'; battleSt.battleTimer = 0;
        return;
      }
    }
    if (battleSt.isRandomEncounter && battleSt.encounterMonsters) {
      const living = battleSt.encounterMonsters.map((m, i) => m.hp > 0 ? i : -1).filter(i => i >= 0);
      if (living.length === 0) { processNextTurn(); return; }
      battleSt.allyTargetIndex = living[Math.floor(Math.random() * living.length)];
    } else { battleSt.allyTargetIndex = -1; }
    const targetDef = battleSt.allyTargetIndex >= 0 ? battleSt.encounterMonsters[battleSt.allyTargetIndex].def
      : pvpSt.isPVPBattle
        ? (pvpSt.pvpPlayerTargetIdx >= 0
            ? (pvpSt.pvpEnemyAllies[pvpSt.pvpPlayerTargetIdx] || pvpSt.pvpOpponentStats).def
            : pvpSt.pvpOpponentStats.def)
        : BOSS_DEF;
    const dualWield = isWeapon(ally.weaponId) && isWeapon(ally.weaponL);
    const potentialHits = calcPotentialHits(ally.level || 1, ally.agi, dualWield);
    battleSt.allyHitResults = rollHits(ally.atk, targetDef, ally.hitRate || 85, potentialHits);
    battleSt.allyHitIdx = 0;
    battleSt.allyHitResult = battleSt.allyHitResults[0];
    battleSt.battleState = 'ally-attack-back'; battleSt.battleTimer = 0;
  } else {
    battleSt.currentAttacker = turn.index;
    // Monster status turn-start: poison damage, paralysis skip
    if (turn.index >= 0 && battleSt.encounterMonsters && battleSt.encounterMonsters[turn.index] && !turn._statusDone) {
      const mon = battleSt.encounterMonsters[turn.index];
      if (mon.status) {
        const { canAct, poisonDmg } = processTurnStart(mon.status, mon.maxHP);
        if (!canAct || mon.hp <= 0) { processNextTurn(); return; }
        if (poisonDmg > 0) {
          mon.hp = Math.max(0, mon.hp - poisonDmg);
          setEnemyDmgNum({ value: poisonDmg, timer: 0 });
          playSFX(SFX.ATTACK_HIT);
          turn._statusDone = true;
          battleSt.turnQueue.unshift(turn);
          battleSt.battleState = 'poison-tick'; battleSt.battleTimer = 0;
          return;
        }
      }
    }
    if (pvpSt.isPVPBattle) {
      const pai = turn.pvpAllyIdx ?? -1;
      pvpSt.pvpCurrentEnemyAllyIdx = pai;
      if (pai < 0 && (!pvpSt.pvpOpponentStats || pvpSt.pvpOpponentStats.hp <= 0)) { processNextTurn(); return; }
      if (pai >= 0 && (pvpSt.pvpEnemyAllies[pai]?.hp ?? 0) <= 0) { processNextTurn(); return; }
      if (pai < 0) pvpSt.pvpEnemyHitIdx = 0;
    }
    if (turn.index >= 0 && battleSt.encounterMonsters && battleSt.encounterMonsters[turn.index].hp <= 0) { processNextTurn(); return; }
    battleSt.battleState = 'enemy-flash'; battleSt.battleTimer = 0; pvpSt.pvpPreflashDecided = false;
  }
}

// ── Player turn actions ────────────────────────────────────────────────────
function _playerTurnFight() {
  let ti = inputSt.playerActionPending.targetIndex;
  if (battleSt.isRandomEncounter && battleSt.encounterMonsters && ti >= 0 && battleSt.encounterMonsters[ti].hp <= 0) {
    const living = battleSt.encounterMonsters.findIndex(m => m.hp > 0);
    if (living < 0) { processNextTurn(); return; }
    ti = living;
  }
  battleSt.currentHitIdx = 0; battleSt.slashFrame = 0;
  inputSt.hitResults = inputSt.playerActionPending.hitResults;
  inputSt.targetIndex = ti;
  bsc.slashFrames = inputSt.playerActionPending.slashFrames;
  battleSt.slashOffX = inputSt.playerActionPending.slashOffX; battleSt.slashOffY = inputSt.playerActionPending.slashOffY;
  battleSt.slashX = inputSt.playerActionPending.slashX; battleSt.slashY = inputSt.playerActionPending.slashY;
  battleSt.battleState = 'attack-back'; battleSt.battleTimer = 0;
}

const CURE_NAME_TO_FLAG = {
  poison: STATUS.POISON, blind: STATUS.BLIND, silence: STATUS.SILENCE,
  mini: STATUS.MINI, toad: STATUS.TOAD, petrify: STATUS.PETRIFY,
  paralysis: STATUS.PARALYSIS,
};

function _playerTurnConsumable() {
  const itemId = inputSt.playerActionPending.itemId;
  const itemDat = ITEMS.get(itemId);
  const effect = itemDat?.effect || 'heal';
  const power = itemDat?.power || 50;

  playSFX(SFX.CURE);
  const { target, allyIndex } = inputSt.playerActionPending;

  if (effect === 'cure_status') {
    // Status cure items — only target player for now
    const flag = CURE_NAME_TO_FLAG[itemDat.cures];
    if (flag && ps.status) removeStatus(ps.status, flag);
    battleSt.itemHealAmount = 0;
    battleSt.battleState = 'item-use'; battleSt.battleTimer = 0;
    return;
  }

  if (effect === 'full_heal') {
    // Elixir — full HP restore
    if (target === 'player' && (allyIndex === undefined || allyIndex < 0)) {
      const heal = ps.stats.maxHP - ps.hp;
      ps.hp = ps.stats.maxHP; battleSt.itemHealAmount = heal; setPlayerHealNum({ value: heal, timer: 0 });
    }
    battleSt.battleState = 'item-use'; battleSt.battleTimer = 0;
    return;
  }

  // Default: heal HP by power amount
  if (target === 'player' && (allyIndex === undefined || allyIndex < 0)) {
    const heal = Math.min(power, ps.stats.maxHP - ps.hp);
    ps.hp += heal; battleSt.itemHealAmount = heal; setPlayerHealNum({ value: heal, timer: 0 });
  } else if (target === 'player' && allyIndex >= 0) {
    const ally = battleSt.battleAllies[allyIndex];
    if (ally) {
      const heal = Math.min(power, ally.maxHP - ally.hp);
      ally.hp += heal; battleSt.itemHealAmount = heal;
      getAllyDamageNums()[allyIndex] = { value: heal, timer: 0, heal: true };
    }
  } else {
    const mon = battleSt.isRandomEncounter && battleSt.encounterMonsters ? battleSt.encounterMonsters[target] : null;
    if (mon) {
      const heal = Math.min(power, mon.maxHP - mon.hp);
      mon.hp += heal; battleSt.itemHealAmount = heal; setEnemyHealNum({ value: heal, timer: 0, index: target });
    } else {
      const curHP = getEnemyHP();
      const maxHP = pvpSt.isPVPBattle ? (pvpSt.pvpOpponentStats ? pvpSt.pvpOpponentStats.maxHP : 1) : BOSS_MAX_HP;
      const heal = Math.min(power, maxHP - curHP);
      setEnemyHP(curHP + heal); battleSt.itemHealAmount = heal; setEnemyHealNum({ value: heal, timer: 0, index: 0 });
    }
  }
  battleSt.battleState = 'item-use'; battleSt.battleTimer = 0;
}

function _playerTurnItem() {
  battleSt.isDefending = false;
  removeItem(inputSt.playerActionPending.itemId);
  if (ITEMS.get(inputSt.playerActionPending.itemId)?.type === 'battle_item') startMagicItem();
  else _playerTurnConsumable();
}

function _playerTurnRun() {
  const playerAgi = (ps.stats ? ps.stats.agi : 5) + getJobLevelStatBonus().agi;
  let avgLevel = 1;
  if (battleSt.encounterMonsters) {
    const alive = battleSt.encounterMonsters.filter(m => m.hp > 0);
    if (alive.length > 0) avgLevel = alive.reduce((s, m) => s + (m.level || 1), 0) / alive.length;
  }
  const successRate = Math.min(99, Math.max(1, playerAgi + 25 - Math.floor(avgLevel / 4)));
  if (Math.floor(Math.random() * 100) < successRate) {
    queueBattleMsg(BATTLE_RAN_AWAY);
    playSFX(SFX.RUN_AWAY);
    battleSt.battleState = 'run-success'; battleSt.battleTimer = 0;
  } else {
    queueBattleMsg(BATTLE_CANT_ESCAPE);
    battleSt.battleState = 'run-fail'; battleSt.battleTimer = 0;
  }
}
