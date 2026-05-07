// Shop Catalog — store inventories, keyed by shop ID
//
// Item IDs reference ROM item table; names + prices come from items.js / text
// decoder at runtime.
// `mapId` + `counter` identify the tile that opens this shop on Z-press.
// Magic shops use `spells:` instead of `items:` and are not yet wired.

export const SHOPS = new Map([
  // --- Town of Ur ---
  ['ur_weapon', {
    mapId: 5, counter: { x: 3, y: 15 },
    items: [0x1F, 0x24, 0x0E, 0x06, 0x4A, 0x4F],
    // Dagger, Longsword, Staff, Nunchuck, Bow, Wooden Arrow
  }],
  ['ur_armor', {
    mapId: 4, counter: { x: 3, y: 5 },
    items: [0x73, 0x58, 0x62, 0x8B],
    // Leather Armor, Leather Shield, Leather Cap, Bronze Bracers
  }],
  ['ur_item', {
    mapId: 8, counter: { x: 8, y: 15 },
    items: [0xA6, 0xAE, 0xAF],
    // Potion, Eye Drops, Antidote
  }],
  ['ur_magic', {
    mapId: 3, counter: { x: 4, y: 4 },
    spells: [0x34, 0x35, 0x36],
    // Cure, Poisona, Sight (White Magic Lv1) — 100 gil each, NES canon for starter town.
    // Higher tiers (Cura/Cure2 in mid-game towns, Curaga/Cure3 later) ship with
    // their respective magic-shop catalogs as those towns come online.
  }],
]);

// Reverse lookup: which shop sits at this counter tile?
// Returns shopId string or null.
export function findShopAtCounter(mapId, x, y) {
  for (const [id, shop] of SHOPS) {
    if (shop.mapId === mapId && shop.counter && shop.counter.x === x && shop.counter.y === y) return id;
  }
  return null;
}
