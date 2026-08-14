// Flame & star sprite systems — decode from ROM, render with map palettes
// Extracted from game.js to reduce file size.

import { NES_SYSTEM_PALETTE, decodeTile } from './tile-decoder.js';
import { _makeCanvas16, _makeCanvas16ctx } from './canvas-utils.js';

// --- Flame sprite decoding ---
// Two-frame sprite graphics bank $0A: file offset 0x14010
// NPC #193 (large torch): gfxByte=$40, offset 0x14010, 8 tiles (2 frames × 4)
// NPC #194 (small candle): gfxByte=$41, offset 0x14090, 8 tiles (2 frames × 4)
// Sprite palette 3: transparent, $0F(black), $27(orange), $30(white)
const FLAME_NPC_DEFS = [
  { id: 193, offset: 0x14010 },  // large torch flame
  { id: 194, offset: 0x14090 },  // small candle flame
  // Kazus's CAMPFIRE. Map 10 places object id 190 at (4,28) — the town's
  // south-west corner, where the tilemap is bare grass because the fire is a
  // sprite, not a tile. It draws the SAME graphics as the large torch:
  // MEASURED by standing next to it in the real game and reading OAM
  // (`WALK=left,left,left,up,up node tools/monscan/ghost-sprite.cjs 10`), whose
  // tiles trace to 0x14010/20/30/40 — frame 1 of id 193.
  //
  // Registered under its OWN id so `_renderFlameFrames` picks up id 190's
  // palette selector from the map rather than the torch's.
  { id: 190, offset: 0x14010 },  // campfire (Kazus SW corner)
];

let _flameRawTiles = null; // Map<npcId, [[tl,tr,bl,br], [tl,tr,bl,br]]> — raw decoded pixels
let _flameFrames = null;   // Map<npcId, [canvas, canvas]> — rendered with current map palette
let _flameSprites = [];    // [{npcId, px, py}] — active flame positions for current map

// --- Star sprite decoding ---
// Star sprites from ROM: 2x2 metatile (16x16) — two frames that alternate
// Frame A (0x014790): diamond star — rays up/down/left/right
// Frame B (0x0147C0): diagonal star — rays to corners (rotated 45°)
const STAR_FRAMES = [0x014790, 0x0147D0]; // each is 4 consecutive 8x8 tiles (TL, TR, BL, BR)
// Palette: 1=dark orange edge, 2=tan/warm yellow body, 3=white center
const STAR_PALETTE = [null, NES_SYSTEM_PALETTE[0x17], NES_SYSTEM_PALETTE[0x27], NES_SYSTEM_PALETTE[0x30]];

let _starTiles = null;     // [canvas, canvas, canvas] — 3 animation frames (8×8)

// Decode raw flame tile pixels once from ROM (no palette applied yet)
export function initFlameRawTiles(romData) {
  if (_flameRawTiles) return;
  _flameRawTiles = new Map();

  for (const { id, offset } of FLAME_NPC_DEFS) {
    const frames = [];
    for (let f = 0; f < 2; f++) {
      const tileOff = offset + f * 4 * 16;
      frames.push([
        decodeTile(romData, tileOff),
        decodeTile(romData, tileOff + 16),
        decodeTile(romData, tileOff + 32),
        decodeTile(romData, tileOff + 48),
      ]);
    }
    _flameRawTiles.set(id, frames);
  }
}

export function initStarTiles(romData) {
  if (_starTiles) return;
  _starTiles = [];
  for (const baseOffset of STAR_FRAMES) {
    const [c, cctx] = _makeCanvas16ctx();
    // 4 tiles: TL(+0), TR(+16), BL(+32), BR(+48)
    const positions = [[0, 0], [8, 0], [0, 8], [8, 8]];
    for (let t = 0; t < 4; t++) {
      const pixels = decodeTile(romData, baseOffset + t * 16);
      const img = cctx.createImageData(8, 8);
      for (let i = 0; i < 64; i++) {
        const ci = pixels[i];
        if (ci === 0) { img.data[i * 4 + 3] = 0; continue; }
        const rgb = STAR_PALETTE[ci];
        img.data[i * 4] = rgb[0];
        img.data[i * 4 + 1] = rgb[1];
        img.data[i * 4 + 2] = rgb[2];
        img.data[i * 4 + 3] = 255;
      }
      cctx.putImageData(img, positions[t][0], positions[t][1]);
    }
    _starTiles.push(c);
  }
}

// Render flame frame canvases using the current map's actual sprite palettes
function _buildNpcPalIdxMap(mapData) {
  const npcPalIdx = new Map();
  if (mapData.npcs) {
    for (const npc of mapData.npcs) {
      if (!_flameRawTiles.has(npc.id) || npcPalIdx.has(npc.id)) continue;
      npcPalIdx.set(npc.id, ((npc.flags >> 2) & 3) >= 2 ? 1 : 0);
    }
  }
  if (!npcPalIdx.has(193)) npcPalIdx.set(193, 0);
  if (!npcPalIdx.has(194)) npcPalIdx.set(194, 1);
  return npcPalIdx;
}

function _buildFlameCanvas(rawFrames, rgbPal) {
  const canvases = [];
  const offsets = [[0, 0], [8, 0], [0, 8], [8, 8]];
  for (const tiles of rawFrames) {
    const c = _makeCanvas16();
    const fctx = c.getContext('2d'); const img = fctx.createImageData(16, 16); const d = img.data;
    for (let q = 0; q < 4; q++) {
      const tile = tiles[q]; const [ox, oy] = offsets[q];
      for (let py = 0; py < 8; py++) {
        for (let px = 0; px < 8; px++) {
          const ci = tile[py * 8 + px]; const di = ((oy + py) * 16 + (ox + px)) * 4;
          if (ci === 0) { d[di + 3] = 0; }
          else { const rgb = rgbPal[ci]; d[di] = rgb[0]; d[di+1] = rgb[1]; d[di+2] = rgb[2]; d[di+3] = 255; }
        }
      }
    }
    fctx.putImageData(img, 0, 0); canvases.push(c);
  }
  return canvases;
}

function _renderFlameFrames(mapData) {
  if (!_flameRawTiles || !mapData || !mapData.spritePalettes) return;
  _flameFrames = new Map();
  const sp = mapData.spritePalettes;
  const npcPalIdx = _buildNpcPalIdxMap(mapData);
  for (const [id, rawFrames] of _flameRawTiles) {
    const rgbPal = sp[npcPalIdx.get(id) || 0].map(ci => NES_SYSTEM_PALETTE[ci & 0x3F]);
    _flameFrames.set(id, _buildFlameCanvas(rawFrames, rgbPal));
  }
}

// Tileset 5 background tiles that need flame overlays
const FLAME_TILE_MAP_TS5 = new Map([
  [0x02, 194],  // candle wall → small candle flame
  [0x31, 193],  // torch mount → large torch flame
  [0x32, 194],  // torch → small candle flame
]);

export function rebuildFlameSprites(mapData, mapRenderer, TILE_SIZE) {
  _flameSprites = [];
  if (!mapData || !_flameRawTiles) return;
  _renderFlameFrames(mapData);
  const rc = mapRenderer && mapRenderer.hasRoomClip() ? mapRenderer.getRoomClip() : null;
  const clipped = (px, py) =>
    rc && (px < rc.x || px >= rc.x + rc.w || py < rc.y || py >= rc.y + rc.h);

  // 1. Wall-mounted flames, from BACKGROUND TILES. Interiors only (tileset 5):
  //    a candle wall or torch mount is part of the room's art.
  const flameMap = mapData.tileset === 5 ? FLAME_TILE_MAP_TS5 : null;
  if (flameMap) {
    const { tilemap } = mapData;
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const npcId = flameMap.get(tilemap[y * 32 + x]);
        if (npcId === undefined) continue;
        const px = x * TILE_SIZE, py = y * TILE_SIZE;
        if (clipped(px, py)) continue;
        _flameSprites.push({ npcId, px, py });
      }
    }
  }

  // 2. Free-standing flames, from the map's OWN OBJECT TABLE. A town's fire is
  //    not a tile — Kazus's south-west corner is bare grass — it is an entry in
  //    the map's NPC list with a high id. This loop did not exist, which is the
  //    whole reason that campfire was missing: the function returned early for
  //    any map that was not tileset 5, so no town ever placed one.
  //
  //    Runs for EVERY tileset, and only for ids we have actually decoded, so an
  //    unknown object is skipped rather than drawn as garbage.
  //    ⛔ Deduped against pass 1. Ur's inn lists id 194 in its object table AT
  //    THE SAME TILES as its candle-wall background tiles, so placing both drew
  //    two flames on one candle — brighter and subtly wrong, the kind of thing
  //    that never gets reported.
  for (const n of mapData.npcs || []) {
    if (!_flameRawTiles.has(n.id)) continue;
    const px = n.x * TILE_SIZE, py = n.y * TILE_SIZE;
    if (clipped(px, py)) continue;
    if (_flameSprites.some(f => f.px === px && f.py === py)) continue;
    _flameSprites.push({ npcId: n.id, px, py });
  }
}

export function clearFlameSprites() { _flameSprites = []; }
export function getFlameSprites() { return _flameSprites; }
export function getFlameFrames() { return _flameFrames; }
export function getStarTiles() { return _starTiles; }
