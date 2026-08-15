#!/usr/bin/env node
// ff1-overworld-scan.mjs — find the overworld tiles that lead somewhere.
//
// WHY
// FF1's towns are only reachable from the overworld, and the area around
// Coneria Castle is a pocket a few tiles wide — walking out of it is not
// possible. Without this, no town map can be reached at all, which blocks every
// question that needs a shop.
//
// WHAT MAKES IT POSSIBLE
// The overworld position is `$27`/`$28` (a 256x256 world), NOT the `$68`/`$69`
// used on ordinary maps, and unlike those it IS authoritative: poking it
// teleports the party. Measured — poked (150,170), stepped, landed (150,171).
//
// THE METHOD
// For each candidate tile, teleport to a NEIGHBOUR and step onto it. If `$48`
// changes, that tile is an entrance and `$48` names the map. Entering is what
// triggers it — a bare poke onto the tile does nothing.
//
// ⛔ ALL FOUR neighbours have to be tried. A first version only approached from
// the north and found ZERO entrances, including one known to exist: the tile
// north of the Coneria Castle entrance is castle wall, so the poke landed the
// party on blocked terrain and no step was possible. A poke to a walkable tile
// works fine — verified against a no-poke control walking the same route.
//
//   node tools/ff1-overworld-scan.mjs --state ff1-world.state
//   node tools/ff1-overworld-scan.mjs --state ff1-world.state --x 120,180 --y 140,200
//
// ⛔ Searching the ROM for a coordinate pair instead finds hundreds of false
// hits — this measures rather than guesses.

import fs from 'node:fs';
import { NES, Controller } from 'jsnes';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const STATE = flag('state', null);
const [X0, X1] = flag('x', '132,164').split(',').map(Number);
const [Y0, Y1] = flag('y', '146,184').split(',').map(Number);
const ROMP = process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes';

const WX = 0x27, WY = 0x28, MAP_ID = 0x48;

if (!STATE) { console.error('--state is required (an FF1 overworld savestate)'); process.exit(1); }
const SNAP = fs.readFileSync(STATE, 'utf8');
const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
nes.loadROM(fs.readFileSync(ROMP, 'binary'));
nes.fromJSON(JSON.parse(SNAP));
const run = (k) => { for (let i = 0; i < k; i++) nes.frame(); };
const reload = () => { nes.fromJSON(JSON.parse(SNAP)); run(12); };
run(20);

console.log(`FF1 overworld scan — x ${X0}..${X1}, y ${Y0}..${Y1} ` +
            `(${(X1 - X0 + 1) * (Y1 - Y0 + 1)} tiles)`);
const found = [];
let tested = 0;
for (let y = Y0; y <= Y1; y++) {
  for (let x = X0; x <= X1; x++) {
    // try every approach — the neighbour we start on has to be walkable
    const APPROACH = [
      [0, -1, Controller.BUTTON_DOWN], [0, 1, Controller.BUTTON_UP],
      [-1, 0, Controller.BUTTON_RIGHT], [1, 0, Controller.BUTTON_LEFT],
    ];
    let hit = 0;
    for (const [dx, dy, btn] of APPROACH) {
      nes.cpu.mem[WX] = (x + dx) & 0xFF; nes.cpu.mem[WY] = (y + dy) & 0xFF;
      run(10);
      nes.buttonDown(1, btn); run(10); nes.buttonUp(1, btn); run(14);
      tested++;
      if (nes.cpu.mem[MAP_ID] !== 0) { hit = nes.cpu.mem[MAP_ID]; break; }
    }
    if (hit) {
      found.push({ x, y, map: hit });
      console.log(`  (${x},${y}) -> MAP ${hit}`);
      reload();
    }
  }
}
console.log(`\ntested ${tested} tiles, found ${found.length} entrance(s)`);
const byMap = new Map();
for (const f of found) if (!byMap.has(f.map)) byMap.set(f.map, f);
console.log('distinct maps reachable: ' +
  ([...byMap].sort((a, b) => a[0] - b[0]).map(([m, f]) => `${m} @(${f.x},${f.y})`).join('  ') || '(none)'));
