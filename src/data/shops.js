// Shop Catalog — store inventories, keyed by shop ID
//
// Item IDs reference ROM item table; names + prices come from items.js / text
// decoder at runtime.
// `mapId` + `counter` identify the tile that opens this shop on Z-press.
// `type` ('weapon'|'armor'|'item'|'magic') drives the FF1-style shopkeeper
// sprite lookup in `data/shop-sprites.js` — render path no-ops when sprite
// data hasn't been captured yet for a given type.

export const SHOPS = new Map([
  // --- Town of Ur ---
  ['ur_weapon', {
    type: 'weapon',
    mapId: 5, counter: { x: 3, y: 15 },
    items: [0x1F, 0x24, 0x0E, 0x06],
    // Dagger, Longsword, Staff, Nunchuck
  }],
  ['ur_armor', {
    type: 'armor',
    mapId: 4, counter: { x: 3, y: 5 },
    items: [0x73, 0x58, 0x62, 0x8B],
    // Leather Armor, Leather Shield, Leather Cap, Bronze Bracers
  }],
  ['ur_item', {
    type: 'item',
    mapId: 8, counter: { x: 8, y: 15 },
    items: [0xA6, 0xAE, 0xAF, 0xA9],
    // Potion, Eye Drops, Antidote
    // TEMP (FenixDown 0xA9): added for revive testing — REMOVE after testing.
  }],
  ['ur_magic', {
    type: 'magic',
    mapId: 3, counter: { x: 4, y: 4 },
    items: [0xE4],
    // Pure scroll (Poisona). 100 gil. Sells the scroll item — player learns
    // by using it from inventory (`pause-menu.js#_applyScrollLearn`).
    // Type stays 'magic' for shopkeeper-sprite lookup; catalog routes
    // through the regular item-shop buy/sell flow (qty selector, sell-back).
    // Higher tiers (Cura, Curaga) ship with their respective magic-shop
    // catalogs as those towns come online.
  }],
]);

// Derive shop type from a shopId. Falls back to inferring from the data
// shape so legacy callers without an explicit `type` still resolve.
export function getShopType(shopId) {
  const shop = SHOPS.get(shopId);
  if (!shop) return null;
  if (shop.type) return shop.type;
  return shop.spells ? 'magic' : 'item';
}

// Reverse lookup: which shop sits at this counter tile?
// Returns shopId string or null.
export function findShopAtCounter(mapId, x, y) {
  for (const [id, shop] of SHOPS) {
    if (shop.mapId === mapId && shop.counter && shop.counter.x === x && shop.counter.y === y) return id;
  }
  return null;
}
