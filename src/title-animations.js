import { NES_SYSTEM_PALETTE, decodeTile } from './tile-decoder.js';
import { nesColorFade, _stepPalFade } from './palette.js';
import { _makeCanvas16 } from './canvas-utils.js';
import { _buildHorizWaterPair } from './water-animation.js';
import { BATTLE_BG_PAL_C1, BATTLE_BG_PAL_C2, BATTLE_BG_PAL_C3,
         _loadBattlePalette, _loadOceanTileData, renderBattleBgWithPalette } from './battle-bg.js';

const TITLE_OCEAN_CHR = [0x22, 0x23, 0x24, 0x25]; // horizontal water CHR tile IDs
const TITLE_WATER_PAL_IDX = 2; // world map palette index for ocean
const TITLE_SKY_BGID = 6;      // airship sky battle BG (blue/lavender/white clouds)

function _precomputeWaterShifts(chrTiles) {
  const shifted = {};
  for (const [ciL, ciR] of [[0x22, 0x23], [0x24, 0x25]]) {
    const bL = chrTiles[ciL], bR = chrTiles[ciR];
    const [arrL, arrR] = _buildHorizWaterPair(bL, bR);
    shifted[ciL] = arrL; shifted[ciR] = arrR;
  }
  return shifted;
}

function _renderOceanTile16(shifted, pal, animFrame) {
  const rgbPal = pal.map(ni => NES_SYSTEM_PALETTE[ni & 0x3F] || [0,0,0]);
  const c = document.createElement('canvas');
  c.width = 16; c.height = 16;
  const tctx = c.getContext('2d');
  for (const [pixels, ox, oy] of [
    [shifted[0x22][animFrame], 0, 0], [shifted[0x23][animFrame], 8, 0],
    [shifted[0x24][animFrame], 0, 8], [shifted[0x25][animFrame], 8, 8],
  ]) {
    const img = tctx.createImageData(8, 8);
    for (let p = 0; p < 64; p++) {
      const rgb = rgbPal[pixels[p]];
      img.data[p*4]=rgb[0]; img.data[p*4+1]=rgb[1]; img.data[p*4+2]=rgb[2]; img.data[p*4+3]=255;
    }
    tctx.putImageData(img, ox, oy);
  }
  return c;
}

function _buildTitleWaterFrames(shifted, basePal, titleFadeMax) {
  const waterFrames = [];
  for (let f = 0; f < 16; f++) waterFrames.push(_renderOceanTile16(shifted, basePal, f));
  const fadeTiles = [];
  const fadePal = [...basePal];
  for (let step = 0; step <= titleFadeMax; step++) {
    fadeTiles.push(_renderOceanTile16(shifted, step === 0 ? basePal : fadePal, 0));
    if (step < titleFadeMax) for (let i = 0; i < 4; i++) fadePal[i] = nesColorFade(fadePal[i]);
  }
  return { waterFrames, fadeTiles };
}

// Returns { titleWaterFrames, titleWaterFadeTiles }
export function initTitleWater(romData, titleFadeMax) {
  const COMMON_CHR = 0x014C10;
  const chrTiles = {};
  for (const ci of TITLE_OCEAN_CHR) chrTiles[ci] = decodeTile(romData, COMMON_CHR + ci * 16);
  const palOff = 0x001650 + TITLE_WATER_PAL_IDX * 4;
  const basePal = [romData[palOff], romData[palOff+1], romData[palOff+2], romData[palOff+3]];
  const { waterFrames, fadeTiles } = _buildTitleWaterFrames(_precomputeWaterShifts(chrTiles), basePal, titleFadeMax);
  return { titleWaterFrames: waterFrames, titleWaterFadeTiles: fadeTiles };
}

// Returns titleSkyFrames array
export function initTitleSky(romData) {
  const bgId = TITLE_SKY_BGID;
  const oceanBgId = 5;
  const palette = [
    0x0F,
    romData[BATTLE_BG_PAL_C1 + oceanBgId],
    romData[BATTLE_BG_PAL_C2 + bgId],
    romData[BATTLE_BG_PAL_C3 + bgId],
  ];
  const { tiles, metaTiles, tilemap } = _loadOceanTileData(romData, bgId);
  const frames = [];
  const fadePal = [...palette];
  while (true) {
    frames.push(renderBattleBgWithPalette(romData, bgId, fadePal, tiles, metaTiles, tilemap));
    if (fadePal[1] === 0x0F && fadePal[2] === 0x0F && fadePal[3] === 0x0F) break;
    _stepPalFade(fadePal);
  }
  return frames;
}

// Returns titleUnderwaterFrames array
export function initTitleUnderwater(romData) {
  const bgId = 18; // undersea Nautilus battle BG ($12/$22/$33 blue palette)
  const palette = _loadBattlePalette(romData, bgId);
  const { tiles, metaTiles, tilemap } = _loadOceanTileData(romData, bgId);
  const frames = [];
  const fadePal = [...palette];
  while (true) {
    frames.push(renderBattleBgWithPalette(romData, bgId, fadePal, tiles, metaTiles, tilemap));
    if (fadePal[1] === 0x0F && fadePal[2] === 0x0F && fadePal[3] === 0x0F) break;
    _stepPalFade(fadePal);
  }
  return frames;
}

// Returns { uwBubbleTiles }
export function initUnderwaterSprites(romData) {
  const SPRITE_ROM = 0x17F10;
  const pal = [null, NES_SYSTEM_PALETTE[0x0F], NES_SYSTEM_PALETTE[0x27], NES_SYSTEM_PALETTE[0x30]];

  function renderSpriteTile(tileIdx) {
    const px = decodeTile(romData, SPRITE_ROM + tileIdx * 16);
    const c = document.createElement('canvas');
    c.width = 8; c.height = 8;
    const lctx = c.getContext('2d');
    const idata = lctx.createImageData(8, 8);
    const d = idata.data;
    for (let i = 0; i < 64; i++) {
      const ci = px[i];
      if (ci === 0) continue;
      const rgb = pal[ci];
      if (!rgb) continue;
      d[i * 4] = rgb[0]; d[i * 4 + 1] = rgb[1]; d[i * 4 + 2] = rgb[2]; d[i * 4 + 3] = 255;
    }
    lctx.putImageData(idata, 0, 0);
    return c;
  }

  const uwBubbleTiles = [];
  uwBubbleTiles.push(renderSpriteTile(0)); // small bubble
  uwBubbleTiles.push(renderSpriteTile(3)); // fish frame 1
  uwBubbleTiles.push(renderSpriteTile(4)); // fish frame 2
  return { uwBubbleTiles };
}

function _renderOceanRow(tiles, metaTiles, tilemap, pal, rowIdx) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 16;
  const rctx = c.getContext('2d');
  for (let col = 0; col < 16; col++) {
    const metaIdx = tilemap[rowIdx * 16 + col];
    const [tl, tr, bl, br] = metaTiles[metaIdx];
    const px = col * 16;
    for (const [tIdx, sx, sy] of [[tl,px,0],[tr,px+8,0],[bl,px,8],[br,px+8,8]]) {
      const img = rctx.createImageData(8, 8);
      const pix = tiles[tIdx];
      for (let p = 0; p < 64; p++) {
        const ci = pix[p];
        if (ci === 0) { img.data[p * 4 + 3] = 0; continue; }
        const rgb = NES_SYSTEM_PALETTE[pal[ci]] || [0, 0, 0];
        img.data[p*4]=rgb[0]; img.data[p*4+1]=rgb[1]; img.data[p*4+2]=rgb[2]; img.data[p*4+3]=255;
      }
      rctx.putImageData(img, sx, sy);
    }
  }
  return c;
}

function _buildOceanPalettes(romData, bgId) {
  const skyPal = _loadBattlePalette(romData, bgId);
  const wPalOff = 0x001650 + TITLE_WATER_PAL_IDX * 4;
  const wavePal = [0x0F, romData[wPalOff], romData[wPalOff + 2], romData[wPalOff + 3]];
  return { skyPal, wavePal };
}

function _buildTitleOceanFrames(tiles, metaTiles, tilemap, skyPal, wavePal) {
  const frames = [];
  const fadeSky = [...skyPal], fadeWave = [...wavePal];
  while (true) {
    const frame = document.createElement('canvas');
    frame.width = 256; frame.height = 32;
    const fctx = frame.getContext('2d');
    const skyBg = NES_SYSTEM_PALETTE[fadeSky[1]] || [0,0,0];
    fctx.fillStyle = `rgb(${skyBg[0]},${skyBg[1]},${skyBg[2]})`;
    fctx.fillRect(0, 0, 256, 16);
    fctx.drawImage(_renderOceanRow(tiles, metaTiles, tilemap, fadeSky, 0), 0, 0);
    const waveBg = NES_SYSTEM_PALETTE[fadeWave[1]] || [0,0,0];
    fctx.fillStyle = `rgb(${waveBg[0]},${waveBg[1]},${waveBg[2]})`;
    fctx.fillRect(0, 16, 256, 16);
    fctx.drawImage(_renderOceanRow(tiles, metaTiles, tilemap, fadeWave, 1), 0, 16);
    frames.push(frame);
    if (fadeSky[1] === 0x0F && fadeSky[2] === 0x0F && fadeSky[3] === 0x0F &&
        fadeWave[1] === 0x0F && fadeWave[2] === 0x0F && fadeWave[3] === 0x0F) break;
    for (let i = 1; i <= 3; i++) { fadeSky[i] = nesColorFade(fadeSky[i]); fadeWave[i] = nesColorFade(fadeWave[i]); }
  }
  return frames;
}

// Returns titleOceanFrames array
export function initTitleOcean(romData) {
  const bgId = 5;
  const { skyPal, wavePal } = _buildOceanPalettes(romData, bgId);
  const { tiles, metaTiles, tilemap } = _loadOceanTileData(romData, bgId);
  return _buildTitleOceanFrames(tiles, metaTiles, tilemap, skyPal, wavePal);
}

// FF3 Sight screen logo — composited pixel data captured from FCEUX (BG+sprites)
// 160×16 pixels, hex digits: 0=transparent, 1=fill (NES $02/$03), 2=outline (NES $22)
const LOGO_PIXELS = [
  '0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000022222100000000000',
  '0002222200000021000000000000000000000000000000002100000000022222000000210000000000000000000000000000000000000000000000000000000000000000000022211122222222221222',
  '0021111122000210000000000000000000000000000000022100000000211111220002100000000000000000000000000000000000000000000000000000000000000000000000000222222222222210',
  '0210022111222100000110000000000000000000000000222100000002100221112221000000000000000000000000000000000000000000000000000000000000000000000000000221122112211100',
  '0210001211111000002211000000000000000000000002221000000002100012111110000000000000000000000000000000000000000000000000000000000000000000000000000220222022100000',
  '0211001210000000000110000000000000000000000021221000000002110012100000000000000000000000000000210000000000000000000000000000000000000000000000002220220022000000',
  '0021111222200000000000000000000000000000000202210000000000211112222000000000000000000000000002210000000000000000000000000000000000000000000000002202220220000000',
  '0002222111220000022100000000000000000000000002210000000000022221112200000000000000000000000002100000000000000000000000000000000000000000000000011101100110000000',
  '0000111110120000222100002022210000002221000022100000000000001111001200000222000002022210002222222100002220000022221000022100222000000000000000022022202200000000',
  '0000000000000022021000222221221000221122100022100000000000000000000100022112210222221221000022112100221122100221112102212100221000000000000000111011001100000000',
  '0000022100000000221000112211121002210022100221000000000000000221000000221002210002210121000021001002210022100022101000021002211000000000000000220022022000000000',
  '0000022100000000210000002100221002100111000221000000000000000221000000210011100002100211000221001002100111000002210000221002210000000000000001110110011000000000',
  '0000221000000002210000022100210022100221002210000000000000002210000002210022000022100210000210000022100220002100221000210002110000000000000111111110110000000000',
  '0000221111000002210000021002202022102210002210210000000000002211100002210221000021002102002210200022102210002210221002210022100000000000001111111111111111110000',
  '0022222221000001222100221002221012221222001222100000000000222222100001222122200221002221001222110012221222001222211002211221100000000000010001111111111110000000',
  '0011111110000000111100110000110001110110000111000000000000111111100000111011000110000110000111100001110110000111110000222221000000000000000000011111110000000000',
  '0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000211000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000120002210000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000122222110000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000012221100000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001111000000000000000000000000000000000000000',
].join('');
const LOGO_W = 160;
const LOGO_H = 21;

// Returns titleLogoFrames array
export function initTitleLogo() {
  const pal = [0x0F, 0x21, 0x30];

  function renderLogo(palette) {
    const c = document.createElement('canvas');
    c.width = LOGO_W; c.height = LOGO_H;
    const lctx = c.getContext('2d');
    const idata = lctx.createImageData(LOGO_W, LOGO_H);
    const d = idata.data;
    for (let i = 0; i < LOGO_PIXELS.length; i++) {
      const ci = LOGO_PIXELS.charCodeAt(i) - 48;
      if (ci === 0) continue;
      const nesC = palette[ci];
      const rgb = NES_SYSTEM_PALETTE[nesC] || [0, 0, 0];
      const idx = i * 4;
      d[idx] = rgb[0]; d[idx + 1] = rgb[1]; d[idx + 2] = rgb[2]; d[idx + 3] = 255;
    }
    lctx.putImageData(idata, 0, 0);
    return c;
  }

  const frames = [];
  const fadePal = [...pal];
  while (true) {
    frames.push(renderLogo(fadePal));
    const allBlack = fadePal[1] === 0x0F && fadePal[2] === 0x0F;
    if (allBlack) break;
    for (let i = 1; i <= 2; i++) fadePal[i] = nesColorFade(fadePal[i]);
  }
  return frames;
}
