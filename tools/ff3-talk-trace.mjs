#!/usr/bin/env node
// ff3-talk-trace.mjs — catch FF3's talk routine fetching a string, and confirm
// (or replace) `stringId = npcId + 0x202` from the CPU.
//
// WHY
// FF3's rule rests on FOUR measurements and is exactly the shape that has now
// been wrong twice: a small constant offset that agrees on the first NPCs
// anyone checks. FF1's `dialogueId == objType` and FF2's both looked settled.
// Both turned out to be a per-type RECORD plus a per-type CODE handler.
// So: do not trust the offset, watch the bus.
//
// THE HOOK
//   * FF3's player tile is pokeable at $0710 / $0711 (nes-run already does
//     this), so an NPC can be talked to without walking.
//   * The string pointer table is at file 0x030010. FF3 is MMC3 with 8KB
//     banks, so that is bank 24, appearing at $8000 or $A000. Fetching string
//     N reads (window + N*2).
//
//   node tools/ff3-talk-trace.mjs --state ff3-freeroam.state --map 7 --npc 4,3
//   node tools/ff3-talk-trace.mjs --state ff3-freeroam.state --map 7 --npc 4,3 --zp
//
// ⛔ Build the tracer AFTER `nes.fromJSON` — it replaces `nes.cpu`. See
// `tools/lib/nes-trace.mjs`.

import fs from 'node:fs';
import { NES, Controller } from 'jsnes';
import { makeTracer, bankAt, groupByPc, hex } from './lib/nes-trace.mjs';

const F3 = await import('./lib/ff3-text.mjs');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const STATE = flag('state', null);
const MAP = parseInt(flag('map', '7'), 10);
const NPC = (flag('npc', '4,3')).split(',').map(Number);
const ZP = args.includes('--zp');
const ROMP = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;

// ⛔ $0710/$0711 (what nes-run's `--at` pokes) are NOT the live position — a
// poke sticks in RAM and the sprite does not move. MEASURED by walking and
// diffing: the live tile is $68/$69, the SAME addresses FF1 and FF2 use.
const PLAYER_X = 0x68, PLAYER_Y = 0x69;
/** MEASURED: a hold of 16 frames advances exactly one tile (5 is far too short). */
const STEP_HOLD = 16, STEP_REST = 16;
const WARP_MAP = 0x0700, WARP_FLAG = 0x00AB;
/** MMC3: 8KB PRG banks. The string pointer table lives in this one. */
const BANK_SIZE = 0x2000;
const PTR_BANK = (F3.PTR_TABLE - 0x10) / BANK_SIZE;

const rom = new Uint8Array(fs.readFileSync(ROMP));
const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
nes.loadROM(fs.readFileSync(ROMP, 'binary'));
if (!STATE) { console.error('--state is required (an FF3 free-roam savestate)'); process.exit(1); }
nes.fromJSON(JSON.parse(fs.readFileSync(STATE, 'utf8')));

// ⛔ AFTER fromJSON
const t = makeTracer(nes);
const cpu = nes.cpu;
const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
const press = (b, hold = STEP_HOLD, after = STEP_REST) => {
  nes.buttonDown(1, b); run(hold); nes.buttonUp(1, b); run(after);
};

// ── warp to the map, then stand next to the NPC ───────────────────────────
run(8);
let took = false;
for (let f = 0; f < 240; f++) {
  cpu.mem[WARP_MAP] = MAP; cpu.mem[WARP_FLAG] = 0x80;
  nes.frame();
  if (cpu.mem[WARP_FLAG] !== 0x80) { took = true; break; }
}
run(180);
if (!took) { console.error(`warp to map ${MAP} was never consumed`); process.exit(1); }

const at = () => [cpu.mem[PLAYER_X], cpu.mem[PLAYER_Y]];
const DIR = { up: Controller.BUTTON_UP, down: Controller.BUTTON_DOWN,
              left: Controller.BUTTON_LEFT, right: Controller.BUTTON_RIGHT };
/** Walk to (tx,ty), alternating axes so a wall on one still routes. */
function goTo(tx, ty, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const [x, y] = at();
    if (x === tx && y === ty) return true;
    if (x !== tx && (i % 2 === 0 || y === ty)) press(DIR[x < tx ? 'right' : 'left']);
    else if (y !== ty) press(DIR[y < ty ? 'down' : 'up']);
    else return false;
  }
  const [x, y] = at();
  return x === tx && y === ty;
}

const [nx, ny] = NPC;
if (!goTo(nx, ny + 1)) console.error(`warning: could not reach (${nx},${ny + 1}), now at ${at()}`);
press(Controller.BUTTON_UP);                            // face the NPC (it blocks)
run(20);
console.log(`FF3 talk trace — map ${MAP}, standing at (${cpu.mem[PLAYER_X]},${cpu.mem[PLAYER_Y]}) facing the NPC on (${nx},${ny})`);
console.log(`string pointers are in 8KB bank ${PTR_BANK}; windows now hold: ` +
  [0x8000, 0xA000, 0xC000, 0xE000].map(w => `${hex(w)}=${bankAt(nes, rom, w, BANK_SIZE)}`).join('  '));

// ── record the talk ───────────────────────────────────────────────────────
const ptrReads = [];
const zpWrites = [];
t.onRead = (addr, val, pc) => {
  for (const win of [0x8000, 0xA000, 0xC000, 0xE000]) {
    if (addr >= win && addr < win + 0x800 && bankAt(nes, rom, win, BANK_SIZE) === PTR_BANK) {
      ptrReads.push({ pc, addr, val, win, id: (addr - win) >> 1 });
    }
  }
};
// $92 holds the string id for the fetch routine at $EE9A
//   LDA $92 / ASL A / TAY / LDA ($94),Y
// so whoever writes $92 (and the base in $94/$95) IS the npcId -> id mapping.
// ⛔ not `flag('zp')` — `--zp` is a BOOLEAN flag, so that reads the next arg.
const WATCH = flag('zpwatch', '92,93,94,95').split(',').map(h => parseInt(h, 16));
// --ramwatch LO-HI watches a whole range (e.g. the $0740 dialogue-id array)
const RANGE = flag('ramwatch', null);
const [RLO, RHI] = RANGE ? RANGE.split('-').map(h => parseInt(h, 16)) : [-1, -1];
// ⛔ Record the bank LIVE. Banks switch during a talk, so the window dump taken
// before it says nothing about which bank the writing instruction lives in —
// disassembling with the stale bank lands mid-instruction and reads as garbage.
const winOf = (pc) => (pc >= 0xE000 ? 0xE000 : pc >= 0xC000 ? 0xC000 : pc >= 0xA000 ? 0xA000 : 0x8000);
if (ZP) {
  t.onWrite = (addr, val, pc) => {
    if (!WATCH.includes(addr) && !(addr >= RLO && addr <= RHI)) return;
    const win = winOf(pc);
    zpWrites.push({ pc, addr, val, win, bank: bankAt(nes, rom, win, BANK_SIZE) });
  };
}

t.recording = true;
press(Controller.BUTTON_A);
run(40);
t.recording = false;

// did a box actually open? read the nametable — FF3 expands text before it
// draws, so tile index == character code.
{
  const v = nes.ppu.vramMem;
  const lines = [];
  for (const base of [0x2000, 0x2400, 0x2800, 0x2C00]) {
    for (let r = 0; r < 30; r++) {
      let str = '';
      for (let c = 0; c < 32; c++) { const g = F3.glyph(v[base + r * 32 + c]); str += (g === null ? ' ' : g); }
      if (/[A-Za-z]{4,}/.test(str)) lines.push(str.trim());
    }
  }
  console.log(`box on screen: ${lines.length ? JSON.stringify(lines.slice(0, 3)) : '(nothing)'}\n`);
}

if (!ptrReads.length) {
  console.log('no read landed in the pointer table — did a box open?');
  process.exit(0);
}

console.log('── reads inside the string pointer table ──');
for (const [pc, rs] of groupByPc(ptrReads).slice(0, 10)) {
  const ids = [...new Set(rs.map(r => r.id))];
  console.log(`  ${hex(pc)}  ${rs.length} read(s)   window ${hex(rs[0].win)}   ids ${ids.slice(0, 10).join(',')}${ids.length > 10 ? ' …' : ''}`);
}

// The lowest-numbered distinct id read is almost always the string itself;
// print every candidate with its text so the right one is obvious rather than
// assumed.
const ids = [...new Set(ptrReads.map(r => r.id))].sort((a, b) => a - b);
console.log(`\n── ${ids.length} distinct id(s) touched ──`);
for (const id of ids.slice(0, 12)) {
  console.log(`  ${id} (0x${id.toString(16)}): "${F3.decodeString(rom, id).slice(0, 72)}"`);
}

if (ZP) {
  console.log('\n── writes to the fetch routine\'s inputs ──');
  for (const w of zpWrites) {
    console.log(`  ${hex(w.pc)}  $${w.addr.toString(16)} = ${w.val} (0x${w.val.toString(16)})` +
                `   [bank ${w.bank} at ${hex(w.win)} -> node tools/dis6502.mjs ` +
                `${w.bank.toString(16).toUpperCase()} ${(w.pc - 2).toString(16).toUpperCase()}]`);
  }
}

console.log(`\n── the last 40 instructions of the talk ──`);
for (const s of t.history(40)) console.log(`  ${hex(s.pc)}  A=${s.a} X=${s.x} Y=${s.y}`);
