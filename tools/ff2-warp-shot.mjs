#!/usr/bin/env node
// ff2-warp-shot.mjs — warp FF2 to location ids and render what you land on.
//
// The warp (`lib/ff2-locations.mjs`) proves the MAP loads, but a map buffer is not
// a playable scene. This renders the screen so the location can be identified by
// eye — which is the only way to tell an overworld from a town from a dungeon
// before any encounter work can start.
//
//   node tools/ff2-warp-shot.mjs --locs 0x00,0x10,0x5C --out /tmp/ff2
//   node tools/ff2-warp-shot.mjs --sweep 0x00 0x20
//
// ⛔ `$D083` disables rendering ($2001=0) on its way in; the map loop turns it
// back on. Give it frames before judging a black screen.

import fs from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { NES } from 'jsnes';
import * as L2 from './lib/ff2-locations.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const OUT = flag('out', '/tmp/claude-1000/-home-joeltco/72d75d82-4b24-4ec2-9ca9-88978d5cb2d3/scratchpad/ff2');
const FRAMES = Number(flag('frames', '150'));
const W = 256, H = 240;

const { rom, snapshot } = L2.loadFixtures();
const hx = (v, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');

let locs;
if (args.includes('--sweep')) {
  const i = args.indexOf('--sweep');
  const lo = Number(args[i + 1]), hi = Number(args[i + 2]);
  locs = Array.from({ length: hi - lo }, (_, k) => lo + k);
} else {
  locs = flag('locs', '0x00,0x5C,0x60').split(',').map(Number);
}

fs.mkdirSync(OUT, { recursive: true });

/** Warp, then keep running so the map loop can re-enable rendering. */
function land(loc) {
  let fb = null;
  const nes = new NES({ onFrame: (b) => { fb = b; }, onAudioSample: () => {} });
  nes.loadROM(Buffer.from(rom).toString('binary'));
  nes.fromJSON(JSON.parse(snapshot));
  nes.frame();
  const cpu = nes.cpu;
  cpu.mem[L2.LOC_ID_ZP] = loc & 0xFF;
  const stub = [0x20, L2.ENTER_LOCATION_PC & 0xFF, L2.ENTER_LOCATION_PC >> 8, ...L2.NMI_TRAMPOLINE];
  stub.forEach((b, i) => { cpu.mem[L2.NMI_STUB_RAM + i] = b; });
  cpu.mem[L2.NMI_VECTOR_RAM] = 0x4C;
  cpu.mem[L2.NMI_VECTOR_RAM + 1] = L2.NMI_STUB_RAM & 0xFF;
  cpu.mem[L2.NMI_VECTOR_RAM + 2] = L2.NMI_STUB_RAM >> 8;
  nes.frame();
  L2.NMI_TRAMPOLINE.forEach((b, i) => { cpu.mem[L2.NMI_VECTOR_RAM + i] = b; });
  for (let i = 0; i < FRAMES; i++) nes.frame();
  return { nes, fb, cpu };
}

const png = (fb, file) => {
  const cv = createCanvas(W * 2, H * 2), cx = cv.getContext('2d');
  const img = cx.createImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    const q = fb[i];
    img.data[i * 4] = q & 0xFF; img.data[i * 4 + 1] = (q >> 8) & 0xFF;
    img.data[i * 4 + 2] = (q >> 16) & 0xFF; img.data[i * 4 + 3] = 255;
  }
  const t = createCanvas(W, H); t.getContext('2d').putImageData(img, 0, 0);
  cx.imageSmoothingEnabled = false; cx.drawImage(t, 0, 0, W * 2, H * 2);
  fs.writeFileSync(file, cv.toBuffer('image/png'));
};

console.log('loc  tilemap  lit%   distinct-tiles  file');
for (const loc of locs) {
  const { fb, nes } = land(loc);
  if (!fb) { console.log(`${hx(loc)}   (no frame)`); continue; }
  const counts = new Map();
  for (let i = 0; i < fb.length; i++) counts.set(fb[i], (counts.get(fb[i]) || 0) + 1);
  let bg = 0, best = -1;
  for (const [c, k] of counts) if (k > best) { best = k; bg = c; }
  const lit = [...fb].filter(p => p !== bg).length / fb.length;
  const nt = new Set([...nes.ppu.vramMem.slice(0x2000, 0x23C0)]).size;
  const file = path.join(OUT, `loc-${hx(loc)}.png`);
  png(fb, file);
  console.log(`${hx(loc)}   ${hx(L2.tilemapOf(rom, loc))}      ${(lit * 100).toFixed(0).padStart(3)}%   ${String(nt).padStart(3)}             ${file}`);
}
