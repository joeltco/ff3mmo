#!/usr/bin/env node
// ff1-room-probe.mjs — walk into a town building and watch `$0D`.
//
// WHY
// FF1's map-object records carry a flag bit `0x80` (`altLayer`), and the
// working theory is that it selects between two sets of objects: the ones
// standing outside and the ones standing inside a building. `$0D` bit 0 is the
// candidate for the runtime side of that switch, but a bit that never changes
// is not evidence — it has to be caught FLIPPING.
//
// THE METHOD
// Nothing here is inferred from the map bytes. Walk the party a tile at a time
// with a write hook on `$0D` armed, and after every step report:
//   - where the party is and what the tile under it is
//   - `$0D`, and every write to it since the last step, with the PC that did it
//   - whether the 64x64 map in RAM CHANGED — a building whose roof lifts is
//     rewriting `$7000`, and that is what "entering" looks like from the CPU
//
//   node tools/ff1-room-probe.mjs --state town.state --walk up,up,up
//   node tools/ff1-room-probe.mjs --state town.state --walk up,up --screen
//
// ⛔ `--screen` reads the NAMETABLE, not the map: by draw time the tile index
// IS the character code, so a shop's text can be read straight off the PPU.
// That is the only way to tell "a menu opened" from "the party moved".
// ⛔ Build the tracer AFTER `fromJSON` — it replaces `nes.cpu`.

import fs from 'node:fs';
import { NES, Controller } from 'jsnes';
import { makeTracer, hex } from './lib/nes-trace.mjs';
import * as F1 from './lib/ff1-text.mjs';
import * as M from './lib/ff1-map.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const STATE = flag('state', null);
const WALK = flag('walk', '').split(',').filter(Boolean);
const SCREEN = args.includes('--screen');
const SAVE = flag('save', null);
const SETTLE = Number(flag('settle', '0'));
const ROMP = process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes';


if (!STATE) { console.error('--state is required'); process.exit(1); }
const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
nes.loadROM(fs.readFileSync(ROMP, 'binary'));
nes.fromJSON(JSON.parse(fs.readFileSync(STATE, 'utf8')));

const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
run(20);

const t = makeTracer(nes);
let writes = [];
t.onWrite = (addr, val, pc) => { if (addr === M.DOOR_STATE) writes.push({ val, pc }); };
t.recording = true;

const B = { up: Controller.BUTTON_UP, down: Controller.BUTTON_DOWN,
            left: Controller.BUTTON_LEFT, right: Controller.BUTTON_RIGHT };
const at = () => [nes.cpu.mem[M.PLAYER_X], nes.cpu.mem[M.PLAYER_Y]];
const tile = (x, y) => M.tileAt(nes.cpu.mem, x, y);
const mapSnapshot = () =>
  nes.cpu.mem.slice(M.MAP_RAM, M.MAP_RAM + M.MAP_W * M.MAP_H).join(',');

/**
 * The text on screen, decoded through the SHIPPED FF1 glyph table — by draw
 * time the tile index IS the character code. All four nametables, because the
 * previous screen's tiles linger. Same reader as `ff1-talk-probe.mjs`.
 */
function screenText() {
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

const report = (label) => {
  const [x, y] = at();
  const f = nes.cpu.mem[M.DOOR_STATE];
  const w = writes.length
    ? writes.map(o => `0x${o.val.toString(16)}@${hex(o.pc)}`).join(' ')
    : '(none)';
  console.log(`${label.padEnd(9)} (${String(x).padStart(2)},${String(y).padStart(2)}) ` +
              `map ${String(nes.cpu.mem[M.MAP_ID]).padStart(3)}  tile 0x${tile(x, y).toString(16).padStart(2, '0')}  ` +
              `$0D=0x${f.toString(16).padStart(2, '0')} bit0=${f & 1}  writes: ${w}`);
  writes = [];
};

console.log(`FF1 room probe — ${STATE}`);
report('start');

let prevMap = mapSnapshot();
for (const dir of WALK) {
  if (!B[dir]) { console.error(`unknown direction "${dir}"`); process.exit(1); }
  nes.buttonDown(1, B[dir]); run(6); nes.buttonUp(1, B[dir]); run(26);
  // ⛔ A shop takes hundreds of frames to fade in and draw. Reporting after the
  // usual 26 frames shows an unchanged screen and reads as "nothing happened".
  run(SETTLE);
  report(dir);
  const nowMap = mapSnapshot();
  if (nowMap !== prevMap) { console.log('          ⟵ MAP RAM CHANGED (the room was redrawn)'); prevMap = nowMap; }
}

if (SCREEN) {
  console.log('\nscreen (nametable, tile index == char code):');
  for (const l of screenText()) console.log(l);
}
if (SAVE) { fs.writeFileSync(SAVE, JSON.stringify(nes.toJSON())); console.log(`\nsaved -> ${SAVE}`); }
