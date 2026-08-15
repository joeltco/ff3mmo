#!/usr/bin/env node
// ff1-stat-fields.mjs — work out what each byte of an FF1 monster record means.
//
// WHY
// The stat table is located (bank 12 $8520, file 0x30530, 20 bytes each) but the
// FIELDS are not identified, and naming one "HP" on a hunch is exactly the kind
// of guess this project keeps getting burned by. Every claim here comes from
// changing a byte and watching what the game does differently.
//
// THE LEVER
// Formation byte 2 is the monster id, so any monster can be made to appear
// (`ff1-monster-verify.mjs`). The same patch-and-fight loop works on the STAT
// record: change one byte, fight, and see what moved.
//
// MODES
//   --map      patch each ROM byte to a sentinel in turn and report which RAM
//              byte changed. The copy at $AFC1 goes through a scatter table at
//              $AFCB, so ROM offset != RAM offset and the mapping has to be
//              measured before anything else can be said.
//   --damage   attack the monster and report which RAM bytes move — current HP
//              is whatever goes DOWN when you hit it.
//   --probe N  patch ROM byte N to a distinctive value and describe the battle.
//
//   node tools/ff1-stat-fields.mjs --map
//   node tools/ff1-stat-fields.mjs --damage
//
// ⛔ The ROM on disk is never touched — patches go into the in-memory copy.
// ⛔ A sentinel can break the encounter outright (a count or a flag byte), and
// "no battle" is a REAL result about that byte, not a failed run.

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NES, Controller } from 'jsnes';
import * as F1 from './lib/ff1-text.mjs';
import * as MN from './lib/ff1-monsters.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const MODE_MAP = args.includes('--map');
const MODE_DAMAGE = args.includes('--damage');
const PROBE = flag('probe', null);
const MONSTER = Number(flag('monster', '0'));
const SENTINEL = Number(flag('sentinel', '0x5A'));
const ROMP = process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes';

const rom = new Uint8Array(fs.readFileSync(ROMP));
const SNAP = zlib.gunzipSync(
  fs.readFileSync(path.join(HERE, 'states', 'ff1-world.state.gz'))).toString('utf8');

const ENEMY_RAM = 0x6BDC, ENEMY_STRIDE = 20;
const DIRS = [Controller.BUTTON_LEFT, Controller.BUTTON_RIGHT];

/** Patch the stat record, walk into an encounter, hand back the machine. */
function fight(patch = {}, monster = MONSTER) {
  const p = Uint8Array.from(rom);
  p[MN.FORMATION_TABLE + MN.FORMATION_MONSTER_OFF] = monster;
  for (const [off, val] of Object.entries(patch)) {
    p[MN.STAT_TABLE + monster * MN.STAT_STRIDE + Number(off)] = val;
  }
  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(Buffer.from(p).toString('binary'));
  nes.fromJSON(JSON.parse(SNAP));
  const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
  run(20);
  nes.cpu.mem[0x27] = 150; nes.cpu.mem[0x28] = 170;
  run(20);
  for (let step = 0; step < 300; step++) {
    const b = DIRS[Math.floor(step / 6) % 2];
    nes.buttonDown(1, b); run(8); nes.buttonUp(1, b); run(12);
    if (screen(nes).some(l => /\bRUN\b/.test(l))) return nes;
  }
  return null;
}

function screen(nes) {
  const v = nes.ppu.vramMem, out = [];
  for (let r = 0; r < 30; r++) {
    let s = '';
    for (let c = 0; c < 32; c++) {
      const g = F1.glyph(v[0x2000 + r * 32 + c]);
      s += (g === null || g === '\n') ? ' ' : g;
    }
    if (s.trim()) out.push(s.trim());
  }
  return out;
}
const enemy = (nes, slot = 0) =>
  [...nes.cpu.mem.slice(ENEMY_RAM + slot * ENEMY_STRIDE, ENEMY_RAM + (slot + 1) * ENEMY_STRIDE)];
const hex = (a) => a.map(v => v.toString(16).padStart(2, '0')).join(' ');

if (MODE_MAP) {
  const base = fight();
  if (!base) { console.error('the baseline battle never started'); process.exit(1); }
  const b = enemy(base);
  console.log(`FF1 stat record — ROM offset -> RAM offset, monster ${MONSTER}`);
  console.log(`  ROM: ${hex(MN.statRecord(rom, MONSTER))}`);
  console.log(`  RAM: ${hex(b)}\n`);
  const mapping = [];
  for (let off = 0; off < MN.STAT_STRIDE; off++) {
    const nes = fight({ [off]: SENTINEL });
    if (!nes) { console.log(`  ROM ${String(off).padStart(2)} -> (no battle — this byte breaks the encounter)`); continue; }
    const a = enemy(nes);
    const moved = [];
    for (let i = 0; i < ENEMY_STRIDE; i++) if (a[i] !== b[i]) moved.push(i);
    mapping.push({ off, moved, vals: moved.map(i => a[i]) });
    console.log(`  ROM ${String(off).padStart(2)} -> RAM ${moved.length ? moved.join(',') : '(nothing changed)'}` +
                `${moved.length ? '  = ' + moved.map((i, k) => `0x${a[i].toString(16)}`).join(',') : ''}`);
  }
  process.exit(0);
}

if (MODE_DAMAGE) {
  const nes = fight();
  if (!nes) { console.error('no battle'); process.exit(1); }
  const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
  console.log(`FF1 — which RAM bytes move when the monster is hit (monster ${MONSTER})`);
  console.log(`  at battle start: ${hex(enemy(nes))}`);
  let prev = enemy(nes);
  for (let round = 1; round <= 6; round++) {
    for (let k = 0; k < 12; k++) {
      nes.buttonDown(1, Controller.BUTTON_A); run(6);
      nes.buttonUp(1, Controller.BUTTON_A); run(24);
    }
    const now = enemy(nes);
    const moved = [];
    for (let i = 0; i < ENEMY_STRIDE; i++) if (now[i] !== prev[i]) moved.push(`${i}:${prev[i]}->${now[i]}`);
    console.log(`  round ${round}: ${hex(now)}${moved.length ? '\n      moved ' + moved.join('  ') : ''}`);
    prev = now;
  }
  const txt = screen(nes).filter(l => /[A-Za-z0-9]{2,}/.test(l));
  console.log(`  screen: ${txt.slice(0, 10).join(' | ').slice(0, 160)}`);
  process.exit(0);
}

if (PROBE !== null) {
  const off = Number(PROBE);
  const nes = fight({ [off]: SENTINEL });
  console.log(`ROM byte ${off} = 0x${SENTINEL.toString(16)}:`);
  if (!nes) { console.log('  no battle started'); process.exit(0); }
  console.log(`  RAM: ${hex(enemy(nes))}`);
  console.log(`  screen: ${screen(nes).filter(l => /[A-Za-z]{2,}/.test(l)).join(' | ').slice(0, 140)}`);
  process.exit(0);
}

console.error('give --map, --damage or --probe N');
process.exit(1);
