// nes-palette-fade.js — reusable NES-style palette fade.
//
// The NES swaps its whole palette in discrete steps; it never blends colors.
// This builds a fade from captured keyframes (per-frame $3F00 palettes) and
// snaps a canvas region to the right keyframe for the current progress — a
// hardware-style swap, NOT an alpha crossfade. Any scene that wants a
// captured palette transition (inn rest, future cutscenes) uses this; the
// captured keyframe data lives in src/data/*-fade-palette.js.

import { NES_SYSTEM_PALETTE } from './tile-decoder.js';

// Reverse RGB → NES index. Canvas pixels rendered from baked NES palettes are
// exact system colors, so this is a clean lookup (no nearest-color search).
const _rgbToIdx = (() => {
  const m = new Map();
  for (let i = 0; i < NES_SYSTEM_PALETTE.length; i++) {
    const [r, g, b] = NES_SYSTEM_PALETTE[i];
    m.set((r << 16) | (g << 8) | b, i);
  }
  return m;
})();

// Build a fade from captured keyframes. Each key is [nesFrame, ...16 colors]
// (BG0×4 BG1×4 BG2×4 BG3×4); key[0] of the FIRST row is the lit/source state.
// Returns { durationMs, finalLut, lutForProgress(prog) } where each lut is a
// 64-entry source→target NES-index map (unmapped colors stay identity, so
// sprite/UI colors not in the BG palette are left untouched).
export function buildPaletteFade(keys) {
  const ref = keys[0];                       // lit frame — its slots are the sources
  const luts = keys.map((key) => {
    const lut = new Uint8Array(64);
    for (let i = 0; i < 64; i++) lut[i] = i;
    for (let s = 0; s < 16; s++) lut[ref[1 + s]] = key[1 + s];
    return { frame: key[0], lut };
  });
  const span = keys[keys.length - 1][0];     // last keyframe number
  const finalLut = luts[luts.length - 1].lut;

  // Snap to the last keyframe at or before the current NES frame (no interp).
  function lutForProgress(prog) {
    const f = Math.max(0, Math.min(1, prog)) * span;
    let lut = luts[0].lut;
    for (const e of luts) { if (e.frame <= f) lut = e.lut; else break; }
    return lut;
  }

  return {
    durationMs: Math.round(span * 1000 / 60),  // capture cadence: span frames @ 60Hz
    finalLut,
    lutForProgress,
  };
}

// Snap a canvas region in place to a palette LUT. The region must already be
// drawn at the source palette this frame (callers re-render the scene each
// frame, so pixels are always the lit source colors).
export function applyPaletteLut(ctx, lut, x, y, w, h) {
  let img;
  try { img = ctx.getImageData(x, y, w, h); }
  catch { return; }
  const d = img.data;
  for (let p = 0; p < d.length; p += 4) {
    const idx = _rgbToIdx.get((d[p] << 16) | (d[p + 1] << 8) | d[p + 2]);
    if (idx === undefined) continue;
    const tgt = lut[idx];
    if (tgt === idx) continue;               // identity color — leave as-is
    const rgb = NES_SYSTEM_PALETTE[tgt];
    d[p] = rgb[0]; d[p + 1] = rgb[1]; d[p + 2] = rgb[2];
  }
  ctx.putImageData(img, x, y);
}
