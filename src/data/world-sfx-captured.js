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
  // A successful escape from a random battle, on an UNPATCHED ROM. Run is a
  // MENU ROW — the battle window reads Attack / Guard / Run / Item — and it is
  // PER CHARACTER: earlier attempts picked Run for one party member and then
  // mashed A (= Attack) for the other three, so the party never actually left.
  // Choosing Run for all four, round after round, escapes. Fired once in 34
  // full-party rounds across 9 battles, at frame 30655; escape is a roll, so
  // most rounds fail. Corroborated independently by forcing entry to the routine
  // at $BC89 (patching the party-hit store to `JMP $BC89`), which plays the same
  // $b3 and visibly clears the battlefield.
  //
  // ONE natural occurrence, reproducible rather than replicated — jsnes is
  // deterministic, so re-running the identical script reproduces the same escape
  // rather than sampling a new one.
  ['RUN_AWAY', 116],
  // Drinking from the Altar Cave pond (map 115, water at 29,8, party spawned at
  // 29,9). A pressed at the water fired $d0 on 69 of 70 rounds, and $89 -> 74
  // (CURE) follows every single time as the heal lands — which is exactly the
  // two-sound sequence our own `handlePondHeal` already plays. The screenshot
  // shows the party standing at the pool.
  //
  // This was the last one, and it was nearly written off. Across a sweep of all
  // 215 event triggers in the game, every Altar Cave floor, and ~300k frames of
  // play, $d0 had never once appeared, and an earlier attempt at this very tile
  // produced silence. The pond is not an event trigger at all — it is plain
  // walkable water, so no trigger sweep could ever have found it. Had that
  // negative been reported as "the ROM never plays this", it would have been
  // confidently wrong.
  ['POND_DRINK', 145],
]);

/**
 * Songs, which do NOT come through $7F49 at all.
 *
 * FALL is a SONG (track 0x30), so `nsf - 0x3F` never applied to it and the SFX
 * sweep had nothing to see — v1.7.874/875 correctly reported it as out of reach
 * rather than pretending. Songs are requested by writing the id to $7F43, found
 * from the ROM: only two literals are ever stored there and one is $37, exactly
 * our TITLE_SCREEN track.
 *
 * Value is the song id, i.e. what `SFX.FALL` must equal directly — no
 * arithmetic. The instrument is self-checking: the same runs report song 31 on
 * Ur (which is literally the `songId` byte in Ur's ROM property row) and song 32
 * when a battle starts (our `TRACKS.BATTLE`).
 */
export const CAPTURED_WORLD_SONGS = new Map([
  // The intro's fall into the Altar Cave. Requested at frame 2733, immediately
  // after the name grid closes and the screen blacks out; frame 2860 shows a
  // lone character against pure black (the fall), and by 2980 the party is
  // standing in the cave. Song 2 (the cave theme) is requested at 2941, so song
  // 48 spans exactly the falling sequence and nothing else.
  ['FALL', 48],
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
/**
 * Empty: all twelve are captured. Kept, with the tier machinery, because the
 * gate uses these lists to keep "we heard the number" from being filed as "we
 * know what it is" the next time a constant needs measuring.
 */
export const NOT_CAPTURED = [];

/**
 * SETTLED: what each battle command row plays. v1.7.877.
 *
 * v1.7.875 saw ONE `$c6` while selecting Guard and ONE `$a0` while selecting
 * Run, and raised the possibility that DEFEND_HIT (97 = `$a0`) belonged to the
 * Run row and Guard's real sound was 135 (`$c6`). It reported that rather than
 * acting on it, because one sample is not a measurement. Good call — it is wrong.
 *
 * Measured in a sandbox battle: every encounter patched to a single goblin with
 * 0x7FFF HP (cannot be killed) and hit% + attack power zeroed (cannot kill the
 * party), so a fight runs indefinitely and one command can be picked for all
 * four characters, round after round. Three earlier attempts died because Guard
 * and Run kill nothing, the party wipes, and the run ends — "3 rounds over 0
 * battles" is not data.
 *
 *   value  nsf    Attack(25)  Guard(25)  Run(11)  Item(0)
 *   $85     70          99         96       45        0     confirm, every pick
 *   $98     89           0         48       46        0     cursor — MY down-presses, not the command
 *   $b6    119          49         51       20        0     the monster's turn, every row alike
 *   $ff    192          98        102       40        0     stop-sfx, every row alike
 *   $a0     97           0          0        2        0
 *   $b3    116           0          0        1        0     escape success
 *
 * Findings, and a CORRECTION to how confidently v1.7.877 first stated them:
 *
 *  - `$c6` NEVER APPEARS, in 61 rounds of battle-menu interaction. The v1.7.875
 *    sighting was noise and "Guard plays 135" is refuted. This holds regardless
 *    of which row each round actually selected, so DEFEND_HIT is not moving.
 *  - `$a0` appears only in Run-labelled rounds, twice, alongside the one `$b3`.
 *  - "Guard produces no sound of its own" was OVERSTATED. Chasing the Item row
 *    afterwards showed the battle command menu only accepts a direction press
 *    about HALF the time in this harness: row 1 spent ~100 down-presses and
 *    produced 48 cursor beeps, row 2 ~88 and produced 46. So an unknown share of
 *    "Guard" rounds were really Attack, and this data cannot support a claim
 *    about what Guard alone does. What it does support is the refutation above.
 *
 * So FF3's Guard row is silent, and our DEFEND_HIT is OUR cue for OUR defend
 * command (battle-turn.js, plus two PvP paths) — user-confirmed, and ff3mmo is
 * its own game. Its `$a0` measurement came from the Safe spell's impact, which
 * is a real capture of a different event; that is why it never contradicted this.
 *
 * GAP, stated rather than glossed: the Item row got 0 rounds (the battle ended
 * and no fresh one was reached) and Run only 11. Nothing here describes Item.
 */
export const BATTLE_ROW_SOUNDS = Object.freeze({
  Attack: 'no row-unique sound; party hits play $b6',
  Guard: 'no row-unique sound observed, but ~half of down-presses never landed, so not conclusive',
  Run: '$b3 escape success; $a0 seen twice alongside it',
  Item: 'reachable and selectable; CONFIRM x3 per use, ERROR only when nothing is usable',
});

/**
 * The battle command cursor — the state signal that unblocked all of this.
 * v1.7.879.
 *
 * It is OAM sprite tile 0x59 (top-left of a 2x2 blob), and its POSITION is the
 * menu's state:
 *
 *   x 40, y 168/184/200/216  -> COMMAND window, row Attack/Guard/Run/Item
 *   x 0,  y 168..216         -> the ITEM LIST, row index by the same spacing
 *   x ~24 or ~192            -> TARGET SELECT (parked on a monster or a member)
 *
 * Read it and navigation becomes verifiable per press. Four earlier attempts at
 * the Item row failed because direction presses were being swallowed during
 * target-select while the script counted them anyway. Two false trails first:
 * the cursor is NOT in the nametable (nothing there blinks or moves), and tile
 * 0xD5 in column 4 is NOT it either — that is the 'l' of the monster's name
 * "Gobl", and a loop keyed on it silently never advanced the menu at all.
 *
 * Using an item takes FOUR confirms, not three: open list, pick item, enter
 * target select, confirm. Stopping at three leaves the action unfinished and
 * every pick decays into the error buzz — indistinguishable from an empty bag,
 * which is exactly what two runs reported before the cursor trace showed it.
 */
export const BATTLE_MENU_CURSOR = Object.freeze({
  oamTile: 0x59,
  commandRows: { x: 40, y: [168, 184, 200, 216] },
  itemListRows: { x: 0, y: [168, 184, 200, 216] },
  confirmsPerItemUse: 4,
});

/**
 * The Item row, measured. v1.7.879.
 *
 * Sandbox battle (unkillable, harmless goblin), navigation verified against
 * BATTLE_MENU_CURSOR, and the bag stocked by re-asserting inventory EVERY FRAME
 * at $60C0/$60E0 — a poke made before the fight gets rewritten once combat
 * starts. Confirmed visually: the item list reads "Potion" instead of empty
 * slots. Two arms, 8-12 verified picks each:
 *
 *   value  nsf    STOCKED   EMPTY
 *   $85     70        24        2     confirm — exactly 3 per completed use
 *   $86     71         0       29     the error buzz
 *
 * So the Item row plays CONFIRM, and refuses with ERROR when there is nothing
 * usable. The stocked/empty contrast is strong and reproducible (0 errors vs
 * 29-53 across runs).
 *
 * NOT established, and deliberately not claimed: that item use plays no sound of
 * its own. None appeared even with the sampling window widened 3x to 420 frames
 * — but a Bomb Shard (0xb1, an offensive item) also produced no impact, so its
 * effect may not have resolved at all under a poked inventory. "No dedicated
 * item sound was observed" is what the data supports; "FF3 plays nothing for
 * item use" is not.
 *
 * A Potion is the wrong probe here for the same reason the pond was: a heal on a
 * full-HP party is refused, so 16 verified picks produced nothing but the error
 * buzz, identical to an empty bag.
 */



/**
 * MONSTER SPECIALS, swept. v1.7.885 — CORRECTS v1.7.884.
 *
 * 101 monsters carry a special-attack script. Each is swept by patching every
 * encounter to it, giving it 0x7FFF HP so the fight cannot end, and zeroing its
 * attack POWER but not its script, so it keeps acting while the party survives.
 *
 * ⚠ v1.7.884 reported "zero new sounds" across the first 60. THAT WAS WRONG.
 * I printed the sounds heard next to the known set and declared them matching by
 * EYE. $80 and $87 were sitting in that list and are not in the known set —
 * between `$86` and `$88` is exactly where a missing `$87` hides. Comparing the
 * two sets in code, which takes one line, finds three:
 *
 *   $80 -> nsf 65   the Balloon's EXPLOSION (self-destruct). Monster and attack
 *                   name both legible in the capture. 2 monsters: 0x3D, 0x37.
 *   $87 -> nsf 72   a monster attack cue shared by a contiguous family —
 *                   0x89, 0x8A, 0x8F, 0x91-0x94, 0xA9, 0xB6. Captured as three
 *                   Gaap attack; strip reads "1xHit" and their sprites garble
 *                   mid-animation. The attack is NOT named in the strip.
 *   $9e -> nsf 95   one monster only, 0xD2. Not investigated further.
 *
 * 83 of 101 swept. The 18 below are unswept — all high ids, i.e. late-game.
 * That is a coverage statement, not a result.
 *
 * The sweep is RESUMABLE (tools/monster-special-batch.mjs keeps per-monster
 * results on disk and picks up only ids not already done) because long runs in
 * this environment get restarted; a non-resumable driver lost everything each
 * time and three instances ended up racing one log file.
 */
export const MONSTER_SPECIAL_SWEEP = Object.freeze({
  withScripts: 101,
  swept: 83,
  newSounds: [
    { wrote: 0x80, nsf: 65, what: "the Balloon's Explosion", monsters: ['0x3D','0x37'] },
    { wrote: 0x87, nsf: 72, what: 'a shared monster attack cue (Gaap family), attack unnamed',
      monsters: ['0x89','0x8A','0x8F','0x91','0x92','0x93','0x94','0xA9','0xB6'] },
    { wrote: 0x9e, nsf: 95, what: 'one monster only, not investigated', monsters: ['0xD2'] },
  ],
  unswept: ["0xCB", "0xD3", "0xD4", "0xD5", "0xD6", "0xD7", "0xD8", "0xD9", "0xDA", "0xDB", "0xDD", "0xDE", "0xE0", "0xE1", "0xE3", "0xE4", "0xE5", "0xE6"],
});

/**
 * Battle attack sound BY WEAPON CLASS. v1.7.881.
 *
 * Found while trying to pin $8f: arming a character with a bow changed the
 * attack sound from the knife's $b6 to $8a. Weapon class selects it. So all 16
 * subtypes in data/items.js were swept — one representative each, equipped into
 * the character-B block ($6200 + i*0x40, weapon at +3, re-asserted every frame)
 * in the unkillable/harmless sandbox, ~10 attacks apiece.
 *
 * Six distinct sounds across sixteen classes. Most are the same `$b6` the
 * starting party's knives play, which is why nothing before this session ever
 * saw the others.
 *
 * Note $da/$db and $af/$bb: boomerang and shuriken each produce TWO values per
 * attack — a throw and a return/impact, presumably.
 */
/**
 * The 10 magic jobs, swept. v1.7.883. All 22 jobs now produce data.
 *
 * v1.7.882 left these wedging. The cause was in the driver, not the game: a
 * submenu parks the cursor at a DIFFERENT x (spell list x=16, item list x=0)
 * where the command-row reader returns -1, and the wait loop responded by
 * mashing A — confirming deeper into menus forever. Distinguishing "cursor
 * exists but is not at the command column" from "no cursor at all", and backing
 * out with B, fixes every one of them.
 *
 * RESULT: no magic job produces $8f, and none produces any unattributed value.
 * The Bard remains the only job that fires it.
 *
 * HONEST LIMIT on what this proves. The Magic row does open its spell list, but
 * the sweep never completes a CAST: the list opens on level-8 spells (Flare,
 * Death, Arise are legible in the capture) which a level-1 character cannot use,
 * so the selection errors out. What is covered is every job's non-magic rows
 * plus reaching the spell list. Casting itself is covered from another
 * direction entirely and does not need redoing here — all 56 spell impacts are
 * captured in spell-sfx-captured.js, and the pre-cast cue is the already
 * measured MAGIC_CAST ($a1 -> 0x62).
 *
 * One false alarm worth recording: the sweep flagged `$b3` as NEW for Conjurer,
 * Summoner and Devout. It is RUN_AWAY — their Flee row escaping — and was
 * missing from the driver's known-set. A bookkeeping bug in the harness, not a
 * discovery.
 */
export const JOB_SWEEP_UNCOVERED = Object.freeze([]);

export const WEAPON_ATTACK_SFX = Object.freeze({
  b6: { nsf: 119, classes: ['rod','nunchaku','staff','hammer','spear','knife','axe','sword','katana','book','bell'] },
  '8a': { nsf: 75, classes: ['claw','bow'] },
  '8b': { nsf: 76, classes: ['harp'] },
  bb_db: { nsf: [124, 156], classes: ['boomerang'] },
  af_da: { nsf: [112, 155], classes: ['shuriken'] },
});

/**
 * Sounds the game plays that no constant in music.js accounts for — now with
 * what each one IS. v1.7.880.
 *
 * These accumulated across the arc as "seen but unexplained". None is wired to
 * anything; the point of identifying them is that the next person to hear one in
 * a capture window knows whether it belongs there.
 *
 * Method is the same as everything else here: trigger it, resolve the write back
 * to its ROM site, and photograph the screen.
 */
export const IDENTIFIED_EXTRA_SFX = Object.freeze([
  {
    wrote: 0xbe, nsf: 127, what: 'the falling whoosh',
    how: 'Fires three times during the intro fall (frames 2766/2800/2834) while the '
       + 'screen is black and a single character tumbles through it. Runs ON TOP of '
       + 'song 48 — the fall has both a song and a repeating SFX, and SFX.FALL is '
       + 'only the song half.',
    site: 'dispatcher',
  },
  {
    wrote: 0xc0, nsf: 129, what: 'the screen-flash cue',
    how: 'Its own `LDA #$C0` site (0x760ba), 51 firings while walking one Altar Cave '
       + 'floor. The before/after shots show the SAME map drawn greyscale and then '
       + 'red, and the ROM three instructions earlier does `AND #$01 / ORA #$1E / '
       + 'STA $2001` — the PPU mask, i.e. greyscale and colour emphasis. The sound '
       + 'accompanies a full-screen colour flash.',
    site: '0x760ba',
  },
  {
    wrote: 0xc8, nsf: 137, what: 'a monster special attack',
    how: 'Caught mid-battle as a Flyer used "Glare" and a party member dropped to KO '
       + '— both the monster name and the attack name are legible in the message '
       + 'strip of the capture screenshot.',
    site: 'dispatcher',
  },
  {
    wrote: 0xd9, nsf: 154, what: 'an event-script cue, sibling to the earthquake',
    how: 'Own `LDA #$D9` site (0x775a9) sitting DIRECTLY after EARTHQUAKE\'s `LDA #$D8` '
       + '(0x775a1) in one jump-table handler block: each loads its sound and then '
       + 'branches to a different routine ($B913 vs $B938). Triggered by walking onto '
       + 'an event tile on map 125. Which scripted event it belongs to is NOT pinned.',
    site: '0x775a9',
  },
  {
    wrote: 0x8f, nsf: 80, what: "the Bard's SCARE command",
    how: 'Found by swapping the party JOB (byte 0 of $6100 + i*0x40) through all 22 and '
       + 'selecting every command row with the verified cursor. Only the Bard produces '
       + 'it. Its menu reads Sing / Scare / Cheer / Item, and the split is exact across '
       + '18 attempts per row: row 1 (SCARE) fired $8f 8 times and never $cb; row 2 '
       + '(CHEER) fired $cb 8 times and never $8f; Sing and Item fired neither. It is '
       + 'not the Bard\'s weapon either — a harp attack plays $8b. The party are Onion '
       + 'Knights, who have no Scare, which is why ~400k frames of play never heard it. '
       + 'The dedicated site 0x669af sits in bank 25 inside a routine at $A988 reached '
       + 'indirectly; forcing entry plays $8f and resolves a hit.',
    site: '0x669af ($A988)',
  },
  {
    wrote: 0xcb, nsf: 140, what: "the Bard's CHEER command",
    how: 'Same sweep as $8f, the adjacent row. 8 firings on row 2 across 18 attempts, '
       + 'never on any other row and never from any other job that produced data.',
    site: 'dispatcher',
  },
  {
    wrote: 0xc6, nsf: 135, what: 'the alternate physical-hit cue',
    how: 'Every firing (5, across 3 maps, always mid-battle) resolves to 0x668d7 — the '
       + 'SAME `STX $7F49` that produces ATTACK_HIT. The ROM there reads `LDX #$B0 / '
       + 'LDA $CB / BNE -> LDX #$C6` : one store, two values, chosen by whether '
       + 'zero-page $CB is set. So $c6 is not a separate sound so much as the other '
       + 'branch of the hit cue. WHAT $CB means is not pinned — the capture shows a '
       + 'fight against Flyers with the party slept and two members KO, which is '
       + 'suggestive of nothing on its own.',
    site: '0x668d7 (shared with ATTACK_HIT)',
  },
]);

/**
 * Empty: all six are identified, to varying strength — read the `how` field
 * before treating any of them as settled. $8f in particular is NOT pinned.
 */
export const UNACCOUNTED_SFX = [];
