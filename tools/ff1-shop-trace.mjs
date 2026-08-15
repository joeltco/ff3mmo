#!/usr/bin/env node
// ff1-shop-trace.mjs — find FF1's shop inventory table by watching a shop open.
//
// WHY
// The shop id space is decoded (`lib/ff1-map.mjs`), so a shop can be opened on
// demand. What it SELLS still has to be found, and searching the ROM for a
// plausible run of item ids finds dozens of false hits. So don't search: open
// the shop and record which cartridge bytes it reads.
//
// THE METHOD
// Poke the game's own request ($51 = id, $50 = 1), record every cartridge read
// while it draws, then look for a PC that reads CONSECUTIVE addresses — that is
// a table walk. Run two different shop ids and the runs move by the stride.
//
//   node tools/ff1-shop-trace.mjs --id 12
//   node tools/ff1-shop-trace.mjs --id 12 --id 13     # compare, to get the stride
//
// ⛔ Record the BANK at read time. $8000-$BFFF is switchable, and resolving a
// read's bank afterwards attributes it to whatever happened to be mapped last.
// ⛔ `onRead` is cartridge-only by design here — the inventory is in ROM, and
// hooking every RAM read as well makes this several times slower for nothing.

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NES } from 'jsnes';
import { makeTracer, bankAt, hex } from './lib/nes-trace.mjs';
import * as M from './lib/ff1-map.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const IDS = args.reduce((a, v, i) => (v === '--id' ? [...a, Number(args[i + 1])] : a), []);
const MINRUN = Number(flag('minrun', '4'));
const SETTLE = Number(flag('settle', '260'));
const ROMP = process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes';
const STATE_GZ = path.join(HERE, 'states', 'ff1-hall.state.gz');

const rom = new Uint8Array(fs.readFileSync(ROMP));
const romBin = fs.readFileSync(ROMP, 'binary');
const SNAP = zlib.gunzipSync(fs.readFileSync(STATE_GZ)).toString('utf8');

/** Open shop `id` and return every cartridge read, tagged with the live bank. */
function readsWhileOpening(id) {
  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(romBin);
  nes.fromJSON(JSON.parse(SNAP));
  for (let i = 0; i < 20; i++) nes.frame();
  const t = makeTracer(nes);
  const hits = [];
  t.onRead = (addr, val, pc) => {
    if (addr < 0x8000) return;
    // ⛔ bank NOW, not later — see header
    hits.push({ addr, val, pc, bank: bankAt(nes, rom, 0x8000) });
  };
  nes.cpu.mem[M.SPECIAL_ID] = id;
  nes.cpu.mem[M.SPECIAL_PENDING] = 1;
  t.recording = true;
  for (let i = 0; i < SETTLE; i++) nes.frame();
  t.recording = false;
  return hits;
}

/** Consecutive-address runs read by one instruction — i.e. table walks. */
function runsOf(hits) {
  const byPc = new Map();
  for (const h of hits) {
    if (!byPc.has(h.pc)) byPc.set(h.pc, []);
    byPc.get(h.pc).push(h);
  }
  const runs = [];
  for (const [pc, list] of byPc) {
    // dedupe repeats of the same address, keep first-seen order
    const seen = new Set();
    const seq = list.filter(h => (seen.has(h.addr) ? false : (seen.add(h.addr), true)));
    seq.sort((a, b) => a.addr - b.addr);
    let start = 0;
    for (let i = 1; i <= seq.length; i++) {
      if (i === seq.length || seq[i].addr !== seq[i - 1].addr + 1) {
        const n = i - start;
        if (n >= MINRUN) {
          runs.push({ pc, bank: seq[start].bank, from: seq[start].addr, n,
                      vals: seq.slice(start, i).map(h => h.val) });
        }
        start = i;
      }
    }
  }
  return runs.sort((a, b) => a.from - b.from);
}

if (!IDS.length) { console.error('give at least one --id N'); process.exit(1); }

const perId = new Map();
for (const id of IDS) {
  const hits = readsWhileOpening(id);
  const runs = runsOf(hits);
  perId.set(id, runs);
  console.log(`\n=== shop id ${id} (${M.specialKind(id)}) — ${hits.length} cartridge reads, ` +
              `${runs.length} run(s) of >=${MINRUN} consecutive ===`);
  for (const r of runs) {
    const file = r.from >= 0xC000
      ? 0x10 + ((rom.length - 0x10) / 0x4000 - 1) * 0x4000 + (r.from - 0xC000)
      : 0x10 + r.bank * 0x4000 + (r.from - 0x8000);
    console.log(`  ${hex(r.pc)} reads ${hex(r.from)}..${hex(r.from + r.n - 1)} ` +
                `(bank ${r.bank}, file 0x${file.toString(16)}) n=${r.n}  ` +
                `[${r.vals.map(v => v.toString(16).padStart(2, '0')).join(' ')}]`);
  }
}

// Two ids read the same table at different offsets — the gap IS the stride.
if (IDS.length >= 2) {
  console.log('\n=== runs that MOVED between ids (the shop table) ===');
  const [a, b] = IDS;
  for (const ra of perId.get(a)) {
    const rb = perId.get(b).find(r => r.pc === ra.pc && r.from !== ra.from);
    if (rb) {
      console.log(`  ${hex(ra.pc)}: id ${a} @ ${hex(ra.from)} -> id ${b} @ ${hex(rb.from)}  ` +
                  `stride ${rb.from - ra.from} per ${b - a} id(s)`);
    }
  }
}
