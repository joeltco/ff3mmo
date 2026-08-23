#!/usr/bin/env node
// loading-shot.mjs — draw the dungeon loading screen the way the player sees it.
//
// The screen has no picture of itself, and it shipped with three of its four
// elements hardcoded to Altar Cave — the Cave of Seals opened under Altar Cave's
// banner, with Altar Cave's floor count and the Land Turtle's HP, over a
// correctly-resolved Djinn. Reading the call site could not show that. Drawing
// it did.
//
//   node tools/loading-shot.mjs               -> loading-<id>.png per dungeon
//   node tools/loading-shot.mjs --id seals

import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import { renderLoadingFrame, initLoadingHarness, W, H } from './lib/loading-frame.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const ZOOM = Math.max(1, parseInt(flag('zoom', '3'), 10));

const m = await initLoadingHarness();
if (!m.haveFF2) console.warn('⚠ no FF2 ROM at ' + m.ff2Path + ' — the Land Turtle silhouette will be blank');

const { DUNGEONS } = await import('../src/data/dungeons.js');
const { dungeonLabels } = await import('../src/dungeon/labels.js');

const only = flag('id', null);
for (const d of DUNGEONS) {
  if (only && d.id !== only) continue;
  const canvas = await renderLoadingFrame(d);
  const out = createCanvas(W * ZOOM, H * ZOOM);
  const octx = out.getContext('2d');
  octx.imageSmoothingEnabled = false;
  octx.drawImage(canvas, 0, 0, W * ZOOM, H * ZOOM);
  const path = new URL(`../loading-${d.id}.png`, import.meta.url).pathname;
  fs.writeFileSync(path, out.toBuffer('image/png'));
  const L = dungeonLabels(d);
  const txt = (b) => [...b].map((c) => (c === 0xFF ? ' '
    : c >= 0x8A && c <= 0xA3 ? String.fromCharCode(65 + c - 0x8A)
    : c >= 0xA4 && c <= 0xBD ? String.fromCharCode(97 + c - 0xA4)
    : c >= 0x80 && c <= 0x89 ? String.fromCharCode(48 + c - 0x80) : '?')).join('');
  console.log(`${d.id.padEnd(6)} "${txt(L.nameBytes)}" | "${txt(L.levelsBytes)}" | "${txt(L.hpBytes)}" -> ${path}`);
}
