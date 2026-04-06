// Pure combat math — no globals, no DOM, safe to import anywhere
// Based on NES FF3 disassembly (31/BB28 get_number_of_hits, 31/BB44 calculate_damage)

export const CRIT_RATE = 5;        // 5% crit chance per hit
export const BASE_HIT_RATE = 80;   // 80% accuracy per hit (unarmed Onion Knight)
export const BOSS_HIT_RATE = 85;   // boss accuracy
export const GOBLIN_HIT_RATE = 75; // goblin accuracy
export const DAMAGE_CAP = 9999;

// NES FF3 damage formula: atk + random(0..floor(atk/2)) - def
// Crit adds flat bonus (NES $28: per-job/weapon crit bonus, additive not multiplicative)
export function calcDamage(atk, def, crit = false, critBonus = 0) {
  let dmg = atk + Math.floor(Math.random() * (Math.floor(atk / 2) + 1)) - def;
  if (crit) dmg += critBonus;
  return Math.min(DAMAGE_CAP, Math.max(1, dmg));
}

// profLevel: weapon proficiency level (0–16) — adds hit rate, crit rate, and ATK bonuses
export function rollHits(atk, def, hitRate, potentialHits, profLevel = 0) {
  const effHitRate = hitRate + profLevel * 0.5;          // +0.5% accuracy per level
  const effCritRate = CRIT_RATE + profLevel * 0.25;      // +0.25% crit per level
  const effAtk = atk + Math.floor(profLevel * 0.5);      // +0.5 ATK per level (floored)
  const critBonus = Math.floor(effAtk / 4);               // flat crit bonus ~25% of ATK
  const results = [];
  for (let i = 0; i < potentialHits; i++) {
    if (Math.random() * 100 < effHitRate) {
      const crit = Math.random() * 100 < effCritRate;
      const dmg = calcDamage(effAtk, def, crit, critBonus);
      results.push({ damage: dmg, crit });
    } else {
      results.push({ miss: true });
    }
  }
  return results;
}
