// Battle sprite cache — canvases built once from ROM, swapped on job change.
// Exported as a single `bsc` object so consumers import the reference once and
// always see live values (fields are reassigned on job swap and per-hit).

import { weaponSubtype } from './data/items.js';
import { initBattleSpriteForJob, initStatusSprites } from './sprite-init.js';
import { initSlashSprites, initKnifeSlashSprites, initSwordSlashSprites, initStaffSlashSprites } from './slash-effects.js';
import { initSouthWindSprite } from './south-wind.js';
import { initCureAnimSprites } from './cure-anim.js';

export const bsc = {
  // Per-job poses (reassigned on job swap)
  battlePoses: { idle: null, idleFade: [], rBack: null, lBack: null, rFwd: null, lFwd: null,
    knifeR: null, knifeL: null, knifeBack: null, victory: null, defend: null, defendFade: [],
    hit: null, kneel: null, kneelFade: [], silhouette: null },
  sweatFrames: [],
  defendSparkleFrames: [],
  cureSparkleFrames: [],

  // Cure spell — captured from PPU via REC OAM. Built once at boot.
  cureCircleFrames: [],     // [size1, size2, size3, size4, brackets]
  cureBgSparkle: null,      // 8×8 build-up sparkle
  cureHealSparkleFrame: null, // 16×16 phase-4 target sparkle (replaces placeholder later)

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
  nunchakuSlashFramesR: null,
  nunchakuSlashFramesL: null,
  staffSlashFramesR: null,
  staffSlashFramesL: null,
};

export function getSlashFramesForWeapon(id, rightHand) {
  const st = weaponSubtype(id);
  if (st === 'knife' || st === 'dagger') return rightHand ? bsc.knifeSlashFramesR : bsc.knifeSlashFramesL;
  if (st === 'sword') return rightHand ? bsc.swordSlashFramesR : bsc.swordSlashFramesL;
  if (st === 'nunchaku') return rightHand ? bsc.nunchakuSlashFramesR : bsc.nunchakuSlashFramesL;
  if (st === 'staff' || st === 'rod') return rightHand ? bsc.staffSlashFramesR : bsc.staffSlashFramesL;
  return rightHand ? bsc.slashFramesR : bsc.slashFramesL;
}

// Per-weapon slash scatter pattern + offset helpers live in slash-effects.js
// (alongside drawSlashOverlay and the slash sprite builders). Re-export here so
// callers don't need to know which file owns what.
export { getSlashPattern, setSlashOffsetForFrame } from './slash-effects.js';

// Init-once caches (slash/SW/status). Call once per ROM load.
export function initBattleSpriteCache() {
  bsc.swPhaseCanvases = initSouthWindSprite();
  bsc.slashFrames = bsc.slashFramesR = bsc.slashFramesL = initSlashSprites();
  bsc.knifeSlashFramesR = bsc.knifeSlashFramesL = initKnifeSlashSprites();
  bsc.swordSlashFramesR = bsc.swordSlashFramesL = initSwordSlashSprites();
  // Staff and nunchaku share the same slash hit-flash sprite — PPU captures of both
  // weapons returned byte-identical tile data (just at different CHR addresses).
  bsc.staffSlashFramesR = bsc.staffSlashFramesL = initStaffSlashSprites();
  bsc.nunchakuSlashFramesR = bsc.nunchakuSlashFramesL = bsc.staffSlashFramesR;
  bsc.statusSpriteMap = initStatusSprites();
  bsc.poisonBubbleFrames = bsc.statusSpriteMap.get(0x02) || [];
  const cure = initCureAnimSprites();
  bsc.cureCircleFrames = cure.circleFrames;
  bsc.cureBgSparkle = cure.bgSparkle;
  bsc.cureHealSparkleFrame = cure.healSparkleFrame;
}

// Per-job battle sprites — call at boot and on job change.
export function loadJobBattleSprites(romRaw, jobIdx) {
  const bs = initBattleSpriteForJob(romRaw, jobIdx);
  bsc.battlePoses = bs.poses;
  bsc.defendSparkleFrames = bs.defendSparkleFrames;
  bsc.cureSparkleFrames = bs.cureSparkleFrames;
  bsc.sweatFrames = bs.sweatFrames;
}
