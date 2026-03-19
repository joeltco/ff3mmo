// World Map Renderer — viewport-based rendering for 128x128 world maps

import { NES_SYSTEM_PALETTE, buildWaterFrames } from './tile-decoder.js';

const TILE_SIZE = 16;

export class WorldMapRenderer {
  constructor(worldMapData) {
    this.data = worldMapData;
    this._buildMetatileAtlas();
    this._initWaterAnimation();
  }

  _buildMetatileAtlas() {
    const { metatiles, chrTiles, palettes, tileAttrs } = this.data;

    // Build a 128-metatile atlas: each metatile is 16×16px, laid out in a row
    const atlas = document.createElement('canvas');
    atlas.width = 128 * TILE_SIZE;
    atlas.height = TILE_SIZE;
    const actx = atlas.getContext('2d');
    const tileImg = actx.createImageData(8, 8);
    const tileData = tileImg.data;

    for (let m = 0; m < 128; m++) {
      const meta = metatiles[m];
      const palIdx = tileAttrs[m] & 0x03;
      const pal = palettes[palIdx];
      const rgbPal = pal.map(nesIdx => NES_SYSTEM_PALETTE[nesIdx & 0x3F] || [0, 0, 0]);

      const chrIndices = [meta.tl, meta.tr, meta.bl, meta.br];
      const offsets = [[0, 0], [8, 0], [0, 8], [8, 8]];

      for (let q = 0; q < 4; q++) {
        const tile = chrTiles[chrIndices[q]];
        if (!tile) continue;

        for (let py = 0; py < 8; py++) {
          for (let px = 0; px < 8; px++) {
            const ci = tile[py * 8 + px];
            const rgb = rgbPal[ci];
            const di = (py * 8 + px) * 4;
            tileData[di] = rgb[0];
            tileData[di + 1] = rgb[1];
            tileData[di + 2] = rgb[2];
            tileData[di + 3] = 255;
          }
        }

        const ox = m * TILE_SIZE + offsets[q][0];
        const oy = offsets[q][1];
        actx.putImageData(tileImg, ox, oy);
      }
    }

    this._atlas = atlas;
  }

  _initWaterAnimation() {
    const { metatiles, chrTiles, palettes, tileAttrs } = this.data;
    const ANIM_CHR = new Set([0x22, 0x23, 0x24, 0x25, 0x26, 0x27]);

    this._waterFrames = buildWaterFrames(chrTiles, 8, 8);
    this._waterMetas = [];

    for (let m = 0; m < 128; m++) {
      const meta = metatiles[m];
      if (ANIM_CHR.has(meta.tl) || ANIM_CHR.has(meta.tr) ||
          ANIM_CHR.has(meta.bl) || ANIM_CHR.has(meta.br)) {
        this._waterMetas.push(m);
      }
    }
  }

  updateWaterAnimation(hFrame, vFrame) {
    if (!this._waterMetas || this._waterMetas.length === 0) return;

    const { metatiles, chrTiles, palettes, tileAttrs } = this.data;
    const actx = this._atlas.getContext('2d');
    const tileImg = actx.createImageData(8, 8);
    const tileData = tileImg.data;
    const HORIZ = new Set([0x22, 0x23, 0x24, 0x25]);
    const TILE_SIZE = 16;

    for (const m of this._waterMetas) {
      const meta = metatiles[m];
      const palIdx = tileAttrs[m] & 0x03;
      const pal = palettes[palIdx];
      const rgbPal = pal.map(nesIdx => NES_SYSTEM_PALETTE[nesIdx & 0x3F] || [0, 0, 0]);

      const chrIndices = [meta.tl, meta.tr, meta.bl, meta.br];
      const offsets = [[0, 0], [8, 0], [0, 8], [8, 8]];

      for (let q = 0; q < 4; q++) {
        const ci = chrIndices[q];
        const frames = this._waterFrames.get(ci);
        const tile = frames
          ? frames[HORIZ.has(ci) ? hFrame % frames.length : vFrame % frames.length]
          : chrTiles[ci];
        if (!tile) continue;

        for (let py = 0; py < 8; py++) {
          for (let px = 0; px < 8; px++) {
            const cIdx = tile[py * 8 + px];
            const rgb = rgbPal[cIdx];
            const di = (py * 8 + px) * 4;
            tileData[di] = rgb[0]; tileData[di + 1] = rgb[1];
            tileData[di + 2] = rgb[2]; tileData[di + 3] = 255;
          }
        }

        actx.putImageData(tileImg, m * TILE_SIZE + offsets[q][0], offsets[q][1]);
      }
    }
  }

  draw(ctx, cameraX, cameraY, originX, originY) {
    const viewW = ctx.canvas.width;
    const viewH = ctx.canvas.height;
    const size = this.data.mapWidth;

    // World pixel position of the top-left of the viewport
    const worldLeft = cameraX - originX;
    const worldTop = cameraY - originY;

    // Tile range to draw (add 1 extra for partial scroll)
    const startTX = Math.floor(worldLeft / TILE_SIZE);
    const startTY = Math.floor(worldTop / TILE_SIZE);
    const endTX = startTX + Math.ceil(viewW / TILE_SIZE) + 1;
    const endTY = startTY + Math.ceil(viewH / TILE_SIZE) + 1;

    for (let ty = startTY; ty <= endTY; ty++) {
      for (let tx = startTX; tx <= endTX; tx++) {
        // Wrap tile coords for seamless scrolling
        const wx = ((tx % size) + size) % size;
        const wy = ((ty % size) + size) % size;

        const metatileId = this.data.tilemap[wy * size + wx];
        const m = metatileId & 0x7F;

        // Screen position
        const sx = tx * TILE_SIZE - worldLeft;
        const sy = ty * TILE_SIZE - worldTop;

        ctx.drawImage(
          this._atlas,
          m * TILE_SIZE, 0, TILE_SIZE, TILE_SIZE,
          sx, sy, TILE_SIZE, TILE_SIZE
        );
      }
    }
  }

  drawOverlay() {
    // No-op for now (no sprite priority on world map)
  }

  isPassable(tileX, tileY) {
    const size = this.data.mapWidth;
    const wx = ((tileX % size) + size) % size;
    const wy = ((tileY % size) + size) % size;

    // Temporary choke block south of Ur — remove when world map content is complete
    if (wx === 95 && wy === 45) return false;

    const metatileId = this.data.tilemap[wy * size + wx];
    const m = metatileId & 0x7F;
    const props = this.data.tileProps[m];

    // Trigger tiles are always passable (walk onto to enter)
    if (props.byte1 & 0x80) return true;

    // Foot blocked: bit 0 set
    if (props.byte1 & 0x01) return false;

    return true;
  }

  getTriggerAt(tileX, tileY) {
    const size = this.data.mapWidth;
    const wx = ((tileX % size) + size) % size;
    const wy = ((tileY % size) + size) % size;

    const metatileId = this.data.tilemap[wy * size + wx];
    const m = metatileId & 0x7F;
    const props = this.data.tileProps[m];

    // Must have trigger bit set in byte1
    if (!(props.byte1 & 0x80)) return null;

    const trigId = props.byte2 & 0x3F;
    const destMap = this.data.entranceTable[trigId];
    if (destMap === 0) return null;

    return { type: 'entrance', trigId, destMap };
  }
}
