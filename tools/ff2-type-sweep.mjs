#!/usr/bin/env node
// ff2-type-sweep.mjs — what does EVERY FF2 object type do when you talk to it?
//
// WHY
// FF2 resolves an object to a per-type CODE handler, so an object type is not
// just a line of dialogue — it can open a shop, an inn, a save prompt. Finding
// which types are shops by walking the world means reaching towns that are many
// hours of play away. This reaches all 256 in one pass without leaving the
// opening map.
//
// THE METHOD
// The map's objects are loaded into RAM at $7500, 16 bytes each:
//
//   +0    live type (0 = despawned)      +2,+3  tile x, y
//   +4,+5 x,y copy                       +0A    the object TYPE
//
// So: put slot 0 on the tile next to the party, set its type, face it, press A,
// and read the box off the nametable. Then do that 256 times.
//
//   node tools/ff2-type-sweep.mjs                    # all 256
//   node tools/ff2-type-sweep.mjs --from 0 --to 40
//   node tools/ff2-type-sweep.mjs --type 97          # just one, verbose
//
// ⛔ Patching the ROM's object table does NOT work here: the savestate already
// has the map loaded, so the ROM copy is never read again. Poke RAM.
// ⛔ Both +0 and +0A have to be set. +0 alone leaves the old handler; +0A alone
// leaves the object despawned.
// ⛔ `!BTN[k]` would reject A — jsnes numbers BUTTON_A as 0.

import fs from 'node:fs';
import { NES, Controller } from 'jsnes';
import * as F2 from './lib/ff2-text.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const ONE = flag('type', null);
const FROM = Number(flag('from', '0'));
const TO = Number(flag('to', '255'));
const STATE = flag('state', process.env.FF2_STATE);
const ROMP = process.env.FF2_ROM || '/home/joeltco/roms/ff2-jp.nes';

const OBJ_RAM = 0x7500, OBJ_STRIDE = 0x10;
const O_LIVE = 0x00, O_X = 0x02, O_Y = 0x03, O_X2 = 0x04, O_Y2 = 0x05, O_TYPE = 0x0A;
const PLAYER_X = 0x68, PLAYER_Y = 0x69;

if (!STATE) { console.error('--state is required (or $FF2_STATE)'); process.exit(1); }
const SNAP = fs.readFileSync(STATE, 'utf8');
const romBin = fs.readFileSync(ROMP, 'binary');

const BTN = { a: Controller.BUTTON_A, b: Controller.BUTTON_B, up: Controller.BUTTON_UP,
              down: Controller.BUTTON_DOWN, left: Controller.BUTTON_LEFT,
              right: Controller.BUTTON_RIGHT };

const strip = (s) => s.normalize('NFD').replace(/[゙゚]/g, '');

/** Sentence-like runs on screen, from all four nametables (FF2 scrolls). */
function screenLines(nes) {
  const v = nes.ppu.vramMem;
  const out = [];
  for (const base of [0x2000, 0x2400, 0x2800, 0x2C00]) {
    for (let r = 0; r < 30; r++) {
      const runs = [];
      let cur = [];
      for (let c = 0; c < 32; c++) {
        const b = v[base + r * 32 + c];
        if (F2.glyph(b) !== null) cur.push(b);
        else { if (cur.length >= 3) runs.push(cur); cur = []; }
      }
      if (cur.length >= 3) runs.push(cur);
      for (const rn of runs) {
        // the box border is a long run of two tiles; a sentence is varied
        if (new Set(rn).size < 3) continue;
        const s = strip(rn.map(b => F2.glyph(b)).join('')).trim();
        if (s) out.push(s);
      }
    }
  }
  return [...new Set(out)];
}

/** Stand an object of `type` next to the party, talk to it, return the screen. */
function talkToType(type) {
  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(romBin);
  nes.fromJSON(JSON.parse(SNAP));
  const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
  const press = (k, hold = 6, after = 16) => {
    nes.buttonDown(1, BTN[k]); run(hold); nes.buttonUp(1, BTN[k]); run(after);
  };
  run(8);
  press('b'); press('b'); run(30);              // close whatever box the state was in
  const baseline = new Set(screenLines(nes));

  const px = nes.cpu.mem[PLAYER_X], py = nes.cpu.mem[PLAYER_Y];
  const m = nes.cpu.mem;
  // clear every other object so nothing else can answer instead
  for (let s = 1; s < 12; s++) m[OBJ_RAM + s * OBJ_STRIDE + O_LIVE] = 0;
  const b = OBJ_RAM;
  m[b + O_LIVE] = type; m[b + O_TYPE] = type;
  m[b + O_X] = px; m[b + O_X2] = px;
  m[b + O_Y] = py - 1; m[b + O_Y2] = py - 1;    // directly above the party
  run(10);
  press('up');                                   // face it (it blocks, so no move)
  press('a', 6, 90);
  const after = screenLines(nes);
  return { lines: after.filter(l => !baseline.has(l)), all: after, nes };
}

if (ONE !== null) {
  const r = talkToType(Number(ONE));
  console.log(`FF2 object type ${ONE}:`);
  for (const l of r.lines) console.log('   ' + l);
  if (!r.lines.length) console.log('   (nothing new appeared)');
  process.exit(0);
}

console.log(`FF2 object types ${FROM}..${TO} — what talking to each one produces\n`);
for (let t = FROM; t <= TO; t++) {
  const r = talkToType(t);
  const txt = r.lines.join(' | ').slice(0, 150);
  console.log(`${String(t).padStart(3)}  ${txt || '(nothing)'}`);
}
