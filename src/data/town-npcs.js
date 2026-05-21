// Town NPC sprite specs — ROM walk bundles + capture palettes, same shape as
// data/opening-scene.js (16-tile / 256-byte bundle rendered by the Sprite
// class, all 4 directions, no fabricated frames). Offsets are relative to
// `romRaw` (header-inclusive). Located by byte-searching the captured OAM
// tiles against the AWJ-patched ROM (see tools/npc-sprite-tool.mjs).

import { DIR_DOWN } from '../sprite.js';

// Ur inn — item-shop keeper. Stands behind the item-shop counter (map 8,
// counter tile (8,15); keeper one tile north at (8,14), facing the player).
// Bundle 0x1E210 is the same walk-sprite shape as the opening right attendant
// but recolored by its own capture palette: magenta hair (SP3), blue tunic
// (SP2). Idle-march (walk-cycle in place) facing down — counter-bound, so it
// animates without wandering.
export const INN_ITEM_KEEPER = {
  romOffset: 0x01E210,
  palTop: [0x1A, 0x0F, 0x15, 0x36], // SP3 — head / hair
  palBtm: [0x1A, 0x0F, 0x12, 0x36], // SP2 — body / legs
  dir: DIR_DOWN,
  animate: true,
};

// Ur weapon shop — keeper. Stands at map 5 (3,14), behind the ur_weapon
// counter at (3,15). Bundle 0x1E610: magenta hair (SP3), blue overalls
// (SP2). Idle-march facing down — counter-bound.
export const WEAPON_KEEPER = {
  romOffset: 0x01E610,
  palTop: [0x1A, 0x0F, 0x15, 0x36], // SP3 — head / hair
  palBtm: [0x1A, 0x0F, 0x12, 0x36], // SP2 — body / overalls
  dir: DIR_DOWN,
  animate: true,
};

// Map ID → keepers to place on that map. One render path: every entry goes
// through npc.js#placeTownNpcs → addSceneNpc → shared Sprite class.
export const TOWN_NPCS = new Map([
  [8, [{ key: 'inn_item_keeper', x: 8, y: 14, spec: INN_ITEM_KEEPER }]],
  [5, [{ key: 'weapon_keeper',   x: 3, y: 14, spec: WEAPON_KEEPER }]],
  // Armor keeper reuses the weapon keeper's sprite (same bundle 0x1E610),
  // behind the ur_armor counter at (3,5).
  [4, [{ key: 'armor_keeper',    x: 3, y:  4, spec: WEAPON_KEEPER }]],
]);
