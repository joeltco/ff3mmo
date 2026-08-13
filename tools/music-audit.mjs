#!/usr/bin/env node
// music-audit.mjs — what song does each map ACTUALLY want, per the ROM?
//
// FF3 stores a song id in every map's property block (byte 10 of the 16-byte
// record at MAP_PROPS_BASE). That byte is the game's own answer to "what plays
// here" — the same number `playTrack` feeds `gme_start_track`, since our NSF
// keeps the ROM's song numbering (TRACKS.TOWN_UR = 0x1F is literally Ur's
// songId byte; see the FALL note in src/music.js).
//
// Before this existed, map music was wired by hand and only ONE map had an
// entry: `map-loading.js` played TOWN_UR for map 114 and nothing for anything
// else, so Kazus, Sasune Castle and every interior kept whatever track the
// previous map left running.
//
//   node tools/music-audit.mjs            # every map the game can reach
//   node tools/music-audit.mjs --all      # all 512 ROM map slots
//   node tools/music-audit.mjs --json     # machine-readable
//
// Reads the ROM through the REAL parseMapProperties — never a hand-copy.

import fs from 'node:fs';

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));

const { parseMapProperties } = await import('../src/map-loader.js');

const args = process.argv.slice(2);
const ALL = args.includes('--all');
const JSON_OUT = args.includes('--json');

// Maps this game actually reaches, with the name the PLAYER would use. Sourced
// from the load sites in src/map-loading.js + src/data/town-npcs.js + the
// dungeon dispatch; a map absent here is one no player can currently stand on.
const REACHABLE = [
  [114, 'Ur (town overworld)'],
  [1,   'Ur — house 1'],
  [2,   'Ur — house 2'],
  [3,   'Ur — magic shop'],
  [4,   'Ur — house 4'],
  [5,   'Ur — house 5'],
  [6,   'Ur — elder house 1F'],
  [7,   'Ur — elder house 2F'],
  [8,   'Ur — house 8'],
  [9,   'Ur — house 9'],
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

const SONG_NAMES = {
  0x02: 'Altar Cave / crystal cave',
  0x07: 'battle victory',
  0x1A: 'piano 3 (loading)',
  0x1E: 'Eternal Wind (world map)',
  0x1F: 'My Home Town',
  0x20: 'Battle 1',
  0x2A: 'Battle 2 (boss)',
  0x30: 'fall / whoosh',
  0x36: 'Crystal Room',
  0x37: 'title screen',
};

const rows = [];
const list = ALL
  ? Array.from({ length: 512 }, (_, i) => [i, ''])
  : REACHABLE;

for (const [mapId, name] of list) {
  let p;
  try { p = parseMapProperties(rom, mapId); } catch { continue; }
  rows.push({
    mapId,
    name,
    songId: p.songId,
    songHex: '0x' + p.songId.toString(16).padStart(2, '0'),
    songName: SONG_NAMES[p.songId] || '',
    tileset: p.tileset,
  });
}

if (JSON_OUT) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log('map   songId        song                          name');
  console.log('----  ------------  ----------------------------  --------------------------');
  for (const r of rows) {
    console.log(
      String(r.mapId).padEnd(6) +
      (r.songHex + ' (' + r.songId + ')').padEnd(14) +
      r.songName.padEnd(30) +
      r.name);
  }
  // Read your own table: which distinct songs are in play, and how many maps
  // share each. A town and a castle landing on the SAME id is a real finding;
  // so is every map landing on a different one.
  const byS = new Map();
  for (const r of rows) byS.set(r.songId, (byS.get(r.songId) || 0) + 1);
  console.log('\ndistinct songs: ' + byS.size + ' across ' + rows.length + ' maps');
  for (const [s, n] of [...byS].sort((a, b) => b[1] - a[1])) {
    console.log('  0x' + s.toString(16).padStart(2, '0') + ' (' + String(s).padStart(3) + ')  ×' + n +
      (SONG_NAMES[s] ? '  ' + SONG_NAMES[s] : ''));
  }
}
