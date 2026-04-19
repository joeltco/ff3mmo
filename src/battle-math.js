// Pure combat math — no globals, no DOM, safe to import anywhere
// Based on NES FF3 disassembly (31/BB28 get_number_of_hits, 31/BB44 calculate_damage)

export const BASE_HIT_RATE = 80;   // 80% accuracy per hit (unarmed Onion Knight)
export const BOSS_HIT_RATE = 85;   // boss accuracy
export const GOBLIN_HIT_RATE = 75; // goblin accuracy
export const DAMAGE_CAP = 9999;

// NES elemental multiplier: 2x if target is weak, 0.5x if target resists
// atkElem/weakness/resist can be a string or array of strings
export function elemMultiplier(atkElem, weakness, resist) {
  if (!atkElem) return 1;
  const atk = Array.isArray(atkElem) ? atkElem : [atkElem];
  const weak = weakness ? (Array.isArray(weakness) ? weakness : [weakness]) : [];
  const res = resist ? (Array.isArray(resist) ? resist : [resist]) : [];
  let mult = 1;
  for (const e of atk) {
    if (weak.includes(e)) { mult = 2; break; }
    if (res.includes(e)) { mult = 0.5; }
  }
  return mult;
}

// NES FF3 damage formula: atk + random(0..floor(atk/2)) - def
// Crit adds flat bonus (NES $28: per-job/weapon crit bonus, additive not multiplicative)
// elemMult: elemental multiplier (1 = neutral, 2 = weak, 0.5 = resist)
export function calcDamage(atk, def, crit = false, critBonus = 0, elemMult = 1) {
  let dmg = atk + Math.floor(Math.random() * (Math.floor(atk / 2) + 1)) - def;
  if (crit) dmg += critBonus;
  dmg = Math.floor(dmg * elemMult);
  return Math.min(DAMAGE_CAP, Math.max(1, dmg));
}

// NES FF3 hit count (from disasm 31/ABCE-ABE3): 1 + floor(level/16) + floor(AGI/16)
// dualWield: each hand gets full hits (total = base * 2). Single weapon: min 1.
export function calcPotentialHits(level, agi, dualWield) {
  const base = Math.max(1, 1 + Math.floor(level / 16) + Math.floor(agi / 16));
  return dualWield ? base * 2 : base;
}

// Roll per-hit results for player/ally/PVP attacks.
// opts.shieldEvade: % chance to block per hit (0 = no shield)
// opts.evade: % chance to dodge per hit (0 = no armor evade)
// opts.defendHalve: true to halve damage (defender is defending)
// opts.elemMult: elemental multiplier (default 1)
// opts.critPct: % chance to crit per hit (0 if not provided). From attacker's job modifier.
// opts.critBonus: flat damage added on crit (0 if not provided). From attacker's job modifier.
export function rollHits(atk, def, hitRate, potentialHits, opts = {}) {
  const { shieldEvade = 0, evade = 0, defendHalve = false, elemMult = 1,
          critPct = 0, critBonus = 0 } = opts;
  const results = [];
  for (let i = 0; i < potentialHits; i++) {
    if (shieldEvade > 0 && Math.random() * 100 < shieldEvade) {
      results.push({ shieldBlock: true });
    } else if (evade > 0 && Math.random() * 100 < evade) {
      results.push({ miss: true });
    } else if (Math.random() * 100 < hitRate) {
      const crit = critPct > 0 && Math.random() * 100 < critPct;
      let dmg = calcDamage(atk, def, crit, critBonus, elemMult);
      if (defendHalve) dmg = Math.max(1, Math.floor(dmg / 2));
      results.push({ damage: dmg, crit });
    } else {
      results.push({ miss: true });
    }
  }
  return results;
}
