// Battle magic-item logic — extracted from game.js
// Handles Southwind and future magic battle items (spell items).

import { battleSt, getEnemyHP, setEnemyHP } from './battle-state.js';
import { pvpSt } from './pvp.js';
import { ps } from './player-stats.js';
import { inputSt } from './input-handler.js';
import { SFX, playSFX } from './music.js';
import { setSwDmgNum } from './damage-numbers.js';

// Injected callback (set via initBattleItems) to avoid circular import on game.js
let _processNextTurn = () => {};
export function initBattleItems({ processNextTurn }) { _processNextTurn = processNextTurn; }

// ── State (module-local, reset via resetBattleItemVars) ─────────────────────
let targets = [];       // ordered list of enemy indices to hit
let hitIdx = 0;         // current target being hit
let dmgApplied = false; // damage applied this cycle
let baseDamage = 0;     // rolled once per throw, split among targets

export function resetBattleItemVars() {
  targets = []; hitIdx = 0;
}

export function getTargets()  { return targets; }
export function getHitIdx()   { return hitIdx; }

// ── Target selection ────────────────────────────────────────────────────────
function _buildTargets() {
  const mode = inputSt.playerActionPending.targetMode || 'single';

  if (pvpSt.isPVPBattle) {
    if (mode === 'all') {
      targets = [];
      if (pvpSt.pvpOpponentStats && pvpSt.pvpOpponentStats.hp > 0) targets.push(0);
      pvpSt.pvpEnemyAllies.forEach((a, i) => { if (a.hp > 0) targets.push(i + 1); });
    } else {
      targets = [inputSt.playerActionPending.target];
    }
  } else if (battleSt.isRandomEncounter && battleSt.encounterMonsters) {
    const mons = battleSt.encounterMonsters;
    const rightCols = mons.map((m, i) =>
      (m.hp > 0 && (mons.length === 1 || (mons.length === 2 && i === 1) || (mons.length >= 3 && (i === 1 || i === 3)))) ? i : -1).filter(i => i >= 0);
    const leftCols = mons.map((m, i) =>
      (m.hp > 0 && mons.length >= 2 && !rightCols.includes(i)) ? i : -1).filter(i => i >= 0);
    if (mode === 'all') {
      const ecnt = mons.length;
      targets = (ecnt <= 2 ? [0, 1] : [0, 1, 2, 3]).filter(i => i < ecnt && mons[i].hp > 0);
    } else if (mode === 'col-right') targets = rightCols;
    else if (mode === 'col-left') targets = leftCols;
    else targets = [inputSt.playerActionPending.target];
  } else {
    // Boss — single target
    targets = getEnemyHP() > 0 ? [0] : [];
  }
}

// ── Damage application (one target at a time) ──────────────────────────────
function _applyDamage(tidx) {
  const dmg = Math.max(1, Math.floor(baseDamage / targets.length));

  if (pvpSt.isPVPBattle) {
    if (tidx === 0) {
      if (!pvpSt.pvpOpponentStats || pvpSt.pvpOpponentStats.hp <= 0) return;
      pvpSt.pvpOpponentStats.hp = Math.max(0, pvpSt.pvpOpponentStats.hp - dmg);
    } else {
      const ally = pvpSt.pvpEnemyAllies[tidx - 1];
      if (!ally || ally.hp <= 0) return;
      ally.hp = Math.max(0, ally.hp - dmg);
    }
    setSwDmgNum(tidx, dmg);
    playSFX(SFX.SW_HIT);
    return;
  }
  if (battleSt.isRandomEncounter && battleSt.encounterMonsters) {
    const mon = battleSt.encounterMonsters[tidx];
    if (!mon || mon.hp <= 0) return;
    mon.hp = Math.max(0, mon.hp - dmg);
  } else {
    // Boss
    if (getEnemyHP() <= 0) return;
    setEnemyHP(Math.max(0, getEnemyHP() - dmg));
  }
  setSwDmgNum(tidx, dmg);
  playSFX(SFX.SW_HIT);
}

// ── Start magic item turn ───────────────────────────────────────────────────
export function startMagicItem() {
  _buildTargets();
  hitIdx = 0;
  const intStat = ps.stats ? ps.stats.int : 5;
  const swAttack = Math.floor(intStat / 2) + 55;
  baseDamage = Math.floor((swAttack + Math.floor(Math.random() * Math.floor(swAttack / 2 + 1))) / 2);
  battleSt.battleState = 'sw-throw';
  battleSt.battleTimer = 0;
}

// ── Update sw-throw / sw-hit states ─────────────────────────────────────────
export function updateMagicItemThrowHit() {
  if (battleSt.battleState === 'sw-throw') {
    if (battleSt.battleTimer >= 250) {
      if (targets.length === 0) { _processNextTurn(); }
      else {
        hitIdx = 0;
        dmgApplied = false;
        battleSt.battleState = 'sw-hit'; battleSt.battleTimer = 0;
      }
    }
    return true;
  }
  // sw-hit: explosion 400ms, then damage + shake, hold until 1100ms
  if (!dmgApplied && battleSt.battleTimer >= 400) {
    _applyDamage(targets[hitIdx]);
    dmgApplied = true;
  }
  if (battleSt.battleTimer >= 1100) {
    hitIdx++;
    dmgApplied = false;
    if (hitIdx < targets.length) {
      battleSt.battleTimer = 0;
    } else {
      if (pvpSt.isPVPBattle) {
        const killed = [];
        if (pvpSt.pvpOpponentStats && pvpSt.pvpOpponentStats.hp <= 0 && targets.includes(0)) killed.push(0);
        targets.forEach(tidx => {
          if (tidx > 0 && pvpSt.pvpEnemyAllies[tidx - 1] && pvpSt.pvpEnemyAllies[tidx - 1].hp <= 0) killed.push(tidx);
        });
        if (killed.length > 0) {
          pvpSt.pvpDyingMap = new Map(killed.map((i, n) => [i, n * 60]));
          battleSt.battleState = 'pvp-dissolve'; battleSt.battleTimer = 0; playSFX(SFX.MONSTER_DEATH);
        } else { _processNextTurn(); }
        return true;
      }
      if (battleSt.isRandomEncounter && battleSt.encounterMonsters) {
        const killed = targets.filter(i => battleSt.encounterMonsters[i] && battleSt.encounterMonsters[i].hp <= 0);
        if (killed.length > 0) {
          const waveOrder = [1, 0, 3, 2];
          const ordered = waveOrder.filter(i => killed.includes(i));
          for (const i of killed) { if (!ordered.includes(i)) ordered.push(i); }
          battleSt.dyingMonsterIndices = new Map(ordered.map((i, n) => [i, n * 60]));
          playSFX(SFX.MONSTER_DEATH);
          battleSt.battleState = 'monster-death'; battleSt.battleTimer = 0;
        } else { _processNextTurn(); }
      } else if (getEnemyHP() <= 0) {
        battleSt.battleState = 'boss-dissolve'; battleSt.battleTimer = 0; playSFX(SFX.BOSS_DEATH);
      } else { _processNextTurn(); }
    }
  }
  return true;
}
