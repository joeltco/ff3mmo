#!/usr/bin/env node
// ff3-make-boss-state.mjs — build `tools/states/ff3-boss.state.gz`.
//
// WHY
// Every FF3 probe in this repo runs from `ff3-freeroam.state.gz`, which produces
// one thing: a two-Goblin random encounter with a party of level-0 Onion Knights.
// Whole regions of the battle code never execute from it — the three `$7ED8`
// bit-0 sites, for one. This makes a second starting point.
//
//   node tools/ff3-make-boss-state.mjs
//   node tools/ff3-make-boss-state.mjs --monster 0xCC --out tools/states/ff3-boss.state.gz
//
// HOW
// The formation the freeroam zone spawns is repointed at the boss (species record
// index 0, its first id), the count pattern is forced to exactly one, and the
// party walks until the encounter fires. The state is then saved MID-BATTLE.
//
// ⭐ The saved state does NOT depend on the patch. jsnes savestates carry RAM and
// mapper state, not the ROM, and by the time it is taken the boss is already
// loaded into the combatant array — so it replays against the UNPATCHED rom. The
// script verifies exactly that before writing, rather than assuming it.
//
// ⛔ Land Turtle (0xCC) is the default because it is the boss that renders
// correctly here. Xande (0xE0) and the dragons (0xAE/0xC8) do spawn and fight,
// but the map has not loaded their graphics so the screen is garbage — usable for
// code probes, useless for anything visual.

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NES, Controller } from 'jsnes';
import { glyph } from './lib/ff3-text.mjs';
import * as EN from './lib/ff3-encounters.mjs';
import * as M3 from './lib/ff3-monsters.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const MON = Number(flag('monster', '0xCC'));
const OUT = flag('out', path.join(HERE, 'states', 'ff3-boss.state.gz'));
const COUNT_INDEX = 7;                     // the freeroam zone's count pattern

const rom = new Uint8Array(fs.readFileSync(path.join(HERE, '..', 'FF3-English.nes')));
const SNAP = zlib.gunzipSync(
  fs.readFileSync(path.join(HERE, 'states', 'ff3-freeroam.state.gz'))).toString('utf8');
const D = [Controller.BUTTON_LEFT, Controller.BUTTON_RIGHT,
           Controller.BUTTON_UP, Controller.BUTTON_DOWN];

const lines = (nes) => {
  const v = nes.ppu.vramMem, out = [];
  for (let r = 0; r < 30; r++) {
    let s = '';
    for (let c = 0; c < 32; c++) { const g = glyph(v[0x2000 + r * 32 + c]); s += (g === null ? ' ' : g); }
    if (s.trim()) out.push(s.replace(/\s+/g, ' ').trim());
  }
  return out;
};
const enemyHP = (nes, i = 0) =>
  nes.cpu.mem[M3.enemyAddr(i)] | (nes.cpu.mem[M3.enemyAddr(i) + 1] << 8);

// ── build the patched ROM ───────────────────────────────────────────────────
const p = Uint8Array.from(rom);
p[EN.SPECIES_TABLE + EN.SPECIES_ID_OFF] = MON;
for (let i = 1; i < EN.SPECIES_SLOTS; i++) p[EN.SPECIES_TABLE + EN.SPECIES_ID_OFF + i] = EN.SPECIES_EMPTY;
p[EN.COUNT_TABLE + COUNT_INDEX * EN.COUNT_STRIDE] = 0x11;      // exactly one

const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
nes.loadROM(Buffer.from(p).toString('binary'));
nes.fromJSON(JSON.parse(SNAP));
const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };

run(30);
let started = false;
for (let s = 0; s < 400 && !started; s++) {
  const b = D[Math.floor(s / 8) % 4];
  nes.buttonDown(1, b); run(10); nes.buttonUp(1, b); run(12);
  if (enemyHP(nes) > 0) started = true;
}
if (!started) { console.error('the encounter never fired'); process.exit(1); }
run(150);                                   // let the intro settle on the menu

const hp = enemyHP(nes);
const drawn = lines(nes).filter(l => /[A-Za-z]{3,}/.test(l));
console.log(`boss 0x${MON.toString(16).toUpperCase()} — HP ${hp}`);
console.log(`  screen: ${drawn.slice(0, 3).join(' | ')}`);

// ── ⭐ verify the state replays against the UNPATCHED rom ────────────────────
const json = JSON.stringify(nes.toJSON());
{
  const check = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  check.loadROM(Buffer.from(rom).toString('binary'));       // the REAL rom
  check.fromJSON(JSON.parse(json));
  for (let i = 0; i < 120; i++) check.frame();
  const hp2 = enemyHP(check);
  const ok = hp2 > 0 && Math.abs(hp2 - hp) < hp;            // still the same fight
  console.log(`  replay on the UNPATCHED rom: enemy HP ${hp2} — ${ok ? 'OK' : 'FAILED'}`);
  if (!ok) {
    console.error('⛔ the state does not stand on its own; not writing it');
    process.exit(1);
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, zlib.gzipSync(Buffer.from(json, 'utf8')));
console.log(`wrote ${path.relative(path.join(HERE, '..'), OUT)} (${(fs.statSync(OUT).size / 1024) | 0} KB)`);
