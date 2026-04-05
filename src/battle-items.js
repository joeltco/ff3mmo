// Battle magic-item logic — extracted from game.js
// Handles Southwind and future magic battle items (spell items).

import { SFX, playSFX } from './music.js';

let _s = null;

// ── State (module-local, reset via resetBattleItemVars) ─────────────────────
let targets = [];       // ordered list of enemy indices to hit
let hitIdx = 0;         // current target being hit
let dmgApplied = false; // damage applied this cycle
let baseDamage = 0;     // rolled once per throw, split among targets
let dmgNums = {};       // {enemyIdx: {value, timer}} — damage numbers during sw-hit

export function resetBattleItemVars() {
  targets = []; hitIdx = 0; dmgNums = {};
}

export function getTargets()  { return targets; }
export function getHitIdx()   { return hitIdx; }
export function getDmgNums()  { return dmgNums; }

// ── Damage number timer tick (called from _updateBattleTimers) ──────────────
export function tickDmgNums(dt) {
  for (const k of Object.keys(dmgNums)) {
    dmgNums[k].timer += dt;
    if (dmgNums[k].timer >= 700) delete dmgNums[k];
  }
}

// ── Target selection ────────────────────────────────────────────────────────
function _buildTargets(shared) {
  const mode = shared.inputSt.playerActionPending.targetMode || 'single';
  const pvp = shared.pvpSt;

  if (pvp && pvp.isPVPBattle) {
    if (mode === 'all') {
      targets = [];
      if (pvp.pvpOpponentStats && pvp.pvpOpponentStats.hp > 0) targets.push(0);
      pvp.pvpEnemyAllies.forEach((a, i) => { if (a.hp > 0) targets.push(i + 1); });
    } else {
      targets = [shared.inputSt.playerActionPending.target];
    }
  } else if (shared.isRandomEncounter && shared.encounterMonsters) {
    const mons = shared.encounterMonsters;
    const rightCols = mons.map((m, i) =>
      (m.hp > 0 && (mons.length === 1 || (mons.length === 2 && i === 1) || (mons.length >= 3 && (i === 1 || i === 3)))) ? i : -1).filter(i => i >= 0);
    const leftCols = mons.map((m, i) =>
      (m.hp > 0 && mons.length >= 2 && !rightCols.includes(i)) ? i : -1).filter(i => i >= 0);
    if (mode === 'all') {
      const ecnt = mons.length;
      targets = (ecnt <= 2 ? [0, 1] : [0, 1, 2, 3]).filter(i => i < ecnt && mons[i].hp > 0);
    } else if (mode === 'col-right') targets = rightCols;
    else if (mode === 'col-left') targets = leftCols;
    else targets = [shared.inputSt.playerActionPending.target];
  } else {
    // Boss — single target
    targets = shared.getEnemyHP() > 0 ? [0] : [];
  }
}

// ── Damage application (one target at a time) ──────────────────────────────
function _applyDamage(tidx) {
  const dmg = Math.max(1, Math.floor(baseDamage / targets.length));
  const pvp = _s.pvpSt;

  if (pvp && pvp.isPVPBattle) {
    if (tidx === 0) {
      if (!pvp.pvpOpponentStats || pvp.pvpOpponentStats.hp <= 0) return;
      pvp.pvpOpponentStats.hp = Math.max(0, pvp.pvpOpponentStats.hp - dmg);
    } else {
      const ally = pvp.pvpEnemyAllies[tidx - 1];
      if (!ally || ally.hp <= 0) return;
      ally.hp = Math.max(0, ally.hp - dmg);
    }
    dmgNums[tidx] = { value: dmg, timer: 0 };
    playSFX(SFX.SW_HIT);
    return;
  }
  if (_s.isRandomEncounter && _s.encounterMonsters) {
    const mon = _s.encounterMonsters[tidx];
    if (!mon || mon.hp <= 0) return;
    mon.hp = Math.max(0, mon.hp - dmg);
  } else {
    // Boss
    if (_s.getEnemyHP() <= 0) return;
    _s.setEnemyHP(Math.max(0, _s.getEnemyHP() - dmg));
  }
  dmgNums[tidx] = { value: dmg, timer: 0 };
  playSFX(SFX.SW_HIT);
}

// ── Start magic item turn ───────────────────────────────────────────────────
export function startMagicItem(shared) {
  _s = shared;
  _buildTargets(shared);
  hitIdx = 0;
  const intStat = shared.ps.stats ? shared.ps.stats.int : 5;
  const swAttack = Math.floor(intStat / 2) + 55;
  baseDamage = Math.floor((swAttack + Math.floor(Math.random() * Math.floor(swAttack / 2 + 1))) / 2);
  shared.battleState = 'sw-throw';
  shared.battleTimer = 0;
}

// ── Update sw-throw / sw-hit states ─────────────────────────────────────────
export function updateMagicItemThrowHit(shared) {
  _s = shared;
  if (shared.battleState === 'sw-throw') {
    if (shared.battleTimer >= 250) {
      if (targets.length === 0) { shared.processNextTurn(); }
      else {
        hitIdx = 0;
        dmgApplied = false;
        shared.battleState = 'sw-hit'; shared.battleTimer = 0;
      }
    }
    return true;
  }
  // sw-hit: explosion 400ms, then damage + shake, hold until 1100ms
  if (!dmgApplied && shared.battleTimer >= 400) {
    _applyDamage(targets[hitIdx]);
    dmgApplied = true;
  }
  if (shared.battleTimer >= 1100) {
    hitIdx++;
    dmgApplied = false;
    if (hitIdx < targets.length) {
      shared.battleTimer = 0;
    } else {
      const pvp = shared.pvpSt;
      if (pvp && pvp.isPVPBattle) {
        const killed = [];
        if (pvp.pvpOpponentStats && pvp.pvpOpponentStats.hp <= 0 && targets.includes(0)) killed.push(0);
        targets.forEach(tidx => {
          if (tidx > 0 && pvp.pvpEnemyAllies[tidx - 1] && pvp.pvpEnemyAllies[tidx - 1].hp <= 0) killed.push(tidx);
        });
        if (killed.length > 0) {
          pvp.pvpDyingMap = new Map(killed.map((i, n) => [i, n * 60]));
          shared.battleState = 'pvp-dissolve'; shared.battleTimer = 0; playSFX(SFX.MONSTER_DEATH);
        } else { shared.processNextTurn(); }
        return true;
      }
      if (shared.isRandomEncounter && shared.encounterMonsters) {
        const killed = targets.filter(i => shared.encounterMonsters[i] && shared.encounterMonsters[i].hp <= 0);
        if (killed.length > 0) {
          const waveOrder = [1, 0, 3, 2];
          const ordered = waveOrder.filter(i => killed.includes(i));
          for (const i of killed) { if (!ordered.includes(i)) ordered.push(i); }
          shared.dyingMonsterIndices = new Map(ordered.map((i, n) => [i, n * 60]));
          playSFX(SFX.MONSTER_DEATH);
          shared.battleState = 'monster-death'; shared.battleTimer = 0;
        } else { shared.processNextTurn(); }
      } else if (shared.getEnemyHP() <= 0) {
        shared.battleState = 'boss-dissolve'; shared.battleTimer = 0; playSFX(SFX.BOSS_DEATH);
      } else { shared.processNextTurn(); }
    }
  }
  return true;
}
