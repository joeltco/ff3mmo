#!/usr/bin/env node
// check-ff1-shops.mjs — FF1's shop tables stay decoded.
//
// Every constant in `lib/ff1-shops.mjs` is a claim about a specific instruction,
// so this compares each one against the bytes at the address it cites. Then it
// opens four real shops and checks the prices the game DRAWS against the prices
// the table predicts, because a table that survives a byte check can still be
// pointing at the wrong thing.
//
//   node tools/check-ff1-shops.mjs
//
// ⛔ Expectations are literal opcodes written out by hand from the listing.
// Never derive one from the value under test.
// ⛔ INN/CLINIC prices are NOT checked against the screen — the shop does not
// draw them at that point. They are pinned to $AAA0/$AAA5 instead, and the INN
// path is additionally caught reading the record live.

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NES, Controller } from 'jsnes';
import { makeTracer } from './lib/nes-trace.mjs';
import * as F1 from './lib/ff1-text.mjs';
import * as M from './lib/ff1-map.mjs';
import * as S from './lib/ff1-shops.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROMP = process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes';
const rom = new Uint8Array(fs.readFileSync(ROMP));
const romBin = fs.readFileSync(ROMP, 'binary');
const SNAP = zlib.gunzipSync(
  fs.readFileSync(path.join(HERE, 'states', 'ff1-hall.state.gz'))).toString('utf8');

const BANKS = (rom.length - 0x10) / 0x4000;
const fixedOf = (a) => 0x10 + (BANKS - 1) * 0x4000 + (a - 0xC000);
const bankOf = (n, a) => 0x10 + n * 0x4000 + (a - 0x8000);

let fails = 0, checks = 0;
function eq(what, got, want) {
  checks++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { fails++; console.log(`  FAIL  ${what}\n          got ${g}  want ${w}`); }
  else console.log(`  ok    ${what}`);
}
const instr = (off, want, what) =>
  eq(what, [...rom.slice(off, off + want.length)], want);
const fixed = (a, want, what) => instr(fixedOf(a), want, `$${a.toString(16).toUpperCase()}  ${what}`);
const b14 = (a, want, what) => instr(bankOf(14, a), want, `$${a.toString(16).toUpperCase()}  ${what} (bank 14)`);

console.log('FF1 shop tables — the constants vs the instructions they claim\n');

console.log('shop id -> KIND');
fixed(0xEB47, [0xA6, M.SPECIAL_ID], 'LDX $51');
fixed(0xEB49, [0xBD, 0xB5, 0xEB], 'LDA $EBB5,X      — the kind table');
eq('KIND_TABLE is $EBB5 in the fixed bank', S.KIND_TABLE, fixedOf(0xEBB5));
fixed(0xEB4C, [0x29, S.KIND_MASK], 'AND #$07         — KIND_MASK');
eq('eight kinds fit in KIND_MASK', S.KINDS.length, S.KIND_MASK + 1);

console.log('\nshop id -> RECORD');
b14(0xA7D1, [0xA5, M.SPECIAL_ID], 'LDA $51');
b14(0xA7D3, [0x0A, 0xAA], 'ASL A / TAX      — two bytes per entry');
b14(0xA7D5, [0xBD, 0x00, 0x83], 'LDA $8300,X      — the pointer table');
eq('SHOP_PTR_TABLE is $8300 in bank 14', S.SHOP_PTR_TABLE, bankOf(14, 0x8300));
b14(0xA7DF, [0xA0, S.RECORD_MAX - 1], 'LDY #$04         — RECORD_MAX bytes copied');
b14(0xA7E9, [0xA9, 0x00, 0x8D, 0x05, 0x03], 'LDA #$00 / STA $0305 — forced terminator');
b14(0xA85F, [0xBD, 0x00, 0x03], 'LDA $0300,X      — walking the record');
b14(0xA862, [0xF0, 0x2D], 'BEQ +            — 00 ENDS the list');
b14(0xA88D, [0xC9, S.RECORD_MAX], 'CMP #$05         — RECORD_MAX');

console.log('\nitem id -> PRICE');
fixed(0xECB9, [0x0A, 0x85, 0x12], 'ASL A / STA $12  — id*2 is the low byte');
// ⛔ the base is NOT written as #$BC anywhere — it is #$5E rolled left, which is
// also how ids >= $80 reach $BD00 for free.
fixed(0xECBC, [0xA9, 0x5E], 'LDA #$5E         — half the table page');
fixed(0xECBE, [0x2A, 0x85, 0x13], 'ROL A / STA $13  — ...doubled into $BC');
eq('PRICE_TABLE is $BC00 in bank 13', S.PRICE_TABLE, bankOf(13, (0x5E << 1) << 8));
fixed(0xECC8, [0xB1, 0x12], 'LDA ($12),Y      — the price is read indirect');

console.log('\nitem id -> NAME');
fixed(0xE004, [0x0A, 0xAA], 'ASL A / TAX      — two bytes per entry');
fixed(0xE006, [0xB0, 0x0B], 'BCS +            — ids >= $80 take the other table');
fixed(0xE008, [0xBD, 0x00, 0xB7], 'LDA $B700,X      — the name pointer table');
fixed(0xE013, [0xBD, 0x00, 0xB8], 'LDA $B800,X      — ...and its second page');
eq('NAME_PTR_TABLE is $B700 in bank 10', S.NAME_PTR_TABLE, bankOf(10, 0xB700));
eq('the two name pages are contiguous', bankOf(10, 0xB800) - bankOf(10, 0xB700), 0x100);
fixed(0xDE47, [0xB1, 0x3E], 'LDA ($3E),Y      — the name printer');
fixed(0xDE49, [0xF0, 0xDE], 'BEQ -            — names are 00-terminated');

console.log('\nINN / CLINIC record is a 16-bit PRICE, not a list');
b14(0xAAA0, [0xAD, 0x00, 0x03, 0x85, 0x10], 'LDA $0300 / STA $10');
b14(0xAAA5, [0xAD, 0x01, 0x03, 0x85, 0x11], 'LDA $0301 / STA $11  — high byte');
b14(0xAAAA, [0xA9, 0x00, 0x85, 0x12], 'LDA #$00 / STA $12   — 24-bit, then printed');

console.log('\nthe kind table agrees with the bands measured by opening every id');
let bandsOk = true;
for (let id = 0; id <= M.SPECIAL_ID_MAX; id++) {
  if (S.KINDS[rom[S.KIND_TABLE + id] & S.KIND_MASK] !== M.specialKind(id)) bandsOk = false;
}
eq('every id 0..70 agrees between ff1-map and the ROM table', bandsOk, true);

// ⛔ Without these, dropping a kind from PRICE_KINDS goes unnoticed: a clinic's
// record then reads as a one-item buy list ([0x28] for id 41) and every other
// check still passes.
console.log('\nthe price kinds stock nothing');
eq('clinic 41 is a 16-bit price, not a list',
   [S.shopAt(rom, 41).price, S.shopAt(rom, 41).items.length], [40, 0]);
eq('inn 51 is a 16-bit price, not a list',
   [S.shopAt(rom, 51).price, S.shopAt(rom, 51).items.length], [30, 0]);
eq('no INN or CLINIC anywhere stocks an item',
   S.allShops(rom).filter(s => S.PRICE_KINDS.has(s.kind) && s.items.length).length, 0);
eq('...and both price kinds are still price kinds',
   [...S.PRICE_KINDS].sort(), ['CLINIC', 'INN']);

console.log('\nunused slots');
const shops = S.allShops(rom, F1.glyph);
const unused = shops.filter(s => s.unused).map(s => s.id);
eq('the unused ids are the tails of the bands', unused,
   [7, 8, 9, 10, 17, 18, 19, 20, 47, 48, 49, 50, 58, 59, 60, 67, 68, 69]);
eq('the filler record starts with 00, so its list is empty',
   rom[S.bank14(S.FILLER_PTR)], 0);
eq('52 shops are in use', shops.length - unused.length, 52);

// ── live: what the shop actually draws ───────────────────────────────────────
console.log('\nfour shops, opened for real (screen prices vs the table)');
function open(id, keys) {
  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(romBin);
  nes.fromJSON(JSON.parse(SNAP));
  for (let i = 0; i < 20; i++) nes.frame();
  nes.cpu.mem[M.SPECIAL_ID] = id;
  nes.cpu.mem[M.SPECIAL_PENDING] = 1;
  for (let i = 0; i < 260; i++) nes.frame();
  for (const k of keys) {
    nes.buttonDown(1, k); for (let i = 0; i < 6; i++) nes.frame();
    nes.buttonUp(1, k); for (let i = 0; i < 90; i++) nes.frame();
  }
  return nes;
}
function pricesOnScreen(nes) {
  const v = nes.ppu.vramMem, nums = [];
  for (let r = 0; r < 30; r++) {
    let s = '';
    for (let c = 0; c < 32; c++) {
      const g = F1.glyph(v[0x2000 + r * 32 + c]);
      s += (g === null || g === '\n') ? ' ' : g;
    }
    for (const m of s.matchAll(/(?<!\d)(\d{1,5})(?!\d)/g)) nums.push(Number(m[1]));
  }
  return nums.filter(n => n !== 400);          // 400 G is the party's gil
}
for (const id of [1, 12, 63, 70]) {
  const e = S.shopAt(rom, id, F1.glyph);
  const seen = pricesOnScreen(open(id, [Controller.BUTTON_A]));
  const want = e.items.map(i => i.price);
  eq(`shop ${String(id).padStart(2)} (${e.kind}) draws ${JSON.stringify(want)}`,
     seen.slice(0, want.length), want);
}

console.log('\nthe INN reads its price out of the record, live');
{
  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(romBin);
  nes.fromJSON(JSON.parse(SNAP));
  for (let i = 0; i < 20; i++) nes.frame();
  nes.cpu.mem[M.SPECIAL_ID] = 51;
  nes.cpu.mem[M.SPECIAL_PENDING] = 1;
  const t = makeTracer(nes);
  const got = [];
  t.onAnyRead = (a, v, pc) => {
    if ((pc === 0xAAA3 && a === 0x300) || (pc === 0xAAA8 && a === 0x301)) got.push(v);
  };
  t.recording = true;
  for (let i = 0; i < 260; i++) nes.frame();
  nes.buttonDown(1, Controller.BUTTON_A); for (let i = 0; i < 6; i++) nes.frame();
  nes.buttonUp(1, Controller.BUTTON_A); for (let i = 0; i < 120; i++) nes.frame();
  t.recording = false;
  eq('inn 51 reads its record bytes at $AAA3/$AAA8',
     got.slice(0, 2), S.shopAt(rom, 51).raw.slice(0, 2));
  eq('...which is the price the table reports', S.shopAt(rom, 51).price, 30);
}

console.log(`\n${checks - fails}/${checks} checks passed`);
if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
