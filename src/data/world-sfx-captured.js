// world-sfx-captured.js — CAPTURED by tools/monscan/world-sfx-sweep.cjs.
//
// The non-battle sounds: menus, chests, doors, warps, the encounter swoosh, the
// opening quake. `spell-sfx-captured.js` covers everything a SPELL plays,
// because the spell sweep can cast all 56. It could not open a chest or walk
// through a door, so v1.7.873 shipped 12 constants on a `SFX $NN + $41` formula.
//
// Method: FF3J fires a sound by writing `0x80 | sfxId` to $7F49; the NSF track
// is `written - 0x3F`. Every write is tagged with the CPU PC and resolved back
// to a ROM OFFSET, so a sound is identified by the CODE SITE that asked for it,
// not by matching the value against what we already ship (which would be
// circular). Attribution to an EVENT comes from what the machine was doing: a
// screenshot at the write, another 70-200 frames later, whether the screen faded
// to black, and whether a battle appeared.
//
// ── Getting there ──────────────────────────────────────────────────────────
//
// 200k frames of scripted walking never left the Altar Cave, so the door and
// warp sounds were unreachable by playing. They are reached by PATCHING instead:
// `MAP=<id>` copies one map's three per-map ROM tables (properties, tilemap ID,
// graphics subset) over all 512, so whatever map the intro loads is the map you
// asked for, and `SPAWN=x,y` rewrites its entrance coordinates so the party
// appears one tile from the trigger. Target coordinates come from the ROM's own
// tilemaps via tools/map-trigger-dump.mjs. Only DATA tables are touched, never
// code, so every $7F49 store stays where the resolver expects it.
//
// ── Why "observed" is kept apart from "attributed" ─────────────────────────
//
// Hearing the value a constant predicts proves the game plays that sound. It
// does NOT prove it plays it for the event the constant is named after. Those
// are the easy half and the hard half (docs/SWEEP-DISCIPLINE.md), so the tiers
// below are separate and the deploy gate asserts they stay separate.

/**
 * Sound is measured AND tied to the event the constant is named for.
 * Value is the NSF track number, i.e. exactly what `SFX.<NAME>` must equal.
 */
export const CAPTURED_WORLD_SFX = new Map([
  // Cursor movement in the name grid and the battle command window. Two distinct
  // `LDA #$98` sites — 0x7d225 (field) and 0x65bea (battle).
  ['CURSOR', 89],
  // Selecting a battle command row that does not exist. The window holds four
  // rows (Attack / Guard / Run / Item, read off a screenshot); rows past them
  // buzz on EVERY attempt, 20/20 per row, while valid rows never do. Also fires
  // from its own `LDA #$86` site (0x7d53b) on the field.
  ['ERROR', 71],
  // Opening a treasure chest: A pressed at a chest, from the ROM's ONLY
  // `LDA #$BF / STA $7F49` (0x7e994). The screenshot shows the party against a
  // row of chests, the follow-up shows one open.
  ['TREASURE', 128],
  // The random-encounter swoosh, from the only `LDA #$95` site (0x7d35f). A
  // battle is on screen within 240 frames 11 times out of 11, while every other
  // field sound in the same run scores 0 — 0/8 quake, 0/3, 0/1. The CONTRAST is
  // the measurement; "it was followed by a battle" alone would not be.
  ['EARTHQUAKE', 153],
  ['BATTLE_SWIPE', 86],
  // Walking onto a door tile in Ur (map 114, door at 21,26 approached from
  // 21,27), from the ROM's only `LDA #$83` site (0x7e6ad). Fired 14 times in 14
  // passes, each followed by a fade to black — i.e. a real map transition, which
  // is what distinguishes it from the $83 seen earlier in the cave.
  ['DOOR', 68],
  // Walking onto the warp tile in the crystal chamber (map 149 at 6,5), 5 of 5
  // passes, each with a fade to black; the screenshot shows a glowing portal.
  // Worth remembering: $dc appears at NO immediate site in the ROM, which had
  // been noted as "suggestive" that WARP might be wrong. It is not wrong — the
  // write comes through the `LDA $CA` dispatcher. The absence signal was
  // correctly labelled not-proof, and acting on it would have broken a good
  // constant.
  ['WARP', 157],
  // The transition wipe, both halves, each from its OWN dedicated site rather
  // than the shared store: $93 closing at 0x7c1cd and $94 opening at 0x7e2e4.
  // Both fire on the map-149 warp (4/5 and 5/5, with fades), and $93 also fires
  // 14/14 immediately after the Ur door. That matches how our own transitions.js
  // uses them.
  ['SCREEN_CLOSE', 84],
  ['SCREEN_OPEN', 85],
]);

/**
 * Heard, from the site the constant implies — but the EVENT is not pinned.
 *
 * Currently empty: DOOR and SCREEN_CLOSE both graduated once their events were
 * demonstrated. The tier stays because the gate uses it to keep "we heard the
 * number" from being filed as "we know what it is".
 */
export const OBSERVED_UNATTRIBUTED = new Map([]);

/**
 * Never heard. Listed rather than glossed — see the CHANGELOG for what each
 * would take.
 */
export const NOT_CAPTURED = [
  // The escape sound. The ROM has exactly one `LDA #$B3` (0x67cc9), in a routine
  // starting at $BC89 that runs a 32-iteration loop setting a per-character flag
  // ($7D83,X |= $80) for all four party slots and only then plays the sound.
  // FORCING entry (patching the party-hit store to `JMP $BC89`) does produce
  // $b3 -> 116 and visibly empties the battlefield, so the routine and the value
  // are right — but a forced jump is not the player escaping, so this stays
  // uncaptured. Two dead ends worth not repeating: that loop's
  // `JSR $8AE6 / AND #$20 / BEQ` looks exactly like a joypad test and is not
  // ($8AE6 is `INC $B6 / LDA $B6 / RTS`, a counter), and Run is a MENU ROW, not
  // a held button — 36 combos and 600-frame holds were chasing a control scheme
  // the game does not have.
  'RUN_AWAY',
  // Never heard; its implied write $d0 has not appeared at any site. Explicitly
  // NOT evidence it is wrong — that is exactly what was true of WARP right up
  // until the crystal-chamber capture. It needs the right tile found.
  'POND_DRINK',
  // FALL is a SONG (0x30), not an SFX, so `nsf + 0x3F` does not apply and no
  // store to $7F49 can confirm or refute it. Out of this method's reach.
  'FALL',
];

/**
 * Sounds the game demonstrably plays that NO constant in music.js accounts for.
 * Recorded so they are not rediscovered as "new" a third time; none is wired to
 * anything and none is claimed to be any particular event.
 */
export const UNACCOUNTED_SFX = [
  { wrote: 0x8f, nsf: 80, where: 'event trigger, farming village (map 69 at 20,16)' },
  { wrote: 0xd9, nsf: 154, where: 'event trigger, map 125 at 17,17; sits beside EARTHQUAKE $d8 in ROM' },
  { wrote: 0xbe, nsf: 127, where: 'intro sequence' },
  { wrote: 0xc6, nsf: 135, where: 'battle, seen on the Guard row' },
];
