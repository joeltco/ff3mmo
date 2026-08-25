// ═══════════════════════════════════════════════════════════════════════════
// ⛔⛔⛔  DO NOT HALF-ASS THE DATA PULL.  ⛔⛔⛔
//
// THIS FILE IS THE APOLOGY FOR THE WORST CASE OF IT.
//
// FF3's per-map NPC entry is `{id, x, y, FLAGS}` — FOUR bytes. v1.10.69 placed
// all ten of Ur's townsfolk using id/x/y and threw the flags byte away, AFTER
// that byte had already been disassembled earlier the same day. Eight of ten
// shipped frozen in place, facing whatever the spec happened to guess, and the
// player's report was "random NPCs standing in random spots".
//
// A record has N fields. If you use fewer than N you have not read it — you
// guessed while holding the answer.
// ═══════════════════════════════════════════════════════════════════════════
//
// npc-flags.js — the NPC record's 4th byte, decoded.
//
// Node-clean on purpose (no imports, no DOM) so tools and gates load it
// directly and audit the SAME behaviour the game ships.
//
// ── the split, from the record handler (bank $3B, `$B34E`) ────────────────
//     LDA ($8C),Y            ; Y=3 -> the flags byte
//     STA $86
//     AND #$F0               ; -> npc struct +1        MOVEMENT
//     LDA $86 / ASL x4 / AND #$C0
//                            ; -> ($8A),Y=5            FACING (bits 2-3)
//
// ── MEASURED ON HARDWARE, not inferred ───────────────────────────────────
// MOVEMENT — high nibble `$00` roams, `$C0` holds its post. Booted the field
// ROM, warped to Ur, walked the party 90 steps and counted distinct tiles per
// NPC (`$7000 + slot*16`, +2/+3 = x/y):
//     $06 $0a $0c $0d $0e $0f  ->  15..27 tiles each   MOVES
//     $05 $07 $08 $09          ->   1 tile each        STANDS STILL
// 10 of 10 agree with the nibble. ⛔ Idling proves nothing — FF3 only steps
// NPCs while the field loop runs with the party walking. The first attempt sat
// still for 1440 frames, saw nobody move, and would have "proved" the opposite.
//
// FACING — `(flags >> 2) & 3`, read back at `$7100 + slot*16 + 5` as
// `value << 6`. Predicted vs measured:
//     Ur (map 114)      80 80 80 40 80 80 40 80 80 40   10/10
//     Sasune (map 18)   40 40 c0 c0 c0 c0                6/6
//     Kazus inn (12)    00 00 00 00 00 80 40 40 40 00   10/10
// ⛔ Ur alone only exercises facings 1 and 2 — two of four. Maps 18 and 12 were
// added precisely because they carry 3 and 0, so the domain is fully covered
// rather than confirmed by the cases that could not disagree.
//
// The order is DOWN, UP, LEFT, RIGHT, which is exactly DIR_DOWN..DIR_RIGHT in
// `sprite.js`, so the field maps straight through with no translation table.

/** Movement: the cartridge lets this NPC roam. */
export const flagsWander = (flags) => (flags & 0xF0) === 0;

/** Facing: 0 DOWN, 1 UP, 2 LEFT, 3 RIGHT — same order as `DIR_*`. */
export const flagsFacing = (flags) => (flags >> 2) & 3;

/**
 * The ROM record standing on a tile, decoded — or `null` when there is none
 * (an ff3mmo-placed NPC), in which case the spec's own dir/wander stand.
 */
export function romFlagsAt(mapData, tileX, tileY) {
  if (!mapData || !mapData.npcs) return null;
  const rec = mapData.npcs.find((n) => n.x === tileX && n.y === tileY);
  if (!rec) return null;
  return { dir: flagsFacing(rec.flags), wander: flagsWander(rec.flags), flags: rec.flags };
}

/**
 * Apply the cartridge's flags to a spec unless it explicitly opts out.
 *
 * ⛔ ONE RECONCILIATION, AND IT IS DELIBERATE. FF3 will step an NPC off a tile
 * with a single open neighbour; ff3mmo's wander rule will not — `npc.js` only
 * moves onto tiles with >= MIN_OPEN_NEIGHBOURS, which is what stops a wanderer
 * jamming itself in a doorway. So a ROM record that says "roam" on a tile our
 * rule cannot roam from would spend the whole game failing to take a step,
 * which looks identical to the frozen NPCs this whole module exists to fix.
 * Those hold their post instead, and `town-npc-audit` prints them as
 * ROM-SAYS-ROAM so the difference is visible rather than silently swallowed.
 */
export function specWithRomFlags(spec, mapData, tileX, tileY, canRoamFrom) {
  if (!spec || spec.ignoreRomFlags) return spec;
  const rf = romFlagsAt(mapData, tileX, tileY);
  if (!rf) return spec;
  const penned = rf.wander && typeof canRoamFrom === 'function' && !canRoamFrom(mapData, tileX, tileY);
  return {
    ...spec,
    dir: rf.dir,
    wander: rf.wander && !penned,
    animate: true,
    romWanted: rf.wander,          // what the cartridge asked for
    penned: !!penned,              // ...and whether our walk rule allowed it
  };
}

/** Can a wanderer legally take a step from here, under ff3mmo's own rule? */
export function makeCanRoamFrom(isWalkableForNpc, minOpenNeighbours) {
  return (mapData, x, y) => {
    let n = 0;
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      if (isWalkableForNpc(mapData, x + dx, y + dy)) n++;
    }
    return n >= minOpenNeighbours;
  };
}
