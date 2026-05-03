// nes-fade.js — pre-render canvas snapshots at progressively darker NES
// palette steps, for "fade-to-black" transitions on already-rasterized regions
// (e.g. the live map viewport when opening the shop).
//
// Each pixel of the source is quantized to its nearest NES palette index,
// then `nesColorFade` is applied N times to step it toward $0F (black).
//
// Returned: [frame0, frame1, ..., frameSteps] — frame0 is the NES-quantized
// original, frameSteps is fully (or nearly) black. Use linearly during
// fade-out, reversed during fade-in.

import { NES_SYSTEM_PALETTE } from './tile-decoder.js';
import { nesColorFade } from './palette.js';

const _nearestCache = new Map();

function _nearestNesIndex(r, g, b) {
  const key = (r << 16) | (g << 8) | b;
  const hit = _nearestCache.get(key);
  if (hit !== undefined) return hit;
  let best = 0, bestDist = Infinity;
  for (let i = 0; i < NES_SYSTEM_PALETTE.length; i++) {
    const [pr, pg, pb] = NES_SYSTEM_PALETTE[i];
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < bestDist) { bestDist = d; best = i; }
  }
  _nearestCache.set(key, best);
  return best;
}

// Build (steps + 1) fade frames from a region of srcCanvas.
export function buildNesFadeFrames(srcCanvas, sx, sy, sw, sh, steps = 4) {
  const tmp = document.createElement('canvas');
  tmp.width = sw; tmp.height = sh;
  const tctx = tmp.getContext('2d');
  tctx.imageSmoothingEnabled = false;
  tctx.drawImage(srcCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
  const img = tctx.getImageData(0, 0, sw, sh);
  const data = img.data;
  const pCount = sw * sh;

  // Per-pixel quantized NES palette index.
  const idxBuf = new Uint8Array(pCount);
  for (let p = 0; p < pCount; p++) {
    const o = p * 4;
    idxBuf[p] = _nearestNesIndex(data[o], data[o + 1], data[o + 2]);
  }

  // Precompute RGB lookup per (step, nesIdx) so the per-pixel inner loop is
  // a single array lookup instead of N calls to nesColorFade.
  const stepRGB = [];
  for (let step = 0; step <= steps; step++) {
    const palette = new Array(64);
    for (let i = 0; i < 64; i++) {
      let idx = i;
      for (let s = 0; s < step; s++) idx = nesColorFade(idx);
      palette[i] = NES_SYSTEM_PALETTE[idx] || [0, 0, 0];
    }
    stepRGB.push(palette);
  }

  const frames = [];
  for (let step = 0; step <= steps; step++) {
    const c = document.createElement('canvas');
    c.width = sw; c.height = sh;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    const out = ctx.createImageData(sw, sh);
    const od = out.data;
    const palette = stepRGB[step];
    for (let p = 0; p < pCount; p++) {
      const rgb = palette[idxBuf[p]];
      const o = p * 4;
      od[o] = rgb[0]; od[o + 1] = rgb[1]; od[o + 2] = rgb[2]; od[o + 3] = 255;
    }
    ctx.putImageData(out, 0, 0);
    frames.push(c);
  }
  return frames;
}
