#!/usr/bin/env node
// ff2-location-sweep.mjs — enter every FF2 location id and classify what it is.
//
// The warp works (`lib/ff2-locations.mjs`), but nothing says WHICH location ids
// are towns, dungeons or overworld — and encounters only happen in some of them.
// This enters each id, records what got drawn and whether the party can walk, then
// optionally walks the candidates looking for a battle.
//
//   node tools/ff2-location-sweep.mjs                 # classify 0x00-0xFF
//   node tools/ff2-location-sweep.mjs --walk 40       # ...then walk each candidate
//   node tools/ff2-location-sweep.mjs --from 0 --to 64
//
// ⛔⛔ THE OBVIOUS DETECTOR IS WRONG. "more than 85% of the nametable changed"
// fires on a MAP TRANSITION, not a battle — walking into an exit redraws the whole
// screen. A first pass reported 111 "battles"; rendering two of them showed both
// triggered at the SAME step with the party at the SAME coords and `$48` changed
// to 1. They were exits. A battle leaves `$48` ALONE, so the screen test is only
// believable together with "the location id did not change".
//
// ⛔ "no battle" from this tool is NOT proof a location lacks encounters — the
// walk is short and the party may be boxed in. It reports walkability alongside,
// so a 1-tile "walk" is never mistaken for a tested location.

import fs from 'node:fs';
import { Controller } from 'jsnes';
import * as L2 from './lib/ff2-locations.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const FROM = Number(flag('from', '0')), TO = Number(flag('to', '256'));
const WALK = Number(flag('walk', '0'));
const { rom, snapshot } = L2.loadFixtures();
const hx = (v, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');
const D = [Controller.BUTTON_UP, Controller.BUTTON_RIGHT, Controller.BUTTON_DOWN, Controller.BUTTON_LEFT];

const rows = [];
for (let d = FROM; d < TO; d++) {
  const e = L2.enterLocation(rom, snapshot, d, { frames: 90 });
  const distinct = new Set(e.nt).size;
  const row = {
    d, distinct,
    tilemap: L2.tilemapOf(rom, d),
    tileset: rom[L2.LOC_TILESET_TABLE + d],
    x: e.x, y: e.y,
    nt: e.nt.join(','),
    tiles: 1, battle: false, step: -1, exitedTo: -1,
  };
  if (WALK) {
    const nes = e.nes, cpu = e.cpu;
    const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
    const base = [...nes.ppu.vramMem.slice(0x2000, 0x23C0)];
    const seen = new Set([`${cpu.mem[L2.PARTY_X_ZP]},${cpu.mem[L2.PARTY_Y_ZP]}`]);
    const loc0 = cpu.mem[L2.LOC_ID_ZP];
    for (let s = 0; s < WALK; s++) {
      const b = D[Math.floor(s / 5) % 4];
      nes.buttonDown(1, b); run(6); nes.buttonUp(1, b); run(8);
      seen.add(`${cpu.mem[L2.PARTY_X_ZP]},${cpu.mem[L2.PARTY_Y_ZP]}`);
      const now = nes.ppu.vramMem.slice(0x2000, 0x23C0);
      let diff = 0;
      for (let i = 0; i < now.length; i++) if (now[i] !== base[i]) diff++;
      if (diff > base.length * 0.85) {
        // ⭐ the discriminator: an EXIT changes $48, a battle does not
        if (cpu.mem[L2.LOC_ID_ZP] !== loc0) { row.exitedTo = cpu.mem[L2.LOC_ID_ZP]; row.step = s; break; }
        row.battle = true; row.step = s; break;
      }
    }
    row.tiles = seen.size;
  }
  rows.push(row);
}

// group by what actually got drawn — distinct screens, not distinct ids
const byScreen = new Map();
for (const r of rows) {
  if (!byScreen.has(r.nt)) byScreen.set(r.nt, []);
  byScreen.get(r.nt).push(r.d);
}
console.log(`entered ${rows.length} location ids -> ${byScreen.size} DISTINCT screens\n`);
console.log('  id  tilemap tileset  spawn   nt-tiles' + (WALK ? '  walked  battle' : ''));
for (const r of rows) {
  const uniq = byScreen.get(r.nt).length === 1;
  console.log(`  ${hx(r.d)}   ${hx(r.tilemap)}      ${hx(r.tileset)}    ${String(r.x).padStart(2)},${String(r.y).padStart(2)}   ${String(r.distinct).padStart(3)}` +
              (WALK ? `      ${String(r.tiles).padStart(3)}   ${r.battle ? `⭐ BATTLE step ${r.step}` : (r.exitedTo >= 0 ? `exit->${hx(r.exitedTo)}` : '')}` : '') +
              (uniq ? '' : '   (shared screen)'));
}
if (WALK) {
  const fought = rows.filter(r => r.battle);
  const exited = rows.filter(r => r.exitedTo >= 0);
  const walkable = rows.filter(r => r.tiles > 3);
  console.log(`\n${walkable.length}/${rows.length} locations let the party walk more than 3 tiles`);
  console.log(`${exited.length} walked into an EXIT (screen changed AND $48 changed) — not battles`);
  console.log(fought.length
    ? `⭐ ${fought.length} produced a BATTLE ($48 unchanged): ${fought.map(r => hx(r.d)).join(' ')}`
    : `⛔ NO battles in ${WALK} steps each. ⛔ That is NOT proof they lack encounters — ` +
      `only ${walkable.length} were walkable and most hit an exit first.`);
}
