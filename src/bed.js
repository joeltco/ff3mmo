// bed.js — inn bed rest scene.
//
// Step onto any bed tile (data/beds.js — tile-id driven, every present/future
// bed works with no per-map setup) to rest: the room palette crossfades to a
// dim "night" palette, holds 8s, then any key fades it back in. HP/MP refill
// (status untouched). No cost.
//
// The fade is the FF3 inn palette ramp captured via REC OAM: each room color
// converges toward a fixed dark-blue palette (NES_DARK below, taken straight
// from the capture's per-frame $3F00 tables — frame 0 → frame 40 hold), while
// sprite-only colors (player/candle: 0x17/0x22/0x15/0x36/0x27) aren't in the
// map so they stay lit. NOT a fade-to-black, NOT a frozen snapshot.
//
// Lifecycle: closed → fade-out → sleep(8s) → wake-wait → fade-in → closed.
// Wired in game-loop (update/draw), movement (input gate), map-triggers
// (step-on via MapRenderer.isBedTileAt).

import { ps } from './player-stats.js';
import { saveSlotsToDB } from './save-state.js';
import { pauseMusic, resumeMusic, playSFX, stopSFX } from './music.js';
import { ui } from './ui-state.js';
import { drawText, measureText } from './font-renderer.js';
import { NES_SYSTEM_PALETTE } from './tile-decoder.js';

// Inner map viewport (the area that dims — HUD chrome stays put).
const HUD_VIEW_X = 0, HUD_VIEW_Y = 32, HUD_VIEW_W = 144, HUD_VIEW_H = 144;
const INNER_X = HUD_VIEW_X + 8, INNER_Y = HUD_VIEW_Y + 8;
const INNER_W = HUD_VIEW_W - 16, INNER_H = HUD_VIEW_H - 16;

const FADE_MS  = 600;     // palette ramp duration (≈36 NTSC frames in the capture)
const SLEEP_MS = 8000;    // dark hold before the wake prompt
const REST_JINGLE = 0;    // inn rest tune — first track in the FF3 NSF playlist

const PROMPT     = 'Press any key';
const PROMPT_PAL = [0x0F, 0x10, 0x0F, 0x30];

// Captured FF3 inn fade: source NES color → dark-palette target (frame 0 →
// frame 40 hold). Room colors converge to dark blue; everything else is
// identity (sprite/candle/player colors aren't listed, so they stay lit).
const _DARK_PAIRS = [
  [0x00, 0x02], [0x08, 0x02], [0x28, 0x02], [0x2b, 0x02],
  [0x10, 0x12], [0x11, 0x12], [0x18, 0x12], [0x1a, 0x12],
  [0x30, 0x12], [0x31, 0x12],
];
const NES_DARK = (() => {
  const t = new Uint8Array(64);
  for (let i = 0; i < 64; i++) t[i] = i;
  for (const [s, d] of _DARK_PAIRS) t[s] = d;
  return t;
})();

// Reverse RGB → NES index (viewport pixels are exact NES colors, no smoothing).
const _rgbToIdx = (() => {
  const m = new Map();
  for (let i = 0; i < NES_SYSTEM_PALETTE.length; i++) {
    const [r, g, b] = NES_SYSTEM_PALETTE[i];
    m.set((r << 16) | (g << 8) | b, i);
  }
  return m;
})();

export const bedSt = {
  state:      'closed',   // closed | fade-out | sleep | wake-wait | fade-in
  timer:      0,
  holdCanvas: null,       // dimmed snapshot drawn during sleep / wake-wait
  healed:     false,
};

export function openBed() {
  if (bedSt.state !== 'closed') return false;
  bedSt.state = 'fade-out';
  bedSt.timer = 0;
  bedSt.holdCanvas = null;
  bedSt.healed = false;
  pauseMusic();
  playSFX(REST_JINGLE);   // one-shot on the SFX channel so it plays once, no loop
  return true;
}

function _close() {
  bedSt.state = 'closed';
  bedSt.timer = 0;
  bedSt.holdCanvas = null;
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

// Crossfade the inner viewport toward the dark palette by amount t (0..1),
// in place, on the live (re-rendered) frame so animation keeps going.
function _dimViewport(ctx, t) {
  let img;
  try { img = ctx.getImageData(INNER_X, INNER_Y, INNER_W, INNER_H); }
  catch { return; }
  const d = img.data;
  for (let p = 0; p < d.length; p += 4) {
    const idx = _rgbToIdx.get((d[p] << 16) | (d[p + 1] << 8) | d[p + 2]);
    if (idx === undefined) continue;
    const dark = NES_SYSTEM_PALETTE[NES_DARK[idx]];
    if (dark === NES_SYSTEM_PALETTE[idx]) continue;  // identity color — leave lit
    d[p]     = (d[p]     + (dark[0] - d[p])     * t) | 0;
    d[p + 1] = (d[p + 1] + (dark[1] - d[p + 1]) * t) | 0;
    d[p + 2] = (d[p + 2] + (dark[2] - d[p + 2]) * t) | 0;
  }
  ctx.putImageData(img, INNER_X, INNER_Y);
}

export function updateBed(dt) {
  if (bedSt.state === 'closed') return;
  bedSt.timer += Math.min(dt, 33);
  const s = bedSt.state;
  if (s === 'fade-out') {
    if (bedSt.timer >= FADE_MS) { bedSt.state = 'sleep'; bedSt.timer = 0; bedSt.holdCanvas = null; }
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
  if (bedSt.state === 'wake-wait') {
    let pressed = false;
    for (const k of Object.keys(keys)) { if (keys[k]) { pressed = true; keys[k] = false; } }
    if (pressed) { bedSt.state = 'fade-in'; bedSt.timer = 0; }
  } else {
    for (const k of Object.keys(keys)) keys[k] = false;  // drain during fades/sleep
  }
  return true;
}

export function drawBed() {
  if (bedSt.state === 'closed') return;
  const ctx = ui.ctx;
  if (!ctx) return;
  const s = bedSt.state;

  if (s === 'fade-out') {
    const t = Math.min(1, bedSt.timer / FADE_MS);
    _dimViewport(ctx, t);
    // At full dark, snapshot the dimmed viewport for the hold.
    if (t >= 1 && !bedSt.holdCanvas) {
      const c = document.createElement('canvas');
      c.width = INNER_W; c.height = INNER_H;
      c.getContext('2d').drawImage(ctx.canvas, INNER_X, INNER_Y, INNER_W, INNER_H, 0, 0, INNER_W, INNER_H);
      bedSt.holdCanvas = c;
    }
    return;
  }
  if (s === 'fade-in') {
    _dimViewport(ctx, Math.max(0, 1 - bedSt.timer / FADE_MS));
    return;
  }

  // sleep / wake-wait — draw the held dim frame over the (live) viewport.
  if (bedSt.holdCanvas) ctx.drawImage(bedSt.holdCanvas, INNER_X, INNER_Y);
  else _dimViewport(ctx, 1);
  if (s === 'wake-wait' && Math.floor(bedSt.timer / 400) % 2 === 0) {
    const x = INNER_X + Math.max(0, (INNER_W - measureText(PROMPT)) >> 1);
    const y = INNER_Y + (INNER_H >> 1) - 4;
    drawText(ctx, x, y, PROMPT, PROMPT_PAL);
  }
}
