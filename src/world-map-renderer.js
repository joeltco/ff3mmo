// World Map Renderer — viewport-based rendering for 128x128 world maps

import { NES_SYSTEM_PALETTE, buildWaterFrames, decodeTile, drawTile } from './tile-decoder.js';
import { BOULDER_TILES, BOULDER_PAL } from './data/boulder-sprite.js';

const TILE_SIZE = 16;

// The boulder blocks the ONE tile that leads to the ocean — the neck of the
// southern coastal peninsula. Both the collision (isPassable) and the overlay
// sprite (drawOverlay) key off these.
//
// v1.7.925 — measured, not guessed. `tools/world-choke.mjs --ocean` classifies
// every world metatile that the renderer animates (CHR $22-$27) as water,
// collects the reachable land tiles that touch it, then blocks each candidate
// tile in turn and re-floods with this very `isPassable`. The pass to the coast
// is a 5-tile dogleg — (79,56) → (79,55) → (79,54) → (80,54) → (81,54) — and
// blocking ANY ONE of them takes the reachable coastline from 52 tiles to ZERO.
// They differ only in how much of the pass itself stays walkable.
//
// v1.7.926 — moved to the north-east end of that dogleg, per Joel. (81,54) sits
// one tile west of the (82,54) warp, so the boulder reads as the thing closing
// the gap rather than as scenery sitting in the middle of a corridor.
//
// Do NOT move this to (95,44). That tile is the neck of Ur's OWN valley:
// blocking it also zeroes the coast, but it costs 399 tiles and every entrance
// except Ur's, which is the v1.7.505 gate that v1.7.903 was right to lift.
const CHOKE_TILE_X = 81;
const CHOKE_TILE_Y = 54;

// World-map entrances that are switched off. `getTriggerAt` returns null for
// these, so the tile is ordinary ground — the player walks over it and nothing
// happens. That is deliberately NOT the "The way is barred." refusal in
// map-triggers.js: a refusal tells the player there is a door here and they may
// not use it, and these are doors that should not appear to exist at all.
//
// Keyed by DESTINATION map, not by coordinate, so an entrance that the ROM
// places at more than one tile goes away everywhere at once.
//
//   95 — the Invincible. Reported by Joel as a warp straight to the airship,
//        sitting at (82,54), one tile east of the choke boulder. v1.7.926.
//  180 — the ship, at (90,59). Same class as the Invincible: rendering map 180
//        (tools/map-png.mjs) shows a wooden vessel on open water with a shop
//        counter, barrels, a bed and a below-decks section — a VEHICLE
//        interior, not a dungeon. It has no reachable exit because you are
//        meant to leave it by disembarking, and there is no vehicle system yet.
//        Confirmed not an event problem: every event script on the map decodes
//        with no map transition (tools/event-resolve.mjs). v1.7.949.
// Movement-mode passability masks — the ROM's own table at $C6CD, read off the
// cartridge, not inferred. A tile blocks a mode iff EVERY bit of that mode's
// mask is set in the tile's `byte1` (`AND mask ; CMP mask` at $C6B0).
//
//   0        on foot          land + forest
//   1        bit0+bit1        land + forest + shallow water
//   2        bit1             shallow water only
//   3        bit2             ocean only
//   4-7      bit4             everything except the bit-4 barrier tiles (flying)
//
// ⛔ bit 3 is NEVER tested by this routine even though most tiles carry it, and
// bit 4 is the flight barrier — it is outside the low nibble and easy to miss.
const WORLD_MODE_MASKS = [0x01, 0x03, 0x02, 0x04, 0x10, 0x10, 0x10, 0x10];
const MODE_ON_FOOT = 0;
const FIRST_FLYING_MODE = 4;

/**
 * Passability for a movement mode, mirroring the ROM routine at $C69B:
 *
 *     C69F  ASL A           ; tile props are interleaved PAIRS
 *     C6A1  LDA $0400,X     ; byte1 (props table, copied to RAM at map load)
 *     C6AB  LDY $42         ; the movement mode
 *     C6AD  LDA $C6CD,Y     ; mask table
 *     C6B0  AND $44
 *     C6B2  CMP $C6CD,Y     ; blocked iff EVERY mask bit is set
 *
 * Proven by patching that table and watching reachability change — see
 * `tools/monscan/mask-table-proof.cjs` and docs/VEHICLE-SYSTEM-PLAN.md §10.
 *
 * Module-level and pure so tools can borrow `isPassable` off the prototype
 * with only `{ data }` bound.
 */
function passableForMode(data, tileX, tileY, mode) {
  const size = data.mapWidth;
  const wx = ((tileX % size) + size) % size;
  const wy = ((tileY % size) + size) % size;

  // Choke boulder south of Ur — hard-blocked regardless of terrain prop.
  if (wx === CHOKE_TILE_X && wy === CHOKE_TILE_Y) return false;

  const props = data.tileProps[data.tilemap[wy * size + wx] & 0x7F];
  let byte1 = props.byte1;

  // $C6B9: a FLYING mode clears the trigger bit, so an airship cannot walk into
  // a town. On foot and in the boats the bit stands.
  if (mode >= FIRST_FLYING_MODE) byte1 &= 0x7F;

  // Trigger tiles are always passable (walk onto to enter)
  if (byte1 & 0x80) return true;

  const mask = WORLD_MODE_MASKS[mode] ?? WORLD_MODE_MASKS[MODE_ON_FOOT];
  return (byte1 & mask) !== mask;
}

const REMOVED_ENTRANCES = new Set([95, 180]);
export class WorldMapRenderer {
  constructor(worldMapData) {
    this.data = worldMapData;
    this._buildMetatileAtlas();
    this._initWaterAnimation();
  }

  /**
   * Atlas of ONLY the metatiles the ROM marks with a priority bit, rendered
   * with color index 0 transparent so the terrain and the player show through.
   *
   * The interior renderer (map-renderer.js) prerenders two FULL-MAP overlay
   * canvases for this. That is fine at 32x32 tiles (512x512px); on the 128x128
   * world map it would be two 2048x2048 buffers — ~33MB, which is exactly the
   * class of boot allocation that was OOM-killing low-memory Android devices.
   * Only ~30 of the 128 metatiles carry a priority bit, so a strip of just
   * those is a few KB, and `drawOverlay` redraws the handful that actually
   * overlap the player each frame.
   *
   * Built lazily on first use: a world with no priority tiles never pays.
   */
  _getPriorityAtlas() {
    if (this._prioAtlas !== undefined) return this._prioAtlas;
    const { metatiles, chrTiles, palettes, tileAttrs, tileProps } = this.data;

    const ids = [];
    for (let m = 0; m < 128; m++) {
      const pr = tileProps[m];
      if (pr && (pr.byte1 & 0x20)) ids.push(m);   // U only — see _drawPriorityTerrain
    }
    if (!ids.length) { this._prioAtlas = null; return null; }

    const slot = new Map();
    ids.forEach((m, i) => slot.set(m, i));
    const c = document.createElement('canvas');
    c.width = ids.length * TILE_SIZE;
    c.height = TILE_SIZE;
    const cx = c.getContext('2d');
    const img = cx.createImageData(8, 8);
    const data = img.data;
    const offsets = [[0, 0], [8, 0], [0, 8], [8, 8]];

    for (const m of ids) {
      const meta = metatiles[m];
      const rgbPal = palettes[tileAttrs[m] & 0x03]
        .map(nesIdx => NES_SYSTEM_PALETTE[nesIdx & 0x3F] || [0, 0, 0]);
      const chrIndices = [meta.tl, meta.tr, meta.bl, meta.br];
      for (let q = 0; q < 4; q++) {
        const tile = chrTiles[chrIndices[q]];
        if (!tile) continue;
        for (let py = 0; py < 8; py++) {
          for (let px = 0; px < 8; px++) {
            const ci = tile[py * 8 + px];
            const di = (py * 8 + px) * 4;
            if (ci === 0) {
              // Transparent — this is what makes it an OVERLAY rather than a
              // solid block painted over the player.
              data[di] = 0; data[di + 1] = 0; data[di + 2] = 0; data[di + 3] = 0;
            } else {
              const rgb = rgbPal[ci];
              data[di] = rgb[0]; data[di + 1] = rgb[1]; data[di + 2] = rgb[2]; data[di + 3] = 255;
            }
          }
        }
        cx.putImageData(img, slot.get(m) * TILE_SIZE + offsets[q][0], offsets[q][1]);
      }
    }
    this._prioAtlas = { canvas: c, slot };
    return this._prioAtlas;
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

  // Lazily decode the 4 captured boulder tiles into a 16×16 offscreen canvas
  // (color 0 = transparent so terrain shows through). Built once.
  _getBoulderCanvas() {
    if (this._boulderCanvas) return this._boulderCanvas;
    const c = document.createElement('canvas');
    c.width = TILE_SIZE; c.height = TILE_SIZE;
    const cx = c.getContext('2d');
    const off = [[0, 0], [8, 0], [0, 8], [8, 8]]; // TL, TR, BL, BR
    for (let i = 0; i < BOULDER_TILES.length; i++) {
      drawTile(cx, decodeTile(BOULDER_TILES[i]), BOULDER_PAL, off[i][0], off[i][1]);
    }
    this._boulderCanvas = c;
    return c;
  }

  /**
   * Priority (foreground) terrain — the ROM's own occlusion bits, ported from
   * the interior renderer which has had this since forever. Trees are metatile
   * $64 (byte1 $2F, U bit set, 520 tiles on the overworld); the player walks
   * BEHIND the canopy instead of on top of it.
   *
   *   0x20 "U" -> the tile redraws over the sprite's BOTTOM 8px
   *   0x10 "L" -> the tile redraws over the sprite's TOP 8px
   *
   * Only tiles overlapping the sprite's own 16x16 box can occlude it, so this
   * walks at most 4 tiles per frame rather than the visible viewport.
   */
  _drawPriorityTerrain(ctx, worldLeft, worldTop, spriteX, spriteY) {
    const prio = this._getPriorityAtlas();
    if (!prio) return;
    const size = this.data.mapWidth;
    const { tilemap, tileProps } = this.data;

    const x0 = Math.floor((worldLeft + spriteX) / TILE_SIZE);
    const x1 = Math.floor((worldLeft + spriteX + TILE_SIZE - 1) / TILE_SIZE);
    const y0 = Math.floor((worldTop + spriteY) / TILE_SIZE);
    const y1 = Math.floor((worldTop + spriteY + TILE_SIZE - 1) / TILE_SIZE);

    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const wx = ((tx % size) + size) % size;
        const wy = ((ty % size) + size) % size;
        const m = tilemap[wy * size + wx] & 0x7F;
        const pr = tileProps[m];
        // U ONLY. The L bit ("redraw over the sprite's TOP 8px") has produced
        // two reported bugs on the overworld and not one confirmed correct
        // frame: mountains cut the player's head off from the row above
        // (v1.7.967), and the Altar Cave mouth — an L tile you STAND on when
        // you step out — cut it off again even after that fix restricted L to
        // the tile underfoot. Overworld terrain that should hide the player
        // hides the LOWER half: tree canopy, which is the U bit and is
        // unaffected. If a future overworld tile genuinely needs to cover the
        // head, it needs a verified frame from the real ROM first.
        if (!pr || !(pr.byte1 & 0x20)) continue;
        // The L bit covers the sprite's HEAD, which is only ever right when the
        // player is standing on the tile — walking under a castle arch. The
        // overworld mountains ($05-$07, $15-$17, $26) also carry L and are
        // foot-blocked (byte1 & 0x01), so you can never be behind one: applying
        // it to a neighbour meant a mountain redrew over the player's head
        // whenever they walked past underneath it. Reported as "top of the
        // player sprite is getting cut off when walking below overworld
        // mountains". The U bit is unrestricted — that is the tree canopy the
        // player walks behind.
        const sx = prio.slot.get(m);
        if (sx === undefined) continue;
        // U clips to the sprite's lower half, L to its upper half.
        const clipY = spriteY + 8;      // U: the sprite's lower half
        ctx.save();
        try {
          ctx.beginPath();
          ctx.rect(spriteX, clipY, TILE_SIZE, 8);
          ctx.clip();
          ctx.drawImage(prio.canvas,
            sx * TILE_SIZE, 0, TILE_SIZE, TILE_SIZE,
            tx * TILE_SIZE - worldLeft, ty * TILE_SIZE - worldTop, TILE_SIZE, TILE_SIZE);
        } finally {
          ctx.restore();
        }
      }
    }
  }

  drawOverlay(ctx, cameraX, cameraY, originX, originY, spriteX, spriteY) {
    // Draw the choke boulder when it's in view. Mirrors the draw() tile-range
    // walk so map wrapping is handled identically; runs after the player
    // sprite, so the boulder reads as a solid foreground.
    const size = this.data.mapWidth;
    const worldLeft = cameraX - originX;
    const worldTop = cameraY - originY;
    const startTX = Math.floor(worldLeft / TILE_SIZE);
    const startTY = Math.floor(worldTop / TILE_SIZE);
    const endTX = startTX + Math.ceil(ctx.canvas.width / TILE_SIZE) + 1;
    const endTY = startTY + Math.ceil(ctx.canvas.height / TILE_SIZE) + 1;
    for (let ty = startTY; ty <= endTY; ty++) {
      if ((((ty % size) + size) % size) !== CHOKE_TILE_Y) continue;
      for (let tx = startTX; tx <= endTX; tx++) {
        if ((((tx % size) + size) % size) !== CHOKE_TILE_X) continue;
        ctx.drawImage(this._getBoulderCanvas(), tx * TILE_SIZE - worldLeft, ty * TILE_SIZE - worldTop);
      }
    }

    // Terrain that draws in FRONT of the player. `render.js#_drawOverlay`
    // passes the sprite box; older callers may not, so skip rather than throw.
    if (spriteX != null && spriteY != null) {
      this._drawPriorityTerrain(ctx, worldLeft, worldTop, spriteX, spriteY);
    }
  }

  isPassable(tileX, tileY) {
    // Delegates to a MODULE-LEVEL function, not `this.isPassableForMode`.
    // Several tools borrow this method through the prototype on a bare
    // `{ data }` object to avoid the canvas-building constructor, so anything
    // reached via `this` other than `data` breaks them — check-encounter-zones
    // failed exactly that way.
    return passableForMode(this.data, tileX, tileY, MODE_ON_FOOT);
  }

  /**
   * Passability for a given MOVEMENT MODE, mirroring the ROM routine at $C69B.
   *
   * The NES does exactly this (fixed bank):
   *
   *     C69D  LDA ($80),Y     ; metatile id
   *     C69F  ASL A           ; *2 — tile props are interleaved PAIRS
   *     C6A1  LDA $0400,X     ; byte1  (the props table, copied to RAM at load)
   *     C6AB  LDY $42         ; the movement mode
   *     C6AD  LDA $C6CD,Y     ; mask table
   *     C6B0  AND $44
   *     C6B2  CMP $C6CD,Y     ; blocked iff EVERY mask bit is set
   *
   * Proven by patching the table and watching reachability change — stock
   * `mask[0] = $01` never lets a walker stand on water, `$80` lets the same
   * walker cross water and mountains, `$00` freezes it. See
   * `tools/monscan/mask-table-proof.cjs` and docs/VEHICLE-SYSTEM-PLAN.md §10.
   *
   * NOT wired to anything yet: `isPassable` still asks for MODE_ON_FOOT, so
   * behaviour is unchanged. `tools/check-world-passability.mjs` gates that.
   */
  isPassableForMode(tileX, tileY, mode) {
    return passableForMode(this.data, tileX, tileY, mode);
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
    if (REMOVED_ENTRANCES.has(destMap)) return null;

    return { type: 'entrance', trigId, destMap };
  }
}
