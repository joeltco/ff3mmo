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
// npc-gfx.js — how an FF3 NPC id becomes a sprite. THE LOOKUP, decoded.
//
// Node-clean on purpose (no imports, no DOM): tools and gates load it directly.
//
// ── the problem this closes ───────────────────────────────────────────────
// FF3's per-map NPC list ({id,x,y,flags}, pointer table at $058010) gives each
// NPC an `id`. That id is NOT a sprite index. Shipping it as one (v1.7.968)
// dressed all of Ur in player JOB sprites, because `0x1C010 + id * 0x100` lands
// in the job range for Ur's ids. `town-npcs.js` carried a standing warning
// about it and recorded three measured pairs nobody could explain:
//
//     gfx $14 -> bundle 32,   $15 -> 34,   $19 -> 38
//
// They are a table lookup. Searching the whole ROM for a 256-byte window
// satisfying all three yields EXACTLY ONE offset: 0x1410 — which is where the
// next table in the series belongs, right after the three parallel palette
// tables at 0x1110 / 0x1210 / 0x1310.
//
// ⛔ Those three are a shared palette LIBRARY — entry `i` holds colours 1, 2, 3
// of palette `i` (colour 0 is the backdrop). They are NOT indexed by npcId.
// A map picks its own entries via bytes 5-9 of its properties; for NPC sprites
// that is byte 8 (spritePalette6) and byte 9 (spritePalette7), read by
// `src/map-loader.js#buildSpritePalettes`. MEASURED off the PPU on 16 maps,
// 16/16 exact — see `tools/ff3-npc-palette.mjs`.
//
// ── how it was verified ───────────────────────────────────────────────────
// Predicted bundle sets vs. what the real PPU holds
// (`tools/monscan/map-bundles.cjs`), over every map the harness could load:
//
//     18 maps with drawn NPCs, 18 matched exactly, 0 misses.
//
// Including Ur 5/5, Castle Sasune 2/2, Kazus 4/4, and the two flames whose
// offsets flame-sprites.js had already measured by reading OAM: the Kazus
// campfire (id 190) and the large torch (id 193) resolve to the SAME index,
// which is exactly what that OAM capture found, while the candle (id 194)
// resolves to a different one.
//
// ⚠ The harness writes the map id as a single byte, so maps >= 256 actually
// load `mapId & 0xFF`. All seven such maps match the TRUNCATED map's
// prediction — they are not counter-examples, they are a harness limit.
//
// ── the index space ───────────────────────────────────────────────────────
//   0..21    player JOB walk sprites, in JOB_NAMES order. Confirmed: index 4
//            is the magic-shop keeper in BOTH Ur and Kazus, and job 4 is the
//            Black Mage — `map-loading.js` calls it `addBlackMageShopkeeper`.
//   22..63   NPC people. 16 tiles = four 2x2 facings (down, up, left, right).
//   64..87   OBJECTS. 8 tiles = two 2x2 animation frames, a DIFFERENT array.
//            Index 79 resolves to 0x14790, whose two frames are the star
//            sprite flame-sprites.js already had at 0x14790 / 0x147D0.
//   88+      NOT DRAWN. Renders as tilemap noise. Invisible event markers —
//            every shop counter trigger in the game is index 115.

/** File offset of the id -> gfx byte table (256 entries, one per NPC id). */
export const NPC_GFX_TABLE_OFF = 0x1410;

/** Walk-sprite array: 16 tiles per entry, four 2x2 facings. */
export const PEOPLE_BASE = 0x1C010;
export const PEOPLE_STRIDE = 0x100;

/** Object array: 8 tiles per entry, two 2x2 frames. */
export const OBJECT_BASE = 0x14010;
export const OBJECT_STRIDE = 0x80;

/** First gfx index that is an object rather than a person. */
export const OBJECT_FIRST = 64;
/**
 * First gfx index with no graphics at all.
 *
 * ⚠ NOMINAL, and deliberately so. The highest index any placed NPC uses as a
 * drawn sprite is 87; the lowest it uses as an invisible marker is 97. Indices
 * 88..96 are used by NOBODY, so the exact boundary inside that gap cannot be
 * measured and every value in [88, 97] behaves identically. It is pinned at 88
 * because that is one past the last index with real sprite data.
 *
 * I tried to separate them by transparent-pixel fraction first — the ranges
 * overlap (0.09..0.97 vs 0.05..0.77), so that discriminator proves nothing.
 * check-npc-gfx asserts the gap is real rather than asserting a false
 * precision about where in it the line sits.
 */
export const UNDRAWN_FIRST = 88;
/** gfx indices below this are player job sprites, not townsfolk. */
export const JOB_LAST = 21;

/** The gfx index an NPC id wears. `rom` must include the 16-byte iNES header. */
export function gfxForNpcId(rom, npcId) {
  return rom[NPC_GFX_TABLE_OFF + (npcId & 0xFF)];
}

/** 'job' | 'person' | 'object' | 'undrawn' — what a gfx index actually is. */
export function kindForGfx(gfx) {
  if (gfx >= UNDRAWN_FIRST) return 'undrawn';
  if (gfx >= OBJECT_FIRST) return 'object';
  if (gfx <= JOB_LAST) return 'job';
  return 'person';
}

/** ROM file offset of a gfx index's tiles, or null when it has none. */
export function offsetForGfx(gfx) {
  if (gfx >= UNDRAWN_FIRST) return null;
  if (gfx >= OBJECT_FIRST) return OBJECT_BASE + (gfx - OBJECT_FIRST) * OBJECT_STRIDE;
  return PEOPLE_BASE + gfx * PEOPLE_STRIDE;
}

/** Tiles per entry: people carry four facings, objects two frames. */
export function tileCountForGfx(gfx) {
  if (gfx >= UNDRAWN_FIRST) return 0;
  return gfx >= OBJECT_FIRST ? 8 : 16;
}

/** Convenience: NPC id straight to a walk-bundle offset (null if not drawn). */
export function bundleForNpcId(rom, npcId) {
  return offsetForGfx(gfxForNpcId(rom, npcId));
}
