// Sprite initialization — pure init functions that read ROM data and produce canvases.
// Extracted from game.js — these run once at startup.

import { NES_SYSTEM_PALETTE, decodeTile } from './tile-decoder.js';
import { nesColorFade } from './palette.js';
import { _makeCanvas16, _makeCanvas16ctx, _hflipCanvas16, _makeWhiteCanvas } from './canvas-utils.js';
import { BAYER4 } from './data/animation-tables.js';
import { _writePixels64 } from './tile-math.js';
import { PLAYER_PALETTES, MONK_PALETTES, ROSTER_FADE_STEPS } from './data/players.js';
import { BATTLE_SPRITE_ROM, BATTLE_JOB_SIZE, BATTLE_PAL_ROM } from './data/jobs.js';
// WR / MO tile constants are no longer imported — those jobs now go through
// `_buildFakePlayerSet` → `getJobPoseTileBundle`. OK_* tiles are still used by
// the player-portrait builders below (`_FP_*` constants), which haven't been
// migrated to the bundle path yet.
import {
  OK_IDLE, OK_VICTORY, OK_KNEEL,
  OK_R_BACK_SWING, OK_L_BACK_SWING, OK_L_FWD_T2, OK_L_FWD_T3, OK_R_FWD_T2,
  OK_LEG_L_IDLE, OK_LEG_R_IDLE,
  OK_LEG_L_BACK_L, OK_LEG_R_BACK_L, OK_LEG_L_FWD_L, OK_LEG_R_FWD_L,
  OK_LEG_L_BACK_R, OK_LEG_L_FWD_R, OK_LEG_R_SWING,
  OK_LEG_L_KNEEL, OK_LEG_R_KNEEL, OK_LEG_L_VICTORY, OK_LEG_R_VICTORY,
} from './data/job-sprites.js';
import { initWeaponSprites } from './weapon-sprites.js';
import { getJobPoseTileBundle, buildPlayerPoseCanvases, buildAllyPosePortraits, buildOpponentBodyCanvases, buildDeathPoseCanvases, POSE_KEYS } from './combatant-sprites.js';
import { LOAD_FADE_MAX } from './loading-screen.js';

// --- Constants (moved from game.js, only used by init code) ---

// Adamantoise sprite — 4 tiles, 16×16, row-major (TL,TR,BL,BR). Offset
// inside the FF2 standalone Famicom ROM (FF2 bank $02 + $3F00). The old
// FF1+II compilation offset 0x04BF10 = FF1's 256 KB + this same FF2
// offset; we switched to standalones in v1.7.256 because the FF1+II
// cart is SUROM and jsnes can't bank-switch past 256 KB PRG.
const FF2_ADAMANTOISE_SPRITE = 0x0BF10;
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

// Shared overlay tiles (defend sparkle + sweat drop). Used by every job's player sprite set.
const _SHARED_DEFEND_SPARKLE_TILES = [
  new Uint8Array([0x01,0x00,0x08,0x00,0x00,0x41,0x00,0x02, 0x00,0x00,0x01,0x02,0x00,0x09,0x00,0x12]),
  new Uint8Array([0x00,0x00,0x00,0x04,0x0A,0x14,0x0A,0x01, 0x00,0x00,0x00,0x18,0x1C,0x0E,0x04,0x00]),
  new Uint8Array([0x00,0x00,0x20,0x10,0x08,0x04,0x00,0x00, 0x00,0x00,0x30,0x38,0x10,0x00,0x00,0x00]),
  new Uint8Array([0x80,0x00,0x20,0x00,0x00,0x00,0x00,0x00, 0x80,0x40,0x00,0x00,0x00,0x00,0x00,0x00]),
];
const _SHARED_SWEAT_FRAME_TILES = [
  [new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x04,0x00,0x40,0x00,0x00,0x00,0x00,0x00]),
   new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x20,0x00,0x02,0x00,0x00,0x00,0x00,0x00])],
  [new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x02,0x10,0x00,0x40,0x00]),
   new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x40,0x08,0x00,0x02,0x00])],
];
function _buildSharedDefendSparkleFrames() {
  return _SHARED_DEFEND_SPARKLE_TILES.map(raw => {
    const sc = document.createElement('canvas'); sc.width = 8; sc.height = 8;
    _blitTile(sc.getContext('2d'), decodeTile(raw, 0), DEFEND_SPARKLE_PAL, 0, 0); return sc;
  });
}
function _buildSharedSweatFrames(palette) {
  return _SHARED_SWEAT_FRAME_TILES.map(frameTiles => {
    const sc = document.createElement('canvas'); sc.width = 16; sc.height = 8;
    const sctx2 = sc.getContext('2d');
    for (let t = 0; t < 2; t++) _blitTile(sctx2, decodeTile(frameTiles[t], 0), palette, t * 8, 0);
    return sc;
  });
}

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
  _drawTileOnto(_FP_KNIFE_L[1], palette, alctx, 8, 0); // L-back head-TR variant
  _drawTileOnto(_FP_KNIFE_L[3], palette, alctx, 8, 8); // L-back body-TR variant

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
  // Heal-phase sparkle tiles — captured via REC OAM at frame 73 (phase 4 of the
  // Cure animation, after MMC3 CHR rebank). $4A is a small 4-color cross, $49 is
  // a fatter asterisk. Pre-1.7.10 these were placeholder bytes that didn't match
  // the running ROM; the real bytes give a more legible flicker.
  const CURE_TILE_4D = new Uint8Array([0x00,0x00,0x00,0x00,0x08,0x00,0x00,0x00, 0x00,0x00,0x00,0x08,0x1C,0x08,0x00,0x00]); // ROM tile $4A (heal-phase CHR)
  const CURE_TILE_4E = new Uint8Array([0x10,0x10,0x28,0xD6,0x28,0x10,0x10,0x00, 0x00,0x00,0x10,0x38,0x10,0x00,0x00,0x00]); // ROM tile $49 (heal-phase CHR)
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
  // Defend, item-use, and magic-cast all share the victory pose in FF3.
  // Using OK_VICTORY directly keeps all three in lock-step — no duplicated byte arrays to drift.
  const battleSpriteDefendCanvas = _buildCanvas4(OK_VICTORY, palette);
  const battleSpriteDefendFadeCanvases = _buildFadedCanvas4Set(OK_VICTORY, palette);

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

// Sweat droplets — always white regardless of body palette. Tile bytes are
// sparse (1-2 pixels set per droplet) so only index 1 / 2 typically render.
// Pre-v1.7.211 this used the body palette and droplets took on skin/hair
// colors, which read wrong.
const SWEAT_PAL = [0x0F, 0x30, 0x30, 0x30]; // transparent + pure white

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
      _blitTile(sctx, decodeTile(frameTiles[t], 0), SWEAT_PAL, t * 8, 0);
    }
    return sc;
  });

  return { battleSpriteKneelCanvas, battleSpriteKneelFadeCanvases, sweatFrames };
}

// Status effect sprite animations — 2-frame 16×8 each, from ROM $1B250-$1B440.
// Palette per status group (NES FF3 disasm groups; values designer-picked
// 2026-05-10, not from REC OAM capture):
//   pal0 — paralysis / silence / poison / near-fatal (pink/red, vibrant)
//   pal1 — sleep (blue, "Zzz" cool-color cliché)
//   pal2 — confused (purple/magenta, swirly stars cliché)
//   pal3 — blind / petrify (gray/stone, dim)
// Index 0 is transparent in sprite context; visible colors are indices 1-3.
const STATUS_PAL0 = [0x0F, 0x36, 0x30, 0x16]; // pink outline / white fill / dark red shadow
const STATUS_PAL1 = [0x0F, 0x21, 0x30, 0x11]; // light blue outline / white fill / med blue shadow — sleep
const STATUS_PAL2 = [0x0F, 0x24, 0x30, 0x14]; // magenta / white / dark purple — confused
const STATUS_PAL3 = [0x0F, 0x00, 0x30, 0x0F]; // light gray / white / black — blind/petrify

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
  2: [0x27, 0x18, 0x21],  // Monk — canonical blue gi
  4: [0x27, 0x18, 0x21],  // Black Mage — same canon palette as Monk per PPU capture 2026-05-07
};

// Build all battle sprite canvases for a given job index (0=Onion Knight, 1=Warrior, etc.)
// Single-source player sprite builder. All 22 jobs run through here — pose tile
// definitions live in combatant-sprites.js (one bundle per job class), this function
// just wraps them with palette + fade variants + silhouette + shared overlays.
function _buildPlayerSpriteSet(romData, jobIdx, palette) {
  const bundle = getJobPoseTileBundle(romData, jobIdx);
  const base = buildPlayerPoseCanvases(bundle, palette);
  const renderFaded = (poseKey) => {
    const arr = [];
    for (let step = 1; step <= HUD_INFO_FADE_STEPS; step++) {
      let fp = [...palette]; for (let s = 0; s < step; s++) fp = fp.map(c => nesColorFade(c));
      arr.push(_renderPortrait(bundle.bodies[poseKey], _BATTLE_LAYOUT, fp));
    }
    return arr;
  };
  // Silhouette: re-color all opaque idle pixels to NES $00 (grey/black).
  const silhouetteCanvas = document.createElement('canvas');
  silhouetteCanvas.width = 16; silhouetteCanvas.height = 16;
  const sctx = silhouetteCanvas.getContext('2d');
  sctx.drawImage(base.idle, 0, 0);
  const sdata = sctx.getImageData(0, 0, 16, 16);
  const darkRgb = NES_SYSTEM_PALETTE[0x00] || [0, 0, 0];
  for (let p = 0; p < 256; p++) {
    if (sdata.data[p * 4 + 3] > 0) { sdata.data[p * 4] = darkRgb[0]; sdata.data[p * 4 + 1] = darkRgb[1]; sdata.data[p * 4 + 2] = darkRgb[2]; }
  }
  sctx.putImageData(sdata, 0, 0);

  initWeaponSprites(palette);

  return {
    poses: {
      idle: base.idle, idleFade: renderFaded('idle'), silhouette: silhouetteCanvas,
      rBack: base.rBack, lBack: base.lBack,
      rFwd: base.rFwd, lFwd: base.lFwd,
      knifeR: base.knifeR, knifeL: base.knifeL, knifeBack: base.lBack, // knifeBack legacy alias for L-back canvas
      knifeRFwd: base.knifeRFwd, knifeLFwd: base.knifeLFwd,
      victory: base.victory, hit: base.hit,
      defend: base.victory, defendFade: renderFaded('victory'),
      kneel: base.kneel, kneelFade: renderFaded('kneel'),
      palette,
    },
    defendSparkleFrames: _buildSharedDefendSparkleFrames(),
    cureSparkleFrames: _initCureSparkleFrames(),
    sweatFrames: _buildSharedSweatFrames(palette),
  };
}

export function initBattleSpriteForJob(romData, jobIdx) {
  const pov = JOB_BATTLE_PAL_OVERRIDE[jobIdx];
  const palette = pov
    ? [0x0F, pov[0], pov[1], pov[2]]
    : [0x0F, romData[BATTLE_PAL_ROM], romData[BATTLE_PAL_ROM + 1], romData[BATTLE_PAL_ROM + 2]];
  return _buildPlayerSpriteSet(romData, jobIdx, palette);
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
      palette,
    },
    defendSparkleFrames: def.defendSparkleFrames,
    cureSparkleFrames: def.cureSparkleFrames,
    sweatFrames: low.sweatFrames,
  };
}


// Unified ally + opponent builder (uses combatant-sprites bundle). Rolled out per-job
// so any regression has a small surface — see _USE_BUNDLE_FOR_ALLY below.
function _buildFakePlayerSet(romData, jobIdx) {
  const bundle = getJobPoseTileBundle(romData, jobIdx);
  const portraits = buildAllyPosePortraits(bundle);
  const bodies    = buildOpponentBodyCanvases(bundle);
  const deathPoses = buildDeathPoseCanvases(bundle);
  return {
    fakePlayerPortraits:           portraits.idle,
    fakePlayerVictoryPortraits:    portraits.victory,
    fakePlayerHitPortraits:        portraits.hit,
    fakePlayerDefendPortraits:     portraits.victory,
    fakePlayerKneelPortraits:      portraits.kneel,
    fakePlayerAttackPortraits:     portraits.rBack,
    fakePlayerAttackLPortraits:    portraits.lBack,
    fakePlayerKnifeBackPortraits:  portraits.lBack,
    fakePlayerKnifeRPortraits:     portraits.knifeR,
    fakePlayerKnifeLPortraits:     portraits.knifeL,
    fakePlayerKnifeRFwdPortraits:  portraits.knifeRFwd,
    fakePlayerKnifeLFwdPortraits:  portraits.knifeLFwd,
    fakePlayerFullBodyCanvases:           bodies.idle,
    fakePlayerHitFullBodyCanvases:        bodies.hit,
    fakePlayerKnifeRFullBodyCanvases:     bodies.knifeR,
    fakePlayerKnifeLFullBodyCanvases:     bodies.knifeL,
    fakePlayerKnifeBackFullBodyCanvases:  bodies.knifeL,
    fakePlayerKnifeRFwdFullBodyCanvases:  bodies.knifeRFwd,
    fakePlayerKnifeLFwdFullBodyCanvases:  bodies.knifeLFwd,
    fakePlayerKneelFullBodyCanvases:      bodies.kneel,
    fakePlayerVictoryFullBodyCanvases:    bodies.victory,
    fakePlayerDeathPoseCanvases: deathPoses || bodies.idle,
    fakePlayerDeathFrames:       bodies.idle.map(c => _makeDeathFrames(c)),
  };
}

// All 22 jobs go through the unified bundle path (`_buildFakePlayerSet` →
// `combatant-sprites.getJobPoseTileBundle`). Per-job pose layout is owned by
// that module — see combatant-sprites.js for the canonical tile assignments.
export function initFakePlayerPortraits(romData, jobIndices) {
  const result = {};
  for (const jobIdx of jobIndices) {
    result[jobIdx] = _buildFakePlayerSet(romData, jobIdx);
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

export function initLoadingScreenFadeFrames(romData, ff2Raw) {
  const moogleFadeFrames = [];
  for (let step = 0; step <= LOAD_FADE_MAX; step++) {
    const normal = renderSpriteFaded(romData, MOOGLE_SPRITE_OFF, MOOGLE_PAL, step);
    const flipped = _hflipCanvas16(normal);
    moogleFadeFrames.push([normal, flipped]);
  }

  let bossFadeFrames = null;
  if (ff2Raw) {
    bossFadeFrames = [];
    for (let step = 0; step <= LOAD_FADE_MAX; step++) {
      const normal = renderBossFaded(ff2Raw, step);
      const flipped = _hflipCanvas16(normal);
      bossFadeFrames.push([normal, flipped]);
    }
  }

  return { moogleFadeFrames, bossFadeFrames };
}
