// weapon-sprites.js — blade, dagger, sword, and fist sprite canvases for battle

import { decodeTile } from './tile-decoder.js';
import { NES_SYSTEM_PALETTE } from './tile-decoder.js';

// ── Tile blit helpers (same as game.js _blitTile / _blitTileH) ──────────────

function _blitTile(ctx, px, palette, x, y) {
  const img = ctx.createImageData(8, 8);
  for (let p = 0; p < 64; p++) {
    const ci = px[p];
    if (ci === 0) { img.data[p * 4 + 3] = 0; }
    else {
      const rgb = NES_SYSTEM_PALETTE[palette[ci]] || [0, 0, 0];
      img.data[p * 4] = rgb[0]; img.data[p * 4 + 1] = rgb[1];
      img.data[p * 4 + 2] = rgb[2]; img.data[p * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, x, y);
}

function _blitTileH(ctx, px, palette, x, y) {
  const img = ctx.createImageData(8, 8);
  for (let p = 0; p < 64; p++) {
    const ci = px[p];
    if (ci === 0) continue;
    const rgb = NES_SYSTEM_PALETTE[palette[ci]] || [0, 0, 0];
    const di = (Math.floor(p / 8) * 8 + (7 - p % 8)) * 4;
    img.data[di] = rgb[0]; img.data[di + 1] = rgb[1];
    img.data[di + 2] = rgb[2]; img.data[di + 3] = 255;
  }
  ctx.putImageData(img, x, y);
}

// ── Tile data ────────────────────────────────────────────────────────────────

const BLADE_TILES = [
  new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x80]),
  new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x01, 0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x01]),
  new Uint8Array([0x00,0x80,0x40,0x21,0x11,0x08,0x07,0x1B, 0xC0,0xE0,0x70,0x38,0x1C,0x0E,0x04,0x00]),
  new Uint8Array([0x01,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x01,0x00,0x00,0x00,0x00,0x00,0x00,0x00]),
];

const SWORD_TILES = [
  new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x80,0xC0, 0x00,0x00,0x00,0x00,0x00,0x00,0x80,0xC0]),
  new Uint8Array([0x00,0x70,0x78,0x7C,0x3E,0x1F,0x0D,0x06, 0x00,0x70,0x78,0x7C,0x3E,0x1F,0x0F,0x07]),
  new Uint8Array([0x60,0xB0,0xD9,0x6D,0x33,0x12,0x0D,0x3B, 0xE0,0xF0,0xF8,0x7C,0x3C,0x1C,0x02,0x00]),
  new Uint8Array([0x03,0x01,0x00,0x00,0x00,0x00,0x00,0x00, 0x03,0x01,0x00,0x00,0x00,0x00,0x00,0x00]),
];

const FIST_TILE = new Uint8Array([0x00,0x00,0x00,0x0C,0x2C,0x4C,0x00,0x00,
                                   0x00,0x00,0x00,0x73,0x53,0x23,0x00,0x00]);

// PPU $1000 capture — Monk wind-up with Nunchuck equipped (SP3 palette, tiles $49/$4A/$4B/$4C).
// Only $49 and $4C carry the diagonal chain pixels; the other two are blank padding.
const NUNCHAKU_TILES = [
  new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00]), // $4A
  new Uint8Array([0x00,0xC0,0x60,0x30,0x18,0x0C,0x06,0x01,0x40,0x60,0x30,0x18,0x0C,0x06,0x02,0x00]), // $49
  new Uint8Array([0x80,0x40,0x60,0x30,0x18,0x0C,0x06,0x02,0x00,0x60,0x30,0x18,0x0C,0x06,0x03,0x00]), // $4C
  new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00]), // $4B
];

// ── Canvas storage ───────────────────────────────────────────────────────────

let knifeRaised = null, knifeSwung = null;
let daggerRaised = null, daggerSwung = null;
let swordRaised = null, swordSwung = null;
let nunchakuRaised = null, nunchakuSwung = null;
let fistCanvas = null;
const _fistCache = new Map(); // palette-key → fist canvas (per-character palette)

// ── Build helpers ────────────────────────────────────────────────────────────

function _buildBladeCanvas(tileDefs, pal, pos, swungOrder) {
  const raised = document.createElement('canvas'); raised.width = 16; raised.height = 16;
  const rctx = raised.getContext('2d');
  for (let t = 0; t < 4; t++) _blitTileH(rctx, decodeTile(tileDefs[t], 0), pal, pos[t][0], pos[t][1]);
  const swung = document.createElement('canvas'); swung.width = 16; swung.height = 16;
  const sctx = swung.getContext('2d');
  for (let t = 0; t < 4; t++) _blitTile(sctx, decodeTile(tileDefs[swungOrder[t]], 0), pal, pos[t][0], pos[t][1]);
  return { raised, swung };
}

// ── Public API ───────────────────────────────────────────────────────────────

export function initWeaponSprites(palette) {
  const pos = [[0,0],[8,0],[0,8],[8,8]];
  const so  = [1, 0, 3, 2];
  let b;
  b = _buildBladeCanvas(BLADE_TILES, [0x0F,0x00,0x32,0x30], pos, so);
  knifeRaised = b.raised; knifeSwung = b.swung;
  b = _buildBladeCanvas(BLADE_TILES, [0x0F,0x1B,0x2B,0x30], pos, so);
  daggerRaised = b.raised; daggerSwung = b.swung;
  b = _buildBladeCanvas(SWORD_TILES, [0x0F,0x00,0x32,0x30], pos, so);
  swordRaised = b.raised; swordSwung = b.swung;
  b = _buildBladeCanvas(NUNCHAKU_TILES, [0x0F,0x00,0x32,0x30], pos, so);
  nunchakuRaised = b.raised; nunchakuSwung = b.swung;

  fistCanvas = document.createElement('canvas');
  fistCanvas.width = 8; fistCanvas.height = 8;
  _blitTile(fistCanvas.getContext('2d'), decodeTile(FIST_TILE, 0), palette, 0, 0);
}

export function getKnifeBladeCanvas()      { return knifeRaised; }
export function getKnifeBladeSwungCanvas()  { return knifeSwung; }
export function getDaggerBladeCanvas()     { return daggerRaised; }
export function getDaggerBladeSwungCanvas() { return daggerSwung; }
export function getSwordBladeCanvas()      { return swordRaised; }
export function getSwordBladeSwungCanvas()  { return swordSwung; }
export function getNunchakuBladeCanvas()      { return nunchakuRaised; }
export function getNunchakuBladeSwungCanvas()  { return nunchakuSwung; }
// Pass the character's body palette to get a fist canvas tinted to match.
// No-arg form returns the legacy global (warrior-palette) fist for back-compat.
export function getFistCanvas(palette) {
  if (!palette) return fistCanvas;
  const key = palette.join(',');
  let c = _fistCache.get(key);
  if (c) return c;
  c = document.createElement('canvas'); c.width = 8; c.height = 8;
  _blitTile(c.getContext('2d'), decodeTile(FIST_TILE, 0), palette, 0, 0);
  _fistCache.set(key, c);
  return c;
}

export function getBlades() {
  return {
    knife:    { raised: knifeRaised,    swung: knifeSwung },
    dagger:   { raised: daggerRaised,   swung: daggerSwung },
    sword:    { raised: swordRaised,    swung: swordSwung },
    nunchaku: { raised: nunchakuRaised, swung: nunchakuSwung },
    fist:     fistCanvas,
  };
}
