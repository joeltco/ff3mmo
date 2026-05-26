// Pure, ps-free stat computation. Same math as `player-stats.js`'s
// `recalcCombatStats` + `getEffectiveStats` + `getShieldEvade`, but takes
// all inputs as arguments so it can run on the server for PvP arbiter
// combatant generation.
//
// v1.7.748 P-2 — extracted from `player-stats.js` to break the singleton
// `ps` coupling. The client wrappers in `player-stats.js` now delegate
// to these functions and assign the results back to ps fields, preserving
// every existing call site's behavior.
//
// Pairs with `docs/PVP-REWRITE-PLAN.md` P-2 deliverable. Wire-sim parity
// test asserts client `recalcCombatStats(...)` output matches a server
// `buildCombatantFromUser(...)` call for the same data.

import { ITEMS, isWeapon } from './data/items.js';
import { BASE_HIT_RATE, calcAttackerAtk } from './battle-math.js';
import { jobLevelStatBonus } from './data/jobs.js';

// Pure effective-stats — base ps.stats + equipment stat bonuses + job
// level bonuses. Mirrors `getEffectiveStats` in player-stats.js.
export function computeEffectiveStats({ stats, jobIdx, jobLevel, equipped }) {
  const allSlots = [equipped.weaponR, equipped.weaponL, equipped.head, equipped.body, equipped.arms];
  let strB = 0, agiB = 0, vitB = 0, intB = 0, mndB = 0;
  for (const id of allSlots) {
    const item = ITEMS.get(id);
    if (!item) continue;
    strB += item.strBonus || 0;
    agiB += item.agiBonus || 0;
    vitB += item.vitBonus || 0;
    intB += item.intBonus || 0;
    mndB += item.mndBonus || 0;
  }
  const jlb = jobLevelStatBonus(jobIdx, jobLevel);
  const base = stats || { str: 5, agi: 5, vit: 5, int: 5, mnd: 5 };
  return {
    str: (base.str | 0) + strB + jlb.str,
    agi: (base.agi | 0) + agiB + jlb.agi,
    vit: (base.vit | 0) + vitB + jlb.vit,
    int: (base.int | 0) + intB + jlb.int,
    mnd: (base.mnd | 0) + mndB + jlb.mnd,
  };
}

// Shield evade lookup — checks both hand slots; returns 0 if neither
// holds a shield. Pure. Mirrors `getShieldEvade` in player-stats.js.
export function computeShieldEvade(weaponR, weaponL) {
  const rItem = ITEMS.get(weaponR);
  const lItem = ITEMS.get(weaponL);
  const shieldItem = rItem?.subtype === 'shield' ? rItem
                   : lItem?.subtype === 'shield' ? lItem
                   : null;
  return shieldItem ? (shieldItem.evade || 0) : 0;
}

// Pure realized-stats. Same math as `recalcCombatStats` in player-stats.js
// but returns a fresh object instead of mutating `ps`. Inputs match a
// save-row + mirror shape so it's callable from anywhere.
//
// Returns:
//   { atk, def, hitRate, evade, mdef, elemResist, statusResist, shieldEvade,
//     intStat, mndStat }
//
// `intStat` and `mndStat` are the effective magic-stat fields — same
// naming as the `update` profile + `generateAllyStats` fast-path consume.
export function computeRealizedStats({ stats, jobIdx, jobLevel, equipped }) {
  const eff = computeEffectiveStats({ stats, jobIdx, jobLevel, equipped });
  const allSlots = [equipped.weaponR, equipped.weaponL, equipped.head, equipped.body, equipped.arms];
  // ATK — calcAttackerAtk uses effective STR + character level + job level.
  const atk = calcAttackerAtk({
    rWpnAtk: isWeapon(equipped.weaponR) ? (ITEMS.get(equipped.weaponR)?.atk || 0) : 0,
    lWpnAtk: isWeapon(equipped.weaponL) ? (ITEMS.get(equipped.weaponL)?.atk || 0) : 0,
    isMonkClass: jobIdx === 2 || jobIdx === 13,
    level: (stats && stats.level) || 1,
    str: eff.str,
    jobLevel,
  });
  // Hit rate — equipped weapon's hit% (preferring R, falling back to L),
  // or BASE_HIT_RATE if unarmed.
  const rWpn = isWeapon(equipped.weaponR) ? ITEMS.get(equipped.weaponR) : null;
  const lWpn = isWeapon(equipped.weaponL) ? ITEMS.get(equipped.weaponL) : null;
  const hitRate = (rWpn || lWpn) ? (rWpn ? rWpn.hit : lWpn.hit) : BASE_HIT_RATE;
  // Armor evade (non-shield) — head/body/arms only.
  const evade = (ITEMS.get(equipped.head)?.evade || 0)
              + (ITEMS.get(equipped.body)?.evade || 0)
              + (ITEMS.get(equipped.arms)?.evade || 0);
  // Magic defense — union across all 5 slots.
  let mdef = 0;
  for (const id of allSlots) { mdef += ITEMS.get(id)?.mdef || 0; }
  // Elemental resistances — union across all 5 slots.
  const resSet = new Set();
  for (const id of allSlots) {
    const r = ITEMS.get(id)?.resist;
    if (r) { const arr = Array.isArray(r) ? r : [r]; arr.forEach(e => resSet.add(e)); }
  }
  const elemResist = [...resSet];
  // Status resistance — bitmask OR across all 5 slots.
  let statusResist = 0;
  for (const id of allSlots) { statusResist |= ITEMS.get(id)?.sResist || 0; }
  // DEF — uses floor(effVit/2) + equipment def. Mirrors `recalcDEF` in
  // player-stats.js. `effVit` here is the same effective-stat value as
  // `eff.vit` — no need to recompute the equipment vitBonus sum.
  const rDef = ITEMS.get(equipped.weaponR)?.def || 0;
  const lDef = ITEMS.get(equipped.weaponL)?.def || 0;
  const def = Math.floor(eff.vit / 2)
    + rDef + lDef
    + (ITEMS.get(equipped.head)?.def || 0)
    + (ITEMS.get(equipped.body)?.def || 0)
    + (ITEMS.get(equipped.arms)?.def || 0);
  return {
    atk, def, hitRate, evade, mdef, elemResist, statusResist,
    shieldEvade: computeShieldEvade(equipped.weaponR, equipped.weaponL),
    intStat: eff.int,
    mndStat: eff.mnd,
    // Pass back effective stats too — callers (the update profile builder,
    // the server combatant builder) ship `agi` as effective, not base.
    effStr: eff.str,
    effAgi: eff.agi,
    effVit: eff.vit,
    effInt: eff.int,
    effMnd: eff.mnd,
  };
}
