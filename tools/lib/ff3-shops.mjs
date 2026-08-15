// ff3-shops.mjs — FF3's shop inventories, prices and item names.
//
// Found by opening real shops and watching the CPU, not by searching the ROM
// for plausible item ids.
//
// WHAT A SHOP IS
// A shopkeeper NPC. `tools/ff3-shop-sweep.mjs` patches the id of one shopkeeper
// standing two tiles from a savestate, warps in and talks, for all 256 ids.
//
// ⛔ FF3 reloads its NPC table from ROM on every map load, so patching the ROM
// DOES take here. FF2 is the opposite: its savestate already holds the map, and
// the poke has to go to RAM $7500.
//
// THE LOAD, from the CPU:
//   3F/EA04  ASL A / TAY / BCC + / INX      ; id*2, carrying into the next page
//            STX $81 / LDA #$00 / STA $80   ; the pointer table is PAGE-ALIGNED
//   3F/EA12  LDA ($80),Y -> $82 ; $83       ; -> the shop's record
//   3F/EA1B  LDY #$3F
//   3F/EA1D  LDA ($82),Y / STA $7B00,Y      ; 64 bytes into RAM $7B00
//
//   3D/B220  LDX #$07
//   3D/B222  LDA $7B01,X / STA $7B80,X      ; EIGHT item slots: $7B01..$7B08
//   3D/B22D  LDX $7B80,Y / JSR $F5D4        ; item id -> price
//   3D/B233  STA $7BA8,Y / $7BB0,Y / $7BB8,Y ; 24-bit, low/mid/high
//
//   3F/F5D4  LDA #$10 / JSR $FF06           ; bank $10
//   3F/F5D9  TXA / ASL A / TAX / BCS +
//   3F/F5DE  LDA $9E00,X / $9E01,X          ; the price, 16-bit LE
//   3F/F5E9  LDA $9F00,X / $9F01,X          ; ...ids >= $80 continue here
//   3F/F5F3  LDA #$00 / STA $82             ; the third byte is always zero
//
// ⛔ The copy is 64 bytes but a record is only [kind] + up to 8 items, so a
// shop's RAM window also holds whatever records are packed after it. Records are
// VARIABLE length — 00 ends the item list early, and a shop with all 8 slots
// filled has no terminator at all (id 228 is one).
// ⛔ $9E00 and $9F00 are ONE contiguous table; the branch exists only because
// `ASL A` on an id >= $80 carries out of the 8-bit X.

// ── tables (file offsets, including the 16-byte iNES header) ─────────────────
export const SHOP_PTR_TABLE = 0x58210;   // bank 44 $8200 — 2 bytes per NPC id
export const SHOP_BANK_BASE = 44 * 0x2000 + 0x10;   // records live in bank 44 @ $8000
export const SHOP_ITEMS_MAX = 8;         // 3D/B220 LDX #$07
export const SHOP_RAM = 0x7B00;          // 3F/EA1F STA $7B00,Y
export const SHOP_COPY_LEN = 0x40;       // 3F/EA1B LDY #$3F

export const PRICE_TABLE = 16 * 0x2000 + 0x10 + (0x9E00 - 0x8000);   // 0x21E10
export const NAME_PTR_TABLE = 0x30810;   // bank 24 $8800 — 2 bytes per item id
export const NAME_BANK_BASE = 30 * 0x2000 + 0x10;   // names live in bank 30 @ $C000

/** The kind byte a record opens with — the word the shop draws for itself. */
export const KINDS = { 7: 'Weapons', 8: 'Armor', 9: 'Items', 10: 'Magic' };

/**
 * The NPC ids that actually OPEN a shop, measured by talking to all 256.
 *
 * ⛔ This is NOT every id with a record. 232, 239, 244 and 250 have perfectly
 * well-formed records and open nothing — a record is necessary but not
 * sufficient, so the set is listed rather than derived.
 */
export const SHOP_NPC_IDS = [
  227, 228, 229, 230, 231, 233, 234, 235, 236, 237, 238,
  240, 241, 242, 243, 245, 246, 247, 248, 249, 251,
];

export const priceForItem = (rom, id) =>
  rom[PRICE_TABLE + id * 2] | (rom[PRICE_TABLE + id * 2 + 1] << 8);

/** An item's name: [icon byte][chars][00], so skip one and stop at the zero. */
export function itemName(rom, id, glyph) {
  const p = rom[NAME_PTR_TABLE + id * 2] | (rom[NAME_PTR_TABLE + id * 2 + 1] << 8);
  let o = NAME_BANK_BASE + (p - 0xC000) + 1;
  let s = '';
  while (rom[o] !== 0 && s.length < 16) {
    const g = glyph(rom[o]);
    if (g !== null && g !== '\n') s += g;
    o++;
  }
  return s.trim();
}

/**
 * What the shopkeeper with this NPC id stocks.
 *
 * @param {Uint8Array} rom
 * @param {number} npcId
 * @param {(b:number)=>string|null} [glyph]  pass `ff3-text.glyph` for names
 */
export function shopAt(rom, npcId, glyph = null) {
  const po = SHOP_PTR_TABLE + npcId * 2;
  const ptr = rom[po] | (rom[po + 1] << 8);
  const offset = SHOP_BANK_BASE + (ptr - 0x8000);
  const kindByte = rom[offset];
  const items = [];
  for (let i = 0; i < SHOP_ITEMS_MAX; i++) {
    const id = rom[offset + 1 + i];
    if (id === 0) break;                       // 00 ends the list early
    items.push({ id, price: priceForItem(rom, id),
                 name: glyph ? itemName(rom, id, glyph) : null });
  }
  return { npcId, ptr, offset, kindByte, kind: KINDS[kindByte] || null, items };
}

export function allShops(rom, glyph = null) {
  return SHOP_NPC_IDS.map(id => shopAt(rom, id, glyph));
}
