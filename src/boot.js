// Boot — one-shot asset initialization from FF3 ROM (with FF1 standalone
// for music and FF2 standalone for the Adamantoise sprite). All functions
// are pure ROM-in / canvases-out with side effects only on shared module
// state (hudSt / battleSt / titleSt / ui).

import { initHUD } from './hud-init.js';
import { loadBossSprite } from './boss-sprites.js';
import { initBattleSpriteCache, loadJobBattleSprites } from './battle-sprite-cache.js';
import { hudSt } from './hud-state.js';
import { ui } from './ui-state.js';
import { battleSt } from './battle-state.js';
import { initFlameRawTiles, initStarTiles } from './flame-sprites.js';
import { setLandTurtleFrames, setLandTurtleFadeFrames, setLoadingMoogleFadeFrames } from './npc.js';
import { initTitleWater, initTitleSky, initTitleUnderwater,
         initUnderwaterSprites, initTitleOcean, initTitleLogo } from './title-animations.js';
import { ps, initPlayerStats, initExpTable } from './player-stats.js';
import { initRoster } from './roster.js';
import { titleSt } from './title-screen.js';
import { initMonsterSprites } from './monster-sprites.js';
import { initMusic, initFF1Music } from './music.js';
import { initCursorTile, initScrollArrows, initAdamantoise,
         initGoblinSprite, initInvincibleSprite, initMoogleSprite,
         initLoadingScreenFadeFrames } from './sprite-init.js';
import { initFakePlayerSprites } from './fake-player-sprites.js';
import { initMissSprite } from './damage-numbers.js';
import { initProjectile } from './projectile-anim.js';
import { initCastAnim } from './cast-anim.js';
import { initSpellAnim } from './spell-anim.js';

const TITLE_FADE_MAX = 4;

// FF1+II Famicom compilation was SUROM (extended MMC1 with 512 KB PRG),
// which jsnes can't bank-switch. v1.7.256 split it into two standalones:
//   ff1Raw — FF1 NES (256 KB MMC1, regular) → FF1 battle music
//   ff2Raw — FF2 Famicom (256 KB MMC1, regular) → Adamantoise sprite
// Both run cleanly in jsnes for in-app PPU capture.
let ff1Raw = null;
let ff2Raw = null;

// Accessors for the EMU tab's ROM toggle. Return null until the
// corresponding loadFFnROM has been called.
export function getFF1Raw() { return ff1Raw; }
export function getFF2Raw() { return ff2Raw; }
export let romRaw = null; // Primary FF3 ROM — live binding: also consumed by job-sprites.js after init

export function initSpriteAssets(rom) {
  romRaw = rom;
  initHUD(rom);

  const ct = initCursorTile(rom);
  ui.cursorTileCanvas = ct.cursorTileCanvas;
  ui.cursorFadeCanvases = ct.cursorFadeCanvases;

  const sa = initScrollArrows(rom);
  ui.scrollArrowDown = sa.scrollArrowDown;
  ui.scrollArrowUp = sa.scrollArrowUp;
  ui.scrollArrowDownFade = sa.scrollArrowDownFade;
  ui.scrollArrowUpFade = sa.scrollArrowUpFade;

  // Battle sprite cache — per-job poses + init-once slash/SW/status
  loadJobBattleSprites(rom, ps.jobIdx);
  initBattleSpriteCache();

  // Fake player portraits & full bodies — keyed by jobIdx
  initFakePlayerSprites(rom, Array.from({ length: 22 }, (_, i) => i));

  initRoster();
  loadBossSprite(0xCC); // Land Turtle — only boss in game

  const gs = initGoblinSprite(rom);
  battleSt.goblinBattleCanvas = gs.goblinBattleCanvas;
  battleSt.goblinWhiteCanvas = gs.goblinWhiteCanvas;
  battleSt.goblinDeathFrames = gs.goblinDeathFrames;

  initMonsterSprites();
  initMissSprite();
  initProjectile();
  initCastAnim();
  initSpellAnim();
  initPlayerStats(rom);
  initExpTable(rom);

  const ms = initMoogleSprite(rom);
  hudSt.moogleFrames = ms.moogleFrames;

  const lf = initLoadingScreenFadeFrames(rom, ff2Raw);
  setLoadingMoogleFadeFrames(lf.moogleFadeFrames);
  setLandTurtleFadeFrames(lf.bossFadeFrames);

  initMusic(rom);
  initFlameRawTiles(rom);
  initStarTiles(rom);
}

export function initTitleAssets(rom) {
  const inv = initInvincibleSprite(rom, TITLE_FADE_MAX);
  hudSt.invincibleFrames = inv.invincibleFrames;
  titleSt.shipFadeFrames = inv.shipFadeFrames;
  titleSt.shadowFade = inv.shadowFade;
  const _tw = initTitleWater(rom, TITLE_FADE_MAX);
  titleSt.waterFrames = _tw.titleWaterFrames;
  titleSt.waterFadeTiles = _tw.titleWaterFadeTiles;
  titleSt.skyFrames = initTitleSky(rom);
  titleSt.underwaterFrames = initTitleUnderwater(rom);
  titleSt.bubbleTiles = initUnderwaterSprites(rom).uwBubbleTiles;
  titleSt.oceanFrames = initTitleOcean(rom);
  titleSt.logoFrames = initTitleLogo();
}

// FF1 standalone NES ROM — provides FF1 battle music (bank $0D). Called
// by index.html once the secondary ROM is available (may arrive before
// or after loadROM depending on which file the user selects first).
export function loadFF1ROM(arrayBuffer) {
  ff1Raw = new Uint8Array(arrayBuffer);
  initFF1Music(ff1Raw);
}

// FF2 standalone Famicom ROM — provides the Adamantoise boss sprite at
// offset 0xBF10 (FF2 bank $02 + $3F00). Drives the loading-screen boss
// silhouette fade alongside the moogle.
export function loadFF2ROM(arrayBuffer) {
  ff2Raw = new Uint8Array(arrayBuffer);
  const ad = initAdamantoise(ff2Raw);
  setLandTurtleFrames(ad.adamantoiseFrames);
  if (romRaw) {
    // Primary FF3 ROM already loaded — rebuild loading-screen fade frames
    // so the boss silhouette fade is available now that ff2Raw exists.
    const lf2 = initLoadingScreenFadeFrames(romRaw, ff2Raw);
    setLoadingMoogleFadeFrames(lf2.moogleFadeFrames);
    setLandTurtleFadeFrames(lf2.bossFadeFrames);
  }
}
