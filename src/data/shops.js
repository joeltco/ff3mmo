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
    items: [0x1F, 0x24, 0x0E, 0x06, 0x4A, 0x4F, 0x50, 0x51],
    // Dagger, Longsword, Staff, Nunchuck, Bow, Wooden/Holy/Iron arrows.
    // The bow tier stocked here is the one an Onion Knight can actually hold:
    // Bow $4A and arrows $4F/$50/$51 all include job bit 0, while the later
    // bows ($4C+) are Ranger/Ninja only and Ranger is unreachable at MAX_LEVEL 5.
    // Three arrow types so the ammo choice is real — Holy carries its element.
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
    items: [0xA6, 0xAE, 0xAF],
    // Potion, Eye Drops, Antidote
  }],
  // --- Town of Kazus ---
  //
  // Catalogs CAPTURED from the running game: `POKE=0x609d node
  // tools/monscan/shop-probe.cjs 16` opens the real shop (Kazus is cursed and
  // its shops stay shut until $609D is set — docs/KAZUS.md) and the stock reads
  // off the screen with prices. Item ids resolved by decoding the name bytes,
  // which share a "Mythril" prefix, NOT by matching price alone.
  //
  // Counters mirror Ur's because the rooms are byte-identical layouts — map
  // 16's column x=3 matches map 5 tile for tile, counter tile $1d at y=15
  // included. MEASURED: the ROM's shop-marker NPC sits at (3,23) on map 16,
  // which is bare floor.
  ['kazus_weapon', {
    type: 'weapon',
    mapId: 16, counter: { x: 3, y: 15 },
    items: [0x09, 0x20, 0x27],
    // MythrilRod 400, MythrilKnife 500, MythrilSwrd 500 — captured stock, in
    // captured order. A tier above Ur, whose dearest is a 100 gil Longsword.
  }],
  ['kazus_armor', {
    type: 'armor',
    mapId: 17, counter: { x: 3, y: 5 },
    items: [0x75, 0x5a, 0x64, 0x8d, 0x8e],
    // MythrilArmor 350, MythrilShield 180, MythrilHelm 180, MythrilGlv 120,
    // MythrilBrc 120. Our ITEMS price for the helm (0x64) is 130 where the ROM
    // shop asks 180; the catalog is the id list, prices come from ITEMS.
  }],
  ['kazus_magic', {
    type: 'magic',
    mapId: 15, counter: { x: 4, y: 4 },
    items: [0xe0, 0xe1, 0xe6],
    // ⚠ CHOSEN, not captured — the only Kazus catalog that is. Map 15 is a
    // round chamber with spell orbs on pedestals rather than a counter room,
    // which is how FF3 sells magic (walk to an ORB, buy that one spell), so
    // shop-probe's walk-to-the-counter cannot reach a trigger that isn't there.
    // Picked one tier above Ur's lone Pure scroll: Fire, Bzzard, and Ice2 (700
    // gil) as the reach purchase. Replace once a per-orb probe lands.
    //
    // The KEEPER is placed by map-loading.js via addBlackMageShopkeeper(4,4,
    // 'kazus_magic'), exactly as Ur's is — on the counter tile, carrying the
    // shopId that opens this menu.
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
