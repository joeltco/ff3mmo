// sprite-names.js — WHO A WALK BUNDLE DEPICTS, when we actually know.
//
// ⛔ THIS FILE EXISTS BECAUSE THE NAMED SHEET WAS WRONG, AND CONFIDENTLY SO.
//
// `docs/sprites/ff3-npc-sheet-named.png` derives its names from `selfName()`
// over `npcId + 0x202` — the string an NPC's line opens with ("Cid:", "Sara:").
// That offset is a DESCRIPTION of FF3's string table with a MEASURED
// counterexample, not a derivation: the talk routine reads a per-NPC byte out
// of RAM at `$0740,X` that the engine rewrites. Used for identity it produced:
//
//   * FOUR different sprites labelled « Cid » — gfx 31, 45, 46 — none of them his
//   * « Sara » AND « Desch » on the SAME bundle, 0x1D910
//   * Cid's own line, "I'm Cid from Canaan", on the CASTLE SASUNE GATE GUARD
//
// The Sara/Desch collision is what got Cid's label deleted from
// `town-npcs.js#STORY_SPRITE_BUNDLES` ("one sprite cannot be both Sara and
// Desch, so it is a shared townsfolk sprite"). The sprite was Cid's all along.
//
// ── the rule ──────────────────────────────────────────────────────────────
// ⛔ NEVER identify a character from `npcId + 0x202`. A name goes in here only
// with evidence you can point at — a sprite match, a PPU capture, or Joel. The
// sheet renders THESE in gold and everything else as "unverified", so a guessed
// name can never again look like a known one.
//
// To identify a bundle: render its DOWN frame (4 tiles at `0x1C010 + gfx*0x100`,
// row-major) and shape-match the transparency mask against a reference picture
// across all 88 bundles. Cid scored 90.2%, nine points clear of second place.
// ⛔ KEYED ON THE NPC ID, NOT THE BUNDLE. FF3 reuses walk sprites heavily — the
// bundle that DEPICTS Cid is worn by ids 31, 67, 192 and 217. Naming the bundle
// "Cid" makes all four Cid, which is the same over-claim as calling it Sara
// because id 67 wears it. Only id 31 at Kazus (17,21) is the man himself.
export const CONFIRMED_NPC_NAMES = new Map([
  [31, {
    name: 'Cid',
    bundle: 0x01D910,
    evidence: 'sprite match 90.2% vs Joel’s reference (red cap + robe), 9pts clear of all 88; docs/NPC-CATALOG.md "The NPC wearing Cid is id 31 at (17,21)"',
  }],
]);

/** The confirmed name for an npc id, or null. Never guesses. */
export function confirmedName(npcId) {
  const e = CONFIRMED_NPC_NAMES.get(npcId);
  return e ? e.name : null;
}

/** Bundles that DEPICT a named character, even where others reuse the art. */
export function depictsName(romOffset) {
  for (const e of CONFIRMED_NPC_NAMES.values()) if (e.bundle === romOffset) return e.name;
  return null;
}
