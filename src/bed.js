// bed.js — inn bed rest scene.
//
// Step onto any bed tile (data/beds.js — tile-id driven, every present/future
// bed works with no per-map setup) to rest. No cost; refills HP/MP only
// (status untouched).
//
// Lifecycle: closed → settle → fade-out → sleep(6s) → wake-wait → fade-in → closed.
//   settle    — brief beat showing the player standing on the bed before it dims
//               (so you see the full step land). Music pauses + rest jingle plays.
//   fade-out  — the captured FF3 inn palette ramp (nes-palette-fade.js, discrete
//               hardware steps — NOT an alpha crossfade).
//   sleep     — 6s dark hold, input drained (the rest can't be skipped).
//   wake-wait — dark hold + prompt; press A (z) or B (x) to wake.
//   fade-in   — palette ramp in reverse, then close.
//
// Wired in game-loop (update/draw), movement (input gate), map-triggers
// (step-on via MapRenderer.isBedTileAt, fired from _onMoveComplete so the step
// is always fully complete first).

import { ps } from './player-stats.js';
import { saveSlotsToDB } from './save-state.js';
import { pauseMusic, resumeMusic, playSFX, stopSFX } from './music.js';
import { ui } from './ui-state.js';
import { drawText, measureText } from './font-renderer.js';
import { buildPaletteFade, applyPaletteLut } from './nes-palette-fade.js';
import { INN_FADE_KEYS } from './data/inn-fade-palette.js';

// Inner map viewport (the area that dims — HUD chrome stays put).
const HUD_VIEW_X = 0, HUD_VIEW_Y = 32, HUD_VIEW_W = 144, HUD_VIEW_H = 144;
const INNER_X = HUD_VIEW_X + 8, INNER_Y = HUD_VIEW_Y + 8;
const INNER_W = HUD_VIEW_W - 16, INNER_H = HUD_VIEW_H - 16;

const FADE = buildPaletteFade(INN_FADE_KEYS);  // captured inn fade (discrete steps)
const FADE_MS  = FADE.durationMs;              // ≈667ms, true NTSC cadence
const SETTLE_MS = 300;    // show the landed step before the room dims
const SLEEP_MS  = 6000;   // forced dark hold before the wake prompt
const REST_JINGLE = 0;    // inn rest tune — first track in the FF3 NSF playlist

const PROMPT     = 'Press A or B';
const PROMPT_PAL = [0x0F, 0x10, 0x0F, 0x30];

export const bedSt = {
  state:  'closed',   // closed | settle | fade-out | sleep | wake-wait | fade-in
  timer:  0,
  healed: false,
};

export function openBed() {
  if (bedSt.state !== 'closed') return false;
  bedSt.state = 'settle';
  bedSt.timer = 0;
  bedSt.healed = false;
  pauseMusic();
  playSFX(REST_JINGLE);   // one-shot on the SFX channel so it plays once, no loop
  return true;
}

function _close() {
  bedSt.state = 'closed';
  bedSt.timer = 0;
  bedSt.healed = false;
  stopSFX();        // cut the jingle if it's still ringing on wake
  resumeMusic();
}

// Refill HP/MP only — status effects intentionally untouched. Save = checkpoint.
function _rest() {
  if (bedSt.healed) return;
  bedSt.healed = true;
  if (ps.stats) { ps.hp = ps.stats.maxHP; ps.mp = ps.stats.maxMP; }
  saveSlotsToDB();
}

export function updateBed(dt) {
  if (bedSt.state === 'closed') return;
  bedSt.timer += Math.min(dt, 33);
  const s = bedSt.state;
  if (s === 'settle') {
    if (bedSt.timer >= SETTLE_MS) { bedSt.state = 'fade-out'; bedSt.timer = 0; }
  } else if (s === 'fade-out') {
    if (bedSt.timer >= FADE_MS) { bedSt.state = 'sleep'; bedSt.timer = 0; }
  } else if (s === 'sleep') {
    if (bedSt.timer >= SLEEP_MS) { _rest(); bedSt.state = 'wake-wait'; bedSt.timer = 0; }
  } else if (s === 'fade-in') {
    if (bedSt.timer >= FADE_MS) _close();
  }
  // wake-wait transitions only on input (handleBedInput).
}

// Owns all input while active — returns true to block movement/other scenes.
export function handleBedInput(keys) {
  if (bedSt.state === 'closed') return false;
  // A (z) or B (x) wakes from the prompt; everything else is drained so the
  // settle / fade / 8s sleep can't be skipped.
  if (bedSt.state === 'wake-wait' && (keys['z'] || keys['Z'] || keys['x'] || keys['X'])) {
    bedSt.state = 'fade-in';
    bedSt.timer = 0;
  }
  for (const k of Object.keys(keys)) keys[k] = false;
  return true;
}

export function drawBed() {
  if (bedSt.state === 'closed' || bedSt.state === 'settle') return;  // settle stays lit
  const ctx = ui.ctx;
  if (!ctx) return;
  const s = bedSt.state;

  if (s === 'fade-out') {
    applyPaletteLut(ctx, FADE.lutForProgress(bedSt.timer / FADE_MS), INNER_X, INNER_Y, INNER_W, INNER_H);
    return;
  }
  if (s === 'fade-in') {
    applyPaletteLut(ctx, FADE.lutForProgress(1 - bedSt.timer / FADE_MS), INNER_X, INNER_Y, INNER_W, INNER_H);
    return;
  }

  // sleep / wake-wait — hold the dark palette live so the candle keeps flickering.
  applyPaletteLut(ctx, FADE.finalLut, INNER_X, INNER_Y, INNER_W, INNER_H);
  if (s === 'wake-wait' && Math.floor(bedSt.timer / 400) % 2 === 0) {
    const x = INNER_X + Math.max(0, (INNER_W - measureText(PROMPT)) >> 1);
    const y = INNER_Y + (INNER_H >> 1) - 4;
    drawText(ctx, x, y, PROMPT, PROMPT_PAL);
  }
}
