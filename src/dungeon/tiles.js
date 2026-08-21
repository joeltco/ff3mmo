// Cave tileset (tileset 0) metatile ids — the ONE place these are written down.
//
// A leaf: imports nothing, so every generator module and every tool can read it
// without dragging in a browser or risking an import cycle.
//
// ⛔ It replaces two vocabularies for the same tiles. `dungeon-locked-room.js`
// carried its own block under the header "Cave tileset constants (mirrored from
// dungeon-generator.js)" with different names — CEILING_TILE / ROCK_TILE /
// FLOOR_TILE / VOID_TILE / CHEST_TILE / BONES_TILE. Mirrored constants are how a
// tile id gets corrected in one file and not the other.
//
// ⛔ WATER_EDGE WAS DEFINED TWICE, WITH DIFFERENT VALUES. `0x08` at module scope
// in dungeon-generator.js (read only by `placePond`), and `0x23` again inside
// floor 3's branch, which SHADOWED it for every line below. Both live in one
// file under one name. They are separate constants here, named for what they
// are, so the shadow cannot come back.

export const CEILING       = 0x00;
export const WALL_ROCKY    = 0x01;
export const ENTRANCE_TOP  = 0x03;  // arch above exit_prev
export const WATER         = 0x04;  // water body
export const WATER_EDGE_POND = 0x08; // edge detail used by `placePond`
export const BONES         = 0x09;  // skeleton/bone decoration, scattered on floor
export const WATER_EDGE_N  = 0x23;  // north-wall water detail — floor 3's pond
// ⛔ $0B / $0C are NOT skeletons — they render as teleport/warp sprites in
// tileset 0. Do not use them for decoration.
export const FLOOR         = 0x30;
export const WARP_A        = 0x3A;
export const WARP_B        = 0x3B;
export const WARP_C        = 0x3C;
export const WARP_D        = 0x3D;
export const PASSAGE       = 0x41;  // passable doorway/passage tile
export const STAIR_ARCH    = 0x42;  // decoration above stairs ($73)
export const FALSE_CEILING = 0x44;  // same visual as $00 but z=0, so passable
export const PASSAGE_BTM   = 0x49;  // passage bottom transition
export const FILL_VOID     = 0x5f;  // black void tile
export const EVENT_TILE    = 0x60;
export const EXIT_PREV     = 0x68;
export const PASSAGE_ENTRY = 0x6a;  // passage from above (exit_prev, deeper floors)
// Closed-door tile. The engine recognises it as a door through its
// collisionByte2 attribute (`(cb2[0x70] >> 4) & 0x0F === 5`) and runs the
// open-on-touch animation — swapping to $7E for the open state and restoring on
// move-off. The same id is the door in the shop tileset too: the engine's logic
// is collisionByte2-driven, not tile-id-driven. v1.7.654.
export const DOOR          = 0x70;
export const STAIRS_DOWN   = 0x73;
export const TRAP_HOLE     = 0x74;
export const CHEST         = 0x7C;

/**
 * Is this tile something the player stands on?
 *
 * Bones are decoration painted onto floor, so they count. Chests, stairs, doors
 * and passages do NOT — they are things you stand BESIDE or step through, and
 * every reachability question in the generator depends on that distinction.
 */
export function isFloorTile(t) { return t === FLOOR || t === BONES; }
