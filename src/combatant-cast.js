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

import { drawCasterCastBehind, drawCasterCastFront, CAST_PHASE_MS_THROW } from './cast-anim.js';
import { battleSt } from './battle-state.js';
import { ps } from './player-stats.js';
import { pvpSt } from './pvp.js';
import { getCastAnimElapsedMs, getCurrentSpellId } from './spell-cast.js';
import { SPELLS } from './data/spells.js';

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
// ally and PVP-enemy single-target offensive casts. The player path has
// extra complexity (multi-target impact-walk, heal-style projectile-during-
// heal-window, item-use skip-windup) and stays in `_drawPlayerSpellTarget-
// SparkleOnEnemy` for now.
//
// Caller passes:
//   role   — 'ally' | 'pvp-enemy'. Identifies which state machine to read.
//   ctx    — render context (typically ui.ctx).
//   caster — { x, y, faction } resolved by caller (per-role layout math).
//   target — { type, index } in the spec _getMagicTargetCenter understands.
export function drawSpellThrow(role, ctx, caster, target) {
  const cfg = _resolveThrowContext(role);
  if (!cfg) return;
  const { ms, spellId, spell } = cfg;
  const projMs = CAST_PHASE_MS_THROW.projectile;
  if (ms < 0) return;
  if (ms < projMs) {
    // Projectile fan from caster center to target — drawProjectileFan handles
    // the cross-faction filter, so caller passes faction explicitly.
    _drawProjectileFan(ctx, caster, [target], spellId, spell, ms / projMs);
    return;
  }
  // Impact burst on target. Sleep / Sight have undefined `kind` bundles —
  // _drawSpellEffectAtTargets is a no-op for those (per spell-anim.js).
  _drawSpellEffectAtTargets(ctx, [target], spellId, ms - projMs);
}

// Imports from battle-drawing.js — used only inside fn bodies, so the cycle
// (battle-drawing → combatant-cast → battle-drawing) resolves lazily at call
// time. The two helpers are pure-render: they take a target spec and draw
// against a canvas context. battle-drawing owns them because they reference
// `_getMagicTargetCenter` which knows about encounter-grid + PVP-cell layout.
import { drawProjectileFan as _drawProjectileFan,
         drawSpellEffectAtTargets as _drawSpellEffectAtTargets } from './battle-drawing.js';

function _resolveThrowContext(role) {
  if (role === 'ally') {
    if (battleSt.battleState !== 'ally-magic-hit') return null;
    const tgtType = battleSt.allyMagicTargetType;
    if (tgtType !== 'enemy' && tgtType !== 'pvp-enemy') return null;
    const spellId = battleSt.allyMagicSpellId;
    if (spellId !== 0x31 && spellId !== 0x32 && spellId !== 0x33) return null;
    const spell = SPELLS.get(spellId);
    if (!spell) return null;
    return { ms: battleSt.battleTimer, spellId, spell };
  }
  if (role === 'pvp-enemy') {
    if (!pvpSt.isPVPBattle) return null;
    if (battleSt.battleState !== 'pvp-enemy-magic-hit') return null;
    if (pvpSt.pvpMagicPartyTargetIdx <= -100) return null;
    const spellId = pvpSt.pvpMagicSpellId;
    if (spellId !== 0x31 && spellId !== 0x32 && spellId !== 0x33) return null;
    const spell = SPELLS.get(spellId);
    if (!spell) return null;
    return { ms: battleSt.battleTimer, spellId, spell };
  }
  return null;
}
