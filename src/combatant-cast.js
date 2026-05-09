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

import { drawCasterCastBehind, drawCasterCastFront } from './cast-anim.js';
import { battleSt } from './battle-state.js';
import { ps } from './player-stats.js';
import { pvpSt } from './pvp.js';
import { getCastAnimElapsedMs, getCurrentSpellId } from './spell-cast.js';

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
