#!/usr/bin/env node
// check-sfx-audio.mjs — does every FF3 sound the game can ask for actually
// PLAY, through the same libgme the browser uses?
//
// Every other check in this repo answers "is the NUMBER right" — the sweeps
// trace what the ROM writes to $7F49 and derive the NSF track. None of them
// answers "and does that track make a sound". Those are different questions,
// and the second is the one the player hears: check-ff2-sfx-audio.mjs exists
// because the FF2 blips passed the register check and shipped SILENT.
//
// So this loads the REAL lib/libgme.js, opens the REAL NSF built by
// nsf-builder.js from the player's ROM, starts every SFX constant and every
// music track, renders PCM and measures it. Silent, or absurdly quiet next to
// the others, is a failure.
//
//   node tools/check-sfx-audio.mjs           # gate mode: silence fails
//   node tools/check-sfx-audio.mjs --table   # print the full measured table
//
// Skips cleanly (exit 0) when the ROM or libgme is unavailable, so it can sit
// in deploy.sh on a machine without the ROM.

import fs from 'node:fs';
import vm from 'node:vm';

const args = process.argv.slice(2);
const TABLE = args.includes('--table');

const ROM_PATH = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
let rom;
try { rom = new Uint8Array(fs.readFileSync(ROM_PATH)); }
catch { console.error(`check-sfx-audio: SKIP — no FF3 ROM at ${ROM_PATH}`); process.exit(0); }

await import('./lib/browser-shim.mjs');
const { buildNSF } = await import('../src/nsf-builder.js');
const { SFX, TRACKS } = await import('../src/music.js');
const nsf = buildNSF(rom);

// libgme is an old Emscripten build: sloppy-mode source with octal literals, so
// require()/import both reject it. Run it in a vm sandbox the way a <script>
// tag does. (Same loader as check-ff2-sfx-audio.mjs.)
const src = fs.readFileSync(new URL('../lib/libgme.js', import.meta.url).pathname, 'utf8');
const sandbox = { console, process, setTimeout, clearTimeout, Date, Math, JSON, TextDecoder, TextEncoder };
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
try { vm.runInContext(src, sandbox, { filename: 'libgme.js' }); }
catch (e) { console.error('check-sfx-audio: SKIP — libgme failed to load: ' + e.message); process.exit(0); }
const Module = sandbox.Module;
if (!Module) { console.error('check-sfx-audio: SKIP — libgme exposed no Module'); process.exit(0); }
await (async () => {
  if (Module.calledRun) return;
  await new Promise((res) => {
    const prev = Module.onRuntimeInitialized;
    Module.onRuntimeInitialized = () => { if (prev) prev(); res(); };
    setTimeout(res, 8000);
  });
})();
if (!Module.ccall) { console.error('check-sfx-audio: SKIP — libgme did not initialise'); process.exit(0); }

const RATE = 48000;

/**
 * Render `seconds` of `track` and report peak / rms / how long it stays audible.
 * `audibleMs` matters for a SFX: a track that opens with a click and then goes
 * quiet is not the same as one that plays a sound, and peak alone cannot tell
 * them apart.
 */
function measure(track, seconds) {
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
  const total = Math.ceil(RATE * seconds);
  let peak = 0, sumSq = 0, count = 0, audible = 0;
  for (let done = 0; done < total; done += N) {
    Module.ccall('gme_play', 'number', ['number', 'number', 'number'], [emu, N * 2, buf]);
    const base = buf >> 1;
    let chunkPeak = 0;
    for (let i = 0; i < N * 2; i++) {
      const v = Module.HEAP16[base + i];
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      if (a > chunkPeak) chunkPeak = a;
      sumSq += v * v; count++;
    }
    if (chunkPeak > 300) audible += (N / RATE) * 1000;
  }
  Module._free(buf);
  Module.ccall('gme_delete', 'number', ['number'], [emu]);
  return { peak, rms: Math.sqrt(sumSq / Math.max(1, count)), audibleMs: Math.round(audible) };
}

// ── reference ────────────────────────────────────────────────────────────
// A track known to work in the shipped game. If THIS measures silent the
// harness is broken and every failure below would be a lie.
const ref = measure(TRACKS.TOWN_UR, 2);
if (ref.err) { console.error(`check-sfx-audio: SKIP — reference track: ${ref.err}`); process.exit(0); }
if (ref.peak < 500) {
  console.error(`check-sfx-audio: SKIP — reference TOWN_UR measured silent (peak ${ref.peak}); harness cannot judge`);
  process.exit(0);
}
console.log(`reference  TOWN_UR (${TRACKS.TOWN_UR})  peak ${ref.peak}  rms ${ref.rms.toFixed(1)}`);

const fails = [];
const rows = [];

console.log('\nconstant           track  peak   rms     audible');
console.log('-----------------  -----  -----  ------  -------');
for (const [name, track] of Object.entries(SFX)) {
  const r = measure(track, 3);
  if (r.err) { fails.push(`SFX.${name} (track ${track}): ${r.err}`); continue; }
  rows.push({ kind: 'sfx', name, track, ...r });
  console.log(('SFX.' + name).padEnd(19) + String(track).padStart(5) + '  ' +
    String(r.peak).padStart(5) + '  ' + r.rms.toFixed(1).padStart(6) + '  ' +
    String(r.audibleMs).padStart(5) + 'ms');
  if (r.peak < 500) fails.push(`SFX.${name} (track ${track}) is SILENT — peak ${r.peak}`);
  else if (r.audibleMs < 40) fails.push(`SFX.${name} (track ${track}) is a CLICK — only ${r.audibleMs}ms audible`);
}

console.log('\ntrack              index  peak   rms     audible');
console.log('-----------------  -----  -----  ------  -------');
for (const [name, track] of Object.entries(TRACKS)) {
  const r = measure(track, 2);
  if (r.err) { fails.push(`TRACKS.${name} (${track}): ${r.err}`); continue; }
  rows.push({ kind: 'music', name, track, ...r });
  console.log(('TRACKS.' + name).padEnd(19) + String(track).padStart(5) + '  ' +
    String(r.peak).padStart(5) + '  ' + r.rms.toFixed(1).padStart(6) + '  ' +
    String(r.audibleMs).padStart(5) + 'ms');
  if (r.peak < 500) fails.push(`TRACKS.${name} (${track}) is SILENT — peak ${r.peak}`);
}

if (TABLE) {
  // Every distinct track number the spell rules can resolve to, so a sound that
  // only a spell reaches is measured too — the SFX constants do not cover them.
  const { CAPTURED_SPELL_SFX } = await import('../src/data/spell-sfx-captured.js');
  const known = new Set(rows.map(r => r.track));
  const extra = [...new Set(CAPTURED_SPELL_SFX.values())].filter(t => !known.has(t)).sort((a, b) => a - b);
  console.log('\nspell-only tracks  (reached by CAPTURED_SPELL_SFX, no named constant)');
  console.log('track  peak   rms     audible');
  console.log('-----  -----  ------  -------');
  for (const t of extra) {
    const r = measure(t, 3);
    if (r.err) { console.log(String(t).padStart(5) + '  ' + r.err); continue; }
    console.log(String(t).padStart(5) + '  ' + String(r.peak).padStart(5) + '  ' +
      r.rms.toFixed(1).padStart(6) + '  ' + String(r.audibleMs).padStart(5) + 'ms' +
      (r.peak < 500 ? '   <-- SILENT' : ''));
    if (r.peak < 500) fails.push(`spell track ${t} is SILENT — peak ${r.peak}`);
  }
}

if (fails.length) {
  console.error('');
  for (const m of fails) console.error('  ✗ ' + m);
  console.error(`\ncheck-sfx-audio: FAIL — ${fails.length} problem(s)`);
  process.exit(1);
}
console.log('\ncheck-sfx-audio: OK — every sound renders audible PCM through libgme');
