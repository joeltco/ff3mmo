// FF1-style shopkeeper sprites — one NPC per shop type, drawn in the
// shop panel header.
//
// SHAPE (when entries land):
//   SHOP_SPRITES.set('weapon', {
//     tiles: new Uint8Array([...]),  // 6 tiles × 16 bytes = 96 bytes (2x3, 16x24 px)
//     palette: [0x0F, 0x16, 0x27, 0x30],  // NES color slots 0..3 (0 = transparent)
//   });
//
// CAPTURE FLOW (FF1&2 ROM):
//   Per `CLAUDE.md` we can't author tile bytes from REC OAM dumps — the
//   shopkeeper data has to come from a running PPU. The EMU tab currently
//   only loads FF3; capturing FF1&2 means either extending the EMU tab to
//   accept the secondary ROM buffer (`ff12Raw` in boot.js) or using an
//   external emulator (FCEUX/Mesen) to SNAP OAM on each shopkeeper sprite.
//   Paste the resulting `new Uint8Array([...])` literal here keyed by
//   shop type and the renderer picks it up automatically.
//
// LAYOUT (when sprite data exists):
//   Rendered at the top-left of the shop panel above the buy/sell list.
//   Position + draw call live in `shop.js` (`_drawShopkeeper`).

export const SHOP_SPRITES = new Map([
  // ['weapon', { tiles: new Uint8Array([...]), palette: [...] }],
  // ['armor',  { tiles: new Uint8Array([...]), palette: [...] }],
  // ['item',   { tiles: new Uint8Array([...]), palette: [...] }],
  // ['magic',  { tiles: new Uint8Array([...]), palette: [...] }],
]);

export function getShopSprite(type) {
  return SHOP_SPRITES.get(type) || null;
}
