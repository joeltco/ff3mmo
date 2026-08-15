#!/usr/bin/env node
// ff1-collision-trace.mjs — find how FF1 decides a tile is walkable.
//
// WHY
// Every other FF1 probe is limited by navigation: the axis-walker cannot route
// through doors, so whole classes of question (what is `$0D` bit 0? what is in
// a shop?) are unanswerable. Pathfinding needs two things — the map, and
// walkability. The map is settled: the decompressed 64x64 tilemap sits at RAM
// $7000, one byte per tile (verified against the screen). This finds the rest.
//
// THE METHOD
// Press a direction and record (a) reads of the tilemap page and (b) every
// cartridge read, with the value. The move code has to fetch the target tile
// and then look its properties up somewhere; doing it once for a move that
// SUCCEEDS and once for a move that is BLOCKED and diffing the two isolates the
// lookup.
//
//   node tools/ff1-collision-trace.mjs --state ff1-castle.state --dir up
//   node tools/ff1-collision-trace.mjs --state ff1-castle.state --dir down
//
// ⛔ Build the tracer AFTER `nes.fromJSON` — it replaces `nes.cpu`.
// ⛔ Resolve a PC's bank AT READ TIME.

import fs from 'node:fs';
import { NES, Controller } from 'jsnes';
import { makeTracer, bankAt, groupByPc, hex } from './lib/nes-trace.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const STATE = flag('state', null);
const DIR = flag('dir', 'up');
const ROMP = process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes';

const PLAYER_X = 0x68, PLAYER_Y = 0x69;
/** MEASURED: the decompressed 64x64 map, one byte per tile. */
const MAP_RAM = 0x7000, MAP_W = 64;

const rom = new Uint8Array(fs.readFileSync(ROMP));
const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
nes.loadROM(fs.readFileSync(ROMP, 'binary'));
if (!STATE) { console.error('--state is required'); process.exit(1); }
nes.fromJSON(JSON.parse(fs.readFileSync(STATE, 'utf8')));

const t = makeTracer(nes);           // ⛔ after fromJSON
const cpu = nes.cpu;
const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
const B = { up: Controller.BUTTON_UP, down: Controller.BUTTON_DOWN,
            left: Controller.BUTTON_LEFT, right: Controller.BUTTON_RIGHT };
const at = () => [cpu.mem[PLAYER_X], cpu.mem[PLAYER_Y]];
const tileAt = (x, y) => cpu.mem[MAP_RAM + (y & 63) * MAP_W + (x & 63)];

run(20);
const [x0, y0] = at();
const D = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[DIR];
const tx = (x0 + D[0]) & 63, ty = (y0 + D[1]) & 63;
console.log(`FF1 collision trace — at (${x0},${y0}) tile 0x${tileAt(x0, y0).toString(16)}, ` +
            `moving ${DIR} onto (${tx},${ty}) tile 0x${tileAt(tx, ty).toString(16)}`);

const mapReads = [];
const romReads = [];
const TOTAL = (rom.length - 0x10) / 0x4000;
t.onRead = (addr, val, pc) => {
  if (addr >= MAP_RAM && addr < MAP_RAM + 0x1000) {
    mapReads.push({ pc, addr, val, tx: (addr - MAP_RAM) % MAP_W, ty: (addr - MAP_RAM) >> 6 });
    return;
  }
  if (addr >= 0x8000) {
    const fixed = pc >= 0xC000;
    const bank = fixed ? TOTAL - 1 : bankAt(nes, rom, 0x8000);
    romReads.push({ pc, addr, val, bank });
  }
};

t.recording = true;
nes.buttonDown(1, B[DIR]); run(6); nes.buttonUp(1, B[DIR]); run(20);
t.recording = false;
const [x1, y1] = at();
console.log(`result: now at (${x1},${y1}) — the move ${x1 === x0 && y1 === y0 ? 'was BLOCKED' : 'SUCCEEDED'}\n`);

console.log('── reads of the tilemap page ──');
for (const [pc, rs] of groupByPc(mapReads).slice(0, 8)) {
  const tiles = [...new Set(rs.map(r => `(${r.tx},${r.ty})=0x${r.val.toString(16)}`))];
  console.log(`  ${hex(pc)}  ${rs.length}x   ${tiles.slice(0, 6).join(' ')}${tiles.length > 6 ? ' …' : ''}`);
}

// A property lookup is a ROM read whose ADDRESS moves with the tile value —
// i.e. base + tile. Report ROM reads whose low byte matches a tile we touched.
const touched = new Set(mapReads.map(r => r.val));
console.log('\n── cartridge reads whose offset matches a tile id (candidate property tables) ──');
const cand = new Map();
for (const r of romReads) {
  for (const tile of touched) {
    if ((r.addr & 0xFF) === tile || (r.addr & 0xFF) === ((tile * 2) & 0xFF)) {
      const base = r.addr - ((r.addr & 0xFF) === tile ? tile : tile * 2);
      const k = `${hex(r.pc)} base ${hex(base)} bank ${r.bank}`;
      if (!cand.has(k)) cand.set(k, []);
      cand.get(k).push(`0x${tile.toString(16)}->0x${r.val.toString(16)}`);
    }
  }
}
for (const [k, v] of [...cand].sort((a, b) => b[1].length - a[1].length).slice(0, 10)) {
  console.log(`  ${k}   ${[...new Set(v)].slice(0, 8).join(' ')}`);
}
if (!cand.size) console.log('  none — the property may already be cached in RAM');
