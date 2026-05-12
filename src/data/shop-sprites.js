// FF1-style shopkeeper sprites — drawn in the shop panel header.
//
// Disassembly orientation (Disch/Entroper FF1 disassembly,
// `bank_0E.asm DrawShop` + `bank_0F.asm LoadShopBGCHRPalettes`):
//
// 1. FF1 has 8 shop types (`lut_ShopTypes` in bank_0F.asm:10376):
//      0 weapon  1 armor  2 white-magic  3 black-magic
//      4 clinic  5 inn    6 item         7 caravan
//
// 2. Each type uses a 4-color BG backdrop palette from
//    `lut_BackdropPal+$40+(type*4)`. The bytes below are pulled from
//    bank_00.dat — these ARE the FF1 shop background palettes. Slot 0
//    is treated as transparent by ff3mmo's tile-decoder.
//
// 3. The shopkeeper is drawn on the BG plane (NOT OAM) — see
//    `bank_0E.asm DrawShop` calling `DrawImageRect` with a 10×10 tile
//    rect from `lut_ShopkeepImage`. Each shop type uses the SAME
//    nametable layout (the 10×10 image below); the differentiation is
//    a tile-index additive of `type * 14` (`lut_ShopkeepAdditive`).
//    Each keeper occupies 14 distinct CHR tiles in `lut_ShopCHR` at
//    indices `1 + type*14 .. 14 + type*14` (tile 0 is the blank/sky
//    backdrop). Total: 8 × 14 = 112 tiles for keepers, baked into the
//    shop CHR bundle loaded by `LoadShopBGCHRPalettes`.
//
// 4. Capture path for ff3mmo:
//      a. Konami → EMU tab → ROM toggle → `FF1` (added in v1.7.256
//         after we discovered the old FF1+II compilation was SUROM and
//         jsnes couldn't bank-switch past 256 KB).
//      b. Walk the party into each shop type once.
//      c. Pause + SNAP BG dumps PPU $0000-$06FF as 128 tiles × 16
//         bytes = 2048 bytes (the shop CHR bundle).
//      d. Slice tiles `1 + type*14` through `14 + type*14` per keeper
//         and paste below.
//
// LAYOUT — `lut_ShopkeepImage` (bank_0E.asm:6031), 10 cols × 10 rows.
// Indices below are RELATIVE to the keeper's 14-tile bundle (1..13;
// 0 = blank / sky-backdrop).
//
// The figure occupies cols 0..3 and rows 2..9; cols 4..5 form the
// counter pillar (drawn at the same tile indices for every keeper).
// Cols 6..9 are unused (blank padding inside the 10×10 rect).
export const SHOPKEEP_IMAGE_LAYOUT = [
  [0,0,0,0,0,0,0,0,0,0],  // row 0 — sky
  [0,0,0,0,0,0,0,0,0,0],  // row 1 — sky
  [0,0,0,0,1,1,0,0,0,0],  // row 2 — counter top
  [4,5,0,0,1,1,0,0,0,0],  // row 3 — body L pair + counter
  [6,7,8,9,1,1,0,0,0,0],  // row 4 — body L + head/upper R
  [4,5,10,11,1,1,0,0,0,0], // row 5 — body L + mid R
  [6,7,12,13,1,1,0,0,0,0], // row 6 — body L + lower R
  [4,5,0,0,1,1,0,0,0,0],  // row 7 — body L (R fades)
  [6,7,0,0,1,1,0,0,0,0],  // row 8 — body L (R fades)
  [0,0,0,0,2,3,0,0,0,0],  // row 9 — counter base
];

// Per-shop-type backdrop palette (4 NES color indices). Cached from
// FF1 disassembly bank_00.dat at offset $3200+$40+type*4. Type slot 0
// is treated as transparent at render time.
export const SHOP_PALETTES = {
  weapon:        [0x0F, 0x30, 0x00, 0x31],
  armor:         [0x0F, 0x10, 0x27, 0x17],
  'white-magic': [0x0F, 0x3C, 0x1C, 0x0C],
  'black-magic': [0x0F, 0x3B, 0x1B, 0x0B],
  clinic:        [0x0F, 0x37, 0x16, 0x10],
  inn:           [0x0F, 0x36, 0x16, 0x07],
  item:          [0x0F, 0x37, 0x17, 0x07],
  caravan:       [0x0F, 0x30, 0x28, 0x16],
};

// Map ff3mmo shop types (currently 4) to the FF1 canonical 8. The
// `magic` shop in ff3mmo today sells WM Lv1 (Cure/Poisona/Sight) so it
// maps to FF1's white-magic keeper. When a black-magic shop opens in a
// later town, add a separate ff3mmo shop type (or split magic into
// `wmagic`/`bmagic`) and point it at black-magic here.
export const FF3MMO_TO_FF1 = {
  weapon: 'weapon',
  armor:  'armor',
  item:   'item',
  magic:  'white-magic',
};

// Shopkeeper tile data, keyed by FF1 canon type. Each entry is the 14
// keeper-specific tiles (16 bytes per 2BPP NES tile = 224 bytes total).
// Tile order matches the indices used by `SHOPKEEP_IMAGE_LAYOUT`
// (1..13 used; the 14th tile is the unused slot in FF1's bundle).
//
// Empty for now — populate from PPU capture per the flow documented
// above. The renderer no-ops on any type without an entry.
export const SHOP_KEEPER_TILES = new Map([
  // ['weapon',      new Uint8Array([...224 bytes...])],
  // ['armor',       new Uint8Array([...224 bytes...])],
  // ['white-magic', new Uint8Array([...224 bytes...])],
  // ['black-magic', new Uint8Array([...224 bytes...])],
  // ['item',        new Uint8Array([...224 bytes...])],
]);

// Resolve `{ tiles, palette }` for the active ff3mmo shop type. Caller
// must guard against the null return (no capture landed yet for the
// requested type).
export function getShopSprite(ff3mmoType) {
  const ff1Type = FF3MMO_TO_FF1[ff3mmoType];
  if (!ff1Type) return null;
  const tiles = SHOP_KEEPER_TILES.get(ff1Type);
  if (!tiles) return null;
  const palette = SHOP_PALETTES[ff1Type];
  if (!palette) return null;
  return { tiles, palette };
}
