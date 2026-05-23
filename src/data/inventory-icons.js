// Inventory HUD icons — currently just the trash/delete sprite.
//
// `$E8` was captured from FF3 OAM @ f4318 in the item-discard menu (group
// 1, screen 8,41, SP3 pal `[0x0F, 0x00, 0x10, 0x30]`, VFLIP set). The OAM
// renders the tile vflipped, so we pre-bake the flipped variant here —
// no flip math at render time. v1.7.599.

import { _make8Canvas } from '../canvas-utils.js';

// Raw $E8 tile, already row-reversed within each plane so a straight
// `_make8Canvas` call renders the upright "trash can" silhouette.
// (Plane 0 bytes 0-7 reversed, plane 1 bytes 8-15 reversed.)
const TRASH_TILE = new Uint8Array([
  0x08, 0x1C, 0x3E, 0x7F, 0x0F, 0x0C, 0x0C, 0x00,
  0x00, 0x08, 0x1C, 0x3E, 0x78, 0x18, 0x18, 0x1C,
]);
const TRASH_PAL = [0x0F, 0x00, 0x10, 0x30];

let _trashCanvas = null;
export function getTrashCanvas() {
  if (!_trashCanvas) _trashCanvas = _make8Canvas(TRASH_TILE, TRASH_PAL);
  return _trashCanvas;
}
