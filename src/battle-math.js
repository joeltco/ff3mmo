// Pure combat math — no globals, no DOM, safe to import anywhere

export const CRIT_RATE = 5;        // 5% crit chance per hit
export const CRIT_MULT = 1.5;      // critical hit damage multiplier
export const BASE_HIT_RATE = 80;   // 80% accuracy per hit (unarmed Onion Knight)
export const BOSS_HIT_RATE = 85;   // boss accuracy
export const GOBLIN_HIT_RATE = 75; // goblin accuracy

// NES FF3 damage formula: atk + random(0..floor(atk/2)) - def
// Full defense subtraction (not halved). Variance: +0-50% of ATK.
export function calcDamage(atk, def) {
  return Math.max(1, atk + Math.floor(Math.random() * (Math.floor(atk / 2) + 1)) - def);
}

// profLevel: weapon proficiency level (0–16) — adds hit rate, crit rate, and ATK bonuses
export function rollHits(atk, def, hitRate, potentialHits, profLevel = 0) {
  const effHitRate = hitRate + profLevel * 0.5;          // +0.5% accuracy per level
  const effCritRate = CRIT_RATE + profLevel * 0.25;      // +0.25% crit per level
  const effAtk = atk + Math.floor(profLevel * 0.5);      // +0.5 ATK per level (floored)
  const results = [];
  for (let i = 0; i < potentialHits; i++) {
    if (Math.random() * 100 < effHitRate) {
      let dmg = calcDamage(effAtk, def);
      const crit = Math.random() * 100 < effCritRate;
      if (crit) dmg = Math.floor(dmg * CRIT_MULT);
      results.push({ damage: dmg, crit });
    } else {
      results.push({ miss: true });
    }
  }
  return results;
}
