#!/usr/bin/env node
// nes-run.mjs — run the REAL FF3 ROM headlessly and screenshot it.
//
// This is the ground truth. Every map tool in here draws OUR interpretation of
// the ROM; this one runs the actual game and captures the actual PPU output, so
// "what should this room look like" stops being an opinion.
//
// Warping uses the ROM's own mechanism, decoded earlier from the event
// interpreter (tools/event-resolve.mjs): opcode $FA "GO TO MAP" writes the map
// id to $0700 and sets $AB = $80; the engine picks that up and loads the map.
// So poking those two RAM addresses is exactly what the game does to itself.
//
//   node tools/nes-run.mjs --frames 600 --out boot.png
//   node tools/nes-run.mjs --warp 114 --out ur.png
//   node tools/nes-run.mjs --warp 17 --at 3,8 --out inn.png
//   node tools/nes-run.mjs --script "start:60,a:10,down:40" --out x.png
//
// Buttons: a b select start up down left right

import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import { NES, Controller } from 'jsnes';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const has = (n) => args.includes('--' + n);

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const OUT = flag('out', 'nes-shot.png');
const ZOOM = Math.max(1, parseInt(flag('zoom', '3'), 10));

const W = 256, H = 240;
const frameBuf = new Uint8Array(W * H * 3);
let frameReady = false;

const nes = new NES({
  onFrame: (buf) => {
    // jsnes gives 0xBBGGRR ints per pixel.
    for (let i = 0; i < W * H; i++) {
      const p = buf[i];
      frameBuf[i * 3]     = p & 0xFF;
      frameBuf[i * 3 + 1] = (p >> 8) & 0xFF;
      frameBuf[i * 3 + 2] = (p >> 16) & 0xFF;
    }
    frameReady = true;
  },
  onAudioSample: () => {},
});

nes.loadROM(fs.readFileSync(ROM, 'binary'));

const BUTTON = {
  a: Controller.BUTTON_A, b: Controller.BUTTON_B,
  select: Controller.BUTTON_SELECT, start: Controller.BUTTON_START,
  up: Controller.BUTTON_UP, down: Controller.BUTTON_DOWN,
  left: Controller.BUTTON_LEFT, right: Controller.BUTTON_RIGHT,
};

function run(n) { for (let i = 0; i < n; i++) nes.frame(); }
function press(btn, holdFrames = 4, thenIdle = 8) {
  const b = BUTTON[btn];
  if (b === undefined) throw new Error('unknown button: ' + btn);
  nes.buttonDown(1, b);
  run(holdFrames);
  nes.buttonUp(1, b);
  run(thenIdle);
}

/** Read/write CPU RAM through jsnes' mapper. */
const peek = (addr) => nes.cpu.mem[addr] & 0xFF;
const poke = (addr, val) => { nes.cpu.mem[addr] = val & 0xFF; };

// ── boot ───────────────────────────────────────────────────────────────────
// `--loadstate` restores a jsnes savestate instead of replaying the intro.
// Reaching free roam from a cold boot costs ~17s (title, name entry, the four
// intro dialogue pages, and the FORCED opening Goblin battle); from a state
// it is under a second. Capture the free-roam state once with `--savestate`,
// then every map capture loads it.
const loadState = flag('loadstate', null);
if (loadState) {
  nes.fromJSON(JSON.parse(fs.readFileSync(loadState, 'utf8')));
  run(8);
} else {
  const bootFrames = parseInt(flag('boot', '420'), 10);
  run(bootFrames);
  // Title -> press start a few times to get into the game.
  if (!has('noboot')) {
    for (let i = 0; i < 6; i++) press('start', 5, 30);
    run(120);
  }
}

// Optional scripted input: "start:60,a:10,down:40"
const script = flag('script', null);
if (script) {
  for (const step of script.split(',')) {
    const [btn, n] = step.split(':');
    const count = parseInt(n || '1', 10);
    if (btn === 'wait') { run(count); continue; }
    for (let i = 0; i < count; i++) press(btn, 4, 6);
  }
}

// `--newgame` drives the New Game flow without hand-tuned timing: press A,
// then keep pressing A until the name-entry screens are done. FF3's name entry
// has no confirm button — a name completes when it fills, and the screen
// advances — so the reliable move is to keep pressing and watch for the frame
// to stop looking like a menu.
if (has('newgame')) {
  const hash = () => { let h = 2166136261; for (let i = 0; i < frameBuf.length; i += 97) { h ^= frameBuf[i]; h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); };
  // Fraction of the frame that is the menu's blue. A map screen is not blue.
  const blueness = () => {
    let n = 0;
    for (let i = 0; i < W * H; i++) {
      const r = frameBuf[i * 3], g = frameBuf[i * 3 + 1], b = frameBuf[i * 3 + 2];
      if (b > 120 && b > r + 60 && b > g + 60) n++;
    }
    return n / (W * H);
  };
  press('a', 5, 120);                     // New Game
  let last = '';
  for (let i = 0; i < 200; i++) {
    press('a', 4, 14);
    if (i % 5 === 0) {
      run(20);
      const bl = blueness();
      if (bl < 0.12) { console.log(`name entry done after ~${i} presses (blueness ${bl.toFixed(3)})`); break; }
      const h = hash();
      if (h === last && i > 40) { console.log(`frame stuck at press ${i}, blueness ${bl.toFixed(3)}`); }
      last = h;
    }
  }
  run(parseInt(flag('introwait', '900'), 10));
}

// ── warp, using the ROM's own go-to-map path ──────────────────────────────
const warp = flag('warp', null);
if (warp != null) {
  const id = parseInt(warp, 10);
  const at = flag('at', null);
  // A single poke does not survive: the engine rewrites $AB every frame it is
  // in a dialogue/battle/menu state, so a one-shot write is usually eaten
  // before the map-load poll ever sees it. Hold both values across a window of
  // frames instead, and stop as soon as the engine consumes them (it clears
  // $AB itself once the load is accepted).
  const holdFrames = parseInt(flag('warphold', '240'), 10);
  let took = false;
  for (let f = 0; f < holdFrames; f++) {
    poke(0x0700, id);        // $FA operand: destination map
    poke(0x00AB, 0x80);      // action flag the engine polls
    nes.frame();
    if (peek(0x00AB) !== 0x80) { took = true; break; }
  }
  console.log(`warp ${id}: ${took ? 'engine consumed the flag' : 'flag never consumed'}`);
  run(parseInt(flag('settle', '240'), 10));

  // Input to run AFTER the warp — e.g. clearing a dialogue box that was open
  // when the warp fired, or walking to a specific tile.
  const after = flag('after', null);
  if (after) {
    for (const step of after.split(',')) {
      const [btn, n] = step.split(':');
      const count = parseInt(n || '1', 10);
      if (btn === 'wait') { run(count); continue; }
      for (let i = 0; i < count; i++) press(btn, 4, 6);
    }
  }
  if (at) {
    // Player tile position, if the caller wants a specific spot.
    const [tx, ty] = at.split(',').map(Number);
    poke(0x0710, tx); poke(0x0711, ty);
    run(60);
  }
}

// `--pc` samples the program counter while the game runs, so I can see WHICH
// routine is live on a given screen. That is how you locate code to patch
// without a symbol map: sample, histogram, then disassemble the hot address
// with tools/dis6502.mjs.
if (has('pc')) {
  const hist = new Map();
  const n = parseInt(flag('pcframes', '120'), 10);
  for (let f = 0; f < n; f++) {
    for (let k = 0; k < 200; k++) {
      nes.cpu.emulate();
      const pc = nes.cpu.REG_PC & 0xFFFF;
      hist.set(pc, (hist.get(pc) || 0) + 1);
    }
    nes.frame();
  }
  const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
  console.log('hottest PCs (addr x count)  — bank regs:',
    'R6=$' + (nes.mmap.prgSelect0 ?? '?'), 'R7=$' + (nes.mmap.prgSelect1 ?? '?'));
  for (const [pc, c] of top) console.log(`  $${pc.toString(16).toUpperCase().padStart(4, '0')}  x${c}`);
  process.exit(0);
}

// `--pcdiff` samples the PC on the CURRENT screen, then again after running
// `--then` input, and reports addresses that appear only in the second sample.
// The per-frame sprite clear and NMI handler dominate any raw histogram; the
// difference is what is unique to the new screen.
if (has('pcdiff')) {
  const sample = (frames) => {
    const h = new Set();
    for (let f = 0; f < frames; f++) {
      for (let k = 0; k < 400; k++) { nes.cpu.emulate(); h.add(nes.cpu.REG_PC & 0xFFFF); }
      nes.frame();
    }
    return h;
  };
  const before = sample(parseInt(flag('pcframes', '60'), 10));
  const then = flag('then', 'a:1');
  for (const step of then.split(',')) {
    const [btn, n] = step.split(':');
    const count = parseInt(n || '1', 10);
    if (btn === 'wait') { run(count); continue; }
    for (let i = 0; i < count; i++) press(btn, 4, 10);
  }
  run(60);
  const after = sample(parseInt(flag('pcframes', '60'), 10));
  const only = [...after].filter(pc => !before.has(pc)).sort((a, b) => a - b);
  console.log(`PCs unique to the new screen: ${only.length}`);
  // Group into runs so the output is readable.
  let start = null, prev = null;
  const runs = [];
  for (const pc of only) {
    if (start === null) { start = prev = pc; continue; }
    if (pc - prev <= 3) { prev = pc; continue; }
    runs.push([start, prev]); start = prev = pc;
  }
  if (start !== null) runs.push([start, prev]);
  for (const [a, b] of runs.slice(0, 30)) {
    console.log(`  $${a.toString(16).toUpperCase().padStart(4,'0')} - $${b.toString(16).toUpperCase().padStart(4,'0')}  (${b - a + 1} bytes)`);
  }
  process.exit(0);
}

// `--probe` presses each button in turn from the current state and reports
// which ones actually change the screen. Faster and more reliable than
// guessing which key confirms a menu.
if (has('probe')) {
  const hash = () => { let h = 2166136261; for (let i = 0; i < frameBuf.length; i += 97) { h ^= frameBuf[i]; h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); };
  run(10);
  const base = hash();
  console.log('baseline frame hash', base);
  const snapshot = JSON.stringify(nes.toJSON());
  for (const b of ['a', 'b', 'select', 'start', 'up', 'down', 'left', 'right']) {
    nes.fromJSON(JSON.parse(snapshot));
    run(2);
    press(b, 4, 60);
    run(30);
    console.log(`  ${b.padEnd(6)} -> ${hash()}${hash() !== base ? '   CHANGED' : ''}`);
  }
  process.exit(0);
}

run(parseInt(flag('frames', '30'), 10));

// `--pal` prints the live BG palette ($3F00-$3F0F) as raw NES colour indices.
// This is the ground truth for "what colour is this room actually", so a
// palette bug in our loader becomes a diff of sixteen numbers instead of an
// argument about whether a hedge looks green.
if (has('pal')) {
  const bg = [];
  for (let i = 0; i < 16; i++) bg.push(nes.ppu.vramMem[0x3F00 + i] & 0x3F);
  const hx = (v) => '$' + v.toString(16).toUpperCase().padStart(2, '0');
  console.log('BG palettes (PPU $3F00):');
  for (let p = 0; p < 4; p++) {
    console.log(`  pal${p}: ${bg.slice(p * 4, p * 4 + 4).map(hx).join(' ')}`);
  }
  console.log('PAL_JSON ' + JSON.stringify(bg));
}

// `--findpos` locates the player's tile-coordinate RAM addresses by MEASURING
// them: snapshot RAM, walk a known number of steps in one axis, and report the
// bytes that moved by exactly that amount. Guessing FF3's RAM map is how you
// ship a renderer aligned to the wrong tile.
if (has('findpos')) {
  const snap = () => Uint8Array.from(nes.cpu.mem.slice(0, 0x800));
  const walk = (btn, n) => { for (let i = 0; i < n; i++) press(btn, 12, 24); run(30); };
  // Walk each axis BOTH ways: a wall on one side would otherwise silently
  // produce "no candidates" and read as "the address does not exist".
  const fmt = (l) => l.map(i => '$' + i.toString(16).padStart(4, '0')).join(' ') || '(none)';
  const axis = (label, dir, n) => {
    const before = snap();
    walk(dir, n);
    const after = snap();
    const up = [], dn = [];
    for (let i = 0; i < 0x800; i++) {
      if (after[i] === ((before[i] + n) & 0xFF)) up.push(i);
      if (after[i] === ((before[i] - n) & 0xFF)) dn.push(i);
    }
    console.log(`${label} ${dir} x${n}:  +${n} -> ${fmt(up)}`);
    console.log(`${label} ${dir} x${n}:  -${n} -> ${fmt(dn)}`);
    return { up, dn };
  };
  axis('X', 'left', 2);
  axis('X', 'right', 2);
  axis('Y', 'down', 3);
  axis('Y', 'up', 3);
  process.exit(0);
}

const saveState = flag('savestate', null);
if (saveState) {
  fs.writeFileSync(saveState, JSON.stringify(nes.toJSON()));
  console.log(`saved state -> ${saveState}`);
}

if (!frameReady) { console.error('no frame produced'); process.exit(1); }

const c = createCanvas(W * ZOOM, H * ZOOM);
const cx = c.getContext('2d');
const src = createCanvas(W, H);
const sctx = src.getContext('2d');
const img = sctx.createImageData(W, H);
for (let i = 0; i < W * H; i++) {
  img.data[i * 4]     = frameBuf[i * 3];
  img.data[i * 4 + 1] = frameBuf[i * 3 + 1];
  img.data[i * 4 + 2] = frameBuf[i * 3 + 2];
  img.data[i * 4 + 3] = 255;
}
sctx.putImageData(img, 0, 0);
cx.imageSmoothingEnabled = false;
cx.drawImage(src, 0, 0, W, H, 0, 0, W * ZOOM, H * ZOOM);
fs.writeFileSync(OUT, c.toBuffer('image/png'));
console.log(`wrote ${OUT} (${W}x${H} @${ZOOM}x)` + (warp != null ? `  warp=${warp}` : ''));
