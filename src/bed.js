// bed.js — inn bed rest scene.
//
// Step onto any bed tile (see data/beds.js — tile-id driven, so every present
// and future bed works with no per-map setup) to rest: the screen fades to
// dark, the FF3 rest jingle plays once, HP/MP refill (status untouched), then
// any key fades back in.
//
// Lifecycle mirrors the shop scene:
//   closed → fade-out → sleep → wake-wait → fade-in → closed
// Wired in: game-loop.js (updateBed/drawBed), movement.js (input gate),
// map-triggers.js#checkTrigger (step-on entry via MapRenderer.isBedTileAt).
// Bed graphics live on the BG map; nothing here authors tiles.

import { ps } from './player-stats.js';
import { saveSlotsToDB } from './save-state.js';
import { buildNesFadeFrames } from './nes-fade.js';
import { playSFX, isSFXEnded, pauseMusic, resumeMusic } from './music.js';
import { ui } from './ui-state.js';
import { drawText, measureText } from './font-renderer.js';

// Inner map viewport — same region the shop fades.
const HUD_VIEW_X = 0, HUD_VIEW_Y = 32, HUD_VIEW_W = 144, HUD_VIEW_H = 144;
const INNER_X = HUD_VIEW_X + 8, INNER_Y = HUD_VIEW_Y + 8;
const INNER_W = HUD_VIEW_W - 16, INNER_H = HUD_VIEW_H - 16;

const FADE_STEPS   = 4;
const FADE_STEP_MS = 80;
const FADE_MS      = (FADE_STEPS + 1) * FADE_STEP_MS;  // 400ms
const REST_JINGLE  = 0x57;    // FF3 NSF rest tune (inn REC OAM capture: $7F49=$96 → track $57)
const SLEEP_MIN_MS = 300;     // hold before polling jingle-end so it's surely playing
const SLEEP_MAX_MS = 8000;    // safety — never hang if the jingle never reports end

const PROMPT     = 'Press any key';
const PROMPT_PAL = [0x0F, 0x10, 0x0F, 0x30];

export const bedSt = {
  state:      'closed',   // closed | fade-out | sleep | wake-wait | fade-in
  timer:      0,
  fadeFrames: null,       // [Canvas] from buildNesFadeFrames, built lazily on first fade frame
  healed:     false,
};

// Enter the rest scene. Called from checkTrigger when the player steps onto a
// bed tile. No-op if already resting.
export function openBed() {
  if (bedSt.state !== 'closed') return false;
  bedSt.state = 'fade-out';
  bedSt.timer = 0;
  bedSt.fadeFrames = null;
  bedSt.healed = false;
  pauseMusic();
  playSFX(REST_JINGLE);
  return true;
}

function _close() {
  bedSt.state = 'closed';
  bedSt.timer = 0;
  bedSt.fadeFrames = null;
  bedSt.healed = false;
  resumeMusic();
}

// Refill HP/MP only — status effects are intentionally left untouched.
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
  if (s === 'fade-out') {
    if (bedSt.timer >= FADE_MS) { bedSt.state = 'sleep'; bedSt.timer = 0; }
  } else if (s === 'sleep') {
    if (bedSt.timer >= SLEEP_MIN_MS && (isSFXEnded() || bedSt.timer >= SLEEP_MAX_MS)) {
      _rest();
      bedSt.state = 'wake-wait'; bedSt.timer = 0;
    }
  } else if (s === 'fade-in') {
    if (bedSt.timer >= FADE_MS) _close();
  }
  // wake-wait transitions only on input (handleBedInput).
}

// Owns all input while active — returns true to block movement/other scenes.
export function handleBedInput(keys) {
  if (bedSt.state === 'closed') return false;
  if (bedSt.state === 'wake-wait') {
    let pressed = false;
    for (const k of Object.keys(keys)) { if (keys[k]) { pressed = true; keys[k] = false; } }
    if (pressed) { bedSt.state = 'fade-in'; bedSt.timer = 0; }
  } else {
    // Drain keys during fades/sleep so a held key can't leak into movement.
    for (const k of Object.keys(keys)) keys[k] = false;
  }
  return true;
}

export function drawBed() {
  if (bedSt.state === 'closed') return;
  const ctx = ui.ctx;
  if (!ctx) return;
  const s = bedSt.state;

  if (s === 'fade-out' || s === 'fade-in') {
    if (!bedSt.fadeFrames) {
      bedSt.fadeFrames = buildNesFadeFrames(ctx.canvas, INNER_X, INNER_Y, INNER_W, INNER_H, FADE_STEPS);
    }
    const raw  = Math.min(FADE_STEPS, Math.floor(bedSt.timer / FADE_STEP_MS));
    const step = (s === 'fade-out') ? raw : (FADE_STEPS - raw);  // out: bright→dark, in: dark→bright
    const frame = bedSt.fadeFrames[Math.max(0, Math.min(step, FADE_STEPS))];
    if (frame) ctx.drawImage(frame, INNER_X, INNER_Y);
    return;
  }

  // sleep / wake-wait — held fully dark.
  ctx.fillStyle = '#000';
  ctx.fillRect(INNER_X, INNER_Y, INNER_W, INNER_H);
  if (s === 'wake-wait' && Math.floor(bedSt.timer / 400) % 2 === 0) {
    const x = INNER_X + Math.max(0, (INNER_W - measureText(PROMPT)) >> 1);
    const y = INNER_Y + (INNER_H >> 1) - 4;
    drawText(ctx, x, y, PROMPT, PROMPT_PAL);
  }
}
