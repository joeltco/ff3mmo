// player-stats.js — player combat stats, equip slots, exp, and derived stat helpers

import { readJobBaseStats, readStartingHP, readStartingMP, readJobLevelBonus, buildExpTable } from './data/jobs.js';
import { ITEMS, isWeapon } from './data/items.js';

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
  _romData: null,  // stored by initExpTable for use in grantExp
  proficiency: {}, // { subtype: points } — 100 pts per level, max level 16 (1600 pts)
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
  ps.atk = ps.stats.str + (ITEMS.get(ps.weaponR)?.atk || 0) + (ITEMS.get(ps.weaponL)?.atk || 0);
  recalcDEF();
}

export function recalcDEF() {
  const rDef = ITEMS.get(ps.weaponR)?.def || 0;
  const lDef = ITEMS.get(ps.weaponL)?.def || 0;
  ps.def = (ps.stats ? ps.stats.vit : 4)
    + rDef + lDef
    + (ITEMS.get(ps.head)?.def || 0)
    + (ITEMS.get(ps.body)?.def || 0)
    + (ITEMS.get(ps.arms)?.def || 0);
}

// Get the weapon ID for a given hit index (shields are not weapons)
export function getHitWeapon(hitIdx) {
  const rW = isWeapon(ps.weaponR);
  const lW = isWeapon(ps.weaponL);
  if (rW && lW) return (hitIdx % 2 === 0) ? ps.weaponR : ps.weaponL;
  if (rW) return ps.weaponR;
  if (lW) return ps.weaponL;
  return 0; // unarmed
}

export function isHitRightHand(hitIdx) {
  const rW = isWeapon(ps.weaponR);
  const lW = isWeapon(ps.weaponL);
  if (rW && lW) return hitIdx % 2 === 0;
  if (rW || lW) return rW; // single weapon hand
  return hitIdx % 2 === 0; // unarmed fists: alternate R/L starting with R
}

export function initPlayerStats(romData) {
  const { str, agi, vit, int: int_, mnd, mpIdx } = readJobBaseStats(romData, 0); // Job 0: Onion Knight
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
  ps.stats.exp += amount;
  ps.leveledUp = false;
  while (ps.stats.exp >= ps.stats.expToNext && ps.stats.level < 5) {
    ps.stats.level++;
    const lv = ps.stats.level;

    // HP growth: vit + random(0, floor(vit/2)) + level * 2 (from disasm 35/BECA-BF09)
    const hpGain = ps.stats.vit + Math.floor(Math.random() * (Math.floor(ps.stats.vit / 2) + 1)) + lv * 2;
    ps.stats.maxHP = Math.min(9999, ps.stats.maxHP + hpGain);

    // Stat bonuses from ROM — job 0 (Onion Knight)
    const bonus = readJobLevelBonus(ps._romData, 0, lv);
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

// --- Proficiency system (FF2-style weapon/magic skill) ---
// Points: 100 per level, max level 16. Gain = hits landed per battle.
// Bonus hits: +1 per 4 proficiency levels (so +4 hits at level 16).
// Categories: sword, knife, axe, spear, staff, bow, unarmed, white, black, call

// Maps animation subtype → proficiency category
export const WEAPON_PROF_CATEGORY = {
  sword:     'sword',
  knife:     'knife',
  axe:       'axe',
  hammer:    'axe',
  spear:     'spear',
  staff:     'staff',
  rod:       'staff',
  bow:       'bow',
  arrow:     'bow',
  katana:    'sword',
  claw:      'unarmed',
  nunchaku:  'unarmed',
  book:      'staff',
  bell:      'staff',
  harp:      'staff',
  boomerang: 'bow',
  shuriken:  'knife',
  shield:    'shield',
  unarmed:   'unarmed',
};

export const PROF_CATEGORIES = ['sword','knife','axe','spear','staff','bow','shield','unarmed','white','black','call'];

export function getProfLevel(category) {
  return Math.min(16, Math.floor((ps.proficiency[category] || 0) / 100));
}

export function getProfHits(subtype) {
  const cat = WEAPON_PROF_CATEGORY[subtype] || subtype;
  return Math.floor(getProfLevel(cat) / 4);
}

// Returns effective shield evade% (base + 1% per shield prof level). 0 if no shield equipped.
export function getShieldEvade(ITEMS) {
  const shieldItem = ITEMS.get(ps.weaponR)?.subtype === 'shield' ? ITEMS.get(ps.weaponR)
                   : ITEMS.get(ps.weaponL)?.subtype === 'shield' ? ITEMS.get(ps.weaponL)
                   : null;
  if (!shieldItem) return 0;
  return (shieldItem.evade || 0) + getProfLevel('shield');
}

// Call once per battle victory with { subtype: hitsLanded }
export function gainProficiency(hitsMap) {
  for (const [subtype, hits] of Object.entries(hitsMap)) {
    if (hits <= 0) continue;
    const cat = WEAPON_PROF_CATEGORY[subtype] || subtype;
    ps.proficiency[cat] = Math.min(1600, (ps.proficiency[cat] || 0) + hits);
  }
}

// Call when a spell is cast (magic proficiency gain)
export function gainMagicProficiency(magicType) {
  const cat = magicType === 'white' ? 'white' : magicType === 'black' ? 'black' : magicType === 'call' ? 'call' : null;
  if (!cat) return;
  ps.proficiency[cat] = Math.min(1600, (ps.proficiency[cat] || 0) + 1);
}

export function playerStatsSnapshot() {
  return {
    str: ps.stats.str, agi: ps.stats.agi, vit: ps.stats.vit,
    int: ps.stats.int, mnd: ps.stats.mnd,
    maxHP: ps.stats.maxHP, maxMP: ps.stats.maxMP,
    weaponR: ps.weaponR, weaponL: ps.weaponL,
    head: ps.head, body: ps.body, arms: ps.arms,
  };
}
