#!/usr/bin/env node
// valley-cast-sheet.mjs — the sprite bundles the BEGINNER VALLEY can actually
// draw, side by side, so a casting decision is made by looking rather than by
// reading a hex offset off a table.
//
// ⛔ WHY THIS IS NARROWER THAN `npc-sheet-ff3.mjs`. That renders all 179 drawn
// NPC ids in the game; almost none of them are castable here. FF3 is CHR-RAM —
// a walk bundle only exists on screen if the map copied it into sprite memory,
// so the real candidate list for a given room is the handful of bundles that
// room LOADS. `check-npc-placement.mjs#LOADED_BUNDLES` is the measured table;
// this sheet draws exactly those, labelled with which rooms can hold them.
//
// ⭐ Map 174 (Sasune's East Tower) is in the list with an EMPTY set — measured
// 2026-08-25 with `MAPS=174,19,30 node tools/monscan/map-bundles.cjs`. It loads
// nine player/battle bundles and NO townsfolk bundle at all, exactly like map
// 11. Anybody placed there renders as tilemap noise. That is why Princess Sara
// is not in her canonical tower room.
//
//   node tools/valley-cast-sheet.mjs      -> docs/sprites/ff3-valley-cast.png

import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
const G = await import('../src/data/npc-gfx.js');
const { loadMap } = await import('../src/map-loader.js');
const { decodeTile: romTile, NES_SYSTEM_PALETTE } = await import('../src/tile-decoder.js');

const rom = new Uint8Array(fs.readFileSync(new URL('../FF3-English.nes', import.meta.url).pathname));

// Which rooms load which bundle — transcribed from check-npc-placement.mjs.
const ROOMS = new Map([
  [0x01D910, 'Kazus town(10), Kazus pub(12)'],
  [0x01DF10, 'Ur(114), Ur tavern(9), Kazus(10,12,16,17)'],
  [0x01E010, 'Ur(114,9,8,7), Kazus(10,12,13), Sasune yard(18)'],
  [0x01E110, 'Ur tavern(9)'],
  [0x01E210, 'Ur(114,8,7,2), Kazus(10,14)'],
  [0x01E310, 'Ur(114)'],
  [0x01E410, 'Kazus pub(12)'],
  [0x01E510, 'Ur(114)'],
  [0x01E610, 'Ur shops(5,4), Ur tavern(9), Kazus shops(16,17)'],
  [0x01E710, 'Ur tavern(9)'],
  [0x01EC10, 'Ur elder(7,6)'],
  [0x01ED10, 'Kazus pub(12), Kazus shops(16,17), Sasune halls(25,26,27), throne(29)'],
  [0x01EE10, 'Sasune yard(18), halls(25,26,27), throne(29)'],
  [0x01EF10, 'Sasune throne(29) ONLY'],
]);

// Who wears each bundle, from the ROM's own id -> gfx table at 0x1410.
const wearers = new Map();
for (let id = 0; id < 256; id++) {
  const off = G.offsetForGfx(G.gfxForNpcId(rom, id));
  if (off == null) continue;
  if (!wearers.has(off)) wearers.set(off, []);
  wearers.get(off).push(id);
}
// …and which of them the cartridge actually PLACES somewhere.
const placedIds = new Set();
for (let m = 0; m < 256; m++) {
  let md; try { md = loadMap(rom, m); } catch { continue; }
  for (const n of md.npcs || []) placedIds.add(n.id);
}

// MEASURED: top half = the map's spritePalette7, bottom half = spritePalette6.
// Sasune's throne room is the palette used here — every candidate is judged in
// one room's colours, because a bundle is not chosen until its palette is.
let PAL = { top: [0x0F, 0x0F, 0x26, 0x36], btm: [0x0F, 0x0F, 0x12, 0x36] };
try { const sp = loadMap(rom, 29).spritePalettes; if (sp) PAL = { top: sp[1], btm: sp[0] }; } catch { /* default */ }

const SC = 4, TILE = 8, CELL_W = 16 * SC + 8, ROW_H = 16 * SC + 34;
const rgb = (v) => NES_SYSTEM_PALETTE[v & 0x3F] || [0, 0, 0];
// ⛔ The REAL decoder, not a hand-copy. A tool that reimplements a game
// function keeps agreeing with itself after the game's copy changes — that has
// happened four times with `calcSpawnY` alone.
const decodeTile = (off) => romTile(rom, off);

const rows = [...ROOMS.keys()];
const cv = createCanvas(760, rows.length * ROW_H + 40);
const g = cv.getContext('2d');
g.fillStyle = '#101018'; g.fillRect(0, 0, cv.width, cv.height);
g.font = '13px monospace'; g.fillStyle = '#e8e8f0';
g.fillText('Bundles the beginner valley can draw — DOWN frame, Sasune throne palette', 10, 22);

rows.forEach((off, i) => {
  const y = 34 + i * ROW_H;
  // DOWN frame = the first 4 tiles, 2x2.
  for (let t = 0; t < 4; t++) {
    const pal = t < 2 ? PAL.top : PAL.btm;
    const px = decodeTile(off + t * 16);
    const dx = 12 + (t % 2) * TILE * SC, dy = y + Math.floor(t / 2) * TILE * SC;
    const img = g.createImageData(TILE * SC, TILE * SC);
    for (let yy = 0; yy < TILE * SC; yy++) for (let xx = 0; xx < TILE * SC; xx++) {
      const ci = px[Math.floor(yy / SC) * 8 + Math.floor(xx / SC)];
      const k = (yy * TILE * SC + xx) * 4;
      if (ci === 0) { img.data[k + 3] = 0; continue; }
      const [r, gg, b] = rgb(pal[ci]);
      img.data[k] = r; img.data[k + 1] = gg; img.data[k + 2] = b; img.data[k + 3] = 255;
    }
    g.putImageData(img, dx, dy);
  }
  const ids = wearers.get(off) || [];
  const shown = ids.filter((id) => placedIds.has(id));
  g.fillStyle = '#ffd77a'; g.font = 'bold 13px monospace';
  g.fillText(`0x${off.toString(16).toUpperCase()}`, CELL_W + 12, y + 16);
  g.fillStyle = '#9fd8ff'; g.font = '11px monospace';
  g.fillText(`worn by ids ${shown.join(' ') || '(none placed)'}`, CELL_W + 12, y + 34);
  g.fillStyle = '#b8b8c8';
  g.fillText(ROOMS.get(off), CELL_W + 12, y + 50);
});

const out = new URL('../docs/sprites/ff3-valley-cast.png', import.meta.url).pathname;
fs.writeFileSync(out, cv.toBuffer('image/png'));
console.log(`${rows.length} bundles -> ${out}`);
