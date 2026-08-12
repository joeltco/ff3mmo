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
         CAST_PHASE_MS_THROW, CAST_T_LUNGE, CAST_T_HEAL_ANIM_START, CAST_T_RETURN, healImpactWindowMs } from './cast-anim.js';
import { battleSt } from './battle-state.js';
import { ps } from './player-stats.js';
import { pvpSt } from './pvp.js';
import { getCastAnimElapsedMs, getCurrentSpellId, getSpellTargets,
         getMagicHitPhase, getSpellHitIdx, isCurrentCastItemUse,
         isCurrentCastFromEquipment } from './spell-cast.js';
import { SPELLS, spellStatusMask } from './data/spells.js';
import { CAPTURED_SPELL_SFX } from './data/spell-sfx-captured.js';
import { elemMultiplier } from './battle-math.js';
import { rand } from './rng.js';
import { dispatchDelta } from './deltas.js';
import { tryInflictStatus, tryInflictStatusByte, removeStatus, addStatus, STATUS, STATUS_NAME_BYTES } from './status-effects.js';
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
    // An equipment cast runs the full timeline but draws NO caster pose — the
    // weapon is doing the magic, not the character. Previously this fell out of
    // `getCastAnimElapsedMs()` returning -1, which also killed the on-target
    // visuals; now the two are separate. v1.7.861.
    if (isCurrentCastFromEquipment()) return null;
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

/**
 * Heal-style spell-anim window for a spell, in ms ELAPSED from cast start.
 *
 * SINGLE SOURCE for the three things that must agree on when a heal-style
 * spell's effect becomes visible: the renderer's impact window (below), the
 * engine's SFX cue, and the engine's screen-shake cue. Before v1.7.851 each
 * computed its own — the renderer off the legacy `CAST_T_HEAL` (1217), the
 * other two off `CAST_PHASE_MS_HEAL` (900) — so on 23 enemy-facing spells the
 * sound and the jolt were 317 ms out of step with the picture.
 *
 * Pure in the spell ID on purpose: the renderer reads mutable battle state,
 * which is what let the last drift ship unnoticed. Being pure, the deploy gate
 * in `tools/encounter-sim.js` can assert the whole schedule directly.
 */
export function healStyleRenderWindow(spellId) {
  return {
    projStart: CAST_T_LUNGE,
    start:     CAST_T_HEAL_ANIM_START,
    end:       CAST_T_HEAL_ANIM_START + healImpactWindowMs(spellId),
  };
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
// ── Spell SFX selector (single source) ─────────────────────────────────────
// Maps a spell to its spell-animation-start SFX. EVERY spell with a spell-anim
// phase has an entry here — heal-style AND throw-style. The engine fires this
// at spell-anim start for both pipelines:
//
// - Throw (Fire, Bzzard, Sleep, Sight): SFX at IMPACT START, syncs with burst.
// - Heal (Cure, Poisona, recovery, cure_status): SFX at SPARKLE START, syncs
//   with the heal-sparkle canvas appearing on the target portrait.
//
// Apply helpers (applyMagicHeal, applyMagicCureStatus, etc.) MUST NOT play
// SFX themselves. The engine is the single source. See memory:
// `feedback_ff3mmo_sfx_during_spell_anim.md` for the rule history.
/**
 * Spell -> impact SFX, as an ORDERED rule table.
 *
 * v1.7.867 — this was an if-chain whose comments dressed picked sounds in the
 * citation style of captured ones: `// NSF $84 — thunder crash` sat directly
 * under `// NSF $82 — REC OAM f1301`. The first is a track number plus my
 * description of what it sounds like; the second is a real capture. Making the
 * provenance a FIELD means a guess can no longer be mistaken for data, and the
 * deploy gate can count how much of the catalogue is actually sourced.
 *
 * WHY THIS FILE CARRIES A WARNING: the v1.7.847 "SFX sweep" that produced the
 * picked entries below checked only that no spell was SILENT — never that the
 * sound was RIGHT — and shipped 23 spells playing Fire's captured impact,
 * Meteo among them. The sweep table it generated printed Meteo and Fire with
 * the same SFX number on adjacent rows and nobody read it. Presence is not
 * correctness. See docs/SWEEP-DISCIPLINE.md before touching this table or
 * declaring any audit of it complete.
 *
 * `src`:
 *   'captured' — traced from a REC OAM / `$Cx` write capture. Real data. Do not
 *                change these without a new capture.
 *   'picked'   — a plausible existing NSF track chosen to suit the element or
 *                the spell family. NOT canon, and not claimed to be. Free to
 *                replace the moment a capture exists.
 *
 * Order is load-bearing and matches the original chain exactly: fire before
 * ice before bolt, so `['bolt','ice']` resolves as ice regardless of array order.
 */
export const SPELL_SFX_RULES = [
  // v1.7.869 — the CAPTURED table comes first, because it is measured data and
  // everything below it is not. 42 of 48 castable spells now have their real
  // impact sound, traced from $7F49 writes by `tools/monscan/spell-sweep.cjs`.
  // Two of the picks below were simply wrong and this replaces them: Quake is
  // 131, not EARTHQUAKE 153; Aero2 is 134, not its ice component's 93.
  { id: 'captured-table', src: 'captured', ref: 'tools/monscan/spell-sweep.cjs $7F49 trace',
    match: (s2) => CAPTURED_SPELL_SFX.has(_spellIdOf(s2)),
    sfxFor: (s2) => CAPTURED_SPELL_SFX.get(_spellIdOf(s2)) },
  { id: 'sight',       src: 'picked',   sfx: SFX.SIGHT,           match: (s)     => s.target === 'sight' },
  { id: 'fire',        src: 'captured', ref: 'REC OAM f1301',     sfx: SFX.FIRE_BOOM,       match: (s, e) => e.includes('fire') },
  { id: 'ice',         src: 'captured', ref: 'REC OAM f766',      sfx: SFX.SW_HIT,          match: (s, e) => e.includes('ice') },
  { id: 'bolt',        src: 'picked',   sfx: SFX.CRYSTAL_THUNDER, match: (s, e) => e.includes('bolt') },
  { id: 'earth',       src: 'picked',   sfx: SFX.EARTHQUAKE,      match: (s, e) => e.includes('earth') },
  { id: 'air',         src: 'picked',   sfx: SFX.FALL,            match: (s, e) => e.includes('air') },
  { id: 'sleep',       src: 'captured', ref: 'REC OAM sleep-emu-snap', sfx: SFX.SLEEP_PUFF, match: (s)  => s.type === 'sleep' },
  { id: 'heal-family', src: 'picked',   sfx: SFX.CURE,            match: (s, e) => e.includes('recovery')
                          || s.target === 'cure_status' || s.target === 'ally' || s.target === 'revive' },
  // The generic tail. v1.7.847 made this FIRE_BOOM — Fire's own captured
  // impact — so 23 element-less spells played Fire's signature, Meteo among
  // them. A fallback must be neutral; SW_HIT is what it was before.
  { id: 'fallback-damage', src: 'picked', sfx: SFX.SW_HIT,     match: (s) => s.type === 'damage' || s.type === 'death' },
  { id: 'fallback-status', src: 'picked', sfx: SFX.SLEEP_PUFF, match: () => true },
];

// Catalogue id for a spell OBJECT, by identity. Callers pass the entry, not the
// id, and changing every call site to thread one through would be a wider edit
// than this needs. A summon's rewritten effect-spell is deliberately absent
// from this map, so it falls through to the picked rules rather than borrowing
// the base spell's captured sound.
let _idBySpell = null;
function _spellIdOf(spell) {
  if (!_idBySpell) { _idBySpell = new Map(); for (const [id, sp] of SPELLS) _idBySpell.set(sp, id); }
  return _idBySpell.get(spell);
}

/** Element as a component list, whatever shape the entry uses (array | string | null). */
/**
 * Every LIVING enemy index on the given side, in the index convention that
 * `spell-cast.js:_getEnemyAt`, `battle-ally.js` and `pvp.js` all already share:
 *
 *   'enemy'     -> battleSt.encounterMonsters[i]
 *   'pvp-enemy' -> 0 is pvpSt.pvpOpponentStats; 1+ is pvpEnemyAllies[i - 1]
 *
 * Lives here because ally-cast and PVP-cast both need it and it must not be
 * written twice — two copies of "who is alive" is exactly the kind of split
 * that drifts. The player path builds the same set inline while resolving its
 * own targetSpec, so this is the second and last implementation, not a third.
 */
export function livingEnemyIndices(targetType) {
  const out = [];
  if (targetType === 'enemy') {
    const ms = battleSt.encounterMonsters || [];
    for (let i = 0; i < ms.length; i++) if (ms[i] && ms[i].hp > 0) out.push(i);
    return out;
  }
  if (targetType === 'pvp-enemy') {
    if (pvpSt.pvpOpponentStats && pvpSt.pvpOpponentStats.hp > 0) out.push(0);
    const as = pvpSt.pvpEnemyAllies || [];
    for (let i = 0; i < as.length; i++) if (as[i] && as[i].hp > 0) out.push(i + 1);
    return out;
  }
  return out;
}

/** The combatant object at an enemy index, same convention as above. */
export function enemyAtIndex(targetType, idx) {
  if (targetType === 'enemy') return (battleSt.encounterMonsters || [])[idx] || null;
  if (targetType === 'pvp-enemy') {
    if (idx === 0) return pvpSt.pvpOpponentStats || null;
    return (pvpSt.pvpEnemyAllies || [])[idx - 1] || null;
  }
  return null;
}

export function spellElementParts(spell) {
  const el = spell && spell.element;
  return Array.isArray(el) ? el : (typeof el === 'string' ? el.split(',') : []);
}

/** The rule that decides this spell's impact sound — sound AND provenance. */
export function spellSfxRule(spell) {
  if (!spell) return null;
  const parts = spellElementParts(spell);
  for (const r of SPELL_SFX_RULES) if (r.match(spell, parts)) return r;
  return null;
}

/** Resolve a rule to a concrete SFX for this spell (table rules are per-id). */
function _sfxOf(rule, spell) { return rule.sfxFor ? rule.sfxFor(spell) : rule.sfx; }

export function getSpellImpactSFX(spell) {
  const r = spellSfxRule(spell);
  return r ? _sfxOf(r, spell) : null;
}

// Plays the impact SFX for a spell. One call site for all three role engines.
// No-op for non-thrown spells (returns null from selector).
export function playSpellImpactSFX(spell) {
  const sfx = getSpellImpactSFX(spell);
  if (sfx != null) playSFX(sfx);
}

// ── Unified spell-effect dispatcher ──────────────────────────────────────
// Single entry point for ALL spell effect application. Dispatches by spell
// shape (target / element / type) to the right helper. Each role calls this
// with role-specific `opts` (target object + I/O callbacks + pre-rolled
// amount + isUndead flag for drain/recovery). Eliminates the per-role inline
// switch statements that were keying off spell IDs.
//
// Caller responsibility: resolve `target` from role state, build `opts` with
// the role's I/O bindings (onDmgNum / onHealNum / onShake / etc.), pass the
// pre-rolled `opts.amount` if the spell is amount-based (damage / heal /
// drain / recovery).
export function applySpell(spell, target, opts = {}) {
  if (!spell) return;
  // Sight — no target needed.
  if (spell.target === 'sight') {
    applyMagicSight(opts);
    return;
  }
  // Erase — no target needed.
  if (spell.target === 'erase') {
    applyMagicErase(opts);
    return;
  }
  if (!target) return;
  // enemy_status — death / all_status / single status name.
  if (spell.target === 'enemy_status') {
    if (spell.type === 'death') {
      applyMagicInstakill(target, spell.hit, opts);
      return;
    }
    if (spell.type === 'all_status') {
      applyMagicAllStatus(target, spell.hit, opts);
      return;
    }
    applyMagicStatus(target, spell.type, spell.hit, opts);
    return;
  }
  // Drain — damage target + heal caster, undead reverses.
  if (spell.target === 'drain') {
    applyMagicDrain(target, opts.amount || 0, opts);
    return;
  }
  // Cure-status — Poisona / Antidote / Heal / Soft.
  if (spell.target === 'cure_status') {
    // Callers may pass an explicit flag; otherwise take the spell's own mask.
    applyMagicCureStatus(target, opts.statusFlag != null ? opts.statusFlag : spellStatusMask(spell), opts);
    return;
  }
  // Toggle-status — Toad / Mini. v1.7.855: this target had NO branch anywhere,
  // in this dispatcher or in spell-cast's enemy path, so both spells fell all
  // the way through to `applyMagicDamage` — Toad cast on an enemy dealt damage
  // instead of transforming it, and cast on an ally it DAMAGED YOUR OWN PARTY.
  if (spell.target === 'toggle_status') {
    applyMagicToggleStatus(target, spellStatusMask(spell), spell.hit, opts);
    return;
  }
  // Recovery — heal non-undead, damage undead.
  if (spell.element === 'recovery') {
    applyMagicRecovery(target, opts.amount || 0, opts);
    return;
  }
  // Default: damage spell (Fire / Bzzard / Bolt / etc.).
  applyMagicDamage(target, opts.amount || 0, spell, opts);
}

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
//
// Hit-check is internal (v1.7.466): spells with `hit > 0 && hit < 100` and
// `element !== 'recovery'` roll one `rand() * 100 >= spell.hit`. Pre-fix the
// sender did this roll in `spell-cast.js#_applyEnemyEffect` and the watcher
// skipped it entirely — sender consumed +1 rand per hit<100 damage cast, so
// every subsequent rand() (monster AI, status inflict, AI ally activation)
// read a different value on the two phones until the next round-boundary
// reseed. Both roles now route through here so they consume identical rand
// counts; only the round reseed can reset cursor alignment.
export function applyMagicDamage(target, baseDmg, spell, opts = {}) {
  if (!target || target.hp <= 0) return 0;
  if (spell && spell.hit > 0 && spell.hit < 100 && spell.element !== 'recovery') {
    if (rand() * 100 >= spell.hit) {
      if (opts.onMiss) opts.onMiss();
      return 0;
    }
  }
  const eMult = elemMultiplier(spell.element, target.weakness, target.resist);
  const mdef = target.mdef || 0;
  const dmg = Math.max(1, Math.floor(baseDmg * eMult) - mdef);
  // P11 (v1.7.494): removed guest short-circuit — viewer mode bypasses
  // the guest FSM entirely, so this function only runs on the host.
  dispatchDelta({ type: 'hp', target, amount: -dmg, source: opts.source });
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
  dispatchDelta({ type: 'hp', target, amount: realHeal, source: opts.source });
  if (opts.onHealNum) opts.onHealNum(realHeal);
  if (opts.sfx) playSFX(opts.sfx);
  return realHeal;
}

// Strip a status flag from target (Poisona, Antidote). `statusFlag` is one of
// the STATUS bitmask flags. Returns true if the flag was set + removed.
export function applyMagicCureStatus(target, statusFlag, opts = {}) {
  if (!target || !target.status) return false;
  const wasSet = !!(target.status.mask & statusFlag);
  dispatchDelta({ type: 'statusRemove', target, flag: statusFlag, source: opts.source });
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
  dispatchDelta({ type: 'hp', target, amount: -dmg, source: opts.source });
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
    dispatchDelta({ type: 'hp', target, amount: -dmg, source: opts.source });
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
  // hit 0 = no roll, guaranteed — same reading as applyMagicDamage and
  // tryInflictStatus. Two death spells (0x10 and Exit) carry hit 0 and could
  // never land while this read it as 0%. See status-effects.js. v1.7.855.
  if (!(hitChance > 0) || rand() * 100 < hitChance) {
    dispatchDelta({ type: 'death', target, source: opts.source });
    if (opts.onDmgNum) opts.onDmgNum(0);
    if (opts.sfx) playSFX(opts.sfx);
    if (opts.onKill) opts.onKill();
    return true;
  }
  if (opts.onMiss) opts.onMiss();
  return false;
}

/**
 * Toggle-status (Toad 0x2e, Mini 0x2f) — target byte 0x07.
 *
 * Cast on an unaffected target it tries to inflict; cast on an already-affected
 * one it cures. That is what the generator's own target table has always called
 * this byte, and it is why the spells are their own family rather than sharing
 * `enemy_status`. Returns the applied flags, or -1 when the cast cured.
 *
 * Resist is honoured on the inflict half — every other inflict path in the game
 * passes it, and this must not become the exception.
 */
export function applyMagicToggleStatus(target, statusMask, hitChance, opts = {}) {
  if (!target || !target.status || !statusMask) return 0;
  if (target.status.mask & statusMask) {
    applyMagicCureStatus(target, statusMask, opts);
    return -1;
  }
  const applied = tryInflictStatusByte(target.status, statusMask, hitChance, target.statusResist || 0);
  if (applied) {
    if (opts.sfx) playSFX(opts.sfx);
    if (opts.onLand) opts.onLand(applied);
  } else if (opts.onMiss) {
    opts.onMiss();
  }
  return applied;
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
  if (isCurrentCastItemUse() && !isCurrentCastFromEquipment()) {
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
  // v1.7.851 — this branch anchored on CAST_T_HEAL (1217, from the LEGACY
  // CAST_PHASE_MS model) while the engine schedules the whole heal-style
  // pipeline off CAST_PHASE_MS_HEAL, whose anim start is CAST_T_HEAL_ANIM_START
  // (900). The burst therefore drew 1217..1500 while the SFX cue fired at 900
  // and the damage number popped at 1283 — sound 317 ms before anything
  // appeared, then the number landing 66 ms INTO the burst with the burst still
  // drawing 217 ms after it. That is the exact overlap the sequential-pipeline
  // rule forbids, on all 23 enemy-facing heal-style spells.
  //
  // Anchored here, the schedule closes exactly: burst 900..900+window, the
  // engine's postImpactGap of 100, then apply at CAST_T_HEAL_APPLY + the same
  // `_animExtraMs` stretch — 100 ms of clean gap for a 283 ms sparkle, for
  // Meteo's 1071 ms sweep and for Kill's 1819 ms alike. The ally + PVP heal
  // paths (battle-ally.js, battle-draw-allies.js) already used this anchor;
  // the player was the last one on the legacy constant.
  const w = healStyleRenderWindow(spellId);
  if (cureMs < w.start) {
    return { phase: 'projectile', targets: enemyTargets, t01: (cureMs - w.projStart) / (w.start - w.projStart), spellId, spell };
  }
  // Window is the sparkle length OR the captured animation's own length,
  // whichever is longer — same helper the engine sizes magic-hit with, so the
  // draw cannot outlive the state or stop before the animation finishes.
  if (cureMs < w.end) {
    return { phase: 'impact', targets: enemyTargets, impactMs: cureMs - w.start, spellId, spell };
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

