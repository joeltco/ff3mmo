// Which palette an NPC wears — the map's, not the spec author's.
//
// Node-clean and import-free so gates and tools can share the REAL rule instead
// of restating it; `src/npc.js` calls this at placement time.
//
// FF3 gives an NPC's head tiles and body tiles DIFFERENT sprite palettes (that
// is why townsfolk read tan-faced in a blue tunic), and each map carries its own
// pair: SP2 for the body, SP3 for the head. `data/town-npcs.js` builds every
// interior NPC through one `interior()` helper that hard-codes the inn's pair,
// under a comment claiming "each map's own SP2/SP3 are the same values for Ur's
// buildings". Measured against the ROM that holds for the tavern, the inn and
// the weapon shop — and is false for the armor shop and BOTH floors of the
// elder's house, where it rendered a white-robed attendant in pink and the
// elder's kin pink-haired instead of blonde. v1.8.10.
//
// Slot 0 is kept from the spec: it is the transparent index the sprite renderer
// never paints, so taking the ROM's own value there would read as a change that
// is not a change.

export function mapPalettesForSpec(spec, mapData) {
  const pals = mapData && mapData.spritePalettes;
  if (!spec || !spec.palTop || !spec.palBtm) return spec;
  if (!pals || !pals[0] || !pals[1]) return spec;
  return {
    ...spec,
    palTop: [spec.palTop[0], pals[1][1], pals[1][2], pals[1][3]],   // SP3 — head / hair
    palBtm: [spec.palBtm[0], pals[0][1], pals[0][2], pals[0][3]],   // SP2 — body
  };
}
