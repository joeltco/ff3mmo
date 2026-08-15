#!/usr/bin/env node
// ff3-shop-sweep.mjs — what does every FF3 NPC id sell?
//
// WHY
// An FF3 shop is a shopkeeper NPC. Reaching every shop by walking means playing
// most of the game; instead, PATCH the id of one shopkeeper that is two tiles
// from a savestate and warp in. FF3 reloads its NPC table from ROM on every map
// load, so a ROM patch DOES take here (unlike FF2, where the savestate already
// had the map in RAM and the poke had to go to $7500).
//
// THE SETUP
//   map 5's NPC record is at file 0x595EE: id 25 @(3,22), then the shopkeeper
//   id 231 @(3,23). Byte 0x595F2 is that shopkeeper's id.
//   warp:  $0700 = map ; $00AB = $80   (from ff3-talk-probe)
//
//   node tools/ff3-shop-sweep.mjs --from 224 --to 255
//   node tools/ff3-shop-sweep.mjs --id 231           # one, verbose
//
// ⛔ The ROM is never modified on disk — the patch is applied to the in-memory
// copy handed to jsnes.
// ⛔ A step is 16 frames; 5 moves nothing at all.

import fs from 'node:fs';
import { NES, Controller } from 'jsnes';

const { glyph } = await import('./lib/ff3-text.mjs');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const ONE = flag('id', null);
const FROM = Number(flag('from', '0'));
const TO = Number(flag('to', '255'));
const STATE = flag('state', process.env.FF3_STATE);
const ROMP = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;

export const SHOPKEEPER_ID_OFF = 0x595F2;   // map 5's shopkeeper id byte
const SHOP_MAP = 5, STAND = [3, 24];
const PLAYER_X = 0x68, PLAYER_Y = 0x69, WARP_MAP = 0x0700, WARP_FLAG = 0x00AB;

if (!STATE) { console.error('--state is required'); process.exit(1); }
const romBytes = new Uint8Array(fs.readFileSync(ROMP));
const SNAP = fs.readFileSync(STATE, 'utf8');
const D = { up: Controller.BUTTON_UP, down: Controller.BUTTON_DOWN,
            left: Controller.BUTTON_LEFT, right: Controller.BUTTON_RIGHT,
            a: Controller.BUTTON_A, b: Controller.BUTTON_B };

/** Patch the shopkeeper to `id`, warp in, talk, and open the buy list. */
function openShop(id, extraA = true) {
  const patched = Uint8Array.from(romBytes);
  patched[SHOPKEEPER_ID_OFF] = id;
  const bin = Buffer.from(patched).toString('binary');
  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(bin);
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
  const at = () => [nes.cpu.mem[PLAYER_X], nes.cpu.mem[PLAYER_Y]];
  for (let i = 0; i < 10; i++) {
    const [x, y] = at();
    if (x === STAND[0] && y === STAND[1]) break;
    if (y > STAND[1]) press('up'); else if (y < STAND[1]) press('down');
    else if (x > STAND[0]) press('left'); else if (x < STAND[0]) press('right');
    else break;
  }
  press('up');
  press('a', 8, 90);
  if (extraA) press('a', 8, 90);
  return nes;
}

/** Every text line on screen. FF3 expands its text before drawing. */
function screen(nes) {
  const v = nes.ppu.vramMem, out = [];
  for (let r = 0; r < 30; r++) {
    let s = '';
    for (let c = 0; c < 32; c++) { const g = glyph(v[0x2000 + r * 32 + c]); s += (g === null ? ' ' : g); }
    if (s.trim()) out.push(s.replace(/\s+/g, ' ').trim());
  }
  return out;
}

if (ONE !== null) {
  const nes = openShop(Number(ONE));
  console.log(`FF3 shopkeeper id ${ONE}:`);
  for (const l of screen(nes)) console.log('   ' + l);
  process.exit(0);
}

console.log(`FF3 shopkeeper ids ${FROM}..${TO} — what each one opens\n`);
for (let id = FROM; id <= TO; id++) {
  const lines = screen(openShop(id));
  console.log(`${String(id).padStart(3)}  ${lines.join(' | ').slice(0, 160) || '(nothing)'}`);
}
