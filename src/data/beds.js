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
