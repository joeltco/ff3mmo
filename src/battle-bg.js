import { NES_SYSTEM_PALETTE, decodeTile } from './tile-decoder.js';
import { _stepPalFade } from './palette.js';

// Battle BG ROM offsets (verified from ff3-disasm)
export const BATTLE_BG_TILES_ROM   = 0x018010;  // bank 0C/$8000, 256 bytes per bgId (16 tiles)
export const BATTLE_BG_MAP_LOOKUP  = 0x073C10;  // bank 39/$BC00, 256 entries (bits 0-4=bgId)
export const BATTLE_BG_PAL_C1      = 0x001110;  // bank 00/$9100, color 1 per bgId
export const BATTLE_BG_PAL_C2      = 0x001210;  // bank 00/$9200, color 2 per bgId
export const BATTLE_BG_PAL_C3      = 0x001310;  // bank 00/$9300, color 3 per bgId
const BATTLE_BG_TMID_TABLE  = 0x05E512;  // bank 2F/$A502, tilemap ID per bgId (24 entries)
const BATTLE_BG_META_TILES  = 0x05E52A;  // bank 2F/$A51A, 4 metatiles × 4 tile IDs
const BATTLE_BG_TILEMAPS    = 0x05E53A;  // bank 2F/$A52A, 3 tilemaps × 32 bytes

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

export function _loadBattlePalette(romData, bgId) {
  return [0x0F, romData[BATTLE_BG_PAL_C1 + bgId], romData[BATTLE_BG_PAL_C2 + bgId], romData[BATTLE_BG_PAL_C3 + bgId]];
}

function _loadBattleMetaTiles(romData) {
  const metaTiles = [];
  for (let m = 0; m < 4; m++) {
    const ids = [];
    for (let j = 0; j < 4; j++) ids.push(romData[BATTLE_BG_META_TILES + m * 4 + j] - 0x60);
    metaTiles.push(ids);
  }
  return metaTiles;
}

function _loadBattleTilemap(romData, bgId) {
  const tilemapIdx = romData[BATTLE_BG_TMID_TABLE + bgId];
  const tmBase = BATTLE_BG_TILEMAPS + tilemapIdx * 32;
  const tilemap = [];
  for (let i = 0; i < 32; i++) tilemap.push(romData[tmBase + i]);
  return tilemap;
}

export function renderBattleBgWithPalette(romData, bgId, palette, tiles, metaTiles, tilemap) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 32;
  const bctx = c.getContext('2d');
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 16; col++) {
      const metaIdx = tilemap[row * 16 + col];
      const [tl, tr, bl, br] = metaTiles[metaIdx];
      const px = col * 16, py = row * 16;
      for (const [tIdx, sx, sy] of [[tl,px,py],[tr,px+8,py],[bl,px,py+8],[br,px+8,py+8]])
        _blitTile(bctx, tiles[tIdx], palette, sx, sy);
    }
  }
  return c;
}

export function _loadOceanTileData(romData, bgId) {
  const tileBase = BATTLE_BG_TILES_ROM + bgId * 0x100;
  const tiles = [];
  for (let i = 0; i < 16; i++) tiles.push(decodeTile(romData, tileBase + i * 16));
  const metaTiles = _loadBattleMetaTiles(romData);
  const tilemap = _loadBattleTilemap(romData, bgId);
  return { tiles, metaTiles, tilemap };
}

// Returns { bgCanvas, fadeFrames }
export function renderBattleBg(romData, bgId) {
  const palette = _loadBattlePalette(romData, bgId);
  const { tiles, metaTiles, tilemap } = _loadOceanTileData(romData, bgId);
  const frames = [];
  const fadePal = [...palette];
  while (true) {
    frames.push(renderBattleBgWithPalette(romData, bgId, fadePal, tiles, metaTiles, tilemap));
    if (fadePal[1] === 0x0F && fadePal[2] === 0x0F && fadePal[3] === 0x0F) break;
    _stepPalFade(fadePal);
  }
  return { bgCanvas: frames[0], fadeFrames: frames };
}
