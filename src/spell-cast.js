// Spell-cast engine — player-cast magic flow.
// Handles ally-target heal/cure (Cure, Poisona) and enemy-target damage paths.
// Pipeline: input → startSpellCast → 'magic-cast' (buildup) → 'magic-hit' (apply
// effect + anim) → next turn. Spells with un-captured visuals fall back to the
// legacy 1100 ms timing; captured spells (Cure, Poisona, Sight, Fire) use the
// CAST_PHASE_MS model from cast-anim.js (~1667 ms).

import { battleSt, getEnemyHP, setEnemyHP, BATTLE_SHAKE_MS } from './battle-state.js';
import { ps } from './player-stats.js';
import { inputSt } from './input-handler.js';
import { SFX, playSFX } from './music.js';
import { setPlayerHealNum, setPlayerDamageNum, getAllyDamageNums, setEnemyDmgNum, setEnemyHealNum, setSwDmgNum,
         tickHealNums, clearHealNums } from './damage-numbers.js';
import { SPELLS, getSpellMPCost, isMultiTargetSpell } from './data/spells.js';
import { STATUS, removeStatus } from './status-effects.js';
import { CAST_PHASE_MS, CAST_T_HEAL, CAST_TOTAL_MS, CAST_T_THROW_RETURN } from './cast-anim.js';
import { queueBattleMsg, isBattleMsgBusy } from './battle-msg.js';
import { _nameToBytes } from './text-utils.js';
import { elemMultiplier } from './battle-math.js';
import { pvpSt } from './pvp.js';

// Map spell.type → STATUS flag for cure_status spells (Poisona, Bndna, etc.)
const SPELL_CURE_FLAG = {
  poison:    STATUS.POISON,
  blind:     STATUS.BLIND,
  silence:   STATUS.SILENCE,
  mini:      STATUS.MINI,
  toad:      STATUS.TOAD,
  petrify:   STATUS.PETRIFY,
  paralysis: STATUS.PARALYSIS,
};

let _processNextTurn = () => {};
export function initSpellCast({ processNextTurn }) { _processNextTurn = processNextTurn; }

// ── Module-local state, reset per cast ──────────────────────────────────────
let _spellId = 0;
let _targets = [];      // [{type: 'player'|'ally'|'enemy', index?}]
let _hitIdx = 0;
let _effectApplied = false;
// Multi-target divides one rolled amount across all targets (Southwind pattern).
// -1 = single-target, per-target re-roll (legacy behavior). >=0 = pre-rolled
// pool divided by targets.length at apply time.
let _baseAmount = -1;

export function getSpellTargets() { return _targets; }
export function getSpellHitIdx() { return _hitIdx; }
export function getCurrentSpellId() { return _spellId; }
export function resetSpellCastVars() {
  _spellId = 0; _targets = []; _hitIdx = 0; _effectApplied = false; _baseAmount = -1;
}

// NES FF3 magic formula (31/B1B4): atk = floor(stat/2) + power, +rand(0..atk/2).
// White magic (recovery / status) uses caster MND; black magic (damage) uses INT.
function _rollMagicAmount(power, useMnd) {
  const stat = ps.stats ? (useMnd ? (ps.stats.mnd || 5) : (ps.stats.int || 5)) : 5;
  const atk = Math.floor(stat / 2) + power;
  return atk + Math.floor(Math.random() * (Math.floor(atk / 2) + 1));
}

// NES FF3 marks undead as "weak to holy AND resists holy" — the contradictory
// pair is the data signature. Used so recovery spells (Cure family) damage
// undead instead of healing them.
function _isUndead(mon) {
  if (!mon) return false;
  const w = Array.isArray(mon.weakness) ? mon.weakness : (mon.weakness ? [mon.weakness] : []);
  const r = Array.isArray(mon.resist) ? mon.resist : (mon.resist ? [mon.resist] : []);
  return w.includes('holy') && r.includes('holy');
}

// Build the encounter/PVP "right column" predicate for a given side.
function _isEnemyRightCol(idx, count) {
  if (pvpSt.isPVPBattle) return idx === 0 || idx === 2;
  return count === 1 || (count === 2 && idx === 1) || (count >= 3 && (idx === 1 || idx === 3));
}

// targetSpec accepts:
//   { allyIndex: -1 }                       → player self
//   { allyIndex: N }                        → roster ally N
//   { enemyIndex: N }                       → encounter monster / PVP cell / boss
//   { allyIndex: -1, targetMode: 'all' }    → all living party (player + roster)
//   { enemyIndex: 0, targetMode: 'all' }    → all living enemies
//   { enemyIndex: N, targetMode: 'col-X' }  → encounter/PVP enemy column
export function startSpellCast(spellId, targetSpec) {
  const spell = SPELLS.get(spellId);
  if (!spell) { _processNextTurn(); return; }
  _spellId = spellId;
  _hitIdx = 0;
  _effectApplied = false;
  _baseAmount = -1;

  const mode = (targetSpec && targetSpec.targetMode) || 'single';
  const onAllies = !!targetSpec && (targetSpec.enemyIndex == null);

  if (mode !== 'single' && onAllies) {
    // All-allies (Cure family heal divided across living party).
    _targets = [];
    if (ps.hp > 0) _targets.push({ type: 'player' });
    (battleSt.battleAllies || []).forEach((a, i) => {
      if (a && a.hp > 0) _targets.push({ type: 'ally', index: i });
    });
  } else if (mode !== 'single' && !onAllies) {
    // All / column on enemy side. Boss path stays single (no group).
    _targets = [];
    if (battleSt.isRandomEncounter && battleSt.encounterMonsters) {
      const mons = battleSt.encounterMonsters;
      mons.forEach((m, i) => {
        if (!m || m.hp <= 0) return;
        const right = _isEnemyRightCol(i, mons.length);
        if (mode === 'all'
            || (mode === 'col-right' && right)
            || (mode === 'col-left'  && !right && mons.length >= 2)) {
          _targets.push({ type: 'enemy', index: i });
        }
      });
    } else if (pvpSt.isPVPBattle) {
      // PVP grid: idx 0 = opponent (right col), 1+ = pvpEnemyAllies (left col).
      const oppAlive = pvpSt.pvpOpponentStats && pvpSt.pvpOpponentStats.hp > 0;
      if ((mode === 'all' || mode === 'col-right') && oppAlive) {
        _targets.push({ type: 'enemy', index: 0 });
      }
      if (mode === 'all' || mode === 'col-left') {
        (pvpSt.pvpEnemyAllies || []).forEach((a, i) => {
          if (a && a.hp > 0) _targets.push({ type: 'enemy', index: i + 1 });
        });
      }
    } else {
      _targets = [{ type: 'enemy', index: 0 }];
    }
  } else if (targetSpec && targetSpec.enemyIndex != null && targetSpec.enemyIndex >= 0) {
    _targets = [{ type: 'enemy', index: targetSpec.enemyIndex }];
  } else if (targetSpec && targetSpec.allyIndex != null && targetSpec.allyIndex >= 0) {
    _targets = [{ type: 'ally', index: targetSpec.allyIndex }];
  } else {
    _targets = [{ type: 'player' }];
  }

  // Multi-target → roll once at cast time, divide at apply time. Single-target
  // keeps per-target re-roll (legacy). Skips status/revive cures (no amount).
  if (_targets.length > 1 && spell.power > 0) {
    const useMnd = spell.element === 'recovery'
      || spell.target === 'cure_status'
      || spell.target === 'revive';
    _baseAmount = _rollMagicAmount(spell.power, useMnd);
  }

  ps.mp -= getSpellMPCost(spellId);
  battleSt.battleState = 'magic-cast';
  battleSt.battleTimer = 0;
  // Cast SFX — FF3J disasm at 33/B0D8 (black) and 33/B0FF (white) writes $A1 to
  // $7F49 immediately at the pre-magic-animation start, before any spell-specific
  // SFX. Fires for every player-cast spell regardless of school.
  playSFX(SFX.MAGIC_CAST);
}

function _getEnemyAt(idx) {
  if (battleSt.isRandomEncounter && battleSt.encounterMonsters) {
    return battleSt.encounterMonsters[idx];
  }
  if (pvpSt.isPVPBattle) {
    return idx === 0 ? pvpSt.pvpOpponentStats : pvpSt.pvpEnemyAllies[idx - 1];
  }
  return null; // boss path uses getEnemyHP/setEnemyHP, no monster object
}

function _setEnemyDmg(idx, value, miss) {
  if (battleSt.isRandomEncounter && battleSt.encounterMonsters) {
    setSwDmgNum(idx, miss ? 0 : value, { miss: !!miss });
    return;
  }
  if (pvpSt.isPVPBattle) {
    setSwDmgNum(idx, miss ? 0 : value, { miss: !!miss });
    return;
  }
  setEnemyDmgNum(miss ? { miss: true, timer: 0 } : { value, timer: 0 });
}

function _applyEnemyEffect(idx, spell) {
  const isEncounter = battleSt.isRandomEncounter && battleSt.encounterMonsters;
  const isPVP = pvpSt.isPVPBattle;
  const isBoss = !isEncounter && !isPVP;
  const mon = isBoss ? null : _getEnemyAt(idx);

  // Sight is a no-op against enemies — the spell's effect is the visual
  // (cast anim + projectile flight) plus the "Ineffective" battle message.
  // Impact SFX is `SFX.SIGHT` (NSF track $81 = SFX $40 + $41) per the REC
  // OAM capture's idle→$40 trigger at frame 39 of the f5887 dump.
  if (spell.target === 'sight') {
    queueBattleMsg(_nameToBytes('Ineffective'));
    playSFX(SFX.SIGHT);
    return;
  }

  // Recovery spell → undead damages, non-undead heals (NES default; player
  // chose to spend MP on a non-undead enemy, so they get healed).
  const isRecovery = spell.element === 'recovery';
  const useMnd = isRecovery || spell.target === 'cure_status' || spell.target === 'revive';

  // Hit roll (offensive non-recovery only). Recovery on undead always hits at NES hit:100.
  if (!isRecovery && spell.hit > 0 && spell.hit < 100) {
    if (Math.random() * 100 >= spell.hit) {
      _setEnemyDmg(idx, 0, true);
      return;
    }
  }

  const amount = _baseAmount >= 0
    ? Math.max(1, Math.floor(_baseAmount / _targets.length))
    : _rollMagicAmount(spell.power, useMnd);

  if (isRecovery) {
    if (isBoss) {
      // Boss path: no monster object so we can't detect undead. Default to heal
      // (matches NES non-undead behavior).
      const curHP = getEnemyHP();
      const heal = Math.min(amount, 9999 - curHP);
      setEnemyHP(curHP + heal);
      setEnemyHealNum({ value: heal, timer: 0, index: idx });
      playSFX(SFX.CURE);
      return;
    }
    if (!mon || mon.hp <= 0) return;
    if (_isUndead(mon)) {
      const dmg = Math.max(1, amount);
      mon.hp = Math.max(0, mon.hp - dmg);
      _setEnemyDmg(idx, dmg, false);
      battleSt.battleShakeTimer = BATTLE_SHAKE_MS;
      playSFX(SFX.SW_HIT);
    } else {
      const heal = Math.min(amount, (mon.maxHP || mon.hp) - mon.hp);
      mon.hp += heal;
      setEnemyHealNum({ value: heal, timer: 0, index: idx });
      playSFX(SFX.CURE);
    }
    return;
  }

  // Non-recovery (damage) spell on enemy.
  if (isBoss) {
    const dmg = Math.max(1, amount);
    setEnemyHP(Math.max(0, getEnemyHP() - dmg));
    _setEnemyDmg(idx, dmg, false);
    battleSt.battleShakeTimer = BATTLE_SHAKE_MS;
    playSFX(spell.element === 'fire' ? SFX.FIRE_BOOM : SFX.SW_HIT);
    return;
  }
  if (!mon || mon.hp <= 0) return;
  const mult = elemMultiplier(spell.element, mon.weakness, mon.resist);
  const dmg = Math.max(1, Math.floor(amount * mult));
  mon.hp = Math.max(0, mon.hp - dmg);
  _setEnemyDmg(idx, dmg, false);
  battleSt.battleShakeTimer = BATTLE_SHAKE_MS;
  playSFX(SFX.SW_HIT);
}

function _applySpellEffect(target) {
  const spell = SPELLS.get(_spellId);
  if (!spell) return;

  if (target.type === 'enemy') {
    _applyEnemyEffect(target.index, spell);
    return;
  }

  // Sight on a friendly target — picker now defaults to enemy, but the user
  // can still navigate Right back to the player side. Battle message says
  // "Ineffective"; SFX matches the enemy path.
  if (spell.target === 'sight') {
    queueBattleMsg(_nameToBytes('Ineffective'));
    playSFX(SFX.SIGHT);
    return;
  }

  // Damage spells (Fire, future BM family) on a friendly target — picker
  // defaults to enemy, but if the user navigates to a friendly cell the spell
  // would otherwise fall through to the heal path below and silently restore
  // HP. Surface "Ineffective" instead and don't apply any effect.
  if (spell.type === 'damage') {
    queueBattleMsg(_nameToBytes('Ineffective'));
    playSFX(SFX.ERROR);
    return;
  }

  // Friendly target paths (player / ally)
  const isCureStatus = spell.target === 'cure_status';
  const isHeal = spell.element === 'recovery';
  const useMnd = isHeal || isCureStatus || spell.target === 'revive';
  const amount = _baseAmount >= 0
    ? Math.max(1, Math.floor(_baseAmount / _targets.length))
    : _rollMagicAmount(spell.power, useMnd);

  if (isCureStatus) {
    const flag = SPELL_CURE_FLAG[spell.type];
    if (target.type === 'player') {
      if (flag && ps.status) removeStatus(ps.status, flag);
      setPlayerHealNum({ value: 0, timer: 0 });
    } else {
      const ally = battleSt.battleAllies[target.index];
      if (!ally) return;
      if (flag && ally.status) removeStatus(ally.status, flag);
      getAllyDamageNums()[target.index] = { value: 0, timer: 0, heal: true };
    }
    playSFX(SFX.CURE);
    return;
  }
  if (target.type === 'player') {
    const heal = Math.min(amount, ps.stats.maxHP - ps.hp);
    ps.hp += heal;
    setPlayerHealNum({ value: heal, timer: 0 });
  } else {
    const ally = battleSt.battleAllies[target.index];
    if (!ally) return;
    const maxHP = ally.maxHP || ally.hp;
    const heal = Math.min(amount, maxHP - ally.hp);
    ally.hp += heal;
    getAllyDamageNums()[target.index] = { value: heal, timer: 0, heal: true };
  }
  playSFX(isHeal ? SFX.CURE : SFX.SW_HIT);
}

// Returns true if the captured white-magic anim (magic circle build-up + cast
// pose + heal sparkle) applies. The FF3 ROM shares this animation across the
// whole white-magic school — REC OAM of Poisona showed tiles $4A-$57 byte-
// identical to Cure's, same SP3 palette `[0x0F, 0x15, 0x27, 0x30]`, same per-
// frame progression. So recovery (Cure family), status-cure (Poisona, Bndna,
// etc.), revive (Raise), and captured BM damage spells (Fire) all use it.
// Spells with un-captured visuals fall back to the legacy 250/400/1100 timing.
function _isCastAnimSpell() {
  const spell = SPELLS.get(_spellId);
  if (!spell) return false;
  return spell.element === 'recovery'
      || spell.target === 'cure_status'
      || spell.target === 'revive'
      || spell.target === 'sight'
      || spell.element === 'fire';
}

export function isSightSpell(spellId) {
  const s = SPELLS.get(spellId);
  return !!(s && s.target === 'sight');
}

// Drives 'magic-cast' (windup) and 'magic-hit' (anim+effect) states.
// For recovery spells, timing matches the FF3 NES OAM capture (~1667ms total).
export function updateSpellCast(dt) {
  const useCastAnim = _isCastAnimSpell();
  const spell = SPELLS.get(_spellId);
  const isThrown = !!(spell && (spell.target === 'sight' || spell.element === 'fire'));
  const castDur  = useCastAnim ? CAST_PHASE_MS.buildup : 250;
  // hitEffectMs = when within magic-hit the spell effect applies (and damage /
  // heal number appears). hitTotalMs = total duration of magic-hit state.
  // Both measured from magic-hit start (= elapsedMs CAST_PHASE_MS.buildup).
  //
  // - Heal-style (Cure, Poisona): effect at CAST_T_HEAL boundary (sparkle
  //   start), total = CAST_TOTAL_MS - buildup (matches OAM Cure timing).
  // - Throw-style (Fire): effect at impact END so the damage number doesn't
  //   pop mid-burst — extend total by 500 ms so the number's bounce
  //   actually plays before the state transitions to monster-death.
  const hitEffectMs = useCastAnim
    ? (isThrown ? (CAST_T_THROW_RETURN - CAST_PHASE_MS.buildup)
                : (CAST_T_HEAL - CAST_PHASE_MS.buildup))
    : 400;
  const hitTotalMs  = useCastAnim
    ? (isThrown ? (CAST_T_THROW_RETURN - CAST_PHASE_MS.buildup + 500)
                : (CAST_TOTAL_MS - CAST_PHASE_MS.buildup))
    : 1100;

  if (battleSt.battleState === 'magic-cast') {
    if (battleSt.battleTimer >= castDur) {
      if (_targets.length === 0) { _processNextTurn(); return true; }
      _hitIdx = 0; _effectApplied = false;
      battleSt.battleState = 'magic-hit'; battleSt.battleTimer = 0;
    }
    return true;
  }
  if (battleSt.battleState !== 'magic-hit') return false;
  tickHealNums(dt);
  if (!_effectApplied && battleSt.battleTimer >= hitEffectMs) {
    _applySpellEffect(_targets[_hitIdx]);
    _effectApplied = true;
  }
  if (battleSt.battleTimer >= hitTotalMs) {
    _hitIdx++;
    _effectApplied = false;
    if (_hitIdx < _targets.length) {
      battleSt.battleTimer = 0;
    } else {
      clearHealNums();
      // If the spell killed any enemies, route through the same monster-death
      // / boss-dissolve / pvp-dissolve transitions the melee path uses, so the
      // victory flow fires when the last monster is killed by a spell.
      // (Without this, a spell-killing-last-enemy would just call
      // _processNextTurn — which loops over a dead enemy roster forever:
      // soft-lock.)
      const killedEnemyIndices = [];
      if (battleSt.isRandomEncounter && battleSt.encounterMonsters) {
        for (const t of _targets) {
          if (t.type === 'enemy' && battleSt.encounterMonsters[t.index]?.hp <= 0) {
            killedEnemyIndices.push(t.index);
          }
        }
      }
      if (killedEnemyIndices.length > 0) {
        battleSt.dyingMonsterIndices = new Map(killedEnemyIndices.map(i => [i, 0]));
        battleSt.battleState = 'monster-death';
        battleSt.battleTimer = 0;
        playSFX(SFX.MONSTER_DEATH);
      } else if (!battleSt.isRandomEncounter && getEnemyHP() <= 0) {
        if (pvpSt.isPVPBattle) {
          battleSt.battleState = 'pvp-dissolve';
          battleSt.battleTimer = 0;
          playSFX(SFX.MONSTER_DEATH);
        } else {
          battleSt.battleState = 'boss-dissolve';
          battleSt.battleTimer = 0;
          playSFX(SFX.BOSS_DEATH);
        }
      } else if (isBattleMsgBusy()) {
        // Battle message still on screen (Sight's "Ineffective", future
        // spell-text dialog, etc.) — defer turn advance through msg-wait gate.
        battleSt.battleState = 'msg-wait';
        battleSt.battleTimer = 0;
      } else {
        _processNextTurn();
      }
    }
  }
  return true;
}

// Renderer hook: returns ms elapsed since cast t=0, or -1 if not in a
// captured-anim cast/hit state. Lets battle-drawing pick cast/projectile/spell
// animation frames without re-reading battleState semantics.
export function getCastAnimElapsedMs() {
  if (!_isCastAnimSpell()) return -1;
  if (battleSt.battleState === 'magic-cast') return battleSt.battleTimer;
  if (battleSt.battleState === 'magic-hit') return CAST_PHASE_MS.buildup + battleSt.battleTimer;
  return -1;
}
