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
import { dungeonForMapId, floorIndexForMapId, isBossFloor } from '../data/dungeons.js';

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

/**
 * The Cave of Seals — no altar, olive rock, dark-green floor.
 *
 * ⭐ DONOR IS MEASURED, NOT GUESSED. Map property byte 2 is the location-name
 * index: the banner string is `0x100 + byte2`. Map 111 -> $9e -> "Altar Cave",
 * map 114 -> $7c -> "Ur", and decoding the byte for all 256 maps names 78 of
 * them, every one a real place. Byte 5 (area) then groups a dungeon's floors:
 *
 *     area $18  maps 103,104,105,106   Sealed Cave / B2F / B3F   palette $79
 *     area $30  maps 22,111,112,113,115  Altar Cave / B2F        palette $78
 *     area $31  maps 116,117,118,119   Subterranean Lake         palette $8b
 *
 * ⛔ THIS SKIN USED TO POINT AT 111 — Altar Cave's own donor, so the "cave"
 * skin repainted the boss room in the crystal dungeon's palette and the swap
 * was invisible. A later guess at map 116 was worse: that is the Subterranean
 * Lake, a different dungeon entirely. Both were inferences from palettes and
 * area bytes. The name table is the ROM saying it outright, so use that.
 *
 * Both caves are tileset 0, so this is a PALETTE swap ($78 -> $79) over the
 * same tile ids — no tile remapping needed.
 */
/**
 * The Sealed Cave's dais — `$3a $3f $3e` / `$3b $3c $3d`, transcribed from ROM
 * map 106 at (7,18).
 *
 * ⭐ THE SAME SIX IDS AS THE CRYSTAL ALTAR. I previously claimed stamping them
 * into a cave tileset would draw garbage; that was read off a tile chart without
 * checking whether the ROM ever uses them there. It does: maps 106 (Sealed Cave
 * B3F) and 119 both build this 3x2 structure, and it renders as a raised dais in
 * the cave palette. The crystal room is the SAME structure with its middle row
 * repeated once — 3 rows instead of 2.
 *
 * ⛔ Placed at rows 8-9 so the boss stands on the top row at (6,8), mirroring the
 * crystal room where the Wind Crystal NPC stands on the altar's top row. In
 * tileset 0 these tiles collide as `$41` — the same as FLOOR — so the dais is
 * walk-on, unlike the crystal altar's blocking `$40`.
 */
const SEALS_DAIS = [
  [8,5,0x3a],[8,6,0x3f],[8,7,0x3e],
  [9,5,0x3b],[9,6,0x3c],[9,7,0x3d],
];

export const SEALS_SKIN = {
  donorMap: 103,
  tileset: 0,
  /**
   * ⭐ The boss NPC is in the ROM too: map 106 places NPC id 62 at (8,18),
   * standing on this dais. `NPC_GFX_TABLE[0x144e]` = gfx `0x4a` = map-object
   * offset `0x14510` — 8 tiles, two 16x16 frames, a two-frame idle of a
   * bare-chested figure with a topknot. gfx `0x4a` is used by exactly ONE npc id
   * in the whole ROM, so it is not shared art.
   */
  bossSpriteOffset: 0x14510,
  bossSpriteFrames: 2,
  // Sprite palette index, by the SAME rule `flame-sprites.js` uses for map
  // objects: `((flags >> 2) & 3) >= 2 ? 1 : 0`. Map 106's NPC 62 record carries
  // flags $EE -> index 1 -> the Sealed Cave's SP3 = [$0F,$0F,$16,$36].
  // ⛔ NOT PICKED BY EYE. Generated floors do not carry `spritePalettes` yet, so
  // nothing DRAWS this—see the changelog; the value is measured and pinned here
  // rather than chosen when the drawing lands.
  bossSpritePalIdx: 1,
  decorate(tilemap) {
    for (const [y, x, t] of SEALS_DAIS) tilemap[y * 32 + x] = t;
  },
};

/**
 * Carve the boss chamber into `tilemap` and let `skin` dress it.
 * @returns {{entranceX:number, entranceY:number, warpTile:{x:number,y:number}}}
 */
/**
 * Skins by id, so `data/dungeons.js` can name one without importing this module
 * (it is a leaf — see the header there). A dungeon row's `bossSkinId` is a key
 * into this object; `resolveBossSkin` is the only place that lookup happens.
 */
export const BOSS_SKINS = {
  crystal: CRYSTAL_SKIN,
  seals:   SEALS_SKIN,
};

/**
 * Resolve a dungeon row's `bossSkinId`.
 *
 * ⛔ THROWS on an unknown id rather than falling back. A typo'd skin id that
 * silently returned the seals skin would look like a working dungeon with the
 * wrong art, which is exactly the failure this registry was built to end — the
 * old code hardcoded `CRYSTAL_SKIN` and every dungeon got a crystal room.
 */
export function resolveBossSkin(skinId) {
  const skin = BOSS_SKINS[skinId];
  if (!skin) throw new Error(`unknown boss skin id '${skinId}' — known: ${Object.keys(BOSS_SKINS).join(', ')}`);
  return skin;
}

/**
 * The ROM map a dungeon mapId borrows its art from — boss chambers use the boss
 * skin's donor, every other floor uses the dungeon's.
 *
 * ⛔ THIS LIVES HERE, NOT IN THE REGISTRY. `data/dungeons.js` is a leaf and
 * cannot import the skins, so putting a `bossDonorMap` field on each row would
 * mean the donor is written down twice — once on the row and once on the skin —
 * and the two would drift. The registry names a skin; this resolves it.
 *
 * Replaces `const romMap = (mapId === 1004) ? 148 : 111` in `map-loading.js`,
 * which was the battle-background lookup and therefore ALSO a per-dungeon fact.
 */
export function resolveDungeonDonor(mapId) {
  const dungeon = dungeonForMapId(mapId);
  if (!dungeon) return null;
  const floorIndex = floorIndexForMapId(mapId);
  // Side rooms (locked / secret) are not floors and borrow the dungeon's art.
  if (floorIndex !== null && isBossFloor(dungeon, floorIndex)) {
    return resolveBossSkin(dungeon.bossSkinId).donorMap;
  }
  return dungeon.donorMap;
}

export function carveBossChamber(tilemap, skin = SEALS_SKIN) {
  for (const [y, x, t] of LAYOUT) tilemap[y * 32 + x] = t;
  skin.decorate?.(tilemap);
  return { entranceX: 6, entranceY: 19, warpTile: { x: 6, y: 5 } };
}
