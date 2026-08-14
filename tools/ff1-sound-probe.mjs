#!/usr/bin/env node
// ff1-sound-probe.mjs — run the REAL FF1 ROM and log every song it asks for,
// with a screenshot of the moment it asked.
//
// FF1 keeps the current track in zero page **$4B** (`music_track`) and starts a
// song through `Music_NewSong` at $B003 with the id in A — both documented in
// src/ff1-nsf-builder.js, which drives that same entry. NSF track N is FF1 song
// id N + $41, so a write of $4F to $4B is NSF track 14.
//
// This exists because ff3mmo's two FF1 constants were "verified by ear":
//   FF1_TRACKS.MENU_SCREEN = 16, FF1_TRACKS.SHOP = 14
// By ear is a PICK. This attributes them to the moment the GAME requests them.
//
//   node tools/ff1-sound-probe.mjs --frames 4000 --shots out/
//   node tools/ff1-sound-probe.mjs --script "start:2,wait:120,a:20" --shots out/
//
// Buttons: a b select start up down left right   (script step is "btn:count")
//
// jsnes note: hook cpu.write, NOT mmap.write — stores below $2000 go straight
// to cpu.mem and never reach the mapper, so a mapper hook sees nothing.

import fs from 'node:fs';
import path from 'node:path';
import { NES, Controller } from 'jsnes';
import { createCanvas } from '@napi-rs/canvas';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const ROM = process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes';
const SHOTS = flag('shots', null);
const FRAMES = parseInt(flag('frames', '3000'), 10);
const SCRIPT = flag('script', null);
const MUSIC_TRACK = 0x4B;

if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const W = 256, H = 240;
const fb = new Uint32Array(W * H);
const nes = new NES({ onFrame: (b) => fb.set(b), onAudioSample: () => {} });
nes.loadROM(fs.readFileSync(ROM, 'binary'));

let frame = 0;
let last = null;
const events = [];
const pendingShots = [];

const cpu = nes.cpu;
const ow = cpu.write.bind(cpu);
cpu.write = function (addr, val) {
  if ((addr & 0xFFFF) === MUSIC_TRACK) {
    const v = val & 0xFF;
    // A real REQUEST has bit 6 set ($41 = song 1). The driver then writes the
    // masked id and a 0 as its own bookkeeping; counting those as requests
    // triples the timeline and invents a "stop" event after every song.
    if ((v & 0x40) && v !== last) {
      last = v;
      const track = (v & 0x3F) - 1;          // FF1 song id -> NSF track
      events.push({ f: frame, val: v, track });
      pendingShots.push({ f: frame, val: v, track });
    }
  }
  return ow(addr, val);
};
const of = nes.frame.bind(nes);
nes.frame = function () { frame++; return of(); };

function shot(name) {
  if (!SHOTS) return;
  const c = createCanvas(W, H); const x = c.getContext('2d');
  const d = x.createImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    const p = fb[i];
    d.data[i * 4] = p & 255; d.data[i * 4 + 1] = (p >> 8) & 255; d.data[i * 4 + 2] = (p >> 16) & 255; d.data[i * 4 + 3] = 255;
  }
  x.putImageData(d, 0, 0);
  fs.writeFileSync(path.join(SHOTS, name), c.toBuffer('image/png'));
}

// Screenshot 45 frames AFTER a request, so whatever screen the music belongs to
// has actually been drawn. Shooting on the write itself catches the old screen.
function run(n) {
  for (let i = 0; i < n; i++) {
    nes.frame();
    for (const p of pendingShots) {
      if (!p.done && frame - p.f === 45) {
        p.done = true;
        shot(`track${String(p.track).padStart(2, '0')}-f${String(p.f).padStart(5, '0')}.png`);
      }
    }
  }
}
const B = {
  a: Controller.BUTTON_A, b: Controller.BUTTON_B,
  select: Controller.BUTTON_SELECT, start: Controller.BUTTON_START,
  up: Controller.BUTTON_UP, down: Controller.BUTTON_DOWN,
  left: Controller.BUTTON_LEFT, right: Controller.BUTTON_RIGHT,
};
const press = (name, hold = 6, after = 16) => {
  nes.buttonDown(1, B[name]); run(hold); nes.buttonUp(1, B[name]); run(after);
};

// Savestates: reaching free roam costs ~6300 frames of party creation. Park it
// once and every later probe starts in a second.
const LOAD = flag('loadstate', null);
const SAVE = flag('savestate', null);
if (LOAD) { nes.fromJSON(JSON.parse(fs.readFileSync(LOAD, 'utf8'))); run(8); }

if (SCRIPT) {
  for (const step of SCRIPT.split(',')) {
    const [btn, n] = step.split(':');
    const count = parseInt(n || '1', 10);
    if (btn === 'wait') { run(count); continue; }
    if (btn === 'shot') { shot(`mark-f${String(frame).padStart(5, '0')}.png`); continue; }
    for (let i = 0; i < count; i++) press(btn, 6, 16);
  }
} else {
  run(FRAMES);
}

if (SAVE) { fs.writeFileSync(SAVE, JSON.stringify(nes.toJSON())); console.log('parked state -> ' + SAVE); }

console.log(`FF1 ${ROM} — ${frame} frames, watching $4B (music_track)\n`);
console.log('  frame   value  NSF track');
console.log('  ------  -----  ---------');
for (const e of events) {
  console.log(`  ${String(e.f).padStart(6)}  $${e.val.toString(16).padStart(2, '0')}    ` +
    (e.track < 0 ? '(stop/none)' : e.track));
}
const tracks = [...new Set(events.filter(e => e.track >= 0).map(e => e.track))].sort((a, b) => a - b);
console.log('\ndistinct NSF tracks requested: ' + (tracks.join(', ') || '(none)'));
if (SHOTS) console.log('shots -> ' + SHOTS + '/');
