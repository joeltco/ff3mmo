// Battle ally update logic — extracted from game.js

import { battleSt, getEnemyHP, setEnemyHP, BATTLE_SHAKE_MS, BATTLE_DMG_SHOW_MS } from './battle-state.js';
import { playSlashSFX } from './battle-sfx.js';
import { resetSlashScatterCache, shouldDrawSlash, SWING_HOLD_MS } from './slash-effects.js';
import { isWeapon } from './data/items.js';
import { SFX, playSFX } from './music.js';
import { _nameToBytes } from './text-utils.js';
import { queueBattleMsg } from './battle-msg.js';
import { pvpSt } from './pvp.js';
import { inputSt } from './input-handler.js';
import { getEnemyDmgNum, setEnemyDmgNum, setPlayerHealNum, getAllyDamageNums, tickHealNums, clearHealNums } from './damage-numbers.js';
import { ROSTER_FADE_STEPS } from './data/players.js';
import { IDLE_FRAME_MS } from './combatant-pose.js';
import { ps } from './player-stats.js';
import { removeStatus, STATUS } from './status-effects.js';

// Injected at boot — avoids circular import on main.js
let _buildTurnOrder = () => [];
let _processNextTurn = () => {};
let _isTeamWiped = () => false;
export function initBattleAlly({ buildTurnOrder, processNextTurn, isTeamWiped }) {
  _buildTurnOrder = buildTurnOrder;
  _processNextTurn = processNextTurn;
  _isTeamWiped = isTeamWiped;
}

// ── Combo finalization ───────────────────────────────────────────────────────
function _finalizeAllyCombo() {
  let totalDmg = 0, anyCrit = false, allMiss = true, hitsLanded = 0;
  for (const h of battleSt.allyHitResults) {
    if (!h.miss) { totalDmg += h.damage; allMiss = false; hitsLanded++; if (h.crit) anyCrit = true; }
  }
  setEnemyDmgNum(allMiss ? { miss: true, timer: 0 } : { value: totalDmg, crit: anyCrit, timer: 0 });
  inputSt.targetIndex = battleSt.allyTargetIndex;
}

// ── After damage-show: check for death/dissolve or advance turn ──────────────
function _updateAllyDamageShow() {
  if (battleSt.isRandomEncounter && battleSt.encounterMonsters && battleSt.allyTargetIndex >= 0 && battleSt.encounterMonsters[battleSt.allyTargetIndex].hp <= 0) {
    battleSt.dyingMonsterIndices = new Map([[battleSt.allyTargetIndex, 0]]);
    battleSt.battleState = 'monster-death'; battleSt.battleTimer = 0; playSFX(SFX.MONSTER_DEATH);
  } else if (!battleSt.isRandomEncounter && getEnemyHP() <= 0) {
    if (pvpSt.isPVPBattle) {
      battleSt.battleState = 'pvp-dissolve'; battleSt.battleTimer = 0; playSFX(SFX.MONSTER_DEATH);
    } else { battleSt.battleState = 'boss-dissolve'; battleSt.battleTimer = 0; playSFX(SFX.BOSS_DEATH); }
  } else {
    _processNextTurn();
  }
}

// ── Ally join fade-in ────────────────────────────────────────────────────────
function _updateAllyJoin() {
  if (battleSt.battleState === 'ally-fade-in') {
    const newAlly = battleSt.battleAllies[battleSt.battleAllies.length - 1];
    if (newAlly && battleSt.battleTimer >= 100) {
      newAlly.fadeStep = Math.max(0, newAlly.fadeStep - 1);
      battleSt.battleTimer = 0;
      if (newAlly.fadeStep <= 0) { battleSt.turnQueue = _buildTurnOrder(); _processNextTurn(); }
    }
    return true;
  }
  return false;
}

// ── Ally attack combo (multi-hit with summed damage) ─────────────────────────
const ALLY_BACK_MS = 40;
const ALLY_FWD_MS = 40;
// Slash phase dwell comes from SWING_HOLD_MS in slash-effects.js — one source
// of truth shared across player / ally / PVP opponent paths.
const ALLY_COMBO_PAUSE_MS = 30;

function _updateAllyAttack() {
  if (battleSt.battleState === 'ally-attack-back') {
    const allyNow = battleSt.battleAllies[battleSt.currentAllyAttacker];
    if (!allyNow) return false;
    const rW = isWeapon(allyNow.weaponId);
    const lW = isWeapon(allyNow.weaponL);
    const allyUnarmed = !rW && !lW;
    const dualOrUnarmed = (rW && lW) || allyUnarmed;
    // Pre-compute the upcoming hand so we can detect a hand change before committing to it.
    const willBeLeft = dualOrUnarmed ? (battleSt.allyHitIdx % 2 === 1) : !rW;
    const handChange = battleSt.allyHitIdx > 0 && battleSt.allyHitIsLeft !== willBeLeft;
    const delay = handChange ? IDLE_FRAME_MS
                : (allyUnarmed ? 0 : (battleSt.allyHitIdx === 0 ? ALLY_BACK_MS : ALLY_COMBO_PAUSE_MS));
    if (battleSt.battleTimer >= delay) {
      if (battleSt.allyHitIdx === 0) {
        queueBattleMsg(_nameToBytes(allyNow.name || 'Ally'));
      }
      battleSt.allyHitIsLeft = willBeLeft;
      battleSt.battleState = 'ally-attack-fwd';
      battleSt.battleTimer = 0;
    }
    return true;
  }
  if (battleSt.battleState === 'ally-attack-fwd') {
    if (battleSt.battleTimer >= ALLY_FWD_MS) {
      const ally = battleSt.battleAllies[battleSt.currentAllyAttacker];
      const isLeft = battleSt.allyHitIsLeft;
      const activeWpn = isLeft ? ally.weaponL : (ally && ally.weaponId);
      const hit = battleSt.allyHitResults[battleSt.allyHitIdx];
      battleSt.allyHitResult = hit;
      playSlashSFX(activeWpn, hit && hit.crit);
      // Re-roll RNG scatter for impact weapons on every new hit so the cached
      // value from the previous hit (or another slash path) doesn't bleed in.
      resetSlashScatterCache();
      battleSt.battleState = 'ally-slash';
      battleSt.battleTimer = 0;
    }
    return true;
  }
  if (battleSt.battleState === 'ally-slash') {
    const hit = battleSt.allyHitResults[battleSt.allyHitIdx];
    const drawSlash = shouldDrawSlash(hit);
    if (battleSt.battleTimer >= SWING_HOLD_MS) {
      if (drawSlash) {
        // Defend halving for PVP opponent
        if (pvpSt.isPVPBattle && pvpSt.pvpOpponentIsDefending && battleSt.allyTargetIndex < 0)
          hit.damage = Math.max(1, Math.floor(hit.damage / 2));
        // Apply damage per hit
        if (battleSt.allyTargetIndex >= 0 && battleSt.encounterMonsters) {
          battleSt.encounterMonsters[battleSt.allyTargetIndex].hp = Math.max(0, battleSt.encounterMonsters[battleSt.allyTargetIndex].hp - hit.damage);
        } else if (battleSt.allyTargetIndex < 0) {
          setEnemyHP(Math.max(0, getEnemyHP() - hit.damage));
          if (pvpSt.isPVPBattle) pvpSt.pvpOpponentShakeTimer = BATTLE_SHAKE_MS;
        }
        if (hit.crit) battleSt.critFlashTimer = 0;
      }
      // Advance combo
      battleSt.allyHitIdx = battleSt.allyHitIdx + 1;
      if (battleSt.allyHitIdx < battleSt.allyHitResults.length) {
        const nextAlly = battleSt.battleAllies[battleSt.currentAllyAttacker];
        const nrW = nextAlly && isWeapon(nextAlly.weaponId);
        const nlW = nextAlly && isWeapon(nextAlly.weaponL);
        battleSt.allyHitIsLeft = (nrW && nlW) || (!nrW && !nlW)
          ? (battleSt.allyHitIdx % 2 === 1)
          : !nrW;
        battleSt.battleState = 'ally-attack-back';
        battleSt.battleTimer = 0;
      } else {
        _finalizeAllyCombo();
        battleSt.allyHitIsLeft = false;
        battleSt.battleState = 'ally-damage-show';
        battleSt.battleTimer = 0;
      }
    }
    return true;
  }
  return false;
}

// ── Ally taking enemy hit ────────────────────────────────────────────────────
function _updateAllyEnemyHit() {
  if (battleSt.battleState === 'ally-hit') {
    if (battleSt.battleTimer >= BATTLE_SHAKE_MS) { battleSt.battleState = 'ally-damage-show-enemy'; battleSt.battleTimer = 0; }
    return true;
  }
  if (battleSt.battleState === 'ally-damage-show-enemy') {
    if (battleSt.battleTimer >= BATTLE_DMG_SHOW_MS) {
      const ally = battleSt.battleAllies[battleSt.enemyTargetAllyIdx];
      if (ally && ally.hp <= 0) {
        // Start death animation — visual only, battle continues
        ally.deathTimer = 0;
        battleSt.turnQueue = battleSt.turnQueue.filter(t => !(t.type === 'ally' && t.index === battleSt.enemyTargetAllyIdx));
        battleSt.enemyTargetAllyIdx = -1;
        if (_isTeamWiped()) {
          battleSt.battleState = 'team-wipe'; battleSt.battleTimer = 0;
        } else {
          _processNextTurn();
        }
      } else { battleSt.enemyTargetAllyIdx = -1; _processNextTurn(); }
    }
    return true;
  }
  return false;
}

// ── Ally magic cast (WM heal AI) ─────────────────────────────────────────────
// Mirrors the player magic-cast → magic-hit pipeline but caster is an ally.
// Timing: 600 ms windup (ally-magic-cast) → 1000 ms hit phase (effect at 400 ms,
// turn ends at 1000 ms). No magic-circle on caster portrait yet — render shows
// caster in victory pose + heal sparkle on target during hit phase.
const ALLY_MAGIC_CAST_MS  = 600;
const ALLY_MAGIC_EFFECT_MS = 400;  // within hit phase
const ALLY_MAGIC_HIT_MS   = 1000;

function _applyAllyMagicEffect() {
  const spellId = battleSt.allyMagicSpellId;
  // 0x36 Sight — no gameplay effect; defensive guard so the Cure fall-through
  // below doesn't accidentally heal the target if some future AI selector or
  // sentinel sets allyMagicSpellId to Sight. Cast anim still plays via the
  // shared white-magic flame, impact SFX matches the player-cast path.
  if (spellId === 0x36) {
    playSFX(SFX.SIGHT);
    return;
  }
  // 0x31 Fire — ally AI doesn't cast offensive magic on enemies today; this
  // guard exists so a stray Fire spellId (sync error, future BM ally) doesn't
  // fall through and accidentally heal the target via the default Cure path.
  // Boom SFX plays; damage application is the player-cast pipeline's job.
  if (spellId === 0x31) {
    playSFX(SFX.FIRE_BOOM);
    return;
  }
  // 0x35 Poisona — strip POISON flag from target, no HP change. Sparkle still
  // shows via the heal-num placeholder ({value:0, heal:true}) on the target.
  if (spellId === 0x35) {
    if (battleSt.allyMagicTargetType === 'player') {
      if (ps.status) removeStatus(ps.status, STATUS.POISON);
      setPlayerHealNum({ value: 0, timer: 0 });
    } else {
      const target = battleSt.battleAllies[battleSt.allyMagicTargetIdx];
      if (!target) return;
      if (target.status) removeStatus(target.status, STATUS.POISON);
      getAllyDamageNums()[battleSt.allyMagicTargetIdx] = { value: 0, timer: 0, heal: true };
    }
    playSFX(SFX.CURE);
    return;
  }
  // 0x34 Cure (default heal path)
  const heal = battleSt.allyMagicHealAmount;
  if (battleSt.allyMagicTargetType === 'player') {
    if (!ps.stats) return;
    const realHeal = Math.min(heal, (ps.stats.maxHP || 0) - ps.hp);
    ps.hp += realHeal;
    setPlayerHealNum({ value: realHeal, timer: 0 });
  } else {
    const target = battleSt.battleAllies[battleSt.allyMagicTargetIdx];
    if (!target) return;
    const maxHP = target.maxHP || target.hp;
    const realHeal = Math.min(heal, maxHP - target.hp);
    target.hp += realHeal;
    getAllyDamageNums()[battleSt.allyMagicTargetIdx] = { value: realHeal, timer: 0, heal: true };
  }
  playSFX(SFX.CURE);
}

function _updateAllyMagicCast(dt) {
  if (battleSt.battleState === 'ally-magic-cast') {
    if (battleSt.battleTimer >= ALLY_MAGIC_CAST_MS) {
      battleSt.battleState = 'ally-magic-hit';
      battleSt.battleTimer = 0;
      battleSt.allyMagicEffectApplied = false;
    }
    return true;
  }
  if (battleSt.battleState === 'ally-magic-hit') {
    tickHealNums(dt);
    if (!battleSt.allyMagicEffectApplied && battleSt.battleTimer >= ALLY_MAGIC_EFFECT_MS) {
      _applyAllyMagicEffect();
      battleSt.allyMagicEffectApplied = true;
    }
    if (battleSt.battleTimer >= ALLY_MAGIC_HIT_MS) {
      clearHealNums();
      battleSt.allyMagicCasterIdx = -1;
      battleSt.allyMagicTargetIdx = -1;
      battleSt.allyMagicSpellId = 0;
      battleSt.allyMagicItemMode = false;
      _processNextTurn();
    }
    return true;
  }
  return false;
}

// ── Ally KO sequence ─────────────────────────────────────────────────────────
function _updateAllyKOSequence() {
  if (battleSt.battleState === 'ally-ko-fade') {
    const koAlly = battleSt.battleAllies[battleSt.enemyTargetAllyIdx];
    if (koAlly && battleSt.battleTimer >= 100) {
      koAlly.fadeStep = Math.min(ROSTER_FADE_STEPS, koAlly.fadeStep + 1);
      battleSt.battleTimer = 0;
      if (koAlly.fadeStep >= ROSTER_FADE_STEPS) {
        battleSt.turnQueue = battleSt.turnQueue.filter(t => !(t.type === 'ally' && t.index === battleSt.enemyTargetAllyIdx));
        battleSt.enemyTargetAllyIdx = -1;
        if (_isTeamWiped()) {
          battleSt.battleState = 'team-wipe'; battleSt.battleTimer = 0;
        } else {
          _processNextTurn();
        }
      }
    }
    return true;
  }
  if (battleSt.battleState === 'ally-ko-msg') return true;
  return false;
}

export function updateBattleAlly(dt) {
  if (_updateAllyJoin()) return true;
  if (_updateAllyAttack()) return true;
  if (_updateAllyMagicCast(dt)) return true;
  if (battleSt.battleState === 'ally-damage-show') { if (battleSt.battleTimer >= 700) _updateAllyDamageShow(); return true; }
  if (_updateAllyEnemyHit()) return true;
  if (_updateAllyKOSequence()) return true;
  return false;
}
