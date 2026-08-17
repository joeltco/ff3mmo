#!/usr/bin/env node
// audit-ff1-formation-unread.mjs — FF1 formation bytes 14 and 15 are NEVER READ.
//
// ⛔ A MANUAL AUDIT, deliberately NOT in `deploy.sh`. Every assertion fights a
// real battle to the reward screen and hooks every memory read; the FF1 gate
// suite already pushes the deploy past ten minutes. Run this by hand after
// touching `lib/ff1-monsters.mjs`. Same arrangement as
// `check-ff3-monster-fields.mjs`.
//
//   node tools/audit-ff1-formation-unread.mjs
//
// WHAT MAKES A NEGATIVE MEAN ANYTHING HERE — three controls, all required:
//   ⭐ THE PROBE CONTROL. The same hook, same run, must find the KNOWN readers of
//      bytes 10 and 11 (`LDA $6D8E` at $F339, `LDA $6D8F` at $F341). A probe that
//      cannot find a consumer cannot prove one is absent.
//   ⭐ THE BATTLE CONTROL, over TWO fights. An earlier pass in this repo wrongly
//      called stat bytes unread because the monster died in one hit and never
//      swung, so the fight must be shown to run: the 1-enemy fight must start
//      with a body and reach the reward screen, and the 5-enemy fight must make
//      the monsters SWING (party HP drops). ⛔ Do not demand both from one
//      battle — a lone imp can die before acting, and that reads as a broken
//      harness. ⛔ Sample the party minimum DURING the fight; after it ends that
//      RAM has been written over.
//   ⭐ THE MODE CONTROL. Checked in all eight layout / art / palette / ambush
//      modes, not just the default one.
// ⛔ And they are NOT padding — 23 and 19 distinct values across 128 formations.

import fs from 'node:fs';
import zlib from 'node:zlib';
import { NES, Controller } from 'jsnes';
import * as F1 from './lib/ff1-text.mjs';
import * as MN from './lib/ff1-monsters.mjs';

const ROMP = process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes';
const rom = new Uint8Array(fs.readFileSync(ROMP));
const raw = fs.readFileSync('tools/states/ff1-world.state.gz');
const SNAP = (raw[0] === 0x1f && raw[1] === 0x8b) ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
const D = [Controller.BUTTON_LEFT, Controller.BUTTON_RIGHT];
const REC = MN.FORMATION_TABLE;
const ROM_REC = 0x8400;                      // formation 0 in the $8000 window
const COPY = new Set(Object.values(MN.FORMATION_COPY_SITES));

/**
 * Fight with `patch` applied, hooking every read of record byte `off` (both the
 * ROM record and the RAM copy). Returns the consumer sites that are NOT the copy
 * loop, plus proof the battle actually ran.
 */
function probe(off, patch = {}, presses = 300) {
  const p = Uint8Array.from(rom);
  for (const [o, v] of Object.entries(patch)) p[REC + Number(o)] = v & 0xFF;
  const watch = { [ROM_REC + off]: 'rom', [MN.FORMATION_RAM_COPY + off]: 'ram' };
  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(Buffer.from(p).toString('binary'));
  nes.fromJSON(JSON.parse(SNAP));
  const cpu = nes.cpu;
  const oL = cpu.load.bind(cpu), oE = cpu.emulate.bind(cpu);
  let cur = 0, hit = null; const sites = new Map();
  cpu.load = function (a) { if (watch[a]) hit = watch[a]; return oL(a); };
  cpu.emulate = function () {
    cur = cpu.REG_PC; hit = null; const r = oE();
    if (hit) sites.set(cur, (sites.get(cur) || 0) + 1);
    return r;
  };
  const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
  const lines = () => {
    const v = nes.ppu.vramMem, out = [];
    for (let r = 0; r < 30; r++) {
      let s = '';
      for (let c = 0; c < 32; c++) { const g = F1.glyph(v[0x2000 + r * 32 + c]); s += (g === null || g === '\n') ? ' ' : g; }
      out.push(s);
    }
    return out;
  };
  // ⛔ Count live bodies by MAX hp (+9). CURRENT hp (+13) is not filled in on a
  // fresh spawn, so a control built on it reads 0 and reports "no enemies" in a
  // battle that plainly has them.
  const bodies = () => [...Array(9)].filter((_, i) => {
    const a = MN.ENEMY_RAM + i * MN.ENEMY_RAM_STRIDE;
    return (cpu.mem[a + MN.ENEMY_MAXHP_OFF] | (cpu.mem[a + MN.ENEMY_MAXHP_OFF + 1] << 8)) > 0;
  }).length;
  const pHP = () => [0, 1, 2, 3].reduce((s, i) =>
    s + (cpu.mem[MN.PARTY_HP + i * MN.PARTY_HP_STRIDE] | (cpu.mem[MN.PARTY_HP + i * MN.PARTY_HP_STRIDE + 1] << 8)), 0);

  run(20);
  cpu.mem[0x27] = 150; cpu.mem[0x28] = 170;
  run(20);
  let reached = false;
  for (let s = 0; s < 300; s++) {
    const b = D[Math.floor(s / 6) % 2];
    nes.buttonDown(1, b); run(8); nes.buttonUp(1, b); run(12);
    if (lines().some(l => /\bRUN\b/.test(l))) { reached = true; break; }
  }
  // ⛔ Sample the MINIMUM seen DURING the fight. Reading these after the battle
  // ends measures whatever has since been written over that RAM — which made the
  // battle controls report "enemies never died" in a fight that was WON.
  const b0 = bodies(), p0 = pHP();
  let minP = p0, won = false;
  for (let k = 0; k < presses; k++) {
    nes.buttonDown(1, Controller.BUTTON_A); run(4); nes.buttonUp(1, Controller.BUTTON_A); run(10);
    if (/perished|EXP|GOLD/i.test(lines().join(' '))) { won = true; break; }
    minP = Math.min(minP, pHP());
  }
  const consumers = [...sites].filter(([pc]) => !COPY.has(pc) && !COPY.has(pc + 1));
  return { reached, won, consumers, partyHurt: minP < p0,
           b0, minP, p0, sites: [...sites.keys()] };
}

let bad = 0, n = 0;
const ok = (label, cond, detail) => {
  n++; if (!cond) bad++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  return cond;
};

console.log('FF1 formation bytes 14 and 15 — never read (a manual audit)\n');

// ── ⭐ CONTROL 1: the probe can find a consumer when one exists ─────────────
console.log('  control: the same hook on bytes that ARE read');
let probeWorks = true;
for (const [off, pc] of Object.entries(MN.FORMATION_KNOWN_READERS)) {
  const r = probe(Number(off), { 6: 0x11 });
  const found = r.consumers.some(([p]) => p === pc || p + 1 === pc);
  if (!found) probeWorks = false;
  console.log(`     byte ${off}: ${r.consumers.length} consumer site(s) ` +
              `${r.consumers.map(([p, c]) => `$${p.toString(16).toUpperCase()}x${c}`).join(' ')}` +
              ` — expected $${pc.toString(16).toUpperCase()} ${found ? 'FOUND' : 'MISSING'}`);
}
ok('the hook finds the known readers of bytes 10 and 11', probeWorks);
if (!probeWorks) {
  console.error('\n⛔ the probe cannot see a consumer that is definitely there.');
  console.error('   Every "never read" result below would be meaningless. Stopping.');
  process.exit(1);
}

// ── ⭐ CONTROL 2: the battle really runs ────────────────────────────────────
// ⛔ TWO SEPARATE FIGHTS. Demanding "enemies died AND the party was hit" from one
// one-enemy battle is wrong — a lone imp can die before it ever swings, and that
// failure looks exactly like a broken harness. Win in the 1-enemy fight; take
// damage in the default 5-enemy fight, which is long enough for monsters to act.
const full = probe(14, { 6: 0x11 });
ok('the 1-enemy battle is reached, fought and WON', full.reached && full.won);
// ⛔ "enemies died" is redundant with reaching the reward screen — you cannot win
// otherwise. What is worth asserting is that a body was THERE to kill.
ok('...and it started with a live enemy on the field', full.b0 > 0, `${full.b0} bodies`);
const long = probe(14, {}, 400);
ok('the 5-enemy battle makes the monsters SWING', long.partyHurt,
   `party HP ${long.p0} -> ${long.minP}`);

// ── the finding ─────────────────────────────────────────────────────────────
for (const off of MN.FORMATION_UNREAD_OFF) {
  const r = probe(off, { 6: 0x11 });
  ok(`byte ${off} has NO consumer across a full won battle`, r.consumers.length === 0,
     `touched only by ${r.sites.map(p => '$' + p.toString(16).toUpperCase()).join(' ')}`);
}

// ── ⭐ CONTROL 3: every mode, not just the default ──────────────────────────
const MODES = [
  ['default', {}],
  ['byte0=0x20', { 0: 0x20 }], ['byte0=0x40', { 0: 0x40 }], ['byte0=0x80', { 0: 0x80 }],
  ['byte1=0x01', { 1: 0x01, 6: 0x11, 7: 0x11, 8: 0x11, 9: 0x11 }], ['byte1=0x02', { 1: 0x02 }],
  ['byte13=0xC0', { 13: 0xC0 }], ['byte12=0x84', { 12: 0x84 }],
];
let anyMode = false;
for (const [label, patch] of MODES) {
  for (const off of MN.FORMATION_UNREAD_OFF) {
    const r = probe(off, { 6: 0x11, ...patch }, 120);
    if (r.consumers.length) { anyMode = true; console.log(`     ⛔ ${label} byte ${off}: ${r.consumers.length} consumer(s)`); }
  }
}
ok(`no consumer appears in any of the ${MODES.length} layout/art/palette/ambush modes`, !anyMode);

// ── not padding ─────────────────────────────────────────────────────────────
const distinct = (off, N = 128) => new Set(
  Array.from({ length: N }, (_, f) => rom[REC + f * MN.FORMATION_STRIDE + off])).size;
ok('byte 14 is NOT padding', distinct(14) > 8, `${distinct(14)} distinct across 128 formations`);
ok('byte 15 is NOT padding', distinct(15) > 8, `${distinct(15)} distinct across 128 formations`);

// ── wiring ──────────────────────────────────────────────────────────────────
ok('14 and 15 are recorded as UNREAD, not as unknown',
   JSON.stringify(MN.FORMATION_UNREAD_OFF) === JSON.stringify([14, 15])
   && MN.FORMATION_UNKNOWN_OFF.length === 0);

console.log(`\n${n - bad}/${n} checks passed`);
process.exit(bad ? 1 : 0);
