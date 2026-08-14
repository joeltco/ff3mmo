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
export const INN_ITEM_KEEPER = {
  romOffset: 0x01E210,
  palTop: TOWN_KEEPER_PAL_TOP,
  palBtm: TOWN_KEEPER_PAL_BTM,
  dir: DIR_DOWN,
  animate: true,
};

// Ur weapon shop — keeper. Stands at map 5 (3,14), behind the ur_weapon
// counter at (3,15). Bundle 0x1E610. Idle-march facing down — counter-bound.
export const WEAPON_KEEPER = {
  romOffset: 0x01E610,
  palTop: TOWN_KEEPER_PAL_TOP,
  palBtm: TOWN_KEEPER_PAL_BTM,
  dir: DIR_DOWN,
  animate: true,
};

// Ur inn — innkeeper (the woman). Stands at map 8 (3,14). Bundle 0x1E010 (same
// walk-sprite shape as the opening left attendant) recolored by the town
// palette. Idle-march facing down.
export const INN_KEEPER = {
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
export const STORY_SPRITE_BUNDLES = new Map([
  [0x01D910, 'Cid'],
  [0x01ED10, 'Cid (ghost form)'],
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
export const UR_NPC_05 = urNpc(0, {
  wander: false, animate: true, dir: DIR_DOWN,
  dialogue: [
    'You have the look',
    'of someone who asks.',
    'Ask, then.',
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
  dialogue: [
    'The old well ran dry.',
    'Use the pond now.',
  ],
});
export const UR_NPC_07 = urNpc(2, {
  dialogue: [
    'Knights rode past.',
    'None of them came back.',
  ],
});
export const UR_NPC_08 = urNpc(3, {
  dialogue: [
    'The shops are open by day.',
    'No Light Warrior in years.',
    "Sleep at the inn — it's free.",
  ],
});
export const UR_NPC_09 = urNpc(4, {
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
export const UR_NPC_0A = urNpc(3, {
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
export const UR_NPC_0D = urNpc(7, {
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
  dialogue: [
    'You carry a blade.',
    'Then you go where we cannot.',
  ],
});
export const UR_NPC_0F = urNpc(9, {
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
export const UR_TAVERN_KEEP = interior(0x01E010, DIR_DOWN, [
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
export const UR_TAVERN_DRINKER_A = interior(0x01DF10, DIR_RIGHT, [
  'Drink up, friend.',
  'The dark keeps anyway.',
]);
export const UR_TAVERN_DRINKER_B = interior(0x01E110, DIR_LEFT, [
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
export const UR_TAVERN_DRINKER_D = interior(0x01E710, DIR_DOWN, [
  'Sit a while, warrior.',
  "North road's cold.",
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
export const KAZUS_TOWN_C = kazusNpc(1, { dialogue: ['Mythril still comes up.', 'Little else does.'] });
export const KAZUS_TOWN_D = kazusNpc(2, { dialogue: ['Travelers are rare here.', 'Rest before you go on.'] });

// Inn (map 12) — indoors, so `interior()`: no wandering, idle-march in place.
export const KAZUS_INN_KEEP = interior(0x01DF10, DIR_DOWN, [
  'Beds upstairs.',
  'Ale down here.',
]);
export const KAZUS_INN_GUEST_A = interior(0x01E010, DIR_DOWN, [
  'I came for the mythril.',
  'I am still waiting.',
]);
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

// Shop keepers — one tile above their counter facing DOWN, as Ur's keepers
// stand. Bundles are the only non-ghost ones their maps load.
export const KAZUS_WEAPON_KEEPER = interior(0x01DF10, DIR_DOWN, [
  'Mythril holds an edge.',
  'It costs what it costs.',
]);
export const KAZUS_ARMOR_KEEPER = interior(0x01DF10, DIR_DOWN, [
  'Mythril plate.',
  'Dear, but it turns a blade.',
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
export const SASUNE_GUARD_W = sasuneNpc(0, {
  wander: false,
  dir: DIR_RIGHT,
  dialogue: ['The gate stays open.', 'His Majesty wills it.'],
});
export const SASUNE_GUARD_E = sasuneNpc(1, {
  wander: false,
  dir: DIR_LEFT,
  dialogue: ['Kazus lies south.', 'Go carefully.'],
});

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
  ]],

  // --- Kazus --- (bundle constraints in the block above KAZUS_TOWN_A)
  [10, [
    // ⛔ (17,21) is a DOORWAY — one open neighbour. A wanderer placed there can
    // never legally move (npc.js only steps onto tiles with >= 3 open
    // neighbours), so it stood in the inn's door permanently. Gated now by
    // check-npc-placement.
    { key: 'kazus_town_b', x: 3, y: 28, spec: KAZUS_TOWN_B },   // beside the campfire
    { key: 'kazus_town_c', x: 15, y: 20, spec: KAZUS_TOWN_C },
    { key: 'kazus_town_d', x: 14, y: 17, spec: KAZUS_TOWN_D },
  ]],
  // Coordinates MEASURED from the map's largest connected room (63 tiles,
  // x2-6 / y16-20). Map 12's own ROM roster coords are sealed pockets —
  // check-npc-placement refused all three guests on them.
  [12, [
    { key: 'kazus_inn_keep',    x: 3, y: 17, spec: KAZUS_INN_KEEP },
    { key: 'kazus_inn_guest_a', x: 5, y: 17, spec: KAZUS_INN_GUEST_A },
    { key: 'kazus_inn_guest_b', x: 3, y: 19, spec: KAZUS_INN_GUEST_B },
  ]],
  [16, [{ key: 'kazus_weapon_keeper', x: 3, y: 14, spec: KAZUS_WEAPON_KEEPER }]],
  [17, [{ key: 'kazus_armor_keeper',  x: 3, y: 4,  spec: KAZUS_ARMOR_KEEPER }]],

  [8, [
    { key: 'inn_item_keeper', x: 8, y: 14, spec: INN_ITEM_KEEPER },
    { key: 'inn_keeper',      x: 3, y: 14, spec: INN_KEEPER },
    // The ROM lists three more people here, but map 8 only ever holds TWO NPC
    // walk bundles in sprite memory and both are taken by the keepers — so any
    // guest would render as a copy of one of them. Left out rather than shipped
    // as twins. If FF3's gfx-id -> bundle mapping is ever decoded, or the inn is
    // seen loading more bundles, they can come back.
  ]],
  [5, [{ key: 'weapon_keeper',   x: 3, y: 14, spec: WEAPON_KEEPER }]],
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
  // Ur northern house (map 2) — NOBODY. The ROM lists five NPCs for map 2, at
  // (4,24) (6,24) (8,24) (11,25) (6,26), and not one of them is in the room
  // this door opens into: the entrance walks the player to (8,21), whose room
  // is rows 17-23. Those five belong to another interior packed into the same
  // shared tilemap. `ur_householder` was placed on the ROM's (6,26) without
  // checking which room that is, so it stood outside the house the player was
  // standing in. Gated now by tools/check-npc-room.mjs.
  // Putting someone in the northern house means inventing a coordinate the ROM
  // does not have — ask first.
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
    { key: 'ur_npc_05', x: 10, y: 28, spec: UR_NPC_05 },   // quest giver, static
    { key: 'ur_npc_0a', x: 29, y: 10, spec: UR_NPC_0A },   // far north
    // ⛔ Was (21,15) — a DOORWAY, one open neighbour. He WANDERS, and npc.js only
    // steps onto tiles with >= 3, so he has been standing in that doorway since
    // he was placed, unable to move. Found by check-npc-placement's wander rule
    // (added v1.8.14 after the same bug shipped in Kazus). (21,16) is the
    // nearest open ground — one tile south, same spot for the player.
    { key: 'ur_npc_09', x: 21, y: 16, spec: UR_NPC_09 },   // north centre
    { key: 'ur_npc_0d', x:  9, y: 21, spec: UR_NPC_0D },   // west
    { key: 'ur_npc_0c', x: 16, y: 25, spec: UR_NPC_0C },   // south centre
  ]],
]);
