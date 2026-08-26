// THE LOOT REGISTRY — one named table per PLACE, and the one resolver.
//
// ⛔ WHY THIS EXISTS. Loot was keyed by raw `mapId` with a hand-copied special
// case and a global fallback that pointed at a REAL DUNGEON'S TABLE:
//
//     let tiers = LOOT_POOLS[mapId];
//     if (!tiers && UR_CHEST_MAPS.has(mapId)) tiers = LOOT_POOLS[114];
//     if (!tiers) tiers = DEFAULT_LOOT;            // === LOOT_POOLS[1000]
//
// That exact chain was written SIX TIMES — twice in data/loot-pools.js, twice in
// map-triggers.js, twice in economy-arbiter.js — across client AND server. Six
// copies of one rule is six chances for the two halves of the economy to
// disagree about what a chest may contain.
//
// It was also WRONG, measurably. `tools/valley-loot-audit.mjs` walks every
// treasure tile the player can actually reach in the beginner valley:
//
//     area            tiles | own table | Ur fallback | ALTAR-CAVE fallback
//     UR                 14 |         2 |          12 |                   0
//     KAZUS               2 |         0 |           0 |                   2
//     CASTLE SASUNE      11 |         0 |           0 |                  11
//     ALTAR CAVE         12 |        12 |           0 |                   0
//     SEALED CAVE         5 |         5 |           0 |                   0
//                        44 |        19 |          12 |                  13
//
// ⛔ THIRTEEN treasure tiles — every one in Kazus and Castle Sasune — rolled the
// OPENING DUNGEON'S FLOOR-1 TABLE, mimic tier and all. A chest in the king's
// castle could turn into an Altar Cave goblin. Nobody designed that; it is what
// "fall back to DEFAULT_LOOT" means when nobody wrote a table.
//
// ⛔ AND `UR_CHEST_MAPS` WAS A DUPLICATE. It listed `{1,2,3,4,5,6,7,8,9,114,147}`
// — byte for byte the map set `data/areas.js` already declares for Ur. Add a
// room to Ur and its chests silently start rolling the Altar Cave's table.
//
// ── THE SHAPE ─────────────────────────────────────────────────────────────
//
// A table is named after the PLACE, not numbered after a map:
//
//     ur_town, ur_interior, kazus_town, sasune, altar_f1..f4, seals_f1..f3
//
// and a map finds its table through the registries that ALREADY say where a map
// belongs — `AREAS` for towns, `DUNGEONS` for floors. Nothing is keyed by a bare
// map id and nothing is special-cased by hand.
//
// Tier shape is unchanged: `{ weight, pool: [<item id> | { gil: [min,max] }] }`
// or `{ weight, monster: true }`.

import { AREAS } from './areas.js';
import { DUNGEONS, sideRoomForMapId, normalFloorMapIds } from './dungeons.js';

const GIL = (min, max) => ({ gil: [min, max] });

/**
 * ⚠ UNDESIGNED — a real place with real chests and no table written for it.
 *
 * Kazus and Castle Sasune are here. They are NOT given a dungeon's table: a
 * chest in a castle must not be able to eat you. This is the town baseline —
 * gil and consumables, no mimic, nothing above what the local shops sell — and
 * `check-loot-tables.mjs` LISTS every place still using it so the debt is
 * visible instead of silent.
 *
 * ⛔ Do not "fix" this by pointing it at a dungeon. That is the bug it replaces.
 */
export const UNDESIGNED = [
  { weight: 55, pool: [GIL(20, 80)] },
  { weight: 30, pool: [0xA6] },                 // Potion
  { weight: 15, pool: [0xAF, 0xAE] },           // Antidote, Eyedrop
];

export const LOOT_TABLES = {
  // ── Towns ───────────────────────────────────────────────────────────────
  ur_town: [
    { weight: 70, pool: [0xA6, 0xA6, 0xAF] },   // Potion x2, Antidote
    { weight: 30, pool: [GIL(10, 30)] },
  ],

  // ⭐ KAZUS TIER — Joel, 2026-08-26: Castle Sasune's chests get "kazus loot".
  //
  // Kazus is the mythril town, and its shops are the valley's second tier:
  // armour 120-350 G, weapons 400-500 G. Sasune sits beside it in progression
  // and its eleven chests had no table at all, so both places roll this.
  //
  // ⭐ AT SHOP TIER ON PURPOSE — also Joel's call, and it is what the CARTRIDGE
  // does: FF3's own Ur chests hold Long sword, Leather, Dagger and Staff, every
  // one of them sold in Ur's shops. A chest here saves you the gil, it does not
  // hand you something unbuyable.
  //
  // ⛔ An earlier pass in this session asserted the opposite — "a chest never
  // offers what a valley shop stocks" — as a design principle. That was
  // invented, nobody asked for it, and the cartridge disproves it. Do not
  // reintroduce it.
  kazus_tier: [
    { weight: 30, pool: [GIL(60, 180)] },
    { weight: 20, pool: [0xA6] },                       // Potion
    { weight: 14, pool: [0xAF, 0xAE] },                 // Antidote, Eyedrop
    { weight: 10, pool: [0xAC, 0xAB] },                 // EchoHerb, MaidKiss
    { weight: 16, pool: [0x8D, 0x8E, 0x64] },           // Mithril gloves x2, helm
    { weight:  7, pool: [0x5A, 0x75] },                 // Mithril shield, mail
    { weight:  3, pool: [0x09] },                       // Mithril rod
  ],

  // ── Altar Cave ──────────────────────────────────────────────────────────
  altar_f1: [
    { weight: 16, pool: [0xA6] },
    { weight: 30, pool: [GIL(20, 60)] },
    { weight: 15, pool: [0x62] },
    { weight:  3, pool: [0xE3, 0xE1] },
    { weight:  3, pool: [0x98] },
    { weight: 12, monster: true },
  ],
  altar_f2: [
    { weight: 12, pool: [0xA6] },
    { weight: 30, pool: [GIL(40, 100)] },
    { weight: 20, pool: [0x62, 0x1F, 0x06, 0x0E] },
    { weight:  5, pool: [0x58] },
    { weight:  3, pool: [0xE3, 0xE1] },
    { weight:  3, pool: [0x98] },
    { weight: 12, monster: true },
  ],
  altar_f3: [
    { weight:  9, pool: [0xA6] },
    { weight: 30, pool: [GIL(75, 175)] },
    { weight: 25, pool: [0x58, 0x1F] },
    { weight: 10, pool: [0x73] },
    { weight:  3, pool: [0xE3, 0xE1] },
    { weight:  3, pool: [0x98] },
    { weight: 12, monster: true },
  ],
  altar_f4: [
    { weight:  6, pool: [0xA6] },
    { weight: 30, pool: [GIL(125, 275)] },
    { weight: 25, pool: [0x73, 0x1F] },
    { weight: 20, pool: [0x8B, 0x24] },
    { weight:  3, pool: [0xE3, 0xE1] },
    { weight:  3, pool: [0x98] },
    { weight: 12, monster: true },
  ],

  // ⛔ THREE ITEMS REMOVED 2026-08-26 — they are not from here.
  //
  // Read out of the ROM's own chest table (`0x3C10`) and bracketed to the maps
  // that hold them by the per-map chest base (map property byte 12). The
  // beginner valley is areas $18 $26 $30 $65 $6c $6d:
  //
  //   Carapace  0x65 / 0x76  ->  map 161, area $37 — VIKING'S COVE. The only
  //                              two Carapace chests in the entire cartridge,
  //                              adjacent, in a cove 41 tiles from Ur that NO
  //                              vehicle in this game can reach: on foot 267
  //                              tiles, canoe 296, airship 304, and it is in
  //                              none of them. Hand-typed into these tables on
  //                              2026-08-22 as "Shell Helm" / "She Armor".
  //   WSlayer   0x25         ->  maps 140 ($46) and 170 ($1e). Also elsewhere.
  //   FenixDown 0xA9         ->  maps 164 74 177 120 126 136 143 183 166 170 —
  //                              TEN chests and not one in the valley. 3000 G,
  //                              in six of eight tables, in dungeons whose
  //                              chests skip the server replay gate.
  //
  // ⛔ NOTHING WAS PUT IN THEIR PLACE. The weights simply redistribute. What
  // SHOULD be here is a separate decision and inventing a replacement is the
  // mistake that produced docs/SEALED-CAVE-LOOT-PLAN.md §4.
  //
  // What the cartridge DOES place in the valley, same method: Long sword (map
  // 103, the Sealed Cave itself), Mithril sword (84, $18), Tonfa (23, Castle
  // Sasune), Mithril rod (191), Copper (175), Potion (all over).
  //
  // ── Cave of Seals ───────────────────────────────────────────────────────
  //
  // ⚠ CARRIED OVER UNCHANGED FROM `LOOT_POOLS[2000..2002]`, and known to be
  // wrong — `docs/SEALED-CAVE-LOOT-PLAN.md` §1 measures why: two of three floors
  // drop gear the valley's shops already sell, and the deepest floor puts the
  // two most valuable items in the region at ~9% each in a dungeon whose chests
  // deliberately skip the server's replay gate. This module is the PLUMBING
  // pass; the contents are a separate decision and are not being invented here.
  seals_f1: [
    { weight:  8, pool: [0xA6] },
    { weight: 30, pool: [GIL(150, 320)] },
    { weight: 22, pool: [0x24, 0x73] },
    { weight: 15, pool: [0x8B, 0x1F] },
    { weight:  4, pool: [0xE3, 0xE1] },
    { weight: 12, monster: true },
  ],
  seals_f2: [
    { weight:  6, pool: [0xA6] },
    { weight: 30, pool: [GIL(220, 450)] },
    { weight: 24, pool: [0x09] },
    { weight: 16, pool: [0x20, 0x27] },
    { weight:  5, pool: [0xE3, 0xE1] },
    { weight: 12, monster: true },
  ],
  seals_f3: [
    { weight:  4, pool: [0xA6] },
    { weight: 30, pool: [GIL(300, 650)] },
    { weight: 24, pool: [0x27, 0x07] },
    { weight:  5, pool: [0xE3, 0xE1] },
    { weight: 12, monster: true },
  ],
};

// ── Which place owns which table ──────────────────────────────────────────
//
// ⛔ BY AREA / DUNGEON ROW, never by a hand-listed map set. `AREAS` already
// knows every map in Ur; `DUNGEONS` already knows every floor of a dungeon.

/** Area `loc` -> table name. An area absent here is UNDESIGNED, on purpose. */
export const AREA_LOOT = {
  ur: 'ur_town',
  // ⭐ Sasune rolls KAZUS's table, per Joel — the castle is that tier, and its
  // eleven chests were falling through to the Altar Cave's floor-1 table before
  // v1.10.92 and to the bare town baseline after it.
  kazus: 'kazus_tier',
  sasune: 'kazus_tier',
  'sasune-throne': 'kazus_tier',
};

/** Dungeon id -> its per-floor table names, shallowest first. */
export const DUNGEON_LOOT = {
  altar: ['altar_f1', 'altar_f2', 'altar_f3', 'altar_f4'],
  seals: ['seals_f1', 'seals_f2', 'seals_f3'],
};

// mapId -> table name, built once from the registries above.
const _byMap = new Map();
for (const [loc, table] of Object.entries(AREA_LOOT)) {
  const area = AREAS.find((a) => a.loc === loc);
  if (!area) continue;
  _byMap.set(area.head, table);
  for (const mapId of area.rooms.keys()) _byMap.set(mapId, table);
}
for (const d of DUNGEONS) {
  const names = DUNGEON_LOOT[d.id] || [];
  normalFloorMapIds(d).forEach((mapId, i) => { if (names[i]) _byMap.set(mapId, names[i]); });
}

/** Every map that resolves to a real (non-UNDESIGNED) table. For gates. */
export function mappedLootMaps() { return new Map(_byMap); }

/**
 * The table for a map, and whether it is a designed one.
 *
 * ⛔ THE ONLY RESOLVER. Six copies of this chain used to live in three files;
 * every caller — client roll, vase roll, and the server's economy arbiter —
 * goes through here so the two halves of the economy cannot disagree.
 */
export function lootTableFor(mapId, rng = Math.random) {
  // Locked-room chest: roll ANY of its dungeon's normal floors, so the room can
  // hand out deeper-floor loot the player has not reached yet (v1.7.675).
  const side = sideRoomForMapId(mapId);
  if (side?.kind === 'locked') {
    const floors = normalFloorMapIds(side.dungeon);
    mapId = floors[Math.floor(rng() * floors.length)];
  }
  const name = _byMap.get(mapId);
  if (name && LOOT_TABLES[name]) return { name, tiers: LOOT_TABLES[name], designed: true };
  return { name: 'UNDESIGNED', tiers: UNDESIGNED, designed: false };
}

// ── The roll ──────────────────────────────────────────────────────────────

/**
 * Pick a map's loot, RAW — the pool entry itself, gil left as `{gil:[min,max]}`.
 *
 * ⛔ ONE PICKER. `rollLootEntry` and `rollVaseLoot` differed by a single
 * `.filter(t => !t.monster)` and were otherwise copy-paste, and `map-triggers.js`
 * carried a third and fourth copy of the same loop. A vase is "search here", not
 * "spawn a battle" — that is the whole difference.
 *
 * The client wants the raw tuple so it can roll the amount with the same RNG it
 * uses for everything else (v1.7.777); `rollLoot` below resolves it for callers
 * that just want a number.
 *
 * `kind` is 'chest' or 'vase'. Returns `{monster:true}` | `{gil:[min,max]}` |
 * `<item id>` | null.
 */
export function pickLootEntry(mapId, kind = 'chest', rng = Math.random) {
  let { tiers } = lootTableFor(mapId, rng);
  if (kind === 'vase') tiers = tiers.filter((t) => !t.monster);
  if (!tiers.length) return null;
  const total = tiers.reduce((s, t) => s + t.weight, 0);
  let roll = rng() * total;
  let tier = tiers[0];
  for (const t of tiers) { if (roll < t.weight) { tier = t; break; } roll -= t.weight; }
  if (tier.monster) return { monster: true };
  return tier.pool[Math.floor(rng() * tier.pool.length)];
}

/**
 * Same pick, with gil resolved to a single amount.
 * Returns `{ monster: true }` | `{ gil: <n> }` | `<item id>` | null.
 */
export function rollLoot(mapId, kind = 'chest', rng = Math.random) {
  const entry = pickLootEntry(mapId, kind, rng);
  if (entry && typeof entry === 'object' && entry.gil) {
    const [min, max] = entry.gil;
    return { gil: min + Math.floor(rng() * (max - min + 1)) };
  }
  return entry;
}

/**
 * Everything a map COULD yield — `{ items, gilMax, hasMonster }`.
 *
 * ⛔ THE SERVER'S UNION CHECK, and it must be derived from the same tables the
 * client rolls or the arbiter rejects legitimate claims. `economy-arbiter.js`
 * carried two hand-written copies of this walk plus two more copies of the
 * fallback chain; drift between them is a player being told their real chest is
 * a forgery.
 *
 * ⛔ A LOCKED ROOM IS THE UNION OF ITS DUNGEON'S FLOORS. `lootTableFor` picks
 * ONE floor at random for a roll, which is right for rolling and wrong for
 * validating — the server has to accept whichever floor the client rolled.
 */
export function resolvedPoolFor(mapId, kind = 'chest') {
  let tiers;
  const side = sideRoomForMapId(mapId);
  if (side?.kind === 'locked') {
    tiers = [];
    for (const floorId of normalFloorMapIds(side.dungeon)) {
      const name = _byMap.get(floorId);
      if (name && LOOT_TABLES[name]) tiers = tiers.concat(LOOT_TABLES[name]);
    }
    if (!tiers.length) tiers = UNDESIGNED;
  } else {
    tiers = lootTableFor(mapId, () => 0).tiers;
  }
  if (!tiers || !tiers.length) return null;
  const items = new Set();
  let gilMax = 0, hasMonster = false;
  for (const t of tiers) {
    if (t.monster) { if (kind === 'chest') hasMonster = true; continue; }
    for (const e of t.pool) {
      if (typeof e === 'number') items.add(e);
      else if (e && e.gil) gilMax = Math.max(gilMax, e.gil[1] | 0);
    }
  }
  return { items, gilMax, hasMonster };
}
