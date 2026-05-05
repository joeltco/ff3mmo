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
import { CURE_PHASE_MS, CURE_T_HEAL, CURE_TOTAL_MS } from './cure-anim.js';

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
  // Cast SFX — FF3J disasm at 33/B0D8 (black) and 33/B0FF (white) writes $A1 to
  // $7F49 immediately at the pre-magic-animation start, before any spell-specific
  // SFX. Fires for every player-cast spell regardless of school.
  playSFX(SFX.MAGIC_CAST);
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

// Returns true if the captured cure anim (magic circle build-up + cast pose +
// heal sparkle) applies — recovery spells only. Status cures and damage spells
// keep the legacy short timing until their own captures land.
function _isCureAnimSpell() {
  const spell = SPELLS.get(_spellId);
  return !!(spell && spell.element === 'recovery');
}

// Drives 'magic-cast' (windup) and 'magic-hit' (anim+effect) states.
// For recovery spells, timing matches the FF3 NES OAM capture (~1667ms total).
export function updateSpellCast(dt) {
  const useCureAnim = _isCureAnimSpell();
  const castDur     = useCureAnim ? CURE_PHASE_MS.buildup : 250;
  // CURE_T_HEAL is measured from t=0 of the *whole* anim; magic-hit starts at
  // CURE_T_LUNGE (= buildup end), so heal-effect time within magic-hit is the
  // delta from CURE_T_LUNGE.
  const hitEffectMs = useCureAnim ? (CURE_T_HEAL - CURE_PHASE_MS.buildup) : 400;
  const hitTotalMs  = useCureAnim ? (CURE_TOTAL_MS - CURE_PHASE_MS.buildup) : 1100;

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
      _processNextTurn();
    }
  }
  return true;
}

// Renderer hook: returns ms elapsed since cure-anim t=0, or -1 if not in a
// recovery-spell cast/hit state. Lets battle-drawing pick magic-circle frames
// without re-reading battleState semantics.
export function getCureAnimElapsedMs() {
  if (!_isCureAnimSpell()) return -1;
  if (battleSt.battleState === 'magic-cast') return battleSt.battleTimer;
  if (battleSt.battleState === 'magic-hit') return CURE_PHASE_MS.buildup + battleSt.battleTimer;
  return -1;
}
