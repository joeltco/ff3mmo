// Sprite Assembly — combines 8x8 tiles into 16x16 sprites with walk animation

import { decodeTile, drawTile } from './tile-decoder.js';

const SPRITE_TILE_BASE = 0x01C010;

export const DIR_DOWN = 0;
export const DIR_UP = 1;
export const DIR_LEFT = 2;
export const DIR_RIGHT = 3;

// Verified via FCEUX OAM trace:
// DOWN f0: tiles $00-$03, no flip
// DOWN f1: top row $00/$01 NO flip, bottom row $03/$02 HFLIP (only bottom flips)
// UP   f0: tiles $04-$07, no flip
// UP   f1: top row $04/$05 NO flip, bottom row $07/$06 HFLIP (only bottom flips)
// LEFT f0: tiles $08-$0B, no flip
// LEFT f1: tiles $0C-$0F, no flip, 1px bob up
// RIGHT f0: tiles $08-$0B, full HFLIP
// RIGHT f1: tiles $0C-$0F, full HFLIP, 1px bob up
//
// flip: full horizontal flip of entire sprite (LEFT/RIGHT)
// bottomFlip: only flip bottom 8px row, top stays same (DOWN/UP f1)
// tiles for bottomFlip frames are pre-swapped [TL,TR,BR,BL] so bottom row
// renders correctly after the half-flip
const WALK_FRAMES = {
  [DIR_DOWN]: [
    { tiles: [0, 1, 2, 3], flip: false, bottomFlip: false, yOff: 0 },
    { tiles: [0, 1, 2, 3], flip: false, bottomFlip: true,  yOff: 0, xOff: -1 },
  ],
  [DIR_UP]: [
    { tiles: [4, 5, 6, 7], flip: false, bottomFlip: false, yOff: 0 },
    { tiles: [4, 5, 6, 7], flip: false, bottomFlip: true,  yOff: 0, xOff: -1 },
  ],
  [DIR_LEFT]: [
    { tiles: [8, 9, 10, 11],   flip: false, bottomFlip: false, yOff:  0 },
    { tiles: [12, 13, 14, 15], flip: false, bottomFlip: false, yOff: -1 },
  ],
  [DIR_RIGHT]: [
    { tiles: [8, 9, 10, 11],   flip: true, bottomFlip: false, yOff:  0 },
    { tiles: [12, 13, 14, 15], flip: true, bottomFlip: false, yOff: -1 },
  ],
};

export class Sprite {
  constructor(romData, paletteColors, paletteBottom) {
    this.romData = romData;
    this.palette = paletteColors;
    this.paletteBottom = paletteBottom || paletteColors;
    this.direction = DIR_DOWN;
    this.frame = 0;
    this.tileCache = new Map();
  }

  getDecodedTile(tileIndex) {
    if (!this.tileCache.has(tileIndex)) {
      const offset = SPRITE_TILE_BASE + tileIndex * 16;
      this.tileCache.set(tileIndex, decodeTile(this.romData, offset));
    }
    return this.tileCache.get(tileIndex);
  }

  setDirection(dir) { this.direction = dir; }
  getDirection()    { return this.direction; }

  setWalkProgress(t) { this.frame = t < 0.5 ? 0 : 1; }
  resetFrame()       { this.frame = 0; }

  draw(ctx, x, y) {
    const frameData   = WALK_FRAMES[this.direction][this.frame];
    const tileIndices = frameData.tiles;
    x += frameData.xOff || 0;
    y += frameData.yOff || 0;

    if (!this._tmpCanvas) {
      this._tmpCanvas = document.createElement('canvas');
      this._tmpCanvas.width = 16;
      this._tmpCanvas.height = 16;
      this._tmpCtx = this._tmpCanvas.getContext('2d');
    }
    const tmpCtx = this._tmpCtx;
    tmpCtx.clearRect(0, 0, 16, 16);

    // Draw all 4 tiles into temp canvas (top row normal, bottom row normal)
    const positions = [[0,0],[8,0],[0,8],[8,8]];
    for (let i = 0; i < 4; i++) {
      const tile = this.getDecodedTile(tileIndices[i]);
      const pal  = i < 2 ? this.palette : this.paletteBottom;
      drawTile(tmpCtx, tile, pal, positions[i][0], positions[i][1]);
    }

    if (frameData.flip) {
      // Full horizontal flip (LEFT/RIGHT)
      ctx.save();
      ctx.translate(x + 16, y);
      ctx.scale(-1, 1);
      ctx.drawImage(this._tmpCanvas, 0, 0);
      ctx.restore();
    } else if (frameData.bottomFlip) {
      // Top 8px drawn normally, bottom 8px flipped horizontally
      ctx.drawImage(this._tmpCanvas, 0, 0, 16, 8, x, y, 16, 8);
      ctx.save();
      ctx.translate(x + 16, y + 8);
      ctx.scale(-1, 1);
      ctx.drawImage(this._tmpCanvas, 0, 8, 16, 8, 0, 0, 16, 8);
      ctx.restore();
    } else {
      ctx.drawImage(this._tmpCanvas, 0, 0, 16, 16, x, y, 16, 16);
    }
  }
}

export { WALK_FRAMES, SPRITE_TILE_BASE };
