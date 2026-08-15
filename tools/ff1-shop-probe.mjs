#!/usr/bin/env node
// ff1-shop-probe.mjs — open any FF1 shop and read its stock off the screen.
//
// WHY
// The inventory tables are decoded (`lib/ff1-shops.mjs`), but a decoded table is
// a claim until the shop it describes draws the same thing. This opens the real
// shop, walks into its Buy list, and prints what the game put on screen next to
// what the table predicts.
//
//   node tools/ff1-shop-probe.mjs --id 12
//   node tools/ff1-shop-probe.mjs --id 12 --keys a          # into the Buy list
//   node tools/ff1-shop-probe.mjs --all                     # every shop, compared
//
// ⛔ The shop needs ~260 frames to fade in; the CPU sits in the wait-for-NMI
// spin at $FEBB meanwhile and that is NOT a hang.
// ⛔ Names on screen are TRUNCATED to the panel width ("Wooden" is both Wooden
// Armor and Wooden Shield), so screen text confirms the COUNT and the PRICES,
// which are unambiguous — it cannot by itself confirm which item an id is.
//
// ⛔ The three kinds do NOT admit the same check, and pretending they do reads
// as 20 failures when nothing is wrong:
//   WEAPON/ARMOR/ITEM/OASIS  the Buy list is the table, in order -> exact match
//   WMAGIC/BMAGIC            the shop only offers spells the chosen character
//                            can actually learn, so a low-level party is shown
//                            a SUBSET (often none). Every price drawn must be in
//                            the table; the reverse is not required. Rows also
//                            carry the spell LEVEL, so only numbers >= 100 are
//                            prices.
//   INN/CLINIC               the price is never drawn on this screen. It is
//                            confirmed instead by $AAA0 LDA $0300 / LDA $0301
//                            feeding the number printer, caught live.

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NES, Controller } from 'jsnes';
import * as F1 from './lib/ff1-text.mjs';
import * as M from './lib/ff1-map.mjs';
import * as S from './lib/ff1-shops.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const ID = flag('id', null);
const KEYS = flag('keys', '').split(',').filter(Boolean);
const ALL = args.includes('--all');
const ROMP = process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes';

const rom = new Uint8Array(fs.readFileSync(ROMP));
const romBin = fs.readFileSync(ROMP, 'binary');
const SNAP = zlib.gunzipSync(
  fs.readFileSync(path.join(HERE, 'states', 'ff1-hall.state.gz'))).toString('utf8');

const B = { a: Controller.BUTTON_A, b: Controller.BUTTON_B,
            up: Controller.BUTTON_UP, down: Controller.BUTTON_DOWN };

/** Open shop `id`, press `keys`, and hand back the machine. */
function open(id, keys = []) {
  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(romBin);
  nes.fromJSON(JSON.parse(SNAP));
  for (let i = 0; i < 20; i++) nes.frame();
  nes.cpu.mem[M.SPECIAL_ID] = id;
  nes.cpu.mem[M.SPECIAL_PENDING] = 1;
  for (let i = 0; i < 260; i++) nes.frame();
  for (const k of keys) {
    // ⛔ `!B[k]` would reject A — jsnes numbers BUTTON_A as 0.
    if (B[k] === undefined) { console.error(`unknown key "${k}"`); process.exit(1); }
    nes.buttonDown(1, B[k]); for (let i = 0; i < 6; i++) nes.frame();
    nes.buttonUp(1, B[k]); for (let i = 0; i < 90; i++) nes.frame();
  }
  return nes;
}

/** The visible nametable as text — tile index IS the char code by draw time. */
function screen(nes) {
  const v = nes.ppu.vramMem;
  const out = [];
  for (let r = 0; r < 30; r++) {
    let s = '';
    for (let c = 0; c < 32; c++) {
      const g = F1.glyph(v[0x2000 + r * 32 + c]);
      s += (g === null || g === '\n') ? ' ' : g;
    }
    if (s.trim()) out.push(String(r).padStart(2) + '|' + s + '|');
  }
  return out;
}

/** The prices the shop drew, in order — these are unambiguous. */
function pricesOnScreen(nes) {
  const nums = [];
  for (const line of screen(nes)) {
    for (const m of line.matchAll(/(?<!\d)(\d{1,5})(?!\d)/g)) {
      // the row label ("14|") is not part of the panel
      if (line.indexOf(m[0]) > 3) nums.push(Number(m[1]));
    }
  }
  return nums;
}

if (ALL) {
  console.log('every shop: the table vs what the shop draws\n');
  console.log('id  kind    table                              screen prices');
  let mismatch = 0;
  for (let id = 1; id <= M.SPECIAL_ID_MAX; id++) {
    const entry = S.shopAt(rom, id, F1.glyph);
    const magic = entry.kind === 'WMAGIC' || entry.kind === 'BMAGIC';
    if (S.PRICE_KINDS.has(entry.kind)) {
      console.log(`${String(id).padStart(2)}  ${entry.kind.padEnd(6)}  ` +
                  `${String(entry.price).padEnd(34)} (price is not drawn — see header)`);
      continue;
    }
    const nes = open(id, magic ? ['a', 'a'] : ['a']);
    const seen = pricesOnScreen(nes).filter(n => n !== 400);   // 400 G = party gil
    const want = entry.items.map(i => i.price);
    const ok = magic
      ? seen.filter(n => n >= 100).every(n => want.includes(n))
      : JSON.stringify(want) === JSON.stringify(seen.slice(0, want.length));
    if (!ok) mismatch++;
    const note = magic ? `  (subset: ${seen.filter(n => n >= 100).length} of ${want.length} offered)` : '';
    console.log(`${String(id).padStart(2)}  ${entry.kind.padEnd(6)}  ` +
                `${JSON.stringify(want).padEnd(34)} ${JSON.stringify(seen)}` +
                `${ok ? note : '  <-- MISMATCH'}`);
  }
  console.log(`\n${mismatch} mismatch(es)`);
  process.exit(mismatch ? 1 : 0);
}

if (ID === null) { console.error('give --id N or --all'); process.exit(1); }
const id = Number(ID);
const entry = S.shopAt(rom, id, F1.glyph);
console.log(`FF1 shop ${id} — ${entry.kind}`);
console.log(`  record @ file 0x${entry.recordOffset.toString(16)}: ` +
            `[${entry.raw.map(v => v.toString(16).padStart(2, '0')).join(' ')}]`);
if (S.PRICE_KINDS.has(entry.kind)) console.log(`  price: ${entry.price} G`);
else for (const it of entry.items) {
  console.log(`  0x${it.id.toString(16).padStart(2, '0')}  ${(it.name || '?').padEnd(10)} ${String(it.price).padStart(6)} G`);
}
const nes = open(id, KEYS);
console.log('\nscreen:');
for (const l of screen(nes)) console.log('  ' + l);
console.log(`\n$0300-$0305 = ` +
  [...nes.cpu.mem.slice(0x300, 0x306)].map(v => v.toString(16).padStart(2, '0')).join(' ') +
  `   $66 (kind) = ${nes.cpu.mem[0x66]}`);
