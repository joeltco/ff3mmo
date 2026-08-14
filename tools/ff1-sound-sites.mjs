#!/usr/bin/env node
// ff1-sound-sites.mjs — every place FF1 asks for a song, straight from the ROM.
//
// FF1's sound engine lives in bank $0D. `Music_NewSong` at $B003 takes a song id
// in A, and the current track is kept in zero page **$4B** (`music_track`) — all
// documented in src/ff1-nsf-builder.js, which drives that same entry point.
// NSF track N (0-based) corresponds to FF1 song id N + $41.
//
// So every sound the game can ask for is either a `STA $4B` or a call into
// Music_NewSong with an immediate loaded first. Enumerating them gives the
// complete vocabulary with the ROM address of each request, which is what turns
// "track 14 sounds like a shop" into "track 14 is requested from the shop code".
//
//   node tools/ff1-sound-sites.mjs
//   node tools/ff1-sound-sites.mjs --json

import fs from 'node:fs';

const args = process.argv.slice(2);
const ROM = process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes';
const rom = new Uint8Array(fs.readFileSync(ROM));
const PRG_START = 16;
const BANK = 0x4000;
const banks = Math.floor((rom.length - PRG_START) / BANK);

function cpuAddr(off) {
  const b = Math.floor((off - PRG_START) / BANK);
  const within = (off - PRG_START) % BANK;
  return { bank: b, addr: (b === banks - 1 ? 0xC000 : 0x8000) + within };
}

const sites = [];

// 1. direct stores to music_track
for (let i = PRG_START; i < rom.length - 2; i++) {
  if (rom[i] !== 0x85 || rom[i + 1] !== 0x4B) continue;          // STA $4B
  let val = null;
  if (i >= 2 && rom[i - 2] === 0xA9) val = rom[i - 1];           // LDA #imm
  const { bank, addr } = cpuAddr(i);
  sites.push({ off: i, bank, addr, val, how: 'STA $4B' });
}

// 2. JSR Music_NewSong ($B003) with an immediate loaded immediately before
for (let i = PRG_START; i < rom.length - 3; i++) {
  if (rom[i] !== 0x20 || rom[i + 1] !== 0x03 || rom[i + 2] !== 0xB0) continue;
  let val = null;
  if (i >= 2 && rom[i - 2] === 0xA9) val = rom[i - 1];
  const { bank, addr } = cpuAddr(i);
  sites.push({ off: i, bank, addr, val, how: 'JSR Music_NewSong' });
}

sites.sort((a, b) => a.off - b.off);

// FF1 song id -> NSF track is id - $41 (the builder adds $41 going the other way).
const trackOf = (v) => (v == null ? null : (v & 0x3F) - 1);

console.log(`song-request sites in ${ROM}: ${sites.length}\n`);
console.log('ROM off   bank  cpu     value  NSF track  how');
console.log('--------  ----  ------  -----  ---------  -----------------');
for (const s of sites) {
  const t = trackOf(s.val);
  console.log(
    ('0x' + s.off.toString(16)).padEnd(10) +
    String(s.bank).padStart(3) + '   $' + s.addr.toString(16).padStart(4, '0') + '  ' +
    (s.val == null ? '(reg)' : '$' + s.val.toString(16)).padEnd(7) +
    (t == null || t < 0 ? '-' : String(t)).padStart(9) + '  ' + s.how);
}

const byTrack = new Map();
for (const s of sites) {
  const t = trackOf(s.val);
  if (t == null || t < 0) continue;
  if (!byTrack.has(t)) byTrack.set(t, []);
  byTrack.get(t).push(s);
}
console.log('\nNSF tracks requested by immediate value:');
for (const [t, ss] of [...byTrack].sort((a, b) => a[0] - b[0])) {
  console.log(`  track ${String(t).padStart(2)}  from ${ss.length} site(s): ` +
    ss.map(s => `bank ${s.bank} $${s.addr.toString(16)}`).join(', '));
}
const imm = sites.filter(s => s.val != null).length;
console.log(`\n${imm} of ${sites.length} sites load an immediate; the rest pass it in a register.`);

if (args.includes('--json')) {
  const out = new URL('./monscan/ff1-sound-sites.json', import.meta.url).pathname;
  fs.writeFileSync(out, JSON.stringify(sites, null, 2));
  console.log('wrote ' + out);
}
