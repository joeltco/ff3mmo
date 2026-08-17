#!/usr/bin/env node
// ff2-goto.mjs — warp FF2 to any location id, the way `ff1-goto` does for FF1.
//
// WHY
// Everything FF2-side in this repo has been blocked behind movement: the party in
// `ff2-outside.state.gz` walks in place and produced no encounter in 3000 steps,
// boot-driving drifts, and the warp-table hunt found only NPC records. So the map
// was never reachable — and without a map, no encounter table can be measured.
//
// WHAT THE ROM SAYS (bank 15, the fixed $C000 bank — read, not guessed):
//
//   $D341  LDA #$00 / JSR $FE03      ; bank 0 into the $8000 window
//   $D346  LDX $48                   ; ⭐ X = the CURRENT LOCATION ID
//   $D348  LDA $B200,X               ; ⭐ -> the location's TILEMAP id
//   $D34C  ASL/ROL/AND #$01/ORA #$04 ; tilemap bit 7 picks bank 4 or 5
//   $D356  ASL A / TAX
//   $D358  LDA $8000,X / LDA $8001,X ; a 2-byte pointer to the compressed tilemap
//   $D366  LDA #$74 / STA $83        ; decompress to $7400
//   $D36A  JSR $D38F                 ; the decompressor
//   $D372  JMP $9C00                 ; enter the map
//
// ⛔ TWO TRAPS THAT COST AN HOUR HERE, both of which make the routine look inert:
//   1. `m6502.mjs#listing` labels each line with the FILE offset, NOT the CPU
//      address. Copying those labels put every address 0x11 too high. The mapping
//      for this bank is `cpu = file - 0x30010`; the live bytes are the arbiter.
//   2. Setting `REG_PC` and then calling `nes.frame()` does NOT run the routine —
//      an NMI fires within a few instructions and the handler drops the injected
//      PC on the floor (the trace goes $D341 -> $0100 -> the game loop). Step
//      `cpu.emulate()` directly so no NMI is ever dispatched.
//
// So a warp is: poke `$48`, then enter the loader at `$D351`. The routine lives in
// the fixed bank, so it is callable whatever is paged in.
//
//   node tools/ff2-goto.mjs --loc 0x5C
//   node tools/ff2-goto.mjs --sweep 0x50 0x68 --out /tmp/ff2
//   node tools/ff2-goto.mjs --prove          # ⭐ the table-patch proof, see below
//
// ⛔ HOW THIS IS PROVEN. "$48 holds the location id" is not a finding — an address
// that HOLDS a value is not shown to BE it. Two things are checked instead:
//   1. changing `$48` changes the DECOMPRESSED MAP at $7400 (it moves);
//   2. ⭐ patching the table entry for one location to another's tilemap id makes
//      that location decompress to the OTHER location's map, byte for byte. Only a
//      genuine location->tilemap table can do that. `--prove` runs it and exits
//      nonzero on failure.

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { NES } from 'jsnes';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const has = (n) => args.includes('--' + n);

const ROM = process.env.FF2_ROM || '/home/joeltco/roms/ff2-jp.nes';
const STATE = flag('state', path.join(HERE, 'states', 'ff2-outside.state.gz'));

/** The decoded chain. Kept here until a check pins it; then it moves to lib/. */
export const LOC_ID_ZP = 0x48;           // zero page: the current location id
export const LOC_TILEMAP_TABLE = 0x3210; // file offset; CPU $B200 in bank 0
export const LOC_LOADER_PC = 0xD341;     // bank 15, the fixed $C000 bank
export const LOC_TABLE_READ_PC = 0xD348; // the LDA $B200,X itself
export const LOC_LOADER_DONE_PC = 0xD372; // the JMP $9C00 that ends it
export const MAP_RAM = 0x7400, MAP_RAM_LEN = 0x400;

const rom = new Uint8Array(fs.readFileSync(ROM));
const SNAP = zlib.gunzipSync(fs.readFileSync(STATE)).toString('utf8');
const hx = (v, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');

/**
 * Warp a fresh machine to `loc` and return what the game decompressed.
 * `patch` is an optional {fileOffset: byte} applied to the ROM first.
 */
function warp(loc, { patch = null, frames = 24 } = {}) {
  const r = patch ? Uint8Array.from(rom) : rom;
  if (patch) for (const [off, val] of Object.entries(patch)) r[Number(off)] = val;

  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(Buffer.from(r).toString('binary'));
  nes.fromJSON(JSON.parse(SNAP));          // ⛔ this REPLACES nes.cpu
  nes.frame();

  const cpu = nes.cpu;
  cpu.mem[LOC_ID_ZP] = loc & 0xFF;
  // ⛔ jsnes keeps REG_PC one byte BEFORE the next opcode.
  cpu.REG_PC = LOC_LOADER_PC - 1;

  // ⛔ step the CPU directly — nes.frame() lets an NMI eat the injected PC.
  let steps = 0, readTable = false, done = false, gotTilemap = null;
  for (; steps < 2_000_000; steps++) {
    const pc = (cpu.REG_PC + 1) & 0xFFFF;
    if (pc === LOC_TABLE_READ_PC) readTable = true;
    if (pc === LOC_TABLE_READ_PC + 3 && gotTilemap === null) gotTilemap = cpu.REG_ACC;
    if (pc === LOC_LOADER_DONE_PC) { done = true; break; }
    cpu.emulate();
  }

  const map = Buffer.from(cpu.mem.slice(MAP_RAM, MAP_RAM + MAP_RAM_LEN));
  return {
    loc, steps, done, readTable,
    /** what the CPU actually loaded out of the table, not what we read from the file */
    tilemapLive: gotTilemap,
    tilemap: r[LOC_TILEMAP_TABLE + loc],
    hash: crypto.createHash('sha1').update(map).digest('hex').slice(0, 12),
    nonzero: map.filter(b => b !== 0).length,
    nes,
  };
}

// ── the proof ───────────────────────────────────────────────────────────────
if (has('prove')) {
  console.log('FF2 location loader — proving the table, not just reading it\n');
  let bad = 0, n = 0;
  const ok = (label, cond, detail) => {
    n++; if (!cond) bad++;
    console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  };

  // TCRF's two documented pairs, used only as the starting anchors.
  const A = 0x5C, B = 0x60;
  const a = warp(A), b = warp(B);
  for (const r of [a, b])
    console.log(`  loc ${hx(r.loc)} -> tilemap ${hx(r.tilemap)} (CPU loaded ${hx(r.tilemapLive ?? 0)})  ` +
                `map ${r.hash} (${r.nonzero} nonzero, ${r.steps} steps, done=${r.done})`);
  console.log('');

  // ⛔ the routine must actually RUN — every earlier attempt failed silently here.
  ok('the loader ran to its own exit', a.done && b.done);
  ok('the CPU really read the table', a.readTable && b.readTable);
  ok('the byte the CPU loaded is the byte at the table offset',
     a.tilemapLive === a.tilemap && b.tilemapLive === b.tilemap);
  ok('the loader actually decompressed something', a.nonzero > 64 && b.nonzero > 64);
  ok('two different locations give two different maps', a.hash !== b.hash);
  ok('the table says 2E for loc 5C and 30 for loc 60', a.tilemap === 0x2E && b.tilemap === 0x30);

  // ⭐ THE PROOF. Repoint loc A's entry at loc B's tilemap. If $B200 really is the
  // location->tilemap table, loc A must now load B's map byte for byte.
  const patched = warp(A, { patch: { [LOC_TILEMAP_TABLE + A]: b.tilemap } });
  ok('repointing loc 5C\'s entry at tilemap 30 loads loc 60\'s MAP EXACTLY',
     patched.hash === b.hash, `${a.hash} -> ${patched.hash} (want ${b.hash})`);
  // ...and the reverse, so the pass cannot come from both maps being identical.
  const back = warp(B, { patch: { [LOC_TILEMAP_TABLE + B]: a.tilemap } });
  ok('...and repointing loc 60 at tilemap 2E loads loc 5C\'s map',
     back.hash === a.hash, `${b.hash} -> ${back.hash} (want ${a.hash})`);

  // ⛔ the revert: an UNPATCHED run must NOT match, or the test proves nothing.
  ok('the unpatched runs still differ (the proof can fail)', a.hash !== b.hash);

  // ⭐ TCRF claims tilemap 2F is referenced by no location. That is now testable
  // against the ROM itself rather than taken on faith.
  const used2F = [];
  for (let i = 0; i < 0x100; i++) if (rom[LOC_TILEMAP_TABLE + i] === 0x2F) used2F.push(i);
  ok('tilemap 2F is referenced by no location (TCRF, now ROM-checked)',
     used2F.length === 0, used2F.length ? `used by ${used2F.map(v => hx(v)).join(',')}` : 'unreferenced');

  console.log(`\n${n - bad}/${n} checks passed`);
  process.exit(bad ? 1 : 0);
}

// ── sweep / single ──────────────────────────────────────────────────────────
const sweep = has('sweep');
const list = sweep
  ? (() => { const i = args.indexOf('--sweep'); const lo = Number(args[i + 1]), hi = Number(args[i + 2]);
             return Array.from({ length: hi - lo }, (_, k) => lo + k); })()
  : [Number(flag('loc', '0x5C'))];

const seen = new Map();
for (const loc of list) {
  const r = warp(loc);
  const dup = seen.get(r.hash);
  seen.set(r.hash, r.loc);
  console.log(`  loc ${hx(loc)} -> tilemap ${hx(r.tilemap)}  map ${r.hash}  ` +
              `${String(r.nonzero).padStart(4)} nonzero${dup !== undefined ? `  (same map as loc ${hx(dup)})` : ''}`);
}
console.log(`\n${list.length} locations, ${seen.size} distinct maps`);
