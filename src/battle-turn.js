// Battle turn order + turn dispatch — extracted from game.js

import { battleSt, getEnemyHP, setEnemyHP, BATTLE_SHAKE_MS, BOSS_DEF, BOSS_MAX_HP } from './battle-state.js';
import { rollHits, calcPotentialHits } from './battle-math.js';
import { BATTLE_RAN_AWAY, BATTLE_CANT_ESCAPE } from './data/strings.js';
import { getMonsterName } from './text-decoder.js';
import { ps, getJobLevelStatBonus } from './player-stats.js';
import { JOBS } from './data/jobs.js';
import { ITEMS, isWeapon, isBladedWeapon } from './data/items.js';
import { SFX, playSFX } from './music.js';
import { processTurnStart, removeStatus, STATUS, blindHitPenalty, hasStatus } from './status-effects.js';
import { bsc, getSlashFramesForWeapon } from './battle-sprite-cache.js';
import { pvpSt } from './pvp.js';
import { inputSt } from './input-handler.js';
import { queueBattleMsg } from './battle-msg.js';
import { _nameToBytes } from './text-utils.js';
import { getAllyDamageNums, setEnemyDmgNum, setEnemyHealNum, setPlayerDamageNum, setPlayerHealNum } from './damage-numbers.js';
import { startMagicItem } from './battle-items.js';
import { startSpellCast } from './spell-cast.js';
import { selectCursor, saveSlots, saveSlotsToDB } from './save-state.js';
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
    // End-of-round poison: every poisoned actor (player + allies + monsters /
    // PVP opponents) ticks simultaneously, damage numbers pop together, no
    // portrait shake or hit-pose. Differs from NES (per-turn-start tick) but
    // matches the requested UX of one consolidated end-of-round phase.
    if (_applyEndOfRoundPoison()) {
      battleSt.battleState = 'poison-end-tick'; battleSt.battleTimer = 0;
      return;
    }
    battleSt.battleState = 'menu-open'; battleSt.battleTimer = 0;
    return;
  }
  const turn = battleSt.turnQueue.shift();
  if (turn.type === 'player') {
    if (ps.hp <= 0) { processNextTurn(); return; }
    // Status turn-start: paralysis/sleep skip, confuse flag.
    // Poison damage is deferred to end-of-round (see _applyEndOfRoundPoison).
    if (ps.status && !turn._statusDone) {
      const { canAct, confused } = processTurnStart(ps.status, ps.stats ? ps.stats.maxHP : ps.hp);
      if (!canAct) { processNextTurn(); return; }
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
        const _playerJob = JOBS[ps.jobIdx] || {};
        const _playerCrit = { critPct: _playerJob.critPct || 0, critBonus: _playerJob.critBonus || 0 };
        if (pick.type === 'monster') {
          const mon = battleSt.encounterMonsters[pick.index];
          const firstWpnId = isWeapon(ps.weaponR) ? ps.weaponR : ps.weaponL;
          const firstHandR = isWeapon(ps.weaponR) || !isWeapon(ps.weaponL);
          const bladed = isBladedWeapon(firstWpnId);
          inputSt.playerActionPending = { command: 'fight', targetIndex: pick.index,
            hitResults: rollHits(ps.atk, mon.def, effHitRate, potHits, { ..._playerCrit, evade: mon.evade || 0 }),
            slashFrames: getSlashFramesForWeapon(firstWpnId, firstHandR),
            slashOffX: bladed ? 8 : Math.floor(Math.random() * 40) - 20,
            slashOffY: bladed ? -8 : Math.floor(Math.random() * 40) - 20,
            slashX: 0, slashY: 0 };
        } else {
          // Self or ally: roll hits, apply damage directly, skip slash animation
          const targetDef = pick.type === 'self' ? ps.def : (battleSt.battleAllies[pick.index].def || 0);
          const hits = rollHits(ps.atk, targetDef, effHitRate, potHits, _playerCrit);
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
      if (pn) queueBattleMsg(pn);
      _playerTurnFight();
    }
    else if (cmd === 'defend') { inputSt.battleActionCount++; if (pn) queueBattleMsg(pn); playSFX(SFX.DEFEND_HIT); battleSt.battleState = 'defend-anim'; battleSt.battleTimer = 0; }
    else if (cmd === 'item') { inputSt.battleActionCount++; _playerTurnItem(); }
    else if (cmd === 'magic') { inputSt.battleActionCount++; _playerTurnMagic(); }
    else if (cmd === 'skip') processNextTurn();
    else if (cmd === 'run') _playerTurnRun();
  } else if (turn.type === 'ally') {
    battleSt.currentAllyAttacker = turn.index;
    battleSt.allyHitIsLeft = false;
    const ally = battleSt.battleAllies[turn.index];
    if (!ally || ally.hp <= 0) { processNextTurn(); return; }
    // Ally status turn-start (paralysis/sleep). Poison damage deferred.
    if (ally.status && !turn._statusDone) {
      const { canAct } = processTurnStart(ally.status, ally.maxHP || ally.hp);
      if (!canAct) { processNextTurn(); return; }
    }
    // White Mage heal AI — pick lowest-HP-pct teammate (player or other ally) below 60% HP.
    // If anyone needs healing AND ally knows Cure (0x34), cast on them. Else fall through to Poisona check / attack.
    if (_tryAllyCure(ally, turn.index)) return;
    // White Mage status AI — if anyone (incl self) is poisoned and ally knows Poisona (0x35), cast it.
    if (_tryAllyPoisona(ally, turn.index)) return;
    if (battleSt.isRandomEncounter && battleSt.encounterMonsters) {
      const living = battleSt.encounterMonsters.map((m, i) => m.hp > 0 ? i : -1).filter(i => i >= 0);
      if (living.length === 0) { processNextTurn(); return; }
      battleSt.allyTargetIndex = living[Math.floor(Math.random() * living.length)];
    } else { battleSt.allyTargetIndex = -1; }
    const monTgt = battleSt.allyTargetIndex >= 0 ? battleSt.encounterMonsters[battleSt.allyTargetIndex] : null;
    const pvpTgt = !monTgt && pvpSt.isPVPBattle
      ? (pvpSt.pvpPlayerTargetIdx >= 0
          ? (pvpSt.pvpEnemyAllies[pvpSt.pvpPlayerTargetIdx] || pvpSt.pvpOpponentStats)
          : pvpSt.pvpOpponentStats)
      : null;
    const targetDef = monTgt ? monTgt.def : pvpTgt ? pvpTgt.def : BOSS_DEF;
    // Unarmed = dual fists (same as player path) → 2x hits.
    const aRw = isWeapon(ally.weaponId), aLw = isWeapon(ally.weaponL);
    const dualWield = (aRw && aLw) || (!aRw && !aLw);
    const potentialHits = calcPotentialHits(ally.level || 1, ally.agi, dualWield);
    const _allyJob = JOBS[ally.jobIdx || 0] || {};
    battleSt.allyHitResults = rollHits(ally.atk, targetDef, ally.hitRate || 85, potentialHits, {
      critPct: _allyJob.critPct || 0,
      critBonus: _allyJob.critBonus || 0,
      shieldEvade: pvpTgt ? (pvpTgt.shieldEvade || 0) : 0,
      evade: monTgt ? (monTgt.evade || 0) : pvpTgt ? (pvpTgt.evade || 0) : 0,
    });
    battleSt.allyHitIdx = 0;
    battleSt.allyHitResult = battleSt.allyHitResults[0];
    battleSt.battleState = 'ally-attack-back'; battleSt.battleTimer = 0;
  } else {
    battleSt.currentAttacker = turn.index;
    // Monster status turn-start: paralysis skip. Poison damage deferred.
    if (turn.index >= 0 && battleSt.encounterMonsters && battleSt.encounterMonsters[turn.index] && !turn._statusDone) {
      const mon = battleSt.encounterMonsters[turn.index];
      if (mon.status) {
        const { canAct } = processTurnStart(mon.status, mon.maxHP);
        if (!canAct || mon.hp <= 0) { processNextTurn(); return; }
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
    // Queue the actor name BEFORE the preflash so the 200ms message fade-in
    // overlaps the 133ms BOSS_PREFLASH_MS window. Without this the message
    // started fading in only after the swing began, so the player saw the hit
    // land before the name appeared. Both regular and PVP enemy turns route
    // through here.
    if (pvpSt.isPVPBattle) {
      const pai = pvpSt.pvpCurrentEnemyAllyIdx;
      const stats = pai >= 0 ? pvpSt.pvpEnemyAllies[pai] : pvpSt.pvpOpponentStats;
      if (stats && stats.name) queueBattleMsg(_nameToBytes(stats.name));
    } else if (battleSt.currentAttacker >= 0 && battleSt.encounterMonsters) {
      const mon = battleSt.encounterMonsters[battleSt.currentAttacker];
      if (mon) queueBattleMsg(getMonsterName(mon.monsterId) || _nameToBytes('Enemy'));
    }
    battleSt.battleState = 'enemy-flash'; battleSt.battleTimer = 0; pvpSt.pvpPreflashDecided = false;
  }
}

// ── End-of-round poison ────────────────────────────────────────────────────
// Walks every living combatant once. Anyone with the POISON flag takes
// floor(maxHP/16) and gets a damage-num popped on their slot. Player + allies
// clamp to HP 1 (NES never lets poison kill from full); enemies/monsters can
// die. Returns true if any actor ticked (caller drives the hold-state).
function _applyEndOfRoundPoison() {
  let anyTicked = false;
  if (ps.hp > 0 && ps.status && hasStatus(ps.status, STATUS.POISON)) {
    const max = ps.stats ? ps.stats.maxHP : ps.hp;
    const dmg = Math.floor(max / 16);
    if (dmg > 0) {
      ps.hp = Math.max(1, ps.hp - dmg);
      setPlayerDamageNum({ value: dmg, timer: 0 });
      anyTicked = true;
    }
  }
  for (let i = 0; i < battleSt.battleAllies.length; i++) {
    const ally = battleSt.battleAllies[i];
    if (!ally || ally.hp <= 0 || !ally.status) continue;
    if (!hasStatus(ally.status, STATUS.POISON)) continue;
    const dmg = Math.floor((ally.maxHP || ally.hp) / 16);
    if (dmg <= 0) continue;
    ally.hp = Math.max(1, ally.hp - dmg);
    getAllyDamageNums()[i] = { value: dmg, timer: 0 };
    anyTicked = true;
  }
  if (battleSt.isRandomEncounter && battleSt.encounterMonsters) {
    for (let i = 0; i < battleSt.encounterMonsters.length; i++) {
      const mon = battleSt.encounterMonsters[i];
      if (!mon || mon.hp <= 0 || !mon.status) continue;
      if (!hasStatus(mon.status, STATUS.POISON)) continue;
      const dmg = Math.floor((mon.maxHP || mon.hp) / 16);
      if (dmg <= 0) continue;
      mon.hp = Math.max(0, mon.hp - dmg);
      setEnemyDmgNum({ value: dmg, timer: 0, index: i });
      anyTicked = true;
    }
  }
  if (pvpSt.isPVPBattle) {
    const opp = pvpSt.pvpOpponentStats;
    if (opp && opp.hp > 0 && opp.status && hasStatus(opp.status, STATUS.POISON)) {
      const dmg = Math.floor((opp.maxHP || opp.hp) / 16);
      if (dmg > 0) { opp.hp = Math.max(0, opp.hp - dmg); setEnemyDmgNum({ value: dmg, timer: 0 }); anyTicked = true; }
    }
    for (let i = 0; i < pvpSt.pvpEnemyAllies.length; i++) {
      const e = pvpSt.pvpEnemyAllies[i];
      if (!e || e.hp <= 0 || !e.status) continue;
      if (!hasStatus(e.status, STATUS.POISON)) continue;
      const dmg = Math.floor((e.maxHP || e.hp) / 16);
      if (dmg <= 0) continue;
      e.hp = Math.max(0, e.hp - dmg);
      anyTicked = true;
    }
  }
  return anyTicked;
}

// ── Ally heal AI (White Mage) ──────────────────────────────────────────────
// Returns true if ally cast Cure this turn (caller should NOT also do attack).
function _tryAllyCure(ally, allyIdx) {
  if (!ally.knownSpells || !ally.knownSpells.includes(0x34)) return false;
  // Build heal candidates: player + every other living ally. Each entry tracks
  // hpPct so we can pick the one most in need. Threshold: < 0.6 = needs heal.
  const candidates = [];
  if (ps.hp > 0 && ps.stats && ps.stats.maxHP) {
    candidates.push({ type: 'player', idx: -1, pct: ps.hp / ps.stats.maxHP });
  }
  for (let i = 0; i < battleSt.battleAllies.length; i++) {
    const other = battleSt.battleAllies[i];
    if (!other || other.hp <= 0) continue;
    if (!other.maxHP) continue;
    candidates.push({ type: 'ally', idx: i, pct: other.hp / other.maxHP });
  }
  // Need at least one teammate below 60% HP. Pick the lowest pct.
  candidates.sort((a, b) => a.pct - b.pct);
  const lowest = candidates[0];
  if (!lowest || lowest.pct >= 0.6) return false;
  // Cure power 42, formula: floor(MND/2) + power + rand(0..floor(atk/2))
  const mnd = ally.mnd || 5;
  const atk = Math.floor(mnd / 2) + 42;
  const heal = atk + Math.floor(Math.random() * (Math.floor(atk / 2) + 1));
  battleSt.allyMagicCasterIdx    = allyIdx;
  battleSt.allyMagicTargetType   = lowest.type;
  battleSt.allyMagicTargetIdx    = lowest.idx;
  battleSt.allyMagicSpellId      = 0x34;
  battleSt.allyMagicHealAmount   = heal;
  battleSt.allyMagicEffectApplied = false;
  battleSt.allyMagicItemMode     = false;
  queueBattleMsg(_nameToBytes(ally.name || 'Ally'));
  playSFX(SFX.MAGIC_CAST);
  battleSt.battleState = 'ally-magic-cast';
  battleSt.battleTimer = 0;
  return true;
}

// ── Ally Poisona AI ────────────────────────────────────────────────────────
// Returns true if ally cast Poisona this turn. Targets first poisoned teammate
// (player → self → other allies). MP-gated upstream by knownSpells presence;
// no need to deduct MP here since fake-roster allies don't track MP.
function _tryAllyPoisona(ally, allyIdx) {
  if (!ally.knownSpells || !ally.knownSpells.includes(0x35)) return false;
  let target = null;
  if (ps.hp > 0 && ps.status && hasStatus(ps.status, STATUS.POISON)) {
    target = { type: 'player', idx: -1 };
  }
  if (!target) {
    if (ally.status && hasStatus(ally.status, STATUS.POISON)) {
      target = { type: 'ally', idx: allyIdx };
    }
  }
  if (!target) {
    for (let i = 0; i < battleSt.battleAllies.length; i++) {
      if (i === allyIdx) continue;
      const other = battleSt.battleAllies[i];
      if (!other || other.hp <= 0 || !other.status) continue;
      if (hasStatus(other.status, STATUS.POISON)) {
        target = { type: 'ally', idx: i };
        break;
      }
    }
  }
  if (!target) return false;
  battleSt.allyMagicCasterIdx     = allyIdx;
  battleSt.allyMagicTargetType    = target.type;
  battleSt.allyMagicTargetIdx     = target.idx;
  battleSt.allyMagicSpellId       = 0x35;
  battleSt.allyMagicHealAmount    = 0;
  battleSt.allyMagicEffectApplied = false;
  battleSt.allyMagicItemMode      = false;
  queueBattleMsg(_nameToBytes(ally.name || 'Ally'));
  playSFX(SFX.MAGIC_CAST);
  battleSt.battleState = 'ally-magic-cast';
  battleSt.battleTimer = 0;
  return true;
}

// ── Ally item AI (cure potion / antidote) ──────────────────────────────────
// Roster ally consumes a Cure Potion (target heal 50) or Antidote (cure POISON
// on target). Reuses the ally-magic-cast / ally-magic-hit pipeline with
// allyMagicItemMode=true to suppress the cast flame; sparkle + heal-num still
// render on the target as with spell casts.
function _tryAllyItem(ally, allyIdx) {
  if (Math.random() >= 0.25) return false;
  // Antidote: any teammate (incl self / player) with POISON
  let targetType = null, targetIdx = -1, spellSentinel = 0;
  if (ps.hp > 0 && ps.status && hasStatus(ps.status, STATUS.POISON)) {
    targetType = 'player'; targetIdx = -1; spellSentinel = 0x35;
  } else if (ally.status && hasStatus(ally.status, STATUS.POISON)) {
    targetType = 'ally'; targetIdx = allyIdx; spellSentinel = 0x35;
  } else {
    for (let i = 0; i < battleSt.battleAllies.length; i++) {
      if (i === allyIdx) continue;
      const o = battleSt.battleAllies[i];
      if (!o || o.hp <= 0 || !o.status) continue;
      if (hasStatus(o.status, STATUS.POISON)) { targetType = 'ally'; targetIdx = i; spellSentinel = 0x35; break; }
    }
  }
  // Cure Potion: lowest-HP teammate < 50%
  if (!targetType) {
    const candidates = [];
    if (ps.hp > 0 && ps.stats && ps.stats.maxHP) {
      candidates.push({ type: 'player', idx: -1, pct: ps.hp / ps.stats.maxHP });
    }
    for (let i = 0; i < battleSt.battleAllies.length; i++) {
      const o = battleSt.battleAllies[i];
      if (!o || o.hp <= 0 || !o.maxHP) continue;
      candidates.push({ type: 'ally', idx: i, pct: o.hp / o.maxHP });
    }
    candidates.sort((a, b) => a.pct - b.pct);
    const lowest = candidates[0];
    if (!lowest || lowest.pct >= 0.5) return false;
    targetType = lowest.type; targetIdx = lowest.idx; spellSentinel = 0x34;
  }
  battleSt.allyMagicCasterIdx     = allyIdx;
  battleSt.allyMagicTargetType    = targetType;
  battleSt.allyMagicTargetIdx     = targetIdx;
  battleSt.allyMagicSpellId       = spellSentinel;
  battleSt.allyMagicHealAmount    = 50;
  battleSt.allyMagicEffectApplied = false;
  battleSt.allyMagicItemMode      = true;
  queueBattleMsg(_nameToBytes(ally.name || 'Ally'));
  playSFX(SFX.CURE);
  battleSt.battleState = 'ally-magic-cast';
  battleSt.battleTimer = 0;
  return true;
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

function _playerTurnMagic() {
  battleSt.isDefending = false;
  const pending = inputSt.playerActionPending;
  if (!pending) { processNextTurn(); return; }
  // For v1, ally-target Cure: target is 'player' or an ally index.
  const allyIndex = pending.target === 'player' ? (pending.allyIndex ?? -1) : -1;
  startSpellCast(pending.spellId, { allyIndex });
  // MP changed; persist immediately so a crash doesn't refund the cost.
  saveSlotsToDB();
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
