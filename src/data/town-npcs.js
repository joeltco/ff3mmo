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

// Verified townsfolk walk bundles (OAM-located, see tools/npc-sprite-tool.mjs).
const NPC_BUNDLES = [0x01DF10, 0x01E010, 0x01E210, 0x01E310, 0x01E610];

/** One Ur townsperson. `slot` picks a verified bundle, NOT the ROM gfx byte. */
// Townsfolk WANDER. v1.7.970 pinned them to their ROM tiles to spread them out
// and that killed the walking, which was never the ask — they should be spread
// AND moving. Back to `wander: true` (random spawn from the town's grass pool
// + a 3-tile leash), which is how they behaved before.
//
// The quest giver is the exception: he stays put so you can find him again.
function urNpc(slot, extra = {}) {
  return {
    romOffset: NPC_BUNDLES[slot % NPC_BUNDLES.length],
    palTop: UR_SP3,
    palBtm: UR_SP2,
    dir: DIR_DOWN,
    wander: true,
    leash: 3,
    ...extra,
  };
}

// The five below carry the dialogue that shipped with the old placements,
// re-attached to whichever ROM entry sits nearest the spot it used to stand
// on. The other five are SILENT on purpose: FF3's NPC text lives behind the
// event system, which is not decoded, and inventing lines for them would be
// making up content that is not in the game.
export const UR_NPC_05 = urNpc(0, {
  dialogue: [
    'I have a task for the brave...',
    "...but not yet. Return soon.",
    'The crystal will guide you.',
  ],
});
export const UR_NPC_06 = urNpc(1, {
  dialogue: [
    'The old well ran dry the night the light dimmed.',
    'Draw your water at the pond now.',
  ],
});
// QUEST GIVER — ROM (8,27), directly under the elder's house door at (9,26),
// the tile you walk past going in and out. He does NOT wander: a quest bubble
// that strolls off is a bubble you have to go hunting for. Idle-march keeps him
// alive on the spot. His idle lines below only show if the quest is ever
// removed; while it exists, quests.js supplies his pages for every stage.
export const UR_NPC_07 = urNpc(2, {
  wander: false, animate: true, dir: DIR_DOWN,
  dialogue: [
    "Sasune's knights rode past at dawn.",
    'None of them came back.',
  ],
});
export const UR_NPC_08 = urNpc(3, {
  dialogue: [
    'The shops are open by day.',
    "We've not seen a Light Warrior in years.",
    "Sleep at the inn — it's free.",
  ],
});
export const UR_NPC_09 = urNpc(4, {
  dialogue: [
    'Mind the cave to the north.',
    'Something down there took my brother.',
  ],
});
export const UR_NPC_0A = urNpc(5, {
  dialogue: [
    'I keep the north field.',
    'Nothing grows in the dark.',
  ],
});
export const UR_NPC_0C = urNpc(6, {
  dialogue: [
    'Welcome to Ur, traveler.',
    'Folks here keep to themselves.',
    'The grass beyond hides things.',
  ],
});
export const UR_NPC_0D = urNpc(7, {
  dialogue: [
    'Ur is quiet most days.',
    'The cave drains the light.',
    'Travelers like you give us hope.',
  ],
});
export const UR_NPC_0E = urNpc(8, {
  dialogue: [
    'You carry a blade.',
    'Then you go where we cannot.',
  ],
});
export const UR_NPC_0F = urNpc(9, {
  dialogue: [
    "I study the crystal's silence.",
    'The light wanes by the day.',
    'Strange dreams come from the cave.',
  ],
});

// ── Ur inn (map 8) upstairs + lobby guests ───────────────────────────────
// Three more people the ROM puts in the inn that we never placed. Same
// derivation; map 8's own sprite palettes.
const INN_SP2 = [0x1A, 0x0F, 0x12, 0x36];  // map 8 sprite palette 6 — body
const INN_SP3 = [0x1A, 0x0F, 0x15, 0x36];  // map 8 sprite palette 7 — skin / hair
const innGuest = (slot) => ({
  romOffset: NPC_BUNDLES[slot % NPC_BUNDLES.length],
  palTop: INN_SP3, palBtm: INN_SP2,
  dir: DIR_DOWN,
  animate: true,        // indoors: stay on the ROM tile, march in place
});
export const UR_INN_GUEST_15 = innGuest(0);
export const UR_INN_GUEST_16A = innGuest(2);
export const UR_INN_GUEST_16B = innGuest(3);


// ── Ur tavern (map 9, up the stairs from the inn) ─────────────────────────
// The ROM puts five people in the bar room at the top-right of map 9's shared
// tilemap: a keep behind the counter and four drinkers at the tables. Coords
// are the ROM's own (tools/npc-dump.mjs 9); each faces the counter or the
// table they are sat at, which is what "seated" looks like with walk sprites.
const tavern = (slot, dir, dialogue) => ({
  romOffset: NPC_BUNDLES[slot % NPC_BUNDLES.length],
  palTop: TAVERN_SP3, palBtm: TAVERN_SP2,
  dir, animate: true, dialogue,
});
const TAVERN_SP2 = [0x1A, 0x0F, 0x12, 0x36];
const TAVERN_SP3 = [0x1A, 0x0F, 0x15, 0x36];

export const UR_TAVERN_KEEP = tavern(4, DIR_DOWN, [
  'Ale? Sit anywhere you like.',
  'Nobody is in a hurry to leave lately.',
]);
export const UR_TAVERN_DRINKER_A = tavern(0, DIR_RIGHT, [
  'Drink up, friend.',
  'The dark keeps either way.',
]);
export const UR_TAVERN_DRINKER_B = tavern(2, DIR_LEFT, [
  'I hauled ore from the mines for years.',
  'Then the vein went black.',
]);
export const UR_TAVERN_DRINKER_C = tavern(3, DIR_UP, [
  'They say the crystal chooses four.',
  'Four! And look at the state of us.',
]);
export const UR_TAVERN_DRINKER_D = tavern(1, DIR_DOWN, [
  'Sit a while, warrior.',
  'The road north is colder than this floor.',
]);

// ── Ur elder's house (maps 6 ground / 7 upper) ───────────────────────────
const elder = (slot, dir, dialogue) => ({
  romOffset: NPC_BUNDLES[slot % NPC_BUNDLES.length],
  palTop: UR_SP3, palBtm: UR_SP2,
  dir, animate: true, dialogue,
});
export const UR_ELDER_ATTENDANT = elder(1, DIR_DOWN, [
  'The elder is upstairs.',
  'He has not slept since the tremor.',
]);
export const UR_ELDER_KIN_A = elder(2, DIR_RIGHT, [
  'Father watches the road',
  'for riders that never come.',
]);
export const UR_ELDER_KIN_B = elder(3, DIR_LEFT, [
  'We kept the lamps lit',
  'for you.',
]);
export const UR_ELDER_KIN_C = elder(0, DIR_DOWN, [
  'You came out of the cave?',
  'Then the old stories are true.',
]);

// ── Ur house (map 2) ─────────────────────────────────────────────────────
export const UR_HOUSEHOLDER = {
  romOffset: NPC_BUNDLES[2],
  palTop: UR_SP3, palBtm: UR_SP2,
  dir: DIR_DOWN, animate: true,
  dialogue: [
    'Bar your door at night.',
    'Things walk the grass that did not before.',
  ],
};

// Map ID → keepers to place on that map. One render path: every entry goes
// through npc.js#placeTownNpcs → addSceneNpc → shared Sprite class.
export const TOWN_NPCS = new Map([
  [8, [
    { key: 'inn_item_keeper', x: 8, y: 14, spec: INN_ITEM_KEEPER },
    { key: 'inn_keeper',      x: 3, y: 14, spec: INN_KEEPER },
    // ROM roster (tools/npc-dump.mjs 8): three guests we never placed.
    { key: 'ur_inn_guest_a',  x: 4, y:  3, spec: UR_INN_GUEST_15 },
    { key: 'ur_inn_guest_b',  x: 7, y:  2, spec: UR_INN_GUEST_16A },
    { key: 'ur_inn_guest_c',  x: 9, y:  2, spec: UR_INN_GUEST_16B },
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
  // Ur house (map 2).
  [2, [{ key: 'ur_householder', x: 6, y: 26, spec: UR_HOUSEHOLDER }]],
  // Armor keeper reuses the weapon keeper's sprite (same bundle 0x1E610),
  // behind the ur_armor counter at (3,5).
  [4, [{ key: 'armor_keeper',    x: 3, y:  4, spec: WEAPON_KEEPER }]],
  // Ur town — all TEN of the ROM's NPCs, at the ROM's own coordinates.
  // Wanderers still have their spawn randomised per map entry (v1.7.769), so
  // these coords are the fallback when the grass pool runs dry; the ROM entry
  // they came from is in the comment.
  [114, [
    { key: 'ur_npc_05', x: 10, y: 28, spec: UR_NPC_05 },
    { key: 'ur_npc_06', x: 17, y: 28, spec: UR_NPC_06 },
    { key: 'ur_npc_08', x: 28, y: 28, spec: UR_NPC_08 },
    { key: 'ur_npc_09', x: 21, y: 15, spec: UR_NPC_09 },
    { key: 'ur_npc_0a', x: 29, y: 10, spec: UR_NPC_0A },
    { key: 'ur_npc_0c', x: 16, y: 25, spec: UR_NPC_0C },
    { key: 'ur_npc_0d', x:  9, y: 21, spec: UR_NPC_0D },
    { key: 'ur_npc_0e', x: 15, y: 22, spec: UR_NPC_0E },
    { key: 'ur_npc_0f', x: 21, y: 17, spec: UR_NPC_0F },
    { key: 'ur_npc_07', x:  8, y: 27, spec: UR_NPC_07 },
  ]],
]);
