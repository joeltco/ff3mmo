// Battle ally update logic — extracted from game.js

import { battleSt, getEnemyHP, BATTLE_SHAKE_MS, BATTLE_DMG_SHOW_MS } from './battle-state.js';
import { playSlashSFX } from './battle-sfx.js';
import { resetSlashScatterCache, shouldDrawSlash, SWING_HOLD_MS } from './slash-effects.js';
import { summarizeHits, isLeftHandHit } from './battle-math.js';
import { applyPhysicalHitToEnemy } from './physical-attack.js';
import { isWeapon } from './data/items.js';
import { SFX, playSFX } from './music.js';
import { _nameToBytes } from './text-utils.js';
import { queueBattleMsg } from './battle-msg.js';
import { BATTLE_ALLY, BATTLE_SLAIN } from './data/strings.js';
import { pvpSt } from './pvp.js';
import { inputSt } from './input-handler.js';
import { getEnemyDmgNum, setEnemyDmgNum, setPlayerHealNum, getAllyDamageNums, tickHealNums, clearHealNums, setSwDmgNum, DMG_SHOW_MS, makeHealNumCallback } from './damage-numbers.js';
import { ROSTER_FADE_STEPS } from './data/players.js';
import { IDLE_FRAME_MS } from './combatant-pose.js';
import { ps } from './player-stats.js';
import { STATUS, STATUS_NAME_TO_FLAG } from './status-effects.js';
import { SPELLS } from './data/spells.js';
import { replaceBattleMsg } from './battle-msg.js';
import { CAST_PHASE_MS_THROW, CAST_PHASE_MS_HEAL } from './cast-anim.js';
import { applyMagicDamage, applyMagicStatus, applyMagicHeal,
         applyMagicCureStatus, applyMagicSight, applyMagicErase,
         applySpell, playSpellImpactSFX } from './combatant-cast.js';
import { COOP_HOST_ARB, resolvePhysicalAttack } from './coop-resolver.js';

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
  const { totalDmg, anyCrit, allMiss } = summarizeHits(battleSt.allyHitResults);
  setEnemyDmgNum(allMiss ? { miss: true, timer: 0 } : { value: totalDmg, crit: anyCrit, timer: 0 });
  inputSt.targetIndex = battleSt.allyTargetIndex;
  // Phase 6 — host-arb emit. The attacking "ally" on host's view is a
  // peer player; their action was relayed via `encounter-action` and
  // host ran the rolled hits locally. Ship the outcome so every other
  // guest (including the original sender) applies the same damage.
  // Encounter only (PvP unaffected). Flag-gated; default off.
  if (COOP_HOST_ARB && battleSt.isWireEncounter && battleSt.encounterIsHost
      && !pvpSt.isPVPBattle && battleSt.allyTargetIndex >= 0) {
    const ally = battleSt.battleAllies[battleSt.currentAllyAttacker];
    if (ally && ally.userId) {
      resolvePhysicalAttack({
        actor:  { kind: 'player', userId: ally.userId | 0 },
        target: { kind: 'monster', idx: battleSt.allyTargetIndex },
        hits:   battleSt.allyHitResults || [],
        weaponId: ally.weaponId || ally.weaponL || 0,
        hand:    battleSt.allyHitIsLeft ? 'L' : 'R',
      });
    }
  }
}

// ── After damage-show: check for death/dissolve or advance turn ──────────────
function _updateAllyDamageShow() {
  if (battleSt.isRandomEncounter && battleSt.encounterMonsters && battleSt.allyTargetIndex >= 0 && battleSt.encounterMonsters[battleSt.allyTargetIndex].hp <= 0) {
    battleSt.dyingMonsterIndices = new Map([[battleSt.allyTargetIndex, 0]]);
    battleSt.battleState = 'monster-death'; battleSt.battleTimer = 0; playSFX(SFX.MONSTER_DEATH);
  } else if (!battleSt.isRandomEncounter && getEnemyHP() <= 0) {
    if (pvpSt.isPVPBattle) {
      // Explicit dying-cell map (was relying on _buildPVPDyingMap lazy fallback).
      const cellIdx = pvpSt.pvpPlayerTargetIdx < 0 ? 0 : pvpSt.pvpPlayerTargetIdx + 1;
      pvpSt.pvpDyingMap = new Map([[cellIdx, 0]]);
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
    // Pre-compute the upcoming hand so we can detect a hand change before committing to it.
    // `isLeftHandHit` encodes the RRLL pattern (v1.7.273): first half
    // of the combo is right-hand, second half left. Single-weapon
    // attackers always strike with the equipped hand.
    const totalHits = battleSt.allyHitResults ? battleSt.allyHitResults.length : 0;
    const willBeLeft = isLeftHandHit(battleSt.allyHitIdx, totalHits, rW, lW);
    const handChange = battleSt.allyHitIdx > 0 && battleSt.allyHitIsLeft !== willBeLeft;
    const delay = handChange ? IDLE_FRAME_MS
                : (allyUnarmed ? 0 : (battleSt.allyHitIdx === 0 ? ALLY_BACK_MS : ALLY_COMBO_PAUSE_MS));
    if (battleSt.battleTimer >= delay) {
      if (battleSt.allyHitIdx === 0) {
        queueBattleMsg(allyNow.name ? _nameToBytes(allyNow.name) : BATTLE_ALLY);
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
        // Pick the weapon for this swing (matches the hand alternation set
        // when the slash kicked off — see _updateAllyAttackBack). Allies use
        // the same wpn-status inflict + wake-on-hit semantics as the player
        // (user-confirmed 2026-05-10; previously gated to player only).
        const ally = battleSt.battleAllies[battleSt.currentAllyAttacker];
        const wpnId = ally
          ? (battleSt.allyHitIsLeft ? ally.weaponL : ally.weaponId)
          : null;
        applyPhysicalHitToEnemy(hit, battleSt.allyTargetIndex, { weaponId: wpnId, attackerIsAlly: true });
        if (battleSt.allyTargetIndex < 0 && pvpSt.isPVPBattle) {
          pvpSt.pvpOpponentShakeTimer = BATTLE_SHAKE_MS;
        }
      }
      // Advance combo
      battleSt.allyHitIdx = battleSt.allyHitIdx + 1;
      if (battleSt.allyHitIdx < battleSt.allyHitResults.length) {
        const nextAlly = battleSt.battleAllies[battleSt.currentAllyAttacker];
        const nrW = nextAlly && isWeapon(nextAlly.weaponId);
        const nlW = nextAlly && isWeapon(nextAlly.weaponL);
        battleSt.allyHitIsLeft = isLeftHandHit(
          battleSt.allyHitIdx, battleSt.allyHitResults.length, nrW, nlW);
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
          battleSt.battleState = battleSt.isRandomEncounter ? 'encounter-box-close' : 'enemy-box-close';
          battleSt.battleTimer = 0;
        } else {
          _processNextTurn();
        }
      } else { battleSt.enemyTargetAllyIdx = -1; _processNextTurn(); }
    }
    return true;
  }
  return false;
}

// ── Ally magic cast pipeline ─────────────────────────────────────────────────
// Mirrors the player magic-cast → magic-hit pipeline byte-for-byte. ALL timings
// derive from `CAST_PHASE_MS_THROW` (cast-anim.js) — same constants the player
// throw path reads — so the four-stage pipeline (cast windup → projectile →
// impact burst → damage number) lines up across all three roles.
//
// Frame timeline for an ally cast on a cross-faction target (offensive):
//   [ally-magic-cast]  0    →  800 ms   cast windup (halo + flame)
//   [ally-magic-hit]   0    →  150 ms   projectile fan caster→target
//                      150  →  700 ms   impact burst on target (550 ms = 8 frames @67ms)
//                      150  ←           damage applies + setSwDmgNum at impact START
//                      700  →  867 ms   ret window (post-impact hold, matches player)
//   [monster-death | next-turn]
//
// Damage number lifetime: setSwDmgNum at hit-phase t=150ms. SW_DMG_SHOW_MS=700,
// so number visible until hit-phase t=850ms — overlaps the ret window cleanly,
// auto-clears via tickDmgNums in updateBattle. No state-transition flicker.
//
const ALLY_MAGIC_CAST_MS   = CAST_PHASE_MS_THROW.buildup;       // 800

// Throw-style timing (offensive Fire / Bzzard / Sleep on enemy) ────────────
// SFX fires at IMPACT START — same rule the player thrown impact-walk uses
// (`spell-cast.js:650`). Without this, FIRE_BOOM / SW_HIT / SLEEP_PUFF would
// fire at damage-apply time = AFTER burst ends, sounding stale.
const ALLY_THROW_SFX_MS    = CAST_PHASE_MS_THROW.projectile +   // 250
                             CAST_PHASE_MS_THROW.preImpactGap;
// Effect (damage) fires AFTER the impact burst + post-impact gap.
// Sequence: cast → projectile → preImpactGap → impact (SFX) → postImpactGap → damage → bounce → stick → end.
const ALLY_THROW_EFFECT_MS = CAST_PHASE_MS_THROW.projectile +   // 900
                             CAST_PHASE_MS_THROW.preImpactGap +
                             CAST_PHASE_MS_THROW.impact +
                             CAST_PHASE_MS_THROW.postImpactGap;
const ALLY_THROW_HIT_MS    = ALLY_THROW_EFFECT_MS + DMG_SHOW_MS;  // 1650

// Heal-style timing (same-team Cure / Poisona on player or ally) ───────────
// No projectile (per the same-team rule). Sparkle is the spell anim.
// Sequence: cast → preImpactGap → sparkle (impact) → postImpactGap → apply
// (heal-num + SFX) → bounce → stick → end. SFX fires at apply time via
// the helper's `opts.sfx` — there's no separate impact-start SFX for heal.
const ALLY_HEAL_EFFECT_MS  = CAST_PHASE_MS_HEAL.preImpactGap +   // 483
                             CAST_PHASE_MS_HEAL.impact +
                             CAST_PHASE_MS_HEAL.postImpactGap;
const ALLY_HEAL_HIT_MS     = ALLY_HEAL_EFFECT_MS + DMG_SHOW_MS;  // 1233

// Spell IDs that route through the heal pipeline (same-team).
function _isAllyMagicHealSpell(spellId) {
  const spell = SPELLS.get(spellId);
  if (!spell) return false;
  return spell.element === 'recovery'
      || spell.target === 'ally'
      || spell.target === 'cure_status'
      || spell.target === 'revive';
}

// Resolve the offensive-cast target object from the ally-magic state.
// Idx convention matches `spell-cast.js:_getEnemyAt`:
//   'enemy'      → encounterMonsters[idx]
//   'pvp-enemy'  → 0 → pvpOpponentStats; 1+ → pvpEnemyAllies[idx - 1]
function _allyMagicEnemyTarget() {
  if (battleSt.allyMagicTargetType === 'enemy') {
    return battleSt.encounterMonsters && battleSt.encounterMonsters[battleSt.allyMagicTargetIdx];
  }
  if (battleSt.allyMagicTargetType === 'pvp-enemy') {
    if (battleSt.allyMagicTargetIdx === 0) return pvpSt.pvpOpponentStats;
    return pvpSt.pvpEnemyAllies && pvpSt.pvpEnemyAllies[battleSt.allyMagicTargetIdx - 1];
  }
  return null;
}

// Set the damage/miss display for an offensive ally cast. Uses `setSwDmgNum`
// (per-target indexed) so the number lands on the actual target slot, not
// on the player's currently-selected enemy. `drawSWDamageNumbers` is the
// renderer; gated to fire during 'ally-magic-hit' as well as 'magic-hit'.
function _setAllyMagicEnemyDmgNum(num) {
  if (battleSt.allyMagicTargetType !== 'enemy' && battleSt.allyMagicTargetType !== 'pvp-enemy') return;
  setSwDmgNum(battleSt.allyMagicTargetIdx, num.value || 0, { miss: !!num.miss });
}

function _applyAllyMagicEffect() {
  const spellId = battleSt.allyMagicSpellId;
  const spell = SPELLS.get(spellId);
  if (!spell) return;

  // Sight has no target — peek the front-row enemy. Erase / dispel likewise.
  if (spell.target === 'sight') { applyMagicSight({ sfx: SFX.SIGHT }); return; }
  if (spell.target === 'erase') { applyMagicErase(); return; }

  // Resolve target object + faction. v1.7.464 — previously this dispatcher
  // only knew six spell IDs (0x31, 0x32, 0x33, 0x34, 0x35, 0x36); every
  // other player-cast spell (Fira / Bzzara / Stone / Confuse / Drain /
  // Catas / Curaja / Raise / etc.) fell through to a default Cure-style
  // heal call, which silently healed enemy targets and mis-applied buffs.
  // Watchers now route through `applySpell` (the same dispatcher the
  // sender uses) so every spell renders correctly on every phone.
  const tType = battleSt.allyMagicTargetType;
  const tIdx  = battleSt.allyMagicTargetIdx;
  const isEnemy = tType === 'enemy' || tType === 'pvp-enemy';
  const isPlayerTgt = tType === 'player';
  let target = null;
  if (isEnemy) target = _allyMagicEnemyTarget();
  else if (isPlayerTgt) target = ps;
  else if (tType === 'ally') target = battleSt.battleAllies[tIdx];
  if (!target) return;

  // Pick amount channel. Heal / cure-status / revive spells ride
  // `healAmount`; everything else rides `damageRoll`. Both pre-rolled by the
  // sender at confirm-pause (v1.7.458 `prerollSpellAmount`).
  const isHeal = spell.element === 'recovery'
    || spell.target === 'cure_status'
    || spell.target === 'revive';
  const amount = isHeal
    ? (battleSt.allyMagicHealAmount | 0)
    : (battleSt.allyMagicDamageRoll | 0);

  // Cure-status spells (Poisona, Esuna, Bndna, etc.) — pick the status
  // flag from `spell.type` the same way the sender does (spell-cast.js:679).
  const statusFlag = spell.target === 'cure_status'
    ? (STATUS_NAME_TO_FLAG[spell.type] || STATUS.POISON)
    : 0;

  // Callbacks per faction. Damage numbers / heal numbers / status messages
  // route to the role-specific renderers; applySpell dispatches the actual
  // mutation.
  const onDmgNum    = isEnemy      ? (dmg) => _setAllyMagicEnemyDmgNum({ value: dmg, timer: 0 }) : null;
  const onHealNum   = !isEnemy     ? makeHealNumCallback(isPlayerTgt ? 'self' : 'ally', tIdx)    : null;
  const onSparkle   = !isEnemy     ? () => onHealNum && onHealNum(0)                              : null;
  const onMiss      = isEnemy      ? () => _setAllyMagicEnemyDmgNum({ miss: true, timer: 0 })    : null;
  const onLand      = isEnemy      ? () => _setAllyMagicEnemyDmgNum({ value: 0, timer: 0 })       : null;

  applySpell(spell, target, {
    amount, statusFlag,
    onDmgNum, onHealNum, onSparkle, onMiss, onLand,
    onStatusMsg: replaceBattleMsg,
  });
}

function _updateAllyMagicCast(dt) {
  if (battleSt.battleState === 'ally-magic-cast') {
    if (battleSt.battleTimer >= ALLY_MAGIC_CAST_MS) {
      battleSt.battleState = 'ally-magic-hit';
      battleSt.battleTimer = 0;
      battleSt.allyMagicEffectApplied = false;
      battleSt.allyMagicSfxPlayed = false;
    }
    return true;
  }
  if (battleSt.battleState === 'ally-magic-hit') {
    tickHealNums(dt);
    // Heal-style and throw-style use different per-phase timings (heal has no
    // projectile + applies later for the sequential pipeline). Pick which
    // timing constants apply by inspecting the active spell once per frame.
    //
    // SFX timing rule (memory `feedback_ff3mmo_sfx_during_spell_anim.md`):
    // every spell fires SFX at SPELL-ANIM START. Throw = impact-burst start;
    // Heal = sparkle-burst start (= preImpactGap into magic-hit). The engine
    // drives both via `playSpellImpactSFX(spell)` which uses the shared
    // selector — helpers never carry SFX.
    const isHeal = _isAllyMagicHealSpell(battleSt.allyMagicSpellId);
    const sfxMs    = isHeal ? CAST_PHASE_MS_HEAL.preImpactGap : ALLY_THROW_SFX_MS;
    const effectMs = isHeal ? ALLY_HEAL_EFFECT_MS : ALLY_THROW_EFFECT_MS;
    const hitMs    = isHeal ? ALLY_HEAL_HIT_MS    : ALLY_THROW_HIT_MS;

    if (!battleSt.allyMagicSfxPlayed && battleSt.battleTimer >= sfxMs) {
      const spell = SPELLS.get(battleSt.allyMagicSpellId);
      if (spell) playSpellImpactSFX(spell);
      battleSt.allyMagicSfxPlayed = true;
    }
    if (!battleSt.allyMagicEffectApplied && battleSt.battleTimer >= effectMs) {
      _applyAllyMagicEffect();
      battleSt.allyMagicEffectApplied = true;
    }
    if (battleSt.battleTimer >= hitMs) {
      clearHealNums();
      // Kill detection — if the offensive cast dropped an enemy to 0 HP,
      // route to the same death state the player cast uses (`spell-cast.js:
      // _finishMagicHit`). Without this the dead enemy sits at 0 HP with
      // no death anim; the encounter never transitions to victory if it was
      // the last living enemy.
      const tgtType = battleSt.allyMagicTargetType;
      const tgtIdx = battleSt.allyMagicTargetIdx;
      let routedToDeath = false;
      if (tgtType === 'enemy' && battleSt.encounterMonsters) {
        const m = battleSt.encounterMonsters[tgtIdx];
        if (m && m.hp <= 0) {
          replaceBattleMsg(BATTLE_SLAIN);
          battleSt.dyingMonsterIndices = new Map([[tgtIdx, 0]]);
          battleSt.battleState = 'monster-death';
          battleSt.battleTimer = 0;
          playSFX(SFX.MONSTER_DEATH);
          routedToDeath = true;
        }
      } else if (tgtType === 'pvp-enemy') {
        const tgt = tgtIdx === 0
          ? pvpSt.pvpOpponentStats
          : pvpSt.pvpEnemyAllies[tgtIdx - 1];
        if (tgt && tgt.hp <= 0) {
          replaceBattleMsg(BATTLE_SLAIN);
          pvpSt.pvpDyingMap = new Map([[tgtIdx, 0]]);
          battleSt.battleState = 'pvp-dissolve';
          battleSt.battleTimer = 0;
          playSFX(SFX.MONSTER_DEATH);
          routedToDeath = true;
        }
      }
      battleSt.allyMagicCasterIdx = -1;
      battleSt.allyMagicTargetIdx = -1;
      battleSt.allyMagicSpellId = 0;
      battleSt.allyMagicItemMode = false;
      if (!routedToDeath) _processNextTurn();
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
          battleSt.battleState = battleSt.isRandomEncounter ? 'encounter-box-close' : 'enemy-box-close';
          battleSt.battleTimer = 0;
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

// Side-channel fade-in tick (v1.7.423+) — drives the fade-down on any
// ally that was instant-added (via co-op invite spawn, assist accept,
// or peer ally-join broadcast). Independent of `battleState` so it works
// during any mid-battle phase without interrupting the FSM. Each ally
// carries `fadeInStartMs` set at push-time; `fadeStep` is derived from
// elapsed time. The classic `_updateAllyJoin` state-machine fade-in still
// drives the `tryJoinPlayerAlly` path; this is parallel for wire-spawned
// peers that bypass that state.
const FADE_IN_PER_STEP_MS = 100;
function _tickAllyFadeIn() {
  const now = Date.now();
  for (const a of battleSt.battleAllies) {
    if (!a || !a.fadeInStartMs) continue;
    const elapsed = now - a.fadeInStartMs;
    const step = ROSTER_FADE_STEPS - Math.floor(elapsed / FADE_IN_PER_STEP_MS);
    a.fadeStep = Math.max(0, step);
    if (a.fadeStep <= 0) { delete a.fadeInStartMs; a.fadeStep = 0; }
  }
}

export function updateBattleAlly(dt) {
  _tickAllyFadeIn();
  // Co-op random encounter — wire-driven ally is waiting for the remote
  // player's `encounter-action` to arrive. processNextTurn unshifted the
  // turn back to the queue head and set this state; each frame we retry
  // by calling processNextTurn — when the action shows up, the ally turn
  // proceeds; otherwise it stalls another frame. v1.7.418.
  //
  // Disconnect timeout (v1.7.419) — if we've been waiting WIRE_WAIT_TIMEOUT_MS
  // (~30s), the peer's WS probably dropped without the server's synthetic
  // disconnect arriving (TCP half-open / cellular loss). Pop the stalled
  // turn, flip the ally to AI-fallback (defend this turn + isWireDriven
  // off so future turns run AI), then advance.
  if (battleSt.battleState === 'ally-wire-wait') {
    // v1.7.471 — peer misses the turn if no wire action arrives in the
    // same window the local player has (TURN_TIME_MS=10s). No auto-defend,
    // no AI fallback — just skip the queue forward. `isWireDriven` stays
    // true so the next turn's wire-wait runs normally if the peer's
    // actions resume. Matches the local "miss your turn" semantics.
    // Pre-v1.7.471: 45s timeout flipped `isWireDriven=false` permanently
    // → fake-AI took over; v1.7.470 tried turn-scoped defend; both wrong.
    const WIRE_WAIT_TIMEOUT_MS = 10000;
    if (battleSt.battleTimer > WIRE_WAIT_TIMEOUT_MS) {
      battleSt.turnQueue.shift();  // drop the unfulfilled turn; no animation, no damage.
      _processNextTurn();
      return true;
    }
    _processNextTurn();
    return true;
  }
  if (_updateAllyJoin()) return true;
  if (_updateAllyAttack()) return true;
  if (_updateAllyMagicCast(dt)) return true;
  if (battleSt.battleState === 'ally-damage-show') { if (battleSt.battleTimer >= 700) _updateAllyDamageShow(); return true; }
  if (_updateAllyEnemyHit()) return true;
  if (_updateAllyKOSequence()) return true;
  return false;
}
