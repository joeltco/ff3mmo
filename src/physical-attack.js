// physical-attack.js — single source for "apply a physical hit to an enemy".
//
// Before v1.7.208, three separate sites duplicated this logic with subtle
// divergence:
//   - battle-update.js (_updatePlayerSlash) — full version: defend-halve,
//     encounter/boss dispatch, wake-on-hit, weapon-status inflict, crit flash
//   - battle-ally.js (_updateAllySlash) — partial: defend-halve + dispatch
//     + crit flash, but NO wake-on-hit and NO weapon-status inflict.
//   - pvp.js handles enemy-attacking-player (a different shape; not folded
//     here — the target side is friendly, not enemy).
//
// User confirmed (2026-05-10) that ally hits SHOULD wake sleeping enemies
// and SHOULD inflict weapon-status — the prior omissions were unfilled
// gaps, not design. Folding here closes both gaps in one place and keeps
// future fixes from drifting.

import { battleSt, getEnemyHP, setEnemyHP } from './battle-state.js';
import { pvpSt } from './pvp.js';
import { ITEMS } from './data/items.js';
import { tryInflictStatus, wakeOnHit } from './status-effects.js';
import { dispatchDelta } from './deltas.js';
import { isCoopGuest } from './coop-resolver.js';

// Apply a single physical-attack hit to the currently-targeted enemy.
//
// `hit` — { miss, damage, crit, ... } (mutated when defend-halving applies).
// `targetIdx` — encounter monster index, or -1 for boss / PVP main opp.
// `opts.weaponId` — for weapon-status inflict; pass null/undefined to skip.
// `opts.attackerIsAlly` — true for ally attacks; false (default) for player.
//   Currently informational only — the helper applies wake/status uniformly
//   per the user's 2026-05-10 confirmation. The flag exists in case future
//   per-attacker behavior diverges.
//
// Side effects: HP write, status mask write, crit-flash trigger. Returns
// nothing — the caller already has `hit` for downstream rendering.
export function applyPhysicalHitToEnemy(hit, targetIdx, opts = {}) {
  if (!hit || hit.miss) return;

  // PVP defend halving — applies when the PVP main opponent is defending and
  // is the target of this hit. Encounter / boss / PVP-ally targets ignore.
  const isPVPMainTarget = pvpSt.isPVPBattle && targetIdx < 0;
  if (isPVPMainTarget && pvpSt.pvpOpponentIsDefending) {
    hit.damage = Math.max(1, Math.floor(hit.damage / 2));
  }

  // Phase 6.7 — guest-side short-circuit. Under host-arb, the host
  // applies the authoritative damage + status via resolvePhysicalAttack;
  // its resolution packet is applied by coop-applier#_apply which writes
  // the same HP delta + status flag. The slash + damage-num animation
  // is driven by FSM state transitions (not this function), so they
  // continue firing — only the underlying mutation is deferred to the
  // host's wire packet. Flag-off path is unchanged.
  if (isCoopGuest()) return;

  if (battleSt.isRandomEncounter && battleSt.encounterMonsters) {
    const mon = battleSt.encounterMonsters[targetIdx];
    if (!mon) return;
    dispatchDelta({ type: 'hp', target: mon, amount: -hit.damage, source: opts.source });
    if (mon.status) wakeOnHit(mon.status);
    if (opts.weaponId != null && mon.status && mon.hp > 0) {
      const wpnData = ITEMS.get(opts.weaponId);
      if (wpnData && wpnData.status) {
        const arr = Array.isArray(wpnData.status) ? wpnData.status : [wpnData.status];
        for (const s of arr) {
          const applied = tryInflictStatus(mon.status, s, wpnData.hit || 50, mon.statusResist);
          if (applied) battleSt.comboStatusInflicted = applied;
        }
      }
    }
  } else {
    setEnemyHP(Math.max(0, getEnemyHP() - hit.damage));
  }

  if (hit.crit) battleSt.critFlashTimer = 0;
}
