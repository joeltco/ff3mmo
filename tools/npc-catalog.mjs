#!/usr/bin/env node
// npc-catalog.mjs — the labelled NPC sprite catalog for FF1, FF2 and FF3.
//
// This exists because Kazus shipped with its shop keepers wearing the GHOST
// sprite. Bundles were being chosen off "which ones does this map load into
// sprite memory", which says nothing about who they DEPICT, and not one was
// rendered before it went out. A sprite is a picture; picking one from a list
// of hex offsets is picking blind.
//
//   node tools/npc-catalog.mjs              # all three games -> docs/sprites/
//   node tools/npc-catalog.mjs --game ff3
//   node tools/npc-catalog.mjs --json
//
// ── FF3 ───────────────────────────────────────────────────────────────────
// Resolution lives in `src/data/npc-gfx.js` (id -> gfx index -> offset); the
// header there records how the table at 0x1410 was found and how it was
// verified (18 maps measured off the PPU, 18 matched). Labels come from the
// ROM's own data: job names for the job range, and for everyone else the maps
// they actually stand in.
//
// ── FF1 / FF2 ─────────────────────────────────────────────────────────────
// Both are the same engine layout and BOTH were read off a running PPU rather
// than guessed:
//
//   * A character is 4 consecutive tiles drawn TL, TR, BL, BR. MEASURED from
//     OAM coordinates — FF1 Coneria Castle has tiles $50,$51,$52,$53 at
//     (32,28),(40,28),(32,36),(40,36), and FF2 Altair has $20..$23 the same
//     way. Guessing this cost four wrong sheets.
//   * An entry is 0x100 bytes = four 16x16 frames, at 0x9010 + n * 0x100,
//     48 entries, ending where background tiles start at 0xC010.
//   * The +0x10 is the iNES header. Rendering from 0x9000 instead of 0x9010
//     misaligns every tile by one and produces confident garbage.
//
// FF1 class names are the game's OWN class-select menu (screenshotted), tied
// to offsets by building a party led by each class and tracing the leader's
// OAM tile home: class N is entry N, for all six.
//
// ⛔ COLOURS ARE INDICATIVE for the ROM-side sheets. FF3 repaints every NPC
// with the palette of the map it stands on (data/npc-palette.js: head tiles
// take the map's SP3, body tiles SP2). The SHAPE is what these sheets are for.

import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.document = { createElement: () => createCanvas(8, 8), getElementById: () => null, addEventListener() {} };

const { decodeTile, NES_SYSTEM_PALETTE } = await import('../src/tile-decoder.js');
const { loadMap } = await import('../src/map-loader.js');
const { JOB_NAMES } = await import('../src/data/jobs.js');
const G = await import('../src/data/npc-gfx.js');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const ONLY = flag('game', null);
const OUTDIR = new URL('../docs/sprites/', import.meta.url).pathname;
fs.mkdirSync(OUTDIR, { recursive: true });

const FF3 = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const FF1 = process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes';
const FF2 = process.env.FF2_ROM || '/home/joeltco/roms/ff2-jp.nes';

const rgb = (v) => NES_SYSTEM_PALETTE[v & 0x3F] || [0, 0, 0];

// ── FF1 / FF2 shared layout, both MEASURED off the PPU (see header) ────────
export const NES12 = { BASE: 0x9010, STRIDE: 0x100, FRAME: 0x40, COUNT: 48, END: 0xC010 };

// FF1 class-select order, read off the game's own menu.
const FF1_CLASSES = ['Fighter', 'Thief', 'Bl.Belt', 'RedMage', 'Wh.Mage', 'Bl.Mage'];

function tilePixels(rom, off) {
  try { return decodeTile(rom, off); } catch { return null; }
}

function drawTile(g, ox, oy, rom, off, pal, SC) {
  const px = tilePixels(rom, off);
  if (!px) return;
  const img = g.createImageData(8 * SC, 8 * SC);
  for (let y = 0; y < 8 * SC; y++) {
    for (let x = 0; x < 8 * SC; x++) {
      const ci = px[Math.floor(y / SC) * 8 + Math.floor(x / SC)];
      const i = (y * 8 * SC + x) * 4;
      if (ci === 0) { img.data[i + 3] = 0; continue; }
      const [r, gg, b] = rgb(pal[ci]);
      img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, ox, oy);
}

/** A 2x2 pose from 4 consecutive tiles, TL TR BL BR. */
function drawPose(g, ox, oy, rom, base, SC, palTop, palBtm) {
  [[0, 0], [1, 0], [0, 1], [1, 1]].forEach(([tx, ty], k) =>
    drawTile(g, ox + tx * 8 * SC, oy + ty * 8 * SC, rom, base + k * 16, ty === 0 ? palTop : palBtm, SC));
}

function isBlankRun(rom, off, tiles) {
  for (let t = 0; t < tiles; t++) {
    const px = tilePixels(rom, off + t * 16);
    if (!px) return true;
    for (const v of px) if (v !== 0) return false;
  }
  return true;
}

function sheet({ title, cells, poses, cellNote, out, SC = 3, cols = 6, bg = '#0e0e18' }) {
  const CELL = 16 * SC;
  const CW = CELL * poses + 16;
  const CH = CELL + 46;
  const rows = Math.ceil(cells.length / cols);
  const cv = createCanvas(cols * CW + 12, rows * CH + 40);
  const g = cv.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.fillStyle = bg; g.fillRect(0, 0, cv.width, cv.height);
  g.textBaseline = 'top';
  g.font = 'bold 14px sans-serif'; g.fillStyle = '#ffd35c';
  g.fillText(title, 10, 10);
  cells.forEach((c, i) => {
    const cx = 10 + (i % cols) * CW, cy = 34 + Math.floor(i / cols) * CH;
    c.draw(g, cx, cy, SC);
    const n = cellNote(c);
    g.font = 'bold 11px sans-serif'; g.fillStyle = n.headColor || '#ffd35c';
    g.fillText(n.head, cx, cy + CELL + 3);
    g.font = '9px sans-serif'; g.fillStyle = '#aab';
    g.fillText((n.line1 || '').slice(0, 40), cx, cy + CELL + 17);
    g.fillStyle = '#889';
    g.fillText((n.line2 || '').slice(0, 40), cx, cy + CELL + 29);
  });
  fs.writeFileSync(out, cv.toBuffer('image/png'));
  return cells.length;
}

// ══ FF3 ═══════════════════════════════════════════════════════════════════
function buildFF3() {
  const rom = new Uint8Array(fs.readFileSync(FF3));
  const placements = new Map();
  for (let mapId = 0; mapId < 512; mapId++) {
    let md; try { md = loadMap(rom, mapId); } catch { continue; }
    for (const n of md.npcs || []) {
      const gfx = G.gfxForNpcId(rom, n.id);
      if (!placements.has(gfx)) placements.set(gfx, []);
      placements.get(gfx).push({ mapId, id: n.id, x: n.x, y: n.y, flags: n.flags });
    }
  }
  const MAP_NAMES = new Map([
    [114, 'Ur'], [1, 'Ur secret2'], [2, 'Ur secret'], [3, 'Ur magic'], [4, 'Ur armor'],
    [5, 'Ur weapon'], [6, 'Ur elder1'], [7, 'Ur elder2'], [8, 'Ur inn'], [9, 'Ur tavern'],
    [10, 'Kazus'], [12, 'Kazus inn'], [15, 'Kazus magic'], [16, 'Kazus weapon'],
    [17, 'Kazus armor'], [18, 'Castle Sasune'],
  ]);
  // ⛔ One representative pair ON PURPOSE here: this sheet is keyed by GFX, and
  // one gfx is worn by NPCs across many maps with different palettes, so there
  // is no single right answer. `tools/npc-sheet-ff3.mjs` is keyed by npcId and
  // does use the real per-map colours. Measurement: tools/ff3-npc-palette.mjs.
  const PT = [0x1A, 0x0F, 0x26, 0x36], PB = [0x1A, 0x0F, 0x12, 0x36];
  const OBJ = [0x0F, 0x16, 0x27, 0x30];

  const entries = [];
  for (let gfx = 0; gfx < G.UNDRAWN_FIRST; gfx++) {
    const off = G.offsetForGfx(gfx);
    const kind = G.kindForGfx(gfx);
    const tiles = G.tileCountForGfx(gfx);
    if (isBlankRun(rom, off, 4)) continue;
    const list = placements.get(gfx) || [];
    entries.push({
      gfx, off, kind, tiles,
      ids: [...new Set(list.map(p => p.id))].sort((a, b) => a - b),
      placements: list.length,
      maps: [...new Set(list.map(p => p.mapId))].sort((a, b) => a - b),
      named: [...new Set(list.map(p => p.mapId))].filter(m => MAP_NAMES.has(m)).map(m => MAP_NAMES.get(m)),
      label: kind === 'job' ? JOB_NAMES[gfx] : null,
    });
  }
  const cells = entries.map(e => ({
    ...e,
    draw: (g, cx, cy, SC) => {
      const poses = e.kind === 'object' ? 2 : 4;
      for (let d = 0; d < poses; d++) {
        drawPose(g, cx + d * 16 * SC, cy, rom, e.off + d * 64, SC,
          e.kind === 'object' ? OBJ : PT, e.kind === 'object' ? OBJ : PB);
      }
    },
  }));
  const n = sheet({
    title: `FF3 — ${entries.length} NPC sprites, resolved through NPC_GFX_TABLE @ 0x1410 ` +
           `(verified against the PPU on 18 maps, 18 matched)`,
    cells, poses: 4, cols: 6,
    out: OUTDIR + 'ff3-npc-catalog.png',
    cellNote: (c) => ({
      head: `#${c.gfx}  0x${c.off.toString(16).toUpperCase()}`,
      headColor: c.kind === 'object' ? '#8fd6ff' : c.kind === 'job' ? '#c8a8ff' : '#ffd35c',
      line1: c.label ? `${c.label} (job)` :
        (c.placements ? `${c.ids.length} id(s), ${c.placements} placements` : 'unused by any map'),
      line2: c.named.length ? c.named.slice(0, 3).join(', ')
        : (c.maps.length ? `maps ${c.maps.slice(0, 5).join(',')}` : `(${c.kind})`),
    }),
  });
  return { game: 'ff3', count: n, entries };
}

// ══ FF1 / FF2 ═════════════════════════════════════════════════════════════
function buildNes12(name, romPath, classes) {
  const rom = new Uint8Array(fs.readFileSync(romPath));
  const PAL = [0x0F, 0x0F, 0x16, 0x36];   // black outline + one colour + pale, as the games use
  const entries = [];
  for (let n = 0; n < NES12.COUNT; n++) {
    const off = NES12.BASE + n * NES12.STRIDE;
    if (isBlankRun(rom, off, 4)) continue;
    entries.push({
      index: n, off,
      label: classes && classes[n] ? classes[n] : null,
      kind: classes && classes[n] ? 'class' : 'npc',
    });
  }
  const cells = entries.map(e => ({
    ...e,
    draw: (g, cx, cy, SC) => {
      for (let f = 0; f < 4; f++) drawPose(g, cx + f * 16 * SC, cy, rom, e.off + f * NES12.FRAME, SC, PAL, PAL);
    },
  }));
  sheet({
    title: `${name.toUpperCase()} — ${entries.length} sprite entries at 0x9010 + n*0x100, ` +
           `four 16x16 frames each (layout measured off the PPU)`,
    cells, poses: 4, cols: 5, SC: 3, bg: '#5a6072',
    out: OUTDIR + `${name}-npc-catalog.png`,
    cellNote: (c) => ({
      head: `#${c.index}  0x${c.off.toString(16).toUpperCase()}`,
      headColor: c.kind === 'class' ? '#ffe9a8' : '#ffd35c',
      line1: c.label ? `${c.label} (player class)` : 'NPC / object',
      line2: '',
    }),
  });
  return { game: name, count: entries.length, entries };
}

const out = [];
if (!ONLY || ONLY === 'ff3') out.push(buildFF3());
if (!ONLY || ONLY === 'ff1') out.push(buildNes12('ff1', FF1, FF1_CLASSES));
if (!ONLY || ONLY === 'ff2') out.push(buildNes12('ff2', FF2, null));

if (args.includes('--json')) {
  console.log(JSON.stringify(out.map(o => ({
    game: o.game, count: o.count,
    entries: o.entries.map(({ draw, ...rest }) => rest),
  })), null, 2));
} else {
  for (const o of out) console.log(`${o.game}: ${o.count} sprite entries -> docs/sprites/${o.game}-npc-catalog.png`);
}
