// PvE replay-validate engine. v1.7.775 P-5.
//
// Outcome-validate model: instead of replaying the entire battle FSM
// server-side (PvP-arbiter style), this engine validates that the
// client's CLAIMED rewards are consistent with the server-rolled
// monster list. Server confirms:
//   - victor in ['party' | 'wipe' | 'fled']
//   - on victory: expGained / gilGained / cpGained match the sum across
//     the formation (matching the client formula in battle-update.js
//     line 836-843: max(1, floor(total / 4)))
//   - drop is null OR drop is in the union of valid drops for the
//     monsters that were in the battle
//   - on wipe/flee: all rewards must be 0
//
// What this misses (degraded but acceptable for v1):
//   - HP / MP / status of party post-battle (cheater can lie about
//     surviving with full HP — but this doesn't grant currency directly;
//     the inventory mirror catches item dup attempts)
//   - Per-monster which-died-which-survived breakdown (we trust the
//     reward total but don't verify each individual monster outcome)
//   - Magic / item resolution (intents are logged for forensics but
//     not replayed — P-5b deferred)
//
// Future P-5b: full per-action replay. Will require lifting battle-turn
// + battle-ally + status-effects + spell-cast into Node-clean shared
// modules (same shape as the PvP arbiter's P-4c roadmap).

import { MONSTERS } from './src/data/monsters.js';

// Validate a claimed outcome against the server-canonical monster list.
//
// Args:
//   battle.monsters[]       — server-rolled formation from createPveBattle
//   battle.preState         — captured at battle start (currently unused
//                             by outcome-validate but P-5b will need it)
//   claimedOutcome          — { victor, expGained, cpGained, gilGained, drop }
//
// Returns:
//   { accepted: true,  canonical: <copy of claim, normalized> }   on match
//   { accepted: false, reason: 'string' }                          on reject
export function validateBattleOutcome(battle, claimedOutcome) {
  if (!battle || !battle.monsters) {
    return { accepted: false, reason: 'no-battle' };
  }
  const claim = claimedOutcome || {};
  const victor = claim.victor;

  if (victor !== 'party' && victor !== 'wipe' && victor !== 'fled') {
    return { accepted: false, reason: 'invalid-victor' };
  }

  // Wipe/flee path: all rewards must be 0. Trust client's post-state
  // (player/monster HP); reject any non-zero reward.
  if (victor === 'wipe' || victor === 'fled') {
    if ((claim.expGained | 0) !== 0) return { accepted: false, reason: 'reward-on-loss-exp' };
    if ((claim.gilGained | 0) !== 0) return { accepted: false, reason: 'reward-on-loss-gil' };
    if ((claim.cpGained  | 0) !== 0) return { accepted: false, reason: 'reward-on-loss-cp' };
    if (claim.drop != null)          return { accepted: false, reason: 'drop-on-loss' };
    return {
      accepted: true,
      canonical: { victor, expGained: 0, gilGained: 0, cpGained: 0, drop: null },
    };
  }

  // Victory path. Mirror battle-update.js#_updateVictoryFsm formulas:
  //   raw     = sum of monster.exp                  → /4 floor → max 1
  //   gil     = sum of monster.gil                  → /4 floor → max 1
  //   cp      = sum of monster.cp || 1              → /4 floor → max 1
  const sumExp = battle.monsters.reduce((s, m) => s + (m.exp | 0), 0);
  const sumGil = battle.monsters.reduce((s, m) => s + (m.gil | 0), 0);
  const sumCp  = battle.monsters.reduce((s, m) => s + ((m.cp != null ? m.cp : 1) | 0), 0);
  const expected = {
    expGained: Math.max(1, Math.floor(sumExp / 4)),
    gilGained: Math.max(1, Math.floor(sumGil / 4)),
    cpGained:  Math.max(1, Math.floor(sumCp  / 4)),
  };

  if ((claim.expGained | 0) !== expected.expGained) {
    return { accepted: false, reason: 'exp-mismatch claim=' + (claim.expGained|0) + ' expected=' + expected.expGained };
  }
  if ((claim.gilGained | 0) !== expected.gilGained) {
    return { accepted: false, reason: 'gil-mismatch claim=' + (claim.gilGained|0) + ' expected=' + expected.gilGained };
  }
  if ((claim.cpGained | 0) !== expected.cpGained) {
    return { accepted: false, reason: 'cp-mismatch claim=' + (claim.cpGained|0) + ' expected=' + expected.cpGained };
  }

  // Drop check — claimed drop must be null OR in the union of every
  // battle monster's drop table. Mirrors the filter in battle-update.js
  // line 853 (`validDrops = mData?.drops?.filter(d => d != null)`).
  const claimedDrop = claim.drop;
  if (claimedDrop != null) {
    const validDrops = new Set();
    for (const m of battle.monsters) {
      const mData = MONSTERS.get(m.monsterId);
      if (!mData || !mData.drops) continue;
      for (const d of mData.drops) {
        if (d != null) validDrops.add(d);
      }
    }
    if (!validDrops.has(claimedDrop)) {
      return { accepted: false, reason: 'drop-not-in-pool claim=0x' + claimedDrop.toString(16) };
    }
  }

  return {
    accepted: true,
    canonical: {
      victor,
      expGained: expected.expGained,
      gilGained: expected.gilGained,
      cpGained:  expected.cpGained,
      drop:      claimedDrop != null ? claimedDrop : null,
    },
  };
}
