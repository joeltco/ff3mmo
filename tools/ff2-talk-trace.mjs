#!/usr/bin/env node
// ff2-talk-trace.mjs — catch FF2's talk routine in the act of looking up a
// string, and report the instruction that does it.
//
// WHY
// `tools/ff2-talk-probe.mjs` proved `dialogueId == objType` false but could not
// say what the real rule is: two measured pairs still leave six candidate byte
// tables. Guessing more tables is the wrong move. Watch the CPU instead.
//
// THE HOOK
// jsnes' Mapper1.load returns `cpu.mem[address]` for $8000-$FFFF, so the mapped
// PRG is readable with no shift, and every cartridge read funnels through
// `cpu.loadFromCartridge`. Wrapping it gives (PC, address, value) for every ROM
// byte the game touches. Wrapping `cpu.emulate` gives the executed PC stream.
//
// THE TARGET
// Minwu is object type 8 in the Altair throne room and displays string 49.
// String 49's pointer lives at file 0x18072 — bank 6, offset 0x62 — so when
// bank 6 is mapped at $8000 the game MUST read $8062/$8063. Catching that read
// identifies the lookup instruction, and the index register at that moment is
// the id the game actually computed.
//
//   node tools/ff2-talk-trace.mjs --state ff2-town.state --npc 5,19
//   node tools/ff2-talk-trace.mjs --state ff2-town.state --npc 5,19 --depth 400
//
// ⛔ jsnes' REG_PC is the address of the LAST byte consumed, so the printed
// address is the byte AFTER the instruction: a 2-byte `LDA ($80),Y` at $EAA3
// prints as $EAA5. Subtract the instruction length to get its start.

import fs from 'node:fs';
import { NES, Controller } from 'jsnes';

const F2 = await import('./lib/ff2-text.mjs');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const STATE = flag('state', null);
const NPC = (flag('npc', '5,19')).split(',').map(Number);
const DEPTH = parseInt(flag('depth', '260'), 10);
const ROMP = process.env.FF2_ROM || '/home/joeltco/roms/ff2-jp.nes';

const PLAYER_X = 0x68, PLAYER_Y = 0x69;
const BANK_SIZE = 0x4000;

const rom = new Uint8Array(fs.readFileSync(ROMP));
const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
nes.loadROM(fs.readFileSync(ROMP, 'binary'));

const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
const BTN = {
  a: Controller.BUTTON_A, b: Controller.BUTTON_B, up: Controller.BUTTON_UP,
  down: Controller.BUTTON_DOWN, left: Controller.BUTTON_LEFT, right: Controller.BUTTON_RIGHT,
};
const press = (k, hold = 6, after = 14) => {
  nes.buttonDown(1, BTN[k]); run(hold); nes.buttonUp(1, BTN[k]); run(after);
};
const at = () => [nes.cpu.mem[PLAYER_X], nes.cpu.mem[PLAYER_Y]];

if (!STATE) { console.error('--state is required'); process.exit(1); }
nes.fromJSON(JSON.parse(fs.readFileSync(STATE, 'utf8')));

// ⛔ `nes.fromJSON` REPLACES `nes.cpu` with a NEW object. Binding `cpu` (or
// installing the hooks below) before this line silently traces a discarded
// CPU: coordinates read 255 and not one hook ever fires.
const cpu = nes.cpu;

run(8); press('b'); press('b'); run(40);

/** Walk to (tx,ty), alternating axes so a wall on one still routes. */
function goTo(tx, ty, tries = 80) {
  for (let i = 0; i < tries; i++) {
    const [x, y] = at();
    if (x === tx && y === ty) return true;
    if (x !== tx && (i % 2 === 0 || y === ty)) press(x < tx ? 'right' : 'left');
    else if (y !== ty) press(y < ty ? 'down' : 'up');
    else return false;
  }
  const [x, y] = at();
  return x === tx && y === ty;
}

const [nx, ny] = NPC;
if (!goTo(nx, ny + 1)) { console.error(`could not reach (${nx},${ny + 1})`); process.exit(1); }
press('up');   // face the NPC; its tile is solid so this only turns us
console.log(`standing at ${at()} facing up at the NPC on (${nx},${ny})\n`);

// ── which PRG bank is currently at $8000? ────────────────────────────────
// Compare the mapped window against every bank; MMC1 has no register we can
// read that is guaranteed to be the whole story, but the bytes never lie.
function bankAt(base) {
  for (let b = 0; b < (rom.length - 0x10) / BANK_SIZE; b++) {
    const off = 0x10 + b * BANK_SIZE;
    let ok = true;
    for (let i = 0; i < 32; i++) if (rom[off + i] !== cpu.mem[base + i]) { ok = false; break; }
    if (ok) return b;
  }
  return -1;
}

// ── record ───────────────────────────────────────────────────────────────
const RING = 1 << 16;
const pcRing = new Int32Array(RING);
const aRing = new Int32Array(RING);
const xRing = new Int32Array(RING);
const yRing = new Int32Array(RING);
let ri = 0, recording = false;

const reads = [];       // interesting cartridge reads, in order
let readSeq = 0;

const origEmu = cpu.emulate.bind(cpu);
cpu.emulate = function () {
  if (recording) {
    // ⛔ REG_PC is the last byte consumed; the instruction starts at +1.
    pcRing[ri] = (cpu.REG_PC + 1) & 0xFFFF;
    aRing[ri] = cpu.REG_ACC; xRing[ri] = cpu.REG_X; yRing[ri] = cpu.REG_Y;
    ri = (ri + 1) % RING;
  }
  return origEmu();
};

// MEASURED: string 49's pointer is at file 0x18072 = $8062 with bank 6 mapped.
const WANT_ID = parseInt(flag('id', '49'), 10);
const WANT_ADDR = 0x8000 + WANT_ID * 2;
let stopRi = -1;

const origLoad = cpu.loadFromCartridge.bind(cpu);
cpu.loadFromCartridge = function (addr) {
  const v = origLoad(addr);
  // ⛔ STOP AT THE HIT. ~9900 instructions run per frame and the ring holds
  // 65536, so letting the talk finish overwrites the window seven times over
  // and the "instructions before the lookup" are all post-talk idle loop.
  if (recording && addr === WANT_ADDR) { stopRi = ri; recording = false; }
  // The pointer tables all sit at the very bottom of their bank, so a read in
  // the first 1KB of a switchable window is a table lookup candidate.
  if (recording && ((addr >= 0x8000 && addr < 0x8400) || (addr >= 0xA000 && addr < 0xA400))) {
    reads.push({ seq: readSeq++, pc: (cpu.REG_PC + 1) & 0xFFFF, addr, v,
                 a: cpu.REG_ACC, x: cpu.REG_X, y: cpu.REG_Y, ri });
  }
  return v;
};

// $92 holds the STRING ID for the fetch routine at $EA8C
//   LDA $92 / ASL A / ADC $94 / ... / LDA ($80),Y
// so the instruction that writes $92 is the objType -> id mapping itself.
const WATCH = (flag('zp', '92,93,94,95')).split(',').map(h => parseInt(h, 16));
const zpWrites = [];
const origWrite = cpu.write.bind(cpu);
cpu.write = function (addr, val) {
  if (recording && WATCH.includes(addr)) {
    zpWrites.push({ pc: (cpu.REG_PC + 1) & 0xFFFF, addr, val,
                    a: cpu.REG_ACC, x: cpu.REG_X, y: cpu.REG_Y });
  }
  return origWrite(addr, val);
};

recording = true;
press('a'); run(26);
recording = false;

console.log(`── writes to zero page ${WATCH.map(w => '$' + w.toString(16)).join(' ')} during the talk ──`);
for (const w of zpWrites) {
  console.log(`  $${w.pc.toString(16).toUpperCase().padStart(4, '0')}  ` +
              `$${w.addr.toString(16)} = ${w.val} (0x${w.val.toString(16)})   ` +
              `A=${w.a} X=${w.x} Y=${w.y}`);
}
console.log('');

// ── what did it fetch? ───────────────────────────────────────────────────
console.log(`bank at $8000 now: ${bankAt(0x8000)}   bank at $A000: ${bankAt(0xA000)}`);
console.log(`${reads.length} reads in a table window during the talk\n`);

// Group by the instruction that did the reading — a table lookup shows up as
// one PC hit many times with a moving address.
const byPc = new Map();
for (const r of reads) {
  if (!byPc.has(r.pc)) byPc.set(r.pc, []);
  byPc.get(r.pc).push(r);
}
console.log('── reads grouped by instruction ──');
for (const [pc, rs] of [...byPc].sort((a, b) => b[1].length - a[1].length).slice(0, 14)) {
  const addrs = [...new Set(rs.map(r => r.addr))];
  console.log(`  $${pc.toString(16).toUpperCase().padStart(4, '0')}  ${String(rs.length).padStart(3)} read(s)  ` +
    `addr ${addrs.slice(0, 6).map(a => '$' + a.toString(16)).join(' ')}${addrs.length > 6 ? ' …' : ''}` +
    `   Y=${[...new Set(rs.map(r => r.y))].slice(0, 6).join(',')}` +
    `   X=${[...new Set(rs.map(r => r.x))].slice(0, 6).join(',')}`);
}

// ── the pointer we are hunting ───────────────────────────────────────────
// String 49 of the 0x18010 table lives at 0x19278, i.e. $9268 with bank 6 in
// the $8000 window, so its pointer bytes are 68 92 stored at $8062/$8063.
const pOff = 0x18010 + WANT_ID * 2;
const want = { lo: rom[pOff], hi: rom[pOff + 1], addr: 0x8000 + WANT_ID * 2 };
console.log(`\n── hunting the read of string ${WANT_ID}'s pointer ──`);
console.log(`  file 0x${pOff.toString(16)} holds ${want.lo.toString(16)} ${want.hi.toString(16)}` +
            `  -> expect a read of $${want.addr.toString(16)} returning 0x${want.lo.toString(16)}`);
const hit = reads.filter(r => r.addr === want.addr || r.addr === want.addr + 1);
if (!hit.length) {
  console.log('  NOT SEEN — the table is not read through that window during the talk.');
} else {
  for (const h of hit) {
    console.log(`  ✓ $${h.pc.toString(16).toUpperCase()} read $${h.addr.toString(16)} = 0x${h.v.toString(16)}` +
                `   A=${h.a} X=${h.x} Y=${h.y}`);
  }
  // the instruction stream around the first hit is the routine we want
  const start = ((stopRi >= 0 ? stopRi : hit[0].ri) - DEPTH + RING) % RING;
  const seen = [];
  for (let i = 0; i < DEPTH; i++) {
    const k = (start + i) % RING;
    if (pcRing[k]) seen.push({ pc: pcRing[k], a: aRing[k], x: xRing[k], y: yRing[k] });
  }
  fs.writeFileSync('/tmp/ff2-talk-pcs.json', JSON.stringify(seen));
  const uniq = [...new Set(seen.map(s => s.pc))].sort((a, b) => a - b);
  console.log(`\n  ${seen.length} instructions before it, ${uniq.length} distinct addresses`);
  console.log(`  span $${uniq[0].toString(16).toUpperCase()}-$${uniq[uniq.length - 1].toString(16).toUpperCase()}` +
              `   (full stream -> /tmp/ff2-talk-pcs.json)`);
  console.log('\n── the last 40 instructions before the lookup ──');
  for (const s of seen.slice(-40)) {
    console.log(`  $${s.pc.toString(16).toUpperCase().padStart(4, '0')}  A=${String(s.a).padStart(3)} X=${String(s.x).padStart(3)} Y=${String(s.y).padStart(3)}`);
  }
}
