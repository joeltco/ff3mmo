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
// ⛔⛔ FACING IS NOT DECODED. DO NOT GUESS IT AGAIN.
//
// v1.10.76 shipped `(flags >> 2) & 3` as facing and standing NPCs faced the
// wrong way. That field is the PALETTE SELECTOR — `flame-sprites.js:92` reads
// exactly `((flags >> 2) & 3) >= 2 ? 1 : 0` to pick a torch palette, and
// `town-npcs.js` says so in a comment that was read straight past.
//
// How the wrong answer survived: the byte at `$7100 + slot*16 + 5` was verified
// to EQUAL `(flags >> 2) & 3 << 6` on 26 records across three maps — a perfect
// score that proves only that the number arrives, NOT what it means. Then the
// DIRECTION was assumed from a comment instead of measured.
//
// What killed it (`facedir.cjs`): match each NPC's on-screen OAM tiles back to
// a 4-tile group of its own walk bundle, and read the H-flip bit.
//     $05 (map 114, field value 2) -> group 3 + HFLIP -> drawn RIGHT
//     $1e (map 10,  field value 1) -> group 3 + HFLIP -> drawn RIGHT
// DIFFERENT field values, IDENTICAL facing. One number cannot be both.
//
// ⛔ Also note the bundle holds DOWN, UP, LEFT-f0, LEFT-f1 — only THREE
// directions. RIGHT is a mirrored LEFT, so a group index is not a facing index
// either. Whoever decodes this must measure the DRAWN direction, not a byte.
//
// Until then facing comes from the spec, hand-set per NPC, and `specWithRomFlags`
// leaves `dir` alone.

/** Movement: the cartridge lets this NPC roam. */
export const flagsWander = (flags) => (flags & 0xF0) === 0;

/**
 * ⛔ NOT FACING — the PALETTE selector. Kept named for what it IS so nobody
 * wires it as a direction again. See `flame-sprites.js#npcPalIdx`.
 */
export const flagsPaletteSel = (flags) => (flags >> 2) & 3;

/**
 * The ROM record standing on a tile, decoded — or `null` when there is none
 * (an ff3mmo-placed NPC), in which case the spec's own dir/wander stand.
 */
export function romFlagsAt(mapData, tileX, tileY) {
  if (!mapData || !mapData.npcs) return null;
  const rec = mapData.npcs.find((n) => n.x === tileX && n.y === tileY);
  if (!rec) return null;
  // ⛔ NO `dir` HERE. Facing is undecoded — see the banner above.
  return { wander: flagsWander(rec.flags), flags: rec.flags };
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
  // ⛔ `dir` IS DELIBERATELY UNTOUCHED. Only MOVEMENT is decoded (measured
  // 10/10 on hardware); facing is not, and guessing it is what made standing
  // NPCs face the wrong way.
  return {
    ...spec,
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
