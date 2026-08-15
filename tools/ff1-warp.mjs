#!/usr/bin/env node
// ff1-warp.mjs — go to any FF1 map by driving the game's OWN transition.
//
// WHY
// Reaching a shop by walking is hopeless: towns are only reachable from the
// overworld, the overworld pocket around the start is a few tiles wide, and
// stepping onto an interior door leaves the party frozen on the tile. But the
// transition itself is a two-byte request, and setting those two bytes runs the
// real routine — no shortcut, no fabricated state.
//
// READ OFF THE CPU (see `ff1-exits.mjs` for the full listing):
//
//   $CEB0  LDA $45 / BEQ + / STA $51 / INC $50   ; tile property 1 -> request
//   $C8E5  LDA $50 / BNE $C8FE                   ; the pending branch...
//   $C8FE  JSR $CB94 ...                         ; ...runs the transition
//
// So `$51 = index; $50 = 1` is exactly what walking onto a door does. This
// pokes those and lets the game do the rest.
//
//   node tools/ff1-warp.mjs --state hall.state --index 12
//   node tools/ff1-warp.mjs --state hall.state --sweep 0,80     # decode the table
//
// ⛔ The transition needs MANY frames — the loader parks the CPU in the
// wait-for-NMI spin at $FEBB and the map only appears after the fade. Settling
// for a handful of frames reports "it hung" when it merely had not finished.
// ⛔ A destination whose map never changes is a REAL result (a dud index), not
// a broken harness — the sweep prints it as such rather than hiding it.

import fs from 'node:fs';
import { NES } from 'jsnes';
import * as F1 from './lib/ff1-text.mjs';
import * as M from './lib/ff1-map.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const STATE = flag('state', null);
const INDEX = flag('index', null);
const SWEEP = flag('sweep', null);
const SETTLE = Number(flag('settle', '400'));
const SAVE = flag('save', null);
const SCREEN = args.includes('--screen');
const ROMP = process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes';


if (!STATE) { console.error('--state is required'); process.exit(1); }
const SNAP = fs.readFileSync(STATE, 'utf8');
const romBin = fs.readFileSync(ROMP, 'binary');

/** Fresh machine at the savestate. */
function boot() {
  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(romBin);
  nes.fromJSON(JSON.parse(SNAP));
  for (let i = 0; i < 20; i++) nes.frame();
  return nes;
}

/** Request the transition and let it finish. */
function warp(nes, idx) {
  const from = nes.cpu.mem[M.MAP_ID];
  nes.cpu.mem[M.SPECIAL_ID] = idx;
  nes.cpu.mem[M.SPECIAL_PENDING] = 1;
  for (let i = 0; i < SETTLE; i++) nes.frame();
  const m = nes.cpu.mem;
  return { from, map: m[M.MAP_ID], x: m[M.PLAYER_X], y: m[M.PLAYER_Y],
           flag: m[M.DOOR_STATE], pending: m[M.SPECIAL_PENDING] };
}

/** Text on screen — by draw time the nametable tile index IS the char code. */
function screenText(nes) {
  const v = nes.ppu.vramMem;
  const out = [];
  for (const base of [0x2000, 0x2400, 0x2800, 0x2C00]) {
    for (let r = 0; r < 30; r++) {
      let s = '';
      for (let c = 0; c < 32; c++) {
        const g = F1.glyph(v[base + r * 32 + c]);
        s += (g === null || g === '\n') ? ' ' : g;
      }
      s = s.trim();
      if (/[A-Za-z]{3,}/.test(s)) out.push(s);
    }
  }
  return out;
}

if (SWEEP) {
  const [lo, hi] = SWEEP.split(',').map(Number);
  console.log(`FF1 warp sweep — indices ${lo}..${hi}, ${SETTLE} frames each\n`);
  console.log('idx  ->  map   at        $0D  screen');
  for (let i = lo; i <= hi; i++) {
    const nes = boot();
    const r = warp(nes, i);
    // the screen is the ONLY honest label — a shop id is only a shop id
    // because the shop drew itself.
    const txt = screenText(nes).slice(0, 4).join(' / ') || '(nothing drew)';
    console.log(`${String(i).padStart(3)}  ->  ${String(r.map).padStart(3)}  ` +
                `(${String(r.x).padStart(2)},${String(r.y).padStart(2)})  ` +
                `0x${r.flag.toString(16).padStart(2, '0')}  ${txt}`);
  }
  process.exit(0);
}

if (INDEX === null) { console.error('give --index N or --sweep lo,hi'); process.exit(1); }
const nes = boot();
console.log(`FF1 warp — from ${STATE}, index ${INDEX}`);
const r = warp(nes, Number(INDEX));
console.log(`map ${r.from} -> ${r.map}   party (${r.x},${r.y})   ` +
            `$0D=0x${r.flag.toString(16).padStart(2, '0')} bit0=${r.flag & 1} bit7=${(r.flag >> 7) & 1}   ` +
            `$50=${r.pending}`);
if (SCREEN) {
  const lines = screenText(nes);
  console.log('\nscreen text:');
  console.log(lines.length ? lines.map(l => '  ' + l).join('\n') : '  (none — no menu or box is open)');
}
if (SAVE) { fs.writeFileSync(SAVE, JSON.stringify(nes.toJSON())); console.log(`\nsaved -> ${SAVE}`); }
