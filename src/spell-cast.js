// Spell-cast engine — player-cast magic flow.
// Modelled on battle-items.js (Southwind throw/hit). For v1 we only handle
// White Mage Cure: ally-target heal using the NES magic damage formula
// (atk = floor(INT/2) + power, +rand(0..atk/2)) applied as healing.

import { battleSt } from './battle-state.js';
import { ps } from './player-stats.js';
import { inputSt } from './input-handler.js';
import { SFX, playSFX } from './music.js';
import { setPlayerHealNum, getAllyDamageNums, tickHealNums, clearHealNums } from './damage-numbers.js';
import { SPELLS, getSpellMPCost } from './data/spells.js';
import { STATUS, removeStatus } from './status-effects.js';

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
let _targets = [];      // ['player'] or [allyIndex] for ally spells
let _hitIdx = 0;
let _effectApplied = false;
let _baseAmount = 0;    // pre-rolled heal/damage amount

export function getSpellTargets() { return _targets; }
export function getSpellHitIdx() { return _hitIdx; }
export function getCurrentSpellId() { return _spellId; }
export function resetSpellCastVars() {
  _spellId = 0; _targets = []; _hitIdx = 0; _effectApplied = false; _baseAmount = 0;
}

// NES FF3 magic formula (31/B1B4): atk = floor(stat/2) + power, +rand(0..atk/2).
// White magic (recovery / status) uses caster MND; black magic (damage) uses INT.
function _rollMagicAmount(power, useMnd) {
  const stat = ps.stats ? (useMnd ? (ps.stats.mnd || 5) : (ps.stats.int || 5)) : 5;
  const atk = Math.floor(stat / 2) + power;
  return atk + Math.floor(Math.random() * (Math.floor(atk / 2) + 1));
}

// targetSpec: { allyIndex: -1 } for player, { allyIndex: N } for ally N.
// (For v1, ally spells only — Cure on player or ally.)
export function startSpellCast(spellId, targetSpec) {
  const spell = SPELLS.get(spellId);
  if (!spell) { _processNextTurn(); return; }
  _spellId = spellId;
  _hitIdx = 0;
  _effectApplied = false;
  const allyIndex = (targetSpec && targetSpec.allyIndex != null) ? targetSpec.allyIndex : -1;
  _targets = [allyIndex < 0 ? 'player' : allyIndex];
  const isWhite = spell.element === 'recovery' || spell.target === 'cure_status' || spell.target === 'revive';
  _baseAmount = _rollMagicAmount(spell.power, isWhite);
  // MP deduction (cost may be 0 for unmapped spells in v1)
  const cost = getSpellMPCost(spellId);
  ps.mp = Math.max(0, ps.mp - cost);
  battleSt.battleState = 'magic-cast';
  battleSt.battleTimer = 0;
}

function _applySpellEffect(target) {
  const spell = SPELLS.get(_spellId);
  if (!spell) return;
  const isCureStatus = spell.target === 'cure_status';
  const isHeal = spell.element === 'recovery';
  if (isCureStatus) {
    const flag = SPELL_CURE_FLAG[spell.type];
    if (target === 'player') {
      if (flag && ps.status) removeStatus(ps.status, flag);
      setPlayerHealNum({ value: 0, timer: 0 });
    } else {
      const ally = battleSt.battleAllies[target];
      if (!ally) return;
      if (flag && ally.status) removeStatus(ally.status, flag);
      getAllyDamageNums()[target] = { value: 0, timer: 0, heal: true };
    }
    playSFX(SFX.CURE);
    return;
  }
  if (target === 'player') {
    const heal = Math.min(_baseAmount, ps.stats.maxHP - ps.hp);
    ps.hp += heal;
    setPlayerHealNum({ value: heal, timer: 0 });
  } else {
    const ally = battleSt.battleAllies[target];
    if (!ally) return;
    const maxHP = ally.maxHP || ally.hp;
    const heal = Math.min(_baseAmount, maxHP - ally.hp);
    ally.hp += heal;
    getAllyDamageNums()[target] = { value: heal, timer: 0, heal: true };
  }
  playSFX(isHeal ? SFX.CURE : SFX.SW_HIT);
}

// Drives 'magic-cast' (windup) and 'magic-hit' (anim+effect) states.
export function updateSpellCast(dt) {
  if (battleSt.battleState === 'magic-cast') {
    if (battleSt.battleTimer >= 250) {
      if (_targets.length === 0) { _processNextTurn(); return true; }
      _hitIdx = 0; _effectApplied = false;
      battleSt.battleState = 'magic-hit'; battleSt.battleTimer = 0;
    }
    return true;
  }
  if (battleSt.battleState !== 'magic-hit') return false;
  tickHealNums(dt);
  if (!_effectApplied && battleSt.battleTimer >= 400) {
    _applySpellEffect(_targets[_hitIdx]);
    _effectApplied = true;
  }
  if (battleSt.battleTimer >= 1100) {
    _hitIdx++;
    _effectApplied = false;
    if (_hitIdx < _targets.length) {
      battleSt.battleTimer = 0;
    } else {
      clearHealNums();
      _processNextTurn();
    }
  }
  return true;
}
