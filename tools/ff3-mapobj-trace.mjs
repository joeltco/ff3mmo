#!/usr/bin/env node
// ff3-mapobj-trace.mjs — catch FF3 loading a map's NPC list, and check what
// `src/map-loader.js#readNPCs` assumes against what the CPU actually does.
//
// WHY
// FF2's map object table turned out to be one contiguous run, not the two
// blocks the catalog modelled — and that mistake had silently dropped 79
// objects including a main party member. FF1's model was then re-derived and
// held up. FF3's has never been checked at all, and unlike the other two it is
// LOAD-BEARING: `readNPCs` is what the shipped game places NPCs from.
//
// What it currently assumes, all unverified:
//   * pointer table at file 0x058010, indexed by map property byte 4
//   * `nesAddr = ((hi | 0x80) << 8) | lo`   <- forces bit 7 of the high byte
//   * at most 16 NPCs, 4 bytes each {id, x, y, flags}, id == 0 terminates
//
// THE HOOK
// The NPC data lives in 8KB banks 44-45 (0x58010-0x5C010). Warp to a map while
// recording cartridge reads and report every instruction that read there — the
// pointer fetch and the record walk both have to show up.
//
//   node tools/ff3-mapobj-trace.mjs --state ff3-freeroam.state --map 7
//
// ⛔ Build the tracer AFTER `nes.fromJSON` — it replaces `nes.cpu`.

import fs from 'node:fs';
import { NES } from 'jsnes';
import { makeTracer, bankAt, groupByPc, hex } from './lib/nes-trace.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const STATE = flag('state', null);
const MAP = parseInt(flag('map', '7'), 10);
const ROMP = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;

const WARP_MAP = 0x0700, WARP_FLAG = 0x00AB;
const BANK_SIZE = 0x2000;
/** file 0x058010-0x05C010 -> 8KB banks 44 and 45 */
const NPC_BANKS = [44, 45];

const rom = new Uint8Array(fs.readFileSync(ROMP));
const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
nes.loadROM(fs.readFileSync(ROMP, 'binary'));
if (!STATE) { console.error('--state is required'); process.exit(1); }
nes.fromJSON(JSON.parse(fs.readFileSync(STATE, 'utf8')));

const t = makeTracer(nes);            // ⛔ after fromJSON
const cpu = nes.cpu;
const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };

/** Which window a CPU address sits in, and hence which bank it resolves to. */
const winOf = (a) => (a >= 0xE000 ? 0xE000 : a >= 0xC000 ? 0xC000 : a >= 0xA000 ? 0xA000 : 0x8000);
const fileOf = (addr) => {
  const w = winOf(addr);
  const b = bankAt(nes, rom, w, BANK_SIZE);
  return b < 0 ? -1 : 0x10 + b * BANK_SIZE + (addr - w);
};

const reads = [];
t.onRead = (addr, val, pc) => {
  if (addr < 0x8000) return;
  const b = bankAt(nes, rom, winOf(addr), BANK_SIZE);
  if (!NPC_BANKS.includes(b)) return;
  // ⛔ Record the PC's OWN bank AT READ TIME. Banks switch during a map load,
  // so resolving it after the warp disassembles a different routine entirely.
  const pcBank = bankAt(nes, rom, winOf(pc), BANK_SIZE);
  reads.push({ pc, addr, val, bank: b, pcBank,
               file: 0x10 + b * BANK_SIZE + (addr - winOf(addr)) });
};

run(8);
t.recording = true;
let took = false;
for (let f = 0; f < 240; f++) {
  cpu.mem[WARP_MAP] = MAP; cpu.mem[WARP_FLAG] = 0x80;
  nes.frame();
  if (cpu.mem[WARP_FLAG] !== 0x80) { took = true; break; }
}
run(200);
t.recording = false;
if (!took) { console.error(`warp to map ${MAP} never consumed`); process.exit(1); }

console.log(`FF3 map-object trace — map ${MAP}, ${reads.length} read(s) in NPC banks ${NPC_BANKS.join('/')}\n`);
console.log('── grouped by instruction ──');
for (const [pc, rs] of groupByPc(reads).slice(0, 12)) {
  const files = [...new Set(rs.map(r => r.file))].sort((a, b) => a - b);
  const pcBank = rs[0].pcBank;
  console.log(`  ${hex(pc)}  ${String(rs.length).padStart(4)} read(s)  ` +
              `file 0x${files[0].toString(16)}${files.length > 1 ? `..0x${files[files.length - 1].toString(16)}` : ''}` +
              `  (${files.length} distinct)`);
  console.log(`        values ${[...new Set(rs.map(r => r.val))].slice(0, 10).join(',')}` +
              `   -> node tools/dis6502.mjs ${pcBank.toString(16).toUpperCase()} ${(pc - 3).toString(16).toUpperCase()}`);
}

// What map-loader.js would predict, for comparison.
const { loadMap } = await import('../src/map-loader.js');
const md = loadMap(rom, MAP);
console.log(`\n── src/map-loader.js#readNPCs predicts ${md.npcs.length} NPC(s) ──`);
for (const n of md.npcs) console.log(`   id ${String(n.id).padStart(3)} at (${n.x},${n.y}) flags 0x${(n.flags ?? 0).toString(16)}`);
const touched = [...new Set(reads.map(r => r.file))].sort((a, b) => a - b);
console.log(`\nfile offsets actually read: 0x${touched[0]?.toString(16)} .. 0x${touched[touched.length - 1]?.toString(16)}`);
