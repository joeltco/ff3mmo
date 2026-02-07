// Map Renderer — pre-renders full map to a canvas, draws viewport, checks collision

import { NES_SYSTEM_PALETTE } from './tile-decoder.js';

const TILE_SIZE = 16;
const MAP_SIZE = 32; // 32×32 metatiles
const MAP_PX = MAP_SIZE * TILE_SIZE; // 512px

export class MapRenderer {
  constructor(mapData, startX, startY) {
    this.mapData = mapData;
    this._playerZ = 0;

    // Initialize z-level from start tile
    const sx = startX ?? mapData.entranceX;
    const sy = startY ?? mapData.entranceY;
    const eTile = mapData.tilemap[sy * MAP_SIZE + sx];
    const eColl = mapData.collision[eTile < 128 ? eTile : eTile & 0x7F];
    const eZZ = eColl & 0x03;
    if (eZZ > 0 && eZZ < 3) this._playerZ = eZZ;

    this._triggerMap = mapData.triggerMap;       // Map<"x,y", {type, trigId}>
    this._collisionByte2 = mapData.collisionByte2; // Uint8Array(128)
    this._entranceData = mapData.entranceData;   // Uint8Array(16)

    this._computeRoomBounds(mapData, sx, sy);
    this.prerenderFullMap();
  }

  _computeRoomBounds(mapData, startX, startY) {
    const { entranceX, entranceY, tilemap, collision } = mapData;
    const visited = new Uint8Array(1024);

    // Phase 1: BFS through walkable tiles only
    // Seed from both player position and entrance so rooms with
    // counters/barriers include both sides in the clip region
    const queue = [];
    const startIdx = startY * MAP_SIZE + startX;
    visited[startIdx] = 1;
    queue.push(startIdx);
    const entIdx = entranceY * MAP_SIZE + entranceX;
    if (!visited[entIdx]) {
      visited[entIdx] = 1;
      queue.push(entIdx);
    }

    while (queue.length > 0) {
      const idx = queue.shift();
      const x = idx % MAP_SIZE;
      const y = (idx - x) / MAP_SIZE;

      for (const [dx, dy] of [[0,-1],[0,1],[-1,0],[1,0]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= MAP_SIZE || ny < 0 || ny >= MAP_SIZE) continue;
        const nidx = ny * MAP_SIZE + nx;
        if (visited[nidx]) continue;

        const mid = tilemap[nidx];
        const m = mid < 128 ? mid : mid & 0x7F;
        const coll = collision[m];

        // Wall: don't expand in phase 1
        if ((coll & 0x07) === 3) continue;

        // Collision-trigger (bit 7): room boundary, don't expand
        if (coll & 0x80) continue;

        // Dynamic entrance/door trigger: room boundary, don't expand
        const trig = this._triggerMap.get(`${nx},${ny}`);
        if (trig && trig.type === 1) continue;

        visited[nidx] = 1;
        queue.push(nidx);
      }
    }

    // Phase 2: expand from visited tiles through walls, 3 rings deep.
    // This includes room borders (walls, counters, decorations) without
    // bleeding into adjacent rooms in shared tilemaps.
    const WALL_RINGS = 3;
    let frontier = [];
    for (let i = 0; i < 1024; i++) {
      if (visited[i]) frontier.push(i);
    }

    for (let ring = 0; ring < WALL_RINGS; ring++) {
      const next = [];
      for (const idx of frontier) {
        const x = idx % MAP_SIZE;
        const y = (idx - x) / MAP_SIZE;
        for (const [dx, dy] of [[0,-1],[0,1],[-1,0],[1,0]]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= MAP_SIZE || ny < 0 || ny >= MAP_SIZE) continue;
          const nidx = ny * MAP_SIZE + nx;
          if (visited[nidx]) continue;

          // Only expand into wall tiles (zz=3)
          const mid = tilemap[nidx];
          const m = mid < 128 ? mid : mid & 0x7F;
          const coll = collision[m];
          if ((coll & 0x07) !== 3) continue;

          visited[nidx] = 1;
          next.push(nidx);
        }
      }
      frontier = next;
    }

    // Bounding box of visited tiles + small margin
    let minX = MAP_SIZE, maxX = 0, minY = MAP_SIZE, maxY = 0;
    for (let i = 0; i < 1024; i++) {
      if (!visited[i]) continue;
      const x = i % MAP_SIZE;
      const y = (i - x) / MAP_SIZE;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }

    const PAD = 4;
    const left = Math.max(0, minX - PAD);
    const top = Math.max(0, minY - PAD);
    const right = maxX + PAD + 1;
    const bottom = maxY + PAD + 1;

    // Large/outdoor maps: no clip needed
    if ((right - left) >= 26 || (bottom - top) >= 26) {
      this._roomClip = null;
      return;
    }

    this._roomClip = {
      x: left * TILE_SIZE,
      y: top * TILE_SIZE,
      w: (right - left) * TILE_SIZE,
      h: (bottom - top) * TILE_SIZE,
    };
  }

  prerenderFullMap() {
    const { chrTiles, metatiles, palettes, tileAttrs, tilemap, fillTile } = this.mapData;

    const fullCanvas = document.createElement('canvas');
    fullCanvas.width = MAP_PX;
    fullCanvas.height = MAP_PX;
    const fctx = fullCanvas.getContext('2d');

    const tileImg = fctx.createImageData(8, 8);
    const tileData = tileImg.data;

    for (let ty = 0; ty < MAP_SIZE; ty++) {
      for (let tx = 0; tx < MAP_SIZE; tx++) {
        const mid = tilemap[ty * MAP_SIZE + tx];
        const m = mid < 128 ? mid : mid & 0x7F;
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

          const ox = tx * TILE_SIZE + offsets[q][0];
          const oy = ty * TILE_SIZE + offsets[q][1];
          fctx.putImageData(tileImg, ox, oy);
        }
      }
    }

    this._mapCanvas = fullCanvas;

    this._overlayU = this._prerenderPriorityCanvas(chrTiles, metatiles, palettes, tileAttrs, tilemap, 0x20);
    this._overlayL = this._prerenderPriorityCanvas(chrTiles, metatiles, palettes, tileAttrs, tilemap, 0x10);

    // Pre-render fill tile for out-of-bounds
    const fillMeta = metatiles[fillTile] || metatiles[0];
    const fillPalIdx = tileAttrs[fillTile] & 0x03;
    const fillPal = palettes[fillPalIdx];
    const fillRgb = fillPal.map(nesIdx => NES_SYSTEM_PALETTE[nesIdx & 0x3F] || [0, 0, 0]);

    const fillCanvas = document.createElement('canvas');
    fillCanvas.width = TILE_SIZE;
    fillCanvas.height = TILE_SIZE;
    const fillCtx = fillCanvas.getContext('2d');
    const fillImg = fillCtx.createImageData(8, 8);
    const fp = fillImg.data;
    const fillChr = [fillMeta.tl, fillMeta.tr, fillMeta.bl, fillMeta.br];
    const fillOff = [[0, 0], [8, 0], [0, 8], [8, 8]];
    for (let q = 0; q < 4; q++) {
      const tile = chrTiles[fillChr[q]];
      if (!tile) continue;
      for (let py = 0; py < 8; py++) {
        for (let px = 0; px < 8; px++) {
          const ci = tile[py * 8 + px];
          const rgb = fillRgb[ci];
          const di = (py * 8 + px) * 4;
          fp[di] = rgb[0]; fp[di + 1] = rgb[1]; fp[di + 2] = rgb[2]; fp[di + 3] = 255;
        }
      }
      fillCtx.putImageData(fillImg, fillOff[q][0], fillOff[q][1]);
    }
    this._fillCanvas = fillCanvas;
  }

  _prerenderPriorityCanvas(chrTiles, metatiles, palettes, tileAttrs, tilemap, bitMask) {
    const canvas = document.createElement('canvas');
    canvas.width = MAP_PX;
    canvas.height = MAP_PX;
    const octx = canvas.getContext('2d');
    const oImg = octx.createImageData(8, 8);
    const oData = oImg.data;

    for (let ty = 0; ty < MAP_SIZE; ty++) {
      for (let tx = 0; tx < MAP_SIZE; tx++) {
        const mid = tilemap[ty * MAP_SIZE + tx];
        const m = mid < 128 ? mid : mid & 0x7F;
        const props = this.mapData.collision[m];
        if (!(props & bitMask)) continue;

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
              const di = (py * 8 + px) * 4;
              if (ci === 0) {
                oData[di] = 0; oData[di+1] = 0; oData[di+2] = 0; oData[di+3] = 0;
              } else {
                const rgb = rgbPal[ci];
                oData[di] = rgb[0]; oData[di+1] = rgb[1]; oData[di+2] = rgb[2]; oData[di+3] = 255;
              }
            }
          }

          const ox = tx * TILE_SIZE + offsets[q][0];
          const oy = ty * TILE_SIZE + offsets[q][1];
          octx.putImageData(oImg, ox, oy);
        }
      }
    }
    return canvas;
  }

  draw(ctx, cameraX, cameraY, originX, originY) {
    const viewW = ctx.canvas.width;
    const viewH = ctx.canvas.height;

    const worldLeft = cameraX - originX;
    const worldTop = cameraY - originY;

    // Fill background with fill tile pattern
    const pattern = ctx.createPattern(this._fillCanvas, 'repeat');
    ctx.fillStyle = pattern;
    ctx.save();
    ctx.translate(-worldLeft % TILE_SIZE, -worldTop % TILE_SIZE);
    ctx.fillRect(-(TILE_SIZE), -(TILE_SIZE), viewW + TILE_SIZE * 2, viewH + TILE_SIZE * 2);
    ctx.restore();

    // Draw map, clipped to room bounds for shared tilemaps (small indoor rooms)
    // NES PPU wraps tilemaps vertically, so draw a second copy shifted by MAP_PX
    const rc = this._roomClip;
    if (rc) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(rc.x - worldLeft, rc.y - worldTop, rc.w, rc.h);
      ctx.clip();
      ctx.drawImage(this._mapCanvas, -worldLeft, -worldTop);
      ctx.drawImage(this._mapCanvas, -worldLeft, -worldTop + MAP_PX);
      ctx.restore();
    } else {
      ctx.drawImage(this._mapCanvas, -worldLeft, -worldTop);
    }
  }

  drawOverlay(ctx, cameraX, cameraY, originX, originY, spriteX, spriteY) {
    const worldLeft = cameraX - originX;
    const worldTop = cameraY - originY;

    // u bit (0x20): overlay clips to sprite's bottom 8px
    ctx.save();
    ctx.beginPath();
    ctx.rect(spriteX, spriteY + 8, 16, 8);
    ctx.clip();
    ctx.drawImage(this._overlayU, -worldLeft, -worldTop);
    ctx.drawImage(this._overlayU, -worldLeft, -worldTop + MAP_PX);
    ctx.restore();

    // l bit (0x10): overlay clips to sprite's top 8px
    ctx.save();
    ctx.beginPath();
    ctx.rect(spriteX, spriteY, 16, 8);
    ctx.clip();
    ctx.drawImage(this._overlayL, -worldLeft, -worldTop);
    ctx.drawImage(this._overlayL, -worldLeft, -worldTop + MAP_PX);
    ctx.restore();
  }

  isPassable(tileX, tileY) {
    if (tileX < 0 || tileX >= MAP_SIZE || tileY < 0 || tileY >= MAP_SIZE) {
      return false;
    }

    // Entrance tile is always passable (allows walking back to exit)
    if (tileX === this.mapData.entranceX && tileY === this.mapData.entranceY) {
      return true;
    }

    // Check dynamic trigger map first — entrance tiles are passable
    const key = `${tileX},${tileY}`;
    const trig = this._triggerMap.get(key);
    if (trig) {
      if (trig.type === 1) return true; // entrance/door — passable
      return false; // events/treasures — blocked for now
    }

    const metatileId = this.mapData.tilemap[tileY * MAP_SIZE + tileX];
    const m = metatileId < 128 ? metatileId : metatileId & 0x7F;
    const collByte = this.mapData.collision[m];

    // Bit 7 = collision-based trigger tile
    if (collByte & 0x80) {
      const b2 = this._collisionByte2[metatileId];
      const trigType = (b2 >> 4) & 0x0F;
      // exit_prev (0) and entrance/door (4,5) are passable
      if (trigType === 0 || trigType === 4 || trigType === 5) return true;
      return false;
    }

    // Z-level passability (matches NPC check at 3B/B0C5)
    const lower3 = collByte & 0x07;

    // All zero: passable, reset z-level
    if (lower3 === 0) {
      this._playerZ = 0;
      return true;
    }

    // Bridge bit set (>= 4): passable, no z-level change
    if (lower3 >= 4) {
      return true;
    }

    // Both z-bits set: always impassable
    if (lower3 === 3) {
      return false;
    }

    // Check z-level conflict: tile_zz OR player_z == 3 means blocked
    const combined = lower3 | this._playerZ;
    if (combined === 3) {
      return false;
    }

    // Passable — update z-level
    this._playerZ = combined;
    return true;
  }

  getTriggerAt(tileX, tileY) {
    // Check dynamic trigger map first (entrance/door/treasure/event tiles)
    const key = `${tileX},${tileY}`;
    const dynTrig = this._triggerMap.get(key);
    if (dynTrig) {
      return { source: 'dynamic', type: dynTrig.type, trigId: dynTrig.trigId };
    }

    // Check collision-based triggers (byte1 bit 7 + byte2 encodes type/id)
    const metatileId = this.mapData.tilemap[tileY * MAP_SIZE + tileX];
    const m = metatileId < 128 ? metatileId : metatileId & 0x7F;
    if (m < this.mapData.collision.length) {
      const b1 = this.mapData.collision[m];
      if (b1 & 0x80) {
        const b2 = this._collisionByte2[m];
        const trigType = (b2 >> 4) & 0x0F;
        const trigId = b2 & 0x0F;
        return { source: 'collision', trigType, trigId };
      }
    }

    // Entrance position acts as exit_prev (walk back to where you entered)
    if (tileX === this.mapData.entranceX && tileY === this.mapData.entranceY) {
      return { source: 'entrance', trigType: 0 };
    }

    return null;
  }
}
