#!/usr/bin/env node
// ff1-talk-trace.mjs — catch FF1's talk routine fetching a string, and report
// the object type it fetched it FOR.
//
// WHY, given FF1 already "has" a rule
// `dialogueId == objType` shipped for FF1 as verified in v1.8.25 and was
// retracted in v1.8.29; the replacement (a 4-byte record at 0x395E5, byte 1)
// rests on ONE screen measurement. FF2's rule looked just as settled and was
// wrong. So: re-derive it from the CPU, and measure many objects, not one.
//
// THE HOOK
// FF1 keeps its live map objects in RAM at $6F00, 16 bytes apart, byte 0 = the
// object TYPE (confirmed on Coneria Castle: slots 0-1 hold type 32, which the
// sprite table sends to entry 25 — exactly what the PPU shows). The string
// pointer table is at file 0x28010 = $8000 with bank 10 mapped, so a fetch of
// string N reads $8000 + N*2.
//
// Watching both at once gives (objType, stringId) pairs straight off the bus,
// with no table assumed anywhere.
//
//   node tools/ff1-talk-trace.mjs --state ff1-castle.state
//   node tools/ff1-talk-trace.mjs --state ff1-castle.state --sweep 40
//
// `--sweep N` wanders the map pressing A, collecting as many distinct pairs as
// it can — the "many measurements, not one" part.

import fs from 'node:fs';
import { NES, Controller } from 'jsnes';
import { makeTracer, bankAt, groupByPc, hex } from './lib/nes-trace.mjs';

const F1 = await import('./lib/ff1-text.mjs');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const STATE = flag('state', null);
const SWEEP = parseInt(flag('sweep', '0'), 10);
const ROMP = process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes';

/** MEASURED: live map objects, 16 bytes apart, byte 0 = type. */
const OBJ_RAM = 0x6F00, OBJ_STRIDE = 0x10, OBJ_SLOTS = 16;
/** The string pointer table sits at $8000 when its bank is mapped. */
const PTR_WINDOW = 0x8000;
const PTR_BANK = (F1.PTR_TABLE - 0x10) / 0x4000;

const rom = new Uint8Array(fs.readFileSync(ROMP));
const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
nes.loadROM(fs.readFileSync(ROMP, 'binary'));
if (!STATE) { console.error('--state is required'); process.exit(1); }
nes.fromJSON(JSON.parse(fs.readFileSync(STATE, 'utf8')));

// ⛔ build the tracer AFTER fromJSON — it replaces nes.cpu
const t = makeTracer(nes);

const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
const B = {
  a: Controller.BUTTON_A, b: Controller.BUTTON_B, up: Controller.BUTTON_UP,
  down: Controller.BUTTON_DOWN, left: Controller.BUTTON_LEFT, right: Controller.BUTTON_RIGHT,
};
const press = (k, hold = 10, after = 26) => {
  nes.buttonDown(1, B[k]); run(hold); nes.buttonUp(1, B[k]); run(after);
};

run(20);
console.log(`FF1 talk trace — map $0048 = ${nes.cpu.mem[F1.MAP_ID_ADDR]}`);
console.log(`bank at $8000: ${bankAt(nes, rom, 0x8000)}   (string pointers live in bank ${PTR_BANK})`);

/** The object types currently live in RAM, by slot. */
const liveTypes = () => Array.from({ length: OBJ_SLOTS },
  (_, i) => nes.cpu.mem[OBJ_RAM + i * OBJ_STRIDE]);
console.log(`live object types: [${liveTypes().join(',')}]\n`);

// ── the trace ─────────────────────────────────────────────────────────────
// Two things are watched at once:
//   * reads of $6F00+slot*16 -> which OBJECT the game is working on
//   * reads of $8000+id*2 while bank 10 is mapped -> which STRING it fetched
let lastObjType = null, lastObjPc = null;
const ptrReads = [];
const objReads = [];

t.onRead = (addr, val, pc) => {
  if (addr >= OBJ_RAM && addr < OBJ_RAM + OBJ_SLOTS * OBJ_STRIDE) {
    if ((addr - OBJ_RAM) % OBJ_STRIDE === 0) {     // byte 0 of a slot = its type
      lastObjType = val; lastObjPc = pc;
      objReads.push({ pc, slot: (addr - OBJ_RAM) / OBJ_STRIDE, val });
    }
    return;
  }
  // the pointer table is only meaningful while ITS bank is in the window
  if (addr >= PTR_WINDOW && addr < PTR_WINDOW + 0x400 && bankAt(nes, rom, 0x8000) === PTR_BANK) {
    ptrReads.push({ pc, addr, val, id: (addr - PTR_WINDOW) >> 1, objType: lastObjType, objPc: lastObjPc });
  }
};

const pairs = new Map();     // objType -> stringId, as measured
function talkOnce() {
  ptrReads.length = 0;
  t.recording = true;
  press('a'); run(24);
  t.recording = false;
  // the FIRST pointer read after a talk is the line being displayed
  const first = ptrReads.find(r => r.objType !== null);
  if (first && !pairs.has(first.objType)) pairs.set(first.objType, first.id);
  return first;
}

if (!SWEEP) {
  const hit = talkOnce();
  if (!hit) { console.log('no string pointer was fetched — is an NPC in front of you?'); process.exit(0); }
  console.log(`objType ${hit.objType} (read at ${hex(hit.objPc)})  ->  string ${hit.id}`);
  console.log(`   "${F1.decodeString(rom, hit.id, { nl: ' ' }).slice(0, 90)}"`);
  console.log(`\n── pointer reads, by instruction ──`);
  for (const [pc, rs] of groupByPc(ptrReads).slice(0, 8)) {
    console.log(`  ${hex(pc)}  ${rs.length} read(s)  ids ${[...new Set(rs.map(r => r.id))].slice(0, 8).join(',')}`);
  }
  console.log(`\n── object-array reads, by instruction ──`);
  for (const [pc, rs] of groupByPc(objReads).slice(0, 8)) {
    console.log(`  ${hex(pc)}  ${rs.length} read(s)  slots ${[...new Set(rs.map(r => r.slot))].join(',')}`);
  }
  console.log(`\n── last 30 instructions before the fetch ──`);
  for (const s of t.history(30)) console.log(`  ${hex(s.pc)}  A=${s.a} X=${s.x} Y=${s.y}`);
  process.exit(0);
}

// ── sweep: wander and talk, collecting as many pairs as possible ──────────
const DIRS = ['up', 'right', 'down', 'left'];
for (let i = 0; i < SWEEP; i++) {
  press(DIRS[i % 4]);
  talkOnce();
  press('b');                    // dismiss any box we opened
  press('b');
}

console.log(`── measured (objType -> stringId) pairs, straight off the bus ──`);
const rows = [...pairs].sort((a, b) => a[0] - b[0]);
let agree = 0;
for (const [type, id] of rows) {
  const predicted = F1.dialogueForType(rom, type);
  const ok = predicted === id;
  if (ok) agree++;
  console.log(`  objType ${String(type).padStart(3)}  ->  string ${String(id).padStart(3)}` +
              `   record byte1 predicts ${String(predicted).padStart(3)}  ${ok ? '✓' : '✗'}` +
              `   ${id === type ? '(id==type here)' : ''}`);
  console.log(`       "${F1.decodeString(rom, id, { nl: ' ' }).slice(0, 78)}"`);
}
console.log(`\n${agree}/${rows.length} agree with the 4-byte record at 0x${F1.DIALOGUE_TABLE.toString(16)} byte 1`);
const idIsType = rows.filter(([ty, id]) => ty === id).length;
console.log(`${idIsType}/${rows.length} would also satisfy the RETRACTED dialogueId == objType rule`);
if (agree !== rows.length) process.exitCode = 1;
