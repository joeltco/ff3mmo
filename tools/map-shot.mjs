#!/usr/bin/env node
// map-shot.mjs — screenshot the game's ACTUAL render, not an approximation.
//
// Every other map tool here draws the 32x32 tilemap. The player never sees
// that. `render.js` draws into a 144x144 window (HUD_VIEW_W/H) — NINE tiles by
// nine — centred on the player, by filling a fill-tile background and then
// blitting the prerendered map canvas through `_roomClip`. Reviewing a 32x32
// tilemap render and calling a room "verified" is how three bad room-clip
// changes shipped.
//
// This drives `MapRenderer.draw()` itself against a real canvas
// (@napi-rs/canvas), with the same camera math as `render.js`:
//   camX/camY = player pixel position, originX = SCREEN_CENTER_X,
//   originY = SCREEN_CENTER_Y + 3
// so what lands in the PNG is what the player looks at.
//
//   node tools/map-shot.mjs 17 out.png              # at the map's spawn
//   node tools/map-shot.mjs 17 out.png --at 3,8     # at a specific tile
//   node tools/map-shot.mjs 17 out.png --zoom 4
//   node tools/map-shot.mjs 17 out.png --full       # whole 256x240 frame

import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

// --- DOM shim backed by a real canvas -------------------------------------
globalThis.document = {
  createElement: (tag) => {
    if (tag !== 'canvas') return {};
    return createCanvas(1, 1);
  },
};

const { loadMap } = await import('../src/map-loader.js');
const { MapRenderer } = await import('../src/map-renderer.js');

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));

const args = process.argv.slice(2);
const mapId = parseInt(args[0], 10);
const out = args[1] || `shot-${mapId}.png`;
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const has = (n) => args.includes('--' + n);
const ZOOM = Math.max(1, parseInt(flag('zoom', '4'), 10));

// Mirrors src/render.js
const HUD_TOP_H = 32;
const HUD_VIEW_X = 0, HUD_VIEW_Y = HUD_TOP_H, HUD_VIEW_W = 144, HUD_VIEW_H = 144;
const SCREEN_CENTER_X = HUD_VIEW_X + (HUD_VIEW_W - 16) / 2;
const SCREEN_CENTER_Y = HUD_VIEW_Y + (HUD_VIEW_H - 16) / 2 - 3;
const CANVAS_W = 256, CANVAS_H = 240;
const TILE = 16;

const md = loadMap(rom, mapId);
// Mirror the game's load-time passage opening (v1.7.950).
if (md.tilemap[16 * 32 + 8] !== 0x32) {
  for (let i = 0; i < md.tilemap.length; i++) {
    if (md.tilemap[i] === 0x5B) md.tilemap[i] = 0x5D;
    if (md.tilemap[i] === 0x5C) md.tilemap[i] = 0x5E;
  }
}

// Spawn where the GAME spawns, not at the raw ROM entrance. Mirrors
// src/map-loading.js#_calcSpawnY — the ROM entrance is the door tile on the
// outside and the player is walked to the interior doorway. Shooting the raw
// entrance photographs a tile the player never stands on.
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
let px = md.entranceX, py = calcSpawnY(md, md.entranceX, md.entranceY);
const at = flag('at', null);
if (at) { const [a, b] = at.split(',').map(Number); px = a; py = b; }

const r = new MapRenderer(md, px, py);

const canvas = createCanvas(CANVAS_W, CANVAS_H);
const ctx = canvas.getContext('2d');
ctx.fillStyle = '#000';
ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

// The game clips the world to the HUD view before drawing the map.
ctx.save();
ctx.beginPath();
ctx.rect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);
ctx.clip();
r.draw(ctx, px * TILE, py * TILE, SCREEN_CENTER_X, SCREEN_CENTER_Y + 3);
r.drawOverlay?.(ctx, px * TILE, py * TILE, SCREEN_CENTER_X, SCREEN_CENTER_Y + 3, SCREEN_CENTER_X, SCREEN_CENTER_Y);
ctx.restore();

// Mark where the player stands so the framing is unambiguous.
if (!has('nomark')) {
  ctx.strokeStyle = '#f0f';
  ctx.lineWidth = 1;
  ctx.strokeRect(SCREEN_CENTER_X + 0.5, SCREEN_CENTER_Y + 0.5, 15, 15);
}

// Crop to the view unless --full.
const sx = has('full') ? 0 : HUD_VIEW_X;
const sy = has('full') ? 0 : HUD_VIEW_Y;
const sw = has('full') ? CANVAS_W : HUD_VIEW_W;
const sh = has('full') ? CANVAS_H : HUD_VIEW_H;

const zc = createCanvas(sw * ZOOM, sh * ZOOM);
const zx = zc.getContext('2d');
zx.imageSmoothingEnabled = false;
zx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw * ZOOM, sh * ZOOM);

fs.writeFileSync(out, zc.toBuffer('image/png'));
console.log(`map ${mapId} at tile (${px},${py}) -> ${out}  (${sw}x${sh} view, ${ZOOM}x)`);
