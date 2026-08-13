#!/usr/bin/env node
// world-shot.mjs — screenshot the OVERWORLD the way the player sees it.
//
// Same job as tools/map-shot.mjs, for `WorldMapRenderer`. It draws the terrain,
// paints a stand-in player sprite, then runs `drawOverlay` — which is the whole
// point, because that is where the ROM's priority bits redraw terrain back over
// the sprite. Occlusion bugs are invisible in a plain tilemap render: you have
// to draw a sprite and see what covers it.
//
// The stand-in is a flat magenta 16x16 block on purpose. Any terrain pixel
// showing inside that block is terrain drawn OVER the player, so "is the head
// cut off" becomes a pixel count instead of an opinion.
//
//   node tools/world-shot.mjs 80,50 out.png
//   node tools/world-shot.mjs 80,50 out.png --zoom 6
//   node tools/world-shot.mjs 80,50 --report        # occluded px, no file

import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

globalThis.document = { createElement: (t) => (t === 'canvas' ? createCanvas(1, 1) : {}) };

const { loadWorldMap } = await import('../src/world-map-loader.js');
const { WorldMapRenderer } = await import('../src/world-map-renderer.js');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const has = (n) => args.includes('--' + n);

const [tileX, tileY] = (args[0] || '80,50').split(',').map(Number);
const out = args[1] && !args[1].startsWith('--') ? args[1] : null;
const ZOOM = Math.max(1, parseInt(flag('zoom', '4'), 10));

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));
const world = loadWorldMap(rom, 0);
const r = new WorldMapRenderer(world);

// Mirrors src/render.js
const HUD_VIEW_Y = 32, HUD_VIEW_W = 144, HUD_VIEW_H = 144;
const SCREEN_CENTER_X = (HUD_VIEW_W - 16) / 2;
const SCREEN_CENTER_Y = HUD_VIEW_Y + (HUD_VIEW_H - 16) / 2 - 3;
const TILE = 16;

const canvas = createCanvas(HUD_VIEW_W, HUD_VIEW_H + HUD_VIEW_Y);
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;
ctx.fillStyle = '#000';
ctx.fillRect(0, 0, canvas.width, canvas.height);

// `--off dx,dy` shifts the camera by sub-tile pixels. The player sits at a
// fixed screen position while the map scrolls, so MID-STEP the camera is not on
// a tile boundary and the sprite's box straddles two tile rows. Occlusion bugs
// live in exactly those in-between frames — testing only aligned positions
// finds nothing.
const [offX, offY] = (flag('off', '0,0')).split(',').map(Number);
const camX = tileX * TILE + offX, camY = tileY * TILE + offY;
// render.js draws the map at SCREEN_CENTER_Y + 3 but places the sprite at
// SCREEN_CENTER_Y — a deliberate 3px offset. Mirror it exactly: get this wrong
// and the tile row above never enters the overlay's tile walk, so the tool
// reports zero occlusion for a bug the player is staring at.
const MAP_ORIGIN_Y = SCREEN_CENTER_Y + 3;
r.draw(ctx, camX, camY, SCREEN_CENTER_X, MAP_ORIGIN_Y);

// Stand-in player, then the priority pass that may redraw terrain over it.
const PLAYER = '#ff00ff';
ctx.fillStyle = PLAYER;
ctx.fillRect(SCREEN_CENTER_X, SCREEN_CENTER_Y, 16, 16);
r.drawOverlay?.(ctx, camX, camY, SCREEN_CENTER_X, MAP_ORIGIN_Y, SCREEN_CENTER_X, SCREEN_CENTER_Y);

// Count what covered the sprite, split by half — the report says the TOP is cut.
const px = ctx.getImageData(SCREEN_CENTER_X, SCREEN_CENTER_Y, 16, 16).data;
let top = 0, bottom = 0;
for (let y = 0; y < 16; y++) {
  for (let x = 0; x < 16; x++) {
    const i = (y * 16 + x) * 4;
    const isPlayer = px[i] === 0xFF && px[i + 1] === 0x00 && px[i + 2] === 0xFF;
    if (isPlayer) continue;
    if (y < 8) top++; else bottom++;
  }
}
const m = world.tilemap[(((tileY % 128) + 128) % 128) * 128 + (((tileX % 128) + 128) % 128)] & 0x7F;
const above = world.tilemap[(((tileY - 1 + 128) % 128)) * 128 + (((tileX % 128) + 128) % 128)] & 0x7F;
const bits = (b) => ((b & 0x20) ? 'U' : '') + ((b & 0x10) ? 'L' : '') || '-';
console.log(`tile (${tileX},${tileY}) = $${m.toString(16).padStart(2, '0')} [${bits(world.tileProps[m].byte1)}]` +
            `  above = $${above.toString(16).padStart(2, '0')} [${bits(world.tileProps[above].byte1)}]`);
console.log(`  terrain drawn over the sprite:  top half ${top}/128 px   bottom half ${bottom}/128 px`);

if (out && !has('report')) {
  const z = createCanvas(canvas.width * ZOOM, canvas.height * ZOOM);
  const zx = z.getContext('2d');
  zx.imageSmoothingEnabled = false;
  zx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, z.width, z.height);
  fs.writeFileSync(out, z.toBuffer('image/png'));
  console.log(`  -> ${out}`);
}
