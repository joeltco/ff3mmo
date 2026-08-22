#!/usr/bin/env node
// ff3-zone-trace.mjs — catch FF3 CHOOSING an encounter, and find the table that
// says which formations a map can roll.
//
// WHY
// `tools/lib/ff3-encounters.mjs` decoded everything downstream of the choice:
// `$7CED/$7CEE` is a 16-bit index into ENCOUNTER_SET ($5C010), which yields a
// species record and a count pattern. What has never been found is the step
// BEFORE that — how a MAP picks the value it writes there. The zones in
// `src/data/encounters.js` are hand-authored because of that gap.
//
// ⛔ It is NOT a map property byte — all 16 were decoded and checked; see
// `tools/map-encounters.mjs`, which self-tests and refuses. So watch the bus.
//
// THE HOOK is the ENCOUNTER_SET fetch itself (bank 46, $8000 + zone*2): that
// read is unambiguous proof a formation was picked. Everything else is reported
// relative to it — the writes that set the id, and the cartridge reads before
// them.
//
//   node tools/ff3-zone-trace.mjs                     # freeroam (world map)
//   node tools/ff3-zone-trace.mjs --map 111           # warp to a dungeon first
//
// ⛔ Resolve the PC's bank AT ACCESS TIME — banks switch constantly and a
// post-hoc lookup disassembles a different routine.

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NES, Controller } from 'jsnes';
import { makeTracer, bankAt, hex } from './lib/nes-trace.mjs';
import * as EN from './lib/ff3-encounters.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const MAP = flag('map', null) === null ? null : Number(flag('map'));
const READS = Number(flag('reads', '60'));
const HIST = Number(flag('hist', '30'));
const BANK_SIZE = 0x2000;
const SET_BANK = (EN.ENCOUNTER_SET - 0x10) / BANK_SIZE;      // 46
const SET_LEN = EN.ENCOUNTER_SET_ENTRIES * EN.ENCOUNTER_SET_STRIDE;

const ROMP = process.env.FF3_ROM || path.join(HERE, '..', 'FF3-English.nes');
const rom = new Uint8Array(fs.readFileSync(ROMP));
const SNAP = zlib.gunzipSync(
  fs.readFileSync(path.join(HERE, 'states', 'ff3-freeroam.state.gz'))).toString('utf8');

const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
nes.loadROM(Buffer.from(rom).toString('binary'));
nes.fromJSON(JSON.parse(SNAP));
const cpu = nes.cpu;
const t = makeTracer(nes);                       // ⛔ after fromJSON

const winOf = (a) => (a >= 0xE000 ? 0xE000 : a >= 0xC000 ? 0xC000 : a >= 0xA000 ? 0xA000 : 0x8000);
const bankOf = (a) => bankAt(nes, rom, winOf(a), BANK_SIZE);
const fileOf = (a, b) => (b < 0 ? -1 : 0x10 + b * BANK_SIZE + (a - winOf(a)));

const WARP_MAP = 0x0700, WARP_FLAG = 0x00AB;
const D = [Controller.BUTTON_LEFT, Controller.BUTTON_RIGHT];
const STEP_HOLD = 16, STEP_REST = 16;
const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
run(8);

if (MAP !== null) {
  let took = false;
  for (let f = 0; f < 240; f++) {
    cpu.mem[WARP_MAP] = MAP; cpu.mem[WARP_FLAG] = 0x80;
    nes.frame();
    if (cpu.mem[WARP_FLAG] !== 0x80) { took = true; break; }
  }
  if (!took) { console.error(`warp to map ${MAP} never consumed`); process.exit(1); }
  run(180);
}

// ── ring of recent cartridge reads; a log of zone-id writes; break on the fetch
const RING = 8192;
const rAddr = new Int32Array(RING), rVal = new Int32Array(RING), rPc = new Int32Array(RING);
const rBank = new Int32Array(RING), rPcBank = new Int32Array(RING);
let ri = 0;
const writes = [];
// --watch 0x6a,0x6b : extra RAM addresses whose writes are logged the same way
const WATCH = (flag('watch', '') ? flag('watch').split(',').map(Number) : []);
const wwrites = [];

t.onRead = (addr, val, pc) => {
  if (addr < 0x8000) return;
  const b = bankOf(addr);
  if (!hit && b === SET_BANK && (addr - winOf(addr)) < SET_LEN) {
    hit = { addr, val, pc, pcBank: bankOf(pc), ri,
            lo: cpu.mem[EN.ZONE_ID_ZP], hi: cpu.mem[EN.ZONE_ID_ZP + 1],
            hist: t.history(HIST), writes: writes.slice(-12), wwrites: wwrites.slice(-16) };
    t.recording = false;
    return;
  }
  rAddr[ri] = addr; rVal[ri] = val; rPc[ri] = pc;
  rBank[ri] = b; rPcBank[ri] = bankOf(pc);
  ri = (ri + 1) % RING;
};
t.onWrite = (addr, val, pc) => {
  if (WATCH.includes(addr)) wwrites.push({ addr, val, pc, pcBank: bankOf(pc), ri });
  if (addr !== EN.ZONE_ID_ZP && addr !== EN.ZONE_ID_ZP + 1) return;
  writes.push({ addr, val, pc, pcBank: bankOf(pc), ri });
};

let hit = null;
t.recording = true;
outer:
for (let step = 0; step < 600 && !hit; step++) {
  const b = D[step % D.length];
  nes.buttonDown(1, b);
  for (let i = 0; i < STEP_HOLD; i++) { nes.frame(); if (hit) break outer; }
  nes.buttonUp(1, b);
  for (let i = 0; i < STEP_REST; i++) { nes.frame(); if (hit) break outer; }
}

if (!hit) { console.error('no ENCOUNTER_SET fetch in 600 steps'); process.exit(1); }

const zone = (hit.hi << 8) | hit.lo;
const off = hit.addr - winOf(hit.addr);
console.log(`⭐ ENCOUNTER_SET fetched: ${hex(hit.addr)} (table offset 0x${off.toString(16)}) = 0x${hit.val.toString(16)}`);
console.log(`   by ${hex(hit.pc)} bank ${hit.pcBank}`);
console.log(`   $7CED/$7CEE = 0x${hit.lo.toString(16)}/0x${hit.hi.toString(16)}  ->  zone ${zone} (0x${zone.toString(16)})`);
console.log(`   table offset implies zone ${off >> 1}\n`);

console.log('── writes to $7CED/$7CEE seen before the fetch ──');
for (const w of hit.writes)
  console.log(`   ${hex(w.addr)} = 0x${w.val.toString(16).padStart(2, '0')}  by ${hex(w.pc)} bank ${w.pcBank}` +
              `  -> node tools/dis6502.mjs ${w.pcBank.toString(16).toUpperCase()} ${(w.pc - 3).toString(16).toUpperCase()}`);

if (WATCH.length) {
  console.log(`\n── writes to ${WATCH.map((a) => hex(a)).join('/')} before the fetch ──`);
  for (const w of hit.wwrites)
    console.log(`   ${hex(w.addr)} = 0x${w.val.toString(16).padStart(2, '0')}  by ${hex(w.pc)} bank ${w.pcBank}` +
                `  -> node tools/dis6502.mjs ${w.pcBank.toString(16).toUpperCase()} ${(w.pc - 3).toString(16).toUpperCase()}`);
}

console.log(`\n── last ${READS} cartridge reads before the fetch ──`);
for (let k = READS; k > 0; k--) {
  const i = (hit.ri - k + RING) % RING;
  if (!rPc[i]) continue;
  console.log(`   pc ${hex(rPc[i])} (b${String(rPcBank[i]).padStart(2)})  read ${hex(rAddr[i])}` +
              ` = 0x${rVal[i].toString(16).padStart(2, '0')}  bank ${String(rBank[i]).padStart(2)}` +
              `  file 0x${fileOf(rAddr[i], rBank[i]).toString(16)}`);
}

console.log(`\n── last ${HIST} instructions ──`);
for (const h of hit.hist) console.log(`   ${hex(h.pc)}  A=${h.a.toString(16)} X=${h.x.toString(16)} Y=${h.y.toString(16)}`);
