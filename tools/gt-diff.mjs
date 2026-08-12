#!/usr/bin/env node
// gt-diff.mjs — diff OUR renderer against the REAL game, pixel for pixel.
//
// tools/nes-run.mjs captures what the actual FF3 ROM puts on screen.
// tools/map-shot.mjs captures what src/map-renderer.js puts on screen. This
// tool overlays the two and reports where they disagree.
//
// The two captures are not framed identically — the emulator's camera sits
// wherever the warp left the party, ours sits on the computed spawn — so this
// does NOT assume alignment. It searches whole-tile offsets for the one that
// maximises agreement, then reports the residual. That means a real mismatch
// (wrong tile, wrong palette, trailing tiles outside a room) shows up as
// residual disagreement AFTER the best possible alignment, which is the only
// honest way to compare two differently-framed screenshots.
//
//   node tools/gt-diff.mjs real.png ours.png
//   node tools/gt-diff.mjs real.png ours.png --ascii     # per-tile ASCII map
//
// ASCII legend:  .  both blank      =  agree (drawn)
//                X  disagree        r  only the REAL game draws here
//                o  only OURS draws here  <-- trailing tiles look like this

import fs from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const args = process.argv.slice(2);
const [pathA, pathB] = args;
const has = (n) => args.includes('--' + n);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };

if (!pathA || !pathB) {
  console.error('usage: gt-diff.mjs <real.png> <ours.png> [--ascii]');
  process.exit(2);
}

const TILE = 16;
const SEARCH = parseInt(flag('search', '10'), 10);   // +/- this many tiles

async function pixels(p) {
  const img = await loadImage(fs.readFileSync(p));
  const c = createCanvas(img.width, img.height);
  const cx = c.getContext('2d');
  cx.imageSmoothingEnabled = false;
  cx.drawImage(img, 0, 0);
  return { w: img.width, h: img.height, d: cx.getImageData(0, 0, img.width, img.height).data };
}

const A = await pixels(pathA);
const B = await pixels(pathB);

// Both captures may be zoomed; normalise to 1x NES pixels.
const zA = Math.max(1, Math.round(A.w / 256));
const zB = Math.max(1, Math.round(B.w / 256));
const W = 256, H = 240;

const sample = (img, z, x, y) => {
  const px = x * z, py = y * z;
  if (px < 0 || py < 0 || px >= img.w || py >= img.h) return null;
  const i = (py * img.w + px) * 4;
  return (img.d[i] << 16) | (img.d[i + 1] << 8) | img.d[i + 2];
};
const isBlank = (c) => c === null || c === 0x000000;

// Compare STRUCTURE, not RGB. jsnes and src/tile-decoder.js use different
// NES-to-RGB lookup tables, so the same tile is #e7d5c4 in the emulator and
// #ababab for us. That is a palette-table difference, not a map bug, and
// comparing raw RGB drowns every real finding in it. What matters is which
// pixels are drawn at all — that is what exposes wrong tiles, missing
// geometry, and tiles we draw outside a room. `--color` opts back into strict
// RGB when the question really is about colour.
const STRICT = has('color');
const same = (a, b) => STRICT ? a === b : (isBlank(a) === isBlank(b));

// --- find the whole-tile offset that maximises agreement -------------------
let best = { score: -1, dx: 0, dy: 0 };
for (let ty = -SEARCH; ty <= SEARCH; ty++) {
  for (let tx = -SEARCH; tx <= SEARCH; tx++) {
    const dx = tx * TILE, dy = ty * TILE;
    let agree = 0, drawn = 0;
    for (let y = 0; y < H; y += 2) {
      for (let x = 0; x < W; x += 2) {
        const a = sample(A, zA, x, y);
        const b = sample(B, zB, x + dx, y + dy);
        if (isBlank(a) && isBlank(b)) continue;   // both empty proves nothing
        drawn++;
        if (same(a, b)) agree++;
      }
    }
    // Require real overlap so a near-empty alignment can't win by default.
    if (drawn < 400) continue;
    const score = agree / drawn;
    if (score > best.score) best = { score, dx, dy, agree, drawn };
  }
}

if (best.score < 0) {
  console.log('no alignment with meaningful overlap — the two captures share no drawn content');
  process.exit(1);
}

console.log(`best alignment: ours shifted by (${best.dx}, ${best.dy}) px  ` +
            `= (${best.dx / TILE}, ${best.dy / TILE}) tiles`);
console.log(`agreement: ${(best.score * 100).toFixed(1)}%  (${best.agree}/${best.drawn} drawn px)`);

// --- classify every metatile cell at that alignment -------------------------
const cols = W / TILE, rows = Math.floor(H / TILE);
let nBoth = 0, nDiff = 0, nRealOnly = 0, nOursOnly = 0;
const grid = [];
for (let r = 0; r < rows; r++) {
  let line = '';
  for (let c = 0; c < cols; c++) {
    let aDrawn = 0, bDrawn = 0, sameN = 0, tot = 0;
    for (let y = 0; y < TILE; y += 2) {
      for (let x = 0; x < TILE; x += 2) {
        const px = c * TILE + x, py = r * TILE + y;
        const a = sample(A, zA, px, py);
        const b = sample(B, zB, px + best.dx, py + best.dy);
        if (!isBlank(a)) aDrawn++;
        if (!isBlank(b)) bDrawn++;
        if (same(a, b)) sameN++;
        tot++;
      }
    }
    let ch;
    if (!aDrawn && !bDrawn) ch = '.';
    else if (aDrawn && !bDrawn) { ch = 'r'; nRealOnly++; }
    else if (!aDrawn && bDrawn) { ch = 'o'; nOursOnly++; }
    else if (sameN / tot > 0.92) { ch = '='; nBoth++; }
    else { ch = 'X'; nDiff++; }
    line += ch;
  }
  grid.push(line);
}

if (has('ascii')) {
  console.log('\n   ' + [...Array(cols).keys()].map(i => (i % 10)).join(''));
  grid.forEach((l, i) => console.log(String(i).padStart(2) + ' ' + l));
}

console.log(`\ncells: ${nBoth} agree, ${nDiff} differ, ${nRealOnly} real-only, ${nOursOnly} OURS-ONLY`);
if (nOursOnly) console.log(`  ^ ${nOursOnly} cells where WE draw and the real game draws nothing = trailing tiles`);
process.exit(nDiff || nOursOnly ? 1 : 0);
