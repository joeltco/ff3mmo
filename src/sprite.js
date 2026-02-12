// Sprite Assembly — combines 8x8 tiles into 16x16 sprites with walk animation

import { decodeTile, drawTile } from './tile-decoder.js';

// FF3 map sprite tile region starts at file offset $01C010
// Each character's walk sprites are a set of 8x8 tiles arranged in a 2x2 grid
// The first character (Onion Knight) tiles are at the start of this region.
//
// Typical NES sprite layout for a 16x16 character:
//   [TL] [TR]     (top-left, top-right)
//   [BL] [BR]     (bottom-left, bottom-right)
//
// FF3 walking sprite arrangement (tile indices relative to sprite tile base):
// Each direction has 2 walk frames. The tile indices below are offsets
// into the sprite tile region (each tile is 16 bytes in 2BPP).
//
// These are provisional — use tile-browser.html to verify and adjust.
// FF3 typically arranges: down-frame0, down-frame1, up-frame0, up-frame1,
// left-frame0, left-frame1 (right = horizontal flip of left)

const SPRITE_TILE_BASE = 0x01C010; // File offset for map/walking sprite tiles

// Direction constants
export const DIR_DOWN = 0;
export const DIR_UP = 1;
export const DIR_LEFT = 2;
export const DIR_RIGHT = 3;

// Walk animation frames per direction
// Verified by user inspection of debug sprite sheet.
// 16 tiles per character: down(4), up(4), left-f0(4), left-f1(4)
// Down/up have 1 unique frame — walk animation alternates normal/hflipped.
// Left has 2 independent frames. Right = left horizontally flipped.
// Tiles are row-major: [TL, TR, BL, BR].
const WALK_FRAMES = {
  [DIR_DOWN]: [
    { tiles: [0, 1, 2, 3], flip: false },  // frame 0
    { tiles: [0, 1, 2, 3], flip: true },   // frame 1 (horizontally flipped)
  ],
  [DIR_UP]: [
    { tiles: [4, 5, 6, 7], flip: false },  // frame 0
    { tiles: [4, 5, 6, 7], flip: true },   // frame 1 (horizontally flipped)
  ],
  [DIR_LEFT]: [
    { tiles: [8, 9, 10, 11], flip: false },   // frame 0
    { tiles: [12, 13, 14, 15], flip: false },  // frame 1
  ],
  [DIR_RIGHT]: [
    { tiles: [8, 9, 10, 11], flip: true },    // frame 0 (left tiles, flipped)
    { tiles: [12, 13, 14, 15], flip: true },   // frame 1 (left tiles, flipped)
  ],
};

export class Sprite {
  constructor(romData, paletteColors) {
    this.romData = romData;
    this.palette = paletteColors; // sub-palette: 4 NES color indices
    this.direction = DIR_DOWN;
    this.frame = 0;

    // Pre-decode all needed tiles from the sprite region
    this.tileCache = new Map();
  }

  getDecodedTile(tileIndex) {
    if (!this.tileCache.has(tileIndex)) {
      const offset = SPRITE_TILE_BASE + tileIndex * 16;
      this.tileCache.set(tileIndex, decodeTile(this.romData, offset));
    }
    return this.tileCache.get(tileIndex);
  }

  setDirection(dir) {
    this.direction = dir;
  }

  getDirection() {
    return this.direction;
  }

  // Set animation frame directly based on movement progress (0.0 - 1.0)
  // Frame 0 for first half of step, frame 1 for second half
  setWalkProgress(t) {
    this.frame = t < 0.5 ? 0 : 1;
  }

  resetFrame() {
    this.frame = 0;
  }

  // Draw the 16x16 sprite at (x, y) on the canvas context
  draw(ctx, x, y) {
    const frames = WALK_FRAMES[this.direction];
    const frameData = frames[this.frame];
    const tileIndices = frameData.tiles;
    const isFlipped = frameData.flip;

    // 2x2 tile positions in row-major order: [TL, TR, BL, BR]
    const positions = [
      [0, 0],  // top-left
      [8, 0],  // top-right
      [0, 8],  // bottom-left
      [8, 8],  // bottom-right
    ];

    // Render tiles to a temp canvas, then composite with transparency
    if (!this._tmpCanvas) {
      this._tmpCanvas = document.createElement('canvas');
      this._tmpCanvas.width = 16;
      this._tmpCanvas.height = 16;
      this._tmpCtx = this._tmpCanvas.getContext('2d');
    }
    const tmpCtx = this._tmpCtx;
    tmpCtx.clearRect(0, 0, 16, 16);

    for (let i = 0; i < 4; i++) {
      const tile = this.getDecodedTile(tileIndices[i]);
      drawTile(tmpCtx, tile, this.palette, positions[i][0], positions[i][1]);
    }

    if (isFlipped) {
      ctx.save();
      ctx.translate(x + 16, y);
      ctx.scale(-1, 1);
      ctx.drawImage(this._tmpCanvas, 0, 0);
      ctx.restore();
    } else {
      ctx.drawImage(this._tmpCanvas, 0, 0, 16, 16, x, y, 16, 16);
    }
  }
}

export { WALK_FRAMES, SPRITE_TILE_BASE };
