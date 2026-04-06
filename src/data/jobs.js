// FF3 NES job (class) data and ROM readers

// ROM offsets (iNES +16 header)
export const BATTLE_SPRITE_ROM    = 0x050010;  // Bank 28/$8000 — battle character graphics (disasm 2F/AB3D)
export const BATTLE_JOB_SIZE      = 0x02A0;    // 672 bytes (42 tiles) per job
export const BATTLE_PAL_ROM       = 0x05CF04;  // char palette 0 — 3 bytes (colors 1-3, color 0 = $0F)
export const JOB_BASE_STATS_OFF   = 0x072010;  // 22 jobs × 8 bytes: [adj, minLvl, STR, AGI, VIT, INT, MND, mpIdx]
export const CHAR_INIT_HP_OFF     = 0x073BE8;  // 2 bytes little-endian
export const CHAR_INIT_MP_OFF     = 0x073B98;  // 10 entries × 8 bytes (indexed by job mpIdx)
export const LEVEL_EXP_TABLE_OFF  = 0x0720C0;  // 98 × 3 bytes (24-bit LE per level)
export const LEVEL_STAT_BONUS_OFF = 0x0721E6;  // 22 jobs × 98 levels × 2 bytes

// Weapon type flags (bitmask for job.weapons)
export const WPN_SWORD    = 0x001;
export const WPN_KNIFE    = 0x002;
export const WPN_BOW      = 0x004;
export const WPN_STAFF    = 0x008;
export const WPN_ROD      = 0x010;
export const WPN_BOOK     = 0x020;
export const WPN_BELL     = 0x040;
export const WPN_HARP     = 0x080;
export const WPN_SPEAR    = 0x100;
export const WPN_AXE      = 0x200;  // includes hammers
export const WPN_CLAW     = 0x400;
export const WPN_KATANA   = 0x800;
export const WPN_BOOMERANG = 0x1000;
export const WPN_SHURIKEN  = 0x2000;
export const WPN_ARROW     = 0x4000;
export const WPN_ALL       = 0x7FFF;

// Armor type flags (bitmask for job.armor)
export const ARM_SHIELD   = 0x01;
export const ARM_HELMET   = 0x02;
export const ARM_BODY     = 0x04;
export const ARM_GLOVES   = 0x08;
export const ARM_ALL      = 0x0F;
export const ARM_LIGHT    = ARM_HELMET | ARM_BODY | ARM_GLOVES;  // no shield

// Magic type flags (bitmask for job.magic)
export const MAG_WHITE    = 0x01;
export const MAG_BLACK    = 0x02;
export const MAG_CALL     = 0x04;  // summon/call magic

// 22 jobs in ROM order — cpCost and lvReq from ROM $72010 (Data Crystal)
// NES names: OnionKid, Fighter, Monk, WhiteWiz, BlackWiz, RedWiz, Hunter,
//            Knight, Thief, Scholar, Geomancer, Dragoon, Viking, Karateka,
//            M.Knight, Conjurer, Bard, Summoner, Shaman, Warlock, Sage, Ninja
export const JOBS = [
  // idx  name             weapons                                          armor                        magic            maxMagicLv  cpCost  lvReq
  { name: 'Onion Knight', weapons: WPN_SWORD | WPN_KNIFE | WPN_BOW | WPN_ARROW, armor: ARM_ALL,           magic: 0,         maxMagicLv: 0, cpCost: 136, lvReq:  0 },
  { name: 'Fighter',      weapons: WPN_SWORD | WPN_KNIFE | WPN_BOW | WPN_ARROW, armor: ARM_ALL,          magic: 0,         maxMagicLv: 0, cpCost: 121, lvReq:  0 },
  { name: 'Monk',         weapons: 0,                                      armor: ARM_LIGHT,            magic: 0,         maxMagicLv: 0, cpCost: 119, lvReq:  0 },
  { name: 'White Mage',   weapons: WPN_STAFF | WPN_ROD,                    armor: ARM_LIGHT,            magic: MAG_WHITE, maxMagicLv: 7, cpCost: 153, lvReq:  0 },
  { name: 'Black Mage',   weapons: WPN_KNIFE | WPN_ROD,                    armor: ARM_LIGHT,            magic: MAG_BLACK, maxMagicLv: 7, cpCost: 151, lvReq:  0 },
  { name: 'Red Mage',     weapons: WPN_SWORD | WPN_KNIFE | WPN_BOW | WPN_STAFF | WPN_ROD | WPN_ARROW, armor: ARM_ALL, magic: MAG_WHITE | MAG_BLACK, maxMagicLv: 4, cpCost: 138, lvReq:  0 },
  { name: 'Ranger',       weapons: WPN_BOW,                                armor: ARM_LIGHT,            magic: MAG_WHITE, maxMagicLv: 3, cpCost: 123, lvReq:  9 },
  { name: 'Knight',       weapons: WPN_SWORD | WPN_KNIFE | WPN_BOOMERANG,   armor: ARM_ALL,              magic: 0,         maxMagicLv: 0, cpCost: 140, lvReq:  9 },
  { name: 'Thief',        weapons: WPN_KNIFE | WPN_BOOMERANG,              armor: ARM_ALL,              magic: 0,         maxMagicLv: 0, cpCost: 117, lvReq:  9 },
  { name: 'Scholar',      weapons: WPN_BOOK,                               armor: ARM_LIGHT,            magic: 0,         maxMagicLv: 0, cpCost: 170, lvReq:  9 },
  { name: 'Geomancer',    weapons: WPN_BELL,                               armor: ARM_LIGHT,            magic: 0,         maxMagicLv: 0, cpCost: 164, lvReq: 14 },
  { name: 'Dragoon',      weapons: WPN_SPEAR,                              armor: ARM_ALL,              magic: 0,         maxMagicLv: 0, cpCost:  91, lvReq: 14 },
  { name: 'Viking',       weapons: WPN_AXE,                                armor: ARM_ALL,              magic: 0,         maxMagicLv: 0, cpCost:  85, lvReq: 14 },
  { name: 'Black Belt',   weapons: WPN_CLAW,                               armor: ARM_LIGHT,            magic: 0,         maxMagicLv: 0, cpCost:  40, lvReq: 14 },
  { name: 'Magic Knight', weapons: WPN_KATANA | WPN_SWORD | WPN_BOOMERANG,  armor: ARM_ALL,              magic: MAG_WHITE, maxMagicLv: 3, cpCost: 130, lvReq: 14 },
  { name: 'Conjurer',     weapons: WPN_ROD,                                armor: ARM_LIGHT,            magic: MAG_CALL,  maxMagicLv: 8, cpCost: 216, lvReq: 14 },
  { name: 'Bard',         weapons: WPN_HARP,                               armor: ARM_LIGHT,            magic: 0,         maxMagicLv: 0, cpCost: 187, lvReq: 14 },
  { name: 'Summoner',     weapons: WPN_ROD,                                armor: ARM_LIGHT,            magic: MAG_CALL,  maxMagicLv: 8, cpCost: 196, lvReq: 29 },
  { name: 'Devout',       weapons: WPN_STAFF | WPN_ROD,                    armor: ARM_LIGHT,            magic: MAG_WHITE, maxMagicLv: 8, cpCost: 204, lvReq: 29 },
  { name: 'Magus',        weapons: WPN_ROD,                                armor: ARM_LIGHT,            magic: MAG_BLACK, maxMagicLv: 8, cpCost: 240, lvReq: 29 },
  { name: 'Sage',         weapons: WPN_ROD | WPN_STAFF | WPN_BOOK,         armor: ARM_LIGHT,            magic: MAG_WHITE | MAG_BLACK | MAG_CALL, maxMagicLv: 8, cpCost: 255, lvReq: 39 },
  { name: 'Ninja',        weapons: WPN_ALL,                                armor: ARM_ALL,              magic: 0,         maxMagicLv: 0, cpCost:   0, lvReq: 39 },
];

// Convenience — job names array in ROM order
export const JOB_NAMES = JOBS.map(j => j.name);

// Base stats for a job at level 1
// Returns { str, agi, vit, int, mnd, mpIdx }
export function readJobBaseStats(romData, jobIdx) {
  const off = JOB_BASE_STATS_OFF + jobIdx * 8;
  return {
    str:   romData[off + 2],
    agi:   romData[off + 3],
    vit:   romData[off + 4],
    int:   romData[off + 5],
    mnd:   romData[off + 6],
    mpIdx: romData[off + 7],
  };
}

// Starting HP (2 bytes little-endian)
export function readStartingHP(romData) {
  return romData[CHAR_INIT_HP_OFF] | (romData[CHAR_INIT_HP_OFF + 1] << 8);
}

// Starting MP for a given mpIdx (8 bytes per entry, take level 1)
export function readStartingMP(romData, mpIdx) {
  return romData[CHAR_INIT_MP_OFF + mpIdx * 8];
}

// Stat/MP bonuses granted at a level-up
// Returns { str, agi, vit, int, mnd, mpGain } — add each to the corresponding stat
export function readJobLevelBonus(romData, jobIdx, level) {
  const off = LEVEL_STAT_BONUS_OFF + jobIdx * 196 + (level - 1) * 2;
  const byte1 = romData[off];
  const byte2 = romData[off + 1];
  const amt = byte1 & 0x07;
  let mpBits = byte2, mpGain = 0;
  while (mpBits) { mpGain += mpBits & 1; mpBits >>= 1; }
  return {
    str: (byte1 & 0x80) ? amt : 0,
    agi: (byte1 & 0x40) ? amt : 0,
    vit: (byte1 & 0x20) ? amt : 0,
    int: (byte1 & 0x10) ? amt : 0,
    mnd: (byte1 & 0x08) ? amt : 0,
    mpGain,
  };
}

// Check if job can equip an item (by item ID, needs ITEMS map passed in)
// Uses per-item jobs bitmask where bit N = job index N can equip
export function canJobEquip(jobIdx, itemId, ITEMS) {
  if (!itemId) return true;
  const item = ITEMS.get(itemId);
  if (!item) return true;
  if (item.jobs === undefined) return true;
  return !!(item.jobs & (1 << jobIdx));
}

// Build full exp-to-next table (98 levels, 24-bit LE each)
export function buildExpTable(romData) {
  const table = new Uint32Array(98);
  for (let i = 0; i < 98; i++) {
    const off = LEVEL_EXP_TABLE_OFF + i * 3;
    table[i] = romData[off] | (romData[off + 1] << 8) | (romData[off + 2] << 16);
  }
  return table;
}
