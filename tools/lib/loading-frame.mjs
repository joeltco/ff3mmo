// loading-frame.mjs — draw the dungeon loading screen through the REAL modules.
//
// Shared by `tools/loading-shot.mjs` (look at it) and
// `tools/check-loading-screen.mjs` (gate it). One harness, so a gate can never
// pass against a frame the shot tool would not produce.

import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

export const W = 256, H = 240;

let _ctx = null, _canvas = null, _mods = null;

/** Boot the game's UI modules headlessly. Idempotent. */
export async function initLoadingHarness() {
  if (_mods) return _mods;

  globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.document = {
    createElement: () => createCanvas(8, 8),
    addEventListener() {},
    getElementById: () => null,
    fonts: { load: () => Promise.resolve() },
  };

  _canvas = createCanvas(W, H);
  _ctx = _canvas.getContext('2d');

  const { initFont } = await import('../../src/font-renderer.js');
  const { ui } = await import('../../src/ui-state.js');
  const { applyIPS } = await import('../../src/ips-patcher.js');

  const romPath = process.env.FF3_ROM || new URL('../../FF3-English.nes', import.meta.url).pathname;
  const rom = new Uint8Array(fs.readFileSync(romPath));
  // The game patches with ff3-awj.ips at boot before it touches the font; without
  // it every AWJ letter tile is missing and the text renders as garbage.
  applyIPS(rom, new Uint8Array(fs.readFileSync(new URL('../../patches/ff3-awj.ips', import.meta.url).pathname)));
  initFont(rom);
  ui.ctx = _ctx;

  const boot = await import('../../src/boot.js');
  boot.initSpriteAssets(rom);
  // The Land Turtle silhouette is an FF2 rip — without it the default-boss branch
  // draws nothing and a missing silhouette reads as a dungeon-specific choice.
  const ff2 = process.env.FF2_ROM || `${process.env.HOME}/roms/ff2-jp.nes`;
  const haveFF2 = fs.existsSync(ff2);
  if (haveFF2) boot.loadFF2ROM(new Uint8Array(fs.readFileSync(ff2)).buffer);

  const { initMapLoading, setupTopBox } = await import('../../src/map-loading.js');
  initMapLoading(rom);
  const { transSt, topBoxSt, loadingSt } = await import('../../src/transitions.js');
  const { drawLoadingOverlay } = await import('../../src/loading-screen.js');
  const { drawHUD } = await import('../../src/hud-drawing.js');
  // ⛔ `drawHUD` RETURNS EARLY while the title screen is up, and a fresh harness
  // starts there — the top box, which is where the dungeon NAME is drawn during
  // loading, silently never rendered.
  const { titleSt } = await import('../../src/title-screen.js');
  titleSt.state = 'done';

  _mods = { rom, haveFF2, ff2Path: ff2, setupTopBox, transSt, topBoxSt, loadingSt, drawLoadingOverlay, drawHUD };
  return _mods;
}

/**
 * Render one dungeon's loading screen. Returns the canvas (reused between
 * calls — copy the pixels out before rendering again).
 */
export async function renderLoadingFrame(dungeon) {
  const m = await initLoadingHarness();
  _ctx.fillStyle = '#000';
  _ctx.fillRect(0, 0, W, H);
  m.transSt.destMapId = dungeon.base;
  m.transSt.state = 'loading';
  m.transSt.timer = 0;
  m.transSt.dungeon = true;
  m.loadingSt.state = 'visible'; m.loadingSt.timer = 0; m.loadingSt.bgScroll = 0;
  m.setupTopBox(dungeon.base, false);
  // The real path (`_updateTransitionHold`) puts the box in 'fade-in' at step 0
  // while the loading screen is up — 'visible' is not a state it ever holds
  // here, and picking it silently skips the name draw.
  m.topBoxSt.state = 'fade-in'; m.topBoxSt.fadeStep = 0;
  m.drawHUD();
  m.drawLoadingOverlay();
  return _canvas;
}

/** Raw RGBA pixels of the last-rendered frame. */
export function framePixels() {
  return Uint8ClampedArray.from(_ctx.getImageData(0, 0, W, H).data);
}
