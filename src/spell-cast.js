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
import { STATUS, addStatus, removeStatus, tryInflictStatus, STATUS_NAME_BYTES } from './status-effects.js';
import { CAST_PHASE_MS, CAST_PHASE_MS_THROW, CAST_T_HEAL, CAST_TOTAL_MS, CAST_T_THROW_RETURN, CAST_T_THROW_IMPACT_START } from './cast-anim.js';
import { applyMagicDamage, applyMagicStatus, applyMagicHeal,
         applyMagicCureStatus, applyMagicSight } from './combatant-cast.js';
import { pvpGridLayout } from './pvp-math.js';
import { queueBattleMsg, replaceBattleMsg, isBattleMsgBusy } from './battle-msg.js';
import { BATTLE_INEFFECTIVE, BATTLE_HASTE, BATTLE_PROTECT, BATTLE_REFLECT, BATTLE_SLAIN } from './data/strings.js';
import { _nameToBytes } from './text-utils.js';
import { getSpellNameClean, getItemNameClean } from './text-decoder.js';
import { elemMultiplier } from './battle-math.js';
import { pvpSt } from './pvp.js';
import { applyBuff, BUFF_HASTE, BUFF_PROTECT, BUFF_REFLECT } from './buffs.js';

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
// Fires once per cast — set when the spell SFX has played so the apply path
// doesn't double up. Lets the SFX trigger fire EARLY (at spell-anim start)
// instead of waiting until the damage-number pops at hitEffectMs.
let _sfxPlayed = false;
// True when the cast was triggered by a battle item (SouthWind, etc.) rather
// than a spellcaster job action. Items skip the BM/WM cast pose, MP cost, and
// MAGIC_CAST SFX — they go straight from a 250 ms throw window to magic-hit.
let _isItemUse = false;
// Substate within 'magic-hit' for thrown cross-faction spells. 'projectile'
// runs the parallel fan-out (single battleTimer 0..150). 'impact-walk' runs
// the per-target serial impact bursts (battleTimer resets per target). Single-
// target throws and heal-style casts stay in 'impact-walk' for the whole
// magic-hit duration with the original timing — the walk code only kicks in
// when isThrown && cross-faction targets exist (any count, including 1).
let _magicHitPhase = 'impact-walk';
export function getMagicHitPhase() { return _magicHitPhase; }

function _playSpellSFXOnce(sfx) {
  if (_sfxPlayed) return;
  playSFX(sfx);
  _sfxPlayed = true;
}

// Cross-faction damage spells that take the throw path (cast windup → projectile
// → impact burst). Add new offensive elements here when wiring more BM spells.
// Keeping this in one place per the modularize-cross-cutting-gates rule.
const _THROWN_DAMAGE_ELEMENTS = new Set(['fire', 'ice', 'bolt']);
function _isThrownDamageElement(el) { return _THROWN_DAMAGE_ELEMENTS.has(el); }

// Status-type spells that ALSO take the throw path (cast windup → projectile →
// impact burst, then status apply at impact end). Damage spells use element;
// status spells don't — gate by `spell.type` here. Sleep is the canonical
// example: REC OAM sleep-emu-snap shows the same cast → projectile → impact
// timeline as Fire/Blizzard. Add new entries when wiring more thrown statuses.
const _THROWN_STATUS_TYPES = new Set(['sleep']);
function _isThrownStatusType(t) { return _THROWN_STATUS_TYPES.has(t); }

// Queue the post-encoded status name (e.g., "Asleep" / "Confused") on the
// battle message strip when a status lands. Mirrors the existing
// 'Ineffective' miss path — short single-line messages, no target-name
// prefix yet (revisit when the two-stage FF3-NES message strip lands).
function _queueStatusMsg(flag) {
  const bytes = STATUS_NAME_BYTES[flag];
  if (bytes) replaceBattleMsg(bytes);
}

// SFX index per spell. Captured via the v1.7.111 EMU dumper's pre-consume
// `$Cx` write trace. Add new entries when wiring new spells. Falls back to
// SW_HIT for unmapped spells.
function _spellImpactSFX(spell) {
  if (!spell) return SFX.SW_HIT;
  if (spell.target === 'sight') return SFX.SIGHT;
  if (spell.element === 'fire') return SFX.FIRE_BOOM;       // NSF $82 — REC OAM f1301
  if (spell.element === 'ice')  return SFX.SW_HIT;          // NSF $5D — REC OAM f766 (Blizzard $9C → $5D)
  if (spell.type === 'sleep')   return SFX.SLEEP_PUFF;      // NSF $95 — REC OAM sleep-emu-snap
  return SFX.SW_HIT;
}

export function getSpellTargets() { return _targets; }
export function getSpellHitIdx() { return _hitIdx; }
export function getCurrentSpellId() { return _spellId; }
// True when the active cast was triggered by a battle item, not a job's spell
// action. Render paths use this to skip the throw projectile (items go straight
// to impact) and to align the impact-phase timer to magic-hit start (0 ms).
export function isCurrentCastItemUse() { return _isItemUse; }
export function resetSpellCastVars() {
  _spellId = 0; _targets = []; _hitIdx = 0; _effectApplied = false; _baseAmount = -1;
  _sfxPlayed = false;
  _magicHitPhase = 'impact-walk';
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

// Visual (row, col) position for an enemy by index — used to sort _targets
// into TL→TR→BL→BR walk order so the per-target impact bursts step through
// the grid in reading order. For encounter, mirrors `_encounterGridPos`'s
// layout (4-mon = 2x2, 3-mon = top pair + middle bottom, 2-mon = horizontal
// pair, 1-mon = single). For PVP, defers to `pvpGridLayout`'s gridPos table.
function _enemyVisualPos(idx) {
  if (battleSt.isRandomEncounter && battleSt.encounterMonsters) {
    const cnt = battleSt.encounterMonsters.length;
    if (cnt <= 2) return { row: 0, col: idx };
    if (cnt === 3) return idx < 2 ? { row: 0, col: idx } : { row: 1, col: 0 };
    // 4-mon: 0=TL, 1=TR, 2=BL, 3=BR
    return { row: idx < 2 ? 0 : 1, col: idx % 2 };
  }
  if (pvpSt.isPVPBattle) {
    const total = 1 + (pvpSt.pvpEnemyAllies ? pvpSt.pvpEnemyAllies.length : 0);
    const { gridPos } = pvpGridLayout(total);
    const safe = Math.min(idx, gridPos.length - 1);
    const [gr, gc] = gridPos[safe];
    return { row: gr, col: gc };
  }
  return { row: 0, col: 0 };
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
export function startSpellCast(spellId, targetSpec, opts = {}) {
  const spell = SPELLS.get(spellId);
  if (!spell) { _processNextTurn(); return; }
  _spellId = spellId;
  _hitIdx = 0;
  _effectApplied = false;
  _baseAmount = -1;
  _sfxPlayed = false;
  _isItemUse = !!opts.isItemUse;

  // Strip name: item name on item-use, spell name on spell-cast. Replace
  // (don't queue) so the actor name already on the strip swaps in-place;
  // queue depth stays at 1 per turn.
  if (_isItemUse && opts.itemId != null) {
    replaceBattleMsg(getItemNameClean(opts.itemId));
  } else {
    replaceBattleMsg(getSpellNameClean(spellId));
  }

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

  // Self-buff spells (Haste, Protect, Reflect) always target the caster,
  // regardless of what enemy/ally the user picked. Battle items like
  // BachusWine / TurtleShell / Curtain route through here as item-use; the
  // picker may have selected an enemy but the buff applies to the player.
  if (spell.target === 'haste' || spell.target === 'protect' || spell.target === 'reflect') {
    _targets = [{ type: 'player' }];
  }

  // Multi-target enemy walk order: top→bottom, left→right (visual reading
  // order). The impact-walk phase steps through _targets in this order so
  // the spell-anim plays TL → TR → BL → BR like the legacy SouthWind walk.
  if (_targets.length > 1 && _targets.every(t => t && t.type === 'enemy')) {
    _targets.sort((a, b) => {
      const pa = _enemyVisualPos(a.index), pb = _enemyVisualPos(b.index);
      return pa.row - pb.row || pa.col - pb.col;
    });
  }

  // Multi-target → roll once at cast time, divide at apply time. Single-target
  // keeps per-target re-roll (legacy). Skips status/revive cures (no amount).
  if (_targets.length > 1 && spell.power > 0) {
    const useMnd = spell.element === 'recovery'
      || spell.target === 'cure_status'
      || spell.target === 'revive';
    _baseAmount = _rollMagicAmount(spell.power, useMnd);
  }

  // Item-use skips MP deduction (items have no MP cost) and the MAGIC_CAST
  // pre-animation SFX (items aren't a spell-cast — they're a throw).
  if (!_isItemUse) {
    ps.mp -= getSpellMPCost(spellId);
  }
  battleSt.battleState = 'magic-cast';
  battleSt.battleTimer = 0;
  // Cast SFX — FF3J disasm at 33/B0D8 (black) and 33/B0FF (white) writes $A1 to
  // $7F49 immediately at the pre-magic-animation start, before any spell-specific
  // SFX. Fires for every player-cast spell regardless of school.
  if (!_isItemUse) {
    playSFX(SFX.MAGIC_CAST);
  }
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
    applyMagicSight({
      sfx: SFX.SIGHT,
      onIneffectiveMsg: () => replaceBattleMsg(BATTLE_INEFFECTIVE),
    });
    return;
  }

  // target='enemy_status' — try to inflict a status condition (Confuse, Sleep,
  // Death). The spell's `type` field names the status. Battle items like
  // LamiaScale/SheepPillow/DevilNote dispatch through here.
  if (spell.target === 'enemy_status') {
    if (!mon) {
      // Boss path — no monster object. Treat as ineffective for now.
      replaceBattleMsg(BATTLE_INEFFECTIVE);
      _playSpellSFXOnce(SFX.SW_HIT);
      return;
    }
    if (mon.hp <= 0) return;
    if (spell.type === 'death') {
      // Instakill check against spell.hit, blocked by death-resistant monsters.
      if (Math.random() * 100 < spell.hit) {
        if (mon.status) addStatus(mon.status, STATUS.DEATH);
        mon.hp = 0;
        _setEnemyDmg(idx, 0, false);
        _playSpellSFXOnce(SFX.MONSTER_DEATH);
      } else {
        _setEnemyDmg(idx, 0, true);  // miss
      }
      return;
    }
    // type='all_status' (Shade) — try every "major" debuff against the enemy,
    // each rolled independently against spell.hit. Tranquilizer dispatches
    // through this; per FF3 NES Shade attempts paralysis and other statuses.
    if (spell.type === 'all_status') {
      if (!mon.status) return;
      const candidates = ['paralysis', 'blind', 'silence', 'sleep', 'confuse'];
      let anyApplied = 0;
      for (const name of candidates) {
        const f = tryInflictStatus(mon.status, name, spell.hit, mon.statusResist);
        if (f) {
          anyApplied |= f;
          _queueStatusMsg(f);
        }
      }
      if (anyApplied) {
        _playSpellSFXOnce(SFX.SW_HIT);
      } else {
        _setEnemyDmg(idx, 0, true);  // miss
      }
      return;
    }
    // confuse / sleep / blind / mini / silence / etc. — name = spell.type.
    // Shared `applyMagicStatus` helper (combatant-cast.js) — same path ally
    // + PVP-enemy use for Sleep.
    applyMagicStatus(mon, spell.type, spell.hit, {
      sfx: _spellImpactSFX(spell),
      onLand: _queueStatusMsg,
      onMiss: () => _setEnemyDmg(idx, 0, true),
    });
    return;
  }

  // target='erase' — clear positive statuses from enemy. No buff state on
  // monsters in the project yet, so this is a SFX-only acknowledgement.
  if (spell.target === 'erase') {
    _playSpellSFXOnce(SFX.SW_HIT);
    return;
  }

  // target='drain' — damage enemy + heal caster (the player) by the same amount.
  // Reverses on undead per NES canon (heal enemy, no player heal).
  if (spell.target === 'drain') {
    if (!mon || mon.hp <= 0) return;
    const drainAmt = _baseAmount >= 0
      ? Math.max(1, Math.floor(_baseAmount / _targets.length))
      : _rollMagicAmount(spell.power, true);
    if (_isUndead(mon)) {
      const heal = Math.min(drainAmt, (mon.maxHP || mon.hp) - mon.hp);
      mon.hp += heal;
      setEnemyHealNum({ value: heal, timer: 0, index: idx });
      _playSpellSFXOnce(SFX.CURE);
      return;
    }
    const dmg = Math.max(1, drainAmt);
    mon.hp = Math.max(0, mon.hp - dmg);
    _setEnemyDmg(idx, dmg, false);
    const playerHeal = Math.min(dmg, (ps.stats?.maxHP ?? ps.hp) - ps.hp);
    if (playerHeal > 0) {
      ps.hp += playerHeal;
      setPlayerHealNum({ value: playerHeal, timer: 0 });
    }
    battleSt.battleShakeTimer = BATTLE_SHAKE_MS;
    _playSpellSFXOnce(SFX.CURE);
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
      _playSpellSFXOnce(SFX.CURE);
      return;
    }
    if (!mon || mon.hp <= 0) return;
    if (_isUndead(mon)) {
      const dmg = Math.max(1, amount);
      mon.hp = Math.max(0, mon.hp - dmg);
      _setEnemyDmg(idx, dmg, false);
      battleSt.battleShakeTimer = BATTLE_SHAKE_MS;
      _playSpellSFXOnce(SFX.SW_HIT);
    } else {
      const heal = Math.min(amount, (mon.maxHP || mon.hp) - mon.hp);
      mon.hp += heal;
      setEnemyHealNum({ value: heal, timer: 0, index: idx });
      _playSpellSFXOnce(SFX.CURE);
    }
    return;
  }

  // Non-recovery (damage) spell on enemy.
  if (isBoss) {
    const dmg = Math.max(1, amount);
    setEnemyHP(Math.max(0, getEnemyHP() - dmg));
    _setEnemyDmg(idx, dmg, false);
    battleSt.battleShakeTimer = BATTLE_SHAKE_MS;
    _playSpellSFXOnce(_spellImpactSFX(spell));
    return;
  }
  if (!mon || mon.hp <= 0) return;
  // Shared `applyMagicDamage` helper — same path ally + PVP-enemy use for
  // Fire/Bzzard. Element multiplier + mdef applied internally.
  applyMagicDamage(mon, amount, spell, {
    sfx: SFX.SW_HIT,
    onDmgNum: (dealt) => _setEnemyDmg(idx, dealt, false),
    onShake: () => { battleSt.battleShakeTimer = BATTLE_SHAKE_MS; },
  });
}

function _applySpellEffect(target) {
  const spell = SPELLS.get(_spellId);
  if (!spell) return;

  if (target.type === 'enemy') {
    _applyEnemyEffect(target.index, spell);
    return;
  }

  // Sight on a friendly target — picker now defaults to enemy, but the user
  // can still navigate Right back to the player side. Shared `applyMagicSight`
  // helper (combatant-cast.js); same path ally + PVP-enemy use.
  if (spell.target === 'sight') {
    applyMagicSight({
      sfx: SFX.SIGHT,
      onIneffectiveMsg: () => replaceBattleMsg(BATTLE_INEFFECTIVE),
    });
    return;
  }

  // Self-buff spells (Haste, Protect, Reflect) — apply to ps via buffs.js.
  // Haste doubles potential hits per turn (calcPotentialHits respects it).
  // Protect halves incoming physical damage (rollHits respects it).
  // Reflect — buff is set, but spell-bouncing isn't wired yet (would need
  // target retargeting in this file). For now Reflect is cosmetic: msg fires,
  // buff records, but offensive enemy spells still hit normally. TODO when
  // we ship the bounce path.
  if (spell.target === 'haste') {
    applyBuff(ps, BUFF_HASTE);
    replaceBattleMsg(BATTLE_HASTE);
    _playSpellSFXOnce(SFX.CURE);
    return;
  }
  if (spell.target === 'protect') {
    applyBuff(ps, BUFF_PROTECT);
    replaceBattleMsg(BATTLE_PROTECT);
    _playSpellSFXOnce(SFX.CURE);
    return;
  }
  if (spell.target === 'reflect') {
    applyBuff(ps, BUFF_REFLECT);
    replaceBattleMsg(BATTLE_REFLECT);
    _playSpellSFXOnce(SFX.CURE);
    return;
  }

  // Damage spells (Fire, future BM family) on a friendly target — picker
  // defaults to enemy, but if the user navigates to a friendly cell the spell
  // would otherwise fall through to the heal path below and silently restore
  // HP. Surface "Ineffective" instead and don't apply any effect.
  if (spell.type === 'damage') {
    replaceBattleMsg(BATTLE_INEFFECTIVE);
    _playSpellSFXOnce(SFX.ERROR);
    return;
  }

  // Friendly target paths (player / ally)
  const isCureStatus = spell.target === 'cure_status';
  const isHeal = spell.element === 'recovery';
  const useMnd = isHeal || isCureStatus || spell.target === 'revive';
  const amount = _baseAmount >= 0
    ? Math.max(1, Math.floor(_baseAmount / _targets.length))
    : _rollMagicAmount(spell.power, useMnd);

  // Friendly target — resolve target object + heal-num callback per type.
  const isPlayerTgt = target.type === 'player';
  const tgt = isPlayerTgt ? ps : battleSt.battleAllies[target.index];
  if (!tgt) return;
  const onHealNum = isPlayerTgt
    ? (n) => setPlayerHealNum({ value: n, timer: 0 })
    : (n) => { getAllyDamageNums()[target.index] = { value: n, timer: 0, heal: true }; };

  // Cure-status (Poisona, Antidote) — shared helper.
  if (isCureStatus) {
    const flag = SPELL_CURE_FLAG[spell.type];
    applyMagicCureStatus(tgt, flag, {
      sfx: SFX.CURE,
      onSparkle: () => onHealNum(0),
    });
    return;
  }

  // Cure (heal) — shared helper. SFX is CURE for recovery spells, SW_HIT
  // legacy for non-recovery friendly heals (rare).
  applyMagicHeal(tgt, amount, {
    sfx: isHeal ? SFX.CURE : SFX.SW_HIT,
    onHealNum,
  });
}

// Returns true if the captured white-magic anim (magic circle build-up + cast
// pose + heal sparkle) applies. The FF3 ROM shares this animation across the
// whole white-magic school — REC OAM of Poisona showed tiles $4A-$57 byte-
// identical to Cure's, same SP3 palette `[0x0F, 0x15, 0x27, 0x30]`, same per-
// frame progression. So recovery (Cure family), status-cure (Poisona, Bndna,
// etc.), revive (Raise), and captured BM damage spells (Fire) all use it.
// Spells with un-captured visuals fall back to the legacy 250/400/1100 timing.
function _isCastAnimSpell() {
  // Items skip the BM/WM cast pose entirely — they go straight from throw to
  // hit with no buildup window, so timing falls back to legacy 250ms→1100ms.
  if (_isItemUse) return false;
  const spell = SPELLS.get(_spellId);
  if (!spell) return false;
  return spell.element === 'recovery'
      || spell.target === 'cure_status'
      || spell.target === 'revive'
      || spell.target === 'sight'
      || _isThrownDamageElement(spell.element)
      || _isThrownStatusType(spell.type);
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
  const isThrown = !!(spell && (spell.target === 'sight' || _isThrownDamageElement(spell.element) || _isThrownStatusType(spell.type)));
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
  // sfxStartMs = when the spell SFX plays. For thrown damage spells with
  // a cross-faction target, fire at IMPACT START (when the burst begins
  // rendering) so the boom sound plays during the visual rather than at
  // the damage-number pop. Heal-style and Sight keep firing SFX inside
  // _applyEnemyEffect / _applySpellEffect at hitEffectMs.
  const _hasCrossFactionTarget = _targets.some(t => t && t.type === 'enemy');
  // Any thrown spell with a cross-faction target fires its impact SFX at
  // burst start (Fire, Blizzard, Sleep). Sight is excluded — it has no impact
  // bundle and plays its own SFX inside _applyEnemyEffect at hitEffectMs.
  const _isThrownToEnemy = isThrown && spell && spell.target !== 'sight' && _hasCrossFactionTarget;
  // Item-use skips the cast windup, so magic-hit starts the impact at timer=0
  // — fire SFX immediately. Spell-cast keeps the projectile-end offset.
  const sfxStartMs = _isThrownToEnemy
    ? (_isItemUse ? 0 : (CAST_T_THROW_IMPACT_START - CAST_PHASE_MS.buildup))
    : -1;

  if (battleSt.battleState === 'magic-cast') {
    if (battleSt.battleTimer >= castDur) {
      if (_targets.length === 0) { _processNextTurn(); return true; }
      _hitIdx = 0; _effectApplied = false;
      // Thrown spells with cross-faction target(s) get the projectile fan
      // first, then the per-target serial impact walk. Heal-style + boss-
      // path single-target stay in 'impact-walk' for the whole magic-hit
      // duration. Item-use skips the projectile sub-phase entirely (legacy
      // SouthWind behavior: items have no projectile flight, just the per-
      // target impact walk).
      _magicHitPhase = (isThrown && _hasCrossFactionTarget && !_isItemUse) ? 'projectile' : 'impact-walk';
      _sfxPlayed = false;
      battleSt.battleState = 'magic-hit'; battleSt.battleTimer = 0;
    }
    return true;
  }
  if (battleSt.battleState !== 'magic-hit') return false;
  tickHealNums(dt);

  // Phase 1 — projectile fan-out (parallel, ~150ms). Render path draws all
  // enemyTargets simultaneously. No effect apply during this phase.
  if (_magicHitPhase === 'projectile') {
    const projDur = CAST_PHASE_MS_THROW.projectile;
    if (battleSt.battleTimer >= projDur) {
      _magicHitPhase = 'impact-walk';
      battleSt.battleTimer = 0;
      _hitIdx = 0;
      _effectApplied = false;
      _sfxPlayed = false;
    }
    return true;
  }

  // Phase 2a — thrown impact walk: per-target serial impact + damage hold.
  // Each target gets its own ~1050ms window: 0..550 impact burst, 550 = apply
  // effect (damage / status roll), 550..1050 hold for the damage-number
  // bounce. SFX fires per-target at the start of each window.
  if (isThrown && _hasCrossFactionTarget) {
    const impactDur = CAST_PHASE_MS_THROW.impact;       // 550 ms
    const damageHoldMs = 500;
    const perTargetMs = impactDur + damageHoldMs;
    if (!_sfxPlayed) _playSpellSFXOnce(_spellImpactSFX(spell));
    if (!_effectApplied && battleSt.battleTimer >= impactDur) {
      _applySpellEffect(_targets[_hitIdx]);
      _effectApplied = true;
    }
    if (battleSt.battleTimer >= perTargetMs) {
      _hitIdx++;
      if (_hitIdx < _targets.length) {
        battleSt.battleTimer = 0;
        _effectApplied = false;
        _sfxPlayed = false;
        return true;
      }
      // Walk complete — pin _hitIdx to last target so any render reads stay
      // in-bounds, then run the shared transition tail.
      _hitIdx = _targets.length - 1;
      _finishMagicHit();
    }
    return true;
  }

  // Phase 2b — heal-style / single-target / sight: original parallel apply.
  if (sfxStartMs >= 0 && !_sfxPlayed && battleSt.battleTimer >= sfxStartMs) {
    _playSpellSFXOnce(_spellImpactSFX(spell));
  }
  if (!_effectApplied && battleSt.battleTimer >= hitEffectMs) {
    for (const tgt of _targets) _applySpellEffect(tgt);
    _effectApplied = true;
  }
  if (battleSt.battleTimer >= hitTotalMs) {
    _finishMagicHit();
  }
  return true;
}

// Shared transition tail: clears heal numbers, detects spell-kills, and
// routes to monster-death / boss-dissolve / pvp-dissolve / msg-wait /
// next-turn the same way the legacy parallel-apply branch did. Called by
// both the throw-walk completion and the heal-style total-time completion.
function _finishMagicHit() {
  clearHealNums();
  const killedEnemyIndices = [];
  if (battleSt.isRandomEncounter && battleSt.encounterMonsters) {
    for (const t of _targets) {
      if (t.type === 'enemy' && battleSt.encounterMonsters[t.index]?.hp <= 0) {
        killedEnemyIndices.push(t.index);
      }
    }
  }
  if (killedEnemyIndices.length > 0) {
    replaceBattleMsg(BATTLE_SLAIN);
    battleSt.dyingMonsterIndices = new Map(killedEnemyIndices.map(i => [i, 0]));
    battleSt.battleState = 'monster-death';
    battleSt.battleTimer = 0;
    playSFX(SFX.MONSTER_DEATH);
  } else if (!battleSt.isRandomEncounter && getEnemyHP() <= 0) {
    replaceBattleMsg(BATTLE_SLAIN);
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
    // Battle message still on screen (Sight's "Ineffective", status-name
    // strips, future spell-text dialog) — defer turn advance through
    // msg-wait gate.
    battleSt.battleState = 'msg-wait';
    battleSt.battleTimer = 0;
  } else {
    _processNextTurn();
  }
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
