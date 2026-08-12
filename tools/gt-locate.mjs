#!/usr/bin/env node
// gt-locate.mjs — check ONE map against the real ROM, properly.
//
// tools/gt-sweep.mjs compares at OUR spawn camera, which is almost never where
// the emulator's camera ended up (a warp keeps the party's carried-over
// position). Worse, a trailing row only enters the 144x144 window when the
// camera is near the spawn — so the sweep reported the Kazus inn (map 13) CLEAN
// while it was visibly broken with 8 stray tiles.
//
// This does it the right way round: the emulator's position can't be set, so
// hold it fixed and search OURS. For every candidate camera tile it renders our
// view — with the clip SEED pinned at the spawn, because the game computes the
// room clip once on entry and never recomputes it as you walk — and keeps the
// position that agrees most with the real frame. OURS-ONLY at that position is
// the honest defect count.
//
//   node tools/gt-locate.mjs 13
//   node tools/gt-locate.mjs 13 --real captured.png    # reuse a capture
//   node tools/gt-locate.mjs 13 --ascii
//
// Needs a free-roam savestate ($FF3_STATE) unless --real is given.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createCanvas, loadImage } from '@napi-rs/canvas';

globalThis.document = { createElement: (t) => (t === 'canvas' ? createCanvas(1, 1) : {}) };

const { loadMap } = await import('../src/map-loader.js');
const { MapRenderer } = await import('../src/map-renderer.js');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const has = (n) => args.includes('--' + n);
const id = parseInt(args[0], 10);

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));

// --- our renderer, same camera math as src/render.js ------------------------
const HUD_VIEW_X = 0, HUD_VIEW_Y = 32, HUD_VIEW_W = 144, HUD_VIEW_H = 144;
const SCREEN_CENTER_X = HUD_VIEW_X + (HUD_VIEW_W - 16) / 2;
const SCREEN_CENTER_Y = HUD_VIEW_Y + (HUD_VIEW_H - 16) / 2 - 3;
const W = 256, H = 240, TILE = 16;

const md = loadMap(rom, id);
if (md.tilemap[16 * 32 + 8] !== 0x32) {
  for (let i = 0; i < md.tilemap.length; i++) {
    if (md.tilemap[i] === 0x5B) md.tilemap[i] = 0x5D;
    if (md.tilemap[i] === 0x5C) md.tilemap[i] = 0x5E;
  }
}

function calcSpawnY(m, ex, ey) {
  const at2 = (x, y) => m.tilemap[y * 32 + x];
  const collOf = (mid) => m.collision[mid < 128 ? mid : mid & 0x7F];
  if ((collOf(at2(ex, ey)) & 0x07) === 3) {
    for (let d = 1; d < 32; d++) { const ny = (ey - d + 32) % 32; if (at2(ex, ny) === 0x44) return ny; }
    for (let d = 1; d <= 16; d++) { const ny = ey + d; if (ny >= 32) break; const mid = at2(ex, ny);
      if (mid === m.fillTile) break; const c = collOf(mid);
      if ((c & 0x07) !== 3 && !(c & 0x80)) return ny; }
    for (let d = 1; d <= 16; d++) { const ny = ey - d; if (ny < 0) break; const mid = at2(ex, ny);
      if (mid === m.fillTile) break; const c = collOf(mid);
      if ((c & 0x07) !== 3 && !(c & 0x80)) return ny; }
    return ey;
  }
  const entMid = at2(ex, ey);
  const entM = entMid < 128 ? entMid : entMid & 0x7F;
  if (entMid === 0x44) return ey;
  if ((m.collision[entM] & 0x80) && ((m.collisionByte2[entM] >> 4) & 0x0F) === 0) {
    for (let d = 1; d <= 8; d++) { const ny = ey - d; if (ny < 0) break; if (at2(ex, ny) === 0x44) return ny; }
  }
  return ey;
}

const seedX = md.entranceX, seedY = calcSpawnY(md, md.entranceX, md.entranceY);
const renderer = new MapRenderer(md, seedX, seedY);   // clip built ONCE, at the spawn

const ourCanvas = createCanvas(W, H);
const ourCtx = ourCanvas.getContext('2d');
function renderAt(px, py) {
  ourCtx.fillStyle = '#000';
  ourCtx.fillRect(0, 0, W, H);
  ourCtx.save();
  ourCtx.beginPath();
  ourCtx.rect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);
  ourCtx.clip();
  renderer.draw(ourCtx, px * TILE, py * TILE, SCREEN_CENTER_X, SCREEN_CENTER_Y + 3);
  renderer.drawOverlay?.(ourCtx, px * TILE, py * TILE, SCREEN_CENTER_X, SCREEN_CENTER_Y + 3,
                         SCREEN_CENTER_X, SCREEN_CENTER_Y);
  ourCtx.restore();
  return ourCtx.getImageData(0, 0, W, H).data;
}

// --- the real frame ---------------------------------------------------------
let realPath = flag('real', null);
if (!realPath) {
  const state = process.env.FF3_STATE;
  if (!state || !fs.existsSync(state)) {
    console.error('need $FF3_STATE (a free-roam savestate) or --real <png>');
    process.exit(2);
  }
  realPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gtloc-')), `r${id}.png`);
  execFileSync('node', ['tools/nes-run.mjs', '--loadstate', state, '--warp', String(id),
    '--warphold', '300', '--settle', '300', '--out', realPath, '--zoom', '1', '--frames', '40'],
    { stdio: ['ignore', 'ignore', 'ignore'] });
}
const realImg = await loadImage(fs.readFileSync(realPath));
const rc = createCanvas(realImg.width, realImg.height);
const rctx = rc.getContext('2d');
rctx.drawImage(realImg, 0, 0);
const realData = rctx.getImageData(0, 0, realImg.width, realImg.height).data;
const zR = Math.max(1, Math.round(realImg.width / W));

const pxAt = (d, w, z, x, y) => {
  const X = x * z, Y = y * z;
  if (X < 0 || Y < 0 || X >= w || Y >= (d.length / 4 / w)) return null;
  const i = (Y * w + X) * 4;
  return (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
};
const blank = (c) => c === null || c === 0x000000;

// Score one camera position: best structural agreement over a small offset
// search (the two windows are centred differently, ours 144 wide vs 256).
function score(ourData) {
  let best = { agree: 0, drawn: 1, dx: 0, dy: 0, pct: 0 };
  for (let ty = -6; ty <= 6; ty++) {
    for (let tx = -8; tx <= 8; tx++) {
      const dx = tx * TILE, dy = ty * TILE;
      let agree = 0, drawn = 0;
      for (let y = 0; y < H; y += 4) {
        for (let x = 0; x < W; x += 4) {
          const a = pxAt(realData, realImg.width, zR, x, y);
          const b = pxAt(ourData, W, 1, x + dx, y + dy);
          if (blank(a) && blank(b)) continue;
          drawn++;
          if (blank(a) === blank(b)) agree++;
        }
      }
      if (drawn < 100) continue;
      const pct = agree / drawn;
      if (pct > best.pct) best = { agree, drawn, dx, dy, pct };
    }
  }
  return best;
}

// --- search every camera tile inside the clip -------------------------------
const clip = renderer._roomClip;
const L = clip ? clip.x / TILE : 0, T = clip ? clip.y / TILE : 0;
const R = clip ? (clip.x + clip.w) / TILE : 32, B = clip ? (clip.y + clip.h) / TILE : 32;

let winner = null;
for (let y = T; y < B; y++) {
  for (let x = L; x < R; x++) {
    if (!renderer.isPassable(x, y, 0)) continue;      // the player must be able to stand there
    const s = score(renderAt(x, y));
    if (!winner || s.pct > winner.pct) winner = { ...s, x, y };
  }
}

if (!winner) { console.log(`map ${id}: no walkable camera position inside the clip`); process.exit(0); }

// --- classify cells at the winning position ---------------------------------
const ourData = renderAt(winner.x, winner.y);
const cols = W / TILE, rows = Math.floor(H / TILE);
let nAgree = 0, nDiff = 0, nReal = 0, nOurs = 0;
const grid = [];
for (let r = 0; r < rows; r++) {
  let line = '';
  for (let c = 0; c < cols; c++) {
    let aD = 0, bD = 0, same = 0, tot = 0;
    for (let y = 0; y < TILE; y += 2) {
      for (let x = 0; x < TILE; x += 2) {
        const a = pxAt(realData, realImg.width, zR, c * TILE + x, r * TILE + y);
        const b = pxAt(ourData, W, 1, c * TILE + x + winner.dx, r * TILE + y + winner.dy);
        if (!blank(a)) aD++;
        if (!blank(b)) bD++;
        if (blank(a) === blank(b)) same++;
        tot++;
      }
    }
    let ch;
    if (!aD && !bD) ch = '.';
    else if (aD && !bD) { ch = 'r'; nReal++; }
    else if (!aD && bD) { ch = 'o'; nOurs++; }
    else if (same / tot > 0.92) { ch = '='; nAgree++; }
    else { ch = 'X'; nDiff++; }
    line += ch;
  }
  grid.push(line);
}

const confident = winner.pct >= 0.6 && nAgree >= 20;
console.log(`map ${id}  spawn/seed (${seedX},${seedY})  best camera (${winner.x},${winner.y})  ` +
            `agreement ${(winner.pct * 100).toFixed(1)}%`);
console.log(`  ${nAgree} agree, ${nDiff} differ, ${nReal} real-only, ${nOurs} OURS-ONLY` +
            (!confident ? '   (LOW CONFIDENCE — treat as inconclusive)'
              : nOurs ? '   <-- TRAILING TILES' : '   clean'));
if (has('ascii')) {
  console.log('\n   ' + [...Array(cols).keys()].map(i => i % 10).join(''));
  grid.forEach((l, i) => console.log(String(i).padStart(2) + ' ' + l));
}
process.exit(confident && nOurs ? 1 : 0);
