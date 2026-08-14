#!/usr/bin/env node
// ff2-learn-capture.mjs — what sound does FF2 play when you LEARN a keyword?
//
// Only possible since the name-entry patch (tools/ff2-build-playable-rom.mjs)
// made FF2 reachable headlessly. Boots the patched ROM to a town, walks up to
// an NPC, and drives the たずねる / おぼえる / アイテム verb menu while logging
// every sound request with the frame it happened on, so a cue can be attributed
// to the ACTION that caused it instead of to whatever was on screen.
//
// FF2's audio API is the single byte $E0 (bit 6 = play song, bit 7 = restore),
// and its three short blips are fixed-bank routines that poke pulse 2 directly
// ($DB45 cursor, $DB2E confirm, $C921 unused). Both are watched — a menu cue
// could be either, and assuming one would beg the question.
//
//   node tools/ff2-learn-capture.mjs --rom ff2-playable.nes --shots out/
//
// Prints a per-step timeline: what was pressed, what sounded, and a screenshot
// of each sound moment.

import fs from 'node:fs';
import path from 'node:path';
import { NES, Controller } from 'jsnes';
import { createCanvas } from '@napi-rs/canvas';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const ROM = flag('rom', null);
const SHOTS = flag('shots', null);
if (!ROM) { console.error('usage: ff2-learn-capture.mjs --rom <patched.nes> [--shots dir]'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const fb = new Uint32Array(256 * 240);
const nes = new NES({ onFrame: (b) => fb.set(b), onAudioSample: () => {} });
nes.loadROM(fs.readFileSync(ROM, 'binary'));

let frame = 0;
const events = [];
const cpu = nes.cpu;
const ow = cpu.write.bind(cpu);
cpu.write = function (addr, val) {
  const a = addr & 0xFFFF, v = val & 0xFF;
  // Hook the CPU write path, NOT the mapper: stores below $2000 go straight to
  // cpu.mem and never reach mmap, so a mapper hook sees no zero-page writes.
  if (a === 0x00E0 && (v & 0x40) && !(v & 0x80)) events.push({ f: frame, kind: 'song', song: v & 0x3F, raw: v });
  else if (a === 0x00E0 && (v & 0x80)) events.push({ f: frame, kind: 'restore', raw: v });
  return ow(addr, val);
};
const oe = cpu.emulate.bind(cpu);
cpu.emulate = function () {
  const pc = cpu.REG_PC;
  if (pc === 0xDB45) events.push({ f: frame, kind: 'blip', name: 'cursor' });
  else if (pc === 0xDB2E) events.push({ f: frame, kind: 'blip', name: 'confirm' });
  else if (pc === 0xC921) events.push({ f: frame, kind: 'blip', name: 'unused-c921' });
  return oe();
};
const of = nes.frame.bind(nes);
nes.frame = function () { frame++; return of(); };

const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
const press = (b, hold = 6, after = 24) => { nes.buttonDown(1, b); run(hold); nes.buttonUp(1, b); run(after); };
const B = Controller;

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

/** Is the verb menu (たずねる/おぼえる/アイテム) on screen? It is a small box bottom-left. */
function verbMenuOpen() {
  let blue = 0, total = 0;
  for (let y = 150; y < 215; y++) {
    for (let x = 18; x < 78; x++) {
      const p = fb[y * 256 + x];
      const r = p & 0xFF, g = (p >> 8) & 0xFF, b = (p >> 16) & 0xFF;
      if (b > 100 && b > r + 40 && b > g + 40) blue++;
      total++;
    }
  }
  return blue / total > 0.5;
}

const mark = () => events.length;
const since = (m) => events.slice(m).map(e =>
  (e.kind === 'song' ? `song ${e.song}` : e.kind === 'blip' ? `blip:${e.name}` : 'restore') + `@f${e.f}`);

// ── boot the patched ROM into the town ───────────────────────────────────
run(400);
press(B.BUTTON_START, 6, 240);
press(B.BUTTON_A, 6, 120);
for (let i = 0; i < 400; i++) press(B.BUTTON_A, 5, 10);
run(200);
console.log('booted; verb menu on screen: ' + verbMenuOpen());
shot('00-town.png');

// ── step through the verb menu, logging each action separately ───────────
const steps = [];
function step(label, fn) {
  const m = mark();
  fn();
  const snd = since(m);
  steps.push({ label, sounds: snd });
  console.log(`  ${label.padEnd(34)} ${snd.length ? snd.join('  ') : '(silent)'}`);
  shot(steps.length.toString().padStart(2, '0') + '-' + label.replace(/[^a-z0-9]+/gi, '-') + '.png');
}

console.log('\nverb-menu timeline:');
if (!verbMenuOpen()) step('press A to open the verb menu', () => { press(B.BUTTON_A, 6, 60); run(60); });
step('cursor DOWN to おぼえる (LEARN)', () => { press(B.BUTTON_DOWN, 8, 40); run(40); });
step('press A on おぼえる (LEARN)', () => { press(B.BUTTON_A, 8, 60); run(180); });
step('press A again (pick a word / advance)', () => { press(B.BUTTON_A, 8, 60); run(180); });
step('press A again (confirm)', () => { press(B.BUTTON_A, 8, 60); run(240); });

console.log('\nall sound events, in order:');
for (const e of events) {
  console.log(`  f${String(e.f).padStart(6)}  ` +
    (e.kind === 'song' ? `song ${e.song} ($${e.raw.toString(16)})` : e.kind === 'blip' ? `blip ${e.name}` : 'restore music'));
}
