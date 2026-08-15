// nes-trace.mjs — watch what a running NES ROM actually reads, writes and runs.
//
// This is the machinery behind the talk-routine traces. It answers "which
// instruction touched this byte", which is the only reliable way to find a
// lookup rule in a ROM: every structural guess about tables has to be checked
// against the CPU eventually, so start there.
//
//   import { makeTracer } from './lib/nes-trace.mjs';
//   nes.fromJSON(state);                    // ⛔ BEFORE makeTracer — see below
//   const t = makeTracer(nes);
//   t.onRead  = (addr, val, pc) => { ... };
//   t.onWrite = (addr, val, pc) => { ... };
//   t.recording = true;
//   ...run frames...
//   t.history(40)                            // the last 40 instructions
//
// ⛔ TRAP 1 — `nes.fromJSON` REPLACES `nes.cpu` with a NEW object. A tracer
// built before the load (or any cached `cpu` reference) hooks a DISCARDED CPU:
// no hook ever fires and RAM reads come back as garbage. `makeTracer` binds
// `nes.cpu` at call time, so build it AFTER every fromJSON.
//
// ⛔ TRAP 2 — the ring buffer wraps FAST. ~9,900 instructions execute per
// frame, so a 65,536-entry ring covers under 7 frames. If you want the
// instructions BEFORE an event, stop recording AT the event (`t.recording =
// false` inside the hook) or the window is overwritten by whatever ran after.
//
// ⛔ TRAP 3 — jsnes' `REG_PC` is the address of the LAST byte consumed, so the
// PC reported during an instruction is the byte AFTER it: a 2-byte
// `LDA ($80),Y` at $EAA3 reports $EAA5. Subtract the length to get the start.
//
// Note `Mapper1.load` (and Mapper4) return `cpu.mem[address]` for $8000-$FFFF,
// so the currently-mapped PRG is readable directly as `nes.cpu.mem[addr]`,
// unshifted. `bankAt` below identifies which PRG bank is in a window by
// comparing bytes, which never lies about the mapper state.

/**
 * Attach read/write/instruction hooks to a running NES.
 *
 * @param {object} nes            a jsnes NES, already loaded AND state-restored
 * @param {object} [opts]
 * @param {number} [opts.ringSize] instruction history depth (power of two)
 */
export function makeTracer(nes, { ringSize = 1 << 16 } = {}) {
  const cpu = nes.cpu;                 // bound AFTER fromJSON — see TRAP 1
  const pcRing = new Int32Array(ringSize);
  const aRing = new Int32Array(ringSize);
  const xRing = new Int32Array(ringSize);
  const yRing = new Int32Array(ringSize);
  let ri = 0;

  const t = {
    recording: false,
    /** called for every CARTRIDGE read while recording: (addr, val, pc) */
    onRead: null,
    /**
     * called for EVERY read, including internal RAM below $2000.
     *
     * ⛔ `onRead` only sees cartridge space — jsnes serves `addr < 0x2000` from
     * `cpu.mem` without going through `loadFromCartridge`. Anything that reads a
     * table in zero page or the $0200-$07FF range (FF1's tile properties at
     * $0400, for one) is INVISIBLE to `onRead`, and sampling that table later
     * from RAM gives stale values because the region is reused.
     */
    onAnyRead: null,
    /** called for every write while recording: (addr, val, pc) */
    onWrite: null,
    /** current instruction address (see TRAP 3 — this is the byte AFTER) */
    pc: () => (cpu.REG_PC + 1) & 0xFFFF,
    get index() { return ri; },
    /** the last `n` executed instructions, oldest first */
    history(n = 64, from = ri) {
      const out = [];
      for (let i = n; i > 0; i--) {
        const k = (from - i + ringSize) % ringSize;
        if (pcRing[k]) out.push({ pc: pcRing[k], a: aRing[k], x: xRing[k], y: yRing[k] });
      }
      return out;
    },
  };

  const origEmu = cpu.emulate.bind(cpu);
  cpu.emulate = function () {
    if (t.recording) {
      pcRing[ri] = (cpu.REG_PC + 1) & 0xFFFF;
      aRing[ri] = cpu.REG_ACC; xRing[ri] = cpu.REG_X; yRing[ri] = cpu.REG_Y;
      ri = (ri + 1) % ringSize;
    }
    return origEmu();
  };

  const origLoad = cpu.loadFromCartridge.bind(cpu);
  cpu.loadFromCartridge = function (addr) {
    const v = origLoad(addr);
    if (t.recording && t.onRead) t.onRead(addr, v, t.pc());
    return v;
  };

  // full read hook — only installed when someone asks, since it fires on every
  // operand fetch and is markedly slower than the cartridge-only path
  const origAny = cpu.load.bind(cpu);
  cpu.load = function (addr) {
    const v = origAny(addr);
    if (t.recording && t.onAnyRead) t.onAnyRead(addr, v, t.pc());
    return v;
  };

  const origWrite = cpu.write.bind(cpu);
  cpu.write = function (addr, val) {
    if (t.recording && t.onWrite) t.onWrite(addr, val, t.pc());
    return origWrite(addr, val);
  };

  return t;
}

/**
 * Which PRG bank is mapped into the window at `base`?
 *
 * Compares the mapped bytes against every bank in the file. Mapper registers
 * are not always readable (and MMC1's shadow state is easy to misread), but
 * the bytes in `cpu.mem` are what the CPU will actually fetch.
 *
 * @returns {number} bank index, or -1 if nothing matches (e.g. RAM window)
 */
export function bankAt(nes, rom, base, bankSize = 0x4000, probe = 32) {
  const banks = (rom.length - 0x10) / bankSize;
  for (let b = 0; b < banks; b++) {
    const off = 0x10 + b * bankSize;
    let ok = true;
    for (let i = 0; i < probe; i++) if (rom[off + i] !== nes.cpu.mem[base + i]) { ok = false; break; }
    if (ok) return b;
  }
  return -1;
}

/** Group recorded hits by the instruction that caused them, busiest first. */
export function groupByPc(hits) {
  const by = new Map();
  for (const h of hits) {
    if (!by.has(h.pc)) by.set(h.pc, []);
    by.get(h.pc).push(h);
  }
  return [...by].sort((a, b) => b[1].length - a[1].length);
}

export const hex = (v, n = 4) => '$' + v.toString(16).toUpperCase().padStart(n, '0');
