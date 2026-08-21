// The boss chamber — ONE shape, worn by every dungeon under a per-dungeon skin.
// See docs/DUNGEON-CHAMBERS-PLAN.md §4c.
//
// It used to be `generateBossRoom`, which was not a boss chamber at all: it was
// *the crystal room*, with the crystal pedestal baked into its tile list. That is
// why every dungeon would have ended in the same room.
//
// ⛔ THE PEDESTAL IS NOT PART OF THE SHAPE. Tiles $3a-$3f only depict a crystal
// altar in TILESET 2. Left in the shared layout, a cave-tileset dungeon would get
// a "pedestal" drawn from whatever $3a-$3f happen to be in tileset 0. It lives in
// `CRYSTAL_SKIN.decorate` and is stamped over the shape after it is carved — so
// Altar Cave's room is unchanged, and a dungeon with any other skin simply has
// floor where the altar would be.
//
// ⛔ THE WARP TILE IS NOT crystal-specific. Every dungeon's boss chamber has a
// way out (gated on `battleSt.enemyDefeated`, v1.10.19), so $61 stays in the
// shape.

// Diamond layout, originally transcribed from ROM map 148.
// Rows 8-10 / cols 5-7 are plain FLOOR here; the crystal skin puts the altar on.
const LAYOUT = [
  // y, x, tile — top narrowing approach (rows 2-4)
  [2,5,0x01],[2,6,0x01],[2,7,0x01],
  [3,5,0x02],[3,6,0x02],[3,7,0x02],
  [4,5,0x30],[4,6,0x30],[4,7,0x30],
  // diamond widens (rows 5-6); $61 at (6,5) is the warp out
  [5,4,0x01],[5,5,0x30],[5,6,0x61],[5,7,0x30],[5,8,0x01],
  [6,3,0x01],[6,4,0x02],[6,5,0x30],[6,6,0x30],[6,7,0x30],[6,8,0x02],[6,9,0x01],
  [7,3,0x02],[7,4,0x30],[7,5,0x30],[7,6,0x30],[7,7,0x30],[7,8,0x30],[7,9,0x02],
  // widest rows (8-10) — the boss stands at (6,8)
  [8,3,0x30],[8,4,0x30],[8,5,0x30],[8,6,0x30],[8,7,0x30],[8,8,0x30],[8,9,0x30],
  [9,1,0x01],[9,2,0x01],[9,3,0x30],[9,4,0x30],[9,5,0x30],[9,6,0x30],[9,7,0x30],[9,8,0x30],[9,9,0x30],[9,10,0x01],[9,11,0x01],
  [10,1,0x02],[10,2,0x02],[10,3,0x30],[10,4,0x30],[10,5,0x30],[10,6,0x30],[10,7,0x30],[10,8,0x30],[10,9,0x30],[10,10,0x02],[10,11,0x02],
  [11,1,0x30],[11,2,0x30],[11,3,0x30],[11,4,0x30],[11,5,0x30],[11,6,0x30],[11,7,0x30],[11,8,0x30],[11,9,0x30],[11,10,0x30],[11,11,0x30],
  // diamond narrows (rows 12-13)
  [12,3,0x30],[12,4,0x30],[12,5,0x30],[12,6,0x30],[12,7,0x30],[12,8,0x30],[12,9,0x30],
  [13,3,0x30],[13,4,0x30],[13,5,0x30],[13,6,0x30],[13,7,0x30],[13,8,0x30],[13,9,0x30],
  // narrowing exit (rows 14-17)
  [14,3,0x30],[14,6,0x30],[14,9,0x30],
  [15,3,0x30],[15,5,0x01],[15,6,0x30],[15,7,0x01],[15,9,0x30],
  [16,5,0x02],[16,6,0x30],[16,7,0x02],
  [17,5,0x30],[17,6,0x30],[17,7,0x30],
  // entrance (rows 18-19)
  [18,6,0x42],
  [19,6,0x6b],
];

/** The crystal altar — Altar Cave's dressing, meaningless outside tileset 2. */
const CRYSTAL_PEDESTAL = [
  [8,5,0x3a],[8,6,0x3f],[8,7,0x3e],
  [9,5,0x3a],[9,6,0x3f],[9,7,0x3e],
  [10,5,0x3b],[10,6,0x3c],[10,7,0x3d],
];

/**
 * A dungeon's boss-chamber skin. Per §4c a skin is
 * `{ donorMap, tileset, musicIn, musicOut }` — `decorate` is the fifth field,
 * for anything the skin draws INTO the shared shape.
 *
 * ⛔ Skin is not ending kind. What beating the boss DOES — the crystal NPC,
 * `startCrystalReveal()`, `ps.unlockedJobs` — belongs to the ending kind, not
 * here. Keeping them apart is the whole point of the split.
 */
export const CRYSTAL_SKIN = {
  donorMap: 148,
  tileset: 2,
  decorate(tilemap) {
    for (const [y, x, t] of CRYSTAL_PEDESTAL) tilemap[y * 32 + x] = t;
  },
};

/** The plain cave skin — no altar. What the Cave of Seals would use. */
export const CAVE_SKIN = {
  donorMap: 111,
  tileset: 0,
  decorate() {},
};

/**
 * Carve the boss chamber into `tilemap` and let `skin` dress it.
 * @returns {{entranceX:number, entranceY:number, warpTile:{x:number,y:number}}}
 */
export function carveBossChamber(tilemap, skin = CAVE_SKIN) {
  for (const [y, x, t] of LAYOUT) tilemap[y * 32 + x] = t;
  skin.decorate?.(tilemap);
  return { entranceX: 6, entranceY: 19, warpTile: { x: 6, y: 5 } };
}
