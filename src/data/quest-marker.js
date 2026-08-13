// Quest-marker sprite — the NPC talk bubble with an exclamation mark.
//
// ROM-located, never hand-authored. Found by shape-searching the ROM with
// tools/sprite-find.mjs against a reference screenshot; the two frames sit
// contiguously and the slot after them is unrelated border art, so the
// animation is exactly two frames.
//
//   0x56A50  frame 0 — tiles 0x56A50 / 0x56A60 / 0x56A70 / 0x56A80  (TL TR BL BR)
//   0x56A90  frame 1 — tiles 0x56A90 / 0x56AA0 / 0x56AB0 / 0x56AC0
//
// Same layout as the torch/candle flames in flame-sprites.js: 8 tiles, two
// frames of four, 16x16 each.
//
// Palette indices inside the tiles:
//   0  transparent
//   1  outline
//   2  the exclamation mark   <-- recolour THIS to change marker meaning
//   3  bubble fill
//
// The bubble body, outline and tail are pixel-identical between the frames —
// only the mark changes (frame 0 has a fat-topped mark, frame 1 a narrow bar
// one row lower), so it reads as the "!" popping in place.
//
// There is NO "?" variant anywhere in the ROM: a silhouette scan of the whole
// surrounding bank turned up these two and nothing else. So a WoW-style
// "! to take / ? to hand in" vocabulary is not available without inventing
// art, which this project does not do. Marker STATE has to be carried by the
// mark's colour instead — which index 2 makes a one-entry palette swap.

export const QUEST_MARKER_OFFSET = 0x56A50;   // frame 0; frame 1 is +0x40
export const QUEST_MARKER_FRAMES = 2;
export const QUEST_MARKER_TILES_PER_FRAME = 4;

/** Palette slot occupied by the exclamation mark, for state recolouring. */
export const QUEST_MARKER_MARK_INDEX = 2;

// Marker palettes. Slot 0 is transparent; slots 1/3 are the bubble's own
// outline and fill and stay put, so only slot 2 differs between states.
// NES colour values (see NES_SYSTEM_PALETTE in tile-decoder.js).
const OUTLINE = 0x0F;   // black
const FILL    = 0x30;   // white
export const QUEST_MARKER_PALETTES = {
  // A quest is available here.
  available: [0x0F, OUTLINE, 0x16, FILL],   // red mark — matches the ROM art
  // Quest accepted, objective not finished yet.
  active:    [0x0F, OUTLINE, 0x28, FILL],   // amber mark
  // Objectives complete — come back and hand it in.
  turnin:    [0x0F, OUTLINE, 0x2A, FILL],   // green mark
  // Repeatable / already cleared once.
  repeat:    [0x0F, OUTLINE, 0x21, FILL],   // pale blue mark
};
