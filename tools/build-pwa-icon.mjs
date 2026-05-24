#!/usr/bin/env node
// build-pwa-icon.mjs — render Onion Knight idle portrait inside the FF3 HUD
// menu border, output PWA / apple-touch-icon PNGs.
//
// Source pixels: 48×48 (6×6 NES tiles).
//   - 6×6 grid of HUD border tiles (TL/top/TR/left/fill/right/BL/bot/BR)
//     drawn with MENU_PALETTE ($0F, $00, $0F, $30 — black/grey/black/white).
//   - 16×24 Onion Knight idle portrait centered at (16, 12), 4 body tiles
//     + 2 leg tiles, PLAYER_PALETTES[0] (canonical ROM red outfit).
//
// All ROM bytes pulled from the live game data (`src/data/job-sprites.js`,
// `src/data/players.js`) — no hand-authored tiles. Per the "never invent
// sprites" rule, the icon is literally the in-game render at portrait size.
//
// Outputs (written next to repo root):
//   - icon-192.png         — Android / Chrome manifest icon (4× nearest scale)
//   - icon-512.png         — larger manifest icon for splash screens
//   - apple-touch-icon.png — iOS Home Screen tile (180×180, 3.75× scale)
//
// Usage: `node tools/build-pwa-icon.mjs [path/to/ff3.nes]`
// Defaults to `~/roms/ff3-jp.nes`. v1.7.633.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { decodeTile, NES_SYSTEM_PALETTE } from '../src/tile-decoder.js';
import { OK_IDLE } from '../src/data/job-sprites.js';
import { PLAYER_PALETTES } from '../src/data/players.js';

// ── HUD border tiles in ROM (mirrors src/hud-init.js) ──────────────────────
const BORDER_TILE_ROM = 0x1B710 + (0xF7 - 0x70) * 16;  // 0x1BF80
const BORDER_TILE_COUNT = 9;
const MENU_PALETTE = [0x0F, 0x00, 0x0F, 0x30];
// Border tile indices: 0=TL, 1=top, 2=TR, 3=left, 4=right, 5=BL, 6=bot, 7=BR, 8=fill

// ── 32×32 source layout — square HUD frame holding the 16×16 portrait ────
// In-game HUD shows the head+torso 16×16 portrait (4 tiles, no legs); this
// mirrors that exactly. 32×32 source = 4×4 tile grid with the portrait
// centered inside a 2×2 interior fill.
const SRC_W = 32, SRC_H = 32;
const PORTRAIT_X = 8, PORTRAIT_Y = 8;   // centers 16×16 portrait in 32×32

// 4×4 grid of border-tile indices.
const BORDER_GRID = [
  [0, 1, 1, 2],
  [3, 8, 8, 4],
  [3, 8, 8, 4],
  [5, 6, 6, 7],
];

// ── Render helpers ─────────────────────────────────────────────────────────

function makeBuffer(w, h) {
  // RGBA. Alpha 0 = fully transparent; we stamp opaque pixels as we draw.
  return Buffer.alloc(w * h * 4, 0);
}

function blitTile(buf, w, _h, pixels, palette, dx, dy, { transparent0 = false, maxRows = 8 } = {}) {
  for (let py = 0; py < maxRows; py++) {
    for (let px = 0; px < 8; px++) {
      const ci = pixels[py * 8 + px];
      if (transparent0 && ci === 0) continue;
      const nes = palette[ci];
      const rgb = NES_SYSTEM_PALETTE[nes] || [0, 0, 0];
      const off = ((dy + py) * w + (dx + px)) * 4;
      buf[off] = rgb[0]; buf[off + 1] = rgb[1]; buf[off + 2] = rgb[2]; buf[off + 3] = 255;
    }
  }
}

function renderSource(romData) {
  const buf = makeBuffer(SRC_W, SRC_H);
  // 1. Menu border + fill — opaque.
  const borderTiles = [];
  for (let i = 0; i < BORDER_TILE_COUNT; i++) {
    borderTiles.push(decodeTile(romData, BORDER_TILE_ROM + i * 16));
  }
  // Border tiles: pixel 0 transparent so corner-rounding shows through, AND the
  // outside-the-rounded-square corners become true alpha-0 (iOS home screen
  // mask, system wallpaper, etc.). Fill tiles draw opaquely because their
  // pixel 0 is in the interior, not the outer corner.
  for (let gy = 0; gy < 4; gy++) {
    for (let gx = 0; gx < 4; gx++) {
      blitTile(buf, SRC_W, SRC_H, borderTiles[BORDER_GRID[gy][gx]], MENU_PALETTE, gx * 8, gy * 8, { transparent0: true });
    }
  }
  // 2. Top 16×16 of the OK_IDLE sprite (4 body tiles, 2×2). Exact pixels
  //    `_renderPortrait` draws into title-screen player-select boxes.
  const pal = PLAYER_PALETTES[0];  // canonical red outfit
  const bodyTiles = OK_IDLE.map((t) => decodeTile(t, 0));
  blitTile(buf, SRC_W, SRC_H, bodyTiles[0], pal, PORTRAIT_X,     PORTRAIT_Y,     { transparent0: true });
  blitTile(buf, SRC_W, SRC_H, bodyTiles[1], pal, PORTRAIT_X + 8, PORTRAIT_Y,     { transparent0: true });
  blitTile(buf, SRC_W, SRC_H, bodyTiles[2], pal, PORTRAIT_X,     PORTRAIT_Y + 8, { transparent0: true });
  blitTile(buf, SRC_W, SRC_H, bodyTiles[3], pal, PORTRAIT_X + 8, PORTRAIT_Y + 8, { transparent0: true });
  return buf;
}

function nearestScale(src, srcW, srcH, dstW, dstH) {
  const dst = Buffer.alloc(dstW * dstH * 4);
  const xScale = srcW / dstW, yScale = srcH / dstH;
  for (let y = 0; y < dstH; y++) {
    const sy = Math.min(srcH - 1, Math.floor(y * yScale));
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(srcW - 1, Math.floor(x * xScale));
      const so = (sy * srcW + sx) * 4;
      const dof = (y * dstW + x) * 4;
      dst[dof] = src[so]; dst[dof + 1] = src[so + 1]; dst[dof + 2] = src[so + 2]; dst[dof + 3] = src[so + 3];
    }
  }
  return dst;
}

// ── PNG encoder (truecolor RGBA) — derived from render-oam-dump.js, alpha added
function crc32(buf) {
  if (!crc32.table) {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    crc32.table = t;
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = crc32.table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePNG(rgba, w, h) {
  const stride = w * 4;
  const filtered = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    filtered[y * (stride + 1)] = 0;
    Buffer.from(rgba.subarray(y * stride, y * stride + stride)).copy(filtered, y * (stride + 1) + 1);
  }
  const idat = zlib.deflateSync(filtered);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;     // bit depth
  ihdr[9] = 6;     // color type = truecolor RGBA
  ihdr[10] = 0;    // compression
  ihdr[11] = 0;    // filter
  ihdr[12] = 0;    // interlace
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ── main ────────────────────────────────────────────────────────────────────
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const romPath = process.argv[2] || path.join(os.homedir(), 'roms', 'ff3-jp.nes');
console.log('[icon] reading ROM:', romPath);
const romData = fs.readFileSync(romPath);

const src = renderSource(romData);
console.log(`[icon] rendered ${SRC_W}×${SRC_H} source`);

const targets = [
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-512.png', size: 512 },
  { name: 'apple-touch-icon.png', size: 180 },
];
for (const t of targets) {
  const scaled = nearestScale(src, SRC_W, SRC_H, t.size, t.size);
  const png = encodePNG(scaled, t.size, t.size);
  const outPath = path.join(repoRoot, t.name);
  fs.writeFileSync(outPath, png);
  console.log(`[icon] wrote ${t.name} (${t.size}×${t.size}, ${png.length} bytes)`);
}
