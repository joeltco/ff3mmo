// vehicle-sprite.js — draw the craft the player is riding on the world map.
//
// The tiles cannot come from `Sprite.gfxBase` the way job sprites do: FF3 is
// CHR-RAM, so a vehicle's pattern data is decompressed into PPU memory at run
// time and has no fixed ROM offset. The bytes are captured instead
// (`src/data/vehicle-sprites-captured.js`, from tools/monscan/emit-vehicle-sprites.cjs)
// and composited here.
//
// Each mode's canvas is built once and cached — the layout never animates, and
// rebuilding per frame would decode tiles on every draw.

import { CAPTURED_VEHICLE_SPRITES } from './data/vehicle-sprites-captured.js';
import { NES_SYSTEM_PALETTE } from './tile-decoder.js';

const _cache = new Map();

/** Composite one mode's OAM layout into a canvas. Returns null if uncaptured. */
function buildCanvas(mode) {
  const v = CAPTURED_VEHICLE_SPRITES.get(mode | 0);
  if (!v) return null;
  const tiles = new Map(v.tiles);
  let w = 8, h = 8;
  for (const [, dx, dy] of v.layout) { w = Math.max(w, dx + 8); h = Math.max(h, dy + 8); }
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (const [tileId, dx, dy, hf, vf, palIdx] of v.layout) {
    const pat = tiles.get(tileId);
    if (!pat) continue;
    const base = (palIdx & 3) * 4;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const tx = hf ? 7 - x : x, ty = vf ? 7 - y : y;
        const lo = (pat[ty] >> (7 - tx)) & 1;
        const hi = (pat[ty + 8] >> (7 - tx)) & 1;
        const ci = lo | (hi << 1);
        if (!ci) continue;                       // colour 0 is transparent
        const rgb = NES_SYSTEM_PALETTE[v.pal[base + ci] & 0x3F] || [0, 0, 0];
        const px = dx + x, py = dy + y;
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        const o = (py * w + px) * 4;
        img.data[o] = rgb[0]; img.data[o + 1] = rgb[1]; img.data[o + 2] = rgb[2]; img.data[o + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function hasVehicleSprite(mode) {
  return CAPTURED_VEHICLE_SPRITES.has(mode | 0);
}

/**
 * Draw the craft centred on the same point the walk sprite uses, so boarding
 * does not visually shift the party.
 */
export function drawVehicle(ctx, x, y, mode) {
  const key = mode | 0;
  if (!_cache.has(key)) _cache.set(key, buildCanvas(key));
  const c = _cache.get(key);
  if (!c) return false;
  ctx.drawImage(c, x + (16 - c.width) / 2 | 0, y + (16 - c.height) / 2 | 0);
  return true;
}
