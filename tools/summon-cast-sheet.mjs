#!/usr/bin/env node
// summon-cast-sheet.mjs — the summon CAST burst, frame by frame, as captured.
//
//   node tools/summon-cast-sheet.mjs            # the shared cast animation
//   node tools/summon-cast-sheet.mjs --creature=0x30
//
// The cast burst is the summon school's own animation ($55810) and is shared by
// all eight creatures. This draws every captured frame at its own hold, on the
// 256x152 source rect it was captured against, so where it sits ON THE NES
// SCREEN is visible rather than inferred.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.findIndex((a) => a.startsWith(`--${n}=`)); return i === -1 ? d : args[i].split('=')[1]; };
const CREATURE = flag('creature', null);

globalThis.window = { addEventListener() {}, devicePixelRatio: 1 };
globalThis.document = { createElement: () => createCanvas(8, 8), addEventListener() {},
                        getElementById: () => null, body: { appendChild() {} },
                        fonts: { load: () => Promise.resolve() } };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {}, clear() {} };

const rom = new Uint8Array(fs.readFileSync(path.join(HERE, '..', 'FF3-English.nes')));
const { applyIPS } = await import('../src/ips-patcher.js');
applyIPS(rom, new Uint8Array(fs.readFileSync(path.join(HERE, '..', 'patches', 'ff3-awj.ips'))));
const { initTextDecoder } = await import('../src/text-decoder.js');
const { initFont } = await import('../src/font-renderer.js');
const { initSpriteAssets } = await import('../src/boot.js');
initTextDecoder(rom); initFont(rom); initSpriteAssets(rom);
const { getSummon, summonCastFrameAt, summonPhaseAt, summonTotalMs } = await import('../src/summon-anim.js');
const { CAPTURED_SUMMONS } = await import('../src/data/summon-anim-captured.js');

const id = CREATURE === null ? 0x30 : Number(CREATURE);
const s = getSummon(id);
const cap = CAPTURED_SUMMONS.get(id);
if (!s) { console.error('no summon 0x' + id.toString(16)); process.exit(1); }

const BAND_W = 256, BAND_H = 144, SCALE = 2, PAD = 4, LABEL = 12, COLS = 8;

/** Draw one band frame onto a fresh canvas so its position in the band shows. */
function bandOf(frameCanvas) {
  const c = createCanvas(BAND_W, BAND_H);
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.fillStyle = '#000'; g.fillRect(0, 0, BAND_W, BAND_H);
  if (frameCanvas) g.drawImage(frameCanvas, 0, 0);
  // where ff3mmo's player portrait sits in this same band (HUD_VIEW_Y = 32)
  g.strokeStyle = '#40ff70'; g.lineWidth = 1;
  g.strokeRect(152.5, 40 - 32 + 0.5, 15, 15);
  return c;
}

const which = CREATURE === null || !cap.cast ? 'cast' : 'cast';
const frames = s.cast ? s.cast.frames : [];
const holds = s.cast ? s.cast.holds : [];
console.log(`summon 0x${id.toString(16)}  cast frames=${frames.length}  total=${holds.reduce((a, c) => a + c, 0)}ms`);
console.log(`capture box: ${JSON.stringify(cap.cast && cap.cast.box)}   (NES screen coords)`);

const rows = Math.ceil(frames.length / COLS);
const sheet = createCanvas(PAD + COLS * (BAND_W * SCALE + PAD), PAD + rows * (BAND_H * SCALE + LABEL + PAD));
const sc = sheet.getContext('2d');
sc.imageSmoothingEnabled = false;
sc.fillStyle = '#12121a'; sc.fillRect(0, 0, sheet.width, sheet.height);
frames.forEach((fr, i) => {
  const x = PAD + (i % COLS) * (BAND_W * SCALE + PAD);
  const y = PAD + Math.floor(i / COLS) * (BAND_H * SCALE + LABEL + PAD);
  sc.drawImage(bandOf(fr), x, y, BAND_W * SCALE, BAND_H * SCALE);
  sc.fillStyle = '#c8c8d8'; sc.font = '10px monospace';
  sc.fillText(`f${i}  ${Math.round(holds[i])}ms`, x, y + BAND_H * SCALE + 10);
});
const out = path.join(HERE, 'out', `summon-cast-${id.toString(16)}.png`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, sheet.toBuffer('image/png'));
console.log(out);
