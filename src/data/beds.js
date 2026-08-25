// ═══════════════════════════════════════════════════════════════════════════
// ⛔⛔⛔  DO NOT HALF-ASS THE DATA PULL.  ⛔⛔⛔
//
// A ROM record has N FIELDS. If you use fewer than N, YOU HAVE NOT READ IT —
// you have guessed while holding the answer. This banner exists because that
// happened over and over in one day:
//
//   * FF3's NPC record is {id, x, y, FLAGS}. The flags byte was DISASSEMBLED
//     (bits 2-3 = FACING, bits 4-7 = MOVEMENT) and then DROPPED on the floor,
//     so ten Ur townsfolk shipped frozen in "random spots" facing wrong.
//   * Cid took THREE releases and Joel pointing at the tile — while
//     `npc-dump.mjs 12` had printed `id $2c @(6,23) ... DRAWN` the whole time.
//   * `$67` was called the "black magic sign" without checking its ATTRIBUTE
//     palette. It is the same star on pal1, the TREE/WOOD palette. Green
//     corners shipped.
//   * Characters were identified from `npcId + 0x202` instead of by RENDERING
//     THE SPRITE — which put Cid's line on the Castle Sasune gate guard.
//   * `check-shops` asked `findShopAtCounter` for the shop's OWN coords, so it
//     agreed with itself wherever the counter pointed.
//   * "0 of 28 bundles match" was a `+0x10` applied twice. SELF-TEST THE
//     INSTRUMENT BEFORE BELIEVING A NEGATIVE.
//
// BEFORE YOU SAY "DONE", ANSWER THIS OUT LOUD:
//   List every field/byte/column of the record you just read. Point at the line
//   of code that CONSUMES each one. If any field is unconsumed, you are NOT
//   done — wire it or say plainly which one you dropped and why.
//
// AND: RENDER IT AND LOOK. `map-png --grid --box`, `tileset-sheet.mjs`,
// `npc-sheet-ff3.mjs`, `npc-cast.cjs`. "The code looks right" is not a check.
// ═══════════════════════════════════════════════════════════════════════════
// beds.js — inn-rest tile registry.
//
// A "bed tile" is identified by its METATILE ID within a tileset, not by map
// coordinates. So any map (present OR future) that places these tiles becomes
// a rest spot automatically — no per-map registration. To add beds in a new
// tileset, add an entry here.
//
// Inn tileset (5), verified bed-exclusive on map 8. Only the BOTTOM halves
// trigger rest — you walk up the side of the bed and stop at the pillow:
//   $0a = bed top-half (NOT a trigger; walking onto it shouldn't start sleep)
//   $0b = bed bottom-half (top set)
//   $62 = bed bottom-half (bottom set)
const BED_TILE_IDS = {
  5: new Set([0x0b, 0x62]),
};

// True if the given metatile id is a bed tile in the given tileset.
export function isBedTileId(tileset, metatileId) {
  const ids = BED_TILE_IDS[tileset];
  return !!ids && ids.has(metatileId & 0x7f);
}
