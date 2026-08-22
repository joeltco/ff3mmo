// Chest + vase loot tables. v1.7.777 — extracted from src/map-triggers.js
// for shared client + server use (the PvE economy arbiter rolls server-side).
//
// Tier shape: { weight, pool: [<item id> | { gil: [min, max] }] }  OR  { weight, monster: true }
// `rollLootEntry(mapId, rng?)` is pure — pass any RNG fn (defaults to Math.random)
// to get a deterministic roll. Server uses `createRng(seed).rand`.

import { sideRoomForMapId, normalFloorMapIds, STARTING_DUNGEON } from './dungeons.js';

const GIL = (min, max) => ({ gil: [min, max] });

export const LOOT_POOLS = {
  114: [ // Ur (town)
    { weight: 70, pool: [0xA6, 0xA6, 0xAF] },                     // Potion(2x), Antidote
    { weight: 30, pool: [GIL(10, 30)] },
  ],
  1000: [ // Altar Cave F1
    { weight: 16, pool: [0xA6] },
    { weight: 30, pool: [GIL(20, 60)] },
    { weight: 15, pool: [0x62] },
    { weight:  3, pool: [0xE3, 0xE1] },
    { weight:  3, pool: [0x98] },
    { weight: 12, monster: true },
  ],
  1001: [ // Altar Cave F2
    { weight: 12, pool: [0xA6] },
    { weight: 30, pool: [GIL(40, 100)] },
    { weight: 20, pool: [0x62, 0x1F, 0x06, 0x0E] },
    { weight:  5, pool: [0x58] },
    { weight:  3, pool: [0xE3, 0xE1] },
    { weight:  3, pool: [0x98] },
    { weight:  2, pool: [0xA9] },
    { weight: 12, monster: true },
  ],
  1002: [ // Altar Cave F3
    { weight:  9, pool: [0xA6] },
    { weight: 30, pool: [GIL(75, 175)] },
    { weight: 25, pool: [0x58, 0x1F] },
    { weight: 10, pool: [0x73] },
    { weight:  3, pool: [0xE3, 0xE1] },
    { weight:  3, pool: [0x98] },
    { weight:  2, pool: [0xA9] },
    { weight: 12, monster: true },
  ],
  1003: [ // Altar Cave F4
    { weight:  6, pool: [0xA6] },
    { weight: 30, pool: [GIL(125, 275)] },
    { weight: 25, pool: [0x73, 0x1F] },
    { weight: 20, pool: [0x8B, 0x24] },
    { weight:  3, pool: [0xE3, 0xE1] },
    { weight:  3, pool: [0x98] },
    { weight:  3, pool: [0xA9] },
    { weight: 12, monster: true },
  ],
  // --- Cave of Seals (2000-2002) ---
  //
  // ⛔ A DESIGN CHOICE, LIKE ALTAR CAVE'S. There is no ROM provenance for a
  // procedural dungeon's loot table: the cartridge has fixed chests at fixed
  // spots, and this game rolls pools for every chest including towns
  // (`UR_CHEST_MAPS` -> `LOOT_POOLS[114]`). What IS taken from the ROM is the
  // TIER: this dungeon's monsters are lv4-6 against Altar Cave's lv1-2, so the
  // curve continues from Altar F4 (gil 125-275) rather than restarting.
  // Item ids and prices are read off `data/items.js`, which is ROM-generated.
  2000: [ // Seals F1 — picks up where Altar F4 left off
    { weight:  8, pool: [0xA6] },                       // Potion
    { weight: 30, pool: [GIL(150, 320)] },
    { weight: 22, pool: [0x24, 0x73] },                 // Longsword, Leathor
    { weight: 15, pool: [0x8B, 0x1F] },                 // BrnzeBrac, Dagger
    { weight:  4, pool: [0xE3, 0xE1] },                 // Cure / I scrolls
    { weight:  3, pool: [0xA9] },                       // PhoexDown
    { weight: 12, monster: true },                      // mimic
  ],
  2001: [ // Seals F2
    { weight:  6, pool: [0xA6] },
    { weight: 30, pool: [GIL(220, 450)] },
    { weight: 24, pool: [0x09, 0x65] },                 // MythrilRod, Shell Helm
    { weight: 16, pool: [0x20, 0x27] },                 // MythrKfe, MythrSwrd
    { weight:  5, pool: [0xE3, 0xE1] },
    { weight:  4, pool: [0xA9] },
    { weight: 12, monster: true },
  ],
  2002: [ // Seals F3 — deepest normal floor
    { weight:  4, pool: [0xA6] },
    { weight: 30, pool: [GIL(300, 650)] },
    { weight: 24, pool: [0x27, 0x07] },                 // MythrSwrd, Tonfa
    { weight: 18, pool: [0x25, 0x76] },                 // Wislayer, She Armor
    { weight:  5, pool: [0xE3, 0xE1] },
    { weight:  5, pool: [0xA9] },
    { weight: 12, monster: true },
  ],
};
export const DEFAULT_LOOT = LOOT_POOLS[STARTING_DUNGEON.base];
export const UR_CHEST_MAPS = new Set([114, 1, 2, 3, 4, 5, 6, 7, 8, 9, 147]);

// Pure roll. Pass rng() for deterministic / seeded callers. Returns:
//   { monster: true }                  — chest mimic; caller spawns battle
//   { gil: amount }                    — gil pickup
//   <item id: number>                  — item pickup
function _resolveTier(tier, rng) {
  if (tier.monster) return { monster: true };
  const entry = tier.pool[Math.floor(rng() * tier.pool.length)];
  if (typeof entry === 'object' && entry.gil) {
    const [min, max] = entry.gil;
    return { gil: min + Math.floor(rng() * (max - min + 1)) };
  }
  return entry;
}

export function rollLootEntry(mapId, rng = Math.random) {
  const _side = sideRoomForMapId(mapId);
  if (_side?.kind === 'locked') {
    // Locked-room chest: roll ANY of its dungeon's normal floors, so the room
    // can hand out deeper-floor loot the player has not reached yet (v1.7.675).
    const floors = normalFloorMapIds(_side.dungeon);
    mapId = floors[Math.floor(rng() * floors.length)];
  }
  let tiers = LOOT_POOLS[mapId];
  if (!tiers && UR_CHEST_MAPS.has(mapId)) tiers = LOOT_POOLS[114];
  if (!tiers) tiers = DEFAULT_LOOT;
  const total = tiers.reduce((s, t) => s + t.weight, 0);
  let roll = rng() * total;
  for (const t of tiers) {
    if (roll < t.weight) return _resolveTier(t, rng);
    roll -= t.weight;
  }
  return _resolveTier(tiers[0], rng);
}

// Same as rollLootEntry but filters out mimic tiers + non-item gil tiers
// not really — keeps gil because vases drop gil too. Just drops `monster` tiers
// (vase = "search here" not "spawn a battle"). Mirrors the filter in
// src/map-triggers.js#rollHiddenTreasureLoot.
export function rollVaseLoot(mapId, rng = Math.random) {
  let tiers = LOOT_POOLS[mapId];
  if (!tiers && UR_CHEST_MAPS.has(mapId)) tiers = LOOT_POOLS[114];
  if (!tiers) tiers = DEFAULT_LOOT;
  tiers = tiers.filter(t => !t.monster);
  if (tiers.length === 0) return null;
  const total = tiers.reduce((s, t) => s + t.weight, 0);
  let roll = rng() * total;
  for (const t of tiers) {
    if (roll < t.weight) return _resolveTier(t, rng);
    roll -= t.weight;
  }
  return _resolveTier(tiers[0], rng);
}
