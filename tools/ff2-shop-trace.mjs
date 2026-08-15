#!/usr/bin/env node
// ff2-shop-trace.mjs — find FF2's shop inventory tables by opening a shop.
//
// WHY
// FF2's shops are object types 192-219 (`ff2-type-sweep.mjs` found that by
// standing every one of the 256 types next to the party and talking to it).
// What each one STOCKS still has to be found, and searching the ROM for a
// plausible run of item ids finds dozens of false hits.
//
// THE METHOD
// Stand a shop object next to the party, talk, walk into the Buy list, and
// record every cartridge byte read. Then do it again for the NEXT shop id and
// diff: a read whose address MOVED between the two is indexed by the shop, and
// the distance is the stride.
//
//   node tools/ff2-shop-trace.mjs --state s.state --type 192 --type 193
//
// ⛔ Record the bank at read time — $8000-$BFFF is switchable.
// ⛔ Poke the object into RAM at $7500; patching the ROM's table does nothing
// once a savestate has the map loaded. Both +0 and +0A must be set.

import fs from 'node:fs';
import { NES, Controller } from 'jsnes';
import { makeTracer, bankAt, hex } from './lib/nes-trace.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const TYPES = args.reduce((a, v, i) => (v === '--type' ? [...a, Number(args[i + 1])] : a), []);
const MINRUN = Number(flag('minrun', '3'));
const STATE = flag('state', process.env.FF2_STATE);
const ROMP = process.env.FF2_ROM || '/home/joeltco/roms/ff2-jp.nes';

const OBJ_RAM = 0x7500, O_LIVE = 0, O_X = 2, O_Y = 3, O_X2 = 4, O_Y2 = 5, O_TYPE = 0x0A;
const PLAYER_X = 0x68, PLAYER_Y = 0x69;

if (!STATE) { console.error('--state is required'); process.exit(1); }
if (TYPES.length < 1) { console.error('give at least one --type N'); process.exit(1); }
const rom = new Uint8Array(fs.readFileSync(ROMP));
const romBin = fs.readFileSync(ROMP, 'binary');
const SNAP = fs.readFileSync(STATE, 'utf8');
const B = { a: Controller.BUTTON_A, b: Controller.BUTTON_B, up: Controller.BUTTON_UP };

/** Open the shop of object `type` and record cartridge reads while it draws. */
function readsWhileBuying(type) {
  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(romBin);
  nes.fromJSON(JSON.parse(SNAP));
  const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
  const press = (k, h = 6, a = 16) => {
    nes.buttonDown(1, B[k]); run(h); nes.buttonUp(1, B[k]); run(a);
  };
  run(8); press('b'); press('b'); run(30);
  const m = nes.cpu.mem, px = m[PLAYER_X], py = m[PLAYER_Y];
  for (let s = 1; s < 12; s++) m[OBJ_RAM + s * 0x10 + O_LIVE] = 0;
  m[OBJ_RAM + O_LIVE] = type; m[OBJ_RAM + O_TYPE] = type;
  m[OBJ_RAM + O_X] = px; m[OBJ_RAM + O_X2] = px;
  m[OBJ_RAM + O_Y] = py - 1; m[OBJ_RAM + O_Y2] = py - 1;
  run(10); press('up');

  // record only from the moment the shop is asked to draw its stock
  const t = makeTracer(nes);
  const hits = [];
  t.onRead = (addr, val, pc) => {
    if (addr < 0x8000) return;
    hits.push({ addr, val, pc, bank: bankAt(nes, rom, 0x8000) });
  };
  t.recording = true;
  press('a', 6, 60);            // open the shop
  press('a', 6, 60);            // ...and its Buy list
  t.recording = false;
  return hits;
}

/** Consecutive-address runs read by one instruction — table walks. */
function runsOf(hits) {
  const byPc = new Map();
  for (const h of hits) {
    const k = `${h.pc}|${h.bank}`;
    if (!byPc.has(k)) byPc.set(k, new Map());
    byPc.get(k).set(h.addr, h.val);
  }
  const runs = [];
  for (const [k, addrs] of byPc) {
    const [pc, bank] = k.split('|').map(Number);
    const seq = [...addrs.keys()].sort((a, b) => a - b);
    let start = 0;
    for (let i = 1; i <= seq.length; i++) {
      if (i === seq.length || seq[i] !== seq[i - 1] + 1) {
        if (i - start >= MINRUN) {
          runs.push({ pc, bank, from: seq[start], n: i - start,
                      vals: seq.slice(start, i).map(a => addrs.get(a)) });
        }
        start = i;
      }
    }
  }
  return runs.sort((a, b) => a.from - b.from);
}

const fileOf = (a, bank) => a >= 0xC000
  ? 0x10 + ((rom.length - 0x10) / 0x4000 - 1) * 0x4000 + (a - 0xC000)
  : 0x10 + bank * 0x4000 + (a - 0x8000);

const per = new Map();
for (const t of TYPES) {
  const hits = readsWhileBuying(t);
  const runs = runsOf(hits);
  per.set(t, runs);
  console.log(`\n=== shop object type ${t} (shop index ${t - 192}) — ` +
              `${hits.length} cartridge reads, ${runs.length} run(s) >=${MINRUN} ===`);
  for (const r of runs.slice(0, 40)) {
    console.log(`  ${hex(r.pc)} ${hex(r.from)}..${hex(r.from + r.n - 1)} ` +
                `bank ${r.bank} file 0x${fileOf(r.from, r.bank).toString(16)} n=${r.n}  ` +
                `[${r.vals.slice(0, 12).map(v => v.toString(16).padStart(2, '0')).join(' ')}]`);
  }
}

if (TYPES.length >= 2) {
  console.log('\n=== runs that MOVED between the two shops (indexed by shop) ===');
  const [a, b] = TYPES;
  for (const ra of per.get(a)) {
    const rb = per.get(b).find(r => r.pc === ra.pc && r.from !== ra.from);
    if (!rb) continue;
    console.log(`  ${hex(ra.pc)}: ${hex(ra.from)} -> ${hex(rb.from)}  ` +
                `stride ${rb.from - ra.from} per ${b - a} shop(s)  ` +
                `file 0x${fileOf(ra.from, ra.bank).toString(16)}`);
  }
}
