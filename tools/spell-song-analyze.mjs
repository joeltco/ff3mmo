#!/usr/bin/env node
// spell-song-analyze.mjs — does any spell request a SONG, not just a SFX?
//
// FF3 has TWO sound request channels and every spell capture so far watched
// only one:
//
//   $7F49  short sound effects   (what CAPTURED_SPELL_SFX is built from)
//   $7F43  songs / jingles       (never watched during a cast)
//
// src/music.js already documents a sound the SFX sweep "could never see" for
// exactly this reason (FALL, song 48). So a spell whose real sound is
// song-type is invisible to the existing table, and whatever minor $7F49 cue
// lands in the window gets recorded as its impact instead. That is the
// hypothesis this tests, and Meteo is the reason.
//
//   node tools/spell-song-analyze.mjs <sweep.json>
//
// Prints, per spell, the control-subtracted SONG requests alongside the SFX
// ones, and flags any spell that asks for a song during its animation.

import fs from 'node:fs';

const path = process.argv[2];
if (!path) { console.error('usage: spell-song-analyze.mjs <sweep.json>'); process.exit(2); }
const d = JSON.parse(fs.readFileSync(path, 'utf8'));
const rs = d.results || [];

await import('./lib/browser-shim.mjs');
const { SPELL_NAMES_SHRINES: NAMES } = await import('../src/data/spells.js');
const { CAPTURED_SPELL_SFX } = await import('../src/data/spell-sfx-captured.js');

// Ambient = present in nearly every trace, so it belongs to the battle, not the
// spell. Computed from the data rather than hardcoded.
const seen = new Map();
for (const r of rs) {
  const s = new Set((r.sfxWrites || []).map(w => w.val));
  for (const v of s) seen.set(v, (seen.get(v) || 0) + 1);
}
const AMB = new Set([...seen].filter(([, n]) => n >= rs.length * 0.9).map(([v]) => v));

const songSeen = new Map();
for (const r of rs) {
  const s = new Set((r.songWrites || []).map(w => w.val));
  for (const v of s) songSeen.set(v, (songSeen.get(v) || 0) + 1);
}
const SONG_AMB = new Set([...songSeen].filter(([, n]) => n >= rs.length * 0.9).map(([v]) => v));

console.log('ambient sfx  (>=90% of traces): ' + [...AMB].map(v => '$' + v.toString(16)).join(' '));
console.log('ambient song (>=90% of traces): ' + ([...SONG_AMB].map(v => '$' + v.toString(16)).join(' ') || '(none)'));
console.log('total song writes across all spells: ' +
  rs.reduce((a, r) => a + (r.songWrites || []).length, 0));

console.log('\nid    name      sfx (own)                 SONG (own)');
console.log('----  --------  ------------------------  ------------------------------');
const withSong = [];
for (const r of rs.slice().sort((a, b) => a.id - b.id)) {
  const sfxOwn = (r.sfxWrites || []).filter(w => !AMB.has(w.val));
  const songOwn = (r.songWrites || []).filter(w => !SONG_AMB.has(w.val));
  if (songOwn.length) withSong.push({ id: r.id, songOwn });
  console.log(
    ('0x' + r.id.toString(16).padStart(2, '0')).padEnd(6) +
    (NAMES.get(r.id) || '?').padEnd(10) +
    sfxOwn.map(w => (w.val - 0x3f) + '@' + w.f).join(' ').padEnd(26) +
    songOwn.map(w => 'song ' + w.val + '@' + w.f).join(' '));
}

console.log('\n' + '='.repeat(70));
if (!withSong.length) {
  console.log('NO spell requests a song during its cast.');
  console.log('The song-channel hypothesis is REFUTED: $7F43 is silent for all ' +
    rs.length + ' spells, so nothing was being missed by watching only $7F49.');
} else {
  console.log('SPELLS THAT REQUEST A SONG — the SFX-only sweep could not see these:');
  for (const w of withSong) {
    console.log('  0x' + w.id.toString(16).padStart(2, '0') + '  ' +
      (NAMES.get(w.id) || '?').padEnd(10) +
      w.songOwn.map(x => 'song ' + x.val + ' @f' + x.f).join(' ') +
      '   (table currently says sfx ' + CAPTURED_SPELL_SFX.get(w.id) + ')');
  }
}
