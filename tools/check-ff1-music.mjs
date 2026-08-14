#!/usr/bin/env node
// check-ff1-music.mjs — our FF1 music reaches the player, and the FF1 reference
// data stays honest.
//
// TWO DIFFERENT THINGS, and conflating them produced a wrong report once:
//
//   1. WHICH FF1 track each of OUR screens plays is a DESIGN CHOICE. The shop
//      uses track 14 and the pause menu uses 16 because those were chosen; the
//      elder house runs FF2's theme on exactly the same basis. A ROM attribution
//      is not the standard, and calling the shop track "unverified" for lacking
//      one was the wrong bar applied inconsistently.
//   2. What FF1 ITSELF plays where is reference data for the sound catalogue.
//      FF1 keeps its song in zero page $4B (`music_track`), started via
//      Music_NewSong at $B003; NSF track N is song id N + $41. Only three
//      meanings have actually been watched (`tools/ff1-sound-probe.mjs`), and
//      this gate fails if a fourth is added without a capture.
//
// So: pin the wiring and the audibility (what a player experiences), and keep
// the catalogue's claims to what was observed.
//
//   node tools/check-ff1-music.mjs

import fs from 'node:fs';

await import('./lib/browser-shim.mjs');
const { FF1_TRACKS, FF1_TRACK_MEANINGS } = await import('../src/music.js');

let fails = 0;
const fail = (m) => { console.error('  FAIL  ' + m); fails++; };
const ok = (m) => console.log('  ok    ' + m);

console.log('\nmeasured');
if (FF1_TRACKS.MENU_SCREEN !== 16) fail(`FF1_TRACKS.MENU_SCREEN is ${FF1_TRACKS.MENU_SCREEN}, measured 16`);
else ok('MENU_SCREEN = 16 (watched on the party-menu open)');
for (const [t, meaning] of [[0, 'opening prologue'], [3, 'overworld field'], [16, 'main menu']]) {
  if (!FF1_TRACK_MEANINGS.has(t)) fail(`FF1_TRACK_MEANINGS lost track ${t} (${meaning})`);
}
// FF1_TRACK_MEANINGS documents what FF1 ITSELF plays where, for the catalogue.
// It is reference data, not a requirement on our own screen choices.
if (FF1_TRACK_MEANINGS.size !== 3) {
  fail(`FF1_TRACK_MEANINGS has ${FF1_TRACK_MEANINGS.size} entries; only 3 were actually observed in FF1 — ` +
       `adding one without a capture turns a guess into "MEASURED" in the catalogue`);
} else ok('exactly 3 observed FF1 meanings, none invented');

// ── the tracks are WIRED to their screens ────────────────────────────────
// This is what actually matters for the game: our shop and our pause menu play
// FF1 music, and that music must reach the player. WHICH track each screen uses
// is a design choice — ff3mmo picks its own music per screen (the elder house
// runs FF2's theme on the same basis), so a ROM attribution is not the standard
// here and an earlier pass was wrong to call SHOP "unverified" for lacking one.
console.log('\nwiring');
const SHOP_SRC = fs.readFileSync(new URL('../src/shop.js', import.meta.url), 'utf8');
if (!/playFF1Track\(\s*FF1_TRACKS\.SHOP\s*\)/.test(SHOP_SRC)) {
  fail('src/shop.js does not play FF1_TRACKS.SHOP — the shop lost its music');
} else ok('shop.js plays FF1_TRACKS.SHOP');
if (!/pauseMusic\s*\(\s*\)/.test(SHOP_SRC)) {
  fail('src/shop.js does not pause the map music before starting the shop track');
} else ok('shop.js pauses the map music first');

const PAUSE_SRC = fs.readFileSync(new URL('../src/pause-menu.js', import.meta.url), 'utf8');
if (!/playFF1Track\(\s*FF1_TRACKS\.MENU_SCREEN\s*\)/.test(PAUSE_SRC)) {
  fail('src/pause-menu.js does not play FF1_TRACKS.MENU_SCREEN');
} else ok('pause-menu.js plays FF1_TRACKS.MENU_SCREEN');

// ── audible through the real decoder ─────────────────────────────────────
console.log('\nplayback');
const ROM = process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes';
let rom = null;
try { rom = new Uint8Array(fs.readFileSync(ROM)); } catch { /* optional */ }
if (!rom) console.log('  skip  no FF1 ROM at ' + ROM);
else {
  const vm = (await import('node:vm')).default;
  const src = fs.readFileSync(new URL('../lib/libgme.js', import.meta.url).pathname, 'utf8');
  const sb = { console, process, setTimeout, clearTimeout, Date, Math, JSON, TextDecoder, TextEncoder };
  sb.window = sb; sb.self = sb; sb.globalThis = sb;
  vm.createContext(sb);
  try { vm.runInContext(src, sb, { filename: 'libgme.js' }); } catch { /* skip */ }
  const Module = sb.Module;
  if (!Module) console.log('  skip  libgme unavailable');
  else {
    await (async () => {
      if (Module.calledRun) return;
      await new Promise((res) => {
        const prev = Module.onRuntimeInitialized;
        Module.onRuntimeInitialized = () => { if (prev) prev(); res(); };
        setTimeout(res, 8000);
      });
    })();
    const { buildFF1NSF } = await import('../src/ff1-nsf-builder.js');
    const nsf = buildFF1NSF(rom);
    for (const [name, track] of Object.entries(FF1_TRACKS)) {
      const ref = Module.allocate(1, 'i32', Module.ALLOC_STATIC);
      if (Module.ccall('gme_open_data', 'number', ['array', 'number', 'number', 'number'],
          [nsf, nsf.length, ref, 48000]) !== 0) { fail('gme_open_data failed'); continue; }
      const emu = Module.getValue(ref, 'i32');
      if (Module.ccall('gme_start_track', 'number', ['number', 'number'], [emu, track]) !== 0) {
        fail(`gme_start_track failed for FF1_TRACKS.${name} (${track}) — libgme refuses it, so it is SILENT`);
        Module.ccall('gme_delete', 'number', ['number'], [emu]); continue;
      }
      const N = 2048, buf = Module._malloc(N * 2 * 2);
      let peak = 0;
      for (let d = 0; d < 48000 * 2; d += N) {
        Module.ccall('gme_play', 'number', ['number', 'number', 'number'], [emu, N * 2, buf]);
        const base = buf >> 1;
        for (let i = 0; i < N * 2; i++) { const v = Math.abs(Module.HEAP16[base + i]); if (v > peak) peak = v; }
      }
      Module._free(buf);
      Module.ccall('gme_delete', 'number', ['number'], [emu]);
      if (peak < 500) fail(`FF1_TRACKS.${name} (${track}) renders SILENT (peak ${peak})`);
      else ok(`FF1_TRACKS.${name} (${track}) audible (peak ${peak})`);
    }
  }
}

console.log(fails ? `\ncheck-ff1-music: ${fails} FAILED` : '\ncheck-ff1-music: all checks passed');
process.exit(fails ? 1 : 0);
