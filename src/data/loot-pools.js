// Chest + vase loot tables. v1.7.777 — extracted from src/map-triggers.js
// for shared client + server use (the PvE economy arbiter rolls server-side).
//
// Tier shape: { weight, pool: [<item id> | { gil: [min, max] }] }  OR  { weight, monster: true }
// `rollLootEntry(mapId, rng?)` is pure — pass any RNG fn (defaults to Math.random)
// to get a deterministic roll. Server uses `createRng(seed).rand`.

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
};
export const DEFAULT_LOOT = LOOT_POOLS[1000];
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
  if (mapId === 1010) {
    // Locked-room chest: pick a random altar floor (1000-1003) and roll its pool.
    const altarFloors = [1000, 1001, 1002, 1003];
    mapId = altarFloors[Math.floor(rng() * altarFloors.length)];
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
