// Boot — one-shot asset initialization from FF3 ROM (and FF1&2 ROM for
// Adamantoise + FF1 music). All functions are pure ROM-in / canvases-out
// with side effects only on shared module state (hudSt/battleSt/titleSt/ui).

import { initHUD } from './hud-init.js';
import { loadBossSprite } from './boss-sprites.js';
import { initBattleSpriteCache, loadJobBattleSprites } from './battle-sprite-cache.js';
import { hudSt } from './hud-state.js';
import { ui } from './ui-state.js';
import { battleSt } from './battle-state.js';
import { initFlameRawTiles, initStarTiles } from './flame-sprites.js';
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

const TITLE_FADE_MAX = 4;

let ff12Raw = null;       // FF1&2 ROM — Adamantoise sprite + FF1 music
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
  initFakePlayerSprites(rom, [0, 1]);

  initRoster();
  loadBossSprite(0xCC); // Land Turtle — only boss in game

  const gs = initGoblinSprite(rom);
  battleSt.goblinBattleCanvas = gs.goblinBattleCanvas;
  battleSt.goblinWhiteCanvas = gs.goblinWhiteCanvas;
  battleSt.goblinDeathFrames = gs.goblinDeathFrames;

  initMonsterSprites();
  initMissSprite();
  initPlayerStats(rom);
  initExpTable(rom);

  const ms = initMoogleSprite(rom);
  hudSt.moogleFrames = ms.moogleFrames;

  const lf = initLoadingScreenFadeFrames(rom, ff12Raw);
  hudSt.moogleFadeFrames = lf.moogleFadeFrames;
  hudSt.bossFadeFrames = lf.bossFadeFrames;

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

// FF1&2 ROM provides Adamantoise boss sprite + FF1 battle music. Called by
// index.html once the secondary ROM is available (may arrive before or after
// loadROM depending on which file the user selects first).
export function loadFF12ROM(arrayBuffer) {
  ff12Raw = new Uint8Array(arrayBuffer);
  const ad = initAdamantoise(ff12Raw);
  hudSt.adamantoiseFrames = ad.adamantoiseFrames;
  initFF1Music(ff12Raw);
  if (romRaw) {
    // Primary ROM already loaded — rebuild loading-screen fade frames so the
    // boss silhouette fade is available now that ff12Raw exists.
    const lf2 = initLoadingScreenFadeFrames(romRaw, ff12Raw);
    hudSt.moogleFadeFrames = lf2.moogleFadeFrames;
    hudSt.bossFadeFrames = lf2.bossFadeFrames;
  }
}
