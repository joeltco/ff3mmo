#!/usr/bin/env node
// ff3-shop-probe.mjs — open every FF3 shop and check it against the table.
//
// The tables in `lib/ff3-shops.mjs` are a claim until the shop draws the same
// items. This patches one shopkeeper's id, warps in, opens the Buy list and
// compares names and prices.
//
//   node tools/ff3-shop-probe.mjs --state s.state --id 231
//   node tools/ff3-shop-probe.mjs --state s.state --all
//
// ⛔ Some glyph bytes have no entry in the decoder (Blizzard draws as "B zzard"
// on screen and decodes as "Bzzard"), so names are compared with all spaces
// removed. Prices are exact.

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NES, Controller } from 'jsnes';

const { glyph } = await import('./lib/ff3-text.mjs');
const S = await import('./lib/ff3-shops.mjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const ONE = flag('id', null);
const ALL = args.includes('--all');
const STATE = flag('state', null);
const ROMP = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;

const SHOPKEEPER_ID_OFF = 0x595F2;    // map 5's shopkeeper id byte
const SHOP_MAP = 5, STAND = [3, 24];
const PLAYER_X = 0x68, PLAYER_Y = 0x69, WARP_MAP = 0x0700, WARP_FLAG = 0x00AB;

const rom = new Uint8Array(fs.readFileSync(ROMP));
const SNAP = STATE
  ? fs.readFileSync(STATE, 'utf8')
  : zlib.gunzipSync(fs.readFileSync(path.join(HERE, 'states', 'ff3-freeroam.state.gz'))).toString('utf8');
const D = { up: Controller.BUTTON_UP, down: Controller.BUTTON_DOWN,
            left: Controller.BUTTON_LEFT, right: Controller.BUTTON_RIGHT, a: Controller.BUTTON_A };

function openShop(id) {
  const p = Uint8Array.from(rom); p[SHOPKEEPER_ID_OFF] = id;
  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(Buffer.from(p).toString('binary'));
  nes.fromJSON(JSON.parse(SNAP));
  const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
  const press = (k, h = 16, a = 16) => {
    nes.buttonDown(1, D[k]); run(h); nes.buttonUp(1, D[k]); run(a);
  };
  run(8);
  for (let f = 0; f < 240; f++) {
    nes.cpu.mem[WARP_MAP] = SHOP_MAP; nes.cpu.mem[WARP_FLAG] = 0x80;
    nes.frame();
    if (nes.cpu.mem[WARP_FLAG] !== 0x80) break;
  }
  run(180);
  for (let i = 0; i < 10; i++) {
    const x = nes.cpu.mem[PLAYER_X], y = nes.cpu.mem[PLAYER_Y];
    if (x === STAND[0] && y === STAND[1]) break;
    if (y > STAND[1]) press('up'); else if (y < STAND[1]) press('down');
    else if (x > STAND[0]) press('left'); else if (x < STAND[0]) press('right');
    else break;
  }
  press('up'); press('a', 8, 90); press('a', 8, 90);
  return nes;
}

/** The "Name  price" rows the shop drew, plus the kind word and the RAM record. */
function readShop(nes) {
  const v = nes.ppu.vramMem;
  const lines = [];
  for (let r = 0; r < 30; r++) {
    let s = '';
    for (let c = 0; c < 32; c++) { const g = glyph(v[0x2000 + r * 32 + c]); s += (g === null ? ' ' : g); }
    if (s.trim()) lines.push(s.replace(/\s+/g, ' ').trim());
  }
  const rows = [];
  for (const l of lines) {
    const m = l.match(/^(.*?[A-Za-z?].*?)\s+(\d+)$/);
    if (m && !/you buy|How many|^1 4 10/.test(l)) rows.push({ name: m[1].replace(/\s+/g, ''), price: Number(m[2]) });
  }
  const kindLine = lines.find(l => /you buy,/.test(l));
  const kind = kindLine ? kindLine.replace(/\s*you buy,.*/, '').replace(/^What will\s*/, '').trim() : null;
  return { rows, kind, lines, ram: [...nes.cpu.mem.slice(S.SHOP_RAM, S.SHOP_RAM + 10)] };
}

function check(id) {
  const e = S.shopAt(rom, id, glyph);
  const got = readShop(openShop(id));
  const problems = [];
  if (got.kind !== e.kind) problems.push(`drew kind "${got.kind}", table says "${e.kind}"`);
  if (got.ram[0] !== e.kindByte) problems.push(`RAM $7B00 kind ${got.ram[0]}, table says ${e.kindByte}`);
  const wantIds = e.items.map(i => i.id);
  const ramIds = got.ram.slice(1, 1 + wantIds.length);
  if (JSON.stringify(ramIds) !== JSON.stringify(wantIds)) {
    problems.push(`RAM ids [${ramIds}] vs table [${wantIds}]`);
  }
  if (got.rows.length !== e.items.length) {
    problems.push(`drew ${got.rows.length} rows, table has ${e.items.length}`);
  } else {
    for (let i = 0; i < e.items.length; i++) {
      if (got.rows[i].price !== e.items[i].price) {
        problems.push(`row ${i}: drew ${got.rows[i].price} G, table says ${e.items[i].price} G`);
      }
      const a = got.rows[i].name.replace(/\s/g, ''), b = e.items[i].name.replace(/\s/g, '');
      if (a !== b) problems.push(`row ${i}: drew "${a}", table says "${b}"`);
    }
  }
  return { e, got, problems };
}

if (ALL) {
  console.log('every FF3 shop: the table vs what the shop draws\n');
  let bad = 0;
  for (const id of S.SHOP_NPC_IDS) {
    const { e, problems } = check(id);
    if (problems.length) bad++;
    console.log(`id ${id}  ${String(e.kind).padEnd(8)} ` +
                `${e.items.map(i => `${i.name} ${i.price}G`).join(' / ')}` +
                `${problems.length ? '\n     MISMATCH: ' + problems.join('; ') : ''}`);
  }
  console.log(`\n${bad} mismatch(es) across ${S.SHOP_NPC_IDS.length} shops`);
  process.exit(bad ? 1 : 0);
}

if (ONE === null) { console.error('give --id N or --all'); process.exit(1); }
const { e, got, problems } = check(Number(ONE));
console.log(`FF3 shop, NPC id ${e.npcId} — ${e.kind} (kind byte ${e.kindByte}), record @ file 0x${e.offset.toString(16)}`);
for (const it of e.items) {
  console.log(`  0x${it.id.toString(16).padStart(2, '0')}  ${it.name.padEnd(12)} ${String(it.price).padStart(6)} G`);
}
console.log('\ndrawn:');
for (const r of got.rows) console.log(`  ${r.name.padEnd(12)} ${String(r.price).padStart(6)} G`);
console.log(problems.length ? '\nMISMATCH:\n  ' + problems.join('\n  ') : '\n✓ matches');
process.exit(problems.length ? 1 : 0);
