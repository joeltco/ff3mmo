// Fake-player sprite canvases — keyed by jobIdx: { 0: [...palIdx entries...], 1: [...] }
// All dicts are mutated in place so consumers can import them directly and always see live data.
//
// v1.7.937 — BUILT LAZILY, one job at a time.
//
// Boot used to call `initFakePlayerSprites(rom, [0..21])`, building all 22 jobs
// up front. Each job runs `_buildFakePlayerSet`, which produces ~20 canvas
// groups (12 portrait poses, 9 full-body pose sets, death poses, plus a
// `_makeDeathFrames` pass over every idle body) — thousands of canvases
// allocated synchronously before the title screen ever appears. On an Android
// 10 / Chrome 151 device that killed the renderer outright: the boot stage
// recorder reported `DIED-AT stage=initSpriteAssets` with no throw and no
// beacon, which is what an OOM kill looks like.
//
// These canvases draw OTHER players — roster rows, PvP opponents, AI allies.
// None of it is needed to reach the title screen, and `PLAYER_POOL` ships empty
// by default, so most of that work was for jobs nobody would ever see.
//
// Rather than add an `ensureJob()` call at every site that introduces a player
// (easy to miss one, and a miss means a silently missing sprite), each exported
// dict is a Proxy that builds its job on first access. Consumers keep writing
// `fakePlayerPortraits[jobIdx]` unchanged and cannot forget to warm it.

import { initFakePlayerPortraits } from './sprite-init.js';

// Backing stores. `_ensureJob` writes to THESE, never to the proxies, so
// populating a job can't re-enter the get trap.
const _raw = {
  fakePlayerPortraits: {},
  fakePlayerVictoryPortraits: {},
  fakePlayerHitPortraits: {},
  fakePlayerDefendPortraits: {},
  fakePlayerKneelPortraits: {},
  fakePlayerAttackPortraits: {},
  fakePlayerAttackLPortraits: {},
  fakePlayerKnifeBackPortraits: {},
  fakePlayerKnifeRPortraits: {},
  fakePlayerKnifeLPortraits: {},
  fakePlayerKnifeRFwdPortraits: {},
  fakePlayerKnifeLFwdPortraits: {},
  fakePlayerFullBodyCanvases: {},
  fakePlayerHitFullBodyCanvases: {},
  fakePlayerKnifeRFullBodyCanvases: {},
  fakePlayerKnifeLFullBodyCanvases: {},
  fakePlayerKnifeBackFullBodyCanvases: {},
  fakePlayerKnifeRFwdFullBodyCanvases: {},
  fakePlayerKnifeLFwdFullBodyCanvases: {},
  fakePlayerKneelFullBodyCanvases: {},
  fakePlayerVictoryFullBodyCanvases: {},
  fakePlayerDeathPoseCanvases: {},
  fakePlayerDeathFrames: {},
};

// Jobs are 0..21 (see the `length: 22` the boot path used to pass). Bounding
// keeps a stray non-job index from doing work.
const MAX_JOB_IDX = 21;

let _romRaw = null;
const _built = new Set();

/** Build one job's full sprite set, once. No-op before the ROM is loaded. */
function _ensureJob(jobIdx) {
  if (!Number.isInteger(jobIdx) || jobIdx < 0 || jobIdx > MAX_JOB_IDX) return;
  if (_built.has(jobIdx) || !_romRaw) return;
  // Mark BEFORE building: if the build throws, we must not retry it on every
  // subsequent read — that would turn one bad job into a per-frame stall.
  _built.add(jobIdx);
  let fp;
  try {
    fp = initFakePlayerPortraits(_romRaw, [jobIdx]);
  } catch (e) {
    console.warn('[fake-player-sprites] build failed for job', jobIdx, e && e.message);
    return;
  }
  const set = fp && fp[jobIdx];
  if (!set) return;
  for (const key of Object.keys(_raw)) {
    if (set[key] !== undefined) _raw[key][jobIdx] = set[key];
  }
}

// A numeric read is a job lookup — warm it, then serve. `+prop === +prop` is a
// cheap NaN test; these dicts are read inside render loops, so the trap stays
// allocation-free and regex-free.
function _lazy(target) {
  return new Proxy(target, {
    get(t, prop, recv) {
      if (typeof prop === 'string') { const j = +prop; if (j === j) _ensureJob(j); }
      return Reflect.get(t, prop, recv);
    },
    has(t, prop) {
      if (typeof prop === 'string') { const j = +prop; if (j === j) _ensureJob(j); }
      return Reflect.has(t, prop);
    },
  });
}

export const fakePlayerPortraits = _lazy(_raw.fakePlayerPortraits);
export const fakePlayerVictoryPortraits = _lazy(_raw.fakePlayerVictoryPortraits);
export const fakePlayerHitPortraits = _lazy(_raw.fakePlayerHitPortraits);
export const fakePlayerDefendPortraits = _lazy(_raw.fakePlayerDefendPortraits);
export const fakePlayerKneelPortraits = _lazy(_raw.fakePlayerKneelPortraits);
export const fakePlayerAttackPortraits = _lazy(_raw.fakePlayerAttackPortraits);
export const fakePlayerAttackLPortraits = _lazy(_raw.fakePlayerAttackLPortraits);
export const fakePlayerKnifeBackPortraits = _lazy(_raw.fakePlayerKnifeBackPortraits);
export const fakePlayerKnifeRPortraits = _lazy(_raw.fakePlayerKnifeRPortraits);
export const fakePlayerKnifeLPortraits = _lazy(_raw.fakePlayerKnifeLPortraits);
export const fakePlayerKnifeRFwdPortraits = _lazy(_raw.fakePlayerKnifeRFwdPortraits);
export const fakePlayerKnifeLFwdPortraits = _lazy(_raw.fakePlayerKnifeLFwdPortraits);
export const fakePlayerFullBodyCanvases = _lazy(_raw.fakePlayerFullBodyCanvases);
export const fakePlayerHitFullBodyCanvases = _lazy(_raw.fakePlayerHitFullBodyCanvases);
export const fakePlayerKnifeRFullBodyCanvases = _lazy(_raw.fakePlayerKnifeRFullBodyCanvases);
export const fakePlayerKnifeLFullBodyCanvases = _lazy(_raw.fakePlayerKnifeLFullBodyCanvases);
export const fakePlayerKnifeBackFullBodyCanvases = _lazy(_raw.fakePlayerKnifeBackFullBodyCanvases);
export const fakePlayerKnifeRFwdFullBodyCanvases = _lazy(_raw.fakePlayerKnifeRFwdFullBodyCanvases);
export const fakePlayerKnifeLFwdFullBodyCanvases = _lazy(_raw.fakePlayerKnifeLFwdFullBodyCanvases);
export const fakePlayerKneelFullBodyCanvases = _lazy(_raw.fakePlayerKneelFullBodyCanvases);
export const fakePlayerVictoryFullBodyCanvases = _lazy(_raw.fakePlayerVictoryFullBodyCanvases);
export const fakePlayerDeathPoseCanvases = _lazy(_raw.fakePlayerDeathPoseCanvases);
export const fakePlayerDeathFrames = _lazy(_raw.fakePlayerDeathFrames);

/**
 * Register the ROM and eagerly build only the jobs passed in. Every other job
 * builds on first access. Signature is unchanged, so callers that want a job
 * warmed ahead of a render frame can still ask for it by name.
 */
export function initFakePlayerSprites(romRaw, jobIndices = [0]) {
  _romRaw = romRaw;
  for (const j of jobIndices) _ensureJob(j | 0);
}

/** Test/debug hook — which jobs have actually been built. */
export function _builtJobCount() { return _built.size; }
