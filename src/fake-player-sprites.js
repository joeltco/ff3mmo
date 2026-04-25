// Fake-player sprite canvases — keyed by jobIdx: { 0: [...palIdx entries...], 1: [...] }
// All dicts are mutated in place so consumers can import them directly and always see live data.

import { initFakePlayerPortraits } from './sprite-init.js';

export const fakePlayerPortraits = {};
export const fakePlayerVictoryPortraits = {};
export const fakePlayerHitPortraits = {};
export const fakePlayerDefendPortraits = {};
export const fakePlayerKneelPortraits = {};
export const fakePlayerAttackPortraits = {};
export const fakePlayerAttackLPortraits = {};
export const fakePlayerKnifeBackPortraits = {};
export const fakePlayerKnifeRPortraits = {};
export const fakePlayerKnifeLPortraits = {};
export const fakePlayerKnifeRFwdPortraits = {};
export const fakePlayerKnifeLFwdPortraits = {};
export const fakePlayerFullBodyCanvases = {};
export const fakePlayerHitFullBodyCanvases = {};
export const fakePlayerKnifeRFullBodyCanvases = {};
export const fakePlayerKnifeLFullBodyCanvases = {};
export const fakePlayerKnifeBackFullBodyCanvases = {};
export const fakePlayerKnifeRFwdFullBodyCanvases = {};
export const fakePlayerKnifeLFwdFullBodyCanvases = {};
export const fakePlayerKneelFullBodyCanvases = {};
export const fakePlayerVictoryFullBodyCanvases = {};
export const fakePlayerDeathPoseCanvases = {};
export const fakePlayerDeathFrames = {};

const _DICTS = {
  fakePlayerPortraits,
  fakePlayerVictoryPortraits,
  fakePlayerHitPortraits,
  fakePlayerDefendPortraits,
  fakePlayerKneelPortraits,
  fakePlayerAttackPortraits,
  fakePlayerAttackLPortraits,
  fakePlayerKnifeBackPortraits,
  fakePlayerKnifeRPortraits,
  fakePlayerKnifeLPortraits,
  fakePlayerKnifeRFwdPortraits,
  fakePlayerKnifeLFwdPortraits,
  fakePlayerFullBodyCanvases,
  fakePlayerHitFullBodyCanvases,
  fakePlayerKnifeRFullBodyCanvases,
  fakePlayerKnifeLFullBodyCanvases,
  fakePlayerKnifeBackFullBodyCanvases,
  fakePlayerKnifeRFwdFullBodyCanvases,
  fakePlayerKnifeLFwdFullBodyCanvases,
  fakePlayerKneelFullBodyCanvases,
  fakePlayerVictoryFullBodyCanvases,
  fakePlayerDeathPoseCanvases,
  fakePlayerDeathFrames,
};

export function initFakePlayerSprites(romRaw, jobIndices = [0, 1]) {
  const fp = initFakePlayerPortraits(romRaw, jobIndices);
  for (const [key, dict] of Object.entries(_DICTS)) {
    for (const j of jobIndices) {
      if (fp[j] && fp[j][key] !== undefined) dict[j] = fp[j][key];
    }
  }
}
