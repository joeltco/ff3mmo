#!/usr/bin/env node
// event-resolve.mjs — walk the FULL event chain for a map's event tiles, from
// the ROM, and report what each one would DO.
//
// Chain (each step disassembled, see tools/event-dump.mjs for the citations):
//
//   tile $60-$63 on the map          collision byte2 = $F0 -> handler type 15
//   3F/$E6BE                         LDA $45 / AND #$0F      -> trigId
//                                    LDA $0720,X             -> EVENT ID
//   $0720 block                      per-map, selected by map property byte 15
//                                    ($078F): idx*2 into a pointer table in
//                                    bank $10 — $A200 for idx < $80, $A300 for
//                                    idx >= $80
//   bank $2C $8880 + id*2            -> condition-script pointer (data in $2D)
//   3C/$931B                         evaluate records: condition bytes until
//                                    $FF, then one RESULT byte -> $6C
//   bank $2C $8600 + result*2        -> the actual opcode script
//   3E/$D21D                         interpreter. Operand length by RANGE:
//                                    $FE = 2 bytes (WAIT), < $E4 = 1 byte,
//                                    $E4-$FC = 2 bytes, >= $FD = 1 byte
//
// Opcodes that move the player (from the $B617 jump table):
//   $F9  EXIT TO WORLD   (LDA $71 / STA $0730, $AB = $C0)
//   $FA  GO TO MAP       (operand -> $0700, $AB = $80)
//
//   node tools/event-resolve.mjs 180        # every event tile on map 180
//   node tools/event-resolve.mjs 180 --raw  # + raw script bytes

import fs from 'node:fs';

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));

const MAP_PROPS_BASE = 0x004010;
const BANK10_BASE    = 0x020010;   // bank $10 at NES $A000
const PTR_BANK       = 0x2C;
const DATA_BANK      = 0x2D;
const COND_TABLE     = 0x8880;     // condition-script pointers, bank $2C
const SCRIPT_TABLE   = 0x8600;     // opcode-script pointers, bank $2C

const bankOff = (bank, addr) =>
  bank * 0x2000 + 0x10 + (addr >= 0xA000 ? addr - 0xA000 : addr - 0x8000);
const hex2 = v => v.toString(16).toUpperCase().padStart(2, '0');
const hex4 = v => v.toString(16).toUpperCase().padStart(4, '0');

const { loadMap } = await import('../src/map-loader.js');

/** Map property byte 15 — the index into the per-map event-id pointer table. */
function eventTableIndex(mapId) {
  return rom[MAP_PROPS_BASE + mapId * 16 + 15];
}

/** The 16-byte block the ROM copies to $0720: event id per trigId. */
function eventIdBlock(mapId) {
  const idx = eventTableIndex(mapId);
  // idx*2, carry picks the table: $A200 for idx < $80, $A300 for idx >= $80.
  const base = (idx < 0x80) ? 0xA200 : 0xA300;
  const off  = bankOff(0x10, base) + ((idx * 2) & 0xFF);
  const ptr  = rom[off] | (rom[off + 1] << 8);
  // `$FF03` maps bank A at $8000 AND A+1 at $A000, so a pointer read out of
  // this table can legitimately land in EITHER window. The observed values are
  // $89xx — the $8000 window of bank $10 — not $Axxx.
  if (ptr < 0x8000 || ptr >= 0xC000) return { idx, ptr, ids: null };
  const blockOff = (ptr < 0xA000)
    ? 0x10 * 0x2000 + 0x10 + (ptr - 0x8000)      // bank $10 @ $8000
    : 0x11 * 0x2000 + 0x10 + (ptr - 0xA000);     // bank $11 @ $A000
  return { idx, ptr, ids: Array.from(rom.slice(blockOff, blockOff + 16)) };
}

/** Condition script for an event id -> the RESULT byte the evaluator stores. */
function evalConditions(eventId) {
  const pOff = bankOff(PTR_BANK, COND_TABLE) + eventId * 2;
  const ptr = rom[pOff] | (rom[pOff + 1] << 8);
  if (ptr < 0xA000 || ptr >= 0xC000) return { ptr, result: null, records: [] };
  const b = Array.from(rom.slice(bankOff(DATA_BANK, ptr), bankOff(DATA_BANK, ptr) + 64));
  const records = [];
  let i = 0;
  while (i < b.length && records.length < 16) {
    const conds = [];
    while (i < b.length && b[i] !== 0xFF) { conds.push(b[i]); i++; }
    if (i >= b.length) break;
    i++;
    if (i >= b.length) break;
    records.push({ conds, result: b[i] });
    i++;
    if (!conds.length) break;      // terminator record
  }
  // With no story flags set, every conditional record fails and the first
  // UNCONDITIONAL record wins. That is the fresh-save path, which is the one
  // that matters for "can a new player get out of this map".
  const uncond = records.find(r => r.conds.length === 0);
  return { ptr, result: uncond ? uncond.result : (records[0]?.result ?? null), records };
}

/** Decode the opcode script for a result code. */
function script(result) {
  const pOff = bankOff(PTR_BANK, SCRIPT_TABLE) + result * 2;
  const ptr = rom[pOff] | (rom[pOff + 1] << 8);
  if (ptr < 0xA000 || ptr >= 0xC000) return { ptr, ops: null };
  let off = bankOff(DATA_BANK, ptr);
  const ops = [];
  for (let n = 0; n < 64; n++) {
    const op = rom[off];
    let len;
    if (op === 0xFE) len = 2;
    else if (op < 0xE4) len = 1;
    else if (op <= 0xFC) len = 2;
    else len = 1;                       // >= $FD
    const operand = len === 2 ? rom[off + 1] : null;
    ops.push({ at: off, op, operand });
    off += len;
    if (op === 0xFF || op === 0xFD) break;   // terminators
    if (ops.length >= 64) break;
  }
  return { ptr, ops };
}

const NAMED = new Map([
  [0xF9, 'EXIT TO WORLD'],
  [0xFA, 'GO TO MAP'],
  [0xFE, 'WAIT'],
  [0xFF, 'END'],
  [0xFD, 'END/RET'],
]);

const mapId = parseInt(process.argv[2], 10);
const RAW = process.argv.includes('--raw');
const md = loadMap(rom, mapId);

const blk = eventIdBlock(mapId);
console.log(`map ${mapId}: event-table idx = $${hex2(blk.idx)}  ->  $0720 block ptr $${hex4(blk.ptr)}`);
if (!blk.ids) { console.log('  (pointer out of bank $10 range — no event block)'); process.exit(1); }
console.log(`  event ids by trigId: ${blk.ids.map(hex2).join(' ')}\n`);

const evTiles = [];
for (const [key, t] of (md.triggerMap || [])) {
  if (t.type !== 0) continue;          // type 0 = event tile ($60-$63)
  const [x, y] = key.split(',').map(Number);
  evTiles.push({ x, y, trigId: t.trigId });
}
if (!evTiles.length) { console.log('no event tiles on this map'); process.exit(0); }

for (const t of evTiles) {
  const eventId = blk.ids[t.trigId];
  console.log(`event tile (${t.x},${t.y})  trigId ${t.trigId}  ->  event id $${hex2(eventId)}`);
  const cond = evalConditions(eventId);
  console.log(`  condition script $${hex4(cond.ptr)}  ${cond.records.length} record(s), fresh-save result = ` +
    (cond.result == null ? 'NONE' : '$' + hex2(cond.result)));
  if (cond.result == null) { console.log('  (no result — nothing to run)\n'); continue; }
  const sc = script(cond.result);
  console.log(`  opcode script  $${hex4(sc.ptr)}`);
  if (!sc.ops) { console.log('  (pointer out of range)\n'); continue; }
  for (const o of sc.ops) {
    const name = NAMED.get(o.op) || '';
    const operand = o.operand != null ? ` $${hex2(o.operand)}` : '';
    console.log(`    $${hex2(o.op)}${operand.padEnd(4)}  ${name}`);
  }
  const move = sc.ops.find(o => o.op === 0xF9 || o.op === 0xFA);
  if (move) {
    console.log(`  => MOVES THE PLAYER: ${NAMED.get(move.op)}` +
      (move.op === 0xFA ? ` to map ${move.operand}` : ' (back to the overworld)'));
  } else {
    console.log('  => no map transition in this script');
  }
  if (RAW) console.log('  raw: ' + sc.ops.map(o => hex2(o.op) + (o.operand != null ? ' ' + hex2(o.operand) : '')).join(' | '));
  console.log('');
}
