// HUD icons captured from FF3 ROM.
//
// $E8 — UP-ARROW indicator from the item-discard menu (group 1, OAM snap
// @ frame 4318, screen 8,41, SP3 pal, VFLIP set). Originally mistaken for
// the trash icon in v1.7.599; renamed in v1.7.602 after the BG snap
// showed the real trash is a 2x2 BG-tile cluster, not an OAM sprite.
//
// $58/$59/$5A/$5B — the actual trash can: a 2x2 BG-tile cluster from the
// same menu (BG snap @ frame 1905, cols 7-8 / rows 19-20, BG3 pal). Only
// color index 3 (white) is rendered; the BG-blue field (index 2) and
// inner black (indices 0/1) stay transparent so the icon sits cleanly on
// any HUD background. v1.7.602.

import { _make8Canvas, _makeCanvas16ctx } from '../canvas-utils.js';
import { decodeTile } from '../tile-decoder.js';

// ── Up-arrow ($E8, vflipped) ───────────────────────────────────────
// Bytes pre-row-reversed inside each plane so a straight `_make8Canvas`
// call renders the upright arrowhead (caller doesn't need to vflip).
const UP_ARROW_TILE = new Uint8Array([
  0x08, 0x1C, 0x3E, 0x7F, 0x0F, 0x0C, 0x0C, 0x00,
  0x00, 0x08, 0x1C, 0x3E, 0x78, 0x18, 0x18, 0x1C,
]);
const UP_ARROW_PAL = [0x0F, 0x00, 0x10, 0x30];

let _upArrowCanvas = null;
export function getUpArrowCanvas() {
  if (!_upArrowCanvas) _upArrowCanvas = _make8Canvas(UP_ARROW_TILE, UP_ARROW_PAL);
  return _upArrowCanvas;
}

// ── Trash can ($58/$59/$5A/$5B, 16×16 silhouette) ──────────────────
const TRASH_TILE_NW = new Uint8Array([0x00,0x01,0x01,0x1F,0x0F,0x0F,0x0F,0x0F,0xFF,0xFE,0xFF,0xE0,0xFF,0xFA,0xFA,0xFA]);
const TRASH_TILE_NE = new Uint8Array([0x00,0x00,0x00,0xF0,0xE0,0xE0,0xE0,0xE0,0xFF,0xFF,0x0F,0x07,0xEF,0xAF,0xAF,0xAF]);
const TRASH_TILE_SW = new Uint8Array([0x0F,0x0F,0x0F,0x0F,0x0F,0x0F,0x04,0x00,0xFA,0xFA,0xFA,0xFA,0xFA,0xFF,0xF0,0xFB]);
const TRASH_TILE_SE = new Uint8Array([0xE0,0xE0,0xE0,0xE0,0xE0,0xE0,0x40,0x00,0xAF,0xAF,0xAF,0xAF,0xAF,0xEF,0x1F,0xBF]);

// Custom 8x8 quadrant renderer — only color index 3 draws (white);
// every other index stays transparent. Bypasses `_make8Canvas`
// because that helper renders palette colors 1+2 opaquely, which
// would draw the FF3 menu's blue-field background.
function _drawTrashQuadrant(ctx, tile, ox, oy) {
  const px = decodeTile(tile);
  const img = ctx.createImageData(8, 8);
  for (let p = 0; p < 64; p++) {
    if (px[p] === 3) {
      img.data[p * 4] = 0xFF;
      img.data[p * 4 + 1] = 0xFF;
      img.data[p * 4 + 2] = 0xFF;
      img.data[p * 4 + 3] = 0xFF;
    }
  }
  ctx.putImageData(img, ox, oy);
}

let _trashCanvas = null;
export function getTrashCanvas() {
  if (_trashCanvas) return _trashCanvas;
  const [c, cx] = _makeCanvas16ctx();
  _drawTrashQuadrant(cx, TRASH_TILE_NW, 0, 0);
  _drawTrashQuadrant(cx, TRASH_TILE_NE, 8, 0);
  _drawTrashQuadrant(cx, TRASH_TILE_SW, 0, 8);
  _drawTrashQuadrant(cx, TRASH_TILE_SE, 8, 8);
  _trashCanvas = c;
  return _trashCanvas;
}
