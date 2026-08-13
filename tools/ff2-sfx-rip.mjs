#!/usr/bin/env node
// ff2-sfx-rip.mjs — run the REAL FF2 (J) ROM and log every sound the game asks
// for, with a screenshot of the moment it asked.
//
// From tools/ff2-sound-map.mjs, FF2's whole audio API is ONE zero-page byte:
//
//   $E0 written with bit 6 set  -> play table entry (value & $3F)
//   $E0 written with bit 7 set  -> restore the stashed music ("sfx over")
//   $E5                         -> a frame countdown; when it hits 0 the driver
//                                  writes $30 to $4004, i.e. it silences pulse 2
//
// So there is no separate SFX engine to reverse: sound effects ARE entries in
// the same 39-entry table the music uses, and "which sound is the cursor blip"
// is answerable by watching $E0 while pressing the button.
//
// This hooks the CPU's write path, so every store is caught wherever it came
// from — no need to know which bank or which routine did it.
//
//   node tools/ff2-sfx-rip.mjs --frames 1800 --shots out/ff2
//   node tools/ff2-sfx-rip.mjs --script "start:2,wait:120,a:6" --shots out/ff2
//   node tools/ff2-sfx-rip.mjs --loadstate ff2.state --script "down:1,down:1"
//
// Buttons: a b select start up down left right   (script step is "btn:count")

import fs from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { NES, Controller } from 'jsnes';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const has = (n) => args.includes('--' + n);

const ROM = process.env.FF2_ROM || '/home/joeltco/roms/ff2-jp.nes';
const SHOT_DIR = flag('shots', null);
const ZOOM = Math.max(1, parseInt(flag('zoom', '2'), 10));
const W = 256, H = 240;

const frameBuf = new Uint8Array(W * H * 3);
const nes = new NES({
  onFrame: (buf) => {
    for (let i = 0; i < W * H; i++) {
      const p = buf[i];
      frameBuf[i * 3] = p & 0xFF; frameBuf[i * 3 + 1] = (p >> 8) & 0xFF; frameBuf[i * 3 + 2] = (p >> 16) & 0xFF;
    }
  },
  onAudioSample: () => {},
});
nes.loadROM(fs.readFileSync(ROM, 'latin1'));

// ── the hook ──────────────────────────────────────────────────────────────
// jsnes routes every CPU store through mmap.write. Wrapping it catches stores
// from any bank without having to know which routine ran — the alternative,
// grepping the ROM for `STA $E0` sites, misses stores made through an indexed
// or indirect address.
const WATCH = new Set((flag('watch', 'E0,E5')).split(',').map(h => parseInt(h, 16)));
let frame = 0;
const events = [];
// NOTE: hook cpu.write, NOT mmap.write. jsnes short-circuits every store below
// $2000 straight into `this.mem[addr & 0x7ff]` and never calls the mapper, so a
// mapper hook sees ZERO zero-page writes and reports "this game never asks for
// a sound" — a false negative that looks exactly like a correct measurement.
const origWrite = nes.cpu.write.bind(nes.cpu);
nes.cpu.write = (addr, val) => {
  const a = addr & 0xFFFF;
  // Below $2000 only log real CHANGES (the driver rewrites the same value
  // constantly); at/above $2000 every APU store matters, even a repeat.
  if (WATCH.has(a) && (a >= 0x2000 || (nes.cpu.mem[a & 0x7FF] & 0xFF) !== (val & 0xFF))) {
    events.push({ frame, addr: a, val: val & 0xFF, pc: nes.cpu.REG_PC & 0xFFFF });
  }
  return origWrite(addr, val);
};

const BUTTON = {
  a: Controller.BUTTON_A, b: Controller.BUTTON_B,
  select: Controller.BUTTON_SELECT, start: Controller.BUTTON_START,
  up: Controller.BUTTON_UP, down: Controller.BUTTON_DOWN,
  left: Controller.BUTTON_LEFT, right: Controller.BUTTON_RIGHT,
};
const marks = [];   // [{frame, label}] — what we were doing when
const SHOT_EVERY = parseInt(flag('shotevery', '0'), 10);
function run(n) {
  for (let i = 0; i < n; i++) {
    nes.frame(); frame++;
    if (SHOT_EVERY && frame % SHOT_EVERY === 0) shot(`t-f${String(frame).padStart(5, '0')}.png`);
  }
}
function press(btn, hold = 4, idle = 8) {
  marks.push({ frame, label: `press ${btn}` });
  nes.buttonDown(1, BUTTON[btn]); run(hold);
  nes.buttonUp(1, BUTTON[btn]); run(idle);
}

function shot(name) {
  if (!SHOT_DIR) return;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const c = createCanvas(W * ZOOM, H * ZOOM);
  const cx = c.getContext('2d');
  const src = createCanvas(W, H);
  const sctx = src.getContext('2d');
  const img = sctx.createImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    img.data[i * 4] = frameBuf[i * 3]; img.data[i * 4 + 1] = frameBuf[i * 3 + 1];
    img.data[i * 4 + 2] = frameBuf[i * 3 + 2]; img.data[i * 4 + 3] = 255;
  }
  sctx.putImageData(img, 0, 0);
  cx.imageSmoothingEnabled = false;
  cx.drawImage(src, 0, 0, W * ZOOM, H * ZOOM);
  fs.writeFileSync(path.join(SHOT_DIR, name), c.toBuffer('image/png'));
}

// ── drive ─────────────────────────────────────────────────────────────────
const loadState = flag('loadstate', null);
if (loadState) { nes.fromJSON(JSON.parse(fs.readFileSync(loadState, 'utf8'))); run(8); }
else run(parseInt(flag('boot', '240'), 10));

const script = flag('script', null);
if (script) {
  for (const step of script.split(',')) {
    const [btn, n] = step.split(':');
    const count = parseInt(n || '1', 10);
    if (btn === 'wait') { marks.push({ frame, label: `wait ${count}` }); run(count); continue; }
    if (btn === 'shot') { shot(`mark-f${String(frame).padStart(5, '0')}.png`); continue; }
    for (let i = 0; i < count; i++) press(btn, parseInt(flag('hold', '4'), 10), parseInt(flag('idle', '10'), 10));
  }
}
run(parseInt(flag('frames', '0'), 10));

const saveState = flag('savestate', null);
if (saveState) fs.writeFileSync(saveState, JSON.stringify(nes.toJSON()));

// ── report ────────────────────────────────────────────────────────────────
const hx = (v, n = 2) => '$' + v.toString(16).padStart(n, '0');
const markAt = (f) => {
  let last = null;
  for (const m of marks) { if (m.frame <= f) last = m; else break; }
  return last ? `${last.label} @f${last.frame}` : '(boot)';
};

console.log(`FF2 ${ROM} — ${frame} frames, watching ${[...WATCH].map(a => hx(a)).join(' ')}`);
console.log(`\n  frame  addr  val  PC       meaning                        during`);
const counts = new Map();
for (const e of events) {
  let meaning;
  if (e.addr === 0xE0) {
    if (e.val & 0x80)      meaning = 'RESTORE stashed music';
    else if (e.val & 0x40) { const id = e.val & 0x3F; meaning = `PLAY table entry ${id} (${hx(id)})`; counts.set(id, (counts.get(id) || 0) + 1); }
    else if (e.val === 0)  meaning = '(cleared by driver)';
    else                   meaning = `raw ${hx(e.val)} — neither bit 6 nor 7`;
  } else if (e.addr === 0xE5) {
    meaning = `pulse-2 cutoff countdown = ${e.val}`;
  } else {
    meaning = `APU ${hx(e.addr, 4)} <- ${hx(e.val)}`;
  }
  console.log(`  ${String(e.frame).padStart(6)}  ${hx(e.addr, 4)} ${hx(e.val)}  PC=${hx(e.pc, 4)}  ${meaning.padEnd(30)} ${markAt(e.frame)}`);
  if (SHOT_DIR && e.addr === 0xE0 && (e.val & 0x40) && !(e.val & 0x80)) {
    // Screenshot at the request frame is one frame late by construction (we
    // only have the last rendered frame), which is close enough to attribute
    // the sound to what is on screen.
    shot(`e0-${hx(e.val).slice(1)}-f${String(e.frame).padStart(5, '0')}.png`);
  }
}
if (!events.length) console.log('  (no writes seen — wrong addresses, or nothing asked for a sound)');

if (counts.size) {
  console.log('\nTable entries requested, by count:');
  for (const [id, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`  entry ${String(id).padStart(2)} (${hx(id)})  x${n}   -> write ${hx(0x40 | id)} to $E0`);
  }
}
if (SHOT_DIR) console.log(`\nshots -> ${SHOT_DIR}/`);
