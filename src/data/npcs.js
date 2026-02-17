// NPC Catalog — roles and types, keyed by area + NPC index
//
// NPC positions come from ROM at runtime (map-loader.js readNPCs).
// NPC names come from ROM text decoder at runtime.
// This catalog adds gameplay role info — who they are and what they do.
// Start: Town of Ur

export const NPCS = new Map([
  // --- Town of Ur (map 114) ---
  ['ur_0', { role: 'elder' }],
  ['ur_1', { role: 'caretaker' }],
  ['ur_2', { role: 'villager' }],
  ['ur_3', { role: 'villager' }],
  ['ur_4', { role: 'villager' }],
  ['ur_5', { role: 'villager' }],
  ['ur_6', { role: 'villager' }],
  ['ur_7', { role: 'villager' }],

  // --- Shopkeepers (mapped by shop ID) ---
  ['ur_weapon_shop', { role: 'shopkeeper', shop: 'ur_weapon' }],
  ['ur_armor_shop',  { role: 'shopkeeper', shop: 'ur_armor' }],
  ['ur_item_shop',   { role: 'shopkeeper', shop: 'ur_item' }],
  ['ur_magic_shop',  { role: 'shopkeeper', shop: 'ur_magic' }],
]);
