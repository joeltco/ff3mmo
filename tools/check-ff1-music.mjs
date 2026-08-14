#!/usr/bin/env node
// check-ff1-music.mjs — FF1's tracks are what the ROM actually asks for.
//
// FF1 keeps the current song in zero page $4B (`music_track`) and starts one via
// Music_NewSong at $B003; NSF track N is FF1 song id N + $41. Both constants
// here used to say "verified by ear", which is a PICK.
//
// MENU_SCREEN is now measured: `tools/ff1-sound-probe.mjs` watched the game write
// $51 to $4B the moment the party menu opened, and write the field song back when
// it closed, with a screenshot of FF1's ITEM/MAGIC/WEAPON/ARMOR/STATUS screen.
//
// SHOP is NOT attributed. The ROM does request track 14 — three sites in bank 14,
// found by `tools/ff1-sound-sites.mjs` — so it is a real track, but nobody has
// watched it fire on a shop screen. This gate holds it to exactly that claim: it
// must remain a track the ROM requests, and it must not be quietly relabelled as
// measured.
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
if (FF1_TRACK_MEANINGS.size !== 3) {
  fail(`FF1_TRACK_MEANINGS has ${FF1_TRACK_MEANINGS.size} entries; only 3 were actually observed — ` +
       `adding one without a capture turns a guess into "MEASURED" in the catalogue`);
} else ok('exactly 3 observed meanings, none invented');

// ── the unattributed one ─────────────────────────────────────────────────
console.log('\nSHOP (not attributed)');
const sitesPath = new URL('./monscan/ff1-sound-sites.json', import.meta.url).pathname;
if (!fs.existsSync(sitesPath)) {
  console.log('  skip  run tools/ff1-sound-sites.mjs --json first');
} else {
  const sites = JSON.parse(fs.readFileSync(sitesPath, 'utf8'));
  const trackOf = (v) => (v == null ? null : (v & 0x3F) - 1);
  const shopSites = sites.filter(s => trackOf(s.val) === FF1_TRACKS.SHOP);
  if (!shopSites.length) {
    fail(`the ROM never requests track ${FF1_TRACKS.SHOP} — FF1_TRACKS.SHOP is not a real game track`);
  } else ok(`the ROM requests track ${FF1_TRACKS.SHOP} from ${shopSites.length} site(s)`);
  if (FF1_TRACK_MEANINGS.has(FF1_TRACKS.SHOP)) {
    fail(`track ${FF1_TRACKS.SHOP} is listed as a MEASURED meaning, but it has never been ` +
         `observed on a shop screen — attribute it or leave it out`);
  } else ok('not claimed as measured');
}

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
