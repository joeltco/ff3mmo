// bed.js — inn bed rest scene.
//
// Step onto any bed tile (data/beds.js — tile-id driven, every present/future
// bed works with no per-map setup) to rest. No cost; refills HP/MP only
// (status untouched).
//
// Lifecycle: closed → settle → fade-out → sleep(6s) → fade-in → walk-out → closed.
//   settle    — face left and hold the room lit, on the bed, before it dims
//               (so you see the full step land). Music pauses here.
//   fade-out  — the captured FF3 inn palette ramp (nes-palette-fade.js, discrete
//               hardware steps — NOT an alpha crossfade). Silent during the fade.
//   sleep     — 6s dark hold; the rest jingle fires on the first (fully dark)
//               frame, not during the fade. Input drained (can't be skipped).
//   fade-in   — palette ramp in reverse; auto-advances (no button to wake).
//   walk-out  — sprite walks down one tile off the bed, then the pond-heal
//               "Fully Restored!" message box shows and the scene closes.
//
// Wired in game-loop (updateBed), render (isBedDimming/drawBedDim — dims the BG
// before the sprite pass so sprites never fade), movement (input gate), and
// map-triggers (step-on via MapRenderer.isBedTileAt, fired from _onMoveComplete
// so the step is always fully complete first).

import { ps } from './player-stats.js';
import { saveSlotsToDB } from './save-state.js';
import { pauseMusic, resumeMusic, playSFX, stopSFX } from './music.js';
import { mapSt } from './map-state.js';
import { sprite } from './player-sprite.js';
import { DIR_LEFT, DIR_DOWN } from './sprite.js';
import { startMove } from './movement.js';
import { showMsgBox } from './message-box.js';
import { POND_RESTORED } from './data/strings.js';
import { buildPaletteFade, applyPaletteLut } from './nes-palette-fade.js';
import { INN_FADE_KEYS } from './data/inn-fade-palette.js';

// Inner map viewport (the area that dims — HUD chrome stays put).
const HUD_VIEW_X = 0, HUD_VIEW_Y = 32, HUD_VIEW_W = 144, HUD_VIEW_H = 144;
const INNER_X = HUD_VIEW_X + 8, INNER_Y = HUD_VIEW_Y + 8;
const INNER_W = HUD_VIEW_W - 16, INNER_H = HUD_VIEW_H - 16;

const FADE = buildPaletteFade(INN_FADE_KEYS);  // captured inn fade (discrete steps)
const FADE_MS  = FADE.durationMs;              // ≈667ms, true NTSC cadence
const SETTLE_MS = 300;    // show the landed step before the room dims
const SLEEP_MS  = 6000;   // forced dark hold before waking
const REST_JINGLE = 0;    // inn rest tune — first track in the FF3 NSF playlist

export const bedSt = {
  state:  'closed',   // closed | settle | fade-out | sleep | fade-in | walk-out
  timer:  0,
  healed: false,
};

export function openBed() {
  if (bedSt.state !== 'closed') return false;
  bedSt.state = 'settle';
  bedSt.timer = 0;
  bedSt.healed = false;
  sprite.setDirection(DIR_LEFT);   // lie facing left
  sprite.resetFrame();
  pauseMusic();           // jingle fires later, on the fully-dark frame
  return true;
}

function _close() {
  bedSt.state = 'closed';
  bedSt.timer = 0;
  bedSt.healed = false;
  stopSFX();        // cut the jingle if it's still ringing
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
    if (bedSt.timer >= FADE_MS) {
      bedSt.state = 'sleep';
      bedSt.timer = 0;
      playSFX(REST_JINGLE);   // on the first fully-dark frame — one-shot, no loop
    }
  } else if (s === 'sleep') {
    if (bedSt.timer >= SLEEP_MS) { _rest(); bedSt.state = 'fade-in'; bedSt.timer = 0; }
  } else if (s === 'fade-in') {
    if (bedSt.timer >= FADE_MS) {
      bedSt.state = 'walk-out';
      startMove(DIR_DOWN);   // step one tile off the bed (sets facing + lerp)
    }
  } else if (s === 'walk-out') {
    if (!mapSt.moving) {     // step finished — confirm rest, hand off, close
      showMsgBox(POND_RESTORED, null);
      _close();
    }
  }
}

// Owns all input while active — drains everything (no wake button) and returns
// true to block movement / other scenes until the scene closes itself.
export function handleBedInput(keys) {
  if (bedSt.state === 'closed') return false;
  for (const k of Object.keys(keys)) keys[k] = false;
  return true;
}

// True while the room is dimmed (fade-out / sleep / fade-in). render.js uses
// this to dim the BG layer (map + overlay) BEFORE sprites are drawn, so the
// player / NPCs / candle land on top at full brightness and never fade.
export function isBedDimming() {
  const s = bedSt.state;
  return s === 'fade-out' || s === 'fade-in' || s === 'sleep';
}

// Snap the room (BG layer) to the captured fade palette. Called from render.js
// after the map+overlay draw and before the sprite pass — never operates on
// composited sprite pixels, so sprite colors that happen to match a room color
// can't be dimmed by collision.
export function drawBedDim(ctx) {
  const s = bedSt.state;
  if (s === 'fade-out') {
    applyPaletteLut(ctx, FADE.lutForProgress(bedSt.timer / FADE_MS), INNER_X, INNER_Y, INNER_W, INNER_H);
  } else if (s === 'fade-in') {
    applyPaletteLut(ctx, FADE.lutForProgress(1 - bedSt.timer / FADE_MS), INNER_X, INNER_Y, INNER_W, INNER_H);
  } else if (s === 'sleep') {
    // hold the dark palette live so the candle keeps flickering on top
    applyPaletteLut(ctx, FADE.finalLut, INNER_X, INNER_Y, INNER_W, INNER_H);
  }
}
