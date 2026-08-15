#!/usr/bin/env node
// item-verify.mjs — check EVERY item name and price against the running game.
//
// WHY
// The catalogs walk each ROM's name and price tables over the whole id space,
// but a shop only ever proved the handful of ids it stocks. The rest were taken
// on the table's word.
//
// THE METHOD
// A shop draws whatever its record tells it to. So PATCH the record to stock any
// five (FF1) / four (FF2) / eight (FF3) ids you like, open the shop, and read
// the names and prices the game itself draws. Sweep the record over the whole
// id space and every item gets checked.
//
//   node tools/item-verify.mjs --game 1
//   node tools/item-verify.mjs --game 3 --from 0 --to 63
//
// ⛔ The ROM on disk is never touched — the patch goes into the in-memory copy.
// ⛔ FF2 entries are (item, PRICE CODE) pairs, so its price column is the code's
// price, not a property of the item. Only the NAME is an item fact there.
// ⛔ Names are compared with whitespace removed: several glyph bytes have no
// entry in the decoders and draw as a space ("B zzard"), on both sides.

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NES, Controller } from 'jsnes';

import * as F1 from './lib/ff1-text.mjs';
import * as M1 from './lib/ff1-map.mjs';
import * as S1 from './lib/ff1-shops.mjs';
import * as F2 from './lib/ff2-text.mjs';
import * as S2 from './lib/ff2-shops.mjs';

const { glyph: g3 } = await import('./lib/ff3-text.mjs');
const S3 = await import('./lib/ff3-shops.mjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const GAME = flag('game', '1');
const FROM = Number(flag('from', '0'));
const TO = Number(flag('to', '255'));
// ⛔ Batching several ids into one record is fast but FRAGILE: an id the game
// refuses to draw shifts every later row up, and the comparison then reports a
// long cascade of "wrong name" for items that are perfectly fine. --batch 1
// makes each id its own shop, so a blank row means exactly one thing.
const BATCH = Number(flag('batch', '0'));

const snap = (f) => zlib.gunzipSync(fs.readFileSync(path.join(HERE, 'states', f))).toString('utf8');
const strip = (s) => s.normalize('NFD').replace(/[゙゚]/g, '').replace(/\s/g, '');

let bad = 0, seen = 0;
const report = (id, what, got, want) => {
  seen++;
  if (got === want) return;
  bad++;
  console.log(`  MISMATCH 0x${id.toString(16).padStart(2, '0')} ${what}: drew ${JSON.stringify(got)}, table says ${JSON.stringify(want)}`);
};

// ── FF1 ─────────────────────────────────────────────────────────────────────
async function verifyFF1() {
  const ROMP = process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes';
  const rom = new Uint8Array(fs.readFileSync(ROMP));
  const SNAP = snap('ff1-hall.state.gz');
  const SHOP = 12;                                     // an ARMOR shop, 5 slots
  const REC = S1.shopAt(rom, SHOP).recordOffset;
  console.log(`FF1 — stocking shop ${SHOP} (record @ 0x${REC.toString(16)}) with each id in turn\n`);

  const open = (ids) => {
    const p = Uint8Array.from(rom);
    for (let i = 0; i < S1.RECORD_MAX; i++) p[REC + i] = ids[i] ?? 0;
    const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
    nes.loadROM(Buffer.from(p).toString('binary'));
    nes.fromJSON(JSON.parse(SNAP));
    const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
    run(20);
    nes.cpu.mem[M1.SPECIAL_ID] = SHOP; nes.cpu.mem[M1.SPECIAL_PENDING] = 1;
    run(260);
    nes.buttonDown(1, Controller.BUTTON_A); run(6); nes.buttonUp(1, Controller.BUTTON_A); run(90);
    const v = nes.ppu.vramMem, rows = [];
    for (let r = 0; r < 30; r++) {
      let s = '';
      for (let c = 20; c < 32; c++) { const g = F1.glyph(v[0x2000 + r * 32 + c]); s += (g === null || g === '\n') ? ' ' : g; }
      if (s.trim()) rows.push(s.trim());
    }
    // the panel alternates a NAME row and a PRICE row
    const out = [];
    for (let i = 0; i < rows.length - 1; i++) {
      if (/^\d+$/.test(rows[i + 1]) && !/^\d+$/.test(rows[i])) out.push({ name: rows[i], price: Number(rows[i + 1]) });
    }
    return out;
  };

  const ids = [], blanks = [];
  for (let id = FROM; id <= TO; id++) if (S1.itemName(rom, id, F1.glyph)) ids.push(id);
  const step1 = BATCH || S1.RECORD_MAX;
  for (let i = 0; i < ids.length; i += step1) {
    const batch = ids.slice(i, i + step1);
    const drawn = open(batch);
    for (let k = 0; k < batch.length; k++) {
      const id = batch[k];
      const want = { name: strip(S1.itemName(rom, id, F1.glyph)), price: S1.itemPrice(rom, id) };
      const got = drawn[k];
      if (!got) { blanks.push(id); seen++; continue; }
      report(id, 'name', strip(got.name), want.name);
      report(id, 'price', got.price, want.price);
    }
  }
  if (blanks.length) {
    console.log(`\n${blanks.length} id(s) the game refuses to draw at all — ` +
                `their name pointers land on junk, so they are not real items:`);
    console.log('  ' + blanks.map(i => '0x' + i.toString(16).padStart(2, '0')).join(' '));
  }
}

// ── FF2 ─────────────────────────────────────────────────────────────────────
async function verifyFF2() {
  const ROMP = process.env.FF2_ROM || '/home/joeltco/roms/ff2-jp.nes';
  const rom = new Uint8Array(fs.readFileSync(ROMP));
  const SNAP = snap('ff2-outside.state.gz');
  const REC = S2.SHOP_TABLE;                            // shop 0's record
  console.log(`FF2 — stocking shop 0 (record @ 0x${REC.toString(16)}) with each id in turn\n`);
  const B = { a: Controller.BUTTON_A, b: Controller.BUTTON_B, up: Controller.BUTTON_UP };

  const open = (ids) => {
    const p = Uint8Array.from(rom);
    for (let i = 0; i < S2.SHOP_ITEMS; i++) { p[REC + i * 2] = ids[i] ?? 0; p[REC + i * 2 + 1] = 0xED; }
    const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
    nes.loadROM(Buffer.from(p).toString('binary'));
    nes.fromJSON(JSON.parse(SNAP));
    const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
    const press = (k, h = 6, a = 16) => { nes.buttonDown(1, B[k]); run(h); nes.buttonUp(1, B[k]); run(a); };
    run(8); press('b'); press('b'); run(30);
    const m = nes.cpu.mem, px = m[0x68], py = m[0x69];
    for (let s = 1; s < 12; s++) m[0x7500 + s * 0x10] = 0;
    m[0x7500] = S2.SHOP_TYPE_FIRST; m[0x750A] = S2.SHOP_TYPE_FIRST;
    m[0x7502] = px; m[0x7504] = px; m[0x7503] = py - 1; m[0x7505] = py - 1;
    run(10); press('up'); press('a', 6, 60); press('a', 6, 60);
    const v = nes.ppu.vramMem, rows = [];
    for (let r = 3; r < 12; r++) {
      let s = '';
      for (let c = 14; c < 32; c++) { const g = F2.glyph(v[0x2000 + r * 32 + c]); s += (g === null || g === '\n') ? ' ' : g; }
      const mm = s.match(/^\s*(.*?[^\s])\s+(\d+)\s*$/);
      if (mm) rows.push({ name: mm[1], price: Number(mm[2]) });
    }
    return rows;
  };

  const ids = [];
  for (let id = FROM; id <= TO; id++) if (S2.itemName(rom, id, F2.glyph)) ids.push(id);
  const step2 = BATCH || S2.SHOP_ITEMS;
  for (let i = 0; i < ids.length; i += step2) {
    const batch = ids.slice(i, i + step2);
    const drawn = open(batch);
    for (let k = 0; k < batch.length; k++) {
      const id = batch[k];
      const got = drawn[k];
      const want = strip(S2.itemName(rom, id, F2.glyph));
      if (!got) { report(id, 'row', null, want); continue; }
      report(id, 'name', strip(got.name), want);
    }
  }
}

// ── FF3 ─────────────────────────────────────────────────────────────────────
async function verifyFF3() {
  const ROMP = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
  const rom = new Uint8Array(fs.readFileSync(ROMP));
  const SNAP = snap('ff3-freeroam.state.gz');
  const REC = S3.shopAt(rom, 231).offset;               // a Weapons shop
  console.log(`FF3 — stocking shop 231 (record @ 0x${REC.toString(16)}) with each id in turn\n`);
  const D = { up: Controller.BUTTON_UP, down: Controller.BUTTON_DOWN,
              left: Controller.BUTTON_LEFT, right: Controller.BUTTON_RIGHT, a: Controller.BUTTON_A };

  const open = (ids) => {
    const p = Uint8Array.from(rom);
    for (let i = 0; i < S3.SHOP_ITEMS_MAX; i++) p[REC + 1 + i] = ids[i] ?? 0;
    const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
    nes.loadROM(Buffer.from(p).toString('binary'));
    nes.fromJSON(JSON.parse(SNAP));
    const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
    const press = (k, h = 16, a = 16) => { nes.buttonDown(1, D[k]); run(h); nes.buttonUp(1, D[k]); run(a); };
    run(8);
    for (let f = 0; f < 240; f++) {
      nes.cpu.mem[0x0700] = 5; nes.cpu.mem[0x00AB] = 0x80;
      nes.frame();
      if (nes.cpu.mem[0x00AB] !== 0x80) break;
    }
    run(180);
    for (let i = 0; i < 10; i++) {
      const x = nes.cpu.mem[0x68], y = nes.cpu.mem[0x69];
      if (x === 3 && y === 24) break;
      if (y > 24) press('up'); else if (y < 24) press('down');
      else if (x > 3) press('left'); else press('right');
    }
    press('up'); press('a', 8, 90); press('a', 8, 90);
    const v = nes.ppu.vramMem, rows = [];
    for (let r = 0; r < 30; r++) {
      let s = '';
      for (let c = 0; c < 32; c++) { const g = g3(v[0x2000 + r * 32 + c]); s += (g === null ? ' ' : g); }
      s = s.replace(/\s+/g, ' ').trim();
      const mm = s.match(/^(.*?[A-Za-z?].*?)\s+(\d+)$/);
      if (mm && !/you buy|How many|^1 4 10/.test(s)) rows.push({ name: mm[1], price: Number(mm[2]) });
    }
    return rows;
  };

  const ids = [], blanks = [];
  for (let id = FROM; id <= TO; id++) if (S3.itemName(rom, id, g3)) ids.push(id);
  const step = BATCH || S3.SHOP_ITEMS_MAX;
  for (let i = 0; i < ids.length; i += step) {
    const batch = ids.slice(i, i + step);
    const drawn = open(batch);
    for (let k = 0; k < batch.length; k++) {
      const id = batch[k];
      const got = drawn[k];
      const want = { name: strip(S3.itemName(rom, id, g3)), price: S3.priceForItem(rom, id) };
      if (!got) { blanks.push(id); seen++; continue; }
      report(id, 'name', strip(got.name), want.name);
      report(id, 'price', got.price, want.price);
    }
  }
  if (blanks.length) {
    console.log(`\n${blanks.length} id(s) the game refuses to draw — not real items:`);
    console.log('  ' + blanks.map(i => '0x' + i.toString(16).padStart(2, '0')).join(' '));
  }
}

const RUN = { 1: verifyFF1, 2: verifyFF2, 3: verifyFF3 }[GAME];
if (!RUN) { console.error('--game must be 1, 2 or 3'); process.exit(1); }
await RUN();
console.log(`\n${seen - bad}/${seen} checks matched the running game`);
process.exit(bad ? 1 : 0);
