// HUD canvas init — decodes border tiles from ROM, builds composite HUD canvases
// and their fade frames. Runs once at boot.

import { NES_SYSTEM_PALETTE, decodeTiles } from './tile-decoder.js';
import { nesColorFade } from './palette.js';
import { ui, drawBoxOnCtx } from './ui-state.js';
import { titleSt } from './title-screen.js';
import { LOAD_FADE_MAX } from './loading-screen.js';

const CANVAS_W = 256;
const CANVAS_H = 240;
const HUD_TOP_H = 32;
const HUD_VIEW_X = 0;
const HUD_VIEW_Y = HUD_TOP_H;
const HUD_VIEW_W = 144;
const HUD_VIEW_H = 144;
const HUD_RIGHT_X = HUD_VIEW_W;
const HUD_RIGHT_W = CANVAS_W - HUD_VIEW_W;
const HUD_BOT_Y = HUD_VIEW_Y + HUD_VIEW_H;
const HUD_BOT_H = CANVAS_H - HUD_BOT_Y;

// Menu border tiles — ROM offset: bank 0D, $1700 into bank, tiles $F7-$FF
const BORDER_TILE_ROM = 0x1B710 + (0xF7 - 0x70) * 16;  // 0x1BF80
const BORDER_TILE_COUNT = 9;  // $F7 TL, $F8 top, $F9 TR, $FA left, $FB right, $FC BL, $FD bot, $FE BR, $FF fill
const MENU_PALETTE = [0x0F, 0x00, 0x0F, 0x30];  // black, grey, black (interior), white

let borderTileCanvases = null;
let borderFadeSets = null;

function _tileToCanvas(pixels, palette, transparentBg = false) {
  const c = document.createElement('canvas');
  c.width = 8; c.height = 8;
  const tctx = c.getContext('2d');
  const img = tctx.createImageData(8, 8);
  for (let i = 0; i < 64; i++) {
    const rgb = NES_SYSTEM_PALETTE[palette[pixels[i]]] || [0, 0, 0];
    img.data[i * 4] = rgb[0]; img.data[i * 4 + 1] = rgb[1];
    img.data[i * 4 + 2] = rgb[2]; img.data[i * 4 + 3] = (transparentBg && pixels[i] === 0) ? 0 : 255;
  }
  tctx.putImageData(img, 0, 0);
  return c;
}

function _initHUDBorderTiles(tiles) {
  borderTileCanvases = tiles.map(p => _tileToCanvas(p, MENU_PALETTE));
  ui.borderTileCanvases = borderTileCanvases;
  ui.cornerMasks = [0, 2, 5, 7].map(idx => {
    const pixels = tiles[idx];
    const c = document.createElement('canvas'); c.width = 8; c.height = 8;
    const tctx = c.getContext('2d'); const img = tctx.createImageData(8, 8);
    for (let i = 0; i < 64; i++) if (pixels[i] === 0) img.data[i * 4 + 3] = 255;
    tctx.putImageData(img, 0, 0); return c;
  });
  ui.borderBlueTileCanvases = tiles.map(p => _tileToCanvas(p, [0x02, 0x00, 0x02, 0x30], true));
  borderFadeSets = [];
  for (let step = 0; step <= LOAD_FADE_MAX; step++) {
    const fadedPal = MENU_PALETTE.map(c => { let fc = c; for (let s = 0; s < step; s++) fc = nesColorFade(fc); return fc; });
    borderFadeSets.push(tiles.map(p => _tileToCanvas(p, fadedPal)));
  }
  ui.borderFadeSets = borderFadeSets;
  // Title screen gets transparent-background border tiles (no black outer edge)
  titleSt.borderTiles = tiles.map(p => _tileToCanvas(p, MENU_PALETTE, true));
  const titleFadeSets = [];
  for (let step = 0; step <= LOAD_FADE_MAX; step++) {
    const fadedPal = MENU_PALETTE.map(c => { let fc = c; for (let s = 0; s < step; s++) fc = nesColorFade(fc); return fc; });
    titleFadeSets.push(tiles.map(p => _tileToCanvas(p, fadedPal, true)));
  }
  titleSt.borderFadeSets = titleFadeSets;
}

function _initHUDCanvases() {
  const hudCanvas = document.createElement('canvas');
  hudCanvas.width = CANVAS_W; hudCanvas.height = CANVAS_H;
  const hctx = hudCanvas.getContext('2d'); hctx.imageSmoothingEnabled = false;
  drawBoxOnCtx(hctx, borderTileCanvases, HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H, false);
  drawBoxOnCtx(hctx, borderTileCanvases, HUD_RIGHT_X, HUD_VIEW_Y, 32, 32);
  drawBoxOnCtx(hctx, borderTileCanvases, HUD_RIGHT_X + 32, HUD_VIEW_Y, HUD_RIGHT_W - 32, 32);
  drawBoxOnCtx(hctx, borderTileCanvases, 0, HUD_BOT_Y, CANVAS_W, HUD_BOT_H);
  ui.hudCanvas = hudCanvas;

  const titleHudCanvas = document.createElement('canvas');
  titleHudCanvas.width = CANVAS_W; titleHudCanvas.height = CANVAS_H;
  const thctx = titleHudCanvas.getContext('2d'); thctx.imageSmoothingEnabled = false;
  drawBoxOnCtx(thctx, borderTileCanvases, HUD_VIEW_X, HUD_VIEW_Y, CANVAS_W, HUD_VIEW_H, false);
  drawBoxOnCtx(thctx, borderTileCanvases, 0, HUD_BOT_Y, CANVAS_W, HUD_BOT_H);
  ui.titleHudCanvas = titleHudCanvas;
}

function _buildFadedHUDSet(boxes) {
  const arr = [];
  for (let step = 1; step <= LOAD_FADE_MAX; step++) {
    const c = document.createElement('canvas'); c.width = CANVAS_W; c.height = CANVAS_H;
    const fctx = c.getContext('2d'); fctx.imageSmoothingEnabled = false;
    for (const [bx, by, bw, bh, fill] of boxes) drawBoxOnCtx(fctx, borderFadeSets[step], bx, by, bw, bh, fill);
    arr.push(c);
  }
  return arr;
}

export function initHUD(romData) {
  _initHUDBorderTiles(decodeTiles(romData, BORDER_TILE_ROM, BORDER_TILE_COUNT));
  _initHUDCanvases();
  ui.hudFadeCanvases = _buildFadedHUDSet([
    [HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H, false],
    [HUD_RIGHT_X, HUD_VIEW_Y, 32, 32, true],
    [HUD_RIGHT_X + 32, HUD_VIEW_Y, HUD_RIGHT_W - 32, 32, true],
  ]);
  ui.titleHudFadeCanvases = _buildFadedHUDSet([[HUD_VIEW_X, HUD_VIEW_Y, CANVAS_W, HUD_VIEW_H, false]]);
}
