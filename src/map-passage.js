// map-passage.js — the passage rewrite the engine applies to every map load.
//
// A LEAF on purpose (no imports). This lived in `map-triggers.js`, which pulls in
// the roster, the message box and `ui-state.js` — so a map tool that wanted it
// got `window is not defined` and every reachability tool in tools/ simply went
// without. That is not a cosmetic problem: skipping it models each map more
// CLOSED than the game is. Ur's secret house reads as 28 tiles with its treasure
// room walled off; the live game gives 49 and an open way in. `check-area-graph`
// reported map 1 "unreachable" for exactly this reason, and it was wrong.
//
// `map-triggers.js` re-exports it under the same name, so call sites are unchanged.

/** FF3 $D6/$D7: $5B → $5D (doorframe top), $5C → $5E (walkable passage). */
export function applyPassage(tm) {
  for (let i = 0; i < tm.length; i++) {
    if (tm[i] === 0x5B) tm[i] = 0x5D;
    if (tm[i] === 0x5C) tm[i] = 0x5E;
  }
}
