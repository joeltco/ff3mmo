// Pure combat math — no globals, no DOM, safe to import anywhere
// Based on NES FF3 disassembly (31/BB28 get_number_of_hits, 31/BB44 calculate_damage)

export const BASE_HIT_RATE = 80;   // 80% accuracy per hit (unarmed Onion Knight)
export const BOSS_HIT_RATE = 85;   // boss accuracy
export const GOBLIN_HIT_RATE = 75; // goblin accuracy
export const DAMAGE_CAP = 9999;

// Initiative priority — `agi*2 + rand(0..255)`. Higher rolls go first.
// Single source for buildTurnOrder (player / ally / encounter / PVP-opp /
// PVP-enemy-ally) so the formula can't drift across actor types.
export function rollInitiative(agi) {
  return ((agi || 0) * 2) + Math.floor(Math.random() * 256);
}

// Reduce a hit-results array to its battle-display summary. Used by player,
// ally, and PVP combo-hit finalizers (battle-update / battle-ally / pvp).
// `dmgKey` defaults to 'damage'; PVP uses 'dmg'. `respectShieldBlock` skips
// blocked hits (PVP only — player/ally roll shield-block into miss earlier).
export function summarizeHits(hits, opts = {}) {
  const dmgKey = opts.dmgKey || 'damage';
  const respectShieldBlock = !!opts.respectShieldBlock;
  let totalDmg = 0, anyCrit = false, allMiss = true, hitsLanded = 0;
  for (const h of hits) {
    if (h.miss) continue;
    if (respectShieldBlock && h.shieldBlock) continue;
    totalDmg += h[dmgKey];
    allMiss = false;
    hitsLanded++;
    if (h.crit) anyCrit = true;
  }
  return { totalDmg, anyCrit, allMiss, hitsLanded };
}

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

// NES FF3 attacker ATK (disasm 30/9F44, 31/AC76-AC9B). Single source for player + ally + PVP.
// rWpnAtk/lWpnAtk: equipped-weapon ATK (0 for unarmed slot or non-weapon item).
// isMonkClass: true for Monk(2)/BlackBelt(13). When unarmed, uses level-based formula.
// Non-Monks add floor(str/2) — without it, weapon ATK alone is too low to overcome
// any equipped defender's DEF (vit + armor stack) and damage clamps to 1.
//
// Dual-wield: returns max(rWpnAtk, lWpnAtk) + str/2 as the canonical ATK display
// (the better hand's per-hit ATK). The player path in input-handler.js rolls each
// hand independently at its own weapon ATK, so averaging the two hands distorted
// the displayed ATK below either weapon's true per-hit power — equipping a
// weaker offhand visibly LOWERED ATK, and adding a shield instead made it go UP
// (the "12 vs 13" dagger+knife / dagger+shield bug, v1.7.321).
//
// Ally / PVP-enemy use this value directly in `rollHits` with 2× hits
// (potentialHits doubles when dualWield=true). For matched weapons that
// matches canon expected damage; for mismatched dual it's slightly above the
// per-hand canon (~14% on a 6/8 split), which is an acceptable tradeoff for
// the consistent display. The summing-both-ATKs bug from 2026-05-08 (OK D+K
// hit Altar Cave boss for 2× canon) is NOT reintroduced — max ≤ sum.
export function calcAttackerAtk({ rWpnAtk, lWpnAtk, isMonkClass, level, str, jobLevel }) {
  const isUnarmed = !rWpnAtk && !lWpnAtk;
  if (isUnarmed && isMonkClass) {
    return Math.floor(str / 4) + Math.floor(level * 1.5) + Math.floor(jobLevel / 4) + 2;
  }
  const wpnAtk = Math.max(rWpnAtk, lWpnAtk);
  return wpnAtk + Math.floor(str / 2);
}

// Hit count: 1 + floor(level/12) + floor(AGI/12). NES uses /16; we tightened to
// /12 so mid-levels (~12-24) feel snappier — at /16 you're stuck on 1 hit
// through level 15, which felt flat. dualWield: each hand gets full hits
// (total = base * 2). Single weapon: min 1.
// `hasted`: doubles the final hit count (buffs.js BUFF_HASTE). Stacks with
// dual-wield — a hasted dual-wielder takes 4× the base count.
export function calcPotentialHits(level, agi, dualWield, hasted = false) {
  const base = Math.max(1, 1 + Math.floor(level / 12) + Math.floor(agi / 12));
  let n = dualWield ? base * 2 : base;
  if (hasted) n *= 2;
  return n;
}

// Which hand owns the `hitIdx`th hit in a combo. v1.7.273 standardized
// on RRLL across player / ally / PVP-enemy: first half right, second
// half left. Single-weapon callers fall through to the equipped hand.
// Inputs are booleans rather than weapon IDs so the helper stays free
// of `isWeapon` / `ITEMS` dependencies.
//   hitIdx     — current hit index (0-based)
//   totalHits  — full length of the combo (e.g., hitResults.length)
//   rW / lW    — true if the corresponding hand has a weapon
//                (both false = unarmed dual fists, both true = dual wield)
// Returns true for right-hand. `isLeftHandHit` is the boolean complement.
export function isRightHandHit(hitIdx, totalHits, rW, lW) {
  const dualOrUnarmed = (rW && lW) || (!rW && !lW);
  if (dualOrUnarmed) return hitIdx < (totalHits >> 1);
  return !!rW;
}

export function isLeftHandHit(hitIdx, totalHits, rW, lW) {
  return !isRightHandHit(hitIdx, totalHits, rW, lW);
}

// Roll per-hit results for player/ally/PVP attacks.
// opts.shieldEvade: % chance to block per hit (0 = no shield)
// opts.evade: % chance to dodge per hit (0 = no armor evade)
// opts.defendHalve: true to halve damage (defender is defending)
// opts.targetProtected: true if defender has BUFF_PROTECT — halves physical
//   damage like defendHalve. Stacks multiplicatively with defendHalve so a
//   defending + Protected target takes 1/4 damage (canon: both flags halve
//   independently).
// opts.elemMult: elemental multiplier (default 1)
// opts.critPct: % chance to crit per hit (0 if not provided). From attacker's job modifier.
// opts.critBonus: flat damage added on crit (0 if not provided). From attacker's job modifier.
export function rollHits(atk, def, hitRate, potentialHits, opts = {}) {
  const { shieldEvade = 0, evade = 0, defendHalve = false, targetProtected = false,
          elemMult = 1, critPct = 0, critBonus = 0 } = opts;
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
      if (targetProtected) dmg = Math.max(1, Math.floor(dmg / 2));
      results.push({ damage: dmg, crit });
    } else {
      results.push({ miss: true });
    }
  }
  return results;
}
