// ═══════════════════════════════════════════════════════════════════════════
// ⛔⛔⛔  DO NOT HALF-ASS THE DATA PULL.  ⛔⛔⛔
//
// A ROM record has N FIELDS. If you use fewer than N, YOU HAVE NOT READ IT —
// you have guessed while holding the answer. This banner exists because that
// happened over and over in one day:
//
//   * FF3's NPC record is {id, x, y, FLAGS}. The flags byte was DISASSEMBLED
//     (bits 2-3 = FACING, bits 4-7 = MOVEMENT) and then DROPPED on the floor,
//     so ten Ur townsfolk shipped frozen in "random spots" facing wrong.
//   * Cid took THREE releases and Joel pointing at the tile — while
//     `npc-dump.mjs 12` had printed `id $2c @(6,23) ... DRAWN` the whole time.
//   * `$67` was called the "black magic sign" without checking its ATTRIBUTE
//     palette. It is the same star on pal1, the TREE/WOOD palette. Green
//     corners shipped.
//   * Characters were identified from `npcId + 0x202` instead of by RENDERING
//     THE SPRITE — which put Cid's line on the Castle Sasune gate guard.
//   * `check-shops` asked `findShopAtCounter` for the shop's OWN coords, so it
//     agreed with itself wherever the counter pointed.
//   * "0 of 28 bundles match" was a `+0x10` applied twice. SELF-TEST THE
//     INSTRUMENT BEFORE BELIEVING A NEGATIVE.
//
// BEFORE YOU SAY "DONE", ANSWER THIS OUT LOUD:
//   List every field/byte/column of the record you just read. Point at the line
//   of code that CONSUMES each one. If any field is unconsumed, you are NOT
//   done — wire it or say plainly which one you dropped and why.
//
// AND: RENDER IT AND LOOK. `map-png --grid --box`, `tileset-sheet.mjs`,
// `npc-sheet-ff3.mjs`, `npc-cast.cjs`. "The code looks right" is not a check.
// ═══════════════════════════════════════════════════════════════════════════
// Town NPC sprite specs — ROM walk bundles + capture palettes, same shape as
// data/opening-scene.js (16-tile / 256-byte bundle rendered by the Sprite
// class, all 4 directions, no fabricated frames). Offsets are relative to
// `romRaw` (header-inclusive). Located by byte-searching the captured OAM
// tiles against the AWJ-patched ROM (see tools/npc-sprite-tool.mjs).

import { DIR_DOWN, DIR_UP, DIR_LEFT, DIR_RIGHT } from '../sprite.js';

// Shared town-keeper palette (magenta hair / blue tunic). Every counter-bound
// keeper in Ur uses this same SP3/SP2 pair — the only thing that differs
// between item-shop / weapon-shop / inn / future shopkeepers is the ROM
// bundle offset. Extracted v1.7.694 — three specs used to repeat the same
// 4-byte tuples inline.
const TOWN_KEEPER_PAL_TOP = [0x1A, 0x0F, 0x15, 0x36]; // SP3 — head / hair
const TOWN_KEEPER_PAL_BTM = [0x1A, 0x0F, 0x12, 0x36]; // SP2 — body / tunic / dress

// Ur inn — item-shop keeper. Stands behind the item-shop counter (map 8,
// counter tile (8,15); keeper one tile north at (8,14), facing the player).
// Bundle 0x1E210 is the same walk-sprite shape as the opening right attendant
// but recolored by the town palette. Idle-march (walk-cycle in place) facing
// down — counter-bound, so it animates without wandering.
// ⛔ ignoreRomFlags — this NPC does NOT take facing/movement from the ROM
// record on its tile. Counter-bound keepers must face their CUSTOMER and must
// never wander off the counter; the villager whose tile they borrowed faces
// wherever the cartridge pointed them. Everyone without this marker gets the
// cartridge's own flags byte (see npc.js#romFlagsAt).
export const INN_ITEM_KEEPER = {
  ignoreRomFlags: true,
  romOffset: 0x01E210,
  palTop: TOWN_KEEPER_PAL_TOP,
  palBtm: TOWN_KEEPER_PAL_BTM,
  dir: DIR_DOWN,
  animate: true,
};

// Ur inn — the guest upstairs. ROM record id $15 @(4,3), the same id the item
// keeper wears, so the same bundle. Faces down, stands still.
// ⛔ ignoreRomFlags — this NPC does NOT take facing/movement from the ROM
// record on its tile. Counter-bound keepers must face their CUSTOMER and must
// never wander off the counter; the villager whose tile they borrowed faces
// wherever the cartridge pointed them. Everyone without this marker gets the
// cartridge's own flags byte (see npc.js#romFlagsAt).
export const INN_GUEST = {
  ignoreRomFlags: true,
  romOffset: 0x01E210,
  palTop: TOWN_KEEPER_PAL_TOP,
  palBtm: TOWN_KEEPER_PAL_BTM,
  dir: DIR_DOWN,
  animate: true,
  dialogue: [
    'A bed and no coin asked.',
    'I have stayed three nights.',
  ],
};

// Ur weapon shop — keeper. Stands at map 5 (3,14), behind the ur_weapon
// counter at (3,15). Bundle 0x1E610. Idle-march facing down — counter-bound.
// ⛔ ignoreRomFlags — this NPC does NOT take facing/movement from the ROM
// record on its tile. Counter-bound keepers must face their CUSTOMER and must
// never wander off the counter; the villager whose tile they borrowed faces
// wherever the cartridge pointed them. Everyone without this marker gets the
// cartridge's own flags byte (see npc.js#romFlagsAt).
export const WEAPON_KEEPER = {
  ignoreRomFlags: true,
  romOffset: 0x01E610,
  palTop: TOWN_KEEPER_PAL_TOP,
  palBtm: TOWN_KEEPER_PAL_BTM,
  dir: DIR_DOWN,
  animate: true,
};

// Ur inn — innkeeper (the woman). Stands at map 8 (3,14). Bundle 0x1E010 (same
// walk-sprite shape as the opening left attendant) recolored by the town
// palette. Idle-march facing down.
// ⛔ ignoreRomFlags — this NPC does NOT take facing/movement from the ROM
// record on its tile. Counter-bound keepers must face their CUSTOMER and must
// never wander off the counter; the villager whose tile they borrowed faces
// wherever the cartridge pointed them. Everyone without this marker gets the
// cartridge's own flags byte (see npc.js#romFlagsAt).
export const INN_KEEPER = {
  ignoreRomFlags: true,
  romOffset: 0x01E010,
  palTop: TOWN_KEEPER_PAL_TOP,
  palBtm: TOWN_KEEPER_PAL_BTM,
  dir: DIR_DOWN,
  animate: true,
  // Reachable NPC (no counter) — turns to face the player on talk. Hospitable
  // innkeeper; the beds here are free. Pages render via showMsgBoxPages. Keep
  // each page ≤2 wrapped lines: the box is HUD_VIEW_W=144 (maxChars 16) and
  // only 2 lines clear the border tiles — longer pages spill past the frame.
  dialogue: [
    'Welcome to our inn, traveler!',
    'The beds here are free.',
    'Rest as long as you like.',
    'A good sleep mends all.',
    'Sweet dreams, dear!',
  ],
};

// ── Ur townsfolk — the ROM's own roster ───────────────────────────────────
//
// FF3 stores a per-map NPC table (pointer table at $058010; {id,x,y,flags}
// entries terminated by id 0) that `map-loader.js#readNPCs` has always
// decoded — but only flame-sprites.js ever read it. The earlier Ur villagers
// were placed from OAM snaps instead, i.e. from whoever happened to be on
// screen, so FIVE of the ROM's TEN were simply missing.
//
//   node tools/npc-dump.mjs 114     — the roster below, straight from the ROM
//   node tools/npc-sheet.mjs 114 x.png — renders each gfx id so you can see them
//
// POSITIONS and COUNT come from the ROM. The SPRITES do not, and this is the
// important caveat: the roster's `gfx` byte is NOT an index into the sprite
// bundle table at 0x01C010. I shipped it as one in v1.7.968 and dressed all of
// Ur in PLAYER JOB SPRITES — bundles 0..23 of that table are the Onion Knight
// and the job classes, which is exactly what `0x01C010 + gfx*256` lands on for
// Ur's gfx ids $05-$0f. Render the range with `tools/npc-sheet.mjs` and it is
// obvious.
//
// The real townsfolk bundles live around 24..41 (0x01DF10, 0x01E010, 0x01E210,
// 0x01E310, 0x01E610 are the OAM-verified ones). The ROM must translate gfx id
// -> bundle through a lookup that is not decoded: the known pairs ($14->32,
// $15->34, $19->38) are not a constant offset, so guessing one would just be
// the same mistake again. Until that table is found, every NPC below uses a
// VERIFIED townsfolk bundle — reused across people, which the ROM itself does
// (the inn lists gfx $16 twice).
//
// Palettes are the map's OWN sprite palettes, split head/body the way FF3
// draws them: head tiles take SP3, body tiles SP2 — which is why Ur's
// townsfolk read as tan-faced in a blue tunic. I first gave each NPC ONE
// flag-derived palette and rendered a row of uniformly pink people, nothing
// like the game; `tools/npc-sheet.mjs` draws the split so it can be compared
// against a real capture of Ur. Each entry's flags byte does carry a palette
// selector — (flags >> 2) & 3, the field flame-sprites.js reads for torches —
// but what it varies on a PERSON is not decoded, so it is not used here.
const UR_SP2 = [0x1A, 0x0F, 0x12, 0x36];   // map 114 sprite palette 6 — blue body
const UR_SP3 = [0x1A, 0x0F, 0x26, 0x36];   // map 114 sprite palette 7 — skin / hair

// Ur's town NPC walk bundles — READ OUT OF THE PPU, not chosen by eye.
//
// `node tools/nes-run.mjs --warp 114 --chrmap --bundles` traces what the real
// game has loaded in sprite memory while standing in Ur and groups it into
// 16-tile walk bundles. Ur loads exactly these five (13-14 of 16 tiles each;
// the remainder are duplicate tiles that dedupe against other sprites):
//
//   0x01DF10  0x01E010  0x01E210  0x01E310  0x01E510
//
// Everything else is a different town's cast. v1.7.973 replaced the pool with
// ten bundles picked off a contact sheet because they "looked like villagers"
// — seven of those ten (24, 25, 26, 27, 33, 36, 39) are never loaded in Ur at
// all, which is why the town filled up with strangers.
//
// FIVE bundles for TEN people: the ROM reuses them, and so do we. The inn and
// item keepers draw from this same set — that is FF3's own doing, not a bug;
// Ur simply does not have ten unique character sprites in memory.
const NPC_BUNDLES = [
  0x01DF10,
  0x01E010,
  0x01E210,
  0x01E310,
  0x01E510,
];

// Kazus's town walk bundles — read out of the PPU exactly like Ur's, with
// `MAPS=10 node tools/monscan/map-bundles.cjs`. Map 10 loads FOUR; the ROM's
// own roster lists seven townsfolk for them, so the extras stay unplaced rather
// than shipping as twins.
//
// Bundle 0x01ED10 is deliberately NOT here — it is CID, a story character.
// See the note above the Kazus shop keepers.
const KAZUS_TOWN_BUNDLES = [
  0x01DF10,
  0x01E010,
  0x01E210,
];

// ⛔ NAMED STORY CHARACTERS. Never put one of these on an ordinary NPC.
//
// They are in the walk-bundle range and a map loads them like any other, so
// they look available on the sprite-catalog sheet. They are not. Twice now one
// has been placed as furniture: 0x01ED10 on all three Kazus shop keepers
// (v1.8.12) and then as an inn "ghost" (v1.8.13), and 0x01D910 as a Kazus
// townsman who wandered the streets as Cid (v1.8.17). check-npc-placement
// fails on any placed NPC using one.
//
// ⚠ 0x01ED10 IS MISLABELLED HERE — see docs/NPC-CATALOG.md. It is not Cid in
// any form; it is the GENERIC GHOST, worn by 10 different NPC ids across 22
// maps including every Kazus interior (inn, magic, weapon, armor). The ban is
// left in place because lifting it changes who stands in a live town, which is
// a content call — but it is a ban on the wrong grounds, and it currently stops
// Kazus's cursed interiors using the sprite the ROM itself puts there.
//
// ⚠ AND 0x01D910 IS NOT CID EITHER. Decoding the dialogue table settled it:
// the four NPC ids wearing that sprite are SARA (id 67, "I'm Sara! King
// Sasune's daughter"), DESCH (id 192), and two unnamed. One sprite cannot be
// both Sara and Desch, so it is a shared townsfolk sprite, not Cid's.
//
// Map 10 does load it for id 31 at (17,21) — that part was re-measured on
// hardware — but id 31 says "Can you play the piano?", and Cid's own lines
// belong to ids 48 and 51.
//
// BOTH entries below are therefore bans on the wrong grounds. They are kept
// because lifting them changes who stands in a live town, which is a content
// call, not a cataloguing one. See docs/NPC-CATALOG.md.
/**
 * Bundles ONE named npc key may wear, and nobody else.
 *
 * ⭐ 0x01ED10 is the Djinn's cursed-ghost sprite. It was banned outright, which
 * also locked out the one character it actually belongs to: Cid, who spends the
 * whole pre-quest game as a ghost in the Kazus inn. Reserving beats banning —
 * every other villager is still kept off it, by key rather than by hope.
 */
// Bundle -> the SET of npc keys allowed to wear it. Everyone else is refused by
// `check-npc-placement`.
//
// ⛔ IT WAS ONE KEY PER BUNDLE, AND THE ROM SAYS THAT WAS WRONG BOTH TIMES.
// Widened 2026-08-25, from the cartridge's own id->gfx table at ROM 0x1410:
//
//   0x01D910 is gfx 25, worn by ids 31, 67 (SARA), 192 (Desch) and 217. It is a
//   SHARED townsfolk sprite, which docs/NPC-CATALOG.md already flagged when it
//   said the "Cid" label on this bundle was wrong. Cid keeps it — Joel supplied
//   that art and it shape-matches at 90.2%, and that decision stands. Princess
//   Sara joins him because ID 67 IS HER: this is not a lookalike, it is the
//   sprite the cartridge dresses her in. They stand in different rooms (Cid in
//   the pub, map 12; Sara out in the town, map 10) and are never co-visible.
//
//   0x01ED10 is gfx 45, worn by TEN ids — the entire cursed cast of Kazus and
//   Castle Sasune. It is THE CURSE'S SPRITE, not one man's costume. The v1.10.66
//   ban ("dressing ordinary villagers as ghosts was not the world we ship")
//   rests on a premise the hardware contradicts: they are not ordinary villagers
//   wearing a ghost, they are the town's ENTIRE early-game population, and the
//   curse lifts. Measured with tools/monscan/npc-cast.cjs in both story states.
//
// ⛔ STILL RESERVED, NOT OPEN. Every key listed here is a character the story
// puts in that sprite on purpose. An ordinary villager must not drift onto
// either bundle by accident — that is what this table is for, and it is why the
// widening is a LIST of names rather than a deletion.
export const RESERVED_BUNDLES = new Map([
  [0x01D910, new Set(['cid', 'sara'])],
  [0x01ED10, new Set(['cid', 'sasune_king', 'sasune_attendant_w', 'sasune_attendant_e'])],
]);

export const STORY_SPRITE_BUNDLES = new Map([
  // ⭐ CID. Restored 2026-08-24: Joel supplied the sprite (red pointed cap,
  // red robe) and it shape-matches this bundle's DOWN frame at 90.2%, nine
  // points clear of the next candidate across all 88 bundles.
  //
  // It was de-labelled on the strength of `npcId + 0x202` naming its wearers
  // Sara and Desch. That rule is a DESCRIPTION of the string table with a
  // measured counterexample, not a derivation — the same rule puts Cid's
  // "I'm Cid from Canaan" line on the Castle Sasune gate guard. A picture beats
  // it. docs/NPC-CATALOG.md had it right the first time: "Kazus's real bundle
  // set includes 0x1D910 (Cid) ... The NPC wearing Cid is id 31 at (17,21)."
  [0x01D910, 'CID — his own sprite, id $1f at Kazus (17,21)'],
  [0x01ED10, 'generic ghost (was labelled "Cid (ghost form)" — wrong, see NPC-CATALOG.md)'],
]);

/**
 * One townsperson, for ANY town. `bundles` is that town's PPU-verified walk-
 * bundle set and `slot` indexes it.
 *
 * ⛔ Towns share this. Kazus shipped in v1.8.12 built on `interior()` instead —
 * the INDOOR helper, which does not set `wander` — so an entire town stood
 * still. A second hand-rolled path is how that happens; there is one path now.
 */
function townNpc(bundles, slot, extra = {}) {
  return {
    romOffset: bundles[slot % bundles.length],
    // Indicative only: npc-palette.js repaints every spec with the palette of
    // the map it is placed on (v1.8.10).
    palTop: UR_SP3,
    palBtm: UR_SP2,
    dir: DIR_DOWN,
    wander: true,
    // ⛔ ALWAYS animate. `addSceneNpc` resolves
    //   mode = wander ? 'pause' : (animate ? 'idle-march' : 'static')
    // so a spec that turns wandering OFF without turning animation ON is
    // FROZEN — a statue of a person, in a game where everyone else breathes.
    // That is a property of the helper's defaults, not something each caller
    // should have to remember: the campfire man shipped frozen in v1.8.17
    // because `wander: false` was passed and nothing set `animate`.
    // Ur's static quest giver had to say `animate: true` by hand for the same
    // reason; now he does not have to.
    animate: true,
    // Start on the declared tile and roam from there.
    fixedSpawn: true,
    leash: 3,
    ...extra,
  };
}

/** One Ur townsperson. `slot` picks a verified bundle, NOT the ROM gfx byte. */
// Townsfolk WANDER. v1.7.970 pinned them to their ROM tiles to spread them out
// and that killed the walking, which was never the ask — they should be spread
// AND moving. Back to `wander: true` (random spawn from the town's grass pool
// + a 3-tile leash), which is how they behaved before.
//
// The quest giver is the exception: he stays put so you can find him again.
// `fixedSpawn` keeps them on the ROM's own tile: without it the random grass
// pool bunched nearly all ten into the south plaza by the entrance.
const urNpc = (slot, extra = {}) => townNpc(NPC_BUNDLES, slot, extra);

/** One Kazus townsperson. Same helper, that town's bundles. */
const kazusNpc = (slot, extra = {}) => townNpc(KAZUS_TOWN_BUNDLES, slot, extra);

// Castle Sasune's courtyard (map 18) loads exactly TWO NPC walk bundles —
// `MAPS=18 node tools/monscan/map-bundles.cjs`. The ROM lists six people there
// (one id48, one id59 and FOUR identical id60 guards), the same over-listing
// Ur and Kazus have, so four of them cannot be drawn distinctly.
//
// ⛔ Do NOT compute a bundle from an NPC id. `0x1C010 + id*256` puts id60 at
// 0x1FC10, which renders BLANK on the catalog sheet — the same trap the Kazus
// campfire had. These two are what the PPU actually holds.
const SASUNE_BUNDLES = [
  0x01E010,
  0x01EE10,
];

/** One Castle Sasune courtyard NPC. */
const sasuneNpc = (slot, extra = {}) => townNpc(SASUNE_BUNDLES, slot, extra);

// The five below carry the dialogue that shipped with the old placements,
// re-attached to whichever ROM entry sits nearest the spot it used to stand
// on. The other five are SILENT on purpose: FF3's NPC text lives behind the
// event system, which is not decoded, and inventing lines for them would be
// making up content that is not in the game.
// QUEST GIVER — ROM (10,28), below the elder's house door at (9,26) and out in
// the open. He does NOT wander: a quest bubble that strolls off is one you have
// to go hunting for. Idle-march keeps him alive on the spot. The idle lines
// below only show if the quest is removed; while it exists quests.js supplies
// his pages for every stage.
export const UR_NPC_05 = urNpc(2, {
  romOffset: 0x01E210, wander: false, animate: true, dir: DIR_DOWN,
  // ⭐ The first variant is what `QUESTS.ur_missing_brother.after` used to be.
  // It moved here because a parting line is a fact about the world, not a
  // property of an errand — and as a quest layer it outranked this NPC's own
  // dialogue for the rest of the save, which is how two shipped lines elsewhere
  // became unreachable. `brother_avenged` is set by the quest's last stage.
  dialogue: [
    { when: 'brother_avenged', pages: [
      'The cave is quieter now.',
      'It will not bring him back.',
      'But it is quieter.',
    ] },
    { pages: [
      'You have the look',
      'of someone who asks.',
      'Ask, then.',
    ] },
  ],
  // He will not offer the job unasked — the quest opens when you bring him the
  // word BROTHER, which ur_npc_09 teaches. See QUESTS.ur_missing_brother.
  answers: {
    brother: [
      'He was mine.',
      'You know already.',
    ],
    cave: [
      'It runs under Ur.',
      'It has for years.',
    ],
  },
});
export const UR_NPC_06 = urNpc(1, {
  romOffset: 0x01E310, wander: false, animate: true,
  dialogue: [
    'The old well ran dry.',
    'Use the pond now.',
  ],
});
export const UR_NPC_07 = urNpc(2, {
  romOffset: 0x01DF10, wander: false, animate: true,
  dialogue: [
    'Knights rode past.',
    'None of them came back.',
  ],
});
export const UR_NPC_08 = urNpc(3, {
  romOffset: 0x01E310, wander: false, animate: true,
  dialogue: [
    'The shops are open by day.',
    'No Light Warrior in years.',
    "Sleep at the inn — it's free.",
  ],
});
export const UR_NPC_09 = urNpc(3, {
  romOffset: 0x01E210, wander: false, animate: true,
  dialogue: [
    'Mind the cave north.',
    'It took my brother.',
  ],
  teaches: ['cave', 'brother'],
  answers: {
    brother: [
      'Not mine. His.',
      'Ask the man by',
      'the elder\'s door.',
    ],
    cave: [
      'The mouth is north.',
      'Nothing comes back up.',
    ],
  },
});
export const UR_NPC_0A = urNpc(4, {
  romOffset: 0x01E510,
  dialogue: [
    'I keep the north field.',
    'Nothing grows in the dark.',
  ],
  answers: {
    cave: [
      'My field ends at it.',
      'I do not go closer.',
    ],
    vein: [
      'It ran under my rows.',
      'Then the soil turned.',
    ],
  },
});
export const UR_NPC_0C = urNpc(6, {
  romOffset: 0x01DF10, wander: false, animate: true,
  dialogue: [
    'Welcome to Ur, traveler.',
    'Folks here keep to',
    'themselves.',
  ],
  answers: {
    brother: [
      'Eight days he is gone.',
      'His kin waits below',
      'the elder\'s house.',
    ],
    riders: [
      'They passed at dawn.',
      'None came back through.',
    ],
  },
});
export const UR_NPC_0D = urNpc(0, {
  romOffset: 0x01DF10, wander: false, animate: true,
  dialogue: [
    'Ur is quiet most days.',
    'The cave drains the light.',
    'You give us hope.',
  ],
  teaches: ['cave'],
  answers: {
    cave: [
      'The light thins',
      'the nearer you get.',
    ],
  },
});
export const UR_NPC_0E = urNpc(8, {
  romOffset: 0x01E010,
  dialogue: [
    'You carry a blade.',
    'Then you go where we cannot.',
  ],
});
export const UR_NPC_0F = urNpc(9, {
  romOffset: 0x01DF10, wander: false, animate: true,
  dialogue: [
    'I study the crystal.',
    'The light wanes by the day.',
    'The cave sends dreams.',
  ],
});


// ── Ur interiors ─────────────────────────────────────────────────────────
//
// Each map gets bundles THAT MAP ACTUALLY LOADS, read out of the PPU with
// `node tools/nes-run.mjs --warp <id> --chrmap --bundles`. They are not the
// same set as the town's: an interior loads its own cast, and handing a room a
// bundle it never copies into sprite memory is how v1.7.973/974 put strangers
// in Ur. Verified sets:
//
//   map 9 tavern : 0x1DF10 0x1E010 0x1E110 0x1E610 0x1E710
//   map 8 inn    : 0x1E010 0x1E210
//   map 6 elder  : 0x1EC10
//   map 7 elder+ : 0x1E010 0x1E210 0x1EC10
//   map 2 house  : 0x1E210

// ⛔ These are the INN's pair, and they are a DEFAULT, not the truth. The line
// that used to sit here — "each map's own SP2/SP3 are the same values for Ur's
// buildings" — is false, and it is why the elder's house shipped wrong: the
// attendant is a white-robed figure with a tan face in the ROM and rendered in
// the inn's pink, and the elder's kin came out pink-haired instead of blonde.
// Measured from the ROM (tools/npc-palette-shot.mjs):
//
//   map 5 weapon  SP2 [0F,0F,12,36]  SP3 [0F,0F,15,36]   same as the inn
//   map 8 inn     SP2 [0F,0F,12,36]  SP3 [0F,0F,15,36]
//   map 9 tavern  SP2 [0F,0F,12,36]  SP3 [0F,0F,15,36]
//   map 4 armor   SP2 [0F,0F,12,36]  SP3 [0F,0F,26,36]   <- differs
//   map 6 elder-  SP2 [0F,0F,15,30]  SP3 [0F,0F,27,30]   <- differs, both
//   map 7 elder+  SP2 [0F,0F,12,36]  SP3 [0F,0F,27,30]   <- differs
//
// Whatever is written here is overwritten at placement time by the palettes of
// the map the NPC actually stands on (`data/npc-palette.js`), so a new interior
// does not need its own pair and CANNOT go wrong by reusing this one.
// check-npc-placement fails if that repaint is ever unwired. v1.8.10.
const INN_SP2 = [0x1A, 0x0F, 0x12, 0x36];  // body
const INN_SP3 = [0x1A, 0x0F, 0x15, 0x36];  // skin / hair

const interior = (romOffset, dir, dialogue, words) => ({
  romOffset, palTop: INN_SP3, palBtm: INN_SP2,
  dir, animate: true,        // indoors: hold the ROM tile, march in place
  dialogue,
  // Word Memory (optional 4th arg): { teaches: [...], answers: { term: [...] } }.
  ...(words || {}),
});

// Tavern — a keep behind the counter and four drinkers at the tables.
export const UR_TAVERN_KEEP = interior(0x01DF10, DIR_DOWN, [
  'Ale? Sit anywhere.',
  'No one hurries out.',
], {
  answers: {
    brother: [
      'He drank here.',
      'Then he went down.',
    ],
    vein: [
      'Ore paid for this bar.',
      'Not any more.',
    ],
  },
});
export const UR_TAVERN_DRINKER_A = interior(0x01E710, DIR_RIGHT, [
  'Drink up, friend.',
  'The dark keeps anyway.',
]);
export const UR_TAVERN_DRINKER_B = interior(0x01E010, DIR_LEFT, [
  'I hauled ore here.',
  'Then the vein went black.',
], {
  // ⛔ He does NOT volunteer VEIN. It is the one term in the game you have to
  // EARN with another term: bring him CAVE (free, from ur_npc_09 or ur_npc_0d)
  // and his answer hands VEIN over — the word is already sitting in the reply,
  // "The vein and the cave are the same dark." That is FF2's actual structure,
  // word -> person -> word, and before v1.8.8 the data shape could not express
  // it: every term was an independent pickup and the "chain" was a claim in a
  // comment. Moving `vein` out of `teaches` is what makes it a chain; putting
  // it back makes the term free again and `audit-words` fails.
  teaches: [],
  answers: {
    vein: [
      'Black to the rock.',
      'It started below.',
    ],
    cave: {
      pages: [
        'The vein and the cave',
        'are the same dark.',
      ],
      teaches: 'vein',
    },
  },
});
export const UR_TAVERN_DRINKER_C = interior(0x01E610, DIR_UP, [
  'The crystal picks four.',
  'Four! Look at us.',
]);
export const UR_TAVERN_DRINKER_D = interior(0x01E110, DIR_DOWN, [
  { when: 'road_cleared', pages: [
    'They will not ride back.',
    'But the road is ours.',
  ] },
  { pages: [
    'Sit a while, warrior.',
    "North road's cold.",
  ] },
], {
  answers: {
    riders: [
      'They took the north road.',
      'I poured for them.',
    ],
    cave: [
      'Cold comes off it.',
      'Even in here.',
    ],
  },
});

// Inn guests — map 8 only loads the two keeper bundles, so the guests share
// them. That is the ROM's own economy, not a shortcut.
export const UR_INN_GUEST_15  = interior(0x01E010, DIR_DOWN, [
  'The beds cost nothing.',
  'Sleep while you can.',
]);
export const UR_INN_GUEST_16A = interior(0x01E210, DIR_DOWN, [
  'I came in from the road.',
  'I am not going back out.',
]);
export const UR_INN_GUEST_16B = interior(0x01E210, DIR_LEFT, [
  'Quiet night. Too quiet.',
]);

// Elder's house.
export const UR_ELDER_ATTENDANT = interior(0x01EC10, DIR_DOWN, [
  'The elder is upstairs.',
  'He has not slept.',
], {
  answers: {
    cave: [
      'Say nothing of it',
      'in front of him.',
    ],
    brother: [
      'His kin still waits',
      'outside our door.',
    ],
  },
});
export const UR_ELDER_KIN_A = interior(0x01E010, DIR_RIGHT, [
  'Father watches the road',
  'for riders long gone.',
], {
  teaches: ['riders'],
  answers: {
    riders: [
      'Knights of the crown.',
      'They rode north once.',
    ],
  },
});
export const UR_ELDER_KIN_B = interior(0x01E210, DIR_LEFT, [
  'We kept the lamps lit',
  'for you.',
]);
export const UR_ELDER_KIN_C = interior(0x01EC10, DIR_DOWN, [
  'You came from the cave?',
  "Then it's all true.",
], {
  answers: {
    riders: [
      'Father counts the days',
      'since they rode.',
    ],
    cave: [
      'You were down there.',
      'I can see it on you.',
    ],
  },
});

// House (map 2).
export const UR_HOUSEHOLDER = interior(0x01E210, DIR_DOWN, [
  'Bar your door at night.',
  'Things walk the grass now.',
]);

// Map ID → keepers to place on that map. One render path: every entry goes
// through npc.js#placeTownNpcs → addSceneNpc → shared Sprite class.
// The keepers below are ORDINARY talkable NPCs — the shop opens from the
// counter TILE (`movement.js` counter lookup), not from them — so giving one
// `teaches` / `answers` works normally.
//
// ⛔ What does NOT work is an NPC that carries `shopId`: `npc.js#talkToNpc`
// calls openShop and returns before the verb menu is reached. Today that is
// only `addBlackMageShopkeeper`, which takes no spec at all (`npc.scene` stays
// null, so `_verbRows` returns nothing anyway) and `addSceneNpc` deliberately
// does not forward `spec.shopId`. Those two facts are what keep the mechanisms
// disjoint, and `tools/audit-words.mjs` gates both — if a spec ever gains a
// shopId, or addSceneNpc starts forwarding one, the word behaviour on that NPC
// dies silently and the gate fires instead.

// ── Kazus ────────────────────────────────────────────────────────────────
//
// Second town: map 10 (the game prints "Kazus" on entry), inn 12, shops
// 15 magic / 16 weapon / 17 armor. Measurements in docs/KAZUS.md.
//
// ⛔ EVERY SPRITE BELOW WAS LOOKED AT before it was placed —
// `node tools/npc-sprite-catalog.mjs` draws all 48 walk bundles with their
// offsets. v1.8.12 picked them off "which bundles does this map load", which
// says nothing about who they DEPICT, and gave all three shop keepers the
// GHOST. Loaded is not the same as suitable.
//
// The maps load very little, and that constrains the cast:
//   map 10  0x1D910 0x1DF10 0x1E010 0x1E210      four townsfolk
//   map 12  0x1DF10 0x1E010 0x1E410 + 0x1ED10    three guests + THE GHOST
//   map 15  0x1C410 + 0x1ED10                    one keeper + ghost
//   map 16  0x1DF10 + 0x1ED10                    one keeper + ghost
//   map 17  0x1DF10 + 0x1ED10                    one keeper + ghost
//
// So a non-ghost keeper on 16/17 can only be 0x1DF10, and on 15 only 0x1C410.
// That is not a preference, it is the whole set the map has in memory.
//
// ⚠ DIALOGUE IS FILLER. Ur, Kazus and Sasune get one dialogue + quest pass
// once all three are structurally complete. Kept short and inside the
// 16-char/2-line box so check-dialogue-fit stays honest meanwhile.

// Town (map 10) — WANDERING, through the shared townNpc helper, exactly as Ur.
// The man at the CAMPFIRE in the south-west corner. Not a fifth NPC: map 10
// loads only four walk bundles and the ROM draws this person on 0x01DF10 —
// slot 1, the one this spec already had — measured by reading OAM beside the
// fire (tiles trace to 0x1DF90/A0/B0/C0). So he sits where the ROM puts him,
// on the coordinate the ROM uses, rather than being invented next to it.
//
// `wander: false` — a man at a fire stays at his fire. It also keeps him off
// the >= 3-open-neighbour rule that wanderers need, and (3,28) is walled to the
// west. DIR_RIGHT faces the flame at (4,28).
export const KAZUS_TOWN_B = kazusNpc(0, {
  wander: false,          // `animate` comes from townNpc — he marches in place
  dir: DIR_RIGHT,
  dialogue: ['The mines gave out.', 'The fire still catches.'],
});
// ⛔ HE WALKS AGAIN. v1.10.65 froze him to satisfy the shared-bundle rule: he had
// been given 0x01DF10 to match the record at (15,20), which is the campfire
// man's bundle, and duplicates have to stand still. Freezing a walker to satisfy
// a sprite constraint is fixing the wrong end — map 10 also loads 0x01E210, whose
// ROM record is (18,27), so he moves there instead and gets both: the cartridge's
// own tile and sprite, AND his walk.
export const KAZUS_TOWN_C = kazusNpc(2, {
  dialogue: ['Mythril still comes up.', 'Little else does.'],
});
// Teaches AIRSHIP. The term must be a word he SAYS — that is what makes LEARN
// honest — and the carry is town -> inn, so the word has a walk in it.
export const KAZUS_TOWN_D = kazusNpc(1, {
  dialogue: ['A Canaan man came through.', 'Left an airship in the sand.'],
  teaches: ['airship'],
});

// Inn (map 12) — indoors, so `interior()`: no wandering, idle-march in place.
// ⛔ ignoreRomFlags — this NPC does NOT take facing/movement from the ROM
// record on its tile. Counter-bound keepers must face their CUSTOMER and must
// never wander off the counter; the villager whose tile they borrowed faces
// wherever the cartridge pointed them. Everyone without this marker gets the
// cartridge's own flags byte (see npc.js#romFlagsAt).
export const KAZUS_INN_KEEP = interior(0x01DF10, DIR_DOWN, [
  'Beds upstairs.',
  'Ale down here.',
], { ignoreRomFlags: true });
// ⭐ THE PUB'S ITEM KEEPER. He stands BEHIND the bar at (9,23) — ROM record
// $2e, whose own bundle this is — with the counter slab at (9,24) and the stool
// the player uses at (9,25). He shipped as `kazus_inn_guest_a`, an idle
// villager, so facing him across his own counter did nothing. `kazus_item` in
// `data/shops.js` is his counter; `movement.js#findShopAtCounter` opens it.
//
// ⛔ Counter-bound, so DIR_DOWN and no wandering, exactly like Ur's keepers.
// ⛔ ignoreRomFlags — this NPC does NOT take facing/movement from the ROM
// record on its tile. Counter-bound keepers must face their CUSTOMER and must
// never wander off the counter; the villager whose tile they borrowed faces
// wherever the cartridge pointed them. Everyone without this marker gets the
// cartridge's own flags byte (see npc.js#romFlagsAt).
export const KAZUS_ITEM_KEEPER = interior(0x01E010, DIR_DOWN, [
  'Mythril town, mythril prices.',
  'Potions and cures.',
], { ignoreRomFlags: true });
export const KAZUS_INN_GUEST_B = interior(0x01E410, DIR_LEFT, [
  'Sasune lies north.',
  'The castle still stands.',
]);

// ⛔ 0x01ED10 IS CID. Do not place him as an ordinary NPC.
//
// v1.8.13 put this bundle in the inn as a generic "ghost" with idle filler
// dialogue, and v1.8.12 had it on all three shop KEEPERS. It is a named story
// character: he belongs on the scene path (`data/opening-scene.js` +
// `npc.js#queueOpeningIntro`), which is how a scripted character with a scene
// and a role is placed, NOT in TOWN_NPCS, which is the table for townsfolk who
// stand around and repeat a line.
//
// Kept here as a NOTE rather than a spec so the next pass does not rediscover
// the bundle on the catalog sheet and reuse it. The Kazus quest that needs him
// comes with a scene, not with a wander spec.

// ── CID ──────────────────────────────────────────────────────────────────
//
// ⭐ THE GHOST BUNDLE IS CID'S, AND ONLY CID'S (v1.10.66). 0x01ED10 was banned
// outright — the Kazus cast that wears it in the ROM are the Djinn's cursed
// townsfolk, and dressing ordinary villagers as ghosts was not the world we
// ship. It is now RESERVED: Cid wears it before his quest is done, his own
// sprite after, and nobody else may take it. `check-npc-placement` enforces the
// reservation by npc key.
//
// He stands in the Kazus inn, which is where FF3 puts him — the ROM's own line
// for that record: "I'm Cid from Canaan. Been stuck here since Nelv Valley got
// blocked by that giant rock. I stayed in this hotel and then THIS happened."
//
// ⚠ DIALOGUE IS ROUGH on purpose. The whole NPC-dialogue + quest pass comes
// after the towns are shaped; these lines carry the beats, not the final voice.
// ⭐ CID, CURSED. Same man, same tile (6,23) — the Djinn's ghost form, which is
// the sprite record $2c actually wears. Swaps to CID once the quest is done.
// ⛔ ignoreRomFlags — this NPC does NOT take facing/movement from the ROM
// record on its tile. Counter-bound keepers must face their CUSTOMER and must
// never wander off the counter; the villager whose tile they borrowed faces
// wherever the cartridge pointed them. Everyone without this marker gets the
// cartridge's own flags byte (see npc.js#romFlagsAt).
export const CID_GHOST = interior(0x01ED10, DIR_DOWN, [
  'Cid, of Canaan.',
  'The curse caught me here.',
], {
  ignoreRomFlags: true,
  answers: {
    // The start word of `kazus_sealed_cave`. Without an entry the ASK list dims
    // it and the quest looks unaskable.
    djinn: [
      'North, past the water.',
      'It did this to me.',
      'It did this to all of us.',
    ],
    airship: [
      'She is west, in the sand.',
      'Clear the cave road first.',
      'I will not send you dead.',
    ],
  },
}, { ignoreRomFlags: true });

// ── CID — a SPECIAL CHARACTER, not a townsperson ─────────────────────────
//
// He stands in the KAZUS PUB DOORWAY: map 10, (17,21), tile $70 — a door. That
// is the cartridge's own record for him and it is where you find him.
//
// ⛔ HE STANDS AT (6,23) — the end of the pub's bar — IN TWO STATES.
//
// This tile was in `tools/npc-dump.mjs 12` the whole time, listed DRAWN on a
// fresh game, and it got walked past twice: v1.10.70 left Cid on the STREET
// outside (map 10, 18,22) and v1.10.71 put him on a BAR STOOL at (9,25).
// Record `$2c` @(6,23) is his.
//
// ⭐ KAZUS IS CURSED WHEN YOU FIND HIM, AND SO IS HE. That is why the old
// `cid_ghost` / `cid_man` pair existed — the two-state idea was right all along,
// it was just on the wrong tiles wearing the wrong faces. Before the Sealed
// Cave he is a GHOST (0x01ED10, which map 12 loads and which `$2c` itself
// wears); after it he is himself (0x01D910, the red cap Joel identified).
// Both states sit on (6,23); `when` puts exactly one of them in the room.
//
// ⛔ NEVER identify him from `npcId + 0x202` again. It put his "I'm Cid from
// Canaan" line on the Castle Sasune gate guard and named his own sprite
// "Sara"/"Desch". Sprite + ROM tile, nothing else.
//
// ⛔ HE DOES NOT WANDER. `npc.js#tryYieldToPlayer` returns false for `static`
// and `idle-march`, so a still NPC NEVER yields — keep him off doors and off
// any tile the player must walk through. (6,23) is open floor beside the bar.
// ⛔ ignoreRomFlags — this NPC does NOT take facing/movement from the ROM
// record on its tile. Counter-bound keepers must face their CUSTOMER and must
// never wander off the counter; the villager whose tile they borrowed faces
// wherever the cartridge pointed them. Everyone without this marker gets the
// cartridge's own flags byte (see npc.js#romFlagsAt).
export const CID = {
  ignoreRomFlags: true,
  romOffset: 0x01D910,   // ⭐ his own face — AFTER the curse lifts
  palTop: UR_SP3,
  palBtm: UR_SP2,
  dir: DIR_LEFT,
  wander: false,
  animate: true,
  fixedSpawn: true,
  // ⛔ THESE THREE LINES REPLACE AN UNREACHABLE PAGE SET. This spec is only
  // placed once `curse_lifted` holds, which only his own quest sets — and while
  // that quest was `done`, `after.cid` outranked idle dialogue forever, so
  // "That rock in Nelv keeps me here" could not be reached in any of the 384
  // world states. The `after` pages are the ones a player actually saw, so they
  // are the ones that survive.
  dialogue: [
    'Cid, of Canaan. Properly,',
    'this time.',
    'Fly her well.',
  ],
  answers: {
    djinn: [
      'Sealed, and good riddance.',
      'I owe you a face.',
    ],
    airship: [
      'She is mine, and west.',
      'Clear the road first.',
    ],
    cave: [
      'The seal broke.',
      'That is the whole of it.',
    ],
  },
};

// ⛔ AFTER the quest, and on a DIFFERENT tile. Cid has no unique sprite in FF3 —
// the ROM dresses him in gfx31 (0x01DF10), the generic villager, at Kazus
// (22,12). Map 12's own 0x01DF10 record is at (9,25), so that is where the man
// stands once the ghost is gone: the same bundle the inn keeper wears, which
// the shared-bundle rule allows because both are still and both are on ROM
// records that wear it.
export const CID_MAN = interior(0x01DF10, DIR_DOWN, [
  'Flesh again. Yours to thank.',
  'She is yours to fly.',
], {
  answers: {
    airship: [
      'Due west, in the sand.',
      'Walk up and she is yours.',
    ],
  },
});

// Shop keepers — one tile above their counter facing DOWN, as Ur's keepers
// stand.
//
// ⭐ THEY WEAR UR'S KEEPER SPRITE, 0x1E610 (v1.10.75). They used to wear
// 0x1DF10, the generic villager every other townsperson wears, so a Kazus shop
// looked like a house with a stranger in it while Ur's read as shops. The
// cartridge does dress them as villagers — record $28 wears 0x1DF10 — but
// ff3mmo's shops should read as shops, and Ur already set that pattern.
//
// ⛔ Maps 16/17 do not LOAD 0x1E610, and that is the same circular argument
// Cid's placement cost a release to: a map loads the bundles its own ROM
// records call for. ff3mmo draws bundles straight from ROM offsets with no
// CHR-RAM budget, so this is a deliberate, listed exception in
// `check-npc-placement`, not a licence to hand-add ordinary townsfolk.
// ⛔ ignoreRomFlags — this NPC does NOT take facing/movement from the ROM
// record on its tile. Counter-bound keepers must face their CUSTOMER and must
// never wander off the counter; the villager whose tile they borrowed faces
// wherever the cartridge pointed them. Everyone without this marker gets the
// cartridge's own flags byte (see npc.js#romFlagsAt).
export const KAZUS_WEAPON_KEEPER = interior(0x01E610, DIR_DOWN, [
  'Mythril holds an edge.',
  'It costs what it costs.',
], { ignoreRomFlags: true });
// ⛔ ignoreRomFlags — this NPC does NOT take facing/movement from the ROM
// record on its tile. Counter-bound keepers must face their CUSTOMER and must
// never wander off the counter; the villager whose tile they borrowed faces
// wherever the cartridge pointed them. Everyone without this marker gets the
// cartridge's own flags byte (see npc.js#romFlagsAt).
export const KAZUS_ARMOR_KEEPER = interior(0x01E610, DIR_DOWN, [
  'Mythril plate.',
  'Dear, but it turns a blade.',
], { ignoreRomFlags: true });

// Ur's secret house (map 2). ONE person, and the ROM's own tile.
//
// ⛔ THIS ROOM WAS DECLARED PERMANENTLY EMPTY ON A STALE MEASUREMENT. The note
// that stood here said the entrance walks the player to (8,21) into a room of
// rows 17-23, so none of map 2's five records could be reached. Both halves are
// wrong now: the tilemap decompressor fix (v1.10.9, "run length 0 means 256")
// moved the entrance to (8,29) and the room to rows 25-28, which CONTAINS the
// record at (6,26) — and of the five records, three are objects (gfx 65) and one
// is an invisible marker, so only ever ONE was a person.
//
// A room ruled out by a measurement gets re-measured when the measurement
// changes. `tools/npc-candidates.mjs` is what re-opened it.
export const UR_SECRET_RESIDENT = interior(0x01E210, DIR_DOWN, [
  'The back way is open.',
  'It was not always.',
]);

// Kazus houses (maps 13 and 14) — EMPTY until v1.10.64 while every other Kazus
// interior had somebody in it. Both were chosen with `tools/npc-candidates.mjs`,
// which answers all four placement constraints per ROM record at once: in the
// entrance room, talkable, wanderable, and on a bundle the map's PPU actually
// holds.
//
// ⛔ ONE BUNDLE EACH. `MAPS=13,14 node tools/monscan/map-bundles.cjs` — map 13
// loads only 0x1E010 and map 14 only 0x1E210 in the townsfolk range, so these
// rooms hold exactly one person. The ROM lists 3 and 5; the rest cannot be
// drawn distinctly.
export const KAZUS_HOUSE2_RESIDENT = interior(0x01E010, DIR_DOWN, [
  'The mines run under us.',
  'You hear them at night.',
]);
export const KAZUS_HOUSE3_RESIDENT = interior(0x01E210, DIR_DOWN, [
  'Rings were made here.',
  'Mythril takes the binding.',
]);
// ⛔ NO KAZUS_MAGIC_KEEPER SPEC. A magic shop's keeper is placed by
// `map-loading.js` via `addBlackMageShopkeeper(x, y, shopId)` — ON the counter
// tile, carrying the shopId that `talkToNpc` uses to open the menu. Ur's does
// exactly that (map-loading.js: `if (mapId === 3) addBlackMageShopkeeper(4, 4,
// 'ur_magic')`), and TOWN_NPCS for map 3 is empty.
//
// v1.8.12 put a plain TOWN_NPCS keeper at (4,3) instead: one tile behind the
// counter, with no shopId, so he stood in the wrong place AND the shop had no
// menu — he just said a line.


// ── Castle Sasune ────────────────────────────────────────────────────────
//
// Map 18, the courtyard — the game prints "Castle Sasune" on entry, which is
// how the map was confirmed. Map 29 is the "Sasune Throne Room" (its own
// banner) and is deliberately EMPTY here: the King and Princess Sara are story
// characters and belong on the scene path, not in this table. Its NPC entries
// even come in PAIRS on identical tiles (id55+id56 both at 10,6), which is a
// scripted character's two states, not two villagers.
//
// ⛔ NO SHOPS. Nothing in maps 18-30 carries a shop-marker id (227-244), which
// matches FF3: Sasune sells nothing. Do not add one.
//
// Guards stand their posts: `wander: false`. `animate` comes from townNpc, so
// they march in place rather than freezing.
//
// ⚠ DIALOGUE IS FILLER, like Ur's and Kazus's, pending the one dialogue+quest
// pass once all three locations are structurally complete.
// ⛔ THE BUNDLES WERE SWAPPED. Both stand on the ROM's own coordinates, but
// each wore the OTHER record's sprite: (15,20) is id48, who wears gfx46
// (0x01EE10), and (16,21) is id59 on gfx32 (0x01E010). Slot 0 is 0x01E010, so
// `sasuneNpc(0)` at (15,20) dressed the id48 post in the id59 sprite and vice
// versa. Nothing caught it because both bundles ARE loaded by map 18 — the
// bundle rule only asks whether the map holds it, not whether the person on
// that tile wears it.
// ⭐ HE TEACHES SARA, and the King does NOT. A giver who teaches their own start
// word is a chain with no walk in it (the note on ur_lost_riders). You hear the
// princess named at the gate, and carry it inside to her father.
export const SASUNE_GUARD_W = sasuneNpc(1, {
  wander: false,
  dir: DIR_RIGHT,
  // ⛔ EVERY VARIANT NAMES SARA. A teacher whose later lines drop the word
  // stops being a teacher halfway through the story, and the ASK list would
  // still offer LEARN on it. `check-words` fails the build on that.
  dialogue: [
    { when: 'curse_lifted', pages: [
      'The gate stays open.',
      'Sara is home. Ask her',
      'yourself.',
    ] },
    { pages: [
      'The gate stays open.',
      'Nobody comes anyway.',
      'Not since Sara went.',
    ] },
  ],
  teaches: ['sara'],
  answers: {
    sara: [
      { when: 'sara_found', pages: ['Back, and no thanks to us.'] },
      { pages: [
        'The princess. Gone,',
        'and the King past speaking',
        'sense about it.',
      ] },
    ],
  },
});
export const SASUNE_GUARD_E = sasuneNpc(0, {
  wander: false,
  dir: DIR_LEFT,
  dialogue: ['Kazus lies south.', 'Go carefully.'],
});

// ⭐ THE FOUR POSTED GUARDS. The ROM lists FOUR id60 records on map 18 — one
// bundle, four tiles, deliberately identical: (8,19) and (22,19) flanking the
// inner gate, (7,17) and (23,18) on the walls behind them. Castle Sasune is
// SUPPOSED to look garrisoned.
//
// They were unplaceable until v1.10.65 under a blanket "one person per sprite
// bundle" rule, which was written for Ur's WANDERERS — two identical faces
// strolling the same town reads as a bug, four still guards at four posts does
// not. `check-npc-placement` now allows a shared bundle only where every sharer
// stands still AND sits on a ROM record whose own id wears that bundle, which
// is exactly this case and nothing else.
//
// All four share one spec: identical people, identical line. Facing is the only
// thing that differs, and it comes from the placement below.
export const SASUNE_POST_GUARD = sasuneNpc(1, {
  wander: false,
  dialogue: ['The keep is watched.', 'Move along, traveler.'],
});

// The inner hall (map 25). The castle's interior maps 25/26/27 SHARE one NPC
// roster (npcIdx $11, six records) because they share a tilemap — and all six
// records sit in map 25's room, rows 23-28. That is why 26 and 27 stay empty:
// their own entrances open somewhere else on the same grid, so putting anybody
// there means inventing a coordinate the cartridge does not have.
//
// ⛔ FOUR OF THE SIX WEAR 0x01ED10 and are therefore not placeable — see the
// note above the shop keepers. The two that remain are id54 at (9,23) and
// (11,23) on 0x01EE10, one bundle, so this hall holds one person.
export const SASUNE_HALL_SERVANT = interior(0x01EE10, DIR_DOWN, [
  'The halls run long.',
  'Keep to the lit ones.',
]);

// ── CASTLE SASUNE: THE THRONE ROOM ───────────────────────────────────────
//
// ⛔ THE THRONE ROOM WAS EMPTY. `node tools/npc-dump.mjs 29` lists ELEVEN NPC
// records on map 29 and ff3mmo placed ZERO of them — there was no King in this
// game at all, in the room the whole Sasune chain starts from.
//
// ⭐ AND THE CARTRIDGE HAD ALREADY PAIRED THE CURSE. Map 29's records come in
// SAME-TILE PAIRS, one cursed and one not:
//
//     (10,6) the throne   $37 ghost / $38 living   living bundle 0x1EF10
//     (9,7)               $31 ghost / $32 living   living bundle 0x1EE10
//     (11,7)              $33 ghost / $34 living   living bundle 0x1EE10
//
// Every cursed id resolves through the id->gfx table at ROM 0x1410 to gfx 45 =
// 0x1ED10, the ghost. The two-state design was in the data the whole time.
//
// ⭐ THE KING IS $38, and his bundle 0x1EF10 is worn by NO OTHER RECORD IN THE
// GAME — one id, one room. He sits on the throne tile ($3e) at (10,6).
// ⛔ Identified by PLACEMENT AND SPRITE, never by `npcId + 0x202`, which is a
// description of the string table with a measured counterexample.
//
// Both states carry the SAME KEY. See the note on the TOWN_NPCS rows below —
// that is the whole fix for the class of bug that killed `kazus_cid_airship`.
const throneNpc = (romOffset, extra = {}) => ({
  romOffset,
  ignoreRomFlags: true,
  palTop: UR_SP3,
  palBtm: UR_SP2,
  dir: DIR_DOWN,
  wander: false,
  animate: true,
  fixedSpawn: true,
  ...extra,
});

/** King Sasune, cursed — a ghost on his own throne. Records $37 @(10,6). */
export const SASUNE_KING_CURSED = throneNpc(0x01ED10, {
  // ⭐ He hears about his daughter BEFORE the curse lifts — the two chains are
  // independent, so the cursed King needs both lines. As a quest `after` this
  // was one page set for every state at once.
  // ⛔ EVERY VARIANT MUST SAY THE WORD HE TEACHES. `check-words` enforces it,
  // and it caught this exact line: the first cut of the daughter variant read
  // "She is home and furious. / Let her be furious." — no DJINN in it, so the
  // ASK list would have offered LEARN on a term he never spoke.
  dialogue: [
    { when: 'daughter_home', pages: [
      'She is home and furious.',
      'The Djinn still has us.',
    ] },
    { pages: [
      'King Sasune. Or I was.',
      'The Djinn made ghosts',
      'of my whole house.',
    ] },
  ],
  teaches: ['djinn'],
  answers: {
    // ⛔ THE START WORD MUST BE ANSWERABLE. The ASK list greys out terms an NPC
    // has no entry for, so without this his own daughter's name reads as a dead
    // end right up until the player picks it anyway.
    sara: [
      'My daughter. Gone a week.',
      'She took the ring and',
      'told nobody.',
    ],
    djinn: [
      'It was sealed once.',
      'The quake let it out.',
      'Seal it and we are men again.',
    ],
    ring: [
      'Mythril, cut in Kazus.',
      'Made for my daughter.',
      'It is the only thing',
      'that binds him.',
    ],
  },
});

/** King Sasune, restored. Record $38 @(10,6) — bundle 0x1EF10, his alone. */
export const SASUNE_KING = throneNpc(0x01EF10, {
  dialogue: [
    { when: 'daughter_home', pages: [
      'The Djinn is sealed and',
      'she is home. Furious.',
      'Let her be furious.',
    ] },
    { pages: [
      'The Djinn is sealed.',
      'Flesh again, all of us.',
      'Sasune cannot repay this.',
    ] },
  ],
  teaches: ['djinn'],
  answers: {
    djinn: [
      'Sealed, and may it hold.',
      'My thanks are yours.',
    ],
    sara: [
      'She is home. She sulks',
      'that you did not need her.',
    ],
  },
});

/** The throne-room attendants, in both states. Records $31/$32 and $33/$34. */
export const SASUNE_ATTENDANT_CURSED = throneNpc(0x01ED10, {
  dialogue: ['We cannot even weep.', 'Ghosts have no water in them.'],
});
export const SASUNE_ATTENDANT = throneNpc(0x01EE10, {
  dialogue: ['I have my hands back.', 'I keep looking at them.'],
});

// ── CASTLE SASUNE: THE RUNNER ────────────────────────────────────────────
//
// ⭐ Script `0x238`: "I only escaped the curse because I was out running
// errands." The cartridge already has the one un-cursed servant in the castle,
// and he is the only person in Sasune who was OUTSIDE when the Djinn struck —
// which makes him the only one who could have seen the princess leave.
//
// He is not a new placement: `sasune_hall_servant` already stands on the ROM's
// own $36 record at map 25 (9,23), on 0x1EE10, which map 25 loads. This adds
// his words.
export const SASUNE_RUNNER_WORDS = {
  dialogue: [
    { when: 'sara_found', pages: [
      'Sara is back. I carried',
      'the news and dropped',
      'nothing this time.',
    ] },
    { pages: [
      'I was out when it came.',
      'Eggs. I was carrying eggs.',
      'I saw Sara go.',
    ] },
  ],
  teaches: ['sara'],
  answers: {
    sara: [
      { when: 'sara_found', pages: ['She came home on her own feet.', 'Mostly.'] },
      { pages: [
        'She went out the east gate.',
        'Asked me the road to Kazus.',
        'I was carrying eggs.',
        'I did not think to stop her.',
      ] },
    ],
    djinn: [
      'I was on the road when',
      'it came. That is all',
      'that saved me.',
    ],
    ring: [
      'She never took it off.',
      'Not since she was small.',
    ],
  },
};

// ── KAZUS: THE SMITH ─────────────────────────────────────────────────────
//
// ⭐ Script `0x231`: "The Mythril Ring can seal the Djinn. It's only made in
// this town. That's why the Djinn attacked us." And `0x22f`: "there was a
// Mythril Ring made for Princess Sara of Castle Sasune."
//
// ROM record $23 @(22,12) on map 10 — up by the mine mouth, native bundle
// 0x1DF10, which map 10 loads. Unplaced until now; one of the six Kazus town
// records ff3mmo was not using.
export const KAZUS_SMITH = kazusNpc(0, {
  romOffset: 0x01DF10, wander: false, animate: true, dir: DIR_DOWN,
  dialogue: [
    { when: 'curse_lifted', pages: [
      'The forge is lit again.',
      'That ring of hers held.',
    ] },
    { pages: [
      'I cut the ring here.',
      'Mythril. That is why',
      'it came for us.',
    ] },
  ],
  teaches: ['ring'],
  answers: {
    ring: [
      { when: 'sara_found', pages: ['You found her, then.', 'Good. It was my work.'] },
      { pages: [
        'I cut hers myself.',
        'She was back a week ago',
        'asking what crosses water.',
        'I had no answer for her.',
      ] },
    ],
    djinn: [
      'Mythril binds it.',
      'Nothing else we make does.',
    ],
    sara: [
      { when: 'sara_found', pages: ['She has more nerve', 'than her father.'] },
      { pages: ['The princess? Here.', 'She has not left.'] },
    ],
  },
});

// ── PRINCESS SARA ────────────────────────────────────────────────────────
//
// ⭐ HER OWN SPRITE. `gfxForNpcId(rom, 67)` -> gfx 25 -> bundle 0x1D910. The
// cartridge places her only on maps 33/34 (a late-game pair) and NEVER in
// Sasune or the Sealed Cave — in FF3 she is put on screen by event script, not
// by the static NPC table, so where she stands here is ff3mmo's call.
//
// ⛔ SHE IS NOT IN THE EAST TOWER, and that is a MEASUREMENT, not a preference.
// Script `0x243` says her room is at the top of the east tower, and map 174 is
// exactly that room — but `MAPS=174,19,30 node tools/monscan/map-bundles.cjs`
// (2026-08-25) shows it loads NINE player/battle bundles and NOT ONE townsfolk
// bundle. FF3 is CHR-RAM: anybody placed there renders as tilemap noise, the
// same as map 11.
//
// ⛔ SHE SHARES A SPRITE WITH OUR CID, and there is no third option. gfx 25 is
// worn by ids 31, 67 (Sara), 192 (Desch) and 217 — a shared townsfolk sprite,
// which `docs/NPC-CATALOG.md` already flagged when it said the "Cid" label on
// this bundle was wrong. Rendering every bundle the valley can draw
// (`tools/valley-cast-sheet.mjs`) shows the alternative is a generic blue-cap
// villager: dressing the princess as a townsman is worse than sharing a face
// with a man who stands in a different room. Cid is in the pub (map 12); she is
// out in the town (map 10). They are never on screen together.
//
// ⛔ NOT ON (17,21). That is the pub DOORWAY — one open neighbour, and the tile
// Cid's own ROM record sits on. Placing her there would block the entrance.
// (15,20) is the ROM's $21 record, out in the open west of the inn.
export const SARA = {
  romOffset: 0x01D910,
  ignoreRomFlags: true,
  palTop: UR_SP3,
  palBtm: UR_SP2,
  dir: DIR_DOWN,
  wander: false,
  animate: true,
  fixedSpawn: true,
  // ⛔ THE `sara_found` VARIANT IS GONE, and that is a measurement, not a trim.
  // `tools/audit-dialogue-reach.mjs` walked all 384 consistent world states and
  // it appeared in none: `sara_found` is set the moment the `found` stage
  // advances, and from that instant until the quest closes her `voice` entry
  // for the `return` stage outranks idle dialogue. It was three lines nobody
  // could ever read. Its beat — "not going home while that thing is down
  // there" — is carried by that voice line and by the `djinn_sealed` variant.
  dialogue: [
    { when: 'djinn_sealed', pages: [
      'The ring did its work.',
      'I felt it go.',
      'Take me home, would you.',
    ] },
    // Was `QUESTS.sasune_missing_daughter.after.sara`.
    { when: 'daughter_home', pages: [
      'You told him, then.',
      'I am still going back',
      'for that thing.',
    ] },
    { pages: [
      'Sara. Of Castle Sasune.',
      'The ring is why I am',
      'still standing here.',
    ] },
  ],
  teaches: ['ring'],
  answers: {
    ring: [
      'Mythril. It kept the curse',
      'off me and nothing else.',
      'It will bind the Djinn.',
    ],
    djinn: [
      'North, past the water.',
      'I got as far as the shore',
      'and no further.',
    ],
    sara: [
      'That is me. Yes.',
      'You may stop looking.',
    ],
  },
};

export const TOWN_NPCS = new Map([
  // --- Castle Sasune --- (two bundles; see the block above SASUNE_GUARD_W)
  [18, [
    // On the ENTRANCE PATH, at the ROM's own id48 / id59 coordinates. They were
    // first placed on the id60 guard posts at (8,19) and (22,19) — reachable,
    // but seven tiles either side of where the player walks in, so the castle
    // read as deserted through the 9-tile viewport. The ROM puts two people
    // right where you arrive; these are them.
    { key: 'sasune_guard_w', x: 15, y: 20, spec: SASUNE_GUARD_W },
    { key: 'sasune_guard_e', x: 16, y: 21, spec: SASUNE_GUARD_E },
    // The ROM's four id60 posts, verbatim. Inner pair faces the gate they
    // flank; the wall pair faces the courtyard.
    { key: 'sasune_post_w',  x:  8, y: 19, spec: { ...SASUNE_POST_GUARD, dir: DIR_RIGHT } },
    { key: 'sasune_post_e',  x: 22, y: 19, spec: { ...SASUNE_POST_GUARD, dir: DIR_LEFT } },
    { key: 'sasune_post_nw', x:  7, y: 17, spec: { ...SASUNE_POST_GUARD, dir: DIR_DOWN } },
    { key: 'sasune_post_ne', x: 23, y: 18, spec: { ...SASUNE_POST_GUARD, dir: DIR_DOWN } },
  ]],
  // --- Castle Sasune, THRONE ROOM (map 29) ---
  //
  // ⭐⭐ BOTH STATES CARRY THE SAME KEY, AND THAT IS THE POINT.
  //
  // `kazus_cid_airship` shipped DEAD because its two Cids had DIFFERENT keys
  // (`cid_ghost` / `cid`) while the quest named only one of them — so the giver
  // did not exist until the quest he gave was already finished. A person is not
  // two people because their face changed. The KEY is the identity; the spec is
  // the costume; `when` picks the costume. A quest stage binds to
  // `sasune_king` and finds him in either state.
  //
  // ROM records, all on their cartridge tiles (tools/npc-dump.mjs 29):
  //   (10,6) throne   $37 ghost / $38 King      (11,7)  $33 ghost / $34 living
  //   (9,7)           $31 ghost / $32 living
  [29, [
    { key: 'sasune_king', x: 10, y: 6, spec: SASUNE_KING_CURSED, when: (q, f) => !f('curse_lifted') },
    { key: 'sasune_king', x: 10, y: 6, spec: SASUNE_KING,        when: (q, f) =>  f('curse_lifted') },
    { key: 'sasune_attendant_w', x: 9, y: 7,
      spec: { ...SASUNE_ATTENDANT_CURSED, dir: DIR_RIGHT }, when: (q, f) => !f('curse_lifted') },
    { key: 'sasune_attendant_w', x: 9, y: 7,
      spec: { ...SASUNE_ATTENDANT, dir: DIR_RIGHT },        when: (q, f) =>  f('curse_lifted') },
    { key: 'sasune_attendant_e', x: 11, y: 7,
      spec: { ...SASUNE_ATTENDANT_CURSED, dir: DIR_LEFT },  when: (q, f) => !f('curse_lifted') },
    { key: 'sasune_attendant_e', x: 11, y: 7,
      spec: { ...SASUNE_ATTENDANT, dir: DIR_LEFT },         when: (q, f) =>  f('curse_lifted') },
  ]],

  // Inner hall — the ROM's own id54 coordinate, the only record in this room on
  // a bundle map 25 loads and is allowed to use.
  [25, [
    // ⭐ THE RUNNER — script 0x238, the one servant the curse missed because he
    // was outside on an errand. He is the only person in Sasune who could have
    // seen the princess go, which is why the King's chain passes through him.
    { key: 'sasune_hall_servant', x: 9, y: 23,
      spec: { ...SASUNE_HALL_SERVANT, ...SASUNE_RUNNER_WORDS, dir: DIR_RIGHT } },
    // Its PAIR. Both id54 records, both on 0x01EE10 — a matched pair flanking
    // the hall, same as the gate posts above.
    { key: 'sasune_hall_servant_e', x: 11, y: 23, spec: { ...SASUNE_HALL_SERVANT, dir: DIR_LEFT } },
  ]],

  // --- Kazus --- (bundle constraints in the block above KAZUS_TOWN_A)
  [10, [
    // ⛔ (17,21) is a DOORWAY — one open neighbour. A wanderer placed there can
    // never legally move (npc.js only steps onto tiles with >= 3 open
    // neighbours), so it stood in the inn's door permanently. Gated now by
    // check-npc-placement.
    { key: 'kazus_town_b', x: 3, y: 28, spec: KAZUS_TOWN_B },   // beside the campfire
    { key: 'kazus_town_c', x: 18, y: 27, spec: KAZUS_TOWN_C },
    { key: 'kazus_town_d', x: 14, y: 17, spec: KAZUS_TOWN_D },
    // ⭐ THE SMITH — ROM record $23 @(22,12), up by the mine mouth, on the
    // native 0x1DF10 map 10 already loads. Kazus cuts the mythril (script
    // 0x231), so the man who made Sara's ring is the lead that points north.
    { key: 'kazus_smith', x: 22, y: 12, spec: KAZUS_SMITH },
    // ⛔ PRINCESS SARA IS NOT IN KAZUS ANY MORE — see GENERATED_NPCS below. She stood on ROM record $21
    // @(15,20) because the quest's canoe used to be its final REWARD, so the
    // Sealed Cave was unreachable until after she was found and she could not be
    // put there. Joel, 2026-08-27: *"why is sara in kazus?!"* — the canoe moved
    // to the smith's stage instead, and she is where she said she was going.
    // Placed by `placeSaraInExitChamber` on the Cave of Seals' floor 1.
  ]],
  // Coordinates MEASURED from the map's largest connected room (63 tiles,
  // x2-6 / y16-20). Map 12's own ROM roster coords are sealed pockets —
  // check-npc-placement refused all three guests on them.
  [12, [
      // ⭐ ROM POSITION. Our tilemap decode dropped whole rows of fill until
      // v1.10.9 (run length 0 means 256), so these three sat in a room that
      // does not exist; `check-npc-placement` called them sealed in the moment
      // the decode was fixed. Coordinates are the cartridge's own NPC table
      // for map 12 — id40 @(14,25) beside the inn marker id250 @(14,26),
      // id39 @(5,27), id41 @(3,27).
    { key: 'kazus_inn_keep',    x: 14, y: 25, spec: KAZUS_INN_KEEP },
    // MOVED off the ghost records at (5,27)/(3,27) — those two tiles carry
    // 0x01ED10 records, which is Cid's sprite now. (9,23) is the ROM's 0x01E010
    // record and (9,26) its 0x01E410 one, so each guest wears what the
    // cartridge puts on the tile they stand on.
    { key: 'kazus_item_keeper', x: 9,  y: 23, spec: KAZUS_ITEM_KEEPER },
    { key: 'kazus_inn_guest_b', x: 9,  y: 26, spec: KAZUS_INN_GUEST_B },
    // ⭐ CID, in two states on two tiles. `when` is evaluated at placement time
    // (npc.js#placeTownNpcs) so exactly one of them is ever in the room.
    // ⭐ CID — record $2c @(6,23), the end of the bar. Cursed before the Sealed
    // Cave, himself after. `when` is evaluated at placement time so exactly one
    // of the two is ever in the room.
    // ⭐⭐ ONE KEY, TWO COSTUMES — and this is the bug fix, not a tidy-up.
    //
    // These rows used to be keyed `cid_ghost` and `cid`, and the quest named
    // `cid` as its giver. `cid`'s row is gated on that quest being DONE, so the
    // giver did not exist until the quest he gave was already finished: the
    // offer could never fire, on any save, and it shipped that way. A man is
    // not two people because the curse took his face. The key is the identity;
    // `when` picks the costume; the quest binds to `cid` and finds him either
    // way. `tools/check-quest-stages.mjs` is the gate that now catches this.
    //
    // ⛔ Gated on the FLAG, not on the quest id. The curse lifting is a fact
    // about the world that Kazus and Sasune both read; keying it to one quest's
    // name means renaming that quest silently un-curses two towns.
    { key: 'cid', x: 6, y: 23, spec: CID_GHOST, when: (q, f) => !f('curse_lifted') },
    { key: 'cid', x: 6, y: 23, spec: CID,       when: (q, f) =>  f('curse_lifted') },
    // ⛔ The two stand-ins that used to be here were never him. `cid_ghost` sat on
    // record $27 @(5,27) — "This cave is the Mythril Mines." — and `cid_man` on
    // $26 @(9,25) — "Kazus developed around the Mythril Mines." Neither is him.
    // Both were identified through `npcId + 0x202`, which is a description of
    // the string table, not a derivation. He is on map 10 (17,21) wearing his
    // own sprite; see the CID block above.
  ]],
  // ROM position: id40 @(3,22), behind the Kazus weapon marker id232 @(3,23)
  // which is where the counter goes. Was (3,14) — a room the broken tilemap
  // decode invented. Same story as map 5 below.
  [16, [{ key: 'kazus_weapon_keeper', x: 3, y: 22, spec: KAZUS_WEAPON_KEEPER }]],
  [17, [{ key: 'kazus_armor_keeper',  x: 3, y: 4,  spec: KAZUS_ARMOR_KEEPER }]],
  // ⛔ MAP 11 STAYS EMPTY, and that is a MEASUREMENT. `MAPS=11 node
  // tools/monscan/map-bundles.cjs` finds NO townsfolk walk bundle in sprite
  // memory at all — the map loads none. Anyone placed there draws as tilemap
  // noise, whichever bundle the spec names. Its two ROM records are in another
  // interior on the same shared tilemap. `check-npc-placement` pins map 11 to
  // an empty bundle set so a future pass cannot quietly add somebody.
  // ROM positions: map 13 id46 @(7,5), map 14 id47 @(7,7). Both are in the room
  // the door opens into and both are talkable from it.
  [13, [{ key: 'kazus_house2_resident', x: 7, y: 5, spec: KAZUS_HOUSE2_RESIDENT }]],
  [14, [{ key: 'kazus_house3_resident', x: 7, y: 7, spec: KAZUS_HOUSE3_RESIDENT }]],

  [8, [
    { key: 'inn_item_keeper', x: 8, y: 14, spec: INN_ITEM_KEEPER },
    { key: 'inn_keeper',      x: 3, y: 14, spec: INN_KEEPER },
    // ⭐ THE CONDITION THIS NOTE NAMED IS MET. It read: "if FF3's gfx-id ->
    // bundle mapping is ever decoded ... they can come back." npc-gfx.js
    // decoded it. Map 8's third person is id $15 at (4,3) — the SAME id, and
    // therefore the same bundle (0x1E210), as the item keeper at (8,14). The
    // ROM itself posts two identical people in this room, which is precisely
    // what the shared-bundle rule permits: both stand still, both on a ROM
    // record for that bundle.
    { key: 'inn_guest', x: 4, y: 3, spec: INN_GUEST },
  ]],
  // ROM position: id25 @(3,22), behind the Ur weapon marker id231 @(3,23).
  // Every shop that already worked follows this exact rule — our keeper sits
  // on the cartridge's non-marker NPC tile, the counter on the marker's.
  [5, [{ key: 'weapon_keeper',   x: 3, y: 22, spec: WEAPON_KEEPER }]],
  // Ur tavern — ROM roster (tools/npc-dump.mjs 9), bar room top-right.
  [9, [
    { key: 'ur_tavern_keep',      x: 23, y: 3, spec: UR_TAVERN_KEEP },
    { key: 'ur_tavern_drinker_a', x: 22, y: 7, spec: UR_TAVERN_DRINKER_A },
    { key: 'ur_tavern_drinker_b', x: 24, y: 7, spec: UR_TAVERN_DRINKER_B },
    { key: 'ur_tavern_drinker_c', x: 28, y: 8, spec: UR_TAVERN_DRINKER_C },
    { key: 'ur_tavern_drinker_d', x: 29, y: 5, spec: UR_TAVERN_DRINKER_D },
  ]],
  // Elder's house — ground floor (6) and upper floor (7).
  [6, [{ key: 'ur_elder_attendant', x: 11, y: 14, spec: UR_ELDER_ATTENDANT }]],
  [7, [
    { key: 'ur_elder_kin_a', x: 2, y: 4, spec: UR_ELDER_KIN_A },
    { key: 'ur_elder_kin_b', x: 6, y: 4, spec: UR_ELDER_KIN_B },
    { key: 'ur_elder_kin_c', x: 4, y: 3, spec: UR_ELDER_KIN_C },
  ]],
  // Ur's secret house — the ROM's (6,26), the room's only person. See the spec.
  [2, [{ key: 'ur_secret_resident', x: 6, y: 26, spec: UR_SECRET_RESIDENT }]],
  // Armor keeper reuses the weapon keeper's sprite (same bundle 0x1E610),
  // behind the ur_armor counter at (3,5).
  [4, [{ key: 'armor_keeper',    x: 3, y:  4, spec: WEAPON_KEEPER }]],
  // Ur town — FIVE of the ROM's ten, one per sprite bundle.
  //
  // Ur only ever has five NPC walk bundles in sprite memory (verified with
  // `nes-run.mjs --warp 114 --bundlecheck`), so placing all ten meant every
  // face appeared twice — the "double NPCs". One person per bundle removes the
  // twins and thins the crowd.
  //
  // The five kept are spread across the whole map (rows 10-28) and, apart from
  // the quest giver, none is adjacent to the elder's house door at (9,26).
  // DROPPED on purpose: (8,27) sat beside that door and its wander leash let it
  // step onto (9,27), the tile you exit onto — that is the one that felt like it
  // was blocking the path. Also dropped: (17,28), (28,28), (15,22), (21,17).
  [114, [
    // ⭐ ALL TEN, on the cartridge's own tiles, wearing the cartridge's own
    // sprites. Five of these were dropped in v1.7.973 for a reason the file
    // recorded honestly: FF3's gfx-id -> bundle table was not decoded, so a
    // sixth villager could only be given a bundle by eye, and Ur loads just
    // FIVE — every extra face came out a twin of somebody. `npc-gfx.js`
    // decoded that table (0x1410, 18/18 PPU-verified), so each person now
    // wears what the ROM puts on their tile and the guesswork is gone.
    //
    // Ur genuinely has 10 people on 5 bundles — the cartridge reuses them. The
    // shared-bundle rule in check-npc-placement allows that exactly when every
    // sharer STANDS STILL on a ROM record for that bundle, because the "double
    // NPC" report was about two identical faces WALKING. So the two sole
    // wearers of their bundle wander (id0A, id0E) and the other eight
    // idle-march in place. Nobody is frozen: `animate: true` throughout.
    //
    //   node tools/npc-dump.mjs 114     — the roster below, straight from the ROM
    { key: 'ur_npc_05', x: 10, y: 28, spec: UR_NPC_05 },   // quest giver, static
    { key: 'ur_npc_06', x: 17, y: 28, spec: UR_NPC_06 },
    { key: 'ur_npc_07', x:  8, y: 27, spec: UR_NPC_07 },
    { key: 'ur_npc_08', x: 28, y: 28, spec: UR_NPC_08 },
    // ⭐ BACK ON THE ROM'S TILE. He was moved to (21,16) in v1.8.14 because
    // (21,15) is a doorway and he WANDERED — npc.js only steps onto tiles with
    // >= 3 open neighbours, so he stood in that door unable to move. He no
    // longer wanders (he shares 0x1E210 with the quest giver), so the doorway
    // costs him nothing and he goes back where the cartridge puts him.
    { key: 'ur_npc_09', x: 21, y: 15, spec: UR_NPC_09 },
    { key: 'ur_npc_0a', x: 29, y: 10, spec: UR_NPC_0A },   // far north, wanders
    { key: 'ur_npc_0c', x: 16, y: 25, spec: UR_NPC_0C },
    { key: 'ur_npc_0d', x:  9, y: 21, spec: UR_NPC_0D },
    { key: 'ur_npc_0e', x: 15, y: 22, spec: UR_NPC_0E },   // wanders
    { key: 'ur_npc_0f', x: 21, y: 17, spec: UR_NPC_0F },
  ]],
]);


// ── NPCs ON GENERATED MAPS ────────────────────────────────────────────────
//
// `TOWN_NPCS` pairs a person with a TILE, which only works on a map that is the
// same every time. A dungeon floor is regenerated on every entry, so there is no
// tile to write down — the placer finds one at load time from something stable
// on the map (Sara: the `PASSAGE_ENTRY` that marks her chamber).
//
// ⛔ IT STILL HAS TO BE DECLARED SOMEWHERE THE GATES CAN READ. `check-quest-
// stages` asks "is the person you need in the room" by looking them up in
// `TOWN_NPCS`, and a person placed by a function in `npc.js` is invisible to it
// — the quest would read as unstartable while being perfectly fine, or, far
// worse, the reverse. This is that declaration: same shape, no coordinates.
export const GENERATED_NPCS = new Map([
  // The Cave of Seals, floor 1 — the exit chamber the boulder opens.
  [2001, [{ key: 'sara', spec: SARA, where: 'floor-1 exit chamber' }]],
]);
