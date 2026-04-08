// player-stats.js — player combat stats, equip slots, exp, and derived stat helpers

import { readJobBaseStats, readStartingHP, readStartingMP, readJobLevelBonus, buildExpTable, JOBS } from './data/jobs.js';
import { ITEMS, isWeapon } from './data/items.js';
import { BASE_HIT_RATE } from './battle-math.js';
import { createStatusState } from './status-effects.js';

// Mutable player state — replaces the scattered globals in game.js
export const ps = {
  stats: null,      // { str, agi, vit, int, mnd, hp, maxHP, mp, maxMP, level, exp, expToNext }
  expTable: null,   // Uint32Array(98)
  leveledUp: false,
  hp: 28,
  mp: 12,
  atk: 12,
  def: 4,
  gil: 0,
  weaponR: 0x1E,   // right hand item ID (Knife), 0 = unarmed
  weaponL: 0x00,   // left hand item ID, 0 = unarmed
  head: 0x00,
  body: 0x00,
  arms: 0x00,
  hitRate: 80,      // effective hit% from weapon
  evade: 0,         // total evade% from armor (non-shield)
  mdef: 0,          // total magic defense from armor
  attackRoll: 1,    // potential hits (from effective AGI)
  elemResist: [],   // array of element strings player resists (from armor)
  status: { mask: 0, poisonDmgTick: 0 },  // status effect state — persists across battles
  _romData: null,  // stored by initExpTable for use in grantExp
  jobLevels: {},  // { [jobIdx]: { level, jp } } — 100 JP per level, max 99
  jobIdx: 0,            // current job index (0=Onion Knight, 1=Warrior, etc.)
  unlockedJobs: 0x01,   // bitmask: bit N = job N unlocked. 0x01 = only Onion Knight
  cp: 0,                // capacity points (0-255), earned from battles, spent on job changes
};

// Equip slot index mapping: -100=RH, -101=LH, -102=Head, -103=Body, -104=Arms
export const EQUIP_SLOT_SUBTYPE = { '-102': 'helmet', '-103': 'body', '-104': 'arms' };

export function getEquipSlotId(eqIdx) {
  switch (eqIdx) {
    case -100: return ps.weaponR;
    case -101: return ps.weaponL;
    case -102: return ps.head;
    case -103: return ps.body;
    case -104: return ps.arms;
    default: return 0;
  }
}

export function setEquipSlotId(eqIdx, id) {
  switch (eqIdx) {
    case -100: ps.weaponR = id; break;
    case -101: ps.weaponL = id; break;
    case -102: ps.head = id; break;
    case -103: ps.body = id; break;
    case -104: ps.arms = id; break;
  }
}

export function recalcCombatStats() {
  const allSlots = [ps.weaponR, ps.weaponL, ps.head, ps.body, ps.arms];
  // Sum equipment stat bonuses
  let strB = 0, agiB = 0, vitB = 0;
  for (const id of allSlots) {
    const item = ITEMS.get(id);
    if (!item) continue;
    strB += item.strBonus || 0;
    agiB += item.agiBonus || 0;
    vitB += item.vitBonus || 0;
  }
  const effStr = (ps.stats ? ps.stats.str : 5) + strB;
  const effAgi = (ps.stats ? ps.stats.agi : 5) + agiB;
  // ATK = effective STR + weapon attack powers + floor(AGI/4) + floor(jobLv/4) (from disasm 31/ABEF)
  const jobLv = getJobLevel();
  ps.atk = effStr + (ITEMS.get(ps.weaponR)?.atk || 0) + (ITEMS.get(ps.weaponL)?.atk || 0)
         + Math.floor(effAgi / 4) + Math.floor(jobLv / 4);
  // Hit rate from equipped weapon (or base if unarmed)
  const rWpn = isWeapon(ps.weaponR) ? ITEMS.get(ps.weaponR) : null;
  const lWpn = isWeapon(ps.weaponL) ? ITEMS.get(ps.weaponL) : null;
  ps.hitRate = (rWpn || lWpn) ? (rWpn ? rWpn.hit : lWpn.hit) : BASE_HIT_RATE;
  // Attack roll (potential hits) from effective AGI
  ps.attackRoll = Math.max(1, Math.floor(effAgi / 10));
  // Armor evade% (non-shield — shield evade handled separately by getShieldEvade)
  ps.evade = (ITEMS.get(ps.head)?.evade || 0)
           + (ITEMS.get(ps.body)?.evade || 0)
           + (ITEMS.get(ps.arms)?.evade || 0);
  // Magic defense from all equipment
  ps.mdef = 0;
  for (const id of allSlots) { ps.mdef += ITEMS.get(id)?.mdef || 0; }
  // Elemental resistances from all equipment
  const resSet = new Set();
  for (const id of allSlots) {
    const r = ITEMS.get(id)?.resist;
    if (r) { const arr = Array.isArray(r) ? r : [r]; arr.forEach(e => resSet.add(e)); }
  }
  ps.elemResist = [...resSet];
  // DEF with equipment vitality bonus
  recalcDEF(vitB);
}

export function recalcDEF(vitBonus = 0) {
  // If called standalone (e.g. equip change), re-sum vitBonus
  if (vitBonus === 0) {
    for (const id of [ps.weaponR, ps.weaponL, ps.head, ps.body, ps.arms]) {
      vitBonus += ITEMS.get(id)?.vitBonus || 0;
    }
  }
  const rDef = ITEMS.get(ps.weaponR)?.def || 0;
  const lDef = ITEMS.get(ps.weaponL)?.def || 0;
  ps.def = (ps.stats ? ps.stats.vit : 4) + vitBonus
    + rDef + lDef
    + (ITEMS.get(ps.head)?.def || 0)
    + (ITEMS.get(ps.body)?.def || 0)
    + (ITEMS.get(ps.arms)?.def || 0);
}

// Get the weapon ID for a given hit index (shields are not weapons)
// rHandHitCount: if dual wielding, hits 0..rHandHitCount-1 are R hand, rest are L
export function getHitWeapon(hitIdx, rHandHitCount = 0) {
  const rW = isWeapon(ps.weaponR);
  const lW = isWeapon(ps.weaponL);
  if (rW && lW && rHandHitCount > 0) return hitIdx < rHandHitCount ? ps.weaponR : ps.weaponL;
  if (rW) return ps.weaponR;
  if (lW) return ps.weaponL;
  return 0; // unarmed
}

export function isHitRightHand(hitIdx, rHandHitCount = 0) {
  const rW = isWeapon(ps.weaponR);
  const lW = isWeapon(ps.weaponL);
  if (rW && lW && rHandHitCount > 0) return hitIdx < rHandHitCount;
  if (rW || lW) return rW; // single weapon hand
  return true; // unarmed: always R pose
}

export function initPlayerStats(romData) {
  const { str, agi, vit, int: int_, mnd, mpIdx } = readJobBaseStats(romData, ps.jobIdx);
  const hp = readStartingHP(romData);
  const mp = readStartingMP(romData, mpIdx);
  ps.stats = { str, agi, vit, int: int_, mnd, hp, maxHP: hp, mp, maxMP: mp, level: 1, exp: 0, expToNext: 0 };
  ps.hp = hp;
  ps.mp = mp;
  recalcCombatStats();
}

export function initExpTable(romData) {
  ps._romData = romData;
  ps.expTable = buildExpTable(romData);
  ps.stats.expToNext = ps.expTable[0];
}

export function fullHeal() {
  ps.stats.hp = ps.stats.maxHP; ps.stats.mp = ps.stats.maxMP;
  ps.hp = ps.stats.maxHP; ps.mp = ps.stats.maxMP;
}

export function grantExp(amount) {
  // NES splits EXP across 4 party members; we have 1 player, so divide by 4
  ps.stats.exp += Math.max(1, Math.floor(amount / 4));
  ps.leveledUp = false;
  while (ps.stats.exp >= ps.stats.expToNext && ps.stats.level < 99) {
    ps.stats.level++;
    const lv = ps.stats.level;

    // HP growth: vit + random(0, floor(vit/2)) + level * 2 (from disasm 35/BECA-BF09)
    const hpGain = ps.stats.vit + Math.floor(Math.random() * (Math.floor(ps.stats.vit / 2) + 1)) + lv * 2;
    ps.stats.maxHP = Math.min(9999, ps.stats.maxHP + hpGain);

    // Stat bonuses from ROM — current job
    const bonus = readJobLevelBonus(ps._romData, ps.jobIdx, lv);
    ps.stats.str += bonus.str; ps.stats.agi += bonus.agi; ps.stats.vit += bonus.vit;
    ps.stats.int += bonus.int; ps.stats.mnd += bonus.mnd;
    ps.stats.maxMP += bonus.mpGain;

    // Full heal on level-up (matches FF3)
    fullHeal();

    // Update derived combat stats
    recalcCombatStats();

    // Next threshold
    if (lv - 1 < 98) ps.stats.expToNext = ps.expTable[lv - 1];
    else ps.stats.expToNext = 0xFFFFFF; // max level

    ps.leveledUp = true;
  }
  return { leveledUp: ps.leveledUp };
}

// --- Job Level system (NES FF3) ---
// 100 JP per level, max 1 level per battle, max level 99.
// JP rates: NES values / 4 for single-player (NES has 4 party members sharing actions).
// JLv 1-14 = 5 JP/action (was 20), JLv 15+ varies by job.

// JP gain rates per job at JLv 15+ (NES values / 4, minimum 2)
const JP_RATES = {
  0:2, 1:4, 2:4, 3:3, 4:3, 5:3, 6:4, 7:4, 8:4, 9:5,
  10:4, 11:4, 12:6, 13:4, 14:3, 15:3, 16:3, 17:3, 18:3, 19:3, 20:3, 21:3
};

export function getJobLevel(jobIdx = ps.jobIdx) {
  return ps.jobLevels[jobIdx]?.level || 1;
}

// Call once per battle victory with total actions taken.
// Returns new level number on level-up, or null.
export function gainJobJP(actionCount) {
  const jl = ps.jobLevels[ps.jobIdx] || (ps.jobLevels[ps.jobIdx] = { level: 1, jp: 0 });
  const rate = jl.level < 15 ? 5 : (JP_RATES[ps.jobIdx] || 4);
  jl.jp += actionCount * rate;
  if (jl.jp >= 100 && jl.level < 99) {
    jl.jp -= 100;
    jl.level++;
    return jl.level;
  }
  return null;
}

// Shield evade — base evade from shield item only (no proficiency bonus)
export function getShieldEvade() {
  const shieldItem = ITEMS.get(ps.weaponR)?.subtype === 'shield' ? ITEMS.get(ps.weaponR)
                   : ITEMS.get(ps.weaponL)?.subtype === 'shield' ? ITEMS.get(ps.weaponL)
                   : null;
  if (!shieldItem) return 0;
  return shieldItem.evade || 0;
}

export function grantCP(amount) {
  ps.cp = Math.min(255, ps.cp + amount);
}

// Returns CP cost to switch to a job (full NES base cost, minus job level discount)
export function jobSwitchCost(newJobIdx) {
  const baseCost = JOBS[newJobIdx]?.cpCost || 0;
  const targetJobLv = getJobLevel(newJobIdx);
  return Math.max(0, baseCost - (targetJobLv - 1));
}

export function changeJob(newJobIdx) {
  ps.jobIdx = newJobIdx;
  // Rebuild stats from scratch for the new job at current level
  const { str, agi, vit, int: int_, mnd, mpIdx } = readJobBaseStats(ps._romData, newJobIdx);
  const baseHP = readStartingHP(ps._romData);
  const baseMP = readStartingMP(ps._romData, mpIdx);
  let s = { str, agi, vit, int: int_, mnd, maxHP: baseHP, maxMP: baseMP };
  // Replay level bonuses
  for (let lv = 2; lv <= ps.stats.level; lv++) {
    const hpGain = s.vit + Math.floor(Math.random() * (Math.floor(s.vit / 2) + 1)) + lv * 2;
    s.maxHP = Math.min(9999, s.maxHP + hpGain);
    const bonus = readJobLevelBonus(ps._romData, newJobIdx, lv);
    s.str += bonus.str; s.agi += bonus.agi; s.vit += bonus.vit;
    s.int += bonus.int; s.mnd += bonus.mnd;
    s.maxMP += bonus.mpGain;
  }
  ps.stats.str = s.str; ps.stats.agi = s.agi; ps.stats.vit = s.vit;
  ps.stats.int = s.int; ps.stats.mnd = s.mnd;
  ps.stats.maxHP = s.maxHP; ps.stats.maxMP = s.maxMP;
  // Clamp HP/MP to new maximums
  ps.hp = Math.min(ps.hp, s.maxHP); ps.stats.hp = ps.hp;
  ps.mp = Math.min(ps.mp, s.maxMP); ps.stats.mp = ps.mp;
  recalcCombatStats();
}

export function playerStatsSnapshot() {
  return {
    str: ps.stats.str, agi: ps.stats.agi, vit: ps.stats.vit,
    int: ps.stats.int, mnd: ps.stats.mnd,
    maxHP: ps.stats.maxHP, maxMP: ps.stats.maxMP, hp: ps.hp,
    weaponR: ps.weaponR, weaponL: ps.weaponL,
    head: ps.head, body: ps.body, arms: ps.arms,
    hitRate: ps.hitRate, evade: ps.evade, mdef: ps.mdef, attackRoll: ps.attackRoll,
  };
}
