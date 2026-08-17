#!/usr/bin/env node
// check-ff1-encounter-rate.mjs — FF1's encounter rate stays decoded.
//
//   $CDC3  LDA $45 / BPL        ; tile prop bit 7 = an encounter tile
//   $CDC7  JSR $C571            ; random
//   $CDCA  CMP $F8 / BCS        ; ⭐ random < $F8 -> battle
//   $CFB4  LDA #$0B / JSR $FE03 ; bank 11
//   $CFB9  LDX $48 / LDA $8C01,X / STA $F8   ; ⭐⭐ per-map rate
//   $C753  LDA $8C00 / STA $F8               ; ⭐ overworld rate
//
// ⭐ FF1 and FF2 both hold the live rate in zero page $F8 and fire on random<$F8.
//
// ⛔ THE RATE IS READ ONLY AT MAP ENTRY. Two earlier attempts failed on that:
//   * poking $F8 mid-walk steers nothing and CORRUPTED state into a fake "RUN"
//     detection at step 49 for every rate, including 0x00 — a green-looking gate
//     asserting a behaviour that never happened;
//   * poking $27/$28 to reach the door fails (blocked terrain) — already recorded
//     in ff1-goto.mjs, and re-discovered the hard way.
// ⭐ So this gate CROSSES A REAL MAP LOAD the documented way: repoint the one
// reachable entrance and walk each direction to exhaustion, resetting between.

import fs from 'node:fs';
import zlib from 'node:zlib';
import { NES, Controller } from 'jsnes';
import * as M from './lib/ff1-map.mjs';

export const RATE_ZP = 0xF8;
export const OVERWORLD_RATE = 0x2CC10;      // file; bank 11 $8C00
export const MAP_RATE_TABLE = 0x2CC11;      // file; bank 11 $8C01 + mapId
export const RATE_BANK = 0x0B;
export const REACHABLE_DOOR = 9, TEST_MAP = 1;

const rom = new Uint8Array(fs.readFileSync(process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes'));
const raw = fs.readFileSync('tools/states/ff1-world.state.gz');
const SNAP = (raw[0] === 0x1f && raw[1] === 0x8b) ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
const hx = (v, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');

function enter(patch) {
  const r = Uint8Array.from(rom);
  r[M.ENTRANCE_MAP + REACHABLE_DOOR] = TEST_MAP;
  for (const [o, v] of Object.entries(patch || {})) r[Number(o)] = v;
  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(Buffer.from(r).toString('binary'));
  const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
  for (const b of [Controller.BUTTON_UP, Controller.BUTTON_LEFT,
                   Controller.BUTTON_RIGHT, Controller.BUTTON_DOWN]) {
    nes.fromJSON(JSON.parse(SNAP)); run(20);
    for (let s = 0; s < 120; s++) {
      nes.buttonDown(1, b); run(8); nes.buttonUp(1, b); run(12);
      if (nes.cpu.mem[M.MAP_ID] !== 0) { run(120); return { map: nes.cpu.mem[M.MAP_ID], f8: nes.cpu.mem[RATE_ZP], step: s }; }
    }
  }
  return null;
}

let bad = 0, n = 0;
const ok = (l, c, d) => { n++; if (!c) bad++; console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${l}${d ? ` — ${d}` : ''}`); };

console.log('FF1 encounter rate — $F8, table bank 11 $8C00\n');
const a = enter(null);
ok('a real map load is reached', !!a, a ? `map ${hx(a.map)} at step ${a.step}` : 'never found the door');
if (!a) { console.log('\n0/1 checks passed'); process.exit(1); }
const entry = MAP_RATE_TABLE + a.map;
ok('$F8 after the load equals the map\'s table entry', a.f8 === rom[entry],
   `$F8=${hx(a.f8)} table=${hx(rom[entry])}`);

// ⭐ the causal test — the table must DRIVE $F8, not merely match it once
for (const v of [0x77, 0x02]) {
  const p = enter({ [entry]: v });
  ok(`patching the entry to ${hx(v)} makes $F8 follow`, p && p.f8 === v, p ? `$F8=${hx(p.f8)}` : 'no load');
}
// ⛔ one sample matching is the trap this guards; the unpatched value must differ
ok('the unpatched value differs from both sentinels', a.f8 !== 0x77 && a.f8 !== 0x02, hx(a.f8));

// constants bound to the instructions that read them
const owF = 0x3C763, mapF = 0x3CFCB;
ok('the overworld read is LDA $8C00', rom[owF] === 0xAD && (rom[owF + 1] | (rom[owF + 2] << 8)) === 0x8C00);
ok('the per-map read is LDA $8C01,X', rom[mapF] === 0xBD && (rom[mapF + 1] | (rom[mapF + 2] << 8)) === 0x8C01);
ok('the file offsets agree with those CPU addresses',
   0x10 + RATE_BANK * 0x4000 + 0x0C00 === OVERWORLD_RATE && 0x10 + RATE_BANK * 0x4000 + 0x0C01 === MAP_RATE_TABLE);
ok('the check still compares against $F8',
   rom[0x10 + 15 * 0x4000 + (0xCDCA - 0xC000)] === 0xC5 && rom[0x10 + 15 * 0x4000 + (0xCDCA - 0xC000) + 1] === RATE_ZP);
ok('the per-map rates are not uniform', new Set([...rom.slice(MAP_RATE_TABLE, MAP_RATE_TABLE + 0x80)]).size > 3,
   `${new Set([...rom.slice(MAP_RATE_TABLE, MAP_RATE_TABLE + 0x80)]).size} distinct, overworld=${hx(rom[OVERWORLD_RATE])}`);

console.log(`\n${n - bad}/${n} checks passed`);
process.exit(bad ? 1 : 0);
