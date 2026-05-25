// Town NPC sprite specs — ROM walk bundles + capture palettes, same shape as
// data/opening-scene.js (16-tile / 256-byte bundle rendered by the Sprite
// class, all 4 directions, no fabricated frames). Offsets are relative to
// `romRaw` (header-inclusive). Located by byte-searching the captured OAM
// tiles against the AWJ-patched ROM (see tools/npc-sprite-tool.mjs).

import { DIR_DOWN } from '../sprite.js';

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

// ── Ur wandering townsfolk ────────────────────────────────────────────────
//
// Five wanderers populate map 114, mirroring the FF3 ROM's canonical Ur
// layout (captured via OAM snap — see CHANGELOG v1.7.694 / v1.7.695). Each
// uses a distinct ROM sprite bundle + SP3 hair color so they read as
// different people; all share the SP2 blue tunic body. `wander: true` + a
// 3-4 tile Chebyshev leash keeps each NPC in their plaza without migrating
// across the whole map. Talks face the player; v1.7.693 yield-to-player
// behavior is automatic.

// Shared SP3 hair palettes — one swap-color per slot, palette is otherwise
// the same as the shopkeepers' (only color 3 — the outfit / hair primary —
// differs).
const VILLAGER_HAIR_PEACH   = [0x1A, 0x0F, 0x26, 0x36];   // peach
const VILLAGER_HAIR_YELLOW  = [0x1A, 0x0F, 0x27, 0x30];   // yellow (scene-attendant tone)
const VILLAGER_HAIR_MAGENTA = TOWN_KEEPER_PAL_TOP;        // magenta (matches shopkeepers)

// South plaza, near (15, 25). Bundle 0x01DF10 is the "common villager" body
// — same sprite the FF3 ROM places twice in the Ur scene at canonical tiles
// (7,19) + (8,27); see the v1.7.694 OAM snap. Peach hair so they read as a
// distinct person at a glance from the magenta shopkeepers.
export const UR_VILLAGER_PEACH = {
  romOffset: 0x01DF10,
  palTop: VILLAGER_HAIR_PEACH,
  palBtm: TOWN_KEEPER_PAL_BTM,
  dir: DIR_DOWN,
  wander: true,
  leash: 4,
  dialogue: [
    'Welcome to Ur, traveler.',
    'Folks here keep to themselves.',
    'The grass beyond hides things.',
  ],
};

// South-west plaza, spawn (10, 27). Bundle 0x01E210 — same body as the
// item-shop keeper but the outdoor palette + wander mode reads as a
// completely different villager. Snap canonical was (10, 28); shifted one
// row north to land on an openArea tile.
export const UR_VILLAGER_TRADER = {
  romOffset: 0x01E210,
  palTop: VILLAGER_HAIR_PEACH,
  palBtm: TOWN_KEEPER_PAL_BTM,
  dir: DIR_DOWN,
  wander: true,
  leash: 3,
  dialogue: [
    'I trade messages for the elder.',
    'Folks come from far for the crystal.',
    'Mind the bees in the tall grass.',
  ],
};

// Northwest area, spawn (7, 19). Bundle 0x01E010 — same body as the
// opening-scene left attendant + the inn keeper, recolored yellow. Yellow
// hair distinguishes them from the south-plaza wanderers.
export const UR_VILLAGER_MAIDEN = {
  romOffset: 0x01E010,
  palTop: VILLAGER_HAIR_YELLOW,
  palBtm: TOWN_KEEPER_PAL_BTM,
  dir: DIR_DOWN,
  wander: true,
  leash: 3,
  dialogue: [
    'Ur is quiet most days.',
    'The cave drains the light.',
    'Travelers like you give us hope.',
  ],
};

// East plaza, spawn (16, 24). Bundle 0x01E310 is NEW — the taller hooded
// silhouette captured in the v1.7.694 OAM snap (group 2). Magenta hair
// keeps the visual link to the shopkeeper palette. This is the only NPC
// using this bundle so far — distinct silhouette helps it stand out as a
// "scholar / sage" rather than a generic villager.
export const UR_HOODED_SAGE = {
  romOffset: 0x01E310,
  palTop: VILLAGER_HAIR_MAGENTA,
  palBtm: TOWN_KEEPER_PAL_BTM,
  dir: DIR_DOWN,
  wander: true,
  leash: 3,
  dialogue: [
    "I study the crystal's silence.",
    'The light wanes by the day.',
    'Strange dreams come from the cave.',
  ],
};

// South-east plaza, spawn (11, 28). Same body as UR_VILLAGER_PEACH but
// magenta hair — so it reads as a different person despite sharing the
// bundle. Snap canonical was (8, 27); shifted because (8, 27) sits in a
// pinched area without enough open-area neighbors to wander from.
export const UR_VILLAGER_RED = {
  romOffset: 0x01DF10,
  palTop: VILLAGER_HAIR_MAGENTA,
  palBtm: TOWN_KEEPER_PAL_BTM,
  dir: DIR_DOWN,
  wander: true,
  leash: 3,
  dialogue: [
    'The shops are open by day.',
    "We've not seen a Light Warrior in years.",
    "Sleep at the inn — it's free.",
  ],
};

// Map ID → keepers to place on that map. One render path: every entry goes
// through npc.js#placeTownNpcs → addSceneNpc → shared Sprite class.
export const TOWN_NPCS = new Map([
  [8, [
    { key: 'inn_item_keeper', x: 8, y: 14, spec: INN_ITEM_KEEPER },
    { key: 'inn_keeper',      x: 3, y: 14, spec: INN_KEEPER },
  ]],
  [5, [{ key: 'weapon_keeper',   x: 3, y: 14, spec: WEAPON_KEEPER }]],
  // Armor keeper reuses the weapon keeper's sprite (same bundle 0x1E610),
  // behind the ur_armor counter at (3,5).
  [4, [{ key: 'armor_keeper',    x: 3, y:  4, spec: WEAPON_KEEPER }]],
  // Ur overworld (tileset 4) — five wandering villagers populate the south
  // plaza + northwest + east plaza, mirroring the FF3 ROM's canonical layout
  // (captured via OAM snap; see CHANGELOG). Each coord verified openArea
  // (walkable + ≥3 walkable neighbors) — canonical snap tiles (10,28) and
  // (8,27) shifted slightly to (10,27) / (11,28) so they pass the wander rule.
  // v1.7.694 (1 NPC) → v1.7.695 (5 NPCs).
  [114, [
    { key: 'ur_villager_peach',  x: 15, y: 25, spec: UR_VILLAGER_PEACH },
    { key: 'ur_villager_trader', x: 10, y: 27, spec: UR_VILLAGER_TRADER },
    { key: 'ur_villager_maiden', x:  7, y: 19, spec: UR_VILLAGER_MAIDEN },
    { key: 'ur_hooded_sage',     x: 16, y: 24, spec: UR_HOODED_SAGE },
    { key: 'ur_villager_red',    x: 11, y: 28, spec: UR_VILLAGER_RED },
  ]],
]);
