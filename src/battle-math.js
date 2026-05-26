// Pure combat math — no globals, no DOM, safe to import anywhere
// Based on NES FF3 disassembly (31/BB28 get_number_of_hits, 31/BB44 calculate_damage)
//
// Every gameplay roll goes through `rand()` (seedable mulberry32 in rng.js)
// so two clients running the same battle agree byte-for-byte once the
// websocket layer broadcasts the seed. Pre-v1.7.358 these used Math.random
// and would diverge on the first hit roll.

import { rand } from './rng.js';

export const BASE_HIT_RATE = 80;   // 80% accuracy per hit (unarmed Onion Knight)
export const BOSS_HIT_RATE = 85;   // boss accuracy
export const GOBLIN_HIT_RATE = 75; // goblin accuracy
export const DAMAGE_CAP = 9999;

// Initiative priority — `agi*2 + rand(0..255)`. Higher rolls go first.
// Single source for buildTurnOrder (player / ally / encounter / PVP-opp /
// PVP-enemy-ally) so the formula can't drift across actor types.
// `opts.rand` lets the PvP arbiter inject a per-battle RNG instance
// (created via `createRng()` in rng.js). Defaults to the singleton —
// existing client callers unchanged. v1.7.749 P-3.
export function rollInitiative(agi, opts = {}) {
  const rng = opts.rand || rand;
  return ((agi || 0) * 2) + Math.floor(rng() * 256);
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
// `opts.rand` — see rollInitiative above for the injection convention.
export function calcDamage(atk, def, crit = false, critBonus = 0, elemMult = 1, opts = {}) {
  const rng = opts.rand || rand;
  let dmg = atk + Math.floor(rng() * (Math.floor(atk / 2) + 1)) - def;
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
// Returns DISPLAY ATK = rWpnAtk + lWpnAtk + floor(str/2). For dual-wield the
// menu shows the SUM of both weapons (canon NES menu behavior + intuitive UX —
// holding two weapons reads as a bigger number than holding one + a shield).
// Single-wield: one slot is 0 so sum collapses to the equipped weapon.
//
// IMPORTANT: this is the display value. Damage rolls MUST split per-hand —
// each hand contributes its own weapon ATK + floor(str/2), with hits divided
// between the hands (RRLL). Player rolls per-hand in input-handler.js#rollHand.
// Ally + PVP rolls per-hand via rollHits opts.lAtk / opts.splitRH (v1.7.322).
// Using `combatant.atk` directly in a single rollHits call with 2× hits would
// re-create the 2026-05-08 sum-and-double 2× canon bug.
export function calcAttackerAtk({ rWpnAtk, lWpnAtk, isMonkClass, level, str, jobLevel }) {
  const isUnarmed = !rWpnAtk && !lWpnAtk;
  if (isUnarmed && isMonkClass) {
    return Math.floor(str / 4) + Math.floor(level * 1.5) + Math.floor(jobLevel / 4) + 2;
  }
  return rWpnAtk + lWpnAtk + Math.floor(str / 2);
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

// Apply-time target redirect. If `picked` is alive (hp > 0) return it.
// Otherwise scan `factionList` for the first living combatant. Returns
// null if the whole faction is dead. Use at apply time (not decision
// time) so a target that died during cast windup or mid-combo gets
// redirected to a living teammate instead of silently no-op'ing.
//
// `picked`       — single combatant object (may be null/dead)
// `factionList`  — array of combatants on the same side as `picked`.
//                  Caller decides the array (player faction =
//                  [ps, ...battleAllies], enemy faction = encounterMonsters
//                  or [pvpOpponentStats, ...pvpEnemyAllies], etc).
//                  Pass null to disable fallback (returns picked-if-alive
//                  or null).
//
// v1.7.359 — multiplayer prep step 2/7.
export function resolveLivingTarget(picked, factionList) {
  if (picked && (picked.hp || 0) > 0) return picked;
  if (!factionList) return null;
  for (const c of factionList) {
    if (c && (c.hp || 0) > 0) return c;
  }
  return null;
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
// opts.lAtk + opts.splitRH: when splitRH=true, hits 0..floor(n/2)-1 use `atk` (right
//   hand) and floor(n/2)..n-1 use `lAtk` (left hand). RRLL ordering matches
//   battle-math.js#isRightHandHit + the slash-animation timing. Used by ally and
//   PVP-enemy dual-wield paths; player splits per-hand earlier and calls rollHits
//   once per hand instead.
export function rollHits(atk, def, hitRate, potentialHits, opts = {}) {
  const { shieldEvade = 0, evade = 0, defendHalve = false, targetProtected = false,
          elemMult = 1, critPct = 0, critBonus = 0, lAtk = 0, splitRH = false } = opts;
  // v1.7.749 P-3 — per-battle RNG injection. Defaults to singleton so
  // existing client callers (battle-update / battle-ally / pvp) behave
  // identically.
  const rng = opts.rand || rand;
  const results = [];
  const splitIdx = splitRH ? (potentialHits >> 1) : potentialHits;
  for (let i = 0; i < potentialHits; i++) {
    const handAtk = (splitRH && i >= splitIdx) ? lAtk : atk;
    if (shieldEvade > 0 && rng() * 100 < shieldEvade) {
      results.push({ shieldBlock: true });
    } else if (evade > 0 && rng() * 100 < evade) {
      results.push({ miss: true });
    } else if (rng() * 100 < hitRate) {
      const crit = critPct > 0 && rng() * 100 < critPct;
      let dmg = calcDamage(handAtk, def, crit, critBonus, elemMult, opts);
      if (defendHalve) dmg = Math.max(1, Math.floor(dmg / 2));
      if (targetProtected) dmg = Math.max(1, Math.floor(dmg / 2));
      results.push({ damage: dmg, crit });
    } else {
      results.push({ miss: true });
    }
  }
  return results;
}
