// Spell-cast engine — player-cast magic flow.
// Handles ally-target heal/cure (Cure, Poisona) and enemy-target damage paths.
// Pipeline: input → startSpellCast → 'magic-cast' (buildup) → 'magic-hit' (apply
// effect + anim) → next turn. Spells with un-captured visuals fall back to the
// legacy 1100 ms timing; captured spells (Cure, Poisona, Sight, Fire) use the
// CAST_PHASE_MS model from cast-anim.js (~1667 ms).

import { battleSt, getEnemyHP, setEnemyHP, BATTLE_SHAKE_MS, setActiveCast, clearActiveCast } from './battle-state.js';
import { ps } from './player-stats.js';
import { inputSt } from './input-handler.js';
import { SFX, playSFX } from './music.js';
import { setPlayerHealNum, setPlayerDamageNum, getAllyDamageNums, setEnemyDmgNum, setEnemyHealNum, setSwDmgNum,
         tickHealNums, clearHealNums, DMG_SHOW_MS, makeHealNumCallback } from './damage-numbers.js';
import { SPELLS, getSpellMPCost, isMultiTargetSpell } from './data/spells.js';
import { STATUS, addStatus, removeStatus, tryInflictStatus, STATUS_NAME_BYTES, STATUS_NAME_TO_FLAG } from './status-effects.js';
import { CAST_PHASE_MS, CAST_PHASE_MS_THROW, CAST_TOTAL_MS, CAST_T_THROW_RETURN, CAST_T_THROW_IMPACT_START,
         CAST_T_HEAL_APPLY, CAST_T_HEAL_ANIM_START } from './cast-anim.js';
import { applyMagicDamage, applyMagicStatus, applyMagicHeal,
         applyMagicCureStatus, applyMagicSight, applyMagicDrain,
         applyMagicRecovery, applyMagicAllStatus, applyMagicInstakill,
         applyMagicErase, getSpellImpactSFX } from './combatant-cast.js';
import { pvpGridLayout } from './pvp-math.js';
import { queueBattleMsg, replaceBattleMsg } from './battle-msg.js';
import { BATTLE_INEFFECTIVE, BATTLE_HASTE, BATTLE_PROTECT, BATTLE_REFLECT, BATTLE_SLAIN } from './data/strings.js';
import { _nameToBytes } from './text-utils.js';
import { getSpellNameShrinesClean, getItemNameShrinesClean } from './text-decoder.js';
import { elemMultiplier, resolveLivingTarget } from './battle-math.js';
import { rand } from './rng.js';
import { pvpSt } from './pvp.js';
import { applyBuff, BUFF_HASTE, BUFF_PROTECT, BUFF_REFLECT } from './buffs.js';

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
// Spell impact SFX selector moved to `combatant-cast.js:getSpellImpactSFX` —
// single source for all three role engines (player + ally + PVP-enemy). Local
// alias for grep-discoverability and existing call sites.
const _spellImpactSFX = (spell) => getSpellImpactSFX(spell);

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
  clearActiveCast();
}

// NES FF3 magic formula (31/B1B4): atk = floor(stat/2) + power, +rand(0..atk/2).
// White magic (recovery / status) uses caster MND; black magic (damage) uses INT.
function _rollMagicAmount(power, useMnd) {
  const stat = ps.stats ? (useMnd ? (ps.stats.mnd || 5) : (ps.stats.int || 5)) : 5;
  const atk = Math.floor(stat / 2) + power;
  return atk + Math.floor(rand() * (Math.floor(atk / 2) + 1));
}

// Pre-roll the magic amount for a player-cast spell BEFORE wire emit so the
// rolled value can ride the wire payload. The PvP wire bridge calls this at
// confirm-pause (battle-update.js#_updateBattleMenuConfirm); the rolled
// value gets stashed on `pending.preRolledAmount` and threaded through
// `startSpellCast(spellId, ts, { preRolledAmount })`. The receiver applies
// the supplied value directly so neither side double-consumes `rand()`.
// Returns 0 for spells with no numeric amount (status / revive / buffs).
export function prerollSpellAmount(spellId) {
  const spell = SPELLS.get(spellId);
  if (!spell || !(spell.power > 0)) return 0;
  const useMnd = spell.element === 'recovery'
    || spell.target === 'cure_status'
    || spell.target === 'revive';
  return _rollMagicAmount(spell.power, useMnd);
}

// Wire bridge needs to know whether the rolled amount is a heal (rides
// `healAmount`) or damage (rides `damageRoll`). Mirrors `prerollSpellAmount`'s
// useMnd decision but exposed for the wire emit sites.
export function isHealSpell(spellId) {
  const spell = SPELLS.get(spellId);
  if (!spell) return false;
  return spell.element === 'recovery'
    || spell.target === 'cure_status'
    || spell.target === 'revive';
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
    replaceBattleMsg(getItemNameShrinesClean(opts.itemId));
  } else {
    replaceBattleMsg(getSpellNameShrinesClean(spellId));
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


  // Wire bridge: when the caller pre-rolled the amount (co-op + PvP wire path
  // at confirm-pause), use that value as `_baseAmount` and skip the local
  // roll. Without this both sender and receiver would consume different
  // rand() counts → cursor drift + damage-number divergence. Falls through
  // to legacy multi-target roll for non-wire / AI paths.
  if (typeof opts.preRolledAmount === 'number' && opts.preRolledAmount > 0) {
    _baseAmount = opts.preRolledAmount | 0;
  } else if (_targets.length > 1 && spell.power > 0) {
    // Multi-target → roll once at cast time, divide at apply time.
    // Single-target keeps per-target re-roll (legacy). Skips status/revive
    // cures (no amount).
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
  // v1.7.362 step 5/7 — unified active-cast bag. Module-local `_spellId`,
  // `_targets`, `_isItemUse` continue to drive the player-cast pipeline;
  // this populates the shared bag so the wire layer (future step) has one
  // place to read instead of three.
  setActiveCast({
    caster: { faction: 'player', idx: -1 },
    spellId,
    isItemUse: _isItemUse,
    targets: _targets.map(t => ({ faction: t.type, idx: t.index ?? -1 })),
    healAmount: _baseAmount >= 0 ? _baseAmount : 0,
    damageRoll: 0,
  });
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
  let mon = isBoss ? null : _getEnemyAt(idx);

  // Apply-time target redirect (v1.7.359 step 2/7). If the spell was aimed at
  // a single target and the picked monster died during cast windup, redirect
  // to the next-living enemy on the same side so the spell doesn't silently
  // miss. Multi-target spells walk their own _targets list and skip dead
  // slots naturally at the apply path. Reassigning `idx` here updates every
  // closure-bound `_setEnemyDmg(idx, …)` callback below because they capture
  // the local variable, not its value at call site.
  if (!isBoss && _targets.length === 1 && mon && mon.hp <= 0) {
    const factionList = isEncounter
      ? battleSt.encounterMonsters
      : [pvpSt.pvpOpponentStats, ...(pvpSt.pvpEnemyAllies || [])];
    const live = resolveLivingTarget(mon, factionList);
    if (live) {
      mon = live;
      idx = factionList.indexOf(live);
    }
  }

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
      // Shared `applyMagicInstakill` helper.
      applyMagicInstakill(mon, spell.hit, {
        sfx: SFX.MONSTER_DEATH,
        onDmgNum: () => _setEnemyDmg(idx, 0, false),
        onMiss: () => _setEnemyDmg(idx, 0, true),
      });
      return;
    }
    // type='all_status' (Shade / Tranquilizer) — shared `applyMagicAllStatus`.
    if (spell.type === 'all_status') {
      applyMagicAllStatus(mon, spell.hit, {
        sfx: SFX.SW_HIT,
        onStatusLand: _queueStatusMsg,
        onMiss: () => _setEnemyDmg(idx, 0, true),
      });
      return;
    }
    // confuse / sleep / blind / mini / silence / etc. — name = spell.type.
    // Shared `applyMagicStatus` helper (combatant-cast.js). SFX: thrown status
    // (sleep) gets fired by the engine at impact start; non-thrown status
    // (confuse / blind / mini / silence) fires SFX at apply time via opts.sfx
    // since there's no impact-burst phase for those.
    applyMagicStatus(mon, spell.type, spell.hit, {
      sfx: _isThrownStatusType(spell.type) ? null : _spellImpactSFX(spell),
      onLand: _queueStatusMsg,
      onMiss: () => _setEnemyDmg(idx, 0, true),
    });
    return;
  }

  // target='erase' — shared `applyMagicErase` helper.
  if (spell.target === 'erase') {
    applyMagicErase({ sfx: SFX.SW_HIT });
    return;
  }

  // target='drain' — shared `applyMagicDrain` helper.
  if (spell.target === 'drain') {
    if (!mon || mon.hp <= 0) return;
    const drainAmt = _baseAmount >= 0
      ? Math.max(1, Math.floor(_baseAmount / _targets.length))
      : _rollMagicAmount(spell.power, true);
    applyMagicDrain(mon, drainAmt, {
      sfx: SFX.CURE,
      isUndead: _isUndead(mon),
      onTargetDmgNum: (dmg) => _setEnemyDmg(idx, dmg, false),
      onTargetHealNum: makeHealNumCallback('enemy', idx),
      onShake: () => { battleSt.battleShakeTimer = BATTLE_SHAKE_MS; },
      onCasterHeal: (amt) => {
        const realHeal = Math.min(amt, (ps.stats?.maxHP ?? ps.hp) - ps.hp);
        if (realHeal > 0) {
          ps.hp += realHeal;
          setPlayerHealNum({ value: realHeal, timer: 0 });
        }
      },
    });
    return;
  }

  // Recovery spell → undead damages, non-undead heals (NES default; player
  // chose to spend MP on a non-undead enemy, so they get healed).
  const isRecovery = spell.element === 'recovery';
  const useMnd = isRecovery || spell.target === 'cure_status' || spell.target === 'revive';

  const amount = _baseAmount >= 0
    ? Math.max(1, Math.floor(_baseAmount / _targets.length))
    : _rollMagicAmount(spell.power, useMnd);

  if (isRecovery) {
    if (isBoss) {
      // Boss path: no monster object so we can't detect undead. Default to heal
      // (matches NES non-undead behavior). Direct HP manipulation here since
      // boss uses getEnemyHP/setEnemyHP, not a monster object.
      const curHP = getEnemyHP();
      const heal = Math.min(amount, 9999 - curHP);
      setEnemyHP(curHP + heal);
      setEnemyHealNum({ value: heal, timer: 0, index: idx });
      _playSpellSFXOnce(SFX.CURE);
      return;
    }
    if (!mon || mon.hp <= 0) return;
    // Shared `applyMagicRecovery` helper — heals non-undead, damages undead.
    applyMagicRecovery(mon, amount, {
      isUndead: _isUndead(mon),
      onDmgNum: (dmg) => _setEnemyDmg(idx, dmg, false),
      onHealNum: makeHealNumCallback('enemy', idx),
      onShake: () => { battleSt.battleShakeTimer = BATTLE_SHAKE_MS; },
    });
    return;
  }

  // Non-recovery (damage) spell on enemy.
  if (isBoss) {
    // Boss path bypasses applyMagicDamage (no monster object), so do the
    // hit-check locally to preserve hit<100 miss chance.
    if (spell.hit > 0 && spell.hit < 100 && rand() * 100 >= spell.hit) {
      _setEnemyDmg(idx, 0, true);
      return;
    }
    const dmg = Math.max(1, amount);
    setEnemyHP(Math.max(0, getEnemyHP() - dmg));
    _setEnemyDmg(idx, dmg, false);
    battleSt.battleShakeTimer = BATTLE_SHAKE_MS;
    _playSpellSFXOnce(_spellImpactSFX(spell));
    return;
  }
  if (!mon || mon.hp <= 0) return;
  // Shared `applyMagicDamage` helper. SFX: thrown elements (fire/ice/bolt) get
  // fired by the engine at impact start; non-thrown damage fires here via
  // opts.sfx. Most damage spells are thrown so opts.sfx is usually null.
  // Hit-check now lives inside `applyMagicDamage` (v1.7.466) so the sender
  // and the wire-driven watcher consume the same rand count — pre-fix the
  // sender rolled here and the watcher skipped, drifting the round cursor
  // by one per hit<100 damage cast.
  applyMagicDamage(mon, amount, spell, {
    sfx: _isThrownDamageElement(spell.element) ? null : SFX.SW_HIT,
    onDmgNum: (dealt) => _setEnemyDmg(idx, dealt, false),
    onMiss:   () => _setEnemyDmg(idx, 0, true),
    onShake:  () => { battleSt.battleShakeTimer = BATTLE_SHAKE_MS; },
  });
}

// Apply an offensive spell (damage / status / instakill / all-status) to a
// FRIENDLY target. v1.7.361 (step 4/7) — pre-step-4 the player could not
// pick their own ally or self as an offensive target; the dispatch errored
// with "Ineffective". Engine-side `applyMagic*` helpers were always
// faction-agnostic, so this is a routing fix not a primitive change. Mirror
// of `_applyEnemyEffect`'s offensive branches but with player/ally
// damage-num callbacks (`setPlayerDamageNum` / `getAllyDamageNums()[idx]`)
// in place of the enemy `_setEnemyDmg` callback.
function _applyFriendlyOffensive(target, spell) {
  const isPlayerTgt = target.type === 'player';
  const tgt = isPlayerTgt ? ps : battleSt.battleAllies[target.index];
  if (!tgt || tgt.hp <= 0) return;

  const setDmgNum = (val, miss = false) => {
    if (isPlayerTgt) {
      setPlayerDamageNum(miss ? { miss: true, timer: 0 } : { value: val, timer: 0 });
    } else {
      getAllyDamageNums()[target.index] = miss ? { miss: true, timer: 0 } : { value: val, timer: 0 };
    }
  };

  // Status / instakill / all-status routes through dedicated helpers.
  if (spell.target === 'enemy_status') {
    if (spell.type === 'death') {
      applyMagicInstakill(tgt, spell.hit, {
        sfx: SFX.MONSTER_DEATH,
        onDmgNum: () => setDmgNum(0),
        onMiss: () => setDmgNum(0, true),
      });
      return;
    }
    if (spell.type === 'all_status') {
      applyMagicAllStatus(tgt, spell.hit, {
        sfx: SFX.SW_HIT,
        onStatusLand: _queueStatusMsg,
        onMiss: () => setDmgNum(0, true),
      });
      return;
    }
    applyMagicStatus(tgt, spell.type, spell.hit, {
      sfx: _isThrownStatusType(spell.type) ? null : _spellImpactSFX(spell),
      onLand: _queueStatusMsg,
      onMiss: () => setDmgNum(0, true),
    });
    return;
  }

  // Damage spell on friendly. Hit-check now happens inside applyMagicDamage
  // (v1.7.466 — keeps the rand-consumption symmetric with the wire watcher
  // path). On miss, `onMiss` fires the miss display instead of `onDmgNum`.
  const amount = _baseAmount >= 0
    ? Math.max(1, Math.floor(_baseAmount / _targets.length))
    : _rollMagicAmount(spell.power, false);

  applyMagicDamage(tgt, amount, spell, {
    sfx: _isThrownDamageElement(spell.element) ? null : SFX.SW_HIT,
    onDmgNum: (dealt) => setDmgNum(dealt),
    onMiss:   () => setDmgNum(0, true),
    onShake:  () => { battleSt.battleShakeTimer = BATTLE_SHAKE_MS; },
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

  // Apply-time target redirect (v1.7.359 step 2/7). If the spell was aimed at
  // a single friendly and the picked combatant died during cast windup,
  // redirect to the next-living teammate (another ally first, then the player
  // as fallback). Multi-target heals re-roll per slot below; dead slots there
  // skip silently inside applyMagicHeal.
  let activeTarget = target;
  if (_targets.length === 1) {
    const allies = battleSt.battleAllies || [];
    const picked = target.type === 'player' ? ps : allies[target.index];
    if (!picked || picked.hp <= 0) {
      let redirected = null;
      for (let i = 0; i < allies.length; i++) {
        if (allies[i] && allies[i].hp > 0) {
          redirected = { type: 'ally', index: i };
          break;
        }
      }
      if (!redirected && ps.hp > 0) redirected = { type: 'player' };
      if (redirected) activeTarget = redirected;
    }
  }

  // Offensive spell on a friendly target (v1.7.361 step 4/7). Pre-step-4 this
  // errored with "Ineffective" — engine-side `applyMagic*` helpers are
  // faction-agnostic, only the routing here forbade it. Now mirrors the
  // confused-attack path (battle-turn.js:128-147) which has always written
  // friendly damage via the same primitives. Player who intentionally picks
  // their own ally as Fire target sees damage land + the standard impact anim.
  //
  // NOTE: cannot gate by `spell.type === 'damage'` — Cure + Cura have
  // type='damage' too (it's the dispatch axis for numeric-effect spells).
  // Gate by offensive-target set instead so heal spells still reach
  // applyMagicHeal below.
  if (spell.target === 'enemy' || spell.target === 'all_enemies' || spell.target === 'enemy_status') {
    _applyFriendlyOffensive(activeTarget, spell);
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
  const isPlayerTgt = activeTarget.type === 'player';
  const tgt = isPlayerTgt ? ps : battleSt.battleAllies[activeTarget.index];
  if (!tgt) return;
  const onHealNum = makeHealNumCallback(isPlayerTgt ? 'self' : 'ally', activeTarget.index);

  // Cure-status (Poisona, Antidote) — shared helper.
  // SFX fires via the engine at sparkle-start (see `getSpellImpactSFX` →
  // `playSpellImpactSFX`). NOT passed to the helper.
  if (isCureStatus) {
    const flag = STATUS_NAME_TO_FLAG[spell.type];
    applyMagicCureStatus(tgt, flag, {
      onSparkle: () => onHealNum(0),
    });
    return;
  }

  // Cure (heal) — shared helper. SFX engine-driven; not in opts.
  applyMagicHeal(tgt, amount, { onHealNum });
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
  // - Heal-style (Cure, Poisona): same sequential pipeline as throw, just no
  //   projectile. preImpactGap → sparkle (impact) → postImpactGap → apply →
  //   damage-num bounce. Effect fires at CAST_T_HEAL_APPLY (= preGap+impact+
  //   postGap) so the heal number is sequential with the sparkle, not parallel.
  //   Total extends by DMG_SHOW_MS so the number's bounce + stick play out
  //   before the state ends.
  // - Throw-style (Fire): effect at impact END so the damage number doesn't
  //   pop mid-burst — extend total by 500 ms so the number's bounce
  //   actually plays before the state transitions to monster-death.
  const hitEffectMs = useCastAnim
    ? (isThrown ? (CAST_T_THROW_RETURN - CAST_PHASE_MS.buildup)
                : (CAST_T_HEAL_APPLY - CAST_PHASE_MS.buildup))
    : 400;
  const hitTotalMs  = useCastAnim
    ? (isThrown ? (CAST_T_THROW_RETURN - CAST_PHASE_MS.buildup + 500)
                : (hitEffectMs + DMG_SHOW_MS))
    : 1100;
  // sfxStartMs = when the spell SFX plays. ALL spells fire SFX during the
  // spell-animation phase — engine drives it, helpers never carry SFX.
  // (See memory `feedback_ff3mmo_sfx_during_spell_anim.md`.)
  //
  // - Throw (Fire / Bzzard / Sleep): SFX at IMPACT START (burst begins).
  // - Heal-style (Cure / Poisona / recovery / cure_status): SFX at SPARKLE
  //   START (heal-sparkle canvas begins rendering).
  // - Sight: special — its SFX still fires at hitEffectMs because Sight has
  //   no spell-anim render (the "Ineffective" msg is the visual feedback).
  const _hasCrossFactionTarget = _targets.some(t => t && t.type === 'enemy');
  const _isThrownToEnemy = isThrown && spell && spell.target !== 'sight' && _hasCrossFactionTarget;
  // Item-use skips the cast windup, so magic-hit starts the impact at timer=0
  // — fire SFX immediately. Spell-cast keeps the projectile-end offset.
  let sfxStartMs;
  if (_isThrownToEnemy) {
    sfxStartMs = _isItemUse ? 0 : (CAST_T_THROW_IMPACT_START - CAST_PHASE_MS.buildup);
  } else if (useCastAnim && !isThrown && spell && spell.target !== 'sight') {
    // Heal-style sparkle starts at preImpactGap into magic-hit phase.
    sfxStartMs = CAST_T_HEAL_ANIM_START - CAST_PHASE_MS.buildup;
  } else {
    sfxStartMs = -1;  // legacy / sight / unknown — SFX gated inside _apply* helpers
  }

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
    // Projectile phase includes the preImpactGap — projectile renders for
    // `projectile` ms then nothing for `preImpactGap` ms before transitioning
    // to impact-walk. The renderer (combatant-cast.js drawSpellThrow) gates
    // its render on ms < projectile, so the gap is naturally empty.
    const projDur = CAST_PHASE_MS_THROW.projectile + CAST_PHASE_MS_THROW.preImpactGap;
    if (battleSt.battleTimer >= projDur) {
      _magicHitPhase = 'impact-walk';
      battleSt.battleTimer = 0;
      _hitIdx = 0;
      _effectApplied = false;
      _sfxPlayed = false;
    }
    return true;
  }

  // Phase 2a — thrown impact walk: per-target serial impact + post-impact gap
  // + damage hold. Each target gets a ~1150ms window: 0..550 impact burst,
  // 550..650 post-impact gap (no render), 650 = apply effect (damage applies +
  // damage number pops), 650..1150 hold for the damage-number bounce. SFX
  // fires per-target at the start of each window.
  if (isThrown && _hasCrossFactionTarget) {
    const impactDur     = CAST_PHASE_MS_THROW.impact;          // 550
    const postGap       = CAST_PHASE_MS_THROW.postImpactGap;   // 100
    const damageStartMs = impactDur + postGap;                  // 650 — when damage applies
    const damageHoldMs  = DMG_SHOW_MS;                          // 750 — full bounce + stick
    const perTargetMs   = damageStartMs + damageHoldMs;        // 1400
    if (!_sfxPlayed) _playSpellSFXOnce(_spellImpactSFX(spell));
    if (!_effectApplied && battleSt.battleTimer >= damageStartMs) {
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
// routes to monster-death / boss-dissolve / pvp-dissolve / next-turn the
// same way the legacy parallel-apply branch did. Called by both the
// throw-walk completion and the heal-style total-time completion.
function _finishMagicHit() {
  clearHealNums();
  // Collect kills across the spell's target set. Encounter monsters use
  // monsterIndex (idx into encounterMonsters); PVP enemies use cellIdx
  // (0 = main opp, 1+ = pvpEnemyAllies[idx-1]). Pre-v1.7.213 the PVP
  // branch only fired for the player's currently-selected target via
  // getEnemyHP() — multi-target spells that killed off-target PVP enemies
  // would die silently with no dissolve anim.
  const killedEnemyIndices = [];
  const killedPVPCells = [];
  if (battleSt.isRandomEncounter && battleSt.encounterMonsters) {
    for (const t of _targets) {
      if (t.type === 'enemy' && battleSt.encounterMonsters[t.index]?.hp <= 0) {
        killedEnemyIndices.push(t.index);
      }
    }
  } else if (pvpSt.isPVPBattle) {
    for (const t of _targets) {
      if (t.type !== 'pvp-enemy') continue;
      const tgt = t.index === 0 ? pvpSt.pvpOpponentStats : pvpSt.pvpEnemyAllies[t.index - 1];
      if (tgt && tgt.hp <= 0) killedPVPCells.push(t.index);
    }
    // Single-target spell path didn't carry a `pvp-enemy` target descriptor —
    // fall back to the player's currently-selected target dying via getEnemyHP.
    if (killedPVPCells.length === 0 && getEnemyHP() <= 0) {
      const cellIdx = pvpSt.pvpPlayerTargetIdx < 0 ? 0 : pvpSt.pvpPlayerTargetIdx + 1;
      killedPVPCells.push(cellIdx);
    }
  }
  if (killedEnemyIndices.length > 0) {
    replaceBattleMsg(BATTLE_SLAIN);
    battleSt.dyingMonsterIndices = new Map(killedEnemyIndices.map(i => [i, 0]));
    // Last entry wins for multi-kill (AOE Fire on all enemies); for single-kill
    // it's the one killed monster. Either way the victory-name-out shows
    // a monster the player actually defeated, not encounterMonsters[0].
    const lastKilled = battleSt.encounterMonsters?.[killedEnemyIndices[killedEnemyIndices.length - 1]];
    if (lastKilled) battleSt.lastKilledMonsterId = lastKilled.monsterId;
    battleSt.battleState = 'monster-death';
    battleSt.battleTimer = 0;
    playSFX(SFX.MONSTER_DEATH);
  } else if (killedPVPCells.length > 0) {
    replaceBattleMsg(BATTLE_SLAIN);
    pvpSt.pvpDyingMap = new Map(killedPVPCells.map(i => [i, 0]));
    battleSt.battleState = 'pvp-dissolve';
    battleSt.battleTimer = 0;
    playSFX(SFX.MONSTER_DEATH);
  } else if (!battleSt.isRandomEncounter && !pvpSt.isPVPBattle && getEnemyHP() <= 0) {
    replaceBattleMsg(BATTLE_SLAIN);
    battleSt.battleState = 'boss-dissolve';
    battleSt.battleTimer = 0;
    playSFX(SFX.BOSS_DEATH);
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
