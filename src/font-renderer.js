// Font Renderer — draws text using NES font tiles extracted from ROM
//
// Font tiles: 160 tiles at ROM 0x1B610 (tile IDs $60-$FF)
// Letters/digits/punctuation live at $70-$FF (English IPS patch);
// item-type icon graphics live at $60-$6F (shield/armor/helm/sword/
// axe/spear/bow/rod/staff/etc.) and the magic-school icons at
// $72/$74/$75 share the same atlas.
// Each tile is 8x8 pixels, 2BPP NES format.
//
// Text bytes from the text decoder ARE tile IDs — they index directly
// into these font tiles. Color index 0 = transparent, 1-3 = text colors.

import { decodeTile, NES_SYSTEM_PALETTE } from './tile-decoder.js';
import { getItemName, getItemNameClean, getMonsterName, getSpellName,
         getJobName, getStringBytes } from './text-decoder.js';

// Font tile range — extended down to $60 in v1.7.245 to cover the
// item-type icon tiles (shield $60, body $61, helm $62, gauntlet $63,
// claw $64, book $65, rod $66, hammer $67, spear $68, knife $69,
// axe $6a, sword $6b, katana $6c, harp $6d, bow $6e, bell $6f).
const FONT_ROM_OFFSET = 0x1B610;  // ROM file offset (with iNES header)
const FONT_TILE_START = 0x60;
const FONT_TILE_COUNT = 160;      // $60-$FF

// Common text palettes (NES color indices)
// [transparent, color1, color2, color3]
export const TEXT_WHITE   = [0x0F, 0x0F, 0x0F, 0x30]; // white on black
export const TEXT_GREY    = [0x0F, 0x10, 0x00, 0x30]; // grey on black
export const TEXT_BLUE    = [0x0F, 0x12, 0x02, 0x30]; // blue on black
export const TEXT_RED     = [0x0F, 0x16, 0x06, 0x30]; // red on black
export const TEXT_GREEN   = [0x0F, 0x1A, 0x0A, 0x30]; // green on black
export const TEXT_YELLOW  = [0x0F, 0x28, 0x18, 0x30]; // yellow on black

let _fontPixels = null;  // Map<tileId, Uint8Array(64)>
let _tileCache = null;   // Map<paletteKey, Map<tileId, HTMLCanvasElement>>

// Arrow + claw + bracer/ring icon tiles — sourced from the A.W. Jackson
// FF3 fan translation, which splits glyphs the original JP ROM (and
// Chaos Rush) collapse into one. Arrows ($F3 in A.W.J.) share $6E with
// bows in Chaos Rush; claws ($E6) share $64 with nunchaku; bracers /
// rings ($E5) share $63 with gauntlets / gloves. Each tile lands at
// an unused icon slot in the Chaos Rush font atlas and the
// corresponding item IDs override their ROM icon byte in
// text-decoder.js (ARROW_ITEM_IDS / CLAW_ITEM_IDS / BRACER_ITEM_IDS).
const ARROW_TILE_ID = 0x77;
const ARROW_TILE_BYTES = new Uint8Array([
  0x00, 0x60, 0x60, 0x10, 0x08, 0x06, 0x05, 0x02,
  0xff, 0xff, 0xdf, 0x8f, 0xe7, 0xf3, 0xf7, 0xfa,
]);
const CLAW_TILE_ID = 0x76;
const CLAW_TILE_BYTES = new Uint8Array([
  0x08, 0x24, 0x12, 0x48, 0x23, 0x17, 0x0e, 0x00,
  0xff, 0xe7, 0xd3, 0xc9, 0xa2, 0xd4, 0xe0, 0xf1,
]);
const BRACER_TILE_ID = 0x78;
const BRACER_TILE_BYTES = new Uint8Array([
  0x00, 0x6c, 0x72, 0x22, 0x44, 0x48, 0x30, 0x00,
  0xff, 0xdd, 0x9c, 0xfc, 0xf9, 0xf3, 0x87, 0xcf,
]);

/**
 * Initialize font tiles from ROM data.
 * Call after IPS patch is applied.
 * @param {Uint8Array} romData — full ROM bytes (with iNES header)
 */
export function initFont(romData) {
  _fontPixels = new Map();
  _tileCache = new Map();

  for (let i = 0; i < FONT_TILE_COUNT; i++) {
    const tileId = FONT_TILE_START + i;
    const pixels = decodeTile(romData, FONT_ROM_OFFSET + i * 16);
    _fontPixels.set(tileId, pixels);
  }
  _fontPixels.set(ARROW_TILE_ID,  decodeTile(ARROW_TILE_BYTES,  0));
  _fontPixels.set(CLAW_TILE_ID,   decodeTile(CLAW_TILE_BYTES,   0));
  _fontPixels.set(BRACER_TILE_ID, decodeTile(BRACER_TILE_BYTES, 0));
}

/**
 * Get pre-rendered tile canvases for a palette.
 * Cached per palette — first call renders, subsequent calls return cache.
 */
function getCanvases(palette) {
  const key = palette.join(',');
  if (_tileCache.has(key)) return _tileCache.get(key);

  const canvases = new Map();
  for (const [tileId, pixels] of _fontPixels) {
    const c = document.createElement('canvas');
    c.width = 8; c.height = 8;
    const tctx = c.getContext('2d');
    const img = tctx.createImageData(8, 8);

    for (let i = 0; i < 64; i++) {
      const colorIdx = pixels[i];
      if (colorIdx === 0) {
        img.data[i * 4 + 3] = 0; // transparent
      } else {
        const nesIdx = palette[colorIdx];
        const rgb = NES_SYSTEM_PALETTE[nesIdx] || [0, 0, 0];
        img.data[i * 4]     = rgb[0];
        img.data[i * 4 + 1] = rgb[1];
        img.data[i * 4 + 2] = rgb[2];
        img.data[i * 4 + 3] = 255;
      }
    }
    tctx.putImageData(img, 0, 0);
    canvases.set(tileId, c);
  }

  _tileCache.set(key, canvases);
  return canvases;
}

/**
 * Draw text tile bytes to a canvas context.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x — pixel x position
 * @param {number} y — pixel y position
 * @param {Uint8Array} bytes — tile byte array from text decoder
 * @param {number[]} [palette=TEXT_WHITE] — 4 NES color indices
 * @returns {number} width drawn in pixels
 */
export function drawText(ctx, x, y, bytes, palette = TEXT_WHITE) {
  if (!_fontPixels) return 0;
  const canvases = getCanvases(palette);
  let cx = x;

  for (const b of bytes) {
    if (b === 0x00) break;
    if (b < 0x28) continue; // skip control codes
    const tc = canvases.get(b);
    if (tc) {
      ctx.drawImage(tc, cx, y);
    }
    cx += 8;
  }
  return cx - x;
}

/**
 * Measure text width in pixels (8px per visible character).
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function measureText(bytes) {
  let count = 0;
  for (const b of bytes) {
    if (b === 0x00) break;
    if (b < 0x28) continue;
    count++;
  }
  return count * 8;
}

// --- Convenience: draw names by ID ---

export function drawItemText(ctx, x, y, itemId, palette = TEXT_WHITE) {
  return drawText(ctx, x, y, getItemNameClean(itemId), palette);
}

export function drawMonsterText(ctx, x, y, monsterId, palette = TEXT_WHITE) {
  return drawText(ctx, x, y, getMonsterName(monsterId), palette);
}

export function drawSpellText(ctx, x, y, spellId, palette = TEXT_WHITE) {
  return drawText(ctx, x, y, getSpellName(spellId), palette);
}

export function drawJobText(ctx, x, y, jobId, palette = TEXT_WHITE) {
  return drawText(ctx, x, y, getJobName(jobId), palette);
}

export function drawStringById(ctx, x, y, stringId, palette = TEXT_WHITE) {
  return drawText(ctx, x, y, getStringBytes(stringId), palette);
}

// Returns Map<tileId, HTMLCanvasElement> for all loaded font tiles — used by tile viewer debug tool
export function getAllFontTiles(palette = TEXT_WHITE) {
  if (!_fontPixels) return new Map();
  return getCanvases(palette);
}
