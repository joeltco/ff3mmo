#!/usr/bin/env node
// ff2-shop-probe.mjs — open every FF2 shop and check it against the table.
//
// The tables in `lib/ff2-shops.mjs` are a claim until the shop they describe
// draws the same four items. This stands each shop object next to the party,
// opens its Buy list, and compares the names and prices on screen.
//
//   node tools/ff2-shop-probe.mjs --state s.state --index 0
//   node tools/ff2-shop-probe.mjs --state s.state --all
//
// ⛔ Poke the object into RAM at $7500 — patching the ROM's object table does
// nothing once a savestate has the map loaded, and BOTH +0 and +0A must be set.
// ⛔ The PPU draws ゛ as its own tile over the base kana, so screen text and ROM
// text must both be NFD-normalised or every voiced name fails to match.
// ⛔ `!BTN[k]` would reject A — jsnes numbers BUTTON_A as 0.

import fs from 'node:fs';
import { NES, Controller } from 'jsnes';
import * as F2 from './lib/ff2-text.mjs';
import * as S from './lib/ff2-shops.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const INDEX = flag('index', null);
const ALL = args.includes('--all');
const STATE = flag('state', process.env.FF2_STATE);
const ROMP = process.env.FF2_ROM || '/home/joeltco/roms/ff2-jp.nes';

const OBJ_RAM = 0x7500, O_LIVE = 0, O_X = 2, O_Y = 3, O_X2 = 4, O_Y2 = 5, O_TYPE = 0x0A;
const PLAYER_X = 0x68, PLAYER_Y = 0x69;

if (!STATE) { console.error('--state is required'); process.exit(1); }
const rom = new Uint8Array(fs.readFileSync(ROMP));
const romBin = fs.readFileSync(ROMP, 'binary');
const SNAP = fs.readFileSync(STATE, 'utf8');
const B = { a: Controller.BUTTON_A, b: Controller.BUTTON_B, up: Controller.BUTTON_UP };
const strip = (s) => s.normalize('NFD').replace(/[゙゚]/g, '');

/** Open shop `index` and return the four rows of its Buy list. */
function openShop(index) {
  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(romBin);
  nes.fromJSON(JSON.parse(SNAP));
  const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
  const press = (k, h = 6, a = 16) => {
    nes.buttonDown(1, B[k]); run(h); nes.buttonUp(1, B[k]); run(a);
  };
  run(8); press('b'); press('b'); run(30);
  const m = nes.cpu.mem, px = m[PLAYER_X], py = m[PLAYER_Y];
  for (let s = 1; s < 12; s++) m[OBJ_RAM + s * 0x10 + O_LIVE] = 0;
  const type = S.SHOP_TYPE_FIRST + index;
  m[OBJ_RAM + O_LIVE] = type; m[OBJ_RAM + O_TYPE] = type;
  m[OBJ_RAM + O_X] = px; m[OBJ_RAM + O_X2] = px;
  m[OBJ_RAM + O_Y] = py - 1; m[OBJ_RAM + O_Y2] = py - 1;
  run(10); press('up'); press('a', 6, 60); press('a', 6, 60);

  const v = nes.ppu.vramMem, rows = [];
  for (let r = 3; r < 12; r++) {
    let s = '';
    for (let c = 14; c < 32; c++) {
      const g = F2.glyph(v[0x2000 + r * 32 + c]);
      s += (g === null || g === '\n') ? ' ' : g;
    }
    if (s.trim()) rows.push(strip(s).trim());
  }
  return { rows, ram: [...nes.cpu.mem.slice(S.SHOP_RAM, S.SHOP_RAM + S.SHOP_COPY_LEN)] };
}

/** Split a drawn row into its name and its price. */
function parseRow(row) {
  const m = row.match(/^(.*?)\s+(\d+)\s*$/);
  return m ? { name: strip(m[1]).trim(), price: Number(m[2]) } : null;
}

function check(index) {
  const e = S.shopAt(rom, index, F2.glyph);
  const { rows, ram } = openShop(index);
  const drawn = rows.map(parseRow).filter(Boolean);
  const problems = [];
  // the RAM copy must begin with the record the table predicts
  if (JSON.stringify(ram.slice(0, S.SHOP_STRIDE)) !== JSON.stringify(e.raw)) {
    problems.push(`RAM $7B00 = [${ram.slice(0, 8).map(v => v.toString(16)).join(' ')}] ` +
                  `but the table says [${e.raw.map(v => v.toString(16)).join(' ')}]`);
  }
  if (drawn.length !== S.SHOP_ITEMS) {
    problems.push(`drew ${drawn.length} rows, expected ${S.SHOP_ITEMS}`);
  } else {
    for (let i = 0; i < S.SHOP_ITEMS; i++) {
      if (drawn[i].price !== e.items[i].price) {
        problems.push(`row ${i}: drew ${drawn[i].price} G, table says ${e.items[i].price} G`);
      }
      if (strip(e.items[i].name) !== drawn[i].name) {
        problems.push(`row ${i}: drew "${drawn[i].name}", table says "${strip(e.items[i].name)}"`);
      }
    }
  }
  return { e, drawn, problems };
}

if (ALL) {
  console.log('every FF2 shop: the table vs what the shop draws\n');
  let bad = 0;
  for (let i = 0; i < S.SHOP_COUNT; i++) {
    const { e, drawn, problems } = check(i);
    if (problems.length) bad++;
    console.log(`shop ${String(i).padStart(2)} (type ${e.objType})  ` +
                `[${e.raw.map(v => v.toString(16).padStart(2, '0')).join(' ')}]  ` +
                `${e.items.map(it => `${it.name} ${it.price}G`).join(' / ')}` +
                `${problems.length ? '\n     MISMATCH: ' + problems.join('; ') : ''}`);
    void drawn;
  }
  console.log(`\n${bad} mismatch(es) across ${S.SHOP_COUNT} shops`);
  process.exit(bad ? 1 : 0);
}

if (INDEX === null) { console.error('give --index N or --all'); process.exit(1); }
const i = Number(INDEX);
const { e, drawn, problems } = check(i);
console.log(`FF2 shop ${i} — object type ${e.objType}, record @ file 0x${e.offset.toString(16)}`);
console.log(`  raw [${e.raw.map(v => v.toString(16).padStart(2, '0')).join(' ')}]`);
for (const it of e.items) {
  console.log(`  item 0x${it.id.toString(16).padStart(2, '0')} code 0x${it.code.toString(16)}  ` +
              `${(it.name || '?').padEnd(12)} ${String(it.price).padStart(6)} G`);
}
console.log('\ndrawn on screen:');
for (const d of drawn) console.log(`  ${d.name.padEnd(12)} ${String(d.price).padStart(6)} G`);
console.log(problems.length ? '\nMISMATCH:\n  ' + problems.join('\n  ') : '\n✓ matches');
process.exit(problems.length ? 1 : 0);
