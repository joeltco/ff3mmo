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

// Shopkeeper tile data, keyed by FF1 canon type. Each entry is the
// 13 keeper-specific tiles ($01..$0D) in `SHOPKEEP_IMAGE_LAYOUT` order
// (16 bytes per 2BPP NES tile → 208 bytes per keeper). FF1 reserves a
// 14th slot per keeper in its CHR bundle (the additive jumps by 14)
// but the layout never references it, so we skip it here.
//
// The renderer no-ops on any type without an entry.
export const SHOP_KEEPER_TILES = new Map([
  // FF1 weapon-shop keeper (USA ROM, captured via SNAP BG on frame 1997).
  // Palette: PPU BG0 at capture time matched `SHOP_PALETTES.weapon`
  // (FF1 disassembly lut_BackdropPal+$40).
  ['weapon', new Uint8Array([
    // $01 — counter pillar (decorative striped panel)
    0x88,0x88,0x88,0x08,0x88,0x88,0x88,0x80, 0x66,0x66,0x66,0x06,0x66,0x66,0x66,0x60,
    // $02 — counter base, left half
    0x00,0x88,0x00,0x00,0x40,0x5F,0x40,0x7F, 0x00,0x66,0x00,0x7F,0x3F,0x20,0x3F,0x00,
    // $03 — counter base, right half
    0x00,0x88,0x00,0x00,0x04,0xF4,0x04,0xFC, 0x00,0x66,0x00,0xFC,0xF8,0x08,0xF8,0x00,
    // $04 — body upper-left (alternates with $06 down the figure)
    0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x03, 0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x03,
    // $05 — body upper-right (alternates with $07)
    0x07,0x0D,0x1B,0x36,0x6C,0xD8,0xB0,0x60, 0x07,0x0F,0x1F,0x3E,0x7C,0xF8,0xF0,0xE0,
    // $06 — body lower-left
    0x06,0x4D,0x6B,0x3E,0x18,0x0C,0x06,0x00, 0x07,0x0F,0x0F,0x06,0x20,0x70,0x60,0x80,
    // $07 — body lower-right
    0xC0,0x80,0x00,0x00,0x00,0x00,0x00,0x00, 0xC0,0x80,0x00,0x00,0x00,0x00,0x00,0x00,
    // $08 — head left
    0x00,0x00,0x00,0x00,0x00,0x06,0x06,0x07, 0x00,0x1F,0x3F,0x3F,0x3F,0x39,0x39,0x18,
    // $09 — head right
    0x00,0x00,0x00,0x10,0x70,0x80,0xD8,0xF8, 0x00,0xF0,0xF8,0xE8,0x80,0x00,0x00,0x00,
    // $0A — face / mid left
    0x03,0x01,0x1E,0x3F,0x3E,0x3F,0x1E,0x1E, 0x1C,0x0C,0x02,0x01,0x00,0x00,0x01,0x11,
    // $0B — face / mid right
    0xC0,0x82,0xB6,0x76,0x80,0x58,0x2C,0x48, 0x30,0x70,0x40,0x00,0x8E,0x56,0x82,0x80,
    // $0C — chin / lower face left
    0x04,0x18,0x1F,0x0F,0x0F,0x00,0x00,0x00, 0x03,0x18,0x1F,0x0F,0x0F,0x0F,0x0F,0x0F,
    // $0D — chin / lower face right
    0x70,0x00,0xD0,0xB0,0xB0,0x00,0x00,0x00, 0x80,0x00,0xD0,0xB0,0xB0,0xB0,0xB0,0xD8,
  ])],
  // armor / white-magic / black-magic / item — pending captures.
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
