// Battle sprite cache — canvases built once from ROM, swapped on job change.
// Exported as a single `bsc` object so consumers import the reference once and
// always see live values (fields are reassigned on job swap and per-hit).

import { weaponSubtype } from './data/items.js';
import { initBattleSpriteForJob, initStatusSprites } from './sprite-init.js';
import { initSlashSprites, initKnifeSlashSprites, initSwordSlashSprites } from './slash-effects.js';
import { initSouthWindSprite } from './south-wind.js';

export const bsc = {
  // Per-job poses (reassigned on job swap)
  battlePoses: { idle: null, idleFade: [], rBack: null, lBack: null, rFwd: null, lFwd: null,
    knifeR: null, knifeL: null, knifeBack: null, victory: null, defend: null, defendFade: [],
    hit: null, kneel: null, kneelFade: [], silhouette: null },
  sweatFrames: [],
  defendSparkleFrames: [],
  cureSparkleFrames: [],

  // Status animation sprites (built once at boot; `poisonBubbleFrames` is an alias into the map)
  statusSpriteMap: new Map(),
  poisonBubbleFrames: [],

  // South-wind expanding ice explosion phases (built once)
  swPhaseCanvases: [],

  // Slash frames (built once; `slashFrames` alias flips to R or L per-hit)
  slashFramesR: null,
  slashFramesL: null,
  slashFrames: null,
  knifeSlashFramesR: null,
  knifeSlashFramesL: null,
  swordSlashFramesR: null,
  swordSlashFramesL: null,
};

export function getSlashFramesForWeapon(id, rightHand) {
  const st = weaponSubtype(id);
  if (st === 'knife' || st === 'dagger') return rightHand ? bsc.knifeSlashFramesR : bsc.knifeSlashFramesL;
  if (st === 'sword') return rightHand ? bsc.swordSlashFramesR : bsc.swordSlashFramesL;
  return rightHand ? bsc.slashFramesR : bsc.slashFramesL;
}

// Init-once caches (slash/SW/status). Call once per ROM load.
export function initBattleSpriteCache() {
  bsc.swPhaseCanvases = initSouthWindSprite();
  bsc.slashFrames = bsc.slashFramesR = bsc.slashFramesL = initSlashSprites();
  bsc.knifeSlashFramesR = bsc.knifeSlashFramesL = initKnifeSlashSprites();
  bsc.swordSlashFramesR = bsc.swordSlashFramesL = initSwordSlashSprites();
  bsc.statusSpriteMap = initStatusSprites();
  bsc.poisonBubbleFrames = bsc.statusSpriteMap.get(0x02) || [];
}

// Per-job battle sprites — call at boot and on job change.
export function loadJobBattleSprites(romRaw, jobIdx) {
  const bs = initBattleSpriteForJob(romRaw, jobIdx);
  bsc.battlePoses = bs.poses;
  bsc.defendSparkleFrames = bs.defendSparkleFrames;
  bsc.cureSparkleFrames = bs.cureSparkleFrames;
  bsc.sweatFrames = bs.sweatFrames;
}
