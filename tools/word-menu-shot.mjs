#!/usr/bin/env node
// word-menu-shot.mjs — render the ASK/LEARN menu the way the player sees it.
//
// The verb menu is the one panel with no picture of itself. It shipped with a
// black interior under a blue message box and a cursor sitting on the text
// baseline instead of 4px above it, and no gate noticed because both are
// "it renders" facts, not logic. So: draw it and look.
//
//   node tools/word-menu-shot.mjs            -> word-menu.png
//   node tools/word-menu-shot.mjs --rows ask

import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };

globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.document = {
  createElement: () => createCanvas(8, 8),
  addEventListener() {},
  getElementById: () => null,
};

const W = 256, H = 240;
const ZOOM = Math.max(1, parseInt(flag('zoom', '3'), 10));
const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');

const { initFont } = await import('../src/font-renderer.js');
const { ui } = await import('../src/ui-state.js');
const { initHUD } = await import('../src/hud-init.js');
const { initCursorTile, initScrollArrows } = await import('../src/sprite-init.js');
const { drawBorderedBox } = await import('../src/hud-drawing.js');
const { _nameToBytes } = await import('../src/text-utils.js');
const mb = await import('../src/message-box.js');
const wm = await import('../src/word-menu.js');
const { KEYWORDS } = await import('../src/data/keywords.js');

const ROM_PATH = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM_PATH));
// The game patches the ROM with patches/ff3-awj.ips at boot (main.js) before it
// touches the font. Without it the AWJ letter tiles this project encodes text
// into are not in the ROM and every string renders as garbage — which is what
// the first run of this tool produced, and it looked like a text bug rather
// than a tool bug.
const { applyIPS } = await import('../src/ips-patcher.js');
applyIPS(rom, new Uint8Array(fs.readFileSync(new URL('../patches/ff3-awj.ips', import.meta.url).pathname)));
initFont(rom);
ui.ctx = ctx;
initHUD(rom);
const _ct = initCursorTile(rom);
ui.cursorTileCanvas = _ct.cursorTileCanvas;
ui.cursorFadeCanvases = _ct.cursorFadeCanvases;
// The scroll arrows are a separate init (boot.js does both). Without this the
// shot draws a scrolling list with no arrows and looks like the arrows are
// broken — which is exactly what the first run of the v1.8.7 scroll shot did.
const _sa = initScrollArrows(rom);
ui.scrollArrowUp = _sa.scrollArrowUp;
ui.scrollArrowDown = _sa.scrollArrowDown;
// The arrows blink on a 250 ms wall-clock phase; a shot has to be deterministic,
// so pin Date.now to the ON half rather than running the tool twice hoping.
const _realNow = Date.now;
Date.now = () => 0;
process.on('exit', () => { Date.now = _realNow; });

mb.registerMsgHighlights(Object.values(KEYWORDS).map(k => k.text));

// Viewport backdrop, so the panels are judged against the same black the game
// draws them over rather than against a transparent canvas.
ctx.fillStyle = '#000';
ctx.fillRect(0, 0, W, H);

mb.showMsgBox(_nameToBytes('Mind the cave north. It took my brother.'));
mb.msgState.state = 'hold';
mb.msgState.typed = mb.msgState.bytes.length;

// `--rows scroll` is the case the scroll arrows exist for: MAX_VISIBLE is 4
// and the vocabulary was already 4 when v1.8.7 added them, so the very next
// term starts the list scrolling. Draw it at 6 and check the arrow does not
// land on the last glyph of the longest label.
const mode = flag('rows', 'verbs');
const rows = mode === 'ask'
  ? [{ label: 'BROTHER', act: 'say', term: true, has: true },
     { label: 'CAVE',    act: 'say', term: true, has: true },
     { label: 'RIDERS',  act: 'say', term: true, has: false }]
  : mode === 'scroll'
  ? [{ label: 'BROTHER', act: 'say', term: true, has: true },
     { label: 'CAVE',    act: 'say', term: true, has: true },
     { label: 'RIDERS',  act: 'say', term: true, has: false },
     { label: 'VEIN',    act: 'say', term: true, has: true },
     { label: 'CRYSTAL', act: 'say', term: true, has: false },
     { label: 'DJINN',   act: 'say', term: true, has: true }]
  : [{ label: 'LEARN', act: 'learn' }, { label: 'ASK', act: 'ask' }];

wm.wordMenuSt.open = true;
wm.wordMenuSt.rows = rows;
wm.wordMenuSt.index = mode === 'scroll' ? parseInt(flag('index', '2'), 10) : 1;
wm.wordMenuSt.scroll = mode === 'scroll' ? parseInt(flag('scroll', '1'), 10) : 0;

mb.drawMsgBox(ctx, drawBorderedBox);
wm.drawWordMenu();

const out = createCanvas(W * ZOOM, H * ZOOM);
const octx = out.getContext('2d');
octx.imageSmoothingEnabled = false;
octx.drawImage(canvas, 0, 0, W * ZOOM, H * ZOOM);
const dest = flag('out', 'word-menu.png');
fs.writeFileSync(dest, out.toBuffer('image/png'));
console.log('wrote ' + dest);
