// player-stats.js — player combat stats, equip slots, exp, and derived stat helpers

import { buildExpTable, JOBS, jobLevelStatBonus } from './data/jobs.js';
import { computeJobStats, getJobLevelDelta } from './data/players.js';
import { ITEMS, isWeapon } from './data/items.js';
import { BASE_HIT_RATE, calcAttackerAtk, isRightHandHit } from './battle-math.js';
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
  head: 0x62,      // Leather Cap
  body: 0x72,      // Cloth Armor
  arms: 0x00,
  hitRate: 80,      // effective hit% from weapon
  evade: 0,         // total evade% from armor (non-shield)
  mdef: 0,          // total magic defense from armor
  elemResist: [],   // array of element strings player resists (from armor)
  statusResist: 0,  // bitmask of armor status immunities (NAME_TO_FLAG bits)
  status: { mask: 0, poisonDmgTick: 0 },  // status effect state — persists across battles
  _romData: null,  // stored by initExpTable for use in grantExp
  jobLevels: {},  // { [jobIdx]: { level, jp } } — 100 JP per level, max 99
  jobIdx: 0,            // current job index (0=Onion Knight, 1=Warrior, etc.)
  unlockedJobs: 0x01,   // bitmask: bit N = job N unlocked. 0x01 = only Onion Knight
  cp: 0,                // capacity points (0-255), earned from battles, spent on job changes
  playTime: 0,          // total play time in seconds
  lastTown: 114,        // map ID of last town visited — legacy fallback for respawn
  lastWorldExitX: null, // overworld tile X where player last landed from a structure exit
  lastWorldExitY: null, // overworld tile Y — paired with X, used for death respawn when slain on overworld
  knownSpells: [],      // array of spell IDs the player has learned (granted by job + magic shop)
  buffs: {},            // active battle buffs (haste/protect/reflect). Cleared on resetBattleVars; not persisted.
  // Persistent map mutations — keyed by mapId, then "x,y" coord, value is the
  // new tile byte. Replayed in loadMapById after generateFloor rebuilds the
  // fresh tilemap from ROM, so chests stay opened / secret walls stay
  // revealed / rock puzzles stay solved across map re-entry (and saves).
  // Pre-v1.7.215 these mutations were in-memory only and reset on re-entry,
  // letting players farm chests by exiting and walking back in.
  consumedTiles: {},
};

// Starting spells granted when a player first switches into a mage job.
// Keyed by jobIdx. White Mage = 3, Black Mage = 4, Red Mage = 5.
// School-gating (data/spells.js JOB_SCHOOLS): WM = white only, BM = black
// only, RM = both. RM starts with one entry from each school.
const STARTING_SPELLS = {
  3: [0x34, 0x35, 0x36],       // White Mage: Cure, Poisona, Sight
  4: [0x31, 0x32, 0x33],       // Black Mage: Fire + Bzzard + Sleep
  5: [0x34, 0x31, 0x32, 0x33], // Red Mage: Cure + Fire + Bzzard + Sleep (cross-school starter)
};

export function grantStartingSpells(jobIdx = ps.jobIdx) {
  const list = STARTING_SPELLS[jobIdx];
  if (!list) return;
  for (const id of list) {
    if (!ps.knownSpells.includes(id)) ps.knownSpells.push(id);
  }
}

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
  const jobLv = getJobLevel();
  const jlb = getJobLevelStatBonus(ps.jobIdx, jobLv);
  const effStr = (ps.stats ? ps.stats.str : 5) + strB + jlb.str;
  const effAgi = (ps.stats ? ps.stats.agi : 5) + agiB + jlb.agi;
  ps.atk = calcAttackerAtk({
    rWpnAtk: isWeapon(ps.weaponR) ? (ITEMS.get(ps.weaponR)?.atk || 0) : 0,
    lWpnAtk: isWeapon(ps.weaponL) ? (ITEMS.get(ps.weaponL)?.atk || 0) : 0,
    isMonkClass: ps.jobIdx === 2 || ps.jobIdx === 13,
    level: ps.stats ? ps.stats.level : 1,
    str: effStr,
    jobLevel: jobLv,
  });
  // Hit rate from equipped weapon (or base if unarmed)
  const rWpn = isWeapon(ps.weaponR) ? ITEMS.get(ps.weaponR) : null;
  const lWpn = isWeapon(ps.weaponL) ? ITEMS.get(ps.weaponL) : null;
  ps.hitRate = (rWpn || lWpn) ? (rWpn ? rWpn.hit : lWpn.hit) : BASE_HIT_RATE;
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
  // Status resistance bitmask — OR of armor sResist bytes (NES status immunity)
  let sMask = 0;
  for (const id of allSlots) { sMask |= ITEMS.get(id)?.sResist || 0; }
  ps.statusResist = sMask;
  // DEF with equipment + job level vitality bonus
  recalcDEF(vitB + jlb.vit);
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
  // DEF uses floor(vit/2) to mirror the floor(str/2) attacker formula —
  // without it the asymmetry leaves defenders much tankier than the
  // displayed ATK/DEF spread implies.
  const effVit = (ps.stats ? ps.stats.vit : 4) + vitBonus;
  ps.def = Math.floor(effVit / 2)
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
  // `rHandHitCount` is the input-handler-provided split point (= total / 2
  // for dual/unarmed). v1.7.274 delegates to the shared
  // `isRightHandHit` helper — `totalHits = rHandHitCount * 2` reconstructs
  // the combo length the helper expects.
  const rW = isWeapon(ps.weaponR);
  const lW = isWeapon(ps.weaponL);
  return isRightHandHit(hitIdx, rHandHitCount * 2, rW, lW);
}

export function initPlayerStats(romData) {
  // Stats come from the per-job matrix in data/players.js — same source the
  // fake-player path uses, so a level-N RM has identical numbers whether
  // you're playing the character or fighting one in PVP.
  ps._romData = romData;
  const s = computeJobStats(ps.jobIdx, 1);
  ps.stats = {
    str: s.str, agi: s.agi, vit: s.vit, int: s.int, mnd: s.mnd,
    hp: s.maxHP, maxHP: s.maxHP,
    mp: s.maxMP, maxMP: s.maxMP,
    level: 1, exp: 0, expToNext: 0,
  };
  ps.hp = s.maxHP;
  ps.mp = s.maxMP;
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

    // Per-level stat deltas come from the same matrix the fake-player path
    // uses. Deterministic — at any given level, str = 5 + lv*W, etc. — so a
    // local-player RM and a fake-player RM at the same level have identical
    // numbers. No more ROM random rolls.
    const d = getJobLevelDelta(ps.jobIdx);
    ps.stats.str = Math.min(99, ps.stats.str + d.str);
    ps.stats.agi = Math.min(99, ps.stats.agi + d.agi);
    ps.stats.vit = Math.min(99, ps.stats.vit + d.vit);
    ps.stats.int = Math.min(99, ps.stats.int + d.int);
    ps.stats.mnd = Math.min(99, ps.stats.mnd + d.mnd);
    ps.stats.maxHP = Math.min(9999, ps.stats.maxHP + d.hpGain);
    ps.stats.maxMP += d.mpGain;

    // No full heal on level-up — HP is preserved at whatever it was (current HP is always ≤
    // new maxHP since maxHP only grows). KO'd players stay KO'd so the end-of-battle respawn
    // check in `encounter-box-close` / `enemy-box-close` fires correctly.

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

// Per-job stat bonuses from job level (remake-style scaling). Thin wrapper
// over the pure `jobLevelStatBonus(jobIdx, jobLv)` in data/jobs.js — the
// pure version is shared with the fake-player path (data/players.js).
export function getJobLevelStatBonus(jobIdx = ps.jobIdx, jobLv = getJobLevel(jobIdx)) {
  return jobLevelStatBonus(jobIdx, jobLv);
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

// Gil mutation helpers — single seam for "give the player money" /
// "deduct gil" so the future multiplayer layer can hook delta emission
// from one place instead of 8 inline `ps.gil += X` / `ps.gil -= X` sites.
// No cap yet (see INVENTORY-ECONOMY-AUDIT.md #6 — depends on economy
// design); helpers return the actual amount transacted.
export function grantGil(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const intN = Math.floor(n);
  ps.gil += intN;
  return intN;
}

// Returns true if gil was successfully deducted, false if insufficient.
export function spendGil(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return false;
  const intN = Math.floor(n);
  if (ps.gil < intN) return false;
  ps.gil -= intN;
  return true;
}

// Cost to switch from current job to newJobIdx.
// NES formula (disasm 3D/AD85): cost = (|physDiff| + |chaosDiff|) * 4 - newJobLevel, min 0.
// Alignment byte: high nibble = physical/magical index, low nibble = lawful/chaotic index.
export function jobSwitchCost(newJobIdx) {
  const currAlign = JOBS[ps.jobIdx]?.alignment ?? 0;
  const newAlign = JOBS[newJobIdx]?.alignment ?? 0;
  const physDiff = Math.abs((currAlign >> 4) - (newAlign >> 4));
  const chaosDiff = Math.abs((currAlign & 0xF) - (newAlign & 0xF));
  const newJobLv = getJobLevel(newJobIdx);
  return Math.max(0, (physDiff + chaosDiff) * 4 - newJobLv);
}

export function changeJob(newJobIdx) {
  ps.jobIdx = newJobIdx;
  // Stats for the new job at the current level — single matrix lookup.
  // Deterministic: a job change on a level-N character produces the same
  // numbers it would have if the player had been that job from level 1.
  const s = computeJobStats(newJobIdx, ps.stats.level);
  ps.stats.str = Math.min(99, s.str);
  ps.stats.agi = Math.min(99, s.agi);
  ps.stats.vit = Math.min(99, s.vit);
  ps.stats.int = Math.min(99, s.int);
  ps.stats.mnd = Math.min(99, s.mnd);
  ps.stats.maxHP = s.maxHP;
  ps.stats.maxMP = s.maxMP;
  // Clamp HP/MP to new maximums
  ps.hp = Math.min(ps.hp, s.maxHP); ps.stats.hp = ps.hp;
  ps.mp = Math.min(ps.mp, s.maxMP); ps.stats.mp = ps.mp;
  grantStartingSpells(newJobIdx);
  recalcCombatStats();
}

export function playerStatsSnapshot() {
  return {
    str: ps.stats.str, agi: ps.stats.agi, vit: ps.stats.vit,
    int: ps.stats.int, mnd: ps.stats.mnd,
    maxHP: ps.stats.maxHP, maxMP: ps.stats.maxMP, hp: ps.hp,
    weaponR: ps.weaponR, weaponL: ps.weaponL,
    head: ps.head, body: ps.body, arms: ps.arms,
    hitRate: ps.hitRate, evade: ps.evade, mdef: ps.mdef,
  };
}
