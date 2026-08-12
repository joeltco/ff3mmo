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
import { setLandTurtleFrames, setLandTurtleFadeFrames, setLoadingMoogleFadeFrames, setCrystalFrames } from './npc.js';
import { initCrystalSprite } from './crystal-sprite.js';
import { initTitleWater, initTitleSky, initTitleUnderwater,
         initUnderwaterSprites, initTitleOcean, initTitleLogo } from './title-animations.js';
import { ps, initPlayerStats, initExpTable } from './player-stats.js';
import { initRoster } from './roster.js';
import { titleSt } from './title-screen.js';
import { initMonsterSprites } from './monster-sprites.js';
import { initMusic, initFF1Music, initFF2Music } from './music.js';
import { initCursorTile, initScrollArrows, initAdamantoise,
         initGoblinSprite, initInvincibleSprite, initMoogleSprite,
         initLoadingScreenFadeFrames } from './sprite-init.js';
import { initFakePlayerSprites } from './fake-player-sprites.js';
import { initMissSprite } from './damage-numbers.js';
import { initProjectile } from './projectile-anim.js';
import { initCastAnim } from './cast-anim.js';
import { initSpellAnim } from './spell-anim.js';
import { initSummonAnim } from './summon-anim.js';
import { setStage } from './boot-stage.js';

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
  setStage('sa:initHUD');
  initHUD(rom);

  setStage('sa:cursorTile');
  const ct = initCursorTile(rom);
  ui.cursorTileCanvas = ct.cursorTileCanvas;
  ui.cursorFadeCanvases = ct.cursorFadeCanvases;

  setStage('sa:scrollArrows');
  const sa = initScrollArrows(rom);
  ui.scrollArrowDown = sa.scrollArrowDown;
  ui.scrollArrowUp = sa.scrollArrowUp;
  ui.scrollArrowLeft = sa.scrollArrowLeft;
  ui.scrollArrowRight = sa.scrollArrowRight;
  ui.scrollArrowDownFade = sa.scrollArrowDownFade;
  ui.scrollArrowUpFade = sa.scrollArrowUpFade;
  ui.scrollArrowLeftFade = sa.scrollArrowLeftFade;
  ui.scrollArrowRightFade = sa.scrollArrowRightFade;

  // Battle sprite cache — per-job poses + init-once slash/SW/status
  setStage('sa:jobBattleSprites');
  loadJobBattleSprites(rom, ps.jobIdx);
  setStage('sa:battleSpriteCache');
  initBattleSpriteCache();

  // Fake player portraits & full bodies — keyed by jobIdx.
  //
  // v1.7.937 — was `Array.from({ length: 22 }, (_, i) => i)`, i.e. every job
  // built here, synchronously, before the title screen. That is thousands of
  // canvases for OTHER players' roster/PvP sprites, and it OOM-killed the
  // renderer on an Android 10 device (`DIED-AT stage=initSpriteAssets`).
  // Everything else builds on first access — see fake-player-sprites.js. Only
  // the local player's job is warmed here, so the first frame that draws the
  // player doesn't pay for it mid-render.
  setStage('sa:fakePlayerSprites');
  initFakePlayerSprites(rom, [ps.jobIdx | 0]);

  setStage('sa:roster');
  initRoster();
  setStage('sa:bossSprite');
  loadBossSprite(0xCC); // Land Turtle — only boss in game
  setCrystalFrames(initCrystalSprite()); // Wind Crystal (Land Turtle defeat reveal)

  setStage('sa:goblinSprite');
  const gs = initGoblinSprite(rom);
  battleSt.goblinBattleCanvas = gs.goblinBattleCanvas;
  battleSt.goblinWhiteCanvas = gs.goblinWhiteCanvas;
  battleSt.goblinDeathFrames = gs.goblinDeathFrames;

  setStage('sa:monsterSprites');
  initMonsterSprites();
  setStage('sa:missSprite');
  initMissSprite();
  setStage('sa:projectile');
  initProjectile();
  setStage('sa:castAnim');
  initCastAnim();
  setStage('sa:spellAnim');
  initSpellAnim();
  setStage('sa:summonAnim');
  initSummonAnim();
  setStage('sa:playerStats');
  initPlayerStats(rom);
  setStage('sa:expTable');
  initExpTable(rom);

  setStage('sa:moogleSprite');
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
  initFF2Music(ff2Raw); // FF2 NSF for the elder-house theme

  if (romRaw) {
    // Primary FF3 ROM already loaded — rebuild loading-screen fade frames
    // so the boss silhouette fade is available now that ff2Raw exists.
    const lf2 = initLoadingScreenFadeFrames(romRaw, ff2Raw);
    setLoadingMoogleFadeFrames(lf2.moogleFadeFrames);
    setLandTurtleFadeFrames(lf2.bossFadeFrames);
  }
}
