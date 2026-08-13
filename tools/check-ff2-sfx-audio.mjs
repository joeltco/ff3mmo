#!/usr/bin/env node
// check-ff2-sfx-audio.mjs — does the ripped FF2 blip actually make a SOUND?
//
// check-ff2-sfx.mjs proves our hand-assembled 6502 writes the right APU
// registers when a 6502 executes it. It says nothing about whether libgme —
// the thing that actually plays the NSF in the browser — starts the track and
// emits samples. Those are different questions, and the second one is the one
// the player hears. It shipped silent.
//
// So: load the REAL lib/libgme.js in Node, open the REAL NSF built by
// ff2-nsf-builder.js, start each sound-effect track, render PCM and measure it.
// A track that produces silence fails.
//
//   node tools/check-ff2-sfx-audio.mjs

import fs from 'node:fs';
import vm from 'node:vm';

const ROM_PATH = process.env.FF2_ROM || '/home/joeltco/roms/ff2-jp.nes';
let rom;
try { rom = new Uint8Array(fs.readFileSync(ROM_PATH)); }
catch { console.error(`check-ff2-sfx-audio: SKIP — no FF2 ROM at ${ROM_PATH}`); process.exit(0); }

const { buildFF2NSF, FF2_SFX, ff2SfxTrack } = await import('../src/ff2-nsf-builder.js');
const nsf = buildFF2NSF(rom);

// libgme is an old Emscripten build: sloppy-mode source with octal literals, so
// require()/import both reject it as strict-mode ESM. Run it through vm in a
// sloppy context, the way a <script> tag does in the browser.
const src = fs.readFileSync(new URL('../lib/libgme.js', import.meta.url).pathname, 'utf8');
const sandbox = { console, process, setTimeout, clearTimeout, Date, Math, JSON, TextDecoder, TextEncoder };
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
try { vm.runInContext(src, sandbox, { filename: 'libgme.js' }); }
catch (e) { console.error('check-ff2-sfx-audio: SKIP — libgme failed to load: ' + e.message); process.exit(0); }
const Module = sandbox.Module;
if (!Module) { console.error('check-ff2-sfx-audio: SKIP — libgme exposed no Module'); process.exit(0); }

async function ready() {
  if (Module.calledRun) return;
  await new Promise((res) => {
    const prev = Module.onRuntimeInitialized;
    Module.onRuntimeInitialized = () => { if (prev) prev(); res(); };
    setTimeout(res, 8000);
  });
}
await ready();
if (!Module.ccall) { console.error('check-ff2-sfx-audio: SKIP — libgme did not initialise'); process.exit(0); }

const RATE = 48000;
const fail = [];
const err = (m) => fail.push(m);

/** Render `frames` stereo sample-pairs of `track` and report peak + RMS. */
function measure(track, frames) {
  const ref = Module.allocate(1, 'i32', Module.ALLOC_STATIC);
  if (Module.ccall('gme_open_data', 'number', ['array', 'number', 'number', 'number'],
      [nsf, nsf.length, ref, RATE]) !== 0) return { err: 'gme_open_data failed' };
  const emu = Module.getValue(ref, 'i32');
  if (Module.ccall('gme_start_track', 'number', ['number', 'number'], [emu, track]) !== 0) {
    Module.ccall('gme_delete', 'number', ['number'], [emu]);
    return { err: 'gme_start_track failed' };
  }
  const N = 2048;
  const buf = Module._malloc(N * 2 * 2);
  let peak = 0, sumSq = 0, count = 0;
  for (let done = 0; done < frames; done += N) {
    Module.ccall('gme_play', 'number', ['number', 'number', 'number'], [emu, N * 2, buf]);
    const base = buf >> 1;
    for (let i = 0; i < N * 2; i++) {
      const v = Module.HEAP16[base + i];
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sumSq += v * v; count++;
    }
  }
  Module._free(buf);
  Module.ccall('gme_delete', 'number', ['number'], [emu]);
  return { peak, rms: Math.sqrt(sumSq / Math.max(1, count)) };
}

// A known-good reference: FF2 song 24 is the elder-house theme that already
// plays in game. If THAT measures silent, the harness is wrong, not the blips —
// without this the whole run could report a false failure.
const music = measure(24, RATE / 2);
if (music.err) { console.error(`check-ff2-sfx-audio: SKIP — reference track: ${music.err}`); process.exit(0); }
if (music.peak < 500) {
  console.error(`check-ff2-sfx-audio: SKIP — reference music track measured silent (peak ${music.peak}); harness cannot judge`);
  process.exit(0);
}
console.log(`  reference: FF2 track 24 (elder house)  peak ${music.peak}  rms ${music.rms.toFixed(1)}`);

for (const s of FF2_SFX) {
  const track = ff2SfxTrack(s.name);
  // The blip lasts dur frames at 60Hz; render a bit past it.
  const r = measure(track, Math.ceil(RATE * (s.dur + 8) / 60));
  if (r.err) { err(`${s.name} (track ${track}): ${r.err}`); continue; }
  console.log(`  ${s.name.padEnd(13)} track ${String(track).padStart(2)}  peak ${String(r.peak).padStart(5)}  rms ${r.rms.toFixed(1)}`);
  if (r.peak < 500) {
    err(`${s.name} (track ${track}) is SILENT — peak ${r.peak}. libgme starts the track but the ` +
        `stub emits nothing the player can hear.`);
  }
}

if (fail.length) {
  for (const m of fail) console.error(`  ✗ ${m}`);
  console.error(`\ncheck-ff2-sfx-audio: FAIL — ${fail.length} problem(s)`);
  process.exit(1);
}
console.log('check-ff2-sfx-audio: OK — every ripped blip renders audible PCM through libgme');
