// combatant-cast.js — single source of truth for cast-windup rendering
// across all three roles (player / roster ally / PVP enemy). Each role's
// render site calls `drawCastWindup(layer, ctx, role, idx, x, y, mirror)`;
// the helper resolves role-specific state (battleState, casterIdx, spellId,
// jobIdx, elapsed) and dispatches to `drawCasterCastBehind/Front` from
// cast-anim.js.
//
// Why this exists: between v1.7.150 and v1.7.166 the ally cast had three
// different render shapes (parallel `_drawAllyCastAnim*` helpers, then
// pre/post-clip passes, then inline-with-clip), drifting from the player's
// inline pattern at every revision. v1.7.166 removed the panel clip + made
// ally inline-identical to player. v1.7.167 lifts that pattern into ONE
// function so the player + ally + PVP enemy paths are literally the same
// code — only the (role, idx) input differs.

import { drawCasterCastBehind, drawCasterCastFront,
         CAST_PHASE_MS_THROW, CAST_T_LUNGE, CAST_T_HEAL, CAST_T_RETURN } from './cast-anim.js';
import { battleSt } from './battle-state.js';
import { ps } from './player-stats.js';
import { pvpSt } from './pvp.js';
import { getCastAnimElapsedMs, getCurrentSpellId, getSpellTargets,
         getMagicHitPhase, getSpellHitIdx, isCurrentCastItemUse } from './spell-cast.js';
import { SPELLS } from './data/spells.js';
import { elemMultiplier } from './battle-math.js';
import { tryInflictStatus, removeStatus, addStatus, STATUS, STATUS_NAME_BYTES } from './status-effects.js';
import { playSFX, SFX } from './music.js';

// Resolve role-specific cast context. Returns { jobIdx, spellId, elapsed }
// or null if this role is not currently casting (or doesn't match `idx`).
//
// `idx` semantics by role:
//   'player'      → ignored (always 0).
//   'ally'        → row index in battleSt.battleAllies. Only the casting ally
//                   matches; other rows skip.
//   'pvp-enemy'   → cell index (0 = main opponent, 1+ = pvpEnemyAllies[i-1]).
function _resolveCastContext(role, idx) {
  if (role === 'player') {
    if (battleSt.battleState !== 'magic-cast') return null;
    const elapsed = getCastAnimElapsedMs();
    if (elapsed < 0) return null;
    return { jobIdx: ps.jobIdx, spellId: getCurrentSpellId(), elapsed };
  }
  if (role === 'ally') {
    if (battleSt.battleState !== 'ally-magic-cast') return null;
    if (battleSt.allyMagicItemMode) return null;
    if (battleSt.allyMagicCasterIdx !== idx) return null;
    const ally = battleSt.battleAllies[idx];
    if (!ally) return null;
    return { jobIdx: ally.jobIdx || 0, spellId: battleSt.allyMagicSpellId, elapsed: battleSt.battleTimer };
  }
  if (role === 'pvp-enemy') {
    if (battleSt.battleState !== 'pvp-enemy-magic-cast') return null;
    if (pvpSt.pvpMagicCasterCellIdx !== idx) return null;
    const opp = idx === 0 ? pvpSt.pvpOpponent : (pvpSt.pvpEnemyAllies[idx - 1] || null);
    if (!opp) return null;
    return { jobIdx: opp.jobIdx || 0, spellId: pvpSt.pvpMagicSpellId, elapsed: battleSt.battleTimer };
  }
  return null;
}

// Single entry point. `layer` is 'behind' (BM halo, before portrait) or 'front'
// (WM stars / BM flame, after portrait). Caller passes the portrait center
// (x, y) and `mirror` for face-right combatants (PVP enemy uses true).
export function drawCastWindup(layer, ctx, role, idx, x, y, mirror = false) {
  const c = _resolveCastContext(role, idx);
  if (!c) return;
  const fn = layer === 'behind' ? drawCasterCastBehind : drawCasterCastFront;
  fn(ctx, x, y, c.jobIdx, c.spellId, c.elapsed, mirror);
}

// Spell throw animation (projectile fan → impact burst). Single helper for
// ALL three roles: player, ally, PVP-enemy. Resolver handles the role-specific
// flows internally; renderer is two branches (projectile / impact).
//
// Player flows: 1) item-use (skip projectile, single-target impact at hit-idx);
//               2) thrown (parallel projectile fan + serial impact-walk);
//               3) heal-style (projectile during heal-window, impact during
//                  heal window, both targeting all enemy targets in parallel).
// Ally / PVP-enemy: single-target throw (projectile then impact, simple split).
//
// Caller passes:
//   role   — 'player' | 'ally' | 'pvp-enemy'. Identifies which state machine.
//   ctx    — render context.
//   caster — { x, y, faction } resolved by caller (per-role layout math).
//   target — { type, index }. For player, pass null — resolver derives from
//            getSpellTargets() filtered to enemy faction.
export function drawSpellThrow(role, ctx, caster, target) {
  const r = _resolveThrowRender(role, caster, target);
  if (!r) return;
  if (r.phase === 'projectile') {
    _drawProjectileFan(ctx, caster.x, caster.y, caster.faction, r.targets, r.spellId, r.spell, r.t01);
    return;
  }
  // r.phase === 'impact'
  _drawSpellEffectAtTargets(ctx, r.targets, r.spellId, r.impactMs);
}

// Returns { phase, targets, t01? | impactMs?, spellId, spell } or null.
function _resolveThrowRender(role, caster, target) {
  if (role === 'player') return _resolvePlayerThrow(caster);
  if (role === 'ally') return _resolveSimpleThrow('ally', target);
  if (role === 'pvp-enemy') return _resolveSimpleThrow('pvp-enemy', target);
  return null;
}

// Single-target throw with simple projectile/impact split. Used by ally + PVP-enemy.
// Time reference: battleSt.battleTimer (resets on state entry).
// ── Shared damage / status application ─────────────────────────────────────
//
// Three roles applied Fire / Bzzard / Sleep effects with copy-paste-similar
// code: roll damage with element multiplier + mdef, decrement HP, set damage
// number, play SFX. Sleep used `tryInflictStatus` with the same hit + resist
// pattern in all three. Lifted into shared helpers; each role passes its own
// damage-number / shake / status-msg callbacks.

// Apply Fire / Bzzard damage to an enemy target. Pre-rolled `baseDmg` from
// the role-specific damage roller (player uses `_rollMagicAmount`, ally/PVP
// use `*MagicDamageRoll`). Returns the actual damage dealt (post-mult/mdef).
export function applyMagicDamage(target, baseDmg, spell, opts = {}) {
  if (!target || target.hp <= 0) return 0;
  const eMult = elemMultiplier(spell.element, target.weakness, target.resist);
  const mdef = target.mdef || 0;
  const dmg = Math.max(1, Math.floor(baseDmg * eMult) - mdef);
  target.hp = Math.max(0, target.hp - dmg);
  if (opts.onDmgNum) opts.onDmgNum(dmg);
  if (opts.onShake) opts.onShake();
  if (opts.sfx) playSFX(opts.sfx);
  if (target.hp <= 0 && opts.onKill) opts.onKill();
  return dmg;
}

// Heal target by `amount`, clamped to maxHP. Returns actual heal dealt.
// Works on `ps` (player), `battleAllies[i]`, `pvpEnemyAllies[i]`, encounter
// monster — any object with `hp` + optional `maxHP` or `stats.maxHP`.
export function applyMagicHeal(target, amount, opts = {}) {
  if (!target) return 0;
  const maxHP = target.maxHP || (target.stats && target.stats.maxHP) || target.hp || 0;
  const realHeal = Math.min(amount, maxHP - (target.hp || 0));
  target.hp = (target.hp || 0) + realHeal;
  if (opts.onHealNum) opts.onHealNum(realHeal);
  if (opts.sfx) playSFX(opts.sfx);
  return realHeal;
}

// Strip a status flag from target (Poisona, Antidote). `statusFlag` is one of
// the STATUS bitmask flags. Returns true if the flag was set + removed.
export function applyMagicCureStatus(target, statusFlag, opts = {}) {
  if (!target || !target.status) return false;
  const wasSet = !!(target.status.mask & statusFlag);
  removeStatus(target.status, statusFlag);
  if (opts.onSparkle) opts.onSparkle();
  if (opts.sfx) playSFX(opts.sfx);
  return wasSet;
}

// Sight no-op: ineffective msg + impact SFX. Same shape across all three roles
// (player + ally + PVP-enemy each had inline branches doing the same thing).
export function applyMagicSight(opts = {}) {
  if (opts.onIneffectiveMsg) opts.onIneffectiveMsg();
  if (opts.sfx) playSFX(opts.sfx);
}

// Drain — damage target + heal caster by the same amount. Undead reverses
// (heals target, no caster heal — NES canon). Caller provides target dmg-num,
// shake, and caster-heal callbacks. Returns the actual damage dealt (or
// healed-on-undead value).
export function applyMagicDrain(target, amount, opts = {}) {
  if (!target || target.hp <= 0) return 0;
  if (opts.isUndead) {
    return applyMagicHeal(target, amount, { sfx: SFX.CURE, onHealNum: opts.onTargetHealNum });
  }
  const dmg = Math.max(1, amount);
  target.hp = Math.max(0, target.hp - dmg);
  if (opts.onTargetDmgNum) opts.onTargetDmgNum(dmg);
  if (opts.onShake) opts.onShake();
  if (opts.onCasterHeal) opts.onCasterHeal(dmg);
  if (opts.sfx) playSFX(opts.sfx);
  if (target.hp <= 0 && opts.onKill) opts.onKill();
  return dmg;
}

// Recovery — heal non-undead, damage undead. Player Cure on enemy. Caller
// indicates `opts.isUndead`. SFX defaults: heal=CURE, damage=SW_HIT.
export function applyMagicRecovery(target, amount, opts = {}) {
  if (!target || target.hp <= 0) return 0;
  if (opts.isUndead) {
    const dmg = Math.max(1, amount);
    target.hp = Math.max(0, target.hp - dmg);
    if (opts.onDmgNum) opts.onDmgNum(dmg);
    if (opts.onShake) opts.onShake();
    playSFX(opts.damageSfx || SFX.SW_HIT);
    if (target.hp <= 0 && opts.onKill) opts.onKill();
    return dmg;
  }
  return applyMagicHeal(target, amount, { sfx: opts.healSfx || SFX.CURE, onHealNum: opts.onHealNum });
}

// All-status (Shade, Tranquilizer) — try every "major" debuff against target,
// each rolled independently against `hitChance`. `opts.candidates` lets caller
// override the default list. Calls `onStatusLand(flag)` per landed status so
// caller can queue per-status battle messages. Returns the OR'd applied mask.
export function applyMagicAllStatus(target, hitChance, opts = {}) {
  if (!target || !target.status) return 0;
  const candidates = opts.candidates || ['paralysis', 'blind', 'silence', 'sleep', 'confuse'];
  const resist = target.statusResist || 0;
  let anyApplied = 0;
  for (const name of candidates) {
    const f = tryInflictStatus(target.status, name, hitChance, resist);
    if (f) {
      anyApplied |= f;
      if (opts.onStatusLand) opts.onStatusLand(f);
    }
  }
  if (anyApplied) {
    if (opts.sfx) playSFX(opts.sfx);
  } else if (opts.onMiss) {
    opts.onMiss();
  }
  return anyApplied;
}

// Instakill (Death) — `hitChance` roll. On land, sets HP to 0 and applies the
// DEATH status flag. Caller provides death-anim trigger via `onKill` (typical:
// trigger monster-death state / ally.deathTimer / pvp-dissolve).
export function applyMagicInstakill(target, hitChance, opts = {}) {
  if (!target || target.hp <= 0) return false;
  if (Math.random() * 100 < hitChance) {
    if (target.status) addStatus(target.status, STATUS.DEATH);
    target.hp = 0;
    if (opts.onDmgNum) opts.onDmgNum(0);
    if (opts.sfx) playSFX(opts.sfx);
    if (opts.onKill) opts.onKill();
    return true;
  }
  if (opts.onMiss) opts.onMiss();
  return false;
}

// Erase — clear positive statuses / buffs. Currently SFX-only since monster
// buff state isn't tracked yet; helper is forward-compatible (future buff
// state would clear here via opts.target.buffs).
export function applyMagicErase(opts = {}) {
  if (opts.sfx) playSFX(opts.sfx);
}

// Try to inflict a status (Sleep, etc.) on a target. Returns the applied
// status flag (truthy) on land, 0 on miss.
export function applyMagicStatus(target, statusName, hitChance, opts = {}) {
  if (!target || !target.status) return 0;
  const resist = target.statusResist || 0;
  const applied = tryInflictStatus(target.status, statusName, hitChance, resist);
  if (applied) {
    if (opts.sfx) playSFX(opts.sfx);
    if (opts.onStatusMsg && STATUS_NAME_BYTES[applied]) opts.onStatusMsg(STATUS_NAME_BYTES[applied]);
    if (opts.onLand) opts.onLand(applied);
    return applied;
  }
  if (opts.onMiss) opts.onMiss();
  return 0;
}

function _resolveSimpleThrow(role, target) {
  if (!target) return null;
  let stateName, spellId;
  if (role === 'ally') {
    if (battleSt.battleState !== 'ally-magic-hit') return null;
    const tgtType = battleSt.allyMagicTargetType;
    if (tgtType !== 'enemy' && tgtType !== 'pvp-enemy') return null;
    spellId = battleSt.allyMagicSpellId;
    stateName = 'ally-magic-hit';
  } else {
    if (!pvpSt.isPVPBattle) return null;
    if (battleSt.battleState !== 'pvp-enemy-magic-hit') return null;
    if (pvpSt.pvpMagicPartyTargetIdx <= -100) return null;
    spellId = pvpSt.pvpMagicSpellId;
    stateName = 'pvp-enemy-magic-hit';
  }
  if (spellId !== 0x31 && spellId !== 0x32 && spellId !== 0x33) return null;
  const spell = SPELLS.get(spellId);
  if (!spell) return null;
  const ms = battleSt.battleTimer;
  if (ms < 0) return null;
  const projMs = CAST_PHASE_MS_THROW.projectile;
  const preGap = CAST_PHASE_MS_THROW.preImpactGap;
  const impactMs = CAST_PHASE_MS_THROW.impact;
  // Phase split: projectile → gap (no render) → impact → gap (no render, dmg pops here) → ret.
  if (ms < projMs) return { phase: 'projectile', targets: [target], t01: ms / projMs, spellId, spell };
  if (ms < projMs + preGap) return null;
  if (ms < projMs + preGap + impactMs) return { phase: 'impact', targets: [target], impactMs: ms - projMs - preGap, spellId, spell };
  return null;
}

// Player throw — three flows resolved off the same getter set as the legacy
// `_drawPlayerSpellTargetSparkleOnEnemy`. Caster position is the player
// portrait center; caller passes it via the `caster` arg.
function _resolvePlayerThrow(_caster) {
  if (battleSt.battleState !== 'magic-hit') return null;
  const targets = getSpellTargets();
  if (!targets || targets.length === 0) return null;
  const enemyTargets = targets.filter(t => t.type === 'enemy');
  if (enemyTargets.length === 0) return null;
  const spellId = getCurrentSpellId();
  const spell = SPELLS.get(spellId);
  if (!spell) return null;
  // Item-use (battle items routed via animSpellId): skip cast windup AND
  // projectile, go straight to impact at the current hit-walk target.
  if (isCurrentCastItemUse()) {
    const idx = Math.min(getSpellHitIdx(), enemyTargets.length - 1);
    if (idx < 0) return null;
    return { phase: 'impact', targets: [enemyTargets[idx]], impactMs: battleSt.battleTimer, spellId, spell };
  }
  // Thrown spell (cross-faction damage + sight + thrown status). Engine
  // reports phase via `getMagicHitPhase()`; battleTimer resets per per-target
  // window during 'impact-walk', so we use it directly for the burst clock.
  const isThrown = spell.target === 'sight'
                || spell.element === 'fire'
                || spell.element === 'ice'
                || spell.element === 'bolt'
                || spell.type === 'sleep';
  if (isThrown) {
    const phase = getMagicHitPhase();
    if (phase === 'projectile') {
      // Projectile phase lasts `projectile + preImpactGap` ms in the engine.
      // The fan renders for the first `projectile` ms (drawProjectileFan
      // bails on t01 > 1 anyway, but explicit gate is clearer).
      if (battleSt.battleTimer >= CAST_PHASE_MS_THROW.projectile) return null;
      return { phase: 'projectile', targets: enemyTargets, t01: battleSt.battleTimer / CAST_PHASE_MS_THROW.projectile, spellId, spell };
    }
    // 'impact-walk': battleTimer resets per-target. Burst plays for `impact` ms,
    // then post-impact gap (no render), then damage applies + hold (no burst).
    if (battleSt.battleTimer >= CAST_PHASE_MS_THROW.impact) return null;
    const idx = Math.min(getSpellHitIdx(), enemyTargets.length - 1);
    if (idx < 0) return null;
    return { phase: 'impact', targets: [enemyTargets[idx]], impactMs: battleSt.battleTimer, spellId, spell };
  }
  // Heal-style (Cure on undead, etc.) — projectile during the heal window,
  // impact during the heal window. Same parallel-target pattern player has
  // used since v1.7.x; engine elapsed via getCastAnimElapsedMs.
  const cureMs = getCastAnimElapsedMs();
  if (cureMs < CAST_T_LUNGE) return null;
  if (cureMs < CAST_T_HEAL) {
    const projWindow = CAST_T_HEAL - CAST_T_LUNGE;
    return { phase: 'projectile', targets: enemyTargets, t01: (cureMs - CAST_T_LUNGE) / projWindow, spellId, spell };
  }
  if (cureMs < CAST_T_RETURN) {
    return { phase: 'impact', targets: enemyTargets, impactMs: cureMs - CAST_T_HEAL, spellId, spell };
  }
  return null;
}

// Imports from battle-drawing.js — used only inside fn bodies, so the cycle
// (battle-drawing → combatant-cast → battle-drawing) resolves lazily at call
// time. The two helpers are pure-render: they take a target spec and draw
// against a canvas context. battle-drawing owns them because they reference
// `_getMagicTargetCenter` which knows about encounter-grid + PVP-cell layout.
import { drawProjectileFan as _drawProjectileFan,
         drawSpellEffectAtTargets as _drawSpellEffectAtTargets } from './battle-drawing.js';

