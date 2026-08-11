// world-sfx-captured.js — CAPTURED by tools/monscan/world-sfx-sweep.cjs.
//
// The non-battle sounds: menus, chests, the encounter swoosh, the opening quake.
// `spell-sfx-captured.js` covers everything a SPELL plays, because the spell
// sweep can cast all 56. It cannot open a chest or move a menu cursor, so
// v1.7.873 shipped 12 constants still carrying a `SFX $NN + $41` formula rather
// than a measurement. This file holds the ones now measured, and — just as
// importantly — names the ones that are NOT.
//
// Method: FF3J fires a sound by writing `0x80 | sfxId` to $7F49; the NSF track
// is `written - 0x3F`. The sweep tags every write with the CPU PC and resolves
// it back to a ROM OFFSET, so a sound is identified by the CODE SITE that asked
// for it, not by matching the value against what we already ship (which would
// be circular). Attribution to an EVENT then comes from what the machine was
// doing: a screenshot at the write, a screenshot 70-200 frames later, whether
// the screen faded to black, and whether a battle appeared.
//
// ── Why "observed" is not the same as "attributed" ─────────────────────────
//
// Hearing the value the constant predicts proves the game plays that sound. It
// does NOT prove the game plays it for the event the constant is named after.
// Those are the easy half and the hard half, and this whole sweep arc keeps
// getting burned by shipping the easy one (docs/SWEEP-DISCIPLINE.md). So the
// two tiers below are kept apart on purpose, and only ATTRIBUTED is gated.

/**
 * Sound is measured AND tied to the event the constant is named for.
 * Value is the NSF track number, i.e. exactly what `SFX.<NAME>` must equal.
 */
export const CAPTURED_WORLD_SFX = new Map([
  // Cursor movement in the name grid and in the battle command window. Fires
  // from two distinct `LDA #$98` sites (0x7d225 field, 0x65bea battle).
  ['CURSOR', 89],
  // Selecting a command row that does not exist. The battle menu has three
  // rows; rows 3-6 buzz on EVERY attempt (20/20 per row, 12 rounds), while rows
  // 0-2 never do. Also fires from its own `LDA #$86` site (0x7d53b) on the field.
  ['ERROR', 71],
  // Opening a treasure chest: A pressed facing a chest, from the ROM's ONLY
  // `LDA #$BF / STA $7F49` (0x7e994). Screenshot at the write shows the party
  // against a row of chests; the follow-up shows one of them open.
  ['TREASURE', 128],
  // The random-encounter swoosh, from the only `LDA #$95` site (0x7d35f). A
  // battle is on screen within 240 frames of this sound 11 times out of 11,
  // while every other field sound in the same run scores 0 — 0/8 for the quake,
  // 0/3 for $83, 0/1 for the chest. That contrast is the measurement; "it was
  // followed by a battle once" would not be.
  ['BATTLE_SWIPE', 86],
  // The opening earthquake, from the only `LDA #$D8` site (0x775a1), during the
  // intro sequence before control is handed over.
  ['EARTHQUAKE', 153],
]);

/**
 * Heard, from the site the constant implies — but the EVENT is not pinned.
 *
 * Deliberately not gated. Promoting one of these to CAPTURED_WORLD_SFX needs the
 * event demonstrated, not just the number matched.
 */
export const OBSERVED_UNATTRIBUTED = new Map([
  // $93 arrives at the window-routine store $E28F, 3 times in 200k frames. Rare
  // enough that it is plainly not "every window that closes", and no close was
  // isolated well enough to say what it belongs to.
  ['SCREEN_CLOSE', 84],
  // $83 fires on the field, always at the SAME map position, 7 times in 200k
  // frames — a tile trigger the party keeps walking back onto. No fade to black
  // follows, so it is NOT a map transition, and the Altar Cave has no doors. The
  // value matches DOOR; the event does not.
  ['DOOR', 68],
]);

/**
 * Never heard once, across ~250k frames of scripted play. Listed rather than
 * glossed — see the CHANGELOG for what each would take.
 */
export const NOT_CAPTURED = [
  // The escape sound. The ROM has exactly one `LDA #$B3` (0x67cc9), reached only
  // after a 32-iteration animation loop, so it plays on a SUCCESSFUL escape. 36
  // button combos and 21 command-menu walks never escaped. NOTE: the loop's
  // `JSR $8AE6 / AND #$20 / BEQ` looks like a joypad test and is NOT — $8AE6 is
  // `INC $B6 / LDA $B6 / RTS`, a loop counter. Reading it as "hold SELECT to
  // run" was tested and is wrong.
  'RUN_AWAY',
  // $94 is the fall-through literal at the same shared store that produced $93,
  // so the game can request it, but it never did in any run here.
  'SCREEN_OPEN',
  // Their implied writes ($dc, $d0) appear at NO immediate site in the ROM. That
  // is a signal, not a proof: spell sounds are table-driven and also absent, and
  // SIGHT/FIRE_BOOM are both measured-correct while absent. Needs a town.
  'WARP', 'POND_DRINK',
  // FALL is a SONG (0x30), not an SFX, so `nsf + 0x3F` does not even apply to
  // it — it cannot be checked by this method at all.
  'FALL',
];
