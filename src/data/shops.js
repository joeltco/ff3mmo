// Shop Catalog — store inventories, keyed by shop ID
//
// Item IDs reference ROM item table (names from text decoder at runtime)
// Prices from FF3 Pixel Remaster
// Start: Town of Ur

export const SHOPS = new Map([
  // --- Town of Ur ---
  ['ur_weapon', {
    items: [0x1F, 0x24, 0x0E, 0x06, 0x4A, 0x4F],
    // Dagger, Longsword, Staff, Nunchuck, Bow, Wooden Arrow
  }],
  ['ur_armor', {
    items: [0x73, 0x58, 0x62, 0x8B],
    // Leather Armor, Leather Shield, Leather Cap, Bronze Bracers
  }],
  ['ur_item', {
    items: [0xA6, 0xAE, 0xAF],
    // Potion, Eye Drops, Antidote
  }],
  ['ur_magic', {
    spells: [0x35],
    // Poisona (spell ID, not item ID)
  }],
]);
