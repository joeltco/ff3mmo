#!/usr/bin/env node
// check-tree-occlusion.mjs — prove the overworld draws priority terrain
// (trees) IN FRONT of the player, using the real WorldMapRenderer.
//
// The ROM marks foreground terrain with collision byte1 bits: 0x20 ("U") means
// the tile redraws over the sprite's BOTTOM 8px, 0x10 ("L") over its TOP 8px.
// Interiors have honoured this forever; the world map never did, so the player
// walked on top of forest canopy. Tree = metatile $64 (byte1 $2F), 520 tiles.
//
// Rendering can't be eyeballed from CI, so this drives the real drawOverlay
// with a recording 2D context and asserts WHAT was drawn and HOW it was
// clipped.
//
//   node tools/check-tree-occlusion.mjs

import fs from 'node:fs';

// Recording canvas stub.
let LOG = [];
function mkCanvas() {
  const c = { _w: 0, _h: 0 };
  Object.defineProperty(c, 'width',  { get: () => c._w, set: v => { c._w = v; }, configurable: true });
  Object.defineProperty(c, 'height', { get: () => c._h, set: v => { c._h = v; }, configurable: true });
  c.getContext = () => ({
    canvas: c,
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4), width: w, height: h }),
    putImageData() {}, fillRect() {}, clearRect() {}, save() { LOG.push({ op: 'save' }); },
    restore() { LOG.push({ op: 'restore' }); }, translate() {}, scale() {},
    beginPath() {}, rect(x, y, w, h) { LOG.push({ op: 'rect', x, y, w, h }); },
    clip() { LOG.push({ op: 'clip' }); },
    drawImage(img, ...a) { LOG.push({ op: 'drawImage', args: a }); },
    setTransform() {}, measureText: () => ({ width: 0 }), fillText() {},
  });
  return c;
}
globalThis.document = { createElement: () => mkCanvas(), getElementById: () => null, querySelector: () => null, addEventListener() {} };
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
try { Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true }); } catch (_) {}

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));
const { loadWorldMap } = await import('../src/world-map-loader.js');
const { WorldMapRenderer } = await import('../src/world-map-renderer.js');

const world = loadWorldMap(rom, 0);
const r = new WorldMapRenderer(world);
const SIZE = world.mapWidth;
const TILE = 16;

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.error('  ✗ ' + m); failed++; };

// ── 1. The ROM marks foreground terrain at all ────────────────────────────
const prioIds = [];
for (let m = 0; m < 128; m++) {
  const p = world.tileProps[m];
  if (p && (p.byte1 & 0x30)) prioIds.push(m);
}
if (prioIds.length) ok(`ROM marks ${prioIds.length} metatiles with a priority bit`);
else bad('no metatile carries a priority bit — did tileProps parsing change?');

// ── 2. Trees ($64) are among them, with the U bit ─────────────────────────
const TREE = 0x64;
const treeProps = world.tileProps[TREE];
if (treeProps && (treeProps.byte1 & 0x20)) {
  ok(`tree metatile $64 has the U bit (byte1=$${treeProps.byte1.toString(16)})`);
} else {
  bad(`tree metatile $64 lacks the U bit (byte1=$${treeProps ? treeProps.byte1.toString(16) : '??'})`);
}

let treeCount = 0, treePos = null;
for (let i = 0; i < world.tilemap.length; i++) {
  if ((world.tilemap[i] & 0x7F) === TREE) {
    treeCount++;
    if (!treePos) treePos = { x: i % SIZE, y: (i - (i % SIZE)) / SIZE };
  }
}
if (treeCount > 100) ok(`${treeCount} tree tiles on the overworld`);
else bad(`only ${treeCount} tree tiles found — expected hundreds`);

// ── 3. Standing on a tree issues a CLIPPED redraw of that tile ────────────
// Camera centred so the player's 16x16 box sits exactly on the tree tile.
function drawAt(tx, ty) {
  LOG = [];
  const spriteX = 0, spriteY = 0;
  // worldLeft/worldTop = camera - origin; choose so tile (tx,ty) maps to (0,0).
  const camX = tx * TILE, camY = ty * TILE;
  r.drawOverlay({ canvas: { width: 256, height: 240 }, ...mkCanvas().getContext('2d') },
    camX, camY, 0, 0, spriteX, spriteY);
  return LOG;
}

const onTree = drawAt(treePos.x, treePos.y);
const treeDraws = onTree.filter(e => e.op === 'drawImage');
const treeRects = onTree.filter(e => e.op === 'rect');
if (treeDraws.length >= 1) ok(`standing on a tree draws ${treeDraws.length} foreground tile(s)`);
else bad('standing on a tree drew NOTHING in front of the player');

const bottomHalfClip = treeRects.some(e => e.y === 8 && e.h === 8);
if (bottomHalfClip) ok('clip is the sprite’s BOTTOM half (y=8,h=8) — U bit honoured');
else bad('no bottom-half clip rect; got ' + JSON.stringify(treeRects.slice(0, 4)));

// ── 4. Plain terrain draws no foreground ──────────────────────────────────
let plain = null;
for (let i = 0; i < world.tilemap.length && !plain; i++) {
  const m = world.tilemap[i] & 0x7F;
  const p = world.tileProps[m];
  if (p && !(p.byte1 & 0x30)) plain = { x: i % SIZE, y: (i - (i % SIZE)) / SIZE };
}
const onPlain = drawAt(plain.x, plain.y).filter(e => e.op === 'drawImage');
if (onPlain.length === 0) ok('plain terrain draws no foreground overlay');
else bad(`plain terrain drew ${onPlain.length} foreground tile(s) — everything would occlude`);

// ── 5. The priority atlas stays small ─────────────────────────────────────
// The interior renderer prerenders full-map overlays; at 128x128 that would be
// two 2048x2048 buffers (~33MB) and this project has already had boot OOMs.
const atlas = r._getPriorityAtlas();
if (atlas && atlas.canvas.width <= 128 * TILE && atlas.canvas.height === TILE) {
  ok(`priority atlas is ${atlas.canvas.width}x${atlas.canvas.height}px (not a full-map buffer)`);
} else {
  bad('priority atlas is missing or unexpectedly large');
}

// ── 6. A mountain must NOT cover the player's head ────────────────────────
// render.js draws the map at `SCREEN_CENTER_Y + 3` while placing the sprite at
// `SCREEN_CENTER_Y`. With that 3px offset the overlay's tile walk reaches the
// row ABOVE the player even when perfectly tile-aligned — so a mountain
// directly above, which carries the L bit, redrew its bottom 3px across the
// player's head. Reported as "top of the player sprite is getting cut off when
// walking below overworld mountains".
//
// Every check above used originY = 0 and so never saw it. This one mirrors the
// real origins.
function drawAtRealOrigin(tx, ty) {
  LOG = [];
  const spriteY = 0;
  const originY = spriteY + 3;                    // exactly what render.js passes
  r.drawOverlay({ canvas: { width: 256, height: 240 }, ...mkCanvas().getContext('2d') },
    tx * TILE, ty * TILE, 0, originY, 0, spriteY);
  return LOG;
}

// A walkable tile with a foot-blocked, L-bit mountain directly above it.
let belowMountain = null;
for (let y = 1; y < SIZE && !belowMountain; y++) {
  for (let x = 0; x < SIZE; x++) {
    const here = world.tilemap[y * SIZE + x] & 0x7F;
    const up = world.tilemap[(y - 1) * SIZE + x] & 0x7F;
    const pHere = world.tileProps[here], pUp = world.tileProps[up];
    if (!pHere || !pUp) continue;
    if (pHere.byte1 & 0x01) continue;                       // player must be able to stand here
    if (!(pUp.byte1 & 0x10) || (pUp.byte1 & 0x20)) continue; // L-only tile above
    if (!(pUp.byte1 & 0x01)) continue;                       // and it must be foot-blocked
    belowMountain = { x, y };
    break;
  }
}
if (!belowMountain) {
  bad('found no walkable tile below a foot-blocked L-bit mountain to test');
} else {
  const drawn = drawAtRealOrigin(belowMountain.x, belowMountain.y)
    .filter(e => e.op === 'drawImage');
  if (drawn.length === 0) {
    ok(`standing below a mountain at (${belowMountain.x},${belowMountain.y}) draws nothing over the player`);
  } else {
    bad(`a mountain above (${belowMountain.x},${belowMountain.y}) drew ${drawn.length} tile(s) over the ` +
        `player's head — the L bit must only apply to the tile being stood on`);
  }
}

if (failed) { console.error(`\ncheck-tree-occlusion: FAIL (${failed})`); process.exit(1); }
console.log('\ncheck-tree-occlusion: OK');
