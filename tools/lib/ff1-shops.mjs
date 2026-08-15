// ff1-shops.mjs — FF1's shop inventories, prices and item names.
//
// Every table here was found by opening a real shop and watching which
// cartridge bytes it read — never by searching the ROM for a plausible run of
// item ids, which finds dozens of false hits. The listing that proves each one
// sits next to it.
//
// THE CHAIN, from a tile you step on to the words on screen:
//
//   prop1 of the tile           -> $51, the shop id      (see ff1-map.mjs)
//   $EB47  LDX $51 / LDA $EBB5,X / AND #$07              -> the shop KIND
//   $A7D1  LDA $51 / ASL A / TAX
//   $A7D5  LDA $8300,X -> $10 ; LDA $8301,X -> $11       -> the shop's RECORD
//   $A7DF  LDY #$04 / LDA ($10),Y / STA $0300,Y / DEY / BPL
//   $A7E9  LDA #$00 / STA $0305                          -> forced terminator
//   $A85F  LDA $0300,X / BEQ +                           -> 00 ENDS the list
//   $A88D  CMP #$05 / BCC                                -> at most FIVE items
//   $ECCA  ...$BC00,X (bank 13)                          -> the item's PRICE
//   $E004  ASL A / TAX / BCS $E013
//   $E008  LDA $B700,X / LDA $B701,X   (bank 10)         -> the item's NAME ptr
//   $E013  LDA $B800,X / LDA $B801,X                     -> ...ids >= $80
//   $DE47  LDA ($3E),Y / BEQ                             -> names are 00-terminated
//
// ⛔ `$B700` and `$B800` are ONE contiguous table. The branch exists only
// because `ASL A` on an id >= $80 carries out of the 8-bit X; `base + id*2` over
// the full 0..255 range lands in the same place, which is why this file uses a
// single base.
//
// ⛔ Item names are VARIABLE length, not a fixed stride. Most records are 8
// bytes, which makes `base + id*8` look right — it fits Wooden/Chain/Iron and
// then breaks, because "Ribbon" is 9 and shifts everything after it. The
// pointer table is the only correct way in.

// ── tables (file offsets; all include the 16-byte iNES header) ───────────────
export const KIND_TABLE = 0x3EBC5;   // CPU $EBB5, fixed bank — 1 byte per shop id
export const KIND_MASK = 0x07;       // $EB4C AND #$07
export const SHOP_PTR_TABLE = 0x38310;  // CPU $8300, bank 14 — 2 bytes per shop id
export const RECORD_MAX = 5;         // $A7DF LDY #$04 ... $A88D CMP #$05
export const PRICE_TABLE = 0x37C10;  // CPU $BC00, bank 13 — 2 bytes per ITEM id
export const NAME_PTR_TABLE = 0x2B710;  // CPU $B700, bank 10 — 2 bytes per ITEM id

/**
 * Unused shop slots all point HERE, at a shared filler record whose first byte
 * is 0x00 (so the buy list is empty and the shop draws nothing). Every band has
 * a few: ids 7-9, 10, 17-20, 47-50, 58-60, 67-69. Reading their record as data
 * yields junk — an unused INN "costs" 7680 G — so they are flagged, not
 * reported.
 */
export const FILLER_PTR = 0x838E;

const BANK = (n, cpu) => 0x10 + n * 0x4000 + (cpu - 0x8000);
export const bank10 = (cpu) => BANK(10, cpu);
export const bank14 = (cpu) => BANK(14, cpu);

/**
 * The eight shop kinds, in the order the `& 0x07` byte gives them. Confirmed
 * two ways: this table reproduces the bands measured by opening every id
 * (`ff1-warp.mjs --sweep`), and the banner each one draws is the name below.
 */
export const KINDS = ['WEAPON', 'ARMOR', 'WMAGIC', 'BMAGIC', 'CLINIC', 'INN', 'ITEM', 'OASIS'];

/** INN and CLINIC do not stock items — their record is a 16-bit PRICE. */
export const PRICE_KINDS = new Set(['INN', 'CLINIC']);

export const itemPrice = (rom, id) =>
  rom[PRICE_TABLE + id * 2] | (rom[PRICE_TABLE + id * 2 + 1] << 8);

/** The item's name, walked from the pointer table and stopped at the 00. */
export function itemName(rom, id, glyph) {
  const p = rom[NAME_PTR_TABLE + id * 2] | (rom[NAME_PTR_TABLE + id * 2 + 1] << 8);
  let o = bank10(p), s = '';
  while (rom[o] !== 0 && s.length < 16) {
    const g = glyph(rom[o]);
    // unmapped bytes are the little type icons that follow a name
    if (g !== null && g !== '\n') s += g;
    o++;
  }
  return s.trim();
}

/**
 * Everything about shop `id`.
 *
 * @param {Uint8Array} rom
 * @param {number} id      1..70 ($EBB5 has no entry past 70)
 * @param {(b:number)=>string|null} [glyph]  pass `ff1-text.glyph` for names
 */
export function shopAt(rom, id, glyph = null) {
  const kindByte = rom[KIND_TABLE + id];
  const kind = KINDS[kindByte & KIND_MASK];
  const ptr = rom[SHOP_PTR_TABLE + id * 2] | (rom[SHOP_PTR_TABLE + id * 2 + 1] << 8);
  const recordOffset = bank14(ptr);
  const raw = [...rom.slice(recordOffset, recordOffset + RECORD_MAX)];
  const unused = ptr === FILLER_PTR;

  if (PRICE_KINDS.has(kind)) {
    // $AAA0 LDA $0300 / STA $10 / LDA $0301 / STA $11 / LDA #$00 / STA $12
    //       JSR $8E84    — a 24-bit value handed to the number printer.
    return { id, kind, kindByte, ptr, recordOffset, raw, unused,
             price: unused ? null : (raw[0] | (raw[1] << 8)), items: [] };
  }

  const items = [];
  for (const b of raw) {
    if (b === 0) break;                       // $A862 BEQ — the list ends here
    items.push({ id: b, price: itemPrice(rom, b),
                 name: glyph ? itemName(rom, b, glyph) : null });
  }
  return { id, kind, kindByte, ptr, recordOffset, raw, unused, price: null, items };
}

/** Every real shop. Id 0 is excluded: prop1 == 0 means "this tile does nothing". */
export function allShops(rom, glyph = null, max = 70) {
  const out = [];
  for (let id = 1; id <= max; id++) out.push(shopAt(rom, id, glyph));
  return out;
}
