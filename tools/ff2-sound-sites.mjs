#!/usr/bin/env node
// ff2-sound-sites.mjs — every place FF2 asks for a sound, straight from the ROM.
//
// FF2's entire audio API is one zero-page byte, $E0 (mapped from tools/
// ff2-sound-map.mjs):
//     bit 6 set -> play song-table entry (value & $3F)
//     bit 7 set -> restore the stashed music
// so every sound the game can request is an `LDA #imm / STA $E0` somewhere in
// the ROM. Enumerating them gives the COMPLETE vocabulary of what FF2 plays,
// with the ROM address of each request — no emulator, no reaching gameplay.
//
// This matters because reaching FF2 gameplay headlessly is blocked at the name
// grid, so the in-game "learn a keyword" sound cannot be captured by playing.
// The static sweep at least bounds the answer: whatever that sound is, it is one
// of these requests.
//
//   node tools/ff2-sound-sites.mjs
//   node tools/ff2-sound-sites.mjs --json
//
// Prints each site's PRG bank + CPU address so it can be cross-referenced with
// a trace, and groups by requested entry.

import fs from 'node:fs';

const args = process.argv.slice(2);
const ROM = process.env.FF2_ROM || '/home/joeltco/roms/ff2-jp.nes';
const rom = new Uint8Array(fs.readFileSync(ROM));
const PRG_START = 16;                       // iNES header
const BANK = 0x4000;
const banks = Math.floor((rom.length - PRG_START) / BANK);

/** CPU address a PRG offset appears at: last bank is fixed at $C000. */
function cpuAddr(off) {
  const b = Math.floor((off - PRG_START) / BANK);
  const within = (off - PRG_START) % BANK;
  return { bank: b, addr: (b === banks - 1 ? 0xC000 : 0x8000) + within };
}

const sites = [];
for (let i = PRG_START; i < rom.length - 3; i++) {
  // STA $E0 (zero page) = 85 E0
  if (rom[i] !== 0x85 || rom[i + 1] !== 0xE0) continue;
  // Walk back a few bytes for the value being stored.
  let val = null, how = 'via register';
  if (i >= 2 && rom[i - 2] === 0xA9) { val = rom[i - 1]; how = 'LDA #'; }
  else if (i >= 2 && rom[i - 2] === 0xA5) { how = 'LDA $' + rom[i - 1].toString(16); }
  else if (i >= 3 && rom[i - 3] === 0xAD) { how = 'LDA abs'; }
  const { bank, addr } = cpuAddr(i);
  sites.push({ off: i, bank, addr, val, how });
}

const decode = (v) => {
  if (v == null) return '';
  if (v & 0x80) return 'RESTORE stashed music';
  if (v & 0x40) return 'play song ' + (v & 0x3F);
  return 'raw $' + v.toString(16);
};

console.log(`STA $E0 sites in ${ROM}: ${sites.length}\n`);
console.log('ROM off   bank  cpu     value  meaning');
console.log('--------  ----  ------  -----  ---------------------------');
for (const s of sites) {
  console.log(
    ('0x' + s.off.toString(16)).padEnd(10) +
    String(s.bank).padStart(3) + '   $' + s.addr.toString(16).padStart(4, '0') + '  ' +
    (s.val == null ? s.how.padEnd(7) : ('$' + s.val.toString(16)).padEnd(7)) +
    decode(s.val));
}

const bySong = new Map();
for (const s of sites) {
  if (s.val == null || !(s.val & 0x40) || (s.val & 0x80)) continue;
  const song = s.val & 0x3F;
  if (!bySong.has(song)) bySong.set(song, []);
  bySong.get(song).push(s);
}
console.log('\nsongs requested by immediate value:');
for (const [song, ss] of [...bySong].sort((a, b) => a[0] - b[0])) {
  console.log(`  song ${String(song).padStart(2)}  requested from ${ss.length} site(s): ` +
    ss.map(s => `bank ${s.bank} $${s.addr.toString(16)}`).join(', '));
}
const immediate = sites.filter(s => s.val != null).length;
console.log(`\n${immediate} of ${sites.length} sites load an immediate; the rest pass the value in a register ` +
  `(those need a trace to attribute).`);

if (args.includes('--json')) {
  const out = new URL('./monscan/ff2-sound-sites.json', import.meta.url).pathname;
  fs.writeFileSync(out, JSON.stringify(sites, null, 2));
  console.log('wrote ' + out);
}
