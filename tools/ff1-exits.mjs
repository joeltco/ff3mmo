#!/usr/bin/env node
// ff1-exits.mjs — every tile on the loaded FF1 map that does something, and what.
//
// WHY
// Walking onto a town's door tile does nothing visible, so "which tile is the
// shop" cannot be answered by looking at the map. It IS answerable from the
// CPU: the tile-property SECOND byte is the tile's SPECIAL id.
//
// The rule, the id space and the listings that prove them all live in
// `lib/ff1-map.mjs` — this tool only walks the map and prints.
//
// ⛔ An earlier version of this tool resolved prop1 through the overworld
// entrance tables at $AC00/$AC20/$AC40 and printed confident nonsense
// ("(15,19) -> map 11"). Those tables are indexed by the overworld entrance id,
// a DIFFERENT space. (15,19) carries prop1 = 12, and 12 is the ARMOR SHOP.
//
//   node tools/ff1-exits.mjs --state town.state
//
// ⛔ The property table is in INTERNAL RAM, so `onRead` cannot see it being
// read (that hook is cartridge-only) — this samples `cpu.mem` directly instead.

import fs from 'node:fs';
import { NES } from 'jsnes';
import * as M from './lib/ff1-map.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const STATE = flag('state', null);
const ROMP = process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes';

if (!STATE) { console.error('--state is required'); process.exit(1); }
const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
nes.loadROM(fs.readFileSync(ROMP, 'binary'));
nes.fromJSON(JSON.parse(fs.readFileSync(STATE, 'utf8')));
for (let i = 0; i < 20; i++) nes.frame();

const m = nes.cpu.mem;

console.log(`FF1 specials — map ${m[M.MAP_ID]}, party at (${m[M.PLAYER_X]},${m[M.PLAYER_Y]})\n`);

const byIdx = new Map();
for (let y = 0; y < M.MAP_H; y++) {
  for (let x = 0; x < M.MAP_W; x++) {
    const p1 = M.prop1(m, x, y);
    if (!p1) continue;                       // $CEB0 BEQ — this tile does nothing
    if (!byIdx.has(p1)) {
      byIdx.set(p1, { tile: M.tileAt(m, x, y), walk: !M.isBlocked(m, x, y), at: [] });
    }
    byIdx.get(p1).at.push([x, y]);
  }
}

if (!byIdx.size) { console.log('no tile on this map has prop1 set — nothing on it does anything'); process.exit(0); }

console.log('id   tile  opens        walkable  tiles');
for (const [id, info] of [...byIdx].sort((a, b) => a[0] - b[0])) {
  const kind = M.specialKind(id);
  const spots = info.at.slice(0, 8).map(([x, y]) => `(${x},${y})`).join(' ')
    + (info.at.length > 8 ? ` +${info.at.length - 8} more` : '');
  console.log(`${String(id).padStart(3)}  0x${info.tile.toString(16).padStart(2, '0')}  ` +
              `${(kind || 'off-table').padEnd(11)}  ${info.walk ? 'yes     ' : 'NO      '}  ${spots}`);
}
console.log('\nverify any of these with:  node tools/ff1-warp.mjs --state <state> --index <id> --screen');
