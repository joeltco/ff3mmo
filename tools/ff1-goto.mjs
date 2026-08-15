#!/usr/bin/env node
// ff1-goto.mjs — put the party on ANY FF1 map, by patching where a door leads.
//
// WHY
// FF1's towns and dungeons are only reachable from the overworld, and the
// overworld pocket the starting savestate sits in has no walkable route out (a
// 630-tile scan found no entrance). Everything past Coneria Castle was therefore
// unreachable — no town, no shop, no dungeon, no chest.
//
// THE METHOD (the hex-patch rule)
// The overworld ENTRANCE tables are three parallel byte arrays, caught by
// hooking the reads that feed the write to `$48` during a transition:
//
//   $AC00 + i   destination X     file 0x2C10
//   $AC20 + i   destination Y     file 0x2C30
//   $AC40 + i   destination MAP   file 0x2C50
//
// So: repoint the entrance the party CAN reach at whatever map you want, walk
// in, and you are there. The ROM on disk is never touched — the patch goes into
// the in-memory copy handed to jsnes.
//
//   node tools/ff1-goto.mjs --state world.state --map 16 --at 30,18
//   node tools/ff1-goto.mjs --state world.state --entrance 33 --save out.state
//
// ⛔ The overworld uses `$27`/`$28`, NOT the `$68`/`$69` every other map uses,
// and unlike those they ARE pokeable.

import fs from 'node:fs';
import { NES, Controller } from 'jsnes';
import * as M from './lib/ff1-map.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const STATE = flag('state', null);
const MAP = flag('map', null);
const AT = flag('at', null);
const ENTRANCE = flag('entrance', null);
const SAVE = flag('save', null);
const ROMP = process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes';

/** The entrance the starting savestate can actually walk into. */
const REACHABLE_ENTRANCE = 9;      // Coneria Castle's door

if (!STATE) { console.error('--state is required (an FF1 overworld savestate)'); process.exit(1); }
const rom = new Uint8Array(fs.readFileSync(ROMP));
const SNAP = fs.readFileSync(STATE, 'utf8');

let destMap, destX, destY;
if (ENTRANCE !== null) {
  const e = M.entranceFor(rom, Number(ENTRANCE));
  ({ map: destMap, x: destX, y: destY } = e);
} else {
  if (MAP === null) { console.error('give --map N [--at X,Y] or --entrance N'); process.exit(1); }
  destMap = Number(MAP);
  [destX, destY] = (AT || '0,0').split(',').map(Number);
}

const patched = Uint8Array.from(rom);
patched[M.ENTRANCE_X + REACHABLE_ENTRANCE] = destX;
patched[M.ENTRANCE_Y + REACHABLE_ENTRANCE] = destY;
patched[M.ENTRANCE_MAP + REACHABLE_ENTRANCE] = destMap;

const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
nes.loadROM(Buffer.from(patched).toString('binary'));
nes.fromJSON(JSON.parse(SNAP));
const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
const D = [Controller.BUTTON_UP, Controller.BUTTON_DOWN, Controller.BUTTON_LEFT, Controller.BUTTON_RIGHT];
run(20);

console.log(`FF1 goto — entrance ${REACHABLE_ENTRANCE} repointed to map ${destMap} @(${destX},${destY})`);
console.log(`  starting at world (${nes.cpu.mem[M.WORLD_X]},${nes.cpu.mem[M.WORLD_Y]})`);

// Find the door. ⛔ It is straight NORTH of where the starting savestate sits —
// six tiles up, at world (146,152). Neither a round-robin walk nor poking onto
// neighbouring tiles finds it: the round-robin turns around long before it gets
// there, and a poke frequently lands the party on blocked terrain where no step
// is possible at all. Walk each direction to exhaustion instead.
let arrived = false;
outer:
for (const b of [Controller.BUTTON_UP, Controller.BUTTON_LEFT,
                 Controller.BUTTON_RIGHT, Controller.BUTTON_DOWN]) {
  nes.fromJSON(JSON.parse(SNAP));
  run(20);
  for (let step = 0; step < 120; step++) {
    nes.buttonDown(1, b); run(8); nes.buttonUp(1, b); run(12);
    if (nes.cpu.mem[M.MAP_ID] !== 0) { arrived = true; break outer; }
  }
}
if (!arrived) { console.error('never found the door — the pocket may differ in this savestate'); process.exit(1); }
run(120);

const m = nes.cpu.mem;
console.log(`  arrived: map ${m[M.MAP_ID]} at (${m[M.PLAYER_X]},${m[M.PLAYER_Y]})`);
if (SAVE) { fs.writeFileSync(SAVE, JSON.stringify(nes.toJSON())); console.log(`  saved -> ${SAVE}`); }
