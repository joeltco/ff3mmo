// Player buff system — foundation for Haste / Protect / Reflect.
//
// **Scope (v0):** player-only, battle-bound. Buffs reset at the start of every
// battle via `resetBattleVars` so a Haste from the previous fight doesn't
// carry over and unbalance the next encounter. FF3 NES canon is also
// per-battle for these three (technically Reflect ~10 turns; for v0 we treat
// it as battle-bound and add turn-decay later).
//
// **Storage shape:** a combatant's `buffs` field is a plain object,
//   `{ haste?: true, protect?: true, reflect?: true }`. Boolean values
//   only — no metadata yet. The next iteration adds `turnsLeft` for
//   Reflect's decay timer; the helpers below will keep the same surface.
//
// **Roadmap (deferred, NOT shipped here):**
//   - Per-ally buffs: `battleAllies[i].buffs`
//   - PVP-enemy buffs: `pvpSt.pvpOpponentStats.buffs` + `pvpEnemyAllies[i].buffs`
//   - Encounter-monster buffs: `battleSt.encounterMonsters[i].buffs`
//   - Reflect spell-bouncing (target retargeting in spell-cast)
//   - Turn-decay for Reflect (~10 turns)
//   - Buff icons on portraits (visual indicator above sprite)

export const BUFF_HASTE   = 'haste';
export const BUFF_PROTECT = 'protect';
export const BUFF_REFLECT = 'reflect';

export const ALL_BUFFS = [BUFF_HASTE, BUFF_PROTECT, BUFF_REFLECT];

// Mark a buff as active on a combatant. Re-applying an already-active buff
// is a no-op (no stacking) — same as canon. Idempotent.
export function applyBuff(combatant, buffKey) {
  if (!combatant) return;
  if (!combatant.buffs) combatant.buffs = {};
  combatant.buffs[buffKey] = true;
}

export function hasBuff(combatant, buffKey) {
  return !!(combatant && combatant.buffs && combatant.buffs[buffKey]);
}

// Wipe all buffs. Called at battle start (resetBattleVars). Mutates the
// combatant's buffs object in place rather than reassigning, so any stable
// references to it (e.g. inside a draw helper that has cached the ref)
// stay valid.
export function clearAllBuffs(combatant) {
  if (!combatant || !combatant.buffs) return;
  for (const k of Object.keys(combatant.buffs)) delete combatant.buffs[k];
}
