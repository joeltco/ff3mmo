#!/usr/bin/env node
// check-ff2-shops.mjs — FF2's shop tables stay decoded.
//
// Each constant in `lib/ff2-shops.mjs` is a claim about a specific instruction,
// so this compares it against the bytes at the address it cites. Then it opens
// four real shops and checks the names and prices the game DRAWS.
//
//   node tools/check-ff2-shops.mjs
//
// ⛔ Expectations are literal opcodes written out by hand from the listing.
// ⛔ The shop-object range is measured, not assumed: it is re-checked live by
// talking to 192 (a shop), 191 (the last dialogue type) and 222 (the inn).

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NES, Controller } from 'jsnes';
import * as F2 from './lib/ff2-text.mjs';
import * as S from './lib/ff2-shops.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROMP = process.env.FF2_ROM || '/home/joeltco/roms/ff2-jp.nes';
const rom = new Uint8Array(fs.readFileSync(ROMP));
const romBin = fs.readFileSync(ROMP, 'binary');
const SNAP = zlib.gunzipSync(
  fs.readFileSync(path.join(HERE, 'states', 'ff2-outside.state.gz'))).toString('utf8');

const bankOf = (n, a) => 0x10 + n * 0x4000 + (a - 0x8000);
const fixedOf = (a) => 0x10 + ((rom.length - 0x10) / 0x4000 - 1) * 0x4000 + (a - 0xC000);

let fails = 0, checks = 0;
function eq(what, got, want) {
  checks++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { fails++; console.log(`  FAIL  ${what}\n          got ${g}  want ${w}`); }
  else console.log(`  ok    ${what}`);
}
const instr = (off, want, what) => eq(what, [...rom.slice(off, off + want.length)], want);
const b14 = (a, want, what) => instr(bankOf(14, a), want, `$${a.toString(16).toUpperCase()}  ${what}`);
const fixed = (a, want, what) => instr(fixedOf(a), want, `$${a.toString(16).toUpperCase()}  ${what}`);

console.log('FF2 shop tables — the constants vs the instructions they claim\n');

console.log('the shop record load ($8E9B, bank 14)');
b14(0x8E9B, [0x0A, 0x0A, 0x0A], 'ASL A x3         — index * 8 = SHOP_STRIDE');
eq('SHOP_STRIDE is 8', S.SHOP_STRIDE, 8);
b14(0x8E9E, [0x18, 0x6D, 0x80, 0x83], 'CLC / ADC $8380  — the table base pointer');
eq('SHOP_TABLE_PTR is $8380 in bank 14', S.SHOP_TABLE_PTR, bankOf(14, 0x8380));
const basePtr = rom[S.SHOP_TABLE_PTR] | (rom[S.SHOP_TABLE_PTR + 1] << 8);
eq('...and it holds $860D', basePtr, 0x860D);
eq('SHOP_TABLE is that pointer in bank 14', S.SHOP_TABLE, bankOf(14, basePtr));
b14(0x8EAB, [0xA0, S.SHOP_COPY_LEN - 1], 'LDY #$0F         — SHOP_COPY_LEN bytes');
b14(0x8EAD, [0xB1, 0x80, 0x99, 0x00, 0x7B], 'LDA ($80),Y / STA $7B00,Y');
eq('SHOP_RAM is $7B00', S.SHOP_RAM, 0x7B00);
// ⛔ the copy is longer than the stride, so a shop's window holds the NEXT
// shop's record too. Only the first SHOP_STRIDE bytes are its own.
eq('the copy overruns the stride (that is why only 4 items are the shop\'s)',
   S.SHOP_COPY_LEN > S.SHOP_STRIDE, true);
eq('4 items of 2 bytes fill the stride', S.SHOP_ITEMS * 2, S.SHOP_STRIDE);

console.log('\nthe object-type classifier ($CBD5, fixed bank)');
fixed(0xCBD5, [0xA5, 0xA0], 'LDA $A0          — the object type');
fixed(0xCBD7, [0xC9, 0x60], 'CMP #$60         — HI_TABLE_FIRST');
fixed(0xCBDB, [0xC9, S.SHOP_TYPE_FIRST], 'CMP #$C0         — SHOP_TYPE_FIRST');
eq('SHOP_TYPE_FIRST is ff2-text\'s NO_HANDLER_FIRST', S.SHOP_TYPE_FIRST, F2.NO_HANDLER_FIRST);
eq('28 shops', S.SHOP_COUNT, 28);

console.log('\nthe tables resolve');
eq('PRICE_TABLE is $8000 in bank 14', S.PRICE_TABLE, bankOf(14, 0x8000));
eq('NAME_PTR_TABLE is $8200 in bank 10', S.NAME_PTR_TABLE, bankOf(10, 0x8200));
// A price code is not a price: the SAME code must give the SAME price for two
// items that are not the same item. 0xF2 is Axe and Mace, both 500 G.
eq('code 0xF2 is 500 G', S.priceForCode(rom, 0xF2), 500);
eq('code 0xE6 is 20 G', S.priceForCode(rom, 0xE6), 20);
eq('code 0xE4 is 40000 G', S.priceForCode(rom, 0xE4), 40000);
const s0 = S.shopAt(rom, 0, F2.glyph);
eq('shop 0 stocks 4 items', s0.items.length, 4);
eq('shop 0 item 0 is 0x3A at 150 G', [s0.items[0].id, s0.items[0].price], [0x3A, 150]);

// ── live ────────────────────────────────────────────────────────────────────
const OBJ_RAM = 0x7500, O_LIVE = 0, O_X = 2, O_Y = 3, O_X2 = 4, O_Y2 = 5, O_TYPE = 0x0A;
const B = { a: Controller.BUTTON_A, b: Controller.BUTTON_B, up: Controller.BUTTON_UP };
const strip = (s) => s.normalize('NFD').replace(/[゙゚]/g, '');

function talk(type, extraA) {
  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(romBin);
  nes.fromJSON(JSON.parse(SNAP));
  const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
  const press = (k, h = 6, a = 16) => {
    nes.buttonDown(1, B[k]); run(h); nes.buttonUp(1, B[k]); run(a);
  };
  run(8); press('b'); press('b'); run(30);
  const m = nes.cpu.mem, px = m[0x68], py = m[0x69];
  for (let s = 1; s < 12; s++) m[OBJ_RAM + s * 0x10 + O_LIVE] = 0;
  m[OBJ_RAM + O_LIVE] = type; m[OBJ_RAM + O_TYPE] = type;
  m[OBJ_RAM + O_X] = px; m[OBJ_RAM + O_X2] = px;
  m[OBJ_RAM + O_Y] = py - 1; m[OBJ_RAM + O_Y2] = py - 1;
  run(10); press('up'); press('a', 6, 60);
  if (extraA) press('a', 6, 60);
  const v = nes.ppu.vramMem, rows = [], full = [];
  for (let r = 0; r < 30; r++) {
    let panel = '', whole = '';
    for (let c = 0; c < 32; c++) {
      const g = F2.glyph(v[0x2000 + r * 32 + c]);
      const ch = (g === null || g === '\n') ? ' ' : g;
      whole += ch;
      if (c >= 14) panel += ch;
    }
    // ⛔ the item panel is rows 3-11 / columns 14+, but the かう/うる MENU is
    // bottom-left. A window that only covers the panel reports every shop as
    // "not a shop".
    if (r >= 3 && r < 12 && panel.trim()) rows.push(strip(panel).trim());
    if (whole.trim()) full.push(strip(whole).trim());
  }
  return { rows, full, ram: [...nes.cpu.mem.slice(S.SHOP_RAM, S.SHOP_RAM + S.SHOP_STRIDE)] };
}

console.log('\nfour shops, opened for real');
for (const idx of [0, 8, 16, 27]) {
  const e = S.shopAt(rom, idx, F2.glyph);
  const { rows, ram } = talk(e.objType, true);
  eq(`shop ${String(idx).padStart(2)} loads its record into $7B00`, ram, e.raw);
  const drawn = rows.map(r => r.match(/^(.*?)\s+(\d+)\s*$/)).filter(Boolean)
    .map(m => ({ name: strip(m[1]).trim(), price: Number(m[2]) }));
  eq(`shop ${String(idx).padStart(2)} draws the table's prices`,
     drawn.map(d => d.price), e.items.map(i => i.price));
  eq(`shop ${String(idx).padStart(2)} draws the table's names`,
     drawn.map(d => d.name), e.items.map(i => strip(i.name)));
}

console.log('\nthe shop range itself, re-measured');
{
  // 192 opens a shop; 191 is still dialogue; 222 is the inn, not a shop.
  const shopish = (r) => r.full.some(l => /かう/.test(l)) && r.full.some(l => /うる/.test(l));
  eq('type 192 opens a shop', shopish(talk(S.SHOP_TYPE_FIRST, false)), true);
  eq('type 191 does NOT', shopish(talk(S.SHOP_TYPE_FIRST - 1, false)), false);
  const innR = talk(0xDE, false);
  const inn = innR.full.join(' ');
  eq('type 0xDE is the inn, not a shop', /とまり/.test(inn) && !shopish(innR), true);
  eq('...and the table says so', S.SPECIAL_TYPES[0xDE], 'INN');
}

// ── FF2's monster NAME table ────────────────────────────────────────────────
// ⛔ Not pinned to an instruction (FF2's battle code is not traced). Confirmed
// instead by the four monster-GUARD object types, which name their monster and
// then start the fight — four samples spread across the table, each agreeing
// with the guard's own dialogue.
console.log('\nmonster names, confirmed by the guards that summon them');
{
  const MN = await import('./lib/ff2-monsters.mjs');
  eq('128 names decode', MN.allMonsters(rom, F2.glyph).length, MN.NAME_COUNT);
  eq('the table ends with the four final bosses',
     MN.allMonsters(rom, F2.glyph).slice(-4).map(m => m.name),
     ['ティアマット', 'ベルゼブル', 'アスタロート', 'こうてい']);
  for (const c of MN.CONFIRMED) {
    eq(`index ${c.id} is ${c.name}`, MN.monsterName(rom, c.id, F2.glyph), c.name);
    const r = talk(c.type, false);
    const hay = r.full.map(l => l.replace(/\s/g, '')).join('|');
    eq(`...and guard type ${c.type} names it in its dialogue`,
       hay.includes(strip(c.name)), true);
  }
}

console.log(`\n${checks - fails}/${checks} checks passed`);
if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
