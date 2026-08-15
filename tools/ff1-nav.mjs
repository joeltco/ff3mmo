#!/usr/bin/env node
// ff1-nav.mjs — pathfinding for FF1, so probes stop being limited by
// "the axis-walker cannot route through doors".
//
// EVERYTHING HERE IS READ OFF THE CPU, not guessed:
//
//   the map          RAM $7000, 64x64, one byte per tile
//                    $CBBE builds the address as $7000 + y*64 + x:
//                      LDA $15 / LSR x2 / ORA #$70      -> high byte
//                      LDA $15 / ROR x3 / AND #$C0 / ORA $14  -> low byte
//                      LDY #$00 / LDA ($10),Y
//   tile properties  RAM $0400, TWO bytes per tile, indexed tile*2
//                      $CBD5 ASL A / TAY / LDA $0400,Y -> $44 (and $45)
//   walkable         the PLAYER-MOVE check is $CA76, found by diffing the
//                    executed-PC sets of a blocked and a successful move:
//                      $CA79  JSR $CAA2 / BCS $CA9A   ; an earlier refusal
//                      $CA7E  JSR $CBBE               ; fetch properties -> $44
//                      $CA81  LDA $44 / AND #$1F
//                      $CA85  CMP #$01 / BEQ $CA9A    ; BLOCKED
//                      $CA89  AND #$1E / TAX
//                      $CA8C  LDA $CDA1,X / JMP ($0010) ; per-terrain handler
//                    so a tile is blocked iff (prop0 & 0x1F) == 0x01.
//
// ⛔ NOT $CBE2. That routine also reads the properties and does `AND #$C2`,
// which is what an earlier pass mistook for the collision rule — it is some
// other query, and it disagrees with reality: tile 0x38 (prop0 0x01) is blocked
// though 0x01 & 0xC2 == 0, and tile 0x44 (prop0 0x80) is passable though
// 0x80 & 0xC2 != 0. Both are exactly right under (prop0 & 0x1F) == 1.
//
// The property table lives in RAM because it is loaded per tileset, so this
// reads it live rather than resolving a ROM table — always correct for whatever
// map is loaded.
//
//   node tools/ff1-nav.mjs --state ff1-castle.state --to 7,16
//   node tools/ff1-nav.mjs --state ff1-castle.state --map          # print it
//   node tools/ff1-nav.mjs --state ff1-castle.state --to 7,16 --save out.state
//
// ⛔ Objects block movement too, so live NPC positions are treated as walls.
// ⛔ Build nothing before `nes.fromJSON` — it replaces `nes.cpu`.

import fs from 'node:fs';
import { NES, Controller } from 'jsnes';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const STATE = flag('state', null);
const TO = flag('to', null);
const SAVE = flag('save', null);
const SHOW = args.includes('--map');
const ROMP = process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes';

const PLAYER_X = 0x68, PLAYER_Y = 0x69, MAP_ID = 0x48;
const MAP_RAM = 0x7000, MAP_W = 64, MAP_H = 64;
const PROP_RAM = 0x0400;          // 2 bytes per tile
const BLOCK_MASK = 0x1F, BLOCK_VALUE = 0x01;   // $CA83 AND #$1F / CMP #$01
const SPECIAL_MASK = 0x1E, SPECIAL_DOOR = 0x08;
const OBJ_RAM = 0x6F00, OBJ_STRIDE = 0x10, OBJ_SLOTS = 16;

const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
nes.loadROM(fs.readFileSync(ROMP, 'binary'));
if (!STATE) { console.error('--state is required'); process.exit(1); }
nes.fromJSON(JSON.parse(fs.readFileSync(STATE, 'utf8')));

const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
const B = { up: Controller.BUTTON_UP, down: Controller.BUTTON_DOWN,
            left: Controller.BUTTON_LEFT, right: Controller.BUTTON_RIGHT };
const press = (k, hold = 6, after = 26) => {
  nes.buttonDown(1, B[k]); run(hold); nes.buttonUp(1, B[k]); run(after);
};
const at = () => [nes.cpu.mem[PLAYER_X], nes.cpu.mem[PLAYER_Y]];
const tile = (x, y) => nes.cpu.mem[MAP_RAM + (y & 63) * MAP_W + (x & 63)];
const prop0 = (x, y) => nes.cpu.mem[PROP_RAM + tile(x, y) * 2];
const walkable = (x, y) => (prop0(x, y) & BLOCK_MASK) !== BLOCK_VALUE;
/** $CA89 AND #$1E indexes the terrain-handler table at $CDA1. */
const terrainType = (x, y) => prop0(x, y) & SPECIAL_MASK;

/** Live object tiles — NPCs block movement. */
function blockers() {
  const s = new Set();
  for (let i = 0; i < OBJ_SLOTS; i++) {
    const b = OBJ_RAM + i * OBJ_STRIDE;
    if (!nes.cpu.mem[b]) continue;                 // slot empty / not spawned
    s.add(`${nes.cpu.mem[b + 2]},${nes.cpu.mem[b + 3]}`);
  }
  return s;
}

run(20);
console.log(`FF1 nav — map ${nes.cpu.mem[MAP_ID]}, player at (${at()})`);

if (SHOW) {
  const [px, py] = at();
  const blk = blockers();
  console.log('\n  . walkable   # blocked   + door/trigger   @ player   N npc');
  for (let y = 0; y < MAP_H; y++) {
    let row = String(y).padStart(2) + ' ';
    for (let x = 0; x < MAP_W; x++) {
      row += (x === px && y === py) ? '@'
        : blk.has(`${x},${y}`) ? 'N'
        : terrainType(x, y) ? '+'
        : walkable(x, y) ? '.' : '#';
    }
    console.log(row);
  }
}

if (!TO) { if (!SHOW) console.error('give --to X,Y or --map'); process.exit(0); }

const [gx, gy] = TO.split(',').map(Number);

/** BFS over walkable tiles; NPCs are walls, but the GOAL may be one. */
function findPath(sx, sy, tx, ty, ignoreNpcs = false) {
  const blk = ignoreNpcs ? new Set() : blockers();
  const key = (x, y) => y * MAP_W + x;
  const prev = new Map();
  const q = [[sx, sy]];
  const seen = new Set([key(sx, sy)]);
  const STEPS = [['up', 0, -1], ['down', 0, 1], ['left', -1, 0], ['right', 1, 0]];
  while (q.length) {
    const [x, y] = q.shift();
    if (x === tx && y === ty) {
      const out = [];
      let c = key(x, y);
      while (prev.has(c)) { const [d, p] = prev.get(c); out.unshift(d); c = p; }
      return out;
    }
    for (const [d, dx, dy] of STEPS) {
      const nx = (x + dx) & 63, ny = (y + dy) & 63;
      const k = key(nx, ny);
      if (seen.has(k)) continue;
      const goal = nx === tx && ny === ty;
      if (!goal && (!walkable(nx, ny) || blk.has(`${nx},${ny}`))) continue;
      seen.add(k); prev.set(k, [d, key(x, y)]); q.push([nx, ny]);
    }
  }
  return null;
}

// ⛔ NPCs WANDER. A path planned once goes stale the moment one steps into it,
// which is why a plan-then-execute walk stalls partway. Verify every step and
// re-plan when one does not land.
let replans = 0, steps = 0;
for (let guard = 0; guard < 400; guard++) {
  const [cx, cy] = at();
  if (cx === gx && cy === gy) break;
  // ⛔ NPCs are walls for planning, but they WANDER — if the only thing sealing
  // the route is an NPC standing in a corridor, the honest answer is "wait",
  // not "unreachable". Re-plan ignoring them and let the step loop stall.
  let path = findPath(cx, cy, gx, gy);
  if (!path) path = findPath(cx, cy, gx, gy, true);
  if (!path) {
    console.log(`no walkable path from (${cx},${cy}) to (${gx},${gy}) — ` +
                `target tile 0x${tile(gx, gy).toString(16)} prop0 0x${prop0(gx, gy).toString(16)}` +
                `${walkable(gx, gy) ? '' : ' (blocked)'}`);
    process.exit(1);
  }
  if (!steps) console.log(`path found: ${path.length} step(s)`);
  press(path[0]);
  steps++;
  const [nx, ny] = at();
  if (nx === cx && ny === cy) {
    replans++;
    if (replans > 60) { console.log('stuck — too many blocked steps'); break; }
    run(20);                       // let whatever is in the way move on
  }
}
const [ex, ey] = at();
console.log(`${steps} step(s) taken, ${replans} re-plan(s)`);
const ok = ex === gx && ey === gy;
console.log(`walked to (${ex},${ey}) — ${ok ? '✓ ARRIVED' : `✗ ended short (wanted ${gx},${gy})`}`);
if (SAVE && ok) { fs.writeFileSync(SAVE, JSON.stringify(nes.toJSON())); console.log(`saved -> ${SAVE}`); }
process.exitCode = ok ? 0 : 1;
