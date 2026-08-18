#!/usr/bin/env node
// ff1-menu-cursor.mjs — what does the battle menu cursor DO when the sweep presses A?
//
//   node tools/ff1-menu-cursor.mjs                 # CHAOS (0x7F)
//   node tools/ff1-menu-cursor.mjs --id 0x00
//
// ⭐ WHY: the sweep pressed A into the battle menu for 8 rounds and no monster
// special ever fired, for ANY monster including the four Fiends and CHAOS. Reading
// the BG nametable showed the menu text UNCHANGED across three A presses — which
// rules out both "A selected FIGHT" (screen would advance) and "A selected RUN"
// (fight would end). The BG can't answer it because FF1 draws the battle cursor
// as an OAM SPRITE, not a nametable tile.
//
// ⛔ POSITIONAL ONLY. This reads sprite X/Y to find where the cursor sits and
// whether it moves. It does NOT interpret tile bytes, palettes, or frame timing
// into render code — that is the CLAUDE.md OAM prohibition and it still stands.
//
// ⛔ A NULL RESULT HERE IS ONLY TRUSTWORTHY IF INPUT IS PROVEN TO LAND, so the
// run drives D-PAD presses first: if the cursor never moves for ANY button, the
// bug is input delivery, not menu selection.

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
const ID = Number(flag('id', '0x7F'));
// ⭐ --seq a,a,a  reproduces exactly what the sweep sends (A and nothing else).
const SEQ_ARG = flag('seq', 'down,down,up,right,a,a,a,b');

const rom = new Uint8Array(fs.readFileSync(process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes'));
const raw = fs.readFileSync(path.join(HERE, 'states', 'ff1-world.state.gz'));
const SNAP = (raw[0] === 0x1f && raw[1] === 0x8b) ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
const hx = (v, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');

const p = Uint8Array.from(rom);
p[MN.FORMATION_TABLE + MN.FORMATION_MONSTER_OFF] = ID;
p[MN.FORMATION_TABLE + MN.FORMATION_COUNT_OFF[0]] = 0x11;
const S = MN.STAT_TABLE + ID * MN.STAT_STRIDE;
p[S + MN.STAT_FIELDS.hp[0]] = 0xFF; p[S + MN.STAT_FIELDS.hp[1]] = 0xFF;
p[S + MN.STAT_FIELDS.evade] = 0xFF;

const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
nes.loadROM(Buffer.from(p).toString('binary'));
nes.fromJSON(JSON.parse(SNAP));
const c = nes.cpu;
const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };

const lines = () => {
  const v = nes.ppu.vramMem, out = [];
  for (let r = 0; r < 30; r++) {
    let s = '';
    for (let col = 0; col < 32; col++) { const g = F1.glyph(v[0x2000 + r * 32 + col]); s += (g === null || g === '\n') ? ' ' : g; }
    out.push(s);
  }
  return out;
};
const inBattle = () => lines().some(l => /\bRUN\b/.test(l));

// ⭐ jsnes keeps OAM in ppu.spriteMem — 64 entries of [y, tile, attr, x].
// y >= 0xEF means the sprite is parked off the bottom of the screen (hidden).
const oam = () => {
  const m = nes.ppu.spriteMem, out = [];
  for (let i = 0; i < 64; i++) {
    const y = m[i * 4], tile = m[i * 4 + 1], attr = m[i * 4 + 2], x = m[i * 4 + 3];
    if (y >= 0xEF) continue;
    out.push({ i, y, tile, attr, x });
  }
  return out;
};
const fmt = (s) => `#${String(s.i).padStart(2)} tile $${hx(s.tile)} @(${String(s.x).padStart(3)},${String(s.y).padStart(3)}) pal${s.attr & 3}`;
const key = (s) => `${s.i}:${s.tile}`;

function diff(before, after) {
  const B = new Map(before.map(s => [key(s), s])), A = new Map(after.map(s => [key(s), s]));
  const moved = [], gone = [], added = [];
  for (const [k, s] of A) {
    const b = B.get(k);
    if (!b) added.push(s);
    else if (b.x !== s.x || b.y !== s.y) moved.push([b, s]);
  }
  for (const [k, s] of B) if (!A.has(k)) gone.push(s);
  return { moved, gone, added };
}

// --- reach the battle menu -------------------------------------------------
run(20);
c.mem[0x27] = 150; c.mem[0x28] = 170;
run(20);
const D = [Controller.BUTTON_LEFT, Controller.BUTTON_RIGHT];
let started = false;
for (let s = 0; s < 300 && !started; s++) {
  const b = D[Math.floor(s / 6) % 2];
  nes.buttonDown(1, b); run(8); nes.buttonUp(1, b); run(12);
  if (inBattle()) started = true;
}
if (!started) { console.log('never reached a battle'); process.exit(1); }

console.log(`monster $${hx(ID)} — at the battle menu\n`);
let prev = oam();
console.log(`visible sprites: ${prev.length}`);
for (const s of prev) console.log('   ' + fmt(s));
console.log('\nmenu text:');
for (const [i, l] of lines().entries()) if (l.trim()) console.log(`  row ${String(i).padStart(2)}: [${l}]`);

// --- drive one button at a time, watch what moves --------------------------
// ⭐ D-PAD FIRST. If nothing moves for DOWN/UP either, the finding is that input
// never lands, and every "no special fired" result in the sweep is an artifact.
const BTN = { a: Controller.BUTTON_A, b: Controller.BUTTON_B, up: Controller.BUTTON_UP,
              down: Controller.BUTTON_DOWN, left: Controller.BUTTON_LEFT, right: Controller.BUTTON_RIGHT };
const SEQ = SEQ_ARG.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// ⭐ The cursor is the 2x2 pal-3 cluster of tiles $F0-$F3. Its TOP-LEFT corner is
// the selected cell; when it is absent, no command menu is open.
const CURSOR_TILES = new Set([0xF0, 0xF1, 0xF2, 0xF3]);
const cursorAt = (sprites) => {
  const c = sprites.filter(s => CURSOR_TILES.has(s.tile) && (s.attr & 3) === 3);
  if (!c.length) return null;
  return { x: Math.min(...c.map(s => s.x)), y: Math.min(...c.map(s => s.y)) };
};
// The active character steps LEFT out of the party column (rest x = 176/178).
// Slots are 6 sprites each: #4-9, #10-15, #16-21, #22-27.
const activeChar = (sprites) => {
  for (let slot = 0; slot < 4; slot++) {
    const own = sprites.filter(s => s.i >= 4 + slot * 6 && s.i < 10 + slot * 6);
    if (own.length && Math.min(...own.map(s => s.x)) < 170) return slot + 1;
  }
  return 0;
};

for (const name of SEQ) {
  const btn = BTN[name];
  if (btn === undefined) { console.log(`unknown button ${name}`); continue; }
  nes.buttonDown(1, btn); run(4); nes.buttonUp(1, btn); run(16);
  const now = oam();
  const d = diff(prev, now);
  const bits = [];
  for (const [b, a] of d.moved) bits.push(`#${b.i} $${hx(b.tile)} (${b.x},${b.y})->(${a.x},${a.y})`);
  for (const s of d.added) bits.push(`+${fmt(s)}`);
  for (const s of d.gone) bits.push(`-${fmt(s)}`);
  const cur = cursorAt(now);
  const battle = inBattle() ? 'in-battle' : '⛔BATTLE OVER';
  console.log(`\npress ${name.toUpperCase().padEnd(5)} [${battle}] cursor=${cur ? `(${cur.x},${cur.y})` : 'NONE'} char=${activeChar(now) || '-'}  ${bits.length ? bits.join('  ') : 'NOTHING MOVED'}`);
  prev = now;
}
