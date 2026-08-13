#!/usr/bin/env node
// check-map-music.mjs — every map starts its OWN measured song.
//
// Guards the v1.7.997 fix. Before it, `_loadRegularMap` started music for map
// 114 and no other map, so Kazus (17), Castle Sasune (18) and the mountain town
// (10) kept whatever track the previous map left playing — in practice Ur's
// town theme, which is what Joel reported.
//
// The song values come from `tools/music-probe.mjs`, which warps the real ROM
// into all 256 map slots and records the write to $7F43. This gate does NOT
// re-run the emulator (too slow for a deploy); it pins the table and, more
// importantly, exercises the REAL decision function so a revert of the wiring
// fails here rather than in a player's ears.
//
//   node tools/check-map-music.mjs

import fs from 'node:fs';

await import('./lib/browser-shim.mjs');
const { MAP_SONGS, songForMap } = await import('../src/data/map-songs.js');
const { mapEntryMusic } = await import('../src/map-music.js');

let fails = 0;
const fail = (msg) => { console.error('  FAIL  ' + msg); fails++; };
const ok = (msg) => console.log('  ok    ' + msg);

// ── 1. the table is complete, not sampled ────────────────────────────────
console.log('\nmeasured song table');
if (MAP_SONGS.size !== 256) fail(`MAP_SONGS has ${MAP_SONGS.size} entries, expected 256`);
else ok('256 map slots measured');

// ── 2. anchors that were already correct in the shipped game ─────────────
// If a re-measure or a hand-edit moves one of these, the sweep is wrong, not
// the game. Never derive these from the table under test.
const ANCHORS = [
  [114, 31, "Ur — the one map whose music was already right"],
  [115,  2, 'Altar Cave 1F'],
  [149, 54, 'Crystal chamber'],
];
console.log('\nanchors (known-correct before the fix)');
for (const [mapId, want, why] of ANCHORS) {
  const got = songForMap(mapId);
  if (got !== want) fail(`map ${mapId} (${why}): song ${got}, expected ${want}`);
  else ok(`map ${mapId} -> ${want}  (${why})`);
}

// ── 3. the maps Joel reported ────────────────────────────────────────────
// Two assertions each, and the second is the one that matters: it is not
// enough that these maps HAVE a song, they must not have UR's song — "it plays
// something" was the state that shipped.
const UR_SONG = 31;
const REPORTED = [
  [17, 12, 'Kazus inn'],
  [18, 12, 'Castle Sasune'],
  [10, 12, 'mountain town'],
];
console.log('\nreported-wrong maps');
for (const [mapId, want, name] of REPORTED) {
  const got = songForMap(mapId);
  if (got == null) fail(`${name} (map ${mapId}) has no song at all`);
  else if (got === UR_SONG) fail(`${name} (map ${mapId}) still plays Ur's theme (${UR_SONG}) — this is the reported bug`);
  else if (got !== want) fail(`${name} (map ${mapId}): song ${got}, measured ${want}`);
  else ok(`${name} (map ${mapId}) -> ${want}, not Ur's ${UR_SONG}`);
}

// ── 4. the decision function itself ──────────────────────────────────────
// Runs the REAL mapEntryMusic the game calls, not a restatement of it.
console.log('\nmapEntryMusic behaviour');
const cases = [
  ['plain map starts its own song',
    () => mapEntryMusic(17, { ff2Ready: true, pendingTrack: null, ff2ElderTrack: 24 }),
    (r) => r.kind === 'ff3' && r.song === 12],
  ['elder house takes FF2 when the FF2 ROM is loaded',
    () => mapEntryMusic(6, { ff2Ready: true, pendingTrack: null, ff2ElderTrack: 24 }),
    (r) => r.kind === 'ff2' && r.track === 24],
  ['elder house falls back to its measured FF3 song without FF2',
    () => mapEntryMusic(6, { ff2Ready: false, pendingTrack: null, ff2ElderTrack: 24 }),
    (r) => r.kind === 'ff3' && r.song === 31],
  ['a queued transition track is not talked over',
    () => mapEntryMusic(114, { ff2Ready: true, pendingTrack: 31, ff2ElderTrack: 24 }),
    (r) => r.kind === 'deferred'],
  ['an unmeasured slot (dungeon floor) starts nothing',
    () => mapEntryMusic(1000, { ff2Ready: true, pendingTrack: null, ff2ElderTrack: 24 }),
    (r) => r.kind === 'none'],
];
for (const [name, run, want] of cases) {
  let r;
  try { r = run(); } catch (e) { fail(`${name}: threw ${e.message}`); continue; }
  if (!want(r)) fail(`${name}: got ${JSON.stringify(r)}`);
  else ok(name);
}

// ── 5. the wiring, not just the data ─────────────────────────────────────
// Everything above still passes if `_loadRegularMap` goes back to its old
// `mapId === 114` branch and never calls the decision function — the table
// would be perfect and unused. This is the only check that catches that, so it
// is deliberately about the call site.
console.log('\nwiring');
const ML = fs.readFileSync(new URL('../src/map-loading.js', import.meta.url), 'utf8');
if (!/mapEntryMusic\s*\(/.test(ML)) {
  fail('src/map-loading.js does not call mapEntryMusic — map music is hardcoded again');
} else ok('map-loading.js delegates to mapEntryMusic');

// The specific shape of the old bug: a music call guarded by one literal map id.
const hardcoded = ML.match(/mapId\s*===\s*\d+[^\n]*playTrack\s*\(/);
if (hardcoded) fail(`src/map-loading.js starts music behind a single-map test: ${hardcoded[0].trim()}`);
else ok('no single-map hardcoded music branch');

const TS = fs.readFileSync(new URL('../src/title-screen.js', import.meta.url), 'utf8');
if (/pendingTrack\s*=\s*TRACKS\.TOWN_UR/.test(TS)) {
  fail('src/title-screen.js queues TOWN_UR for every saved map — loading a save in Kazus opens on Ur\'s theme');
} else ok('title-screen queues the saved map\'s own song');

console.log(fails ? `\ncheck-map-music: ${fails} FAILED` : '\ncheck-map-music: all checks passed');
process.exit(fails ? 1 : 0);
