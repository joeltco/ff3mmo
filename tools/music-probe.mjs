#!/usr/bin/env node
// music-probe.mjs — what song does the REAL ROM start when you enter a map?
//
// `tools/music-audit.mjs` reads byte 10 of each map's property record and calls
// it the song. That is an INTERPRETATION of a byte. This runs the actual game,
// warps into the map with the engine's own go-to-map path, and records what the
// sound engine is asked to play. Measurement, not interpretation.
//
// Why this exists: byte 10 reads 0x1f for Ur (a clean song id) but 0x81 for
// Kazus, Sasune Castle and the mountain town — high bit set, which is the SFX
// convention, so the byte cannot be taken at face value for those maps. Guessing
// what the high bit means is exactly the move that has produced wrong audio
// before.
//
// Song requests go to $7F43, SFX to $7F49 (both measured — see the FALL note in
// src/music.js). Both live in battery-backed RAM, and the engine consumes and
// clears them mid-frame, so polling after a frame misses them. The write hook is
// the only way to see them.
//
//   node tools/music-probe.mjs                    # every reachable map
//   node tools/music-probe.mjs 17 18              # just these maps
//   node tools/music-probe.mjs --shots out/       # also screenshot each map
//
// SELF-CHECK: Ur (114) must report song 31 (0x1f). It is the one map whose
// music is already known-correct in the shipped game, so a run that gets Ur
// wrong is a broken harness and every other number in it is worthless.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { Nes } = require('./monscan/nes.cjs');

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;

const SONG_REQ = 0x7F43;
const SFX_REQ  = 0x7F49;

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const SHOTS = flag('shots', null);
const SETTLE = parseInt(flag('settle', '300'), 10);
const ids = args.filter(a => /^\d+$/.test(a)).map(Number);

const REACHABLE = [
  [114, 'Ur (town overworld)   [SELF-CHECK: must be 31]'],
  [1,   'Ur — house 1'],
  [3,   'Ur — magic shop'],
  [6,   'Ur — elder house 1F'],
  [7,   'Ur — elder house 2F'],
  [147, 'Ur — inn'],
  [17,  'Kazus — inn'],
  [18,  'Sasune Castle'],
  [10,  'mountain town'],
  [115, 'Altar Cave 1F'],
  [116, 'Altar Cave 2F'],
  [117, 'Altar Cave 3F'],
  [118, 'Altar Cave 4F'],
  [149, 'Crystal chamber'],
];

// `--all` sweeps every map slot. Worth it because `/warp <id>` in chat can put
// a player on ANY map, so "the maps I listed" is not the same set as "the maps
// the game can load".
const ALL = args.includes('--all');
const ALL_MAX = parseInt(flag('max', '256'), 10);
const NAMED = new Map(REACHABLE);
const targets = ids.length
  ? ids.map(i => [i, NAMED.get(i) || ''])
  : ALL
    ? Array.from({ length: ALL_MAX }, (_, i) => [i, NAMED.get(i) || ''])
    : REACHABLE;

if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

/**
 * Warp into `mapId` and return every song / SFX request seen after the warp.
 *
 * The warp is the engine's own $FA GO-TO-MAP path (write map id to $0700, set
 * $AB = $80) — the same poke tools/nes-run.mjs uses. A single write does not
 * survive, because the engine rewrites $AB every frame it spends in a
 * dialogue / menu state, so hold both values until the flag is consumed.
 */
// Free-roam savestate, built once and reused. Replaying the intro costs ~17s
// per map; restoring costs milliseconds. Cached on disk so repeat runs skip it.
const STATE_PATH = new URL('./monscan/free-roam.json', import.meta.url).pathname;

/**
 * Joel's intro sequence, the one `world-sfx-sweep.cjs#boot` and
 * `reach-battle.cjs` already use: six A presses then DOWN, repeated, walks the
 * name grid through all four characters; the game runs on into the Altar Cave
 * by itself. Do NOT retune this by hand — it is shared, proven input.
 */
function bootToFreeRoam(n) {
  n.run(300);
  for (let i = 0; i < 25; i++) n.press('start', 6, 45);
  for (let block = 0; block < 10; block++) {
    for (let k = 0; k < 6; k++) n.press('a', 8, 25);
    n.press('down', 8, 40);
  }
  n.run(600);
  // The intro runs on into the FORCED opening Goblin battle, and warping out of
  // a live battle corrupts the machine — the probe crashed on an invalid opcode
  // at $9a59 on every map until this was added. Fight it out (mash A) and only
  // warp once the screen is a map again. Same >12-sprites battle test the other
  // monscan sweeps use.
  for (let i = 0; i < 120 && spriteCount(n) > 12; i++) n.press('a', 6, 24);
  n.run(180);
  if (spriteCount(n) > 12) throw new Error('still in the opening battle after 120 A presses');

  // ...and the battle is followed by the party's post-fight dialogue, which is
  // the SECOND reason the warp never took. The engine rewrites $AB every frame
  // a message box is open, so the go-to-map flag is eaten before the map-load
  // poll ever sees it (nes-run.mjs says exactly this in its own warp comment,
  // and its `--warp` fails the same way from the same state). Clear every page
  // before warping.
  for (let i = 0; i < 60 && boxOpen(n); i++) n.press('a', 6, 20);
  n.run(120);
  if (boxOpen(n)) throw new Error('a message box is still open after 60 A presses');
  return n;
}

/** >12 visible sprites means a battle is on screen (shared with status-offset.cjs). */
function spriteCount(n) {
  let c = 0;
  for (let i = 0; i < 64; i++) if (n.nes.ppu.sprY[i] < 0xEF) c++;
  return c;
}

/**
 * Is a message box open? FF3's box is a solid blue slab across the top of the
 * screen; a map is not. Measured on the real frames this probe produces: with
 * the post-battle box up the top third reads ~0.55 blue, and on a clear map it
 * reads under 0.02 — so 0.20 sits in open space between the two, not near
 * either. (Sampling the WHOLE screen would not separate them: the Altar Cave's
 * own floor is dark and the world map has water.)
 */
function boxOpen(n) {
  let blue = 0, total = 0;
  for (let y = 0; y < 80; y++) {
    for (let x = 0; x < 256; x++) {
      const p = n.fb[y * 256 + x];
      const r = p & 0xFF, g = (p >> 8) & 0xFF, b = (p >> 16) & 0xFF;
      if (b > 120 && b > r + 60 && b > g + 60) blue++;
      total++;
    }
  }
  return blue / total > 0.20;
}

// NOT savestate-cached. jsnes' toJSON/fromJSON round-trip does not restore this
// ROM's mapper state intact — a restored machine crashes on an invalid opcode at
// $9a59 within a few frames. Booting fresh per map costs ~25s and is correct;
// a savestate that crashes is not a speedup. (Also: the write hook must be
// installed on the machine that does the warp, so the recording machine is the
// one that has to boot either way.)

// One booted machine, warped repeatedly. Booting costs ~25 s; a warp costs
// about a second, so chaining is what makes a 512-map sweep possible at all.
// `_rec` is swapped per warp so the hook writes into the current map's bucket.
let _rec = null;
let _frame = -1;
let _machine = null;

function machine() {
  if (_machine) return _machine;
  const n = new Nes(ROM, {
    onBatteryRamWrite: (addr, val) => {
      if (!_rec) return;                    // between warps — not this map's
      const a = addr | 0, v = val & 0xFF;
      if (a === SONG_REQ) _rec.songs.push({ f: _frame, v });
      else if (a === SFX_REQ) _rec.sfx.push({ f: _frame, v });
    },
  });
  bootToFreeRoam(n);
  _machine = n;
  return n;
}

function probe(mapId) {
  const n = machine();
  const rec = { songs: [], sfx: [] };
  const poke = (a, v) => { n.nes.cpu.mem[a] = v; };
  const peek = (a) => n.nes.cpu.mem[a];

  // Record only from the warp onward. Anything the previous map or the intro
  // requested would otherwise be read as this map's music.
  _rec = rec;
  let took = false;
  for (let f = 0; f < 240; f++) {
    poke(0x0700, mapId);
    poke(0x00AB, 0x80);
    _frame = f;
    n.nes.frame();
    if (peek(0x00AB) !== 0x80) { took = true; break; }
  }
  const warpFrame = _frame;
  for (let f = 0; f < SETTLE; f++) { _frame = warpFrame + 1 + f; n.nes.frame(); }
  _rec = null;

  return { took, songs: rec.songs, sfx: rec.sfx, warpFrame, nes: n };
}

/**
 * Leave the machine ready for the NEXT warp.
 *
 * Arriving on a map opens its name banner ("Castle Sasune"), and a banner is a
 * message box — the engine rewrites $AB while one is up, so without this only
 * the FIRST warp in a chain ever lands. Called after the recording window
 * closes so clearing the box never eats into the measurement.
 */
function readyForNextWarp(n) {
  for (let i = 0; i < 40 && boxOpen(n); i++) n.press('a', 6, 18);
  n.run(60);
}

/** Throw the machine away so the next probe boots clean (after a crash). */
function resetMachine() { _machine = null; _rec = null; }

console.log('map   song requests after warp            sfx           name');
console.log('----  -----------------------------------  ------------  ----------------------');

const results = [];
for (const [mapId, name] of targets) {
  // A warp that is never consumed is a FAILED reading, not a quiet "(none)".
  // Treat it exactly like a crash: reboot and retry once. Letting it through as
  // an empty row is how a map ends up looking like it requests no music at all.
  let r = null;
  for (let attempt = 0; attempt < 2 && (!r || !r.took); attempt++) {
    if (attempt > 0) resetMachine();
    try { r = probe(mapId); }
    catch (e) { r = null; }
  }
  if (!r) { console.log(String(mapId).padEnd(6) + 'PROBE FAILED (crashed twice)'); resetMachine(); continue; }
  readyForNextWarp(r.nes);

  // The LAST song requested after the warp settles is the one left playing —
  // a map load can request a silence/stop first.
  const reqs = r.songs.map(s => s.v);
  const final = reqs.length ? reqs[reqs.length - 1] : null;
  const desc = reqs.length
    ? reqs.map(v => '0x' + v.toString(16).padStart(2, '0') + '(' + v + ')').join(' → ')
    : '(none)';

  results.push({ mapId, name, reqs, final, sfx: r.sfx.map(s => s.v) });
  console.log(
    String(mapId).padEnd(6) +
    desc.padEnd(37) +
    (r.sfx.length ? r.sfx.map(s => '$' + s.v.toString(16)).join(',') : '-').padEnd(14) +
    (r.took ? '' : '[WARP NOT CONSUMED] ') + name);

  if (SHOTS) r.nes.screenshot(path.join(SHOTS, 'map-' + mapId + '.png'));
}

// ── self-check ────────────────────────────────────────────────────────────
// Never trust a sweep that cannot reproduce a value already known to be right.
const ur = results.find(r => r.mapId === 114);
if (ur) {
  const ok = ur.final === 31;
  console.log('\nSELF-CHECK Ur(114) expects song 31: ' +
    (ok ? 'PASS (' + ur.final + ')' : 'FAIL (got ' + ur.final + ') — harness is broken, ignore every row above'));
  if (!ok) process.exitCode = 1;
}

if (args.includes('--json')) {
  fs.writeFileSync('music-probe.json', JSON.stringify(results, null, 2));
  console.log('wrote music-probe.json');
}
