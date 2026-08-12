// Map Renderer — pre-renders full map to a canvas, draws viewport, checks collision

import { NES_SYSTEM_PALETTE, buildWaterFrames } from './tile-decoder.js';
import { isBedTileId } from './data/beds.js';

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
      this._visibleMask = null;
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

        const trig = this._triggerMap.get(`${nx},${ny}`);
        // v1.7.951 — EVENT tiles ($60-$63, trigger type 0) must not stop this
        // walk. They carry collision bit $80, so the `coll & 0x80` test below
        // treated them as walls. Since v1.7.944 made them PASSABLE, the player
        // could walk through one into the rest of a town while this room-bounds
        // walk still stopped dead at it — so the clip rectangle covered only the
        // entry area and everything beyond it was never drawn. You walked into
        // blackness. That is the "map is in pieces" report, and it hit every one
        // of the 30 maps that event fix opened, towns included.
        //
        // This walk MUST agree with `isPassable`. Where they disagree, the
        // player can reach tiles the renderer refuses to paint.
        const isEventTile = trig && trig.type === 0;
        if (!isEventTile) {
          if ((coll & 0x07) === 3) continue;
          if (coll & 0x80) continue;
        }
        // Doors still stop the walk on purpose: the clip must not bleed into
        // the next room through a doorway.
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

    let left = minX;
    let right = maxX + 1;
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
      this._visibleMask = null;   // outdoor / full-map: draw everything
      return;
    }

    // v1.7.953 — trim edges that show ANOTHER room's floor.
    //
    // The bounding box of the player's room, plus the wall/overhang
    // extensions above, can enclose part of a neighbouring room on a shared
    // tilemap. The player then sees a strip of somewhere else hanging off
    // their room — reported as "the inn had trailing tiles outside the rooms".
    // Kazus's inn (map 17) is the clearest case: the room is rows 0-6 and the
    // clip reached row 10, dragging in three rows of a different room's floor
    // and its door.
    //
    // `visited` is Phase 1's flood of the player's own room, so any WALKABLE
    // tile inside the clip that isn't in it belongs to someone else. Peel whole
    // rows/columns off each edge while they contain such a tile. Walls and fill
    // are left alone — those are the room's own border and must keep drawing.
    // BOTH sides of this test must come from the SAME walkability rule, and it
    // must be the one the player obeys. Phase 1's `visited` uses its own rules
    // (it stops at doors), so mixing it with `isPassable` gave a set that
    // matched neither: the trim silently did nothing on the maps that needed it
    // and ate real room on the maps that didn't. Flood once, here, with the
    // real `isPassable` — every field it reads is assigned before this runs.
    // Flood carrying the z-level per node. Reachability genuinely depends on
    // which level you arrive at — the same tile can be enterable from z=1 and
    // blocked from z=2 — so the search state is (x, y, z), not (x, y). With the
    // old mutating `isPassable` this was impossible to express, which is why
    // two floods in different orders disagreed.
    const startZ = this._playerZ;
    const roomSet = new Set([startY * MAP_SIZE + startX]);
    {
      const seenState = new Set([(startY * MAP_SIZE + startX) * 4 + startZ]);
      const fq = [[startX, startY, startZ]];
      while (fq.length) {
        const [cx, cy, cz] = fq.pop();
        for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || nx >= MAP_SIZE || ny < 0 || ny >= MAP_SIZE) continue;
          if (!this.isPassable(nx, ny, cz)) continue;
          const nz = this.zAfterEntering(nx, ny, cz);
          const st = (ny * MAP_SIZE + nx) * 4 + nz;
          if (seenState.has(st)) continue;
          seenState.add(st);
          roomSet.add(ny * MAP_SIZE + nx);
          fq.push([nx, ny, nz]);
        }
      }
    }
    const foreignAt = (x, y) => !roomSet.has(y * MAP_SIZE + x) && this.isPassable(x, y);
    // Only peel an edge that is ENTIRELY outside the player's room and shows
    // another room's floor. An edge still containing the room's own tiles must
    // stay — trimming on "contains any foreign tile" ate real room on 10 maps
    // (map 171 lost 116 of its 122 walkable tiles) and put the player back in
    // un-drawn space, which is the bug this whole area exists to prevent.
    // Clamp to the player's OWN room, plus one tile for its walls.
    //
    // Peeling edges "while the edge looks foreign" does not work: it stops at
    // the first pure-wall row, so on map 17 (Kazus's inn) it never reached the
    // inn's floor at all. The player's room there is the small area at the
    // BOTTOM — entrance (3,8) — and the inn above it belongs to another map id
    // on the same tilemap. Clamping to the room's bounding box removes it in
    // one step and cannot cut into the room, so the "draw everywhere you can
    // walk" invariant still holds.
    let rminX = MAP_SIZE, rmaxX = -1, rminY = MAP_SIZE, rmaxY = -1;
    for (const k of roomSet) {
      const x = k % MAP_SIZE, y = (k - x) / MAP_SIZE;
      if (x < rminX) rminX = x;
      if (x > rmaxX) rmaxX = x;
      if (y < rminY) rminY = y;
      if (y > rmaxY) rmaxY = y;
    }
    // v1.7.955 — the rect is now simply the MASK's bounding box. It used to be
    // derived from Phase 1's walk and merely clamped toward the room, which can
    // only ever shrink: once the z-aware flood found map 146's real 200-tile
    // room, the old rect was too SMALL and 80 walkable tiles fell outside the
    // drawn area. The mask decides what is painted; the rect only has to
    // contain it.
    // v1.7.956 — UNION, never intersection.
    //
    // Clamping the rect down to the walkable room cut a town's scenery: a
    // town's buildings, trees and decoration sit OUTSIDE the walkable tiles and
    // are most of the picture. Kazus rendered as scattered fragments. So the
    // rect is now the union of Phase 1's box (which towns have looked right
    // under for months) and the z-aware room's box — it can only ever grow.
    //
    // Drawing a little extra is a cosmetic flaw. Drawing too little deletes the
    // town. When the two disagree, err toward drawing more.
    if (rmaxX >= 0) {
      top    = Math.min(top,    Math.max(0, rminY - 1));
      bottom = Math.max(bottom, Math.min(MAP_SIZE, rmaxY + 2));
      left   = Math.min(left,   Math.max(0, rminX - 1));
      right  = Math.max(right,  Math.min(MAP_SIZE, rmaxX + 2));
    }
    let l = left, r = right;

    // Per-tile visibility mask: the room's own tiles plus exactly one ring of
    // neighbours (its walls). A RECTANGLE cannot express this. Map 17's room is
    // rows 6-10, but rows 9-10 are a ONE-TILE-WIDE exit column at x=3 — the
    // rectangle painted a full-width wall band across both, which is the "extra
    // bottom row". Dilating the room by one tile gives the wall ring and
    // nothing else, so no row is missing at the top and none is spare at the
    // bottom. `prerenderFullMap` skips every tile the mask clears.
    // Room + its WALL BAND, up to 2 tiles thick.
    //
    // A 1-tile dilation (v1.7.954/957) shaved the outer wall off these rooms —
    // their wall bands are two tiles thick — which looked worse than the
    // trailing tiles it replaced. An UNBOUNDED wall flood is no good either:
    // walls are contiguous between rooms in a building, so it wraps around the
    // neighbour (map 17 reached row 0; map 2 grew from 70 tiles to 144).
    // Bounded expansion through wall only, stopping at void and at another
    // room's floor, is what actually traces one room.
    const WALL_BAND = 2;
    const mask = new Uint8Array(MAP_SIZE * MAP_SIZE);
    {
      const anyPass = (x, y) => this.isPassable(x, y, 0) || this.isPassable(x, y, 1) || this.isPassable(x, y, 2);
      const wq = [];
      for (const k of roomSet) { mask[k] = 1; wq.push([k % MAP_SIZE, (k - (k % MAP_SIZE)) / MAP_SIZE, 0]); }
      let head = 0;
      while (head < wq.length) {
        const [x, y, d] = wq[head++];
        if (d >= WALL_BAND) continue;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= MAP_SIZE || ny < 0 || ny >= MAP_SIZE) continue;
            const k = ny * MAP_SIZE + nx;
            if (mask[k]) continue;
            if (tilemap[k] === fillTile) continue;   // void — stop
            if (anyPass(nx, ny)) continue;           // another room's floor — stop
            mask[k] = 1; wq.push([nx, ny, d + 1]);
          }
        }
      }
    }
    // v1.7.957 — the mask applies ONLY to small enclosed building interiors.
    //
    // Applying it everywhere is what tore Kazus apart: a town's buildings,
    // trees and scenery sit OUTSIDE the walkable tiles and are most of the
    // picture, so masking to "walkable + one ring" deletes the town. The fix is
    // not a better mask, it is knowing which maps are rooms. Three conditions,
    // all of which a town fails:
    //
    //   1. The fill tile is NOT walkable — interiors sit in void; a town's fill
    //      is ground or hedge you can see past.
    //   2. The player's room is SMALL (<= 60 tiles). Kazus's village room is
    //      145, Ur's 291, the castle's 240.
    //   3. The room is a minority of the map's walkable tiles (< 50%), i.e. the
    //      tilemap really does hold other rooms. Towns and caves run 0.85-0.98;
    //      the inn is 0.22.
    //
    // Measured verdicts: inn (17) 13 tiles / 0.22 -> masked. Village (164) 145
    // / 0.38, castle (18) 240 / 0.52, Ur (114) 291 / 0.88, mountain town (10)
    // 196 / 0.94, Altar Cave (111) 0.85 -> all UNMASKED.
    const fillM = fillTile < 128 ? fillTile : fillTile & 0x7F;
    const fillColl = collision[fillM];
    const fillIsVoid = (fillColl & 0x07) === 3 || (fillColl & 0x80) !== 0;
    let totalWalkable = 0;
    for (let y = 0; y < MAP_SIZE; y++) {
      for (let x = 0; x < MAP_SIZE; x++) {
        if (this.isPassable(x, y, 0) || this.isPassable(x, y, 1) || this.isPassable(x, y, 2)) totalWalkable++;
      }
    }
    const roomFraction = totalWalkable ? roomSet.size / totalWalkable : 1;
    const isEnclosedRoom = fillIsVoid && roomSet.size <= 60 && roomFraction < 0.5;
    // v1.7.958 — MASK OFF EVERYWHERE. Third attempt, third regression.
    //
    // Restricting it to enclosed rooms stopped it deleting towns, but the mask
    // itself is still wrong for a room: it is the walkable area dilated by ONE
    // tile, and these rooms have wall bands TWO tiles thick. So it shaved the
    // outer wall off the inn and made it look worse than the trailing tiles it
    // was meant to fix.
    //
    // The rectangular clip has shipped for months and its only known flaw is a
    // strip of a neighbouring room on shared tilemaps. That is a cosmetic flaw.
    // Every mask attempt has produced a WORSE, more visible one. Not shipping a
    // fourth guess at this: it needs a definition of the room's true extent
    // (its full wall band, not a 1-tile dilation), which I do not have yet.
    this._visibleMask = isEnclosedRoom ? mask : null;

    this._roomClip = {
      x: l * TILE_SIZE,
      y: top * TILE_SIZE,
      w: (r - l) * TILE_SIZE,
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
        // v1.7.954 — skip tiles outside the room's own wall ring. Leaving them
        // transparent lets draw()'s fill-tile background show through, which is
        // what the player should see beyond their room.
        if (this._visibleMask && !this._visibleMask[ty * MAP_SIZE + tx]) continue;
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

  // v1.7.454 — patch a single 16×16 metatile in the pre-rendered canvases
  // after a tile mutation (chest opened, secret wall revealed, rock-puzzle
  // wall dropped). Pre-fix, every mutation rebuilt the entire MapRenderer
  // — `prerenderFullMap` iterates 32×32 metatiles + two priority overlays
  // synchronously, which produced a visible ~50–200 ms screen flicker on
  // mobile. This method only repaints the changed tile.
  redrawMetatileAt(tx, ty) {
    if (tx < 0 || tx >= MAP_SIZE || ty < 0 || ty >= MAP_SIZE) return;
    if (!this._mapCanvas) return;
    const { chrTiles, metatiles, palettes, tileAttrs, tilemap, collision } = this.mapData;
    const mid = tilemap[ty * MAP_SIZE + tx];
    const m = mid < 128 ? mid : mid & 0x7F;
    const meta = metatiles[m];
    if (!meta) return;
    const palIdx = tileAttrs[m] & 0x03;
    const pal = palettes[palIdx];
    const rgbPal = pal.map(nesIdx => NES_SYSTEM_PALETTE[nesIdx & 0x3F] || [0, 0, 0]);
    const chrIndices = [meta.tl, meta.tr, meta.bl, meta.br];
    const offsets = [[0, 0], [8, 0], [0, 8], [8, 8]];
    const props = collision[m];

    const baseX = tx * TILE_SIZE;
    const baseY = ty * TILE_SIZE;

    // Map canvas — opaque repaint (no clear needed; we overwrite every pixel).
    const mctx = this._mapCanvas.getContext('2d');
    const mImg = mctx.createImageData(8, 8);
    const mData = mImg.data;
    for (let q = 0; q < 4; q++) {
      const tile = chrTiles[chrIndices[q]];
      if (!tile) continue;
      for (let py = 0; py < 8; py++) {
        for (let px = 0; px < 8; px++) {
          const ci = tile[py * 8 + px];
          const rgb = rgbPal[ci];
          const di = (py * 8 + px) * 4;
          mData[di] = rgb[0]; mData[di + 1] = rgb[1]; mData[di + 2] = rgb[2]; mData[di + 3] = 255;
        }
      }
      mctx.putImageData(mImg, baseX + offsets[q][0], baseY + offsets[q][1]);
    }

    // Overlay canvases — transparent for empty pixels. Clear first since
    // the previous tile may have had foreground tiles that the new one
    // doesn't.
    for (const { canvas, bitMask } of [
      { canvas: this._overlayU, bitMask: 0x20 },
      { canvas: this._overlayL, bitMask: 0x10 },
    ]) {
      if (!canvas) continue;
      const octx = canvas.getContext('2d');
      octx.clearRect(baseX, baseY, TILE_SIZE, TILE_SIZE);
      if (!(props & bitMask)) continue;
      const oImg = octx.createImageData(8, 8);
      const oData = oImg.data;
      for (let q = 0; q < 4; q++) {
        const tile = chrTiles[chrIndices[q]];
        if (!tile) continue;
        for (let py = 0; py < 8; py++) {
          for (let px = 0; px < 8; px++) {
            const ci = tile[py * 8 + px];
            const di = (py * 8 + px) * 4;
            if (ci === 0) {
              oData[di] = 0; oData[di + 1] = 0; oData[di + 2] = 0; oData[di + 3] = 0;
            } else {
              const rgb = rgbPal[ci];
              oData[di] = rgb[0]; oData[di + 1] = rgb[1]; oData[di + 2] = rgb[2]; oData[di + 3] = 255;
            }
          }
        }
        octx.putImageData(oImg, baseX + offsets[q][0], baseY + offsets[q][1]);
      }
    }
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
      try {
        ctx.beginPath();
        ctx.rect(rc.x - worldLeft, rc.y - worldTop, rc.w, rc.h);
        ctx.clip();
        ctx.drawImage(this._mapCanvas, -worldLeft, -worldTop);
      } finally {
        ctx.restore();
      }
    } else {
      ctx.drawImage(this._mapCanvas, -worldLeft, -worldTop);
    }
  }

  drawOverlay(ctx, cameraX, cameraY, originX, originY, spriteX, spriteY) {
    const worldLeft = cameraX - originX;
    const worldTop = cameraY - originY;

    // u bit (0x20): overlay clips to sprite's bottom 8px
    ctx.save();
    try {
      ctx.beginPath();
      ctx.rect(spriteX, spriteY + 8, 16, 8);
      ctx.clip();
      ctx.drawImage(this._overlayU, -worldLeft, -worldTop);
    } finally {
      ctx.restore();
    }

    // l bit (0x10): overlay clips to sprite's top 8px
    ctx.save();
    try {
      ctx.beginPath();
      ctx.rect(spriteX, spriteY, 16, 8);
      ctx.clip();
      ctx.drawImage(this._overlayL, -worldLeft, -worldTop);
    } finally {
      ctx.restore();
    }
  }

  // True if the metatile at (tileX, tileY) is a bed tile for this map's
  // tileset (data/beds.js). Drives both walk-on collision and the rest trigger.
  isBedTileAt(tileX, tileY) {
    if (tileX < 0 || tileX >= MAP_SIZE || tileY < 0 || tileY >= MAP_SIZE) return false;
    const id = this.mapData.tilemap[tileY * MAP_SIZE + tileX] & 0x7F;
    return isBedTileId(this.mapData.tileset, id);
  }

  /**
   * Can the player stand on (tileX, tileY) while on z-level `z`?
   * PURE — no state is written. Pass an explicit `z` to reason about a
   * hypothetical position (map tools do); omit it for the live player.
   */
  isPassable(tileX, tileY, z = this._playerZ) {
    if (tileX < 0 || tileX >= MAP_SIZE || tileY < 0 || tileY >= MAP_SIZE) {
      return false;
    }

    // Entrance tile is always passable (allows walking back to exit)
    if (tileX === this.mapData.entranceX && tileY === this.mapData.entranceY) {
      return true;
    }

    // Bed tiles are walk-on rest spots (bed.js owns the scene). Pass over their
    // default collision so you can step fully onto a bed; the step-on trigger
    // in map-triggers.js then opens the rest scene.
    if (this.isBedTileAt(tileX, tileY)) return true;

    // Check dynamic trigger map first — entrance tiles are passable
    const key = `${tileX},${tileY}`;
    const trig = this._triggerMap.get(key);
    if (trig) {
      if (trig.type === 1 || trig.type === 4) return true; // entrance/door/passage — passable
      // v1.7.944 — EVENT tiles ($60-$63, TRIGGER_TYPE_TABLE type 0) are
      // PASSABLE. The player's own tile dispatch says so: byte2 high nibble $F
      // routes to 3F/$E6BE, which runs the event and exits via
      // `LDA $2D / LSR A / BCC $E714`, and $E714 is a bare RTS reached with
      // carry CLEAR — carry clear is "move allowed", exactly like the type-0
      // handler at $E689 (`LDA #$40 / STA $AB / CLC / RTS`).
      //
      // Treating them as walls sealed off most of several towns, because these
      // tiles sit in doorways. Measured across all 256 maps: 30 maps gain
      // reachable area, map 10 goes 31 -> 196 tiles (the whole town was behind
      // ONE event tile at (8,28), with plain floor either side), map 31
      // 200 -> 493, map 55 54 -> 293, map 43 2 -> 146.
      //
      // The stale comment below cited 3B/90EB and 3B/B0C5 as proof the ROM
      // blocks these. Those are the NPC/entity collision routines, not the
      // player's — the same misreading that produced the reverted v1.7.907.
      if (trig.type === 0) return true;
      //
      // Treasure ($78-$7C) stays blocked: the player walks UP to a chest and
      // opens it, never stands on it.
      // v1.7.906 — "blocked for now" was right, and it is not provisional.
      // Events ($60-$63) and treasure ($78-$7C) carry collision bit 7 in ALL 7
      // tilesets (119/119 trigger tiles do), so the ROM blocks every one of them
      // and fires the trigger on the ATTEMPT to enter. Blocking here matches the
      // ROM exactly. Re-derive with:
      //   node tools/dis6502.mjs --bytes 3A 93C1 128
      // The rewrite the ROM does (tile -> instance slot, base table 3A/923F,
      // source table 3A/93C1) clones each instance from its OWN original
      // metatile, so instance collision === collision[original id]. That is why
      // reading `collision[$60]` directly, as we do, gives the same answer.
      return false;
    }

    const metatileId = this.mapData.tilemap[tileY * MAP_SIZE + tileX];
    const m = metatileId < 128 ? metatileId : metatileId & 0x7F;
    const collByte = this.mapData.collision[m];

    // Bit 7 = collision-based trigger tile
    //
    // v1.7.905 — this is a DELIBERATE divergence from the ROM, now confirmed
    // rather than assumed. Both ROM collision routines (3B/90EB and the
    // 3B/B0C5 one cited below) open with `LDA $0400,Y / BMI blocked`: bit 7
    // set means BLOCKED, full stop, and the trigger type is never inspected.
    // The ROM fires a trigger on the ATTEMPT to enter, so the player never
    // stands on a door tile.
    //
    // We let the player stand on the tile and fire the trigger from there, so
    // some types have to be passable. Verify with:
    //   node tools/dis6502.mjs 3B 90E0 22
    //
    // The consequence is real and unfixed: type 1 is solid here, and type-1
    // tiles sit at the entrances of maps 43, 96, 124 and 167, which
    // `tools/map-explorable.mjs` flags as having no exit from spawn. Moving to
    // the ROM's fire-on-attempt model is the actual fix; widening this list is
    // not, because then the player stands inside doorways.
    if (collByte & 0x80) {
      const b2 = this._collisionByte2[metatileId];
      const trigType = (b2 >> 4) & 0x0F;
      // exit_prev (0) and entrance/door (4,5) are passable
      if (trigType === 0 || trigType === 4 || trigType === 5) return true;
      return false;
    }

    // Z-level passability (matches NPC check at 3B/B0C5).
    //
    // v1.7.955 — PURE. This used to MUTATE `this._playerZ` as a side effect of
    // asking "can I stand here", which made the answer depend on the order the
    // question was asked. Two floods over the same map in different orders
    // walked different z-levels and disagreed — that is what left 13 maps
    // measuring as drawing another room's floor, and it forced an exemption in
    // `check-room-clip.mjs`. The z now comes in as an argument and the new z
    // goes out through `zAfterEntering`; only `commitZ` writes state.
    const lower3 = collByte & 0x07;
    if (lower3 === 0) return true;        // flat ground — always fine
    if (lower3 >= 4) return true;         // bridge — passable, z unchanged
    if (lower3 === 3) return false;       // both z-bits — solid
    return (lower3 | z) !== 3;            // z conflict blocks
  }

  /**
   * The z-level the player would be on after entering (tileX, tileY) from `z`.
   * Mirrors `isPassable`'s rules exactly; returns `z` unchanged when the tile
   * doesn't move the player between levels.
   */
  zAfterEntering(tileX, tileY, z = this._playerZ) {
    if (tileX < 0 || tileX >= MAP_SIZE || tileY < 0 || tileY >= MAP_SIZE) return z;
    const metatileId = this.mapData.tilemap[tileY * MAP_SIZE + tileX];
    const m = metatileId < 128 ? metatileId : metatileId & 0x7F;
    const collByte = this.mapData.collision[m];
    if (collByte & 0x80) return z;        // trigger tiles don't change level
    const lower3 = collByte & 0x07;
    if (lower3 === 0) return 0;           // flat ground resets to level 0
    if (lower3 >= 4) return z;            // bridge keeps the current level
    if (lower3 === 3) return z;           // solid — never entered
    const combined = lower3 | z;
    return combined === 3 ? z : combined;
  }

  /** Commit the player's z after an accepted move. The ONLY writer of state. */
  commitZ(tileX, tileY) {
    this._playerZ = this.zAfterEntering(tileX, tileY);
    return this._playerZ;
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
