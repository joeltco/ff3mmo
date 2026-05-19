// Co-op viewer animation helpers (P2+, docs/COOP-VIEWER-PLAN.md).
//
// Thin scaffolding module the viewer (`src/coop-viewer.js`, P3) calls to
// drive its anim functions. The original P2 plan called for heavy
// extraction of orchestration code from `battle-update.js` /
// `battle-ally.js`; on audit the existing low-level primitives are
// already pure and shareable:
//
//   - `src/slash-effects.js` — slash overlay frames, SLASH_FRAME_MS,
//     drawSlashOverlay, getSlashPattern. No FSM coupling.
//   - `src/damage-numbers.js` — every damage-num slot setter +
//     ticker. DMG_BOUNCE_MS / DMG_STICK_MS / DMG_SHOW_MS exposed.
//   - `src/spell-anim.js` — per-spell registry (cast / impact /
//     target effect). `getSpellAnim(spellId)` returns the bundle.
//   - `src/music.js` — `playSFX(SFX.X)` is the SFX entry point.
//
// The viewer's anim functions in P3 call these directly. The ONLY
// orchestration the viewer needs is wall-clock advancement + final-
// state write at anim end; both live in `coop-viewer.js` so they
// stay co-located with the queue/dispatch logic.
//
// This file currently re-exports the timing constants the viewer
// consumes for `animMs` calibration, plus a couple of small helpers
// that don't fit anywhere else. Grows as P3+ surface needs.

export {
  SLASH_FRAME_MS,
  SLASH_FRAMES,
  SWING_HOLD_MS,
  getSlashHoldMs,
  getSlashPattern,
  shouldDrawSlash,
  setSlashOffsetForFrame,
  drawSlashOverlay,
} from './slash-effects.js';

export {
  DMG_BOUNCE_MS,
  DMG_STICK_MS,
  DMG_SHOW_MS,
  SW_DMG_SHOW_MS,
  createDmg,
  createMiss,
  createHeal,
  createAllyHeal,
  setSwDmgNum,
  setPlayerDamageNum,
  setPlayerHealNum,
  setEnemyDmgNum,
  getAllyDamageNums,
  resetAllDmgNums,
  tickDmgNums,
} from './damage-numbers.js';

export {
  getSpellAnim,
  getSpellAnimForItem,
  getSpellAnimFrame,
} from './spell-anim.js';

// Monster-death dissolve — viewer triggers via `dyingMonsterIndices` +
// `MONSTER_DEATH_MS`; same primitive the FSM uses. Re-exported here so
// the viewer doesn't reach into battle-update for it.
export const MONSTER_DEATH_MS = 800;  // matches src/battle-update.js MONSTER_DEATH_MS

// Wall-clock anim helper. Used by every viewer anim that wants a simple
// duration-based done check. `state` is the per-anim scratch object the
// viewer threads through tick — we mutate `state.elapsedMs` in place
// rather than allocating each frame.
export function tickElapsed(state, dt, durationMs) {
  state.elapsedMs = (state.elapsedMs | 0) + (dt | 0);
  return state.elapsedMs >= durationMs;
}

// Linear-interp normalized progress, clamped to [0, 1]. Useful for
// anim curves (slash slide, damage-num bounce).
export function easeLinearProgress(elapsedMs, durationMs) {
  if (durationMs <= 0) return 1;
  const p = elapsedMs / durationMs;
  return p < 0 ? 0 : (p > 1 ? 1 : p);
}
