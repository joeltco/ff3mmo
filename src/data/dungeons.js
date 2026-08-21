// Dungeon endings — what beating a dungeon's boss DOES.
//
// A hand-maintained leaf, imports nothing.
//
// ⛔ ENDING KIND IS NOT SKIN. Skin is tiles, palettes, music and battle
// background — what the boss chamber looks and sounds like, and it is a
// per-dungeon thing every dungeon has (`dungeon/boss-chamber.js`). Ending kind
// is what happens when the boss dies. Altar Cave is a CRYSTAL dungeon: its boss
// dissolves into the Wind Crystal and unlocks jobs. The Cave of Seals is a
// regular dungeon — a boss at the end, and nothing else. Conflating the two axes
// is how they got welded together in the first place.
//
// ⛔ THE DISSOLVE ITSELF IS NOT CRYSTAL-SPECIFIC. Every boss dissolves; that is
// the death animation. Only the crystal reveal, the standing crystal NPC and the
// job unlock belong to the crystal ending.

export const ENDING_CRYSTAL = 'crystal';
export const ENDING_BOSS    = 'boss';

/** Wind Crystal — Warrior, Monk, White Mage, Black Mage, Red Mage (bits 1-5). */
export const WIND_CRYSTAL_JOBS = 0x3E;

// The one crystal chamber that exists: Altar Cave's, mapId 1004.
const CRYSTAL_CHAMBERS = new Set([1004]);

/**
 * What kind of ending does this map's boss have?
 *
 * Read at boss-death time from the map the fight is happening on, rather than
 * cached on `battleSt`, so it cannot go stale between entering a dungeon and
 * killing the thing at the bottom.
 *
 * Defaults to a plain boss ending: a new dungeon gets no crystal unless it is
 * explicitly listed above. That default is the point — the old code did the
 * opposite, handing a Wind Crystal to ANY boss that died.
 */
export function endingKindFor(mapId) {
  return CRYSTAL_CHAMBERS.has(mapId) ? ENDING_CRYSTAL : ENDING_BOSS;
}

/** Convenience for the map-load and battle paths. */
export function isCrystalChamber(mapId) { return endingKindFor(mapId) === ENDING_CRYSTAL; }
