#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// ⛔⛔⛔  RENDER IT AND LOOK.  ⛔⛔⛔
//
// backdrop-shot.mjs — the top-box strip a place actually gets, through the
// SHIPPED resolver (`resolveBackdrop`) and the SHIPPED decoder (`getBattleBg`).
//
// The overworld strip was stuck on grassland for every terrain in the game and
// nothing caught it, because looking at it meant walking the world by hand.
// `--walk` renders the strip for each tile along a line, labelled with the
// biome, so a border crossing can be checked in one image.
//
//   node tools/backdrop-shot.mjs --walk 95 41 62 9        # Ur -> desert
//   node tools/backdrop-shot.mjs --walk 95 41 38 24 12    # Ur -> forest, 12 steps
//   node tools/backdrop-shot.mjs --map 111                # a dungeon donor map
//   node tools/backdrop-shot.mjs --dungeon altar          # every floor
import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));

globalThis.window = { addEventListener() {} };
globalThis.document = { createElement: () => createCanvas(8, 8), addEventListener() {} };

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1]; };
const argAt = (n, k) => args[args.indexOf(n) + k];

const { getBattleBg } = await import('../src/battle-bg.js');
const { resolveBackdrop, backdropName, backdropBiome, backdropSourceFor } =
  await import('../src/data/backdrops.js');
const { loadWorldMap } = await import('../src/world-map-loader.js');
const { WorldMapRenderer } = await import('../src/world-map-renderer.js');
const { DUNGEONS } = await import('../src/data/dungeons.js');

const STRIP_W = 256, STRIP_H = 32, LABEL_H = 20, PAD = 6;

/** One labelled strip row. `ctx` is a real resolver context. */
function stripRow(sheetCtx, y, ctx, label) {
  const id = resolveBackdrop(rom, ctx);
  const { bgCanvas } = getBattleBg(rom, id);
  sheetCtx.fillStyle = '#e8e8f0';
  sheetCtx.font = '11px monospace';
  sheetCtx.fillText(
    `${label}  ->  bg ${String(id).padStart(2)} ${backdropName(id)}` +
    `${backdropBiome(id) ? ` (biome ${backdropBiome(id)})` : ''}` +
    `  via ${backdropSourceFor(ctx)}`,
    PAD, y + 3);
  sheetCtx.imageSmoothingEnabled = false;
  sheetCtx.drawImage(bgCanvas, PAD, y + LABEL_H);
  return id;
}

function sheetOf(rows, outPath) {
  // Labels run wider than the 256px strip; give them room rather than clipping.
  const c = createCanvas(Math.max(STRIP_W, 400) + PAD * 2, rows.length * (STRIP_H + LABEL_H) + PAD * 2);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#101014';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.textBaseline = 'top';
  rows.forEach((r, i) => stripRow(ctx, PAD + i * (STRIP_H + LABEL_H), r.ctx, r.label));
  fs.writeFileSync(outPath, c.toBuffer('image/png'));
  console.log('wrote', outPath);
}

const out = flag('--out') || 'backdrop-shot.png';

if (args.includes('--walk')) {
  const x0 = +argAt('--walk', 1), y0 = +argAt('--walk', 2);
  const x1 = +argAt('--walk', 3), y1 = +argAt('--walk', 4);
  const steps = +argAt('--walk', 5) || 8;
  const renderer = new WorldMapRenderer(loadWorldMap(rom, 0));
  const rows = [];
  for (let i = 0; i <= steps; i++) {
    const tx = Math.round(x0 + (x1 - x0) * (i / steps));
    const ty = Math.round(y0 + (y1 - y0) * (i / steps));
    rows.push({
      label: `world ${String(tx).padStart(3)},${String(ty).padStart(3)}`,
      ctx: { onWorldMap: true, mapId: 0, tileX: tx, tileY: ty, worldMapRenderer: renderer },
    });
  }
  // Collapse runs of the same backdrop — a walk of 30 identical grass strips
  // hides the one border crossing that matters.
  const kept = rows.filter((r, i) =>
    i === 0 || i === rows.length - 1 ||
    resolveBackdrop(rom, r.ctx) !== resolveBackdrop(rom, rows[i - 1].ctx) ||
    resolveBackdrop(rom, r.ctx) !== resolveBackdrop(rom, rows[i + 1].ctx));
  sheetOf(kept, out);
} else if (flag('--dungeon')) {
  const d = DUNGEONS.find((x) => x.id === flag('--dungeon'));
  if (!d) { console.error(`no dungeon '${flag('--dungeon')}' — have ${DUNGEONS.map((x) => x.id).join(', ')}`); process.exit(1); }
  const rows = [];
  for (let f = 0; f < d.floors; f++)
    rows.push({ label: `${d.id} floor ${f}${f === d.floors - 1 ? ' (boss)' : ''}`,
                ctx: { onWorldMap: false, mapId: d.base + f } });
  sheetOf(rows, out);
} else {
  const mapId = flag('--map') ? parseInt(flag('--map'), 10) : 114;
  sheetOf([{ label: `map ${mapId}`, ctx: { onWorldMap: false, mapId } }], out);
}
