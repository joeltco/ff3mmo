// Sprite initialization — pure init functions that read ROM data and produce canvases.
// Extracted from game.js — these run once at startup.

import { NES_SYSTEM_PALETTE, decodeTile } from './tile-decoder.js';
import { nesColorFade } from './palette.js';
import { _makeCanvas16, _makeCanvas16ctx, _hflipCanvas16, _makeWhiteCanvas } from './canvas-utils.js';
import { BAYER4 } from './data/animation-tables.js';
import { _writePixels64 } from './tile-math.js';
import { PLAYER_PALETTES, MONK_PALETTES, ROSTER_FADE_STEPS } from './data/players.js';
import { BATTLE_SPRITE_ROM, BATTLE_JOB_SIZE, BATTLE_PAL_ROM } from './data/jobs.js';
import { OK_IDLE, OK_VICTORY, OK_L_BACK_SWING, OK_L_FWD_T2, OK_L_FWD_T3, OK_R_BACK_SWING, OK_R_FWD_T2, OK_KNEEL,
         OK_LEG_L_IDLE, OK_LEG_R_IDLE, OK_LEG_L_BACK_L, OK_LEG_R_BACK_L, OK_LEG_L_FWD_L, OK_LEG_R_FWD_L,
         OK_LEG_L_BACK_R, OK_LEG_L_FWD_R, OK_LEG_R_SWING, OK_LEG_L_KNEEL, OK_LEG_R_KNEEL, OK_LEG_L_VICTORY, OK_LEG_R_VICTORY,
         OK_DEATH } from './data/job-sprites.js';
import { WR_IDLE, WR_LEG_L, WR_LEG_R, WR_L_BACK, WR_LEG_L_BACK_L, WR_LEG_R_BACK_L,
         WR_L_FWD_T2, WR_L_FWD_T3, WR_LEG_L_FWD_L, WR_LEG_R_FWD_L,
         WR_R_BACK_T2, WR_LEG_L_BACK_R, WR_LEG_L_FWD_R, WR_LEG_R_SWING,
         WR_KNEEL, WR_LEG_L_KNEEL, WR_LEG_R_KNEEL,
         WR_VICTORY, WR_LEG_L_VICTORY, WR_LEG_R_VICTORY,
         WR_HIT, WR_LEG_L_HIT, WR_LEG_R_HIT,
         WR_DEATH } from './data/warrior-sprites.js';
import { MO_IDLE, MO_LEG_L, MO_LEG_R,
         MO_R_BACK_T2, MO_LEG_L_BACK_R, MO_LEG_R_BACK_R,
         MO_LEG_L_FWD_R,
         MO_L_BACK_T1, MO_L_BACK_T3,
         MO_L_FWD_T2, MO_L_FWD_T3,
         MO_VICTORY, MO_LEG_L_VICTORY, MO_LEG_R_VICTORY,
         MO_DEATH } from './data/monk-sprites.js';
import { initWeaponSprites } from './weapon-sprites.js';
import { LOAD_FADE_MAX } from './loading-screen.js';

// --- Constants (moved from game.js, only used by init code) ---

const FF2_ADAMANTOISE_SPRITE = 0x04BF10;  // 4 tiles, 16×16, row-major (TL,TR,BL,BR)
const LAND_TURTLE_PAL_TOP = [0x0F, 0x13, 0x23, 0x28];
const LAND_TURTLE_PAL_BOT = [0x0F, 0x19, 0x18, 0x28];

const GOBLIN_GFX_OFF = 0x40010;  // Bank $20:$8000 — size 0 (4×4), gfxID 0
const GOBLIN_PAL0 = [0x0F, 0x17, 0x28, 0x3C];
const GOBLIN_PAL1 = [0x0F, 0x18, 0x28, 0x11];
const GOBLIN_TILE_PAL = [0,0,0,0, 1,0,1,0, 1,1,1,1, 1,1,1,1];
const GOBLIN_TILES = 16;
const GOBLIN_COLS = 4;

const MOOGLE_GFX_ID = 42;
const MOOGLE_SPRITE_OFF = 0x01C010 + MOOGLE_GFX_ID * 256; // 0x01EA10
const MOOGLE_PAL = [0x0F, 0x0F, 0x16, 0x30];

const INVINCIBLE_TILE_ROM = 0x17A90;
const INVINCIBLE_PAL = [0x0F, 0x0F, 0x27, 0x30];

const CURSOR_TILE_ROM = 0x01B450;
const SCROLL_ARROW_ROM = 0x01B490;

const DEFEND_SPARKLE_PAL = [0x0F, 0x1B, 0x2B, 0x30];

export const MONSTER_DEATH_FRAMES = 16;

const HUD_INFO_FADE_STEPS = 4;  // duplicated from game.js for _buildFadedCanvas4Set

// --- Battle sprite low-level helpers ---
const _BATTLE_LAYOUT = [[0,0],[8,0],[0,8],[8,8]];

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

function _buildCanvas4(tilesArr, palette) {
  const c = _makeCanvas16(); const cx = c.getContext('2d');
  for (let i = 0; i < 4; i++) {
    _blitTile(cx, decodeTile(tilesArr[i], 0), palette, _BATTLE_LAYOUT[i][0], _BATTLE_LAYOUT[i][1]);
  }
  return c;
}

function _buildFadedCanvas4Set(tilesArr, palette) {
  const arr = [];
  for (let step = 1; step <= HUD_INFO_FADE_STEPS; step++) {
    let fp = [...palette];
    for (let s = 0; s < step; s++) fp = fp.map(c => nesColorFade(c));
    arr.push(_buildCanvas4(tilesArr, fp));
  }
  return arr;
}

function _buildCanvas4ROM(romData, offset, palette) {
  const c = _makeCanvas16(); const cx = c.getContext('2d');
  for (let i = 0; i < 4; i++) {
    _blitTile(cx, decodeTile(romData, offset + i * 16), palette, _BATTLE_LAYOUT[i][0], _BATTLE_LAYOUT[i][1]);
  }
  return c;
}

function _drawTileOnto(tileBytes, palette, ctx, x, y) {
  _blitTile(ctx, decodeTile(tileBytes, 0), palette, x, y);
}

function _renderPortrait(tiles, layout, palette) {
  const c = _makeCanvas16(); const pctx = c.getContext('2d');
  for (let i = 0; i < 4; i++) _blitTile(pctx, tiles[i], palette, layout[i][0], layout[i][1]);
  return c;
}

function _genPosePortraits(poseTiles, paletteList = PLAYER_PALETTES) {
  return paletteList.map(basePal => {
    const frames = [];
    for (let step = 0; step <= ROSTER_FADE_STEPS; step++) {
      const pal = basePal.slice();
      for (let s = 0; s < step; s++) { pal[1] = nesColorFade(pal[1]); pal[2] = nesColorFade(pal[2]); pal[3] = nesColorFade(pal[3]); }
      frames.push(_renderPortrait(poseTiles, _BATTLE_LAYOUT, pal));
    }
    return frames;
  });
}

// --- _FP_* pose tile constants ---
const _FP_ATK_R_TILE  = OK_R_BACK_SWING[2];
const _FP_ATK_L_TILE3 = OK_L_FWD_T2;
const _FP_ATK_L_TILE4 = OK_L_FWD_T3;
const _FP_KNEEL       = OK_KNEEL;
const _FP_IDLE_PPU    = OK_IDLE;
const _FP_VICTORY     = OK_VICTORY;
const _FP_KNIFE_BACK  = OK_L_BACK_SWING;
const _FP_DEFEND      = OK_VICTORY;
const _FP_KNIFE_R     = OK_R_BACK_SWING;
const _FP_KNIFE_L     = OK_L_BACK_SWING;
const _FP_LEG_L       = OK_LEG_L_IDLE;
const _FP_LEG_R       = OK_LEG_R_IDLE;
const _FP_LEG_L_BACK_L  = OK_LEG_L_BACK_L;
const _FP_LEG_R_BACK_L  = OK_LEG_R_BACK_L;
const _FP_LEG_L_FWD_L   = OK_LEG_L_FWD_L;
const _FP_LEG_R_FWD_L   = OK_LEG_R_FWD_L;
const _FP_LEG_L_BACK_R  = OK_LEG_L_BACK_R;
const _FP_LEG_L_FWD_R   = OK_LEG_L_FWD_R;
const _FP_LEG_R_SWING   = OK_LEG_R_SWING;
const _FP_LEG_L_KNEEL   = OK_LEG_L_KNEEL;
const _FP_LEG_R_KNEEL   = OK_LEG_R_KNEEL;
const _FP_LEG_L_VICTORY = OK_LEG_L_VICTORY;
const _FP_LEG_R_VICTORY = OK_LEG_R_VICTORY;

// --- Full-body canvas helpers ---
function _renderDecodedTile(ctx, tile, pal, ox, oy) { _blitTile(ctx, tile, pal, ox, oy); }

function _buildFullBody16x24Canvas(topTiles4, legL, legR, pal) {
  const c = document.createElement('canvas'); c.width = 16; c.height = 24;
  const bctx = c.getContext('2d');
  topTiles4.forEach((tile, i) => { const [bx, by] = _BATTLE_LAYOUT[i]; _renderDecodedTile(bctx, tile, pal, bx, by); });
  [[legL, 0, 16], [legR, 8, 16]].forEach(([tile, lx, ly]) => _renderDecodedTile(bctx, tile, pal, lx, ly));
  const fl = document.createElement('canvas');
  fl.width = 16; fl.height = 24;
  const flctx = fl.getContext('2d');
  flctx.save(); flctx.translate(16, 0); flctx.scale(-1, 1); flctx.drawImage(c, 0, 0); flctx.restore();
  return fl;
}

// --- Death frame helper ---
export function _makeDeathFrames(srcCanvas) {
  const { width: w, height: h } = srcCanvas;
  const origData = srcCanvas.getContext('2d').getImageData(0, 0, w, h);
  const maxThreshold = (w - 1) + (h - 1) + 15;
  const frames = [];
  for (let f = 0; f < MONSTER_DEATH_FRAMES; f++) {
    const fc = document.createElement('canvas'); fc.width = w; fc.height = h;
    const fctx = fc.getContext('2d'); const fd = fctx.createImageData(w, h);
    const wave = (f / (MONSTER_DEATH_FRAMES - 1)) * (maxThreshold + 1);
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const idx = (py * w + px) * 4;
        const threshold = (w - 1 - px) + py + BAYER4[py & 3][px & 3];
        if (threshold < wave) { fd.data[idx + 3] = 0; }
        else { fd.data[idx] = origData.data[idx]; fd.data[idx+1] = origData.data[idx+1]; fd.data[idx+2] = origData.data[idx+2]; fd.data[idx+3] = origData.data[idx+3]; }
      }
    }
    fctx.putImageData(fd, 0, 0); frames.push(fc);
  }
  return frames;
}

// --- Invincible sprite helpers ---
function _hflipTile(pixels) {
  const out = new Uint8Array(64);
  for (let row = 0; row < 8; row++)
    for (let col = 0; col < 8; col++)
      out[row * 8 + col] = pixels[row * 8 + (7 - col)];
  return out;
}

function _renderInvFrame(tilePixels, grid, pal) {
  const c = document.createElement('canvas');
  c.width = 32; c.height = 32;
  const fctx = c.getContext('2d');
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const tileId = grid[row * 4 + col];
      let pixels = tilePixels.get(tileId);
      if (!pixels) continue;
      pixels = _hflipTile(pixels);
      const img = fctx.createImageData(8, 8);
      _writePixels64(img, pixels, pal);
      fctx.putImageData(img, col * 8, row * 8);
    }
  }
  return c;
}

function _renderInvShadow(tilePixels, pal) {
  const c = document.createElement('canvas');
  c.width = 32; c.height = 8;
  const sctx = c.getContext('2d');
  const shadowTiles = [0xC0, 0xC1, 0xC1, 0xC0];
  const shadowFlip  = [false, false, false, true];
  for (let col = 0; col < 4; col++) {
    let pixels = tilePixels.get(shadowTiles[col]);
    if (!pixels) continue;
    if (shadowFlip[col]) pixels = _hflipTile(pixels);
    const img = sctx.createImageData(8, 8);
    _writePixels64(img, pixels, pal);
    sctx.putImageData(img, col * 8, 0);
  }
  return c;
}

// --- Fade rendering helpers ---
function renderSpriteFaded(romData, spriteOff, basePal, fadeSteps) {
  const fadedPal = basePal.map((c, i) => {
    if (i === 0) return c;
    let fc = c;
    for (let s = 0; s < fadeSteps; s++) fc = nesColorFade(fc);
    return fc;
  });

  const tiles = [];
  for (let i = 0; i < 4; i++) {
    tiles.push(decodeTile(romData, spriteOff + i * 16));
  }

  const [c, cctx] = _makeCanvas16ctx();
  for (let i = 0; i < 4; i++) {
    _blitTile(cctx, tiles[i], fadedPal, _BATTLE_LAYOUT[i][0], _BATTLE_LAYOUT[i][1]);
  }
  return c;
}

function renderBossFaded(romData, fadeSteps) {
  const palTop = [0x0F, 0x0F, LAND_TURTLE_PAL_TOP[1], LAND_TURTLE_PAL_TOP[2]];
  const palBot = [0x0F, 0x0F, LAND_TURTLE_PAL_BOT[3], LAND_TURTLE_PAL_BOT[2]];
  const fadedTop = palTop.map((c, i) => {
    if (i === 0) return c;
    let fc = c; for (let s = 0; s < fadeSteps; s++) fc = nesColorFade(fc);
    return fc;
  });
  const fadedBot = palBot.map((c, i) => {
    if (i === 0) return c;
    let fc = c; for (let s = 0; s < fadeSteps; s++) fc = nesColorFade(fc);
    return fc;
  });

  const tiles = [];
  for (let i = 0; i < 4; i++) {
    tiles.push(decodeTile(romData, FF2_ADAMANTOISE_SPRITE + i * 16));
  }

  const [c, cctx] = _makeCanvas16ctx();
  for (let i = 0; i < 4; i++) _renderDecodedTile(cctx, tiles[i], i < 2 ? fadedTop : fadedBot, _BATTLE_LAYOUT[i][0], _BATTLE_LAYOUT[i][1]);
  return c;
}

// --- Goblin sprite helper ---
function _renderGoblinSprite(tiles, pal0, pal1, tilePalMap) {
  const c = document.createElement('canvas');
  c.width = GOBLIN_COLS * 8;
  c.height = GOBLIN_COLS * 8;
  const cctx = c.getContext('2d');
  for (let ty = 0; ty < GOBLIN_COLS; ty++) {
    for (let tx = 0; tx < GOBLIN_COLS; tx++) {
      const tileIdx = ty * GOBLIN_COLS + tx;
      const pal = tilePalMap[tileIdx] === 1 ? pal1 : pal0;
      _blitTile(cctx, tiles[tileIdx], pal, tx * 8, ty * 8);
    }
  }
  return c;
}

// ========================================================================
// Exported init functions — each returns an object of canvas results
// ========================================================================

export function initCursorTile(romData) {
  const palette = [0x0F, 0x00, 0x10, 0x30];
  const cursorTileCanvas = _buildCanvas4ROM(romData, CURSOR_TILE_ROM, palette);
  const cursorFadeCanvases = [];
  for (let step = 1; step <= 4; step++) {
    let fp = [...palette];
    for (let s = 0; s < step; s++) fp = fp.map(c => nesColorFade(c));
    cursorFadeCanvases.push(_buildCanvas4ROM(romData, CURSOR_TILE_ROM, fp));
  }
  return { cursorTileCanvas, cursorFadeCanvases };
}

function _buildSingleTile(romData, offset, palette) {
  const c = document.createElement('canvas');
  c.width = 8; c.height = 8;
  _blitTile(c.getContext('2d'), decodeTile(romData, offset), palette, 0, 0);
  return c;
}

function _vflip8(src) {
  const c = document.createElement('canvas');
  c.width = 8; c.height = 8;
  const cx = c.getContext('2d');
  cx.translate(0, 8); cx.scale(1, -1);
  cx.drawImage(src, 0, 0);
  return c;
}

export function initScrollArrows(romData) {
  const palette = [0x0F, 0x00, 0x10, 0x30];
  const downArrow = _buildSingleTile(romData, SCROLL_ARROW_ROM, palette);
  const upArrow = _vflip8(downArrow);
  const downFade = [], upFade = [];
  for (let step = 1; step <= 4; step++) {
    let fp = [...palette];
    for (let s = 0; s < step; s++) fp = fp.map(c => nesColorFade(c));
    const df = _buildSingleTile(romData, SCROLL_ARROW_ROM, fp);
    downFade.push(df);
    upFade.push(_vflip8(df));
  }
  return { scrollArrowDown: downArrow, scrollArrowUp: upArrow, scrollArrowDownFade: downFade, scrollArrowUpFade: upFade };
}

function _initBattleIdleSprites(romData, palette) {
  const IDLE_PPU = OK_IDLE;
  const battleSpriteCanvas = _buildCanvas4(IDLE_PPU, palette);
  const battleSpriteFadeCanvases = _buildFadedCanvas4Set(IDLE_PPU, palette);

  // Silhouette — same shape, all opaque pixels → NES $00 (grey)
  const silhouetteCanvas = document.createElement('canvas');
  silhouetteCanvas.width = 16; silhouetteCanvas.height = 16;
  const sctx = silhouetteCanvas.getContext('2d');
  sctx.drawImage(battleSpriteCanvas, 0, 0);
  const sdata = sctx.getImageData(0, 0, 16, 16);
  const darkRgb = NES_SYSTEM_PALETTE[0x00] || [0, 0, 0];
  for (let p = 0; p < 16 * 16; p++) {
    if (sdata.data[p * 4 + 3] > 0) {
      sdata.data[p * 4] = darkRgb[0];
      sdata.data[p * 4 + 1] = darkRgb[1];
      sdata.data[p * 4 + 2] = darkRgb[2];
    }
  }
  sctx.putImageData(sdata, 0, 0);

  return { battleSpriteCanvas, battleSpriteFadeCanvases, silhouetteCanvas };
}

function _initBattleAttackSprites(palette, battleSpriteCanvas) {
  const battleSpriteAttackCanvas = document.createElement('canvas');
  battleSpriteAttackCanvas.width = 16; battleSpriteAttackCanvas.height = 16;
  const actx = battleSpriteAttackCanvas.getContext('2d');
  actx.drawImage(battleSpriteCanvas, 0, 0);
  _drawTileOnto(_FP_ATK_R_TILE, palette, actx, 0, 8);

  const battleSpriteAttackLCanvas = document.createElement('canvas');
  battleSpriteAttackLCanvas.width = 16; battleSpriteAttackLCanvas.height = 16;
  const alctx = battleSpriteAttackLCanvas.getContext('2d');
  alctx.drawImage(battleSpriteCanvas, 0, 0);
  _drawTileOnto(_FP_KNIFE_L[3], palette, alctx, 8, 8);

  const battleSpriteAttackL2Canvas = document.createElement('canvas');
  battleSpriteAttackL2Canvas.width = 16; battleSpriteAttackL2Canvas.height = 16;
  const al2ctx = battleSpriteAttackL2Canvas.getContext('2d');
  al2ctx.drawImage(battleSpriteCanvas, 0, 0);
  _drawTileOnto(OK_L_FWD_T2, palette, al2ctx, 0, 8);
  _drawTileOnto(OK_L_FWD_T3, palette, al2ctx, 8, 8);

  return { battleSpriteAttackCanvas, battleSpriteAttackLCanvas, battleSpriteAttackL2Canvas };
}

function _initBattleKnifeBodySprites(palette) {
  const battleSpriteKnifeRCanvas = _buildCanvas4(_FP_KNIFE_R, palette);
  const battleSpriteKnifeLCanvas = _buildCanvas4(_FP_KNIFE_L, palette);
  const battleSpriteKnifeBackCanvas = _buildCanvas4(_FP_KNIFE_BACK, palette);
  return { battleSpriteKnifeRCanvas, battleSpriteKnifeLCanvas, battleSpriteKnifeBackCanvas };
}

function _initBattleRomPoses(romData, palette) {
  const battleSpriteVictoryCanvas = _buildCanvas4(_FP_VICTORY, palette);
  const battleSpriteHitCanvas = _buildCanvas4ROM(romData, BATTLE_SPRITE_ROM + 30 * 16, palette);
  // R FWD body = all idle (OK_R_FWD_T2 === OK_IDLE_T2); legs-only animation.
  const battleSpriteAttack2Canvas = _buildCanvas4([OK_IDLE[0], OK_IDLE[1], OK_R_FWD_T2, OK_IDLE[3]], palette);
  return { battleSpriteVictoryCanvas, battleSpriteHitCanvas, battleSpriteAttack2Canvas };
}

function _initCureSparkleFrames() {
  const CURE_TILE_4D = new Uint8Array([0x00,0x40,0x00,0x10,0x08,0x04,0x03,0x03, 0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x01]);
  const CURE_TILE_4E = new Uint8Array([0x00,0x00,0x00,0x08,0x10,0x60,0x20,0x80, 0x00,0x00,0x00,0x00,0x00,0x00,0xC0,0xC0]);
  const CURE_PAL = [0x0F, 0x12, 0x22, 0x31];
  const cureTileCanvases = [CURE_TILE_4D, CURE_TILE_4E].map(raw => {
    const c = document.createElement('canvas'); c.width = 8; c.height = 8;
    _blitTile(c.getContext('2d'), decodeTile(raw, 0), CURE_PAL, 0, 0); return c;
  });
  const configLayouts = [
    [[1,0,0,true,false],[0,8,0,true,false],[0,0,8,false,true],[1,8,8,false,true]],
    [[0,0,0,false,false],[1,8,0,false,false],[1,0,8,true,true],[0,8,8,true,true]],
  ];
  return configLayouts.map(config => {
    const c = _makeCanvas16();
    const cx = c.getContext('2d');
    for (const [ti, ox, oy, hf, vf] of config) {
      cx.save();
      if (hf && vf) { cx.translate(ox + 8, oy + 8); cx.scale(-1, -1); cx.drawImage(cureTileCanvases[ti], 0, 0); }
      else if (hf)  { cx.translate(ox + 8, oy);     cx.scale(-1,  1); cx.drawImage(cureTileCanvases[ti], 0, 0); }
      else if (vf)  { cx.translate(ox,     oy + 8); cx.scale( 1, -1); cx.drawImage(cureTileCanvases[ti], 0, 0); }
      else          { cx.drawImage(cureTileCanvases[ti], ox, oy); }
      cx.restore();
    }
    return c;
  });
}

function _initBattleDefendSprites(palette) {
  const DEFEND_TILES = [
    new Uint8Array([0x05,0x0B,0x17,0x03,0x00,0x00,0x0E,0x1F, 0x07,0x0F,0x1F,0x3F,0x43,0x40,0x20,0x00]),
    new Uint8Array([0x00,0x00,0xA0,0xD0,0xE8,0x78,0x10,0x88, 0x2C,0x59,0xBE,0xD6,0xEF,0xFB,0x75,0x1A]),
    new Uint8Array([0x04,0xD6,0xD6,0x3F,0xEF,0xF0,0x63,0x0E, 0x00,0x00,0x00,0x24,0xE4,0xF0,0x6F,0x1F]),
    new Uint8Array([0x90,0x4C,0xCC,0x30,0x7C,0x78,0x30,0x00, 0x32,0x21,0x00,0xB0,0x7C,0x7C,0xB2,0xC2]),
  ];
  const battleSpriteDefendCanvas = _buildCanvas4(DEFEND_TILES, palette);
  const battleSpriteDefendFadeCanvases = _buildFadedCanvas4Set(DEFEND_TILES, palette);

  const SPARKLE_TILES = [
    new Uint8Array([0x01,0x00,0x08,0x00,0x00,0x41,0x00,0x02, 0x00,0x00,0x01,0x02,0x00,0x09,0x00,0x12]),
    new Uint8Array([0x00,0x00,0x00,0x04,0x0A,0x14,0x0A,0x01, 0x00,0x00,0x00,0x18,0x1C,0x0E,0x04,0x00]),
    new Uint8Array([0x00,0x00,0x20,0x10,0x08,0x04,0x00,0x00, 0x00,0x00,0x30,0x38,0x10,0x00,0x00,0x00]),
    new Uint8Array([0x80,0x00,0x20,0x00,0x00,0x00,0x00,0x00, 0x80,0x40,0x00,0x00,0x00,0x00,0x00,0x00]),
  ];
  const defendSparkleFrames = SPARKLE_TILES.map(raw => {
    const sc = document.createElement('canvas');
    sc.width = 8; sc.height = 8;
    _blitTile(sc.getContext('2d'), decodeTile(raw, 0), DEFEND_SPARKLE_PAL, 0, 0);
    return sc;
  });

  const cureSparkleFrames = _initCureSparkleFrames();

  return { battleSpriteDefendCanvas, battleSpriteDefendFadeCanvases, defendSparkleFrames, cureSparkleFrames };
}

function _initBattleLowHPSprites(palette) {
  const battleSpriteKneelCanvas = _buildCanvas4(_FP_KNEEL, palette);
  const battleSpriteKneelFadeCanvases = _buildFadedCanvas4Set(_FP_KNEEL, palette);

  const SWEAT_FRAME_TILES = [
    [new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x04,0x00,0x40,0x00,0x00,0x00,0x00,0x00]),
     new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x20,0x00,0x02,0x00,0x00,0x00,0x00,0x00])],
    [new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x02,0x10,0x00,0x40,0x00]),
     new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x40,0x08,0x00,0x02,0x00])],
  ];
  const sweatFrames = SWEAT_FRAME_TILES.map(frameTiles => {
    const sc = document.createElement('canvas');
    sc.width = 16; sc.height = 8;
    const sctx = sc.getContext('2d');
    for (let t = 0; t < 2; t++) {
      _blitTile(sctx, decodeTile(frameTiles[t], 0), palette, t * 8, 0);
    }
    return sc;
  });

  return { battleSpriteKneelCanvas, battleSpriteKneelFadeCanvases, sweatFrames };
}

// Status effect sprite animations — 2-frame 16×8 each, from ROM $1B250-$1B440
// Palette per status from disassembly: pal0=paralysis/silence/poison/near-fatal, pal1=sleep, pal2=confused, pal3=blind/petrify
const STATUS_PAL0 = [0x0F, 0x36, 0x30, 0x16]; // black, pink, white, dark red
const STATUS_PAL1 = [0x0F, 0x36, 0x30, 0x16]; // sleep (same pal0 for now)
const STATUS_PAL2 = [0x0F, 0x36, 0x30, 0x16]; // confused (same pal0 for now)
const STATUS_PAL3 = [0x0F, 0x36, 0x30, 0x16]; // blind/petrify (same pal0 for now)

const STATUS_SPRITE_DATA = {
  0x01: { // PARALYSIS
    pal: STATUS_PAL0, tiles: [
      [new Uint8Array([0x00,0x00,0x40,0x00,0x00,0x00,0x00,0x00,0xf0,0x38,0x58,0x98,0x60,0x00,0x40,0x00]),
       new Uint8Array([0x00,0x00,0x02,0x00,0x00,0x00,0x00,0x00,0x0f,0x1c,0x1a,0x19,0x06,0x00,0x04,0x02])],
      [new Uint8Array([0x00,0x00,0x20,0x00,0x00,0x00,0x00,0x00,0xe0,0x90,0xb0,0xd0,0xa0,0x00,0x00,0xa0]),
       new Uint8Array([0x00,0x00,0xe0,0x4e,0x84,0xe8,0x0e,0x00,0x00,0x00,0xe0,0x0e,0x20,0xe2,0x0e,0x00])],
    ]},
  0x100: { // SLEEP
    pal: STATUS_PAL1, tiles: [
      [new Uint8Array([0x00,0xe0,0x4e,0x84,0xe8,0x0e,0x00,0x00,0x00,0xe0,0x0e,0x20,0xe2,0x0e,0x00,0x00]),
       new Uint8Array([0x00,0xe0,0x8e,0x08,0x40,0x24,0xe2,0x0e,0x00,0xe0,0x2e,0x42,0x04,0x80,0xe8,0x0e])],
      [new Uint8Array([0xe0,0x8e,0x08,0x40,0x24,0xe2,0x0e,0x00,0xe0,0x2e,0x42,0x04,0x80,0xe8,0x0e,0x00]),
       new Uint8Array([0x00,0x00,0x10,0x60,0xc0,0xc0,0xe0,0x3f,0x00,0x00,0x10,0x60,0xc0,0x80,0xc0,0x3f])],
    ]},
  0x200: { // CONFUSE
    pal: STATUS_PAL2, tiles: [
      [new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x08,0xe0,0x00,0x00,0x00,0x00,0x00,0x00,0x08,0xe0,0x00]),
       new Uint8Array([0x00,0x07,0x10,0x00,0x00,0x00,0x00,0x00,0x00,0x07,0x10,0x00,0x00,0x00,0x00,0x00])],
      [new Uint8Array([0xfc,0x07,0x03,0x03,0x06,0x08,0x00,0x00,0xfc,0x03,0x01,0x03,0x06,0x08,0x00,0x00]),
       new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x07,0x3f,0x7f,0x73,0x7f,0x1f,0x00,0x01])],
    ]},
  0x10: { // SILENCE
    pal: STATUS_PAL0, tiles: [
      [new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0xe0,0xf8,0xfc,0x6c,0xfc,0xf8,0x80,0x00]),
       new Uint8Array([0x08,0x1c,0x0e,0x07,0x07,0x0e,0x1c,0x08,0x0f,0x3f,0x7f,0x77,0x7f,0x3f,0x1c,0x09])],
      [new Uint8Array([0x20,0x70,0xe0,0xc0,0xc0,0xe0,0x70,0x20,0xe0,0xf8,0xfc,0xec,0xfc,0xf8,0xf0,0x20]),
       new Uint8Array([0x00,0x00,0x00,0x00,0x3f,0x3d,0x3d,0x38,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00])],
    ]},
  0x04: { // BLIND
    pal: STATUS_PAL3, tiles: [
      [new Uint8Array([0x00,0x00,0x04,0x0c,0xf8,0xe0,0xe0,0xe0,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00]),
       new Uint8Array([0x00,0x00,0x00,0x00,0x3f,0x3d,0x3d,0x38,0x00,0x00,0x00,0x00,0x00,0x10,0x20,0x00])],
      [new Uint8Array([0x00,0x00,0x04,0x0c,0xf8,0xe0,0xe0,0xe0,0x00,0x00,0x00,0x00,0x00,0x40,0x80,0x00]),
       new Uint8Array([0x00,0x02,0x05,0x02,0x00,0x20,0x50,0x20,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00])],
    ]},
  0x02: { // POISON
    pal: STATUS_PAL0, tiles: [
      [new Uint8Array([0x00,0x02,0x05,0x02,0x00,0x20,0x50,0x20, 0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00]),
       new Uint8Array([0x00,0x00,0x0c,0x12,0x12,0x0c,0x00,0x00, 0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00])],
      [new Uint8Array([0x00,0x00,0x02,0x05,0x22,0x50,0x20,0x00, 0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00]),
       new Uint8Array([0x00,0x0c,0x12,0x12,0x0c,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00])],
    ]},
  0x40: { // PETRIFY (partial)
    pal: STATUS_PAL3, tiles: [
      [new Uint8Array([0x00,0xf0,0x28,0x5c,0xc4,0xac,0x58,0x60,0x00,0x00,0xf0,0xf0,0x38,0x50,0xa0,0x00]),
       new Uint8Array([0x01,0x06,0x0d,0x1f,0x1a,0x0d,0x07,0x00,0x00,0x01,0x00,0x00,0x00,0x00,0x00,0x00])],
      [new Uint8Array([0xf0,0x28,0x5c,0xc4,0xac,0x58,0x60,0x00,0x00,0xf0,0xf0,0x38,0x50,0xa0,0x00,0x00]),
       new Uint8Array([0x07,0x1f,0x3e,0x7f,0xdf,0xff,0xdf,0xdf,0x00,0x07,0x1f,0x1f,0x7f,0x7f,0x7f,0x7f])],
    ]},
};

// Returns Map<statusFlag, [frame0Canvas, frame1Canvas]>
export function initStatusSprites() {
  const map = new Map();
  for (const [flag, data] of Object.entries(STATUS_SPRITE_DATA)) {
    const frames = data.tiles.map(frameTiles => {
      const sc = document.createElement('canvas');
      sc.width = 16; sc.height = 8;
      const sctx = sc.getContext('2d');
      _blitTile(sctx, decodeTile(frameTiles[0], 0), data.pal, 0, 0);
      _blitTile(sctx, decodeTile(frameTiles[1], 0), data.pal, 8, 0);
      return sc;
    });
    map.set(Number(flag), frames);
  }
  return map;
}

// Backward compat — returns just poison frames
export function initPoisonBubble() {
  const map = initStatusSprites();
  return map.get(0x02) || [];
}

// Read 4 tiles from ROM for a job pose (tile indices relative to job block start)
function _readJobTiles(romData, jobBase, t0, t1, t2, t3) {
  return [t0, t1, t2, t3].map(t => decodeTile(romData, jobBase + t * 16));
}

function _readJobTileRaw(romData, jobBase, tileIdx) {
  const off = jobBase + tileIdx * 16;
  return new Uint8Array(romData.buffer.slice ? romData.buffer.slice(off, off + 16) : romData.slice(off, off + 16));
}

// Per-job battle palette overrides — PPU captures. Each entry is [color1, color2, color3]
// (color 0 is always 0x0F transparent). Jobs without an entry fall back to BATTLE_PAL_ROM.
// Monk uses SP1 slot: 0x27 (orange/skin), 0x18 (olive/hair), 0x21 (blue gi — customizable color).
const JOB_BATTLE_PAL_OVERRIDE = {
  2: [0x27, 0x18, 0x21],
};

// Build all battle sprite canvases for a given job index (0=Onion Knight, 1=Warrior, etc.)
export function initBattleSpriteForJob(romData, jobIdx) {
  const pov = JOB_BATTLE_PAL_OVERRIDE[jobIdx];
  const palette = pov
    ? [0x0F, pov[0], pov[1], pov[2]]
    : [0x0F, romData[BATTLE_PAL_ROM], romData[BATTLE_PAL_ROM + 1], romData[BATTLE_PAL_ROM + 2]];
  const jobBase = BATTLE_SPRITE_ROM + jobIdx * BATTLE_JOB_SIZE;

  // For Onion Knight (jobIdx 0), use the PPU-dumped tiles (proven correct)
  if (jobIdx === 0) return initBattleSprite(romData);

  // For Warrior (jobIdx 1), use PPU-dumped tiles
  if (jobIdx === 1) {
    const d = (raw) => decodeTile(raw, 0);
    const idleTiles = WR_IDLE.map(d);
    const battleSpriteCanvas = _renderPortrait(idleTiles, _BATTLE_LAYOUT, palette);
    const battleSpriteFadeCanvases = [];
    for (let step = 1; step <= HUD_INFO_FADE_STEPS; step++) {
      let fp = [...palette];
      for (let s = 0; s < step; s++) fp = fp.map(c => nesColorFade(c));
      battleSpriteFadeCanvases.push(_renderPortrait(idleTiles, _BATTLE_LAYOUT, fp));
    }
    const silhouetteCanvas = document.createElement('canvas');
    silhouetteCanvas.width = 16; silhouetteCanvas.height = 16;
    const sctx = silhouetteCanvas.getContext('2d');
    sctx.drawImage(battleSpriteCanvas, 0, 0);
    const sdata = sctx.getImageData(0, 0, 16, 16);
    const darkRgb = NES_SYSTEM_PALETTE[0x00] || [0, 0, 0];
    for (let p = 0; p < 256; p++) {
      if (sdata.data[p * 4 + 3] > 0) { sdata.data[p * 4] = darkRgb[0]; sdata.data[p * 4 + 1] = darkRgb[1]; sdata.data[p * 4 + 2] = darkRgb[2]; }
    }
    sctx.putImageData(sdata, 0, 0);
    // R back swing: idle + R back T2
    const atkRBackTiles = [idleTiles[0], idleTiles[1], d(WR_R_BACK_T2), idleTiles[3]];
    const battleSpriteAttackCanvas = _renderPortrait(atkRBackTiles, _BATTLE_LAYOUT, palette);
    // L back swing: idle + L back T3
    const atkLBackTiles = [idleTiles[0], idleTiles[1], idleTiles[2], d(WR_L_BACK[3])];
    const battleSpriteAttackLCanvas = _renderPortrait(atkLBackTiles, _BATTLE_LAYOUT, palette);
    // R fwd swing: idle body (R FWD uses idle T0-T3)
    const battleSpriteAttack2Canvas = _renderPortrait(idleTiles, _BATTLE_LAYOUT, palette);
    // L fwd swing: idle + L fwd T2/T3
    const atkLFwdTiles = [idleTiles[0], idleTiles[1], d(WR_L_FWD_T2), d(WR_L_FWD_T3)];
    const battleSpriteAttackL2Canvas = _renderPortrait(atkLFwdTiles, _BATTLE_LAYOUT, palette);
    // Knife poses
    const knifeRTiles = [idleTiles[0], idleTiles[1], d(WR_R_BACK_T2), idleTiles[3]];
    const knifeLTiles = [idleTiles[0], idleTiles[1], idleTiles[2], d(WR_L_BACK[3])];
    const battleSpriteKnifeRCanvas = _renderPortrait(knifeRTiles, _BATTLE_LAYOUT, palette);
    const battleSpriteKnifeLCanvas = _renderPortrait(knifeLTiles, _BATTLE_LAYOUT, palette);
    const battleSpriteKnifeBackCanvas = _renderPortrait(knifeLTiles, _BATTLE_LAYOUT, palette);
    initWeaponSprites(palette);
    const victoryTiles = WR_VICTORY.map(d);
    const battleSpriteVictoryCanvas = _renderPortrait(victoryTiles, _BATTLE_LAYOUT, palette);
    const battleSpriteDefendCanvas = _renderPortrait(victoryTiles, _BATTLE_LAYOUT, palette);
    const battleSpriteDefendFadeCanvases = [];
    for (let step = 1; step <= HUD_INFO_FADE_STEPS; step++) {
      let fp = [...palette]; for (let s = 0; s < step; s++) fp = fp.map(c => nesColorFade(c));
      battleSpriteDefendFadeCanvases.push(_renderPortrait(victoryTiles, _BATTLE_LAYOUT, fp));
    }
    const hitTiles = WR_HIT.map(d);
    const battleSpriteHitCanvas = _renderPortrait(hitTiles, _BATTLE_LAYOUT, palette);
    const kneelTiles = WR_KNEEL.map(d);
    const battleSpriteKneelCanvas = _renderPortrait(kneelTiles, _BATTLE_LAYOUT, palette);
    const battleSpriteKneelFadeCanvases = [];
    for (let step = 1; step <= HUD_INFO_FADE_STEPS; step++) {
      let fp = [...palette]; for (let s = 0; s < step; s++) fp = fp.map(c => nesColorFade(c));
      battleSpriteKneelFadeCanvases.push(_renderPortrait(kneelTiles, _BATTLE_LAYOUT, fp));
    }
    const SPARKLE_TILES = [
      new Uint8Array([0x01,0x00,0x08,0x00,0x00,0x41,0x00,0x02, 0x00,0x00,0x01,0x02,0x00,0x09,0x00,0x12]),
      new Uint8Array([0x00,0x00,0x00,0x04,0x0A,0x14,0x0A,0x01, 0x00,0x00,0x00,0x18,0x1C,0x0E,0x04,0x00]),
      new Uint8Array([0x00,0x00,0x20,0x10,0x08,0x04,0x00,0x00, 0x00,0x00,0x30,0x38,0x10,0x00,0x00,0x00]),
      new Uint8Array([0x80,0x00,0x20,0x00,0x00,0x00,0x00,0x00, 0x80,0x40,0x00,0x00,0x00,0x00,0x00,0x00]),
    ];
    const defendSparkleFrames = SPARKLE_TILES.map(raw => {
      const sc = document.createElement('canvas'); sc.width = 8; sc.height = 8;
      _blitTile(sc.getContext('2d'), decodeTile(raw, 0), DEFEND_SPARKLE_PAL, 0, 0); return sc;
    });
    const cureSparkleFrames = _initCureSparkleFrames();
    const SWEAT_FRAME_TILES = [
      [new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x04,0x00,0x40,0x00,0x00,0x00,0x00,0x00]),
       new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x20,0x00,0x02,0x00,0x00,0x00,0x00,0x00])],
      [new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x02,0x10,0x00,0x40,0x00]),
       new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x40,0x08,0x00,0x02,0x00])],
    ];
    const sweatFrames = SWEAT_FRAME_TILES.map(frameTiles => {
      const sc = document.createElement('canvas'); sc.width = 16; sc.height = 8;
      const sctx2 = sc.getContext('2d');
      for (let t = 0; t < 2; t++) _blitTile(sctx2, decodeTile(frameTiles[t], 0), palette, t * 8, 0);
      return sc;
    });
    return {
      poses: {
        idle: battleSpriteCanvas, idleFade: battleSpriteFadeCanvases, silhouette: silhouetteCanvas,
        rBack: battleSpriteAttackCanvas, lBack: battleSpriteAttackLCanvas,
        rFwd: battleSpriteAttack2Canvas, lFwd: battleSpriteAttackL2Canvas,
        knifeR: battleSpriteKnifeRCanvas, knifeL: battleSpriteKnifeLCanvas, knifeBack: battleSpriteKnifeBackCanvas,
        victory: battleSpriteVictoryCanvas, hit: battleSpriteHitCanvas,
        defend: battleSpriteDefendCanvas, defendFade: battleSpriteDefendFadeCanvases,
        kneel: battleSpriteKneelCanvas, kneelFade: battleSpriteKneelFadeCanvases,
      },
      defendSparkleFrames, cureSparkleFrames, sweatFrames,
    };
  }

  // For other jobs, read all poses from ROM using same tile indices as OK
  // Tile layout within a job block (42 tiles total):
  //   0-3: idle, 4-7: ?, 8-11: ?, 12-15: ?, 16-17: ?, 18-21: attack2,
  //   22-23: ?, 24-27: victory/defend, 28-29: ?, 30-33: hit, 34-35: ?,
  //   36-39: kneel, 40-41: ?
  const idleTiles = _readJobTiles(romData, jobBase, 0, 1, 2, 3);
  const battleSpriteCanvas = _renderPortrait(idleTiles, _BATTLE_LAYOUT, palette);
  const battleSpriteFadeCanvases = [];
  for (let step = 1; step <= HUD_INFO_FADE_STEPS; step++) {
    let fp = [...palette];
    for (let s = 0; s < step; s++) fp = fp.map(c => nesColorFade(c));
    battleSpriteFadeCanvases.push(_renderPortrait(idleTiles, _BATTLE_LAYOUT, fp));
  }

  // Silhouette
  const silhouetteCanvas = document.createElement('canvas');
  silhouetteCanvas.width = 16; silhouetteCanvas.height = 16;
  const sctx = silhouetteCanvas.getContext('2d');
  sctx.drawImage(battleSpriteCanvas, 0, 0);
  const sdata = sctx.getImageData(0, 0, 16, 16);
  const darkRgb = NES_SYSTEM_PALETTE[0x00] || [0, 0, 0];
  for (let p = 0; p < 256; p++) {
    if (sdata.data[p * 4 + 3] > 0) {
      sdata.data[p * 4] = darkRgb[0]; sdata.data[p * 4 + 1] = darkRgb[1]; sdata.data[p * 4 + 2] = darkRgb[2];
    }
  }
  sctx.putImageData(sdata, 0, 0);

  // Attack — idle body with tile 2 replaced by attack arm tile
  const battleSpriteAttackCanvas = document.createElement('canvas');
  battleSpriteAttackCanvas.width = 16; battleSpriteAttackCanvas.height = 16;
  const actx = battleSpriteAttackCanvas.getContext('2d');
  actx.drawImage(battleSpriteCanvas, 0, 0);
  _blitTile(actx, decodeTile(romData, jobBase + 14 * 16), palette, 0, 8); // R fwd arm

  const battleSpriteAttackLCanvas = document.createElement('canvas');
  battleSpriteAttackLCanvas.width = 16; battleSpriteAttackLCanvas.height = 16;
  const alctx = battleSpriteAttackLCanvas.getContext('2d');
  alctx.drawImage(battleSpriteCanvas, 0, 0);
  _blitTile(alctx, decodeTile(romData, jobBase + 7 * 16), palette, 8, 8); // L back arm

  // Knife body poses — use back/fwd swing tiles
  const knifeRTiles = _readJobTiles(romData, jobBase, 0, 1, 12, 3);
  const knifeLTiles = _readJobTiles(romData, jobBase, 0, 1, 2, 7);
  const knifeBackTiles = _readJobTiles(romData, jobBase, 0, 1, 2, 7);
  const battleSpriteKnifeRCanvas = _renderPortrait(knifeRTiles, _BATTLE_LAYOUT, palette);
  const battleSpriteKnifeLCanvas = _renderPortrait(knifeLTiles, _BATTLE_LAYOUT, palette);
  const battleSpriteKnifeBackCanvas = _renderPortrait(knifeBackTiles, _BATTLE_LAYOUT, palette);

  initWeaponSprites(palette);

  // Victory / Defend (same pose in FF3)
  const victoryTiles = _readJobTiles(romData, jobBase, 24, 25, 26, 27);
  const battleSpriteVictoryCanvas = _renderPortrait(victoryTiles, _BATTLE_LAYOUT, palette);
  const battleSpriteDefendCanvas = _renderPortrait(victoryTiles, _BATTLE_LAYOUT, palette);
  const battleSpriteDefendFadeCanvases = [];
  for (let step = 1; step <= HUD_INFO_FADE_STEPS; step++) {
    let fp = [...palette];
    for (let s = 0; s < step; s++) fp = fp.map(c => nesColorFade(c));
    battleSpriteDefendFadeCanvases.push(_renderPortrait(victoryTiles, _BATTLE_LAYOUT, fp));
  }

  // Hit
  const battleSpriteHitCanvas = _buildCanvas4ROM(romData, jobBase + 30 * 16, palette);

  // Attack2
  const battleSpriteAttack2Canvas = _buildCanvas4ROM(romData, jobBase + 18 * 16, palette);

  // Kneel
  const kneelTiles = _readJobTiles(romData, jobBase, 36, 37, 38, 39);
  const battleSpriteKneelCanvas = _renderPortrait(kneelTiles, _BATTLE_LAYOUT, palette);
  const battleSpriteKneelFadeCanvases = [];
  for (let step = 1; step <= HUD_INFO_FADE_STEPS; step++) {
    let fp = [...palette];
    for (let s = 0; s < step; s++) fp = fp.map(c => nesColorFade(c));
    battleSpriteKneelFadeCanvases.push(_renderPortrait(kneelTiles, _BATTLE_LAYOUT, fp));
  }

  // Sparkle + cure frames (shared across all jobs)
  const SPARKLE_TILES = [
    new Uint8Array([0x01,0x00,0x08,0x00,0x00,0x41,0x00,0x02, 0x00,0x00,0x01,0x02,0x00,0x09,0x00,0x12]),
    new Uint8Array([0x00,0x00,0x00,0x04,0x0A,0x14,0x0A,0x01, 0x00,0x00,0x00,0x18,0x1C,0x0E,0x04,0x00]),
    new Uint8Array([0x00,0x00,0x20,0x10,0x08,0x04,0x00,0x00, 0x00,0x00,0x30,0x38,0x10,0x00,0x00,0x00]),
    new Uint8Array([0x80,0x00,0x20,0x00,0x00,0x00,0x00,0x00, 0x80,0x40,0x00,0x00,0x00,0x00,0x00,0x00]),
  ];
  const defendSparkleFrames = SPARKLE_TILES.map(raw => {
    const sc = document.createElement('canvas'); sc.width = 8; sc.height = 8;
    _blitTile(sc.getContext('2d'), decodeTile(raw, 0), DEFEND_SPARKLE_PAL, 0, 0); return sc;
  });
  const cureSparkleFrames = _initCureSparkleFrames();

  // Sweat frames (shared)
  const SWEAT_FRAME_TILES = [
    [new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x04,0x00,0x40,0x00,0x00,0x00,0x00,0x00]),
     new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x20,0x00,0x02,0x00,0x00,0x00,0x00,0x00])],
    [new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x02,0x10,0x00,0x40,0x00]),
     new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x40,0x08,0x00,0x02,0x00])],
  ];
  const sweatFrames = SWEAT_FRAME_TILES.map(frameTiles => {
    const sc = document.createElement('canvas'); sc.width = 16; sc.height = 8;
    const sctx2 = sc.getContext('2d');
    for (let t = 0; t < 2; t++) _blitTile(sctx2, decodeTile(frameTiles[t], 0), palette, t * 8, 0);
    return sc;
  });

  return {
    poses: {
      idle: battleSpriteCanvas, idleFade: battleSpriteFadeCanvases, silhouette: silhouetteCanvas,
      rBack: battleSpriteAttackCanvas, lBack: battleSpriteAttackLCanvas,
      rFwd: battleSpriteAttack2Canvas, lFwd: null,
      knifeR: battleSpriteKnifeRCanvas, knifeL: battleSpriteKnifeLCanvas, knifeBack: battleSpriteKnifeBackCanvas,
      victory: battleSpriteVictoryCanvas, hit: battleSpriteHitCanvas,
      defend: battleSpriteDefendCanvas, defendFade: battleSpriteDefendFadeCanvases,
      kneel: battleSpriteKneelCanvas, kneelFade: battleSpriteKneelFadeCanvases,
    },
    defendSparkleFrames, cureSparkleFrames, sweatFrames,
  };
}

export function initBattleSprite(romData) {
  const palette = [0x0F, romData[BATTLE_PAL_ROM], romData[BATTLE_PAL_ROM + 1], romData[BATTLE_PAL_ROM + 2]];

  const idle = _initBattleIdleSprites(romData, palette);
  const atk = _initBattleAttackSprites(palette, idle.battleSpriteCanvas);
  const knife = _initBattleKnifeBodySprites(palette);
  initWeaponSprites(palette);
  const rom = _initBattleRomPoses(romData, palette);
  const def = _initBattleDefendSprites(palette);
  const low = _initBattleLowHPSprites(palette);

  return {
    poses: {
      idle: idle.battleSpriteCanvas, idleFade: idle.battleSpriteFadeCanvases, silhouette: idle.silhouetteCanvas,
      rBack: atk.battleSpriteAttackCanvas, lBack: atk.battleSpriteAttackLCanvas,
      rFwd: rom.battleSpriteAttack2Canvas, lFwd: atk.battleSpriteAttackL2Canvas,
      knifeR: knife.battleSpriteKnifeRCanvas, knifeL: knife.battleSpriteKnifeLCanvas, knifeBack: knife.battleSpriteKnifeBackCanvas,
      victory: rom.battleSpriteVictoryCanvas, hit: rom.battleSpriteHitCanvas,
      defend: def.battleSpriteDefendCanvas, defendFade: def.battleSpriteDefendFadeCanvases,
      kneel: low.battleSpriteKneelCanvas, kneelFade: low.battleSpriteKneelFadeCanvases,
    },
    defendSparkleFrames: def.defendSparkleFrames,
    cureSparkleFrames: def.cureSparkleFrames,
    sweatFrames: low.sweatFrames,
  };
}

// --- Fake player portraits and full-body canvases ---

function _initFakePosePortraits(romData) {
  const idleTiles = _FP_IDLE_PPU.map(d => decodeTile(d, 0));
  const fakePlayerPortraits         = _genPosePortraits(idleTiles);
  const fakePlayerVictoryPortraits  = _genPosePortraits(_FP_VICTORY.map(d => decodeTile(d, 0)));
  const fakePlayerHitPortraits      = _genPosePortraits([0,1,2,3].map(i => decodeTile(romData, BATTLE_SPRITE_ROM + (30 + i) * 16)));
  const fakePlayerDefendPortraits   = _genPosePortraits(_FP_DEFEND.map(d => decodeTile(d, 0)));
  const fakePlayerAttackPortraits   = _genPosePortraits([idleTiles[0], idleTiles[1], decodeTile(_FP_ATK_R_TILE, 0), idleTiles[3]]);
  const fakePlayerAttackLPortraits  = _genPosePortraits([idleTiles[0], idleTiles[1], idleTiles[2], decodeTile(_FP_KNIFE_L[3], 0)]);
  const fakePlayerKnifeBackPortraits = _genPosePortraits(_FP_KNIFE_BACK.map(d => decodeTile(d, 0)));
  const fakePlayerKnifeRPortraits   = _genPosePortraits(_FP_KNIFE_R.map(d => decodeTile(d, 0)));
  const fakePlayerKnifeLPortraits   = _genPosePortraits(_FP_KNIFE_L.map(d => decodeTile(d, 0)));
  const fakePlayerKneelPortraits    = _genPosePortraits(_FP_KNEEL.map(d => decodeTile(d, 0)));
  return {
    fakePlayerPortraits, fakePlayerVictoryPortraits, fakePlayerHitPortraits,
    fakePlayerDefendPortraits, fakePlayerAttackPortraits, fakePlayerAttackLPortraits,
    fakePlayerKnifeBackPortraits, fakePlayerKnifeRPortraits, fakePlayerKnifeLPortraits,
    fakePlayerKneelPortraits,
  };
}

// Generate all portrait types for Warrior from PPU-dumped tiles
function _initWarriorPosePortraits() {
  const d = (raw) => decodeTile(raw, 0);
  const idleTiles = WR_IDLE.map(d);
  const victoryTiles = WR_VICTORY.map(d);
  const hitTiles = WR_HIT.map(d);
  const kneelTiles = WR_KNEEL.map(d);
  const knifeRTiles = [idleTiles[0], idleTiles[1], d(WR_R_BACK_T2), idleTiles[3]];
  const knifeLTiles = [idleTiles[0], idleTiles[1], idleTiles[2], d(WR_L_BACK[3])];
  return {
    fakePlayerPortraits: _genPosePortraits(idleTiles),
    fakePlayerVictoryPortraits: _genPosePortraits(victoryTiles),
    fakePlayerHitPortraits: _genPosePortraits(hitTiles),
    fakePlayerDefendPortraits: _genPosePortraits(victoryTiles),
    fakePlayerAttackPortraits: _genPosePortraits(knifeRTiles),
    fakePlayerAttackLPortraits: _genPosePortraits(knifeLTiles),
    fakePlayerKnifeBackPortraits: _genPosePortraits(knifeLTiles),
    fakePlayerKnifeRPortraits: _genPosePortraits(knifeRTiles),
    fakePlayerKnifeLPortraits: _genPosePortraits(knifeLTiles),
    fakePlayerKneelPortraits: _genPosePortraits(kneelTiles),
  };
}

function _buildIdleFullBodies() {
  const legL = decodeTile(_FP_LEG_L, 0), legR = decodeTile(_FP_LEG_R, 0);
  const tiles = _FP_IDLE_PPU.map(d => decodeTile(d, 0));
  return PLAYER_PALETTES.map(pal => _buildFullBody16x24Canvas(tiles, legL, legR, pal));
}

function _buildKnifeFullBodies() {
  const build = (data, lL, lR, pal) => _buildFullBody16x24Canvas(data.map(d => decodeTile(d, 0)), decodeTile(lL, 0), decodeTile(lR, 0), pal);
  const fakePlayerKnifeRFullBodyCanvases    = PLAYER_PALETTES.map(pal => build(_FP_KNIFE_R,    _FP_LEG_L_BACK_R, _FP_LEG_R_SWING,   pal));
  const fakePlayerKnifeLFullBodyCanvases    = PLAYER_PALETTES.map(pal => build(_FP_KNIFE_L,    _FP_LEG_L_BACK_L, _FP_LEG_R_BACK_L,  pal));
  const fakePlayerKnifeBackFullBodyCanvases = PLAYER_PALETTES.map(pal => build(_FP_KNIFE_BACK, _FP_LEG_L_BACK_L, _FP_LEG_R_BACK_L, pal));
  const _FP_L_FWD = [OK_IDLE[0], OK_IDLE[1], OK_L_FWD_T2, OK_L_FWD_T3];
  const _FP_R_FWD = [OK_IDLE[0], OK_IDLE[1], OK_R_FWD_T2, OK_IDLE[3]];
  const fakePlayerKnifeLFwdFullBodyCanvases = PLAYER_PALETTES.map(pal => build(_FP_L_FWD, _FP_LEG_L_FWD_L, _FP_LEG_R_FWD_L, pal));
  const fakePlayerKnifeRFwdFullBodyCanvases = PLAYER_PALETTES.map(pal => build(_FP_R_FWD, _FP_LEG_L_FWD_R, _FP_LEG_R_SWING, pal));
  const fakePlayerKneelFullBodyCanvases    = PLAYER_PALETTES.map(pal => build(_FP_KNEEL, _FP_LEG_L_KNEEL, _FP_LEG_R_KNEEL, pal));
  const fakePlayerVictoryFullBodyCanvases  = PLAYER_PALETTES.map(pal => build(_FP_VICTORY, _FP_LEG_L_VICTORY, _FP_LEG_R_VICTORY, pal));
  return {
    fakePlayerKnifeRFullBodyCanvases, fakePlayerKnifeLFullBodyCanvases,
    fakePlayerKnifeBackFullBodyCanvases, fakePlayerKnifeLFwdFullBodyCanvases,
    fakePlayerKnifeRFwdFullBodyCanvases, fakePlayerKneelFullBodyCanvases,
    fakePlayerVictoryFullBodyCanvases,
  };
}

function _buildHitFullBodies(romData) {
  const legL = decodeTile(_FP_LEG_L, 0), legR = decodeTile(_FP_LEG_R, 0);
  const hitPortrait4 = [0,1,2,3].map(i => decodeTile(romData, BATTLE_SPRITE_ROM + (30 + i) * 16));
  const hitLeg2 = [34,35].map(i => decodeTile(romData, BATTLE_SPRITE_ROM + i * 16));
  return PLAYER_PALETTES.map(pal =>
    _buildFullBody16x24Canvas([...hitPortrait4], hitLeg2[0], hitLeg2[1], pal));
}

function _buildDeathPoseCanvases() {
  const tiles = OK_DEATH.map(d => decodeTile(d, 0));
  return PLAYER_PALETTES.map(pal => {
    const c = document.createElement('canvas'); c.width = 24; c.height = 16;
    const bctx = c.getContext('2d');
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 3; col++) {
        _renderDecodedTile(bctx, tiles[row * 3 + col], pal, col * 8, row * 8);
      }
    }
    return c;
  });
}

// Build full body canvases for Warrior from PPU-dumped tiles
function _buildWarriorFullBodies() {
  const d = (raw) => decodeTile(raw, 0);
  const idleTiles = WR_IDLE.map(d);
  const hitTiles = WR_HIT.map(d);
  const kneelTiles = WR_KNEEL.map(d);
  const victoryTiles = WR_VICTORY.map(d);
  const knifeRTiles = [idleTiles[0], idleTiles[1], d(WR_R_BACK_T2), idleTiles[3]];
  const knifeLTiles = [idleTiles[0], idleTiles[1], idleTiles[2], d(WR_L_BACK[3])];
  const atkRTiles = [idleTiles[0], idleTiles[1], idleTiles[2], idleTiles[3]];
  const atkLTiles = [idleTiles[0], idleTiles[1], d(WR_L_FWD_T2), d(WR_L_FWD_T3)];
  const build = (tiles, lL, lR) => PLAYER_PALETTES.map(pal => _buildFullBody16x24Canvas(tiles, lL, lR, pal));
  const idleBodies = build(idleTiles, d(WR_LEG_L), d(WR_LEG_R));
  // Death pose uses Warrior-specific tiles
  const deathTiles = WR_DEATH.map(d);
  const deathCanvases = PLAYER_PALETTES.map(pal => {
    const c = document.createElement('canvas'); c.width = 24; c.height = 16;
    const bctx = c.getContext('2d');
    for (let row = 0; row < 2; row++)
      for (let col = 0; col < 3; col++)
        _renderDecodedTile(bctx, deathTiles[row * 3 + col], pal, col * 8, row * 8);
    return c;
  });
  return {
    fakePlayerFullBodyCanvases: idleBodies,
    fakePlayerHitFullBodyCanvases: build(hitTiles, d(WR_LEG_L_HIT), d(WR_LEG_R_HIT)),
    fakePlayerKnifeRFullBodyCanvases: build(knifeRTiles, d(WR_LEG_L_BACK_R), d(WR_LEG_R_SWING)),
    fakePlayerKnifeLFullBodyCanvases: build(knifeLTiles, d(WR_LEG_L_BACK_L), d(WR_LEG_R_BACK_L)),
    fakePlayerKnifeBackFullBodyCanvases: build(knifeLTiles, d(WR_LEG_L_BACK_L), d(WR_LEG_R_BACK_L)),
    fakePlayerKnifeRFwdFullBodyCanvases: build(atkRTiles, d(WR_LEG_L_FWD_R), d(WR_LEG_R_SWING)),
    fakePlayerKnifeLFwdFullBodyCanvases: build(atkLTiles, d(WR_LEG_L_FWD_L), d(WR_LEG_R_FWD_L)),
    fakePlayerKneelFullBodyCanvases: build(kneelTiles, d(WR_LEG_L_KNEEL), d(WR_LEG_R_KNEEL)),
    fakePlayerVictoryFullBodyCanvases: build(victoryTiles, d(WR_LEG_L_VICTORY), d(WR_LEG_R_VICTORY)),
    fakePlayerDeathPoseCanvases: deathCanvases,
    fakePlayerDeathFrames: idleBodies.map(c => _makeDeathFrames(c)),
  };
}

// Monk fake-player portraits/bodies — ROM-read at jobBase 0x50550. Same tile-index
// convention as the generic ROM path: idle 0-3, L-back swap tile 7, R-back swap tile 14,
// victory 24-27, hit 30-33 + legs 34-35, kneel 36-39, default legs 4-5.
// If any pose looks scrambled in-game, PPU-capture the specific tiles (see CLAUDE.md).
// PPU-captured Monk tiles where available; ROM-read fallback for poses not yet captured.
function _initMonkPosePortraits(romData) {
  const d = (raw) => decodeTile(raw, 0);
  const jobBase = BATTLE_SPRITE_ROM + 2 * BATTLE_JOB_SIZE;
  const t = (idx) => decodeTile(romData, jobBase + idx * 16);
  const idleTiles    = MO_IDLE.map(d);
  const knifeRTiles  = [idleTiles[0], idleTiles[1], d(MO_R_BACK_T2), idleTiles[3]];       // R-back: body-TL swaps
  const knifeLTiles  = [idleTiles[0], d(MO_L_BACK_T1), idleTiles[2], d(MO_L_BACK_T3)];    // L-back: head-TR + body-TR swap
  const victoryTiles = MO_VICTORY.map(d);
  const hitTiles     = [t(30), t(31), t(32), t(33)];
  const kneelTiles   = [t(36), t(37), t(38), t(39)];
  const gen = (tiles) => _genPosePortraits(tiles, MONK_PALETTES);
  return {
    fakePlayerPortraits: gen(idleTiles),
    fakePlayerVictoryPortraits: gen(victoryTiles),
    fakePlayerHitPortraits: gen(hitTiles),
    fakePlayerDefendPortraits: gen(victoryTiles),
    fakePlayerAttackPortraits: gen(knifeRTiles),
    fakePlayerAttackLPortraits: gen(knifeLTiles),
    fakePlayerKnifeBackPortraits: gen(knifeLTiles),
    fakePlayerKnifeRPortraits: gen(knifeRTiles),
    fakePlayerKnifeLPortraits: gen(knifeLTiles),
    fakePlayerKneelPortraits: gen(kneelTiles),
  };
}

function _buildMonkFullBodies(romData) {
  const d = (raw) => decodeTile(raw, 0);
  const jobBase = BATTLE_SPRITE_ROM + 2 * BATTLE_JOB_SIZE;
  const t = (idx) => decodeTile(romData, jobBase + idx * 16);
  const idleTiles    = MO_IDLE.map(d);
  const knifeRTiles  = [idleTiles[0], idleTiles[1], d(MO_R_BACK_T2), idleTiles[3]];
  const knifeLTiles  = [idleTiles[0], d(MO_L_BACK_T1), idleTiles[2], d(MO_L_BACK_T3)];
  const victoryTiles = MO_VICTORY.map(d);
  const hitTiles     = [t(30), t(31), t(32), t(33)];
  const kneelTiles   = [t(36), t(37), t(38), t(39)];
  const atkLTiles    = [idleTiles[0], idleTiles[1], d(MO_L_FWD_T2), d(MO_L_FWD_T3)];
  const legL = d(MO_LEG_L), legR = d(MO_LEG_R);
  const legLBackR = d(MO_LEG_L_BACK_R), legRBackR = d(MO_LEG_R_BACK_R);
  const legLFwdR = d(MO_LEG_L_FWD_R), legRSwing = legRBackR; // R leg swing shared across R-back/R-fwd/L-back/L-fwd
  const legLBackL = legLFwdR, legRBackL = legRBackR;          // L-back legs byte-identical to R-fwd L-leg / R-leg swing
  const legLFwdL = legLFwdR, legRFwdL = legRBackR;            // L-fwd legs same bytes
  const legLHit = t(34), legRHit = t(35);
  const build = (tiles, lL, lR) => MONK_PALETTES.map(pal => _buildFullBody16x24Canvas(tiles, lL, lR, pal));
  const idleBodies = build(idleTiles, legL, legR);
  // PPU-captured death pose — 2 rows × 3 cols (24×16 prone sprite)
  const deathTiles = MO_DEATH.map(d);
  const deathCanvases = MONK_PALETTES.map(pal => {
    const c = document.createElement('canvas'); c.width = 24; c.height = 16;
    const bctx = c.getContext('2d');
    for (let row = 0; row < 2; row++)
      for (let col = 0; col < 3; col++)
        _renderDecodedTile(bctx, deathTiles[row * 3 + col], pal, col * 8, row * 8);
    return c;
  });
  return {
    fakePlayerFullBodyCanvases: idleBodies,
    fakePlayerHitFullBodyCanvases: build(hitTiles, legLHit, legRHit),
    fakePlayerKnifeRFullBodyCanvases: build(knifeRTiles, legLBackR, legRBackR),
    fakePlayerKnifeLFullBodyCanvases: build(knifeLTiles, legLBackL, legRBackL),
    fakePlayerKnifeBackFullBodyCanvases: build(knifeLTiles, legLBackL, legRBackL),
    fakePlayerKnifeRFwdFullBodyCanvases: build(idleTiles, legLFwdR, legRSwing),
    fakePlayerKnifeLFwdFullBodyCanvases: build(atkLTiles, legLFwdL, legRFwdL),
    fakePlayerKneelFullBodyCanvases: build(kneelTiles, legL, legR),
    fakePlayerVictoryFullBodyCanvases: build(victoryTiles, d(MO_LEG_L_VICTORY), d(MO_LEG_R_VICTORY)),
    fakePlayerDeathPoseCanvases: deathCanvases,
    fakePlayerDeathFrames: idleBodies.map(c => _makeDeathFrames(c)),
  };
}


export function initFakePlayerPortraits(romData, jobIndices) {
  // Build per-job portrait and body sets
  // jobIndices = array of unique job indices to generate for (e.g. [0, 1, 2])
  const result = {};
  for (const jobIdx of jobIndices) {
    let portraits, bodies;
    if (jobIdx === 0) {
      portraits = _initFakePosePortraits(romData);
      const fullBodies = _buildIdleFullBodies();
      const knifeBodies = _buildKnifeFullBodies();
      const hitBodies = _buildHitFullBodies(romData);
      const deathPoses = _buildDeathPoseCanvases();
      bodies = {
        fakePlayerFullBodyCanvases: fullBodies,
        ...knifeBodies,
        fakePlayerHitFullBodyCanvases: hitBodies,
        fakePlayerDeathPoseCanvases: deathPoses,
        fakePlayerDeathFrames: fullBodies.map(c => _makeDeathFrames(c)),
      };
    } else if (jobIdx === 1) {
      portraits = _initWarriorPosePortraits();
      bodies = _buildWarriorFullBodies();
    } else if (jobIdx === 2) {
      portraits = _initMonkPosePortraits(romData);
      bodies = _buildMonkFullBodies(romData);
    } else {
      // Future jobs will need their own PPU-dumped tiles
      portraits = _initWarriorPosePortraits(); // placeholder
      bodies = _buildWarriorFullBodies();      // placeholder
    }
    result[jobIdx] = { ...portraits, ...bodies };
  }
  return result;
}

export function initAdamantoise(romData) {
  const palTop = [0x0F, 0x0F, LAND_TURTLE_PAL_TOP[1], LAND_TURTLE_PAL_TOP[2]];
  const palBot = [0x0F, 0x0F, LAND_TURTLE_PAL_BOT[3], LAND_TURTLE_PAL_BOT[2]];
  const tiles = [];
  for (let i = 0; i < 4; i++) {
    tiles.push(decodeTile(romData, FF2_ADAMANTOISE_SPRITE + i * 16));
  }

  const normal = document.createElement('canvas');
  normal.width = 16; normal.height = 16;
  const actx = normal.getContext('2d');
  for (let i = 0; i < 4; i++) _renderDecodedTile(actx, tiles[i], i < 2 ? palTop : palBot, _BATTLE_LAYOUT[i][0], _BATTLE_LAYOUT[i][1]);

  const flipped = _hflipCanvas16(normal);
  return { adamantoiseFrames: [normal, flipped] };
}

export function initGoblinSprite(romData) {
  const tiles = [];
  for (let i = 0; i < GOBLIN_TILES; i++) {
    tiles.push(decodeTile(romData, GOBLIN_GFX_OFF + i * 16));
  }

  const goblinBattleCanvas = _renderGoblinSprite(tiles, GOBLIN_PAL0, GOBLIN_PAL1, GOBLIN_TILE_PAL);
  const goblinWhiteCanvas = _makeWhiteCanvas(goblinBattleCanvas);
  const goblinDeathFrames = _makeDeathFrames(goblinBattleCanvas);

  return { goblinBattleCanvas, goblinWhiteCanvas, goblinDeathFrames };
}

export function initInvincibleSprite(romData, titleFadeMax) {
  const tilePixels = new Map();
  for (let i = 0; i < 64; i++)
    tilePixels.set(0xC0 + i, decodeTile(romData, INVINCIBLE_TILE_ROM + i * 16));

  const frameA_grid = [0xE5,0xE4,0xE3,0xE2, 0xE9,0xE8,0xE7,0xE6, 0xED,0xEC,0xEB,0xEA, 0xF1,0xF0,0xEF,0xEE];
  const frameB_grid = [0xF5,0xF4,0xF3,0xF2, 0xF6,0xE8,0xE7,0xE6, 0xF7,0xEC,0xEB,0xEA, 0xFB,0xFA,0xF9,0xF8];

  const invincibleFrames = [
    _renderInvFrame(tilePixels, frameA_grid, INVINCIBLE_PAL),
    _renderInvFrame(tilePixels, frameB_grid, INVINCIBLE_PAL),
  ];

  const fadePals = Array.from({ length: titleFadeMax + 1 }, (_, fl) =>
    INVINCIBLE_PAL.map((c, i) => { if (i === 0) return c; let fc = c; for (let s = 0; s < fl; s++) fc = nesColorFade(fc); return fc; })
  );
  const shipFadeFrames = fadePals.map(p => [_renderInvFrame(tilePixels, frameA_grid, p), _renderInvFrame(tilePixels, frameB_grid, p)]);
  const shadowFade = fadePals.map(p => _renderInvShadow(tilePixels, p));

  return { invincibleFrames, shipFadeFrames, shadowFade };
}

export function initMoogleSprite(romData) {
  const tiles = [];
  for (let i = 0; i < 4; i++) {
    tiles.push(decodeTile(romData, MOOGLE_SPRITE_OFF + i * 16));
  }

  const normal = document.createElement('canvas');
  normal.width = 16; normal.height = 16;
  const mctx = normal.getContext('2d');
  for (let i = 0; i < 4; i++) {
    _blitTile(mctx, tiles[i], MOOGLE_PAL, _BATTLE_LAYOUT[i][0], _BATTLE_LAYOUT[i][1]);
  }

  const flipped = _hflipCanvas16(normal);
  return { moogleFrames: [normal, flipped] };
}

export function initLoadingScreenFadeFrames(romData, ff12Raw) {
  const moogleFadeFrames = [];
  for (let step = 0; step <= LOAD_FADE_MAX; step++) {
    const normal = renderSpriteFaded(romData, MOOGLE_SPRITE_OFF, MOOGLE_PAL, step);
    const flipped = _hflipCanvas16(normal);
    moogleFadeFrames.push([normal, flipped]);
  }

  let bossFadeFrames = null;
  if (ff12Raw) {
    bossFadeFrames = [];
    for (let step = 0; step <= LOAD_FADE_MAX; step++) {
      const normal = renderBossFaded(ff12Raw, step);
      const flipped = _hflipCanvas16(normal);
      bossFadeFrames.push([normal, flipped]);
    }
  }

  return { moogleFadeFrames, bossFadeFrames };
}
