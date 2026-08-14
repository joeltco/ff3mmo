#!/usr/bin/env node
// check-word-learn-sfx.mjs — LEARN plays FF2's real keyword-learned jingle, and
// only when a word was actually learned.
//
// The value is MEASURED, not picked. FF2 gameplay was unreachable headlessly
// until the one-byte name-entry patch (tools/ff2-build-playable-rom.mjs); with
// it, tools/ff2-learn-capture.mjs logged every $E0 request against its frame.
// Song 9 fires on the exact frame Hilda teaches the keyword 【のばら】:
//
//     ヒルダ「あいことばは【のばら】です。よく おぼえておくのよ。」
//
// and never again across four re-conversations with the same NPC or sixty
// wander-and-LEARN attempts. It plays over the map music and restores it 98
// frames later (~1.6 s), matching track 9's measured 1536 ms.
//
//   node tools/check-word-learn-sfx.mjs

import fs from 'node:fs';

await import('./lib/browser-shim.mjs');
const { FF2_TRACKS } = await import('../src/music.js');

let fails = 0;
const fail = (m) => { console.error('  FAIL  ' + m); fails++; };
const ok = (m) => console.log('  ok    ' + m);

console.log('\nmeasured track');
if (FF2_TRACKS.WORD_LEARNED !== 9) {
  fail(`FF2_TRACKS.WORD_LEARNED is ${FF2_TRACKS.WORD_LEARNED}, measured 9`);
} else ok('FF2_TRACKS.WORD_LEARNED = 9');

// It must not collide with the chime: two different events sharing one cue is
// how a sound stops meaning anything.
if (FF2_TRACKS.WORD_LEARNED === FF2_TRACKS.MENTION_CHIME) {
  fail(`the learned cue and the @-mention chime are both track ${FF2_TRACKS.WORD_LEARNED}`);
} else ok(`distinct from MENTION_CHIME (${FF2_TRACKS.MENTION_CHIME})`);

// ── the wiring ───────────────────────────────────────────────────────────
console.log('\nwiring');
const WM = fs.readFileSync(new URL('../src/word-menu.js', import.meta.url), 'utf8');
if (!/playWordLearnedJingle\s*\(/.test(WM)) {
  fail('src/word-menu.js never calls playWordLearnedJingle — LEARN still uses the plain confirm blip');
} else ok('word-menu calls playWordLearnedJingle');

// The cue must be GUARDED by "something was actually learned". An unguarded
// call fires on "Nothing new to learn." too, which teaches the player that the
// reward sound means nothing.
//
// Checked as the INVARIANT, not as one expression: this used to pin
// `if (names.length) playWordLearnedJingle` verbatim and failed on correct code
// the moment v1.8.8 split LEARN into `_learnOne` (guard `if (got)`). There are
// two call sites now — LEARN, and an answer that hands over the next term — and
// every one of them must sit behind a conditional downstream of a real
// learnWord() call.
{
  const code = WM.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const sites = [...code.matchAll(/playWordLearnedJingle\s*\(/g)];
  if (!sites.length) fail('no playWordLearnedJingle call sites found in the stripped source');
  for (const m of sites) {
    const before = code.slice(Math.max(0, m.index - 240), m.index);
    const guarded = /if\s*\(/.test(before) && /learnWord\s*\(/.test(before);
    if (!guarded) {
      fail(`a playWordLearnedJingle call is not guarded by an actual learn — it would fire when ` +
           `nothing was learned. Context: ...${before.slice(-90).replace(/\s+/g, ' ')}`);
    }
  }
  if (sites.length) ok(`${sites.length} jingle call site(s), each behind a learnWord() guard`);
}

// ── audible through the real decoder ─────────────────────────────────────
console.log('\nplayback');
const ROM = process.env.FF2_ROM || '/home/joeltco/roms/ff2-jp.nes';
let rom = null;
try { rom = new Uint8Array(fs.readFileSync(ROM)); } catch { /* optional */ }
if (!rom) {
  console.log('  skip  no FF2 ROM at ' + ROM);
} else {
  const vm = (await import('node:vm')).default;
  const src = fs.readFileSync(new URL('../lib/libgme.js', import.meta.url).pathname, 'utf8');
  const sandbox = { console, process, setTimeout, clearTimeout, Date, Math, JSON, TextDecoder, TextEncoder };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  try { vm.runInContext(src, sandbox, { filename: 'libgme.js' }); } catch { /* skip below */ }
  const Module = sandbox.Module;
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
    const { buildFF2NSF } = await import('../src/ff2-nsf-builder.js');
    const nsf = buildFF2NSF(rom);
    const ref = Module.allocate(1, 'i32', Module.ALLOC_STATIC);
    if (Module.ccall('gme_open_data', 'number', ['array', 'number', 'number', 'number'],
        [nsf, nsf.length, ref, 48000]) !== 0) fail('gme_open_data failed');
    else {
      const emu = Module.getValue(ref, 'i32');
      if (Module.ccall('gme_start_track', 'number', ['number', 'number'], [emu, FF2_TRACKS.WORD_LEARNED]) !== 0) {
        fail(`gme_start_track failed for track ${FF2_TRACKS.WORD_LEARNED} — libgme refuses it, so LEARN is SILENT`);
      } else {
        const N = 2048, buf = Module._malloc(N * 2 * 2);
        let peak = 0;
        for (let d = 0; d < 48000 * 2; d += N) {
          Module.ccall('gme_play', 'number', ['number', 'number', 'number'], [emu, N * 2, buf]);
          const base = buf >> 1;
          for (let i = 0; i < N * 2; i++) { const v = Math.abs(Module.HEAP16[base + i]); if (v > peak) peak = v; }
        }
        Module._free(buf);
        if (peak < 500) fail(`track ${FF2_TRACKS.WORD_LEARNED} renders SILENT (peak ${peak})`);
        else ok(`track ${FF2_TRACKS.WORD_LEARNED} renders audible PCM (peak ${peak})`);
      }
      Module.ccall('gme_delete', 'number', ['number'], [emu]);
    }
  }
}

console.log(fails ? `\ncheck-word-learn-sfx: ${fails} FAILED` : '\ncheck-word-learn-sfx: all checks passed');
process.exit(fails ? 1 : 0);
