#!/usr/bin/env node
// ff1-spell-source.mjs — where does a monster's chosen spell id COME FROM?
//
//   node tools/ff1-spell-source.mjs --id 0x77 --rounds 10
//
// ⭐ Byte 7 selects a POOL, not an attack: LICH (byte 7 $22) casts spell ids
// $1C/$1D/$1F, CHAOS ($2A) casts $2C/$34/$48. The pool is not a fixed-stride table
// (no stride 2..48 fits three monsters), so it has to be caught at runtime.
//
// ⛔ SEARCHING OPCODES DOES NOT WORK HERE. $6875, where byte 7 is stashed, has NO
// absolute reader anywhere in the ROM — it is consumed indexed. Same for the pool.
//
// ⭐ METHOD: keep a ring buffer of recent loads. The instant $6C8C is written (that
// is the chosen spell id), walk back for the most recent load that RETURNED that
// value. That load is the pool read. Coincidences scatter; the real source repeats
// at a consistent address across activations, which is what the aggregation shows.

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NES, Controller } from 'jsnes';
import * as F1 from './lib/ff1-text.mjs';
import * as MN from './lib/ff1-monsters.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const ID = Number(flag('id', '0x77'));
const ROUNDS = Number(flag('rounds', '10'));
const ROUND_CAP = 1800;

const rom = new Uint8Array(fs.readFileSync(process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes'));
const raw = fs.readFileSync(path.join(HERE, 'states', 'ff1-world.state.gz'));
const SNAP = (raw[0] === 0x1f && raw[1] === 0x8b) ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
const hx = (v, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');
const PARTY_HP = 0x610A, PARTY_STRIDE = 0x40;
const SPELL_PARAM = 0x6C8C;

const p = Uint8Array.from(rom);
p[MN.FORMATION_TABLE + MN.FORMATION_MONSTER_OFF] = ID;
p[MN.FORMATION_TABLE + MN.FORMATION_COUNT_OFF[0]] = 0x11;
const S = MN.STAT_TABLE + ID * MN.STAT_STRIDE;
p[S + MN.STAT_FIELDS.evade] = 0xFF;

const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
nes.loadROM(Buffer.from(p).toString('binary'));
nes.fromJSON(JSON.parse(SNAP));
const c = nes.cpu;
const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };

const lines = () => {
  const v = nes.ppu.vramMem, out = [];
  for (let r = 0; r < 30; r++) {
    let s = '';
    for (let col = 0; col < 32; col++) { const g = F1.glyph(v[0x2000 + r * 32 + col]); s += (g === null || g === '\n') ? ' ' : g; }
    out.push(s);
  }
  return out;
};
const menuUp = () => lines().some(l => /\bRUN\b/.test(l));
const onBattleScreen = () => lines().filter(l => /\bHP\b/.test(l)).length >= 3;
const immortal = () => {
  for (let i = 0; i < 4; i++) { c.mem[PARTY_HP + i * PARTY_STRIDE] = 0xE7; c.mem[PARTY_HP + i * PARTY_STRIDE + 1] = 0x03; }
  for (let i = 0; i < 9; i++) {
    const a = MN.ENEMY_RAM + i * MN.ENEMY_RAM_STRIDE;
    if ((c.mem[a + MN.ENEMY_MAXHP_OFF] | (c.mem[a + MN.ENEMY_MAXHP_OFF + 1] << 8)) === 0) continue;
    c.mem[a + MN.ENEMY_CURHP_OFF] = 0xE7; c.mem[a + MN.ENEMY_CURHP_OFF + 1] = 0x03;
  }
};

// --- ring buffer of loads, and the write trigger ---------------------------
const RING = 512;
const rAddr = new Uint16Array(RING), rVal = new Uint8Array(RING), rPc = new Uint16Array(RING);
let rI = 0, recording = false;
const found = [];                     // { srcAddr, srcPc, val, back }

const origLoad = c.load.bind(c);
c.load = function (addr) {
  const v = origLoad(addr);
  if (recording) { rAddr[rI] = addr; rVal[rI] = v; rPc[rI] = c.REG_PC; rI = (rI + 1) % RING; }
  return v;
};
const origWrite = c.write.bind(c);
c.write = function (addr, val) {
  if (recording && addr === SPELL_PARAM && val !== 0xFF) {
    // ⭐ Walk BACK from the newest load. The first match is the closest producer.
    for (let k = 1; k <= RING; k++) {
      const i = (rI - k + RING) % RING;
      if (rVal[i] === val) { found.push({ srcAddr: rAddr[i], srcPc: rPc[i], val, back: k }); break; }
    }
  }
  return origWrite(addr, val);
};

// --- reach the battle ------------------------------------------------------
run(20);
c.mem[0x27] = 150; c.mem[0x28] = 170;
run(20);
const D = [Controller.BUTTON_LEFT, Controller.BUTTON_RIGHT];
let started = false;
for (let s = 0; s < 300 && !started; s++) {
  const b = D[Math.floor(s / 6) % 2];
  nes.buttonDown(1, b); run(8); nes.buttonUp(1, b); run(12);
  if (menuUp()) started = true;
}
if (!started) { console.log('never reached a battle'); process.exit(1); }
console.log(`monster $${hx(ID)}, byte 7 = $${hx(rom[S + MN.STAT_FIELDS.special])}`);

recording = true;
let acted = 0;
for (let r = 0; r < ROUNDS; r++) {
  if (!onBattleScreen()) break;
  immortal();
  for (let k = 0; k < 12 && menuUp() && onBattleScreen(); k++) {
    nes.buttonDown(1, Controller.BUTTON_A); run(4); nes.buttonUp(1, Controller.BUTTON_A); run(16);
  }
  acted++;
  let f = 0;
  while (f < ROUND_CAP && !menuUp() && onBattleScreen()) { run(10); f += 10; immortal(); }
}
recording = false;

console.log(`\n${found.length} spell choices across ${acted} rounds`);
for (const f of found) console.log(`  spell $${hx(f.val)} <- read from $${hx(f.srcAddr, 4)} (PC $${hx(f.srcPc, 4)}, ${f.back} loads back)`);

// ⭐ The real source repeats at a consistent address; coincidental value matches
// scatter. Group and rank.
const grp = new Map();
for (const f of found) {
  const k = f.srcPc;
  if (!grp.has(k)) grp.set(k, []);
  grp.get(k).push(f);
}
console.log('\nreader PC  hits  source addresses            ROM bank (16-byte signature)');
for (const [pc, fs_] of [...grp.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const sig = Array.from({ length: 16 }, (_, i) => c.mem[(pc + i) & 0xFFFF]);
  const hits = [];
  for (let o = 16; o + 16 <= rom.length; o++) {
    let ok = true;
    for (let i = 0; i < 16; i++) if (rom[o + i] !== sig[i]) { ok = false; break; }
    if (ok) { hits.push(o); if (hits.length > 4) break; }
  }
  const where = hits.length === 1 ? `⭐ bank ${Math.floor((hits[0] - 16) / 0x4000)} (file $${hx(hits[0], 5)})`
    : hits.length === 0 ? '⛔ no ROM match' : `⛔ AMBIGUOUS x${hits.length}`;
  const addrs = [...new Set(fs_.map(f => '$' + hx(f.srcAddr, 4)))].join(' ');
  console.log(`  $${hx(pc, 4)}  ${String(fs_.length).padStart(4)}  ${addrs.padEnd(26)}  ${where}`);
}
