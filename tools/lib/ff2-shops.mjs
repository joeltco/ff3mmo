// ff2-shops.mjs — FF2's shop inventories, prices and item names.
//
// Found by standing a shop object next to the party and opening it, then
// watching which cartridge bytes it read. Nothing here came from searching the
// ROM for a plausible run of item ids.
//
// WHAT A SHOP IS
// `tools/ff2-type-sweep.mjs` put all 256 object types next to the party and
// talked to each. Types 192-219 open a shop; the four after them are special:
//
//   192-219 (0xC0-0xDB)  SHOP  — 28 of them
//   220     (0xDC)       ferry ("to Hoft, 32 gil")
//   221     (0xDD)       airship (Cid's)
//   222     (0xDE)       INN
//   223     (0xDF)       "nothing happened"
//   224-255              nothing at all
//
// 0xC0 is not a coincidence: it is `NO_HANDLER_FIRST` in `ff2-text.mjs`, the
// point where object types stop having a dialogue handler. `$CBD5 LDA $A0 /
// CMP #$60 / CMP #$C0` is the classifier.
//
// THE LOAD, from the CPU:
//   $8E9B  ASL A / ASL A / ASL A       ; shop index * 8
//   $8E9E  CLC / ADC $8380 -> $80      ; + the table base held at $8380
//   $8EA4  LDA $8381 / ADC #$00 -> $81
//   $8EAB  LDY #$0F
//   $8EAD  LDA ($80),Y / STA $7B00,Y   ; ...into RAM $7B00
//   $8EB2  DEY / BPL
//
// ⛔ The copy is SIXTEEN bytes but the stride is EIGHT, so each shop's window
// also contains the NEXT shop's record. Only the first 8 bytes are its own —
// measured: shop 1's RAM begins with shop 0's last 8 bytes, and every shop
// draws exactly four items (checked by holding DOWN in the buy list, which
// never scrolls).
//
// A record is 4 entries of 2 bytes: (item id, PRICE CODE). The price code is
// not a price — the same code gives the same price for different items (`0xF2`
// is 500 G for both Axe and Mace; `0xF1` is 400 G for all three spellbooks),
// and it indexes a table of its own.

// ── tables (file offsets, including the 16-byte iNES header) ─────────────────
export const SHOP_TABLE = 0x3861D;      // CPU $860D bank 14
export const SHOP_TABLE_PTR = 0x38390;  // CPU $8380 bank 14 — holds $860D
export const SHOP_STRIDE = 8;           // $8E9B ASL A x3
export const SHOP_ITEMS = 4;            // 4 entries of 2 bytes
export const SHOP_COPY_LEN = 16;        // $8EAB LDY #$0F — overlaps the next shop
export const SHOP_RAM = 0x7B00;         // $8EAF STA $7B00,Y
export const PRICE_TABLE = 0x38010;     // CPU $8000 bank 14 — 2 bytes LE per code
export const NAME_PTR_TABLE = 0x28210;  // CPU $8200 bank 10 — 2 bytes per item id

export const SHOP_TYPE_FIRST = 0xC0;    // 192
export const SHOP_TYPE_LAST = 0xDB;     // 219
export const SHOP_COUNT = SHOP_TYPE_LAST - SHOP_TYPE_FIRST + 1;

/** The four object types just past the shops, measured by the type sweep. */
export const SPECIAL_TYPES = { 0xDC: 'FERRY', 0xDD: 'AIRSHIP', 0xDE: 'INN', 0xDF: 'NOTHING' };

const BANK = (n, cpu) => 0x10 + n * 0x4000 + (cpu - 0x8000);
export const bank10 = (cpu) => BANK(10, cpu);
export const bank14 = (cpu) => BANK(14, cpu);

export const priceForCode = (rom, code) =>
  rom[PRICE_TABLE + code * 2] | (rom[PRICE_TABLE + code * 2 + 1] << 8);

/**
 * An item's name. The record is a leading ICON byte, then the name, then 00 —
 * the icon has no glyph, so it drops out on its own.
 */
export function itemName(rom, id, glyph) {
  const p = rom[NAME_PTR_TABLE + id * 2] | (rom[NAME_PTR_TABLE + id * 2 + 1] << 8);
  let o = bank10(p), s = '';
  while (rom[o] !== 0 && s.length < 16) {
    const g = glyph(rom[o]);
    if (g !== null && g !== '\n') s += g;
    o++;
  }
  return s.trim();
}

/**
 * What shop `index` (0..27, i.e. object type 192..219) stocks.
 *
 * @param {Uint8Array} rom
 * @param {number} index
 * @param {(b:number)=>string|null} [glyph]  pass `ff2-text.glyph` for names
 */
export function shopAt(rom, index, glyph = null) {
  const off = SHOP_TABLE + index * SHOP_STRIDE;
  const raw = [...rom.slice(off, off + SHOP_STRIDE)];
  const items = [];
  for (let i = 0; i < SHOP_ITEMS; i++) {
    const id = raw[i * 2], code = raw[i * 2 + 1];
    items.push({ id, code, price: priceForCode(rom, code),
                 name: glyph ? itemName(rom, id, glyph) : null });
  }
  return { index, objType: SHOP_TYPE_FIRST + index, offset: off, raw, items };
}

export function allShops(rom, glyph = null) {
  const out = [];
  for (let i = 0; i < SHOP_COUNT; i++) out.push(shopAt(rom, i, glyph));
  return out;
}
