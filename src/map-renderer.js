// Map Renderer — pre-renders full map to a canvas, draws viewport, checks collision

import { NES_SYSTEM_PALETTE, buildWaterFrames } from './tile-decoder.js';

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
    this._initWaterAnimation();
  }

  _computeRoomBounds(mapData, startX, startY) {
    if (mapData.skipRoomClip) {
      this._roomClip = null;
      return;
    }
    const { entranceX, entranceY, tilemap, collision, fillTile } = mapData;
    const visited = new Uint8Array(1024);

    // Phase 1: BFS through walkable tiles only (seed from spawn, not ROM entrance)
    const queue = [];
    const startIdx = startY * MAP_SIZE + startX;
    visited[startIdx] = 1;
    queue.push(startIdx);

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

        if ((coll & 0x07) === 3) continue;
        if (coll & 0x80) continue;

        const trig = this._triggerMap.get(`${nx},${ny}`);
        if (trig && trig.type === 1) continue;

        visited[nidx] = 1;
        queue.push(nidx);
      }
    }

    // Column clamp for Phase 2: derived from Phase 1 walkable area + 1 tile
    // padding for surrounding walls. Tighter than startX±8 to avoid bleeding
    // into other rooms on shared tilemaps.
    let p1MinX = startX, p1MaxX = startX, p1MaxY = startY;
    for (let i = 0; i < 1024; i++) {
      if (!visited[i]) continue;
      const x = i % MAP_SIZE;
      const y = (i - x) / MAP_SIZE;
      if (x < p1MinX) p1MinX = x;
      if (x > p1MaxX) p1MaxX = x;
      if (y > p1MaxY) p1MaxY = y;
    }
    const p2ColMin = Math.max(0, p1MinX - 4);
    const p2ColMax = Math.min(MAP_SIZE - 1, p1MaxX + 4);
    const p2RowMax = Math.min(MAP_SIZE - 1, p1MaxY + 1);

    // Phase 2: distance-limited flood fill through non-fill tiles.
    // Max 5 tiles from any walkable floor — covers walls, ceiling, and
    // overhang without bleeding into adjacent rooms on shared tilemaps.
    const dist = new Int8Array(1024);
    dist.fill(-1);
    const p2queue = [];
    for (let i = 0; i < 1024; i++) {
      if (visited[i]) { p2queue.push(i); dist[i] = 0; }
    }

    while (p2queue.length > 0) {
      const idx = p2queue.shift();
      if (dist[idx] >= 5) continue;
      const x = idx % MAP_SIZE;
      const y = (idx - x) / MAP_SIZE;

      for (const [dx, dy] of [[0,-1],[0,1],[-1,0],[1,0]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= MAP_SIZE || ny < 0 || ny >= MAP_SIZE) continue;
        if (nx < p2ColMin || nx > p2ColMax) continue;
        if (ny > p2RowMax) continue;
        const nidx = ny * MAP_SIZE + nx;
        if (visited[nidx]) continue;

        const mid = tilemap[nidx];
        if (mid === fillTile) continue;

        visited[nidx] = 1;
        dist[nidx] = dist[idx] + 1;

        // Stop expanding at collision trigger tiles (bit 7) — these are
        // room boundaries like exit_prev ($68). Include the tile in the
        // clip but don't go past it.
        const nM = mid < 128 ? mid : mid & 0x7F;
        const nColl = collision[nM];
        if (!(nColl & 0x80)) {
          p2queue.push(nidx);
        }
      }
    }

    // Bounding box
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

    const left = minX;
    const right = maxX + 1;
    let bottom = maxY + 1;

    // Extend top by 1 row if it contains only wall tiles (z=3) or fill.
    // This recovers ceiling rows the distance-limited BFS couldn't reach
    // without bleeding into adjacent rooms (which have floor tiles, z<3).
    let top = minY;
    if (top > 0) {
      let canExpand = true;
      for (let col = left; col < right; col++) {
        const mid = tilemap[(top - 1) * MAP_SIZE + col];
        if (mid === fillTile) continue;
        const m = mid < 128 ? mid : mid & 0x7F;
        const coll = collision[m];
        if ((coll & 0x07) !== 3) { canExpand = false; break; }
      }
      if (canExpand) top--;
    }

    // Extend bottom by up to 2 rows of wall overhang ($01 etc).
    // Only expand if ALL non-fill tiles are z=3 AND at least one is
    // not $00 (ceiling). Pure $00 rows are room separators, not borders.
    for (let ext = 0; ext < 2 && bottom < MAP_SIZE; ext++) {
      let hasOverhang = false;
      let allWall = true;
      for (let col = left; col < right; col++) {
        const mid = tilemap[bottom * MAP_SIZE + col];
        if (mid === fillTile) continue;
        const m = mid < 128 ? mid : mid & 0x7F;
        const coll = collision[m];
        if ((coll & 0x07) !== 3) { allWall = false; break; }
        if (mid !== 0x00) hasOverhang = true;
      }
      if (!allWall || !hasOverhang) break;
      bottom++;
    }

    // Full-map (outdoor) maps: no clip needed
    if ((right - left) >= MAP_SIZE || (bottom - top) >= MAP_SIZE) {
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

  hasRoomClip() {
    return this._roomClip !== null;
  }

  getRoomClip() {
    return this._roomClip;
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
    const rc = this._roomClip;
    if (rc) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(rc.x - worldLeft, rc.y - worldTop, rc.w, rc.h);
      ctx.clip();
      ctx.drawImage(this._mapCanvas, -worldLeft, -worldTop);
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
    ctx.restore();

    // l bit (0x10): overlay clips to sprite's top 8px
    ctx.save();
    ctx.beginPath();
    ctx.rect(spriteX, spriteY, 16, 8);
    ctx.clip();
    ctx.drawImage(this._overlayL, -worldLeft, -worldTop);
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
      if (trig.type === 1 || trig.type === 4) return true; // entrance/door/passage — passable
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

  _initWaterAnimation() {
    const { chrTiles, metatiles, tilemap } = this.mapData;
    const ANIM_CHR = new Set([0x22, 0x23, 0x24, 0x25, 0x26, 0x27]);

    this._waterFrames = buildWaterFrames(chrTiles, 8, 8);
    this._waterPositions = [];

    // Scan tilemap for positions referencing animated CHR tiles
    for (let ty = 0; ty < MAP_SIZE; ty++) {
      for (let tx = 0; tx < MAP_SIZE; tx++) {
        const mid = tilemap[ty * MAP_SIZE + tx];
        const m = mid < 128 ? mid : mid & 0x7F;
        const meta = metatiles[m];
        if (ANIM_CHR.has(meta.tl) || ANIM_CHR.has(meta.tr) ||
            ANIM_CHR.has(meta.bl) || ANIM_CHR.has(meta.br)) {
          this._waterPositions.push({ tx, ty, m });
        }
      }
    }
  }

  updateWaterAnimation(hFrame, vFrame) {
    if (!this._waterPositions || this._waterPositions.length === 0) return;

    const { chrTiles, metatiles, palettes, tileAttrs } = this.mapData;
    const fctx = this._mapCanvas.getContext('2d');
    const tileImg = fctx.createImageData(8, 8);
    const tileData = tileImg.data;
    const HORIZ = new Set([0x22, 0x23, 0x24, 0x25]);

    for (const { tx, ty, m } of this._waterPositions) {
      const meta = metatiles[m];
      const palIdx = tileAttrs[m] & 0x03;
      const pal = palettes[palIdx];
      const rgbPal = pal.map(nesIdx => NES_SYSTEM_PALETTE[nesIdx & 0x3F] || [0, 0, 0]);

      const chrIndices = [meta.tl, meta.tr, meta.bl, meta.br];
      const offsets = [[0, 0], [8, 0], [0, 8], [8, 8]];

      for (let q = 0; q < 4; q++) {
        const ci = chrIndices[q];
        const frames = this._waterFrames.get(ci);
        if (!frames) continue; // not an animated CHR tile

        const frame = HORIZ.has(ci) ? hFrame % frames.length : vFrame % frames.length;
        const tile = frames[frame];

        for (let py = 0; py < 8; py++) {
          for (let px = 0; px < 8; px++) {
            const cIdx = tile[py * 8 + px];
            const rgb = rgbPal[cIdx];
            const di = (py * 8 + px) * 4;
            tileData[di] = rgb[0]; tileData[di + 1] = rgb[1];
            tileData[di + 2] = rgb[2]; tileData[di + 3] = 255;
          }
        }

        fctx.putImageData(tileImg, tx * TILE_SIZE + offsets[q][0], ty * TILE_SIZE + offsets[q][1]);
      }
    }
  }

  updateTileAt(tileX, tileY, newMetatileId) {
    const { chrTiles, metatiles, palettes, tileAttrs, collision } = this.mapData;
    const m = newMetatileId < 128 ? newMetatileId : newMetatileId & 0x7F;
    const meta = metatiles[m];
    const palIdx = tileAttrs[m] & 0x03;
    const pal = palettes[palIdx];
    const rgbPal = pal.map(nesIdx => NES_SYSTEM_PALETTE[nesIdx & 0x3F] || [0, 0, 0]);

    const chrIndices = [meta.tl, meta.tr, meta.bl, meta.br];
    const offsets = [[0, 0], [8, 0], [0, 8], [8, 8]];

    // Redraw on main map canvas
    const fctx = this._mapCanvas.getContext('2d');
    const tileImg = fctx.createImageData(8, 8);
    const tileData = tileImg.data;

    for (let q = 0; q < 4; q++) {
      const tile = chrTiles[chrIndices[q]];
      if (!tile) continue;
      for (let py = 0; py < 8; py++) {
        for (let px = 0; px < 8; px++) {
          const ci = tile[py * 8 + px];
          const rgb = rgbPal[ci];
          const di = (py * 8 + px) * 4;
          tileData[di] = rgb[0]; tileData[di + 1] = rgb[1];
          tileData[di + 2] = rgb[2]; tileData[di + 3] = 255;
        }
      }
      fctx.putImageData(tileImg, tileX * TILE_SIZE + offsets[q][0], tileY * TILE_SIZE + offsets[q][1]);
    }

    // Clear priority overlays at this tile (closed door may have had priority bits)
    const props = collision[m];
    const ox = tileX * TILE_SIZE;
    const oy = tileY * TILE_SIZE;
    const uctx = this._overlayU.getContext('2d');
    const lctx = this._overlayL.getContext('2d');
    uctx.clearRect(ox, oy, TILE_SIZE, TILE_SIZE);
    lctx.clearRect(ox, oy, TILE_SIZE, TILE_SIZE);

    // Redraw priority overlays if new tile has priority bits
    if (props & 0x30) {
      const oImg = fctx.createImageData(8, 8);
      const oData = oImg.data;
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
        const px = ox + offsets[q][0];
        const py = oy + offsets[q][1];
        if (props & 0x20) uctx.putImageData(oImg, px, py);
        if (props & 0x10) lctx.putImageData(oImg, px, py);
      }
    }
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

    return null;
  }
}
