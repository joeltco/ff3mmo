// Town NPC sprite specs — ROM walk bundles + capture palettes, same shape as
// data/opening-scene.js (16-tile / 256-byte bundle rendered by the Sprite
// class, all 4 directions, no fabricated frames). Offsets are relative to
// `romRaw` (header-inclusive). Located by byte-searching the captured OAM
// tiles against the AWJ-patched ROM (see tools/npc-sprite-tool.mjs).

import { DIR_DOWN, DIR_RIGHT } from '../sprite.js';

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
// screen, so FIVE of the ROM's TEN were missing and the five we did have used
// bundles (gfx 31/32/34/35) that appear nowhere in Ur's roster.
//
//   node tools/npc-dump.mjs 114     — the roster below, straight from the ROM
//   node tools/npc-sheet.mjs 114 x.png — renders each gfx id so you can see them
//
// Walk bundle = 0x01C010 + gfx*256, the same convention as MOOGLE_SPRITE_OFF
// in sprite-init.js.
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

/** One Ur townsperson, straight from a ROM roster row. */
function urNpc(gfx, extra = {}) {
  return {
    romOffset: 0x01C010 + gfx * 256,
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
export const UR_NPC_05 = urNpc(0x05, {
  // ROM (10,28) — exactly where the old quest NPC stood. Keeps its
  // idle-march-in-place behaviour rather than wandering.
  dir: DIR_RIGHT, wander: false, animate: true,
  dialogue: [
    'I have a task for the brave...',
    "...but not yet. Return soon.",
    'The crystal will guide you.',
  ],
});
export const UR_NPC_06 = urNpc(0x06);
export const UR_NPC_07 = urNpc(0x07);
export const UR_NPC_08 = urNpc(0x08, {
  dialogue: [
    'The shops are open by day.',
    "We've not seen a Light Warrior in years.",
    "Sleep at the inn — it's free.",
  ],
});
export const UR_NPC_09 = urNpc(0x09);
export const UR_NPC_0A = urNpc(0x0a);
export const UR_NPC_0C = urNpc(0x0c, {
  dialogue: [
    'Welcome to Ur, traveler.',
    'Folks here keep to themselves.',
    'The grass beyond hides things.',
  ],
});
export const UR_NPC_0D = urNpc(0x0d, {
  dialogue: [
    'Ur is quiet most days.',
    'The cave drains the light.',
    'Travelers like you give us hope.',
  ],
});
export const UR_NPC_0E = urNpc(0x0e);
export const UR_NPC_0F = urNpc(0x0f, {
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
const innGuest = (gfx) => ({
  romOffset: 0x01C010 + gfx * 256,
  palTop: INN_SP3, palBtm: INN_SP2,
  dir: DIR_DOWN,
  animate: true,        // indoors: stay on the ROM tile, march in place
});
export const UR_INN_GUEST_15 = innGuest(0x15);
export const UR_INN_GUEST_16A = innGuest(0x16);
export const UR_INN_GUEST_16B = innGuest(0x16);

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
