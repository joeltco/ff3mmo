#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// ⛔⛔⛔  DO NOT HALF-ASS THE DATA PULL.  ⛔⛔⛔
//
// A ROM record has N FIELDS. If you use fewer than N, YOU HAVE NOT READ IT —
// you have guessed while holding the answer. This banner exists because that
// happened over and over in one day:
//
//   * FF3's NPC record is {id, x, y, FLAGS}. The flags byte was DISASSEMBLED
//     (bits 2-3 = FACING, bits 4-7 = MOVEMENT) and then DROPPED on the floor,
//     so ten Ur townsfolk shipped frozen in "random spots" facing wrong.
//   * Cid took THREE releases and Joel pointing at the tile — while
//     `npc-dump.mjs 12` had printed `id $2c @(6,23) ... DRAWN` the whole time.
//   * `$67` was called the "black magic sign" without checking its ATTRIBUTE
//     palette. It is the same star on pal1, the TREE/WOOD palette. Green
//     corners shipped.
//   * Characters were identified from `npcId + 0x202` instead of by RENDERING
//     THE SPRITE — which put Cid's line on the Castle Sasune gate guard.
//   * `check-shops` asked `findShopAtCounter` for the shop's OWN coords, so it
//     agreed with itself wherever the counter pointed.
//   * "0 of 28 bundles match" was a `+0x10` applied twice. SELF-TEST THE
//     INSTRUMENT BEFORE BELIEVING A NEGATIVE.
//
// BEFORE YOU SAY "DONE", ANSWER THIS OUT LOUD:
//   List every field/byte/column of the record you just read. Point at the line
//   of code that CONSUMES each one. If any field is unconsumed, you are NOT
//   done — wire it or say plainly which one you dropped and why.
//
// AND: RENDER IT AND LOOK. `map-png --grid --box`, `tileset-sheet.mjs`,
// `npc-sheet-ff3.mjs`, `npc-cast.cjs`. "The code looks right" is not a check.
// ═══════════════════════════════════════════════════════════════════════════
// event-flags.mjs — FF3's story-flag encoding, decoded, plus who sets and tests each flag.
//
// ── THE ENCODING ────────────────────────────────────────────────────────────
// A story flag is ONE BYTE, id 0-127, living in battery-backed save RAM:
//
//     address = $6020 + (id >> 3)        bit = 1 << (id & 7)
//
// Two independent implementations in the ROM agree on this for all 128 ids:
//
//   * the CONDITION evaluator computes it arithmetically — bank $3C $9344:
//       AND #$7F / AND #$07 / TAY / LDA $935A,Y   ; mask table 01 02 04 08 10 20 40 80
//       PLA / LSR A x3 / TAY / LDA $6020,Y / AND $80
//   * the SETTER looks it up — bank 59 $B983 (= $9983 in the $8000 window):
//       LDA $BBD2,Y  ; bitmask for flag Y
//       LDA $BCD2,Y  ; byte offset for flag Y
//       ORA / STA $6020,Y
//
// ── CONDITION RECORDS (bank $3C $931B) ──────────────────────────────────────
// A record is condition bytes until $FF, then one RESULT byte (the script index).
// In a condition byte, **bit 7 is POLARITY**: set = "this flag must be SET",
// clear = "this flag must be CLEAR". The low 7 bits are the flag id. All
// conditions in a record must hold or the record is skipped.
//
// ── EVENT OPCODES (jump table bank 59 $B617, opcode = $E4 + index) ───────────
//     $F0  show NPC dialogue by slot ($0740,X)      $F1  show message by id
//     $F2  SET FLAG    (operand = flag id)          $F3  CLEAR FLAG
//     $F8  sound/music (writes $7F42 / $7F43)       $F9  exit to world
//     $FA  go to map                                $FE  wait   $FF/$FD end
//
// ⭐ VERIFIED LIVE: booting the real ROM and watching SRAM, the flags set during
// the opening are 126, 44, 0 IN THAT ORDER — exactly the $F2 operands of script
// 48, at the predicted addresses and bits. (126 is cleared again later.)
//
//   node tools/event-flags.mjs              # summary + opcode/flag reference
//   node tools/event-flags.mjs 0            # everything about flag 0
//
import fs from 'node:fs';

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));
const MAP_PROPS_BASE = 0x004010, PTR_BANK = 0x2C, DATA_BANK = 0x2D;
const SCRIPT_TABLE = 0x8600, COND_TABLE = 0x8880;
const bankOff = (b, a) => b * 0x2000 + 0x10 + (a >= 0xA000 ? a - 0xA000 : a - 0x8000);
const b59 = (a) => 16 + 59 * 0x2000 + (a >= 0xA000 ? a - 0xA000 : a - 0x8000);

export const flagAddr = (id) => 0x6020 + (id >> 3);
export const flagMask = (id) => 1 << (id & 7);

/** Cross-check the ROM's own setter tables against the arithmetic rule. */
export function verifyTables() {
  let bad = 0;
  for (let i = 0; i < 128; i++) {
    if (rom[b59(0xBBD2) + i] !== flagMask(i) || rom[b59(0xBCD2) + i] !== (i >> 3)) bad++;
  }
  return { checked: 128, bad };
}

function script(r) {
  const p = bankOff(PTR_BANK, SCRIPT_TABLE) + r * 2;
  const ptr = rom[p] | (rom[p + 1] << 8);
  if (ptr < 0xA000 || ptr >= 0xC000) return null;
  let o = bankOff(DATA_BANK, ptr); const ops = [];
  for (let n = 0; n < 64; n++) {
    const op = rom[o];
    let len; if (op === 0xFE) len = 2; else if (op < 0xE4) len = 1; else if (op <= 0xFC) len = 2; else len = 1;
    ops.push({ op, operand: len === 2 ? rom[o + 1] : null });
    o += len;
    if (op === 0xFF || op === 0xFD) break;
  }
  return { r, ptr, ops };
}
function eventIdBlock(mapId) {
  const idx = rom[MAP_PROPS_BASE + mapId * 16 + 15];
  const base = (idx < 0x80) ? 0xA200 : 0xA300;
  const off = bankOff(0x10, base) + ((idx * 2) & 0xFF);
  const ptr = rom[off] | (rom[off + 1] << 8);
  if (ptr < 0x8000 || ptr >= 0xC000) return null;
  const bo = (ptr < 0xA000) ? 0x10 * 0x2000 + 0x10 + (ptr - 0x8000) : 0x11 * 0x2000 + 0x10 + (ptr - 0xA000);
  return Array.from(rom.slice(bo, bo + 16));
}
function records(eventId) {
  const p = bankOff(PTR_BANK, COND_TABLE) + eventId * 2;
  const ptr = rom[p] | (rom[p + 1] << 8);
  if (ptr < 0xA000 || ptr >= 0xC000) return [];
  const b = Array.from(rom.slice(bankOff(DATA_BANK, ptr), bankOff(DATA_BANK, ptr) + 64));
  const out = []; let i = 0;
  while (i < b.length && out.length < 16) {
    const c = [];
    while (i < b.length && b[i] !== 0xFF) { c.push(b[i]); i++; }
    if (i >= b.length) break; i++;
    if (i >= b.length) break;
    out.push({ conds: c, result: b[i] }); i++;
    if (!c.length) break;
  }
  return out;
}

/** For each flag: which scripts set/clear it, and which conditions test it. */
export function flagIndex() {
  const idx = new Map();
  const get = (id) => { if (!idx.has(id)) idx.set(id, { setBy: [], clearedBy: [], testedBy: [] }); return idx.get(id); };
  for (let r = 0; r < 512; r++) {
    const s = script(r); if (!s) continue;
    for (const o of s.ops) {
      if (o.op === 0xF2 && o.operand !== null) get(o.operand).setBy.push(r);
      if (o.op === 0xF3 && o.operand !== null) get(o.operand).clearedBy.push(r);
    }
  }
  for (let map = 0; map < 512; map++) {
    const ids = eventIdBlock(map); if (!ids) continue;
    ids.forEach((eid, trig) => {
      for (const rec of records(eid)) for (const c of rec.conds) {
        get(c & 0x7F).testedBy.push({ map, trig, wantSet: !!(c & 0x80), result: rec.result });
      }
    });
  }
  return idx;
}

const arg = process.argv[2];
const v = verifyTables();
console.log(`setter tables vs (id>>3, 1<<(id&7)): ${v.checked - v.bad}/${v.checked} ${v.bad ? '⛔' : '✅'}`);
const idx = flagIndex();
if (arg === undefined) {
  const used = [...idx].filter(([, d]) => d.setBy.length || d.testedBy.length);
  console.log(`\nflags referenced anywhere: ${used.length} of 128`);
  console.log('\nid   addr/bit      setBy scripts        testedBy (map,trig) count');
  for (const [id, d] of used.sort((a, b) => a[0] - b[0])) {
    console.log(`${String(id).padStart(3)}  $${flagAddr(id).toString(16)} bit${id & 7}   ` +
      `${(d.setBy.join(',') || '-').padEnd(18)}  ${d.testedBy.length}`);
  }
} else {
  const id = parseInt(arg, 10);
  const d = idx.get(id) || { setBy: [], clearedBy: [], testedBy: [] };
  console.log(`\nflag ${id} -> $${flagAddr(id).toString(16)} bit ${id & 7} (mask $${flagMask(id).toString(16)})`);
  console.log(`  set by scripts   : ${d.setBy.join(', ') || 'NONE'}`);
  console.log(`  cleared by       : ${d.clearedBy.join(', ') || 'none'}`);
  console.log(`  tested by        : ${d.testedBy.length} condition(s)`);
  for (const t of d.testedBy.slice(0, 20)) {
    console.log(`     map ${String(t.map).padStart(3)} trig ${String(t.trig).padStart(2)}  requires ${t.wantSet ? 'SET  ' : 'CLEAR'} -> script ${t.result}`);
  }
}
