#!/usr/bin/env node
// ff1-overworld-sweep.mjs — find FF1's locations by their MUSIC.
//
// Walking the overworld blind to reach a shop wasted a lot of frames. The party's
// overworld position is just two zero-page bytes — MEASURED by diffing RAM while
// walking: **$027 = X** (moves on RIGHT only) and **$028 = Y** (moves on DOWN
// only). So warp instead of walk: poke a coordinate, take a step, and watch
// `music_track` ($4B).
//
// Entering a town / castle / shop is exactly what changes the music, so a
// coordinate that produces a NEW song request is a location entrance — the sweep
// labels itself. That is the same idea as the FF3 map-music probe, one game over.
//
//   node tools/ff1-overworld-sweep.mjs --x0 120 --x1 175 --y0 140 --y1 190
//   node tools/ff1-overworld-sweep.mjs --state ff1-world.state --shots out/
//
// Needs a free-roam savestate (tools/ff1-sound-probe.mjs --savestate).

import fs from 'node:fs';
import path from 'node:path';
import { NES, Controller } from 'jsnes';
import { createCanvas } from '@napi-rs/canvas';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const ROM = process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes';
const STATE = flag('state', null);
const SHOTS = flag('shots', null);
const X0 = parseInt(flag('x0', '120'), 10), X1 = parseInt(flag('x1', '176'), 10);
const Y0 = parseInt(flag('y0', '140'), 10), Y1 = parseInt(flag('y1', '190'), 10);
const STEP = parseInt(flag('step', '2'), 10);
if (!STATE) { console.error('usage: --state <free-roam.state>'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const POS_X = 0x027, POS_Y = 0x028, MUSIC_TRACK = 0x4B;

const fb = new Uint32Array(256 * 240);
const romBin = fs.readFileSync(ROM, 'binary');
const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));

// One machine, restored per trial — building a fresh NES per coordinate would
// allocate a new set of large arrays hundreds of times.
const nes = new NES({ onFrame: (b) => fb.set(b), onAudioSample: () => {} });
nes.loadROM(romBin);

let requests = [];
let lastVal = null;
const cpu = nes.cpu;
const ow = cpu.write.bind(cpu);
cpu.write = function (addr, val) {
  if ((addr & 0xFFFF) === MUSIC_TRACK) {
    const v = val & 0xFF;
    if ((v & 0x40) && v !== lastVal) { lastVal = v; requests.push((v & 0x3F) - 1); }
  }
  return ow(addr, val);
};

function shot(name) {
  if (!SHOTS) return;
  const c = createCanvas(256, 240); const x = c.getContext('2d');
  const d = x.createImageData(256, 240);
  for (let i = 0; i < 256 * 240; i++) {
    const p = fb[i];
    d.data[i * 4] = p & 255; d.data[i * 4 + 1] = (p >> 8) & 255; d.data[i * 4 + 2] = (p >> 16) & 255; d.data[i * 4 + 3] = 255;
  }
  x.putImageData(d, 0, 0);
  fs.writeFileSync(path.join(SHOTS, name), c.toBuffer('image/png'));
}

const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
const hold = (b, n) => { nes.buttonDown(1, b); run(n); nes.buttonUp(1, b); run(12); };

const hits = [];
let tried = 0;
for (let y = Y0; y <= Y1; y += STEP) {
  for (let x = X0; x <= X1; x += STEP) {
    nes.fromJSON(structuredClone(state));
    run(6);
    nes.cpu.mem[POS_X] = x; nes.cpu.mem[POS_Y] = y;
    run(20);
    requests = []; lastVal = null;
    // A step is what triggers an entrance; standing on the tile is not enough.
    try {
      hold(Controller.BUTTON_DOWN, 24);
      run(90);
      hold(Controller.BUTTON_UP, 24);
      run(90);
    } catch { /* a bad warp can wedge the machine; that is not a hit */ }
    tried++;
    const got = [...new Set(requests)].filter(t => t >= 0);
    if (got.length) {
      hits.push({ x, y, tracks: got });
      console.log(`  (${x},${y})  track ${got.join(', ')}`);
      shot(`loc-${x}-${y}-track${got[0]}.png`);
    }
  }
  process.stderr.write(`  ...y=${y} (${tried} coords, ${hits.length} hits)\n`);
}

console.log(`\n${tried} coordinates, ${hits.length} produced a music change`);
const byTrack = new Map();
for (const h of hits) for (const t of h.tracks) {
  if (!byTrack.has(t)) byTrack.set(t, []);
  byTrack.get(t).push(`${h.x},${h.y}`);
}
for (const [t, cs] of [...byTrack].sort((a, b) => a[0] - b[0])) {
  console.log(`  track ${String(t).padStart(2)}  at ${cs.length} coord(s): ${cs.slice(0, 6).join(' ')}`);
}
