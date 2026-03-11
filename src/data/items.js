// Item Catalog — Pixel Remaster stats, keyed by ROM item ID
//
// Names come from ROM text decoder at runtime (string $0400 + id)
// Stats source: FF3 Pixel Remaster / StrategyWiki
// ROM IDs from disassembly item tables
// Start: Ur shops + Altar Cave chest loot

// --- Consumables (ROM IDs $A6-$AF) ---
const CONSUMABLES = [
  [0xA6, { type: 'consumable', price: 50,  effect: 'restore_hp', value: 50 }],   // Potion
  [0xA7, { type: 'consumable', price: 600, effect: 'restore_hp', value: 500 }],  // Hi-Potion
  [0xA8, { type: 'consumable', price: 0,   effect: 'restore_all', value: 0 }],   // Elixir
  [0xA9, { type: 'consumable', price: 200, effect: 'revive', value: 0 }],        // Phoenix Down
  [0xAC, { type: 'consumable', price: 100, effect: 'cure_silence', value: 0 }],  // Echo Herbs
  [0xAE, { type: 'consumable', price: 40,  effect: 'cure_blind', value: 0 }],    // Eye Drops
  [0xAF, { type: 'consumable', price: 80,  effect: 'cure_poison', value: 0 }],   // Antidote
];

// --- Weapons ---
const WEAPONS = [
  [0x1E, { type: 'weapon', subtype: 'knife',    atk: 6,  hit: 85, price: 20 }],  // Knife
  [0x1F, { type: 'weapon', subtype: 'dagger',   atk: 8,  hit: 85, price: 60 }],  // Dagger
  [0x24, { type: 'weapon', subtype: 'sword',    atk: 10, hit: 80, price: 100 }], // Longsword
  [0x0E, { type: 'weapon', subtype: 'staff',    atk: 3,  hit: 50, price: 40 }],  // Staff
  [0x06, { type: 'weapon', subtype: 'nunchaku', atk: 12, hit: 70, price: 30 }],  // Nunchuck
  [0x4A, { type: 'weapon', subtype: 'bow',      atk: 5,  hit: 90, price: 100 }], // Bow
  [0x4F, { type: 'weapon', subtype: 'arrow',    atk: 6,  hit: 90, price: 4 }],   // Wooden Arrow
];

// --- Armor ---
const ARMOR = [
  [0x73, { type: 'armor', subtype: 'body',   def: 2, mdef: 1, evade: 1, price: 90 }],  // Leather Armor
  [0x58, { type: 'armor', subtype: 'shield', def: 3, mdef: 2, evade: 3, price: 40 }],  // Leather Shield
  [0x62, { type: 'armor', subtype: 'helmet', def: 1, mdef: 1, evade: 1, price: 15 }],  // Leather Cap
  [0x8B, { type: 'armor', subtype: 'arms',   def: 1, mdef: 3, evade: 2, price: 80 }],  // Bronze Bracers
];

// --- Spells (sold in magic shops, spell IDs not item IDs) ---
const MAGIC = [
  [0x35, { type: 'magic', subtype: 'white', level: 1, price: 100 }],  // Poisona (spell $35)
];

export const ITEMS = new Map([
  ...CONSUMABLES,
  ...WEAPONS,
  ...ARMOR,
  ...MAGIC,
]);
