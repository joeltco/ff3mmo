import { NES_SYSTEM_PALETTE } from './tile-decoder.js';
import { _getPlane0, _rebuild, _shiftHorizWater, _isWater, _buildHorizMixed, _writeTilePixels } from './tile-math.js';

const HORIZ_CHR = new Set([0x22, 0x23, 0x24, 0x25]);
const VERT_CHR = [0x26, 0x27];
const ANIM_CHR = new Set([0x22, 0x23, 0x24, 0x25, 0x26, 0x27]);

let _waterCache = null;
let _indoorWaterCache = null;

export function resetWorldWaterCache()  { _waterCache = null; }
export function resetIndoorWaterCache() { _indoorWaterCache = null; }

export function _buildHorizWaterPair(bL, bR) {
  const p0L = _getPlane0(bL), p0R = _getPlane0(bR);
  const p1L = bL.map(p => p & 2), p1R = bR.map(p => p & 2);
  const arrL = [], arrR = [];
  let cL = new Uint8Array(p0L), cR = new Uint8Array(p0R);
  for (let f = 0; f < 16; f++) {
    arrL.push(_rebuild(cL, p1L)); arrR.push(_rebuild(cR, p1R));
    [cL, cR] = _shiftHorizWater(cL, cR);
  }
  return [arrL, arrR];
}

function _buildHorizWaterFrames(chrTiles, frames) {
  for (const [ciL, ciR] of [[0x22, 0x23], [0x24, 0x25]]) {
    const bL = chrTiles[ciL], bR = chrTiles[ciR];
    if (!bL || !bR || !_isWater(bL) || !_isWater(bR)) continue;
    const [arrL, arrR] = _buildHorizWaterPair(bL, bR);
    frames.set(ciL, arrL); frames.set(ciR, arrR);
  }
}

function _buildWorldVertWaterFrames(chrTiles, frames) {
  for (const ci of VERT_CHR) {
    const base = chrTiles[ci];
    if (!base || !_isWater(base)) continue;
    const p0 = _getPlane0(base), p1 = base.map(p => p & 2);
    const arr = [];
    for (let f = 0; f < 8; f++) {
      const rot = new Uint8Array(8);
      for (let r = 0; r < 8; r++) rot[r] = p0[((r - f) % 8 + 8) % 8];
      arr.push(_rebuild(rot, p1));
    }
    frames.set(ci, arr);
  }
}

function _findAnimatedMetatiles(metatiles) {
  const metas = [];
  for (let m = 0; m < 128; m++) {
    const mt = metatiles[m];
    if (ANIM_CHR.has(mt.tl) || ANIM_CHR.has(mt.tr) || ANIM_CHR.has(mt.bl) || ANIM_CHR.has(mt.br)) metas.push(m);
  }
  return metas;
}

function _findAnimatedPositions(tilemap, metatiles) {
  const positions = [];
  for (let ty = 0; ty < 32; ty++) for (let tx = 0; tx < 32; tx++) {
    const mid = tilemap[ty * 32 + tx];
    const mt = metatiles[mid < 128 ? mid : mid & 0x7F];
    if (ANIM_CHR.has(mt.tl) || ANIM_CHR.has(mt.tr) || ANIM_CHR.has(mt.bl) || ANIM_CHR.has(mt.br))
      positions.push({ tx, ty, m: mid < 128 ? mid : mid & 0x7F });
  }
  return positions;
}

function _buildWaterCache(wmr) {
  const { metatiles, chrTiles } = wmr.data;
  const frames = new Map();
  _buildHorizWaterFrames(chrTiles, frames);
  _buildWorldVertWaterFrames(chrTiles, frames);
  return { frames, metas: _findAnimatedMetatiles(metatiles) };
}

function _buildIndoorWaterCache(mr) {
  const { chrTiles, metatiles, tilemap } = mr.mapData;
  const frames = new Map();
  _buildHorizWaterFrames(chrTiles, frames);
  _buildWorldVertWaterFrames(chrTiles, frames);
  return { frames, positions: _findAnimatedPositions(tilemap, metatiles) };
}

export function _updateWorldWater(wmr, waterTick) {
  if (!wmr || !wmr._atlas) return;
  if (!_waterCache) _waterCache = _buildWaterCache(wmr);
  const { frames, metas } = _waterCache;
  if (metas.length === 0) return;

  const { metatiles, chrTiles, palettes, tileAttrs } = wmr.data;
  const actx = wmr._atlas.getContext('2d');
  const tileImg = actx.createImageData(8, 8);
  const td = tileImg.data;
  const hShift = Math.floor(waterTick / 8) % 16;
  const hPrev  = (hShift + 15) % 16;
  const subRow = waterTick % 8;
  const vFrame = Math.floor(waterTick / 8) % 8;

  for (const m of metas) {
    const meta = metatiles[m];
    const rgbPal = palettes[tileAttrs[m] & 0x03].map(ni => NES_SYSTEM_PALETTE[ni & 0x3F] || [0,0,0]);
    const chrs = [meta.tl, meta.tr, meta.bl, meta.br];
    const offs = [[0,0],[8,0],[0,8],[8,8]];
    for (let q = 0; q < 4; q++) {
      const ci = chrs[q];
      const fr = frames.get(ci);
      if (!fr) {
        const tile = chrTiles[ci];
        if (!tile) continue;
        _writeTilePixels(td, tile, rgbPal);
      } else if (HORIZ_CHR.has(ci)) {
        _writeTilePixels(td, _buildHorizMixed(fr[hShift % fr.length], fr[hPrev % fr.length], subRow), rgbPal);
      } else {
        _writeTilePixels(td, fr[vFrame % fr.length], rgbPal);
      }
      actx.putImageData(tileImg, m * 16 + offs[q][0], offs[q][1]);
    }
  }
}

export function _updateIndoorWater(mr, waterTick) {
  if (!mr || !mr._mapCanvas) return;
  if (!_indoorWaterCache) _indoorWaterCache = _buildIndoorWaterCache(mr);
  const { frames, positions } = _indoorWaterCache;
  if (positions.length === 0) return;

  const { metatiles, chrTiles, palettes, tileAttrs } = mr.mapData;
  const fctx = mr._mapCanvas.getContext('2d');
  const tileImg = fctx.createImageData(8, 8);
  const td = tileImg.data;
  const hShift = Math.floor(waterTick / 8) % 16;
  const hPrev = (hShift + 15) % 16;
  const subRow = waterTick % 8;
  const vFrame = Math.floor(waterTick / 8) % 8;

  for (const { tx, ty, m } of positions) {
    const meta = metatiles[m];
    const rgbPal = palettes[tileAttrs[m] & 0x03].map(ni => NES_SYSTEM_PALETTE[ni & 0x3F] || [0, 0, 0]);
    const chrs = [meta.tl, meta.tr, meta.bl, meta.br];
    const offs = [[0, 0], [8, 0], [0, 8], [8, 8]];
    for (let q = 0; q < 4; q++) {
      const ci = chrs[q];
      const fr = frames.get(ci);
      if (!fr) continue;
      if (HORIZ_CHR.has(ci)) {
        _writeTilePixels(td, _buildHorizMixed(fr[hShift % fr.length], fr[hPrev % fr.length], subRow), rgbPal);
      } else {
        _writeTilePixels(td, fr[vFrame % fr.length], rgbPal);
      }
      fctx.putImageData(tileImg, tx * 16 + offs[q][0], ty * 16 + offs[q][1]);
    }
  }
}
